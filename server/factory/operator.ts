// Operators (SPEC §12.7): an agent token the owner made an operator acts for the owner over MCP and HTTP: it answers
// and cancels decisions, asks for stop or revert, creates and changes projects; an inbox token answers the Inbox's
// pending actions. Reads are open to every token; each write needs its scope (403 naming the switch). A token never
// answers a decision it asked itself, and no agent answers a launch approval (§11.1: recognised through
// launch_requests.decision_id). Everything is audited as `agent:<name>`, and decisions keep who answered them.
// factory_status is the operator's whole picture in one small answer.
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import type { ActionAnswer, PendingActionView } from '../../shared/types.ts';
import {
  formatStartTime, projectConfigSchema, type DecisionKind, type DecisionView, type FactoryStatus, type InboxAnswerType, type InboxItem, type OperatorDecision, type ProjectView,
  type TaskStatus, type ToolArgs,
} from '../../shared/factory.ts';
import type { Caller } from './agent.ts';
import { answerPending, getPending, listPending } from '../control/pending.ts';
import { maxRounds } from './config.ts';
import { answerDecision, decisionView, type DecisionRow } from './decisions.ts';
import { governor } from './governor.ts';
import { autopilotHold, createProject, listProjectRows, projectAction, projectRow, projectView, requireProject, updateProject, type ProjectRow } from './projects.ts';
import { FactoryError, requestControl } from './tasks.ts';
import { listScheduled, missedSince } from './schedule.ts';

// ---------- scopes ----------

export type Scope = 'operator' | 'inbox';
const SWITCH: Record<Scope, string> = { operator: 'Operator', inbox: 'Inbox' };

/** Does the caller hold this scope? A caller built without its scopes has them read from its token. */
export function hasScope(ctx: Ctx, caller: Caller, scope: Scope): boolean {
  if (!caller.tokenId) return false;
  if (caller[scope] !== undefined) return !!caller[scope];
  return !!ctx.db.get(`SELECT 1 FROM agent_tokens WHERE id = ? AND ${scope} = 1 AND revoked_at IS NULL`, caller.tokenId);
}

/** 403 naming the switch the owner turns on in Settings → Factory → Agent tokens. */
export function requireScope(ctx: Ctx, caller: Caller, scope: Scope, what: string): void {
  if (!hasScope(ctx, caller, scope)) {
    throw new FactoryError(403, `this agent token may not ${what}: the owner turns on “${SWITCH[scope]}” for it in Settings → Factory → Agent tokens`);
  }
}

// ---------- decisions ----------

type Decision = DecisionRow & { project: string | null; launch: number };
// a decision's project: its package's, or its plan's (§12.6: the plan's approval is tied to no package)
const PROJECT_OF = 'COALESCE(t.project, (SELECT pl.project FROM plans pl WHERE pl.decision_id = d.id))';
const DECISION_SQL = `SELECT d.*, ${PROJECT_OF} AS project, EXISTS (SELECT 1 FROM launch_requests l WHERE l.decision_id = d.id) AS launch
  FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id`;

function kindOf(d: Decision): DecisionKind {
  if (d.launch) return 'launch_approval';
  if (d.asked_by === 'factory:rounds') return 'round_limit';
  if (d.asked_by === 'factory:plan') return 'plan';
  if (d.asked_by.startsWith('factory:')) return 'line';
  return 'question';
}

/** Asked by this token: by its id when the decision recorded one, else (older rows) by its actor name. */
const ownBy = (d: DecisionRow, caller: Caller, actor: string) => (d.asked_token ? d.asked_token === caller.tokenId : d.asked_by === actor);

/** Why this caller may not answer or cancel the decision, or null. */
function refusal(ctx: Ctx, d: Decision, actor: string, caller: Caller, operator = hasScope(ctx, caller, 'operator')): { status: number; why: string } | null {
  if (d.status !== 'pending') return { status: 409, why: `decision ${d.id} is already ${d.status}` };
  if (d.launch) {
    return { status: 403, why: `decision ${d.id} is a launch approval: only the owner answers those (they can turn off “Ask me before each launch” for the launching token instead)` };
  }
  if (ownBy(d, caller, actor)) return { status: 403, why: `decision ${d.id} was asked by this token: an agent never answers its own question` };
  if (!operator) return { status: 403, why: 'this agent token may not answer decisions: the owner turns on “Operator” for it in Settings → Factory → Agent tokens' };
  return null;
}

function decisionRow(ctx: Ctx, id: string): Decision {
  const d = ctx.db.get<Decision>(`${DECISION_SQL} WHERE d.id = ?`, id);
  if (!d) throw new FactoryError(404, `unknown decision ${id}`);
  return d;
}

/** decisions_list: pending first, then newest; 20 by default. */
export function listOperatorDecisions(ctx: Ctx, a: ToolArgs<'decisions_list'>, actor: string, caller: Caller): OperatorDecision[] {
  if (a.project) requireProject(ctx, a.project);
  const where = ['1 = 1'];
  const args: (string | number)[] = [];
  if (a.status) {
    where.push('d.status = ?');
    args.push(a.status);
  }
  if (a.project) {
    where.push(`${PROJECT_OF} = ?`);
    args.push(a.project);
  }
  const operator = hasScope(ctx, caller, 'operator');
  return ctx.db
    .all<Decision>(`${DECISION_SQL} WHERE ${where.join(' AND ')} ORDER BY d.status = 'pending' DESC, d.created_at DESC LIMIT ?`, ...args, a.limit ?? 20)
    .map((d) => {
      const no = refusal(ctx, d, actor, caller, operator);
      return { ...decisionView(d), kind: kindOf(d), project: d.project, mayAnswer: !no, ...(no && d.status === 'pending' ? { why: no.why } : {}) };
    });
}

/**
 * decision_answer / decision_cancel (answer null). With options, the answer must be one of them (matched ignoring case
 * and surrounding spaces, stored as written in the options); without, any text.
 */
export function operatorAnswer(ctx: Ctx, id: string, answer: string | null, actor: string, caller: Caller): DecisionView {
  requireScope(ctx, caller, 'operator', answer === null ? 'cancel decisions' : 'answer decisions');
  const d = decisionRow(ctx, id);
  const no = refusal(ctx, d, actor, caller, true);
  if (no) throw new FactoryError(no.status, no.why);
  let value = answer;
  const options = json<string[]>(d.options_json, []) ?? [];
  if (value !== null && options.length) {
    const want = value.trim().toLowerCase();
    const match = options.find((o) => o.trim().toLowerCase() === want);
    if (match === undefined) throw new FactoryError(400, `the answer must be one of its options: ${options.map((o) => `"${o}"`).join(', ')}`);
    value = match;
  }
  const out = answerDecision(ctx, id, value, actor);
  if (!out) throw new FactoryError(409, `decision ${id} is already answered`);
  return out;
}

// ---------- controls and projects ----------

export function operatorControl(ctx: Ctx, a: ToolArgs<'control_request'>, actor: string, caller: Caller) {
  requireScope(ctx, caller, 'operator', `ask for a ${a.kind}`);
  return requestControl(ctx, a.taskId, a.kind, a.note?.trim() || null, actor);
}

/** projects_save: creates the project when the key is new, else changes only the fields given. */
export function operatorSaveProject(ctx: Ctx, a: ToolArgs<'projects_save'>, actor: string, caller: Caller): { created: boolean; project: ProjectView } {
  requireScope(ctx, caller, 'operator', 'create or change projects');
  const { key, config, ...fields } = a;
  if (projectRow(ctx, key)) {
    updateProject(ctx, key, { ...fields, config }, actor);
    return { created: false, project: projectView(ctx, key) };
  }
  // a new project takes the config as given; null (= remove a key) means nothing there
  const fresh = config ? projectConfigSchema.parse(Object.fromEntries(Object.entries(config).filter(([, v]) => v != null))) : undefined;
  createProject(ctx, { ...fields, key, config: fresh }, actor);
  return { created: true, project: projectView(ctx, key) };
}

/** projects_set: state first (archive, unarchive, pause, resume), then autopilot. */
export function operatorSetProject(ctx: Ctx, a: ToolArgs<'projects_set'>, actor: string, caller: Caller): ProjectView {
  requireScope(ctx, caller, 'operator', "change a project's autopilot or state");
  if (a.autopilot === undefined && a.state === undefined) throw new FactoryError(400, 'give autopilot, state or both');
  const p = requireProject(ctx, a.key);
  if (a.state && a.state !== p.state) {
    if (a.state === 'archived') projectAction(ctx, p.key, 'archive', actor);
    else {
      if (p.state === 'archived') projectAction(ctx, p.key, 'unarchive', actor);
      projectAction(ctx, p.key, a.state === 'paused' ? 'pause' : 'resume', actor);
    }
  }
  if (a.autopilot !== undefined) projectAction(ctx, p.key, 'autopilot', actor, { on: a.autopilot });
  return projectView(ctx, p.key);
}

// ---------- the Inbox ----------

/** The web Inbox's answers (POST /api/actions/:id/answer, inbox_answer). */
export const actionAnswerSchema: z.ZodType<ActionAnswer> = z.union([
  z.object({ type: z.literal('allow'), scope: z.enum(['once', 'session']).optional(), updatedInput: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('deny'), message: z.string().max(4000).optional(), interrupt: z.boolean().optional() }),
  z.object({ type: z.literal('answers'), answers: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('reply'), text: z.string().min(1).max(20000) }),
  z.object({ type: z.literal('release') }),
]);

/** What each kind of pending action takes from an agent (the buttons the web Inbox shows for it). */
const ANSWERS: Record<string, InboxAnswerType[]> = {
  permission: ['allow', 'deny'],
  plan: ['allow', 'deny'],
  question: ['answers', 'deny'],
  stop_wait: ['reply', 'release'],
};

/**
 * One path for the web Inbox and inbox_answer: the action must exist and still be pending; the session gets the answer
 * at once. `kinds`: refuse an answer type the action's kind does not take (agents).
 */
export function answerInboxAction(ctx: Ctx, id: string, answer: ActionAnswer, by: string, opts: { kinds?: boolean } = {}): { ok: true } {
  const p = getPending(ctx, id);
  if (!p) throw new FactoryError(404, 'not found');
  if (p.status !== 'pending') throw new FactoryError(409, `already ${p.status}`);
  if (opts.kinds && !(ANSWERS[p.kind] ?? []).includes(answer.type)) {
    throw new FactoryError(400, `a ${p.kind} takes ${(ANSWERS[p.kind] ?? []).join(' or ') || 'no answer from an agent'}, not ${answer.type}`);
  }
  const ok = answerPending(ctx, id, answer as unknown as Record<string, unknown>, by);
  ctx.db.audit(by, 'answer', id, answer);
  if (!ok) throw new FactoryError(409, 'already answered');
  return { ok: true };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

function inboxItem(p: PendingActionView, now: number): InboxItem {
  const r = p.request;
  const input = (r.toolInput ?? {}) as Record<string, unknown>;
  const item: InboxItem = {
    id: p.id, kind: p.kind as InboxItem['kind'], sessionId: p.sessionId, session: r.sessionName ?? null, project: r.projectName ?? null, machine: r.machineName ?? null,
    cwd: r.cwd ?? null, branch: r.branch ?? null, tool: p.toolName, ageMin: minutes(now - p.createdAt), expiresInMin: p.expiresAt ? minutes(p.expiresAt - now) : null,
    detail: cut(p.kind === 'stop_wait' ? (r.lastAssistantMessage ?? '') : p.kind === 'plan' ? String(input.plan ?? '') : p.kind === 'question' ? '' : JSON.stringify(input), 1500),
    answers: ANSWERS[p.kind] ?? [],
  };
  if (p.kind === 'question' && Array.isArray(input.questions)) {
    item.questions = (input.questions as { question?: unknown; options?: unknown; multiSelect?: unknown }[]).map((q) => ({
      question: String(q?.question ?? ''),
      options: Array.isArray(q?.options) ? q.options.map((o) => (typeof o === 'string' ? o : String((o as { label?: unknown })?.label ?? ''))) : [],
      multiSelect: !!q?.multiSelect,
    }));
  }
  return item;
}

export function operatorInbox(ctx: Ctx, a: ToolArgs<'inbox_list'>, caller: Caller): { pending: InboxItem[]; more: number } {
  requireScope(ctx, caller, 'inbox', 'read the Inbox');
  const now = Date.now();
  const all = listPending(ctx, 'pending', 500).filter((p) => p.kind !== 'pause');
  const limit = a.limit ?? 10;
  return { pending: all.slice(0, limit).map((p) => inboxItem(p, now)), more: Math.max(0, all.length - limit) };
}

export function operatorInboxAnswer(ctx: Ctx, a: ToolArgs<'inbox_answer'>, actor: string, caller: Caller): { ok: true } {
  requireScope(ctx, caller, 'inbox', 'answer the Inbox');
  const answer: ActionAnswer | null =
    a.type === 'allow' ? { type: 'allow', ...(a.scope ? { scope: a.scope } : {}) }
    : a.type === 'deny' ? { type: 'deny', ...(a.message?.trim() ? { message: a.message.trim() } : {}), ...(a.interrupt ? { interrupt: true } : {}) }
    : a.type === 'answers' ? (a.answers && Object.keys(a.answers).length ? { type: 'answers', answers: a.answers } : null)
    : a.type === 'reply' ? (a.text ? { type: 'reply', text: a.text } : null)
    : { type: 'release' };
  if (!answer) throw new FactoryError(400, a.type === 'answers' ? 'answers: { [question]: label } is required' : 'text is required for a reply');
  return answerInboxAction(ctx, a.id, answer, actor, { kinds: true });
}

// ---------- factory_status ----------

const TITLE = 80;
const QUESTION = 100;
const LIMITS = { line: 20, ready: 10, decisions: 20, controls: 10 };

/** Drops the fields that would say nothing (null, undefined): every byte counts in a small context. */
function lean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
  return o;
}
const orNull = <T>(v: T | null | undefined, keep = true) => (keep && v !== null && v !== undefined ? v : null);

/** The operator's picture of the factory in one small answer (§12.7). */
export function factoryStatus(ctx: Ctx, a: ToolArgs<'factory_status'>, actor: string, caller: Caller, now = Date.now()): FactoryStatus {
  const { db } = ctx;
  const g = governor(ctx, now);
  const projects: ProjectRow[] = a.project ? [requireProject(ctx, a.project)] : listProjectRows(ctx, ['active', 'paused']);
  // the packages in view: the project's, or those of every project not archived plus those without one
  const scope = a.project ? 't.project = ?' : "(t.project IS NULL OR t.project IN (SELECT key FROM factory_projects WHERE state != 'archived'))";
  const sargs = a.project ? [a.project] : [];
  const count = (sql: string, ...args: (string | number)[]) => db.get<{ n: number }>(sql, ...args)!.n;

  const machines = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM machines').map((m) => [m.id, m.name]));
  const counts = db.all<{ project: string; status: TaskStatus; n: number }>(
    `SELECT project, status, COUNT(*) n FROM tasks WHERE archived_at IS NULL AND project IN (${projects.map(() => '?').join(',') || "''"}) GROUP BY project, status`,
    ...projects.map((p) => p.key),
  );

  // pending decisions and open controls, by package, for "what it waits for"
  const decisionsSql = `${DECISION_SQL} WHERE d.status = 'pending' ${a.project ? `AND ${PROJECT_OF} = ?` : ''}`;
  const decisions = db.all<Decision>(`${decisionsSql} ORDER BY d.created_at ASC LIMIT ?`, ...sargs, LIMITS.decisions);
  const decisionsTotal = count(`SELECT COUNT(*) n FROM (${decisionsSql})`, ...sargs);
  const decidingTasks = new Set(db.all<{ task_id: string }>("SELECT DISTINCT task_id FROM decisions WHERE status = 'pending' AND task_id IS NOT NULL").map((r) => r.task_id));
  const controlsSql = `SELECT c.id, c.task_id, c.kind, c.created_at FROM control_requests c JOIN tasks t ON t.id = c.task_id WHERE c.status = 'open' AND ${scope}`;
  const controls = db.all<{ id: number; task_id: string; kind: 'stop' | 'revert'; created_at: number }>(`${controlsSql} ORDER BY c.created_at ASC LIMIT ?`, ...sargs, LIMITS.controls);
  const controlsTotal = count(`SELECT COUNT(*) n FROM (${controlsSql})`, ...sargs);
  const controlled = new Map(db.all<{ task_id: string; kind: string }>("SELECT task_id, kind FROM control_requests WHERE status = 'open'").map((r) => [r.task_id, r.kind]));

  const rounds = maxRounds(ctx);
  const lineSql = `SELECT t.id, t.project, t.title, t.status, t.stage, t.round, t.extra_rounds, t.line_json, t.updated_at FROM tasks t
    WHERE t.archived_at IS NULL AND t.status IN ('in_lucru', 'la_porti', 'blocata') AND ${scope}`;
  const line = db
    .all<{ id: string; project: string | null; title: string; status: TaskStatus; stage: string | null; round: number; extra_rounds: number; line_json: string | null; updated_at: number }>(
      `${lineSql} ORDER BY t.status = 'blocata' DESC, t.updated_at ASC, t.id LIMIT ?`, ...sargs, LIMITS.line,
    )
    .map((t) => {
      const l = json<{ waiting?: unknown; since?: unknown }>(t.line_json, null);
      const waits = controlled.has(t.id) ? `${controlled.get(t.id)} request`
        : decidingTasks.has(t.id) ? 'decision'
        : typeof l?.waiting === 'string' && l.waiting ? cut(l.waiting, 60)
        : t.status === 'blocata' ? 'owner' : t.status === 'la_porti' ? 'gates' : 'worker';
      const since = typeof l?.since === 'number' ? l.since : t.updated_at;
      return lean({
        id: t.id, project: orNull(t.project), title: cut(t.title, TITLE), status: t.status, stage: orNull(t.stage), round: orNull(t.round, t.round > 0),
        maxRounds: orNull(rounds + t.extra_rounds, t.round > 0), waits, sinceMin: minutes(now - since),
      }) as FactoryStatus['line'][number];
    });
  // gata packages whose start time has not come (§11.8): on the line view too, so the operator sees what they wait for
  const at = Math.floor(now);
  const laterSql = `SELECT t.id, t.project, t.title, t.not_before, t.updated_at FROM tasks t WHERE t.archived_at IS NULL AND t.status = 'gata' AND t.not_before > ${at} AND ${scope}`;
  const later = db
    .all<{ id: string; project: string | null; title: string; not_before: number; updated_at: number }>(
      `${laterSql} ORDER BY t.not_before, t.id LIMIT ?`, ...sargs, Math.max(0, LIMITS.line - line.length),
    )
    .map((t) => lean({
      id: t.id, project: orNull(t.project), title: cut(t.title, TITLE), status: 'gata' as const, waits: `start time ${formatStartTime(t.not_before)}`, sinceMin: minutes(now - t.updated_at),
    }) as FactoryStatus['line'][number]);
  line.push(...later);
  const lineTotal = count(`SELECT COUNT(*) n FROM (${lineSql})`, ...sargs) + count(`SELECT COUNT(*) n FROM (${laterSql})`, ...sargs);

  const readySql = `SELECT t.id, t.project, t.title, t.priority FROM tasks t WHERE t.status = 'gata' AND t.archived_at IS NULL AND ${scope}
    AND (t.not_before IS NULL OR t.not_before <= ${at})
    AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks x ON x.id = d.depends_on WHERE d.task_id = t.id AND x.status != 'integrata')`;
  const ready = db
    .all<{ id: string; project: string | null; title: string; priority: number }>(`${readySql} ORDER BY t.priority DESC, t.created_at ASC, t.id ASC LIMIT ?`, ...sargs, LIMITS.ready)
    .map((t) => lean({ id: t.id, project: orNull(t.project), title: cut(t.title, TITLE), priority: orNull(t.priority, t.priority !== 0) }) as FactoryStatus['ready'][number]);
  const readyTotal = count(`SELECT COUNT(*) n FROM (${readySql})`, ...sargs);

  // alerts: one line each
  const alerts: string[] = [];
  if (g.stopAll) alerts.push(`governor: stop all: ${cut(g.reason, 200)}`);
  else if (!g.canStart) alerts.push(`governor: no new work: ${cut(g.reason, 200)}`);
  const offline = new Map<string, string[]>();
  for (const p of projects) if (p.state === 'active' && p.machine_id && !ctx.runners.has(p.machine_id)) offline.set(p.machine_id, [...(offline.get(p.machine_id) ?? []), p.key]);
  for (const [m, keys] of offline) alerts.push(`runner offline on ${machines.get(m) ?? m} (${keys.join(', ')})`);
  // the conductor's own reasons (§12.5): paused, runner offline or too old, line unknown or invalid, a recipe line, the governor
  const held = projects.flatMap((p) => {
    const h = autopilotHold(ctx, p, g);
    return h ? [`${p.key} (${h.short})`] : [];
  });
  if (held.length) alerts.push(`autopilot held: ${held.join(', ')}`);
  for (const p of projects) if (p.line_error) alerts.push(`line file of ${p.key}: ${cut(p.line_error, 120)}`);
  for (const m of missedSince(ctx, now - 24 * 3600_000)) {
    alerts.push(`scheduled start missed: ${cut(m.title, 80)} (planned ${formatStartTime(m.notBefore)})${m.waits ? `, it waited for: ${cut(m.waits, 100)}` : ''}`);
  }
  const scheduled = listScheduled(ctx, { project: a.project }, now)
    .filter((s) => s.status === 'pending' || s.status === 'starting')
    .map((s) => lean({ id: s.id, kind: s.kind, taskId: orNull(s.taskId), title: cut(s.title, TITLE), notBefore: s.notBefore, expiresAt: s.expiresAt, waits: cut(s.waits ?? '', 200) }) as FactoryStatus['scheduled'][number]);

  const operator = hasScope(ctx, caller, 'operator');
  const usage = g.usage;
  return {
    at: now,
    governor: {
      canStart: g.canStart, stopAll: g.stopAll, reason: cut(g.reason, 200), waitUntil: g.waitUntil,
      fiveHourPct: usage.fiveHour ? Math.round(usage.fiveHour.pct) : null, sevenDayPct: usage.sevenDay ? Math.round(usage.sevenDay.pct) : null,
      usageAgeMin: usage.ageMs === null ? null : minutes(usage.ageMs),
    },
    alerts,
    projects: projects.map((p) => lean({
      key: p.key, name: cut(p.name, TITLE), state: p.state, autopilot: !!p.autopilot, machine: p.machine_id ? (machines.get(p.machine_id) ?? p.machine_id) : null,
      runnerOnline: p.machine_id ? ctx.runners.has(p.machine_id) : null,
      counts: Object.fromEntries(counts.filter((c) => c.project === p.key).map((c) => [c.status, c.n])),
    }) as FactoryStatus['projects'][number]),
    line,
    lineMore: Math.max(0, lineTotal - line.length),
    ready,
    readyMore: Math.max(0, readyTotal - ready.length),
    scheduled,
    waiting: {
      decisions: decisions.map((d) => lean({
        id: d.id, kind: kindOf(d), taskId: d.task_id, question: cut(d.question, QUESTION), options: (json<string[]>(d.options_json, []) ?? []).map((o) => cut(o, 40)),
        askedBy: d.asked_by, ageMin: minutes(now - d.created_at), mayAnswer: !refusal(ctx, d, actor, caller, operator),
      }) as FactoryStatus['waiting']['decisions'][number]),
      decisionsMore: Math.max(0, decisionsTotal - decisions.length),
      controls: controls.map((c) => ({ id: c.id, taskId: c.task_id, kind: c.kind, ageMin: minutes(now - c.created_at) })),
      controlsMore: Math.max(0, controlsTotal - controls.length),
      inbox: count("SELECT COUNT(*) n FROM pending_actions WHERE status = 'pending' AND kind != 'pause'"),
    },
  };
}
