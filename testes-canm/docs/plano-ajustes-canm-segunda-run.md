# Relatório — 2ª run (`pdb+gracefull`) e o erro pós-migração

Investigação do Milestone 2 (cluster sem erro na migração). Cobre a sequência de
runs e fecha o diagnóstico do erro que aparece **quando a migração finaliza**.

> Linguagem: o CANM é **reativo a métricas de utilização** e **orientado a custo** — nunca "proativo".

---

## 1. Runs e resultados

| Run | Config | Duração | Erros | Nota |
|---|---|---|---|---|
| `pdb-only` | PDB | ~2h | **0,64%** | erros durante o drain (in-flight) |
| `pdb+gracefull` (cortada) | PDB + preStop 15s | ~14min | 0,24% | cortada ao surgir erro; não comparável |
| `pdb+gracefull+50m` (overnight) | PDB + preStop + CPU req 50m | **2h completa** | **0,92%** | run cheia, **várias** migrações |

A overnight (02:17→04:17, 237.953 req) é a referência: **0,92%** de erro. É *maior* que
as runs curtas justamente porque captou **várias migrações high→low** — cada uma contribui
com uma rajada de erro (ver §3).

---

## 2. O que o graceful shutdown resolveu (e o que expôs)

O `preStop` (Milestone 2.1) resolveu o lado **origem**: requisições em voo cortadas
*durante o drain*. Expôs um modo de falha **do lado destino**: o nó novo satura no warmup.
preStop é estruturalmente incapaz de cobrir isso (capacidade transitória, não drenar conexão).

---

## 3. Mecanismo — confirmado e fechado (n≥2, high→low)

Cada `high->low` (scale-down) reproduz:

1. CANM dreca um nó N2 inteiro (score ~0,14, ocioso) e cria **um** nó E2.
2. O **workload inteiro do nó drenado (~28 pods de app, ≈1 réplica de cada serviço + redis)
   cold-starta JUNTO no único nó novo** — confirmado por inspeção do nó: 28 pods de app.
3. O nó E2 vai a **~100–118% de CPU por ~8 min** (warmup sincronizado).
4. Cada **replica frio fica `Ready` e PERMANECE Ready** durante a saturação (sem flap,
   `restarts=0`) — `/health` barato responde <1s mesmo com o nó a 118%, enquanto requests
   pesados dão **timeout**. Logo o replica frio segue no endpoint e recebe ~1/5 do tráfego.

### 3.1 Evidência definitiva (overnight, 1ª migração — horário local)
Migração `high->low` score 0,139, início 02:17:53, fim ~02:24.

**Os erros são RAJADA na finalização, não espalhados pela saturação:**

| Janela | req/s | erros/30s | CPU nó novo |
|---|---|---|---|
| 02:23:30–02:25:30 | ~8–11 | 1–3 | 99,7% → subindo |
| **02:26:00 em diante** | ~11,7–12 (cheio) | **0** | ainda 99–118% até 02:28 |
| 02:30:00 | **12 (cheio)** | **0** | **36%** |

Dois fatos que fecham o diagnóstico:
- **A rajada de erro é o *cliff de finalização* (~02:24):** quando o nó-origem é removido, o
  tráfego migra de golpe para os pods frios. Passada a transferência (~02:26), o erro **zera
  mesmo com o nó ainda a ~100%** — os pods quentearam os hot-paths e passam a responder no prazo.
- **Em regime os pods CABEM no E2:** às 02:30 o nó está a **36% com tráfego cheio (12 req/s)
  e zero erro**. Não é piso sem-tráfego. Físca da migração: N2-origem a 14% → mesmos pods no
  E2 (~1,5× mais lento) ≈ 21–36%. **Os 118% são puramente o warmup sincronizado de ~28 pods.**

Conclusão: **não é falta de capacidade** — é o **cliff de finalização + warmup sincronizado**.

(O re-teste 2× do baseline high-node, inalterado, confirma que o problema é transitório de
migração, não artefato de baseline.)

---

## 4. Levers DESCARTADOS (com o porquê)

### ❌ topologySpreadConstraints — não ajuda, pode reforçar
Com **1 réplica/serviço/nó**, o nó novo vazio é o destino *balanceado*: `maxSkew=1` faz o
scheduler **preferir** empilhar os evacuados nele. Só ajudaria se a distribuição fosse
desigual — não é. (`apply-topology-spread.sh` existe mas **não deve ser usado** aqui.)

### ❌ Requests de CPU maiores — inviável nesta densidade
~28 pods de app por nó de 2 vCPU (~1800m úteis ÷ 28 ≈ 64m/pod no teto). 50m já está no limite;
150m tornaria os pods **não-escalonáveis** (exigiria muito mais nós → mata o scale-down). O
cluster é overcommitado de propósito. **Requests não é lever aqui** — 50m não "ficou baixo demais".

---

## 5. Levers VIÁVEIS

| Lever | Onde | Avaliação |
|---|---|---|
| **Drain pausado/incremental gateado em CPU** | CANM (código) | **Primário.** Ataca a raiz (cliff + warmup sincronizado), app-independente, usa a infra de métricas que o CANM já tem. Ver [roadmap-drain-pausado.md](roadmap-drain-pausado.md). |
| Readiness que reflita capacidade real | App (~26 serviços) | Secundário. "Certo" mas org-pesado; risco de flapar em regime. |
| Nós menores no pool low | Infra | Reduz o storm na origem (menos pods por nó drenado). |
| Disparar high→low só em vales reais | CANM (política) | Complemento. **Mesmo a 12 req/s deu erro** → sozinho não zera. |

Por que o drain pausado é suficiente (e não é problema de capacidade): o dado das **02:30
(36% com tráfego)** prova que o destino comporta a carga em regime. Basta **não sincronizar
o warmup** e **não criar o cliff** — exatamente o que o drain pausado faz.

---

## 6. Conclusão e próximo passo

O erro pós-migração está **diagnosticado e fechado**: cliff de finalização + warmup
sincronizado de ~28 pods num nó E2 frio; readiness cego à sobrecarga mantém os replicas frios
recebendo tráfego. Não é capacidade (cabe a 36% em regime).

**Próximo passo:** implementar o **drain pausado gateado em CPU** no CANM —
ver [roadmap-drain-pausado.md](roadmap-drain-pausado.md). Readiness fica como fix app-side a
médio prazo.
