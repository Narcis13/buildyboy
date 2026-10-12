import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { cronMatches } from './cron.ts';
import { createJob, dispatch, markLostDisconnected, type NewJob } from './core.ts';

/** Fires each enabled schedule at most once per matching (server local time) minute. Returns created job ids. */
export function fireSchedules(ctx: Ctx, now = Date.now()): string[] {
  const minute = Math.floor(now / 60_000) * 60_000;
  const out: string[] = [];
  for (const s of ctx.db.all<{ id: string; cron: string; job_template_json: string; last_run_at: number | null }>('SELECT * FROM schedules WHERE enabled = 1')) {
    try {
      if ((s.last_run_at ?? 0) >= minute || !cronMatches(s.cron, new Date(now))) continue;
      ctx.db.run('UPDATE schedules SET last_run_at = ? WHERE id = ?', now, s.id);
      const t = json<NewJob>(s.job_template_json);
      if (!t) continue;
      out.push(createJob(ctx, { ...t, scheduleId: s.id }));
      ctx.db.audit('scheduler', 'schedule_fired', s.id, { jobId: out[out.length - 1] });
    } catch (e) {
      console.error('[scheduler]', s.id, (e as Error).message);
    }
  }
  return out;
}

/** Job queue dispatch, lost-runner detection and cron schedules. Returns a stop function. */
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
  a.unref();
  b.unref();
  return () => {
    clearInterval(a);
    clearInterval(b);
  };
}
