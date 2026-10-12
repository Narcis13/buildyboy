// Job lifecycle on the server: create, dispatch to runners, apply runner events, reconcile, lost detection.
// The server owns the queue; runners re-check limits and answer `queued` when busy (see runner/main.ts).
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { rulesFor } from '../redaction.ts';
import type { JobStatus, RunnerCommand, RunnerEvent } from '../../shared/types.ts';
import { json } from '../db.ts';
import { jobView } from '../queries.ts';
import { redactText } from '../../shared/redact.ts';
import { checkOptions, OptionError, type StoredJobOptions } from '../../runner/options.ts';

export const OUTPUT_CAP = 20_000;
export const LOST_AFTER_MS = 2 * 60_000;
export const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'stopped', 'lost'];

export class JobError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export interface RunnerInfo {
  version?: string;
  allowedRoots?: string[];
  concurrency?: number;
  claudeVersion?: string | null;
  platform?: string;
  running?: { jobId: string; sessionId: string | null }[];
}

export function runnerInfo(ctx: Ctx, machineId: string): RunnerInfo | null {
  return json<RunnerInfo>(ctx.db.get<{ runner_info_json: string | null }>('SELECT runner_info_json FROM machines WHERE id = ?', machineId)?.runner_info_json ?? null);
}

/** Path comparison across platforms: forward slashes, no trailing slash, lower case for Windows-style paths. */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
}

export function under(child: string, root: string): boolean {
  const c = normPath(child);
  const r = normPath(root);
  return c === r || c.startsWith(r.endsWith('/') ? r : r + '/');
}

/** "One running job per repo": the longest known project root containing cwd, else cwd itself. */
function repoKey(ctx: Ctx, machineId: string, cwd: string): string {
  let best = '';
  for (const p of ctx.db.all<{ root_path: string }>('SELECT root_path FROM projects WHERE machine_id = ?', machineId)) {
    if (under(cwd, p.root_path) && p.root_path.length > best.length) best = p.root_path;
  }
  return normPath(best || cwd);
}

export interface NewJob {
  promptId?: number | null;
  promptText?: string | null;
  machineId: string;
  cwd: string;
  title?: string | null;
  options: unknown;
  scheduleId?: string | null;
  rerunOf?: string | null;
}

/** Inserts a queued job and tries to dispatch it. Throws JobError on bad input. */
export function createJob(ctx: Ctx, input: NewJob): string {
  const { db } = ctx;
  if (!db.get('SELECT 1 FROM machines WHERE id = ? AND revoked = 0', input.machineId)) throw new JobError(400, 'unknown machine');
  let options: StoredJobOptions;
  try {
    options = checkOptions(input.options);
  } catch (e) {
    if (e instanceof OptionError) throw new JobError(400, e.message);
    throw e;
  }
  let text = input.promptText?.trim() ? input.promptText : null;
  let title = input.title?.trim() || null;
  if (input.promptId != null) {
    const p = db.get<{ title: string; rendered: string }>('SELECT title, rendered FROM prompts WHERE id = ?', input.promptId);
    if (!p) throw new JobError(400, 'unknown prompt');
    text ??= p.rendered;
    title ??= p.title;
  }
  if (!text) throw new JobError(400, 'promptId or promptText is required');
  title ??= (/^\s*(?:[-*]\s+)?(?:\*\*)?Goal:(?:\*\*)?\s*(.+)$/im.exec(text)?.[1] ?? text.split('\n').map((l) => l.replace(/^[#\s]+/, '').trim()).find(Boolean) ?? 'Job').slice(0, 80);
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO jobs (id, prompt_id, machine_id, cwd, title, prompt_text, options_json, status, created_at, updated_at, schedule_id, rerun_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    id, input.promptId ?? null, input.machineId, input.cwd, title, text, JSON.stringify(options), now, now, input.scheduleId ?? null, input.rerunOf ?? null,
  );
  ctx.bus.publish('jobs', 'changed', { id });
  dispatch(ctx, input.machineId);
  return id;
}

export function sendToRunner(ctx: Ctx, machineId: string, cmd: RunnerCommand | Record<string, unknown>): boolean {
  const send = ctx.runners.get(machineId);
  if (!send) return false;
  send(cmd);
  return true;
}

/** Sends queued jobs to connected runners within their concurrency and one-per-repo limits. */
export function dispatch(ctx: Ctx, machineId?: string) {
  const { db } = ctx;
  for (const m of machineId ? [machineId] : [...ctx.runners.keys()]) {
    if (!ctx.runners.has(m)) continue;
    const limit = Math.max(1, Math.floor(runnerInfo(ctx, m)?.concurrency ?? 2));
    const active = db.all<{ cwd: string }>("SELECT cwd FROM jobs WHERE machine_id = ? AND status IN ('starting','running')", m);
    let slots = limit - active.length;
    if (slots <= 0) continue;
    const busy = new Set(active.map((j) => repoKey(ctx, m, j.cwd)));
    for (const q of db.all<{ id: string; cwd: string }>("SELECT id, cwd FROM jobs WHERE machine_id = ? AND status = 'queued' ORDER BY created_at", m)) {
      if (slots <= 0) break;
      const key = repoKey(ctx, m, q.cwd);
      if (busy.has(key)) continue;
      const now = Date.now();
      db.run("UPDATE jobs SET status = 'starting', dispatched_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'", now, now, q.id);
      const job = jobView(ctx, q.id)!;
      if (!sendToRunner(ctx, m, { type: 'job', job })) {
        db.run("UPDATE jobs SET status = 'queued', dispatched_at = NULL WHERE id = ?", q.id);
        break;
      }
      busy.add(key);
      slots--;
      ctx.bus.publish('jobs', 'changed', { id: q.id });
    }
  }
}

function notifyEnd(ctx: Ctx, id: string) {
  const j = jobView(ctx, id);
  if (!j) return;
  if (j.sessionId) ctx.bus.publish('floor', 'session', { id: j.sessionId });
  if (j.status === 'stopped') return;
  const reason = typeof j.result?.reason === 'string' ? j.result.reason : '';
  ctx.notify({
    type: 'job',
    title: `Job ${j.status}: ${j.title ?? j.id.slice(0, 8)}`,
    body: [j.machineName, j.costUsd != null ? `$${j.costUsd.toFixed(2)}` : null, j.status !== 'succeeded' ? reason : null].filter(Boolean).join(' · '),
    sessionId: j.sessionId ?? undefined,
    url: `/jobs/${id}`,
  });
}

/** Applies a batch of runner events to one of this machine's jobs. */
export function applyRunnerEvents(ctx: Ctx, machineId: string, jobId: string, events: RunnerEvent[]) {
  const rules = rulesFor(ctx);
  const { db } = ctx;
  const j = db.get<{ machine_id: string; status: JobStatus; output_lines: number; options_json: string }>('SELECT machine_id, status, output_lines, options_json FROM jobs WHERE id = ?', jobId);
  if (!j || j.machine_id !== machineId) throw new JobError(404, 'job not found');
  let status = j.status;
  let ended = false;
  let output = false;
  db.tx(() => {
    const now = Date.now();
    for (const ev of events) {
      if (ev.type === 'output') {
        const base = Number(db.get<{ n: number }>('SELECT output_lines n FROM jobs WHERE id = ?', jobId)!.n);
        const room = Math.max(0, OUTPUT_CAP - base);
        ev.lines.slice(0, room).forEach((line, i) => db.run('INSERT OR IGNORE INTO job_output (job_id, seq, ts, line_json) VALUES (?, ?, ?, ?)', jobId, base + i, now, redactText(String(line), rules)));
        if (room > 0 && ev.lines.length > room) db.run('INSERT OR IGNORE INTO job_output (job_id, seq, ts, line_json) VALUES (?, ?, ?, ?)', jobId, OUTPUT_CAP, now, JSON.stringify({ type: 'buildyboy_truncated', note: `output capped at ${OUTPUT_CAP} lines` }));
        db.run('UPDATE jobs SET output_lines = output_lines + ? WHERE id = ?', ev.lines.length, jobId);
        output = true;
      } else if (ev.type === 'verify') {
        db.run('UPDATE jobs SET verify_json = ? WHERE id = ?', JSON.stringify({ ranAt: now, results: ev.results.map((r) => ({ ...r, output: redactText(String(r.output ?? ''), rules).slice(0, 64 * 1024) })) }), jobId);
      } else if (ev.type === 'status') {
        // a finished job stays finished; only a job we gave up on (lost) may still report its real end
        if (TERMINAL.includes(status) && status !== 'lost') continue;
        const sid = ev.sessionId ?? null;
        if (ev.status === 'queued') {
          db.run("UPDATE jobs SET status = 'queued', dispatched_at = NULL, result_json = ? WHERE id = ?", JSON.stringify(ev.result ?? null), jobId);
        } else if (ev.status === 'starting' || ev.status === 'running') {
          if (status === 'lost') continue;
          db.run('UPDATE jobs SET status = ?, started_at = COALESCE(started_at, ?), session_id = COALESCE(?, session_id) WHERE id = ?', ev.status, now, sid, jobId);
        } else if (TERMINAL.includes(ev.status)) {
          db.run(
            'UPDATE jobs SET status = ?, ended_at = ?, exit_code = ?, cost_usd = COALESCE(?, cost_usd), result_json = ?, session_id = COALESCE(?, session_id) WHERE id = ?',
            ev.status, now, ev.exitCode ?? null, ev.costUsd ?? null, JSON.stringify(ev.result ?? null), sid, jobId,
          );
          ended = true;
        }
        status = ev.status;
      }
    }
    db.run('UPDATE jobs SET updated_at = ? WHERE id = ?', now, jobId);
    // walk mode chosen at launch applies to the session once its row exists (hooks create it)
    const walk = json<StoredJobOptions>(j.options_json)?.walkMode;
    if (walk !== undefined) db.run('UPDATE sessions SET walk_mode = ? WHERE id = (SELECT session_id FROM jobs WHERE id = ?) AND walk_mode IS NULL', walk ? 1 : 0, jobId);
  });
  ctx.bus.publish('jobs', 'changed', { id: jobId });
  if (output) ctx.bus.publish(`job:${jobId}`, 'output');
  if (ended) {
    notifyEnd(ctx, jobId);
    dispatch(ctx, machineId);
  }
}

function markLost(ctx: Ctx, ids: string[]) {
  for (const id of ids) {
    ctx.db.run("UPDATE jobs SET status = 'lost', ended_at = ?, result_json = ? WHERE id = ? AND status IN ('starting','running')", Date.now(), JSON.stringify({ reason: 'runner lost contact with the job' }), id);
    ctx.bus.publish('jobs', 'changed', { id });
    notifyEnd(ctx, id);
  }
}

/** On heartbeat: jobs the runner doesn't list are re-queued (never arrived) or lost (vanished mid-run). */
export function reconcile(ctx: Ctx, machineId: string, runningIds: string[], now = Date.now()) {
  const running = new Set(runningIds);
  const rows = ctx.db.all<{ id: string; status: string; dispatched_at: number | null; updated_at: number | null }>(
    "SELECT id, status, dispatched_at, updated_at FROM jobs WHERE machine_id = ? AND status IN ('starting','running')", machineId,
  );
  const lost: string[] = [];
  for (const r of rows) {
    if (running.has(r.id)) continue;
    if (r.status === 'starting' && (r.dispatched_at ?? 0) < now - 60_000) {
      ctx.db.run("UPDATE jobs SET status = 'queued', dispatched_at = NULL WHERE id = ? AND status = 'starting'", r.id);
      ctx.bus.publish('jobs', 'changed', { id: r.id });
    } else if (r.status === 'running' && (r.updated_at ?? 0) < now - LOST_AFTER_MS) lost.push(r.id);
  }
  markLost(ctx, lost);
}

/** Jobs on runners that have been disconnected for over 2 minutes are lost. */
export function markLostDisconnected(ctx: Ctx, now = Date.now()) {
  const rows = ctx.db.all<{ id: string; machine_id: string; seen: number | null }>(
    "SELECT j.id, j.machine_id, m.runner_seen_at seen FROM jobs j JOIN machines m ON m.id = j.machine_id WHERE j.status IN ('starting','running')",
  );
  markLost(ctx, rows.filter((r) => !ctx.runners.has(r.machine_id) && (r.seen ?? 0) < now - LOST_AFTER_MS).map((r) => r.id));
}

/** Backticked commands from the prompt's `Done when:` slot (inline or the numbered/bulleted lines under it). */
export function doneWhenCommands(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*(?:[-*]\s+)?(?:\*\*)?Done when:/i.test(l));
  if (i < 0) return [];
  const chunk = [lines[i]];
  for (let k = i + 1; k < lines.length && (/^\s+\S/.test(lines[k]) || /^\s*(?:\d+[.)]|[-*])\s/.test(lines[k])); k++) {
    if (/^\s*(?:[-*]\s+)?\*\*[\w ]+:\*\*/.test(lines[k])) break; // next slot in the list-styled preview
    chunk.push(lines[k]);
  }
  const out: string[] = [];
  for (const m of chunk.join('\n').matchAll(/`([^`\n]+)`/g)) {
    const c = m[1].trim();
    if (c && !c.startsWith('/') && !/^https?:/i.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}
