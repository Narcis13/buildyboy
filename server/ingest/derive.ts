import { createHash } from 'node:crypto';
import type { Ctx } from '../context.ts';
import type { HookEnvelope, HookInput, SessionSource, SessionStatus } from '../../shared/types.ts';
import { redactHookEvent, redactTranscriptLine, redactValue } from '../../shared/redact.ts';
import { diffLines, diffStats, unifiedDiff } from '../../shared/diff.ts';
import { nextStatus } from './status.ts';
import { parseTranscriptLine } from './transcript.ts';
import { supersedeOnEvent } from '../control/pending.ts';
import { indexText } from '../search.ts';

export const OUTPUT_CAP = 64 * 1024;
const PATCH_CAP = 64 * 1024;

export class IngestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function eventHash(machineId: string, env: HookEnvelope): string {
  const e = env.event;
  // Tool events are unique per (event, tool_use_id); the PreToolUse telemetry and control paths dedupe here.
  const salt = e.tool_use_id ? '' : String(env.ts);
  return createHash('sha256').update(`${machineId}|${JSON.stringify(e)}|${salt}`).digest('hex');
}

export function sourceFrom(env: Record<string, string>): SessionSource {
  if (env.BUILDYBOY_JOB_ID) return 'headless';
  const ep = env.CLAUDE_CODE_ENTRYPOINT ?? '';
  if (ep === 'cli') return 'cli';
  if (ep === 'claude-desktop' || ep.includes('desktop')) return 'desktop';
  if (ep === 'sdk-cli') return 'headless';
  if (ep.startsWith('sdk')) return 'sdk';
  if (ep.includes('bg') || ep.includes('background')) return 'bg';
  return 'unknown';
}

function sourceFromEntrypoint(ep: string | undefined): SessionSource | null {
  if (!ep) return null;
  const s = sourceFrom({ CLAUDE_CODE_ENTRYPOINT: ep });
  return s === 'unknown' ? null : s;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function shorten(s: string, n = 90): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function relPath(p: string | null, cwd: string | null): string {
  if (!p) return '';
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase())) return p.slice(cwd.length).replace(/^[\\/]/, '') || p;
  return p;
}

export function mcpServerOf(tool: string): string | null {
  const m = /^mcp__(.+?)__/.exec(tool);
  return m ? m[1] : null;
}

/** "Bash: npm test", "Editing server/db.ts", ... */
export function activityFor(tool: string, input: Record<string, unknown> | undefined, cwd: string | null): string {
  const i = input ?? {};
  const file = relPath(str(i.file_path) ?? str(i.notebook_path) ?? str(i.path), cwd);
  switch (tool) {
    case 'Bash':
      return `Bash: ${shorten(str(i.command) ?? '', 70)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${file}`;
    case 'Read':
      return `Reading ${file}`;
    case 'Grep':
      return `Grep: ${shorten(str(i.pattern) ?? '', 60)}`;
    case 'Glob':
      return `Glob: ${shorten(str(i.pattern) ?? '', 60)}`;
    case 'WebFetch':
      return `Fetching ${shorten(str(i.url) ?? '', 60)}`;
    case 'WebSearch':
      return `Searching “${shorten(str(i.query) ?? '', 60)}”`;
    case 'Agent':
    case 'Task':
      return `Agent: ${shorten(str(i.description) ?? str(i.subagent_type) ?? '', 60)}`;
    case 'TodoWrite':
      return 'Updating todos';
    case 'AskUserQuestion':
      return 'Asking a question';
    case 'ExitPlanMode':
      return 'Proposing a plan';
    default: {
      const server = mcpServerOf(tool);
      if (server) return `${server}: ${tool.slice(`mcp__${server}__`.length)}`;
      return tool;
    }
  }
}

export function summarize(e: HookInput, cwd: string | null): string {
  const tool = e.tool_name ?? '';
  switch (e.hook_event_name) {
    case 'UserPromptSubmit':
      return `Prompt: ${shorten(String(e.prompt ?? ''), 120)}`;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest':
      return activityFor(tool, e.tool_input, cwd);
    case 'PostToolUseFailure':
      return `${tool} failed: ${shorten(String(e.error ?? ''), 100)}`;
    case 'PermissionDenied':
      return `${tool} denied: ${shorten(String(e.reason ?? ''), 100)}`;
    case 'Notification':
      return shorten(String(e.message ?? e.notification_type ?? 'Notification'), 120);
    case 'SubagentStart':
      return `Subagent started: ${e.agent_type ?? e.agent_id}`;
    case 'SubagentStop':
      return `Subagent finished: ${e.agent_type ?? e.agent_id}`;
    case 'PreCompact':
      return `Compacting (${e.trigger ?? 'auto'})`;
    case 'PostCompact':
      return 'Compaction finished';
    case 'Stop':
      return 'Turn finished';
    case 'StopFailure':
      return `Stopped with error: ${shorten(String(e.error ?? e.reason ?? e.message ?? ''), 100)}`;
    case 'SessionStart':
      return `Session started (${e.source ?? 'startup'})`;
    case 'SessionEnd':
      return `Session ended (${e.reason ?? 'other'})`;
    default:
      return e.hook_event_name;
  }
}

/** Output text for a tool_response, plus an exit code when one can be inferred. */
export function toolOutput(tool: string, resp: unknown): { text: string; exitCode: number | null } {
  if (resp == null) return { text: '', exitCode: null };
  if (typeof resp === 'string') return { text: resp, exitCode: null };
  if (tool === 'Bash' && typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    const out = [str(r.stdout) ?? '', r.stderr ? `[stderr]\n${r.stderr}` : ''].filter(Boolean).join('\n');
    const code = typeof r.exitCode === 'number' ? r.exitCode : typeof r.exit_code === 'number' ? r.exit_code : r.interrupted ? null : 0;
    return { text: out, exitCode: code };
  }
  if (Array.isArray(resp)) {
    // MCP-style content blocks
    const t = resp.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n');
    return { text: t, exitCode: null };
  }
  return { text: JSON.stringify(resp, null, 2), exitCode: null };
}

function cap(text: string, n = OUTPUT_CAP): string {
  return text.length > n ? `${text.slice(0, n)}\n… [truncated ${text.length - n} chars]` : text;
}

function fileChangesFor(tool: string, input: Record<string, unknown>): { path: string; op: string; patch: string; added: number; removed: number }[] {
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (!path) return [];
  if (tool === 'Edit') {
    const lines = diffLines(String(input.old_string ?? ''), String(input.new_string ?? ''));
    return [{ path, op: 'edit', patch: unifiedDiff(String(input.old_string ?? ''), String(input.new_string ?? ''), path), ...diffStats(lines) }];
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0;
    let removed = 0;
    const patches: string[] = [];
    for (const ed of input.edits as Record<string, unknown>[]) {
      const a = String(ed.old_string ?? '');
      const b = String(ed.new_string ?? '');
      const s = diffStats(diffLines(a, b));
      added += s.added;
      removed += s.removed;
      patches.push(unifiedDiff(a, b, path));
    }
    return [{ path, op: 'edit', patch: patches.join('\n'), added, removed }];
  }
  if (tool === 'Write') {
    const content = String(input.content ?? '');
    return [{ path, op: 'write', patch: unifiedDiff('', content, path), added: content === '' ? 0 : content.split(/\r?\n/).length, removed: 0 }];
  }
  if (tool === 'NotebookEdit') return [{ path, op: 'edit', patch: String(input.new_source ?? ''), added: 0, removed: 0 }];
  return [];
}

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function parseRemote(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

const PRICES: Record<string, [number, number, number, number]> = {
  // $/MTok: input, output, cache read, cache write (estimates, used only when no authoritative cost exists)
  opus: [5, 25, 0.5, 6.25],
  sonnet: [3, 15, 0.3, 3.75],
  haiku: [1, 5, 0.1, 1.25],
};

export function estimateCost(model: string | null, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const fam = model ? Object.keys(PRICES).find((k) => model.toLowerCase().includes(k)) : undefined;
  const p = PRICES[fam ?? 'sonnet'];
  return (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheWrite * p[3]) / 1e6;
}

export interface IngestResult {
  duplicate: boolean;
  sessionId: string;
  eventId: number | null;
}

/** Ingests one hook envelope from an authenticated machine. Idempotent by event hash. */
export function ingestEnvelope(ctx: Ctx, machineId: string, env: HookEnvelope): IngestResult {
  const { db } = ctx;
  const raw = env.event;
  if (!raw || typeof raw !== 'object' || typeof raw.session_id !== 'string' || !raw.session_id || typeof raw.hook_event_name !== 'string') {
    throw new IngestError(400, 'event.session_id and event.hook_event_name are required');
  }
  const e = redactHookEvent(raw);
  const sid = e.session_id;
  const now = Date.now();
  const ts = typeof env.ts === 'number' && env.ts > 0 ? env.ts : now;
  const hash = eventHash(machineId, env);
  const name = e.hook_event_name;
  const envVars = env.env ?? {};

  const owner = db.get<{ machine_id: string }>('SELECT machine_id FROM sessions WHERE id = ?', sid);
  if (owner && owner.machine_id !== machineId) throw new IngestError(403, 'session belongs to another machine');

  return db.tx(() => {
    db.run(
      `UPDATE machines SET last_seen = ?, hostname = COALESCE(?, hostname), platform = COALESCE(?, platform), arch = COALESCE(?, arch),
       user = COALESCE(?, user), hook_version = COALESCE(?, hook_version), spool_bytes = COALESCE(?, spool_bytes) WHERE id = ?`,
      now, env.hostname ?? null, env.platform ?? null, env.arch ?? null, env.user ?? null, env.hookVersion ?? null, env.spoolBytes ?? null, machineId,
    );

    const cwd = str(e.cwd);
    const summary = summarize(e, cwd);
    const ins = db.run(
      'INSERT OR IGNORE INTO events (hash, session_id, agent_id, ts, event, tool_name, tool_use_id, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      hash, sid, str(e.agent_id), ts, name, str(e.tool_name), str(e.tool_use_id), summary, JSON.stringify({ ...e, _env: envVars, _git: env.git ?? null }),
    );
    const duplicate = ins.changes === 0;
    const eventId = duplicate ? null : Number(ins.lastInsertRowid);

    // project
    const root = env.git?.root ?? envVars.CLAUDE_PROJECT_DIR ?? cwd;
    let projectId: number | null = null;
    if (root) {
      const remote = env.git?.remote ?? null;
      const gh = parseRemote(remote ?? undefined);
      const pname = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
      db.run(
        `INSERT INTO projects (machine_id, root_path, name, git_remote, gh_owner, gh_repo) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id, root_path) DO UPDATE SET git_remote = COALESCE(excluded.git_remote, git_remote),
         gh_owner = COALESCE(excluded.gh_owner, gh_owner), gh_repo = COALESCE(excluded.gh_repo, gh_repo)`,
        machineId, root, pname, remote, gh?.owner ?? null, gh?.repo ?? null,
      );
      projectId = Number(db.get<{ id: number }>('SELECT id FROM projects WHERE machine_id = ? AND root_path = ?', machineId, root)!.id);
    }

    // session
    let s = db.get<{ status: SessionStatus; start_sha: string | null; waiting_since: number | null; source: string; started_at: number; last_event_at: number }>(
      'SELECT status, start_sha, waiting_since, source, started_at, last_event_at FROM sessions WHERE id = ?', sid,
    );
    if (!s) {
      db.run(
        `INSERT INTO sessions (id, machine_id, project_id, cwd, source, transcript_path, job_id, status, started_at, last_event_at, remote_control, parent_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
        sid, machineId, projectId, cwd, sourceFrom(envVars), str(e.transcript_path), envVars.BUILDYBOY_JOB_ID ?? null, ts, ts,
        envVars.CLAUDE_CODE_BRIDGE_SESSION_ID ?? null, null,
      );
      s = { status: 'idle', start_sha: null, waiting_since: null, source: sourceFrom(envVars), started_at: ts, last_event_at: ts };
      if (envVars.BUILDYBOY_JOB_ID) {
        db.run("UPDATE jobs SET session_id = COALESCE(session_id, ?), status = CASE WHEN status IN ('queued','starting') THEN 'running' ELSE status END WHERE id = ?", sid, envVars.BUILDYBOY_JOB_ID);
      }
      indexText(db, 'session', sid, sid, `${sid} ${cwd ?? ''}`);
    }

    if (!duplicate) applyEvent(ctx, sid, e, ts, env, cwd, projectId, s);

    for (const t of env.transcripts ?? []) applyTranscript(ctx, sid, t.lines, t.agentId ?? null);

    if (env.progress && typeof env.progress.content === 'string') {
      db.run('INSERT OR IGNORE INTO progress_docs (session_id, ts, hash, content) VALUES (?, ?, ?, ?)', sid, ts, env.progress.hash, redactValue(env.progress.content).slice(0, 32 * 1024));
    }

    if (!duplicate && env.git) applyGit(ctx, sid, projectId, name, ts, env, s.start_sha);

    if (!duplicate) supersedeOnEvent(ctx, sid, e);

    return { duplicate, sessionId: sid, eventId };
  });
}

function applyEvent(
  ctx: Ctx, sid: string, e: HookInput, ts: number, env: HookEnvelope, cwd: string | null, projectId: number | null,
  s: { status: SessionStatus; waiting_since: number | null; last_event_at: number },
) {
  const { db } = ctx;
  const name = e.hook_event_name;
  const tool = str(e.tool_name);
  const input = (e.tool_input ?? {}) as Record<string, unknown>;
  const tuid = str(e.tool_use_id);
  const isSub = !!e.agent_id;

  // Out-of-order async events must not rewind status.
  const inOrder = ts >= s.last_event_at || name === 'SessionEnd' || name === 'Stop';
  let status = s.status;
  if (inOrder) {
    // inside a subagent, only permission prompts change the parent's state; everything else proves it's working
    status = isSub && name !== 'PermissionRequest' ? (s.status === 'waiting' ? 'waiting' : nextStatus(s.status, 'PostToolUse')) : nextStatus(s.status, name, e);
  }
  let waitingSince = s.waiting_since;
  let waitAdd = 0;
  if (status === 'waiting' && s.status !== 'waiting') waitingSince = ts;
  if (status !== 'waiting' && s.status === 'waiting' && waitingSince) {
    waitAdd = Math.max(0, ts - waitingSince);
    waitingSince = null;
  }

  const activity = tool && (name === 'PreToolUse' || name === 'PermissionRequest') ? activityFor(tool, input, cwd) : name === 'Stop' ? 'Waiting for prompt' : name === 'UserPromptSubmit' ? 'Thinking…' : name === 'PreCompact' ? 'Compacting context' : null;

  db.run(
    `UPDATE sessions SET last_event_at = MAX(last_event_at, ?), status = ?, status_reason = ?, waiting_since = ?, wait_ms = wait_ms + ?,
     activity = COALESCE(?, activity), cwd = COALESCE(cwd, ?), project_id = COALESCE(project_id, ?),
     permission_mode = COALESCE(?, permission_mode), effort = COALESCE(?, effort), transcript_path = COALESCE(transcript_path, ?),
     model = COALESCE(?, model), name = COALESCE(name, ?), remote_control = COALESCE(?, remote_control),
     job_id = COALESCE(job_id, ?) WHERE id = ?`,
    ts, status, name === 'StopFailure' ? summarize(e, cwd) : name === 'Notification' ? str(e.message) : null, waitingSince, waitAdd,
    activity, cwd, projectId,
    isSub ? null : str(e.permission_mode), str(e.effort), str(e.transcript_path),
    str(e.model), str(e.session_title), env.env?.CLAUDE_CODE_BRIDGE_SESSION_ID ?? null,
    env.env?.BUILDYBOY_JOB_ID ?? null, sid,
  );
  if (name === 'SessionStart' && e.source === 'resume') db.run('UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?', sid);
  if (name === 'SessionEnd') db.run('UPDATE sessions SET ended_at = ?, end_reason = ?, activity = NULL WHERE id = ?', ts, str(e.reason) ?? 'other', sid);
  if (name === 'PreCompact') db.run('UPDATE sessions SET compactions = compactions + 1 WHERE id = ?', sid);

  // tool calls
  if (tool && tuid) {
    const mcp = mcpServerOf(tool);
    const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
    const command = str(input.command);
    if (name === 'PreToolUse') {
      db.run(
        `INSERT INTO tool_calls (tool_use_id, session_id, agent_id, tool_name, mcp_server, input_json, status, started_at, file_path, command)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?) ON CONFLICT(tool_use_id) DO NOTHING`,
        tuid, sid, str(e.agent_id), tool, mcp, JSON.stringify(input), ts, filePath, command,
      );
      if (command) indexText(db, 'command', tuid, sid, command);
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure' || name === 'PermissionDenied') {
      const failed = name !== 'PostToolUse';
      const out = name === 'PostToolUse' ? toolOutput(tool, e.tool_response) : { text: String(e.error ?? e.reason ?? ''), exitCode: null };
      let exitCode = out.exitCode;
      if (name === 'PostToolUseFailure') {
        const m = /exit code (\d+)/i.exec(out.text);
        exitCode = m ? Number(m[1]) : null;
      }
      const st = name === 'PermissionDenied' ? 'denied' : name === 'PostToolUseFailure' ? (e.is_interrupt ? 'interrupted' : 'error') : 'ok';
      const dur = typeof e.duration_ms === 'number' ? e.duration_ms : null;
      db.run(
        `INSERT INTO tool_calls (tool_use_id, session_id, agent_id, tool_name, mcp_server, input_json, output_text, output_len, status, started_at, ended_at, duration_ms, file_path, command, exit_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_use_id) DO UPDATE SET output_text = excluded.output_text, output_len = excluded.output_len, status = excluded.status,
         ended_at = excluded.ended_at, duration_ms = COALESCE(excluded.duration_ms, excluded.ended_at - tool_calls.started_at), exit_code = excluded.exit_code`,
        tuid, sid, str(e.agent_id), tool, mcp, JSON.stringify(input), cap(out.text), out.text.length, st, dur != null ? ts - dur : ts, ts, dur, filePath, command, exitCode,
      );
      if (!failed) {
        for (const fc of fileChangesFor(tool, input)) {
          const r = db.run('INSERT OR IGNORE INTO file_changes (session_id, tool_use_id, ts, path, op, added, removed, patch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sid, tuid, ts, fc.path, fc.op, fc.added, fc.removed, fc.patch.slice(0, PATCH_CAP));
          if (r.changes) db.run('UPDATE sessions SET lines_added = lines_added + ?, lines_removed = lines_removed + ? WHERE id = ?', fc.added, fc.removed, sid);
        }
        if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
          db.run('INSERT INTO todos (session_id, ts, items_json) VALUES (?, ?, ?)', sid, ts, JSON.stringify(input.todos));
        }
        if (tool === 'TaskCreate' || tool === 'TaskUpdate') applyTaskTool(ctx, sid, ts, tool, input, e.tool_response);
        if (tool === 'Bash' && command && /\bgh\s+pr\s+create\b/.test(command)) {
          const m = PR_RE.exec(out.text);
          if (m) linkPr(ctx, sid, projectId, m[0]);
        }
      }
    }
  }

  if (name === 'SubagentStart' && e.agent_id) {
    const desc = db.get<{ input_json: string }>(
      "SELECT input_json FROM tool_calls WHERE session_id = ? AND tool_name IN ('Agent','Task') ORDER BY started_at DESC LIMIT 1", sid,
    );
    let description: string | null = null;
    try {
      description = desc ? (JSON.parse(desc.input_json).description ?? null) : null;
    } catch {
      // ignore
    }
    db.run('INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO NOTHING', e.agent_id, sid, str(e.agent_type), description, ts);
  }
  if (name === 'SubagentStop' && e.agent_id) {
    db.run(
      "INSERT INTO subagents (agent_id, session_id, agent_type, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?, 'done') ON CONFLICT(agent_id) DO UPDATE SET ended_at = excluded.ended_at, status = 'done'",
      e.agent_id, sid, str(e.agent_type), ts, ts,
    );
  }
  if (name === 'UserPromptSubmit' && typeof e.prompt === 'string') indexText(db, 'prompt', `ev-${sid}-${ts}`, sid, e.prompt);
}

function applyTaskTool(ctx: Ctx, sid: string, ts: number, tool: string, input: Record<string, unknown>, resp: unknown) {
  const last = ctx.db.get<{ items_json: string }>('SELECT items_json FROM todos WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1', sid);
  let items: Record<string, unknown>[] = [];
  try {
    items = last ? JSON.parse(last.items_json) : [];
  } catch {
    items = [];
  }
  if (tool === 'TaskCreate') {
    const r = (resp && typeof resp === 'object' ? resp : {}) as Record<string, unknown>;
    const task = (r.task as Record<string, unknown> | undefined) ?? {};
    items.push({ id: String(task.id ?? r.id ?? items.length + 1), content: String(input.subject ?? input.description ?? ''), status: 'pending' });
  } else {
    const id = String(input.taskId ?? input.id ?? '');
    const it = items.find((x) => String(x.id) === id);
    if (it && typeof input.status === 'string') it.status = input.status;
  }
  ctx.db.run('INSERT INTO todos (session_id, ts, items_json) VALUES (?, ?, ?)', sid, ts, JSON.stringify(items));
}

export function linkPr(ctx: Ctx, sid: string | null, projectId: number | null, url: string) {
  const num = Number(url.split('/').pop());
  ctx.db.run(
    'INSERT INTO pull_requests (project_id, number, url, session_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET session_id = COALESCE(pull_requests.session_id, excluded.session_id)',
    projectId, num, url, sid, Date.now(),
  );
}

function applyGit(ctx: Ctx, sid: string, projectId: number | null, trigger: string, ts: number, env: HookEnvelope, startSha: string | null) {
  const { db } = ctx;
  const g = env.git!;
  db.run(
    'INSERT INTO git_snapshots (session_id, ts, trigger, branch, sha, ahead, behind, dirty, shortstat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sid, ts, trigger, g.branch ?? null, g.sha ?? null, g.ahead ?? null, g.behind ?? null, g.dirty ?? null, g.shortstat ?? null,
  );
  db.run(
    'UPDATE sessions SET git_branch = COALESCE(?, git_branch), git_dirty = COALESCE(?, git_dirty), start_sha = COALESCE(start_sha, ?), end_sha = CASE WHEN ? IN (\'Stop\',\'SessionEnd\') THEN COALESCE(?, end_sha) ELSE end_sha END WHERE id = ?',
    g.branch ?? null, g.dirty ?? null, startSha ? null : (g.sha ?? null), trigger, g.sha ?? null, sid,
  );
  if (g.lastCommit?.sha) {
    const c = g.lastCommit;
    db.run(
      'INSERT INTO commits (sha, project_id, session_id, ts, message, author, files, added, removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha) DO NOTHING',
      c.sha, projectId, sid, c.ts || ts, redactValue(c.message), c.author, c.files, c.added, c.removed,
    );
  }
  if (g.prUrl) linkPr(ctx, sid, projectId, g.prUrl);
}

/** Parses transcript JSONL lines into messages and session patches. Deduplicated by uuid. */
export function applyTranscript(ctx: Ctx, sid: string, lines: string[], agentId: string | null) {
  const { db } = ctx;
  const envIds = new Set<string>();
  let usageChanged = false;
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const line = redactTranscriptLine(rawLine, envIds);
    const { message: m, patch } = parseTranscriptLine(line, agentId);
    if (m) {
      const r = db.run(
        `INSERT OR IGNORE INTO messages (uuid, session_id, parent_uuid, agent_id, role, kind, ts, model, api_message_id, text, content_json, usage_json, is_sidechain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.uuid, sid, m.parentUuid, m.agentId, m.role, m.kind, m.ts, m.model, m.apiMessageId, m.text, m.contentJson, m.usage ? JSON.stringify(m.usage) : null, m.isSidechain ? 1 : 0,
      );
      if (r.changes) {
        if (m.usage) usageChanged = true;
        if (m.model && !m.isSidechain) db.run('UPDATE sessions SET model = ? WHERE id = ?', m.model, sid);
        if (m.text && (m.kind === 'text' || m.kind === 'prompt')) indexText(db, 'message', m.uuid, sid, m.text);
      }
    }
    if (patch) {
      if (patch.name) db.run('UPDATE sessions SET name = ? WHERE id = ?', patch.name, sid);
      if (typeof patch.costUsd === 'number') db.run("UPDATE sessions SET cost_usd = MAX(CASE WHEN cost_source = 'estimate' OR cost_source IS NULL THEN 0 ELSE cost_usd END, ?), cost_source = 'transcript' WHERE id = ?", patch.costUsd, sid);
      if (typeof patch.linesAdded === 'number') db.run('UPDATE sessions SET lines_added = MAX(lines_added, ?), lines_removed = MAX(lines_removed, ?) WHERE id = ?', patch.linesAdded, patch.linesRemoved ?? 0, sid);
      if (patch.prUrl) {
        const p = db.get<{ project_id: number | null }>('SELECT project_id FROM sessions WHERE id = ?', sid);
        linkPr(ctx, sid, p?.project_id ?? null, patch.prUrl);
      }
      if (patch.version) db.run('UPDATE machines SET claude_version = ? WHERE id = (SELECT machine_id FROM sessions WHERE id = ?)', patch.version, sid);
      if (patch.entrypoint) {
        const src = sourceFromEntrypoint(patch.entrypoint);
        if (src) db.run("UPDATE sessions SET source = ? WHERE id = ? AND source = 'unknown'", src, sid);
      }
    }
  }
  if (usageChanged) recomputeTokens(ctx, sid);
}

export function recomputeTokens(ctx: Ctx, sid: string) {
  const { db } = ctx;
  const t = db.get<{ i: number; o: number; cr: number; cw: number }>(
    `SELECT COALESCE(SUM(i),0) i, COALESCE(SUM(o),0) o, COALESCE(SUM(cr),0) cr, COALESCE(SUM(cw),0) cw FROM (
       SELECT MAX(COALESCE(json_extract(usage_json,'$.input_tokens'),0)) i, MAX(COALESCE(json_extract(usage_json,'$.output_tokens'),0)) o,
              MAX(COALESCE(json_extract(usage_json,'$.cache_read_input_tokens'),0)) cr, MAX(COALESCE(json_extract(usage_json,'$.cache_creation_input_tokens'),0)) cw
       FROM messages WHERE session_id = ? AND usage_json IS NOT NULL GROUP BY COALESCE(api_message_id, uuid))`,
    sid,
  )!;
  const last = db.get<{ usage_json: string; model: string | null }>(
    "SELECT usage_json, model FROM messages WHERE session_id = ? AND usage_json IS NOT NULL AND is_sidechain = 0 ORDER BY ts DESC LIMIT 1", sid,
  );
  let ctxPct: number | null = null;
  if (last) {
    try {
      const u = JSON.parse(last.usage_json);
      const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      const windowSize = last.model?.includes('[1m]') ? 1_000_000 : 200_000;
      ctxPct = Math.min(100, Math.round((used / windowSize) * 1000) / 10);
    } catch {
      // ignore
    }
  }
  const sess = db.get<{ model: string | null; cost_source: string | null }>('SELECT model, cost_source FROM sessions WHERE id = ?', sid);
  db.run(
    'UPDATE sessions SET tokens_input = ?, tokens_output = ?, tokens_cache_read = ?, tokens_cache_write = ?, context_pct = COALESCE(?, context_pct) WHERE id = ?',
    t.i, t.o, t.cr, t.cw, ctxPct, sid,
  );
  if (!sess?.cost_source || sess.cost_source === 'estimate') {
    const est = estimateCost(sess?.model ?? null, { input: t.i, output: t.o, cacheRead: t.cr, cacheWrite: t.cw });
    db.run("UPDATE sessions SET cost_usd = ?, cost_source = 'estimate' WHERE id = ?", est, sid);
  }
}
