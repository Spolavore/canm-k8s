# Plano de Implementação — k6 CANM

> **Referência principal:** `simulacao-carga-canm.md`
> **Fonte de pesos:** `k6/data/endpoits_mais_utilizados_mes*.csv` (período 2026-05-01 a 2026-05-24)
> **Decisões já tomadas:** k6 (Grafana), sem integração Prometheus por enquanto, sem preocupação com HTTP 420 (token whitelisted), conta com créditos ilimitados, **dataset idêntico entre runs** (sequência determinística).

---

## Volumetria-alvo (reproduzida no teste)

| Profile | Req/dia (real) | Req/s 24h | Req/s horário comercial | Pico estimado |
|---------|---------------:|----------:|------------------------:|--------------:|
| Dia útil | 625.823 | 7,24 | ~11,6 | ~22 |
| Fim de semana | 294.455 | 3,41 | ~5,5 | ~10 |

**Total mensal simulado (sem `superlogica-data`):** 12.368.811 req em 24 dias do período.

---

## Estrutura de arquivos a criar

```
testes-plat/
  docs/
    00-plano.md                   ← este arquivo
    01-endpoints-config.md        ← 23 endpoints + pesos dia útil/fim semana
    02-cenarios-config.md         ← 7 cenários (A–G)
    03-execucao.md                ← comandos CLI, seeds, limpeza
    04-cenario-econodata.md       ← detalhamento do cenário F (dia útil real)
    simulacao-carga-canm.md       ← contexto original do projeto

  k6/
    data/                         ← CSVs com volumetria real (input do trabalho)
    src/
      load-test.js                ← entry point compartilhado
      lib/
        auth.js                   ← token JWT + headers comuns
        sequence.js               ← sequência determinística (dia-util OU fim-semana)
      endpoints/
        busca.js                  ← 14 endpoints ecdt-busca
        historico.js              ← 3 endpoints ecdt-historico-v2
        billing.js                ← 2 endpoints ecdt-billing
        admin.js                  ← 1 endpoint ecdt-admin-v2
        api.js                    ← 1 endpoint ecdt-api (NOVO)
        tags.js                   ← 1 endpoint ecdt-tags (NOVO)
        crowdsourcing.js          ← 1 endpoint ecdt-crowdsourcing (NOVO)
      endpoints-map.js            ← string → função
      scenarios/
        constant.js               ← A — carga constante
        step-up.js                ← B — degrau ascendente
        step-down.js              ← C — degrau descendente
        spike.js                  ← D — pico isolado
        sine-wave.js              ← E — onda senoidal
        econodata-dia-util.js     ← F — dia útil real (24h comprimidas)
        econodata-fim-semana.js   ← G — fim de semana real
```

---

## Ordem de implementação

### Parte 1 — Infraestrutura base
1. `src/lib/auth.js` — exporta `AUTH_HEADERS` e `NO_AUTH_HEADERS`
2. `src/lib/sequence.js` — duas listas de pesos + `SharedArray` selecionado por `K6_TRAFFIC_PROFILE`
3. `src/endpoints/busca.js` — 14 funções
4. `src/endpoints/historico.js` — 3 funções
5. `src/endpoints/billing.js` — 2 funções
6. `src/endpoints/admin.js` — 1 função
7. `src/endpoints/api.js` — 1 função (`infoToken`)
8. `src/endpoints/tags.js` — 1 função (`tags`)
9. `src/endpoints/crowdsourcing.js` — 1 função (`apiFeedback`)
10. `src/endpoints-map.js` — mapa string → função

### Parte 2 — Cenários
11. `src/scenarios/constant.js` — A baseline, executar primeiro para smoke test
12. `src/scenarios/step-up.js` — B
13. `src/scenarios/step-down.js` — C
14. `src/scenarios/spike.js` — D
15. `src/scenarios/sine-wave.js` — E
16. `src/scenarios/econodata-dia-util.js` — F
17. `src/scenarios/econodata-fim-semana.js` — G

---

## Decisões de design

### Dois profiles de tráfego
A análise dos CSVs mostrou que a distribuição entre endpoints muda
significativamente entre dia útil e fim de semana — `searchBairros`, por exemplo,
sobe de 0,47% para 1,46% (3,1×) no fim de semana. Justifica ter duas sequências
distintas em vez de uma média ponderada.

Seleção via variável de ambiente: `K6_TRAFFIC_PROFILE=dia-util|fim-semana` (default: `dia-util`).
A sequência é construída uma única vez no init com a lista de pesos correspondente.

### Sequência determinística (requisito central)
O dataset de carga deve ser **idêntico entre execuções** para que diferentes configurações
do cluster CANM sejam comparadas com o mesmo input.

Abordagem em `src/lib/sequence.js` + `load-test.js`:
1. `sequence.js` gera um array de 10.000 nomes de endpoint distribuídos proporcionalmente aos pesos do profile ativo.
2. Embaralha com **Fisher-Yates + LCG semeado** (semente fixa `42`).
3. Armazena no `SharedArray` do k6 — construído uma única vez no init.
4. `load-test.js` usa `exec.scenario.iterationInTest` (índice **global** no cenário, não por VU) para acessar `sequence[idx % sequence.length]`.

**Propriedades garantidas:**

| Comparação | Mesmas requisições? | Mesmo conteúdo? | Mesma ordem? |
|------------|:------------------:|:---------------:|:------------:|
| Mesmo cenário + mesma config + mesmo profile (reexecução) | ✅ idênticas | ✅ | ✅ |
| Cenários diferentes, mesmo profile, mesma quantidade total de iters | ✅ idênticas | ✅ | ✅ |
| Cenários diferentes, mesmo profile, quantidades diferentes (N < M) | ✅ as N reqs do cenário menor são as N primeiras do cenário maior (**subconjunto exato**) | ✅ | ✅ |
| Profiles diferentes (`dia-util` vs `fim-semana`) | ❌ propositalmente distintas (distribuições diferentes) | — | — |

Em palavras: **cenário com mais requisições é sempre um superconjunto do cenário com menos
requisições** (no mesmo profile). Comparar resultado da config A vs config B do CANM em
qualquer cenário é comparar exatamente o mesmo input.

> **Atenção:** se um cenário ultrapassar 10.000 iterações totais, a sequência reinicia (`idx % SEQUENCE.length`).
> Para cenários longos, aumentar o tamanho do `buildRaw` no `sequence.js`.

### Payloads fixos
Nenhum dado aleatório nos corpos das requisições. Todos os endpoints usam fixtures hardcoded:
- CNPJ fixture: `33000167000101` (Petrobrás — empresa com dados ricos no Elastic)
- `cdCliente`: `TESTE-1-20260523`
- `searchEmailsBuscados.cnpjsComprimidos`: string LZ-String pré-computada do CNPJ fixture, **hardcoded** em `busca.js`
- `desbloquearEmpresas.cnpjs`: CNPJ criptografado `6084160a58feb6f4ff21682505bb979974b6e7b27359e86f919c7dd083e66cb3`, **hardcoded** em `billing.js`
- `apiFeedback`: payload real capturado em produção — `cnpj='98.748.809/0001-09'`, `nome_campo='sobre_empresa'`, `avaliacao='Like'`

### Think time fixo
`sleep(1.0)` fixo entre iterações — sem variação aleatória.
Ajustável via `K6_THINK_TIME` (default `1.0`), mas deve ser o mesmo valor em todas as baterias comparativas.

### Token único
Todos os VUs usam o mesmo token Bearer (ver `01-endpoints-config.md §src/lib/auth.js`).
`ecdt-admin-v2-back` usa `jwt.verify()` — validar com `curl` manual antes da primeira execução
(ver `03-execucao.md §2.4`).

### Endpoints com gravação em BD
`salvar-pesquisa-recente`, `desbloquearEmpresas` gravam dados reais em beta.
A conta tem créditos ilimitados — sem risco de esgotar saldo.
Executar limpeza de `log_pesquisa` após cada bateria (ver `03-execucao.md §3`).

### Endpoints com dependência de dado
- `searchEmailsBuscados` — LZ-String hardcoded em `busca.js`.
- `obterGrupoEconomico` e `obterOrganograma` — CNPJ `33000167000101` como fixture.
- `desbloquearEmpresas` — CNPJ criptografado hardcoded em `billing.js` (valor: `6084160a...e66cb3`).
- `apiFeedback` — PUT com payload real capturado em produção; sem side effects observáveis (confirmado).

### Endpoints removidos do escopo
- `updateElasticIndexExp` — removido pelo usuário (depende de `cdEvento` UUID gerenciado internamente).
- `api/superlogica-data` — chama API externa.
- Endpoints com volume baixo que não aparecem no top 25 real: `searchFerramentasTecnologias`,
  `searchAllSetorAmigavel`, `searchFaixasPresumidas`, `cidadesFormatadas`, `searchCalcCompanies`,
  `pesquisa-new`, `history-new`, `get-pesquisa`, `searchCidades`, `searchCnaesFilter`,
  `dados-dashboard`, `dados-tabelas-dashboard`, `api/billing-v3/debitar`.

### Endpoints adicionados ao escopo (novos)
Surgiram nos novos relatórios mas não estavam na especificação original:
- `ecdt-api/info-token` — GET, lista webhooks/integrações.
- `ecdt-tags/tags` — GET, lista tags do cliente.
- `ecdt-crowdsourcing/api/feedback` — PUT, avaliação de campo de empresa.

### Thresholds padrão (ajustar por cenário)
```javascript
thresholds: {
  http_req_duration: ['p(95)<3000'],
  http_req_failed: ['rate<0.05'],
}
```

---

## Pré-requisitos antes de executar qualquer teste

1. k6 instalado: `k6 version` deve retornar `v0.5x.x`
2. Token JWT válido — checar `exp: 1780171343` (~2026-06-26)
3. Validação `curl` dos 6 endpoints (smoke + escritas) — ver `03-execucao.md §2` — todos retornando 200

> Todos os valores específicos do ambiente estão hardcoded — não há nada a configurar via env.

---

## Cenário recomendado para primeira execução

**`constant.js`** com `K6_TRAFFIC_PROFILE=dia-util`, `K6_VUS=3`, `K6_DURATION=2m` — smoke test
que cobre todos os 23 endpoints e valida o setup end-to-end antes de qualquer experimento com o CANM.

```bash
k6 run k6/src/scenarios/constant.js \
  -e K6_TRAFFIC_PROFILE=dia-util \
  -e K6_VUS=3 -e K6_DURATION=2m
```
