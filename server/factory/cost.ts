// A package's exact cost (SPEC §11.7): the sum of every session linked to it, split by role. A session is linked when
// its hook events carry BB_TASK (with BB_ROLE: lucrator, qa, poarta, coordonator), when it runs in the package's herdr
// terminal (tasks.session_id) or when it is the package's job. The last two count as lucrator.
import type { Ctx } from '../context.ts';
import { ROLES, type Role } from '../../shared/factory.ts';

const SWEEP_KEY = 'task_link_event_id';

/** Links sessions tagged BB_TASK in hook events newer than the last sweep. Cheap: it reads only new events. */
export function syncTaskSessions(ctx: Ctx) {
  const { db } = ctx;
  const last = Number(db.getSetting<unknown>(SWEEP_KEY, 0)) || 0;
  const max = db.get<{ m: number | null }>('SELECT MAX(id) m FROM events')?.m ?? 0;
  if (max <= last) return;
  const rows = db.all<{ session_id: string; task: unknown; role: unknown; ts: number }>(
    `SELECT session_id, json_extract(payload_json, '$._env.BB_TASK') task, json_extract(payload_json, '$._env.BB_ROLE') role, ts
     FROM events WHERE id > ? AND id <= ? AND payload_json LIKE '%"BB_TASK"%' ORDER BY id`, last, max,
  );
  db.tx(() => {
    for (const r of rows) {
      if (typeof r.task !== 'string' || !/^[\w.-]{1,64}$/.test(r.task)) continue;
      const role = typeof r.role === 'string' && ROLES.includes(r.role.toLowerCase() as Role) ? r.role.toLowerCase() : 'lucrator';
      if (db.run('INSERT OR IGNORE INTO task_sessions (task_id, session_id, role, linked_at) VALUES (?, ?, ?, ?)', r.task, r.session_id, role, r.ts).changes) {
        ctx.bus.publish('tasks', 'changed', { id: r.task });
      }
    }
    db.setSetting(SWEEP_KEY, max);
  });
}

export interface TaskCost {
  total: number;
  byRole: Partial<Record<Role, number>>;
  sessions: number;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Measured cost per task id, for the tasks that have at least one linked session. */
export function taskCosts(ctx: Ctx, ids: string[]): Map<string, TaskCost> {
  const out = new Map<string, TaskCost>();
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  const rows = ctx.db.all<{ task_id: string; session_id: string; role: Role; cost: number; pri: number }>(
    `SELECT ts.task_id, s.id session_id, ts.role, s.cost_usd cost, 0 pri FROM task_sessions ts JOIN sessions s ON s.id = ts.session_id WHERE ts.task_id IN (${marks})
     UNION ALL SELECT t.id, s.id, 'lucrator', s.cost_usd, 1 FROM tasks t JOIN sessions s ON s.id = t.session_id WHERE t.id IN (${marks})
     UNION ALL SELECT t.id, s.id, 'lucrator', s.cost_usd, 1 FROM tasks t JOIN sessions s ON s.job_id = t.job_id WHERE t.job_id IS NOT NULL AND t.id IN (${marks})
     ORDER BY pri`,
    ...ids, ...ids, ...ids,
  );
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.task_id}\u0000${r.session_id}`;
    if (seen.has(k)) continue; // a BB_ROLE tag wins over the terminal or job link
    seen.add(k);
    const c = out.get(r.task_id) ?? { total: 0, byRole: {}, sessions: 0 };
    c.total = round(c.total + (r.cost ?? 0));
    c.byRole[r.role] = round((c.byRole[r.role] ?? 0) + (r.cost ?? 0));
    c.sessions++;
    out.set(r.task_id, c);
  }
  return out;
}
