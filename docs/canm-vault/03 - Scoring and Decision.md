# Scoring and Decision — Algoritmo de Score e Política

## Coleta de Métricas

O CANM usa **Prometheus** para obter o uso de CPU e memória de cada nó.

### Queries PromQL

**CPU Usage por nó (%):**
```promql
sum(rate(container_cpu_usage_seconds_total[<timeWindow>])) by (node)
  / sum(machine_cpu_cores) by (node) * 100
```

**Memory Usage por nó (%):**
```promql
sum(container_memory_working_set_bytes) by (node)
  / sum(machine_memory_bytes) by (node) * 100
```

Ambas filtradas por `job="<PROMETHEUS_JOB>"`.

---

## Cálculo do Score

### Normalização de Pesos

Os pesos `CPU_WEIGHT` e `MEMORY_WEIGHT` (configuráveis) são **normalizados** para somar 1.0:

```typescript
// Exemplo: CPU_WEIGHT=0.75, MEMORY_WEIGHT=0.25
normalized_cpu = 0.75 / (0.75 + 0.25) = 0.75
normalized_mem = 0.25 / (0.75 + 0.25) = 0.25
```

Isso garante que mudar um peso sem ajustar o outro não desequilibra o resultado.

### Fórmula Final

```
score = (cpuUsage% × normalizedCpuWeight + memoryUsage% × normalizedMemWeight) / 100
```

**Resultado:** valor entre `0.0` e `1.0`
- `0.0` = nó completamente ocioso
- `1.0` = nó com 100% de CPU e memória usados

**Exemplo:**
```
cpuUsage   = 20% → contribuição = 20 × 0.75 = 15.0
memoryUsage = 60% → contribuição = 60 × 0.25 = 15.0
score = (15.0 + 15.0) / 100 = 0.30  → nó candidato a high→low (abaixo de 0.35)
```

---

## Janelas de Tempo de Avaliação

O CANM usa janelas de tempo **diferentes por pool**:

| Pool | Variável | Default | Racional |
|------|----------|---------|----------|
| Low Pool | `LOW_POOL_TIME_WINDOW_EVAL` | `10m` | Reage mais rápido à sobrecarga |
| High Pool | `HIGH_POOL_TIME_WINDOW_EVAL` | `1h` | Janela longa evita flutuações em nós caros |

A janela longa no high pool garante que um spike temporário não dispare uma migração cara desnecessariamente.

---

## Cooldown por Nó

Após uma migração (criação do nó destino), há um período de cooldown para evitar *ping-pong* entre pools:

```typescript
isNodeInCooldown(node): boolean {
  const cooldown = node.nodePool === lowPool
    ? LOW_NODE_COOL_DOWN   // default: 5 minutos
    : HIGH_NODE_COOL_DOWN; // default: 30 minutos
  return Date.now() - new Date(node.creationTimestamp).getTime() < cooldown;
}
```

Nós em cooldown são **ignorados** na avaliação.

---

## Política de Decisão

### `prioritizeCost` (padrão)

```
1. Avalia HIGH POOL (nós caros):
   - Ordena por score CRESCENTE (menor uso primeiro)
   - Se algum nó tem score ≤ LOW_SCORE_THRESHOLD (0.35):
     → Seleciona o de menor score
     → Inicia migração high→low
     → Encerra avaliação deste tick

2. Se não encontrou candidato no high pool:
   Avalia LOW POOL (nós baratos):
   - Ordena por score DECRESCENTE (maior uso primeiro)
   - Se algum nó tem score ≥ HIGH_SCORE_THRESHOLD (0.6):
     → Seleciona o de maior score
     → Inicia migração low→high
```

### `prioritizePerformance`

Mesma lógica, mas **invertida**: avalia low pool primeiro (busca por sobrecarga), e só então avalia high pool (busca por ociosidade).

---

## Diagrama de Decisão

```
evaluateCluster()
│
├── policy = prioritizeCost
│   │
│   ├── [HIGH POOL] scores ≤ 0.35?
│   │   ├── SIM → migrate high→low  (menor score vence)
│   │   └── NÃO ↓
│   │
│   └── [LOW POOL] scores ≥ 0.6?
│       ├── SIM → migrate low→high  (maior score vence)
│       └── NÃO → nenhuma ação
│
└── policy = prioritizePerformance
    │
    ├── [LOW POOL] scores ≥ 0.6?
    │   ├── SIM → migrate low→high
    │   └── NÃO ↓
    │
    └── [HIGH POOL] scores ≤ 0.35?
        ├── SIM → migrate high→low
        └── NÃO → nenhuma ação
```

---

## Exemplo Real (do `migrations.jsonl`)

```json
{
  "timestamp": "2026-05-14T00:52:01.268Z",
  "durationMs": 308662,
  "direction": "high->low",
  "node": "gke-beta-pool-beta-high-0de43245-hdv1",
  "score": 0.31,
  "fromPool": "pool-beta-high",
  "toPool": "pool-beta",
  "policy": "prioritizeCost",
  "status": "passed"
}
```

Score de `0.31` no high pool, abaixo do threshold `0.35` → migração executada com sucesso em ~5 minutos.

---

## Relacionados

- [[02 - Architecture]] — onde MetricsAdapter se encaixa no sistema
- [[06 - Configuration]] — como configurar thresholds, pesos e janelas
- [[04 - Migration Pipeline]] — o que acontece após a decisão ser tomada
