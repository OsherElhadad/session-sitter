---
name: kb-sitter
description: Use when a supervision runtime needs to load BDI knowledge (three bottom-line.md files) for one running coding-agent session. Given a (user, project, team) triple and a knowledge repo, this skill fetches the three tier files and returns them in tier order (team → project → user) for merging. Do not invoke for general repo browsing, plain file reads, or for classifying observed agent actions.
---

# kb-sitter — knowledge loader

Loads the three BDI `bottom-line.md` files a supervision runtime needs to reason about one running
coding-agent session.

This skill is **only** the loader. It does not classify actions, does not decide traffic-light
interventions, and does not format messages — those live in the supervisor
([`docs/SUPERVISION.md`](../../docs/SUPERVISION.md)). Keeping loading out of the model's hands is
deliberate: routing is deterministic code, so which knowledge applies is never a judgment call.

---

## When to invoke

Invoke when a supervision runtime needs the belief / desire / intention knowledge for a specific
`(user, project, team)` triple, and a knowledge source is configured.

Do **not** invoke for:

- general repository browsing — use `git` or `gh`
- reading a file by path — use the Read tool
- classifying an agent's action or deciding an intervention — that is the supervisor's job

---

## Inputs

| Input | Example | Notes |
|---|---|---|
| `user` | `alice` | owner of the running session — routes the highest-precedence tier |
| `project` | `demo-project` | the repository or project the session is working on |
| `team` | `platform` | the team the user belongs to — the broadest tier |

Plus one knowledge source:

- `--local <dir>` — a local corpus checkout (preferred: offline, instant, picks up uncommitted
  edits). Also read from `KNOWLEDGE_LOCAL_REPO`.
- `--repo <git-url> [--ref <ref>]` — shallow-cloned per call. Also read from `KNOWLEDGE_REPO` /
  `KNOWLEDGE_REF`.

A slug you cannot supply should be resolved by the caller — from the working directory, a
registry, or by asking — *before* invoking this skill. The loader does not guess.

---

## How to invoke

```bash
node out/corpus/cli.js fetch-knowledge \
  --user alice --project demo-project --team platform \
  --local /path/to/corpus
```

Build first if `out/` is absent: `npm run compile`.

---

## Output

JSON on stdout: the load order, then one entry per tier.

```json
{
  "load_order": ["team", "project", "user"],
  "files": {
    "team": {
      "slug": "platform",
      "path_in_repo": "data/knowledge/teams/platform/bottom-line.md",
      "exists": true,
      "content": "---\nscope: team\n…"
    },
    "project": { "slug": "demo-project", "path_in_repo": "…", "exists": true,  "content": "…" },
    "user":    { "slug": "alice",        "path_in_repo": "…", "exists": false, "content": null }
  }
}
```

**A missing tier file is not an error.** It surfaces as `exists: false` with `content: null`, and
the caller proceeds with the tiers it did get — including with none at all.

---

## Merge order

Return and merge in `load_order`: **team → project → user**. Narrower scope wins on conflict, so a
user entry outranks a project entry, which outranks a team entry.

Do **not** resolve conflicts while loading. Surface every entry from every tier, annotated with
its tier, and let the classifier weigh them. A team-level red safety rule must never be silently
dropped because a narrower file happens to reuse an id.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success — tier files may still be missing; check `exists` per tier |
| `1` | the knowledge source could not be read (bad local path, clone failed) |
| `2` | bad arguments — a slug or the source is missing |

---

## See also

- [`docs/KNOWLEDGE.md`](../../docs/KNOWLEDGE.md) — the BDI schema, the three tiers, and routing
- [`knowledge/bottom-line.template.md`](../../knowledge/bottom-line.template.md) — a tier file to copy
- [`knowledge/REGISTRY.example.md`](../../knowledge/REGISTRY.example.md) — validating the triple
