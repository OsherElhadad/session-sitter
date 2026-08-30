# Cross-Window Session Focus

**Date:** 2026-06-18  
**Status:** Approved

## Problem

The session switcher shows sessions from all open IDE windows (read from
`~/.claude/projects/**/*.jsonl`). Clicking a session always calls
`claude-vscode.primaryEditor.open` in the **current** window, even when the
session belongs to a different window. The result is the session opens in the
wrong window instead of jumping to the window that already has it.

## Goal

When a user clicks a session in the active list:
- If it belongs to the **current window** → switch locally (existing behaviour,
  unchanged).
- If it belongs to a **different window** → bring that window to the OS
  foreground and focus the correct Claude panel there (main editor or secondary
  sidebar — Claude Code's own command handles the panel location).
- If focusing the foreign window **fails** for any reason → show a warning
  toast and do nothing. Never open the session in the wrong window.

The **History** panel (`addFromHistory`) is unchanged — history sessions have
no running window and always open locally.

## Mechanism

### Owner detection

`~/.claude/ide/<port>.lock` files are written by the Claude Code extension.
Each file maps a workspace to the extension-host PID running in that window:

```json
{
  "pid": 9999,
  "workspaceFolders": ["/home/user/myproject"],
  "ideName": "IBM Bob",
  "transport": "ws",
  "authToken": "..."
}
```

A session's `projectPath` (its `cwd`) is matched against `workspaceFolders`
using: `projectPath === wf || projectPath.startsWith(wf + '/')`.

The current window's extension-host PID is `process.pid`. If a live lock file
matches the session and has a different PID, it is the foreign owner.

### OS window focus

Each extension host has `VSCODE_IPC_HOOK_CLI` in its environment, pointing to
a Unix socket through which the `code` CLI communicates with that specific IDE
instance. Reading `/proc/<pid>/environ` (null-separated) extracts this value.

Running `execFile('code', [workspacePath], { env: { ...process.env, VSCODE_IPC_HOOK_CLI: targetSocket } })`
sends an "open" command to the foreign window's IDE, which brings it to the OS
foreground.

### Panel focus (within the target window)

Every session switcher instance watches for a focus-request file addressed to
its own PID: `~/.claude/session-sitter/focus-<process.pid>.json`. When the
file appears (written by the sender in another window), the receiver calls
`vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId)`
locally. This is the same command used today for local switching; Claude Code
resolves the panel location (main editor or secondary sidebar) itself.

## Data flow

```
User clicks session X in Window A
  │
  ├─ read ~/.claude/ide/*.lock
  │    → find live lock with workspaceFolders ∋ session.projectPath
  │         and pid ≠ process.pid  (→ foreign owner pid=9999)
  │
  ├─ read /proc/9999/environ
  │    → VSCODE_IPC_HOOK_CLI=/run/user/1000/vscode-ipc-XXXX.sock
  │
  ├─ write ~/.claude/session-sitter/focus-9999.json
  │    { sessionId, workspacePath, requestedAt }
  │
  ├─ execFile('code', [workspacePath], { env: { VSCODE_IPC_HOOK_CLI: targetSocket } })
  │    → Window B's IDE comes to OS foreground
  │
  └─ return  (no local primaryEditor.open)

Window B's FileSystemWatcher fires on focus-9999.json
  │
  ├─ read file, check requestedAt ≤ 10 s
  ├─ executeCommand('claude-vscode.primaryEditor.open', sessionId)
  │    → correct Claude panel focused (main editor or sidebar)
  └─ delete focus-9999.json
```

## Code changes

### `SessionManager.ts` — two new exported functions

```typescript
export interface LockFileInfo {
  pid: number;
  workspaceFolders: string[];
  port: number;
}

// Read ~/.claude/ide/*.lock, return entries whose PID is still alive.
export async function readActiveLockFiles(): Promise<LockFileInfo[]>

// Read /proc/<pid>/environ and return the VSCODE_IPC_HOOK_CLI value, or null.
export async function getIPCSocketForPid(pid: number): Promise<string | null>
```

### `SessionSitterViewProvider.ts` — three additions

**`_startFocusRequestWatcher()`** — called from `resolveWebviewView`.  
Creates a `vscode.workspace.createFileSystemWatcher` on
`~/.claude/session-sitter/focus-<process.pid>.json`.  
On create/change: reads file, validates `requestedAt` freshness (≤10 s),
calls `primaryEditor.open(sessionId)`, deletes file.

**`_tryFocusForeignWindow(sessionId): Promise<'focused' | 'foreign-failed' | 'local'>`**  
- `'local'` — no live foreign lock file matched; caller uses existing behaviour.  
- `'focused'` — signal file written and `code` spawned successfully.  
- `'foreign-failed'` — foreign owner found but any step failed (PID dead,
  `/proc` unreadable, `code` not on PATH, etc.).

**Updated `switchSession` handler:**

```
'local'          → claude-vscode.primaryEditor.open (existing)
'focused'        → done
'foreign-failed' → vscode.window.showWarningMessage("Could not switch to the
                   window containing this session.")
```

## Edge cases

| Scenario | Behaviour |
|---|---|
| Multiple live lock files for same workspace | First live foreign PID wins |
| Same PID in multiple lock files | Handled naturally — PID is the same process |
| Stale focus-request file (crashed switcher) | Receiver ignores if `requestedAt` > 10 s, deletes |
| `~/.claude/session-sitter/` missing | Created lazily on first write |
| `code` not on PATH | `execFile` throws → `'foreign-failed'` → toast |
| `/proc/<pid>/environ` unreadable | `getIPCSocketForPid` returns null → `'foreign-failed'` → toast |
| No lock file matches session workspace | `'local'` → existing behaviour (session has no running owner) |
| Receiver fires before OS window focus | Harmless — `primaryEditor.open` works regardless of OS focus state |
| `addFromHistory` | Unchanged — always opens in current window |

## Testing

Manual verification:

1. Two windows, different workspaces → click session from other window → correct
   window foregrounds, correct Claude panel is focused.
2. Session in current window → click → switches locally as before.
3. Kill target window, then click its session → warning toast, nothing opens.
4. Session with no lock file match → warning toast, nothing opens.
5. History panel `addFromHistory` → opens in current window as before.
