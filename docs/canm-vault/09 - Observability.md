# Observability — Logs e Monitoramento

O CANM persiste três arquivos de auditoria em formato **JSONL** (uma linha JSON por entrada) na raiz do projeto:

| Arquivo | O que registra |
|---------|---------------|
| `migrations.jsonl` | Cada migração iniciada (sucesso ou falha) |
| `compensations.jsonl` | Cada acionamento do mecanismo de compensação |
| `reconciliations.jsonl` | Cada ação executada pela reconciliação |

---

## `migrations.jsonl`

Cada migração concluída (com sucesso ou falha) é registrada, em formato **JSONL** (uma linha JSON por entrada).

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

## `compensations.jsonl`

Registra cada acionamento do mecanismo de compensação — ou seja, toda vez que uma etapa do pipeline falha e o sistema tenta desfazer o que foi feito.

### Schema

```typescript
{
  timestamp:       string,   // ISO8601 — quando a compensação ocorreu
  sourceNode:      string,   // nó origem da migração que falhou
  destinationNode?: string,  // nó destino (presente apenas quando failedStage = "draining")
  direction:       "high->low" | "low->high",
  failedStage:     "addition" | "draining" | "removing",
  action:          "annotation_cleared"           // addition: annotation MIGRATION_STAGE removida do source
                 | "uncordoned_dest_deleted"       // draining: source uncordoned e destination deletado
                 | "dest_marked_pending_removal"   // draining: destination não pôde ser deletado, marcado para reconciliação
                 | "delegated_to_reconciliation",  // removing: nenhuma ação imediata, annotation persiste para retry
  outcome:         "success" | "failed"
}
```

### Queries Úteis

```bash
# Todas as compensações com falha
cat compensations.jsonl | jq 'select(.outcome == "failed")'

# Compensações por etapa que falhou
cat compensations.jsonl | jq -s 'group_by(.failedStage) | map({stage: .[0].failedStage, count: length})'

# Destinations que ficaram como pending-removal (requerem atenção da reconciliação)
cat compensations.jsonl | jq 'select(.action == "dest_marked_pending_removal")'

# Últimas 10 compensações
tail -n 10 compensations.jsonl | jq .
```

---

## `reconciliations.jsonl`

Registra cada ação executada pelo loop de reconciliação — uma entrada por nó processado por tick.

### Schema

```typescript
{
  timestamp:      string,  // ISO8601 — quando a ação foi executada
  node:           string,  // nome do nó reconciliado
  nodeState?:     "created" | "managed" | "pending-removal",  // estado CANM do nó (presente no Case B)
  pipelineStage?: "addition" | "draining" | "removing",        // stage em que o nó estava preso (presente no Case C)
  action:         "deleted"            // nó removido do cluster (orphan, state não-terminal ou retry removal)
                | "promoted_to_managed" // destination promovido a managed (source removido ou em stage removing)
                | "stage_cleared"      // annotation MIGRATION_STAGE removida do source (addition ou draining)
                | "retry_removal",     // remoção do source retentada (stage removing)
  outcome:        "success" | "failed"
}
```

### Queries Úteis

```bash
# Ações com falha (indicam que o nó ainda precisa de atenção)
cat reconciliations.jsonl | jq 'select(.outcome == "failed")'

# Distribuição de ações por tipo
cat reconciliations.jsonl | jq -s 'group_by(.action) | map({action: .[0].action, count: length})'

# Nós que foram promovidos a managed (migrações recuperadas pela reconciliação)
cat reconciliations.jsonl | jq 'select(.action == "promoted_to_managed")'

# Nós com retry de remoção — útil para identificar sources persistentemente presos
cat reconciliations.jsonl | jq 'select(.action == "retry_removal")' | jq -s 'group_by(.node) | map({node: .[0].node, retries: length, lastOutcome: .[-1].outcome})'

# Todas as ações sobre um nó específico
cat reconciliations.jsonl | jq 'select(.node == "<nome-do-no>")'
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
| Compensações repetidas no mesmo nó | `compensations.jsonl` — verificar se `outcome=failed` está persistindo |
| Reconciliação retentando remoção várias vezes | `reconciliations.jsonl` com `action=retry_removal` e `outcome=failed` — verificar permissões gcloud |
| Destination deletado inesperadamente | `reconciliations.jsonl` com `action=deleted` — cruzar com `compensations.jsonl` para ver se houve falha de drain anterior |
| Arquivos de log crescendo muito | Normal — nenhum dos três arquivos tem rotação automática; rotacionar manualmente se necessário |

---

## Relacionados

- [[04 - Migration Pipeline]] — o que acontece durante cada migração
- [[05 - Reconciliation Loop]] — estados que a reconciliação tenta resolver
- [[07 - How to Run]] — como iniciar e verificar que está funcionando
