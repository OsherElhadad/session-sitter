---
description: Lint a practices file — which clauses can actually enforce anything, and what a change would alter.
argument-hint: <practices.md> [--replay] [--limit N]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" check $ARGUMENTS`

Show that output verbatim, then call out the errors specifically. An `error` finding means a clause
declares a level but carries no `Match:` line, so it cannot deny or allow anything on its own — it
only reaches the classifier as prose. That silent gap is what this command exists to catch, so it
should not be listed among the warnings as if it were cosmetic.

With `--replay`, every line printed is a recorded decision whose verdict this file would change.
Read those as the blast radius of the edit.
