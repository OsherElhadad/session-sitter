# Contributing

Issues and pull requests are welcome. This file is the short version of what the CI will tell you
anyway — reading it first saves a round trip.

## The gate

```bash
npm ci        # once, or whenever package-lock.json changes
make check    # type-check + lint + tests
make guards   # the four consistency guards CI also runs
```

`make check` is exactly what CI's test job runs, on Node 20 and 22. `make` with no target lists
every other target. Nothing in CI is CI-only, so a green `make check` locally means a green
pipeline — that property is deliberate, and worth keeping.

Two things that catch people out on a fresh clone:

- `src/buildInfo.ts` is generated and gitignored. The source imports it, so the type-check, the
  lint and the tests all need it. Every `make` target that needs it depends on it, which is why you
  should go through `make` rather than calling `npx vitest` directly.
- Reading IBM Bob's session store needs `python3` on your `PATH`, and so do the tests that build
  SQLite fixtures. CI pins it with `setup-python` rather than trusting the runner image.

## TypeScript only

There is no Python, no build step beyond `tsc`, and **no runtime dependencies** — `dependencies` in
`package.json` is empty and should stay that way. A VS Code extension ships its whole dependency
tree to every user, and a native module breaks VSIX portability outright.

The one place Python is *executed* is `src/BobDatabase.ts`, which shells out to `python3 -c` to read
Bob's SQLite store read-only. That is a runtime dependency on an interpreter, not Python source in
this repository, and `ci/check-no-python.sh` enforces the difference. See
[why one `python3` call remains](docs/ARCHITECTURE.md#why-one-python3-call-remains).

Adding a dev dependency is a normal change. Adding a runtime one needs a reason in the PR
description.

## The guards

Four scripts under `ci/`, all runnable by hand, all offline. They exist because each one caught a
real bug that nothing else would have.

| Guard | What it refuses |
|---|---|
| `bash ci/check-no-python.sh` | a `.py` file in the tree, an internal name or host, or a `.vsix` that would ship `ci/`, the `Makefile` or `.github/` |
| `node ci/check-settings.mjs` | a setting the code reads that `package.json` does not declare, or declares and nothing reads — the drift that makes every `config.get()` silently return its fallback |
| `bash ci/check-naming.sh` | any spelling of a previous project name, in code, in prose, or in a filename |
| `node ci/check-links.mjs` | a relative markdown link or HTML image `src`/`srcset` that does not resolve on disk |

If you add a setting, declare it in `package.json` **and** read it in `src/`, or add it to
`UI_ONLY` in `ci/check-settings.mjs` with a comment saying who reads it instead. If you add a
setting a user is expected to find, it also belongs in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md), which claims to cover every one.

`docs/superpowers/` is excluded from the link check and the spellchecker on purpose: those are
dated design records, and rewriting one to satisfy a linter would falsify the record.

## Tests

[vitest](https://vitest.dev), under `src/test/`. No network, no real agent, no VS Code instance —
the `vscode` module is stubbed. A test that needs one of those three is a test that will be flaky
on someone else's machine, so the seam belongs in the code instead.

`make test-file FILE=src/test/<name>.test.ts` runs one file. Do not put a test count in a badge or
in prose; nothing verifies it and it silently rots.

## Commit messages and PR descriptions

The subject line is a sentence saying what the change does for a user, in the present tense, with
no `type:` prefix and no ticket number:

```
Stop an interrupted session from sitting in the active list forever
Show sessions from other machines, with no configuration
Let the session list hold still, and give each workspace its own colour
```

The body explains **why** — what was wrong, what a reader would otherwise assume, and what you
decided against. A diff already says what changed; a body that repeats it is wasted. The same voice
applies to comments and docs in this repo: explain the reason, not the mechanics, and skip the
marketing.

## Releasing

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry, in the same voice — what changed and why it mattered.
3. Push a matching tag: `git tag v0.8.1 && git push origin v0.8.1`.

`.github/workflows/release.yml` asserts the tag agrees with `package.json`, runs the full gate, and
attaches the `.vsix` to a GitHub Release. A mismatch fails the release rather than publishing a
build named after a different version.

## Security

Please do not open a public issue for a vulnerability — see [`SECURITY.md`](SECURITY.md).
