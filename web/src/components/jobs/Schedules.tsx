import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduledLaunchView, ScheduledStatus } from '../../../../shared/factory.ts';
import { api, ApiError } from '../../lib/api.ts';
import { exactTime, shortPath } from '../../lib/format.ts';
import { Link, navigate } from '../../lib/router.tsx';
import { Badge, Button, Card, Empty, RelTime } from '../ui.tsx';
import { fetchMachines, type ScheduleView } from './common.tsx';

const SCHEDULED_COLOR: Record<ScheduledStatus, string> = {
  pending: 'var(--bb-waiting)',
  starting: 'var(--bb-idle)',
  started: 'var(--bb-working)',
  missed: 'var(--bb-error)',
  cancelled: 'var(--bb-ended)',
};

/** "catch-up 2 h", "catch-up 90 min", "no catch-up". */
export function catchUpText(minutes: number): string {
  if (!minutes) return 'no catch-up';
  if (minutes < 60) return `catch-up ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `catch-up ${h} h${m ? ` ${m} min` : ''}`;
}

const linkCls = 'inline-flex min-h-[44px] items-center text-accent underline';

function ScheduledLaunches() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['jobs', 'scheduled-launches'], queryFn: () => api.get<ScheduledLaunchView[]>('/api/scheduled-launches') });
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cancel = async (id: string) => {
    setErr(null);
    setBusy(id);
    try {
      await api.post(`/api/scheduled-launches/${id}/cancel`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Cancel failed');
    } finally {
      setArmed(null);
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ['jobs', 'scheduled-launches'] });
    }
  };
  return (
    <div className="mb-6" data-testid="scheduled-launches">
      <h3 className="mb-2 text-base font-semibold">Scheduled launches</h3>
      {err && <p role="alert" className="mb-2 text-error">{err}</p>}
      {error && <p role="alert" className="mb-2 text-error">Could not load scheduled launches: {(error as Error).message}</p>}
      {data && !data.length && (
        <Empty>
          <span data-testid="scheduled-empty">Nothing scheduled. Agents schedule a launch with tasks_launch or coordinator_launch and notBefore; it starts at the first chance after that time.</span>
        </Empty>
      )}
      <ul className="flex flex-col gap-2">
        {data?.map((s) => (
          <li key={s.id}>
            <Card className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-center ${s.status === 'missed' ? '!border-error' : ''}`} data-testid="scheduled-launch" data-status={s.status} data-kind={s.kind} data-task={s.taskId ?? ''}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid="scheduled-status"><Badge color={SCHEDULED_COLOR[s.status]} className={s.status === 'missed' ? 'font-bold' : ''}>{s.status}</Badge></span>
                  <span className="text-sm text-muted">{s.kind === 'worker' ? `worker for ${s.taskId ?? '?'}` : 'coordinator'}</span>
                  <span className="min-w-0 truncate text-[15px] font-medium" title={s.title}>{s.title}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted">
                  <span>{s.machineName ?? s.machineId.slice(0, 8)}</span>
                  <span>{s.launcher}</span>
                  <span className="font-mono text-xs" title={s.cwd}>{shortPath(s.cwd, 2)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-sm">
                  <span data-testid="scheduled-not-before">Not before {s.notBeforeText}</span>
                  <span className="text-muted" title={exactTime(s.expiresAt)}>{s.status === 'missed' ? 'expired' : 'until'} {new Date(s.expiresAt).toLocaleString()}</span>
                  {s.staleStart && <span className="text-muted">started on stale usage data</span>}
                </div>
                {s.status === 'missed' && <p className="mt-1 text-sm font-medium text-error">Missed: it did not start before it expired.{s.waits ? ` It was waiting: ${s.waits}` : ''}</p>}
                {s.status === 'pending' && s.waits && <p className="mt-1 text-sm text-waiting" data-testid="scheduled-waits">Waits: {s.waits}</p>}
                {(s.jobId || s.taskId) && (
                  <div className="flex flex-wrap gap-x-4">
                    {s.jobId && <Link to={`/jobs/${s.jobId}`} className={linkCls} data-testid="scheduled-job">Job {s.jobId.slice(0, 8)}</Link>}
                    {s.kind === 'worker' && s.taskId && <Link to={`/backlog/${encodeURIComponent(s.taskId)}`} className={linkCls} data-testid="scheduled-task">{s.taskId}</Link>}
                  </div>
                )}
              </div>
              {s.status === 'pending' && (
                <Button
                  variant={armed === s.id ? 'danger' : 'ghost'}
                  disabled={busy === s.id}
                  onClick={() => (armed === s.id ? void cancel(s.id) : setArmed(s.id))}
                  onBlur={() => setArmed(null)}
                  data-testid="scheduled-cancel"
                >
                  {armed === s.id ? 'Tap again to cancel' : 'Cancel'}
                </Button>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Schedules() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['jobs', 'schedules'], queryFn: () => api.get<ScheduleView[]>('/api/schedules') });
  const machines = useQuery({ queryKey: ['jobs', 'machines'], queryFn: fetchMachines });
  const [armed, setArmed] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = (id: string) => machines.data?.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  const remove = async (id: string) => {
    setErr(null);
    try {
      await api.del(`/api/schedules/${id}`);
      await qc.invalidateQueries({ queryKey: ['jobs', 'schedules'] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Delete failed');
    }
  };
  return (
    <section id="schedules" aria-label="Schedules" className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Schedules</h2>
        <Button onClick={() => navigate('/jobs?new=1&schedule=1')}>New schedule</Button>
      </div>
      <ScheduledLaunches />
      <h3 className="mb-2 text-base font-semibold">Recurring, by cron</h3>
      {err && <p role="alert" className="mb-2 text-error">{err}</p>}
      {data && !data.length && <Empty>No schedules. Use cron syntax, e.g. “0 2 * * *” to run a prompt every night at 02:00.</Empty>}
      <ul className="flex flex-col gap-2">
        {data?.map((s) => {
          const text = s.job?.promptText ?? '';
          const label = s.job?.title || (/^\s*Goal:\s*(.+)$/im.exec(text)?.[1] ?? text.split('\n').find((l) => l.trim()))?.slice(0, 80) || (s.job?.promptId ? `Prompt #${s.job.promptId}` : 'Job');
          return (
            <li key={s.id}>
              <Card className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-sm">{s.cron}</code>
                    <span className="truncate text-[15px] font-medium">{label}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted">
                    {s.job && <span>{name(s.job.machineId)}</span>}
                    {s.job && <span className="font-mono text-xs" title={s.job.cwd}>{shortPath(s.job.cwd, 2)}</span>}
                    <span data-testid="schedule-catch-up" title="A run missed while the server was down still starts once, if it is not older than this">{catchUpText(s.catchUpMinutes)}</span>
                    <span title={exactTime(s.nextRunAt)}>next {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}</span>
                    {s.lastRunAt && <span>last <RelTime ts={s.lastRunAt} /></span>}
                  </div>
                </div>
                <Button variant={armed === s.id ? 'danger' : 'ghost'} onClick={() => (armed === s.id ? void remove(s.id) : setArmed(s.id))} onBlur={() => setArmed(null)}>
                  {armed === s.id ? 'Tap again to delete' : 'Delete'}
                </Button>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
