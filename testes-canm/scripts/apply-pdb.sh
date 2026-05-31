#!/usr/bin/env bash
#
# apply-pdb.sh
# -----------------------------------------------------------------------------
# Cria um PodDisruptionBudget (maxUnavailable=1) para cada workload
# (Deployment/StatefulSet) descoberto DIRETAMENTE no cluster.
#
# - Descobre os namespaces via kubectl e ignora kube-system e namespaces de
#   infra/observabilidade gerenciados (ver EXCLUDE_NS). Use --namespace=NS
#   para restringir a um unico namespace.
# - O selector de cada PDB e' copiado do proprio .spec.selector.matchLabels
#   do workload (nao e' hardcoded), garantindo match exato dos pods.
# - DRY-RUN por padrao: so imprime os manifests. Use --apply para aplicar.
#
# IMPORTANTE (graceful shutdown): um PDB NAO drena trafego nem faz shutdown
# gracioso. Ele apenas LIMITA disrupcoes voluntarias (drain de nodo / eviction
# do autoscaler), garantindo que no maximo `maxUnavailable` pods do workload
# fiquem indisponiveis ao mesmo tempo. O drain de trafego em si e' feito pelo
# EndpointSlice controller + kube-proxy ao marcar o pod como Terminating, e
# isso e' racy. Para nao perder requisicoes em voo, configure NO POD:
#   - preStop hook (ex: sleep 10-15s) para a remocao do endpoint propagar
#     antes do app parar de aceitar conexoes;
#   - terminationGracePeriodSeconds adequado;
#   - tratamento de SIGTERM no app (parar de aceitar novas, drenar in-flight);
#   - readinessProbe.
# Ver apply-graceful-shutdown.sh. PDB e graceful shutdown sao ortogonais.
#
# Flags:
#   --apply          Aplica de fato (sem isso, so imprime os manifests).
#   --namespace=NS   Restringe a um namespace (default: todos menos EXCLUDE_NS).
# -----------------------------------------------------------------------------
set -euo pipefail

# ---- Configuracao -----------------------------------------------------------
MAX_UNAVAILABLE="${MAX_UNAVAILABLE:-1}"
MANAGED_LABEL="canm-pdb-script"
# Namespaces ignorados: kube-system (pedido) + system/observabilidade/gerenciados
# do GKE, onde PDB nao faz sentido ou nao deve ser tocado.
EXCLUDE_NS=("kube-system" "kube-public" "kube-node-lease" "gke-managed-cim" \
            "gke-managed-system" "gmp-system" "gmp-public" "custom-metrics")

APPLY=false
NS_FILTER=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --namespace=*) NS_FILTER="${arg#*=}" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

# ---- Pre-checks -------------------------------------------------------------
command -v kubectl >/dev/null || { echo "kubectl nao encontrado no PATH" >&2; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo '???')"
echo ">> Contexto kubectl: $CTX"
echo ">> maxUnavailable: $MAX_UNAVAILABLE"
[[ -n "$NS_FILTER" ]] && echo ">> Namespace: $NS_FILTER" || echo ">> Namespaces: todos menos os de sistema/gerenciados"
$APPLY && echo ">> MODO: APPLY (vai criar/atualizar PDBs)" \
        || echo ">> MODO: DRY-RUN (apenas imprime; use --apply para aplicar)"
echo

is_excluded_ns() {
  local ns="$1"
  for ex in "${EXCLUDE_NS[@]}"; do [[ "$ns" == "$ex" ]] && return 0; done
  return 1
}

# Lista de namespaces a processar.
if [[ -n "$NS_FILTER" ]]; then
  NAMESPACES=("$NS_FILTER")
else
  mapfile -t NAMESPACES < <(kubectl get ns -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | sort -u)
fi
[[ ${#NAMESPACES[@]} -gt 0 ]] || { echo "Nenhum namespace encontrado." >&2; exit 1; }

MANIFEST=""
COUNT=0

for ns in "${NAMESPACES[@]}"; do
  if [[ -z "$NS_FILTER" ]] && is_excluded_ns "$ns"; then
    echo "-- namespace ignorado: $ns"
    continue
  fi
  echo "== namespace: $ns =="

  # Lista Deployments e StatefulSets do namespace (KIND<TAB>NAME)
  while IFS=$'\t' read -r kind name; do
    [[ -z "$name" ]] && continue

    # Copia o selector real do workload -> garante match exato dos pods.
    labels_yaml="$(kubectl get "$kind" "$name" -n "$ns" \
      -o go-template='{{range $k,$v := .spec.selector.matchLabels}}      {{$k}}: {{$v}}
{{end}}')"
    if [[ -z "${labels_yaml// /}" ]]; then
      echo "   ! $kind/$name sem matchLabels no selector; pulando" >&2
      continue
    fi

    echo "   + PDB para $kind/$name"
    MANIFEST+="---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}-pdb
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: ${MANAGED_LABEL}
spec:
  maxUnavailable: ${MAX_UNAVAILABLE}
  selector:
    matchLabels:
${labels_yaml}
"
    COUNT=$((COUNT+1))
  done < <(kubectl get deploy,statefulset -n "$ns" \
            -o jsonpath='{range .items[*]}{.kind}{"\t"}{.metadata.name}{"\n"}{end}' 2>/dev/null)
done

echo
echo ">> Total de PDBs a aplicar: $COUNT"
[[ $COUNT -eq 0 ]] && { echo "Nada a fazer."; exit 0; }

echo "---------------------------------------------------------------"
printf '%s' "$MANIFEST"
echo "---------------------------------------------------------------"

if $APPLY; then
  echo ">> Aplicando..."
  printf '%s' "$MANIFEST" | kubectl apply -f -
  echo ">> Concluido. Verifique com: kubectl get pdb -A"
else
  echo ">> DRY-RUN: nada foi aplicado. Reexecute com --apply para criar os PDBs."
fi
