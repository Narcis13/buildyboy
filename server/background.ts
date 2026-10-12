import type { Ctx } from './context.ts';
import { STALE_AFTER_MS } from './ingest/status.ts';
import { startJobScheduler } from './jobs/scheduler.ts';

/** Periodic jobs: stale detection, retention. Returns a stop function. */
export function startBackground(ctx: Ctx): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(() => {
      try {
        fn();
      } catch (e) {
        console.error('[background]', e);
      }
    }, ms);
    t.unref();
    timers.push(t);
  };

  every(60_000, () => markStale(ctx));
  every(6 * 3600_000, () => purgeOld(ctx));

  const stopJobs = startJobScheduler(ctx);

  return () => {
    timers.forEach(clearInterval);
    stopJobs();
  };
}

export function markStale(ctx: Ctx, now = Date.now()) {
  const rows = ctx.db.all<{ id: string }>("SELECT id FROM sessions WHERE status = 'working' AND last_event_at < ?", now - STALE_AFTER_MS);
  for (const r of rows) {
    ctx.db.run("UPDATE sessions SET status = 'stale' WHERE id = ?", r.id);
    ctx.bus.publish('floor', 'session', { id: r.id });
  }
  return rows.length;
}

/** Retention: raw events and job output older than N days (default 90). Sessions and messages stay. */
export function purgeOld(ctx: Ctx, now = Date.now()) {
  const days = ctx.db.getSetting<number>('retention_days', 90);
  const cutoff = now - days * 24 * 3600_000;
  ctx.db.run('DELETE FROM events WHERE ts < ?', cutoff);
  ctx.db.run('DELETE FROM job_output WHERE ts < ?', cutoff);
  ctx.db.run('DELETE FROM otel_events WHERE ts < ?', cutoff);
}
