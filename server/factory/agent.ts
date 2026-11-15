// Agent tokens and the agent API (SPEC §11.1). `bb mcp` calls POST /api/agent/<tool> with an agent token: a bearer
// token separate from machine tokens, limited to the MCP tools below and revocable from the PWA.
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Ctx } from '../context.ts';
import { randomToken, sha256 } from '../auth.ts';
import { listSessions, sessionDetail } from '../queries.ts';
import { promptStore } from '../routes/prompts.ts';
import { lintPrompt, parseTemplate, renderTemplate } from '../../shared/harness.ts';
import { TOOLS, TOOL_NAMES, type AgentTokenView, type ToolArgs, type ToolName } from '../../shared/factory.ts';
import { agentGuide } from '../docs/reference.ts';
import { governor, readUsage } from './governor.ts';
import { ackControls, claimTask, controls, createTask, FactoryError, getTask, listTasks, recordGate, taskSummary, updateTask } from './tasks.ts';
import { askDecision, getDecision } from './decisions.ts';
import { sendDigest } from './digest.ts';
import { listFindings, updateFindings } from './findings.ts';
import { gateRunStatus, startGateRun } from './gateruns.ts';

export function createAgentToken(ctx: Ctx, name: string): { id: string; token: string } {
  const id = randomUUID();
  const token = `bba_${randomToken(24)}`;
  ctx.db.run('INSERT INTO agent_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', id, name, sha256(token), Date.now());
  return { id, token };
}

export function listAgentTokens(ctx: Ctx): AgentTokenView[] {
  return ctx.db
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>('SELECT * FROM agent_tokens ORDER BY created_at DESC')
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
}

export function revokeAgentToken(ctx: Ctx, id: string): boolean {
  return ctx.db.run('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), id).changes > 0;
}

export function agentFromToken(ctx: Ctx, auth: string | undefined): { id: string; name: string } | null {
  const m = /^Bearer\s+(bba_\S+)$/i.exec(auth ?? '');
  if (!m) return null;
  const row = ctx.db.get<{ id: string; name: string; revoked_at: number | null; last_used_at: number | null }>('SELECT id, name, revoked_at, last_used_at FROM agent_tokens WHERE token_hash = ?', sha256(m[1]));
  if (!row || row.revoked_at) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > 30_000) ctx.db.run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', Date.now(), row.id);
  return { id: row.id, name: row.name };
}

export function requireAgent(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    const a = agentFromToken(ctx, c.req.header('authorization'));
    if (!a) return c.json({ error: 'unauthorized' }, 401);
    c.set('agent' as never, a as never);
    await next();
  };
}

type Handler<T extends ToolName> = (ctx: Ctx, args: ToolArgs<T>, actor: string) => unknown;

function templateFor(store: ReturnType<typeof promptStore>, a: { templateId?: number; template?: string }) {
  const t = store.template(a);
  if (!t) throw new FactoryError(404, 'unknown template');
  return { row: t, parsed: parseTemplate(t.body) };
}

/** One handler per MCP tool. They return plain JSON and throw FactoryError for 4xx answers. */
export const HANDLERS: { [K in ToolName]: Handler<K> } = {
  usage_get: (ctx) => readUsage(ctx),
  governor_get: (ctx) => governor(ctx),
  sessions_list: (ctx, a) => listSessions(ctx, { live: a.live, limit: a.limit ?? 50 }),
  sessions_get: (ctx, a) => {
    const s = sessionDetail(ctx, a.id);
    if (!s) throw new FactoryError(404, `unknown session ${a.id}`);
    return s;
  },
  tasks_list: (ctx, a) => listTasks(ctx, { status: a.status, ready: a.ready, limit: a.limit }),
  tasks_get: (ctx, a) => getTask(ctx, a.id),
  tasks_create: (ctx, a, actor) => createTask(ctx, { ...a, source: 'agent' }, actor),
  tasks_claim: (ctx, a, actor) => claimTask(ctx, a, actor),
  tasks_update: (ctx, a, actor) => updateTask(ctx, a, actor),
  prompts_render: (ctx, a) => {
    const { row, parsed } = templateFor(promptStore(ctx), a);
    return { templateId: row.id, template: row.name, rendered: renderTemplate(parsed, a.slots, a.extraMd), warnings: lintPrompt(parsed, a.slots) };
  },
  prompts_lint: (ctx, a) => {
    const { row, parsed } = templateFor(promptStore(ctx), a);
    return { templateId: row.id, warnings: lintPrompt(parsed, a.slots) };
  },
  prompts_save: (ctx, a, actor) => {
    if (a.taskId) taskSummary(ctx, a.taskId); // unknown task: refuse before saving anything
    const store = promptStore(ctx);
    let saved;
    if (a.id != null) {
      const cur = store.load(a.id);
      if (!cur) throw new FactoryError(404, `unknown prompt ${a.id}`);
      const tpl = a.templateId != null || a.template ? templateFor(store, a).row.id : undefined;
      saved = store.update(cur, { title: a.title, slots: a.slots, extraMd: a.extraMd, tags: a.tags, templateId: tpl });
    } else {
      const tpl = templateFor(store, a).row.id;
      saved = store.load(store.create(tpl, a.title, a.slots, a.extraMd ?? '', a.tags ?? []));
    }
    if (!saved) throw new FactoryError(400, 'could not save the prompt');
    ctx.db.audit(actor, 'prompt_save', String(saved.id), { version: saved.version });
    if (a.taskId) updateTask(ctx, { id: a.taskId, promptId: saved.id, promptVersion: saved.version }, actor);
    return { id: saved.id, version: saved.version, title: saved.title, rendered: saved.rendered };
  },
  gates_record: (ctx, a, actor) => recordGate(ctx, a, actor),
  gates_run: (ctx, a, actor) => {
    const { id, status, round, machineId, sent } = startGateRun(ctx, a, actor);
    return { runId: id, status, round, machineId, sent, ...(sent ? {} : { note: 'the runner is not connected; the run starts when gates_status finds it back' }) };
  },
  gates_status: (ctx, a) => gateRunStatus(ctx, a.runId),
  findings_list: (ctx, a) => listFindings(ctx, a),
  findings_update: (ctx, a, actor) => updateFindings(ctx, a.ids, a.status, a.note?.trim() || null, actor),
  decision_ask: (ctx, a, actor) => askDecision(ctx, a, actor),
  decision_get: (ctx, a) => {
    const d = getDecision(ctx, a.id);
    if (!d) throw new FactoryError(404, `unknown decision ${a.id}`);
    return d;
  },
  digest_post: (ctx, a) => sendDigest(ctx, 'manual', a.note ?? null),
  control_get: (ctx, a, actor) => {
    const open = controls(ctx, { taskId: a.taskId });
    if (!a.ack || !open.length) return { requests: open, acked: false };
    ackControls(ctx, open.map((r) => r.id), actor);
    const ids = new Set(open.map((r) => r.id));
    return { requests: controls(ctx, { taskId: a.taskId, all: true }).filter((r) => ids.has(r.id)), acked: true };
  },
  docs_get: (ctx, a) => {
    if (a.tool && !TOOL_NAMES.includes(a.tool as ToolName)) throw new FactoryError(400, `unknown tool ${a.tool}; the tools are ${TOOL_NAMES.join(', ')}`);
    return agentGuide({ url: ctx.config.publicUrl }, a.topic ?? 'start', a.tool);
  },
};

/** How long an idempotency key is remembered: longer than any outage the `bb mcp` outbox would wait out. */
const KEY_TTL_MS = 30 * 24 * 3600_000;

/**
 * Runs one tool for an agent: validates the arguments with the tool's schema, then calls its handler. Both
 * transports use it: POST /api/agent/<tool> (REST and `bb mcp`) and the Streamable HTTP endpoint at /mcp.
 * With an idempotency key, a repeated key returns the first answer and changes nothing (`replayed: true`).
 * Throws FactoryError (status + message) for every refusal: unknown tool 404, bad arguments 400, and the handlers' own.
 */
export function callTool(ctx: Ctx, name: string, rawArgs: unknown, actor: string, key: string | null = null): { result: unknown; replayed?: true } {
  if (!TOOL_NAMES.includes(name as ToolName)) throw new FactoryError(404, `unknown tool ${name}`);
  const tool = name as ToolName;
  const parsed = TOOLS[tool].input.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new FactoryError(400, `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  const { db } = ctx;
  if (key) {
    const seen = db.get<{ result_json: string | null }>('SELECT result_json FROM agent_calls WHERE key = ?', key);
    if (seen) return { result: seen.result_json ? JSON.parse(seen.result_json) : null, replayed: true };
  }
  const run = () => {
    const result = (HANDLERS[tool] as (ctx: Ctx, a: unknown, actor: string) => unknown)(ctx, parsed.data, actor) ?? null;
    if (key) {
      db.run('INSERT INTO agent_calls (key, tool, result_json, created_at) VALUES (?, ?, ?, ?)', key, tool, JSON.stringify(result), Date.now());
      if (Math.random() < 0.01) db.run('DELETE FROM agent_calls WHERE created_at < ?', Date.now() - KEY_TTL_MS);
    }
    return result;
  };
  return { result: key ? db.tx(run) : run() };
}
