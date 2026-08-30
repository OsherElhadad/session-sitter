# Changelog

This is the one file that names what the project used to be called. Everywhere else carries a
single name — **Session Sitter** — and `ci/check-naming.sh` enforces that.

## 0.5.0

**The project is now Session Sitter.** Same extension, one name, and one settings namespace.

### Breaking: every setting moved

Two namespaces collapsed into `sessionSitter.*`. The old names are **not** read, so an existing
configuration needs renaming — a stale key is silently ignored, which looks like the feature simply
not working.

| Before 0.5.0 | 0.5.0 |
|---|---|
| `claudeSessionSwitcher.autoRespond` | `sessionSitter.autoRespond` |
| `claudeSessionSwitcher.probelessActiveWindowMinutes` | `sessionSitter.probelessActiveWindowMinutes` |
| `reckon.supervisorStateDir` | `sessionSitter.supervisorStateDir` |
| `reckon.autoSupervise` | `sessionSitter.autoSupervise` |
| `reckon.supervisorRepoPath` | `sessionSitter.supervisorRepoPath` |
| `reckon.dataRepoPath` | `sessionSitter.dataRepoPath` |
| `reckon.knowledge.user` · `.project` · `.team` | `sessionSitter.knowledge.user` · `.project` · `.team` |
| `reckon.knowledge.registryPath` | `sessionSitter.knowledge.registryPath` |
| `reckon.uploadScriptPath` | **removed** — set `sessionSitter.dataRepoPath` instead |
| `reckon.pythonPath` | **removed** — it was already unused |

Command ids moved the same way: `claudeSessionSwitcher.refresh` → `sessionSitter.refresh`, and so
on for all 17.

### Breaking: two paths on disk

| Before 0.5.0 | 0.5.0 |
|---|---|
| `~/.claude/session-switcher/` | `~/.claude/session-sitter/` |
| `<stateDir>/session-switcher.log` | `<stateDir>/session-sitter.log` |

The first is cross-window focus state and is rebuilt within a minute, so there is nothing to move.

**Your supervision state carries over untouched.** Records, transcripts, the outbox and the
messaging offset all keep their format — point `sessionSitter.supervisorStateDir` at the same
directory and pending decisions resume with their deadlines intact.

### Also in this release

- The extension id is `eranra.session-sitter`; the panel is titled **Session Sitter**; the output
  channel and the command category match.
- **`ci/check-naming.sh`** fails the build on any leftover of a previous name, in code or in prose.
  No allowlist except this file.
- **`ci/check-settings.mjs`** asserts that every setting the code reads is declared in
  `package.json`, and vice versa. It was written after the rename produced exactly that drift —
  the code read one namespace while the declarations used another, and nothing failed: every
  `config.get()` just returned its fallback. A compiler cannot catch that; comparing the two sides
  can.

## 0.1.0

- Consolidated a private supervision runtime into this extension as **TypeScript only** — roughly
  2,600 lines of Python (a traffic-light supervisor, a session-corpus uploader, a secret masker and
  a knowledge loader) ported to `src/supervisor/` and `src/corpus/`, with the behavior contracts
  intact.
- Added traffic-light supervision of the actions an agent pauses on, the Bob and Claude
  extension-host bridges, the supervision activity feed, and approval rules alongside the existing
  text rules.
- Added CI (compile, lint, 602 tests on Node 20 and 22, packaging, docs links, spellcheck, guards),
  a release pipeline, and a Makefile.

## 0.0.x

Session panel for Claude Code and IBM Bob IDE: live status, one-click switching, cross-window
focus, hover preview, history. Later added Codex CLI and VS Code Chat as sources, full-transcript
export, and the Copy transcript submenu.
