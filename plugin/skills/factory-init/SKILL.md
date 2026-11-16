---
name: factory-init
description: Put the current repository on the Buildyboy factory. Inspects the repo (package manager, scripts, tests, e2e, how the app starts, CI, CLAUDE.md), proposes a minimal factory.json and checks it with `bb line check`, scaffolds factory/packages/ with a package spec template, git-ignores the factory's files, and registers the project with Buildyboy. Use it once per repo, when the owner says "put this repo on the factory", "set up the factory here" or "factory init".
argument-hint: "[project key]"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, mcp__buildyboy__projects_list, mcp__buildyboy__projects_get, mcp__buildyboy__machines_list
---

# Put this repository on the factory

You set up this repository so the Buildyboy factory can build packages in it unattended: workers in their own
worktrees, acceptance tests written first, gates G1–G5, integration into the base branch. The repo describes its
**line** in one file, `factory.json`; everything else (QA, review, visual check, merge, cleanup) is built into the
factory's kit. Your job is to write the smallest correct `factory.json`, the package folder and the template, and to
register the project. You change nothing else in the repo. Project key asked for: `$ARGUMENTS` (empty: derive it).

Work in this order and **stop and ask the owner** wherever a step says so. Show what you will write before you write it.

## 1. Preconditions

1. `git rev-parse --show-toplevel`: you must be at the top of a git repository, in its **main checkout** (not a linked
   worktree: `git rev-parse --git-dir` and `--git-common-dir` must be the same folder). The factory runs its line from
   this trusted checkout. If it is a worktree, stop and say so.
2. `git status --short`: note uncommitted changes; you will only add files, never touch theirs.
3. Check that the Buildyboy MCP tools are in this session (`mcp__buildyboy__projects_list` and friends). If they are
   not, you can still do steps 2–6; for step 7 tell the owner how to connect, then use the PWA link:
   > Create an agent token in Buildyboy (Settings → Factory → Agent tokens), then run
   > `claude mcp add --transport http buildyboy https://<server>/mcp --header "Authorization: Bearer bba_…" --scope user`
   > and start a new Claude Code session. On a machine with a Buildyboy checkout,
   > `claude mcp add buildyboy --scope user -e BUILDYBOY_URL=https://<server> -e BUILDYBOY_AGENT_TOKEN=bba_… -- node <checkout>/cli/bb.ts mcp`
   > adds an offline queue.
4. Read `~/.buildyboy/config.json` (`url` = the server, `machineId` = this machine) and `~/.buildyboy/runner.json`
   (`allowedRoots`). No config: the machine is not paired; tell the owner to pair it (Machines → Pair a machine in the
   app) and stop at step 7.
5. If `factory.json` already exists, this is a review, not a creation: check it (step 5) and only propose changes.

## 2. Read the repository

Find facts, never guess. Note for each the file that proves it.

- **Package manager and scripts**: `package.json` scripts and the lock file (`package-lock.json` → npm,
  `pnpm-lock.yaml` → pnpm, `yarn.lock`, `bun.lock*`), `pyproject.toml`/`uv.lock`/`poetry.lock`, `Cargo.toml`,
  `go.mod`, `Makefile`/`justfile`, `composer.json`, `Gemfile`, `*.csproj`/`*.sln`.
- **Checks**: typecheck, lint and unit tests, and the single command that runs them. **CI config**
  (`.github/workflows/*.yml`, `.gitlab-ci.yml`, …) is the best source: the factory's G1 should run what CI runs.
- **End-to-end / black-box tests**: Playwright (`playwright.config.*`), Cypress, an HTTP test suite, CLI tests. Whether
  one command can run the tests of one folder (`npx playwright test <dir>`, `pytest <dir>`, `go test ./<dir>/...`).
- **Screenshots**: a script that writes screenshots of pages to a folder, if one exists.
- **How the app starts**: the dev or start command, how it takes its port (`PORT`, `--port`), a health or ready URL.
- **Data**: a database (env vars like `DATABASE_URL`, docker-compose services), migrations and how they are numbered.
- **Setup a fresh clone needs**: install (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync`…), generated files,
  a database to create, an `.env` from `.env.example`.
- **Context for agents**: `CLAUDE.md`, `AGENTS.md`, architecture or decision docs.
- **Default branch**: `git symbolic-ref --short refs/remotes/origin/HEAD` (the line's `base`; default `main`).
- **Where the runner will run**: the machine and OS of `machineId`. On Windows the default shell is `cmd.exe`; if the
  commands need a POSIX shell, the line needs `"shell": ["C:/Program Files/Git/bin/bash.exe", "-c"]`.

## 3. Propose `factory.json`

Write **only the keys that differ from the defaults**. A repo with nothing but `{"commands": {"verify": "npm test"}}`
has a working line. The keys and their defaults:

| Key | Default | Meaning |
|---|---|---|
| `base` | `main` | branch packages are integrated into |
| `branch` | `pkg/{id}` | the package's branch |
| `worktree` | `../<checkout folder>-wt/{id}` | the package's worktree; must be inside the runner's `allowedRoots` |
| `shell` | platform shell | argv prefix that runs a command line |
| `commands.setup` | none | after the worktree exists: install, create a database… |
| `commands.verify` | none | G1: typecheck, lint, tests. Without it G1 is off |
| `commands.acceptance` | none | G2: the package's acceptance tests. Without it G2 and QA are off |
| `commands.shots` | none | G4: writes screenshots to `paths.shots`. Without it G4 is off |
| `commands.app` | none | G4: starts the app for the visual judge (`app.url`, `app.readyPath`, `app.readyTimeoutSec` 180) |
| `commands.cleanup` | none | after integration: drop the database… |
| `paths.packages` | `factory/packages` | package specs |
| `paths.acceptance` | `tests/acceptance/{localId}` | where QA writes; the worker may not touch it |
| `paths.shots` | `test-results/shots/{localId}` | screenshots for G4 (at most 12 are attached) |
| `paths.protected` | `[]` | more paths a worker may not change (`factory.json` and `paths.acceptance` always are) |
| `env`, `envFile` | `{}`, `.env.factory` | variables for every step and the worker, also written to this file in the worktree |
| `resources` | none | `ports: [from, to]`, `dbPrefix`, `migrations: {from, block}`: allocated per package at claim |
| `gates.G1…G5` | on when their command exists; G3 and G5 always | `enabled`, `timeoutSec`, `steps`; `G2.qa` (true), `G3.security` (`sensitive`/`always`/`never`), `G4.chrome` (false), `G5.push` (true) |
| `models` | `opus`, visual `sonnet` | per role: worker, qa, review, visual, foreman (`null` = off), planner |
| `worker` | `launcher: hc`, `permissionMode: auto`, `limitHours: 10`, `subagents: 4`, `chrome: false` | how a worker starts (`launcher: claude` when herdr is not installed) |
| `limits` | `workers: 2` | parallel packages; `rounds` overrides the gate round limit |
| `integrate.approval` | `sensitive` | ask the owner before G5: `never`, `sensitive`, `always` |
| `context` | `["CLAUDE.md"]` | files every role reads first |

Placeholders in commands, paths and env: `{id} {idLower} {localId} {localIdLower} {project} {round} {port} {db}
{worktree} {branch}`. Commands run through the shell, in the worktree, with placeholders filled from checked values.

Rules for the proposal:

- **Never invent a command.** Every command line must be one that works in this repo today (a script that exists, a
  tool already installed and configured). Run nothing that changes state to find out; reading `package.json` is enough.
- **`commands.setup`** is almost always needed: the worktree is a fresh checkout without dependencies.
- **`commands.verify`**: what CI runs, chained with `&&` (typecheck, lint, unit tests). Without any check, say so and
  leave G1 off: the factory then relies on review alone, which is weak.
- **`commands.acceptance`**: only when the repo can already run black-box tests of one folder, e.g.
  `npx playwright test tests/acceptance/{localId}`. If it cannot, leave it out and tell the owner what adding one
  would switch on: QA writes the package's acceptance tests from its criteria **before** the code, and G2 runs them
  untouched — the factory's strongest check.
- **`commands.shots` / `commands.app`**: only when a screenshot script exists. Otherwise leave them out and say that
  adding one switches on G4, a visual judge on desktop and phone screenshots of the package's pages.
- **Ports and databases**: if the app or its tests listen on a port, add `resources.ports` (a free range, as wide as
  `limits.workers` needs, e.g. `[4100, 4199]`) and pass `{port}` through `env` (`"PORT": "{port}"`). One database
  per package: `resources.dbPrefix` and `{db}` in `env`, created in `setup`, dropped in `cleanup`. Numbered
  migrations: `resources.migrations` so parallel packages never take the same numbers.
- **`context`**: the agent-facing docs that exist. If there is no `CLAUDE.md`, do not list it.
- **`paths.protected`**: suggest the CI config and anything that must change only with the owner's approval (gate
  scripts, applied migrations, deployment files). Ask; do not decide alone.
- **Sensitive repos** (auth, payments, personal data): suggest `"integrate": {"approval": "always"}` and
  `"gates": {"G3": {"security": "always"}}`, and ask.
- Show the file with one line per key saying why, and the gates it turns on. **Ask the owner to confirm** before
  writing it at the top of the repo.

## 4. Package folder and template

Create `paths.packages` (default `factory/packages/`) with a `.gitkeep`, and the template **outside** that folder
(`factory/package-template.md`), because `bb tasks import` imports every Markdown file with frontmatter under the
folder. The template, in English unless the repo's docs use another language:

```markdown
---
id: P<n>
title: <short title>
status: backlog
depends_on: []
priority: 50
sensitive: false   # true for authentication, authorization, data import or export, personal data, payments, irreversible external effects
---

# P<n>: <title>

## Scope

<What it solves and for whom, in 3–5 sentences. What is out of scope.>

## Sources

- **Decisions:** <recorded decisions and docs that apply>.
- **Code:** <existing modules and files to read first>.

## External effects

<Only if the package sends something outside the system (email, payments, another system's API, files for others).
What leaves and where; what happens when it is interrupted halfway and how the real state is found before a retry;
when sending again is allowed and when never. Otherwise: "None.">

## What it delivers

1. <Data model and storage.>
2. <Services, routes, commands.>
3. <Pages.>
4. <Docs brought up to date, if a documented flow changes; otherwise "none".>

## Acceptance criteria

Criteria marked _(G1)_ are proven by the build and test command, those marked _(G3)_ only by review; QA writes a
black-box test for every other one.

1. <An observable result through the public surface (UI, HTTP, CLI), with synthetic data.>
2. <A refusal: who is not allowed, which input is rejected, and that the system itself refuses it.>
3. _(G3)_ <A security or domain rule checked at review.>

## Pages for the visual check

<The pages G4 captures at desktop and phone width, including an empty state and one with data; "none" without UI.>
```

Optional, only if the owner wants them now: `factory/worker.md`, `factory/review.md`, `factory/visual.md`,
`factory/qa.md`, each with one HTML comment line saying what belongs there (the kit adds the file to that role's
instructions when it exists):

- `worker.md`: `<!-- This project's rules for workers: conventions, module boundaries, what never to touch. -->`
- `review.md`: `<!-- This project's review rules for G3, added to the kit's checklist: architecture, naming, domain rules. -->`
- `visual.md`: `<!-- This project's visual rules for G4: language, number and date formats, design system. -->`
- `qa.md`: `<!-- How this project tests: framework, how the app starts, test data, selectors and their conventions. -->`

## 5. Check the line with `bb line check`

Run `node <buildyboy checkout>/cli/bb.ts line check <repo top folder>` (add `--file <path>` if the line file is not
`factory.json`). Find the Buildyboy checkout: `claude mcp get buildyboy` shows `…/cli/bb.ts` when the MCP server runs
over stdio; else the runner's service (`~/.config/systemd/user/buildyboy-runner.service`, `WorkingDirectory`), else
ask the owner. Fix every error and re-run until it passes; show the owner the resolved line it prints (enabled gates,
the commands filled for a sample package, the worktree path) and its warnings. Check that the worktree path and the
checkout are both inside `allowedRoots` of `~/.buildyboy/runner.json`; if not, tell the owner which root to add (the
server cannot change that file). Without a checkout, say that `bb line check` was not run and that **Check setup** on
the project's Setup tab validates the line on the runner after step 7.

## 6. Keep the factory's files out of git

Make sure `.gitignore` covers `/.factory/` and the env file (`/.env.factory`, or the line's `envFile`), and the
screenshot folder if it is not ignored yet. Add only the missing lines.

## 7. Register the project

Fields: `key` (lower case, `^[a-z][a-z0-9-]{1,23}$`, from `$ARGUMENTS` or the repo folder name; it never changes),
`name`, `repo` (`owner/name` from `git remote get-url origin`, if it is on GitHub), `idPrefix` (`""`, or e.g. `SH-`:
packages are then stored as `SH-P1`; ask the owner, it is fixed once the project has packages), `machineId` (from
`~/.buildyboy/config.json`), `checkout` (the absolute path of this main checkout, as the runner on that machine sees
it), `lineFile` (`factory.json` unless it lives elsewhere).

1. `projects_list {state: "all"}`: a project may already exist for this repo (older packages created one). If so,
   update that one with its key instead of creating a second (one project per repo).
2. Show the owner the fields and ask for a yes. `machineId`, `checkout` and `lineFile` decide what the runner
   executes, so never guess them.
3. Call `projects_save {key, name, repo, idPrefix, machineId, checkout, lineFile}`. It works only when this agent
   token is an **operator**. On a 403, or without the MCP tools, print the link to the app's form with the same fields,
   URL-encoded, for the owner to open and save:
   `<server>/projects/new?key=<key>&name=<name>&repo=<owner/name>&machineId=<id>&checkout=<path>&lineFile=factory.json&idPrefix=<prefix>`
4. `projects_get {key}` to confirm.

## 8. Tell the owner what comes next

In a few lines:

1. Review and commit `factory.json`, `factory/`, `.gitignore` on the base branch and push: the runner reads the line
   from the main checkout, and workers branch from `origin/<base>`.
2. On the project's page (Projects → the project → Setup) press **Check setup**: the runner validates the line there.
3. Plan the work: `/buildyboy:factory-plan <goal or spec>`, or **Plan new work** on the project page.
4. Turn **Autopilot** on for the project when the plan is approved, and follow it from the phone. To drive it by
   hand instead: `/buildyboy:factory-foreman <key>`.

Never commit, push, or change files other than the ones above unless the owner asks.
