---
description: Query the governance audit trail — every decision, the clause it cited, and who decided.
argument-hint: [--since 24h] [--denied] [--corrected] [--session ID] [--tool T] [--limit N] [--json|--csv]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" log $ARGUMENTS`

Show that output to the user verbatim. Each line is `timestamp · verdict · tool · clause (or actor)
· latency · input`, and a rewritten call is marked as such. Do not re-derive any of it from the
transcript: the trail is the record, and a summary that disagrees with it is worse than no summary.

The last line names the file or directory the decisions actually came from. If the result is empty,
that line is the answer — read it out rather than guessing why.
