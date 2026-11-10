# Task

Goal: Make Buildyboy keep the factory's bookkeeping, which the arond coordinator did by hand during P1–P7: (1) `bb mcp` keeps working when the server is unreachable (local outbox, stale reads, a local governor, a phone alert); (2) the server counts gate rounds, applies the "N failed rounds → blocata + decision" rule and computes each package's exact cost from every session tagged with it; (3) gates run as runner jobs from a recipe kept in the project repo, and the coordinator gets back only the verdict and the findings; (4) `tasks_claim` allocates the package's resources (port, database name, migration-number range) and the server warns about collisions; (5) gate findings become structured records with a status, and a new package can be created from selected findings.
Done when: `npm run check`, `npm run build`, `npm run e2e` and `npm run smoke:mcp` pass; the smoke test also covers every new tool; new vitest tests show (a) with the server stopped, `gates_record`, `tasks_update` and `digest_post` return `queued: true`, and after the server is back each queued call lands exactly once, even when the replay runs twice (idempotency key); reads such as `tasks_get` and `governor_get` return the last known answer with `stale: true` and its age; `governor_get` offline is computed from the local statusline sample; (b) three failing gate rounds move a package to `blocata` and open one pending decision tied to it, an approved extra round allows round 4, and `tasks_get` shows `round` and `maxRounds`; (c) two sessions tagged `BB_TASK=P9` (one `lucrator`, one `poarta`) make the task's cost their exact sum, split by role; (d) a `gates_run` job runs a recipe step through the runner, records the gate result with the step's verdict, summary and findings, keeps the log on the server and returns no log text to the caller; (e) two claims get different ports and non-overlapping migration ranges, and integrating a package whose used migrations overlap another active package's range adds a warning to that package and to the digest; (f) findings from a failed round are `open`, a later pass of the same gate marks that gate's earlier blocker/major findings `fixed` while minors stay `open`, and `tasks_create` with `fromFindings` builds the body and acceptance criteria from them and marks them `deferred` to the new task; in Chrome, the package page shows the round, the cost split by role, the resources and the findings with their status, on desktop and at phone width.
Scope: `shared/factory.ts`, `shared/` (new factory types only), `server/factory/`, `server/routes/factory.ts`, `server/migrations/` (new files only), `server/db.ts` (only if the new tables need it), `server/factory/digest.ts`, `cli/mcp.ts`, `cli/` (new modules for the outbox and cache), `plugin/hooks/bb-hook.mjs` (only the env allowlist), `plugin/statusline/bb-statusline.mjs` (only a local copy of the latest sample), `runner/` (the gate job kind), `web/src/pages/Task.tsx`, `web/src/pages/Backlog.tsx`, `web/src/pages/Settings.tsx`, `web/src/components/` (new factory components), `server/docs/templates/`, `SPEC.md` §11, `tests/`, `e2e/`, `scripts/smoke-mcp.ts`; everything else is read-only.
Limit: 8 hours or 60 iterations
Subagents: 4
Branch: new, `feat/factory-bookkeeping`
PR: yes
Unattended: yes
Context: Why: the arond factory integrated P1–P7 in about 1.5 days (≈ $320), but the coordinator made 187 `gates_record` and 193 `tasks_update` calls, kept gate scripts and ~150 logs in its own scratchpad, estimated costs ("≈") because QA and `claude -p` gate runs were not tied to packages, counted rounds from memory, renumbered migrations of parallel packages three times by hand, killed orphan dev servers that caused two false gate failures, and copied gate findings into free-text notes. The server was unreachable for about 4 hours (2026-11-10, ~06:00–10:00): 21 "fetch failed" errors, no governor, so no packages could start. The full retrospective (in Romanian) is in the arond repo, `meta/jurnal/2026-11-10-retrospectiva-fabricii.md`.
Context: Decisions already made: (1) **Backward compatibility.** Every existing MCP tool keeps its current arguments and result shape; new fields are optional and additive. The arond coordinator (`C:\newme\arond\fabrica\coordonator.md`) uses them as they are today. (2) **Outbox** in `~/.buildyboy/outbox.jsonl` (or `BUILDYBOY_HOME`), written by `bb mcp` for write tools only (`gates_record`, `tasks_update`, `digest_post`, `prompts_save`; `tasks_claim` and `decision_ask` fail clearly instead, because their answer matters right away). Each queued call carries an idempotency key the server stores, so a replay is harmless. Replay at `bb mcp` start, before every call, and every 30 s while queued items exist, in order. The read cache holds the last successful answer per tool and arguments. The offline governor uses the same rules as `server/factory/governor.ts` on the latest local statusline sample, with `reason` saying it is local. If the server is unreachable for over 10 minutes and `ntfyTopic` is set in the local config, `bb mcp` sends one ntfy message directly, once per outage, and one when the server is back. (3) **Rounds.** A new round starts at each transition into `la_porti`, and the first gate result without such a transition counts as round 1. The `gate_max_rounds` setting defaults to 3. When the last gate of a round fails and the round is at the limit, the server sets `blocata` and opens a decision tied to the package with the failed gates and the options "Încă o rundă", "Încă o rundă, doar pentru <gate>", "Oprește pachetul". A move from `blocata` back to `in_lucru` with a note raises `maxRounds` by one. (4) **Cost.** Add `BB_TASK` and `BB_ROLE` (`lucrator`, `qa`, `poarta`, `coordonator`) to the hook's env allowlist and link those sessions to the task. Sessions already linked through the herdr terminal count as `lucrator`. When linked sessions exist, the task's `costUsd` is their sum; a value set by hand with `tasks_update` stays visible as `costManualUsd`. (5) **Gates as jobs.** The server never runs commands; the runner does (SPEC §10). New tools: `gates_run {taskId, gate, args?}` returns a `runId`, and `gates_status {runId}` returns the state and, when the run is done, the verdict, summary and findings. The recipe is a JSON file whose path is set **per repo in Buildyboy** (Settings → Factory), read from the trusted main checkout, never from the package's worktree (the worker must not be able to change its own gates). A gate is a list of argv steps (no shell) with placeholders (`{id}`, `{idLower}`, `{worktree}`, `{round}`, `{port}`, `{db}`, `{recipeDir}`, `{args}`) and a timeout. The step contract: exit 0 = pass, 1 = fail, other = error; the last stdout line is JSON `{verdict, summary, details?, findings?, shots?}`. The runner sets `BB_TASK` and `BB_ROLE=poarta` for the step and keeps the log on the server (truncated at a sensible size). The arond recipe and scripts are being written in `C:\newme\arond\fabrica\porti\` with this contract; read them for a real example, don't change them. (6) **Resources.** A per-repo config (same Settings → Factory place): port range, database prefix, first migration number and block size, cleanup templates. `tasks_claim` returns `resources {port, db, migrations: {from, to}}`, and they are kept until `integrata`. `tasks_update` accepts `migrationsUsed`. When a package is integrated, any other active package whose range overlaps its used numbers gets a task event and a digest line asking it to renumber. The move to `integrata` returns the filled-in cleanup list. (7) **Findings.** `gates_record` accepts `findings: [{severity: blocker|major|minor, title, file?, line?, detail?, fix?}]`. New tools: `findings_list {taskId?, status?, severity?}`, `findings_update {ids, status, note?}` (statuses: `open`, `fixed`, `deferred`, `for_architect`, `wontfix`), and `tasks_create` gains `fromFindings: number[]`. The package page lists findings; the backlog gets a filter for open minors across packages. (8) The digest lists pending decisions with their age, not just their count. (9) Don't deploy. Narcis publishes to WSL himself with `deploy/deploy-wsl.sh`. Don't edit any `~/.claude` settings file.

If a missing detail would change the result, ask me one focused question (when unattended: pick the safest sensible default and record it under Decisions instead). For anything else, choose a sensible default, say what it is, and start.

## How to work

1. **Orient.** If `PROGRESS.md` exists, read it, confirm it still matches the code, and resume from its next step. Read only what the next decision needs.
2. **Baseline.** Run the checks before changing anything and note the result. Every change is measured against it.
3. **Small steps.** Make one bounded change and run the checks it affects. Keep it if it moves toward done; revert just that change if it doesn't. Don't repeat a failed approach without a new reason.
4. **Simpler wins.** When two solutions work equally well, keep the one with less code. Removing code without losing anything counts as progress. Don't add abstractions, config, or files the task doesn't need.
5. **Don't touch the evaluator.** Never edit, skip, or loosen a check to make it pass. If a check looks wrong, stop and tell me.

## Subagents

Use them when they save real time or context. Otherwise, do the work yourself.

- **Good fits:** independent pieces that can run in parallel, wide codebase searches, a fresh-eyes review at the end. **Poor fits:** small tasks and tightly coupled edits.
- **Pick the cheapest model that can do the job well.** Sonnet 5.5 for well-defined work: searching, mechanical edits, writing tests, following a clear plan. Opus 5.5 for ambiguous design, hard debugging, and the final review.
- **Brief them fully.** A subagent doesn't see this conversation. Give it the goal, the files, its scope, and exactly what to return.
- **No overlapping edits.** Two subagents never edit the same files at the same time.
- **Verify before keeping.** A subagent saying "done" is a claim. Run the checks on its work yourself.
- **Only you commit and push.** Subagents edit files; they don't touch git.
- Stay within the subagent limit above, counting every agent you start.

## Visual check

For anything a person will look at (UI, layout, styles, charts, generated pages), open it in Chrome and look at it before calling it done.

- Start the dev server if needed, open the page in a new tab, and take a screenshot.
- Compare it with what was asked. Try the main interaction, check the console for errors, and check a phone-width viewport if layout matters.
- Treat this as one of the checks: fix what looks wrong, then look again.
- Leave my other tabs and logged-in accounts alone.
- If Chrome isn't connected, say so. Never claim something looks right without seeing it.

## Git

Commits, pushes to the work branch, and opening the PR are pre-approved. You don't need to ask.

- **Branch.** If `Branch` is new, fetch and branch off the latest base branch. If it's current, work where you are. Unattended work never lands directly on `main`/`master`: if you're on it, create a branch first.
- **Commit at each milestone**, meaning a step that passes its checks and leaves nothing worse than the baseline. Stage only the files you changed. Never commit secrets, `.env` files, build output, or `PROGRESS.md`. Keep messages short: what changed and why.
- **Push after every commit.** If a push fails, keep committing locally, note it in `PROGRESS.md`, and try again at the next milestone.
- **Open the PR when finished** (if `PR` is yes), using `gh`, against the base branch. In the description, cover what changed, the check results, and what's unresolved. Open it as a draft if any check fails or the work is partial.
- **Never** force-push, rewrite pushed history, push to any other branch, merge the PR, or enable auto-merge.

## When I'm away (`Unattended: yes`)

- Don't wait for me. Where you'd normally ask, pick the safest reasonable option, record it under Decisions, and keep going.
- Anything on the ask-first list below: don't do it. Leave it as a next step for me.
- If one part is blocked, record why and move to another part. When nothing useful is left or the limit is reached, run Finish and stop. Don't spin.
- Keep `PROGRESS.md` current after every milestone. On a long run your context may get compacted, and this file is how you stay on track.

## Guardrails

- Stay inside scope.
- Ask before anything else irreversible or outward-facing: deploy, publish, delete data, send messages, spend money.
- Commit before a risky edit so it can be undone.
- Before retrying an external write (push, PR), check whether the first attempt already landed.

## Progress file

You must keep this file when the task is unattended or spans sessions. Skip it for short attended tasks. Keep it out of git (add it to `.git/info/exclude`). Keep it short:

- **Done:** finished milestones and their check results
- **Decisions:** choices that shape the result, and why
- **Tried and failed:** what didn't work, and why
- **Git:** branch, last pushed commit, PR link
- **Next:** one concrete step to resume from

## Finish

1. Reread the full diff once with fresh eyes (a review subagent works well for large changes). Look for bugs, leftover debug code, and complexity you can remove.
2. Rerun all checks on the final version, including the Chrome check for visual changes.
3. Commit and push the final state. If `PR` is yes, open the PR.
4. Report briefly:
   - branch and PR link
   - what changed, with file paths
   - each check: pass or fail, with the real output for failures
   - for visual changes, what you looked at in Chrome
   - if you used subagents: how many, which model, and for what
   - decisions made without me, and anything unresolved

If the limit or a blocker stops you, say exactly what's left. Never report a result you didn't observe.
