# Architecture — Componentes e Integrações

## Estrutura de Arquivos

```
canm/
├── src/
│   ├── components/
│   │   ├── MigratorOrchestrator.ts   ← orquestrador principal
│   │   ├── GkeNodeMigrator.ts        ← integração GKE 
│   │   ├── MetricsAdapter.ts         ← coleta de métricas Prometheus
│   │   └── AuditLogger.ts            ← log de migrações
│   ├── services/
│   │   ├── prometheus.service.ts     ← cliente HTTP para Prometheus
│   │   └── axios.service.ts          ← cliente HTTP genérico
│   ├── lib/
│   │   └── KubernetesClient.ts       ← wrapper do SDK @kubernetes/client-node
│   ├── repositories/
│   │   └── prometheus.queries.ts     ← queries PromQL
│   ├── config/
│   │   └── gkeCredentialsGenerator.ts← autenticação GKE/kubeconfig
│   ├── utils/
│   │   ├── constants.ts              ← annotation keys (canm.io/*)
│   │   ├── math.ts                   ← normalize(), comp()
│   │   ├── date.ts                   ← parsing de durações ('30m' → ms)
│   │   ├── hash.ts                   ← geração de hashes aleatórios
│   │   ├── bytes.ts                  ← conversão de unidades de byte
│   │   └── logger.ts                 ← logging estruturado (stdout)
│   ├── types.ts                      ← tipos TypeScript globais
│   └── index.ts                      ← entry point
└── docs/
    ├── migration-pipeline.md
    ├── compensacao-e-reconciliacao.md
    └── limitacoes-conhecidas.md
```

---

## Diagrama de Componentes

```
┌──────────────────────────────────────────────────────────────────┐
│                       CANM Process                               │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              MigratorOrchestrator                           │ │
│  │  (decisões, loop de ticks, reconciliação, pipeline, saga)   │ │
│  └──────┬────────────────┬──────────────────┬──────────────────┘ │
│         │                │                  │                    │
│  ┌──────▼───────┐ ┌──────▼──────┐ ┌────────▼──────────────────┐  │
│  │MetricsAdapter│ │GkeNodeMigrat│ │      AuditLogger           │ │
│  │              │ │or           │ │  (JSONL em migrations.jsonl│ │
│  │ cpuWeight    │ │             │ │   + stdout)                │ │
│  │ memoryWeight │ │ k8sClient   │ └────────────────────────────┘ │
│  └──────┬───────┘ └──────┬──────┘                                │
│         │                │                                       │
│  ┌──────▼───────┐ ┌──────▼──────────────────────────────────┐    │
│  │ Prometheus   │ │         KubernetesClient                 │   │
│  │ Service      │ │  (SDK @kubernetes/client-node)           │   │
│  └──────────────┘ └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
         │                │
         │                ├── kubectl CLI  (drain, uncordon, wait)
         │                └── gcloud CLI   (MIG create/delete instances)
         │
         └── Prometheus HTTP API  (queries PromQL)
```

---

## Fluxo de Dados por Tick

```
1. CHECK_INTERVAL expira (default: 1 minuto)
   │
2. reconcilePendingMigrations()
   ├── listNodes() → filtra por annotations CANM
   ├── Para cada nó inconsistente: tenta corrigir (uncordon, delete, retry)
   └── Retorna: seguro para avaliar?  (true/false)
   │
3. [se seguro] evaluateCluster()
   ├── getNodesScore(HIGH_POOL_TIME_WINDOW_EVAL) → scores do high pool
   ├── getNodesScore(LOW_POOL_TIME_WINDOW_EVAL) → scores do low pool
   ├── expandNodesInfo() → adiciona nodePool + creationTimestamp
   ├── Filtra nós em cooldown
   ├── Avalia thresholds (LOW_SCORE_THRESHOLD / HIGH_SCORE_THRESHOLD)
   └── Se candidato encontrado → migrateNode(node)
   │
4. [se migração iniciada] executeMigrationPipeline(node, direction)
   ├── Etapa ADDITION   → GkeNodeMigrator.addNode*()
   ├── Etapa DRAINING   → mecanismo configurável: drain() one-shot | batchedDrain() por lotes |
   │                       surge/rollout maxUnavailable=0 (evacuação sem downtime)
   └── Etapa REMOVING   → GkeNodeMigrator.removeNode*()
   │
5. compensate() ou AuditLogger.log() conforme resultado
   │
6. Aguarda próximo tick
```

---

## Responsabilidades por Classe

### `MigratorOrchestrator`
- Inicia e controla o loop de ticks (`start()`)
- Toma todas as **decisões de migração** (avaliar, selecionar candidato, definir direção)
- Executa a **saga** (pipeline sequencial com compensações)
- Gerencia a **reconciliação** de estados incompletos
- Mantém configuração (`MigrationConfig`) lida do `.env`

### `GkeNodeMigrator`
- Abstrai todas as operações **GKE-específicas**
- Gerencia criação e remoção de instâncias via `gcloud compute instance-groups managed`
- Gera nomes únicos para os nós criados (`gke-canm-<pool>-<hash>`)
- Expande informações de nós com metadados do GCP (creationTimestamp, pool)
- Detecta qual MIG (Managed Instance Group) pertence a cada node pool

### `MetricsAdapter`
- Faz queries no **Prometheus** para CPU e Memory por nó
- Aplica pesos normalizados (`cpuWeight`, `memoryWeight`) ao calcular o score final
- Suporta diferentes janelas de tempo por pool
- Retorna array de `NodeScore` com `node name → score (0-1)`

### `KubernetesClient`
- Wrapper sobre `@kubernetes/client-node`
- Executa `kubectl drain`, `kubectl cordon`/`uncordon`, `kubectl wait`
- `getPodsOnNode` (pods despejáveis) e `evictPod` (Eviction API `policy/v1`, respeita PDB) — usados pelo drain pausado por lotes
- Faz `annotateNode` / `removeNodeAnnotation` (chave para o mecanismo de estado)
- Configura kubeconfig automaticamente via `gkeCredentialsGenerator` se necessário

### `AuditLogger`
- Persiste cada migração em `migrations.jsonl` (formato JSONL, append-only)
- Loga no stdout com timestamps e nível de severidade

---

## Integrações Externas

| Sistema | Como conecta | Operações |
|---------|--------------|-----------|
| **Prometheus** | HTTP REST API (`PROMETHEUS_API_URL`) | Query `cpu_usage`, `memory_usage` por nó |
| **Kubernetes API** | SDK + kubeconfig | `listNodes`, `annotate`, `drain`, `cordon`/`uncordon`, `getPodsOnNode`, `evictPod` (Eviction API), `wait` |
| **GCP Compute / MIG** | `gcloud` CLI no PATH | `create-instance`, `delete-instances`, `wait-until --stable` |
| **kubectl** | CLI no PATH | `drain`, `cordon`, `uncordon`, `wait --for=create`, `wait --for=condition=Ready` |

---

## Relacionados

- [[03 - Scoring and Decision]] — como MetricsAdapter calcula scores
- [[04 - Migration Pipeline]] — sequência de etapas do GkeNodeMigrator
- [[05 - Reconciliation Loop]] — lógica do reconcilePendingMigrations
