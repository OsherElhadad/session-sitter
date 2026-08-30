# Corpus: collecting sessions

Knowledge has to come from somewhere. The corpus is the store of past agent sessions that
[BDI entries](KNOWLEDGE.md) are distilled from — your team's own history, in one repository.

Regular users of supervision do not need any of this. This is the producer side.

---

## Layout

```
<corpus repo>/
├── data/
│   ├── sessions/<user>/<source>/
│   │   ├── 20260714_fix-the-failing-test-a1b2c3d4.claude.json   ← clean envelope
│   │   ├── 20260714_fix-the-failing-test-a1b2c3d4.meta.yaml     ← sidecar
│   │   └── raw/
│   │       └── 20260714_fix-the-failing-test-a1b2c3d4.claude.jsonl  ← untouched original
│   └── knowledge/{teams,projects,users}/<slug>/bottom-line.md
```

`<source>` is one of `bob`, `claude`, `chatgpt`, `copilot`, `other`.

**The stem is deterministic**: `YYYYMMDD_slug-id8`, where `id8` is a SHA-1 prefix of the full
session id — a *hash*, not a slice, because agent session ids share long common prefixes and a
slice would collide and overwrite distinct sessions. All three artifacts of one session share the
stem, and the same session always produces the same name, which is what makes re-importing
idempotent.

The **envelope** is the clean, analyzable form: user and assistant turns only, with the model and
any tool names. The **raw** copy preserves everything, so nothing is lost to the envelope's
filtering. The **sidecar** records provenance: who uploaded it, from what source, the original
filename, the title, the model, and when.

---

## Uploading

From the panel: right-click a session → **Upload to Corpus**. It runs in-process — no script path
to configure, no subprocess.

Set `sessionSitter.dataRepoPath` to the corpus repo root first.

From the CLI:

```bash
npm run compile

# One file (the source is detected from the extension)
node out/corpus/cli.js upload ./my-chat.bob.json --repo /path/to/corpus

# Override what cannot be detected
node out/corpus/cli.js upload ./notes.txt --source other --slug design-review --repo …

# Preview every step, touching nothing
node out/corpus/cli.js upload ./my-chat.bob.json --repo … --dry-run
```

Each upload pulls latest from `main`, commits **only** the affected files, and pushes. If you were
on another branch it stashes, switches, and puts you back where you were, stash popped.

---

## Bulk import

`import` reads your local Bob and Claude stores directly and writes every session it finds:

```bash
# Both sources
node out/corpus/cli.js import --repo /path/to/corpus

# One source, capped, committed locally without pushing
node out/corpus/cli.js import --claude --limit 20 --no-push --repo …

# See what it would do
node out/corpus/cli.js import --repo … --dry-run
```

It reads:

- **Bob** — `~/.bob/db/bob.db`, every `task_type = 'normal'` task with its messages. User prompts
  are unwrapped from Bob's `<environment_details>`/`<user_query>` scaffolding.
- **Claude** — top-level `~/.claude/projects/*/​<uuid>.jsonl` files. Subagent sidechains are
  skipped, synthetic models are dropped, and the title comes from the first *real* user prompt —
  harness-injected context (`<system-reminder>`, `<ide_selection>`, a `Caveat:` preamble) is kept
  as a message but never used as the title.

**It is idempotent.** By default a session whose envelope already exists is skipped, so a re-run
commits only what is new. `--force` rewrites everything.

The whole batch is **one commit**, not one per session.

---

## Secrets are redacted before anything is committed

Developers paste credentials into prompts. Masking runs automatically on import, before
`git add`, so no unmasked credential can enter git history.

```bash
# Mask an existing store by hand
node out/corpus/cli.js mask --repo /path/to/corpus --user alice

# Report only, write nothing
node out/corpus/cli.js mask --repo … --dry-run
```

What it detects: GitHub tokens (fine-grained, classic, OAuth), Anthropic and OpenAI keys, AWS
access key ids and secret keys, Google API keys, Slack tokens, JWTs, bearer tokens, and PEM
private key blocks.

Each real value is replaced with a **deterministic fake of the same shape and length**, keeping
the recognizable prefix (`ghp_`, `sk-ant-`, `AKIA`, `AIza`) and embedding the marker `MASKED`.
Same shape means the file still parses and still reads like a real session; deterministic means
the envelope and its raw copy stay consistent with each other; the marker means a second run
skips already-masked values, so masking is **idempotent**.

Two things it deliberately does *not* do:

- **It never masks emails, names or file paths.** Those are not secrets, and masking them corrupts
  legitimate content.
- **It does not rely on file contents alone.** A secret pasted into a session *title* would end up
  in the stored filename, where no content pass would ever reach it — so the slug is redacted
  before the name is built.

Every run writes `MASKING-REPORT.md` next to the store, listing what was masked by type. It shows
only redacted previews (`first4…last3`); the repository never stores the original values.

`--no-mask` skips it. Review before pushing if you use it.

---

## Listing and deleting

```bash
node out/corpus/cli.js list --repo /path/to/corpus
node out/corpus/cli.js list --repo … --source claude --top 20
node out/corpus/cli.js delete 20260714_old-session.bob.json --repo … --user alice
```

`list` shows the newest first per source, with the title read from the envelope and the upload
time from the sidecar. `delete` removes the file and its sidecar in a single commit.

---

## Adding a new agent harness

1. Add the suffix and source name to `EXTENSION_SOURCE_MAP` in [`../src/corpus/upload.ts`](../src/corpus/upload.ts).
2. Add the source to `VALID_SOURCES` in the same file.
3. For bulk import, add an `extract<Harness>Sessions` function returning `ImportRecord[]`.

The envelope shape is the contract; anything that can produce it fits.

---

## Keep the corpus private

Sessions contain real work: internal names, architecture, customer references, and whatever else
got typed into a prompt. Masking removes credentials — it does not make a session public. Keep the
corpus repository private and separate from this one.

---

## See also

- [`KNOWLEDGE.md`](KNOWLEDGE.md) — turning sessions into BDI entries
- [`SUPERVISION.md`](SUPERVISION.md) — what that knowledge then does
