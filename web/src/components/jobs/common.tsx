import { useEffect, useState, type ReactNode } from 'react';
import type { JobStatus, JobView, MachineSummary } from '../../../../shared/types.ts';
import type { StoredJobOptions } from '../../../../runner/options.ts';
import { api } from '../../lib/api.ts';
import { duration } from '../../lib/format.ts';
import { Badge } from '../ui.tsx';

/** GET /api/jobs/:id adds these to JobView. */
export interface JobDetailView extends JobView {
  outputLines: number;
  rerunOf: string | null;
  scheduleId: string | null;
  runnerOnline: boolean;
  verifyCommands: string[];
}

export interface ScheduleView {
  id: string;
  cron: string;
  enabled: boolean;
  lastRunAt: number | null;
  createdAt: number;
  nextRunAt: number | null;
  job: { promptId?: number | null; promptText?: string | null; machineId: string; cwd: string; title?: string | null; options: StoredJobOptions } | null;
}

export const STATUS_COLOR: Record<JobStatus, string> = {
  queued: 'var(--bb-muted)',
  starting: 'var(--bb-idle)',
  running: 'var(--bb-working)',
  succeeded: 'var(--bb-working)',
  failed: 'var(--bb-error)',
  stopped: 'var(--bb-ended)',
  lost: 'var(--bb-waiting)',
};

export const isLive = (s: JobStatus) => s === 'starting' || s === 'running';

export function JobBadge({ status }: { status: JobStatus }) {
  return (
    <Badge color={STATUS_COLOR[status]} className={status === 'running' ? 'animate-pulse' : ''}>
      {status}
    </Badge>
  );
}

export const inputCls = 'min-h-11 w-full rounded-lg border border-line bg-bg-2 px-3 text-base text-ink outline-none focus:border-accent';

export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-sm text-muted ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-sm">{hint}</span>}
    </label>
  );
}

export function jobDeadline(j: Pick<JobView, 'options' | 'startedAt'>): number | null {
  const m = (j.options as StoredJobOptions).limitMinutes;
  return m && j.startedAt ? j.startedAt + m * 60_000 : null;
}

/** Ticking "12m 3s left". */
export function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = until - now;
  return <span className={left < 5 * 60_000 ? 'text-waiting' : ''}>{left > 0 ? `${duration(left)} left` : 'limit reached'}</span>;
}

export function jobDuration(j: Pick<JobView, 'startedAt' | 'endedAt'>, now = Date.now()): number | null {
  return j.startedAt ? (j.endedAt ?? now) - j.startedAt : null;
}

export const fetchMachines = () => api.get<MachineSummary[]>('/api/machines');
