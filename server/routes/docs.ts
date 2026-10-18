import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { DOCS_DIR, createDocs } from '../docs/engine.ts';

const TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** The user manual. Public on purpose: it holds no data, and it is what you read before your first login. */
export function docsRoutes(ctx: Ctx) {
  const app = new Hono();
  const docs = createDocs();
  const assetsDir = join(DOCS_DIR, 'assets');
  const site = () => ({ url: ctx.config.publicUrl });
  const builtin: Record<string, string> = { 'faqir.css': docs.css, 'faqir-core.js': docs.coreJs };

  // Asset URLs carry a hash of the assets (see the layout); an old hash is still served, just not cached.
  app.get('/docs/assets/:version/:file{.+}', (c) => {
    const file = c.req.param('file');
    const type = TYPES[file.split('.').pop() ?? ''];
    if (!type || file.split('/').some((seg) => seg === '..' || seg === '') || file.includes('\\')) return c.text('not found', 404);
    const fresh = ctx.config.production && c.req.param('version') === docs.assetVersion;
    const headers = { 'content-type': type, 'cache-control': fresh ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (builtin[file] !== undefined) return c.body(builtin[file], 200, headers);
    try {
      return c.body(new Uint8Array(readFileSync(join(assetsDir, file))), 200, headers);
    } catch {
      return c.text('not found', 404);
    }
  });

  const send = (html: string | null) =>
    new Response(html ?? docs.notFound(site()), {
      status: html ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-robots-tag': 'noindex' },
    });

  app.get('/docs', () => send(docs.page('index', site())));
  app.get('/docs/', (c) => c.redirect('/docs', 301));
  app.get('/docs/:slug', (c) => {
    const slug = c.req.param('slug');
    return send(slug === 'index' ? null : docs.page(slug, site()));
  });
  app.get('/docs/*', () => send(null));

  return app;
}
