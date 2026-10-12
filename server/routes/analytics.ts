import { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { requireWeb } from '../auth.ts';
import { json } from '../db.ts';

const DAY = 86_400_000;
const RANGES: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

type Breakdown = Record<string, number>;
interface CostBucket {
  period: string;
  total: number;
  byProject: Breakdown;
  byModel: Breakdown;
  byMachine: Breakdown;
}

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Monday of the week containing the given UTC day (YYYY-MM-DD). */
function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return dayKey(d.getTime() - back * DAY);
}

function add(into: Breakdown, key: string, n: number) {
  into[key] = (into[key] ?? 0) + n;
}

function bucketList(map: Map<string, CostBucket>): CostBucket[] {
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function ranked(b: Breakdown): { name: string; total: number }[] {
  return Object.entries(b).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
}

export interface AnalyticsResponse {
  range: string;
  since: number;
  until: number;
  days: string[];
  totals: {
    costUsd: number;
    sessions: number;
    activeMs: number;
    linesAdded: number;
    linesRemoved: number;
    waitMs: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    cacheHitRatio: number | null;
  };
  cost: {
    byDay: CostBucket[];
    byWeek: CostBucket[];
    byMonth: CostBucket[];
    projects: { name: string; total: number }[];
    models: { name: string; total: number }[];
    machines: { name: string; total: number }[];
  };
  tokens: { byDay: { day: string; input: number; output: number; cacheRead: number; cacheWrite: number; cacheHitRatio: number | null }[] };
  sessions: { byDay: { day: string; count: number; activeMs: number; linesAdded: number; linesRemoved: number }[] };
  tools: {
    mostUsed: { tool: string; count: number; errors: number }[];
    mostFailedCommands: { command: string; tool: string; count: number; lastAt: number }[];
  };
  waits: {
    totalMs: number;
    byDay: { day: string; waitMs: number }[];
    actions: { answered: number; avgMs: number | null; maxMs: number | null; totalMs: number; byKind: { kind: string; count: number; avgMs: number }[] };
  };
  jobs: { byPrompt: { promptId: number | null; title: string; runs: number; succeeded: number; failed: number; successRate: number | null; avgCostUsd: number | null; avgDurationMs: number | null }[] };
  rateLimits: { ts: number; fiveHourPct: number | null; sevenDayPct: number | null }[];
}

export function buildAnalytics(ctx: Ctx, range: string, now = Date.now()): AnalyticsResponse {
  const nDays = RANGES[range];
  // window = the last N UTC days, including today
  const since = Date.parse(`${dayKey(now)}T00:00:00Z`) - (nDays - 1) * DAY;
  const days: string[] = [];
  for (let i = 0; i < nDays; i++) days.push(dayKey(since + i * DAY));
  const { db } = ctx;

  // ---- sessions: cost, tokens, activity (attributed to the day the session started) ----
  const rows = db.all<{
    day: string; project: string; model: string; machine: string; cost: number; sessions: number; active: number; added: number; removed: number; wait: number;
    tin: number; tout: number; tcr: number; tcw: number;
  }>(
    `SELECT date(s.started_at / 1000, 'unixepoch') AS day,
            COALESCE(p.name, '(no project)') AS project,
            COALESCE(s.model, 'unknown') AS model,
            m.name AS machine,
            COALESCE(SUM(s.cost_usd), 0) AS cost,
            COUNT(*) AS sessions,
            COALESCE(SUM(MAX(0, COALESCE(s.ended_at, s.last_event_at) - s.started_at)), 0) AS active,
            COALESCE(SUM(s.lines_added), 0) AS added,
            COALESCE(SUM(s.lines_removed), 0) AS removed,
            COALESCE(SUM(s.wait_ms), 0) AS wait,
            COALESCE(SUM(s.tokens_input), 0) AS tin,
            COALESCE(SUM(s.tokens_output), 0) AS tout,
            COALESCE(SUM(s.tokens_cache_read), 0) AS tcr,
            COALESCE(SUM(s.tokens_cache_write), 0) AS tcw
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
       JOIN machines m ON m.id = s.machine_id
      WHERE s.started_at >= ?
      GROUP BY day, project, model, machine`,
    since,
  );

  const byDay = new Map<string, CostBucket>();
  const byWeek = new Map<string, CostBucket>();
  const byMonth = new Map<string, CostBucket>();
  const mk = (period: string): CostBucket => ({ period, total: 0, byProject: {}, byModel: {}, byMachine: {} });
  for (const d of days) byDay.set(d, mk(d));
  const projects: Breakdown = {};
  const models: Breakdown = {};
  const machines: Breakdown = {};
  const dayStats = new Map(days.map((d) => [d, { day: d, count: 0, activeMs: 0, linesAdded: 0, linesRemoved: 0, waitMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]));
  const totals = { costUsd: 0, sessions: 0, activeMs: 0, linesAdded: 0, linesRemoved: 0, waitMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const r of rows) {
    const buckets = [byDay.get(r.day) ?? (byDay.set(r.day, mk(r.day)), byDay.get(r.day)!)];
    const wk = weekStart(r.day);
    const mo = r.day.slice(0, 7);
    if (!byWeek.has(wk)) byWeek.set(wk, mk(wk));
    if (!byMonth.has(mo)) byMonth.set(mo, mk(mo));
    buckets.push(byWeek.get(wk)!, byMonth.get(mo)!);
    for (const b of buckets) {
      b.total += r.cost;
      add(b.byProject, r.project, r.cost);
      add(b.byModel, r.model, r.cost);
      add(b.byMachine, r.machine, r.cost);
    }
    add(projects, r.project, r.cost);
    add(models, r.model, r.cost);
    add(machines, r.machine, r.cost);
    const ds = dayStats.get(r.day);
    if (ds) {
      ds.count += r.sessions;
      ds.activeMs += r.active;
      ds.linesAdded += r.added;
      ds.linesRemoved += r.removed;
      ds.waitMs += r.wait;
      ds.input += r.tin;
      ds.output += r.tout;
      ds.cacheRead += r.tcr;
      ds.cacheWrite += r.tcw;
    }
    totals.costUsd += r.cost;
    totals.sessions += r.sessions;
    totals.activeMs += r.active;
    totals.linesAdded += r.added;
    totals.linesRemoved += r.removed;
    totals.waitMs += r.wait;
    totals.input += r.tin;
    totals.output += r.tout;
    totals.cacheRead += r.tcr;
    totals.cacheWrite += r.tcw;
  }
  const hit = (i: number, cr: number, cw: number) => (i + cr + cw > 0 ? cr / (i + cr + cw) : null);
  const dayList = [...dayStats.values()];

  // ---- tools ----
  const mostUsed = db.all<{ tool: string; count: number; errors: number }>(
    `SELECT tool_name AS tool, COUNT(*) AS count, SUM(status = 'error') AS errors
       FROM tool_calls WHERE started_at >= ? GROUP BY tool_name ORDER BY count DESC, tool_name LIMIT 12`,
    since,
  );
  const failed = db.all<{ command: string; tool: string; count: number; lastAt: number }>(
    `SELECT substr(command, 1, 300) AS command, tool_name AS tool, COUNT(*) AS count, MAX(started_at) AS lastAt
       FROM tool_calls WHERE started_at >= ? AND status = 'error' AND command IS NOT NULL AND command != ''
      GROUP BY substr(command, 1, 300), tool_name ORDER BY count DESC, lastAt DESC LIMIT 10`,
    since,
  );

  // ---- permission wait: time sessions spent waiting, and how long answered actions took ----
  const answered = db.get<{ n: number; avg: number | null; max: number | null; total: number | null }>(
    `SELECT COUNT(*) AS n, AVG(answered_at - created_at) AS avg, MAX(answered_at - created_at) AS max, SUM(answered_at - created_at) AS total
       FROM pending_actions WHERE status = 'answered' AND answered_at IS NOT NULL AND created_at >= ? AND kind != 'pause'`,
    since,
  );
  const byKind = db.all<{ kind: string; count: number; avgMs: number }>(
    `SELECT kind, COUNT(*) AS count, AVG(answered_at - created_at) AS avgMs
       FROM pending_actions WHERE status = 'answered' AND answered_at IS NOT NULL AND created_at >= ? AND kind != 'pause'
      GROUP BY kind ORDER BY count DESC`,
    since,
  );

  // ---- jobs by prompt ----
  const jobRows = db.all<{ promptId: number | null; title: string | null; runs: number; ok: number; bad: number; finished: number; cost: number | null; dur: number | null }>(
    `SELECT j.prompt_id AS promptId, p.title AS title, COUNT(*) AS runs,
            SUM(j.status = 'succeeded') AS ok,
            SUM(j.status IN ('failed', 'lost')) AS bad,
            SUM(j.status IN ('succeeded', 'failed', 'lost', 'stopped')) AS finished,
            AVG(j.cost_usd) AS cost,
            AVG(CASE WHEN j.ended_at IS NOT NULL AND j.started_at IS NOT NULL THEN j.ended_at - j.started_at END) AS dur
       FROM jobs j LEFT JOIN prompts p ON p.id = j.prompt_id
      WHERE j.created_at >= ?
      GROUP BY j.prompt_id ORDER BY runs DESC`,
    since,
  );

  // ---- rate limits from the statusline bridge ----
  const rl = db.all<{ ts: number; value: number; attrs_json: string | null }>(
    "SELECT ts, value, attrs_json FROM otel_points WHERE name = 'statusline.rate_limits' AND ts >= ? ORDER BY ts LIMIT 5000", since,
  );
  const step = Math.max(1, Math.ceil(rl.length / 400));
  const rateLimits = rl.filter((_, i) => i % step === 0 || i === rl.length - 1).map((r) => {
    const a = json<{ five_hour?: { used_percentage?: number }; seven_day?: { used_percentage?: number } }>(r.attrs_json, {});
    return {
      ts: r.ts,
      fiveHourPct: a?.five_hour?.used_percentage ?? r.value ?? null,
      sevenDayPct: a?.seven_day?.used_percentage ?? null,
    };
  });

  return {
    range,
    since,
    until: now,
    days,
    totals: {
      costUsd: totals.costUsd,
      sessions: totals.sessions,
      activeMs: totals.activeMs,
      linesAdded: totals.linesAdded,
      linesRemoved: totals.linesRemoved,
      waitMs: totals.waitMs,
      tokens: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite },
      cacheHitRatio: hit(totals.input, totals.cacheRead, totals.cacheWrite),
    },
    cost: {
      byDay: bucketList(byDay),
      byWeek: bucketList(byWeek),
      byMonth: bucketList(byMonth),
      projects: ranked(projects),
      models: ranked(models),
      machines: ranked(machines),
    },
    tokens: { byDay: dayList.map((d) => ({ day: d.day, input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, cacheHitRatio: hit(d.input, d.cacheRead, d.cacheWrite) })) },
    sessions: { byDay: dayList.map((d) => ({ day: d.day, count: d.count, activeMs: d.activeMs, linesAdded: d.linesAdded, linesRemoved: d.linesRemoved })) },
    tools: { mostUsed: mostUsed.map((t) => ({ ...t, errors: t.errors ?? 0 })), mostFailedCommands: failed },
    waits: {
      totalMs: totals.waitMs,
      byDay: dayList.map((d) => ({ day: d.day, waitMs: d.waitMs })),
      actions: {
        answered: answered?.n ?? 0,
        avgMs: answered?.avg ?? null,
        maxMs: answered?.max ?? null,
        totalMs: answered?.total ?? 0,
        byKind,
      },
    },
    jobs: {
      byPrompt: jobRows.map((j) => ({
        promptId: j.promptId,
        title: j.title ?? (j.promptId == null ? 'Ad-hoc jobs' : `Prompt #${j.promptId}`),
        runs: j.runs,
        succeeded: j.ok ?? 0,
        failed: j.bad ?? 0,
        successRate: j.finished ? (j.ok ?? 0) / j.finished : null,
        avgCostUsd: j.cost,
        avgDurationMs: j.dur,
      })),
    },
    rateLimits,
  };
}

export function analyticsRoutes(ctx: Ctx) {
  const app = new Hono();
  const auth = requireWeb(ctx);

  app.get('/api/analytics', auth, (c) => {
    const range = c.req.query('range') ?? '30d';
    if (!(range in RANGES)) return c.json({ error: 'range must be 7d, 30d or 90d' }, 400);
    return c.json(buildAnalytics(ctx, range));
  });

  return app;
}
