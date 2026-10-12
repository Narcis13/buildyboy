import type { Ctx } from '../context.ts';
import type { ActionAnswer, HookEnvelope, PendingActionView, PermissionSuggestion } from '../../shared/types.ts';
import { createPending, matchKey, waitFor } from './pending.ts';
import { pauseAll, sessionWalk } from './state.ts';
import { redactValue } from '../../shared/redact.ts';
import { rulesFor } from '../redaction.ts';

type Out = Record<string, unknown> | null;

/** The Stop hook gives up after 590 s (hooks.json); hold well inside that so a late reply still reaches it. */
export const MAX_STOP_WAIT_MS = 9 * 60_000;

interface SessionCtl {
  kill_requested: number;
  paused: number;
  stop_wait_min: number | null;
  cwd: string | null;
  git_branch: string | null;
  name: string | null;
  machine_name: string | null;
  project_name: string | null;
}

function sessionCtl(ctx: Ctx, sid: string): SessionCtl | undefined {
  return ctx.db.get<SessionCtl>(
    `SELECT s.kill_requested, s.paused, s.stop_wait_min, s.cwd, s.git_branch, s.name, m.name AS machine_name, p.name AS project_name
     FROM sessions s JOIN machines m ON m.id = s.machine_id LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
    sid,
  );
}

function lastAssistantText(ctx: Ctx, sid: string): string | null {
  const r = ctx.db.get<{ text: string }>("SELECT text FROM messages WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND text IS NOT NULL AND is_sidechain = 0 ORDER BY ts DESC LIMIT 1", sid);
  return r?.text ?? null;
}

function context(ctx: Ctx, sid: string, s: SessionCtl | undefined, extra: Partial<PendingActionView['request']> = {}): PendingActionView['request'] {
  return {
    cwd: s?.cwd ?? null,
    branch: s?.git_branch ?? null,
    sessionName: s?.name ?? null,
    machineName: s?.machine_name ?? null,
    projectName: s?.project_name ?? null,
    lastAssistantMessage: lastAssistantText(ctx, sid),
    ...extra,
  };
}

/** Takes queued messages for delivery. `modes` picks which ones. */
function takeQueued(ctx: Ctx, sid: string, modes: string[], via: string): string[] {
  const rows = ctx.db.all<{ id: string; text: string }>(
    `SELECT id, text FROM queued_messages WHERE session_id = ? AND status = 'queued' AND mode IN (${modes.map(() => '?').join(',')}) ORDER BY created_at`,
    sid, ...modes,
  );
  const now = Date.now();
  for (const r of rows) ctx.db.run("UPDATE queued_messages SET status = 'delivered', delivered_at = ?, delivered_via = ? WHERE id = ?", now, via, r.id);
  if (rows.length) ctx.bus.publish(`session:${sid}`, 'queue');
  return rows.map((r) => r.text);
}

function killOutput(event: string): Out {
  const reason = 'Stopped from Buildyboy';
  const out: Record<string, unknown> = { continue: false, stopReason: reason };
  if (event === 'PreToolUse') out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
  return out;
}

/** Maps a web answer to PermissionRequest hook output. */
export function permissionOutput(answer: ActionAnswer, toolInput: Record<string, unknown>, suggestions: PermissionSuggestion[] | undefined, kind: string): Out {
  const decision: Record<string, unknown> = {};
  if (answer.type === 'allow') {
    decision.behavior = 'allow';
    if (answer.updatedInput) decision.updatedInput = answer.updatedInput;
    if (answer.scope === 'session' && suggestions?.length) {
      decision.updatedPermissions = suggestions.map((s) => ({ ...s, destination: 'session' }));
    }
  } else if (answer.type === 'deny') {
    decision.behavior = 'deny';
    decision.message = answer.message || (kind === 'plan' ? 'Plan rejected from Buildyboy.' : 'Denied from Buildyboy.');
    if (answer.interrupt) decision.interrupt = true;
  } else if (answer.type === 'answers') {
    decision.behavior = 'allow';
    decision.updatedInput = { ...toolInput, answers: answer.answers };
  } else {
    return null;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function waitPause(ctx: Ctx, sid: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let set = ctx.pauseWaiters.get(sid);
    if (!set) ctx.pauseWaiters.set(sid, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      set!.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
    set.add(done);
  });
}

export function wakePaused(ctx: Ctx, sid?: string) {
  const sets = sid ? [ctx.pauseWaiters.get(sid)] : [...ctx.pauseWaiters.values()];
  for (const set of sets) for (const fn of [...(set ?? [])]) fn();
}

/**
 * Decides the sync hook output for a control event. The envelope has already been ingested.
 * Returns null to print nothing (the local prompt or default applies).
 */
export async function decide(ctx: Ctx, env: HookEnvelope, signal?: AbortSignal): Promise<Out> {
  const e = env.event;
  const sid = e.session_id;
  const name = e.hook_event_name;
  const s = sessionCtl(ctx, sid);
  const rules = rulesFor(ctx);
  const input = redactValue(e.tool_input ?? {}, rules) as Record<string, unknown>;
  const tool = e.tool_name ?? null;

  if (name === 'PreToolUse') {
    if (s?.kill_requested) {
      ctx.db.run('UPDATE sessions SET kill_requested = 0 WHERE id = ?', sid);
      return killOutput('PreToolUse');
    }
    if (s?.paused || pauseAll(ctx)) {
      const id = createPending(ctx, { sessionId: sid, kind: 'pause', toolName: tool, request: context(ctx, sid, s, { toolInput: input }), waitMs: ctx.config.pauseWaitMs });
      await waitPause(ctx, sid, ctx.config.pauseWaitMs, signal);
      ctx.db.run("UPDATE pending_actions SET status = 'answered', answered_at = ?, answered_by = 'resume' WHERE id = ? AND status = 'pending'", Date.now(), id);
      ctx.bus.publish('inbox', 'changed');
      const again = sessionCtl(ctx, sid);
      if (again?.kill_requested) {
        ctx.db.run('UPDATE sessions SET kill_requested = 0 WHERE id = ?', sid);
        return killOutput('PreToolUse');
      }
    }
    if (tool === 'AskUserQuestion' && sessionWalk(ctx, sid)) {
      const id = createPending(ctx, { sessionId: sid, kind: 'question', toolName: tool, matchKey: matchKey(tool, input), request: context(ctx, sid, s, { toolInput: input }), waitMs: ctx.config.permissionWaitMs });
      const ans = (await waitFor(ctx, id, ctx.config.permissionWaitMs, signal)) as ActionAnswer | null;
      if (ans?.type === 'answers') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...(e.tool_input ?? {}), answers: ans.answers } } };
      }
      if (ans?.type === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ans.message || 'Declined from Buildyboy' } };
    }
    if (signal?.aborted) return null;
    const now = takeQueued(ctx, sid, ['now'], 'pre_tool_use');
    if (now.length) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Message from the user (sent via Buildyboy):\n${now.join('\n\n')}` } };
    return null;
  }

  if (name === 'PermissionRequest') {
    if (!sessionWalk(ctx, sid)) return null;
    const kind = tool === 'ExitPlanMode' ? 'plan' : tool === 'AskUserQuestion' ? 'question' : 'permission';
    const suggestions = Array.isArray(e.permission_suggestions) ? (e.permission_suggestions as PermissionSuggestion[]) : undefined;
    const id = createPending(ctx, {
      sessionId: sid, kind, toolName: tool, matchKey: matchKey(tool, input),
      request: context(ctx, sid, s, { toolInput: input, permissionSuggestions: suggestions }), waitMs: ctx.config.permissionWaitMs,
    });
    const ans = (await waitFor(ctx, id, ctx.config.permissionWaitMs, signal)) as ActionAnswer | null;
    if (!ans) return null;
    return permissionOutput(ans, (e.tool_input ?? {}) as Record<string, unknown>, suggestions, kind);
  }

  if (name === 'Stop') {
    const queued = takeQueued(ctx, sid, ['after_turn', 'now'], 'stop');
    if (queued.length) return { decision: 'block', reason: queued.join('\n\n') };
    if (!sessionWalk(ctx, sid)) return null;
    const mins = s?.stop_wait_min ?? ctx.db.getSetting<number | null>('stop_wait_min', null) ?? ctx.config.stopWaitMin;
    if (mins <= 0) return null;
    const waitMs = Math.min(mins * 60_000, MAX_STOP_WAIT_MS);
    const last = typeof e.last_assistant_message === 'string' ? redactValue(e.last_assistant_message, rules) : null;
    const id = createPending(ctx, { sessionId: sid, kind: 'stop_wait', request: context(ctx, sid, s, { lastAssistantMessage: last ?? lastAssistantText(ctx, sid) }), waitMs });
    const ans = (await waitFor(ctx, id, waitMs, signal)) as ActionAnswer | null;
    if (ans?.type === 'reply' && ans.text.trim()) return { decision: 'block', reason: ans.text };
    if (signal?.aborted) return null;
    // a message queued while we waited also counts
    const late = takeQueued(ctx, sid, ['after_turn', 'now'], 'stop');
    if (late.length) return { decision: 'block', reason: late.join('\n\n') };
    return null;
  }

  if (name === 'UserPromptSubmit') {
    const now = takeQueued(ctx, sid, ['now'], 'user_prompt');
    if (now.length) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Message from the user (sent via Buildyboy):\n${now.join('\n\n')}` } };
    return null;
  }

  return null;
}
