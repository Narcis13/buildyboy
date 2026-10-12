import webpush from 'web-push';
import { randomBytes } from 'node:crypto';
import type { Ctx, Notification } from '../context.ts';

interface Vapid {
  publicKey: string;
  privateKey: string;
}

/** VAPID keys are generated on first use and kept in the settings table (inside the data dir's DB). */
export function vapidKeys(ctx: Ctx): Vapid {
  let v = ctx.db.getSetting<Vapid | null>('vapid', null);
  if (!v) {
    v = webpush.generateVAPIDKeys();
    ctx.db.setSetting('vapid', v);
  }
  return v;
}

/** One-time tokens that let a notification's Allow/Deny buttons answer without a page (and without a cookie). */
const actionTokens = new Map<string, { actionId: string; exp: number }>();

export function takeActionToken(token: string): string | null {
  const t = actionTokens.get(token);
  actionTokens.delete(token);
  return t && t.exp > Date.now() ? t.actionId : null;
}

function inQuietHours(q: { start?: string; end?: string } | null, now = new Date()): boolean {
  if (!q?.start || !q?.end) return false;
  const mins = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = mins(q.start);
  const b = mins(q.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** Decides whether a notification should go out given the user's per-type, per-session and quiet-hours settings. */
export function shouldNotify(ctx: Ctx, n: Notification, now = new Date()): boolean {
  if (n.type === 'test') return true;
  const types = ctx.db.getSetting<Record<string, boolean>>('push_types', {});
  if (types[n.type] === false) return false;
  const muted = ctx.db.getSetting<string[]>('push_muted_sessions', []);
  if (n.sessionId && muted.includes(n.sessionId)) return false;
  return !inQuietHours(ctx.db.getSetting<{ start?: string; end?: string } | null>('quiet_hours', null), now);
}

export async function deliver(ctx: Ctx, n: Notification): Promise<{ push: number; ntfy: boolean }> {
  const base = ctx.config.publicUrl;
  const payload: Record<string, unknown> = { title: n.title, body: n.body, url: n.url ?? '/', sessionId: n.sessionId, actionId: n.actionId, type: n.type };
  if (n.actions && n.actionId) {
    const token = randomBytes(18).toString('base64url');
    const now = Date.now();
    for (const [k, v] of actionTokens) if (v.exp < now) actionTokens.delete(k);
    actionTokens.set(token, { actionId: n.actionId, exp: now + 15 * 60_000 });
    payload.actionToken = token;
  }
  let sent = 0;
  const subs = ctx.db.all<{ id: string; endpoint: string; keys_json: string }>('SELECT id, endpoint, keys_json FROM push_subscriptions');
  if (subs.length) {
    const v = vapidKeys(ctx);
    const subject = base.startsWith('https://') ? base : 'mailto:buildyboy@localhost';
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }, JSON.stringify(payload), {
            TTL: 3600,
            urgency: n.type === 'pending' ? 'high' : 'normal',
            timeout: 8000,
            vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey },
          });
          ctx.db.run('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?', Date.now(), s.id);
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) ctx.db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        }
      }),
    );
  }
  let ntfy = false;
  const topic = ctx.db.getSetting<string | null>('ntfy_url', null);
  if (topic && /^https?:\/\//.test(topic)) {
    try {
      const r = await fetch(topic, {
        method: 'POST',
        body: n.body,
        headers: { Title: n.title.replace(/[^\x20-\x7e]/g, ''), Click: `${base}${n.url ?? '/'}`, Tags: n.type === 'pending' ? 'warning' : 'robot', Priority: n.type === 'pending' ? 'high' : 'default' },
        signal: AbortSignal.timeout(8000),
      });
      ntfy = r.ok;
    } catch {
      // optional channel
    }
  }
  return { push: sent, ntfy };
}

/** Fan-out to Web Push and ntfy. Never throws and never blocks the caller. */
export function createNotifier(ctx: Ctx): (n: Notification) => void {
  return (n) => {
    ctx.bus.publish('notifications', n.type, n);
    if (!shouldNotify(ctx, n)) return;
    deliver(ctx, n).catch((e) => console.error('[push]', e));
  };
}
