// The conductor (SPEC §12.5): for each project with autopilot on and state `active` it moves the packages along the line
//
//   (ready) claim → prepare → qa → build → G1 → G2 → G3 → G4 → G5 → integrata → cleanup
//
// by reading the database and sending commands to the project's runner (step runs, job launches, `hc` commands); it
// never runs anything itself. `tick(ctx, project)` advances every package by at most one transition and is safe to call
// at any time, any number of times: the run, job or command a transition sends is recorded in `tasks.line_json` in the
// same transaction, and a stage with one in flight waits for it. State survives restarts. Every transition leaves a
// `line` row in the package's history. It runs on bus events and every 20 s (server/background.ts), never in tests
// unless a test calls it. The worker side is line-worker.ts; questions and controls line-decide.ts; plans plan.ts.
import type { Ctx } from '../context.ts';
import { isGate, KIT_STEPS, type StepName, type TaskStatus } from '../../shared/factory.ts';
import { briefFiles } from './brief.ts';
import { answerDecision, getDecision, listDecisions } from './decisions.ts';
import { gateRunStatus, gateRunView, startStepRun } from './gateruns.ts';
import { governor } from './governor.ts';
import { askApproval, askProtected, attention, control, decided, findingsTell, needsApproval, stopping, toBuild } from './line-decide.ts';
import { cut, fresh, gateSeq, LINE_ACTOR, persist, RETRY_MS, setWait, stateOf, taskRow, waitFor, type Env, type LineState } from './line-state.ts';
import { build, foremanDone, tellOf, workerAlive } from './line-worker.ts';
import { advancePlans } from './plan.ts';
import { autopilotHold, listProjectRows, projectConfig, projectLine, projectRow, requestLine } from './projects.ts';
import { ackControls, claimTask, FactoryError, listTasks, taskEvent, updateTask, type TaskRow } from './tasks.ts';

export { parseStatusLine } from './worker.ts';
export { LINE_ACTOR } from './line-state.ts';

/** Steps that spend tokens: none starts while the governor says stopAll. */
const TOKEN_STEPS = new Set<StepName>(['qa', 'G3', 'G4']);
/** How often the conductor asks a runner for a line it does not know yet. */
const LINE_ASK_MS = 5 * 60_000;
/** a step run or hc command still queued after this is sent to the runner again */
export const RESEND_MS = 60_000;
const lineAsked = new Map<string, number>();
const busy = new Set<string>();

const STEP_LABEL: Partial<Record<StepName, string>> = { prepare: 'prepare', qa: 'QA', cleanup: 'cleanup', revert: 'revert' };
const label = (s: StepName) => STEP_LABEL[s] ?? s;

export interface TickResult {
  /** transitions made */
  moved: number;
  /** why the conductor holds the project (null: it drives it fully) */
  held: string | null;
}

/**
 * One pass over a project: its plans, then (autopilot on, `active`) each package by at most one transition, then claims
 * up to `limits.workers`. `now` is injectable so tests never sleep.
 */
export function tick(ctx: Ctx, key: string, now = Date.now()): TickResult {
  if (busy.has(key)) return { moved: 0, held: 'a tick is running' };
  busy.add(key);
  try {
    let moved = advancePlans(ctx, key);
    const p = projectRow(ctx, key);
    if (!p || !p.autopilot || p.state !== 'active') return { moved, held: !p ? 'unknown project' : !p.autopilot ? 'autopilot is off' : `the project is ${p.state}` };
    const g = governor(ctx, now);
    const hold = autopilotHold(ctx, p, g);
    if (hold?.all) {
      if (hold.short === 'line unknown' && (lineAsked.get(key) ?? 0) < now - LINE_ASK_MS) {
        lineAsked.set(key, now);
        requestLine(ctx, p);
      }
      return { moved, held: hold.why };
    }
    const e: Env = { ctx, p, line: projectLine(p)!, g, now };
    const touched = new Set<string>();
    for (const t of lineTasks(ctx, key)) {
      try {
        if (advance(e, t)) {
          moved++;
          touched.add(t.id);
        }
      } catch (err) {
        // one package's trouble must not stop the others
        console.error(`[line] ${t.id}:`, err);
      }
    }
    moved += claimNext(e, touched);
    return { moved, held: hold?.why ?? null };
  } finally {
    busy.delete(key);
  }
}

/** Every project the conductor has something to do in: autopilot on, or a plan in flight. */
export function conductAll(ctx: Ctx, now = Date.now()): number {
  const keys = new Set([
    ...listProjectRows(ctx, ['active']).filter((p) => p.autopilot).map((p) => p.key),
    ...ctx.db.all<{ project: string }>("SELECT DISTINCT project FROM plans WHERE status IN ('running', 'proposed', 'failed')").map((r) => r.project),
  ]);
  let moved = 0;
  for (const k of keys) moved += tick(ctx, k, now).moved;
  return moved;
}

/** Runs the conductor on the events that matter (packages, runs, jobs, sessions, decisions, runners), debounced. */
export function startConductor(ctx: Ctx): () => void {
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    timer = null;
    try {
      conductAll(ctx);
    } catch (e) {
      console.error('[line]', e);
    }
  };
  const TOPICS = new Set(['tasks', 'jobs', 'floor', 'inbox', 'machines']);
  const off = ctx.bus.subscribe((ev) => {
    if (!TOPICS.has(ev.topic) || timer) return;
    timer = setTimeout(run, 500);
    timer.unref();
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}

/** The packages the conductor looks at: on its line, in flight (picked up), or with an open stop/revert request. */
function lineTasks(ctx: Ctx, key: string): TaskRow[] {
  return ctx.db.all<TaskRow>(
    `SELECT * FROM tasks t WHERE t.project = ? AND (
       (t.archived_at IS NULL AND (t.line_json IS NOT NULL OR t.status IN ('in_lucru', 'la_porti')))
       OR EXISTS (SELECT 1 FROM control_requests c WHERE c.task_id = t.id AND c.status = 'open'))
     ORDER BY t.priority DESC, t.created_at, t.id`,
    key,
  );
}

const openControl = (ctx: Ctx, taskId: string) =>
  ctx.db.get<{ id: number; kind: 'stop' | 'revert'; note: string | null }>("SELECT id, kind, note FROM control_requests WHERE task_id = ? AND status = 'open' ORDER BY created_at, id LIMIT 1", taskId) ?? null;

/** One transition for one package, or none. */
function advance(e: Env, t: TaskRow): boolean {
  const st = stateOf(t);
  if (st?.stop) return stopping(e, t, st);
  const ctl = openControl(e.ctx, t.id);
  if (ctl && !(ctl.kind === 'revert' && t.stage === 'revert' && st)) return control(e, t, st, ctl);
  if (!st) return adopt(e, t);
  if (st.status !== t.status) return pickUp(e, t, st);
  if (st.hold) return false;
  if (st.decisionId) return decided(e, t, st);
  if (st.foremanJob) return foremanDone(e, t, st);
  const stage = t.stage as StepName | 'build' | null;
  if (stage === 'build') return build(e, t, st);
  if (stage && (isGate(stage) || (KIT_STEPS as readonly string[]).includes(stage))) return step(e, t, st, stage);
  return false;
}

/** The worktree of the package's last good prepare, if any (it was prepared). */
function prepared(e: Env, taskId: string): { worktree: string | null } | null {
  const r = e.ctx.db.get<{ details_json: string | null }>("SELECT details_json FROM gate_runs WHERE task_id = ? AND gate = 'prepare' AND status = 'done' AND verdict = 'pass' ORDER BY finished_at DESC LIMIT 1", taskId);
  if (!r) return null;
  const w = (() => {
    try {
      return (JSON.parse(r.details_json ?? 'null') as { worktree?: unknown } | null)?.worktree;
    } catch {
      return null;
    }
  })();
  return { worktree: typeof w === 'string' ? w : null };
}

/** A package in flight the conductor has no state for (claimed by hand, or before autopilot was on). */
function adopt(e: Env, t: TaskRow): boolean {
  if (t.status === 'la_porti') {
    const first = gateSeq(e.line, {})[0];
    if (!first) return false;
    const st = fresh(e, t, `${first} run`, { worktree: prepared(e, t.id)?.worktree ?? undefined, launcher: e.line.worker.launcher, jobId: t.job_id ?? undefined, launchedAt: e.now, mark: 0 });
    return persist(e, t, st, { stage: first, text: `Picked up at the gates (round ${t.round}): ${first} first.` });
  }
  return pickUpWork(e, t, null, `Picked up in progress`);
}

/** in_lucru without a running conductor state: prepare first if it never was, else the worker (alive or started again). */
function pickUpWork(e: Env, t: TaskRow, st: LineState | null, how: string): boolean {
  const prep = prepared(e, t.id);
  if (!prep) return persist(e, t, fresh(e, t, 'prepare run'), { stage: 'prepare', text: `${how}: it was never prepared, so prepare runs first.` });
  const launcher = st?.launcher ?? e.line.worker.launcher;
  const jobId = st?.jobId ?? t.job_id ?? undefined;
  const alive = workerAlive(e, t, { launcher, jobId });
  const next = fresh(e, t, alive ? "the worker's status line" : 'a new worker', {
    worktree: st?.worktree ?? prep.worktree ?? undefined, launcher, jobId, launchedAt: st?.launchedAt ?? e.now, mark: st ? st.mark : 0, restarts: st?.restarts, lastFail: st?.lastFail,
    ...(alive ? {} : { needLaunch: 'resume' as const }),
  });
  const failed = st?.lastFail ? gateRunView(e.ctx, st.lastFail) : null;
  if (st && (st.status === 'la_porti' || st.status === 'blocata')) {
    next.tell = failed && failed.verdict === 'fail' ? findingsTell(e, t, failed) : tellOf('to go on', 'The owner moved this package back to work. Go on, run the checks, push, then end your final message with the FACTORY-STATUS line.');
  }
  return persist(e, t, next, { stage: 'build', text: `${how}: ${alive ? 'its worker is at work; waits for its status line' : 'no live worker, so one starts from PROGRESS.md'}.` });
}

/** Its status was changed by someone else (the owner, an operator, a coordinator): pick it up from the new one. */
function pickUp(e: Env, t: TaskRow, st: LineState): boolean {
  if (st.decisionId && getDecision(e.ctx, st.decisionId)?.status === 'pending' && t.status !== 'blocata') answerDecision(e.ctx, st.decisionId, null, LINE_ACTOR);
  const by = `Moved to ${t.status} (was ${st.status})`;
  switch (t.status as TaskStatus) {
    case 'backlog':
    case 'gata':
      return persist(e, t, null, { stage: null, text: `${by}: off the line.` });
    case 'blocata': {
      // a gate failed in the last allowed round (§11.7): its decision drives what comes next
      const rounds = listDecisions(e.ctx, { taskId: t.id, status: 'pending' }).find((d) => d.askedBy === 'factory:rounds');
      const run = rounds ? lastFailedRunId(e, t.id) : undefined;
      const next: LineState = { ...st, decisionId: rounds?.id, ask: rounds ? 'rounds' : undefined, hold: !rounds, runId: undefined, lastFail: run ?? st.lastFail };
      waitFor(e, next, rounds ? 'decision: one more round?' : 'the owner (blocked)');
      return persist(e, t, next, {
        text: rounds ? `${rounds.question} The owner decides: another round, or stop.` : `${by}: the conductor leaves it until it moves again.`,
      });
    }
    case 'in_lucru':
      return pickUpWork(e, t, st, by);
    case 'la_porti': {
      const first = gateSeq(e.line, {})[0];
      const next = fresh(e, t, `${first} run`, { worktree: st.worktree, launcher: st.launcher, jobId: st.jobId, launchedAt: st.launchedAt, mark: st.mark, restarts: st.restarts });
      return persist(e, t, next, { stage: first, text: `${by}: round ${t.round} of the gates, ${first} first.` });
    }
    case 'integrata':
      return persist(e, t, fresh(e, t, 'cleanup run', { worktree: st.worktree }), { stage: 'cleanup', text: `${by}: cleanup next.` });
  }
}

const lastFailedRunId = (e: Env, taskId: string) =>
  e.ctx.db.get<{ id: string }>("SELECT id FROM gate_runs WHERE task_id = ? AND status = 'done' AND verdict = 'fail' ORDER BY finished_at DESC LIMIT 1", taskId)?.id;

// ---------- steps: prepare, qa, gates, cleanup, revert ----------

/**
 * Starts the stage the package just moved to, in the same pass: a step passing and the next one starting are one hop
 * (two history rows), so a package never idles a tick between stages.
 */
export function onward(e: Env, t: TaskRow, st: LineState): true {
  const s = t.stage as StepName | 'build' | null;
  if (s === 'build') build(e, t, st);
  else if (s && (isGate(s) || (KIT_STEPS as readonly string[]).includes(s))) startStep(e, t, st, s);
  return true;
}

function step(e: Env, t: TaskRow, st: LineState, name: StepName): boolean {
  if (!st.runId) return startStep(e, t, st, name);
  // a run still queued is re-sent (gates_status semantics), but not on every tick of its first minute
  const seen = gateRunView(e.ctx, st.runId);
  const r = seen && seen.status === 'queued' && e.now - seen.createdAt < RESEND_MS ? seen : gateRunStatus(e.ctx, st.runId, e.now);
  if (r.status === 'queued' || r.status === 'running') return false;
  if (r.status === 'error') return stepError(e, t, st, name, r.error ?? 'error');
  return stepDone(e, t, st, name, r.id, r.verdict!, r.summary ?? '', r.details);
}

function startStep(e: Env, t: TaskRow, st: LineState, name: StepName): boolean {
  const { ctx, now } = e;
  if (st.retryAt && now < st.retryAt) return false;
  if (TOKEN_STEPS.has(name) && e.g.stopAll) return setWait(e, t, st, `governor: stop all (${label(name)} spends tokens)`);
  if (name === 'G5' && !st.approved && !st.allowProtected) {
    const approval = needsApproval(e, t);
    if (approval) return askApproval(e, t, st, approval);
  }
  try {
    ctx.db.tx(() => {
      const files = name === 'prepare' ? briefFiles(ctx, taskRow(ctx, t.id), e.p, e.line, LINE_ACTOR) : undefined;
      const run = startStepRun(ctx, { taskId: t.id, step: name, args: name === 'G5' && st.allowProtected ? ['--allow-protected'] : [], files }, LINE_ACTOR);
      Object.assign(st, { runId: run.id, retryAt: undefined });
      waitFor(e, st, `${label(name)} run`);
      persist(e, t, st, { text: `${label(name)[0].toUpperCase()}${label(name).slice(1)} started${isGate(name) ? ` (round ${Math.max(1, t.round)})` : ''}${run.sent ? '' : '; the runner gets it when it is back'}.` });
    });
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    return stepError(e, t, st, name, err.message);
  }
  return true;
}

/** No verdict: retried once after a minute; a second error needs attention (G5's protected paths ask the owner). */
function stepError(e: Env, t: TaskRow, st: LineState, name: StepName, error: string): boolean {
  if (name === 'G5' && /^needs approval\b/i.test(error)) return askProtected(e, t, st, error);
  const attempts = st.attempts + 1;
  if (attempts < 2) {
    Object.assign(st, { runId: undefined, attempts, retryAt: e.now + RETRY_MS });
    waitFor(e, st, `${label(name)} again in a minute`);
    return persist(e, t, st, { text: `${label(name)} could not run (${cut(error, 300)}). Trying again in a minute.` });
  }
  if (name === 'cleanup') return leave(e, t, `Cleanup could not run twice (${cut(error, 300)}): clean up by hand (worktree, branch, terminal).`, true);
  return attention(e, t, { ...st, runId: undefined, attempts }, `${label(name)} could not run twice: ${cut(error, 500)}`, name === 'revert' ? 'revert' : 'step');
}

/** Off the line; with `warn`, a warning event too (the digest lists it). */
function leave(e: Env, t: TaskRow, text: string, warn = false): boolean {
  e.ctx.db.tx(() => {
    persist(e, t, null, { stage: null, text });
    if (warn) taskEvent(e.ctx, t.id, LINE_ACTOR, 'warning', null, null, { message: text });
  });
  return true;
}

function stepDone(e: Env, t: TaskRow, st: LineState, name: StepName, runId: string, verdict: 'pass' | 'fail' | 'skip', summary: string, details: unknown): boolean {
  const ok = verdict !== 'fail';
  const said = cut(summary.replace(/\s+/g, ' ').trim(), 300);
  switch (name) {
    case 'prepare': {
      if (!ok) return attention(e, t, { ...st, runId: undefined }, `prepare failed: ${said}`, 'step');
      const w = (details as { worktree?: unknown } | null)?.worktree;
      const nextStage = e.line.qa ? 'qa' : 'build';
      const next = fresh(e, t, nextStage === 'qa' ? 'QA run' : 'the worker', { worktree: typeof w === 'string' ? w : st.worktree, ...(nextStage === 'build' ? { needLaunch: 'first' as const } : {}) });
      persist(e, t, next, { stage: nextStage, text: `Prepared (${said}). Next: ${nextStage === 'qa' ? 'QA writes the acceptance tests' : 'the worker'}.` });
      return onward(e, t, next);
    }
    case 'qa': {
      if (!ok) return attention(e, t, { ...st, runId: undefined }, `QA failed: ${said}`, 'step');
      const next = fresh(e, t, 'the worker', { worktree: st.worktree, needLaunch: 'first' });
      persist(e, t, next, { stage: 'build', text: `QA wrote the acceptance tests (${said}). Next: the worker.` });
      return onward(e, t, next);
    }
    case 'cleanup':
      return ok ? leave(e, t, `Cleaned up (${said}). The package leaves the line.`) : leave(e, t, `Cleanup did not finish (${said}): clean up by hand.`, true);
    case 'revert': {
      if (!ok) return attention(e, t, { ...st, runId: undefined }, `the revert failed: ${said}`, 'revert');
      e.ctx.db.tx(() => {
        const open = e.ctx.db.all<{ id: number }>("SELECT id FROM control_requests WHERE task_id = ? AND kind = 'revert' AND status = 'open'", t.id).map((r) => r.id);
        updateTask(e.ctx, { id: t.id, status: 'gata', note: `reverted: ${cut(summary, 500)}` }, LINE_ACTOR);
        ackControls(e.ctx, open, LINE_ACTOR);
        persist(e, t, null, { stage: null, text: `Reverted (${said}): back to gata.` });
      });
      return true;
    }
  }
  // a gate
  if (ok) {
    const seq = gateSeq(e.line, st);
    const next = seq[seq.indexOf(name as never) + 1];
    if (name === 'G5') {
      const n = fresh(e, t, 'cleanup run', { worktree: st.worktree, launcher: st.launcher });
      persist(e, t, n, { stage: 'cleanup', status: 'integrata', note: `G5: ${cut(summary, 500)}`, text: `G5 ${verdict}: integrated (${said}). Cleanup next.` });
      return onward(e, t, n);
    }
    if (!next) return attention(e, t, { ...st, runId: undefined }, `${name} ${verdict}, but G5 is off in this line: the conductor cannot integrate it; integrate it by hand`, 'g5off');
    const n = { ...st, runId: undefined, attempts: 0, retryAt: undefined };
    waitFor(e, n, `${next} run`);
    persist(e, t, n, { stage: next, text: `${name} ${verdict} (${said}). Next: ${next}.` });
    return onward(e, t, n);
  }
  const now = taskRow(e.ctx, t.id);
  st.lastFail = runId;
  if (now.status === 'blocata') {
    // the last allowed round failed: §11.7 blocked it and asked; pickUp sees the decision
    st.runId = undefined;
    return pickUp(e, now, st);
  }
  const run = gateRunView(e.ctx, runId)!;
  return toBuild(e, t, { ...st, runId: undefined }, findingsTell(e, t, run), `${name} failed in round ${run.round} (${said}): the findings go back to the worker.`);
}

// ---------- claims ----------

/** limits.workers: the owner's override, else the line's (default 2). */
const workersLimit = (e: Env) => projectConfig(e.p).limits?.workers ?? e.line.limits?.workers ?? 2;

function claimNext(e: Env, touched: Set<string>): number {
  if (!e.g.canStart) return 0;
  const { ctx, p } = e;
  const limit = workersLimit(e);
  let inFlight = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE project = ? AND archived_at IS NULL AND status IN ('in_lucru', 'la_porti')", p.key)!.n;
  let n = 0;
  for (const r of listTasks(ctx, { project: p.key, ready: true })) {
    if (inFlight >= limit) break;
    if (touched.has(r.id)) continue;
    if (claim(e, r.id)) {
      inFlight++;
      n++;
    }
  }
  return n;
}

/** Claims a ready package (resources allocated) and starts prepare with the worker's brief: one transition. */
function claim(e: Env, id: string): boolean {
  const { ctx, p, line, now } = e;
  return ctx.db.tx(() => {
    const c = claimTask(ctx, { id, project: p.key, force: true, agent: LINE_ACTOR }, LINE_ACTOR);
    if (!c.task) return false;
    const t = taskRow(ctx, id);
    const res = c.resources ? [c.resources.port != null ? `port ${c.resources.port}` : null, c.resources.db ? `db ${c.resources.db}` : null].filter(Boolean).join(', ') : '';
    const st = fresh(e, t, 'prepare run');
    try {
      const files = briefFiles(ctx, t, p, line, LINE_ACTOR);
      const run = startStepRun(ctx, { taskId: id, step: 'prepare', files }, LINE_ACTOR);
      st.runId = run.id;
      persist(e, t, st, { stage: 'prepare', text: `Claimed${res ? ` (${res})` : ''}: prepare started (worktree, branch, the worker's brief).` });
    } catch (err) {
      if (!(err instanceof FactoryError)) throw err;
      Object.assign(st, { attempts: 1, retryAt: now + RETRY_MS });
      waitFor(e, st, 'prepare again in a minute');
      persist(e, t, st, { stage: 'prepare', text: `Claimed, but prepare could not start (${cut(err.message, 300)}). Trying again in a minute.` });
    }
    return true;
  });
}
