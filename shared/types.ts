// Shared event + API types. Imported by server, web, runner, scripts and tests.

export type Platform = 'win32' | 'linux' | 'darwin' | 'wsl' | string;
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'compacting' | 'stale' | 'ended' | 'error';
export type SessionSource = 'cli' | 'desktop' | 'headless' | 'bg' | 'sdk' | 'unknown';
export type ToolCallStatus = 'ok' | 'error' | 'denied' | 'interrupted' | 'running';
export type PendingKind = 'permission' | 'question' | 'plan' | 'stop_wait' | 'pause';
export type PendingStatus = 'pending' | 'answered' | 'timeout' | 'superseded';
export type JobStatus = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'lost';
export type ControlEvent = 'PermissionRequest' | 'PreToolUse' | 'Stop' | 'UserPromptSubmit' | 'Notification';

export const CONTROL_EVENTS: readonly ControlEvent[] = ['PermissionRequest', 'PreToolUse', 'Stop', 'UserPromptSubmit', 'Notification'];

/** Raw hook stdin JSON from Claude Code. Only the common fields are typed; everything else is kept as-is. */
export interface HookInput {
  session_id: string;
  hook_event_name: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  effort?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  [key: string]: unknown;
}

export interface GitInfo {
  root?: string;
  branch?: string;
  sha?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  remote?: string;
  worktree?: boolean;
  /** `git diff --shortstat <start_sha>` at Stop */
  shortstat?: string;
  /** set when the Bash command ran `git commit` */
  lastCommit?: { sha: string; message: string; author: string; ts: number; files: number; added: number; removed: number };
  /** set when `gh pr create` printed a PR URL */
  prUrl?: string;
}

export interface TranscriptDelta {
  path: string;
  agentId?: string;
  /** byte offset the lines start at; lets the server ignore duplicates */
  offset: number;
  lines: string[];
}

/** What bb-hook.mjs sends for every hook invocation. */
export interface HookEnvelope {
  v: 1;
  machineId?: string;
  hostname: string;
  platform: Platform;
  arch?: string;
  user: string;
  pid: number;
  ppid: number;
  hookVersion: string;
  ts: number;
  env: Record<string, string>;
  event: HookInput;
  git?: GitInfo;
  transcripts?: TranscriptDelta[];
  progress?: { hash: string; content: string };
  spoolBytes?: number;
  /** sent by the lean sync PreToolUse path: decide only, the async twin ingests */
  controlOnly?: boolean;
}

export interface SessionControl {
  walk: boolean;
  kill?: boolean;
  pause?: boolean;
  queued?: number;
}

/** Local control cache the hook keeps in ~/.buildyboy/control.json. */
export interface ControlState {
  ts: number;
  /** effective walk mode for the machine (global or machine-level) */
  walk: boolean;
  /** global "Pause everything" */
  pauseAll?: boolean;
  /** sessions that need the slow path */
  sessions: Record<string, SessionControl>;
}

export interface IngestResponse {
  ok: true;
  accepted: number;
  duplicates: number;
  control: ControlState;
}

export interface HookResponse {
  /** JSON to print on stdout, or null to print nothing */
  output: Record<string, unknown> | null;
  control: ControlState;
}

// ---------- Web API ----------

export interface MachineSummary {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  claudeVersion: string | null;
  hookVersion: string | null;
  online: boolean;
  runnerOnline: boolean;
  lastSeen: number | null;
  spoolBytes: number | null;
  walkMode: boolean | null;
  revoked: boolean;
}

export interface ToolToken {
  id: string;
  tool: string;
  status: ToolCallStatus;
}

export interface SessionSummary {
  id: string;
  machineId: string;
  machineName: string;
  projectId: number | null;
  projectName: string | null;
  cwd: string | null;
  source: SessionSource;
  name: string | null;
  model: string | null;
  status: SessionStatus;
  statusReason: string | null;
  activity: string | null;
  branch: string | null;
  dirty: boolean;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  costUsd: number;
  contextPct: number | null;
  jobId: string | null;
  walkMode: boolean;
  /** last ~20 tool calls, oldest first */
  belt: ToolToken[];
  /** running subagents */
  drones: { agentId: string; agentType: string | null }[];
  pendingCount: number;
  imported: boolean;
  job?: { id: string; status: JobStatus; maxBudgetUsd: number | null; deadline: number | null } | null;
}

export interface SessionDetail extends SessionSummary {
  effort: string | null;
  permissionMode: string | null;
  transcriptPath: string | null;
  parentSessionId: string | null;
  endReason: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheHitPct: number | null;
  compactions: number;
  waitMs: number;
  linesAdded: number;
  linesRemoved: number;
  startSha: string | null;
  endSha: string | null;
  remoteControl: string | null;
  paused: boolean;
  killRequested: boolean;
  stopWaitMin: number;
  platform: string | null;
  /** push notifications muted for this session */
  pushMuted: boolean;
}

export type TimelineItem =
  | { kind: 'prompt'; id: string; ts: number; text: string; agentId?: string | null }
  | { kind: 'assistant'; id: string; ts: number; text: string; model?: string | null; agentId?: string | null }
  | { kind: 'thinking'; id: string; ts: number; text: string; agentId?: string | null }
  | {
      kind: 'tool';
      id: string;
      ts: number;
      tool: string;
      mcpServer: string | null;
      status: ToolCallStatus;
      input: Record<string, unknown> | null;
      output: string | null;
      outputLen: number | null;
      durationMs: number | null;
      exitCode: number | null;
      filePath: string | null;
      command: string | null;
      agentId?: string | null;
      patch?: string | null;
    }
  | { kind: 'event'; id: string; ts: number; event: string; summary: string; level: 'info' | 'warn' | 'error'; data?: unknown; agentId?: string | null }
  | { kind: 'raw'; id: string; ts: number; data: unknown; agentId?: string | null };

export interface TimelinePage {
  items: TimelineItem[];
  /** pass back as ?cursor= to get older items; null when at the beginning */
  cursor: string | null;
}

export interface PermissionSuggestion {
  type: string;
  [key: string]: unknown;
}

export interface PendingActionView {
  id: string;
  sessionId: string;
  kind: PendingKind;
  status: PendingStatus;
  toolName: string | null;
  createdAt: number;
  expiresAt: number | null;
  answeredAt: number | null;
  answeredBy: string | null;
  request: {
    toolInput?: Record<string, unknown>;
    permissionSuggestions?: PermissionSuggestion[];
    lastAssistantMessage?: string | null;
    cwd?: string | null;
    branch?: string | null;
    sessionName?: string | null;
    machineName?: string | null;
    projectName?: string | null;
  };
  response: Record<string, unknown> | null;
}

/** POST /api/actions/:id/answer body */
export type ActionAnswer =
  | { type: 'allow'; scope?: 'once' | 'session'; updatedInput?: Record<string, unknown> }
  | { type: 'deny'; message?: string; interrupt?: boolean }
  | { type: 'answers'; answers: Record<string, string> }
  | { type: 'reply'; text: string }
  | { type: 'release' };

export interface QueuedMessageView {
  id: string;
  sessionId: string;
  text: string;
  mode: 'now' | 'after_turn';
  status: 'queued' | 'delivered' | 'cancelled';
  createdAt: number;
  deliveredAt: number | null;
  deliveredVia: string | null;
}

export interface AttentionSummary {
  waiting: number;
  pending: number;
  jobsFailed: number;
  stale: number;
}

export interface JobOptions {
  model?: string;
  fallbackModel?: string;
  effort?: string;
  permissionMode?: string;
  maxBudgetUsd: number;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean | string;
  walkMode?: boolean;
  verify?: string[];
}

export interface JobView {
  id: string;
  promptId: number | null;
  machineId: string;
  machineName?: string;
  cwd: string;
  title: string | null;
  promptText: string;
  options: JobOptions;
  sessionId: string | null;
  status: JobStatus;
  exitCode: number | null;
  costUsd: number | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  verify: { ranAt: number; results: { command: string; ok: boolean; exitCode: number | null; output: string }[] } | null;
}

/** One message on GET /api/stream. Clients mostly use these to invalidate queries. */
export interface StreamMessage {
  topic: string; // 'floor' | 'inbox' | `session:${id}` | 'jobs' | `job:${id}` | 'machines'
  type: string;
  data?: unknown;
}

/** Runner <-> server */
export type RunnerCommand =
  | { type: 'job'; job: JobView }
  | { type: 'stop'; jobId: string }
  | { type: 'message'; jobId: string; text: string }
  | { type: 'verify'; jobId: string; commands: string[] }
  | { type: 'ping' };

export type RunnerEvent =
  | { type: 'status'; status: JobStatus; sessionId?: string; exitCode?: number | null; costUsd?: number | null; result?: Record<string, unknown> | null }
  | { type: 'output'; lines: string[] }
  | { type: 'verify'; results: { command: string; ok: boolean; exitCode: number | null; output: string }[] };

export interface ApiError {
  error: string;
}
