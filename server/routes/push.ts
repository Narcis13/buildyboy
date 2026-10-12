import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { requireWeb, clientIp, rateLimited } from '../auth.ts';
import { deliver, takeActionToken, vapidKeys } from '../push/notify.ts';
import { answerPending, getPending } from '../control/pending.ts';

const subSchema = z.object({
  subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  deviceName: z.string().max(100).optional(),
});

export function pushRoutes(ctx: Ctx) {
  const app = new Hono();
  const auth = requireWeb(ctx);

  app.get('/api/push/vapid', auth, (c) => c.json({ publicKey: vapidKeys(ctx).publicKey }));

  app.get('/api/push/subscriptions', auth, (c) =>
    c.json(ctx.db.all('SELECT id, device_name AS deviceName, created_at AS createdAt, last_ok_at AS lastOkAt FROM push_subscriptions ORDER BY created_at DESC')),
  );

  app.post('/api/push/subscribe', auth, async (c) => {
    const b = subSchema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid subscription' }, 400);
    const { endpoint, keys } = b.data.subscription;
    ctx.db.run(
      'INSERT INTO push_subscriptions (id, device_name, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json, device_name = excluded.device_name',
      randomUUID(), b.data.deviceName ?? (c.req.header('user-agent') ?? '').slice(0, 100), endpoint, JSON.stringify(keys), Date.now(),
    );
    ctx.db.audit('web', 'push_subscribe', null, { deviceName: b.data.deviceName });
    return c.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', auth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.endpoint === 'string') ctx.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', body.endpoint);
    if (typeof body?.id === 'string') ctx.db.run('DELETE FROM push_subscriptions WHERE id = ?', body.id);
    ctx.db.audit('web', 'push_unsubscribe');
    return c.json({ ok: true });
  });

  app.post('/api/push/test', auth, async (c) => {
    const r = await deliver(ctx, { type: 'test', title: 'Buildyboy test notification', body: 'If you can read this, notifications work.', url: '/settings' });
    ctx.db.audit('web', 'push_test', null, r);
    return c.json({ ok: true, ...r });
  });

  /** Public: Allow/Deny pressed on a notification. The one-time token is the credential. */
  app.post('/api/push/act', async (c) => {
    if (rateLimited(`push:${clientIp(c)}`, 30)) return c.json({ error: 'too many requests' }, 429);
    const body = await c.req.json().catch(() => ({}));
    const actionId = typeof body?.token === 'string' ? takeActionToken(body.token) : null;
    if (!actionId) return c.json({ error: 'invalid or expired token' }, 403);
    const p = getPending(ctx, actionId);
    if (!p || p.status !== 'pending') return c.json({ error: 'already handled' }, 409);
    const answer = body.decision === 'allow' ? { type: 'allow' } : { type: 'deny', message: 'Denied from a notification' };
    answerPending(ctx, actionId, answer, 'push');
    ctx.db.audit('push', 'answer', actionId, answer);
    return c.json({ ok: true });
  });

  return app;
}
