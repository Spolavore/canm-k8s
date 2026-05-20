# How to Run — Instalação e Execução

## Pré-requisitos

### Runtime
- **Node.js** ≥ 18 (recomendado)
- **npm** ≥ 9

### CLIs Externas (devem estar no PATH)

| CLI | Versão Mínima | Instalação |
|-----|---------------|------------|
| `kubectl` | **≥ 1.31** | `gcloud components install kubectl` |
| `gcloud` | recente (≥ 400) | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) |

> **Atenção:** `kubectl wait --for=create` foi introduzido na versão 1.31. Versões anteriores causarão falha silenciosa na etapa de ADDITION. Ver [[08 - Limitations]].

### Permissões GCP Necessárias

O service account ou usuário autenticado precisa de:
- `container.nodes.list` (listar nós)
- `compute.instanceGroups.update` (criar/remover instâncias nas MIGs)
- `compute.instanceGroups.get` (consultar estado das MIGs)
- `compute.instances.delete` (remover VMs)

---

## Instalação

```bash
# 1. Clonar o repositório
git clone <repo-url>
cd canm

# 2. Instalar dependências npm
npm install

# 3. Criar arquivo de configuração
cp .env.example .env
# Editar .env com os valores reais do seu cluster
```

---

## Autenticação

### Google Cloud

```bash
# Login com conta de usuário (desenvolvimento)
gcloud auth login

# OU: ativar service account (produção)
gcloud auth activate-service-account --key-file=credentials.json

# Configurar projeto padrão
gcloud config set project <GCP_PROJECT_ID>
```

### Kubernetes

O CANM gera as credenciais do kubeconfig automaticamente a partir das variáveis `GKE_CLUSTER_NAME`, `GKE_REGION` e `GKE_PROJECT`. Se preferir configurar manualmente:

```bash
gcloud container clusters get-credentials <CLUSTER_NAME> \
  --zone <ZONE> \
  --project <PROJECT_ID>

# Verificar conexão
kubectl get nodes
```

---

## Comandos de Execução

```bash
# Desenvolvimento — com hot reload via nodemon
npm run dev

# Build TypeScript → JavaScript
npm run build   # ou: npm build

# Produção (após build)
npm start

# Script de debug isolado (src/debug/debug.ts)
npm run debug
```

---

## Verificações Antes de Iniciar

```bash
# 1. Verificar versão do kubectl
kubectl version --client
# Deve ser ≥ 1.31

# 2. Verificar conexão com cluster
kubectl cluster-info

# 3. Verificar acesso ao Prometheus
curl http://<PROMETHEUS_API_URL>/api/v1/query?query=up

# 4. Verificar node pools existentes
kubectl get nodes -L cloud.google.com/gke-nodepool

# 5. Verificar acesso às MIGs
gcloud compute instance-groups managed list \
  --filter="name~pool-" \
  --zones=<GKE_REGION>
```

---

## Verificando que o CANM Está Funcionando

Após iniciar com `npm run dev`:

1. **Logs no stdout** — você verá mensagens de tick, reconciliação e avaliação
2. **Arquivo `migrations.jsonl`** — cada migração completa (ou falha) é registrada aqui
3. **Annotations nos nós** — durante uma migração ativa:
   ```bash
   kubectl get nodes -o json | jq '.items[] | select(.metadata.annotations | has("canm.io/migration-stage")) | {name: .metadata.name, annotations: .metadata.annotations}'
   ```

---

## Rodando em Docker

O repositório não inclui Dockerfile, mas a estrutura esperada é:

```dockerfile
FROM node:18-slim

# Instalar kubectl e gcloud
RUN apt-get update && apt-get install -y curl apt-transport-https
# [instalar gcloud SDK e kubectl]

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

# .env deve ser injetado via secrets (não copiado na imagem)
CMD ["npm", "start"]
```

> **Importante:** Nunca commite o `.env` na imagem Docker. Use Kubernetes Secrets ou variáveis de ambiente do runtime.

---

## Monitorando Logs

```bash
# Ver migrações em tempo real
tail -f migrations.jsonl | jq .

# Ver apenas falhas
cat migrations.jsonl | jq 'select(.status == "failed")'

# Ver estatísticas de migração
cat migrations.jsonl | jq -s 'group_by(.status) | map({status: .[0].status, count: length})'
```

---

## Parando o CANM

O CANM não tem graceful shutdown especial — um `Ctrl+C` ou `SIGTERM` encerra o processo. Se uma migração estiver em andamento no momento do kill, o [[05 - Reconciliation Loop]] vai detectar e limpar o estado incompleto na próxima inicialização.

---

## Relacionados

- [[06 - Configuration]] — variáveis de ambiente necessárias
- [[08 - Limitations]] — restrições de versão e ambiente
- [[09 - Observability]] — como interpretar os logs
