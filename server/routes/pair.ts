import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { clientIp, rateLimited, redeemPairingCode } from '../auth.ts';

const pairSchema = z.object({
  code: z.string().min(4).max(32),
  name: z.string().max(80).optional(),
  hostname: z.string().max(200).optional(),
  platform: z.string().max(20).optional(),
  arch: z.string().max(20).optional(),
  user: z.string().max(100).optional(),
});

/** Public: exchanges a one-time pairing code for a machine token. */
export function pairRoute(ctx: Ctx) {
  const app = new Hono();
  app.post('/api/pair', async (c) => {
    if (rateLimited(`pair:${clientIp(c)}`, 20)) return c.json({ error: 'too many attempts' }, 429);
    const b = pairSchema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'code required' }, 400);
    const r = redeemPairingCode(ctx, b.data.code, b.data);
    if (!r) return c.json({ error: 'invalid or expired code' }, 403);
    ctx.db.audit('machine', 'paired', r.machineId, { hostname: b.data.hostname });
    ctx.bus.publish('machines', 'changed');
    return c.json({ machineId: r.machineId, token: r.token, url: ctx.config.publicUrl });
  });
  return app;
}
