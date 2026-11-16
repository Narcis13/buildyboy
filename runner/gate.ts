// Gate and step runner (SPEC §11.7, §12.4): runs one gate or kit step of a package from the line file kept in the repo's
// trusted main checkout, then reports back over HTTP. The server never runs commands; this does (SPEC §10).
//
// For each run the line file is read from the checkout (never a worktree) and, in this order: the line's argv `steps`
// for that gate or step run (plain argv, no shell, in the checkout: the §11.7 contract, unchanged); else the built-in of
// runner/kit; else an error. A §11.7 recipe (argv steps, no `commands`) runs exactly as before: argv steps only.
//
// Step contract (see arond/fabrica/porti/scripts): exit 0 = pass (or skip), 1 = fail, anything else = error. The last
// non-empty stdout line, if JSON, is {verdict, summary, details?, findings?, shots?}.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import {
  FINDING_SEVERITIES, SHOT_MAX_BYTES, STEP_NAMES, isGate, type FindingInput, type Gate, type GateCommand, type GateReport, type RecipeStep, type StepName, type StepPackage,
  type TaskVars, type Verdict,
} from '../shared/factory.ts';
import { argvStepsOf, fill, isLegacyLine, lineEnv, lineVars, resolveLine, stepPlan, type ResolvedLine } from '../shared/line.ts';
import { HttpError, type Api } from './api.ts';
import { resolveClaude } from './claude.ts';
import { resolveHc } from './herdr.ts';
import { baseEnv, KitError, spawnCapture, Tail, writeFactoryFiles, type Outcome } from './kit/exec.ts';
import { BUILT_INS, type Kit, type StepResult } from './kit/steps.ts';
import { checkCwd, isInside } from './paths.ts';

const WIN = process.platform === 'win32';
export type GateRun = GateCommand['run'];
type Vars = GateRun['vars'];

const DEFAULT_TIMEOUT_SEC = 1800;
/** the verifiers' steps get longer by default */
const LONG_TIMEOUT_SEC = 3600;
const LOG_CAP = 512 * 1024;
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
  /** runner.json's claudePath (claude is resolved as runner/claude.ts does) */
  claudePath?: string;
  /** runner.json's hcPath */
  hcPath?: string;
}

/** Expands the placeholders of one step's argv (§12.2's, plus {recipeDir}). `{args}` as a whole element becomes the args list. */
export function expandArgv(argv: string[], vars: Partial<TaskVars>, args: string[], recipeDir: string): string[] {
  const values: Partial<TaskVars> = { id: '', idLower: '', worktree: '', round: '', port: '', db: '', localId: '', localIdLower: '', project: '', branch: '', ...vars };
  const out: string[] = [];
  for (const el of argv) {
    if (el === '{args}') {
      out.push(...args);
      continue;
    }
    out.push(fill(el, values).replace(/\{(recipeDir|args)\}/g, (_m, k: string) => (k === 'args' ? args.join(' ') : recipeDir)));
  }
  return out;
}

const lastLine = (s: string): string => {
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim();
  return '';
};

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

/** Screenshot files named by the step, read only inside the runner's allowed roots. */
function collectShots(raw: unknown[], checkout: string, roots: string[], log: (s: string) => void): NonNullable<GateReport['shots']> {
  const shots: NonNullable<GateReport['shots']> = [];
  for (const s of raw) {
    if (shots.length >= MAX_SHOTS) break;
    const p = typeof s === 'string' ? s : s && typeof s === 'object' && typeof (s as { path?: unknown }).path === 'string' ? (s as { path: string }).path : null;
    if (!p) continue;
    const mime = SHOT_MIME[extname(p).toLowerCase()];
    if (!mime) continue;
    const abs = resolve(checkout, p);
    if (!roots.some((r) => isInside(abs, r))) {
      log(`shot ${abs}: outside the allowed roots; skipped`);
      continue;
    }
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

/** The line file as JSON: a regular file under 1 MB holding an object. */
function loadRaw(file: string): Record<string, unknown> {
  const st = statSync(file);
  if (!st.isFile() || st.size > RECIPE_MAX_BYTES) throw new Error('recipe is not a regular file under 1 MB');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('the line file must hold a JSON object');
  return j as Record<string, unknown>;
}

/** The project's line file, read from the trusted checkout (inside the allowed roots) and resolved: `{type: 'line'}`. */
export function readLine(checkout: unknown, lineFile: unknown, roots: string[]): { ok: true; line: ResolvedLine; warnings: string[] } | { ok: false; error: string } {
  const where = checkCwd(checkout, roots);
  if (!where.ok) return { ok: false, error: where.reason };
  if (typeof lineFile !== 'string' || !lineFile || lineFile.includes('\0')) return { ok: false, error: 'line file path missing' };
  const abs = resolve(where.cwd, lineFile);
  if (!isInside(abs, where.cwd) || abs === where.cwd) return { ok: false, error: `the line file is outside the checkout: ${lineFile}` };
  try {
    const real = realpathSync.native(abs);
    if (!isInside(real, where.cwd)) return { ok: false, error: `the line file is outside the checkout: ${lineFile}` };
    const r = resolveLine(loadRaw(real), { checkoutDir: where.cwd, file: lineFile });
    return r.ok ? r : { ok: false, error: `${lineFile}: ${r.errors.join('; ')}`.slice(0, 4000) };
  } catch (e) {
    return { ok: false, error: `cannot read ${lineFile}: ${(e as Error).message}` };
  }
}

const validTimeout = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

async function sendFinal(run: GateRun, report: GateReport, deps: GateDeps) {
  const path = '/api/runner/gates/' + encodeURIComponent(run.id);
  const { initialMs, maxMs, totalMs } = deps.retry ?? { initialMs: 1000, maxMs: 30_000, totalMs: 24 * 3600_000 };
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

type ArgvOutcome =
  | { error: string; summary?: string; exitCode: number | null }
  | { verdict: Verdict; summary: string; details?: unknown; findings: FindingInput[]; shotRefs: unknown[]; exitCode: number | null };

interface ArgvOpts { cwd: string; env: NodeJS.ProcessEnv; vars: Partial<TaskVars>; args: string[]; recipeDir: string; timeouts: unknown[]; buf: Tail; log: (s: string) => void; signal?: AbortSignal }

/** The §11.7 contract: argv steps in order, no shell, in the checkout; the first failing step stops the run. */
async function runArgvSteps(name: string, steps: RecipeStep[], o: ArgvOpts): Promise<ArgvOutcome> {
  for (const [i, s] of steps.entries()) {
    if (!s || !Array.isArray(s.argv) || !s.argv.length || s.argv.some((a) => typeof a !== 'string') || !s.argv[0]) return { error: `recipe ${name} step ${i + 1} has no argv`, exitCode: null };
  }
  const summaries: string[] = [];
  const details: { name: string; details: unknown }[] = [];
  const findings: FindingInput[] = [];
  const shotRefs: unknown[] = [];
  let allSkip = true;
  let failed = false;
  let exitCode: number | null = null;
  for (const [i, step] of steps.entries()) {
    const label = step.name?.trim() || `step ${i + 1}`;
    const argv = expandArgv(step.argv, o.vars, o.args, o.recipeDir);
    if (!argv[0]) return { error: `${label}: empty command after expanding placeholders`, exitCode };
    if (WIN && /\.(cmd|bat)$/i.test(argv[0])) {
      return { error: `${label}: ${argv[0]} is a batch file, which cannot run without a shell; call it through cmd.exe explicitly in the recipe, e.g. ["cmd.exe", "/c", "${argv[0]}", …]`, exitCode };
    }
    const timeoutSec = validTimeout(step.timeoutSec) ?? o.timeouts.map(validTimeout).find((t) => t !== undefined) ?? DEFAULT_TIMEOUT_SEC;
    o.buf.add(`$ ${argv.join(' ')}\n`);
    o.log(label);
    const r: Outcome = await spawnCapture(argv, { cwd: o.cwd, env: o.env, timeoutMs: timeoutSec * 1000, signal: o.signal, onData: (s) => o.buf.add(s) });
    if (o.buf.text() && !/\n$/.test(o.buf.text())) o.buf.add('\n');
    exitCode = r.code;
    const j = r.kind === 'exit' && r.code !== null ? parseStepJson(r.stdout) : null;
    const summary = str(j?.summary, 4000);
    if (r.kind === 'aborted') return { error: 'runner stopped while the gate was running', exitCode };
    if (r.kind === 'timeout') return { error: `step ${label} timed out after ${timeoutSec}s`, summary, exitCode };
    if (r.kind === 'spawn-error') return { error: `step ${label} could not start: ${r.message ?? 'spawn failed'}`, exitCode };
    if (r.code === null) return { error: `step ${label} was killed by signal ${r.signal ?? '?'}`, exitCode };
    if (r.code !== 0 && r.code !== 1) return { error: `step ${label} exited with code ${r.code}`, summary, exitCode };
    if (summary) summaries.push(summary);
    if (j) {
      findings.push(...cleanFindings(j.findings));
      if (Array.isArray(j.shots)) shotRefs.push(...j.shots);
      if (j.details !== undefined && j.details !== null) details.push({ name: label, details: j.details });
    }
    if (r.code === 1) {
      failed = true;
      allSkip = false;
      break;
    }
    if (j?.verdict !== 'skip') allSkip = false;
  }
  const verdict: Verdict = failed ? 'fail' : allSkip ? 'skip' : 'pass';
  return {
    verdict,
    summary: summaries.length ? summaries.join(' · ') : `${name} ${verdict}: no summary from the recipe (exit ${exitCode}); see the log`,
    details: details.length === 1 ? details[0].details : details.length > 1 ? { steps: details } : undefined,
    findings,
    shotRefs,
    exitCode,
  };
}

/** The package of a command; today's command shape (no `task`) gives an id only. */
function packageOf(run: GateRun): StepPackage {
  const t = run.task;
  const id = typeof t?.id === 'string' && t.id ? t.id : String(run.vars?.id || run.taskId);
  return {
    id,
    localId: typeof t?.localId === 'string' && t.localId ? t.localId : String(run.vars?.localId || id),
    title: typeof t?.title === 'string' ? t.title.slice(0, 500) : '',
    body: typeof t?.body === 'string' ? t.body.slice(0, 200_000) : '',
    acceptance: Array.isArray(t?.acceptance) ? t.acceptance.filter((c): c is string => typeof c === 'string').slice(0, 200) : [],
    sensitive: t?.sensitive === true,
    branch: typeof t?.branch === 'string' ? t.branch : null,
  };
}

const realOr = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A step's timeout: its own, the line's, else the default (1 h for the verifiers' steps). */
export function timeoutOf(line: ResolvedLine, s: StepName): number {
  const own = isGate(s) ? line.gates[s].timeoutSec : line.steps[s].timeoutSec;
  return validTimeout(own) ?? validTimeout(line.timeoutSec) ?? (s === 'qa' || s === 'G3' || s === 'G4' ? LONG_TIMEOUT_SEC : DEFAULT_TIMEOUT_SEC);
}

/** Everything a built-in needs, from validated values only; the worktree must be inside the allowed roots. */
function makeKit(run: GateRun, line: ResolvedLine, checkout: string, args: string[], deps: GateDeps, buf: Tail): Kit {
  const pkg = packageOf(run);
  if (pkg.id !== run.taskId) throw new KitError(`the package ${pkg.id} is not the run's ${run.taskId}`);
  const res = run.resources ?? null;
  const input = { id: pkg.id, localId: pkg.localId, project: run.project ?? run.vars?.project ?? '', round: run.round, port: res?.port ?? run.vars?.port ?? '', db: res?.db ?? run.vars?.db ?? '' };
  let v: TaskVars;
  try {
    v = lineVars(line, input, '');
  } catch (e) {
    throw new KitError((e as Error).message);
  }
  const worktree = resolve(checkout, fill(line.worktree, v));
  if (!deps.allowedRoots.some((r) => isInside(worktree, resolve(r)) || isInside(worktree, realOr(r)))) throw new KitError(`the worktree ${worktree} is outside the runner's allowed roots`);
  if (isInside(checkout, worktree) || isInside(worktree, checkout)) throw new KitError(`the worktree ${worktree} must not be the checkout, nor inside it`);
  const vars: TaskVars = { ...v, worktree };
  const env = baseEnv({
    ...lineEnv(line, vars), BB_TASK: run.taskId, BB_ROLE: 'poarta', BB_GATE: run.gate, BB_ROUND: vars.round, BB_PORT: vars.port, BB_DB: vars.db, BB_WORKTREE: worktree,
    BB_LOCAL_ID: vars.localId, BB_PROJECT: vars.project, BB_BRANCH: vars.branch,
  });
  const kit: Kit = {
    run, line, checkout, worktree, branch: vars.branch, base: line.base, vars, pkg, args, env, roots: deps.allowedRoots, timeoutMs: DEFAULT_TIMEOUT_SEC * 1000, signal: deps.signal,
    log: (s) => buf.add(s), claude: () => resolveClaude(deps.claudePath), hc: () => resolveHc(deps.hcPath),
    sub: (g) => runPlanned(kit, g),
  };
  return kit;

  /** runs a gate or step as the line says (argv steps, else the built-in); a KitError is an error */
  async function runPlanned(k: Kit, s: StepName): Promise<StepResult & { shots?: unknown[] }> {
    const p = stepPlan(k.line, s);
    if (p.kind === 'off') return { verdict: 'skip', summary: `${s} skip: ${p.reason}` };
    const scoped: Kit = { ...k, timeoutMs: timeoutOf(k.line, s) * 1000, env: { ...k.env, BB_GATE: s }, sub: (g: StepName) => runPlanned(scoped, g) };
    // the server's files go under .factory/ before the step runs (prepare writes them once the worktree exists)
    if (k.run.files?.length && s !== 'prepare') {
      if (!isDir(k.worktree)) throw new KitError(`cannot write files: the worktree ${k.worktree} does not exist`);
      writeFactoryFiles(k.worktree, k.run.files);
    }
    if (p.kind === 'builtin') return BUILT_INS[s](scoped);
    const holder = isGate(s) ? k.line.gates[s] : k.line.steps[s];
    const o = await runArgvSteps(s, argvStepsOf(k.line, s)!, {
      cwd: k.checkout, env: scoped.env, vars: k.vars, args: k.args, recipeDir: dirname(resolve(k.checkout, k.line.file)), timeouts: [holder.timeoutSec, k.line.timeoutSec], buf,
      log: (x) => deps.log(`gate ${run.id} (${run.taskId} ${s}): ${x}`), signal: deps.signal,
    });
    if ('error' in o) throw new KitError(o.error);
    return { verdict: o.verdict, summary: o.summary, details: o.details as Record<string, unknown> | undefined, findings: o.findings, shots: o.shotRefs };
  }
}

/** Runs the gate or step and reports: `running` first, then exactly one final `done` or `error`. Returns the final report. */
export async function runGate(run: GateRun, deps: GateDeps): Promise<GateReport> {
  const { log } = deps;
  const buf = new Tail(LOG_CAP);
  const logText = () => (buf.dropped ? `[… ${buf.dropped} bytes dropped …]\n` : '') + buf.text();
  let exitCode: number | null = null;
  let lineInfo: Pick<GateReport, 'line' | 'lineError'> = {};
  const fail = (error: string, summary?: string): GateReport => ({ status: 'error', error, ...(summary ? { summary } : {}), exitCode, log: logText(), ...lineInfo });
  const done = (r: { verdict: Verdict; summary: string; details?: unknown; findings: FindingInput[]; shotRefs: unknown[] }, checkout: string): GateReport => {
    const report: GateReport = { status: 'done', verdict: r.verdict, summary: r.summary.slice(0, 20_000), findings: cleanFindings(r.findings).slice(0, MAX_FINDINGS), exitCode, log: logText(), ...lineInfo };
    if (r.details !== undefined) report.details = r.details;
    const shots = collectShots(r.shotRefs, checkout, deps.allowedRoots, log);
    if (shots.length) report.shots = shots;
    return report;
  };

  // `running` is a courtesy; a failure to deliver it never blocks the gate
  if (run && typeof run.id === 'string' && run.id) {
    await deps.api.post('/api/runner/gates/' + encodeURIComponent(run.id), { status: 'running' } satisfies GateReport).catch((e: Error) => log(`gate ${run.id}: running report failed: ${e.message}`));
  }

  const final = await (async (): Promise<GateReport> => {
    if (!run || typeof run.id !== 'string' || !run.id) return fail('gate command has no id');
    const where = checkCwd(run.checkout, deps.allowedRoots);
    if (!where.ok) return fail(where.reason);
    const checkout = where.cwd;
    if (!(STEP_NAMES as readonly string[]).includes(run.gate)) return fail(`unknown gate ${String(run.gate)}`);
    const step = run.gate as StepName;
    if (typeof run.recipe !== 'string' || !run.recipe || run.recipe.includes('\0')) return fail('recipe path missing');
    const recipePath = resolve(checkout, run.recipe);
    if (!isInside(recipePath, checkout) || recipePath === checkout) return fail(`recipe is outside the checkout: ${run.recipe}`);
    let raw: Record<string, unknown>;
    let recipeDir: string;
    try {
      const real = realpathSync.native(recipePath);
      if (!isInside(real, checkout)) return fail(`recipe is outside the checkout: ${run.recipe}`);
      raw = loadRaw(real);
      recipeDir = dirname(real);
    } catch (e) {
      return fail(`cannot read recipe ${run.recipe}: ${(e as Error).message}`);
    }
    const args = Array.isArray(run.args) ? run.args.filter((a) => typeof a === 'string') : [];

    // ---- a §11.7 recipe: exactly as before ----
    if (isLegacyLine(raw)) {
      if (!isGate(step)) return fail(`the line file ${run.recipe} is a §11.7 recipe without "commands": the kit's ${step} is off (add "commands" to use it)`);
      const recipe = raw as { timeoutSec?: unknown; gates: Partial<Record<Gate, { steps?: unknown; timeoutSec?: unknown }>> };
      const gate = recipe.gates[step];
      if (!gate) return fail(`recipe has no ${step}`);
      const steps = Array.isArray(gate.steps) ? (gate.steps as RecipeStep[]) : [];
      if (!steps.length) return fail(`recipe ${step} has no steps`);
      const v: Partial<Vars> = run.vars ?? {};
      const vars: Partial<TaskVars> = { ...v, id: v.id ?? '', idLower: v.idLower ?? '', worktree: v.worktree ?? '', round: v.round || String(run.round ?? ''), port: v.port ?? '', db: v.db ?? '' };
      const env: NodeJS.ProcessEnv = {
        ...process.env, BB_TASK: run.taskId, BB_ROLE: 'poarta', BB_GATE: step, BB_ROUND: vars.round, BB_PORT: vars.port, BB_DB: vars.db, BB_WORKTREE: vars.worktree,
      };
      const o = await runArgvSteps(step, steps, {
        cwd: checkout, env, vars, args, recipeDir, timeouts: [gate.timeoutSec, recipe.timeoutSec], buf, log: (s) => log(`gate ${run.id} (${run.taskId} ${step}): ${s}`), signal: deps.signal,
      });
      exitCode = o.exitCode;
      if ('error' in o) return fail(o.error, o.summary);
      return done(o, checkout);
    }

    // ---- a line (§12.3): argv steps, else the built-in ----
    const res = resolveLine(raw, { checkoutDir: checkout, file: run.recipe });
    if (!res.ok) {
      const lineError = `${run.recipe}: ${res.errors.join('; ')}`.slice(0, 4000);
      if (step === 'prepare') lineInfo = { lineError };
      return fail(`the line file is invalid: ${lineError}`);
    }
    if (step === 'prepare') lineInfo = { line: res.line };
    try {
      const kit = makeKit(run, res.line, checkout, args, deps, buf);
      log(`gate ${run.id} (${run.taskId} ${step}): ${stepPlan(res.line, step).kind}`);
      const r = await kit.sub(step);
      return done({ verdict: r.verdict, summary: r.summary || `${step} ${r.verdict}`, details: r.details, findings: r.findings ?? [], shotRefs: r.shots ?? [] }, checkout);
    } catch (e) {
      if (e instanceof KitError) return fail(e.message);
      throw e;
    }
  })().catch((e: Error) => fail(`gate crashed: ${e.message}`));

  if (final.status === 'error') log(`gate ${run?.id}: error: ${final.error}`);
  else log(`gate ${run.id}: ${final.verdict}`);

  if (run && typeof run.id === 'string' && run.id) await sendFinal(run, final, deps);
  return final;
}
