#!/usr/bin/env bash
#
# Percorre todos os nodos do cluster e gera um arquivo .txt
# listando quais pods estão rodando em cada nodo.
#
# Uso:
#   ./pods-por-nodo.sh [arquivo_saida]
#
# Exemplo:
#   ./pods-por-nodo.sh pods-por-nodo.txt

set -euo pipefail

OUTPUT="${1:-pods-por-nodo.txt}"

# Garante que o kubectl está disponível
if ! command -v kubectl >/dev/null 2>&1; then
  echo "Erro: kubectl não encontrado no PATH." >&2
  exit 1
fi

# Cabeçalho do relatório
{
  echo "Relatório de Pods por Nodo"
  echo "Gerado em: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Contexto: $(kubectl config current-context 2>/dev/null || echo 'desconhecido')"
  echo "============================================================"
  echo
} > "$OUTPUT"

# Percorre cada nodo retornado por 'kubectl get nodes'
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  {
    echo "NODO: $node"
    echo "------------------------------------------------------------"

    # Lista todos os pods (todos os namespaces) agendados nesse nodo.
    # O field-selector spec.nodeName filtra direto na API.
    pods=$(kubectl get pods --all-namespaces \
            --field-selector "spec.nodeName=$node" \
            -o custom-columns="NAMESPACE:.metadata.namespace,POD:.metadata.name,STATUS:.status.phase" \
            --no-headers 2>/dev/null || true)

    if [ -z "$pods" ]; then
      echo "  (nenhum pod neste nodo)"
    else
      # Conta e imprime de forma alinhada
      total=$(printf '%s\n' "$pods" | grep -c . || true)
      printf '%s\n' "$pods" | awk '{printf "  - [%s] %s/%s\n", $3, $1, $2}'
      echo
      echo "  Total de pods: $total"
    fi

    echo
  } >> "$OUTPUT"
done

echo "Relatório gerado em: $OUTPUT"
