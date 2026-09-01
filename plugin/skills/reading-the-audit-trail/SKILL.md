---
name: reading-the-audit-trail
description: Read and interpret the Session Sitter audit trail — what agents were allowed to do, which clause was applied, who decided, and how long it took. Use when the user asks what happened overnight, why a call was denied or rewritten, which rules are firing, or wants to export the decision log.
---

# Reading the audit trail

Two append-only JSONL files under the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`, or
`~/.claude/session-sitter/` when the plugin is loaded session-only). Both are rotated at 4 MiB, with
one previous generation kept as `<name>.jsonl.1`.

Read them through the CLI rather than by hand — it already merges the rotated generation, skips
malformed lines, and filters:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" log --since 24h --denied
node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" digest --since 24h
node "${CLAUDE_PLUGIN_ROOT}/lib/audit/cli.js" status
```

`--json` and `--csv` are there for handing the log to someone else. `/session-sitter:log`,
`:digest` and `:status` are the same three commands.

## `decisions.jsonl` — one record per permission decision

| Field | Read it as |
|---|---|
| `ts` | ISO timestamp, UTC |
| `sessionId` | joins to `status`, and to the session files under `sessions/` |
| `cwd` | which repository the agent was in |
| `tool` | the Claude Code tool name — `Bash`, `Write`, `Edit`, … |
| `inputSummary` | the command or path, **redacted and truncated to 300 characters**. Never the raw input. |
| `light` | `green` allowed · `yellow` corrected · `red` denied · `null` no light was assigned |
| `decision` | `allow` or `deny` — what Claude Code was actually told |
| `clause` | the citation, e.g. `practices §team-git-002`, or `null` when no written clause applied |
| `actor` | who decided (below) |
| `latencyMs` | how long the hook took. The deterministic path is single-digit. |
| `rewritten` | true when the correction lane replaced the tool input |
| `note` | one human-readable line — usually the most useful field in the record |

**`actor` is the field that answers "who decided this":**

- `deterministic` — a read-only tool, a safe command, or the built-in destructive-action table. No
  model was involved.
- `policy` — a written clause or a correction rule. `clause` names it.
- `model` — the classifier tier ran. Only present when the classifier is enabled.
- `human` — a person answered an escalation.
- `timeout` — **no verdict arrived**, so the call was denied. Either nothing was configured to decide
  it, or the classifier was unreachable, or the practices file could not be read. `note` says which.

A run full of `timeout` denials is not a run full of unsafe calls — it is a policy gap. Say that
plainly rather than reporting it as risky agent behaviour.

## `activity.jsonl` — one record per tool result, and per wait

Two record shapes share this file:

- **Tool results**: `tool`, `fingerprint` (a 12-character hash of the input — the input itself is
  never stored), `ok`. Several consecutive records with the same `fingerprint` and `ok: false` is the
  signature of a wedged agent, which is the reason this file exists.
- **Waits**: `waiting` (`idle_prompt` or `permission_prompt`) and a bounded `message`. The gap between
  a wait record and the next decision is how long a human was waited on — the number an "it ran
  unattended" claim stands or falls on.

## What the trail cannot tell you

- **Whether the tool succeeded at what the user wanted.** It records the decision, not the outcome.
- **The exact original input.** Summaries are redacted and truncated on purpose, so a replay through
  `policy check --replay` is approximate for a long command.
- **Anything that never reached a prompt.** `PermissionRequest` fires only when Claude Code was about
  to ask. A call auto-approved by a permission rule in settings, or one made in a mode that does not
  ask, leaves no decision record. An empty trail can mean nothing was governed, not that nothing
  happened.
