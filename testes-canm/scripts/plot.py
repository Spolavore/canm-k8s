#!/usr/bin/env python3
"""
Gera gráficos a partir do CSV de output do k6.

Uso:
  python3 plot.py <caminho-csv>

Gera 4 PNGs (300 dpi) no mesmo diretório do CSV:
  {basename}-01-throughput.png       — req/s ao longo do tempo + média móvel
  {basename}-02-latency.png          — p50/p95/p99 ao longo do tempo
  {basename}-03-errors.png           — taxa de erro (%) ao longo do tempo
  {basename}-04-latency-vs-rps.png   — latência média (Y) + req/s (Y' twin) no mesmo gráfico

Dependências:
  pip install pandas matplotlib
"""

import sys
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker

DPI = 300
FIGSIZE = (12, 4)


def load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df['ts'] = pd.to_datetime(df['timestamp'], unit='s')
    return df


def _elapsed_minutes(index: pd.DatetimeIndex, t0: pd.Timestamp) -> list[float]:
    return [(t - t0).total_seconds() / 60.0 for t in index]


def _format_xaxis(ax, elapsed_min: list[float]) -> None:
    ax.set_xlabel('Tempo (min)')
    total = max(elapsed_min) if elapsed_min else 1
    step = max(1, int(total / 10))
    ax.xaxis.set_major_locator(ticker.MultipleLocator(step))
    ax.xaxis.set_minor_locator(ticker.MultipleLocator(1))


def plot_throughput(df: pd.DataFrame, out: Path, _title: str) -> None:
    reqs = df[df['metric_name'] == 'http_reqs'].copy()
    if reqs.empty:
        print('  ! sem dados http_reqs — pulando throughput')
        return
    t0 = df['ts'].min()
    per_sec = reqs.set_index('ts').resample('1s')['metric_value'].sum()
    rolling = per_sec.rolling(10, min_periods=1).mean()
    x_ps = _elapsed_minutes(per_sec.index, t0)
    x_ro = _elapsed_minutes(rolling.index, t0)

    fig, ax = plt.subplots(figsize=FIGSIZE)
    ax.plot(x_ps, per_sec.values, linewidth=0.6, color='#1f77b4',
            alpha=0.5, label='req/s (bucket 1s)')
    ax.plot(x_ro, rolling.values, linewidth=2.0, color='#ff7f0e',
            label='média móvel 10s')
    ax.set_ylabel('Requisições por segundo')
    ax.grid(True, alpha=0.3)
    ax.legend(loc='upper left')
    _format_xaxis(ax, x_ps)
    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def plot_latency(df: pd.DataFrame, out: Path, _title: str) -> None:
    dur = df[df['metric_name'] == 'http_req_duration'].copy()
    if dur.empty:
        print('  ! sem dados http_req_duration — pulando latency')
        return
    t0 = df['ts'].min()
    dur = dur.set_index('ts').sort_index()
    grouped = dur['metric_value'].resample('5s')
    p50 = grouped.quantile(0.50)
    p95 = grouped.quantile(0.95)
    p99 = grouped.quantile(0.99)
    x = _elapsed_minutes(p50.index, t0)

    fig, ax = plt.subplots(figsize=FIGSIZE)
    ax.plot(x, p50.values, label='p50', linewidth=1.5, color='#2ca02c')
    ax.plot(x, p95.values, label='p95', linewidth=1.5, color='#ff7f0e')
    ax.plot(x, p99.values, label='p99', linewidth=1.5, color='#d62728')
    ax.set_ylabel('Latência (ms)')
    ax.grid(True, alpha=0.3)
    ax.legend(loc='upper left')
    _format_xaxis(ax, x)
    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def plot_errors(df: pd.DataFrame, out: Path, _title: str) -> None:
    failed = df[df['metric_name'] == 'http_req_failed'].copy()
    if failed.empty:
        print('  ! sem dados http_req_failed — pulando errors')
        return
    t0 = df['ts'].min()
    failed = failed.set_index('ts').sort_index()
    per_sec_total = failed['metric_value'].resample('1s').count()
    per_sec_fail = failed['metric_value'].resample('1s').sum()
    err_rate = (per_sec_fail / per_sec_total * 100).fillna(0)
    x = _elapsed_minutes(err_rate.index, t0)

    fig, ax = plt.subplots(figsize=FIGSIZE)
    ax.fill_between(x, 0, err_rate.values, color='#d62728', alpha=0.3)
    ax.plot(x, err_rate.values, color='#d62728', linewidth=1.2)
    ax.set_ylabel('Taxa de erro (%)')
    ax.grid(True, alpha=0.3)
    ax.set_ylim(0, max(5.0, err_rate.max() * 1.2))
    _format_xaxis(ax, x)
    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def plot_latency_vs_rps(df: pd.DataFrame, out: Path, _title: str) -> None:
    dur = df[df['metric_name'] == 'http_req_duration'].copy()
    reqs = df[df['metric_name'] == 'http_reqs'].copy()
    if dur.empty or reqs.empty:
        print('  ! dados insuficientes — pulando latency-vs-rps')
        return
    t0 = df['ts'].min()

    dur = dur.set_index('ts').sort_index()
    lat_avg_s = dur['metric_value'].resample('5s').mean() / 1000.0
    x_lat = _elapsed_minutes(lat_avg_s.index, t0)

    per_sec = reqs.set_index('ts').sort_index().resample('1s')['metric_value'].sum()
    rps_rolling = per_sec.rolling(10, min_periods=1).mean()
    x_rps = _elapsed_minutes(rps_rolling.index, t0)

    fig, ax1 = plt.subplots(figsize=FIGSIZE)
    color1 = '#1f77b4'
    ax1.set_ylabel('Latência média 5s (s)', color=color1)
    line1, = ax1.plot(x_lat, lat_avg_s.values,
                      color=color1, linewidth=1.6, label='Latência média (s)')
    ax1.tick_params(axis='y', labelcolor=color1)
    ax1.grid(True, alpha=0.3)
    _format_xaxis(ax1, x_lat)

    ax2 = ax1.twinx()
    color2 = '#ff7f0e'
    ax2.set_ylabel('Requisições por segundo', color=color2)
    line2, = ax2.plot(x_rps, rps_rolling.values,
                      color=color2, linewidth=1.6, label='req/s (rolling 10s)')
    ax2.tick_params(axis='y', labelcolor=color2)

    ax1.legend(handles=[line1, line2], loc='upper left')

    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    csv_path = Path(sys.argv[1])
    if not csv_path.exists():
        print(f'CSV não encontrado: {csv_path}')
        return 1

    print(f'==> Lendo {csv_path}')
    df = load_csv(csv_path)
    print(f'    {len(df):,} linhas')

    title_suffix = csv_path.stem
    base = csv_path.parent / csv_path.stem

    print('==> Gerando gráficos:')
    plot_throughput(df, base.with_name(base.name + '-01-throughput.png'), title_suffix)
    plot_latency(df, base.with_name(base.name + '-02-latency.png'), title_suffix)
    plot_errors(df, base.with_name(base.name + '-03-errors.png'), title_suffix)
    plot_latency_vs_rps(df, base.with_name(base.name + '-04-latency-vs-rps.png'), title_suffix)

    print(f'==> Outputs em {csv_path.parent}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
