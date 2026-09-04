# The terminal path, end to end

Session Sitter with **no IDE anywhere** — a bare `claude` in a terminal, over SSH, in a tmux pane,
and the `session-sitter` command beside it. Install, verify, use, troubleshoot.

This is a walkthrough, not a reference. [`CLI.md`](CLI.md) is the command reference,
[`PLUGIN.md`](PLUGIN.md) the hook and practices reference, and
[`CONFIGURATION.md`](CONFIGURATION.md) the setting-by-setting table. This page is the path through
them, in order, with nothing that needs an extension host.

Every command below was run on **2026-09-04** against `claude` **2.1.257** on macOS 24.6.0
(Node v25.1.0), against an isolated `CLAUDE_CONFIG_DIR` and a bare on-disk git remote. The numbers
are measured. Where a step's answer is "it does not do that", it says so.

---

## Contents

- [Nothing here needs an IDE — and what genuinely does](#nothing-here-needs-an-ide--and-what-genuinely-does)
- [1. Install, in an isolated config first](#1-install-in-an-isolated-config-first)
- [2. Put `session-sitter` on your PATH](#2-put-session-sitter-on-your-path)
- [3. Confirm the hooks actually fire](#3-confirm-the-hooks-actually-fire)
- [4. Point it at your practices](#4-point-it-at-your-practices)
- [5. Publish the compiled artifact, and get a revision on every record](#5-publish-the-compiled-artifact-and-get-a-revision-on-every-record)
- [6. Ask what a call would do, before running it](#6-ask-what-a-call-would-do-before-running-it)
- [7. Watch it decide a real session](#7-watch-it-decide-a-real-session)
- [8. Read the trail](#8-read-the-trail)
- [9. Rung 7 in a terminal: what happens when nothing can decide](#9-rung-7-in-a-terminal-what-happens-when-nothing-can-decide)
- [10. Run the daemon, so timeouts still expire](#10-run-the-daemon-so-timeouts-still-expire)
- [11. Propose practices from the trail](#11-propose-practices-from-the-trail)
- [Troubleshooting](#troubleshooting)
- [Isolating a test run](#isolating-a-test-run)

---

## Nothing here needs an IDE — and what genuinely does

Steps 1–11 need `claude`, `node` and `git`. Two things in the product do need an extension host, and
saying so up front is cheaper than discovering it at 02:00:

| Needs an IDE | Why | What the terminal gets instead |
|---|---|---|
| Applying a decision into an already-paused agent | Reaching a paused session means writing into it, which the terminal cannot do | The daemon **counts** the backlog and says so: `3 deliveries waiting for an IDE window — a terminal cannot reach a paused agent, so they stay queued` |
| The dashboard panel | It is a webview | `session-sitter status`, `log`, `digest`, and `export --html` for a self-contained page |

Everything else — the whole decision ladder, the correction lane, the audit trail, escalation to a
human, compiling the artifact, mining the trail — runs with no IDE installed.

---

## 1. Install, in an isolated config first

The plugin's `PreToolUse` and `PermissionRequest` hooks **fail closed**: a call no clause covers is
denied. That is the point, and it means a first install changes what your running sessions are
allowed to do. Install into a scratch config, confirm it decides the way you want, and only then
install for real.

```bash
export CLAUDE_CONFIG_DIR=/tmp/ss-try/cfg          # a config that is not your own
mkdir -p /tmp/ss-try/repo && cd /tmp/ss-try/repo
git init -q -b main

claude plugin marketplace add eranra/session-sitter
claude plugin install session-sitter@session-sitter
```

Both are plain CLI subcommands — no slash command, no interactive session needed:

```
✔ Successfully added marketplace: session-sitter (declared in user settings)
✔ Successfully installed plugin: session-sitter@session-sitter (scope: user)
```

**A local checkout installs by path, not by git URL.** `claude plugin marketplace add` accepts
`owner/repo`, an `https://` URL, or a directory path. A bare repository on disk is **not** accepted —
`file:///path/to/repo.git` is rejected as an invalid source format. To install from a checkout, give
it the directory:

```bash
claude plugin marketplace add /path/to/session-sitter
claude plugin install session-sitter@session-sitter
```

Or skip installing altogether and load it for one session:

```bash
claude --plugin-dir /path/to/session-sitter/plugin
```

---

## 2. Put `session-sitter` on your PATH

The plugin ships the whole command, but a plugin is installed by cloning into a version-stamped
directory and nothing about that is on a `PATH`. Symlink the launcher it ships:

```bash
mkdir -p ~/.local/bin
ln -sf "$(ls -d "$CLAUDE_CONFIG_DIR"/plugins/cache/*/session-sitter/*/bin/session-sitter | tail -1)" \
       ~/.local/bin/session-sitter
session-sitter --version
```

Substitute `~/.claude` for `$CLAUDE_CONFIG_DIR` for a normal install. The path contains the version,
so **re-run that after every plugin update**; the launcher resolves its own symlinks and, when the
link goes stale, prints the path it resolved to and the command to fix it instead of a Node module
error.

No plugin at all is also fine — see [`CLI.md`](CLI.md#getting-it) for `npx` and `npm i -g`.

---

## 3. Confirm the hooks actually fire

Do not take registration on trust. The cheapest real check is a headless prompt, because
`SessionStart` fires for it:

```bash
cd /tmp/ss-try/repo
export SESSION_SITTER_DATA_DIR=/tmp/ss-try/data
claude -p 'Reply with exactly the word: registered' --output-format json | head -c 200
find /tmp/ss-try/data -type f
```

`SessionStart` registers the session, so a file appears:

```
/tmp/ss-try/data/sessions/2f565fe0-c498-4e13-bea6-6ef6d7ba391f.json
/tmp/ss-try/data/pipeline.jsonl
/tmp/ss-try/data/pipeline/shapes.json
```

**`SessionStart` registers a session; it does not pin a policy revision.** The revision is stamped
per decision, by the hook that decides — see step 5. And `PermissionRequest` is **not emitted in
headless mode**, so `claude -p` proves the lifecycle hooks are wired and nothing more. To see the
ladder decide you need an interactive session (step 7) or the hook boundary (step 6).

---

## 4. Point it at your practices

The direct way — one markdown file, no repository layout:

```bash
export SESSION_SITTER_PRACTICES=/path/to/practices.md
session-sitter policy check "$SESSION_SITTER_PRACTICES"
```

`policy check` is worth running before you trust the file: a clause with no `Match:` line is context
for the classifier and **cannot deny anything on its own**, and a red clause somebody believed was
enforcing something is the most expensive quiet failure in this design. See
[`PLUGIN.md`](PLUGIN.md#the-practices-file) for the format.

For the three-tier layout (`user`, `project`, `team`), point at a checkout containing
`data/knowledge/` instead:

```bash
export SESSION_SITTER_USER=dev
export SESSION_SITTER_PROJECT=widget-lab
export SESSION_SITTER_TEAM=widget-lab
export KNOWLEDGE_LOCAL_REPO=/path/to/knowledge-checkout
```

`SESSION_SITTER_PRACTICES` and the tier routing are **exclusive**: a practices file set means no
artifact is consulted at all. `policy explain` prints which of the two answered, so a degraded
answer is visibly degraded rather than quietly wrong.

---

## 5. Publish the compiled artifact, and get a revision on every record

The compiled artifact is the versioned, content-hashed policy the runtime loads. It matters for two
reasons: it keeps the prompt cache stable (a file mutating under the runtime invalidates it), and it
is what puts a **revision** on every decision record, so a citation can be resolved months later
against the policy that actually fired.

```bash
session-sitter policy compile --corpus /path/to/knowledge-checkout --dry-run   # look first
session-sitter policy compile --corpus /path/to/knowledge-checkout            # publish
```

```
8 clauses from 3 file(s)
  revision   sha256:c26682b7e327dffe74e211c0373db9b0e8498ebacd1c453023924975d8b5a058
  corpus_ref git:d72a972
  core       1 clause(s), 306 bytes
  wrote      /tmp/ss-try/data/policy/c26682b7….json
  published  /tmp/ss-try/data/policy/current.json
```

A malformed corpus writes **nothing** and exits non-zero, naming what is wrong; the runtime keeps
serving the last good revision. There is no middle outcome on purpose.

Without a published artifact every record carries `rev: null` and `policy explain --rev` has nothing
to resolve. That is honest, not broken — but it is worth knowing which state you are in.

`session-sitter policy ablate` is the other half: it re-decides the recorded window with each clause
removed and reports what moves, so a clause that changes nothing is a retirement candidate *with
evidence*. It needs a published artifact and a window of at least a few hundred decisions.

---

## 6. Ask what a call would do, before running it

`policy explain` runs the hook's own loader, matcher and selector against a hypothetical call. It
writes nothing, calls no model, and decides nothing:

```bash
session-sitter policy explain Bash --command 'rm -rf ./build'
```

```
WOULD DENY  ·  rung 3 (written red clause)  ·  revision c26682b7
  practices §team-fs-004@c26682b — A generated directory is rebuilt, never deleted out from under a running job
  A recursive delete cannot be narrowed into a safer form and cannot be undone, so this clause denies
  it outright rather than rewriting it. If a stale `build/` is the problem, run the build's own clean
  target; if you truly need the delete, a human runs it.
  ↳ source: data/knowledge/teams/widget-lab/bottom-line.md

  8 clause(s) evaluated from the compiled artifact
  no model call · 0 tokens · 2.89 ms of policy work
  this decides nothing — the PermissionRequest hook decides, and it will decide again when the call actually runs.
```

Add `--json` for the machine-readable form; `--rev <revision>` explains against a retained artifact
instead of the published one.

**One place `explain` and the hook legitimately differ.** An explain cannot ask a human — a
hypothetical has no prompt to hold open — so on the escalation path it reports the answer silence
would produce, which is `deny`. With `SESSION_SITTER_ESCALATE=on` its note says so explicitly, so
the difference is visible rather than a surprise. Everywhere else the two agree exactly, by
construction: `explain` calls the enforcement path's evaluator rather than a copy of it.

---

## 7. Watch it decide a real session

`PermissionRequest` fires only in an **interactive** session, and only when Claude Code was already
going to prompt you. So:

```bash
cd /tmp/ss-try/repo
claude --permission-mode manual
```

With `permissions.defaultMode` set to `auto` nothing prompts and the ladder never runs. `manual` is
what makes it visible.

Then ask for something your practices cover. A real transcript line from a real session, with a
`--force` push rewritten before it ran:

```
⏺ I ran the command exactly as given. It failed. Full output:
    To /tmp/ss-term/remote.git
     ! [rejected]        main -> main (stale info)
    error: failed to push some refs to '/tmp/ss-term/remote.git'

  (stale info) is the lease-check rejection, not the ordinary non-fast-forward one. A plain
  git push --force doesn't produce that message […] So something in this environment is
  turning the bare --force into a leased force push.
```

The agent was never told about the rewrite. It inferred it from git's own error — which is what a
correction lane looks like from the inside.

And a denial that cites the clause rather than announcing a classifier:

```
⏺ Error: denied — practices §team-fs-004: A generated directory is rebuilt, never deleted out
  from under a running job
    A recursive delete cannot be narrowed into a safer form and cannot be undone, so this
    clause denies it outright rather than rewriting it. […]
  ⎿  Denied by PermissionRequest hook
```

Measured on this path, 50 process spawns per rung, whole-process wall clock including Node startup:

| Rung | What decided | min | p50 | p95 |
|---|---|---|---|---|
| 1 | deterministic green (`Read`) | 58.7 | **62.4** | 66.6 |
| 2 | correction lane (`git push --force`) | 59.1 | **63.0** | 69.8 |
| 4 | written green clause (`npm test`) | 57.7 | **66.4** | 74.8 |
| 5 | built-in red table (`rm -rf`) | 57.7 | **68.5** | 75.6 |
| 7 | fail closed | 59.9 | **69.8** | 75.7 |

Milliseconds, via `node scripts/time-permission-hook.js` from a checkout. The **in-hook** figure the
trail records — the decision itself, without Node startup — was **3–5 ms** for every deterministic
rung in this run, with **0 model calls**.

---

## 8. Read the trail

Three commands over what the hooks just wrote. No IDE, no server.

```bash
session-sitter log --since 24h
```

```
WHEN         LIGHT         OUTCOME   TOOL   CLAUSE                   ACTOR          INPUT
09-04 20:36  yellow        correct   Bash   practices §force-push    correction     rewritten
09-04 20:39  green         allow     Bash   not recorded             deterministic  as written
09-04 20:39  green         allow     Bash   practices §team-ci-001   policy         as written
09-04 20:41  red           deny      Bash   practices §team-fs-004   policy         as written
09-04 20:44  red           deny      Bash   practices §team-sec-003  policy         as written
09-04 20:55  not recorded  deny      Bash   not recorded             timeout        as written

17 decisions · 9 denied · 3 corrected
```

```bash
session-sitter digest --since 24h        # one page per session
session-sitter export --html   --since 24h > trail.html    # self-contained, no external refs
session-sitter export --jsonline --since 24h > trail.ndjson  # one record per line
```

`export` requires exactly one of `--html` or `--jsonline` and says so if you give neither. The HTML
is genuinely self-contained — zero external references — so it survives being emailed.

`log` merges the hook trail with the supervisor's own records and names both sources in its footer.
`not recorded` is a real value and distinct from a zero: it means that record was written before the
field existed. See [`CLI.md`](CLI.md#not-recorded).

---

## 9. Rung 7 in a terminal: what happens when nothing can decide

Rung 7 is fail-closed: no clause matched, no classifier, so the call is **denied**, because silence
is not approval. In a terminal the question that matters is whether it can *hang*. It cannot. Three
bounded outcomes, all measured:

| Configuration | What happens | Measured |
|---|---|---|
| `SESSION_SITTER_ESCALATE=off` (**the default**) | Denies at once, naming the three ways to resolve it | **111 ms** wall, 4 ms in-hook |
| `escalate=on`, **no daemon running** | Denies at once. It refuses to wait for a question nobody can receive, and names the daemon command | **109 ms** wall, 5 ms in-hook. No ask queued |
| `escalate=on`, daemon running | Writes an ask, polls for a verdict, denies at the deadline | Deadline **45 s** default, **55 s** hard ceiling |

The ceiling is not advisory. `PermissionRequest` is allowed 60 s by `hooks.json`, and being killed
mid-wait would return no JSON at all — which Claude Code reports as a *hook error* rather than a
decision — so the wait is capped at 55 s whatever you configure. A deadline that passes with no
answer is recorded `actor: 'timeout'` with a note saying a human was asked and did not answer.

The denial with escalation off, verbatim:

```
Session Sitter denied this call because the supervisor could not reach a verdict, and silence is
not approval. Nothing here says the call is unsafe — only that nothing said it was safe. To
resolve it: write a practices clause covering this call, enable the classifier
(SESSION_SITTER_CLASSIFIER=on), or run in observe mode (SESSION_SITTER_MODE=observe) to hand the
decision back to Claude Code.
```

And with escalation on but nothing to serve it:

```
(escalation: no daemon has run here. Start one with `session-sitter daemon`, or turn escalation
off with SESSION_SITTER_ESCALATE=off.)
```

**Answering an ask with no Telegram configured.** The default channel is `stub`, which is a pair of
directories rather than a dead end: the daemon writes the question to
`<state-dir>/notifications/<id>.txt` and reads a reply from `<state-dir>/inbox/<id>.txt`. So a human
at a second terminal can answer:

```bash
cat .supervisor-state/notifications/req-ask-*.txt      # what is being asked
echo allow > .supervisor-state/inbox/req-ask-mtn9e92y-0c0e2aee.txt
```

Measured end to end: the hook wrote the ask, the daemon posted it after **1.19 s**, the reply was
dropped, and the hook returned `allow` at **3.16 s** — recorded as
`actor: "human", note: "allowed by a human after 3s: allow"`.

One human saying yes once is **not** a standing rule: the record is deliberately not marked settled,
so nothing derives a permission rule from it. Set `MESSAGING_CHANNEL=telegram` with a bot token for
the real thing — see [`TELEGRAM.md`](TELEGRAM.md).

---

## 10. Run the daemon, so timeouts still expire

With nothing running, an escalation never reaches its deadline and "silence is never approval" stops
being true. That is what the daemon is for.

```bash
session-sitter daemon --status          # is one running here?
session-sitter daemon --once            # one pass, for cron or a smoke check
session-sitter daemon --interval 5      # resident
```

```
running · pid 19024 · a-hostname
  started   09-04 20:56
  last pass 09-04 21:10
  passes    403, 3 record(s) transitioned
  reading   no — timeouts only
  state dir /tmp/ss-try/repo/.supervisor-state
```

`reading: no` means this process is not reading the human channel — either none is configured, or
another daemon holds the reader lease. One reader per machine is enforced, because a bot token has
one destructive update stream.

`SIGTERM` finishes the current pass and stops:

```
09-04 21:10 SIGTERM — finishing this pass and stopping
09-04 21:10 stopped after 403 pass(es), 3 record(s) transitioned
```

After it exits, `--status` reports `dead` rather than `running`. A `--once` run reports
`single pass` instead — because for the cron setup `--once` exists to serve, the pid being gone is
the expected state, and calling that `dead` is how people learn to stop reading a status line.
`plugin/systemd/` has a unit file.

---

## 11. Propose practices from the trail

`learn` reads the decision trail and proposes clauses. **No model, ever** — it is deterministic
counting over records that are already redacted.

```bash
export KNOWLEDGE_LOCAL_REPO=/path/to/knowledge-checkout   # required: somewhere to propose into
session-sitter learn
```

The honest outcome over a small window looks like this, and is worth showing because it is what you
will usually get first:

```
clauses: +0 −3 merge 0 = net -3  (0 proposal(s), 28 shape(s) below the floor)

Nothing proposed: ok.
− force-push (retire) — proposed for retirement, no file written
− proj-read-001 (retire) — proposed for retirement, no file written
? team-fs-004 — redundant with rung 5's denied — built-in destructive-action rule
                (Bash: rm -rf ./build): narrow it or delete it

Shapes: 28 below the floor.

Every proposal is inert until a human accepts it. 0 model call(s).
```

Read that as: 28 repeated call shapes were seen but none crossed the support floor, so **nothing was
proposed**, which is the correct answer for a 17-decision window. The retirements and redundancy
flags are still useful — `team-fs-004` really is redundant here, because the built-in destructive
table denies `rm -rf ./build` with no written clause at all. Verify a redundancy claim before acting
on it: deleting a clause because a built-in covers it is only safe if it does.

Every proposal is a file a human reviews. A machine may propose; it may not outrank a human.

---

## Troubleshooting

**Nothing prompts, so nothing is governed.** `permissions.defaultMode` is `auto`. Run
`claude --permission-mode manual`.

**Everything is denied.** That is fail-closed working with no practices loaded. Check that
`SESSION_SITTER_PRACTICES` or the tier routing is actually reaching the hook —
`session-sitter policy explain Bash --command 'npm test'` prints how many clauses it evaluated and
from where. Zero clauses is the answer you are looking for. `SESSION_SITTER_MODE=observe` hands
decisions back to Claude Code while you sort it out.

**A read of a secret was not denied, and no record was written.** `PermissionRequest` fires only
when Claude Code was *already going to prompt*, and it does not prompt for reads. `PreToolUse` is the
hook that covers them, and it is on by default (`SESSION_SITTER_PRETOOL=on`). Confirm it at the hook
boundary rather than guessing:

```bash
P=$(ls -d "$CLAUDE_CONFIG_DIR"/plugins/cache/*/session-sitter/*)
echo '{"session_id":"probe","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat .env"}}' \
  | node "$P/lib/hooks/preToolUse.js"
```

A `{}` reply is *no decision* — the call proceeds. A deny prints the clause. Piping the event JSON
into any hook this way is the fastest way to separate "the policy does not cover this" from "the
hook never ran".

**`session-sitter: cannot find the CLI at …`** — the symlink points into a version-stamped directory
and the plugin updated. Re-run the `ln -sf` from step 2; the error names the path it resolved to.

**`session-sitter status` shows nothing, or the wrong machine's sessions.** It reads the session
store under the **active** `CLAUDE_CONFIG_DIR`. If you exported one for a test and forgot, that is
why it is empty; if you meant to see your real sessions, unset it.

**The daemon refuses to start**, saying a VS Code extension host is live here. Two supervisors on
one state dir would both apply timeouts. Close the window, turn its supervision off, or pass
`--allow-with-ide` if you know that window is not supervising this state dir.

**`ablate` says it needs more decisions.** It refuses the *run*, not the corpus: a zero over a short
window is not evidence a clause is worthless. Let the window fill.

---

## Isolating a test run

Worth its own section because getting it wrong means a fail-closed hook denying calls in your real
sessions.

```bash
export CLAUDE_CONFIG_DIR=/tmp/ss-try/cfg      # config, plugins, and the session store
export SESSION_SITTER_DATA_DIR=/tmp/ss-try/data   # the trail, the artifact, the asks
git init --bare -q /tmp/ss-try/remote.git     # so a force push cannot reach a real host
```

Those two variables cover it: `CLAUDE_CONFIG_DIR` moves Claude's own configuration *and* the session
store `status` reads, and `SESSION_SITTER_DATA_DIR` moves everything this plugin writes. An installed
plugin also gets `CLAUDE_PLUGIN_DATA` pointing inside the active config dir, so it follows along on
its own; `SESSION_SITTER_DATA_DIR` is what a `--plugin-dir` run or a hand-run hook needs.

What `CLAUDE_CONFIG_DIR` does **not** move: `~/.bob` and `~/.codex`. Those are other tools with their
own configuration, and this variable says nothing about where they keep their sessions — so a scan
still finds Bob and Codex sessions if you have them.

Verify the isolation held rather than assuming it:

```bash
session-sitter status        # should be "0 sessions" in a fresh scratch config
```

[`EVIDENCE.md`](EVIDENCE.md) has a `setup.sh` that builds this whole world — isolated config, bare
remote, scratch repo with genuine git divergence — in one command:

```bash
ROOT=/tmp/ss-try PLUGIN=/path/to/session-sitter/plugin sh docs/evidence/setup.sh
. /tmp/ss-try/env.sh
```
