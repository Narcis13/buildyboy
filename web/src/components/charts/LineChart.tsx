import { useState } from 'react';
import { niceMax } from './BarChart.tsx';
import { seriesColor } from './palette.ts';
import { useWidth } from './useWidth.ts';

export interface LineSeries {
  name: string;
  /** one y per x; null breaks the line */
  values: (number | null)[];
  color?: string;
}

/** Line chart over arbitrary x values (timestamps or day indexes). Hand-written SVG, drawn at container width. */
export function LineChart({
  xs, series, height = 170, yMax, format = (n) => String(Math.round(n * 100) / 100), xFormat = (x) => String(x), ariaLabel, testId,
}: {
  xs: number[];
  series: LineSeries[];
  height?: number;
  yMax?: number;
  format?: (n: number) => string;
  xFormat?: (x: number) => string;
  ariaLabel: string;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = yMax ?? niceMax(Math.max(...all, 0));
  const left = Math.max(34, format(top).length * 7 + 8);
  const bottom = 22;
  const plotW = width - left - 10;
  const plotH = height - bottom - 8;
  const x0 = xs.length ? xs[0] : 0;
  const x1 = xs.length ? xs[xs.length - 1] : 1;
  const px = (x: number) => left + (x1 === x0 ? plotW / 2 : ((x - x0) / (x1 - x0)) * plotW);
  const py = (v: number) => 6 + plotH - (v / top) * plotH;

  const pick = (clientX: number, rect: DOMRect) => {
    if (!xs.length) return;
    const rel = clientX - rect.left;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(px(xs[i]) - rel) < Math.abs(px(xs[best]) - rel)) best = i;
    setActive(best);
  };

  return (
    <div ref={ref} data-testid={testId} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        className="block touch-pan-y select-none"
        onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
      >
        {[0, top / 2, top].map((t) => (
          <g key={t}>
            <line x1={left} x2={width - 10} y1={py(t)} y2={py(t)} stroke="var(--bb-line)" strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={left - 6} y={py(t) + 4} textAnchor="end" fontSize={11} fill="var(--bb-muted)">{format(t)}</text>
          </g>
        ))}
        {xs.length > 0 && (
          <>
            <text x={left} y={height - 6} textAnchor="start" fontSize={11} fill="var(--bb-muted)">{xFormat(x0)}</text>
            <text x={width - 10} y={height - 6} textAnchor="end" fontSize={11} fill="var(--bb-muted)">{xFormat(x1)}</text>
          </>
        )}
        {series.map((s, si) => {
          const color = s.color ?? seriesColor(si);
          const segs: string[][] = [[]];
          s.values.forEach((v, i) => {
            if (v == null) segs.push([]);
            else segs[segs.length - 1].push(`${px(xs[i]).toFixed(1)},${py(v).toFixed(1)}`);
          });
          return (
            <g key={s.name}>
              {segs.filter((p) => p.length > 1).map((p, i) => (
                <polyline key={i} points={p.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {segs.filter((p) => p.length === 1).map((p, i) => {
                const [cx, cy] = p[0].split(',');
                return <circle key={i} cx={cx} cy={cy} r={3} fill={color} />;
              })}
              {active != null && s.values[active] != null && <circle cx={px(xs[active])} cy={py(s.values[active]!)} r={4} fill={color} stroke="var(--bb-panel)" strokeWidth={2} />}
            </g>
          );
        })}
        {active != null && <line x1={px(xs[active])} x2={px(xs[active])} y1={6} y2={6 + plotH} stroke="var(--bb-muted)" strokeDasharray="2 3" />}
      </svg>
      <div className="mt-1 min-h-5 text-sm text-muted" aria-live="polite">
        {active != null ? (
          <span>
            <span className="text-ink">{xFormat(xs[active])}</span>
            {series.map((s) => ` · ${s.name} ${s.values[active] == null ? '—' : format(s.values[active]!)}`)}
          </span>
        ) : (
          'Touch the chart for values'
        )}
      </div>
    </div>
  );
}
