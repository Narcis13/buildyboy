import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JobView } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { duration, shortPath, usd } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { Card, Empty, RelTime, Tabs } from '../ui.tsx';
import { Countdown, JobBadge, isLive, jobDeadline, jobDuration } from './common.tsx';

type Filter = 'all' | 'active' | 'done' | 'failed';
const FILTERS: Record<Filter, string> = { all: '', active: 'queued,starting,running', done: 'succeeded,stopped', failed: 'failed,lost' };

export function JobList() {
  const [filter, setFilter] = useState<Filter>('all');
  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs', 'list', filter],
    queryFn: () => api.get<JobView[]>(`/api/jobs${FILTERS[filter] ? `?status=${FILTERS[filter]}` : ''}`),
  });
  return (
    <section aria-label="Jobs">
      <Tabs
        className="mb-3"
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'active', label: 'Active' },
          { id: 'done', label: 'Done' },
          { id: 'failed', label: 'Failed' },
        ]}
      />
      {isLoading && <div className="p-4 text-muted">Loading…</div>}
      {error && <div className="p-4 text-error">Could not load jobs: {(error as Error).message}</div>}
      {data && !data.length && <Empty>No jobs yet. Launch one from a saved prompt with “New job”.</Empty>}
      <ul className="flex flex-col gap-2">
        {data?.map((j) => (
          <li key={j.id}>
            <JobRow j={j} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function JobRow({ j }: { j: JobView }) {
  const deadline = isLive(j.status) ? jobDeadline(j) : null;
  return (
    <Link to={`/jobs/${j.id}`} data-testid="job-row" className="block">
      <Card className="flex min-h-14 flex-col gap-1 px-3 py-2.5 hover:border-accent md:flex-row md:items-center md:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <JobBadge status={j.status} />
          <span className="truncate text-[15px] font-medium">{j.title ?? j.id.slice(0, 8)}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted md:flex-nowrap">
          <span className="truncate">{j.machineName ?? j.machineId.slice(0, 8)}</span>
          <span className="truncate font-mono text-xs" title={j.cwd}>
            {shortPath(j.cwd, 2)}
          </span>
          <span className="tabular-nums">{usd(j.costUsd)}</span>
          <span className="tabular-nums">{duration(jobDuration(j))}</span>
          {deadline && <Countdown until={deadline} />}
          <RelTime ts={j.createdAt} />
        </div>
      </Card>
    </Link>
  );
}
