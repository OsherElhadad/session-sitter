# Claude Session Switcher

A VS Code extension that gives Claude Code what it's missing: a **live session panel** that shows exactly which Claude sessions are running right now, lets you switch between them with one click, and keeps every background session alive while you focus elsewhere.

---

## The Problem

Claude Code supports multiple concurrent sessions — each one keeps running in the background even when its tab is hidden. But there's no built-in way to see at a glance which sessions are active, what they're doing, or switch to one without hunting through tabs.

This extension adds a **Claude Sessions panel** to your Secondary Sidebar that solves exactly that.

---

## What It Does

### Live session list — not a history browser

The panel shows only sessions that have a **running Claude process right now**. It detects this by reading `~/.claude/sessions/<pid>.json` — files Claude Code writes for each active session — and verifying the PID is still alive using the Linux kernel's `procStart` timestamp (so recycled PIDs don't fool it). Sessions that end disappear automatically.

### Status indicators

Each session row shows a live status dot updated every 5 seconds:

| Indicator | Meaning |
|-----------|---------|
| 🟢 Spinning green ring | Claude is actively running tools or computing |
| 🟡 Pulsing yellow dot | You sent a message — Claude hasn't responded yet |
| ⚫ Dim gray dot | Session is idle, waiting for your input |

### One-click switching

Click any session row to bring that Claude Code panel to the front — in the same window, no new windows opened. The `×` button closes the Claude Code editor tab entirely.

### History panel

Past conversations live in a collapsible **History ▶** section. Click any item to re-open it as a live session.

### AI-generated titles

Session titles match exactly what Claude Code shows in its own tab bar — the AI-generated summary (e.g. "Fix authentication bug"), not your raw first message.

---

## Installation

### Build from source

```bash
git clone https://github.com/eranra/claude-session-switcher.git
cd claude-session-switcher
npm install
npx @vscode/vsce package --no-dependencies
```

Then in VS Code: **Extensions panel** → `···` → **Install from VSIX...** → select the `.vsix` → reload.

### Development

Press **F5** in VS Code to launch an Extension Development Host with live reloading.

---

## Requirements

- [Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) installed and activated
- VS Code **1.65** or later
- Linux or WSL (relies on `/proc` for PID liveness detection)

---

## Getting Started

1. Open the **Secondary Sidebar** (`Ctrl+Alt+B` or **View → Secondary Side Bar**)
2. The **Claude Sessions** panel appears automatically
3. Open Claude Code sessions — they appear in the panel in real time

| Action | How |
|--------|-----|
| Switch to a session | Click the row |
| Close a session tab | Click `×` on the row |
| Start a new session | Click `+` |
| Browse past sessions | Click **History ▶** |
| Resume a past session | Click any History item |

---

## How It Works

### Detecting live sessions

Claude Code writes a JSON file to `~/.claude/sessions/<pid>.json` for every active session:

```json
{
  "pid": 1641086,
  "sessionId": "3bfad019-...",
  "cwd": "/home/user/my-project",
  "startedAt": 1781443340390,
  "procStart": "33842439",
  "entrypoint": "claude-vscode"
}
```

For each file the extension checks:

1. **PID alive?** — `process.kill(pid, 0)` (signal 0 checks existence without sending a signal)
2. **Not a recycled PID?** — compares `procStart` to `/proc/<pid>/stat` field 21 (kernel start-time in jiffies)
3. **VS Code session?** — `entrypoint === "claude-vscode"` (excludes CLI runs)
4. **Started today?** — `startedAt` within the last 24 hours (excludes zombie processes from a VS Code that was never restarted)

This is exact — no time-window guessing for active sessions.

### Status detection

The JSONL tail (last 32 KB) is scanned backward for the last meaningful record:

```
assistant with tool_use content  →  active  (tools are executing)
file modified in last 30 s       →  active  (Claude may still be streaming)
user record                      →  waiting (message sent, no response yet)
pr-link / last-prompt record     →  idle    (CLI session ended cleanly)
assistant + quiet 30 s           →  idle    (response complete)
```

### Session titles

The extension reads the `ai-title` record Claude Code appends after the first exchange — the same title shown in Claude Code's tab bar. Falls back to the first user message for brand-new sessions.

### Switching sessions

Clicking a session calls `claude-vscode.primaryEditor.open(sessionId)` — Claude Code's own command — which either reveals an existing panel or opens a new editor tab in the current window. Background sessions stay alive with `retainContextWhenHidden: true`.

### Reliability in WSL

VS Code's file system watcher can silently stop delivering events in WSL2. A 5-second polling loop ensures status indicators and new sessions stay current even when watcher events are missing.

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full breakdown of components, data flows, and design decisions.

---

## Known Limitations

- **Linux / WSL only** for PID-based detection. On macOS/Windows the extension falls back to showing sessions active within the last 2 hours.
- **Cannot detect which panel is visible** — the VS Code tab API is unavailable from the remote extension host in WSL, so the extension knows which sessions are *running* but not which is currently *on screen*.
- **New sessions appear after first exchange** — Claude Code creates the session file when the first message is sent, so brand-new empty sessions aren't visible until then.

---

## Contributing

```bash
npm run compile   # TypeScript → out/
npm test          # vitest unit tests (29 tests)
npm run lint      # ESLint
```

Issues and pull requests welcome.

---

## License

MIT
