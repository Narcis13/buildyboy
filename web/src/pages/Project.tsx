// /projects/:key: one factory project (SPEC §12.9). The header holds its switches (autopilot, pause, archive); the tabs
// are its line, its board, its archive, the activity of its checkouts and its setup. The tab lives in `?tab=`.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectDetail } from '../../../shared/factory.ts';
import { api, ApiError } from '../lib/api.ts';
import { shortPath, usd } from '../lib/format.ts';
import { Link, navigate, useQueryParam } from '../lib/router.tsx';
import { Button, Card, Empty, RelTime, Tabs, Toggle } from '../components/ui.tsx';
import { AutopilotBadge, inFlight, openCount, ProgressBar, StateBadge, totalCount, useProjectAction } from '../components/factory/projects.tsx';
import { CheckoutActivity } from '../components/projects/CheckoutActivity.tsx';
import { ProjectLine } from '../components/projects/ProjectLine.tsx';
import { PlanForm } from '../components/projects/Plans.tsx';
import { ProjectBacklog, ProjectDone } from '../components/projects/ProjectDone.tsx';
import { ProjectSetup } from '../components/projects/ProjectSetup.tsx';

const TABS = ['line', 'backlog', 'done', 'activity', 'setup'] as const;
type Tab = (typeof TABS)[number];

function Header({ p, planOpen, setPlanOpen }: { p: ProjectDetail; planOpen: boolean; setPlanOpen: (open: boolean) => void }) {
  const act = useProjectAction(p.key);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = p.state === 'archived';
  const open = openCount(p);
  const attention = p.attention;
  return (
    <Card className="p-4" data-testid="project-header" data-state={p.state} data-autopilot={p.autopilot ? 'on' : 'off'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="min-w-0 text-xl font-semibold leading-snug [overflow-wrap:anywhere]">{p.name}</h1>
        <StateBadge p={p} />
        <AutopilotBadge p={p} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
        <span className="font-mono">{p.key}</span>
        {p.idPrefix && <span>id prefix <span className="font-mono">{p.idPrefix}</span></span>}
        {p.repo && (/\//.test(p.repo) ? <a className="text-accent underline" target="_blank" rel="noreferrer" href={`https://github.com/${p.repo}`}>{p.repo}</a> : <span>{p.repo}</span>)}
        {p.machineName && <span>{p.machineName}</span>}
        {p.checkout && <span className="font-mono" title={p.checkout}>{shortPath(p.checkout, 2)}</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="project-controls">
        <span data-testid="autopilot-switch">
          <Toggle on={p.autopilot} label="Autopilot" disabled={archived || act.isPending} onChange={(on) => act.mutate({ action: 'autopilot', body: { on } })} />
        </span>
        {!archived &&
          (p.state === 'paused' ? (
            <Button size="sm" variant="primary" disabled={act.isPending} onClick={() => act.mutate({ action: 'resume' })} data-testid="project-resume">Resume</Button>
          ) : (
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'pause' })} data-testid="project-pause">Pause</Button>
          ))}
        {!archived && !planOpen && <Button size="sm" variant="primary" onClick={() => setPlanOpen(true)} data-testid="plan-open">Plan new work</Button>}
        {archived ? (
          <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'unarchive' })} data-testid="project-unarchive">Unarchive</Button>
        ) : confirmArchive ? null : (
          <Button size="sm" disabled={act.isPending} onClick={() => setConfirmArchive(true)} data-testid="project-archive">Archive…</Button>
        )}
      </div>
      {p.autopilot && !archived && (p.autopilotHeld || p.state === 'paused') && (
        <p className="mt-1 text-sm text-waiting [overflow-wrap:anywhere]" data-testid="autopilot-held">
          Autopilot held: {p.autopilotHeld ?? 'the project is paused: work in flight goes on, nothing new starts.'}
        </p>
      )}
      {!archived && planOpen && <PlanForm projectKey={p.key} onClose={() => setPlanOpen(false)} />}
      {!p.autopilot && !archived && <p className="mt-1 text-sm text-muted">Autopilot off: a coordinator session or you move the packages along.</p>}
      {confirmArchive && !archived && (
        <div className="mt-3 space-y-2 rounded-lg border border-waiting p-3" data-testid="project-archive-confirm">
          <p className="text-[15px]">
            Archive {p.name}? {open ? `Its ${open} open package${open === 1 ? ' is' : 's are'} archived with it, and n` : 'N'}othing can start in it until you unarchive it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={act.isPending}
              onClick={() => act.mutate({ action: 'archive' }, { onSettled: () => setConfirmArchive(false) })}
              data-testid="project-archive-confirm-yes"
            >
              Archive project
            </Button>
            <Button size="sm" onClick={() => setConfirmArchive(false)}>Keep</Button>
          </div>
        </div>
      )}
      {act.error && <div role="alert" className="mt-2 text-error">{(act.error as Error).message}</div>}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-6" data-testid="project-stats">
        <ProgressBar done={p.integrated} total={totalCount(p)} className="col-span-2" />
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">On the line</div>
          <div className="text-[15px] tabular-nums">
            {inFlight(p)} <span className="text-sm text-muted">· {p.counts.gata} ready</span>
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">Waits on you</div>
          <div className={`text-[15px] tabular-nums ${attention ? 'font-medium text-waiting' : ''}`} data-testid="project-attention">
            {attention ? `${attention} package${attention === 1 ? '' : 's'}` : 'nothing'}
            {p.openDecisions > 0 && <span className="text-sm font-normal"> · {p.openDecisions} decision{p.openDecisions === 1 ? '' : 's'}</span>}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">Cost</div>
          <div className="font-mono text-[15px]">{usd(p.costUsd)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">Last activity</div>
          <div className="text-[15px]">{p.lastActivityAt ? <RelTime ts={p.lastActivityAt} /> : '—'}</div>
        </div>
      </div>
    </Card>
  );
}

function Activity({ p }: { p: ProjectDetail }) {
  if (!p.checkoutIds.length) {
    return (
      <Empty>
        {p.repo
          ? `No checkout of ${p.repo} has reported to Buildyboy yet. Sessions in a clone of it show up here.`
          : 'Set the repository on the Setup tab to see the sessions, pull requests and commits of its checkouts here.'}
      </Empty>
    );
  }
  return (
    <div className="space-y-8">
      {p.checkoutIds.map((id) => (
        <CheckoutActivity key={id} id={id} heading />
      ))}
    </div>
  );
}

export default function ProjectPage({ projectKey }: { projectKey: string }) {
  const [planOpen, setPlanOpen] = useState(false);
  const tabParam = useQueryParam('tab');
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'line';
  const { data: p, isLoading, error } = useQuery({
    queryKey: ['factory-project', projectKey],
    queryFn: () => api.get<ProjectDetail>(`/api/factory/projects/${encodeURIComponent(projectKey)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const setTab = (t: Tab) => navigate(`/projects/${encodeURIComponent(projectKey)}${t === 'line' ? '' : `?tab=${t}`}`, true);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl space-y-3" data-testid="factory-project-page">
        <Link to="/projects" className="inline-flex min-h-[44px] items-center text-accent underline">← Projects</Link>
        <div role="alert" className="text-error">
          {error instanceof ApiError && error.status === 404 ? `There is no project ${projectKey}.` : `Could not load ${projectKey}: ${(error as Error).message}`}
        </div>
      </div>
    );
  }
  if (isLoading || !p) return <div className="text-muted" data-testid="factory-project-page">Loading…</div>;

  const label = (text: string, n?: number) => (
    <>
      {text}
      {n != null && n > 0 && <span className="ml-1.5 font-mono text-sm text-muted">{n}</span>}
    </>
  );
  return (
    <div className="mx-auto max-w-[1600px] space-y-4" data-testid="factory-project-page" data-project={p.key}>
      <Link to="/projects" className="inline-flex min-h-[44px] items-center text-accent underline">← Projects</Link>
      <Header p={p} planOpen={planOpen} setPlanOpen={setPlanOpen} />
      <Tabs<Tab>
        className="-mx-4 px-4 md:mx-0 md:px-0"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'line', label: label('Line', inFlight(p)) },
          { id: 'backlog', label: label('Backlog', openCount(p)) },
          { id: 'done', label: label('Done', p.archived) },
          { id: 'activity', label: 'Activity' },
          { id: 'setup', label: 'Setup' },
        ]}
      />
      <div data-testid={`project-tab-${tab}`}>
        {tab === 'line' && <ProjectLine p={p} onPlan={() => setPlanOpen(true)} />}
        {tab === 'backlog' && <ProjectBacklog p={p} />}
        {tab === 'done' && <ProjectDone p={p} />}
        {tab === 'activity' && <Activity p={p} />}
        {tab === 'setup' && <ProjectSetup key={p.key} p={p} />}
      </div>
    </div>
  );
}
