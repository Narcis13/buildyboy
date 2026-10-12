import { createHash, randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import type { HookInput, PendingActionView, PendingKind, PendingStatus } from '../../shared/types.ts';
import { json } from '../db.ts';

export function matchKey(toolName: string | null | undefined, input: unknown): string {
  return createHash('sha256').update(`${toolName ?? ''}|${JSON.stringify(input ?? null)}`).digest('hex').slice(0, 32);
}

interface PendingRow {
  id: string;
  session_id: string;
  kind: PendingKind;
  tool_name: string | null;
  match_key: string | null;
  request_json: string;
  status: PendingStatus;
  response_json: string | null;
  created_at: number;
  expires_at: number | null;
  answered_at: number | null;
  answered_by: string | null;
}

export function toView(r: PendingRow): PendingActionView {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    status: r.status,
    toolName: r.tool_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    answeredAt: r.answered_at,
    answeredBy: r.answered_by,
    request: json(r.request_json, {}) ?? {},
    response: json(r.response_json),
  };
}

export function getPending(ctx: Ctx, id: string): PendingActionView | null {
  const r = ctx.db.get<PendingRow>('SELECT * FROM pending_actions WHERE id = ?', id);
  return r ? toView(r) : null;
}

export function listPending(ctx: Ctx, status: 'pending' | 'history', limit = 100): PendingActionView[] {
  const rows = status === 'pending'
    ? ctx.db.all<PendingRow>("SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?", limit)
    : ctx.db.all<PendingRow>("SELECT * FROM pending_actions WHERE status != 'pending' ORDER BY COALESCE(answered_at, created_at) DESC LIMIT ?", limit);
  return rows.map(toView);
}

function publishInbox(ctx: Ctx, sessionId: string) {
  ctx.bus.publish('inbox', 'changed');
  ctx.bus.publish('floor', 'session', { id: sessionId });
  ctx.bus.publish(`session:${sessionId}`, 'pending');
}

export function createPending(
  ctx: Ctx,
  p: { sessionId: string; kind: PendingKind; toolName?: string | null; matchKey?: string | null; request: PendingActionView['request']; waitMs: number },
): string {
  const id = randomUUID();
  const now = Date.now();
  ctx.db.run(
    'INSERT INTO pending_actions (id, session_id, kind, tool_name, match_key, request_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, p.sessionId, p.kind, p.toolName ?? null, p.matchKey ?? null, JSON.stringify(p.request), 'pending', now, now + p.waitMs,
  );
  publishInbox(ctx, p.sessionId);
  const what = p.kind === 'stop_wait' ? 'Turn finished — waiting for your next instruction'
    : p.kind === 'plan' ? 'Plan waiting for approval'
    : p.kind === 'question' ? 'Claude is asking a question'
    : p.kind === 'pause' ? 'Session paused'
    : `${p.toolName ?? 'Tool'} needs permission`;
  if (p.kind !== 'pause') {
    ctx.notify({
      type: p.kind === 'stop_wait' ? 'turn_done' : 'pending',
      title: what,
      body: [p.request.projectName, p.request.sessionName].filter(Boolean).join(' · ') || p.sessionId.slice(0, 8),
      sessionId: p.sessionId,
      actionId: id,
      url: `/inbox#${id}`,
      actions: p.kind === 'permission',
    });
  }
  return id;
}

function finish(ctx: Ctx, id: string, status: PendingStatus, response: Record<string, unknown> | null, by: string | null): boolean {
  const r = ctx.db.run(
    "UPDATE pending_actions SET status = ?, response_json = ?, answered_at = ?, answered_by = ? WHERE id = ? AND status = 'pending'",
    status, response ? JSON.stringify(response) : null, Date.now(), by, id,
  );
  if (!r.changes) return false;
  const row = ctx.db.get<{ session_id: string }>('SELECT session_id FROM pending_actions WHERE id = ?', id)!;
  publishInbox(ctx, row.session_id);
  const w = ctx.waiters.get(id);
  if (w) {
    ctx.waiters.delete(id);
    w(status === 'answered' ? response : null);
  }
  return true;
}

/** Waits for an answer. Resolves null on timeout, supersede or abort (the local prompt/default applies). */
export function waitFor(ctx: Ctx, id: string, ms: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const timer = setTimeout(() => {
      ctx.waiters.delete(id);
      finish(ctx, id, 'timeout', null, null);
      settle(null);
    }, ms);
    const onAbort = () => {
      ctx.waiters.delete(id);
      finish(ctx, id, 'timeout', null, 'hook-closed');
      settle(null);
    };
    signal?.addEventListener('abort', onAbort);
    ctx.waiters.set(id, settle);
  });
}

export function answerPending(ctx: Ctx, id: string, response: Record<string, unknown>, by: string): boolean {
  const row = ctx.db.get<{ session_id: string; created_at: number; kind: string; tool_name: string | null }>('SELECT session_id, created_at, kind, tool_name FROM pending_actions WHERE id = ?', id);
  const ok = finish(ctx, id, 'answered', response, by);
  if (ok && row) {
    const secs = Math.round((Date.now() - row.created_at) / 1000);
    const verb = response.type === 'allow' ? 'Allowed' : response.type === 'deny' ? 'Denied' : response.type === 'answers' ? 'Answered' : response.type === 'reply' ? 'Replied' : 'Released';
    const summary = `${verb}${row.tool_name ? ` ${row.tool_name}` : ''} by ${by} after ${secs}s`;
    ctx.db.run(
      'INSERT INTO events (hash, session_id, ts, event, tool_name, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), row.session_id, Date.now(), 'Decision', row.tool_name, summary, JSON.stringify({ actionId: id, kind: row.kind, response, by, waitedMs: Date.now() - row.created_at }),
    );
    ctx.bus.publish(`session:${row.session_id}`, 'timeline');
  }
  return ok;
}

const ENDS_TOOL = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
const ENDS_TURN = new Set(['Stop', 'UserPromptSubmit', 'SessionEnd', 'StopFailure']);

/** Case (c): a later event shows the session moved on, so the human answered locally. */
export function supersedeOnEvent(ctx: Ctx, sessionId: string, e: HookInput) {
  const rows = ctx.db.all<{ id: string; kind: string; match_key: string | null }>(
    "SELECT id, kind, match_key FROM pending_actions WHERE session_id = ? AND status = 'pending'", sessionId,
  );
  if (!rows.length) return;
  const name = e.hook_event_name;
  for (const r of rows) {
    let sup = false;
    if (r.kind === 'stop_wait') sup = name === 'UserPromptSubmit' || name === 'SessionEnd';
    else if (r.kind === 'pause') sup = name === 'SessionEnd';
    else sup = ENDS_TURN.has(name) || (ENDS_TOOL.has(name) && r.match_key === matchKey(e.tool_name, e.tool_input));
    if (sup) finish(ctx, r.id, 'superseded', null, 'local');
  }
}
