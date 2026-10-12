// Integration: spawns the real plugin/hooks/bb-hook.mjs with fixture stdin against a test server and asserts
// its stdout JSON for every row of the SPEC §3.2 control table, plus fail-open behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import type { PendingActionView } from '../shared/types.ts';

const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'bb-hook.mjs');
let srv: TestServer;
let web: WebClient;
let token: string;
let home: string;
let n = 0;

interface HookRun {
  stdout: string;
  code: number | null;
  ms: number;
  json: any;
}

function runHook(args: string[], input: Record<string, unknown>, env: Record<string, string> = {}): Promise<HookRun> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, BUILDYBOY_HOME: home, BUILDYBOY_URL: srv.url, BUILDYBOY_TOKEN: token, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => {
      let json: any = null;
      try {
        json = out ? JSON.parse(out) : null;
      } catch {
        json = undefined;
      }
      resolve({ stdout: out, code, ms: Date.now() - t0, json });
    });
    p.stdin.end(JSON.stringify(input));
  });
}

const base = (sid: string) => ({ session_id: sid, cwd: process.cwd(), transcript_path: join(home, 'none.jsonl'), permission_mode: 'default' });

async function waitPending(sid: string, kind?: string): Promise<PendingActionView> {
  for (let i = 0; i < 200; i++) {
    const { pending } = await web.get<{ pending: PendingActionView[] }>('/api/inbox');
    const p = pending.find((x) => x.sessionId === sid && (!kind || x.kind === kind));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pending action for ${sid}`);
}

/** Sends a telemetry event so the session exists and the hook's control cache refreshes. */
async function telemetry(sid: string, event = 'SessionStart', extra: Record<string, unknown> = {}) {
  const r = await runHook([], { ...base(sid), hook_event_name: event, ...extra });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
}

function newSid() {
  return `hook-test-${++n}-${Date.now()}`;
}

beforeAll(async () => {
  srv = await startTestServer({ permissionWaitMs: 4000, stopWaitMin: 0.08, pauseWaitMs: 4000 });
  web = await srv.login();
  token = createMachine(srv.ctx, 'hook-test-machine').token;
});
afterAll(() => srv.stop());
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bb-home-'));
  await web.post('/api/global/walk', { on: true });
});

describe('§3.2 permission (walk mode on)', () => {
  const ask = (sid: string) => runHook(['--control'], { ...base(sid), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy' }], behavior: 'allow', destination: 'localSettings' }] });

  it('allow once', async () => {
    const sid = newSid();
    await telemetry(sid);
    const run = ask(sid);
    const p = await waitPending(sid, 'permission');
    expect(p.request.toolInput).toEqual({ command: 'npm run deploy' });
    await web.post(`/api/actions/${p.id}/answer`, { type: 'allow' });
    const r = await run;
    expect(r.json).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('allow for this session (updatedPermissions from permission_suggestions)', async () => {
    const sid = newSid();
    await telemetry(sid);
    const run = ask(sid);
    const p = await waitPending(sid);
    await web.post(`/api/actions/${p.id}/answer`, { type: 'allow', scope: 'session' });
    const d = (await run).json.hookSpecificOutput.decision;
    expect(d.behavior).toBe('allow');
    expect(d.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy' }], behavior: 'allow', destination: 'session' }]);
  });

  it('deny with a message, and deny + interrupt', async () => {
    const sid = newSid();
    await telemetry(sid);
    let run = ask(sid);
    let p = await waitPending(sid);
    await web.post(`/api/actions/${p.id}/answer`, { type: 'deny', message: 'not on prod' });
    expect((await run).json.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'not on prod' });
    run = ask(sid);
    p = await waitPending(sid);
    await web.post(`/api/actions/${p.id}/answer`, { type: 'deny', message: 'stop', interrupt: true });
    expect((await run).json.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'stop', interrupt: true });
  });

  it('times out to no output (local prompt applies)', async () => {
    const sid = newSid();
    await telemetry(sid);
    const r = await ask(sid);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const { history } = await web.get<{ history: PendingActionView[] }>('/api/inbox');
    expect(history.find((h) => h.sessionId === sid)?.status).toBe('timeout');
  });

  it('is superseded when the session moves on locally', async () => {
    const sid = newSid();
    await telemetry(sid);
    const run = ask(sid);
    await waitPending(sid);
    await telemetry(sid, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, tool_use_id: 'toolu_x1', tool_response: { stdout: 'ok' } });
    const r = await run;
    expect(r.stdout).toBe('');
    const { history } = await web.get<{ history: PendingActionView[] }>('/api/inbox');
    expect(history.find((h) => h.sessionId === sid)?.status).toBe('superseded');
  });

  it('returns immediately when walk mode is off', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    await telemetry(sid);
    const r = await ask(sid);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(1500);
  });
});

describe('§3.2 question and plan', () => {
  const questions = [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite', description: '' }, { label: 'Postgres', description: '' }] }];

  it('AskUserQuestion via PreToolUse returns updatedInput with answers', async () => {
    const sid = newSid();
    await telemetry(sid); // writes control.json with walk on
    const run = runHook(['--control', '--lean'], { ...base(sid), hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_q1' });
    const p = await waitPending(sid, 'question');
    await web.post(`/api/actions/${p.id}/answer`, { type: 'answers', answers: { 'Which database?': 'SQLite' } });
    expect((await run).json).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers: { 'Which database?': 'SQLite' } } } });
  });

  it('AskUserQuestion via PermissionRequest returns allow + updatedInput', async () => {
    const sid = newSid();
    await telemetry(sid);
    const run = runHook(['--control'], { ...base(sid), hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });
    const p = await waitPending(sid, 'question');
    await web.post(`/api/actions/${p.id}/answer`, { type: 'answers', answers: { 'Which database?': 'Postgres' } });
    expect((await run).json.hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which database?': 'Postgres' } } });
  });

  it('ExitPlanMode: approve and reject with feedback', async () => {
    const sid = newSid();
    await telemetry(sid);
    const plan = (s: string) => runHook(['--control'], { ...base(s), hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '1. do it' } });
    let run = plan(sid);
    let p = await waitPending(sid, 'plan');
    await web.post(`/api/actions/${p.id}/answer`, { type: 'allow' });
    expect((await run).json.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    run = plan(sid);
    p = await waitPending(sid, 'plan');
    await web.post(`/api/actions/${p.id}/answer`, { type: 'deny', message: 'add tests first' });
    expect((await run).json.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'add tests first' });
  });
});

describe('§3.2 steering, stop wait, kill and pause', () => {
  it('a queued message is delivered at the next Stop', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    await telemetry(sid);
    await web.post(`/api/sessions/${sid}/messages`, { text: 'now run the tests', mode: 'after_turn' });
    const r = await runHook(['--control'], { ...base(sid), hook_event_name: 'Stop', stop_hook_active: false });
    expect(r.json).toEqual({ decision: 'block', reason: 'now run the tests' });
    const side = await web.get<any>(`/api/sessions/${sid}/side`);
    expect(side.queued[0]).toMatchObject({ status: 'delivered', deliveredVia: 'stop' });
  });

  it('a "now" message is delivered at the next PreToolUse as additionalContext', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    await telemetry(sid);
    await web.post(`/api/sessions/${sid}/messages`, { text: 'use pnpm', mode: 'now' });
    await telemetry(sid, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'toolu_r1', tool_response: 'x' }); // refreshes control.json
    const r = await runHook(['--control', '--lean'], { ...base(sid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm i' }, tool_use_id: 'toolu_b1' });
    expect(r.json.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(r.json.hookSpecificOutput.additionalContext).toContain('use pnpm');
  });

  it('Stop holds while walk mode is on and returns my reply', async () => {
    const sid = newSid();
    await telemetry(sid);
    const run = runHook(['--control'], { ...base(sid), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All done.' });
    const p = await waitPending(sid, 'stop_wait');
    expect(p.request.lastAssistantMessage).toBe('All done.');
    await web.post(`/api/actions/${p.id}/answer`, { type: 'reply', text: 'commit and push' });
    expect((await run).json).toEqual({ decision: 'block', reason: 'commit and push' });
  });

  it('a compose-box message answers a holding Stop', async () => {
    const sid = newSid();
    await telemetry(sid);
    const run = runHook(['--control'], { ...base(sid), hook_event_name: 'Stop', stop_hook_active: false });
    await waitPending(sid, 'stop_wait');
    await web.post(`/api/sessions/${sid}/messages`, { text: 'continue', mode: 'after_turn' });
    expect((await run).json).toEqual({ decision: 'block', reason: 'continue' });
  });

  it('Stop lets the session go idle after the wait', async () => {
    const sid = newSid();
    await telemetry(sid);
    const r = await runHook(['--control'], { ...base(sid), hook_event_name: 'Stop', stop_hook_active: false });
    expect(r.stdout).toBe('');
    expect(r.ms).toBeGreaterThan(4000);
  });

  it('emergency stop: PreToolUse denies with continue:false', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    await telemetry(sid);
    await web.post(`/api/sessions/${sid}/stop`);
    await telemetry(sid, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'y' }, tool_use_id: 'toolu_r2', tool_response: 'y' });
    const r = await runHook(['--control', '--lean'], { ...base(sid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'toolu_b2' });
    expect(r.json).toEqual({ continue: false, stopReason: 'Stopped from Buildyboy', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Stopped from Buildyboy' } });
  });

  it('pause holds PreToolUse until resumed', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    await telemetry(sid);
    await web.post(`/api/sessions/${sid}/pause`);
    await telemetry(sid, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'z' }, tool_use_id: 'toolu_r3', tool_response: 'z' });
    const t0 = Date.now();
    const run = runHook(['--control', '--lean'], { ...base(sid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_b3' });
    await new Promise((r) => setTimeout(r, 800));
    await web.post(`/api/sessions/${sid}/resume`);
    const r = await run;
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeGreaterThan(700);
    expect(Date.now() - t0).toBeLessThan(3500);
  });

  it('lean PreToolUse exits without calling the server when nothing is pending', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    await telemetry(sid);
    const r = await runHook(['--control', '--lean'], { ...base(sid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_b4' }, { BUILDYBOY_URL: 'http://127.0.0.1:9' });
    expect(r.stdout).toBe('');
    expect(existsSync(join(home, 'breaker'))).toBe(false); // never touched the network
  });
});

describe('fail open', () => {
  const DOWN = 'http://127.0.0.1:9'; // nothing listens on the discard port

  it('control events print nothing, exit 0, well under 1.5 s when the server is down', async () => {
    for (const ev of ['PermissionRequest', 'Stop', 'UserPromptSubmit']) {
      const r = await runHook(['--control'], { ...base('down-1'), hook_event_name: ev, tool_name: 'Bash', tool_input: { command: 'ls' }, prompt: 'hi' }, { BUILDYBOY_URL: DOWN });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms).toBeLessThan(1500);
    }
  });

  it('a hung server costs at most ~1 s', async () => {
    const { createServer } = await import('node:net');
    const hung = createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    const port = (hung.address() as { port: number }).port;
    const r = await runHook(['--control'], { ...base('hung-1'), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, { BUILDYBOY_URL: `http://127.0.0.1:${port}` });
    hung.close();
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2000);
  });

  it('telemetry spools when down, the breaker skips the network, and the spool flushes later', async () => {
    const sid = newSid();
    const down = await runHook([], { ...base(sid), hook_event_name: 'SessionStart' }, { BUILDYBOY_URL: DOWN });
    expect(down.code).toBe(0);
    expect(existsSync(join(home, 'breaker'))).toBe(true);
    const r2 = await runHook([], { ...base(sid), hook_event_name: 'UserPromptSubmit', prompt: 'hello' }, { BUILDYBOY_URL: DOWN });
    expect(r2.ms).toBeLessThan(1500);
    const spool = readFileSync(join(home, 'spool.jsonl'), 'utf8').trim().split('\n');
    expect(spool).toHaveLength(2);
    // server back: clear the breaker (it would expire after 60 s) and send another event
    rmSync(join(home, 'breaker'));
    await telemetry(sid, 'Notification', { message: 'back', notification_type: 'idle_prompt' });
    expect(existsSync(join(home, 'spool.jsonl')) ? readFileSync(join(home, 'spool.jsonl'), 'utf8').trim() : '').toBe('');
    const events = await web.get<any[]>(`/api/sessions/${sid}/events`);
    expect(events.map((e) => e.event).sort()).toEqual(['Notification', 'SessionStart', 'UserPromptSubmit']);
  });

  it('does nothing when disabled or unconfigured', async () => {
    const r = await runHook(['--control'], { ...base('x'), hook_event_name: 'Stop' }, { BUILDYBOY_DISABLED: '1' });
    expect(r.stdout).toBe('');
    const r2 = await runHook(['--control'], { ...base('x'), hook_event_name: 'Stop' }, { BUILDYBOY_URL: '', BUILDYBOY_TOKEN: '' });
    expect(r2.stdout).toBe('');
    const bad = await runHook([], { nope: true });
    expect(bad.code).toBe(0);
  });
});

describe('transcript deltas and PROGRESS.md', () => {
  it('ships new transcript lines once, and PROGRESS.md at Stop', async () => {
    await web.post('/api/global/walk', { on: false });
    const sid = newSid();
    const dir = mkdtempSync(join(tmpdir(), 'bb-proj-'));
    const tp = join(dir, `${sid}.jsonl`);
    const line = (i: number) => JSON.stringify({ type: 'assistant', uuid: `${sid}-u${i}`, timestamp: new Date().toISOString(), message: { id: `m${i}`, content: [{ type: 'text', text: `hello ${i}` }], usage: { input_tokens: 10, output_tokens: 5 } } });
    writeFileSync(tp, `${line(1)}\n${line(2)}\n{"type":"assistant","partial`);
    writeFileSync(join(dir, 'PROGRESS.md'), '# Progress\n\n## Next\n- ship it\n');
    const ev = { session_id: sid, cwd: dir, transcript_path: tp };
    await runHook([], { ...ev, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 'toolu_t1', tool_response: 'a' });
    await runHook([], { ...ev, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'b' }, tool_use_id: 'toolu_t2', tool_response: 'b' });
    const r = await runHook(['--control'], { ...ev, hook_event_name: 'Stop', stop_hook_active: false });
    expect(r.code).toBe(0);
    const t = await web.get<any>(`/api/sessions/${sid}/timeline`);
    expect(t.items.filter((i: any) => i.kind === 'assistant').map((i: any) => i.text)).toEqual(['hello 1', 'hello 2']);
    const side = await web.get<any>(`/api/sessions/${sid}/side`);
    expect(side.progress.content).toContain('ship it');
    const offsets = JSON.parse(readFileSync(join(home, 'offsets', `${sid}.json`), 'utf8'));
    expect(offsets.offsets[tp]).toBe(Buffer.byteLength(`${line(1)}\n${line(2)}\n`));
  });
});
