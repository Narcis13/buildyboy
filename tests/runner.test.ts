// M7: runner + jobs, end to end with a fake `claude` (fixtures/fake-claude.mjs). Never touches ~/.buildyboy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { startTestServer, TEST_PASSWORD, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { dispatch, doneWhenCommands, markLostDisconnected } from '../server/jobs/core.ts';
import { cronMatches, nextRun, parseCron } from '../server/jobs/cron.ts';
import { fireSchedules } from '../server/jobs/scheduler.ts';
import { buildClaudeArgs, checkOptions } from '../runner/options.ts';
import { startRunner, type Runner } from '../runner/main.ts';
import { resolveClaude } from '../runner/claude.ts';
import type { Notification } from '../server/context.ts';

const FAKE = resolve('fixtures/fake-claude.mjs');

let srv: TestServer;
let web: WebClient;
let runner: Runner;
let machine: { id: string; token: string };
let tmp: string;
let roots: string;
let repoA: string;
let repoB: string;
let outside: string;
const notes: Notification[] = [];

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
const waitOutput = (id: string, needle: string) => waitFor(async () => (await output(id)).some((l) => l.includes(needle)), `"${needle}" in job ${id}`);
const launch = async (promptText: string, cwd: string, options: Record<string, unknown> = {}): Promise<string> =>
  (await web.post('/api/jobs', { promptText, machineId: machine.id, cwd, options })).id;
const initOf = async (id: string) => JSON.parse((await output(id)).find((l) => l.includes('"subtype":"init"'))!);

/** fetch with the web session, returning the Response (WebClient throws on non-2xx and has no DELETE) */
let rawHeaders: Record<string, string> | null = null;
async function rawCall(method: string, path: string, body?: unknown) {
  if (!rawHeaders) {
    const res = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    const csrf = cookies.find((c) => c.startsWith('bb_csrf='))!.slice('bb_csrf='.length);
    rawHeaders = { cookie: cookies.join('; '), 'x-bb-csrf': csrf, 'content-type': 'application/json' };
  }
  return fetch(`${srv.url}${path}`, { method, headers: rawHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(async () => {
  srv = await startTestServer();
  srv.ctx.notify = (n) => notes.push(n);
  web = await srv.login();
  machine = createMachine(srv.ctx, 'runner-box', { platform: process.platform });
  tmp = mkdtempSync(join(tmpdir(), 'bb-runner-'));
  const home = join(tmp, 'home');
  roots = join(tmp, 'roots');
  repoA = join(roots, 'repo-a');
  repoB = join(roots, 'repo-b');
  outside = join(tmp, 'outside');
  for (const d of [home, join(repoA, '.git'), join(repoA, 'sub'), repoB, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: srv.url, token: machine.token, machineId: machine.id }));
  writeFileSync(join(home, 'runner.json'), JSON.stringify({ allowedRoots: [roots], concurrency: 2, idleExitSeconds: 1, stopGraceSeconds: 1 }));
  process.env.BUILDYBOY_HOME = home;
  process.env.BUILDYBOY_CLAUDE_BIN = FAKE;
  delete process.env.BUILDYBOY_URL;
  delete process.env.BUILDYBOY_TOKEN;
  runner = startRunner({ log: () => {} });
  await waitFor(() => srv.ctx.runners.has(machine.id), 'runner to connect');
  await waitFor(() => srv.ctx.db.get<{ i: string | null }>('SELECT runner_info_json i FROM machines WHERE id = ?', machine.id)?.i, 'first heartbeat');
});

afterAll(async () => {
  await runner?.stop();
  await srv?.stop();
  delete process.env.BUILDYBOY_HOME;
  delete process.env.BUILDYBOY_CLAUDE_BIN;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly
  }
});

describe('runner jobs', () => {
  let first: string;

  it('runs a job: output arrives, status succeeded, cost recorded', async () => {
    first = await launch('Say hello', repoA, { model: 'sonnet', permissionMode: 'acceptEdits', maxTurns: 5, allowedTools: ['Read', 'Bash(npm test:*)'], effort: 'high' });
    const j = await waitStatus(first, 'succeeded', 'failed');
    expect(j.status).toBe('succeeded');
    expect(j.exitCode).toBe(0);
    expect(j.costUsd).toBeCloseTo(0.0123, 4);
    expect(j.result.subtype).toBe('success');
    expect(j.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(j.startedAt).toBeGreaterThan(0);
    expect(j.endedAt).toBeGreaterThanOrEqual(j.startedAt);
    const lines = await output(first);
    expect(lines.some((l) => l.includes('The project has a **README**'))).toBe(true);
    expect(lines.some((l) => l.includes('"tool_use"'))).toBe(true);
    const init = await initOf(first);
    expect(init.fake_job_id).toBe(first);
    const argv: string[] = init.fake_argv;
    expect(argv.slice(0, 7)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--input-format', 'stream-json']);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(j.sessionId);
    expect(argv[argv.indexOf('-n') + 1]).toBe('Say hello');
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--allowedTools') + 3)).toEqual(['Read', 'Bash(npm test:*)']);
    expect(notes.some((n) => n.type === 'job' && n.url === `/jobs/${first}`)).toBe(true);
    const list = await web.get('/api/jobs?status=succeeded');
    expect(list.map((x: { id: string }) => x.id)).toContain(first);
  });

  it('Spec-ify runs an Opus job with the specify schema and returns structured output', async () => {
    const { jobId } = await web.post('/api/prompts/specify', { idea: 'add CSV export', machineId: machine.id, cwd: repoA });
    const j = await waitStatus(jobId, 'succeeded', 'failed');
    expect(j.status).toBe('succeeded');
    expect(j.result.structured_output).toEqual({ goal: 'Fake goal', doneWhen: ['`npm test` passes'], scope: 'src/', spec: '# Draft spec' });
    const argv: string[] = (await initOf(jobId)).fake_argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]).required).toEqual(['goal', 'doneWhen', 'scope', 'spec']);
    await expect(web.post('/api/jobs', { machineId: machine.id, cwd: repoA, promptText: 'x', options: { maxBudgetUsd: 1, outputSchema: 'anything' } })).rejects.toThrow(/outputSchema/);
  });

  it('delivers follow-up messages over stdin', async () => {
    const id = await launch('WAIT for me', repoB);
    await waitOutput(id, 'Waiting for a follow-up');
    expect((await job(id)).status).toBe('running');
    await web.post(`/api/jobs/${id}/message`, { text: 'ping 42' });
    await waitOutput(id, 'Echo: ping 42');
    expect((await output(id)).some((l) => l.includes('"buildyboy_user"'))).toBe(true);
    const j = await waitStatus(id, 'succeeded', 'failed');
    expect(j.status).toBe('succeeded');
  });

  it('stops a job (graceful, then kills the tree)', async () => {
    const id = await launch('STUBBORN job', repoB);
    await waitOutput(id, 'Waiting for a follow-up');
    const r = await web.post(`/api/jobs/${id}/stop`);
    expect(r.delivered).toBe(true);
    const j = await waitStatus(id, 'stopped', 'failed', 'succeeded');
    expect(j.status).toBe('stopped');
  });

  it('runs one job per repo at a time', async () => {
    const a = await launch('WAIT a', repoA);
    await waitStatus(a, 'running');
    const b = await launch('WAIT b', repoA); // same cwd: the server holds it
    const c = await launch('WAIT c', join(repoA, 'sub')); // same git repo: the runner defers it
    await waitFor(async () => (await job(c)).result?.reason?.includes('another job'), 'runner to defer c');
    expect((await job(b)).status).toBe('queued');
    expect((await job(c)).status).toBe('queued');
    await web.post(`/api/jobs/${a}/stop`);
    await waitStatus(a, 'stopped');
    await waitStatus(b, 'running');
    await web.post(`/api/jobs/${b}/stop`);
    await waitStatus(b, 'stopped');
    dispatch(srv.ctx, machine.id); // the heartbeat would retry c within 15 s
    await waitStatus(c, 'running');
    await web.post(`/api/jobs/${c}/stop`);
    await waitStatus(c, 'stopped');
  });

  it('cancels a queued job without a runner round trip', async () => {
    // on a machine with no runner, so nothing can pick the job up before the stop
    const idle = createMachine(srv.ctx, 'no-runner');
    srv.ctx.db.run("INSERT INTO jobs (id, machine_id, cwd, prompt_text, options_json, status, created_at) VALUES ('q-1', ?, ?, 'x', '{\"maxBudgetUsd\":1}', 'queued', ?)", idle.id, repoA, Date.now());
    await web.post('/api/jobs/q-1/stop');
    expect((await job('q-1')).status).toBe('stopped');
  });

  it('rejects a cwd outside the allowed roots (runner side), including .. and symlink escapes', async () => {
    const out = await launch('Say hello', outside);
    expect((await waitStatus(out, 'failed')).result.reason).toMatch(/outside the runner's allowed roots/);
    const dots = await launch('Say hello', `${roots}${sep}..${sep}outside`);
    expect((await waitStatus(dots, 'failed')).result.reason).toMatch(/must not contain '\.\.'/);
    const link = join(roots, 'escape-link');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const sym = await launch('Say hello', link);
    expect((await waitStatus(sym, 'failed')).result.reason).toMatch(/outside the runner's allowed roots/);
    const rel = await launch('Say hello', 'repo-a');
    expect((await waitStatus(rel, 'failed')).result.reason).toMatch(/absolute/);
  });

  it('rejects bad option values (server and runner)', async () => {
    const bad = [
      { model: 'sonnet; rm -rf /' },
      { permissionMode: 'yolo' },
      { effort: 'extreme' },
      { maxBudgetUsd: -1 },
      { maxBudgetUsd: 0 },
      { maxBudgetUsd: '5' },
      { maxBudgetUsd: 1e9 },
      { maxTurns: 1.5 },
      { allowedTools: ['Bash(rm -rf /)$'] },
      { disallowedTools: ['--dangerously-skip-permissions'] },
      { worktree: '../evil' },
    ];
    for (const options of bad) {
      const r = await rawCall('POST', '/api/jobs', { promptText: 'x', machineId: machine.id, cwd: repoA, options });
      expect(r.status, JSON.stringify(options)).toBe(400);
    }
    expect(() => buildClaudeArgs({ model: 'opus' }, { sessionId: '00000000-0000-0000-0000-000000000000', title: 't' })).toThrow(/maxBudgetUsd/);
    expect(checkOptions({ maxBudgetUsd: 2, worktree: true, junk: 1 })).toEqual({ maxBudgetUsd: 2, worktree: true });
    // a job that skipped server validation is still refused by the runner
    srv.ctx.db.run("INSERT INTO jobs (id, machine_id, cwd, prompt_text, options_json, status, created_at) VALUES ('bad-1', ?, ?, 'x', ?, 'queued', ?)", machine.id, repoB, JSON.stringify({ maxBudgetUsd: 5, model: 'x;y' }), Date.now());
    dispatch(srv.ctx, machine.id);
    expect((await waitStatus('bad-1', 'failed')).result.reason).toMatch(/invalid model/);
  });

  it('runs verify only with confirmed: true, and stores the results', async () => {
    const ok = 'node -e "process.exit(0)"';
    const no = 'node -e "console.log(\'nope\'); process.exit(3)"';
    const r = await rawCall('POST', `/api/jobs/${first}/verify`, { commands: [ok] });
    expect(r.status).toBe(400);
    const r2 = await rawCall('POST', `/api/jobs/${first}/verify`, { commands: [ok], confirmed: 'yes' });
    expect(r2.status).toBe(400);
    expect((await job(first)).verify).toBeNull();
    // the runner refuses commands the job itself never named
    await web.post(`/api/jobs/${first}/verify`, { commands: [ok], confirmed: true });
    const refused = await waitFor(async () => (await job(first)).verify, 'verify refusal');
    expect(refused.results[0]).toMatchObject({ ok: false, output: expect.stringContaining('refused') });
    const own = await launch('Say hello', repoA, { verify: [ok, no] });
    await waitStatus(own, 'succeeded');
    await web.post(`/api/jobs/${own}/verify`, { commands: [ok, no], confirmed: true });
    const j = await waitFor(async () => (await job(own)).verify, 'verify results');
    expect(j.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, false]);
    expect(j.results[1].exitCode).toBe(3);
    expect(j.results[1].output).toContain('nope');

    const withDone = await launch('Goal: test\nDone when: `node -e "console.log(1)"` passes and `/health` returns 200\nScope: src', repoB);
    expect((await job(withDone)).verifyCommands).toEqual(['node -e "console.log(1)"']);
    expect((await job(withDone)).title).toBe('test');
    await waitStatus(withDone, 'succeeded');
  });

  it('resumes with --resume <session> and reruns with a fresh session', async () => {
    const orig = await job(first);
    const { id: resumed } = await web.post(`/api/jobs/${first}/resume`, { text: 'one more thing' });
    const r = await waitStatus(resumed, 'succeeded', 'failed');
    expect(r.status).toBe('succeeded');
    const argv: string[] = (await initOf(resumed)).fake_argv;
    expect(argv[argv.indexOf('--resume') + 1]).toBe(orig.sessionId);
    expect(argv).not.toContain('--session-id');
    expect(r.rerunOf).toBe(first);
    const { id: rerun } = await web.post(`/api/jobs/${first}/rerun`);
    const rr = await waitStatus(rerun, 'succeeded', 'failed');
    expect(rr.sessionId).not.toBe(orig.sessionId);
    expect(rr.promptText).toBe(orig.promptText);
  });

  it('reports claude agents (--bg sessions) and runner info', async () => {
    const s = await waitFor(() => srv.ctx.db.get<{ source: string; status: string; name: string }>('SELECT source, status, name FROM sessions WHERE id = ?', 'bg-fake-0001-aaaa'), 'bg session');
    expect(s).toMatchObject({ source: 'bg', status: 'working', name: 'Nightly dependency bump' });
    const done = srv.ctx.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ?', 'bg-fake-0002-bbbb');
    expect(done?.status).toBe('ended');
    const p = await web.get(`/api/runner/projects?machine=${machine.id}`);
    expect(p.runnerOnline).toBe(true);
    expect(p.allowedRoots).toEqual([resolve(roots)]);
    expect(p.recent).toContain(repoA);
    const m = (await web.get('/api/machines')).find((x: { id: string }) => x.id === machine.id);
    expect(m.runnerOnline).toBe(true);
  });

  it('only lets a machine report on its own jobs', async () => {
    const other = createMachine(srv.ctx, 'other-box');
    const res = await fetch(`${srv.url}/api/runner/jobs/${first}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
      body: JSON.stringify({ events: [{ type: 'status', status: 'failed' }] }),
    });
    expect(res.status).toBe(404);
    const anon = await fetch(`${srv.url}/api/runner/jobs/${first}/events`, { method: 'POST', body: '{}' });
    expect(anon.status).toBe(401);
    expect((await job(first)).status).toBe('succeeded');
  });

  it('marks jobs lost when their runner is gone for over 2 minutes', () => {
    const gone = createMachine(srv.ctx, 'gone-box');
    srv.ctx.db.run('UPDATE machines SET runner_seen_at = ? WHERE id = ?', Date.now() - 3 * 60_000, gone.id);
    srv.ctx.db.run("INSERT INTO jobs (id, machine_id, cwd, prompt_text, options_json, status, created_at) VALUES ('lost-1', ?, '/x', 'x', '{}', 'running', ?)", gone.id, Date.now());
    markLostDisconnected(srv.ctx);
    expect(srv.ctx.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = 'lost-1'")!.status).toBe('lost');
  });

  it('creates, fires and deletes cron schedules', async () => {
    const bad = await rawCall('POST', '/api/schedules', { cron: '61 * * * *', job: { promptText: 'x', machineId: machine.id, cwd: repoB } });
    expect(bad.status).toBe(400);
    const { id } = await web.post('/api/schedules', { cron: '* * * * *', job: { promptText: 'Say hello', machineId: machine.id, cwd: repoB } });
    const list = await web.get('/api/schedules');
    expect(list[0]).toMatchObject({ id, cron: '* * * * *', enabled: true });
    expect(list[0].nextRunAt).toBeGreaterThan(Date.now());
    const now = Date.now();
    const fired = fireSchedules(srv.ctx, now);
    expect(fired).toHaveLength(1);
    expect(fireSchedules(srv.ctx, now + 1000)).toHaveLength(0); // once per minute
    await waitStatus(fired[0], 'succeeded');
    expect((await rawCall('DELETE', `/api/schedules/${id}`)).status).toBe(200);
    expect(await web.get('/api/schedules')).toEqual([]);
  });

  it('fans one prompt out to several targets', async () => {
    const { ids } = await web.post('/api/jobs/fanout', { promptText: 'Say hello', targets: [{ machineId: machine.id, cwd: repoA }, { machineId: machine.id, cwd: repoB }], options: { maxBudgetUsd: 1 } });
    expect(ids).toHaveLength(2);
    for (const id of ids) expect((await waitStatus(id, 'succeeded', 'failed')).status).toBe('succeeded');
  });
});

describe('cron matcher', () => {
  const at = (s: string) => new Date(s);
  it('parses fields and rejects bad ones', () => {
    expect([...parseCron('*/15 2 * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('1,5-7 * * * *').minute]).toEqual([1, 5, 6, 7]);
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
    expect([...parseCron('0 0 * jan-mar mon-fri').dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * jan-mar *').month]).toEqual([1, 2, 3]);
    expect([...parseCron('10/20 * * * *').minute]).toEqual([10, 30, 50]);
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *', 'x * * * *']) expect(() => parseCron(bad), bad).toThrow();
  });
  it('matches local time', () => {
    expect(cronMatches('0 2 * * *', at('2026-10-12T02:00:30'))).toBe(true);
    expect(cronMatches('0 2 * * *', at('2026-10-12T02:01:00'))).toBe(false);
    expect(cronMatches('30 9 * * mon-fri', at('2026-10-12T09:30:00'))).toBe(true); // Monday
    expect(cronMatches('30 9 * * mon-fri', at('2026-10-11T09:30:00'))).toBe(false); // Sunday
    // day-of-month and day-of-week OR together when both are set
    expect(cronMatches('0 0 1 * 0', at('2026-10-11T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * 0', at('2026-10-01T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * 0', at('2026-10-02T00:00:00'))).toBe(false);
  });
  it('computes the next run', () => {
    expect(nextRun('0 2 * * *', at('2026-10-12T02:00:00'))!.getTime()).toBe(at('2026-10-13T02:00:00').getTime());
    expect(nextRun('*/5 * * * *', at('2026-10-12T10:03:20'))!.getTime()).toBe(at('2026-10-12T10:05:00').getTime());
    expect(nextRun('0 0 29 2 *', at('2026-03-01T00:00:00'))!.getTime()).toBe(at('2028-02-29T00:00:00').getTime());
  });
});

describe.runIf(process.platform === 'win32')('claude executable on Windows', () => {
  it('unwraps an npm .cmd shim instead of going through cmd.exe, and refuses one it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-shim-'));
    const cli = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, '');
    writeFileSync(join(dir, 'claude.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    writeFileSync(join(dir, 'weird.cmd'), '@ECHO off\r\nstart something %*\r\n');
    const prev = process.env.BUILDYBOY_CLAUDE_BIN;
    try {
      process.env.BUILDYBOY_CLAUDE_BIN = join(dir, 'claude.cmd');
      expect(resolveClaude()).toEqual({ command: process.execPath, prefix: [cli] });
      process.env.BUILDYBOY_CLAUDE_BIN = join(dir, 'weird.cmd');
      expect(() => resolveClaude()).toThrow(/without a shell/);
    } finally {
      process.env.BUILDYBOY_CLAUDE_BIN = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('done-when extraction', () => {
  it('takes backticked commands from the inline or list form', () => {
    expect(doneWhenCommands('Goal: x\nDone when: `npm test` passes and `/health` returns 200\nScope: y')).toEqual(['npm test']);
    expect(doneWhenCommands('Done when:\n  1. `npx tsc -p .` passes\n  2. `npm test` passes, see `https://x`\nScope: `ignored`')).toEqual(['npx tsc -p .', 'npm test']);
    expect(doneWhenCommands('- **Done when:** `npm run e2e` is green\n- **Scope:** `nope`')).toEqual(['npm run e2e']);
    expect(doneWhenCommands('no slot here `npm test`')).toEqual([]);
  });
});
