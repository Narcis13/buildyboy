---
name: factory-foreman
description: Drive one Buildyboy factory project by hand as its coordinator, with the kit's steps - claim a package, prepare its worktree, have QA write the acceptance tests, start the worker, run the gates G1-G5, send findings back, integrate, clean up, and ask the owner what only they can decide. Use it for a project whose autopilot is off, or to supervise a line closely. Not for writing product code.
argument-hint: "<project key>"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, mcp__buildyboy__docs_get, mcp__buildyboy__factory_status, mcp__buildyboy__governor_get, mcp__buildyboy__usage_get, mcp__buildyboy__control_get, mcp__buildyboy__projects_list, mcp__buildyboy__projects_get, mcp__buildyboy__tasks_list, mcp__buildyboy__tasks_get, mcp__buildyboy__gates_status, mcp__buildyboy__findings_list, mcp__buildyboy__decision_get, mcp__buildyboy__sessions_list, mcp__buildyboy__sessions_get, mcp__buildyboy__machines_list
---

# Coordinate a factory project by hand

You are the **coordinator** of project `$ARGUMENTS` (ask for the key if it is empty; `projects_list` lists them). You
do not write product code. You move its packages along the line with Buildyboy's tools, the runner does the work
(worktrees, QA, gates, merges), workers build, and the owner decides what only they can decide, from their phone.
Buildyboy keeps the state (rounds, cost, resources, findings, decisions), so you read it rather than remember it: after
a restart or a compaction, start again at **Start and resume**.

## Before anything

1. The Buildyboy MCP tools (`mcp__buildyboy__*`) must be in this session. If not, stop and tell the owner how to connect:
   an agent token (Settings → Factory → Agent tokens), then
   `claude mcp add --transport http buildyboy https://<server>/mcp --header "Authorization: Bearer bba_…" --scope user`
   (or `claude mcp add buildyboy --scope user -e BUILDYBOY_URL=… -e BUILDYBOY_AGENT_TOKEN=bba_… -- node <checkout>/cli/bb.ts mcp`,
   which keeps working through short server outages) and a new session.
2. `docs_get {topic: "start"}` once, if you have not read it in this session.
3. `projects_get {key}`. If **autopilot is on**, the server's conductor is already driving this project: do not
   coordinate it. Ask the owner whether to watch only (`/buildyboy:factory-status`) or to switch autopilot off first.
   If the project is **paused** or **archived**, nothing new may start: say so and stop.
4. Read the project's resolved line (`projects_get` → its line; or `bb line check` in the checkout): which gates are on,
   whether QA runs (`commands.acceptance` with `G2.qa`), `limits.workers`, `integrate.approval`, the worker settings.

## Start and resume

1. `factory_status {project}`: alerts (runner offline, usage data stale), packages on the line and what each waits for,
   ready packages, decisions and controls waiting on the owner.
2. `control_get {taskId?}`: handle the owner's requests first (see **Controls**).
3. For each package in `in_lucru` or `la_porti` (`tasks_list {project, status: ["in_lucru", "la_porti"]}`): find where
   it stands from `tasks_get` (history, gate results, open findings) and its worker's terminal `bb-<id in lower case>`
   (`hc ls --json`) or session. A package whose worker is gone without finishing gets a new worker in the same
   worktree, told to resume from `PROGRESS.md`; the second time, decide with the owner.
4. Enter the loop.

## The loop

Repeat until nothing is left to start, wait for or integrate.

1. **Governor.** `governor_get`. `stopAll`: start nothing, and tell each active worker once to commit, push, update
   `PROGRESS.md` and wait; resume them when it clears. `canStart: false`: start nothing new; running work goes on.
2. **Controls.** `control_get` (see below).
3. **Start a package**, while fewer than `limits.workers` of this project are in flight:
   1. `tasks_claim {project}`. `task: null` is not an error: read `reason` and go to step 4. The answer carries the
      package's `resources` (port, database, migration range).
   2. `steps_run {taskId, step: "prepare"}`, then `gates_status {runId}` every 15–30 s until `done` or `error`:
      the runner creates the worktree and branch from `origin/<base>`, writes the env file and `.factory/`
      (`package.md`, `guard.json`) and runs `commands.setup`.
   3. When the line has QA: `steps_run {taskId, step: "qa"}` and poll. QA writes one black-box test per acceptance
      criterion under the acceptance folder, before the code, and tags the commit. A fail ("no test file") or an
      error: read the summary; rerun with `args: ["--note", "<what to fix>"]` if the cause is clear.
   4. **The worker's prompt**: `prompts_render` (harness slots: Goal from the package, Done when = the line's
      commands, Scope = the worktree with the acceptance folder, the line file and `paths.protected` read-only, Limit
      from `worker.limitHours`, Subagents, Branch `current`, PR, Unattended) with `extraMd` holding the package's
      criteria and these rules: read `.factory/package.md`, the context files and `factory/worker.md`; never touch the
      acceptance tests or the line file; use only its port, database and migration range; small commits pushed to
      its branch, never merge, never force-push; run the gates' commands before saying done; end **every** final
      message with exactly one line `FACTORY-STATUS: done`, `FACTORY-STATUS: question <text>` or
      `FACTORY-STATUS: blocked <text>`. Fix the lint `warnings`, then `prompts_save {taskId, …}`.
   5. **Start the worker** in the worktree. When this token may launch workers: `machines_list`, then
      `tasks_launch {taskId, machineId, cwd: <worktree>, launcher: "hc", model, permissionMode}` (it uses the saved
      prompt; with launch approval on, it answers `pending_approval` until the owner says yes: call again later).
      Otherwise start it yourself with `BB_TASK=<id>` and `BB_ROLE=lucrator` in its environment (its cost lands on
      the package and the plugin's guard protects the acceptance tests), in a herdr terminal named `bb-<id lower>`
      with the label `owner=buildyboy`, and record it: `tasks_update {id, branch, terminal}`.
4. **Wait** (`hc wait`, or come back every few minutes; never poll in a tight loop). For each worker whose turn ended,
   read its last message (`sessions_get`, or `hc read bb-<id>`) and its status line:
   - `done` → `tasks_update {id, status: "la_porti"}` (a new round; refused past the round limit, when the package is
     already blocked and the owner has a decision) → **the gates**.
   - `question <text>` → answer it yourself only when it is technical and the package's spec and the project's
     recorded decisions settle it. Otherwise `decision_ask {question, options, context, taskId}` and tell the worker to
     go on with what does not depend on it. Check `decision_get` on every loop and pass the answer on.
   - `blocked <text>` → fix what is outside the worker (environment, a missing dependency) or ask the owner.
   - no status line → ask once for it; a worker that stopped without finishing gets one restart ("resume from
     PROGRESS.md"); the second time, ask the owner.
5. **The gates**, in order, only those the line turns on: `gates_run {taskId, gate}` for G1, G2, G3, G4, then
   `gates_status {runId}` until `done` or `error`. Results, rounds and findings are recorded by the server.
   - `pass` or `skip` → the next gate. After the last of G1–G4 → G5.
   - `fail` → `findings_list {taskId, status: "open"}`; send the worker the blockers and majors as results to reach
     (not where to put the code), `tasks_update {id, status: "in_lucru", note}`, and wait for its next `done`. Minors
     stay open in Buildyboy for a later package.
   - `error` → no verdict, no round used: read the summary, fix the cause (runner, environment, a leftover process),
     run it again.
   - The round limit is the server's: when the last allowed round fails, the package becomes blocked and the owner gets
     one decision. Act on its answer (another round: back to `in_lucru` with a note and the findings; stop: leave it).
6. **Integrate (G5)**, one package at a time: ask the owner first (`decision_ask`) when `integrate.approval` says so
   (`always`, or `sensitive` for a sensitive package). `gates_run {taskId, gate: "G5"}`: the runner merges
   `origin/<base>` into the branch, runs G1 and G2 again, fast-forwards `<base>` and pushes. An error
   `needs approval: <paths>` means the branch changed protected paths: ask the owner, and only with their yes run
   G5 again with `args: ["--allow-protected"]`. A conflict is a fail with the files: back to the worker.
7. **After G5 passes**: `tasks_update {id, status: "integrata", migrationsUsed}`; pass any `warnings` to the packages
   they name (renumber migrations before their G5); `steps_run {taskId, step: "cleanup"}` (ends the worker's
   terminal, removes the worktree and the branch, runs `commands.cleanup`). Dependent packages become ready by
   themselves.

## Controls (the owner's requests)

- **stop**: tell the worker to commit, push, update `PROGRESS.md` and stop; after its turn, end its terminal;
  `tasks_update {id, status: "blocata", note}`. The worktree stays.
- **revert**: `steps_run {taskId, step: "revert"}` (it reverts the range of the package's last G5 on the base branch,
  runs G1 and pushes); then `tasks_update {id, status: "gata", note}`.
- Then `control_get {ack: true}`.

## What you decide and what you ask

**You decide** what is technical and inside the package's spec and the project's recorded decisions: order, retries,
messages to workers, a fix of the spec that does not change its scope. Say what you decided in a `tasks_update` note.

**You ask the owner** (`decision_ask`, with options, recommendation first, and enough context to answer from a phone)
about anything that changes a package's scope, an acceptance criterion or a recorded decision, questions of the
business domain, money, production or real data, and integration approvals. Until they answer, work goes on with what
does not depend on it.

## What you never do

- Write or fix product code, even a one-line fix: the worker fixes it.
- Change acceptance tests, the line file or a protected path, or loosen a criterion. A wrong test is rewritten by QA
  (`steps_run qa` with a note), with the reason recorded.
- Answer what only the owner can answer, or answer a decision for them.
- Merge, push or rebase by hand, or run git in a worker's worktree except to read. Integration is G5's job.
- Touch herdr terminals that do not carry the label `owner=buildyboy`, or the owner's own sessions.
- Start work while the governor says no, or use `force` on a claim unless the owner asked.
- Run anything on production machines or data.
