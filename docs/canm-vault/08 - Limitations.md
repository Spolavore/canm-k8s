# Limitations — Limitações Conhecidas

## 1. Dependências de Versão de CLIs

### kubectl ≥ 1.31 obrigatório

O CANM usa `kubectl wait --for=create node/<nome>` para aguardar o nó aparecer no API Server após a criação da instância na MIG. Esse subcomando (`--for=create`) foi introduzido apenas na versão 1.31.

**Impacto:** Com versões anteriores, a etapa de ADDITION falha ou nunca termina, deixando o cluster em estado inconsistente.

**Verificação:**
```bash
kubectl version --client --output=json | jq '.clientVersion.minor'
# Deve retornar "31" ou superior
```

### gcloud SDK recente obrigatório

O comando `gcloud compute instance-groups managed wait-until --stable` deve estar disponível e funcional. Versões muito antigas do SDK GCP podem não ter esse subcomando.

---

## 2. Apenas Clusters Zonais (não regionais)

### O Problema

`GKE_REGION` deve conter uma **zona** específica (ex: `us-central1-a`), **não uma região** (ex: `us-central1`).

Em clusters **regionais**, o GKE distribui os nós entre múltiplas zonas de forma transparente. Cada node pool tem um Managed Instance Group (MIG) em cada zona. Ao chamar `gcloud compute instance-groups managed create-instance`, é necessário especificar em qual zona (e portanto em qual MIG) criar a instância — e o CANM atualmente não tem essa lógica.

### Assimetria Presente

Curiosamente, a **remoção** funciona em clusters regionais, pois o CANM extrai a zona diretamente do nome da instância a ser removida. Só a adição é afetada.

### Impacto

Tentar usar o CANM com `GKE_REGION=us-central1` (regional) fará as migrações `high→low` e `low→high` falharem na etapa de ADDITION.

### Mitigação Futura

Implementar seleção automática de zona durante a adição: consultar qual MIG de qual zona tem menos instâncias (ou usar a mesma zona da instância sendo removida).

---

## 3. Single-Writer — Sem Suporte a Múltiplas Réplicas

### O Problema

O CANM assume que é o **único agente** modificando os node pools. Não há:
- Locks distribuídos no Kubernetes (como `Lease` objects)
- Coordenação entre réplicas
- CAS (Compare-And-Swap) nas annotations

### Consequências de Múltiplas Réplicas

- `getNodePoolCount()` pode retornar valores diferentes simultaneamente para cada réplica
- Duas réplicas podem decidir migrar o mesmo nó concorrentemente
- Annotations podem ser sobrescritas de forma não determinística
- Remoções duplicadas causam erros do gcloud (instância já não existe)

### Recomendação

**Rodar exatamente 1 réplica do CANM por cluster.** Se deployado em Kubernetes, usar `replicas: 1` e sem HPA no deployment do CANM.

---

## 4. Sem Persistência de Estado Entre Reinicializações (até M3)

### Status Atual

O mecanismo de [[05 - Reconciliation Loop]] usa annotations nos nós para persistir o estado — isso **sobrevive a reinicializações**. No entanto, existe uma janela de vulnerabilidade:

Se o CANM morrer **entre** a conclusão de uma etapa e a escrita da annotation correspondente (race condition de processo), o estado ficará inconsistente.

### Exemplo Concreto

```
1. gcloud delete-instances <source>  ← executado com sucesso
2. [CANM morre aqui]
3. [CANM reinicia]
4. Reconciliação não vê o source (já foi removido) ✓
5. Mas o nó novo ainda está em STATE=created
6. Reconciliação deleta o nó novo → pods são re-evictados brevemente ⚠
```

### Impacto

Breve downtime para pods que estavam no nó novo enquanto são reagendados em outros nós.

---

## 5. Sem Suporte a PDBs na Etapa de Drain

O `kubectl drain` inclui `--force` e `--delete-emptydir-data`, mas se um `PodDisruptionBudget` impede a evicção dos pods, o drain falha. O CANM:

1. Compensa (uncordon source, remove nó novo)
2. Marca o source com annotation pendente
3. A reconciliação vai tentar novamente no próximo tick

Se o PDB continuar bloqueando, a migração nunca avança — o source fica preso em `stage=draining` indefinidamente (com cooldown de 5 minutos entre retentativas).

**Workaround:** Verificar PDBs antes de configurar thresholds agressivos, ou aumentar `LOW_SCORE_THRESHOLD` para reduzir a frequência de migrações.

---

## 6. Sem Validação de Topologia do Cluster

O CANM não valida se `HIGH_NODE_POOL` e `LOW_NODE_POOL` existem antes de iniciar. Uma configuração errada (ex: typo no nome do pool) só é descoberta quando a primeira migração é tentada, potencialmente após horas.

---

## 7. Métricas de Rede não Consideradas

O score atual leva em conta apenas CPU e memória. Workloads com alto I/O de rede ou disco podem ser mal classificados. Uma melhoria futura mencionada no código é incluir métricas de rede.

---

## Tabela Resumo

| Limitação | Severidade | Contornável? |
|-----------|-----------|--------------|
| kubectl < 1.31 | Alta — falha silenciosa | Sim — atualizar kubectl |
| Cluster regional | Alta — ADDITION falha | Sim — usar zona específica |
| Múltiplas réplicas | Alta — race conditions | Sim — rodar 1 réplica |
| Race condition ao matar | Baixa — breve downtime | Parcialmente (via reconciliação) |
| PDB bloqueando drain | Média — migração travada | Sim — revisar PDBs |
| Sem validação de configuração | Baixa — descoberta tardia | Não (por enquanto) |
| Rede não considerada | Baixa — falso positivo ocasional | Sim — via CPU_WEIGHT/MEMORY_WEIGHT |

---

## Relacionados

- [[07 - How to Run]] — verificações de versão antes de iniciar
- [[05 - Reconciliation Loop]] — como estados inconsistentes são recuperados
- [[10 - Roadmap]] — melhorias planejadas para clusters regionais e persistência
