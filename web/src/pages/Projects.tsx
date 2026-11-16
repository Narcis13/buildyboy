// /projects: the factory projects (active, paused; archived behind a toggle), then the repositories telemetry has seen
// that are not on the factory yet. /projects/new: the new-project form. /projects/:key: a project (pages/Project.tsx).
// /projects/checkout/:id, and the old /projects/<number>: one checkout's activity, as before factory projects.
import { useState } from 'react';
import type { ProjectView } from '../../../shared/factory.ts';
import { usd } from '../lib/format.ts';
import { Link, navigate, useLocation } from '../lib/router.tsx';
import { Button, Card, Empty, PageTitle, RelTime } from '../components/ui.tsx';
import { CheckoutPage, useCheckouts, type CheckoutListItem } from '../components/projects/CheckoutActivity.tsx';
import { NewProjectForm, newProjectHref, prefillFromSearch } from '../components/projects/NewProjectForm.tsx';
import { AutopilotBadge, inFlight, keyFrom, ProgressBar, StateBadge, totalCount, useFactoryProjects } from '../components/factory/projects.tsx';
import ProjectPage from './Project.tsx';

function ProjectCard({ p }: { p: ProjectView }) {
  const flight = inFlight(p);
  return (
    <Link to={`/projects/${encodeURIComponent(p.key)}`} data-testid="factory-project-card" data-project={p.key} data-state={p.state} className="block h-full min-h-[44px]">
      <Card className="flex h-full flex-col gap-3 p-4 transition hover:border-accent">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{p.name}</div>
            <div className="truncate font-mono text-sm text-muted">
              {p.key}
              {p.repo && p.repo !== p.key ? ` · ${p.repo}` : ''}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <StateBadge p={p} />
            <AutopilotBadge p={p} />
          </div>
        </div>
        <ProgressBar done={p.integrated} total={totalCount(p)} />
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[15px]">
          <span data-testid="card-in-flight">
            <span className="tabular-nums">{flight}</span> <span className="text-muted">on the line</span>
          </span>
          <span>
            <span className="tabular-nums">{p.counts.gata}</span> <span className="text-muted">ready</span>
          </span>
          {p.attention > 0 && (
            <span className="font-medium text-waiting" data-testid="card-attention">
              {p.attention} wait{p.attention === 1 ? 's' : ''} on you
              {p.openDecisions > 0 && (
                <span className="font-normal">
                  {' '}({p.openDecisions} decision{p.openDecisions === 1 ? '' : 's'})
                </span>
              )}
            </span>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span className="font-mono text-ink">{usd(p.costUsd)}</span>
          <span>{p.lastActivityAt ? <RelTime ts={p.lastActivityAt} /> : 'no activity yet'}</span>
          {p.machineName && <span>{p.machineName}</span>}
        </div>
      </Card>
    </Link>
  );
}

function OtherRepo({ c }: { c: CheckoutListItem }) {
  const repo = c.ghOwner && c.ghRepo ? `${c.ghOwner}/${c.ghRepo}` : '';
  const href = newProjectHref({ key: keyFrom(c.ghRepo ?? c.name), name: c.ghRepo ?? c.name, repo, machineId: c.machineId, checkout: c.rootPath });
  return (
    <Card className="flex h-full flex-col gap-2 p-4" data-testid="other-repo" data-checkout={c.id}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-base font-semibold">{c.name}</span>
        <span className="shrink-0 font-mono text-sm">{usd(c.costUsd)}</span>
      </div>
      <div className="truncate font-mono text-sm text-muted" title={c.rootPath}>{c.rootPath}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span>{c.machineName}</span>
        {repo && <span>{repo}</span>}
        <span>
          {c.sessions} session{c.sessions === 1 ? '' : 's'}
        </span>
        <span>{c.lastEventAt ? <RelTime ts={c.lastEventAt} /> : 'no activity'}</span>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="primary" onClick={() => navigate(href)} data-testid="put-on-factory">Put on the factory</Button>
        <Link to={`/projects/checkout/${c.id}`} className="inline-flex min-h-[44px] items-center px-2 text-[15px] text-accent underline md:min-h-9" data-testid="other-repo-activity">
          Activity
        </Link>
      </div>
    </Card>
  );
}

function ProjectList() {
  const projects = useFactoryProjects();
  const checkouts = useCheckouts();
  const [showArchived, setShowArchived] = useState(false);
  const all = projects.data ?? [];
  const byName = (a: ProjectView, b: ProjectView) => a.name.localeCompare(b.name);
  const active = all.filter((p) => p.state === 'active').sort(byName);
  const paused = all.filter((p) => p.state === 'paused').sort(byName);
  const archived = all.filter((p) => p.state === 'archived').sort(byName);
  const onFactory = new Set(all.flatMap((p) => p.checkoutIds));
  const others = (checkouts.data ?? []).filter((c) => !onFactory.has(c.id));

  return (
    <div data-testid="projects-page">
      <PageTitle right={<Button variant="primary" onClick={() => navigate('/projects/new')} data-testid="new-project-open">New project</Button>}>Projects</PageTitle>
      {projects.error && <div role="alert" className="mb-3 text-error">Could not load projects: {(projects.error as Error).message}</div>}
      {projects.isLoading && <div className="text-muted">Loading…</div>}
      {projects.data && !active.length && !paused.length && (
        <Empty>No factory project yet. Put one of your repositories on the factory below, or create one with New project.</Empty>
      )}
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="factory-projects">
        {[...active, ...paused].map((p) => (
          <li key={p.key}>
            <ProjectCard p={p} />
          </li>
        ))}
      </ul>
      {archived.length > 0 && (
        <div className="mt-3">
          <Button size="sm" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)} data-testid="toggle-archived">
            {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
          </Button>
          {showArchived && (
            <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="archived-projects">
              {archived.map((p) => (
                <li key={p.key}>
                  <ProjectCard p={p} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="mt-8" data-testid="other-repos">
        <h2 className="mb-1 text-base font-semibold tracking-wide">
          Other repositories <span className="font-mono text-sm font-normal text-muted">{others.length}</span>
        </h2>
        <p className="mb-3 text-sm text-muted">Checkouts your sessions worked in that no factory project covers yet.</p>
        {checkouts.error && <div role="alert" className="mb-3 text-error">Could not load the repositories: {(checkouts.error as Error).message}</div>}
        {checkouts.data && !others.length && <Empty>Every repository Buildyboy has seen is on the factory.</Empty>}
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {others.map((c) => (
            <li key={c.id}>
              <OtherRepo c={c} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NewProject() {
  const { search } = useLocation();
  return (
    <div data-testid="new-project-page" className="mx-auto max-w-4xl">
      <Link to="/projects" className="inline-flex min-h-[44px] items-center text-accent underline">← Projects</Link>
      <PageTitle>New project</PageTitle>
      <p className="-mt-2 mb-4 text-[15px] text-muted">A project owns its packages, its line and its history. Where its line runs can be set now or later, on its Setup tab.</p>
      {/* keyed by the query, so a second "Put on the factory" refills it */}
      <NewProjectForm key={search} prefill={prefillFromSearch(search)} />
    </div>
  );
}

export default function Projects({ id, checkout }: { id?: string; checkout?: string }) {
  if (checkout) return <CheckoutPage id={checkout} />;
  if (!id) return <ProjectList />;
  if (id === 'new') return <NewProject />;
  // the old numeric checkout pages; project keys start with a letter
  if (/^\d+$/.test(id)) return <CheckoutPage id={id} />;
  return <ProjectPage projectKey={id} />;
}
