import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { simulate } from '../scripts/simulate.ts';
import { S1 } from '../fixtures/scenario.ts';
import type { AnalyticsResponse } from '../server/routes/analytics.ts';
import type { SessionSummary } from '../shared/types.ts';

let srv: TestServer;
let web: WebClient;

beforeAll(async () => {
  srv = await startTestServer();
  await simulate({ url: srv.url, dataDir: srv.dataDir, log: () => {} });
  web = await srv.login();
  const { db } = srv.ctx;
  const now = Date.now();
  const machine = db.get<{ id: string }>('SELECT id FROM machines LIMIT 1')!.id;
  // a saved prompt with two finished jobs (one failed) plus one ad-hoc running job
  db.run("INSERT INTO prompts (id, title, slots_json, rendered, created_at, updated_at) VALUES (1, 'Nightly deps', '{}', 'x', ?, ?)", now, now);
  const job = (id: string, promptId: number | null, status: string, cost: number) =>
    db.run(
      'INSERT INTO jobs (id, prompt_id, machine_id, cwd, prompt_text, options_json, status, cost_usd, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, promptId, machine, '/tmp/x', 'p', '{}', status, cost, now - 60_000, now - 50_000, now - 20_000,
    );
  job('j1', 1, 'succeeded', 1);
  job('j2', 1, 'failed', 3);
  job('j3', null, 'succeeded', 2);
  // a permission that took the human 30 s to answer
  db.run(
    "INSERT INTO pending_actions (id, session_id, kind, tool_name, request_json, status, created_at, answered_at, answered_by) VALUES ('pa1', ?, 'permission', 'Bash', '{}', 'answered', ?, ?, 'web')",
    S1, now - 40_000, now - 10_000,
  );
  // rate limit samples from the statusline bridge
  db.run(
    "INSERT INTO otel_points (ts, session_id, name, value, attrs_json) VALUES (?, ?, 'statusline.rate_limits', 42, ?)",
    now - 5_000, S1, JSON.stringify({ five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 17 } }),
  );
});
afterAll(() => srv.stop());

describe('GET /api/analytics', () => {
  it('requires a web login', async () => {
    expect((await fetch(`${srv.url}/api/analytics`)).status).toBe(401);
  });

  it('rejects unknown ranges', async () => {
    await expect(web.get('/api/analytics?range=1y')).rejects.toThrow(/400/);
  });

  it('has the documented shape for every range', async () => {
    for (const [range, n] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const a = await web.get<AnalyticsResponse>(`/api/analytics?range=${range}`);
      expect(a.range).toBe(range);
      expect(a.days).toHaveLength(n);
      expect(a.cost.byDay).toHaveLength(n);
      expect(a.tokens.byDay).toHaveLength(n);
      expect(a.sessions.byDay).toHaveLength(n);
      for (const key of ['byWeek', 'byMonth', 'projects', 'models', 'machines'] as const) expect(Array.isArray(a.cost[key])).toBe(true);
      expect(a.cost.byDay[0]).toMatchObject({ period: a.days[0], total: expect.any(Number), byProject: expect.any(Object), byModel: expect.any(Object), byMachine: expect.any(Object) });
    }
  });

  it('adds up the fixture sessions', async () => {
    const a = await web.get<AnalyticsResponse>('/api/analytics?range=7d');
    const sessions = await web.get<SessionSummary[]>('/api/sessions');
    expect(a.totals.sessions).toBe(3);
    expect(a.totals.costUsd).toBeCloseTo(sessions.reduce((s, x) => s + x.costUsd, 0), 6);
    expect(a.totals.costUsd).toBeGreaterThanOrEqual(0.4213);
    // cost per day sums to the total, and each breakdown does too
    const dayTotal = a.cost.byDay.reduce((s, d) => s + d.total, 0);
    expect(dayTotal).toBeCloseTo(a.totals.costUsd, 6);
    for (const b of a.cost.byDay) {
      for (const by of [b.byProject, b.byModel, b.byMachine]) expect(Object.values(by).reduce((s, v) => s + v, 0)).toBeCloseTo(b.total, 6);
    }
    expect(a.cost.machines.map((m) => m.name).sort()).toEqual(['devbox-win', 'wsl-ubuntu']);
    expect(a.cost.projects.map((p) => p.name)).toEqual(expect.arrayContaining(['shop-api', 'billing', 'notes']));
    expect(a.cost.byWeek.length).toBeGreaterThanOrEqual(1);
    expect(a.cost.byMonth.reduce((s, m) => s + m.total, 0)).toBeCloseTo(a.totals.costUsd, 6);
    expect(a.sessions.byDay.reduce((s, d) => s + d.count, 0)).toBe(3);
    expect(a.totals.activeMs).toBeGreaterThan(60_000);
    expect(a.totals.linesAdded).toBeGreaterThanOrEqual(18);
    expect(a.totals.linesRemoved).toBeGreaterThanOrEqual(2);
  });

  it('reports tokens and cache hit ratio', async () => {
    const a = await web.get<AnalyticsResponse>('/api/analytics?range=30d');
    expect(a.totals.tokens.cacheRead).toBeGreaterThan(0);
    expect(a.totals.cacheHitRatio).toBeGreaterThan(0.5);
    expect(a.totals.cacheHitRatio).toBeLessThanOrEqual(1);
    expect(a.tokens.byDay.reduce((s, d) => s + d.cacheRead, 0)).toBe(a.totals.tokens.cacheRead);
  });

  it('ranks tools and failed commands', async () => {
    const a = await web.get<AnalyticsResponse>('/api/analytics?range=7d');
    const bash = a.tools.mostUsed.find((t) => t.tool === 'Bash')!;
    expect(bash.count).toBeGreaterThanOrEqual(5);
    expect(bash.errors).toBeGreaterThanOrEqual(2);
    expect(a.tools.mostUsed[0].count).toBeGreaterThanOrEqual(a.tools.mostUsed[1].count);
    const cmds = a.tools.mostFailedCommands.map((c) => c.command);
    expect(cmds).toContain('npm test');
    expect(cmds).toContain('npm update && npm test');
    expect(a.tools.mostFailedCommands.every((c) => c.count >= 1)).toBe(true);
  });

  it('measures permission wait, job success per prompt and rate limits', async () => {
    const a = await web.get<AnalyticsResponse>('/api/analytics?range=7d');
    expect(a.waits.actions.answered).toBe(1);
    expect(a.waits.actions.avgMs).toBe(30_000);
    expect(a.waits.actions.byKind).toEqual([{ kind: 'permission', count: 1, avgMs: 30_000 }]);
    expect(a.waits.totalMs).toBeGreaterThanOrEqual(0);
    const nightly = a.jobs.byPrompt.find((j) => j.title === 'Nightly deps')!;
    expect(nightly).toMatchObject({ promptId: 1, runs: 2, succeeded: 1, failed: 1, successRate: 0.5 });
    expect(nightly.avgCostUsd).toBe(2);
    expect(a.jobs.byPrompt.find((j) => j.promptId == null)).toMatchObject({ title: 'Ad-hoc jobs', runs: 1, successRate: 1 });
    expect(a.rateLimits).toHaveLength(1);
    expect(a.rateLimits[0]).toMatchObject({ fiveHourPct: 42, sevenDayPct: 17 });
  });
});
