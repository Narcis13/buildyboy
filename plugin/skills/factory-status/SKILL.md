---
name: factory-status
description: Report in a few lines what the Buildyboy factory is doing and what waits on the owner - packages on the line and where each stands, ready packages, decisions and stop/revert requests waiting, alerts such as a runner offline or autopilot held. Use it whenever the owner asks how the factory, a project or the line is doing, or what needs them.
argument-hint: "[project key]"
allowed-tools: mcp__buildyboy__factory_status, mcp__buildyboy__decisions_list, mcp__buildyboy__projects_list
---

# Factory status

1. The Buildyboy MCP tools must be in this session (`mcp__buildyboy__factory_status`). If they are not, say so and how
   to connect: an agent token from Settings → Factory → Agent tokens, then
   `claude mcp add --transport http buildyboy https://<server>/mcp --header "Authorization: Bearer bba_…" --scope user`
   and a new session. Stop there.
2. Call `factory_status` (with `{project: "$ARGUMENTS"}` when a key was given). One call is enough; call
   `decisions_list {status: "pending"}` only if the owner asks about a decision's details.
3. Answer in at most about ten lines, most urgent first:
   - **Alerts**, if any: runner offline, usage data stale, autopilot held (and why: governor, paused project, runner).
   - **Waiting on the owner**: each pending decision (package, the question in a few words, how long it has waited),
     open stop/revert requests, the Inbox count.
   - **Per active project**: autopilot on or off; packages on the line as `id title: stage, round, waiting for what,
     since when`; how many are ready next.
   - The governor in one phrase when it stops new work (5-hour or 7-day window, until when).
4. Report only what the answer says; do not guess causes. Do not answer decisions, change projects or start anything:
   this skill only reads. If the owner wants to act, point to the app (Projects, Decisions) or, for a by-hand project,
   `/buildyboy:factory-foreman <key>`.
