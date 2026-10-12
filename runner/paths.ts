// Allowed-root enforcement. Runs on the runner, so the server can't widen it.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';

/** Comparison key: resolved (no trailing separator except at a drive root), lower case on Windows. */
export function pathKey(p: string): string {
  const r = resolve(p);
  return WIN ? r.toLowerCase() : r;
}

export function isInside(child: string, root: string): boolean {
  const c = pathKey(child);
  const r = pathKey(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

function realDir(p: string): string | null {
  try {
    const real = realpathSync.native(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export type CwdCheck = { ok: true; cwd: string; root: string } | { ok: false; reason: string };

/** The job's cwd must be an absolute existing directory whose real path (symlinks resolved) is inside a real allowed root. */
export function checkCwd(cwd: unknown, roots: string[]): CwdCheck {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return { ok: false, reason: 'cwd missing' };
  if (!isAbsolute(cwd)) return { ok: false, reason: `cwd must be an absolute path: ${cwd}` };
  if (cwd.split(/[\\/]+/).includes('..')) return { ok: false, reason: `cwd must not contain '..': ${cwd}` };
  if (WIN && /^\\\\[?.]\\/.test(cwd)) return { ok: false, reason: 'device paths are not allowed' };
  const real = realDir(cwd);
  if (!real) return { ok: false, reason: `cwd does not exist or is not a directory: ${cwd}` };
  for (const r of roots) {
    const rr = realDir(r);
    if (rr && isInside(real, rr)) return { ok: true, cwd: real, root: rr };
  }
  return { ok: false, reason: `cwd is outside the runner's allowed roots: ${cwd}` };
}

/** Nearest ancestor (up to the allowed root) holding `.git`; the unit for "one running job per repo". */
export function repoRoot(dir: string, allowedRoot: string): string {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    if (pathKey(d) === pathKey(allowedRoot)) return dir;
    const up = dirname(d);
    if (up === d) return dir;
    d = up;
  }
}
