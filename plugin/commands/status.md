---
description: Show every session Session Sitter has registered, with its decision counts.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" *)
---

Sessions Session Sitter knows about:

!`node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" status`

Show that output to the user as it is — the point is the raw list, not a summary of it. If it
reports no sessions, the `SessionStart` hook has not run: either the plugin is not enabled, or this
session started before it was.
