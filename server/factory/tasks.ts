// The backlog (SPEC §11.2): packages with states, dependencies, acceptance criteria and a history of every change,
// plus their gate results and Narcis's control requests. Used by the web routes and the agent API alike.
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { governor } from './governor.ts';
import { listDecisions } from './decisions.ts';
import {
  GATES, SHOT_MAX_BYTES, TASK_STATUSES, type ControlRequest, type Gate, type GateResult, type GovernorVerdict, type TaskDetail, type TaskEvent,
  type TaskStatus, type TaskSummary, type ToolArgs, type Verdict,
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
      costUsd: r.cost_usd,
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
  const rows = ctx.db.all<TaskRow>(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER} LIMIT ?`, ...args, f.limit ?? 500);
  const out = summaries(ctx, rows);
  return f.ready ? out.filter((t) => t.ready) : out;
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
  return { ...s, body: row(ctx, id).body, events, gateResults: gateResults(ctx, id), controls: controls(ctx, { taskId: id, all: true }), decisions: listDecisions(ctx, { taskId: id }) };
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
  db.tx(() => {
    const now = Date.now();
    if (existing) {
      updateTask(ctx, { ...t, id }, actor, { title: t.title, body: t.body, repo: t.repo, priority: t.priority, sensitive: t.sensitive });
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
    event(ctx, id, actor, 'created', null, status, { title: t.title });
  });
  db.audit(actor, existing ? 'task_upsert' : 'task_create', id);
  publish(ctx, id);
  return taskSummary(ctx, id);
}

export type TaskPatch = ToolArgs<'tasks_update'>;
/** Fields only the web (and an upsert) may change, on top of what the agent tool allows. */
export interface TaskExtra { title?: string; body?: string; repo?: string; priority?: number; sensitive?: boolean; jobId?: string; claimedBy?: string | null }

export function updateTask(ctx: Ctx, p: TaskPatch, actor: string, extra: TaskExtra = {}): TaskSummary {
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
  const statusChange = p.status && p.status !== cur.status ? p.status : null;
  if (statusChange && !TASK_STATUSES.includes(statusChange)) throw new FactoryError(400, 'unknown status');
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
      event(ctx, p.id, actor, 'status', cur.status, statusChange, p.note ? { note: p.note } : undefined);
    }
    if (sets.length) db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, now, p.id);
    const { status: _s, note, ...rest } = changed as Record<string, unknown> & { status?: unknown; note?: unknown };
    if (Object.keys(rest).length) event(ctx, p.id, actor, 'update', null, null, rest);
    if (note !== undefined && !statusChange) event(ctx, p.id, actor, 'note', null, null, { note });
  });
  if (sets.length || changed.dependsOn) publish(ctx, p.id);
  return taskSummary(ctx, p.id);
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
    event(ctx, pick.id, actor, 'status', 'gata', 'in_lucru', { claimedBy: who });
    publish(ctx, pick.id);
    return { task: taskSummary(ctx, pick.id), governor: g };
  });
}

// ---------- gates ----------

const MIME = /^image\/(png|jpeg|webp|gif)$/;

export function recordGate(ctx: Ctx, a: ToolArgs<'gates_record'>, actor: string): GateResult {
  row(ctx, a.taskId);
  const shots = (a.screenshots ?? []).map((s) => {
    if (!s.base64) throw new FactoryError(400, `screenshot ${s.name}: no image data (bb mcp uploads a local path for you)`);
    const data = Buffer.from(s.base64, 'base64');
    if (!data.length || data.length > SHOT_MAX_BYTES) throw new FactoryError(400, `screenshot ${s.name}: empty or larger than ${SHOT_MAX_BYTES} bytes`);
    const mime = s.mime ?? sniff(data);
    if (!mime || !MIME.test(mime)) throw new FactoryError(400, `screenshot ${s.name}: only png, jpeg, webp or gif`);
    return { name: s.name, mime, data };
  });
  const id = ctx.db.tx(() => {
    const now = Date.now();
    const r = ctx.db.run(
      'INSERT INTO gate_results (task_id, gate, verdict, summary, details_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      a.taskId, a.gate, a.verdict, a.summary, a.details === undefined ? null : JSON.stringify(a.details), actor, now,
    );
    const gid = Number(r.lastInsertRowid);
    for (const s of shots) ctx.db.run('INSERT INTO gate_shots (gate_result_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?)', gid, s.name, s.mime, s.data, now);
    event(ctx, a.taskId, actor, 'gate', null, null, { gate: a.gate, verdict: a.verdict, shots: shots.length });
    ctx.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', now, a.taskId);
    return gid;
  });
  publish(ctx, a.taskId);
  return gateResults(ctx, a.taskId).find((g) => g.id === id)!;
}

function sniff(b: Buffer): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

export function gateResults(ctx: Ctx, taskId: string): GateResult[] {
  const rows = ctx.db.all<{ id: number; gate: Gate; verdict: Verdict; summary: string; details_json: string | null; actor: string; created_at: number }>(
    'SELECT id, gate, verdict, summary, details_json, actor, created_at FROM gate_results WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', taskId,
  );
  const shots = rows.length
    ? ctx.db.all<{ id: number; gate_result_id: number; name: string; mime: string }>(
        `SELECT id, gate_result_id, name, mime FROM gate_shots WHERE gate_result_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`, ...rows.map((r) => r.id),
      )
    : [];
  return rows
    .map((r) => ({
      id: r.id, gate: r.gate, verdict: r.verdict, summary: r.summary, details: json(r.details_json, null), actor: r.actor, createdAt: r.created_at,
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
