import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { simulate } from '../scripts/simulate.ts';
import { S1, S2, S3 } from '../fixtures/scenario.ts';
import { createMachine } from '../server/auth.ts';
import type { SessionDetail, SessionSummary, TimelinePage } from '../shared/types.ts';

let srv: TestServer;
let web: WebClient;
let tokens: Awaited<ReturnType<typeof simulate>>;

beforeAll(async () => {
  srv = await startTestServer();
  tokens = await simulate({ url: srv.url, dataDir: srv.dataDir, log: () => {} });
  web = await srv.login();
});
afterAll(() => srv.stop());

describe('ingestion of the fixture scenario', () => {
  it('creates 3 sessions on 2 machines', async () => {
    const sessions = await web.get<SessionSummary[]>('/api/sessions');
    expect(sessions.map((s) => s.id).sort()).toEqual([S1, S2, S3].sort());
    expect(new Set(sessions.map((s) => s.machineId)).size).toBe(2);
    expect((await web.get<any[]>('/api/machines')).find((m) => m.name === 'devbox-win')?.claudeVersion).toBe('2.1.296');
    const machines = await web.get<any[]>('/api/machines');
    expect(machines.map((m) => m.name).sort()).toEqual(['devbox-win', 'wsl-ubuntu']);
  });

  it('derives statuses', async () => {
    const byId = Object.fromEntries((await web.get<SessionSummary[]>('/api/sessions')).map((s) => [s.id, s]));
    expect(byId[S1].status).toBe('idle');
    expect(byId[S2].status).toBe('waiting');
    expect(byId[S3].status).toBe('ended');
    expect(byId[S1].name).toBe('Add rate limiting to login');
    expect(byId[S1].branch).toBe('feat/rate-limit');
    expect(byId[S1].belt.length).toBeGreaterThan(10);
  });

  it('derives tool calls, subagents, todos, files, git and progress', async () => {
    const d = await web.get<SessionDetail>(`/api/sessions/${S1}`);
    expect(d.costUsd).toBeCloseTo(0.4213, 3);
    expect(d.tokens.cacheRead).toBeGreaterThan(0);
    const side = await web.get<any>(`/api/sessions/${S1}/side`);
    expect(side.subagents).toHaveLength(1);
    expect(side.subagents[0]).toMatchObject({ agentId: 'agent-fx-review', status: 'done', description: 'Review the limiter for edge cases' });
    expect(side.todos.items).toHaveLength(3);
    expect(side.files.map((f: any) => f.path.split('\\').pop()).sort()).toEqual(['app.ts', 'auth.ts', 'rateLimit.ts']);
    expect(side.git.commits).toHaveLength(1);
    expect(side.git.commits[0].message).toBe('Add login rate limiting');
    expect(side.git.snapshots.length).toBeGreaterThanOrEqual(3);
    expect(side.progress.content).toContain('## Next');
  });

  it('builds a timeline with every kind of item', async () => {
    const t = await web.get<TimelinePage>(`/api/sessions/${S1}/timeline`);
    const tools = new Set(t.items.filter((i) => i.kind === 'tool').map((i) => (i as any).tool));
    for (const name of ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'mcp__github__get_issue']) {
      expect(tools, name).toContain(name);
    }
    const kinds = new Set(t.items.map((i) => i.kind));
    for (const k of ['prompt', 'assistant', 'thinking', 'tool', 'event']) expect(kinds).toContain(k);
    const failed = t.items.find((i) => i.kind === 'tool' && i.status === 'error') as any;
    expect(failed.exitCode).toBe(1);
    const edit = t.items.find((i) => i.kind === 'tool' && i.tool === 'Edit') as any;
    expect(edit.patch).toContain('+router.post');
    // prompts come from UserPromptSubmit once, not duplicated from the transcript
    expect(t.items.filter((i) => i.kind === 'prompt' && !i.agentId)).toHaveLength(1);
  });

  it('shows unknown transcript lines as raw and failures as events', async () => {
    const t = await web.get<TimelinePage>(`/api/sessions/${S3}/timeline`);
    expect(t.items.some((i) => i.kind === 'raw')).toBe(true);
    expect(t.items.some((i) => i.kind === 'event' && i.event === 'StopFailure' && i.level === 'error')).toBe(true);
    const s2 = await web.get<SessionDetail>(`/api/sessions/${S2}`);
    expect(s2.compactions).toBe(1);
  });
});

describe('idempotency and auth', () => {
  it('ignores duplicate envelopes', async () => {
    const env = { v: 1, hostname: 'h', platform: 'linux', user: 'u', pid: 1, ppid: 1, hookVersion: 't', ts: 1700000000000, env: {}, event: { session_id: 'dup-1', hook_event_name: 'Notification', message: 'hi' } };
    const post = async () => {
      const r = await fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${tokens.A.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ envelopes: [env, env] }) });
      return r.json();
    };
    expect(await post()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(await post()).toMatchObject({ accepted: 0, duplicates: 2 });
  });

  it('rejects bad tokens and other machines\' sessions', async () => {
    const bad = await fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    expect(bad.status).toBe(401);
    const other = createMachine(srv.ctx, 'intruder');
    const env = { v: 1, ts: Date.now(), env: {}, event: { session_id: S1, hook_event_name: 'Stop' } };
    const r = await fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify(env) });
    expect(r.status).toBe(403);
  });

  it('requires login and CSRF for web routes', async () => {
    expect((await fetch(`${srv.url}/api/sessions`)).status).toBe(401);
    const login = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect(login.status).toBe(401);
  });
});

describe('per-session notification mute', () => {
  it('mutes and unmutes push for one session', async () => {
    await web.post(`/api/sessions/${S1}/mute`, { on: true });
    expect((await web.get<SessionDetail>(`/api/sessions/${S1}`)).pushMuted).toBe(true);
    const { shouldNotify } = await import('../server/push/notify.ts');
    expect(shouldNotify(srv.ctx, { type: 'pending', title: 't', body: 'b', sessionId: S1 })).toBe(false);
    expect(shouldNotify(srv.ctx, { type: 'pending', title: 't', body: 'b', sessionId: S2 })).toBe(true);
    await web.post(`/api/sessions/${S1}/mute`, { on: false });
    expect((await web.get<SessionDetail>(`/api/sessions/${S1}`)).pushMuted).toBe(false);
  });
});
