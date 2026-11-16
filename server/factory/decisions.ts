// Decisions (SPEC §11.5): questions the coordinator cannot settle alone. They wait in the phone inbox; the answer is
// delivered later through decision_get. Each records who answered it (the owner, or an operator: §12.7) and which
// agent token asked it.
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import type { DecisionView, ToolArgs } from '../../shared/factory.ts';
import { FactoryError } from './tasks.ts';

export type DecisionRow = {
  id: string; task_id: string | null; question: string; context: string | null; options_json: string | null; status: DecisionView['status']; answer: string | null;
  asked_by: string; created_at: number; answered_at: number | null; answered_by: string | null; asked_token: string | null;
};
type Row = DecisionRow;

export const decisionView = (r: Row): DecisionView => ({
  id: r.id, taskId: r.task_id, question: r.question, context: r.context, options: json<string[]>(r.options_json, []) ?? [], status: r.status, answer: r.answer,
  askedBy: r.asked_by, createdAt: r.created_at, answeredAt: r.answered_at, answeredBy: r.answered_by,
});
const view = decisionView;

export function listDecisions(ctx: Ctx, f: { status?: DecisionView['status']; taskId?: string; project?: string; limit?: number } = {}): DecisionView[] {
  const where = ['1 = 1'];
  const args: (string | number)[] = [];
  if (f.status) {
    where.push('status = ?');
    args.push(f.status);
  }
  if (f.taskId) {
    where.push('task_id = ?');
    args.push(f.taskId);
  }
  if (f.project) {
    // decisions tied to the project's packages (§12.1), and its plans' (§12.6)
    where.push('(task_id IN (SELECT id FROM tasks WHERE project = ?) OR id IN (SELECT decision_id FROM plans WHERE project = ? AND decision_id IS NOT NULL))');
    args.push(f.project, f.project);
  }
  return ctx.db.all<Row>(`SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY status = 'pending' DESC, created_at DESC LIMIT ?`, ...args, f.limit ?? 200).map(view);
}

export function getDecision(ctx: Ctx, id: string): DecisionView | null {
  const r = ctx.db.get<Row>('SELECT * FROM decisions WHERE id = ?', id);
  return r ? view(r) : null;
}

/** `tokenId`: the agent token that asks, so it can never answer its own question (§12.7). */
export function askDecision(ctx: Ctx, a: ToolArgs<'decision_ask'>, actor: string, tokenId: string | null = null): DecisionView {
  if (a.taskId && !ctx.db.get('SELECT 1 FROM tasks WHERE id = ?', a.taskId)) throw new FactoryError(400, `unknown task ${a.taskId}`);
  const id = randomUUID();
  ctx.db.run(
    "INSERT INTO decisions (id, task_id, question, context, options_json, status, asked_by, asked_token, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
    id, a.taskId ?? null, a.question, a.context ?? null, a.options?.length ? JSON.stringify(a.options) : null, actor, tokenId, Date.now(),
  );
  ctx.bus.publish('inbox', 'decision', { id });
  if (a.taskId) ctx.bus.publish('tasks', 'changed', { id: a.taskId });
  ctx.notify({ type: 'decision', title: `Decision needed${a.taskId ? ` · ${a.taskId}` : ''}`, body: a.question.slice(0, 240), url: `/decisions#${id}` });
  return getDecision(ctx, id)!;
}

export function answerDecision(ctx: Ctx, id: string, answer: string | null, actor: string): DecisionView | null {
  const cur = getDecision(ctx, id);
  if (!cur || cur.status !== 'pending') return null;
  const status = answer === null ? 'cancelled' : 'answered';
  ctx.db.run("UPDATE decisions SET status = ?, answer = ?, answered_at = ?, answered_by = ? WHERE id = ? AND status = 'pending'", status, answer, Date.now(), actor, id);
  ctx.db.audit(actor, `decision_${status}`, id);
  ctx.bus.publish('inbox', 'decision', { id });
  if (cur.taskId) ctx.bus.publish('tasks', 'changed', { id: cur.taskId });
  return getDecision(ctx, id);
}
