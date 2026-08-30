# Changelog

This is the one file that names what the project used to be called. Everywhere else carries a
single name — **Session Sitter** — and `ci/check-naming.sh` enforces that.

## 0.6.0

**Every intervention is visible, and everything is configured from settings.**

### Deterministic rule decisions are now recorded and reported

Until now only the supervisor's decisions reached you. A `sessionSitter.autoRespond` rule that
auto-approved a tool prompt, auto-rejected one, or sent a canned reply changed what your agent did
and left no trace outside the log.

Every applied rule now writes a supervision record under `<stateDir>/records/` — the same file
shape the supervisor writes, with `decided_by: "rule"` and a `rule` trace naming the pattern that
fired — and posts a **one-way update** to your messaging channel.

- The **Supervision activity** panel tags each card **⚙ rule** or **🧠 AI**, and shows the rule
  pattern that fired.
- The light follows the outcome: approve → 🟢, reject → 🔴, canned text reply → 🟡.
- A rule decision is never an interactive card. The decision is already made; there is nothing to
  ask.
- This needs only `sessionSitter.supervisorStateDir`. Rule decisions are recorded and reported even
  with `sessionSitter.autoSupervise: false`, because no classifier is involved.
- New `sessionSitter.supervisor.notifyRuleDecisions` (default `true`) keeps them out of Telegram
  while still recording them.

A decision is reported only once it actually reached the agent: a failed resolve or a failed send
reports nothing. Reporting can never delay or break applying a decision — a broken record write or
a dead channel is logged and dropped.

### Supervisor configuration moved into settings.json

The supervisor used to read its engine, credentials, channel and timeouts from the environment or a
`.env` file. All of it is now a `sessionSitter.supervisor.*` setting, editable in the Settings UI:

| Was | Now |
|---|---|
| `SUPERVISOR_ENGINE` | `sessionSitter.supervisor.engine` |
| `BOB_CLI_PATH` | `sessionSitter.supervisor.bobCliPath` |
| `CLAUDE_CLI_PATH` | `sessionSitter.supervisor.claudeCliPath` |
| `BOB_API_KEY` / `BOBSHELL_API_KEY` | `sessionSitter.supervisor.bobApiKey` |
| `ANTHROPIC_BASE_URL` | `sessionSitter.supervisor.anthropicBaseUrl` |
| `ANTHROPIC_AUTH_TOKEN` | `sessionSitter.supervisor.anthropicAuthToken` |
| `CLAUDE_TIMEOUT_SECONDS` | `sessionSitter.supervisor.classifierTimeoutSeconds` |
| `ORANGE_RESPONSE_TIMEOUT_MINUTES` | `sessionSitter.supervisor.orangeResponseTimeoutMinutes` |
| `MESSAGING_CHANNEL` | `sessionSitter.supervisor.messagingChannel` |
| `TELEGRAM_BOT_TOKEN` | `sessionSitter.supervisor.telegramBotToken` |
| `TELEGRAM_CHAT_ID` | `sessionSitter.supervisor.telegramChatId` |
| `RED_NOTIFY` | `sessionSitter.supervisor.redNotify` |
| `KNOWLEDGE_REPO` | `sessionSitter.supervisor.knowledgeRepo` |
| `KNOWLEDGE_REF` | `sessionSitter.supervisor.knowledgeRef` |

**Not breaking.** The environment and `.env` are still read as a fallback for any setting you have
not set, so an existing install keeps working untouched. Precedence is: an explicitly-set setting >
process environment > `.env` files > built-in default. VS Code stores settings in plain text, so
leaving a credential setting empty and keeping the environment variable is a supported choice.

The standalone supervisor CLI (`node out/supervisor/cli.js`) has no settings to read and is
unchanged — environment plus flags.

### Also

- New command **Session Sitter: Open Settings**, and the panel's **☰** menu now offers
  **All settings…**, **Auto-respond rules…** and **Supervisor settings…** separately.
- One messaging channel per window, shared by the supervisor and the rule reporter — two Telegram
  consumers on one bot would fight over `getUpdates`.

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
