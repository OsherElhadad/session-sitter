# Knowledge: the BDI files supervision reads

A coding agent does not inherit your team's practices. Those live in senior developers' heads and
half-remembered PR reviews, and every new session starts without them:

- the agent pushes straight to `main` — *your rule: always via a reviewed PR*
- the agent force-pushes a shared branch — *your rule: ask first*
- the agent writes `bypass-permissions` into shared config — *your rule: personal config only*
- the agent pastes a live API key into a prompt — *your rule: reference it by env-var name*

Knowledge files are where those rules live so the supervisor can apply them.

---

## Three tiers, narrower wins

```
<corpus repo>/data/knowledge/
├── teams/<team>/bottom-line.md        ← broadest · lowest precedence
├── projects/<project>/bottom-line.md  ← one repository or initiative
└── users/<user>/bottom-line.md        ← personal · highest precedence
```

They are loaded in order — team, then project, then user — and handed to the classifier with the
**narrower tier first**, so it sees the precedence. Modeled after how Claude Code layers
`CLAUDE.md` files.

Conflicts are not resolved during loading. Every entry from every tier is surfaced, annotated
with its tier, and the classifier reasons about them. That is deliberate: a team-level red safety
rule must never be silently dropped because a narrower file happens to reuse an id.

A missing tier file is **not** an error. It is skipped, and supervision runs on what is there —
including on nothing at all, which simply means no BDI informs the decision.

Start from [`../knowledge/bottom-line.template.md`](../knowledge/bottom-line.template.md).

---

## The BDI model

Each file holds entries of three kinds:

- **Belief** — a fact about how things are. *"Pushes to main go through a reviewed PR."*
- **Desire** — a goal or preference. *"Keep the test suite under two minutes."*
- **Intention** — a rule shaped `when X → do Y`, with a trigger, a precondition, an action and a
  termination condition. *"When the agent proposes a force-push to a shared branch, ask first."*

### The entry format

A `###` heading naming the kind and the title, then a metadata table, then the body:

```markdown
### Belief: Pushes to main go through a reviewed PR

| Field | Value |
|---|---|
| id | team-git-001 |
| level | orange |
| confidence | high |
| scope | team |
| source | 2026-06 PR review thread |
| tags | git, review |
| added | 2026-06-14 |

The team merges through pull requests; a direct push to main bypasses review and CI gating.

---
```

| Field | Meaning |
|---|---|
| `id` | stable identifier. The classifier cites it, so decisions are traceable to a rule. |
| `level` | 🟢 `green` / 🟡 `yellow` / 🟠 `orange` / 🔴 `red` — the entry's **default** light. |
| `confidence` | `low` / `medium` / `high`. Repetition across sessions is what firms this up. |
| `scope` | the tier this entry belongs to: `user`, `project` or `team`. |
| `source` | where it came from — a session, a PR thread, a person. Provenance matters. |
| `tags` | comma-separated, for grouping. |
| `added` / `updated` | ISO dates. Recency is weighed. |
| `supersedes` | the id this entry replaces, when a practice changed. |
| `expires` | ISO date after which it should not be trusted. |

`level` is a **default, not a verdict**. The classifier weighs scope, confidence, recency,
provenance and the actual situation. An explicit instruction in the current session outranks
older inferred knowledge — unless a mandatory safety or policy constraint (`red`) applies.

Entries end at the next `###` heading, a `##` section boundary, or a lone `---`. Anything outside
an entry is ignored, so prose and front-matter are free.

---

## Routing: which files apply to this session

Supervision needs one `(user, project, team)` triple. There are two ways to get it.

### Settings-driven (the default)

```jsonc
"sessionSitter.knowledge.user": "your-slug",
"sessionSitter.knowledge.project": "your-project",
"sessionSitter.knowledge.team": "your-team"
```

The three slugs are used as given. A slug you leave empty means that tier is simply not
configured: its file is reported missing and the other tiers still load. Nothing is guessed, and
no wrong slug is ever substituted.

### Registry-driven (optional)

Point `sessionSitter.knowledge.registryPath` at a markdown file with the roster, and the triple is
validated against it:

- **project omitted** and the user is on exactly one project → that project is used.
- **project omitted** and the user is on several → a hard error. It refuses to guess.
- **team omitted** → taken from the user's row, else the project's row.
- **an unknown slug anywhere** → a hard error. Never a default.

The registry is three markdown tables; see
[`../knowledge/REGISTRY.example.md`](../knowledge/REGISTRY.example.md). Column headers are matched
by name (`Team slug`, `Project slug`, `User slug`), and cells may be plain, backticked, or
markdown links.

Use a registry when several people share a corpus and you want a typo in a slug to fail loudly
rather than silently route to a file that does not exist.

---

## Where the files are read from

In precedence order:

1. `sessionSitter.dataRepoPath` — a local checkout. Offline, instant, and it picks up uncommitted edits.
2. `KNOWLEDGE_REPO` (git URL) + `KNOWLEDGE_REF` — shallow-cloned per load, so what is read is
   what is committed.

Reading a local checkout is the recommended setup: the loading path stays deterministic and needs
no network.

---

## Loading knowledge yourself

The same loader is exposed as a CLI, so a skill or a script can fetch the three tier files:

```bash
node out/corpus/cli.js fetch-knowledge \
  --user alice --project demo-project --team platform \
  --local /path/to/corpus
```

It prints the load order and, per tier, the slug, the in-repo path, whether it exists, and its
content. A missing file is `exists: false`, never an error. That contract is what
[`../skills/kb-sitter/SKILL.md`](../skills/kb-sitter/SKILL.md) is built on.

---

## Writing good entries

- **Be specific enough to act on.** "Be careful with git" cannot drive a decision; "force-pushing
  a shared branch needs a heads-up first" can.
- **Say why, and where it came from.** The classifier cites the entry in the notification you
  read on your phone. Without a reason it is unreviewable.
- **Set `level` to what you would actually want.** A `red` on everything trains you to ignore it.
- **Supersede rather than delete.** `supersedes` keeps the history of why a practice changed.
- **Put personal preference in the user tier.** Team files are for what the team agreed.

---

## See also

- [`SUPERVISION.md`](SUPERVISION.md) — how a light becomes an action
- [`CORPUS.md`](CORPUS.md) — feeding sessions in, which is where entries come from
- [`CONFIGURATION.md`](CONFIGURATION.md) — every knowledge setting
