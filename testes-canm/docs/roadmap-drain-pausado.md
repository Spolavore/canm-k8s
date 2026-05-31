# Roadmap — Drain pausado/incremental

**Objetivo:** eliminar o erro pós-migração diagnosticado na
[2ª run](plano-ajustes-canm-segunda-run.md): num `high->low`, o `kubectl drain` one-shot
evacua ~28 pods que **cold-startam juntos** no nó E2 novo (warmup ~100–118% por ~8 min) e,
na finalização, o tráfego migra de golpe para pods frios → **timeouts**.

**Ideia (1ª versão, simples):** trocar o drain de um disparo por um **loop em lotes**, com uma
**espera fixa entre lotes**. Assim o warmup deixa de ser sincronizado (os pods aquecem aos
poucos, o nó sobe rumo ao regime ~36% em vez de estourar) e não há o cliff de finalização (a
origem segue servindo seus pods quentes até cada lote ser movido).

> A espera fixa é deliberadamente simples para a 1ª iteração. O ideal — **gatear cada lote pela
> CPU real do nó destino** em vez de um tempo fixo — fica como [Trabalho futuro](#trabalho-futuro).

> Escopo: é uma **reescrita do passo de drain** (não um patch). O `kubectl drain` atual fica
> como fallback (`DRAIN_PACED=false`).

---

## Estado atual (o que muda)

Pipeline em [`MigratorOrchestrator.executeMigrationPipeline`](../../src/components/MigratorOrchestrator.ts#L246):
`addition` (cria nó destino) → **`draining`** (`this.nodeMigrator.drain(node, 60, true)`) → `removing`.

Hoje o `draining` é:
[`GkeNodeMigrator.drain`](../../src/components/GkeNodeMigrator.ts#L33) →
[`KubernetesClient.drain`](../../src/lib/KubernetesClient.ts#L59) →
`kubectl drain ... --timeout=600s` (um disparo, todos os pods).

Só o estágio `draining` muda. `addition` e `removing` ficam iguais.

---

## Desenho do drain pausado (1ª versão)

```
cordon(source)                       # impede novos pods na origem
pods = getEvictablePods(source)      # exclui DaemonSet/mirror/static
for lote in chunks(pods, BATCH):
    for pod in lote: evict(pod)      # Eviction API -> respeita PDB
    sleep(DRAIN_BATCH_INTERVAL)      # espera FIXA entre lotes (warmup do lote)
remove(source)                       # estágio 'removing' (inalterado)
```

A espera fixa entre lotes dá tempo dos pods do lote aquecerem antes de evacuar o próximo,
distribuindo o warmup no tempo em vez de concentrá-lo.

---

## Config nova (env)

| Var | Default | Função |
|---|---|---|
| `DRAIN_PACED` | `false` | Feature flag; `false` mantém o `kubectl drain` atual |
| `DRAIN_BATCH_SIZE` | `3` | Pods evacuados por lote |
| `DRAIN_BATCH_INTERVAL` | `60s` | Espera fixa entre lotes (ajustar empiricamente) |

> `DRAIN_BATCH_INTERVAL` é um chute inicial — sem feedback de CPU, é o usuário que calibra
> (warmup do nó inteiro foi ~8 min para ~28 pods; com lotes de 3 são ~9–10 lotes).

Wiring em [`src/index.ts`](../../src/index.ts) + tipos em
[`src/types.ts`](../../src/types.ts) (`MigrationConfig`), no mesmo padrão das outras vars.

---

## Fases

### Fase 0 — Config + flag (sem comportamento novo)
- Adicionar as 3 vars em `MigrationConfig` (types.ts), defaults no construtor do
  `MigratorOrchestrator`, e leitura de env no `index.ts`.
- `DRAIN_PACED=false` por padrão → nada muda. Permite mergear incremental.

### Fase 1 — Primitivas (KubernetesClient / GkeNodeMigrator)
Adicionar em [`KubernetesClient`](../../src/lib/KubernetesClient.ts) (shell-out kubectl, como o resto):
- `cordon(node)` → `kubectl cordon <node>` (hoje só existe `uncordon`).
- `getPodsOnNode(node)` → `kubectl get pods -A --field-selector spec.nodeName=<node> -o json`,
  filtrando DaemonSet/mirror/static (ownerReferences kind=DaemonSet / annotation mirror).
- `evictPod(ns, name, grace)` → Eviction API (respeita PDB). Opções de implementação:
  - `kubectl` não tem `evict` por pod; usar `kubectl create -f -` com um objeto
    `policy/v1 Eviction` no subresource, **ou**
  - adotar `@kubernetes/client-node` só para `createNamespacedPodEviction`.
  - (NÃO usar `kubectl delete pod` — ignora PDB.)

### Fase 2 — `drainPaced` no GkeNodeMigrator
- `drainPaced(source, opts)` orquestrando: `cordon` → lotes (`evict` + `sleep(DRAIN_BATCH_INTERVAL)`).
- Loop com `DRAIN_BATCH_SIZE`; espera fixa entre lotes.

### Fase 3 — Integrar no pipeline (atrás da flag)
- Em [`executeMigrationPipeline`](../../src/components/MigratorOrchestrator.ts#L246), no estágio
  `draining`: se `DRAIN_PACED` → `drainPaced(...)`; senão → `drain(...)` atual.
- `addition`/`removing` inalterados.
- **Compensação:** mantida como hoje (tudo-ou-nada). Ver [Compensação](#compensação).

### Fase 4 — Validação
- Rodar **um** `high->low` com `DRAIN_PACED=true` e capturar:
  - CPU do nó destino — deve **ficar mais baixa** (sem o pico de 118%);
  - erros do k6 na finalização — devem cair a ~0;
  - **duração da migração** — vai **aumentar** (lotes × `DRAIN_BATCH_INTERVAL`);
- Comparar com a baseline overnight (**0,92%**). Critério: erro por migração ~0, sem Pending.
- Calibrar `DRAIN_BATCH_SIZE` / `DRAIN_BATCH_INTERVAL` conforme a CPU observada.

---

## Compensação

**Mantida como está hoje (tudo-ou-nada)** — é estado de sobrevivência. Em falha no estágio
`draining`, [`compensate('draining', ...)`](../../src/components/MigratorOrchestrator.ts#L181)
faz `uncordon(source)` + remove o nó destino criado.

Consequência aceita nesta versão: se a falha ocorrer **no meio** do drain pausado, alguns pods
já podem ter sido movidos para o nó destino; ao removê-lo, esses pods são despejados e
**reescalonados** pelo scheduler (churn, mas sobrevivível — sem perda de dado). Tratar a falha
parcial de forma fina fica como [Trabalho futuro](#trabalho-futuro).

---

## Riscos e trade-offs (1ª versão)

- **Migração mais lenta** (lotes × espera fixa). Aceitável para um otimizador de custo
  esporádico.
- **Espera fixa é um chute** — sem feedback de CPU, pode ser curta demais (não evita o storm)
  ou longa demais (migração lenta à toa). É o motivo de o gate por CPU ser o próximo passo.
- **Eviction API vs kubectl** — decisão de implementação (Fase 1); o importante é **respeitar
  PDB** (não usar `delete pod`).
- **Interação com PDB**: pacing é *mais* conservador que o drain atual → seguro; a Eviction API
  já honra os PDBs (`maxUnavailable=1`).

---

## Trabalho futuro

### 1. Gate por CPU do destino (substitui a espera fixa)
Em vez de `sleep(DRAIN_BATCH_INTERVAL)`, esperar a **CPU instantânea do nó destino** cair
abaixo de um limiar antes do próximo lote. Vantagens: adaptativo (não é chute), e
**auto-protetor** — se a carga de regime não couber, o gate trava em vez de criar storm (o
travamento é o sinal de que virou problema de capacidade, não de pacing).
- `MetricsAdapter.getNodeCpuInstant(node)` reaproveitando o Prometheus, com janela curta
  (`[1m]`) — diferente do score em janela de 3–10 min.
- Variante curta do `CPU_USAGE_QUERY` em
  [`prometheus.queries.ts`](../../src/repositories/prometheus.queries.ts).
- Vars: `DRAIN_CPU_GATE` (ex. 0,5 = joelho), `DRAIN_GATE_TIMEOUT`, `DRAIN_GATE_POLL`.
- Cuidado com ruído: exigir o limiar por ≥2 leituras seguidas.

### 2. `DRAIN_MAX_TOTAL` — teto do drain inteiro
Limite de tempo do drain completo; estourou → falha → compensação. Evita drain pendurado
indefinidamente quando o pacing não converge.

### 3. Compensação de falha parcial
Quando parte dos pods já foi movida, **não** apagar o nó destino (apagar = churn/derruba os
movidos). Ação fina: `uncordon(source)`, **manter** o destino com os pods já movidos, marcar a
migração como `partial` e delegar à reconciliação convergir. Substitui o tudo-ou-nada atual
para reduzir churn.

### Fora de escopo deste roadmap (registrar)
- **Readiness app-side** que reflita capacidade real (fix dos ~26 serviços; risco de flap).
- **Política**: gatear `high->low` a vales reais / suavizar agressividade do scale-down.
- **Nós menores** no pool low (reduz pods por nó drenado).
