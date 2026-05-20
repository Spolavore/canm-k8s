# Observability — Logs e Monitoramento

## Arquivo de Auditoria (`migrations.jsonl`)

Cada migração concluída (com sucesso ou falha) é registrada em `migrations.jsonl` na raiz do projeto, em formato **JSONL** (uma linha JSON por entrada).

### Schema

```typescript
{
  timestamp:  string,  // ISO8601 — quando a migração terminou
  durationMs: number,  // tempo total em milissegundos
  direction:  "high->low" | "low->high",
  node:       string,  // nome do nó origem que foi migrado
  score:      number,  // score do nó no momento da decisão (0-1)
  fromPool:   string,  // nome do node pool de origem
  toPool:     string,  // nome do node pool de destino
  policy:     "prioritizeCost" | "prioritizePerformance",
  status:     "passed" | "failed"
}
```

### Exemplo Real

```json
{"timestamp":"2026-05-14T00:52:01.268Z","durationMs":308662,"direction":"high->low","node":"gke-beta-pool-beta-high-0de43245-hdv1","score":0.31,"fromPool":"pool-beta-high","toPool":"pool-beta","policy":"prioritizeCost","status":"passed"}
```

Uma migração típica leva ~5 minutos (`308662 ms ≈ 5.1 min`) — dominado pela criação da instância e espera pelo nó ficar Ready.

---

## Queries Úteis no `migrations.jsonl`

```bash
# Visualizar em tempo real
tail -f migrations.jsonl | jq .

# Apenas migrações com falha
cat migrations.jsonl | jq 'select(.status == "failed")'

# Últimas 5 migrações
tail -n 5 migrations.jsonl | jq .

# Estatísticas por status
cat migrations.jsonl | jq -s 'group_by(.status) | map({
  status: .[0].status,
  count: length,
  avg_duration_min: (map(.durationMs) | add / length / 60000 | round)
})'

# Migrações high→low (economias)
cat migrations.jsonl | jq 'select(.direction == "high->low" and .status == "passed")'

# Distribuição de scores ao migrar
cat migrations.jsonl | jq '[.score] | sort | {min: min, max: max, avg: (add/length)}'
```

---

## Logs de Stdout

O CANM usa o módulo `logger.ts` para logs estruturados no stdout. Em modo de desenvolvimento (`SHOW_DECISIONS_LOGS=TRUE`), inclui raciocínio de decisão detalhado.

### Categorias de Log

| Evento | Nível | Exemplo |
|--------|-------|---------|
| Tick iniciado | INFO | `[tick] reconciliation started` |
| Nó avaliado | DEBUG | `[eval] node-A score=0.71 (high pool, above threshold)` |
| Migração iniciada | INFO | `[migration] high->low node-B score=0.25` |
| Etapa concluída | INFO | `[pipeline] ADDITION complete: gke-canm-pool-...` |
| Compensação | WARN | `[compensate] drain failed, uncordoning source` |
| Reconciliação | INFO | `[reconcile] removing orphan node gke-canm-pool-...` |
| Erro | ERROR | `[error] gcloud delete-instances failed: ...` |

---

## Inspecionando Estado via kubectl

```bash
# Ver todos os nós com annotations CANM
kubectl get nodes -o json | jq '
  .items[]
  | select(.metadata.annotations | to_entries | map(.key) | any(startswith("canm.io/")))
  | {
      name: .metadata.name,
      pool: .metadata.labels["cloud.google.com/gke-nodepool"],
      annotations: (.metadata.annotations | with_entries(select(.key | startswith("canm.io/"))))
    }
'

# Nós em migração ativa (com migration-stage)
kubectl get nodes -o json | jq '
  .items[]
  | select(.metadata.annotations["canm.io/migration-stage"] != null)
  | {name: .metadata.name, stage: .metadata.annotations["canm.io/migration-stage"]}
'

# Nós criados pelo CANM (prefixo gke-canm-)
kubectl get nodes | grep "^gke-canm-"

# Status de nó específico
kubectl describe node <gke-canm-pool-...>
```

---

## Métricas que o CANM Consome (Prometheus)

Para verificar se as métricas estão disponíveis corretamente:

```bash
# CPU usage por nó (deve retornar valores para cada nó)
curl -s "http://<PROMETHEUS_URL>/api/v1/query" \
  --data-urlencode 'query=sum(rate(container_cpu_usage_seconds_total[5m])) by (node)' \
  | jq '.data.result[] | {node: .metric.node, value: .value[1]}'

# Memory usage por nó
curl -s "http://<PROMETHEUS_URL>/api/v1/query" \
  --data-urlencode 'query=sum(container_memory_working_set_bytes) by (node) / sum(machine_memory_bytes) by (node) * 100' \
  | jq '.data.result[] | {node: .metric.node, value: .value[1]}'

# Verificar se o job existe
curl -s "http://<PROMETHEUS_URL>/api/v1/label/job/values" | jq '.data[]'
```

---

## Sinais de Alerta

| Situação | O que verificar |
|----------|-----------------|
| CANM não migra nenhum nó | Scores dentro da zona segura? Cooldowns ativos? `SHOW_DECISIONS_LOGS=TRUE` |
| Migrações sempre falham | Permissões GCP? Versão do kubectl? Logs de erro detalhados |
| Source preso em `stage=draining` | PDB impedindo evicção? `kubectl describe node <source>` |
| Nó `gke-canm-*` existe mas state ≠ `managed` | Reconciliação deve limpar — se persistir, verificar permissões gcloud |
| `migrations.jsonl` crescendo muito | Normal — arquivo não tem rotação automática; rotacionar manualmente se necessário |

---

## Relacionados

- [[04 - Migration Pipeline]] — o que acontece durante cada migração
- [[05 - Reconciliation Loop]] — estados que a reconciliação tenta resolver
- [[07 - How to Run]] — como iniciar e verificar que está funcionando
