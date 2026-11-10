// Gates as runner jobs (SPEC §11.7). gates_run sends the gate to the runner of the repo's machine; the runner reads the
// recipe from the trusted main checkout, runs its argv steps and reports back (POST /api/runner/gates/:id). The server
// records the gate result with the verdict, summary and findings, keeps the log, and never hands the log to the agent.
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { sendToRunner } from '../jobs/core.ts';
import { findingSchema, type FindingInput, type Gate, type GateCommand, type GateReport, type GateRunStatus, type GateRunView, type ToolArgs, type Verdict } from '../../shared/factory.ts';
import { repoConfig } from './config.ts';
import { FactoryError, recordGate, taskVars } from './tasks.ts';

/** The server keeps the tail of a gate's log. */
export const LOG_KEEP = 256 * 1024;

type Row = {
  id: string; task_id: string; gate: Gate; round: number; args_json: string; machine_id: string; command_json: string; status: GateRunStatus; verdict: Verdict | null;
  summary: string | null; findings_json: string | null; gate_result_id: number | null; exit_code: number | null; error: string | null; log: string | null;
  created_at: number; started_at: number | null; finished_at: number | null;
};

const COLS = `id, task_id, gate, round, args_json, machine_id, command_json, status, verdict, summary, findings_json, gate_result_id, exit_code, error,
  LENGTH(CAST(log AS BLOB)) log, created_at, started_at, finished_at`;

const view = (r: Row): GateRunView => ({
  id: r.id, taskId: r.task_id, gate: r.gate, round: r.round, args: json<string[]>(r.args_json, []) ?? [], machineId: r.machine_id, status: r.status,
  verdict: r.verdict, summary: r.summary, findings: json<FindingInput[]>(r.findings_json, []) ?? [], gateResultId: r.gate_result_id, exitCode: r.exit_code,
  error: r.error, logBytes: Number(r.log ?? 0), createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});

const get = (ctx: Ctx, id: string) => ctx.db.get<Row>(`SELECT ${COLS} FROM gate_runs WHERE id = ?`, id);

export function listGateRuns(ctx: Ctx, taskId: string, limit = 50): GateRunView[] {
  return ctx.db.all<Row>(`SELECT ${COLS} FROM gate_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`, taskId, limit).map(view);
}

export function startGateRun(ctx: Ctx, a: ToolArgs<'gates_run'>, actor: string): GateRunView & { sent: boolean } {
  const t = ctx.db.get<Parameters<typeof taskVars>[0]>('SELECT * FROM tasks WHERE id = ?', a.taskId);
  if (!t) throw new FactoryError(404, `unknown task ${a.taskId}`);
  const cfg = repoConfig(ctx, t.repo);
  if (!cfg) throw new FactoryError(400, `${a.taskId}: no factory config for repo ${t.repo ?? '(none)'}; set it in Settings → Factory`);
  if (!cfg.machineId || !cfg.checkout || !cfg.recipe) throw new FactoryError(400, `repo ${cfg.repo}: the factory config needs a machine, the main checkout and the recipe path`);
  if (!ctx.db.get('SELECT 1 FROM machines WHERE id = ? AND revoked = 0', cfg.machineId)) throw new FactoryError(400, `repo ${cfg.repo}: unknown machine ${cfg.machineId}`);
  const id = randomUUID();
  const round = Math.max(1, t.round);
  const command: GateCommand = {
    type: 'gate',
    run: { id, taskId: t.id, gate: a.gate, round, args: a.args ?? [], checkout: cfg.checkout, recipe: cfg.recipe, vars: taskVars(t, cfg) },
  };
  ctx.db.run(
    "INSERT INTO gate_runs (id, task_id, gate, round, args_json, machine_id, command_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
    id, t.id, a.gate, round, JSON.stringify(a.args ?? []), cfg.machineId, JSON.stringify(command), Date.now(),
  );
  ctx.db.run(
    'INSERT INTO task_events (task_id, ts, actor, kind, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
    t.id, Date.now(), actor, 'gate_run', JSON.stringify({ runId: id, gate: a.gate, round }),
  );
  ctx.bus.publish('tasks', 'changed', { id: t.id });
  const sent = sendToRunner(ctx, cfg.machineId, command as unknown as Record<string, unknown>);
  return { ...view(get(ctx, id)!), sent };
}

/** A run still `running` this long after it started never reported back (runner crash, or a longer outage). */
export const RUN_STALE_MS = 6 * 3600_000;

/** gates_status: re-sends a run still queued (the runner was away; it ignores a run it already has). Never the log. */
export function gateRunStatus(ctx: Ctx, runId: string, now = Date.now()): GateRunView & { sent?: boolean } {
  let r = get(ctx, runId);
  if (!r) throw new FactoryError(404, `unknown gate run ${runId}`);
  if (r.status === 'running' && now - (r.started_at ?? r.created_at) > RUN_STALE_MS) {
    ctx.db.run(
      "UPDATE gate_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
      `no report from the runner for ${Math.round(RUN_STALE_MS / 3600_000)} h; run the gate again`, now, runId,
    );
    r = get(ctx, runId)!;
  }
  if (r.status === 'queued') return { ...view(r), sent: sendToRunner(ctx, r.machine_id, JSON.parse(r.command_json)) };
  return view(r);
}

export function gateRunLog(ctx: Ctx, runId: string): string | null {
  return ctx.db.get<{ log: string | null }>('SELECT log FROM gate_runs WHERE id = ?', runId)?.log ?? null;
}

const tail = (s: string | undefined) => {
  if (!s) return null;
  if (s.length <= LOG_KEEP) return s;
  return `[… ${s.length - LOG_KEEP} characters dropped …]\n${s.slice(-LOG_KEEP)}`;
};

/** A runner's report. Only the machine the run was sent to may report; a finished run ignores later reports. */
export function applyGateReport(ctx: Ctx, machineId: string, runId: string, rep: GateReport): GateRunView {
  const r = get(ctx, runId);
  if (!r || r.machine_id !== machineId) throw new FactoryError(404, 'unknown gate run');
  if (r.status === 'done' || r.status === 'error') return view(r);
  const now = Date.now();
  if (rep.status === 'running') {
    ctx.db.run("UPDATE gate_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", now, runId);
  } else if (rep.status === 'done' && rep.verdict && ['pass', 'fail', 'skip'].includes(rep.verdict)) {
    const findings = (rep.findings ?? []).flatMap((f) => {
      const p = findingSchema.safeParse(f);
      return p.success ? [p.data] : [];
    });
    const summary = (rep.summary ?? '').slice(0, 20_000) || `${r.gate} ${rep.verdict}`;
    const details = { ...(rep.details !== undefined ? { details: rep.details } : {}), runId, exitCode: rep.exitCode ?? null };
    const base = { taskId: r.task_id, gate: r.gate, verdict: rep.verdict, summary, details, findings };
    let gate;
    try {
      gate = recordGate(ctx, { ...base, screenshots: (rep.shots ?? []).slice(0, 12) }, 'runner:gate', { round: r.round });
    } catch (e) {
      if (!(e instanceof FactoryError)) throw e;
      gate = recordGate(ctx, { ...base, summary: `${summary} (screenshots dropped: ${e.message})` }, 'runner:gate', { round: r.round });
    }
    ctx.db.run(
      `UPDATE gate_runs SET status = 'done', verdict = ?, summary = ?, findings_json = ?, gate_result_id = ?, exit_code = ?, log = ?,
       started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
      rep.verdict, summary, JSON.stringify(findings), gate.id, rep.exitCode ?? null, tail(rep.log), now, now, runId,
    );
  } else {
    ctx.db.run(
      `UPDATE gate_runs SET status = 'error', error = ?, summary = ?, exit_code = ?, log = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
      (rep.error ?? (rep.status === 'done' ? 'the runner gave no valid verdict' : 'error')).slice(0, 4000), rep.summary?.slice(0, 20_000) ?? null,
      rep.exitCode ?? null, tail(rep.log), now, now, runId,
    );
  }
  ctx.bus.publish('tasks', 'changed', { id: r.task_id });
  return view(get(ctx, runId)!);
}
