// Checked herdr commands (SPEC §12.4, §12.5 "Telling a worker something"): the server asks a runner to `hc send` a line to,
// or `hc kill`, a terminal the factory started (`bb-…`, label owner=buildyboy; the runner checks both with `hc get`).
// Each command is kept in hc_commands so its sender (the conductor) can read the outcome; the runner reports it on
// POST /api/runner/hc/:id. A command still queued is re-sent when its status is read, like a gate run.
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { sendToRunner } from '../jobs/core.ts';
import { hcTerminalName } from '../../runner/options.ts';
import type { HcCommand, HcCommandStatus, HcCommandView, HcReport, StepFile } from '../../shared/factory.ts';
import { checkStepFiles } from './gateruns.ts';
import { projectRow } from './projects.ts';
import { FactoryError, taskEvent } from './tasks.ts';

const NAME_RE = /^bb-[a-z0-9_-]{1,29}$/;

type Row = {
  id: string; machine_id: string; task_id: string | null; op: 'send' | 'kill'; name: string; command_json: string; status: HcCommandStatus;
  result_json: string | null; error: string | null; actor: string; created_at: number; finished_at: number | null;
};

const view = (r: Row): HcCommandView => ({
  id: r.id, machineId: r.machine_id, taskId: r.task_id, op: r.op, name: r.name, status: r.status, result: json(r.result_json, null), error: r.error,
  createdAt: r.created_at, finishedAt: r.finished_at,
});

export interface HcArgs {
  op: 'send' | 'kill';
  /** the package whose worker terminal it is: gives the machine (its project's) and the default name `bb-<id>` */
  taskId?: string;
  /** without a package: the machine and the terminal's name */
  machineId?: string;
  name?: string;
  text?: string;
  if?: 'idle' | 'working';
  files?: StepFile[];
}

/** Sends a checked `hc send` or `hc kill` to the runner and keeps it; read its outcome with hcCommandStatus. */
export function sendHcCommand(ctx: Ctx, a: HcArgs, actor: string): HcCommandView & { sent: boolean } {
  if (a.op !== 'send' && a.op !== 'kill') throw new FactoryError(400, 'op: send or kill');
  let machineId = a.machineId ?? null;
  let name = a.name ?? null;
  if (a.taskId) {
    const t = ctx.db.get<{ id: string; project: string | null }>('SELECT id, project FROM tasks WHERE id = ?', a.taskId);
    if (!t) throw new FactoryError(404, `unknown task ${a.taskId}`);
    machineId ??= projectRow(ctx, t.project)?.machine_id ?? null;
    name ??= hcTerminalName(t.id);
  }
  if (!machineId) throw new FactoryError(400, 'no machine: give machineId, or a package whose project has one');
  if (!ctx.db.get('SELECT 1 FROM machines WHERE id = ? AND revoked = 0', machineId)) throw new FactoryError(400, `unknown machine ${machineId}`);
  if (!name || !NAME_RE.test(name)) throw new FactoryError(400, `terminal ${JSON.stringify(name)}: only the factory's terminals (bb-…)`);
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (a.op === 'send' && !text) throw new FactoryError(400, 'send: text is required');
  if (text.length > 200_000) throw new FactoryError(400, 'text: at most 200 000 characters');
  if (a.if !== undefined && a.if !== 'idle' && a.if !== 'working') throw new FactoryError(400, 'if: idle or working');
  const files = checkStepFiles(a.files);
  const id = randomUUID();
  const cmd: HcCommand = { type: 'hc', id, op: a.op, name, ...(a.op === 'send' ? { text, ...(a.if ? { if: a.if } : {}), ...(files.length ? { files } : {}) } : {}) };
  ctx.db.run(
    "INSERT INTO hc_commands (id, machine_id, task_id, op, name, command_json, status, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
    id, machineId, a.taskId ?? null, a.op, name, JSON.stringify(cmd), actor, Date.now(),
  );
  if (a.taskId) taskEvent(ctx, a.taskId, actor, 'hc', null, null, { id, op: a.op, name, ...(a.op === 'send' ? { text: text.slice(0, 300) } : {}) });
  const sent = sendToRunner(ctx, machineId, cmd as unknown as Record<string, unknown>);
  return { ...view(ctx.db.get<Row>('SELECT * FROM hc_commands WHERE id = ?', id)!), sent };
}

/** The outcome of an hc command; one still queued is re-sent (the runner ignores an id it already ran). */
export function hcCommandStatus(ctx: Ctx, id: string): HcCommandView & { sent?: boolean } {
  const r = ctx.db.get<Row>('SELECT * FROM hc_commands WHERE id = ?', id);
  if (!r) throw new FactoryError(404, `unknown hc command ${id}`);
  if (r.status === 'queued') return { ...view(r), sent: sendToRunner(ctx, r.machine_id, JSON.parse(r.command_json)) };
  return view(r);
}

/** The runner's report: only the machine it was sent to; the first report wins. */
export function applyHcReport(ctx: Ctx, machineId: string, id: string, rep: HcReport): HcCommandView {
  const r = ctx.db.get<Row>('SELECT * FROM hc_commands WHERE id = ?', id);
  if (!r || r.machine_id !== machineId) throw new FactoryError(404, 'unknown hc command');
  if (r.status !== 'queued') return view(r);
  const ok = rep.status === 'done';
  ctx.db.run(
    'UPDATE hc_commands SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?',
    ok ? 'done' : 'error', rep.result ? JSON.stringify(rep.result).slice(0, 20_000) : null, ok ? null : (rep.error ?? 'error').slice(0, 4000), Date.now(), id,
  );
  if (r.task_id) {
    taskEvent(ctx, r.task_id, 'runner:hc', 'hc_done', null, null, { id, op: r.op, name: r.name, status: ok ? 'done' : 'error', ...(ok ? {} : { error: (rep.error ?? '').slice(0, 500) }) });
    ctx.bus.publish('tasks', 'changed', { id: r.task_id });
  }
  return view(ctx.db.get<Row>('SELECT * FROM hc_commands WHERE id = ?', id)!);
}
