// The planner (SPEC §12.6): `plan_request {project, goal, notes?}` (owner or operator) starts a read-only `claude -p` job
// on the project's runner, in the main checkout, with the built-in structured answer `plan`. Its packages are created in
// `backlog` as one plan (tasks.plan_id) and one decision asks the owner: Approve (they become gata; with autopilot on the
// conductor starts them) or Discard (the plan's untouched backlog packages are deleted). A failed or empty plan asks the
// owner the planner's questions; an answer plans again with it as notes.
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { createJob, JobError } from '../jobs/core.ts';
import { PLAN_ANSWERS, planAnswerSchema, type PlanAnswer, type PlanStatus, type PlanView } from '../../shared/factory.ts';
import { fillKit, kitText, modelFor } from './brief.ts';
import { askDecision, getDecision } from './decisions.ts';
import { READ_ONLY_TOOLS } from './foreman.ts';
import { governor } from './governor.ts';
import { projectLine, projectTaskId, requireProject, type ProjectRow } from './projects.ts';
import { createTask, FactoryError, taskEvent, updateTask } from './tasks.ts';
import { jobAnswer } from './worker.ts';

export const PLAN_ACTOR = 'factory:plan';
export const PLANNER_LIMITS = { maxTurns: 60, maxBudgetUsd: 5, limitMinutes: 45 };

type Row = {
  id: string; project: string; goal: string; notes: string | null; status: PlanStatus; job_id: string | null; decision_id: string | null; summary: string | null;
  questions_json: string | null; error: string | null; actor: string; created_at: number; updated_at: number;
};

function view(ctx: Ctx, r: Row): PlanView {
  return {
    id: r.id, project: r.project, goal: r.goal, notes: r.notes, status: r.status, jobId: r.job_id, decisionId: r.decision_id, summary: r.summary,
    questions: json<string[]>(r.questions_json, []) ?? [], error: r.error, actor: r.actor, createdAt: r.created_at, updatedAt: r.updated_at,
    packages: ctx.db.all<{ id: string }>('SELECT id FROM tasks WHERE plan_id = ? ORDER BY created_at, id', r.id).map((t) => t.id),
  };
}

export function listPlans(ctx: Ctx, project: string, limit = 20): PlanView[] {
  return ctx.db.all<Row>('SELECT * FROM plans WHERE project = ? ORDER BY created_at DESC LIMIT ?', project, limit).map((r) => view(ctx, r));
}

export function getPlan(ctx: Ctx, id: string): PlanView | null {
  const r = ctx.db.get<Row>('SELECT * FROM plans WHERE id = ?', id);
  return r ? view(ctx, r) : null;
}

const set = (ctx: Ctx, id: string, fields: Partial<Omit<Row, 'id'>>) => {
  const keys = Object.keys(fields);
  ctx.db.run(`UPDATE plans SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (fields as Record<string, string | number | null>)[k]), Date.now(), id);
};
const publish = (ctx: Ctx, project: string) => ctx.bus.publish('tasks', 'project', { key: project });

function plannerPrompt(p: ProjectRow, goal: string, notes: string | null): string {
  const line = projectLine(p);
  const context = line?.context ?? ['CLAUDE.md'];
  return fillKit(kitText('planner.md'), {
    project: p.key,
    goal: goal.trim(),
    notes: notes?.trim() ? `**Notes from the owner:**\n\n${notes.trim()}` : '',
    context: context.length ? context.map((c) => `\`${c}\``).join(', ') : 'none listed',
    packages: `${line?.paths.packages ?? 'factory/packages'}/`,
  }).replace(/\n{3,}/g, '\n\n').trim();
}

/** plan_request and POST /api/factory/projects/:key/plan: starts the planner. Refused while the governor says stopAll. */
export function requestPlan(ctx: Ctx, a: { project: string; goal: string; notes?: string | null }, actor: string): PlanView {
  const p = requireProject(ctx, a.project);
  if (p.state === 'archived') throw new FactoryError(409, `project ${p.key} is archived: unarchive it first`);
  if (!p.machine_id || !p.checkout) throw new FactoryError(400, `project ${p.key} needs a machine and the main checkout first (the planner reads the repo there)`);
  const model = modelFor(p, projectLine(p), 'planner');
  if (!model) throw new FactoryError(409, `the planner is off for project ${p.key} (models.planner is null)`);
  const g = governor(ctx);
  if (g.stopAll) throw new FactoryError(409, `governor: ${g.reason}`);
  const goal = a.goal.trim();
  const notes = a.notes?.trim() || null;
  if (goal.length < 3) throw new FactoryError(400, 'goal: say what to build');
  const id = randomUUID();
  const now = Date.now();
  ctx.db.tx(() => {
    let jobId: string;
    try {
      jobId = createJob(ctx, {
        machineId: p.machine_id!,
        cwd: p.checkout!,
        promptText: plannerPrompt(p, goal, notes),
        title: `Planner: ${p.key}: ${goal}`.slice(0, 200),
        options: { model, permissionMode: 'dontAsk', allowedTools: READ_ONLY_TOOLS, outputSchema: 'plan', role: 'coordonator', launcher: 'claude', ...PLANNER_LIMITS },
      });
    } catch (e) {
      if (e instanceof JobError) throw new FactoryError(e.status, e.message);
      throw e;
    }
    ctx.db.run(
      "INSERT INTO plans (id, project, goal, notes, status, job_id, actor, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
      id, p.key, goal, notes, jobId, actor, now, now,
    );
  });
  ctx.db.audit(actor, 'plan_request', p.key, { planId: id, goal: goal.slice(0, 300) });
  publish(ctx, p.key);
  return getPlan(ctx, id)!;
}

/** The planner's packages, created in backlog in dependency order; a taken or repeated local id gets a suffix. Ids in the plan's order. */
function createPackages(ctx: Ctx, p: ProjectRow, planId: string, a: PlanAnswer): { ids: string[]; notes: string[] } {
  const notes: string[] = [];
  const ids: string[] = [];
  const used = new Set<string>();
  const firstOf = new Map<string, number>();
  a.packages.forEach((pk, i) => {
    const want = projectTaskId(p, pk.localId);
    let id = want;
    for (let n = 2; used.has(id) || ctx.db.get('SELECT 1 FROM tasks WHERE id = ?', id); n++) id = projectTaskId(p, `${pk.localId}-${n}`);
    if (id !== want) notes.push(firstOf.has(pk.localId) ? `the plan names ${pk.localId} twice: the second one is ${id}` : `${pk.localId} is taken: created as ${id}`);
    if (!firstOf.has(pk.localId)) firstOf.set(pk.localId, i);
    used.add(id);
    ids.push(id);
  });
  // dependencies: on packages of this plan (by local id) or existing ones; created after what they need
  const done = new Set<number>();
  const order: number[] = [];
  const visiting = new Set<number>();
  const visit = (i: number) => {
    if (done.has(i) || visiting.has(i)) return;
    visiting.add(i);
    for (const d of a.packages[i].dependsOn) {
      const j = firstOf.get(d);
      if (j !== undefined && j !== i) visit(j);
    }
    visiting.delete(i);
    done.add(i);
    order.push(i);
  };
  a.packages.forEach((_, i) => visit(i));
  const created = new Set<string>();
  for (const i of order) {
    const pk = a.packages[i];
    const deps: string[] = [];
    for (const d of pk.dependsOn) {
      const j = firstOf.get(d);
      const dep = j !== undefined ? ids[j] : ctx.db.get<{ id: string }>('SELECT id FROM tasks WHERE id IN (?, ?)', projectTaskId(p, d), d)?.id;
      if (dep && dep !== ids[i] && (j === undefined || created.has(dep))) deps.push(dep);
      else notes.push(`${ids[i]}: dependency ${d} dropped (${dep ? 'a cycle' : 'unknown'})`);
    }
    createTask(ctx, {
      project: p.key, id: ids[i], title: pk.title, body: pk.body, acceptance: pk.acceptance, dependsOn: deps, sensitive: pk.sensitive, priority: pk.priority,
      status: 'backlog', source: 'plan',
    }, PLAN_ACTOR);
    ctx.db.run('UPDATE tasks SET plan_id = ? WHERE id = ?', planId, ids[i]);
    created.add(ids[i]);
  }
  return { ids, notes };
}

function proposal(r: Row, a: PlanAnswer, ids: string[], notes: string[]): { question: string; context: string } {
  const lines = [
    a.summary || '(no summary)',
    '',
    ...a.packages.map((pk, i) => `- **${ids[i] ?? pk.localId}** ${pk.title}${pk.sensitive ? ' (sensitive)' : ''}${pk.dependsOn.length ? `, after ${pk.dependsOn.join(', ')}` : ''}`),
    ...(a.questions.length ? ['', '**What the planner assumed:**', ...a.questions.map((q) => `- ${q}`)] : []),
    ...(notes.length ? ['', ...notes.map((n) => `- ${n}`)] : []),
    '',
    `**${PLAN_ANSWERS.approve}**: they become ready (gata). **${PLAN_ANSWERS.discard}**: the packages still untouched in backlog are deleted. To change them first, edit them on the project's Backlog tab, then answer.`,
  ];
  return { question: `Plan for ${r.project}: ${r.goal.slice(0, 200)}: ${ids.length} package${ids.length === 1 ? '' : 's'}. Approve?`, context: lines.join('\n') };
}

/** One step for each plan of the project: a finished planner job becomes packages and a decision; an answer is applied. */
export function advancePlans(ctx: Ctx, project: string): number {
  let moved = 0;
  for (const r of ctx.db.all<Row>("SELECT * FROM plans WHERE project = ? AND status IN ('running', 'proposed', 'failed') ORDER BY created_at", project)) {
    if (r.status === 'running') moved += finishPlan(ctx, r) ? 1 : 0;
    else if (r.decision_id) moved += applyAnswer(ctx, r) ? 1 : 0;
  }
  return moved;
}

function finishPlan(ctx: Ctx, r: Row): boolean {
  const a = r.job_id ? jobAnswer(ctx, r.job_id) : { state: 'missing' as const };
  if (a.state === 'running') return false;
  const p = requireProject(ctx, r.project);
  const parsed = a.state === 'ended' ? planAnswerSchema.safeParse(a.structured) : null;
  if (parsed?.success && parsed.data.packages.length) {
    ctx.db.tx(() => {
      const { ids, notes } = createPackages(ctx, p, r.id, parsed.data);
      const q = proposal(r, parsed.data, ids, notes);
      const d = askDecision(ctx, { question: q.question, context: q.context, options: [PLAN_ANSWERS.approve, PLAN_ANSWERS.discard] }, PLAN_ACTOR);
      set(ctx, r.id, { status: 'proposed', summary: parsed.data.summary || null, questions_json: JSON.stringify(parsed.data.questions), decision_id: d.id });
    });
    publish(ctx, r.project);
    return true;
  }
  const questions = parsed?.success ? parsed.data.questions : [];
  const why =
    a.state !== 'ended' ? 'its job is gone'
    : parsed?.success ? 'the planner proposed no packages'
    : a.status !== 'succeeded' ? `its job ${a.status}${a.reason ? ` (${a.reason})` : ''}`
    : 'it gave no valid structured answer';
  const context = [
    `The planner could not plan this goal: ${why}.`,
    ...(questions.length ? ['', '**It asks:**', ...questions.map((q) => `- ${q}`)] : []),
    '',
    'Answer with what it needs to know: the planner runs again with your answer as notes. Cancel the question to drop the goal.',
  ].join('\n');
  ctx.db.tx(() => {
    const d = askDecision(ctx, { question: `The plan for ${r.project} failed: ${r.goal.slice(0, 200)}`, context }, PLAN_ACTOR);
    set(ctx, r.id, { status: 'failed', error: why, summary: parsed?.success ? parsed.data.summary || null : null, questions_json: JSON.stringify(questions), decision_id: d.id });
  });
  publish(ctx, r.project);
  return true;
}

function applyAnswer(ctx: Ctx, r: Row): boolean {
  const d = getDecision(ctx, r.decision_id!);
  if (!d || d.status === 'pending') return false;
  const by = d.answeredBy ?? PLAN_ACTOR;
  const answer = (d.answer ?? '').trim().toLowerCase();
  if (r.status === 'failed') {
    // an answer is what the planner needed: plan again with it
    set(ctx, r.id, { status: 'cancelled' });
    if (d.status === 'answered' && d.answer?.trim()) {
      try {
        requestPlan(ctx, { project: r.project, goal: r.goal, notes: [r.notes, `Answers to the planner's questions: ${d.answer.trim()}`].filter(Boolean).join('\n\n') }, by);
      } catch (e) {
        if (!(e instanceof FactoryError)) throw e;
        set(ctx, r.id, { error: `planning again failed: ${e.message}` });
      }
    }
    publish(ctx, r.project);
    return true;
  }
  const pkgs = ctx.db.all<{ id: string; status: string }>('SELECT id, status FROM tasks WHERE plan_id = ? ORDER BY created_at, id', r.id);
  ctx.db.tx(() => {
    if (d.status === 'answered' && answer === PLAN_ANSWERS.approve.toLowerCase()) {
      for (const t of pkgs.filter((x) => x.status === 'backlog')) updateTask(ctx, { id: t.id, status: 'gata', note: `plan approved by ${by}` }, PLAN_ACTOR);
      set(ctx, r.id, { status: 'approved' });
    } else if (d.status === 'answered' && answer === PLAN_ANSWERS.discard.toLowerCase()) {
      // untouched: still in backlog with nothing in its history but its creation
      const untouched = pkgs.filter(
        (t) => t.status === 'backlog' && !ctx.db.get("SELECT 1 FROM task_events WHERE task_id = ? AND kind NOT IN ('created')", t.id),
      );
      for (const t of untouched) ctx.db.run('DELETE FROM tasks WHERE id = ?', t.id);
      const kept = pkgs.filter((t) => !untouched.includes(t)).map((t) => t.id);
      for (const id of kept) taskEvent(ctx, id, PLAN_ACTOR, 'note', null, null, { note: `kept: the plan was discarded, but this package was changed or started` });
      ctx.db.audit(by, 'plan_discard', r.project, { planId: r.id, deleted: untouched.map((t) => t.id), kept });
      set(ctx, r.id, { status: 'discarded' });
    } else {
      // cancelled, or an answer that is neither: the packages stay in backlog for the owner
      set(ctx, r.id, { status: 'cancelled' });
    }
  });
  for (const t of pkgs) ctx.bus.publish('tasks', 'changed', { id: t.id });
  publish(ctx, r.project);
  return true;
}
