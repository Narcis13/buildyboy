import type { QueuedMessageView } from '../../../../shared/types.ts';

/** GET /api/sessions/:id/side (not in shared/types yet). */
export interface SideData {
  todos: { ts: number; items: { content?: string; status?: string; activeForm?: string }[] } | null;
  files: { path: string; edits: number; added: number | null; removed: number | null; lastTs: number }[];
  fileChanges: { id: number; toolUseId: string; ts: number; path: string; op: string; added: number | null; removed: number | null; patch: string | null }[];
  git: {
    snapshots: { ts: number; trigger: string; branch: string | null; sha: string | null; ahead: number | null; behind: number | null; dirty: number | null; shortstat: string | null }[];
    commits: { sha: string; ts: number; message: string; author: string | null; files: number | null; added: number | null; removed: number | null }[];
    prs: { number: number; url: string; title: string | null; state: string | null; branch: string | null; reviewState: string | null; checksState: string | null; updatedAt: number | null }[];
  };
  subagents: { agentId: string; agentType: string | null; description: string | null; startedAt: number; endedAt: number | null; status: string | null }[];
  progress: { content: string; ts: number } | null;
  queued: QueuedMessageView[];
  pending: { id: string; kind: string; toolName: string | null; createdAt: number }[];
}

/** GET /api/sessions/:id/events */
export interface RawEvent {
  id: number;
  ts: number;
  event: string;
  toolName: string | null;
  summary: string | null;
  payload: unknown;
}
