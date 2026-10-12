// Finds the real `claude` executable. Never goes through a shell: on Windows a `.cmd` shim is unwrapped
// to the script it launches, and anything we can't unwrap is refused.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

const WIN = process.platform === 'win32';

export interface Exe {
  command: string;
  /** arguments that go before claude's own (e.g. the script path when run through node) */
  prefix: string[];
}

function isFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!WIN) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name: string): string | null {
  const exts = WIN ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** npm's shim ends with `"%dp0%\node_modules\...\cli.js" %*` (or an .exe); run that target directly. */
function unwrapShim(file: string): Exe {
  const text = readFileSync(file, 'utf8');
  const dir = dirname(file);
  const m = [...text.matchAll(/"%~?dp0%?\\?([^"%]+\.(?:js|mjs|cjs|exe))"/gi)].pop();
  if (m) {
    const target = resolve(dir, m[1].replace(/\\/g, '/'));
    if (existsSync(target)) {
      if (/\.exe$/i.test(target)) return { command: target, prefix: [] };
      const localNode = join(dir, 'node.exe');
      return { command: existsSync(localNode) ? localNode : process.execPath, prefix: [target] };
    }
  }
  throw new Error(`cannot run ${file} safely without a shell; set "claudePath" in runner.json to claude.exe`);
}

function fromPath(p: string): Exe {
  const ext = extname(p).toLowerCase();
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') return { command: process.execPath, prefix: [p] };
  if (WIN && (ext === '.cmd' || ext === '.bat')) return unwrapShim(p);
  return { command: p, prefix: [] };
}

/** BUILDYBOY_CLAUDE_BIN (tests) > runner.json claudePath > `claude` on PATH. */
export function resolveClaude(claudePath?: string): Exe {
  const override = process.env.BUILDYBOY_CLAUDE_BIN;
  if (override) return fromPath(resolve(override));
  const want = claudePath || 'claude';
  if (isAbsolute(want)) {
    if (!isFile(want)) throw new Error(`claudePath not found: ${want}`);
    return fromPath(want);
  }
  const found = which(want);
  if (!found) throw new Error(`'${want}' not found on PATH; set "claudePath" in runner.json`);
  return fromPath(found);
}
