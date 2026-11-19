import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { cronMatches, parseCron } from './cron.ts';
import { createJob, dispatch, markLostDisconnected, type NewJob } from './core.ts';

/** Default catch-up window of a cron schedule, in minutes (0 = off); the longest one allowed. */
export const CATCH_UP_MINUTES = { default: 120, max: 1440 } as const;

/**
 * The most recent minute (server local time) at or before `now` that the cron matches, later than `after` and at most
 * `windowMin` minutes back; null when there is none.
 */
export function lastMatch(cron: string, now: number, after: number, windowMin: number): number | null {
  const c = parseCron(cron);
  const minute = Math.floor(now / 60_000) * 60_000;
  for (let m = minute; m > after && m >= minute - windowMin * 60_000; m -= 60_000) if (cronMatches(c, new Date(m))) return m;
  return null;
}

/**
 * Fires each enabled schedule at most once per matching (server local time) minute. A schedule whose matching minute
 * fell while the scheduler was not running (the server or the PC was down) fires once at the next tick when that
 * minute is within its catch-up window, however many minutes were missed; the job records caughtUp. Returns created
 * job ids.
 */
export function fireSchedules(ctx: Ctx, now = Date.now()): string[] {
  const out: string[] = [];
  for (const s of ctx.db.all<{ id: string; cron: string; job_template_json: string; last_run_at: number | null; created_at: number; catch_up_minutes: number }>(
    'SELECT * FROM schedules WHERE enabled = 1',
  )) {
    try {
      // runs before the schedule existed are not missed runs
      const after = Math.max(s.last_run_at ?? 0, Math.floor(s.created_at / 60_000) * 60_000 - 1);
      const at = lastMatch(s.cron, now, after, Math.min(Math.max(0, s.catch_up_minutes), CATCH_UP_MINUTES.max));
      if (at === null) continue;
      const caughtUp = at < Math.floor(now / 60_000) * 60_000;
      ctx.db.run('UPDATE schedules SET last_run_at = ? WHERE id = ?', now, s.id);
      const t = json<NewJob>(s.job_template_json);
      if (!t) continue;
      const jobId = createJob(ctx, { ...t, scheduleId: s.id });
      if (caughtUp) ctx.db.run('UPDATE jobs SET caught_up = 1 WHERE id = ?', jobId);
      out.push(jobId);
      ctx.db.audit('scheduler', 'schedule_fired', s.id, { jobId, ...(caughtUp ? { caughtUp: true, missedMinute: at } : {}) });
    } catch (e) {
      console.error('[scheduler]', s.id, (e as Error).message);
    }
  }
  return out;
}

/** Job queue dispatch, lost-runner detection and cron schedules (also once at start: catch-up). Returns a stop function. */
export function startJobScheduler(ctx: Ctx): () => void {
  const tick = (fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      console.error('[jobs]', e);
    }
  };
  const a = setInterval(tick(() => {
    markLostDisconnected(ctx);
    dispatch(ctx);
  }), 5_000);
  const b = setInterval(tick(() => fireSchedules(ctx)), 15_000);
  const first = setTimeout(tick(() => fireSchedules(ctx)), 0);
  a.unref();
  b.unref();
  return () => {
    clearInterval(a);
    clearInterval(b);
    clearTimeout(first);
  };
}
