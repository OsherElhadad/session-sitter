# Knowledge registry (example)

An **optional** roster of the teams, projects and users your corpus has knowledge for. Point
`reckon.knowledge.registryPath` at a file like this one and the `(user, project, team)` triple is
validated against it before any file is read.

Without a registry the three configured slugs are used as given — which is the simpler setup, and
the default. Use a registry when several people share a corpus and you want a typo in a slug to
fail loudly instead of quietly routing to a file that does not exist.

Every slug here is a placeholder. Replace them.

---

## What the registry buys you

| Situation | Without a registry | With a registry |
|---|---|---|
| `project` not configured | that tier is skipped | inferred, when the user is on exactly one project |
| `project` not configured, user on several | that tier is skipped | **hard error** — it refuses to guess |
| `team` not configured | that tier is skipped | taken from the user's row, else the project's row |
| a slug is misspelled | the file is reported missing, supervision runs without it | **hard error** naming the unknown slug |

An unknown slug is never replaced by a default.

---

## Teams

| Team slug | File |
|---|---|
| `platform` | [`data/knowledge/teams/platform/bottom-line.md`](data/knowledge/teams/platform/bottom-line.md) |
| `data-eng` | [`data/knowledge/teams/data-eng/bottom-line.md`](data/knowledge/teams/data-eng/bottom-line.md) |

## Projects

| Project slug | File | Team | Users on this project |
|---|---|---|---|
| `demo-project` | [`data/knowledge/projects/demo-project/bottom-line.md`](data/knowledge/projects/demo-project/bottom-line.md) | `platform` | alice, bob |
| `warehouse` | [`data/knowledge/projects/warehouse/bottom-line.md`](data/knowledge/projects/warehouse/bottom-line.md) | `data-eng` | bob, carol |

## Users

| User slug | File | Team | Projects |
|---|---|---|---|
| `alice` | [`data/knowledge/users/alice/bottom-line.md`](data/knowledge/users/alice/bottom-line.md) | `platform` | demo-project |
| `bob` | [`data/knowledge/users/bob/bottom-line.md`](data/knowledge/users/bob/bottom-line.md) | `platform` | demo-project, warehouse |
| `carol` | [`data/knowledge/users/carol/bottom-line.md`](data/knowledge/users/carol/bottom-line.md) | `data-eng` | warehouse |

---

## Worked examples

**Alice, project omitted.** `user=alice` → she is on exactly one project, so `demo-project` is
used, and `platform` comes from her row. Loads all three tiers.

**Bob, project omitted.** `user=bob` → he is on two projects. Hard error: resolve the project
before routing. Guessing would silently apply the wrong project's rules.

**Carol, project given.** `user=carol, project=warehouse` → team `data-eng` from her row.

**An unknown user.** `user=dave` → hard error naming `dave` as unknown, rather than falling back
to some default roster.

---

## Format notes

- Tables are found by their header text: `Team slug`, `Project slug`, `User slug`. Column order
  after the first cell follows the shape above.
- Cells may be plain (`alice`), backticked (`` `alice` ``), or markdown links — all three parse to
  the same slug.
- The user and project lists are comma- or space-separated.
- Prose between tables is ignored, so a registry can document itself.
