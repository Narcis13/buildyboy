// The conductor's questions and the owner's levers (SPEC §12.5): needs-attention, integration approval and the
// protected-paths refusal of G5 (decisions asked by `factory:line` with fixed English options, matched exactly when
// answered, by the owner or an operator), the round-limit decision of §11.7 (`factory:rounds`), and the controls
// (`stop`: tell the worker to commit, push and stop, then `hc kill`, `blocata`; `revert`: step revert, back to `backlog`).
import { sendToRunner } from '../jobs/core.ts';
import { GATES, LINE_ANSWERS, ROUND_ANSWERS, type GateRunView } from '../../shared/factory.ts';
import { findingsMessage } from './brief.ts';
import { answerDecision, askDecision, getDecision } from './decisions.ts';
import { gateRunView } from './gateruns.ts';
import { hcCommandStatus, sendHcCommand } from './hc.ts';
import {
  cut, fresh, gateSeq, LINE_ACTOR, norm, persist, STOP_GRACE_MS, waitFor, type Env, type LineState, type Tell, type Why,
} from './line-state.ts';
import { askForeman, attentionOptions, deliver, NUDGE, STOP_WORK, tellOf } from './line-worker.ts';
import { onward } from './line.ts';
import { projectConfig } from './projects.ts';
import { ackControls, FactoryError, taskEvent, taskSummary, type TaskRow } from './tasks.ts';
import { eventMark, jobAnswer, lastStop, sessionEnded } from './worker.ts';

const A = LINE_ANSWERS;

const RETRY_TEXT: Record<Why, (e: Env, t: TaskRow) => string> = {
  step: (_e, t) => `${t.stage ?? 'the step'} runs again`,
  revert: () => 'the revert runs again',
  dead: () => 'a new worker starts from PROGRESS.md',
  launch: () => 'the worker is launched again',
  limit: (e) => `the worker gets another ${e.line.worker.limitHours} h`,
  nostatus: () => 'the worker is asked again for its status line',
  foreman: () => 'the worker is asked again for its status line',
  enter: () => 'the move to the gates is tried again',
  g5off: () => '',
};

/** Needs attention: one decision tied to the package with what happened and the options that apply. */
export function attention(e: Env, t: TaskRow, st: LineState, what: string, why: Why): boolean {
  const options = attentionOptions(e, why);
  const context = [
    `**${t.title}** · stage ${t.stage ?? '—'} · round ${t.round}`,
    '',
    what,
    '',
    ...(options.includes(A.retry) ? [`- **${A.retry}**: ${RETRY_TEXT[why](e, t)}.`] : []),
    ...(options.includes(A.foreman) ? [`- **${A.foreman}**: the foreman looks at it and answers, retries, or asks you a sharper question.`] : []),
    `- **${A.stop}**: the worker commits, pushes and stops; the package becomes blocata.`,
    `- **${A.mine}**: the conductor leaves this package alone until you move it to another status.`,
  ].join('\n');
  e.ctx.db.tx(() => {
    const d = askDecision(e.ctx, { taskId: t.id, question: cut(`${t.id} needs attention: ${what}`, 4000), context, options }, LINE_ACTOR);
    Object.assign(st, { decisionId: d.id, ask: 'attention', why, what: cut(what, 2000), runId: undefined, retryAt: undefined });
    waitFor(e, st, 'decision: needs attention');
    persist(e, t, st, { text: `Needs attention: ${cut(what, 400)}. Asked the owner.` });
  });
  return true;
}

/** integrate.approval (the project's override, else the line's): ask before G5? */
export function needsApproval(e: Env, t: TaskRow): string | null {
  const a = projectConfig(e.p).integrate?.approval ?? e.line.integrate.approval;
  return a === 'always' || (a === 'sensitive' && t.sensitive) ? a : null;
}

export function askApproval(e: Env, t: TaskRow, st: LineState, approval: string): boolean {
  const base = e.line.base;
  e.ctx.db.tx(() => {
    const d = askDecision(e.ctx, {
      taskId: t.id,
      question: `Integrate ${t.id} into ${base}?`,
      context: [
        `**${t.title}**${t.sensitive ? ' (sensitive)' : ''}: every gate before G5 passed in round ${t.round}. The line asks you first (integrate.approval: ${approval}).`,
        '',
        `- **${A.integrate}**: G5 merges ${base} into the branch, runs G1 and G2 again, fast-forwards ${base} and pushes.`,
        `- **${A.stop}**: the worker commits, pushes and stops; the package becomes blocata.`,
        `- **${A.mine}**: the conductor leaves it to you.`,
      ].join('\n'),
      options: [A.integrate, A.stop, A.mine],
    }, LINE_ACTOR);
    Object.assign(st, { decisionId: d.id, ask: 'approval' });
    waitFor(e, st, 'decision: integrate?');
    persist(e, t, st, { text: `Every gate passed: asked the owner before integrating (integrate.approval: ${approval}).` });
  });
  return true;
}

/** G5 refused: protected paths changed (`needs approval: …`). */
export function askProtected(e: Env, t: TaskRow, st: LineState, error: string): boolean {
  const paths = error.replace(/^needs approval:\s*/i, '').trim();
  e.ctx.db.tx(() => {
    const d = askDecision(e.ctx, {
      taskId: t.id,
      question: cut(`${t.id} changes protected paths: ${paths}. Integrate anyway?`, 4000),
      context: [
        `G5 refused to integrate **${t.title}**: the branch changes ${paths}, which the line protects (the line file, acceptance tests, paths.protected).`,
        '',
        `- **${A.integrateProtected}**: G5 runs again and integrates them.`,
        `- **${A.undoProtected}**: back to the worker, to undo those changes.`,
        `- **${A.stop}** · **${A.mine}**.`,
      ].join('\n'),
      options: [A.integrateProtected, A.undoProtected, A.stop, A.mine],
    }, LINE_ACTOR);
    Object.assign(st, { decisionId: d.id, ask: 'protected', what: cut(paths, 2000), runId: undefined, attempts: 0 });
    waitFor(e, st, 'decision: protected paths');
    persist(e, t, st, { text: `G5 refused: protected paths changed (${cut(paths, 300)}). Asked the owner.` });
  });
  return true;
}

/** The last failed gate run of the package (its findings go back to the worker). */
export function lastFailedRun(e: Env, taskId: string): GateRunView | null {
  const r = e.ctx.db.get<{ id: string }>(
    "SELECT id FROM gate_runs WHERE task_id = ? AND status = 'done' AND verdict = 'fail' AND gate IN ('G1','G2','G3','G4','G5') ORDER BY finished_at DESC, created_at DESC LIMIT 1", taskId,
  );
  return r ? gateRunView(e.ctx, r.id) : null;
}

export function findingsTell(e: Env, t: TaskRow, run: GateRunView): Tell {
  const m = findingsMessage(t, run.gate, run.round, taskSummary(e.ctx, t.id).maxRounds, run.summary ?? '', run.findings, e.line, e.p);
  return tellOf(`the ${run.gate} findings`, m.text, { line: m.line, files: [m.file] });
}

/** Back to the worker (`in_lucru`, stage build) with a message. */
export function toBuild(e: Env, t: TaskRow, st: LineState, tell: Tell, text: string, o: { only?: LineState['only']; note?: string } = {}): boolean {
  const next = fresh(e, t, `the worker, to take ${tell.what}`, {
    worktree: st.worktree, launcher: st.launcher, jobId: st.jobId, launchedAt: st.launchedAt, mark: st.mark, restarts: st.restarts, lastFail: st.lastFail, tell, only: o.only,
  });
  persist(e, t, next, { stage: 'build', status: 'in_lucru', note: o.note, text });
  return onward(e, t, next);
}

/** The worker said done: a new round (§11.7) and the first gate. */
export function enterGates(e: Env, t: TaskRow, st: LineState): boolean {
  const first = gateSeq(e.line, st)[0];
  if (!first) return attention(e, t, st, 'no gate is on in this line, so the conductor cannot integrate it', 'g5off');
  const next = fresh(e, t, `${first} run`, { worktree: st.worktree, launcher: st.launcher, jobId: st.jobId, launchedAt: st.launchedAt, mark: st.mark, restarts: st.restarts, only: st.only });
  const round = t.round + 1;
  try {
    persist(e, t, next, { stage: first, status: 'la_porti', note: 'the worker says done', text: `The worker says done: round ${round} of the gates starts with ${first}.` });
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    return attention(e, t, st, `it cannot go to the gates: ${err.message}`, 'enter');
  }
  return onward(e, t, next);
}

/** Leaves the package alone until its status changes by hand. */
function mine(e: Env, t: TaskRow, st: LineState, text: string): boolean {
  st.hold = true;
  waitFor(e, st, 'the owner, by hand');
  return persist(e, t, st, { text });
}

function retry(e: Env, t: TaskRow, st: LineState, by: string): boolean {
  const why = st.why ?? 'step';
  const say = `${by}: ${A.retry}. ${RETRY_TEXT[why](e, t)}.`;
  switch (why) {
    case 'step':
    case 'revert':
      Object.assign(st, { runId: undefined, attempts: 0, retryAt: undefined });
      waitFor(e, st, `${t.stage ?? 'the step'}, again`);
      return persist(e, t, st, { text: say });
    case 'dead':
    case 'launch':
      Object.assign(st, { needLaunch: st.launcher ? 'resume' : 'first', restarts: 0, attempts: 0, retryAt: undefined });
      waitFor(e, st, 'a new worker');
      return persist(e, t, st, { text: say });
    case 'limit':
      st.launchedAt = e.now;
      waitFor(e, st, "the worker's status line");
      return persist(e, t, st, { text: say });
    case 'nostatus':
    case 'foreman':
      Object.assign(st, { nudged: true, tell: tellOf('to end with the status line', NUDGE) });
      return persist(e, t, st, { text: say });
    case 'enter':
      return enterGates(e, t, st);
    case 'g5off':
      return mine(e, t, st, `${by}: the conductor leaves it to the owner.`);
  }
}

/** A decision the conductor waits on: apply its answer once there is one. */
export function decided(e: Env, t: TaskRow, st: LineState): boolean {
  const d = getDecision(e.ctx, st.decisionId!);
  const ask = st.ask;
  // the worker gets the interim message while the owner thinks; a message in flight lands before the answer is applied
  if ((ask === 'escalation' || ask === 'question') && st.tell && st.launcher && (d?.status === 'pending' || st.tell.hcId)) return deliver(e, t, st);
  if (d?.status === 'pending') return false;
  Object.assign(st, { decisionId: undefined, ask: undefined });
  const by = d?.answeredBy && d.answeredBy !== 'web' ? d.answeredBy : 'The owner';
  if (!d || d.status === 'cancelled') return mine(e, t, st, 'The question was withdrawn: the conductor leaves the package alone until its status changes.');
  const answer = (d.answer ?? '').trim();
  const a = norm(answer);
  const is = (o: string) => a === norm(o);
  if (is(A.stop) && ask !== 'question' && ask !== 'escalation') return startStop(e, t, st, undefined, `${by} answered ${A.stop}`);
  if (is(A.mine) && ask !== 'question' && ask !== 'escalation') return mine(e, t, st, `${by}: "${A.mine}". The conductor leaves ${t.id} alone until its status changes.`);
  switch (ask) {
    case 'attention':
      if (is(A.retry)) return retry(e, t, st, by);
      if (is(A.foreman)) return askForeman(e, t, st, st.why === 'step' || st.why === 'revert' ? 'step' : 'attention', st.what ?? 'the package needs attention');
      // anything else is an instruction for the worker, when there is one
      if (st.launcher && t.stage === 'build') {
        st.tell = tellOf("the owner's instruction", `The owner says: ${answer}`);
        return persist(e, t, st, { text: `${by} answered "${cut(answer, 200)}": telling the worker.` });
      }
      return retry(e, t, st, by);
    case 'approval':
      if (is(A.integrate)) {
        Object.assign(st, { approved: true, attempts: 0 });
        waitFor(e, st, 'G5 run');
        return persist(e, t, st, { text: `${by} approved the integration: G5 starts.` });
      }
      return mine(e, t, st, `${by} answered "${cut(answer, 200)}" to the integration: the conductor leaves it to the owner.`);
    case 'protected':
      if (is(A.integrateProtected)) {
        Object.assign(st, { allowProtected: true, attempts: 0 });
        waitFor(e, st, 'G5 run');
        return persist(e, t, st, { text: `${by} approved the protected changes: G5 runs again with --allow-protected.` });
      }
      if (is(A.undoProtected)) {
        const tell = tellOf('to undo the protected changes', `G5 refused to integrate: the branch changes protected paths (${st.what ?? 'see G5'}). Undo those changes (they need the owner's approval), run the checks, commit and push, then end your final message with FACTORY-STATUS: done.`);
        return toBuild(e, t, st, tell, `${by}: undo the protected changes first. Back to the worker.`);
      }
      return mine(e, t, st, `${by} answered "${cut(answer, 200)}" about the protected paths: the conductor leaves it to the owner.`);
    case 'rounds': {
      const only = a.startsWith(norm(ROUND_ANSWERS.onlyFor)) ? GATES.find((g) => a.endsWith(g.toLowerCase())) : undefined;
      if (is(ROUND_ANSWERS.more) || only) {
        const run = lastFailedRun(e, t.id);
        const tell = run ? findingsTell(e, t, run) : tellOf('to go on', 'Another round of gates was allowed. Fix what the gates found, run the checks, push, then end with the FACTORY-STATUS line.');
        return toBuild(e, t, st, tell, `${by} allowed one more round${only ? ` for ${only} only` : ''}: back to the worker with the findings.`, { only, note: `one more round${only ? ` (${only})` : ''}: ${by}` });
      }
      if (is(ROUND_ANSWERS.stop)) return startStop(e, t, st, undefined, `${by} answered ${ROUND_ANSWERS.stop}`);
      return mine(e, t, st, `${by} answered "${cut(answer, 200)}" to the round limit: the conductor leaves it to the owner.`);
    }
    case 'question':
    case 'escalation':
    default: {
      if (!st.launcher || t.stage !== 'build') return retry(e, t, { ...st, why: st.why ?? 'step' }, by);
      st.tell = tellOf("the owner's answer", `The owner answered${d.question ? ` "${cut(d.question, 300)}"` : ''}: ${answer}`);
      return persist(e, t, st, { text: `${by} answered: ${cut(answer, 300)}. Telling the worker.` });
    }
  }
}

// ---------- controls ----------

/** Starts the stop: the worker commits, pushes and stops; its terminal is closed; the package becomes blocata. */
export function startStop(e: Env, t: TaskRow, st: LineState | null, controlId: number | undefined, note: string | null | undefined): boolean {
  const s = st ?? fresh(e, t, 'stopping');
  if (s.decisionId && getDecision(e.ctx, s.decisionId)?.status === 'pending') answerDecision(e.ctx, s.decisionId, null, LINE_ACTOR);
  Object.assign(s, { decisionId: undefined, ask: undefined, foremanJob: undefined, hold: false, stop: { phase: 'tell', at: e.now, mark: 0, controlId, note: note ?? null } });
  waitFor(e, s, 'stopping');
  return persist(e, t, s, { text: `Stop${note ? ` (${cut(note, 300)})` : ''}: the worker commits, pushes and stops, then the package is blocked.` });
}

/** One step of a stop in progress. */
export function stopping(e: Env, t: TaskRow, st: LineState): boolean {
  const { ctx, p, now } = e;
  const s = st.stop!;
  const live = st.launcher === 'hc' && !!t.session_id && !sessionEnded(ctx, t.session_id);
  try {
    if (s.phase === 'tell') {
      if (live) {
        ctx.db.tx(() => {
          const r = sendHcCommand(ctx, { op: 'send', taskId: t.id, text: STOP_WORK(s.note) }, LINE_ACTOR);
          st.stop = { ...s, phase: 'told', hcId: r.id, mark: eventMark(ctx), at: now };
          waitFor(e, st, 'the worker, to commit and stop');
          persist(e, t, st, { text: 'Told the worker to commit, push, update PROGRESS.md and stop.' });
        });
        return true;
      }
      if (st.launcher === 'claude' && st.jobId && jobAnswer(ctx, st.jobId).state === 'running') sendToRunner(ctx, p.machine_id!, { type: 'stop', jobId: st.jobId });
      if (st.launcher === 'hc' && t.terminal) return kill(e, t, st);
      return finishStop(e, t, st);
    }
    if (s.phase === 'told') {
      const over = !t.session_id || sessionEnded(ctx, t.session_id) || !!lastStop(ctx, t.session_id, s.mark) || now - s.at > STOP_GRACE_MS;
      return over ? kill(e, t, st) : false;
    }
    if (s.hcId && hcCommandStatus(ctx, s.hcId).status === 'queued') return false;
    return finishStop(e, t, st);
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    return finishStop(e, t, st, err.message);
  }
}

function kill(e: Env, t: TaskRow, st: LineState): boolean {
  e.ctx.db.tx(() => {
    const r = sendHcCommand(e.ctx, { op: 'kill', taskId: t.id }, LINE_ACTOR);
    st.stop = { ...st.stop!, phase: 'kill', hcId: r.id };
    waitFor(e, st, "the worker's terminal to close");
    persist(e, t, st, { text: `Closing the worker's terminal bb-${t.id.toLowerCase()}.` });
  });
  return true;
}

function finishStop(e: Env, t: TaskRow, st: LineState, problem?: string): boolean {
  const s = st.stop!;
  e.ctx.db.tx(() => {
    Object.assign(st, { stop: undefined, hold: true, tell: undefined, runId: undefined });
    waitFor(e, st, 'the owner (stopped)');
    persist(e, t, st, {
      status: t.status === 'integrata' ? undefined : 'blocata',
      note: `stopped${s.note ? `: ${cut(s.note, 500)}` : ''}`,
      text: `Stopped${problem ? ` (${cut(problem, 200)})` : ''}: the package is blocked until it is moved by hand.`,
    });
    if (s.controlId) ackControls(e.ctx, [s.controlId], LINE_ACTOR);
  });
  return true;
}

/** Was the package integrated by a G5 the server knows the range of? */
const integrated = (e: Env, taskId: string) =>
  !!e.ctx.db.get("SELECT 1 FROM gate_runs WHERE task_id = ? AND gate = 'G5' AND status = 'done' AND verdict = 'pass' AND details_json LIKE '%\"range\"%'", taskId);

/** An open stop or revert request (§11.5) on a package the conductor drives. */
export function control(e: Env, t: TaskRow, st: LineState | null, ctl: { id: number; kind: 'stop' | 'revert'; note: string | null }): boolean {
  if (ctl.kind === 'stop') {
    if (t.status === 'integrata') {
      e.ctx.db.tx(() => {
        ackControls(e.ctx, [ctl.id], LINE_ACTOR);
        taskEvent(e.ctx, t.id, LINE_ACTOR, 'line', null, null, { text: 'Stop requested, but the package is already integrated: nothing to stop (ask for a revert instead).' });
      });
      e.ctx.bus.publish('tasks', 'changed', { id: t.id });
      return true;
    }
    return startStop(e, t, st, ctl.id, ctl.note);
  }
  if (!integrated(e, t.id)) {
    e.ctx.db.tx(() => {
      ackControls(e.ctx, [ctl.id], LINE_ACTOR);
      taskEvent(e.ctx, t.id, LINE_ACTOR, 'line', null, null, { text: 'Revert requested, but no integration of this package is known: nothing to revert.' });
    });
    e.ctx.bus.publish('tasks', 'changed', { id: t.id });
    return true;
  }
  const s = st ?? fresh(e, t, 'revert run');
  if (s.decisionId && getDecision(e.ctx, s.decisionId)?.status === 'pending') answerDecision(e.ctx, s.decisionId, null, LINE_ACTOR);
  const next = fresh(e, t, 'revert run', { worktree: s.worktree });
  return persist(e, t, next, { stage: 'revert', text: `Revert requested${ctl.note ? ` (${cut(ctl.note, 300)})` : ''}: the integration is reverted on ${e.line.base}, then the package goes back to backlog.` });
}
