# Design: Live Multi-Session Switcher

**Date:** 2026-06-14  
**Status:** Approved

---

## Problem

The Claude Code VS Code extension supports multiple concurrent sessions as editor tabs
(`retainContextWhenHidden: true` keeps each Claude subprocess alive when its tab is hidden).
However it provides no session switcher UI. Our extension fills that gap, but the current
implementation has two bugs:

1. **Tab bar shows all disk sessions** — `SessionManager` scans `~/.claude/projects/` and
   surfaces hundreds of historical sessions. The user cannot identify which sessions are
   currently live.

2. **Switch command is correct but the tab set is wrong** — `claude-vscode.primaryEditor.open(sessionId)`
   already does the right thing: reveals an existing panel, or opens a new editor tab in the
   current window (never a new OS window). The bug is that the tab bar is populated from disk
   instead of from an explicit user-managed registry, so the wrong sessions appear.

---

## Key facts from Claude Code source (v2.1.138)

- `createPanel(sessionId, prompt, ViewColumn.Active)` — if `sessionPanels.get(sessionId)`
  exists, calls `panel.reveal()` (focuses the tab, same window). If not, creates a new
  WebviewPanel in `ViewColumn.Active` (new editor tab, same window, never new OS window).
- `data-initial-session="{sessionId}"` is embedded in the webview HTML so Claude Code resumes
  the correct session when the panel is created.
- `retainContextWhenHidden: true` — the webview JS state and the Claude subprocess both
  survive when the tab is hidden. Background sessions keep running.
- `visibility_changed` notification is sent on hide/show but has no pause/stop logic.
- The URI handler `vscode://anthropic.claude-code/open?session=xxx` simply delegates to
  `claude-vscode.primaryEditor.open` — using the command directly is equivalent and preferred.

---

## Design

### Component 1: `LiveSessionRegistry`

A new class responsible for the ordered list of sessions in the tab bar.

```typescript
class LiveSessionRegistry implements vscode.Disposable {
  // Persisted in ExtensionContext.globalState under key 'liveSessionIds'
  private _ids: string[];  // ordered, most-recently-added last

  add(sessionId: string): void      // adds to end if not present; fires onDidChange
  remove(sessionId: string): void   // removes; fires onDidChange
  getIds(): string[]                // returns shallow copy

  readonly onDidChange: vscode.Event<string[]>
}
```

**Persistence:** `globalState.get/update('liveSessionIds', [])`. Survives VS Code restarts.
Sessions remain in the registry even when their Claude panel is closed — the panel re-opens
on next click (resuming the session via `data-initial-session`).

**No automatic purging.** The user removes sessions explicitly with ×. If a JSONL file is
deleted on disk, `SessionManager` returns null for that session ID; the ViewProvider omits
it from the rendered tab bar silently.

### Component 2: `SessionManager` (narrowed role)

Unchanged parsing logic. Role narrows:
- **Tab metadata:** Given a list of session IDs from `LiveSessionRegistry`, return parsed
  `ClaudeSession` objects (title, projectName, status, updatedAt).
- **History:** `getRecentSessions(limit: number)` — returns the N most-recently-modified
  sessions from disk, excluding IDs already in the registry.
- **FileSystemWatcher** — kept; fires `onDidChangeSessions` to refresh metadata.

Remove: the watcher no longer drives what appears in the tab bar. It only refreshes
metadata (title, status) for sessions already in the registry.

### Component 3: `SessionSitterViewProvider` (updated wiring)

Listens to both `LiveSessionRegistry.onDidChange` and `SessionManager.onDidChangeSessions`.
On either event, pushes an `updateSessions` message to the webview containing only the
sessions in the registry (with metadata from `SessionManager`).

Message handlers:

| Message | Action |
|---|---|
| `switchSession` | `vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId)` |
| `newSession` | `vscode.commands.executeCommand('claude-vscode.newConversation')` |
| `removeTab` | `registry.remove(sessionId)` |
| `loadHistory` | query `SessionManager.getRecentSessions(50)`, push `updateHistory` to webview |
| `addFromHistory` | `registry.add(sessionId)` + `primaryEditor.open(sessionId)` |
| `ready` | push current session list |

### Component 4: Auto-adding new sessions

When `FileSystemWatcher.onDidCreate` fires for a new `.jsonl` file AND the file's `mtime`
is within 60 seconds of now, the session is considered freshly created and is auto-added to
the registry. This covers the common flow: user clicks +, Claude Code creates a new session
file, it auto-appears in the tab bar. It also covers sessions opened directly from the
command palette or terminal, as long as they are recent.

If `SessionManager` cannot yet parse the new file (the JSONL has no user message yet because
Claude Code hasn't written the first exchange), the ViewProvider renders a placeholder tab
labelled "Starting…" until the next `onDidChangeSessions` event brings parseable metadata.

`onDidChange` events (edits to existing files) do **not** auto-add — they only refresh
metadata for sessions already in the registry.

### Component 5: Webview UI additions

The existing tab strip UI is kept. Two additions:

1. **History panel** — a collapsible section below the tab strip, toggled by a "History"
   button. When opened, sends `loadHistory` to the extension and renders a list of recent
   sessions. Clicking a history item sends `addFromHistory`.

2. **Empty-state improvement** — when the registry is empty AND history has no sessions,
   show "No sessions yet — click + to start one". When registry is empty but history
   exists, show "No pinned sessions — expand History to resume one".

---

## Data flow

```
User clicks "+" button
  → newSession message → claude-vscode.newConversation
  → Claude Code opens new panel, creates new JSONL file (~1-3s later)
  → FileSystemWatcher onDidCreate fires
  → file mtime < 30s → registry.add(newSessionId)
  → onDidChange fires → ViewProvider pushes updated tab list to webview
  → New tab appears in bar

User clicks a tab
  → switchSession message → claude-vscode.primaryEditor.open(sessionId)
  → If panel exists in Claude Code: panel.reveal() — focuses tab, same window
  → If panel was closed: new editor tab opens, Claude Code resumes session
  → Background sessions keep running (retainContextWhenHidden)

User clicks × on a tab
  → removeTab message → registry.remove(sessionId)
  → Tab disappears from bar; Claude Code panel is NOT closed (session stays live)

User expands History
  → loadHistory message → SessionManager.getRecentSessions(50)
  → History list rendered in webview
  → User clicks a history item → addFromHistory → registry.add + primaryEditor.open
```

---

## Files changed

| File | Change |
|---|---|
| `src/LiveSessionRegistry.ts` | New — registry with globalState persistence |
| `src/SessionManager.ts` | Narrow role: add `getRecentSessions(limit)`, remove auto-tab-bar logic |
| `src/SessionSitterViewProvider.ts` | Wire to registry; handle new message types |
| `src/extension.ts` | Instantiate `LiveSessionRegistry`; pass to provider |
| `src/webview/main.js` | Add history panel toggle + addFromHistory messages |
| `src/webview/styles.css` | Style history panel |

---

## What is NOT changing

- `claude-vscode.primaryEditor.open(sessionId)` — already the correct switch command
- JSONL parsing logic in `SessionManager` — unchanged
- Webview tab strip HTML/CSS structure — kept, extended only
- CSP, nonce, webview security model — unchanged
- `package.json` manifest — unchanged

---

## Verification

1. Open VS Code. Session tab bar shows empty (or previously pinned sessions from globalState).
2. Click + → new Claude session opens as editor tab → auto-appears in tab bar.
3. Click + again → second session opens → two tabs in bar, both Claude processes running.
4. In session 2, start a long task. Switch to session 1 by clicking its tab in the bar.
5. Confirm session 2's Claude process continues running in the background (check its editor
   tab — work is progressing even though it's hidden).
6. Click the session 2 tab in the bar → its editor tab comes to front. No new window opened.
7. Click × on a tab → it disappears from the bar. Its Claude editor tab stays open.
8. Restart VS Code → previously pinned sessions reappear in the tab bar (globalState).
9. Click a session whose editor tab was closed → new editor tab opens, session resumes.
10. Expand History → recent sessions appear. Click one → added to bar and opened.
