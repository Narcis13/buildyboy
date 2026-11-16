// The factory (SPEC §11, §12): types shared by the server, the PWA and `bb mcp`, plus the MCP tool list.
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

/** The steps of the line that are not gates (§12.4): they run like gates but make no gate result and use no round. */
export const KIT_STEPS = ['prepare', 'qa', 'cleanup', 'revert'] as const;
export type KitStep = (typeof KIT_STEPS)[number];
/** Everything a run can be: a gate or a kit step. */
export const STEP_NAMES = ['prepare', 'qa', ...GATES, 'cleanup', 'revert'] as const;
export type StepName = Gate | KitStep;
export const isGate = (s: unknown): s is Gate => (GATES as readonly unknown[]).includes(s);
/** The runner version that knows the built-in steps (runner/kit, §12.4); older runners run argv steps only. */
export const KIT_RUNNER_VERSION = '0.2.0';

export interface TaskSummary {
  id: string;
  /** the id without its project's prefix (`ED-P1` → `P1`); the id itself when the project has none */
  localId: string;
  /** the factory project it belongs to (for life); null for old data and one-off packages */
  project: string | null;
  title: string;
  status: TaskStatus;
  /** where the conductor has it on the line (§12.5: prepare, qa, build, G1…G5, cleanup); null off the line */
  stage: string | null;
  /** archived packages leave the default lists (§12.2); null when not archived */
  archivedAt: number | null;
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
  /** allocated by tasks_claim from the project's config; null when it has none */
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
  /** a gate (G1–G5) or a kit step (prepare, qa, cleanup, revert: no gate result, no round) */
  gate: StepName;
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
  /** what the step reported besides its verdict (G5: { range }, qa: { commit, tag, files }, verifiers: { costUsd }…) */
  details: unknown;
  logBytes: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * §11.7's per-repo factory config, as the Settings card still reads and writes it (GET/PUT /api/factory/config). Since
 * migration 009 it is a view of the projects: machineId, checkout and recipe (= lineFile) are the project's own columns,
 * the other fields its config.legacy.
 */
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

// ---------- projects (§12.1) ----------

export const PROJECT_STATES = ['active', 'paused', 'archived'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];
/** a project key: never changes */
export const PROJECT_KEY_RE = /^[a-z][a-z0-9-]{1,23}$/;
/** a package id prefix: '' or e.g. `ED-` */
export const ID_PREFIX_RE = /^(?:[A-Z][A-Z0-9]{0,7}-)?$/;
/** the roles whose model a project may override (§12.3 `models`) */
export const MODEL_ROLES = ['worker', 'qa', 'review', 'visual', 'foreman', 'planner'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** §11.7's per-repo allocation fields, kept in a project that came from that config (config.legacy). */
export const legacyRepoConfigSchema = z.object({
  /** the package's worktree, with placeholders */
  worktree: z.string().trim().max(1000).default(''),
  portFrom: z.number().int().min(1).max(65535).nullable().default(null),
  portTo: z.number().int().min(1).max(65535).nullable().default(null),
  dbPrefix: z.string().trim().max(60).regex(/^[\w-]*$/, 'letters, digits, _ and - only').default(''),
  migrationFrom: z.number().int().min(0).max(1_000_000).nullable().default(null),
  migrationBlock: z.number().int().min(1).max(1000).default(10),
  /** cleanup lines returned when a package is integrated, with placeholders */
  cleanup: z.array(z.string().max(2000)).max(30).default([]),
});
export type LegacyRepoConfig = z.infer<typeof legacyRepoConfigSchema>;

/**
 * A project's config_json: the owner's (or an operator's) overrides, which win over the line file (§12.3), and the
 * legacy allocation fields of a project migrated from `factory_repos`.
 */
const limitsSchema = z.object({ workers: z.number().int().min(1).max(20).optional(), rounds: z.number().int().min(1).max(50).optional() });
/** model per role; null turns that role off (the foreman: everything goes to the owner) */
const model = z.string().trim().min(1).max(100).nullable().optional();
const modelsSchema = z.object({ worker: model, qa: model, review: model, visual: model, foreman: model, planner: model } satisfies Record<ModelRole, unknown>);
const integrateSchema = z.object({ approval: z.enum(['never', 'sensitive', 'always']).optional() });
export const projectConfigSchema = z.object({
  legacy: legacyRepoConfigSchema.optional(),
  limits: limitsSchema.optional(),
  models: modelsSchema.optional(),
  integrate: integrateSchema.optional(),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

const projectKey = z.string().trim().regex(PROJECT_KEY_RE, 'a project key: a lower-case letter, then letters, digits and "-", 2–24 characters');

/** The fields of a project the owner (or an operator, §12.7) sets: POST and PUT /api/factory/projects. */
export const projectFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repo: z.string().trim().max(200).regex(/^[\w.-]+(?:\/[\w.-]+)*$/, 'owner/name').nullable(),
  idPrefix: z.string().regex(ID_PREFIX_RE, "'' or an upper-case prefix ending in '-', e.g. ED-"),
  machineId: z.string().trim().min(1).max(100).nullable(),
  checkout: z.string().trim().min(1).max(1000).nullable(),
  lineFile: z.string().trim().min(1).max(1000),
  config: projectConfigSchema,
});
export const projectCreateSchema = projectFieldsSchema.partial().extend({ key: projectKey });
/** config is merged key by key into the stored one; a key set to null is removed */
export const projectPatchSchema = projectFieldsSchema.omit({ config: true }).partial().extend({
  config: z.object({
    legacy: legacyRepoConfigSchema.nullable().optional(),
    limits: limitsSchema.nullable().optional(),
    models: modelsSchema.nullable().optional(),
    integrate: integrateSchema.nullable().optional(),
  }).optional(),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

/** POST /api/factory/projects/:key/<action> */
export const PROJECT_ACTIONS = ['pause', 'resume', 'archive-done', 'archive', 'unarchive', 'refresh', 'autopilot'] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/** A factory project as projects_list and GET /api/factory/projects return it. Times are epoch ms. */
export interface ProjectView {
  key: string;
  name: string;
  /** `owner/name` (or a bare name, from old data); packages created with this repo and no project land here */
  repo: string | null;
  /** '' or e.g. `ED-`: the package ids it owns (§12.2) */
  idPrefix: string;
  /** where its line runs: the trusted main checkout on a paired machine */
  machineId: string | null;
  machineName: string | null;
  checkout: string | null;
  /** relative to the checkout (default factory.json; a migrated project keeps its §11.7 recipe path) */
  lineFile: string;
  config: ProjectConfig;
  /** the resolved line as the runner last reported it (§12.3; its shape is shared/line.ts's), null until then */
  resolvedLine: unknown;
  lineSeenAt: number | null;
  lineError: string | null;
  state: ProjectState;
  autopilot: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** packages per status, archived ones left out */
  counts: Record<TaskStatus, number>;
  /** archived packages */
  archived: number;
  /** packages integrated, ever */
  integrated: number;
  /** sum over its packages (measured, else set by hand) */
  costUsd: number;
  /** pending decisions tied to its packages */
  openDecisions: number;
  /** packages waiting on the owner: blocked, or with a pending decision (archived ones left out) */
  attention: number;
  /** the newest change to one of its packages */
  lastActivityAt: number | null;
  /** the §5 projects (checkouts seen by telemetry) whose GitHub repo is this one */
  checkoutIds: number[];
}

/** projects_get and GET /api/factory/projects/:key */
export interface ProjectDetail extends ProjectView {
  /** its packages on the line: in_lucru and la_porti, with their stage */
  line: TaskSummary[];
  /** its ready packages, in claim order */
  next: TaskSummary[];
  /** pending decisions tied to its packages, newest first */
  decisions: DecisionView[];
}

/**
 * Placeholders of every template the factory fills (§12.2): factory.json, cleanup lines, the worktree template.
 * {recipeDir} and {args} exist only in gate recipe steps.
 */
export const TASK_VAR_NAMES = ['id', 'idLower', 'localId', 'localIdLower', 'project', 'round', 'port', 'db', 'worktree', 'branch'] as const;
export type TaskVars = Record<(typeof TASK_VAR_NAMES)[number], string>;

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

/** The package as a step command carries it (§12.4): what a built-in needs and the repo does not hold. Data, never commands. */
export interface StepPackage {
  id: string;
  localId: string;
  title: string;
  body: string;
  acceptance: string[];
  sensitive: boolean;
  /** tasks.branch as recorded; the runner uses the line's `branch` template for git (never a branch the server names) */
  branch: string | null;
}

/** A file the runner writes under `<worktree>/.factory/` (path relative to `.factory/`; anything that escapes it is refused). */
export interface StepFile {
  path: string;
  content: string;
}

/** Server → runner: run one gate or kit step (§11.7, §12.4). Runners before 0.2.0 know only gates and the first six vars. */
export interface GateCommand {
  type: 'gate';
  run: {
    id: string;
    taskId: string;
    /** G1–G5, or prepare, qa, cleanup, revert (runner 0.2.0+) */
    gate: StepName;
    round: number;
    args: string[];
    checkout: string;
    /** the project's line file, relative to the checkout */
    recipe: string;
    /** the six the runner fills in recipe steps, plus the rest of §12.2's placeholders (localId, project, branch…) */
    vars: Record<'id' | 'idLower' | 'worktree' | 'round' | 'port' | 'db', string> & Partial<TaskVars>;
    /** the project's key */
    project?: string;
    /** the package (built-in steps write it to .factory/package.md and give it to verifiers) */
    task?: StepPackage;
    resources?: TaskResources | null;
    /** G3 from round 2: the open blockers and majors of earlier rounds, which the reviewer checks first */
    findings?: FindingInput[];
    /** written under <worktree>/.factory/ before the step runs (prepare: once the worktree exists) */
    files?: StepFile[];
  };
}

/** Server → runner: read and resolve the project's line file now (§12.3, "Check setup"); answered on POST /api/runner/lines. */
export interface LineCommand {
  type: 'line';
  id: string;
  project: string;
  checkout: string;
  lineFile: string;
}

/** Runner → server: POST /api/runner/lines. */
export interface LineReport {
  id?: string;
  project: string;
  /** the resolved line (shared/line.ts ResolvedLine), or null with `error` */
  line: unknown;
  error?: string | null;
}

/** Server → runner: a checked herdr command on a terminal the factory started (`bb-…`, label owner=buildyboy). */
export interface HcCommand {
  type: 'hc';
  id: string;
  op: 'send' | 'kill';
  /** the terminal's name, `bb-…` */
  name: string;
  /** send: the text; long or multi-line text is written to <terminal cwd>/.factory/inbox/<n>.md and the sent line points at it */
  text?: string;
  /** send: only when the terminal's status is exactly this (hc send --if) */
  if?: 'idle' | 'working';
  /** send: more files under the terminal's .factory/ first */
  files?: StepFile[];
}

/** Runner → server: POST /api/runner/hc/:id. */
export interface HcReport {
  status: 'done' | 'error';
  error?: string;
  /** send: { sent, inbox? }; kill: { killed } */
  result?: Record<string, unknown>;
}

export type HcCommandStatus = 'queued' | 'done' | 'error';
export interface HcCommandView {
  id: string;
  machineId: string;
  taskId: string | null;
  op: 'send' | 'kill';
  name: string;
  status: HcCommandStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** Runner → server: POST /api/runner/gates/:id. `done` carries a verdict; `error` means the gate could not give one. */
export interface GateReport {
  /** the resolved line (prepare, and any step that read it): the server keeps it on the project */
  line?: unknown;
  /** why the line file could not be resolved (kept on the project) */
  lineError?: string;
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
  /** who answered or cancelled it: `web` (the owner), `agent:<name>` (an operator, §12.7), a `factory:` actor; null when unknown */
  answeredBy: string | null;
}

// ---------- operators (§12.7) ----------

/**
 * What a decision is about, for an operator: a launch approval (only the owner answers it), the round limit of §11.7,
 * one from the line (§12.5: needs attention, integration approval), or a question from an agent (coordinator, foreman…).
 */
export type DecisionKind = 'launch_approval' | 'round_limit' | 'line' | 'question';

/** decisions_list: a decision plus what an operator needs to act on it. */
export interface OperatorDecision extends DecisionView {
  kind: DecisionKind;
  project: string | null;
  /** may the calling token answer or cancel it (pending, not its own question, not a launch approval, operator scope) */
  mayAnswer: boolean;
  /** why not, when mayAnswer is false and it is pending */
  why?: string;
}

/**
 * factory_status: one compact answer for a small context. Ages are in minutes; lists are capped, `…More` counts the rest.
 * In list items, a field that would be null (or a zero round, a zero priority) is left out.
 */
export interface FactoryStatus {
  at: number;
  governor: { canStart: boolean; stopAll: boolean; reason: string; waitUntil: number | null; fiveHourPct: number | null; sevenDayPct: number | null; usageAgeMin: number | null };
  /** runner offline, usage data stale, autopilot held… one line each */
  alerts: string[];
  /** counts per status, zeros left out; machine and runnerOnline only when the project has a machine */
  projects: { key: string; name: string; state: ProjectState; autopilot: boolean; machine?: string; runnerOnline?: boolean; counts: Partial<Record<TaskStatus, number>> }[];
  /** packages on the line (in_lucru, la_porti) and blocked ones: blocked first, then the longest unchanged */
  line: { id: string; project?: string; title: string; status: TaskStatus; stage?: string; round?: number; maxRounds?: number; waits: string; sinceMin: number }[];
  lineMore: number;
  /** ready packages in claim order */
  ready: { id: string; project?: string; title: string; priority?: number }[];
  readyMore: number;
  /** everything waiting on the owner (or an operator) */
  waiting: {
    decisions: { id: string; kind: DecisionKind; taskId?: string; question: string; options: string[]; askedBy: string; ageMin: number; mayAnswer: boolean }[];
    decisionsMore: number;
    controls: { id: number; taskId: string; kind: 'stop' | 'revert'; ageMin: number }[];
    controlsMore: number;
    /** pending Inbox actions of sessions in walk mode (inbox_list with an inbox token) */
    inbox: number;
  };
}

/** inbox_list: a pending Inbox action, cut for a small context. */
export interface InboxItem {
  id: string;
  kind: 'permission' | 'question' | 'plan' | 'stop_wait';
  sessionId: string;
  session: string | null;
  project: string | null;
  machine: string | null;
  cwd: string | null;
  branch: string | null;
  tool: string | null;
  ageMin: number;
  expiresInMin: number | null;
  /** the tool input (permission), the plan, or the last message of the finished turn, cut to ~1500 characters */
  detail: string;
  /** a question's questions with their option labels: answer with { type: 'answers', answers: { [question]: label } } */
  questions?: { question: string; options: string[]; multiSelect: boolean }[];
  /** the answer types inbox_answer takes for this kind */
  answers: InboxAnswerType[];
}

export const INBOX_ANSWER_TYPES = ['allow', 'deny', 'answers', 'reply', 'release'] as const;
export type InboxAnswerType = (typeof INBOX_ANSWER_TYPES)[number];

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

/** What an agent token may start with tasks_launch and coordinator_launch. */
export const LAUNCH_SCOPES = ['off', 'workers', 'all'] as const;
export type LaunchScope = (typeof LAUNCH_SCOPES)[number];
export const LAUNCH_SCOPE_LABEL: Record<LaunchScope, string> = { off: 'Nothing', workers: 'Workers', all: 'Workers and coordinators' };

export interface AgentTokenView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** what it may launch; off for every new token */
  launch: LaunchScope;
  /** each launch waits for the owner's approval (a decision) */
  launchApproval: boolean;
  /** acts for the owner (§12.7): answers decisions, asks for stop/revert, creates and changes projects, archives */
  operator: boolean;
  /** answers the Inbox's pending actions of sessions in walk mode (§12.7) */
  inbox: boolean;
}

/** The answer of tasks_launch and coordinator_launch. */
export type LaunchResult =
  | { status: 'launched'; kind: 'worker' | 'coordinator'; jobId: string; launcher: 'hc' | 'claude'; machineId: string; cwd: string; taskId: string | null; decisionId: string | null }
  | { status: 'pending_approval' | 'refused'; kind: 'worker' | 'coordinator'; decisionId: string; answer: string | null; reason: string };

export interface MachineView {
  id: string;
  name: string;
  platform: string | null;
  runnerOnline: boolean;
  /** folders the runner may work in; a launch outside them is refused (empty: the runner did not say) */
  allowedRoots: string[];
  concurrency: number | null;
  runnerSeenAt: number | null;
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

/** Tools that change nothing (MCP `readOnlyHint`). control_get changes state only with ack: true. */
export const READ_ONLY_TOOLS = [
  'usage_get', 'governor_get', 'sessions_list', 'sessions_get', 'tasks_list', 'tasks_get', 'projects_list', 'projects_get', 'prompts_render', 'prompts_lint',
  'gates_status', 'findings_list', 'decision_get', 'machines_list', 'factory_status', 'decisions_list', 'inbox_list', 'docs_get',
] as const;

/** Longest coordinator prompt: it goes on a herdr command line (runner/options.ts HC_PROMPT_MAX). */
export const LAUNCH_PROMPT_MAX = 24_000;
const launchArgs = {
  machineId: z.string().trim().min(1).max(100).describe('The machine whose runner starts it (machines_list)'),
  cwd: z.string().trim().min(1).max(1000).describe("Working directory on that machine, inside the runner's allowed roots"),
  launcher: z.enum(['hc', 'claude']).optional().describe('hc (default): interactive claude in a herdr terminal; claude: a headless claude -p job'),
  model: z.string().max(100).optional(),
  permissionMode: z.string().max(40).optional().describe('default, acceptEdits, plan, auto, dontAsk or bypassPermissions'),
  maxBudgetUsd: z.number().positive().max(1000).optional().describe('Budget for a claude -p job (default 5)'),
  promptId: z.number().int().positive().optional().describe('A saved prompt to start it with'),
};

/** docs_get topics. */
export const DOCS_TOPICS = ['start', 'tools', 'api', 'operator', 'all'] as const;
export type DocsTopic = (typeof DOCS_TOPICS)[number];

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
    description: 'Backlog packages. `ready: true` returns only tasks that can start now (status gata, all dependencies integrated). Archived packages are left out unless `archived: true` (then only they are listed).',
    input: z.object({
      status: z.array(status).optional(),
      ready: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      project: projectKey.optional().describe('Only the packages of this project (projects_list)'),
      archived: z.boolean().optional().describe('true: only archived packages'),
    }),
  },
  tasks_get: {
    description: 'One package with its history, gate results, control requests and decisions.',
    input: z.object({ id }),
  },
  tasks_create: {
    description: "Create a package. With upsert: true an existing id is updated instead (status is kept unless given). In a project with an id prefix, the id gets the prefix (P1 → ED-P1) and dependencies resolve inside the project first; without project, the project whose repo matches `repo` is used.",
    input: z.object({
      project: projectKey.optional().describe('The project it belongs to (for life); default: the project whose repo is `repo`'),
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
    description: "Claim a package for work: the given id, or the next ready one by priority (in `project`, or across active projects). Sets it to in_lucru and returns its resources (port, database, migration range) from its project's config. Never in a paused or archived project. Refused when the governor says canStart is false, unless force is true.",
    input: z.object({
      id: id.optional(),
      agent: z.string().max(100).optional(),
      force: z.boolean().optional(),
      project: projectKey.optional().describe('Claim only in this project'),
    }),
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
      archived: z.boolean().optional().describe('Archive (true) or unarchive (false) the package'),
    }),
  },
  projects_list: {
    description: 'Factory projects: each one owns its packages, its config and where its line runs. Default: active and paused ones.',
    input: z.object({ state: z.enum([...PROJECT_STATES, 'all']).optional().describe('active, paused, archived, or all (default: active and paused)') }),
  },
  projects_get: {
    description: 'One project: its counts, cost and what waits on the owner, plus its packages on the line, the ready ones and its pending decisions.',
    input: z.object({ key: projectKey }),
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
    description: "Run a gate on the runner of the package's project, from its recipe (the project's line file). Returns a runId; gates_status gives the verdict, summary and findings once it is done. The log stays on the server.",
    input: z.object({ taskId: id, gate: z.enum(GATES), args: z.array(z.string().max(2000)).max(30).optional() }),
  },
  gates_status: {
    description: 'The state of a gate or step run; once done, its verdict, summary, findings, details and the recorded gate result id (never the log).',
    input: z.object({ runId: z.string().min(1).max(64) }),
  },
  steps_run: {
    description:
      "Run a kit step of the line on the runner of the package's project (§12.4): prepare (worktree, branch, env file, .factory/, setup), qa (acceptance tests before the code), cleanup (after integration) or revert (undo the G5 range). Returns a runId for gates_status. Steps make no gate result and use no round.",
    input: z.object({
      taskId: id,
      step: z.enum(KIT_STEPS),
      args: z.array(z.string().max(2000)).max(30).optional().describe('revert: the range <old>..<new> (default: the last G5 pass); argv steps: their {args}'),
    }),
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
  machines_list: {
    description: 'Paired machines with their runner: id, name, online, allowed roots. The machineId and cwd of tasks_launch and coordinator_launch come from here.',
    input: z.object({}),
  },
  tasks_launch: {
    description:
      "Start a worker for a package on a machine's runner: an interactive claude in a herdr terminal (default) or a claude -p job. Claims the package (in_lucru). Only for tokens the owner allowed to launch; refused while the governor says canStart is false; may first wait for the owner's approval (status pending_approval: call again with the same arguments once decision_get shows the answer).",
    input: z.object({ taskId: id, ...launchArgs }),
  },
  coordinator_launch: {
    description:
      "Start a coordinator on a machine's runner: an interactive claude in a herdr terminal (default) or a claude -p job, with the built-in coordinator prompt or your own. Only for tokens the owner allowed to launch coordinators; refused while the governor says canStart is false; may first wait for the owner's approval like tasks_launch.",
    input: z.object({
      ...launchArgs,
      prompt: z.string().trim().min(1).max(LAUNCH_PROMPT_MAX).optional().describe('Its first prompt instead of the built-in coordinator prompt'),
      title: z.string().trim().max(120).optional().describe('Session name (default: Coordinator)'),
    }),
  },
  control_get: {
    description: "Narcis's open requests to stop a package or revert its integration. ack: true marks the returned ones as handled.",
    input: z.object({ taskId: id.optional(), ack: z.boolean().optional() }),
  },
  // ---------- operators (§12.7): reads for every token, writes for operator (or inbox) tokens ----------
  factory_status: {
    description:
      'What the factory is doing, in one small answer: the governor, alerts, each project (autopilot, counts), the packages on the line with what they wait for, the ready ones, and everything waiting on the owner (decisions, stop/revert requests, the Inbox). Start every operator loop here.',
    input: z.object({ project: projectKey.optional().describe('Only this project (default: active and paused projects)') }),
  },
  decisions_list: {
    description: 'Decisions, pending first, each with its kind (launch_approval, round_limit, line, question), its project and whether you may answer it.',
    input: z.object({
      status: z.enum(['pending', 'answered', 'cancelled']).optional().describe('Only this status (default: all, pending first)'),
      project: projectKey.optional().describe("Only decisions tied to this project's packages"),
      limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
    }),
  },
  decision_answer: {
    description:
      "Answer a pending decision for the owner. Operator tokens only. The answer must be one of its options when it has some. Never a decision your token asked, never a launch approval (the owner's alone).",
    input: z.object({ id: z.string().trim().min(1).max(64), answer: z.string().trim().min(1).max(20_000) }),
  },
  decision_cancel: {
    description: 'Cancel a pending decision (withdraw the question). Operator tokens only; the same limits as decision_answer.',
    input: z.object({ id: z.string().trim().min(1).max(64) }),
  },
  control_request: {
    description: "Ask for a package to be stopped or its integration reverted, as the owner's \"Stop the package\" button does. Operator tokens only. The coordinator (or the conductor) acts on it through control_get.",
    input: z.object({ taskId: id, kind: z.enum(['stop', 'revert']), note: z.string().max(4000).optional().describe('Why, for whoever carries it out') }),
  },
  projects_save: {
    description:
      'Create a project, or change one (only the fields given). Operator tokens only. machineId, checkout and lineFile decide what the runner executes: set them only as the owner told you.',
    input: projectPatchSchema.extend({ key: projectKey }),
  },
  projects_set: {
    description: "Switch a project's autopilot, or pause, resume, archive or unarchive it (state). Operator tokens only.",
    input: z.object({
      key: projectKey,
      autopilot: z.boolean().optional().describe('true: the conductor moves its packages along the line'),
      state: z.enum(PROJECT_STATES).optional().describe('active (resume or unarchive), paused (nothing new starts) or archived (it and its packages leave the lists)'),
    }),
  },
  inbox_list: {
    description: "The Inbox's pending actions of sessions in walk mode: permissions, questions, plans and finished turns waiting for a reply. Inbox tokens only.",
    input: z.object({ limit: z.number().int().min(1).max(50).optional().describe('Default 10') }),
  },
  inbox_answer: {
    description:
      'Answer a pending Inbox action as the web Inbox does: allow or deny a permission or a plan, answer a question, reply to a finished turn (or release it). Inbox tokens only. The session acts on it at once.',
    input: z.object({
      id: z.string().trim().min(1).max(64),
      type: z.enum(INBOX_ANSWER_TYPES).describe("One of the item's answers (inbox_list)"),
      scope: z.enum(['once', 'session']).optional().describe('allow: once (default) or for the rest of the session'),
      message: z.string().max(4000).optional().describe('deny: what to tell Claude instead'),
      interrupt: z.boolean().optional().describe('deny: also stop the turn'),
      answers: z.record(z.string().max(2000), z.string().max(4000)).optional().describe('answers: { [question]: chosen label }'),
      text: z.string().trim().min(1).max(20_000).optional().describe('reply: the next instruction'),
    }),
  },
  docs_get: {
    description:
      "Buildyboy's own manual for agents, as Markdown: how the factory works and the recommended loop (topic start), the operator's guide (operator), every MCP tool with its arguments, result and errors (tools, or one tool with `tool`), every HTTP endpoint (api), or everything (all). Read topic start once before your first factory run.",
    input: z.object({
      topic: z.enum(DOCS_TOPICS).optional().describe("start (default): concepts, connecting and the workflow; operator: the owner's deputy; tools: the tool reference; api: the HTTP API; all: everything"),
      tool: z.string().max(64).optional().describe('One tool name: only its reference entry'),
    }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOLS)[T]['input']>;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
