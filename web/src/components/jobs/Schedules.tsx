import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.ts';
import { exactTime, shortPath } from '../../lib/format.ts';
import { navigate } from '../../lib/router.tsx';
import { Button, Card, Empty, RelTime } from '../ui.tsx';
import { fetchMachines, type ScheduleView } from './common.tsx';

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
