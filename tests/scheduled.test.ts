// Scheduled starts (SPEC §11.8): a package's start time, launches scheduled on the server, cron catch-up and the
// governor's rule for scheduled starts on stale data. The server clock is moved with vi.setSystemTime (Date only), and
// the ticks are called directly with that time; the runner is a fake connection in ctx.runners.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { tick } from '../server/factory/line.ts';
import { storeProjectLine } from '../server/factory/projects.ts';
import { fireScheduledLaunches } from '../server/factory/schedule.ts';
import { evaluateScheduled, STALE_START_EVERY_MS } from '../server/factory/governor.ts';
import { digestData, digestText } from '../server/factory/digest.ts';
import { fireSchedules } from '../server/jobs/scheduler.ts';
import { resolveLine } from '../shared/line.ts';
import { DEFAULT_THRESHOLDS, formatStartTime, type Usage } from '../shared/factory.ts';
import type { Notification } from '../server/context.ts';

let srv: TestServer;
let web: WebClient;
let m: { id: string; token: string };
let tmp: string;
const tok: Record<string, { id: string; token: string }> = {};
const notes: Notification[] = [];
const sent: any[] = [];

const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const raw = async (who: string, tool: string, body: unknown = {}) => {
  const r = await fetch(`${srv.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${tok[who].token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json()) as { result?: any; error?: string }) };
};
const call = async (who: string, tool: string, body: unknown = {}) => {
  const a = await raw(who, tool, body);
  if (a.status !== 200) throw new Error(`${tool} ${a.status} ${a.error}`);
  return a.result;
};
const machinePost = (path: string, body: unknown) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const envelope = (event: Record<string, unknown>) => ({ v: 1, ts: Date.now(), env: {}, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 'test', event });
/** A fresh statusline sample, now (by the current, maybe faked, clock). */
async function usage(fivePct = 10, sevenPct = 20, fiveResetsInH = 1) {
  const resets = Math.floor(Date.now() / 1000);
  const r = await machinePost('/api/statusline', {
    session_id: 'sched-usage', rate_limits: { five_hour: { used_percentage: fivePct, resets_at: resets + fiveResetsInH * 3600 }, seven_day: { used_percentage: sevenPct, resets_at: resets + 5 * 86400 } },
  });
  expect(r.ok).toBe(true);
}
const db = () => srv.ctx.db;
const connect = () => srv.ctx.runners.set(m.id, (c) => sent.push(c));
const disconnect = () => srv.ctx.runners.delete(m.id);
const clock = (ms: number) => vi.setSystemTime(ms);
const fire = () => fireScheduledLaunches(srv.ctx, Date.now());
const scheduled = (id: string) => db().get<any>('SELECT * FROM scheduled_launches WHERE id = ?', id)!;
const jobsTitled = (title: string) => db().all<{ id: string }>('SELECT id FROM jobs WHERE title = ?', title);

async function project(key: string, autopilot = false) {
  await web.post('/api/factory/projects', { key, name: key, machineId: m.id, checkout: join(tmp, key) });
  if (!autopilot) return;
  const r = resolveLine({ commands: { verify: 'npm test' } }, { checkoutDir: join(tmp, key) });
  if (!r.ok) throw new Error(r.errors.join('; '));
  storeProjectLine(srv.ctx, key, r.line, null);
  await web.post(`/api/factory/projects/${key}/autopilot`, { on: true });
}

beforeAll(async () => {
  srv = await startTestServer();
  srv.ctx.notify = (n) => notes.push(n);
  web = await srv.login();
  tmp = mkdtempSync(join(tmpdir(), 'bb-sched-'));
  m = createMachine(srv.ctx, 'nightbox', { platform: process.platform });
  db().run('UPDATE machines SET runner_info_json = ? WHERE id = ?', JSON.stringify({ version: '0.2.0', concurrency: 20 }), m.id);
  await machinePost('/api/ingest', envelope({ session_id: 'sched-usage', cwd: tmp, hook_event_name: 'SessionStart' }));
  for (const name of ['launcher', 'approver', 'plain']) tok[name] = createAgentToken(srv.ctx, name);
  await web.put(`/api/agent-tokens/${tok.launcher.id}`, { launch: 'all', launchApproval: false });
  await web.put(`/api/agent-tokens/${tok.approver.id}`, { launch: 'all', launchApproval: true });
});
afterAll(() => srv.stop());
afterEach(async () => {
  vi.useRealTimers();
  db().setSetting('governor_max_age_min', 30);
  disconnect();
  // each test starts from its own usage data and its own launches (a faked clock leaves samples stamped in the future)
  db().run("DELETE FROM otel_points WHERE name = 'statusline.rate_limits'");
  db().run("UPDATE scheduled_launches SET status = 'cancelled', closed_at = ? WHERE status = 'pending'", Date.now());
});

describe("a package's start time", () => {
  it('keeps a gata package out of every path that picks work until its time, then makes it ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    db().setSetting('governor_max_age_min', 1_000_000);
    await usage();
    await project('later', true);
    connect();
    const at = t0 + 2 * H;
    const created = await call('launcher', 'tasks_create', { project: 'later', id: 'A1', title: 'Night package', status: 'gata', notBefore: iso(at) });
    expect(created).toMatchObject({ id: 'A1', status: 'gata', ready: false, notBefore: at, notBeforeText: formatStartTime(at) });

    expect(await call('launcher', 'tasks_list', { ready: true, project: 'later' })).toEqual([]);
    expect(await call('launcher', 'tasks_claim', { project: 'later' })).toMatchObject({ task: null, reason: 'no task of project later is ready to start' });
    const status = await call('launcher', 'factory_status', { project: 'later' });
    expect(status.ready).toEqual([]);
    expect(status.line).toContainEqual(expect.objectContaining({ id: 'A1', status: 'gata', waits: `start time ${formatStartTime(at)}` }));
    // the autopilot skips it
    tick(srv.ctx, 'later', Date.now());
    expect(db().get<{ status: string }>("SELECT status FROM tasks WHERE id = 'A1'")!.status).toBe('gata');
    // naming it does not skip the start time, force neither
    for (const body of [{ id: 'A1' }, { id: 'A1', force: true }]) {
      const r = await raw('launcher', 'tasks_claim', body);
      expect(r.status).toBe(409);
      expect(r.error).toContain(`not before ${formatStartTime(at)}`);
    }
    // a time without an offset is refused
    const bad = await raw('launcher', 'tasks_update', { id: 'A1', notBefore: '2026-11-20T03:30' });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/offset/);

    // the clock passes the start time: ready with no further action, and the autopilot takes it
    clock(at + 60_000);
    await usage();
    expect((await call('launcher', 'tasks_list', { ready: true, project: 'later' })).map((t: any) => t.id)).toEqual(['A1']);
    expect((await call('launcher', 'factory_status', { project: 'later' })).ready.map((t: any) => t.id)).toEqual(['A1']);
    tick(srv.ctx, 'later', Date.now());
    expect(db().get<{ status: string }>("SELECT status FROM tasks WHERE id = 'A1'")!.status).toBe('in_lucru');
  });

  it('is cleared with tasks_update {notBefore: null}, and set from the web', async () => {
    await project('clear');
    const at = Date.now() + 5 * H;
    await call('launcher', 'tasks_create', { project: 'clear', id: 'C1', title: 'Clear me', status: 'gata', notBefore: at });
    expect(await call('launcher', 'tasks_list', { ready: true, project: 'clear' })).toEqual([]);
    const upd = await call('launcher', 'tasks_update', { id: 'C1', notBefore: null });
    expect(upd).toMatchObject({ notBefore: null, notBeforeText: null, ready: true });
    expect((await call('launcher', 'tasks_claim', { id: 'C1', force: true })).task).toMatchObject({ id: 'C1', status: 'in_lucru' });
    // the PWA's patch takes the same field
    const t = await web.post('/api/tasks', { project: 'clear', id: 'C2', title: 'Web', status: 'gata' });
    const patched = await web.put(`/api/tasks/${t.id}`, { notBefore: iso(at) });
    expect(patched).toMatchObject({ notBefore: at, ready: false });
  });
});

describe('scheduled launches', () => {
  it('coordinator_launch with notBefore is kept on the server and starts once, when the runner and the governor allow', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db().setSetting('governor_max_age_min', 1_000_000);
    await usage();
    const at = Date.now() + H;
    const before = db().get<{ n: number }>('SELECT COUNT(*) n FROM jobs')!.n;
    const r = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Night coordinator', notBefore: iso(at), launcher: 'claude' });
    expect(r).toMatchObject({ status: 'scheduled', kind: 'coordinator', notBefore: at, expiresAt: at + 6 * H });
    expect(typeof r.scheduleId).toBe('string');
    expect(db().get<{ n: number }>('SELECT COUNT(*) n FROM jobs')!.n).toBe(before);
    expect((await call('launcher', 'factory_status')).scheduled).toContainEqual(
      expect.objectContaining({ id: r.scheduleId, kind: 'coordinator', title: 'Night coordinator', notBefore: at, expiresAt: at + 6 * H, waits: `start time ${formatStartTime(at)}` }),
    );
    // before its time nothing happens, even with the runner online
    connect();
    expect(fire()).toEqual([]);
    disconnect();

    // past its time, the runner offline: it waits, with the reason
    clock(at + 5 * 60_000);
    await usage();
    expect(fire()).toEqual([]);
    expect(scheduled(r.scheduleId)).toMatchObject({ status: 'pending', waits: 'runner offline on nightbox' });
    // the governor says no for a reason other than stale data: it waits
    connect();
    await usage(95);
    expect(fire()).toEqual([]);
    expect(scheduled(r.scheduleId).waits).toMatch(/^governor: 5-hour window at 95%/);
    expect((await call('launcher', 'schedules_list')).find((s: any) => s.id === r.scheduleId)).toMatchObject({ status: 'pending', waits: expect.stringMatching(/^governor/) });
    // usage drops, the runner is there: it starts exactly once, even when two ticks race
    await usage(10);
    const [a, b] = await Promise.all([Promise.resolve().then(fire), Promise.resolve().then(fire)]);
    expect([...a, ...b]).toHaveLength(1);
    expect(fire()).toEqual([]);
    expect(jobsTitled('Night coordinator')).toHaveLength(1);
    expect(scheduled(r.scheduleId)).toMatchObject({ status: 'started', job_id: jobsTitled('Night coordinator')[0].id, waits: null });
    expect((await call('launcher', 'factory_status')).scheduled.find((s: any) => s.id === r.scheduleId)).toBeUndefined();

    // a second coordinator with the same title waits while the first one is live on that machine
    const twin = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Night coordinator', notBefore: Date.now() - 1000, launcher: 'claude' });
    expect(fire()).toEqual([]);
    expect(scheduled(twin.scheduleId).waits).toBe('a session named "Night coordinator" is already live on nightbox');
    await call('launcher', 'schedule_cancel', { id: twin.scheduleId });
  });

  it('a scheduled hc launch waits for a signed-in Windows session', async () => {
    db().setSetting('governor_max_age_min', 1_000_000);
    await usage();
    db().run('UPDATE machines SET runner_info_json = ? WHERE id = ?', JSON.stringify({ version: '0.2.0', concurrency: 20, interactiveSession: false }), m.id);
    expect((await call('launcher', 'machines_list')).find((x: any) => x.id === m.id).interactiveSession).toBe(false);
    connect();
    const r = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'HC coordinator', notBefore: Date.now() - 1000 });
    expect(fire()).toEqual([]);
    expect(scheduled(r.scheduleId).waits).toMatch(/^no signed-in Windows session on nightbox/);
    db().run('UPDATE machines SET runner_info_json = ? WHERE id = ?', JSON.stringify({ version: '0.2.0', concurrency: 20, interactiveSession: true }), m.id);
    expect(fire()).toHaveLength(1);
    expect(scheduled(r.scheduleId).status).toBe('started');
  });

  it('is missed after its window, with one alert, a notification and a digest line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db().setSetting('governor_max_age_min', 1_000_000);
    await usage();
    const at = Date.now() + H;
    const r = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Missed coordinator', notBefore: iso(at), catchUpHours: 1, launcher: 'claude' });
    expect(r.expiresAt).toBe(at + H);
    clock(at + 10 * 60_000);
    expect(fire()).toEqual([]); // runner offline
    clock(at + H + 60_000);
    notes.length = 0;
    connect();
    expect(fire()).toEqual([]);
    expect(fire()).toEqual([]);
    expect(jobsTitled('Missed coordinator')).toHaveLength(0);
    expect(scheduled(r.scheduleId)).toMatchObject({ status: 'missed', waits: 'runner offline on nightbox' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'factory', title: 'Scheduled start missed: Missed coordinator' });
    expect(notes[0].body).toContain('runner offline');
    const alerts: string[] = (await call('launcher', 'factory_status')).alerts;
    expect(alerts.filter((a) => a.startsWith('scheduled start missed: Missed coordinator'))).toHaveLength(1);
    expect(digestText(digestData(srv.ctx)).body.split('\n').filter((l) => l.startsWith('Missed scheduled starts:') && l.includes('Missed coordinator'))).toHaveLength(1);
    const list = await web.get('/api/scheduled-launches');
    expect(list.find((s: any) => s.id === r.scheduleId)).toMatchObject({ status: 'missed' });
  });

  it('schedule_cancel cancels it, for tokens that may launch that kind', async () => {
    const r = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Cancelled', notBefore: Date.now() + H, launcher: 'claude' });
    expect((await raw('plain', 'schedule_cancel', { id: r.scheduleId })).status).toBe(403);
    expect(await call('launcher', 'schedule_cancel', { id: r.scheduleId })).toMatchObject({ id: r.scheduleId, status: 'cancelled' });
    expect((await raw('launcher', 'schedule_cancel', { id: r.scheduleId })).status).toBe(409);
    expect((await raw('plain', 'coordinator_launch', { machineId: m.id, cwd: tmp, notBefore: Date.now() + H })).status).toBe(403);
    // the web cancels too
    const w = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Web cancel', notBefore: Date.now() + H, launcher: 'claude' });
    expect(await web.post(`/api/scheduled-launches/${w.scheduleId}/cancel`)).toMatchObject({ status: 'cancelled' });
    connect();
    expect(fireScheduledLaunches(srv.ctx, Date.now() + 2 * H)).toEqual([]);
  });

  it('tasks_launch with notBefore keeps the package gata with that start time until the real start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db().setSetting('governor_max_age_min', 1_000_000);
    await usage();
    await project('night');
    await call('launcher', 'tasks_create', { project: 'night', id: 'W1', title: 'Night worker', status: 'gata' });
    await call('launcher', 'tasks_create', { project: 'night', id: 'W2', title: 'Not ready', status: 'backlog' });
    expect((await raw('launcher', 'tasks_launch', { taskId: 'W2', machineId: m.id, cwd: tmp, notBefore: Date.now() + H })).status).toBe(409);
    const at = Date.now() + H;
    const r = await call('launcher', 'tasks_launch', { taskId: 'W1', machineId: m.id, cwd: tmp, notBefore: iso(at), launcher: 'claude' });
    expect(r).toMatchObject({ status: 'scheduled', kind: 'worker', taskId: 'W1', notBefore: at, expiresAt: at + 6 * H });
    expect(await call('launcher', 'tasks_get', { id: 'W1' })).toMatchObject({ status: 'gata', notBefore: at, ready: false, jobId: null });
    expect((await raw('launcher', 'tasks_claim', { id: 'W1' })).status).toBe(409);
    expect((await raw('launcher', 'tasks_launch', { taskId: 'W1', machineId: m.id, cwd: tmp, launcher: 'claude' })).status).toBe(409); // immediate: the start time
    expect((await raw('launcher', 'tasks_launch', { taskId: 'W1', machineId: m.id, cwd: tmp, notBefore: at + H })).status).toBe(409); // already scheduled
    expect((await call('launcher', 'schedules_list', { project: 'night' })).map((s: any) => s.id)).toEqual([r.scheduleId]);

    clock(at + 60_000);
    await usage();
    connect();
    const [a, b] = await Promise.all([Promise.resolve().then(fire), Promise.resolve().then(fire)]);
    expect([...a, ...b]).toHaveLength(1);
    expect(await call('launcher', 'tasks_get', { id: 'W1' })).toMatchObject({ status: 'in_lucru', jobId: [...a, ...b][0] });
    expect(scheduled(r.scheduleId).status).toBe('started');
  });

  it('asks the approval at scheduling time, naming the start time', async () => {
    const at = Date.now() + 3 * H;
    const args = { machineId: m.id, cwd: tmp, title: 'Approved later', notBefore: iso(at), launcher: 'claude' };
    const first = await call('approver', 'coordinator_launch', args);
    expect(first.status).toBe('pending_approval');
    const d = db().get<{ question: string }>('SELECT question FROM decisions WHERE id = ?', first.decisionId)!;
    expect(d.question).toContain(formatStartTime(at));
    await web.post(`/api/decisions/${first.decisionId}/answer`, { answer: 'Launch' });
    const again = await call('approver', 'coordinator_launch', args);
    expect(again).toMatchObject({ status: 'scheduled', decisionId: first.decisionId, notBefore: at });
    // the approval was for that time only
    expect((await call('approver', 'coordinator_launch', { ...args, notBefore: iso(at + H) })).status).toBe('pending_approval');
  });
});

describe('cron catch-up', () => {
  const at = (h: number, min: number, day = 20) => new Date(2026, 10, day, h, min).getTime();
  async function schedule(cron: string, catchUpMinutes?: number) {
    const { id } = await web.post('/api/schedules', { cron, job: { promptText: 'Nightly', machineId: m.id, cwd: tmp }, ...(catchUpMinutes === undefined ? {} : { catchUpMinutes }) });
    db().run('UPDATE schedules SET created_at = ?, last_run_at = ? WHERE id = ?', at(12, 0, 19), at(3, 30, 19), id);
    return id;
  }
  const remove = (id: string) => web.del(`/api/schedules/${id}`);

  it('fires a missed minute once at the next tick within the window, and records caughtUp', async () => {
    const id = await schedule('30 3 * * *');
    expect((await web.get('/api/schedules')).find((s: any) => s.id === id).catchUpMinutes).toBe(120);
    const fired = fireSchedules(srv.ctx, at(4, 10));
    expect(fired).toHaveLength(1);
    expect((await web.get(`/api/jobs/${fired[0]}`)).caughtUp).toBe(true);
    expect(fireSchedules(srv.ctx, at(4, 11))).toEqual([]);
    expect(fireSchedules(srv.ctx, at(5, 0))).toEqual([]);
    // on time, it is not a catch-up
    const onTime = fireSchedules(srv.ctx, at(3, 30, 21) + 5000);
    expect(onTime).toHaveLength(1);
    expect((await web.get(`/api/jobs/${onTime[0]}`)).caughtUp).toBe(false);
    await remove(id);
  });

  it('never fires more than once for several missed minutes', async () => {
    const id = await schedule('*/10 * * * *');
    db().run('UPDATE schedules SET last_run_at = ? WHERE id = ?', at(1, 0), id);
    expect(fireSchedules(srv.ctx, at(1, 55))).toHaveLength(1);
    expect(fireSchedules(srv.ctx, at(1, 56))).toEqual([]);
    expect(fireSchedules(srv.ctx, at(2, 0))).toHaveLength(1);
    await remove(id);
  });

  it('does not fire outside the window, nor with catch-up off', async () => {
    const late = await schedule('30 3 * * *');
    expect(fireSchedules(srv.ctx, at(5, 31))).toEqual([]);
    expect(fireSchedules(srv.ctx, at(6, 0))).toEqual([]);
    await remove(late);
    const off = await schedule('30 3 * * *', 0);
    expect(fireSchedules(srv.ctx, at(3, 31))).toEqual([]);
    expect(fireSchedules(srv.ctx, at(3, 30, 21))).toHaveLength(1);
    await remove(off);
  });
});

describe("the governor's rule for scheduled starts", () => {
  const now = Date.UTC(2026, 10, 20, 1, 30);
  const sample = (five: { pct: number; resetsAt: number | null } | null, seven: { pct: number; resetsAt: number | null } | null, ageMin = 300): Usage => ({
    fiveHour: five, sevenDay: seven, updatedAt: now - ageMin * 60_000, ageMs: ageMin * 60_000, sessionId: 's',
  });
  const T = DEFAULT_THRESHOLDS;

  it('allows a start when stale data is the only reason and each window is safe', () => {
    const ok = evaluateScheduled(sample({ pct: 80, resetsAt: now - H }, { pct: 70, resetsAt: now + 3 * 86400_000 }), T, now, null);
    expect(ok.canStart).toBe(true);
    expect(ok.reason).toMatch(/^started on stale usage data: usage data is 300 min old; last known 5-hour window reset at .*, 7-day 70% \(limit 80%\)$/);
    // too close to a limit, a window missing, fresh data, or a blocking window: today's rule
    expect(evaluateScheduled(sample({ pct: 10, resetsAt: now + H }, { pct: 71, resetsAt: now + 86400_000 }), T, now, null).canStart).toBe(false);
    expect(evaluateScheduled(sample({ pct: 10, resetsAt: now + H }, null), T, now, null).canStart).toBe(false);
    expect(evaluateScheduled(sample({ pct: 90, resetsAt: now + H }, { pct: 10, resetsAt: now + 86400_000 }), T, now, null)).toMatchObject({ canStart: false, reason: expect.stringMatching(/^5-hour window at 90%/) });
    expect(evaluateScheduled(sample({ pct: 10, resetsAt: now + H }, { pct: 10, resetsAt: now + 86400_000 }, 5), T, now, null)).toMatchObject({ canStart: true, reason: 'ok: 5-hour 10%, 7-day 10%' });
    // one per 30 minutes
    const again = evaluateScheduled(sample({ pct: 10, resetsAt: now + H }, { pct: 10, resetsAt: now + 86400_000 }), T, now, now - 10 * 60_000);
    expect(again).toMatchObject({ canStart: false, waitUntil: now + 20 * 60_000 });
    expect(again.reason).toMatch(/one such start per 30 min/);
    expect(evaluateScheduled(sample({ pct: 10, resetsAt: now + H }, { pct: 10, resetsAt: now + 86400_000 }), T, now, now - STALE_START_EVERY_MS).canStart).toBe(true);
  });

  it('lets a scheduled launch start on stale data, and only a scheduled one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await usage(10, 20);
    await project('stale');
    await call('launcher', 'tasks_create', { project: 'stale', id: 'S1', title: 'Stale night', status: 'gata' });
    const at = Date.now() + 4 * H;
    const r = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Stale coordinator', notBefore: iso(at), launcher: 'claude' });
    const r2 = await call('launcher', 'coordinator_launch', { machineId: m.id, cwd: tmp, title: 'Second stale', notBefore: iso(at), launcher: 'claude' });
    clock(at + 60_000); // the last sample is 4 h old: stale, the 5-hour window has reset, the 7-day one is at 20%
    connect();
    const g = await call('launcher', 'governor_get');
    expect(g.canStart).toBe(false);
    expect(g.reason).toMatch(/^usage data is \d+ min old/);
    // an unscheduled launch in the same state is refused
    const now = await raw('launcher', 'tasks_launch', { taskId: 'S1', machineId: m.id, cwd: tmp, launcher: 'claude' });
    expect(now.status).toBe(409);
    expect(now.error).toMatch(/^governor: usage data is/);
    // the scheduled one starts, and says why; the second waits (one per 30 min)
    expect(fire()).toHaveLength(1);
    expect(scheduled(r.scheduleId)).toMatchObject({ status: 'started', stale_start: 1 });
    expect(scheduled(r2.scheduleId)).toMatchObject({ status: 'pending', waits: expect.stringMatching(/one such start per 30 min/) });
    const logged = db().get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'governor_stale_start' ORDER BY id DESC LIMIT 1")!;
    expect(JSON.parse(logged.detail).reason).toMatch(/^started on stale usage data: /);
    // 30 minutes later the second one may go
    clock(at + 32 * 60_000);
    expect(fire()).toHaveLength(1);
    expect(scheduled(r2.scheduleId).status).toBe('started');
  });
});
