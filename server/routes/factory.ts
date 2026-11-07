// The factory's HTTP surface (SPEC §11): the agent API for `bb mcp` (agent token) and the web API for the PWA (cookie).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { requireWeb, webUser } from '../auth.ts';
import { TASK_STATUSES, TOOLS, TOOL_NAMES, type TaskStatus, type ToolName } from '../../shared/factory.ts';
import { parseTaskFile, orderByDeps, TaskFileError } from '../../shared/tasks-md.ts';
import { agentFromToken, createAgentToken, HANDLERS, listAgentTokens, requireAgent, revokeAgentToken } from '../factory/agent.ts';
import { governor, readUsage } from '../factory/governor.ts';
import { createTask, deleteTask, FactoryError, gateShot, getTask, listTasks, requestControl, updateTask } from '../factory/tasks.ts';
import { answerDecision, listDecisions } from '../factory/decisions.ts';
import { listDigests, sendDigest } from '../factory/digest.ts';
import { importGithubIssues } from '../factory/import.ts';

function fail(c: Context, e: unknown) {
  if (e instanceof FactoryError) return c.json({ error: e.message }, e.status as 400);
  if (e instanceof TaskFileError) return c.json({ error: e.message }, 400);
  throw e;
}

const webTaskSchema = TOOLS.tasks_create.input.omit({ upsert: true, extRef: true });
const webPatchSchema = TOOLS.tasks_update.input.omit({ id: true }).extend({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(100_000).optional(),
  repo: z.string().max(500).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  sensitive: z.boolean().optional(),
});

export function factoryRoutes(ctx: Ctx) {
  const app = new Hono<{ Variables: { agent: { id: string; name: string } } }>();
  const web = requireWeb(ctx);
  const agentAuth = requireAgent(ctx);
  const { db } = ctx;

  // ---------- agent API: one endpoint per MCP tool ----------
  app.post('/api/agent/:tool', agentAuth, async (c) => {
    const name = c.req.param('tool') as ToolName;
    if (!TOOL_NAMES.includes(name)) return c.json({ error: `unknown tool ${name}` }, 404);
    const parsed = TOOLS[name].input.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return c.json({ error: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` }, 400);
    const actor = `agent:${c.get('agent').name}`;
    try {
      return c.json({ result: (HANDLERS[name] as (ctx: Ctx, a: unknown, actor: string) => unknown)(ctx, parsed.data, actor) ?? null });
    } catch (e) {
      return fail(c, e);
    }
  });

  // ---------- governor and usage: the PWA or an agent ----------
  const webOrAgent = async (c: Context, next: () => Promise<void>) => {
    if (agentFromToken(ctx, c.req.header('authorization')) || webUser(ctx, c)) return next();
    return c.json({ error: 'unauthorized' }, 401);
  };
  app.get('/api/governor', webOrAgent, (c) => c.json(governor(ctx)));
  app.get('/api/usage', webOrAgent, (c) => c.json(readUsage(ctx)));

  // ---------- backlog ----------
  app.get('/api/tasks', web, (c) => {
    const status = (c.req.query('status') ?? '').split(',').filter((s): s is TaskStatus => TASK_STATUSES.includes(s as TaskStatus));
    return c.json(listTasks(ctx, { status, ready: c.req.query('ready') === '1', q: c.req.query('q') }));
  });

  app.post('/api/tasks', web, async (c) => {
    const p = webTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'a title is required' }, 400);
    try {
      return c.json(createTask(ctx, { ...p.data, source: 'web' }, 'web'), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/tasks/import/markdown', web, async (c) => {
    const b = z.object({ files: z.array(z.object({ name: z.string().max(300), text: z.string().max(500_000) })).min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'files: [{ name, text }] required' }, 400);
    try {
      const parsed = orderByDeps(b.data.files.map((f) => parseTaskFile(f.text, f.name)));
      const out = db.tx(() => parsed.map((t) => createTask(ctx, { ...t, upsert: true, source: 'markdown' }, 'web')));
      return c.json({ imported: out.map((t) => t.id) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/tasks/import/github', web, async (c) => {
    const b = z.object({ owner: z.string().regex(/^[\w.-]{1,100}$/), repo: z.string().regex(/^[\w.-]{1,100}$/), label: z.string().max(100).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'owner and repo required' }, 400);
    try {
      return c.json(await importGithubIssues(ctx, b.data.owner, b.data.repo, b.data.label));
    } catch (e) {
      if (e instanceof FactoryError) return fail(c, e);
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.get('/api/tasks/:id', web, (c) => {
    try {
      return c.json(getTask(ctx, c.req.param('id')));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.put('/api/tasks/:id', web, async (c) => {
    const p = webPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'invalid task' }, 400);
    const { title, body, repo, priority, sensitive, ...patch } = p.data;
    try {
      return c.json(updateTask(ctx, { ...patch, id: c.req.param('id') }, 'web', { title, body, repo, priority, sensitive }));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/tasks/:id', web, (c) => {
    try {
      deleteTask(ctx, c.req.param('id'), 'web');
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** "Stop the package" / "Revert its integration": recorded for the coordinator, which reads them with control_get. */
  app.post('/api/tasks/:id/control', web, async (c) => {
    const b = z.object({ kind: z.enum(['stop', 'revert']), note: z.string().max(4000).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'kind must be stop or revert' }, 400);
    try {
      return c.json(requestControl(ctx, c.req.param('id'), b.data.kind, b.data.note?.trim() || null, 'web'), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/gate-shots/:id', web, (c) => {
    const s = gateShot(ctx, Number(c.req.param('id')));
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.body(Buffer.from(s.data), 200, { 'content-type': s.mime, 'cache-control': 'private, max-age=86400' });
  });

  // ---------- decisions ----------
  app.get('/api/decisions', web, (c) => {
    const s = c.req.query('status');
    return c.json(listDecisions(ctx, { status: s === 'pending' || s === 'answered' || s === 'cancelled' ? s : undefined }));
  });

  app.post('/api/decisions/:id/answer', web, async (c) => {
    const b = z.object({ answer: z.string().trim().min(1).max(20_000) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'an answer is required' }, 400);
    const d = answerDecision(ctx, c.req.param('id'), b.data.answer, 'web');
    return d ? c.json(d) : c.json({ error: 'not found or already answered' }, 409);
  });

  app.post('/api/decisions/:id/cancel', web, (c) => {
    const d = answerDecision(ctx, c.req.param('id'), null, 'web');
    return d ? c.json(d) : c.json({ error: 'not found or already answered' }, 409);
  });

  // ---------- agent tokens ----------
  app.get('/api/agent-tokens', web, (c) => c.json(listAgentTokens(ctx)));

  app.post('/api/agent-tokens', web, async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'a name is required' }, 400);
    const t = createAgentToken(ctx, b.data.name);
    db.audit('web', 'agent_token_create', t.id, { name: b.data.name });
    return c.json({ id: t.id, name: b.data.name, token: t.token }, 201);
  });

  app.post('/api/agent-tokens/:id/revoke', web, (c) => {
    if (!revokeAgentToken(ctx, c.req.param('id'))) return c.json({ error: 'not found or already revoked' }, 404);
    db.audit('web', 'agent_token_revoke', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---------- digests ----------
  app.get('/api/digests', web, (c) => c.json(listDigests(ctx)));
  app.post('/api/digests', web, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { note?: unknown };
    return c.json(sendDigest(ctx, 'manual', typeof b?.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 4000) : null), 201);
  });

  return app;
}
