#!/usr/bin/env bash
#
# remove-pdb.sh
# -----------------------------------------------------------------------------
# Lista todos os PodDisruptionBudgets do cluster e os remove.
#
# DRY-RUN por padrao: apenas lista. Use --delete para remover de fato.
#
# Flags:
#   --delete         Remove os PDBs (sem isso, so lista).
#   --managed-only   Restringe aos PDBs criados pelo apply-pdb.sh
#                    (label app.kubernetes.io/managed-by=canm-pdb-script).
#   --namespace=NS   Restringe a um namespace (default: todos, -A).
#   --yes            Pula a confirmacao interativa.
# -----------------------------------------------------------------------------
set -euo pipefail

MANAGED_LABEL="canm-pdb-script"
DELETE=false
MANAGED_ONLY=false
ASSUME_YES=false
NS_SCOPE="-A"          # -A = todos os namespaces
NS_NAME=""

for arg in "$@"; do
  case "$arg" in
    --delete) DELETE=true ;;
    --managed-only) MANAGED_ONLY=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --namespace=*) NS_NAME="${arg#*=}"; NS_SCOPE="-n $NS_NAME" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl nao encontrado no PATH" >&2; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo '???')"
SELECTOR=()
$MANAGED_ONLY && SELECTOR=(-l "app.kubernetes.io/managed-by=${MANAGED_LABEL}")

echo ">> Contexto kubectl: $CTX"
echo ">> Escopo: ${NS_NAME:-todos os namespaces}"
$MANAGED_ONLY && echo ">> Filtro: somente PDBs gerenciados (managed-by=${MANAGED_LABEL})" \
              || echo ">> Filtro: TODOS os PDBs"
echo

# Lista (NAMESPACE<TAB>NAME) dos PDBs no escopo.
mapfile -t PDBS < <(kubectl get pdb $NS_SCOPE "${SELECTOR[@]}" \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}' 2>/dev/null)

if [[ ${#PDBS[@]} -eq 0 ]]; then
  echo "Nenhum PDB encontrado no escopo. Nada a fazer."
  exit 0
fi

echo "PDBs encontrados (${#PDBS[@]}):"
echo "---------------------------------------------------------------"
kubectl get pdb $NS_SCOPE "${SELECTOR[@]}" \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,MIN-AVAIL:.spec.minAvailable,MAX-UNAVAIL:.spec.maxUnavailable,ALLOWED-DISRUPTIONS:.status.disruptionsAllowed'
echo "---------------------------------------------------------------"
echo

if ! $DELETE; then
  echo ">> DRY-RUN: nada foi removido. Reexecute com --delete para apagar."
  exit 0
fi

if ! $ASSUME_YES; then
  echo "Voce esta prestes a REMOVER ${#PDBS[@]} PDB(s) do contexto: $CTX"
  read -r -p "Digite 'sim' para confirmar: " ans
  [[ "$ans" == "sim" ]] || { echo "Abortado."; exit 1; }
fi

echo ">> Removendo..."
for entry in "${PDBS[@]}"; do
  ns="${entry%%$'\t'*}"
  name="${entry#*$'\t'}"
  kubectl delete pdb "$name" -n "$ns"
done
echo ">> Concluido. Verifique com: kubectl get pdb -A"
