// Agent tokens and the agent API (SPEC §11.1). `bb mcp` calls POST /api/agent/<tool> with an agent token: a bearer
// token separate from machine tokens, limited to the MCP tools below and revocable from the PWA.
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Ctx } from '../context.ts';
import { randomToken, sha256 } from '../auth.ts';
import { listSessions, sessionDetail } from '../queries.ts';
import { promptStore } from '../routes/prompts.ts';
import { lintPrompt, parseTemplate, renderTemplate } from '../../shared/harness.ts';
import { LAUNCH_SCOPES, TOOLS, TOOL_NAMES, type AgentTokenView, type LaunchScope, type ToolArgs, type ToolName } from '../../shared/factory.ts';
import { agentGuide } from '../docs/reference.ts';
import { governor, readUsage } from './governor.ts';
import { ackControls, claimTask, controls, createTask, FactoryError, getTask, listTasks, recordGate, taskSummary, updateTask } from './tasks.ts';
import { askDecision, getDecision } from './decisions.ts';
import { sendDigest } from './digest.ts';
import { listFindings, updateFindings } from './findings.ts';
import { gateRunStatus, startGateRun, startStepRun } from './gateruns.ts';
import { agentLaunch, launchScope, listMachines } from './launch.ts';
import { cancelScheduled, listScheduled } from './schedule.ts';
import { getProject, listProjects } from './projects.ts';
import { requestPlan } from './plan.ts';
import {
  factoryStatus, hasScope, listOperatorDecisions, requireScope, operatorAnswer, operatorControl, operatorInbox, operatorInboxAnswer, operatorSaveProject, operatorSetProject,
} from './operator.ts';

export function createAgentToken(ctx: Ctx, name: string): { id: string; token: string } {
  const id = randomUUID();
  const token = `bba_${randomToken(24)}`;
  ctx.db.run('INSERT INTO agent_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', id, name, sha256(token), Date.now());
  return { id, token };
}

export function listAgentTokens(ctx: Ctx): AgentTokenView[] {
  return ctx.db
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null; launch: string; launch_approval: number; operator: number; inbox: number }>(
      'SELECT * FROM agent_tokens ORDER BY created_at DESC',
    )
    .map((r) => ({
      id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
      launch: (LAUNCH_SCOPES as readonly string[]).includes(r.launch) ? (r.launch as LaunchScope) : 'off', launchApproval: r.launch_approval !== 0,
      operator: r.operator === 1, inbox: r.inbox === 1,
    }));
}

export interface TokenScopes {
  launch?: LaunchScope;
  launchApproval?: boolean;
  operator?: boolean;
  inbox?: boolean;
}

/**
 * Settings → Factory → Agent tokens: what a token may launch, whether each launch waits for the owner's approval, and
 * whether it acts for the owner (operator) or answers the Inbox (inbox), §12.7.
 */
export function setTokenLaunch(ctx: Ctx, id: string, p: TokenScopes): AgentTokenView | null {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  const col = (name: string, v: string | number | undefined) => {
    if (v === undefined) return;
    sets.push(`${name} = ?`);
    args.push(v);
  };
  const bit = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
  col('launch', p.launch);
  col('launch_approval', bit(p.launchApproval));
  col('operator', bit(p.operator));
  col('inbox', bit(p.inbox));
  if (sets.length && !ctx.db.run(`UPDATE agent_tokens SET ${sets.join(', ')} WHERE id = ? AND revoked_at IS NULL`, ...args, id).changes) return null;
  return listAgentTokens(ctx).find((t) => t.id === id && !t.revokedAt) ?? null;
}
export const setTokenScopes = setTokenLaunch;

export function revokeAgentToken(ctx: Ctx, id: string): boolean {
  return ctx.db.run('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), id).changes > 0;
}

export interface AgentIdentity {
  id: string;
  name: string;
  /** §12.7 scopes, read with the token */
  operator: boolean;
  inbox: boolean;
}

export function agentFromToken(ctx: Ctx, auth: string | undefined): AgentIdentity | null {
  const m = /^Bearer\s+(bba_\S+)$/i.exec(auth ?? '');
  if (!m) return null;
  const row = ctx.db.get<{ id: string; name: string; revoked_at: number | null; last_used_at: number | null; operator: number; inbox: number }>(
    'SELECT id, name, revoked_at, last_used_at, operator, inbox FROM agent_tokens WHERE token_hash = ?', sha256(m[1]),
  );
  if (!row || row.revoked_at) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > 30_000) ctx.db.run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', Date.now(), row.id);
  return { id: row.id, name: row.name, operator: row.operator === 1, inbox: row.inbox === 1 };
}

/** The Caller of an authenticated agent: what the handlers check (launch scope, operator, inbox, self-answers). */
export const callerOf = (a: AgentIdentity): Caller => ({ tokenId: a.id, operator: a.operator, inbox: a.inbox });

export function requireAgent(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    const a = agentFromToken(ctx, c.req.header('authorization'));
    if (!a) return c.json({ error: 'unauthorized' }, 401);
    c.set('agent' as never, a as never);
    await next();
  };
}

/**
 * Who calls: the agent token's id (its launch permission lives there; it also tells a token's own decisions apart),
 * null when there is none, and its §12.7 scopes. A caller built without the scopes has them read from the token.
 */
export interface Caller {
  tokenId: string | null;
  operator?: boolean;
  inbox?: boolean;
}

/** An operator token acts for the owner (§12.7, `agent_tokens.operator`, off by default). */
export function isOperator(ctx: Ctx, tokenId: string | null): boolean {
  return !!tokenId && !!ctx.db.get('SELECT 1 FROM agent_tokens WHERE id = ? AND operator = 1 AND revoked_at IS NULL', tokenId);
}

type Handler<T extends ToolName> = (ctx: Ctx, args: ToolArgs<T>, actor: string, caller: Caller) => unknown;

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
  tasks_list: (ctx, a) => listTasks(ctx, { status: a.status, ready: a.ready, limit: a.limit, project: a.project, archived: a.archived }),
  tasks_get: (ctx, a) => getTask(ctx, a.id),
  tasks_create: (ctx, a, actor) => createTask(ctx, { ...a, source: 'agent' }, actor),
  tasks_claim: (ctx, a, actor) => claimTask(ctx, a, actor),
  tasks_update: (ctx, a, actor, caller) => {
    // archiving is the owner's, or an operator's (§12.2, §12.7)
    if (a.archived !== undefined && !hasScope(ctx, caller, 'operator')) {
      throw new FactoryError(403, 'only the owner or an operator token may archive packages: the owner turns on “Operator” for this token in Settings → Factory → Agent tokens');
    }
    return updateTask(ctx, a, actor);
  },
  projects_list: (ctx, a) => listProjects(ctx, { state: a.state }),
  projects_get: (ctx, a) => getProject(ctx, a.key),
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
  steps_run: (ctx, a, actor) => {
    const { id, status, round, machineId, sent } = startStepRun(ctx, { taskId: a.taskId, step: a.step, args: a.args }, actor);
    return { runId: id, step: a.step, status, round, machineId, sent, ...(sent ? {} : { note: 'the runner is not connected; the run starts when gates_status finds it back' }) };
  },
  findings_list: (ctx, a) => listFindings(ctx, a),
  findings_update: (ctx, a, actor) => updateFindings(ctx, a.ids, a.status, a.note?.trim() || null, actor),
  decision_ask: (ctx, a, actor, caller) => askDecision(ctx, a, actor, caller.tokenId),
  decision_get: (ctx, a) => {
    const d = getDecision(ctx, a.id);
    if (!d) throw new FactoryError(404, `unknown decision ${a.id}`);
    return d;
  },
  digest_post: (ctx, a) => sendDigest(ctx, 'manual', a.note ?? null),
  machines_list: (ctx) => listMachines(ctx),
  tasks_launch: (ctx, a, actor, caller) => agentLaunch(ctx, 'worker', a, actor, caller.tokenId),
  coordinator_launch: (ctx, a, actor, caller) => agentLaunch(ctx, 'coordinator', a, actor, caller.tokenId),
  schedules_list: (ctx, a) => listScheduled(ctx, a),
  schedule_cancel: (ctx, a, actor, caller) =>
    cancelScheduled(ctx, a.id, actor, (kind) => {
      const { scope } = launchScope(ctx, caller.tokenId);
      return scope === 'all' || (scope === 'workers' && kind === 'worker') || hasScope(ctx, caller, 'operator');
    }),
  control_get: (ctx, a, actor) => {
    const open = controls(ctx, { taskId: a.taskId });
    if (!a.ack || !open.length) return { requests: open, acked: false };
    ackControls(ctx, open.map((r) => r.id), actor);
    const ids = new Set(open.map((r) => r.id));
    return { requests: controls(ctx, { taskId: a.taskId, all: true }).filter((r) => ids.has(r.id)), acked: true };
  },
  // operators (§12.7, server/factory/operator.ts)
  factory_status: (ctx, a, actor, caller) => factoryStatus(ctx, a, actor, caller),
  decisions_list: (ctx, a, actor, caller) => listOperatorDecisions(ctx, a, actor, caller),
  decision_answer: (ctx, a, actor, caller) => operatorAnswer(ctx, a.id, a.answer, actor, caller),
  decision_cancel: (ctx, a, actor, caller) => operatorAnswer(ctx, a.id, null, actor, caller),
  control_request: (ctx, a, actor, caller) => operatorControl(ctx, a, actor, caller),
  projects_save: (ctx, a, actor, caller) => operatorSaveProject(ctx, a, actor, caller),
  projects_set: (ctx, a, actor, caller) => operatorSetProject(ctx, a, actor, caller),
  plan_request: (ctx, a, actor, caller) => {
    requireScope(ctx, caller, 'operator', 'request plans');
    return requestPlan(ctx, a, actor);
  },
  inbox_list: (ctx, a, _actor, caller) => operatorInbox(ctx, a, caller),
  inbox_answer: (ctx, a, actor, caller) => operatorInboxAnswer(ctx, a, actor, caller),
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
export function callTool(ctx: Ctx, name: string, rawArgs: unknown, actor: string, key: string | null = null, caller: Caller = { tokenId: null }): { result: unknown; replayed?: true } {
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
    const result = (HANDLERS[tool] as (ctx: Ctx, a: unknown, actor: string, caller: Caller) => unknown)(ctx, parsed.data, actor, caller) ?? null;
    if (key) {
      db.run('INSERT INTO agent_calls (key, tool, result_json, created_at) VALUES (?, ?, ?, ?)', key, tool, JSON.stringify(result), Date.now());
      if (Math.random() < 0.01) db.run('DELETE FROM agent_calls WHERE created_at < ?', Date.now() - KEY_TTL_MS);
    }
    return result;
  };
  return { result: key ? db.tx(run) : run() };
}
