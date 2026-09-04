# The Claude Code plugin

Session Sitter ships as a Claude Code plugin as well as a VS Code extension. Same engine, different
front end: the extension shows you a panel, the plugin answers permission prompts.

**What it is:** agent governance for the terminal. Your team's written practices decide every
permission prompt — and their red clauses stop the calls that never raise one — unsafe calls are rewritten into safe ones instead of blocked, and every decision
lands in an audit trail that names the clause it applied.

**The principle:** *silence is never approval.* When nothing can reach a verdict, the answer is no.

---

## Install

```bash
/plugin marketplace add eranra/session-sitter
/plugin install session-sitter@session-sitter
```

To try it without installing anything, load it for one session from a checkout:

```bash
claude --plugin-dir /path/to/session-sitter/plugin
```

Then point it at your practices file and restart the session:

```bash
export SESSION_SITTER_PRACTICES=/path/to/practices.md
```

If your `permissions.defaultMode` is `auto`, nothing prompts, so the whole decision ladder below
never runs — run with `--permission-mode manual` to see it work. (`default` was renamed; it is no
longer among the choices `claude --help` lists.)

### The `session-sitter` command comes with it

The plugin ships the whole terminal front end at `lib/cli/index.js`, so the slash commands below are
backed by the same code `docs/CLI.md` documents — `status`, `log`, `digest`, `policy`, `learn` and
`export`, not a reduced set.

To get it on your `PATH`, symlink the launcher the plugin ships:

```bash
mkdir -p ~/.local/bin
ln -sf "$(ls -d ~/.claude/plugins/cache/*/session-sitter/*/bin/session-sitter | tail -1)" \
       ~/.local/bin/session-sitter
session-sitter --version
```

The install path is version-stamped, so **that symlink breaks the next time the plugin updates** and
you re-run the same command. The launcher resolves its own symlinks, so when it does break it says
which path it resolved to and prints the re-link command, rather than failing with a Node module
error.

If you would rather not depend on a plugin path at all, the command installs on its own — no
extension, no plugin, no registry account:

```bash
npx github:eranra/session-sitter status      # no install
npm i -g github:eranra/session-sitter        # or on PATH for good
```

Both build on the way in (`out/` is not committed), so they need a toolchain but no clone.

---

## Which calls does which hook govern

This distinction is load-bearing, and getting it wrong is how a clause looks enforced and is not.

**Claude Code does not prompt for every tool call.** Reading a file inside the project — including a
`.env` — is allowed with no prompt at all, even under `--permission-mode manual` with nothing in your
`allow` rules. `PermissionRequest` stands in front of a *prompt*, so for a call that raises no prompt
it is never invoked, and a clause enforced only there never fires. That was verified in a live
session, not inferred: `cat .env` and a `Read` of the same path both succeeded and
`PermissionRequest` was not called once.

So there are two hooks, with two different jobs:

| | `PermissionRequest` | `PreToolUse` |
|---|---|---|
| Fires on | only calls Claude Code was going to prompt you about | **every** tool call |
| Can answer | allow, deny, or allow-with-the-call-rewritten | deny, or nothing |
| Reaches for a model | yes, on rung 6, when you turn the classifier on | **never** |
| When it cannot decide | **denies** — it costs one prompt, and silence is not approval | **returns no decision** — it is in front of every call in the session, so denying here would deny the session |
| Rungs it applies | all seven | a matched red clause, or the built-in destructive table. Nothing else. |

`PreToolUse` covers every route to the same content, because it matches the tool name and its
arguments the same way the rest of the ladder does: one clause matching `.env` denies `Bash
{"command":"cat .env"}`, `Read`, `Grep`, `Glob`, `NotebookRead`, `Write` and `Edit` without naming
any of them. That matters — a clause forbidding secrets is defeated if `grep -r AWS_SECRET .` still
works.

Two things it deliberately does not do:

- **It cannot rewrite a call.** `PreToolUse` has no `updatedInput`, only allow/deny/ask. So when a
  correction rule would fire it stands aside and leaves the rewrite to `PermissionRequest`. The
  honest consequence: a correctable call that Claude Code allows without prompting is not corrected.
- **It never returns `allow`.** An allow there would suppress the prompt you wanted and skip
  `PermissionRequest` entirely. No decision is the correct neutral, and it is what this hook returns
  for the overwhelming majority of calls.

Your written **green** clauses still outrank the built-in table here, so a team that wrote
`rm -rf ./build` as green keeps it. Turn the whole hook off with `SESSION_SITTER_PRETOOL=off`.

---

## What each hook does

| Hook | Job | Budget |
|---|---|---|
| `PermissionRequest` | **The governance decision** for a call Claude Code was going to prompt about. Allow, deny with the clause cited, or allow with the call rewritten. Writes the audit record. | 60 s allowed; measured p50 **64 ms** per process, of which 3 ms is the decision |
| `PreToolUse` | **The red clauses on calls that never prompt.** Fires on every tool call, denies only on a matched red clause or the built-in destructive table, and returns no decision for everything else. Cannot rewrite a call and never calls a model. | 10 s allowed; measured p50 **65 ms** per process for the no-decision case, max 89 ms over 50 spawns — almost all of it Node startup |
| `ConfigChange` | **Guards the agent's own permission configuration.** Blocks a settings change that widens what the agent may do, allows a narrowing, records both. | 5 s |
| `SessionStart` | Registers the session — id, cwd, pid, name, model, host — so a bare terminal session is visible and the audit knows whose decision a record is | 5 s |
| `PostToolUse`, `PostToolUseFailure` | Appends the minimum a wedge detector needs: tool, a hash of the input, success or failure, timestamp. The input itself is never stored. | 5 s |
| `Notification` | Records `idle_prompt` and `permission_prompt`, so the trail knows how long a human was waited on. **It cannot answer anything** — the event accepts no decision. | 5 s |
| `SessionEnd` | Stamps the session's record with an end time, the reason, and its decision counts | 2 s (the event's whole budget is 1.5 s) |

## The decision ladder

`PermissionRequest` takes the first rung that holds. It runs only for a call that would have
prompted you; `PreToolUse` applies rungs 3 and 5 to the rest (see above). Rungs 1–5 spawn nothing and consult no model — measured p50 64 ms per hook process against
11–17 s when the classifier runs (`node scripts/time-permission-hook.js`, and
`docs/superpowers/plans/2026-09-01-plugin-verification.md` §5).

1. **Deterministic green.** A read-only tool, or a safe non-mutating shell command. Allow.
2. **The correction lane.** A correction rule rewrites the call into its safer form — `git push
   --force` becomes `git push --force-with-lease`. Allow with `updatedInput`, citing the clause. The
   **rewritten** input is re-checked against your red clauses first, so a rewrite can never get a
   denied call through.
3. **A written red clause matches.** Deny, citing the clause.
4. **A written green clause matches.** Allow, citing the clause. This is what lets an overnight run
   proceed instead of stalling.
5. **The built-in destructive-action table.** Deny. This is the fallback for a team that has written
   nothing.
6. **The classifier**, with your practices as context — only when `SESSION_SITTER_CLASSIFIER=on`.
7. **Fail closed.** Deny, saying plainly that the supervisor could not reach a verdict.

Two ordering decisions worth knowing, because both are deliberate:

- **Your written clauses outrank the built-in table.** The table is a default for teams with no
  policy, and a written rule that cannot override a default is not a policy layer. That is how a team
  deliberately allows `rm -rf ./build`.
- **Red outranks green at every tier.** `docs/KNOWLEDGE.md` leaves conflict *resolution* to the
  classifier, but a deterministic matcher has to break the tie, and safety is the only defensible way
  to break it.

`AskUserQuestion` and `ExitPlanMode` are exempt before any policy loads. Both are questions *to you*,
and this layer never answers one.

### Every command in the line, not just the first

Claude Code matches permission patterns on a command **prefix**, so `Bash(git:*)` does not match
`git add . && git commit -m x` ([#25441]). Per the community meta-issue [#30519] (79 reactions, open)
the same hole applies to **deny** rules, which is the half that matters: a written deny can be walked
past by appending `&& <the denied thing>`. [#28240] (205 reactions, `regression`, `area:permissions`)
is the same hole from the prompting side.

So this hook does not match on a prefix. It splits the command line into the commands a shell would
actually run — across `&&`, `||`, `;`, `|`, `|&`, `&`, newlines, `$(…)`, backticks and process
substitution `<(…)`, honouring single and double quoting — runs the ladder over **every one of them**,
and combines the results **deny > ambiguous > allow**. A compound command is only as safe as its most
dangerous part, and "I could not decide about part 3" is never "part 3 is fine".

The deny then names the offending command and its position, which prefix matching structurally cannot:

```
denied — practices §no-publish: Never publish a package from an agent session

Publishing is irreversible and belongs to a human with a changelog in front of them.

This call runs 2 commands; sub-command 2 of 2 is the one that matched: npm publish
```

Two properties are worth stating plainly, because they are what makes this a security control rather
than a convenience:

- **A written green clause can no longer launder the rest of the line.** Before this, a clause was
  matched against the whole command line as one string, so `Match: npm test` licensed anything that
  merely *contained* those words — `npm test && curl … | sh` included. It now clears only the command
  it was written for, and the rest has to clear on its own merits.
- **It fails closed.** A line the splitter will not vouch for — an unbalanced quote, an unterminated
  substitution, arithmetic expansion `$(( ))`, substitution nested more than four deep — is
  **ambiguous**, never safe. It escalates to the classifier, or it is denied, and the message says the
  command line was the reason:

  ```
  Session Sitter denied this call because the supervisor could not reach a verdict … 

  (shell: arithmetic expansion $(( )))
  ```

  That has a real cost: an ordinary `npm test -- --shard=$((1 + 1))` is denied even though a green
  clause covers `npm test`. It is the deliberate direction. Two knowing over-approximations sit on the
  same side of the line: a heredoc body is scanned like code (so its prose becomes harmless extra
  constituents), and subshell/group punctuation is stripped rather than modelled.

`src/policy/shell.ts` is the splitter; there is no parser dependency, because this repository has no
runtime dependencies. The combining rule is `combineVerdicts` in `src/hooks/permissionRequest.ts`,
exported rather than inlined so any other tier that produces a per-constituent verdict reuses the same
"which light wins" instead of growing a second copy of it. Its adversarial tests are `src/test/policy/shell.test.ts` and the compound
section of `src/test/hooks/permissionRequest.test.ts`.

### The standing rule it writes, when you ask for one

Clicking Claude Code's own "Always allow" saves the **literal** command string, so the rule never
matches a second time and `settings.local.json` fills with dead one-off entries ([#6850],
45 reactions, open; [#11380], 64 reactions) — or it offers a wildcard far wider than the subcommand
you approved ([#29187], `regression`). Both were observed live while verifying this: the dialog's own
suggestion for `npm test` was `Bash(npm test *)`, and for `git status && npm publish` it was
`Bash(npm publish *)`.

With `SESSION_SITTER_PERSIST_RULES=on`, a call **allowed by a written green clause** comes back with a
`decision.updatedPermissions` derived from that clause instead:

| The dialog would have written | Session Sitter writes | Because the clause said |
|---|---|---|
| `Bash(npm test *)` for `npm test -- --shard=2` | `Bash(npm test:*)` | `Match: npm test` |

The derivation is deliberately narrow, and emits **nothing** — letting the prompt come back — unless
every one of these holds. A too-wide rule is a security hole that outlives the session:

1. A **green clause** allowed the call. Never a deny (`updatedPermissions` is allow-only anyway),
   never the correction lane (a rewrite is per-call), never the deterministic tier (no clause to
   derive from, and it grants that path free every time), never the classifier.
2. The tool is `Bash`.
3. The call is a **single** command. A rule derived from a compound is the very bug above: a prefix
   rule taken from `git status && rm -rf /` would license the `rm` to anything starting with
   `git status`.
4. The clause matcher was written as a **substring**, and the command starts with it on a word
   boundary. A `/regex/` says nothing a prefix rule can express, and a substring that matched in the
   *middle* of a command licenses no prefix at all.

The result is strictly narrower than the clause: the clause allows its substring **anywhere**, the
emitted rule allows it only as a **prefix**. The audit record names both the rule and the clause it
came from:

```
allowed — practices §tests-are-free: Running the test suite needs no approval
  — standing rule Bash(npm test:*) written to session, derived from practices §tests-are-free
```

`destination` is `session` by default — in memory, gone when the session ends. `SESSION_SITTER_RULE_DESTINATION`
moves it to `localSettings`, `projectSettings` or `userSettings`; a value it does not recognise falls
back to `session`. A hook that edits a git-tracked settings file behind your back is a bad citizen, so
`projectSettings` is something you ask for.

---

## Guarding your permission configuration

An agent that can edit `.claude/settings.json` can add itself an allow rule, delete the deny rule that
was stopping it, or set `defaultMode` to `bypassPermissions`. Everything else here is decided by rules
that live in files the agent can write, so this is the escalation path that makes the rest of it
theatre. [medusa](https://github.com/Pantheon-Security/medusa) (973 stars) scans `.claude/` for the
same reason.

The `ConfigChange` hook blocks a change that **widens** what the agent may do, and allows a narrowing.
Three widenings are recognised, and they are the three that grant reach:

- an entry appears in `permissions.allow`;
- an entry disappears from `permissions.deny`;
- `permissions.defaultMode` moves up `plan < default`/`manual` `< acceptEdits < auto < dontAsk <
  bypassPermissions`. A mode the table has never heard of ranks above all of them.

A block looks like this, and every decision — block or allow — lands in `decisions.jsonl` with
`clause: "built-in §config-guard"`:

```json
{"decision":"block","reason":"Session Sitter blocked this change to …/.claude/settings.json because it widens what the agent may do: permissions.allow gained \"Bash(curl:*)\"."}
```

**Why the record matters more here than anywhere else.** The hooks reference is explicit: "A blocked
change surfaces no message to you or to Claude … Claude Code only writes a line to the debug log." Our
record is the only place the block is visible.

Four limits, all recorded rather than papered over:

- **`policy_settings` cannot be blocked.** Documented: "any blocking decision is ignored. This ensures
  enterprise-managed settings always take effect." Those are recorded and allowed through.
- **The first change to a file is always allowed.** The hook is told a file changed, not what it
  changed *from*, so it keeps a snapshot of the permissions it last accepted and diffs against that.
  With no snapshot there is nothing to compare, and blocking on ignorance would block the first
  legitimate edit of every session. The record says `first observation`.
- **A blocked change is still on disk.** Blocking stops the running session from applying it, nothing
  more. So the snapshot is deliberately *not* advanced on a block, and the same widening is blocked
  again next time.
- **`permissions.ask` and `additionalDirectories` are not compared.** Only the three fields above.

[#25441]: https://github.com/anthropics/claude-code/issues/25441
[#30519]: https://github.com/anthropics/claude-code/issues/30519
[#28240]: https://github.com/anthropics/claude-code/issues/28240
[#6850]: https://github.com/anthropics/claude-code/issues/6850
[#11380]: https://github.com/anthropics/claude-code/issues/11380
[#29187]: https://github.com/anthropics/claude-code/issues/29187

---

## The practices file

Markdown, in the project's existing BDI bottom-line schema (`docs/KNOWLEDGE.md`), so a file already
written for the extension works here unchanged. What the plugin adds is a **citable clause id** and a
`Match:` line that makes a clause act.

### A worked example

```markdown
# Bottom line — platform team

Anything outside a `###` entry is ignored, so notes like this one are free.

---

### Intention: Never force-push to a shared branch

| Field | Value |
|---|---|
| id | team-git-002 |
| level | red |
| tags | git, history |

Match: `/git\s+push\b.*(--force(?!-with-lease)|\s-f\b)/`, `/git\s+push\b.*--delete/`

> The first pattern is a regex, and the negative lookahead is load-bearing. A plain
> `Match: git push --force` is a case-insensitive **substring**, so it also matches
> `git push --force-with-lease` — and because a corrected call is re-checked against your red
> clauses before it is allowed, that red clause would veto the very rewrite the correction lane
> just made. The correction would come back as a denial and the lane would look broken.

Rewriting history on a branch other people build on destroys their work. Push a new commit, or use
`--force-with-lease` on a branch only you build on.

---

### Intention: Running the test suite and the build never needs approval

| Field | Value |
|---|---|
| id | team-ci-001 |
| level | green |
| tags | testing |

Match: npm test, npm run build, npx vitest

Both write only into `out/` and `coverage/`, and an overnight run that stalls on them is a run that
did nothing.

---

### Belief: Credentials are referenced by environment variable, never pasted

| Field | Value |
|---|---|
| id | team-sec-001 |
| level | red |

No `Match:` line, so this clause reaches the classifier as prose and **cannot deny anything on its
own**. `/session-sitter:policy` reports that as an error.
```

Given that file, a `git push --force origin main` is denied with:

```
denied — practices §team-git-002: Never force-push to a shared branch

Rewriting history on a branch other people build on destroys their work. Push a new commit, or use
`--force-with-lease` on a branch only you build on.
```

### The fields that matter

| Field | Effect |
|---|---|
| `id` | **The citation.** Cited as `practices §team-git-002` in the denial and in the trail. Without one, the id falls back to a leading number in the title (`### Intention: 4. …` → `practices §4`), then to a slug of the title. Set it explicitly, or retitling a clause silently changes its own citation. |
| `level` | `red` denies · `green` allows · `yellow`/`orange` are context for the classifier only |
| `Match:` | Comma-separated patterns. A plain **substring**, matched case-insensitively with whitespace loosened, or a `/regex/flags` literal. Backtick a pattern containing a comma. **Without this line the clause decides nothing.** |
| The body | Shown to the user under the denial. Write the explanation you would give in review. |

The haystack is the tool name plus its arguments as JSON, so `Bash` commands, `Write` paths and
`WebFetch` URLs are all matchable.

### Check it before you trust it

```bash
/session-sitter:policy /path/to/practices.md --replay
/session-sitter:explain Bash --command 'git push --force origin main'
```

An `error` finding means a clause declares a level but carries no `Match:` line — it enforces
nothing while looking like it does, which is the most expensive failure this format has. `--replay`
re-decides your recorded decisions with the edited file and prints only the verdicts that change, so
you see a policy change's blast radius before you ship it.

### Ask what a call would do, before running it

`/session-sitter:explain` answers "what would happen, and which clause decides?" — the clause, the
rung, the traffic light and the artifact revision — without running the call, without a model call,
and without writing a record.

```console
$ /session-sitter:explain Bash --command 'aws s3 rb s3://ledger-nightly'
WOULD DENY  ·  rung 3 (written red clause)  ·  revision 2b5481a3
  practices §pay-storage-001@2b5481a — Never delete a bucket
  Deleting a bucket takes its contents and its name with it, and the name cannot be reclaimed.
  ↳ source: data/knowledge/teams/payments/bottom-line.md
```

It calls the hook's own loader, matcher and selector — not a second evaluator — so what it says and
what the hook does cannot disagree. Full flags, the `--json` contract and the degradation table are
in [`docs/CLI.md`](CLI.md#policy-explain); the same command runs as
`session-sitter policy explain …` with no `claude` session at all, which is the CI and SSH path.

The `checking-a-call-against-policy` skill wraps the same command for the pre-flight case: an agent
about to write a deploy script asks first, instead of being denied three times mid-file. It carries
no policy logic — a trigger and one command — because a skill that restated the rules would be a
second source of truth about what they are.

Two things it deliberately is **not**:

- **not an authority.** It writes nothing and returns no verdict. The `PermissionRequest` hook is the
  only thing that enforces anything, and it decides again when the call actually runs.
- **not an MCP tool.** A repo-resident `.mcp.json` can declare a server, so a hostile checkout could
  ship one named `session-sitter` whose answer is "green" for everything — the same channel the
  classifier already refuses to read `.claude/settings.json` over. Tool schemas also render *before*
  `system` in every agent request, so they would cost tokens for the session's whole life and
  invalidate the agent's cached prefix on every description edit.

### Three tiers instead of one file

For a team policy shared across projects, use the knowledge repo layout — team, then project, then
user, narrowest winning — via `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM` plus
`KNOWLEDGE_LOCAL_REPO`. See `docs/KNOWLEDGE.md`. It is the same loader the extension uses.

---

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `SESSION_SITTER_PRACTICES` | — | Path to a single practices markdown file. The simplest setup. |
| `SESSION_SITTER_MODE` | `enforce` | `enforce` applies the whole ladder, fail-closed included. `observe` records every decision but returns no verdict for the ambiguous case, handing it back to Claude Code and to Auto mode. |
| `SESSION_SITTER_CLASSIFIER` | `off` | Whether an ambiguous call may spawn the classifier CLI. Off by default: paying for a subprocess and a model round trip in front of a live prompt is the operator's call. |
| `SESSION_SITTER_PRETOOL` | `on` | Whether the `PreToolUse` hook enforces red clauses on calls Claude Code never prompts about. On by default: without it a written clause governs only the calls that would have raised a prompt anyway. Safe as a default because its only two outcomes are a denial citing a matched red clause — the same verdict `PermissionRequest` would give the same call — and no decision at all. |
| `SESSION_SITTER_PERSIST_RULES` | `off` | Whether an allow made by a written green clause may return a **generalised** standing permission rule derived from that clause. Off by default — a plugin that silently edits your permission rules is a bad citizen. The dialog's literal `permission_suggestions` are never echoed. |
| `SESSION_SITTER_RULE_DESTINATION` | `session` | Where such a rule is written: `session` (in memory), `localSettings`, `projectSettings`, `userSettings`. An unrecognised value falls back to `session`. |
| `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM` | — | Knowledge-routing triple for the three-tier layout |
| `SESSION_SITTER_DATA_DIR` | `${CLAUDE_PLUGIN_DATA}`, else `~/.claude/session-sitter/` | Where the trail and session records go |

Everything the classifier needs (`SUPERVISOR_ENGINE`, `BOB_CLI_PATH`, `CLAUDE_CLI_PATH`,
`CLAUDE_TIMEOUT_SECONDS`, the knowledge repo settings) comes from the existing supervisor
configuration — see `docs/CONFIGURATION.md`.

**Read this before turning `enforce` on with nothing configured.** With no practices file and no
classifier, every call that is not deterministically safe is denied — every `Write`, every `Edit`,
every command outside the safe list. That is the principle working as designed, not a bug, but it is
not a useful first five minutes. Start with a practices file, or start in `observe` mode.

---

## The audit trail

Two append-only JSONL files under the data directory, each rotated at 4 MiB with one previous
generation kept as `<name>.jsonl.1`. Every input summary is redacted through the same secret detector
the corpus importer uses (`src/corpus/mask.ts`) and truncated to 300 characters.

### `decisions.jsonl` — one record per decision

```json
{"ts":"2026-09-01T12:02:31.966Z","sessionId":"3d6b8d33-d0e4-45f6-86e3-027526f32203",
 "cwd":"/private/tmp/repo","tool":"Bash",
 "inputSummary":"git push --force origin HEAD:refs/heads/main",
 "light":"yellow","decision":"allow","clause":"practices §force-push","actor":"policy",
 "latencyMs":4,"rewritten":true,
 "note":"corrected — practices §force-push: --force replaced with --force-with-lease so the push refuses rather than overwriting commits pushed by someone else"}
```

| Field | Read it as |
|---|---|
| `light` | `green` allowed · `yellow` corrected · `red` denied · `null` no light assigned |
| `decision` | `allow` · `deny` · `none` (no verdict returned — an exempt tool, or observe mode) |
| `clause` | the citation, or `null` when no written clause applied |
| `actor` | `deterministic` · `policy` · `model` · `human` · `timeout` |
| `latencyMs` | time inside the hook: policy load, decision, audit append. Single-digit on the deterministic path. It excludes process startup — the wall clock Claude Code waits for is about 60 ms more, nearly all of it Node starting up. |
| `rewritten` | true when the correction lane replaced the tool input |

`actor` is the field that answers *who decided*. A run full of `timeout` denials is a policy gap, not
a run full of unsafe calls.

### `activity.jsonl` — tool results and waits

Tool results carry `tool`, a 12-character `fingerprint` of the input, and `ok`. Several consecutive
records with the same fingerprint and `ok: false` is the signature of a wedged agent, which is why
this file exists. Wait records carry `waiting` (`idle_prompt` / `permission_prompt`) and a bounded
message.

### Reading it

```bash
/session-sitter:status                  # the worklist, and what this plugin has registered
/session-sitter:log --since 24h --denied
/session-sitter:digest --since 24h      # one summary per session
/session-sitter:policy practices.md --replay
/session-sitter:explain Bash --command 'terraform apply'
/session-sitter:learn --dry-run         # practices proposed from the trail, no model
/session-sitter:export --since 7d       # one HTML file to send someone
```

`--json` and `--csv` are there for handing the log to someone else. Every command is a thin wrapper
around a script in `plugin/lib/`, so there is one implementation of "what happened" and the terminal
and the slash command cannot disagree about it.

Two of these are worth a note:

- **`/session-sitter:status` answers two questions**, because they are different questions. The
  *worklist* reads each agent's own session store, so it sees sessions this plugin has never touched.
  The *registered* list reads what the hooks wrote, so it is what tells you governance is actually
  wired up here. A session in the first and not the second is running **ungoverned**.
- **`/session-sitter:export` writes a file** and prints its path rather than printing the report. A
  self-contained HTML snapshot is for a human to open, it can be megabytes, and pouring it into the
  conversation would cost more than it tells anyone.

The `session-sitter` command reads the same trail. It resolves the data directory exactly as the
hooks do — `$SESSION_SITTER_DATA_DIR`, else `$CLAUDE_PLUGIN_DATA`, else `~/.claude/session-sitter` —
and reads `decisions.jsonl` alongside any supervision state dir it finds, so the plugin's decisions
show up whether or not this machine has ever opened an IDE:

```bash
session-sitter log --since 24h --denied
session-sitter digest
```

Pass `--state-dir` only when you mean one directory and nothing else: it is honoured outright, and it
excludes the hook trail. See [the CLI reference](CLI.md#where-state-is-read-from).

A statusline showing the session's traffic light and decision count is at `plugin/statusline.js`:

```json
{ "statusLine": { "type": "command",
                  "command": "node ~/.claude/plugins/cache/session-sitter/session-sitter/<version>/statusline.js",
                  "refreshInterval": 5 } }
```

---

## What this does not do

Honesty here is cheaper than a support thread.

- **It cannot answer a question meant for you.** `AskUserQuestion` and `ExitPlanMode` are exempt by
  design. A genuine question to a human stays a question to a human.
- **It does not govern `claude -p`.** `PermissionRequest` is not emitted on the headless path
  (verified on v2.1.252 — see `docs/superpowers/plans/2026-09-01-plugin-verification.md`). In `-p` the
  plugin still registers the session and records activity, but it is never asked to decide, so the
  unattended-governance story holds for interactive sessions only. This is the largest gap between
  what the design intended and what the platform currently emits.
- **It does not replace Auto mode.** It sits in front of it and complements it: this layer names the
  clause it applied and can rewrite a call, which Auto mode cannot; Auto mode brings Anthropic's
  judgment to everything your practices do not mention. Both can be on. In `observe` mode this layer
  defers to it entirely.
- **It cannot escalate and wait.** The hook has to answer synchronously, so the orchestrator's orange
  lane — notify a human, count down, apply their answer — is not reachable from here. An ambiguous
  call is denied, not queued. The `human` and `timeout`-after-waiting actors belong to the extension's
  path.
- **It judges the call, not the conversation.** The classifier tier deliberately does not read the
  session transcript; doing so in front of a live prompt would spend the entire latency budget.
- **A clause still matches text, not argv.** A clause is a substring or regex over the tool name and
  its arguments, so `echo 'rm -rf /'` is denied by a `Match: rm -rf` clause even though the `rm` is an
  argument to `echo`. The compound evaluator does not make this worse — that line is one command — but
  it does not fix it either. Fixing it means clauses matching parsed argv, which is a different
  feature.
- **A shell construct it cannot parse is denied, not approved.** See the fail-closed list above. It is
  the right direction and it has a cost: `npm test -- --shard=$((1 + 1))` is denied even with a green
  clause covering `npm test`.
- **A hook timeout fails open in an interactive session.** No decision means the prompt appears as
  usual. The deterministic path is 64 ms, so this only matters if you enable the classifier — and a
  measured classifier round trip is 11–17 s against the hook's 60 s timeout, which is closer than it
  sounds.
- **Installing a plugin means running its author's code.** Hooks run unsandboxed with your full
  environment. That is true of every plugin, including this one.

---

## `plugin/lib/` is committed build output

A plugin is installed by cloning a git ref into `~/.claude/plugins/cache/…`, and nothing compiles it
on the way in. So a plugin written in TypeScript has to ship JavaScript.

The alternative — hand-writing the hooks in JavaScript — would fork the decision logic away from the
tested engine and leave this repository with two definitions of what "red" means. Committing build
output is the smaller cost.

`make plugin` compiles `src/` and copies the dependency closure of the hook and CLI entry points into
`plugin/lib/`, each file carrying a generated-file header. The file list is derived by walking the
`require` graph, not maintained by hand, and the copy refuses any module that imports `vscode`.
`ci/check-plugin-lib.sh` rebuilds and runs `git diff --exit-code plugin/lib`, so a stale artifact
fails the build instead of shipping a plugin a version behind the tests that vouch for it.

`scripts/time-permission-hook.js` measures the hook's latency by spawning the shipped binary, and
asserts each rung's verdict while it does — so re-running it both reproduces the numbers in the
verification record and checks the ladder still behaves.

```bash
make plugin            # rebuild plugin/lib and commit it
make plugin-validate   # claude plugin validate ./plugin --strict, plus the marketplace
```

---

## Adding a correction rule

The correction lane is the one place this plugin hands the agent a command it did not ask for, so the
bar is high. `src/policy/corrections.ts` carries the rule, and the reasoning for every rule that was
considered and rejected. A rule ships only when all four hold:

1. **The safer form is unambiguous** — one sensible replacement, not a choice among several.
2. **The rewrite is equivalent or strictly narrower** — never more reach than was asked for, never a
   different goal.
3. **It is verifiable by reading the command**, with no knowledge of repository, network or intent.
4. **Failure of the rewritten form is loud** — the agent sees the refusal and can escalate, rather
   than silently doing less than it thinks it did.

`rm -rf`, `git reset --hard`, `git checkout .`, an unpinned `npm install`, and `git push origin main`
all fail at least one of those and are deliberately **not** rewritten. Deny them with a clause, or
leave them to the classifier.
