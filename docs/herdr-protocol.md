# Buildyboy × herdr working protocol

How Buildyboy and herdr (`hc`, herdr-core) work together in the factory, what each side does, and who can start a
herdr terminal from where. Normative details live in SPEC §11 (especially §11.4); this page is the overview.

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

### Only two commands

The runner executes exactly these, as an argv with no shell:

| Command | When | Timeout |
|---|---|---|
| `hc ls --json` | every `hcPollSeconds` (default 15 s) | 10 s |
| `hc run --bg --json …` | a job with `launcher: 'hc'` | 30 s |

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
| An external AI agent through Buildyboy | `bb mcp` or HTTP `/mcp` with an agent token | **No** |

### herdr on its own

herdr opens no network port. It reaches other machines through ssh, or through any command given with `--via`
(for example `--via 'wsl.exe -d Ubuntu -e sh -c' --name wsl`). `hc connect` speaks herdr's API over stdin/stdout,
for app builders (`hc schema` prints it as JSON Schema).

### Why an external agent can't launch through Buildyboy

- `POST /api/tasks/:id/launch`, `POST /api/jobs` and `/api/jobs/fanout` require a web session (`requireWeb`). An
  agent token is refused.
- None of the agent tools, in `bb mcp` or the HTTP `/mcp` endpoint, launch a job or a terminal. They cover tasks,
  gates, decisions, control, the governor, findings, prompts, the digest, sessions and usage.
- `gates_run` runs a gate's argv steps on the runner, but only from the recipe in the repo's main checkout. It is not
  a way to start terminals.

So today an agent starts terminals only by running `hc` itself, on a machine where it already runs.

## 6. Possible extension: `tasks_launch` for agents

If remote agents should be able to start workers through Buildyboy:

- **One tool, same path.** Add an agent tool `tasks_launch {taskId, machineId, cwd, launcher?, model?,
  maxBudgetUsd?}` that reuses the launch route's logic. That keeps the allowed-roots check, the checked argv and the
  claim on the package.
- **Off by default.** Turn it on per agent token or with a setting (for example `agent_launch_enabled`).
- **Optional approval.** It could first ask Narcis through `decision_ask` and launch only after approval.
- **Respect the governor.** Refuse while `governor_get` says no.
- **Audit it.** Record each launch as `agent:<name>`, like the other agent writes.

## 7. Settings and env, at a glance

| Name | Where | Meaning |
|---|---|---|
| `hcPath` | `~/.buildyboy/runner.json` | path to `hc`, or `off` |
| `hcPollSeconds` | `~/.buildyboy/runner.json` | how often to report `hc ls` (default 15) |
| `BUILDYBOY_HC` | runner env | overrides `hcPath`; `off` disables |
| `HC_TERMINAL_ID` | set by herdr in its terminals | forwarded by the hook; links session ↔ terminal |
| `BB_TASK`, `BB_ROLE` | worker / gate env | links sessions to a package and a cost role |
| `~/.config/herdr-core/config.toml` | herdr | herdr's own settings (`notes`, `shell`, `draft_wait`, `wait_timeout`) |
