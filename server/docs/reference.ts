// The reference for agents and integrations: every MCP tool and every HTTP endpoint, as data. One source feeds three
// readers: the manual's pages (/docs/agents, /docs/mcp-tools, /docs/api), the Markdown guide agents fetch
// (/docs/agents.md, /llms.txt) and the docs_get tool. tests/reference.test.ts fails when a route or a tool argument is
// missing here, so the reference cannot drift from the code.
import { z } from 'zod';
import { DOCS_TOPICS, GATE_LABEL, GATES, QUEUEABLE_TOOLS, READ_ONLY_TOOLS, STATUS_LABEL, TASK_STATUSES, TOOLS, TOOL_NAMES, type DocsTopic, type ToolName } from '../../shared/factory.ts';

export interface RefSite {
  /** this server's public URL, without a trailing slash */
  url: string;
}

// ---------- data shapes ----------

export interface Shape {
  id: string;
  title: string;
  intro: string;
  fields: [name: string, type: string, desc: string][];
}

export const SHAPES: Shape[] = [
  {
    id: 'task',
    title: 'Task (package) summary',
    intro: 'Returned by tasks_list, tasks_create, tasks_claim (as task) and tasks_update. Times are epoch milliseconds.',
    fields: [
      ['id', 'string', 'Given (P2, arond-12) or generated (T<n>). Letters, digits, ".", "_" and "-", at most 64.'],
      ['title', 'string', 'One line.'],
      ['status', 'enum', 'backlog · gata (ready) · in_lucru (in progress) · la_porti (at the gates) · integrata (integrated) · blocata (blocked).'],
      ['ready', 'boolean', 'status is gata and every dependency is integrata: tasks_claim may take it.'],
      ['dependsOn', 'string[]', 'Ids this package waits for.'],
      ['waitingOn', 'string[]', 'The dependencies not yet integrated.'],
      ['repo', 'string | null', 'Repository name; matches a repo in Settings → Factory (case-insensitive) for resources and gates_run.'],
      ['branch', 'string | null', 'The worker branch, set with tasks_update.'],
      ['priority', 'integer', 'Higher first (-1000…1000, default 0). tasks_claim picks by priority, then age.'],
      ['costUsd', 'number | null', 'Sum of the linked sessions\' costs when any are linked, else the value set by hand.'],
      ['costManualUsd', 'number | null', 'The value set with tasks_update costUsd.'],
      ['costByRole', 'object | null', 'Measured cost per role: lucrator (worker), qa, poarta (gates), coordonator.'],
      ['linkedSessions', 'integer', 'Sessions linked through BB_TASK, the package\'s herdr terminal or its job.'],
      ['round', 'integer', 'Current gate round, 0 before the first.'],
      ['maxRounds', 'integer', 'Round limit (setting gate_max_rounds, default 3, plus approved extra rounds).'],
      ['resources', 'object | null', '{ port, db, migrations: { from, to } } allocated by tasks_claim from the repo\'s factory config.'],
      ['migrationsUsed', 'integer[]', 'Migration numbers the package reported with tasks_update.'],
      ['openFindings', 'object', 'Open findings by severity: { blocker, major, minor }.'],
      ['promptId · promptVersion', 'integer | null', 'The saved worker prompt (prompts_save with taskId sets both).'],
      ['sensitive', 'boolean', 'Auth, RLS, import, pseudonymisation work: flagged in the digest.'],
      ['note', 'string | null', 'The latest note.'],
      ['claimedBy', 'string | null', 'Who claimed it (tasks_claim agent, else agent:<token name>).'],
      ['terminal · sessionId · jobId', 'string | null', 'Where the worker runs: herdr terminal, Claude Code session, Buildyboy job.'],
      ['source', 'string', 'web, markdown, github or agent.'],
      ['extRef', 'string | null', 'External reference, e.g. owner/repo#12 for an imported GitHub issue.'],
      ['acceptance', 'string[]', 'Acceptance criteria, one per item.'],
      ['gates', 'object', 'Latest verdict per gate: { G1: "pass", G4: "fail", … }.'],
      ['openControls', 'integer', 'Open stop/revert requests from the human.'],
      ['createdAt · updatedAt · integratedAt', 'number', 'Epoch ms (integratedAt null until integrated).'],
    ],
  },
  {
    id: 'task-detail',
    title: 'Task detail',
    intro: 'Returned by tasks_get: every Task summary field, plus:',
    fields: [
      ['body', 'string', 'The package description (Markdown).'],
      ['events', 'TaskEvent[]', 'History, newest first: { ts, actor, kind, from, to, detail }. kind is created, status, update, note, gate, gate_run, control or warning.'],
      ['gateResults', 'GateResult[]', 'Every gate result, newest first (see Gate result).'],
      ['controls', 'ControlRequest[]', 'Stop/revert requests, open and handled (see Control request).'],
      ['decisions', 'Decision[]', 'Decisions tied to the package.'],
      ['findings', 'Finding[]', 'Every finding of the package.'],
      ['gateRuns', 'GateRun[]', 'Gate runs on the runner.'],
    ],
  },
  {
    id: 'claim',
    title: 'Claim result',
    intro: 'Returned by tasks_claim. A refusal is not an error: task is null and reason says why.',
    fields: [
      ['task', 'Task | null', 'The claimed package, now in_lucru, or null.'],
      ['governor', 'GovernorVerdict', 'The governor\'s answer at the time of the claim.'],
      ['reason', 'string?', 'Why nothing was claimed: "governor: …", "no task is ready to start", "task P3 waits on P1", "task P3 is in_lucru, not gata".'],
      ['resources', 'object | null', '{ port, db, migrations: { from, to } }; null when the repo has no factory config.'],
    ],
  },
  {
    id: 'gate-result',
    title: 'Gate result',
    intro: 'Returned by gates_record; listed in tasks_get gateResults.',
    fields: [
      ['id', 'integer', 'Gate result id.'],
      ['gate', 'enum', 'G1…G5.'],
      ['round', 'integer', 'The round it counts in.'],
      ['verdict', 'enum', 'pass, fail or skip.'],
      ['summary', 'string', 'One paragraph.'],
      ['details', 'any', 'Whatever JSON was recorded with it.'],
      ['actor', 'string', 'agent:<token name>, runner:gate or web.'],
      ['createdAt', 'number', 'Epoch ms.'],
      ['shots', 'object[]', '{ id, name, mime, url }. The url (/api/gate-shots/:id) needs a web login.'],
    ],
  },
  {
    id: 'finding',
    title: 'Finding',
    intro: 'Returned by findings_list and findings_update.',
    fields: [
      ['id', 'integer', 'Finding id, used by findings_update and tasks_create fromFindings.'],
      ['taskId · gate · round · gateResultId', '', 'Where it was found.'],
      ['severity', 'enum', 'blocker, major or minor.'],
      ['title · file · line · detail · fix', '', 'As recorded.'],
      ['status', 'enum', 'open, fixed, deferred, for_architect or wontfix. A later pass of the same gate marks its open blockers and majors fixed.'],
      ['note', 'string | null', 'Why the status changed.'],
      ['deferredTo', 'string | null', 'The package made from it (tasks_create fromFindings).'],
      ['createdAt · updatedAt', 'number', 'Epoch ms.'],
    ],
  },
  {
    id: 'gate-run',
    title: 'Gate run',
    intro: 'Returned by gates_status. The log never leaves the server.',
    fields: [
      ['id', 'string', 'The runId.'],
      ['taskId · gate · round · args · machineId', '', 'What runs where.'],
      ['status', 'enum', 'queued (waiting for the runner), running, done (has a verdict) or error (no verdict: the gate could not run; no round is used).'],
      ['verdict · summary', '', 'Once done.'],
      ['findings', 'object[]', 'The findings the recipe reported.'],
      ['gateResultId', 'integer | null', 'The gate result recorded for it.'],
      ['exitCode · error', '', 'Diagnostics for error runs.'],
      ['logBytes', 'integer', 'Size of the log kept on the server (GET /api/gate-runs/:id/log, web login).'],
      ['createdAt · startedAt · finishedAt', 'number | null', 'Epoch ms.'],
      ['sent', 'boolean?', 'Whether a queued run was (re)sent to the runner just now.'],
    ],
  },
  {
    id: 'decision',
    title: 'Decision',
    intro: 'Returned by decision_ask and decision_get.',
    fields: [
      ['id', 'string', 'UUID.'],
      ['taskId', 'string | null', 'The package it is tied to.'],
      ['question · context', 'string', 'As asked.'],
      ['options', 'string[]', 'Suggested answers; the human may also type a free answer.'],
      ['status', 'enum', 'pending, answered or cancelled.'],
      ['answer', 'string | null', 'The human\'s answer.'],
      ['askedBy', 'string', 'agent:<token name>, or factory:rounds for round-limit questions.'],
      ['createdAt · answeredAt', 'number | null', 'Epoch ms.'],
    ],
  },
  {
    id: 'launch',
    title: 'Launch result',
    intro: 'Returned by tasks_launch and coordinator_launch. pending_approval and refused are answers, not errors.',
    fields: [
      ['status', 'enum', 'launched; pending_approval (the owner was asked: call again with the same arguments once decision_get shows the answer); refused (the owner said no or cancelled the question).'],
      ['kind', 'enum', 'worker or coordinator.'],
      ['jobId', 'string', 'launched: the runner job that starts it (UUID).'],
      ['launcher', 'enum', 'launched: hc (a herdr terminal) or claude (a claude -p job).'],
      ['machineId · cwd', 'string', 'launched: where it runs.'],
      ['taskId', 'string | null', 'launched: the package (worker), null for a coordinator.'],
      ['decisionId', 'string | null', 'The approval decision, when the token needs one.'],
      ['answer', 'string | null', "refused: the owner's answer."],
      ['reason', 'string', 'pending_approval and refused: what to do next.'],
    ],
  },
  {
    id: 'machine',
    title: 'Machine',
    intro: 'Returned by machines_list.',
    fields: [
      ['id', 'string', 'The machineId of tasks_launch and coordinator_launch.'],
      ['name · platform', 'string | null', 'As paired.'],
      ['runnerOnline', 'boolean', 'Its runner is connected now; a launch on an offline runner waits in the queue.'],
      ['allowedRoots', 'string[]', 'Folders the runner may work in; a cwd outside them is refused. Empty: the runner has not said.'],
      ['concurrency', 'number | null', 'How many jobs the runner runs at once.'],
      ['runnerSeenAt', 'number | null', 'Epoch ms of its last heartbeat.'],
    ],
  },
  {
    id: 'control',
    title: 'Control request',
    intro: 'Returned by control_get (in requests).',
    fields: [
      ['id', 'integer', 'Request id.'],
      ['taskId', 'string', 'The package.'],
      ['kind', 'enum', 'stop (stop working on the package) or revert (undo its integration). Buildyboy never runs git for you.'],
      ['note', 'string | null', 'The human\'s note.'],
      ['status', 'enum', 'open or acked.'],
      ['createdAt · ackedAt', 'number | null', 'Epoch ms.'],
    ],
  },
  {
    id: 'usage',
    title: 'Usage',
    intro: 'Returned by usage_get and GET /api/usage, and inside every governor verdict.',
    fields: [
      ['fiveHour · sevenDay', 'object | null', '{ pct (0–100), resetsAt (epoch ms or null) }; null when the window is not in the data.'],
      ['updatedAt', 'number | null', 'When the newest statusline sample arrived.'],
      ['ageMs', 'number | null', 'How old that sample is.'],
      ['sessionId', 'string | null', 'The session that sent it.'],
    ],
  },
  {
    id: 'governor',
    title: 'Governor verdict',
    intro: 'Returned by governor_get and GET /api/governor.',
    fields: [
      ['canStart', 'boolean', 'May a new worker start now?'],
      ['stopAll', 'boolean', 'The 7-day window is over its limit: stop the factory until it resets.'],
      ['waitUntil', 'number | null', 'Epoch ms to wait for, when known.'],
      ['reason', 'string', 'Human-readable, e.g. "ok: 5-hour 12%, 7-day 30%".'],
      ['usage', 'Usage', 'The data it decided on.'],
      ['thresholds', 'object', '{ fiveHourPct (85), sevenDayPct (80), maxAgeMin (30) }.'],
      ['local · stale', 'boolean?', 'Only from `bb mcp` while the server is unreachable: computed from the local statusline sample.'],
    ],
  },
  {
    id: 'session',
    title: 'Session',
    intro: 'Returned by sessions_list (summaries) and sessions_get (detail).',
    fields: [
      ['id', 'string', 'The Claude Code session id.'],
      ['machineId · machineName · projectId · projectName · cwd', '', 'Where it runs.'],
      ['source', 'string', 'hook, job, import or bg.'],
      ['name · model', 'string | null', ''],
      ['status', 'enum', 'working, waiting, idle, compacting, stale, ended or error.'],
      ['statusReason · activity', 'string | null', 'What it is doing or waiting for.'],
      ['branch · dirty', '', 'Git state.'],
      ['startedAt · lastEventAt · endedAt', 'number | null', 'Epoch ms.'],
      ['costUsd · contextPct', 'number', 'Cost so far and context window use.'],
      ['jobId · job', '', 'The Buildyboy job that started it, if any.'],
      ['walkMode · pendingCount', '', 'Remote approvals on; open approvals/questions.'],
      ['belt · drones', 'array', 'The last ~20 tool calls; running subagents.'],
      ['detail only', '', 'effort, permissionMode, transcriptPath, parentSessionId, endReason, tokens { input, output, cacheRead, cacheWrite }, cacheHitPct, compactions, waitMs and more.'],
    ],
  },
  {
    id: 'digest',
    title: 'Digest',
    intro: 'Returned by digest_post.',
    fields: [
      ['id', 'integer', ''],
      ['ts', 'number', 'Epoch ms.'],
      ['kind', 'enum', 'daily or manual.'],
      ['title · body', 'string', 'The text that was pushed to the phone.'],
    ],
  },
];

// ---------- MCP tools ----------

export const TOOL_GROUPS = [
  { id: 'usage', title: 'Usage and the governor' },
  { id: 'sessions', title: 'Sessions' },
  { id: 'backlog', title: 'Backlog' },
  { id: 'prompts', title: 'Prompts' },
  { id: 'gates', title: 'Gates and findings' },
  { id: 'launch', title: 'Launching workers and coordinators' },
  { id: 'human', title: 'The human: decisions, controls, digest' },
  { id: 'docs', title: 'Documentation' },
] as const;
type ToolGroupId = (typeof TOOL_GROUPS)[number]['id'];

interface ToolDoc {
  group: ToolGroupId;
  /** when to call it, in one or two sentences */
  use: string;
  /** a description for every argument path (top level, and `list[].field` for arrays of objects) */
  args: Record<string, string>;
  returns: string;
  shapes?: string[];
  errors?: string[];
  example: Record<string, unknown>;
  notes?: string[];
}

const tmpl = {
  templateId: 'Template id (see GET /api/templates). Omit both templateId and template for the built-in harness template.',
  template: 'Template name instead of an id, e.g. "harness".',
};

export const TOOL_DOCS: Record<ToolName, ToolDoc> = {
  usage_get: {
    group: 'usage',
    use: 'Read the Claude subscription windows. Usually governor_get is what you want: it applies the rules to the same data.',
    args: {},
    returns: 'Usage.',
    shapes: ['usage'],
    example: {},
    notes: ['The data comes from the statusline bridge of interactive sessions; it is null until one has run.'],
  },
  governor_get: {
    group: 'usage',
    use: 'Before starting any new worker, and at the top of every coordinator loop. canStart false means wait (until waitUntil when known); stopAll means stop the factory.',
    args: {},
    returns: 'Governor verdict.',
    shapes: ['governor', 'usage'],
    example: {},
    notes: [
      'Rules: 7-day window at or above 80% → stopAll; 5-hour window at or above 85% → no new workers (active ones finish); usage data older than 30 min, or none → no new workers. The three numbers are settings.',
      'tasks_claim checks the governor itself and refuses unless force: true.',
    ],
  },
  sessions_list: {
    group: 'sessions',
    use: 'See the Claude Code sessions Buildyboy knows about: what each is doing, its cost, context use and branch.',
    args: { live: 'Only sessions that have not ended.', limit: 'At most this many (default 50), newest activity first.' },
    returns: 'Session summary[].',
    shapes: ['session'],
    example: { live: true, limit: 20 },
  },
  sessions_get: {
    group: 'sessions',
    use: 'One session in detail, e.g. a worker you started, to check its status, cost or tokens.',
    args: { id: 'The Claude Code session id.' },
    returns: 'Session detail.',
    shapes: ['session'],
    errors: ['404 unknown session <id>'],
    example: { id: '6f1c2e9a-…' },
  },
  tasks_list: {
    group: 'backlog',
    use: 'Read the backlog. With ready: true, only packages that can start now (status gata and every dependency integrated), in claim order.',
    args: {
      status: 'Only these statuses.',
      ready: 'Only packages tasks_claim could take now.',
      limit: 'At most this many (default 500).',
    },
    returns: 'Task summary[], by priority (high first), then age.',
    shapes: ['task'],
    example: { ready: true },
  },
  tasks_get: {
    group: 'backlog',
    use: 'Everything about one package: body, acceptance criteria, history, gate results with screenshots, findings, gate runs, decisions and stop/revert requests.',
    args: { id: 'Package id.' },
    returns: 'Task detail.',
    shapes: ['task-detail', 'task'],
    errors: ['404 unknown task <id>'],
    example: { id: 'P3' },
  },
  tasks_create: {
    group: 'backlog',
    use: 'Add a package to the backlog, or (upsert) update one you created earlier, e.g. when re-importing a plan. fromFindings turns chosen gate findings into a follow-up package.',
    args: {
      id: 'Package id; generated as T<n> when omitted. Letters, digits, ".", "_" and "-".',
      title: 'One line.',
      body: 'Description (Markdown).',
      acceptance: 'Acceptance criteria, one per item. The gates check against them.',
      dependsOn: 'Ids this package waits for; it becomes ready only when all are integrata.',
      repo: 'Repository name. Must match Settings → Factory for resources and gates_run.',
      branch: 'Worker branch.',
      priority: 'Higher is claimed first (-1000…1000, default 0).',
      sensitive: 'Auth, RLS, import, pseudonymisation: flagged in the digest.',
      status: 'Initial status (default backlog). Use gata to make it claimable.',
      upsert: 'Update the package if the id exists. Its status changes only while it is still backlog or gata.',
      extRef: 'External reference, unique per package, e.g. owner/repo#12. Without an id, an existing package with this extRef is the one updated.',
      fromFindings: 'Finding ids: they make the body and acceptance criteria and are marked deferred to the new package.',
    },
    returns: 'Task summary.',
    shapes: ['task'],
    errors: [
      '409 task <id> already exists (without upsert)',
      '409 <extRef> already belongs to another task',
      '400 a bad id, a dependency that does not exist or a dependency cycle',
      '400 too many acceptance criteria or too long a body with fromFindings',
    ],
    example: { id: 'P4', title: 'Export to CSV', status: 'gata', repo: 'arond', dependsOn: ['P3'], acceptance: ['`pnpm test export` passes', 'The export button downloads a CSV of the visible rows'] },
  },
  tasks_claim: {
    group: 'backlog',
    use: 'Take a package to work on. Without id, the next ready one by priority. It becomes in_lucru, claimed by you, and gets its port, database name and migration range.',
    args: {
      id: 'Claim this package (it must be ready).',
      agent: 'Name recorded as claimedBy (default: agent:<token name>).',
      force: 'Claim even when the governor says canStart is false. Only when the human asked for it.',
    },
    returns: 'Claim result. When nothing can be claimed, task is null and reason says why: this is not an error.',
    shapes: ['claim', 'task', 'governor'],
    errors: ['404 unknown task <id> (with id)'],
    example: { agent: 'coordinator' },
    notes: ['Claiming is atomic: two coordinators never get the same package.', 'Resources are kept until the package is integrated.'],
  },
  tasks_update: {
    group: 'backlog',
    use: 'Move a package through its life and record what happened: status, branch, terminal, session, prompt version, cost, migrations used, notes.',
    args: {
      id: 'Package id.',
      status: 'New status. Moving into la_porti starts a gate round (refused past the limit). blocata → in_lucru with a note allows one more round. integrata returns the cleanup list.',
      branch: 'Worker branch.',
      costUsd: 'Cost set by hand; measured costs of linked sessions take precedence in costUsd.',
      promptId: 'Saved prompt id (prompts_save with taskId sets it for you).',
      promptVersion: 'Saved prompt version.',
      terminal: 'herdr terminal address of the worker, e.g. t7.',
      sessionId: 'Claude Code session id of the worker.',
      note: 'A note for the history (and the reason for a status change).',
      dependsOn: 'Replace the dependencies.',
      acceptance: 'Replace the acceptance criteria.',
      migrationsUsed: 'Migration numbers the package uses; checked against the other active packages when it is integrated.',
    },
    returns: 'Task summary, plus cleanup (string[]: the repo\'s cleanup lines, filled in) and warnings (string[]: other packages that must renumber migrations) when it was integrated.',
    shapes: ['task'],
    errors: ['404 unknown task <id>', '409 <id> has used its N gate rounds (moving into la_porti)', '400 a dependency cycle or an unknown dependency'],
    example: { id: 'P3', status: 'la_porti', branch: 'pachet/P3', terminal: 't7', note: 'worker finished, all tests green' },
    notes: ['Every change is kept in the package history with you as the actor.', 'Queued by `bb mcp` while the server is unreachable.'],
  },
  prompts_render: {
    group: 'prompts',
    use: 'Fill a prompt template (by default the harness template: Goal, Done when, Scope, Limit, Subagents, Branch, PR, Unattended) and get the Markdown to hand to a worker, with lint warnings.',
    args: { ...tmpl, slots: 'Slot values by slot name, e.g. { "Goal": "…", "Done when": "`pnpm verify` passes" }.', extraMd: 'Markdown appended after the template (spec, notes).' },
    returns: '{ templateId, template, rendered (Markdown), warnings: [{ id, slot?, message }] }.',
    errors: ['404 unknown template'],
    example: { slots: { Goal: 'Build P3: CSV export', 'Done when': '`pnpm verify` passes', Scope: 'web/src/export/**', Unattended: 'yes', Limit: '2 hours' } },
  },
  prompts_lint: {
    group: 'prompts',
    use: 'Check slot values without rendering: empty Done when, no runnable check, unattended without a limit, unfilled or leftover placeholders.',
    args: { ...tmpl, slots: 'Slot values by slot name.' },
    returns: '{ templateId, warnings: [{ id, slot?, message }] }. An empty list means clean.',
    errors: ['404 unknown template'],
    example: { slots: { Goal: 'Build P3', 'Done when': '' } },
  },
  prompts_save: {
    group: 'prompts',
    use: 'Keep the prompt you gave a worker as a versioned prompt in the library. With taskId, the package records the prompt and its version.',
    args: {
      id: 'Save a new version of this prompt instead of a new prompt.',
      title: 'Prompt title.',
      ...tmpl,
      slots: 'Slot values by slot name.',
      extraMd: 'Markdown appended after the template.',
      tags: 'Up to 20 tags.',
      taskId: 'Link the saved prompt and version to this package.',
    },
    returns: '{ id, version, title, rendered }.',
    errors: ['404 unknown template', '404 unknown prompt <id>', '404 unknown task <taskId>'],
    example: { title: 'P3 worker', taskId: 'P3', slots: { Goal: 'Build P3: CSV export', 'Done when': '`pnpm verify` passes' } },
    notes: ['Queued by `bb mcp` while the server is unreachable.'],
  },
  gates_record: {
    group: 'gates',
    use: 'Record a gate result you produced yourself (a review, a QA pass with screenshots). For gates defined in the repo\'s recipe, use gates_run instead.',
    args: {
      taskId: 'Package id.',
      gate: Object.entries(GATE_LABEL).map(([g, l]) => `${g} ${l}`).join('; ') + '.',
      verdict: 'pass, fail or skip.',
      summary: 'One paragraph the human reads on the phone.',
      details: 'Any JSON you want kept with the result.',
      screenshots: 'Up to 12 images (png, jpeg, webp or gif, 5 MB each).',
      'screenshots[].name': 'Label, e.g. "desktop" or "phone".',
      'screenshots[].path': 'Local file path. Only `bb mcp` (stdio) reads it and uploads it; over HTTP send base64.',
      'screenshots[].base64': 'The image bytes, base64.',
      'screenshots[].mime': 'image/png, image/jpeg, image/webp or image/gif (sniffed when omitted).',
      findings: 'Problems found, up to 200.',
      'findings[].severity': 'blocker, major or minor.',
      'findings[].title': 'One line.',
      'findings[].file': 'File path, if any.',
      'findings[].line': 'Line number, if any.',
      'findings[].detail': 'What is wrong.',
      'findings[].fix': 'How to fix it.',
    },
    returns: 'Gate result.',
    shapes: ['gate-result', 'finding'],
    errors: ['404 unknown task <taskId>', '400 a screenshot without image data, too large, or not an image'],
    example: {
      taskId: 'P3', gate: 'G3', verdict: 'fail', summary: 'Review: the export ignores the active filter.',
      findings: [{ severity: 'major', title: 'Export ignores the filter', file: 'web/src/export/csv.ts', line: 42, fix: 'Pass the filtered rows' }],
    },
    notes: [
      'Rounds: a result counts in the package\'s current round. A fail in the last allowed round blocks the package (blocata) and asks the human whether to allow another round.',
      'A pass marks the gate\'s earlier open blockers and majors fixed; minors stay open.',
      'Queued by `bb mcp` while the server is unreachable.',
    ],
  },
  gates_run: {
    group: 'gates',
    use: 'Run a gate on the repo\'s runner, from the recipe in its main checkout (Settings → Factory). Then poll gates_status until done or error.',
    args: { taskId: 'Package id; its repo needs a factory config.', gate: 'G1…G5.', args: 'Extra arguments for the recipe\'s {args} placeholder.' },
    returns: '{ runId, status, round, machineId, sent, note? }. sent is false when the runner is offline; the run starts when gates_status finds it back.',
    shapes: ['gate-run'],
    errors: ['404 unknown task <taskId>', '400 no factory config for the repo, or one without a machine, checkout or recipe'],
    example: { taskId: 'P3', gate: 'G1' },
    notes: [
      'The runner runs the gate\'s argv steps without a shell, in the main checkout. Exit 0 = pass (or skip), 1 = fail, anything else = error; the last stdout line is JSON { verdict, summary, details?, findings?, shots? }.',
      'A verdict is recorded like gates_record (actor runner:gate). An error records nothing and uses no round.',
    ],
  },
  gates_status: {
    group: 'gates',
    use: 'Poll a gate run (every 10–30 s is plenty). Re-sends a run still queued to its runner.',
    args: { runId: 'From gates_run.' },
    returns: 'Gate run: state, and once done the verdict, summary, findings and gate result id. Never the log.',
    shapes: ['gate-run'],
    errors: ['404 unknown gate run <runId>'],
    example: { runId: '0b8e…' },
    notes: ['A run still running 6 h after it started becomes an error.'],
  },
  findings_list: {
    group: 'gates',
    use: 'Read findings: what a worker must fix (open blockers and majors of its package), or the open minors to batch into a follow-up package.',
    args: { taskId: 'Only this package.', status: 'Only this status.', severity: 'Only this severity.', limit: 'At most this many (default 500).' },
    returns: 'Finding[], open first, then by severity.',
    shapes: ['finding'],
    example: { taskId: 'P3', status: 'open' },
  },
  findings_update: {
    group: 'gates',
    use: 'Triage findings: fixed, deferred, for_architect (needs a design decision), wontfix, or back to open.',
    args: { ids: 'Finding ids.', status: 'open, fixed, deferred, for_architect or wontfix.', note: 'Why.' },
    returns: 'The updated Finding[].',
    shapes: ['finding'],
    example: { ids: [17, 18], status: 'wontfix', note: 'cosmetic, accepted by the architect' },
  },
  decision_ask: {
    group: 'human',
    use: 'Ask the human something only they can decide. It lands in the PWA\'s Decisions inbox and pushes a notification to the phone. Poll decision_get for the answer.',
    args: {
      question: 'The question, answerable on a phone.',
      context: 'What they need to know to answer (Markdown).',
      options: 'Up to 8 suggested answers; they may also type their own.',
      taskId: 'Tie it to a package.',
    },
    returns: 'Decision (status pending).',
    shapes: ['decision'],
    errors: ['400 unknown task <taskId>'],
    example: { question: 'P5 needs a new table. Add it now or wait for the schema review?', options: ['Add it now', 'Wait for the review'], taskId: 'P5' },
    notes: ['While you wait, keep working on what does not depend on the answer.'],
  },
  decision_get: {
    group: 'human',
    use: 'Read a decision and, once answered, the answer. Poll every few minutes, not seconds.',
    args: { id: 'From decision_ask.' },
    returns: 'Decision.',
    shapes: ['decision'],
    errors: ['404 unknown decision <id>'],
    example: { id: '3c0d…' },
  },
  digest_post: {
    group: 'human',
    use: 'Send the digest now (it also goes out daily on its own): what was integrated in 24 h, gate passes and failures, packages in progress and blocked, usage, decisions waiting, unhandled stop/revert requests.',
    args: { note: 'A note at the top, e.g. why you are sending it.' },
    returns: 'Digest.',
    shapes: ['digest'],
    example: { note: 'P1–P3 integrated; pausing for the night' },
    notes: ['Queued by `bb mcp` while the server is unreachable.'],
  },
  machines_list: {
    group: 'launch',
    use: 'Before tasks_launch or coordinator_launch: pick the machine (runnerOnline) and a cwd inside its allowed roots.',
    args: {},
    returns: 'Machine[] (paired, not revoked), by name.',
    shapes: ['machine'],
    example: {},
  },
  tasks_launch: {
    group: 'launch',
    use: 'Start the worker for a package you claimed, on a runner, instead of starting it yourself. Only when your token may launch workers (the owner turns it on in Settings → Factory → Agent tokens).',
    args: {
      taskId: 'The package.',
      machineId: 'The machine whose runner starts it: an id from machines_list.',
      cwd: "Working directory on that machine. It must be inside the runner's allowed roots (machines_list).",
      launcher: 'hc (default): an interactive claude in a new herdr terminal; claude: a headless claude -p job.',
      model: "Model for claude, e.g. sonnet or opus. Default: the machine's default.",
      permissionMode: 'default, acceptEdits, plan, auto, dontAsk or bypassPermissions.',
      maxBudgetUsd: 'Spending limit of a claude -p job, 0–1000 (default 5).',
      promptId: "A saved prompt (prompts_save). Default: the package's own prompt, else one made from its title, body and acceptance criteria.",
    },
    returns: 'Launch result. launched: the package is in_lucru and claimed (by you, if nobody had claimed it); the job records its herdr terminal or session on the package.',
    shapes: ['launch'],
    errors: [
      '403 this agent token may not launch workers', '404 unknown task', '409 this package is already integrated', '409 governor: <reason>',
      "400 cwd is outside the runner's allowed roots", '400 unknown machine / unknown prompt / invalid model',
    ],
    example: { taskId: 'P3', machineId: '6f1c…', cwd: '/home/me/src/arond', launcher: 'hc', permissionMode: 'acceptEdits' },
    notes: [
      'Refused while governor_get says canStart is false: there is no force.',
      'When the owner asked to approve launches, the first call puts a question in their inbox and answers pending_approval with its decisionId. Call again with the same arguments: pending_approval while they have not answered, launched once they answer Launch (within 24 hours), refused otherwise. Do not ask again for a launch they refused unless something changed.',
      'Every launch is in the audit log as agent:<token name>.',
    ],
  },
  coordinator_launch: {
    group: 'launch',
    use: 'Start another coordinator (for example one per repo, or a fresh one on another machine). Only when your token may launch coordinators.',
    args: {
      machineId: 'The machine whose runner starts it: an id from machines_list.',
      cwd: "Working directory on that machine. It must be inside the runner's allowed roots (machines_list).",
      launcher: 'hc (default): an interactive claude in a new herdr terminal; claude: a headless claude -p job.',
      model: "Model for claude, e.g. sonnet or opus. Default: the machine's default.",
      permissionMode: 'default, acceptEdits, plan, auto, dontAsk or bypassPermissions.',
      maxBudgetUsd: 'Spending limit of a claude -p job, 0–1000 (default 5).',
      promptId: 'A saved prompt to start it with, instead of the built-in coordinator prompt.',
      prompt: 'Its first prompt as text (at most 24 000 characters), instead of the built-in one: what to coordinate, which repo.',
      title: 'Session name (default Coordinator).',
    },
    returns: 'Launch result. The herdr terminal is named bb-coord-<job> and labelled bb.role=coordonator.',
    shapes: ['launch'],
    errors: ['403 this agent token may not launch coordinators', '409 governor: <reason>', "400 cwd is outside the runner's allowed roots", '400 unknown machine / unknown prompt / invalid model'],
    example: { machineId: '6f1c…', cwd: '/home/me/src/arond', prompt: 'Coordinate the arond backlog: packages whose repo is arond only.' },
    notes: [
      'The built-in prompt tells it to read docs_get and run the coordinator loop. The machine needs the buildyboy MCP server registered for Claude Code (user scope) so the new coordinator has the tools.',
      'Governor and approval work as in tasks_launch.',
    ],
  },
  control_get: {
    group: 'human',
    use: 'Check, at the top of every loop, whether the human asked to stop a package or revert its integration. Handle them, then call again with ack: true.',
    args: { taskId: 'Only this package.', ack: 'Mark the returned requests handled.' },
    returns: '{ requests: ControlRequest[], acked }.',
    shapes: ['control'],
    example: { ack: true },
    notes: ['Buildyboy never runs git on your repositories: a revert request is yours to carry out.'],
  },
  docs_get: {
    group: 'docs',
    use: 'Read this manual from inside a session. Topic start once before your first run; tools or api when you need the details.',
    args: { topic: 'start (default), tools, api or all.', tool: 'One tool\'s entry only, e.g. "tasks_claim".' },
    returns: 'Markdown text.',
    errors: ['400 unknown tool'],
    example: { topic: 'start' },
  },
};

export interface ArgRow {
  name: string;
  type: string;
  required: boolean;
  desc: string;
}

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
  description?: string;
  additionalProperties?: JsonSchema;
};

const SAFE = 9007199254740991;

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => String(v)).join(' | ');
  if (s.type === 'array') {
    const item = s.items ?? {};
    const inner = item.type === 'object' && item.properties ? 'object' : typeOf(item);
    const count = s.maxItems != null ? `, ${s.minItems ? `${s.minItems}–` : 'up to '}${s.maxItems}` : '';
    return `${inner}[]${count}`;
  }
  if (s.type === 'object') return s.additionalProperties ? `{ [name]: ${typeOf(s.additionalProperties)} }` : 'object';
  if (s.type === 'integer' || s.type === 'number') {
    const lo = s.minimum != null && s.minimum > -SAFE ? s.minimum : null;
    const hi = s.maximum != null && s.maximum < SAFE ? s.maximum : null;
    return lo != null && hi != null ? `${s.type} ${lo}…${hi}` : lo != null ? `${s.type} ≥ ${lo}` : hi != null ? `${s.type} ≤ ${hi}` : s.type;
  }
  if (s.type === 'string') return s.maxLength != null ? `string ≤ ${s.maxLength.toLocaleString('en-US')}` : 'string';
  if (s.type) return s.type;
  return 'any JSON';
}

export function toolSchema(name: ToolName): JsonSchema {
  return z.toJSONSchema(TOOLS[name].input, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

/** One row per argument, and per field of an array of objects (`findings[].severity`). */
export function argRows(name: ToolName): ArgRow[] {
  const docs = TOOL_DOCS[name].args;
  const rows: ArgRow[] = [];
  const walk = (props: Record<string, JsonSchema>, required: string[], prefix: string) => {
    for (const [key, s] of Object.entries(props)) {
      const path = `${prefix}${key}`;
      rows.push({ name: path, type: typeOf(s), required: required.includes(key), desc: docs[path] ?? s.description ?? '' });
      if (s.type === 'array' && s.items?.type === 'object' && s.items.properties) walk(s.items.properties, s.items.required ?? [], `${path}[].`);
    }
  };
  const root = toolSchema(name);
  walk(root.properties ?? {}, root.required ?? [], '');
  return rows;
}

// ---------- HTTP API ----------

export type Auth = 'public' | 'web' | 'machine' | 'agent' | 'web-or-agent';

export const AUTH: Record<Auth, { label: string; desc: string }> = {
  public: { label: 'Public', desc: 'No credentials. Holds no data, or its own one-time credential is in the request.' },
  web: {
    label: 'Web login',
    desc: 'The PWA\'s session cookie bb_session (from POST /api/auth/login). Every request other than GET also needs the header x-bb-csrf with the value of the bb_csrf cookie.',
  },
  machine: { label: 'Machine token', desc: '"Authorization: Bearer bbm_…": the token a paired machine keeps in ~/.buildyboy/config.json. Used by the plugin\'s hooks, the statusline bridge, OTEL export and the runner.' },
  agent: { label: 'Agent token', desc: '"Authorization: Bearer bba_…": created in Settings → Factory → Agent tokens, revocable. Reaches only the agent API, /mcp, /api/governor and /api/usage. It starts workers or coordinators only when the owner allows it for that token.' },
  'web-or-agent': { label: 'Web login or agent token', desc: 'Either one.' },
};

export interface Field {
  name: string;
  desc: string;
}

export interface Endpoint {
  method: string;
  /** exactly as registered in Hono (the test compares them) */
  path: string;
  auth: Auth;
  summary: string;
  query?: Field[];
  body?: Field[];
  returns: string;
  errors?: string[];
  notes?: string[];
}

export interface ApiGroup {
  id: string;
  title: string;
  intro: string;
  endpoints: Endpoint[];
}

const f = (name: string, desc: string): Field => ({ name, desc });
const OK = '{ ok: true }';

export const API_GROUPS: ApiGroup[] = [
  {
    id: 'agent',
    title: 'Agents: MCP and the agent API',
    intro: 'What an AI agent or a script acting for one should use. Everything here takes an agent token.',
    endpoints: [
      {
        method: 'ALL', path: '/mcp', auth: 'agent',
        summary: 'The Streamable HTTP MCP endpoint: every Buildyboy tool for remote MCP clients. Stateless: send JSON-RPC with POST (initialize, tools/list, tools/call…).',
        body: [f('(JSON-RPC)', 'An MCP request or notification. Accept: application/json, text/event-stream.')],
        returns: 'The JSON-RPC response as JSON, or as an SSE stream when the client prefers it. GET and DELETE answer 405 (no sessions).',
        errors: ['401 without a valid agent token (with WWW-Authenticate: Bearer)', '413 a body over ~95 MB'],
        notes: [
          'Serves both the 2026-07-28 protocol and 2025-era stateless clients.',
          'Tools run in-process under your agent token; results and refusals are the same as POST /api/agent/<tool>.',
          'Unlike `bb mcp`, there is no offline queue, and gates_record screenshots must be sent as base64.',
        ],
      },
      {
        method: 'POST', path: '/api/agent/:tool', auth: 'agent',
        summary: 'Call one MCP tool over plain HTTP, with the same arguments. What `bb mcp` does for every call.',
        body: [f('(tool arguments)', 'The tool\'s arguments as a JSON object; {} for none.')],
        returns: '{ result } with the tool\'s result; { result, replayed: true } when the idempotency key was seen before.',
        errors: ['401 unauthorized', '404 unknown tool <name>', '400 invalid arguments: <path> <problem>', 'Each tool\'s own 4xx answers, as { error }'],
        notes: ['Header idempotency-key (optional, ≤ 200 chars): a repeated key returns the first answer and changes nothing (kept 30 days). Use it for writes you may retry.'],
      },
      {
        method: 'GET', path: '/api/governor', auth: 'web-or-agent',
        summary: 'The governor\'s verdict (same as governor_get).',
        returns: 'Governor verdict.',
      },
      {
        method: 'GET', path: '/api/usage', auth: 'web-or-agent',
        summary: 'The subscription usage windows (same as usage_get).',
        returns: 'Usage.',
      },
      {
        method: 'ALL', path: '/.well-known/oauth-protected-resource', auth: 'public',
        summary: 'Answers 404 JSON on purpose: Buildyboy uses static agent tokens, not OAuth. Stops MCP clients from parsing the app shell as OAuth metadata.',
        returns: '404 { error }.',
      },
      { method: 'ALL', path: '/.well-known/oauth-protected-resource/*', auth: 'public', summary: 'As above, for path-suffixed metadata lookups.', returns: '404 { error }.' },
      { method: 'ALL', path: '/.well-known/oauth-authorization-server', auth: 'public', summary: 'As above.', returns: '404 { error }.' },
      { method: 'ALL', path: '/.well-known/openid-configuration', auth: 'public', summary: 'As above.', returns: '404 { error }.' },
    ],
  },
  {
    id: 'public',
    title: 'Public: health, docs, installers, pairing',
    intro: 'No credentials needed.',
    endpoints: [
      { method: 'GET', path: '/api/health', auth: 'public', summary: 'Liveness check.', returns: '{ ok: true, version, time }.' },
      { method: 'GET', path: '/docs', auth: 'public', summary: 'This manual\'s home page (HTML).', returns: 'HTML.' },
      { method: 'GET', path: '/docs/', auth: 'public', summary: 'Redirects to /docs.', returns: '301.' },
      { method: 'GET', path: '/docs/:slug', auth: 'public', summary: 'A manual page (HTML).', returns: 'HTML, or a 404 page.' },
      { method: 'GET', path: '/docs/*', auth: 'public', summary: 'Anything else under /docs: the 404 page.', returns: '404 HTML.' },
      { method: 'GET', path: '/docs/assets/:version/:file{.+}', auth: 'public', summary: 'The manual\'s CSS, JS and images. The version is a content hash.', returns: 'The file.' },
      {
        method: 'GET', path: '/docs/agents.md', auth: 'public',
        summary: 'The whole agent guide as one Markdown file: concepts, connecting, the loop, every tool, every endpoint. The best thing to give an agent to read.',
        query: [f('topic', 'start, tools, api or all (default all).')],
        returns: 'text/markdown.',
      },
      { method: 'GET', path: '/llms.txt', auth: 'public', summary: 'A short llms.txt index pointing agents at the guide and the MCP endpoint.', returns: 'text/markdown.' },
      { method: 'GET', path: '/install.sh', auth: 'public', summary: 'The Linux/macOS/WSL client installer, with this server\'s URL filled in. Run with a pairing code: curl -fsSL <url>/install.sh | bash -s -- CODE.', returns: 'text/plain.' },
      { method: 'GET', path: '/install.ps1', auth: 'public', summary: 'The Windows client installer: $env:BB_CODE=\'CODE\'; irm <url>/install.ps1 | iex.', returns: 'text/plain.' },
      { method: 'GET', path: '/plugin.tgz', auth: 'public', summary: 'The Claude Code plugin as a one-plugin marketplace, for the installers.', returns: 'application/gzip.' },
      {
        method: 'POST', path: '/api/pair', auth: 'public',
        summary: 'Exchange a one-time pairing code (Settings → Machines, valid 10 minutes) for a machine token.',
        body: [f('code', 'The pairing code (required).'), f('name · hostname · platform · arch · user', 'Optional machine details.')],
        returns: '{ machineId, token (bbm_…), url }.',
        errors: ['403 invalid or expired code', '429 too many attempts (20 a minute per IP)'],
      },
      {
        method: 'POST', path: '/api/push/act', auth: 'public',
        summary: 'Allow or Deny pressed on a push notification. The one-time token from the notification is the credential.',
        body: [f('token', 'The action token.'), f('decision', 'allow or deny.')],
        returns: OK,
        errors: ['403 invalid or expired token', '409 already handled', '429 rate limited'],
      },
    ],
  },
  {
    id: 'account',
    title: 'Web login and account',
    intro: 'How a browser (or a script acting as the owner) logs in. Agents should use an agent token instead.',
    endpoints: [
      { method: 'GET', path: '/api/me', auth: 'public', summary: 'Am I logged in, and is the first-run setup still open?', returns: '{ authenticated, setupRequired, csrf }.' },
      {
        method: 'POST', path: '/api/auth/login', auth: 'public',
        summary: 'Log in with the password. Sets the bb_session (HttpOnly) and bb_csrf cookies, valid 30 days.',
        body: [f('password', 'The web password.')],
        returns: OK,
        errors: ['401 wrong password', '429 too many attempts'],
      },
      {
        method: 'POST', path: '/api/auth/setup', auth: 'public',
        summary: 'First run only: choose the password with the setup token the server printed, and log in.',
        body: [f('token', 'The setup token from the server log.'), f('password', 'At least 8 characters.')],
        returns: OK,
        errors: ['403 invalid setup token', '400 password too short', '429 too many attempts'],
      },
      { method: 'POST', path: '/api/auth/logout', auth: 'web', summary: 'End this login.', returns: OK },
      {
        method: 'POST', path: '/api/auth/password', auth: 'web',
        summary: 'Change the password. Logs out every other device.',
        body: [f('current', 'The current password.'), f('next', 'The new one, at least 8 characters.')],
        returns: OK,
        errors: ['401 wrong password', '400 too short'],
      },
      { method: 'GET', path: '/api/auth/devices', auth: 'web', summary: 'Logged-in devices.', returns: '[{ id, device, ip, created_at, last_seen_at, current }].' },
      { method: 'DELETE', path: '/api/auth/devices/:id', auth: 'web', summary: 'Log a device out.', returns: OK },
      {
        method: 'GET', path: '/api/settings', auth: 'web',
        summary: 'Server settings. Secrets read back masked.',
        returns: '{ walk_mode, pause_all, stop_wait_min, retention_days, redaction_rules, budget_session_usd, budget_job_usd, watchers, ntfy_url, quiet_hours, push_types, github_token (masked), context_threshold_pct, governor_five_hour_pct, governor_seven_day_pct, governor_max_age_min, digest_enabled, digest_time, public_url, vapid_public_key }.',
      },
      {
        method: 'PUT', path: '/api/settings', auth: 'web',
        summary: 'Change settings. Send only the keys to change; null resets one to its default; the masked secret value is ignored.',
        body: [f('(any setting key)', 'The keys listed under GET /api/settings, except public_url and vapid_public_key.')],
        returns: '{ ok: true, changed: string[] }.',
      },
      { method: 'GET', path: '/api/audit', auth: 'web', summary: 'The last 200 audit log entries.', returns: '[{ ts, actor, action, target, detail }].' },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions, the Floor and the Inbox',
    intro: 'What the PWA shows about Claude Code sessions, and how it steers them. Web login.',
    endpoints: [
      {
        method: 'GET', path: '/api/stream', auth: 'web',
        summary: 'Server-sent events for live updates.',
        query: [f('topics', 'Comma-separated: floor, inbox, machines, jobs, tasks, session:<id>, session:* or * (default floor,inbox).'), f('lastEventId', 'Resume after this event id (or the Last-Event-ID header).')],
        returns: 'SSE: hello { lastId }, then message { topic, type, data } events, ping every 25 s, reset when resuming is not possible.',
      },
      { method: 'GET', path: '/api/attention', auth: 'web', summary: 'Counters for the attention bar.', returns: '{ waiting, pending, jobsFailed, stale, decisions }.' },
      {
        method: 'GET', path: '/api/sessions', auth: 'web',
        summary: 'Sessions, newest activity first.',
        query: [f('live', '1 for sessions that have not ended.'), f('since', 'Epoch ms: active since.'), f('project', 'Project id.'), f('machine', 'Machine id.'), f('limit', 'Up to 1000.')],
        returns: 'Session summary[].',
      },
      { method: 'GET', path: '/api/sessions/:id', auth: 'web', summary: 'One session.', returns: 'Session detail.', errors: ['404 not found'] },
      {
        method: 'GET', path: '/api/sessions/:id/timeline', auth: 'web',
        summary: 'The session\'s timeline (prompts, tool calls, replies), newest page first.',
        query: [f('cursor', 'From the previous page, for older items.')],
        returns: '{ items, cursor }.',
      },
      { method: 'GET', path: '/api/sessions/:id/side', auth: 'web', summary: 'The side panels: todos, files changed, git (snapshots, commits, PRs), subagents, progress doc, queued messages, pending actions.', returns: '{ todos, files, fileChanges, git, subagents, progress, queued, pending }.' },
      { method: 'GET', path: '/api/sessions/:id/events', auth: 'web', summary: 'Raw hook events, newest first.', query: [f('limit', 'Up to 2000 (default 500).')], returns: '[{ id, ts, event, toolName, summary, payload }].' },
      { method: 'GET', path: '/api/sessions/:id/export.md', auth: 'web', summary: 'The session as a Markdown download.', returns: 'text/markdown.', errors: ['404 not found'] },
      {
        method: 'POST', path: '/api/sessions/:id/messages', auth: 'web',
        summary: 'Send the session a message. If it is holding at Stop waiting for you, the message answers that wait; otherwise it is queued and delivered by the next hook.',
        body: [f('text', 'Up to 20 000 characters.'), f('mode', 'after_turn (default) or now.')],
        returns: '{ id }.',
        errors: ['404 not found', '400 text required'],
      },
      { method: 'DELETE', path: '/api/sessions/:id/messages/:mid', auth: 'web', summary: 'Cancel a queued message that has not been delivered.', returns: OK },
      {
        method: 'POST', path: '/api/sessions/:id/:action{stop|pause|resume|walk|mute}', auth: 'web',
        summary: 'Steer a session: stop (interrupt at the next tool call and stop its job), pause, resume, walk (remote approvals for this session), mute (no push notifications).',
        body: [f('on', 'walk: true, false or null (follow the machine); mute: true or false.'), f('stopWaitMin', 'walk: minutes to hold at Stop waiting for a reply (0–9).')],
        returns: OK,
        errors: ['404 not found'],
      },
      { method: 'GET', path: '/api/inbox', auth: 'web', summary: 'Pending approvals, questions, plan approvals and Stop waits, plus the last 50 handled.', returns: '{ pending, history }.' },
      {
        method: 'POST', path: '/api/actions/:id/answer', auth: 'web',
        summary: 'Answer a pending action.',
        body: [f('type', 'allow { scope?: once | session, updatedInput? } · deny { message?, interrupt? } · answers { answers: { [question]: answer } } · reply { text } · release.')],
        returns: OK,
        errors: ['400 invalid answer', '404 not found', '409 already answered'],
      },
      { method: 'POST', path: '/api/global/:what{walk|pause}', auth: 'web', summary: 'Walk mode or Pause everything, for every machine.', body: [f('on', 'true or false.')], returns: OK },
      { method: 'GET', path: '/api/global', auth: 'web', summary: 'The global switches.', returns: '{ walk, pauseAll }.' },
      { method: 'GET', path: '/api/search', auth: 'web', summary: 'Full-text search across prompts, replies, tool calls and saved prompts.', query: [f('q', 'Search terms.')], returns: 'Hits, best first, at most 50.' },
      { method: 'GET', path: '/api/projects', auth: 'web', summary: 'Projects (repositories) with session counts and cost.', returns: '[{ id, machineId, machineName, rootPath, name, gitRemote, ghOwner, ghRepo, sessions, lastEventAt, costUsd }].' },
      { method: 'GET', path: '/api/projects/:id', auth: 'web', summary: 'One project: its sessions, jobs, PRs, commits, cost by day and progress docs.', returns: '{ project, sessions, jobs, prs, commits, costByDay, progress }.', errors: ['404 not found'] },
      { method: 'GET', path: '/api/analytics', auth: 'web', summary: 'The Insights page: cost and tokens over time, tools, failures, wait time, job success rates.', query: [f('range', '7d, 30d (default) or 90d.')], returns: 'Analytics object.', errors: ['400 bad range'] },
    ],
  },
  {
    id: 'machines',
    title: 'Machines, pairing and notifications',
    intro: 'Web login.',
    endpoints: [
      { method: 'GET', path: '/api/machines', auth: 'web', summary: 'Paired machines with their versions, runner state and walk mode.', returns: 'Machine[].' },
      {
        method: 'POST', path: '/api/machines/:id/:action{walk|rotate|revoke|rename}', auth: 'web',
        summary: 'walk (machine-level walk mode), rotate (new token, shown once), revoke (the token stops working, the runner disconnects), rename.',
        body: [f('on', 'walk: true, false or null (follow global).'), f('name', 'rename: the new name.')],
        returns: '{ ok: true } (rotate: { ok, token }).',
        errors: ['404 not found'],
      },
      {
        method: 'POST', path: '/api/pairing-codes', auth: 'web',
        summary: 'Make a pairing code (valid 10 minutes, single use) and the installer commands.',
        body: [f('name', 'Optional machine name.')],
        returns: '{ code, expiresAt, commands: { bash, powershell } }.',
      },
      { method: 'GET', path: '/api/push/vapid', auth: 'web', summary: 'The Web Push public key.', returns: '{ publicKey }.' },
      { method: 'GET', path: '/api/push/subscriptions', auth: 'web', summary: 'Devices subscribed to push.', returns: '[{ id, deviceName, createdAt, lastOkAt }].' },
      { method: 'POST', path: '/api/push/subscribe', auth: 'web', summary: 'Subscribe this browser.', body: [f('subscription', 'The PushSubscription JSON { endpoint, keys: { p256dh, auth } }.'), f('deviceName', 'Optional.')], returns: OK },
      { method: 'POST', path: '/api/push/unsubscribe', auth: 'web', summary: 'Remove a subscription.', body: [f('endpoint · id', 'Either one.')], returns: OK },
      { method: 'POST', path: '/api/push/test', auth: 'web', summary: 'Send a test notification to every device (and ntfy).', returns: '{ ok, … delivery counts }.' },
    ],
  },
  {
    id: 'backlog',
    title: 'Backlog, gates and decisions (web)',
    intro: 'The PWA\'s side of the factory. Agents do the same through the MCP tools; these take a web login.',
    endpoints: [
      {
        method: 'GET', path: '/api/tasks', auth: 'web', summary: 'The backlog.',
        query: [f('status', 'Comma-separated statuses.'), f('ready', '1: only ready packages.'), f('q', 'Text in the id, title or body.')],
        returns: 'Task summary[].',
      },
      { method: 'POST', path: '/api/tasks', auth: 'web', summary: 'Create a package (the tasks_create arguments, except upsert and extRef).', body: [f('(tasks_create arguments)', 'title is required.')], returns: '201 Task summary.', errors: ['400 a title is required', '409 exists'] },
      {
        method: 'POST', path: '/api/tasks/import/markdown', auth: 'web',
        summary: 'Import Markdown task files (frontmatter id, title, status, depends_on, repo, branch, priority, sensitive, acceptance; or an "Acceptance criteria" section). Upserts by id; ordered by dependencies.',
        body: [f('files', '[{ name, text }], 1–200 files.')],
        returns: '{ imported: string[] }.',
        errors: ['400 a file that does not parse'],
      },
      {
        method: 'POST', path: '/api/tasks/import/github', auth: 'web',
        summary: 'Import the open issues of a GitHub repository (optionally one label) as packages, upserted by owner/repo#n. Uses the GitHub token from Settings.',
        body: [f('owner', 'Repository owner.'), f('repo', 'Repository name.'), f('label', 'Optional label filter.')],
        returns: 'Import summary.',
        errors: ['400 owner and repo required', '502 GitHub failed'],
      },
      { method: 'GET', path: '/api/tasks/:id', auth: 'web', summary: 'One package.', returns: 'Task detail.', errors: ['404 unknown task'] },
      {
        method: 'PUT', path: '/api/tasks/:id', auth: 'web',
        summary: 'Update a package: the tasks_update arguments, plus title, body, repo, priority and sensitive.',
        body: [f('(tasks_update arguments without id)', ''), f('title · body · repo · priority · sensitive', 'Web-only fields.')],
        returns: 'Task summary (+ cleanup, warnings).',
        errors: ['400 invalid task', '404 unknown task', '409 round limit'],
      },
      { method: 'DELETE', path: '/api/tasks/:id', auth: 'web', summary: 'Delete a package and its history.', returns: OK, errors: ['404 unknown task'] },
      {
        method: 'POST', path: '/api/tasks/:id/control', auth: 'web',
        summary: '"Stop the package" or "Revert its integration": recorded for the coordinator, which reads it with control_get.',
        body: [f('kind', 'stop or revert.'), f('note', 'Optional.')],
        returns: '201 Control request.',
      },
      {
        method: 'POST', path: '/api/tasks/:id/launch', auth: 'web',
        summary: 'Start a package: as an interactive agent in a new herdr terminal (launcher hc) or as a claude -p job. Claims it.',
        body: [
          f('machineId', 'The runner\'s machine.'), f('cwd', 'Working directory, inside the runner\'s allowed roots.'), f('launcher', 'hc (default) or claude.'),
          f('promptId', 'A saved prompt; default the package\'s prompt, else one made from the package.'), f('model · permissionMode', 'Optional.'), f('maxBudgetUsd', 'Default 5.'),
        ],
        returns: '201 { id, jobId, launcher }.',
        errors: ['409 already integrated', '400 cwd outside the allowed roots'],
      },
      { method: 'GET', path: '/api/gate-shots/:id', auth: 'web', summary: 'A gate screenshot.', returns: 'The image.', errors: ['404 not found'] },
      { method: 'GET', path: '/api/gate-runs/:id/log', auth: 'web', summary: 'The last 256 KB of a gate run\'s log.', returns: 'text/plain.', errors: ['404 no log'] },
      { method: 'GET', path: '/api/findings', auth: 'web', summary: 'Findings.', query: [f('taskId · status · severity', 'Filters.')], returns: 'Finding[].' },
      { method: 'POST', path: '/api/findings/update', auth: 'web', summary: 'Set the status of findings (the findings_update arguments).', body: [f('ids · status · note', 'As findings_update.')], returns: 'Finding[].' },
      { method: 'GET', path: '/api/factory/config', auth: 'web', summary: 'Settings → Factory: the round limit and the per-repo config.', returns: '{ maxRounds, repos: [{ repo, machineId, checkout, recipe, worktree, portFrom, portTo, dbPrefix, migrationFrom, migrationBlock, cleanup }] }.' },
      { method: 'PUT', path: '/api/factory/config', auth: 'web', summary: 'Replace the factory config. Each repo once.', body: [f('maxRounds', '1–50.'), f('repos', 'Up to 50 repo configs (shape as in GET).')], returns: 'The saved config.', errors: ['400 invalid config or a repo twice'] },
      { method: 'GET', path: '/api/decisions', auth: 'web', summary: 'Decisions.', query: [f('status', 'pending, answered or cancelled.')], returns: 'Decision[].' },
      { method: 'POST', path: '/api/decisions/:id/answer', auth: 'web', summary: 'Answer a decision.', body: [f('answer', 'Free text or one of its options.')], returns: 'Decision.', errors: ['409 not found or already answered'] },
      { method: 'POST', path: '/api/decisions/:id/cancel', auth: 'web', summary: 'Cancel a pending decision.', returns: 'Decision.', errors: ['409 not found or already answered'] },
      { method: 'GET', path: '/api/agent-tokens', auth: 'web', summary: 'Agent tokens (never the token itself).', returns: '[{ id, name, createdAt, lastUsedAt, revokedAt, launch, launchApproval }].' },
      { method: 'POST', path: '/api/agent-tokens', auth: 'web', summary: 'Create an agent token. The token is in this answer only.', body: [f('name', 'What uses it, e.g. coordinator or claude-desktop.')], returns: '201 { id, name, token (bba_…) }.' },
      {
        method: 'PUT', path: '/api/agent-tokens/:id', auth: 'web',
        summary: 'What the token may launch with tasks_launch and coordinator_launch, and whether each launch waits for your approval.',
        body: [f('launch', 'off (default), workers or all (workers and coordinators).'), f('launchApproval', 'true (default): every launch is a decision you answer first.')],
        returns: 'The token, as in GET.',
        errors: ['400 invalid values', '404 not found or revoked'],
      },
      { method: 'POST', path: '/api/agent-tokens/:id/revoke', auth: 'web', summary: 'Revoke an agent token; it stops working at once.', returns: OK, errors: ['404 not found or already revoked'] },
      { method: 'GET', path: '/api/digests', auth: 'web', summary: 'The last 30 digests.', returns: 'Digest[].' },
      { method: 'POST', path: '/api/digests', auth: 'web', summary: 'Send the digest now.', body: [f('note', 'Optional.')], returns: '201 Digest.' },
      { method: 'GET', path: '/api/terminals', auth: 'web', summary: 'herdr terminals reported by the runners, linked to sessions and packages.', returns: '[{ machineId, machineName, address, name, agent, cwd, state, status, turn, where, taskId, sessionId, seenAt }].' },
    ],
  },
  {
    id: 'jobs',
    title: 'Jobs, schedules, prompts and templates (web)',
    intro: 'Launching Claude Code on a machine through its runner, and the prompt library. Web login.',
    endpoints: [
      { method: 'GET', path: '/api/jobs', auth: 'web', summary: 'Jobs, newest first.', query: [f('status', 'Comma-separated: queued, starting, running, succeeded, failed, stopped, lost.'), f('machine', 'Machine id.'), f('limit', '1–500 (default 200).')], returns: 'Job[] (promptText cut to 300 characters).' },
      { method: 'GET', path: '/api/jobs/:id', auth: 'web', summary: 'One job, with its output count, rerun/schedule origin, runner state and verify commands.', returns: 'Job.', errors: ['404 not found'] },
      { method: 'GET', path: '/api/jobs/:id/output', auth: 'web', summary: 'The job\'s stream-json output lines.', query: [f('after', 'Only lines after this seq.'), f('limit', '1–2000 (default 1000).')], returns: '{ lines: [{ seq, ts, line }], total }.' },
      {
        method: 'POST', path: '/api/jobs', auth: 'web',
        summary: 'Start a claude -p job on a machine.',
        body: [
          f('machineId', 'Runner machine.'), f('cwd', 'Inside the runner\'s allowed roots.'), f('promptId · promptText', 'A saved prompt or the text.'), f('title', 'Optional.'),
          f('options', '{ model, fallbackModel, effort, permissionMode, maxBudgetUsd (default 5), maxTurns, allowedTools, disallowedTools, worktree, walkMode, verify }.'),
        ],
        returns: '{ id }.',
        errors: ['400 invalid job or options'],
      },
      { method: 'POST', path: '/api/jobs/fanout', auth: 'web', summary: 'The same job on up to 20 machine/folder targets.', body: [f('targets', '[{ machineId, cwd }].'), f('promptId · promptText · title · options', 'As POST /api/jobs.')], returns: '{ ids }.' },
      {
        method: 'POST', path: '/api/jobs/:id/:action{stop|message|resume|rerun|verify}', auth: 'web',
        summary: 'stop; message (send text to a running job); resume (continue its session with new text); rerun (same prompt again); verify (run the Done-when commands on the runner, with confirmed: true).',
        body: [f('text', 'message, resume.'), f('commands', 'verify: the exact commands (default: the job\'s).'), f('confirmed', 'verify: must be true.')],
        returns: '{ ok } · { id } for resume and rerun · { ok, commands } for verify.',
        errors: ['409 job state does not allow it, or the runner is offline'],
      },
      { method: 'GET', path: '/api/schedules', auth: 'web', summary: 'Scheduled jobs.', returns: '[{ id, cron, enabled, lastRunAt, createdAt, nextRunAt, job }].' },
      { method: 'POST', path: '/api/schedules', auth: 'web', summary: 'Schedule a job with a 5-field cron expression (server time).', body: [f('cron', 'e.g. "0 3 * * 1-5".'), f('job', 'As POST /api/jobs.')], returns: '{ id }.', errors: ['400 invalid cron, machine or prompt'] },
      { method: 'DELETE', path: '/api/schedules/:id', auth: 'web', summary: 'Delete a schedule.', returns: OK },
      { method: 'GET', path: '/api/runner/projects', auth: 'web', summary: 'For the launch form: a machine\'s runner state, allowed roots, projects and recent folders.', query: [f('machine', 'Machine id.')], returns: '{ runnerOnline, allowedRoots, concurrency, projects, recent }.' },
      { method: 'GET', path: '/api/templates', auth: 'web', summary: 'Prompt templates, the built-in harness first.', returns: 'Template[].' },
      { method: 'POST', path: '/api/templates', auth: 'web', summary: 'Add or replace a template (Markdown with <placeholders>).', body: [f('name', 'Not "harness".'), f('body', 'The template.')], returns: '201 Template.' },
      { method: 'GET', path: '/api/templates/:id', auth: 'web', summary: 'One template with its slots.', returns: 'Template.' },
      { method: 'DELETE', path: '/api/templates/:id', auth: 'web', summary: 'Delete a template no prompt uses.', returns: OK, errors: ['409 built-in or in use'] },
      { method: 'GET', path: '/api/prompts', auth: 'web', summary: 'Saved prompts with run statistics.', query: [f('q', 'Text.'), f('tag', 'One tag.')], returns: 'Prompt[].' },
      { method: 'POST', path: '/api/prompts', auth: 'web', summary: 'Save a prompt.', body: [f('templateId · title · slots · extraMd · tags', 'As prompts_save.')], returns: '201 Prompt.' },
      { method: 'GET', path: '/api/prompts/:id', auth: 'web', summary: 'One prompt.', returns: 'Prompt.' },
      { method: 'PUT', path: '/api/prompts/:id', auth: 'web', summary: 'Edit a prompt; a content change makes a new version.', body: [f('templateId · title · slots · extraMd · tags', 'Any of them.')], returns: 'Prompt.' },
      { method: 'POST', path: '/api/prompts/specify', auth: 'web', summary: 'Spec-ify: a read-only runner job turns a rough idea into Goal, Done when, Scope and a draft spec.', body: [f('idea', 'The rough idea.'), f('machineId · cwd', 'Where to look.'), f('model · maxBudgetUsd', 'Default opus and $1.')], returns: '{ jobId }.' },
      { method: 'POST', path: '/api/prompts/:id/duplicate', auth: 'web', summary: 'Copy a prompt.', returns: '201 Prompt.' },
      { method: 'GET', path: '/api/prompts/:id/versions', auth: 'web', summary: 'A prompt\'s versions, newest first.', returns: '[{ version, slots, extraMd, rendered, createdAt }].' },
      { method: 'DELETE', path: '/api/prompts/:id', auth: 'web', summary: 'Delete a prompt.', returns: OK },
    ],
  },
  {
    id: 'machine-api',
    title: 'Machine API: hooks, statusline, telemetry',
    intro: 'What the Claude Code plugin on a paired machine sends. Machine token. You only call these when writing your own client.',
    endpoints: [
      { method: 'POST', path: '/api/ingest', auth: 'machine', summary: 'Hook events, one envelope or a batch ({ envelopes } or an array). Bad items are skipped, not fatal.', body: [f('v · ts · event', 'The envelope; event carries session_id and hook_event_name plus the hook\'s JSON.')], returns: '{ ok, accepted, duplicates, rejected, control }.' },
      { method: 'POST', path: '/api/hook/:event', auth: 'machine', summary: 'A blocking hook (PreToolUse, Stop…): ingests the event and long-polls for a decision (remote approval, queued message, stop). Sends one space at once, then the JSON.', body: [f('(envelope)', 'As /api/ingest; controlOnly: true to only decide.')], returns: '{ output (JSON for the hook to print, or null), control }.', errors: ['403 the session belongs to another machine'] },
      { method: 'GET', path: '/api/machine/status', auth: 'machine', summary: '/bb-status: what the server knows about this machine and a session.', query: [f('session', 'Session id.')], returns: '{ machineId, name, lastSeen, spoolBytes, machineWalk, session }.' },
      { method: 'POST', path: '/api/machine/walk', auth: 'machine', summary: '/bb-walk: walk mode for a session, or the whole machine.', body: [f('on', 'true or false.'), f('sessionId', 'Optional.'), f('stopWaitMin', '0–9.')], returns: '{ ok, scope, control }.' },
      { method: 'POST', path: '/api/import', auth: 'machine', summary: '`bb import`: a chunk of an old transcript.', body: [f('sessionId', ''), f('path', 'Transcript path.'), f('lines', 'Up to 20 000 JSONL lines.')], returns: '{ ok, created, … }.' },
      { method: 'POST', path: '/api/statusline', auth: 'machine', summary: 'The statusline bridge: cost, context and the rate-limit windows the governor reads.', body: [f('(statusline JSON)', 'session_id, cost.total_cost_usd, context_window.used_percentage, rate_limits.five_hour / seven_day, model.display_name.')], returns: OK },
      { method: 'POST', path: '/v1/metrics', auth: 'machine', summary: 'OpenTelemetry metrics (OTLP/HTTP JSON) from Claude Code.', body: [f('resourceMetrics', 'OTLP.')], returns: '{ partialSuccess, accepted }.' },
      { method: 'POST', path: '/v1/logs', auth: 'machine', summary: 'OpenTelemetry log events (OTLP/HTTP JSON). Prompt bodies are dropped; the rest is redacted.', body: [f('resourceLogs', 'OTLP.')], returns: '{ partialSuccess, accepted }.' },
    ],
  },
  {
    id: 'runner',
    title: 'Runner API',
    intro: 'The runner daemon (`bb runner`) on a paired machine. Machine token.',
    endpoints: [
      { method: 'GET', path: '/api/runner/stream', auth: 'machine', summary: 'The command stream: SSE command events (job, stop, message, verify, gate, ping). One connection per machine.', returns: 'SSE.' },
      { method: 'POST', path: '/api/runner/heartbeat', auth: 'machine', summary: 'Runner state: version, allowed roots, concurrency, running jobs.', body: [f('version · hostname · platform · allowedRoots · concurrency · claudeVersion · running', '')], returns: OK },
      { method: 'POST', path: '/api/runner/agents', auth: 'machine', summary: 'Claude Code background agents seen on the machine.', body: [f('agents', 'Array.')], returns: '{ ok, upserted }.' },
      { method: 'POST', path: '/api/runner/jobs/:id/events', auth: 'machine', summary: 'A job\'s status, output lines and verify results.', body: [f('events', '[{ type: status | output | verify, … }].')], returns: OK },
      { method: 'POST', path: '/api/runner/terminals', auth: 'machine', summary: 'The machine\'s herdr terminals (replaces the previous list; closed terminals end their sessions).', body: [f('terminals', '[{ address, name, agent, cwd, state, status, turn, where }].'), f('takenAt', 'Runner clock when hc ls ran.')], returns: '{ ok, count }.' },
      { method: 'POST', path: '/api/runner/gates/:id', auth: 'machine', summary: 'A gate run\'s report: running, done (verdict, summary, findings, shots) or error. Only the run\'s machine.', body: [f('status · verdict · summary · details · findings · shots · exitCode · error · log', '')], returns: 'Gate run.' },
    ],
  },
];

/** Paths that are not endpoints: the PWA's static files and its SPA fallback, and the /api 404 catch-all. */
export const UNDOCUMENTED_ROUTES = ['ALL /*', 'GET /*', 'ALL /api/*'];

export function displayPath(p: string): string {
  return p.replace(/:(\w+)\{([^}]+)\}/g, (_, name: string, re: string) => (re.includes('|') ? `{${re}}` : `:${name}`));
}

export function endpointAnchor(e: Endpoint): string {
  const p = displayPath(e.path).replace(/\*/g, '-any').replace(/\/$/, '-slash');
  return `${e.method}-${p}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- the guide ----------

function startGuide(site: RefSite): string {
  const u = site.url;
  return `# Buildyboy for agents

Buildyboy is a self-hosted control tower around Claude Code (${u}). It records every Claude Code session on every paired
machine, lets its owner approve and steer them from a phone, and runs an autonomous **software factory**: a
*coordinator* agent takes packages from a backlog, starts *workers* for them, runs *gates* (checks) and integrates what
passes. Buildyboy holds the factory's memory: the backlog, subscription usage and the governor, gate results and
findings, the human's decisions, stop/revert requests and the daily digest.

## Connect

Every agent uses an **agent token** (\`bba_…\`). The owner creates one in Settings → Factory → Agent tokens (or
\`node cli/bb.ts agent-token <name>\` on the server host). It reaches only the agent surface and can be revoked at any time.

**MCP over Streamable HTTP** (any machine, no checkout needed):

\`\`\`
URL:     ${u}/mcp
Header:  Authorization: Bearer bba_…
\`\`\`

- Claude Code: \`claude mcp add --transport http buildyboy ${u}/mcp --header "Authorization: Bearer bba_…"\`
- JSON config (Cursor, VS Code, Windsurf…): \`{ "type": "http", "url": "${u}/mcp", "headers": { "Authorization": "Bearer bba_…" } }\`
- A client that only speaks stdio: \`npx -y mcp-remote ${u}/mcp --header "Authorization: Bearer bba_…"\`

**MCP over stdio with \`bb mcp\`** (a machine with a Buildyboy checkout and Node 24): adds an offline outbox, a read
cache and local screenshot upload.

\`\`\`
claude mcp add buildyboy --scope user -e BUILDYBOY_URL=${u} -e BUILDYBOY_AGENT_TOKEN=bba_… -- node <checkout>/cli/bb.ts mcp
\`\`\`

**Plain HTTP**: every tool is also \`POST ${u}/api/agent/<tool>\` with the arguments as the JSON body and the same
bearer token. The answer is \`{ "result": … }\`; a refusal is a 4xx with \`{ "error": "…" }\`.

\`\`\`
curl -X POST ${u}/api/agent/tasks_list -H "Authorization: Bearer bba_…" -H "Content-Type: application/json" -d '{"ready":true}'
\`\`\`

## Concepts

- **Package (task)**: one unit of work in the backlog, with an id (P3), acceptance criteria, dependencies, a repo and a
  status. Statuses are Romanian: ${TASK_STATUSES.map((s) => `\`${s}\` (${STATUS_LABEL[s]})`).join(', ')}.
- **Ready**: status \`gata\` and every dependency \`integrata\`. Only ready packages can be claimed.
- **Claim**: \`tasks_claim\` moves a ready package to \`in_lucru\` and allocates its **resources** from the repo's
  factory config: a port, a database name and a block of migration numbers, kept until it is integrated.
- **Gates**: ${GATES.map((g) => `${g} ${GATE_LABEL[g]}`).join('; ')}. A gate result is pass, fail or skip, with a
  summary, optional screenshots and **findings** (blocker, major, minor).
- **Rounds**: every move into \`la_porti\` starts a gate round. A failing gate in the last allowed round (3 by
  default) blocks the package (\`blocata\`) and asks the human whether to allow another round.
- **Governor**: from the subscription's 5-hour and 7-day windows, says whether a new worker may start
  (\`canStart\`) or the factory must stop (\`stopAll\`).
- **Launching**: an agent token the owner allowed to launch can start workers (\`tasks_launch\`) and, if allowed,
  coordinators (\`coordinator_launch\`) on a paired machine's runner. Refused while the governor says no; may wait
  for the owner's approval first.
- **Decisions**: questions for the human, answered on the phone. **Controls**: the human's requests to stop a
  package or revert its integration. **Digest**: a daily summary pushed to the phone.
- **Roles and cost**: sessions started with the env vars \`BB_TASK=<id>\` and \`BB_ROLE\` (lucrator = worker, qa,
  poarta = gates, coordonator) are linked to the package; its cost is their measured sum.

## The coordinator loop

1. \`governor_get\`. If \`stopAll\`, send \`digest_post\` with a note and stop. If not \`canStart\`, start nothing new;
   wait until \`waitUntil\` (keep supervising running workers).
2. \`control_get\`. For each request: \`stop\` → stop that package's worker, \`tasks_update\` it with a note;
   \`revert\` → revert its integration in git yourself. Then \`control_get {ack: true}\`.
3. \`tasks_list {ready: true}\` and \`tasks_claim\` (optionally \`{id}\`). Read the package with \`tasks_get\`.
4. Write the worker prompt: \`prompts_render\` with the harness slots (Goal, Done when, Scope, Limit, Subagents,
   Branch, PR, Unattended) and the package's acceptance criteria; fix what \`warnings\` says; \`prompts_save {taskId}\`.
5. Start the worker in a worktree with \`BB_TASK\` and \`BB_ROLE=lucrator\` set, and record it:
   \`tasks_update {id, branch, terminal or sessionId}\`. Or, when your token may launch, let a runner start it:
   \`machines_list\`, then \`tasks_launch {taskId, machineId, cwd}\` (it records the terminal or session itself).
6. When it is done: \`tasks_update {status: "la_porti"}\`. Run each gate: \`gates_run\` then \`gates_status\` until
   \`done\`/\`error\` for recipe gates, or run a check yourself and \`gates_record\` it. On a fail, hand the open
   blockers and majors (\`findings_list {taskId, status: "open"}\`) back to the worker, move it to \`in_lucru\`, repeat.
7. All gates pass: merge, \`tasks_update {status: "integrata", migrationsUsed}\`, run the returned \`cleanup\`
   lines, and pass any \`warnings\` on to the packages they name.
8. Only the human can decide something? \`decision_ask\` (with options and context), keep working on other packages,
   and check \`decision_get\` on later loops.

## Conventions

- Times are epoch milliseconds. Ids of packages are strings; findings and gate results are integers; runs and
  decisions are UUIDs.
- Every tool result is JSON (\`docs_get\` returns Markdown). A refused call is an MCP error result
  (\`isError: true\`) whose text is the server's reason, e.g. "task P3 waits on P1".
- \`tasks_claim\` returning \`task: null\` is not an error: read \`reason\`.
- Read-only tools: ${READ_ONLY_TOOLS.join(', ')}. Every other tool changes state and is recorded in the history with
  your token's name as the actor.
- With \`bb mcp\`, while the server is unreachable: ${QUEUEABLE_TOOLS.join(', ')} are queued and replayed once (answer
  \`{queued: true, key}\`); reads return the last answer with \`stale: true\`; governor_get is computed locally.
  Over HTTP there is no queue: retry later.
- Limits: gate screenshots png/jpeg/webp/gif, 5 MB each, 12 per call; findings 200 per call; a decision has up to 8
  options. Over HTTP, screenshots go as base64.

## More

- \`docs_get {topic: "tools"}\`: every tool with its arguments, result, errors and an example.
- \`docs_get {topic: "api"}\`: every HTTP endpoint.
- The same as one file: ${u}/docs/agents.md · the manual: ${u}/docs/agents
`;
}

function mdTable(head: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

export function toolMarkdown(name: ToolName): string {
  const d = TOOL_DOCS[name];
  const rows = argRows(name);
  const parts = [`### ${name}`, '', TOOLS[name].description, '', `**When:** ${d.use}`, ''];
  parts.push(rows.length ? mdTable(['Argument', 'Type', 'Required', 'Description'], rows.map((r) => [`\`${r.name}\``, r.type, r.required ? 'yes' : '', r.desc])) : 'No arguments.');
  parts.push('', `**Returns:** ${d.returns}`);
  if (d.errors?.length) parts.push('', `**Errors:** ${d.errors.join('; ')}.`);
  for (const n of d.notes ?? []) parts.push('', `- ${n}`);
  parts.push('', 'Example arguments:', '', '```json', JSON.stringify(d.example, null, 2), '```');
  return parts.join('\n');
}

function shapesMarkdown(): string {
  return SHAPES.map((s) => [`### ${s.title}`, '', s.intro, '', mdTable(['Field', 'Type', 'Meaning'], s.fields.map(([n, t, m]) => [`\`${n}\``, t, m]))].join('\n')).join('\n\n');
}

function toolsMarkdown(): string {
  const groups = TOOL_GROUPS.map((g) => [`## ${g.title}`, '', ...TOOL_NAMES.filter((n) => TOOL_DOCS[n].group === g.id).map((n) => toolMarkdown(n) + '\n')].join('\n'));
  return ['# MCP tool reference', '', `${TOOL_NAMES.length} tools, the same over \`/mcp\`, \`bb mcp\` and \`POST /api/agent/<tool>\`.`, '', ...groups, '## Result shapes', '', shapesMarkdown()].join('\n');
}

function apiMarkdown(site: RefSite): string {
  const auth = mdTable(['Auth', 'How'], (Object.keys(AUTH) as Auth[]).map((a) => [AUTH[a].label, AUTH[a].desc]));
  const groups = API_GROUPS.map((g) => {
    const eps = g.endpoints.map((e) => {
      const lines = [`### ${e.method} ${displayPath(e.path)}`, '', `${e.summary} *Auth: ${AUTH[e.auth].label}.*`];
      if (e.query?.length) lines.push('', 'Query: ' + e.query.map((q) => `\`${q.name}\` ${q.desc}`).join(' · '));
      if (e.body?.length) lines.push('', 'Body (JSON): ' + e.body.map((b) => `\`${b.name}\`${b.desc ? ` ${b.desc}` : ''}`).join(' · '));
      lines.push('', `Returns: ${e.returns}`);
      if (e.errors?.length) lines.push('', `Errors: ${e.errors.join('; ')}.`);
      for (const n of e.notes ?? []) lines.push('', `- ${n}`);
      return lines.join('\n');
    });
    return [`## ${g.title}`, '', g.intro, '', ...eps.map((x) => x + '\n')].join('\n');
  });
  return [
    '# HTTP API reference',
    '',
    `Base URL: ${site.url}. Bodies and answers are JSON unless noted; errors are \`{ "error": "…" }\` with a 4xx status.`,
    'Unknown paths under /api answer 404 JSON.',
    '',
    auth,
    '',
    ...groups,
  ].join('\n');
}

/** The Markdown guide: what docs_get and /docs/agents.md answer. */
export function agentGuide(site: RefSite, topic: DocsTopic = 'all', tool?: string): string {
  if (tool) {
    if (!TOOL_NAMES.includes(tool as ToolName)) throw new Error(`unknown tool ${tool}`);
    return toolMarkdown(tool as ToolName);
  }
  if (!DOCS_TOPICS.includes(topic)) topic = 'all';
  const parts: string[] = [];
  if (topic === 'start' || topic === 'all') parts.push(startGuide(site));
  if (topic === 'tools' || topic === 'all') parts.push(toolsMarkdown());
  if (topic === 'api' || topic === 'all') parts.push(apiMarkdown(site));
  return parts.join('\n\n');
}

export function llmsTxt(site: RefSite): string {
  const u = site.url;
  return `# Buildyboy

> A self-hosted control tower around Claude Code: live sessions on every machine, remote approvals from a phone, and an autonomous software factory (backlog, governor, gates, decisions, digest) driven by agents over MCP.

Agents connect to the MCP server at ${u}/mcp (Streamable HTTP) with "Authorization: Bearer <agent token>"; every tool is also POST ${u}/api/agent/<tool>.

## Docs

- [Agent guide (Markdown, everything)](${u}/docs/agents.md): concepts, connecting, the coordinator loop, every MCP tool and every HTTP endpoint
- [Getting started for agents](${u}/docs/agents.md?topic=start)
- [MCP tool reference](${u}/docs/agents.md?topic=tools)
- [HTTP API reference](${u}/docs/agents.md?topic=api)
- [Human manual](${u}/docs)
`;
}

// ---------- data for the HTML pages ----------

/** The HTML pages print text as text: drop the Markdown backticks the guide uses for code. */
const plain = (s: string) => s.replace(/`/g, '');

export function referenceData() {
  const readOnly = new Set<string>(READ_ONLY_TOOLS);
  const queueable = new Set<string>(QUEUEABLE_TOOLS);
  const shapeTitle = new Map(SHAPES.map((s) => [s.id, s.title]));
  return {
    toolGroups: TOOL_GROUPS.map((g) => ({
      id: `tools-${g.id}`,
      title: g.title,
      tools: TOOL_NAMES.filter((n) => TOOL_DOCS[n].group === g.id).map((n) => {
        const d = TOOL_DOCS[n];
        return {
          name: n,
          anchor: `tool-${n}`,
          description: plain(TOOLS[n].description),
          use: plain(d.use),
          args: argRows(n).map((r) => ({ ...r, desc: plain(r.desc), required: r.required ? 'yes' : '' })),
          hasArgs: argRows(n).length > 0,
          returns: plain(d.returns),
          shapes: (d.shapes ?? []).map((s) => ({ title: shapeTitle.get(s)!, href: `/docs/mcp-tools#shape-${s}` })),
          hasShapes: !!d.shapes?.length,
          errors: (d.errors ?? []).map(plain),
          hasErrors: !!d.errors?.length,
          notes: (d.notes ?? []).map(plain),
          hasNotes: !!d.notes?.length,
          example: JSON.stringify({ name: n, arguments: d.example }, null, 2),
          kind: readOnly.has(n) ? 'read-only' : queueable.has(n) ? 'write · queued offline by bb mcp' : 'write',
        };
      }),
    })),
    shapes: SHAPES.map((s) => ({ ...s, intro: plain(s.intro), anchor: `shape-${s.id}`, fields: s.fields.map(([name, type, desc]) => ({ name, type, desc: plain(desc) })) })),
    auth: (Object.keys(AUTH) as Auth[]).map((a) => ({ id: a, ...AUTH[a] })),
    apiGroups: API_GROUPS.map((g) => ({
      ...g,
      intro: plain(g.intro),
      anchor: `api-${g.id}`,
      endpoints: g.endpoints.map((e) => ({
        ...e,
        summary: plain(e.summary),
        returns: plain(e.returns),
        anchor: endpointAnchor(e),
        display: displayPath(e.path),
        authLabel: AUTH[e.auth].label,
        query: (e.query ?? []).map((q) => ({ ...q, desc: plain(q.desc) })),
        hasQuery: !!e.query?.length,
        body: (e.body ?? []).map((b) => ({ ...b, desc: plain(b.desc) })),
        hasBody: !!e.body?.length,
        errors: (e.errors ?? []).map(plain),
        hasErrors: !!e.errors?.length,
        notes: (e.notes ?? []).map(plain),
        hasNotes: !!e.notes?.length,
      })),
    })),
    toolCount: TOOL_NAMES.length,
    endpointCount: API_GROUPS.reduce((n, g) => n + g.endpoints.length, 0),
  };
}
