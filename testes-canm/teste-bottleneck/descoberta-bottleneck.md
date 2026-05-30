# Teste de Descoberta de Bottleneck

## Configuração

* 4 nodos no high-node-pool, 5 pods por deployment
* Cenário: `step-up.js` — 6 degraus instantâneos de 150 VUs, 1 min por degrau
* Degraus: 150 → 300 → 450 → 600 → 750 → 900 VUs
* Profile: `dia-util`

## Resultados (execução 2026-05-25)

### Limiar de saturação

| Métrica | Valor |
|---|---|
| VUs sem degradação (0 erros) | **≤ 750 VUs** |
| VUs onde degradação começa | **900 VUs** |
| Throughput sustentável máximo | **~136 req/s** (a 750 VUs, sem erros) |
| Throughput no colapso | ~141 req/s (a 900 VUs, com 60%+ de erro no pico) |
| Total de requisições no teste | 46.898 |
| Taxa de erro global | 0,87% (concentrada no degrau final) |

### Perfil de erros no degrau 900 VUs

| Tipo | Qtd | % |
|---|---|---|
| Timeout (error_code 1050) | 382 | 93% |
| 502 Bad Gateway | 26 | 6% |
| EOF / connection reset | 3 | 1% |
| 401 / 400 / 403 (auth/payload) | **0** | 0% |

> Os erros são 100% de capacidade — nenhum erro de token ou payload malformado.

### Endpoint gargalo

`/ecdt-busca/searchDadosDetalheEmpresa` — **376 timeouts (92% de todos os erros)**

É o primeiro endpoint a falhar sob carga alta (query multi-documento Elasticsearch,
mais cara que os GETs simples). O segundo mais afetado é
`/ecdt-historico-v2/obter-nota-qualificacao` (18 × 502).

### Latência por degrau (comportamento observado)

* **p50**: estável até ~750 VUs, colapsa a 900 VUs
* **p95**: começa a subir a ~600 VUs, explode a 900 VUs
* **p99**: sobe progressivamente desde o início — sensível à carga desde 300 VUs

## Conclusão

O sistema suporta até **~750 VUs / ~136 req/s** sem erros mensuráveis.
Acima disso o primeiro componente a ceder é o `ecdt-busca` (pod de busca),
com queries lentas acumulando fila até estourar o timeout de 120s.

Os cenários de carga realista (`econodata-dia-util`, `econodata-fim-semana`)
foram calibrados para operar com folga abaixo deste limiar:

| Cenário | Pico (VUs) | % do limiar |
|---|---|---|
| `econodata-dia-util` (SPIKE) | 400 | 53% |
| `econodata-fim-semana` (platô) | 120 | 16% |

<!-- Cluster: 4 nodos high-node-pool, 5 pods/deployment, CANM desligado -->
