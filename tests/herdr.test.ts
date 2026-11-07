// herdr (hc) integration, end to end with a fake `hc` (fixtures/fake-hc.mjs) and a fake `claude`. The real hc is never run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createJob } from '../server/jobs/core.ts';
import { terminalViews } from '../server/routes/herdr.ts';
import { startRunner, type Runner } from '../runner/main.ts';
import { findHc, resolveHc } from '../runner/herdr.ts';
import { buildHcRunArgs, checkOptions, hcTerminalName } from '../runner/options.ts';
import type { TerminalView } from '../shared/factory.ts';

const FAKE_HC = resolve('fixtures/fake-hc.mjs');
const FAKE_CLAUDE = resolve('fixtures/fake-claude.mjs');
const HOOK = resolve('plugin/hooks/bb-hook.mjs');

let srv: TestServer;
let web: WebClient;
let runner: Runner;
let machine: { id: string; token: string };
let tmp: string;
let repoA: string;
let outside: string;
let hcLog: string;
let hcTerminals: string;
const events: { topic: string; type: string }[] = [];

async function waitFor<T>(fn: () => Promise<T> | T, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const job = (id: string) => web.get(`/api/jobs/${id}`);
const waitStatus = (id: string, ...statuses: string[]) => waitFor(async () => {
  const j = await job(id);
  return statuses.includes(j.status) ? j : null;
}, `job ${id} to be ${statuses.join('|')}`);
const output = async (id: string): Promise<string[]> => (await web.get(`/api/jobs/${id}/output`)).lines.map((l: { line: string }) => l.line);
const hcRuns = (): string[][] => {
  try {
    return readFileSync(hcLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const setTerminals = (list: unknown[]) => writeFileSync(hcTerminals, JSON.stringify(list));
const terminals = () => web.get<TerminalView[]>('/api/terminals');
const task = (id: string) => web.get(`/api/tasks/${id}`);
const newTask = (id: string, extra: Record<string, unknown> = {}) =>
  web.post('/api/tasks', { id, title: `Package ${id}`, body: `Do the work of ${id}.`, acceptance: [`${id} passes \`npm test\``], status: 'gata', ...extra });

function envelope(sid: string, ts: number, env: Record<string, string>) {
  return { v: 1, ts, env, hostname: 'h', platform: 'linux', user: 'u', pid: 1, ppid: 1, hookVersion: 't', event: { session_id: sid, cwd: repoA, hook_event_name: 'SessionStart' } };
}
const ingest = (token: string, env: unknown) =>
  fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(env) });
const report = (token: string, body: unknown) =>
  fetch(`${srv.url}/api/runner/terminals`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  srv = await startTestServer();
  const unsub = srv.ctx.bus.subscribe((e) => events.push({ topic: e.topic, type: e.type }));
  afterAll(unsub);
  web = await srv.login();
  machine = createMachine(srv.ctx, 'hc-box', { platform: process.platform });
  tmp = mkdtempSync(join(tmpdir(), 'bb-herdr-'));
  const home = join(tmp, 'home');
  const roots = join(tmp, 'roots');
  repoA = join(roots, 'repo-a');
  outside = join(tmp, 'outside');
  for (const d of [home, join(repoA, '.git'), outside]) mkdirSync(d, { recursive: true });
  hcLog = join(tmp, 'hc-runs.jsonl');
  hcTerminals = join(tmp, 'hc-terminals.json');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: srv.url, token: machine.token, machineId: machine.id }));
  writeFileSync(join(home, 'runner.json'), JSON.stringify({ allowedRoots: [roots], concurrency: 2, idleExitSeconds: 1, stopGraceSeconds: 1, hcPollSeconds: 1 }));
  process.env.BUILDYBOY_HOME = home;
  process.env.BUILDYBOY_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.BUILDYBOY_HC = FAKE_HC;
  process.env.FAKE_HC_LOG = hcLog;
  process.env.FAKE_HC_TERMINALS = hcTerminals;
  delete process.env.FAKE_HC_FAIL;
  delete process.env.BUILDYBOY_URL;
  delete process.env.BUILDYBOY_TOKEN;
  runner = startRunner({ log: () => {} });
  await waitFor(() => srv.ctx.runners.has(machine.id), 'runner to connect');
  await waitFor(() => srv.ctx.db.get<{ i: string | null }>('SELECT runner_info_json i FROM machines WHERE id = ?', machine.id)?.i, 'first heartbeat');
});

afterAll(async () => {
  await runner?.stop();
  await srv?.stop();
  for (const k of ['BUILDYBOY_HOME', 'BUILDYBOY_CLAUDE_BIN', 'BUILDYBOY_HC', 'FAKE_HC_LOG', 'FAKE_HC_TERMINALS', 'FAKE_HC_FAIL']) delete process.env[k];
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly
  }
});

describe('terminal reports', () => {
  it('stores what the runner reports, replaces it on the next report and links packages and sessions', async () => {
    await newTask('T77');
    setTerminals([
      { address: 't1', agent: 'claude-code', cwd: repoA, state: 'live', status: 'working', turn: 3, where: 'repo / 1' },
      { address: 't2', name: 'bb-t77', agent: 'claude-code', cwd: repoA, state: 'live', status: 'idle', turn: 0, where: 'repo / 2' },
      { address: 't3', agent: 'node', cwd: outside, state: 'live' },
    ]);
    const list = await waitFor(async () => {
      const l = await terminals();
      return l.length === 3 ? l : null;
    }, 'three terminals');
    expect(list.map((t) => t.address)).toEqual(['t1', 't2', 't3']);
    expect(list[0]).toMatchObject({ machineId: machine.id, machineName: 'hc-box', agent: 'claude-code', status: 'working', turn: 3, where: 'repo / 1', name: null, taskId: null, sessionId: null });
    expect(list[1]).toMatchObject({ name: 'bb-t77', taskId: 'T77', status: 'idle' });
    expect(list[2]).toMatchObject({ agent: 'node', status: null, turn: null });
    expect(events.some((e) => e.topic === 'floor' && e.type === 'terminals')).toBe(true);

    // a session started in terminal t1 is found through HC_TERMINAL_ID (the newest one wins)
    expect((await ingest(machine.token, envelope('hc-old-session', Date.now() - 60_000, { HC_TERMINAL_ID: 't1' }))).status).toBe(200);
    expect((await ingest(machine.token, envelope('hc-new-session', Date.now(), { HC_TERMINAL_ID: 't1' }))).status).toBe(200);
    expect((await ingest(machine.token, envelope('hc-bad-env', Date.now(), { HC_TERMINAL_ID: 't1; rm -rf /' }))).status).toBe(200);
    expect(srv.ctx.db.get<{ h: string | null }>("SELECT hc_terminal h FROM sessions WHERE id = 'hc-bad-env'")!.h).toBeNull();
    expect((await terminals()).find((t) => t.address === 't1')!.sessionId).toBe('hc-new-session');

    // the next report replaces the list: t1 and t3 are gone, t2 stays
    events.length = 0;
    setTerminals([{ address: 't2', name: 'bb-t77', agent: 'claude-code', cwd: repoA, state: 'live', status: 'blocked', turn: 1, where: 'repo / 2' }]);
    const after = await waitFor(async () => {
      const l = await terminals();
      return l.length === 1 ? l : null;
    }, 'replacement report');
    expect(after[0]).toMatchObject({ address: 't2', status: 'blocked', turn: 1 });
    expect(srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM hc_terminals')!.n).toBe(1);
    await waitFor(() => events.some((e) => e.topic === 'floor' && e.type === 'terminals'), 'a terminals event');
  });

  it('keeps machines apart, hides stale reports and refuses bad or anonymous ones', async () => {
    const other = createMachine(srv.ctx, 'other-hc-box');
    expect((await report(other.token, { terminals: [{ address: 't2', agent: 'claude-code', cwd: '/x', state: 'live' }] })).status).toBe(200);
    const all = await terminals();
    expect(all.filter((t) => t.address === 't2').map((t) => t.machineName).sort()).toEqual(['hc-box', 'other-hc-box']);
    expect(all.find((t) => t.machineName === 'other-hc-box')!.taskId).toBeNull(); // bb-t77 belongs to the other machine's terminal
    // the runner's next report does not touch the other machine's rows
    await new Promise((r) => setTimeout(r, 1500));
    expect((await terminals()).some((t) => t.machineName === 'other-hc-box')).toBe(true);
    expect(terminalViews(srv.ctx, Date.now() + 5 * 60_000)).toEqual([]);
    expect((await report(other.token, { terminals: 'nope' })).status).toBe(400);
    expect((await report(other.token, { terminals: [{ address: '' }] })).status).toBe(400);
    expect((await fetch(`${srv.url}/api/runner/terminals`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${srv.url}/api/terminals`)).status).toBe(401);
    expect((await report(other.token, { terminals: [] })).status).toBe(200);
    expect((await terminals()).some((t) => t.machineName === 'other-hc-box')).toBe(false);
  });
});

describe('HC_TERMINAL_ID from the real hook', () => {
  it('is on the hook allowlist and ends up in sessions.hc_terminal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bb-hchook-'));
    const code = await new Promise<number | null>((done) => {
      const p = spawn(process.execPath, [HOOK], {
        env: { ...process.env, BUILDYBOY_HOME: home, BUILDYBOY_URL: srv.url, BUILDYBOY_TOKEN: machine.token, HC_TERMINAL_ID: 't42', HOME_SECRET: 'never-sent' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      p.on('close', done);
      p.stdin.end(JSON.stringify({ session_id: 'hc-hook-session', cwd: repoA, transcript_path: join(home, 'none.jsonl'), hook_event_name: 'SessionStart', source: 'startup' }));
    });
    expect(code).toBe(0);
    const row = await waitFor(() => srv.ctx.db.get<{ h: string }>("SELECT hc_terminal h FROM sessions WHERE id = 'hc-hook-session'"), 'the hooked session');
    expect(row.h).toBe('t42');
    const payload = srv.ctx.db.get<{ p: string }>("SELECT payload_json p FROM events WHERE session_id = 'hc-hook-session' LIMIT 1")!.p;
    expect(payload).not.toContain('never-sent');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('launching a package', () => {
  const launch = (id: string, body: Record<string, unknown>) => web.post(`/api/tasks/${id}/launch`, { machineId: machine.id, cwd: repoA, ...body });

  it('launcher hc runs hc with a validated argv, then the package is in_lucru with its terminal and job', async () => {
    await newTask('T10', { repo: 'repo-a', branch: 'feat/t10' });
    const before = hcRuns().length;
    const { id } = await launch('T10', { launcher: 'hc', model: 'sonnet', permissionMode: 'acceptEdits' });
    const j = await waitStatus(id, 'succeeded', 'failed');
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ launcher: 'hc', terminal: 't7', name: 'bb-t10' });
    expect(j.options).toMatchObject({ launcher: 'hc', taskId: 'T10' });
    expect(j.title).toBe('T10: Package T10');

    const runs = hcRuns();
    expect(runs).toHaveLength(before + 1);
    const argv = runs[runs.length - 1];
    expect(argv).toEqual([
      'run', '--bg', '--json', '--name', 'bb-t10', '--cwd', realpathSync.native(repoA),
      '--label', 'owner=buildyboy', '--label', 'bb.task=T10', '--label', `bb.job=${id}`, '--no-parent',
      'claude', '--model', 'sonnet', '--permission-mode', 'acceptEdits', '-n', 'T10: Package T10',
      argv[argv.length - 1],
    ]);
    expect(argv).not.toContain('-p'); // interactive, not headless
    const prompt = argv[argv.length - 1];
    expect(prompt).toContain('# Package T10');
    expect(prompt).toContain('Do the work of T10.');
    expect(prompt).toContain('- T10 passes `npm test`');
    expect(prompt).toContain('branch feat/t10');
    expect(j.promptText).toBe(prompt);

    expect((await output(id)).join('\n')).toContain('Started in herdr terminal t7 (bb-t10)');
    const t = await task('T10');
    expect(t).toMatchObject({ status: 'in_lucru', terminal: 't7', jobId: id });
    expect(t.events.some((e: { kind: string; to: string | null }) => e.kind === 'status' && e.to === 'in_lucru')).toBe(true);

    // the reported terminal links back to the package through tasks.terminal, even without a name
    setTerminals([{ address: 't7', agent: 'claude-code', cwd: repoA, state: 'live', status: 'working', turn: 1, where: 'repo / bb' }]);
    const mine = await waitFor(async () => (await terminals()).find((x) => x.machineId === machine.id && x.address === 't7'), 'terminal t7');
    expect(mine.taskId).toBe('T10');

    // the worker's first hook in that terminal gives the package its session (not another machine's t7)
    const other = createMachine(srv.ctx, 'elsewhere');
    await ingest(other.token, envelope('hc-foreign-t7', Date.now(), { HC_TERMINAL_ID: 't7' }));
    expect((await task('T10')).sessionId).toBeNull();
    await ingest(machine.token, envelope('hc-worker-t7', Date.now(), { HC_TERMINAL_ID: 't7' }));
    expect((await task('T10')).sessionId).toBe('hc-worker-t7');
  });

  it('only moves a gata package to in_lucru; others keep their state and still get the terminal', async () => {
    await newTask('T11', { status: 'backlog' });
    const { id } = await launch('T11', { launcher: 'hc' });
    expect((await waitStatus(id, 'succeeded', 'failed')).status).toBe('succeeded');
    expect(await task('T11')).toMatchObject({ status: 'backlog', terminal: expect.stringMatching(/^t\d+$/), jobId: id });
  });

  it('uses the chosen prompt instead of building one', async () => {
    await newTask('T12');
    const now = Date.now();
    const pid = Number(srv.ctx.db.run("INSERT INTO prompts (title, slots_json, rendered, created_at, updated_at) VALUES ('Rendered one', '{}', 'Goal: do the rendered thing\nDone when: `npm test` passes', ?, ?)", now, now).lastInsertRowid);
    const { id } = await launch('T12', { launcher: 'hc', promptId: pid });
    await waitStatus(id, 'succeeded', 'failed');
    const argv = hcRuns().at(-1)!;
    expect(argv[argv.length - 1]).toBe('Goal: do the rendered thing\nDone when: `npm test` passes');
    expect(argv).toContain('--name');
    expect(argv[argv.indexOf('--name') + 1]).toBe('bb-t12');
    // a package that records its own prompt uses it by default
    await newTask('T13');
    await web.put('/api/tasks/T13', { promptId: pid });
    const second = await launch('T13', { launcher: 'hc' });
    await waitStatus(second.id, 'succeeded', 'failed');
    expect(hcRuns().at(-1)!.at(-1)).toBe('Goal: do the rendered thing\nDone when: `npm test` passes');
  });

  it('refuses a directory outside the runner allowed roots, on the server and on the runner', async () => {
    await newTask('T20');
    const before = hcRuns().length;
    await expect(launch('T20', { launcher: 'hc', cwd: outside })).rejects.toThrow(/outside the runner's allowed roots/);
    // a job that skipped the server's early check is still refused by the runner, and nothing is started
    const id = createJob(srv.ctx, { machineId: machine.id, cwd: outside, promptText: 'x', title: 'T20', options: { maxBudgetUsd: 1, launcher: 'hc', taskId: 'T20' } });
    const j = await waitStatus(id, 'failed');
    expect(j.result.reason).toMatch(/outside the runner's allowed roots/);
    expect(hcRuns()).toHaveLength(before);
    expect(await task('T20')).toMatchObject({ status: 'gata', terminal: null });
    await expect(launch('T20', { launcher: 'screen' })).rejects.toThrow(/400/);
    await expect(web.post('/api/tasks/NOPE/launch', { machineId: machine.id, cwd: repoA })).rejects.toThrow(/404/);
    await expect(launch('T20', { model: 'sonnet; rm -rf /' })).rejects.toThrow(/invalid model/);
  });

  it('fails the job, and leaves the package alone, when hc fails', async () => {
    await newTask('T21');
    process.env.FAKE_HC_FAIL = "name 'bb-t21' is already in use";
    try {
      const { id } = await launch('T21', { launcher: 'hc' });
      const j = await waitStatus(id, 'failed', 'succeeded');
      expect(j.status).toBe('failed');
      expect(j.result.reason).toMatch(/hc run failed: .*already in use/);
    } finally {
      delete process.env.FAKE_HC_FAIL;
    }
    expect(await task('T21')).toMatchObject({ status: 'gata', terminal: null });
  });

  it('launcher claude is a normal claude -p job that records the job and session on the package', async () => {
    await newTask('T30');
    const before = hcRuns().length;
    const { id, launcher } = await launch('T30', { launcher: 'claude' });
    expect(launcher).toBe('claude');
    const j = await waitStatus(id, 'succeeded', 'failed');
    expect(j.status).toBe('succeeded');
    const init = JSON.parse((await output(id)).find((l) => l.includes('"subtype":"init"'))!);
    expect(init.fake_argv.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    expect(hcRuns()).toHaveLength(before); // hc was not involved
    const t = await task('T30');
    expect(t).toMatchObject({ status: 'gata', terminal: null, jobId: id, sessionId: j.sessionId });
  });
});

describe('options and argv', () => {
  it('validates launcher and taskId', () => {
    expect(checkOptions({ maxBudgetUsd: 1, launcher: 'hc', taskId: 'T-1.a' })).toEqual({ maxBudgetUsd: 1, launcher: 'hc', taskId: 'T-1.a' });
    expect(() => checkOptions({ maxBudgetUsd: 1, launcher: 'sh' })).toThrow(/launcher/);
    expect(() => checkOptions({ maxBudgetUsd: 1, taskId: 'T 1; rm' })).toThrow(/taskId/);
    expect(() => checkOptions({ maxBudgetUsd: 1, taskId: '--evil' })).not.toThrow(); // a name, never a flag: it is only ever a --label value or lowercased into --name
  });

  it('names terminals with 1-32 of a-z 0-9 - _', () => {
    expect(hcTerminalName('T12')).toBe('bb-t12');
    expect(hcTerminalName('Feature X/ö')).toMatch(/^bb-[a-z0-9_-]+$/);
    for (const id of ['T1', 'A'.repeat(64), 'x.y.z', '---', 'ÄÖ']) expect(hcTerminalName(id, '1234-abcd')).toMatch(/^[a-z0-9_-]{1,32}$/);
    expect(hcTerminalName(undefined, 'abcd1234-ffff')).toBe('bb-job-abcd1234');
  });

  it('builds the hc run argv without a shell, keeping flags in the prompt out of the way', () => {
    const o = { maxBudgetUsd: 1, launcher: 'hc', taskId: 'T5' };
    const a = buildHcRunArgs(o, { jobId: 'job-1', cwd: '/w', title: '-sneaky title', prompt: '- do a thing --and "quote" $(x)', program: '/bin/claude', pluginDirs: ['/p'] });
    expect(a).toEqual([
      'run', '--bg', '--json', '--name', 'bb-t5', '--cwd', '/w', '--label', 'owner=buildyboy', '--label', 'bb.task=T5', '--label', 'bb.job=job-1', '--no-parent',
      '/bin/claude', '--plugin-dir', '/p', '-n', 'sneaky title', 'Task: - do a thing --and "quote" $(x)',
    ]);
    expect(() => buildHcRunArgs(o, { jobId: 'a b', cwd: '/w', title: null, prompt: 'x' })).toThrow(/job id/);
    expect(() => buildHcRunArgs(o, { jobId: 'j', cwd: '/w', title: null, prompt: '   ' })).toThrow(/empty prompt/);
    expect(() => buildHcRunArgs(o, { jobId: 'j', cwd: '/w', title: null, prompt: 'x'.repeat(30_000) })).toThrow(/too long/);
    expect(() => buildHcRunArgs({ maxBudgetUsd: 1, model: 'x;y' }, { jobId: 'j', cwd: '/w', title: null, prompt: 'x' })).toThrow(/invalid model/);
  });

  it('finds hc through BUILDYBOY_HC, can be switched off, and runs a script through node', () => {
    expect(findHc()).toBe(FAKE_HC);
    expect(resolveHc()).toEqual({ command: process.execPath, prefix: [FAKE_HC] });
    process.env.BUILDYBOY_HC = 'off';
    try {
      expect(findHc()).toBeNull();
      expect(resolveHc(FAKE_HC)).toBeNull();
    } finally {
      process.env.BUILDYBOY_HC = FAKE_HC;
    }
  });
});
