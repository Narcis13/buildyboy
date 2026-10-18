// The user manual at /docs, rendered on the server with @faqir-ui/template and styled by an @faqir-ui/core theme.
// Templates are compiled once (a template error fails loudly at startup, not on a reader's request) and rendered
// per request, so commands in the manual can show this server's own URL.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { compile } from '@faqir-ui/template/compile';
import { render, type Template } from '@faqir-ui/template';
import { components } from '@faqir-ui/template/registry';
import { createFileLoader } from '@faqir-ui/template/node';
import { PAGES, SECTIONS, docHref, type DocPage } from './catalog.ts';

/** templates/ and assets/ live next to this file: they are part of the code, not of a deployment's data. */
export const DOCS_DIR = import.meta.dirname;

/** The @faqir-ui/core theme the manual is drawn in (dist/faqir.<theme>.css). */
export const DOCS_THEME = 'slate';

export interface DocsSite {
  /** this server's public URL, without a trailing slash */
  url: string;
}

export interface Docs {
  /** the page as HTML, or null for an unknown slug */
  page(slug: string, site: DocsSite): string | null;
  notFound(site: DocsSite): string;
  /** the theme bundle cut down to the tokens, base and the components the manual uses */
  css: string;
  coreJs: string;
  /** a hash of every asset, so asset URLs change exactly when an asset does */
  assetVersion: string;
}

const require = createRequire(import.meta.url);

function coreFile(name: string): string {
  return readFileSync(require.resolve(`@faqir-ui/core/dist/${name}`), 'utf8');
}

function compileOrThrow(file: string, loader: (name: string) => string | null): Template {
  const source = loader(file);
  if (source == null) throw new Error(`docs: template not found: ${file}`);
  const { ast, diagnostics } = compile(source, { file, loader, components });
  if (!ast) throw new Error(`docs: ${diagnostics.map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`).join('\n')}`);
  return ast;
}

/**
 * The template language puts every node on its own line, so an inline element followed by punctuation renders
 * as "<code>x</code> ," with a visible space. Glue punctuation back onto the element on either side.
 */
const INLINE = '(?:a|b|code|em|i|kbd|mark|small|span|strong)';
const AFTER = new RegExp(`(</${INLINE}>)\\n[ ]*(?=[.,;:!?)\\]’”…])`, 'g');
const BEFORE = new RegExp(`([(\\[“‘])\\n[ ]*(?=<${INLINE}[ >])`, 'g');
export function glueInline(html: string): string {
  return html.replace(AFTER, '$1').replace(BEFORE, '$1');
}

/** Keeps the bundle's tokens, theme and base sections, plus the sections of the components in `used`. */
export function subsetCss(bundle: string, used: Set<string>): string {
  const parts = bundle.split(/(?=^\/\* === [^\n]+ === \*\/$)/m);
  return parts
    .filter((part) => {
      const m = /^\/\* === (?:primitives|recipes|patterns)\/([a-z0-9-]+)\.css === \*\//.exec(part);
      return !m || used.has(m[1]);
    })
    .join('');
}

type SiteData = DocsSite & { assets: string; host: string };

function pageData(page: DocPage, site: SiteData) {
  const i = PAGES.indexOf(page);
  const link = (p: DocPage | undefined) => (p ? { title: p.title, href: docHref(p.slug) } : null);
  const section = SECTIONS.find((s) => s.pages.includes(page))!;
  return {
    site,
    page: { slug: page.slug, title: page.title, summary: page.summary, section: section.title, home: page.slug === 'index' },
    nav: SECTIONS.map((s) => ({
      title: s.title,
      pages: s.pages.map((p) => ({ title: p.title, href: docHref(p.slug), current: p.slug === page.slug })),
    })),
    // the manual's home lists every other page as a card
    sections: SECTIONS.map((s) => ({
      title: s.title,
      id: s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      pages: s.pages.filter((p) => p.slug !== 'index').map((p) => ({ title: p.title, summary: p.summary, href: docHref(p.slug) })),
    })),
    prev: link(PAGES[i - 1]),
    next: link(PAGES[i + 1]),
  };
}

function notFoundData(site: SiteData) {
  return { ...pageData(PAGES[0], site), page: { slug: '', title: 'Page not found', summary: 'There is no manual page at this address.', section: '', home: false }, prev: null, next: null };
}

export function createDocs(docsDir = DOCS_DIR): Docs {
  const loader = createFileLoader(join(docsDir, 'templates'));
  const compiled = new Map(PAGES.map((p) => [p.slug, compileOrThrow(`pages/${p.slug}.faqir`, loader)]));
  const missing = compileOrThrow('pages/not-found.faqir', loader);
  const draw = (ast: Template, data: Record<string, unknown>) => glueInline(render(ast, data, { idPrefix: 'doc' }));

  // Render every page once with placeholder data to learn which components the manual draws.
  const probe: SiteData = { url: 'https://buildyboy.example', host: 'buildyboy.example', assets: '/docs/assets/0' };
  const used = new Set<string>();
  for (const html of [...PAGES.map((p) => draw(compiled.get(p.slug)!, pageData(p, probe))), draw(missing, notFoundData(probe))]) {
    for (const m of html.matchAll(/data-ui="([a-z0-9-]+)"/g)) used.add(m[1]);
  }
  const css = subsetCss(coreFile(`faqir.${DOCS_THEME}.css`), used);
  const coreJs = coreFile('faqir-core.min.js');

  const hash = createHash('sha256').update(css).update(coreJs);
  for (const f of readdirSync(join(docsDir, 'assets'), { recursive: true, withFileTypes: true }).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    if (f.isFile()) hash.update(f.name).update(readFileSync(join(f.parentPath, f.name)));
  }
  const assetVersion = hash.digest('hex').slice(0, 12);
  const withAssets = (site: DocsSite): SiteData => ({ ...site, host: new URL(site.url).host, assets: `/docs/assets/${assetVersion}` });

  return {
    page(slug, site) {
      const page = PAGES.find((p) => p.slug === slug);
      return page ? draw(compiled.get(slug)!, pageData(page, withAssets(site))) : null;
    },
    notFound: (site) => draw(missing, notFoundData(withAssets(site))),
    css,
    coreJs,
    assetVersion,
  };
}
