# Buildyboy × herdr working protocol

How Buildyboy and herdr (`hc`, herdr-core) work together in the factory, what each side does, and who can start a
herdr terminal from where. Normative details live in SPEC §11 (especially §11.4) and §12.4–§12.5; this page is the overview.

Checked against herdr-core **0.1.21** (`%LOCALAPPDATA%\Programs\herdr-core\hc.exe`) on 2026-11-14.

## 1. Roles

The link is one way: **Buildyboy uses herdr; herdr knows nothing about Buildyboy.**

| Side | Job |
|---|---|
| **herdr** | Runs the work: terminals that stay alive, the coordinator, the workers. |
| **Buildyboy** | Holds the memory and the view: backlog, usage and governor, gates, decisions, digest, the phone UI. |
| **Buildyboy runner** | The only Buildyboy part that runs `hc`, on its own machine. The server never runs `hc`. |

```
 Narcis (phone) ──► Buildyboy: backlog · usage 5h/7d · governor · gates · decisions · digest
                         ▲ MCP (bb mcp / HTTP /mcp, agent token)   ▲ hooks + statusline bridge
 hc terminal: COORDINATOR ── hc run/wait/send ──► WORKERS (interactive claude, a worktree each)
                         └── claude -p --json-schema ──► VERIFIERS (review, QA, visual)
```

The factory (decided 2026-11-07, used for the arond project):

- A **coordinator** Claude Code session runs in a herdr terminal. It decides what runs next.
- It starts interactive **workers**, one worktree per package, with `hc run --bg`, and drives them with
  `hc wait`, `hc send` and `hc read`.
- It runs short `claude -p` **verifiers** and integrates packages that pass the gates.
- It talks to Buildyboy through the MCP tools (`tasks_claim`, `tasks_update`, `gates_run`, `decision_ask`, …).

## 2. What the runner does with `hc`

Code: `runner/herdr.ts`, `runner/main.ts`, `runner/options.ts`, `runner/config.ts`.

### Finding `hc`

In order: `BUILDYBOY_HC`, then `hcPath` in `~/.buildyboy/runner.json`, then herdr-core's default Windows install
(`%LOCALAPPDATA%\Programs\herdr-core\hc.exe`), then `PATH`. Setting either one to `off` (or `none`, `false`, `0`)
turns the integration off. `bb doctor` reports whether `hc` was found.

### The commands it runs

The runner executes exactly these, each as an argv with no shell:

| Command | When | Timeout |
|---|---|---|
| `hc ls --json` | every `hcPollSeconds` (default 15 s) | 10 s |
| `hc run --bg --json …` | a job with `launcher: 'hc'` | 30 s |
| `hc get <name> --json` | before every `send` and `kill`: the check below | 15 s |
| `hc send --json [--if idle\|working] <name> <line>` | a `{type: 'hc', op: 'send'}` command (runner 0.2.0+, SPEC §12.4) | 60 s |
| `hc kill --json <name>` | a `{type: 'hc', op: 'kill'}` command, and the kit's `cleanup` step | 30 s |

**Only its own terminals.** `send` and `kill` act on a terminal only when all of these hold, else the command is
refused with the reason and nothing runs: the name matches `^bb-[a-z0-9_-]{1,29}$` (the names the runner gives:
`bb-<package id in lower case>`, `bb-coord-<job>`); `hc get <name>` answers that same name; and the terminal carries
the label `owner=buildyboy`. The owner's own herdr terminals never match.

**Long messages go through a file.** `send` takes one short line (at most 500 characters). Longer or multi-line text,
and any `files` sent with it, are written first under the terminal's working folder, in `.factory/inbox/<n>.md` (the
folder must be inside the runner's allowed roots), and the line sent is `Read .factory/inbox/<n>.md: a message from
the factory. Act on it, then go on.` A line that starts with `-` is prefixed so it is never read as a flag.

The server sends these as `{type: 'hc', id, op, name, text?, if?, files?}` and the runner answers
`POST /api/runner/hc/:id` with `done` (`{sent, inbox?}` or `{killed}`) or `error`.

### Reporting terminals

Each `hc ls` result goes to `POST /api/runner/terminals` (machine token) with `takenAt`, the runner clock when `hc ls`
ran. Per terminal the server keeps: address, name, agent, cwd, state, status, turn, where. It replaces that
machine's rows in `hc_terminals`. The Floor shows rows seen in the last 2 minutes (`TERMINAL_FRESH_MS`).

## 3. Linking terminals, sessions and packages

- **Terminal → session.** The Buildyboy hook forwards herdr's `HC_TERMINAL_ID` (env allowlist, SPEC §3.1). Ingest
  stores it as `sessions.hc_terminal` (`server/ingest/derive.ts`). It must match `^[\w./-]{1,64}$`.
- **Terminal → package.** Terminals Buildyboy starts are named `bb-<task id>`, so `hc ls` links them back by
  name. A package's `tasks.terminal` is matched on the machine of its job or session, because hc numbers terminals
  per machine.
- **Session → package.** When a worker's `SessionStart` arrives from a terminal that a package in `in_lucru` or
  `la_porti` names, that session becomes the package's session.
- **Cost.** `BB_TASK` and `BB_ROLE` in the hook env put sessions into `task_sessions`. The package's
  herdr-terminal session counts as role `lucrator`.

### Closed terminals end their sessions

A session killed with its terminal (`hc kill`, `hc rm`, a closed window) sends no `SessionEnd`. So a session linked
to a terminal of that machine:

- whose terminal is reported `finished` or is missing from the list, **and**
- whose last event is older than the report's `takenAt`

becomes `ended` with end reason `terminal closed`, and its running tool calls become `interrupted`. `box/t7` and
`t7` count as the same terminal; when unsure, the session stays open. If such a session sends another event, it is
reopened. There is no time-based rule.

## 4. Launching a package into a herdr terminal

From the package page (`LaunchTask`), `POST /api/tasks/:id/launch`:

```json
{ "machineId": "…", "cwd": "C:\\newme\\arond-wt\\t12", "launcher": "hc",
  "promptId": null, "model": null, "permissionMode": null, "maxBudgetUsd": 5 }
```

1. The server refuses a package that is already `integrata` (409) and a `cwd` outside the runner's allowed roots (400).
2. The prompt is the package's own prompt, or one built from its title, body and acceptance criteria.
3. It creates a job and **claims the package** (`in_lucru`) at once, so `tasks_claim` won't give it to another
   worker.
4. The runner turns the job into:
   ```
   hc run --bg --json --name bb-<task> --cwd <dir> --label owner=buildyboy --label bb.task=<id> … claude …
   ```
   `claude` is resolved to its real executable (never a `.cmd` shim); hc passes arguments through unchanged.
5. On success the job ends `succeeded` with `{ launcher: 'hc', terminal, name }`. A launch that fails before any
   terminal or session exists hands the package back to its earlier status.

`launcher: 'claude'` runs a normal headless `claude -p` job instead.

## 5. Who can start a herdr terminal, and from where

| Who | How | Today |
|---|---|---|
| Anyone with a shell on the machine | `hc run --bg claude` | Yes |
| The coordinator (an agent in a herdr terminal) | `hc run --bg …` on its own machine | Yes, the normal factory path |
| Another machine, through herdr | `hc machine add <ssh-target>`, then `hc run --on <machine> --bg …` (address `machine/t7`); or `ssh box hc run …` / `ssh box hc connect` | Yes, over ssh or a `--via` command. No machines are registered yet (`hc machine ls` → `[]`) |
| Narcis, from the phone or browser | Package launch with `launcher: 'hc'` on any machine that runs a runner and has `hc` | Yes (web login) |
| An external AI agent through Buildyboy | `tasks_launch` / `coordinator_launch` over `bb mcp` or HTTP `/mcp`, with an agent token | Only when Narcis allows that token (off by default) |

### herdr on its own

herdr opens no network port. It reaches other machines through ssh, or through any command given with `--via`
(for example `--via 'wsl.exe -d Ubuntu -e sh -c' --name wsl`). `hc connect` speaks herdr's API over stdin/stdout,
for app builders (`hc schema` prints it as JSON Schema).

### Agents launching through Buildyboy

`POST /api/tasks/:id/launch`, `POST /api/jobs` and `/api/jobs/fanout` still require a web session. Agents launch
through two tools that share the launch route's code (`server/factory/launch.ts`), so they get the same
allowed-roots check, checked argv and claim on the package:

- `tasks_launch {taskId, machineId, cwd, launcher?, model?, permissionMode?, maxBudgetUsd?, promptId?}` starts a
  worker for a package, exactly as the package page does.
- `coordinator_launch {machineId, cwd, …, prompt?, promptId?, title?}` starts a coordinator: terminal
  `bb-coord-<job>`, label `bb.role=coordonator`, the built-in coordinator prompt unless it gets its own. The machine
  needs the buildyboy MCP server registered for Claude Code so the new coordinator has the tools.
- `machines_list` gives the `machineId`s, whether their runner is online, and their allowed roots.

The rules:

- **Off by default, per token.** Settings → Factory → Agent tokens → *May launch*: Nothing, Workers, or Workers and
  coordinators (`PUT /api/agent-tokens/:id {launch, launchApproval}`). Otherwise 403.
- **Approval.** *Ask me before each launch* (on by default): the first call opens a decision (Launch / Refuse) and
  answers `pending_approval`; the same call again answers the same until Narcis replies; after **Launch** the next
  identical call starts it. One approval, one launch, valid 24 hours. Refused or cancelled → `refused`.
- **Governor.** Refused (409) while `governor_get` says `canStart: false`, checked before asking and again at launch.
- **Checks first.** A launch that would fail anyway (outside the allowed roots, unknown machine, bad option) is refused
  before Narcis is asked.
- **Audit.** `task_launch` / `coordinator_launch` as `agent:<name>` (with the decision id), plus
  `launch_approval_asked` and `launch_refused`.

`gates_run` and `steps_run` run a project's line (its `factory.json` in the main checkout: argv steps or the kit's
built-ins): they are not a way to start terminals. The kit's `cleanup` step ends the package's terminal `bb-<id>` with
the checked `kill` above.

## 6. How the conductor uses terminals

With a project's autopilot on, the server's conductor (SPEC §12.5) drives its packages and never runs `hc` itself:
it sends commands to the project's runner.

- **Start.** At the `build` stage it launches the worker as in §4, with `launcher` from the line's `worker.launcher`
  (default `hc`): terminal `bb-<id>`, labels `owner=buildyboy` and `bb.task=<id>`, in the package's worktree. The launch
  line only says to read `.factory/brief.md`, which the `prepare` step wrote.
- **Listen.** It learns that a worker's turn ended from the hooks (the Stop event's `last_assistant_message`, linked to
  the package through the terminal), and reads the worker's status line: `FACTORY-STATUS: done`, `question <text>` or
  `blocked <text>`. `hc wait` and `hc read` are not used.
- **Tell.** Findings after a failed gate, the foreman's answers, a nudge for a missing status line, and the governor's
  "commit, push and wait" go to a live terminal with the checked `send` (findings travel as a file in
  `.factory/inbox/`). A headless worker (`launcher: claude`) gets a new job that resumes its session instead.
- **Stop.** A stop request tells the worker to commit, push and stop, then ends its terminal with the checked `kill`.
  After integration the `cleanup` step ends it too.
- **Gone.** A worker whose terminal closed without `done` (see "Closed terminals end their sessions") is started again
  once in the same worktree; the second time the package needs the owner's attention.

A coordinator driving a project by hand (autopilot off) keeps using `hc` directly on its own machine; it should give
the terminals it starts the same name and labels, so the runner can still `send` to them and `cleanup` can end them.

## 7. Settings and env, at a glance

| Name | Where | Meaning |
|---|---|---|
| `hcPath` | `~/.buildyboy/runner.json` | path to `hc`, or `off` |
| `hcPollSeconds` | `~/.buildyboy/runner.json` | how often to report `hc ls` (default 15) |
| `BUILDYBOY_HC` | runner env | overrides `hcPath`; `off` disables |
| `HC_TERMINAL_ID` | set by herdr in its terminals | forwarded by the hook; links session ↔ terminal |
| `BB_TASK`, `BB_ROLE` | worker / gate env | links sessions to a package and a cost role |
| `~/.config/herdr-core/config.toml` | herdr | herdr's own settings (`notes`, `shell`, `draft_wait`, `wait_timeout`) |
