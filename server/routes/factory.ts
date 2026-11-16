// The factory's HTTP surface (SPEC §11): the agent API for `bb mcp` (agent token) and the web API for the PWA (cookie).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { requireMachine, requireWeb, webUser } from '../auth.ts';
import { FINDING_SEVERITIES, FINDING_STATUSES, LAUNCH_SCOPES, TASK_STATUSES, TOOLS, type GateReport, type TaskStatus } from '../../shared/factory.ts';
import { parseTaskFile, orderByDeps, TaskFileError, taskFileToCreate } from '../../shared/tasks-md.ts';
import { agentFromToken, callerOf, callTool, createAgentToken, listAgentTokens, requireAgent, revokeAgentToken, setTokenLaunch, type AgentIdentity } from '../factory/agent.ts';
import { governor, readUsage } from '../factory/governor.ts';
import { createTask, deleteTask, FactoryError, gateShot, getTask, listTasks, requestControl, updateTask } from '../factory/tasks.ts';
import { answerDecision, listDecisions } from '../factory/decisions.ts';
import { listDigests, sendDigest } from '../factory/digest.ts';
import { importGithubIssues } from '../factory/import.ts';
import { factoryConfig, factoryConfigSchema, saveFactoryConfig } from '../factory/config.ts';
import { listFindings, updateFindings } from '../factory/findings.ts';
import { applyGateReport, gateRunLog } from '../factory/gateruns.ts';
import { lastSegment } from './projects.ts';

function fail(c: Context, e: unknown) {
  if (e instanceof FactoryError) return c.json({ error: e.message }, e.status as 400);
  if (e instanceof TaskFileError) return c.json({ error: e.message }, 400);
  throw e;
}

const gateReportSchema = z.object({
  status: z.enum(['running', 'done', 'error']),
  verdict: z.enum(['pass', 'fail', 'skip']).optional(),
  summary: z.string().max(100_000).optional(),
  details: z.unknown().optional(),
  findings: z.array(z.unknown()).max(1000).optional(),
  shots: z.array(z.object({ name: z.string().max(200), base64: z.string(), mime: z.string().max(60).optional() })).max(50).optional(),
  exitCode: z.number().int().nullable().optional(),
  error: z.string().max(100_000).optional(),
  log: z.string().optional(),
});

const webTaskSchema = TOOLS.tasks_create.input.omit({ upsert: true, extRef: true });
const webPatchSchema = TOOLS.tasks_update.input.omit({ id: true }).extend({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(100_000).optional(),
  repo: z.string().max(500).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  sensitive: z.boolean().optional(),
});

export function factoryRoutes(ctx: Ctx) {
  const app = new Hono<{ Variables: { agent: AgentIdentity } }>();
  const web = requireWeb(ctx);
  const agentAuth = requireAgent(ctx);
  const { db } = ctx;

  // ---------- agent API: one endpoint per MCP tool ----------
  app.post('/api/agent/:tool', agentAuth, async (c) => {
    // `bb mcp` sends an idempotency key with every write it may replay from its outbox: a repeated key gets the first
    // answer back and changes nothing.
    const key = c.req.header('idempotency-key')?.trim().slice(0, 200) || null;
    try {
      const agent = c.get('agent');
      const out = callTool(ctx, c.req.param('tool'), (await c.req.json().catch(() => ({}))) ?? {}, `agent:${agent.name}`, key, callerOf(agent));
      return c.json(out);
    } catch (e) {
      return fail(c, e);
    }
  });

  // ---------- gate runs: the runner reports, the PWA reads the log ----------
  app.post('/api/runner/gates/:id', requireMachine(ctx), async (c) => {
    const b = gateReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: `invalid report: ${b.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` }, 400);
    try {
      return c.json(applyGateReport(ctx, c.get('machineId' as never) as string, c.req.param('id'), b.data as GateReport));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/gate-runs/:id/log', web, (c) => {
    const log = gateRunLog(ctx, c.req.param('id'));
    return log === null ? c.json({ error: 'no log' }, 404) : c.text(log);
  });

  // ---------- findings ----------
  app.get('/api/findings', web, (c) => {
    const status = c.req.query('status');
    const severity = c.req.query('severity');
    return c.json(listFindings(ctx, {
      taskId: c.req.query('taskId') || undefined,
      status: FINDING_STATUSES.find((s) => s === status),
      severity: FINDING_SEVERITIES.find((s) => s === severity),
    }));
  });

  app.post('/api/findings/update', web, async (c) => {
    const b = TOOLS.findings_update.input.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'ids and a status are required' }, 400);
    try {
      return c.json(updateFindings(ctx, b.data.ids, b.data.status, b.data.note?.trim() || null, 'web'));
    } catch (e) {
      return fail(c, e);
    }
  });

  // ---------- factory config: gate rounds and §11.7's per-repo config, kept on the projects (§12.1) ----------
  app.get('/api/factory/config', web, (c) => c.json(factoryConfig(ctx)));
  app.put('/api/factory/config', web, async (c) => {
    const b = factoryConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: `invalid config: ${b.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }, 400);
    const names = b.data.repos.map((r) => r.repo.toLowerCase());
    if (new Set(names).size !== names.length) return c.json({ error: 'each repo can be configured once' }, 400);
    try {
      saveFactoryConfig(ctx, b.data, 'web');
    } catch (e) {
      return fail(c, e);
    }
    db.audit('web', 'factory_config', null, { repos: names });
    return c.json(factoryConfig(ctx));
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
    const archived = c.req.query('archived');
    try {
      return c.json(listTasks(ctx, {
        status, ready: c.req.query('ready') === '1', q: c.req.query('q'), project: c.req.query('project') || undefined,
        archived: archived === 'all' ? 'all' : archived === '1' || archived === 'true',
      }));
    } catch (e) {
      return fail(c, e);
    }
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
    const b = z
      .object({ files: z.array(z.object({ name: z.string().max(300), text: z.string().max(500_000) })).min(1).max(200), project: TOOLS.tasks_create.input.shape.project })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'files: [{ name, text }] required; project: a project key' }, 400);
    try {
      const parsed = orderByDeps(b.data.files.map((f) => ({ ...parseTaskFile(f.text, f.name), ref: f.name })));
      const args = parsed.map((t) => {
        const p = TOOLS.tasks_create.input.safeParse(taskFileToCreate(t, t.ref, b.data.project));
        if (!p.success) throw new TaskFileError(`${t.ref}: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
        return p.data;
      });
      const out = db.tx(() => args.map((t) => createTask(ctx, { ...t, source: 'markdown' }, 'web')));
      return c.json({ imported: out.map((t) => t.id) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/tasks/import/github', web, async (c) => {
    const b = z
      .object({ owner: z.string().regex(/^[\w.-]{1,100}$/), repo: z.string().regex(/^[\w.-]{1,100}$/), label: z.string().max(100).optional(), project: TOOLS.tasks_create.input.shape.project })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'owner and repo required' }, 400);
    try {
      return c.json(await importGithubIssues(ctx, b.data.owner, b.data.repo, b.data.label, b.data.project));
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

  /** The archive (§12.2): the same as PUT /api/tasks/:id { archived }. */
  app.post('/api/tasks/:id/:action{archive|unarchive}', web, (c) => {
    const action = lastSegment(c); // not the parameter: Hono's trie router matches it as a prefix
    if (action !== 'archive' && action !== 'unarchive') return c.json({ error: 'not found' }, 404);
    try {
      return c.json(updateTask(ctx, { id: c.req.param('id'), archived: action === 'archive' }, 'web'));
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
    return c.body(Buffer.from(s.data), 200, { 'content-type': s.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
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

  app.put('/api/agent-tokens/:id', web, async (c) => {
    const b = z
      .object({ launch: z.enum(LAUNCH_SCOPES).optional(), launchApproval: z.boolean().optional(), operator: z.boolean().optional(), inbox: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'launch must be off, workers or all; launchApproval, operator and inbox true or false' }, 400);
    const t = setTokenLaunch(ctx, c.req.param('id'), b.data);
    if (!t) return c.json({ error: 'not found or revoked' }, 404);
    const { operator, inbox, ...launch } = b.data;
    if (Object.keys(launch).length) db.audit('web', 'agent_token_launch', t.id, launch);
    if (operator !== undefined || inbox !== undefined) db.audit('web', 'agent_token_scopes', t.id, { operator, inbox }); // §12.7
    return c.json(t);
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
