## What this does, and why

<!--
The subject line of your commit says what changed. This says why: what was wrong, what a reader
would otherwise assume, and what you decided against. See CONTRIBUTING.md for the voice.
-->

## Verification

<!-- Paste the tail of `make check`, and name anything you checked by hand in a real IDE window. -->

- [ ] `make check` passes (type-check + lint + tests)
- [ ] `make guards` passes (no Python, settings match `package.json`, one project name, links resolve)
- [ ] Tried it in a real IDE window — `make install`, or F5 for an Extension Development Host

## If this change touched…

- [ ] **A setting** — declared in `package.json`, read in `src/`, and documented in
      `docs/CONFIGURATION.md`, which claims to cover every one
- [ ] **A command** — user-facing ones go in the palette; a developer probe is gated on
      `sessionSitter.debugCommands`
- [ ] **Anything a user sees** — a `CHANGELOG.md` entry saying why it mattered
- [ ] **Nothing added a runtime dependency** — `dependencies` in `package.json` is still empty
