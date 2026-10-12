import type { ReactNode } from 'react';

/** Ranked horizontal bars (label, bar, value). Plain HTML so long labels wrap instead of overflowing. */
export function HBars({ rows, color = 'var(--bb-accent)', testId }: { rows: { label: ReactNode; value: number; text?: string; sub?: ReactNode }[]; color?: string; testId?: string }) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return (
    <ul className="space-y-2.5" data-testid={testId}>
      {rows.map((r, i) => (
        <li key={i}>
          <div className="flex items-baseline justify-between gap-3 text-[15px]">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 font-mono text-sm text-muted">{r.text ?? r.value}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-panel-2">
            <div className="h-full rounded" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} />
          </div>
          {r.sub && <div className="mt-0.5 text-sm text-muted">{r.sub}</div>}
        </li>
      ))}
    </ul>
  );
}
