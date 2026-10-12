import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { duration, relTime, tokens } from '../lib/format.ts';
import { Card, Empty, PageTitle, Tabs } from '../components/ui.tsx';
import { BarChart, Legend, type BarDatum } from '../components/charts/BarChart.tsx';
import { LineChart } from '../components/charts/LineChart.tsx';
import { HBars } from '../components/charts/HBars.tsx';
import { Sparkline } from '../components/charts/Sparkline.tsx';
import { foldOther, topSeries } from '../components/charts/palette.ts';

type Breakdown = Record<string, number>;
interface CostBucket { period: string; total: number; byProject: Breakdown; byModel: Breakdown; byMachine: Breakdown }

/** Mirrors the response of GET /api/analytics (server/routes/analytics.ts). */
export interface AnalyticsData {
  range: string;
  since: number;
  until: number;
  days: string[];
  totals: {
    costUsd: number; sessions: number; activeMs: number; linesAdded: number; linesRemoved: number; waitMs: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    cacheHitRatio: number | null;
  };
  cost: {
    byDay: CostBucket[]; byWeek: CostBucket[]; byMonth: CostBucket[];
    projects: { name: string; total: number }[]; models: { name: string; total: number }[]; machines: { name: string; total: number }[];
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

type Range = '7d' | '30d' | '90d';
type By = 'project' | 'model' | 'machine';
type Period = 'day' | 'week' | 'month';

const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

function Section({ title, children, hint, testId }: { title: string; children: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <Card className="min-w-0 p-4" data-testid={testId}>
      <h2 className="mb-1 text-base font-semibold tracking-wide">{title}</h2>
      {hint && <p className="mb-3 text-sm text-muted">{hint}</p>}
      {!hint && <div className="mb-2" />}
      {children}
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="min-w-0 p-3">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 truncate text-sm text-muted">{sub}</div>}
    </Card>
  );
}

export default function Analytics() {
  const [range, setRange] = useState<Range>('30d');
  const [by, setBy] = useState<By>('project');
  const [period, setPeriod] = useState<Period>('day');
  const { data, isLoading, error } = useQuery({
    queryKey: ['analytics', range],
    queryFn: () => api.get<AnalyticsData>(`/api/analytics?range=${range}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const cost = useMemo(() => {
    if (!data) return null;
    const buckets = period === 'day' ? data.cost.byDay : period === 'week' ? data.cost.byWeek : data.cost.byMonth;
    const totals = by === 'project' ? data.cost.projects : by === 'model' ? data.cost.models : data.cost.machines;
    const series = topSeries(totals);
    const pick = (b: CostBucket) => (by === 'project' ? b.byProject : by === 'model' ? b.byModel : b.byMachine);
    const bars: BarDatum[] = buckets.map((b) => ({ label: b.period, values: foldOther(pick(b), series) }));
    return { bars, series: series.filter((s) => bars.some((b) => (b.values[s] ?? 0) > 0)) };
  }, [data, by, period]);

  const rateLimitChart = useMemo(() => {
    if (!data?.rateLimits.length) return null;
    return {
      xs: data.rateLimits.map((r) => r.ts),
      five: data.rateLimits.map((r) => r.fiveHourPct),
      seven: data.rateLimits.map((r) => r.sevenDayPct),
    };
  }, [data]);

  return (
    <div data-testid="analytics-page">
      <PageTitle right={<Tabs<Range> tabs={[{ id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }]} value={range} onChange={setRange} />}>Analytics</PageTitle>
      {error && <div role="alert" className="mb-3 rounded-lg border border-error p-3 text-error">Could not load analytics: {(error as Error).message}</div>}
      {isLoading && !data && <div className="text-muted">Loading…</div>}
      {data && cost && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-2 lg:grid-cols-6" data-testid="analytics-totals">
            <Stat label="Cost" value={money(data.totals.costUsd)} sub={`${data.totals.sessions} sessions`} />
            <Stat label="Active time" value={duration(data.totals.activeMs)} sub="sum of session durations" />
            <Stat label="Lines" value={<><span className="text-working">+{data.totals.linesAdded}</span> <span className="text-error">−{data.totals.linesRemoved}</span></>} />
            <Stat label="Tokens out" value={tokens(data.totals.tokens.output)} sub={`${tokens(data.totals.tokens.input)} in`} />
            <Stat label="Cache hit" value={pct(data.totals.cacheHitRatio)} sub={`${tokens(data.totals.tokens.cacheRead)} cached`} />
            <Stat label="Waiting on you" value={duration(data.totals.waitMs)} sub="in permission and idle waits" />
          </div>

          <Section title="Cost" testId="analytics-cost" hint="Each session's cost is counted on the day it started.">
            <div className="mb-2 flex flex-wrap items-center gap-x-4">
              <Tabs<By> tabs={[{ id: 'project', label: 'Project' }, { id: 'model', label: 'Model' }, { id: 'machine', label: 'Machine' }]} value={by} onChange={setBy} />
              <Tabs<Period> tabs={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }]} value={period} onChange={setPeriod} />
            </div>
            <BarChart data={cost.bars} series={cost.series} format={money} labelFormat={(l) => (period === 'month' ? l : l.slice(5))} ariaLabel={`Cost per ${period} by ${by}`} testId="chart-cost" />
            <Legend series={cost.series} />
          </Section>

          <Section title="Tokens" hint={`Cache hit ratio ${pct(data.totals.cacheHitRatio)} of input tokens were read from cache.`}>
            <BarChart
              data={data.tokens.byDay.map((d) => ({ label: d.day, values: { 'cache read': d.cacheRead, 'cache write': d.cacheWrite, input: d.input, output: d.output } }))}
              series={['cache read', 'cache write', 'input', 'output']}
              format={tokens}
              ariaLabel="Tokens per day"
            />
            <Legend series={['cache read', 'cache write', 'input', 'output']} />
            <div className="mt-2 flex items-center gap-3 text-sm text-muted">
              Cache hit by day
              <Sparkline values={data.tokens.byDay.map((d) => (d.cacheHitRatio ?? 0) * 100)} ariaLabel="cache hit ratio by day" />
            </div>
          </Section>

          <Section title="Sessions per day" hint={`${data.totals.sessions} sessions, ${duration(data.totals.activeMs)} active.`}>
            <BarChart data={data.sessions.byDay.map((d) => ({ label: d.day, values: { sessions: d.count } }))} series={['sessions']} format={(n) => String(Math.round(n))} ariaLabel="Sessions per day" />
          </Section>

          <Section title="Active time" hint="Sum of session durations per day.">
            <BarChart data={data.sessions.byDay.map((d) => ({ label: d.day, values: { active: d.activeMs / 60_000 } }))} series={['active']} format={(n) => `${Math.round(n)}m`} ariaLabel="Active minutes per day" />
          </Section>

          <Section title="Lines added and removed">
            <BarChart data={data.sessions.byDay.map((d) => ({ label: d.day, values: { added: d.linesAdded, removed: d.linesRemoved } }))} series={['added', 'removed']} format={(n) => String(Math.round(n))} ariaLabel="Lines added and removed per day" />
            <Legend series={['added', 'removed']} />
          </Section>

          <Section title="Most-used tools" testId="analytics-tools">
            {data.tools.mostUsed.length ? (
              <HBars rows={data.tools.mostUsed.map((t) => ({ label: t.tool, value: t.count, text: t.errors ? `${t.count} · ${t.errors} failed` : String(t.count) }))} />
            ) : (
              <Empty>No tool calls in this range.</Empty>
            )}
          </Section>

          <Section title="Most-failed commands" testId="analytics-failed">
            {data.tools.mostFailedCommands.length ? (
              <ul className="space-y-2">
                {data.tools.mostFailedCommands.map((c) => (
                  <li key={c.command + c.tool} className="flex items-start gap-3 rounded-lg bg-panel-2 p-2.5">
                    <span className="mt-0.5 shrink-0 rounded bg-error px-1.5 font-mono text-sm text-white">{c.count}×</span>
                    <span className="min-w-0 flex-1">
                      <code className="block break-all font-mono text-sm">{c.command}</code>
                      <span className="text-sm text-muted">{c.tool} · last {relTime(c.lastAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No failed commands. Nice.</Empty>
            )}
          </Section>

          <Section title="Permission wait" testId="analytics-wait" hint="How long Claude waited on you: per-session wait time, and the time answered requests sat in the Inbox.">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Session wait" value={duration(data.waits.totalMs)} />
              <Stat label="Answered" value={data.waits.actions.answered} />
              <Stat label="Avg to answer" value={duration(data.waits.actions.avgMs)} sub={data.waits.actions.maxMs != null ? `max ${duration(data.waits.actions.maxMs)}` : undefined} />
            </div>
            {data.waits.actions.byKind.length > 0 && (
              <ul className="mt-3 space-y-1 text-[15px]">
                {data.waits.actions.byKind.map((k) => (
                  <li key={k.kind} className="flex justify-between"><span>{k.kind}</span><span className="font-mono text-sm text-muted">{k.count} · avg {duration(k.avgMs)}</span></li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Job success by prompt" testId="analytics-jobs">
            {data.jobs.byPrompt.length ? (
              <ul className="space-y-3">
                {data.jobs.byPrompt.map((j) => (
                  <li key={String(j.promptId)}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[15px]">{j.title}</span>
                      <span className="shrink-0 font-mono text-sm text-muted">{pct(j.successRate)} of {j.runs}</span>
                    </div>
                    <div className="mt-1 flex h-2 overflow-hidden rounded bg-panel-2">
                      <div className="h-full bg-working" style={{ width: `${(j.succeeded / j.runs) * 100}%` }} />
                      <div className="h-full bg-error" style={{ width: `${(j.failed / j.runs) * 100}%` }} />
                    </div>
                    <div className="mt-0.5 text-sm text-muted">
                      {j.succeeded} ok · {j.failed} failed{j.avgCostUsd != null ? ` · avg ${money(j.avgCostUsd)}` : ''}{j.avgDurationMs != null ? ` · avg ${duration(j.avgDurationMs)}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No jobs yet. Launch one from the Composer.</Empty>
            )}
          </Section>

          <Section title="Rate limits" testId="analytics-rate" hint="Needs the statusline bridge (Settings). Percent of the 5-hour and 7-day windows used.">
            {rateLimitChart ? (
              <>
                <LineChart
                  xs={rateLimitChart.xs}
                  series={[{ name: '5-hour', values: rateLimitChart.five }, { name: '7-day', values: rateLimitChart.seven }]}
                  yMax={100}
                  format={(n) => `${Math.round(n)}%`}
                  xFormat={(x) => new Date(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  ariaLabel="Rate limit usage over time"
                />
                <Legend series={['5-hour', '7-day']} />
              </>
            ) : (
              <Empty>No rate-limit samples. Turn on the statusline bridge in Settings to see them here.</Empty>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
