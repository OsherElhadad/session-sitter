# Permission matching: three features, and what was actually verified

**Date:** 2026-09-02
**Status:** Implemented and verified against the real binary
**Binary:** `claude` **v2.1.252**
**Contract source:** `https://code.claude.com/docs/en/hooks` (fetched 2026-09-02, 316,963 bytes)

Input for this work: `docs/superpowers/specs/2026-09-02-feature-research.md`. Design record for the
plugin itself: `docs/superpowers/specs/2026-09-01-claude-code-plugin-design.md`. User-facing
documentation: `docs/PLUGIN.md`.

## Verification method

Everything below is real hook I/O from a real `claude` session, not a hand-fed payload.

- Isolated `CLAUDE_CONFIG_DIR`, isolated scratch project, no git remote, invented content only. The
  user's own `~/.claude/settings.json` was never written to and `/plugin install` was never run.
- Each hook command was wrapped in a shim that `cat`s stdin to a file, pipes that file into the real
  hook, and `tee`s the hook's stdout to a second file. Both files are verbatim.
- **`PermissionRequest` does not fire in `-p` (headless) mode on v2.1.252.** Confirmed again here:
  `SessionStart` and `PostToolUse` hooks registered the same way fired and wrote their records, while
  `PermissionRequest` produced nothing across four `-p` runs, whether registered through
  `--plugin-dir` or through the isolated `settings.json`. The docs say hooks still run in sessions
  that cannot prompt. They do not. `docs/PLUGIN.md` already carried this limitation from the earlier
  verification round; it is unchanged.
- So every capture below comes from an **interactive** session driven through a pty
  (`script -q /dev/null claude --permission-mode default`).

Two incidental observations from the real runs, both corroborating the research:

- Claude Code v2.1.252 *does* split compounds for its own ask decision — it reported *"This Bash
  command contains multiple operations. The following part requires approval: npm publish"*. But it
  still allowed the whole of `echo "total: $((2 + 2))" && git status` with no permission request at
  all once `Bash(echo:*)` was in `permissions.allow`, which is [#30519]'s prefix-matching hole
  reproduced live.
- The dialog's own "always allow" suggestion for `npm test` was `Bash(npm test *)`, and for
  `git status && npm publish` it was `Bash(npm publish *)` — the over-broad suggestion of [#29187].

## 1. Compound-command permission matching

Closes [#25441], [#30519], [#28240]. Code: `src/policy/shell.ts`, and `decideDeterministically` /
`combine` in `src/hooks/permissionRequest.ts`.

### Captured: a compound denied, with the sub-command named

Real hook stdin:

```json
{
  "session_id": "3efb4e71-85d7-46aa-8d18-85859d7c0d37",
  "transcript_path": "/tmp/ss-perms/cfg/projects/-private-tmp-ss-perms-proj/3efb4e71-85d7-46aa-8d18-85859d7c0d37.jsonl",
  "cwd": "/private/tmp/ss-perms/proj",
  "prompt_id": "c11a250b-67dc-408a-b0c9-d63e517dfe7d",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "git status && npm publish",
    "description": "Show git status then npm publish"
  },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "npm publish *" }],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ]
}
```

Real hook stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "denied — practices §no-publish: Never publish a package from an agent session\n\nPublishing is irreversible and belongs to a human with a changelog in front of them.\n\nThis call runs 2 commands; sub-command 2 of 2 is the one that matched: npm publish"
    }
  }
}
```

The head of the line (`git status`) is deterministically safe and would have cleared on its own. The
tail is what decided it, and the message says which one and where. Note also that no
`updatedPermissions` appears on a deny.

### Captured: fail-closed on a construct the splitter will not vouch for

Real hook stdin:

```json
{
  "session_id": "f9d50588-1df7-4c9f-b871-b557e04bd287",
  "cwd": "/private/tmp/ss-perms/proj",
  "prompt_id": "1db412ab-aa2f-405e-a563-47494f93cb6b",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test -- --shard=$((1 + 1))",
    "description": "Run npm test with shard 2"
  },
  "permission_suggestions": []
}
```

Real hook stdout (message elided at the ellipsis for length; the parenthetical is verbatim):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Session Sitter denied this call because the supervisor could not reach a verdict, and silence is not approval. … \n\n(shell: arithmetic expansion $(( )))"
    }
  }
}
```

A green clause `Match: npm test` was loaded and would have matched this string. The fail-closed rule
outranks it, and the message names the command line as the reason rather than the practices. This is
the honest cost of failing closed, stated in `docs/PLUGIN.md` rather than hidden.

### Unit-tested only

The other shapes are covered in `src/test/policy/shell.test.ts` (21 tests) and the compound section of
`src/test/hooks/permissionRequest.test.ts`: every separator including `|&` and newline, `$(…)`,
backticks, process substitution, nesting to the depth cap, quoting tricks (`git status; echo "a && b"`
must not split inside the literal), unbalanced quotes, unterminated substitutions, subshell/group
punctuation, heredoc over-splitting, the green-clause laundering hole, and the false-deny direction
(`npm ci && npm test` must be exactly as ambiguous as `npm ci` alone, never blanket-denied).

## 2. Generalised `updatedPermissions`

Closes [#6850], [#11380], and the other direction of [#29187]. Code: `src/policy/generalise.ts`.

### Captured: the derived rule instead of the literal one

Real hook stdin — note the dialog's own suggestion, which is the bug:

```json
{
  "session_id": "c7b5bc56-81eb-497a-b85c-926f0b905e6f",
  "cwd": "/private/tmp/ss-perms/proj",
  "prompt_id": "c2c188ab-566f-4dae-9259-edbf572d1798",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test", "description": "Run npm test" },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "npm test *" }],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ]
}
```

Real hook stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        {
          "type": "addRules",
          "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }],
          "behavior": "allow",
          "destination": "session"
        }
      ]
    }
  }
}
```

And the real audit record for the same call:

```json
{
  "ts": "2026-09-01T15:49:30.851Z",
  "sessionId": "c7b5bc56-81eb-497a-b85c-926f0b905e6f",
  "cwd": "/private/tmp/ss-perms/proj",
  "tool": "Bash",
  "inputSummary": "npm test",
  "light": "green",
  "decision": "allow",
  "clause": "practices §tests-are-free",
  "actor": "policy",
  "latencyMs": 4,
  "rewritten": false,
  "note": "allowed — practices §tests-are-free: Running the test suite needs no approval — standing rule Bash(npm test:*) written to session, derived from practices §tests-are-free"
}
```

The clause said `Match: npm test`; the emitted rule is the prefix `Bash(npm test:*)`, strictly narrower
than the clause (which matches its substring anywhere), and the record cites the clause it came from.

### Unit-tested only

`src/test/policy/generalise.test.ts` (11 tests) pins the derivation and, more importantly, the eight
cases that must emit nothing: a red clause, a regex matcher, a substring that matched mid-command, a
prefix that stops mid-word, a compound, an unsplittable line, a non-`Bash` tool, and an input with no
command. `src/test/hooks/permissionRequest.test.ts` adds the end-to-end guards: nothing by default,
nothing for a deterministic-tier allow (no clause), nothing for a correction, nothing for a deny,
nothing for a compound, and the destination fallback.

## 3. Guarding the agent's own permission configuration

Code: `src/hooks/configChange.ts`. No issue closes here — this one comes from the ecosystem evidence
(`Pantheon-Security/medusa`, 973 stars; `synthesisengineering/claude-settings-guard`).

### The contract matched the documented one

Verified against `https://code.claude.com/docs/en/hooks` on 2026-09-02. Every claim in the research
spec held, with one clarification worth recording:

| Claim | Verdict |
|---|---|
| Event name `ConfigChange` | Correct |
| Matchers `user_settings \| project_settings \| local_settings \| policy_settings \| skills` | Correct |
| Input carries `source` and optionally `file_path` | Correct |
| Blocks with `{"decision": "block"}` | Correct — and it is a **top-level** `decision`, not a `hookSpecificOutput.decision` as `PermissionRequest` uses. The docs list `ConfigChange` in the "Top-level `decision`" row. |
| `policy_settings` changes cannot be blocked | Correct, verbatim: "any blocking decision is ignored. This ensures enterprise-managed settings always take effect." |
| A blocked change surfaces no message | Correct, verbatim: "A blocked change surfaces no message to you or to Claude, whether you block with `reason` or with stderr on exit 2. Claude Code only writes a line to the debug log." |
| `reason` | Documented as "Accepted but never shown". Sent anyway, for the debug log. |

The input carries no before/after content, which is why the hook keeps its own snapshot of the last
accepted permission shape.

### Captured: baseline, then a block

Two real `ConfigChange` events from one interactive session in which the agent edited
`.claude/settings.json` twice. The stdin is verbatim; both events carry the same fields:

```json
{
  "session_id": "37f57337-47b8-427a-afde-5f3610d28ae3",
  "transcript_path": "/tmp/ss-perms/cfg/projects/-private-tmp-ss-perms-proj/37f57337-47b8-427a-afde-5f3610d28ae3.jsonl",
  "cwd": "/private/tmp/ss-perms/proj",
  "prompt_id": "756102b6-1743-46c9-b323-38df2788725d",
  "hook_event_name": "ConfigChange",
  "source": "project_settings",
  "file_path": "/private/tmp/ss-perms/proj/.claude/settings.json"
}
```

First event — no snapshot yet, so it becomes the baseline. Real stdout:

```json
{}
```

Second event — `permissions.allow` gained `Bash(curl:*)`. Real stdout:

```json
{
  "decision": "block",
  "reason": "Session Sitter blocked this change to /private/tmp/ss-perms/proj/.claude/settings.json because it widens what the agent may do: permissions.allow gained \"Bash(curl:*)\"."
}
```

Both real audit records, which are the only place a human can see either decision:

```
allow | built-in §config-guard | recorded — first observation of project_settings; nothing to compare against, so this shape is now the baseline
deny  | built-in §config-guard | blocked — project_settings widened the agent's own permissions: permissions.allow gained "Bash(curl:*)"
```

### Unit-tested only

`src/test/hooks/configChange.test.ts` (25 tests): the three widening kinds, the mode ranking including
`manual` as an alias for `default` and an unknown mode ranking widest, narrowings allowed, the
snapshot deliberately not advancing on a block, the baseline advancing on an allow, `policy_settings`
never blocked, an unreadable file allowed, an unparseable file blocked, `skills` and a missing
`file_path` recorded and allowed, and all three settings sources adjudicated independently.

## What is not verified

- **Nothing here is verified on the headless `-p` path**, because `PermissionRequest` is not emitted
  there on v2.1.252. `ConfigChange` on the headless path was not exercised either.
- **`updatedPermissions` writing to a settings *file* is not verified.** The captured run used
  `destination: "session"`, the default. The three file destinations are documented platform values,
  passed through unchanged; that Claude Code writes them to the right file is taken from the docs.
- **The block's effect on the running session is not directly observed.** The hook returned
  `{"decision": "block"}` and the platform surfaces nothing, by design, so there is no observable
  signal beyond the file staying un-applied — and the file on disk keeps the change either way.
- **Subagents in Agent Teams remain uncovered.** [#23983] is open: `PermissionRequest` hooks are not
  triggered for subagent permission requests there. Unchanged by this work.

[#6850]: https://github.com/anthropics/claude-code/issues/6850
[#11380]: https://github.com/anthropics/claude-code/issues/11380
[#23983]: https://github.com/anthropics/claude-code/issues/23983
[#25441]: https://github.com/anthropics/claude-code/issues/25441
[#28240]: https://github.com/anthropics/claude-code/issues/28240
[#29187]: https://github.com/anthropics/claude-code/issues/29187
[#30519]: https://github.com/anthropics/claude-code/issues/30519
