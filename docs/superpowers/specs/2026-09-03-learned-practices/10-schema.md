# 10 — The knowledge schema and its lifecycle

Design spec. Decides the on-disk shape of a learned practice, the fields it carries, who reads each
one, how a machine proposal is prevented from outranking a human's, how an old audit record stays
explainable, what the runtime actually loads, and what goes into the prompt when the corpus is large.

Read alongside the research notes (report 00) (+ ADDENDUM), `01-internal-review.md` §3/§5/§8,
`02-oss-landscape.md` §R1/§R4/§R5, `03-firstparty.md` §1.2.

Code read before designing: `src/supervisor/knowledge.ts` (all 469 lines),
`src/supervisor/prompt.ts:121-132`, `src/supervisor/models.ts` (`KnowledgeRef`, `RuleTrace`,
`SupervisionRecord`), `knowledge/bottom-line.template.md`, `docs/KNOWLEDGE.md:60-175`, and on the
unmerged `pr/policy-compile` branch: `src/policy/practices.ts`, `src/policy/cli.ts`,
`src/policy/corrections.ts`, `src/policy/generalise.ts`, `src/hooks/permissionRequest.ts`,
`src/hooks/paths.ts`, `src/hooks/settings.ts`, `src/audit/trail.ts`.

---

## 0. The seven decisions, up front

1. **Two file kinds, one parser for the part that matters.** `bottom-line.md` is untouched and stays
   the *human* lane. Learned clauses go into a new per-clause file kind under `learned/`. The
   frontmatter is new (~40 lines); the clause *body* is a verbatim `### Intention: …` + `Match:` +
   prose block, so `parseBottomLine` and `extractPatterns` are reused, not reimplemented.
2. **Authorship is the directory, not a field.** `origin` is assigned by the loader from the path it
   read. A machine cannot write `origin: human`, because nothing reads a written `origin` — and the
   pipeline's write surface is an *enforced* invariant (§3.3.2): every write goes to
   `learned/<id>.md` through one path-producing function, and anything else is a hard error that
   writes nothing.
3. **Precedence is a four-rung ladder over clauses: human red → human green → learned red → learned
   green.** Humans decide first and completely; machine clauses speak only where humans are silent.
   The surprising rung — a human green beating a learned red — is deliberate and defended in §3.3.1:
   a machine proposal overrides a human's explicit practice in *neither* direction. This is a
   deterministic evaluation order, not prose in a doc.
4. **A compiled, content-addressed artifact is what the runtime loads** — `<rev>.json` under the
   plugin data dir, hash computed over everything except `compiledAt` and `revision` themselves, so
   the prompt-cache breakpoint content is byte-stable across processes and across recompiles that
   changed nothing.
5. **A learned clause without a recorded rationale does not compile, and retirement is a state.**
   `05`'s measurement — rules files grow +226% and the older a rule is the less likely it is ever
   deleted, because once the *why* is gone deletion costs O(2^|D|) — makes the rationale a schema
   requirement (§2.5), `retired` a first-class status distinct from `superseded` (§4.4), and
   `displaces` the recorded fact of a one-in-one-out eviction at the tier ceiling (§6.6).
6. **The status enum is canonical here, six values:** `proposed | audit | accepted | declined |
   superseded | retired` (§2.4, team-lead ruling). `rejected` and `deprecated` are not values —
   `declined` is the governance verb, and a deliberate disarm is `retired` + `retired_reason: manual`.
7. **Matching is never budgeted; the prompt is.** Deterministic pattern matching runs over every
   compiled clause with no cap. Only the classifier's knowledge block is bounded, split into a
   revision-stable core (inside the cache breakpoint) and a per-call selection (outside it).

Everything below is the detail, and the defence.

---

## 1. One format or two?

### 1.1 The three candidates

| Option | What it means | Why not |
|---|---|---|
| **A. Append to `bottom-line.md`** | the cron job edits the shared per-tier file | A machine appending to a hand-written file conflicts with human edits on every run; the review diff interleaves machine and human prose; there is nowhere to put provenance without bloating the table a human reads; and authorship survives only as `git blame`, which any file move erases. `mem0`'s April-2026 lesson (`02` §3) is precisely that LLM-driven in-place mutation of a shared store is where these systems break. |
| **B. Extend the metadata table** with `evidence`, `support`, `learned_from`, … | keeps one parser | The table cannot express the nested provenance block without flattening it into `learned_from_sessions`, `learned_from_decisions`, `learned_from_support` — three keys that only exist because the container cannot nest. And it puts nine machine fields in front of a human who is trying to read four. |
| **C. A new per-clause file kind, `bottom-line.md` untouched** | one clause per file under `learned/` | Chosen. |

### 1.2 The chosen layout

```
data/knowledge/
  teams/<team>/bottom-line.md          # unchanged. Human lane. Parsed by parseBottomLine, as today.
  teams/<team>/learned/<id>.md         # NEW. One clause per file. Machine lane.
  projects/<project>/bottom-line.md
  projects/<project>/learned/<id>.md
  users/<user>/bottom-line.md
  users/<user>/learned/<id>.md
```

Why per-file wins on the three things the shared table is bad at:

- **Review diff.** `git diff --stat` on a proposal PR is one line per proposed clause. A reviewer
  accepts clause 3 and rejects clause 7 by editing two independent files, and the PR conversation
  threads per file. In option A the same review is a conversation about hunks of one file.
- **Provenance.** The frontmatter block belongs to exactly one clause, so `support: 47` is
  unambiguous. In a shared file, per-clause provenance either goes in the table (option B) or
  becomes ambiguous.
- **Supersession.** Replacing a clause is `git mv`-free: add `<new-id>.md` with
  `supersedes: [old-id]`, and `<old-id>.md` stays on disk with `status: superseded`. In a shared
  file, supersession is a hunk that deletes text — which is exactly the "supersede rather than
  delete" advice (`docs/KNOWLEDGE.md:172`) that today populates a dead field.

### 1.3 Migration cost, honestly

The cost of option C is **one new frontmatter parser and one new directory walk.** It is *not* a
migration: no existing file changes, no existing test changes, no reformat.

- `parseBottomLine` (`knowledge.ts:277-329`) is retained bit-for-bit. Its `HEADING_RE` /
  `TABLE_ROW_RE` behaviour, including the documented `meta[key] = val` swallow, is unchanged.
- The baseline that must keep passing is **1,139 tests in 56 files** — a clean vitest run on
  `10ff422`. (The 1,146 figure quoted earlier was a worktree that already carried PR #40's 7 tests.
  PR #42 took it to 1,240.)
  It exercises `parseBottomLine`, `parsePractices`, `clauseFrom`, `loadKnowledge` and the hook
  ladder. None of those inputs or outputs change.
- `learned/` is absent in every existing corpus, and an absent directory reads as zero clauses. The
  loader's existing rule — *a missing tier is not an error* (`knowledge.ts:14`, `:463-465`) — extends
  to it unchanged.

What we deliberately do **not** do: migrate the corpus to YAML, JSON, or a database. Five
independent formats converged on markdown-prose + frontmatter (`02` §5); `bottom-line.md` is already
in that family; and prose is what makes the PR review work.

### 1.4 Why the *body* is not new

A learned clause's body is a bottom-line entry, verbatim:

```markdown
### Intention: Never force-push to a shared branch

Match: `git push --force`

Rewriting history on a branch other people build on destroys their work.
```

so `parseBottomLine(body, tier, file)[0]` → `clauseFrom(entry)` produces a `Clause` with the
existing `clauseId`/`citation`/`patterns`/`text` semantics, including `extractPatterns` lifting the
`Match:` line out of the prose. That reuse is the point: there is one definition of what a matcher
means, and one definition of what a citation looks like. The frontmatter carries only what the body
cannot.

### 1.5 The frontmatter is not YAML — and must not pretend to be

Zero runtime dependencies means no YAML parser. The frontmatter is a **documented restricted
subset**, and anything outside it is a *lint error*, never a silent misparse:

- `key: scalar` — scalar is the rest of the line, trimmed, unquoted.
- `key: [a, b, c]` — inline list only; comma-separated, brackets required.
- exactly one nested block, `learned_from:`, whose children are two-space-indented `key: scalar` or
  `key: [..]`.
- `#` starts a comment only at the start of a line.
- Anything else — a block list (`- item`), a multi-line scalar (`|`/`>`), an anchor, a quoted key —
  is a hard lint error naming the line.

This is honest about a constraint the research glossed over. It is safe because the *writer* of a
learned file is our own code, so the writer and the reader are one contract; and it is safe for
hand-edited files because the failure is loud.

---

## 2. The field list, and who reads each field

The rule from `01` §3, applied without exception: **a field with no named consumer is cut.** Five of
nine existing fields are parsed and dead; this schema adds nothing to that pile.

### 2.1 The schema

```
---
id: no-force-push-to-shared-branch
status: accepted
level: red
evidence: EXTRACTED
support: 47
contradictions: 0
learned_at: 2026-08-30
adopted_at: 2026-09-01
expires: 2027-09-01
supersedes: [ask-before-force-push]
displaces: []
fix_from: --force
fix_to: --force-with-lease
learned_from:
  sessions: [20260812_nightly-release-a1b2c3d4]
  decisions: [d-8f21e0, d-8f2244, d-903b17]
---
```

Plus three fields that appear only on a clause that has left service (§4.4):

```
status: retired
retired_at: 2026-11-14
retired_reason: ablation         # ablation | displacement | manual
retired_by: abl-2026-11-14-7c3f  # the ablation run, or the displacing clause id. Null for manual.
```

Note what is **not** there: `action`, `severity`, `paths`, `min_version`, `origin`, `confidence`,
`scope`, `source`, `tags`, `citation`, and — deliberately — `rationale`. §2.3 defends each cut, and
§2.5 explains why the rationale is the body prose rather than a field of its own.

### 2.2 Field → consumer → behaviour if absent

| Field | Consumer (code path) | If absent |
|---|---|---|
| `id` | `clauseIdFor` → `citation` (`practices.ts:169-181`); the compiled artifact's key; `DecisionRecord.clause` (`trail.ts`); `supersedes` targets | **Compile error.** A learned clause with no id cannot be cited or superseded. (Hand-written entries keep today's fallback: numbered heading, else title slug.) |
| `status` | `compilePolicy()` — only `accepted` reaches `clauses[]`; `policy propose` builds the review queue from `proposed`; `lint` | **Compile error** for a learned file. Defaulting to `proposed` would be friendlier and wrong: a missing status must never be the one that ships. |
| `level` | rungs 3–4 of the hook ladder (`permissionRequest.ts:225,272,293` via `normalizeLevel`); the deny message; core-set selection (§6) | `null` → the clause reaches the classifier as prose and can never decide. Today's behaviour, kept. `lint` warns (as `policy/cli.ts:55-60` already does). |
| `match` (in body, not frontmatter) | `extractPatterns` → `ClauseMatcher[]` → `findMatchingClause`; `generalise.ts` (substring matchers only) | no patterns → prose-only clause; `lint` errors when `level` is `red`/`green` (existing check, `policy/cli.ts:61-66`) |
| `fix_from` / `fix_to` | **new** `clauseCorrection()` feeding rung 2 of the ladder, alongside the hard-coded `CORRECTION_RULES` | no rewrite lane for this clause. Both-or-neither: one without the other is a compile error. |
| `evidence` | `policy propose` — groups and orders the review queue and the PR body, EXTRACTED first, AMBIGUOUS last and labelled *needs a human decision*; `lint` | **Conditional, and unambiguous: required iff `learned_from` is non-empty; must be ABSENT otherwise.** Both violations are compile errors (missing when there is evidence; present when there is none). Explicitly *not* read at runtime — see §3.4. |
| `support` | `policy propose` — a candidate below the support threshold is not proposed at all; ordering within an evidence group; the PR body's "seen 47 times" line | treated as `0`, so the clause is never proposed. Never affects a decision. |
| `contradictions` | `policy propose` — `> 0` blocks the proposal and prints the conflicting decision ids; `lint` reports it on an accepted clause | treated as `0`. A missing count is the optimistic reading, so `lint` warns when the field is absent on a learned file. |
| `learned_from.sessions` / `.decisions` | `policy explain <id>` prints the evidence; `policy propose` writes it into the PR body; `policy replay` seeds its test set from `decisions` (the Voyager/OPA "no test, no review" rule, `02` §R3) | the clause cannot be proposed — a candidate with no evidence is not a candidate |
| `learned_at` | `policy propose --prune`: a proposal still `proposed` after 30 days is closed as stale | no staleness finding for that clause |
| `adopted_at` | `policy stats` — decisions before vs after adoption, which is how you measure whether the clause helped (`02` §R4); the clock for `lint`'s "fired zero times in 90 days" | that clause is omitted from the effectiveness report |
| `expires` | `compilePolicy()` — an expired **accepted** clause makes the compile **exit non-zero**, naming it; `lint` errors | never expires. Today's behaviour. |
| `supersedes` | `compilePolicy()` — a clause named by an accepted clause's `supersedes` is excluded from `clauses[]` and recorded in the compile report; `policy explain` walks the chain | nothing is superseded |
| body prose (**the rationale** — §2.5) | the deny message (`permissionRequest.ts:225`), the classifier knowledge block, the compiled `body`, and the retirement review's "is this still true?" | **Compile error for any clause under `learned/`.** A clause whose *why* is gone is undeletable at O(2^&#124;D&#124;) (arXiv:2608.11095). Existing `bottom-line.md` entries keep today's `lint` **warn**, for zero-breakage. |
| `displaces` | `compilePolicy()` — the named clause must be `status: retired` in the same commit, else the compile fails. This is what makes one-in-one-out *checked* rather than intended (§6.6) | nothing is displaced; required only when the tier is at its clause ceiling |
| `retired_at` | `policy explain` (the retirement line in an audit answer); `policy stats` — churn per tier | **Compile error when `status: retired`** — same bar as `retired_reason`, because audit resolution needs the date, not just the cause |
| `retired_reason` | `policy explain` — prints *replaced by X* / *ablated, run Y* / *retired by hand*; the review queue's history view | **Compile error when `status: retired`.** "Why did this rule go away" is precisely the thing the corpus must not lose. |
| `weight` | des-runtime's selector — the ranking signal for the per-call selection (§6.4) | **Compile error** on an accepted clause. Frozen at accept from `evidence` + `support`; recomputing it later would move the revision, so it is set once and only a review changes it. |
| `retired_by` | `policy explain` resolves it — to des-validate's ablation run id, or to the displacing clause | null is legal only for `retired_reason: manual` |
| title (`###` heading) | `citation` fallback, deny message, prompt | **Compile error**: no heading means `parseBottomLine` finds no entry at all |
| `extra` (unrecognised keys) | round-tripped on any rewrite; `lint` warns *unknown field `levle` — did you mean `level`?* | n/a |

`origin`, `tier`, `citation`, `sourceFile` and `revision` are **derived, never authored**. §3 explains
why that matters for `origin` specifically.

### 2.3 What was cut, and why

- **`action: allow|deny|rewrite`** — `level` already means exactly this and is already load-bearing
  at `permissionRequest.ts:272,293`. Two fields for one meaning is how `scope` became a dead
  duplicate of `tier`.
- **`severity: LOW..CRITICAL`** — no consumer. `DecisionRecord` records `light`, not a severity; the
  classifier's `Issue.severity` is a *model output*, not a clause input. Semgrep needs severity
  because it has no traffic-light; we have one.
- **`paths: [glob]`** — redundant. `haystackFor` already includes the whole tool input JSON, so a
  clause that should apply only to `src/**` writes `Match: /"file_path":"[^"]*\/src\//`, or more
  usually just names the thing it cares about. Semgrep needs `paths` because its patterns are
  AST-shaped and path-blind; ours are not. Adding a second way to express scope guarantees one of
  the two becomes the dead one.
- **`min_version`** — no consumer today. The compiled artifact already carries `schemaVersion`, and
  the compiler is the thing that would gate on it. Add it the day matcher semantics actually change,
  not before.
- **`confidence: low|medium|high`** — replaced by `evidence` + `support`, which a reviewer can act
  on. `01` §3 records it as "advisory text only", typed by hand and measured by nothing. Still
  parsed from existing `bottom-line.md` files for compatibility; not in the learned schema; not in
  the compiled artifact.
- **`scope`** — the tier is the directory. Retained in the parser; not in the new schema.
- **`source`** (free text) — superseded by structured `learned_from`. `01` §3 shows the prompt's
  `sourceFile ?? source` fallback never fires. Retained in the parser; not in the new schema.
- **`rationale:` as a frontmatter field** — the body prose already is it, and it is the copy that
  reaches the deny message and the prompt. Two places to write the *why* means one goes stale, and by
  this section's own rule it would be the invisible one. See §2.5.
- **`tags`** — "effectively dead" (`01` §3): carried to `Clause.tags`, copied back, never read.
  Retained in the parser and in today's prompt line so no existing render changes; not in the
  learned schema; **dropped from the compiled artifact**.

That is a schema that is *smaller* than the union the research proposed, which is the correct
direction of travel given §3 of the internal review.

### 2.5 The rationale is the body, and it is mandatory

`05-community.md` measured what happens without it: **+226% growth over a rules file's lifetime,
+4.9 net instructions per commit, and a log-hazard of -0.032/commit — the older an instruction is,
the less likely it is ever deleted** (arXiv:2608.11095, 247,694 instruction lifetimes across 1,867
repos). The stated cause is the operative part: *once an instruction's rationale is gone, deleting it
without risking a correctness regression costs O(2^|D|)*. And the measured fix is the cheapest thing
in this entire spec: **comments encoding latent reasoning removed 99.3% of the excess** (+211.3% →
+1.4%). With arXiv:2507.11538's 68% instruction-following at 500 instructions, clause count is a
**correctness cliff, not a cost line** — and a pipeline that proposes clauses on a cron reaches it
faster than any human would.

So: **for any clause under `learned/`, non-empty rationale prose is a schema requirement that fails
validation.** Not a lint info, not a warn. The compile exits non-zero naming the file.

Three specifics.

**1. Rationale and evidence are different things, and both are required.**

| | Field | Answers | Required by |
|---|---|---|---|
| **Rationale** | the body prose | *why does this rule exist, and what should happen instead* — in prose a human can evaluate and, later, disagree with | compile, for every clause under `learned/` |
| **Evidence** | `learned_from.decisions` / `.sessions` | *which concrete decisions produced it* — checkable, not persuasive | `policy propose`; a candidate with neither is not a candidate |

A support count is not a reason. `support: 47` says a pattern recurred; it cannot tell a reviewer in
2027 whether the reason still holds. That is the whole distinction, and conflating them is how a
corpus becomes the grievance archive `05` quotes.

**2. It is the body, not a new field.** The body already carries both halves of Semgrep's `message`
doctrine (why + remediation), it is already what the deny message and the prompt render, and it is
already in the compiled artifact. A `rationale:` key beside it would be a second place to write the
same thing, and §2.3's rule says one of the two becomes the dead one — here, predictably, the one
nobody sees at the moment of denial.

**3. The check is a floor, not a quality bar.** Validation requires ≥ 80 characters of prose after
`Match:` lines are lifted and the title is excluded.

```
// ponytail: 80 chars is a floor against an empty or title-restating body, not a quality gate.
// Judging whether a reason is *good* is the reviewer's job and cannot be automated here.
// Upgrade path if the floor is gamed: require the body to survive a title-similarity check.
```

**What this does not do.** It does not stop growth on its own — it makes deletion *possible*, which
is the precondition for §4.4's retirement state and §6.6's ceiling. The three mechanisms are one
design: rationale makes a clause reviewable, ablation makes removing it falsifiable, and the ceiling
makes removal happen.

### 2.4 TypeScript interfaces

```ts
// src/supervisor/learnedClauses.ts — NEW
//
// Location note: this spec first said `src/policy/learned.ts`. `impl-foundation` shipped it at
// `src/supervisor/learnedClauses.ts` (PR #42) because `src/policy/` does not exist on origin/main —
// the policy layer lives in the unmerged `perms` branch. That was the right call: demanding the
// `src/policy/` path would have forced the PR onto an unmerged stack. `src/supervisor/` is where
// `knowledge.ts` already lives, which is the module this one extends. Recorded, not "fixed".

/** Assigned by the loader from the path it read. Never parsed from a file. */
export type ClauseOrigin = 'human' | 'learned';

/**
 * CANONICAL — team-lead ruling, and the single vocabulary for all three specs and the
 * implementation. Six states. Only `accepted` ever reaches a decision.
 *
 *  proposed   a candidate. Never affects any decision.
 *  audit      matched deterministically, never rendered, contributes nothing to the outcome.
 *             **Compiled INTO the artifact, carrying status 'audit'** — the runtime never reads
 *             markdown once an artifact exists, so an omitted audit clause could never match and
 *             des-governance's promote gate would wait forever for hits that cannot arrive. The
 *             exclusion audit needs is from *rendering* (one `status === 'accepted'` check in the
 *             selector), not from compilation. Two consequences: an audit clause costs zero prompt
 *             tokens and cannot break the KV cache, so a trial is free; and a prose-only audit
 *             clause is inert — not rendered because not accepted, not matchable because no
 *             `Match:` — which is why `accept --audit` refuses one.
 *  accepted   live.
 *  declined   a human said no. (NOT `rejected` — `decline` is already the governance verb, and two
 *             names for one state is the thing §4.4 exists to prevent.)
 *  superseded replaced by a named successor.
 *  retired    no longer enforced; `retired_reason` says why (§4.4).
 *
 * `deprecated` is deliberately NOT a value: des-governance's `retire` and des-runtime's "disarming a
 * red needs a reviewed diff" are both `retired` + `retired_reason: 'manual'`. One terminal-disabled
 * state distinguished by *reason* is the mechanism §4.4 already chose, so a human disarming a red and
 * an ablation retiring dead weight stay tellable apart without a second enum value. `superseded`
 * stays separate because a named successor is a genuinely different history.
 */
export type ClauseStatus =
  'proposed' | 'audit' | 'accepted' | 'declined' | 'superseded' | 'retired';

/** Why a clause left service. Required whenever status is 'retired'. */
export type RetiredReason = 'ablation' | 'displacement' | 'manual';

/** graphify's three-level tag (02 §2). A routing decision for the reviewer, not a score. */
export type Evidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

/** Provenance. Cedar-style annotations: carried, never evaluated. */
export interface LearnedFrom {
  /** Corpus session filenames (`YYYYMMDD_slug-id8`), not paths and not contents. */
  sessions: string[];
  /** `DecisionRecord` ids from our own decisions.jsonl. */
  decisions: string[];
}

/**
 * A substring→substring rewrite. Deliberately not a template: mechanical replacement is the only
 * form that satisfies all four conditions in corrections.ts:14-24 (unambiguous, strictly narrower,
 * verifiable by reading the command, loud on failure) without executing author-supplied code.
 */
export interface ClauseFix { from: string; to: string; }

/** One learned clause file, parsed. */
export interface LearnedClauseFile {
  id: string;
  status: ClauseStatus;
  level: ClauseLevel;               // from ../policy/practices
  evidence: Evidence;
  support: number;
  contradictions: number;
  learnedAt: string;                // ISO date
  adoptedAt: string | null;
  expires: string | null;
  supersedes: string[];
  fix: ClauseFix | null;
  learnedFrom: LearnedFrom;
  /** Set when the tier was at its ceiling and this clause pushed another out (§6.6). */
  displaces: string[];
  /** All three are set together, and only when status is 'retired'. */
  retiredAt: string | null;
  retiredReason: RetiredReason | null;
  /** des-validate's ablation run id, or the displacing clause id. Null only for 'manual'. */
  retiredBy: string | null;
  /** Unrecognised frontmatter keys, preserved verbatim so a rewrite never drops them. */
  extra: Record<string, string>;
  /** The markdown after the frontmatter, parsed by the existing loader. */
  clause: Clause;                   // from ../policy/practices
  path: string;
}

/** What every consumer sees. `Clause` plus the four things a governed clause needs. */
export interface GovernedClause extends Clause {
  origin: ClauseOrigin;
  status: ClauseStatus;
  fix: ClauseFix | null;
  /** Present only for origin 'learned'. */
  provenance: {
    evidence: Evidence; support: number; contradictions: number;
    learnedAt: string; adoptedAt: string | null; learnedFrom: LearnedFrom;
  } | null;
  /**
   * The immutable subset of provenance that ships in the compiled artifact, so a clause is
   * deletable from the artifact alone (§5.4). Both halves are immutable AFTER ACCEPTANCE, and that
   * is load-bearing, not tidiness: any mutable per-clause field here moves the revision, which
   * rewrites the cached prompt prefix — about $1.25 per session at 200k context. So never add a
   * "last matched at" / hit counter to a compiled clause. Counters live in the audit log.
   */
  deletable: { decisions: string[]; validation: string | null } | null;
  /**
   * Ranking signal for des-runtime's selector. Bucketed, FROZEN AT ACCEPT TIME, never updated —
   * live `support`/`evidence`/`contradictions` stay in the corpus and the audit log where the
   * offline tools read them. Frozen because a mutable per-clause field moves the revision and
   * rewrites every running session's cached prefix; bucketed because a raw count would churn on
   * every ingest. If a clause's support later changes enough to matter, that is a new clause
   * revision through review — which is the honest way to say it.
   */
  weight: 'high' | 'medium' | 'low';
}
```

A hand-written `bottom-line.md` entry becomes a `GovernedClause` with
`origin: 'human'`, `status: 'accepted'`, `fix: null`, `provenance: null`. So there is **one runtime
type**, and every consumer — the hook ladder, the prompt, the lint, the replay — reads it. That is
the `practices.ts:10-13` discipline ("a second knowledge path would be a second source of truth")
applied to the write path.

---

## 3. Provenance and trust

### 3.1 The requirement

A reader — human or runtime — must be able to tell a hand-written clause from a machine-proposed
one, and a machine proposal must never override a human's explicit practice. Enforced in the data
model, not in prose.

### 3.2 Authorship is the path

`origin` is **not a field**. It is set by the loader:

```ts
// reading data/knowledge/<dir>/<slug>/bottom-line.md   → origin 'human'
// reading data/knowledge/<dir>/<slug>/learned/<id>.md  → origin 'learned'
```

An `origin:` key appearing in a learned file's frontmatter lands in `extra` and is ignored, exactly
like any other unknown key — and `lint` errors on it by name, because writing it is a sign somebody
thought it would work.

Why this and not a field: the machine writes the file, so it can write any field value it likes.
It cannot write the *directory the loader chose to read*. This is the same reasoning that makes
`01` §6.5 correct about red-before-green: the invariant has to live somewhere the untrusted party
cannot reach.

A human who wants a learned clause treated as their own writes it into `bottom-line.md` and deletes
the learned file — a normal edit, in a normal PR. `status: accepted` on a learned file means *a
human approved this machine clause*, which is a strictly weaker statement, and the ladder treats it
as such.

### 3.3 Precedence: a four-rung ladder

The existing hook ladder (`permissionRequest.ts:19-30`) evaluates written red clauses before written
green ones, across all tiers, because "a deterministic matcher has to break the tie somehow, and
safety is the only defensible way." That protects a team red from a user green. It does **not**
protect a human green from a learned red — a machine clause could deny work a human explicitly
allowed. So rungs 3 and 4 of the existing ladder become four:

```
3a. human   red   — any tier, narrower first   → deny, citing the clause
3b. human   green — any tier, narrower first   → allow, citing the clause
3c. learned red   — any tier, narrower first   → deny, citing the clause
3d. learned green — any tier, narrower first   → allow, citing the clause
```

Two properties fall out, and both are testable:

- **A machine clause can never contradict a human clause about the same call.** If any human clause
  matches, a verdict is returned at 3a or 3b and rungs 3c/3d are never reached.
- **Safety still wins within an origin.** Red precedes green inside each half, so today's
  team-red-beats-user-green invariant is unchanged.

### 3.3.1 The surprising rung: a human green beats a learned red, by design

Read the ladder quickly and 3b-before-3c looks like the unsafe direction winning. It is deliberate,
and it is the *same* rule as everything else in §3, not an exception to it:

> **A machine proposal never overrides a human's explicit practice — in either direction.** Not to
> permit what a human forbade, and not to forbid what a human permitted.

The alternative — learned red beating human green — was considered and rejected. It means one bad
extraction can halt a team's work on a call a human explicitly wrote down as allowed, with **no
human in the loop at the moment it happens**: the agent stops overnight, the citation names a clause
nobody wrote, and the only remedy is someone waking up and editing the corpus. That is a worse
failure than the one it prevents, because the failure it prevents has a human remedy that already
exists: if the human green is wrong, a human changes it, in a PR, with a diff. Machine-proposed
policy earns authority by being reviewed, not by being pessimistic.

Two boundaries on that, so it is not read as wider than it is:

- **It is not fail-open.** A learned red still fires on every call no *human* clause covers — which
  is the overwhelming majority — and the engine's built-in destructive-action table (rung 5) is
  untouched and still catches what nothing written covers. The scope of 3b-over-3c is exactly
  "calls a human explicitly permitted in writing".
- **Learned red still beats learned green** (3c before 3d), for the same reason human red beats
  human green: within one origin a matcher has to break the tie, and safety is the only defensible
  way (`permissionRequest.ts:19-30`). So the pessimistic ordering holds everywhere it is not
  contradicting a human.

The lint helps here rather than the runtime: when a learned red's patterns overlap an accepted human
green's, `lint` reports it as a contradiction and names both clauses, so the conflict is surfaced to
a reviewer — Karpathy's *flag, never silently overwrite* — instead of being silently resolved at
3am by whichever rung ran first.

Implementation is a change of loop bounds in `decideOne`, not a new mechanism:

```ts
for (const origin of ['human', 'learned'] as const) {
  for (const level of ['red', 'green'] as const) {
    const hit = findMatchingClause(clauses.filter(c => c.origin === origin), hay, level);
    if (hit) { return verdictFor(hit, level); }
  }
}
```

`rankClauses` still orders by tier within each pass, so ordering is fully determined by
`(origin, level, tier, id)` — total, deterministic, and reproducible under replay.

The correction lane (rung 2) keeps its position ahead of red, and keeps its existing guarantee that
the rewritten input is re-checked against the red clauses before it is returned. Clause-declared
fixes are consulted human-origin-first, for the same reason.

### 3.3.2 The write boundary — an enforced invariant, not a convention

The whole trust model rests on the path carrying the authority, so the pipeline's write surface is
an enforced invariant with its own test, not an implied convention:

> **Every write the pipeline makes is to `data/knowledge/<dir>/<slug>/learned/<id>.md`, where `<id>`
> equals the clause's `id` field. Any other path is a hard error and the run makes no change at
> all.**

Enforced in one place — a `learnedClausePath(tier, slug, id)` function that is the *only* thing in
the pipeline that produces a write path — plus a guard that re-validates the resolved absolute path
before the write:

```ts
// src/supervisor/learnedClauses.ts
export function learnedClausePath(tier: Tier, slug: string, id: string): string { … }

/** Refuses anything the pipeline is not allowed to write. Called on every write, no exceptions. */
export function assertWritable(corpusRoot: string, target: string, id: string): void {
  // resolved, symlink-resolved, must be exactly <corpusRoot>/data/knowledge/*/*/learned/<id>.md
}
```

Four things it rejects, each because it is a real way the invariant could be lost:

1. any path not under a `learned/` directory — in particular `bottom-line.md`, the registry, and
   anything outside `data/knowledge/`;
2. a filename not equal to `<id>.md`, so the path and the citable id can never disagree;
3. a traversal or symlink escape (`..`, or a `learned/` that is a symlink pointing elsewhere) —
   the check runs on the fully resolved real path, not the string;
4. a write while the corpus checkout is *not* the configured corpus root, which is the
   `01` §6.1 hazard restated: the default knowledge repo is the workspace the supervised agent can
   write, so the pipeline must never be pointed at a tree it does not own.

`assertWritable` throws; per the fail-closed constraint, a throw means the run writes nothing and
exits non-zero. A partial proposal is worse than no proposal.

**What if a human hand-authors a file under `learned/`?** It is harmless, and it works: the file
loads, `origin` is `'learned'`, and the clause is evaluated at rung 3c/3d. The only effect is that
the human has **downgraded their own clause's precedence** — it now loses to every clause in a
`bottom-line.md`, including a contradicting one. Nothing is corrupted and nothing is unsafe; the
clause just does less than the author expected. So `lint` emits an **info**, not an error:

> `learned/foo.md` has no `learned_from` evidence — a hand-written clause belongs in
> `bottom-line.md`, where it outranks machine-proposed clauses.

Info rather than error because the reverse direction is also legitimate: a reviewer who is not yet
sure about a clause can deliberately park it in `learned/` precisely to give it the lower
precedence. The heuristic is `learned_from` being empty, which is the one thing a machine-proposed
clause always has and a hand-written one never does.

**How this squares with §2.5's mandatory rationale.** The two checks key on different fields, on
purpose:

| Check | Keys on | Severity | Why |
|---|---|---|---|
| "this looks hand-parked" | `learned_from` empty | **info** | parking is legitimate, so it cannot be an error |
| "this clause has no rationale" | the **body prose** | **error** | it applies to *every* clause under `learned/`, machine-proposed or hand-parked |

A hand-parked clause has a human author sitting right there, so it is the *easiest* case in which to
demand a reason, not an exception to it. The rationale requirement therefore never keys on
`learned_from`: an empty evidence list means "a human wrote this", which changes the precedence
advice and changes nothing about whether the why is recorded.

**Ruling on `evidence` for a hand-parked clause: it is absent, not `AMBIGUOUS`.** `evidence` describes
an *extraction*, and a clause a human typed had none — so no value in the enum is honest, and forcing
one makes the field lie in the one case a reviewer most needs to trust it. Hence the conditional in
§2.2: required iff `learned_from` is non-empty, a compile error when present with empty
`learned_from`, and a compile error when missing with evidence present. Both directions checked, so
there is no defensive "it might be either" for an implementation to guess at.

`impl-foundation` currently requires it always and writes `AMBIGUOUS` for the hand-parked case
(PR #42). That works and is not a bug — it just costs the honesty of the field, so it should flip to
the conditional. Three lines of validation, and one fixture.

### 3.4 Why `evidence` is not read at runtime

`evidence: AMBIGUOUS` is a **routing decision for the reviewer**, per `02` §R3, and the routing
happens offline: an AMBIGUOUS candidate is labelled in the PR and needs an explicit human accept.
Once `status: accepted`, a human has taken responsibility, and re-litigating that at the permission
boundary would mean the runtime second-guessing a decision it has less information about than the
reviewer did. So `evidence` is carried into the compile report and the `explain` output, and is
**absent from the compiled artifact**. Stated plainly because the alternative — a runtime that
discounts AMBIGUOUS clauses — is a plausible-sounding design that produces a clause whose effect
nobody can predict from reading it.

---

## 4. Supersede-not-delete, and bi-temporality

### 4.1 The requirement

An audit record from March must resolve to the clause text that actually fired, after the corpus
changed in September.

### 4.2 Three timelines, one of them authoritative

| Timeline | Field | What it means | Authoritative for |
|---|---|---|---|
| when the machine learned it | `learned_at` | the ingest run that extracted the candidate | staleness pruning |
| when it became effective | `adopted_at` | the human accepted it | the effectiveness report |
| when it was actually loadable | the **revision chain** | which compiled artifact contained it | **audit** |

The decisive call: **the revision chain is authoritative for audit, and the two dates are
documentation.** A clause can be accepted and not compiled; compiled and not yet deployed; deployed
and then reverted. Dates in frontmatter cannot express any of that, and two competing answers to
"what was in force in March" is worse than one imperfect one. `adopted_at` earns its place by
answering a different question — *did adopting this help?* — which the revision chain answers only
awkwardly.

### 4.3 The mechanism

1. **Nothing is deleted.** A replacement clause carries `supersedes: [old-id]`; the old file stays
   on disk with `status: superseded`. `compilePolicy()` excludes it from `clauses[]` and names it in
   the compile report.
2. **Every decision stamps its revision.** `DecisionRecord` gains one field:

   ```ts
   /** The compiled policy revision this decision was evaluated against. Null when no artifact
    *  was in use (the live-parse path), which is itself the fact a reader needs. */
   policyRevision: string | null;
   ```

   `SupervisionRecord` gains `policy_revision: string | null` for the classifier path. Both are
   additive and nullable, so old records read back unchanged — the same rule
   `SupervisionRecord.session_name` already documents ("null on a record written before names
   existed").
3. **Artifacts are retained.** `dataDir()/policy/<revision>.json` is never rewritten (the filename
   *is* the hash). Retention: the last 20 revisions, plus every revision named by a decision still
   present in `decisions.jsonl` or `decisions.jsonl.1`. Since the trail is bounded at 4 MiB with one
   generation kept (`trail.ts:MAX_BYTES`), the artifact set stays bounded by construction and never
   outlives the decisions that reference it.
4. **`policy explain <requestId|decisionId>`** reads the decision, loads `policy/<rev>.json`, finds
   the clause by id, and prints the verbatim `title` + `body` + `patterns` that fired — from the
   revision that fired them, not from today's corpus. If the artifact has been reaped, it says so
   explicitly rather than printing today's text as though it were March's. **That last sentence is
   the whole feature**: silently substituting current text is how an audit trail becomes a lie.
5. **`corpusRevision`** in the artifact ties the revision back to a git SHA, so the markdown itself
   is recoverable from the corpus repo even after the artifact is reaped.

---

### 4.4 Retirement — a state, because "replaced" and "dead weight" are different histories

`expires` and `supersedes` do **not** cover this, and I will not pretend they do:

| | Means | Recorded as |
|---|---|---|
| `supersedes` | *a better clause about the same subject replaced it* | the successor names it |
| `expires` | *it was only ever meant to hold until a date* | a date, decided at authoring time |
| **`retired`** | *it turned out to change nothing, or the tier was full* | evidence produced **after** the fact |

Forcing retirement through `expires` would mean back-dating a field to a day nobody chose, and
forcing it through `supersedes` would mean inventing a successor that does not exist. Both destroy
the thing a reviewer needs most: *why is this rule gone.* Hence `status: retired` plus
`retired_reason`, which is a compile error to omit.

**What makes retirement possible at all.** `des-validate` owns **ablation replay** — replaying the
recorded decisions *without* a clause to show that removing it changes nothing. That is the operation
that makes deletion falsifiable, and per `05` §1.5 it does not exist anywhere: replay of a whole
rules file exists (`HudsonGri/mdarena`, 65 stars, one commit day), replay of *one clause in
isolation* against a *permission-decision log* does not. **I specify only the schema slot for its
result; the mechanism is des-validate's and I am not duplicating it.** The slot is
`retired_by: <opaque id>` plus `retired_reason: ablation`, and the contract is that des-validate can
resolve that id to the run that justified the retirement.

**Three causes, one state:**

| `retired_reason` | Who decides | `retired_by` |
|---|---|---|
| `ablation` | des-validate's replay showed removing it changed no recorded decision | the ablation run id |
| `displacement` | the tier hit its ceiling and an incoming clause named it in `displaces` (§6.6) | the displacing clause's `id` |
| `manual` | a human retired it in review | null |

**How a retired clause stays resolvable for audit.** Exactly the same mechanism as supersession
(§4.3), and no new machinery:

1. **The file stays on disk.** `status: retired`, the body prose intact. Retirement is a status
   change, never a deletion — this is the one rule the whole section exists to protect.
2. **New artifacts exclude it** from `clauses[]` and name it in `<rev>.report.json` with its reason.
3. **Old artifacts still contain it**, unchanged, because an artifact filename *is* its content hash
   and is never rewritten. So a March decision stamped with revision A resolves through A.
4. **`policy explain` on that decision** prints the clause verbatim from A, and appends the
   retirement: *retired 2026-11-14 (ablation, run abl-2026-11-14-7c3f)*. The decision is explained by
   the text that fired **and** by the fact that the rule no longer applies — which is more than a
   live corpus could ever tell you.
5. If revision A has been reaped, the same honest failure as §4.3 step 4: say the artifact is gone
   and name the `corpusRevision`. Never substitute today's text.

A retirement is therefore a **normal reviewable diff**: one file's frontmatter changes four lines,
and `git log` on that file is the clause's whole life.

### 4.5 The audit deadline is `expires`. No new field.

`13-governance` §7.2 wants `| audit | 2026-09-15 |` in the metadata table, and its templates render
*"audit closes &lt;date&gt;"*. My answer is **not to add `audit_until`**: `expires` already exists, is
already a date, is already validated for ISO shape (§5.8), and already **fails the compile once it is
in the past** (§2.2). Point it at the audit deadline and the deadline acquires teeth for free — after
2026-09-15 nothing compiles until a human promotes the clause to `accepted` or retires it. That is
exactly the promote-or-drop gate governance is asking for, and a second date field would mean two
answers to *when does this stop* with only one of them enforced.

So: **an `audit` clause SHOULD carry `expires`, and governance's template reads `expires`.** `lint`
warns on an `audit` clause without one (a trial with no deadline is a trial nobody ends).

**One field, two enforcement levels, keyed on `status`:**

| `status` + past `expires` | Effect |
|---|---|
| `accepted` | **compile refuses to publish.** The clause is still enforced in the last good artifact — nobody's red stops firing because a date passed — but nothing new ships until a human extends or retires it. |
| `audit` | **refuses to *promote*, never blocks the compile.** `lint` errors, governance's promote gate refuses, the dashboard shows it. An audit clause contributes nothing to any outcome by definition, and inert things do not get to block the build. |

That asymmetry is the argument *for* reusing `expires`: one field, two documented levels, both
enforced — versus a second field that would only ever have had the weaker one.

**The compile error must be actionable.** It names every expired accepted clause, its `expires` date,
the days elapsed, and the two legitimate remedies — because an error that says only *something
expired* turns a two-minute fix into archaeology:

```
compile refused: 2 accepted clauses have expired

  practices §stale-green-npm-audit        expires 2026-03-01  (185 days ago)
    data/knowledge/projects/demo/learned/stale-green-npm-audit.md
  practices §old-lockfile-rule            expires 2026-07-14  (50 days ago)
    data/knowledge/teams/platform/bottom-line.md

Two ways forward, both a reviewed diff:
  - extend:  set a new `expires`, if the practice still holds
  - retire:  status: retired + retired_reason: manual  (the clause stays on disk and stays citable)

The last good artifact (sha256:4f9a1c2e) is still serving. Expiry never removes a block.
Responding to an incident? `policy block` is outside the artifact and works regardless — see
14-runtime §7.3.
```

**A blocked compile never blocks incident response.** The deny-only revocation channel
(`policy block`, `14-runtime` §7.3) does not go through the artifact, so a stale `expires` on some
minor green cannot stop a team from denying something at 02:00. That is precisely why that channel
exists, and it is stated here because someone reading "compile is blocked" mid-incident will
otherwise conclude they have no options. The
semantics are unchanged for `accepted` clauses — `expires` has always meant *stop trusting this after
this date*, and for a trial that is the same sentence.

```
// ponytail: reusing `expires` instead of adding `audit_until`. One date field, one enforcement
// path, already tested. Add a second only if a clause ever needs a trial deadline AND a separate
// sunset — which nothing has asked for.
```

## 5. The compiled runtime artifact

### 5.1 Why it exists

Two constraints from the brief, both violated by parsing the corpus per decision:

- **Constraint 2 (KV cache).** PR #37 puts practices in the `system` block behind a cache breakpoint
  for a ~99% hit rate. Any byte change invalidates it. A corpus of markdown files that a cron job
  and several humans write to is not a stable input; a content-addressed compiled file is.
- **Constraint 1 (bounded prompt).** `renderKnowledge` (`prompt.ts:121-132`) prints every entry.
  Selection needs a pre-shaped list, computed once.

Plus the cost measured in `01` §2: three `readFile`s (or a full `git clone`) and a full re-parse per
decision, twice per tool call with both PRs installed.

### 5.2 Location

Two files, both real, and **no pointer file** — `policy/HEAD` is dropped:

| Path | What it is |
|---|---|
| `dataDir()/policy/<revision>.json` | immutable, never rewritten. Required for audit resolution: a March decision must resolve to the text that actually fired. |
| `dataDir()/policy/current.json` | a **copy** of the current revision, written atomically (temp + rename). What the hook opens. |

A copy rather than a pointer because the hook's millisecond budget forbids the extra open+read
indirection, and a symlink is platform-annoying on Windows. The duplicated ~112 KB is not worth a
design compromise. The artifact's own `revision` field identifies which revision `current.json` is,
so nothing needs `HEAD` to find out.

Reusing `paths.ts`'s `dataDir()` puts both where the plugin already writes `decisions.jsonl`, and it
survives plugin updates.

**Not in the corpus repo.** It is derived, it is per-routing-triple, and committing it would put a
1,000-line generated JSON diff in front of every reviewer of a two-line prose change — which
defeats the reason §1 kept markdown.

### 5.3 Shape

```json
{
  "schema": 1,
  "revision": "sha256:4f9a1c2e8b7d3056a1f4c9e2b8d70513a6c4f9e2b1d80736a5c4f9e2b1d80736",
  "corpus_ref": "git:9c1e4a7",
  "built_at": "2026-09-01T09:14:03Z",
  "routing": { "user": "alice", "project": "demo-project", "team": "platform" },
  "prompt_core": "- [team] red practices §no-force-push-to-shared-branch\n  Never force-push to a shared branch: Rewriting history on a branch other people build on destroys their work.\n- [team] red practices §team-sec-001\n  Credentials are referenced by environment variable, never pasted: A live key in a prompt, a commit, or a config file is a leak.",
  "clauses": [
    {
      "id": "no-force-push-to-shared-branch",
      "origin": "learned",
      "tier": "team",
      "level": "red",
      "kind": "intention",
      "title": "Never force-push to a shared branch",
      "message": "Rewriting history on a branch other people build on destroys their work.",
      "citation": "practices §no-force-push-to-shared-branch",
      "patterns": [{ "raw": "git push --force", "isRegex": false, "flags": "i" }],
      "fix": { "from": "--force", "to": "--force-with-lease" },
      "weight": "high",
      "sourceFile": "data/knowledge/teams/platform/learned/no-force-push-to-shared-branch.md",
      "supersedes": ["ask-before-force-push"],
      "deletable": { "decisions": ["d-8f21e0", "d-8f2244", "d-903b17"], "validation": null }
    }
  ]
}
```

**Naming: snake_case on disk, camelCase in the types.** `SupervisionRecord` is already snake_case on
disk by documented convention (`models.ts:198`), and this is another on-disk file read by the same
codebase — one convention, no per-file exception. So the JSON keys are `schema`, `built_at`,
`corpus_ref`, `prompt_core`, `message`; the TypeScript interfaces in §2.4 stay camelCase. Where the
prose below says `promptCore` / `corpusRevision` / `compiledAt` it means the same field by its
in-code name.

### 5.4 What is included, what is omitted

**Included:** clauses where `status` is `accepted` **or `audit`** (audit clauses are compiled so they
can match; they are excluded from `promptCore` and from the per-call selection, and their match
records an `audit_verdicts` entry instead of a verdict — see §2.4), not named by any accepted clause's `supersedes`,
whose `expires` is absent or in the future, and every one of whose `Match:` patterns compiled.

**Omitted, and why each omission is safe:**

| Omitted | Reason |
|---|---|
| `status: proposed` / `declined` | a proposal must not be able to affect a decision — invariant T1 |
| superseded clauses | the replacement is present; the old text stays resolvable through the *older* artifact and the corpus |
| `evidence`, `support`, `contradictions`, `learned_at`, `adopted_at`, `learned_from.sessions` | offline-only and **mutable**. Excluding them means editing a support count does not change the revision, does not invalidate the KV cache, and cannot change a verdict |
| `tags`, `confidence`, `scope`, `source` | no consumer (§2.3) |
| the compile report | written to the sibling `policy/<rev>.report.json`, deliberately **outside** the hashed artifact, so a change to the proposed-clause queue never moves the revision |

**Kept in the artifact on purpose: enough to delete the clause from the artifact alone.** `05`'s
design consequence is that a clause is safely deletable only if it carries (a) the rationale,
(b) the concrete decisions that motivated it, and (c) an identifier for the replay that justified it.
So each compiled clause carries `body` (a, already there) and
`deletable: { decisions, validation }` (b and c). Both halves are **immutable once accepted** — a
decision id list and an ablation run id do not change under a reviewer's edits — so this adds bytes
to the hashed artifact without reintroducing revision churn, which is exactly why `support` and
`evidence` stay out. It costs nothing in the prompt: `deletable` is not in `promptCore`.

The property this buys: someone holding only `policy/<rev>.json` can answer *why does this clause
exist, what produced it, and what proved it earns its place* — without the corpus, without git, and
without asking anyone. A clause that cannot answer those three is permanent by construction.

**A clause with a dropped pattern is not omitted — it fails the compile.** `01` §5 verifies the
worst failure mode in the codebase: `practices.ts:143-145` drops an unparseable regex and a red
clause silently protects nothing. `compilePolicy()` returns a non-zero exit naming the clause and
the pattern. Offline, loud, before anything ships. This is the single highest-value line in this
spec.

### 5.5 The revision hash

```ts
export function revisionOf(a: CompiledPolicy): string {
  const { revision: _r, compiledAt: _c, ...body } = a;
  return 'sha256:' + createHash('sha256').update(canonicalJson(body)).digest('hex');
}
```

`canonicalJson` sorts object keys recursively, emits no whitespace, and uses `\n` nowhere outside
string values. Two properties, both tested:

- **`compiledAt` and `revision` are excluded**, so recompiling an unchanged corpus yields the same
  revision, `current.json` is byte-identical, and the KV cache stays warm. Including a timestamp in the hash
  would defeat the entire purpose of the artifact.
- **`promptCore` is inside the hash**, because it is the bytes that go into the cached system block.
  If the core changes, the revision must change — the cache is *supposed* to be invalidated then.

**One naming scheme, settled with des-runtime: the content hash.** Artifacts are named by
`revisionOf()`, and a citation is `practices §<id>@<rev7>` where `rev7` is the first 7 hex characters
of that hash. The alternative — naming by the corpus git SHA — needs a second form
(`local-<sha256(tier files)>`) for an uncommitted checkout, which the content hash covers with no
special case. The git SHA is still recorded, as `corpusRevision`, so the markdown stays recoverable.

`corpusRevision` is `git:<short-sha>` when the corpus checkout is clean, and
`dirty:<sha256-of-inputs-8>` when it is not — because `knowledge.ts:360` reads the working tree, not
a commit, and a compile from an uncommitted tree must be visibly distinguishable in an audit trail.

### 5.6 Loading, and failing closed

```
loadGovernedClauses(settings):
  1. if policy/current.json exists → read it (or, for a session pinned to a revision,
     policy/<pinned-rev>.json)
       a. recompute revisionOf(); mismatch → discard, log, fall through to (2)
       b. malformed JSON or `schema` > 1 → discard, log, fall through to (2)
       c. routing triple ≠ the session's triple → discard, log, fall through to (2)
       d. otherwise → return its clauses, and stamp `policyRevision` on the decision
  2. a pinned <rev>.json that is missing or fails (a)-(c) → fall back to current.json,
     then to (3). A pinned session never silently upgrades to a different revision without
     the fallback being logged.
  3. else → today's path: loadPractices() over the corpus, plus the learned/ walk,
            filtered to status accepted or audit. `policyRevision: null`.
```

Falling back to the corpus is not fail-open: the corpus is the source of truth, and a tampered
artifact that *removed* a red clause is defeated by re-reading the markdown. The existing rule at
`permissionRequest.ts:64-68` still holds — a configured-but-unreadable policy source is an error,
never an empty policy.

### 5.7 A malformed file: load keeps the good clauses, compile refuses the artifact

A parse failure in one file under `learned/` must **not** drop the other clauses in that tier.
Dropping the tier removes *other* reds too, which is strictly worse than losing the broken one — so
the two halves are split, deliberately, and the split is the reconciliation of fail-loud with
never-silently-weaken:

| Stage | On a malformed `learned/<id>.md` | Why |
|---|---|---|
| **load** (runtime) | skip that file, **keep every other clause in the tier**, and surface the finding (a `SkipRecord` on the bundle: path + reason, reported by `lint` and by `policy status`) | Cedar's *skip-on-error, and report it* (`02` §4c). The alternative loses reds nobody broke. |
| **compile** | **refuse to produce an artifact at all**, exit non-zero, name the file and the reason | A broken corpus must never become live policy. This is already the rule for a dropped regex (§5.4); it is the same rule. |

The two halves cannot drift because they answer different questions: *what is the safest thing to
serve right now* (everything that still parses) versus *may this become the new policy* (no). The
runtime keeps serving the **last good artifact** while the corpus is broken, so a malformed proposal
cannot weaken production even for one decision.

### 5.8 The other parse-failure rulings, recorded

Blessed as decisions, all of them errors rather than silent defaults:

| Input | Ruling |
|---|---|
| malformed ISO date in `expires` / `learned_at` / `adopted_at` / `retired_at` | **error.** `expires` is load-bearing at compile time, so a date that silently parses to something else is a rule that silently outlives its sunset. |
| non-numeric `support` | **error.** Absent is `0` (§2.2) — a *wrong* number is not the same as no number. |
| two `###` entries in one `learned/` file | **error.** One clause per file is the whole point of §1.2; two means the filename disagrees with at least one `id`. |
| an unreadable file under `learned/` | **error**, not a skip — the same rule as `permissionRequest.ts:64-68`, a configured-but-unreadable policy source. Note this is the *file* being unreadable (I/O), distinct from §5.7's malformed *content*. |

---

## 6. Selection and bounding

Today `renderKnowledge` prints every entry from every tier, untruncated, while `renderTurns` caps at
40 turns and truncates payloads to 400 chars. At 200 accepted clauses the knowledge block crowds out
the transcript it is supposed to be reasoning about. This is a correctness bug, not an optimisation.

### 6.1 The rule that comes first: matching is never budgeted

Deterministic matching runs over **every** compiled clause. No cap, no selection, no retrieval.
A red clause dropped by a budget is a silent safety failure — the exact class of bug `01` §5
verified in the dropped-regex case. Matching 200 compiled substring/regex matchers against one
command is microseconds and no I/O.

So the budget applies **only** to the classifier's knowledge block, which is reached only when the
deterministic ladder returned nothing.

### 6.2 Two blocks, split by the cache breakpoint

| Block | Contents | Where | Budget |
|---|---|---|---|
| **core** | `promptCore` from the artifact, byte-for-byte | inside the cache breakpoint, with the rest of the system prompt | 8 KB |
| **selected** | clauses relevant to *this* pending action | outside the breakpoint, next to the transcript (which varies per call anyway) | 4 KB |

This is what makes constraints 1 and 2 compatible. A per-call selection inside the cached block
would invalidate the cache on every call; putting it in the already-varying region costs nothing.

### 6.3 The core set (compile time, deterministic)

Every clause with `level` `red` or `orange`, ordered by `(level: red, orange) → (origin: human,
learned) → (tier: user, project, team) → id`, each rendered as today's two-line form with the body
truncated at 400 chars (matching `prompt.ts:141`'s existing convention).

If the core exceeds 8 KB, **the compile fails** and names the byte count. A corpus whose mandatory
rules do not fit in the prompt is a corpus that needs splitting into narrower tiers, and finding
that out offline is infinitely better than finding out from a truncated red rule at 3am.

### 6.4 The per-call selection (runtime, deterministic)

In order, stopping at 4 KB:

1. **Every clause whose patterns match** the pending action's haystack, in ladder order. These are
   the clauses that *would have* decided if the ladder had been allowed to; the classifier must see
   them. Uncapped within the 4 KB (in practice a handful).
2. **Prose-only clauses, by token overlap.** Score = the number of distinct lowercase word tokens of
   length ≥ 4 shared between `title + body` and `toolName + summarizeInput(toolInput)`. Take the top
   10 with score ≥ 1, ties broken by ladder order.
3. **Nothing else.** No embeddings, no LLM call, no similarity model at the permission boundary.

**What happens when the selection does not fit in 4 KB: whole clauses are dropped, never
truncated.** Clauses are emitted in the order above and the first one that would cross 4 KB — and
every one after it — is dropped entirely; the count lands in the subset line. The two alternatives
were rejected:

- *Truncate mid-clause* — a half-rendered clause is the worst possible input to the classifier: the
  `why` survives and the `what to do instead` is cut, or a body ends mid-sentence and reads as a
  different rule than the one on disk. A clause the model is shown must be the clause the corpus
  contains, or the decision is not explainable from the artifact.
- *Spill into the cached core* — that invalidates the KV cache on a per-call basis, which is the
  exact thing §6.2 exists to prevent.

Dropping whole clauses keeps the property that every rendered clause is verbatim, and the subset line
makes the drop visible. Note that this is a soft edge: the clauses at risk of being dropped are the
low-scoring token-overlap ones, because §6.4's step 1 (clauses whose patterns actually matched) is
emitted first and is a handful in practice. If step 1 alone ever exceeds 4 KB, that is a corpus with
many long overlapping matchers for one call, and `lint` reports the overlap — but the runtime still
drops rather than truncates, and still says so.

Then one final line, always emitted:

```
(N of M clauses shown — policy revision sha256:4f9a1c2e, core 12, selected 7)
```

The model is told its knowledge is a subset, and the audit record can reconstruct exactly which
clauses were in front of the model for that decision. A prompt that silently shows a subset is a
prompt whose output nobody can reproduce.

Token overlap is a deliberately naive heuristic. `ponytail:` the upgrade path is `node:sqlite`'s
FTS5 (verified available on the box per `02`, zero deps, zero build) — worth building the day a
measured miss rate justifies it, not before.

### 6.5 What this means for existing users

Today's corpora are far under 12 KB, so every clause still renders, in the same order, with the same
two-line format. The bounding is invisible until it is needed, which is the only acceptable shape
for a change to the prompt that governs everyone.

---

### 6.6 Budgets, confirmed: I specified bytes, des-validate specifies the count

To answer the question directly: **§6 specifies byte budgets only** — 8 KB for the revision-stable
core, 4 KB for the per-call selection. I did **not** specify a per-tier clause ceiling, and after
reading `05` that is a gap, because bytes are the wrong unit for the failure the research measured.
arXiv:2507.11538's 68%-at-500 result and the 16-irrelevant-instructions/-24-point figure are about
**instruction count**, not size; and `05` §1.4 records the correct rebuttal to byte-based
compression (*"a `##` header is like 1-2 tokens… the actual token savings are smaller than the
byte-level numbers suggest"*). Byte budgets protect the prompt. They do not protect compliance.

**Two different limits were both being called "the ceiling." They are not the same limit**, and this
spec uses these names throughout:

| Name | What it bounds | Owner | Value |
|---|---|---|---|
| **per-tier rendered-clause ceiling** | how many clauses of one tier may be *rendered* into a prompt | `12-validation` §5.3 | 25 |
| **total instruction-equivalent budget** | the whole corpus's instruction count, across tiers | `11-pipeline` §11 | `max_clauses` 150 |

They are compatible — 150 total with at most 25 rendered per tier — but a reader collides them, so
`displaces` and the compile check below apply to the **total instruction-equivalent budget**, and the
**per-tier rendered-clause ceiling** is a selection limit enforced in §6.4, not a reason to retire a
clause.

**The count is real and it is des-validate's number.** The division of labour:

| Owner | Owns |
|---|---|
| des-validate | the ceiling's *value*, the one-in-one-out displacement policy, and the ablation replay that justifies a displacement |
| this spec | the *schema slot* that records which clause a proposal displaced, and the compile-time check that the displacement actually happened |

The schema side is two things and no more:

1. **`displaces: [id]`** on the incoming clause — distinct from `supersedes`, because they are
   different claims. `supersedes` says *this replaces that, on the same subject*; `displaces` says
   *the tier was full, so that unrelated clause lost its seat*. Collapsing them would erase the
   difference between an improvement and an eviction, which is the same mistake as collapsing
   `retired` into `superseded` (§4.4).
2. **A compile-time check with no discretion:** for each accepted clause, every id in `displaces`
   must resolve to a clause that is `status: retired` with `retired_reason: displacement` and
   `retired_by` equal to the displacing clause's id, and the total count of accepted clauses must be
   at or under the **total instruction-equivalent budget**. Otherwise the compile fails. That makes one-in-one-out
   **checked** rather than intended — a policy nobody verifies is a policy that quietly stops
   happening on the first busy week.

```
// ponytail: both limits are shared constants the compiler reads, not per-tier config.
// A knob per tier is a knob nobody tunes and everyone forgets. Split the tier if it doesn't fit.
```

The limits interact in exactly one place, and the interaction is benign: the total
instruction-equivalent budget binds first in practice, so the 8 KB core-overflow compile failure (§6.3) is the backstop for a tier of
unusually long clauses rather than the primary limit. Both fail at compile time, offline, naming the
number.

## 7. Coexistence with Claude Code auto memory

Auto memory is on by default, writes typed notes (`user` / `feedback` / `project` / `reference`)
into `~/.claude/projects/<repo>/memory/`, and its `feedback` type explicitly captures "corrections
you give Claude and approaches you confirm" — the same raw material we mine. Two learning systems on
one machine.

### 7.1 The position: complement, document the overlap, read nothing

| | Auto memory | Session Sitter clauses |
|---|---|---|
| Written by | Claude, silently, mid-session | a scheduled pipeline, then a human in review |
| Reviewed | never | a git PR, one file per clause |
| Scope | machine-local, one repo | team / project / user tiers, shared in a corpus repo |
| Enforcement | none — context for the model | deterministic allow/deny/rewrite at the permission boundary |
| Citation | none | `practices §<id>`, in the audit record |
| Recall | model-driven (`MEMORY.md` → open files on demand) | deterministic pattern match, then bounded prompt |

We do not rebuild what it does. We are the governance artifact it is explicitly not.

### 7.2 What we will not do, and why

**We never read `~/.claude/projects/**/memory/**`.** Two reasons, in order: the brief's privacy rule
forbids reading the content of anything under `~/.claude/projects/`, and — noted in `03` §1.5 — an
attempt to `head` one of those files was itself denied by the auto-mode classifier as PII handling.
A pipeline whose first act is to trip the platform's own privacy gate is the wrong pipeline.

There is also no *need*. Our extraction inputs are the two things we already own: the masked corpus
under `data/sessions/`, and `decisions.jsonl` — which `00-brief` correctly identifies as the richest
mining input in the system, and which contains the one signal auto memory has no equivalent of: a
human overriding a governance decision.

### 7.3 What we legitimately can do

1. **Document the overlap** in `docs/KNOWLEDGE.md` with the table above, so a user asking "why did
   Claude remember X but Session Sitter didn't learn it?" gets an answer instead of a mystery.
2. **A human-driven, one-way import.** `policy propose --from-file <path>` accepts a file the *human*
   points at, including a memory note they chose to share, and turns it into a `proposed` learned
   clause with `evidence: AMBIGUOUS` and `learned_from.sessions: []`. The human is the trust
   boundary; the pipeline never walks that directory, never globs it, and never reads it
   unprompted. This is the difference between a user sharing a file and a tool crawling a private
   store.
3. **Say what we do not know.** A memory note may state the opposite of an accepted clause and
   nothing will reconcile them. We cannot detect that without reading the notes, so we will not
   claim to. It goes in the docs as a named limitation.

### 7.4 One claim I could not verify, flagged

Auto memory writes to a separate directory, not into the session JSONL, so the corpus importer
should not be double-counting memory text as session content. I take this from `03` §1.2/§1.4
(documented storage layouts) and **did not verify it by reading either location**, per the privacy
rule. If it turns out that memory content is echoed into the transcript, §7.2's "no need" argument
weakens and the extraction step needs a filter. Worth one deliberate check by whoever owns the
importer, using `/export` or `claude -p --output-format json` — never a direct read.

---

## 8. Migration

Zero breakage is a requirement, and this design achieves it by **not touching anything that
currently works.**

| Existing thing | What happens on upgrade |
|---|---|
| `data/knowledge/**/bottom-line.md` | nothing. Not moved, not reformatted, not re-validated. Parsed by the same `parseBottomLine`. |
| `parseBottomLine`, `parseRegistry`, `resolveTriple`, `fetchBdiFiles`, `loadKnowledge` | unchanged, including the `meta[key] = val` swallow and the `?? null` defaults |
| `parsePractices`, `clauseFrom`, `rankClauses`, `findMatchingClause` | unchanged. `GovernedClause extends Clause`, so every existing consumer compiles |
| the 56 test files / 1,139 passing tests on `10ff422` | unchanged inputs, unchanged outputs |
| `knowledge/bottom-line.template.md` | gains a comment noting that `confidence`, `scope` and `source` are legacy advisory fields, and that `expires`/`supersedes` become load-bearing only under the compile path. The template's misleading YAML frontmatter (`01` §3 — `scope`/`owner`/`updated`, read by nothing) is either removed or made real; that is a one-line docs fix, not a schema change |
| absent `learned/` directory | reads as zero learned clauses, via the existing missing-tier rule |
| absent `policy/current.json` | live-parse path, `policyRevision: null`. **No compile step means today's behaviour exactly.** |
| `expires: 2020-01-01` on an existing entry | still no runtime effect. Becomes a `lint` error, and blocks a *compile* — which the user has to opt into. Nobody's red rule stops firing because they upgraded. |
| `supersedes: old-id` on an existing entry | still no runtime effect on the live-parse path; excludes the target on the compile path |
| unknown fields (`levle: red`) | still parsed into `meta`/`extra`, still preserved on round-trip, now surfaced by `lint` with a did-you-mean |

The one behaviour change anybody could notice is §6's prompt bounding, and it is inert below 12 KB
of knowledge — which every existing corpus is.

Adoption is therefore three independent opt-ins, in any order: run the lint; run the ingest and
review a proposal PR; run the compile and point the runtime at the artifact.

---

## 9. Worked example: one complete clause file

`data/knowledge/teams/platform/learned/no-force-push-to-shared-branch.md`

```markdown
---
id: no-force-push-to-shared-branch
status: accepted
level: red
evidence: EXTRACTED
support: 47
contradictions: 0
learned_at: 2026-08-30
adopted_at: 2026-09-01
expires: 2027-09-01
supersedes: [ask-before-force-push]
displaces: []
fix_from: --force
fix_to: --force-with-lease
learned_from:
  sessions: [20260812_nightly-release-a1b2c3d4, 20260819_hotfix-batch-9f0e1d2c]
  decisions: [d-8f21e0, d-8f2244, d-903b17]
---

### Intention: Never force-push to a shared branch

Match: `git push --force`, `/git\s+push\b[^|;&]*--delete\b/`

Rewriting history on a branch other people build on destroys their work: their next pull is a
conflict against commits that no longer exist, and anything they had not pushed is unrecoverable.

Push a follow-up commit, or push to a new branch and open a PR. If the history genuinely has to
change, `--force-with-lease` refuses when someone else has pushed since you last fetched, which is
the case this rule exists to catch.
```

The two body paragraphs are the **rationale**, and they are why this clause is deletable: a reviewer
in 2027 can read *why* it exists (their next pull is a conflict against commits that no longer exist)
and decide whether that is still true, rather than facing the O(2^|D|) problem of removing a rule
whose reason is gone. `learned_from.decisions` names the three records to check. That pair — reason
plus evidence — is what §2.5 makes mandatory, and both halves travel into the compiled artifact.

Reading it as a reviewer: the *path* says a machine proposed it. `evidence: EXTRACTED` says the
pattern was literally present in the sources rather than inferred. `support: 47 / contradictions: 0`
says it happened 47 times and never the other way. `learned_from.decisions` names three audit
records to check. `supersedes` says which weaker clause it replaces. The body says both why and what
to do instead — Semgrep's `message` doctrine — which is what makes the deny message useful and the
`fix_from`/`fix_to` rewrite defensible.

Reading it as the runtime: `status: accepted` and unexpired, so it compiles; `origin: learned` from
the path, so it is evaluated at rung 3c, after every human clause; `level: red` with two compiled
patterns, so it denies deterministically and cites `practices §no-force-push-to-shared-branch`;
`fix` offers the rewrite lane a mechanical, idempotent replacement that the existing re-check will
re-validate against the red clauses before returning it.

---

## 10. Test plan — the invariants

Existing-style tests: no network, no real agent, no VS Code, injectable seams
(`FetchFn`, `SettingsReader`) as today.

### Trust and precedence

- **T1. A proposed clause never affects a decision.** For a corpus and a set of recorded calls,
  verdicts are identical with and without a `status: proposed` clause added that would have denied
  every call. Asserted on the compiled path *and* the live-parse path.
- **T2. A `declined`, `superseded` or `audit` clause never affects a decision.** Same construction
  as T1, one case per state. For `audit` the assertion is stronger: it matches, it is recorded, and
  the verdict is byte-identical to the run without it.
- **T3. A learned red never overrides a human green.** Table test: human green `npm test` + learned
  red `npm` → allow, cited to the human clause.
- **T4. A learned green never overrides a human red.** → deny, cited to the human clause.
- **T5. `origin` cannot be forged.** A learned file containing `origin: human` loads as
  `origin: 'learned'`, the key lands in `extra`, and `lint` errors on it by name.
- **T5a. Learned red beats learned green.** Learned green `npm` + learned red `npm publish` on the
  same call → deny. The pessimistic ordering holds everywhere it is not contradicting a human.
- **T5b. A learned red still fires where no human clause covers the call**, and the built-in
  destructive-action table (rung 5) still denies where no written clause covers it — asserting
  §3.3.1's scope boundary, so 3b-over-3c is not read as fail-open.
- **T6. Safety order preserved within an origin.** Team red + user green on the same call → deny
  (today's invariant, re-asserted after the ladder change).
- **T7. Ladder order is total.** Two clauses identical but for `id` produce a stable, documented
  winner across 1,000 shuffles of the input array.

### Schema and lint

- **T8. An unknown field is preserved, not dropped.** Load → rewrite → reload round-trips
  `bogusfield` byte-identically; `lint` warns with a did-you-mean for `levle`/`expries`.
- **T9. A non-subset frontmatter construct is a loud error.** A block list, a `|` scalar and a
  quoted key each produce a lint error naming the line — never a silently-empty field.
- **T10. Missing required learned fields fail the compile**, one test per field
  (`id`, `status`, `evidence`), each asserting the error names the field and the file.
- **T11. `fix_from` without `fix_to` (and vice versa) is a compile error.**

### Rationale, retirement, and the ceiling

- **T37. A learned clause with no rationale fails the compile.** Empty body, whitespace-only body,
  and a body that is only a `Match:` line each exit non-zero naming the file. Also: a body under the
  80-character floor fails, and one at exactly 80 passes (the boundary is asserted, not assumed).
- **T38. An existing `bottom-line.md` entry with an empty body still only warns.** The zero-breakage
  half of §2.5, asserted against a real existing fixture — otherwise the requirement quietly becomes
  a breaking change for every current user.
- **T39. The rationale check does not key on `learned_from`.** A hand-parked clause (empty
  `learned_from`) with no rationale → compile error; with a rationale → compiles, and produces
  exactly one `info` about precedence. This is §3.3.2's reconciliation, as a test.
- **T40. `status: retired` without `retired_reason` fails the compile**, and `retired_reason:
  ablation` / `displacement` with a null `retired_by` fails; `manual` with a null `retired_by`
  passes.
- **T41. A retired clause never affects a decision**, and is absent from `clauses[]` but present in
  `<rev>.report.json` with its reason. (T1/T2's construction, extended to the new state.)
- **T42. A retired clause stays resolvable.** Compile A with the clause accepted, decide, retire it,
  compile B; `policy explain` on the recorded decision prints A's body **and** the retirement reason
  and run id. The distinct-histories property: the same test with `superseded` prints *replaced by X*,
  and the two outputs are asserted to differ.
- **T43. Retirement is never a deletion.** After `policy retire`, the clause file still exists and
  its body is byte-identical; only frontmatter changed. Asserted on disk, because this is the one
  rule the whole of §4.4 protects.
- **T44. `displaces` is checked, not trusted.** A clause naming a `displaces` target that is still
  `accepted`, or `retired` for the wrong reason, or whose `retired_by` names a different clause →
  compile error, one case each. And a tier over the ceiling with no `displaces` → compile error.
- **T45. `displaces` and `supersedes` stay distinct.** A clause using `supersedes` to evict an
  unrelated clause does not satisfy the ceiling check, and vice versa.

### Malformed input

- **T46. One malformed file does not drop its tier.** A tier with a red clause plus a malformed file:
  the red still denies at load time, and the skip is reported with the path and reason.
- **T47. The same corpus refuses to compile**, exit non-zero naming the file — the other half of
  §5.7, in the same test file as T46 so the pair cannot drift.
- **T48. The runtime keeps serving the last good artifact** while the corpus is malformed, and the
  decision is stamped with that older revision (not `null`, and not the broken corpus).
- **T49. §5.8's four rulings, one case each** — bad ISO date, non-numeric `support`, two entries in
  one file, unreadable file — each an error naming the field or file. Plus: absent `support` is `0`
  and compiles.
- **T49a. An `audit` clause is in the artifact and inert to the outcome.** It appears in
  `clauses[]` with `status: 'audit'`, its match records an `audit_verdicts` entry, the verdict is
  byte-identical to the run without it, and it appears in neither `promptCore` nor the per-call
  selection. Adding one does not move `promptCore`.
- **T49b. A prose-only `audit` clause is inert**, and `accept --audit` refuses it.
- **T49c. `weight` is frozen.** It is a compile error to omit on an accepted clause; re-running the
  ingest with changed `support` does not change a compiled clause's `weight` and does not move the
  revision.
- **T49d. An `audit` clause's `expires` is the deadline, and a lapsed trial does not block the
  compile.** A corpus whose only expired clause is `audit` compiles successfully; `lint` errors on it,
  and the promote gate refuses it. Paired in the same test with T19's accepted case, so the two
  enforcement levels cannot drift into one.
- **T49e. The expiry error is actionable.** It names every expired accepted clause, its date, the
  days elapsed, both remedies, and the still-serving revision — asserted on the message, because an
  unhelpful-but-correct error is the failure mode this test exists to prevent.
- **T50. The status enum has exactly six values**, and `rejected` / `deprecated` are not among them —
  a one-line guard against the vocabulary drifting back apart across three specs.
- **T51. `evidence` is conditional, both directions.** Non-empty `learned_from` without `evidence` →
  error; `evidence` present with empty `learned_from` → error; hand-parked with neither → compiles.

### Compile

- **T12. A dropped regex fails the compile.** The exact fixture from `01` §5 — a red clause with
  ``/git\s+push\b.*--delete(/`` — exits non-zero naming the clause and the pattern. Today it loads
  silently with one pattern gone.
- **T13. Determinism.** Same corpus bytes → same `revision`, across two processes and two temp dirs.
- **T14. `compiledAt` does not move the revision.** Compile twice, one second apart; revision equal,
  `current.json` byte-identical.
- **T13a. On-disk keys are snake_case.** Compile a fixture corpus, then walk the **emitted
  artifact's** key names recursively (never the TypeScript source, which legitimately stays
  camelCase): `schema`, `built_at`, `corpus_ref`, `prompt_core`, `clauses[].message` present, and no
  key matching `/[a-z][A-Z]/` anywhere. Asserting on the parsed object rather than a source grep is
  what stops it passing vacuously.
- **T13b. `current.json` is a byte-identical copy of `<revision>.json`**, written atomically, and
  `policy/HEAD` does not exist.
- **T14a. `deletable` is present on every compiled learned clause**, carries the accepted clause's
  `learned_from.decisions` verbatim, and is absent (`null`) for a human clause.
- **T14b. `deletable` does not churn the revision.** Editing `support`, `evidence` or
  `learned_from.sessions` leaves the revision unchanged (T15); editing `learned_from.decisions` on an
  **accepted** clause is a compile error, because that list is immutable after acceptance — which is
  what makes T14a's inclusion safe for the KV cache.
- **T15. Offline-only fields do not move the revision.** Editing `support`, `contradictions`,
  `evidence`, `learned_at` or `learned_from` yields the same revision. (This is the KV-cache
  property, expressed as a test.)
- **T16. Adding a proposed clause does not move the revision.**
- **T17. `promptCore` does move the revision.** Changing an accepted red clause's body changes it.
- **T18. Duplicate id is a compile error**, including across origins — an ambiguous citation is the
  `01` §7 #13 failure, and a citation that points at two contradictory rules is worse than no
  citation.
- **T19. An expired accepted clause fails the compile**, naming the clause and the days elapsed.
- **T20. A superseded clause is absent from `clauses[]` and present in `<rev>.report.json`.**
- **T21. A core set over 8 KB fails the compile**, naming the byte count.

### Audit and bi-temporality

- **T22. A decision resolves to the clause that fired, not today's text.** Compile A, decide, edit
  the clause body, compile B; `policy explain` on the recorded decision prints A's body.
- **T23. A reaped revision says so.** Delete `policy/<A>.json`; `explain` reports the artifact is
  gone and names the `corpusRevision`, and does **not** print today's text.
- **T24. `policyRevision: null` on the live-parse path**, and old records without the field read
  back unchanged.

### Runtime loading

- **T25. A hash mismatch is refused and falls back to the corpus**, and the fallback still denies a
  red-clause call — asserting the tamper path is fail-closed, not fail-open.
- **T26. A routing-triple mismatch is refused** (an artifact compiled for another team never
  governs this session).
- **T27. `schemaVersion` from the future is refused, not partially read.**

### Selection and bounding

- **T28. Matching is never budgeted.** With 200 accepted clauses, the 200th (a red clause, last in
  every ordering) still denies its call.
- **T29. The knowledge block respects the budget.** With 200 accepted clauses, core ≤ 8 KB,
  selected ≤ 4 KB, and every clause whose pattern matched the pending action is present.
- **T30. The subset line is always emitted** and its counts match the rendered block.
- **T30a. Overflow drops whole clauses.** With selected clauses totalling > 4 KB, every rendered
  clause is byte-identical to its compiled `body` (no truncation anywhere in the block), the dropped
  ones are absent entirely, and the subset line's counts match.
- **T31. Selection is deterministic.** Same input → identical block across 100 runs and across
  shuffles of the clause array.
- **T32. Zero-breakage render.** For each existing test fixture corpus, with no `learned/` and no
  artifact, the rendered knowledge block is byte-identical to today's `renderKnowledge` output.

### The write boundary

- **T34. The pipeline cannot write outside `learned/`.** `assertWritable` rejects, one case each:
  a `bottom-line.md` target, a filename ≠ `<id>.md`, a `..` traversal, a `learned/` that is a
  symlink to a directory outside the corpus root, and a corpus root other than the configured one.
  Each asserts the run wrote **nothing** and exited non-zero — not that it wrote a subset.
- **T35. `learnedClausePath` is the only path producer.** A test greps the pipeline's own sources
  for filesystem write calls (`writeFile`, `appendFile`, `rename`, `rm`, `mkdir`) and asserts every
  target expression routes through `learnedClausePath`. Crude, and it is the only thing that stops
  the invariant decaying the first time somebody adds a second writer.
- **T36. A hand-written file under `learned/` is harmless and lower-precedence.** It loads with
  `origin: 'learned'`, loses to a contradicting `bottom-line.md` clause, and produces exactly one
  `info` finding from `lint`.

### Extraction gate (the fixture lesson)

- **T33. The validation gate does not trust its own fixtures.** Per the ADDENDUM: the corpus masking
  bug survived 35 passing tests because every fixture was underscore-free. So the compile's
  secret-scan over `data/knowledge/**` (closing `01` §1.3 scope gap 1 — a credential pasted into a
  knowledge file is committed unmasked *and* injected into every prompt) is tested with
  realistic base64url fixtures containing `_` and `-`, and the test asserts the *scanner's* rule
  table, not just one example per rule.

---

## 11. Things I could not verify

1. **`node:sqlite` FTS5.** Taken from `02`'s live check on this box; I did not re-run it. It appears
   in this spec only as a named upgrade path (§6.4), never as a v1 dependency, so the design does
   not rest on it.
2. **Auto memory's storage layout** and the claim that memory content is not echoed into the
   session JSONL (§7.4). Documented, not observed — deliberately, per the privacy rule.
3. ~~**The test count.**~~ **Settled: 1,139 in 56 files**, a clean vitest run on `10ff422`. Not
   1,146 (that worktree already contained PR #40's 7 tests) and not my 851 / 1,152 (greps of
   `it(`/`test(` call sites, a different metric). PR #42 took the baseline to 1,240. §1.3 and §8
   cite 1,139.
4. ~~**PR #37's cache breakpoint placement.**~~ **Verified, caveat withdrawn.**
   `src/supervisor/fastClassifier.ts` builds `system` as `[rubric, knowledge]`
   with `cache_control` on the **last system block** (line 260), and the judging instruction rides a
   **trailing user turn** because Anthropic has no trailing-system channel, so nothing after that
   breakpoint is cached (lines 21-22). §6.2's split is not merely compatible with that structure —
   it is what the structure already affords: `prompt_core` in the cached `system` knowledge block,
   per-call selection on the uncached trailing turn.
5. **The -24-point figure** (16 irrelevant instructions cost 24 percentage points of compliance with
   rules already present). `05` flags it as appearing only in a secondary Substack write-up, not in
   arXiv:2608.11095's abstract. I use it as *motivation* for §6.6's count ceiling, never as the
   number that sets it — the ceiling's value is des-validate's, and it should be set from the primary
   results (+226%/+4.9 per commit, 68% at 500) plus our own replay, not from a figure with one
   source.
6. **des-validate's ablation contract.** §4.4 specifies the schema slot (`retired_by` +
   `retired_reason: ablation`) and assumes des-validate can resolve an opaque run id to the replay
   that justified a retirement. I have not seen their design, so the id's format and where the runs
   are stored are theirs to define; if they need more than one opaque string, that is a one-field
   amendment here, not a redesign.
7. **Whether the 80-character rationale floor is the right floor.** It is a guess at "not empty, not
   a restated title", marked `ponytail:` with its upgrade path (a title-similarity check). Worth
   re-measuring against the first real batch of proposals rather than defending.
8. **Whether `policy explain` should also resolve the classifier path's clause citations.**
   `SupervisionRecord.assessment.issues[].relevant_knowledge` already carries `scope`, `entry`,
   `source_file`, `provenance` and `confidence` (`models.ts:87-93`) — a *model-authored* citation,
   which is exactly the thing a compiled artifact makes verifiable. Resolving those against the
   stamped revision would let us measure how often the model cites a clause that was not in front
   of it. Out of scope here; worth its own decision.
