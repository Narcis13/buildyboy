import type { Ctx } from '../context.ts';

/** Job queue dispatch + cron schedules. Implemented in M7. Returns a stop function. */
export function startJobScheduler(_ctx: Ctx): () => void {
  return () => {};
}
