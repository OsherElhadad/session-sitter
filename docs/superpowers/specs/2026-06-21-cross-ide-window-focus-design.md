# Cross-IDE Cross-Window Session Focus

**Date:** 2026-06-21
**Status:** Approved

## Problem

Clicking a session in the switcher runs `_tryFocusForeignWindow()`
([`SessionSwitcherViewProvider.ts`](../../../src/SessionSwitcherViewProvider.ts)).
That feature was designed and tested for **desktop VS Code on a local machine**.
Under **IBM Bob** (and any remote/server IDE such as VS Code Remote-WSL/SSH), every
assumption it makes is false, so clicking a session that belongs to a running window
shows the toast **"Could not switch to the window containing this session."** and the
session never opens.

### Evidence (gathered on the user's IBM Bob / WSL2 machine)

| Assumption in current code | Reality on IBM Bob (remote) | Consequence |
|---|---|---|
| `~/.claude/ide/<port>.lock` `pid` = the window's extension-host pid | Lock `pid` is the **shared `bobide` server** (`984306`); the extension host is a different pid (`1353707`, `1381769`) | Local sessions are **misclassified as foreign** |
| `/proc/<lockpid>/environ` contains `VSCODE_IPC_HOOK_CLI` | The server pid has **no** IPC socket in its environ | `getIPCSocketForPid()` returns `null` → `'foreign-failed'` → the toast |
| The focus CLI is `code` | `code` resolves to `/usr/bin/code` → **real Microsoft VS Code**, a different IDE than the running IBM Bob | Wrong IDE invoked; cannot focus a Bob window |
| Receiver watches `focus-<lockpid>.json` | Sender writes `focus-984306.json`; receiver watches `focus-<extHostPid>.json` | Focus request never received |

Additionally, local opens hardcode `claude-vscode.primaryEditor.open`, which (confirmed
in Bob's compiled bundle) **always forces `ViewColumn.Active` (main editor)** and ignores
the secondary side panel.

### Verified facts about the environment

- Each window's extension host (`process.pid`) has **descendant processes that carry
  that window's unique `VSCODE_IPC_HOOK_CLI`** socket
  (window 1 descendants → `vscode-ipc-ce311aff….sock`; window 2 → `…4004a6d5….sock`).
  The extension host process itself does *not* have the variable in its environ.
- IBM Bob's remote CLI is `bobide`
  (`~/.bobide-server/bin/<commit>/bin/remote-cli/bobide`), placed first on `PATH`.
  There is **no** `code` in that remote-cli dir, so `code` falls through to system VS Code.
- `ptrace_scope = 0` and processes are same-user, so `/proc/<pid>/environ` of our own
  descendants is readable.

## Goal

When the user clicks a session in the active list, on **both IBM Bob and VS Code**
(local or remote):

- Session owned by the **current window** → reveal it locally, respecting whether
  Claude is docked in the **main editor** or the **secondary side panel**.
- Session owned by a **different window** → bring that window to the OS foreground and
  focus Claude there.
- Only show the warning toast when focusing genuinely cannot be done (no live owner
  window found, or no usable socket/CLI for it).

The **History** panel (`addFromHistory`) is unchanged — history sessions have no running
window and always open locally.

## Mechanism

The fix replaces reliance on the Claude lock-file pid with a **self-published
per-window registry**: each window knows its own identity and IPC socket and writes them
to a file; peers read those files to address and focus each other.

### 1. Per-window registry

Directory: `~/.claude/session-switcher/windows/`
File: `<extHostPid>.json`

```json
{
  "pid": 1353707,
  "workspaceFolders": ["/home/eranra/go/src/github.com/eranra/claude-session-switcher"],
  "ideCli": "bobide",
  "ipcSocket": "/run/user/1000/vscode-ipc-ce311aff-8557-4800-9501-97cc0f3a2343.sock",
  "updatedAt": 1750000000000
}
```

- `pid` — `process.pid` of this window's extension host. Stable per window; used both as
  the file key and as the focus-request address.
- `workspaceFolders` — from `vscode.workspace.workspaceFolders` (mapped to `.uri.fsPath`).
- `ideCli` — detected focus CLI (see §3).
- `ipcSocket` — this window's own socket (see §2). May be empty if not yet discoverable.
- `updatedAt` — epoch ms; used for staleness.

**Lifecycle**
- Written on activation/`resolveWebviewView`.
- Refreshed on `vscode.window.onDidChangeWindowState` (focus changes) and on a periodic
  timer (e.g. every 60 s) so `ipcSocket` is re-resolved if it was empty at startup.
- Removed on `dispose()`.
- Readers ignore entries whose `pid` is dead (`process.kill(pid, 0)` throws) or whose
  `updatedAt` is older than a staleness window (e.g. 24 h); dead files are best-effort
  unlinked.

### 2. Self IPC-socket discovery

A window discovers its **own** socket (the ext-host env lacks it):

1. Enumerate `/proc/<pid>` numeric entries.
2. For each, read `/proc/<pid>/environ`; if it contains `VSCODE_IPC_HOOK_CLI=…`, record
   the value and check whether the process's PPID-chain (walk `/proc/<pid>/stat` field 4)
   includes our `process.pid`.
3. Return the socket of the first descendant match. Cache it; re-resolve on refresh if
   still empty.

This is Linux-specific. On platforms without `/proc` (non-remote macOS/Windows desktop),
fall back to `process.env.VSCODE_IPC_HOOK_CLI` (present in desktop VS Code's extension
host). If neither yields a socket, `ipcSocket` is left empty and cross-window *raise* for
that window degrades gracefully (see §6).

### 3. IDE CLI detection

Determine the executable used to focus a window:

1. Look for a `remote-cli` directory among `PATH` entries (the remote-cli dir is on
   `PATH` in remote IDEs). Use the executable found there (`bobide`, `code`,
   `code-insiders`, …).
2. Otherwise derive from `vscode.env.appName` (e.g. contains "Bob" → `bobide`).
3. Otherwise default to `code`.

The detected name is stored as `ideCli` in the registry so a sender uses the **owner
window's** CLI, not its own.

### 4. Owner detection

`_findOwnerWindow(session)` reads the registry, filters to live entries, and returns the
entry whose `workspaceFolders` contains the session's `projectPath`
(`projectPath === wf || projectPath.startsWith(wf + '/')`) and whose `pid !== process.pid`.
Returns `null` when the only match is our own window (→ local) or there is no match.

### 5. OS window focus (raise)

Given an owner window entry with a usable `ipcSocket` and `ideCli`:

```ts
execFile(
  owner.ideCli,
  ['--reuse-window', owner.workspaceFolders[0]],
  { env: { ...process.env, VSCODE_IPC_HOOK_CLI: owner.ipcSocket }, timeout: 3000 },
)
```

Talking to the owner window's own socket brings **that** window to the OS foreground.
`--reuse-window` prevents opening a new window.

### 6. Panel / session focus within the target window

Every switcher instance watches `~/.claude/session-switcher/focus-<process.pid>.json`.
The sender writes `focus-<owner.pid>.json` (`{ sessionId, requestedAt }`). On receive,
within the freshness window (≤10 s), the receiver reveals the session **tab-aware**.

`claudeCode.preferredLocation` was rejected as the signal: it is a single global value
(observed `"panel"` on the dev machine) that cannot represent a mixed-mode layout where
some sessions live in the editor and others in the side panel, and it is only updated
when Claude is opened via its own commands — dragging Claude into the side panel does not
update it. The reliable, observable signal is whether the session is currently an open
**editor tab** (via the `tabGroups` API, already used by `_openClaudeTabLabels()`):

```ts
private _openSessionLocal(sessionId: string): void {
  const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
  if (session && this._openClaudeTabLabels().has(session.title)) {
    // Already an editor tab → reveal it there (createPanel reveals existing panels).
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  } else {
    // Live session not in the editor → it lives in the secondary side panel; focus it.
    void vscode.commands.executeCommand('claude-vscode.sidebar.open');
  }
}
```

The **same helper** is used for purely local clicks (`switchSession` when the current
window owns the session) and the foreign-focus receiver. **`addFromHistory` is the
exception:** history sessions are not running, so there is nothing in the side panel to
focus — they always open fresh in the editor via `primaryEditor.open(sessionId)`.

## Data flow

```
User clicks session X in Window A
  │
  ├─ read ~/.claude/session-switcher/windows/*.json   (live entries only)
  │     → find entry whose workspaceFolders ∋ X.projectPath and pid ≠ process.pid
  │
  ├─ none found ──────────────► local: location-aware open in Window A   (done)
  │
  └─ owner = Window B (pid, ideCli, ipcSocket)
       ├─ write ~/.claude/session-switcher/focus-<B.pid>.json { sessionId, requestedAt }
       ├─ execFile(B.ideCli, ['--reuse-window', B.workspace], { VSCODE_IPC_HOOK_CLI: B.ipcSocket })
       │     → Window B comes to the OS foreground
       └─ if B has no usable socket/cli → warning toast (cannot focus)   (done)

Window B's FileSystemWatcher fires on focus-<B.pid>.json
  ├─ requestedAt ≤ 10 s ?
  ├─ read claudeCode.preferredLocation
  │     sidebar → claude-vscode.sidebar.open
  │     else    → claude-vscode.primaryEditor.open(sessionId)
  └─ delete focus-<B.pid>.json
```

## Code changes

### `SessionManager.ts`
- **Remove dependence on lock-file pid for focus.** `readActiveLockFiles` and
  `getIPCSocketForPid(pid)` are no longer used for owner/socket resolution. (`getActiveSessionIds`
  / liveness used by `_pushSessions` is unrelated and stays.) Keep or delete the now-unused
  exports per the implementation plan.
- **Add** self-socket discovery and IDE-CLI detection helpers (or place them in a new module
  `WindowRegistry.ts` — see below).

### New module `WindowRegistry.ts`
- `discoverOwnIpcSocket(): Promise<string | null>` — §2.
- `detectIdeCli(): string` — §3.
- `writeWindowEntry(entry)`, `removeWindowEntry(pid)`, `readLiveWindows(): Promise<WindowEntry[]>`.
- Pure, file-system-and-`/proc`-based; unit-testable with a temp dir and injectable
  `/proc` reader.

### `SessionSwitcherViewProvider.ts`
- On activation: detect CLI, discover own socket, `writeWindowEntry`; start refresh timer +
  `onDidChangeWindowState` listener; `removeWindowEntry` on dispose.
- `_findOwnerWindow(session)` — §4 (replaces lock-file matching in `_tryFocusForeignWindow`).
- `_tryFocusForeignWindow(sessionId)` — rewritten per §5; returns
  `'focused' | 'foreign-failed' | 'local'` as today.
- `_openSessionLocal(sessionId)` — new location-aware helper (§6); used by the `'local'`
  branch, `addFromHistory`, and the focus-request receiver.
- `_handleFocusRequest` — uses `_openSessionLocal` (§6) instead of unconditional
  `primaryEditor.open`.
- `_startFocusRequestWatcher` — unchanged (already keyed on `process.pid`).

## Edge cases

| Scenario | Behaviour |
|---|---|
| Owner window has empty `ipcSocket` (socket not yet discoverable) | Cannot raise → warning toast; refresh timer re-resolves socket for next time |
| Multiple live windows match the same workspace | First live entry wins (documented, same as before) |
| Stale `windows/<pid>.json` from a crashed window | Reader skips dead pid; file best-effort unlinked |
| `~/.claude/session-switcher/windows/` missing | Created lazily on first write |
| Owner CLI not found / `execFile` throws | `'foreign-failed'` → warning toast |
| Non-`/proc` desktop OS | Socket via `process.env.VSCODE_IPC_HOOK_CLI`; CLI via `vscode.env.appName`/default |
| `addFromHistory` | Unchanged — always opens locally (location-aware) |
| Receiver fires before OS focus completes | Harmless — open command works regardless of OS focus state |

## Limitations

- **Secondary side panel cannot be switched to a *specific* session.** The Claude
  extension's `sidebar.open` command takes no `sessionId` (confirmed in the bundle), and
  the sidebar webview has no per-session API. When a session lives in the secondary panel,
  this design **focuses that panel** (eliminating the error and bringing the window
  forward) but shows whatever session the panel currently holds. Switching to the exact
  session is fully supported only in the **main-editor** case. This is an upstream
  Claude-extension constraint, not something this extension can work around.
- **A live session not shown as an editor tab is assumed to be in the side panel.** There
  is no API to confirm a session is in the side panel, so the tab-aware rule infers it.
  Consequence: clicking a live session that happens to be open in *neither* place will
  focus the (possibly empty) side panel rather than reopen it in the editor.

## Testing

Unit (vitest):
- `WindowRegistry`: write/read round-trip; liveness filtering; staleness filtering;
  socket discovery against a faked `/proc` tree (descendant match vs non-descendant);
  CLI detection from a faked `PATH`/`appName`.
- `_findOwnerWindow`: own-pid → local; matching foreign entry → that entry; no match → null.
- `_openSessionLocal`: `preferredLocation` sidebar vs panel routes to the correct command
  (mock `executeCommand`).
- `_handleFocusRequest`: freshness gate; location routing; file deleted afterward.

Manual:
1. IBM Bob, two windows (different workspaces) → click a session from the other window →
   that window foregrounds and Claude focuses (editor case switches to the exact session).
2. Same window owns the session → click → reveals locally, respecting editor/sidebar.
3. Target window docked in secondary panel → click → window foregrounds, panel focused,
   no error toast.
4. Kill the target window, then click its session → warning toast, nothing opens.
5. Session with no live owner window → opens locally.
6. Repeat (1)–(2) on desktop VS Code to confirm the `/proc`-less fallback path.
```
