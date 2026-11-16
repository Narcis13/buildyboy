// Factory projects (SPEC §12.1) in the PWA: the queries, the picker the task forms use, and small shared pieces.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectView } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Field, inputClass } from '../settings/bits.tsx';
import { Badge } from '../ui.tsx';

/** Every project, archived ones included: the pages split them by state. Live through the `tasks` and `inbox` topics. */
export function useFactoryProjects() {
  return useQuery({ queryKey: ['factory-projects', 'all'], queryFn: () => api.get<ProjectView[]>('/api/factory/projects?state=all') });
}

/** POST /api/factory/projects/:key/<action> (pause, resume, archive, unarchive, archive-done, refresh, autopilot {on}). */
export function useProjectAction(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) => api.post<unknown>(`/api/factory/projects/${encodeURIComponent(key)}/${action}`, body ?? {}),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['factory-project', key] });
      qc.invalidateQueries({ queryKey: ['factory-projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Active ones first, then paused, each by name. */
export function openProjects(all: ProjectView[] | undefined): ProjectView[] {
  const rank = { active: 0, paused: 1, archived: 2 } as const;
  return (all ?? []).filter((p) => p.state !== 'archived').sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

/** Packages that are not archived. */
export const openCount = (p: ProjectView) => Object.values(p.counts).reduce((a, b) => a + b, 0);
/** Everything it ever had: open and archived. */
export const totalCount = (p: ProjectView) => openCount(p) + p.archived;
/** Packages on the line. */
export const inFlight = (p: ProjectView) => p.counts.in_lucru + p.counts.la_porti;

/** A free-looking key from a repo or a name, the way the server makes them: "My_Shop.js" → "my-shop-js". */
export function keyFrom(s: string): string {
  const t = s.trim().replace(/\/+$/, '');
  let k = t.slice(t.lastIndexOf('/') + 1).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (k && !/^[a-z]/.test(k)) k = `p-${k}`;
  k = k.slice(0, 24).replace(/-+$/, '');
  return k.length === 1 ? `${k}-p` : k;
}

export function StateBadge({ p }: { p: Pick<ProjectView, 'state'> }) {
  if (p.state === 'active') return null;
  return (
    <span data-testid="project-state">
      <Badge color={p.state === 'paused' ? 'var(--bb-waiting)' : 'var(--bb-ended)'}>{p.state}</Badge>
    </span>
  );
}

/** On, off, or "held": autopilot is on but the conductor leaves the project alone (paused, runner offline, no line…; the reason is `autopilotHeld`). */
export function AutopilotBadge({ p }: { p: Pick<ProjectView, 'autopilot' | 'state' | 'autopilotHeld'> }) {
  return p.autopilot && p.state === 'active' && !p.autopilotHeld ? (
    <Badge color="var(--bb-working)" className="normal-case">autopilot on</Badge>
  ) : (
    <span title={p.autopilot ? (p.autopilotHeld ?? undefined) : undefined}>
      <Badge className="normal-case">{p.autopilot ? 'autopilot held' : 'autopilot off'}</Badge>
    </span>
  );
}

/** "3 of 9 integrated" as a bar. */
export function ProgressBar({ done, total, className = '' }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-label="Integrated"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total} integrated`}
        className="h-2 overflow-hidden rounded-full bg-bg-2"
      >
        <div className="h-full rounded-full bg-working" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-sm text-muted">
        <span className="tabular-nums text-ink">{done}</span> of <span className="tabular-nums">{total}</span> integrated
      </div>
    </div>
  );
}

/**
 * The project a new package goes to: none, or an active or paused one (archived projects take no new packages).
 * `value` '' means no project.
 */
export function ProjectPicker({ id, value, onChange, hint }: { id: string; value: string; onChange: (key: string) => void; hint?: string }) {
  const projects = openProjects(useFactoryProjects().data);
  const chosen = projects.find((p) => p.key === value);
  return (
    <Field
      label="Project"
      htmlFor={id}
      hint={hint ?? (chosen?.state === 'paused' ? 'Paused: nothing starts in it until you resume it.' : undefined)}
    >
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} data-testid={id}>
        <option value="">No project</option>
        {value && !chosen && <option value={value}>{value}</option>}
        {projects.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
            {p.state === 'paused' ? ' (paused)' : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}
