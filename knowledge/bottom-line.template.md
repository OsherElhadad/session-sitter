---
scope: team          # team | project | user — must match the tier this file lives in
owner: your-team     # the slug of the team / project / user this file belongs to
updated: 2026-08-30
---

# Bottom line — your-team

The practices supervision applies to every session routed to this tier. Copy this file to
`data/knowledge/<teams|projects|users>/<slug>/bottom-line.md` in your corpus repo and replace the
entries.

Precedence is team < project < user: a user entry outranks a project entry, which outranks a team
entry. Conflicts are not resolved here — every entry from every tier is handed to the classifier,
which weighs them. Full schema: [`../docs/KNOWLEDGE.md`](../docs/KNOWLEDGE.md).

Anything outside a `###` entry is ignored, so notes like this one are free.

---

## Beliefs — facts about how things are

### Belief: Changes to main go through a reviewed pull request

| Field | Value |
|---|---|
| id | team-git-001 |
| level | orange |
| confidence | high |
| scope | team |
| source | replace with where you learned this |
| tags | git, review |
| added | 2026-08-30 |

The team merges through pull requests. A direct push to main bypasses review and CI gating, so an
agent proposing one should raise it rather than proceed.

---

### Belief: Credentials are referenced by environment variable, never pasted

| Field | Value |
|---|---|
| id | team-sec-001 |
| level | red |
| confidence | high |
| scope | team |
| source | replace with where you learned this |
| tags | security, secrets |
| added | 2026-08-30 |

A live key in a prompt, a commit, or a config file is a leak. Reference it by env-var name and
read it at runtime.

---

## Desires — goals and preferences

### Desire: Keep the test suite fast enough to run on every change

| Field | Value |
|---|---|
| id | team-test-001 |
| level | yellow |
| confidence | medium |
| scope | team |
| tags | testing |
| added | 2026-08-30 |

Prefer fakes at I/O boundaries over end-to-end setup. A suite nobody waits for is a suite nobody
runs.

---

## Intentions — `when X → do Y`

### Intention: Ask before force-pushing a shared branch

| Field | Value |
|---|---|
| id | team-git-002 |
| level | orange |
| confidence | high |
| scope | team |
| tags | git |
| added | 2026-08-30 |

**Trigger:** the agent proposes `git push --force` (or `--force-with-lease`) to a branch that is
not its own throwaway branch.

**Precondition:** the branch may have been pulled by someone else.

**Action:** stop and ask the developer. Offer a non-destructive alternative — a follow-up commit,
or a new branch.

**Termination:** the developer approves, or the agent takes the alternative.

---

### Intention: Prefer the existing utility over a new one

| Field | Value |
|---|---|
| id | team-code-001 |
| level | yellow |
| confidence | medium |
| scope | team |
| tags | conventions |
| added | 2026-08-30 |

**Trigger:** the agent is about to write a helper that duplicates something already in the
codebase.

**Action:** point at the existing utility by name. This needs no human judgment, so it is a
yellow correction rather than a question.

**Termination:** the agent reuses it, or explains why it does not fit.
