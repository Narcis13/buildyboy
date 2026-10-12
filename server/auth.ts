import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Ctx } from './context.ts';

export const SESSION_COOKIE = 'bb_session';
export const CSRF_COOKIE = 'bb_csrf';
export const CSRF_HEADER = 'x-bb-csrf';
const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, got);
}

export function setPassword(ctx: Ctx, pw: string) {
  ctx.db.setSetting('password_hash', hashPassword(pw));
  ctx.db.run("DELETE FROM settings WHERE key = 'setup_token'");
}

export function hasPassword(ctx: Ctx): boolean {
  return !!ctx.db.getSetting<string | null>('password_hash', null);
}

/** One-time setup token printed to the log while no password exists. */
export function ensureSetupToken(ctx: Ctx): string | null {
  if (hasPassword(ctx)) return null;
  let t = ctx.db.getSetting<string | null>('setup_token', null);
  if (!t) {
    t = randomToken(18);
    ctx.db.setSetting('setup_token', t);
  }
  return t;
}

// ---- rate limiting (in memory, per key) ----
const attempts = new Map<string, number[]>();
function recent(key: string, windowMs: number): number[] {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  attempts.set(key, list);
  return list;
}

/** Counts this request and reports whether `key` made more than `max` requests in the window. */
export function rateLimited(key: string, max = 10, windowMs = 60_000): boolean {
  const list = recent(key, windowMs);
  list.push(Date.now());
  return list.length > max;
}

/** Login limiting counts failures only, so a successful login never locks anyone out. */
export function tooManyFailures(key: string, max = 10, windowMs = 60_000): boolean {
  return recent(`fail:${key}`, windowMs).length >= max;
}

export function noteFailure(key: string) {
  recent(`fail:${key}`, 60_000).push(Date.now());
}

export function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
}

function isHttps(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

export function createWebSession(ctx: Ctx, c: Context): void {
  const token = randomToken();
  const csrf = randomToken(18);
  const now = Date.now();
  ctx.db.run(
    'INSERT INTO web_sessions (id, token_hash, csrf, device, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), sha256(token), csrf, (c.req.header('user-agent') ?? '').slice(0, 200), clientIp(c), now, now, now + THIRTY_DAYS,
  );
  const secure = isHttps(c);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge: THIRTY_DAYS / 1000 });
  setCookie(c, CSRF_COOKIE, csrf, { httpOnly: false, secure, sameSite: 'Strict', path: '/', maxAge: THIRTY_DAYS / 1000 });
}

export function destroyWebSession(ctx: Ctx, c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) ctx.db.run('DELETE FROM web_sessions WHERE token_hash = ?', sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, CSRF_COOKIE, { path: '/' });
}

export interface WebUser {
  sessionId: string;
  csrf: string;
}

export function webUser(ctx: Ctx, c: Context): WebUser | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = ctx.db.get<{ id: string; csrf: string; expires_at: number; last_seen_at: number }>('SELECT id, csrf, expires_at, last_seen_at FROM web_sessions WHERE token_hash = ?', sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (Date.now() - row.last_seen_at > 60_000) ctx.db.run('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?', Date.now(), row.id);
  return { sessionId: row.id, csrf: row.csrf };
}

/** Cookie auth plus CSRF (double submit + SameSite=Strict) on state-changing requests. */
export function requireWeb(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    const u = webUser(ctx, c);
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const h = c.req.header(CSRF_HEADER);
      if (!h || h !== u.csrf) return c.json({ error: 'csrf' }, 403);
    }
    c.set('webUser' as never, u as never);
    await next();
  };
}

// ---- machine tokens ----

export function newMachineToken(): string {
  return `bbm_${randomToken(24)}`;
}

export function createMachine(ctx: Ctx, name: string, info: { hostname?: string; platform?: string; arch?: string; user?: string } = {}): { id: string; token: string } {
  const id = randomUUID();
  const token = newMachineToken();
  ctx.db.run(
    'INSERT INTO machines (id, name, hostname, platform, arch, user, token_hash, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, info.hostname ?? null, info.platform ?? null, info.arch ?? null, info.user ?? null, sha256(token), Date.now(),
  );
  return { id, token };
}

export function rotateMachineToken(ctx: Ctx, id: string): string {
  const token = newMachineToken();
  ctx.db.run('UPDATE machines SET token_hash = ?, revoked = 0 WHERE id = ?', sha256(token), id);
  return token;
}

export function machineFromToken(ctx: Ctx, auth: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(auth ?? '');
  if (!m) return null;
  const row = ctx.db.get<{ id: string; revoked: number }>('SELECT id, revoked FROM machines WHERE token_hash = ?', sha256(m[1]));
  return row && !row.revoked ? row.id : null;
}

export function requireMachine(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    const id = machineFromToken(ctx, c.req.header('authorization'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    c.set('machineId' as never, id as never);
    await next();
  };
}

export const PAIR_TTL_MS = 10 * 60 * 1000;

export function createPairingCode(ctx: Ctx, name?: string): { code: string; expiresAt: number } {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  const now = Date.now();
  ctx.db.run('INSERT INTO pairing_codes (code, name, created_at, expires_at) VALUES (?, ?, ?, ?)', code, name ?? null, now, now + PAIR_TTL_MS);
  return { code, expiresAt: now + PAIR_TTL_MS };
}

/** Exchanges a pairing code for a machine token. Codes are single use and expire after 10 minutes. */
export function redeemPairingCode(ctx: Ctx, code: string, info: { name?: string; hostname?: string; platform?: string; arch?: string; user?: string }): { machineId: string; token: string } | null {
  return ctx.db.tx(() => {
    const row = ctx.db.get<{ code: string; name: string | null; expires_at: number; used_at: number | null }>('SELECT * FROM pairing_codes WHERE code = ?', code.toUpperCase().trim());
    if (!row || row.used_at || row.expires_at < Date.now()) return null;
    const m = createMachine(ctx, info.name || row.name || info.hostname || 'machine', info);
    ctx.db.run('UPDATE pairing_codes SET used_at = ?, machine_id = ? WHERE code = ?', Date.now(), m.id, row.code);
    return { machineId: m.id, token: m.token };
  });
}
