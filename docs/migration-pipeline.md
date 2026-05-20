# Fluxo do `executeMigrationPipeline`

Este documento descreve as etapas executadas por `executeMigrationPipeline` em
[src/components/MigratorOrchestrator.ts](../src/components/MigratorOrchestrator.ts)
e o uso correto das annotations `canm.io/migration-stage` e `canm.io/state`.

## Modelo conceitual

Existem **dois nós** envolvidos em cada migração:

- **Source** (`node.node`): o nó que está sendo migrado para outro pool. É um
  worker comum do cluster, sem prefixo `gke-canm-`. É ele que **passa pelas
  etapas** do pipeline (`addition → draining → removing`).
- **Novo nó** (`newNode`): o nó criado no pool de destino com prefixo
  `gke-canm-`. É ele que substitui o source ao final.

Daí a separação das annotations:

| Annotation                | Onde vive      | Valores possíveis                              |
| ------------------------- | -------------- | ---------------------------------------------- |
| `canm.io/migration-stage` | No **source**  | `addition`, `draining`, `removing`, `conclued` |
| `canm.io/state`           | No **novo nó** | `created`, `managed`, `pending-removal`        |
| `canm.io/source-node`     | No **novo nó** | Nome do source que originou esse destino       |

> O **novo nó nunca recebe** `canm.io/migration-stage` porque não é ele que está
> sendo migrado. O **source nunca recebe** `canm.io/state` porque o STATE é uma
> condição lógica dos nós que o CANM gerencia (os com prefixo `gke-canm-`).

> A annotation `canm.io/source-node` no novo nó funciona como ligação reversa:
> permite à reconciliação descobrir se o source correspondente ainda existe
> antes de decidir se deve deletar o destino ou promovê-lo.

## Etapas

### Etapa 1 — Addition

1. Marca o **source** com `MIGRATION_STAGE = addition`.
2. Cria o novo nó no node pool de destino.
3. Se a criação **dá certo**:
    - Marca o novo nó com `STATE = created`.
    - Marca o novo nó com `SOURCE_NODE = <nome do source>` para permitir que
      a reconciliação ligue destino ↔ source.
4. Se **dá errado**: nada precisa ser revertido. Mesmo que o nó tenha sido
   parcialmente criado, ele entra órfão sem nenhuma annotation CANM, e a
   reconciliação captura nós com prefixo `gke-canm-` que não têm nenhuma
   annotation do CANM (`isNotMappedNode`).

### Etapa 2 — Draining

1. Marca o **source** com `MIGRATION_STAGE = draining`.
2. Drena o source.
3. Se **dá certo**: segue adiante.
4. Se **dá errado**: dispara `compensate(direction, 'draining', source, newNode)`.
   Ver seção [Compensação](#compensação).

### Etapa 3 — Removing

1. Marca o **source** com `MIGRATION_STAGE = removing`.
2. Remove o source (delete na MIG).
3. Se **dá certo**: nenhuma annotation precisa ser atualizada — o nó deixou de
   existir e suas annotations vão com ele.
4. Se **dá errado**: dispara `compensate(direction, 'removing', source)`. O
   `STATE = pending-removal` **não é escrito aqui** — é responsabilidade da
   compensação. Ver seção [Compensação](#compensação).

### Etapa 4 — Conclusão

Se todas as etapas anteriores terminaram com sucesso, marca o novo nó com
`STATE = managed`. Retorna `{ status: 'passed', stage: 'conclued' }`.

## Resumo das transições

```
source (canm.io/migration-stage):
  ø → addition → draining → removing → (nó removido)

new node (canm.io/state):
  ø → created → managed
```

## Compensação

A compensação é acionada quando alguma etapa do pipeline falha e o cluster
precisa ser revertido a um estado seguro. A política geral é **conservadora**:
não tenta re-executar a etapa que falhou, e sim restaurar o cluster ao estado
anterior à migração. Eventuais ações pendentes ficam delegadas à reconciliação.

Casos:

### Caso `addition`

**Nenhuma ação.** Se a criação do novo nó falhou, ou ele não existe, ou existe
de forma órfã sem annotations CANM — nesse último caso, a reconciliação captura
o nó via `isNotMappedNode` (nó com prefixo `gke-canm-` sem nenhuma annotation
CANM) e remove.

Detalhe cosmético: o source pode ficar com `MIGRATION_STAGE = addition`
anotado. Não causa problema operacional; será sobrescrito numa próxima
migração ou pode ser ignorado.

### Caso `draining`

Pressuposto: a etapa anterior funcionou — existe um novo nó no destino, mas o
drain do source falhou.

Ações em ordem:

1. **Uncordon do source.** O drain costuma deixar o source cordoned antes de
   evictar pods; se o drain falhou no meio, o source pode ter ficado
   cordoned. O uncordon devolve o source à rotação normal.
    - Se o uncordon falhar: loga e segue em frente. A
      [reconciliação](#reconciliação) ainda enxerga o source enquanto a
      annotation `MIGRATION_STAGE = draining` estiver presente, e tenta o
      uncordon nos próximos ticks até resolver.
2. **Remove o novo nó.** Como a migração foi revertida, o novo nó (destino)
   deixa de fazer sentido e é deletado da MIG.
    - Se a remoção falhar: marca o novo nó com `STATE = pending-removal`, e a
      reconciliação tenta remover no próximo tick. Esse caminho funciona porque
      o novo nó tem prefixo `gke-canm-` e é descoberto por
      `getCanmCreatedNodes`.

Política: **não há retry do drain**. Drain costuma falhar por motivos
estruturais (PDB bloqueando, `terminationGracePeriod` longo, daemonset
travado) que retry imediato não resolve. Reverter é mais seguro do que
insistir.

### Caso `removing`

Pressuposto: as etapas anteriores funcionaram — o source foi drenado com
sucesso e o novo nó está pronto, mas a remoção do source na MIG falhou.

Ação: marca o source com `MIGRATION_STAGE = removing` (já feito pela etapa do
pipeline antes do erro) e delega à [reconciliação](#reconciliação), que faz
retry da remoção em ticks subsequentes. Se a remoção continuar falhando
indefinidamente, o cooldown segura o ritmo, mas é sinal de problema mais
profundo (kubectl/gcloud, IAM, MIG em estado ruim) que requer investigação.

## Reconciliação

A reconciliação roda a cada tick **antes** da avaliação de migração. Seu papel
é capturar nós em estados inconsistentes (deixados por falhas no pipeline ou
por compensações que não completaram) e levá-los a um estado limpo — ou
removê-los. Funciona como um "guarda-redes" do sistema.

### Descoberta dos nós a reconciliar (`getUnreconciledNodes`)

Combina duas categorias:

- **Nós criados pelo CANM** (prefixo `gke-canm-`) com `STATE != managed`.
- **Nós criados pelo provedor** que carregam **pelo menos uma annotation CANM
  diferente de `LAST_RECONCILIATION`**.

> Por que excluir `LAST_RECONCILIATION` do trigger: ela é metadado de
> diagnóstico (registra quando reconcile tocou o nó pela última vez), não um
> sinal de "precisa de ação". Se contasse, um source totalmente limpo após uma
> falha transitória ficaria na lista pra sempre, gerando ruído.

A lista resultante é ordenada com nós do **high pool primeiro** — alinhado com
a política de priorizar redução de custo.

### Política por tick: 1 ação destrutiva + N de metadata

Espelha a política da avaliação (uma migração por tick), com nuance:

- **Ações destrutivas** (delete de nó, retry de remoção): no máximo **1 por
  tick**. Impacto observável, não cascateia.
- **Ações de metadata** (uncordon, remover annotation): **N por tick**.
  Idempotentes, baratas, necessárias pra o cluster convergir rápido pra um
  estado limpo após falhas.

Uma flag interna `heavyActionExecuted` regula isso no loop: quando rola uma
destrutiva, ações destrutivas subsequentes do mesmo tick são puladas (próximo
tick pega).

### Cooldown por nó

A annotation `canm.io/last-reconciliation` armazena o timestamp da última
tentativa. Hoje o cooldown é fixo em 5 minutos.

A escrita dessa annotation (`markReconciled`) acontece **somente em falha** —
em sucesso de ação destrutiva o nó deixa de existir, e em sucesso de metadata
o source fica clean e sai naturalmente da próxima lista de unreconciled.

### Casos

#### Caso A — Órfão CANM

Nó com prefixo `gke-canm-` **sem nenhuma annotation CANM**. Resultado típico
de morte da aplicação entre `addNode(...)` e
`annotateNode(STATE, 'created')`.

Ação: **deletar** (HEAVY).

#### Caso B — CANM com `STATE` em `created` ou `pending-removal`

Causas típicas:

- Pipeline morreu mid-flow após `STATE = created`, antes de `STATE = managed`.
- Compensação de draining marcou o destino órfão como `pending-removal` por
  não ter conseguido removê-lo na hora.
- **Migração efetivamente concluída** mas a aplicação morreu entre o `remove`
  do source e a escrita de `STATE = managed`. Nesse caso o destino já está
  servindo o workload do source removido.

Para distinguir os casos, o reconcile usa a annotation `SOURCE_NODE` do
destino e faz uma **consulta direta ao K8s** (via `getNodeByName`, não pelo
snapshot do tick) pra ver se o source ainda existe:

| Condição                                            | Ação                                          |
| --------------------------------------------------- | --------------------------------------------- |
| `state = pending-removal`                           | **deletar** (HEAVY) — sinal explícito         |
| `state = created` e source **não existe** mais      | **promover a `managed`** (METADATA)           |
| `state = created` e source **ainda existe**         | **deletar** (HEAVY) — migração incompleta     |
| `state = created` mas destino sem `SOURCE_NODE`     | **deletar** (HEAVY) — default conservador     |

> **Por que consulta ao vivo e não pelo snapshot:** o source pode ter sido
> deletado **mais cedo neste mesmo tick** (e.g., quando o Case C `removing`
> roda antes do Case B). O snapshot do início do tick ainda mostra o source
> como existente, levando a uma decisão errada de deletar o destino
> (carregando workload). A consulta direta reflete o estado real no momento da
> decisão.

#### Caso C — Source preso em algum stage

Dispatch pelo valor de `MIGRATION_STAGE`.

##### `stage = 'addition'`

Source foi anotado mas o pipeline morreu antes da Etapa 2. Não há ação
operacional pendente — o source nunca foi tocado, está intacto. Basta limpar
a annotation residual.

Ação: **remover `MIGRATION_STAGE`** (METADATA). Em falha do remove,
`markReconciled` segura retry.

##### `stage = 'draining'`

Causa: pipeline travou na etapa de drain e a compensação não completou. O
source pode estar cordoned (residual do drain inicial).

Ações em ordem:

1. Se source está cordoned (`isNodeCordoned`), executa **uncordon**.
2. **Se uncordon sucedeu**: remove `MIGRATION_STAGE`. Source fica
   completamente limpo.
3. **Se uncordon falhou**: **mantém `MIGRATION_STAGE`** e marca
   `LAST_RECONCILIATION` pra cooldown. Próximo tick tenta de novo.

> **Princípio importante:** `MIGRATION_STAGE` é a **âncora de visibilidade**
> do source na lista de unreconciled. Removê-la antes do problema operacional
> (nó cordoned) estar resolvido faria o nó "sumir do radar" do reconcile e
> ficar permanentemente cordoned. A regra é: só remove a âncora quando o
> problema-raiz foi resolvido.

##### `stage = 'removing'`

Causa: source foi drenado com sucesso, mas a remoção da MIG falhou.

Ação: **retry da remoção** (HEAVY). É low-risk (nó já está vazio e
cordoned). Se sucede, o nó some com todas as annotations. Se falha,
`markReconciled` e cooldown.

### Retorno do `reconcilePendingMigrations`

Devolve `!heavyActionExecuted`:

- Sem ação destrutiva → `true` → `evaluateCluster` roda no mesmo tick.
- Com ação destrutiva → `false` → defere `evaluateCluster` pro próximo tick
  (dá tempo do cluster estabilizar).

Ações de metadata não bloqueiam evaluation — são rápidas e não disruptivas.

## Melhorias futuras

### Cordon-on-create + uncordon-before-drain no destino

Hoje, entre o momento em que o novo nó é criado (Etapa 1) e o momento em que o
source começa a drenar (Etapa 2), o novo nó está **livre** para receber pods
do scheduler — qualquer deployment, replicaset ou novo workload no cluster pode
pousar nele.

Isso tem duas consequências indesejáveis quando o pipeline falha:

1. Se a compensação remove o novo nó (caso `draining` falho), pods que pousaram
   ali durante a janela vão precisar ser re-evictados — aumenta o downtime e
   pressão no scheduler.
2. Workloads não-relacionados à migração acabam sendo realocados duas vezes
   (uma vez para cá, outra para fora) sem motivo.

Desenho proposto:

1. **Na criação** do novo nó (Etapa 1), aplicar `cordon` imediatamente após o
   `waitUntilNodeReady`. O nó fica registrado, com `STATE = created`, mas
   `unschedulable = true` — o scheduler não envia pods novos para ele.
2. **Logo antes** do drain do source (Etapa 2), executar `uncordon` no novo
   nó. Aí ele entra na rotação no momento certo — quando os pods evictados
   pelo drain precisam de algum lugar para pousar.

Trade-off importante: com o destino cordoned, pods evictados pelo drain **não
podem pousar nele** — eles vão para outros nós existentes do pool de destino.
Por isso a proposta é uncordoned-before-drain (não cordoned-durante-drain): no
momento do drain, o destino já está aberto e é candidato natural do scheduler.

Essa melhoria é independente do mecanismo de compensação atual e pode ser
adicionada sem refatorar o pipeline.

### Ordenação sources-antes-de-destinations no reconcile (race remanescente)

A consulta ao vivo via `getNodeByName` resolve o pior caso (Test 1.10 do
plano de testes: source já deletado, destino órfão com workload). Mas existe
uma janela onde a **ordem de iteração** dentro do tick ainda importa.

Cenário: migração de **`low->high`** (source em low pool, destino em high
pool) crash no Test 1.8 (após `MIGRATION_STAGE = removing` no source).
`getUnreconciledNodes` ordena nós do high pool primeiro → **destino é
processado antes do source**. Quando o Case B faz a consulta ao vivo, o
source ainda existe (ainda não foi para o Case C `removing` deste tick) →
destino vai pra branch de delete → workload perdido.

Para `high->low` o problema não aparece porque source vem primeiro na ordem
de cost, é deletado pelo Case C, e quando o destino é processado a consulta
retorna 404.

Fix sugerido: alterar `getUnreconciledNodes` para devolver **providers
(sources) sempre antes de canm-created (destinations)**, mantendo o sort por
custo dentro de cada grupo. Isso garante que toda decisão de Case B em
destinos veja o estado já reconciliado dos sources do mesmo tick.

Independente disso, a primeira versão aceita o blip nesse cenário específico
porque o sistema continua **recuperável** — o workload re-escalona em outros
nós, com latência adicional curta.
