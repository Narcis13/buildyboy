// Gate findings (SPEC §11.7): what a gate found, as records with a status. A later pass of the same gate marks its
// earlier blocker and major findings fixed; minors stay open until someone decides (fixed, deferred to a new package,
// for the architect, won't fix).
import type { Ctx } from '../context.ts';
import { FINDING_SEVERITIES, type FindingInput, type FindingSeverity, type FindingStatus, type FindingView, type Gate } from '../../shared/factory.ts';
import { FactoryError } from './tasks.ts';

type Row = {
  id: number; task_id: string; gate_result_id: number | null; gate: Gate; round: number; severity: FindingSeverity; title: string; file: string | null;
  line: number | null; detail: string | null; fix: string | null; status: FindingStatus; note: string | null; deferred_to: string | null; created_at: number; updated_at: number;
};

const view = (r: Row): FindingView => ({
  id: r.id, taskId: r.task_id, gateResultId: r.gate_result_id, gate: r.gate, round: r.round, severity: r.severity, title: r.title, file: r.file, line: r.line,
  detail: r.detail, fix: r.fix, status: r.status, note: r.note, deferredTo: r.deferred_to, createdAt: r.created_at, updatedAt: r.updated_at,
});

const SEV_ORDER = `CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 ELSE 2 END`;

export function listFindings(ctx: Ctx, f: { taskId?: string; status?: FindingStatus; severity?: FindingSeverity; ids?: number[]; limit?: number } = {}): FindingView[] {
  const where = ['1 = 1'];
  const args: (string | number)[] = [];
  if (f.taskId) where.push('task_id = ?'), args.push(f.taskId);
  if (f.status) where.push('status = ?'), args.push(f.status);
  if (f.severity) where.push('severity = ?'), args.push(f.severity);
  if (f.ids) {
    if (!f.ids.length) return [];
    where.push(`id IN (${f.ids.map(() => '?').join(',')})`);
    args.push(...f.ids);
  }
  return ctx.db
    .all<Row>(`SELECT * FROM findings WHERE ${where.join(' AND ')} ORDER BY status = 'open' DESC, ${SEV_ORDER}, task_id, id LIMIT ?`, ...args, f.limit ?? 500)
    .map(view);
}

/** Inside recordGate's transaction: stores the result's findings and, on a pass, closes the gate's earlier serious ones. */
export function applyGateFindings(ctx: Ctx, taskId: string, gate: Gate, round: number, gateResultId: number, verdict: string, findings: FindingInput[]): { added: number; fixed: number } {
  const now = Date.now();
  for (const f of findings) {
    ctx.db.run(
      `INSERT INTO findings (task_id, gate_result_id, gate, round, severity, title, file, line, detail, fix, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      taskId, gateResultId, gate, round, f.severity, f.title, f.file ?? null, f.line ?? null, f.detail ?? null, f.fix ?? null, now, now,
    );
  }
  let fixed = 0;
  if (verdict === 'pass') {
    fixed = ctx.db.run(
      `UPDATE findings SET status = 'fixed', note = COALESCE(note, ?), updated_at = ?
       WHERE task_id = ? AND gate = ? AND status = 'open' AND severity IN ('blocker', 'major') AND COALESCE(gate_result_id, 0) != ?`,
      `${gate} passed in round ${round}`, now, taskId, gate, gateResultId,
    ).changes as number;
  }
  return { added: findings.length, fixed };
}

export function openFindingCounts(ctx: Ctx, ids: string[]): Map<string, Record<FindingSeverity, number>> {
  const out = new Map<string, Record<FindingSeverity, number>>();
  if (!ids.length) return out;
  const rows = ctx.db.all<{ task_id: string; severity: FindingSeverity; n: number }>(
    `SELECT task_id, severity, COUNT(*) n FROM findings WHERE status = 'open' AND task_id IN (${ids.map(() => '?').join(',')}) GROUP BY task_id, severity`, ...ids,
  );
  for (const id of ids) out.set(id, Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as Record<FindingSeverity, number>);
  for (const r of rows) if (FINDING_SEVERITIES.includes(r.severity)) out.get(r.task_id)![r.severity] = r.n;
  return out;
}

export function updateFindings(ctx: Ctx, ids: number[], status: FindingStatus, note: string | null, actor: string, deferredTo: string | null = null): FindingView[] {
  const found = listFindings(ctx, { ids: [...new Set(ids)] });
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new FactoryError(404, `unknown finding${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
  const now = Date.now();
  ctx.db.tx(() => {
    for (const f of found) {
      ctx.db.run(
        'UPDATE findings SET status = ?, note = COALESCE(?, note), deferred_to = CASE WHEN ? = \'deferred\' THEN COALESCE(?, deferred_to) ELSE NULL END, updated_at = ? WHERE id = ?',
        status, note, status, deferredTo, now, f.id,
      );
    }
    const byTask = new Map<string, number[]>();
    for (const f of found) byTask.set(f.taskId, [...(byTask.get(f.taskId) ?? []), f.id]);
    for (const [taskId, list] of byTask) {
      ctx.db.run(
        'INSERT INTO task_events (task_id, ts, actor, kind, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        taskId, now, actor, 'findings', JSON.stringify({ ids: list, status, ...(note ? { note } : {}), ...(deferredTo ? { deferredTo } : {}) }),
      );
      ctx.bus.publish('tasks', 'changed', { id: taskId });
    }
  });
  return listFindings(ctx, { ids: found.map((f) => f.id) });
}

/** tasks_create fromFindings: the body section and acceptance criteria made from the chosen findings. */
export function findingsBrief(ctx: Ctx, ids: number[]): { findings: FindingView[]; body: string; acceptance: string[] } {
  const findings = listFindings(ctx, { ids: [...new Set(ids)] });
  const missing = ids.filter((id) => !findings.some((f) => f.id === id));
  if (missing.length) throw new FactoryError(400, `unknown finding${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
  const where = (f: FindingView) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null);
  const body = [
    '## Findings',
    '',
    ...findings.map((f) =>
      [
        `- **[${f.severity}] ${f.title}** — ${f.taskId} ${f.gate}, round ${f.round} (finding #${f.id})${where(f) ? ` · \`${where(f)}\`` : ''}`,
        f.detail ? `  ${f.detail.replace(/\n/g, '\n  ')}` : null,
        f.fix ? `  Fix: ${f.fix.replace(/\n/g, '\n  ')}` : null,
      ].filter(Boolean).join('\n'),
    ),
  ].join('\n');
  const acceptance = findings.map((f) => `Fixed: ${f.title}${where(f) ? ` (${where(f)})` : ''}`);
  return { findings, body, acceptance };
}
