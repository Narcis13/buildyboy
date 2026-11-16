// A project's Backlog tab (its board) and Done tab (its archive: integrated packages with date, rounds, cost and
// duration, totals, and "Archive done" for the integrated ones still on the board).
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ProjectDetail, TaskSummary } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { duration, usd } from '../../lib/format.ts';
import { Link, navigate } from '../../lib/router.tsx';
import { Button, Card, Empty } from '../ui.tsx';
import { ImportPanel } from '../factory/ImportPanel.tsx';
import { NewTaskForm } from '../factory/NewTaskForm.tsx';
import { TaskBoard } from '../factory/TaskBoard.tsx';
import { StatusBadge } from '../factory/common.tsx';
import { useProjectAction } from '../factory/projects.tsx';

export function ProjectBacklog({ p }: { p: ProjectDetail }) {
  const [panel, setPanel] = useState<'new' | 'import' | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'project', p.key],
    queryFn: () => api.get<TaskSummary[]>(`/api/tasks?project=${encodeURIComponent(p.key)}`),
    placeholderData: keepPreviousData,
  });
  const archiveLink =
    p.archived > 0 ? (
      <Link to={`/projects/${encodeURIComponent(p.key)}?tab=done`} className="inline-flex min-h-[44px] items-center text-sm text-accent underline md:min-h-8" data-testid="archive-link">
        {p.archived} archived
      </Link>
    ) : null;
  return (
    <div className="space-y-3">
      {p.state !== 'archived' && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setPanel(panel === 'new' ? null : 'new')} data-testid="new-task-open">New task</Button>
          <Button variant={panel === 'import' ? 'primary' : 'ghost'} onClick={() => setPanel(panel === 'import' ? null : 'import')} data-testid="import-open">Import</Button>
          <Link to={`/backlog?project=${encodeURIComponent(p.key)}`} className="inline-flex min-h-[44px] items-center px-2 text-[15px] text-accent underline">Open in Backlog</Link>
        </div>
      )}
      {panel === 'new' && (
        <NewTaskForm
          project={p.key}
          onDone={(id) => {
            setPanel(null);
            if (id) navigate(`/backlog/${encodeURIComponent(id)}`);
          }}
        />
      )}
      {panel === 'import' && <ImportPanel project={p.key} onClose={() => setPanel(null)} />}
      {error && <div role="alert" className="text-error">Could not load the board: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && !data.length && (
        <>
          <Empty>No open packages. Create one, import a plan, or look at the Done tab.</Empty>
          {archiveLink}
        </>
      )}
      {data && data.length > 0 && <TaskBoard tasks={data} archive={archiveLink} />}
    </div>
  );
}

/** "2d 3h" past two days, else "5h 12m". */
const took = (ms: number) => (ms >= 48 * 3600_000 ? `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3600_000)}h` : duration(ms));

const day = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

export function ProjectDone({ p }: { p: ProjectDetail }) {
  const act = useProjectAction(p.key);
  const [result, setResult] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'archived', p.key],
    queryFn: () => api.get<TaskSummary[]>(`/api/tasks?project=${encodeURIComponent(p.key)}&archived=1`),
  });
  const rows = [...(data ?? [])].sort((a, b) => (b.integratedAt ?? b.archivedAt ?? 0) - (a.integratedAt ?? a.archivedAt ?? 0));
  const cost = rows.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  const rounds = rows.reduce((s, t) => s + t.round, 0);
  const integrated = rows.filter((t) => t.status === 'integrata').length;
  const waiting = p.counts.integrata;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[15px]" data-testid="done-totals">
          <span>
            <span className="tabular-nums">{rows.length}</span> <span className="text-muted">archived</span>
            {integrated !== rows.length && <span className="text-muted"> ({integrated} integrated)</span>}
          </span>
          <span>
            <span className="tabular-nums">{rounds}</span> <span className="text-muted">gate round{rounds === 1 ? '' : 's'}</span>
          </span>
          <span className="font-mono">{usd(cost)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!waiting || act.isPending}
            onClick={() =>
              act.mutate(
                { action: 'archive-done' },
                { onSuccess: (r) => setResult(((r as { archived?: string[] }).archived ?? []).length ? `Archived ${(r as { archived: string[] }).archived.join(', ')}` : 'Nothing to archive') },
              )
            }
            data-testid="archive-done"
            title="Archive the integrated packages that are still on the board"
          >
            Archive done{waiting ? ` (${waiting})` : ''}
          </Button>
          {result && <span role="status" className="text-working" data-testid="archive-done-result">{result}</span>}
          {act.error && <span role="alert" className="text-error">{(act.error as Error).message}</span>}
        </div>
      </div>
      {error && <div role="alert" className="text-error">Could not load the archive: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && !rows.length && <Empty>Nothing archived yet. Integrated packages land here a day after they are integrated, or with Archive done.</Empty>}
      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="hidden gap-x-3 border-b border-line px-3 py-2 text-xs uppercase tracking-wider text-muted sm:flex" aria-hidden="true">
            <span className="w-20 shrink-0">Id</span>
            <span className="flex-1">Package</span>
            <span className="w-24 text-right">Integrated</span>
            <span className="w-16 text-right">Rounds</span>
            <span className="w-16 text-right">Took</span>
            <span className="w-14 text-right">Cost</span>
          </div>
          <ul className="divide-y divide-line" data-testid="done-list">
            {rows.map((t) => (
              <li key={t.id} data-testid="done-row" data-task={t.id}>
                <Link to={`/backlog/${encodeURIComponent(t.id)}`} className="flex min-h-[44px] flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-panel-2 sm:flex-nowrap">
                  <span className="shrink-0 font-mono text-sm font-semibold text-accent sm:w-20">{t.id}</span>
                  <span className="min-w-0 flex-1 basis-48 text-[15px] leading-snug [overflow-wrap:anywhere]">
                    {t.title}
                    {t.status !== 'integrata' && (
                      <span className="ml-2 align-middle">
                        <StatusBadge status={t.status} />
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-wrap gap-x-3 text-sm text-muted sm:justify-end">
                    <span className="sm:w-24 sm:text-right">{day(t.integratedAt)}</span>
                    <span className="sm:w-16 sm:text-right">
                      {t.round} round{t.round === 1 ? '' : 's'}
                    </span>
                    <span className="sm:w-16 sm:text-right" title="From created to integrated">{t.integratedAt ? took(t.integratedAt - t.createdAt) : '—'}</span>
                    <span className="font-mono text-ink sm:w-14 sm:text-right">{t.costUsd != null ? usd(t.costUsd) : '—'}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
