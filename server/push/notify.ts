import type { Ctx, Notification } from '../context.ts';

/** Fan-out to Web Push and ntfy. Replaced with the full implementation in M3. */
export function createNotifier(ctx: Ctx): (n: Notification) => void {
  return (n) => {
    ctx.bus.publish('notifications', n.type, n);
  };
}
