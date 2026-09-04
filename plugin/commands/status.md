---
description: Every agent session and which of them need you, plus the sessions this plugin has registered.
argument-hint: [--since 24h] [--blocked] [--sort status|activity] [--json]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" *)
---

The worklist — every session across Claude Code, IBM Bob, Codex and VS Code Chat, ordered so the ones
waiting on a human come first:

!`node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" status $ARGUMENTS`

The sessions this plugin's `SessionStart` hook has registered, with their decision counts:

!`node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" status`

Show both as they are — the point is the raw lists, not a summary of them.

These answer two different questions and it is worth keeping them apart. The **worklist** reads each
agent's own session store, so it sees sessions this plugin has never touched. The **registered** list
reads what the hooks wrote, so it is what says whether governance is actually wired up here. A session
in the first list and not the second is running *ungoverned*: the plugin was not enabled when it
started. If the registered list is empty entirely, either the plugin is not enabled or every session
predates it — say so plainly rather than reporting the worklist as if it were governed.
