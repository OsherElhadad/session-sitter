---
description: What would Session Sitter do with this call, and which clause decides it?
argument-hint: <tool> --command '<cmd>' | --input '<json>'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" explain $ARGUMENTS`

Show that output verbatim. The clause text is the corpus's, at the revision named — do not paraphrase
it, and do not re-derive the verdict yourself. If it says WOULD DENY and names a rewrite, the useful
next step is the rewritten command, not an argument about the rule.

This command decides nothing: it writes no record and returns no verdict. The `PermissionRequest`
hook decides, and it decides again when the call actually runs.
