# Architecture: Claude Session Switcher

## Overview

The extension does two things.

**It shows you your agent sessions.** Claude Code, IBM Bob, Codex and VS Code Chat each keep
their own session store, and none of them shows you a list of what is alive across windows. The
panel does: one worklist of the sessions you can act on right now, everything else under History,
one click to switch.

**It supervises what those agents pause on.** When an agent stops for approval, the extension
classifies that specific pending action into a traffic light — green, yellow, orange, red —
against knowledge learned from your team's past sessions, and applies the outcome back into the
agent. Orange reaches a human asynchronously with a countdown, and silence is never treated as
approval.

Two design rules shape everything below:

1. **For reading sessions: read what the agents already write to disk.** No reimplementation of
   their internals.
2. **For acting on a blocked session: use the agent's own join point.** A task blocked at a
   permission prompt cannot be reached by a chat message; the only channel that works is the
   agent's own approval emitter, reached in-process through the V8 inspector.

---

## Project Structure

```
claude-session-switcher/
├── src/
│   ├── extension.ts                    # activate() — wires everything together
│   ├── SessionManager.ts               # the four session stores; scanning + transcripts
│   ├── SessionSwitcherViewProvider.ts  # the sidebar webview + the activity feed
│   ├── WindowRegistry.ts               # cross-window focus + published open-session ids
│   ├── BobDatabase.ts                  # the one read-only SQLite shim (see below)
│   ├── AutoResponder.ts                # text rules, approval rules, supervisor handoff
│   ├── SessionExporter.ts              # the full-transcript export contract
│   ├── SupervisionService.ts           # drives the supervisor in-process
│   ├── SupervisorOutbox.ts             # applies supervisor decisions into the agent
│   ├── SupervisionActivity.ts          # records/ -> the panel's activity feed
│   ├── agents/                         # per-IDE live-process bridges (V8 inspector)
│   │   ├── BobInspector.ts    BobSender.ts     BobApprover.ts
│   │   ├── ClaudeInspector.ts ClaudeSender.ts  ClaudeApprover.ts
│   │   └── QuestionProbe.ts            # read-only probes for debugging the bridges
│   ├── supervisor/                     # the runtime supervisor — pure TypeScript
│   │   ├── models.ts      timeutil.ts   schema.ts     questions.ts
│   │   ├── transcript.ts  knowledge.ts  tiers.ts      prompt.ts
│   │   ├── engine.ts      store.ts      messaging.ts  telegram.ts
│   │   ├── agentControl.ts orchestrator.ts config.ts  factory.ts
│   │   └── cli.ts                      # node out/supervisor/cli.js run|poll
│   ├── corpus/                         # session corpus tooling
│   │   ├── upload.ts  mask.ts  cli.ts
│   └── webview/
│       ├── main.js                     # tab strip, history, activity feed
│       ├── toolbarMenu.js              # the ☰ menu (About + Settings…)
│       └── styles.css                  # theme-aware styles
├── src/test/                           # vitest; 600+ tests, no network, no real agent
├── knowledge/                          # BDI tier template + registry example
├── skills/kb-sitter/                   # the knowledge-loader skill
└── docs/
```

Everything in this repository is TypeScript. See
[Why one `python3` call remains](#why-one-python3-call-remains).

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
[ Implement X   demo-project   × ]
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

---

## The Supervision Layer

### The loop

```
agent pauses at a prompt
  → AutoResponder's approval sweep sees it (every 5 s, per IDE)
      ├─ an auto-approve rule matches      → resolve it, done
      ├─ it is a user-facing question       → never auto-answered; goes to the relay
      └─ nothing handled it                → hand to SupervisionService
                                                 │
SessionExporter writes  <stateDir>/history/<id>.json   (the export contract)
                                                 │
Orchestrator: deterministic tier → load BDI → build prompt → classify → validate → act
                                                 │
                       ┌─────────────────────────┼──────────────────────┐
                    GREEN                     YELLOW              ORANGE / RED
              approve the prompt        inject labeled          post a decision card
              + one-way update           guidance                + start the countdown
                                                                        │
                                                          reply ──┐  ┌── timeout
                                                                  ▼  ▼
                                                    approve / deny + relay the instruction
                                                 │
Orchestrator writes a delivery → <stateDir>/outbox/<deliveryId>.json
                                                 │
SupervisorOutbox applies it: approval channel (blocked prompt) or message channel (idle task)
```

### Why the supervisor runs in-process

The supervisor used to be a Python package driven by a spawned interpreter — one process per
blocked prompt, plus a long-lived poll loop. Now that it is TypeScript there is no reason for a
process boundary: `SupervisionService` owns an `Orchestrator` directly, so a decision costs no
process spawn and no interpreter startup.

What did **not** change is the on-disk state, because each directory earns its place:

| Directory | Why it exists |
|---|---|
| `history/` | the export contract — one JSON file per exported session, replayable offline |
| `records/` | one durable record per decision: the audit trail, and what the activity panel reads |
| `outbox/` | the delivery queue. A delivery is archived only on a **confirmed** apply, so a failed or `notfound` resolve is retried instead of silently lost |
| `inbox/` | simulated replies for the stub messaging channel |
| `notifications/` | what the stub channel would have sent |
| `locks/` | one lock per session, so two live Orange cards can never exist for one decision |

Losing the process boundary did not mean losing durability: a crash mid-decision is still
recoverable, and a restarted extension host resumes pending Orange records and applies their
timeouts.

The outbox indirection also stays, but it is now **kicked**: the orchestrator calls the applier
the instant it writes a delivery, so an approval reaches the blocked agent in milliseconds. The
1500 ms timer and the `fs.watch` remain as the safety net.

### The deterministic tier

Before any model call, `supervisor/tiers.ts` decides the obvious cases:

- **read-only or plainly safe** (`read_file`, `grep`, `git status`, `ls`) → GREEN, auto-approved.
- **unambiguously destructive** (`--force` push, deleting a remote ref, `rm -rf`, `DROP TABLE`,
  `chmod 777`, touching `.env` / `id_rsa` / `credentials`) → RED, blocked.
- **anything else** → ambiguous, so the classifier runs.

A plain `git push origin main` is deliberately *not* deterministic-red: whether that is safe
depends on branch protection, and the deterministic tier must not pre-empt that judgment.

### Recovery, and why it never fails closed

The classifier is a coding-agent CLI, and it sometimes narrates a decision as prose instead of
emitting JSON. The recovery chain exists because a hard failure would strand the agent at a
blocked prompt forever:

1. `extractJsonObject` scans every balanced top-level object and takes the first one carrying a
   `traffic_light` — this is what survives markdown fences, surrounding prose, and the stats
   object Bob's `--output-format json` appends.
2. Failing that, `salvageAssessmentFromText` reads the light out of the prose and builds a
   minimal valid assessment. It deliberately refuses to salvage *structured* output: a
   structured-but-invalid assessment must fail loudly rather than be silently patched.
3. Failing that, the action is escalated to the human as Orange. Unparsable is not approval.

### Identity and safety rules

These are contracts, not preferences:

- **Never impersonate the user.** Every message to the agent carries the
  `[Session Supervisor]` label. The one exception is a question answer, which *is* the user's
  own choice and so carries no label.
- **A question is never resolved through the approval channel.** Approving
  `ask_followup_question` / `AskUserQuestion` consumes the request, and the agent then reports
  that the user gave no answer. Questions go to the relay, where a human picks a real option.
- **Silence is never approval.** An Orange timeout denies the action and hands the agent safe
  alternatives; a Red timeout blocks. Neither writes an approval.
- **The prompt is always sent on stdin.** A supervision prompt embeds a transcript plus the BDI
  knowledge and routinely exceeds the OS single-argument limit, which makes `execve` fail with
  `E2BIG`.
- **Untrusted content is delimited and declared as data.** The transcript and the knowledge are
  wrapped in explicit markers, and the prompt tells the model to ignore instructions found there.

---

## The Agent Bridges

Reading a session from disk is enough to *show* it. Acting on one is not: a task blocked at a
permission prompt is waiting on an in-memory resolver, and nothing on disk reaches it.

`agents/` therefore reaches each agent's live objects in the same extension host, through the
in-process V8 inspector:

| Agent | How it is reached | What it gives us |
|---|---|---|
| **IBM Bob** | walk `api.startTask`'s `[[Scopes]]` to the module-local `TaskManager` | open task ids, pending approvals, resolve an approval, inject a message |
| **Claude Code** | take `activate` from our own `require.cache` and walk its scopes to the manager | open session ids, pending permission requests, resolve one, answer a question, inject a message |

Two properties matter:

- **All inspector access is serialized.** There is one inspector surface per extension host, and
  the Bob path stashes a global that it deletes in its `finally`. Several features drive it on
  independent 5 s timers, so overlapping calls could let one call's cleanup pull the global out
  from under another — an intermittent silent no-op. `runExclusive` chains every call.
- **Every bridge degrades to nothing.** A missing extension, a closure that moved, a call that
  threw: each returns an empty result and logs. A scan loop must never throw.

Claude carries no tool metadata on its permission deferred, so `ClaudeApprover` idempotently
wraps each comm's `send` to record `requestId → {toolName, inputs}` before the prompt reaches the
webview. A request with **no** captured metadata is never auto-approved — we know neither what it
is nor whether it is a question, so it is handed to the supervisor instead.

---

## The Active Worklist

The Sessions list answers "what can I act on right now", not "what changed most recently". How
that is decided depends on what each source can actually tell us:

| Source | Signal |
|---|---|
| **Bob** | its live `TaskManager` reports the open task ids |
| **Claude** | its live manager reports the open session ids |
| **Codex** | *nothing* — no extension host to ask |
| **VS Code Chat** | *nothing* |

For Bob and Claude the answer is read fresh from this window and unioned with what other live
windows published to `~/.claude/session-switcher/windows/` — so the answer is cross-window. A
session is also treated as active when its status is not idle, so a session you are working in
does not vanish because the probe was momentarily silent.

Codex and Chat have no liveness signal at all, so recency is the only honest proxy: they count as
active while updated within `claudeSessionSwitcher.probelessActiveWindowMinutes` (default 120,
`0` to keep them in History always). The rule is named and configurable rather than hidden.

---

## Why one `python3` call remains

Every line of this extension is TypeScript. There is exactly one place it shells out, and it is
worth being explicit about: `BobDatabase.ts` reads IBM Bob's SQLite store through
`python3 -c` with the standard library's `sqlite3` module.

A VS Code extension has no SQLite driver available. A native module (`sqlite3`,
`better-sqlite3`) breaks VSIX portability across the platforms and Electron ABIs this runs on,
and `node:sqlite` is too new to rely on in the VS Code and Bob IDE hosts targeted here. The
`python3` shim needs no dependency, is read-only (`mode=ro`), and every value is bound as a
parameter — the SQL is a constant at each call site.

It is confined to that one file, it only affects Bob sessions, and swapping in a WASM SQLite
build later means replacing one function.
