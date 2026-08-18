# Migration Pipeline — Saga Pattern

## Visão Geral

Cada migração passa por **3 etapas sequenciais** implementadas como uma **Saga** com transações compensatórias. Se qualquer etapa falha, o sistema executa compensações para desfazer o que foi feito, evitando deixar o cluster em estado inconsistente.

```
[ADDITION] → [DRAINING] → [REMOVING] → [MANAGED]
```

---

## Annotations CANM

O estado da migração é persistido como **annotations** no recurso `Node` do Kubernetes. Isso é fundamental: sobrevive a reinicializações do CANM.

**No nó origem (source):**

| Annotation | Valores possíveis | Significado |
|------------|-------------------|-------------|
| `canm.io/migration-stage` | `addition` / `draining` / `removing` | Etapa atual da migração |
| `canm.io/last-reconciliation` | ISO8601 | Timestamp da última tentativa de reconciliação |

**No nó destino (novo nó criado):**

| Annotation | Valores possíveis | Significado |
|------------|-------------------|-------------|
| `canm.io/state` | `created` / `managed` | Estado do ciclo de vida do nó |

**Observação:** Nós criados pelo CANM sempre têm prefixo `gke-canm-` no nome para facilitar a rastreabilidade e evidenciar as ações tomadas pelo mecanismo.

---

## Etapa 1 — ADDITION

**Objetivo:** Criar o nó de destino no pool alvo.

```
annotate(source, MIGRATION_STAGE = 'addition')
  ↓
gcloud compute instance-groups managed create-instance
  --instance=gke-canm-<pool>-<hash>
  --zone=<GKE_REGION>
  ↓
gcloud compute instance-groups managed wait-until --stable
  ↓
kubectl wait --for=create node/gke-canm-<pool>-<hash>  (timeout: 120s)
  ↓
kubectl wait --for=condition=Ready node/gke-canm-<pool>-<hash>  (timeout: 300s)
  ↓
annotate(novo_nó, STATE = 'created')
```

**Compensação em falha:** Remove imediatamente a annotation `MIGRATION_STAGE` do source. O cluster permanece intacto — nenhum nó foi criado. Para crashes (processo morto antes do catch), a reconciliação (Case C addition) é o safety net.

---

## Etapa 2 — DRAINING

**Objetivo:** Drenar todos os pods do nó origem para que possam ser rescheduleados no novo nó (ou em outros nós disponíveis).

Existem **dois modos**, selecionados pela flag `DRAIN_PACED` (ver [[06 - Configuration]]). A compensação é idêntica nos dois.

### Modo legado — drain one-shot (`DRAIN_PACED=false`, default)

```
annotate(source, MIGRATION_STAGE = 'draining')
  ↓
kubectl drain <source>
  --grace-period=60
  --force
  --ignore-daemonsets
  --delete-emptydir-data
  ↓
(todos os pods saem de uma vez → movidos para gke-canm-* ou outros nós)
```

### Modo pausado/incremental — drain por lotes (`DRAIN_PACED=true`)

**Motivação:** no one-shot, todos os pods do nó (na medição, ~28–40) são evacuados de uma vez e **cold-startam juntos** no nó destino recém-criado, gerando um pico de warmup de CPU e timeouts na finalização (tráfego migra de golpe para pods frios). O drain pausado distribui esse warmup no tempo, evacuando em lotes com uma espera fixa entre eles — a origem segue servindo seus pods quentes até cada lote ser movido.

```
annotate(source, MIGRATION_STAGE = 'draining')
  ↓
cordon(source)                          ← impede novos pods na origem
  ↓
getPodsOnNode(source)                   ← pods DESPEJÁVEIS (exclui DaemonSet/mirror/static)
  ↓
para cada lote de DRAIN_BATCH_SIZE pods:
    para cada pod do lote:
        evictPod(pod)                   ← Eviction API (policy/v1) → respeita PDB
    sleep(DRAIN_BATCH_INTERVAL)         ← espera FIXA entre lotes (warmup do lote)
                                          (não há espera após o último lote)
```

Detalhes do modo pausado:
- **Eviction API, não `kubectl delete pod`:** [`evictPod`](../../src/lib/KubernetesClient.ts) usa o subrecurso `eviction` (`policy/v1`), que **honra PodDisruptionBudgets**. Se um PDB bloquearia a remoção, a API responde `429` (backpressure) — o pod é retentado com backoff; esgotadas as tentativas, é logado e o drain segue (o pod remanescente sai no estágio REMOVING). `404` (pod já inexistente) é tratado como despejado.
- **Cordon explícito primeiro**, garantindo que pods substitutos não voltem à origem (vão para o destino ou outros nós).
- **Trade-off:** a migração fica **mais lenta** (lotes × `DRAIN_BATCH_INTERVAL`) em troca de eliminar o pico de warmup. Aceitável para um otimizador de custo esporádico.

### Compensação em falha (idêntica nos dois modos)
```
1. kubectl uncordon <source>         ← drain pode cordonar mesmo em erro
2. gcloud ... delete-instances <novo_nó>
   ├── SUCESSO → cluster voltou ao estado inicial
   └── FALHA   → annotate(novo_nó, STATE = 'pending-removal')
                  reconciliação vai remover depois
```

> **Falha parcial no modo pausado:** se o drain falhar **no meio** dos lotes, alguns pods já podem ter sido movidos para o destino. A compensação atual (tudo-ou-nada) remove esse destino → os pods movidos são reescalonados (churn, mas sobrevivível, sem perda de dado). Compensação fina é [[10 - Roadmap|trabalho futuro]].

---

## Etapa 3 — REMOVING

**Objetivo:** Remover o nó origem do Managed Instance Group do GCP.

```
annotate(source, MIGRATION_STAGE = 'removing')
  ↓
gcloud compute instance-groups managed delete-instances
  --instance=<source>
  --zone=<zona_da_instância>
  ↓
gcloud compute instance-groups managed wait-until --stable
```

**Compensação em falha:** Nenhuma imediata — o source já foi drenado, o nó novo já está rodando. A annotation `MIGRATION_STAGE=removing` no source sinaliza para a reconciliação tentar novamente.

---

## Conclusão

Após `REMOVING` bem-sucedido:

```
annotate(novo_nó, STATE = 'managed')
  ↓
AuditLogger.log(status = 'passed')
  ↓
migrations.jsonl ← append
```

---

## Geração de Nomes de Nós

Nós criados pelo CANM seguem o padrão `gke-canm-<pool>-<hash>`:

```typescript
// Tenta nome descritivo (máx 63 chars — limite GCP):
"gke-canm-" + nodePool + "-" + hash8chars
// Ex: "gke-canm-pool-beta-9f424f17"

// Fallback se exceder 63 chars:
"gke-canm-" + nodePool.slice(0, N) + "-" + hash4chars
```

O prefixo `gke-canm-` é obrigatório — o sistema identifica nós criados por ele por esse prefixo.

---

## Tabela de Transições de Estado

```
Source Node:
  (sem annotation) → addition → draining → removing → (nó deletado)

Destination Node:
  (sem annotation) → created → managed
```

---

## Diagrama Completo com Compensações

```
┌─────────────────────────────────────────────────────────┐
│  PIPELINE: high→low, source = "node-B"                  │
└─────────────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────┐
    │ ADDITION                          │
    │ - annotate source: stage=addition │
    │ - gcloud create-instance          │
    │ - kubectl wait Ready              │
    │ - annotate novo: state=created    │
    └────┬──────────────────────────────┘
         │ FALHA? → compensate: removeAnnotation(MIGRATION_STAGE) → TICK
         │ OK ↓
    ┌────▼──────────────────────────────┐
    │ DRAINING                          │
    │ - annotate source: stage=draining │
    │ - DRAIN_PACED=false: kubectl drain│
    │ - DRAIN_PACED=true:  cordon +     │
    │     evict por lotes + sleep       │
    └────┬──────────────────────────────┘
         │ FALHA? → uncordon source
         │          delete novo nó
         │          se delete falha → state=pending-removal → TICK
         │ OK ↓
    ┌────▼──────────────────────────────┐
    │ REMOVING                          │
    │ - annotate source: stage=removing │
    │ - gcloud delete-instances node-B  │
    └────┬──────────────────────────────┘
         │ FALHA? → stage=removing persiste → reconciliação retry → TICK
         │ OK ↓
    ┌────▼──────────────────────────────┐
    │ CONCLUSÃO                         │
    │ - annotate novo: state=managed    │
    │ - AuditLog: status=passed         │
    └───────────────────────────────────┘
```

---

## Relacionados

- [[05 - Reconciliation Loop]] — como estados de falha são retomados
- [[03 - Scoring and Decision]] — quando e por que uma migração é iniciada
- [[08 - Limitations]] — limitações sobre clusters zonais e concorrência
