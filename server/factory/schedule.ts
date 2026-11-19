// Scheduled launches (SPEC §11.8): tasks_launch and coordinator_launch with notBefore, kept on the server so a restart
// of the PC (or of an agent's session) loses nothing. The tick starts each one at the first chance after its time,
// when every check passes again: the package is still gata, the runner is online (and, for hc, in a signed-in
// session), no live coordinator carries the same name, and the governor allows it (with its rule for scheduled
// starts on stale data). A check that fails leaves it waiting with the reason visible; past its window it is missed,
// and the owner is told once.
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { runnerInfo } from '../jobs/core.ts';
import { formatStartTime, type ScheduledLaunchView, type ScheduledStatus } from '../../shared/factory.ts';
import { scheduledGovernor } from './governor.ts';
import { planCoordinator, planWorker, start, type CoordinatorLaunch, type LaunchKind, type WorkerLaunch } from './launch.ts';
import { requireProject } from './projects.ts';
import { FactoryError } from './tasks.ts';

export const SCHEDULE_ACTOR = 'factory:schedule';
const SHOWN_CLOSED_MS = 7 * 24 * 3600_000;

interface Row {
  id: string; kind: LaunchKind; args_json: string; actor: string; token_id: string | null; decision_id: string | null; task_id: string | null; project: string | null;
  machine_id: string; title: string; launcher: 'hc' | 'claude'; not_before: number; expires_at: number; status: ScheduledStatus; waits: string | null;
  job_id: string | null; stale_start: number; created_at: number; updated_at: number; closed_at: number | null;
}

const machineName = (ctx: Ctx, id: string) => ctx.db.get<{ name: string }>('SELECT name FROM machines WHERE id = ?', id)?.name ?? null;

/** What a pending launch waits for: its start time until then, afterwards the last reason it did not start. */
export function waitsOf(r: Pick<Row, 'status' | 'not_before' | 'waits'>, now = Date.now()): string | null {
  if (r.status !== 'pending' && r.status !== 'starting') return r.waits;
  return r.not_before > now ? `start time ${formatStartTime(r.not_before)}` : (r.waits ?? 'the next tick');
}

function view(ctx: Ctx, r: Row, now: number): ScheduledLaunchView {
  const args = json<{ cwd?: string }>(r.args_json, {}) ?? {};
  return {
    id: r.id, kind: r.kind, status: r.status, taskId: r.task_id, project: r.project, title: r.title, machineId: r.machine_id, machineName: machineName(ctx, r.machine_id),
    cwd: args.cwd ?? '', launcher: r.launcher, notBefore: r.not_before, notBeforeText: formatStartTime(r.not_before), expiresAt: r.expires_at, waits: waitsOf(r, now),
    jobId: r.job_id, staleStart: r.stale_start === 1, decisionId: r.decision_id, actor: r.actor, createdAt: r.created_at, closedAt: r.closed_at,
  };
}

/** schedules_list and GET /api/scheduled-launches: pending first (soonest first), then those closed in the last 7 days. */
export function listScheduled(ctx: Ctx, f: { project?: string } = {}, now = Date.now()): ScheduledLaunchView[] {
  if (f.project) requireProject(ctx, f.project);
  const rows = ctx.db.all<Row>(
    `SELECT * FROM scheduled_launches WHERE (status IN ('pending', 'starting') OR closed_at > ?) ${f.project ? 'AND project = ?' : ''}
     ORDER BY status IN ('pending', 'starting') DESC, CASE WHEN status IN ('pending', 'starting') THEN not_before ELSE -closed_at END LIMIT 200`,
    now - SHOWN_CLOSED_MS, ...(f.project ? [f.project] : []),
  );
  return rows.map((r) => view(ctx, r, now));
}

/** Cancels a launch that has not started. `may(kind)` says whether the caller may (the web always may). */
export function cancelScheduled(ctx: Ctx, id: string, actor: string, may: (kind: LaunchKind) => boolean = () => true): ScheduledLaunchView {
  const r = ctx.db.get<Row>('SELECT * FROM scheduled_launches WHERE id = ?', id);
  if (!r) throw new FactoryError(404, `unknown scheduled launch ${id}`);
  if (!may(r.kind)) throw new FactoryError(403, `this agent token may not launch ${r.kind === 'worker' ? 'workers' : 'coordinators'}, so it may not cancel this launch either`);
  const now = Date.now();
  if (ctx.db.run("UPDATE scheduled_launches SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'", now, now, id).changes !== 1) {
    throw new FactoryError(409, `this scheduled launch is already ${r.status}`);
  }
  ctx.db.audit(actor, 'launch_schedule_cancel', r.task_id ?? id, { id, kind: r.kind });
  ctx.bus.publish('jobs', 'scheduled', { id });
  return view(ctx, ctx.db.get<Row>('SELECT * FROM scheduled_launches WHERE id = ?', id)!, now);
}

/** Why a due launch cannot start now, or null. */
/** A coordinator session with the same name blocks a scheduled one only when it was heard from this recently. */
export const LIVE_SESSION_MS = 60 * 60_000;

function blocker(ctx: Ctx, r: Row, now: number): string | null {
  const name = machineName(ctx, r.machine_id) ?? r.machine_id;
  if (r.kind === 'worker') {
    const t = ctx.db.get<{ status: string; archived_at: number | null }>('SELECT status, archived_at FROM tasks WHERE id = ?', r.task_id);
    if (!t) return 'the package was deleted';
    if (t.archived_at != null) return 'the package is archived';
    if (t.status !== 'gata') return `the package is ${t.status}, not gata`;
  }
  if (!ctx.runners.has(r.machine_id)) return `runner offline on ${name}`;
  // hc starts an interactive terminal: a runner started at boot, before anyone signed in, cannot (§11.8)
  const info = runnerInfo(ctx, r.machine_id) as { interactiveSession?: unknown; platform?: unknown } | null;
  if (r.launcher === 'hc' && info?.platform === 'win32' && info.interactiveSession !== true) {
    return info.interactiveSession === false
      ? `no signed-in Windows session on ${name} (an hc launch needs one; launcher claude does not)`
      : `the runner on ${name} has not said yet whether it runs in a signed-in Windows session (an hc launch needs one)`;
  }
  if (r.kind === 'coordinator') {
    // a session killed by a restart never sends SessionEnd: only one heard from in the last hour counts as live
    const live = ctx.db.get(
      `SELECT 1 FROM sessions WHERE machine_id = ? AND name = ? AND ended_at IS NULL AND last_event_at > ?
       UNION ALL SELECT 1 FROM jobs WHERE machine_id = ? AND title = ? AND status IN ('queued', 'starting', 'running') LIMIT 1`,
      r.machine_id, r.title, now - LIVE_SESSION_MS, r.machine_id, r.title,
    );
    if (live) return `a session named "${r.title}" is already live on ${name}`;
  }
  return null;
}

const setWaits = (ctx: Ctx, r: Row, waits: string, now: number) => {
  if (r.waits === waits) return;
  ctx.db.run("UPDATE scheduled_launches SET waits = ?, updated_at = ? WHERE id = ? AND status = 'pending'", waits, now, r.id);
  ctx.bus.publish('jobs', 'scheduled', { id: r.id });
};

function missed(ctx: Ctx, r: Row, now: number) {
  if (ctx.db.run("UPDATE scheduled_launches SET status = 'missed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'", now, now, r.id).changes !== 1) return;
  const why = r.waits ? ` It waited for: ${r.waits}.` : '';
  ctx.db.audit(SCHEDULE_ACTOR, 'launch_schedule_missed', r.task_id ?? r.id, { id: r.id, kind: r.kind, notBefore: r.not_before, expiresAt: r.expires_at, waits: r.waits });
  ctx.notify({
    type: 'factory',
    title: `Scheduled start missed: ${r.title}`.slice(0, 120),
    body: `Planned for ${formatStartTime(r.not_before)}, it did not start by ${formatStartTime(r.expires_at)}.${why}`,
    url: '/jobs#schedules',
  });
  ctx.bus.publish('jobs', 'scheduled', { id: r.id });
}

/**
 * The tick (every 15 s, and once at start): starts each due launch whose checks pass, marks missed the ones past their
 * window. Returns the started job ids. The status moves pending → starting with a conditional update, so two ticks
 * that race start a launch once.
 */
export function fireScheduledLaunches(ctx: Ctx, now = Date.now()): string[] {
  const out: string[] = [];
  for (const r of ctx.db.all<Row>("SELECT * FROM scheduled_launches WHERE status = 'pending' AND not_before <= ? ORDER BY not_before, created_at", now)) {
    try {
      if (now > r.expires_at) {
        missed(ctx, r, now);
        continue;
      }
      const why = blocker(ctx, r, now);
      if (why) {
        setWaits(ctx, r, why, now);
        continue;
      }
      const g = scheduledGovernor(ctx, now);
      if (!g.canStart) {
        setWaits(ctx, r, `governor: ${g.reason}`, now);
        continue;
      }
      const stale = g.reason.startsWith('started on stale usage data');
      let jobId: string | null = null;
      try {
        // the launch's own checks (cwd, options, project paused…) first, then one transaction: claimed, started, recorded
        const args = json<WorkerLaunch & CoordinatorLaunch>(r.args_json, null)!;
        const p = r.kind === 'worker' ? planWorker(ctx, args) : planCoordinator(ctx, args, r.actor);
        jobId = ctx.db.tx(() => {
          if (ctx.db.run("UPDATE scheduled_launches SET status = 'starting', updated_at = ? WHERE id = ? AND status = 'pending'", now, r.id).changes !== 1) return null;
          const id = start(ctx, p, r.actor, r.decision_id);
          ctx.db.run(
            "UPDATE scheduled_launches SET status = 'started', job_id = ?, waits = NULL, stale_start = ?, closed_at = ?, updated_at = ? WHERE id = ?",
            id, stale ? 1 : 0, now, now, r.id,
          );
          ctx.db.audit(SCHEDULE_ACTOR, 'launch_schedule_started', r.task_id ?? r.id, { id: r.id, jobId: id, kind: r.kind, governor: g.reason });
          if (stale) ctx.db.audit(SCHEDULE_ACTOR, 'governor_stale_start', r.task_id ?? r.id, { id: r.id, jobId: id, reason: g.reason });
          return id;
        });
      } catch (e) {
        if (!(e instanceof FactoryError)) throw e;
        // nothing was kept (the transaction rolled back): it waits, and is missed if that never changes
        setWaits(ctx, r, e.message.slice(0, 500), now);
      }
      ctx.bus.publish('jobs', 'scheduled', { id: r.id });
      if (jobId) out.push(jobId);
    } catch (e) {
      console.error('[schedule]', r.id, (e as Error).message);
    }
  }
  return out;
}

/** factory_status and the digest: launches missed since `since`. */
export function missedSince(ctx: Ctx, since: number): { id: string; title: string; notBefore: number; waits: string | null }[] {
  return ctx.db
    .all<{ id: string; title: string; not_before: number; waits: string | null }>(
      "SELECT id, title, not_before, waits FROM scheduled_launches WHERE status = 'missed' AND closed_at > ? ORDER BY closed_at LIMIT 20", since,
    )
    .map((r) => ({ id: r.id, title: r.title, notBefore: r.not_before, waits: r.waits }));
}
