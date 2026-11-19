# Buildyboy — a software factory around Claude Code

One self-hosted Node.js server and one SQLite file that see everything my Claude Code sessions do, on every machine I use. I can watch, steer and approve them from my phone, and write and launch new unattended runs from a prompt composer built on `harness-prompt.md`.

The user is one developer (me). I start sessions by hand in a terminal (Windows or WSL), in the Claude Desktop app, or headless with `claude -p`. Then I go for a walk and follow along on my phone through `https://<public host>`.

This file is the product spec. `TASK.md` says how to build it. When this spec is silent, pick the simplest option that serves the user story above and record the choice under Decisions in `PROGRESS.md`.

---

## 1. Facts about the environment (verified 2026-10-12)

| Item | Value |
|---|---|
| Dev machine | Windows 11, Node 24.19, git 2.56, gh 2.102 (logged in as `Narcis13`), Claude Code 2.1.296 |
| WSL | Ubuntu 26.04, systemd on, user `sysadm`, Node 24.19 via nvm (`~/.nvm/nvm.sh`), Claude Code 2.1.287 at `~/.local/bin/claude`, `sudo` needs a password |
| Networking | WSL mirrored networking; `eth0` holds the public IP **109.99.176.213** |
| Already running in WSL (do not touch) | Caddy on :80/:443 serving `contzo.lol` → `127.0.0.1:3333` (the AdonisJS app "efacturi"), PostgreSQL :5432, Redis :6379, SSH :22 |
| DNS | `buildyboy.109-99-176-213.sslip.io` resolves to the public IP today, so use it as the default host. `*.contzo.lol` does **not** point at this machine (it resolves to 86.35.3.x), so a contzo.lol subdomain needs a DNS record the user creates. |
| SQLite | Node's built-in `node:sqlite` (SQLite 3.53.3) works on this machine, with FTS5 and `backup()`. Use it so there are no native modules to build on Windows. |
| Repo | `origin` = `https://github.com/Narcis13/buildyboy.git` |

### Claude Code capabilities this design relies on (from code.claude.com/docs, 2026-10)

- **Hook events:** SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.
- **Fields on every event:** `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`. Inside subagents, `agent_id` and `agent_type` are added.
- **Handler types:** `command` (supports `async: true`), `http` (POSTs the JSON; headers can use `$VAR` with `allowedEnvVars`), `mcp_tool`, `prompt`, `agent`. The default timeout is 600 s. It is 30 s on UserPromptSubmit and the model-switch events.
- **Control outputs:**
  - PreToolUse: `hookSpecificOutput.permissionDecision` = allow, deny, ask or defer, plus `updatedInput` and `additionalContext`.
  - PermissionRequest: `hookSpecificOutput.decision.behavior` = allow or deny. Allow can carry `updatedInput` and `updatedPermissions`. Deny can carry `message` and `interrupt`.
  - Stop: `decision:"block"` plus `reason`, which makes Claude continue with the reason as its instruction. A turn is capped at 8 consecutive continuations.
  - Universal: `continue:false` plus `stopReason`, and `systemMessage`.
  - Stop input includes `last_assistant_message`.
- **Notification `notification_type`:** permission_prompt, idle_prompt, agent_needs_input, agent_completed, elicitation_*, auth_success, quota_auto_resume_*.
- **Plugins** can bundle `hooks/hooks.json`, commands, skills and `.mcp.json`. `claude --plugin-dir <dir>` loads a plugin for one session only. That is how tests use the plugin without touching the user's real config.
- **OpenTelemetry:**
  - Enable with `CLAUDE_CODE_ENABLE_TELEMETRY=1`. Set `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer …`.
  - Metrics: `claude_code.cost.usage`, `token.usage`, `lines_of_code.count`, `commit.count`, `pull_request.count`, `active_time.total`, `session.count`, `code_edit_tool.decision`.
  - Events: user_prompt, assistant_response, tool_result, api_request (with cost and tokens), api_error, tool_decision, permission_mode_changed.
  - Prompt and response content is off unless `OTEL_LOG_USER_PROMPTS` or `OTEL_LOG_ASSISTANT_RESPONSES` is set.
- **Statusline input JSON:** `cost.total_cost_usd`, `total_lines_added` and `total_lines_removed`, plus `context_window.used_percentage` and `context_window_size`. `rate_limits.five_hour` and `seven_day` (`used_percentage`, `resets_at`) are filled on Pro/Max. Also `workspace.repo.{owner,name}` and `model.display_name`.
- **Headless mode:**
  - `claude -p` takes `--output-format stream-json --verbose --include-hook-events --include-partial-messages`.
  - `--input-format stream-json` keeps stdin open so follow-up messages can be sent.
  - Session flags: `--session-id <uuid>`, `--resume`, `--fork-session`, `-n <name>`.
  - Limits and permissions: `--max-turns`, `--max-budget-usd`, `--permission-mode` (default, acceptEdits, plan, auto, dontAsk, bypassPermissions), `--permission-prompt-tool <mcp tool>`, `--permission-prompts host|none`.
  - Other flags: `--model`, `--effort`, `--fallback-model`, `-w/--worktree`, `--allowedTools`, `--disallowedTools`, `--append-system-prompt`, `--json-schema`.
  - Stream message types: `system` (init, hook_started, hook_response, api_retry), `assistant`, `user`, `stream_event`, and the final `result` (total_cost_usd, session_id, permission_denials).
- **Background sessions:** `claude --bg` is managed with `claude agents --json --all` (states working, blocked, done, failed, stopped), `claude logs <id>`, `claude stop <id>` and `claude attach <id>`.
- **Transcripts:** `~/.claude/projects/<cwd-slug>/<session_id>.jsonl`. **The format is internal and may change**, so parse it tolerantly and keep unknown fields as raw JSON.
- **Remote Control (built in):** `claude --remote-control` drives one interactive session from the Claude phone app. Buildyboy **complements** it and does not reimplement it. Buildyboy is the multi-machine, multi-session overview, history, approvals hub, factory and analytics. When a session is known to have Remote Control on, show a link out to it.
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk` exposes `query()` with `hooks` callbacks and `canUseTool`, which can await a remote decision.

**Not yet verified, so check these empirically and record the result in PROGRESS.md under Decisions:**
- what happens when a PermissionRequest hook times out;
- whether PermissionRequest fires under `claude -p`, or whether `--permission-prompt-tool` is needed there;
- whether Claude Desktop's Code tab loads user-scope plugins and hooks;
- whether `AskUserQuestion` can be answered through `updatedInput` from a PreToolUse or PermissionRequest hook;
- which environment variable names the session source (for example `CLAUDE_CODE_ENTRYPOINT`);
- whether `async` works for `http` hooks.

---

## 2. Architecture

```
 dev machine(s): Windows / WSL / any                          WSL host (public)
 ┌───────────────────────────────────────────┐               ┌──────────────────────────────┐
 │ claude (terminal | Desktop | -p | --bg)   │               │ Caddy :443  (TLS, existing)  │
 │   └─ buildyboy plugin                     │   HTTPS       │   buildyboy.<ip>.sslip.io    │
 │       hooks/hooks.json → bb-hook.mjs ─────┼──────────────▶│      └─▶ 127.0.0.1:7700      │
 │       (spool + circuit breaker + git)     │  /api/ingest  │ buildyboy server (Node 24)   │
 │       commands: /bb-walk /bb-status ...   │  /v1/logs     │   Hono + SSE + node:sqlite   │
 │   OTEL exporter (env) ────────────────────┼──────────────▶│   serves web/dist (PWA)      │
 │ bb-runner daemon (optional) ◀─────────────┼── SSE jobs ───│   Web Push (VAPID) / ntfy    │
 │   spawns `claude -p --output-format       │──── results ─▶│   GitHub API poller          │
 │   stream-json` in allowlisted dirs        │               │   data/buildyboy.db (WAL)    │
 └───────────────────────────────────────────┘               └──────────────────────────────┘
                                                                        ▲  phone / laptop browser
```

Data flows in from four places. Each one catches something the others miss, and they are merged on `session_id`:

1. **Hooks.** These carry lifecycle, tool calls with full input and output, permission prompts, notifications, subagents and compaction, and they are the only path for control.
2. **Transcript deltas.** Hooks ship them. They carry the assistant text, thinking summaries, model and per-message token usage.
3. **OTLP/HTTP JSON.** This carries authoritative cost, tokens, API latency and errors, and tool decisions.
4. **Runner stream-json.** This carries the full stream of jobs that Buildyboy launched itself.

An optional fifth source is the statusline bridge (§5.9), which adds context % and rate limits.

### Tech choices (fixed; change them only for a recorded reason)

- **Language:** TypeScript everywhere. Use erasable syntax only (`"erasableSyntaxOnly": true`), so the server runs with plain `node server/main.ts` and no build step. `tsc --noEmit` checks it.
- **Server:** Hono on `@hono/node-server`, with SSE for live push (no WebSocket server). `node:sqlite` `DatabaseSync` runs with WAL, `foreign_keys=ON` and numbered SQL migrations in `server/migrations/`. Validate input with zod.
- **Web:** React 19, Vite, Tailwind CSS v4 and TanStack Query, plus `@xyflow/react` for the pannable and zoomable Floor canvas. Draw charts with small hand-written SVG components unless a library clearly pays for itself. Build it as a PWA (manifest plus service worker) so it installs to the home screen and can receive Web Push.
- **Plugin hook script:** one zero-dependency `plugin/hooks/bb-hook.mjs` that uses only Node built-ins. It must run on Windows and Linux.
- **Runner:** `runner/main.ts`, run by Node 24 directly, with zero or minimal dependencies.
- **Tests:** Vitest for unit and integration tests. Playwright (Chromium) for e2e at 1280×800 and 390×844.
- **Libraries:** look up current docs for every library through the Context7 MCP before using its API.

### Repo layout

```
server/      main.ts, db.ts, migrations/, routes/, ingest/, control/, push/, github/, otlp/
web/         Vite app (src/pages, src/components/floor, src/components/timeline, ...)
shared/      types.ts (event + API types), harness.ts (template parser/renderer), redact.ts
plugin/      .claude-plugin/plugin.json, hooks/hooks.json, hooks/bb-hook.mjs, commands/*.md
runner/      main.ts (daemon), job.ts
cli/         bb.ts — `bb server | runner | pair | set-password | token | import | backup | doctor`
deploy/      deploy-wsl.sh, buildyboy.service, caddy-site.caddy, backup.sh, README section
fixtures/    synthetic hook events, transcripts and stream-json (never copied from real sessions)
scripts/     simulate.ts (replays fixtures into a running server), smoke-claude.ts
.claude-plugin/marketplace.json   (makes this repo a one-plugin marketplace)
```

---

## 3. The plugin and hook protocol (the heart of it)

### 3.1 bb-hook.mjs behavior

- **Input.** Read the hook JSON from stdin. Read config from `~/.buildyboy/config.json`, which holds `{url, token, machineId}`. The environment variables `BUILDYBOY_URL`, `BUILDYBOY_TOKEN` and `BUILDYBOY_DISABLED=1` override it.
- **Envelope.** Wrap the hook JSON with:
  - `machineId`, `hostname`, `platform`. The platform is win32, linux, darwin or **wsl**; detect WSL from `/proc/version` containing "microsoft".
  - `user`, `pid`, `ppid`, `hookVersion`, `ts`.
  - a few allowlisted environment variables. These are the entrypoint or source variable, `CLAUDE_PROJECT_DIR`, `TERM_PROGRAM`, `BUILDYBOY_JOB_ID` and herdr's `HC_TERMINAL_ID` (§11.4). **Never send the whole environment.**
- **Git enrichment.** Do it only on SessionStart, Stop, SessionEnd, and PostToolUse of a Bash call that ran `git`/`gh`. Each command has a 1.5 s timeout and git errors are ignored. Collect:
  - branch, HEAD sha, upstream ahead and behind, dirty file count, remote URL (credentials stripped), repo root, whether it is a worktree and, for a linked worktree, `mainRoot`: the main checkout (the folder holding the common `.git` dir from `git rev-parse --git-common-dir`; absent for a bare repo);
  - at Stop, `git diff --shortstat` against the session's start sha;
  - for `gh pr create` output, the PR URL.
- **Transcript deltas.** Keep a byte offset per session in `~/.buildyboy/offsets/<session>.json`. On PreToolUse (the async twin), PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStop, PreCompact, PostCompact and SessionEnd, send the new JSONL lines, capped at 256 KB per call; any remainder goes on the next call.
- **PROGRESS.md.** At Stop, if `<cwd>/PROGRESS.md` exists and changed (by hash), include its content, capped at 32 KB. This is how harness runs show their Done / Decisions / Next on the phone.
- **Telemetry events are async.** These are every event except the control events listed next. Configure them with `async: true` and POST them to `/api/ingest`. On network failure, append to `~/.buildyboy/spool.jsonl` and flush it on the next successful call. The spool file is capped at 50 MB, dropping the oldest entries first.
- **Control events are sync.** These are PermissionRequest, PreToolUse, Stop, UserPromptSubmit and Notification. POST them to `/api/hook/<event>` and print the server's JSON response on stdout.
- **Fail open, always.** If the server is unreachable or slow, print nothing and exit 0. A circuit-breaker file (`~/.buildyboy/breaker`) skips network calls for 60 s after a failure. **A broken or unreachable Buildyboy must never block, slow or change a local session.** Budgets: at most 1 s extra per sync hook when the server is down, and p95 under 150 ms when it is up on localhost.
- **Fast PreToolUse.** The script first reads the local control cache `~/.buildyboy/control.json`, which the server returns on every telemetry response and the runner refreshes. It calls the server only when the cache says walk mode is on, a kill or pause is pending, or messages are queued. Otherwise it exits immediately.
- **Hook config.** `hooks/hooks.json` registers the script for all useful events. Use `${CLAUDE_PLUGIN_ROOT}` in the command, and set explicit timeouts. Remote approvals need a long timeout, configurable, with a default of 10 min.

### 3.2 Control semantics (server side)

The server keeps a `pending_actions` row for every request that waits on the human. Each request opened in a hook resolves in one of three ways:
- **(a) answered** from the web, in which case the hook gets the decision;
- **(b) timed out**, in which case the hook returns nothing and the local prompt or default applies;
- **(c) answered locally**, which is detected when a later event shows the session moved on. The row is then marked `superseded` and disappears from the Inbox.

Every pending action is pushed to subscribed devices. The cases:

| Situation | Hook | What I can do from the phone | Hook output |
|---|---|---|---|
| Tool needs permission | PermissionRequest (long-poll while **walk mode** is on) | Allow once / Allow for this session (via `updatedPermissions` from `permission_suggestions`) / Deny with a message / Deny and interrupt | `decision.behavior` |
| Claude asks a multiple-choice question | PreToolUse or PermissionRequest on `AskUserQuestion` | Tap options or type "Other" | `updatedInput` with answers. If that mechanism doesn't work, deny with a reason that contains my answer, and record which one was used. |
| Claude proposes a plan | PermissionRequest on `ExitPlanMode` | Read the rendered plan, approve, or reject with feedback | allow / deny + message |
| I want to steer | Queued message → delivered at the next Stop (`decision:"block"`, `reason` = my message) or at the next PreToolUse/PostToolUse as `additionalContext` (choose "now" or "after this turn") | Compose box on the session page | — |
| Turn finished while walk mode is on | Stop holds for up to N min (default 5, configurable per session) waiting for my next instruction, then lets the session go idle | Reply box plus quick replies ("continue", "run the tests", "commit and push", "stop here") | block + reason |
| Emergency stop | PreToolUse returns deny plus `continue:false` with `stopReason` | Big **Stop session** button (confirm). For runner jobs, also kill the process. | universal `continue:false` |
| Pause | PreToolUse holds until resumed (bounded by the timeout) | Pause / Resume | — |

**Walk mode** is a global, per-machine or per-session toggle, also settable with the `/bb-walk on|off` slash command. When it is off, hooks are pure telemetry and desk work is never slowed. Show it prominently.

### 3.3 Plugin extras

- **Slash commands:** `/bb-walk [on|off|5m]`, `/bb-status` (server reachability, machine id, walk mode, spool size) and `/bb-link` (prints this session's Buildyboy URL).
- **Install for real use:** `claude plugin marketplace add <repo or path>`, then `claude plugin install buildyboy@buildyboy`. The installer scripts in §6 do this.
- **Tests:** use `--plugin-dir ./plugin` only.

---

## 4. Data model (SQLite, one file)

Create the tables in migrations. Store raw payloads as JSON text next to the extracted columns, so the parser can improve later and re-derive from the raw data (`bb reindex`).

- **machines:** id, name, hostname, platform, arch, user, token_hash, claude_version, hook_version, runner_online, first_seen, last_seen.
- **projects:** id, machine_id, root_path, name, git_remote, gh_owner, gh_repo, default_branch. A project is unique on (machine_id, root_path). The root is the git `mainRoot` when the hook sends one, else the repo root, else `CLAUDE_PROJECT_DIR`, else cwd: a session in a linked worktree belongs to its main checkout's project and keeps the worktree as its own cwd and branch. An event without git info keeps the session's project and creates none for its folder. An envelope with `mainRoot` moves its session there even if an earlier event without git info filed it elsewhere (a project left with no sessions, commits or PRs is removed). Without `mainRoot` (a plugin from before this change) the worktree folder is the project, as before. Migration 006 moves the sessions, commits and PRs of existing worktree projects (at least one event at the git root said `worktree: true`, none said `false`; older hooks also said `true` in subfolders of a normal checkout, which the hook no longer does) to the one other project on the same machine with the same `git_remote`, and removes the emptied project; with no remote or not exactly one candidate it leaves the project alone.
- **sessions:** id (Claude session_id), machine_id, project_id, cwd, source (cli, desktop, headless, bg, sdk, unknown), name, model, effort, permission_mode, transcript_path, parent_session_id (resume or fork), job_id, status, status_reason, started_at, last_event_at, ended_at, end_reason. Totals: cost_usd, tokens (input, output, cache_read, cache_write), context_pct. Git: lines_added, lines_removed, git_branch, start_sha, end_sha. Also walk_mode and remote_control.
  - **status** is one of `working`, `waiting` (on me), `idle` (turn ended, awaiting prompt), `compacting`, `stale` (no event for 10 min while working), `ended` and `error`.
- **events:** id, session_id, agent_id, ts, event, tool_name, tool_use_id, summary, payload_json. This is the raw append-only log. Index it on (session_id, ts).
- **messages:** uuid, session_id, parent_uuid, agent_id, role, kind, ts, model, text, content_json, usage_json, is_sidechain. Parsed from transcript deltas, deduplicated by uuid.
- **tool_calls:** tool_use_id, session_id, agent_id, tool_name, mcp_server, input_json, output_text (truncated to 64 KB, with a full-length counter), status (ok, error, denied, blocked, interrupted, running), started_at, ended_at, duration_ms, file_path, command, exit_code.
  - A call opens at PreToolUse and closes at PostToolUse (`ok`), PostToolUseFailure (`error` or `interrupted`) or PermissionDenied (`denied`, auto mode only). A call refused before it runs, by a PreToolUse hook (exit 2 or a `deny` decision) or by a `deny` permission rule, gets **no** result event: Claude Code fires only its PreToolUse (checked against the hooks reference and real runs, Claude Code 2.1.319). Such calls become `blocked`: from the transcript, when an error `tool_result` arrives for a call still running (its text, e.g. "Permission to use Bash … has been denied", becomes the output); and as a safety net, still-running calls are closed at the next PreToolUse of the same context (main or one subagent) if they started at least 2 s earlier (calls of one assistant message start together), at Stop or UserPromptSubmit (main context), at SubagentStop (that subagent) and at SessionEnd (all). A PreToolUse that arrives after such a closing event of its context (spool or async order) is closed at once. A result event that arrives later still overwrites `blocked`.
- **subagents:** agent_id, session_id, agent_type, description, started_at, ended_at, status.
- **file_changes:** session_id, tool_use_id, path, op, added, removed, patch (capped).
- **todos:** session_id, ts, items_json. Comes from TodoWrite and Task tools.
- **git_snapshots:** session_id, ts, trigger, branch, sha, ahead, behind, dirty, shortstat.
- **commits:** sha, project_id, session_id, ts, message, author, files, added, removed.
- **pull_requests:** project_id, number, url, title, state, branch, session_id, checks_state, checks_json, updated_at.
- **progress_docs:** session_id, ts, hash, content.
- **pending_actions:** id, session_id, kind (permission, question, plan, stop_wait, pause), request_json, status (pending, answered, timeout, superseded), response_json, created_at, answered_at, answered_by.
- **queued_messages:** id, session_id, text, mode (now, after_turn), status (queued, delivered, cancelled), created_at, delivered_at, delivered_via.
- **templates:** id, name, source (path or uploaded), body. `harness-prompt.md` is seeded and re-read from disk on change.
- **prompts:** id, template_id, title, slots_json, extra_md, rendered, tags, created_at, updated_at.
- **prompt_versions:** prompt_id, version, slots_json, extra_md, rendered, created_at.
- **jobs:** id, prompt_id, machine_id, cwd, options_json, session_id, status (queued, starting, running, succeeded, failed, stopped, lost), exit_code, cost_usd, result_json, started_at, ended_at, verify_json.
- **job_output:** job_id, seq, line_json. Raw stream-json, capped.
- **otel_points:** ts, session_id, name, value, attrs_json.
- **otel_events:** ts, session_id, name, attrs_json.
- **push_subscriptions:** id, device_name, endpoint, keys_json, created_at, last_ok_at.
- **pairing_codes**, **web_sessions**, **audit_log** (ts, actor, action, target, detail) and **settings** (key, value).
- **Factory (§11):** tasks, task_deps, task_events, gate_results, gate_shots, decisions, control_requests, agent_tokens, hc_terminals, digests; sessions.hc_terminal.
- **FTS5 index** over messages.text, tool_calls.command and input, prompts.rendered and session names.

**Redaction.** Before anything is stored, `shared/redact.ts` masks likely secrets: API keys and tokens (`sk-…`, `ghp_…`, `gho_…`, AWS keys, JWTs, `Bearer …`, `password=…`) and the content of `.env*` files read with Read. The rules are testable and can be extended in Settings.

**Retention.** Raw events and job output older than N days (default 90) are purged nightly. Sessions, messages and aggregates are kept. `bb backup` uses `node:sqlite` `backup()`.

---

## 5. Features

Each item is in scope. Priorities and order are in §8.

### 5.1 The Floor (home, the canvas metaphor)

The look is an industrial blueprint, dark-first with a light theme too: a factory floor seen from above.
- **Machine = bay.** Each machine is a labeled zone with an online light and its runner status.
- **Session = station.** Each live or recent session is a station inside its machine's bay. It shows:
  - a big **status lamp**: pulsing green for working, amber for waiting on me (it also badges the Attention bar), blue for idle, grey for ended, red for error, striped for stale;
  - the project name and branch, with a dirty dot;
  - the current activity line, for example "Bash: npm test" or "Editing server/db.ts";
  - a **context tank** (fill %), a **cost meter** and the elapsed time;
  - a **conveyor belt**: the last ~20 tool calls as colored tokens that slide in. Read is blue, Edit and Write violet, Bash orange, Web teal, MCP pink, Agent yellow, failures outlined red.
- **Subagent = drone.** Running subagents are drones tethered to their station. They land and fade when they finish.
- **Jobs.** Jobs launched by the factory show a "job" badge and their Limit countdown (time left, budget left).
- **Desktop.** Pan and zoom with React Flow. Positions are auto-laid-out per machine, can be dragged, and are remembered per device in localStorage.
- **Phone.** It is not a tiny canvas. It is a vertical list of station cards with the same visual language, grouped by machine, with "waiting" sessions first. A toggle opens the canvas.
- **Filters:** live only / today / project / machine. Respect `prefers-reduced-motion`.
- **Attention bar.** A sticky bar across all pages: "2 waiting for you · 1 job failed". One tap opens the Inbox.

### 5.2 Session page

- **Header:**
  - status, name, machine, cwd, branch and git state, model, effort, permission mode;
  - cost, tokens and cache-hit %, the context gauge, and a compaction count;
  - duration and time spent waiting on me;
  - a walk-mode toggle, a Stop button and a Remote Control link when it is on.
- **Copy buttons:** `claude --resume <id>`, `claude --desktop --resume <id>` and `cd <cwd>`.
- **Timeline:** a chat-like feed of my prompts, Claude's text (markdown) and tool calls, each with its own renderer:
  - Bash: command, exit code and collapsible output;
  - Edit, Write and MultiEdit: a unified diff with syntax highlighting;
  - Read, Grep and Glob: path, pattern and result counts;
  - WebFetch and WebSearch: URL or query;
  - Agent/Task: opens that subagent's lane;
  - TodoWrite: a live checklist;
  - AskUserQuestion: a question card;
  - ExitPlanMode: the plan as rendered markdown;
  - MCP tools: a server/tool badge plus JSON.
- **Events in the timeline:** compaction, errors (PostToolUseFailure, StopFailure such as rate limits), notifications and permission decisions with who decided and how long it took.
- **Side panels** (tabs on the phone): Todos, Files touched (a heatmap of paths plus per-file diffs), Git (snapshots, commits, PR plus checks), Subagents, Progress (the latest `PROGRESS.md` rendered, highlighting **Next** and **Decisions**), and Raw events.
- **Compose box:** queue a message, choose now or after the turn, see queued and delivered state, and use quick replies.
- **Live updates:** the page updates over SSE. When I scroll up it stops auto-scrolling, and a "jump to live" pill brings me back.
- **Replay:** a scrubber replays the session on the timeline and the station animation.
- **Export:** export as Markdown (prompts, answers, tool summaries, diffs).

### 5.3 Inbox, notifications and remote control

- **Inbox.** It lists every pending action, newest first. Each card shows enough context to decide without opening the session: the tool, the full command or diff, the cwd and branch, and Claude's last message. Big touch targets let me answer each case in §3.2. Answered and expired items move to History.
- **Web Push** goes to every subscribed device. Notifications fire for:
  - a permission, question or plan waiting on me;
  - a session that finished a turn while walk mode is on;
  - a job that succeeded or failed;
  - a session that is stale or looping (§5.8);
  - CI on a session's PR that failed or passed;
  - a budget threshold, or rate limits above 80%.
  The push carries actions where the platform allows them (Allow / Deny). Push can be set per type and per session, and quiet hours can be set.
- **ntfy topic.** An optional fallback channel through an ntfy.sh topic URL (one POST). It is useful on iOS when the PWA isn't installed.
- **Kill and pause.** Both are available per session, plus a global **"Pause everything"**.

### 5.4 Prompt factory (composer for `harness-prompt.md`)

- **Template parsing.** Parse `harness-prompt.md` at runtime. The slots are the `Key: <hint>` lines under `# Task`. Infer each control from its hint:
  - `<yes | no>` becomes a toggle;
  - `<new, e.g. … | current>` becomes a choice plus a name field;
  - a number with a default becomes a number field;
  - anything else becomes a textarea.
  The body after the slots stays verbatim. Edits to the template file on disk show up without a restart. Extra templates can be uploaded or pasted, and any `<…>` placeholder becomes a slot.
- **The form:**
  - Goal is a large textarea. Done when is a list editor with one check per line, rendered as a list. Scope, Limit, Subagents, Branch, PR and Unattended follow the slot types.
  - An **Attach spec** area holds free markdown appended as a `## Spec` section, or a reference to a spec file in the target repo.
  - There is a live rendered preview.
  - **Lint warnings** come from the template's own rules:
    - `PR: yes` requires a new branch;
    - `Unattended: yes` without a Limit;
    - an empty Done when, or one with no runnable command;
    - Subagents is not a number;
    - leftover `<…>` placeholders.
- **Library.** Saved prompts with tags, search, duplicate, version history with a diff between versions, and stats per prompt (runs, success rate, average cost and duration).
- **Outputs:** copy the Markdown; download it as `TASK.md`; copy a ready command line (`claude -p "$(cat TASK.md)" --permission-mode … --max-budget-usd …`, with PowerShell and bash variants); or **Launch** it as a job (§5.5).
- **Spec-ify (optional, last).** A button sends my rough idea through a runner job (`claude -p`, Opus, `--json-schema`) and fills the Goal, Done when and Scope slots plus a draft spec. I review them before saving.

### 5.5 Runner and jobs (start work from the phone)

- **Pairing and connection.** `bb runner` is a small daemon on each machine. It pairs once with a code, then holds an outbound SSE connection, so it works behind NAT. It sends a heartbeat every 15 s.
- **Allowed directories.** The runner config lists **allowed root directories**. The config lives on the machine and the server cannot change it. Jobs can run only inside those roots. The runner never runs arbitrary shell commands from the server. It runs only `claude` with a validated argument list, plus the job's Done-when verify commands, and only after I confirm them in the UI.
- **Launch form:**
  - Inputs: a saved prompt, a machine, a project directory (from known projects under the allowed roots), and optionally a new git worktree (`-w`).
  - Model and run settings: model, fallback model, effort, permission mode, max budget USD (required, default $5), max turns, extra allowed and disallowed tools, walk mode on or off.
  - The runner starts `claude -p --output-format stream-json --verbose --include-hook-events --input-format stream-json --session-id <uuid> -n <title>`. The prompt is written to stdin and the job id goes into the `BUILDYBOY_JOB_ID` environment variable. The hooks then link the job and the session automatically.
- **While it runs.** The job's stream shows live. I can send follow-up messages over stdin stream-json, stop it (graceful, then kill), resume it (`--resume <session>`) or rerun it.
- **Queue.** Jobs queue per machine, with one running job per repo at a time and a configurable machine-wide concurrency (default 2). Scheduled jobs (cron syntax) cover cases like "every night at 02:00 run the dependency-update prompt on repo X". Fan-out runs one prompt across several projects.
- **Verify.** After a job, the **Verify** action runs the prompt's Done-when commands in the job's directory. They run on the runner, with confirmation, and the pass/fail output is shown and stored. This checks the agent's claims against reality.
- **Background sessions.** The runner also reports `claude agents --json --all` every 60 s, so `--bg` sessions show on the Floor even before their hooks fire.

### 5.6 Git and GitHub

- **Git timeline per session.** It is built from the hook snapshots: the start state, every commit made during the session (message, files, +/−), the end state, and the diffstat for the whole session.
- **GitHub pulls.** With an optional GitHub token in Settings (fine-grained, read-only is enough), the server polls PRs for the branches of active projects every 2 min. It reads state, review state and check runs. A PR is linked to a session when the PR URL appears in a hook or the branch matches. A failed check notifies me.
- **Project page.** It lists the sessions, jobs, PRs, cost over time and the recent `PROGRESS.md` files.

### 5.7 Insights

- **Analytics page:**
  - cost per day, week and month, broken down by project, model and machine;
  - tokens and cache hit ratio;
  - sessions per day, active time, and lines added or removed;
  - the most-used tools and the most-failed commands;
  - permission-wait time (how long Claude waited on me);
  - job success rate per prompt template;
  - rate-limit history, if the statusline bridge is on.
- **Global search** (FTS) across messages, commands, file paths, prompts and session names. Results deep-link to the exact timeline item.
- **Backfill.** `bb import` uploads existing transcripts from `~/.claude/projects` on that machine, with a progress bar. On the first day, months of history show up. Imported sessions are tagged `imported` and parsed tolerantly.

### 5.8 Smart watchers (server-side rules, each can be toggled)

- **Stale:** no event for 10 min while working.
- **Loop suspicion:** the same tool and input failing 3 times or more, or 15 turns or more with no file changes.
- **Budget:** a session or job cost passes a threshold.
- **Context:** more than 85% used, or the number of compactions in one session.
- **Harness alignment:** a harness run whose `PROGRESS.md` **Next** hasn't changed in 60 min, or a run that reached its Limit.

Each watcher writes a timeline event and can push a notification.

### 5.9 Machines, setup and settings

- **Machines page:**
  - online status, Claude and hook versions, the time of the last event, spool size (reported) and runner status;
  - per-machine walk mode;
  - rotate or revoke its token;
  - a **hook health check** that sends a test event round trip.
- **Settings:**
  - password change, and passkeys (optional, stretch);
  - notification channels and quiet hours, a "Send test notification" button;
  - redaction rules, retention, budgets and watcher thresholds;
  - the GitHub token;
  - the **OTEL snippet** (the env block to paste into `~/.claude/settings.json`);
  - the **statusline bridge** snippet.
- **Statusline bridge.** A tiny `plugin/statusline/bb-statusline.mjs` POSTs the statusline JSON, throttled to once every 10 s per session, then runs the user's previous statusline command and passes its output through. It is optional and documented, never installed automatically.
- **Auth:**
  - **Web login.** A single password (scrypt) sets an HttpOnly, Secure, SameSite=Strict session cookie for 30 days, with a device list and remote logout. Login is rate-limited, and POSTs get CSRF protection. On first run with no password, the server prints a one-time setup URL to its log; `bb set-password` also works.
  - **Hooks and runners** use per-machine bearer tokens, stored as hashes. Machines get them through pairing codes: a code is shown in the UI, valid for 10 min, and used once.

---

## 6. Deploy and install

### 6.1 Server deploy to WSL: `deploy/deploy-wsl.sh`

The script is idempotent, uses `set -euo pipefail`, and has `--dry-run` and `--uninstall`. It runs inside WSL as `sysadm`, using `sudo` only for the system steps, and it prints every action before doing it.

1. **Preflight checks:** Node 24 via nvm, port 7700 free, Caddy present, and the existing Caddyfile valid.
2. **Install:** rsync the app to `/opt/buildyboy` (or `~/apps/buildyboy`, whichever needs no extra sudo), run `npm ci --omit=dev` and build the web app. The data directory is `~/.local/share/buildyboy` (the DB, VAPID keys and backups).
3. **Service:** install the systemd unit `buildyboy.service` (User=sysadm, the absolute nvm node path, `Restart=always`, `127.0.0.1:7700`, `NODE_ENV=production`, plus hardening: `NoNewPrivileges`, `ProtectSystem=strict` with the data dir writable).
4. **Caddy.** Write `/etc/caddy/sites/buildyboy.caddy` for `${DOMAIN:-buildyboy.109-99-176-213.sslip.io}`, reverse-proxying to 127.0.0.1:7700. Turn SSE buffering off (`flush_interval -1`). Add an `import /etc/caddy/sites/*.caddy` line to the main Caddyfile **only if it is missing, after a timestamped backup**. Then run `caddy validate`, then `systemctl reload caddy`. If validation fails, restore the backup automatically. **Never edit or reorder the existing contzo.lol blocks.**
5. **Backups:** a nightly backup timer (keep 14).
6. **Finish:** wait for `https://$DOMAIN/api/health` to return 200 and print the setup URL.

There is also an update script: `deploy/update.sh` pulls, installs, migrates and restarts, and rolls back if the health check fails.

### 6.2 Client install (each machine)

- **Linux/WSL/mac:** `curl -fsSL https://<host>/install.sh | bash -s -- <PAIRCODE>`.
- **Windows:** `$env:BB_CODE='<PAIRCODE>'; irm https://<host>/install.ps1 | iex`.

The installer:
1. downloads the plugin from the server as a tarball;
2. writes `~/.buildyboy/config.json`;
3. registers the plugin with `claude plugin marketplace add` and `claude plugin install`;
4. optionally installs `bb runner` as a user service (systemd `--user` on WSL, a Scheduled Task at logon on Windows);
5. sends a test event.

Uninstall reverses all of it. **Nothing edits `~/.claude/settings.json` directly.**

Note: Windows and WSL have separate `~/.claude` folders, so install on both.

---

## 7. HTTP API (sketch; refine as you build)

- **Public:** `GET /api/health`, `GET /install.sh`, `GET /install.ps1`, `GET /plugin.tgz`, `POST /api/pair`.
- **Agent token (§11.1):** `POST /api/agent/<tool>` (one per MCP tool), `GET /api/governor`, `GET /api/usage`.
- **Machine token:** `POST /api/ingest` (batch of envelopes, idempotent by an event hash), `POST /api/hook/:event` (sync control; may long-poll), `POST /v1/metrics`, `POST /v1/logs` (OTLP http/json), `POST /api/statusline`, `GET /api/runner/stream` (SSE jobs and control), `POST /api/runner/jobs/:id/events`.
- **Web (cookie):**
  - Sessions: `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/timeline?cursor=`.
  - Live: `GET /api/stream` (SSE; topics floor, session:<id>, inbox).
  - Inbox: `GET /api/inbox`, `POST /api/actions/:id/answer`.
  - Session control: `POST /api/sessions/:id/messages`, `POST /api/sessions/:id/{stop,pause,resume,walk}`.
  - Prompts and templates: `GET|POST|PUT /api/prompts…`, `GET /api/templates`.
  - Jobs: `POST /api/jobs`, `POST /api/jobs/:id/{stop,message,resume,verify}`.
  - Factory (§11): `GET|POST /api/tasks`, `GET|PUT|DELETE /api/tasks/:id`, `POST /api/tasks/:id/{control,launch}`, `POST /api/tasks/import/{markdown,github}`, `GET /api/gate-shots/:id`, `GET /api/decisions`, `POST /api/decisions/:id/{answer,cancel}`, `GET|POST /api/agent-tokens`, `POST /api/agent-tokens/:id/revoke`, `GET|POST /api/digests`, `GET /api/terminals`, `GET /api/governor`.
  - Everything else: `GET /api/machines…`, `GET /api/projects…`, `GET /api/analytics…`, `GET /api/search?q=`, `POST /api/push/subscribe`, `GET|PUT /api/settings`, `POST /api/auth/{login,logout}`.

---

## 8. Milestones (build in this order; each must pass checks before the next)

1. **M0: Skeleton and checks.**
   - Build the layout from §2.
   - Add the scripts `check` (tsc for all packages plus Vitest), `build`, `e2e`, `simulate`, `smoke:claude`, `dev` and `start`.
   - `GET /api/health` returns 200.
   - Commit the `.gitignore` (data/, node_modules/, dist/, .env*, PROGRESS.md).
2. **M1: Ingestion.**
   - Migrations, `/api/ingest`, the hook control endpoint stubs, machine tokens, redaction and the timeline derivation (events → tool_calls, messages, subagents, todos, file_changes, status machine).
   - `bb-hook.mjs` with the spool and circuit breaker.
   - Synthetic fixtures covering: 3 sessions on 2 machines, a subagent, a permission request, an AskUserQuestion, a compaction, a failure and a git commit.
   - `npm run simulate` (with a `--live` mode that replays in real time).
   - Tests for redaction, the status machine, transcript-delta parsing and idempotency.
3. **M2: Live UI.**
   - Auth, SSE, the Floor (desktop canvas plus phone list), the session timeline with every tool renderer, the Attention bar and the PWA shell.
   - Playwright e2e at both viewports on simulated data.
   - Visual check in Chrome.
4. **M3: Remote control.**
   - Pending actions with long-poll, the Inbox, answers for permission, question and plan, queued messages through Stop and `additionalContext`, walk mode, stop and pause, Web Push (VAPID keys generated on first run) and ntfy.
   - Integration tests that spawn `bb-hook.mjs` with fixture stdin against a test server and assert its stdout JSON for every row of the §3.2 table, plus fail-open when the server is down (no output, exit 0, well under 1.5 s).
5. **M4: Real Claude smoke (`npm run smoke:claude`).**
   - In a temporary git repo, start the server on a temporary DB.
   - Run `claude -p` with `--plugin-dir ./plugin`, the cheapest model alias, `--max-budget-usd 0.30` and a small task that reads, writes and commits a file.
   - Assert: the session row exists; SessionStart, PostToolUse and Stop arrived; messages were parsed from the transcript; a git snapshot shows the commit.
   - In a second run, require a permission (default mode, a Write) that the test approves through the API, and assert the file exists.
   - Fix the parsers against the real payload shapes. Settle the not-yet-verified items in §1 and record them. Store only sanitized, synthetic-looking fixtures.
6. **M5: Deploy and install.**
   - `deploy/deploy-wsl.sh` (and its `--dry-run`), the systemd unit, the Caddy snippet, `update.sh`, `backup.sh`, pairing, `install.sh` and `install.ps1`, the Machines page and the README "Go for a walk in 10 minutes" guide.
   - Verify with `bash -n`, with shellcheck if it's available, and by running `--dry-run` inside WSL. The dry run must exit 0 and leave the `/etc/caddy/Caddyfile` checksum unchanged.
   - **Do not run the real deploy.**
7. **M6: Prompt factory.**
   - The template parser and renderer in `shared/harness.ts`, with a golden test: filling every slot of `harness-prompt.md` produces the template with only the slot values replaced and everything else byte-identical. Hints are dropped and the line endings are preserved.
   - Lint rules, the form, preview, library, versions with diff, and the copy/download/command-line outputs.
8. **M7: Runner and jobs.**
   - Pairing, outbound SSE, allowed roots, the launch form, the live job stream, follow-up messages, stop, resume, rerun, the queue, cron schedules, Verify, and `claude agents` reporting.
   - Test with a fake `claude` binary (an environment override for the executable path) that emits fixture stream-json, plus one real cheap job inside the smoke budget.
9. **M8: Git and GitHub.** Session git timeline, commits, PR detection, the GitHub poller (skipped cleanly without a token) and the project page.
10. **M9: Insights.** The OTLP receiver, analytics, FTS search, `bb import` backfill, smart watchers, replay, Markdown export and the statusline bridge.
11. **M10 (stretch):** Spec-ify, passkeys, fan-out, and per-template success stats.

---

## 9. Quality bar

- **Phone first.** At 390 px wide: no horizontal scroll, touch targets of 44 px or more, readable 15 px or larger body text, and the Inbox answerable with one thumb. Desktop gets more density, not a different app.
- **Speed.** The Floor updates within 1 s of a hook event. A session with 2,000 events opens in under 1.5 s on desktop, using a virtualized timeline.
- **Resilience.** The server restarting loses nothing, because hooks spool. A lost SSE connection reconnects and backfills from the last event id.
- **Safety.**
  - Every state-changing web action is CSRF-protected and audit-logged.
  - Machine tokens can only ingest and answer their own sessions' hooks.
  - The runner's allowed roots are enforced on the client side.
  - Secrets are redacted.
  - No dependency on a third-party SaaS except optional Web Push endpoints, ntfy and GitHub.
- **Honest UI.** Unknown or unparsed transcript lines show as "raw" rather than disappearing. Times show as relative with exact timestamps on hover or long-press.

## 10. Non-goals

- Reimplementing Remote Control's interactive terminal.
- Multi-user or teams.
- Running Claude on the server itself (the server never executes Claude, `hc` or shell commands; the runner does, §5.5 and §11.4).
- Editing code in the browser.
- Running git on other repositories. Stop and revert requests for a package are recorded for the coordinator (§11.5); the coordinator does the git work.
- Orchestrating the factory itself. Buildyboy is the control tower; a Claude Code coordinator in a herdr terminal decides what runs next (§11).

An MCP server and a backlog are **no longer** non-goals: they are §11.1 and §11.2.

---

## 11. The factory (P0)

Buildyboy is the control tower of an autonomous factory (decided 2026-11-07): a **coordinator** Claude Code session runs in a herdr terminal, starts interactive **workers** (one worktree per package) with `hc run --bg`, runs short `claude -p` verifiers, and integrates packages that pass the gates. Buildyboy holds the memory: the backlog, usage and the governor, the gates, the decisions inbox and the daily digest, and it shows all of it on the phone.

```
 Narcis (phone) ──► Buildyboy: backlog · usage 5h/7d · governor · gates · decisions · digest
                         ▲ MCP (bb mcp, agent token)            ▲ hooks + statusline bridge
 hc terminal: COORDINATOR ── hc run/wait/send ──► WORKERS (interactive claude, a worktree each)
                         └── claude -p --json-schema ──► VERIFIERS (review, QA, visual)
```

### 11.1 MCP server: `bb mcp` and `/mcp` (Streamable HTTP)

- Two transports, one tool surface (`shared/mcp-tools.ts`: `registerTools`, the server instructions sent at initialize, `readOnlyHint` annotations from `READ_ONLY_TOOLS`). The tool list and its zod schemas live in `shared/factory.ts` (`TOOLS`), so every transport and the server validate the same arguments.
  - **`bb mcp`** (stdio, `cli/mcp.ts`, official MCP TypeScript SDK v2): a thin process on the agent's machine. Every tool is one call to `POST /api/agent/<tool>`, with the offline outbox, read cache and local governor of §11.7.
  - **`/mcp`** (Streamable HTTP, `server/routes/mcp.ts`, decided 2026-11-14): for remote machines and MCP clients without a checkout. Stateless `createMcpHandler`: each POST builds a fresh `McpServer` whose tools run in-process through `callTool` (`server/factory/agent.ts`), the same function behind `/api/agent/<tool>`. Serves the 2026-07-28 protocol and 2025-era stateless clients; GET/DELETE answer 405. Auth is `Authorization: Bearer bba_…`, checked before the SDK sees the request (401 with `WWW-Authenticate: Bearer`). Body limit ~95 MB (12 screenshots of 5 MB as base64). No outbox: when the server is down the call fails. `gates_record` screenshots must be base64; a `path` is refused with a message saying so. `/.well-known/oauth-*` and `openid-configuration` answer 404 JSON so a client's OAuth discovery after a 401 never parses the PWA's index.html.
- **Agent tokens** (`bba_…`) are separate from machine tokens: stored as hashes in `agent_tokens`, created in Settings → Factory (or `bb agent-token <name>` on the server host), shown once, revocable from the PWA. An agent token reaches only `/api/agent/*`, `/mcp`, `GET /api/governor` and `GET /api/usage`; a machine token or a web cookie reaches neither `/api/agent/*` nor `/mcp`. Each token also has a launch scope (`launch`: `off` by default, `workers`, or `all` = workers and coordinators) and `launch_approval` (default on), set from Settings → Factory (`PUT /api/agent-tokens/:id`).
- **Agents launching** (`server/factory/launch.ts`, shared with `POST /api/tasks/:id/launch`): `tasks_launch` starts a worker for a package (allowed-roots check, checked options, claims the package); `coordinator_launch` starts a coordinator (`role: coordonator` → hc terminal `bb-coord-<job>`, label `bb.role=coordonator`, built-in coordinator prompt unless given one). Order: token scope (403) → the launch's own checks (400/404/409) → governor `canStart` (409, no force) → approval. With approval on, the first call opens a decision (Launch / Refuse) and stores a `launch_requests` row keyed by the token and the normalised arguments; identical calls answer `pending_approval` until it is answered, then launch once (approval valid 24 h) or answer `refused`. Audit: `task_launch` / `coordinator_launch` as `agent:<name>`, `launch_approval_asked`, `launch_refused`.
- Config for `bb mcp`: `BUILDYBOY_URL` (default: the url in `~/.buildyboy/config.json`) and `BUILDYBOY_AGENT_TOKEN`. Register with `claude mcp add buildyboy --scope user -e BUILDYBOY_URL=… -e BUILDYBOY_AGENT_TOKEN=… -- node <repo>/cli/bb.ts mcp`, or over HTTP with `claude mcp add --transport http buildyboy https://<host>/mcp --header "Authorization: Bearer bba_…"`. Settings → Factory shows both lines with a fresh token.
- Tools: `usage_get`, `governor_get`, `sessions_list`, `sessions_get`, `tasks_list`, `tasks_get`, `tasks_create`, `tasks_claim`, `tasks_update`, `prompts_render`, `prompts_lint`, `prompts_save`, `gates_record`, `gates_run`, `gates_status`, `findings_list`, `findings_update`, `decision_ask`, `decision_get`, `digest_post`, `control_get`, `machines_list`, `tasks_launch`, `coordinator_launch`, `docs_get`. Results are JSON text (`docs_get`: Markdown); failures come back as `isError` with the server's message.
- `gates_record` takes screenshots as local paths; `bb mcp` reads them and uploads base64 (PNG, JPEG, WebP or GIF, at most 5 MB each, 12 per call).
- **Reference for agents** (`server/docs/reference.ts`): every tool (when to use it, every argument with type and description derived from its zod schema, result, errors, an example), the result shapes, and every HTTP endpoint (method, path, auth, query, body, result, errors) as data. It feeds the manual's "For agents" pages (`/docs/agents`, `/docs/mcp-tools`, `/docs/api`), a public Markdown guide (`/docs/agents.md?topic=start|tools|api|all`, `/llms.txt`) and the `docs_get` tool. `tests/reference.test.ts` fails when a registered route or a tool argument has no entry, or an entry names something that does not exist.
- `npm run smoke:mcp` starts a server on a temporary DB, sends a SessionStart and a statusline sample the real way, spawns `bb mcp` over stdio and calls every tool, connects to `/mcp` over Streamable HTTP and checks it lists the same tools, then checks that a revoked token is refused. `tests/mcp-http.test.ts` drives `/mcp` with the SDK client.

### 11.2 Backlog

- **tasks** (packages): id (given, like `P2`, or `T<n>`), title, body, acceptance criteria, status, repo, branch, priority, cost, prompt id and version, sensitive flag, note, claimed by, job, terminal, session, source (`web`, `markdown`, `github`, `agent`), external ref, integrated_at. **task_deps** (task → depends on, no cycles), **task_events** (history: created, status, update, note, gate, control).
- Statuses: `backlog`, `gata`, `in_lucru`, `la_porti`, `integrata`, `blocata`. A task is **ready** when it is `gata` and every dependency is `integrata`.
- `tasks_claim` takes the given ready task or the best ready one (priority, then age), sets `in_lucru` and `claimed_by`, atomically. It is refused while the governor says `canStart: false`, unless `force: true`.
- Inputs: the PWA (also on the phone); Markdown files with frontmatter (`bb tasks import <file|dir>`, generic: `id`, `title`, `status`, `depends_on`/`after`, `repo`, `branch`, `priority`, `sensitive`, `acceptance` or an "Acceptance criteria" section; upsert by id, or by path for files without an id; dependencies ordered; a re-import never changes the status of a package already started, and absent lists leave dependencies and criteria alone); GitHub issues of a repo (optional label) through the existing GitHub token, upserted by `owner/repo#n`. `--dry-run` prints each package with its criteria, numbered and whole, and writes nothing.
- The criteria section (Markdown files and issue bodies, one parser in `shared/tasks-md.ts`): the heading that is exactly "Acceptance criteria" or "Criterii de acceptare", ignoring case, diacritics, leading numbering and a trailing colon; without one, the first heading that contains "acceptance criteria", "criterii de acceptare", "criteriile de acceptare" or "criterii de acceptanță". A heading that only mentions acceptance ("Contractul pentru testele de acceptare") never counts. The section runs to the next heading of the same or a higher level. Every `-`, `*`, `+` or `1.` item is one criterion (a `[ ]`/`[x]` box is dropped); its indented lines continue it, joined with a space, until the next item, a blank line or a heading. Fenced code blocks (``` or ~~~) are skipped: their lines are never headings, items or continuations.
- PWA: `/backlog` (board: six columns on desktop, a status filter on the phone), `/backlog/:id` (the package page, §11.5).

### 11.3 Consumption governor

`GET /api/governor` and `governor_get` answer `{ canStart, stopAll, waitUntil, reason, usage, thresholds }` from the newest statusline sample (`rate_limits.five_hour` / `seven_day`, `used_percentage` and `resets_at` in epoch seconds):

- the 7-day window at or above **80%** → `stopAll: true`, `canStart: false`, `waitUntil` = its reset;
- the 5-hour window at or above **85%** → `canStart: false` (active workers finish), `waitUntil` = its reset;
- a window missing from the data, or whose `resets_at` has passed, is ignored (each window is read from the newest sample that carries it, so a sparse sample cannot hide a window still over its limit);
- data older than **30 min**, or no data at all, → `canStart: false`, with the reason.

The three thresholds are settings (`governor_five_hour_pct`, `governor_seven_day_pct`, `governor_max_age_min`). The existing 80% watcher (§5.8) still notifies.

### 11.4 herdr integration

- The **runner** finds `hc` (`hcPath` in runner.json, `BUILDYBOY_HC`, herdr-core's default install, or PATH), reports `hc ls --json` every 15 s to `POST /api/runner/terminals`, and the Floor shows the terminals with their status, linked to their Claude Code session through `HC_TERMINAL_ID` (hook env allowlist → `sessions.hc_terminal`) and to their package.
- **Closed terminals end their sessions.** A session killed with its terminal (`hc kill`, `hc rm`, a closed window) sends no SessionEnd. Each report carries `takenAt` (runner clock when `hc ls` ran; older runners: arrival time). A session linked to a terminal of that machine (`sessions.hc_terminal`) whose terminal is reported `finished` or is missing, and whose last event is older than `takenAt`, becomes `ended` with end reason `terminal closed`; its running tool calls become `interrupted`. `box/t7` and `t7` count as the same terminal. There is no time-based rule: sessions without an hc terminal, or in a live one, stay idle for as long as they are idle. If a session ended this way sends another event, it is reopened.
- A package starts as an interactive agent from its page: `POST /api/tasks/:id/launch` with `launcher: 'hc'` makes a job that the runner turns into `hc run --bg --name bb-<task> --cwd <dir> --label owner=buildyboy --label bb.task=<id> … claude …` (a checked argv, inside the allowed roots, no shell; `claude` is resolved to its real executable, never a `.cmd` shim, and hc passes arguments through unchanged, verified 2026-11-07). `launcher: 'claude'` is a normal `claude -p` job. Launching claims the package (`in_lucru`) at once; a launch that fails before any terminal or session hands it back to its earlier status. The worker's SessionStart links its session to the package through the terminal.

### 11.5 Gates, controls, decisions and the digest

- **gate_results** (task, gate G1–G5, verdict pass/fail/skip, summary, details, actor) and **gate_shots** (images, in the DB so backups keep them). The package page shows each gate's latest verdict, summary and screenshots, and earlier attempts.
- **Oprește pachetul** and **Cere revenirea integrării** record a **control_request** (`stop` or `revert`, with a note). `control_get` returns the open ones; `ack: true` marks them handled. Buildyboy never runs git on other repositories.
- **decisions**: `decision_ask` puts a question (with options and context, optionally tied to a package) in `/decisions` and pushes a notification; the answer is read back with `decision_get`. Pending decisions count in the attention bar.
- **Digest**: once a day at `digest_time` (default 08:00 server time, `digest_enabled`), and on demand with `digest_post` or Settings: what was integrated in 24 h (sensitive packages marked), gate passes and failures, packages in progress and blocked, 5 h/7 d usage and the governor, decisions waiting, unhandled stop/revert requests. Sent through Web Push/ntfy and kept in **digests**.

### 11.6 Activation on a machine

The factory needs usage data, so on each machine where the coordinator runs:

1. Pair the machine and install the plugin (§6.2).
2. Configure the statusline bridge in `~/.claude/settings.json` (`plugin/statusline/bb-statusline.mjs`) and, optionally, the OTEL env block (Settings → Snippets). Nothing in Buildyboy edits these files.
3. Create an agent token and register `bb mcp` with `claude mcp add`.
4. Run `bb doctor` (with `BUILDYBOY_AGENT_TOKEN` set): it lists exactly what is still missing (statusline bridge, OTEL, MCP registration, `hc`, fresh usage data) and the step for each.

### 11.7 Bookkeeping (decided 2026-11-10)

What the coordinator kept by hand during P1–P7 is kept by Buildyboy. Every existing tool keeps its arguments and result shape; the new fields are optional and additive.

- **Offline `bb mcp`** (`cli/outbox.ts`). The server is *unreachable* when fetch fails or answers 502/503/504; any other answer (401 included) is real. `gates_record`, `tasks_update`, `digest_post` and `prompts_save` are then appended to `~/.buildyboy/outbox.jsonl` (or `BUILDYBOY_HOME`) with an idempotency key and answer `{ queued: true, key, … }`; `tasks_claim`, `decision_ask` and the other writes fail clearly. Every queueable call sends the `idempotency-key` header; the server stores key → result (`agent_calls`, 30 days) and answers a repeated key with the first result. Replay runs in order at start, before every call and every 30 s while items are queued; an item the server refuses moves to `outbox.rejected.jsonl`. Every `bb mcp` on the machine shares the file, so appends and rewrites take `outbox.jsonl.lock`, and each item is replayed only by a `bb mcp` with the agent token that queued it. Reads keep the last answer per tool and arguments (`mcp-cache.json`, 200 entries) and return it with `stale: true, staleAgeMs, staleSince` (an array comes back as `{ stale, …, result }`). `governor_get` offline applies the governor's rules (`evaluate`, now in `shared/factory.ts`) to `~/.buildyboy/statusline/latest.json`, which the statusline bridge writes on every call, with `local: true` and a reason that says so. After 10 minutes unreachable, with `ntfyTopic` in `~/.buildyboy/config.json`, one ntfy message per outage, and one when the server is back.
- **Rounds.** Each move into `la_porti` starts a round (`tasks.round`); the first gate result without one counts as round 1, and every gate result stores its round. A failing gate ends its round; if the round is at `maxRounds` (setting `gate_max_rounds`, default 3, plus approved extra rounds) the package becomes `blocata` and one decision tied to it asks: "Încă o rundă", "Încă o rundă, doar pentru <gate>" (per failed gate), "Oprește pachetul". Moving into `la_porti` past the limit is refused (409). `blocata` → `in_lucru` with a note (or by Narcis on the PWA) raises `maxRounds` by one and cancels that decision if still pending; a gate run's verdict counts in the round it ran in, and a late one from an earlier round blocks nothing. `tasks_get` shows `round` and `maxRounds`.
- **Cost.** The hook passes `BB_TASK` and `BB_ROLE` (`lucrator`, `qa`, `poarta`, `coordonator`); new hook events carrying them are swept into **task_sessions** (role; unknown roles count as `lucrator`). The package's herdr-terminal session and its job's session count as `lucrator`. With linked sessions, `costUsd` is their sum, `costByRole` the split and `costManualUsd` the value set by hand.
- **Gates as runner jobs.** Settings → Factory holds per repo: the runner's machine, the main checkout, the recipe path (relative to the checkout), the worktree template, a port range, a database prefix, the first migration number and block size, and cleanup templates. `gates_run {taskId, gate, args?}` stores a **gate_run** and sends `{type: 'gate'}` to the runner (resent by `gates_status` while queued). The runner (`runner/gate.ts`) reads the recipe from the checkout (inside its allowed roots; never the worktree), runs the gate's argv steps without a shell, in the checkout, with `BB_TASK`, `BB_ROLE=poarta` and the package's values in the env, and placeholders `{id} {idLower} {worktree} {round} {port} {db} {recipeDir} {args}`. Step contract: exit 0 = pass (or skip), 1 = fail, anything else = error; the last stdout line is JSON `{verdict, summary, details?, findings?, shots?}`; the first failing step stops the gate. It reports to `POST /api/runner/gates/:id` (machine token, only the run's machine). A verdict is recorded with `gates_record` semantics (actor `runner:gate`); an error records nothing, so a broken runner never uses up a round. The runner keeps retrying its final report for 24 h; a run still `running` 6 h after it started becomes an error at the next `gates_status`. Screenshot paths are read only inside the runner's allowed roots, and a summary never falls back to log text. The log's last 256 KB stay on the server (`GET /api/gate-runs/:id/log`, web only); `gates_status` returns the state, verdict, summary, findings and gate result id, never the log.
- **Resources.** `tasks_claim` returns `resources {port, db, migrations: {from, to}}`: the lowest port of the range not held by another package of the repo that is not integrated, `<dbPrefix><id lower case>`, and the next migration block after every range and used number recorded for the repo. A package keeps them until `integrata`. `tasks_update` takes `migrationsUsed`. Integrating a package whose used numbers fall in another active package's range adds a `warning` event to that package (renumber) and a line to the digest; the move to `integrata` returns the cleanup list filled in.
- **Findings.** `gates_record` takes `findings: [{severity: blocker|major|minor, title, file?, line?, detail?, fix?}]`, stored as **findings** with status `open`. A later pass of the same gate marks that gate's open blockers and majors `fixed`; minors stay open. `findings_list {taskId?, status?, severity?}`, `findings_update {ids, status, note?}` (`open`, `fixed`, `deferred`, `for_architect`, `wontfix`), and `tasks_create {fromFindings}` builds the body section and one acceptance criterion per finding and marks them `deferred` to the new package (refused past 100 criteria or a 100 000-character body). The package page lists them; the backlog filters open minors across packages.
- **Digest** lists pending decisions with their age, and the warnings of the last 24 h.

### 11.8 Scheduled starts (decided 2026-11-19)

**Why.** A factory start set for 03:30 as a session-only cron inside an interactive Claude Code session died when Windows Update restarted the PC at 03:15; nothing started until a human noticed at 07:55. Buildyboy had no start time on a package; cron schedules fired only in their exact minute (and the server runs in WSL on the same PC, so the restart stopped it too); the governor refused every start on usage data older than 30 min, which is always the case at night; and the runner was a Scheduled Task at logon with nothing starting the WSL distro at boot. Everything is backward compatible: every new argument is optional and additive, and without them behaviour is unchanged.

1. **A package's start time.** `tasks.not_before` (epoch ms). `TaskSummary` gains `notBefore` and `notBeforeText` (formatted in the server's time zone). Set with `tasks_create` / `tasks_update` / the web PATCH of a task as ISO 8601 with an offset or `Z`, or epoch ms; `null` clears; a string without an offset is refused (400). **`notBefore` is a readiness condition, not a trigger:** `ready` is false while it is in the future (so `tasks_list {ready}`, `tasks_claim` without an id, `factory_status.ready` and the autopilot skip the package), and it is ready by itself once the time passes, so a restart just means "first chance after the time". `tasks_claim {id}` and an immediate launch of such a package answer 409 naming the time and how to clear it. `factory_status.line` lists gata packages whose time has not come with `waits: "start time <time>"`.
2. **Scheduled launches.** `tasks_launch` / `coordinator_launch` accept `notBefore` and `catchUpHours` (default 6, max 24) and return `{status: "scheduled", kind, scheduleId, notBefore, expiresAt, taskId, decisionId}` instead of starting; rows live in `scheduled_launches` (statuses `pending`, `starting`, `started`, `missed`, `cancelled`). **The same token permission and approval apply, asked at scheduling time** (the question names the start time). `expiresAt` defaults to `notBefore` + 6 h, at most 24 h. A server tick (every 15 s and once at server start) starts each due launch at the first chance when: the package is still gata (worker), the runner is online, for `hc` the runner is in a signed-in Windows session, no live session or job with the same title runs on that machine (coordinator), and the governor allows it (rule 4). Each failed check leaves it `pending` with the reason in `waits`. After `expiresAt` it never starts: `missed`, one push/ntfy notification, a `factory_status` alert and a digest line. A scheduled `tasks_launch` sets the package's `notBefore` to the same time (the package stays gata until the real start); cancelling leaves that start time. New tools `schedules_list {project?}` and `schedule_cancel {id}`; `factory_status.scheduled` lists the pending ones. Web: `GET /api/scheduled-launches?project=` (pending first, then those closed in the last 7 days; `ScheduledLaunchView` in `shared/factory.ts`) and `POST /api/scheduled-launches/:id/cancel` (409 when not pending).
3. **Cron catch-up.** `schedules.catch_up_minutes` (default 120, 0 = off, max 1440). At each tick and at server start, if the most recent matching minute after `last_run_at` is in the past and within the window, the schedule fires once (never more than once for several missed minutes, not at all outside the window); the job gets `caughtUp: true`. `GET /api/schedules` items carry `catchUpMinutes`; `POST /api/schedules` accepts it.
4. **Governor rule for scheduled starts only.** When the only reason for `canStart: false` is usage data older than `governor_max_age_min` (30), a scheduled launch may start if, for each window (5-hour, 7-day), either its `resetsAt` has passed since the last sample or its last known percentage is at least 10 points under its threshold (a window missing from the data keeps the rule of §11.3). The reason is "started on stale usage data: …" and it is audited. At most one such start per 30 min (the started session's statusline then refreshes the data). Unscheduled launches, `tasks_claim` and the autopilot keep the old rule.
5. **Runner capability.** The heartbeat reports `interactiveSession` (Windows: false when the runner runs in session 0, that is a Scheduled Task started at boot before anyone signed in; null off Windows); `machines_list` shows it. herdr-core's `hc` starts an interactive claude in a herdr terminal, which Buildyboy treats as needing a signed-in session (not verified without one), so a scheduled `hc` launch waits with "no signed-in Windows session on <machine> …"; `launcher: "claude"` (`claude -p`) works without one.

**Boot options (opt-in, `deploy/install.ps1`, elevated PowerShell).** Nothing changes unless asked for. Both register Scheduled Tasks as the current user with logon type S4U ("run whether user is logged on or not", no stored password), run level Limited:

- `-BootWsl` (`-WslDistro`, default `Ubuntu`; env `BB_BOOT_WSL`, `BB_WSL_DISTRO`) registers **Buildyboy WSL (boot)**: an AtStartup trigger repeating every 5 minutes indefinitely, `MultipleInstances IgnoreNew`, no time limit, running `wsl.exe -d <distro> --exec sleep infinity`. A running wsl process keeps the distro, systemd and `buildyboy.service` up (WSL stops a distro about 15 s after its last wsl process exits, so a one-shot start is not enough); the repetition brings it back if WSL was updated or shut down. Precedent on the owner's PC: a hand-made "WSL Ubuntu KeepAlive" task (`conhost --headless wsl.exe sleep infinity`, at logon and every 5 min, IgnoreNew) held WSL up; without a user at boot conhost is not needed.
- `-BootRunner` (env `BB_BOOT_RUNNER`) registers **Buildyboy Runner (boot)**: AtStartup, the same `node bb.ts runner` command, restart on failure. It runs in session 0 (see part 5). The at-logon `BuildyboyRunner` task is re-registered with a first action that stops the boot task (`Stop-ScheduledTask`, always exiting 0) so the signed-in runner takes over; ending it stops any `claude -p` job the boot runner was running, which the server marks lost.
- `BB_UNINSTALL` removes both tasks (a running keep-alive stays until the next restart). Without elevation the script prints how to rerun and installs nothing else differently.

**Limits (decided, not hidden).** After an unattended restart nobody is signed in unless auto-logon is configured: `claude -p` launches and the server work, `hc` launches wait until someone signs in or until their catch-up window ends (missed plus alert); unattended night starts should use `launcher: "claude"`. Auto-logon (Sysinternals Autologon, `netplwiz`) would make `hc` work but stores credentials and leaves an unlocked desktop session, so it is the owner's security decision and Buildyboy does not configure it. S4U tasks have no network credentials (no SMB shares) but do have internet; if S4U fails for the WSL task on some WSL versions, the fallback is "Run only when user is logged on" (starts at logon only) or a stored password. Windows Update can still shut WSL down during the day; the 5-minute repetition brings it back. Open points: `claude -p` credentials and `hc` in session 0 are not verified.

---

## 12. Projects and the line (decided 2026-11-16)

§11 was built for one project (arond): its coordinator instructions, gate scripts, reviewer prompts and conventions live in that repo, the backlog is one global board, and an LLM coordinator session does the bookkeeping. §12 makes the same way of working available to **any repo**, with less of the owner's attention and no coordinator tokens on the happy path:

- a **project** is a first-class thing that owns its packages, its config and its history (§12.1, §12.2);
- a repo describes its **line** in one small file, `factory.json`; the gates, QA, review, visual check, integration and cleanup come built in (**the kit**, §12.3, §12.4);
- a deterministic **conductor** in the server moves packages along the line; an LLM **foreman** is called only when judgment is needed (§12.5, §12.6);
- an **operator** agent (the owner's deputy, e.g. a phone bot) can do over MCP what the owner does in the PWA (§12.7);
- the plugin ships the **skills** that put a repo on the factory and plan its work (§12.8).

```
 owner / operator bot ──► projects · plan · decisions · autopilot            (PWA, MCP, HTTP)
                              │
 server: CONDUCTOR  claim → prepare → qa → build → G1 → G2 → G3 → G4 → G5 → cleanup     (no LLM)
                              │ step commands, job launches, hc send          ▲ reports, hook events
 runner: KIT steps (git worktree, commands from factory.json, claude -p verifiers) · workers in herdr terminals
                              └── FOREMAN (claude -p, structured answer) only for questions and stuck packages
```

Rules that hold everywhere: the server still never runs commands or reads repositories; the runner runs only what the trusted main checkout's `factory.json` says, plus the kit; everything in §11 keeps working (§12.10).

### 12.1 Projects

- **factory_projects**: `key` (primary key, `^[a-z][a-z0-9-]{1,23}$`, never changes), `name`, `repo` (`owner/name`, optional), `id_prefix` (`''` or `^[A-Z][A-Z0-9]{0,7}-$`, e.g. `ED-`), `machine_id` and `checkout` (where its line runs: the trusted main checkout on a paired machine), `line_file` (path relative to the checkout, default `factory.json`), `config_json` (operator overrides and, for projects that came from §11.7's repo config, the legacy fields), `line_json` / `line_seen_at` / `line_error` (the resolved line as the runner last reported it), `state` (`active`, `paused`, `archived`), `autopilot` (0/1), `created_at`, `updated_at`, `archived_at`.
- `tasks.project` references a project (null = no project: old data and one-off tasks). A package belongs to one project for life.
- **States.** `active`: normal. `paused`: nothing new starts (no claim, no launch, the conductor skips it); work in flight continues. `archived`: hidden from default lists, its packages are archived (§12.2), nothing can be claimed or launched; it can be unarchived.
- **Migration 009** turns every entry of the `factory_repos` setting into a project (key from the repo name, `id_prefix ''`, `line_file` = the old recipe path, `config_json` = the old fields), makes a project for every other distinct `tasks.repo`, and assigns existing tasks by repo. `factory_repos` is no longer read. Packages already `integrata` are stamped archived, so the board starts clean.
- **Who may change what.** `machine_id`, `checkout` and `line_file` decide what the runner executes, so only the owner (web) or an operator token (§12.7) may set them. Any agent token may read projects.
- **Web API**: `GET /api/factory/projects[?state=active|paused|archived|all]`, `POST /api/factory/projects`, `GET /api/factory/projects/:key`, `PUT /api/factory/projects/:key`, `POST /api/factory/projects/:key/{pause|resume|archive|unarchive|refresh|autopilot}`, `DELETE /api/factory/projects/:key` (only while it has no packages). The checkout-level `/api/projects` of §5 stays as it is; a factory project links to those checkouts through its repo (`gh_owner/gh_repo`).
- **ProjectView** (list and detail): the columns above plus `machineName`, `counts` per status over non-archived packages, `archived` (count), `integrated` (total ever), `costUsd` (sum over its packages), `openDecisions`, `attention` (packages waiting on the owner: blocked, or with a pending decision), `lastActivityAt`, `checkoutIds` (matching §5 projects). The detail adds `line` (packages in `in_lucru`/`la_porti`, with their stage) and `next` (ready packages).
- **Tools**: `projects_list {state?}`, `projects_get {key}` (read). `tasks_list`, `tasks_create`, `tasks_claim` take `project`; `tasks_claim` without it picks across active projects. `tasks_create` without `project` uses the project whose `repo` matches the given repo, else none.

### 12.2 Package ids and the archive

- Ids stay globally unique strings (`^[\w.-]{1,64}$`), so nothing that keys on a task id changes. A project with an `id_prefix` owns the ids that start with it: a package created in it with id `P1` is stored as `ED-P1`; one created without an id gets `ED-<n>` (n = the highest number it has used + 1). An id that already starts with the prefix is kept. `localId` is the id without the prefix. Dependencies given as local ids resolve inside the project first.
- **Placeholders** everywhere a template is filled (factory.json, cleanup): `{id}`, `{idLower}`, `{localId}`, `{localIdLower}`, `{project}`, `{round}`, `{port}`, `{db}`, `{worktree}`, `{branch}`.
- **Archive.** `tasks.archived_at`. Set by the owner or an operator (package page, "Archive done" on a project, `tasks_update {archived}`), by archiving the project, and by a background sweep that archives packages integrated more than `archive_done_after_hours` ago (setting, default 24; 0 turns the sweep off). Lists leave archived packages out unless asked (`GET /api/tasks?archived=1`, `tasks_list {archived: true}` return only archived ones); `tasks_get` and dependency checks are unaffected. Unarchive clears it.

### 12.3 `factory.json`: a repo's line

One JSON file in the main checkout, read and validated by the runner (`shared/line.ts`, one zod schema for the runner, the server and `bb line check`). Everything is optional; a repo with only `{"commands": {"verify": "npm test"}}` has a working line. The §11.7 recipe is a valid `factory.json` (its `gates.<G>.steps` replace the built-in step of that gate).

| Key | Default | Meaning |
|---|---|---|
| `base` | `main` | the branch packages are integrated into |
| `branch` | `pkg/{id}` | the package's branch |
| `worktree` | `../<checkout folder>-wt/{id}` | the package's worktree (relative to the checkout, or absolute); must be inside the runner's allowed roots |
| `shell` | platform shell | argv prefix that runs a command line, e.g. `["C:/Program Files/Git/bin/bash.exe", "-c"]` |
| `commands.setup` | none | after the worktree exists: install, create a database… |
| `commands.verify` | none | G1: typecheck, lint, tests. Without it G1 is off |
| `commands.acceptance` | none | G2: the package's acceptance tests. Without it G2 and QA are off |
| `commands.shots` | none | G4: writes screenshots to `paths.shots`. Without it G4 is off |
| `commands.app` | none | G4: starts the app for the visual judge (`app.url`, `app.readyPath`, `app.readyTimeoutSec` 180) |
| `commands.cleanup` | none | after integration: drop the database… |
| `paths.packages` | `factory/packages` | package specs (Markdown with frontmatter, §11.2) |
| `paths.acceptance` | `tests/acceptance/{localId}` | where QA writes; protected from the worker |
| `paths.shots` | `test-results/shots/{localId}` | screenshots for G4 (at most 12 are attached) |
| `paths.protected` | `[]` | more paths a worker may not change (`factory.json` and `paths.acceptance` always are) |
| `env`, `envFile` | `{}`, `.env.factory` | variables for every step and the worker, also written to this file in the worktree (kept out of git) |
| `resources` | none | `ports: [from, to]`, `dbPrefix`, `migrations: {from, block}`: what `tasks_claim` allocates (replaces the per-repo fields of §11.7; those remain the fallback) |
| `gates.G1…G5` | on when their command exists; G3 and G5 always | `enabled`, `timeoutSec`, `steps` (argv override); `G2.qa` (true), `G3.security` (`sensitive`, `always`, `never`), `G4.chrome` (false), `G5.push` (true) |
| `steps.prepare`, `.qa`, `.cleanup`, `.revert` | built in | `steps` (argv override), `timeoutSec` |
| `models` | worker, qa, review, foreman, planner: `opus`; visual: `sonnet` | the model per role |
| `worker` | `launcher: hc`, `permissionMode: auto`, `limitHours: 10`, `subagents: 4`, `chrome: false` | how a worker starts |
| `limits` | `workers: 2` | parallel packages of this project; `rounds` overrides `gate_max_rounds` |
| `integrate.approval` | `sensitive` | ask the owner before G5: `never`, `sensitive` (packages flagged sensitive), `always` |
| `context` | `["CLAUDE.md"]` | files every role reads first |

- Command lines run through the shell, in the worktree, with placeholders filled from validated values only (ids `[\w.-]`, numbers, paths the runner computed). They come from the main checkout, never from a worktree: a worker cannot change its own gates.
- A package that must change `factory.json` or another protected path asks first (the guard of §12.8 blocks the write; the worker raises it with its `question` status line), and such a change passes G5 only with the owner's approval (§12.5).
- The server keeps the resolved line the runner reports (`line_json`): with every `prepare`, and on demand (`{type: 'line'}` → `POST /api/runner/lines`, behind "Check setup" and `refresh`). Operator overrides in `config_json` (`limits.workers`, `limits.rounds`, `models.*`, `integrate.approval`) win over the file.

### 12.4 Steps: the kit in the runner

- A **step** is what a gate run already is (§11.7): the server stores a run and sends it to the project's runner; the runner executes and reports `running`, then one `done` (verdict, summary, details, findings, shots) or `error`. Runs of `prepare`, `qa`, `cleanup` and `revert` live in `gate_runs` too, but only G1–G5 make gate results and count in rounds. `steps_run {taskId, step, args?}` starts one; `gates_status` reports any run.
- For each run the runner reads the line file from the checkout and executes, in this order of preference: the line's argv `steps` for that gate or step (§11.7 contract, unchanged); else the **built-in** (`runner/kit/`); else an error. Commands carry what a built-in needs and the repo does not hold: the package (`id`, `localId`, title, body, acceptance criteria, sensitive, branch), its resources, and `files` to write under `<worktree>/.factory/` (never elsewhere).
- Built-ins (each returns the step contract; all stop leftover processes of the worktree and of the package's port before and after, because an orphaned dev server gives false failures):
  - **prepare**: fetch; create the worktree and branch from `origin/<base>` (reuse them when they exist); write `envFile` and `.factory/` (`package.md`, `brief.md`, `guard.json`) and keep them out of git (`.git/info/exclude`); run `commands.setup`. Reports the resolved line.
  - **qa** (when G2 is on and `G2.qa`): `claude -p` in the worktree with `BB_ROLE=qa`, the kit's QA instructions and `factory/qa.md` if the repo has one: black-box acceptance tests in `paths.acceptance`, one per criterion, written before the code; then commit and the local tag `bb-acceptance/<id>`. Fails when no test file was added.
  - **G1**: `commands.verify`. Summary: the last result lines and the first error lines.
  - **G2**: fail when `paths.acceptance` differs from the tag or the branch touched other packages' acceptance tests; then `commands.acceptance`. A `MANUAL.md` there is named in the summary for the owner.
  - **G3**: `claude -p` in the worktree, read-only (`Read`, `Grep`, `Glob`, `git diff|log|show`), `--json-schema`, the kit's review prompt plus `factory/review.md`; a second pass with a security focus when `G3.security` asks for it; retried once without `structured_output`. From round 2 the prompt lists the earlier open findings, so the reviewer checks the fixes first. Findings: blocker, major, minor; fail on any blocker or major.
  - **G4**: `commands.shots`, start `commands.app`, wait for `app.readyPath`, then a `claude -p` judge (`--chrome` when `G4.chrome`) with the kit's visual prompt plus `factory/visual.md`; stop the app; attach up to 12 screenshots. `skip` when the package produced no screenshots.
  - **G5**: in the worktree merge `origin/<base>` (a conflict is a `fail` with the files, and the merge is aborted); G1 and G2 again on the result; then in the checkout fast-forward `<base>` to the branch and push both (`G5.push`). The summary holds `<old>..<new>`. Refuses (error `needs approval: …`) when protected paths changed and the run lacks `--allow-protected`.
  - **cleanup**: only when the branch is in `origin/<base>`: end the package's herdr terminal (`bb-<id>`, label `owner=buildyboy`), remove the worktree and the local branch, run `commands.cleanup`.
  - **revert**: `git revert` of the G5 range on `<base>`, G1, push.
- Verifier sessions run with `BB_TASK` and `BB_ROLE` (`qa`, `poarta`), an explicit `--permission-mode`, a turn limit and a budget; their cost lands on the package (§11.7).
- **herdr.** The runner gains two checked `hc` commands, for terminals it started only (name `bb-…`, label `owner=buildyboy`): `send` (a short line; long text is written to `.factory/inbox/<n>.md` first and the line points at it) and `kill`. `{type: 'hc', id, op, name, text?, files?}` → `POST /api/runner/hc/:id`.
- The runner reports `version`; the server refuses built-in steps on a runner older than 0.2.0 with a message that says to restart `bb runner`.

### 12.5 The conductor (autopilot)

`server/factory/line.ts`. For each project with `autopilot` on and state `active`, on every relevant event (package, run, job, session or decision changed; runner connected) and every 20 s, it advances that project's packages. It only reads the database and sends commands; every transition is a `task_events` row (`line`), so the package page shows what happened and why. State survives restarts: `tasks.stage` and `tasks.line_json` (`{waiting, runId?, jobId?, attempts, since, note?}`).

| Stage | Status | What the conductor does |
|---|---|---|
| (ready) | `gata` | Governor `canStart`, runner online, fewer than `limits.workers` packages of the project in flight: `tasks_claim` it (resources allocated) → `prepare` |
| `prepare` | `in_lucru` | step `prepare`, with the package and the worker brief as files → `qa` or `build` |
| `qa` | `in_lucru` | step `qa` → `build` |
| `build` | `in_lucru` | launch the worker (§11.4: `hc` terminal `bb-<id>` or `claude -p`), then wait for its turn to end and read the **status line** |
| `G1`…`G4` | `la_porti` | each enabled gate in order; pass or skip → next; fail → open blockers and majors back to the worker → `build`; after the last one → `G5` |
| `G5` | `la_porti` | ask the owner first when `integrate.approval` says so or protected paths changed; pass → `integrata` → `cleanup`; fail → findings to the worker → `build` |
| `cleanup` | `integrata` | step `cleanup`; the package leaves the line |

- **The worker's status line.** The brief asks the worker to end every final message with one line: `FACTORY-STATUS: done`, `FACTORY-STATUS: question <text>` or `FACTORY-STATUS: blocked <text>`. The conductor reads it from the Stop event's `last_assistant_message` (or the job's result). `done` → `la_porti` (a new round, §11.7) and the gates. `question` → the foreman (§12.6). `blocked` → the foreman. No status line → one nudge asking for it, then the foreman. A worker whose session or terminal ended without `done` is started again once ("resume from PROGRESS.md"); the second time the package needs attention.
- **Telling a worker something** (findings, answers, stop): a live herdr terminal gets `hc send`; a headless worker gets a new job that resumes its session. Findings travel as a file in `.factory/inbox/`.
- **The brief** is composed by the server: the harness template (§5.4) with Goal, Done when (the line's commands), Scope (the worktree; protected paths read-only), Limit, Subagents, Branch `current`, PR and Unattended from the line; then the package (body, criteria, resources); then the kit's worker rules (who you are, read `context` and `factory/worker.md`, never touch acceptance tests or the line file, commit small and push the branch, never merge, the status line). It is saved in the prompt library (§11.1 `prompts_save` semantics) and written to `.factory/brief.md`; the launch line only says to read it.
- **Errors.** A step that ends in `error` (no verdict) is retried once after a minute; a second error needs attention. So does a worker past `worker.limitHours`.
- **Needs attention** = one decision tied to the package (`asked_by factory:line`) with what happened and the options that apply: Retry, Ask the foreman, Stop the package, I'll take it from here (the conductor leaves the package alone until its status changes by hand). The conductor acts on the answer; it also acts on the round-limit decision of §11.7 (one more round → back to `build` with the findings; stop → stop).
- **Controls** (§11.5). `stop`: tell the worker to commit, push and stop; then `hc kill`; `blocata`; ack. `revert`: step `revert`; back to `backlog` (not `gata`: with autopilot on it would be built again at once; the owner decides); ack.
- **Governor.** `canStart: false`: nothing new is claimed and no worker is launched; packages in flight go on. `stopAll`: also no step that spends tokens (`qa`, G3, G4, foreman) and each active worker is told once to commit, push, update PROGRESS.md and wait; when it clears they are told to resume.
- **By hand.** With autopilot off nothing here runs: a coordinator session (§11) or the owner drives the same tools (`tasks_claim`, `steps_run`, `tasks_launch`, `gates_run`, `tasks_update`). A package moved by hand while autopilot is on is picked up from its new status.

### 12.6 The foreman and the planner

Both are `claude -p` jobs on the project's runner, in the main checkout, read-only, with a structured answer (`outputSchema`), a turn limit and a budget. Their sessions count as role `coordonator`.

- **Foreman** (`models.foreman`; `null` turns it off, and everything goes to the owner). Input: the package, what the worker asked or why it is stuck, the last gate summaries. Answer: `{action: 'answer' | 'retry' | 'escalate' | 'block', message, question?, options?}`. `answer`: the message goes to the worker. `retry`: the failed step runs again. `escalate`: a decision for the owner with its question and options; the worker is told to go on with what does not depend on it. `block`: `blocata` with the reason. It answers what is technical and inside the package's spec; anything that changes scope, a recorded decision, an acceptance criterion or touches production is escalated.
- **Planner.** `plan_request {project, goal, notes?}` (owner or operator) starts it with the goal; it reads the repo and answers `{summary, packages: [{localId, title, body, acceptance[], dependsOn[], sensitive, priority}], questions[]}`. The packages are created in `backlog` as one **plan** (`tasks.plan_id`), and one decision asks: Approve (all become `gata`), Discard (deleted), or edit them first in the PWA. With autopilot on, an approved plan starts by itself.

### 12.7 Operators

An agent token may be made an **operator** (Settings → Factory → Agent tokens, off by default, like launching in §11.1): it acts for the owner. Each such action is audited as `agent:<name>` and listed in the digest ("answered by operators").

- `agent_tokens.operator` (0/1): may answer decisions, ask for stop or revert, create and change projects (including `checkout`, `line_file`, autopilot, pause, archive), archive packages, request plans.
- `agent_tokens.inbox` (0/1, separate): may answer the Inbox's pending actions (permissions, questions, plans, turn-end replies) of sessions in walk mode.
- A token can never answer a decision it asked itself, and no agent can answer a launch approval (§11.1): the owner removes the need for it per token instead.
- **Tools** (reads for every token; writes need the scope):
  - `factory_status {project?}`: one compact answer made for small contexts: governor, alerts (runner offline, usage data stale, autopilot held), per active project its autopilot state, counts, packages on the line (`id`, title, stage, round, what it waits for, since when), ready packages, and everything waiting on the owner (pending decisions with id, question, options, age; open controls; inbox count).
  - `decisions_list {status?, project?, limit?}`, `decision_answer {id, answer}`, `decision_cancel {id}`.
  - `control_request {taskId, kind: stop | revert, note?}`.
  - `projects_save {key, …}` (create or change), `projects_set {key, autopilot?, state?}`.
  - `plan_request` (§12.6); `tasks_update {archived}` (§12.2).
  - `inbox_list`, `inbox_answer {id, …}` (scope `inbox`).
- `docs_get {topic: 'operator'}`: the operator's guide: the loop (`factory_status` → answer what waits → plan or adjust → come back later), what each answer does, and what an operator must leave to the owner.

### 12.8 The plugin: skills and the guard

- **Skills** (`plugin/skills/<name>/SKILL.md`, invoked as `/buildyboy:<name>`):
  - `factory-init`: put this repo on the factory. Reads the repo (scripts, tests, stack), proposes `factory.json`, checks it with `bb line check`, scaffolds `factory/packages/` with a spec template, and registers the project (`projects_save`, or a link to the PWA form with the fields filled when the token is not an operator).
  - `factory-plan`: turn a goal or a spec into package files under `paths.packages` (scope, sources, deliverables, acceptance criteria that a black-box test can check, dependencies), then import them (`bb tasks import --project`).
  - `factory-foreman`: drive a project by hand as its coordinator with the kit (`tasks_claim`, `steps_run`, `tasks_launch`, `gates_run`…): for autopilot-off projects and for supervising.
  - `factory-status`: what the factory is doing and what waits on the owner (`factory_status`).
- **Guard** (`plugin/hooks/bb-guard.mjs`, PreToolUse on `Write|Edit|MultiEdit|NotebookEdit`): in a session with `BB_TASK` whose worktree has `.factory/guard.json`, a write to a protected path is denied with the reason, unless `BB_ROLE` is `qa` and the path is the acceptance folder. It fails open and is defence in depth: G2 and G5 are what decide.
- `bb line check [dir]` validates a `factory.json` and prints the resolved line; `bb tasks import --project <key>` imports into a project.

### 12.9 PWA

- **Projects** (`/projects`): factory projects first (active, then paused; archived behind a toggle), each card with its autopilot state, a progress bar (integrated of all), what is in flight, what waits on the owner, cost and last activity; then the repositories seen by telemetry that have no factory project, each with **Put on the factory**.
- **Project page** (`/projects/:key`): header with the autopilot switch, Pause, Archive and Plan new work; tabs **Line** (packages in flight with a stage stepper, the worker's lamp and what each waits for; pending decisions; next ready packages), **Backlog** (this project's board), **Done** (the archive: integrated packages with date, rounds, cost and duration, and "Archive done"), **Activity** (the sessions, pull requests, commits and cost of its checkouts, as §5 shows them today), **Setup** (machine, checkout, line file, the resolved line with "Check setup", overrides).
- **Backlog** (`/backlog`): a project switcher on top (all active projects, or one); only non-archived packages, so the Integrată column holds what landed in the last day; a link to each project's archive.
- The package page shows the stage and the line's history; Settings → Factory keeps the global values (gate rounds, archive delay, agent tokens with their launch, operator and inbox switches).

### 12.10 Compatibility

- Every §11 tool keeps its arguments and result shape; new fields are additive. A project migrated from `factory_repos` keeps running its recipe gates exactly as before, with autopilot off, until it adds `commands` to its line file.
- arond: project `arond`, `id_prefix ''`, ids unchanged (`P8a`), `line_file fabrica/porti/porti.json`.

### 12.11 Build order

1. Projects, ids and the archive on the server (§12.1, §12.2). 2. In parallel: the PWA (§12.9); the line file, the kit and the runner (§12.3, §12.4); operators (§12.7). 3. The conductor, the foreman and the planner (§12.5, §12.6). 4. The plugin's skills and guard, the manual, the agent docs (§12.8).
