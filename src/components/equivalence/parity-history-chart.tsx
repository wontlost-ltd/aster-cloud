/**
 * 双引擎一致性历史图：每晚运行的「检查数」折线（解析 / 运行结果 / Core IR 三条）。
 *
 * 为什么画检查数而不是一致率：一致率长期贴在 100%，五条序列叠成一片「条形码」，
 * 读者什么也读不出。检查数能同时讲清两件事——测试语料在增长、每次运行是否有分歧
 * （有分歧的运行点画成红色空心圆）。精确的一致数 / 总数在悬浮提示与数据表里。
 *
 * 为什么手写 SVG：页面跑在 Cloudflare Workers + strict-dynamic CSP 下，几条折线
 * 不值得引入 100KB+ 图表库；SVG 用设计 token 着色，暗色模式自动跟随。
 *
 * 无障碍：图本身 role="img" + 文字摘要；可聚焦后用 ←/→ 逐日查看；
 * 完整数值以「显示数据表」作为替代。
 */
'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/components/ui';

export type HistoryPoint = { timestamp: string; value: number; total: number };

export type HistorySeries = {
  key: string;
  label: string;
  /** 线条与图例颜色（不承担语义；分歧统一用 danger 色 + 空心圆形状表达）。 */
  tone: 'primary' | 'sky' | 'amber';
  points: HistoryPoint[];
};

type RangeKey = 'week' | 'month' | 'all';
const RANGE_DAYS: Record<Exclude<RangeKey, 'all'>, number> = { week: 7, month: 30 };

export type HistoryChartLabels = {
  rangeLabel: string;
  ranges: Record<RangeKey, string>;
  /** 文字摘要模板，含 {from} {to} {divergent}。 */
  summary: string;
  /** 悬浮提示「{value} / {total} 一致」模板。 */
  agreeOf: string;
  divergedLegend: string;
  tableToggle: string;
  colDate: string;
  empty: string;
};

type Props = { series: HistorySeries[]; labels: HistoryChartLabels; locale: string };

/** SSR / 首次渲染的默认宽度；挂载后按容器实际像素宽度重算，保证窄屏上刻度文字不被缩小。 */
const DEFAULT_W = 720;
const VIEW_H = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 48 };
const DAY_MS = 86_400_000;

const TONE: Record<HistorySeries['tone'], { stroke: string; fill: string; dot: string }> = {
  primary: { stroke: 'stroke-primary', fill: 'fill-primary', dot: 'bg-primary' },
  sky: { stroke: 'stroke-sky-600 dark:stroke-sky-400', fill: 'fill-sky-600 dark:fill-sky-400', dot: 'bg-sky-600 dark:bg-sky-400' },
  amber: { stroke: 'stroke-amber-600 dark:stroke-amber-400', fill: 'fill-amber-600 dark:fill-amber-400', dot: 'bg-amber-600 dark:bg-amber-400' },
};

/** 日期统一按 UTC 格式化：时间戳是 UTC，钉住时区避免 SSR/CSR 水合不一致。 */
function fmtDate(iso: string, locale: string, long = false): string {
  const opts: Intl.DateTimeFormatOptions = long
    ? { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }
    : { timeZone: 'UTC', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(new Date(iso));
}

/** 把最大值抬到「好看」的刻度上限（1/2/5 × 10^n）。 */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * mag >= n) ?? 10) * mag;
}

const fill = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

export function ParityHistoryChart({ series, labels, locale }: Props) {
  const [range, setRange] = useState<RangeKey>('all');
  const boxRef = useRef<HTMLDivElement>(null);
  const [VIEW_W, setViewW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setViewW(Math.max(280, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [active, setActive] = useState<number | null>(null);
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  // 所有序列出现过的 UTC 日（升序），作为 x 轴类目。
  const allDays = useMemo(
    () => [...new Set(series.flatMap((s) => s.points.map((p) => p.timestamp.slice(0, 10))))].sort(),
    [series],
  );
  const span = allDays.length > 1 ? Date.parse(allDays.at(-1)!) - Date.parse(allDays[0]!) : 0;
  // 只提供有意义的范围：历史不足该范围一半时不显示该选项。
  const ranges = (['week', 'month', 'all'] as RangeKey[]).filter((r) => r === 'all' || span >= RANGE_DAYS[r] * DAY_MS * 0.5);

  const days = useMemo(() => {
    if (range === 'all' || allDays.length === 0) return allDays;
    const cutoff = Date.parse(allDays.at(-1)!) - RANGE_DAYS[range] * DAY_MS;
    return allDays.filter((d) => Date.parse(d) >= cutoff);
  }, [allDays, range]);

  const geo = useMemo(() => {
    const byDay = series.map((s) => new Map(s.points.map((p) => [p.timestamp.slice(0, 10), p])));
    const max = niceCeil(Math.max(1, ...days.flatMap((d) => byDay.map((m) => m.get(d)?.total ?? 0))));
    const innerW = VIEW_W - PAD.left - PAD.right;
    const innerH = VIEW_H - PAD.top - PAD.bottom;
    // x 轴按真实时间比例：nightly 有漏跑或历史断档时，间隔应如实反映，而不是被压成等距。
    const t0 = days.length ? Date.parse(days[0]!) : 0;
    const tSpan = days.length > 1 ? Date.parse(days.at(-1)!) - t0 : 0;
    const xOf = (i: number) => PAD.left + (tSpan === 0 ? innerW / 2 : ((Date.parse(days[i]!) - t0) / tSpan) * innerW);
    const yOf = (v: number) => PAD.top + (1 - v / max) * innerH;
    const lines = series.map((s, si) => {
      const pts = days
        .map((d, i) => ({ i, p: byDay[si]!.get(d) }))
        .filter((e): e is { i: number; p: HistoryPoint } => !!e.p)
        .map(({ i, p }) => ({ i, p, x: xOf(i), y: yOf(p.total), diverged: p.value < p.total }));
      return { s, pts, path: pts.map((e, k) => `${k ? 'L' : 'M'}${e.x.toFixed(1)},${e.y.toFixed(1)}`).join('') };
    });
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: max * f, y: yOf(max * f) }));
    return { byDay, lines, ticks, xOf };
  }, [series, days, VIEW_W]);

  if (allDays.length === 0) {
    return <p className="rounded-lg border border-border bg-bg-subtle p-6 text-sm text-fg-muted">{labels.empty}</p>;
  }

  const divergentRuns = new Set(geo.lines.flatMap((l) => l.pts.filter((e) => e.diverged).map((e) => e.i))).size;
  const summary = fill(labels.summary, {
    from: fmtDate(days[0]!, locale, true),
    to: fmtDate(days.at(-1)!, locale, true),
    divergent: nf.format(divergentRuns),
  });
  const activeDay = active != null ? days[active] : undefined;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setActive((cur) => Math.min(days.length - 1, Math.max(0, (cur ?? days.length) + step)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
          {series.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn('h-0.5 w-4 rounded-full', TONE[s.tone].dot)} />
              {s.label}
            </li>
          ))}
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-full border-2 border-danger" />
            {labels.divergedLegend}
          </li>
        </ul>
        {ranges.length > 1 && (
          <div role="group" aria-label={labels.rangeLabel} className="inline-flex rounded-full border border-border bg-bg-muted p-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={r === range}
                onClick={() => {
                  setRange(r);
                  setActive(null);
                }}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:shadow-ring',
                  r === range ? 'bg-bg text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                )}
              >
                {labels.ranges[r]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        ref={boxRef}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="relative rounded-lg focus-visible:outline-none focus-visible:shadow-ring"
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full"
          role="img"
          aria-label={summary}
          onMouseLeave={() => setActive(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
            let best = 0;
            for (let i = 1; i < days.length; i++) {
              if (Math.abs(geo.xOf(i) - x) < Math.abs(geo.xOf(best) - x)) best = i;
            }
            setActive(best);
          }}
        >
          {geo.ticks.map((t) => (
            <g key={t.v}>
              <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={t.y} y2={t.y} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 8} y={t.y + 3} textAnchor="end" className="fill-fg-subtle font-mono text-[10px]">
                {nf.format(t.v)}
              </text>
            </g>
          ))}
          {active != null && (
            <line x1={geo.xOf(active)} x2={geo.xOf(active)} y1={PAD.top} y2={VIEW_H - PAD.bottom} className="stroke-border-strong" strokeDasharray="3 3" />
          )}
          {geo.lines.map(({ s, path, pts }) => (
            <g key={s.key}>
              <path d={path} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={TONE[s.tone].stroke} />
              {pts
                .filter((e) => e.diverged || e.i === active || pts.length === 1)
                .map((e) => (
                  <circle
                    key={e.i}
                    cx={e.x}
                    cy={e.y}
                    r={e.diverged ? 4.5 : 3.5}
                    strokeWidth={2}
                    className={e.diverged ? 'fill-bg stroke-danger' : cn(TONE[s.tone].fill, 'stroke-bg')}
                  />
                ))}
            </g>
          ))}
          {(days.length > 1 ? [0, days.length - 1] : [0]).map((i) => (
            <text
              key={i}
              x={geo.xOf(i)}
              y={VIEW_H - 8}
              textAnchor={days.length <= 1 ? 'middle' : i === 0 ? 'start' : 'end'}
              className="fill-fg-subtle font-mono text-[10px]"
            >
              {fmtDate(days[i]!, locale)}
            </text>
          ))}
        </svg>

        {activeDay && (
          <div
            aria-live="polite"
            className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-lg border border-border bg-bg px-3 py-2 text-xs shadow-lg"
            style={
              geo.xOf(active!) > VIEW_W / 2
                ? { right: `${(1 - geo.xOf(active!) / VIEW_W) * 100 + 2}%` }
                : { left: `${(geo.xOf(active!) / VIEW_W) * 100 + 2}%` }
            }
          >
            <p className="font-semibold text-fg">{fmtDate(activeDay, locale, true)}</p>
            <ul className="mt-1 space-y-0.5">
              {series.map((s, si) => {
                const p = geo.byDay[si]!.get(activeDay);
                if (!p) return null;
                return (
                  <li key={s.key} className="flex items-center justify-between gap-3 tabular-nums">
                    <span className="inline-flex items-center gap-1.5 text-fg-muted">
                      <span aria-hidden className={cn('size-2 rounded-full', TONE[s.tone].dot)} />
                      {s.label}
                    </span>
                    <span className={p.value < p.total ? 'font-semibold text-danger' : 'text-fg'}>
                      {fill(labels.agreeOf, { value: nf.format(p.value), total: nf.format(p.total) })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <details className="group">
        <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">{labels.tableToggle}</summary>
        <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-bg-subtle text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">{labels.colDate}</th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...days].reverse().map((d) => (
                <tr key={d}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal tabular-nums text-fg-muted">{fmtDate(d, locale, true)}</th>
                  {series.map((s, si) => {
                    const p = geo.byDay[si]!.get(d);
                    return (
                      <td key={s.key} className={cn('px-3 py-1.5 text-right tabular-nums', p && p.value < p.total ? 'font-semibold text-danger' : 'text-fg')}>
                        {p ? `${nf.format(p.value)} / ${nf.format(p.total)}` : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
