// The digest (SPEC §11.5): once a day at a configurable time, and on demand (digest_post), a phone notification with
// what was integrated, the gates, usage and the decisions that wait.
import type { Ctx } from '../context.ts';
import type { DigestView } from '../../shared/factory.ts';
import { governor } from './governor.ts';

const DAY = 24 * 3600_000;

export interface DigestData {
  since: number;
  integrated: { id: string; title: string; sensitive: boolean }[];
  gates: { pass: number; fail: number; skip: number; failed: { taskId: string; gate: string }[] };
  blocked: string[];
  inProgress: string[];
  decisionsPending: number;
  controlsOpen: number;
  usage: { fiveHourPct: number | null; sevenDayPct: number | null; canStart: boolean; stopAll: boolean; reason: string };
  note: string | null;
}

export function digestData(ctx: Ctx, now = Date.now(), note: string | null = null): DigestData {
  const { db } = ctx;
  const since = now - DAY;
  const gates = db.all<{ task_id: string; gate: string; verdict: string }>('SELECT task_id, gate, verdict FROM gate_results WHERE created_at > ? ORDER BY id', since);
  const g = governor(ctx, now);
  const n = (sql: string) => db.get<{ n: number }>(sql)!.n;
  return {
    since,
    integrated: db
      .all<{ id: string; title: string; sensitive: number }>("SELECT id, title, sensitive FROM tasks WHERE status = 'integrata' AND integrated_at > ? ORDER BY integrated_at", since)
      .map((t) => ({ id: t.id, title: t.title, sensitive: !!t.sensitive })),
    gates: {
      pass: gates.filter((x) => x.verdict === 'pass').length,
      fail: gates.filter((x) => x.verdict === 'fail').length,
      skip: gates.filter((x) => x.verdict === 'skip').length,
      failed: gates.filter((x) => x.verdict === 'fail').map((x) => ({ taskId: x.task_id, gate: x.gate })),
    },
    blocked: db.all<{ id: string }>("SELECT id FROM tasks WHERE status = 'blocata' ORDER BY id").map((t) => t.id),
    inProgress: db.all<{ id: string }>("SELECT id FROM tasks WHERE status IN ('in_lucru','la_porti') ORDER BY id").map((t) => t.id),
    decisionsPending: n("SELECT COUNT(*) n FROM decisions WHERE status = 'pending'"),
    controlsOpen: n("SELECT COUNT(*) n FROM control_requests WHERE status = 'open'"),
    usage: { fiveHourPct: g.usage.fiveHour?.pct ?? null, sevenDayPct: g.usage.sevenDay?.pct ?? null, canStart: g.canStart, stopAll: g.stopAll, reason: g.reason },
    note,
  };
}

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v)}%`);

export function digestText(d: DigestData): { title: string; body: string } {
  const lines: string[] = [];
  if (d.note) lines.push(d.note);
  lines.push(
    d.integrated.length
      ? `Integrated: ${d.integrated.map((t) => `${t.id}${t.sensitive ? ' (sensitive)' : ''}`).join(', ')}`
      : 'Integrated: nothing in the last 24 h',
  );
  lines.push(`Gates: ${d.gates.pass} passed, ${d.gates.fail} failed${d.gates.failed.length ? ` (${d.gates.failed.slice(0, 6).map((f) => `${f.taskId} ${f.gate}`).join(', ')})` : ''}`);
  if (d.inProgress.length) lines.push(`In progress: ${d.inProgress.join(', ')}`);
  if (d.blocked.length) lines.push(`Blocked: ${d.blocked.join(', ')}`);
  lines.push(`Usage: 5 h ${pct(d.usage.fiveHourPct)}, 7 d ${pct(d.usage.sevenDayPct)}${d.usage.stopAll ? ' — factory stopped' : d.usage.canStart ? '' : ' — no new workers'}`);
  if (d.decisionsPending) lines.push(`Decisions waiting: ${d.decisionsPending}`);
  if (d.controlsOpen) lines.push(`Your stop/revert requests not yet handled: ${d.controlsOpen}`);
  const title = `Factory digest: ${d.integrated.length} integrated${d.decisionsPending ? `, ${d.decisionsPending} decision${d.decisionsPending > 1 ? 's' : ''} waiting` : ''}`;
  return { title, body: lines.join('\n') };
}

export function sendDigest(ctx: Ctx, kind: 'daily' | 'manual', note: string | null = null, now = Date.now()): DigestView {
  const data = digestData(ctx, now, note);
  const { title, body } = digestText(data);
  const r = ctx.db.run('INSERT INTO digests (ts, kind, title, body, data_json) VALUES (?, ?, ?, ?, ?)', now, kind, title, body, JSON.stringify(data));
  ctx.notify({ type: 'digest', title, body, url: '/backlog' });
  ctx.bus.publish('tasks', 'digest');
  return { id: Number(r.lastInsertRowid), ts: now, kind, title, body };
}

export function listDigests(ctx: Ctx, limit = 30): DigestView[] {
  return ctx.db.all<DigestView>('SELECT id, ts, kind, title, body FROM digests ORDER BY ts DESC, id DESC LIMIT ?', limit);
}

/** Today's scheduled time (local server time, "HH:MM" in settings.digest_time, default 08:00). */
export function scheduledAt(time: string, now: number): number {
  const [h, m] = /^\d{1,2}:\d{2}$/.test(time) ? time.split(':').map(Number) : [8, 0];
  const d = new Date(now);
  d.setHours(Math.min(h, 23), Math.min(m, 59), 0, 0);
  return d.getTime();
}

/** Called every minute: sends the daily digest once the scheduled time has passed today. */
export function maybeDailyDigest(ctx: Ctx, now = Date.now()): DigestView | null {
  if (ctx.db.getSetting<boolean>('digest_enabled', true) === false) return null;
  const at = scheduledAt(ctx.db.getSetting<string>('digest_time', '08:00'), now);
  if (now < at) return null;
  const last = ctx.db.get<{ ts: number }>("SELECT MAX(ts) ts FROM digests WHERE kind = 'daily'")?.ts ?? 0;
  if (last >= at) return null;
  return sendDigest(ctx, 'daily', null, now);
}
