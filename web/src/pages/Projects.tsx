import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JobStatus, SessionSummary } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { relTime, usd } from '../lib/format.ts';
import { Link } from '../lib/router.tsx';
import { Badge, Card, Empty, Lamp, Markdown, PageTitle, RelTime, statusLabel } from '../components/ui.tsx';
import { BarChart } from '../components/charts/BarChart.tsx';

interface ProjectListItem {
  id: number;
  machineId: string;
  machineName: string;
  rootPath: string;
  name: string;
  gitRemote: string | null;
  ghOwner: string | null;
  ghRepo: string | null;
  sessions: number;
  lastEventAt: number | null;
  costUsd: number;
}

interface ProjectDetail {
  project: {
    id: number; machine_id: string; machine_name: string; root_path: string; name: string;
    git_remote: string | null; gh_owner: string | null; gh_repo: string | null; default_branch: string | null;
  };
  sessions: SessionSummary[];
  jobs: { id: string; title: string | null; status: JobStatus; costUsd: number | null; createdAt: number; endedAt: number | null }[];
  prs: { number: number | null; url: string; title: string | null; state: string | null; branch: string | null; checksState: string | null; updatedAt: number | null; sessionId: string | null }[];
  commits: { sha: string; ts: number; message: string | null; author: string | null; files: number | null; added: number | null; removed: number | null; sessionId: string | null }[];
  costByDay: { day: string; cost: number }[];
  progress: { sessionId: string; ts: number; content: string }[];
}

const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

function checksColor(state: string | null): string {
  if (state === 'success' || state === 'passing') return 'var(--bb-working)';
  if (state === 'failure' || state === 'failing' || state === 'error') return 'var(--bb-error)';
  if (state === 'pending' || state === 'running') return 'var(--bb-waiting)';
  return 'var(--bb-muted)';
}

function jobColor(s: JobStatus): string {
  if (s === 'succeeded') return 'var(--bb-working)';
  if (s === 'failed' || s === 'lost') return 'var(--bb-error)';
  if (s === 'running' || s === 'starting') return 'var(--bb-idle)';
  return 'var(--bb-muted)';
}

function Section({ title, count, children, testId }: { title: string; count?: number; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="min-w-0">
      <h2 className="mb-2 flex items-baseline gap-2 text-base font-semibold tracking-wide">
        {title}
        {count != null && <span className="font-mono text-sm font-normal text-muted">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function ProjectList() {
  const { data, isLoading, error } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectListItem[]>('/api/projects'), refetchInterval: 30_000 });
  return (
    <div data-testid="projects-page">
      <PageTitle>Projects</PageTitle>
      {error && <div role="alert" className="mb-3 text-error">Could not load projects: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && data.length === 0 && <Empty>No projects yet. They appear as soon as a session reports its git repository.</Empty>}
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} data-testid="project-card" className="block min-h-[44px]">
              <Card className="p-4 transition hover:border-accent">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-base font-semibold">{p.name}</span>
                  <span className="shrink-0 font-mono text-sm">{usd(p.costUsd)}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-sm text-muted" title={p.rootPath}>{p.rootPath}</div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                  <span>{p.machineName}</span>
                  <span>{p.sessions} session{p.sessions === 1 ? '' : 's'}</span>
                  {p.ghOwner && <span>{p.ghOwner}/{p.ghRepo}</span>}
                  <span>{p.lastEventAt ? relTime(p.lastEventAt) : 'no activity'}</span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectPage({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
    refetchInterval: 30_000,
  });

  const costBars = useMemo(() => {
    if (!data?.costByDay.length) return [];
    const byDay = new Map(data.costByDay.map((d) => [d.day, d.cost]));
    const first = Date.parse(`${data.costByDay[0].day}T00:00:00Z`);
    const last = Math.max(Date.parse(`${data.costByDay[data.costByDay.length - 1].day}T00:00:00Z`), Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`));
    const start = Math.max(first, last - 59 * 86_400_000);
    const out: { label: string; values: Record<string, number> }[] = [];
    for (let t = start; t <= last; t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      out.push({ label: day, values: { cost: byDay.get(day) ?? 0 } });
    }
    return out;
  }, [data]);

  if (error) return <div role="alert" className="text-error">Could not load project: {(error as Error).message}. <Link to="/projects" className="text-accent underline">All projects</Link></div>;
  if (isLoading || !data) return <div className="text-muted">Loading…</div>;
  const { project: p } = data;
  const totalCost = data.sessions.reduce((s, x) => s + x.costUsd, 0);

  return (
    <div data-testid="project-page">
      <PageTitle right={<Link to="/projects" className="flex min-h-[44px] items-center text-accent underline">All projects</Link>}>{p.name}</PageTitle>
      <Card className="mb-4 p-4">
        <div className="break-all font-mono text-sm text-muted">{p.root_path}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
          <span>{p.machine_name}</span>
          {p.default_branch && <span className="text-muted">default {p.default_branch}</span>}
          {p.gh_owner && p.gh_repo && <a className="text-accent underline" target="_blank" rel="noreferrer" href={`https://github.com/${p.gh_owner}/${p.gh_repo}`}>{p.gh_owner}/{p.gh_repo}</a>}
          <span className="font-mono">{usd(totalCost)} total</span>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Cost over time" testId="project-cost">
          <Card className="p-4">
            {costBars.length ? <BarChart data={costBars} series={['cost']} format={money} ariaLabel={`Cost per day for ${p.name}`} testId="project-cost-chart" /> : <div className="text-muted">No cost recorded yet.</div>}
          </Card>
        </Section>

        <Section title="Sessions" count={data.sessions.length} testId="project-sessions">
          {data.sessions.length === 0 ? <Empty>No sessions.</Empty> : (
            <ul className="space-y-2">
              {data.sessions.slice(0, 20).map((s) => (
                <li key={s.id}>
                  <Link to={`/s/${s.id}`} className="block min-h-[44px]">
                    <Card className="flex items-center gap-3 p-3 transition hover:border-accent">
                      <Lamp status={s.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{s.name ?? s.id.slice(0, 8)}</span>
                        <span className="block truncate text-sm text-muted">{statusLabel(s.status)}{s.branch ? ` · ${s.branch}` : ''} · <RelTime ts={s.lastEventAt} /></span>
                      </span>
                      <span className="shrink-0 font-mono text-sm">{usd(s.costUsd)}</span>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Jobs" count={data.jobs.length} testId="project-jobs">
          {data.jobs.length === 0 ? <Empty>No jobs ran in this project.</Empty> : (
            <ul className="space-y-2">
              {data.jobs.slice(0, 15).map((j) => (
                <li key={j.id}>
                  <Link to={`/jobs/${j.id}`} className="block min-h-[44px]">
                    <Card className="flex items-center gap-3 p-3 transition hover:border-accent">
                      <Badge color={jobColor(j.status)}>{j.status}</Badge>
                      <span className="min-w-0 flex-1 truncate text-[15px]">{j.title ?? j.id.slice(0, 8)}</span>
                      <span className="shrink-0 text-sm text-muted">{j.costUsd != null ? usd(j.costUsd) : relTime(j.createdAt)}</span>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Pull requests" count={data.prs.length} testId="project-prs">
          {data.prs.length === 0 ? <Empty>No pull requests linked yet. Add a GitHub token in Settings to track checks.</Empty> : (
            <ul className="space-y-2">
              {data.prs.map((pr) => (
                <li key={pr.url}>
                  <a href={pr.url} target="_blank" rel="noreferrer" className="block min-h-[44px]">
                    <Card className="p-3 transition hover:border-accent">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-muted">#{pr.number}</span>
                        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{pr.title ?? pr.url}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
                        <Badge color={pr.state === 'merged' ? 'var(--bb-tool-edit)' : pr.state === 'open' ? 'var(--bb-working)' : 'var(--bb-muted)'}>{pr.state ?? 'unknown'}</Badge>
                        <Badge color={checksColor(pr.checksState)}>checks: {pr.checksState ?? 'none'}</Badge>
                        {pr.branch && <span className="font-mono">{pr.branch}</span>}
                        <span>{relTime(pr.updatedAt)}</span>
                      </div>
                    </Card>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Commits" count={data.commits.length} testId="project-commits">
          {data.commits.length === 0 ? <Empty>No commits recorded.</Empty> : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
              {data.commits.slice(0, 30).map((c) => (
                <li key={c.sha} className="p-3">
                  <div className="text-[15px]">{c.message?.split('\n')[0] ?? '(no message)'}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted">
                    <span className="font-mono">{c.sha.slice(0, 7)}</span>
                    <span>{c.author}</span>
                    {c.files != null && <span>{c.files} files</span>}
                    <span><span className="text-working">+{c.added ?? 0}</span> <span className="text-error">−{c.removed ?? 0}</span></span>
                    <span>{relTime(c.ts)}</span>
                    {c.sessionId && <Link to={`/s/${c.sessionId}`} className="text-accent underline">session</Link>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent PROGRESS.md" count={data.progress.length} testId="project-progress">
          {data.progress.length === 0 ? <Empty>No PROGRESS.md captured. Harness runs write one at each Stop.</Empty> : (
            <div className="space-y-3">
              {data.progress.map((d, i) => (
                <details key={d.sessionId + d.ts} open={i === 0} className="rounded-xl border border-line bg-panel">
                  <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 px-4 text-[15px]">
                    <span>Session {d.sessionId.slice(0, 8)}</span>
                    <span className="text-sm text-muted">{relTime(d.ts)}</span>
                  </summary>
                  <div className="border-t border-line px-4 py-3"><Markdown text={d.content} /></div>
                </details>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

export default function Projects({ id }: { id?: string }) {
  return id ? <ProjectPage id={id} /> : <ProjectList />;
}
