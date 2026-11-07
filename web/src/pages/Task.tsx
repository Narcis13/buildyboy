import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STATUS_LABEL, TASK_STATUSES, type TaskDetail, type TaskStatus, type TaskSummary } from '../../../shared/factory.ts';
import { api, ApiError } from '../lib/api.ts';
import { usd } from '../lib/format.ts';
import { Link } from '../lib/router.tsx';
import { Card, Empty, RelTime } from '../components/ui.tsx';
import { inputClass } from '../components/settings/bits.tsx';
import { ControlSection } from '../components/factory/ControlSection.tsx';
import { DecisionCard } from '../components/factory/DecisionCard.tsx';
import { GatesSection } from '../components/factory/GatesSection.tsx';
import { TaskHistory } from '../components/factory/TaskHistory.tsx';
import { LaunchTask } from '../components/factory/LaunchTask.tsx';
import { GateChips, Section, StatusBadge, TaskFlags } from '../components/factory/common.tsx';

function Meta({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wider text-muted">{label}</dt>
      <dd className="min-h-[1.5rem] truncate text-[15px]" data-testid={testId}>{children}</dd>
    </div>
  );
}

const none = <span className="text-muted">—</span>;

function StatusSelect({ t }: { t: TaskDetail }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (status: TaskStatus) => api.put(`/api/tasks/${encodeURIComponent(t.id)}`, { status }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['task', t.id] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="task-status" className="sr-only">Status</label>
      <select id="task-status" value={t.status} disabled={set.isPending} onChange={(e) => set.mutate(e.target.value as TaskStatus)} className={`${inputClass} w-auto min-w-[10rem]`} data-testid="task-status">
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>{STATUS_LABEL[s]}</option>
        ))}
      </select>
      {set.error && <span role="alert" className="text-error">{(set.error as Error).message}</span>}
    </div>
  );
}

function Deps({ t, all }: { t: TaskDetail; all: TaskSummary[] }) {
  const byId = new Map(all.map((x) => [x.id, x]));
  const unblocks = all.filter((x) => x.dependsOn.includes(t.id));
  const row = (id: string) => {
    const x = byId.get(id);
    return (
      <li key={id}>
        <Link to={`/backlog/${encodeURIComponent(id)}`} className="flex min-h-[44px] items-center gap-3 rounded-lg px-2 hover:bg-panel-2" data-testid="dep-link" data-task={id}>
          <span className="font-mono text-sm font-semibold text-accent">{id}</span>
          <span className="min-w-0 flex-1 truncate text-[15px]">{x?.title ?? ''}</span>
          {x && <StatusBadge status={x.status} />}
        </Link>
      </li>
    );
  };
  return (
    <div className="space-y-3">
      {t.dependsOn.length ? <ul data-testid="deps">{t.dependsOn.map(row)}</ul> : <div className="text-muted">No dependencies.</div>}
      {unblocks.length > 0 && (
        <div>
          <div className="text-sm text-muted">Unblocks</div>
          <ul data-testid="unblocks">{unblocks.map((x) => row(x.id))}</ul>
        </div>
      )}
    </div>
  );
}

export default function Task({ id }: { id: string }) {
  const { data: t, isLoading, error } = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const all = useQuery({ queryKey: ['tasks', 'all'], queryFn: () => api.get<TaskSummary[]>('/api/tasks') });

  if (error) {
    return (
      <div className="mx-auto max-w-3xl space-y-3" data-testid="task-page">
        <Link to="/backlog" className="inline-flex min-h-[44px] items-center text-accent underline">← Backlog</Link>
        <div role="alert" className="text-error">{error instanceof ApiError && error.status === 404 ? `There is no task ${id}.` : `Could not load ${id}: ${(error as Error).message}`}</div>
      </div>
    );
  }
  if (isLoading || !t) return <div className="text-muted" data-testid="task-page">Loading…</div>;

  const pendingDecisions = t.decisions.filter((d) => d.status === 'pending');
  return (
    <div className="mx-auto max-w-[1200px] space-y-5" data-testid="task-page" data-task={t.id}>
      <Link to="/backlog" className="inline-flex min-h-[44px] items-center text-accent underline">← Backlog</Link>

      <Card className="p-4" data-testid="task-header">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base font-semibold text-accent" data-testid="task-id">{t.id}</span>
          <StatusBadge status={t.status} />
          <TaskFlags t={t} />
        </div>
        <h1 className="mt-1 text-xl font-semibold leading-snug [overflow-wrap:anywhere]" data-testid="task-title">{t.title}</h1>
        {t.waitingOn.length > 0 && <p className="mt-1 text-[15px] text-muted">Waits on {t.waitingOn.join(', ')}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <StatusSelect t={t} />
          <GateChips gates={t.gates} />
        </div>
        {t.status !== 'integrata' && (
          <div className="mt-3">
            <LaunchTask task={t} />
          </div>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Meta label="Repo">{t.repo ?? none}</Meta>
          <Meta label="Branch">{t.branch ? <span className="font-mono text-sm" title={t.branch}>{t.branch}</span> : none}</Meta>
          <Meta label="Cost" testId="task-cost">{t.costUsd != null ? usd(t.costUsd) : none}</Meta>
          <Meta label="Claimed by">{t.claimedBy ?? none}</Meta>
          <Meta label="Prompt">
            {t.promptId != null ? (
              <Link to={`/composer/${t.promptId}`} className="inline-flex min-h-[44px] items-center text-accent underline" data-testid="task-prompt">
                #{t.promptId}{t.promptVersion != null ? ` v${t.promptVersion}` : ''}
              </Link>
            ) : (
              none
            )}
          </Meta>
          <Meta label="Session">
            {t.sessionId ? (
              <Link to={`/s/${t.sessionId}`} className="inline-flex min-h-[44px] items-center font-mono text-sm text-accent underline" data-testid="task-session">
                {t.sessionId.slice(0, 8)}
              </Link>
            ) : (
              none
            )}
          </Meta>
          <Meta label="Terminal">{t.terminal ? <span className="font-mono text-sm">{t.terminal}</span> : none}</Meta>
          <Meta label="Job">
            {t.jobId ? (
              <Link to={`/jobs/${t.jobId}`} className="inline-flex min-h-[44px] items-center font-mono text-sm text-accent underline">{t.jobId.slice(0, 8)}</Link>
            ) : (
              none
            )}
          </Meta>
          <Meta label="Priority">{t.priority}</Meta>
          <Meta label="Source">{t.source}{t.extRef ? ` · ${t.extRef}` : ''}</Meta>
          <Meta label="Updated"><RelTime ts={t.updatedAt} /></Meta>
          {t.integratedAt && <Meta label="Integrated"><RelTime ts={t.integratedAt} /></Meta>}
        </dl>
        {t.note && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-panel-2 p-3 text-[15px] [overflow-wrap:anywhere]" data-testid="task-note">{t.note}</p>}
      </Card>

      {pendingDecisions.length > 0 && (
        <Section title="Waiting for your decision" count={pendingDecisions.length} testId="task-pending-decisions">
          <div className="space-y-3">
            {pendingDecisions.map((d) => (
              <DecisionCard key={d.id} d={d} showTask={false} />
            ))}
          </div>
        </Section>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="min-w-0 space-y-5">
          <Section title="Description">
            {t.body ? (
              <Card className="p-4"><div className="whitespace-pre-wrap text-[15px] leading-relaxed [overflow-wrap:anywhere]" data-testid="task-body">{t.body}</div></Card>
            ) : (
              <Empty>No description.</Empty>
            )}
          </Section>
          <Section title="Acceptance criteria" count={t.acceptance.length}>
            {t.acceptance.length ? (
              <ul className="list-disc space-y-1 pl-6 text-[15px]" data-testid="task-acceptance">
                {t.acceptance.map((a, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">{a}</li>
                ))}
              </ul>
            ) : (
              <div className="text-muted">None listed.</div>
            )}
          </Section>
          <Section title="Dependencies" count={t.dependsOn.length}>
            <Deps t={t} all={all.data ?? []} />
          </Section>
          <Section title="Gates" testId="task-gates">
            <GatesSection results={t.gateResults} />
          </Section>
        </div>
        <div className="min-w-0 space-y-5">
          <Section title="Control">
            <ControlSection taskId={t.id} controls={t.controls} />
          </Section>
          {t.decisions.length > pendingDecisions.length && (
            <Section title="Decisions" count={t.decisions.length - pendingDecisions.length}>
              <div className="space-y-3">
                {t.decisions
                  .filter((d) => d.status !== 'pending')
                  .map((d) => (
                    <DecisionCard key={d.id} d={d} showTask={false} />
                  ))}
              </div>
            </Section>
          )}
          <Section title="History" count={t.events.length}>
            <TaskHistory events={t.events} />
          </Section>
        </div>
      </div>
    </div>
  );
}
