# Reconciliation Loop — Recuperação de Estados Inconsistentes

## Por que Existe

O [[04 - Migration Pipeline]] pode falhar em qualquer etapa. Quando isso acontece, o cluster fica em estado **parcialmente migrado**: um nó pode estar cordoned, ou um nó novo pode existir sem par source sendo removido. O Reconciliation Loop detecta e corrige esses estados a cada tick, **antes** de qualquer nova avaliação.

---

## Quando Roda

**Sempre que o loop de tick dispara**, independente de haver migrações em andamento. É a primeira coisa que acontece a cada `CHECK_INTERVAL`.

```
[tick] → reconcilePendingMigrations() → [se OK] evaluateCluster()
```

Se a reconciliação ainda tem trabalho a fazer ou alguma ação alterou o estado do cluster de forma crítica ( como deleção de um nó), a avaliação é **pulada** nesse tick.

---

## O que Procura

A reconciliação inspeciona **todos os nós do cluster** e filtra por:
1. Nós com prefixo `gke-canm-` (criados pelo CANM)
2. Nós com annotations `canm.io/migration-stage` ou `canm.io/state`

---

## Casos de Reconciliação

### CASE A — Nó CANM Órfão

**Condição:** Nó com prefixo `gke-canm-` mas **sem** a annotation `canm.io/state`.

**Causa provável:** Falha após criação da instância mas antes de anotar com `STATE=created`.

**Ação:** DELETE o nó via gcloud (1 nó por tick — operação pesada).

---

### CASE B — Nó CANM em Estado Não-Terminal

**Condição:** Nó com `canm.io/state` ≠ `managed` (i.e., `created` ou `pending-removal`).

**Causa provável:**
- `created`: CANM morreu após criar nó mas antes de concluir a migração
- `pending-removal`: Falha na remoção do nó novo durante compensação

**Ação (depende do estado do source):**

Para `state=created`, a reconciliação faz um live lookup do source referenciado em `canm.io/source-node`:

| Condição                                              | Ação                                           |
|-------------------------------------------------------|------------------------------------------------|
| Source **não existe** (404)                           | Promove destination para `managed` (METADATA)  |
| Source existe com `canm.io/migration-stage=removing`  | Promove destination para `managed` (METADATA)  |
| Source existe e **sem** stage `removing`              | DELETE o destination via gcloud (HEAVY)        |

A promoção para `managed` é segura nos dois primeiros casos porque o source já foi removido ou está na etapa final de remoção — o destination já recebeu o workload e é o nó legítimo do cluster.

Para `state=pending-removal`: DELETE o nó via gcloud (1 nó por tick, HEAVY).

> **Por que checar `removing` no source?** Sem esse check, se a reconciliação avalia o destination antes do source (o que ocorre em migrações `low->high`, onde o destination está no high pool e é priorizado pela ordenação de custo), ela deletaria o destination mesmo com o workload já migrado. O source seria então removido pelo Case C, deixando o cluster com um nó a menos.

---

### CASE C — Source Preso em Stage

**Condição:** Nó com annotation `canm.io/migration-stage` ativa.

#### Sub-caso: `stage = 'addition'`
**Causa:** Falha durante ADDITION, nó novo nunca foi criado.
**Ação:** Remove annotation `MIGRATION_STAGE` do source (operação leve — apenas metadados).

#### Sub-caso: `stage = 'draining'`
**Causa:** Falha durante DRAINING.
**Ação:**
1. Se source está cordoned: `kubectl uncordon <source>`
2. Remove annotation `MIGRATION_STAGE` do source

#### Sub-caso: `stage = 'removing'`
**Causa:** Falha no `gcloud delete-instances` — source drenado mas não removido.
**Ação:** Retry da remoção via `gcloud compute instance-groups managed delete-instances` (1 por tick).

---

## Cooldown de Reconciliação

Para evitar retry storms, cada nó tem um cooldown de **5 minutos** entre tentativas de reconciliação. O timestamp da última tentativa é salvo na annotation `canm.io/last-reconciliation`.

```typescript
const lastReconciliation = node.annotations['canm.io/last-reconciliation'];
if (lastReconciliation) {
  const elapsed = Date.now() - new Date(lastReconciliation).getTime();
  if (elapsed < convertToMs('5m')) return; // pula este tick
}
```

---

## Fluxo Completo

```
reconcilePendingMigrations()
│
├── listNodes() com annotations CANM
│
├── Para cada nó encontrado:
│   │
│   ├── CASE A: prefixo gke-canm- sem state annotation
│   │   └── gcloud delete-instances (1 por tick) → return false
│   │
│   ├── CASE B: state = 'created' ou 'pending-removal'
│   │   ├── state='created' → live lookup do source
│   │   │   ├── source 404 ou stage=removing → promove para managed (METADATA)
│   │   │   └── source existe e não removing → gcloud delete-instances (1 por tick) → return false
│   │   └── state='pending-removal' → gcloud delete-instances (1 por tick) → return false
│   │
│   └── CASE C: migration-stage presente no source
│       ├── stage = 'addition'  → remove annotation → return false
│       ├── stage = 'draining'  → uncordon + remove annotation → return false
│       └── stage = 'removing'  → retry gcloud delete → return false
│
└── Nenhum caso encontrado → return true (seguro para avaliar)
```

---

## Garantias e Limitações

**Garante:**
- Nenhuma nova migração começa enquanto há estados incompletos
- Nós órfãos são deletados (evita custos desnecessários)
- Sources drenados são eventualmente removidos (retry com cooldown)

**Não garante:**
- Idempotência perfeita se **múltiplas réplicas** do CANM rodarem (ver [[08 - Limitations]])
- Recuperação instantânea — pode levar vários ticks se cooldowns estiverem ativos
- Pods com PDB violação: se `kubectl drain` continuar falhando, o source nunca é removido

---

## Relacionados

- [[04 - Migration Pipeline]] — onde os estados inconsistentes são criados
- [[08 - Limitations]] — restrição de single-writer
- [[09 - Observability]] — como monitorar o que a reconciliação está fazendo
