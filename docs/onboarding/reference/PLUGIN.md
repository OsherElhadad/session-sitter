# The Claude Code plugin, configured

Session Sitter also ships as a **Claude Code plugin** that governs permission prompts in the
terminal, with no VS Code involved. It shares the practices format and the classifier configuration
with the extension, and nothing else.

Its own knobs are **environment variables** by necessity: a hook is a bare Node process with no VS
Code settings to read and no flags to take.

This is a configuration reference. The mechanism — which hook governs which calls, the decision
ladder, the correction lane, the audit trail — is [`../../PLUGIN.md`](../../PLUGIN.md).

---

## Install

```bash
/plugin marketplace add eranra/session-sitter
/plugin install session-sitter@session-sitter
```

Or, to try it from a checkout without installing:

```bash
claude --plugin-dir /path/to/session-sitter/plugin
```

Then point it at a practices file and restart the session:

```bash
export SESSION_SITTER_PRACTICES=/path/to/practices.md
```

**One thing to check before concluding it does nothing:** if `permissions.defaultMode` is `auto`,
nothing prompts, so the decision ladder never runs. Use `--permission-mode manual` to see it work.

---

## Say this before turning `enforce` on

**With no practices file and no classifier, `enforce` denies every call that is not
deterministically safe** — every `Write`, every `Edit`, every command outside the safe list. That is
the principle working as designed, and it is not a useful first five minutes.

Start with a practices file, or start in `observe` mode. Both are one variable.

---

## The variables

| Variable | Default | What it does |
|---|---|---|
| `SESSION_SITTER_PRACTICES` | — | Path to a single practices markdown file. The simplest setup. |
| `SESSION_SITTER_MODE` | `enforce` | `enforce` applies the whole ladder, fail-closed included. `observe` records every decision but returns no verdict for the ambiguous case, handing it back to Claude Code and to Auto mode. |
| `SESSION_SITTER_CLASSIFIER` | `off` | Whether an ambiguous call may spawn the classifier CLI. Off by default: paying for a subprocess and a model round trip in front of a live prompt is the operator's call. |
| `SESSION_SITTER_PRETOOL` | `on` | Whether the `PreToolUse` hook enforces red clauses on calls Claude Code never prompts about. On by default, because a clause governing only the calls that would have prompted you anyway is not the promise this plugin makes. |
| `SESSION_SITTER_ESCALATE` | `off` | Whether the last rung **asks a human** before it fails closed. Off by default, and not out of timidity: it holds the agent still for up to `SESSION_SITTER_ESCALATE_WAIT` seconds, and it only works when a `session-sitter daemon` is running to deliver the question. Turning it on asserts both. |
| `SESSION_SITTER_ESCALATE_WAIT` | `45` | Seconds that rung waits for an answer. Capped at 55, below the hook event's own 60-second budget — a hook killed mid-wait returns no JSON at all, which Claude Code reports as a hook **error** rather than as a decision. |
| `SESSION_SITTER_PERSIST_RULES` | `off` | Whether an allow made by a written green clause may return a **generalised** standing permission rule derived from that clause. Off by default — a plugin that silently edits your permission rules is a bad citizen. |
| `SESSION_SITTER_RULE_DESTINATION` | `session` | Where such a rule is written: `session` (in memory), `localSettings`, `projectSettings`, `userSettings`. An unrecognised value falls back to `session`. |
| `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM` | — | The knowledge-routing triple, for the three-tier layout. |
| `SESSION_SITTER_DATA_DIR` | `${CLAUDE_PLUGIN_DATA}`, else `~/.claude/session-sitter/` | Where the audit trail and session records go. |

Everything the classifier needs — `SUPERVISOR_ENGINE`, `BOB_CLI_PATH`, `CLAUDE_CLI_PATH`,
`CLAUDE_TIMEOUT_SECONDS`, and the knowledge repo variables — comes from the existing supervisor
configuration. See [`ENVIRONMENT.md`](ENVIRONMENT.md).

### Why `PRETOOL` defaults on and `PERSIST_RULES` defaults off

Worth explaining rather than just stating, because the asymmetry looks arbitrary.

`SESSION_SITTER_PRETOOL` has exactly two outcomes: a denial citing a matched red clause — the same
verdict `PermissionRequest` would give the same call — or no decision at all. It cannot approve
anything, so `on` is safe. `off` is the conservative choice, not the correct one: with it off, a
written clause governs only the calls that would have raised a prompt anyway, and reading a project
`.env` raises none.

`SESSION_SITTER_PERSIST_RULES` writes to your permission configuration. That is not the plugin's to
do quietly, so it is opt-in, and the dialog's literal `permission_suggestions` are never echoed
back — only a generalised rule derived from a clause you wrote.

`SESSION_SITTER_ESCALATE` is off for a third reason again: it makes two claims on the user's behalf.
It holds the agent still for up to 45 seconds, and it depends on a `session-sitter daemon` running
somewhere to deliver the question — a hook cannot poll Telegram itself, because a hook runs once per
prompt and a bot token may only have one reader. Turning it on without a daemon means the wait always
expires.

---

## The practices file

Markdown, in the project's BDI bottom-line schema, so a file already written for the extension works
here unchanged. What the plugin adds is a **citable clause id** and a `Match:` line that makes a
clause act.

```markdown
### Intention: Never force-push to a shared branch

| Field | Value |
|---|---|
| id | team-git-002 |
| level | red |
| tags | git, history |

Match: `/git\s+push\b.*(--force(?!-with-lease)|\s-f\b)/`, `/git\s+push\b.*--delete/`

Rewriting history on a branch other people build on destroys their work. Push a new commit, or use
`--force-with-lease` on a branch only you build on.
```

| Field | Effect |
|---|---|
| `id` | **The citation**, cited as `practices §team-git-002` in the denial and in the trail. Without one it falls back to a leading number in the title, then to a slug of the title — so retitling a clause silently changes its own citation. Set it explicitly. |
| `level` | `red` denies · `green` allows · `yellow` / `orange` are context for the classifier only |
| `Match:` | Comma-separated patterns: a plain **substring**, matched case-insensitively with whitespace loosened, or a `/regex/flags` literal. Backtick a pattern containing a comma. **Without this line the clause decides nothing.** |
| The body | Shown to the user under the denial. Write the explanation you would give in review. |

The haystack is the tool name plus its arguments as JSON, so `Bash` commands, `Write` paths and
`WebFetch` URLs are all matchable.

**Two traps worth naming, because both produce a file that looks correct:**

- **A clause with a `level` and no `Match:` enforces nothing.** It reaches the classifier as prose
  and cannot deny on its own. `/session-sitter:policy` reports that as an `error` finding — it is the
  most expensive failure this format has.
- **A plain substring is a substring.** `Match: git push --force` also matches
  `git push --force-with-lease`. Because a corrected call is re-checked against your red clauses
  before it is allowed, such a clause vetoes the very rewrite the correction lane just made, and the
  correction comes back as a denial — the lane looks broken. Use the negative lookahead:
  `/git\s+push\b.*--force(?!-with-lease)/`.

For a team policy shared across projects, use the three-tier knowledge layout — team, then project,
then user, narrowest winning — via `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM` plus
`KNOWLEDGE_LOCAL_REPO`. It is the same loader the extension uses:
[`../../KNOWLEDGE.md`](../../KNOWLEDGE.md).

---

## Check it before trusting it

```bash
/session-sitter:policy /path/to/practices.md --replay
/session-sitter:explain Bash --command 'git push --force origin main'
```

`policy` lints the file; an `error` finding is a clause that enforces nothing while looking like it
does. `--replay` re-decides your recorded decisions with the edited file and prints only the verdicts
that **change**, so a policy change's blast radius is visible before you ship it.

`explain` answers "what would happen, and which clause decides?" without running the call, without a
model call, and without writing a record. It calls the hook's own loader, matcher and selector — not
a second evaluator — so what it says and what the hook does cannot disagree. The same command runs as
`session-sitter policy explain …` with no `claude` session at all, which is the CI and SSH path.

Full flags and the `--json` contracts: [`../../CLI.md`](../../CLI.md#policy-explain).

---

## Related skills

The plugin ships three skills of its own, which do different jobs from this one:

| Skill | For |
|---|---|
| `writing-practices` | authoring or editing the practices file — the clauses themselves |
| `checking-a-call-against-policy` | asking what a call would do before running it |
| `reading-the-audit-trail` | reading the decisions the plugin recorded |

This skill configures Session Sitter. Those three use what it configured.
