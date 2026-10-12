import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB } from './db.ts';
import { Bus } from './bus.ts';
import { createApp } from './app.ts';
import type { Ctx, ServerConfig } from './context.ts';
import { ensureSetupToken, hasPassword, setPassword } from './auth.ts';
import { startBackground } from './background.ts';
import { createNotifier } from './push/notify.ts';
import { expireOrphans } from './control/pending.ts';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function configFromEnv(over: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const port = Number(env.BUILDYBOY_PORT ?? env.PORT ?? 7700);
  const host = env.BUILDYBOY_HOST ?? '127.0.0.1';
  return {
    port,
    host,
    dataDir: resolve(env.BUILDYBOY_DATA ?? join(ROOT_DIR, 'data')),
    publicUrl: (env.BUILDYBOY_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/$/, ''),
    rootDir: ROOT_DIR,
    permissionWaitMs: Number(env.BUILDYBOY_PERMISSION_WAIT_MS ?? 9.5 * 60_000),
    stopWaitMin: Number(env.BUILDYBOY_STOP_WAIT_MIN ?? 5),
    pauseWaitMs: Number(env.BUILDYBOY_PAUSE_WAIT_MS ?? 9.5 * 60_000),
    production: env.NODE_ENV === 'production',
    ...over,
  };
}

export function createContext(config: ServerConfig, dbPath = join(config.dataDir, 'buildyboy.db')): Ctx {
  const ctx: Ctx = {
    db: new DB(dbPath),
    bus: new Bus(),
    config,
    notify: () => {},
    waiters: new Map(),
    pauseWaiters: new Map(),
    runners: new Map(),
  };
  ctx.notify = createNotifier(ctx);
  return ctx;
}

export interface RunningServer {
  ctx: Ctx;
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Starts the server. Port 0 picks a free port (tests). */
export async function startServer(over: Partial<ServerConfig> = {}, opts: { dbPath?: string; background?: boolean; quiet?: boolean } = {}): Promise<RunningServer> {
  const config = configFromEnv(over);
  const ctx = createContext(config, opts.dbPath);
  // a restart drops every long-poll: requests still marked pending have no hook waiting anymore
  expireOrphans(ctx, true);
  const initial = process.env.BUILDYBOY_INITIAL_PASSWORD;
  if (initial && !hasPassword(ctx)) setPassword(ctx, initial);
  const app = createApp(ctx);
  const stopBg = opts.background === false ? () => {} : startBackground(ctx);
  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => res(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${config.host}:${port}`;
  if (over.publicUrl === undefined && !process.env.BUILDYBOY_PUBLIC_URL) config.publicUrl = url;
  if (!opts.quiet) {
    console.log(`[buildyboy] listening on ${url} (data: ${config.dataDir})`);
    const token = ensureSetupToken(ctx);
    if (token) console.log(`[buildyboy] no password set. Open ${config.publicUrl}/setup?token=${token} (or run: bb set-password)`);
  }
  return {
    ctx,
    url,
    port,
    close: () =>
      new Promise<void>((res) => {
        stopBg();
        for (const w of ctx.waiters.values()) w(null);
        server.close(() => {
          ctx.db.close();
          res();
        });
        // SSE and long-poll connections would keep close() waiting
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  const stop = async () => {
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
