# Plano de ajustes do CANM — pós execução `pdb-only` (2026-05-30)

Baseado na execução `testes-canm/canm/pdb-only` (cenário econodata-dia-util,
15:59–17:59 local / run de ~2h). Dois milestones:

1. **Ajustar parâmetros** com base no comportamento observado.
2. **Configurar o cluster** para que as aplicações não retornem erro durante a migração.

> Linguagem: o CANM é **reativo a métricas de utilização** e **orientado a custo** — nunca "proativo".

---

## Achados que fundamentam o plano

### Nota metodológica (corrige a correlação)
`migrations.jsonl` está em **UTC** (sufixo `Z`); `canm-cpu-usage.csv` e `timing.md`
estão em **horário local (UTC−3)**. Âncora: o resumo k6 marca `20:59:34 UTC` e o
`timing.md` marca fim `17:59:42` — mesmo instante. Toda correlação migração×CPU
abaixo já está convertida para local.

### A1. Estabilização real ≈ 10–12 min, não ~4 min (parâmetro mal calibrado)
Medido em `canm-cpu-usage.csv`, todo nó recém-criado dispara um spike de partida
e só assenta abaixo de 50% de CPU depois de ~10–12 min:

| Nó (LOW) | pico inicial | tempo até <50% sustentado |
|---|--:|--:|
| f983b272 | 114% | 11,8 min |
| 077ace35 | 117% | 10,2 min |
| 9c0ae771 | 118% | 10,2 min |
| a906ca1f | 100% | 10,2 min |
| dac3df47 | 100% | 9,8 min |

Nós HIGH levaram 8–16 min (um caso, 214acca9, levou **15,8 min** > os 14m de cooldown).

O `parametros-canm.md` derivou os cooldowns com **estabilização ~4 min**
(de `workload/cpu-no-drain.csv`). Esse valor é **empiricamente baixo** para a carga
de produção real: o número certo é **~10–12 min**.

### A2. O flap observado é warmup-flap, e o cooldown o cobre
A migração `low->high` de **score 0,99** ocorreu num nó de **9 min de idade**, com
CPU média de **100%** nos 5 min anteriores — ou seja, o nó **ainda estava no spike
de partida** (que assenta só aos ~12 min). O `LOW_NODE_COOL_DOWN=8m` expirou *antes*
da estabilização, e o CANM devolveu o nó ao pool forte durante o transitório.

Como o `isNodeInCooldown` ([MigratorOrchestrator.ts:98](../../src/components/MigratorOrchestrator.ts#L98))
mede o cooldown a partir do `creationTimestamp` **do próprio nó**, e o nó que flapou
é um nó recém-criado pelo CANM, **aumentar o cooldown resolve este caso**.

### A3. As migrações borderline (0,50x) são genuínas, não warmup
As `low->high` de score 0,503/0,504 foram em nós de **66–68 min** de idade, com CPU
real ~37–50% — nós maduros cruzando o **joelho de ~50%**. Isso é comportamento
**de projeto** (subir antes de degradar a latência), não um bug de estabilização.
Se forem indesejáveis, o ajuste é de **histerese/threshold**, não de cooldown.

### A4. Erros coincidem com a migração e PDB sozinho não resolve
O run `pdb-only` teve **0,64% de falhas (1555/243406)**. O PDB (via Eviction API —
o `drain` do CANM usa `kubectl drain`, que **respeita PDB**) limita *quantos* pods
caem juntos, mas **não drena tráfego** do pod que está terminando. Sem `preStop`/
SIGTERM, requisições em voo são cortadas no encerramento — exatamente o gap que a
pasta `pdb+gracefull` foi planejada para testar.

Detalhe de interação: o CANM dreca com `--grace-period=60`
([KubernetesClient.ts:59](../../src/lib/KubernetesClient.ts#L59)), que **sobrescreve**
o `terminationGracePeriodSeconds` do pod para 60s durante o drain. Um `preStop` de
15s cabe folgado nesses 60s.

---

## Milestone 1 — Ajuste de parâmetros (a partir da execução atual) — ✅ APLICADO (2026-05-30)

**Objetivo:** parar o warmup-flap re-derivando os cooldowns com a estabilização real.

### 1.1 Re-derivar os cooldowns (lever principal — resolve A2)
Fórmula do doc: `cooldown ≥ janela_do_pool + estabilização`. Trocando estabilização
4m → **~12m** (A1):

| Variável | Antes | Cálculo novo | Aplicado |
|---|---|---|---|
| `LOW_NODE_COOL_DOWN` | `8m` | 3m (janela low) + 12m | **`15m`** |
| `HIGH_NODE_COOL_DOWN` | `14m` | 10m (janela high) + 12m | **`22m`** |

Cooldowns longos no high são aceitáveis: scale-down deve ser conservador.

> `LOW=15m` é o piso da fórmula (3m + 12m, sem margem); cobre a estabilização real
> (~12m) e o flap observado (nó de 9 min), mas fica no limite inferior sobre o pior
> caso medido (settle de 11,8 min). Se reaparecer flap de warmup numa próxima run,
> subir para 16–17m dá folga.

> **Thresholds mantidos** (`HIGH=0.5`, `LOW=0.25`) por decisão: as borderline 0,50x
> (A3) são genuínas, então não justificam mexer no joelho agora.

### 1.2 (Opcional) Amortecer o transitório também na janela
Alternativa/complemento ao cooldown: subir `LOW_POOL_TIME_WINDOW_EVAL` de `3m` para
`5m`. Janela maior dilui o spike de partida na média, mas **atrasa o scale-up
genuíno** — trade-off a medir. Preferir o cooldown (1.1) como ajuste primário.

### 1.3 (Decisão de projeto, não bug) Histerese no joelho — A3
As migrações borderline de 0,50x são corretas pelo design atual. Se o objetivo for
reduzi-las, opções (escolher uma, não aplicar às cegas):
- subir `HIGH_SCORE_THRESHOLD` 0,5 → ~0,55 (troca: começa a subir um pouco mais
  tarde, latência um pouco pior — o doc fixou 0,5 no joelho de propósito);
- exigir score ≥ threshold por N janelas consecutivas (dwell) — exige mudança de código.

### 1.4 Achados arquiteturais (fora de parâmetro)
- **Sem janela global de assentamento → ✅ IMPLEMENTADO:** `evaluateCluster` faz no
  máximo 1 migração por tick, mas nada impedia migrações consecutivas (gap real medido
  de **~36 s** entre fim e início). Adicionado `CANM_EVAL_COOLDOWN='2m'`
  ([`MigratorOrchestrator.start`](../../src/components/MigratorOrchestrator.ts#L580)).
  Ver `parametros-canm.md` §6 (incl. ressalva: 2m é inicial, pode ser curto p/ irmãos).
- **`drain` sem `--timeout` → ✅ IMPLEMENTADO:** com PDB estrito, se um workload
  estivesse degradado (`ALLOWED-DISRUPTIONS=0`) o drain podia **travar indefinidamente**.
  Adicionado `--timeout=600s` ([`KubernetesClient.drain`](../../src/lib/KubernetesClient.ts#L63));
  drain que estoura o teto falha limpo e cai na compensação.
- **Cooldown não cobre nós irmãos (pendente):** o cooldown é por `creationTimestamp` do
  nó migrado; nós antigos que absorvem a carga redistribuída no drain não são protegidos.
  Não foi a causa neste run, e o `CANM_EVAL_COOLDOWN` mitiga parcialmente (anti-burst),
  mas continua um buraco se a carga subir mais.

---

## Milestone 2 — Configurar o cluster para não retornar erro

**Objetivo:** zerar (ou aproximar de zero) os 0,64% de erro durante a migração.
A causa é drop de requisições em voo no encerramento do pod — ortogonal ao PDB.

### 2.1 Graceful shutdown nos Deployments (fix principal — resolve A4)
Aplicar `preStop` + grace period (script já pronto:
`scripts/apply-graceful-shutdown.sh`, preStop 15s + grace 30s, sleep nativo):
```bash
./testes-canm/scripts/apply-graceful-shutdown.sh --apply --only=ecdt-gateway-beta  # 1º um serviço
./testes-canm/scripts/apply-graceful-shutdown.sh --apply                            # depois o resto
```
O `preStop` segura o encerramento até o pod sair do EndpointSlice, fechando a corrida
em que kube-proxy ainda roteia para o pod `Terminating`.

### 2.2 Confirmar tratamento de SIGTERM nos serviços de maior tráfego
O `preStop` ganha tempo, mas **o app precisa** parar de aceitar novas conexões e
finalizar as em voo ao receber SIGTERM, e ter `readinessProbe`. Verificar pelo menos
`ecdt-gateway-beta`, `ecdt-api-beta`, `ecdt-busca-beta`. Sem isso, o erro persiste
mesmo com preStop.

### 2.3 Topology spread / anti-afinidade por serviço
No relatório de distribuição vários serviços têm **2 réplicas no mesmo nó** (ex.:
`ecdt-busca-beta`, `ecdt-oauth2-beta`). Drenar esse nó tira 2 de 5 réplicas de uma vez
→ ou o PDB (`maxUnavailable=1`) **bloqueia o drain**, ou (sem PDB) o serviço perde 40%
da capacidade num golpe. Adicionar `topologySpreadConstraints` (1 réplica por nó)
torna o drain suave e evita o bloqueio.

### 2.4 Manter PDB `maxUnavailable=1` (já aplicável)
`scripts/apply-pdb.sh` cria os 26 PDBs. Necessário para serializar evictions, mas
**só funciona bem junto com 2.1–2.3** — sozinho, é o cenário `pdb-only` que ainda deu
0,64% de erro.

### Ordem sugerida de validação
`pdb-only` (feito) → aplicar 2.1 (+2.2) → re-rodar como `pdb+gracefull` → comparar a
taxa de erro. Se ainda houver erro, aplicar 2.3 e re-medir.

---

## Resumo das mudanças no `.env` — ✅ aplicado

```diff
- LOW_NODE_COOL_DOWN='8m'
+ LOW_NODE_COOL_DOWN='15m'
- HIGH_NODE_COOL_DOWN='14m'
+ HIGH_NODE_COOL_DOWN='22m'
```
Thresholds e janelas mantidos. Opcionais não aplicados (avaliar em runs futuras):
janela low `3m→5m` (1.2); `HIGH_SCORE_THRESHOLD 0.5→0.55` (1.3).
