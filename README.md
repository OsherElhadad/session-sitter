# Claude Session Switcher

A VS Code extension that does two things for your coding agents.

**It shows you your sessions.** One live panel listing every session across
[Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code),
[IBM Bob IDE](https://marketplace.visualstudio.com/items?itemName=ibm.bob-code), Codex and VS Code
Chat — which ones are alive right now, one click to switch, across windows.

**It supervises what they pause on.** When an agent stops for approval, the extension classifies
that action into a traffic light against your team's own practices, and acts: approve it, correct
it, or reach you asynchronously with a countdown. Silence is never treated as approval.

Coding agents do not stop when you close the laptop. The second half is for the moments you are
not there. → [`docs/SUPERVISION.md`](docs/SUPERVISION.md)

---

## Features

### 🔀 One panel, four sources

The **AI Sessions** panel in the Secondary Sidebar lists your sessions from Claude Code, IBM Bob
IDE, Codex and VS Code Chat side by side.

The main list is a **live worklist**: only sessions you can act on right now. Claude and Bob are
judged by what their extension hosts actually report as open — unioned across every window — so a
session open in another window still shows here. Codex and Chat expose no such signal, so they
count as active while recently updated (`claudeSessionSwitcher.probelessActiveWindowMinutes`,
default 120). Everything else lives under **History**.

### 🚦 Traffic-light supervision

| Light | Meaning | What happens |
|:---:|---|---|
| 🟢 **Green** | the action is fine | approve the prompt, record it, no human contact |
| 🟡 **Yellow** | a safe, unambiguous correction | inject labeled guidance; the agent self-corrects |
| 🟠 **Orange** | your call | block, send a decision card with a countdown; on timeout deny and offer alternatives |
| 🔴 **Red** | policy, not judgment | block outright; the block stands on timeout |

A read-only action never costs a model call — a deterministic tier decides the obvious cases
first. A **Supervision activity** panel shows every decision, with a failed one expanding to its
recorded error. Off until you set `reckon.supervisorStateDir`.

### 🤖 Auto-respond and auto-approve

Rules resolve the prompts you never want to see again — `{ toolPattern, decision }` for approvals,
`{ matchPattern, response }` for replies, optionally scoped to a project or to one IDE. Anything no
rule handles is handed to the supervisor. A user-facing question is never auto-answered.

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

Everything not in the worklist lives in a collapsible **History ▶** section. Click any item to
re-open it.

### 📄 Copy transcript

Right-click any session → **Copy transcript** → to editor, to clipboard, or to a file. Clean
handoff markdown: user and assistant prose only, with tool calls and scaffolding stripped. Works
for all four sources.

### 📤 Upload to corpus

Right-click a session → **Upload to Corpus** to add it to your session corpus, the store the
supervision knowledge is distilled from. Runs in-process; secrets are redacted before anything is
committed. → [`docs/CORPUS.md`](docs/CORPUS.md)

### ✨ Smart titles

- **Claude:** the AI-generated title Claude Code appends after the first exchange, falling back to
  the first user message
- **Bob:** the task title from the Bob database, falling back to the first user message
- **Codex:** the thread name from `~/.codex/session_index.jsonl`, falling back to the workspace
- **Chat:** the first request's text, falling back to `Chat in <workspace>`

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

## Supervision in five minutes

Skip this if you only want the session panel.

**1.** Point the extension at a state directory and your knowledge:

```jsonc
{
  "reckon.supervisorStateDir": "/home/you/.ai-sessions/state",
  "reckon.dataRepoPath": "/home/you/work/team-corpus",
  "reckon.knowledge.user": "your-slug",
  "reckon.knowledge.project": "your-project",
  "reckon.knowledge.team": "your-team"
}
```

**2.** Pick a classifier and a channel in `<workspaceRoot>/.env`:

```bash
SUPERVISOR_ENGINE=bob          # or: claude
BOB_API_KEY=…
MESSAGING_CHANNEL=telegram     # or: stub — writes cards to files, no account needed
TELEGRAM_BOT_TOKEN=…
TELEGRAM_CHAT_ID=…
```

**3.** Write your first rules. Start from
[`knowledge/bottom-line.template.md`](knowledge/bottom-line.template.md), copy it to
`data/knowledge/teams/<your-team>/bottom-line.md` in your corpus repo, and replace the entries.

**That is it — there is nothing to run.** The supervisor runs inside the extension: no interpreter,
no daemon, no background script. Turn it off with `reckon.autoSupervise: false`.

Full reference: [`docs/SUPERVISION.md`](docs/SUPERVISION.md) ·
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

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
| Copy a transcript | Right-click → **Copy transcript** |
| Upload to the corpus | Right-click → **Upload to Corpus** |
| See supervision decisions | Open **Supervision activity** |
| Open About / Settings | Click **☰** |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed breakdown of components, data flows, and design decisions.

### Key components

| File | Role |
|------|------|
| `src/extension.ts` | `activate()` — wires everything together |
| `src/SessionManager.ts` | the four session stores: scanning, status, transcripts |
| `src/SessionSwitcherViewProvider.ts` | the sidebar webview, the worklist partition, the activity feed |
| `src/WindowRegistry.ts` | cross-window focus and published open-session ids |
| `src/BobDatabase.ts` | the one read-only SQLite shim |
| `src/agents/` | Bob and Claude bridges: open ids, approvals, message injection |
| `src/AutoResponder.ts` | text rules, approval rules, and the supervisor handoff |
| `src/SessionExporter.ts` | the full-transcript export contract |
| `src/SupervisionService.ts` | drives the supervisor in-process |
| `src/supervisor/` | the runtime supervisor: schema, knowledge, tiers, prompt, engine, store, messaging, orchestrator |
| `src/SupervisorOutbox.ts` | applies supervisor decisions back into the agent |
| `src/corpus/` | the session uploader, the secret masker, the knowledge loader |
| `src/webview/` | tab strip, history, activity feed, ☰ menu (vanilla JS, no build step) |

### Data flow

```
Filesystem changes (JSONL / bob.db-wal / codex index / chat sessions)
        │
        ▼
  SessionManager                      ←─ 5-second poll fallback
  (scans + parses four stores)
        │  onDidChangeSessions
        ├──────────────────────────────────────────────┐
        ▼                                              ▼
  SessionSwitcherViewProvider                    AutoResponder
  (worklist / history partition)            (text rules + approval sweep)
        │  postMessage                                 │  nothing handled it
        ▼                                              ▼
  Webview                                        SupervisionService
                                          (export → classify → act, in-process)
                                                       │  writes a delivery
                                                       ▼
                                                 SupervisorOutbox
                                        (approval channel, or message channel)
```

---

## Known Limitations

- **Linux / WSL only** for Claude PID-based detection. On macOS/Windows the extension falls back to showing sessions active within the last 2 hours.
- **Bob "open in sidebar" not detectable** — Bob IDE does not persist which task is currently open in its sidebar to the database. The extension uses `status='running'` (actively executing) plus a 2-hour recency window as the best available approximation.
- **New Claude sessions appear after first exchange** — Claude Code creates the session file when the first message is sent, so brand-new empty sessions aren't visible until then.
- **Bob sessions require `python3`** — Bob's SQLite DB is read through a `python3 -c` shim, because
  a VS Code extension has no SQLite driver available and a native module would break VSIX
  portability. It is confined to `src/BobDatabase.ts`, is read-only, and only affects Bob sessions.
  `python3` is standard on Linux and WSL. Everything else in this repository is TypeScript — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#why-one-python3-call-remains).
- **Claude message injection targets a single conversation** — the sessionId↔channel link lives in
  Claude's webview, not its extension host, so injection targets the sole open channel and skips
  when several are open.
- **Supervision needs a classifier CLI** — either `bob` or `claude` on your `PATH`, with its
  credentials in the environment.

---

## Contributing

```bash
npm run compile   # TypeScript → out/
npm test          # vitest — 600+ tests, no network, no real agent needed
npm run lint      # ESLint
npm run check     # all three
```

Press **F5** for an Extension Development Host with live reloading.

Documentation:

| Document | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | components, session detection, the supervision layer, the agent bridges |
| [`docs/SUPERVISION.md`](docs/SUPERVISION.md) | the traffic lights, the lifecycle, running it by hand, troubleshooting |
| [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md) | the BDI schema, the three tiers, routing |
| [`docs/CORPUS.md`](docs/CORPUS.md) | collecting sessions, bulk import, secret masking |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | every setting, environment variable, flag and command |

Issues and pull requests welcome.

---

## License

MIT
