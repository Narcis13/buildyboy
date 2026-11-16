// The line file, `factory.json` (SPEC §12.3): one zod schema for the runner, the server and `bb line check`. Everything is
// optional; `{"commands": {"verify": "npm test"}}` is a working line. §11.7's gate recipe (`{timeoutSec, gates: {G1:
// {steps: [...]}}}`) is a valid line too: a file with argv `steps` and no `commands` is a *legacy* line, which runs
// exactly as before (only its argv steps; a gate without steps is "recipe has no G<n>"), so a migrated project keeps its
// gates until it adds `commands` (§12.10).
//
// Placeholders (§12.2) are filled from validated values only: ids `[\w.-]`, numbers, the project key and paths the
// runner computed. In a command line a value that is not plain is quoted for the line's shell.
import { z } from 'zod';
import { GATES, KIT_STEPS, TASK_VAR_NAMES, type Gate, type KitStep, type StepName, type TaskVars } from './factory.ts';

export const LINE_FILE_DEFAULT = 'factory.json';
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
const ID_RE = /^[\w.-]{1,64}$/;
const PROJECT_RE = /^[a-z][a-z0-9-]{1,23}$/;
const PH_RE = new RegExp(`\\{(${TASK_VAR_NAMES.join('|')})\\}`, 'g');

/** A git branch name we accept: no leading dash or slash, no `..`, `//`, `@{`, `.lock` or trailing dot/slash. */
export function validRef(s: string): boolean {
  return /^[\w][\w./-]{0,199}$/.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('.lock') && !/[./]$/.test(s);
}

const unknownPlaceholders = (s: string) => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).filter((n) => !(TASK_VAR_NAMES as readonly string[]).includes(n));
const SAMPLE: TaskVars = { id: 'P1', idLower: 'p1', localId: 'P1', localIdLower: 'p1', project: 'demo', round: '1', port: '4000', db: 'db_p1', worktree: '/wt/P1', branch: 'pkg/P1' };

/** A path inside the repo: relative, no `..`; placeholders allowed. */
const relPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((p) => !/^([a-zA-Z]:|[\\/~])/.test(p) && !p.split(/[\\/]+/).includes('..') && !/[\0\r\n]/.test(p), 'a path relative to the repo, without ".."')
  .refine((p) => !unknownPlaceholders(p).length, `only the placeholders ${TASK_VAR_NAMES.map((n) => `{${n}}`).join(' ')}`);
const commandLine = z.string().trim().min(1).max(8000).refine((s) => !/[\0\r\n]/.test(s), 'one line');
const timeout = z.number().positive().max(7 * 24 * 3600);
const argvStep = z.strictObject({ name: z.string().max(200).optional(), argv: z.array(z.string().max(8000)).min(1).max(200), timeoutSec: timeout.optional() });
const gateCommon = { enabled: z.boolean().optional(), timeoutSec: timeout.optional(), steps: z.array(argvStep).min(1).max(50).optional() };
const stepCommon = z.strictObject({ timeoutSec: timeout.optional(), steps: z.array(argvStep).min(1).max(50).optional() });
const model = z.string().trim().regex(/^\w[\w.:[\]-]{0,99}$/, 'a model name');

export const lineSchema = z.strictObject({
  base: z.string().trim().refine(validRef, 'a branch name').default('main'),
  branch: z
    .string()
    .trim()
    .refine((s) => !unknownPlaceholders(s).length && /\{(id|idLower|localId|localIdLower)\}/.test(s), 'a template with {id} (or {idLower}, {localId}, {localIdLower})')
    .refine((s) => validRef(fill(s, SAMPLE)), 'a branch name once filled')
    .default('pkg/{id}'),
  /** default `../<checkout folder>-wt/{id}`, filled in by resolveLine */
  worktree: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((s) => !unknownPlaceholders(s).length && /\{(id|idLower|localId|localIdLower)\}/.test(s), 'a path template with {id} (or {idLower}, {localId}, {localIdLower})')
    .optional(),
  shell: z.array(z.string().min(1).max(1000)).min(1).max(10).optional(),
  commands: z
    .strictObject({
      setup: commandLine.optional(), verify: commandLine.optional(), acceptance: commandLine.optional(), shots: commandLine.optional(), app: commandLine.optional(), cleanup: commandLine.optional(),
    })
    .prefault({}),
  app: z
    .strictObject({
      url: z.string().trim().regex(/^https?:\/\/[^\s]+$/, 'an http(s) URL').refine((s) => !unknownPlaceholders(s).length, 'only §12.2 placeholders').optional(),
      readyPath: z.string().trim().regex(/^\/[^\s]*$/, 'a path starting with /').default('/'),
      readyTimeoutSec: timeout.default(180),
    })
    .prefault({}),
  paths: z
    .strictObject({
      packages: relPath.default('factory/packages'),
      acceptance: relPath.default('tests/acceptance/{localId}'),
      shots: relPath.default('test-results/shots/{localId}'),
      protected: z.array(relPath).max(100).default([]),
    })
    .prefault({}),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, 'an environment variable name'), z.string().max(4000).refine((v) => !/[\0\r\n]/.test(v), 'one line')).default({}),
  envFile: relPath.default('.env.factory'),
  resources: z
    .strictObject({
      ports: z.tuple([z.number().int().min(1).max(65535), z.number().int().min(1).max(65535)]).refine(([a, b]) => a <= b, 'ports: [from, to] with from <= to').optional(),
      dbPrefix: z.string().trim().max(60).regex(/^[\w-]*$/, 'letters, digits, _ and - only').default(''),
      migrations: z.strictObject({ from: z.number().int().min(0).max(1_000_000), block: z.number().int().min(1).max(1000).default(10) }).optional(),
    })
    .optional(),
  gates: z
    .strictObject({
      G1: z.strictObject(gateCommon).prefault({}),
      G2: z.strictObject({ ...gateCommon, qa: z.boolean().default(true) }).prefault({}),
      G3: z.strictObject({ ...gateCommon, security: z.enum(['sensitive', 'always', 'never']).default('sensitive') }).prefault({}),
      G4: z.strictObject({ ...gateCommon, chrome: z.boolean().default(false) }).prefault({}),
      G5: z.strictObject({ ...gateCommon, push: z.boolean().default(true) }).prefault({}),
    })
    .prefault({}),
  steps: z.strictObject({ prepare: stepCommon.prefault({}), qa: stepCommon.prefault({}), cleanup: stepCommon.prefault({}), revert: stepCommon.prefault({}) }).prefault({}),
  models: z
    .strictObject({
      worker: model.default('opus'), qa: model.default('opus'), review: model.default('opus'), visual: model.default('sonnet'), foreman: model.nullable().default('opus'), planner: model.default('opus'),
    })
    .prefault({}),
  worker: z
    .strictObject({
      launcher: z.enum(['hc', 'claude']).default('hc'),
      permissionMode: z.enum(PERMISSION_MODES).default('auto'),
      limitHours: z.number().positive().max(24 * 14).default(10),
      subagents: z.number().int().min(0).max(20).default(4),
      chrome: z.boolean().default(false),
    })
    .prefault({}),
  limits: z.strictObject({ workers: z.number().int().min(1).max(20).default(2), rounds: z.number().int().min(1).max(50).optional() }).prefault({}),
  integrate: z.strictObject({ approval: z.enum(['never', 'sensitive', 'always']).default('sensitive') }).prefault({}),
  context: z.array(relPath).max(50).default(['CLAUDE.md']),
  /** §11.7: the default timeout of every argv step */
  timeoutSec: timeout.optional(),
});
export type LineFile = z.output<typeof lineSchema>;

export interface ResolvedLine extends Omit<LineFile, 'worktree'> {
  /** the line file, relative to the checkout */
  file: string;
  /** a §11.7 recipe: argv steps only, no built-ins (§12.10) */
  legacy: boolean;
  /** the worktree template, relative to the checkout or absolute (default `../<checkout folder>-wt/{id}`) */
  worktree: string;
  /** which gates run (§12.3) */
  enabled: Record<Gate, boolean>;
  /** QA runs before the build: G2 is on and G2.qa */
  qa: boolean;
}

export type LineResult = { ok: true; line: ResolvedLine; warnings: string[] } | { ok: false; errors: string[] };

/** A §11.7 recipe: some gate has argv steps and the file has no `commands`. */
export function isLegacyLine(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (o.commands !== undefined) return false;
  const gates = o.gates as Record<string, { steps?: unknown }> | undefined;
  return !!gates && typeof gates === 'object' && Object.values(gates).some((g) => g && typeof g === 'object' && Array.isArray(g.steps));
}

const folderOf = (dir: string) => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo';

/** Validates a parsed factory.json and resolves its defaults. `checkoutDir` names the default worktree folder. */
export function resolveLine(raw: unknown, o: { checkoutDir: string; file?: string }): LineResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the line file must hold a JSON object'] };
  // "$schema", "$comment" and "//…" keys are comments
  const clean = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => !k.startsWith('$') && !k.startsWith('//')));
  const p = lineSchema.safeParse(clean);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const l = p.data;
  const legacy = isLegacyLine(clean);
  const errors: string[] = [];
  const warnings: string[] = [];
  const c = l.commands;
  const has = (g: Gate) => !!l.gates[g].steps;
  const on = (g: Gate, auto: boolean) => (l.gates[g].enabled === false ? false : legacy ? has(g) : l.gates[g].enabled === true || auto || has(g));
  const enabled: Record<Gate, boolean> = { G1: on('G1', !!c.verify), G2: on('G2', !!c.acceptance), G3: on('G3', true), G4: on('G4', !!c.shots), G5: on('G5', true) };
  if (!legacy) {
    if (l.gates.G1.enabled && !c.verify && !has('G1')) errors.push('gates.G1: enabled, but there is no commands.verify and no steps');
    if (l.gates.G2.enabled && !c.acceptance && !has('G2')) errors.push('gates.G2: enabled, but there is no commands.acceptance and no steps');
    if (l.gates.G4.enabled && !c.shots && !has('G4')) errors.push('gates.G4: enabled, but there is no commands.shots and no steps');
    if (c.app && !l.app.url && !l.resources?.ports) warnings.push('commands.app: no app.url and no resources.ports, so the visual judge gets http://localhost:{port} without a port');
    if (enabled.G2 && !/\{(id|idLower|localId|localIdLower)\}/.test(l.paths.acceptance)) warnings.push('paths.acceptance has no {localId}: every package shares one acceptance folder');
  } else if (Object.keys(clean).some((k) => !['gates', 'timeoutSec'].includes(k))) {
    warnings.push('a §11.7 recipe (argv steps, no "commands"): only its argv steps run; add "commands" to use the kit');
  }
  if (errors.length) return { ok: false, errors };
  const line: ResolvedLine = {
    ...l,
    file: (o.file ?? LINE_FILE_DEFAULT).replace(/\\/g, '/'),
    legacy,
    worktree: l.worktree ?? `../${folderOf(o.checkoutDir)}-wt/{id}`,
    enabled,
    qa: enabled.G2 && l.gates.G2.qa,
  };
  return { ok: true, line, warnings };
}

/** The gates that run, in order. */
export const enabledGates = (line: Pick<ResolvedLine, 'enabled'>): Gate[] => GATES.filter((g) => line.enabled[g]);

/** The line's argv steps for a gate or kit step, if it has any (they win over the built-in, §12.4). */
export function argvStepsOf(line: Pick<ResolvedLine, 'gates' | 'steps'>, step: StepName): { name?: string; argv: string[]; timeoutSec?: number }[] | null {
  const s = (GATES as readonly string[]).includes(step) ? line.gates[step as Gate].steps : line.steps[step as KitStep]?.steps;
  return s?.length ? s : null;
}

/** How a run of `step` executes on this line: argv steps, the built-in, or nothing (with the reason). */
export function stepPlan(line: ResolvedLine, step: StepName): { kind: 'argv' } | { kind: 'builtin' } | { kind: 'off'; reason: string } {
  if (argvStepsOf(line, step)) return { kind: 'argv' };
  if (line.legacy) return { kind: 'off', reason: (GATES as readonly string[]).includes(step) ? `recipe has no ${step}` : `the line is a §11.7 recipe without "commands": the kit's ${step} is off` };
  if ((GATES as readonly string[]).includes(step) && !line.enabled[step as Gate]) return { kind: 'off', reason: `${step} is off in the line` };
  if (step === 'qa' && !line.qa) return { kind: 'off', reason: 'QA is off in the line (G2 is off, or gates.G2.qa is false)' };
  return (KIT_STEPS as readonly string[]).includes(step) || (GATES as readonly string[]).includes(step) ? { kind: 'builtin' } : { kind: 'off', reason: `unknown step ${step}` };
}

// ---------- placeholders (§12.2) ----------

export interface VarInput {
  id: string;
  localId?: string;
  project?: string;
  round?: number | string;
  port?: number | string | null;
  db?: string | null;
}

/**
 * The placeholder values of a package, validated (ids `[\w.-]`, a project key, whole numbers, a db name `[\w-]`); the
 * worktree is the absolute path the runner computed, the branch the line's template filled. Throws on a bad value.
 */
export function lineVars(line: Pick<ResolvedLine, 'branch'>, v: VarInput, worktree: string): TaskVars {
  const bad = (what: string, x: unknown) => new Error(`invalid ${what}: ${JSON.stringify(x)}`);
  if (!ID_RE.test(v.id)) throw bad('package id', v.id);
  const local = v.localId || v.id;
  if (!ID_RE.test(local)) throw bad('local id', local);
  if (v.project && !PROJECT_RE.test(v.project)) throw bad('project key', v.project);
  const round = String(v.round ?? 1);
  if (!/^\d{1,4}$/.test(round)) throw bad('round', v.round);
  const port = v.port == null || v.port === '' ? '' : String(v.port);
  if (port && (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535)) throw bad('port', v.port);
  const db = v.db ?? '';
  if (db && !/^[\w-]{1,100}$/.test(db)) throw bad('database name', db);
  const base = { id: v.id, idLower: v.id.toLowerCase(), localId: local, localIdLower: local.toLowerCase(), project: v.project ?? '', round, port, db, worktree };
  const branch = fill(line.branch, { ...base, branch: '' });
  if (!validRef(branch)) throw bad('branch', branch);
  return { ...base, branch };
}

/** Fills §12.2 placeholders; `quote` wraps each value (command lines). Unknown `{…}` are left alone. */
export function fill(template: string, vars: Partial<TaskVars>, quote?: (v: string) => string): string {
  return template.replace(PH_RE, (m, k: string) => {
    const v = vars[k as keyof TaskVars];
    if (v === undefined) return m;
    return quote ? quote(v) : v;
  });
}

export type ShellKind = 'posix' | 'cmd' | 'powershell';

/** What kind of shell runs the line's command lines: from `shell[0]`, else the platform's (cmd.exe on Windows). */
export function shellKind(shell: string[] | undefined, platform: string): ShellKind {
  if (!shell?.length) return platform === 'win32' ? 'cmd' : 'posix';
  const exe = shell[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
  if (exe === 'cmd') return 'cmd';
  if (exe === 'powershell' || exe === 'pwsh') return 'powershell';
  return 'posix';
}

/** Quotes a value for a command line of that shell; plain values (`[\w./:@%+=,-]`) stay as they are. */
export function quoteFor(kind: ShellKind): (v: string) => string {
  return (v) => {
    if (/^[\w./:\\@+=,-]*$/.test(v) && v !== '') return v;
    if (kind === 'posix') return `'${v.replace(/'/g, `'\\''`)}'`;
    if (kind === 'powershell') return `'${v.replace(/'/g, "''")}'`;
    return `"${v.replace(/"/g, '')}"`; // cmd: paths cannot hold a double quote; % and ^ are not in our values
  };
}

/** A command line of the line with its placeholders filled and quoted for its shell. */
export function fillCommand(line: Pick<ResolvedLine, 'shell'>, command: string, vars: TaskVars, platform: string): string {
  return fill(command, vars, quoteFor(shellKind(line.shell, platform)));
}

/** The env of every step (and the worker): the line's `env` with placeholders filled (plain, no quoting). */
export function lineEnv(line: Pick<ResolvedLine, 'env'>, vars: TaskVars): Record<string, string> {
  return Object.fromEntries(Object.entries(line.env).map(([k, v]) => [k, fill(v, vars)]));
}

/** The acceptance folder of every package: the part of `paths.acceptance` before its first id placeholder (`tests/acceptance/`). */
export function acceptanceRoot(line: Pick<ResolvedLine, 'paths'>): string | null {
  const t = line.paths.acceptance.replace(/\\/g, '/');
  const i = t.search(/\{(id|idLower|localId|localIdLower)\}/);
  if (i < 0) return null;
  const head = t.slice(0, i);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/') + 1) : '';
}
