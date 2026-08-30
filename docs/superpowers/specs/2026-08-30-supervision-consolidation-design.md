# Design: Consolidate the reckon supervision runtime into claude-session-switcher (TypeScript only)

**Date:** 2026-08-30
**Status:** Approved

---

## Goal

Fold everything the `reckon` project added on top of `claude-session-switcher` back into this
repository, as **one VS Code extension written entirely in TypeScript**. Nothing that ships in
this repo is written in Python.

reckon was a fork-by-copy of this extension plus:

1. **TypeScript additions** — Bob/Claude inspector bridges, an approval sweep, a session
   exporter, a supervision activity feed, a supervisor outbox bridge, question probes.
2. **A Python runtime supervisor** (`supervisor/reckon_supervisor/*.py`, ~2 600 lines) that
   classified a paused agent action into a traffic light, notified a human over Telegram, and
   applied the outcome back into the agent.
3. **Python corpus tooling** — a session uploader and a secret masker.
4. **A Python knowledge loader** (`kb-sitter-skill/scripts/fetch_bdi_files.py`).

Meanwhile this repository moved on: Codex and VS Code Chat sessions, full-transcript export,
the "Copy transcript" context submenu, and a standardized session-row layout. **Those changes
must survive the merge**, so this is a merge, not a copy.

---

## What ships after this change

```
claude-session-switcher/
├── src/
│   ├── extension.ts                    # wires everything
│   ├── SessionManager.ts               # 4 session sources: claude | bob | codex | chat
│   ├── SessionSwitcherViewProvider.ts  # sidebar UI + supervision activity feed
│   ├── WindowRegistry.ts               # cross-window focus + open-session publication
│   ├── AutoResponder.ts                # text rules + approval rules + supervisor handoff
│   ├── SessionExporter.ts              # full transcript export contract
│   ├── SupervisorOutbox.ts             # applies supervisor decisions into Bob/Claude
│   ├── SupervisionActivity.ts          # records/ -> panel feed
│   ├── SupervisionService.ts           # in-process supervisor driver (replaces spawn python)
│   ├── agents/                         # per-IDE live-process bridges (V8 inspector)
│   │   ├── BobInspector.ts   BobSender.ts   BobApprover.ts
│   │   ├── ClaudeInspector.ts ClaudeSender.ts ClaudeApprover.ts
│   │   └── QuestionProbe.ts
│   ├── supervisor/                     # the ported runtime supervisor — pure TypeScript
│   │   ├── models.ts  timeutil.ts  schema.ts  questions.ts
│   │   ├── transcript.ts  knowledge.ts  tiers.ts  prompt.ts
│   │   ├── engine.ts  store.ts  messaging.ts  telegram.ts
│   │   ├── agentControl.ts  orchestrator.ts  config.ts
│   │   └── cli.ts                      # `node out/supervisor/cli.js run|poll`
│   └── corpus/                         # ported uploader + masker
│       ├── mask.ts  upload.ts  kbFetch.ts  cli.ts
├── skills/kb-sitter/SKILL.md           # knowledge loader skill (calls the TS CLI)
├── knowledge/                          # tier-file template + example registry
└── docs/                               # architecture, supervision, knowledge, corpus
```

### Python removed, one-for-one

| Removed (reckon) | Replacement (this repo) |
|---|---|
| `supervisor/reckon_supervisor/config.py` | `src/supervisor/config.ts` |
| `…/models.py` | `src/supervisor/models.ts` |
| `…/timeutil.py` | `src/supervisor/timeutil.ts` |
| `…/schema.py` | `src/supervisor/schema.ts` |
| `…/store.py` | `src/supervisor/store.ts` |
| `…/knowledge.py` + `kb-sitter-skill/scripts/fetch_bdi_files.py` | `src/supervisor/knowledge.ts` + `src/corpus/kbFetch.ts` |
| `…/tiers.py` | `src/supervisor/tiers.ts` |
| `…/transcript.py` | `src/supervisor/transcript.ts` |
| `…/prompt.py` | `src/supervisor/prompt.ts` |
| `…/engine.py` | `src/supervisor/engine.ts` |
| `…/questions.py` | `src/supervisor/questions.ts` |
| `…/messaging.py` | `src/supervisor/messaging.ts` |
| `…/telegram.py` | `src/supervisor/telegram.ts` |
| `…/agent_control.py` | `src/supervisor/agentControl.ts` |
| `…/orchestrator.py` | `src/supervisor/orchestrator.ts` |
| `supervisor/supervise.py` | `src/supervisor/cli.ts` (+ in-process `SupervisionService`) |
| `scripts/mask_sessions.py` | `src/corpus/mask.ts` |
| `scripts/upload_session.py` | `src/corpus/upload.ts` (+ `src/corpus/cli.ts`) |

The one *runtime* use of `python3` that remains is the pre-existing read-only SQLite query
against Bob's `~/.bob/db/bob.db`, inherited unchanged from this repo's `SessionManager`. It is
not our code being ported — it is a two-line `python3 -c` shim that predates reckon. See
[Deliberately unchanged](#deliberately-unchanged).

---

## Key decisions

### D1 — The supervisor runs in-process, not as a spawned interpreter

reckon spawned `python3 supervise.py run <id>` per prompt plus a long-lived
`supervise.py poll --loop 1`. Once the supervisor is TypeScript there is no reason for a
process boundary: `SupervisionService` owns an `Orchestrator` inside the extension host and
calls `supervise()` / `poll()` directly.

**Kept:** the on-disk state layout (`records/`, `history/`, `outbox/`, `inbox/`,
`notifications/`). It earns its place — the activity panel reads `records/`, deliveries are
retried until the agent confirms them, and a crash mid-decision is recoverable. Losing the
process boundary does not mean losing durability.

**Consequence:** `reckon.pythonPath` is no longer used by supervision. It stays in the
settings schema, marked deprecated, so an existing `settings.json` does not error.

### D2 — The outbox stays the delivery queue, but is kicked synchronously

The orchestrator still writes one JSON delivery per intervention into `outbox/`, and
`SupervisorOutbox` still applies it through Bob's approval emitter / Claude's deferred. That
indirection is what makes a failed apply retryable ("archive only on a confirmed `ok`").

What changes: `SupervisionService` calls `outbox.poll()` immediately after the orchestrator
returns, so an approval reaches the blocked agent in milliseconds instead of on the next
1 500 ms tick. The timer and `fs.watch` remain as the safety net.

### D3 — Knowledge routing is settings-first; the registry file is optional

reckon resolved the `(user, project, team)` triple by parsing registry tables out of a
`session-sitter.skill.md` that hard-coded real IBM team, project, and user slugs. Those names
are internal and do not belong in a public repository.

The **mechanism** ports (`parseRegistry`, `resolveTriple`, `parseBottomLine`, tier precedence
team < project < user). The **data** does not:

- With no registry file configured, the triple comes straight from
  `reckon.knowledge.{user,project,team}` and no validation against a registry happens.
- With `reckon.knowledgeRegistryPath` set, the file is parsed and the triple is validated
  against it exactly as before (unknown slug → hard error, single-project fallback, etc.).
- `knowledge/REGISTRY.example.md` ships a generic registry (`alice`, `demo-project`,
  `platform`) so the parser has a documented, testable shape.

Nothing from reckon's private `data/` submodule is copied.

### D4 — "Active" sessions: reckon's live-worklist rule, extended to probeless sources

reckon replaced "top 20 by recency" with an **active-only** main list (everything else goes to
History), where active = the IDE reports the session open, via Bob's `TaskManager` and
Claude's manager, unioned across windows through `WindowRegistry`.

Codex and VS Code Chat — added to this repo after that change — have **no** live-process
signal at all. Dropping them into History permanently would be a regression. So the rule
becomes per-source:

```
isActive(s) =
    source has a liveness probe (bob | claude)  ->  IDE reports it open  OR  s.status !== 'idle'
    source has no probe        (codex | chat)   ->  updatedAt within reckon.probelessActiveWindowMinutes (default 120)
```

The recency window is an honest proxy, named and configurable rather than hidden.

### D5 — The uploader loses its shell-out and its Python

`reckon.uploadScriptPath` pointed at `upload_session.py`. The port makes uploading an
in-process TypeScript call, so the extension needs the **corpus repo root**, not a script path:

- New: `reckon.dataRepoPath` — absolute path to the corpus repo (contains `data/sessions/`).
- Backwards compatible: when `dataRepoPath` is empty and the legacy `uploadScriptPath` is set,
  the repo root is derived from it (`<root>/scripts/upload_session.py` → `<root>`). Users
  upgrading do not have to reconfigure.

Secret masking runs before any commit, unchanged in behavior: same rule set, same
deterministic same-shape/same-length fakes, same `MASKED` marker, same idempotency.

### D6 — Identity stays claude-session-switcher

Command ids stay `claudeSessionSwitcher.*`, the view stays `claudeSessionSwitcher.view`, the
container stays "AI Sessions", the cross-window dir stays `~/.claude/session-switcher/`. Only
the supervision and corpus settings live under the `reckon.*` namespace — where this repo
already put `reckon.uploadScriptPath`.

### D7 — Ported code keeps its verified behavior, quirks included

The Python supervisor's odd-looking details are load-bearing and were learned from live
failures. They port verbatim:

- The classifier prompt rides on **stdin**, never argv (a transcript + BDI blows past
  `MAX_ARG_STRLEN`, giving `E2BIG`).
- `extractJsonObject` scans *all* balanced top-level objects and returns the first with a
  `traffic_light`, because Bob's `--output-format json` appends a stats object.
- Unparseable classifier output is salvaged from prose, then escalated to Orange — never
  hard-failed, because a hard fail strands the agent at a blocked prompt.
- A user-facing question (`ask_followup_question`, `AskUserQuestion`) is **never** resolved
  through the approval channel; it goes to the question relay.
- Silence is never approval: an Orange timeout denies and hands the agent alternatives; a Red
  timeout blocks.
- Per-session locking prevents two live Orange cards for one decision. POSIX `flock` becomes
  an atomic `O_EXCL` lock file carrying the owner pid, with a stale-owner check — Node has no
  `flock`, and a pid-liveness check restores the "a crashed run never strands the lock"
  property that made `flock` the right choice.

---

## Behavior contracts preserved across the port

| Contract | Where |
|---|---|
| Export schema `1.0`, camelCase keys | `SessionExporter.ts` ↔ `supervisor/transcript.ts` |
| Traffic-light state machine + terminal states | `supervisor/models.ts` |
| Per-light required assessment fields | `supervisor/schema.ts` |
| Tier precedence team < project < user | `supervisor/knowledge.ts` |
| Deterministic green/red pre-classification | `supervisor/tiers.ts` |
| Telegram card layout, callback data, toggle/submit | `supervisor/telegram.ts` |
| Delivery JSON shape (`deliveryId`, `channel`, `decision`, `answers`) | `supervisor/agentControl.ts` ↔ `SupervisorOutbox.ts` |
| Stored session naming `YYYYMMDD_slug-id8` + `.meta.yaml` sidecar | `corpus/upload.ts` |

---

## Deliberately unchanged

- **`python3 -c` for reading `bob.db`.** Pre-existing in this repo (`SessionManager`,
  `SessionExporter`). Bob ships no Node SQLite driver; the alternatives are a native module
  (breaks VSIX portability) or bundling a WASM SQLite (~1.5 MB, new dependency). Neither is in
  scope for "port the Python that reckon added". Documented as the single external runtime
  dependency, with the WASM path noted as the upgrade.
- **The inspector approach.** Reaching Bob's `TaskManager` and Claude's manager through the
  in-process V8 inspector is the only channel that reaches a prompt-blocked agent. Ported as-is.
- **reckon's private `data/` corpus and its internal slugs.** Not copied. See D3.

---

## Test strategy

Ported logic is tested at the same seams the Python suite used (24 Python test files,
~2 000 lines). Pure functions get direct unit tests; I/O boundaries get fakes.

| Area | Fake | What is asserted |
|---|---|---|
| `schema.ts` | — | required fields, enum membership, confidence range, per-light conditionals, fenced/prose recovery, prose salvage, unclassified→orange |
| `store.ts` | tmpdir | atomic write, restart reload, consumed-update dedupe, lock busy + stale-owner takeover |
| `knowledge.ts` | injected `fetch` | registry parse, triple resolution + fallbacks + unknown-slug errors, BDI entry parse, tier order, missing tier tolerated |
| `tiers.ts` | — | red beats safe-read, plain `git push origin main` stays ambiguous, generated assessments valid |
| `transcript.ts` | tmpdir | camelCase + snake_case tolerance, bad role rejected, id mismatch rejected |
| `prompt.ts` | — | untrusted content delimited, narrower tier rendered first, schema block present |
| `engine.ts` | `FakeEngine`, stubbed spawn | envelope unwrap, JSON hardener retry, stdin (never argv), timeout/not-found errors |
| `questions.ts` | — | Bob + Claude normalization, multi-select, answer text rendering |
| `telegram.ts` | injected `api` | card + keyboard build, toggle accumulation, offset persistence, callback correlation, `@active` fallback |
| `orchestrator.ts` | fake engine/channel/controller/clock | full green/yellow/orange/red lifecycles, timeout→yellow, question relay, duplicate suppression, late reply, restart-safety |
| `mask.ts` | tmpdir | every rule detected, same-shape fakes, idempotent re-run, emails/paths untouched |
| `upload.ts` | tmpdir + fake git | naming, sidecar, collision counter, import idempotency, dry-run writes nothing |

Existing extension tests must keep passing unchanged (123 at baseline), and the merged
`SessionManager` / view-provider gain tests for the partition rule and the preserved
Codex/Chat/transcript paths.

---

## Out of scope

- Rewriting the corpus analyzer that authors BDI files (reckon never automated it either).
- Slack / WhatsApp channels (`MessagingChannel` stays the seam; only stub + Telegram ship).
- Multi-channel Claude targeting (v1 single-channel limitation ports as-is).
