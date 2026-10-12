# Claude Code behavior notes (confirmed for Buildyboy)

Sources: the hooks reference at code.claude.com/docs (fetched 2026-10-12), the Agent SDK "user input" guide, and empirical runs
with Claude Code **2.1.296** on Windows 11 (`claude -p`, model alias `haiku`, throwaway temp git repos, a throwaway
`--plugin-dir` probe plugin that dumped every hook's stdin, plus `npm run smoke:claude`). Total spend for all real runs is in
the PR description.

## The "not yet verified" items from SPEC.md §1

| Question | Answer | How we know |
|---|---|---|
| What happens when a PermissionRequest hook times out? | The hook is cancelled and its output discarded; the **normal permission flow continues**. Under `claude -p` that means the call is **denied** (nobody to ask; it shows up in `result.permission_denials`). Interactively the usual dialog appears. | Docs (timeouts section). Empirical under `-p`: a hook with `timeout: 3` that answered after 10 s → Bash denied after ~3 s, the run continued. Interactive case: docs only. |
| Does PermissionRequest fire under `claude -p`? Is `--permission-prompt-tool` needed? | **It fires**, with `tool_name`, `tool_input` and `permission_suggestions` (no `tool_use_id`). A hook `decision.behavior: "allow"` is honored, so `--permission-prompt-tool` is **not** needed. Without a decision, `-p` denies. | Empirical (probe + `smoke:claude` run 2: a Write in `default` mode approved from the API → file created). |
| Does the Desktop app's Code tab load user-scope plugins and hooks? | **Not verified.** Verifying it means installing the plugin for real (`claude plugin install`), which is an ask-first step. Desktop sessions write transcripts with `entrypoint: "claude-desktop"`, so transcript import works for them regardless. | Left as a Next step for the user (README "Go for a walk" step 4 checks it). |
| Can `AskUserQuestion` be answered through `updatedInput`? | The documented answer shape is `updatedInput: { questions, answers: { "<question text>": "<option label or typed text>" } }` (multi-select: labels joined with `", "`), returned as an **allow** on the permission path (SDK `canUseTool` ⇔ CLI PermissionRequest hook). Buildyboy sends exactly that from PermissionRequest, and also from PreToolUse (`permissionDecision: "allow"` + `updatedInput`). **Empirically unverifiable under `-p`:** in 2.1.296, headless sessions don't offer the AskUserQuestion tool at all (the model's ToolSearch for it returns no match, even with `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL=true`). The deny-with-answer fallback is therefore not used. | Docs (Agent SDK "Handle clarifying questions"); empirical probe showed the tool is absent under `-p`. |
| Which env var names the session source? | `CLAUDE_CODE_ENTRYPOINT`: `sdk-cli` for `claude -p`, `cli` for the terminal, `claude-desktop` for the Desktop app (the last two seen as `entrypoint` in transcript lines). Hooks also get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_EFFORT`, and `CLAUDE_CODE_BRIDGE_SESSION_ID` while Remote Control is active. | Empirical (probe dumped hook env names) + transcripts' `entrypoint` field. |
| Does `async` work for `http` hooks? | **No.** `async: true` is only available on `type: "command"` hooks. Buildyboy uses command hooks only. | Docs ("This field is only available on `type: "command"` hooks"). |

## Other confirmed behaviors Buildyboy relies on

- **Async hooks under `-p`** run (we saw async PostToolUse complete), but Claude Code **kills any async hook still running at
  teardown** (docs). So the last events of a headless run must not be async: Buildyboy's `Stop` (sync, carries the final
  transcript delta, git snapshot and PROGRESS.md) and `SessionEnd` (sync, `timeout: 5`) are registered without `async`.
- **SessionEnd** hooks share a 1.5 s budget by default; a per-hook `timeout` raises it (docs).
- **Stop input** has `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. `decision: "block"` +
  `reason` continues the turn; 8 consecutive continuations max (docs).
- **PermissionRequest output**: `hookSpecificOutput.decision` with `behavior`, and `updatedInput` / `updatedPermissions` (allow)
  or `message` / `interrupt` (deny). Permission update entries carry a `destination`; Buildyboy's "Allow for this session"
  echoes `permission_suggestions` with `destination: "session"`.
- **PreToolUse output**: `hookSpecificOutput.permissionDecision` (allow/deny/ask/defer), `permissionDecisionReason`,
  `updatedInput`, `additionalContext`. Universal `continue: false` + `stopReason` stops Claude (used for the emergency stop).
- **Timeouts**: default 600 s for command hooks; 30 s on UserPromptSubmit. A timed-out PreToolUse hook does not block the tool.
- **Hook command form**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/bb-hook.mjs"` works on Windows (Claude Code substitutes the variable;
  forward slashes).
- **`--plugin-dir`** loads a plugin for one session only; combined with `--setting-sources project,local` it keeps the user's
  own settings and installed plugins out of test runs.
- **Headless stdin**: `claude -p` waits up to 3 s for stdin data; spawn it with stdin ignored (or `< /dev/null`).
- **Transcript lines** seen (keys only, no content copied): `user`, `assistant` (with `message.id`, `model`, `usage`),
  `system` (subtypes `compact_boundary`, `turn_duration`, `stop_hook_summary`, `local_command`, `informational`, ...),
  `ai-title`, `custom-title`, `cost-state` (`totalCostUSD`, `totalLinesAdded`, `totalLinesRemoved`, `modelUsage`),
  `pr-link` (`prUrl`, `prNumber`), `permission-mode`, `mode`, `attachment`, `queue-operation`, `file-history-*`,
  `last-prompt`, `agent-name`, `atis-latch`, `relocated`. Unknown types are stored and shown as raw.
- **Hook payload fields** (empirical): every event has `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and usually
  `prompt_id`, `permission_mode`, `effort`. PreToolUse/PostToolUse add `tool_name`, `tool_input`, `tool_use_id`
  (+ `tool_response`, `duration_ms` on PostToolUse). SessionEnd has `reason` (`other` for a finished `-p` run).

## Latency (bb-hook.mjs on Windows, server on localhost)

p95 over 20 runs, measured while other work was running on the machine: lean PreToolUse 40 ms (bare `node -e 0` is ~32 ms),
telemetry 66 ms, sync PermissionRequest (walk off) 66 ms, sync Stop with git enrichment 129 ms (one
`git status --porcelain=v2 --branch` call plus a cached repo root/remote). Server down: no output, exit 0, < 1 s; a server that
accepts but never answers costs ~1 s (headers timeout), then the circuit breaker skips the network for 60 s.
