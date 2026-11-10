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
  /** the sum of the linked sessions' costs when the task has any (see costByRole), else the value set by hand */
  costUsd: number | null;
  /** the value set by hand with tasks_update, kept visible next to the measured cost */
  costManualUsd: number | null;
  /** measured cost per role of the linked sessions; null when no session is linked */
  costByRole: Partial<Record<Role, number>> | null;
  /** sessions linked to the task (BB_TASK, its herdr terminal, its job) */
  linkedSessions: number;
  /** current gate round (0 before the first one) and the limit, after which the package is blocked */
  round: number;
  maxRounds: number;
  /** allocated by tasks_claim from the repo's factory config; null when the repo has none */
  resources: TaskResources | null;
  migrationsUsed: number[];
  /** open findings by severity */
  openFindings: Record<FindingSeverity, number>;
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
  /** the round it belongs to */
  round: number;
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
  findings: FindingView[];
  gateRuns: GateRunView[];
}

export const ROLES = ['lucrator', 'qa', 'poarta', 'coordonator'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { lucrator: 'Worker', qa: 'QA', poarta: 'Gates', coordonator: 'Coordinator' };

export interface TaskResources {
  port: number | null;
  db: string | null;
  migrations: { from: number; to: number } | null;
}

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_STATUSES = ['open', 'fixed', 'deferred', 'for_architect', 'wontfix'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface FindingView {
  id: number;
  taskId: string;
  gateResultId: number | null;
  gate: Gate;
  round: number;
  severity: FindingSeverity;
  title: string;
  file: string | null;
  line: number | null;
  detail: string | null;
  fix: string | null;
  status: FindingStatus;
  note: string | null;
  /** the package it was deferred to (tasks_create fromFindings) */
  deferredTo: string | null;
  createdAt: number;
  updatedAt: number;
}

export type GateRunStatus = 'queued' | 'running' | 'done' | 'error';

/** A gate run by the runner from the repo's recipe. The log stays on the server (GET /api/gate-runs/:id/log). */
export interface GateRunView {
  id: string;
  taskId: string;
  gate: Gate;
  round: number;
  args: string[];
  machineId: string;
  status: GateRunStatus;
  verdict: Verdict | null;
  summary: string | null;
  findings: FindingInput[];
  gateResultId: number | null;
  exitCode: number | null;
  error: string | null;
  logBytes: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Per-repo factory config (Settings → Factory). */
export interface RepoFactoryConfig {
  /** matches the task's `repo` (case-insensitive) */
  repo: string;
  /** the machine whose runner runs the gates */
  machineId: string | null;
  /** the trusted main checkout on that machine; the recipe is read from here, never from a worktree */
  checkout: string;
  /** recipe path, relative to the checkout */
  recipe: string;
  /** the package's worktree, with placeholders ({id}, {idLower}) */
  worktree: string;
  portFrom: number | null;
  portTo: number | null;
  dbPrefix: string;
  migrationFrom: number | null;
  migrationBlock: number;
  /** cleanup lines returned when a package is integrated, with placeholders */
  cleanup: string[];
}

export interface FactoryConfig {
  maxRounds: number;
  repos: RepoFactoryConfig[];
}

/** One argv step of a gate (no shell). Placeholders: {id} {idLower} {worktree} {round} {port} {db} {recipeDir} {args}. */
export interface RecipeStep {
  name?: string;
  argv: string[];
  timeoutSec?: number;
}

/** The recipe file in the repo's main checkout. */
export interface GateRecipe {
  timeoutSec?: number;
  gates: Partial<Record<Gate, { steps: RecipeStep[]; timeoutSec?: number }>>;
}

/** Server → runner: run one gate. */
export interface GateCommand {
  type: 'gate';
  run: {
    id: string;
    taskId: string;
    gate: Gate;
    round: number;
    args: string[];
    checkout: string;
    recipe: string;
    vars: Record<'id' | 'idLower' | 'worktree' | 'round' | 'port' | 'db', string>;
  };
}

/** Runner → server: POST /api/runner/gates/:id. `done` carries a verdict; `error` means the gate could not give one. */
export interface GateReport {
  status: 'running' | 'done' | 'error';
  verdict?: Verdict;
  summary?: string;
  details?: unknown;
  findings?: FindingInput[];
  shots?: { name: string; base64: string; mime?: string }[];
  exitCode?: number | null;
  error?: string;
  /** the combined output of the steps; the server keeps the tail */
  log?: string;
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

export const DEFAULT_THRESHOLDS: GovernorThresholds = { fiveHourPct: 85, sevenDayPct: 80, maxAgeMin: 30 };

/** resets_at is Unix epoch seconds in the statusline JSON; accept ms and ISO strings too. */
export function epochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return epochMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** One window of the statusline's rate_limits ({ used_percentage, resets_at }). */
export function windowOf(raw: unknown): UsageWindow | null {
  const w = raw as { used_percentage?: unknown; resets_at?: unknown } | null | undefined;
  if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null;
  return { pct: w.used_percentage, resetsAt: epochMs(w.resets_at) };
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString() : 'an unknown time');

/**
 * Pure decision, shared by the server and `bb mcp` (offline, on the local statusline sample). Rules (fabrica.md): the
 * 7-day window at or above its threshold stops the factory until it resets; the 5-hour window at or above its threshold
 * blocks new workers until it resets; a window missing from the data, or whose reset time has passed, is ignored; data
 * older than maxAgeMin (or no data at all) blocks new workers.
 */
export function evaluate(usage: Usage, t: GovernorThresholds, now = Date.now()): GovernorVerdict {
  const reasons: string[] = [];
  let canStart = true;
  let stopAll = false;
  let waitUntil: number | null = null;
  const later = (ms: number | null) => {
    if (ms && (waitUntil === null || ms > waitUntil)) waitUntil = ms;
  };
  const live = (w: UsageWindow | null) => (w && (w.resetsAt === null || w.resetsAt > now) ? w : null);

  const week = live(usage.sevenDay);
  if (week && week.pct >= t.sevenDayPct) {
    stopAll = true;
    canStart = false;
    later(week.resetsAt);
    reasons.push(`7-day window at ${Math.round(week.pct)}% (limit ${t.sevenDayPct}%): stop the factory until it resets at ${fmt(week.resetsAt)}`);
  }
  const five = live(usage.fiveHour);
  if (five && five.pct >= t.fiveHourPct) {
    canStart = false;
    later(five.resetsAt);
    reasons.push(`5-hour window at ${Math.round(five.pct)}% (limit ${t.fiveHourPct}%): no new workers until it resets at ${fmt(five.resetsAt)}; let active ones finish`);
  }
  if (usage.updatedAt === null) {
    canStart = false;
    reasons.push('no usage data yet: turn on the statusline bridge (bb doctor shows what is missing)');
  } else if (usage.ageMs !== null && usage.ageMs > t.maxAgeMin * 60_000) {
    canStart = false;
    reasons.push(`usage data is ${Math.round(usage.ageMs / 60_000)} min old (limit ${t.maxAgeMin} min): no new workers until fresh data arrives`);
  }
  if (!reasons.length) {
    const parts = [five ? `5-hour ${Math.round(five.pct)}%` : '5-hour window absent', week ? `7-day ${Math.round(week.pct)}%` : '7-day window absent'];
    reasons.push(`ok: ${parts.join(', ')}`);
  }
  return { canStart, stopAll, waitUntil, reason: reasons.join('; '), usage, thresholds: t };
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

export const findingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().trim().min(1).max(500),
  file: z.string().max(1000).optional(),
  line: z.number().int().min(0).optional(),
  detail: z.string().max(20_000).optional(),
  fix: z.string().max(20_000).optional(),
});
export type FindingInput = z.infer<typeof findingSchema>;

/** Write tools `bb mcp` queues in its outbox while the server is unreachable (their answer can wait). */
export const QUEUEABLE_TOOLS = ['gates_record', 'tasks_update', 'digest_post', 'prompts_save'] as const;

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
      fromFindings: z.array(z.number().int()).max(200).optional().describe('Finding ids: they make the body and acceptance criteria, and are marked deferred to the new package'),
    }),
  },
  tasks_claim: {
    description: "Claim a package for work: the given id, or the next ready one by priority. Sets it to in_lucru and returns its resources (port, database, migration range) from the repo's factory config. Refused when the governor says canStart is false, unless force is true.",
    input: z.object({ id: id.optional(), agent: z.string().max(100).optional(), force: z.boolean().optional() }),
  },
  tasks_update: {
    description: 'Update a package: status, branch, cost, prompt version, terminal, session, used migrations or a note. Every change is kept in its history. Moving to integrata returns the cleanup list; moving from blocata back to in_lucru with a note allows one more gate round.',
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
      migrationsUsed: z.array(z.number().int().min(0)).max(500).optional().describe('Migration numbers the package uses; checked against the other active packages when it is integrated'),
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
    description: 'Record a gate result (G1–G5) for a package: verdict, summary, optional details, screenshots and findings. The server counts rounds and blocks the package when the last allowed round fails.',
    input: z.object({
      taskId: id,
      gate: z.enum(GATES),
      verdict: z.enum(['pass', 'fail', 'skip']),
      summary: z.string().max(20_000),
      details: z.unknown().optional(),
      screenshots: z.array(shotSchema).max(12).optional(),
      findings: z.array(findingSchema).max(200).optional(),
    }),
  },
  gates_run: {
    description: "Run a gate on the runner from the repo's recipe (Settings → Factory). Returns a runId; gates_status gives the verdict, summary and findings once it is done. The log stays on the server.",
    input: z.object({ taskId: id, gate: z.enum(GATES), args: z.array(z.string().max(2000)).max(30).optional() }),
  },
  gates_status: {
    description: 'The state of a gate run; once done, its verdict, summary, findings and the recorded gate result id (never the log).',
    input: z.object({ runId: z.string().min(1).max(64) }),
  },
  findings_list: {
    description: 'Gate findings, filtered by package, status and severity.',
    input: z.object({
      taskId: id.optional(),
      status: z.enum(FINDING_STATUSES).optional(),
      severity: z.enum(FINDING_SEVERITIES).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
  },
  findings_update: {
    description: 'Set the status of findings (open, fixed, deferred, for_architect, wontfix), with an optional note.',
    input: z.object({ ids: z.array(z.number().int()).min(1).max(500), status: z.enum(FINDING_STATUSES), note: z.string().max(4000).optional() }),
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
