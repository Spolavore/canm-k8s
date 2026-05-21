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

| Forward action       | Compensating action                                                 |
|----------------------|---------------------------------------------------------------------|
| `addNode<Pool>`      | Remove a annotation `MIGRATION_STAGE` do source — cluster intacto, nenhum nó foi criado |
| `drain`              | `uncordon` do nó de origem + `removeNode<Pool>` do nó recém-criado  |
| `removeNode<Pool>`   | Marca o nó de origem com `STATE=pending-removal` (dead-letter)      |

**Nota sobre o `drain`**: o comando `kubectl drain` não é atômico. Ele é
client-side e faz duas operações server-side em sequência — `cordon` no nó
de origem e um *loop* de evictions sobre os pods. Em quase todo cenário
real de falha (PDB violado, timeout, webhook recusando eviction), o cordon
**já foi aplicado** quando o comando retorna erro. Portanto a compensação
precisa, além de remover o nó novo órfão, executar `uncordon` no nó de
origem para que ele volte a ser elegível no scheduler. As duas operações
são independentes — uma falhar não impede a outra.

Se ambas as operações da compensação tiverem sucesso, o cluster volta ao
estado pré-migração. Se a remoção do nó novo falhar, ele é marcado com
`STATE=pending-removal` + `TARGET_POOL=<pool de destino>` para ser
retomado pela reconciliação.

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

Annotations utilizadas (prefixo `canm.io/`):

| Annotation                       | Significado                                                                |
|----------------------------------|----------------------------------------------------------------------------|
| `canm.io/migration-state`        | `created` \| `draining` \| `managed` \| `pending-removal`                  |
| `canm.io/target-node-pool`       | Pool em que o nó vive (usado pela reconciliação para decidir qual `removeNode<Pool>` chamar) |

Cada annotation se refere ao **próprio nó que a carrega**, em vez de
descrever a saga inteira. Isso vale tanto para o nó novo (criado pelo CANM)
quanto para o nó antigo (alvo da migração) — cada um carrega o estado da
sua parte do ciclo.

**Ciclo do nó novo** (caminho feliz):

```
addNode passa     → STATE=created
                    TARGET_POOL=<pool em que nasceu>
drain passa       → STATE=draining
removeNode passa  → STATE=managed
```

`managed` sinaliza que o nó terminou a saga e está em estado estacionário,
pronto para receber workload. A reconciliação ignora nós nesse estado.

**Ciclo do nó antigo** (apenas em caso de falha):

```
removeNode falha  → STATE=pending-removal (no nó antigo)
```

Em caminho feliz, o nó antigo é deletado fisicamente quando `removeNode`
passa, levando junto todas as suas annotations — não há necessidade de
anotar nada nele durante a saga normal.

**Compensação de `drain` falhando** (segue o mesmo padrão):

```
draining falha → tenta uncordon(source) + remove(nó novo)
   se remove falhar → STATE=pending-removal + TARGET_POOL no nó novo
```

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

| Etapa que falha | Compensação imediata                                      | Estado pós-falha                                  |
|-----------------|-----------------------------------------------------------|---------------------------------------------------|
| `addNode`       | Nenhuma (primeira etapa)                                  | Cluster intacto                                   |
| `drain`         | `uncordon` no source + `remove` do nó recém-criado        | Cluster intacto (ou nó novo vira *dead-letter*)   |
| `removeNode`    | Marca source com `pending-removal` — vira *dead-letter*   | Nó drenado fica anotado; reconciliação retoma     |

Para o caso `drain`, as duas ações da compensação (`uncordon` no source e
`removeNode` no nó novo) são tentadas em try/catch separados — uma falhar
não impede a outra. Se o `removeNode` falhar dentro da compensação, o nó
novo recebe `STATE=pending-removal` + `TARGET_POOL=<pool>` para que a
reconciliação retome.

### 3.3. Lógica da reconciliação

A reconciliação varre nós cujo `canm.io/migration-state` indica saga em
aberto. O fluxo principal é:

1. Encontrar nós com `STATE=pending-removal`.
2. Para cada um, ler `TARGET_POOL` e chamar `removeNode<Pool>` novamente.
3. Em caso de sucesso, o nó é deletado fisicamente (annotations vão junto).
4. Em caso de falha persistente, manter a annotation e logar — esse nó
   continuará tentando ser removido a cada ciclo.

Casos secundários a tratar:

- Nó com `STATE=created` mas sem progresso há tempo suficiente
  (ex.: timeout configurável): representa um crash do CANM logo após o
  `addNode`. A reconciliação pode escolher retomar a saga ou abortar
  removendo o nó novo.
- Nó com `STATE=draining`: idem, mas após o início do drain. Como o drain
  pode ter deixado o source cordoned e parcialmente evictado, a
  reconciliação tipicamente termina o drain remanescente ou aborta com
  uncordon do source + remoção do nó novo.

Nós em `STATE=managed` são ignorados pela reconciliação — representam o
estado estacionário do caminho feliz.

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
