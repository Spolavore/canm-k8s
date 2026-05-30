# Execução e Limpeza — k6 CANM

---

## §1 — Comandos de execução por cenário

### Instalação do k6
```bash
# Ubuntu/Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
k6 version
```

### Variáveis comuns
| Variável | Descrição | Default |
|----------|-----------|---------|
| `K6_TRAFFIC_PROFILE` | `dia-util` ou `fim-semana` | `dia-util` |
| `K6_VUS` | VUs simultâneos (override do cenário) | varia por cenário |
| `K6_DURATION` | Duração override | varia por cenário |
| `K6_THINK_TIME` | Sleep entre iterações por VU (s) | `1.0` |

> Todos os valores específicos do ambiente (CNPJ criptografado, LZ-String de `cnpjsComprimidos`,
> token JWT) estão **hardcoded** no código — não precisam ser passados via env.

### Cenário A — Baseline (rodar primeiro — smoke test)
```bash
cd testes-plat
k6 run k6/src/scenarios/constant.js \
  -e K6_TRAFFIC_PROFILE=dia-util \
  -e K6_VUS=3 -e K6_DURATION=2m
```

### Cenário A — Baseline longo (dia útil)
```bash
k6 run k6/src/scenarios/constant.js \
  -e K6_TRAFFIC_PROFILE=dia-util \
  -e K6_VUS=9 -e K6_DURATION=10m
```

### Cenário A — Baseline longo (fim de semana)
```bash
k6 run k6/src/scenarios/constant.js \
  -e K6_TRAFFIC_PROFILE=fim-semana \
  -e K6_VUS=4 -e K6_DURATION=10m
```

### Cenário B — Degrau ascendente (dia útil)
```bash
k6 run k6/src/scenarios/step-up.js -e K6_TRAFFIC_PROFILE=dia-util
```

### Cenário C — Degrau descendente
```bash
# Rodar logo após o step-up enquanto o cluster ainda tem nós extras
k6 run k6/src/scenarios/step-down.js -e K6_TRAFFIC_PROFILE=dia-util
```

### Cenário D — Spike
```bash
k6 run k6/src/scenarios/spike.js -e K6_TRAFFIC_PROFILE=dia-util
```

### Cenário E — Onda senoidal
```bash
k6 run k6/src/scenarios/sine-wave.js -e K6_TRAFFIC_PROFILE=dia-util
```

### Cenário F — Econodata dia útil real
```bash
k6 run k6/src/scenarios/econodata-dia-util.js -e K6_TRAFFIC_PROFILE=dia-util
```

### Cenário G — Econodata fim de semana real
```bash
k6 run k6/src/scenarios/econodata-fim-semana.js -e K6_TRAFFIC_PROFILE=fim-semana
```

### Salvar saída em CSV (recomendado — granular por requisição, fácil de plotar)
```bash
mkdir -p k6/results
k6 run k6/src/scenarios/constant.js \
  -e K6_TRAFFIC_PROFILE=dia-util \
  -e K6_VUS=9 -e K6_DURATION=10m \
  --out csv=k6/results/$(date +%Y%m%d-%H%M)-A-dia-util-config-X.csv
```

Cada linha do CSV é um evento de métrica. Colunas relevantes para o gráfico de
tempo de requisição ao longo do tempo: `metric_name`, `timestamp`, `metric_value`,
`name` (nome do endpoint), `status`, `vu`, `iter`. Filtrar por
`metric_name=http_req_duration` para obter latência (em ms) de cada request.

> **Convenção de nomeação:** `<timestamp>-<cenário A–G>-<profile>-<config-do-cluster>.csv`
> facilita correlacionar resultados ao comparar configurações do CANM.

---

## §2 — Validação dos endpoints antes da primeira execução

> Roda uma vez, antes da primeira bateria. Garante que token, payload e auth funcionam.

```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjZF9jbGllbnRlIjoiVEVTVEUtMS0yMDI2MDUyMyIsImlkX3VzdWFyaW8iOjM3MzA4LCJ1c2VyX25hbWUiOiJ0dEB0dC5jb20iLCJzY29wZSI6WyJvcGVuaWQiXSwiZXhwIjoxNzgwMTcxMzQzLCJhdXRob3JpdGllcyI6WyJST0xFX1VTRVIiXSwianRpIjoiZTc3YjBhM2MtMDM2OS00OWIxLTg5YTEtNmU4ZjRiMTcwZmM2IiwiY2xpZW50X2lkIjoiM2FhOThmYjliYTA1MDI0NzA1YTY0MDRmNmFkZDBhODAiLCJmbGdfYXRpdm8iOnRydWUsImZsZ19wbGFub19hdGl2byI6dHJ1ZX0.m5QeBfWbPQklvW52GCYFbefznSczSGPpKAZIl_TdScI"

BASE="https://betaplat.api.econodata.com.br"

# 1) Smoke: 4 endpoints básicos
curl -s -o /dev/null -w "checkSessao: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" "$BASE/ecdt-busca/checkSessao"

curl -s -o /dev/null -w "tarja-notificacao: %{http_code} (valida jwt.verify)\n" \
  -H "Authorization: Bearer $TOKEN" "$BASE/ecdt-admin-v2/tarja-notificacao"

curl -s -o /dev/null -w "info-token: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" "$BASE/ecdt-api/info-token"

curl -s -o /dev/null -w "tags: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" "$BASE/ecdt-tags/tags"

# 2) feedback (PUT — payload real)
curl -s -o /dev/null -w "feedback: %{http_code}\n" \
  -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cnpj":"98.748.809/0001-09","nome_campo":"sobre_empresa","valor_atual":"smoke-test","novo_valor":"smoke-test","avaliacao":"Like","tipo":"avaliacao"}' \
  "$BASE/ecdt-crowdsourcing/api/feedback"

# 3) desbloquearEmpresas (POST — usa o CNPJ_CRIPTO já hardcoded em billing.js)
curl -s -o /dev/null -w "desbloquearEmpresas: %{http_code}\n" \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cnpjs":["6084160a58feb6f4ff21682505bb979974b6e7b27359e86f919c7dd083e66cb3"],"departamentos":[],"origem":"load-test","quantidadePessoas":0}' \
  "$BASE/ecdt-billing/api/billing-v3/desbloquearEmpresas"
```
Esperado: todos `200`. Se algum falhar, investigar antes de rodar k6.

---

## §3 — Limpeza pós-teste

Executar após **cada bateria** para manter o banco limpo entre comparações de configuração:

```sql
-- Remove apenas os registros gerados pelo teste (salvar-pesquisa-recente)
DELETE FROM public.log_pesquisa
WHERE cd_cliente = 'TESTE-1-20260523'
  AND nm_pesquisa IS NULL
  AND prompt IS NULL;

-- Confirmar quantidade total restante
SELECT count(*) FROM public.log_pesquisa
WHERE cd_cliente = 'TESTE-1-20260523';
```

> Não é necessário rollback de `billing.movimentos` ou `billing.desbloqueios` —
> conta tem créditos ilimitados e os registros não interferem em testes posteriores.

---

## §4 — Checklist pré-execução (copiar a cada bateria)

```
[ ] Token válido — exp: 1780171343 (~2026-06-26)
[ ] curl §2 — todos os 6 endpoints validados retornaram 200
[ ] K6_TRAFFIC_PROFILE escolhido (dia-util ou fim-semana)
[ ] Limpeza da bateria anterior executada (§3)
[ ] k6 version retorna v0.5x.x
[ ] mkdir -p k6/results
```

---

## §5 — Matriz recomendada de execuções

Cada cenário deve ser executado para cada **configuração do CANM** que se quer comparar.
Use sempre o mesmo `K6_TRAFFIC_PROFILE`, `K6_VUS`, `K6_DURATION` entre baterias da mesma comparação.

### Sessão 1 — Validação do setup
| # | Cenário | Profile | VUs | Duração | Objetivo |
|---|---------|---------|-----|---------|----------|
| 1 | A — Constant | dia-util | 3 | 2m | Smoke test |
| 2 | A — Constant | dia-util | 9 | 10m | Baseline dia útil — config A |
| 3 | A — Constant | fim-semana | 4 | 10m | Baseline fim de semana — config A |

### Sessão 2 — Experimentos CANM (config A)
| # | Cenário | Profile | Objetivo |
|---|---------|---------|----------|
| 4 | B — Step-up | dia-util | Observar scale-out |
| 5 | C — Step-down | dia-util | Observar scale-in (rodar logo após 4) |
| 6 | D — Spike | dia-util | Reação a burst |
| 7 | F — Econodata dia útil | dia-util | Padrão real de produção |
| 8 | G — Econodata fim de semana | fim-semana | Padrão real fim de semana |

### Sessão 3 — Repetir com config B do cluster
9. Alterar parâmetros do CANM (nova configuração).
10. Repetir 4–8 com os mesmos comandos — dataset idêntico garante comparabilidade.

### Sessão 4 — Estresse
| # | Cenário | Profile | Objetivo |
|---|---------|---------|----------|
| 11 | E — Sine wave | dia-util | Sazonalidade sintética |
| 12 | A — Constant | dia-util | K6_VUS=30 K6_DURATION=20m (carga sustentada acima do real) |

> **Reprodutibilidade:** a semente `42` em `sequence.js` + payloads fixos garantem
> que baterias diferentes submetam exatamente o mesmo conjunto de requisições ao cluster,
> tornando comparações entre configurações do CANM diretamente comparáveis.

---

## §6 — Diagnóstico rápido após execução

### Via CSV + awk (sem dependências)
```bash
# Quantidade de requests por endpoint
awk -F',' 'NR>1 && $2=="http_req_duration" {print $13}' \
  k6/results/<file>.csv | sort | uniq -c | sort -rn | head

# Quantidade de erros por status code
awk -F',' 'NR>1 && $2=="http_req_failed" && $4=="1" {print $14}' \
  k6/results/<file>.csv | sort | uniq -c
```

> Os índices de coluna podem variar conforme versão do k6 — confira a primeira linha
> do CSV (`head -1 k6/results/<file>.csv`) e ajuste se necessário.

### Via Python/Pandas (recomendado para gráficos do TCC)

```python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv('k6/results/<file>.csv')

# Filtrar só latência de requests
dur = df[df['metric_name'] == 'http_req_duration'].copy()
dur['ts'] = pd.to_datetime(dur['timestamp'], unit='s')
dur['latency_ms'] = dur['metric_value']

# Estatísticas por endpoint (p50/p95/p99)
print(dur.groupby('name')['latency_ms'].describe(percentiles=[.5, .95, .99]))

# Gráfico: latência ao longo do tempo (média móvel de 10s)
ax = dur.set_index('ts')['latency_ms'].rolling('10s').mean().plot(
    figsize=(12, 4),
    title='Latência média (rolling 10s) — config X',
    ylabel='ms',
)
plt.tight_layout()
plt.savefig('grafico-latencia-config-X.png', dpi=150)

# Gráfico: scatter por endpoint (cada ponto = 1 request)
fig, ax = plt.subplots(figsize=(12, 6))
for endpoint, group in dur.groupby('name'):
    ax.scatter(group['ts'], group['latency_ms'], s=2, alpha=0.4, label=endpoint)
ax.set_ylabel('ms'); ax.set_title('Latência por endpoint')
ax.legend(loc='upper right', fontsize=6, markerscale=3)
plt.tight_layout()
plt.savefig('grafico-scatter-config-X.png', dpi=150)
```

### Comparar duas configurações do CANM lado a lado

```python
df_a = pd.read_csv('k6/results/<config-A>.csv')
df_b = pd.read_csv('k6/results/<config-B>.csv')

for name, df in [('config A', df_a), ('config B', df_b)]:
    d = df[df['metric_name'] == 'http_req_duration']
    d.set_index(pd.to_datetime(d['timestamp'], unit='s'))['metric_value'] \
     .rolling('10s').mean().plot(label=name)

plt.legend(); plt.ylabel('latência ms (rolling 10s)'); plt.title('A vs B')
plt.savefig('comparacao-A-vs-B.png', dpi=150)
```
