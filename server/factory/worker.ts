// The worker as the conductor sees it (SPEC §12.5): its status line, read from the final message of its turn (the Stop
// event's `last_assistant_message` after the worker was launched or last told something; for a headless worker the
// job's result), whether it died, and the answers of the conductor's own `claude -p` jobs (foreman, planner). Reads
// the database only.
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { TERMINAL } from '../jobs/core.ts';
import type { JobStatus } from '../../shared/types.ts';
import type { WorkerStatus } from '../../shared/factory.ts';

const STATUS_RE = /^FACTORY-STATUS\s*:\s*(.*)$/i;

/**
 * The worker's status line: the last line of the message that reads `FACTORY-STATUS: done | question <text> |
 * blocked <text>`, ignoring case, Markdown around it (a quote, a list marker, backticks, bold) and trailing text after
 * `done`. Null when there is none, or the last one names no known status.
 */
export function parseStatusLine(text: string | null | undefined): WorkerStatus | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim().replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').replace(/^[`*_]+/, '').replace(/[`*_]+$/, '').trim();
    const m = STATUS_RE.exec(l);
    if (!m) continue;
    const k = /^[`*_]*(done|question|blocked)[`*_]*(?=$|[\s:.,;!—–-])[\s:.,;!—–-]*(.*)$/i.exec(m[1].trim());
    if (!k) return null;
    const kind = k[1].toLowerCase() as WorkerStatus['kind'];
    if (kind === 'done') return { kind };
    return { kind, text: k[2].trim().replace(/[`*_]+$/, '').trim() || '(no text given)' };
  }
  return null;
}

/** The newest hook event id: Stop events after it belong to a turn that started after this moment. */
export const eventMark = (ctx: Ctx) => ctx.db.get<{ m: number | null }>('SELECT MAX(id) m FROM events')?.m ?? 0;

/** The final message of the session's newest main-agent turn that ended after `mark`, or null. */
export function lastStop(ctx: Ctx, sessionId: string, mark: number): { id: number; message: string } | null {
  const r = ctx.db.get<{ id: number; payload_json: string }>(
    "SELECT id, payload_json FROM events WHERE session_id = ? AND event = 'Stop' AND agent_id IS NULL AND id > ? ORDER BY id DESC LIMIT 1", sessionId, mark,
  );
  if (!r) return null;
  const m = json<{ last_assistant_message?: unknown }>(r.payload_json, null)?.last_assistant_message;
  return { id: r.id, message: typeof m === 'string' ? m : '' };
}

export function sessionEnded(ctx: Ctx, sessionId: string): boolean {
  return ctx.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ?', sessionId)?.status === 'ended';
}

/** Counts a session on the package with this role (§11.7 task_sessions; the foreman is `coordonator`). */
export function linkSession(ctx: Ctx, taskId: string, sessionId: string | null, role: 'lucrator' | 'coordonator') {
  if (!sessionId) return;
  if (ctx.db.run('INSERT OR IGNORE INTO task_sessions (task_id, session_id, role, linked_at) VALUES (?, ?, ?, ?)', taskId, sessionId, role, Date.now()).changes) {
    ctx.bus.publish('tasks', 'changed', { id: taskId });
  }
}

export type JobAnswer =
  | { state: 'missing' }
  | { state: 'running' }
  | { state: 'ended'; status: JobStatus; text: string | null; structured: unknown; sessionId: string | null; reason: string | null; terminal: string | null };

/**
 * A finished `claude -p` job's answer: its final text and structured output. The runner keeps only the start of the
 * result text in result_json, so the last `result` line of the job's output wins when it is there.
 */
export function jobAnswer(ctx: Ctx, jobId: string): JobAnswer {
  const j = ctx.db.get<{ status: JobStatus; result_json: string | null; session_id: string | null }>('SELECT status, result_json, session_id FROM jobs WHERE id = ?', jobId);
  if (!j) return { state: 'missing' };
  if (!TERMINAL.includes(j.status)) return { state: 'running' };
  const r = json<Record<string, unknown>>(j.result_json, null) ?? {};
  let text = typeof r.result === 'string' ? r.result : null;
  let structured: unknown = r.structured_output ?? null;
  const out = ctx.db.get<{ line_json: string }>(
    `SELECT line_json FROM job_output WHERE job_id = ? AND line_json LIKE '%"type":"result"%' ORDER BY seq DESC LIMIT 1`, jobId,
  );
  const msg = out ? json<Record<string, unknown>>(out.line_json, null) : null;
  if (msg?.type === 'result') {
    if (typeof msg.result === 'string') text = msg.result;
    if (msg.structured_output != null) structured = msg.structured_output;
  }
  return {
    state: 'ended', status: j.status, text, structured, sessionId: j.session_id ?? (typeof r.session_id === 'string' ? r.session_id : null),
    reason: typeof r.reason === 'string' ? r.reason : null, terminal: typeof r.terminal === 'string' ? r.terminal : null,
  };
}
