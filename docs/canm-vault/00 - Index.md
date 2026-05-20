# CANM — Cost Aware Node Migration

> Sistema de otimização automática de custos em clusters Kubernetes (GKE) via migração inteligente de nós entre node pools.

---

## Navegação

| Nota                          | Conteúdo                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| [[01 - Overview]]             | Propósito, objetivos e contexto do projeto                   |
| [[02 - Architecture]]         | Componentes principais, diagrama de fluxo e integrações      |
| [[03 - Scoring and Decision]] | Algoritmo de score, pesos e política de decisão              |
| [[04 - Migration Pipeline]]   | Pipeline de migração (Saga Pattern), etapas e compensações   |
| [[05 - Reconciliation Loop]]  | Loop de reconciliação e tratamento de estados inconsistentes |
| [[06 - Configuration]]        | Hiperparâmetros, variáveis de ambiente e defaults            |
| [[07 - How to Run]]           | Instalação, dependências, autenticação e comandos            |
| [[08 - Limitations]]          | Limitações conhecidas e restrições de design                 |
| [[09 - Observability]]        | Logs, auditoria e como monitorar                             |
| [[10 - Roadmap]]              | Milestones e melhorias planejadas                            |

---

## Visão Rápida

```
Cluster GKE
├── pool-high (caro, alta performance)
│   └── nós subutilizados (score < 0.35) → migrar para pool-low
└── pool-low (barato, compartilhado)
    └── nós sobrecarregados (score > 0.6) → migrar para pool-high
```

**Loop de operação:** a cada `CHECK_INTERVAL` (default 1 minuto):
1. **Reconciliação** — resolve estados incompletos de migrações anteriores
2. **Avaliação** — coleta scores via Prometheus e decide se migrar
3. **Pipeline** — executa Addition → Draining → Removing com compensações

---

## Stack

- **Linguagem:** TypeScript + Node.js
- **Cluster:** GKE (Google Kubernetes Engine)
- **Métricas:** Prometheus
- **APIs externas:** Kubernetes SDK, gcloud CLI, kubectl CLI
- **Padrão:** Saga Pattern + Kubernetes Reconciliation Loop

---

*Vault gerado em: 2026-05-18*
