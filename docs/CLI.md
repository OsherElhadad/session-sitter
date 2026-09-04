# `session-sitter` — the terminal front end

Everything the panel shows, for people who never open the IDE: the worklist, the audit trail of
supervision decisions, an overnight digest, and a linter for your practices file.

The supervision engine was built host-free, and session reading is too
([`src/sessionScan.ts`](../src/sessionScan.ts)), so this is a second front end over the same code —
not a reimplementation. A session's title, its status and a decision's traffic light are computed by
exactly the functions the panel uses.

```bash
session-sitter status                 # who needs you
session-sitter status --watch 5       # the same, redrawing in place
session-sitter log --denied --since 2h
session-sitter digest                 # what your agents did last night
session-sitter policy check
session-sitter policy explain Bash --command 'git push --force origin main'
session-sitter export --html > report.html   # one file you can send someone
```

---

## Getting it

Three ways in, and none of them needs VS Code.

**It comes with the Claude Code plugin.** The plugin ships the whole command at `lib/cli/index.js`,
and the slash commands are backed by it, so `/session-sitter:log` and `session-sitter log` are the
same code. To put it on your `PATH`, symlink the launcher the plugin ships:

```bash
mkdir -p ~/.local/bin
ln -sf "$(ls -d ~/.claude/plugins/cache/*/session-sitter/*/bin/session-sitter | tail -1)" \
       ~/.local/bin/session-sitter
```

The install path is version-stamped, so re-run that after a plugin update. The launcher resolves its
own symlinks and, when the link goes stale, prints the path it resolved to and the command to fix it
rather than a Node module error.

**Or on its own, with no plugin and no extension:**

```bash
npx github:eranra/session-sitter status     # nothing installed
npm i -g github:eranra/session-sitter       # or keep it on PATH
```

Both compile on the way in, because `out/` is not committed — so they want a toolchain, not a clone.

**Or from a checkout**, which is what a contributor wants:

```bash
make compile && node out/cli/index.js status
```

---

## Contents

- [Getting it](#getting-it)
- [Common conventions](#common-conventions)
- [`status`](#status)
- [`daemon`](#daemon)
- [`log`](#log)
- [`digest`](#digest)
- [`policy check`](#policy-check)
- [`policy explain`](#policy-explain)
- [`export`](#export)
- [Who invokes what](#who-invokes-what)
- [Where state is read from](#where-state-is-read-from)
- [The `--json` contracts](#the---json-contracts)

---

## Common conventions

### Exit codes

Uniform across every command.

| Code | Meaning |
|---|---|
| `0` | the command ran and printed its answer |
| `1` | the command ran and something it needed was missing or unreadable — an absent parser, an unreadable file, a practices file that did not parse |
| `2` | the arguments were wrong — an unknown flag, a missing value, an unparsable `--since`, contradictory flags |

`2` means *you* typed it wrong; `1` means *this build* could not answer. Scripts can rely on that
split.

### Colour

Colour is a property of the destination, not of the program.

- stdout is **not** a terminal → no escape sequences at all, so a pipe receives data rather than
  ANSI noise.
- [`NO_COLOR`](https://no-color.org) set to *anything*, including the empty string → no colour.
- `TERM=dumb` → no colour.
- `FORCE_COLOR` set to anything but `0` → colour even into a pipe. `NO_COLOR` still wins.

### Times

Every `--since` accepts both halves of how people describe "when":

| Form | Example | Means |
|---|---|---|
| relative | `90s`, `45m`, `2h`, `3d`, `1w` | that long ago. Long names (`2 hours`) and any case also work. |
| day word | `today`, `yesterday`, `now` | midnight local, or this instant |
| bare date | `2026-08-30` | the start of that **local** day |
| ISO timestamp | `2026-08-30T18:00:00Z` | exactly that instant |

A value that cannot be read is an error (exit 2), never a silent "beginning of time".

### "not recorded"

Where a writer recorded nothing, the output says `not recorded` and the JSON carries `null` or `""`.
Nothing is inferred and no gap is filled with a plausible number — these reports get forwarded, and
an invented figure in one has a long half-life.

---

## `status`

The worklist: every session across Claude Code, IBM Bob, Codex and VS Code Chat.

```
session-sitter status [options]
```

| Flag | Default | What it does |
|---|---|---|
| `--since WHEN` | `24h` | only sessions updated since `WHEN` |
| `--all` | off | no time window — every session on disk, however old. Contradicts `--since`. |
| `--agent NAME` | all | one of `claude`, `bob`, `codex`, `chat` |
| `--needs-me` | off | only `approval` and `question` — see [statuses](#statuses) |
| `--sort MODE` | `status` | see [orders](#orders) |
| `--peers` | off | also pull sessions from peer machines over SSH |
| `--watch [SECONDS]` | off (`5` when bare) | redraw in place on an interval; Ctrl-C to stop |
| `--json` | off | machine-readable ([contract](#status-json)) |
| `-h`, `--help` | | flags and status meanings |

### Statuses

Six states, the same set the panel renders. The rules that pick one live in
[`src/sessionStatus.ts`](../src/sessionStatus.ts) and are written out in
[`docs/STATUS-INDICATORS.md`](STATUS-INDICATORS.md); the terminal derives nothing of its own, so a
row here and a row in the IDE always agree.

Listed most urgent first, which is also the default order:

| Marker | State | Means | Your move |
|:---:|---|---|---|
| `!` | `approval` | Paused on a permission prompt | Approve or reject it |
| `?` | `question` | Asked you something | Answer it |
| `◉` | `finished` | Done, and you have not opened it since | Read the result |
| `▸` | `working` | Running a tool, or writing a reply | Nothing — it is busy |
| `·` | `seen` | Done, and you have read it | Nothing |
| `○` | `dormant` | Nothing happening, or no signal to tell | Nothing |

The terminal reports the state a session's own storage supports. Splitting `finished` into `seen`
(you have read it) needs the timestamp of when you last opened the row, which the extension keeps in
its own VS Code state rather than in any agent's store — so **`seen` never appears in the CLI**, and
a result you have read reads `finished` here. Nothing else differs.

Every state gets its own glyph, not merely its own colour — a terminal theme can override the
palette, `NO_COLOR` removes it entirely, and colour alone is not readable for everyone. The glyph is
what survives all three.

**`--needs-me` keeps `approval` and `question`**, and nothing else: those are the two states where
nothing moves until you act. Not `finished` — an unread result is worth a look, but nothing is
stalled waiting for you to look at it, and a to-do list containing everything you have not read is
not a to-do list. (The extension's wider `needsYou` predicate, which does include `finished`, is
what dims a row in the panel; the terminal filter is the narrower `isBlockedOnYou`.)

### Orders

`--sort` accepts the six orders [`src/sessionSort.ts`](../src/sessionSort.ts) defines: `status`
(the default), `recent`, `hostWorkspace`, `workspace`, `source`, `title`. They are the same six the
panel's sort menu offers, and they behave identically.

**`status`** is the urgency ranking — `approval`, `question`, `finished`, `working`, `seen`,
`dormant`, newest first inside each group and tie-broken on session id so the order holds between
passes. It is the panel's "Needs you first", and it is the right default for a worklist, so the
terminal does not define an order of its own.

### The time window, and why there is one

`~/.claude/projects` is append-only and never pruned, so a machine in daily use holds hundreds of
finished sessions. The panel hides the old ones behind process liveness; the CLI does not use that
check — it covers only sessions started from the IDE, and on macOS it currently judges every session
dead. The 24-hour window is what keeps the worklist a worklist. Use `--all` for the archive.

### Peers

Peer discovery is a local file read, but the pull that follows it opens SSH connections. A command
that reaches the network without being asked is a command people stop running, so `--peers` is the
consent. Without it, the output says so in a footer, and an absent machine is never a mystery.

With `--peers`, each peer's reachability is reported — including the reason a connection failed —
rather than the peer silently vanishing from the list. A peer failure never costs you the local
worklist.

### `--watch`

Redraws in place: the screen and its scrollback are cleared before each frame, so a long watch does
not scroll the terminal into oblivion. The cursor is hidden while drawing and restored on the way
out, whichever way the loop ends.

Ctrl-C is honoured immediately, not at the end of the current interval. `--watch` requires a
terminal — into a pipe the escapes would be garbage and the frames would append forever, so it
refuses with exit 2 — and cannot be combined with `--json`.

---

## `daemon`

Keeps supervision running on a machine with no IDE.

```bash
session-sitter daemon                    # resident, 5s passes
session-sitter daemon --status           # is it running, and is it working?
session-sitter daemon --once             # one pass — for cron
```

### What one pass does, and why it matters

Three things: **post new questions** from hook escalations, **correlate replies** to escalated
decisions, and **expire the ones nobody answered.**

The order is the order of one round trip, and it matters. A question written by a hook a moment ago is
posted *before* the pass looks for replies, so it does not lose a whole pass waiting — and for a hook
holding a prompt open, a pass is most of its deadline.

That first job is what makes [`SESSION_SITTER_ESCALATE`](PLUGIN.md#escalation-answering-a-prompt-from-somewhere-else)
work: the hook writes an ask and waits on a *file*, and this daemon is the only process that touches
the messaging channel. A hook runs once per prompt, so a hook that polled Telegram itself would be an
unbounded number of readers of a stream that only one process may read.

The second is the reason this command exists. Expiring a card is the mechanism behind *silence is
never approval* — and with nothing running, an escalated call never reaches its deadline. It sits in
`orange_awaiting_user` for as long as the state dir survives, which is the one outcome this project
says it will not produce. Before this, that mechanism ran only inside a VS Code window, or as
`supervise poll --loop` typed by hand.

### What it deliberately does not do

**It does not apply decisions into a paused agent.** The orchestrator writes its decisions as JSON
into `<stateDir>/outbox/`, and getting from there into a blocked agent means resolving a prompt
through that agent's approval emitter — which lives inside another VS Code extension's process. A
terminal cannot reach it.

So the daemon **counts** the backlog and says a window is needed:

```
14:02 3 deliveries waiting for an IDE window — a terminal cannot reach a paused agent, so they stay queued
```

Nothing is lost by waiting: the outbox moves a delivery to `done/` only on a confirmed apply, so a
window opening later drains the queue. A daemon that discarded what it could not deliver would be
worse than one that never ran.

It also does not start `SupervisionService`, `AutoResponder` or `PendingWatcher`, and that is not an
omission. Those are driven by IBM Bob's pending-approval queue, read through the VS Code extension
host — Bob is an IDE, so on a terminal-only machine **their input does not exist.** A daemon that
constructed them would be watching an empty room.

### One reader per machine

A Telegram bot token has one update stream, and `getUpdates` consumes it **destructively**. Two
pollers do not each get a copy: each update goes to whichever asked first, and the shared offset
advances past updates the other never saw. Replies are silently split at random, and both halves look
like they are working.

So the daemon takes the same reader lease the Telegram remote control uses
(`~/.claude/session-sitter/bus/telegram.lock`) and **reads only while it holds it.** Not holding it is
not an error — it means a window is the reader here, and that window is already doing this work:

```
14:02 another reader holds the Telegram lease — timeouts only, no replies read
```

Note what still runs in that state: **timeouts.** Not holding the lease suppresses reading replies, never
expiring a card, because standing fully down would leave escalations pending past their deadline.

It also **refuses to start** when a live VS Code extension host is registered on this machine, naming
the pids so the claim can be checked:

```
$ session-sitter daemon
session-sitter daemon: refusing to start: 1 VS Code extension host live on this machine (pid 33550).
```

The lease alone is not enough for that case: with the Telegram remote interface off,
`SupervisionService` polls `getUpdates` *without* taking the lease, so nothing would arbitrate.
`--allow-with-ide` overrides it when you know the window is not supervising this state dir.

### `--status` answers a different question from `systemctl status`

```
$ session-sitter daemon --status
running · pid 164800 · eranra-wsl
  started   09-04 14:55
  last pass 09-04 14:56
  passes    34, 0 record(s) transitioned
  reading   no — timeouts only
  state dir /repo/.supervisor-state
```

A pid cannot answer "are my timeouts being applied": pids are recycled, and **a daemon wedged
mid-pass is still a live pid** — `active (running)` to systemd. So every pass writes a heartbeat, and
the status is read from that:

| | |
|---|---|
| `running` | the pid is live and a pass landed recently |
| `stale` | **the process is up and the work has stopped.** Says so in as many words: timeouts are not being applied |
| `dead` | the pid is gone |
| `single pass` | a finished `--once` run. The process exiting is expected, so this is not reported as a failure — a status line that cries wolf at a working cron setup is one people stop reading |
| — | nothing has ever run here, and it names the path it looked at |

Staleness scales with `--interval`, so a daemon that wakes every ten minutes is not called wedged for
being nine minutes idle. Exit is 0 only for `running`, so `--status` works as a health check.

### Running it as a service

A user unit ships at [`plugin/systemd/session-sitter-daemon.service`](../plugin/systemd/session-sitter-daemon.service):

```bash
mkdir -p ~/.config/systemd/user
cp plugin/systemd/session-sitter-daemon.service ~/.config/systemd/user/
# edit ExecStart for how you installed it, then:
systemctl --user daemon-reload
systemctl --user enable --now session-sitter-daemon
loginctl enable-linger "$USER"        # survive logout — usually the point on a build box
```

A **user** unit, not a system one: everything it reads is under `$HOME`, and it has to run as the
person whose agents it supervises. A system unit runs as root against the wrong home, which is the
kind of misconfiguration that looks like it is working.

`Restart=always` rather than `on-failure`, because the daemon exits 0 on `SIGTERM` and a clean exit
that was not a `systemctl stop` still means nothing is applying timeouts.

For cron instead, `--once` is the pass: `*/5 * * * * session-sitter daemon --once --state-dir ~/...`.

Either way it stops cleanly on `SIGINT`/`SIGTERM` — it finishes the pass in flight, releases the lease
and exits 0, rather than being killed halfway through writing a record.

---

## `log`

Query the audit trail of supervision decisions.

```
session-sitter log [options]
```

| Flag | Default | What it does |
|---|---|---|
| `--since WHEN` | no window | only decisions since `WHEN` |
| `--denied` | off | only decisions that blocked a call, **including** a countdown that ran out |
| `--corrected` | off | only the correction lane — calls that were rewritten |
| `--session ID` | all | one session |
| `--tool NAME` | all | one tool, matched case-insensitively |
| `--limit N` | `50` | keep the most recent N; `0` for no limit |
| `--state-dir PATH` | searched | read this state dir instead of [searching](#where-state-is-read-from) |
| `--json` | off | machine-readable ([contract](#log-json)) |
| `--csv` | off | comma-separated, RFC 4180 quoted, for a spreadsheet |

Output is chronological — oldest first, like every log — with one line per decision: time, traffic
light, outcome, tool, the clause cited, the actor, and whether the input was rewritten.

`--denied` includes `timeout` on purpose. A countdown expiring is a block: *silence is never
approval*.

Combining filters is an AND. `--json` and `--csv` cannot be combined.

### Outcomes

| Outcome | Means |
|---|---|
| `allow` | the call ran as written |
| `deny` | the call was blocked |
| `correct` | the call was rewritten and the rewrite ran |
| `escalate` | a human was asked |
| `timeout` | a human was asked and did not answer, so the call was denied |
| `resolved` | a human answered and their answer was applied |
| `pending` | recorded, not yet decided |
| `failed` | the supervisor itself failed |
| `unknown` | the writer recorded no outcome, and none could be read from the light without guessing |

### The three writers

`log` reads all three and labels each decision with its origin in `--json` (`from`), and each
decision's `id` names the file and line it came from, so a surprising row traces back to a byte on
disk:

- **`audit`, from `decisions.jsonl`** — the plugin's hooks, one record per governance decision
  (`decisions.jsonl:12`). The trail that exists on a terminal-only machine. Carries the clause
  citation, which rung answered (`actor` is `deterministic`, `policy`, `correction`, `classifier`,
  `human` or `timeout`), the latency, and the whole redacted call. It records no `host` and no
  session name, and no cost — it stores token counts, and turning those into money in a reader would
  mean pinning prices where nobody could trace them.
- **`audit`, from `audit.jsonl`** — `<stateDir>/audit.jsonl`, the same reader's shape for a trail
  shipped from elsewhere. Nothing in this repository writes it yet.
- **`supervision`** — `<stateDir>/records/req-*.json`, written by the extension and the `supervise`
  CLI since before the audit trail existed. These carry a traffic light, a lifecycle state and a
  rule trace but **no clause citation**, so `clause.id` is empty for them. That gap is the reason
  the audit trail exists, and printing it empty is how it stays visible.

Two translations happen on the way in, and both are deliberate. A hook record's `decision: "allow"`
with `rewritten: true` reads as outcome **`correct`** — the correction lane is the distinction the
whole trail exists to make. And `decision: "none"`, which means the hook reached no verdict at all
(an exempt tool, or observe mode), reads as **`unknown`**, never as `allow`: a layer that records a
decision it did not take is a layer whose trail cannot be used as evidence.

A half-written line is skipped and the rest of the trail is still returned: a governance log that
becomes unqueryable because of one truncated write is a log you cannot use in the situation you
most need it.

---

## `digest`

What your agents did last night — one page per session.

```
session-sitter digest [options]
```

| Flag | Default | What it does |
|---|---|---|
| `--since WHEN` | 18:00 yesterday | window start |
| `--session ID` | all | one session |
| `--state-dir PATH` | searched | read this state dir |
| `--json` | off | machine-readable ([contract](#digest-json)) |

The default window is a fixed point, not a sliding 24 hours: the question is asked in the morning
about the evening before, and a window that slides answers a different question every time it runs.

Each page carries the session name, its id, what it was asked, the span it actually covered, the
decision counts by lane, the clauses that fired with how often, and the cost. Busiest session
first — on a morning read, the one that did the most is the one to check.

```
digest 08-31 18:00 → 09-01 08:12
3 sessions · 7 decisions

── nightly dependency bump ────────────────────────── claude · buildbox
  session   s-night-1
  asked     bump the pinned deps and open a PR
  window    08-31 21:04 → 08-31 22:31
  decisions 3 · 1 corrected · 0 escalated · 1 denied
  clauses   practices§1: read-only tools never need a prompt
            practices§4: never force-push to a shared branch
            practices§7: never delete a production database
  cost      $0.0043
```

A session with no recorded cost reports `not recorded`, and `costUsd` is `null` in the JSON. **Do
not read that as `0`** — that distinction is why the field is nullable rather than defaulted.

---

## `policy check`

Lint a practices file, and replay real decisions against it.

```
session-sitter policy check [PATH] [options]
```

`PATH` defaults to the first of `PRACTICES.md`, `practices.md`, `docs/PRACTICES.md`,
`.claude/PRACTICES.md` that exists in the working directory.

| Flag | Default | What it does |
|---|---|---|
| `--replay N` | off | re-decide the last N real decisions against this policy and report which would change |
| `--state-dir PATH` | searched | where `--replay` reads decisions from |
| `--json` | off | machine-readable ([contract](#policy-json)) |

Exit `0` when every clause parsed, `1` when something did not — so this works as a CI step.

The parser itself lives in `src/policy/` and is built separately. This command
loads it at runtime and does **not** contain a second parser: two parsers would disagree about what
a clause is, which is exactly the failure a citable clause exists to prevent. When the parser is
absent, `policy check` says so and exits 1 rather than guessing.

`--replay` needs a decision function from that module. Decisions with no recorded tool input are
counted as **skipped**, never as unchanged — a replay that quietly ignores half the trail would
report a reassuring number about the wrong half.

---

## `policy explain`

**What would happen if the agent tried this, and which clause decides it?** Answered without running
the call, without a model, and without writing anything.

```
session-sitter policy explain <tool> [--command CMD | --input JSON] [--rev REVISION|current] [--json]
```

```console
$ session-sitter policy explain Bash --command 'git status && aws s3 rb s3://x'
WOULD DENY  ·  rung 3 (written red clause)  ·  revision 2b5481a3
  practices §pay-storage-001@2b5481a — Never delete a bucket
  Deleting a bucket takes its contents and its name with it, and the name cannot be reclaimed.
  ↳ source: data/knowledge/teams/payments/bottom-line.md
  ↳ sub-command 2 of 2: aws s3 rb s3://x

  3 clause(s) evaluated from the compiled artifact
  no model call · 0 tokens · 2.96 ms of policy work
  this decides nothing — the PermissionRequest hook decides, and it will decide again when the call
  actually runs.
```

| Flag | Default | What it does |
|---|---|---|
| `--command CMD` | — | shorthand for `--input '{"command":"CMD"}'` |
| `--input JSON` | — | the whole tool input, as a JSON object. Use this for `Write`, `WebFetch`, anything that is not a shell call |
| `--rev REV` | the published revision | explain against a **retained** revision instead, so an old citation resolves to the text that actually fired. `current` is the explicit form of the default |
| `--json` | off | machine-readable ([contract](#policy-explain-json)) |

### It is the same code as the hook, and that is the whole point

`explain` calls `loadPolicyInputs` → `decideDeterministically` → `routeAmbiguous` →
`selectForPolicy` / `cite` — the exact functions
[`src/hooks/permissionRequest.ts`](../src/hooks/permissionRequest.ts) calls when it decides for real.
It contains no evaluator of its own. A retrieval surface with a second evaluator disagrees with the
enforcement path on the day somebody asks *why* a call was denied, which is the one day the answer
matters.

The rung it prints is carried on the hook's own verdict, not re-derived here. `src/test/policy/explain.test.ts`
runs a table of twelve calls through both `handle` and `explain` and asserts identical light, clause,
revision, source and behaviour.

### It cannot authorise anything

- It writes **nothing**. Not to `decisions.jsonl`, not anywhere: hypotheticals in an audit trail
  destroy the trail as a record. `src/policy/explain.ts` imports nothing that can write, and a test
  byte-compares the trail across a query.
- Its output field is `would`, not `behavior`, and it emits no `hookSpecificOutput`. Nothing
  downstream can read it as a `PermissionRequest` response, even by accident.
- The classifier rung is **reported, never run**. `WOULD ASK · rung 6` means "this would go to the
  classifier"; no tokens are spent finding out what it would say.

### Reading an old decision

A decision record names the revision it was evaluated against. Feed that back in and you get the
clause text as it read then, not as it reads now:

```console
$ session-sitter policy explain Bash --command 'git push --force origin main' --rev 8339cfd1df8d…
WOULD DENY  ·  rung 3 (written red clause)  ·  revision 8339cfd1
  practices §pay-git-002@8339cfd — Never force-push to a shared branch
  ↳ correction force-push-to-lease was rejected by practices §pay-git-002

$ session-sitter policy explain Bash --command 'git push --force origin main'
WOULD ALLOW  ·  rung 2 (the correction lane — rewritten into its safer form)  ·  revision 2b5481a3
```

Same call, two revisions, two answers — because the clause was narrowed in between. A named revision
that has rolled off retention **refuses** rather than answering from `current.json`: a query that
silently changes source is the same class of lie as a second evaluator.

### When the policy is missing or broken

Every failure degrades to an answer plus a diagnosis. Nothing throws, and nothing ever reads as
"allowed" because a file was unreadable.

| Condition | What it prints | Exit |
|---|---|---|
| no compiled artifact, markdown corpus readable | the verdict, plus `answered from the markdown corpus, not a compiled artifact: <why>` | 0 |
| artifact unparsable / wrong `schema_version` / compiled for another routing triple | falls back to the corpus and names the reason in `policy.degraded` | 0, or 1 if the corpus is empty too |
| neither source readable | the verdict (rung 7, fail closed) plus `why:` naming **both** failures and `fix:` naming the two commands that resolve it | 1 |
| configured `SESSION_SITTER_PRACTICES` unreadable | the same rung-7 verdict the hook gives, diagnosed as *your configured practicesFile `<path>` could not be read* — not "supervisor error". It is a configuration mistake you fix in one edit | 1 |
| `--rev` naming a revision that rolled off, or a corrupt one | one line on stderr saying so, and *nothing was answered from a different revision instead* | 1 |
| a clause whose pattern no longer compiles | skipped; every other clause still decides | 0 |

`policy.source` in `--json` always names which source actually answered, and `policy.degraded`
always says why the artifact did not.

---

## `export`

The decision trail, as ndjson or as one self-contained HTML file. **The app never pushes** — `export`
writes to stdout and whatever you chose reads it, so there is no exporter, no agent, no SDK, and
nothing that has to keep in step with somebody else's schema.

```
session-sitter export --jsonline [options]
session-sitter export --html [options] > report.html
```

| Flag | Default | What it does |
|---|---|---|
| `--jsonline` | — | newline-delimited JSON on stdout, one object per decision |
| `--html` | — | one self-contained HTML snapshot on stdout |
| `--scope local\|team` | `local` | `team` applies the allow-list below |
| `--since WHEN` | all | `2h`, `7d`, `2026-08-30`, or an ISO instant |
| `--limit N` | 2000 | keep the newest N records |

Exactly one of `--jsonline` / `--html` is required. Exit `1` when there is no trail to read, `2` on a
bad flag.

### `--jsonline`, and why the shipper is `curl`

A `DecisionRecord` already *is* ndjson with an ISO `ts`, so nothing needs converting:

```bash
# once — a 10.4 MB zero-config binary, no installer, no account
curl -sL https://github.com/VictoriaMetrics/VictoriaLogs/releases/download/v1.52.0/victoria-logs-darwin-arm64-v1.52.0.tar.gz | tar xz

# -httpListenAddr is NOT optional. The default binds every interface, which on a café
# network publishes your audit trail to every device on it.
./victoria-logs -storageDataPath=./vlogs -httpListenAddr=127.0.0.1:9428 -retentionPeriod=90d

session-sitter export --jsonline --since 7d \
  | curl -s -X POST --data-binary @- \
    '127.0.0.1:9428/insert/jsonline?_time_field=ts&_msg_field=note,inputSummary&_stream_fields=tool,actor'

open http://127.0.0.1:9428/select/vmui
```

Nothing ships automatically. There is no `SessionEnd` egress: this is a command you run, or a cron
you wrote.

### `--html` is a report, not a live view

One file, opened over `file://`, mailed, or committed to a private repo. No CDN, no chart library, no
web fonts, no remote images — offline `file://` and the webview CSP both forbid remote fetches, so the
only chart is an inline `<svg>` and the bars are CSS gradients in ordinary tables.

A stale page that looks live is worse than no page, so it says what it is in seven places: the title
and heading end in **"— snapshot"** and never say the other word; a header band carries the generation
instant, the window as two **absolute** instants, the revisions, the record count and whether
`--limit` truncated it, and the version and host; **the regeneration command ships verbatim inside the
thing that goes stale**; there are no relative timestamps anywhere, because "3 minutes ago" is exactly
the lie a static file tells; a few lines of script compare your clock to the embedded generation
instant and paint a band past 24 h, which is the only staleness signal that can be true at *view*
time; there are no live affordances at all — no meta refresh, no poll, no heartbeat; and a cell
nothing recorded prints **"not recorded"**, never `0`.

What it therefore cannot do: tail, ad-hoc query, roll up across machines, alert. Those are why you
pipe `--jsonline` into something instead, and the header band says which ones you are missing.

### `--scope=team`: projection, not redaction

**Masking is not anonymisation.** `redactSecrets` matches credential *shapes*. It cannot know that
`curl https://payments-internal.example/v2/…` names a customer, that a path under `customers/` names a
deal, or that a `note` quotes a sentence somebody typed about an unannounced product.

So the team scope is an explicit allow-list that **drops keys**, never blanks them — a dashboard
filter is a display choice over data that already left the machine, and a blanked key is a column
somebody later fills in.

| Field | `local` (default) | `team` |
|---|---|---|
| `ts`, `latencyMs`, `tool`, `decision`, `light`, `actor`, `rewritten` | as written | as written |
| `clause`, `rev`, `policySource` | as written | as written — a clause is the team's own written practice, the least sensitive thing in the record |
| `telemetry` token counts | as written | as written — counts, never content |
| `sessionId`, `cwd` | raw | HMAC under a key generated once per machine (`.export-key`, mode 0600): correlatable *within* a stream, not back to a repository |
| `inputSummary` | as written (already redacted) | **dropped**, replaced by `toolShape` — `Bash git push`, never the command line — plus `inputFingerprint` |
| `note`, `call` (`original_input` / `updated_input`), `ask`, `session_name`, assessment prose | as written | **dropped** |

**There is no flag that ships the excluded set**, and because the projection drops keys the ship
command above is **byte-identical in both scopes**: `_msg_field=note,inputSummary` simply finds
neither field in a team payload and falls back. That is the design, not a coincidence — there is no
scope-aware branch downstream, no second code path to get wrong, and no toggle anyone can flip. A
command that is safe in both scopes cannot be misconfigured into unsafety; a `--redact` toggle can be,
and eventually is.

A team log store is a **new system of record with its own retention**, not a mirror. Set
`-retentionPeriod` explicitly and bind it to `127.0.0.1`.

---

## Who invokes what

The surface question has three answers because three people ask it.

| | **Solo dev** | **Team lead** | **On SSH, no browser** |
|---|---|---|---|
| Where they are | one laptop, no team tier | a checkout of the corpus repo, reviewing PRs | a terminal, and nothing else |
| Primary surface | the hook, silently. The denial message names the clause and quotes it, so most days they invoke nothing | `policy explain` to test a clause *before* writing it; `policy check --replay` for the blast radius of an edit | `session-sitter` on `$PATH` |
| Concretely | third time the same thing is blocked: `/session-sitter:explain`, then the `writing-practices` skill | `policy explain <tool> --command …` · `policy check <file> --replay` · `policy compile --dry-run` in CI · `policy ablate` for clauses that stopped mattering | `session-sitter policy explain … --json`, `log --denied`, `digest --since 24h`, `export --html > report.html` to hand someone a file — and `session-sitter daemon` as a user unit, because nothing else expires an escalation on that machine |
| Do they need the skill? | **yes, most of all** — no reviewer, so the pre-flight check is the only thing between them and a denial loop | rarely; they read the corpus directly | no; they type the command |

**The bare-terminal path is not a degraded path.** The plugin's hooks are plain `node` commands
invoked by path, `src/supervisor/*` contains no `import 'vscode'`, and `session-sitter` needs no
session running at all. Everything on this page works over SSH with no browser, no VS Code and no
account:

```bash
session-sitter policy explain Bash --command 'terraform apply' --json | jq -r '.would, .clause'
```

That is also the CI path: exit 0 answered, 1 no policy loaded, 2 bad arguments.

One thing on that machine is **not** free, and saying so is the honest version of the claim above:
if you use escalation, something has to be resident to expire a card nobody answered. That is
[`session-sitter daemon`](#daemon), and without it an escalated call stays pending instead of failing
closed at its deadline. The governance decision itself needs nothing resident — the hook decides
in-process — so this applies only to the escalation path.

A surface a solo dev *must* invoke to get value is a surface that failed — so the hook decides
silently, the denial explains itself, and `explain` is there for the third time the same thing gets
blocked.

---

## Where state is read from

`log`, `digest` and `policy check --replay` read decisions from two *kinds* of place, and the
difference matters: one is a state dir, and one is the plugin's own data dir.

**The hook trail — always read.** `<dataDir>/decisions.jsonl`, where `dataDir` is
`$SESSION_SITTER_DATA_DIR`, else `$CLAUDE_PLUGIN_DATA` (the directory Claude Code hands an installed
plugin), else `~/.claude/session-sitter`. This is the file the plugin's hooks append to, and **on a
terminal-only machine it is the only trail there is** — the hooks are the only front end running.

**The state dir — searched, first populated one wins.** Two conventions, both looked at, in order:

1. `$STATE_DIR`, or a `.env` beside the working directory that sets it (the same resolution
   [`src/supervisor/config.ts`](../src/supervisor/config.ts) applies), else
   `<cwd>/.supervisor-state` — where the `supervise` CLI writes.
2. `<VS Code user dir>/globalStorage/eranra.session-sitter/state` — where the extension writes when
   `sessionSitter.supervisorStateDir` is unset.

The first that actually holds an `audit.jsonl` or a `records/` directory wins.

**The hook trail is read *as well as* the state dir, never instead of it.** A machine can have both —
an IDE window supervising sessions, and terminal sessions governed by the same practices — and
showing one while hiding the other is the worst failure available to an evidence tool. It is also the
bug this resolution replaced: `log` reported `No supervision state found` on machines whose
`decisions.jsonl` had been filling up for weeks, because the hook trail was not among the places it
looked.

`--state-dir PATH` is the one exception. It is honoured outright, even when empty, **and to the
exclusion of the hook trail** — being told where to look and reading somewhere else as well is not a
favour either. Pass it when you mean one directory and nothing else.

Every command reports what it actually read — in text as the trailing `·`-separated path, in `--json`
as `stateDir` plus `hookTrail` — and every empty result lists every place it looked, the hook trail
included.

---

## The `--json` contracts

Other tools read these, so two rules apply to changing them: **fields are added, never
repurposed**, and `version` goes up the day a field's meaning changes. An unrecorded value is
`null` or `""` — never omitted, never filled in.

### `status --json` <a id="status-json"></a>

```json
{
  "version": 1,
  "generatedAt": "2026-09-01T08:12:44.101Z",
  "host": "buildbox",
  "counts": {
    "total": 11, "approval": 2, "question": 0, "finished": 3, "working": 1, "seen": 4, "dormant": 1
  },
  "sessions": [
    {
      "sessionId": "ad5078c2-07a1-43a2-a01b-a88d72925d2c",
      "agent": "claude",
      "title": "extract the pure readers out of SessionManager",
      "workspace": { "name": "session-sitter", "path": "/Users/u/session-sitter" },
      "machine": "buildbox",
      "local": true,
      "status": "approval",
      "blockedOnYou": true,
      "updatedAt": "2026-09-01T08:11:58.707Z",
      "ageSeconds": 45
    }
  ],
  "peers": [
    { "peer": "u@other", "reachable": false, "sessionCount": null, "error": "publickey" }
  ]
}
```

| Field | Notes |
|---|---|
| `host` | this machine's short name |
| `counts` | `total` plus one key per state, always all six, at `0` when empty |
| `agent` | `claude` \| `bob` \| `codex` \| `chat` |
| `machine` | short host; this machine for a local session, the peer's for a remote one |
| `status` | one of `approval` \| `question` \| `finished` \| `working` \| `seen` \| `dormant` — the same value the panel renders |
| `blockedOnYou` | `true` for `approval` and `question`, so a consumer need not hard-code which two those are |
| `peers` | empty unless `--peers`; `sessionCount` and `error` are `null` when not reported |

`status` is the single source of truth and `blockedOnYou` is derived from it — a consumer may branch
on either. The six values are a closed set: a seventh state would be a `version` bump, because a
switch over the six is the natural way to read this field.

### `log --json` <a id="log-json"></a>

```json
{
  "version": 1,
  "generatedAt": "2026-09-01T08:12:44.101Z",
  "stateDir": "/Users/u/repo/.supervisor-state",
  "hookTrail": "/Users/u/.claude/session-sitter/decisions.jsonl",
  "populated": true,
  "count": 1,
  "decisions": [
    {
      "id": "audit.jsonl:1",
      "from": "audit",
      "at": "2026-08-31T21:04:11.000Z",
      "sessionId": "s-night-1",
      "sessionName": "nightly dependency bump",
      "host": "buildbox",
      "agent": "claude",
      "tool": "Bash",
      "light": "yellow",
      "outcome": "correct",
      "actor": "rule",
      "clause": { "id": "practices§4", "text": "never force-push to a shared branch" },
      "rewritten": true,
      "reason": "rewritten to --force-with-lease",
      "latencyMs": 7,
      "costUsd": 0.0012
    }
  ]
}
```

| Field | Notes |
|---|---|
| `stateDir` | which state dir was read |
| `hookTrail` | the plugin's `decisions.jsonl` when it was read; `null` when it does not exist, or when `--state-dir` confined the read to one directory |
| `populated` | whether either store held anything a reader can use |
| `id` | the request id for a supervision record; `<file>:<line>` for a trail line, so the row traces back to disk |
| `from` | `audit` \| `supervision` — which writer it came from |
| `light` | `green` \| `yellow` \| `orange` \| `red`, or `""` |
| `outcome` | see [outcomes](#outcomes) |
| `actor` | `rule` \| `classifier` \| `human` from the older writers; `deterministic` \| `policy` \| `correction` \| `classifier` \| `human` \| `timeout` from the hook trail, which records *which* rung answered. `""` when not recorded. |
| `clause` | `null` when no clause was cited — distinct from a cited clause with empty text |
| `rewritten` | `true` only for the correction lane |
| `latencyMs`, `costUsd` | `null` when not recorded. Not `0`. |

### `log --csv`

One header row, then one row per decision, RFC 4180 quoted. An unrecorded number is an **empty
cell**, never `0` — a spreadsheet that reads a missing cost as zero under-reports every total.

```
at,session_id,session_name,host,agent,tool,light,outcome,actor,clause_id,clause_text,rewritten,latency_ms,cost_usd,reason
```

### `digest --json` <a id="digest-json"></a>

```json
{
  "version": 1,
  "generatedAt": "2026-09-01T08:12:44.101Z",
  "window": { "since": "2026-08-31T17:00:00.000Z", "until": "2026-09-01T08:12:44.101Z" },
  "stateDir": "/Users/u/repo/.supervisor-state",
  "hookTrail": "/Users/u/.claude/session-sitter/decisions.jsonl",
  "populated": true,
  "totals": {
    "sessions": 3, "decisions": 7, "corrected": 1, "escalated": 1, "denied": 3, "costUsd": 0.0043
  },
  "sessions": [
    {
      "sessionId": "s-night-1",
      "sessionName": "nightly dependency bump",
      "agent": "claude",
      "host": "buildbox",
      "ask": "bump the pinned deps and open a PR",
      "decisions": 3,
      "corrected": 1,
      "escalated": 0,
      "denied": 1,
      "clauses": [{ "clause": "practices§4: never force-push to a shared branch", "count": 1 }],
      "firstAt": "2026-08-31T21:04:11.000Z",
      "lastAt": "2026-08-31T22:31:40.000Z",
      "costUsd": 0.0043
    }
  ]
}
```

`ask` is `""` when no record carried it. `costUsd` is `null` when nothing in the window recorded a
cost, at both the session and the totals level.

### `policy explain --json` <a id="policy-explain-json"></a>

```json
{
  "would": "deny",
  "rung": 3,
  "rungLabel": "written red clause",
  "actor": "policy",
  "light": "red",
  "clause": "practices §pay-storage-001",
  "citation": "practices §pay-storage-001@2b5481a",
  "title": "Never delete a bucket",
  "message": "Deleting a bucket takes its contents and its name with it, and the name cannot be reclaimed.",
  "sourceFile": "data/knowledge/teams/payments/bottom-line.md",
  "fix": null,
  "rewritten": null,
  "note": "denied — practices §pay-storage-001: Never delete a bucket",
  "policy": {
    "source": "artifact",
    "rev": "sha256:2b5481a315c3b9cb…",
    "degraded": null,
    "clauses": 3,
    "elapsedMs": 2.96
  },
  "selection": {
    "matched": ["pay-storage-001"],
    "shown": 1,
    "subsetLine": "(1 of 3 clauses shown — policy revision 2b5481a3, core 0, selected 1)"
  }
}
```

`would` is `allow`, `deny` or `ask` — deliberately **not** `behavior`, so this object is not
paste-compatible with a hook response. `actor` is the tier the trail would record — `deterministic`,
`policy`, `correction`, `model`, `timeout` — so a script can diff an explain against the record of the
same call field for field; it is `null` only on the classifier rung, where which actor reaches the
record depends on a model call an explain never makes. `policy.source` is `artifact` or `markdown` and always names
what actually answered. `citation` carries the `@<rev7>` suffix only when an artifact answered;
on the markdown fallback it is `null` and `clause` alone is the citation. `rewritten` is the
correction lane's rewrite when there would be one, and `selection` is the bounded per-call set the
classifier would receive — `null` on the markdown fallback, which has no selector.

### `policy check --json` <a id="policy-json"></a>

```json
{
  "version": 1,
  "generatedAt": "2026-09-01T08:12:44.101Z",
  "path": "PRACTICES.md",
  "ok": true,
  "clauses": [
    { "id": "practices§4", "text": "never force-push to a shared branch", "light": "red", "line": 9 }
  ],
  "issues": [],
  "replay": {
    "considered": 12,
    "skipped": 3,
    "changed": 1,
    "changes": [
      {
        "id": "audit.jsonl:7",
        "at": "2026-08-31T21:04:11.000Z",
        "tool": "Bash",
        "was": "allow",
        "now": "deny",
        "clauseId": "practices§4"
      }
    ]
  }
}
```

`ok` is the single field a CI step should branch on. `replay` is `null` when `--replay` was not
asked for; `skipped` counts the decisions that carried no tool input, so a consumer can see how much
of the trail could not be re-decided.

---

## Related

- [`docs/SUPERVISION.md`](SUPERVISION.md) — the traffic lights, the lifecycle, and the `supervise`
  CLI that writes the records `log` reads
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — the components, and where session detection lives
- [`docs/CONFIGURATION.md`](CONFIGURATION.md) — every setting and environment variable
