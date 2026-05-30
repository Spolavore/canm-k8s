# Cenários de Carga — Configuração k6

> Cenários calibrados conforme volumetria real (ver `01-endpoints-config.md` §Volumetria).
> Cada arquivo de cenário exporta `options` e a função `default`.
> O **profile de tráfego** é selecionado via `K6_TRAFFIC_PROFILE=dia-util|fim-semana` (default: `dia-util`)
> e determina qual sequência (e portanto distribuição de endpoints) será executada.

---

## Volumetria-alvo (referência para calibrar VUs)

| Profile | Req/s 24h | Req/s horário comercial (~80% em 12h) | Pico estimado (3× média HC) |
|---------|-----------|---------------------------------------|------------------------------|
| `dia-util` | 7,24 | ~11,6 | ~22 |
| `fim-semana` | 3,41 | ~5,5 | ~10 |

---

## Calibração de VUs → req/s

Latência média observada no teste-piloto: `~227ms`. Think time padrão: `1.0s`.

```
req/s por VU = 1 / (think_time + avg_latency) = 1 / (1.0 + 0.227) ≈ 0,815 req/s
```

| Alvo (req/s) | VUs necessários | Onde se aplica |
|--------------|-----------------|----------------|
| 3,41 | ~4 | Baseline fim de semana 24h |
| 5,5 | ~7 | Pico médio horário comercial fim de semana |
| 7,24 | ~9 | Baseline dia útil 24h |
| 11,6 | ~14 | Pico médio horário comercial dia útil |
| 22 | ~27 | Pico de 12h–14h dia útil |
| 30+ | 37+ | Stress test acima do real (forçar CANM) |

---

## Limites práticos por serviço

| Serviço | Gargalo conhecido | Nota |
|---------|-------------------|------|
| ecdt-admin-v2-back | Pool BD max:1 | `tarja-notificacao` representa 7–8% do mix → com 30 VUs gera ~2 req/s neste serviço, dentro do que `max:1` consegue serializar |
| ecdt-historico-v2 | Pool BD max:10 | `obter-nota-qualificacao` é 43% do mix → atenção a partir de ~30 VUs |
| ecdt-billing | Pool BD max:10 | OK até ~30 VUs |
| ecdt-busca | Rate-limit 500/min (token whitelisted — ignorar) | OK |

---

## Cenário A — Carga constante (baseline / smoke test)

> **Executar primeiro.** Valida setup end-to-end.
> Arquivo: `src/scenarios/constant.js`

```javascript
export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: __ENV.K6_VUS ? parseInt(__ENV.K6_VUS) : 9,  // 9 VUs ≈ 7 req/s (baseline dia útil)
      duration: __ENV.K6_DURATION || '5m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.05'],
  },
};
```

| Profile | VUs sugeridos | req/s alvo |
|---------|---------------|-----------|
| `dia-util` | 9 | ~7,24 |
| `fim-semana` | 4 | ~3,41 |

Smoke test inicial (pequeno):
```
K6_VUS=3 K6_DURATION=2m
```

---

## Cenário B — Degrau ascendente

> Força adição de nós no CANM. Aumenta VUs em degraus, sustenta, observa scale-out.
> Arquivo: `src/scenarios/step-up.js`

```javascript
// Progressão calibrada na volumetria real:
//   4 VUs (baseline FdS) → 9 (baseline dia útil) → 14 (HC dia útil) → 22 (pico 12h–14h) → 30 (stress)
export const options = {
  scenarios: {
    step_up: {
      executor: 'ramping-vus',
      startVUs: 4,
      stages: [
        { duration: '30s', target: 4  },  // aquecimento — nível fim de semana
        { duration: '3m',  target: 9  },  // baseline dia útil
        { duration: '30s', target: 9  },
        { duration: '3m',  target: 14 },  // horário comercial dia útil
        { duration: '30s', target: 14 },
        { duration: '3m',  target: 22 },  // pico real 12h–14h
        { duration: '30s', target: 22 },
        { duration: '3m',  target: 30 },  // stress — força scale-out
        { duration: '2m',  target: 30 },
        { duration: '1m',  target: 0  },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.10'],
  },
};
```

Duração total: ~17 minutos.

---

## Cenário C — Degrau descendente

> Força remoção de nós (scale-in) pelo CANM.
> Rodar imediatamente após `step-up.js` enquanto o cluster ainda tem nós extras.
> Arquivo: `src/scenarios/step-down.js`

```javascript
export const options = {
  scenarios: {
    step_down: {
      executor: 'ramping-vus',
      startVUs: 30,
      stages: [
        { duration: '2m',  target: 30 },  // mantém stress inicial
        { duration: '30s', target: 22 },  // volta a pico real
        { duration: '3m',  target: 22 },
        { duration: '30s', target: 14 },  // horário comercial dia útil
        { duration: '3m',  target: 14 },
        { duration: '30s', target: 9  },  // baseline dia útil
        { duration: '3m',  target: 9  },
        { duration: '30s', target: 4  },  // baseline fim de semana
        { duration: '3m',  target: 4  },  // observar scale-in
        { duration: '1m',  target: 0  },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.10'],
  },
};
```

Duração total: ~17 minutos.

---

## Cenário D — Pico isolado (spike)

> Testa reação do CANM a spike inesperado. Carga normal → burst → volta ao normal.
> Arquivo: `src/scenarios/spike.js`

```javascript
export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m',  target: 9  },   // aquecimento — baseline dia útil
        { duration: '2m',  target: 9  },
        { duration: '15s', target: 50 },   // spike abrupto — burst inesperado
        { duration: '3m',  target: 50 },   // sustenta spike — CANM deve reagir
        { duration: '15s', target: 9  },   // queda repentina
        { duration: '3m',  target: 9  },   // observar scale-in
        { duration: '30s', target: 0  },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<8000'],   // threshold generoso durante spike
    http_req_failed: ['rate<0.15'],
  },
};
```

Duração total: ~10 minutos.

---

## Cenário E — Onda senoidal (sazonalidade sintética)

> Simula sazonalidade de uso. Aproxima senoide via stages curtos.
> Para um dia completo realista, use o cenário F (`econodata-dia-util.js`).
> Arquivo: `src/scenarios/sine-wave.js`

```javascript
// 2 ciclos completos (~20 minutos) — amplitude 4–22 VUs (vale fim de semana ↔ pico real)
const CYCLE = [
  { duration: '30s', target: 13 },
  { duration: '30s', target: 18 },
  { duration: '30s', target: 21 },
  { duration: '30s', target: 22 },
  { duration: '30s', target: 21 },
  { duration: '30s', target: 18 },
  { duration: '30s', target: 13 },
  { duration: '30s', target: 8  },
  { duration: '30s', target: 5  },
  { duration: '30s', target: 4  },
  { duration: '30s', target: 8  },
  { duration: '30s', target: 13 },
  { duration: '30s', target: 18 },
  { duration: '30s', target: 21 },
  { duration: '30s', target: 22 },
  { duration: '30s', target: 21 },
  { duration: '30s', target: 18 },
  { duration: '30s', target: 13 },
  { duration: '30s', target: 8  },
  { duration: '30s', target: 4  },
];

export const options = {
  scenarios: {
    sine_wave: {
      executor: 'ramping-vus',
      startVUs: 4,
      stages: CYCLE,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<4000'],
    http_req_failed: ['rate<0.08'],
  },
};
```

Duração total: ~10 minutos.

---

## Cenário F — Dia útil real (`econodata-dia-util.js`)

> Replica o padrão diário de **dia útil** medido em produção (`pattern-dia-util-2026-05-25.csv`).
> 24h comprimidas em **120 min — escala 1:12** (1 min teste = 12 min real).
> Usar com `K6_TRAFFIC_PROFILE=dia-util`.
> Detalhamento completo (CSV-by-hour, fator de correção, todas as 22 stages) em `04-cenario-econodata.md`.

**Características:**
- Calibrado ao limiar de degradação **300 VUs = 100%** (step-up 2026-05-27)
- Mapeamento **VU↔CPU não-linear** (correção): 18% CPU → 15 VUs, 97% CPU → 300 VUs
- **4 picos a 300 VUs** ao longo do dia (12h, 13h, 14h, 15h), com 15h sendo o mais intenso
- **Vale do almoço enxuto** (1h real apenas, 12h–13h)
- **Queda brusca em 16h** (transição rápida 100→60 VUs)

```javascript
// Estrutura resumida — ver arquivo para os 22 stages com todos os comentários
startVUs: 15,
stages: [
  // baseline → ramp → pico matinal → vale almoço (5 stages, picos a 300 VUs em 12h)
  // TARDE 1 (10 stages oscilando 40↔300 VUs)
  // PICO TARDE (9 stages sustentados perto de 300 VUs — 15h é o pico)
  // declínio (60→35) → queda noturna (25→20) → baseline (15)
]
```

**Duração total:** 120 minutos.

---

## Cenário G — Fim de semana real (`econodata-fim-semana.js`)

> Replica o padrão diário de **fim de semana** medido em produção (`pattern-fim-semana-2026-05-23.csv`).
> 24h comprimidas em **120 min — escala 1:12**.
> Usar com `K6_TRAFFIC_PROFILE=fim-semana`.

**Características:**
- Tráfego **genuinamente plano** o dia inteiro (CPU max ~18% mediano, sem variação temporal)
- **Apenas 2 batches agendados** quebram o platô:
  - 05h18–05h50 (multi-nodo, peak 37,7%) → 32min real / 2m40s teste
  - 17h50–17h54 (1 nodo apenas, peak 42,5%) → 4min real / 20s teste
- Sinal ao CANM: **manter estável, sem escalar** (intencional)

```javascript
// Estrutura completa — 7 stages
startVUs: 15,
stages: [
  { duration: '26m30s', target: 15 },  // 00h–05h18 madrugada plana
  { duration: '20s',    target: 70 },  // 05h18–05h22 batch matinal up
  { duration: '2m',     target: 70 },  // 05h22–05h46 batch sustentado
  { duration: '20s',    target: 15 },  // 05h46–05h50 batch down
  { duration: '60m',    target: 15 },  // 05h50–17h50 dia plano (12h reais)
  { duration: '5s',     target: 60 },  // 17h50 batch vespertino up
  { duration: '10s',    target: 60 },  // sustenta
  { duration: '5s',     target: 15 },  // down
  { duration: '30m30s', target: 15 },  // 17h54–24h fim do dia plano
]
```

**Duração total:** 120 minutos.

---

## Entry point `src/load-test.js`

> Importado por cada cenário; cada arquivo de cenário re-exporta `options` próprio e o `default function` abaixo.

```javascript
import { sleep } from 'k6';
import { SEQUENCE } from './lib/sequence.js';
import { ENDPOINT_FN } from './endpoints-map.js';

export default function () {
  const name = SEQUENCE[__ITER % SEQUENCE.length];
  ENDPOINT_FN[name]();
  sleep(parseFloat(__ENV.K6_THINK_TIME || '1.0'));
}
```

> **Importante:** k6 não suporta `import` dinâmico de `options` em runtime. Cada arquivo de cenário
> embute o `options` próprio e reusa o mesmo `default function`. Comandos exatos em `03-execucao.md §1`.

---

## Matriz cenário × profile

Para comparações reprodutíveis entre configurações do cluster, recomenda-se rodar **cada cenário com ambos os profiles**:

| Cenário | `dia-util` | `fim-semana` | Observação |
|---------|:---------:|:------------:|------------|
| A — Constant | ✅ | ✅ | Smoke test + baseline |
| B — Step-up | ✅ | ➖ | Foco em dia útil (volume maior força melhor o scale-out) |
| C — Step-down | ✅ | ➖ | Idem |
| D — Spike | ✅ | ➖ | Idem |
| E — Sine | ✅ | ✅ | Sazonalidade sintética |
| F — Econodata dia útil | ✅ | — | Profile específico |
| G — Econodata fim de semana | — | ✅ | Profile específico |
