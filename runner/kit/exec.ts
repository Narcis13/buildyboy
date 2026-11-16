// Running things for the kit (SPEC §12.4): an argv without a shell (gate recipe steps, git, claude), a command line of
// the line file through the line's `shell` (or the platform shell), and the files the server sends, confined to
// `<worktree>/.factory/`. Output is kept as a bounded tail; a timeout or an abort kills the whole process tree.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { StepFile } from '../../shared/factory.ts';
import { shellKind, type ResolvedLine } from '../../shared/line.ts';
import { isInside } from '../paths.ts';
import { killTree } from '../proc.ts';

const WIN = process.platform === 'win32';

/** Keeps the last `cap` characters, remembering how much was dropped from the head. */
export class Tail {
  private s = '';
  dropped = 0;
  private cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  add(chunk: string) {
    this.s += chunk;
    if (this.s.length > this.cap * 2) this.trim();
  }
  private trim() {
    if (this.s.length > this.cap) {
      this.dropped += this.s.length - this.cap;
      this.s = this.s.slice(this.s.length - this.cap);
    }
  }
  text(): string {
    this.trim();
    return this.s;
  }
}

export interface Outcome {
  kind: 'exit' | 'timeout' | 'aborted' | 'spawn-error';
  code: number | null;
  signal: string | null;
  message?: string;
  stdout: string;
  stderr: string;
}

export interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onData?: (s: string) => void;
  /** written to stdin, then closed */
  input?: string | Buffer;
  /** Windows: pass the arguments as they are (cmd.exe /s /c "…") */
  verbatim?: boolean;
  stdoutCap?: number;
}

/** Runs an argv without a shell. Never rejects: a spawn failure, a timeout or an abort is an outcome. */
export function spawnCapture(argv: string[], o: SpawnOpts): Promise<Outcome> {
  return new Promise((done) => {
    const stdout = new Tail(o.stdoutCap ?? 2 * 1024 * 1024);
    const stderr = new Tail(256 * 1024);
    let settled = false;
    let kind: Outcome['kind'] = 'exit';
    let forced: NodeJS.Timeout | null = null;
    const finish = (r: Partial<Outcome>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      o.signal?.removeEventListener('abort', onAbort);
      done({ kind, code: null, signal: null, stdout: stdout.text(), stderr: stderr.text(), ...r });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: o.cwd, env: o.env, shell: false, windowsHide: true, detached: !WIN, windowsVerbatimArguments: !!o.verbatim, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      settled = true; // the timer below does not exist yet: answer directly
      return done({ kind: 'spawn-error', code: null, signal: null, message: (e as Error).message, stdout: '', stderr: '' });
    }
    const stop = (why: 'timeout' | 'aborted') => {
      if (settled || kind !== 'exit') return;
      kind = why;
      killTree(child);
      forced = setTimeout(() => finish({}), 5000); // pipes held open by an orphaned grandchild must not hang the step
    };
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs);
    const onAbort = () => stop('aborted');
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort);
    }
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (s: string) => {
      stdout.add(s);
      o.onData?.(s);
    });
    child.stderr!.on('data', (s: string) => {
      stderr.add(s);
      o.onData?.(s);
    });
    if (o.input !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.input);
    }
    child.on('error', (e) => {
      if (kind === 'exit') kind = 'spawn-error';
      finish({ message: e.message });
    });
    child.on('close', (code, sig) => finish({ code, signal: sig }));
  });
}

/** The environment of everything the runner starts: no runner token, not nested in a Claude Code session. */
export function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.BUILDYBOY_TOKEN;
  return env;
}

/** The argv that runs one command line of the line: its `shell` prefix, else cmd.exe /d /s /c on Windows, /bin/sh -c elsewhere. */
export function shellArgv(line: Pick<ResolvedLine, 'shell'>, command: string, platform = process.platform): { argv: string[]; verbatim: boolean } {
  if (line.shell?.length) return { argv: [...line.shell, command], verbatim: false };
  if (platform === 'win32') return { argv: [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `"${command}"`], verbatim: true };
  return { argv: ['/bin/sh', '-c', command], verbatim: false };
}

export { shellKind };

/** A command line of the line, through its shell. */
export function runCommandLine(line: Pick<ResolvedLine, 'shell'>, command: string, o: SpawnOpts): Promise<Outcome> {
  const { argv, verbatim } = shellArgv(line, command);
  return spawnCapture(argv, { ...o, verbatim });
}

/** git without a prompt; `ok` is exit 0. */
export async function git(args: string[], cwd: string, o: { timeoutMs?: number; input?: string | Buffer; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}) {
  const r = await spawnCapture(['git', ...args], {
    cwd, env: { ...(o.env ?? baseEnv()), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }, timeoutMs: o.timeoutMs ?? 10 * 60_000, signal: o.signal, input: o.input,
  });
  return { ok: r.kind === 'exit' && r.code === 0, code: r.code, out: r.stdout.trim(), err: (r.stderr || r.message || '').trim(), kind: r.kind };
}

/** An error that ends the step without a verdict (no round used). */
export class KitError extends Error {}

/** git that must succeed; otherwise a KitError with git's message. */
export async function gitOk(args: string[], cwd: string, o: Parameters<typeof git>[2] = {}): Promise<string> {
  const r = await git(args, cwd, o);
  if (!r.ok) throw new KitError(`git ${args.join(' ')} failed${r.kind !== 'exit' ? ` (${r.kind})` : ''}: ${(r.err || r.out).split(/\r?\n/).slice(0, 4).join(' ').slice(0, 600)}`);
  return r.out;
}

const FILE_RE = /^[\w.-]+(?:\/[\w.-]+)*$/;
const MAX_FILE = 1024 * 1024;

/** A path the server sent, relative to `.factory/` (a leading `.factory/` is accepted); null when it would escape it. */
export function factoryPath(worktree: string, p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const rel = p.replace(/\\/g, '/').replace(/^\.factory\//, '');
  if (!FILE_RE.test(rel) || rel.split('/').some((s) => s === '.' || s === '..' || /^\.+$/.test(s))) return null;
  const root = join(worktree, '.factory');
  const abs = resolve(root, rel);
  return isInside(abs, root) && abs !== resolve(root) ? abs : null;
}

/** Writes the server's files under `<worktree>/.factory/`; refuses the whole set when one path escapes it. */
export function writeFactoryFiles(worktree: string, files: StepFile[] | undefined): string[] {
  if (!files?.length) return [];
  if (!Array.isArray(files) || files.length > 50) throw new KitError('files: at most 50');
  const out: { abs: string; content: string }[] = [];
  for (const f of files) {
    const abs = factoryPath(worktree, f?.path);
    if (!abs) throw new KitError(`file ${JSON.stringify(f?.path)}: only paths under .factory/ (letters, digits, . _ -), never outside it`);
    if (typeof f.content !== 'string' || Buffer.byteLength(f.content) > MAX_FILE) throw new KitError(`file ${f.path}: text of at most 1 MB`);
    out.push({ abs, content: f.content });
  }
  for (const f of out) {
    mkdirSync(dirname(f.abs), { recursive: true });
    writeFileSync(f.abs, f.content);
  }
  return out.map((f) => f.abs);
}

/** Strips ANSI colours. */
export const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The summary of a test command (as arond's g1.sh): its last result lines and, when it failed, its first error lines. */
export function testSummary(output: string, failed: boolean): string {
  const lines = plain(output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let results = lines.filter((l) => /Tests? +\d|\d+ (passed|failed|flaky|skipped)|\bpass(ed)?\b.*\d|\d+ tests?\b/i.test(l)).slice(-4);
  if (!results.length) results = lines.slice(-3);
  const parts = [results.join('; ')];
  if (failed) {
    const errs = lines.filter((l) => /error|fail/i.test(l)).slice(0, 5).map((l) => l.slice(0, 200));
    if (errs.length) parts.push(`First errors: ${errs.join('; ')}`);
  }
  return parts.filter(Boolean).join('. ').slice(0, 3000);
}
