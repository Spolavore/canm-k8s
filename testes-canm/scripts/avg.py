#!/usr/bin/env python3
"""
Calcula a média das N execuções de um cenário k6 e gera gráficos + summary.

Uso:
  python3 avg.py <pasta-do-cenario>

Exemplo:
  python3 avg.py tests/descoberta-bottleneck/

A pasta deve conter subpastas numeradas (1/, 2/, 3/...), cada uma com um
arquivo *.csv gerado pelo k6 --out csv=.

Saída em <pasta>/avg/:
  avg-01-throughput.png
  avg-02-latency.png
  avg-03-errors.png
  avg-04-latency-vs-rps.png
  avg-summary.txt
"""

import sys
import re
from pathlib import Path

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker

DPI = 300
FIGSIZE = (12, 4)
COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd']


# ── carregamento ─────────────────────────────────────────────────────────────

def load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df['ts'] = pd.to_datetime(df['timestamp'], unit='s')
    return df


def to_elapsed(series: pd.Series, t0: pd.Timestamp) -> pd.Series:
    return (series - t0).dt.total_seconds()


def discover_csvs(base: Path) -> list[Path]:
    """Encontra o CSV mais recente em cada subpasta numerada."""
    runs = []
    for sub in sorted(base.iterdir()):
        if not sub.is_dir() or not re.fullmatch(r'\d+', sub.name):
            continue
        csvs = sorted(sub.glob('*.csv'), key=lambda p: p.stat().st_mtime)
        if csvs:
            runs.append(csvs[-1])
    return runs


# ── alinhamento por tempo decorrido ──────────────────────────────────────────

def align_series(series_list: list[pd.Series], freq: str) -> pd.DataFrame:
    """
    Cada série tem índice DatetimeIndex. Converte para segundos decorridos,
    reamostrada em `freq`, alinha pelo índice numérico e retorna DataFrame
    onde cada coluna é uma run.
    """
    elapsed_list = []
    for i, s in enumerate(series_list):
        t0 = s.index.min()
        s_el = s.copy()
        s_el.index = (s.index - t0).total_seconds()
        elapsed_list.append(s_el.rename(f'run{i+1}'))

    df = pd.concat(elapsed_list, axis=1)
    df.index = pd.to_timedelta(df.index, unit='s')
    df = df.resample(freq).mean()
    # índice em minutos para plotar
    df.index = df.index.total_seconds() / 60.0
    return df


# ── eixo X ───────────────────────────────────────────────────────────────────

def _format_xaxis(ax, max_min: float) -> None:
    ax.set_xlabel('Tempo (min)')
    step = max(1, int(max_min / 10))
    ax.xaxis.set_major_locator(ticker.MultipleLocator(step))
    ax.xaxis.set_minor_locator(ticker.MultipleLocator(1))


# ── plots ─────────────────────────────────────────────────────────────────────

def plot_throughput(dfs: list[pd.DataFrame], out: Path) -> None:
    series = []
    for df in dfs:
        reqs = df[df['metric_name'] == 'http_reqs'].copy()
        if reqs.empty:
            continue
        s = reqs.set_index('ts').resample('1s')['metric_value'].sum()
        series.append(s)

    if not series:
        return

    aligned = align_series(series, '1s')
    avg = aligned.mean(axis=1)
    x = aligned.index.values

    fig, ax = plt.subplots(figsize=FIGSIZE)
    for i, col in enumerate(aligned.columns):
        ax.plot(x, aligned[col].values, linewidth=0.6,
                color=COLORS[i % len(COLORS)], alpha=0.35, label=f'run {i+1}')
    ax.plot(x, avg.values, linewidth=2.2, color='#2c2c2c', label='média')
    ax.set_ylabel('Requisições por segundo')
    ax.grid(True, alpha=0.3)
    ax.legend(loc='upper left', fontsize=8)
    _format_xaxis(ax, x[-1] if len(x) else 1)
    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def plot_latency(dfs: list[pd.DataFrame], out: Path) -> None:
    p50s, p95s, p99s = [], [], []
    for df in dfs:
        dur = df[df['metric_name'] == 'http_req_duration'].copy()
        if dur.empty:
            continue
        g = dur.set_index('ts').sort_index()['metric_value'].resample('5s')
        p50s.append(g.quantile(0.50))
        p95s.append(g.quantile(0.95))
        p99s.append(g.quantile(0.99))

    if not p50s:
        return

    a50 = align_series(p50s, '5s').mean(axis=1)
    a95 = align_series(p95s, '5s').mean(axis=1)
    a99 = align_series(p99s, '5s').mean(axis=1)
    x = a50.index.values

    fig, ax = plt.subplots(figsize=FIGSIZE)
    ax.plot(x, a50.values, label='p50 (média)', linewidth=1.8, color='#2ca02c')
    ax.plot(x, a95.values, label='p95 (média)', linewidth=1.8, color='#ff7f0e')
    ax.plot(x, a99.values, label='p99 (média)', linewidth=1.8, color='#d62728')
    ax.set_ylabel('Latência (ms)')
    ax.grid(True, alpha=0.3)
    ax.legend(loc='upper left', fontsize=8)
    _format_xaxis(ax, x[-1] if len(x) else 1)
    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def plot_errors(dfs: list[pd.DataFrame], out: Path) -> None:
    series = []
    for df in dfs:
        failed = df[df['metric_name'] == 'http_req_failed'].copy()
        if failed.empty:
            continue
        f = failed.set_index('ts').sort_index()
        total = f['metric_value'].resample('1s').count()
        fail  = f['metric_value'].resample('1s').sum()
        series.append((fail / total * 100).fillna(0))

    if not series:
        return

    aligned = align_series(series, '1s')
    avg = aligned.mean(axis=1)
    x = aligned.index.values

    fig, ax = plt.subplots(figsize=FIGSIZE)
    for i, col in enumerate(aligned.columns):
        ax.plot(x, aligned[col].values, linewidth=0.6,
                color=COLORS[i % len(COLORS)], alpha=0.35)
    ax.fill_between(x, 0, avg.values, color='#d62728', alpha=0.2)
    ax.plot(x, avg.values, color='#d62728', linewidth=1.8, label='média')
    ax.set_ylabel('Taxa de erro (%)')
    ax.set_ylim(0, max(5.0, float(avg.max()) * 1.2))
    ax.grid(True, alpha=0.3)
    ax.legend(loc='upper left', fontsize=8)
    _format_xaxis(ax, x[-1] if len(x) else 1)
    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


def plot_latency_vs_rps(dfs: list[pd.DataFrame], out: Path) -> None:
    lat_series, rps_series = [], []
    for df in dfs:
        dur  = df[df['metric_name'] == 'http_req_duration'].copy()
        reqs = df[df['metric_name'] == 'http_reqs'].copy()
        if dur.empty or reqs.empty:
            continue
        lat_series.append(
            dur.set_index('ts').sort_index()['metric_value'].resample('5s').mean() / 1000.0
        )
        ps = reqs.set_index('ts').sort_index().resample('1s')['metric_value'].sum()
        rps_series.append(ps.rolling(10, min_periods=1).mean())

    if not lat_series:
        return

    a_lat = align_series(lat_series, '5s').mean(axis=1)
    a_rps = align_series(rps_series, '1s').mean(axis=1)
    x_lat = a_lat.index.values
    x_rps = a_rps.index.values

    fig, ax1 = plt.subplots(figsize=FIGSIZE)
    color1 = '#1f77b4'
    ax1.set_ylabel('Latência média 5s (s)', color=color1)
    line1, = ax1.plot(x_lat, a_lat.values, color=color1, linewidth=1.8,
                      label='Latência média (s)')
    ax1.tick_params(axis='y', labelcolor=color1)
    ax1.grid(True, alpha=0.3)
    _format_xaxis(ax1, x_lat[-1] if len(x_lat) else 1)

    ax2 = ax1.twinx()
    color2 = '#ff7f0e'
    ax2.set_ylabel('Requisições por segundo', color=color2)
    line2, = ax2.plot(x_rps, a_rps.values, color=color2, linewidth=1.8,
                      label='req/s (rolling 10s)')
    ax2.tick_params(axis='y', labelcolor=color2)
    ax1.legend(handles=[line1, line2], loc='upper left', fontsize=8)

    fig.tight_layout()
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    print(f'  → {out.name}')


# ── summary ──────────────────────────────────────────────────────────────────

def build_summary(dfs: list[pd.DataFrame], csv_paths: list[Path], label: str = '') -> str:
    rows = []
    for df, path in zip(dfs, csv_paths):
        m_reqs   = df[df['metric_name'] == 'http_reqs']['metric_value']
        m_fail   = df[df['metric_name'] == 'http_req_failed']['metric_value']
        m_dur    = df[df['metric_name'] == 'http_req_duration']['metric_value']
        duration = (df['ts'].max() - df['ts'].min()).total_seconds()
        total    = len(m_reqs)
        fails    = int(m_fail.sum()) if not m_fail.empty else 0
        rps      = total / duration if duration > 0 else 0
        rows.append({
            'run':      path.parent.name,
            'total':    total,
            'fails':    fails,
            'fail_pct': fails / total * 100 if total > 0 else 0,
            'rps':      rps,
            'avg_ms':   m_dur.mean() if not m_dur.empty else float('nan'),
            'p50_ms':   m_dur.quantile(0.50) if not m_dur.empty else float('nan'),
            'p95_ms':   m_dur.quantile(0.95) if not m_dur.empty else float('nan'),
            'p99_ms':   m_dur.quantile(0.99) if not m_dur.empty else float('nan'),
        })

    SEP = '═' * 80
    HR  = '─' * 80
    title = label.upper() if label else 'CENÁRIO'
    L   = ['', SEP, f' RESUMO MÉDIO — {title}', SEP, '']

    def fmt(v): return f'{v:.1f}' if not np.isnan(v) else '-'

    L += [' Por execução:', HR,
          f' {"Run":<6} {"Reqs":>7} {"Falhas":>7} {"Falha%":>7} '
          f'{"req/s":>7} {"avg(ms)":>9} {"p50":>9} {"p95":>9} {"p99":>9}',
          ' ' + '─' * 78]
    for r in rows:
        L.append(
            f' {r["run"]:<6} {r["total"]:>7} {r["fails"]:>7} '
            f'{fmt(r["fail_pct"]):>7} {fmt(r["rps"]):>7} '
            f'{fmt(r["avg_ms"]):>9} {fmt(r["p50_ms"]):>9} '
            f'{fmt(r["p95_ms"]):>9} {fmt(r["p99_ms"]):>9}'
        )

    # Médias
    avg = {k: np.mean([r[k] for r in rows]) for k in
           ['total', 'fails', 'fail_pct', 'rps', 'avg_ms', 'p50_ms', 'p95_ms', 'p99_ms']}
    std = {k: np.std([r[k] for r in rows]) for k in
           ['rps', 'avg_ms', 'p95_ms']}

    L += ['', HR, ' Média das execuções:', HR,
          f' Requisições  : {avg["total"]:.0f}',
          f' Falhas       : {avg["fails"]:.0f}  ({fmt(avg["fail_pct"])}%)',
          f' Throughput   : {fmt(avg["rps"])} req/s  (σ={fmt(std["rps"])})',
          f' Latência avg : {fmt(avg["avg_ms"])} ms',
          f' p50          : {fmt(avg["p50_ms"])} ms',
          f' p95          : {fmt(avg["p95_ms"])} ms  (σ={fmt(std["p95_ms"])})',
          f' p99          : {fmt(avg["p99_ms"])} ms',
          '', SEP, '']

    return '\n'.join(L)


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    base = Path(sys.argv[1]).resolve()
    if not base.is_dir():
        print(f'Diretório não encontrado: {base}')
        return 1

    csv_paths = discover_csvs(base)
    if not csv_paths:
        print(f'Nenhum CSV encontrado em subpastas de {base}')
        return 1

    print(f'==> {len(csv_paths)} execuções encontradas:')
    for p in csv_paths:
        print(f'    {p.relative_to(base.parent)}')

    print('==> Carregando CSVs...')
    dfs = [load_csv(p) for p in csv_paths]
    total_rows = sum(len(d) for d in dfs)
    print(f'    {total_rows:,} linhas no total')

    out_dir = base / 'avg'
    out_dir.mkdir(exist_ok=True)

    print('==> Gerando gráficos médios:')
    plot_throughput(dfs,    out_dir / 'avg-01-throughput.png')
    plot_latency(dfs,       out_dir / 'avg-02-latency.png')
    plot_errors(dfs,        out_dir / 'avg-03-errors.png')
    plot_latency_vs_rps(dfs, out_dir / 'avg-04-latency-vs-rps.png')

    print('==> Gerando summary...')
    summary = build_summary(dfs, csv_paths, label=base.name)
    (out_dir / 'avg-summary.txt').write_text(summary)
    print(summary)

    print(f'==> Outputs em {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
