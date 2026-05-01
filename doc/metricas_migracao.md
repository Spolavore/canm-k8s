# Métricas de Decisão de Migração — CANM

> **Contexto:** TCC — Cost-Aware Scheduled Node Migration (CANM)  
> Cluster: GKE | Stack: front-end, back-end, Redis  
> Migração: N2 (pico) ↔ E2 (ocioso) | Janela ociosa: 18h–07h

---

## 1. Limitação do Critério Único de CPU

A abordagem inicial — média de CPU < 30% por 1h para migrar, > 65% por 10m para retornar — é funcional, mas apresenta a **falácia da média**:

> Um nó com 5% e outro com 85% resultam em média 45%. O critério simples não migraria, mas há pressão real no cluster.

Além disso, CPU isolada não captura:
- Pressão de memória (crítico para Redis)
- Saturação de I/O e swap
- Pods pendentes (sinal de que o scheduler já está sob pressão)
- Throughput de rede (relevante para front-end/back-end)

---

## 2. Conjunto de Métricas por Dimensão

| Dimensão | Métrica Prometheus | Justificativa |
|---|---|---|
| **CPU Utilização** | `rate(node_cpu_seconds_total{mode!="idle"}[5m])` | Critério principal de carga |
| **CPU Saturação** | `node_load1 / count(node_cpu_seconds_total{mode="idle"})` | Detecta fila de processos — load > 1 = saturação real |
| **Memória Utilização** | `1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)` | Redis é sensível; swap mascara pressão real |
| **Memória Saturação** | `rate(node_vmstat_pgmajfault[5m])` | Page faults indicam swap ativo — migrar nesse estado é perigoso |
| **Rede Throughput** | `rate(node_network_transmit_bytes_total[5m])` | Pico de requisições pode não aparecer na CPU |
| **Pods Pending** | `kube_pod_status_phase{phase="Pending"}` | Pods pendentes = cluster sob pressão → não migrar |
| **PDB Disponível** | `kube_poddisruptionbudget_status_disruptions_allowed` | Garante que o drain não viola disponibilidade |
| **Nós Prontos** | `kube_node_status_condition{condition="Ready",status="true"}` | Confirma saúde do nó substituto antes do drain |

> **Nota:** Todas essas métricas já estão disponíveis no ambiente atual via `node_exporter` e `cadvisor` (configurados em `prometheus.yml`), sem nenhuma mudança de infraestrutura necessária.

---

## 3. Cluster Pressure Score (Métrica Composta)

Para unificar as dimensões em um único sinal de decisão, propõe-se um **índice sintético ponderado**:

```
cluster_pressure_score =
    α · avg_cpu_utilization +
    β · avg_memory_utilization +
    γ · avg_network_utilization
```

### Pesos padrão (calibráveis empiricamente)

| Hiperparâmetro | Valor inicial | Dimensão |
|---|---|---|
| `α` (alpha) | 0.5 | CPU |
| `β` (beta) | 0.3 | Memória |
| `γ` (gamma) | 0.2 | Rede |

> Os pesos somam 1.0 e refletem a prioridade relativa de cada recurso para a stack (front-end, back-end, Redis). Podem ser ajustados com base em dados empíricos coletados durante os experimentos.

### Limiares de decisão

| Score | Duração | Ação |
|---|---|---|
| `< 0.30` | por 1h | Migrar N2 → E2 |
| `> 0.65` | por 10m | Retornar E2 → N2 |

### Implementação em PromQL

```promql
# CPU utilization média do cluster
avg_cpu = avg(rate(node_cpu_seconds_total{mode!="idle"}[5m]))

# Memória utilizada média
avg_mem = avg(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))

# Rede normalizada (bytes/s → fração de um teto configurável, ex: 125MB/s = 1Gbps)
avg_net = avg(rate(node_network_transmit_bytes_total[5m])) / 125000000

# Score composto
cluster_pressure_score = (0.5 * avg_cpu) + (0.3 * avg_mem) + (0.2 * avg_net)
```

---

## 4. Lógica de Decisão Completa

### 4.1 Gate de Downscaling — N2 → E2

Todas as condições devem ser verdadeiras **simultaneamente**:

```promql
# [1] Score composto abaixo do limiar por 1h
cluster_pressure_score < 0.30
  for: 1h

# [2] Nenhum nó individualmente acima de 50% (anti-falácia da média)
max(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (node) < 0.50

# [3] Memória livre > 30% (Redis não está sob pressão)
avg(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 0.30

# [4] Sem page faults significativos (sem swap ativo)
rate(node_vmstat_pgmajfault[5m]) < 10

# [5] Sem pods Pending
sum(kube_pod_status_phase{phase="Pending"}) == 0
```

### 4.2 Gate de Upscaling — E2 → N2

**Qualquer uma** das condições dispara o retorno:

```promql
# [1] Score composto acima do limiar por 10m
cluster_pressure_score > 0.65
  for: 10m

# [2] OU saturação de CPU em um nó (load > 1.5x núcleos disponíveis)
max(node_load1 / on(node) count by(node)(node_cpu_seconds_total{mode="idle"})) > 1.5
  for: 5m

# [3] OU memória crítica
avg(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) < 0.15
  for: 5m
```

---

## 5. Guarda Especial para Redis

O Redis requer protocolo específico antes do drain, pois pode perder estado se interrompido abruptamente.

### Pré-condições obrigatórias antes de drenar nó com Redis

```bash
# 1. Forçar snapshot imediato
kubectl exec -n <namespace> <redis-pod> -- redis-cli BGSAVE

# 2. Aguardar confirmação de conclusão (comparar timestamp)
kubectl exec -n <namespace> <redis-pod> -- redis-cli LASTSAVE

# 3. Verificar configuração de persistência
kubectl exec -n <namespace> <redis-pod> -- redis-cli CONFIG GET save
```

### Critério de aprovação

Só prosseguir com o drain se:
- `BGSAVE` retornar `Background saving started`
- `LASTSAVE` retornar timestamp posterior ao início da migração
- PDB do Redis permitir disrupção (`disruptions_allowed >= 1`)

> Documentar esse protocolo como **"migração stateful segura"** na metodologia do TCC — é um ponto de diferenciação relevante em relação ao CA/NAP, que não possui essa lógica de guarda.

---

## 6. Hiperparâmetros do Algoritmo

Os valores abaixo são tratados como **hiperparâmetros configuráveis**, permitindo análise de sensibilidade nos experimentos:

| Parâmetro | Símbolo | Valor Padrão | Descrição |
|---|---|---|---|
| Peso CPU | `α` | 0.5 | Contribuição da CPU no score |
| Peso Memória | `β` | 0.3 | Contribuição da memória no score |
| Peso Rede | `γ` | 0.2 | Contribuição da rede no score |
| Limiar de downscaling | `θ_down` | 0.30 | Score abaixo → candidato a E2 |
| Limiar de upscaling | `θ_up` | 0.65 | Score acima → retorno para N2 |
| Janela de observação (down) | `T_down` | 60 min | Duração mínima abaixo de `θ_down` |
| Janela de observação (up) | `T_up` | 10 min | Duração mínima acima de `θ_up` |
| Page fault máximo | `PF_max` | 10/s | Limite de swap ativo tolerado |
| Load ratio máximo (por nó) | `LR_max` | 1.5 | Saturação individual de CPU |

### Sugestão de experimentos de sensibilidade

- Variar `α`, `β`, `γ` com soma = 1.0 e medir falsos positivos de migração
- Avaliar `θ_down` em {0.20, 0.25, 0.30, 0.35} e medir janelas de migração capturadas
- Avaliar `T_down` em {30, 45, 60, 90} minutos e medir risco de migração prematura

---

## 7. Comparação com Abordagem Simples

| Aspecto | Critério simples (só CPU média) | Score composto (CANM) |
|---|---|---|
| Robustez | Baixa — vulnerável à falácia da média | Alta — detecta pressão multidimensional |
| Segurança para Redis | Nenhuma | Guarda explícita de memória e page faults |
| Diferenciação vs CA/NAP | Difícil de argumentar | Score sintético é ponto de originalidade |
| Risco de falsa migração | Alto | Baixo — múltiplos gates simultâneos |
| Calibração empírica | Não se aplica | Hiperparâmetros ajustáveis com dados reais |
| Complexidade de implementação | Baixa | Média — requer coleta de múltiplas séries |

---

## 8. Fontes das Métricas no Ambiente Atual

Todas as métricas listadas são coletadas pelos jobs já configurados em `prometheus.yml`:

| Métrica | Job responsável |
|---|---|
| `node_cpu_seconds_total` | `node_exporter` |
| `node_memory_MemAvailable_bytes` | `node_exporter` |
| `node_vmstat_pgmajfault` | `node_exporter` |
| `node_network_transmit_bytes_total` | `node_exporter` |
| `node_load1` | `node_exporter` |
| `kube_pod_status_phase` | `kubernetes-pods` / `kubernetes-pods-hml` |
| `kube_poddisruptionbudget_status_disruptions_allowed` | `kubernetes-pods` |
| Métricas de container (CPU/mem por pod) | `cadvisor-*` |# Métricas de Decisão de Migração — CANM

> **Contexto:** TCC — Cost-Aware Scheduled Node Migration (CANM)  
> Cluster: GKE | Stack: front-end, back-end, Redis  
> Migração: N2 (pico) ↔ E2 (ocioso) | Janela ociosa: 18h–07h

---

## 1. Limitação do Critério Único de CPU

A abordagem inicial — média de CPU < 30% por 1h para migrar, > 65% por 10m para retornar — é funcional, mas apresenta a **falácia da média**:

> Um nó com 5% e outro com 85% resultam em média 45%. O critério simples não migraria, mas há pressão real no cluster.

Além disso, CPU isolada não captura:
- Pressão de memória (crítico para Redis)
- Saturação de I/O e swap
- Pods pendentes (sinal de que o scheduler já está sob pressão)
- Throughput de rede (relevante para front-end/back-end)

---

## 2. Conjunto de Métricas por Dimensão

| Dimensão | Métrica Prometheus | Justificativa |
|---|---|---|
| **CPU Utilização** | `rate(node_cpu_seconds_total{mode!="idle"}[5m])` | Critério principal de carga |
| **CPU Saturação** | `node_load1 / count(node_cpu_seconds_total{mode="idle"})` | Detecta fila de processos — load > 1 = saturação real |
| **Memória Utilização** | `1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)` | Redis é sensível; swap mascara pressão real |
| **Memória Saturação** | `rate(node_vmstat_pgmajfault[5m])` | Page faults indicam swap ativo — migrar nesse estado é perigoso |
| **Rede Throughput** | `rate(node_network_transmit_bytes_total[5m])` | Pico de requisições pode não aparecer na CPU |
| **Pods Pending** | `kube_pod_status_phase{phase="Pending"}` | Pods pendentes = cluster sob pressão → não migrar |
| **PDB Disponível** | `kube_poddisruptionbudget_status_disruptions_allowed` | Garante que o drain não viola disponibilidade |
| **Nós Prontos** | `kube_node_status_condition{condition="Ready",status="true"}` | Confirma saúde do nó substituto antes do drain |

> **Nota:** Todas essas métricas já estão disponíveis no ambiente atual via `node_exporter` e `cadvisor` (configurados em `prometheus.yml`), sem nenhuma mudança de infraestrutura necessária.

---

## 3. Cluster Pressure Score (Métrica Composta)

Para unificar as dimensões em um único sinal de decisão, propõe-se um **índice sintético ponderado**:

```
cluster_pressure_score =
    α · avg_cpu_utilization +
    β · avg_memory_utilization +
    γ · avg_network_utilization
```

### Pesos padrão (calibráveis empiricamente)

| Hiperparâmetro | Valor inicial | Dimensão |
|---|---|---|
| `α` (alpha) | 0.5 | CPU |
| `β` (beta) | 0.3 | Memória |
| `γ` (gamma) | 0.2 | Rede |

> Os pesos somam 1.0 e refletem a prioridade relativa de cada recurso para a stack (front-end, back-end, Redis). Podem ser ajustados com base em dados empíricos coletados durante os experimentos.

### Limiares de decisão

| Score | Duração | Ação |
|---|---|---|
| `< 0.30` | por 1h | Migrar N2 → E2 |
| `> 0.65` | por 10m | Retornar E2 → N2 |

### Implementação em PromQL

```promql
# CPU utilization média do cluster
avg_cpu = avg(rate(node_cpu_seconds_total{mode!="idle"}[5m]))

# Memória utilizada média
avg_mem = avg(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))

# Rede normalizada (bytes/s → fração de um teto configurável, ex: 125MB/s = 1Gbps)
avg_net = avg(rate(node_network_transmit_bytes_total[5m])) / 125000000

# Score composto
cluster_pressure_score = (0.5 * avg_cpu) + (0.3 * avg_mem) + (0.2 * avg_net)
```

---

## 4. Lógica de Decisão Completa

### 4.1 Gate de Downscaling — N2 → E2

Todas as condições devem ser verdadeiras **simultaneamente**:

```promql
# [1] Score composto abaixo do limiar por 1h
cluster_pressure_score < 0.30
  for: 1h

# [2] Nenhum nó individualmente acima de 50% (anti-falácia da média)
max(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (node) < 0.50

# [3] Memória livre > 30% (Redis não está sob pressão)
avg(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 0.30

# [4] Sem page faults significativos (sem swap ativo)
rate(node_vmstat_pgmajfault[5m]) < 10

# [5] Sem pods Pending
sum(kube_pod_status_phase{phase="Pending"}) == 0
```

### 4.2 Gate de Upscaling — E2 → N2

**Qualquer uma** das condições dispara o retorno:

```promql
# [1] Score composto acima do limiar por 10m
cluster_pressure_score > 0.65
  for: 10m

# [2] OU saturação de CPU em um nó (load > 1.5x núcleos disponíveis)
max(node_load1 / on(node) count by(node)(node_cpu_seconds_total{mode="idle"})) > 1.5
  for: 5m

# [3] OU memória crítica
avg(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) < 0.15
  for: 5m
```

---

## 5. Guarda Especial para Redis

O Redis requer protocolo específico antes do drain, pois pode perder estado se interrompido abruptamente.

### Pré-condições obrigatórias antes de drenar nó com Redis

```bash
# 1. Forçar snapshot imediato
kubectl exec -n <namespace> <redis-pod> -- redis-cli BGSAVE

# 2. Aguardar confirmação de conclusão (comparar timestamp)
kubectl exec -n <namespace> <redis-pod> -- redis-cli LASTSAVE

# 3. Verificar configuração de persistência
kubectl exec -n <namespace> <redis-pod> -- redis-cli CONFIG GET save
```

### Critério de aprovação

Só prosseguir com o drain se:
- `BGSAVE` retornar `Background saving started`
- `LASTSAVE` retornar timestamp posterior ao início da migração
- PDB do Redis permitir disrupção (`disruptions_allowed >= 1`)

> Documentar esse protocolo como **"migração stateful segura"** na metodologia do TCC — é um ponto de diferenciação relevante em relação ao CA/NAP, que não possui essa lógica de guarda.

---

## 6. Hiperparâmetros do Algoritmo

Os valores abaixo são tratados como **hiperparâmetros configuráveis**, permitindo análise de sensibilidade nos experimentos:

| Parâmetro | Símbolo | Valor Padrão | Descrição |
|---|---|---|---|
| Peso CPU | `α` | 0.5 | Contribuição da CPU no score |
| Peso Memória | `β` | 0.3 | Contribuição da memória no score |
| Peso Rede | `γ` | 0.2 | Contribuição da rede no score |
| Limiar de downscaling | `θ_down` | 0.30 | Score abaixo → candidato a E2 |
| Limiar de upscaling | `θ_up` | 0.65 | Score acima → retorno para N2 |
| Janela de observação (down) | `T_down` | 60 min | Duração mínima abaixo de `θ_down` |
| Janela de observação (up) | `T_up` | 10 min | Duração mínima acima de `θ_up` |
| Page fault máximo | `PF_max` | 10/s | Limite de swap ativo tolerado |
| Load ratio máximo (por nó) | `LR_max` | 1.5 | Saturação individual de CPU |

### Sugestão de experimentos de sensibilidade

- Variar `α`, `β`, `γ` com soma = 1.0 e medir falsos positivos de migração
- Avaliar `θ_down` em {0.20, 0.25, 0.30, 0.35} e medir janelas de migração capturadas
- Avaliar `T_down` em {30, 45, 60, 90} minutos e medir risco de migração prematura

---

## 7. Comparação com Abordagem Simples

| Aspecto | Critério simples (só CPU média) | Score composto (CANM) |
|---|---|---|
| Robustez | Baixa — vulnerável à falácia da média | Alta — detecta pressão multidimensional |
| Segurança para Redis | Nenhuma | Guarda explícita de memória e page faults |
| Diferenciação vs CA/NAP | Difícil de argumentar | Score sintético é ponto de originalidade |
| Risco de falsa migração | Alto | Baixo — múltiplos gates simultâneos |
| Calibração empírica | Não se aplica | Hiperparâmetros ajustáveis com dados reais |
| Complexidade de implementação | Baixa | Média — requer coleta de múltiplas séries |

---

## 8. Fontes das Métricas no Ambiente Atual

Todas as métricas listadas são coletadas pelos jobs já configurados em `prometheus.yml`:

| Métrica | Job responsável |
|---|---|
| `node_cpu_seconds_total` | `node_exporter` |
| `node_memory_MemAvailable_bytes` | `node_exporter` |
| `node_vmstat_pgmajfault` | `node_exporter` |
| `node_network_transmit_bytes_total` | `node_exporter` |
| `node_load1` | `node_exporter` |
| `kube_pod_status_phase` | `kubernetes-pods` / `kubernetes-pods-hml` |
| `kube_poddisruptionbudget_status_disruptions_allowed` | `kubernetes-pods` |
| Métricas de container (CPU/mem por pod) | `cadvisor-*` |