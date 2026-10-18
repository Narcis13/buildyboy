import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_DIR, createDocs, glueInline, subsetCss } from '../server/docs/engine.ts';
import { PAGES, docHref } from '../server/docs/catalog.ts';
import { startTestServer, type TestServer } from './helpers.ts';

const SITE = { url: 'https://bb.example.test' };
const docs = createDocs();
const html = new Map(PAGES.map((p) => [p.slug, docs.page(p.slug, SITE)!]));

// Every element the manual may use. A prose line written without its leading `|` parses as an element named after
// its first word ("Open the app" → <Open>), so anything outside this list is almost certainly a missing pipe.
const TAGS = new Set(
  ('a article aside body br button code dd details div dl dt em figcaption figure footer h1 h2 h3 h4 head header html img kbd ' +
    'li link main meta nav ol p pre script section small span strong summary table tbody td th thead time title tr ul')
    .split(' '),
);

describe('the manual', () => {
  it('renders every page in the catalog', () => {
    for (const p of PAGES) {
      const page = html.get(p.slug)!;
      expect(page, p.slug).toContain(`<title>${p.title.replace(/&/g, '&amp;')} · Buildyboy manual</title>`);
      expect(page.length, p.slug).toBeGreaterThan(3000);
    }
  });

  it('uses only known HTML elements (no prose line lost its pipe)', () => {
    for (const [slug, page] of html) {
      const unknown = [...page.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)[\s>]/g)].map((m) => m[1]).filter((t) => !TAGS.has(t));
      expect(unknown, slug).toEqual([]);
    }
  });

  it('never puts a space before punctuation', () => {
    for (const [slug, page] of html) {
      const prose = page.replace(/<pre>[\s\S]*?<\/pre>/g, '');
      expect(prose.match(/.*\n[ ]+[,.;:!?)].*/g) ?? [], slug).toEqual([]);
    }
  });

  it('links only to pages and anchors that exist', () => {
    const ids = new Map([...html].map(([slug, page]) => [docHref(slug), new Set([...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
    for (const [slug, page] of html) {
      for (const [, href] of page.matchAll(/ href="(\/docs[^"]*)"/g)) {
        if (href.startsWith('/docs/assets/')) continue;
        const [path, hash] = href.split('#');
        expect(ids.has(path), `${slug} → ${href}`).toBe(true);
        if (hash) expect(ids.get(path)!.has(hash), `${slug} → ${href}`).toBe(true);
      }
    }
  });

  it('shows images that exist, each with alt text', () => {
    for (const [slug, page] of html) {
      for (const [tag] of page.matchAll(/<img [^>]*>/g)) {
        expect(tag, slug).toMatch(/ alt="/);
        const src = /src="\/docs\/assets\/[0-9a-f]+\/([^"]+)"/.exec(tag);
        if (src) expect(existsSync(join(DOCS_DIR, 'assets', src[1])), `${slug}: ${src[1]}`).toBe(true);
      }
    }
  });

  it('writes this server\'s address into commands', () => {
    expect(html.get('quick-start')).toContain('curl -fsSL https://bb.example.test/install.sh');
  });

  it('glues punctuation onto inline elements', () => {
    expect(glueInline('<p>\n  Run\n  <code>npm ci</code>\n  , then go (\n  <code>x</code>\n  ).\n</p>')).toBe('<p>\n  Run\n  <code>npm ci</code>, then go (<code>x</code>).\n</p>');
  });

  it('keeps the tokens and base of the theme bundle, and only the components in use', () => {
    const bundle = '/* head */\n/* === tokens/a.css === */\n:root{}\n/* === base/reset.css === */\nbody{}\n/* === primitives/card.css === */\n[data-ui="card"]{}\n/* === recipes/tabs.css === */\n[data-ui="tabs"]{}\n';
    const out = subsetCss(bundle, new Set(['card']));
    expect(out).toContain(':root{}');
    expect(out).toContain('body{}');
    expect(out).toContain('[data-ui="card"]');
    expect(out).not.toContain('tabs');
  });
});

describe('the /docs routes', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer({ publicUrl: 'https://bb.example.test' });
  });
  afterAll(async () => {
    await srv.stop();
  });

  it('serves the manual without logging in', async () => {
    const res = await fetch(`${srv.url}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<h1>Welcome</h1>');
    expect((await fetch(`${srv.url}/docs/quick-start`)).status).toBe(200);
  });

  it('answers an unknown page with a 404 manual page', async () => {
    const res = await fetch(`${srv.url}/docs/no-such-page`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
  });

  it('serves the theme, the engine and its own assets', async () => {
    const page = await (await fetch(`${srv.url}/docs`)).text();
    const assets = /href="(\/docs\/assets\/[0-9a-f]+)\/faqir.css"/.exec(page)![1];
    for (const [file, type] of [['faqir.css', 'text/css'], ['docs.css', 'text/css'], ['docs.js', 'text/javascript'], ['faqir-core.js', 'text/javascript'], ['img/floor-desktop.png', 'image/png']]) {
      const res = await fetch(`${srv.url}${assets}/${file}`);
      expect(res.status, file).toBe(200);
      expect(res.headers.get('content-type'), file).toContain(type);
    }
    expect((await fetch(`${srv.url}${assets}/../app.ts`)).status).not.toBe(200);
    expect((await fetch(`${srv.url}${assets}/nope.css`)).status).toBe(404);
  });
});
