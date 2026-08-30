# Design: IBM Bob Session Support

**Date:** 2025-06-30  
**Status:** Approved  
**Approach:** A — Unified `SessionManager` with `source` field

---

## Overview

Extend the Session Sitter to also display and switch IBM Bob sessions in the same unified panel, interleaved with Claude sessions. Each row shows a "Bob" or "Claude" source badge so the user can tell them apart at a glance. All existing Claude features — status indicators, history, hover preview, cross-window focus, new session button — are replicated for Bob sessions.

---

## Data Model

Add a `source` discriminator to `ClaudeSession`:

```typescript
export interface ClaudeSession {
  sessionId:   string;
  projectName: string;
  projectPath: string;
  title:       string;
  updatedAt:   Date;
  status:      'idle' | 'waiting' | 'active';
  source:      'claude' | 'bob';   // NEW
}
```

The field flows through unchanged to the webview. All existing code that does not reference `source` continues to work without modification.

---

## Bob Session Storage

IBM Bob (a VS Code fork built on Cline/Roo) stores task data under:

```
~/.config/IBM Bob/User/globalStorage/ibm.bob-code/tasks/<task-uuid>/
  ui_messages.json          — array of {ts, type, say|ask, text, partial?, images?}
  api_conversation_history.json — messages array; first item contains cwd in system text
  task_metadata.json        — files-in-context tracking (not used for session display)
```

**No PID liveness files exist.** Bob does not write `~/.bob/sessions/<pid>.json` equivalents.

### Extracting session fields

| Field | Source | Method |
|---|---|---|
| `sessionId` | directory name | UUID directory name |
| `title` | `ui_messages.json` | First `{type:"say", say:"text"}` record's `.text`, truncated to 60 chars |
| `projectPath` | `api_conversation_history.json` | Regex `# Current Workspace Directory \((.+?)\)` in first message's text block |
| `projectName` | derived | `path.basename(projectPath)` |
| `updatedAt` | `ui_messages.json` mtime | `fs.stat()` |
| `status` | `ui_messages.json` tail | See status table below |
| `source` | constant | `'bob'` |

### Bob status inference

Scan `ui_messages.json` backward from the last record to find the first meaningful entry:

| Last record condition | Status |
|---|---|
| `{type:"say", say:"api_req_started"}` | `active` |
| `{type:"ask", ask:"tool"}` | `active` |
| `{type:"say", say:"command_output"}` + file modified < 30 s | `active` |
| `{type:"ask", ask:"completion_result"}` | `idle` |
| `{type:"say", say:"completion_result"}` | `idle` |
| `{type:"say", say:"text"}` and no `api_req_started` record exists yet in the file | `waiting` |
| file modified < 30 s (fallback) | `active` |
| anything else | `idle` |

### Active session detection (liveness)

Bob has no PID files, so the same fallback chain used for Claude applies:

1. **Tab API** — duck-type `input?.viewType?.includes('bobChatView')` to find open Bob panels → sessions whose title matches an open tab are "live"
2. **2-hour recency window** — last resort when no tab matches

---

## `SessionManager` Changes

### New scanner

Add `_scanBobSessions(): Promise<ClaudeSession[]>` that:

1. Resolves `BOB_TASKS_DIR = ~/.config/IBM Bob/User/globalStorage/ibm.bob-code/tasks`
2. Lists task directories (each is a UUID)
3. Calls `_parseBobTaskDir(taskDir)` per directory, catching errors silently
4. Returns sessions sorted by `updatedAt` descending

Add `_parseBobTaskDir(dir: string): Promise<ClaudeSession | null>` that reads `ui_messages.json` and `api_conversation_history.json` as described above.

### Merged scan

Rename existing `_scanSessions` internals to `_scanClaudeSessions`. The top-level `_scanSessions` calls both, merges the arrays, and sorts by `updatedAt` descending.

### File watcher

Extend the `FileSystemWatcher` to also watch:
```
~/.config/IBM Bob/User/globalStorage/ibm.bob-code/tasks/**/*.json
```
This ensures Bob task updates trigger the same debounced refresh as Claude JSONL changes.

### `getRecentExchanges` extension

When `source === 'bob'`, read exchanges from `ui_messages.json` instead of JSONL:
- **User messages:** `{type:"say", say:"text"}` records where the text appears before any `api_req_started` (i.e. user-originated)
- **Assistant messages:** `{type:"say", say:"text", partial:false}` records that appear after an `api_req_started`

Store the `ui_messages.json` path in `_sessionFilePaths` keyed by `sessionId`, same as JSONL paths for Claude.

---

## `SessionSitterViewProvider` Changes

### Tab detection

Extend `_openClaudeTabLabels()` to also match Bob panels:

```typescript
if (input?.viewType?.includes('claudeVSCodePanel') ||
    input?.viewType?.includes('bobChatView')) {
  labels.add(tab.label);
}
```

### Session switching dispatch

In `_openSessionLocal(sessionId)`, branch on `session.source`:

```typescript
if (session.source === 'bob') {
  void vscode.commands.executeCommand('bobChatView.focus');
} else {
  // existing Claude logic
}
```

Bob has no per-session open-by-ID command; `bobChatView.focus` brings the Bob sidebar to front. Cross-window focus (the focus-file mechanism) is source-agnostic and works unchanged.

### New session

Add a `newBobSession` message handler:

```typescript
case 'newBobSession':
  void vscode.commands.executeCommand('bob-code.task.pickWorkspace');
  break;
```

The existing `newSession` message (Claude) is unchanged.

### Close tab

In `_closeTabForSession`, check `input?.viewType?.includes('claudeVSCodePanel')` before closing (already implicitly the case). Bob sessions send no `removeTab` message — the `×` button is not rendered for them in the webview.

### History: `addFromHistory`

Extend the `addFromHistory` handler to dispatch by source:

```typescript
case 'addFromHistory': {
  const session = allSessions.find(s => s.sessionId === sessionId);
  if (session?.source === 'bob') {
    void vscode.commands.executeCommand('bobChatView.focus');
  } else {
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  }
  break;
}
```

---

## Webview Changes (`main.js` + `styles.css`)

### Source badge

In `buildTab(session)` and `buildHistoryItem(session)`, prepend a source badge when `session.source === 'bob'`:

```javascript
if (session.source === 'bob') {
  const sourceBadge = document.createElement('span');
  sourceBadge.className = 'tab-badge tab-badge--bob';
  sourceBadge.textContent = 'Bob';
  textEl.prepend(sourceBadge);
}
```

`tab-badge--bob` gets a distinct background color (`#1f70c1`) vs the muted gray project badge.

### Close button

Render the `×` close button only for Claude sessions:

```javascript
if (session.source !== 'bob') {
  // append closeBtn
}
```

### New session buttons

Replace the single `+` button with two buttons:

```html
<button id="new-session-btn"     title="New Claude Session">+</button>
<button id="new-bob-session-btn" title="New Bob Session">+B</button>
```

`new-session-btn` sends `{type: 'newSession'}` (unchanged).  
`new-bob-session-btn` sends `{type: 'newBobSession'}`.

### Session objects

The `source` field is included in all session objects pushed to the webview via `updateSessions`, `updateHistory`, and `sessionPreview` messages. No webview-side routing logic needed beyond the badge/close-button checks.

---

## Extension Manifest (`package.json`)

No new commands, views, or dependencies. `extensionDependencies` keeps only `Anthropic.claude-code` — Bob is a separate IDE entirely (not a VS Code extension), so no dependency declaration is possible or needed. The Bob scanner gracefully returns `[]` when the tasks directory doesn't exist.

---

## Error Handling

- Bob tasks directory absent → `_scanBobSessions` returns `[]` silently (same as Claude projects dir)
- Malformed `ui_messages.json` → skip that task directory
- Missing `api_conversation_history.json` → `projectPath` defaults to `''`, `projectName` defaults to `''`
- `bobChatView.focus` command unavailable (not running in Bob) → VS Code swallows unknown command silently, no user-visible error

---

## Tests

New tests in `src/test/SessionManager.test.ts`:

- `_parseBobTaskDir` returns `null` when `ui_messages.json` is absent or has no user message
- Title extracted from first user `say:text` record, truncated to 60 chars
- `projectPath` extracted via regex from `api_conversation_history.json`
- Status: `api_req_started` → `active`; `completion_result` → `idle`; user text before any response → `waiting`; recent mtime fallback → `active`
- `source` is `'bob'` on all returned sessions
- Merged scan sorts both Claude and Bob sessions by `updatedAt` descending

New tests in `src/test/SessionSitterViewProvider.test.ts`:

- Switching a Bob session calls `bobChatView.focus`, not `claude-vscode.primaryEditor.open`
- `newBobSession` message calls `bob-code.task.pickWorkspace`
- Bob session rows have no `removeTab` message on close (no `×` button rendered)
- `addFromHistory` for a Bob session calls `bobChatView.focus`

---

## Non-Goals

- No attempt to detect which specific Bob task is currently visible (Bob exposes no API for this)
- No Bob session close/delete from the panel (no public Bob command available)
- No support for Bob running on Windows without WSL (same Linux/WSL-only constraint as Claude)
