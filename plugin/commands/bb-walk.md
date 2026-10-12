---
description: Turn Buildyboy walk mode on or off for this session (remote approvals from your phone)
argument-hint: "[on|off|5m]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/bb-cli.mjs" walk $ARGUMENTS`

Tell the user the line above, verbatim. Don't do anything else.
