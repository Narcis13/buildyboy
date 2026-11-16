// The digest (SPEC §11.5): once a day at a configurable time, and on demand (digest_post), a phone notification with
// what was integrated, the gates, usage and the decisions that wait. When its packages come from more than one
// project (§12.1), each line names their project. Decisions answered by operators (§12.7) are listed with who answered.
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
  /** the pending decisions themselves, oldest first */
  decisions: { id: string; taskId: string | null; question: string; ageMs: number }[];
  /** package warnings of the last 24 h (e.g. renumber migrations) */
  warnings: { taskId: string; message: string }[];
  controlsOpen: number;
  usage: { fiveHourPct: number | null; sevenDayPct: number | null; canStart: boolean; stopAll: boolean; reason: string };
  note: string | null;
  /** the project of every package named above that has one */
  projects?: Record<string, string>;
  /** decisions answered (or cancelled: answer null) by operators in the period (§12.7), oldest first */
  operatorAnswers?: { id: string; by: string; taskId: string | null; question: string; answer: string | null }[];
}

export function digestData(ctx: Ctx, now = Date.now(), note: string | null = null): DigestData {
  const { db } = ctx;
  const since = now - DAY;
  const gates = db.all<{ task_id: string; gate: string; verdict: string }>('SELECT task_id, gate, verdict FROM gate_results WHERE created_at > ? ORDER BY id', since);
  const g = governor(ctx, now);
  const n = (sql: string) => db.get<{ n: number }>(sql)!.n;
  const d: DigestData = {
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
    blocked: db.all<{ id: string }>("SELECT id FROM tasks WHERE status = 'blocata' AND archived_at IS NULL ORDER BY id").map((t) => t.id),
    inProgress: db.all<{ id: string }>("SELECT id FROM tasks WHERE status IN ('in_lucru','la_porti') AND archived_at IS NULL ORDER BY id").map((t) => t.id),
    decisionsPending: n("SELECT COUNT(*) n FROM decisions WHERE status = 'pending'"),
    decisions: db
      .all<{ id: string; task_id: string | null; question: string; created_at: number }>("SELECT id, task_id, question, created_at FROM decisions WHERE status = 'pending' ORDER BY created_at LIMIT 20")
      .map((d) => ({ id: d.id, taskId: d.task_id, question: d.question, ageMs: Math.max(0, now - d.created_at) })),
    warnings: db
      .all<{ task_id: string; detail_json: string | null }>("SELECT task_id, detail_json FROM task_events WHERE kind = 'warning' AND ts > ? ORDER BY ts", since)
      .map((w) => ({ taskId: w.task_id, message: String((JSON.parse(w.detail_json ?? '{}') as { message?: unknown }).message ?? '') })),
    controlsOpen: n("SELECT COUNT(*) n FROM control_requests WHERE status = 'open'"),
    operatorAnswers: db
      .all<{ id: string; answered_by: string; task_id: string | null; question: string; answer: string | null }>(
        "SELECT id, answered_by, task_id, question, answer FROM decisions WHERE answered_at > ? AND answered_by LIKE 'agent:%' ORDER BY answered_at LIMIT 20", since,
      )
      .map((d) => ({ id: d.id, by: d.answered_by.slice('agent:'.length), taskId: d.task_id, question: d.question, answer: d.answer })),
    usage: { fiveHourPct: g.usage.fiveHour?.pct ?? null, sevenDayPct: g.usage.sevenDay?.pct ?? null, canStart: g.canStart, stopAll: g.stopAll, reason: g.reason },
    note,
  };
  const named = [...new Set([
    ...d.integrated.map((t) => t.id), ...d.gates.failed.map((f) => f.taskId), ...d.blocked, ...d.inProgress, ...d.warnings.map((w) => w.taskId),
    ...d.decisions.flatMap((x) => (x.taskId ? [x.taskId] : [])), ...(d.operatorAnswers ?? []).flatMap((x) => (x.taskId ? [x.taskId] : [])),
  ])];
  d.projects = {};
  for (let i = 0; i < named.length; i += 500) {
    const ids = named.slice(i, i + 500);
    for (const r of db.all<{ id: string; project: string }>(`SELECT id, project FROM tasks WHERE project IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`, ...ids)) d.projects[r.id] = r.project;
  }
  return d;
}

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v)}%`);

/** "40 min", "5 h", "3 d" */
export function age(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export function digestText(d: DigestData): { title: string; body: string } {
  // with packages from more than one project, lists group by project ("arond: P8, P9; shop: ED-3") and single
  // packages carry it ("shop ED-3")
  const projects = d.projects ?? {};
  const multi = new Set(Object.values(projects)).size > 1;
  const one = (id: string) => (multi && projects[id] ? `${projects[id]} ${id}` : id);
  const many = (items: { id: string; text: string }[]) => {
    if (!multi) return items.map((i) => i.text).join(', ');
    const by = new Map<string, string[]>();
    for (const i of items) by.set(projects[i.id] ?? '', [...(by.get(projects[i.id] ?? '') ?? []), i.text]);
    return [...by].map(([k, v]) => (k ? `${k}: ${v.join(', ')}` : v.join(', '))).join('; ');
  };
  const ids = (list: string[]) => many(list.map((id) => ({ id, text: id })));
  const lines: string[] = [];
  if (d.note) lines.push(d.note);
  lines.push(
    d.integrated.length
      ? `Integrated: ${many(d.integrated.map((t) => ({ id: t.id, text: `${t.id}${t.sensitive ? ' (sensitive)' : ''}` })))}`
      : 'Integrated: nothing in the last 24 h',
  );
  lines.push(`Gates: ${d.gates.pass} passed, ${d.gates.fail} failed${d.gates.failed.length ? ` (${many(d.gates.failed.slice(0, 6).map((f) => ({ id: f.taskId, text: `${f.taskId} ${f.gate}` })))})` : ''}`);
  if (d.inProgress.length) lines.push(`In progress: ${ids(d.inProgress)}`);
  if (d.blocked.length) lines.push(`Blocked: ${ids(d.blocked)}`);
  lines.push(`Usage: 5 h ${pct(d.usage.fiveHourPct)}, 7 d ${pct(d.usage.sevenDayPct)}${d.usage.stopAll ? ' — factory stopped' : d.usage.canStart ? '' : ' — no new workers'}`);
  for (const w of d.warnings ?? []) lines.push(`Warning ${one(w.taskId)}: ${w.message}`);
  if (d.decisionsPending) {
    lines.push(`Decisions waiting: ${d.decisionsPending}`);
    for (const q of d.decisions ?? []) lines.push(`  · ${q.taskId ? `${one(q.taskId)}, ` : ''}${age(q.ageMs)}: ${q.question.length > 90 ? `${q.question.slice(0, 89)}…` : q.question}`);
  }
  if (d.operatorAnswers?.length) {
    lines.push(`Answered by operators: ${d.operatorAnswers.length}`);
    const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    for (const a of d.operatorAnswers) {
      lines.push(`  · ${a.by}${a.taskId ? `, ${one(a.taskId)}` : ''}: ${short(a.question, 70)} → ${a.answer === null ? 'cancelled' : short(a.answer, 50)}`);
    }
  }
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
