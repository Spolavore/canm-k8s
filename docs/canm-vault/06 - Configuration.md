 # Configuration — Hiperparâmetros e Variáveis de Ambiente

Todas as configurações do CANM são lidas de um arquivo `.env` na raiz do projeto. Valores com `*` são obrigatórios.

---

## Cluster GKE

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `EXTERNAL_PROVIDER` | string | `'gke'` | Provider de cloud (apenas `gke` suportado) |
| `GKE_CLUSTER_NAME` * | string | — | Nome do cluster GKE |
| `GKE_REGION` * | string | — | **Zona** do cluster (ex: `us-central1-a`) — ver [[08 - Limitations]] |
| `GKE_PROJECT` * | string | — | Project ID no GCP |
| `GKE_INTERNAL_IP` | bool string | `'false'` | Se `'true'`, usa IP interno do cluster nas credenciais |

---

## Prometheus

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `PROMETHEUS_API_URL` * | URL | — | Endpoint base do Prometheus (ex: `http://prometheus.local:9090/`) |
| `PROMETHEUS_JOB` | string | `'kubernetes-nodes-metrics-beta'` | Nome do job que expõe métricas de nós |

---

## Node Pools

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `HIGH_NODE_POOL` * | string | — | Nome do node pool caro (high-performance) |
| `LOW_NODE_POOL` * | string | — | Nome do node pool barato (low-cost) |

---

## Thresholds de Score

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `LOW_SCORE_THRESHOLD` | float | `0.35` | Score ≤ este valor → nó do high pool é candidato a migrar para o low |
| `HIGH_SCORE_THRESHOLD` | float | `0.6` | Score ≥ este valor → nó do low pool é candidato a migrar para o high |

**Zona segura:** scores entre `LOW_SCORE_THRESHOLD` e `HIGH_SCORE_THRESHOLD` → nenhuma migração.

---

## Cooldowns

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `HIGH_NODE_COOL_DOWN` | duration | `'30m'` | Nós recém-criados no high pool ficam imunes por este período |
| `LOW_NODE_COOL_DOWN` | duration | `'5m'` | Nós recém-criados no low pool ficam imunes por este período |

---

## Política de Migração

| Variável | Tipo | Default | Opções |
|----------|------|---------|--------|
| `MIGRATION_POLICY` | enum | `'prioritizeCost'` | `prioritizeCost` / `prioritizePerformance` |

Ver [[03 - Scoring and Decision]] para detalhes.

---

## Janelas de Tempo de Avaliação

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `LOW_POOL_TIME_WINDOW_EVAL` | duration | `'10m'` | Janela Prometheus para score do low pool |
| `HIGH_POOL_TIME_WINDOW_EVAL` | duration | `'1h'` | Janela Prometheus para score do high pool |

---

## Intervalo de Operação

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `CHECK_INTERVAL` | duration | `'1m'` | Tempo entre ticks (reconciliação + avaliação) |

---

## Drain Pausado/Incremental

Controla a etapa DRAINING do pipeline (ver [[04 - Migration Pipeline]]). Com `DRAIN_PACED=false` (default) nada muda — usa-se o `kubectl drain` one-shot. Com `DRAIN_PACED=true`, os pods são evacuados em lotes via Eviction API, com espera fixa entre lotes.

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `DRAIN_PACED` | bool string | `'false'` | Feature flag. Apenas `'TRUE'` (maiúsculo) ativa o drain pausado; qualquer outro valor mantém o `kubectl drain` atual |
| `DRAIN_BATCH_SIZE` | int | `10` | Quantidade de pods evacuados por lote |
| `DRAIN_BATCH_INTERVAL` | duration | `'5m'` | Espera fixa entre lotes (tempo para o lote aquecer no nó destino) |

**Calibração:** o `DRAIN_BATCH_INTERVAL` é um chute inicial — sem feedback de CPU, é o operador que calibra empiricamente observando o warmup do nó destino. Lotes menores (ex: `3`–`5`) distribuem melhor o warmup mas alongam a migração; lotes maiores aproximam o comportamento do one-shot. Duração total ≈ `(nº de lotes − 1) × DRAIN_BATCH_INTERVAL`.

> A espera fixa é deliberadamente simples nesta 1ª versão. Gatear cada lote pela **CPU real do nó destino** (em vez de tempo fixo) é [[10 - Roadmap|trabalho futuro]].

---

## Pesos de Métricas

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `CPU_WEIGHT` | float | `0.75` | Peso do CPU no score composto |
| `MEMORY_WEIGHT` | float | `0.25` | Peso da memória no score composto |

Os pesos são **normalizados automaticamente** — não precisam somar 1.0, mas o rácio entre eles determina a influência relativa.

---

## Debug

| Variável | Tipo | Default | Descrição |
|----------|------|---------|-----------|
| `SHOW_DECISIONS_LOGS` | bool string | — | Se `'TRUE'`, loga raciocínio de decisão detalhado |

---

## Formato de Durações

O CANM usa formato de string para durações em todas as variáveis de tempo:

| Sufixo | Unidade |
|--------|---------|
| `ms` | milissegundos |
| `s` | segundos |
| `m` | minutos |
| `h` | horas |

**Exemplos válidos:** `'30m'`, `'1h'`, `'90s'`, `'500ms'`, `'1m30s'` (não — apenas um sufixo por vez)

---

## Exemplo de `.env`

```env
# Cluster GKE
EXTERNAL_PROVIDER=gke
GKE_CLUSTER_NAME=my-cluster
GKE_REGION=us-central1-a
GKE_PROJECT=my-gcp-project

# Prometheus
PROMETHEUS_API_URL=http://prometheus.local:9090/
PROMETHEUS_JOB=kubernetes-nodes-metrics

# Node Pools
HIGH_NODE_POOL=pool-high-performance
LOW_NODE_POOL=pool-low-cost

# Thresholds (zona segura: 0.35 < score < 0.60)
LOW_SCORE_THRESHOLD=0.35
HIGH_SCORE_THRESHOLD=0.60

# Cooldowns
HIGH_NODE_COOL_DOWN=30m
LOW_NODE_COOL_DOWN=5m

# Política
MIGRATION_POLICY=prioritizeCost

# Janelas de avaliação
LOW_POOL_TIME_WINDOW_EVAL=10m
HIGH_POOL_TIME_WINDOW_EVAL=1h

# Intervalo de operação
CHECK_INTERVAL=1m

# Drain pausado/incremental (opcional; default desligado)
DRAIN_PACED=TRUE
DRAIN_BATCH_SIZE=10
DRAIN_BATCH_INTERVAL=5m

# Pesos de score (serão normalizados)
CPU_WEIGHT=0.75
MEMORY_WEIGHT=0.25

# Debug
SHOW_DECISIONS_LOGS=TRUE
```

---

## Considerações de Tuning

### Quando aumentar `HIGH_POOL_TIME_WINDOW_EVAL`
Se nós do high pool estão migrando desnecessariamente por picos curtos de CPU (ex: jobs batch). Janelas maiores (ex: `2h`) tornam a decisão mais conservadora.

### Quando diminuir `LOW_SCORE_THRESHOLD`
Se o sistema está migrando nós muito utilizados do high pool. Reduzir para `0.2` exige utilização ainda mais baixa antes de migrar.

### Quando ajustar `CPU_WEIGHT`
Workloads memory-intensive (ex: Redis, caches): considere `CPU_WEIGHT=0.4, MEMORY_WEIGHT=0.6`.

### Quando reduzir `CHECK_INTERVAL`
Para reação mais rápida a mudanças de carga. Porém aumenta frequência de queries no Prometheus.

---

## Relacionados

- [[03 - Scoring and Decision]] — como thresholds e pesos afetam o algoritmo
- [[08 - Limitations]] — restrição sobre `GKE_REGION` precisar ser zona
