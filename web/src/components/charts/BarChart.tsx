import { useState } from 'react';
import { seriesColor } from './palette.ts';
import { useWidth } from './useWidth.ts';

export interface BarDatum {
  /** x-axis label, e.g. 2026-10-12 */
  label: string;
  values: Record<string, number>;
}

/** Stacked vertical bars drawn as SVG at the measured container width. Tap or hover a bar to read its values. */
export function BarChart({
  data, series, height = 170, format = (n) => String(Math.round(n * 100) / 100), labelFormat = (s) => s.slice(5), ariaLabel, testId,
}: {
  data: BarDatum[];
  series: string[];
  height?: number;
  format?: (n: number) => string;
  labelFormat?: (label: string) => string;
  ariaLabel: string;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((s, k) => s + (d.values[k] ?? 0), 0));
  const max = Math.max(...totals, 0);
  const top = max > 0 ? niceMax(max) : 1;
  const left = Math.max(34, format(top).length * 7 + 8);
  const bottom = 22;
  const plotW = width - left - 4;
  const plotH = height - bottom - 6;
  const slot = data.length ? plotW / data.length : plotW;
  const barW = Math.max(2, Math.min(28, slot * 0.72));
  const y = (v: number) => 4 + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const sel = active != null ? data[active] : null;

  return (
    <div ref={ref} data-testid={testId} className="w-full">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block select-none">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={width - 4} y1={y(t)} y2={y(t)} stroke="var(--bb-line)" strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--bb-muted)">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = left + slot * i + slot / 2;
          let acc = 0;
          return (
            <g key={d.label} onPointerEnter={() => setActive(i)} onClick={() => setActive(i === active ? null : i)} style={{ cursor: 'pointer' }}>
              <rect x={cx - slot / 2} y={4} width={slot} height={plotH} fill={active === i ? 'var(--bb-grid)' : 'transparent'} />
              {series.map((k, si) => {
                const v = d.values[k] ?? 0;
                if (v <= 0) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return <rect key={k} x={cx - barW / 2} y={y1} width={barW} height={Math.max(0.5, y0 - y1)} fill={seriesColor(si)} rx={1} />;
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--bb-muted)">{labelFormat(d.label)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 min-h-5 text-sm text-muted" aria-live="polite">
        {sel ? (
          <span>
            <span className="text-ink">{sel.label}</span> · total {format(totals[active!])}
            {series.filter((k) => (sel.values[k] ?? 0) > 0).map((k) => ` · ${k} ${format(sel.values[k])}`)}
          </span>
        ) : (
          'Tap a bar for details'
        )}
      </div>
    </div>
  );
}

/** Rounds up to a 1/2/5 × 10^n value so axis labels are tidy. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * p;
}

export function Legend({ series }: { series: string[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
      {series.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: seriesColor(i) }} />
          <span className="max-w-[10rem] truncate">{s}</span>
        </li>
      ))}
    </ul>
  );
}
