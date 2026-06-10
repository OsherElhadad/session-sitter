# Architecture: Claude Code Session Switcher Extension

## Context

The Claude Code VS Code extension supports multiple sessions but has no convenient way to manage them as tabs in the Secondary Sidebar. Each session must be opened individually via the Command Palette or keyboard shortcuts. The goal is a lightweight companion extension that adds a tabbed session browser/switcher to the Secondary Sidebar — without reimplementing any Claude Code functionality.

---

## How It Works: Key Discovery

The Claude Code extension registers a URI handler at `vscode://anthropic.claude-code/open` that accepts:
- `?session=<uuid>` — resume a specific existing session
- `?prompt=<text>` — pre-fill the prompt box

This is the **core mechanism** the extension will use. Calling:
```typescript
vscode.env.openExternal(
  vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${sessionId}`)
)
```
...from our extension causes VS Code to route the URI back to Claude Code, which loads that session in the sidebar/tab (respecting `claudeCode.preferredLocation`).

No reimplementation of Claude Code. No fragile command-ID hacks. Just a URI call.

---

## Session Data: What's Available

Claude Code stores all session transcripts locally at:
```
~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
```

Each `.jsonl` file is newline-delimited JSON. The first `user`-type record in each file contains:
```json
{
  "type": "user",
  "message": { "content": "the first message text..." },
  "timestamp": "2026-06-03T06:20:07.401Z",
  "sessionId": "d61ee3f8-38ea-4316-8b4e-c90a8dd2e45e",
  "cwd": "C:\\Users\\332543756\\my-project"
}
```

From this we can extract, **without any Claude Code API**:
- Session UUID (from filename)
- Session title (first user message, truncated to ~60 chars)
- Project name (last segment of `cwd`)
- Timestamp (last modified time of the file)

Claude Code also maintains `~/.claude/history.jsonl` with entries like:
```json
{ "display": "the command text", "project": "C:\\...", "sessionId": "...", "timestamp": 1776235378150 }
```
This is useful as a quick index of recent sessions without parsing full transcripts.

---

## Extension Architecture

### Project Structure
```
claude-session-switcher/
├── package.json                       # Manifest: views, commands, activation
├── src/
│   ├── extension.ts                   # activate(), registers providers + commands
│   ├── SessionManager.ts              # Reads ~/.claude/projects/, parses sessions, FileSystemWatcher
│   ├── SessionSwitcherViewProvider.ts # WebviewViewProvider for the sidebar panel
│   └── webview/
│       ├── main.js                    # Tab UI: renders tabs, handles click events
│       └── styles.css                 # Tab strip styling (dark/light theme aware)
└── resources/
    └── icon.svg                       # Activity bar icon
```

### Component 1: `SessionManager`
Responsible for all session data. No VS Code UI concerns.

```typescript
interface ClaudeSession {
  sessionId: string;    // UUID (from filename)
  projectName: string;  // last path segment of cwd
  projectPath: string;  // full cwd
  title: string;        // first user message, truncated to 60 chars
  updatedAt: Date;      // file mtime (last activity)
}
```

- Reads `~/.claude/projects/` using Node.js `fs` APIs
- For each `.jsonl` file: reads first ~3KB to extract the first `user` record
- Uses `vscode.workspace.createFileSystemWatcher('**/.claude/projects/**/*.jsonl')` to detect new sessions in real time
- Emits an event (`onDidChangeSessions`) when the list changes
- Caches parsed sessions in memory; invalidates when files change

### Component 2: `SessionSwitcherViewProvider`
Implements `vscode.WebviewViewProvider`. Registered for the secondary sidebar view.

**Responsibilities:**
- Renders the tab strip HTML in a WebView (hosted in secondary sidebar)
- Listens to `SessionManager.onDidChangeSessions` and calls `webviewView.webview.postMessage()` to update the UI
- Handles `onDidReceiveMessage` from the WebView:
  - `switchSession`: calls `vscode.env.openExternal(Uri.parse('vscode://anthropic.claude-code/open?session=' + id))`
  - `newSession`: calls `vscode.commands.executeCommand('claude-vscode.newConversation')`
  - `removeTab`: removes session from local "pinned tabs" list (does not delete session data)

### Component 3: The WebView UI (`webview/main.js`)
A plain HTML/CSS/JS tab strip — no framework needed. Communicates with the extension via `acquireVsCodeApi().postMessage()`.

**UI layout:**
```
[ + ] [ Session 1 × ] [ Session 2 × ] [ Session 3 × ]
```
- Tabs are horizontally scrollable if many sessions
- Each tab shows: session title (first message, truncated) + project name badge
- `×` button removes the tab from the strip (doesn't delete data)
- `+` button creates a new Claude Code session
- Below the tab strip: a collapsible "History" section showing all sessions from `~/.claude/history.jsonl`, searchable, click to add to tab strip

---

## Extension Manifest (`package.json`) Key Points

```json
{
  "contributes": {
    "viewsContainers": {
      "secondarySidebar": [{
        "id": "claude-session-switcher",
        "title": "Claude Sessions",
        "icon": "resources/icon.svg"
      }]
    },
    "views": {
      "claude-session-switcher": [{
        "type": "webview",
        "id": "claudeSessionSwitcher.view",
        "name": "Sessions"
      }]
    }
  },
  "extensionDependencies": ["Anthropic.claude-code"],
  "activationEvents": ["onStartupFinished"]
}
```

`extensionDependencies` ensures Claude Code is installed and activated before our extension runs.

---

## Session Switching Flow (End-to-End)

```
User clicks tab in WebView
  → WebView JS: vscodeApi.postMessage({ type: 'switchSession', sessionId: 'xxx' })
  → SessionSwitcherViewProvider.onDidReceiveMessage
  → vscode.env.openExternal(Uri.parse('vscode://anthropic.claude-code/open?session=xxx'))
  → OS protocol handler routes back to VS Code
  → Claude Code URI handler receives it
  → Claude Code loads session 'xxx' in its panel/tab
```

---

## New Session Flow

```
User clicks "+" button
  → WebView JS: vscodeApi.postMessage({ type: 'newSession' })
  → vscode.commands.executeCommand('claude-vscode.newConversation')
  → Claude Code opens a new blank session
  → FileSystemWatcher detects new .jsonl file created
  → SessionManager emits onDidChangeSessions
  → SessionSwitcherViewProvider pushes updated session list to WebView
  → New tab appears automatically
```

---

## Limitations to Communicate

1. **Session switching is not instant UI**: `vscode.env.openExternal` with a `vscode://` URI is a round-trip through the OS. It will work but may feel slightly slower than native tab switching (~50-200ms extra).

2. **Titles come from raw JSONL**: Claude Code's AI-generated titles (shown in its own session list) are not accessible from outside the extension. We derive titles from the first user message ourselves — which is a reasonable approximation.

3. **No live "active session" indicator**: We cannot query Claude Code to know which session is currently open. The tab strip will not auto-highlight the current session unless we track this ourselves via file mtime heuristics.

4. **Claude Code must be installed**: `extensionDependencies` enforces this at install time.

---

## Verification Plan

1. Install both Claude Code and this extension in VS Code
2. Open the Secondary Sidebar — confirm the "Claude Sessions" panel appears
3. Start a new Claude session — confirm it appears as a new tab automatically (FileSystemWatcher working)
4. Click a tab — confirm Claude Code switches to that session (URI handler working)
5. Click "+" — confirm a new Claude session opens
6. Click "×" on a tab — confirm it disappears from the strip but the session data is not deleted
7. Open history panel — confirm all past sessions appear and are searchable
8. Click a history session — confirm it's added to the tab strip and opens in Claude Code
