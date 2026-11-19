// Starting agents on a runner (SPEC §11.4): a worker for a backlog package, or a coordinator. One path for the PWA
// (POST /api/tasks/:id/launch) and for agents (tasks_launch, coordinator_launch), so both get the same checks: the
// runner's allowed roots, the validated options (and so the checked argv), and the claim on the package.
// Agents also need their token's permission (off by default), the governor's canStart and, when the owner asked for it,
// the owner's approval through a decision: the first call asks, a later call with the same arguments launches.
import { createHash, randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { checkOptions, OptionError, type StoredJobOptions } from '../../runner/options.ts';
import { createJob, JobError, runnerInfo, under, type NewJob } from '../jobs/core.ts';
import { CATCH_UP_HOURS, formatStartTime, type LaunchResult, type LaunchScope, type MachineView, type TaskDetail, type ToolArgs } from '../../shared/factory.ts';
import { askDecision, getDecision } from './decisions.ts';
import { governor } from './governor.ts';
import { FactoryError, getTask, startTimeArg, updateTask } from './tasks.ts';
import { projectBlocks, projectRow } from './projects.ts';

export type LaunchKind = 'worker' | 'coordinator';

interface LaunchBase {
  machineId: string;
  cwd: string;
  launcher?: 'hc' | 'claude';
  promptId?: number | null;
  model?: string | null;
  permissionMode?: string | null;
  maxBudgetUsd?: number | null;
}
export interface WorkerLaunch extends LaunchBase {
  taskId: string;
  /** the conductor's one-line launch prompt (§12.5: the brief is in .factory/brief.md); wins over promptId */
  promptText?: string | null;
  /** a claude -p worker's time limit */
  limitMinutes?: number | null;
}
export interface CoordinatorLaunch extends LaunchBase { prompt?: string | null; title?: string | null }

/** How long an approved launch may still be started: the agent comes back within a loop or two, not days later. */
export const APPROVAL_TTL_MS = 24 * 3600_000;
const APPROVE = /^(launch|yes|approve|approved|ok|go)[.!]*$/i;

/** The prompt text for a package without a prompt of its own: built from its title, body and acceptance criteria. */
export function taskPrompt(t: TaskDetail): string {
  const lines = [`# ${t.title}`, '', `Backlog package ${t.id}${t.repo ? ` in ${t.repo}` : ''}${t.branch ? `, branch ${t.branch}` : ''}.`];
  if (t.body.trim()) lines.push('', t.body.trim());
  if (t.acceptance.length) lines.push('', '## Acceptance criteria', ...t.acceptance.map((a) => `- ${a}`));
  return lines.join('\n');
}

/** The first prompt of a coordinator started without one of its own. */
export function coordinatorPrompt(by: string): string {
  return [
    '# Buildyboy coordinator',
    '',
    `You are the coordinator of the Buildyboy software factory, started by ${by}. You drive it through the buildyboy MCP tools.`,
    '',
    '1. Call docs_get (topic "start") once, then run the coordinator loop it describes, again and again.',
    '2. Start nothing new while governor_get says canStart is false; stop the factory when it says stopAll.',
    '3. Handle control_get requests first. Ask the owner with decision_ask when only they can decide.',
    '4. When you stop, say why with digest_post.',
    '',
    'If the buildyboy tools are not available in this session, say so and stop.',
  ].join('\n');
}

const asFactory = (e: unknown): never => {
  if (e instanceof JobError) throw new FactoryError(e.status, e.message);
  if (e instanceof OptionError) throw new FactoryError(400, e.message);
  throw e;
};

export interface Plan {
  kind: LaunchKind;
  job: NewJob;
  options: StoredJobOptions;
  machineName: string;
  task: TaskDetail | null;
  /** a line for the approval question: which prompt it starts with */
  promptNote: string;
}

/** Everything that can be checked before anything starts. Throws FactoryError. */
function checkBase(ctx: Ctx, a: LaunchBase, extra: Partial<StoredJobOptions>): { machineName: string; options: StoredJobOptions } {
  const m = ctx.db.get<{ name: string }>('SELECT name FROM machines WHERE id = ? AND revoked = 0', a.machineId);
  if (!m) throw new FactoryError(400, `unknown machine ${a.machineId}`);
  const roots = runnerInfo(ctx, a.machineId)?.allowedRoots ?? [];
  if (roots.length && !roots.some((r) => under(a.cwd, r))) throw new FactoryError(400, `cwd is outside the runner's allowed roots: ${a.cwd}`);
  if (a.promptId != null && !ctx.db.get('SELECT 1 FROM prompts WHERE id = ?', a.promptId)) throw new FactoryError(400, `unknown prompt ${a.promptId}`);
  let options: StoredJobOptions;
  try {
    options = checkOptions({
      maxBudgetUsd: a.maxBudgetUsd ?? 5, model: a.model || undefined, permissionMode: a.permissionMode || undefined, launcher: a.launcher ?? 'hc', ...extra,
    });
  } catch (e) {
    return asFactory(e);
  }
  return { machineName: m.name, options };
}

/** `scheduling`: checked now for a launch that starts later (§11.8), whose own start time the package then carries. */
export function planWorker(ctx: Ctx, a: WorkerLaunch, scheduling = false): Plan {
  const task = getTask(ctx, a.taskId);
  if (task.status === 'integrata') throw new FactoryError(409, 'this package is already integrated');
  if (task.archivedAt != null) throw new FactoryError(409, 'this package is archived');
  if (scheduling && task.status !== 'gata') throw new FactoryError(409, `only a gata package can be scheduled: ${task.id} is ${task.status}`);
  if (!scheduling && (task.status === 'gata' || task.status === 'backlog') && task.notBefore != null && task.notBefore > Date.now()) {
    throw new FactoryError(409, `${task.id} has a start time: not before ${formatStartTime(task.notBefore)}; clear it to start earlier, or schedule the launch with notBefore`);
  }
  const blocked = projectBlocks(projectRow(ctx, task.project)); // §12.1: nothing starts in a paused or archived project
  if (blocked) throw new FactoryError(409, blocked);
  const { machineName, options } = checkBase(ctx, a, { taskId: task.id, ...(a.limitMinutes ? { limitMinutes: a.limitMinutes } : {}) });
  const own = a.promptText?.trim() || null;
  const promptId = own ? null : (a.promptId ?? (task.promptId && ctx.db.get('SELECT 1 FROM prompts WHERE id = ?', task.promptId) ? task.promptId : null));
  return {
    kind: 'worker',
    job: { machineId: a.machineId, cwd: a.cwd, promptId, promptText: own ?? (promptId ? null : taskPrompt(task)), title: `${task.id}: ${task.title}`.slice(0, 200), options },
    options,
    machineName,
    task,
    promptNote: own ? `its own: ${own.slice(0, 200)}` : promptId ? `saved prompt #${promptId}` : 'built from the package (title, body, acceptance criteria)',
  };
}

/** A prompt as a Markdown quote for the approval question, cut to what a phone shows. */
function quote(text: string): string {
  const t = text.trim();
  return `\n\n${t.slice(0, 1500).split('\n').map((l) => `> ${l}`).join('\n')}${t.length > 1500 ? '\n> …' : ''}`;
}

export function planCoordinator(ctx: Ctx, a: CoordinatorLaunch, actor: string): Plan {
  const { machineName, options } = checkBase(ctx, a, { role: 'coordonator' });
  const own = a.prompt?.trim() || null;
  // the prompt is all a coordinator is told: the owner sees it before approving
  const saved = !own && a.promptId != null ? ctx.db.get<{ rendered: string }>('SELECT rendered FROM prompts WHERE id = ?', a.promptId)?.rendered ?? '' : '';
  return {
    kind: 'coordinator',
    job: {
      machineId: a.machineId,
      cwd: a.cwd,
      promptId: own ? null : a.promptId ?? null,
      promptText: own ?? (a.promptId != null ? null : coordinatorPrompt(actor)),
      title: a.title?.trim() || 'Coordinator',
      options,
    },
    options,
    machineName,
    task: null,
    promptNote: own ? `its own:${quote(own)}` : a.promptId != null ? `saved prompt #${a.promptId}:${quote(saved)}` : 'the built-in coordinator prompt',
  };
}

/** Creates the job; a worker launch also claims the package. Recorded in the audit log under `actor`. */
export function start(ctx: Ctx, p: Plan, actor: string, decisionId: string | null): string {
  let jobId: string;
  try {
    jobId = createJob(ctx, p.job);
  } catch (e) {
    return asFactory(e);
  }
  const detail = { jobId, machineId: p.job.machineId, cwd: p.job.cwd, launcher: p.options.launcher, ...(decisionId ? { decisionId } : {}) };
  if (p.task) {
    // launching is claiming: tasks_claim must not hand the same package to another worker meanwhile
    updateTask(ctx, { id: p.task.id, ...(p.task.status === 'in_lucru' ? {} : { status: 'in_lucru' as const }) }, 'launch', { jobId, claimedBy: p.task.claimedBy ?? actor });
    ctx.db.audit(actor, 'task_launch', p.task.id, detail);
  } else {
    ctx.db.audit(actor, 'coordinator_launch', jobId, detail);
  }
  return jobId;
}

/** POST /api/tasks/:id/launch: the owner starts a package from the PWA. */
export function launchWorker(ctx: Ctx, a: WorkerLaunch, actor: string): { jobId: string; launcher: 'hc' | 'claude' } {
  const p = planWorker(ctx, a);
  return { jobId: start(ctx, p, actor, null), launcher: p.options.launcher ?? 'claude' };
}

// ---------- agents ----------

export function launchScope(ctx: Ctx, tokenId: string | null): { scope: LaunchScope; approval: boolean } {
  const t = tokenId ? ctx.db.get<{ launch: string; launch_approval: number }>('SELECT launch, launch_approval FROM agent_tokens WHERE id = ? AND revoked_at IS NULL', tokenId) : null;
  const scope: LaunchScope = t?.launch === 'workers' || t?.launch === 'all' ? t.launch : 'off';
  return { scope, approval: t ? t.launch_approval !== 0 : true };
}

/** The same launch always gives the same key, whichever optional arguments were spelled out. */
function argsKey(kind: LaunchKind, a: WorkerLaunch | CoordinatorLaunch, at: Schedule | null): string {
  const w = a as Partial<WorkerLaunch>;
  const c = a as Partial<CoordinatorLaunch>;
  const norm = [
    kind, w.taskId ?? null, a.machineId, a.cwd, a.launcher ?? 'hc', a.model || null, a.permissionMode || null, a.maxBudgetUsd ?? 5, a.promptId ?? null,
    c.prompt?.trim() || null, c.title?.trim() || null,
    // an approved immediate launch does not approve a scheduled one, nor one at another time
    ...(at ? [at.notBefore, at.expiresAt - at.notBefore] : []),
  ];
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

function approvalQuestion(p: Plan, actor: string, at: Schedule | null): { question: string; context: string } {
  const what = p.task ? `a worker for ${p.task.id}` : 'a coordinator';
  const when = at ? ` at ${formatStartTime(at.notBefore)}` : '';
  const o = p.options;
  const lines = [
    `**${actor}** asks to start ${what}${p.task ? ` (${p.task.title})` : ''}.`,
    '',
    `- Machine: ${p.machineName}`,
    `- Folder: \`${p.job.cwd}\``,
    `- Launcher: ${o.launcher === 'hc' ? 'interactive claude in a herdr terminal' : `claude -p job, budget $${o.maxBudgetUsd}`}`,
    `- Model: ${o.model ?? 'default'}`,
    `- Permission mode: ${o.permissionMode ?? 'default'}`,
    `- Prompt: ${p.promptNote}`,
    ...(at ? [`- Starts: at the first chance after ${formatStartTime(at.notBefore)}, at the latest by ${formatStartTime(at.expiresAt)} (the server starts it then; nobody is asked again)`] : []),
    '',
    `Answer **Launch** to allow it. Nothing ${at ? 'is scheduled' : 'starts'} until the agent calls again; an approval holds for ${APPROVAL_TTL_MS / 3600_000} hours.`,
  ];
  return { question: `Start ${what} on ${p.machineName}${when}?`, context: lines.join('\n') };
}

/**
 * tasks_launch and coordinator_launch. Order: the token's permission, the launch's own checks (so the owner is never
 * asked about a launch that would fail), the governor, then the approval when the token needs one.
 */
export function agentLaunch(ctx: Ctx, kind: LaunchKind, a: ToolArgs<'tasks_launch'> | ToolArgs<'coordinator_launch'>, actor: string, tokenId: string | null): LaunchResult {
  const { db } = ctx;
  const { scope, approval } = launchScope(ctx, tokenId);
  if (scope === 'off' || (kind === 'coordinator' && scope !== 'all')) {
    throw new FactoryError(403, `this agent token may not launch ${kind === 'worker' ? 'workers' : 'coordinators'}: the owner allows it in Settings → Factory → Agent tokens`);
  }
  const at = scheduleOf(a);
  const p = kind === 'worker' ? planWorker(ctx, a as WorkerLaunch, !!at) : planCoordinator(ctx, a as CoordinatorLaunch, actor);
  if (at && p.task && db.get("SELECT 1 FROM scheduled_launches WHERE task_id = ? AND status IN ('pending', 'starting')", p.task.id)) {
    throw new FactoryError(409, `${p.task.id} already has a scheduled launch: schedules_list shows it, schedule_cancel cancels it`);
  }
  // a scheduled launch meets the governor at its start time, not now
  const g = at ? null : governor(ctx);
  if (g && !g.canStart) throw new FactoryError(409, `governor: ${g.reason}`);

  let approved: { id: string; decision_id: string } | null = null;
  if (approval) {
    const key = argsKey(kind, a as WorkerLaunch | CoordinatorLaunch, at);
    const close = (id: string, status: 'refused' | 'expired') => db.run('UPDATE launch_requests SET status = ?, closed_at = ? WHERE id = ?', status, Date.now(), id);
    const ask = (): LaunchResult => {
      const asked = askDecision(ctx, { ...approvalQuestion(p, actor, at), options: ['Launch', 'Refuse'], taskId: p.task?.id }, actor, tokenId);
      db.run(
        'INSERT INTO launch_requests (id, token_id, kind, task_id, args_key, decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomUUID(), tokenId, kind, p.task?.id ?? null, key, asked.id, Date.now(),
      );
      db.audit(actor, 'launch_approval_asked', p.task?.id ?? null, { kind, decisionId: asked.id, machineId: p.job.machineId, cwd: p.job.cwd });
      return { status: 'pending_approval', kind, decisionId: asked.id, answer: null, reason: 'the owner must approve this launch: call again with the same arguments once decision_get shows the answer' };
    };
    const req = db.get<{ id: string; decision_id: string }>(
      "SELECT id, decision_id FROM launch_requests WHERE token_id = ? AND args_key = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", tokenId, key,
    );
    if (!req) return ask();
    const d = getDecision(ctx, req.decision_id);
    if (d?.status === 'pending') {
      return { status: 'pending_approval', kind, decisionId: d.id, answer: null, reason: 'waiting for the owner: call again with the same arguments once decision_get shows the answer' };
    }
    if (!d || d.status === 'cancelled' || !APPROVE.test((d.answer ?? '').trim())) {
      close(req.id, 'refused');
      db.audit(actor, 'launch_refused', p.task?.id ?? null, { kind, decisionId: req.decision_id, answer: d?.answer ?? null });
      return { status: 'refused', kind, decisionId: req.decision_id, answer: d?.answer ?? null, reason: d?.status === 'cancelled' ? 'the owner cancelled the question' : 'the owner did not approve this launch' };
    }
    if ((d.answeredAt ?? 0) < Date.now() - APPROVAL_TTL_MS) {
      close(req.id, 'expired');
      return ask();
    }
    approved = req;
  }

  if (at) {
    const out = scheduleLaunch(ctx, kind, a, p, at, actor, tokenId, approved?.decision_id ?? null);
    if (approved) db.run("UPDATE launch_requests SET status = 'launched', closed_at = ? WHERE id = ?", Date.now(), approved.id);
    return out;
  }
  const jobId = start(ctx, p, actor, approved?.decision_id ?? null);
  if (approved) db.run("UPDATE launch_requests SET status = 'launched', job_id = ?, closed_at = ? WHERE id = ?", jobId, Date.now(), approved.id);
  return { status: 'launched', kind, jobId, launcher: p.options.launcher ?? 'claude', machineId: p.job.machineId, cwd: p.job.cwd, taskId: p.task?.id ?? null, decisionId: approved?.decision_id ?? null };
}

// ---------- scheduled launches (§11.8): kept here, started by server/factory/schedule.ts ----------

interface Schedule { notBefore: number; expiresAt: number }

function scheduleOf(a: ToolArgs<'tasks_launch'> | ToolArgs<'coordinator_launch'>): Schedule | null {
  if (a.notBefore === undefined) {
    if (a.catchUpHours !== undefined) throw new FactoryError(400, 'catchUpHours goes with notBefore');
    return null;
  }
  const notBefore = startTimeArg(a.notBefore)!;
  // a time already past would make an immediate launch that skips the governor's usual rule
  if (notBefore < Date.now() - 60_000) throw new FactoryError(400, `notBefore ${formatStartTime(notBefore)} is in the past: launch without notBefore to start now`);
  return { notBefore, expiresAt: notBefore + Math.round((a.catchUpHours ?? CATCH_UP_HOURS.default) * 3600_000) };
}

/**
 * Keeps the launch on the server; the tick starts it. A worker's package gets the same start time, so neither a claim
 * nor the autopilot takes it before then.
 */
function scheduleLaunch(
  ctx: Ctx, kind: LaunchKind, a: ToolArgs<'tasks_launch'> | ToolArgs<'coordinator_launch'>, p: Plan, at: Schedule, actor: string, tokenId: string | null, decisionId: string | null,
): LaunchResult {
  const { notBefore: _n, catchUpHours: _c, ...args } = a;
  const id = randomUUID();
  const now = Date.now();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO scheduled_launches (id, kind, args_json, actor, token_id, decision_id, task_id, project, machine_id, title, launcher, not_before, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, JSON.stringify(args), actor, tokenId, decisionId, p.task?.id ?? null, p.task?.project ?? null, p.job.machineId, p.job.title ?? 'Coordinator',
      p.options.launcher ?? 'claude', at.notBefore, at.expiresAt, now, now,
    );
    if (p.task) updateTask(ctx, { id: p.task.id, notBefore: at.notBefore }, actor);
    ctx.db.audit(actor, 'launch_scheduled', p.task?.id ?? id, { id, kind, notBefore: at.notBefore, expiresAt: at.expiresAt, machineId: p.job.machineId, cwd: p.job.cwd, ...(decisionId ? { decisionId } : {}) });
  });
  ctx.bus.publish('jobs', 'scheduled', { id });
  return { status: 'scheduled', kind, scheduleId: id, notBefore: at.notBefore, expiresAt: at.expiresAt, taskId: p.task?.id ?? null, decisionId };
}

/** machines_list: where an agent can launch. */
export function listMachines(ctx: Ctx): MachineView[] {
  return ctx.db
    .all<{ id: string; name: string; platform: string | null; runner_info_json: string | null; runner_seen_at: number | null }>(
      'SELECT id, name, platform, runner_info_json, runner_seen_at FROM machines WHERE revoked = 0 ORDER BY name, id',
    )
    .map((m) => {
      const info = json<{ allowedRoots?: unknown; concurrency?: unknown; platform?: unknown; version?: unknown; interactiveSession?: unknown }>(m.runner_info_json, null);
      return {
        id: m.id,
        name: m.name,
        platform: m.platform ?? (typeof info?.platform === 'string' ? info.platform : null),
        runnerOnline: ctx.runners.has(m.id),
        allowedRoots: Array.isArray(info?.allowedRoots) ? info.allowedRoots.filter((r): r is string => typeof r === 'string') : [],
        concurrency: typeof info?.concurrency === 'number' ? info.concurrency : null,
        runnerSeenAt: m.runner_seen_at,
        runnerVersion: typeof info?.version === 'string' ? info.version.slice(0, 40) : null,
        interactiveSession: typeof info?.interactiveSession === 'boolean' ? info.interactiveSession : null,
      };
    });
}
