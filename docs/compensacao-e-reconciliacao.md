# Compensação e Reconciliação no Processo de Migração

Este documento descreve o modelo de tratamento de falhas adotado pelo CANM para
o processo de migração de nós entre node pools. O objetivo é garantir que,
diante de falhas em qualquer etapa de uma migração, o cluster nunca permaneça
em estado inconsistente (ex.: nó adicionado mas não drenado, nó drenado mas não
removido).

## 1. O problema

A migração de um nó é uma operação composta por três etapas sequenciais:

1. `addNode<Pool>` — adiciona um nó no pool de destino.
2. `drain` — drena o nó de origem (move pods para fora dele).
3. `removeNode<Pool>` — remove o nó de origem do pool atual.

Trata-se de uma **transação distribuída**: a operação como um todo só é
consistente se todas as etapas tiverem sucesso.

Exemplos de estados inconsistentes possíveis:

- `addNode` passa, `drain` falha → existe um nó novo no pool de destino sem
  finalidade, consumindo custo.
- `addNode` passa, `drain` passa, `removeNode` falha → existe um nó drenado
  (sem pods úteis) ainda presente no pool de origem, também consumindo custo.


## 2. Modelo adotado

O CANM combina três padrões bem estabelecidos de sistemas distribuídos:

- **Saga pattern com compensating transactions** — para falhas detectadas
  *dentro* do ciclo em que a migração foi iniciada.
- **Dead-letter / pending state persistente** — para falhas que não puderam
  ser resolvidas no ciclo atual e precisam ser retomadas em ciclos futuros.
- **Reconciliation loop** — para converger o estado real do cluster ao estado
  desejado no início de cada ciclo, antes de qualquer nova decisão.

### 2.1. Saga pattern com compensating transactions

Uma **saga** é uma sequência de transações locais onde cada etapa de avanço
(*forward action*) possui uma operação inversa (*compensating action*) capaz
de desfazer seus efeitos. Se a etapa N falha, as etapas 1..N-1 são compensadas
em ordem inversa.

Aplicado ao CANM, o mapeamento é:

| Forward action       | Compensating action                          |
|----------------------|----------------------------------------------|
| `addNode<Pool>`      | `removeNode<Pool>` do nó recém-criado        |
| `drain`              | (sem compensação direta — ver nota abaixo)   |
| `removeNode<Pool>`   | (etapa final — nada a compensar)             |

**Nota sobre o `drain`**: a operação de drain em si não tem uma "operação
inversa" trivial (não é possível "des-drenar" o nó devolvendo pods movidos).
Felizmente, ela também não precisa: se `drain` falha, o nó de origem
permanece em uso normal e o cleanup necessário é apenas remover o nó *novo*
que foi adicionado pelo `addNode`. Se `drain` passa mas `removeNode` falha, o
nó de origem fica vazio (cordoned) — esse é o caso tratado pela
reconciliação, não pela compensação.

### 2.2. Estado persistente via annotations

Para que a compensação e a reconciliação funcionem, o CANM precisa saber, a
qualquer momento, **quais nós estão em qual estado de migração**. Em vez de
manter esse estado apenas em memória (perdido em qualquer crash/restart) ou
em arquivos locais (acoplados à máquina onde o processo roda), o CANM utiliza
**annotations no próprio recurso `Node` do Kubernetes**.

Vantagens dessa abordagem:

- O estado vive junto do recurso ao qual se refere.
- É persistido pelo etcd do cluster — sobrevive a reinícios do CANM.
- É inspecionável manualmente via `kubectl describe node <nó>`.
- Elimina a necessidade de volume mounts, locks de arquivo ou armazenamento
  externo.

Annotations propostas (prefixo `canm.io/`):

| Annotation                       | Significado                                                |
|----------------------------------|------------------------------------------------------------|
| `canm.io/migration-state`        | `creating` \| `draining` \| `pending-removal`              |
| `canm.io/source-node`            | Nome do nó de origem (no nó recém-criado)                  |
| `canm.io/target-pool`            | Pool de destino                                            |
| `canm.io/migration-started-at`   | Timestamp ISO do início da migração                        |
| `canm.io/last-failure`           | Última mensagem de erro, se houver                         |

### 2.3. Reconciliation loop

Inspirado nos *controllers* nativos do Kubernetes, o ciclo do CANM passa a
ter duas fases:

1. **Fase de reconciliação** (nova): no início de cada tick, antes de avaliar
   métricas, o orquestrador varre os nós do cluster procurando por annotations
   de migração que indiquem estado inconsistente, e tenta convergir esses nós
   ao estado desejado.
2. **Fase de avaliação** (atual): só executa se a reconciliação não deixou
   pendências críticas. Calcula scores e decide se inicia uma nova migração.

Essa ordem é importante: nunca iniciar uma migração nova enquanto houver
pendências de uma migração anterior evita acúmulo de inconsistências e
disputas por recursos.

## 3. Fluxo completo de uma migração

```
┌──────────────────────────────────────────────────────────────────┐
│  Tick do orquestrador                                            │
│                                                                  │
│  1. Fase de reconciliação                                        │
│     - Lista nós com annotation `canm.io/migration-state`         │
│     - Para cada um, tenta concluir/reverter a etapa pendente     │
│                                                                  │
│  2. Fase de avaliação (só roda se 1. não bloqueou)               │
│     - Decide se inicia uma nova migração                         │
│     - Se sim, executa a saga abaixo                              │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1. O que acontece em cada cenário de falha

| Etapa que falha | Compensação imediata             | Estado pós-falha                                  |
|-----------------|----------------------------------|---------------------------------------------------|
| `addNode`       | Nenhuma (primeira etapa)         | Cluster intacto                                   |
| `drain`         | `remove` do nó recém-criado      | Cluster intacto                                   |
| `removeNode`    | Nenhuma — vira *dead-letter*     | Nó drenado fica anotado; reconciliação retoma     |

### 3.3. Lógica da reconciliação

A reconciliação trata principalmente o caso `pending-removal`. O fluxo é:

1. Encontrar nós com `canm.io/migration-state=pending-removal`.
2. Para cada um, tentar `removeNode<Pool>` novamente.
3. Em caso de sucesso, limpar as annotations.
4. Em caso de falha persistente, manter a annotation e logar — esse nó
   continuará tentando ser removido a cada ciclo.

Casos mais raros (ex.: nó com `state=creating` mas migração nunca concluída)
também são tratados aqui: representam um crash do CANM no meio de uma saga,
e a reconciliação deve removê-los com base na ausência do `sourceNode`
correspondente ou em um timeout configurável.

## 4. Decisões explícitas para esta primeira versão

- **Sem retries dentro do mesmo ciclo.** Se uma etapa falha, a saga aborta
  (compensa ou marca como pendente). Tentativas adicionais ocorrem apenas
  via reconciliação no próximo tick. Isso simplifica a implementação inicial;
  retries com backoff exponencial podem ser introduzidos depois sem mudar a
  arquitetura.
- **Sem persistência em arquivo.** Toda informação de estado vive em
  annotations no recurso `Node`. Não há dependência de volume mount,
  filesystem local ou lock files.
- **Operações continuam síncronas.** A migração permanece bloqueando o
  ciclo em que foi iniciada. Não há fila assíncrona nem worker dedicado para
  migrações — apenas a fase de reconciliação adicional no início de cada
  tick.

## 5. Glossário rápido

- **Saga**: sequência de transações locais com compensações; alternativa a
  transações distribuídas atômicas.
- **Compensating transaction**: operação inversa a uma forward action; usada
  para desfazer efeitos parciais quando uma saga aborta.
- **Dead-letter**: registro persistente de uma operação que não pôde ser
  concluída e precisa ser retomada/inspecionada depois.
- **Reconciliation loop**: laço que compara estado desejado vs. estado real
  e age para convergir o segundo ao primeiro; é o modelo de controle padrão
  do Kubernetes.
- **Annotation (K8s)**: par chave-valor anexado a um recurso, usado para
  guardar metadados arbitrários sem afetar a identidade ou seleção do
  recurso (diferente de labels).
