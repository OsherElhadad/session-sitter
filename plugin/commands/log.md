---
description: Query the governance audit trail — every decision, the clause it cited, and who decided.
argument-hint: [--since 24h] [--denied] [--corrected] [--session ID] [--json|--csv]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" log $ARGUMENTS`

Show that output to the user verbatim. Each line is `timestamp · verdict · tool · clause (or actor)
· latency · input`, and `FIX` means the correction lane rewrote the call. Do not re-derive any of
it from the transcript: the trail is the record, and a summary that disagrees with it is worse than
no summary.
