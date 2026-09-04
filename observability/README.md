# Observing Session Sitter

Three tiers. **Pick the lowest one that answers your question**, because each one above it is more to
run and none of them holds anything the tier below cannot regenerate.

| | You get | You install | You lose |
|---|---|---|---|
| **[Tier 0](#tier-0--nothing-installed)** | the terminal, and one HTML file you can email | **nothing** | live tail, ad-hoc query, cross-machine, alerts |
| **[Tier 1](#tier-1--one-binary)** | full history, LogsQL, live tail, several machines in one view | one 10.4 MB binary | portability — you cannot email a running process |
| **[Tier 2](#tier-2--grafana-over-victorialogs)** | shared dashboards, annotations, **alert rules** | Docker, two containers | Docker, AGPL in the tree you run, one plugin fetch |

**The store of record never moves.** `decisions.jsonl` and `pipeline.jsonl` on each machine are the
only durable copies. Every tier above tier 0 is a *projection* of them, which is why moving up is one
flag and moving back down is `docker compose down -v` — see [Moving back down](#moving-back-down).

**Alerting is the honest reason to run tier 2.** Charts are not: tier 0 draws the same aggregates and
tier 1's built-in UI queries them.

---

## Tier 0 — nothing installed

This is the default and it is not the fallback. It is where most people should stay.

### One command

```bash
session-sitter export --html > report.html && open report.html
```

That file is self-contained — no CDN, no chart library, no web fonts, no remote images — so it works
over `file://`, survives being mailed, and can be committed to a private repo. It carries the outcome
mix over time, the ladder with per-rung latency, which clauses fired, prefix rewrites by revision, the
denials and rewrites as a readable list, **the offline pipeline's funnel and every run including the
ones that produced nothing**, and **the resolved config with the terminal command that changes each
setting**.

It is a **report, not a live view**, and it says so in seven places rather than letting you find out:
the title ends in "— snapshot", every instant in it is absolute, the regeneration command ships
verbatim inside the thing that goes stale, and a few lines of script compare your clock to the embedded
generation instant and paint a band past 24 hours. A stale page that looks live is worse than no page.

### And the terminal, which is the primary surface

```bash
session-sitter status                  # every session, and which need you
session-sitter log --denied            # what got blocked
session-sitter digest --since 24h      # last night, one page per session
session-sitter learn --status          # the last five pipeline runs, with refusal reasons
session-sitter policy check            # lint the practices, replay decisions against them
session-sitter explain <decisionId>    # one decision, all the way down
```

`explain` is the deepest answer in the system and no dashboard replaces it: it replays the selector
against `policy/<rev>.json` and prints the whole ranked considered-set with include and exclude
reasons. A log store has the trail but not the artifact, so that join is a CLI command at every tier.

---

## Tier 1 — one binary

No Docker, no daemon manager, no JVM, no account, no config file.

```bash
# once. 10.4 MB compressed, one static Go binary, no installer.
curl -sL https://github.com/VictoriaMetrics/VictoriaLogs/releases/download/v1.52.0/victoria-logs-darwin-arm64-v1.52.0.tar.gz | tar xz

# run. -httpListenAddr is NOT cosmetic — see "Two flags that are not optional" below.
./victoria-logs-prod -storageDataPath=./vlogs -httpListenAddr=127.0.0.1:9428 -retentionPeriod=90d

# ship. No shipper, no agent, no exporter, no SDK — the exporter is curl.
session-sitter export --jsonline --since 30d \
  | curl -s -X POST -H 'Content-Type: application/x-ndjson' --data-binary @- \
    '127.0.0.1:9428/insert/jsonline?_time_field=ts&_msg_field=note,inputSummary,headline&_stream_fields=kind,machine'

open http://127.0.0.1:9428/select/vmui
```

`session-sitter export --jsonline --help` prints that ship command, so you never have to remember it.

### Two flags that are not optional, and one header

**`-httpListenAddr=127.0.0.1:9428`.** VictoriaLogs' default is `-httpListenAddr=:9428`, which binds
**every interface**. On a café network that publishes your team's redacted-but-real command lines to
every device on it. This is the single most likely way this design leaks.

**`-retentionPeriod`.** Set it explicitly. A log store you ship to is a new system of record with its
own retention, not a mirror of your laptop.

**`-H 'Content-Type: application/x-ndjson'`.** Without it **this command silently ships nothing.**
`curl --data-binary` defaults to `Content-Type: application/x-www-form-urlencoded`, and VictoriaLogs
v1.52.0 discards the body of a form-urlencoded POST to `/insert/jsonline` while still answering
**HTTP 200** — no error, `vl_http_errors_total` unmoved, `vl_rows_ingested_total` flat at zero. The
shell tells you nothing; the only symptom is an empty store. If your UI is empty, check this first:

```bash
curl -s 127.0.0.1:9428/metrics | grep '^vl_rows_ingested_total'
```

### Two kinds of line, one pipe

`export --jsonline` emits both the online and the offline story, tagged so a store holding both can
tell them apart:

| `kind` | One line per | Query it with |
|---|---|---|
| `decision` | governance decision | `kind:decision` |
| `pipeline_run` | `session-sitter learn` invocation | `kind:pipeline_run` |

Every line also carries `machine` — the real hostname at `--scope=local`, a per-machine HMAC at
`--scope=team`. That field is why several laptops can POST into one instance and still be told apart,
which is the one capability tier 0 structurally cannot have.

### Queries worth keeping

Verified against VictoriaLogs v1.52.0. Paste them into vmui.

```logsql
# the outcome mix, one bar per day — is the SHAPE changing?
_time:30d kind:decision | stats by (_time:1d, decision) count() decisions

# which rung decided, and what each cost. The rung is derived from (actor, decision).
_time:30d kind:decision | stats by (actor, decision) count() n,
  quantile(0.5, latencyMs) p50, quantile(0.95, latencyMs) p95 | sort by (n desc)

# THE cost query: prefix rewrites by revision. One per rev is correct; several is the regression.
_time:30d kind:decision telemetry.cache_creation_input_tokens:>0 | stats by (rev) count() rewrites

# every cache figure needs this filter and this denominator. Rungs 1-5 call no model, so a null
# there is NOT a miss, and a rate over all decisions is a number nobody can interpret.
_time:30d kind:decision telemetry.tier:* | stats count() model_decisions,
  sum(telemetry.cache_read_input_tokens) read, sum(telemetry.cache_creation_input_tokens) written

# fail closed — the one series whose RISE is unambiguously bad news
_time:30d kind:decision actor:timeout | stats by (_time:1d) count() fail_closed

# the offline pipeline: runs that correctly produced nothing. No file, no commit, only this row.
_time:30d kind:pipeline_run producedNothing:true | stats count() produced_nothing

# what the pipeline refused, and why. `unroll` splits the per-run refusal array into rows.
_time:30d kind:pipeline_run refusalCount:>0 | unroll (refusals)
  | stats by (refusals) count() times | sort by (times desc)

# live follow
kind:decision decision:deny
```

### Shipping again without double-counting

VictoriaLogs does not dedupe on ingest, so re-shipping the same window inserts it twice. `export`
records the instant of its last successful ship and defaults `--since` to it, so a cron or a shell
alias is idempotent. An explicit `--since` overrides that and does **not** move the watermark — which
is what you want for a one-off backfill and not what you want in a cron.

---

## Tier 2 — Grafana over VictoriaLogs

For a team, or for alerting.

```bash
cd observability
docker compose up -d

# ship, from any machine that has a trail
session-sitter export --jsonline --since 30d \
  | curl -s -X POST -H 'Content-Type: application/x-ndjson' --data-binary @- \
    '127.0.0.1:9428/insert/jsonline?_time_field=ts&_msg_field=note,inputSummary,headline&_stream_fields=kind,machine'

open http://127.0.0.1:3000
```

Two dashboards land in a **Session Sitter** folder:

- **[Session Sitter — decisions](dashboards/session-sitter-decisions.json)** — the online path. The
  outcome mix over time, the fail-closed alarm series, which rung decided and what it cost, which
  clauses fired, prefix rewrites by revision, and the denials as a readable log.
- **[Session Sitter — the offline pipeline](dashboards/session-sitter-pipeline.json)** — the offline
  path. Runs over time by exit reason, the sessions-in-practices-out funnel, what was refused and why,
  and every run including the ones that correctly produced nothing.

### Dashboards as code, and why the UI copy is read-only

They are committed JSON, reviewed like the practices file they report on. `allowUiUpdates: false` in
the provisioning config, and `editable: false` on each dashboard, are deliberate: a dashboard edited
in the UI and never committed is a dashboard nobody else has. Change one by editing the JSON and
re-running `docker compose up -d` — Grafana re-reads the directory every 30 s.

Every panel carries a description explaining what it answers and, where it matters, what it *cannot*
answer. Hover the ⓘ.

### Alert rules — the honest reason to be here

Grafana can alert on any of these queries. The ones worth wiring first:

| Alert | Query | Why |
|---|---|---|
| fail-closed rate rising | `kind:decision actor:timeout \| stats count() n` | a broken artifact or an unreachable classifier |
| the pipeline stopped running | `kind:pipeline_run \| stats count() n` over 48 h | it leaves no artefact when it produces nothing, so silence looks identical to health |
| a pipeline run errored | `kind:pipeline_run failed:true \| stats count() n` | distinct from producing nothing |
| prefix rewrites inside one rev | `kind:decision telemetry.cache_creation_input_tokens:>0 \| stats by (rev) count() n` | the 6.8× cost regression |
| model p95 over 2 s | `kind:decision actor:model \| stats quantile(0.95, latencyMs) p95` | rung 6 is the only rung allowed to be slow, and only this slow |
| two revisions live at once | `kind:decision \| stats by (rev) count() n` | each distinct prefix is paid for separately |

### Anonymous admin, and why it is defensible here

`GF_AUTH_ANONYMOUS_ENABLED=true` is in the compose file, and it is only acceptable **because both
ports are published on `127.0.0.1`**. If you ever unbind either from loopback, turn anonymous auth off
in the same edit. There is nothing else guarding this instance.

### Airgapped

`GF_INSTALL_PLUGINS` needs the network once, on first start. Grafana ships the **Loki** datasource in
core but not this one, which is the concrete reason Grafana+Loki is the named runner-up rather than a
rejected option. If a one-time fetch is unacceptable, either vendor the plugin zip into
`/var/lib/grafana/plugins`, or swap VictoriaLogs for Loki, whose datasource provisions from YAML with
no download. If you take the Loki path, read [Label cardinality](#label-cardinality) first — Loki
punishes the same mistake harder.

### Label cardinality

`_stream_fields=kind,machine`, and nothing else. That is not an oversight.

A stream field **partitions the store**; it is not "the columns I want to group by". Every field in
the line is queryable either way, so naming one here buys nothing and costs a stream per distinct
combination, each with its own index entry and its own write buffer.

`kind` is two values and `machine` is however many machines one person owns, so the product is bounded
by hardware. Adding `tool` and `actor` multiplies it by ~120 for no query benefit. Adding `clause`
multiplies it by the rendered-clause ceiling. Adding `sessionId` or `rev` makes it **unbounded by
construction** — one new stream per session or per artifact revision, forever, in a file that never
stops being appended to.

The failure this buys is not a slow query, and that is what makes it dangerous. A laptop with 20 000
decisions and a few hundred streams is fast, so wrong wiring looks correct and ships. It arrives weeks
later as ingestion latency, then RSS, then rejected writes or an OOM kill mid-append. In a governance
tool the moment the trail stops being written is the moment you most need it.

---

## Moving back down

```bash
docker compose down -v     # tier 2 -> tier 0
rm -rf ./vlogs             # tier 1 -> tier 0
```

Both lose nothing. `decisions.jsonl` and `pipeline.jsonl` on each machine are the record; a log store
is a projection you can rebuild with one `export`. **Every tier is disposable; the file is not.** That
asymmetry is the whole design, and it is why there is no migration in either direction.

---

## What no tier can do

| Question | Why not | Ask instead |
|---|---|---|
| which clauses are in the artifact and never fire | needs the artifact; a log store has only the trail | `session-sitter policy check` |
| why *this* call got that verdict, clause by clause | a replay of the selector, not a log query | `session-sitter explain <decisionId>` |
| what a practices edit would change | a replay against real decisions | `session-sitter policy diff <revA> <revB> --replay N` |
| the command a refusal named, or a failed run's error | local by nature — a real command line, a filesystem path | `session-sitter learn --status` |

## Nothing here writes

Every tier is read-only over append-only files. **The policy that governs an agent is changed in a
terminal or in a pull request, never in a browser.** The resolved config is rendered by
`session-sitter export --html` with the exact command that changes each setting beside it, and that
asymmetry is the product rather than a missing feature: a page that can rewrite the policy is a second
and weaker door into the thing whose entire purpose is that the supervised agent cannot open it.

## Nothing ships automatically

There is no `SessionEnd` egress and no background uploader. `export` is a command a human runs, or a
cron a human wrote. Silent egress of work transcripts is how tools get banned from a company.

## Licences, stated rather than discovered

- **VictoriaLogs** — Apache-2.0, no carve-out.
- **Grafana OSS** — AGPL-3.0. Genuinely FOSS and OSI-approved, and a procurement conversation at some
  employers. Some features are gated to Grafana Enterprise.
