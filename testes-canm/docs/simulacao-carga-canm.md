# Contexto: Simulação de Carga para Validação do CANM (v3 — calibrada por dados reais)

> **Status:** v3 atualiza a §6 com volumetria real extraída de `logs.utilizacao_ms_plataforma`
> (período 2026-05-01 a 2026-05-24) e separa profiles **dia útil** vs **fim de semana**.
> Novos endpoints incluídos no escopo: `ecdt-api/info-token`, `ecdt-tags/tags`,
> `ecdt-crowdsourcing/api/feedback`. Endpoints com volume fora do top 25 real foram retirados
> do escopo de teste (mantidos no documento apenas como referência histórica).
> CSVs-fonte em `k6/data/`. Detalhamento operacional em `docs/01-endpoints-config.md`.

---

## 1. Objetivo

Validar a solução **CANM** (autoescalonador de clusters do TCC) por meio
de testes de carga sobre a plataforma da **Econodata** no ambiente de **beta**.
A simulação deve permitir variar:

- **Quantidade de usuários simulados** (concorrência).
- **Mix de URLs requisitadas** (distribuição entre endpoints).
- **Duração e ramp-up** da carga (para observar reação do escalonador).

---

## 2. Ambiente Alvo

| Componente            | URL / Localização                                   |
|-----------------------|------------------------------------------------------|
| Front-end (Vue 2)     | `https://beta.plat.econodata.com.br/`                |
| API Gateway (beta)    | `https://betaplat.api.econodata.com.br`              |
| Repositórios locais   | `/home/spola/plataforma-repositories`                |
| Cluster               | GKE — cluster **beta** (observado via Prometheus do CANM) |

**Stack confirmada:**
- `ecdt-busca`: Node.js + **Express 4.17.1**
- `ecdt-admin-v2-back`: Node.js + **Express 4.17.1**
- `ecdt-billing`: Node.js + **Express 4.17.1**
- `ecdt-historico-v2`: Node.js + **Express 4.x**
- **Front-end:** Vue 2 (não testado diretamente — carga vai contra o gateway).

> ⚠️ **Todas as requisições de carga passam pelo gateway**
> `https://betaplat.api.econodata.com.br`. Nunca apontar diretamente para os
> IPs internos dos pods. O gateway é o único ponto de entrada do simulador.

---

## 3. Autenticação

Os endpoints da plataforma exigem **JWT no header `Authorization`** com prefixo
**`Bearer`** (formato padrão OAuth2 Bearer Token).

### 3.1 Token a ser utilizado nos testes

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjZF9jbGllbnRlIjoiVEVTVEUtMS0yMDI2MDUyMyIsImlkX3VzdWFyaW8iOjM3MzA4LCJ1c2VyX25hbWUiOiJ0dEB0dC5jb20iLCJzY29wZSI6WyJvcGVuaWQiXSwiZXhwIjoxNzgwMTcxMzQzLCJhdXRob3JpdGllcyI6WyJST0xFX1VTRVIiXSwianRpIjoiZTc3YjBhM2MtMDM2OS00OWIxLTg5YTEtNmU4ZjRiMTcwZmM2IiwiY2xpZW50X2lkIjoiM2FhOThmYjliYTA1MDI0NzA1YTY0MDRmNmFkZDBhODAiLCJmbGdfYXRpdm8iOnRydWUsImZsZ19wbGFub19hdGl2byI6dHJ1ZX0.m5QeBfWbPQklvW52GCYFbefznSczSGPpKAZIl_TdScI
```

### 3.2 Como utilizar

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...m5QeBfWbPQklvW52GCYFbefznSczSGPpKAZIl_TdScI
```

> ⚠️ **Atenção ao prefixo `Bearer ` (com espaço)**.

### 3.3 Conteúdo do token (claims relevantes)

- `cd_cliente`: `TESTE-1-20260523`
- `id_usuario`: `37308`
- `user_name`: `tt@tt.com`
- `authorities`: `[ROLE_USER]`
- `client_id`: `3aa98fb9ba05024705a6404f6add0a80`
- `flg_ativo`: `true`
- `flg_plano_ativo`: `true`
- `exp`: `1780171343` (verificar validade antes de cada bateria)

### 3.4 Validação do token nos serviços

| Serviço | Biblioteca JWT | Verifica assinatura? | Claim de tenant |
|---------|---------------|----------------------|-----------------|
| ecdt-busca | `jsonwebtoken@8.5.1` | **NÃO** — `jwt.decode()` | `cd_cliente` + `id_usuario` |
| ecdt-admin-v2-back | `jsonwebtoken@8.5.1` | **SIM** — `jwt.verify()` + `JWT_SECRET` | `userId` |
| ecdt-billing | `jsonwebtoken@8.5.1` | **NÃO** — `jwt.decode()` | `cd_cliente` + `id_usuario` |
| ecdt-historico-v2 | `jsonwebtoken@8.5.1` | **NÃO** — `jwt.decode()` | `cd_cliente` + `id_usuario` |

**Conclusão:** todos os VUs podem usar o mesmo token. `ecdt-busca`, `ecdt-billing` e
`ecdt-historico-v2` não verificam a assinatura — o token é aceito mesmo após o `exp`.
`ecdt-admin-v2-back` usa `jwt.verify()`: validar se o token do §3.1 foi assinado com
o `JWT_SECRET` do ambiente beta antes de testar `tarja-notificacao`.

---

## 4. Microsserviços envolvidos

| Microsserviço      | Repositório confirmado                                           | Stack              |
|--------------------|------------------------------------------------------------------|--------------------|
| ecdt-busca         | `/home/spola/plataforma-repositories/ecdt-busca`                | Node.js / Express 4.17 |
| ecdt-admin-v2-back | `/home/spola/plataforma-repositories/ecdt-admin-v2-back`        | Node.js / Express 4.17 |
| ecdt-billing       | `/home/spola/plataforma-repositories/ecdt-billing`              | Node.js / Express 4.17 |
| ecdt-historico-v2  | `/home/spola/plataforma-repositories/ecdt-historico-v2`         | Node.js / Express 4.x  |

### 4.1 Informações por microsserviço

---

#### ecdt-busca

- **Caminho:** `/home/spola/plataforma-repositories/ecdt-busca`
- **Framework HTTP:** Express 4.17.1
- **Porta no ambiente beta:** `6974` (`.env.beta` → `PORT=6974`)
- **Arquivo principal de rotas:** `src/index.js`
- **Middleware de autenticação JWT:**
  - Arquivo: `src/middleware/authMiddleware.js`
  - Biblioteca: `jsonwebtoken@8.5.1`
  - **Sem verificação de assinatura** — `jwt.decode()` apenas
  - Claims: `cd_cliente` → `req.userInfo.cdCliente`, `id_usuario` → `req.userInfo.idUsuario`
  - Dois middlewares: `jwtTokenMiddleware` (decodifica) e `jwtTokenAuthAndInfoMiddleware` (decodifica + valida token no Postgres — mais pesado)
- **Rate-limiting:** Sim — Token Bucket via Redis (`ioredis@5.6.0`), **500 tokens/min por usuário**
  - HTTP 420 ao exceder
  - Endpoints **isentos:** `checkSessao`, `health`, `searchCompaniesExport`, `searchPartnersExport`, `searchCompaniesExportPipedrive`, `searchFerramentasTecnologias`, `searchNomesByCnpjs`, `searchFiltroNcm`, `searchEmailsBuscados`, `calculadoraCache`, `updateElasticIndexExp`, `searchBairros`, `searchCidades`, `cidadesFormatadas`
- **Prefixo no gateway:** `/ecdt-busca`

---

#### ecdt-admin-v2-back

- **Caminho:** `/home/spola/plataforma-repositories/ecdt-admin-v2-back`
- **Framework HTTP:** Express 4.17.1
- **Porta no ambiente beta:** `3000` (variável `PORT`)
- **Arquivo principal de rotas:** `src/index.js` (linhas 33–102)
- **Middleware de autenticação JWT:**
  - Arquivo: `src/helpers/token.js`
  - Biblioteca: `jsonwebtoken@8.5.1`
  - **Verifica assinatura** — `jwt.verify()` com `process.env.JWT_SECRET`
  - Claim de usuário: `userId`
  - Variável de ambiente: `JWT_SECRET`
- **Rate-limiting:** Nenhum
- **Pool BD:** `max: 1` — apenas 1 conexão Postgres simultânea; concorrência > 1 serializa na fila
- **Prefixo no gateway:** `/ecdt-admin-v2`
- **Restrição do gateway em beta:** POST, PUT e PATCH para `/ecdt-admin-v2` são **bloqueados** pelo gateway (`requestController.js` linhas 160–163). Apenas **GET** é permitido neste serviço em beta. `tarja-notificacao` deve ser simulado somente como GET.

---

#### ecdt-billing

- **Caminho:** `/home/spola/plataforma-repositories/ecdt-billing`
- **Framework HTTP:** Express 4.17.1
- **Porta no ambiente beta:** `9969` (gateway `routes-beta.json` → `10.93.9.40:9969`)
- **Arquivo principal de rotas:** `src/index.js` (linhas 13–69)
- **Middleware de autenticação JWT:**
  - Arquivo: `src/middlewares/tokenValidation.js`
  - Biblioteca: `jsonwebtoken@8.5.1`
  - **Sem verificação de assinatura** — `jwt.decode()` apenas
  - Claims: `cd_cliente`, `id_usuario`, `user_name`
  - Endpoints sem JWT: `api/billing/dados-dashboard`, `api/billing/dados-tabelas-dashboard`
- **Rate-limiting:** Nenhum
- **Pool BD:** `max: 10`, `connectionTimeoutMillis: 10000`
- **Prefixo no gateway:** `/ecdt-billing`

---

#### ecdt-historico-v2

- **Caminho:** `/home/spola/plataforma-repositories/ecdt-historico-v2`
- **Framework HTTP:** Express 4.x (Node.js)
- **Porta no ambiente beta:** `9998` (`.env.beta` → `PORT=9998`)
  - Gateway `routes-beta.json` aponta para `10.93.9.60:9997` — possível divergência de configuração; irrelevante pois tráfego passa pelo gateway.
- **Arquivo principal de rotas:** `src/index.js` (linhas 26–53)
- **Middleware de autenticação JWT:**
  - Arquivo: `src/middleware/authMiddleware.js`
  - Biblioteca: `jsonwebtoken` (v8.5.1)
  - **Sem verificação de assinatura** — `jwt.decode()` apenas
  - Claims: `cd_cliente` → `req.userInfo.cdCliente`, `id_usuario` → `req.userInfo.idUsuario`
  - Retorna 401 se `cd_cliente` ou `id_usuario` ausentes
- **Rate-limiting:** Nenhum
- **Pool BD:** `max: 10`, `idleTimeoutMillis: 120000`, `connectionTimeoutMillis: 120000` (`src/database/connectionAdmin.js`)
- **Prefixo no gateway:** `/ecdt-historico-v2`

---

## 5. Mapeamento gateway → microsserviço

**Repositório do gateway:** `/home/spola/plataforma-repositories/ecdt-gateway-v2`

**Framework:** Express 4.18.2 com `http-proxy-middleware@2.0.6`

**Arquivo de rotas beta:** `src/database/routes-beta.json`

O gateway carrega dinamicamente: `require('./database/routes-${process.env.ENV}.json')`

E registra para cada serviço:
```javascript
app.use(routes[routeName].path + "/:endpoint", requestController.doRequest);
app.use("/v2" + routes[routeName].path + "/:endpoint", requestController.doRequest);
```

> **Regra fundamental do teste de carga:** todas as requisições devem usar a URL
> pública do gateway — `https://betaplat.api.econodata.com.br`. Os IPs internos
> dos pods são apenas referência de infraestrutura. Nunca apontar o simulador
> diretamente para IPs de pod.

### Mapeamento beta dos 4 serviços em escopo

| Prefixo gateway | IP:Porta interno (beta) | Serviço |
|-----------------|------------------------|---------|
| `/ecdt-busca` | `10.93.9.43:9974` | ecdt-busca |
| `/ecdt-billing` | `10.93.9.40:9969` | ecdt-billing |
| `/ecdt-historico-v2` | `10.93.9.60:9997` | ecdt-historico-v2 |
| `/ecdt-admin-v2` | `10.93.9.73:3000` | ecdt-admin-v2-back |

### URLs completas no gateway de beta

```
https://betaplat.api.econodata.com.br/ecdt-busca/<endpoint>
https://betaplat.api.econodata.com.br/ecdt-admin-v2/<endpoint>
https://betaplat.api.econodata.com.br/ecdt-billing/<endpoint>
https://betaplat.api.econodata.com.br/ecdt-historico-v2/<endpoint>
```

### Autenticação no gateway

O gateway valida o JWT chamando `/oauth/check_token` antes de fazer proxy.
O token é repassado nos headers `authorization`, `x-api-token` e `x-ecdt-token`.
**Timeout do servidor gateway:** 600 segundos.

**Bypass routes no gateway** (sem validação JWT no gateway — o serviço ainda pode validar):
`/ecdt-busca/searchFiliais`, `/api/user/login`, `/oauth/token`, entre outras rotas públicas.

---

## 6. Endpoints a simular — dados reais

**Fonte:** `k6/data/endpoits_mais_utilizados_mes*.csv`
**Período medido:** 2026-05-01 a 2026-05-24 (16 dias úteis + 8 dias de fim de semana).
**Query:** ver `k6/data/queries.txt`.

### 6.0 — Volumetria agregada (sem `api/superlogica-data`)

| Métrica | Dia útil | Fim de semana | Mês total |
|---------|---------:|--------------:|----------:|
| Req agregadas (24 dias) | 10.013.175 | 2.355.636 | 12.368.811 |
| Req/dia média | **625.823** | **294.455** | — |
| Req/s média 24h | **7,24** | **3,41** | — |
| Req/s estimada horário comercial (~80% em 12h) | ~11,6 | ~5,5 | — |
| Pico estimado (3× HC) | ~22 | ~10 | — |

> Volume real **3,3× maior** do que a estimativa anterior de 3,75M req/ano (a v2 do documento
> usava extrapolação anual baseada em outra metodologia; v3 usa dados mensais reais).

### 6.1 — Endpoints incluídos no teste (23 únicos)

Apenas endpoints no top 25 real são testados. Endpoints da especificação original com volume
insuficiente foram removidos do escopo (ver §6.2).

| # | Serviço | Endpoint | Vol. dia útil | Peso dia útil | Vol. fim semana | Peso fim semana |
|---|---------|----------|--------------:|-------------:|----------------:|---------------:|
| 1 | ecdt-historico-v2 | `obter-nota-qualificacao` | 4.336.004 | 43,30% | 966.337 | 41,02% |
| 2 | ecdt-admin-v2 | `tarja-notificacao` *(GET only)* | 726.300 | 7,25% | 188.989 | 8,02% |
| 3 | ecdt-billing | `api/billing-v3/saldo` | 651.718 | 6,51% | 151.336 | 6,42% |
| 4 | ecdt-busca | `searchFiliais` | 612.458 | 6,12% | 152.779 | 6,49% |
| 5 | ecdt-crowdsourcing | `api/feedback` *(NOVO)* | 371.551 | 3,71% | 89.591 | 3,80% |
| 6 | ecdt-api | `info-token` *(NOVO)* | 335.002 | 3,35% | 73.820 | 3,13% |
| 7 | ecdt-busca | `checkSessao` | 328.744 | 3,28% | 83.663 | 3,55% |
| 8 | ecdt-tags | `tags` *(NOVO)* | 322.205 | 3,22% | 75.172 | 3,19% |
| 9 | ecdt-busca | `searchDadosDetalheEmpresa` | 313.785 | 3,13% | 76.545 | 3,25% |
| 10 | ecdt-busca | `obterGrupoEconomico` | 305.802 | 3,05% | 73.902 | 3,14% |
| 11 | ecdt-busca | `searchEventoCliente` | 291.161 | 2,91% | 71.271 | 3,02% |
| 12 | ecdt-busca | `searchEmailsBuscados` | 290.518 | 2,90% | 70.483 | 2,99% |
| 13 | ecdt-busca | `searchFiltroDecisores` | 264.422 | 2,64% | 50.398 | 2,14% |
| 14 | ecdt-busca | `quickSearch` | 209.715 | 2,09% | 55.070 | 2,34% |
| 15 | ecdt-busca | `searchDadosMapping` | 174.986 | 1,75% | 39.680 | 1,68% |
| 16 | ecdt-busca | `searchCompanies` | 106.378 | 1,06% | 23.761 | 1,01% |
| 17 | ecdt-historico-v2 | `pega-prompts-pesquisas` | 72.730 | 0,73% | 15.358 | 0,65% |
| 18 | ecdt-billing | `api/billing-v3/desbloquearEmpresas` | 55.617 | 0,56% | 17.238 | 0,73% |
| 19 | ecdt-busca | `obterOrganograma` | 54.311 | 0,54% | 11.502 | 0,49% |
| 20 | ecdt-busca | `pesquisarCamposPorCnpj` | 52.580 | 0,53% | 12.040 | 0,51% |
| 21 | ecdt-busca | `searchCnpjsBloqueados` | 47.042 | 0,47% | 11.316 | 0,48% |
| 22 | ecdt-busca | `searchBairros` | 46.639 | 0,47% | 34.445 | **1,46%** |
| 23 | ecdt-historico-v2 | `salvar-pesquisa-recente` | 43.507 | 0,43% | 10.940 | 0,46% |

**Diferenças notáveis dia útil ↔ fim de semana:**
- `searchBairros` triplica de peso (0,47% → 1,46%) — busca por endereço cresce no fim de semana
- `tarja-notificacao` sobe de 7,25% para 8,02%
- `info-token` cai de 3,35% para 3,13%
- `searchFiltroDecisores` cai de 2,64% para 2,14% (uso comercial)

### 6.2 — Endpoints removidos do escopo

| Endpoint | Motivo |
|----------|--------|
| `api/superlogica-data` (vol. mês 198.520) | API externa Superlogica |
| `updateElasticIndexExp` | Removido pelo usuário (depende de `cdEvento` UUID gerenciado internamente) |
| `searchFerramentasTecnologias`, `searchAllSetorAmigavel`, `searchFaixasPresumidas`, `cidadesFormatadas`, `searchCalcCompanies` | Não aparecem no top 25 real |
| `pesquisa-new`, `history-new`, `get-pesquisa` | Não aparecem no top 25 real |
| `searchCidades`, `searchCnaesFilter` | Não aparecem no top 25 real |
| `api/billing/dados-dashboard`, `api/billing/dados-tabelas-dashboard`, `api/billing-v3/debitar` | Não aparecem no top 25 real |
| `busca-inteligente` | Chama API Anthropic — custo real de IA |

### 6.3 — Endpoints adicionados ao escopo (NOVOS)

Surgiram nos relatórios reais mas não estavam na especificação v1/v2.

| Endpoint | Repositório | Método | Body / Observação |
|----------|-------------|--------|---------------------|
| `ecdt-api/info-token` | Não disponível localmente (gateway: `10.93.9.41:9970`) | GET | Sem body. Lista webhooks/integrações do cliente. Usado em `WebhookButtons.vue`. |
| `ecdt-tags/tags` | `/home/spola/plataforma-repositories/ecdt-tags` | GET | Sem body. Lista tags do `cd_cliente` (extraído via `jwt.decode()`). Somente leitura. |
| `ecdt-crowdsourcing/api/feedback` | Não disponível localmente (gateway: `10.93.9.61:9980`) | PUT | Payload de avaliação: `{ cnpj, nome_campo, valor_atual, novo_valor, detalhe_campo, avaliacao, tipo }`. Operação mais comum no frontend (`putRequestPromise`). |

### 6.4 — Distribuição por microsserviço (dados reais — dia útil)

| Microsserviço | # endpoints testados | Volume dia útil | % dia útil |
|---------------|---------------------|----------------:|-----------:|
| ecdt-historico-v2 | 3 | 4.452.241 | 44,46% |
| ecdt-busca | 14 | 3.098.541 | 30,94% |
| ecdt-admin-v2 | 1 | 726.300 | 7,25% |
| ecdt-billing | 2 | 707.335 | 7,07% |
| ecdt-crowdsourcing | 1 | 371.551 | 3,71% |
| ecdt-api | 1 | 335.002 | 3,35% |
| ecdt-tags | 1 | 322.205 | 3,22% |

> **Observação:** o endpoint dominante é `obter-nota-qualificacao` (43% sozinho). Carga no
> `ecdt-historico-v2` é maior do que a v2 indicava — atenção ao pool BD `max:10`.

### 6.1 Endpoints de billing — cascata confirmada

**`desbloquearEmpresas` chama `debitar` internamente?**

**SIM** — por chamada de função local (não HTTP).
`desbloquearEmpresa.controller.js` linha 40: `billingService.realizarTransacao(TIPO_MOVIMENTACAO.debito, ...)`
Sem transação de BD englobando a operação → risco de inconsistência em alta concorrência (ver §10).

**`desbloquearPessoa`:** mesmo padrão (linhas 116–117). Não está no top 34 mas segue a mesma lógica.

---

## 7. Detalhes técnicos por endpoint

---

### 1. ecdt-busca — `checkSessao`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/checkSessao`
- **Arquivo de rota:** `src/index.js`
- **Controller / handler:** `src/controllers/sessaoController.js` → `verificarSessao()`
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** `{ "status": 200, "body": "ok" }`
- **Side effects:** Lê features toggle do Postgres (somente leitura)
- **Observações:** Isento de rate-limit. Endpoint ideal para validar o setup do simulador (end-to-end smoke test).
- **Rate-limit:** Isento

---

### 2. ecdt-admin-v2 — `tarja-notificacao`

- **Método HTTP:** GET *(PUT bloqueado pelo gateway em beta)*
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-admin-v2/tarja-notificacao`
- **Arquivo de rota:** `src/index.js` (linhas 37–39)
- **Controller / handler:** `src/controllers/notificacoes/notificacoes.controller.js` → `getTarjaAviso()` (linha 13)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Objeto da tabela `app_plataforma.tarja_notificacao` WHERE `ativo = true`
- **Side effects:** Nenhum — SELECT somente leitura
- **Observações:** Pool BD `max: 1` — alta concorrência neste endpoint serializa todas as queries. Auth com `jwt.verify()`: validar se o token do §3.1 funciona.
- **Rate-limit:** Nenhum

---

### 3. ecdt-billing — `api/billing-v3/saldo`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-billing/api/billing-v3/saldo`
- **Arquivo de rota:** `src/index.js`
- **Controller / handler:** `src/controllers/extratoV3.controller.js` → `getSaldo()` (linhas 6–25)
- **Query params:** `tpCredito` (opcional) — valores: `exportacao`, `geracao_email`, `validacao_telefone`, `desbloqueio_empresas`
- **Body:** Nenhum
- **Resposta esperada (200):** JSON com `saldo_*_disponivel`, `saldo_*_consumido`, `saldo_*_total`, `cd_cliente`, `data_proxima_renovacao`, `periodo`, limites do plano
- **Side effects:** Nenhum — SELECT em `billing.movimentos` + `public.plano_cliente`
- **Rate-limit:** Nenhum

---

### 4. ecdt-busca — `searchDadosMapping`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchDadosMapping`
- **Arquivo de rota:** `src/index.js`
- **Controller / handler:** `src/controllers/faixasController.js` → `searchDadosMappingExibicao()` (linha 16)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Dados de mapeamento de exibição (faixas presumidas para UI)
- **Side effects:** Leitura do Elasticsearch
- **Rate-limit:** Sujeito (500/min)

---

### 5. ecdt-busca — `searchFiltroDecisores`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchFiltroDecisores`
- **Controller / handler:** `src/controllers/decisoresController.js` → `searchFiltroDecisores()` (linha 4)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Lista de filtros de decisores (cargos/departamentos)
- **Side effects:** Consulta Postgres ou Elasticsearch (somente leitura)
- **Rate-limit:** Sujeito

---

### 6. ecdt-busca — `searchFiliais`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchFiliais`
- **Controller / handler:** `src/controllers/filiaisController.js` → `searchFiliais()` (linha 4)
- **Body mínimo:**
  ```json
  { "cnpj": "00000000000191" }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** Lista de filiais da empresa
- **Side effects:** Consulta Elasticsearch — sem gravação
- **Observações:** Este endpoint está no **bypass de auth do gateway** (`/ecdt-busca/searchFiliais`) — o gateway não valida JWT nesta rota, mas o serviço aplica `jwtTokenMiddleware` internamente.
- **Rate-limit:** Sujeito

---

### 7. ecdt-historico-v2 — `obter-nota-qualificacao`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-historico-v2/obter-nota-qualificacao`
- **Arquivo de rota:** `src/index.js` (linha 29)
- **Controller / handler:** `src/controllers/qualificacaoController.js` → `obterNotaQualificacao()` (linhas 4–18)
- **Body:**
  ```json
  { "cnpj": "00000000000191" }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):**
  ```json
  { "dt_nota": 1716400000000, "nota": "Cliente importante" }
  ```
  ou `{ "dt_nota": -1, "nota": "" }` se não houver nota.
- **Side effects:** Nenhum — SELECT em `app_plataforma.notas_qualificacao` (somente leitura)
- **Rate-limit:** Nenhum

---

### 8. ecdt-busca — `searchDadosDetalheEmpresa`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchDadosDetalheEmpresa`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `searchDetalheEmpresa()` (linha 259)
- **Body:**
  ```json
  { "listCnpjs": ["00000000000191"] }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** Dados detalhados da empresa (organograma count, decisores, telefones validados, feedbacks)
- **Side effects:** `Promise.all` com múltiplos fetches: Postgres (empresas desbloqueadas, telefones validados), Elasticsearch (empresa + organograma), crowdsourcing — sem gravação
- **Observações:** Endpoint mais pesado da busca. Latência esperada: 200–800ms. Sujeito ao rate-limit.
- **Rate-limit:** Sujeito

---

### 9. ecdt-busca — `searchEventoCliente`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchEventoCliente`
- **Controller / handler:** `src/controllers/eventoController.js` → `searchEventoCliente()` (linha 5)
- **Body:**
  ```json
  { "cnpj": "00000000000191" }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** Lista de eventos do cliente filtrados por `cd_cliente` + `cnpj` (7 tipos)
- **Side effects:** Nenhum — busca Elasticsearch com filtro por `cd_cliente`
- **Rate-limit:** Sujeito

---

### 10. ecdt-busca — `obterGrupoEconomico`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/obterGrupoEconomico`
- **Controller / handler:** `src/controllers/grupoEconomicoController.js` → `searchGrupoEconomico()` (linha 6)
- **Query params:** `cnpj=<valor>` OU `id=<valor>` (um é obrigatório)
- **Body:** Nenhum
- **Resposta esperada (200):** Estrutura hierárquica do grupo econômico
- **Side effects:** Nenhum — somente leitura Elasticsearch + Postgres
- **Rate-limit:** Sujeito

---

### 11. ecdt-busca — `searchEmailsBuscados`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchEmailsBuscados`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `searchEmailsBuscados()` (linha 383)
- **Body:**
  ```json
  {
    "cdCliente": "TESTE-1-20260523",
    "cnpjsComprimidos": "<LZ-String>",
    "bloqueada": false,
    "dominiosEmpresa": []
  }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** `{ "cnpj": ["email1@...", "email2@..."] }` por empresa
- **Side effects:** Nenhum — sem gravação; emails criptografados se `bloqueada=true`
- **Observações:** **SEM autenticação JWT** nesta rota. **Isento de rate-limit.**
- **Rate-limit:** Isento + sem auth

---

### 12. ecdt-busca — `quickSearch`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/quickSearch`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `quickSearch()` (linha 236)
- **Body:**
  ```json
  { "cnpj": "econodata", "ufs": ["SP"], "size": 10 }
  ```
  (`cnpj` é texto livre para busca por nome ou CNPJ)
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** `{ "resultado_empresas": {...}, "resultado_pessoas": {...} }`
- **Side effects:** Duas buscas paralelas no Elasticsearch — sem gravação
- **Rate-limit:** Sujeito

---

### 13. ecdt-historico-v2 — `pega-prompts-pesquisas`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-historico-v2/pega-prompts-pesquisas`
- **Arquivo de rota:** `src/index.js` (linha 53)
- **Controller / handler:** `src/controllers/promptsController.js` → `carregarPrompts()` (linhas 4–15)
- **Query params:** Nenhum (usa claims do JWT)
- **Body:** Nenhum
- **Headers além de Authorization:** Nenhum
- **Resposta esperada (200):**
  ```json
  { "prompts": ["busca anterior 1", "busca anterior 2"] }
  ```
- **SQL executado:**
  ```sql
  SELECT array_agg(DISTINCT prompt) AS prompts
  FROM public.log_pesquisa
  WHERE cd_cliente = $1 AND id_usuario = $2 AND prompt IS NOT NULL
  ```
- **Side effects:** Nenhum — SELECT somente leitura em `public.log_pesquisa`
- **Observações:** Retornará array vazio se o usuário de teste não tiver prompts salvos. Inserir registros de teste antes.
- **Rate-limit:** Nenhum

---

### 14. ecdt-busca — `obterOrganograma`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/obterOrganograma`
- **Controller / handler:** `src/controllers/organogramaController.js` → `searchOrganograma()` (linha 6)
- **Query params:** `cnpj=<valor>` (obrigatório)
- **Body:** Nenhum
- **Resposta esperada (200):** Árvore hierárquica do organograma enriquecida com emails validados
- **Side effects:** Nenhum — leitura Elasticsearch + Postgres
- **Rate-limit:** Sujeito

---

### 15. ecdt-busca — `searchFerramentasTecnologias`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchFerramentasTecnologias`
- **Controller / handler:** `src/controllers/ferramentasTecnologiasController.js` → `searchFerramentasTecnologias()` (linha 4)
- **Body:** `{}` (vazio)
- **Resposta esperada (200):** Lista de ferramentas/tecnologias para filtro
- **Side effects:** Nenhum — metadados quasi-estáticos
- **Observações:** **SEM autenticação JWT** e **isento de rate-limit**.
- **Rate-limit:** Isento + sem auth

---

### 16. ecdt-historico-v2 — `pesquisa-new`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-historico-v2/pesquisa-new`
- **Arquivo de rota:** `src/index.js` (linha 36)
- **Controller / handler:** `src/controllers/pesquisaController.js` → `carregarPesquisasSalvas()` (linhas 29–37)
- **Query params:**
  - `size` (default 10)
  - `offset` (default 0)
  - `shared` (default false)
  - `dt_criacao_order` (default `"desc"`)
  - `txtSearch` (default `""`)
  - `tipoPesquisa` (opcional)
  - `periodo` (opcional — dias desde criação)
- **Body:** Nenhum
- **Resposta esperada (200):** Array de pesquisas salvas com `nomePesquisa`, `pesquisa_json`, `dataCriacao`, `searchId`, `email`, `total`
- **Side effects:** Nenhum — SELECT paginado com CTE + joins em `public.log_pesquisa`
- **Observações:** Requer que `id_usuario=37308` tenha pesquisas em `log_pesquisa` no banco de beta.
- **Rate-limit:** Nenhum

---

### 17. ecdt-historico-v2 — `history-new`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-historico-v2/history-new`
- **Arquivo de rota:** `src/index.js` (linha 51)
- **Controller / handler:** `src/controllers/historicoController.js` → `carregarPesquisaHistorico()` (linhas 4–15)
- **Query params:**
  - `size` (default 100)
  - `tipoPesquisa` (opcional — `"empresas"` ou `"pessoas"`)
- **Body:** Nenhum
- **SQL:**
  ```sql
  SELECT nm_pesquisa, pesquisa_json, dt_criacao, url_param, email, prompt, tipo_pesquisa
  FROM public.log_pesquisa
  WHERE deleted = false AND (nm_pesquisa IS NULL OR nm_pesquisa = '')
    AND id_usuario = $1 AND tipo_pesquisa IN (...)
  ORDER BY dt_criacao DESC LIMIT $2
  ```
- **Resposta esperada (200):** Array de até 100 entradas recentes do histórico
- **Side effects:** Nenhum — SELECT somente leitura
- **Rate-limit:** Nenhum

---

### 18. ecdt-busca — `searchAllSetorAmigavel`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchAllSetorAmigavel`
- **Controller / handler:** `src/controllers/setorAmigavelController.js` → `listarTodosSetoresAmigaveis()` (linha 4)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Lista completa de setores amigáveis
- **Side effects:** Nenhum — metadados quasi-estáticos
- **Rate-limit:** Sujeito

---

### 19. ecdt-busca — `searchFaixasPresumidas`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchFaixasPresumidas`
- **Controller / handler:** `src/controllers/faixasController.js` → `searchFaixasPresumidas()` (linha 4)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Faixas de faturamento presumido do Elasticsearch
- **Side effects:** Nenhum
- **Rate-limit:** Sujeito

---

### 20. ecdt-busca — `searchCompanies`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchCompanies`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `searchCompanies()` (linha 38)
- **Middleware:** `jwtTokenAuthAndInfoMiddleware` (consulta adicional ao Postgres para validar token)
- **Body mínimo:**
  ```json
  { "options_selected": {}, "size": 10, "from": 0 }
  ```
  Schema completo em `./openapi/ecdt-busca.yml`. Capturar exemplo real do tráfego do frontend.
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** Lista de empresas com dados enriquecidos e status de bloqueio
- **Side effects:** Consulta Postgres (CNPJs por data de ações, empresas desbloqueadas) + Elasticsearch. Sem gravação.
- **Observações:** Endpoint mais pesado — `jwtTokenAuthAndInfoMiddleware` faz query extra no Postgres. Over-fetch no Elastic para filtrar bloqueadas. Latência: 200–1500ms.
- **Rate-limit:** Sujeito

---

### 21. ecdt-busca — `cidadesFormatadas`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/cidadesFormatadas`
- **Controller / handler:** `src/controllers/cidadesController.js` → `cidadesFormatadas()` (linha 5)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Lista completa de cidades lida de `src/cache/cidadesFormatados.json`
- **Side effects:** Nenhum — arquivo JSON em disco (cache estático)
- **Observações:** Endpoint extremamente leve. **Isento de rate-limit.**
- **Rate-limit:** Isento

---

### 22. ecdt-busca — `searchCalcCompanies`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchCalcCompanies`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `searchCalcCompanies()` (linha 132)
- **Body mínimo:**
  ```json
  { "options_selected": {}, "size": 0 }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** Estatísticas agregadas com descrições NCM
- **Side effects:** Consulta Postgres (data de ações) + Elasticsearch (agregações). Sem gravação.
- **Rate-limit:** Sujeito

---

### 23. ecdt-historico-v2 — `salvar-pesquisa-recente`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-historico-v2/salvar-pesquisa-recente`
- **Arquivo de rota:** `src/index.js` (linha 49)
- **Controller / handler:** `src/controllers/historicoController.js` → `salvarPesquisaHistorico()` (linhas 17–24)
- **Body:**
  ```json
  {
    "pesquisa": { "options_selected": {} },
    "shared": false,
    "userPrompt": "",
    "tipoPesquisa": "empresas"
  }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** `{ "searchId": "<md5-hash>" }`
- **SQL:**
  ```sql
  INSERT INTO public.log_pesquisa
    (cd_cliente, id_usuario, nm_pesquisa, pesquisa_json, url_param, email, shared, prompt, tipo_pesquisa)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ```
- **Side effects:** **GRAVA em BD** — INSERT em `public.log_pesquisa`; url_param gerado como MD5(idUsuario + timestamp)
- **Observações:** ⚠️ Gera registros permanentes no banco de beta. Planejar limpeza pós-teste:
  `DELETE FROM log_pesquisa WHERE cd_cliente = 'TESTE-1-20260523'`
- **Rate-limit:** Nenhum

---

### 24. ecdt-historico-v2 — `get-pesquisa`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-historico-v2/get-pesquisa`
- **Arquivo de rota:** `src/index.js` (linha 46)
- **Controller / handler:** `src/controllers/pesquisaController.js` → `carregarPesquisa()` (linhas 4–18)
- **Body:**
  ```json
  { "urlParam": "abc123def456" }
  ```
- **SQL:**
  ```sql
  SELECT pesquisa_json, prompt, tipo_pesquisa
  FROM public.log_pesquisa
  WHERE url_param = $2 AND (id_usuario = $1 OR shared = 'true')
  ```
- **Resposta esperada (200):** Array com dados da pesquisa (tipicamente 1 registro)
- **Side effects:** Nenhum — SELECT somente leitura
- **Observações:** Requer `urlParam` válido no banco de beta. Pode usar IDs criados por `salvar-pesquisa-recente` durante o próprio teste.
- **Rate-limit:** Nenhum

---

### 25. ecdt-billing — `api/billing-v3/desbloquearEmpresas`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-billing/api/billing-v3/desbloquearEmpresas`
- **Controller / handler:** `src/controllers/desbloquearEmpresa.controller.js` → `desbloquear()` (linhas 10–64)
- **Body:**
  ```json
  {
    "cnpjs": ["<CNPJ_CRIPTOGRAFADO>"],
    "departamentos": [],
    "origem": "load-test",
    "quantidadePessoas": 0
  }
  ```
- **Headers além de Authorization:** `Content-Type: application/json`
- **Resposta esperada (200):** `{ "qtd_sucesso": 1, "qtd_falha": 0, "cnpjs_descriptografados": ["..."] }`
- **Side effects:**
  1. **DEBITA saldo** — INSERT em `billing.movimentos`
  2. **REGISTRA desbloqueio** — INSERT em `billing.desbloqueios`
  3. Atualiza Elasticsearch (async)
- **Observações:** Ver risco de race condition em §6.1. Não usar alta concorrência com o mesmo `cd_cliente`. Monitorar saldo antes/depois.
- **Rate-limit:** Nenhum

---

### 26. ecdt-busca — `searchCidades`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchCidades`
- **Controller / handler:** `src/controllers/cidadesController.js` → `searchCidades()` (linha 13)
- **Body mínimo:**
  ```json
  { "uf": "SP", "query": "São Paulo" }
  ```
- **Resposta esperada (200):** Lista de cidades que correspondem ao filtro
- **Side effects:** Nenhum. **Isento de rate-limit.**
- **Rate-limit:** Isento

---

### 27. ecdt-busca — `searchCnaesFilter`

- **Método HTTP:** GET
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchCnaesFilter`
- **Controller / handler:** `src/controllers/cnaesController.js` → `searchAllCnaesFilter()` (linha 31)
- **Query params:** Nenhum
- **Body:** Nenhum
- **Resposta esperada (200):** Todos os CNAEs para filtros de UI
- **Side effects:** Nenhum — metadados quasi-estáticos
- **Rate-limit:** Sujeito

---

### 28. ecdt-busca — `searchBairros`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchBairros`
- **Controller / handler:** `src/controllers/bairrosController.js` → `searchBairros()` (linha 5)
- **Body mínimo:**
  ```json
  { "municipio": "São Paulo", "uf": "SP", "query": "Pinheiros" }
  ```
- **Resposta esperada (200):** Lista de bairros correspondentes ao filtro
- **Side effects:** Nenhum. **Isento de rate-limit.**
- **Rate-limit:** Isento

---

### 29. ecdt-busca — `pesquisarCamposPorCnpj`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/pesquisarCamposPorCnpj`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `pesquisarCamposPorCnpj()` (linha 450)
- **Body:**
  ```json
  {
    "cnpjs": ["00000000000191"],
    "camposElastic": ["nm_empresa", "sg_uf", "cd_cnpj"]
  }
  ```
  `cnpjs` pode ser array direto ou string LZ-String comprimida.
- **Resposta esperada (200):** Array de objetos empresa com apenas os campos solicitados
- **Side effects:** Nenhum — busca Elasticsearch com projeção de campos
- **Rate-limit:** Sujeito

---

### 30. ecdt-billing — `api/billing/dados-dashboard`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-billing/api/billing/dados-dashboard`
- **Controller / handler:** `src/controllers/dashboard.controller.js` → `returnDadosDashboard()` (linhas 63–83)
- **Body:**
  ```json
  { "usuarios": ["tt@tt.com"], "cdCliente": "TESTE-1-20260523" }
  ```
- **Headers além de Authorization:** `Content-Type: application/json` (**SEM JWT — endpoint sem auth**)
- **Resposta esperada (200):** Métricas de dashboard por período (semanal/mensal/trimestral)
- **Side effects:** Chama `ecdt-busca/searchNomesByCnpjs` via HTTP interno. Sem gravação em BD.
- **Observações:** Endpoint sem autenticação. Heavy — múltiplas queries agregadas em paralelo.
- **Rate-limit:** Nenhum

---

### 31. ecdt-billing — `api/billing/dados-tabelas-dashboard`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-billing/api/billing/dados-tabelas-dashboard`
- **Controller / handler:** `src/controllers/dashboard.controller.js` → `returnDadosTabelasDashboard()` (linhas 5–14)
- **Body:**
  ```json
  { "usuarios": ["tt@tt.com"], "cdCliente": "TESTE-1-20260523" }
  ```
- **Headers além de Authorization:** `Content-Type: application/json` (**SEM JWT — endpoint sem auth**)
- **Resposta esperada (200):** Últimas empresas exportadas e visualizadas por período
- **Side effects:** Chama `ecdt-busca/searchNomesByCnpjs` via HTTP. Sem gravação.
- **Rate-limit:** Nenhum

---

### 32. ecdt-billing — `api/billing-v3/debitar`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-billing/api/billing-v3/debitar`
- **Controller / handler:** `src/controllers/extratoV3.controller.js` → `debitarSaldo()` (linhas 56–72)
- **Body:**
  ```json
  { "quantidade": 1, "tpCredito": "exportacao", "descricao": "load-test" }
  ```
  `tpCredito` ∈ `{ exportacao, geracao_email, validacao_telefone, desbloqueio_empresas }`
- **Resposta esperada (200):** `"1 de débito de exportacao adicionado ao cd cliente: TESTE-1-20260523"`
- **Side effects:** **GRAVA em BD** — INSERT em `billing.movimentos`
- **Observações:** Retorna 500 se saldo insuficiente. Monitorar saldo antes/depois.
- **Rate-limit:** Nenhum

---

### 33. ecdt-busca — `updateElasticIndexExp`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/updateElasticIndexExp`
- **Controller / handler:** `src/controllers/updateController.js` → `updateElasticIndexExp()` (linha 19)
- **Middleware:** `jwtTokenAuthAndInfoMiddleware`
- **Body:**
  ```json
  {
    "listCnpjs": "<LZ-String ou array de CNPJs>",
    "cdEvento": "<UUID do evento de exportação>",
    "api": false
  }
  ```
- **Resposta esperada (200):** `{ "busca_empresa": {...}, "evento_cliente": {...}, "mercado": {...} }`
- **Side effects:** **GRAVA no Elasticsearch** + **GRAVA no Postgres** (`updateEventoExportacao`)
- **Observações:** Requer `cdEvento` válido no banco de beta. **Isento de rate-limit.**
- **Rate-limit:** Isento

---

### 34. ecdt-busca — `searchCnpjsBloqueados`

- **Método HTTP:** POST
- **URL completa no gateway:** `https://betaplat.api.econodata.com.br/ecdt-busca/searchCnpjsBloqueados`
- **Controller / handler:** `src/controllers/searchCompaniesController.js` → `getCnpjsBloqueados()` (linha 586)
- **Body:**
  ```json
  { "cnpjs": ["00000000000191", "00000000000272"] }
  ```
- **Resposta esperada (200):** `{ "cnpjsBloqueados": ["00000000000272"] }`
- **Side effects:** Nenhum — SELECT Postgres + inversão em memória
- **Rate-limit:** Sujeito

---

## 7.1 Endpoints com gravação em BD — resumo

| Endpoint | Tabela(s) gravada(s) | Limpeza pós-teste |
|----------|----------------------|-------------------|
| `salvar-pesquisa-recente` | `public.log_pesquisa` | `DELETE FROM log_pesquisa WHERE cd_cliente = 'TESTE-1-20260523'` |
| `updateElasticIndexExp` | Elasticsearch + `log_exportacao` | Verificar impacto |
| `desbloquearEmpresas` | `billing.movimentos` + `billing.desbloqueios` + Elasticsearch | Monitorar saldo; sem rollback |
| `debitar` | `billing.movimentos` | Monitorar saldo |

**Pré-requisitos no banco de beta antes do teste:**
1. `id_usuario=37308` com registros em `log_pesquisa` (para `pesquisa-new`, `history-new`, `get-pesquisa`, `pega-prompts-pesquisas`)
2. Saldo positivo para `cd_cliente=TESTE-1-20260523` em `billing.movimentos`
3. Pelo menos um `cdEvento` válido para `updateElasticIndexExp`

---

## 8. Variáveis do experimento

| Parâmetro  | Descrição |
|------------|-----------|
| `N_USERS` | Usuários virtuais simultâneos |
| `RAMP_UP` | Tempo para atingir `N_USERS` (0s = burst, 60s = gradual) |
| `DURATION` | Duração total da fase de carga |
| `ENDPOINT_MIX` | Distribuição de peso da tabela §6 |
| `THINK_TIME` | Pausa entre requisições por VU |
| `SCENARIO` | Perfil de carga |

**Limites práticos por serviço:**

| Serviço | Gargalo | VUs recomendados (inicial) |
|---------|---------|---------------------------|
| ecdt-busca | Rate-limit 500 req/min com token único | ≤ 10 VUs |
| ecdt-admin-v2-back | Pool BD max 1 | ≤ 3 VUs |
| ecdt-billing | Pool BD max 10 | ≤ 10 VUs |
| ecdt-historico-v2 | Pool BD max 10 | ≤ 10 VUs |

Cenários previstos:
1. **Degrau ascendente** — força adição de nós
2. **Degrau descendente** — força remoção de nós
3. **Pico isolado** — testa reação a spike inesperado
4. **Carga constante** — baseline
5. **Onda senoidal** — simula sazonalidade

---

## 9. Métricas a coletar

### 9.1 Prometheus — ajustes necessários

O regex atual do job `kubernetes-pods-hml` não cobre os 4 serviços. Adicionar ao `prometheus.yml`:

```yaml
- job_name: kubernetes-pods-beta
  kubernetes_sd_configs:
    - role: pod
      namespaces: { names: [beta] }
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_label_app]
      regex: ecdt-busca|ecdt-admin-v2|ecdt-billing|ecdt-historico-v2
      action: keep
```

Verificar job equivalente a `gateway-prd` para o gateway de beta.

### 9.2 Métricas do simulador

- Latência por endpoint (p50/p95/p99)
- Taxa de erros (4xx/5xx) — atenção ao **HTTP 420** (rate-limit do ecdt-busca)
- Throughput realizado vs. alvo (req/s)
- Distribuição de tempos durante ramp-up

---

## 10. Riscos identificados

| # | Risco | Serviço | Impacto | Ação |
|---|-------|---------|---------|------|
| 1 | Pool BD `max: 1` | ecdt-admin-v2-back | Serialização em concorrência > 1 | Limitar VUs; intenção do teste |
| 2 | `desbloquearEmpresas` sem transação BD | ecdt-billing | Race condition → saldo negativo | Não usar mesmo `cd_cliente` em paralelo |
| 3 | `salvar-pesquisa-recente` grava sempre | ecdt-historico-v2 | Acúmulo de dados de teste | Limpar após cada bateria |
| 4 | JWT sem verificação de assinatura | ecdt-busca, ecdt-billing, ecdt-historico-v2 | Token aceito mesmo expirado | Irrelevante para o teste |
| 5 | Gateway bloqueia PUT/POST/PATCH para `/ecdt-admin-v2` | gateway | `tarja-notificacao` só testável como GET | Usar apenas GET; já incorporado |
| 6 | Rate-limit 500 req/min por token único | ecdt-busca | HTTP 420 em concorrência alta | Monitorar e ajustar `N_USERS` |
| 7 | `dados-dashboard` e `dados-tabelas-dashboard` sem auth | ecdt-billing | Exposição sem JWT — comportamento esperado | Sem ação necessária |

---

## 11. Próximos passos

1. ~~**v2 — preencher seções `[A PREENCHER]`**~~ ✅
2. ~~**v3 — calibrar §6 com dados reais (CSVs de utilização)**~~ ✅
3. **Pré-requisitos pré-execução** (ver `docs/03-execucao.md §2`):
   - Validar JWT no `ecdt-admin-v2-back` com `curl`
   - Validar endpoints novos: `info-token`, `tags`, `api/feedback`
   - Computar LZ-String de `cnpjsComprimidos` (CNPJ fixture)
   - Capturar `K6_CNPJ_CRIPTO` via DevTools
4. **Implementação k6** seguindo `docs/00-plano.md` — sequência determinística semeada com
   **dois profiles** (`dia-util` / `fim-semana`) e **23 endpoints** confirmados.
5. **Execução** (ver `docs/03-execucao.md §5`):
   - Sessão 1 — smoke + baseline (cenário A)
   - Sessão 2 — cenários B–G na config A do CANM
   - Sessão 3 — repetir com config B (dataset idêntico permite comparação direta)

---

## 12. Resumo executivo

Simular usuários acessando a plataforma Econodata de beta via gateway
`https://betaplat.api.econodata.com.br`, distribuindo requisições entre **23 endpoints**
proporcionalmente ao peso de cada um com base em dados reais de utilização
(`logs.utilizacao_ms_plataforma`, período 2026-05-01 a 2026-05-24).

Dois profiles distintos refletem o comportamento real:

| Profile | Req/dia média | Req/s 24h | Req/s horário comercial |
|---------|--------------:|----------:|------------------------:|
| **Dia útil** | 625.823 | 7,24 | ~11,6 |
| **Fim de semana** | 294.455 | 3,41 | ~5,5 |

Autenticação via JWT Bearer (token fixo, §3.1). Backends em Node.js/Express
distribuídos por 7 microsserviços (incluindo 3 novos: `ecdt-api`, `ecdt-tags`,
`ecdt-crowdsourcing`). Cluster GKE observado pelo Prometheus do CANM.

A sequência de endpoints é determinística (semeada com `42`) para garantir que
diferentes configurações do cluster CANM sejam comparadas com o mesmo input.

Detalhamento operacional em `docs/00-plano.md`, `docs/01-endpoints-config.md`,
`docs/02-cenarios-config.md`, `docs/03-execucao.md`. Cenários reais de dia útil e
fim de semana em `docs/04-cenario-econodata.md`.
