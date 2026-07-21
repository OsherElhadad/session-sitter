# Codex and VS Code Chat Session Support

**Date:** 2026-07-13
**Status:** Approved

## Goal

Add two new session sources to the AI Sessions view alongside Claude and Bob:

- **Codex** — OpenAI Codex CLI (rollout files under `~/.codex/sessions/`).
- **Chat** — VS Code's built-in Chat panel (`Ctrl+Cmd+I`), whose sessions live under each workspace's `chatSessions/` folder.

Full parity with Claude/Bob: sessions appear in the top-20-by-recency view, can be previewed via the right-click **Show details**, and can be uploaded via **Upload to reckon**.

## Storage layouts

### Codex

- Session rollout files: `~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<uuid>.jsonl`
- Session index: `~/.codex/session_index.jsonl` — one JSON per line: `{id, thread_name, updated_at}`.
- Inside a rollout file, line 0 is `{timestamp, type: "session_meta", payload: {id, cwd, source, model_provider, ...}}`. Subsequent lines are conversation events keyed by `type`.
- Derivations:
  - `sessionId` = `payload.id` (a UUID)
  - `title` = index `thread_name` (falls back to rollout `payload.cwd` basename if the index is missing an entry)
  - `projectPath` = rollout `payload.cwd`
  - `updatedAt` = index `updated_at` (falls back to file mtime)
  - Transcript for preview: subsequent lines with role-bearing events

### VS Code Chat

- Session files: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/<sessionUUID>.jsonl`
- Workspace resolution: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/workspace.json` → `{ folder: "file:///…" }`.
- Log-structured JSONL:
  - Line 0: `{kind: 0, v: {version, creationDate, initialLocation, responderUsername, sessionId, requests: [...], ...}}` — the initial snapshot.
  - Lines 1+: `{kind: 1, k: [...path], v: newValue}` — deltas applied to the snapshot's state tree.
- Derivations:
  - `sessionId` = snapshot `sessionId`
  - `title` = first user request's text (truncated to 60 chars); fallback: `"Chat in <folder-basename>"`
  - `projectPath` = folder from `workspace.json` (URI decoded, stripped of `file://`)
  - `updatedAt` = file mtime (avoids replaying deltas just to find latest timestamp)
  - Transcript for preview: reconstructed by scanning `requests` in the snapshot plus any deltas that modify `requests`

## Approach: pattern-match Bob, one scanner per source

`SessionManager` gains two new private methods that follow the exact shape of the existing `_scanBobSessions()`:

```
private async _scanCodexSessions(): Promise<ClaudeSession[]>
private async _scanChatSessions(): Promise<ClaudeSession[]>
```

`_scanSessions()` calls all four scanners and merges the results (Claude, Bob, Codex, Chat) with no cross-source deduplication (each source has its own `sessionId` namespace; collisions are astronomically unlikely with UUIDs).

The `source` type union in `ClaudeSession` widens:

```ts
source: 'claude' | 'bob' | 'codex' | 'chat';
```

Everything downstream (`getRecentExchanges`, `exportSessionAsJson`, view provider, webview) grows one branch per new source. No architectural refactor.

## Component changes

### `src/SessionManager.ts`

- Widen `ClaudeSession.source` to `'claude' | 'bob' | 'codex' | 'chat'`.
- Add `_scanCodexSessions()`:
  - Read `~/.codex/session_index.jsonl` line by line to build `Map<sessionId, {threadName, updatedAt}>`. Missing file → empty map.
  - Walk `~/.codex/sessions/**/rollout-*.jsonl` (bounded to files whose mtime is within the last 90 days for cost control — configurable if needed later).
  - For each rollout file, read line 0 only; if `type === "session_meta"`, extract `id` and `cwd`.
  - Cross-reference index for `title`/`updatedAt`; fall back to file mtime / `cwd` basename when the index has no entry.
  - Record `filePath` in `_sessionFilePaths` so `getRecentExchanges` and export can find it.
- Add `_scanChatSessions()`:
  - Walk `~/Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.jsonl`. Skip `emptyWindowChatSessions/*`.
  - For each file, read line 0. If `v.sessionId` is present, use it; skip otherwise.
  - Resolve the sibling `<hash>/workspace.json` for the folder path. Fallback: leave `projectPath` empty, `projectName` = `"(no workspace)"`.
  - Title: pull first request from `v.requests[0]` (structure varies; try `.message.text`, `.messageText`, `.text` in that order); truncate to 60 chars. Fallback: `"Chat in " + projectName`.
  - `updatedAt` = file mtime (fast; deltas would be authoritative but cost too much per scan).
  - Record `filePath` in `_sessionFilePaths`.
- Extend `getRecentExchanges(sessionId)` to dispatch on `_sessionSources.get(sessionId)`:
  - `'codex'` → new `_getCodexRecentExchanges(filePath)`: read last ~32 KB, parse events looking for `role`-bearing records (`user_message`, `assistant_message`, or equivalent — verify against the rollout format), emit `MessageExchange` up to 6 records.
  - `'chat'` → new `_getChatRecentExchanges(filePath)`: parse line 0 snapshot's `requests[]`; for each request pull the user text (`.message.text` fallback chain above) and the response text (structure differs by responder). Cap at 6.
- Extend `exportSessionAsJson(sessionId)` similarly:
  - `'codex'` → return the raw `.jsonl` file path directly (envelope-compatible — same JSONL shape as Claude).
  - `'chat'` → build a `.chat.json` envelope (mirroring the `.bob.json` shape from the reckon PR): `{session_id, harness: 'chat', username, created_at, title, messages[]}`. Write to a temp file with a `cleanup` fn.
- Watcher setup in `constructor`: add file watchers for
  - `~/.codex/session_index.jsonl` (create/change → refresh)
  - `~/Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.jsonl` — glob watcher, debounced 500 ms
  Same pattern as `bobDbWatcher`.

### `src/SessionSwitcherViewProvider.ts`

- `_openSessionLocal(sessionId)` gains two branches:
  - `'codex'` → `vscode.commands.executeCommand('openai.chatgpt.focus')` (verify command ID against the installed OpenAI extension; fall back to opening the Codex sidebar via view container ID).
  - `'chat'` → `vscode.commands.executeCommand('workbench.action.chat.open')` (the built-in Chat panel focus command).
- `addFromHistory` case: same two branches, mirror of above.
- No changes to `_closeTabForSession` (Codex/Chat don't expose per-session editor tabs to close).

### `src/webview/main.js`

- `buildTab()` and `buildHistoryItem()`: add two more source badges, mirroring the existing `tab-badge--bob` branch. Labels: `"Codex"`, `"Chat"`.
- Preview card: pass the correct assistant name in the `sessionPreview` handler (`"Codex"` / `"Chat"` in addition to `"Bob"` / `"Claude"`).

### `src/webview/styles.css`

- Add `.tab-badge--codex` and `.tab-badge--chat` color rules. Distinct colors picked from VS Code theme variables:
  - Codex: `#00a67d` (Codex/OpenAI green)
  - Chat: `#6b6b6b` (neutral gray, since VS Code Chat is provider-agnostic)

### `package.json`

- Bump `version` to `0.0.7`.
- No new commands or config settings (upload path from the reckon PR is reused).

## Behaviour details

**Sorting.** The existing top-20-by-recency view mixes all four sources by `updatedAt`. No change needed in the view provider.

**Status.** Both Codex and Chat sessions land as `status: 'idle'`. Neither storage exposes an unambiguous "currently running" signal we can cheaply detect. The green/gray dot in the UI will read gray for these. Follow-up PR could add "running" detection if we discover a signal (e.g., a lock file, or an active process check).

**Errors during scan.** Any per-file parse error is logged to the extension host console and the file skipped. A source scanner throwing at the top level (e.g., `~/.codex/` missing) → the whole source contributes zero sessions; other sources are unaffected.

**Refresh.** Watchers (see above) trigger `_scanSessions` on any relevant filesystem change, same as today for Bob and Claude.

## Files changed (target diff)

- `src/SessionManager.ts` — most of the work (~250 lines added: two scanners + two exchange extractors + two export branches + widened type)
- `src/SessionSwitcherViewProvider.ts` — ~30 lines (two branches in `_openSessionLocal`, two in `addFromHistory`, badges pass-through)
- `src/webview/main.js` — ~40 lines (badges + preview labels)
- `src/webview/styles.css` — ~10 lines (two badge colors)
- `package.json` — one-line version bump
- Tests — see below

## Testing

New unit tests in `src/test/SessionManager.test.ts`:

1. `_scanCodexSessions` builds a temp `~/.codex/` layout with a session_index.jsonl + two rollout files and asserts the resulting ClaudeSessions have correct `sessionId`, `title`, `projectPath`, `updatedAt`, `source: 'codex'`.
2. `_scanCodexSessions` falls back to file mtime and cwd basename when the session_index has no entry.
3. `_scanChatSessions` builds a temp `workspaceStorage/<hash>/chatSessions/uuid.jsonl` layout with a workspace.json and asserts extraction (title from first request, projectPath from folder URI).
4. `_scanChatSessions` falls back to `"Chat in <basename>"` when `requests[]` is empty and `"(no workspace)"` when `workspace.json` is missing.
5. `_scanSessions` merges four sources without dedup and preserves per-source `sessionId`s.
6. `exportSessionAsJson` returns the raw jsonl path for a Codex session (no envelope needed).
7. `exportSessionAsJson` produces a `.chat.json` temp envelope with expected keys for a Chat session and provides a working `cleanup()`.

No new tests for `SessionSwitcherViewProvider` beyond re-running the existing top-20 tests (they don't distinguish source and continue to pass).

## Non-goals

- **Renaming or moving VS Code Chat sessions from inside our extension.** Read-only.
- **"Running" status detection for Codex/Chat.** Deferred until we identify a signal.
- **Per-session focus for Chat.** VS Code's built-in Chat panel does not expose a per-session API surface for extensions to switch active session. Clicking a Chat row focuses the panel; the user picks the session inside it.
- **Bulk deletion / archive from our extension.** Out of scope; existing Bob/Claude behavior mirrored.
- **`SessionSource` abstraction refactor.** Considered and deferred; four is not yet the critical mass for the churn.

## Risk

Low-to-medium. Read-only scanners over well-defined on-disk formats. The main risks:

- **Chat format drift.** VS Code owns the `chatSessions/*.jsonl` schema and can change it without notice. Mitigation: defensive parsing with fallbacks; per-file skip on parse errors.
- **Codex format drift.** OpenAI CLI's rollout format is undocumented and versioned via `payload.cli_version`. Mitigation: same as above.
- **Watcher cost.** Globbing chatSessions across all workspaces may add file-watcher pressure. Mitigation: debounce 500 ms; consider `IgnoreCreateEvents: true` if noisy.
- **Empty title cases.** Both sources can have empty user-facing text at the start. Fallback labels are defined for every case.
