#!/usr/bin/env bash
#
# apply-graceful-shutdown.sh
# -----------------------------------------------------------------------------
# Configura graceful shutdown / drain de trafego nos Deployments do relatorio
# de distribuicao de pods, adicionando:
#   - lifecycle.preStop com sleep nativo (default: 15s) -> da tempo do pod
#     sair do EndpointSlice/Service ANTES do app parar de aceitar conexoes,
#     fechando a corrida em que requisicoes ainda chegam ao pod Terminating;
#   - terminationGracePeriodSeconds (default: 30s) -> 15s do preStop + ~15s
#     para o app drenar requisicoes em voo apos o SIGTERM.
#
# Por que isto e' separado do PDB: o PDB so' limita disrupcoes voluntarias
# (quantos pods caem ao mesmo tempo num drain). Quem realmente evita perder
# requisicao em voo e' esta config NO POD. Sao ortogonais.
#
# Pre-requisitos do app para o drain funcionar de fato:
#   - tratar SIGTERM (parar de aceitar novas conexoes, finalizar in-flight);
#   - ter readinessProbe.
# Sem isso, o preStop ganha tempo mas o app pode cortar conexoes no SIGTERM.
#
# IMPORTANTE: alterar o template do Deployment dispara um ROLLING RESTART dos
# pods (novo pod-template-hash). Rode com cuidado (ex: --only=... gradualmente).
#
# DRY-RUN por padrao (valida via --dry-run=server, nao altera nada).
# Use --apply para aplicar de fato.
#
# Flags / env:
#   --apply              Aplica de fato (sem isso, so valida server-side).
#   --only=a,b,c         Restringe a esses Deployments (rollout gradual).
#   --file=PATH          Relatorio de distribuicao (default abaixo).
#   PRESTOP_SECONDS=15   Duracao do preStop sleep.
#   GRACE_SECONDS=30     terminationGracePeriodSeconds (DEVE ser > PRESTOP).
# -----------------------------------------------------------------------------
set -euo pipefail

DISTRIB_FILE="${DISTRIB_FILE:-testes-canm/workload/distribuicao-high.txt}"
PRESTOP_SECONDS="${PRESTOP_SECONDS:-15}"
GRACE_SECONDS="${GRACE_SECONDS:-30}"
EXCLUDE_NS=("kube-system" "custom-metrics" "gmp-system" "gke-managed-cim")

APPLY=false
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --only=*) ONLY="${arg#*=}" ;;
    --file=*) DISTRIB_FILE="${arg#*=}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl nao encontrado no PATH" >&2; exit 1; }
[[ -f "$DISTRIB_FILE" ]] || { echo "Arquivo nao encontrado: $DISTRIB_FILE" >&2; exit 1; }

# grace DEVE ser maior que o preStop, senao o kubelet manda SIGKILL durante o
# proprio sleep e o app nao tem tempo de drenar in-flight.
if (( GRACE_SECONDS <= PRESTOP_SECONDS )); then
  echo "ERRO: GRACE_SECONDS ($GRACE_SECONDS) deve ser MAIOR que PRESTOP_SECONDS ($PRESTOP_SECONDS)." >&2
  exit 1
fi

CTX="$(kubectl config current-context 2>/dev/null || echo '???')"
echo ">> Contexto kubectl: $CTX"
echo ">> preStop sleep: ${PRESTOP_SECONDS}s | terminationGracePeriodSeconds: ${GRACE_SECONDS}s"
$APPLY && echo ">> MODO: APPLY (dispara rolling restart dos Deployments alterados)" \
        || echo ">> MODO: DRY-RUN (--dry-run=server; nada e' alterado)"
[[ -n "$ONLY" ]] && echo ">> Restrito a: $ONLY"
echo

is_excluded_ns() { local ns="$1"; for ex in "${EXCLUDE_NS[@]}"; do [[ "$ns" == "$ex" ]] && return 0; done; return 1; }
in_only() { [[ -z "$ONLY" ]] && return 0; [[ ",$ONLY," == *",$1,"* ]]; }

mapfile -t POD_REFS < <(grep -oE '[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9.-]*' "$DISTRIB_FILE" | sort -u)
mapfile -t NAMESPACES < <(printf '%s\n' "${POD_REFS[@]}" | cut -d/ -f1 | sort -u)
pod_present_for() { printf '%s\n' "${POD_REFS[@]}" | grep -qE "^$1/$2-"; }

PATCHED=0; FAILED=0
for ns in "${NAMESPACES[@]}"; do
  is_excluded_ns "$ns" && continue
  # Apenas Deployments (StatefulSets como redis tem semantica de shutdown
  # diferente e ficam de fora por padrao).
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    pod_present_for "$ns" "$name" || continue
    in_only "$name" || continue

    # Container principal = o que tem o mesmo nome do Deployment; senao, o 1o.
    main_ctr="$(kubectl get deploy "$name" -n "$ns" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name==\"$name\")].name}" 2>/dev/null)"
    if [[ -z "$main_ctr" ]]; then
      main_ctr="$(kubectl get deploy "$name" -n "$ns" -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)"
      echo "   ~ $ns/$name: container != nome do deploy; usando o 1o container '$main_ctr'"
    fi

    read -r -d '' patch <<EOF || true
spec:
  template:
    spec:
      terminationGracePeriodSeconds: ${GRACE_SECONDS}
      containers:
      - name: ${main_ctr}
        lifecycle:
          preStop:
            sleep:
              seconds: ${PRESTOP_SECONDS}
EOF

    if $APPLY; then
      if kubectl patch deploy "$name" -n "$ns" --type=strategic --patch "$patch" >/dev/null 2>&1; then
        echo "   + $ns/$name (container: $main_ctr) -> patch aplicado"
        PATCHED=$((PATCHED+1))
      else
        echo "   ! $ns/$name -> FALHA no patch" >&2; FAILED=$((FAILED+1))
      fi
    else
      if kubectl patch deploy "$name" -n "$ns" --type=strategic --patch "$patch" --dry-run=server >/dev/null 2>&1; then
        echo "   = $ns/$name (container: $main_ctr) -> patch valido (dry-run)"
        PATCHED=$((PATCHED+1))
      else
        echo "   ! $ns/$name -> patch INVALIDO (dry-run)" >&2; FAILED=$((FAILED+1))
      fi
    fi
  done < <(kubectl get deploy -n "$ns" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
done

echo
echo ">> Deployments OK: $PATCHED | falhas: $FAILED"
$APPLY && echo ">> Acompanhe o rollout: kubectl rollout status deploy/<nome> -n default" \
        || echo ">> DRY-RUN: nada alterado. Reexecute com --apply (ou --apply --only=ecdt-api-beta para gradual)."
