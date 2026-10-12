# Task

Goal: Build Buildyboy v1, a self-hosted software factory around Claude Code, exactly as specified in `SPEC.md`. Read all of SPEC.md first; it is the source of truth. The finished app has five parts: a Node 24 + SQLite server; a Claude Code plugin whose hooks feed it; a phone-first PWA with the Floor canvas, the session timeline, a remote-approval Inbox and a prompt composer built on `harness-prompt.md`; a job runner; and a WSL deploy script. Build them milestone by milestone, M0 to M9, in order (SPEC.md §8).
Done when: all of the following pass on the final commit. If the Limit stops you first, M0–M5 is the minimum useful result; open a draft PR saying which checks still fail.
  1. `npm ci && npm run check` exits 0. `check` runs the typecheck for every package and all Vitest tests.
  2. `npm run build` exits 0.
  3. `npm run e2e` exits 0. It runs Playwright at 1280×800 and 390×844 against fixtures replayed by `npm run simulate` and covers these flows:
     - logging in;
     - the Floor showing the simulated sessions;
     - the session timeline rendering every tool type;
     - answering a pending permission in the Inbox, which releases the waiting `bb-hook.mjs` with the right JSON;
     - a queued message delivered through the Stop hook;
     - the composer parsing `harness-prompt.md` and rendering it back.
  4. `npm run smoke:claude` exits 0. It runs real `claude -p` with `--plugin-dir ./plugin` against a temp server and DB, and checks both the telemetry path and the remote-approval path (SPEC.md M4).
  5. After `npm start`, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7700/api/health` prints `200`.
  6. Inside WSL (`wsl.exe -d Ubuntu -- bash -lc '…'`), `bash -n deploy/*.sh` passes and `deploy/deploy-wsl.sh --dry-run` exits 0. The sha256 of `/etc/caddy/Caddyfile` is the same before and after.
  7. The Chrome visual check (below) has passed for the Floor, Session, Inbox, Composer, Jobs and Machines pages, at desktop and 390 px widths, with no console errors.
  8. `README.md` covers local dev, pairing a machine (Windows and WSL), deploying to WSL, and a "go for a walk" walkthrough.
Scope: all of `C:\newme\buildyboy`, except that `harness-prompt.md`, `SPEC.md` and `TASK.md` are read-only. Everything outside the repo is read-only, with the exceptions listed under "Rules for this task".
Limit: 10 hours of wall-clock time. Don't start a new milestone after 9h30; run Finish instead.
Subagents: 8
Branch: new, `feat/buildyboy-v1`
PR: yes
Unattended: yes

If a missing detail would change the result, ask me one focused question (when unattended: pick the safest sensible default and record it under Decisions instead). For anything else, choose a sensible default, say what it is, and start.

## Rules for this task

- **Spending is pre-approved, within a cap.**
  - You may run real `claude -p` sessions for `smoke:claude` and the runner tests.
  - They may only run inside temp directories you create, using the cheapest model alias that works.
  - Each run gets `--max-budget-usd 0.50` or less, and the whole task gets $8 or less in total.
  - Log each run's cost in `PROGRESS.md`. If the cap is reached, stop running real sessions and rely on fixtures.
- **Leave my real Claude setup alone, on both Windows and WSL.** Don't edit `~/.claude/settings.json` or other settings files. Don't install, enable or uninstall plugins or marketplaces. Test only with `--plugin-dir`, `--settings` and env vars. Tests must point the hook's state directory at a temp dir (e.g. `BUILDYBOY_HOME`), never at the real `~/.buildyboy`.
- **WSL is read-only.** You may only run the dry-run deploy, `bash -n`/shellcheck, and tests in a temp dir. No `sudo`. Don't touch Caddy, `/etc`, `~/apps/efacturi`, or anything on ports 80, 443, 3333, 5432 or 6379. The server uses port 7700; tests use random free ports.
- **Ask-first items.** Leave these as "Next" steps for me:
  - the real deploy;
  - installing the plugin or runner for real;
  - pairing a real machine;
  - sending push notifications to real devices;
  - anything involving my GitHub tokens beyond the existing `gh` login used for git and the PR.
- **Privacy.** You may read real transcripts under `~/.claude/projects` to learn their shape. Never copy them, or anything from them, into the repo or fixtures. Fixtures are synthetic.
- **Docs before code.** Look up library APIs with the Context7 MCP before using them. For Claude Code behavior, use code.claude.com/docs and then confirm empirically. Put the confirmed behaviors in `docs/claude-code-notes.md` (committed), especially the "not yet verified" items in SPEC.md §1.
- **If the spec can't be done as written** (e.g. a hook mechanism doesn't work), build the fallback the spec names, or the simplest working alternative. Record it under Decisions and in `docs/claude-code-notes.md`, then keep going. Don't stall.
- **Inputs go in first.** If `SPEC.md` or `TASK.md` is untracked when you branch, commit them as the first commit on the branch.
- **Good subagent splits** come after M1 has stabilized `shared/types.ts`. For example, web UI pages, deploy and installer scripts, and the runner can be built in parallel, with no file overlap.

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
