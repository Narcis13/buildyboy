// bb mcp offline: outbox + replay, read cache, local governor, phone alert. A real server is stopped and restarted on
// the same port; the MCP server is driven in-process over an in-memory transport, so the assertions are on what the
// model gets back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { startTestServer, type TestServer } from './helpers.ts';
import { startServer, type RunningServer } from '../server/main.ts';
import { createAgentToken, revokeAgentToken } from '../server/factory/agent.ts';
import { agentClient, createMcpServer } from '../cli/mcp.ts';
import { createResilientClient, readOutbox, type ResilientClient } from '../cli/outbox.ts';

let home: string;
let prevHome: string | undefined;
let srv: TestServer;
let live: RunningServer; // the server currently listening (the test server, or its restart)
let url: string;
let port: number;
let token: string;
const layers: ResilientClient[] = [];
const closers: (() => Promise<void>)[] = [];

const file = (f: string) => join(home, f);
let up = true;
const stop = async () => {
  up = false;
  await live.close();
};
const restart = async () => {
  up = true;
  live = await startServer({ port, dataDir: srv.dataDir }, { quiet: true, background: false });
};
const count = (sql: string, ...p: (string | number)[]) => live.ctx.db.get<{ n: number }>(sql, ...p)!.n;

interface Model {
  text: string;
  isError: boolean;
  json: any;
}
/** An MCP client wired in-process to bb mcp's server; returns what the model would see. */
async function connect(opts: { token?: string; now?: () => number; ntfyFetch?: typeof fetch } = {}) {
  const client = agentClient(url, opts.token ?? token);
  const layer = createResilientClient(client, { url, now: opts.now, ntfyFetch: opts.ntfyFetch, replayIntervalMs: 60_000 });
  layers.push(layer);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(client, layer);
  const mcp = new Client({ name: 'outbox-test', version: '1.0.0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  closers.push(async () => {
    await mcp.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Model> => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join('\n');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // an error message
    }
    return { text, isError: !!r.isError, json };
  };
  return { call, layer };
}

const writeSample = (pct: number, ts = Date.now()) => {
  mkdirSync(file('statusline'), { recursive: true });
  writeFileSync(file('statusline/latest.json'), JSON.stringify({ ts, session_id: 'sess-1', rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 7200 } } }));
};

beforeAll(async () => {
  prevHome = process.env.BUILDYBOY_HOME;
  home = mkdtempSync(join(tmpdir(), 'bb-outbox-home-'));
  process.env.BUILDYBOY_HOME = home;
  srv = await startTestServer();
  live = srv;
  url = srv.url;
  port = srv.port;
  token = createAgentToken(srv.ctx, 'outbox-test').token;
  const post = (tool: string, body: unknown) => fetch(`${url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('tasks_create', { id: 'O1', title: 'Offline package', status: 'gata' })).ok).toBe(true);
});

afterAll(async () => {
  for (const l of layers) l.stop();
  for (const c of closers) await c().catch(() => undefined);
  if (up) await live.close().catch(() => undefined);
  rmSync(srv.dataDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.BUILDYBOY_HOME;
  else process.env.BUILDYBOY_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('bb mcp offline', () => {
  it('(b) reads answered while the server is up are served stale when it is stopped', async () => {
    const m = await connect();
    const fresh = await m.call('tasks_get', { id: 'O1' });
    expect(fresh.isError).toBe(false);
    expect(fresh.json.stale).toBeUndefined();
    const gov = await m.call('governor_get');
    expect(gov.json.thresholds).toBeDefined();
    const list = await m.call('tasks_list', {});
    expect(Array.isArray(list.json)).toBe(true);

    await stop();

    const stale = await m.call('tasks_get', { id: 'O1' });
    expect(stale.isError).toBe(false);
    expect(stale.json).toMatchObject({ stale: true, id: 'O1', title: 'Offline package' });
    expect(stale.json.staleAgeMs).toBeGreaterThanOrEqual(0);
    // an array result is wrapped
    const staleList = await m.call('tasks_list', {});
    expect(staleList.json).toMatchObject({ stale: true, result: expect.any(Array) });
    // never answered before: a clear error
    const none = await m.call('tasks_get', { id: 'never-asked' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^tasks_get failed: server unreachable \(/);
    // governor_get falls back to the local computation (no sample yet: the cache's thresholds, no data)
    const offGov = await m.call('governor_get');
    expect(offGov.json).toMatchObject({ local: true, stale: true, canStart: false });
    expect(offGov.json.reason).toMatch(/^local \(server unreachable\): /);
    expect(offGov.json.staleSince).toEqual(expect.any(Number));
    // control_get with ack is never answered from the cache
    expect((await m.call('control_get', { ack: true })).isError).toBe(true);
  });

  it('(c) governor_get offline is computed from the local statusline sample', async () => {
    const m = await connect();
    writeSample(90);
    const high = await m.call('governor_get');
    expect(high.isError).toBe(false);
    expect(high.json).toMatchObject({ canStart: false, stopAll: false, local: true, stale: true });
    expect(high.json.reason).toMatch(/^local \(server unreachable\): 5-hour window at 90%/);
    expect(high.json.usage).toMatchObject({ sessionId: 'sess-1', fiveHour: { pct: 90 } });
    writeSample(20);
    const low = await m.call('governor_get');
    expect(low.json).toMatchObject({ canStart: true, local: true });
    expect(low.json.reason).toMatch(/^local \(server unreachable\): ok: 5-hour 20%/);
    rmSync(file('statusline/latest.json'));
  });

  it('(d) tasks_claim and decision_ask offline fail and are not queued', async () => {
    const m = await connect();
    const claim = await m.call('tasks_claim', { id: 'O1' });
    expect(claim.isError).toBe(true);
    expect(claim.text).toMatch(/^tasks_claim failed: server unreachable \(.*\); not queued because its answer is needed now$/);
    expect((await m.call('decision_ask', { question: 'Ship it?' })).isError).toBe(true);
    expect(existsSync(file('outbox.jsonl'))).toBe(false);
  });

  it('(a) gates_record, tasks_update and digest_post are queued offline and land exactly once after the server is back', async () => {
    const m = await connect();
    const png = join(home, 'shot.png');
    writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

    const g = await m.call('gates_record', { taskId: 'O1', gate: 'G1', verdict: 'pass', summary: 'green offline', screenshots: [{ name: 'p', path: png }] });
    const u1 = await m.call('tasks_update', { id: 'O1', status: 'in_lucru', note: 'offline-1' });
    const u2 = await m.call('tasks_update', { id: 'O1', costUsd: 1.5, note: 'offline-2' });
    const d = await m.call('digest_post', { note: 'offline digest' });
    for (const r of [g, u1, u2, d]) {
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({ queued: true, key: expect.any(String), queuedAt: expect.any(Number), reason: expect.stringMatching(/fetch failed|ECONNREFUSED/) });
    }
    expect(g.json.tool).toBe('gates_record');
    const queued = readOutbox();
    expect(queued.map((i) => i.tool)).toEqual(['gates_record', 'tasks_update', 'tasks_update', 'digest_post']);
    expect(new Set(queued.map((i) => i.key)).size).toBe(4);
    // screenshots were inlined before queueing
    expect((queued[0]!.args as any).screenshots[0]).toMatchObject({ name: 'p', base64: expect.any(String), mime: 'image/png' });
    expect((queued[0]!.args as any).screenshots[0].path).toBeUndefined();
    const lines = readFileSync(file('outbox.jsonl'), 'utf8');

    await restart();

    // two replays at once in this process share one run
    const [r1, r2] = await Promise.all([m.layer.replay(), m.layer.replay()]);
    expect(r1).toBe(r2);
    expect(r1).toMatchObject({ sent: 4, rejected: 0, remaining: 0, unreachable: null });
    expect(existsSync(file('outbox.jsonl'))).toBe(false);

    const landed = () => ({
      gates: count('SELECT COUNT(*) n FROM gate_results WHERE task_id = ?', 'O1'),
      shots: count('SELECT COUNT(*) n FROM gate_shots'),
      inLucru: count("SELECT COUNT(*) n FROM task_events WHERE task_id = ? AND kind = 'status' AND to_status = 'in_lucru'", 'O1'),
      digests: count('SELECT COUNT(*) n FROM digests'),
    });
    expect(landed()).toEqual({ gates: 1, shots: 1, inLucru: 1, digests: 1 });
    const task = live.ctx.db.get<{ status: string; note: string | null; cost_usd: number | null }>('SELECT status, note, cost_usd FROM tasks WHERE id = ?', 'O1')!;
    expect(task).toMatchObject({ status: 'in_lucru', note: 'offline-2' });

    // the same lines again (another process replaying, or a stale copy of the file): the key makes it harmless
    appendFileSync(file('outbox.jsonl'), lines);
    expect(await m.layer.replay()).toMatchObject({ sent: 4, remaining: 0 });
    expect(landed()).toEqual({ gates: 1, shots: 1, inLucru: 1, digests: 1 });
    // two processes replaying the same file at the same time
    appendFileSync(file('outbox.jsonl'), lines);
    const other = createResilientClient(agentClient(url, token), { url });
    layers.push(other);
    await Promise.all([m.layer.replay(), other.replay()]);
    expect(landed()).toEqual({ gates: 1, shots: 1, inLucru: 1, digests: 1 });
    expect(readOutbox()).toEqual([]);

    // back online: reads are live again, a direct queueable call goes straight through
    expect((await m.call('tasks_get', { id: 'O1' })).json.stale).toBeUndefined();
    expect((await m.call('digest_post', { note: 'live' })).json.queued).toBeUndefined();
    expect(landed().digests).toBe(2);
  });

  it('a call made while earlier ones are queued waits behind them, in order', async () => {
    const m = await connect();
    await stop();
    await m.call('tasks_update', { id: 'O1', note: 'first-queued' });
    const second = await m.call('tasks_update', { id: 'O1', note: 'second-queued' });
    expect(second.json.queued).toBe(true);
    expect(readOutbox().map((i) => (i.args as any).note)).toEqual(['first-queued', 'second-queued']);
    await restart();
    // the next call replays first, then sends itself: all three land, oldest first
    const third = await m.call('tasks_update', { id: 'O1', note: 'third-direct' });
    expect(third.isError).toBe(false);
    expect(third.json.queued).toBeUndefined();
    expect(readOutbox()).toEqual([]);
    expect(live.ctx.db.get<{ note: string }>('SELECT note FROM tasks WHERE id = ?', 'O1')!.note).toBe('third-direct');
  });

  it('an item the server rejects is moved to outbox.rejected.jsonl and does not block the rest', async () => {
    const m = await connect();
    await stop();
    await m.call('tasks_update', { id: 'NO-SUCH-TASK', note: 'x' });
    await m.call('digest_post', { note: 'after the bad one' });
    expect(readOutbox()).toHaveLength(2);
    await restart();
    const digestsBefore = count('SELECT COUNT(*) n FROM digests');
    expect(await m.layer.replay()).toMatchObject({ sent: 1, rejected: 1, remaining: 0 });
    expect(count('SELECT COUNT(*) n FROM digests')).toBe(digestsBefore + 1);
    const rejected = readFileSync(file('outbox.rejected.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ tool: 'tasks_update', status: 404, error: expect.any(String) });
  });

  it('(e) a revoked token returns unauthorized and nothing is queued', async () => {
    const t = createAgentToken(live.ctx, 'to-revoke');
    revokeAgentToken(live.ctx, t.id);
    const m = await connect({ token: t.token });
    for (const [name, args] of [['tasks_get', { id: 'O1' }], ['tasks_update', { id: 'O1', note: 'nope' }], ['digest_post', {}]] as const) {
      const r = await m.call(name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toBe(`${name} failed: unauthorized`);
    }
    expect(existsSync(file('outbox.jsonl'))).toBe(false);
  });

  it('(f) ntfy: one message after 10 minutes unreachable, one when it is back', async () => {
    rmSync(file('mcp-state.json'), { force: true });
    writeFileSync(file('config.json'), JSON.stringify({ ntfyTopic: 'bb-test-topic' }));
    const sent: { url: string; title: string; body: string }[] = [];
    const ntfyFetch = (async (u: string, init: RequestInit) => {
      sent.push({ url: u, title: (init.headers as Record<string, string>).Title!, body: String(init.body) });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    let skew = 0;
    const m = await connect({ now: () => Date.now() + skew, ntfyFetch });
    await stop();

    await m.call('tasks_get', { id: 'O1' });
    await m.layer.flush();
    expect(sent).toHaveLength(0); // just went down
    expect(JSON.parse(readFileSync(file('mcp-state.json'), 'utf8')).downSince).toEqual(expect.any(Number));

    skew = 9 * 60_000;
    await m.call('tasks_get', { id: 'O1' });
    await m.layer.flush();
    expect(sent).toHaveLength(0);

    skew = 11 * 60_000;
    await m.call('tasks_update', { id: 'O1', note: 'queued during the outage' }); // a queued call counts in the message
    await m.layer.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://ntfy.sh/bb-test-topic', title: 'Buildyboy server unreachable' });
    expect(sent[0]!.body).toContain(`The Buildyboy server at ${url} has been unreachable since`);
    expect(sent[0]!.body).toMatch(/1 call queued/);

    skew = 20 * 60_000;
    await m.call('tasks_get', { id: 'O1' });
    await m.layer.flush();
    expect(sent).toHaveLength(1); // not a second one

    await restart();
    await m.call('tasks_get', { id: 'O1' });
    await m.layer.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ url: 'https://ntfy.sh/bb-test-topic', title: 'Buildyboy server is back' });
    expect(existsSync(file('mcp-state.json'))).toBe(false);
    await m.call('tasks_get', { id: 'O1' });
    await m.layer.flush();
    expect(sent).toHaveLength(2);
  });

  it('no back message when the down message was never sent', async () => {
    rmSync(file('mcp-state.json'), { force: true });
    writeFileSync(file('config.json'), JSON.stringify({ ntfyTopic: 'https://ntfy.example.com/mine' }));
    const sent: string[] = [];
    const ntfyFetch = (async (u: string) => {
      sent.push(u);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const m = await connect({ ntfyFetch });
    await stop();
    await m.call('tasks_get', { id: 'O1' });
    await restart();
    await m.call('tasks_get', { id: 'O1' });
    await m.layer.flush();
    expect(sent).toEqual([]);
  });
});
