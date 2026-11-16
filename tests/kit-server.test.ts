// The server side of the kit (SPEC §12.3, §12.4): steps_run, the resolved line a prepare reports, resources and rounds from
// the line, the runner-version gate, G3's earlier findings, revert's range, files under .factory/, checked hc commands and
// the line refresh. A fake runner connection is just ctx.runners.set(machineId, fn). Never touches ~/.buildyboy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { startStepRun } from '../server/factory/gateruns.ts';
import { hcCommandStatus, sendHcCommand } from '../server/factory/hc.ts';
import { storeProjectLine } from '../server/factory/projects.ts';
import { FactoryError } from '../server/factory/tasks.ts';
import { resolveLine } from '../shared/line.ts';

let srv: TestServer;
let web: WebClient;
let token: string;
let m1: { id: string; token: string };
let m2: { id: string; token: string };
let tmp: string;

const agent = async (tool: string, body: unknown = {}) => {
  const r = await fetch(`${srv.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { result?: any; error?: string };
  if (!r.ok) throw new Error(`${tool} ${r.status} ${j.error}`);
  return j.result;
};
const post = (m: { token: string }, path: string, body: unknown) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const machinePost = (path: string, body: unknown) => post(m1, path, body);

const storedCommand = (runId: string) => JSON.parse(srv.ctx.db.get<{ command_json: string }>('SELECT command_json FROM gate_runs WHERE id = ?', runId)!.command_json);
const lineOf = (raw: unknown, file = 'factory.json') => {
  const r = resolveLine(raw, { checkoutDir: 'C:/x/co', file });
  if (!r.ok) throw new Error(`line does not resolve: ${r.errors.join('; ')}`);
  return r.line;
};
const setVersion = (machineId: string, version: string | null) =>
  srv.ctx.db.run('UPDATE machines SET runner_info_json = ? WHERE id = ?', version ? JSON.stringify({ version }) : null, machineId);
const project = (key: string, extra: Record<string, unknown> = {}, machineId = m1.id) =>
  web.post('/api/factory/projects', { key, name: key, machineId, checkout: join(tmp, key), lineFile: 'factory.json', ...extra });
const task = (proj: string, id: string, extra: Record<string, unknown> = {}) => agent('tasks_create', { project: proj, id, title: `Task ${id}`, status: 'gata', ...extra });
const claim = (id: string) => agent('tasks_claim', { id, force: true });
/** the commands a fake runner on the machine received */
function fakeRunner(machineId: string): unknown[] {
  const captured: unknown[] = [];
  srv.ctx.runners.set(machineId, (cmd) => captured.push(cmd));
  return captured;
}
const offline = (machineId: string) => srv.ctx.runners.delete(machineId);

beforeAll(async () => {
  srv = await startTestServer();
  srv.ctx.notify = () => {};
  web = await srv.login();
  token = createAgentToken(srv.ctx, 'coordinator').token;
  m1 = createMachine(srv.ctx, 'kitbox', { platform: process.platform });
  m2 = createMachine(srv.ctx, 'otherbox', { platform: process.platform });
  tmp = mkdtempSync(join(tmpdir(), 'bb-kit-'));
});
afterAll(async () => {
  await srv.stop();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold files briefly
  }
});

describe('steps_run', () => {
  it('queues a prepare for an offline runner with the package, its resources and the recipe; a connected runner gets the stored command', async () => {
    await project('ks', {
      idPrefix: 'KS-',
      config: { legacy: { portFrom: 7100, portTo: 7101, dbPrefix: 'ks_', migrationFrom: 10, migrationBlock: 5 } },
    });
    const t = await task('ks', 'P1', { body: 'The body', acceptance: ['one', 'two'], sensitive: true });
    expect(t).toMatchObject({ id: 'KS-P1', localId: 'P1' });
    await claim('KS-P1');
    await agent('tasks_update', { id: 'KS-P1', branch: 'pkg/KS-P1' });

    offline(m1.id);
    const res = await agent('steps_run', { taskId: 'KS-P1', step: 'prepare' });
    expect(res).toMatchObject({ runId: expect.any(String), step: 'prepare', status: 'queued', sent: false, note: expect.any(String), machineId: m1.id });
    const cmd = storedCommand(res.runId);
    expect(cmd.type).toBe('gate');
    expect(cmd.run).toMatchObject({
      id: res.runId, taskId: 'KS-P1', gate: 'prepare', project: 'ks', recipe: 'factory.json', checkout: join(tmp, 'ks'),
      task: { id: 'KS-P1', localId: 'P1', title: 'Task P1', body: 'The body', acceptance: ['one', 'two'], sensitive: true, branch: 'pkg/KS-P1' },
      resources: { port: 7100, db: 'ks_ks_p1', migrations: { from: 10, to: 14 } },
    });
    expect(cmd.run.task).toEqual({ id: 'KS-P1', localId: 'P1', title: 'Task P1', body: 'The body', acceptance: ['one', 'two'], sensitive: true, branch: 'pkg/KS-P1' });
    expect(cmd.run).not.toHaveProperty('findings');
    expect(cmd.run).not.toHaveProperty('files');
    const detail = await agent('tasks_get', { id: 'KS-P1' });
    expect(detail.events.find((e: any) => e.kind === 'step_run')).toMatchObject({ detail: { runId: res.runId, step: 'prepare', round: 1 } });
    expect(detail.round).toBe(0); // a step uses no round

    // the runner comes back: a new run is sent, and what it receives is what is stored
    const captured = fakeRunner(m1.id);
    try {
      const sent = await agent('steps_run', { taskId: 'KS-P1', step: 'prepare' });
      expect(sent).toMatchObject({ status: 'queued', sent: true });
      expect(sent).not.toHaveProperty('note');
      expect(captured).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(captured[0]))).toEqual(storedCommand(sent.runId));
    } finally {
      offline(m1.id);
    }
  });

  it('keeps the resolved line a prepare reports on the project, makes no gate result, and keeps a line error', async () => {
    await project('kline');
    await task('kline', 'LN1');
    await claim('LN1');
    const line = lineOf({ commands: { verify: 'npm test' }, limits: { rounds: 4 } });
    const before = await web.get('/api/factory/projects/kline');
    expect(before).toMatchObject({ resolvedLine: null, lineSeenAt: null, lineError: null });

    const run = await agent('steps_run', { taskId: 'LN1', step: 'prepare' });
    const res = await machinePost(`/api/runner/gates/${run.runId}`, { status: 'done', verdict: 'pass', summary: 'prepared', details: { worktree: 'w' }, line });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: run.runId, status: 'done', verdict: 'pass', gateResultId: null });

    const p = await web.get('/api/factory/projects/kline');
    expect(p.resolvedLine).toEqual(JSON.parse(JSON.stringify(line)));
    expect(p.lineSeenAt).toEqual(expect.any(Number));
    expect(p.lineError).toBeNull();

    const t = await agent('tasks_get', { id: 'LN1' });
    expect(t.gateResults).toEqual([]);
    expect(t.round).toBe(0);
    expect(t.events.find((e: any) => e.kind === 'step')).toMatchObject({ actor: 'runner:step', detail: { runId: run.runId, step: 'prepare', verdict: 'pass', summary: 'prepared' } });
    expect(await agent('gates_status', { runId: run.runId })).toMatchObject({ status: 'done', verdict: 'pass', details: { worktree: 'w' }, gateResultId: null });

    // a run that fails to resolve the line says why
    const qa = await agent('steps_run', { taskId: 'LN1', step: 'qa' });
    const bad = await machinePost(`/api/runner/gates/${qa.runId}`, { status: 'error', error: 'no line', lineError: 'bad' });
    expect(bad.status).toBe(200);
    expect(await agent('gates_status', { runId: qa.runId })).toMatchObject({ status: 'error', error: 'no line' });
    expect((await web.get('/api/factory/projects/kline')).lineError).toBe('bad');
    expect((await agent('tasks_get', { id: 'LN1' })).round).toBe(0);
  });
});

describe('resources and rounds from the line', () => {
  it('allocates ports, database and migrations from the line, and falls back to the legacy fields without line resources', async () => {
    await project('kres');
    storeProjectLine(srv.ctx, 'kres', lineOf({ commands: { verify: 'npm test' }, resources: { ports: [7000, 7001], dbPrefix: 'k_', migrations: { from: 100, block: 5 } } }), null);
    await task('kres', 'Ra-1.x');
    await task('kres', 'RB2');
    const a = await claim('Ra-1.x');
    const b = await claim('RB2');
    expect(a.resources).toEqual({ port: 7000, db: 'k_ra_1_x', migrations: { from: 100, to: 104 } });
    expect(b.resources).toEqual({ port: 7001, db: 'k_rb2', migrations: { from: 105, to: 109 } });

    // only config.legacy: still allocated
    await project('kleg', { config: { legacy: { portFrom: 7200, portTo: 7201, dbPrefix: 'l_', migrationFrom: 50, migrationBlock: 10 } } });
    await task('kleg', 'LG1');
    expect((await claim('LG1')).resources).toEqual({ port: 7200, db: 'l_lg1', migrations: { from: 50, to: 59 } });

    // a stored line without `resources` leaves the legacy fields in charge
    await project('kleg2', { config: { legacy: { portFrom: 7300, portTo: 7301, dbPrefix: 'm_', migrationFrom: 70, migrationBlock: 10 } } });
    storeProjectLine(srv.ctx, 'kleg2', lineOf({ commands: { verify: 'npm test' } }), null);
    await task('kleg2', 'LG2');
    expect((await claim('LG2')).resources).toEqual({ port: 7300, db: 'm_lg2', migrations: { from: 70, to: 79 } });
  });

  it("uses the line's limits.rounds, and the project's own override wins", async () => {
    await project('krounds');
    storeProjectLine(srv.ctx, 'krounds', lineOf({ commands: { verify: 'npm test' }, limits: { rounds: 1 } }), null);
    await task('krounds', 'RN1');
    await claim('RN1');
    expect((await agent('tasks_get', { id: 'RN1' })).maxRounds).toBe(1);
    await agent('tasks_update', { id: 'RN1', status: 'la_porti' });
    await agent('gates_record', { taskId: 'RN1', gate: 'G1', verdict: 'fail', summary: 'red' });
    const t = await agent('tasks_get', { id: 'RN1' });
    expect(t).toMatchObject({ status: 'blocata', round: 1, maxRounds: 1 });
    expect(t.decisions.filter((d: any) => d.status === 'pending')).toHaveLength(1);

    await web.put('/api/factory/projects/krounds', { config: { limits: { rounds: 2 } } });
    expect((await agent('tasks_get', { id: 'RN1' })).maxRounds).toBe(2);
    await task('krounds', 'RN2');
    expect((await agent('tasks_get', { id: 'RN2' })).maxRounds).toBe(2);
  });
});

describe('the runner version', () => {
  it('refuses the kit built-ins on a runner older than 0.2.0, and lets argv steps and the recipe through', async () => {
    const old = createMachine(srv.ctx, 'oldbox', { platform: process.platform });
    setVersion(old.id, '0.1.0');
    await project('kold', {}, old.id);
    await task('kold', 'OLD1');
    await claim('OLD1');

    await expect(agent('steps_run', { taskId: 'OLD1', step: 'prepare' })).rejects.toThrow(/409 .*bb runner/);
    expect(srv.ctx.db.get('SELECT 1 FROM gate_runs WHERE task_id = ?', 'OLD1')).toBeUndefined();

    // no line known: a gate is taken for a recipe step
    expect(await agent('gates_run', { taskId: 'OLD1', gate: 'G1' })).toMatchObject({ status: 'queued', machineId: old.id });

    // a line without argv steps for G1: the kit's built-in, which the old runner lacks
    storeProjectLine(srv.ctx, 'kold', lineOf({ commands: { verify: 'npm test' } }), null);
    await expect(agent('gates_run', { taskId: 'OLD1', gate: 'G1' })).rejects.toThrow(/409 .*bb runner/);

    // argv steps run on any runner
    storeProjectLine(srv.ctx, 'kold', lineOf({ commands: { verify: 'x' }, gates: { G1: { steps: [{ argv: ['node', '-e', '0'] }] } } }), null);
    expect(await agent('gates_run', { taskId: 'OLD1', gate: 'G1' })).toMatchObject({ status: 'queued' });

    setVersion(old.id, '0.2.0');
    expect(await agent('steps_run', { taskId: 'OLD1', step: 'prepare' })).toMatchObject({ step: 'prepare', status: 'queued' });
    setVersion(old.id, '0.10.1'); // compared as numbers, not text
    expect(await agent('steps_run', { taskId: 'OLD1', step: 'cleanup' })).toMatchObject({ step: 'cleanup', status: 'queued' });
  });
});

describe('G3 findings', () => {
  it('carries the earlier open blockers and majors from round 2, never in round 1', async () => {
    await project('kg3', { config: { limits: { rounds: 5 } } });
    await task('kg3', 'GA');
    await claim('GA');
    await agent('tasks_update', { id: 'GA', status: 'la_porti' });
    await agent('gates_record', {
      taskId: 'GA', gate: 'G3', verdict: 'fail', summary: 'review',
      findings: [
        { severity: 'blocker', title: 'SQL injection', file: 'src/db.ts', line: 3, detail: 'concatenated', fix: 'bind it' },
        { severity: 'major', title: 'No auth check' },
        { severity: 'minor', title: 'Naming' },
      ],
    });

    // still round 1: nothing is carried
    const r1 = await agent('gates_run', { taskId: 'GA', gate: 'G3' });
    expect(r1.round).toBe(1);
    expect(storedCommand(r1.runId).run).not.toHaveProperty('findings');

    await agent('tasks_update', { id: 'GA', status: 'in_lucru', note: 'fix G3' });
    await agent('tasks_update', { id: 'GA', status: 'la_porti' });
    const r2 = await agent('gates_run', { taskId: 'GA', gate: 'G3' });
    expect(r2.round).toBe(2);
    expect(storedCommand(r2.runId).run.findings).toEqual([
      { severity: 'blocker', title: 'SQL injection', file: 'src/db.ts', line: 3, detail: 'concatenated', fix: 'bind it' },
      { severity: 'major', title: 'No auth check' },
    ]);
    // only G3 gets them
    expect(storedCommand((await agent('gates_run', { taskId: 'GA', gate: 'G1' })).runId).run).not.toHaveProperty('findings');

    // another package, round 1, with findings of its own: none are sent
    await task('kg3', 'GB');
    await claim('GB');
    await agent('tasks_update', { id: 'GB', status: 'la_porti' });
    await agent('gates_record', { taskId: 'GB', gate: 'G3', verdict: 'fail', summary: 'review', findings: [{ severity: 'blocker', title: 'Leak' }] });
    const rb = await agent('gates_run', { taskId: 'GB', gate: 'G3' });
    expect(rb.round).toBe(1);
    expect('findings' in storedCommand(rb.runId).run).toBe(false);
  });
});

describe('revert', () => {
  it('needs a range, taken from the last G5 pass when none is given', async () => {
    await project('krev');
    await task('krev', 'RV1');
    await claim('RV1');
    await expect(agent('steps_run', { taskId: 'RV1', step: 'revert' })).rejects.toThrow(/400 .*no G5 integration of RV1/);
    expect(await agent('steps_run', { taskId: 'RV1', step: 'revert', args: ['1111111..2222222'] })).toMatchObject({ status: 'queued' });

    await agent('tasks_update', { id: 'RV1', status: 'la_porti' });
    const g5 = await agent('gates_run', { taskId: 'RV1', gate: 'G5' });
    // a report that is not a range is not trusted
    const junk = await agent('gates_run', { taskId: 'RV1', gate: 'G5' });
    expect((await machinePost(`/api/runner/gates/${junk.runId}`, { status: 'done', verdict: 'pass', summary: 'ok', details: { range: 'HEAD~1..HEAD; rm -rf' } })).status).toBe(200);
    await expect(agent('steps_run', { taskId: 'RV1', step: 'revert' })).rejects.toThrow(/400 .*no G5 integration/);

    expect((await machinePost(`/api/runner/gates/${g5.runId}`, { status: 'done', verdict: 'pass', summary: 'integrated', details: { range: 'aaaaaaa..bbbbbbb' } })).status).toBe(200);
    const rev = await agent('steps_run', { taskId: 'RV1', step: 'revert' });
    expect(rev).toMatchObject({ step: 'revert', status: 'queued' });
    expect(storedCommand(rev.runId).run).toMatchObject({ gate: 'revert', args: ['aaaaaaa..bbbbbbb'] });
    // given args win
    const given = await agent('steps_run', { taskId: 'RV1', step: 'revert', args: ['ccccccc..ddddddd'] });
    expect(storedCommand(given.runId).run.args).toEqual(['ccccccc..ddddddd']);
  });
});

describe('files for .factory/', () => {
  it('refuses paths outside it and passes the rest in the command', async () => {
    await project('kfile');
    await task('kfile', 'FL1');
    for (const path of ['../x', 'a/../b', '/etc/passwd', 'C:/x', '.factory/../x', 'a b']) {
      let err: unknown;
      try {
        startStepRun(srv.ctx, { taskId: 'FL1', step: 'prepare', files: [{ path, content: 'y' }] }, 'test');
      } catch (e) {
        err = e;
      }
      expect(err, path).toBeInstanceOf(FactoryError);
      expect((err as FactoryError).status).toBe(400);
    }
    expect(() => startStepRun(srv.ctx, { taskId: 'FL1', step: 'prepare', files: [{ path: 'big.md', content: 'x'.repeat(1024 * 1024 + 1) }] }, 'test')).toThrow(FactoryError);
    expect(srv.ctx.db.get('SELECT 1 FROM gate_runs WHERE task_id = ?', 'FL1')).toBeUndefined(); // nothing was queued

    const ok = startStepRun(srv.ctx, { taskId: 'FL1', step: 'prepare', files: [{ path: 'brief.md', content: 'hi' }, { path: '.factory/notes/a.txt', content: 'n' }] }, 'test');
    expect(ok.status).toBe('queued');
    expect(storedCommand(ok.id).run.files).toEqual([{ path: 'brief.md', content: 'hi' }, { path: '.factory/notes/a.txt', content: 'n' }]);
  });
});

describe('hc commands', () => {
  it('are checked, kept, re-sent while queued, and settled by the first report of their machine', async () => {
    await project('khc');
    await task('khc', 'HC1');
    const captured = fakeRunner(m1.id);
    try {
      const sent = sendHcCommand(srv.ctx, { op: 'send', taskId: 'HC1', text: '  hello  ' }, 'test');
      expect(sent).toMatchObject({ status: 'queued', sent: true, op: 'send', name: 'bb-hc1', machineId: m1.id, taskId: 'HC1' });
      expect(captured).toEqual([{ type: 'hc', id: sent.id, op: 'send', name: 'bb-hc1', text: 'hello' }]);
      expect((await agent('tasks_get', { id: 'HC1' })).events.find((e: any) => e.kind === 'hc')).toMatchObject({ detail: { id: sent.id, op: 'send', name: 'bb-hc1', text: 'hello' } });

      // still queued: reading it sends it again
      expect(hcCommandStatus(srv.ctx, sent.id)).toMatchObject({ status: 'queued', sent: true });
      expect(captured).toHaveLength(2);
      expect(captured[1]).toEqual(captured[0]);

      // not another machine's
      expect((await post(m2, `/api/runner/hc/${sent.id}`, { status: 'done' })).status).toBe(404);
      expect(hcCommandStatus(srv.ctx, sent.id).status).toBe('queued');
      expect((await post(m2, '/api/runner/hc/no-such-id', { status: 'done' })).status).toBe(404);
      expect((await machinePost(`/api/runner/hc/${sent.id}`, { status: 'nope' })).status).toBe(400);

      const done = await machinePost(`/api/runner/hc/${sent.id}`, { status: 'done', result: { sent: true } });
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({ id: sent.id, status: 'done', result: { sent: true }, error: null });
      // the first report wins
      const again = await machinePost(`/api/runner/hc/${sent.id}`, { status: 'error', error: 'late' });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ status: 'done', result: { sent: true }, error: null });
      expect(hcCommandStatus(srv.ctx, sent.id)).toMatchObject({ status: 'done', result: { sent: true } });
      expect(captured).toHaveLength(3); // a settled command is not sent again (the third was the re-send above)
      expect((await agent('tasks_get', { id: 'HC1' })).events.find((e: any) => e.kind === 'hc_done')).toMatchObject({ actor: 'runner:hc', detail: { id: sent.id, status: 'done' } });

      // kill has no text
      const kill = sendHcCommand(srv.ctx, { op: 'kill', taskId: 'HC1', text: 'ignored' }, 'test');
      expect(kill).toMatchObject({ op: 'kill', status: 'queued', sent: true });
      expect(captured[3]).toEqual({ type: 'hc', id: kill.id, op: 'kill', name: 'bb-hc1' });
      const failed = await machinePost(`/api/runner/hc/${kill.id}`, { status: 'error', error: 'no such terminal' });
      expect(await failed.json()).toMatchObject({ status: 'error', error: 'no such terminal' });

      // refusals
      const status = (fn: () => unknown) => {
        try {
          fn();
        } catch (e) {
          return e instanceof FactoryError ? e.status : -1;
        }
        return 0;
      };
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', taskId: 'HC1', name: 'w-p1', text: 'x' }, 'test'))).toBe(400);
      expect(status(() => sendHcCommand(srv.ctx, { op: 'kill', machineId: m1.id, name: 'bb-' }, 'test'))).toBe(400);
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', taskId: 'HC1' }, 'test'))).toBe(400);
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', taskId: 'HC1', text: '   ' }, 'test'))).toBe(400);
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', machineId: m1.id, text: 'x' }, 'test'))).toBe(400); // no terminal name
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', machineId: 'nope', name: 'bb-x', text: 'x' }, 'test'))).toBe(400);
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', taskId: 'NOPE', text: 'x' }, 'test'))).toBe(404);
      expect(status(() => sendHcCommand(srv.ctx, { op: 'send', machineId: m1.id, name: 'bb-free', text: 'x' }, 'test'))).toBe(0);
    } finally {
      offline(m1.id);
    }

    // offline: queued and kept
    const queued = sendHcCommand(srv.ctx, { op: 'send', taskId: 'HC1', text: 'later' }, 'test');
    expect(queued).toMatchObject({ status: 'queued', sent: false });
  });
});

describe('refreshing the line', () => {
  it('asks the runner for the line, and stores the answer only from the project\'s machine', async () => {
    await project('kref');
    const checkout = join(tmp, 'kref');

    offline(m1.id);
    expect(await web.post('/api/factory/projects/kref/refresh')).toMatchObject({ sent: false, reason: expect.any(String) });

    const captured = fakeRunner(m1.id);
    try {
      expect(await web.post('/api/factory/projects/kref/refresh')).toMatchObject({ sent: true });
      expect(captured).toEqual([{ type: 'line', id: expect.any(String), project: 'kref', checkout, lineFile: 'factory.json' }]);
    } finally {
      offline(m1.id);
    }

    const line = lineOf({ commands: { verify: 'npm test' }, resources: { ports: [7400, 7402] } });
    const ok = await machinePost('/api/runner/lines', { project: 'kref', line, error: null });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const p = await web.get('/api/factory/projects/kref');
    expect(p.resolvedLine).toEqual(JSON.parse(JSON.stringify(line)));
    expect(p).toMatchObject({ lineSeenAt: expect.any(Number), lineError: null });

    // not another machine's project, nor an unknown one
    expect((await post(m2, '/api/runner/lines', { project: 'kref', line: lineOf({ commands: {} }), error: null })).status).toBe(404);
    expect((await machinePost('/api/runner/lines', { project: 'nope-x', line, error: null })).status).toBe(404);
    expect((await machinePost('/api/runner/lines', { line })).status).toBe(400);
    expect((await web.get('/api/factory/projects/kref')).resolvedLine).toEqual(JSON.parse(JSON.stringify(line)));

    // the line file does not resolve
    const boom = await machinePost('/api/runner/lines', { project: 'kref', line: null, error: 'boom' });
    expect(boom.status).toBe(200);
    expect(await web.get('/api/factory/projects/kref')).toMatchObject({ lineError: 'boom', lineSeenAt: expect.any(Number) });
  });
});
