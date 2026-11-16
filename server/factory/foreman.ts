// The foreman (SPEC §12.6): a `claude -p` job on the project's runner, in the main checkout, read-only, with the built-in
// structured answer `foreman`, a turn limit and a budget. The conductor calls it only when judgment is needed (a worker's
// question, a stuck package) and applies its answer. Its session counts as `coordonator` on the package.
import type { Ctx } from '../context.ts';
import { createJob, JobError } from '../jobs/core.ts';
import { foremanAnswerSchema, type ForemanAnswer } from '../../shared/factory.ts';
import { fill, type ResolvedLine } from '../../shared/line.ts';
import { fillKit, kitText, modelFor } from './brief.ts';
import type { ProjectRow } from './projects.ts';
import { FactoryError, taskVars, type TaskRow } from './tasks.ts';
import { jobAnswer, linkSession } from './worker.ts';

/** Read-only: files and the git history, nothing that writes. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)', 'Bash(git status *)'];
export const FOREMAN_LIMITS = { maxTurns: 30, maxBudgetUsd: 2, limitMinutes: 20 };

/** The last verdict and summary of each gate in the package's current round, for the foreman's situation. */
function gateSummaries(ctx: Ctx, t: TaskRow): string {
  const rows = ctx.db.all<{ gate: string; verdict: string; summary: string; round: number }>(
    `SELECT g.gate, g.verdict, g.summary, g.round FROM gate_results g WHERE g.task_id = ?
     AND g.id = (SELECT MAX(id) FROM gate_results x WHERE x.task_id = g.task_id AND x.gate = g.gate) ORDER BY g.gate`, t.id,
  );
  return rows.length ? rows.map((r) => `- ${r.gate} (round ${r.round}): ${r.verdict}: ${r.summary.replace(/\s+/g, ' ').slice(0, 800)}`).join('\n') : '- no gate has run yet';
}

/** Starts the foreman on the package. Returns its job id; throws FactoryError when it cannot start. */
export function startForeman(ctx: Ctx, t: TaskRow, p: ProjectRow, line: ResolvedLine, situation: string, worktree: string | null): string {
  const model = modelFor(p, line, 'foreman');
  if (!model) throw new FactoryError(409, 'the foreman is off for this project (models.foreman is null)');
  if (!p.machine_id || !p.checkout) throw new FactoryError(400, `project ${p.key} has no machine or checkout`);
  const v = taskVars(t, p);
  const prompt = [
    fillKit(kitText('foreman.md'), {
      id: t.id,
      project: p.key,
      title: t.title,
      situation: situation.trim().slice(0, 8000),
      worktree: worktree ?? fill(line.worktree, v),
      context: line.context.length ? line.context.map((c) => `\`${c}\``).join(', ') : 'none listed',
    }).trim(),
    '',
    `**Round** ${Math.max(1, t.round)}. **The gates so far:**`,
    gateSummaries(ctx, t),
  ].join('\n');
  try {
    return createJob(ctx, {
      machineId: p.machine_id,
      cwd: p.checkout,
      promptText: prompt,
      title: `Foreman: ${t.id}`,
      options: { model, permissionMode: 'dontAsk', allowedTools: READ_ONLY_TOOLS, outputSchema: 'foreman', role: 'coordonator', bbTask: t.id, launcher: 'claude', ...FOREMAN_LIMITS },
    });
  } catch (e) {
    if (e instanceof JobError) throw new FactoryError(e.status, e.message);
    throw e;
  }
}

export type ForemanResult = { state: 'running' } | { state: 'answer'; answer: ForemanAnswer } | { state: 'failed'; reason: string };

/** The foreman's answer once its job ended; its session is counted on the package as `coordonator`. */
export function foremanResult(ctx: Ctx, taskId: string, jobId: string): ForemanResult {
  const a = jobAnswer(ctx, jobId);
  if (a.state === 'missing') return { state: 'failed', reason: 'its job is gone' };
  if (a.state === 'running') return { state: 'running' };
  linkSession(ctx, taskId, a.sessionId, 'coordonator');
  const p = foremanAnswerSchema.safeParse(a.structured);
  if (p.success) return { state: 'answer', answer: p.data };
  return { state: 'failed', reason: a.status !== 'succeeded' ? `its job ${a.status}${a.reason ? ` (${a.reason})` : ''}` : 'it gave no structured answer' };
}
