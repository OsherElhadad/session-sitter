---
description: What did my agents do — one summary per session, with the clauses applied and everything denied.
argument-hint: [--since 24h]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" digest $ARGUMENTS`

Show that output verbatim. Then, in at most three sentences, name anything a human should look at: a
denial that repeats, one clause firing far more than the rest, or a latency high enough to say the
classifier tier is sitting on the critical path. Say nothing if nothing stands out.
