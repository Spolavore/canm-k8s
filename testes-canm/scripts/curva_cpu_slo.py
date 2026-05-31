#!/usr/bin/env python3
"""
Cruza utilização de CPU (em janela, como o score do CANM) com latência p95 e
taxa de erro do k6, para um cenário, e localiza o "joelho" do SLO — o nível de
CPU a partir do qual a latência/erro disparam. É a base científica para escolher
HIGH_SCORE_THRESHOLD / LOW_SCORE_THRESHOLD.

Para cada minuto decorrido do teste:
  - CPU  = média entre nós da CPU%, suavizada por janela móvel (default 5 min)
           — espelha o `rate(...)[time_window]` que o CANM usa no score.
  - p95  = percentil 95 de http_req_duration (ms) naquele minuto.
  - erro = % de http_req_failed naquele minuto.
Depois agrupa por faixa de CPU (bins de 10%) e mostra p95/erro medianos por faixa.

Alinhamento: k6 e Grafana são alinhados por TEMPO DECORRIDO do início de cada
série (ambos cobrem a mesma janela do teste), evitando dor de cabeça de fuso.

Uso:
  python3 curva_cpu_slo.py <pasta-do-cenario> [--window 5min] [--label "low dia-util"]

A pasta deve conter o CSV do k6 (*dia-util.csv / *fim-semana.csv) e o
grafana-cpu-*.csv. Saída: tabela no terminal + PNG <pasta>/curva-cpu-slo.png.

Dependências: pandas, numpy, matplotlib (venv em scripts/.venv).
"""

import sys
import argparse
from pathlib import Path

import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def find(folder: Path, *patterns: str) -> Path:
    for pat in patterns:
        hits = sorted(folder.glob(pat))
        if hits:
            return hits[0]
    raise FileNotFoundError(f'Nenhum arquivo {patterns} em {folder}')


def load_k6(path: Path) -> pd.DataFrame:
    """Lê só as colunas necessárias do CSV gigante do k6."""
    df = pd.read_csv(path, usecols=['metric_name', 'timestamp', 'metric_value'],
                     dtype={'metric_name': 'category'})
    df['ts'] = pd.to_datetime(df['timestamp'], unit='s')
    df['elapsed_min'] = ((df['ts'] - df['ts'].min()).dt.total_seconds() // 60).astype(int)
    return df


def k6_per_minute(df: pd.DataFrame) -> pd.DataFrame:
    dur = df[df['metric_name'] == 'http_req_duration']
    fail = df[df['metric_name'] == 'http_req_failed']
    p95 = dur.groupby('elapsed_min')['metric_value'].quantile(0.95).rename('p95_ms')
    rps = dur.groupby('elapsed_min')['metric_value'].count().div(60).rename('rps')
    err = fail.groupby('elapsed_min')['metric_value'].mean().mul(100).rename('erro_pct')
    return pd.concat([p95, err, rps], axis=1)


def load_cpu(path: Path, window: str, agg: str = 'mean') -> pd.DataFrame:
    df = pd.read_csv(path)
    tcol = [c for c in df.columns if c.lower() == 'time'][0]
    df['ts'] = pd.to_datetime(df[tcol])
    df = df.drop(columns=[tcol]).set_index('ts').sort_index()
    for c in df.columns:
        df[c] = df[c].astype(str).str.rstrip('%').astype(float)
    # 'mean' = média entre nós (carga do cluster); 'max' = nó mais quente
    # (espelha o score POR NÓ, que é o que o CANM de fato compara ao threshold)
    cluster = df.max(axis=1) if agg == 'max' else df.mean(axis=1)
    smoothed = cluster.rolling(window, min_periods=1).mean()   # janela móvel = score
    out = pd.DataFrame({'cpu_pct': smoothed})
    out['elapsed_min'] = ((out.index - out.index.min()).total_seconds() // 60).astype(int)
    return out.groupby('elapsed_min')['cpu_pct'].mean().to_frame()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder', help='Pasta do cenário (k6 csv + grafana-cpu csv)')
    ap.add_argument('--window', default='5min', help='Janela móvel da CPU (default 5min)')
    ap.add_argument('--agg', default='mean', choices=['mean', 'max'],
                    help="mean = média entre nós; max = nó mais quente (= score por nó)")
    ap.add_argument('--label', default=None, help='Rótulo para títulos/saída')
    args = ap.parse_args()

    folder = Path(args.folder).resolve()
    label = args.label or folder.name

    k6_path = find(folder, '*dia-util.csv', '*fim-semana.csv',
                   '*dia-util-dia-util.csv', '*fim-semana-fim-semana.csv')
    cpu_path = find(folder, 'grafana-cpu-*.csv')
    print(f'==> k6:   {k6_path.name}')
    print(f'==> cpu:  {cpu_path.name}')
    print(f'==> janela CPU: {args.window}')

    k6 = k6_per_minute(load_k6(k6_path))
    cpu = load_cpu(cpu_path, args.window, args.agg)
    m = cpu.join(k6, how='inner').dropna(subset=['p95_ms'])
    print(f'==> {len(m)} minutos alinhados\n')

    # Agrupa por faixa de CPU (bins de 10%)
    bins = list(range(0, 101, 10))
    m['faixa'] = pd.cut(m['cpu_pct'], bins=bins, right=False)
    g = m.groupby('faixa', observed=True).agg(
        n=('p95_ms', 'size'),
        p95_med=('p95_ms', 'median'),
        erro_med=('erro_pct', 'median'),
        rps_med=('rps', 'median'),
    )

    print(f'CURVA CPU × SLO — {label}')
    print('─' * 64)
    print(f'{"CPU (janela)":>14} {"min":>4} {"p95 med (ms)":>13} {"erro med %":>11} {"rps":>7}')
    print('─' * 64)
    for faixa, row in g.iterrows():
        lo = int(faixa.left)
        print(f'{f"{lo:>3}-{lo+10:<3}%":>14} {int(row.n):>4} '
              f'{row.p95_med:>13.0f} {row.erro_med:>11.2f} {row.rps_med:>7.1f}')
    print('─' * 64)

    # Joelho: primeira faixa cujo p95 mediano > 1.5× o p95 das faixas de CPU baixa (<40%)
    base = m.loc[m['cpu_pct'] < 40, 'p95_ms'].median()
    knee = None
    for faixa, row in g.iterrows():
        if int(faixa.left) >= 40 and row.p95_med > 1.5 * base:
            knee = int(faixa.left)
            break
    print(f'p95 base (CPU<40%): {base:.0f} ms')
    if knee is not None:
        print(f'JOELHO do SLO ≈ {knee}–{knee+10}% de CPU '
              f'(p95 passa de {1.5*base:.0f} ms = 1,5× a base)')
    else:
        print('Sem joelho claro nas faixas medidas (p95 não chegou a 1,5× a base).')

    # Plot dual-axis: CPU no x, p95 e erro no y
    ms = m.sort_values('cpu_pct')
    fig, ax1 = plt.subplots(figsize=(9, 5))
    ax1.scatter(ms['cpu_pct'], ms['p95_ms'], s=14, color='#1f77b4', alpha=0.6, label='p95 (ms)')
    ax1.set_xlabel('CPU média do cluster, janela ' + args.window + ' (%)')
    ax1.set_ylabel('p95 latência (ms)', color='#1f77b4')
    ax1.tick_params(axis='y', labelcolor='#1f77b4')
    ax1.grid(True, alpha=0.3)
    if knee is not None:
        ax1.axvline(knee, color='#d62728', linestyle='--', linewidth=1.5,
                    label=f'joelho ≈ {knee}%')
    ax2 = ax1.twinx()
    ax2.scatter(ms['cpu_pct'], ms['erro_pct'], s=14, color='#ff7f0e', alpha=0.6, marker='^')
    ax2.set_ylabel('erro (%)', color='#ff7f0e')
    ax2.tick_params(axis='y', labelcolor='#ff7f0e')
    ax1.set_title(f'CPU × SLO — {label}')
    ax1.legend(loc='upper left', fontsize=8)
    out = folder / 'curva-cpu-slo.png'
    fig.tight_layout()
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f'\n==> gráfico: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
