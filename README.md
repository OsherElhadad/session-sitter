# Claude Session Switcher

A VS Code extension that gives Claude Code and IBM Bob IDE what they're both missing: a **live session panel** that shows exactly which AI sessions are active right now, lets you switch between them with one click, and keeps every background session visible while you work.

---

## Features

### 🔀 Unified session panel for Claude and Bob

The **Claude Sessions** panel in the Secondary Sidebar lists all your active AI sessions side by side — both [Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) and [IBM Bob IDE](https://marketplace.visualstudio.com/items?itemName=ibm.bob-code) sessions appear together, sorted by most recently active.

### 🟢 Live status indicators

Each row shows a status dot updated every 5 seconds:

| Indicator | Meaning |
|-----------|---------|
| 🟢 Spinning green ring | AI is actively running tools or computing |
| 🟡 Pulsing yellow dot | You sent a message — AI hasn't responded yet |
| ⚫ Dim gray dot | Session is idle, waiting for your input |

### 🖱️ One-click switching

Click any session row to bring that panel to the front — same window, no new windows opened. The `×` button closes the editor tab entirely.

### 👁️ Hover preview

Hover over any session row to see the last few messages in a floating popup. User messages are labelled **You**, assistant messages are labelled **Claude** or **Bob** depending on the source.

### 📋 History panel

Past conversations live in a collapsible **History ▶** section below the active sessions. Click any item to re-open it.

### ✨ Smart titles

- **Claude sessions:** uses the AI-generated title Claude Code appends after the first exchange (the same title shown in Claude's tab bar), falling back to the first user message
- **Bob sessions:** uses the task title stored in the Bob database, falling back to the first user message (≤60 chars)

### ➕ New session buttons

- `+` starts a new Claude Code session
- `+B` starts a new Bob session (runs `bob-code.task.pickWorkspace`)

### 🔍 Multi-window support

If a session belongs to a different VS Code window, clicking it sends a focus request to that window and brings it to the foreground.

---

## Session Detection

### Claude Code sessions

Claude Code writes `~/.claude/sessions/<pid>.json` for every active session. The extension:

1. Reads each file and checks `entrypoint === "claude-vscode"` (ignores CLI runs)
2. Verifies the PID is still alive with `process.kill(pid, 0)`
3. Guards against PID recycling by comparing `procStart` to `/proc/<pid>/stat` field 21 (kernel start-time)
4. Discards sessions started more than 24 hours ago (zombie processes from unclosed VS Code instances)

This is exact — no time-window guessing for Claude sessions.

**Fallback chain** when session files are unavailable:

```
1. VS Code Tab API (viewType check)     → if tab matches found, show those
2. ~/.claude/sessions/ PID liveness     → primary detection
3. 2-hour recency window                → last resort fallback
```

### IBM Bob IDE sessions

Bob stores all sessions in a SQLite database at `~/.bob/db/bob.db`. The extension queries the `tasks` table directly (via `python3` subprocess) and maps Bob's status field:

| Bob DB status | Panel status | Indicator |
|---|---|---|
| `running` | active | 🟢 spinning ring |
| `active` (Bob's "done") | idle | ⚫ dim dot |

**What gets shown:**
- Tasks with `status = 'running'` are always shown (actively executing)
- Tasks with `status = 'active'` (completed) are shown if updated within the last 2 hours
- Older completed tasks appear in History only

The workspace path is extracted from the `env` JSON column (`staticEnvInfo.primaryWorkspace`), with fallback to `env.workspace` and then `project_id`.

**Change detection:** watches `~/.bob/db/bob.db-wal` (the SQLite WAL file, written on every transaction) plus a 5-second polling loop.

---

## Installation

### Download the latest release (recommended)

1. Go to the [**Releases page**](https://github.com/eranra/claude-session-switcher/releases/latest) and download the `.vsix` file
2. **For VS Code / Claude Code:** Extensions panel → `···` menu → **Install from VSIX...**
3. **For IBM Bob IDE:** `bobide --install-extension claude-session-switcher-*.vsix`
4. Reload the window when prompted

### Build from source

```bash
git clone https://github.com/eranra/claude-session-switcher.git
cd claude-session-switcher
npm install
npx @vscode/vsce package --no-dependencies
```

Then install the generated `.vsix` as above.

### Development

Press **F5** in VS Code to launch an Extension Development Host with live reloading.

---

## Requirements

- [Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) installed and activated
- VS Code or IBM Bob IDE **1.65** or later
- Linux or WSL
  - Claude session detection relies on `/proc/<pid>/stat` for PID liveness
  - Bob session detection requires `python3` (standard on all Linux systems) to query the SQLite DB
- **IBM Bob IDE sessions:** IBM Bob IDE with `~/.bob/db/bob.db` present (created automatically on first use)

---

## Getting Started

1. Open the **Secondary Sidebar** (`Ctrl+Alt+B` or **View → Secondary Side Bar**)
2. The **Claude Sessions** panel appears automatically
3. Open Claude Code or Bob sessions — they appear in the panel in real time

| Action | How |
|--------|-----|
| Switch to a session | Click the row |
| Close a session tab | Click `×` on the row |
| Start a new Claude session | Click `+` |
| Start a new Bob session | Click `+B` |
| Preview conversation | Hover over a row |
| Browse past sessions | Click **History ▶** |
| Resume a past session | Click any History item |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed breakdown of components, data flows, and design decisions.

### Key components

| File | Role |
|------|------|
| `src/extension.ts` | `activate()` — wires everything together |
| `src/SessionManager.ts` | Reads `~/.claude/` and `~/.bob/db/bob.db`, detects live sessions, polls every 5 s |
| `src/SessionSwitcherViewProvider.ts` | `WebviewViewProvider` — drives the sidebar UI, handles switching logic |
| `src/WindowRegistry.ts` | Tracks open VS Code windows for cross-window focus |
| `src/webview/main.js` | Tab strip + history panel + hover preview (vanilla JS, no build step) |
| `src/webview/styles.css` | Theme-aware styles |

### Data flow

```
Filesystem changes (JSONL / bob.db-wal)
        │
        ▼
  SessionManager          ←─ 5-second poll fallback
  (scans + parses)
        │  onDidChangeSessions
        ▼
  SessionSwitcherViewProvider
  (applies active/history filter)
        │  postMessage(updateSessions / updateHistory)
        ▼
  Webview (main.js)
  (renders tab strip and history panel)
```

---

## Known Limitations

- **Linux / WSL only** for Claude PID-based detection. On macOS/Windows the extension falls back to showing sessions active within the last 2 hours.
- **Bob "open in sidebar" not detectable** — Bob IDE does not persist which task is currently open in its sidebar to the database. The extension uses `status='running'` (actively executing) plus a 2-hour recency window as the best available approximation.
- **New Claude sessions appear after first exchange** — Claude Code creates the session file when the first message is sent, so brand-new empty sessions aren't visible until then.
- **Bob sessions require `python3`** — the SQLite DB is queried via `python3 -c "..."` subprocess since there is no bundled Node.js SQLite driver. `python3` is standard on all Linux/WSL systems.

---

## Contributing

```bash
npm run compile   # TypeScript → out/
npm test          # vitest unit tests (77 tests)
npm run lint      # ESLint
```

Issues and pull requests welcome.

---

## License

MIT
