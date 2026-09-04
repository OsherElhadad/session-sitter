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
- **A proposed directory clause is a textual guard, not a filesystem one.** It matches the path string
  a `Write`, `Edit`, `MultiEdit` or `NotebookEdit` was asked for, never the file that string resolves
  to, so a symlink out of the tree defeats it. Never describe one as confining writes to a directory;
  `assertWritable` is the only filesystem boundary here. `docs/KNOWLEDGE.md` says it at length.

If it proposes nothing, that is the normal result on a thin trail. Say so rather than reaching for an
explanation; `--status` shows the last five runs if the question is whether the pipeline is running at
all.
