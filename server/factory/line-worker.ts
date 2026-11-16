// The conductor's `build` stage (SPEC §12.5): launch the worker (§11.4: a herdr terminal `bb-<id>`, or `claude -p`),
// wait for its turn to end and read its status line; tell it things (findings, answers, a nudge, the governor's pause)
// through `hc send` or a job that resumes its session; start it again once when it dies; ask the foreman (§12.6) when
// it asks or is stuck, and apply the foreman's answer.
import { createJob, JobError } from '../jobs/core.ts';
import { fill } from '../../shared/line.ts';
import { LINE_ANSWERS } from '../../shared/factory.ts';
import { LAUNCH_LINE, modelFor, RESUME_LINE } from './brief.ts';
import { askDecision } from './decisions.ts';
import { foremanResult, startForeman } from './foreman.ts';
import { hcCommandStatus, sendHcCommand } from './hc.ts';
import { launchWorker } from './launch.ts';
import { attention, enterGates } from './line-decide.ts';
import { RESEND_MS } from './line.ts';
import {
  cut, HEADLESS_BUDGET_USD, LINE_ACTOR, NO_SESSION_MS, persist, SEND_RETRY_MS, setWait, waitFor, type Env, type LineState, type Tell,
} from './line-state.ts';
import { FactoryError, taskVars, type TaskRow } from './tasks.ts';
import { eventMark, jobAnswer, lastStop, linkSession, parseStatusLine, sessionEnded } from './worker.ts';

export const NUDGE =
  'Your last message did not end with the factory status line. End your final message with exactly one of: FACTORY-STATUS: done | FACTORY-STATUS: question <your question> | FACTORY-STATUS: blocked <why>. If the package is finished and the checks pass, answer with FACTORY-STATUS: done now.';
export const PAUSE =
  'The factory is pausing: the usage limit is near. Commit your work, push your branch, update PROGRESS.md with the next step, then wait for the next message. Do not start anything new.';
export const RESUME_WORK = 'The factory resumes. Go on from PROGRESS.md, and end your final message with the FACTORY-STATUS line.';
export const STOP_WORK = (note: string | null | undefined) =>
  `The owner stopped this package${note ? ` (${note.replace(/\s+/g, ' ').slice(0, 300)})` : ''}. Commit your work, push your branch, update PROGRESS.md, then stop: do not start anything new.`;

/** A message for the worker: `text` goes as a file when it is long or multi-line. */
export const tellOf = (what: string, text: string, extra: Partial<Tell> = {}): Tell => ({ what, text, ifIdle: true, tries: 0, ...extra });

/** The worktree: what prepare reported, else the line's template resolved against the checkout as the runner does. */
export function worktreeOf(e: Env, t: TaskRow, st: LineState): string {
  if (st.worktree) return st.worktree;
  const rel = fill(e.line.worktree, taskVars(t, e.p));
  if (/^([a-zA-Z]:)?[\\/]/.test(rel)) return rel;
  const parts = `${e.p.checkout!.replace(/[\\/]+$/, '')}/${rel}`.split(/[\\/]+/);
  const out: string[] = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s !== '.') out.push(s);
  }
  return out.join('/');
}

/** The worker's session: linked to the package through its terminal (hc) or its job (claude). */
function workerSession(e: Env, t: TaskRow, st: LineState): string | null {
  if (t.session_id) return t.session_id;
  if (st.launcher === 'claude' && st.jobId) return e.ctx.db.get<{ session_id: string | null }>('SELECT session_id FROM jobs WHERE id = ?', st.jobId)?.session_id ?? null;
  return null;
}

/** A live worker: its herdr session has not ended, or its claude -p turn is still running. */
export function workerAlive(e: Env, t: TaskRow, st: Pick<LineState, 'launcher' | 'jobId'>): boolean {
  if (st.launcher === 'claude') return !!st.jobId && jobAnswer(e.ctx, st.jobId).state === 'running';
  return !!t.session_id && !sessionEnded(e.ctx, t.session_id);
}

/** Launches the worker (first start, or again from PROGRESS.md). No worker starts while the governor says canStart: false. */
export function launch(e: Env, t: TaskRow, st: LineState): boolean {
  const { ctx, p, line, now } = e;
  if (!e.g.canStart) return setWait(e, t, st, 'governor: no new worker now');
  const resume = st.needLaunch === 'resume';
  const launcher = line.worker.launcher;
  const cwd = worktreeOf(e, t, st);
  try {
    ctx.db.tx(() => {
      if (resume) {
        // a fresh session: the old one still counts on the package
        linkSession(ctx, t.id, t.session_id, 'lucrator');
        ctx.db.run('UPDATE tasks SET session_id = NULL, terminal = NULL WHERE id = ?', t.id);
        t.session_id = null;
        t.terminal = null;
      }
      const prompt = resume ? RESUME_LINE(t.id) : LAUNCH_LINE(t.id);
      const r = launchWorker(ctx, {
        taskId: t.id, machineId: p.machine_id!, cwd, launcher, promptText: prompt, model: modelFor(p, line, 'worker'), permissionMode: line.worker.permissionMode,
        ...(launcher === 'claude' ? { maxBudgetUsd: HEADLESS_BUDGET_USD, limitMinutes: Math.round(line.worker.limitHours * 60) } : {}),
      }, LINE_ACTOR);
      Object.assign(st, { launcher, jobId: r.jobId, launchedAt: now, mark: eventMark(ctx), needLaunch: undefined, nudged: false, attempts: 0, retryAt: undefined, worktree: cwd });
      waitFor(e, st, "the worker's status line");
      persist(e, t, st, {
        stage: 'build',
        text: `${resume ? 'Worker started again from PROGRESS.md' : 'Worker launched'} (${launcher === 'hc' ? `herdr terminal bb-${t.id.toLowerCase()}` : 'claude -p'}, ${cwd}): it reads .factory/brief.md. Waits for its status line.`,
      });
    });
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    const attempts = st.attempts + 1;
    if (attempts >= 2) return attention(e, t, { ...st, attempts }, `the worker could not be launched twice: ${err.message}`, 'launch');
    Object.assign(st, { attempts, retryAt: now + 60_000 });
    waitFor(e, st, 'a new launch in a minute');
    return persist(e, t, st, { text: `The worker could not be launched (${err.message}). Trying again in a minute.` });
  }
  return true;
}

/** Delivers the pending message: hc send (once idle), or a new job resuming the headless worker's session. */
export function deliver(e: Env, t: TaskRow, st: LineState): boolean {
  const { ctx, p, line, now } = e;
  const tl = st.tell!;
  if (e.g.stopAll && !tl.pause) return setWait(e, t, st, 'governor: stop all; the message to the worker waits');
  if (st.launcher === 'claude') {
    if (st.jobId && jobAnswer(ctx, st.jobId).state === 'running') return false;
    const sid = workerSession(e, t, st);
    try {
      ctx.db.tx(() => {
        const jobId = createJob(ctx, {
          machineId: p.machine_id!, cwd: worktreeOf(e, t, st), promptText: sid ? tl.text : `${RESUME_LINE(t.id)}\n\n${tl.text}`, title: `${t.id}: ${t.title}`.slice(0, 200),
          options: {
            launcher: 'claude', taskId: t.id, model: modelFor(p, line, 'worker') ?? undefined, permissionMode: line.worker.permissionMode, maxBudgetUsd: HEADLESS_BUDGET_USD,
            limitMinutes: Math.round(line.worker.limitHours * 60), ...(sid ? { resumeSessionId: sid } : {}),
          },
        });
        Object.assign(st, { jobId, tell: undefined, mark: eventMark(ctx), retryAt: undefined });
        waitFor(e, st, "the worker's status line");
        persist(e, t, st, { text: `Told the worker ${tl.what} (a new turn of its session). Waits for its status line.` });
      });
    } catch (err) {
      if (!(err instanceof JobError)) throw err;
      return attention(e, t, st, `the message to the worker could not be sent: ${err.message}`, 'launch');
    }
    return true;
  }
  if (tl.hcId) {
    const row = ctx.db.get<{ status: string; error: string | null; created_at: number }>('SELECT status, error, created_at FROM hc_commands WHERE id = ?', tl.hcId);
    const h = row && row.status === 'queued' && now - row.created_at < RESEND_MS ? row : hcCommandStatus(ctx, tl.hcId);
    if (h.status === 'queued') return false;
    if (h.status === 'done') {
      Object.assign(st, { tell: undefined, mark: tl.mark, retryAt: undefined, ...(tl.pause ? { paused: true } : {}) });
      waitFor(e, st, tl.pause ? 'the governor (the worker was told to wait)' : "the worker's status line");
      return persist(e, t, st);
    }
    // not delivered: the worker is busy, or its terminal is gone
    if (t.session_id && sessionEnded(ctx, t.session_id)) return died(e, t, { ...st, tell: { ...tl, hcId: undefined } }, 'its session ended');
    Object.assign(st, { tell: { ...tl, hcId: undefined, tries: tl.tries + 1 }, retryAt: now + SEND_RETRY_MS });
    waitFor(e, st, `the worker, to take ${tl.what}`);
    return persist(e, t, st, tl.tries === 0 ? { text: `The worker could not take ${tl.what} yet (${cut(h.error ?? 'error', 200)}): trying again every 30 seconds.` } : {});
  }
  if (st.retryAt && now < st.retryAt) return false;
  ctx.db.tx(() => {
    const r = sendHcCommand(ctx, { op: 'send', taskId: t.id, text: tl.line ?? tl.text, ...(tl.ifIdle ? { if: 'idle' as const } : {}), ...(tl.files?.length ? { files: tl.files } : {}) }, LINE_ACTOR);
    Object.assign(st, { tell: { ...tl, hcId: r.id, mark: eventMark(ctx) }, retryAt: undefined });
    waitFor(e, st, `the worker, to take ${tl.what}`);
    persist(e, t, st, tl.tries === 0 ? { text: `Telling the worker ${tl.what}.` } : {});
  });
  return true;
}

type Turn = { kind: 'wait' } | { kind: 'dead'; why: string } | { kind: 'turn'; text: string };

/** The end of the worker's turn: its final message, or why it died. */
function readTurn(e: Env, t: TaskRow, st: LineState): Turn {
  const { ctx, now } = e;
  if (st.launcher === 'claude') {
    const a = st.jobId ? jobAnswer(ctx, st.jobId) : ({ state: 'missing' } as const);
    if (a.state === 'running') return { kind: 'wait' };
    if (a.state === 'missing') return { kind: 'dead', why: 'its job is gone' };
    if (a.text != null && (a.status === 'succeeded' || parseStatusLine(a.text))) return { kind: 'turn', text: a.text };
    return { kind: 'dead', why: `its job ${a.status}${a.reason ? ` (${a.reason})` : ''}` };
  }
  const sid = t.session_id;
  if (!sid) {
    const a = st.jobId ? jobAnswer(ctx, st.jobId) : ({ state: 'missing' } as const);
    if (a.state === 'ended' && a.status !== 'succeeded') return { kind: 'dead', why: `the launch ${a.status}${a.reason ? `: ${a.reason}` : ''}` };
    if (a.state === 'missing') return { kind: 'dead', why: 'its launch job is gone' };
    if (now - (st.launchedAt ?? now) > NO_SESSION_MS) return { kind: 'dead', why: 'no session reported 15 minutes after the launch (is the Buildyboy plugin installed there?)' };
    return { kind: 'wait' };
  }
  const stop = lastStop(ctx, sid, st.mark ?? 0);
  if (stop) return { kind: 'turn', text: stop.message };
  if (sessionEnded(ctx, sid)) return { kind: 'dead', why: 'its session ended' };
  return { kind: 'wait' };
}

/** Is the worker in the middle of a turn (stopAll pauses only those)? */
function inTurn(e: Env, t: TaskRow, st: LineState): boolean {
  return st.launcher === 'hc' && !!t.session_id && !sessionEnded(e.ctx, t.session_id) && !lastStop(e.ctx, t.session_id, st.mark ?? 0);
}

/** The `build` stage, one transition at most. */
export function build(e: Env, t: TaskRow, st: LineState): boolean {
  const { line, now } = e;
  if (!st.launcher || st.needLaunch) return launch(e, t, st);
  if (st.paused) {
    if (e.g.stopAll) return false;
    st.paused = false;
    st.tell = tellOf('to resume', RESUME_WORK);
    return persist(e, t, st, { text: 'The governor allows work again: telling the worker to resume.' });
  }
  if (st.tell) return deliver(e, t, st);
  if (e.g.stopAll && inTurn(e, t, st)) {
    st.tell = tellOf('to pause', PAUSE, { ifIdle: false, pause: true });
    return persist(e, t, st, { text: 'Governor: stop all. Telling the worker to commit, push, update PROGRESS.md and wait.' });
  }
  if (st.launchedAt && now - st.launchedAt > line.worker.limitHours * 3600_000) {
    return attention(e, t, st, `the worker is past its ${line.worker.limitHours} h limit`, 'limit');
  }
  const turn = readTurn(e, t, st);
  if (turn.kind === 'wait') return false;
  if (turn.kind === 'dead') return died(e, t, st, turn.why);
  const s = parseStatusLine(turn.text);
  if (s?.kind === 'done') return enterGates(e, t, st);
  if (s) return askAbout(e, t, st, s.kind, s.text);
  if (!st.nudged) {
    Object.assign(st, { nudged: true, tell: tellOf('to end with the status line', NUDGE) });
    return persist(e, t, st, { text: "The worker's turn ended without a status line: asking it once for one." });
  }
  return askAbout(e, t, st, 'nostatus', turn.text);
}

/** Its session or terminal ended without `done`: started again once, then it needs attention. */
export function died(e: Env, t: TaskRow, st: LineState, why: string): boolean {
  const restarts = (st.restarts ?? 0) + 1;
  if (restarts >= 2) return attention(e, t, { ...st, restarts }, `the worker stopped twice without finishing (${why})`, 'dead');
  Object.assign(st, { restarts, needLaunch: 'resume' as const });
  waitFor(e, st, 'a new worker');
  return persist(e, t, st, { text: `The worker ended without finishing (${why}): starting it again once, from PROGRESS.md.` });
}

/** A question, a block or a missing status line: the foreman when it is on, else the owner. */
export function askAbout(e: Env, t: TaskRow, st: LineState, kind: 'question' | 'blocked' | 'nostatus', text: string): boolean {
  const what =
    kind === 'question' ? `The worker asks: ${text}`
    : kind === 'blocked' ? `The worker says it is blocked: ${text}`
    : `The worker's turn ended twice without a status line. Its last message ended with:\n\n${text.trim().slice(-1500) || '(nothing)'}`;
  if (modelFor(e.p, e.line, 'foreman')) return askForeman(e, t, st, kind, what);
  if (kind === 'question') return askOwner(e, t, st, `${t.id}: the worker asks: ${cut(text, 3000)}`, what);
  return attention(e, t, st, kind === 'blocked' ? `the worker is blocked: ${cut(text, 500)}` : 'the worker ended twice without a status line', 'nostatus');
}

/** A free-text question for the owner; the answer goes to the worker. */
export function askOwner(e: Env, t: TaskRow, st: LineState, question: string, context: string, options: string[] = [], ask: 'question' | 'escalation' = 'question'): boolean {
  e.ctx.db.tx(() => {
    const d = askDecision(e.ctx, { taskId: t.id, question: cut(question, 4000), context: cut(context, 20_000), ...(options.length ? { options } : {}) }, LINE_ACTOR);
    Object.assign(st, { decisionId: d.id, ask });
    waitFor(e, st, "the owner's answer");
    persist(e, t, st, { text: `Asked the owner: ${cut(question, 300)}` });
  });
  return true;
}

export function askForeman(e: Env, t: TaskRow, st: LineState, kind: NonNullable<LineState['foremanAbout']>['kind'], what: string): boolean {
  if (e.g.stopAll) return setWait(e, t, st, 'governor: stop all; the foreman waits');
  try {
    e.ctx.db.tx(() => {
      const jobId = startForeman(e.ctx, t, e.p, e.line, what, st.worktree ?? null);
      Object.assign(st, { foremanJob: jobId, foremanAbout: { kind, what: cut(what, 6000) } });
      waitFor(e, st, 'the foreman');
      persist(e, t, st, { text: `${cut(what.split('\n')[0], 300)} Asked the foreman.` });
    });
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    return attention(e, t, st, `the foreman could not start (${err.message}): ${cut(what, 300)}`, kind === 'step' ? 'step' : 'foreman');
  }
  return true;
}

/** The foreman answered (or failed): apply it. */
export function foremanDone(e: Env, t: TaskRow, st: LineState): boolean {
  const r = foremanResult(e.ctx, t.id, st.foremanJob!);
  if (r.state === 'running') return false;
  const about = st.foremanAbout ?? { kind: 'attention' as const, what: st.what ?? 'the package is stuck' };
  Object.assign(st, { foremanJob: undefined, foremanAbout: undefined });
  const worker = about.kind !== 'step';
  if (r.state === 'failed') {
    if (about.kind === 'question') return askOwner(e, t, st, `${t.id}: ${cut(about.what, 3000)}`, `The foreman could not answer (${r.reason}).\n\n${about.what}`);
    return attention(e, t, st, `the foreman could not answer (${r.reason}): ${cut(about.what, 300)}`, worker ? 'foreman' : 'step');
  }
  const a = r.answer;
  switch (a.action) {
    case 'answer':
      if (!worker) return attention(e, t, st, `${cut(about.what, 300)} The foreman says: ${cut(a.message, 1000)}`, 'step');
      st.tell = tellOf("the foreman's answer", `The foreman answers: ${a.message}`);
      return persist(e, t, st, { text: `The foreman answered: ${cut(a.message, 400)}` });
    case 'retry':
      if (!worker) {
        Object.assign(st, { runId: undefined, attempts: 0, retryAt: undefined });
        waitFor(e, st, 'the step, again');
        return persist(e, t, st, { text: `The foreman says run it again: ${cut(a.message, 400)}` });
      }
      st.tell = tellOf("the foreman's advice", `Try again: ${a.message}`);
      return persist(e, t, st, { text: `The foreman says try again: ${cut(a.message, 400)}` });
    case 'escalate': {
      if (worker) st.tell = tellOf('to go on meanwhile', `${a.message}\n\n(The owner has been asked. Go on with what does not depend on the answer; it comes as another message.)`);
      const options = (a.options ?? []).filter((o) => o.trim()).slice(0, 4);
      return askOwner(e, t, st, `${t.id}: ${cut(a.question || about.what, 3000)}`, `${about.what}\n\n**The foreman:** ${a.message}`, options, 'escalation');
    }
    case 'block':
      Object.assign(st, { hold: true });
      waitFor(e, st, 'the owner (blocked by the foreman)');
      return persist(e, t, st, { status: 'blocata', note: `the foreman: ${cut(a.message, 2000)}`, text: `The foreman blocked it: ${cut(a.message, 400)}` });
  }
}

/** The option list of a needs-attention decision. */
export function attentionOptions(e: Env, why: string): string[] {
  return [...(why === 'g5off' ? [] : [LINE_ANSWERS.retry]), ...(modelFor(e.p, e.line, 'foreman') ? [LINE_ANSWERS.foreman] : []), LINE_ANSWERS.stop, LINE_ANSWERS.mine];
}
