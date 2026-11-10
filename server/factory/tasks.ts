// The backlog (SPEC §11.2): packages with states, dependencies, acceptance criteria and a history of every change,
// plus their gate results and Narcis's control requests. Used by the web routes and the agent API alike.
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { governor } from './governor.ts';
import { askDecision, listDecisions } from './decisions.ts';
import { factoryConfig, fill, repoConfig } from './config.ts';
import { syncTaskSessions, taskCosts } from './cost.ts';
import { applyGateFindings, findingsBrief, listFindings, openFindingCounts, updateFindings } from './findings.ts';
import { listGateRuns } from './gateruns.ts';
import {
  GATES, SHOT_MAX_BYTES, TASK_STATUSES, type ControlRequest, type Gate, type GateResult, type GovernorVerdict, type RepoFactoryConfig, type TaskDetail,
  type TaskEvent, type TaskResources, type TaskStatus, type TaskSummary, type ToolArgs, type Verdict,
} from '../../shared/factory.ts';

export class FactoryError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

interface TaskRow {
  id: string; title: string; body: string; acceptance_json: string; status: TaskStatus; repo: string | null; branch: string | null; priority: number;
  cost_usd: number | null; prompt_id: number | null; prompt_version: number | null; sensitive: number; note: string | null; claimed_by: string | null;
  claimed_at: number | null; job_id: string | null; terminal: string | null; session_id: string | null; source: string; ext_ref: string | null;
  created_at: number; updated_at: number; integrated_at: number | null;
  round: number; extra_rounds: number; res_port: number | null; res_db: string | null; res_mig_from: number | null; res_mig_to: number | null;
  migrations_used_json: string | null;
}

const resourcesOf = (r: TaskRow): TaskResources | null =>
  r.res_port == null && r.res_db == null && r.res_mig_from == null
    ? null
    : { port: r.res_port, db: r.res_db, migrations: r.res_mig_from != null && r.res_mig_to != null ? { from: r.res_mig_from, to: r.res_mig_to } : null };
const migrationsOf = (r: TaskRow): number[] => json<number[]>(r.migrations_used_json, []) ?? [];
const maxRoundsOf = (ctx: Ctx, r: TaskRow) => factoryConfig(ctx).maxRounds + r.extra_rounds;

/** The placeholders of the repo config's templates (worktree, cleanup) and of the gate recipe. */
export function taskVars(r: TaskRow, cfg: RepoFactoryConfig | null): Record<'id' | 'idLower' | 'worktree' | 'round' | 'port' | 'db', string> {
  const base = { id: r.id, idLower: r.id.toLowerCase(), round: String(Math.max(1, r.round)), port: r.res_port != null ? String(r.res_port) : '', db: r.res_db ?? '' };
  return { ...base, worktree: cfg?.worktree ? fill(cfg.worktree, base) : '' };
}

const publish = (ctx: Ctx, id: string) => ctx.bus.publish('tasks', 'changed', { id });

function event(ctx: Ctx, taskId: string, actor: string, kind: string, from: string | null, to: string | null, detail?: unknown) {
  ctx.db.run(
    'INSERT INTO task_events (task_id, ts, actor, kind, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    taskId, Date.now(), actor, kind, from, to, detail === undefined ? null : JSON.stringify(detail),
  );
}

function summaries(ctx: Ctx, rows: TaskRow[]): TaskSummary[] {
  if (!rows.length) return [];
  const { db } = ctx;
  const ids = rows.map((r) => r.id);
  syncTaskSessions(ctx);
  const costs = taskCosts(ctx, ids);
  const findings = openFindingCounts(ctx, ids);
  const maxRounds = factoryConfig(ctx).maxRounds;
  const marks = ids.map(() => '?').join(',');
  const deps = db.all<{ task_id: string; depends_on: string; status: string }>(
    `SELECT d.task_id, d.depends_on, t.status FROM task_deps d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id IN (${marks}) ORDER BY d.depends_on`, ...ids,
  );
  const gates = db.all<{ task_id: string; gate: Gate; verdict: Verdict }>(
    `SELECT g.task_id, g.gate, g.verdict FROM gate_results g WHERE g.task_id IN (${marks})
     AND g.id = (SELECT MAX(id) FROM gate_results x WHERE x.task_id = g.task_id AND x.gate = g.gate)`, ...ids,
  );
  const controls = db.all<{ task_id: string; n: number }>(`SELECT task_id, COUNT(*) n FROM control_requests WHERE status = 'open' AND task_id IN (${marks}) GROUP BY task_id`, ...ids);
  return rows.map((r) => {
    const mine = deps.filter((d) => d.task_id === r.id);
    const waitingOn = mine.filter((d) => d.status !== 'integrata').map((d) => d.depends_on);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      ready: r.status === 'gata' && waitingOn.length === 0,
      dependsOn: mine.map((d) => d.depends_on),
      waitingOn,
      repo: r.repo,
      branch: r.branch,
      priority: r.priority,
      costUsd: costs.get(r.id)?.total ?? r.cost_usd,
      costManualUsd: r.cost_usd,
      costByRole: costs.get(r.id)?.byRole ?? null,
      linkedSessions: costs.get(r.id)?.sessions ?? 0,
      round: r.round,
      maxRounds: maxRounds + r.extra_rounds,
      resources: resourcesOf(r),
      migrationsUsed: migrationsOf(r),
      openFindings: findings.get(r.id)!,
      promptId: r.prompt_id,
      promptVersion: r.prompt_version,
      sensitive: !!r.sensitive,
      note: r.note,
      claimedBy: r.claimed_by,
      terminal: r.terminal,
      sessionId: r.session_id,
      jobId: r.job_id,
      source: r.source,
      extRef: r.ext_ref,
      acceptance: json<string[]>(r.acceptance_json, []) ?? [],
      gates: Object.fromEntries(gates.filter((g) => g.task_id === r.id).map((g) => [g.gate, g.verdict])),
      openControls: controls.find((c) => c.task_id === r.id)?.n ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      integratedAt: r.integrated_at,
    };
  });
}

const ORDER = 'ORDER BY priority DESC, created_at ASC, id ASC';

export function listTasks(ctx: Ctx, f: { status?: TaskStatus[]; ready?: boolean; q?: string; limit?: number } = {}): TaskSummary[] {
  const where: string[] = [];
  const args: string[] = [];
  if (f.status?.length) {
    where.push(`status IN (${f.status.map(() => '?').join(',')})`);
    args.push(...f.status);
  }
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (f.ready) where.push("status = 'gata'");
  // readiness depends on other rows, so the limit applies after that filter
  const rows = ctx.db.all<TaskRow>(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER} LIMIT ?`, ...args, f.ready ? 5000 : (f.limit ?? 500));
  const out = summaries(ctx, rows);
  return f.ready ? out.filter((t) => t.ready).slice(0, f.limit ?? 500) : out;
}

function row(ctx: Ctx, id: string): TaskRow {
  const r = ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  if (!r) throw new FactoryError(404, `unknown task ${id}`);
  return r;
}

export function taskSummary(ctx: Ctx, id: string): TaskSummary {
  return summaries(ctx, [row(ctx, id)])[0];
}

export function getTask(ctx: Ctx, id: string): TaskDetail {
  const s = taskSummary(ctx, id);
  const { db } = ctx;
  const events = db
    .all<{ ts: number; actor: string; kind: string; from_status: string | null; to_status: string | null; detail_json: string | null }>(
      'SELECT ts, actor, kind, from_status, to_status, detail_json FROM task_events WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT 300', id,
    )
    .map((e): TaskEvent => ({ ts: e.ts, actor: e.actor, kind: e.kind, from: e.from_status, to: e.to_status, detail: json(e.detail_json, null) }));
  return {
    ...s, body: row(ctx, id).body, events, gateResults: gateResults(ctx, id), controls: controls(ctx, { taskId: id, all: true }), decisions: listDecisions(ctx, { taskId: id }),
    findings: listFindings(ctx, { taskId: id }), gateRuns: listGateRuns(ctx, id),
  };
}

/** Rejects unknown ids and dependency cycles. */
function setDeps(ctx: Ctx, id: string, deps: string[]) {
  const { db } = ctx;
  const list = [...new Set(deps)];
  for (const d of list) {
    if (d === id) throw new FactoryError(400, `${id} cannot depend on itself`);
    if (!db.get('SELECT 1 FROM tasks WHERE id = ?', d)) throw new FactoryError(400, `unknown dependency ${d}`);
  }
  // cycle check: walking up from each new dependency must never reach `id`
  const seen = new Set<string>();
  const stack = [...list];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === id) throw new FactoryError(400, `dependency cycle through ${id}`);
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of db.all<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ?', cur)) stack.push(r.depends_on);
  }
  db.run('DELETE FROM task_deps WHERE task_id = ?', id);
  for (const d of list) db.run('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)', id, d);
}

function nextId(ctx: Ctx): string {
  const n = ctx.db.get<{ n: number }>("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) n FROM tasks WHERE id GLOB 'T[0-9]*'")!.n;
  return `T${n + 1}`;
}

export type NewTask = ToolArgs<'tasks_create'> & { source?: string };

export function createTask(ctx: Ctx, t: NewTask, actor: string): TaskSummary {
  const { db } = ctx;
  const id = t.id?.trim() || (t.extRef && db.get<{ id: string }>('SELECT id FROM tasks WHERE ext_ref = ?', t.extRef)?.id) || nextId(ctx);
  if (!/^[\w.-]{1,64}$/.test(id)) throw new FactoryError(400, 'task ids use letters, digits, ".", "_" and "-"');
  const existing = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  if (existing && !t.upsert) throw new FactoryError(409, `task ${id} already exists`);
  if (t.extRef && db.get('SELECT 1 FROM tasks WHERE ext_ref = ? AND id != ?', t.extRef, id)) throw new FactoryError(409, `${t.extRef} already belongs to another task`);
  if (t.fromFindings?.length) {
    // the chosen findings make the package: its body section and one acceptance criterion each
    const brief = findingsBrief(ctx, t.fromFindings);
    t = { ...t, body: [t.body?.trim(), brief.body].filter(Boolean).join('\n\n'), acceptance: [...(t.acceptance ?? []), ...brief.acceptance] };
    if (t.acceptance!.length > 100) throw new FactoryError(400, `${t.acceptance!.length} acceptance criteria with these findings (limit 100): pick fewer findings`);
    if (t.body!.length > 100_000) throw new FactoryError(400, 'the findings make the body longer than 100 000 characters: pick fewer findings');
  }
  db.tx(() => {
    const now = Date.now();
    if (t.fromFindings?.length) updateFindings(ctx, t.fromFindings, 'deferred', `deferred to ${id}`, actor, id);
    if (existing) {
      // an upsert (re-import) never moves a package that work has started on
      const status = existing.status === 'backlog' || existing.status === 'gata' ? t.status : undefined;
      updateTask(ctx, { ...t, id, status }, actor, { title: t.title, body: t.body, repo: t.repo, priority: t.priority, sensitive: t.sensitive });
      return;
    }
    const status = t.status ?? 'backlog';
    db.run(
      `INSERT INTO tasks (id, title, body, acceptance_json, status, repo, branch, priority, sensitive, source, ext_ref, created_at, updated_at, integrated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, t.title, t.body ?? '', JSON.stringify(t.acceptance ?? []), status, t.repo ?? null, t.branch ?? null, t.priority ?? 0, t.sensitive ? 1 : 0,
      t.source ?? actor.split(':')[0], t.extRef ?? null, now, now, status === 'integrata' ? now : null,
    );
    if (t.dependsOn?.length) setDeps(ctx, id, t.dependsOn);
    event(ctx, id, actor, 'created', null, status, { title: t.title, ...(t.fromFindings?.length ? { fromFindings: t.fromFindings } : {}) });
  });
  db.audit(actor, existing ? 'task_upsert' : 'task_create', id);
  publish(ctx, id);
  return taskSummary(ctx, id);
}

export type TaskPatch = ToolArgs<'tasks_update'>;
/** Fields only the web (and an upsert) may change, on top of what the agent tool allows. */
export interface TaskExtra { title?: string; body?: string; repo?: string; priority?: number; sensitive?: boolean; jobId?: string; claimedBy?: string | null }

export function updateTask(ctx: Ctx, p: TaskPatch, actor: string, extra: TaskExtra = {}): TaskSummary & { cleanup?: string[]; warnings?: string[] } {
  const { db } = ctx;
  const cur = row(ctx, p.id);
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const changed: Record<string, unknown> = {};
  const set = (col: string, key: string, v: string | number | null | undefined) => {
    if (v === undefined) return;
    if ((cur as unknown as Record<string, unknown>)[col] === v) return;
    sets.push(`${col} = ?`);
    args.push(v);
    changed[key] = v;
  };
  set('title', 'title', extra.title);
  set('body', 'body', extra.body);
  set('repo', 'repo', extra.repo);
  set('priority', 'priority', extra.priority);
  set('sensitive', 'sensitive', extra.sensitive === undefined ? undefined : extra.sensitive ? 1 : 0);
  set('job_id', 'jobId', extra.jobId);
  set('claimed_by', 'claimedBy', extra.claimedBy);
  set('branch', 'branch', p.branch);
  set('cost_usd', 'costUsd', p.costUsd);
  set('prompt_id', 'promptId', p.promptId);
  set('prompt_version', 'promptVersion', p.promptVersion);
  set('terminal', 'terminal', p.terminal);
  set('session_id', 'sessionId', p.sessionId);
  set('note', 'note', p.note);
  if (p.acceptance) set('acceptance_json', 'acceptance', JSON.stringify(p.acceptance));
  if (p.migrationsUsed) set('migrations_used_json', 'migrationsUsed', JSON.stringify([...new Set(p.migrationsUsed)].sort((a, b) => a - b)));
  const statusChange = p.status && p.status !== cur.status ? p.status : null;
  if (statusChange && !TASK_STATUSES.includes(statusChange)) throw new FactoryError(400, 'unknown status');
  const max = maxRoundsOf(ctx, cur);
  // rounds: each move into la_porti starts one; past the limit only an approved extra round (blocata → in_lucru with a note)
  if (statusChange === 'la_porti') {
    if (cur.round >= max) throw new FactoryError(409, `${cur.id} has used its ${max} gate round${max > 1 ? 's' : ''}; move it from blocata back to in_lucru with a note to allow one more`);
    sets.push('round = ?');
    args.push(cur.round + 1);
  }
  const extraRound = statusChange === 'in_lucru' && cur.status === 'blocata' && (!!p.note?.trim() || actor === 'web');
  if (extraRound) sets.push('extra_rounds = extra_rounds + 1');
  let after: { cleanup?: string[]; warnings?: string[] } = {};
  db.tx(() => {
    if (p.dependsOn) {
      const before = db.all<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on', p.id).map((r) => r.depends_on);
      const after = [...new Set(p.dependsOn)].sort();
      if (before.join() !== after.join()) {
        setDeps(ctx, p.id, after);
        changed.dependsOn = after;
      }
    }
    const now = Date.now();
    if (statusChange) {
      sets.push('status = ?');
      args.push(statusChange);
      if (statusChange === 'integrata') {
        sets.push('integrated_at = ?');
        args.push(now);
      }
      const detail = { ...(p.note ? { note: p.note } : {}), ...(statusChange === 'la_porti' ? { round: cur.round + 1 } : {}), ...(extraRound ? { maxRounds: max + 1 } : {}) };
      event(ctx, p.id, actor, 'status', cur.status, statusChange, Object.keys(detail).length ? detail : undefined);
    }
    if (sets.length) db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, now, p.id);
    const { status: _s, note, ...rest } = changed as Record<string, unknown> & { status?: unknown; note?: unknown };
    if (Object.keys(rest).length) event(ctx, p.id, actor, 'update', null, null, rest);
    if (note !== undefined && !statusChange) event(ctx, p.id, actor, 'note', null, null, { note });
    if (extraRound) {
      // the extra round settles the round-limit question, if Narcis has not answered it yet
      for (const d of listDecisions(ctx, { taskId: p.id, status: 'pending' }).filter((x) => x.askedBy === ROUNDS_ACTOR)) {
        db.run("UPDATE decisions SET status = 'cancelled', answered_at = ? WHERE id = ? AND status = 'pending'", now, d.id);
        ctx.bus.publish('inbox', 'decision', { id: d.id });
      }
    }
    if (statusChange === 'integrata') after = onIntegrated(ctx, row(ctx, p.id), actor);
  });
  if (sets.length || changed.dependsOn) publish(ctx, p.id);
  return { ...taskSummary(ctx, p.id), ...after };
}

const ROUNDS_ACTOR = 'factory:rounds';

/**
 * Integration: the cleanup list from the repo config, and a warning for every other active package whose migration
 * range holds numbers this one used (it has to renumber). The warnings go to those packages' history and the digest.
 */
function onIntegrated(ctx: Ctx, t: TaskRow, actor: string): { cleanup?: string[]; warnings?: string[] } {
  const cfg = repoConfig(ctx, t.repo);
  const out: { cleanup?: string[]; warnings?: string[] } = {};
  if (cfg?.cleanup.length) out.cleanup = cfg.cleanup.map((c) => fill(c, taskVars(t, cfg)));
  const used = migrationsOf(t);
  if (!used.length || !t.repo) return out;
  const others = ctx.db.all<TaskRow>(
    "SELECT * FROM tasks WHERE id != ? AND lower(repo) = lower(?) AND status != 'integrata' AND res_mig_from IS NOT NULL AND res_mig_to IS NOT NULL ORDER BY id", t.id, t.repo,
  );
  const warnings: string[] = [];
  for (const o of others) {
    const hit = used.filter((n) => n >= o.res_mig_from! && n <= o.res_mig_to!);
    if (!hit.length) continue;
    const message = `${t.id} was integrated with migration${hit.length > 1 ? 's' : ''} ${hit.join(', ')}, inside ${o.id}'s range ${o.res_mig_from}–${o.res_mig_to}: renumber ${o.id}'s migrations`;
    event(ctx, o.id, actor, 'warning', null, null, { message, from: t.id, migrations: hit });
    publish(ctx, o.id);
    warnings.push(message);
  }
  if (warnings.length) out.warnings = warnings;
  return out;
}

export function deleteTask(ctx: Ctx, id: string, actor: string) {
  row(ctx, id);
  ctx.db.run('DELETE FROM tasks WHERE id = ?', id);
  ctx.db.audit(actor, 'task_delete', id);
  publish(ctx, id);
}

export interface ClaimResult {
  task: TaskSummary | null;
  governor: GovernorVerdict;
  reason?: string;
  /** the package's port, database and migration range (null when its repo has no factory config) */
  resources?: TaskResources | null;
}

/**
 * Port, database and migration range for a package, from its repo's config. Ports are the lowest free in the range among
 * the repo's packages that are not integrated; migration ranges never go back: the next block starts after every range
 * and every used number recorded for the repo. A package keeps what it already has.
 */
function allocateResources(ctx: Ctx, t: TaskRow): TaskResources | null {
  const cfg = repoConfig(ctx, t.repo);
  if (!cfg || !t.repo) return resourcesOf(t);
  const repoRows = ctx.db.all<TaskRow>('SELECT * FROM tasks WHERE lower(repo) = lower(?) AND id != ?', t.repo, t.id);
  let port = t.res_port;
  if (port == null && cfg.portFrom != null) {
    const taken = new Set(repoRows.filter((r) => r.status !== 'integrata' && r.res_port != null).map((r) => r.res_port));
    for (let p = cfg.portFrom; p <= (cfg.portTo ?? cfg.portFrom); p++) {
      if (!taken.has(p)) {
        port = p;
        break;
      }
    }
  }
  const db = t.res_db ?? (cfg.dbPrefix ? `${cfg.dbPrefix}${t.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` : null);
  let from = t.res_mig_from;
  let to = t.res_mig_to;
  if (from == null && cfg.migrationFrom != null) {
    const high = Math.max(cfg.migrationFrom - 1, ...repoRows.map((r) => r.res_mig_to ?? -1), ...repoRows.flatMap(migrationsOf));
    from = high + 1;
    to = from + cfg.migrationBlock - 1;
  }
  ctx.db.run('UPDATE tasks SET res_port = ?, res_db = ?, res_mig_from = ?, res_mig_to = ? WHERE id = ?', port, db, from, to, t.id);
  return resourcesOf(row(ctx, t.id));
}

/** Claims a ready task (the given one, or the best by priority) atomically, unless the governor objects. */
export function claimTask(ctx: Ctx, a: ToolArgs<'tasks_claim'>, actor: string): ClaimResult {
  const g = governor(ctx);
  if (!g.canStart && !a.force) return { task: null, governor: g, reason: `governor: ${g.reason}` };
  return ctx.db.tx(() => {
    const ready = listTasks(ctx, { status: ['gata'], ready: true });
    const pick = a.id ? ready.find((t) => t.id === a.id) : ready[0];
    if (!pick) {
      if (a.id) {
        const t = taskSummary(ctx, a.id);
        return { task: null, governor: g, reason: t.status !== 'gata' ? `task ${a.id} is ${t.status}, not gata` : `task ${a.id} waits on ${t.waitingOn.join(', ')}` };
      }
      return { task: null, governor: g, reason: 'no task is ready to start' };
    }
    const who = a.agent?.trim() || actor;
    ctx.db.run("UPDATE tasks SET status = 'in_lucru', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?", who, Date.now(), Date.now(), pick.id);
    const resources = allocateResources(ctx, row(ctx, pick.id));
    event(ctx, pick.id, actor, 'status', 'gata', 'in_lucru', { claimedBy: who, ...(resources ? { resources } : {}) });
    publish(ctx, pick.id);
    return { task: taskSummary(ctx, pick.id), governor: g, resources };
  });
}

// ---------- gates ----------

const MIME = /^image\/(png|jpeg|webp|gif)$/;

export function recordGate(ctx: Ctx, a: ToolArgs<'gates_record'>, actor: string, opts: { round?: number } = {}): GateResult {
  const cur = row(ctx, a.taskId);
  const shots = (a.screenshots ?? []).map((s) => {
    if (!s.base64) throw new FactoryError(400, `screenshot ${s.name}: no image data (bb mcp uploads a local path for you)`);
    const data = Buffer.from(s.base64, 'base64');
    if (!data.length || data.length > SHOT_MAX_BYTES) throw new FactoryError(400, `screenshot ${s.name}: empty or larger than ${SHOT_MAX_BYTES} bytes`);
    const mime = s.mime ?? sniff(data);
    if (!mime || !MIME.test(mime)) throw new FactoryError(400, `screenshot ${s.name}: only png, jpeg, webp or gif`);
    return { name: s.name, mime, data };
  });
  // the first gate result without a move into la_porti counts as round 1
  const current = Math.max(1, cur.round);
  const round = opts.round != null ? Math.min(opts.round, current) : current;
  const id = ctx.db.tx(() => {
    const now = Date.now();
    const r = ctx.db.run(
      'INSERT INTO gate_results (task_id, gate, round, verdict, summary, details_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      a.taskId, a.gate, round, a.verdict, a.summary, a.details === undefined ? null : JSON.stringify(a.details), actor, now,
    );
    const gid = Number(r.lastInsertRowid);
    for (const s of shots) ctx.db.run('INSERT INTO gate_shots (gate_result_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?)', gid, s.name, s.mime, s.data, now);
    const f = applyGateFindings(ctx, a.taskId, a.gate, round, gid, a.verdict, a.findings ?? []);
    event(ctx, a.taskId, actor, 'gate', null, null, {
      gate: a.gate, verdict: a.verdict, round, shots: shots.length, ...(f.added ? { findings: f.added } : {}), ...(f.fixed ? { fixed: f.fixed } : {}),
    });
    ctx.db.run('UPDATE tasks SET round = MAX(round, ?), updated_at = ? WHERE id = ?', round, now, a.taskId);
    if (a.verdict === 'fail' && round === current) blockAtRoundLimit(ctx, row(ctx, a.taskId), round);
    return gid;
  });
  publish(ctx, a.taskId);
  return gateResults(ctx, a.taskId).find((g) => g.id === id)!;
}

/**
 * A failing gate ends its round (the factory stops at the first failure). In the last allowed round that blocks the
 * package and opens one decision tied to it: one more round, one more only for a failed gate, or stop the package.
 */
function blockAtRoundLimit(ctx: Ctx, t: TaskRow, round: number) {
  const max = maxRoundsOf(ctx, t);
  if (round < max || t.status === 'blocata' || t.status === 'integrata') return;
  if (listDecisions(ctx, { taskId: t.id, status: 'pending' }).some((d) => d.askedBy === ROUNDS_ACTOR)) return;
  const latest = ctx.db.all<{ gate: Gate; verdict: Verdict; summary: string }>(
    `SELECT g.gate, g.verdict, g.summary FROM gate_results g WHERE g.task_id = ? AND g.round = ?
     AND g.id = (SELECT MAX(id) FROM gate_results x WHERE x.task_id = g.task_id AND x.gate = g.gate AND x.round = g.round) ORDER BY g.gate`, t.id, round,
  );
  const failed = latest.filter((g) => g.verdict === 'fail');
  ctx.db.run("UPDATE tasks SET status = 'blocata', updated_at = ? WHERE id = ?", Date.now(), t.id);
  event(ctx, t.id, ROUNDS_ACTOR, 'status', t.status, 'blocata', { round, maxRounds: max, failed: failed.map((g) => g.gate) });
  askDecision(ctx, {
    taskId: t.id,
    question: `${t.id} failed ${failed.map((g) => g.gate).join(', ')} in round ${round} of ${max}. Another round?`,
    context: failed.map((g) => `${g.gate}: ${g.summary.slice(0, 1500)}`).join('\n\n'),
    options: ['Încă o rundă', ...failed.slice(0, 5).map((g) => `Încă o rundă, doar pentru ${g.gate}`), 'Oprește pachetul'],
  }, ROUNDS_ACTOR);
}

function sniff(b: Buffer): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

export function gateResults(ctx: Ctx, taskId: string): GateResult[] {
  const rows = ctx.db.all<{ id: number; gate: Gate; round: number; verdict: Verdict; summary: string; details_json: string | null; actor: string; created_at: number }>(
    'SELECT id, gate, round, verdict, summary, details_json, actor, created_at FROM gate_results WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', taskId,
  );
  const shots = rows.length
    ? ctx.db.all<{ id: number; gate_result_id: number; name: string; mime: string }>(
        `SELECT id, gate_result_id, name, mime FROM gate_shots WHERE gate_result_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`, ...rows.map((r) => r.id),
      )
    : [];
  return rows
    .map((r) => ({
      id: r.id, gate: r.gate, round: r.round, verdict: r.verdict, summary: r.summary, details: json(r.details_json, null), actor: r.actor, createdAt: r.created_at,
      shots: shots.filter((s) => s.gate_result_id === r.id).map((s) => ({ id: s.id, name: s.name, mime: s.mime, url: `/api/gate-shots/${s.id}` })),
    }))
    .sort((a, b) => GATES.indexOf(a.gate) - GATES.indexOf(b.gate) || b.createdAt - a.createdAt);
}

export function gateShot(ctx: Ctx, id: number): { mime: string; data: Uint8Array } | null {
  return ctx.db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM gate_shots WHERE id = ?', id) ?? null;
}

// ---------- control requests (Narcis → coordinator) ----------

type ControlRow = { id: number; task_id: string; kind: 'stop' | 'revert'; note: string | null; status: 'open' | 'acked'; created_at: number; acked_at: number | null };
const controlView = (r: ControlRow): ControlRequest => ({ id: r.id, taskId: r.task_id, kind: r.kind, note: r.note, status: r.status, createdAt: r.created_at, ackedAt: r.acked_at });

/** Records the request only: the coordinator reads it with control_get and acts (Buildyboy never runs git on other repos). */
export function requestControl(ctx: Ctx, taskId: string, kind: 'stop' | 'revert', note: string | null, actor: string): ControlRequest {
  row(ctx, taskId);
  const r = ctx.db.run("INSERT INTO control_requests (task_id, kind, note, status, created_at) VALUES (?, ?, ?, 'open', ?)", taskId, kind, note, Date.now());
  event(ctx, taskId, actor, 'control', null, null, { kind, note });
  ctx.db.audit(actor, `task_${kind}_request`, taskId, { note });
  publish(ctx, taskId);
  return controlView(ctx.db.get<ControlRow>('SELECT * FROM control_requests WHERE id = ?', Number(r.lastInsertRowid))!);
}

export function controls(ctx: Ctx, f: { taskId?: string; all?: boolean } = {}): ControlRequest[] {
  const where = [f.all ? '1 = 1' : "status = 'open'"];
  const args: string[] = [];
  if (f.taskId) {
    where.push('task_id = ?');
    args.push(f.taskId);
  }
  return ctx.db.all<ControlRow>(`SELECT * FROM control_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 200`, ...args).map(controlView);
}

export function ackControls(ctx: Ctx, ids: number[], actor: string) {
  const now = Date.now();
  for (const id of ids) {
    const r = ctx.db.get<ControlRow>("SELECT * FROM control_requests WHERE id = ? AND status = 'open'", id);
    if (!r) continue;
    ctx.db.run("UPDATE control_requests SET status = 'acked', acked_at = ? WHERE id = ?", now, id);
    event(ctx, r.task_id, actor, 'control_ack', null, null, { kind: r.kind, id });
    publish(ctx, r.task_id);
  }
}
