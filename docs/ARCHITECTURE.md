# Architecture: Claude Session Switcher

## Overview

Claude Code supports multiple concurrent sessions — each with `retainContextWhenHidden: true`, meaning background sessions keep running even when their panel is hidden. What it lacks is a panel that shows which sessions are alive and lets you switch between them. This extension fills that gap.

The design goal: **no reimplementation of Claude Code internals, no fragile API hacks — only read what Claude Code already writes to disk**.

---

## Project Structure

```
claude-session-switcher/
├── src/
│   ├── extension.ts                   # activate() — wires everything together
│   ├── SessionManager.ts              # Reads ~/.claude/, detects live sessions, polls
│   ├── SessionSwitcherViewProvider.ts # WebviewViewProvider — drives the sidebar UI
│   └── webview/
│       ├── main.js                    # Tab strip + history panel (vanilla JS)
│       └── styles.css                 # Theme-aware styles
├── src/test/
│   ├── LiveSessionRegistry.test.ts    # Unit tests for registry logic
│   └── SessionManager.test.ts         # Unit tests for JSONL parsing + status
└── resources/
    └── icon.svg
```

---

## Session Detection: How We Know What's Running

This is the core problem the extension solves, and it required more depth than expected.

### The files Claude Code writes

**`~/.claude/sessions/<pid>.json`** — created for each active Claude process:

```json
{
  "pid": 1641086,
  "sessionId": "3bfad019-767d-4942-9c40-fb5ccb313ee1",
  "cwd": "/home/user/my-project",
  "startedAt": 1781443340390,
  "procStart": "33842439",
  "entrypoint": "claude-vscode",
  "kind": "interactive"
}
```

**`~/.claude/ide/<port>.lock`** — created by the VS Code extension host when it connects:

```json
{
  "pid": 6486,
  "workspaceFolders": ["/home/user/my-project"],
  "transport": "ws",
  "authToken": "..."
}
```

**`~/.claude/projects/<encoded-path>/<uuid>.jsonl`** — the session transcript, newline-delimited JSON.

### The detection algorithm (`getActiveSessionIds`)

```
For each file in ~/.claude/sessions/:
  1. Parse pid, sessionId, procStart, entrypoint, startedAt
  2. Skip if entrypoint != "claude-vscode"          (ignore CLI sessions)
  3. Skip if startedAt < (now - 24h)                (ignore zombie processes)
  4. process.kill(pid, 0)  →  throws if dead         (PID liveness check)
  5. Read /proc/<pid>/stat field 21 (starttime)      (kernel jiffies since boot)
  6. Compare to procStart  →  skip if mismatch       (PID recycling guard)
  7. Add sessionId to the active set
```

The `procStart` comparison is the key insight: Linux can reuse a PID after a process dies. By storing and comparing the kernel start-time, we can distinguish the *original* Claude process from an unrelated process that happened to get the same PID later.

### Why not VS Code's tab API?

`vscode.window.tabGroups` would give us tab titles and viewTypes directly. It doesn't work from the remote (WSL) extension host — window APIs are local-host-only. The `~/.claude/sessions/` approach works from the remote host because it reads the local filesystem.

### Fallback chain

```
1. Tab API (duck-typed viewType check)      →  if produces matches: use tab titles
2. ~/.claude/sessions/ PID liveness         →  primary detection (always tried)
3. 2-hour recency window                    →  last resort if session files unreadable
```

---

## Session Data: Reading JSONL Files

### File location

```
~/.claude/projects/<encoded-workspace-path>/<session-uuid>.jsonl
```

The workspace path is encoded by replacing every `/` with `-`, so `/home/user/project` becomes `-home-user-project`.

### Parsing strategy

The extension reads in 16 KB chunks up to 256 KB, looking for two record types:

**`user` record** (first user message → fallback title):
```json
{
  "type": "user",
  "message": { "content": [{"type": "text", "text": "Fix the auth bug"}] },
  "cwd": "/home/user/project"
}
```

**`ai-title` record** (Claude Code's AI-generated title, preferred):
```json
{
  "type": "ai-title",
  "aiTitle": "Fix authentication bug"
}
```

Once both are found (or 256 KB is read), parsing stops. The `ai-title` matches what Claude Code shows in its tab bar.

### Status detection

The last 32 KB of the file is read and scanned *backward* for the most recent meaningful record:

| Last record type | Status | Indicator |
|---|---|---|
| `tool_use` or `tool_result` | `active` | 🟢 spinning ring |
| `assistant` with `tool_use` in content | `active` | 🟢 spinning ring |
| `assistant` + file modified < 30 s ago | `active` | 🟢 spinning ring (still streaming) |
| `user` | `waiting` | 🟡 pulsing dot |
| `pr-link` or `last-prompt` | `idle` | ⚫ dim dot |
| `assistant` + quiet 30 s+ | `idle` | ⚫ dim dot |

The `pr-link` and `last-prompt` records are terminal markers written by Claude CLI at task completion — seeing them means the session is definitively done even if a `user` record appears earlier in the file.

The 32 KB tail (vs the original 2 KB) is necessary because VS Code sessions write large `file-history-snapshot` records that would otherwise push recognizable records out of a smaller window.

### Excluded paths

The recursive JSONL scan skips directories named `subagents/` — these contain transcript files for parallel agent calls, not user-facing sessions.

---

## Components

### `SessionManager`

All session data, no UI. Owns:

- **Initial scan** on construction — async, fires `onDidChangeSessions` when done
- **FileSystemWatcher** on `~/.claude/projects/**/*.jsonl` — fast path for changes
- **5-second polling loop** — fallback for WSL2 where file watchers silently stop
- **Fingerprint comparison** — only fires `onDidChangeSessions` when sessions actually changed (avoids unnecessary redraws)
- **`getActiveSessionIds()`** — the PID liveness check described above
- **`getActiveWorkspacePaths()`** — workspace-level detection via `~/.claude/ide/*.lock` (used as secondary signal)

```typescript
interface ClaudeSession {
  sessionId: string;    // UUID from filename
  projectName: string;  // last segment of cwd
  projectPath: string;  // full cwd
  title: string;        // ai-title if available, else first user message (≤60 chars)
  updatedAt: Date;      // file mtime
  status: 'idle' | 'waiting' | 'active';
}
```

### `SessionSwitcherViewProvider`

Implements `WebviewViewProvider`. Wires `SessionManager` events and the VS Code tab API to the webview.

**Incoming events that trigger a refresh:**
- `sessionManager.onDidChangeSessions` — file content changed
- `vscode.window.tabGroups.onDidChangeTabs` — Claude Code tab opened/closed/renamed

**Messages from webview → extension:**

| Message | Action |
|---|---|
| `switchSession` | `claude-vscode.primaryEditor.open(sessionId)` |
| `newSession` | `claude-vscode.newConversation` |
| `removeTab` | Close the Claude Code editor tab via `tabGroups.close()` |
| `loadHistory` | Query sessions not in the live set, push `updateHistory` |
| `addFromHistory` | `claude-vscode.primaryEditor.open(sessionId)` |

**Session list logic:**
```
1. Check VS Code tabs for claudeVSCodePanel viewType → if matches found, show those
2. Otherwise: call getActiveSessionIds() → show sessions with live PIDs
3. Fallback: sessions with status != idle or modified < 2h
```

### Webview (`main.js` + `styles.css`)

Plain HTML/CSS/JS — no framework, no build step. Communicates exclusively via `acquireVsCodeApi().postMessage()`.

**UI layout:**
```
[ + ]                           ← new session button
[ Fix auth bug  claude-proj  × ]  ← session row (title + project badge + close)
[ Count to 20   claude-proj  × ]
[ Implement X   skillberry   × ]
[ History ▼ ]                   ← collapsible
  [ Past session 1              ]
  [ Past session 2              ]
```

Session rows respond to `updateSessions` messages. History responds to `updateHistory`. Both are pushed by the provider.

---

## Session Switching Flow

```
User clicks a session row
  → webview: postMessage({ type: 'switchSession', sessionId })
  → SessionSwitcherViewProvider
  → vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId)
  → Claude Code's createPanel():
      if sessionPanels.get(sessionId) exists → panel.reveal()   (same window)
      else → createWebviewPanel(... ViewColumn.Active ...)        (new editor tab)
  → Claude Code embeds sessionId in panel HTML as data-initial-session
  → Webview loads and resumes the session
```

The background session's Claude process was never stopped — `retainContextWhenHidden: true` kept its webview state alive. Switching is just making the panel visible again.

---

## Key Design Decisions

**Why read `~/.claude/sessions/` instead of watching JSONL mtime?**
JSONL mtime tells you *when* a session was last active, not *whether* it's running now. A session that finished 3 hours ago has an old mtime. A session that's been idle since morning but never closed has an old mtime too. PID liveness is the ground truth.

**Why the `procStart` check?**
Linux recycles PIDs. Without this check, a new unrelated process that happens to get an old Claude PID would appear as a "live" session. The kernel start-time stored in `procStart` makes the check unique per process instance.

**Why 24-hour `startedAt` filter?**
VS Code process trees can survive for days in WSL without a full restart. Sessions opened in a previous VS Code session accumulate as background processes. The 24-hour window filters these out — if you want them, they're in History.

**Why `claude-vscode.primaryEditor.open` instead of `vscode.env.openExternal`?**
`openExternal` with a `vscode://` URI goes through the OS URI handler, which may open a new VS Code window if multiple instances are running. The command executes directly in the correct extension host and calls `createPanel()` in the same window.

**Why not `vscode.window.tabGroups`?**
This API only works from the local (Windows) extension host. Our extension runs in the remote (WSL) extension host to access the WSL filesystem. The two can't run in the same host simultaneously without a significant refactor to use `vscode.workspace.fs` for all file I/O.
