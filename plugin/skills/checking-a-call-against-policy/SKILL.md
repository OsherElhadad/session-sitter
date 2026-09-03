---
name: checking-a-call-against-policy
description: Find out whether Session Sitter will allow a tool call, and which written clause decides it, BEFORE running it. Use when about to run something plausibly governed — a push, a deploy, a migration, anything touching secrets or infrastructure — or when the user asks what the policy allows, or why a call was denied.
---

# Checking a call against the policy

Run the check. Do not reason about the policy from memory: the corpus changes, and the artifact this
session is pinned to is the only thing that decides.

    node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" explain Bash --command '<the exact command>'

For a tool that is not a shell, pass the whole input instead:

    node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" explain Write --input '{"file_path":"/etc/hosts"}'

Read the result as three facts:

- **WOULD ALLOW** — proceed. The rung says whether a clause allowed it or it was simply read-only.
- **WOULD DENY, with a rewrite** — run the rewritten form. This is the common case and it is not a
  negotiation; the rewrite is what the practices already say is acceptable.
- **WOULD DENY, no rewrite** — stop and tell the user, quoting the clause citation. Do not look for a
  variant that evades the pattern. A clause with a `Match:` line will catch the variant too, and one
  that does not is exactly the clause a human needs to hear about.

**WOULD ASK** means nothing deterministic covers it, so the decision goes to the classifier or back
to the user. Exit code 1 with "no policy is loaded" means no practices are configured — say so
rather than treating it as permission.

This command decides nothing. The `PermissionRequest` hook decides, and it will decide again when you
actually run the call. If the two ever disagree, that is a bug worth reporting — say so rather than
working around it.

To *change* what the policy says, see the `writing-practices` skill. Editing a clause to unblock
yourself is a reviewed change to a git-tracked file, not a workaround.
