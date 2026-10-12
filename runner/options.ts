// Job option validation and the claude argument list. Pure (no Node imports) so the server and web can share it.
import type { JobOptions } from '../shared/types.ts';

/** What jobs.options_json holds: JobOptions plus fields only the server/runner use. */
export interface StoredJobOptions extends JobOptions {
  limitMinutes?: number;
  resumeSessionId?: string;
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const MODEL_RE = /^[\w.:[\]-]{1,100}$/;
const TOOL_RE = /^[\w*][\w*().:, -]{0,199}$/;
const WORKTREE_RE = /^[\w.-]{1,64}$/;
const SESSION_RE = /^[0-9a-zA-Z-]{8,64}$/;

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
  if (r.verify !== undefined && (!Array.isArray(r.verify) || r.verify.some((c) => typeof c !== 'string' || c.length > 2000) || r.verify.length > 30)) throw new OptionError('verify must be a list of commands');
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
  a.push('--max-budget-usd', String(o.maxBudgetUsd));
  return a;
}
