// The kit's `claude -p` verifiers (SPEC §12.4): QA, the reviewer (G3) and the visual judge (G4). Each runs in the
// package's worktree with an explicit permission mode and tool list, a model from the line, a turn limit and a budget,
// and BB_TASK / BB_ROLE in its env so its cost lands on the package (§11.7). With a JSON schema the answer is read from
// `structured_output`; a run without one is retried once. claude is resolved as runner/claude.ts does (never a shim).
import type { Exe } from '../claude.ts';
import { spawnCapture } from './exec.ts';

export interface VerifierOpts {
  exe: Exe;
  cwd: string;
  prompt: string;
  /** the JSON schema of the answer (--json-schema); without one the answer is the result text */
  schema?: unknown;
  model: string;
  permissionMode: 'dontAsk' | 'acceptEdits' | 'default' | 'plan' | 'bypassPermissions' | 'auto';
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  chrome?: boolean;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onData?: (s: string) => void;
}

export interface VerifierAnswer {
  ok: boolean;
  /** structured_output (schema runs) */
  output: Record<string, unknown> | null;
  /** the final text */
  result: string;
  /** summed over the attempts */
  costUsd: number;
  attempts: number;
  sessionId: string | null;
  error?: string;
}

/** The argv after the executable. Variadic --allowedTools is followed by a fixed flag; the prompt is the last positional. */
export function verifierArgs(o: Omit<VerifierOpts, 'exe' | 'cwd' | 'env' | 'timeoutMs' | 'signal' | 'onData'>): string[] {
  const a = ['-p', '--output-format', 'json', '--model', o.model, '--permission-mode', o.permissionMode, '--max-turns', String(o.maxTurns)];
  if (o.chrome) a.push('--chrome');
  if (o.allowedTools.length) a.push('--allowedTools', ...o.allowedTools);
  if (o.schema !== undefined) a.push('--json-schema', JSON.stringify(o.schema));
  a.push('--max-budget-usd', String(o.maxBudgetUsd));
  a.push(o.prompt.startsWith('-') ? `Task: ${o.prompt}` : o.prompt);
  return a;
}

/** `--output-format json` prints one JSON object; tolerate noise before it. */
export function parseClaudeJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim();
  for (const cand of [t, t.slice(t.indexOf('{')), t.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop() ?? '']) {
    if (!cand) continue;
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch {
      // next candidate
    }
  }
  return null;
}

export async function runVerifier(o: VerifierOpts): Promise<VerifierAnswer> {
  let cost = 0;
  let last = '';
  let sessionId: string | null = null;
  const tries = o.schema !== undefined ? 2 : 1;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const r = await spawnCapture([o.exe.command, ...o.exe.prefix, ...verifierArgs(o)], { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, signal: o.signal, onData: o.onData });
    if (r.kind === 'aborted') return { ok: false, output: null, result: '', costUsd: cost, attempts: attempt, sessionId, error: 'runner stopped while claude was running' };
    if (r.kind === 'spawn-error') return { ok: false, output: null, result: '', costUsd: cost, attempts: attempt, sessionId, error: `claude could not start: ${r.message ?? 'spawn failed'}` };
    if (r.kind === 'timeout') return { ok: false, output: null, result: '', costUsd: cost, attempts: attempt, sessionId, error: `claude timed out after ${Math.round(o.timeoutMs / 1000)} s` };
    const j = parseClaudeJson(r.stdout);
    const c = Number(j?.total_cost_usd ?? 0);
    if (Number.isFinite(c) && c > 0) cost += c;
    if (typeof j?.session_id === 'string') sessionId = j.session_id;
    const result = typeof j?.result === 'string' ? j.result : '';
    const so = j?.structured_output;
    if (o.schema === undefined) {
      if (j && j.is_error !== true) return { ok: true, output: null, result, costUsd: cost, attempts: attempt, sessionId };
      last = j ? `claude ended with an error: ${result.slice(0, 300) || String(j.subtype ?? '')}` : `claude printed no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
      continue;
    }
    if (so && typeof so === 'object' && !Array.isArray(so)) return { ok: true, output: so as Record<string, unknown>, result, costUsd: cost, attempts: attempt, sessionId };
    last = j ? `no structured_output (${j.is_error ? 'error: ' : ''}${(result || String(j.subtype ?? '')).slice(0, 300)})` : `claude printed no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
  }
  return { ok: false, output: null, result: '', costUsd: cost, attempts: tries, sessionId, error: tries > 1 ? `${last}; retried once` : last };
}

/** The first sentence of a text, at most 140 characters (a finding's title, as arond's rezultat.mjs). */
export function firstSentence(s: unknown): string {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  const p = t.split(/(?<=[.!?])\s/)[0] ?? '';
  return (p.length > 140 ? `${p.slice(0, 137)}…` : p) || '(no description)';
}
