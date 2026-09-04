---
description: What did my agents do — one summary per session, with the clauses applied and everything denied.
argument-hint: [--since 24h] [--session ID] [--json]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" digest $ARGUMENTS`

Show that output verbatim. Then, in at most three sentences, name anything a human should look at: a
denial that repeats, one clause firing far more than the rest, or a latency high enough to say the
classifier tier is sitting on the critical path. Say nothing if nothing stands out.

`not recorded` means the writer recorded nothing for that field. It does not mean zero, and it must
not be reported as zero — the whole reason the field is nullable is to keep those apart.
