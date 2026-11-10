// Gate runner: executes one gate's steps from a JSON recipe kept in the repo's trusted main checkout, then reports
// back over HTTP. Steps are plain argv (no shell). The server never runs commands; this does (SPEC §10).
//
// Step contract (see arond/fabrica/porti/scripts): exit 0 = pass (or skip), 1 = fail, anything else = error. The last
// non-empty stdout line, if JSON, is {verdict, summary, details?, findings?, shots?}.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { FINDING_SEVERITIES, GATES, SHOT_MAX_BYTES, type FindingInput, type GateCommand, type GateRecipe, type GateReport, type RecipeStep, type Verdict } from '../shared/factory.ts';
import { HttpError, type Api } from './api.ts';
import { checkCwd, isInside } from './paths.ts';
import { killTree } from './proc.ts';

const WIN = process.platform === 'win32';
export type GateRun = GateCommand['run'];
type Vars = GateRun['vars'];

const DEFAULT_TIMEOUT_SEC = 1800;
const LOG_CAP = 512 * 1024;
const STDOUT_CAP = 2 * 1024 * 1024;
const TAIL_CAP = 64 * 1024;
const MAX_SHOTS = 12;
const MAX_FINDINGS = 200;
const RECIPE_MAX_BYTES = 1024 * 1024;
const SHOT_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface GateDeps {
  allowedRoots: string[];
  api: Pick<Api, 'post'>;
  log: (s: string) => void;
  signal?: AbortSignal;
  /** retry schedule for the final report (defaults: 1 s doubling to 30 s, ~10 minutes in all) */
  retry?: { initialMs: number; maxMs: number; totalMs: number };
}

/** Expands the placeholders of one step's argv. `{args}` as a whole element becomes the args list. */
export function expandArgv(argv: string[], vars: Partial<Vars>, args: string[], recipeDir: string): string[] {
  const values: Record<string, string> = {
    id: vars.id ?? '',
    idLower: vars.idLower ?? '',
    worktree: vars.worktree ?? '',
    round: vars.round ?? '',
    port: vars.port ?? '',
    db: vars.db ?? '',
    recipeDir,
  };
  const out: string[] = [];
  for (const el of argv) {
    if (el === '{args}') {
      out.push(...args);
      continue;
    }
    out.push(
      el.replace(/\{(id|idLower|worktree|round|port|db|recipeDir|args)\}/g, (m, k: string) => (k === 'args' ? args.join(' ') : Object.hasOwn(values, k) ? values[k] : m)),
    );
  }
  return out;
}

/** Keeps the last `cap` characters, remembering how much was dropped from the head. */
class Tail {
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

const lastLine = (s: string): string => {
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim();
  return '';
};

interface StepOutcome {
  kind: 'exit' | 'timeout' | 'aborted' | 'spawn-error';
  code: number | null;
  signal: string | null;
  message?: string;
  stdout: string;
  tail: string;
}

function runStep(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal | undefined, onData: (s: string) => void): Promise<StepOutcome> {
  return new Promise((done) => {
    const stdout = new Tail(STDOUT_CAP);
    const tail = new Tail(TAIL_CAP);
    let settled = false;
    let kind: StepOutcome['kind'] = 'exit';
    let forced: NodeJS.Timeout | null = null;
    const finish = (o: Partial<StepOutcome>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      signal?.removeEventListener('abort', onAbort);
      done({ kind, code: null, signal: null, stdout: stdout.text(), tail: tail.text(), ...o });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      kind = 'spawn-error';
      return finish({ message: (e as Error).message });
    }
    const stop = (why: 'timeout' | 'aborted') => {
      if (settled || kind !== 'exit') return;
      kind = why;
      killTree(child);
      forced = setTimeout(() => finish({}), 5000); // pipes held open by an orphaned grandchild must not hang the gate
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('aborted');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (s: string) => {
      stdout.add(s);
      tail.add(s);
      onData(s);
    });
    child.stderr!.on('data', (s: string) => {
      tail.add(s);
      onData(s);
    });
    child.on('error', (e) => {
      if (kind === 'exit') kind = 'spawn-error';
      finish({ message: e.message });
    });
    child.on('close', (code, sig) => finish({ code, signal: sig }));
  });
}

function parseStepJson(stdout: string): Record<string, unknown> | null {
  const line = lastLine(stdout);
  if (!line.startsWith('{')) return null;
  try {
    const j = JSON.parse(line);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

function cleanFindings(raw: unknown): FindingInput[] {
  if (!Array.isArray(raw)) return [];
  const out: FindingInput[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 500) : '';
    if (!title || !(FINDING_SEVERITIES as readonly string[]).includes(o.severity as string)) continue;
    const finding: FindingInput = { severity: o.severity as FindingInput['severity'], title };
    const file = str(o.file, 1000);
    if (file) finding.file = file;
    const line = typeof o.line === 'number' || (typeof o.line === 'string' && o.line.trim()) ? Math.trunc(Number(o.line)) : NaN;
    if (Number.isFinite(line) && line >= 0) finding.line = line;
    const detail = str(o.detail, 20_000);
    if (detail) finding.detail = detail;
    const fix = str(o.fix, 20_000);
    if (fix) finding.fix = fix;
    out.push(finding);
  }
  return out;
}

function collectShots(raw: unknown[], checkout: string, log: (s: string) => void): NonNullable<GateReport['shots']> {
  const shots: NonNullable<GateReport['shots']> = [];
  for (const s of raw) {
    if (shots.length >= MAX_SHOTS) break;
    const p = typeof s === 'string' ? s : s && typeof s === 'object' && typeof (s as { path?: unknown }).path === 'string' ? (s as { path: string }).path : null;
    if (!p) continue;
    const mime = SHOT_MIME[extname(p).toLowerCase()];
    if (!mime) continue;
    const abs = resolve(checkout, p);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > SHOT_MAX_BYTES) {
        log(`shot ${abs}: ${st.size} bytes is over the limit; skipped`);
        continue;
      }
      const given = typeof s === 'object' ? str((s as { name?: unknown }).name, 200) : undefined;
      shots.push({ name: given ?? basename(abs, extname(abs)), base64: readFileSync(abs).toString('base64'), mime });
    } catch {
      // missing or unreadable: skipped
    }
  }
  return shots;
}

function loadRecipe(file: string): GateRecipe {
  const st = statSync(file);
  if (!st.isFile() || st.size > RECIPE_MAX_BYTES) throw new Error('recipe is not a regular file under 1 MB');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!j || typeof j !== 'object' || !j.gates || typeof j.gates !== 'object') throw new Error('recipe has no "gates" object');
  return j as GateRecipe;
}

const validTimeout = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

async function sendFinal(run: GateRun, report: GateReport, deps: GateDeps) {
  const path = '/api/runner/gates/' + encodeURIComponent(run.id);
  const { initialMs, maxMs, totalMs } = deps.retry ?? { initialMs: 1000, maxMs: 30_000, totalMs: 10 * 60_000 };
  const end = Date.now() + totalMs;
  let wait = initialMs;
  for (;;) {
    try {
      await deps.api.post(path, report);
      return;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        deps.log(`gate ${run.id}: server rejected the report (${(e as Error).message}); giving up`);
        return;
      }
      if (deps.signal?.aborted || Date.now() + wait > end) {
        deps.log(`gate ${run.id}: report not delivered (${(e as Error).message}); giving up`);
        return;
      }
      deps.log(`gate ${run.id}: report failed (${(e as Error).message}); retrying in ${Math.round(wait / 1000)} s`);
      await sleep(wait, deps.signal);
      wait = Math.min(wait * 2, maxMs);
    }
  }
}

/** Runs the gate and reports: `running` first, then exactly one final `done` or `error`. Returns the final report. */
export async function runGate(run: GateRun, deps: GateDeps): Promise<GateReport> {
  const { log } = deps;
  const buf = new Tail(LOG_CAP);
  const logText = () => (buf.dropped ? `[… ${buf.dropped} bytes dropped …]\n` : '') + buf.text();
  let exitCode: number | null = null;
  const fail = (error: string, summary?: string): GateReport => ({ status: 'error', error, ...(summary ? { summary } : {}), exitCode, log: logText() });

  // `running` is a courtesy; a failure to deliver it never blocks the gate
  if (run && typeof run.id === 'string' && run.id) {
    await deps.api.post('/api/runner/gates/' + encodeURIComponent(run.id), { status: 'running' } satisfies GateReport).catch((e: Error) => log(`gate ${run.id}: running report failed: ${e.message}`));
  }

  const final = await (async (): Promise<GateReport> => {
    if (!run || typeof run.id !== 'string' || !run.id) return fail('gate command has no id');
    const where = checkCwd(run.checkout, deps.allowedRoots);
    if (!where.ok) return fail(where.reason);
    const checkout = where.cwd;
    if (!(GATES as readonly string[]).includes(run.gate)) return fail(`unknown gate ${String(run.gate)}`);
    if (typeof run.recipe !== 'string' || !run.recipe || run.recipe.includes('\0')) return fail('recipe path missing');
    const recipePath = resolve(checkout, run.recipe);
    if (!isInside(recipePath, checkout) || recipePath === checkout) return fail(`recipe is outside the checkout: ${run.recipe}`);
    let recipe: GateRecipe;
    let recipeDir: string;
    try {
      const real = realpathSync.native(recipePath);
      if (!isInside(real, checkout)) return fail(`recipe is outside the checkout: ${run.recipe}`);
      recipe = loadRecipe(real);
      recipeDir = dirname(real);
    } catch (e) {
      return fail(`cannot read recipe ${run.recipe}: ${(e as Error).message}`);
    }
    const gate = recipe.gates[run.gate];
    if (!gate) return fail(`recipe has no ${run.gate}`);
    const steps: RecipeStep[] = Array.isArray(gate.steps) ? gate.steps : [];
    if (!steps.length) return fail(`recipe ${run.gate} has no steps`);
    for (const [i, s] of steps.entries()) {
      if (!s || !Array.isArray(s.argv) || !s.argv.length || s.argv.some((a) => typeof a !== 'string') || !s.argv[0]) return fail(`recipe ${run.gate} step ${i + 1} has no argv`);
    }

    const v: Partial<Vars> = run.vars ?? {};
    const vars: Vars = { id: v.id ?? '', idLower: v.idLower ?? '', worktree: v.worktree ?? '', round: v.round || String(run.round ?? ''), port: v.port ?? '', db: v.db ?? '' };
    const args = Array.isArray(run.args) ? run.args.filter((a) => typeof a === 'string') : [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BB_TASK: run.taskId,
      BB_ROLE: 'poarta',
      BB_GATE: run.gate,
      BB_ROUND: vars.round,
      BB_PORT: vars.port,
      BB_DB: vars.db,
      BB_WORKTREE: vars.worktree,
    };

    const summaries: string[] = [];
    const details: { name: string; details: unknown }[] = [];
    const findings: FindingInput[] = [];
    const shotRefs: unknown[] = [];
    let allSkip = true;
    let failed = false;
    let lastTail = '';

    for (const [i, step] of steps.entries()) {
      const name = step.name?.trim() || `step ${i + 1}`;
      const argv = expandArgv(step.argv, vars, args, recipeDir);
      if (!argv[0]) return fail(`${name}: empty command after expanding placeholders`);
      if (WIN && /\.(cmd|bat)$/i.test(argv[0])) {
        return fail(`${name}: ${argv[0]} is a batch file, which cannot run without a shell; call it through cmd.exe explicitly in the recipe, e.g. ["cmd.exe", "/c", "${argv[0]}", …]`);
      }
      const timeoutSec = validTimeout(step.timeoutSec) ?? validTimeout(gate.timeoutSec) ?? validTimeout(recipe.timeoutSec) ?? DEFAULT_TIMEOUT_SEC;
      buf.add(`$ ${argv.join(' ')}\n`);
      log(`gate ${run.id} (${run.taskId} ${run.gate}): ${name}`);
      const o = await runStep(argv, checkout, env, timeoutSec * 1000, deps.signal, (s) => buf.add(s));
      if (buf.text() && !/\n$/.test(buf.text())) buf.add('\n');
      exitCode = o.code;
      lastTail = o.tail;
      const j = o.kind === 'exit' && o.code !== null ? parseStepJson(o.stdout) : null;
      const summary = str(j?.summary, 4000);
      if (o.kind === 'aborted') return fail('runner stopped while the gate was running');
      if (o.kind === 'timeout') return fail(`step ${name} timed out after ${timeoutSec}s`, summary);
      if (o.kind === 'spawn-error') return fail(`step ${name} could not start: ${o.message ?? 'spawn failed'}`);
      if (o.code === null) return fail(`step ${name} was killed by signal ${o.signal ?? '?'}`);
      if (o.code !== 0 && o.code !== 1) return fail(`step ${name} exited with code ${o.code}`, summary ?? (lastLine(o.tail).slice(0, 2000) || undefined));
      if (summary) summaries.push(summary);
      if (j) {
        findings.push(...cleanFindings(j.findings));
        if (Array.isArray(j.shots)) shotRefs.push(...j.shots);
        if (j.details !== undefined && j.details !== null) details.push({ name, details: j.details });
      }
      if (o.code === 1) {
        failed = true;
        allSkip = false;
        break;
      }
      if (j?.verdict !== 'skip') allSkip = false;
    }

    const verdict: Verdict = failed ? 'fail' : allSkip ? 'skip' : 'pass';
    const report: GateReport = {
      status: 'done',
      verdict,
      summary: summaries.length ? summaries.join(' · ') : lastLine(lastTail).slice(0, 2000),
      findings: findings.slice(0, MAX_FINDINGS),
      exitCode,
      log: logText(),
    };
    if (details.length === 1) report.details = details[0].details;
    else if (details.length > 1) report.details = { steps: details };
    const shots = collectShots(shotRefs, checkout, log);
    if (shots.length) report.shots = shots;
    return report;
  })().catch((e: Error) => fail(`gate crashed: ${e.message}`));

  if (final.status === 'error') log(`gate ${run?.id}: error: ${final.error}`);
  else log(`gate ${run.id}: ${final.verdict}`);

  if (run && typeof run.id === 'string' && run.id) await sendFinal(run, final, deps);
  return final;
}
