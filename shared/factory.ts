// The factory (SPEC §11): types shared by the server, the PWA and `bb mcp`, plus the MCP tool list.
// Each tool is one HTTP endpoint, POST /api/agent/<name>, behind an agent token. The same zod schema validates the
// arguments in `bb mcp` (where the SDK derives the model-facing JSON Schema) and again on the server.
import { z } from 'zod';

export const TASK_STATUSES = ['backlog', 'gata', 'in_lucru', 'la_porti', 'integrata', 'blocata'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  gata: 'Gata',
  in_lucru: 'În lucru',
  la_porti: 'La porți',
  integrata: 'Integrată',
  blocata: 'Blocată',
};

export const GATES = ['G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type Gate = (typeof GATES)[number];
export const GATE_LABEL: Record<Gate, string> = {
  G1: 'Typecheck, lint, unit and e2e tests',
  G2: 'Acceptance tests',
  G3: 'Independent review',
  G4: 'Screenshots, desktop and phone',
  G5: 'Rebase on main, G1 and G2 again',
};
export type Verdict = 'pass' | 'fail' | 'skip';

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  /** status is `gata` and every dependency is `integrata` */
  ready: boolean;
  dependsOn: string[];
  /** dependencies not yet integrated */
  waitingOn: string[];
  repo: string | null;
  branch: string | null;
  priority: number;
  costUsd: number | null;
  promptId: number | null;
  promptVersion: number | null;
  sensitive: boolean;
  note: string | null;
  claimedBy: string | null;
  terminal: string | null;
  sessionId: string | null;
  jobId: string | null;
  source: string;
  extRef: string | null;
  acceptance: string[];
  /** latest verdict per gate */
  gates: Partial<Record<Gate, Verdict>>;
  openControls: number;
  createdAt: number;
  updatedAt: number;
  integratedAt: number | null;
}

export interface TaskEvent {
  ts: number;
  actor: string;
  kind: string;
  from: string | null;
  to: string | null;
  detail: Record<string, unknown> | null;
}

export interface GateShot {
  id: number;
  name: string;
  mime: string;
  url: string;
}

export interface GateResult {
  id: number;
  gate: Gate;
  verdict: Verdict;
  summary: string;
  details: unknown;
  actor: string;
  createdAt: number;
  shots: GateShot[];
}

export interface ControlRequest {
  id: number;
  taskId: string;
  kind: 'stop' | 'revert';
  note: string | null;
  status: 'open' | 'acked';
  createdAt: number;
  ackedAt: number | null;
}

export interface TaskDetail extends TaskSummary {
  body: string;
  events: TaskEvent[];
  gateResults: GateResult[];
  controls: ControlRequest[];
  decisions: DecisionView[];
}

export interface DecisionView {
  id: string;
  taskId: string | null;
  question: string;
  context: string | null;
  options: string[];
  status: 'pending' | 'answered' | 'cancelled';
  answer: string | null;
  askedBy: string;
  createdAt: number;
  answeredAt: number | null;
}

export interface UsageWindow {
  /** 0–100 */
  pct: number;
  /** epoch ms, or null when unknown */
  resetsAt: number | null;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** when the newest statusline sample arrived (epoch ms), null without data */
  updatedAt: number | null;
  ageMs: number | null;
  sessionId: string | null;
}

export interface GovernorThresholds {
  fiveHourPct: number;
  sevenDayPct: number;
  maxAgeMin: number;
}

export interface GovernorVerdict {
  canStart: boolean;
  stopAll: boolean;
  /** epoch ms; null when there is nothing to wait for (or nothing known) */
  waitUntil: number | null;
  reason: string;
  usage: Usage;
  thresholds: GovernorThresholds;
}

export interface AgentTokenView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface TerminalView {
  machineId: string;
  machineName: string;
  address: string;
  name: string | null;
  agent: string | null;
  cwd: string | null;
  state: string | null;
  status: string | null;
  turn: number | null;
  where: string | null;
  taskId: string | null;
  sessionId: string | null;
  seenAt: number;
}

export interface DigestView {
  id: number;
  ts: number;
  kind: 'daily' | 'manual';
  title: string;
  body: string;
}

// ---------- MCP tools ----------

const id = z.string().trim().min(1).max(64);
const status = z.enum(TASK_STATUSES);
const slots = z.record(z.string().max(200), z.string().max(50_000));
const templateRef = {
  templateId: z.number().int().optional().describe('Template id; defaults to the harness template'),
  template: z.string().max(80).optional().describe('Template name instead of an id'),
};

export const SHOT_MAX_BYTES = 5 * 1024 * 1024;
export const shotSchema = z.object({
  name: z.string().trim().min(1).max(200),
  path: z.string().max(2000).optional().describe('Local image file; `bb mcp` reads it and uploads it'),
  base64: z.string().max(Math.ceil((SHOT_MAX_BYTES * 4) / 3) + 8).optional(),
  mime: z.string().max(60).optional(),
});

export const TOOLS = {
  usage_get: {
    description: 'Claude subscription usage: the 5-hour and 7-day windows (percent used, resets_at) and how old the data is.',
    input: z.object({}),
  },
  governor_get: {
    description: 'The consumption governor: canStart (start new workers?), stopAll (stop the factory), waitUntil and the reason.',
    input: z.object({}),
  },
  sessions_list: {
    description: 'Claude Code sessions Buildyboy knows about: status, context %, cost, branch.',
    input: z.object({ live: z.boolean().optional().describe('Only sessions that have not ended'), limit: z.number().int().min(1).max(200).optional() }),
  },
  sessions_get: {
    description: 'One session in detail.',
    input: z.object({ id: z.string().min(1).max(200) }),
  },
  tasks_list: {
    description: 'Backlog packages. `ready: true` returns only tasks that can start now (status gata, all dependencies integrated).',
    input: z.object({ status: z.array(status).optional(), ready: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }),
  },
  tasks_get: {
    description: 'One package with its history, gate results, control requests and decisions.',
    input: z.object({ id }),
  },
  tasks_create: {
    description: 'Create a package. With upsert: true an existing id is updated instead (status is kept unless given).',
    input: z.object({
      id: id.optional(),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(100_000).optional(),
      acceptance: z.array(z.string().max(2000)).max(100).optional(),
      dependsOn: z.array(id).max(50).optional(),
      repo: z.string().max(500).optional(),
      branch: z.string().max(200).optional(),
      priority: z.number().int().min(-1000).max(1000).optional(),
      sensitive: z.boolean().optional().describe('Auth, RLS, import, pseudonymisation: flagged in the digest'),
      status: status.optional(),
      upsert: z.boolean().optional(),
      extRef: z.string().max(300).optional(),
    }),
  },
  tasks_claim: {
    description: 'Claim a package for work: the given id, or the next ready one by priority. Sets it to in_lucru. Refused when the governor says canStart is false, unless force is true.',
    input: z.object({ id: id.optional(), agent: z.string().max(100).optional(), force: z.boolean().optional() }),
  },
  tasks_update: {
    description: 'Update a package: status, branch, cost, prompt version, terminal, session or a note. Every change is kept in its history.',
    input: z.object({
      id,
      status: status.optional(),
      branch: z.string().max(200).optional(),
      costUsd: z.number().min(0).max(100_000).optional(),
      promptId: z.number().int().optional(),
      promptVersion: z.number().int().min(1).optional(),
      terminal: z.string().max(100).optional(),
      sessionId: z.string().max(200).optional(),
      note: z.string().max(20_000).optional(),
      dependsOn: z.array(id).max(50).optional(),
      acceptance: z.array(z.string().max(2000)).max(100).optional(),
    }),
  },
  prompts_render: {
    description: 'Render a harness prompt from a template and slot values; returns the Markdown and lint warnings.',
    input: z.object({ ...templateRef, slots, extraMd: z.string().max(200_000).optional() }),
  },
  prompts_lint: {
    description: 'Lint slot values against a template (empty Done when, non-runnable checks, leftover placeholders…).',
    input: z.object({ ...templateRef, slots }),
  },
  prompts_save: {
    description: 'Save a prompt (new, or a new version of `id`). With taskId, the task records the prompt and its version.',
    input: z.object({
      id: z.number().int().optional(),
      title: z.string().trim().min(1).max(200),
      ...templateRef,
      slots,
      extraMd: z.string().max(200_000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      taskId: id.optional(),
    }),
  },
  gates_record: {
    description: 'Record a gate result (G1–G5) for a package: verdict, summary, optional details and screenshots.',
    input: z.object({
      taskId: id,
      gate: z.enum(GATES),
      verdict: z.enum(['pass', 'fail', 'skip']),
      summary: z.string().max(20_000),
      details: z.unknown().optional(),
      screenshots: z.array(shotSchema).max(12).optional(),
    }),
  },
  decision_ask: {
    description: "Put a question in Narcis's inbox and notify the phone. Returns its id; poll decision_get for the answer.",
    input: z.object({
      question: z.string().trim().min(1).max(4000),
      context: z.string().max(20_000).optional(),
      options: z.array(z.string().max(300)).max(8).optional(),
      taskId: id.optional(),
    }),
  },
  decision_get: {
    description: 'A decision and its answer, once there is one.',
    input: z.object({ id: z.string().min(1).max(64) }),
  },
  digest_post: {
    description: 'Compose and send the digest now (what was integrated, gates, usage, pending decisions), with an optional note.',
    input: z.object({ note: z.string().max(4000).optional() }),
  },
  control_get: {
    description: "Narcis's open requests to stop a package or revert its integration. ack: true marks the returned ones as handled.",
    input: z.object({ taskId: id.optional(), ack: z.boolean().optional() }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOLS)[T]['input']>;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
