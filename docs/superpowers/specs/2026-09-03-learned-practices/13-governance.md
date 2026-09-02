# 13 — Governance and review UX

How a human being reviews, accepts, declines and owns learned knowledge.

Scope: the *human/process half*. The schema and precedence half is `des-schema`; the extraction and
replay half is `des-pipeline` / `des-validate`. This spec defines the review plane, the noise
budget, ownership, three profile walkthroughs, degradation, the lifecycle, and the anti-patterns.

Status of every `gh` dependency below: **optional**. Each `gh` step names its no-`gh` equivalent
inline. Nothing in the default path requires GitHub, an account, a network, or Python.

---

## 0. The one-paragraph shape

Proposals are **files on the machine that mined them**. Accepted clauses are **markdown in a git
repo**. Declines are **an append-only ledger file**. Every other surface — a GitHub dashboard issue,
a PR, a GitLab MR, the local dashboard server — is a *projection* of those files and can be deleted
and rebuilt from them. The direction of authority is always file → surface. No surface is ever read
back as state, with exactly one exception: a human gesture on a surface (ticking a checkbox, closing
a PR) is a *trigger* that invokes the CLI, which writes the file. Miss the trigger and nothing is
lost — the proposal simply stays queued.

---

## 1. The review plane, tiered

### 1.1 DEFAULT (Node + git, nothing else) — the primary path

Three artifacts, all local, all plain files:

```
<dataDir>/                                  # ~/.claude/session-sitter, or $CLAUDE_PLUGIN_DATA
├── decisions.jsonl                         # exists today (src/hooks/paths.ts:decisionsPath)
├── proposals/
│   ├── p-20260901-3f9a1c2b.md              # one proposal = one file = the whole report
│   ├── p-20260901-7c04ee81.md
│   └── state.jsonl                         # append-only: proposed|accepted|declined|reopened
└── corpus/                                 # created by `init` ONLY when the user has no corpus repo
    └── data/knowledge/users/<slug>/bottom-line.md
```

`<dataDir>/corpus` is a real `git init` repo with no remote. That is the whole trick for the solo
dev: **the "corpus repo" a solo dev never configured is a local git repo in the data dir**, and
`sessionSitter.dataRepoPath` points at it. The existing knowledge loader
(`src/supervisor/knowledge.ts`) works unchanged, and the solo dev gets a full git audit trail of
every accepted clause without a GitHub account, a remote, or knowing that git is involved.

Commands (the full surface — nothing else is needed for the default path):

| Command | Does |
|---|---|
| `proposals list [--all] [--tier T]` | the queue. `--all` includes declined and accepted. |
| `proposals show <id>` | print the proposal file: clause, replay report, motivating decisions. |
| `proposals accept <id> [--audit\|--escalate\|--now] [--tier user\|project\|team]` | write the clause, git-commit it. `--audit` (default for widening) matches and logs but decides nothing; `--escalate` is narrowing-only. §7.1 |
| `proposals decline <id> [--reason "…"] [--scope local\|shared]` | append to the decline ledger. Permanent. |
| `proposals promote <id>` | audit → intended level, after live evidence. Refuses on a disagreement. |
| `proposals retire <clauseId> [--reason "…"]` | `status: retired`, `retired_reason: manual`, keep the clause for provenance. |
| `proposals reopen <fp>` | undo a decline. The only way a declined fingerprint comes back. |
| `policy block '<pattern>'` / `policy revoke <clauseId>` | the emergency brake — deny-only, reaches sessions already running. §7.3 |
| `policy revoke --list\|--clear\|--check` / `policy sync --now` | list, release (widening bar), validate the file, force a refresh. |

Exit codes: `0` did it, `1` nothing to do (empty queue, unknown id), `2` usage, `3` **refused** —
a precedence conflict or a missing authority. `3` is the one a script must handle.

`session-sitter proposals list` **is** the dashboard on this tier. There is no second view to build.

### 1.2 TIER 1 — add `gh`

Enabled by `sessionSitter.review.surface: "github"` plus a repo. Adds three projections and **no new
state**:

1. **One long-lived dashboard issue** in the corpus repo, checkbox per queued candidate, a
   `Declined` section, rewritten in full on every sync (§3.2). `gh issue edit <n> --body-file -`.
2. **One PR per accepted candidate**, opened only after a human asks (§3.3). Body = the proposal file
   verbatim. `gh pr create --body-file`.
3. **CODEOWNERS + required review** on the knowledge paths (§4).

Sync is one command, idempotent, safe to run on a cron: `session-sitter proposals sync`. It reads the
files, renders the issue body, and PUTs it. If `gh` is absent or unauthenticated it prints one line
(`gh not available — queue is at \`session-sitter proposals list\``) and exits `0`. Never an error:
the default path is not degraded by the absence of the optional tier.

**Every tier-1 gesture has a no-`gh` equivalent, and the gh gesture is implemented *as* the CLI
call**, not beside it:

| GitHub gesture | What actually happens | No-`gh` equivalent |
|---|---|---|
| tick a checkbox on the dashboard issue | a workflow runs `proposals pr <id>` | `proposals accept <id>` |
| merge the PR | the branch already contains the clause; merge lands it | `accept` commits locally |
| close the PR unmerged | a workflow runs `proposals decline <id> --reason "PR #N closed"` | `proposals decline <id>` |
| tick an item in the `Declined` section | a workflow runs `proposals reopen <fp>` | `proposals reopen <fp>` |
| a `/propose` comment on the issue | `proposals share`+`pr` for a hand-written candidate | `proposals new` from a template |

If the checkbox workflow never runs (no Actions minutes, disabled workflow, the 60-day public-repo
disable), the queue is still correct — the item stays ticked-and-pending, and the next `sync`
re-renders it as pending. The failure mode of the optional tier is *staleness*, never *wrong state*.

---

## 2. Where proposals live, and where PRs go

The corpus repo (sessions **and** knowledge) is deliberately **private and separate** from the code
repo (`docs/CORPUS.md`: "Keep the corpus repository private and separate from this one"). Three
consequences, each of which changed the design:

**(a) A PR against knowledge is a PR against the corpus repo.** Not the project. So the reviewers
are the corpus repo's CODEOWNERS, the CI that lints the clause runs in the corpus repo, and the
dashboard issue lives in the corpus repo. A team that has a private corpus repo already has
everything; a team that does not has nowhere for a PR to go, which is why the default path does not
use PRs at all.

**(b) Proposals must NOT go in the corpus repo by default.** A proposal body quotes command lines
straight out of `decisions.jsonl` — unmasked, machine-local, and possibly containing a path, a host,
or a pasted secret. The corpus repo's masking (`src/corpus/mask.ts`) runs on *import*, and a
proposal is not an import. So: **proposals are machine-local until a human explicitly shares them**,
and `proposals share <id>` runs the existing masker over the proposal body before it writes
`data/proposals/<id>.md` in the corpus repo. Sharing is the only path from local to git for a
proposal, and it is never automatic.

**(c) Accepted clauses always land in the same layout, whether or not a corpus repo exists:**

```
<corpus root>/data/knowledge/
├── teams/<slug>/bottom-line.md         + declined.jsonl
├── projects/<slug>/bottom-line.md      + declined.jsonl
└── users/<slug>/bottom-line.md         + declined.jsonl
```

`<corpus root>` is `sessionSitter.dataRepoPath` when set, else `<dataDir>/corpus` (auto-created).
That single fallback is what makes the solo-dev and team-lead cases the *same* code path. The
declined ledger sits next to the knowledge file it would have modified — **a decline is recorded at
the tier of the clause it would have created**, so a team decline is shared and reviewable and a user
decline is private, with no new concept.

`data/proposals/` in the corpus repo is for *shared* proposals only, is never read by the runtime,
and carries no CODEOWNERS entry (a proposal is not policy).

---

## 3. Noise management — the make-or-break

### 3.1 The budget, and a sanity-check of the research numbers

Renovate's shipped defaults are `prHourlyLimit: 2`, `prConcurrentLimit: 10`. Taking them literally is
wrong in one dimension and right in the other:

- **`prHourlyLimit: 2` does not transfer as written.** It throttles a *continuous* stream — Renovate
  wakes repeatedly, on many repos, against hundreds of dependencies that change on the registry's
  schedule, not the user's. Our miner is a **batch** over one machine's decision log and runs at most
  once a day. An hourly rate limit on a daily batch is a no-op. The transferable form is a
  **per-run cap**.
- **`prConcurrentLimit: 10` transfers exactly.** It is not a bot-throughput number, it is a
  *human-attention* number: how many open things a person will actually triage before they start
  ignoring the whole surface. That is the same constant for dependency bumps and policy clauses.

So the budget is:

| Limit | Default | Why |
|---|---|---|
| new proposals per run | **5** | one sitting's worth of review. |
| open proposals in the queue | **10** | Renovate's concurrent number, adopted verbatim. |
| mining runs | **1 / 24h** | matches the cadence of the KV-cache constraint (brief §2). |
| PRs opened per hour (gh tier only) | **2** | here Renovate's number *does* apply: ticking 8 checkboxes at once must not fire 8 PRs. |
| open PRs (gh tier only) | **10** | mirrors the queue cap. |

**When the queue is full, mining stops — it does not spill.** No backlog file, no "pending
candidates" count, no second queue. Candidates are cheap and fully re-derivable from
`decisions.jsonl`, so a dropped candidate is not lost information, it is information we will re-derive
tomorrow when there is room. A persisted unbounded backlog is a second source of truth and a
guaranteed staleness bug.

`list` therefore ends with one line and no visualisation:

```
10 of 10 open — mining paused. Accept or decline to make room.
```

### 3.2 Grouping — the primary lever

Renovate's own noise-reduction docs put grouping first, and it is the biggest single win here because
mined candidates are naturally near-duplicates: six `Read(src/**)` variants are not six policy
decisions, they are one.

Group candidates into a single proposal when **all** hold:
- same tier, same level, same `direction` (§4.3);
- same tool;
- the replay report differs only in which records matched — same reversal count (0), same verdict
  transition.

The grouped proposal carries N `Match:` patterns on one clause and one replay report over the union.
It is accepted or declined as a unit. **There is no partial acceptance** — see §8. If a reviewer wants
four of the six patterns, the gesture is `decline` with a reason and hand-edit the clause, or
`accept --patterns 1,2,4,5`, which is an *accept of a strict subset* and produces a **new
fingerprint** (so the original is not silently marked accepted). Subset-accept is the one
concession, and it exists because it is a CLI flag over a list, not a review-comment parser.

Naming a group is the human-facing part: `Read under src/** when the supervisor is green (6
patterns)`.

### 3.3 Ask-before-PR is the default, not an option

`sessionSitter.review.askBeforePr: true` by default — Renovate's `dependencyDashboardApproval: true`,
inverted from their default because our artifact is a *policy change* and theirs is a version bump.
Nothing becomes a PR, and nothing becomes a commit, until a human names the proposal.

The one bypass, copied from Renovate's vulnerability-remediation carve-out: a proposal whose
`direction` is **narrow** may open its PR immediately, because withholding a tightening is the
failure mode that costs something. A **widening** proposal never bypasses the queue, at any tier,
under any config. There is no setting to change that; the asymmetry is the safety property.

### 3.4 Scheduling

Default cron host: whatever the OS already has, or nothing at all. Order of preference:

1. **Staleness check on CLI invocation** — the default. If `decisions.jsonl` has grown and the last
   run is >24h old, `list` mines first and says so. Zero configuration, zero daemons, works
   air-gapped, and the user is by definition present to read the result.
2. `launchd` (macOS) / `systemd --user` timer (Linux), emitted by `session-sitter schedule --install`.
3. GitHub Actions `schedule`, tier 1 only.

Two shipped-template rules from the research, both non-negotiable in our workflow file:
- **never `0 * * * *` or `0 3 * * *`** — GitHub explicitly names the top of the hour as a high-load
  window. Our template uses `37 4 * * *`.
- the template carries a comment stating the **public-repo 60-day disable** and its reset (any commit,
  or one `workflow_dispatch` run). Private org repos are not documented as subject to it; we say that
  precisely, and do not claim more.

### 3.5 What "decline" means, permanently

A decline is keyed on the **fingerprint**, not the proposal id, not the prose:

```
fp = sha1(tier + '|' + level + '|' + direction + '|' + sorted(normalisedPatterns).join(',')).slice(0,8)
```

(Same `id8`-by-hash discipline as the corpus: a hash, not a slice of anything that shares prefixes.)
Deliberately **excludes the prose**, so a re-mined, re-worded, semantically identical candidate is
still suppressed. Deliberately **includes the patterns**, so a candidate that *widens* the match set
is a different rule and is legitimately offered again.

A decline is permanent until an explicit `proposals reopen <fp>`. `list` shows declines only under
`--all`; the dashboard issue shows them in a collapsed `Declined` section with an unticked checkbox
to reopen — Renovate's undo gesture, projected.

**Why closing a PR must NOT be the source of truth.** Five reasons, in descending order of how badly
it breaks:

1. **The default path has no PRs.** A solo dev with a local corpus and no GitHub account would have
   no way to decline anything. The primary path cannot depend on the optional tier.
2. **The GitLab path becomes a rewrite** rather than a second renderer of the same files.
3. **The miner runs offline.** Deciding whether to re-propose a candidate at 04:37 must not require a
   network call, an auth token, or a rate-limited API that is down.
4. **PR-closed is a lossy signal.** PRs get closed for staleness, a bad rebase, a wrong base branch,
   a superseding PR, or repo cleanup. None of those mean "this rule is wrong forever", and none are
   distinguishable from a real decline.
5. **The corpus repo may not be on GitHub at all** even when the code repo is. Two hosts, one policy.

So the ledger is `data/knowledge/<tier>/<slug>/declined.jsonl`, append-only, one JSON object per
line, git-tracked (which gives us who and when for free):

```json
{"fp":"7c04ee81","proposal":"p-20260901-7c04ee81","at":"2026-09-01T14:22:11Z","by":"alice","reason":"we want this prompt to keep firing — it is the last gate before a prod deploy","surface":"pr#412 closed"}
```

`surface` is provenance, not authority. Closing PR #412 *causes* this line to be written by a
workflow calling `proposals decline`; if the workflow fails, the line is absent and the proposal
stays open — visibly, in the queue. The system's worst case is asking again, never silently
forgetting a human's "no".

---

## 4. Ownership and authority

Today: "ownership is push access to a markdown file and nothing else — no CODEOWNERS convention, no
review requirement, no schema validation in CI, no linter" (brief §6). All four are addressed here.

### 4.1 CODEOWNERS, per tier

Shipped as `knowledge/CODEOWNERS.example` and installed into the corpus repo by
`session-sitter init --team`:

```
# <corpus repo>/.github/CODEOWNERS
# A team clause binds people who did not write it. Highest bar.
/data/knowledge/teams/            @acme/policy-owners @acme/security
# A project clause binds one repo's contributors.
/data/knowledge/projects/         @acme/tech-leads
# A user clause binds only its author. Owned by that author, per-directory.
/data/knowledge/users/alice/      @alice
/data/knowledge/users/bob/        @bob
# Proposals and sessions are evidence, not policy. Deliberately unowned.
/data/proposals/
/data/sessions/
```

The tier asymmetry is the point: a **team** clause needs approval from people who will be bound by it
and did not write it (two owning groups → two approvals under "require review from Code Owners"); a
**user** clause needs its author and nobody else, because it cannot bind anyone else.

Branch protection on the corpus repo default branch: require a PR, require review from Code Owners,
require the `policy-check` status, and **do not** enable auto-merge on any knowledge path.

**No-`gh`/no-GitHub equivalent:** CODEOWNERS is inert without a forge. The local substitute is a
commit trailer written by `accept`, plus a `policy check` run in whatever CI the corpus repo has (it
is a plain `node out/policy/cli.js check`, no forge required):

```
Accepted-proposal: p-20260901-3f9a1c2b
Accepted-by: alice <alice@acme.example>
Approved-by: bob <bob@acme.example>
Replay: 500 records, 23 changed, 0 reversed
```

State plainly in the docs: locally, `Approved-by` is an **honour-system trailer**, not enforced
authority. It makes an unreviewed widening *visible in git log* and greppable in CI; it does not
prevent one. Enforcement needs a forge, and we do not pretend otherwise.

### 4.2 What stops a user clause overriding a team red

The schema half is `des-schema`'s (precedence at classification, every tier's entries reaching the
classifier tagged — `knowledge.ts` already refuses to resolve conflicts at load time so a team red
cannot be silently dropped). The human/process half is three gates, cheapest first:

0. **Rationale is a hard gate, not a warning.** `des-schema` §2.5 makes non-empty body prose
   (≥80 chars) a compile error for anything under `learned/`, per arXiv:2608.11095 — once the why is
   gone, deletion costs O(2^|D|) and the corpus triples. So `accept` refuses a thin-bodied mined clause
   rather than writing it and linting it later: the miner must produce a reason a human can disagree
   with, or the candidate is not acceptable. `evidence` is conditional (required iff `learned_from` is
   non-empty), so a hand-parked clause carries rationale and no `evidence` — nothing in this document's
   templates writes `evidence`, and nothing should start.

1. **Accept-time refusal.** `proposals accept` runs the candidate's raw patterns against every
   **red or orange clause from a broader tier** using the *existing* clause matchers. On any
   intersection it refuses, exits `3`, and names the conflict:

```
$ session-sitter proposals accept p-20260901-4d1e0aa9 --tier user
refused: this user clause would license calls a broader clause forbids.

  candidate  green  user   Match: `git push --force-with-lease`
  conflicts  red    team   practices §team-git-002: never force-push to a shared branch
             matched by pattern `git push --force`

A narrower tier does not override a broader red clause — the team clause still reaches the
classifier and will still deny. To change this, propose a change to §team-git-002:

  session-sitter proposals new --supersede team-git-002 --tier team

exit 3
```

   This is a real refusal, not a warning: an accept that produced a clause guaranteed to be
   overruled at runtime would teach the user the tiers do not work.

2. **CI lint.** `policy check` fails on the same intersection, so it cannot land by hand-editing the
   file either. Forge-independent — it is the CLI already in the repo.

3. **CODEOWNERS.** Editing `teams/**` to remove the red clause requires the owning groups. The path a
   user *can* take is the legitimate one: propose a change to the team clause and let its owners
   decide.

### 4.3 Widening vs narrowing — different bars

Every proposal carries a computed `direction`:

| direction | Means | Examples |
|---|---|---|
| **narrow** | strictly fewer calls proceed unprompted | add a red/orange clause; raise a level; shrink a pattern |
| **widen** | strictly more calls proceed unprompted | add a green clause; lower a level; broaden a pattern |
| **neutral** | prose only, no `Match:` line | a Belief that informs the classifier and can never decide |

The bar:

| | user tier | project tier | team tier |
|---|---|---|---|
| **narrow** | self-accept | 1 owner approval | 1 owner approval; may bypass the ask-queue |
| **widen** | self-accept, **audit-first is the default** | 1 owner + not the author | **2 owner approvals**, never auto-merge, audit-first mandatory |
| **revoke / block** (deny-only) | self-serve | 1 approver, may merge before review | 1 approver, may merge before review (§7.3) |
| **disarm a red/orange** | self-serve | 1 owner + not the author | 2 owner approvals — same as a widening, because it is one |
| **neutral** | self-accept | 1 owner approval | 1 owner approval |

A widening at user tier is self-accept because it is your own laptop and it cannot override a broader
red (§4.2). Everything that binds someone else needs someone else.

### 4.4 One config change outranks every clause: the rule destination

`SESSION_SITTER_RULE_DESTINATION` decides where a generalised permission rule is written.
`session` (the default) means in memory, gone at session end. A persistent destination
(`projectSettings`) means the rule is handed to Claude Code's permission set for good — and, per §7.3,
**an unrevocable widening**: once the harness holds the rule, we are never asked again and cannot take
it back.

So this one environment variable outranks every approval bar in the table above, and the governance
rule is short:

- **Flipping it to a persistent destination is itself a team-tier widening.** It takes the widening bar
  (2 owner approvals), it is recorded in the corpus repo rather than in someone's shell profile, and
  the PR body must carry the sentence *"rules written this way cannot be revoked; §7.3 can only print
  the `/permissions` lines to remove by hand."*
- **Accepting a green clause is a different decision when this is persistent**, because the clause can
  now mint rules that outlive it. `accept` prints that in the confirmation, and the replay report names
  the prefix rules the clause would license.
- **No profile in §5 turns it on**, and the solo-dev walkthrough must not — that profile is the least
  likely to read §7.3, so if a future version of the walkthrough enables `persistRules`, the
  revocation caveat goes in the walkthrough itself, next to the setting, not only here.
- If a proposal, a doc, or a future contributor argues for making a persistent destination the
  default: the argument against is this paragraph, and it should be cited rather than re-derived.

Enforcing a *content-dependent* approval count is the one thing CODEOWNERS cannot express — it is
path-based. So `policy-check` computes the direction from the diff and sets a second required status,
`policy/widening`, re-run on `pull_request_review`:

- direction narrow or neutral → passes immediately;
- direction widen → passes only when `gh pr view --json reviews` shows the required number of
  approving reviews from CODEOWNERS, and adds the label `widens-permissions` so the reviewer sees it
  before reading a line of the diff.

No-`gh` equivalent: `accept --tier team` on a widening requires `--approved-by <handle>` and refuses
when it equals the git author; the handle lands in the commit trailer. Honour-system, stated as such.

---

## 5. The three profiles

### 5.1 Solo dev — one laptop, no corpus repo, no GitHub

**Best-served profile.** Everything is default.

*Configures:* nothing. `session-sitter init` on first run.

```
$ session-sitter init
no corpus repo configured — created a local one, private to this machine:
  /Users/<you>/.claude/session-sitter/corpus   (git repo, no remote)
  data/knowledge/users/dev/bottom-line.md    (empty, ready for clauses)

set sessionSitter.dataRepoPath to /Users/<you>/.claude/session-sitter/corpus  ✓ (written to
  ~/.claude/settings.json is NOT done automatically — run with --write-settings, or set it yourself)

learning: on, proposals only. Nothing will change your policy without `proposals accept`.
mining: on first `proposals list` when >24h stale. No daemon installed.
```

*Sees, weekly:*

```
$ session-sitter proposals list
mined 1,284 new decisions (last run 6d ago) — 4 candidates, 3 after grouping and limits

ID                    DIR     TIER  LVL     TITLE                                          Δ/N
p-20260901-3f9a1c2b   widen   user  green   Read under src/** when supervisor is green      23/500
p-20260901-7c04ee81   widen   user  green   npm test and npm run test:* (4 patterns)        61/500
p-20260901-a51b7f30   narrow  user  orange  psql against *.prod.* — ask first               2/500

3 open of 10.  `show <id>` for the report, `accept <id>`, `decline <id>`.
```

*Does:* reads one report, accepts one clause.

```
$ session-sitter proposals show p-20260901-a51b7f30
```
```markdown
# psql against *.prod.* — ask first

| Field | Value |
|---|---|
| proposal | p-20260901-a51b7f30 |
| fingerprint | a51b7f30 |
| direction | narrow |
| tier | user |
| level | orange |
| tool | Bash |
| mined | 2026-09-01T04:37:02Z |
| from | 1,284 decisions, 2026-08-18 .. 2026-09-01 |

## The clause this would write

    ### Intention: Ask before running psql against a production host

    | Field | Value |
    |---|---|
    | id | user-db-004 |
    | level | orange |
    | confidence | low |
    | scope | user |
    | source | proposal p-20260901-a51b7f30 (2 decisions) |
    | tags | db, prod |
    | added | 2026-09-01 |

    Match: `/psql.*\.prod\./`

    Twice in two weeks a psql command reached a production host during ordinary work. Neither was
    intended. Ask first: an orange clause escalates with a countdown and denies on silence.

## Replay over 500 decisions (2026-08-18 .. 2026-09-01)

    would change      2  (0.4%)   ← 2 calls that ran silently would now escalate
    no change       498
    would REVERSE     0           ← no allow→deny or deny→allow beyond the intended change

    Coverage: matched 2 records in project `sitter`, 0 in project `scratch`.

## The decisions that motivated it

    1. 2026-08-22 14:03  Bash  psql -h db-1.prod.acme.example -c 'select count(*) …'
       decided: allow  by: rule (no clause matched — default)   record d-8f21ac04
    2. 2026-08-29 09:41  Bash  psql -h db-2.prod.acme.example -f ./scratch/backfill.sql
       decided: allow  by: rule (no clause matched — default)   record d-2b90ff17

## Why you are seeing this

    Both calls fell through with no clause matched. A call with no rule is a named gap in the
    policy, and the exact command that had no rule is the highest-signal input we have.
```
```
$ session-sitter proposals accept p-20260901-a51b7f30
direction narrow, tier user — no approval required.

wrote  data/knowledge/users/dev/bottom-line.md  (+18 lines, clause user-db-004)
lint   1 clause changed, 0 errors, 0 warnings
commit 4a1c9de  policy: accept user-db-004 (ask before psql on prod)

Live from the next session. This clause is orange: it escalates and denies on silence.
```

*Gets:* a policy file that grows from their own behaviour, a git log of why each clause exists, and a
prompt that stops firing for the four `npm test` shapes they approve every day.

**Honest weakness:** with one user and no team, the three tiers are overhead — they will only ever use
`users/dev/`. And the "review gate" is them reviewing their own machine's output: a diff review with
no second pair of eyes. The value delivered is *visibility and reversibility* ("I can see exactly what
changed and `retire` it"), not governance. We should not describe it as governance to this profile.

### 5.2 Team lead — private corpus repo, 6 engineers, wants review

*Configures:* once, in the corpus repo.

```
$ session-sitter init --team acme-platform --corpus git@github.com:acme/agent-corpus.git
cloned  /Users/<you>/work/agent-corpus
wrote   .github/CODEOWNERS          (teams→@acme/policy-owners @acme/security, projects→@acme/tech-leads)
wrote   .github/workflows/policy-check.yml   (node out/policy/cli.js check + direction gate)
wrote   .github/workflows/proposals.yml      (cron 37 4 * * *; issue-checkbox → CLI)
opened  issue #7 "Session Sitter — Policy Dashboard"

next: enable branch protection on main — require a PR, require review from Code Owners,
require the `policy-check` and `policy/widening` statuses. `gh api` command printed below.
```

Each engineer sets `dataRepoPath` to their clone and gets the solo flow **for their own user tier**.
Six machines, six local queues, one shared knowledge repo. The lead cannot see engineers' queues —
that is deliberate, because a queue contains unmasked command lines from their sessions. An engineer
promotes a candidate to the team's attention explicitly:

```
$ session-sitter proposals share p-20260901-7c04ee81 --tier project
masked  2 values (1 bearer token, 1 host) — see MASKING-REPORT.md
wrote   data/proposals/p-20260901-7c04ee81.md
commit  91be0c2  proposals: share p-20260901-7c04ee81 (npm test, 4 patterns)
pushed  main
synced  issue #7 — now listed under "Shared, awaiting approval"
```

Masking before sharing is mandatory and reuses `src/corpus/mask.ts`. A `share` that cannot mask
(masker error) refuses; it does not share unmasked.

*Sees, weekly:* one issue (§3.2 template below), and 0–2 PRs. Ticks the checkboxes for the two
candidates worth having; the workflow opens the PRs; CODEOWNERS routes the team-tier one to
`@acme/security` and labels it `widens-permissions`; the lead reviews the replay report in the PR
body, which now aggregates across machines:

```
Coverage across shared machines:
  alice   would change 61 / 500   (12.2%)
  bob     would change  4 / 500   ( 0.8%)
  carol   would change  0 / 312   ← this rule never fires in carol's work
```

That last line is the §4.2-of-the-research signal doing real work: a rule that never fires for a
third of the team is a rule that team should probably not be asked to approve at project tier.

*Does weekly:* triage one issue, review ≤2 PRs, merge or close. Closing writes the shared decline
ledger via the workflow, so nobody on the team is re-asked.

*Gets:* the #2 unclaimed differentiator, delivered — **learned rules in git under code review**, with
per-path authority, a replay report as the review artifact, and a decline that is a reviewable commit
rather than a closed tab. Auto memory is machine-local; Cursor team rules are dashboard-managed;
neither can be diffed, blamed, or reverted.

**Honest weakness:** the six queues are invisible to the lead until shared, so team-wide patterns
(all six engineers hitting the same gap) are only visible if all six share. A `proposals share --auto`
for candidates above a hit threshold is the obvious next lever and is **out of scope here** — it is a
privacy decision, not a UX one, and it needs the masker to be trusted more than it currently is.

### 5.3 Org manager — many teams, wants distribution, audit, and mandate

*Configures:* one corpus repo per team (or one repo with many `teams/<slug>/` directories — preferred,
because CODEOWNERS and the dashboard issue are per-repo), plus IT-distributed managed settings pinning
`sessionSitter.dataRepoPath`.

*Sees:* `session-sitter dashboard` (a `node:http` server, zero deps, reusing `src/webview/` assets)
serving one page: clauses per tier, accepted/declined counts per month, and the git log of
`data/knowledge/`. Plus, for free, everything a git host already gives them: blame, history, required
reviews, protected branches, and an audit trail of who approved which widening and when.

*Does:* sets the CODEOWNERS policy for `teams/**` once, reviews the widening PRs that reach
`@acme/security`, and reads the monthly rollup.

*Gets:* **distribution** (a git repo many machines read) and **audit** (git history plus
`decisions.jsonl` per machine).

**Badly served — say this out loud in the docs.** What this profile actually wants is **mandate**, and
this layer cannot deliver it:

- The knowledge path is a **user setting**. A developer can unset `dataRepoPath`, point it at a fork,
  or delete the local clone, and the team tier silently vanishes — a missing tier is "skipped, not an
  error" by design (`knowledge.ts`), which is right for availability and terrible for mandate.
- Claude Code's classifier **deliberately refuses to read project settings**, so we cannot ship an
  enforced repo-resident policy through that channel, and we should not try to route around a
  security decision.
- **Revocation is best-effort, not a kill switch.** §7.3 is a real out-of-band brake and a genuine
  improvement over the earlier draft's "there is no revocation" — but the runtime reads a *local*
  mirror, so the brake reaches a machine only when that machine pulls the corpus repo. A laptop that
  is offline, or pointed at a fork, does not get the brake either. Same drift, same honest answer.
  `des-runtime` says this plainly on its side too, which is worth more than either of us claiming it
  is solved. The one lever available: the revocation file has a stable schema and holds no secrets, so
  an MDM fleet could push `<dataDir>/policy/revocations.jsonl` directly — a **deployment story for an
  org that already has MDM**, not a feature we ship, and it inherits every limitation of the MDM.
- No cross-team rollup without cloning every corpus repo. There is no server, on purpose.

Available mitigations, honestly bounded: IT-distributed **managed settings and managed CLAUDE.md**
(first-party, already exists) can pin the path on a managed fleet; `session-sitter doctor` reports
`team tier: not loaded` loudly; and the decision record shows which tiers informed each decision, so
*drift is detectable after the fact*. Detection is not prevention.

**The honest sentence for the docs:** *this is advisory governance with a real audit trail, not
enforced policy. If you need enforced policy, you need MDM, and you need it above this layer.*

---

## 6. Degradation and escape hatches

| Situation | What happens |
|---|---|
| **No GitHub** | The default path. Files + CLI. Nothing is missing; `sync` is a no-op that says so. |
| **GitLab** | Same files, `glab` instead of `gh`: one long-lived issue, MRs, and CODEOWNERS (GitLab has its own). `sync` dispatches on `review.surface: gitlab`. The projection is the only thing that differs — ~40 lines. |
| **No corpus repo** | `<dataDir>/corpus`, auto-`git init`, no remote. §2(c). |
| **Air-gapped** | Already the default. Nothing phones home; the only network paths are the optional `gh`/`glab` tier and the optional `KNOWLEDGE_REPO` shallow clone. Both absent → full function. |
| **No git at all** | `accept` writes the file and prints `git not found — clause written, not committed. You have no history of this change.` Degrades to a warning, never a refusal. |
| **Learning off, supervision on** | `sessionSitter.learn: "off"`. The miner never runs; `proposals list` says so. **Decision recording stays on**, because it is what makes turning learning on later useful — and because the audit record is a product feature, not a learning input. |
| **Proposals but never automatic anything** | The default already: no cron installed, mining only on explicit `list`, `askBeforePr: true`, no auto-merge, `--audit` default for widening (and audit decides nothing — §7.1). Belt-and-braces: `sessionSitter.learn: "manual"` also disables the staleness trigger, so mining happens only on `proposals mine`. |
| **Wants it all off** | `learn: "off"` + delete `<dataDir>/proposals/`. Accepted clauses are ordinary markdown and keep working; nothing in the runtime depends on the pipeline existing. |
| **Two learning systems** (auto memory is also writing) | Not a conflict to resolve here, but a rule to state: we mine `decisions.jsonl` (ours) and archived session envelopes; we **never read or write `~/.claude/projects/*/memory/`**. Auto memory owns machine-local preferences; we own the reviewable governance artifact. The one visible overlap — a preference captured in both — is acceptable duplication, and the docs say which one is authoritative for a *decision* (ours, because it is cited). |

---

## 7. The lifecycle a human sees

```
proposed ──accept──▶ audit ──promote──▶ accepted ──┬── supersedes ──▶ (new clause, old kept)
   │        (default for widening)   │             └── retire ──────▶ expired (kept, not trusted)
   │                                 │
   └──decline──▶ declined ──reopen──▶ proposed
                                     │
                            (contradicted in audit: `retire` before promote)
```

### 7.1 Audit mode means the clause does not act

**Corrected from an earlier draft of this spec, which encoded audit as "accept at orange". That was
wrong, and wrong in the direction that breaks the product's headline scenario.** Orange means
*escalate to a human with a countdown and **deny on silence***. Orange **acts**. Recording it as
audit made two errors:

1. **It breaks unattended runs, specifically for the proposals trying to help.** A *widening*
   candidate — a clause whose entire purpose is to let more work proceed — would, in "audit" mode,
   block and escalate. At 03:00 there is nobody to escalate to, the countdown expires, and the call
   is **denied**. So the cost is not "more prompts for two weeks", as that draft claimed; it is
   "your overnight run stops on a call the candidate was proposing to permit."
2. **It contaminates the evidence.** Orange changes the outcome, so what gets collected is *how
   humans respond to escalations*, not *whether the clause would have decided correctly*. `promote`
   would then flip to the intended level on evidence that never tested the intended behaviour. The
   replay report is trustworthy precisely because it does not alter history; audit mode must have
   the same property on live traffic.

**Real audit mode**, Kyverno's `failureAction: Audit` (`04-observability.md` §4): the clause is
loaded, matched, and its **would-be verdict written into the decision record — and it contributes
nothing to the outcome.** The decision is made exactly as if the clause were absent. Safe in both
directions: a candidate red in audit lets the call proceed, which is the status quo and therefore
introduces no new risk; a candidate green in audit changes nothing either. A session in audit
behaves identically to one without the clause, and produces a log of what the clause *would* have
done on live traffic.

This inverts nothing about the defaults — it makes the existing one correct. `--audit` as the
default for widening was the worst possible default under the orange semantics and is the right one
under these.

**Audit is deterministic-only and never rendered into the prompt.** `des-runtime` moved `status:
audit` clauses out of the prompt when it took this change — a clause the model can read influences the
outcome, which is the opposite of audit. Two consequences worth having:

- **A trial is free.** Audit costs zero prompt tokens and cannot break the cached prefix, so a team
  can trial a clause across ten thousand real decisions at no cost. Promotion to `accepted` is what
  puts it in the prompt. This removes the only reason to rush a promotion.
- **A prose-only clause is unpromotable by evidence**, and the precise form is *inert in audit,
  advisory when accepted* — rendering requires `status: accepted`, so prose-only + `audit` is neither
  rendered nor matchable and does nothing at all, while prose-only + `accepted` is rendered and
  advisory, influencing the classifier but never deterministically deciding. So `accept --audit` on a
  prose-only clause exits `3` rather than accepting it into a trial that can never accumulate a hit:

```
$ session-sitter proposals accept p-20260901-c8d3 --audit
refused: this clause has no `Match:` line, so it can never produce an audit verdict.

Audit is deterministic — prose reaches the classifier but never decides on its own, so there is
nothing to measure and nothing to promote. Accept it directly:

  session-sitter proposals accept p-20260901-c8d3 --now
exit 3
```

**A passed `expires` on an audit clause changes nothing about enforcement.** It is a lint error and a dashboard
warning; the clause stays in audit until a human promotes or retires it. This matches
`des-runtime`'s expiry rule — a date may not change a clause's enforcement state, only a human act
may — and it is the right rule here for the same reason: a trial that silently ends by graduating
itself is a trial that proved nothing.

`promote` reads the audit hits out of the decision record and shows the human the same three numbers
the replay report shows, now from live traffic:

```
$ session-sitter proposals promote proj-test-011
audit window 2026-09-01 .. 2026-09-15 (14d), clause proj-test-011, 61 would-be hits

  would have matched      61
  agreed with outcome     61   ← the call was allowed anyway, by a human or the classifier
  would have DISAGREED     0   ← any hit where the clause's verdict differs from what happened

promoted: level orange → green, audit marker cleared
commit 7d2f1ab  policy: promote proj-test-011 to green after 14d audit (61/61 agreed)
```

A non-zero **disagreed** count is the whole reason audit exists, and it blocks promotion:

```
$ session-sitter proposals promote proj-test-011
  would have matched      61
  agreed with outcome     58
  would have DISAGREED     3   ← this clause would have allowed 3 calls a human denied

refused: 3 disagreements. Review them before promoting:
  session-sitter records show d-4c19aa02 d-9f0e3b71 d-1d88ce45
  session-sitter proposals promote proj-test-011 --accept-disagreements   (records them in the clause body)
  session-sitter proposals retire proj-test-011  (the audit did its job — drop it)
exit 3
```

**`--escalate` is the other mode, honestly named.** It is the old orange behaviour, kept because it
is genuinely useful — "ask a human first" is a real intermediate step between no rule and a hard
deny — and **restricted to narrowing proposals**, where escalating is a *weaker* action than the
clause's intended red. It is refused on a widening proposal, because there escalating is stronger
than the intended verdict and stronger than the status quo:

```
$ session-sitter proposals accept p-20260901-7c04ee81 --escalate
refused: --escalate is for narrowing proposals only.

This proposal WIDENS (green, 4 patterns). Accepting it at orange would block and escalate calls that
are allowed today, and deny them outright on an unattended run — the opposite of what it proposes.

  --audit   (default)  clause is matched and logged, decides nothing
  --now                clause takes effect at green immediately
exit 3
```

### 7.2 Audit costs no new field, and `expires` gets its consumer back

An earlier draft of this section asked `des-schema` for an `| audit | <date> |` field. It refused, and
correctly: `status: audit` already carries the mode, and `expires` already carries a validated ISO date
with an enforcement path, so the deadline goes there. A second date field would mean two answers to
*when does this stop* with only one of them enforced. **Audit therefore costs zero new schema.**

One field, two enforcement levels, keyed on `status`:

| `status` + past `expires` | Effect |
|---|---|
| `accepted` | the compile refuses to publish anything new. The clause keeps firing in the last good artifact — **expiry never removes a block**. |
| `audit` | **refuses to promote, never blocks the compile.** An audit clause contributes nothing to any outcome, so a forgotten trial must not stop a team publishing policy. |

That asymmetry is the right one and is worth stating as a rule, because it is the kind of thing a later
change gets backwards: **a lapsed trial is a governance problem; a lapsed live clause is a publishing
problem.** They deserve different blast radii.

Consequences on this side:

- **`accept --audit` requires an `expires`** and defaults it to 14 days out. This is the only moment
  anything knows a trial has started, so it is the only place that can set the deadline. A trial with
  no deadline is a trial nobody ends.
- **`promote` refuses a lapsed trial**, composing with the insufficient-evidence refusal it already
  has. Same two reviewed remedies as everywhere else: extend `expires`, or `retire` with
  `retired_reason: 'manual'` — the clause stays on disk and stays citable either way.
- **Templates render the deadline from `expires`.** No `audit_until` anywhere.

**And the `expires` claim is un-withdrawn, one message later.** Two messages ago I withdrew it: both
writers had gone, since audit had its own field and `retire` moved to `status: retired`. With the
deadline back on `expires`, `accept --audit` is its writer again. So the honest ledger, and this is the
third revision of it: **`supersedes` gets its consumer from `accept`, `expires` from `--audit`, and
`status`/`retired_reason` from `retire`.** Recorded as a correction rather than smoothed over, because
the churn is the useful part — `expires` was dead in the codebase for the same reason it kept slipping
here, which is that nobody owned the moment a clock starts. Now `accept --audit` does.

Expiry stays **asymmetric** at the runtime, unchanged by any of this: it prunes a clause from the
prompt and drops a yellow/green from evaluation, but **a red or orange with a past `expires` still
fires**, surfaced as a lint error and `expired_safety_clauses` on the record. A date silently disarming
a safety clause is an invisible failure; a stale red that still fires is at least loud. Which is why
`retire`, not a date, is what disarms one.

### 7.3 Revocation — stopping a clause in sessions already running

`des-runtime` pins the compiled policy revision per session at `SessionStart` so the prompt prefix
stays byte-identical and the KV cache survives — measured at ~$1.25 per session at 200k context, so
~$12.50 to invalidate ten running sessions. The consequence is stark and must be written down: **a
clause published at 02:00 reaches none of the sessions already running.** A team that adds a red
clause during an incident cannot, through the normal path, stop the ten agents already in flight.

**The honest promise, and it is two sentences, not one: `revoke` narrows future decisions. `block` is
the thing that stops a call now.** `updatedPermissions` is allow-only — there is no `removeRules` to
emit — so `revoke` cannot retract a permission rule we already persisted into Claude Code's settings.
Any copy that implies otherwise is the bug; see the blast-radius list and §4.4.

The escape hatch is a **deny-only channel read out of band** — outside the compiled artifact, so it
never invalidates the cache, and structurally incapable of widening. Settled with `des-runtime`:

| File | Written by | Scope |
|---|---|---|
| `<corpus root>/data/knowledge/revocations.jsonl` | `session-sitter policy block` / `policy revoke` | **the reviewable, distributed copy** — git-tracked, has a `reason`, has blame |
| `<dataDir>/policy/revocations-team.jsonl` | the refresher, mirroring the file above | the team, on this machine |
| `<dataDir>/policy/revocations.jsonl` | the CLI, locally | this machine only |

The runtime reads the two **local** files, never the corpus repo — with revision pinning the hot path
no longer clones at all, and putting a 1–5 s `git clone` in front of a human-visible prompt would cost
more than the incident. The two local files are **unioned with no precedence rule**, which is only
safe because the channel is deny-only: merging two deny-only lists cannot conflict and is
order-independent. That property is the entire reason this channel is allowed two writers.

Two entry shapes, and **no third**:

```jsonl
{"revoke":"proj-test-011","author":"lead","at":"2026-09-01T02:14:00Z","reason":"incident 4412 — test task shells out to deploy"}
{"block":["npm run deploy","/npm\s+run\s+deploy\b/i"],"id":"hotfix-4412","message":"deploys frozen — incident 4412","author":"lead","at":"2026-09-01T02:16:00Z","expires":"2026-09-08"}
```

Structural, not validated: a `block` has no `level` (so no green), no `fix` (so no rewrite — a rewrite
is an allow carrying `updatedInput`), and no paths/tier/weight (so no precedence shadowing). **Unknown
keys are ignored, and a line carrying neither `revoke` nor `block` is skipped for having no recognized
directive** — not because a forbidden word was spotted. That distinction is the correction that
matters: rejecting lines containing `allow` or `permit` is a blocklist, and a blocklist is a thing to
be gotten around (`"behavior":"a"+"llow"`, a nested object, a new key next quarter). An allowlist of
two directives cannot be gotten around. A parse failure can never grant, not because it is checked
but because the grammar has no way to express a grant.

**The restriction that shapes the whole section: `revoke` may only stop a clause that GRANTS.**
Green, yellow, and the correction/rewrite lane (allow-shaped, since it returns `updatedInput`).
Revoking a **red or orange is refused by the CLI and ignored by the runtime** (`revoke_refused` on the
decision record), because removing a block widens, and widening is the one thing this channel must not
do. Disarming a red is **this document's gate, not a file edit**: a reviewed diff setting
`status: retired` + `retired_reason: 'manual'`, through the normal PR path, at the §4.3 widening bar.

**Who may revoke, and why one approver is enough.** Revocation does not carry the widening bar:

| | user tier | project tier | team tier |
|---|---|---|---|
| **`policy block` / `policy revoke`** | self-serve, no approval | 1 approver, may merge before review completes | 1 approver, may merge before review completes |
| **disarm a red/orange** (`retired`/`manual`) | self-serve | 1 owner + not the author | **2 owner approvals** — the §4.3 widening bar |

Requiring two approvals to stop an incident is how incidents get worse. But state the reason
explicitly, because it is load-bearing: **the single approver is licensed by the fact that the channel
can only narrow.** It is not a judgement that emergencies deserve less review. Anyone who later
"improves" this into a general clause-injection channel must raise the bar in the same commit, and the
sentence above is there so they cannot claim the precedent.

The gesture is one command, and it does not go through the proposal queue:

```
$ session-sitter policy block 'npm run deploy' --message 'deploys frozen — incident 4412' --tier team
wrote   data/knowledge/revocations.jsonl  (+1 line, id hotfix-4412)
commit  b19f4c0  block: npm run deploy (incident 4412)
pushed  main

Effect  new sessions: immediate.
        running sessions, this machine: next permission request.
        running sessions, team, corpus is a local checkout: next decision.
        running sessions, team, corpus is a git URL: within 5 minutes (`policy sync --now` to
          collapse that to one clone).

Blocks are evaluated in `PreToolUse` as well as `PermissionRequest`, so this stops the call even
where Claude Code would have allowed it silently from its own permission set. `policy revoke` would
not have — that is why the incident gesture is `block`.

This is a brake, not a policy. It becomes a lint ERROR after 30 days:
  session-sitter proposals new --from-revocation hotfix-4412
```

```
$ session-sitter policy revoke proj-git-002
refused: proj-git-002 is level red. This channel can only stop a clause that GRANTS.

Removing a block widens what proceeds, and this file has no review, no CODEOWNERS, and no replay —
its only safety property is that it cannot widen. To disarm a red clause, take the reviewed path:

  session-sitter proposals new --retire proj-git-002 --tier team    (2 owner approvals)
exit 3
```

**Blast radius, stated honestly** — the numbers below are `des-runtime`'s, not my guesses (an earlier
draft of this section proposed a 60-second TTL, and it was wrong in both directions at once — there is
no TTL on the *read*, and on the refresh 60s is *worse* than the real answer at both ends: needlessly
slow against a local checkout, where the mtime check makes it free, and a great deal of git against a
URL, where each refresh is a 1–5 s shallow clone of a file that only changes during an incident):

- **New sessions:** immediate — they never compile the revoked clause in.
- **Local `policy block`:** the session's **next `PermissionRequest`**. The work is sub-millisecond;
  the wait is the agent's next tool call.
- **Team tier, corpus is a local checkout:** **next decision** — the mtime check is already on the hot
  path.
- **Team tier, corpus is a git URL:** **5 minutes** (the existing TTL, `knowledge.ts:371`) plus the
  next decision. `session-sitter policy sync --now` collapses it to one clone, 1–5 s.
- **There is no watcher and no push, and we are not adding one.** A session that never asks for
  permission again never sees the revocation — acceptable, because a session that never asks never
  does the thing we would have blocked. The second term of every window above is therefore unbounded.
- **No rollback.** If the clause allowed a `deploy` at 02:10 and you block at 02:14, the deploy
  happened.
- **`revoke` cannot recall a permission rule already written to a persistent destination.** The
  sharpest limit, and not a cache we can invalidate. `permissionRequest.ts:585-599` writes a standing
  `allow` into Claude Code's own settings, derived from the clause that allowed the call. Once that
  rule exists, the harness's own `permissions.allow` layer matches it and **the call never prompts** —
  `PermissionRequest` is never invoked, no verdict is computed, and `{"revoke": clauseId}` has nothing
  to act on. It fails **silently**, and precisely for the permissions most likely to need revoking:
  the ones a clause granted often enough to be worth persisting.
  - **The mitigation is `block`, not `revoke`.** `des-runtime` evaluates blocks in `PreToolUse`, which
    fires on every tool call whether or not a prompt happens, so a block stops the call even when the
    harness would have allowed it from its own settings. That is why every incident transcript in
    this section reaches for `policy block`.
  - **What `revoke` does instead:** `policy revoke <id>` prints the exact `/permissions` lines a human
    must remove, from the `<dataDir>/policy/granted.jsonl` ledger of rules we caused. `--retract`
    edits the settings file, and **only** with that flag — `generalise.ts` refuses to touch a
    git-tracked settings file behind someone's back on purpose, and revocation is not the excuse to
    start.
  - Bounded by two things that already exist: generalisation is opt-in, and its default destination is
    `session` — in memory, gone at session end. **That default is load-bearing, and this is why**
    (§4.4).
- **No verdict memoisation exists today** (verified across `permissionRequest.ts`, `session.ts`,
  `fastClassifier.ts`; the hook is a fresh process per invocation), so there is nothing to invalidate
  and the windows above are the whole story. Forward constraint, not a thing to build: **anyone adding
  a same-call memo must key it on the revocation files' mtime**, or a memo outlives a revoke inside a
  session.
- **A corrupt file loses the patch, not the policy:** one malformed line is skipped and logged and
  every other line still applies; a whole unreadable file is treated as empty with a loud
  `revoke_list_invalid` event, a red dashboard banner, and a non-zero exit from
  `session-sitter policy revoke --check`. Denying the world because an emergency patch has a typo is
  worse than losing the patch — the corpus is still the policy. Put `policy revoke --check` in the
  corpus repo's CI so a typo is caught before it is pushed to anyone.
- **Air-gapped / no shared corpus:** a local `policy block` works and reaches this machine only.

**Lifecycle of a revocation.** An emergency brake has to end, or it quietly becomes the policy — with
no review, no CODEOWNERS, and no replay behind it:

- `policy revoke --list` shows every live entry with its age.
- **A block older than 30 days is a lint ERROR in `policy check`.** Taking this from `des-runtime`, so
  there is one lint with one home rather than two that can disagree.
- The correct exit is a reviewed clause: `proposals new --from-revocation <id>` opens a normal
  proposal (narrowing, so it may bypass the ask-queue) that encodes the block as a real red clause
  through the normal review path, and removes the revocation line in the same commit on accept.
- `policy revoke --clear <id>` removes a line, and **carries the §4.3 widening bar at team tier**,
  because removing a block is the widening direction. Brake fast, release slow.

### 7.4 The dashboard issue (verbatim template, gh tier)

`gh issue edit 7 --body-file -`. Rewritten in full every sync; the checkbox state is read once at the
start of a sync and translated into CLI calls, then discarded.

~~~markdown
# Session Sitter — Policy Dashboard

This issue is the queue. Tick a box to ask for a PR; nothing here changes policy on its own.
Last synced 2026-09-01 04:37 UTC from 1,284 new decisions. Rebuild it any time: `session-sitter proposals sync`.

**Budget:** 3 of 10 open · 5 new per run · 2 PRs/hour · mining once per 24h.

## Awaiting your approval

Tick to open a PR. Untick before the next sync to change your mind.

- [ ] `p-20260901-3f9a1c2b` 🟢 **widen** · user · Read under `src/**` when supervisor is green — would change **23 / 500** (4.6%), **0 reversed** · [report](../blob/main/data/proposals/p-20260901-3f9a1c2b.md)
- [ ] `p-20260901-7c04ee81` 🟢 **widen** · project · `npm test` and `npm run test:*` (4 patterns) — would change **61 / 500** (12.2%), **0 reversed** · coverage: alice 61/500, bob 4/500, carol **0/312** · [report](../blob/main/data/proposals/p-20260901-7c04ee81.md)

## Open PRs

- #412 🟠 **narrow** · user · Ask before `psql` against `*.prod.*` — opened automatically (narrowing bypasses the queue)

## In audit — matched and logged, deciding nothing

These clauses are loaded but do not affect any decision. Promote when the log agrees.

- `proj-test-011` 🟢 `status: audit` since 2026-09-01, `expires` 2026-09-15 — **61 would-be hits, 61 agreed, 0 disagreed**. `session-sitter proposals promote proj-test-011`
- `proj-db-007` 🔴 `status: audit` since 2026-08-28, `expires` 2026-09-11 — **9 would-be hits, 7 agreed, 2 DISAGREED** — this clause would have denied 2 calls that were fine. Review before promoting.

## Revocations in force

- `hotfix-4412` 🔴 block `npm run deploy` — 2026-09-01 02:14 by @lead, *incident 4412*, **0 days old**. Deny-only; reached running sessions within 5 minutes. Exit path: `session-sitter proposals new --from-revocation hotfix-4412`
- `hotfix-3901` 🔴 block `terraform apply` — **34 days old — LINT ERROR.** A brake this old is undeclared policy. Promote it or clear it.

<details><summary>Declined (2) — tick to reopen</summary>

- [ ] `4d1e0aa9` 🟢 widen · user · `git push --force-with-lease` — declined 2026-08-19 by @alice: *conflicts with §team-git-002*
- [ ] `0c7a19bd` 🟢 widen · project · `docker run` (any) — declined 2026-08-21 by @lead: *far too broad; propose per-image instead*

</details>

<details><summary>Why some candidates are not here</summary>

Mining pauses when 10 proposals are open. Candidates are re-derived from the decision log on every
run, so nothing is lost by pausing — accept or decline to make room.

Declines are recorded in `data/knowledge/<tier>/<slug>/declined.jsonl`, not in this issue. Closing a
PR triggers a decline; the file is what the miner reads.

</details>
~~~

**No-`gh` equivalent:** `session-sitter proposals list` (§5.1) — the same five sections, plain text.

### 7.5 The PR body (verbatim template)

The body is the proposal file, unchanged, plus a four-line header. Deliberately: the artifact
reviewed is the artifact applied (Atlantis's lesson — the merge applies the branch that was reviewed,
it does not re-derive the clause).

~~~markdown
<!-- session-sitter: p-20260901-7c04ee81 fp=7c04ee81 direction=widen tier=project -->
### 🟢 WIDENS what proceeds without a prompt · project tier · 4 patterns · in audit until 2026-09-15

**Merging this makes more calls proceed unprompted.** Two approvals from `@acme/tech-leads` are
required (`policy/widening` status). Closing this PR records a permanent decline in
`data/knowledge/projects/sitter/declined.jsonl` — the file, not this PR, is the source of truth.

- proposal report: `data/proposals/p-20260901-7c04ee81.md` (in this repo, masked)
- accepted **in audit until 2026-09-15** (mandatory for a team/project widening): the clause is
  loaded and its would-be verdict logged, and it **decides nothing**. Merging this changes no
  outcome. Promotion to green is a second, separate PR, and is refused if the audit log shows a
  disagreement.

---

## The clause this adds

    ### Belief: Test commands are safe to run unattended

    | Field | Value |
    |---|---|
    | id | proj-test-011 |
    | level | green |
    | confidence | medium |
    | scope | project |
    | source | proposal p-20260901-7c04ee81 (61 decisions, 3 machines) |
    | tags | test, ci |
    | added | 2026-09-01 |
    | status | audit |
    | expires | 2026-09-15 |

    Match: `npm test`, `npm run test:unit`, `npm run test:e2e`, `npx vitest run`

    Running the test suite reads and writes only the working tree and the local cache. It was
    approved by hand 61 times in two weeks across three machines and denied zero times.

## Replay over 500 decisions (2026-08-18 .. 2026-09-01)

    would change     61  (12.2%)   ← 61 prompts answered by hand become automatic
    no change       439
    would REVERSE     0            ← no allow→deny or deny→allow

    Coverage:  alice 61/500 · bob 4/500 · carol 0/312  ← never fires in carol's work

## The decisions that motivated it (3 of 61)

    1. 2026-08-19 09:12  Bash  npm test              you: approved  → clause: allow   d-1a2b3c4d
    2. 2026-08-19 15:47  Bash  npm run test:unit     you: approved  → clause: allow   d-5e6f7a8b
    3. 2026-08-26 11:02  Bash  npx vitest run src/   you: approved  → clause: allow   d-9c0d1e2f

## Checks

- [x] `policy-check` — 1 clause changed, 0 errors, 0 warnings
- [x] no intersection with a red or orange clause from a broader tier
- [ ] `policy/widening` — 0 of 2 required approvals from `@acme/tech-leads`
~~~

**No-`gh` equivalent:** `accept` writes the same content as the commit message body, so `git show`
gives a reviewer the identical artifact. That is why the header is four lines of markdown and not a
GitHub-specific widget.

### 7.6 Seeing *why*, without opening five files

One file, one command. The proposal file contains, in this order: the clause, the replay report, the
motivating decisions verbatim, and one paragraph naming the signal that produced it. `proposals show`
prints it; the dashboard links it; the PR body embeds it. Record ids (`d-1a2b3c4d`) are there for the
one person in a hundred who wants the raw record — `session-sitter records show d-1a2b3c4d` — and the
other ninety-nine never need to.

---

## 8. Anti-patterns — what we deliberately do not build

| Anti-pattern | Why it is tempting | What we do instead |
|---|---|---|
| **Partial-PR acceptance by parsing review comments** ("approved lines 3–7") | reviewers want 4 of 6 patterns | Group aggressively (§3.2) so the unit is already right; offer `accept --patterns 1,2,4,5`, which is a flag over a list and produces a new fingerprint. Never parse prose. Renovate settled on one-proposal-per-PR after years. |
| **Closed-PR as state** | it is free and Renovate does it | The ledger file is truth; PR-close is a trigger (§3.5). Renovate got this wrong by necessity — it has no repo to write to. We own the repo. |
| **A funnel / Sankey visualisation** of the pipeline | it looks like insight | Five numbers on one line: `mined 1,284 · candidates 4 · grouped 3 · open 3/10 · accepted this month 2`. |
| **A second evaluator for replay** | the production ladder is awkward to call | `proposals` calls `replay()` in `src/policy/cli.ts`, which calls `decideDeterministically` — the production path. A second evaluator means the report lies, and it lies in the direction of confidence. |
| **An "audit" mode that acts** (this spec's own earlier error) | orange already exists, so audit looked free | Audit records a would-be verdict and changes no outcome (§7.1). A mode that blocks and escalates is called `--escalate`, is narrowing-only, and is not audit. |
| **Auto-accepting high-confidence candidates** | "0 reversals, 61 hits, obviously fine" | Nothing writes a policy file except an explicit accept. `confidence` is typed by hand today and nothing measures it (brief §4); a gate keyed on an unmeasured field is theatre. |
| **A rules-review web app** | it demos well | `proposals list` and one 200-line `node:http` page for the org manager. The reviewable artifact is a diff, and git already renders diffs. |
| **Mirroring proposals into the corpus repo automatically** | the team lead wants visibility | Explicit `share`, masked (§2b). An automatic mirror publishes command lines from other people's sessions. |
| **A date that disarms a safety clause** | `expires` looked like a free retirement mechanism | `retire` writes `status: retired` + `retired_reason: manual`; a past `expires` on a red still fires and lints loudly (§7.2). Only a human act disarms a block. |
| **Treating revocation as a kill switch** | org managers ask for one | §7.3 states the window and says plainly it reaches only machines that pull. A brake advertised as a kill switch is worse than no brake, because someone stops watching — and this is not hypothetical: `revoke` on a clause whose permission was persisted does nothing at all, silently, because the call never prompts. That is exactly how the row would have come true, so it is named rather than left abstract. The brake that actually stops a call is `block`, evaluated in `PreToolUse`. |
| **Making the dashboard issue writable state** | checkboxes are so convenient | The issue is rewritten in full on every sync from the files. Checkbox state lives for the length of one sync and is then discarded. |

---

## 9. Test plan

Existing style: vitest, no network, no real agent, no VS Code. Every test drives the CLI's exported
`main()` with `SESSION_SITTER_DATA_DIR` pointed at a `tmp` dir and a bare on-disk git remote where a
remote is needed.

**Fingerprint and decline permanence** — the load-bearing invariants.
1. Same patterns, reworded prose → same `fp`; re-mining after a decline yields an empty queue.
2. Broadened patterns → different `fp`; re-mining after a decline **does** offer it. (Assert both
   directions; only asserting suppression hides the widening hole.)
3. `decline` → `mine` → `list` → empty; `reopen <fp>` → `mine` → present.
4. A decline written by a *shared* ledger in the corpus repo suppresses the candidate on a second
   machine with a different `dataDir`.
5. The ledger is append-only: two declines of the same fp produce two lines, and neither is lost.

**Accept-time precedence refusal (§4.2)** — the security-shaped test.
6. A user-tier green whose pattern is matched by a team-tier red → exit `3`, nothing written, no
   commit. Assert the file is byte-identical afterwards.
7. Same candidate at team tier superseding the red → allowed (the legitimate path is not blocked).
8. `policy check` fails on a hand-edited file with the same intersection.
9. The intersection test uses the clause matchers, not a string compare: a `/regex/` team clause that
   matches the candidate's substring is caught.

**Direction classification.**
10. Table test: add green → widen; add red → narrow; raise orange→red → narrow; lower red→orange →
    widen; broaden a pattern → widen; shrink → narrow; no `Match:` → neutral.
11. A widening at team tier without `--approved-by` → exit `3`. With `--approved-by` equal to the git
    author → exit `3`. With a different handle → accepted, trailer present.

**Noise budget.**
12. 40 raw candidates → ≤5 proposals written in one run; the remainder are absent, and no backlog
    file exists.
13. With 10 open, `mine` writes nothing and prints the paused line; after one accept it writes one.
14. Grouping: 6 candidates differing only in pattern → one proposal, 6 `Match:` patterns, one replay
    report over the union.
15. Candidates differing in `direction` are **never** grouped (a widen must not ride in on a narrow).

**Lifecycle.**
16. `accept --audit` writes the **intended** level plus `status: audit` and an `expires` (defaulted to
    +14d) — assert the level is NOT rewritten, since a rewritten level is the bug this replaced, and
    assert `expires` is always set, since a trial with no deadline is a trial nobody ends.
17. **Audit decides nothing** — the load-bearing test. Replay the same fixture decisions twice, once
    with the clause absent and once with it present in audit: the verdicts are byte-identical, and
    the second run's records carry a would-be verdict for the clause. Assert both halves; asserting
    only that the log appears would pass an implementation that also changed the outcome.
18. `--escalate` on a widening proposal → exit `3`, nothing written. On a narrowing proposal → writes
    orange with the intended red retained for `promote`.
19. `promote` with 0 disagreements sets `status: accepted` and clears `expires`; with ≥1
    disagreement → exit `3`, clause unchanged; `--accept-disagreements` proceeds and records them.
20. `promote` past `expires` refuses (lapsed trial), and refuses separately with no hits at all (no
    evidence is not evidence) — two refusals, two messages, one test each way round.
21. A lapsed `status: audit` clause **does not block the compile**, while a lapsed `accepted` one does.
    Assert both in one test: getting this backwards makes a forgotten trial halt a team.
22. `retire` sets `status: retired`, `retired_reason: 'manual'`, `retired_at` and a non-null
    `retired_by`, and leaves the clause and its `id` in place (provenance survives).
23. `accept` of a subsuming clause sets the old one to `superseded`; a `displaces` eviction of a **red**
    requires the §4.3 widening bar while the displacing clause alone does not — both bars in one test.
24. `accept` refuses a mined clause with a body under 80 chars, and writes no `evidence` field.

**Revocation (§7.3).**
25. `policy revoke <clauseId>` appends one line; the clause file is **byte-identical** afterwards.
26. **`policy revoke` on a red or orange clause → exit `3`, nothing appended.** The load-bearing
    test of the deny-only invariant on the CLI side. `des-runtime` owns the runtime-side
    `revoke_refused` assertion and the `PreToolUse`-denies-a-silently-allowed-call assertion; assert
    both ends exist, so neither side can quietly drop its half.
27. **Property test: no revocations fixture can flip a deny to an allow.** Generate lines including
    `"level":"green"`, `"fix":…`, `"tier":"user"`, and a `revoke` of a red — replay a fixture set with
    and without them and assert no verdict moves toward allow. This is the one test that would catch
    the channel growing a grant. Assert the *reason*, too: a line carrying `"level":"green"` and no
    `revoke`/`block` key is skipped for having **no recognized directive**, not for containing a
    forbidden word. A test that passes because `green` was blocklisted would go green against an
    implementation that can be defeated by `"a"+"llow"`. `des-runtime` deleted its duplicate of this and
    test 27, so both live here — one home each.
28. The two local files are **unioned and order-independent**: the same two lines in either file, in
    either order, produce identical verdicts.
29. A malformed line is skipped and logged while **every other line still applies** (this is what the
    JSONL format buys); a missing file is not an error; a wholly unreadable file is treated as empty
    with `revoke_list_invalid` and a non-zero `policy revoke --check`.
30. `policy revoke --clear` at team tier requires the §4.3 widening bar (2 approvals) while
    `policy block` requires one — assert **both bars in one test**, so an implementation cannot
    accidentally make them the same.
31. A block older than 30 days is a `policy check` **error**, not a warning.
32. `proposals new --from-revocation` produces a narrowing proposal whose patterns equal the block's,
    and removes the revocation line in the same commit on accept.
33. `policy revoke <id>` on a clause with rules in `granted.jsonl` prints the exact `/permissions`
    lines to remove and **edits no settings file without `--retract`** — assert both, since the value
    is the print and the safety is the non-edit.

**Audit gate (§7.1).**
34. `accept --audit` on a clause with no `Match:` line → exit `3`, nothing written.
35. `promote` on a clause with no `Match:` line → exit `3` with the same reason, not a wait-for-hits
    message. A gate that waits forever for hits that cannot happen is the bug this test exists for.
36. An audit clause is **not rendered into the prompt**: assert the prompt bytes are identical with the
    clause absent and with it in audit. This is the half of "audit changes nothing" that lives in the
    prompt rather than in the verdict, and test 17 does not cover it (17 covers the verdict).

**Degradation** — each asserts exit `0` and a specific message, because the failure mode of an
optional tier must be a sentence, not a stack trace.
37. `gh` absent (PATH stubbed) → `sync` exits 0, one line, queue unaffected.
38. `git` absent → `accept` writes the file, warns, exits 0.
39. No `dataRepoPath` → `init` creates `<dataDir>/corpus` as a git repo with the users tier present.
40. `learn: "off"` → `mine` writes nothing; `decisions.jsonl` still grows after a decision.
41. `learn: "manual"` → `list` does not mine even when 30 days stale.
42. A masker error during `share` → refuses, writes nothing to the corpus repo.

**Fixture honesty** (the PR #40 lesson: the masking rules' `\b` terminator missed the real key format
entirely, and the fixtures agreed with the bug).
43. The `share` masking test uses a realistic base64url `sk-ant-` value **containing `_`**, and
    asserts on the *output file's bytes*, not on the masker's own report.
44. One golden test renders the dashboard issue body and the PR body from a fixed proposal set and
    diffs against a checked-in expected file — so a template change is a visible diff, and the
    reversal line can never be silently dropped from the report.

**End-to-end, per the brief's bar for done:** one real run — real `decisions.jsonl` from a live
session, real mining, real proposal file, a real `accept`, a real commit, and a real PR on a scratch
repo with a bare on-disk remote and an isolated `CLAUDE_CONFIG_DIR`. Numbers from that run replace
every illustrative number in the docs.
