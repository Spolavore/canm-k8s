# Cenários `econodata-dia-util.js` e `econodata-fim-semana.js` — Documentação

> Arquivos: `k6/src/scenarios/econodata-dia-util.js` e `k6/src/scenarios/econodata-fim-semana.js`
> **Fontes de dados:**
> - Volumetria: `k6/data/endpoits_mais_utilizados_mes*.csv` (2026-05-01 a 2026-05-24)
> - Padrão temporal dia útil: `pattern-dia-util-2026-05-25.csv` (CPU dos 6 nodos GKE em produção)
> - Padrão temporal fim de semana: `pattern-fim-semana-2026-05-23.csv`
> - Limiar de capacidade: `tests/descoberta-bottleneck/` (step-up tests)

---

## Objetivo

Simular o padrão diário real de tráfego da plataforma Econodata, separadamente para
**dia útil** e **fim de semana**. A análise dos CSVs mostrou que volume e distribuição
mudam significativamente entre os dois — justifica ter cenários separados em vez de
uma média ponderada.

Diferente dos cenários teóricos (B–E), estes replicam o ciclo diário com a curva real
de CPU observada nos pods de produção.

---

## Referência de volumetria (CSVs de endpoint)

| Métrica | Dia útil | Fim de semana |
|---------|---------:|--------------:|
| Dias no período medido | 16 | 8 |
| Req agregadas (sem `superlogica-data`) | 10.013.175 | 2.355.636 |
| Req/dia médias | **625.823** | **294.455** |
| Req/s médio 24h | **7,24 req/s** | **3,41 req/s** |
| Endpoint dominante | `obter-nota-qualificacao` (43,30%) | `obter-nota-qualificacao` (41,02%) |

**Diferenças notáveis entre os profiles:**
- `searchBairros`: 0,47% (dia útil) → 1,46% (fim de semana) — **3,1× mais relevante** no fim de semana
- `tarja-notificacao`: 7,25% → 8,02% (sobe levemente)
- `info-token`: 3,35% → 3,13% (cai levemente)
- `searchFiltroDecisores`: 2,64% → 2,14% (uso de filtros de decisores é menor no fim de semana)

---

## Escala temporal — 1:12

**24h reais comprimidas em 120 minutos de teste.**
**1 minuto de teste = 12 minutos reais.**

| Real | Teste |
|---|---|
| 5 min real | 25s teste |
| 10 min real | 50s teste |
| 12 min real | 1 min teste |
| 30 min real | 2m30s teste |
| 1h real | 5 min teste |
| 2h real | 10 min teste |
| 24h real | 120 min teste |

---

## Limiar de capacidade (300 VUs = 100%)

**Limiar de degradação operacional:** **300 VUs** (definido pelo step-up de 2026-05-27, 3 runs no cluster de 4 nodos).

| VUs | % limiar | Comportamento (step-up) |
|---|---|---|
| ≤150 | ≤50% | Sem erros |
| 300 | 100% | Erros começam (0,16%) |
| 750 | 250% | 0,85% erro, throughput colapsa |

> Ref anterior (step-up 2026-05-25, 5 pods/deploy, CANM off): Smax = 750 VUs / 0 erros.
> As condições de cluster para o step-up de 27/05 não foram confirmadas. Usar **300 VUs** como limiar operacional.

---

## Fator de correção VU↔CPU (não-linear)

Por que não-linear: na produção, há baseline de overhead (processos sistema, healthchecks, métricas)
que mantém CPU em ~18% mesmo sem usuários. Não faz sentido alocar 50+ VUs para reproduzir esse baseline.
Mapeamento empírico aplicado nos cenários:

| CPU max (produção) | VU alvo no teste | % limiar | Onde aplica |
|---|---|---|---|
| ~18% (idle/baseline) | 15 | 5% | Madrugada, noite, fim de semana plano |
| ~25-30% | 25–40 | 8–13% | Pós-expediente, vale almoço |
| ~32-38% | 50–70 | 17–23% | Batches agendados, oscilações |
| ~42-50% | 100–180 | 33–60% | Atividade moderada, transições |
| ~70-85% | 200–280 | 67–93% | Spikes intensos |
| ~95-100% | 300 | 100% | Picos sustentados (teto do limiar) |

---

## Padrão diário — DIA ÚTIL

Análise do `pattern-dia-util-2026-05-25.csv` (max-CPU por hora, dos 6 nodos):

| Hora | Avg max-CPU | Peak | Comentário |
|---|---|---|---|
| 00h–08h | ~19% | ~22% | Baseline noturno estável |
| 08h | 22% | 27% | Início do expediente |
| 09h | 37% | 72% | Ramp matinal — primeiros spikes |
| 10h | 28% | 44% | Dip pré-pico |
| 11h | 48% | 87% | Subida forte |
| **12h** | **32%** | **98%** | **1° teto** — múltiplos picos a 100% |
| **13h** | 38% | 96% | Vale do almoço (só 1h real) com 2 spikes |
| 14h | 41% | 93% | Atividade alta com oscilação |
| **15h** | **51%** | **97%** | **HORA MAIS INTENSA** — picos sustentados no teto |
| **16h** | **26%** | 37% | **Queda BRUSCA** — fim efetivo do expediente intenso |
| 17h–18h | 25% | 47% | Declínio gradual |
| 19h–20h | 20% | 35% | Queda noturna |
| 21h–23h | 19% | 22% | Baseline noite |

> 3 fatos críticos do padrão real:
> 1. **Vale do almoço é curto** (~1h real, apenas 12h–13h), e mesmo nele há spikes a 96%
> 2. **15h é o pico do dia**, não 12h
> 3. **A queda às 16h é brusca**, não gradual — CPU cai de 90%+ para ~26% em minutos

---

## Padrão diário — FIM DE SEMANA

Análise do `pattern-fim-semana-2026-05-23.csv` (max-CPU por hora):

- **Baseline mediano max-CPU:** **18,4%** durante 48,5% do dia
- **Variação temporal:** essencialmente **zero** — pattern genuinamente plano
- **Apenas 2 eventos** quebram o baseline (e ambos são tarefas agendadas, não tráfego de usuário):

| # | Horário | Duração | Peak | Detalhe |
|---|---|---|---|---|
| 1 | **05h18–05h50** | 32 min | 37,7% | Multi-nodo (805i + 3lcg + bujx + c00b sobem juntos) |
| 2 | **17h50–17h54** | 4 min | 42,5% | Isolado no nodo 805i — só 1 nodo afetado |

> Importante: o fim de semana **não tem ramp-up matinal**, **não tem pico de tarde**, **não tem
> declínio noturno**. É tráfego constante o dia inteiro, com 2 interrupções breves de batch.

---

## Mapeamento → stages (cenário F: dia útil)

**24h em 120 min, escala 1:12.** Estrutura em 7 blocos (22 stages).

| Bloco | Horário real | Duração teste | VU alvo | CPU real | Notas |
|---|---|---|---|---|---|
| **Baseline noturno** | 00h–08h | 40m | 15 | ~19% | Vale longo |
| **Ramp-up matinal** | 08h–10h | 10m | 15→150 | 22→37% | Início expediente |
| **Pico matinal** | 10h–12h | 10m (5 stages) | osc. 200→300 | 28→98% | 1° teto |
| **Vale almoço** | 12h–13h | 5m (2 stages) | 20 | 32% | Curto (1h real) |
| **TARDE 1** | 13h–14h40 | 8m20s (10 stages) | osc. 40→300 | 38→93% | 2 spikes 13h + 2 spikes 14h |
| **PICO TARDE** | 14h40–16h | 6m40s (9 stages) | 100→300 sustentado | 51% avg / 97% peak | Hora mais intensa (15h) |
| **Declínio** | 16h–18h | 10m (3 stages) | 60→35 | queda brusca 90%→26% | |
| **Queda noturna** | 18h–22h | 20m (2 stages) | 25→20 | 20% | |
| **Retorno baseline** | 22h–24h | 10m | 15 | 19% | |

**Duração total:** 120 minutos. **Stages totais:** 22.

**Características do design:**
- **Múltiplos picos a 300 VUs** (teto do limiar) durante 12h, 13h, 14h, e 15h — captura o comportamento de "múltiplos nodos a 100% CPU" do real
- **Oscilação intra-pico** com dips para 150–200 VUs entre os picos — replica os vales curtos entre os spikes do real
- **Vale do almoço enxuto** (5 min teste = 1h real) — não 2h como em versões anteriores
- **Queda brusca em 16h** (transição 100→60 VUs em 1min de teste) — fim efetivo do expediente

---

## Mapeamento → stages (cenário G: fim de semana)

**24h em 120 min, escala 1:12.** Estrutura em 5 blocos (7 stages).

| Bloco | Horário real | Duração teste | VU alvo | CPU real | Notas |
|---|---|---|---|---|---|
| **Madrugada plana** | 00h–05h18 | 26m30s | 15 | ~18% | Constante |
| **Batch matinal** | 05h18–05h50 | 2m40s (3 stages) | 15→70→15 | peak 37,7% | Multi-nodo, 32min real |
| **Dia plano** | 05h50–17h50 | 60m | 15 | ~18% | **12h constante sem variação** |
| **Batch vespertino** | 17h50–17h54 | 20s (3 stages) | 15→60→15 | peak 42,5% | 1 nodo só, brevíssimo |
| **Fim do dia plano** | 17h54–24h | 30m30s | 15 | ~18% | Constante |

**Duração total:** 120 minutos. **Stages totais:** 7.

**Características do design:**
- **Zero ramp-up/down macroscópico** — não há padrão temporal a replicar fora dos 2 batches
- **15 VUs sustentados ~117 min de 120** — replica o platô plano de produção
- **2 spikes brevíssimos**: o matinal (multi-nodo, 32min) é maior que o vespertino (1 nodo, 4min) tanto em duração quanto em ratio de impacto no cluster
- **Sinal ao CANM:** carga constante → não escalar. Os 2 batches são curtos demais para acionar reação significativa (intencional — assim era no real).

---

## Como executar

```bash
cd testes-plat

# Dia útil
k6 run k6/src/scenarios/econodata-dia-util.js \
  -e K6_TRAFFIC_PROFILE=dia-util \
  -e K6_CNPJ_CRIPTO=<valor> \
  --out json=k6/results/$(date +%Y%m%d-%H%M)-F-dia-util.json

# Fim de semana
k6 run k6/src/scenarios/econodata-fim-semana.js \
  -e K6_TRAFFIC_PROFILE=fim-semana \
  -e K6_CNPJ_CRIPTO=<valor> \
  --out json=k6/results/$(date +%Y%m%d-%H%M)-G-fim-semana.json
```

---

## Observação sobre "usuários únicos"

Em k6 com `ramping-vus`, os VUs são **reutilizados** entre iterações — não existem
1.000 instâncias distintas de VU. Os ~1.000 usuários/dia da plataforma representam a base
real; o cenário replica o **comportamento de CPU no servidor** (via VU↔CPU não-linear)
em vez de instanciar um VU por usuário real, o que seria impraticável e geraria mais distorção.
