// Job option validation and the claude argument list. Pure (no Node imports) so the server and web can share it.
import type { JobOptions } from '../shared/types.ts';

/** What jobs.options_json holds: JobOptions plus fields only the server/runner use. */
export interface StoredJobOptions extends JobOptions {
  limitMinutes?: number;
  resumeSessionId?: string;
  /** id of a built-in structured-output schema (passed as --json-schema); arbitrary schemas are not accepted */
  outputSchema?: keyof typeof OUTPUT_SCHEMAS;
  /** `hc`: start an interactive `claude` in a herdr terminal instead of running `claude -p` (default `claude`) */
  launcher?: 'claude' | 'hc';
  /** the backlog package this job works on; names the herdr terminal and links it back */
  taskId?: string;
}

export const LAUNCHERS = ['claude', 'hc'] as const;

/** Structured-output schemas jobs may ask for, by id. `specify` turns a rough idea into harness slots + a draft spec. */
export const OUTPUT_SCHEMAS = {
  specify: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'what to build, in one or two sentences' },
      doneWhen: { type: 'array', items: { type: 'string' }, description: 'runnable checks, one per item, with backticked commands' },
      scope: { type: 'string', description: 'files or directories that may change' },
      spec: { type: 'string', description: 'a draft spec in Markdown' },
    },
    required: ['goal', 'doneWhen', 'scope', 'spec'],
  },
} as const;

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// values never start with '-', so none can be read as a flag
const MODEL_RE = /^\w[\w.:[\]-]{0,99}$/;
const TOOL_RE = /^[\w*][\w*().:, -]{0,199}$/;
const WORKTREE_RE = /^[\w.-]{1,64}$/;
const TASK_RE = /^[\w.-]{1,64}$/;
const SESSION_RE = /^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/;

export class OptionError extends Error {}

const num = (v: unknown, name: string, int = false, max = Infinity): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max || (int && !Number.isInteger(v))) throw new OptionError(`${name} must be a ${int ? 'whole ' : ''}number > 0${max < Infinity ? ` and <= ${max}` : ''}`);
  return v;
};

const str = (v: unknown, name: string, re: RegExp): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !re.test(v)) throw new OptionError(`invalid ${name}: ${JSON.stringify(v)}`);
  return v;
};

const tools = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 100) throw new OptionError(`${name} must be a list`);
  const out = v.map((t) => (typeof t === 'string' ? t.trim() : t)).filter((t) => t !== '');
  for (const t of out) if (typeof t !== 'string' || !TOOL_RE.test(t)) throw new OptionError(`invalid tool name in ${name}: ${JSON.stringify(t)}`);
  return out.length ? (out as string[]) : undefined;
};

/** Validates every option against a strict pattern. Throws OptionError. Unknown keys are dropped. */
export function checkOptions(o: unknown): StoredJobOptions {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new OptionError('options must be an object');
  const r = o as Record<string, unknown>;
  const maxBudgetUsd = num(r.maxBudgetUsd, 'maxBudgetUsd', false, 1000);
  if (maxBudgetUsd === undefined) throw new OptionError('maxBudgetUsd is required');
  if (r.permissionMode !== undefined && r.permissionMode !== '' && !PERMISSION_MODES.includes(r.permissionMode as never)) throw new OptionError(`invalid permissionMode: ${JSON.stringify(r.permissionMode)}`);
  if (r.effort !== undefined && r.effort !== '' && !EFFORTS.includes(r.effort as never)) throw new OptionError(`invalid effort: ${JSON.stringify(r.effort)}`);
  let worktree: boolean | string | undefined;
  if (typeof r.worktree === 'boolean') worktree = r.worktree || undefined;
  else worktree = str(r.worktree, 'worktree name', WORKTREE_RE);
  if (r.walkMode !== undefined && typeof r.walkMode !== 'boolean') throw new OptionError('walkMode must be true or false');
  if (r.outputSchema !== undefined && !Object.hasOwn(OUTPUT_SCHEMAS, String(r.outputSchema))) throw new OptionError(`unknown outputSchema: ${JSON.stringify(r.outputSchema)}`);
  if (r.verify !== undefined && (!Array.isArray(r.verify) || r.verify.some((c) => typeof c !== 'string' || c.length > 2000) || r.verify.length > 30)) throw new OptionError('verify must be a list of commands');
  if (r.launcher !== undefined && r.launcher !== '' && !LAUNCHERS.includes(r.launcher as never)) throw new OptionError(`invalid launcher: ${JSON.stringify(r.launcher)}`);
  const out: StoredJobOptions = {
    model: str(r.model, 'model', MODEL_RE),
    fallbackModel: str(r.fallbackModel, 'fallbackModel', MODEL_RE),
    effort: (r.effort || undefined) as string | undefined,
    permissionMode: (r.permissionMode || undefined) as string | undefined,
    maxBudgetUsd,
    maxTurns: num(r.maxTurns, 'maxTurns', true, 100_000),
    allowedTools: tools(r.allowedTools, 'allowedTools'),
    disallowedTools: tools(r.disallowedTools, 'disallowedTools'),
    worktree,
    walkMode: r.walkMode as boolean | undefined,
    verify: r.verify as string[] | undefined,
    limitMinutes: num(r.limitMinutes, 'limitMinutes', false, 7 * 24 * 60),
    resumeSessionId: str(r.resumeSessionId, 'resumeSessionId', SESSION_RE),
    outputSchema: r.outputSchema as StoredJobOptions['outputSchema'],
    launcher: (r.launcher || undefined) as StoredJobOptions['launcher'],
    taskId: str(r.taskId, 'taskId', TASK_RE),
  };
  for (const k of Object.keys(out) as (keyof StoredJobOptions)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Job titles go into argv as-is (no shell), but drop control chars and a leading dash so it can't read as a flag. */
export function cleanTitle(t: string | null | undefined): string {
  const s = (t ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/^[\s-]+/, '').trim().slice(0, 120);
  return s || 'Buildyboy job';
}

/** The validated argument list for `claude`. With resume, `--resume <id>` replaces `--session-id`. */
export function buildClaudeArgs(raw: unknown, opts: { sessionId: string; title: string | null }): string[] {
  const o = checkOptions(raw);
  if (!SESSION_RE.test(opts.sessionId)) throw new OptionError('invalid session id');
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--input-format', 'stream-json'];
  if (o.resumeSessionId) a.push('--resume', o.resumeSessionId);
  else a.push('--session-id', opts.sessionId);
  a.push('-n', cleanTitle(opts.title));
  if (o.worktree) a.push(...(typeof o.worktree === 'string' ? ['--worktree', o.worktree] : ['--worktree']));
  if (o.model) a.push('--model', o.model);
  if (o.fallbackModel) a.push('--fallback-model', o.fallbackModel);
  if (o.effort) a.push('--effort', o.effort);
  if (o.permissionMode) a.push('--permission-mode', o.permissionMode);
  if (o.maxTurns) a.push('--max-turns', String(o.maxTurns));
  // the tool flags are variadic, so a fixed flag always follows them
  if (o.allowedTools) a.push('--allowedTools', ...o.allowedTools);
  if (o.disallowedTools) a.push('--disallowedTools', ...o.disallowedTools);
  if (o.outputSchema) a.push('--json-schema', JSON.stringify(OUTPUT_SCHEMAS[o.outputSchema]));
  a.push('--max-budget-usd', String(o.maxBudgetUsd));
  return a;
}

/** hc terminal name for a package: 1-32 of a-z 0-9 - _, so `T12` becomes `bb-t12`. */
export function hcTerminalName(taskId: string | null | undefined, jobId?: string): string {
  const clean = (taskId ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const base = clean || `job-${(jobId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'x'}`;
  return `bb-${base}`.slice(0, 32).replace(/-+$/, '');
}

const HC_ID_RE = /^[\w.-]{1,64}$/;
/** Longest prompt we put on a command line (Windows allows about 32k characters in all). */
export const HC_PROMPT_MAX = 24_000;

/**
 * The validated argument list for `hc run`, which starts an interactive `claude` in a persistent terminal.
 * `program` is the claude executable (`claude`, or the configured claudePath); `plugin` are extra --plugin-dir paths.
 */
export function buildHcRunArgs(raw: unknown, a: { jobId: string; cwd: string; title: string | null; prompt: string; program?: string; pluginDirs?: string[] }): string[] {
  const o = checkOptions(raw);
  if (!HC_ID_RE.test(a.jobId)) throw new OptionError('invalid job id');
  const prompt = a.prompt.trim();
  if (!prompt) throw new OptionError('empty prompt');
  if (prompt.length > HC_PROMPT_MAX) throw new OptionError(`prompt is too long for a terminal command line (${prompt.length} > ${HC_PROMPT_MAX} characters); launch it with claude -p`);
  const args = ['run', '--bg', '--json', '--name', hcTerminalName(o.taskId, a.jobId), '--cwd', a.cwd, '--label', 'owner=buildyboy'];
  if (o.taskId) args.push('--label', `bb.task=${o.taskId}`);
  args.push('--label', `bb.job=${a.jobId}`, '--no-parent', a.program || 'claude');
  if (o.model) args.push('--model', o.model);
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  for (const d of a.pluginDirs ?? []) args.push('--plugin-dir', d);
  args.push('-n', cleanTitle(a.title));
  // the prompt is a positional argument: a leading dash must not read as a flag
  args.push(prompt.startsWith('-') ? `Task: ${prompt}` : prompt);
  return args;
}
