---
description: Propose practices from the decision trail — no model, ever. Everything it writes is inert until a human accepts it.
argument-hint: [--dry-run] [--status] [--no-retire] [--json]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" learn $ARGUMENTS`

Show that output verbatim.

Two things to be exact about when you describe the result, because both are safety properties rather
than details:

- **Everything it writes is `status: proposed`**, under the corpus's `learned/` directories. A
  proposed clause cannot decide, cannot be matched, and never reaches a permission prompt. It becomes
  policy when a human accepts it in a pull request, and a declined file is never re-proposed. Do not
  describe a proposal as if the rule were now in force.
- **No model runs.** The proposals come from replaying the recorded decisions, so if you cannot point
  at the records behind a clause, do not vouch for it.

If it proposes nothing, that is the normal result on a thin trail. Say so rather than reaching for an
explanation; `--status` shows the last five runs if the question is whether the pipeline is running at
all.
