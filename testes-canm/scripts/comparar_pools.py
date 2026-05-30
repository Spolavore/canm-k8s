#!/usr/bin/env python3
"""
Compara dois pools de nodos (ex: high N2 × low E2) a partir dos dados brutos
de cada execução e gera o markdown comparativo (tabelas k6 + recursos do cluster).

Reproduz a análise de `comparacao-high-vs-low.md` de forma automática, lendo:

  <pool>/<cenario>/*summary.txt              → métricas k6 (reqs, falhas, latência)
  <pool>/<cenario>/grafana-cpu-*.csv         → CPU por nodo (Grafana, "Time" + 1 col/nó)
  <pool>/<cenario>/grafana-mem-*.csv         → MEM por nodo

As métricas de cluster são derivadas dos CSVs do Grafana (validadas contra a
análise original):
  - avg cluster      = média de todas as células (todos os nós × todo o tempo)
  - pico (nó)        = maior célula isolada
  - pico médio/nó    = média dos picos de cada nó (max por coluna, depois média)

Uso:
  python3 comparar_pools.py
  python3 comparar_pools.py --high high-node --low low-node \\
      --high-label "N2" --low-label "E2" \\
      --scenarios econodata-dia-util econodata-fim-semana \\
      --out comparacao-pools-gerado.md

Por padrão escreve em `comparacao-pools-gerado.md` na raiz de testes-canm —
NÃO sobrescreve `comparacao-high-vs-low.md` (curado à mão, com ressalvas que
o script não consegue regenerar).

Dependências: pandas, numpy (use o venv: scripts/.venv).
"""

import sys
import re
import glob
import argparse
from pathlib import Path

import pandas as pd
import numpy as np

# Raiz de testes-canm = pai da pasta scripts/
ROOT = Path(__file__).resolve().parent.parent

# Limiares para as leituras automáticas (heurísticas, revisar antes de publicar)
SATURACAO_PCT = 95.0   # pico de nó acima disso = "satura"
PICO_ALTO_PCT = 85.0   # pico médio/nó acima disso = "pressão alta"


# ── parsing k6 ────────────────────────────────────────────────────────────────

def parse_summary(path: Path) -> dict:
    """Extrai métricas do relatório textual do k6 (summary.txt)."""
    txt = path.read_text()

    def grab(pattern, cast=float):
        m = re.search(pattern, txt)
        return cast(m.group(1)) if m else None

    total = grab(r'Total de requisi\w+\s*:\s*([\d.]+)', lambda s: int(s.replace('.', '')))
    fails = grab(r'Falhas\s*:\s*(\d+)', int)
    fail_pct = grab(r'Falhas\s*:\s*\d+\s*\(([\d.]+)%\)')
    return {
        'total':    total,
        'fails':    fails,
        'fail_pct': fail_pct,
        'rps':      grab(r'Throughput\s*:\s*([\d.]+)\s*req/s'),
        'avg_ms':   grab(r'Lat\w+\s*avg\s*:\s*([\d.]+)\s*ms'),
        'p50_ms':   grab(r'p50\s*:\s*([\d.]+)\s*ms'),
        'p95_ms':   grab(r'p95\s*:\s*([\d.]+)\s*ms'),
        'p99_ms':   grab(r'p99\s*:\s*([\d.]+)\s*ms'),
    }


# ── parsing recursos (Grafana) ──────────────────────────────────────────────────

def load_grafana(path: Path) -> pd.DataFrame:
    """CSV do Grafana: 'Time' + 1 coluna por nó, valores como 'NN.N%'."""
    df = pd.read_csv(path)
    df = df.drop(columns=[c for c in df.columns if c.lower() == 'time'])
    for col in df.columns:
        df[col] = df[col].astype(str).str.rstrip('%').astype(float)
    return df


def cluster_stats(df: pd.DataFrame) -> dict:
    return {
        'avg':           float(df.values.mean()),
        'pico_no':       float(df.values.max()),
        'pico_por_no':   float(df.max(axis=0).mean()),
        'nodes':         len(df.columns),
    }


def find_one(folder: Path, pattern: str) -> Path | None:
    hits = sorted(folder.glob(pattern))
    return hits[0] if hits else None


def collect(pool_dir: Path, scenario: str) -> dict:
    """Junta k6 + CPU + MEM de um pool×cenário. Tolera nomes irregulares via glob."""
    folder = pool_dir / scenario
    if not folder.is_dir():
        return {}

    out = {'k6': None, 'cpu': None, 'mem': None}

    sumf = find_one(folder, '*summary.txt')
    if sumf:
        out['k6'] = parse_summary(sumf)

    cpuf = find_one(folder, 'grafana-cpu-*.csv')
    if cpuf:
        out['cpu'] = cluster_stats(load_grafana(cpuf))

    memf = find_one(folder, 'grafana-mem-*.csv')
    if memf:
        out['mem'] = cluster_stats(load_grafana(memf))

    return out


def count_pods(path: Path) -> int | None:
    """Conta pods num relatório distribuicao-*.txt (linhas '  - [...]')."""
    if not path.exists():
        return None
    return sum(1 for ln in path.read_text().splitlines() if ln.strip().startswith('- ['))


# ── formatação ──────────────────────────────────────────────────────────────────

def pct_delta(low, high):
    """Δ percentual de low em relação a high (sinal indica direção)."""
    if high in (None, 0) or low is None:
        return '—'
    d = (low - high) / high * 100
    return f'{d:+.1f}%'


def ratio_x(low, high):
    """Razão low/high como '×' (para falhas)."""
    if not high or low is None:
        return '—'
    if high == 0:
        return 'n/a (high=0)' if low else '≈ igual'
    return f'{low / high:.1f}×'


def f1(v, suf=''):
    return f'{v:.1f}{suf}' if v is not None else '—'


def k6_table(hi, lo, hl, ll):
    if not (hi and lo):
        return '_(sem dados k6)_\n'
    rows = [
        ('Total requisições', f'{hi["total"]:,}'.replace(',', '.') if hi['total'] else '—',
                              f'{lo["total"]:,}'.replace(',', '.') if lo['total'] else '—',
                              pct_delta(lo['total'], hi['total'])),
        ('Throughput', f1(hi['rps'], ' req/s'), f1(lo['rps'], ' req/s'), pct_delta(lo['rps'], hi['rps'])),
        ('Falhas', f'{hi["fails"]} ({f1(hi["fail_pct"])}%)', f'{lo["fails"]} ({f1(lo["fail_pct"])}%)',
                   ratio_x(lo['fails'], hi['fails']) + ' erro'),
        ('Latência avg', f1(hi['avg_ms'], ' ms'), f1(lo['avg_ms'], ' ms'), pct_delta(lo['avg_ms'], hi['avg_ms'])),
        ('p50', f1(hi['p50_ms'], ' ms'), f1(lo['p50_ms'], ' ms'), pct_delta(lo['p50_ms'], hi['p50_ms'])),
        ('**p95**', f1(hi['p95_ms'], ' ms'), f'**{f1(lo["p95_ms"], " ms")}**', '**' + pct_delta(lo['p95_ms'], hi['p95_ms']) + '**'),
    ]
    L = [f'| Métrica | {hl} | {ll} | Δ ({ll} vs {hl}) |',
         '|---|--:|--:|---|']
    for name, h, l, d in rows:
        L.append(f'| {name} | {h} | {l} | {d} |')
    return '\n'.join(L) + '\n'


def recursos_rows(label, hi, lo, hl, ll):
    """Linhas da tabela de recursos para um cenário (CPU + MEM)."""
    out = []
    if hi.get('cpu') and lo.get('cpu'):
        c_hi, c_lo = hi['cpu'], lo['cpu']
        ratio = c_lo['avg'] / c_hi['avg'] if c_hi['avg'] else 0
        out += [
            (f'{label} — **CPU** avg cluster', c_hi['avg'], c_lo['avg'],
             f'{ll} usa ~{ratio:.1f}× a CPU do {hl} pela mesma carga'),
            (f'{label} — CPU pico (nó)', c_hi['pico_no'], c_lo['pico_no'],
             f'{ll} **satura**' if c_lo['pico_no'] >= SATURACAO_PCT else 'pico de nó isolado'),
            (f'{label} — CPU pico médio/nó', c_hi['pico_por_no'], c_lo['pico_por_no'],
             'todos os nós sob forte pressão' if c_lo['pico_por_no'] >= PICO_ALTO_PCT else 'média dos picos por nó'),
        ]
    if hi.get('mem') and lo.get('mem'):
        m_hi, m_lo = hi['mem'], lo['mem']
        leitura = f'{ll} com mais folga de RAM' if m_lo['avg'] < m_hi['avg'] else 'RAM não é o gargalo'
        out.append((f'{label} — MEM avg cluster', m_hi['avg'], m_lo['avg'], leitura))
    return out


def recursos_table(scen_data, scen_labels, hl, ll):
    L = [f'| Cenário / métrica | {hl} | {ll} | Leitura |',
         '|---|--:|--:|---|']
    for scen, label in scen_labels.items():
        hi, lo = scen_data[scen]
        for name, h, l, leitura in recursos_rows(label, hi, lo, hl, ll):
            mark = '**' if ('pico (nó)' in name and l >= SATURACAO_PCT) else ''
            L.append(f'| {name} | {f1(h)}% | {mark}{f1(l)}%{mark} | {leitura} |')
    return '\n'.join(L) + '\n'


def auto_conclusoes(scen_data, scen_labels, hl, ll):
    """Bullets data-driven baseados em limiares. Revisar antes de publicar."""
    bullets = []
    # CPU ratio médio
    ratios = []
    for scen in scen_labels:
        hi, lo = scen_data[scen]
        if hi.get('cpu') and lo.get('cpu') and hi['cpu']['avg']:
            ratios.append(lo['cpu']['avg'] / hi['cpu']['avg'])
    if ratios:
        bullets.append(
            f'**CPU é o diferenciador.** Para a mesma carga, o {ll} consome em média '
            f'~{np.mean(ratios):.1f}× a CPU do {hl} entre os cenários medidos. '
            f'A memória ficou mais folgada no {ll}, então RAM não restringe — o gargalo é CPU.')
    # Saturação por cenário
    for scen, label in scen_labels.items():
        hi, lo = scen_data[scen]
        if not (lo.get('cpu') and hi.get('k6') and lo.get('k6')):
            continue
        pico = lo['cpu']['pico_no']
        if pico >= SATURACAO_PCT:
            erro_x = ratio_x(lo['k6']['fails'], hi['k6']['fails'])
            p95d = pct_delta(lo['k6']['p95_ms'], hi['k6']['p95_ms'])
            bullets.append(
                f'**No {label.lower()} o {ll} satura nos picos** (pico de nó {pico:.1f}%). '
                f'Essa saturação acompanha {erro_x} de erro e p95 {p95d} frente ao {hl}.')
        else:
            bullets.append(
                f'**No {label.lower()} o {ll} é confortável** (pico de nó {pico:.1f}%, sem saturação). '
                f'A carga cabe no pool barato.')
    # Implicação CANM (linguagem alinhada: reativo a métricas / orientado a custo, nunca "proativo")
    bullets.append(
        f'**Implicação para o CANM** (reativo a métricas de utilização / orientado a custo): '
        f'em janelas de baixo tráfego, descer para o pool barato ({ll}) é seguro e economiza; '
        f'em picos onde o {ll} satura, o CANM precisa manter/subir para o pool {hl}.')
    return '\n'.join(f'{i+1}. {b}' for i, b in enumerate(bullets))


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--high', default='high-node', help='Pasta do pool high (rel. a testes-canm)')
    ap.add_argument('--low', default='low-node', help='Pasta do pool low (rel. a testes-canm)')
    ap.add_argument('--high-label', default='N2', help='Rótulo do pool high (ex: N2)')
    ap.add_argument('--low-label', default='E2', help='Rótulo do pool low (ex: E2)')
    ap.add_argument('--scenarios', nargs='+',
                    default=['econodata-dia-util', 'econodata-fim-semana'],
                    help='Cenários a comparar (subpastas de cada pool)')
    ap.add_argument('--out', default='comparacao-pools-gerado.md',
                    help='Markdown de saída (rel. a testes-canm)')
    args = ap.parse_args()

    high_dir = (ROOT / args.high).resolve()
    low_dir = (ROOT / args.low).resolve()
    hl, ll = args.high_label, args.low_label

    if not high_dir.is_dir() or not low_dir.is_dir():
        print(f'Pastas não encontradas: {high_dir} / {low_dir}')
        return 1

    # Rótulos legíveis dos cenários (capitaliza, troca hífens)
    def nice(s):
        return s.replace('econodata-', '').replace('-', ' ').strip().capitalize()
    scen_labels = {s: nice(s) for s in args.scenarios}

    scen_data = {}
    print(f'==> Comparando {hl} ({args.high}) × {ll} ({args.low})')
    for scen in args.scenarios:
        hi = collect(high_dir, scen)
        lo = collect(low_dir, scen)
        scen_data[scen] = (hi, lo)
        print(f'    {scen}: high k6={"ok" if hi.get("k6") else "—"} '
              f'cpu={"ok" if hi.get("cpu") else "—"} | '
              f'low k6={"ok" if lo.get("k6") else "—"} cpu={"ok" if lo.get("cpu") else "—"}')

    # Pods (mecânico, para ressalvas)
    pods_hi = count_pods(ROOT / f'distribuicao-{args.high.replace("-node", "")}.txt')
    pods_lo = count_pods(ROOT / f'distribuicao-{args.low.replace("-node", "")}.txt')

    # ── montar markdown ──
    md = []
    md.append(f'# Comparação {hl} (high) × {ll} (low) — gerado automaticamente\n')
    md.append(f'> Gerado por `scripts/comparar_pools.py` a partir dos dados brutos em '
              f'`{args.high}/` e `{args.low}/`.\n'
              f'> high = pool série **{hl}**; low = pool série **{ll}**.\n'
              f'> **Revise as conclusões e preencha as ressalvas manuais antes de publicar.**\n')

    md.append('## 1. Resultados k6 (cliente)\n')
    for scen, label in scen_labels.items():
        hi, lo = scen_data[scen]
        md.append(f'### {label}\n')
        md.append(k6_table(hi.get('k6'), lo.get('k6'), hl, ll))

    md.append('## 2. Consumo de recursos no cluster (Grafana)\n')
    md.append(recursos_table(scen_data, scen_labels, hl, ll))
    md.append('')

    md.append('## 3. Conclusões (auto — revisar)\n')
    md.append(auto_conclusoes(scen_data, scen_labels, hl, ll))
    md.append('')

    md.append('## 4. Ressalvas\n')
    if pods_hi is not None and pods_lo is not None:
        md.append(f'- **Pods:** {hl}/high {pods_hi} × {ll}/low {pods_lo} '
                  f'(contados em `distribuicao-*.txt`).')
    md.append('- **Versão de build:** _verificar manualmente se os hashes batem entre os pools._')
    md.append('- **Nº de execuções por cenário:** _preencher (o design prevê 2× p/ reprodutibilidade)._')
    md.append('- **Colocação de redis/serviços:** _verificar manualmente se há concentração de I/O num nó._')
    md.append('')

    out_path = ROOT / args.out
    out_path.write_text('\n'.join(md))
    print(f'==> Escrito: {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
