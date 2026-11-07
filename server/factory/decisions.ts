// Decisions (SPEC §11.5): questions the coordinator cannot settle alone. They wait in the phone inbox; the answer is
// delivered later through decision_get.
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import type { DecisionView, ToolArgs } from '../../shared/factory.ts';
import { FactoryError } from './tasks.ts';

type Row = { id: string; task_id: string | null; question: string; context: string | null; options_json: string | null; status: DecisionView['status']; answer: string | null; asked_by: string; created_at: number; answered_at: number | null };

const view = (r: Row): DecisionView => ({
  id: r.id, taskId: r.task_id, question: r.question, context: r.context, options: json<string[]>(r.options_json, []) ?? [], status: r.status, answer: r.answer,
  askedBy: r.asked_by, createdAt: r.created_at, answeredAt: r.answered_at,
});

export function listDecisions(ctx: Ctx, f: { status?: DecisionView['status']; taskId?: string; limit?: number } = {}): DecisionView[] {
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
  return ctx.db.all<Row>(`SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY status = 'pending' DESC, created_at DESC LIMIT ?`, ...args, f.limit ?? 200).map(view);
}

export function getDecision(ctx: Ctx, id: string): DecisionView | null {
  const r = ctx.db.get<Row>('SELECT * FROM decisions WHERE id = ?', id);
  return r ? view(r) : null;
}

export function askDecision(ctx: Ctx, a: ToolArgs<'decision_ask'>, actor: string): DecisionView {
  if (a.taskId && !ctx.db.get('SELECT 1 FROM tasks WHERE id = ?', a.taskId)) throw new FactoryError(400, `unknown task ${a.taskId}`);
  const id = randomUUID();
  ctx.db.run(
    "INSERT INTO decisions (id, task_id, question, context, options_json, status, asked_by, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    id, a.taskId ?? null, a.question, a.context ?? null, a.options?.length ? JSON.stringify(a.options) : null, actor, Date.now(),
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
  ctx.db.run("UPDATE decisions SET status = ?, answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'", status, answer, Date.now(), id);
  ctx.db.audit(actor, `decision_${status}`, id);
  ctx.bus.publish('inbox', 'decision', { id });
  if (cur.taskId) ctx.bus.publish('tasks', 'changed', { id: cur.taskId });
  return getDecision(ctx, id);
}
