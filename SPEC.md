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
  - a few allowlisted environment variables. These are the entrypoint or source variable, `CLAUDE_PROJECT_DIR`, `TERM_PROGRAM` and `BUILDYBOY_JOB_ID`. **Never send the whole environment.**
- **Git enrichment.** Do it only on SessionStart, Stop, SessionEnd, and PostToolUse of a Bash call that ran `git`/`gh`. Each command has a 1.5 s timeout and git errors are ignored. Collect:
  - branch, HEAD sha, upstream ahead and behind, dirty file count, remote URL (credentials stripped), repo root, whether it is a worktree;
  - at Stop, `git diff --shortstat` against the session's start sha;
  - for `gh pr create` output, the PR URL.
- **Transcript deltas.** Keep a byte offset per session in `~/.buildyboy/offsets/<session>.json`. On PostToolUse, Stop, SubagentStop, PreCompact and SessionEnd, send the new JSONL lines, capped at 256 KB per call; any remainder goes on the next call.
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
- **projects:** id, machine_id, root_path, name, git_remote, gh_owner, gh_repo, default_branch. A project is unique on (machine_id, root_path).
- **sessions:** id (Claude session_id), machine_id, project_id, cwd, source (cli, desktop, headless, bg, sdk, unknown), name, model, effort, permission_mode, transcript_path, parent_session_id (resume or fork), job_id, status, status_reason, started_at, last_event_at, ended_at, end_reason. Totals: cost_usd, tokens (input, output, cache_read, cache_write), context_pct. Git: lines_added, lines_removed, git_branch, start_sha, end_sha. Also walk_mode and remote_control.
  - **status** is one of `working`, `waiting` (on me), `idle` (turn ended, awaiting prompt), `compacting`, `stale` (no event for 10 min while working), `ended` and `error`.
- **events:** id, session_id, agent_id, ts, event, tool_name, tool_use_id, summary, payload_json. This is the raw append-only log. Index it on (session_id, ts).
- **messages:** uuid, session_id, parent_uuid, agent_id, role, kind, ts, model, text, content_json, usage_json, is_sidechain. Parsed from transcript deltas, deduplicated by uuid.
- **tool_calls:** tool_use_id, session_id, agent_id, tool_name, mcp_server, input_json, output_text (truncated to 64 KB, with a full-length counter), status (ok, error, denied, interrupted, running), started_at, ended_at, duration_ms, file_path, command, exit_code.
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
- **Machine token:** `POST /api/ingest` (batch of envelopes, idempotent by an event hash), `POST /api/hook/:event` (sync control; may long-poll), `POST /v1/metrics`, `POST /v1/logs` (OTLP http/json), `POST /api/statusline`, `GET /api/runner/stream` (SSE jobs and control), `POST /api/runner/jobs/:id/events`.
- **Web (cookie):**
  - Sessions: `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/timeline?cursor=`.
  - Live: `GET /api/stream` (SSE; topics floor, session:<id>, inbox).
  - Inbox: `GET /api/inbox`, `POST /api/actions/:id/answer`.
  - Session control: `POST /api/sessions/:id/messages`, `POST /api/sessions/:id/{stop,pause,resume,walk}`.
  - Prompts and templates: `GET|POST|PUT /api/prompts…`, `GET /api/templates`.
  - Jobs: `POST /api/jobs`, `POST /api/jobs/:id/{stop,message,resume,verify}`.
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
- Running Claude on the server itself (the server never executes Claude or shell commands).
- Editing code in the browser.
