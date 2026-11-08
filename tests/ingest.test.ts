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
    const r = await fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ envelopes: [env, { ...env, event: { session_id: 'other-own-1', hook_event_name: 'SessionStart' } }] }) });
    // the foreign event is skipped, the rest of the batch still lands
    expect(await r.json()).toMatchObject({ accepted: 1, rejected: 1 });
    expect(srv.ctx.db.get<{ machine_id: string }>('SELECT machine_id FROM sessions WHERE id = ?', S1)!.machine_id).not.toBe(other.id);
    const hook = await fetch(`${srv.url}/api/hook/Stop`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify(env) });
    expect(hook.status).toBe(403);
  });

  it('requires login and CSRF for web routes', async () => {
    expect((await fetch(`${srv.url}/api/sessions`)).status).toBe(401);
    const login = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect(login.status).toBe(401);
  });
});

describe('tool calls refused before they run', () => {
  // Claude Code sends only PreToolUse for a call a hook (exit 2 / deny) or a deny rule refuses: no Post*, no PermissionDenied.
  const T0 = 1_800_000_000_000;
  const ingest = async (sid: string, events: { ts: number; event: Record<string, unknown>; transcripts?: unknown[] }[]) => {
    const envelopes = events.map((x) => ({ v: 1, hostname: 'h', platform: 'linux', user: 'u', pid: 1, ppid: 1, hookVersion: 't', ts: x.ts, env: {}, transcripts: x.transcripts, event: { session_id: sid, ...x.event } }));
    const r = await fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${tokens.A.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ envelopes }) });
    expect(r.ok).toBe(true);
  };
  const pre = (ts: number, id: string, tool: string, extra: Record<string, unknown> = {}) => ({ ts, event: { hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: { command: 'x', file_path: '/x' }, ...extra } });
  const post = (ts: number, id: string, tool: string, transcripts?: unknown[]) => ({ ts, transcripts, event: { hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: id, tool_input: { command: 'x' }, tool_response: { stdout: 'ok' } } });
  const status = (id: string) => srv.ctx.db.get<{ status: string; output_text: string | null }>('SELECT status, output_text FROM tool_calls WHERE tool_use_id = ?', id);

  it('a Write blocked by a hook and a push refused by deny end blocked, not running', async () => {
    const sid = 'blocked-belt-1';
    await ingest(sid, [
      { ts: T0, event: { hook_event_name: 'SessionStart', source: 'startup' } },
      pre(T0 + 1000, 'bw-1', 'Write'), // a PreToolUse hook exits 2
      pre(T0 + 6000, 'bp-1', 'Bash'), // `git push --force --dry-run`, refused by a deny rule
      { ts: T0 + 9000, event: { hook_event_name: 'Stop' } },
    ]);
    expect(status('bw-1')!.status).toBe('blocked');
    expect(status('bp-1')!.status).toBe('blocked');
    const belt = (await web.get<SessionSummary[]>('/api/sessions')).find((s) => s.id === sid)!.belt;
    expect(belt.map((t) => t.status)).toEqual(['blocked', 'blocked']);
  });

  it('the transcript closes a refused call with its reason; real results still win', async () => {
    const sid = 'blocked-belt-2';
    const result = (id: string, text: string) => JSON.stringify({ type: 'user', uuid: `u-${id}`, timestamp: new Date(T0 + 3000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });
    await ingest(sid, [
      pre(T0 + 1000, 'tw-1', 'Write'),
      pre(T0 + 2000, 'tr-1', 'Read'),
      post(T0 + 4000, 'tr-1', 'Read', [{ path: '/t.jsonl', offset: 0, lines: [result('tw-1', 'PreToolUse:Write hook error: blocked by test hook')] }]),
    ]);
    expect(status('tw-1')).toEqual({ status: 'blocked', output_text: 'PreToolUse:Write hook error: blocked by test hook' });
    expect(status('tr-1')!.status).toBe('ok');
    // a late PostToolUse for a call the safety net closed puts it right
    await ingest(sid, [pre(T0 + 5000, 'tb-1', 'Bash'), pre(T0 + 9000, 'tb-2', 'Bash')]);
    expect(status('tb-1')!.status).toBe('blocked');
    await ingest(sid, [post(T0 + 9500, 'tb-1', 'Bash')]);
    expect(status('tb-1')!.status).toBe('ok');
    // the reason riding on the next PreToolUse still lands after the safety net closed the call
    const denied = 'Permission to use Bash with command git push --force --dry-run has been denied.';
    await ingest(sid, [pre(T0 + 20_000, 'tb-3', 'Bash'), { ...pre(T0 + 25_000, 'tb-4', 'Read'), transcripts: [{ path: '/t.jsonl', offset: 1, lines: [result('tb-3', denied)] }] }]);
    expect(status('tb-3')).toEqual({ status: 'blocked', output_text: denied });
  });

  it('parallel calls and subagent calls are not closed by a sibling PreToolUse', async () => {
    const sid = 'blocked-belt-3';
    await ingest(sid, [
      pre(T0 + 1000, 'pa-1', 'Agent'),
      pre(T0 + 1050, 'pa-2', 'Agent'), // same assistant message
      pre(T0 + 30_000, 'ps-1', 'Bash', { agent_id: 'sub-1' }), // inside the first subagent
    ]);
    expect([status('pa-1')!.status, status('pa-2')!.status, status('ps-1')!.status]).toEqual(['running', 'running', 'running']);
    await ingest(sid, [{ ts: T0 + 40_000, event: { hook_event_name: 'SubagentStop', agent_id: 'sub-1' } }]);
    expect([status('pa-1')!.status, status('ps-1')!.status]).toEqual(['running', 'blocked']);
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

describe('worktree sessions', () => {
  const env = (sid: string, ts: number, git: Record<string, unknown>) => ({ v: 1, hostname: 'h', platform: 'win32', user: 'u', pid: 1, ppid: 1, hookVersion: 't', ts, env: {}, git, event: { session_id: sid, hook_event_name: 'SessionStart', cwd: git.root, source: 'startup' } });
  const send = async (envelopes: unknown[]) => {
    const r = await fetch(`${srv.url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${tokens.A.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ envelopes }) });
    expect(r.ok).toBe(true);
  };
  const projectOf = (sid: string) => srv.ctx.db.get<{ root_path: string; name: string }>('SELECT p.root_path, p.name FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?', sid)!;

  it('files a worktree session under the main checkout; without mainRoot (old plugin) it keeps the worktree folder', async () => {
    const remote = 'https://github.com/o/arond-like.git';
    await send([
      env('wt-new-1', 1_800_000_000_000, { root: 'C:/w/arond-wt/proba', mainRoot: 'C:/w/arond', worktree: true, remote, branch: 'proba' }),
      env('wt-old-1', 1_800_000_000_000, { root: 'C:/w/arond-wt/veche', worktree: true, remote, branch: 'veche' }),
    ]);
    expect(projectOf('wt-new-1')).toEqual({ root_path: 'C:/w/arond', name: 'arond' });
    expect(projectOf('wt-old-1')).toEqual({ root_path: 'C:/w/arond-wt/veche', name: 'veche' });
    // later events carry no git info (cwd and CLAUDE_PROJECT_DIR are the worktree): no project appears for the folder
    await send([{ ...env('wt-new-1', 1_800_000_001_000, {}), git: undefined, env: { CLAUDE_PROJECT_DIR: 'C:/w/arond-wt/proba' }, event: { session_id: 'wt-new-1', hook_event_name: 'UserPromptSubmit', prompt: 'x', cwd: 'C:/w/arond-wt/proba' } }]);
    expect(projectOf('wt-new-1').root_path).toBe('C:/w/arond');
    expect(srv.ctx.db.get("SELECT 1 FROM projects WHERE root_path = 'C:/w/arond-wt/proba'")).toBeUndefined();
  });

  it('migration 006 re-attaches worktree projects it can tie to one main project and leaves the rest', async () => {
    const { DB } = await import('../server/db.ts');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'bb-mig-')), 'db.sqlite');
    let db = new DB(path);
    db.run("INSERT INTO machines (id, name, first_seen) VALUES ('m1', 'pc', 0), ('m2', 'other', 0)");
    const project = (id: number, machine: string, root: string, remote: string | null) =>
      db.run('INSERT INTO projects (id, machine_id, root_path, name, git_remote) VALUES (?, ?, ?, ?, ?)', id, machine, root, root.split('/').pop()!, remote);
    const R = 'https://github.com/o/arond.git';
    project(1, 'm1', 'C:/w/arond', R); // main checkout
    project(2, 'm1', 'C:/w/arond-wt/proba-fabrica', R); // worktree: ties to 1
    project(3, 'm1', 'C:/w/other-wt/x', null); // worktree without a remote: left alone
    project(4, 'm2', 'D:/arond-wt/y', R); // worktree on another machine with no main project there: left alone
    project(5, 'm1', 'C:/w/lib-wt/z', 'https://github.com/o/lib.git'); // two main candidates: left alone
    project(6, 'm1', 'C:/w/lib', 'https://github.com/o/lib.git');
    project(7, 'm1', 'C:/w/lib-copy', 'https://github.com/o/lib.git');
    project(8, 'm1', 'C:/w/mono', 'https://github.com/o/mono.git'); // a normal checkout only ever used from a subfolder,
    project(9, 'm1', 'C:/w/mono-copy', 'https://github.com/o/mono.git'); // which older hooks flagged `worktree: true`
    let n = 0;
    const session = (pid: number, machine: string, worktree: boolean | null, cwd = 'C:\\w\\r') => {
      const sid = `mig-${++n}`;
      db.run("INSERT INTO sessions (id, machine_id, project_id, cwd, status, started_at, last_event_at) VALUES (?, ?, ?, 'c', 'idle', 0, 0)", sid, machine, pid);
      const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd, _git: worktree === null ? null : { root: 'C:/w/r', worktree } });
      db.run("INSERT INTO events (hash, session_id, ts, event, payload_json) VALUES (?, ?, 0, 'SessionStart', ?)", `h-${sid}`, sid, payload);
      return sid;
    };
    const main = session(1, 'm1', false);
    const wt = [session(2, 'm1', true), session(2, 'm1', true)];
    const left = [session(3, 'm1', true), session(4, 'm2', true), session(5, 'm1', true)];
    session(6, 'm1', false);
    session(7, 'm1', false);
    left.push(session(8, 'm1', true, 'C:\\w\\r\\packages\\api'));
    session(9, 'm1', false);
    db.run("INSERT INTO commits (sha, project_id, session_id, ts) VALUES ('abc', 2, ?, 0)", wt[0]);
    db.run("INSERT INTO pull_requests (project_id, number, url, session_id, updated_at) VALUES (2, 1, 'https://github.com/o/arond/pull/1', ?, 0)", wt[0]);
    db.run("DELETE FROM schema_migrations WHERE name = '006_worktree_projects.sql'");
    db.close();
    db = new DB(path); // runs 006 again on this data
    const pid = (sid: string) => db.get<{ project_id: number }>('SELECT project_id FROM sessions WHERE id = ?', sid)!.project_id;
    expect([pid(main), ...wt.map(pid)]).toEqual([1, 1, 1]);
    expect(left.map(pid)).toEqual([3, 4, 5, 8]);
    expect(db.get('SELECT project_id FROM commits')).toEqual({ project_id: 1 });
    expect(db.get('SELECT project_id FROM pull_requests')).toEqual({ project_id: 1 });
    expect(db.all<{ id: number }>('SELECT id FROM projects ORDER BY id').map((p) => p.id)).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
    db.close();
  });
});
