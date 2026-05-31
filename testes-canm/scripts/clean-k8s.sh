#!/usr/bin/env bash
#
# clean-k8s.sh
# -----------------------------------------------------------------------------
# Desfaz o que apply-pdb.sh e apply-graceful-shutdown.sh aplicaram:
#   1. Remove os PodDisruptionBudgets (por padrao so os gerenciados pelo
#      apply-pdb.sh: label app.kubernetes.io/managed-by=canm-pdb-script).
#   2. Reverte o graceful shutdown: remove lifecycle.preStop e zera o
#      terminationGracePeriodSeconds (volta ao default do cluster) nos
#      Deployments que tem o preStop.sleep aplicado pelo script.
#
# So toca em Deployments que REALMENTE tem o preStop.sleep -> nao dispara
# rolling restart em quem nao foi modificado.
#
# DRY-RUN por padrao (so lista / valida). Use --apply para executar.
#
# Flags:
#   --apply           Executa de fato (sem isso, so mostra o que faria).
#   --pdb-only        So remove PDBs (nao reverte graceful shutdown).
#   --graceful-only   So reverte graceful shutdown (nao remove PDBs).
#   --all-pdbs        Remove TODOS os PDBs, nao so os gerenciados.
#   --namespace=NS    Restringe a um namespace (default: todos menos sistema).
#   --yes | -y        Pula a confirmacao interativa.
# -----------------------------------------------------------------------------
set -euo pipefail

MANAGED_LABEL="canm-pdb-script"
EXCLUDE_NS=("kube-system" "kube-public" "kube-node-lease" "gke-managed-cim" \
            "gke-managed-system" "gmp-system" "gmp-public" "custom-metrics")

APPLY=false; YES=false; ALL_PDBS=false; NS_FILTER=""
DO_PDB=true; DO_GRACE=true
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --pdb-only) DO_GRACE=false ;;
    --graceful-only) DO_PDB=false ;;
    --all-pdbs) ALL_PDBS=true ;;
    --namespace=*) NS_FILTER="${arg#*=}" ;;
    --yes|-y) YES=true ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl nao encontrado no PATH" >&2; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo '???')"
echo ">> Contexto kubectl: $CTX"
echo ">> Escopo: ${NS_FILTER:-todos os namespaces menos sistema}"
$APPLY && echo ">> MODO: APPLY (remove/reverte de fato)" || echo ">> MODO: DRY-RUN (so mostra)"
echo

is_excluded_ns() { local ns="$1"; for ex in "${EXCLUDE_NS[@]}"; do [[ "$ns" == "$ex" ]] && return 0; done; return 1; }

# Escopo de namespace para kubectl (-A ou -n NS)
if [[ -n "$NS_FILTER" ]]; then PDB_SCOPE=(-n "$NS_FILTER"); else PDB_SCOPE=(-A); fi

# --- Levantamento ------------------------------------------------------------
PDB_SELECTOR=()
$ALL_PDBS || PDB_SELECTOR=(-l "app.kubernetes.io/managed-by=${MANAGED_LABEL}")

PDBS=()
if $DO_PDB; then
  mapfile -t PDBS < <(kubectl get pdb "${PDB_SCOPE[@]}" "${PDB_SELECTOR[@]}" \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}' 2>/dev/null)
fi

# Deployments (ns<TAB>nome<TAB>container) com preStop.sleep aplicado.
GRACE_TARGETS=()
if $DO_GRACE; then
  if [[ -n "$NS_FILTER" ]]; then DEP_SCOPE=(-n "$NS_FILTER"); else DEP_SCOPE=(-A); fi
  mapfile -t GRACE_TARGETS < <(kubectl get deploy "${DEP_SCOPE[@]}" -o json 2>/dev/null | python3 -c '
import sys, json
exclude = {"kube-system","kube-public","kube-node-lease","gke-managed-cim",
           "gke-managed-system","gmp-system","gmp-public","custom-metrics"}
ns_filter = sys.argv[1] if len(sys.argv) > 1 else ""
data = json.load(sys.stdin)
for it in data.get("items", []):
    ns = it["metadata"]["namespace"]; name = it["metadata"]["name"]
    if not ns_filter and ns in exclude:
        continue
    for c in it["spec"]["template"]["spec"].get("containers", []):
        ps = (c.get("lifecycle") or {}).get("preStop") or {}
        if "sleep" in ps:
            print("%s\t%s\t%s" % (ns, name, c["name"]))
' "$NS_FILTER")
fi

# --- Mostra o plano ----------------------------------------------------------
echo "== PDBs a remover (${#PDBS[@]}) =="
$DO_PDB || echo "   (pulado: --graceful-only)"
if $DO_PDB; then
  $ALL_PDBS && echo "   filtro: TODOS os PDBs" || echo "   filtro: gerenciados (managed-by=${MANAGED_LABEL})"
  for e in "${PDBS[@]}"; do echo "   - ${e//$'\t'//}"; done
  [[ ${#PDBS[@]} -eq 0 ]] && echo "   (nenhum)"
fi
echo
echo "== Deployments a reverter graceful shutdown (${#GRACE_TARGETS[@]}) =="
$DO_GRACE || echo "   (pulado: --pdb-only)"
if $DO_GRACE; then
  for e in "${GRACE_TARGETS[@]}"; do
    ns="${e%%$'\t'*}"; rest="${e#*$'\t'}"; name="${rest%%$'\t'*}"; ctr="${rest#*$'\t'}"
    echo "   - $ns/$name (container: $ctr): remove preStop + reseta grace"
  done
  [[ ${#GRACE_TARGETS[@]} -eq 0 ]] && echo "   (nenhum com preStop.sleep)"
fi
echo

TOTAL=$(( ${#PDBS[@]} + ${#GRACE_TARGETS[@]} ))
[[ $TOTAL -eq 0 ]] && { echo ">> Nada a fazer."; exit 0; }

if ! $APPLY; then
  echo ">> DRY-RUN: nada alterado. Reexecute com --apply para executar."
  exit 0
fi

if ! $YES; then
  echo "Voce vai REMOVER ${#PDBS[@]} PDB(s) e REVERTER ${#GRACE_TARGETS[@]} Deployment(s) no contexto: $CTX"
  echo "(reverter graceful shutdown dispara rolling restart desses Deployments)"
  read -r -p "Digite 'sim' para confirmar: " ans
  [[ "$ans" == "sim" ]] || { echo "Abortado."; exit 1; }
fi

# --- Execucao ----------------------------------------------------------------
if $DO_PDB; then
  echo ">> Removendo PDBs..."
  for e in "${PDBS[@]}"; do
    ns="${e%%$'\t'*}"; name="${e#*$'\t'}"
    kubectl delete pdb "$name" -n "$ns"
  done
fi

if $DO_GRACE; then
  echo ">> Revertendo graceful shutdown..."
  for e in "${GRACE_TARGETS[@]}"; do
    ns="${e%%$'\t'*}"; rest="${e#*$'\t'}"; name="${rest%%$'\t'*}"; ctr="${rest#*$'\t'}"
    read -r -d '' revert_patch <<EOF || true
spec:
  template:
    spec:
      terminationGracePeriodSeconds: null
      containers:
      - name: ${ctr}
        lifecycle:
          preStop: null
EOF
    if kubectl patch deploy "$name" -n "$ns" --type=strategic --patch "$revert_patch" >/dev/null 2>&1; then
      echo "   + $ns/$name -> preStop removido, grace resetado"
    else
      echo "   ! $ns/$name -> FALHA ao reverter" >&2
    fi
  done
fi

echo ">> Concluido. Verifique: kubectl get pdb -A ; kubectl rollout status deploy/<nome> -n default"
