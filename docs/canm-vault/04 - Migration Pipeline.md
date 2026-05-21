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

**Observação:** Nós criados pelo CANM sempre têm prefixo `gke-canm-` no nome.

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

```
annotate(source, MIGRATION_STAGE = 'draining')
  ↓
kubectl drain <source>
  --grace-period=60
  --force
  --ignore-daemonsets
  --delete-emptydir-data
  ↓
(pods movidos para gke-canm-* ou outros nós)
```

**Compensação em falha:**
```
1. kubectl uncordon <source>         ← drain pode cordonar mesmo em erro
2. gcloud ... delete-instances <novo_nó>
   ├── SUCESSO → cluster voltou ao estado inicial
   └── FALHA   → annotate(novo_nó, STATE = 'pending-removal')
                  reconciliação vai remover depois
```

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
    │ - kubectl drain node-B            │
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
