# The fast supervisor tier

**Date:** 2026-09-02 · **Status:** implemented · **Code:** `src/supervisor/fastClassifier.ts`

## Who this is available to — read this first

**The tier needs an API token and a gateway URL, and most Claude Code users have neither.** A user
on a Pro, Max or Team subscription authenticates through OAuth: their credentials live in the OS
keychain, and `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are simply not set. For them this
tier never runs, and supervision behaves exactly as it does today — the deterministic rules still
settle most traffic in 3-4ms, and anything ambiguous still goes to the `bob` / `claude` CLI.

So the speedup below is real but **not universal**: it applies to installs running against an API
key or a gateway, which is the minority of the install base. The setting is on by default and stays
inert without those two values, so nothing breaks for anyone — it just does nothing.

An OAuth token *can* address the Messages API (`Authorization: Bearer` plus an
`anthropic-beta: oauth-2025-04-20` header), so this is a solvable limitation rather than a
permanent one. It needs per-request header support and keychain reading, both deliberately out of
scope here.

## The problem

Supervision had two tiers. The deterministic rules in `tiers.ts` settle the obvious cases in
**3-4ms** and cost nothing. Everything ambiguous went to the classifier engine, which spawns a
whole `bob` or `claude` CLI subprocess per decision and takes **~13.5s** (11.2-16.7s, n=3). The
agent is blocked at its prompt for all of it, against a 60s ceiling on the `PermissionRequest`
hook.

**We are not optimising our own code. We are deleting a process spawn.** The latency audit
(`2026-09-02-supervisor-latency-audit.md`) measured both halves of that claim:

- Starting `claude -p` and getting *any* answer to a ~6-token prompt: **median 7.58s, mean 9.15s,
  n=6** (samples 9.54, 7.76, 16.47, 7.40, 6.50, 7.22s). Boot, settings, MCP and tool init, auth,
  one round trip — before a single one of our tokens is processed. `claude --version` returns in
  0.01s, so it is not `exec`; it is the CLI's own startup.
- Every piece of TypeScript on the path, summed: **under 0.1ms.** `preClassify` 0.0005ms,
  `buildSupervisionPrompt` 0.0385ms, `parseAndValidate` 0.0048ms.

So ~99% of the classifier path is the subprocess and its model call, and there was never anything
to win in our own code. The right framing for what this tier achieves is not 13.5s → 4s: a cached
opus-5 judgement at **~4-5.5s median is below the subprocess's fixed startup cost alone.** The
whole judgement now costs less than the old path spent before it started reading the prompt.

## Who can actually use this

**The tier needs an API token, and most Claude Code users do not have one.** Users on a Pro, Max
or Team subscription authenticate through OAuth, and those credentials live in the OS keychain —
there is no `ANTHROPIC_AUTH_TOKEN` and no `ANTHROPIC_BASE_URL` in their environment at all. For
them this tier never engages and the CLI classifier answers exactly as it did before. So the
speedup below is real, but it is available to users running against an API key or a gateway, which
is the minority of the install base.

It degrades quietly rather than loudly, which is deliberate. A gateway that authenticates the
token but demands an extra header it was not given (`contextguru.vpc.cloud9.ibm.com/anthropic`
returns `401 no x-context-guru-token header`) produces a non-200, which becomes a
`FastClassifierError`, which `orchestrator.ts` catches and records as `fast_llm_fell_back` before
handing the decision to the CLI. The error body is passed through `scrub()` first, so a token
cannot reach a log. **No failure of this tier can produce an approval** — that is the one property
that matters, and it holds for a missing token, a wrong gateway, a timeout, an unparsable verdict
and a low-confidence answer alike.

## The fix, in one sentence

Call the model's HTTP API directly, and use the agent's **own conversation** as a prompt-cached
prefix, so the second and every later decision in a session sends almost no new tokens.

## The mechanism

A request has three parts:

```
system   [0] the rubric — role, the four lights, the output contract
         [1] the BDI knowledge                        <- cache_control: ephemeral
messages [0..n] the agent's conversation, ONE CONTENT BLOCK PER TURN
                                        <- cache_control on the last block, and one ~15 back
         [n+1] one user turn: the pending call, and "judge this"     (never cached, and tiny)
```

The whole thing rests on one property: **a conversation only ever grows at the end.** So the prefix
the previous decision cached is still a prefix of this decision's request, and everything up to the
old breakpoint is a cache read rather than a fresh prefill.

Three details are load-bearing, and each of them was a bug waiting to happen:

**One content block per turn, not one concatenated text.** The cache is keyed on the exact bytes up
to each breakpoint. If appending a turn *rewrote* the last block, the boundary the previous
decision's cache was keyed on would move and the read would be lost. One block per turn means an
appended turn appends a block; every earlier block is byte-identical. Consecutive same-role turns
are grouped into one message so roles still alternate as the API requires, but they stay separate
blocks. `conversationMessages` does this, and a test asserts that every block of a shorter
conversation reappears unchanged as a prefix of a longer one.

**No sliding window.** The slow tier renders only the last 40 turns. The fast tier deliberately
does not: dropping the oldest turn on every decision would shift the whole prefix and destroy the
cache, which is the entire point. Marked `ponytail:` in the source with the upgrade path — window
the *oldest* turns in fixed chunks, so boundaries still never move.

**A second breakpoint ~15 blocks back.** A breakpoint walks back at most 20 content blocks looking
for a prior cache entry. If a single interval between two approvals appended more than 20 turns, a
marker only on the last block would silently find nothing. The second marker covers that case.
Three breakpoints total, inside the budget of four.

Anthropic has no trailing-`system` channel, so the judging instruction rides on a trailing **user**
turn. That is the correct shape rather than a workaround: nothing after the last breakpoint is
cached, and per-decision content is exactly what belongs there. (The ~40 tokens of constant
instruction inside that turn are therefore paid uncached every call. Left there deliberately: it
has to be the *active* instruction, and 40 tokens is not the 1,776-token mistake below.)

### The bug this tier had to avoid inheriting

The audit measured the existing prompt builder and found caching was not merely absent but
**impossible**: two consecutive calls in one session share only **744 chars (~207 tokens) of a
19,256-char prompt**, and across sessions only 554. That is under the 1,024-token minimum for a
breakpoint, so `cache_control` would have bought nothing even if it had been requested. Three named
causes, and what the fast tier does instead:

| Audit finding | Why it breaks caching | What this tier does |
|---|---|---|
| `prompt.ts:135` — `session.turns.slice(-maxTurns)` | A sliding window has no stable prefix *by construction*: every new turn shifts it and rewrites the whole transcript block. | No window. `conversationMessages` is append-only. |
| `prompt.ts:137` — `` `[${t.index}] ${t.role}` `` prints absolute indices | Divergence lands exactly there (`[20] tool:` vs `[23] tool:`). | `renderTurn` emits the body only; the role rides on the message, and no index is printed. |
| `prompt.ts:180-193` — a 1,776-token constant footer appended *after* the transcript | Constant content behind variable content can never be cached. The layout is backwards. | Every constant is in `system`, ahead of everything variable. |

`prompt.ts:169` also puts the session id near the front, capping cross-session reuse. No id,
counter or timestamp appears anywhere in this tier's cached region.

**Two regression tests hold that line, and both were verified to fail when the bug is
reintroduced.** Injecting `slice(-12)` into `conversationMessages` fails the byte-exact prefix
test; injecting `[${turn.index}] ${turn.role}:` into the block text fails the leak test. They are
the most valuable tests in this change:

- *renders request N as a byte-exact prefix of request N+1, over successive growth* — builds the
  request at 3, 4, 5, 8 and 20 turn-pairs and asserts each cached region is an exact prefix of the
  next, with `cache_control` stripped first (the marker moves by design and is not what the cache
  is keyed on).
- *leaks no index, timestamp or session id into the cached region* — run against the default
  fixture, whose turns carry both absolute indices and ISO timestamps, so it proves `renderTurn`
  drops them rather than that the fixture lacked them.

If a session ever outgrows the context budget the fix is **not** a sliding window: truncate at a
stable boundary (a fixed chunk of the oldest turns), accept one cache re-warm, and never move that
boundary again. Marked `ponytail:` at the truncation site.

### The verdict is small on purpose

The slow tier asks for the full `Assessment` — 17 fields, nested issues, evidence and knowledge
refs. The fast tier asks for six:

```json
{"light":"yellow","confidence":0.9,"clause":"team-force-push",
 "reason":"a shared branch needs a lease","rewrite":"git push --force-with-lease origin main",
 "message":"..."}
```

`assessmentFromVerdict` expands that into a schema-valid `Assessment`, deriving the mechanical
per-light fields (block the action, offer Approve/Reject, block the agent on red) in code. Every
field the model does not have to write is latency not spent. The cost is that `issues` is empty —
the fast tier reports one reason, not a structured issue list. A decision that genuinely needs that
detail is one the slower tier should be taking, and low confidence is how it says so.

### Model derivation

The supervisor judges with the **agent's own** model, so "same model as the agent" holds with no
configuration. `ANTHROPIC_MODEL` is the source; `fastClassifierModel` overrides it.

A trailing context-window suffix is stripped: `aws/claude-opus-5[1m]` becomes
`aws/claude-opus-5`. The suffix is a variant an agent harness understands, and the gateway
**403-rejects** it on a plain Messages call. Same model, without the suffix, is accepted.

## The fallback ladder

```
  deterministic rules   ~3ms      no model at all; still runs FIRST and still short-circuits
        |  (ambiguous)
  fast classifier       ~4-6s     one prompt-cached POST /v1/messages
        |  (timeout · HTTP error · unparsable verdict · schema failure · confidence < 0.6)
  agent CLI             ~13.5s    a whole bob/claude subprocess — now edge cases only
        |  (EngineError)
  the existing failure paths: prose salvage, then unclassified-orange escalation
```

Nothing in the ladder can turn a failure into an approval. Every fast-tier failure mode raises
`FastClassifierError` and the orchestrator falls through; a malformed verdict is never patched into
a green. Recording, the correction lane, escalation and deny-on-timeout are untouched — the tier
was inserted between the knowledge load and `engine.classify`, and every existing orchestrator
test still passes unchanged.

Both outcomes are recorded on the decision: a `tier_fast_llm` event when the fast tier answered, a
`fast_llm_fell_back` event when it did not, each carrying the latency and the four token counts.
The fall-back event carries them too when the call itself completed, so a fallback is still
accounted for rather than looking free.

## The measurements

Every number below came from this command, run on 2026-09-01 against
`https://ete-litellm.ai-models.vpc.res.ibm.com`, with the token read from the environment:

```
make compile
ANTHROPIC_BASE_URL=<gateway> ANTHROPIC_AUTH_TOKEN=<token> \
  BENCH_MODELS=aws/claude-opus-5,aws/claude-sonnet-5,aws/claude-haiku-4-5 \
  BENCH_REPEATS=5 node tools/bench/supervisor.mjs
```

The benchmark drives the **shipped** tier (`out/supervisor/fastClassifier.js`), not a copy of it,
over invented synthetic conversations of ~11k prompt tokens. It reads credentials from the
environment only, and skips with exit 0 when there are none, so `make check` and CI never touch
the network.

### Incremental caching over a growing conversation (`aws/claude-opus-5`)

| judgement | turns | ms | input | cache_creation | cache_read |
|---|---|---|---|---|---|
| 1 (cold) | 56 | 4477 | 130 | 10002 | 0 |
| 2 | 60 | 4594 | 0 | 772 | 10002 |
| 3 | 64 | 8492 | 0 | 766 | 10644 |
| 4 | 68 | 4962 | 0 | 777 | 11286 |

The cold decision writes the whole 10k-token prefix. Every decision after it **reads that prefix
back and writes only the ~770 tokens of new conversation** — and `input_tokens`, the uncached
remainder, drops to zero because the judging turn itself lands inside the cache write. Steady
state: **11286 of 11416 prompt tokens served from cache, 98.9%.**

### Warm-cache latency

Measured on a fixed conversation, so only the uncached judging turn differs between samples.

| model | n | median | min | max |
|---|---|---|---|---|
| `aws/claude-opus-5` | 5 | 3886ms | 3129ms | 5113ms |
| `aws/claude-opus-5` | 12 | 5559ms | 3977ms | 15180ms |
| `aws/claude-sonnet-5` | 5 | 10033ms | 3343ms | 13243ms |
| `aws/claude-haiku-4-5` | 5 | 3117ms | 2825ms | 13385ms |

All three showed the same 98.9% cache read. Against the ~13.5s CLI tier, Opus 5 at a ~4-5.5s median
is roughly **2.5-3.5x faster**, not the order of magnitude the token counts might suggest —
prefill was never the whole cost.

### The tail is real, and it interacts with the timeout

The maxima above are not noise to be waved away: **15180ms on Opus over n=12, 13385ms on Haiku over
n=5.** With the default 10s timeout, a judgement in that tail does not merely run late — it is
abandoned and the decision goes to the agent CLI, which then costs its own ~13.5s. Roughly 1 in 12
Opus samples exceeded 10s.

That is the designed behaviour and it is still strictly better than before (the deterministic tier
already absorbs most traffic, and a fallback is no slower than the old two-tier path plus one
abandoned request). But the honest summary is **a much better median, an unchanged worst case**, not
a uniform speedup. `fastClassifierTimeoutSeconds` is the dial: raise it to trade fallbacks for
tail latency.

Sonnet 5's 10033ms median is above the default timeout outright, so it is a poor choice for this
tier on this gateway despite being the cheaper model. Opus 5 — the agent's own model, and therefore
the default — is the fastest of the three at the median.

### What did not reproduce

The prototype found that a plain rubric returned `red` for `git push --force origin main` even
though the practices name `--force-with-lease` as acceptable, and that adding this line fixed it:

> `PREFER yellow+rewrite over red WHENEVER the practices name a safe equivalent form. Only use red
> when no safe rewrite exists.`

The line is in `FAST_RUBRIC` and a test asserts it is sent. **It did not reproduce the yellow here:
all three models returned `red` for that call, with the instruction present.** Their reading is
defensible — the practice says a plain `--force` to a shared branch *is* forbidden, and `main` is
shared — so this looks like a stricter-but-valid answer rather than the failure the prototype saw.
The instruction is retained because it was measured to help there and costs nothing; it is not
carried here as a verified fix.

It also does not matter much in production: `git push --force` matches the deterministic RED table
in `tiers.ts`, so that call is blocked at tier 1 and never reaches the fast tier at all. The
benchmark exercises the tier directly and so bypasses that.

### A silent failure worth writing down

The first benchmark run reported **0% cache read on every model** while succeeding perfectly. The
cause: the minimum cacheable prefix is model-dependent (~2048 tokens on Haiku 4.5) and a shorter
prefix caches nothing at all — no error, no warning, just `cache_creation_input_tokens: 0`. The
synthetic conversation was ~1800 tokens. At 28 turn-pairs (~11k tokens) caching engaged
immediately.

The lesson for the tier, not just the benchmark: **on a short session the fast tier gets no cache
benefit and is simply an uncached call.** It is still far faster than a subprocess, but the 98.9%
figure is a property of a session with some history behind it.

## What a user actually feels

The tier's ~4-5.5s is not the whole wait, and the spec should not pretend it is. Two things sit in
front of it, both from the audit:

- **`AutoResponder.ts:12` — a 0-5,000ms sweep interval** (mean ~2,500ms) before the classifier is
  even triggered. A ~4s judgement is barely visible next to a 5s poll. Not touched here; an
  event-driven trigger is the fix and it is a separate change.
- **`knowledge.ts:400` — a `git clone --depth 1` per decision** when no local knowledge repo is
  configured, estimated at 1-5s *every call*, immediately before this tier runs. Fixed on this
  branch in its own commit, because it is reviewable and mergeable independently of the tier — and
  on the audit's estimate it may be the larger real-world win.

Honest end-to-end for a configured install after both: roughly 2.5s of sweep latency plus a ~4-5.5s
judgement, against 2.5s plus a git clone plus ~13.5s before.

## Where this tier gets called from

Two consumers, and only one of them exists on this branch.

`Orchestrator.superviseLocked` is wired here — one insertion point between the knowledge load and
`engine.classify`, deliberately a 22-line diff so it does not collide with other work in that file.

The bigger payoff is the Claude Code plugin's `PermissionRequest` hook, which lives on another
branch and is **not** wired here. For that caller the seam is one function:

```ts
judgePending(session, bundle, { baseUrl, authToken, model, timeoutSeconds })
  // -> { assessment: Assessment, telemetry: FastTelemetry }
  // throws FastClassifierError on any fall-through; never resolves into an approval on doubt.
```

`fastClassifier.ts` imports only `models.ts`, `transcript.ts`, `knowledge.ts`, `prompt.ts`,
`schema.ts`, `tiers.ts` and `node:http`/`node:https`. Nothing VS Code-shaped:
`grep -rn "from 'vscode'" src/supervisor/` is empty.

## What is not covered

- **Zero new runtime dependencies**, as required: `node:https` / `node:http` only. Raw HTTP rather
  than the Anthropic SDK is a deliberate exception to the usual "use the SDK" rule, forced by that
  constraint.
- **No credential ever reaches a committed file.** The token is read from settings or the
  environment at runtime, is never logged, and `HttpFastClassifier.scrub` replaces it in any error
  text in case a gateway echoes it back. A test asserts that.
- **No real transcript is read anywhere.** The benchmark's conversations are invented.
- The gateway currently configured in the local environment is *not* the one measured here and
  requires an extra `x-context-guru-token` header the tier does not send. Extra-header support was
  not in scope; the tier stays off against such a gateway rather than failing loudly.
- Cost per decision is not measured. The token counts are here, so it can be derived.
