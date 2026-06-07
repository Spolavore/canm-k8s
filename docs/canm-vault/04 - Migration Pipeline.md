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

Existem **três modos** de drenar (ver [[06 - Configuration]]). A compensação e a reconciliação
são **idênticas nos três** — o estágio continua sendo `draining`, só muda o *mecanismo* de evacuação.

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

### Modo surge — evacuação sem downtime (recomendado; em implementação)

> Status: é o mecanismo-alvo, definido após os testes de carga mostrarem que o erro residual de
> toda migração é o gap de capacidade da evicção. Os modos one-shot e pausado já existem.

**Motivação:** tanto o one-shot quanto o pausado drenam por **evicção** — "mata o pod da origem,
depois recria". Isso sempre abre uma **janela de capacidade reduzida**: enquanto o substituto não
está `Ready` no destino, o serviço tem menos réplicas. Sob carga (especialmente nas migrações
`low→high`, que ocorrem justamente quando o nó está sobrecarregado), perder 1 réplica satura as
demais → **timeouts/502 durante a migração**. O `preStop` (handover gracioso, ver
[[06 - Configuration]]) resolveu o *roteamento para pod morto*, mas **não devolve a capacidade
perdida** — esse é o erro residual de toda migração.

O modo surge inverte a ordem: o pod novo fica **`Ready` ANTES** de o antigo sair, então a
capacidade **nunca cai** abaixo do desejado.

```
annotate(source, MIGRATION_STAGE = 'draining')
  ↓
cordon(source)                          ← impede novos pods na origem
  ↓
para cada Deployment com pod na origem:
    rolling replacement com maxUnavailable=0, maxSurge≥1
    (cria pod novo em outro nó → espera Ready → SÓ ENTÃO remove o antigo)
  ↓
(nó origem fica sem pods de app → segue para REMOVING)
```

Detalhes:
- **Zero gap de capacidade:** durante a troca há N+1 réplicas (surge), nunca N−1. Elimina o
  timeout/502 estrutural da migração, em **qualquer direção** (inclusive `low→high` sob pico).
- **Estágio inalterado:** continua `draining`. Falha no meio do surge → mesma
  `compensate('draining')` (uncordon origem + remove destino) e mesma reconciliação. **Não há
  estágio, compensação nem reconciliação novos.**
- Custo: a migração recria todas as réplicas dos serviços afetados (rollout), portanto mais
  churn de pods do que evictar só os da origem — em troca de ~0 erro. `preStop` segue valendo
  (drena conexões em voo na troca).

### Compensação em falha (idêntica nos três modos)
```
1. kubectl uncordon <source>         ← drain pode cordonar mesmo em erro
2. gcloud ... delete-instances <novo_nó>
   ├── SUCESSO → cluster voltou ao estado inicial
   └── FALHA   → annotate(novo_nó, STATE = 'pending-removal')
                  reconciliação vai remover depois
```

> **Falha parcial (pausado ou surge):** se a drenagem falhar **no meio** (alguns lotes/Deployments já evacuados), alguns pods já podem ter sido movidos para o destino. A compensação atual (tudo-ou-nada) remove esse destino → os pods movidos são reescalonados (churn, mas sobrevivível, sem perda de dado). Compensação fina é [[10 - Roadmap|trabalho futuro]].

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
    │ DRAINING (mecanismo configurável) │
    │ - annotate source: stage=draining │
    │ - one-shot: kubectl drain         │
    │ - pausado:  cordon + evict/lotes  │
    │ - surge:    cordon + rollout       │
    │     maxUnavailable=0 (sem downtime)│
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
