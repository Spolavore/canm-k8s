#!/usr/bin/env python3
"""
Gera gráfico de utilização por nodo (CPU ou memória) a partir de CSV exportado do Grafana.

Formato esperado do CSV:
  "Time","node-a","node-b",...
  2026-05-24 16:48:30,38.0%,7.67%,...

Uso:
  python3 plot_cluster.py <caminho-csv> [--out <saida.png>]

Se --out não for informado, salva ao lado do CSV com sufixo _cluster.png.

Dependências:
  pip install pandas matplotlib
"""

import sys
import argparse
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import matplotlib.dates as mdates

DPI = 300
FIGSIZE = (12, 4)

COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
          '#9467bd', '#8c564b', '#e377c2', '#7f7f7f']


def _short_name(col: str) -> str:
    """Remove prefixo comum para deixar a legenda legível."""
    parts = col.split('-')
    return parts[-1] if parts else col


def load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df['ts'] = pd.to_datetime(df['Time'])
    df = df.drop(columns=['Time']).set_index('ts').sort_index()
    for col in df.columns:
        df[col] = df[col].astype(str).str.rstrip('%').astype(float)
    return df


def plot(df: pd.DataFrame, out: Path, ylabel: str, real_time: bool = False) -> None:
    fig, ax = plt.subplots(figsize=FIGSIZE)

    if real_time:
        x = df.index
        for i, col in enumerate(df.columns):
            ax.plot(x, df[col].values,
                    linewidth=1.8,
                    color=COLORS[i % len(COLORS)],
                    label=_short_name(col))
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
        ax.xaxis.set_major_locator(mdates.AutoDateLocator())
        fig.autofmt_xdate()
        ax.set_xlabel('Horário')
    else:
        t0 = df.index.min()
        elapsed = [(t - t0).total_seconds() / 60.0 for t in df.index]
        total_min = max(elapsed) if elapsed else 1
        for i, col in enumerate(df.columns):
            ax.plot(elapsed, df[col].values,
                    linewidth=1.8,
                    color=COLORS[i % len(COLORS)],
                    label=_short_name(col))
        step = max(1, int(total_min / 10))
        ax.xaxis.set_major_locator(ticker.MultipleLocator(step))
        ax.xaxis.set_minor_locator(ticker.MultipleLocator(1))
        ax.set_xlabel('Tempo (min)')

    ax.set_ylabel(ylabel)
    ax.set_ylim(0, 100)
    ax.yaxis.set_major_formatter(ticker.PercentFormatter(xmax=100))
    ax.grid(True, alpha=0.3)
    ax.legend(loc='upper right', fontsize=8)

    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out}')


def detect_ylabel(path: Path) -> str:
    name = path.stem.lower()
    if 'mem' in name or 'memoria' in name or 'memory' in name:
        return 'Memória utilizada (%)'
    return 'CPU utilizada (%)'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('csv', help='Caminho do CSV exportado do Grafana')
    parser.add_argument('--out', help='Arquivo PNG de saída (opcional)')
    parser.add_argument('--real-time', action='store_true',
                        help='Exibe horário real no eixo X em vez de tempo decorrido')
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(f'CSV não encontrado: {csv_path}')
        return 1

    out_path = Path(args.out) if args.out else csv_path.with_name(csv_path.stem + '_cluster.png')
    ylabel = detect_ylabel(csv_path)

    print(f'==> Lendo {csv_path}')
    df = load_csv(csv_path)
    print(f'    {len(df)} amostras, {len(df.columns)} nodos: {list(df.columns)}')

    print(f'==> Gerando gráfico ({ylabel}):')
    plot(df, out_path, ylabel, real_time=args.real_time)

    return 0


if __name__ == '__main__':
    sys.exit(main())
