import { Hono, type Context } from 'hono';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Ctx } from '../context.ts';

interface TarEntry {
  /** posix path inside the archive, no leading slash */
  name: string;
  /** absolute path on disk */
  abs: string;
  size: number;
  mtime: number;
  mode: number;
}

const SKIP = new Set(['node_modules', '.DS_Store', 'Thumbs.db']);

/** Lists `rel` (a file or a directory, relative to root) in a stable order. Directories come before their children. */
function collect(root: string, rel: string, out: TarEntry[], dirs: TarEntry[]) {
  const abs = join(root, rel);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  const name = rel.split(/[\\/]/).join('/');
  if (st.isDirectory()) {
    dirs.push({ name: `${name}/`, abs, size: 0, mtime: Math.floor(st.mtimeMs / 1000), mode: 0o755 });
    for (const child of readdirSync(abs).sort()) {
      if (SKIP.has(child)) continue;
      collect(root, posix.join(name, child), out, dirs);
    }
  } else if (st.isFile()) {
    // Windows reports 0o666/0o777 for everything: only keep the exec bit when it is meaningful.
    out.push({ name, abs, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mode: process.platform !== 'win32' && (st.mode & 0o111) !== 0 ? 0o755 : 0o644 });
  }
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Splits a path longer than 100 bytes into ustar prefix + name, or returns null. */
function splitName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (rest && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  return null;
}

function header(e: TarEntry, isDir: boolean): Buffer {
  const parts = splitName(e.name);
  if (!parts) throw new Error(`path too long for ustar: ${e.name}`);
  const h = Buffer.alloc(512);
  h.write(parts.name, 0, 100, 'utf8');
  h.write(octal(e.mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(isDir ? 0 : e.size, 12), 124, 12, 'ascii');
  h.write(octal(e.mtime, 12), 136, 12, 'ascii');
  h.fill(0x20, 148, 156); // checksum is computed with the field as spaces
  h.write(isDir ? '5' : '0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(parts.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** Minimal ustar writer + gzip, no dependencies. Directories first, then files. */
export function buildTarGz(dirs: TarEntry[], files: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const d of dirs) chunks.push(header(d, true));
  for (const f of files) {
    const data = readFileSync(f.abs);
    chunks.push(header({ ...f, size: data.length }, false), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** The tarball is a one-plugin marketplace: .claude-plugin/marketplace.json + plugin/... */
function pluginEntries(root: string): { dirs: TarEntry[]; files: TarEntry[] } {
  const dirs: TarEntry[] = [];
  const files: TarEntry[] = [];
  collect(root, '.claude-plugin', files, dirs);
  // marketplace.json only: the repo's .claude-plugin/ holds nothing else that belongs in the marketplace
  const keep = files.filter((f) => f.name === '.claude-plugin/marketplace.json');
  collect(root, 'plugin', keep, dirs);
  return { dirs, files: keep };
}

function withUrl(text: string, url: string): string {
  return text.split('__BB_URL__').join(url);
}

/** Public: client installers and the plugin tarball (no auth, no secrets inside). */
export function installRoutes(ctx: Ctx) {
  const app = new Hono();

  const script = (file: string, lf: boolean) => (c: Context) => {
    let text: string;
    try {
      text = readFileSync(join(ctx.config.rootDir, 'deploy', file), 'utf8');
    } catch {
      return c.text(`${file} is not available on this server\n`, 404);
    }
    if (lf) text = text.replace(/\r\n/g, '\n');
    return c.body(withUrl(text, ctx.config.publicUrl), 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
    });
  };
  app.get('/install.sh', script('install.sh', true));
  app.get('/install.ps1', script('install.ps1', false));

  let cache: { sig: string; body: Buffer } | null = null;
  app.get('/plugin.tgz', (c) => {
    const root = ctx.config.rootDir;
    let entries: ReturnType<typeof pluginEntries>;
    try {
      entries = pluginEntries(root);
    } catch (e) {
      return c.text(`cannot read the plugin: ${(e as Error).message}\n`, 500);
    }
    if (!entries.files.some((f) => f.name === '.claude-plugin/marketplace.json') || !entries.files.some((f) => f.name.startsWith('plugin/'))) {
      return c.text('plugin files are not available on this server\n', 404);
    }
    const sig = [...entries.dirs, ...entries.files].map((e) => `${e.name}:${e.size}:${e.mtime}`).join('|');
    if (!cache || cache.sig !== sig) cache = { sig, body: buildTarGz(entries.dirs, entries.files) };
    return c.body(new Uint8Array(cache.body), 200, {
      'content-type': 'application/gzip',
      'content-disposition': 'attachment; filename="buildyboy-plugin.tgz"',
      'cache-control': 'no-cache',
    });
  });

  return app;
}
