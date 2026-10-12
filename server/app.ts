import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Ctx } from './context.ts';
import { machineRoutes } from './routes/machine.ts';
import { webRoutes } from './routes/web.ts';
import { pairRoute } from './routes/pair.ts';
import { extraRoutes } from './routes/index.ts';

export const SERVER_VERSION = '0.1.0';

export function createApp(ctx: Ctx) {
  const app = new Hono();

  app.onError((err, c) => {
    console.error('[http]', c.req.method, c.req.path, err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: SERVER_VERSION, time: Date.now() }));

  app.route('/', pairRoute(ctx));
  app.route('/', machineRoutes(ctx));
  app.route('/', webRoutes(ctx));
  for (const r of extraRoutes(ctx)) app.route('/', r);

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // PWA (web/dist), with SPA fallback to index.html
  const dist = process.env.BUILDYBOY_WEB_DIST ? resolve(process.env.BUILDYBOY_WEB_DIST) : join(ctx.config.rootDir, 'web', 'dist');
  const root = relative(process.cwd(), dist) || '.';
  app.use('/*', serveStatic({ root }));
  app.get('/*', (c) => {
    const index = join(dist, 'index.html');
    if (!existsSync(index)) return c.text('Buildyboy server is running. Build the web app with `npm run build`.', 200);
    return c.html(readFileSync(index, 'utf8'));
  });

  return app;
}
