import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { runWatchers, nextSection } from '../server/watchers.ts';
import { pollGithub, checksState } from '../server/github/poller.ts';
import { simulate } from '../scripts/simulate.ts';
import { S1 } from '../fixtures/scenario.ts';

let srv: TestServer;
let web: WebClient;
let token: string;
const post = (path: string, body: unknown) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const env = (sid: string, event: Record<string, unknown>, ts = Date.now()) => ({ v: 1, ts, env: {}, hostname: 'h', platform: 'linux', user: 'u', pid: 1, ppid: 1, hookVersion: 't', event: { session_id: sid, cwd: '/w/p', ...event } });

beforeAll(async () => {
  srv = await startTestServer();
  web = await srv.login();
  token = createMachine(srv.ctx, 'insights').token;
});
afterAll(() => srv.stop());

describe('OTLP receiver', () => {
  it('stores metrics and events and takes cost from api_request events', async () => {
    await post('/api/ingest', env('otel-1', { hook_event_name: 'SessionStart' }));
    const attr = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: v } });
    const logs = {
      resourceLogs: [{ resource: { attributes: [attr('service.name', 'claude-code')] }, scopeLogs: [{ logRecords: [
        { timeUnixNano: String(Date.now() * 1e6), body: { stringValue: 'claude_code.api_request' }, attributes: [attr('event.name', 'api_request'), attr('session.id', 'otel-1'), attr('cost_usd', 0.25), attr('model', 'claude-haiku')] },
        { timeUnixNano: String(Date.now() * 1e6), body: { stringValue: 'claude_code.api_request' }, attributes: [attr('event.name', 'api_request'), attr('session.id', 'otel-1'), attr('cost_usd', 0.5)] },
      ] }] }],
    };
    expect((await post('/v1/logs', logs)).status).toBe(200);
    const metrics = { resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints: [{ asInt: '1200', timeUnixNano: String(Date.now() * 1e6), attributes: [attr('session.id', 'otel-1'), attr('type', 'input')] }] } }] }] }] };
    expect((await post('/v1/metrics', metrics)).status).toBe(200);
    const s = await web.get<any>('/api/sessions/otel-1');
    expect(s.costUsd).toBeCloseTo(0.75, 5);
    expect(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM otel_points WHERE name = 'claude_code.token.usage'")!.n).toBe(1);
    expect((await fetch(`${srv.url}/v1/logs`, { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('statusline bridge endpoint', () => {
  it('updates cost, context and rate limits', async () => {
    await post('/api/ingest', env('sl-1', { hook_event_name: 'SessionStart' }));
    await post('/api/statusline', { session_id: 'sl-1', cost: { total_cost_usd: 1.23 }, context_window: { used_percentage: 42 }, rate_limits: { five_hour: { used_percentage: 81 } }, model: { display_name: 'Haiku' } });
    const s = await web.get<any>('/api/sessions/sl-1');
    expect(s.costUsd).toBeCloseTo(1.23);
    expect(s.contextPct).toBe(42);
  });
});

describe('watchers', () => {
  it('flags loops, context, budget and stale sessions once', async () => {
    srv.ctx.db.setSetting('budget_session_usd', 1);
    const t0 = Date.now() - 20 * 60_000;
    await post('/api/ingest', { envelopes: [env('w-1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, t0)] });
    for (let i = 0; i < 3; i++) {
      await post('/api/ingest', { envelopes: [
        env('w-1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `tl${i}` }, t0 + i * 1000),
        env('w-1', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `tl${i}`, error: 'Exit code 1' }, t0 + i * 1000 + 500),
      ] });
    }
    srv.ctx.db.run("UPDATE sessions SET context_pct = 91, cost_usd = 2, cost_source = 'otel' WHERE id = 'w-1'");
    runWatchers(srv.ctx);
    runWatchers(srv.ctx);
    const w = srv.ctx.db.all<{ summary: string }>("SELECT summary FROM events WHERE session_id = 'w-1' AND event = 'Watcher'").map((r) => r.summary);
    expect(w.some((s) => s.includes('failed 3 times'))).toBe(true);
    expect(w.some((s) => s.includes('Context 91%'))).toBe(true);
    expect(w.some((s) => s.includes('passed $1'))).toBe(true);
    expect(w.some((s) => s.includes('stale'))).toBe(true);
    expect(w).toHaveLength(new Set(w).size); // each fired once
    const s = await web.get<any>('/api/sessions/w-1');
    expect(s.status).toBe('stale');
    const t = await web.get<any>('/api/sessions/w-1/timeline');
    expect(t.items.some((i: any) => i.kind === 'event' && i.event === 'Watcher')).toBe(true);
  });

  it('reads the Next section of PROGRESS.md', () => {
    expect(nextSection('# P\n\n## Done\n- a\n\n## Next\n- ship it\n- then rest\n\n## Git\n- x')).toBe('- ship it\n- then rest');
    expect(nextSection('- **Done:** a\n- **Next:** open the PR\n- **Git:** b')).toBe('open the PR');
    expect(nextSection('nothing here')).toBe('');
  });
});

describe('bb import backfill', () => {
  it('creates an imported session with messages and synthesized tool calls', async () => {
    const sid = 'imp-0000-1111';
    const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'iu1', timestamp: ts(0), cwd: '/home/u/proj', entrypoint: 'cli', gitBranch: 'main', message: { role: 'user', content: 'fix the bug' } }),
      JSON.stringify({ type: 'assistant', uuid: 'ia1', timestamp: ts(5), message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 'itu1', name: 'Edit', input: { file_path: '/home/u/proj/a.ts', old_string: 'a', new_string: 'b' } }], usage: { input_tokens: 10, output_tokens: 3 } } }),
      JSON.stringify({ type: 'user', uuid: 'iu2', timestamp: ts(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'itu1', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'ia2', timestamp: ts(9), message: { id: 'm2', content: [{ type: 'text', text: 'Fixed.' }] } }),
      JSON.stringify({ type: 'some-future-type', uuid: 'iz', timestamp: ts(10) }),
    ];
    const r = await (await post('/api/import', { sessionId: sid, path: '/x/imp.jsonl', lines })).json();
    expect(r).toMatchObject({ ok: true, created: true });
    const s = await web.get<any>(`/api/sessions/${sid}`);
    expect(s).toMatchObject({ imported: true, status: 'ended', source: 'cli', branch: 'main', projectName: 'proj' });
    const t = await web.get<any>(`/api/sessions/${sid}/timeline`);
    expect(t.items.map((i: any) => i.kind)).toEqual(['prompt', 'tool', 'assistant', 'raw']);
    expect(t.items[1]).toMatchObject({ tool: 'Edit', status: 'ok', output: 'ok' });
    expect(t.items[1].patch).toContain('+b');
    // re-import is idempotent
    await post('/api/import', { sessionId: sid, lines });
    expect((await web.get<any>(`/api/sessions/${sid}/timeline`)).items).toHaveLength(4);
  });
});

describe('GitHub poller', () => {
  let gh: Server;
  beforeAll(async () => {
    gh = createServer((req, res) => {
      const u = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      if (u.includes('/pulls?')) res.end(JSON.stringify([{ number: 7, html_url: 'https://github.com/example/shop-api/pull/7', title: 'Add login rate limiting', state: 'open', merged_at: null, head: { sha: 'abc', ref: 'feat/rate-limit' } }]));
      else if (u.includes('/check-runs')) res.end(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://x' }] }));
      else if (u.includes('/reviews')) res.end(JSON.stringify([{ state: 'APPROVED' }]));
      else res.end('{}');
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    process.env.BUILDYBOY_GITHUB_API = `http://127.0.0.1:${(gh.address() as { port: number }).port}`;
  });
  afterAll(() => {
    delete process.env.BUILDYBOY_GITHUB_API;
    gh.close();
  });

  it('skips cleanly without a token', async () => {
    expect(await pollGithub(srv.ctx)).toBe('skipped');
  });

  it('links PRs to sessions by branch and records checks', async () => {
    await simulate({ url: srv.url, dataDir: srv.dataDir, log: () => {} });
    srv.ctx.db.setSetting('github_token', 'test-token');
    expect(await pollGithub(srv.ctx)).toBeGreaterThan(0);
    const side = await web.get<any>(`/api/sessions/${S1}/side`);
    expect(side.git.prs[0]).toMatchObject({ number: 7, checksState: 'failure', reviewState: 'APPROVED' });
    expect(checksState([])).toBe('none');
    expect(checksState([{ status: 'in_progress', conclusion: null }])).toBe('pending');
    expect(checksState([{ status: 'completed', conclusion: 'success' }])).toBe('success');
  });
});

describe('export', () => {
  it('exports a session as Markdown', async () => {
    const res = await fetch(`${srv.url}/api/sessions/${S1}/export.md`, { headers: { cookie: '' } });
    expect(res.status).toBe(401);
    const md = await web.text(`/api/sessions/${S1}/export.md`);
    expect(md).toContain('# Add rate limiting to login');
    expect(md).toContain('```diff');
  });
});
