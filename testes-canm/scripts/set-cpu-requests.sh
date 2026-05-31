#!/usr/bin/env bash
#
# set-cpu-requests.sh
# -----------------------------------------------------------------------------
# Aumenta o CPU request dos Deployments (descobertos direto no cluster) para um
# valor alvo. Motivacao: requests muito baixos (ex: 10-20m) fazem o scheduler
# tratar um no novo/vazio como capacidade quase infinita e empilhar o workload
# drenado todo nele -> no satura no warmup -> timeouts (ver run pdb+gracefull).
# Requests realistas espalham os pods pela capacidade real.
#
# Define o request no valor alvo (sobe OU desce); pula quem ja esta exatamente
# no alvo (idempotente, nao dispara rollout desnecessario). So mexe no CPU
# (a memoria e' preservada). Patcha o container principal (nome == nome do deploy).
#
# NAO afeta a logica do CANM: o CANM pontua pelo uso REAL de CPU do no, nao
# pelos requests. Isto so melhora o placement durante o drain.
#
# IMPORTANTE: alterar o template dispara ROLLING RESTART. Requests maiores podem
# gerar pods Pending se faltar capacidade. Rode gradual (--only=...) e observe.
# Dica: dimensione o alvo com `kubectl top pods` (uso real) quando possivel.
#
# DRY-RUN por padrao (valida via --dry-run=server). Use --apply para aplicar.
#
# Flags / env:
#   --apply           Aplica de fato (sem isso, so valida server-side).
#   --cpu=VALOR       CPU request alvo (default: env CPU_REQUEST ou 50m).
#   --only=a,b,c      Restringe a esses Deployments (recomendado!).
#   --namespace=NS    Restringe a um namespace (default: todos menos sistema).
#   CPU_REQUEST=50m   Mesmo que --cpu=.
# -----------------------------------------------------------------------------
set -euo pipefail

CPU_REQUEST="${CPU_REQUEST:-50m}"
EXCLUDE_NS=("kube-system" "kube-public" "kube-node-lease" "gke-managed-cim" \
            "gke-managed-system" "gmp-system" "gmp-public" "custom-metrics")

APPLY=false
ONLY=""
NS_FILTER=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --cpu=*) CPU_REQUEST="${arg#*=}" ;;
    --only=*) ONLY="${arg#*=}" ;;
    --namespace=*) NS_FILTER="${arg#*=}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl nao encontrado no PATH" >&2; exit 1; }

# Converte quantidade de CPU do k8s para millicores: 150m->150, 1->1000, 0.5->500
to_millicores() {
  local v="$1"
  [[ -z "$v" ]] && { echo 0; return; }
  if [[ "$v" == *m ]]; then echo "${v%m}"; else awk "BEGIN{printf \"%d\", $v*1000}"; fi
}
TARGET_MC="$(to_millicores "$CPU_REQUEST")"
(( TARGET_MC > 0 )) || { echo "ERRO: --cpu invalido: '$CPU_REQUEST'" >&2; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo '???')"
echo ">> Contexto kubectl: $CTX"
echo ">> CPU request alvo: ${CPU_REQUEST} (${TARGET_MC}m)"
[[ -n "$NS_FILTER" ]] && echo ">> Namespace: $NS_FILTER" || echo ">> Namespaces: todos menos os de sistema/gerenciados"
[[ -n "$ONLY" ]] && echo ">> Restrito a: $ONLY"
$APPLY && echo ">> MODO: APPLY (dispara rolling restart dos alterados)" \
        || echo ">> MODO: DRY-RUN (--dry-run=server; nada e' alterado)"
echo

is_excluded_ns() { local ns="$1"; for ex in "${EXCLUDE_NS[@]}"; do [[ "$ns" == "$ex" ]] && return 0; done; return 1; }
in_only() { [[ -z "$ONLY" ]] && return 0; [[ ",$ONLY," == *",$1,"* ]]; }

if [[ -n "$NS_FILTER" ]]; then
  NAMESPACES=("$NS_FILTER")
else
  mapfile -t NAMESPACES < <(kubectl get ns -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | sort -u)
fi

PATCHED=0; SKIPPED=0; FAILED=0
for ns in "${NAMESPACES[@]}"; do
  if [[ -z "$NS_FILTER" ]] && is_excluded_ns "$ns"; then continue; fi
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    in_only "$name" || continue

    # Container principal = mesmo nome do deploy; senao, o 1o.
    main_ctr="$(kubectl get deploy "$name" -n "$ns" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name==\"$name\")].name}" 2>/dev/null)"
    [[ -z "$main_ctr" ]] && main_ctr="$(kubectl get deploy "$name" -n "$ns" -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)"

    cur="$(kubectl get deploy "$name" -n "$ns" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name==\"$main_ctr\")].resources.requests.cpu}" 2>/dev/null)"
    cur_mc="$(to_millicores "$cur")"

    if (( cur_mc == TARGET_MC )); then
      echo "   . $ns/$name: ja em ${cur:-<vazio>} (== alvo) -> pula"
      SKIPPED=$((SKIPPED+1)); continue
    fi

    patch="{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"${main_ctr}\",\"resources\":{\"requests\":{\"cpu\":\"${CPU_REQUEST}\"}}}]}}}}"
    label="$ns/$name (${cur:-<vazio>} -> ${CPU_REQUEST})"

    if $APPLY; then
      if kubectl patch deploy "$name" -n "$ns" --type=strategic --patch "$patch" >/dev/null 2>&1; then
        echo "   + $label -> aplicado"; PATCHED=$((PATCHED+1))
      else
        echo "   ! $label -> FALHA" >&2; FAILED=$((FAILED+1))
      fi
    else
      if kubectl patch deploy "$name" -n "$ns" --type=strategic --patch "$patch" --dry-run=server >/dev/null 2>&1; then
        echo "   = $label -> patch valido (dry-run)"; PATCHED=$((PATCHED+1))
      else
        echo "   ! $label -> patch INVALIDO (dry-run)" >&2; FAILED=$((FAILED+1))
      fi
    fi
  done < <(kubectl get deploy -n "$ns" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
done

echo
echo ">> A alterar: $PATCHED | ja >= alvo (pulados): $SKIPPED | falhas: $FAILED"
$APPLY && echo ">> Acompanhe: kubectl rollout status deploy/<nome> -n default ; e cheque Pending: kubectl get pods -A | grep Pending" \
        || echo ">> DRY-RUN: nada alterado. Reexecute com --apply (ou --apply --only=ecdt-busca-beta para gradual)."
