// The conductor (SPEC §12.5) and the planner (§12.6), driven end to end against a temp server with a simulated runner:
// the fake runner captures every command (step runs, job launches, hc commands) and the test answers them the way the
// runner does (POST /api/runner/gates/:id, /api/runner/jobs/:id/events, /api/runner/hc/:id); the worker's hook events
// go in the real way (POST /api/ingest, POST /api/hook/Stop). Time is injected: tick(ctx, key, now).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { startServer, type RunningServer } from '../server/main.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { tick } from '../server/factory/line.ts';
import { parseStatusLine } from '../server/factory/worker.ts';
import { storeProjectLine } from '../server/factory/projects.ts';
import { resolveLine } from '../shared/line.ts';
import type { Ctx } from '../server/context.ts';

let srv: TestServer;
let live: { ctx: Ctx; url: string };
let web: WebClient;
let m: { id: string; token: string };
let tmp: string;
/** where the hook events say the sessions run: outside the worktrees, so no §5 checkout swallows them into one repo */
let hooks: string;
let deputy: string;
let offset = 0;
let restarted = false;
const sent: any[] = [];
const done = new Set<string>();

const now = () => Date.now() + offset;
const later = (ms: number) => {
  offset += ms;
};
const go = (key: string) => tick(live.ctx, key, now());
const db = () => live.ctx.db;
const connect = () => live.ctx.runners.set(m.id, (c) => sent.push(JSON.parse(JSON.stringify(c))));
const machinePost = (path: string, body: unknown) =>
  fetch(`${live.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ok = async (r: Promise<Response>) => {
  const res = await r;
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text;
};
const agent = async (tool: string, body: unknown = {}) => {
  const r = await fetch(`${live.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${deputy}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { result?: any; error?: string };
  if (!r.ok) throw new Error(`${tool} ${r.status} ${j.error}`);
  return j.result;
};

// ---------- the simulated runner ----------

/** Commands not answered yet, of a type (and a filter). */
const keyOf = (c: any) => (c.type === 'gate' ? c.run.id : c.type === 'job' ? c.job.id : c.id);
/** Commands not answered yet (a re-send of the same command counts once). */
const pending = (type: string, f: (c: any) => boolean = () => true) => {
  const seen = new Set<string>();
  return sent.filter((c) => c.type === type && !done.has(keyOf(c)) && f(c) && !seen.has(keyOf(c)) && !!seen.add(keyOf(c)));
};
/** The one pending step run of a package (throws when there is none, or two). */
function runOf(taskId: string, step?: string) {
  const ids = new Set(pending('gate', (c) => c.run.taskId === taskId && (!step || c.run.gate === step)).map((c) => c.run.id));
  if (ids.size !== 1) throw new Error(`${taskId}: expected one pending ${step ?? 'step'} run, found ${ids.size} (${[...ids].join(', ')}); stage ${task(taskId).stage}`);
  return sent.find((c) => c.type === 'gate' && c.run.id === [...ids][0]).run;
}
async function report(runId: string, rep: Record<string, unknown>) {
  done.add(runId);
  await ok(machinePost(`/api/runner/gates/${runId}`, rep));
}
const pass = (taskId: string, step: string, extra: Record<string, unknown> = {}) => report(runOf(taskId, step).id, { status: 'done', verdict: 'pass', summary: `${step} ok`, ...extra });
function jobOf(taskId: string | null, f: (j: any) => boolean = () => true) {
  const js = pending('job', (c) => (taskId === null || c.job.options?.taskId === taskId || c.job.options?.bbTask === taskId) && f(c.job));
  if (js.length !== 1) throw new Error(`expected one pending job for ${taskId}, found ${js.length}`);
  return js[0].job;
}
async function jobEvents(jobId: string, events: unknown[]) {
  done.add(jobId);
  await ok(machinePost(`/api/runner/jobs/${jobId}/events`, { events }));
}
/** A claude -p job that answers with structured output. */
const answerJob = (jobId: string, structured: unknown, sessionId = `s-${jobId.slice(0, 8)}`) =>
  jobEvents(jobId, [
    { type: 'status', status: 'running', sessionId },
    { type: 'output', lines: [JSON.stringify({ type: 'result', subtype: 'success', result: 'answered', structured_output: structured, session_id: sessionId })] },
    { type: 'status', status: 'succeeded', exitCode: 0, sessionId, result: { subtype: 'success' } },
  ]);
function hcOf(taskId: string, op?: 'send' | 'kill') {
  const hs = pending('hc', (c) => c.name === `bb-${taskId.toLowerCase()}` && (!op || c.op === op));
  if (hs.length !== 1) throw new Error(`expected one pending hc ${op ?? ''} for ${taskId}, found ${hs.length}`);
  return hs[0];
}
async function hcDone(id: string, status: 'done' | 'error' = 'done', error?: string) {
  done.add(id);
  await ok(machinePost(`/api/runner/hc/${id}`, status === 'done' ? { status, result: { sent: true } } : { status, error }));
}
const envelope = (event: Record<string, unknown>, env: Record<string, string> = {}) => ({ v: 1, ts: Date.now(), env, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 'test', event });
/** The worker's hc launch: the runner reports the terminal, the worker's SessionStart arrives from it. */
async function startWorker(taskId: string, sid = `w-${taskId}-${Math.random().toString(36).slice(2, 8)}`) {
  const job = jobOf(taskId);
  const terminal = `t-${sid}`;
  await jobEvents(job.id, [{ type: 'status', status: 'succeeded', exitCode: 0, result: { launcher: 'hc', terminal, name: `bb-${taskId.toLowerCase()}` } }]);
  await ok(machinePost('/api/ingest', envelope({ session_id: sid, cwd: hooks, hook_event_name: 'SessionStart', source: 'startup' }, { HC_TERMINAL_ID: terminal })));
  expect(task(taskId).session_id).toBe(sid);
  return { sid, job };
}
/** The worker's turn ends: the Stop hook, the real way (a control event). */
const stop = (sid: string, message: string) => ok(machinePost('/api/hook/Stop', envelope({ session_id: sid, cwd: hooks, hook_event_name: 'Stop', last_assistant_message: message })));
const sessionEnd = (sid: string) => ok(machinePost('/api/ingest', envelope({ session_id: sid, cwd: hooks, hook_event_name: 'SessionEnd', reason: 'other' })));

const task = (id: string) => db().get<any>('SELECT * FROM tasks WHERE id = ?', id)!;
const lineOf = (id: string) => JSON.parse(task(id).line_json ?? 'null');
const lineEvents = (id: string) => db().all<{ detail_json: string }>("SELECT detail_json FROM task_events WHERE task_id = ? AND kind = 'line' ORDER BY id", id).map((e) => JSON.parse(e.detail_json).text as string);
const pendingDecision = (id: string) => db().get<any>("SELECT * FROM decisions WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC", id);
const answer = (decisionId: string, a: string) => web.post(`/api/decisions/${decisionId}/answer`, { answer: a });

const LINE_FULL = { commands: { setup: 'npm ci', verify: 'npm test', acceptance: 'npm run acc', shots: 'npm run shots' }, resources: { ports: [7000, 7010], dbPrefix: 'db_' } };
const LINE_VERIFY = { commands: { verify: 'npm test' } };

async function project(key: string, raw: unknown = LINE_FULL, extra: Record<string, unknown> = {}) {
  await web.post('/api/factory/projects', { key, name: key, machineId: m.id, checkout: join(tmp, key), idPrefix: `${key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)}-`, ...extra });
  const r = resolveLine(raw, { checkoutDir: join(tmp, key) });
  if (!r.ok) throw new Error(r.errors.join('; '));
  storeProjectLine(live.ctx, key, r.line, null);
  await web.post(`/api/factory/projects/${key}/autopilot`, { on: true });
}
const pkg = async (key: string, id: string, extra: Record<string, unknown> = {}) =>
  (await web.post('/api/tasks', { project: key, id, title: `Package ${id}`, body: `Build ${id}.`, acceptance: [`${id} works`], status: 'gata', ...extra })).id as string;

/** From ready to the worker's first turn: claim and prepare, (QA,) the launch: one tick per hop. */
async function toWorker(key: string, id: string, qa = true) {
  go(key);
  await pass(id, 'prepare', { details: { worktree: join(tmp, `${key}-wt`, id) } });
  go(key);
  if (qa) {
    await pass(id, 'qa');
    go(key);
  }
  return startWorker(id);
}
/** The round's first gate runs already: every gate passes, then cleanup, and the package leaves the line. */
async function passGates(key: string, id: string, gates: string[]) {
  for (const g of gates) {
    await pass(id, g, g === 'G5' ? { details: { range: 'aaaaaaa..bbbbbbb' } } : {});
    go(key);
  }
  expect(task(id).status).toBe('integrata');
  expect(task(id).stage).toBe('cleanup');
  await pass(id, 'cleanup');
  go(key);
  expect(task(id).stage).toBeNull();
  expect(task(id).line_json).toBeNull();
}

beforeAll(async () => {
  srv = await startTestServer();
  live = srv;
  srv.ctx.notify = () => {};
  web = await srv.login();
  tmp = mkdtempSync(join(tmpdir(), 'bb-conductor-'));
  hooks = mkdtempSync(join(tmpdir(), 'bb-conductor-hooks-'));
  m = createMachine(srv.ctx, 'linebox', { platform: process.platform });
  db().run('UPDATE machines SET runner_info_json = ? WHERE id = ?', JSON.stringify({ version: '0.2.0', concurrency: 20 }), m.id);
  db().setSetting('governor_max_age_min', 1_000_000);
  const resets = Math.floor(Date.now() / 1000) + 30 * 86400;
  await ok(machinePost('/api/ingest', envelope({ session_id: 'usage', cwd: hooks, hook_event_name: 'SessionStart' })));
  await ok(machinePost('/api/statusline', { session_id: 'usage', rate_limits: { five_hour: { used_percentage: 10, resets_at: resets }, seven_day: { used_percentage: 20, resets_at: resets } } }));
  const d = createAgentToken(srv.ctx, 'deputy');
  deputy = d.token;
  await web.put(`/api/agent-tokens/${d.id}`, { operator: true });
  connect();
});
afterAll(async () => {
  if (!restarted) await srv.stop();
  else rmSync(srv.dataDir, { recursive: true, force: true });
  try {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(hooks, { recursive: true, force: true });
  } catch {
    // Windows may hold files briefly
  }
});

describe('the status line', () => {
  it('is the last FACTORY-STATUS line, in any case, with trailing text, inside fences or Markdown', () => {
    expect(parseStatusLine('All checks pass.\nFACTORY-STATUS: done')).toEqual({ kind: 'done' });
    expect(parseStatusLine('factory-status: Done.')).toEqual({ kind: 'done' });
    expect(parseStatusLine('FACTORY-STATUS: done (all green, 12 tests)')).toEqual({ kind: 'done' });
    expect(parseStatusLine('Summary\n\n```\nFACTORY-STATUS: done\n```')).toEqual({ kind: 'done' });
    expect(parseStatusLine('**FACTORY-STATUS: question** Should archived customers count?')).toEqual({ kind: 'question', text: 'Should archived customers count?' });
    expect(parseStatusLine('`FACTORY-STATUS: blocked the database is down`')).toEqual({ kind: 'blocked', text: 'the database is down' });
    expect(parseStatusLine('> FACTORY-STATUS: question: which port?\n')).toEqual({ kind: 'question', text: 'which port?' });
    // the last one wins
    expect(parseStatusLine('FACTORY-STATUS: question x\nmore work\nFACTORY-STATUS: done')).toEqual({ kind: 'done' });
    expect(parseStatusLine('FACTORY-STATUS: question')).toEqual({ kind: 'question', text: '(no text given)' });
    // missing, or not a status
    expect(parseStatusLine('I am done.')).toBeNull();
    expect(parseStatusLine('')).toBeNull();
    expect(parseStatusLine(null)).toBeNull();
    expect(parseStatusLine('FACTORY-STATUS: finished')).toBeNull();
    expect(parseStatusLine('FACTORY-STATUS: doneish')).toBeNull();
  });
});

describe('the line', () => {
  it('drives a package through every gate: claim, prepare with the brief, QA, the worker, G1–G5, integration, cleanup', async () => {
    await project('happy');
    const id = await pkg('happy', 'P1');
    expect(go('happy')).toMatchObject({ moved: 1, held: null });
    let t = task(id);
    expect(t).toMatchObject({ status: 'in_lucru', stage: 'prepare', res_port: 7000 });
    const prep = runOf(id, 'prepare');
    const files = Object.fromEntries(prep.files.map((f: any) => [f.path, f.content]));
    expect(Object.keys(files).sort()).toEqual(['brief.md', 'package.md']);
    expect(files['brief.md']).toMatch(/^# Task/);
    expect(files['brief.md']).toContain('Goal: Build package HAPPY-P1');
    expect(files['brief.md']).toContain('`npm test` passes');
    expect(files['brief.md']).toContain('Branch: current');
    expect(files['brief.md']).toContain('Unattended: yes');
    expect(files['brief.md']).toContain('## Factory rules for this package');
    expect(files['brief.md']).toContain('FACTORY-STATUS: done');
    expect(files['brief.md']).not.toMatch(/\{(acceptanceRule|resources|checks|protected|context)\}/);
    expect(files['package.md']).toContain('1. P1 works');
    expect(files['package.md']).toContain('port 7000');
    // saved in the prompt library with the package recorded on it
    expect(t.prompt_id).toEqual(expect.any(Number));
    expect(db().get<any>('SELECT rendered FROM prompts WHERE id = ?', t.prompt_id).rendered).toBe(files['brief.md']);

    // idempotent: ticking again sends nothing new while prepare runs
    const before = sent.length;
    expect(go('happy').moved).toBe(0);
    expect(go('happy').moved).toBe(0);
    expect(sent.length).toBe(before + 0);

    await pass(id, 'prepare', { details: { worktree: join(tmp, 'happy-wt', id) } });
    go('happy');
    expect(task(id).stage).toBe('qa');
    await pass(id, 'qa');
    go('happy');
    expect(task(id).stage).toBe('build');
    const job = jobOf(id);
    expect(job.promptText).toBe(`Read .factory/brief.md and follow it: it is your task, package ${id} of the Buildyboy factory.`);
    expect(job.cwd).toBe(join(tmp, 'happy-wt', id));
    expect(job.options).toMatchObject({ launcher: 'hc', taskId: id, permissionMode: 'auto', model: 'opus' });
    expect(go('happy').moved).toBe(0); // the launch is in flight: no second worker
    const { sid } = await startWorker(id);
    expect(go('happy').moved).toBe(0); // no turn has ended
    await stop(sid, 'Implemented the export.\n\nFACTORY-STATUS: done');
    go('happy');
    t = task(id);
    expect(t).toMatchObject({ status: 'la_porti', stage: 'G1', round: 1 });
    await passGates('happy', id, ['G1', 'G2', 'G3', 'G4', 'G5']);
    t = task(id);
    expect(t.integrated_at).toEqual(expect.any(Number));
    // the history says what happened, in order
    const ev = lineEvents(id);
    expect(ev[0]).toMatch(/^Claimed \(port 7000, db db_happy_p1\): prepare started/);
    expect(ev.some((e) => /^The worker says done: round 1 of the gates starts with G1/.test(e))).toBe(true);
    expect(ev.some((e) => /^G5 pass: integrated/.test(e))).toBe(true);
    expect(ev[ev.length - 1]).toMatch(/^Cleaned up/);
    // the package page shows them
    const detail = await web.get(`/api/tasks/${id}`);
    expect(detail.events.filter((e: any) => e.kind === 'line').length).toBe(ev.length);
  });

  it('runs a line with only verify: no QA, G1, G3 and G5', async () => {
    await project('lean', LINE_VERIFY);
    const id = await pkg('lean', 'V1');
    const { sid } = await toWorker('lean', id, false);
    expect(sent.some((c) => c.type === 'gate' && c.run.taskId === id && c.run.gate === 'qa')).toBe(false);
    await stop(sid, 'FACTORY-STATUS: done');
    go('lean');
    expect(task(id).stage).toBe('G1');
    await passGates('lean', id, ['G1', 'G3', 'G5']);
    expect(sent.filter((c) => c.type === 'gate' && c.run.taskId === id).map((c) => c.run.gate)).toEqual(['prepare', 'G1', 'G3', 'G5', 'cleanup']);
  });

  it('sends a failed gate back to the worker as a findings file, and the next round passes', async () => {
    await project('fix', LINE_VERIFY);
    const id = await pkg('fix', 'F1');
    const { sid } = await toWorker('fix', id, false);
    await stop(sid, 'FACTORY-STATUS: done');
    go('fix');
    await report(runOf(id, 'G1').id, {
      status: 'done', verdict: 'fail', summary: '2 tests failed',
      findings: [
        { severity: 'blocker', title: 'Export crashes on empty month', file: 'src/export.ts', line: 12, detail: 'TypeError on []', fix: 'return an empty PDF' },
        { severity: 'minor', title: 'Naming' },
      ],
    });
    go('fix');
    expect(task(id)).toMatchObject({ status: 'in_lucru', stage: 'build', round: 1 });
    const h = hcOf(id, 'send');
    expect(h.if).toBe('idle');
    expect(h.text).toMatch(/^Read \.factory\/inbox\/G1-round-1\.md: G1 failed in round 1/);
    expect(h.files).toHaveLength(1);
    const file = h.files[0];
    expect(file.path).toBe('inbox/G1-round-1.md');
    expect(file.content).toContain('# G1 failed: round 1 of 3');
    expect(file.content).toContain('[blocker] Export crashes on empty month');
    expect(file.content).toContain('`src/export.ts:12`');
    expect(file.content).toContain('What happens: TypeError on []');
    expect(file.content).toContain('Fix: return an empty PDF');
    expect(file.content.indexOf('Optional')).toBeGreaterThan(file.content.indexOf('Must fix'));
    expect(go('fix').moved).toBe(0); // the send is in flight
    await hcDone(h.id);
    go('fix');
    expect(lineOf(id).tell).toBeUndefined();
    // an old Stop does not count: only a turn after the message
    expect(go('fix').moved).toBe(0);
    await stop(sid, 'Fixed it.\nFACTORY-STATUS: done');
    go('fix');
    expect(task(id)).toMatchObject({ status: 'la_porti', stage: 'G1', round: 2 });
    await passGates('fix', id, ['G1', 'G3', 'G5']);
  });

  it('tries a message again while the worker is busy', async () => {
    await project('busy', LINE_VERIFY);
    const id = await pkg('busy', 'B1');
    const { sid } = await toWorker('busy', id, false);
    await stop(sid, 'FACTORY-STATUS: done');
    go('busy');
    await report(runOf(id, 'G1').id, { status: 'done', verdict: 'fail', summary: 'red' });
    go('busy');
    await hcDone(hcOf(id, 'send').id, 'error', 'terminal is working, not idle');
    go('busy');
    expect(lineOf(id).retryAt).toEqual(expect.any(Number));
    expect(go('busy').moved).toBe(0);
    expect(pending('hc', (c) => c.name === 'bb-b1')).toHaveLength(0);
    later(31_000);
    go('busy');
    expect(hcOf(id, 'send').text).toMatch(/G1-round-1/);
  });
});

describe('the round limit', () => {
  async function failLastRound(key: string, id: string, gate = 'G1') {
    const { sid } = await toWorker(key, id, false);
    await stop(sid, 'FACTORY-STATUS: done');
    go(key);
    for (const g of ['G1', 'G3']) {
      if (g === gate) break;
      await pass(id, g);
      go(key);
    }
    await report(runOf(id, gate).id, { status: 'done', verdict: 'fail', summary: `${gate} red`, findings: [{ severity: 'major', title: 'Wrong total' }] });
    go(key);
    const t = task(id);
    expect(t.status).toBe('blocata');
    const d = pendingDecision(id);
    expect(d.asked_by).toBe('factory:rounds');
    expect(lineOf(id)).toMatchObject({ ask: 'rounds', decisionId: d.id });
    expect(go(key).moved).toBe(0);
    return { sid, d };
  }

  it('acts on each answer of the round-limit decision', async () => {
    await project('rounds', LINE_VERIFY, { config: { limits: { rounds: 1 } } });
    // one more round
    const a = await pkg('rounds', 'R1');
    const r1 = await failLastRound('rounds', a);
    await answer(r1.d.id, 'Încă o rundă');
    go('rounds');
    expect(task(a)).toMatchObject({ status: 'in_lucru', stage: 'build', extra_rounds: 1 });
    expect(hcOf(a, 'send').files[0].path).toBe('inbox/G1-round-1.md');
    await hcDone(hcOf(a, 'send').id);
    go('rounds');
    await stop(r1.sid, 'FACTORY-STATUS: done');
    go('rounds');
    expect(task(a)).toMatchObject({ status: 'la_porti', round: 2, stage: 'G1' });

    // one more round, only for G3: G3 and G5 run, G1 does not
    const b = await pkg('rounds', 'R2');
    const r2 = await failLastRound('rounds', b, 'G3');
    expect(JSON.parse(r2.d.options_json)).toContain('Încă o rundă, doar pentru G3');
    await answer(r2.d.id, 'Încă o rundă, doar pentru G3');
    go('rounds');
    expect(lineOf(b).only).toBe('G3');
    await hcDone(hcOf(b, 'send').id);
    go('rounds');
    await stop(r2.sid, 'FACTORY-STATUS: done');
    go('rounds');
    expect(task(b).stage).toBe('G3');
    await passGates('rounds', b, ['G3', 'G5']);

    // stop the package
    const c = await pkg('rounds', 'R3');
    const r3 = await failLastRound('rounds', c);
    await agent('decision_answer', { id: r3.d.id, answer: 'Oprește pachetul' }); // an operator answers like the owner
    go('rounds');
    expect(lineOf(c).stop).toMatchObject({ phase: 'tell' });
    go('rounds');
    expect(hcOf(c, 'send').text).toMatch(/^The owner stopped this package/);
    await hcDone(hcOf(c, 'send').id);
    await stop(r3.sid, 'Committed and pushed. Stopping.');
    go('rounds');
    await hcDone(hcOf(c, 'kill').id);
    go('rounds');
    expect(task(c).status).toBe('blocata');
    expect(lineOf(c)).toMatchObject({ hold: true });
    expect(go('rounds').moved).toBe(0);
  });
});

describe('the foreman', () => {
  it('answers a worker question; escalates another to the owner, whose answer reaches the worker', async () => {
    await project('ask', LINE_VERIFY);
    const id = await pkg('ask', 'Q1');
    const { sid } = await toWorker('ask', id, false);
    await stop(sid, 'Half done.\nFACTORY-STATUS: question Should the export include archived customers?');
    go('ask');
    const f = jobOf(id, (j) => j.options.outputSchema === 'foreman');
    expect(f.cwd).toBe(join(tmp, 'ask'));
    expect(f.options).toMatchObject({ role: 'coordonator', bbTask: id, permissionMode: 'dontAsk', launcher: 'claude', maxTurns: 30 });
    expect(f.options.allowedTools).not.toContain('Edit');
    expect(f.promptText).toContain('Should the export include archived customers?');
    expect(f.promptText).toContain('You are the foreman');
    expect(lineOf(id).waiting).toBe('the foreman');
    await answerJob(f.id, { action: 'answer', message: 'Only active customers: the spec says "current customers".' }, 'foreman-1');
    go('ask');
    // the foreman's session counts on the package as coordonator
    expect(db().get<any>('SELECT role FROM task_sessions WHERE task_id = ? AND session_id = ?', id, 'foreman-1')).toMatchObject({ role: 'coordonator' });
    go('ask');
    expect(hcOf(id, 'send').text).toMatch(/^The foreman answers: Only active customers/);
    await hcDone(hcOf(id, 'send').id);
    go('ask');

    await stop(sid, 'FACTORY-STATUS: question May I drop the legacy CSV export?');
    go('ask');
    await answerJob(jobOf(id, (j) => j.options.outputSchema === 'foreman').id, {
      action: 'escalate', message: 'Keep the CSV export for now.', question: 'Drop the legacy CSV export?', options: ['Keep it', 'Drop it'],
    });
    go('ask');
    const d = pendingDecision(id);
    expect(d).toMatchObject({ asked_by: 'factory:line', question: `${id}: Drop the legacy CSV export?` });
    expect(JSON.parse(d.options_json)).toEqual(['Keep it', 'Drop it']);
    // meanwhile the worker goes on with what does not depend on it
    go('ask');
    expect(hcOf(id, 'send').text).toMatch(/Keep the CSV export for now/);
    await hcDone(hcOf(id, 'send').id);
    go('ask');
    await stop(sid, 'Did the rest.\nFACTORY-STATUS: done');
    expect(go('ask').moved).toBe(0); // its turn waits for the owner's answer
    await answer(d.id, 'Drop it');
    go('ask');
    go('ask');
    expect(hcOf(id, 'send').text).toMatch(/The owner answered "ASK-Q1: Drop the legacy CSV export\?": Drop it/);
    await hcDone(hcOf(id, 'send').id);
    go('ask');
    await stop(sid, 'Dropped it.\nFACTORY-STATUS: done');
    go('ask');
    expect(task(id).status).toBe('la_porti');
  });

  it('with the foreman off: no status line gets one nudge, then the owner is asked', async () => {
    await project('quiet', LINE_VERIFY, { config: { models: { foreman: null } } });
    const id = await pkg('quiet', 'N1');
    const { sid } = await toWorker('quiet', id, false);
    await stop(sid, 'I think it works.');
    go('quiet');
    go('quiet');
    expect(hcOf(id, 'send').text).toMatch(/did not end with the factory status line/);
    await hcDone(hcOf(id, 'send').id);
    go('quiet');
    await stop(sid, 'It works, really.');
    go('quiet');
    const d = pendingDecision(id);
    expect(d.question).toMatch(/needs attention: the worker ended twice without a status line/);
    expect(JSON.parse(d.options_json)).toEqual(['Retry', 'Stop the package', "I'll take it from here"]); // no foreman to ask
    expect(sent.some((c) => c.type === 'job' && c.job.options.outputSchema === 'foreman' && c.job.options.bbTask === id)).toBe(false);
    // Retry asks again for the status line
    await answer(d.id, 'Retry');
    go('quiet');
    go('quiet');
    expect(hcOf(id, 'send').text).toMatch(/status line/);
  });

  it('a question with the foreman off goes to the owner as free text', async () => {
    await project('owner', LINE_VERIFY, { config: { models: { foreman: null } } });
    const id = await pkg('owner', 'O1');
    const { sid } = await toWorker('owner', id, false);
    await stop(sid, 'FACTORY-STATUS: question Which currency?');
    go('owner');
    const d = pendingDecision(id);
    expect(d.question).toBe(`${id}: the worker asks: Which currency?`);
    expect(d.options_json).toBeNull();
    await answer(d.id, 'EUR');
    go('owner');
    go('owner');
    expect(hcOf(id, 'send').text).toMatch(/: EUR$/);
  });
});

describe('workers that die and steps that fail', () => {
  it('starts a worker again once from PROGRESS.md, and asks the second time', async () => {
    await project('dies', LINE_VERIFY);
    const id = await pkg('dies', 'D1');
    const w1 = await toWorker('dies', id, false);
    await sessionEnd(w1.sid);
    go('dies');
    expect(lineOf(id)).toMatchObject({ restarts: 1, needLaunch: 'resume' });
    go('dies');
    const j2 = jobOf(id);
    expect(j2.promptText).toMatch(/PROGRESS\.md/);
    expect(task(id).session_id).toBeNull();
    // the dead session still counts on the package
    expect(db().get<any>('SELECT role FROM task_sessions WHERE task_id = ? AND session_id = ?', id, w1.sid)).toMatchObject({ role: 'lucrator' });
    const w2 = await startWorker(id);
    await sessionEnd(w2.sid);
    go('dies');
    const d = pendingDecision(id);
    expect(d.question).toMatch(/the worker stopped twice without finishing/);
    expect(JSON.parse(d.options_json)).toEqual(['Retry', 'Ask the foreman', 'Stop the package', "I'll take it from here"]);
    await answer(d.id, 'Retry');
    go('dies');
    go('dies');
    expect(jobOf(id).promptText).toMatch(/PROGRESS\.md/);
  });

  it('a headless worker: its job result carries the status line; findings go as a job that resumes its session', async () => {
    await project('headless', { ...LINE_VERIFY, worker: { launcher: 'claude', limitHours: 2 } });
    const id = await pkg('headless', 'J1');
    go('headless');
    await pass(id, 'prepare', { details: { worktree: join(tmp, 'headless-wt', id) } });
    go('headless');
    const job = jobOf(id);
    expect(job.options).toMatchObject({ launcher: 'claude', taskId: id, maxBudgetUsd: 30, limitMinutes: 120 });
    const long = `${'Worked a lot. '.repeat(400)}\nFACTORY-STATUS: done`; // longer than the 4000 characters result_json keeps
    await jobEvents(job.id, [
      { type: 'status', status: 'running', sessionId: 'headless-session-1' },
      { type: 'output', lines: [JSON.stringify({ type: 'result', subtype: 'success', result: long, session_id: 'headless-session-1' })] },
      { type: 'status', status: 'succeeded', exitCode: 0, sessionId: 'headless-session-1', result: { subtype: 'success', result: long.slice(0, 4000) } },
    ]);
    go('headless');
    expect(task(id)).toMatchObject({ status: 'la_porti', stage: 'G1', session_id: 'headless-session-1' });
    await report(runOf(id, 'G1').id, { status: 'done', verdict: 'fail', summary: 'red', findings: [{ severity: 'major', title: 'Totals off by one' }] });
    go('headless');
    const next = jobOf(id);
    expect(next.options).toMatchObject({ resumeSessionId: 'headless-session-1', launcher: 'claude' });
    expect(next.promptText).toMatch(/^# G1 failed: round 1/);
    expect(next.promptText).toContain('[major] Totals off by one');
    expect(pending('hc', (c) => c.name === 'bb-headless-j1')).toHaveLength(0);
    await answerJob(next.id, null, 'headless-session-1');
    go('headless');
    // its turn ended without a status line: the nudge resumes it too
    go('headless');
    expect(jobOf(id).promptText).toMatch(/did not end with the factory status line/);
  });

  it('a worker past worker.limitHours needs attention; Retry gives it another stint', async () => {
    await project('slow', { ...LINE_VERIFY, worker: { limitHours: 1 } });
    const id = await pkg('slow', 'T1');
    await toWorker('slow', id, false);
    later(30 * 60_000);
    expect(go('slow').moved).toBe(0);
    later(31 * 60_000);
    go('slow');
    const d = pendingDecision(id);
    expect(d.question).toBe(`${id} needs attention: the worker is past its 1 h limit`);
    await answer(d.id, 'Retry');
    go('slow');
    expect(go('slow').moved).toBe(0);
    expect(lineOf(id).waiting).toBe("the worker's status line");
  });

  it('retries a step error once after a minute, then asks; each answer does what it says', async () => {
    await project('errs', LINE_VERIFY);
    const id = await pkg('errs', 'E1');
    go('errs');
    await report(runOf(id, 'prepare').id, { status: 'error', error: 'git fetch failed' });
    go('errs');
    expect(lineOf(id)).toMatchObject({ attempts: 1, retryAt: expect.any(Number) });
    expect(go('errs').moved).toBe(0);
    expect(pending('gate', (c) => c.run.taskId === id)).toHaveLength(0);
    later(61_000);
    go('errs');
    await report(runOf(id, 'prepare').id, { status: 'error', error: 'git fetch failed again' });
    go('errs');
    let d = pendingDecision(id);
    expect(d.question).toBe(`${id} needs attention: prepare could not run twice: git fetch failed again`);
    // Retry: the step runs again
    await answer(d.id, 'Retry');
    go('errs');
    go('errs');
    await report(runOf(id, 'prepare').id, { status: 'done', verdict: 'fail', summary: 'npm ci failed' });
    go('errs');
    d = pendingDecision(id);
    expect(d.question).toMatch(/prepare failed: npm ci failed/);
    // Ask the foreman: it says retry, and the step runs again
    await answer(d.id, 'Ask the foreman');
    go('errs');
    await answerJob(jobOf(id, (j) => j.options.outputSchema === 'foreman').id, { action: 'retry', message: 'a flaky registry' });
    go('errs');
    go('errs');
    await report(runOf(id, 'prepare').id, { status: 'done', verdict: 'fail', summary: 'npm ci failed' });
    go('errs');
    // I'll take it from here: left alone until moved by hand
    await answer(pendingDecision(id).id, "I'll take it from here");
    go('errs');
    expect(lineOf(id)).toMatchObject({ hold: true });
    const n = sent.length;
    later(3600_000);
    expect(go('errs').moved).toBe(0);
    expect(sent.length).toBe(n);
    // moved by hand to la_porti: picked up at the gates
    await web.put(`/api/tasks/${id}`, { status: 'la_porti' });
    go('errs');
    expect(task(id).stage).toBe('G1');
    go('errs');
    expect(runOf(id, 'G1')).toBeTruthy();

    // Stop the package from an attention decision
    const id2 = await pkg('errs', 'E2');
    go('errs');
    await report(runOf(id2, 'prepare').id, { status: 'done', verdict: 'fail', summary: 'no space' });
    go('errs');
    await answer(pendingDecision(id2).id, 'Stop the package');
    go('errs');
    go('errs');
    expect(task(id2).status).toBe('blocata');
  });
});

describe('integration', () => {
  it('asks before integrating a sensitive package, and before integrating protected paths', async () => {
    await project('gate5', LINE_VERIFY);
    const id = await pkg('gate5', 'S1', { sensitive: true });
    const { sid } = await toWorker('gate5', id, false);
    await stop(sid, 'FACTORY-STATUS: done');
    go('gate5');
    await pass(id, 'G1');
    go('gate5');
    await pass(id, 'G3');
    go('gate5');
    let d = pendingDecision(id);
    expect(d.question).toBe(`Integrate ${id} into main?`);
    expect(JSON.parse(d.options_json)).toEqual(['Integrate', 'Stop the package', "I'll take it from here"]);
    expect(pending('gate', (c) => c.run.taskId === id)).toHaveLength(0);
    await answer(d.id, 'Integrate');
    go('gate5');
    go('gate5');
    await report(runOf(id, 'G5').id, { status: 'error', error: 'needs approval: factory.json, tests/acceptance/P9/a.test.ts' });
    go('gate5');
    d = pendingDecision(id);
    expect(d.question).toMatch(/changes protected paths: factory\.json/);
    expect(JSON.parse(d.options_json)).toEqual(['Integrate with these changes', 'Undo them first', 'Stop the package', "I'll take it from here"]);
    await answer(d.id, 'Integrate with these changes');
    go('gate5');
    go('gate5');
    const g5 = runOf(id, 'G5');
    expect(g5.args).toEqual(['--allow-protected']);
    await report(g5.id, { status: 'done', verdict: 'pass', summary: 'merged', details: { range: '1111111..2222222' } });
    go('gate5');
    expect(task(id).status).toBe('integrata');

    // Undo them first: back to the worker
    const id2 = await pkg('gate5', 'S2');
    const w = await toWorker('gate5', id2, false);
    await stop(w.sid, 'FACTORY-STATUS: done');
    for (const g of ['G1', 'G3']) {
      go('gate5');
      await pass(id2, g);
    }
    go('gate5');
    await report(runOf(id2, 'G5').id, { status: 'error', error: 'needs approval: factory.json' });
    go('gate5');
    await answer(pendingDecision(id2).id, 'Undo them first');
    go('gate5');
    expect(task(id2)).toMatchObject({ status: 'in_lucru', stage: 'build' });
    go('gate5');
    expect(hcOf(id2, 'send').text).toMatch(/G5 refused to integrate: the branch changes protected paths \(factory\.json\)/);
  });
});

describe('controls', () => {
  it('stop: the worker commits and stops, its terminal is closed, the package is blocked and the request acknowledged', async () => {
    await project('ctl', LINE_VERIFY);
    const id = await pkg('ctl', 'C1');
    const { sid } = await toWorker('ctl', id, false);
    await web.post(`/api/tasks/${id}/control`, { kind: 'stop', note: 'wrong approach' });
    go('ctl');
    go('ctl');
    const h = hcOf(id, 'send');
    expect(h.text).toMatch(/^The owner stopped this package \(wrong approach\)\. Commit your work, push your branch/);
    expect(h.if).toBeUndefined();
    await hcDone(h.id);
    expect(go('ctl').moved).toBe(0); // it gets time to commit
    await stop(sid, 'Pushed.');
    go('ctl');
    await hcDone(hcOf(id, 'kill').id);
    go('ctl');
    expect(task(id).status).toBe('blocata');
    expect(db().get<any>('SELECT status FROM control_requests WHERE task_id = ?', id).status).toBe('acked');
  });

  it('revert: the G5 range is reverted and the package goes back to backlog', async () => {
    await project('rev', LINE_VERIFY);
    const id = await pkg('rev', 'V1');
    const { sid } = await toWorker('rev', id, false);
    await stop(sid, 'FACTORY-STATUS: done');
    go('rev');
    await passGates('rev', id, ['G1', 'G3', 'G5']);
    await web.post(`/api/tasks/${id}/control`, { kind: 'revert', note: 'broke prod' });
    go('rev');
    expect(task(id).stage).toBe('revert');
    go('rev');
    const run = runOf(id, 'revert');
    expect(run.args).toEqual(['aaaaaaa..bbbbbbb']);
    await report(run.id, { status: 'done', verdict: 'pass', summary: 'reverted aaaaaaa..bbbbbbb' });
    go('rev');
    expect(task(id)).toMatchObject({ status: 'backlog', stage: null, line_json: null });
    expect(db().get<any>('SELECT status FROM control_requests WHERE task_id = ?', id).status).toBe('acked');

    // a revert of a package never integrated: nothing to do, acknowledged with the reason
    const id2 = await pkg('rev', 'V2', { status: 'backlog' });
    await web.post(`/api/tasks/${id2}/control`, { kind: 'revert' });
    go('rev');
    expect(lineEvents(id2)).toEqual(['Revert requested, but no integration of this package is known: nothing to revert.']);
  });
});

describe('the governor', () => {
  const usage = (five: number, seven: number) => {
    const resets = Math.floor(Date.now() / 1000) + 30 * 86400;
    return ok(machinePost('/api/statusline', { session_id: 'usage', rate_limits: { five_hour: { used_percentage: five, resets_at: resets }, seven_day: { used_percentage: seven, resets_at: resets } } }));
  };

  it('canStart false: nothing is claimed and no worker launched, packages in flight go on', async () => {
    await project('gov', LINE_VERIFY);
    const a = await pkg('gov', 'G1X');
    go('gov');
    await usage(90, 20);
    await pass(a, 'prepare');
    const b = await pkg('gov', 'G2X');
    expect(go('gov').held).toMatch(/^governor: no new work/);
    expect(task(b).status).toBe('gata');
    expect(task(a).stage).toBe('build');
    go('gov');
    expect(pending('job', (c) => c.job.options.taskId === a)).toHaveLength(0);
    expect(lineOf(a).waiting).toBe('governor: no new worker now');
    expect((await web.get('/api/factory/projects/gov')).autopilotHeld).toMatch(/^governor: no new work/);
    await usage(10, 20);
    go('gov');
    expect(jobOf(a)).toBeTruthy();
  });

  it('stopAll: no step that spends tokens; workers are told once to pause, then to resume', async () => {
    await project('halt', LINE_FULL);
    const id = await pkg('halt', 'H1');
    go('halt');
    await usage(10, 85);
    await pass(id, 'prepare');
    go('halt');
    expect(task(id).stage).toBe('qa');
    go('halt');
    expect(pending('gate', (c) => c.run.taskId === id)).toHaveLength(0);
    expect(lineOf(id).waiting).toBe('governor: stop all (QA spends tokens)');
    await usage(10, 20);
    go('halt');
    await pass(id, 'qa');
    go('halt');
    await startWorker(id);
    await usage(10, 85);
    go('halt');
    go('halt');
    const p = hcOf(id, 'send');
    expect(p.text).toMatch(/^The factory is pausing/);
    expect(p.if).toBeUndefined();
    await hcDone(p.id);
    go('halt');
    expect(lineOf(id).paused).toBe(true);
    expect(go('halt').moved).toBe(0); // told once
    await usage(10, 20);
    go('halt');
    go('halt');
    expect(hcOf(id, 'send').text).toMatch(/^The factory resumes/);
  });
});

describe('who the conductor drives', () => {
  it('holds a paused project, leaves autopilot-off projects alone, and picks up a package moved by hand', async () => {
    await project('hand', LINE_VERIFY);
    const id = await pkg('hand', 'K1');
    await web.post('/api/factory/projects/hand/pause');
    expect(go('hand')).toMatchObject({ moved: 0, held: 'the project is paused' });
    expect(task(id).status).toBe('gata');
    await web.post('/api/factory/projects/hand/resume');
    await web.post('/api/factory/projects/hand/autopilot', { on: false });
    expect(go('hand')).toMatchObject({ moved: 0, held: 'autopilot is off' });
    await web.post('/api/factory/projects/hand/autopilot', { on: true });
    go('hand');
    expect(task(id).stage).toBe('prepare');
    // the owner moves it back to gata: it leaves the line (and is claimed again on a later tick)
    await web.put(`/api/tasks/${id}`, { status: 'gata' });
    go('hand');
    expect(task(id)).toMatchObject({ status: 'gata', stage: null, line_json: null });
    expect(lineEvents(id).at(-1)).toBe('Moved to gata (was in_lucru): off the line.');
    // a package claimed by a coordinator before autopilot: picked up and prepared
    await web.post('/api/factory/projects/hand/autopilot', { on: false });
    const id2 = await pkg('hand', 'K2');
    await agent('tasks_claim', { id: id2, force: true });
    await web.post('/api/factory/projects/hand/autopilot', { on: true });
    go('hand');
    expect(task(id2).stage).toBe('prepare');
    expect(lineEvents(id2)[0]).toMatch(/^Picked up in progress: it was never prepared/);
  });

  it('keeps to limits.workers, per project', async () => {
    await project('lim', LINE_VERIFY, { config: { limits: { workers: 1 } } });
    await project('lim2', LINE_VERIFY);
    const a = await pkg('lim', 'L1');
    const b = await pkg('lim', 'L2');
    const c = await pkg('lim2', 'L3');
    const d = await pkg('lim2', 'L4');
    const e = await pkg('lim2', 'L5');
    go('lim');
    go('lim2');
    expect([a, b].map((x) => task(x).status)).toEqual(['in_lucru', 'gata']);
    expect([c, d, e].map((x) => task(x).status)).toEqual(['in_lucru', 'in_lucru', 'gata']);
    // the first one leaves the line: the next starts
    await web.put(`/api/tasks/${a}`, { status: 'backlog' });
    go('lim');
    go('lim');
    expect(task(b).status).toBe('in_lucru');
  });

  it('says why it holds: runner offline or too old, the line unknown, invalid or a recipe', async () => {
    await project('held', LINE_VERIFY);
    await pkg('held', 'X1');
    live.ctx.runners.delete(m.id);
    try {
      expect(go('held').held).toMatch(/runner on linebox is offline/);
      const status = await agent('factory_status', { project: 'held' });
      expect(status.alerts).toContain('autopilot held: held (runner offline)');
    } finally {
      connect();
    }
    db().run('UPDATE machines SET runner_info_json = ? WHERE id = ?', JSON.stringify({ version: '0.1.9', concurrency: 20 }), m.id);
    try {
      expect(go('held').held).toMatch(/is 0\.1\.9; the line's built-in steps need 0\.2\.0/);
      expect((await agent('machines_list')).find((x: any) => x.id === m.id).runnerVersion).toBe('0.1.9');
    } finally {
      db().run('UPDATE machines SET runner_info_json = ? WHERE id = ?', JSON.stringify({ version: '0.2.0', concurrency: 20 }), m.id);
    }
    db().run("UPDATE factory_projects SET line_error = 'gates.G1: enabled, but there is no commands.verify' WHERE key = 'held'");
    expect(go('held').held).toMatch(/does not resolve: gates\.G1/);
    db().run("UPDATE factory_projects SET line_error = NULL, line_json = NULL WHERE key = 'held'");
    expect(go('held').held).toMatch(/the line is not known yet/);
    expect(pending('line', (c) => c.project === 'held')).toHaveLength(1); // it asked the runner, once
    go('held');
    expect(pending('line', (c) => c.project === 'held')).toHaveLength(1);
    // arond's recipe line: argv steps only, no kit: never driven
    const legacy = resolveLine({ timeoutSec: 600, gates: { G1: { steps: [{ argv: ['node', 'g1.js'] }] } } }, { checkoutDir: tmp });
    storeProjectLine(live.ctx, 'held', legacy.ok ? legacy.line : null, null);
    expect(go('held').held).toMatch(/this line has no built-in steps/);
    expect(task('HELD-X1').status).toBe('gata');
    expect((await web.get('/api/factory/projects/held')).autopilotHeld).toMatch(/no built-in steps/);
  });
});

describe('the planner', () => {
  const plan = {
    summary: 'Two packages: the export and its page.',
    packages: [
      { localId: 'P2', title: 'Export page', body: '## Scope\nThe page.', acceptance: ['the page lists months'], dependsOn: ['P1'], sensitive: false, priority: 40 },
      { localId: 'P1', title: 'Monthly PDF export', body: '## Scope\nThe export.', acceptance: ['one PDF per month'], dependsOn: [], sensitive: true, priority: 60 },
    ],
    questions: ['Assumed: A4 paper.'],
  };

  it('turns a goal into backlog packages and a decision: Approve makes them ready', async () => {
    await project('plan', LINE_VERIFY);
    await web.post('/api/factory/projects/plan/autopilot', { on: false });
    const pv = await agent('plan_request', { project: 'plan', goal: 'Monthly invoice PDFs', notes: 'No new dependencies.' });
    expect(pv).toMatchObject({ status: 'running', project: 'plan', goal: 'Monthly invoice PDFs' });
    const job = jobOf(null, (j) => j.id === pv.jobId);
    expect(job.options).toMatchObject({ outputSchema: 'plan', role: 'coordonator', permissionMode: 'dontAsk' });
    expect(job.promptText).toContain('**Goal:** Monthly invoice PDFs');
    expect(job.promptText).toContain('No new dependencies.');
    expect(go('plan').moved).toBe(0);
    await answerJob(job.id, plan);
    go('plan');
    const rows = db().all<any>('SELECT id, status, plan_id, priority, sensitive FROM tasks WHERE plan_id = ? ORDER BY id', pv.id);
    expect(rows.map((r) => [r.id, r.status])).toEqual([['PLAN-P1', 'backlog'], ['PLAN-P2', 'backlog']]);
    expect(db().get<any>("SELECT depends_on FROM task_deps WHERE task_id = 'PLAN-P2'").depends_on).toBe('PLAN-P1');
    const d = db().get<any>("SELECT * FROM decisions WHERE asked_by = 'factory:plan' AND status = 'pending'");
    expect(JSON.parse(d.options_json)).toEqual(['Approve', 'Discard']);
    expect(d.context).toContain('Two packages');
    const detail = await web.get('/api/factory/projects/plan');
    expect(detail.decisions.map((x: any) => x.id)).toContain(d.id);
    expect(detail.plans[0]).toMatchObject({ id: pv.id, status: 'proposed', packages: ['PLAN-P1', 'PLAN-P2'] });
    expect((await agent('decisions_list', { project: 'plan', status: 'pending' })).find((x: any) => x.id === d.id)).toMatchObject({ kind: 'plan', project: 'plan' });
    await answer(d.id, 'Approve');
    go('plan');
    expect(db().all<any>('SELECT status FROM tasks WHERE plan_id = ?', pv.id).map((r) => r.status)).toEqual(['gata', 'gata']);
    expect((await web.get('/api/factory/projects/plan')).plans[0].status).toBe('approved');
  });

  it('Discard deletes the untouched packages and keeps the edited ones; an empty plan asks the questions', async () => {
    const pv = await web.post('/api/factory/projects/plan/plan', { goal: 'Second goal' });
    await answerJob(jobOf(null, (j) => j.id === pv.jobId).id, { ...plan, packages: plan.packages.map((p) => ({ ...p, localId: `${p.localId}x`, dependsOn: p.dependsOn.map((d) => `${d}x`) })) });
    go('plan');
    const ids = db().all<any>('SELECT id FROM tasks WHERE plan_id = ? ORDER BY id', pv.id).map((r) => r.id);
    expect(ids).toEqual(['PLAN-P1x', 'PLAN-P2x']);
    await web.put('/api/tasks/PLAN-P2x', { title: 'Export page, edited' });
    await answer(db().get<any>("SELECT id FROM decisions WHERE asked_by = 'factory:plan' AND status = 'pending'").id, 'Discard');
    go('plan');
    expect(db().all<any>('SELECT id FROM tasks WHERE plan_id = ?', pv.id).map((r) => r.id)).toEqual(['PLAN-P2x']);

    // nothing to plan: the owner gets the questions; an answer plans again with it
    const vague = await agent('plan_request', { project: 'plan', goal: 'Make it better' });
    await answerJob(jobOf(null, (j) => j.id === vague.jobId).id, { summary: '', packages: [], questions: ['Better how: faster, or prettier?'] });
    go('plan');
    const q = db().get<any>("SELECT * FROM decisions WHERE asked_by = 'factory:plan' AND status = 'pending'");
    expect(q.question).toBe('The plan for plan failed: Make it better');
    expect(q.context).toContain('Better how: faster, or prettier?');
    await answer(q.id, 'Faster: the export takes 40 s');
    go('plan');
    const again = jobOf(null, (j) => j.options.outputSchema === 'plan');
    expect(again.promptText).toContain('Faster: the export takes 40 s');
    // a failed job says why
    await jobEvents(again.id, [{ type: 'status', status: 'failed', exitCode: 1, result: { reason: 'budget' } }]);
    go('plan');
    expect((await web.get('/api/factory/projects/plan')).plans[0]).toMatchObject({ status: 'failed', error: 'its job failed (budget)' });
    // refusals
    await expect(web.post('/api/factory/projects/plan/plan', { goal: '' })).rejects.toThrow(/400/);
    await web.post('/api/factory/projects', { key: 'bare', name: 'bare' });
    await expect(web.post('/api/factory/projects/bare/plan', { goal: 'Something' })).rejects.toThrow(/400 .*machine/);
  });
});

describe('restart safety', () => {
  it('a new server process on the same database continues without sending anything twice', async () => {
    await project('again', LINE_VERIFY);
    const id = await pkg('again', 'A1');
    const { sid } = await toWorker('again', id, false);
    await stop(sid, 'FACTORY-STATUS: done');
    go('again');
    const g1 = runOf(id, 'G1');
    const count = sent.filter((c) => c.type === 'gate' && c.run.taskId === id).length;
    // a new process: same database, a fresh context (no in-memory state survives)
    await srv.close();
    restarted = true;
    const next: RunningServer = await startServer({ port: 0, dataDir: srv.dataDir }, { quiet: true, background: false });
    live = next;
    try {
      next.ctx.notify = () => {};
      connect();
      web = await (async () => {
        const res = await fetch(`${next.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery' }) });
        const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
        const csrf = cookies.find((c) => c.startsWith('bb_csrf='))!.slice('bb_csrf='.length);
        const headers = { cookie: cookies.join('; '), 'x-bb-csrf': csrf, 'content-type': 'application/json' };
        const call = async (method: string, path: string, body?: unknown) => {
          const r = await fetch(`${next.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
          const text = await r.text();
          if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
          return text ? JSON.parse(text) : null;
        };
        return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}), put: (p: string, b?: unknown) => call('PUT', p, b ?? {}), del: (p: string) => call('DELETE', p), text: async () => '' } as WebClient;
      })();
      go('again');
      go('again');
      // only the re-send of the run still queued, never a new run
      const runs = sent.filter((c) => c.type === 'gate' && c.run.taskId === id);
      expect(new Set(runs.map((c) => c.run.id)).size).toBe(count);
      expect(runs.at(-1).run.id).toBe(g1.id);
      await pass(id, 'G1');
      go('again');
      expect(task(id).stage).toBe('G3');
    } finally {
      await next.close();
    }
  });
});
