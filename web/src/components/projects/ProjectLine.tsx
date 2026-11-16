// A project's Line tab: its packages in flight, each with the stage stepper, round, worker and what it waits for; the
// project's pending decisions, answerable here; and the next ready packages.
import { useQuery } from '@tanstack/react-query';
import type { DecisionView, ProjectDetail, TaskSummary } from '../../../../shared/factory.ts';
import type { SessionSummary } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { usd } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { Card, Empty, Lamp, statusLabel } from '../ui.tsx';
import { DecisionCard } from '../factory/DecisionCard.tsx';
import { Section, STAGE_LABEL, StageStepper, stageOf, StatusBadge, TaskCard, TaskFlags } from '../factory/common.tsx';

/** One short line: what the package is waiting for now. `owner`: it waits on the owner. */
function waitsFor(t: TaskSummary, decisions: DecisionView[], session: SessionSummary | undefined): { text: string; owner?: boolean } {
  const asks = decisions.filter((d) => d.taskId === t.id).length;
  if (asks) return { text: `Waits on you: ${asks} decision${asks > 1 ? 's' : ''} below`, owner: true };
  if (t.status === 'blocata') return { text: 'Blocked', owner: true };
  if (t.openControls) return { text: 'A stop or revert request is open' };
  const at = stageOf(t);
  if (!at) return { text: '' };
  if (at.stage === 'build') {
    if (!t.sessionId) return { text: 'Waits for a worker' };
    if (session?.status === 'waiting') return { text: 'The worker waits on you (Inbox)', owner: true };
    return { text: session ? `Worker: ${statusLabel(session.status).toLowerCase()}` : 'Worker at work' };
  }
  const v = (t.gates as Record<string, string | undefined>)[at.stage];
  if (v === 'fail') return { text: `${at.stage} failed: back to the worker with the findings` };
  return { text: `${STAGE_LABEL[at.stage]} next` };
}

function LineCard({ t, decisions, session }: { t: TaskSummary; decisions: DecisionView[]; session: SessionSummary | undefined }) {
  const w = waitsFor(t, decisions, session);
  return (
    <Card className="space-y-3 p-3 sm:p-4" data-testid="line-card" data-task={t.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/backlog/${encodeURIComponent(t.id)}`} className="inline-flex min-h-[32px] items-center font-mono text-sm font-semibold text-accent underline">{t.id}</Link>
        <StatusBadge status={t.status} />
        <TaskFlags t={t} />
        {t.costUsd != null && <span className="ml-auto text-sm tabular-nums text-muted">{usd(t.costUsd)}</span>}
      </div>
      <Link to={`/backlog/${encodeURIComponent(t.id)}`} className="block text-[15px] font-medium leading-snug [overflow-wrap:anywhere] hover:underline">{t.title}</Link>
      <StageStepper t={t} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-muted" data-testid="line-round">{t.round > 0 ? `Round ${t.round} of ${t.maxRounds}` : 'Before its first round'}</span>
        {t.sessionId && (
          <Link to={`/s/${t.sessionId}`} className="inline-flex min-h-[44px] items-center gap-2 text-accent underline md:min-h-8" data-testid="line-session">
            {session && <Lamp status={session.status} size={10} />}
            worker {t.sessionId.slice(0, 8)}
          </Link>
        )}
        {w.text && (
          <span className={w.owner ? 'font-medium text-waiting' : 'text-muted'} data-testid="line-waits">
            {w.text}
          </span>
        )}
      </div>
    </Card>
  );
}

export function ProjectLine({ p }: { p: ProjectDetail }) {
  const sessionIds = p.line.map((t) => t.sessionId).filter(Boolean);
  // the workers' lamps; the list is live through the floor topic
  const sessions = useQuery({
    queryKey: ['sessions', 'line'],
    queryFn: () => api.get<SessionSummary[]>('/api/sessions?limit=300'),
    enabled: sessionIds.length > 0,
  });
  const byId = new Map((sessions.data ?? []).map((s) => [s.id, s]));
  // blocked packages wait on the owner too (they count in `attention`); the detail does not carry them
  const blocked = useQuery({
    queryKey: ['tasks', 'project', p.key, 'blocked'],
    queryFn: () => api.get<TaskSummary[]>(`/api/tasks?project=${encodeURIComponent(p.key)}&status=blocata`),
    enabled: p.counts.blocata > 0,
  });
  const emptyLine = !p.next.length
    ? 'No package is ready either.'
    : p.state === 'paused'
      ? 'The project is paused: resume it to start the next one.'
      : p.state === 'archived'
        ? 'The project is archived.'
        : p.autopilot
          ? 'The next ready package starts when the governor allows it.'
          : 'Turn autopilot on, or claim the next package by hand.';
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <Section title="On the line" count={p.line.length} testId="project-line">
        {p.line.length ? (
          <ul className="space-y-3">
            {p.line.map((t) => (
              <li key={t.id}>
                <LineCard t={t} decisions={p.decisions} session={t.sessionId ? byId.get(t.sessionId) : undefined} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing on the line. {emptyLine}</Empty>
        )}
      </Section>
      <div className="min-w-0 space-y-5">
        {(blocked.data?.length ?? 0) > 0 && (
          <Section title="Blocked" count={blocked.data!.length} testId="project-blocked">
            <ul className="flex flex-col gap-2">
              {blocked.data!.map((t) => (
                <li key={t.id}>
                  <TaskCard t={t} />
                </li>
              ))}
            </ul>
          </Section>
        )}
        {p.decisions.length > 0 && (
          <Section title="Waiting for your decision" count={p.decisions.length} testId="project-decisions">
            <div className="space-y-3">
              {p.decisions.map((d) => (
                <DecisionCard key={d.id} d={d} />
              ))}
            </div>
          </Section>
        )}
        <Section title="Next up" count={p.next.length} testId="project-next">
          {p.next.length ? (
            <ul className="flex flex-col gap-2">
              {p.next.slice(0, 8).map((t) => (
                <li key={t.id}>
                  <TaskCard t={t} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No package is ready. Move one to Gata on the Backlog tab, or import a plan.</Empty>
          )}
        </Section>
      </div>
    </div>
  );
}
