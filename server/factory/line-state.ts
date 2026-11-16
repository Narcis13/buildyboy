// The conductor's state per package (SPEC §12.5): `tasks.stage` (where it is on the line) and `tasks.line_json` (what it
// waits for, the run, job or herdr command in flight, counters). Every write goes through `persist`, in one transaction
// with whatever the transition sent, and every transition leaves a `line` row in the package's history.
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { enabledGates, type ResolvedLine } from '../../shared/line.ts';
import type { Gate, GovernorVerdict, StepFile, TaskStatus } from '../../shared/factory.ts';
import type { ProjectRow } from './projects.ts';
import { taskEvent, updateTask, type TaskRow } from './tasks.ts';

export const LINE_ACTOR = 'factory:line';
/** a step that ended in error is retried once after this */
export const RETRY_MS = 60_000;
/** a message the worker could not take yet (not idle) is tried again after this */
export const SEND_RETRY_MS = 30_000;
/** an hc worker that has no session this long after its launch never started */
export const NO_SESSION_MS = 15 * 60_000;
/** a worker told to stop gets this long to commit and push before its terminal is killed */
export const STOP_GRACE_MS = 10 * 60_000;
/** the budget of a headless (claude -p) worker's turn */
export const HEADLESS_BUDGET_USD = 30;

/** A message on its way to the worker: `hc send` (with files under .factory/) or a job that resumes its session. */
export interface Tell {
  /** the whole message (a headless worker's next prompt; the hc line when there is no `line`) */
  text: string;
  /** the one line sent to a herdr terminal when the text travels as a file */
  line?: string;
  files?: StepFile[];
  /** send only when the terminal is idle (its turn ended), so the next Stop is the answer to this */
  ifIdle: boolean;
  /** what it is, for the history: "the G1 findings" */
  what: string;
  /** stopAll's pause: no status line is expected after it */
  pause?: boolean;
  hcId?: string;
  /** the newest hook event when it was sent */
  mark?: number;
  tries: number;
}

export type Ask = 'attention' | 'approval' | 'protected' | 'question' | 'escalation' | 'rounds';
/** why the package needs attention, which says what Retry does */
export type Why = 'step' | 'dead' | 'limit' | 'nostatus' | 'foreman' | 'launch' | 'enter' | 'g5off' | 'revert';

export interface LineState {
  /** what it waits for now, one short line (factory_status shows it) */
  waiting: string;
  /** since when (epoch ms) */
  since: number;
  /** the status the conductor left it in: another one means it was moved by hand */
  status: TaskStatus;
  /** errors of the current step (a second one needs attention) */
  attempts: number;
  runId?: string;
  retryAt?: number;
  /** the worktree prepare reported */
  worktree?: string;
  // the worker
  launcher?: 'hc' | 'claude';
  /** its launch job (hc) or its current turn's job (claude) */
  jobId?: string;
  launchedAt?: number;
  /** Stop events after this hook event id belong to the turn we wait for */
  mark?: number;
  /** a (re)launch is due: first start, or after its session ended without done */
  needLaunch?: 'first' | 'resume';
  restarts?: number;
  nudged?: boolean;
  /** told to wait by the governor's stopAll */
  paused?: boolean;
  tell?: Tell;
  // asking
  decisionId?: string;
  ask?: Ask;
  why?: Why;
  /** what happened, for the decision and the foreman */
  what?: string;
  foremanJob?: string;
  foremanAbout?: { kind: 'question' | 'blocked' | 'nostatus' | 'step' | 'attention'; what: string };
  /** "I'll take it from here", a stop or a block: left alone until its status changes by hand */
  hold?: boolean;
  approved?: boolean;
  allowProtected?: boolean;
  /** the next round runs only this gate (and G5) */
  only?: Gate;
  /** the failed gate run whose findings go back */
  lastFail?: string;
  stop?: { phase: 'tell' | 'told' | 'kill'; at: number; mark: number; controlId?: number; note?: string | null; hcId?: string };
}

export interface Env {
  ctx: Ctx;
  p: ProjectRow;
  line: ResolvedLine;
  g: GovernorVerdict;
  now: number;
}

export function stateOf(t: TaskRow): LineState | null {
  const s = json<LineState>(t.line_json, null);
  return s && typeof s === 'object' && typeof s.status === 'string' && typeof s.waiting === 'string' ? s : null;
}

/** A fresh state for a stage. */
export const fresh = (e: Env, t: TaskRow, waiting: string, keep: Partial<LineState> = {}): LineState => ({ waiting, since: e.now, status: t.status, attempts: 0, ...keep });

/** Sets what it waits for; `since` moves only when that changes. */
export function waitFor(e: Env, st: LineState, text: string): LineState {
  if (st.waiting !== text) {
    st.waiting = text;
    st.since = e.now;
  }
  return st;
}

export interface PersistOpts {
  stage?: string | null;
  /** the history line: what happened, why, what it waits for now */
  text?: string;
  status?: TaskStatus;
  note?: string;
}

/**
 * Writes the state (null: off the line) and, with `text`, the history row; moves the status through updateTask (its
 * rounds and events). Call inside the transaction that sent what the state records. Keeps `t` in step.
 */
export function persist(e: Env, t: TaskRow, st: LineState | null, o: PersistOpts = {}): true {
  const { ctx } = e;
  ctx.db.tx(() => {
    const cur = ctx.db.get<{ status: TaskStatus; stage: string | null }>('SELECT status, stage FROM tasks WHERE id = ?', t.id)!;
    if (o.status && o.status !== cur.status) updateTask(ctx, { id: t.id, status: o.status, ...(o.note ? { note: o.note } : {}) }, LINE_ACTOR);
    const status = ctx.db.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', t.id)!.status;
    const stage = o.stage === undefined ? cur.stage : o.stage;
    if (st) st.status = status;
    const lineJson = st ? JSON.stringify(st) : null;
    ctx.db.run('UPDATE tasks SET stage = ?, line_json = ?, updated_at = ? WHERE id = ?', stage, lineJson, Date.now(), t.id);
    if (o.text) taskEvent(ctx, t.id, LINE_ACTOR, 'line', null, null, { text: o.text, ...(stage ? { stage } : {}), ...(st ? { waiting: st.waiting } : {}) });
    t.status = status;
    t.stage = stage;
    t.line_json = lineJson;
  });
  ctx.bus.publish('tasks', 'changed', { id: t.id });
  return true;
}

/** Waits for something new: one history row when what it waits for changes, nothing otherwise. */
export function setWait(e: Env, t: TaskRow, st: LineState, text: string): boolean {
  if (st.waiting === text) return false;
  waitFor(e, st, text);
  return persist(e, t, st, { text: `Waits: ${text}.` });
}

/** The package's row as it is now. */
export const taskRow = (ctx: Ctx, id: string): TaskRow => ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id)!;

/** The answer as the conductor compares it: trimmed, lower case. */
export const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** The gates of this round, in order: every enabled one, or with `only` that gate and G5. G5 is last when it is on. */
export function gateSeq(line: ResolvedLine, st: Pick<LineState, 'only'>): Gate[] {
  const on = enabledGates(line);
  if (st.only && on.includes(st.only)) return [...new Set([st.only, ...(on.includes('G5') ? (['G5'] as const) : [])])];
  return on;
}

export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
export const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
