# Roadmap — Melhorias Planejadas

## Milestones Identificadas

### M3 — Persistência Robusta de Estado (em progresso)

**Contexto:** Atualmente, a persistência do estado de migração usa annotations nos nós do Kubernetes. Isso já sobrevive a reinicializações do CANM na maioria dos casos, mas há uma janela de race condition se o processo morrer entre uma operação e a escrita da annotation.

**Objetivo:** Tornar o estado completamente idempotente e recuperável em qualquer ponto da falha.

**Possíveis implementações:**
- Usar Kubernetes `ConfigMap` ou `Secret` como store de estado distribuído
- Garantir que cada etapa é idempotente (pode ser repetida sem efeito colateral)
- Adicionar verificação de estado real do GCP antes de decidir o que reconciliar

---

## Melhorias Documentadas no Código

### Cordon-Before-Drain

Atualmente o drain chama `kubectl drain` diretamente, que faz cordon implicitamente. Uma melhoria seria fazer cordon explicitamente primeiro:

```
cordon(source) → aguarda novos pods pararem de ser schedulados → drain(source)
```

Isso reduziria pods em estado transitório durante a migração.

### Suporte a Clusters Regionais

Como descrito em [[08 - Limitations]], clusters regionais têm MIGs distribuídos em múltiplas zonas. A melhoria seria:

```typescript
// Ao criar instância: escolher zona com menos nós (balanceamento)
// OU: usar a mesma zona do nó sendo removido
const targetZone = extractZoneFromNodeName(sourceNode);
await createInstance(targetPool, targetZone);
```

### Métricas de Rede

Incluir métricas de uso de rede no score composto. Útil para workloads com alto tráfego de rede mas baixo uso de CPU/memória.

```typescript
// Nova query sugerida:
sum(rate(container_network_transmit_bytes_total[5m])) by (node)
  / sum(machine_network_bandwidth_bytes) by (node) * 100

// Novo parâmetro:
NETWORK_WEIGHT=0.10
// Requer renormalizar CPU_WEIGHT e MEMORY_WEIGHT
```

### Validação de Configuração no Startup

Antes de iniciar o loop, validar:
- `HIGH_NODE_POOL` e `LOW_NODE_POOL` existem no cluster
- `PROMETHEUS_API_URL` está acessível
- `gcloud` e `kubectl` estão no PATH com as versões corretas
- Permissões IAM mínimas estão presentes

### Promoção Segura (Low → High com Drain Controlado)

Ao migrar `low→high`, o nó low pool está **sobrecarregado**. Drenar ele pode piorar a situação se não houver capacidade suficiente no cluster para absorver os pods. A melhoria seria:

1. Verificar capacidade disponível no cluster antes de drenar
2. Aguardar o novo nó high estar pronto **e com pods schedulados** antes de drenar o low

---

## Melhorias de Observabilidade

- Expor métricas Prometheus do próprio CANM:
  - `canm_migrations_total{status, direction}` — contador
  - `canm_migration_duration_seconds` — histograma
  - `canm_nodes_in_reconciliation` — gauge
- Dashboard Grafana para visualizar custo salvo ao longo do tempo

---

## Distribuição e Deployment

- Criar `Dockerfile` oficial com multi-stage build
- Criar `Helm chart` para deploy em Kubernetes
- Implementar `Kubernetes Lease` para garantir single-writer mesmo com múltiplos pods deployados (para HA/restart automático sem race condition)

---

## Relacionados

- [[08 - Limitations]] — limitações que estas melhorias endereçam
- [[05 - Reconciliation Loop]] — contexto para M3 (persistência de estado)
- [[02 - Architecture]] — onde novas integrações se encaixariam
