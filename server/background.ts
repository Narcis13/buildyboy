import type { Ctx } from './context.ts';
import { runWatchers } from './watchers.ts';
import { startGithubPoller } from './github/poller.ts';
import { startJobScheduler } from './jobs/scheduler.ts';

/** Periodic jobs: watchers, retention, the job scheduler and the GitHub poller. Returns a stop function. */
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

  every(60_000, () => runWatchers(ctx));
  every(6 * 3600_000, () => purgeOld(ctx));

  const stopJobs = startJobScheduler(ctx);
  const stopGithub = startGithubPoller(ctx);

  return () => {
    timers.forEach(clearInterval);
    stopJobs();
    stopGithub();
  };
}

/** Retention: raw events and job output older than N days (default 90). Sessions and messages stay. */
export function purgeOld(ctx: Ctx, now = Date.now()) {
  const days = ctx.db.getSetting<number>('retention_days', 90);
  const cutoff = now - days * 24 * 3600_000;
  // the timeline is built from tool_calls/messages plus these few event types, which are kept
  ctx.db.run("DELETE FROM events WHERE ts < ? AND event NOT IN ('UserPromptSubmit', 'Decision', 'Watcher', 'StopFailure', 'PreCompact', 'SessionStart', 'SessionEnd')", cutoff);
  ctx.db.run('DELETE FROM job_output WHERE ts < ?', cutoff);
  ctx.db.run('DELETE FROM otel_events WHERE ts < ?', cutoff);
}
