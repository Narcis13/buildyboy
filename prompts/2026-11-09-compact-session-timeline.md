# Task

Goal: Make the session page timeline (`/s/<id>`, opened from Floor) easy to scan. By default, show Claude's text messages and the prompts in full, and show each tool call as one compact line (tool + short summary + status/duration) that expands on click. Hide transcript noise entirely: the raw `api-request` lines and the like. Today a real 45-minute contzoapp session is ~148 screens tall, and you have to scroll a lot to see what the start of the session was about.
Done when: `npm run check` (typecheck + vitest) and `npm run build` pass; `npm run e2e` passes (update the existing selectors in `e2e/session.spec.ts` only where the new compact behaviour requires it, without loosening what they verify); new vitest tests cover (a) ingestion: `api-request`, `api-request-blob`, `api-request-shape`, `tools-used`, `session-owner` no longer produce `raw` messages, and (b) the one-line summary function for each tool type; in Chrome, a long session with ~600 items has its timeline at most about 1/4 of today's height in compact mode, one click on a tool line opens the current detailed card, and the "Detailed" toggle restores today's view.
Scope: `server/ingest/transcript.ts`, `server/queries.ts`, `shared/types.ts` (only if needed), `web/src/components/timeline/`, `web/src/pages/Session.tsx`, `web/src/components/session/` (only for the toggle in the lane bar), `server/docs/templates/pages/sessions.faqir`, `tests/`, `e2e/session.spec.ts`, `server/migrations/` (only if you choose to clean up the existing raw rows); everything else is read-only.
Limit: 3 hours or 25 iterations
Subagents: 3
Branch: new, `feat/compact-session-timeline`
PR: yes
Unattended: yes
Context: Observed on 2026-11-09 on buildyboy.contzo.lol, session `f4664dcb-…` (contzoapp, T71.2a, Claude Code 2.1.319). Main lane: 601 items, of which only 32 `assistant` + 5 `prompt` + 20 `thinking`. The rest: 348 `raw` (169 `api-request`, 159 `api-request-blob`, 4 `api-request-shape`, 16 `tools-used`, plus `session-owner`), each a ~375px JSON box labelled "Unrecognised transcript line", ~1.5 MB of JSON in the API response; 189 tools (131 Bash, 13 Write, 10 Edit, 23 claude-in-chrome MCP, etc.), cards of 200–670px with inline diffs, expanded MCP input JSON and Bash output.
Context: Decisions already made: (1) The new line types go into `IGNORED` in `server/ingest/transcript.ts` (see what the `api-request*` lines actually contain before deciding: if they carry useful data, e.g. usage, extract it as a patch, don't display it). The "Unrecognised transcript line" box stays as it is for genuinely new types, but collapsed by default to one line. Optional: a migration that deletes the existing `raw` rows of these types from `messages`, only if it's simple and idempotent. (2) Compact is the default mode; next to the Main/All chips there's a Compact/Detailed toggle, remembered per browser (`readStore`/`writeStore` from `components/floor/hooks.ts`). (3) In compact mode: `assistant` and `prompt` in full (as today); `thinking` stays collapsed as today; each tool is a single line ~32–40px: coloured tool badge + summary (Bash → `description` or the truncated command + `exit N` if ≠0; Edit/Write → relative path + `+a −r`; Read/Grep/Glob → path/pattern + counts; MCP → `server › tool` + the most telling field in the input, e.g. url/action; Agent → description; WebFetch/WebSearch → url/query; TodoWrite → `n/m done`) + status pill only if ≠ ok + duration. Click → expands inline exactly the current `ToolCard`. Failed/denied/blocked tools and `AskUserQuestion`/`ExitPlanMode` stay visible, as today, even in compact mode. (4) Several consecutive tools with no text between them (e.g. 8 Bash in a row) are grouped into one line "8 tools · Bash ×5, Read ×2, Edit ×1" that expands into the individual lines; a group that contains an error shows that in its header. (5) The virtualizer (`@tanstack/react-virtual`) stays; make sure `measureElement` correctly measures the height after expand/collapse and that "Jump to live"/stick-to-bottom keep working. (6) Update the sessions page in the docs (`sessions.faqir`) with a short paragraph about Compact/Detailed.

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
