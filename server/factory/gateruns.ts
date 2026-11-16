// Gates and kit steps as runner jobs (SPEC §11.7, §12.4). gates_run and steps_run send a run to the runner of the
// package's project (its machine, §12.1); the runner reads the project's line file from the trusted main checkout and
// runs the line's argv steps for it, else the kit's built-in, and reports back (POST /api/runner/gates/:id). The
// server sends data only (ids, the package, earlier findings, files under `.factory/`), never commands. A gate's verdict
// is recorded as a gate result with its round and findings; a kit step (prepare, qa, cleanup, revert) only finishes its
// run, with a task_events row. The log stays on the server and never goes to an agent.
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { runnerInfo, sendToRunner } from '../jobs/core.ts';
import {
  KIT_RUNNER_VERSION, findingSchema, isGate, type FindingInput, type GateCommand, type GateReport, type GateRunStatus, type GateRunView, type StepFile, type StepName,
  type TaskResources, type Verdict,
} from '../../shared/factory.ts';
import { compareVersions, localIdOf, projectRow, storeProjectLine, usesBuiltIn } from './projects.ts';
import { FactoryError, recordGate, taskEvent, taskVars, type TaskRow } from './tasks.ts';

/** The server keeps the tail of a gate's log. */
export const LOG_KEEP = 256 * 1024;

type Row = {
  id: string; task_id: string; gate: StepName; round: number; args_json: string; machine_id: string; command_json: string; status: GateRunStatus; verdict: Verdict | null;
  summary: string | null; findings_json: string | null; gate_result_id: number | null; exit_code: number | null; error: string | null; log: string | null; details_json: string | null;
  created_at: number; started_at: number | null; finished_at: number | null;
};

const COLS = `id, task_id, gate, round, args_json, machine_id, command_json, status, verdict, summary, findings_json, gate_result_id, exit_code, error, details_json,
  LENGTH(CAST(log AS BLOB)) log, created_at, started_at, finished_at`;

const view = (r: Row): GateRunView => ({
  id: r.id, taskId: r.task_id, gate: r.gate, round: r.round, args: json<string[]>(r.args_json, []) ?? [], machineId: r.machine_id, status: r.status,
  verdict: r.verdict, summary: r.summary, findings: json<FindingInput[]>(r.findings_json, []) ?? [], gateResultId: r.gate_result_id, exitCode: r.exit_code,
  error: r.error, details: json(r.details_json, null), logBytes: Number(r.log ?? 0), createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});

const get = (ctx: Ctx, id: string) => ctx.db.get<Row>(`SELECT ${COLS} FROM gate_runs WHERE id = ?`, id);

export function listGateRuns(ctx: Ctx, taskId: string, limit = 50): GateRunView[] {
  return ctx.db.all<Row>(`SELECT ${COLS} FROM gate_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`, taskId, limit).map(view);
}

/** One run: gates_status's view without the re-send (the conductor polls this). */
export function gateRunView(ctx: Ctx, runId: string): GateRunView | null {
  const r = get(ctx, runId);
  return r ? view(r) : null;
}

export { compareVersions };

const FILE_RE = /^(?:\.factory\/)?[\w.-]+(?:\/[\w.-]+)*$/;

/** Files for `.factory/`: relative paths of letters, digits and . _ - (no `..`), text of at most 1 MB, 50 at most. */
export function checkStepFiles(files: unknown): StepFile[] {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.length > 50) throw new FactoryError(400, 'files: at most 50 { path, content }');
  return files.map((f) => {
    const path = (f as StepFile)?.path;
    const content = (f as StepFile)?.content;
    if (typeof path !== 'string' || !FILE_RE.test(path) || path.split('/').some((s) => /^\.+$/.test(s))) throw new FactoryError(400, `file ${JSON.stringify(path)}: a path under .factory/ (letters, digits, . _ -), never outside it`);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new FactoryError(400, `file ${path}: text of at most 1 MB`);
    return { path, content };
  });
}

/** The range of the package's last G5 pass (for revert without args). */
function lastIntegration(ctx: Ctx, taskId: string): string | null {
  const rows = ctx.db.all<{ details_json: string | null }>("SELECT details_json FROM gate_runs WHERE task_id = ? AND gate = 'G5' AND status = 'done' AND verdict = 'pass' ORDER BY finished_at DESC LIMIT 5", taskId);
  for (const r of rows) {
    const range = json<{ range?: unknown }>(r.details_json, null)?.range;
    if (typeof range === 'string' && /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/i.test(range)) return range;
  }
  return null;
}

export interface StepRunArgs {
  taskId: string;
  step: StepName;
  args?: string[];
  /** written under <worktree>/.factory/ by the runner (the conductor sends the worker's brief this way) */
  files?: StepFile[];
}

/**
 * Starts a gate or kit step on the project's runner: gates_run, steps_run and the conductor. The command carries the
 * package, its resources, the earlier open G3 findings (G3 from round 2) and the files, never a command line. A run that
 * needs a built-in is refused on a runner that reported a version before 0.2.0.
 */
export function startStepRun(ctx: Ctx, a: StepRunArgs, actor: string): GateRunView & { sent: boolean } {
  const t = ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', a.taskId);
  if (!t) throw new FactoryError(404, `unknown task ${a.taskId}`);
  const p = projectRow(ctx, t.project);
  if (!p) throw new FactoryError(400, `${a.taskId} belongs to no factory project (repo ${t.repo ?? '(none)'}); set its repo up in Settings → Factory`);
  if (!p.machine_id || !p.checkout || !p.line_file) throw new FactoryError(400, `project ${p.key}: it needs a machine, the main checkout and the line file (the recipe path)`);
  if (!ctx.db.get('SELECT 1 FROM machines WHERE id = ? AND revoked = 0', p.machine_id)) throw new FactoryError(400, `project ${p.key}: unknown machine ${p.machine_id}`);
  const version = runnerInfo(ctx, p.machine_id)?.version;
  if (usesBuiltIn(p, a.step) && typeof version === 'string' && compareVersions(version, KIT_RUNNER_VERSION) < 0) {
    throw new FactoryError(409, `the runner on machine ${p.machine_id} is version ${version}; the kit's built-in ${a.step} needs ${KIT_RUNNER_VERSION} or later: update that checkout and restart \`bb runner\` there`);
  }
  let args = a.args ?? [];
  if (a.step === 'revert' && !args.length) {
    const range = lastIntegration(ctx, t.id);
    if (!range) throw new FactoryError(400, `no G5 integration of ${t.id} is known: give the range as args ["<old>..<new>"]`);
    args = [range];
  }
  const files = checkStepFiles(a.files);
  const id = randomUUID();
  const round = Math.max(1, t.round);
  const resources: TaskResources | null =
    t.res_port == null && t.res_db == null && t.res_mig_from == null
      ? null
      : { port: t.res_port, db: t.res_db, migrations: t.res_mig_from != null && t.res_mig_to != null ? { from: t.res_mig_from, to: t.res_mig_to } : null };
  const findings =
    a.step === 'G3' && round >= 2
      ? ctx.db
          .all<{ severity: FindingInput['severity']; title: string; file: string | null; line: number | null; detail: string | null; fix: string | null }>(
            "SELECT severity, title, file, line, detail, fix FROM findings WHERE task_id = ? AND gate = 'G3' AND status = 'open' AND severity IN ('blocker', 'major') ORDER BY id LIMIT 50", t.id,
          )
          .map((f) => ({ severity: f.severity, title: f.title, ...(f.file ? { file: f.file } : {}), ...(f.line != null ? { line: f.line } : {}), ...(f.detail ? { detail: f.detail.slice(0, 2000) } : {}), ...(f.fix ? { fix: f.fix.slice(0, 2000) } : {}) }))
      : [];
  const command: GateCommand = {
    type: 'gate',
    run: {
      id, taskId: t.id, gate: a.step, round, args, checkout: p.checkout, recipe: p.line_file, vars: taskVars(t, p), project: p.key,
      task: { id: t.id, localId: localIdOf(t.id, p.id_prefix), title: t.title, body: t.body, acceptance: json<string[]>(t.acceptance_json, []) ?? [], sensitive: !!t.sensitive, branch: t.branch },
      resources,
      ...(findings.length ? { findings } : {}),
      ...(files.length ? { files } : {}),
    },
  };
  ctx.db.run(
    "INSERT INTO gate_runs (id, task_id, gate, round, args_json, machine_id, command_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
    id, t.id, a.step, round, JSON.stringify(args), p.machine_id, JSON.stringify(command), Date.now(),
  );
  taskEvent(ctx, t.id, actor, isGate(a.step) ? 'gate_run' : 'step_run', null, null, isGate(a.step) ? { runId: id, gate: a.step, round } : { runId: id, step: a.step, round });
  ctx.bus.publish('tasks', 'changed', { id: t.id });
  const sent = sendToRunner(ctx, p.machine_id, command as unknown as Record<string, unknown>);
  return { ...view(get(ctx, id)!), sent };
}

/** gates_run (§11.7): a gate, now with the richer command of §12.4. */
export function startGateRun(ctx: Ctx, a: { taskId: string; gate: StepName; args?: string[] }, actor: string): GateRunView & { sent: boolean } {
  return startStepRun(ctx, { taskId: a.taskId, step: a.gate, args: a.args }, actor);
}

/** A run still `running` this long after it started never reported back (runner crash, or a longer outage). */
export const RUN_STALE_MS = 6 * 3600_000;

/** gates_status: any run, gate or step. Re-sends a run still queued (the runner was away; it ignores a run it already has). Never the log. */
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

const detailsText = (d: unknown) => {
  if (d === undefined) return null;
  const s = JSON.stringify(d);
  return s.length > 200_000 ? JSON.stringify({ truncated: true }) : s;
};

/** A runner's report. Only the machine the run was sent to may report; a finished run ignores later reports. */
export function applyGateReport(ctx: Ctx, machineId: string, runId: string, rep: GateReport): GateRunView {
  const r = get(ctx, runId);
  if (!r || r.machine_id !== machineId) throw new FactoryError(404, 'unknown gate run');
  if (r.status === 'done' || r.status === 'error') return view(r);
  const now = Date.now();
  // the resolved line a prepare carries (or why it did not resolve) is kept on the project (§12.3)
  if (rep.line !== undefined || rep.lineError !== undefined) {
    const key = ctx.db.get<{ project: string | null }>('SELECT project FROM tasks WHERE id = ?', r.task_id)?.project;
    if (key) storeProjectLine(ctx, key, rep.line ?? null, rep.line ? null : (rep.lineError ?? null));
  }
  const gate = isGate(r.gate) ? r.gate : null;
  if (rep.status === 'running') {
    ctx.db.run("UPDATE gate_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", now, runId);
  } else if (rep.status === 'done' && rep.verdict && ['pass', 'fail', 'skip'].includes(rep.verdict)) {
    const findings = (rep.findings ?? []).flatMap((f) => {
      const p = findingSchema.safeParse(f);
      return p.success ? [p.data] : [];
    });
    const summary = (rep.summary ?? '').slice(0, 20_000) || `${r.gate} ${rep.verdict}`;
    let gateResultId: number | null = null;
    if (gate) {
      const details = { ...(rep.details !== undefined ? { details: rep.details } : {}), runId, exitCode: rep.exitCode ?? null };
      const base = { taskId: r.task_id, gate, verdict: rep.verdict, summary, details, findings };
      let g;
      try {
        g = recordGate(ctx, { ...base, screenshots: (rep.shots ?? []).slice(0, 12) }, 'runner:gate', { round: r.round });
      } catch (e) {
        if (!(e instanceof FactoryError)) throw e;
        g = recordGate(ctx, { ...base, summary: `${summary} (screenshots dropped: ${e.message})` }, 'runner:gate', { round: r.round });
      }
      gateResultId = g.id;
    } else {
      // a kit step: no gate result, no round; its history row
      taskEvent(ctx, r.task_id, 'runner:step', 'step', null, null, { runId, step: r.gate, verdict: rep.verdict, summary: summary.slice(0, 1000) });
    }
    ctx.db.run(
      `UPDATE gate_runs SET status = 'done', verdict = ?, summary = ?, findings_json = ?, gate_result_id = ?, exit_code = ?, details_json = ?, log = ?,
       started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
      rep.verdict, summary, JSON.stringify(findings), gateResultId, rep.exitCode ?? null, detailsText(rep.details), tail(rep.log), now, now, runId,
    );
  } else {
    const error = (rep.error ?? (rep.status === 'done' ? 'the runner gave no valid verdict' : 'error')).slice(0, 4000);
    ctx.db.run(
      `UPDATE gate_runs SET status = 'error', error = ?, summary = ?, exit_code = ?, log = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
      error, rep.summary?.slice(0, 20_000) ?? null, rep.exitCode ?? null, tail(rep.log), now, now, runId,
    );
    if (!gate) taskEvent(ctx, r.task_id, 'runner:step', 'step', null, null, { runId, step: r.gate, error: error.slice(0, 1000) });
  }
  ctx.bus.publish('tasks', 'changed', { id: r.task_id });
  return view(get(ctx, runId)!);
}
