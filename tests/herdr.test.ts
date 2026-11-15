// herdr (hc) integration, end to end with a fake `hc` (fixtures/fake-hc.mjs) and a fake `claude`. The real hc is never run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
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

describe('sessions in closed terminals', () => {
  it('a session whose terminal is finished or missing from the runner report ends; the others stay', async () => {
    const box = createMachine(srv.ctx, 'hc-kill-box');
    const now = Date.now();
    const start = (sid: string, ts: number, env: Record<string, string>) => ingest(box.token, envelope(sid, ts, env)).then((r) => expect(r.status).toBe(200));
    await start('hc-killed', now - 60_000, { HC_TERMINAL_ID: 't5' }); // `hc kill t5` + `hc rm t5`: no SessionEnd
    await start('hc-finished', now - 60_000, { HC_TERMINAL_ID: 't8' });
    await start('hc-alive', now - 60_000, { HC_TERMINAL_ID: 't6' });
    await start('hc-newer', now - 1000, { HC_TERMINAL_ID: 't9' }); // started after the listing was taken
    await start('no-terminal', now - 60_000, {});
    const row = (sid: string) => srv.ctx.db.get<{ status: string; end_reason: string | null }>('SELECT status, end_reason FROM sessions WHERE id = ?', sid)!;
    expect(row('hc-killed').status).toBe('idle');
    const listing = { terminals: [{ address: 't6', agent: 'claude-code', state: 'live', status: 'idle' }, { address: 't8', agent: 'claude-code', state: 'finished' }], takenAt: now - 5000 };
    expect((await report(box.token, listing)).status).toBe(200);
    expect(row('hc-killed')).toEqual({ status: 'ended', end_reason: 'terminal closed' });
    expect(row('hc-finished')).toEqual({ status: 'ended', end_reason: 'terminal closed' });
    expect(row('hc-alive').status).toBe('idle');
    expect(row('hc-newer').status).toBe('idle');
    expect(row('no-terminal').status).toBe('idle');
    expect((await web.get<{ id: string; status: string }[]>('/api/sessions')).find((s) => s.id === 'hc-killed')!.status).toBe('ended');
    // `box/t6` and `t6` are the same terminal; a session that speaks after being closed this way is alive again
    await start('hc-boxed', now - 60_000, { HC_TERMINAL_ID: 'box/t6' });
    expect((await report(box.token, listing)).status).toBe(200);
    expect(row('hc-boxed').status).toBe('idle');
    const later = { ...envelope('hc-killed', Date.now() + 1000, {}), event: { session_id: 'hc-killed', hook_event_name: 'UserPromptSubmit', prompt: 'still here', cwd: repoA } };
    expect((await ingest(box.token, later)).status).toBe(200);
    expect(row('hc-killed')).toEqual({ status: 'working', end_reason: null });
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
      // claude resolved to a real executable (here: node + the fake claude script), never a shell shim
      process.execPath, FAKE_CLAUDE, '--model', 'sonnet', '--permission-mode', 'acceptEdits', '-n', 'T10: Package T10',
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

  it('launching claims the package whatever its status, so tasks_claim cannot hand it out again', async () => {
    await newTask('T11', { status: 'backlog' });
    const { id } = await launch('T11', { launcher: 'hc' });
    expect(await task('T11')).toMatchObject({ status: 'in_lucru', claimedBy: 'web', jobId: id }); // right away, before hc answers
    expect((await waitStatus(id, 'succeeded', 'failed')).status).toBe('succeeded');
    expect(await task('T11')).toMatchObject({ status: 'in_lucru', terminal: expect.stringMatching(/^t\d+$/), jobId: id });
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

  it('fails the job, and hands the package back to its earlier status, when hc fails', async () => {
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
    expect(await task('T21')).toMatchObject({ status: 'gata', terminal: null, claimedBy: null });
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
    expect(t).toMatchObject({ status: 'in_lucru', terminal: null, jobId: id, sessionId: j.sessionId });
  });
});

describe('agents launching workers and coordinators', () => {
  let token: { id: string; token: string };
  const call = async (tool: string, body: unknown = {}) => {
    const r = await fetch(`${srv.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json()) as { result?: any; error?: string };
    return { status: r.status, result: j.result, error: j.error };
  };
  const allow = (launch: string, launchApproval: boolean) => web.put(`/api/agent-tokens/${token.id}`, { launch, launchApproval });
  const usage = (pct: number) =>
    fetch(`${srv.url}/api/statusline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'gov-launch', rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }),
    });
  const audit = (action: string) => srv.ctx.db.all<{ actor: string; target: string | null; detail: string | null }>('SELECT actor, target, detail FROM audit_log WHERE action = ? ORDER BY id', action);
  const pending = () => srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM decisions WHERE status = 'pending'")!.n;

  beforeAll(async () => {
    token = createAgentToken(srv.ctx, 'launcher');
    // the statusline bridge only records usage for a session it knows
    expect((await ingest(machine.token, envelope('gov-launch', Date.now(), {}))).status).toBe(200);
  });

  it('is off for a new token; machines_list shows where a launch could go', async () => {
    expect((await web.get('/api/agent-tokens')).find((t: { id: string }) => t.id === token.id)).toMatchObject({ launch: 'off', launchApproval: true });
    await newTask('T40');
    const w = await call('tasks_launch', { taskId: 'T40', machineId: machine.id, cwd: repoA });
    expect(w.status).toBe(403);
    expect(w.error).toMatch(/may not launch workers/);
    expect((await call('coordinator_launch', { machineId: machine.id, cwd: repoA })).status).toBe(403);
    const machines = (await call('machines_list')).result;
    expect(machines.find((m: { id: string }) => m.id === machine.id)).toMatchObject({ name: 'hc-box', runnerOnline: true, allowedRoots: [join(tmp, 'roots')] });
    await expect(web.put(`/api/agent-tokens/${token.id}`, { launch: 'everything' })).rejects.toThrow(/400/);
  });

  it('starts a worker through the launch route\'s path, only while the governor allows it, recorded as the agent', async () => {
    await allow('workers', false);
    await usage(95);
    const blocked = await call('tasks_launch', { taskId: 'T40', machineId: machine.id, cwd: repoA });
    expect(blocked.status).toBe(409);
    expect(blocked.error).toMatch(/^governor: /);
    await usage(10);
    // the same checks as the PWA: allowed roots, options, a known machine
    expect((await call('tasks_launch', { taskId: 'T40', machineId: machine.id, cwd: outside })).error).toMatch(/outside the runner's allowed roots/);
    expect((await call('tasks_launch', { taskId: 'T40', machineId: machine.id, cwd: repoA, model: 'x; rm' })).error).toMatch(/invalid model/);
    expect((await call('tasks_launch', { taskId: 'T40', machineId: 'nope', cwd: repoA })).error).toMatch(/unknown machine/);
    expect((await call('tasks_launch', { taskId: 'NOPE', machineId: machine.id, cwd: repoA })).status).toBe(404);

    const before = hcRuns().length;
    const r = await call('tasks_launch', { taskId: 'T40', machineId: machine.id, cwd: repoA, permissionMode: 'acceptEdits' });
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ status: 'launched', kind: 'worker', launcher: 'hc', taskId: 'T40', decisionId: null });
    expect(await task('T40')).toMatchObject({ status: 'in_lucru', claimedBy: 'agent:launcher', jobId: r.result.jobId });
    expect((await waitStatus(r.result.jobId, 'succeeded', 'failed')).status).toBe('succeeded');
    const argv = hcRuns().at(-1)!;
    expect(hcRuns()).toHaveLength(before + 1);
    expect(argv.slice(0, 5)).toEqual(['run', '--bg', '--json', '--name', 'bb-t40']);
    expect(argv).toContain('bb.task=T40');
    expect(argv).not.toContain('bb.role=coordonator');
    expect(await task('T40')).toMatchObject({ terminal: expect.stringMatching(/^t\d+$/) });
    expect(audit('task_launch').at(-1)).toMatchObject({ actor: 'agent:launcher', target: 'T40' });

    // workers only: no coordinators
    expect((await call('coordinator_launch', { machineId: machine.id, cwd: repoA })).error).toMatch(/may not launch coordinators/);
  });

  it('starts a coordinator terminal once the owner approves it, asking only once', async () => {
    await allow('all', true);
    const args = { machineId: machine.id, cwd: repoA, model: 'opus' };
    const asked = pending();
    const first = await call('coordinator_launch', args);
    expect(first.result).toMatchObject({ status: 'pending_approval', kind: 'coordinator', decisionId: expect.any(String) });
    expect(pending()).toBe(asked + 1);
    const d = await web.get<{ question: string; context: string; options: string[] }[]>('/api/decisions?status=pending').then((l) => l.find((x: any) => x.id === first.result.decisionId)!);
    expect(d.question).toBe('Start a coordinator on hc-box?');
    expect(d.options).toEqual(['Launch', 'Refuse']);
    expect(d.context).toContain('agent:launcher');
    expect(d.context).toContain('Model: opus');

    // asking again changes nothing while the owner has not answered; nothing was started
    const before = hcRuns().length;
    expect((await call('coordinator_launch', { ...args, launcher: 'hc', maxBudgetUsd: 5 })).result).toMatchObject({ status: 'pending_approval', decisionId: first.result.decisionId });
    expect(pending()).toBe(asked + 1);
    expect(hcRuns()).toHaveLength(before);

    await web.post(`/api/decisions/${first.result.decisionId}/answer`, { answer: 'Launch' });
    const launched = await call('coordinator_launch', args);
    expect(launched.result).toMatchObject({ status: 'launched', kind: 'coordinator', taskId: null, decisionId: first.result.decisionId });
    expect((await waitStatus(launched.result.jobId, 'succeeded', 'failed')).status).toBe('succeeded');
    const argv = hcRuns().at(-1)!;
    expect(argv[argv.indexOf('--name') + 1]).toMatch(/^bb-coord-[a-z0-9]{8}$/);
    expect(argv).toContain('bb.role=coordonator');
    expect(argv.some((a) => a.startsWith('bb.task='))).toBe(false);
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv[argv.indexOf('-n') + 1]).toBe('Coordinator');
    expect(argv.at(-1)).toContain('# Buildyboy coordinator');
    expect(argv.at(-1)).toContain('docs_get');
    expect(audit('coordinator_launch').at(-1)).toMatchObject({ actor: 'agent:launcher', target: launched.result.jobId });
    expect(JSON.parse(audit('coordinator_launch').at(-1)!.detail!)).toMatchObject({ decisionId: first.result.decisionId, cwd: repoA });

    // an approval is good for one launch: the same call asks again
    const again = await call('coordinator_launch', args);
    expect(again.result.status).toBe('pending_approval');
    expect(again.result.decisionId).not.toBe(first.result.decisionId);
    await web.post(`/api/decisions/${again.result.decisionId}/cancel`);
  });

  it('a refused worker launch starts nothing, and is never asked about when it would fail anyway', async () => {
    await newTask('T41');
    const asked = pending();
    expect((await call('tasks_launch', { taskId: 'T41', machineId: machine.id, cwd: outside })).status).toBe(400);
    expect(pending()).toBe(asked); // checked before the owner is bothered

    const custom = { taskId: 'T41', machineId: machine.id, cwd: repoA };
    const first = await call('tasks_launch', custom);
    expect(first.result).toMatchObject({ status: 'pending_approval', kind: 'worker' });
    const d = await web.get<any[]>('/api/decisions?status=pending').then((l) => l.find((x) => x.id === first.result.decisionId));
    expect(d).toMatchObject({ taskId: 'T41', question: 'Start a worker for T41 on hc-box?' });
    await web.post(`/api/decisions/${first.result.decisionId}/answer`, { answer: 'Refuse' });
    const before = hcRuns().length;
    expect((await call('tasks_launch', custom)).result).toMatchObject({ status: 'refused', answer: 'Refuse', decisionId: first.result.decisionId });
    expect(hcRuns()).toHaveLength(before);
    expect(await task('T41')).toMatchObject({ status: 'gata', claimedBy: null, jobId: null });
    // a later call is a new question
    const next = await call('tasks_launch', custom);
    expect(next.result.status).toBe('pending_approval');
    expect(next.result.decisionId).not.toBe(first.result.decisionId);
    await web.post(`/api/decisions/${next.result.decisionId}/cancel`);
  });

  it('shows the owner the prompt a coordinator would start with', async () => {
    const r = await call('coordinator_launch', { machineId: machine.id, cwd: repoA, prompt: 'Coordinate repo-a only.\nNever touch main.', title: 'repo-a coordinator' });
    expect(r.result.status).toBe('pending_approval');
    const d = await web.get<any[]>('/api/decisions?status=pending').then((l) => l.find((x) => x.id === r.result.decisionId));
    expect(d.context).toContain('> Coordinate repo-a only.\n> Never touch main.');
    expect(d.taskId).toBeNull();
    await web.post(`/api/decisions/${r.result.decisionId}/cancel`);
    expect((await call('coordinator_launch', { machineId: machine.id, cwd: repoA, prompt: 'Coordinate repo-a only.\nNever touch main.', title: 'repo-a coordinator' })).result)
      .toMatchObject({ status: 'refused', reason: 'the owner cancelled the question' });
  });

  it('turning launch off stops the token at once, approval or not', async () => {
    await allow('off', true);
    expect((await call('tasks_launch', { taskId: 'T41', machineId: machine.id, cwd: repoA })).status).toBe(403);
  });
});

describe('options and argv', () => {
  it('builds a coordinator terminal: its own name and a role label', () => {
    expect(checkOptions({ maxBudgetUsd: 1, role: 'coordonator' })).toEqual({ maxBudgetUsd: 1, role: 'coordonator' });
    expect(() => checkOptions({ maxBudgetUsd: 1, role: 'boss' })).toThrow(/role/);
    const a = buildHcRunArgs({ maxBudgetUsd: 1, launcher: 'hc', role: 'coordonator' }, { jobId: 'ABCD1234-ffff', cwd: '/w', title: 'Coordinator', prompt: 'go', program: ['/bin/claude'] });
    expect(a).toEqual([
      'run', '--bg', '--json', '--name', 'bb-coord-abcd1234', '--cwd', '/w', '--label', 'owner=buildyboy', '--label', 'bb.role=coordonator', '--label', 'bb.job=ABCD1234-ffff', '--no-parent',
      '/bin/claude', '-n', 'Coordinator', 'go',
    ]);
  });

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
    const a = buildHcRunArgs(o, { jobId: 'job-1', cwd: '/w', title: '-sneaky title', prompt: '- do a thing --and "quote" $(x)', program: ['/bin/claude'], pluginDirs: ['/p'] });
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
