import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { DEFAULT_THRESHOLDS, evaluate, governor } from '../server/factory/governor.ts';
import { maybeDailyDigest, scheduledAt } from '../server/factory/digest.ts';
import { factoryChecks } from '../cli/doctor.ts';
import { tasksCli } from '../cli/tasks.ts';
import { acceptanceSection, orderByDeps, parseTaskFile, TaskFileError } from '../shared/tasks-md.ts';
import type { Usage } from '../shared/factory.ts';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const H = 3600_000;
const usage = (u: Partial<Usage>): Usage => ({ fiveHour: null, sevenDay: null, updatedAt: NOW - 60_000, ageMs: 60_000, sessionId: 's', ...u });

describe('governor', () => {
  it('(a) 5-hour window at or above 85%: no new workers until it resets', () => {
    const v = evaluate(usage({ fiveHour: { pct: 85, resetsAt: NOW + 2 * H }, sevenDay: { pct: 40, resetsAt: NOW + 72 * H } }), DEFAULT_THRESHOLDS, NOW);
    expect(v).toMatchObject({ canStart: false, stopAll: false, waitUntil: NOW + 2 * H });
    expect(v.reason).toMatch(/5-hour window at 85%/);
    expect(evaluate(usage({ fiveHour: { pct: 84.9, resetsAt: NOW + 2 * H } }), DEFAULT_THRESHOLDS, NOW).canStart).toBe(true);
  });

  it('(b) 7-day window at or above 80%: stop everything until it resets', () => {
    const v = evaluate(usage({ fiveHour: { pct: 90, resetsAt: NOW + H }, sevenDay: { pct: 80, resetsAt: NOW + 50 * H } }), DEFAULT_THRESHOLDS, NOW);
    expect(v).toMatchObject({ canStart: false, stopAll: true, waitUntil: NOW + 50 * H });
    expect(v.reason).toMatch(/7-day window at 80%/);
  });

  it('(c) a window missing from the data is ignored', () => {
    expect(evaluate(usage({ sevenDay: { pct: 10, resetsAt: NOW + H } }), DEFAULT_THRESHOLDS, NOW)).toMatchObject({ canStart: true, stopAll: false, waitUntil: null });
    expect(evaluate(usage({ fiveHour: { pct: 50, resetsAt: NOW + H } }), DEFAULT_THRESHOLDS, NOW)).toMatchObject({ canStart: true, stopAll: false });
    // both absent but the data is fresh (e.g. after a plan change): nothing to hold the factory back
    const none = evaluate(usage({}), DEFAULT_THRESHOLDS, NOW);
    expect(none.canStart).toBe(true);
    expect(none.reason).toMatch(/5-hour window absent, 7-day window absent/);
    // a window whose reset time has passed is stale too
    expect(evaluate(usage({ fiveHour: { pct: 99, resetsAt: NOW - 1 } }), DEFAULT_THRESHOLDS, NOW).canStart).toBe(true);
  });

  it('(d) usage data older than 30 minutes: no new workers, and the reason says so', () => {
    const v = evaluate(usage({ fiveHour: { pct: 10, resetsAt: NOW + H }, updatedAt: NOW - 31 * 60_000, ageMs: 31 * 60_000 }), DEFAULT_THRESHOLDS, NOW);
    expect(v).toMatchObject({ canStart: false, stopAll: false });
    expect(v.reason).toMatch(/usage data is 31 min old \(limit 30 min\)/);
    expect(evaluate(usage({ updatedAt: null, ageMs: null }), DEFAULT_THRESHOLDS, NOW)).toMatchObject({ canStart: false, reason: expect.stringMatching(/no usage data/) });
  });

  it('thresholds come from settings', () => {
    const v = evaluate(usage({ fiveHour: { pct: 70, resetsAt: NOW + H } }), { fiveHourPct: 60, sevenDayPct: 80, maxAgeMin: 30 }, NOW);
    expect(v.canStart).toBe(false);
  });
});

describe('task files', () => {
  it('parses frontmatter, lists and the acceptance section', () => {
    const t = parseTaskFile(
      '---\nid: P2\ntitle: "Gestiune"\ndepends_on: [P1, P0]\npriority: 5\nsensitive: yes\nstatus: gata\n---\n# ignored heading\n\nText.\n\n## Criterii de acceptare\n- stocul se calculează\n- [ ] raportul iese\n\n## Other\n- not a criterion\n',
      'p2.md',
    );
    expect(t).toMatchObject({ id: 'P2', title: 'Gestiune', dependsOn: ['P1', 'P0'], priority: 5, sensitive: true, status: 'gata', acceptance: ['stocul se calculează', 'raportul iese'] });
    const u = parseTaskFile('---\nafter: P2\nacceptance:\n  - one\n  - two\n---\n# Heading title\n', 'x.md');
    expect(u).toMatchObject({ title: 'Heading title', dependsOn: ['P2'], acceptance: ['one', 'two'] });
    expect(() => parseTaskFile('no frontmatter', 'a.md')).toThrow(TaskFileError);
    expect(() => parseTaskFile('---\ntitle: x\nstatus: done\n---\n', 'a.md')).toThrow(/unknown status/);
  });

  it('acceptance criteria: wrapped items stay whole, only the criteria heading counts', () => {
    const body = [
      '## Contractul pentru testele de acceptare', '- not a criterion', '',
      '## Criterii de Acceptare', 'Intro paragraph.', '', '1. _(G1)_ first line', '   second line', '2. single', '- [x] done item',
      '  continued', '', '  indented after a blank line is not a continuation', '### Sub-heading inside', '- third', '',
      '## Next', '- outside',
    ].join('\n');
    expect(parseTaskFile(`---\ntitle: t\n---\n${body}\n`, 't.md').acceptance).toEqual(['_(G1)_ first line second line', 'single', 'done item continued', 'third']);
    // no exact heading: the first one containing the phrase; headings that merely mention "acceptare" never count
    expect(acceptanceSection('# Testele de acceptare\n- no\n## 3. Acceptance Criteria (draft):\n* yes\n  wrapped\n')).toEqual(['yes wrapped']);
    expect(acceptanceSection('## Criteriile de acceptanță\n- da\n')).toEqual(['da']);
    expect(acceptanceSection('## Contractul pentru testele de acceptare\n- no\n')).toEqual([]);
  });

  it('bb tasks import --dry-run lists every criterion whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-dry-'));
    writeFileSync(join(dir, 'p1.md'), '---\nid: P1\ntitle: One\n---\n## Criterii de acceptare\n1. starts here\n   and ends here.\n2. second.\n');
    const log = console.log;
    const out: string[] = [];
    console.log = (s: string) => void out.push(s);
    try {
      expect(await tasksCli(['import', dir, '--dry-run'])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(out).toEqual(['P1\tbacklog\tOne\t2 criteria', '  1. starts here and ends here.', '  2. second.']);
  });

  it('orders by dependencies and rejects cycles', () => {
    const order = orderByDeps([
      { id: 'C', dependsOn: ['B'] },
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A', 'EXTERNAL'] },
    ]).map((t) => t.id);
    expect(order).toEqual(['A', 'B', 'C']);
    expect(() => orderByDeps([{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }])).toThrow(/cycle/);
  });
});

describe('factory API', () => {
  let srv: TestServer;
  let web: WebClient;
  let agentToken: string;
  let machineToken: string;
  const agent = (tool: string, body: unknown = {}, token = agentToken) =>
    fetch(`${srv.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ok = async (tool: string, body: unknown = {}) => {
    const r = await agent(tool, body);
    const j = (await r.json()) as { result?: any; error?: string };
    if (!r.ok) throw new Error(`${tool} ${r.status} ${j.error}`);
    return j.result;
  };
  const statusline = (limits: unknown, sid = 'gov-s1') =>
    fetch(`${srv.url}/api/statusline`, { method: 'POST', headers: { authorization: `Bearer ${machineToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, rate_limits: limits }) });

  beforeAll(async () => {
    srv = await startTestServer();
    web = await srv.login();
    agentToken = createAgentToken(srv.ctx, 'test').token;
    machineToken = createMachine(srv.ctx, 'gov').token;
    await fetch(`${srv.url}/api/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${machineToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), env: {}, hostname: 'h', platform: 'linux', user: 'u', pid: 1, ppid: 1, hookVersion: 't', event: { session_id: 'gov-s1', cwd: '/w', hook_event_name: 'SessionStart' } }),
    });
  });
  afterAll(() => srv.stop());

  it('agent tokens reach only the agent API; machine tokens and revoked tokens are refused', async () => {
    expect((await agent('usage_get', {}, machineToken)).status).toBe(401);
    expect((await fetch(`${srv.url}/api/sessions`, { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(401);
    expect((await fetch(`${srv.url}/api/tasks`, { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(401);
    expect((await agent('nope')).status).toBe(404);
    expect((await agent('tasks_get', { id: '' })).status).toBe(400);
    const extra = await web.post<{ id: string; token: string }>('/api/agent-tokens', { name: 'temp' });
    expect(extra.token).toMatch(/^bba_/);
    expect((await agent('usage_get', {}, extra.token)).status).toBe(200);
    await web.post(`/api/agent-tokens/${extra.id}/revoke`);
    expect((await agent('usage_get', {}, extra.token)).status).toBe(401);
    const list = await web.get<{ id: string; revokedAt: number | null; lastUsedAt: number | null }[]>('/api/agent-tokens');
    expect(list.find((t) => t.id === extra.id)).toMatchObject({ revokedAt: expect.any(Number), lastUsedAt: expect.any(Number) });
  });

  it('GET /api/governor follows the statusline data and the thresholds in settings', async () => {
    expect((await web.get('/api/governor')).canStart).toBe(false); // no data yet
    const resets = Math.floor(Date.now() / 1000) + 7200;
    await statusline({ five_hour: { used_percentage: 86, resets_at: resets } });
    let g = await web.get('/api/governor');
    expect(g).toMatchObject({ canStart: false, stopAll: false, waitUntil: resets * 1000 });
    await web.put('/api/settings', { governor_five_hour_pct: 90 });
    g = await web.get('/api/governor');
    expect(g.canStart).toBe(true);
    expect(g.thresholds.fiveHourPct).toBe(90);
    await statusline({ five_hour: { used_percentage: 20, resets_at: resets }, seven_day: { used_percentage: 81, resets_at: resets + 86400 } });
    expect(await ok('governor_get')).toMatchObject({ canStart: false, stopAll: true, waitUntil: (resets + 86400) * 1000 });
    await statusline({ five_hour: { used_percentage: 20, resets_at: resets } });
    expect((await fetch(`${srv.url}/api/governor`, { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(200);
  });

  it('backlog: dependencies, readiness, claim, history, cycles', async () => {
    await ok('tasks_create', { id: 'A1', title: 'Base', status: 'gata', priority: 1 });
    await ok('tasks_create', { id: 'A2', title: 'Next', status: 'gata', dependsOn: ['A1'], priority: 9 });
    const created = await web.post('/api/tasks', { title: 'From the phone', acceptance: ['works'] });
    expect(created.id).toMatch(/^T\d+$/);
    expect(created.source).toBe('web');
    expect((await agent('tasks_create', { id: 'A1', title: 'dup' })).status).toBe(409);
    expect((await agent('tasks_update', { id: 'A1', dependsOn: ['A2'] })).status).toBe(400); // cycle
    expect((await agent('tasks_create', { id: 'A3', title: 'x', dependsOn: ['missing'] })).status).toBe(400);

    let list = await ok('tasks_list', { ready: true });
    expect(list.map((t: any) => t.id)).toEqual(['A1']); // A2 has higher priority but waits on A1
    expect((await ok('tasks_get', { id: 'A2' })).waitingOn).toEqual(['A1']);

    // stale usage data blocks claims unless forced
    srv.ctx.db.run("UPDATE otel_points SET ts = ts - 3600000 WHERE name = 'statusline.rate_limits'");
    const refused = await ok('tasks_claim', {});
    expect(refused.task).toBeNull();
    expect(refused.reason).toMatch(/governor: .*min old/);
    const claimed = await ok('tasks_claim', { agent: 'coord', force: true });
    expect(claimed.task).toMatchObject({ id: 'A1', status: 'in_lucru', claimedBy: 'coord' });
    expect((await ok('tasks_claim', { id: 'A2', force: true })).reason).toMatch(/waits on A1/);

    await ok('tasks_update', { id: 'A1', status: 'integrata', branch: 'pachet/A1', costUsd: 2.5, note: 'merged' });
    list = await ok('tasks_list', { ready: true });
    expect(list.map((t: any) => t.id)).toEqual(['A2']);
    const a1 = await web.get('/api/tasks/A1');
    expect(a1).toMatchObject({ status: 'integrata', branch: 'pachet/A1', costUsd: 2.5, integratedAt: expect.any(Number) });
    expect(a1.events.map((e: any) => `${e.kind}:${e.to ?? ''}`)).toEqual(expect.arrayContaining(['created:gata', 'status:in_lucru', 'status:integrata', 'update:']));
    expect((await web.get('/api/tasks?status=integrata')).map((t: any) => t.id)).toEqual(['A1']);
  });

  it('gates with screenshots, controls and decisions', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await ok('tasks_create', { id: 'G1T', title: 'Gated' });
    expect((await agent('gates_record', { taskId: 'G1T', gate: 'G6', verdict: 'pass', summary: '' })).status).toBe(400);
    expect((await agent('gates_record', { taskId: 'G1T', gate: 'G4', verdict: 'pass', summary: 'x', screenshots: [{ name: 'p', path: 'C:/x.png' }] })).status).toBe(400);
    expect((await agent('gates_record', { taskId: 'G1T', gate: 'G4', verdict: 'pass', summary: 'x', screenshots: [{ name: 'txt', base64: Buffer.from('hello').toString('base64') }] })).status).toBe(400);
    await ok('gates_record', { taskId: 'G1T', gate: 'G1', verdict: 'fail', summary: 'tests red' });
    await ok('gates_record', { taskId: 'G1T', gate: 'G1', verdict: 'pass', summary: 'tests green' });
    const g4 = await ok('gates_record', { taskId: 'G1T', gate: 'G4', verdict: 'pass', summary: 'looks right', screenshots: [{ name: 'phone', base64: png.toString('base64') }], details: { widths: [1280, 390] } });
    const img = await fetch(`${srv.url}${g4.shots[0].url}`, { headers: { cookie: (await loginCookie(srv)).cookie } });
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(png)).toBe(true);
    const t = await web.get('/api/tasks/G1T');
    expect(t.gates).toEqual({ G1: 'pass', G4: 'pass' });
    expect(t.gateResults.map((g: any) => `${g.gate}:${g.verdict}`)).toEqual(['G1:pass', 'G1:fail', 'G4:pass']);

    await web.post('/api/tasks/G1T/control', { kind: 'revert', note: 'broke main' });
    expect((await web.get('/api/tasks/G1T')).openControls).toBe(1);
    const ctl = await ok('control_get', { taskId: 'G1T', ack: true });
    expect(ctl.requests).toMatchObject([{ kind: 'revert', note: 'broke main', status: 'acked' }]);
    expect((await ok('control_get', { taskId: 'G1T' })).requests).toEqual([]);
    expect((await web.get('/api/tasks/G1T')).controls[0].status).toBe('acked');

    const notes: string[] = [];
    srv.ctx.notify = (n) => void notes.push(`${n.type}:${n.title}`);
    const d = await ok('decision_ask', { question: 'Q10?', options: ['a', 'b'], taskId: 'G1T' });
    expect(notes).toEqual(['decision:Decision needed · G1T']);
    expect((await web.get('/api/attention')).decisions).toBe(1);
    expect((await web.get('/api/decisions?status=pending')).map((x: any) => x.id)).toEqual([d.id]);
    await web.post(`/api/decisions/${d.id}/answer`, { answer: 'b' });
    expect(await ok('decision_get', { id: d.id })).toMatchObject({ status: 'answered', answer: 'b' });
    await expect(web.post(`/api/decisions/${d.id}/answer`, { answer: 'a' })).rejects.toThrow(/409/);
    expect((await web.get('/api/tasks/G1T')).decisions).toHaveLength(1);
  });

  it('digest: on demand and once a day after the configured time', async () => {
    const notes: { type: string; title: string; body: string }[] = [];
    srv.ctx.notify = (n) => void notes.push(n);
    const d = await ok('digest_post', { note: 'hello' });
    expect(d.kind).toBe('manual');
    expect(d.body).toMatch(/hello/);
    expect(d.body).toMatch(/Integrated: A1/);
    expect(d.body).toMatch(/Usage: 5 h 20%/);
    expect(notes.at(-1)?.type).toBe('digest');

    srv.ctx.db.setSetting('digest_time', '09:30');
    const at = scheduledAt('09:30', Date.now());
    expect(maybeDailyDigest(srv.ctx, at - 60_000)).toBeNull();
    expect(maybeDailyDigest(srv.ctx, at + 60_000)?.kind).toBe('daily');
    expect(maybeDailyDigest(srv.ctx, at + 120_000)).toBeNull(); // once a day
    srv.ctx.db.setSetting('digest_enabled', false);
    expect(maybeDailyDigest(srv.ctx, at + 25 * H)).toBeNull();
    expect((await web.get('/api/digests')).length).toBe(2);
  });

  it('prompts: render, lint and save versions linked to a task', async () => {
    const r = await ok('prompts_render', { slots: { Goal: 'Do X' } });
    expect(r.rendered).toContain('Do X');
    expect(r.warnings.map((w: any) => w.id)).toContain('done-empty');
    expect((await agent('prompts_render', { template: 'missing', slots: {} })).status).toBe(404);
    const v1 = await ok('prompts_save', { title: 'w', slots: { Goal: 'Do X' }, taskId: 'A2' });
    const v2 = await ok('prompts_save', { id: v1.id, title: 'w', slots: { Goal: 'Do Y' }, taskId: 'A2' });
    expect(v2).toMatchObject({ id: v1.id, version: 2 });
    expect(await ok('tasks_get', { id: 'A2' })).toMatchObject({ promptId: v1.id, promptVersion: 2 });
  });

  it('imports Markdown files from the web and from bb tasks import (upsert, deps in order)', async () => {
    const files = [
      { name: 'm2.md', text: '---\nid: M2\ntitle: Second\nafter: [M1]\n---\nBody\n' },
      { name: 'm1.md', text: '---\nid: M1\ntitle: First\nstatus: gata\n---\n## Acceptance criteria\n- one\n' },
    ];
    expect((await web.post('/api/tasks/import/markdown', { files })).imported).toEqual(['M1', 'M2']);
    expect(await web.get('/api/tasks/M1')).toMatchObject({ status: 'gata', acceptance: ['one'], source: 'markdown' });

    const dir = mkdtempSync(join(tmpdir(), 'bb-tasks-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'README.md'), '# not a task\n');
    writeFileSync(join(dir, 'm1.md'), '---\nid: M1\ntitle: First (renamed)\n---\n');
    writeFileSync(join(dir, 'sub', 'm3.md'), '---\nid: M3\ntitle: Third\ndepends_on: M2\n---\n');
    process.env.BUILDYBOY_URL = srv.url;
    process.env.BUILDYBOY_AGENT_TOKEN = agentToken;
    const log = console.log;
    const err = console.error;
    const out: string[] = [];
    console.log = (s: string) => void out.push(s);
    console.error = (s: string) => void out.push(s);
    try {
      expect(await tasksCli(['import', dir])).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
      delete process.env.BUILDYBOY_URL;
      delete process.env.BUILDYBOY_AGENT_TOKEN;
    }
    expect(out.some((l) => /skipped .*README\.md/.test(l))).toBe(true);
    expect(await web.get('/api/tasks/M1')).toMatchObject({ title: 'First (renamed)', status: 'gata' }); // status kept
    expect((await web.get('/api/tasks/M3')).dependsOn).toEqual(['M2']);
  });

  it('imports GitHub issues through the configured token, skipping pull requests', async () => {
    const { createServer } = await import('node:http');
    const gh = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/repos/o/r/issues')) {
        expect(req.headers.authorization).toBe('Bearer ghp_test');
        res.end(JSON.stringify([
          // CRLF, a decoy heading that mentions "acceptare" and a criterion wrapped over two lines
          { number: 7, title: 'Add import', body: 'Text\r\n\r\n## Contractul pentru testele de acceptare\r\n- not a criterion\r\n\r\n## Acceptance criteria\r\n- imports CSV\r\n  with a header row\r\n- reports bad rows', html_url: 'https://github.com/o/r/issues/7', labels: [] },
          { number: 8, title: 'A PR', body: '', html_url: 'https://github.com/o/r/pull/8', pull_request: {}, labels: [] },
        ]));
      } else res.end('[]');
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
    process.env.BUILDYBOY_GITHUB_API = `http://127.0.0.1:${(gh.address() as { port: number }).port}`;
    try {
      await expect(web.post('/api/tasks/import/github', { owner: 'o', repo: 'r' })).rejects.toThrow(/GitHub token/);
      await web.put('/api/settings', { github_token: 'ghp_test' });
      const first = await web.post('/api/tasks/import/github', { owner: 'o', repo: 'r' });
      expect(first.imported).toHaveLength(1);
      const again = await web.post('/api/tasks/import/github', { owner: 'o', repo: 'r' });
      expect(again.imported).toEqual(first.imported);
      expect(await web.get(`/api/tasks/${first.imported[0]}`)).toMatchObject({ title: 'Add import', extRef: 'o/r#7', acceptance: ['imports CSV with a header row', 'reports bad rows'], source: 'github', repo: 'o/r' });
    } finally {
      delete process.env.BUILDYBOY_GITHUB_API;
      gh.close();
    }
  });

  it('a sparse statusline sample does not hide a window that is still over its limit', async () => {
    const resets = Math.floor(Date.now() / 1000) + 7200;
    await statusline({ five_hour: { used_percentage: 30, resets_at: resets }, seven_day: { used_percentage: 92, resets_at: resets + 86400 } });
    await statusline({ five_hour: { used_percentage: 31, resets_at: resets } });
    await statusline({});
    const g = governor(srv.ctx);
    expect(g.usage).toMatchObject({ fiveHour: { pct: 31 }, sevenDay: { pct: 92 } });
    expect(g).toMatchObject({ canStart: false, stopAll: true });
    // once the 7-day window has reset, Claude Code drops it and the old value no longer counts
    srv.ctx.db.run("UPDATE otel_points SET attrs_json = json_set(attrs_json, '$.seven_day.resets_at', 1) WHERE name = 'statusline.rate_limits'");
    expect(governor(srv.ctx)).toMatchObject({ canStart: true, stopAll: false });
  });

  it('ready with a limit counts only ready tasks', async () => {
    for (let i = 0; i < 4; i++) await ok('tasks_create', { id: `L${i}`, title: `busy ${i}`, priority: 500 });
    await ok('tasks_create', { id: 'LR', title: 'ready one', status: 'gata', priority: -5 });
    // the five highest-priority tasks are not ready; the old LIMIT-then-filter returned nothing
    const r = await ok('tasks_list', { ready: true, limit: 3 });
    expect(r).toHaveLength(3);
    expect(r.every((t: any) => t.ready)).toBe(true);
  });

  it('re-importing Markdown keeps the status of a started package, its dependencies, and does not duplicate id-less files', async () => {
    const md = (...lines: string[]) => ['---', ...lines, '---', ''].join('\n');
    await web.post('/api/tasks/import/markdown', { files: [{ name: 'r1.md', text: md('id: R1', 'title: R one', 'status: gata') }, { name: 'r2.md', text: md('id: R2', 'title: R two') }] });
    await web.put('/api/tasks/R2', { dependsOn: ['R1'] });
    await ok('tasks_update', { id: 'R1', status: 'integrata' });
    const again = [{ name: 'r1.md', text: md('id: R1', 'title: R one v2', 'status: gata') }, { name: 'r2.md', text: md('id: R2', 'title: R two') }];
    await web.post('/api/tasks/import/markdown', { files: again });
    expect(await web.get('/api/tasks/R1')).toMatchObject({ title: 'R one v2', status: 'integrata' });
    expect((await web.get('/api/tasks/R2')).dependsOn).toEqual(['R1']);
    const noId = { files: [{ name: 'loose.md', text: md('title: No id') }] };
    const a = (await web.post('/api/tasks/import/markdown', noId)).imported;
    const b = (await web.post('/api/tasks/import/markdown', noId)).imported;
    expect(b).toEqual(a);
    await expect(web.post('/api/tasks/import/markdown', { files: [{ name: 'bad.md', text: md(`title: ${'x'.repeat(300)}`) }] })).rejects.toThrow(/400/);
  });

  it('prompts_save refuses an unknown task before saving anything', async () => {
    const before = srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM prompts')!.n;
    expect((await agent('prompts_save', { title: 'x', slots: {}, taskId: 'NOPE' })).status).toBe(404);
    expect(srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM prompts')!.n).toBe(before);
  });
});

describe('bb doctor factory checks', () => {
  it('names exactly what is missing, reading only the given config dirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-doctor-'));
    const prev = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.BUILDYBOY_HC, a: process.env.BUILDYBOY_AGENT_TOKEN, p: process.env.PATH, l: process.env.LOCALAPPDATA, home: process.env.BUILDYBOY_HOME };
    process.env.BUILDYBOY_HOME = dir;
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.BUILDYBOY_HC = join(dir, 'no-hc.exe');
    process.env.PATH = '';
    process.env.LOCALAPPDATA = dir;
    delete process.env.BUILDYBOY_AGENT_TOKEN;
    const log = console.log;
    const out: string[] = [];
    console.log = (s: string) => void out.push(s);
    try {
      let missing = await factoryChecks(undefined);
      expect(missing).toHaveLength(4);
      expect(out.join('\n')).toMatch(/statusline bridge not configured/);
      expect(out.join('\n')).toMatch(/claude mcp add buildyboy/);
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node /x/plugin/statusline/bb-statusline.mjs' }, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' } }));
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { buildyboy: { command: 'node' } } }));
      writeFileSync(process.env.BUILDYBOY_HC, '');
      out.length = 0;
      missing = await factoryChecks(undefined);
      expect(missing).toEqual([]);
    } finally {
      console.log = log;
      for (const [k, v] of [['CLAUDE_CONFIG_DIR', prev.c], ['BUILDYBOY_HC', prev.h], ['BUILDYBOY_AGENT_TOKEN', prev.a], ['PATH', prev.p], ['LOCALAPPDATA', prev.l], ['BUILDYBOY_HOME', prev.home]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

async function loginCookie(srv: TestServer): Promise<{ cookie: string }> {
  const { TEST_PASSWORD } = await import('./helpers.ts');
  const res = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
  return { cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}
