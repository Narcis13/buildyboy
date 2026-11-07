// herdr (`hc`) on the server: stores the terminals each runner reports, serves them to the Floor, and launches a
// backlog package as an interactive agent. The server never runs hc; it creates a job and the runner runs it
// (SPEC §11.4).
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { requireMachine, requireWeb } from '../auth.ts';
import { hcTerminalName, OptionError } from '../../runner/options.ts';
import { createJob, JobError, runnerInfo, under } from '../jobs/core.ts';
import { FactoryError, getTask, updateTask } from '../factory/tasks.ts';
import type { TaskDetail, TerminalView } from '../../shared/factory.ts';

type Vars = { Variables: { machineId: string } };

/** A runner reports every 15 s by default; older rows are hidden. */
export const TERMINAL_FRESH_MS = 2 * 60_000;

const str = (max: number) => z.string().max(max).nullish();
const terminalsSchema = z.object({
  terminals: z
    .array(
      z.object({
        address: z.string().min(1).max(100),
        name: str(100),
        agent: str(100),
        cwd: str(1000),
        state: str(40),
        status: str(40),
        turn: z.number().int().nullish(),
        where: str(300),
      }),
    )
    .max(500),
});

const launchSchema = z.object({
  machineId: z.string().min(1).max(100),
  cwd: z.string().trim().min(1).max(1000),
  launcher: z.enum(['hc', 'claude']).default('hc'),
  promptId: z.coerce.number().int().positive().nullish(),
  model: z.string().max(100).nullish(),
  permissionMode: z.string().max(40).nullish(),
  maxBudgetUsd: z.number().positive().max(1000).nullish(),
});

interface Row {
  machine_id: string; machine_name: string; address: string; name: string | null; agent: string | null; cwd: string | null; state: string | null;
  status: string | null; turn: number | null; where_label: string | null; task_id: string | null; seen_at: number;
}

/** The prompt text for a package without a prompt of its own: built from its title, body and acceptance criteria. */
export function taskPrompt(t: TaskDetail): string {
  const lines = [`# ${t.title}`, '', `Backlog package ${t.id}${t.repo ? ` in ${t.repo}` : ''}${t.branch ? `, branch ${t.branch}` : ''}.`];
  if (t.body.trim()) lines.push('', t.body.trim());
  if (t.acceptance.length) lines.push('', '## Acceptance criteria', ...t.acceptance.map((a) => `- ${a}`));
  return lines.join('\n');
}

function signature(rows: Row[]): string {
  return JSON.stringify(rows.map((r) => [r.address, r.name, r.agent, r.cwd, r.state, r.status, r.turn, r.where_label]).sort());
}

/** Terminals reported recently, each with the session running in it and the package it belongs to. */
export function terminalViews(ctx: Ctx, now = Date.now()): TerminalView[] {
  const { db } = ctx;
  const rows = db.all<Row>(
    `SELECT t.*, m.name AS machine_name FROM hc_terminals t JOIN machines m ON m.id = t.machine_id
     WHERE t.seen_at > ? AND m.revoked = 0 ORDER BY m.name, t.machine_id, LENGTH(t.address), t.address`,
    now - TERMINAL_FRESH_MS,
  );
  // packages that name a terminal, on the machine of their job or session (hc numbers terminals per machine);
  // one with neither is matched by its bb-<id> name only
  const owned = db.all<{ id: string; terminal: string; machine_id: string | null }>(
    `SELECT t.id, t.terminal, COALESCE(j.machine_id, s.machine_id) AS machine_id FROM tasks t
     LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN sessions s ON s.id = t.session_id WHERE t.terminal IS NOT NULL`,
  );
  return rows.map((r) => {
    const own = owned.find((t) => t.terminal === r.address && t.machine_id === r.machine_id);
    const session = db.get<{ id: string }>('SELECT id FROM sessions WHERE machine_id = ? AND hc_terminal = ? ORDER BY last_event_at DESC LIMIT 1', r.machine_id, r.address);
    return {
      machineId: r.machine_id,
      machineName: r.machine_name,
      address: r.address,
      name: r.name,
      agent: r.agent,
      cwd: r.cwd,
      state: r.state,
      status: r.status,
      turn: r.turn,
      where: r.where_label,
      taskId: own?.id ?? r.task_id,
      sessionId: session?.id ?? null,
      seenAt: r.seen_at,
    };
  });
}

export function herdrRoutes(ctx: Ctx) {
  const app = new Hono<Vars>();
  const mauth = requireMachine(ctx);
  const wauth = requireWeb(ctx);
  const { db, bus } = ctx;

  // ---------- runner: replace this machine's terminals ----------
  app.post('/api/runner/terminals', mauth, async (c) => {
    const machineId = c.get('machineId');
    const p = terminalsSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'bad terminals report' }, 400);
    const mine = () => signature(db.all<Row>('SELECT * FROM hc_terminals WHERE machine_id = ?', machineId));
    const before = mine();
    const now = Date.now();
    // packages by their terminal name (`bb-t12`), so a terminal we started links back without asking hc for labels
    const byName = new Map(db.all<{ id: string }>('SELECT id FROM tasks').map((t) => [hcTerminalName(t.id), t.id]));
    db.tx(() => {
      const seen = new Set<string>();
      for (const t of p.data.terminals) {
        if (seen.has(t.address)) continue;
        seen.add(t.address);
        const taskId = t.name ? byName.get(t.name.toLowerCase()) ?? null : null;
        db.run(
          `INSERT INTO hc_terminals (machine_id, address, name, agent, cwd, state, status, turn, where_label, task_id, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(machine_id, address) DO UPDATE SET name = excluded.name, agent = excluded.agent, cwd = excluded.cwd, state = excluded.state, status = excluded.status,
           turn = excluded.turn, where_label = excluded.where_label, task_id = excluded.task_id, seen_at = excluded.seen_at`,
          machineId, t.address, t.name ?? null, t.agent ?? null, t.cwd ?? null, t.state ?? null, t.status ?? null, t.turn ?? null, t.where ?? null, taskId, now,
        );
      }
      for (const r of db.all<{ address: string }>('SELECT address FROM hc_terminals WHERE machine_id = ?', machineId)) {
        if (!seen.has(r.address)) db.run('DELETE FROM hc_terminals WHERE machine_id = ? AND address = ?', machineId, r.address);
      }
    });
    if (before !== mine()) bus.publish('floor', 'terminals', { machineId });
    return c.json({ ok: true, count: p.data.terminals.length });
  });

  // ---------- web: the terminals ----------
  app.get('/api/terminals', wauth, (c) => c.json(terminalViews(ctx)));

  // ---------- web: start a package ----------
  app.post('/api/tasks/:id/launch', wauth, async (c) => {
    const p = launchSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: `invalid launch: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }, 400);
    const b = p.data;
    try {
      const task = getTask(ctx, c.req.param('id'));
      if (task.status === 'integrata') return c.json({ error: 'this package is already integrated' }, 409);
      const roots = runnerInfo(ctx, b.machineId)?.allowedRoots ?? [];
      if (roots.length && !roots.some((r) => under(b.cwd, r))) return c.json({ error: `cwd is outside the runner's allowed roots: ${b.cwd}` }, 400);
      const promptId = b.promptId ?? (task.promptId && db.get('SELECT 1 FROM prompts WHERE id = ?', task.promptId) ? task.promptId : null);
      const jobId = createJob(ctx, {
        machineId: b.machineId,
        cwd: b.cwd,
        promptId,
        promptText: promptId ? null : taskPrompt(task),
        title: `${task.id}: ${task.title}`.slice(0, 200),
        options: { maxBudgetUsd: b.maxBudgetUsd ?? 5, model: b.model || undefined, permissionMode: b.permissionMode || undefined, launcher: b.launcher, taskId: task.id },
      });
      // launching is claiming: tasks_claim must not hand the same package to another worker meanwhile
      updateTask(ctx, { id: task.id, ...(task.status === 'in_lucru' ? {} : { status: 'in_lucru' as const }) }, 'launch', { jobId, claimedBy: task.claimedBy ?? 'web' });
      db.audit('web', 'task_launch', task.id, { jobId, machineId: b.machineId, cwd: b.cwd, launcher: b.launcher });
      return c.json({ id: jobId, jobId, launcher: b.launcher }, 201);
    } catch (e) {
      if (e instanceof FactoryError || e instanceof JobError) return c.json({ error: e.message }, e.status as 400);
      if (e instanceof OptionError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  return app;
}
