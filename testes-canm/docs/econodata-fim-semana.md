# Teste de Carga — Fim de Semana (high-node)
* Com 4 nodos no high-node-pool rodaremos o cenário `econodata-fim-semana` com o profile `fim-semana`.
* O cenário replica o padrão real de um fim de semana: tráfego genuinamente plano (~3,8 req/s constante ao longo do dia), sem picos pronunciados — confirmado pelos dados de CPU de produção (12–14% flat o dia todo).
* Padrão corrigido (v2): substituído o shape de curva com hump por platô sustentado em ~4–5 VUs.
* Serão realizadas **3 execuções** independentes (reduzido de 5 após análise — ver `design-experimental.md`).
* Objetivo: validar que o CANM escala corretamente para baixo em cenário de baixo volume e mantém latência p95 < 4 s e taxa de erro < 8%.

<!-- Cada iteração salva seus artefatos (CSV + PNGs + summary.txt) na subpasta correspondente: 1/, 2/, 3/ -->
