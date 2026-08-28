# CANM — Cost Aware Node Migration

Operador autônomo que reduz o custo de clusters Kubernetes no GKE (até o presente momente) migrando nós
entre node pools de custos diferentes, de forma reativa às métricas de
utilização observadas no cluster.

O CANM observa continuamente CPU e memória de cada nó via Prometheus. Quando um
nó do pool caro está ocioso, ele é movido para o pool barato; quando um nó do
pool barato está sobrecarregado, é movido para o pool caro. A migração cria o
nó de destino, drena os pods do nó de origem (que o scheduler do Kubernetes
reagenda) e só então remove a origem.

```
Situação detectada                Ação tomada
────────────────────────────────────────────────────────────────
Nó no high pool com score baixo → migra para o low pool (economiza)
Nó no low pool com score alto   → migra para o high pool (performance)
```
---

## Como funciona

### 1. Score

Cada nó recebe um score entre `0.0` e `1.0`, composto por CPU e memória
ponderadas (os pesos são normalizados automaticamente para somar 1.0):

```
score = (cpuUsage% × pesoCpu + memUsage% × pesoMem) / 100
```

As métricas vêm de queries PromQL com janela de tempo configurável — e a janela
pode ser diferente por pool, para que o low pool reaja rápido à sobrecarga
enquanto o high pool exige evidência mais longa antes de ser desmontado.

### 2. Decisão

O score é comparado com dois thresholds. Entre eles existe uma **zona segura**
onde nada acontece:

```
0.0 ─────────── LOW_SCORE_THRESHOLD ───── zona segura ───── HIGH_SCORE_THRESHOLD ─────────── 1.0
      high pool ocioso → migra p/ low                          low pool sobrecarregado → migra p/ high
```

A política (`MIGRATION_POLICY`) define qual pool é avaliado primeiro:
`prioritizeCost` busca ociosidade no high pool antes de tudo;
`prioritizePerformance` busca sobrecarga no low pool primeiro. Nós recém-criados
ficam em cooldown e são ignorados, o que evita ping-pong entre pools.

### 3. Pipeline de migração (Saga)

Cada migração é uma saga de três etapas com transações compensatórias — se
qualquer etapa falha, o que já foi feito é desfeito:

```
[ADDITION] ──→ [DRAINING] ──→ [REMOVING] ──→ [MANAGED]
    │              │               │
    └── cria nó    └── evacua      └── remove o nó origem
        no pool        os pods         da MIG
        destino        da origem
```

O DRAINING tem dois modos. O padrão usa `kubectl drain` one-shot. Com
`DRAIN_PACED=TRUE`, os pods são evacuados em lotes pela Eviction API — que honra
PodDisruptionBudgets — com espera fixa entre lotes, distribuindo no tempo o
warmup dos pods frios no nó destino.

### 4. Reconciliação

O estado da migração é persistido em **annotations nos próprios nós**
(`canm.io/migration-stage`, `canm.io/state`, `canm.io/source-node`), então
sobrevive a reinícios do processo. A cada tick, antes de qualquer avaliação
nova, um loop de reconciliação varre o cluster e corrige estados
inconsistentes: nós órfãos criados pelo CANM, destinos presos em `created`,
origens travadas em `draining`. Se a reconciliação teve trabalho a fazer, a
avaliação daquele tick é pulada.

Nós criados pelo CANM sempre recebem o prefixo `gke-canm-` no nome.

---

## Pré-requisitos

| Requisito | Versão | Observação |
|-----------|--------|------------|
| Node.js | ≥ 18 | |
| `kubectl` | **≥ 1.31** | `kubectl wait --for=create` só existe a partir da 1.31 |
| `gcloud` | recente (≥ 400) | precisa de `instance-groups managed wait-until` |
| Prometheus | — | com métricas de nó (cAdvisor/kubelet) acessíveis por HTTP |

`kubectl` e `gcloud` precisam estar no `PATH` e autenticados — o CANM os invoca
via `execSync`.

Permissões GCP necessárias: `container.nodes.list`,
`compute.instanceGroups.get`, `compute.instanceGroups.update`,
`compute.instances.delete`.

---

## Instalação

```bash
git clone git@github.com:Spolavore/canm-k8s.git
cd canm
npm install

cp .env.example .env
# edite o .env com os valores do seu cluster
```

Autenticação:

```bash
gcloud auth login                     # ou: gcloud auth activate-service-account --key-file=...
gcloud config set project <GCP_PROJECT_ID>
```

O kubeconfig é gerado automaticamente a partir de `GKE_CLUSTER_NAME`,
`GKE_REGION` e `GKE_PROJECT`.

---

## Execução

```bash
npm run dev      # desenvolvimento (ts-node)
npm run build    # compila TypeScript → dist/
npm start        # produção (após o build)
npm run debug    # script isolado de debug
```

Um `Ctrl+C` encerra o processo. Se houver migração em andamento, o loop de
reconciliação limpa o estado incompleto na próxima inicialização.

---

## Configuração

Toda a configuração vem de variáveis de ambiente lidas de um `.env` na raiz.
O arquivo [.env.example](.env.example) documenta cada variável, seu default e
seu formato — use-o como referência primária.

Resumo dos grupos:

| Grupo | Variáveis |
|-------|-----------|
| Cluster GKE | `EXTERNAL_PROVIDER`, `GKE_CLUSTER_NAME`, `GKE_REGION`, `GKE_PROJECT`, `GKE_INTERNAL_IP` |
| Prometheus | `PROMETHEUS_API_URL`, `PROMETHEUS_JOB` |
| Node pools | `HIGH_NODE_POOL`, `LOW_NODE_POOL` |
| Thresholds | `LOW_SCORE_THRESHOLD`, `HIGH_SCORE_THRESHOLD` |
| Loop | `CHECK_INTERVAL`, `MIGRATION_POLICY` |
| Cooldowns | `HIGH_NODE_COOL_DOWN`, `LOW_NODE_COOL_DOWN` |
| Janelas de avaliação | `LOW_POOL_TIME_WINDOW_EVAL`, `HIGH_POOL_TIME_WINDOW_EVAL` |
| Pesos do score | `CPU_WEIGHT`, `MEMORY_WEIGHT` |
| Drain | `DRAIN_PACED`, `DRAIN_BATCH_SIZE`, `DRAIN_BATCH_INTERVAL` |
| Remoção | `REMOVE_SETTLE` |
| Debug | `SHOW_DECISIONS_LOGS` |

Durações usam string com **um** sufixo: `ms`, `s`, `m`, `h` (ex.: `30m`, `1h`,
`90s`). Duas flags são sensíveis ao formato: `DRAIN_PACED` só ativa com a string
maiúscula `TRUE`, e `GKE_INTERNAL_IP` só com a minúscula `true`.
`SHOW_DECISIONS_LOGS` é ativado por **qualquer** valor não-vazio.

Discussão de tuning (quando aumentar a janela do high pool, quando mexer nos
pesos etc.) está em `docs/canm-vault/06 - Configuration.md`.

---

## Observabilidade

O CANM escreve três arquivos JSONL append-only na raiz do projeto:

| Arquivo | Registra |
|---------|----------|
| `migrations.jsonl` | cada migração concluída, com direção, score, duração e status |
| `compensations.jsonl` | cada acionamento do mecanismo de compensação e seu resultado |
| `reconciliations.jsonl` | cada ação do loop de reconciliação, por nó e por tick |

```bash
tail -f migrations.jsonl | jq .
cat migrations.jsonl | jq 'select(.status == "failed")'
```

Para inspecionar migrações em andamento direto no cluster:

```bash
kubectl get nodes -o json | jq '.items[]
  | select(.metadata.annotations["canm.io/migration-stage"] != null)
  | {name: .metadata.name, stage: .metadata.annotations["canm.io/migration-stage"]}'
```

Nenhum dos arquivos tem rotação automática. Schemas completos e queries de
diagnóstico estão em `docs/canm-vault/09 - Observability.md`.

---

## Limitações conhecidas

- **Somente clusters zonais.** `GKE_REGION` precisa conter uma zona
  (`us-central1-a`), não uma região. Em clusters regionais cada node pool tem
  uma MIG por zona e o CANM ainda não escolhe em qual criar a instância — a
  etapa de ADDITION falha. Curiosamente a remoção funciona, porque a zona é
  extraída do nome da instância.
- **Single-writer.** Não há locks distribuídos, `Lease` nem compare-and-swap
  nas annotations. Duas réplicas podem decidir migrar o mesmo nó ao mesmo tempo
  e sobrescrever annotations. Rode **exatamente uma réplica por cluster**
  (`replicas: 1`, sem HPA).
- **`kubectl` < 1.31 falha silenciosamente** na etapa de ADDITION, por causa do
  `--for=create`.
- **PDB no drain.** No modo one-shot, um PodDisruptionBudget que bloqueie a
  evicção derruba o drain inteiro e a origem fica presa em `stage=draining`
  entre retentativas. No modo pausado, a Eviction API trata o `429` com backoff
  e pula o pod, mas um PDB permanentemente bloqueante deixa o pod para trás —
  ele sai à força no REMOVING.
- **Gap de capacidade durante a evicção.** O drain mata o pod antes de o
  substituto ficar `Ready`, o que abre uma janela de capacidade reduzida. Sob
  carga (pior nas migrações `low->high`) isso gera timeouts/502 durante a
  migração. Um `preStop` de handover corrige o roteamento para pod morto, mas
  não o gap de capacidade.
- **Janela de race na persistência de estado.** As annotations sobrevivem a
  reinícios, mas se o processo morre *entre* concluir uma etapa e escrever a
  annotation correspondente, a reconciliação pode remover o nó novo e causar um
  breve reagendamento de pods.
- **Score ignora rede e disco.** Workloads com alto I/O e baixo uso de
  CPU/memória podem ser classificados como ociosos.
- **Sem validação de configuração no startup.** Um typo em `HIGH_NODE_POOL` só
  aparece na primeira tentativa de migração, potencialmente horas depois.

Detalhamento e severidade de cada item em
`docs/canm-vault/08 - Limitations.md`.

---

## Trabalhos futuros

- **Drain por lotes gateado por CPU.** Substituir a espera fixa
  (`DRAIN_BATCH_INTERVAL`, hoje calibrada empiricamente) por um gate na CPU real
  do nó destino: só liberar o próximo lote quando a CPU cair abaixo de um
  limiar. Além de adaptativo, é auto-protetor — se a carga não couber no
  destino, o gate trava em vez de gerar storm. Itens correlatos: um teto de
  tempo `DRAIN_MAX_TOTAL` e compensação de falha parcial (marcar a migração como
  `partial` em vez do tudo-ou-nada atual).
- **Suporte a clusters regionais**, escolhendo a zona de destino pelo
  balanceamento entre MIGs ou reaproveitando a zona do nó removido.
- **Persistência de estado robusta (M3)** — tornar cada etapa idempotente e
  verificar o estado real no GCP antes de reconciliar.
- **`Lease` do Kubernetes** para garantir single-writer mesmo com restart
  automático ou múltiplos pods.
- **Métricas de rede no score composto**, com renormalização dos pesos.
- **Validação de configuração no startup**: existência dos pools,
  acessibilidade do Prometheus, versões de `kubectl`/`gcloud`, permissões IAM.
- **Métricas Prometheus do próprio CANM** (`canm_migrations_total`,
  `canm_migration_duration_seconds`, `canm_nodes_in_reconciliation`) e dashboard
  de custo economizado.
- **Distribuição**: Dockerfile oficial multi-stage e Helm chart.
- **Promoção segura `low->high`**: verificar capacidade disponível no cluster
  antes de drenar um nó já sobrecarregado.

---

## Documentação

### Monografia — documentação completa

**[`docs/canm-monografy.pdf`](docs/canm-monografy.pdf)** é a documentação
completa do projeto, em português: contexto, fundamentação, decisões de
arquitetura, metodologia de avaliação e resultados. É o material de referência
canônico — comece por ele para entender o *porquê* de cada decisão.

### Vault do Obsidian — referência técnica navegável

**[`docs/canm-vault/`](docs/canm-vault/)** é um vault do
[Obsidian](https://obsidian.md). Abra a **pasta** como vault (`Open folder as
vault`) para navegar pelos `[[wikilinks]]` e pelo grafo — no GitHub os links
internos aparecem como texto puro.

| Nota | Conteúdo |
|------|----------|
| `00 - Index` | ponto de entrada e visão rápida |
| `01 - Overview` | propósito, problema resolvido e cenário de uso |
| `02 - Architecture` | componentes, integrações e fluxo por tick |
| `03 - Scoring and Decision` | queries PromQL, fórmula do score e política |
| `04 - Migration Pipeline` | as três etapas da saga e suas compensações |
| `05 - Reconciliation Loop` | casos de estado inconsistente e como são resolvidos |
| `06 - Configuration` | hiperparâmetros, defaults e guia de tuning |
| `07 - How to Run` | instalação, autenticação e verificações |
| `08 - Limitations` | limitações conhecidas com severidade e workaround |
| `09 - Observability` | schemas dos JSONL e queries de diagnóstico |
| `10 - Roadmap` | milestones e melhorias planejadas |

### Notas avulsas

- [`docs/migration-pipeline.md`](docs/migration-pipeline.md) — semântica das
  annotations e do fluxo de `executeMigrationPipeline`
- [`docs/compensacao-e-reconciliacao.md`](docs/compensacao-e-reconciliacao.md) —
  mecanismo de compensação em detalhe
- [`docs/limitacoes-conhecidas.md`](docs/limitacoes-conhecidas.md) — dependências
  de ambiente não capturadas pelo `package.json`

---

## Estrutura do projeto

```
src/
├── components/
│   ├── MigratorOrchestrator.ts   loop de ticks, decisões, saga e reconciliação
│   ├── GkeNodeMigrator.ts        operações GKE (MIGs, criação/remoção, drain)
│   ├── MetricsAdapter.ts         queries Prometheus e cálculo do score
│   └── AuditLogger.ts            escrita dos JSONL de auditoria
├── lib/KubernetesClient.ts       wrapper do @kubernetes/client-node + kubectl
├── services/                     clientes HTTP (Prometheus, axios)
├── repositories/                 queries PromQL
├── config/                       geração de credenciais/kubeconfig do GKE
├── utils/                        annotations, math, durações, hash, logger
├── types.ts                      tipos globais
└── index.ts                      entry point (lê o .env e sobe o orquestrador)
```

---

## Licença

ISC.
