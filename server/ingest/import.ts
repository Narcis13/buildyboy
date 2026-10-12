// Backfill (`bb import`): uploads existing transcripts. Imported sessions have no hook events, so tool calls and file
// changes are synthesized from the transcript's tool_use / tool_result blocks. Parsing is tolerant: unknown lines stay raw.
import type { Ctx } from '../context.ts';
import { applyTranscript, mcpServerOf, sourceFrom, OUTPUT_CAP } from './derive.ts';
import { redactTranscriptLine } from '../../shared/redact.ts';
import { diffLines, diffStats, unifiedDiff } from '../../shared/diff.ts';

export interface ImportChunk {
  sessionId: string;
  path?: string;
  lines: string[];
}

function ts(v: unknown): number | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
}

export function importChunk(ctx: Ctx, machineId: string, chunk: ImportChunk): { created: boolean; skipped?: string } {
  const { db } = ctx;
  const sid = chunk.sessionId;
  const existing = db.get<{ machine_id: string; imported: number }>('SELECT machine_id, imported FROM sessions WHERE id = ?', sid);
  if (existing && existing.machine_id !== machineId) return { created: false, skipped: 'belongs to another machine' };

  const parsed: Record<string, any>[] = [];
  for (const l of chunk.lines) {
    try {
      parsed.push(JSON.parse(l));
    } catch {
      // kept as raw by applyTranscript
    }
  }
  const times = parsed.map((o) => ts(o.timestamp)).filter((t): t is number => t != null);
  const first = times.length ? Math.min(...times) : Date.now();
  const last = times.length ? Math.max(...times) : first;
  const cwd = parsed.find((o) => typeof o.cwd === 'string')?.cwd ?? null;
  const entry = parsed.find((o) => typeof o.entrypoint === 'string')?.entrypoint;
  const branch = parsed.find((o) => typeof o.gitBranch === 'string')?.gitBranch ?? null;

  return db.tx(() => {
    let created = false;
    if (!existing) {
      let projectId: number | null = null;
      if (cwd) {
        const name = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
        db.run('INSERT INTO projects (machine_id, root_path, name) VALUES (?, ?, ?) ON CONFLICT(machine_id, root_path) DO NOTHING', machineId, cwd, name);
        projectId = db.get<{ id: number }>('SELECT id FROM projects WHERE machine_id = ? AND root_path = ?', machineId, cwd)!.id;
      }
      db.run(
        `INSERT INTO sessions (id, machine_id, project_id, cwd, source, transcript_path, status, started_at, last_event_at, ended_at, end_reason, imported, git_branch)
         VALUES (?, ?, ?, ?, ?, ?, 'ended', ?, ?, ?, 'imported', 1, ?)`,
        sid, machineId, projectId, cwd, sourceFrom({ CLAUDE_CODE_ENTRYPOINT: entry ?? '' }), chunk.path ?? null, first, last, last, branch,
      );
      created = true;
    } else {
      db.run('UPDATE sessions SET started_at = MIN(started_at, ?), last_event_at = MAX(last_event_at, ?) WHERE id = ?', first, last, sid);
    }
    applyTranscript(ctx, sid, chunk.lines, null);
    if (created || existing?.imported) synthesizeTools(ctx, sid, chunk.lines);
    return { created };
  });
}

/** tool_use blocks → tool_calls; tool_result blocks → output/status; Edit/Write → file_changes. */
function synthesizeTools(ctx: Ctx, sid: string, lines: string[]) {
  const { db } = ctx;
  const envIds = new Set<string>();
  for (const raw of lines) {
    let o: any;
    try {
      o = JSON.parse(redactTranscriptLine(raw, envIds));
    } catch {
      continue;
    }
    const t = ts(o.timestamp) ?? Date.now();
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    const agentId = typeof o.agentId === 'string' ? o.agentId : null;
    for (const b of content) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const filePath = typeof input.file_path === 'string' ? input.file_path : null;
        const r = db.run(
          `INSERT OR IGNORE INTO tool_calls (tool_use_id, session_id, agent_id, tool_name, mcp_server, input_json, status, started_at, file_path, command)
           VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)`,
          b.id, sid, agentId, String(b.name), mcpServerOf(String(b.name)), JSON.stringify(input), t, filePath, typeof input.command === 'string' ? input.command : null,
        );
        if (r.changes && filePath && (b.name === 'Edit' || b.name === 'Write')) {
          const before = b.name === 'Edit' ? String(input.old_string ?? '') : '';
          const after = b.name === 'Edit' ? String(input.new_string ?? '') : String(input.content ?? '');
          const st = diffStats(diffLines(before, after));
          db.run('INSERT OR IGNORE INTO file_changes (session_id, tool_use_id, ts, path, op, added, removed, patch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sid, b.id, t, filePath, b.name === 'Edit' ? 'edit' : 'write', st.added, st.removed, unifiedDiff(before, after, filePath).slice(0, 64 * 1024));
        }
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? '').join('\n') : JSON.stringify(b.content ?? '');
        db.run(
          `UPDATE tool_calls SET output_text = ?, output_len = ?, status = ?, ended_at = ?, duration_ms = MAX(0, ? - started_at) WHERE tool_use_id = ? AND session_id = ?`,
          text.slice(0, OUTPUT_CAP), text.length, b.is_error ? 'error' : 'ok', t, t, b.tool_use_id, sid,
        );
      }
    }
  }
}
