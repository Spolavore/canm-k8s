# Design Experimental — Bateria de Testes CANM

## Visão geral

Os testes são organizados em quatro grupos com objetivos distintos.
Os Grupos 1 e 2 já estão implementados (high-node-pool).
Os Grupos 3 e 4 estão planejados para implementação futura (low-node-pool).

---

## Grupo 1 — Sem CANM, all-high-node (implementado)

Cluster fixo com todos os nodos no high-node-pool. CANM desligado.
Objetivo: caracterizar o comportamento da aplicação e estabelecer baseline de performance.

| Teste | Cenário | Duração | Repetições | Justificativa |
|---|---|---|---|---|
| Descoberta de bottleneck | `step-up` (dia-util) | ~7 min | **3×** | Resultado qualitativo — confirmar onde CPU/MEM satura de forma consistente |
| Baseline dia útil | `econodata-dia-util` (dia-util) | **120 min** | **2×** | 5 min/hora real — vale do almoço e pico da tarde claramente distinguíveis; 2 runs suficientes para comprovar reprodutibilidade do comportamento do CANM |
| Baseline fim de semana | `econodata-fim-semana` (fim-semana) | **120 min** | **2×** | Platô de 64 min contínuo expõe com clareza as decisões de scale-down do CANM |

> Reset para all-high entre cada run — estado controlado obrigatório.
>
> **Nota sobre repetições (v4):** 2× com 120 min cada.
> Com 5 min por hora real, vale do almoço (12h–14h = 10 min de teste) e pico da tarde
> (14h–16h = 10 min) ficam claramente visíveis nos gráficos, alinhados ao pattern de produção
> (`patter-prd-dia-semana.png`). A bateria total (blocos 2+3) cabe em ~8h30 com cooldowns.
> (Histórico: 5×→3×→2× por degradação em runs tardios; 30min→60min→120min por vales curtos
> demais para o CANM tomar decisões observáveis.)

Script: `tests/run-all.sh`

---

## Grupo 2 — Com CANM ativo, partindo de all-high (execução manual)

CANM ligado, partindo sempre de all-high. **Cada teste é independente** — não há
encadeamento: a saída de um teste não é a entrada de outro. Entre cada run o cluster
volta ao estado inicial controlado (ver "Reset" abaixo). Repetições **≥2×**, para
*testar* a reprodutibilidade da decisão do CANM (não para mediar ruído): se os dois runs
produzem a mesma linha do tempo de migração, o determinismo fica comprovado; se divergem,
é um achado de sensibilidade a threshold.

| Teste | Cluster inicial | Cenário | Repetições | Objetivo |
|---|---|---|---|---|
| Migração + performance (dia útil) | all-high | `econodata-dia-util` (dia-util) | **2×** | Num único run contínuo: observar quais nodos o CANM migra (scale-down) e quando, e verificar se a performance se mantém após a migração |
| Resiliência (opcional) | all-high | `econodata-dia-util` com mais VUs | **2×** | O CANM mantém a performance / reage corretamente sob carga extra? |

> **Reset entre runs (obrigatório).** Diferente do baseline, resetar o CANM não é só
> redimensionar o pool. É preciso (a) voltar a 4 nodos all-high com nodos *provider*
> novos, **sem anotações do CANM** (`STATE`, `MIGRATION_STAGE`, `LAST_RECONCILIATION`) —
> senão o loop de reconciliação começa o run seguinte no meio do estado, e um
> `LAST_RECONCILIATION` recente dentro do cooldown suprime a reconciliação inicial; e
> (b) rotacionar os logs de auditoria (`migrations.jsonl`, `compensations.jsonl`,
> `reconciliations.jsonl`) para isolar os dados de cada run. Cada run precisa do mesmo
> aquecimento (≥ janela de avaliação do high-pool, 15 min) antes de as decisões serem
> representativas. Reset feito manualmente.
>
> Pastas: `tests/canm/econodata-dia-util/1/ 2/`, `tests/canm/resiliencia/1/ 2/`
> Executar manualmente — não incluído no `run-all.sh`.

> **Nota (mudança de desenho).** A versão anterior encadeava as Fases B→C→D sem reset
> (o estado deixado por uma fase era a entrada da próxima). Isso foi removido para tratar
> cada teste de forma independente e reprodutível. O escopo de scale-back-up (low → high)
> sai do Grupo 2 e fica coberto pelo Grupo 4.

---

## Grupo 3 — Sem CANM, all-low-node (planejado — implementar futuramente)

Espelho do Grupo 1, mas com todos os nodos no low-node-pool. CANM desligado.
Objetivo: caracterizar o comportamento da aplicação no pool de menor capacidade e estabelecer
o baseline de performance do low-node, para compará-lo com o high-node e com o estado
pós-migração do CANM.

| Teste | Cenário | Duração | Repetições | Justificativa |
|---|---|---|---|---|
| Descoberta de bottleneck (low) | `step-up` (dia-util) | ~7 min | **3×** | Identificar onde low-node satura — comparar com high-node |
| Baseline dia útil (low) | `econodata-dia-util` (dia-util) | **120 min** | **2×** | Alinhado com Grupo 1 |
| Baseline fim de semana (low) | `econodata-fim-semana` (fim-semana) | **120 min** | **2×** | Alinhado com Grupo 1 |

> Pasta sugerida: `tests/low-node/`
> Implementação: criar `tests/run-all-low.sh` análogo ao `run-all.sh` com `K6_OUT_DIR` apontando para `tests/low-node/`.

---

## Grupo 4 — Com CANM ativo, partindo de all-low (planejado — implementar futuramente)

Espelho do Grupo 2, mas com o cluster iniciando all-low. CANM ligado, **cada teste
independente** (sem encadeamento). Reset para all-low entre cada run, com as mesmas
ressalvas de limpeza de anotações e rotação de logs do CANM descritas no Grupo 2.
Repetições **≥2×**.
Objetivo: validar se o CANM escala para cima (low → high) quando a carga exige e se a
performance pós-escala equivale ao Grupo 1.

| Teste | Cluster inicial | Cenário | Repetições | Objetivo |
|---|---|---|---|---|
| Escala ascendente + performance | all-low | `econodata-dia-util` (dia-util) | **2×** | Num único run contínuo: o CANM migra nodos para high quando necessário, e a performance pós-escala equivale ao Grupo 1? |

> Pasta sugerida: `tests/canm-low/econodata-dia-util/1/ 2/`

---

## Perguntas respondidas por grupo

| Grupo | Pergunta principal |
|---|---|
| 1 — Bottleneck high | Qual componente (CPU/MEM) é o gargalo no high-node? |
| 1 — Baseline high | Qual a performance base sem CANM no high-node? |
| 2 — CANM high→low | O CANM toma a decisão certa ao migrar para low? A performance se mantém? |
| 3 — Bottleneck low | Qual o gargalo no low-node? Em que ponto ele satura em relação ao high? |
| 3 — Baseline low | Qual a performance base sem CANM no low-node? |
| 4 — CANM low→high | O CANM consegue escalar de volta para high quando a carga exige? |

---

## Estrutura de pastas

```
tests/
  design-experimental.md          ← este arquivo
  run-all.sh                       ← Grupos 1 (automatizado)
  descoberta-bottleneck/           ← Grupo 1, step-up × 3
    1/ 2/ 3/
  high-node/
    econodata-dia-util/            ← Grupo 1, baseline × 2
      1/ 2/
    econodata-fim-semana/          ← Grupo 1, baseline × 2
      1/ 2/
  canm/                            ← Grupo 2 (execução manual, ≥2× por teste)
    econodata-dia-util/            ← migração + performance
      1/ 2/
    resiliencia/                   ← opcional, +VUs
      1/ 2/
  low-node/                        ← Grupo 3 (a implementar)
    descoberta-bottleneck/
      1/ 2/ 3/
    econodata-dia-util/
      1/ 2/
    econodata-fim-semana/
      1/ 2/
  canm-low/                        ← Grupo 4 (a implementar, ≥2× por teste)
    econodata-dia-util/            ← escala ascendente + performance
      1/ 2/
```
