import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ProjectView, TaskSummary } from '../../../shared/factory.ts';
import { api } from '../lib/api.ts';
import { Link, navigate, useQueryParam } from '../lib/router.tsx';
import { Button, Empty, PageTitle } from '../components/ui.tsx';
import { inputClass } from '../components/settings/bits.tsx';
import { GovernorBanner } from '../components/factory/GovernorBanner.tsx';
import { ImportPanel } from '../components/factory/ImportPanel.tsx';
import { fetchOpenMinors, OPEN_MINORS_KEY, OpenMinors } from '../components/factory/OpenMinors.tsx';
import { NewTaskForm } from '../components/factory/NewTaskForm.tsx';
import { TaskBoard } from '../components/factory/TaskBoard.tsx';
import { openProjects, useFactoryProjects } from '../components/factory/projects.tsx';

/** `?project=`: a project key, `none` (packages without a project), or absent (all). */
const NONE = 'none';

function SwitchItem({ to, on, label, count, testId, sub }: { to: string; on: boolean; label: string; count: number; testId: string; sub?: string }) {
  return (
    <Link
      to={to}
      aria-current={on ? 'page' : undefined}
      data-testid={testId}
      className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-[15px] ${on ? 'border-accent bg-panel-2 text-ink' : 'border-line text-muted hover:text-ink'}`}
    >
      {label}
      {sub && <span className="text-xs text-muted">{sub}</span>}
      <span className="font-mono text-sm text-muted">{count}</span>
    </Link>
  );
}

/** All · each active or paused project · No project, remembered in the URL. */
function ProjectSwitcher({ projects, tasks, value }: { projects: ProjectView[]; tasks: TaskSummary[]; value: string | null }) {
  const n = (f: (t: TaskSummary) => boolean) => tasks.filter(f).length;
  const none = n((t) => !t.project);
  return (
    <nav aria-label="Project" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1" data-testid="project-switcher">
      <SwitchItem to="/backlog" on={!value} label="All" count={tasks.length} testId="switch-all" />
      {projects.map((p) => (
        <SwitchItem
          key={p.key}
          to={`/backlog?project=${encodeURIComponent(p.key)}`}
          on={value === p.key}
          label={p.name}
          sub={p.state === 'paused' ? 'paused' : undefined}
          count={n((t) => t.project === p.key)}
          testId={`switch-${p.key}`}
        />
      ))}
      {(none > 0 || value === NONE) && <SwitchItem to={`/backlog?project=${NONE}`} on={value === NONE} label="No project" count={none} testId="switch-none" />}
      <Link to="/projects" className="inline-flex min-h-[44px] shrink-0 items-center px-2 text-[15px] text-accent underline" data-testid="switch-projects">
        Projects
      </Link>
    </nav>
  );
}

/** Under the Integrată column: where the integrated packages went (each project's Done tab). */
function ArchiveLinks({ projects }: { projects: ProjectView[] }) {
  const withArchive = projects.filter((p) => p.archived > 0);
  if (!withArchive.length) return null;
  return (
    <div className="flex flex-wrap gap-x-3 text-sm" data-testid="archive-links">
      {withArchive.map((p) => (
        <Link key={p.key} to={`/projects/${encodeURIComponent(p.key)}?tab=done`} className="inline-flex min-h-[44px] items-center text-accent underline md:min-h-8" data-testid="archive-link">
          {withArchive.length > 1 || projects.length > 1 ? `${p.name}: ${p.archived} archived` : `${p.archived} archived`}
        </Link>
      ))}
    </div>
  );
}

export default function Backlog() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [panel, setPanel] = useState<'new' | 'import' | null>(null);
  const [minors, setMinors] = useState(false);
  const project = useQueryParam('project');
  const minorCount = useQuery({ queryKey: OPEN_MINORS_KEY, queryFn: fetchOpenMinors }).data?.length;
  const projects = openProjects(useFactoryProjects().data);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // every open package (the API leaves archived ones out); the switcher filters here, so its counts follow the search
  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'list', q],
    queryFn: () => api.get<TaskSummary[]>(`/api/tasks${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const chosen = project && project !== NONE ? projects.find((p) => p.key === project) : undefined;
  const shown = !data ? undefined : !project ? data : project === NONE ? data.filter((t) => !t.project) : data.filter((t) => t.project === project);
  const archive: ReactNode = project === NONE ? null : <ArchiveLinks projects={chosen ? [chosen] : project ? [] : projects} />;
  const formProject = chosen?.key ?? '';

  return (
    <div data-testid="backlog-page" className="mx-auto max-w-[1600px]">
      <PageTitle
        right={
          <div className="flex gap-2">
            <Button variant={panel === 'import' ? 'primary' : 'ghost'} onClick={() => setPanel(panel === 'import' ? null : 'import')} data-testid="import-open">Import</Button>
            <Button variant="primary" onClick={() => setPanel(panel === 'new' ? null : 'new')} data-testid="new-task-open">New task</Button>
          </div>
        }
      >
        Backlog
      </PageTitle>
      <ProjectSwitcher projects={projects} tasks={data ?? []} value={project} />
      <GovernorBanner />
      {chosen?.state === 'paused' && (
        <div className="mb-3 rounded-lg border border-waiting px-3 py-2 text-[15px]" data-testid="backlog-paused">
          {chosen.name} is paused: nothing new starts in it.{' '}
          <Link to={`/projects/${encodeURIComponent(chosen.key)}`} className="text-accent underline">Open the project</Link>
        </div>
      )}
      {panel === 'new' && (
        <NewTaskForm
          key={formProject}
          project={formProject}
          onDone={(id) => {
            setPanel(null);
            if (id) navigate(`/backlog/${encodeURIComponent(id)}`);
          }}
        />
      )}
      {panel === 'import' && <ImportPanel key={formProject} project={formProject} onClose={() => setPanel(null)} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search tasks"
          placeholder="Search id, title or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${inputClass} min-w-0 flex-1 basis-56 md:max-w-md`}
          data-testid="backlog-search"
        />
        <Button variant={minors ? 'primary' : 'ghost'} aria-pressed={minors} onClick={() => setMinors(!minors)} data-testid="backlog-open-minors">
          Open minors{minorCount != null ? ` ${minorCount}` : ''}
        </Button>
      </div>
      {error && <div role="alert" className="mb-3 text-error">Could not load the backlog: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {minors && <OpenMinors tasks={shown ?? []} />}
      {!minors && shown && !shown.length && !q && (
        <>
          <Empty>{project ? 'No open packages here.' : 'No tasks yet. Create one, or import Markdown files or GitHub issues.'}</Empty>
          {archive && <div className="mt-3">{archive}</div>}
        </>
      )}
      {!minors && shown && !shown.length && q && <Empty>No task matches “{q}”.</Empty>}
      {!minors && shown && shown.length > 0 && <TaskBoard tasks={shown} showProject={!project} archive={archive} />}
    </div>
  );
}
