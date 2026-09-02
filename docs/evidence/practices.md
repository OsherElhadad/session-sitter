# Bottom line — widget-lab platform team

Notes outside a `###` entry are ignored by the parser, so this paragraph costs nothing.

---

### Intention: Never rewrite history on a branch other people build on

| Field | Value |
|---|---|
| id | team-git-002 |
| level | red |
| tags | git, history |

Match: `/git\s+push\b[^\n]*--force(?!-with-lease)/`, `/git\s+push\b[^\n]*--delete/`

A plain `--force` overwrites whatever the remote has, including commits you never fetched. Push a
new commit, or use `--force-with-lease` so the push refuses instead of destroying someone's work.

---

### Intention: A force push must be leased, never blind

| Field | Value |
|---|---|
| id | force-push |
| level | yellow |
| tags | git, history |

This is the clause the built-in correction rule cites when it rewrites `--force` into
`--force-with-lease`. It carries no `Match:` line on purpose: it decides nothing itself, it only
gives `practices §force-push` somewhere to point when the rewrite is explained to the human.

---

### Intention: Secrets are never read into the transcript

| Field | Value |
|---|---|
| id | team-sec-003 |
| level | red |
| tags | secrets |

Match: `/\.env\b/`, id_rsa, credentials.json

A `.env` read puts live credentials into the session transcript, the audit trail and any summary
built from them. Read the key names from `.env.example`, or ask the human for the one value you
need.

---

### Intention: Running the test suite and the build never needs approval

| Field | Value |
|---|---|
| id | team-ci-001 |
| level | green |
| tags | testing |

Match: npm test, npm run build, node --test

Both write only into `out/` and `coverage/`, and an overnight run that stalls on the test suite is
a run that did nothing.

---

### Belief: Credentials are referenced by environment variable, never pasted

| Field | Value |
|---|---|
| id | team-sec-001 |
| level | red |

No `Match:` line, so this clause is prose context for the classifier and enforces nothing on its
own. `/session-sitter:policy` reports that as an error — it is here on purpose, to show that it does.

---

### Intention: A generated directory is rebuilt, never deleted out from under a running job

| Field | Value |
|---|---|
| id | team-fs-004 |
| level | red |
| tags | filesystem |

Match: `/rm\s+-[a-z]*r[a-z]*f\b/`

A recursive delete cannot be narrowed into a safer form and cannot be undone, so this clause denies
it outright rather than rewriting it. If a stale `build/` is the problem, run the build's own clean
target; if you truly need the delete, a human runs it.
