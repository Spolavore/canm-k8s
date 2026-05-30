# Endpoints — Configuração k6

> Cada bloco abaixo é o código JS pronto para o arquivo `src/endpoints/<serviço>.js`.
> Base URL e headers vêm de `src/lib/auth.js`.
> **Todos os payloads são fixos** — nenhum dado aleatório para garantir reprodutibilidade entre runs.
> **Fonte de pesos:** `k6/data/endpoits_mais_utilizados_mes*.csv` (período 2026-05-01 a 2026-05-24).

---

## Volumetria real (referência)

Dados extraídos de `logs.utilizacao_ms_plataforma` (ver `k6/data/queries.txt`).

| Métrica | Dia útil | Fim de semana |
|---------|----------|---------------|
| Dias no período | 16 | 8 |
| Req agregadas (sem `superlogica-data`) | 10.013.175 | 2.355.636 |
| Req/dia médias | 625.823 | 294.455 |
| Req/s médio 24h | **7,24 req/s** | **3,41 req/s** |
| Req/s estimado horário comercial (8h–20h, 80% do tráfego) | **~11,6 req/s** | **~5,5 req/s** |
| Endpoints únicos | 23 | 23 |

**Observação fim de semana:** volume cai ~53% mas a distribuição muda — `searchBairros`
sobe de 0,47% para 1,46% (3,1×), enquanto `info-token` cai um pouco. Justifica
ter cenários separados em vez de média ponderada.

---

## Endpoints incluídos (23 únicos)

| # | Serviço | Endpoint | Peso dia útil | Peso fim de semana |
|---|---------|----------|--------------:|-------------------:|
| 1 | ecdt-historico-v2 | `obter-nota-qualificacao` | 43,30% | 41,02% |
| 2 | ecdt-admin-v2 | `tarja-notificacao` | 7,25% | 8,02% |
| 3 | ecdt-billing | `api/billing-v3/saldo` | 6,51% | 6,42% |
| 4 | ecdt-busca | `searchFiliais` | 6,12% | 6,49% |
| 5 | ecdt-crowdsourcing | `api/feedback` | 3,71% | 3,80% |
| 6 | ecdt-api | `info-token` | 3,35% | 3,13% |
| 7 | ecdt-busca | `checkSessao` | 3,28% | 3,55% |
| 8 | ecdt-tags | `tags` | 3,22% | 3,19% |
| 9 | ecdt-busca | `searchDadosDetalheEmpresa` | 3,13% | 3,25% |
| 10 | ecdt-busca | `obterGrupoEconomico` | 3,05% | 3,14% |
| 11 | ecdt-busca | `searchEventoCliente` | 2,91% | 3,02% |
| 12 | ecdt-busca | `searchEmailsBuscados` | 2,90% | 2,99% |
| 13 | ecdt-busca | `searchFiltroDecisores` | 2,64% | 2,14% |
| 14 | ecdt-busca | `quickSearch` | 2,09% | 2,34% |
| 15 | ecdt-busca | `searchDadosMapping` | 1,75% | 1,68% |
| 16 | ecdt-busca | `searchCompanies` | 1,06% | 1,01% |
| 17 | ecdt-historico-v2 | `pega-prompts-pesquisas` | 0,73% | 0,65% |
| 18 | ecdt-billing | `api/billing-v3/desbloquearEmpresas` | 0,56% | 0,73% |
| 19 | ecdt-busca | `obterOrganograma` | 0,54% | 0,49% |
| 20 | ecdt-busca | `pesquisarCamposPorCnpj` | 0,53% | 0,51% |
| 21 | ecdt-busca | `searchCnpjsBloqueados` | 0,47% | 0,48% |
| 22 | ecdt-busca | `searchBairros` | 0,47% | 1,46% |
| 23 | ecdt-historico-v2 | `salvar-pesquisa-recente` | 0,43% | 0,46% |

**Distribuição por serviço (dia útil):**
- ecdt-historico-v2: 44,46%
- ecdt-busca: 30,94%
- ecdt-admin-v2: 7,25%
- ecdt-billing: 7,07%
- ecdt-crowdsourcing: 3,71%
- ecdt-api: 3,35%
- ecdt-tags: 3,22%

---

## Endpoints excluídos do escopo

| Endpoint | Motivo |
|----------|--------|
| `ecdt-billing/api/superlogica-data` | Chama API externa Superlogica |
| `ecdt-busca/updateElasticIndexExp` | Removido pelo usuário (depende de `cdEvento` UUID gerenciado internamente) |

**Endpoints da especificação original que NÃO aparecem no top 25 real** (volume baixo, fora dos testes):
`searchFerramentasTecnologias`, `searchAllSetorAmigavel`, `searchFaixasPresumidas`,
`cidadesFormatadas`, `searchCalcCompanies`, `pesquisa-new`, `history-new`, `get-pesquisa`,
`searchCidades`, `searchCnaesFilter`, `dados-dashboard`, `dados-tabelas-dashboard`,
`api/billing-v3/debitar`.

---

## `src/lib/auth.js`

```javascript
export const BASE_URL = 'https://betaplat.api.econodata.com.br';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjZF9jbGllbnRlIjoiVEVTVEUtMS0yMDI2MDUyMyIsImlkX3VzdWFyaW8iOjM3MzA4LCJ1c2VyX25hbWUiOiJ0dEB0dC5jb20iLCJzY29wZSI6WyJvcGVuaWQiXSwiZXhwIjoxNzgwMTcxMzQzLCJhdXRob3JpdGllcyI6WyJST0xFX1VTRVIiXSwianRpIjoiZTc3YjBhM2MtMDM2OS00OWIxLTg5YTEtNmU4ZjRiMTcwZmM2IiwiY2xpZW50X2lkIjoiM2FhOThmYjliYTA1MDI0NzA1YTY0MDRmNmFkZDBhODAiLCJmbGdfYXRpdm8iOnRydWUsImZsZ19wbGFub19hdGl2byI6dHJ1ZX0.m5QeBfWbPQklvW52GCYFbefznSczSGPpKAZIl_TdScI';

export const AUTH_HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

export const NO_AUTH_HEADERS = {
  'Content-Type': 'application/json',
};

// Parâmetros aplicados a TODAS as requisições.
// Timeout 120s cobre cold-start de pods sob escalonamento.
// Gateway tem timeout próprio de 600s — não vale ir acima de 120s no client.
export const COMMON_PARAMS = {
  headers: AUTH_HEADERS,
  timeout: '120s',
};

export const COMMON_PARAMS_NO_AUTH = {
  headers: NO_AUTH_HEADERS,
  timeout: '120s',
};
```

---

## `src/lib/sequence.js`

> Gera **duas** sequências determinísticas (dia útil e fim de semana), cada uma com pesos próprios.
> A mesma semente sempre produz a mesma ordem — essencial para comparar configurações do cluster.
> O cenário escolhe qual sequência usar via `K6_TRAFFIC_PROFILE`.

```javascript
import { SharedArray } from 'k6/data';

// Fisher-Yates com LCG determinístico — sem Math.random()
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((s / 4294967296) * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function buildRaw(endpoints, total) {
  const raw = [];
  for (const ep of endpoints) {
    const count = Math.round((ep.weight / 100) * total);
    for (let i = 0; i < count; i++) raw.push(ep.name);
  }
  return raw;
}

// Pesos extraídos de k6/data/endpoits_mais_utilizados_mes_dias_semana.csv
const ENDPOINT_LIST_DIA_UTIL = [
  { name: 'obterNotaQualificacao',     weight: 43.30 },
  { name: 'tarjaNotificacao',          weight:  7.25 },
  { name: 'billingV3Saldo',            weight:  6.51 },
  { name: 'searchFiliais',             weight:  6.12 },
  { name: 'apiFeedback',               weight:  3.71 },
  { name: 'infoToken',                 weight:  3.35 },
  { name: 'checkSessao',               weight:  3.28 },
  { name: 'tags',                      weight:  3.22 },
  { name: 'searchDadosDetalheEmpresa', weight:  3.13 },
  { name: 'obterGrupoEconomico',       weight:  3.05 },
  { name: 'searchEventoCliente',       weight:  2.91 },
  { name: 'searchEmailsBuscados',      weight:  2.90 },
  { name: 'searchFiltroDecisores',     weight:  2.64 },
  { name: 'quickSearch',               weight:  2.09 },
  { name: 'searchDadosMapping',        weight:  1.75 },
  { name: 'searchCompanies',           weight:  1.06 },
  { name: 'pegaPromptsPesquisas',      weight:  0.73 },
  { name: 'desbloquearEmpresas',       weight:  0.56 },
  { name: 'obterOrganograma',          weight:  0.54 },
  { name: 'pesquisarCamposPorCnpj',    weight:  0.53 },
  { name: 'searchCnpjsBloqueados',     weight:  0.47 },
  { name: 'searchBairros',             weight:  0.47 },
  { name: 'salvarPesquisaRecente',     weight:  0.43 },
];

// Pesos extraídos de k6/data/endpoits_mais_utilizados_mes_fins_de_semana.csv
const ENDPOINT_LIST_FIM_SEMANA = [
  { name: 'obterNotaQualificacao',     weight: 41.02 },
  { name: 'tarjaNotificacao',          weight:  8.02 },
  { name: 'searchFiliais',             weight:  6.49 },
  { name: 'billingV3Saldo',            weight:  6.42 },
  { name: 'apiFeedback',               weight:  3.80 },
  { name: 'checkSessao',               weight:  3.55 },
  { name: 'searchDadosDetalheEmpresa', weight:  3.25 },
  { name: 'tags',                      weight:  3.19 },
  { name: 'obterGrupoEconomico',       weight:  3.14 },
  { name: 'infoToken',                 weight:  3.13 },
  { name: 'searchEventoCliente',       weight:  3.02 },
  { name: 'searchEmailsBuscados',      weight:  2.99 },
  { name: 'quickSearch',               weight:  2.34 },
  { name: 'searchFiltroDecisores',     weight:  2.14 },
  { name: 'searchDadosMapping',        weight:  1.68 },
  { name: 'searchBairros',             weight:  1.46 },
  { name: 'searchCompanies',           weight:  1.01 },
  { name: 'desbloquearEmpresas',       weight:  0.73 },
  { name: 'pegaPromptsPesquisas',      weight:  0.65 },
  { name: 'pesquisarCamposPorCnpj',    weight:  0.51 },
  { name: 'obterOrganograma',          weight:  0.49 },
  { name: 'searchCnpjsBloqueados',     weight:  0.48 },
  { name: 'salvarPesquisaRecente',     weight:  0.46 },
];

const PROFILE = (__ENV.K6_TRAFFIC_PROFILE || 'dia-util').toLowerCase();
const ACTIVE_LIST = PROFILE === 'fim-semana' ? ENDPOINT_LIST_FIM_SEMANA : ENDPOINT_LIST_DIA_UTIL;

// SharedArray: construído uma vez no init, compartilhado entre todos os VUs (imutável)
export const SEQUENCE = new SharedArray(`endpoint-sequence-${PROFILE}`, function () {
  return seededShuffle(buildRaw(ACTIVE_LIST, 10000), 42);
});
```

---

## `src/endpoints/busca.js`

> 14 endpoints — ecdt-busca
> Fixture CNPJ único: `"33000167000101"` (Petrobrás)

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS, COMMON_PARAMS_NO_AUTH } from '../lib/auth.js';

const CNPJ = '33000167000101';

// LZ-String pré-computada para cnpjsComprimidos (CNPJ fixture acima).
// Gerado com: node -e "const L=require('lz-string'); process.stdout.write(L.compress('33000167000101'))"
// O servidor faz LZString.decompress(...) — saída de `compress` é UTF-16 puro
// (frontend usa exatamente o mesmo: src/services/EmpresaService.js → `LZString.compress(empresa.cnpj)`).
const CNPJS_LZ = '㌰ೡ᠍臙퐠ꀀ';

export function checkSessao() {
  const res = http.get(`${BASE_URL}/ecdt-busca/checkSessao`, COMMON_PARAMS);
  check(res, { 'checkSessao 200': (r) => r.status === 200 });
}

export function searchDadosMapping() {
  const res = http.get(`${BASE_URL}/ecdt-busca/searchDadosMapping`, COMMON_PARAMS);
  check(res, { 'searchDadosMapping 200': (r) => r.status === 200 });
}

export function searchFiltroDecisores() {
  const res = http.get(`${BASE_URL}/ecdt-busca/searchFiltroDecisores`, COMMON_PARAMS);
  check(res, { 'searchFiltroDecisores 200': (r) => r.status === 200 });
}

// Bypass auth no gateway; serviço aplica jwt internamente
export function searchFiliais() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchFiliais`,
    JSON.stringify({ cnpj: CNPJ }), COMMON_PARAMS);
  check(res, { 'searchFiliais 200': (r) => r.status === 200 });
}

export function searchDadosDetalheEmpresa() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchDadosDetalheEmpresa`,
    JSON.stringify({ listCnpjs: [CNPJ] }), COMMON_PARAMS);
  check(res, { 'searchDadosDetalheEmpresa 200': (r) => r.status === 200 });
}

export function searchEventoCliente() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchEventoCliente`,
    JSON.stringify({ cnpj: CNPJ }), COMMON_PARAMS);
  check(res, { 'searchEventoCliente 200': (r) => r.status === 200 });
}

export function obterGrupoEconomico() {
  const res = http.get(`${BASE_URL}/ecdt-busca/obterGrupoEconomico?cnpj=${CNPJ}`, COMMON_PARAMS);
  check(res, { 'obterGrupoEconomico 200': (r) => r.status === 200 });
}

// Sem autenticação JWT + isento de rate-limit
export function searchEmailsBuscados() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchEmailsBuscados`,
    JSON.stringify({
      cdCliente: 'TESTE-1-20260523',
      cnpjsComprimidos: CNPJS_LZ,
      bloqueada: false,
      dominiosEmpresa: [],
    }), COMMON_PARAMS_NO_AUTH);
  check(res, { 'searchEmailsBuscados 200': (r) => r.status === 200 });
}

export function quickSearch() {
  const res = http.post(`${BASE_URL}/ecdt-busca/quickSearch`,
    JSON.stringify({ cnpj: 'econodata', ufs: ['SP'], size: 10 }), COMMON_PARAMS);
  check(res, { 'quickSearch 200': (r) => r.status === 200 });
}

export function obterOrganograma() {
  const res = http.get(`${BASE_URL}/ecdt-busca/obterOrganograma?cnpj=${CNPJ}`, COMMON_PARAMS);
  check(res, { 'obterOrganograma 200': (r) => r.status === 200 });
}

// Endpoint mais pesado — jwtTokenAuthAndInfoMiddleware faz query extra no Postgres
export function searchCompanies() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchCompanies`,
    JSON.stringify({ options_selected: {}, size: 10, from: 0 }), COMMON_PARAMS);
  check(res, { 'searchCompanies 200': (r) => r.status === 200 });
}

// Isento de rate-limit
export function searchBairros() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchBairros`,
    JSON.stringify({ municipio: 'São Paulo', uf: 'SP', query: 'Pinheiros' }), COMMON_PARAMS);
  check(res, { 'searchBairros 200': (r) => r.status === 200 });
}

export function pesquisarCamposPorCnpj() {
  const res = http.post(`${BASE_URL}/ecdt-busca/pesquisarCamposPorCnpj`,
    JSON.stringify({ cnpjs: [CNPJ], camposElastic: ['nm_empresa', 'sg_uf', 'cd_cnpj'] }),
    COMMON_PARAMS);
  check(res, { 'pesquisarCamposPorCnpj 200': (r) => r.status === 200 });
}

export function searchCnpjsBloqueados() {
  const res = http.post(`${BASE_URL}/ecdt-busca/searchCnpjsBloqueados`,
    JSON.stringify({ cnpjs: [CNPJ, '00000000000272'] }), COMMON_PARAMS);
  check(res, { 'searchCnpjsBloqueados 200': (r) => r.status === 200 });
}
```

---

## `src/endpoints/historico.js`

> 3 endpoints — ecdt-historico-v2. Pool BD max:10. Sem rate-limit.
> **`obter-nota-qualificacao` é o endpoint dominante** (~43% do volume total).

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS } from '../lib/auth.js';

const CNPJ = '33000167000101';

export function obterNotaQualificacao() {
  const res = http.post(`${BASE_URL}/ecdt-historico-v2/obter-nota-qualificacao`,
    JSON.stringify({ cnpj: CNPJ }), COMMON_PARAMS);
  check(res, { 'obterNotaQualificacao 200': (r) => r.status === 200 });
}

export function pegaPromptsPesquisas() {
  const res = http.get(`${BASE_URL}/ecdt-historico-v2/pega-prompts-pesquisas`, COMMON_PARAMS);
  check(res, { 'pegaPromptsPesquisas 200': (r) => r.status === 200 });
}

// GRAVA em BD — limpar após o teste (ver 03-execucao.md §3)
export function salvarPesquisaRecente() {
  const res = http.post(`${BASE_URL}/ecdt-historico-v2/salvar-pesquisa-recente`,
    JSON.stringify({
      pesquisa: { options_selected: {} },
      shared: false,
      userPrompt: '',
      tipoPesquisa: 'empresas',
    }), COMMON_PARAMS);
  check(res, { 'salvarPesquisaRecente 200': (r) => r.status === 200 });
}
```

---

## `src/endpoints/billing.js`

> 2 endpoints — ecdt-billing. Pool BD max:10. Sem rate-limit.
> Conta com créditos ilimitados — sem risco de esgotar saldo.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS } from '../lib/auth.js';

// CNPJ criptografado fixo (fornecido pelo usuário) — não muda entre execuções
const CNPJ_CRIPTO = '6084160a58feb6f4ff21682505bb979974b6e7b27359e86f919c7dd083e66cb3';

export function billingV3Saldo() {
  const res = http.get(`${BASE_URL}/ecdt-billing/api/billing-v3/saldo`, COMMON_PARAMS);
  check(res, { 'billingV3Saldo 200': (r) => r.status === 200 });
}

// GRAVA BD — debita saldo (conta com créditos ilimitados)
export function desbloquearEmpresas() {
  const res = http.post(`${BASE_URL}/ecdt-billing/api/billing-v3/desbloquearEmpresas`,
    JSON.stringify({
      cnpjs: [CNPJ_CRIPTO],
      departamentos: [],
      origem: 'load-test',
      quantidadePessoas: 0,
    }), COMMON_PARAMS);
  check(res, { 'desbloquearEmpresas 200': (r) => r.status === 200 });
}
```

---

## `src/endpoints/admin.js`

> 1 endpoint — ecdt-admin-v2-back. Pool BD max:1. Sem rate-limit.
> Auth com `jwt.verify()` — validar token antes da primeira execução.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS } from '../lib/auth.js';

// GET only — PUT bloqueado pelo gateway em beta
// Pool BD max:1: alta concorrência serializa queries — comportamento esperado e observável
export function tarjaNotificacao() {
  const res = http.get(`${BASE_URL}/ecdt-admin-v2/tarja-notificacao`, COMMON_PARAMS);
  check(res, { 'tarjaNotificacao 200': (r) => r.status === 200 });
}
```

---

## `src/endpoints/api.js` *(NOVO)*

> 1 endpoint — `ecdt-api` (repositório não está em `/home/spola/plataforma-repositories` — mapeado pelo gateway: `routes-beta.json` → `10.93.9.41:9970`).
> Uso real: `WebhookButtons.vue` lista integrações/webhooks da empresa. GET sem payload.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS } from '../lib/auth.js';

// GET — retorna lista de webhooks/integrações do cliente
export function infoToken() {
  const res = http.get(`${BASE_URL}/ecdt-api/info-token`, COMMON_PARAMS);
  check(res, { 'infoToken 200': (r) => r.status === 200 });
}
```

---

## `src/endpoints/tags.js` *(NOVO)*

> 1 endpoint — `ecdt-tags` (`/home/spola/plataforma-repositories/ecdt-tags/server.js`).
> GET `/tags`: retorna todas as tags do `cd_cliente` (extraído via `jwt.decode()` do header).
> SQL: `retornaTagsExcluindoSinalizacoesAssincronas(cd_cliente)` — somente leitura.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS } from '../lib/auth.js';

// GET — listagem de tags do cliente. Leitura simples no Postgres.
export function tags() {
  const res = http.get(`${BASE_URL}/ecdt-tags/tags`, COMMON_PARAMS);
  check(res, { 'tags 200': (r) => r.status === 200 });
}
```

---

## `src/endpoints/crowdsourcing.js` *(NOVO)*

> 1 endpoint — `ecdt-crowdsourcing` (repositório não está em `/home/spola/plataforma-repositories` — gateway: `10.93.9.61:9980`).
> Uso real: avaliação de dados de empresas (like/dislike em campos do perfil).
> Método: **PUT**. Side effects: nenhum impacto observado (confirmado pelo usuário).
> Payload abaixo é o capturado em produção (campo `sobre_empresa`, avaliação `"Like"`).

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COMMON_PARAMS } from '../lib/auth.js';

const SOBRE_EMPRESA = 'Empresa de Transporte Coletivo Viamão Ltda. foi fundada em 11 de julho de 1953, no município de Viamão (RS).  A empresa atua no setor de transporte coletivo de passageiros, oferecendo serviços nas cidades de Viamão, Porto Alegre e Alvorada.  Inicialmente com apenas três veículos, a empresa cresceu ao longo dos anos por meio de fusões com outras companhias do ramo.  Seu público-alvo são os moradores e usuários que necessitam de transporte público nas regiões atendidas.A empresa fornece serviços de transporte metropolitano (executivo, seletivo e convencional) e municipal (urbano e rural, este último operado pela Vialeste Transportes Ltda).  A frota é composta por aproximadamente 292 ônibus que operam em mais de 250 linhas.  A empresa busca oferecer diversos itinerários e tipos de serviços, priorizando a qualidade e satisfação dos seus usuários.';

// PUT — avaliação Like no campo sobre_empresa
export function apiFeedback() {
  const res = http.put(`${BASE_URL}/ecdt-crowdsourcing/api/feedback`,
    JSON.stringify({
      cnpj: '98.748.809/0001-09',
      nome_campo: 'sobre_empresa',
      valor_atual: SOBRE_EMPRESA,
      novo_valor: SOBRE_EMPRESA,
      avaliacao: 'Like',
      tipo: 'avaliacao',
    }), COMMON_PARAMS);
  check(res, { 'apiFeedback ok': (r) => r.status === 200 || r.status === 204 });
}
```

---

## `src/endpoints-map.js`

> Mapeia nome (string da sequência) → função. Usado pelo `load-test.js`.

```javascript
import * as busca from './endpoints/busca.js';
import * as historico from './endpoints/historico.js';
import * as billing from './endpoints/billing.js';
import * as admin from './endpoints/admin.js';
import * as api from './endpoints/api.js';
import * as tags from './endpoints/tags.js';
import * as crowdsourcing from './endpoints/crowdsourcing.js';

export const ENDPOINT_FN = {
  // ecdt-busca
  checkSessao:               busca.checkSessao,
  searchDadosMapping:        busca.searchDadosMapping,
  searchFiltroDecisores:     busca.searchFiltroDecisores,
  searchFiliais:             busca.searchFiliais,
  searchDadosDetalheEmpresa: busca.searchDadosDetalheEmpresa,
  searchEventoCliente:       busca.searchEventoCliente,
  obterGrupoEconomico:       busca.obterGrupoEconomico,
  searchEmailsBuscados:      busca.searchEmailsBuscados,
  quickSearch:               busca.quickSearch,
  obterOrganograma:          busca.obterOrganograma,
  searchCompanies:           busca.searchCompanies,
  searchBairros:             busca.searchBairros,
  pesquisarCamposPorCnpj:    busca.pesquisarCamposPorCnpj,
  searchCnpjsBloqueados:     busca.searchCnpjsBloqueados,

  // ecdt-historico-v2
  obterNotaQualificacao:     historico.obterNotaQualificacao,
  pegaPromptsPesquisas:      historico.pegaPromptsPesquisas,
  salvarPesquisaRecente:     historico.salvarPesquisaRecente,

  // ecdt-billing
  billingV3Saldo:            billing.billingV3Saldo,
  desbloquearEmpresas:       billing.desbloquearEmpresas,

  // ecdt-admin-v2
  tarjaNotificacao:          admin.tarjaNotificacao,

  // ecdt-api
  infoToken:                 api.infoToken,

  // ecdt-tags
  tags:                      tags.tags,

  // ecdt-crowdsourcing
  apiFeedback:               crowdsourcing.apiFeedback,
};
```

---

## Snippet de `src/load-test.js` (função default)

```javascript
import { sleep } from 'k6';
import exec from 'k6/execution';
import { SEQUENCE } from './lib/sequence.js';
import { ENDPOINT_FN } from './endpoints-map.js';

export default function () {
  // Índice GLOBAL da iteração no cenário (não por VU).
  // Garante a propriedade de subconjunto: um cenário com N iterações
  // cobre exatamente os índices 0..N-1 da SEQUENCE. Um cenário com M > N
  // iterações inclui as N primeiras requisições do cenário menor — mesmas
  // requisições, mesma ordem.
  const idx = exec.scenario.iterationInTest;
  const name = SEQUENCE[idx % SEQUENCE.length];
  ENDPOINT_FN[name]();
  sleep(parseFloat(__ENV.K6_THINK_TIME || '1.0'));
}
```

> **Atenção:** se um cenário ultrapassar 10.000 iterações totais, a sequência reinicia
> (`idx % SEQUENCE.length`). Para cenários longos, aumentar o tamanho do `buildRaw` no
> `sequence.js` (ex: `buildRaw(ACTIVE_LIST, 100000)`) para garantir cobertura sem ciclo.
