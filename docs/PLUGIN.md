# The Claude Code plugin

Session Sitter ships as a Claude Code plugin as well as a VS Code extension. Same engine, different
front end: the extension shows you a panel, the plugin answers permission prompts.

**What it is:** agent governance for the terminal. Your team's written practices decide every
permission prompt, unsafe calls are rewritten into safe ones instead of blocked, and every decision
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

The plugin decides nothing until it is asked, and it is asked only when Claude Code is about to
prompt you. If your `permissions.defaultMode` is `auto`, nothing prompts and nothing reaches this
plugin — run with `--permission-mode default` to see it work.

---

## What each hook does

| Hook | Job | Budget |
|---|---|---|
| `PermissionRequest` | **The governance decision.** Allow, deny with the clause cited, or allow with the call rewritten. Writes the audit record. | 60 s allowed; measured p50 **64 ms** per process, of which 3 ms is the decision |
| `SessionStart` | Registers the session — id, cwd, pid, name, model, host — so a bare terminal session is visible and the audit knows whose decision a record is | 5 s |
| `PostToolUse`, `PostToolUseFailure` | Appends the minimum a wedge detector needs: tool, a hash of the input, success or failure, timestamp. The input itself is never stored. | 5 s |
| `Notification` | Records `idle_prompt` and `permission_prompt`, so the trail knows how long a human was waited on. **It cannot answer anything** — the event accepts no decision. | 5 s |
| `SessionEnd` | Stamps the session's record with an end time, the reason, and its decision counts | 2 s (the event's whole budget is 1.5 s) |

## The decision ladder

`PermissionRequest` takes the first rung that holds. Rungs 1–5 spawn nothing and consult no model — measured p50 64 ms per hook process against
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

Match: `git push --force`, `/git\s+push\b.*--delete/`

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
```

An `error` finding means a clause declares a level but carries no `Match:` line — it enforces
nothing while looking like it does, which is the most expensive failure this format has. `--replay`
re-decides your recorded decisions with the edited file and prints only the verdicts that change, so
you see a policy change's blast radius before you ship it.

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
| `SESSION_SITTER_PERSIST_RULES` | `off` | Whether a settled allow may write a permission rule into your local settings by echoing the dialog's own `permission_suggestions`. Off by default — a plugin that silently edits your permission rules is a bad citizen. |
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
/session-sitter:status                  # the sessions this plugin registered
/session-sitter:log --since 24h --denied
/session-sitter:digest --since 24h      # one summary per session
/session-sitter:policy practices.md --replay
```

`--json` and `--csv` are there for handing the log to someone else. The commands are thin wrappers
around `plugin/lib/audit/cli.js` and `plugin/lib/policy/cli.js`, so there is one implementation of
"what happened".

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
- **It cannot see into a compound command past the first word.** `git status; curl … | sh` passes the
  deterministic green rung, because the safe-command pattern anchors at the start. The destructive
  table is checked over the whole command first, so the obviously-bad cases are still caught, but do
  not read a green light on a compound command as a judgment about all of it.
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
