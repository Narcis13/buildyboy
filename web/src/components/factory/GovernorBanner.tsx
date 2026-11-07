import { useQuery } from '@tanstack/react-query';
import type { GovernorVerdict, UsageWindow } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Card, RelTime } from '../ui.tsx';

function UsageBar({ label, w, limit }: { label: string; w: UsageWindow | null; limit: number }) {
  const pct = w ? Math.max(0, Math.min(100, w.pct)) : 0;
  const over = w ? w.pct >= limit : false;
  const color = !w ? 'var(--bb-ended)' : over ? 'var(--bb-error)' : w.pct >= limit * 0.8 ? 'var(--bb-waiting)' : 'var(--bb-working)';
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">
          {w ? `${Math.round(w.pct)}%` : 'no data'}
          {w?.resetsAt ? <> · resets <RelTime ts={w.resetsAt} /></> : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={w ? Math.round(pct) : undefined}
        className="relative h-2.5 overflow-hidden rounded-full bg-panel-2"
        title={w ? `${Math.round(w.pct)}% used; new workers pause at ${limit}%` : 'No usage sample yet'}
      >
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
        <div className="absolute inset-y-0 w-px bg-ink/60" style={{ left: `${limit}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}

/** What the consumption governor says right now: may the factory start a worker, and why not. */
export function GovernorBanner() {
  const { data, error } = useQuery({ queryKey: ['governor'], queryFn: () => api.get<GovernorVerdict>('/api/governor'), refetchInterval: 30_000 });
  if (error) return <div role="alert" className="mb-3 text-error">Could not load the governor: {(error as Error).message}</div>;
  if (!data) return null;
  const state = data.stopAll
    ? { key: 'stopped', label: 'Factory stopped', color: 'var(--bb-error)' }
    : !data.canStart
      ? { key: 'wait', label: 'No new workers', color: 'var(--bb-waiting)' }
      : { key: 'go', label: 'Can start', color: 'var(--bb-working)' };
  return (
    <Card className="mb-4 p-3 md:p-4" data-testid="governor-banner" data-state={state.key} style={{ borderColor: `color-mix(in srgb, ${state.color} 55%, var(--bb-line))` }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-base font-semibold" style={{ color: state.color }}>
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: state.color }} aria-hidden="true" />
          {state.label}
        </span>
        <span className="min-w-0 text-[15px] text-muted [overflow-wrap:anywhere]" data-testid="governor-reason">{data.reason}</span>
        {data.waitUntil != null && (
          <span className="text-[15px]" data-testid="governor-wait">
            Wait until <RelTime ts={data.waitUntil} />
          </span>
        )}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <UsageBar label="5-hour" w={data.usage.fiveHour} limit={data.thresholds.fiveHourPct} />
        <UsageBar label="7-day" w={data.usage.sevenDay} limit={data.thresholds.sevenDayPct} />
      </div>
      <div className="mt-2 text-sm text-muted" data-testid="governor-age">
        {data.usage.updatedAt ? (
          <>
            Usage data from <RelTime ts={data.usage.updatedAt} />
            {data.usage.ageMs != null && data.usage.ageMs > data.thresholds.maxAgeMin * 60_000 ? ' (stale)' : ''}
          </>
        ) : (
          'No usage data yet: turn on the statusline bridge in Settings.'
        )}
      </div>
    </Card>
  );
}
