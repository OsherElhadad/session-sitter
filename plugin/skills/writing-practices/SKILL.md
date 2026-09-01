---
name: writing-practices
description: Write or edit a Session Sitter practices file — the markdown that decides permission prompts. Use when the user wants to add a rule, block a command, allow something without approval, set up a practices file, or asks why a clause did not fire.
---

# Writing a practices file

A practices file is markdown. Session Sitter reads it on every permission prompt and every decision
it makes names the clause it applied, so the file is both the policy and the explanation.

The format is the project's existing BDI bottom-line schema (`docs/KNOWLEDGE.md`), so a file already
written for the VS Code extension works here unchanged. What the plugin adds is **matching**: a
clause becomes deterministic when its body carries a `Match:` line.

## The shape of a clause

```markdown
### Intention: Never force-push to a shared branch

| Field | Value |
|---|---|
| id | team-git-002 |
| level | red |
| tags | git, history |

Match: `git push --force`, `/git\s+push\b.*--delete/`

Rewriting history on a branch other people build on destroys their work. Push a new commit instead.
```

- **The heading** is `### Belief:`, `### Desire:` or `### Intention:` followed by the title. A clause
  under any other heading is ignored, so prose between clauses is free.
- **`id`** is the citation. That clause is cited as `practices §team-git-002` in the denial the user
  sees and in the audit trail. Without an `id`, the id falls back to a leading number in the title
  (`### Intention: 4. …` → `practices §4`) and then to a slug of the title. Set it explicitly — a
  retitled clause otherwise silently changes its own citation.
- **`level`** decides the lane:
  - `red` → deny the call, citing this clause.
  - `green` → allow the call without asking, citing this clause. This is what lets an overnight run
    proceed instead of stalling.
  - `yellow` / `orange` → context for the classifier only. Neither denies nor allows deterministically.
- **`Match:`** is what makes the clause act. Without it the clause is still loaded and still reaches
  the classifier as prose, but **it can never decide anything on its own.** That is the single most
  common mistake, and `/session-sitter:policy` reports it as an error.
- **The body** is shown to the user underneath the denial, so write it as the explanation you would
  give in review, not as a restatement of the title.

## Writing a `Match:` line

Comma-separated patterns. Two forms:

- **A plain substring**, matched case-insensitively, with whitespace loosened — `git push --force`
  also matches `git  push   --force`. Prefer this. Wrap a pattern containing a comma in backticks.
- **A `/regex/flags` literal** when a substring is not enough — `/git\s+push\b.*--delete/`.

The haystack is the tool name plus its arguments as JSON, so `Bash` commands, `Write` file paths and
`WebFetch` URLs are all matchable. A pattern that matches nothing fails silently, which is why every
edit should end with `/session-sitter:policy <file> --replay`.

## Ordering, and what beats what

1. A read-only tool or a safe command is allowed before any clause is consulted.
2. A correction rule rewrites the call if one applies — and the **rewritten** call is re-checked
   against the red clauses, so a rewrite cannot get past a deny.
3. Red clauses, narrowest tier first (user, then project, then team).
4. Green clauses, same order.
5. The built-in destructive-action table, for teams that have written nothing.

Red beats green at every tier, so a green clause can never re-permit something a red clause forbids.
Written clauses beat the built-in table, which is how a team allows `rm -rf ./build` deliberately.

## Where the file goes

Either is fine:

- **One file**, pointed at directly: `SESSION_SITTER_PRACTICES=/path/to/practices.md`. Simplest, and
  the right choice for one repository.
- **Three tiers** in a knowledge repo, layered team → project → user, routed by
  `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM` plus `KNOWLEDGE_LOCAL_REPO`. Use this when several
  projects share a team policy. See `docs/KNOWLEDGE.md`.

## Before you finish

Always run the linter on the file you wrote and report what it says:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/policy/cli.js" check <file> --replay
```

An `error` means a clause claims a level but cannot match anything. Fix it before saying the rule is
in place — a red clause that enforces nothing is worse than no clause, because someone believes it
is working.
