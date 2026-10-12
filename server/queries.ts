import type { Ctx } from './context.ts';
import type { AttentionSummary, JobOptions, JobStatus, JobView, MachineSummary, QueuedMessageView, SessionDetail, SessionSummary, TimelineItem, TimelinePage, ToolToken } from '../shared/types.ts';
import { json } from './db.ts';
import { sessionWalk, machineWalk } from './control/state.ts';
import { isStale } from './ingest/status.ts';

const ONLINE_MS = 5 * 60 * 1000;

interface SessionRow {
  id: string; machine_id: string; machine_name: string; platform: string | null; project_id: number | null; project_name: string | null; cwd: string | null;
  source: string; name: string | null; model: string | null; effort: string | null; permission_mode: string | null; transcript_path: string | null;
  parent_session_id: string | null; job_id: string | null; status: string; status_reason: string | null; activity: string | null;
  started_at: number; last_event_at: number; ended_at: number | null; end_reason: string | null; cost_usd: number;
  tokens_input: number; tokens_output: number; tokens_cache_read: number; tokens_cache_write: number; context_pct: number | null;
  compactions: number; wait_ms: number; waiting_since: number | null; lines_added: number; lines_removed: number; git_branch: string | null; git_dirty: number | null;
  start_sha: string | null; end_sha: string | null; walk_mode: number | null; stop_wait_min: number | null; remote_control: string | null;
  kill_requested: number; paused: number; imported: number; pending_count: number;
}

const SESSION_SELECT = `SELECT s.*, m.name AS machine_name, m.platform AS platform, p.name AS project_name,
  (SELECT COUNT(*) FROM pending_actions a WHERE a.session_id = s.id AND a.status = 'pending' AND a.kind != 'pause') AS pending_count
  FROM sessions s JOIN machines m ON m.id = s.machine_id LEFT JOIN projects p ON p.id = s.project_id`;

function belt(ctx: Ctx, sid: string): ToolToken[] {
  return ctx.db
    .all<{ tool_use_id: string; tool_name: string; status: string }>('SELECT tool_use_id, tool_name, status FROM tool_calls WHERE session_id = ? ORDER BY started_at DESC LIMIT 20', sid)
    .reverse()
    .map((r) => ({ id: r.tool_use_id, tool: r.tool_name, status: r.status as ToolToken['status'] }));
}

function summary(ctx: Ctx, r: SessionRow): SessionSummary {
  const status = isStale(r.status as never, r.last_event_at) ? 'stale' : (r.status as SessionSummary['status']);
  let job: SessionSummary['job'] = null;
  if (r.job_id) {
    const j = ctx.db.get<{ id: string; status: string; options_json: string; started_at: number | null }>('SELECT id, status, options_json, started_at FROM jobs WHERE id = ?', r.job_id);
    if (j) {
      const o = json<JobOptions & { limitMinutes?: number }>(j.options_json, null);
      job = { id: j.id, status: j.status as JobStatus, maxBudgetUsd: o?.maxBudgetUsd ?? null, deadline: o?.limitMinutes && j.started_at ? j.started_at + o.limitMinutes * 60000 : null };
    }
  }
  return {
    id: r.id,
    machineId: r.machine_id,
    machineName: r.machine_name,
    projectId: r.project_id,
    projectName: r.project_name,
    cwd: r.cwd,
    source: r.source as SessionSummary['source'],
    name: r.name,
    model: r.model,
    status,
    statusReason: r.status_reason,
    activity: r.activity,
    branch: r.git_branch,
    dirty: !!r.git_dirty,
    startedAt: r.started_at,
    lastEventAt: r.last_event_at,
    endedAt: r.ended_at,
    costUsd: r.cost_usd,
    contextPct: r.context_pct,
    jobId: r.job_id,
    walkMode: sessionWalk(ctx, r.id),
    belt: belt(ctx, r.id),
    drones: ctx.db.all<{ agentId: string; agentType: string | null }>("SELECT agent_id AS agentId, agent_type AS agentType FROM subagents WHERE session_id = ? AND status = 'running' AND ended_at IS NULL", r.id),
    pendingCount: Number(r.pending_count),
    imported: !!r.imported,
    job,
  };
}

export function listSessions(ctx: Ctx, f: { live?: boolean; since?: number; projectId?: number; machineId?: string; limit?: number } = {}): SessionSummary[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.live) where.push("s.status != 'ended' AND s.last_event_at > ?") && params.push(Date.now() - 24 * 3600 * 1000);
  if (f.since) where.push('s.last_event_at >= ?') && params.push(f.since);
  if (f.projectId) where.push('s.project_id = ?') && params.push(f.projectId);
  if (f.machineId) where.push('s.machine_id = ?') && params.push(f.machineId);
  const sql = `${SESSION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.last_event_at DESC LIMIT ?`;
  return ctx.db.all<SessionRow>(sql, ...params, f.limit ?? 200).map((r) => summary(ctx, r));
}

export function sessionDetail(ctx: Ctx, id: string): SessionDetail | null {
  const r = ctx.db.get<SessionRow>(`${SESSION_SELECT} WHERE s.id = ?`, id);
  if (!r) return null;
  const base = summary(ctx, r);
  const totalIn = r.tokens_input + r.tokens_cache_read + r.tokens_cache_write;
  return {
    ...base,
    effort: r.effort,
    permissionMode: r.permission_mode,
    transcriptPath: r.transcript_path,
    parentSessionId: r.parent_session_id,
    endReason: r.end_reason,
    tokens: { input: r.tokens_input, output: r.tokens_output, cacheRead: r.tokens_cache_read, cacheWrite: r.tokens_cache_write },
    cacheHitPct: totalIn ? Math.round((r.tokens_cache_read / totalIn) * 1000) / 10 : null,
    compactions: r.compactions,
    waitMs: r.wait_ms + (r.waiting_since ? Date.now() - r.waiting_since : 0),
    linesAdded: r.lines_added,
    linesRemoved: r.lines_removed,
    startSha: r.start_sha,
    endSha: r.end_sha,
    remoteControl: r.remote_control,
    paused: !!r.paused,
    killRequested: !!r.kill_requested,
    stopWaitMin: r.stop_wait_min ?? ctx.config.stopWaitMin,
    platform: r.platform,
  };
}

const TIMELINE_EVENTS = ['Notification', 'PreCompact', 'PostCompact', 'StopFailure', 'PermissionRequest', 'PermissionDenied', 'Decision', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd', 'Watcher', 'Stop'];

function levelOf(event: string, payload: Record<string, unknown>): 'info' | 'warn' | 'error' {
  if (event === 'StopFailure') return 'error';
  if (event === 'PermissionDenied' || event === 'Watcher' || event === 'PermissionRequest') return 'warn';
  if (event === 'Notification' && payload.notification_type === 'permission_prompt') return 'warn';
  return 'info';
}

/** Merged, chronological timeline. `cursor` is the ts to page back from (exclusive). */
export function timeline(ctx: Ctx, sid: string, cursor?: number, limit = 1000): TimelinePage {
  const before = cursor ?? Number.MAX_SAFE_INTEGER;
  const items: TimelineItem[] = [];
  const hasPromptEvents = !!ctx.db.get("SELECT 1 FROM events WHERE session_id = ? AND event = 'UserPromptSubmit' LIMIT 1", sid);

  for (const t of ctx.db.all<{ tool_use_id: string; tool_name: string; mcp_server: string | null; status: string; input_json: string | null; output_text: string | null; output_len: number | null; duration_ms: number | null; exit_code: number | null; file_path: string | null; command: string | null; agent_id: string | null; started_at: number; patch: string | null }>(
    `SELECT t.*, (SELECT group_concat(f.patch, char(10)) FROM file_changes f WHERE f.tool_use_id = t.tool_use_id) AS patch
     FROM tool_calls t WHERE t.session_id = ? AND t.started_at < ? ORDER BY t.started_at DESC LIMIT ?`, sid, before, limit)) {
    items.push({
      kind: 'tool', id: t.tool_use_id, ts: t.started_at, tool: t.tool_name, mcpServer: t.mcp_server, status: t.status as never,
      input: json(t.input_json), output: t.output_text, outputLen: t.output_len, durationMs: t.duration_ms, exitCode: t.exit_code,
      filePath: t.file_path, command: t.command, agentId: t.agent_id, patch: t.patch,
    });
  }

  for (const m of ctx.db.all<{ uuid: string; role: string | null; kind: string; ts: number; model: string | null; text: string | null; content_json: string; agent_id: string | null }>(
    "SELECT uuid, role, kind, ts, model, text, content_json, agent_id FROM messages WHERE session_id = ? AND ts < ? AND kind IN ('text','thinking','prompt','raw','system') ORDER BY ts DESC LIMIT ?", sid, before, limit)) {
    if (m.kind === 'text' && m.text) items.push({ kind: 'assistant', id: m.uuid, ts: m.ts, text: m.text, model: m.model, agentId: m.agent_id });
    else if (m.kind === 'thinking' && m.text) items.push({ kind: 'thinking', id: m.uuid, ts: m.ts, text: m.text, agentId: m.agent_id });
    else if (m.kind === 'prompt' && m.text && (!hasPromptEvents || m.agent_id)) items.push({ kind: 'prompt', id: m.uuid, ts: m.ts, text: m.text, agentId: m.agent_id });
    else if (m.kind === 'system' && m.text) items.push({ kind: 'event', id: m.uuid, ts: m.ts, event: 'System', summary: m.text.slice(0, 300), level: 'info', agentId: m.agent_id });
    else if (m.kind === 'raw') items.push({ kind: 'raw', id: m.uuid, ts: m.ts, data: json(m.content_json, m.content_json), agentId: m.agent_id });
  }

  for (const ev of ctx.db.all<{ id: number; ts: number; event: string; summary: string | null; payload_json: string; agent_id: string | null }>(
    `SELECT id, ts, event, summary, payload_json, agent_id FROM events WHERE session_id = ? AND ts < ? AND event IN ('UserPromptSubmit', ${TIMELINE_EVENTS.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT ?`,
    sid, before, ...TIMELINE_EVENTS, limit)) {
    const p = json<Record<string, unknown>>(ev.payload_json, {}) ?? {};
    if (ev.event === 'UserPromptSubmit') {
      items.push({ kind: 'prompt', id: `ev-${ev.id}`, ts: ev.ts, text: String(p.prompt ?? ''), agentId: ev.agent_id });
      continue;
    }
    delete p._env;
    delete p._git;
    items.push({ kind: 'event', id: `ev-${ev.id}`, ts: ev.ts, event: ev.event, summary: ev.summary ?? ev.event, level: levelOf(ev.event, p), data: p, agentId: ev.agent_id });
  }

  items.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  let page = items;
  let next: string | null = null;
  if (items.length > limit) {
    page = items.slice(items.length - limit);
    const boundary = page[0].ts;
    page = items.filter((i) => i.ts >= boundary);
    next = String(boundary);
  }
  return { items: page, cursor: next };
}

export function attention(ctx: Ctx): AttentionSummary {
  const since = Date.now() - 24 * 3600 * 1000;
  const q = (sql: string, ...p: (string | number)[]) => Number(ctx.db.get<{ n: number }>(sql, ...p)?.n ?? 0);
  const working = ctx.db.all<{ status: string; last_event_at: number }>("SELECT status, last_event_at FROM sessions WHERE status = 'working'");
  return {
    waiting: q(
      `SELECT COUNT(*) n FROM sessions WHERE (status = 'waiting' AND last_event_at > ?)
       OR id IN (SELECT session_id FROM pending_actions WHERE status = 'pending' AND kind != 'pause')`, since,
    ),
    pending: q("SELECT COUNT(*) n FROM pending_actions WHERE status = 'pending' AND kind != 'pause'"),
    jobsFailed: q("SELECT COUNT(*) n FROM jobs WHERE status IN ('failed','lost') AND COALESCE(ended_at, created_at) > ?", since),
    stale: working.filter((w) => isStale('working', w.last_event_at)).length,
  };
}

export function listMachines(ctx: Ctx): MachineSummary[] {
  const now = Date.now();
  return ctx.db
    .all<{ id: string; name: string; hostname: string | null; platform: string | null; claude_version: string | null; hook_version: string | null; runner_online: number; last_seen: number | null; spool_bytes: number | null; walk_mode: number | null; revoked: number }>(
      'SELECT * FROM machines ORDER BY name',
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      hostname: m.hostname,
      platform: m.platform,
      claudeVersion: m.claude_version,
      hookVersion: m.hook_version,
      online: !m.revoked && ((m.last_seen ?? 0) > now - ONLINE_MS || !!m.runner_online),
      runnerOnline: !!m.runner_online && ctx.runners.has(m.id),
      lastSeen: m.last_seen,
      spoolBytes: m.spool_bytes,
      walkMode: m.walk_mode == null ? null : m.walk_mode === 1,
      revoked: !!m.revoked,
    }));
}

export function effectiveMachineWalk(ctx: Ctx, id: string) {
  return machineWalk(ctx, id);
}

export function queuedMessages(ctx: Ctx, sid: string): QueuedMessageView[] {
  return ctx.db
    .all<{ id: string; session_id: string; text: string; mode: string; status: string; created_at: number; delivered_at: number | null; delivered_via: string | null }>(
      'SELECT * FROM queued_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 50', sid,
    )
    .map((q) => ({ id: q.id, sessionId: q.session_id, text: q.text, mode: q.mode as never, status: q.status as never, createdAt: q.created_at, deliveredAt: q.delivered_at, deliveredVia: q.delivered_via }));
}

export function jobView(ctx: Ctx, id: string): JobView | null {
  const j = ctx.db.get<Record<string, unknown>>('SELECT j.*, m.name AS machine_name FROM jobs j JOIN machines m ON m.id = j.machine_id WHERE j.id = ?', id);
  return j ? rowToJob(j) : null;
}

export function rowToJob(j: Record<string, unknown>): JobView {
  return {
    id: String(j.id),
    promptId: (j.prompt_id as number | null) ?? null,
    machineId: String(j.machine_id),
    machineName: (j.machine_name as string | undefined) ?? undefined,
    cwd: String(j.cwd),
    title: (j.title as string | null) ?? null,
    promptText: String(j.prompt_text),
    options: json<JobOptions>(j.options_json, { maxBudgetUsd: 5 })!,
    sessionId: (j.session_id as string | null) ?? null,
    status: j.status as JobStatus,
    exitCode: (j.exit_code as number | null) ?? null,
    costUsd: (j.cost_usd as number | null) ?? null,
    result: json(j.result_json),
    createdAt: Number(j.created_at),
    startedAt: (j.started_at as number | null) ?? null,
    endedAt: (j.ended_at as number | null) ?? null,
    verify: json(j.verify_json),
  };
}
