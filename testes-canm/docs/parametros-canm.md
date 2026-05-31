# Justificativa dos parâmetros do CANM (variáveis de ambiente)

Este documento fundamenta a escolha das variáveis de ambiente usadas na bateria
de testes com o CANM ativo (Grupos 2 e 4 do [design-experimental.md](design-experimental.md)).
Cada valor é justificado por evidência: a [comparação high × low](../comparacao-high-vs-low.md),
a curva CPU × SLO (`scripts/curva_cpu_slo.py`) e os testes de estabilização de nó
(`workload/cpu-no-provisionado.csv`, `workload/cpu-no-drain.csv`).

> **Linguagem:** o CANM é **reativo a métricas de utilização** e **orientado a custo** —
> nunca "proativo".

---

## 0. Como o score funciona (necessário para ler os thresholds)

O CANM calcula, por nó ([`MetricsAdapter.ts`](../../src/components/MetricsAdapter.ts)):

```
score(nó) = (CPU% · CPU_WEIGHT + MEM% · MEMORY_WEIGHT) / 100
```

Com `CPU_WEIGHT=1` e `MEMORY_WEIGHT=0`, o score é **simplesmente a utilização de
CPU do nó como fração 0–1**, medida como `rate(...)` **médio sobre uma janela**
(`*_POOL_TIME_WINDOW_EVAL`). Consequências que valem para todo o resto:

- A decisão é **por nó** (não pela média do cluster): um único nó que cruze o
  threshold dispara **uma** migração por ciclo.
- `prioritizeCost` avalia **primeiro o scale-down** (nós do pool forte com score ≤
  `LOW_SCORE_THRESHOLD`) e, se nada agiu, o **scale-up** (nós do pool barato com
  score ≥ `HIGH_SCORE_THRESHOLD`).
- O score é uma **média em janela**, não o pico instantâneo — por isso os
  thresholds foram calibrados contra a CPU em janela, não contra os picos.
- `*_NODE_COOL_DOWN` é a **idade mínima do nó** antes que o CANM possa agir sobre
  ele (anti-flapping), e não "esperar X após uma decisão"
  ([`isNodeInCooldown`](../../src/components/MigratorOrchestrator.ts)).

---

## 1. Tabela-resumo

| Variável | Valor | Base da decisão |
|---|---|---|
| `CPU_WEIGHT` | `1` | App é CPU-bound (comparação high×low) |
| `MEMORY_WEIGHT` | `0` | Memória nunca foi limitante; premissa escopada |
| `HIGH_SCORE_THRESHOLD` | `0.5` | Joelho de latência do pool baixo ≈ 50% CPU (curva CPU×SLO) |
| `LOW_SCORE_THRESHOLD` | `0.25` | Margem anti-flapping: `LOW × 1,5 < HIGH` |
| `LOW_POOL_TIME_WINDOW_EVAL` | `3m` | Scale-up responsivo (reage à carga subindo) |
| `HIGH_POOL_TIME_WINDOW_EVAL` | `10m` | Scale-down conservador (não larga em vale curto) |
| `LOW_NODE_COOL_DOWN` | `8m` | = janela low (3m) + estabilização (~4m) + margem |
| `HIGH_NODE_COOL_DOWN` | `14m` | = janela high (10m) + estabilização (~4m) |
| `CHECK_INTERVAL` | `15s` | Casa com a granularidade do scrape de métricas |
| `POLICY` | `prioritizeCost` | Objetivo do experimento: economia em baixa carga |
| `SHOW_DECISIONS_LOGS` | `TRUE` | Rastro de decisão para reconstruir a linha do tempo |
| `LOW_NODE_POOL` | `pool-beta` | Pool barato (série E2) — alvo do scale-down |

---

## 2. Pesos: `CPU_WEIGHT=1`, `MEMORY_WEIGHT=0`

A [comparação high × low](../comparacao-high-vs-low.md) mostrou que **a CPU é o
diferenciador, não a memória**: para a mesma carga o pool baixo consome ~1,5× a
CPU do pool forte, enquanto a RAM sobrou folga nos dois (memória avg ~52–65%, sem
saturar em nenhum cenário). Logo, o sinal que prediz degradação é a CPU.

**Ressalva (premissa escopada):** com peso 0 em memória, um cenário de pressão de
RAM fica invisível ao CANM. É aceitável **porque** o baseline comprovou folga de
memória para esta aplicação e carga — não é uma verdade universal e deve ser
declarado como limite do estudo.

---

## 3. Thresholds: `HIGH=0.5`, `LOW=0.25`

### 3.1 Evidência — curva CPU × SLO do pool baixo (E2), por nó

Cruzando a CPU em janela de 5 min (nó mais quente) com a latência p95 e o erro do
k6 no cenário dia-útil (`scripts/curva_cpu_slo.py low-node/econodata-dia-util --agg max`):

| CPU (janela) | p95 latência | erro % | estado |
|---|--:|--:|---|
| 20–50% | ~390–500 ms | 0% | confortável |
| **50–60%** | **835 ms** | 0,05% | **joelho — latência começa a dobrar** |
| 60–70% | 1626 ms | 0,11% | degradando |
| 70–90% | 2000–2356 ms | ~0,08% | ruim |

O **joelho está em ~50% de CPU em janela**: abaixo disso a latência é plana
(~400 ms); acima, dispara (835 → 1626 → 2300 ms). No mesmo cenário, o pool forte
(N2) com a mesma carga nunca passou de ~60% de CPU e ficou na zona boa — é a tese
que o CANM explora.

### 3.2 `HIGH_SCORE_THRESHOLD = 0.5`

Fixado **logo abaixo do joelho** (~50%), para o CANM começar a subir antes de a
latência degradar — descontando o tempo de migração (a janela + ~4–5 min de
transição). É **bem mais baixo que 0,6**: com 0,6 o CANM só subiria *depois* de a
latência já ter triplicado.

### 3.3 `LOW_SCORE_THRESHOLD = 0.25`

Abaixo de 25% de CPU em janela num nó forte, a carga é leve o bastante para descer
ao pool barato sem reentrar na zona ruim. O valor respeita a **restrição
anti-flapping** (o pool baixo gasta ~1,5× a CPU para o mesmo trabalho):

```
LOW × (razão CPU low/high ≈ 1,5) < HIGH
0,25 × 1,5 = 0,375  <  0,5          ✅ com folga
```

Ou seja: um nó forte a 25% que desça ao pool barato vira ~37,5% — abaixo do joelho
(~50%) e do `HIGH` (0,5), então não volta a subir no ciclo seguinte. A razão 1,5 é
de primeira ordem (os pods drenados são redistribuídos pelo scheduler, não 1:1).

> **Divisão de trabalho anti-flapping:** o **cooldown** evita oscilação *durante a
> transição* (nó recém-criado); o **gap entre thresholds** evita oscilação *em
> regime permanente*, depois que o cooldown expira. Os dois são necessários.

---

## 4. Janelas de avaliação: `LOW=3m`, `HIGH=10m`

A janela é um trade-off **rejeição de ruído × latência de reação**. Adotou-se a
assimetria clássica de autoscaling **"scale-out rápido, scale-in lento"**:

- **`LOW_POOL_TIME_WINDOW_EVAL=3m`** decide o **scale-up**. Janela curta = reação
  rápida à carga subindo, deixando margem para a migração (~4–5 min) completar
  antes de cruzar o joelho. O padrão real de produção sobe devagar, então 3 min já
  rejeitam ruído transitório (ex: os picos espúrios "111%" vistos em
  `workload/cpu-no-provisionado.csv`).
- **`HIGH_POOL_TIME_WINDOW_EVAL=10m`** decide o **scale-down**. Janela longa =
  conservadora, não devolve capacidade num vale curto (ex: vale do almoço) que
  logo exigiria voltar a subir.

Janela/cooldown high longos **não** atrasam o scale-up múltiplo numa surge: o
cooldown só protege nós recém-criados de reversão; adicionar mais nós ao pool forte
é paginado pelo `CHECK_INTERVAL` (15s) e os nós de origem são antigos.

---

## 5. Cooldowns: `LOW=8m`, `HIGH=14m`

Fórmula: **`cooldown ≥ janela_do_pool + tempo_de_estabilização`**. Um nó recém-criado
é reavaliado pela decisão oposta usando a janela daquele pool; o score dele só fica
representativo depois que o nó fica Ready, recebe tráfego **e** a janela enche de
dados pós-tráfego.

O **tempo de estabilização (~4 min)** vem de `workload/cpu-no-drain.csv`: ao drenar
um nó, o novo nó levou ~4 min do drain até servir tráfego de forma estável.

| Variável | Cálculo | Valor |
|---|---|---|
| `LOW_NODE_COOL_DOWN` | janela low (3m) + estabilização (~4m) + margem | **8m** |
| `HIGH_NODE_COOL_DOWN` | janela high (10m) + estabilização (~4m) | **14m** |

A assimetria das janelas propaga-se coerentemente para os cooldowns: janela high
longa → cooldown high longo (lento para devolver capacidade); janela low curta →
cooldown low curto (responsivo).

---

## 6. Cadência e política

### `CHECK_INTERVAL='15s'`
Cadência da avaliação. Casa com a **granularidade do scrape de métricas** (os CSVs
do Grafana são amostrados a 15 s) — não há ganho em avaliar mais rápido que a
atualização dos dados. É barato (só uma query ao Prometheus) e, como cada ciclo faz
no máximo uma migração, garante reação pronta sem rajada de ações.

### `POLICY='prioritizeCost'`
O objetivo do experimento é **economia em janelas de baixo tráfego**. Esta política
avalia o scale-down primeiro, alinhada à motivação do CANM (orientado a custo,
reativo a métricas de utilização). A alternativa `prioritizePerformance` inverteria
a ordem (prioriza subir).

---

## 7. Observabilidade e identidade de pools

### `SHOW_DECISIONS_LOGS="TRUE"`
Liga o log de **cada decisão** (candidato, descartado por score, descartado por
cooldown). É essencial para o experimento: permite reconstruir a **linha do tempo
de migração** e verificar a **reprodutibilidade entre os 2 runs** (se as decisões
batem, o determinismo fica comprovado; se divergem, é um achado).

### `LOW_NODE_POOL='pool-beta'`
Mapeia o pool barato (série **E2**, custo-otimizada) — o alvo do scale-down. O pool
forte é `HIGH_NODE_POOL='pool-beta-high'` (série **N2**). Identidade de
infraestrutura, sem valor a calibrar.

---

## 8. Ressalvas

1. **Thresholds são provisórios.** O joelho de ~50% foi derivado de **1 execução**
   por cenário. Os valores `0.5 / 0.25` devem ser confirmados após as re-execuções
   com réplicas casadas e o build novo do gateway (ver ressalvas da
   [comparação](../comparacao-high-vs-low.md)).

2. **SLO formal × joelho de latência.** O SLO formal (dia-útil p95 < 8 s) **nunca
   foi violado** pelo pool baixo (máx. ~2,3 s). A linha que de fato importa é o
   **joelho de latência** (~50% CPU), onde a experiência piora ~3×. O CANM aqui
   protege **qualidade de latência**, não o SLO de 8 s — uma escolha de objetivo que
   deve ser declarada. Convém fixar um **alvo interno** (ex: p95 < 1 s) e ancorar o
   `HIGH` no nível de CPU que o cruza.

3. **Razão 1,5× é de primeira ordem.** A relação de CPU low/high vem da média dos
   cenários; a redistribuição de pods pelo scheduler não é 1:1.
