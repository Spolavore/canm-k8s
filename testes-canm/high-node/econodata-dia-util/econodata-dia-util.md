# Teste de Carga — Dia Útil (high-node)
* Com 4 nodos no high-node-pool rodaremos o cenário `econodata-dia-util` com o profile `dia-util`.
* O cenário replica o padrão real de um dia útil: pico matinal (~10h), vale ao meio-dia e pico vespertino (~14h), com média de 7,24 req/s ao longo de 24h.
* VUs dobrados (v2) em relação à primeira rodada — cluster atingiu apenas ~32% CPU; meta: 60–70% para estressar o autoscaler de forma significativa.
* Serão realizadas **3 execuções** independentes (reduzido de 5 após análise — ver `design-experimental.md`).
* Objetivo: validar que o CANM mantém latência p95 < 8 s e taxa de erro < 10% sob carga realista de dia útil com VUs dobrados.

<!-- Cada iteração salva seus artefatos (CSV + PNGs + summary.txt) na subpasta correspondente: 1/, 2/, 3/ -->
