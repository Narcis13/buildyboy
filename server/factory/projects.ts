// Factory projects (SPEC §12.1, §12.2). A project owns its packages, its config and its history. Its machine, checkout
// and line file say where its line runs, so only the owner (and, from §12.7, an operator) sets them; every agent may
// read them. Its id prefix owns the package ids that start with it. `paused`: nothing new starts in it; `archived`: it
// is hidden, its packages are archived, nothing starts. Archived packages leave the default lists; a background sweep
// archives packages integrated more than `archive_done_after_hours` ago (default 24, 0 = off).
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import {
  ID_PREFIX_RE, PROJECT_KEY_RE, TASK_STATUSES, projectConfigSchema, type ProjectAction, type ProjectConfig, type ProjectCreate, type ProjectDetail,
  type ProjectPatch, type ProjectState, type ProjectView, type TaskStatus,
} from '../../shared/factory.ts';
import { syncTaskSessions, taskCosts } from './cost.ts';
import { listDecisions } from './decisions.ts';
import { FactoryError, listTasks, taskEvent } from './tasks.ts';

export interface ProjectRow {
  key: string; name: string; repo: string | null; id_prefix: string; machine_id: string | null; checkout: string | null; line_file: string;
  config_json: string; line_json: string | null; line_seen_at: number | null; line_error: string | null; state: ProjectState; autopilot: number;
  created_at: number; updated_at: number; archived_at: number | null;
}

/** archive_done_after_hours when unset */
export const DEFAULT_ARCHIVE_AFTER_HOURS = 24;

const publish = (ctx: Ctx, key: string) => ctx.bus.publish('tasks', 'project', { key });

export function projectRow(ctx: Ctx, key: string | null | undefined): ProjectRow | null {
  return key ? (ctx.db.get<ProjectRow>('SELECT * FROM factory_projects WHERE key = ?', key) ?? null) : null;
}

export function requireProject(ctx: Ctx, key: string): ProjectRow {
  const p = projectRow(ctx, key);
  if (!p) throw new FactoryError(404, `unknown project ${key}`);
  return p;
}

/** Projects in these states (all of them when none are given), oldest first. */
export function listProjectRows(ctx: Ctx, states?: readonly ProjectState[]): ProjectRow[] {
  if (states && !states.length) return [];
  const where = states ? `WHERE state IN (${states.map(() => '?').join(',')})` : '';
  return ctx.db.all<ProjectRow>(`SELECT * FROM factory_projects ${where} ORDER BY created_at, key`, ...(states ?? []));
}

export function projectConfig(p: ProjectRow): ProjectConfig {
  const c = projectConfigSchema.safeParse(json(p.config_json, {}));
  return c.success ? c.data : {};
}

/** The project of `repo` (ignoring case); archived projects only when asked. */
export function projectByRepo(ctx: Ctx, repo: string | null | undefined, withArchived = false): ProjectRow | null {
  if (!repo?.trim()) return null;
  return (
    ctx.db.get<ProjectRow>(
      `SELECT * FROM factory_projects WHERE repo IS NOT NULL AND lower(repo) = lower(?) ${withArchived ? '' : "AND state != 'archived'"}
       ORDER BY state = 'archived', created_at, key LIMIT 1`,
      repo.trim(),
    ) ?? null
  );
}

/** Why nothing may start in this project now (claim, launch), or null. */
export function projectBlocks(p: ProjectRow | null): string | null {
  if (p?.state === 'paused') return `project ${p.key} is paused`;
  if (p?.state === 'archived') return `project ${p.key} is archived`;
  return null;
}

// ---------- ids (§12.2) ----------

/** The id without the prefix: `ED-P1` → `P1`. */
export const localIdOf = (id: string, prefix: string): string => (prefix && id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : id);

/** A given id in the project: `P1` → `ED-P1`; one that already starts with the prefix is kept. */
export function projectTaskId(p: ProjectRow | null, id: string): string {
  const pre = p?.id_prefix ?? '';
  return pre && !id.startsWith(pre) ? `${pre}${id}` : id;
}

/** `ED-<n>` for a package created without an id: one more than the highest number used; null without a prefix. */
export function nextProjectTaskId(ctx: Ctx, p: ProjectRow | null): string | null {
  const pre = p?.id_prefix;
  if (!pre) return null;
  const n = ctx.db
    .all<{ id: string }>('SELECT id FROM tasks WHERE id GLOB ?', `${pre}[0-9]*`)
    .map((r) => r.id.slice(pre.length))
    .filter((s) => /^\d+$/.test(s))
    .reduce((m, s) => Math.max(m, Number(s)), 0);
  return `${pre}${n + 1}`;
}

/** Dependencies given as local ids resolve inside the project first (`P1` → `ED-P1` when that exists). */
export function resolveDeps(ctx: Ctx, p: ProjectRow | null, deps: string[]): string[] {
  const pre = p?.id_prefix;
  if (!pre) return deps;
  return deps.map((d) => (!d.startsWith(pre) && ctx.db.get('SELECT 1 FROM tasks WHERE id = ?', `${pre}${d}`) ? `${pre}${d}` : d));
}

/** The project a new package lands in: the given one (never an archived one), else the one of its repo, else none. */
export function projectForNewTask(ctx: Ctx, key: string | undefined, repo: string | undefined): ProjectRow | null {
  if (!key) return projectByRepo(ctx, repo);
  const p = requireProject(ctx, key);
  if (p.state === 'archived') throw new FactoryError(409, `project ${p.key} is archived: unarchive it first`);
  return p;
}

// ---------- views ----------

const zeroCounts = () => Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function views(ctx: Ctx, rows: ProjectRow[]): ProjectView[] {
  if (!rows.length) return [];
  const { db } = ctx;
  const keys = rows.map((r) => r.key);
  const marks = keys.map(() => '?').join(',');
  const counts = db.all<{ project: string; status: TaskStatus; n: number }>(
    `SELECT project, status, COUNT(*) n FROM tasks WHERE project IN (${marks}) AND archived_at IS NULL GROUP BY project, status`, ...keys,
  );
  const totals = new Map(
    db.all<{ project: string; archived: number; integrated: number; last: number | null }>(
      `SELECT project, SUM(archived_at IS NOT NULL) archived, SUM(status = 'integrata') integrated, MAX(updated_at) last FROM tasks WHERE project IN (${marks}) GROUP BY project`, ...keys,
    ).map((t) => [t.project, t]),
  );
  const decisions = new Map(
    db.all<{ project: string; n: number }>(
      `SELECT t.project, COUNT(*) n FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE d.status = 'pending' AND t.project IN (${marks}) GROUP BY t.project`, ...keys,
    ).map((d) => [d.project, d.n]),
  );
  const attention = new Map(
    db.all<{ project: string; n: number }>(
      `SELECT t.project, COUNT(*) n FROM tasks t WHERE t.project IN (${marks}) AND t.archived_at IS NULL
       AND (t.status = 'blocata' OR EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.status = 'pending')) GROUP BY t.project`, ...keys,
    ).map((a) => [a.project, a.n]),
  );
  // cost: the measured sum of each package's linked sessions, else the value set by hand (as TaskSummary.costUsd)
  const tasks = db.all<{ id: string; project: string; cost_usd: number | null }>(`SELECT id, project, cost_usd FROM tasks WHERE project IN (${marks})`, ...keys);
  syncTaskSessions(ctx);
  const measured = new Map<string, number>();
  for (let i = 0; i < tasks.length; i += 2000) for (const [id, c] of taskCosts(ctx, tasks.slice(i, i + 2000).map((t) => t.id))) measured.set(id, c.total);
  const cost = new Map<string, number>();
  for (const t of tasks) cost.set(t.project, (cost.get(t.project) ?? 0) + (measured.get(t.id) ?? t.cost_usd ?? 0));
  const machines = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM machines').map((m) => [m.id, m.name]));
  const checkouts = db.all<{ id: number; owner: string | null; repo: string }>('SELECT id, gh_owner owner, gh_repo repo FROM projects WHERE gh_repo IS NOT NULL ORDER BY id');
  return rows.map((r) => {
    const c = zeroCounts();
    for (const x of counts) if (x.project === r.key && x.status in c) c[x.status] = x.n;
    const t = totals.get(r.key);
    const want = r.repo?.trim().toLowerCase();
    return {
      key: r.key,
      name: r.name,
      repo: r.repo,
      idPrefix: r.id_prefix,
      machineId: r.machine_id,
      machineName: r.machine_id ? (machines.get(r.machine_id) ?? null) : null,
      checkout: r.checkout,
      lineFile: r.line_file,
      config: projectConfig(r),
      resolvedLine: json(r.line_json, null),
      lineSeenAt: r.line_seen_at,
      lineError: r.line_error,
      state: r.state,
      autopilot: !!r.autopilot,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
      counts: c,
      archived: t?.archived ?? 0,
      integrated: t?.integrated ?? 0,
      costUsd: round6(cost.get(r.key) ?? 0),
      openDecisions: decisions.get(r.key) ?? 0,
      attention: attention.get(r.key) ?? 0,
      lastActivityAt: t?.last ?? null,
      // §5 checkouts link through their GitHub repo: owner/name, or the bare name for a project without an owner
      checkoutIds: want ? checkouts.filter((x) => (want.includes('/') ? `${x.owner ?? ''}/${x.repo}` : x.repo).toLowerCase() === want).map((x) => x.id) : [],
    };
  });
}

/** projects_list and GET /api/factory/projects: active and paused ones unless a state (or all) is asked for. */
export function listProjects(ctx: Ctx, f: { state?: ProjectState | 'all' } = {}): ProjectView[] {
  return views(ctx, listProjectRows(ctx, f.state === 'all' ? undefined : f.state ? [f.state] : ['active', 'paused']));
}

export function projectView(ctx: Ctx, key: string): ProjectView {
  return views(ctx, [requireProject(ctx, key)])[0];
}

/** projects_get and GET /api/factory/projects/:key */
export function getProject(ctx: Ctx, key: string): ProjectDetail {
  return {
    ...projectView(ctx, key),
    line: listTasks(ctx, { project: key, status: ['in_lucru', 'la_porti'] }),
    next: listTasks(ctx, { project: key, ready: true }),
    decisions: listDecisions(ctx, { project: key, status: 'pending' }),
  };
}

// ---------- writes (the owner: web; later an operator token) ----------

/** "Narcis13/arond" → "arond" */
export function repoName(repo: string): string {
  const t = repo.trim().replace(/\/+$/, '');
  return t.slice(t.lastIndexOf('/') + 1) || repo.trim();
}

/** A free key made from a repo name, the way migration 009 makes them: "My_Shop.js" → "my-shop-js", then "-2", "-3"… */
export function projectKeyFor(ctx: Ctx, repo: string): string {
  let base = repoName(repo).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z]/.test(base)) base = `p-${base}`;
  base = base.slice(0, 24);
  if (base.length < 2) base = `${base}-p`;
  const taken = (k: string) => !!ctx.db.get('SELECT 1 FROM factory_projects WHERE key = ?', k);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base.slice(0, 23 - String(n).length)}-${n}`;
    if (!taken(k)) return k;
  }
}

function checkMachine(ctx: Ctx, id: string | null | undefined) {
  if (id && !ctx.db.get('SELECT 1 FROM machines WHERE id = ?', id)) throw new FactoryError(400, `unknown machine ${id}`);
}

/** One project per repo, and one per id prefix: either decides which project a package belongs to. */
function checkFree(ctx: Ctx, key: string | null, repo: string | null | undefined, prefix: string | undefined) {
  const byRepo = projectByRepo(ctx, repo, true);
  if (byRepo && byRepo.key !== key) throw new FactoryError(409, `repo ${repo} belongs to project ${byRepo.key}`);
  if (!prefix) return;
  if (!ID_PREFIX_RE.test(prefix)) throw new FactoryError(400, `id prefix ${prefix}: '' or an upper-case prefix ending in '-', e.g. ED-`);
  const byPrefix = ctx.db.get<{ key: string }>('SELECT key FROM factory_projects WHERE id_prefix = ? AND key != ?', prefix, key ?? '');
  if (byPrefix) throw new FactoryError(409, `id prefix ${prefix} belongs to project ${byPrefix.key}`);
}

/** A project adopts the packages of its repo that have no project yet, as migration 009 assigned them. */
function adoptByRepo(ctx: Ctx, key: string, repo: string | null): number {
  if (!repo) return 0;
  return Number(
    ctx.db.run("UPDATE tasks SET project = ?, updated_at = ? WHERE project IS NULL AND trim(COALESCE(repo, '')) <> '' AND lower(trim(repo)) = lower(?)", key, Date.now(), repo.trim()).changes,
  );
}

const packageCount = (ctx: Ctx, key: string) => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM tasks WHERE project = ?', key)!.n;

/** Without a key, one is made from the repo (the /api/factory/config shim creates projects that way). */
export function createProject(ctx: Ctx, input: Omit<ProjectCreate, 'key'> & { key?: string }, actor: string): ProjectRow {
  const repo = input.repo?.trim() || null;
  const key = input.key ?? projectKeyFor(ctx, repo ?? input.name ?? 'project');
  if (!PROJECT_KEY_RE.test(key)) throw new FactoryError(400, `project key ${key}: a lower-case letter, then letters, digits and "-", 2–24 characters`);
  if (projectRow(ctx, key)) throw new FactoryError(409, `project ${key} already exists`);
  checkFree(ctx, key, repo, input.idPrefix);
  checkMachine(ctx, input.machineId);
  const now = Date.now();
  const adopted = ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO factory_projects (key, name, repo, id_prefix, machine_id, checkout, line_file, config_json, state, autopilot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
      key, input.name?.trim() || (repo ? repoName(repo) : key), repo, input.idPrefix ?? '', input.machineId ?? null, input.checkout?.trim() || null,
      input.lineFile?.trim() || 'factory.json', JSON.stringify(input.config ?? {}), now, now,
    );
    return adoptByRepo(ctx, key, repo);
  });
  ctx.db.audit(actor, 'project_create', key, { repo, idPrefix: input.idPrefix ?? '', adopted });
  publish(ctx, key);
  return projectRow(ctx, key)!;
}

export function updateProject(ctx: Ctx, key: string, patch: ProjectPatch, actor: string): ProjectRow {
  const p = requireProject(ctx, key);
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const changed: string[] = [];
  const set = (col: keyof ProjectRow, name: string, v: string | number | null | undefined) => {
    if (v === undefined || p[col] === v) return;
    sets.push(`${col} = ?`);
    args.push(v);
    changed.push(name);
  };
  const repo = patch.repo === undefined ? undefined : patch.repo?.trim() || null;
  if (repo !== undefined || (patch.idPrefix !== undefined && patch.idPrefix !== p.id_prefix)) checkFree(ctx, key, repo, patch.idPrefix !== p.id_prefix ? patch.idPrefix : undefined);
  if (patch.idPrefix !== undefined && patch.idPrefix !== p.id_prefix && packageCount(ctx, key)) {
    throw new FactoryError(409, `project ${key} has packages: its id prefix can no longer change`);
  }
  checkMachine(ctx, patch.machineId);
  set('name', 'name', patch.name?.trim());
  set('repo', 'repo', repo);
  set('id_prefix', 'idPrefix', patch.idPrefix);
  set('machine_id', 'machineId', patch.machineId);
  set('checkout', 'checkout', patch.checkout === undefined ? undefined : patch.checkout?.trim() || null);
  set('line_file', 'lineFile', patch.lineFile?.trim());
  if (patch.config) {
    const merged: Record<string, unknown> = { ...projectConfig(p) };
    for (const [k, v] of Object.entries(patch.config)) {
      if (v === null) delete merged[k];
      else if (v !== undefined) merged[k] = v;
    }
    set('config_json', 'config', JSON.stringify(projectConfigSchema.parse(merged)));
  }
  if (!sets.length) return p;
  const adopted = ctx.db.tx(() => {
    ctx.db.run(`UPDATE factory_projects SET ${sets.join(', ')}, updated_at = ? WHERE key = ?`, ...args, Date.now(), key);
    return changed.includes('repo') ? adoptByRepo(ctx, key, repo ?? null) : 0;
  });
  ctx.db.audit(actor, 'project_update', key, { changed, ...(adopted ? { adopted } : {}) });
  publish(ctx, key);
  return projectRow(ctx, key)!;
}

/** The /api/factory/config shim: machine, checkout and line file as the Settings card sends them, unchecked as before. */
export function setProjectColumns(ctx: Ctx, key: string, c: { machineId: string | null; checkout: string | null; lineFile: string }) {
  ctx.db.run('UPDATE factory_projects SET machine_id = ?, checkout = ?, line_file = ?, updated_at = ? WHERE key = ?', c.machineId, c.checkout, c.lineFile, Date.now(), key);
  publish(ctx, key);
}

export function setProjectConfig(ctx: Ctx, key: string, config: ProjectConfig) {
  ctx.db.run('UPDATE factory_projects SET config_json = ?, updated_at = ? WHERE key = ?', JSON.stringify(config), Date.now(), key);
  publish(ctx, key);
}

/** Only while it has no packages (archived ones count): a project with history is archived instead. */
export function deleteProject(ctx: Ctx, key: string, actor: string) {
  requireProject(ctx, key);
  const n = packageCount(ctx, key);
  if (n) throw new FactoryError(409, `project ${key} has ${n} package${n > 1 ? 's' : ''}: archive it instead`);
  ctx.db.run('DELETE FROM factory_projects WHERE key = ?', key);
  ctx.db.audit(actor, 'project_delete', key);
  publish(ctx, key);
}

/** Archives (at = a time) or unarchives (at = null) packages, with one history event each. */
function setArchived(ctx: Ctx, ids: string[], at: number | null, actor: string, detail?: Record<string, unknown>) {
  for (const id of ids) {
    ctx.db.run('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?', at, Date.now(), id);
    taskEvent(ctx, id, actor, at === null ? 'unarchived' : 'archived', null, null, detail);
  }
}

export type ProjectActionResult = ProjectView | { sent: boolean; reason: string } | { archived: string[] };

/**
 * pause / resume / archive / unarchive / autopilot answer the project. Archiving archives its packages (with the
 * project's own timestamp); unarchiving brings back exactly those. archive-done archives its integrated packages now.
 * refresh will ask the runner for the line (§12.3); until the runner reports lines it sends nothing.
 */
export function projectAction(ctx: Ctx, key: string, action: ProjectAction, actor: string, body: { on?: boolean } = {}): ProjectActionResult {
  const p = requireProject(ctx, key);
  const now = Date.now();
  const ids = (sql: string, ...args: (string | number)[]) => ctx.db.all<{ id: string }>(sql, key, ...args).map((r) => r.id);
  let touched: string[] = [];
  const state = (s: ProjectState, archivedAt: number | null) => ctx.db.run('UPDATE factory_projects SET state = ?, archived_at = ?, updated_at = ? WHERE key = ?', s, archivedAt, now, key);
  switch (action) {
    case 'pause':
    case 'resume': {
      if (p.state === 'archived') throw new FactoryError(409, `project ${key} is archived: unarchive it first`);
      const to = action === 'pause' ? 'paused' : 'active';
      if (p.state === to) return projectView(ctx, key);
      state(to, null);
      break;
    }
    case 'archive':
      if (p.state === 'archived') return projectView(ctx, key);
      ctx.db.tx(() => {
        state('archived', now);
        touched = ids('SELECT id FROM tasks WHERE project = ? AND archived_at IS NULL ORDER BY id');
        setArchived(ctx, touched, now, actor, { project: key });
      });
      break;
    case 'unarchive':
      if (p.state !== 'archived') return projectView(ctx, key);
      ctx.db.tx(() => {
        state('active', null);
        touched = p.archived_at == null ? [] : ids('SELECT id FROM tasks WHERE project = ? AND archived_at = ? ORDER BY id', p.archived_at);
        setArchived(ctx, touched, null, actor, { project: key });
      });
      break;
    case 'autopilot': {
      if (typeof body.on !== 'boolean') throw new FactoryError(400, 'on: true or false');
      if (body.on && p.state === 'archived') throw new FactoryError(409, `project ${key} is archived: unarchive it first`);
      if (!!p.autopilot === body.on) return projectView(ctx, key);
      ctx.db.run('UPDATE factory_projects SET autopilot = ?, updated_at = ? WHERE key = ?', body.on ? 1 : 0, now, key);
      ctx.db.audit(actor, 'project_autopilot', key, { on: body.on });
      publish(ctx, key);
      return projectView(ctx, key);
    }
    case 'refresh':
      return { sent: false, reason: 'the runner does not report lines yet' };
    case 'archive-done':
      ctx.db.tx(() => {
        touched = ids("SELECT id FROM tasks WHERE project = ? AND status = 'integrata' AND archived_at IS NULL ORDER BY id");
        setArchived(ctx, touched, now, actor);
      });
      ctx.db.audit(actor, 'project_archive_done', key, { archived: touched });
      for (const id of touched) ctx.bus.publish('tasks', 'changed', { id });
      publish(ctx, key);
      return { archived: touched };
  }
  ctx.db.audit(actor, `project_${action}`, key, touched.length ? { packages: touched.length } : undefined);
  for (const id of touched) ctx.bus.publish('tasks', 'changed', { id });
  publish(ctx, key);
  return projectView(ctx, key);
}

/** Every few minutes: archives packages integrated more than archive_done_after_hours ago (0 turns it off). */
export function archiveSweep(ctx: Ctx, now = Date.now()): string[] {
  const hours = Number(ctx.db.getSetting<unknown>('archive_done_after_hours', DEFAULT_ARCHIVE_AFTER_HOURS));
  if (!Number.isFinite(hours) || hours <= 0) return [];
  const due = ctx.db
    .all<{ id: string }>("SELECT id FROM tasks WHERE status = 'integrata' AND archived_at IS NULL AND integrated_at IS NOT NULL AND integrated_at <= ? ORDER BY id", now - hours * 3600_000)
    .map((r) => r.id);
  if (!due.length) return [];
  ctx.db.tx(() => setArchived(ctx, due, now, 'factory:archive', { afterHours: hours }));
  for (const id of due) ctx.bus.publish('tasks', 'changed', { id });
  return due;
}
