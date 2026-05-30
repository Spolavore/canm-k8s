# Comparação High-node (N2) × Low-node (E2)

> Baseline **sem CANM**, mesmo cluster GKE (`gke_ecdt-produto_us-central1-a_beta`), 4 nodos,
> ~mesma carga (k6, perfis `econodata-dia-util` e `econodata-fim-semana`, 120 min cada).
> High = pool de máquinas série **N2**; Low = pool série **E2**.
> Corresponde ao **Grupo 1** (high, doc `design-experimental.md`) × **Grupo 3** (low, espelho planejado).

## 1. Resultados k6 (cliente)

### Dia útil (pico matinal + vale almoço + pico tarde, teto 300 VUs)

| Métrica            | High (N2) | Low (E2) | Δ          |
|--------------------|----------:|---------:|------------|
| Total requisições  |   277.931 |  273.655 | −1,5%      |
| Throughput         | 38,6 req/s| 38,0 req/s| ≈ igual   |
| Falhas             | 228 (0,08%)| 821 (0,30%)| **3,8× mais erro** |
| Latência avg       |  683,9 ms |  708,2 ms| +3,6%      |
| p50                |  319,2 ms |  333,8 ms| +4,6%      |
| **p95**            | 1247,2 ms | **1588,0 ms**| **+27%** |

### Fim de semana (platô plano ~15 VUs + 2 batches curtos)

| Métrica            | High (N2) | Low (E2) | Δ          |
|--------------------|----------:|---------:|------------|
| Total requisições  |    92.310 |   91.447 | −0,9%      |
| Throughput         | 12,8 req/s| 12,7 req/s| ≈ igual   |
| Falhas             |   2 (0,00%)|  5 (0,01%)| desprezível |
| Latência avg       |  260,8 ms |  272,6 ms| +4,5%      |
| **p95**            |  359,3 ms |  413,8 ms| **+15%**  |

**Throughput praticamente idêntico** porque o k6 usa `ramping-vus` (modelo *fechado*): a carga é
governada pelo número de VUs, não pela capacidade do servidor. Os dois clusters processaram o mesmo
volume — o que muda é **o quanto cada um sofreu para entregá-lo** (CPU, erro, cauda de latência).

## 2. Consumo de recursos no cluster (Grafana, 4 nodos)

| Cenário / métrica          | High (N2) | Low (E2) | Leitura |
|----------------------------|----------:|---------:|---------|
| Dia útil — **CPU** avg cluster | 26,3% | **39,1%** | E2 gasta ~1,5× mais CPU pela mesma carga |
| Dia útil — CPU pico (nó)   |     86,8% | **99,0%** | E2 **satura** nos picos de 300 VUs |
| Dia útil — CPU pico médio/nó |   60,6% | **92,8%** | nos picos, *todos* os nós E2 quase no teto |
| Dia útil — MEM avg cluster |     64,3% | 52,5% | E2 com **mais folga de RAM** |
| Fim sem. — CPU avg cluster |     17,6% | **26,5%** | mesmo no platô plano, E2 ~1,5× a CPU |
| Fim sem. — CPU pico (nó)   |     44,8% | **74,4%** | batches curtos sobem muito mais no E2 |
| Fim sem. — MEM avg cluster |     65,3% | 57,9% | RAM não é o gargalo em nenhum dos dois |

## 3. Conclusões

1. **CPU é o diferenciador, não memória.** Para a mesma carga, o E2 consome ~1,5× a CPU do N2 em
   ambos os cenários — coerente com o menor desempenho por núcleo da série E2 (custo-otimizada,
   sujeita a contenção) frente à N2. A memória ficou **mais folgada** no E2, então RAM não restringe;
   o gargalo é CPU, como o `design-experimental.md` já apontava para o high-node.

2. **No dia útil o E2 satura nos picos.** Pico de nó a **99%** e média-de-pico-por-nó de **93%**:
   nos blocos de 300 VUs (12h/13h/14h/15h) praticamente todos os nós E2 batem no teto. É essa
   saturação que produz os **3,8× mais erros (0,30%)** e o **p95 +27% (1,59 s)**.

3. **No fim de semana o E2 é confortável.** Platô em ~26% de CPU, pico 74%, erro desprezível. A carga
   baixa e constante cabe folgadamente no pool barato.

4. **Ambos cumprem o SLO** dos cenários (dia útil p95 < 8 s e erro < 10%; fim de semana p95 < 4 s e
   erro < 8%) — mas com **margens de segurança muito diferentes**: o N2 sobra capacidade; o E2 entrega
   no limite durante os picos de dia útil.

5. **Implicação para o CANM** (motivação do experimento): os dados sustentam a tese de migração por
   horário. Em janelas de **baixo tráfego (fim de semana / madrugada)**, descer para **E2** é seguro e
   economiza — o cluster nem chega perto do teto. Em **picos de dia útil**, o E2 não tem folga
   (satura, erro 4×, cauda +27%), então o CANM precisa manter/subir para **N2** nesses períodos.
   É exatamente o comportamento que os Grupos 2 e 4 pretendem validar.

## 4. Ressalvas (não é um A/B perfeitamente limpo)

- **Pods:** high 172 × low 176. A diferença é `ecdt-admin-v2-back` (1 réplica no high × 5 no low,
  namespace `admin-novo`) — adiciona um pequeno baseline ocioso ao low, mas fora do tráfego k6.
- **Versão de build:** `ecdt-gateway-v2` rodou com hash diferente (high `77ff7bc5d` × low `65549cb79d`).
- **1 execução por cenário** em cada pool nesta comparação (o design prevê 2× para reprodutibilidade).
- Distribuição de redis difere: no low os 6 ficaram colocados num único nó (`t3rt`), no high estão
  espalhados — pode concentrar I/O num nó do low.
