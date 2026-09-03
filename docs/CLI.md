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
```

---

## Contents

- [Common conventions](#common-conventions)
- [`status`](#status)
- [`log`](#log)
- [`digest`](#digest)
- [`policy check`](#policy-check)
- [`policy explain`](#policy-explain)
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

### The two writers

`log` reads both and labels each decision with its origin in `--json` (`from`):

- **`audit`** — `<stateDir>/audit.jsonl`, one JSON object per decision, written by the hook front
  end. Carries the clause citation, the actor, the latency and the rewritten input.
- **`supervision`** — `<stateDir>/records/req-*.json`, written by the extension and the `supervise`
  CLI since before the audit trail existed. These carry a traffic light, a lifecycle state and a
  rule trace but **no clause citation**, so `clause.id` is empty for them. That gap is the reason
  the audit trail exists, and printing it empty is how it stays visible.

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

## Who invokes what

The surface question has three answers because three people ask it.

| | **Solo dev** | **Team lead** | **On SSH, no browser** |
|---|---|---|---|
| Where they are | one laptop, no team tier | a checkout of the corpus repo, reviewing PRs | a terminal, and nothing else |
| Primary surface | the hook, silently. The denial message names the clause and quotes it, so most days they invoke nothing | `policy explain` to test a clause *before* writing it; `policy check --replay` for the blast radius of an edit | `session-sitter` on `$PATH` |
| Concretely | third time the same thing is blocked: `/session-sitter:explain`, then the `writing-practices` skill | `policy explain <tool> --command …` · `policy check <file> --replay` · `policy compile --dry-run` in CI | `session-sitter policy explain … --json`, `log --denied`, `digest --since 24h` |
| Do they need the skill? | **yes, most of all** — no reviewer, so the pre-flight check is the only thing between them and a denial loop | rarely; they read the corpus directly | no; they type the command |

**The bare-terminal path is not a degraded path.** The plugin's hooks are plain `node` commands
invoked by path, `src/supervisor/*` contains no `import 'vscode'`, and `session-sitter` needs no
session running at all. Everything on this page works over SSH with no browser, no VS Code and no
account:

```bash
session-sitter policy explain Bash --command 'terraform apply' --json | jq -r '.would, .clause'
```

That is also the CI path: exit 0 answered, 1 no policy loaded, 2 bad arguments.

A surface a solo dev *must* invoke to get value is a surface that failed — so the hook decides
silently, the denial explains itself, and `explain` is there for the third time the same thing gets
blocked.

---

## Where state is read from

`log`, `digest` and `policy check --replay` need the supervision state dir. There are two
conventions in this project, and both are searched, in order:

1. `--state-dir PATH` — honoured outright, even when empty. Being told where to look and looking
   somewhere else is not a favour.
2. `$STATE_DIR`, or a `.env` beside the working directory that sets it (the same resolution
   [`src/supervisor/config.ts`](../src/supervisor/config.ts) applies), else
   `<cwd>/.supervisor-state` — where the `supervise` CLI writes.
3. `<VS Code user dir>/globalStorage/eranra.session-sitter/state` — where the extension writes when
   `sessionSitter.supervisorStateDir` is unset.

The first that actually holds an `audit.jsonl` or a `records/` directory wins. Every command reports
which one it used (in `--json` as `stateDir`), and every empty result lists the places it looked.

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
| `stateDir`, `populated` | which directory was read, and whether it held anything |
| `id` | the request id for a supervision record; `audit.jsonl:<line>` for a trail line |
| `from` | `audit` \| `supervision` — which writer it came from |
| `light` | `green` \| `yellow` \| `orange` \| `red`, or `""` |
| `outcome` | see [outcomes](#outcomes) |
| `actor` | `rule` \| `classifier` \| `human`, or `""` |
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
paste-compatible with a hook response. `policy.source` is `artifact` or `markdown` and always names
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
