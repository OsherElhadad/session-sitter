# Copy Transcript from AI Sessions Context Menu

**Date:** 2026-07-20
**Status:** Draft — for review
**Stacked on:** [PR #10 — Codex + VS Code Chat session support](https://github.com/eranra/claude-session-switcher/pull/10)

## Goal

Right-click any row in the AI Sessions view → **Copy transcript ▸** → **Editor** /
**Clipboard** / **File**. Extracts the session's full conversation as
handoff-ready markdown, from any of the four sources (Claude · Bob · Codex ·
Chat). Nothing is written to any live session; this is read-and-export only.

The intended use case is manual handoff — a user pastes the transcript into a
different agent's prompt to continue a conversation there. Motivated by a
concrete case: a session accidentally started in VS Code Chat that the user
meant to run in Claude Code. Verified once by hand in a one-off exercise
before this spec was written; this feature productizes that exercise.

## Non-goals

- **Sending directly into another running session.** A future PR will add
  `Send to <target> ▸` with a submenu of currently-running sessions, using
  `InspectorBobSender` for Bob targets and clipboard fallback for others. Out
  of scope here.
- **Summarize with human review.** Also out of scope. Would layer on top of
  this once the extractors are in place.
- **Editing / archiving / deleting the source session.** All extraction is
  read-only. The source `.jsonl` / SQLite / rollout files are untouched.
- **Non-macOS Chat path.** Chat scanning already lives on the macOS-only path
  from PR #10 (`~/Library/Application Support/Code/User/...`). Same
  restriction applies here; Linux/Windows are deferred.

## The three delivery mechanisms

| Destination | User experience | Implementation |
|---|---|---|
| **Editor** | Opens the transcript in a new untitled Markdown editor tab in the current VS Code window. User selects + copies from there. | `vscode.workspace.openTextDocument({ language: 'markdown', content }); vscode.window.showTextDocument(doc)` |
| **Clipboard** | Silently copies the transcript. A status-bar message ("Transcript copied — 7 turns · 4.2 KB") confirms. | `vscode.env.clipboard.writeText(content)` |
| **File** | Writes to a `.md` file in `os.tmpdir()`; prints the path via `vscode.window.showInformationMessage` with a **Reveal in Finder** button. | `fs.promises.writeFile(tmp, content); vscode.window.showInformationMessage(...)` |

The three destinations differ only in delivery; the transcript content itself
is identical.

## Menu shape

**Decision: DOM submenu.** The existing context menu in `src/webview/main.js`
is a hand-rendered `<div class="session-context-menu">` with plain button
rows, not a VS Code `contributes.menus` contribution. A "▸ expanding to
three items" experience therefore requires a real submenu utility: hover-open
after ~150 ms, keyboard nav (right-arrow opens, left-arrow closes, up/down
navigate), close on escape / click outside / pointer leaving both parent and
submenu. ~80 lines of JS + CSS additions.

The rationale for spending that DOM cost now: the follow-up "Send to ▸" PR
wants the same submenu pattern, and the menu will keep growing. Building
the submenu utility once, generically, pays back twice.

**Trade-off alternatives considered:**
- Three flat top-level menu items (no submenu code, menu grows by two rows).
- A single "Copy transcript…" item that opens a VS Code QuickPick modal (zero
  new UI code, one modal step per action, no reusability for future
  submenu-based features).

Either alternative is a one-day pivot if the DOM submenu turns out fiddly.

## Content: handoff-clean markdown

For every source, the transcript is a sequence of markdown sections, one per
"turn" (a user message and its assistant response), timestamped:

```markdown
# <title from customTitle / session title>

*Copied from <Source> · session `<sessionId>` · <N> turns.*

---

## Turn 1  ·  2026-07-20 19:10:24

**User:**

<user's real prose only — no system prompt scaffolding>

**Assistant:**

<assistant's text response only — no tool_use, no tool_result, no thinking>

---

## Turn 2  ·  2026-07-20 19:11:03

…
```

**Sanitization rules applied per source (all in the "strip" direction):**

- **Claude** (`~/.claude/projects/**/*.jsonl`) — iterate line-per-event JSONL.
  Keep `user` events' `message.content` string (or joined array-of-parts if
  parts are text). Keep `assistant` events' text-typed parts. Drop
  `tool_use`, `tool_result`, `thinking`, meta / system events. If a user
  event's content contains a Copilot-style `<userRequest>...</userRequest>`
  wrapper (unusual for Claude but possible if the user pasted a Chat
  transcript into it), inner text wins.
- **Bob** (SQLite `~/.bob/db/bob.db`, `messages` table) — extend the existing
  Python subprocess pattern from `_getBobRecentExchanges` to fetch **all**
  messages for the task, not just the last 6. Roles map directly. No
  scaffolding wrappers in Bob's format.
- **Codex** (rollout `.jsonl`) — walk **all** lines (not just the tail like
  the preview extractor does). Keep `response_item` records where
  `payload.role` is `user` or `assistant`; extract text from `payload.content`
  parts of type `input_text` or `output_text`. Drop `session_meta`,
  `function_call`, `function_call_output`, `reasoning`, etc.
- **Chat** (workspaceStorage `chatSessions/*.jsonl`) — replay the snapshot +
  deltas (both `kind: 1` field updates and `kind: 2` array pushes) into a
  reconstructed `requests[]` array. User text: unwrap
  `result.metadata.renderedUserMessage[]` and pull the content inside the
  `<userRequest>...</userRequest>` tag if present; fall back to the outer
  text if not. Assistant text: concatenate string `value` fields in
  `response[]`.

**One consequence to name explicitly:** for very long sessions, the resulting
markdown can be large (hundreds of KB). Clipboard writes handle it fine.
Editor + File flavors handle it fine. No pagination or truncation is
introduced — the user opted in via right-click.

## Component changes

### `src/SessionManager.ts` — one new method + four per-source extractors

```ts
async exportFullTranscript(sessionId: string): Promise<string | null>
```

Dispatches by `_sessionSources.get(sessionId)` to one of:

- `_getClaudeFullTranscript(filePath): Promise<TranscriptTurn[]>`
- `_getBobFullTranscript(taskId): Promise<TranscriptTurn[]>`
- `_getCodexFullTranscript(filePath): Promise<TranscriptTurn[]>`
- `_getChatFullTranscript(filePath): Promise<TranscriptTurn[]>`

Where `TranscriptTurn` is a new module-local type:
```ts
interface TranscriptTurn {
  userText?: string;
  assistantText?: string;
  timestamp?: Date;
}
```

The extractors return structured turns; a shared `renderTranscriptAsMarkdown()`
helper formats them into the markdown shape shown above. Returns `null` if
the session isn't found; returns an empty string if no exchangeable text is
present (edge: a brand-new session with no completed turns).

### `src/SessionSwitcherViewProvider.ts` — three new command handlers

New commands (registered in `resolveWebviewView`):
- `copyTranscriptToEditor` → open untitled markdown editor
- `copyTranscriptToClipboard` → `vscode.env.clipboard.writeText`
- `copyTranscriptToFile` → write to `os.tmpdir()`, `showInformationMessage`
  with a **Reveal in Finder** action button that runs
  `vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(tmpPath))`

Each handler:
1. Calls `sessionManager.exportFullTranscript(sessionId)`.
2. If `null` (session vanished), shows a warning toast.
3. If empty (no turns), shows an info toast.
4. Otherwise delivers per its destination.

### `src/webview/main.js` — submenu utility + one new parent item

Add a **`openSubmenu(parentBtn, items)` utility** (~50 lines) that:
- Renders a second `<div class="session-context-menu session-context-menu--sub">`
  positioned to the right of the parent (flip left if it overflows).
- Handles hover-in (150 ms delay to open), hover-out (200 ms delay to close),
  keyboard right-arrow (open), left-arrow (close), up/down (navigate).
- Auto-closes when a leaf item is clicked or when the outer menu closes.

Extend the existing `items` array in `openContextMenu` with:
```js
{ label: 'Copy transcript ▸', submenu: [
    { label: 'To editor',    action: () => vscodeApi.postMessage({ type: 'copyTranscriptToEditor',    sessionId: session.sessionId }) },
    { label: 'To clipboard', action: () => vscodeApi.postMessage({ type: 'copyTranscriptToClipboard', sessionId: session.sessionId }) },
    { label: 'To file',      action: () => vscodeApi.postMessage({ type: 'copyTranscriptToFile',     sessionId: session.sessionId }) },
]},
```

Items with a `submenu` field render as `> ▸`-suffixed rows that open the
submenu on click/hover instead of dispatching a `postMessage`.

### `src/webview/styles.css` — one new class

`.session-context-menu--sub` — same visual style as the base menu, with an
`::before` chevron on parent rows. ~10 lines.

### `package.json` — no changes

No new user-facing commands, no menu contributions (the DOM menu handles
everything), no config settings.

## Testing

Unit tests in `src/test/SessionManager.test.ts`:

1. `_getClaudeFullTranscript` — user + assistant text extracted; tool_use /
   tool_result records ignored; turn ordering preserved.
2. `_getBobFullTranscript` — returns all messages, not just the last 6.
3. `_getCodexFullTranscript` — full walk (not tail-only); `response_item`
   records only; function_call / session_meta records dropped.
4. `_getChatFullTranscript` — delta replay works; `<userRequest>` unwrapping
   works; sessions with empty `requests[]` (all activity in deltas) work.
5. `exportFullTranscript` — dispatch across all four sources; returns `null`
   for unknown sessionId; empty-turns edge case returns empty string.
6. `renderTranscriptAsMarkdown` — snapshot: given a fixed array of turns,
   produces the expected markdown (header, turn sections, separators, etc.).

New tests: ~150 lines.

Integration test for the webview submenu: skipped for now — the existing
tests don't exercise the DOM code path either, and a submenu can be manually
verified in the same VSIX install pass we already do.

## Manual verification (Task 10-style)

- Right-click any Claude row → **Copy transcript ▸ To editor** — opens a new
  untitled `.md` tab with the extracted transcript, user + assistant only.
- Same for a Bob row, Codex row, Chat row.
- Right-click → **Copy transcript ▸ To clipboard** — status message
  confirms; paste into any editor works.
- Right-click → **Copy transcript ▸ To file** — info toast with a **Reveal
  in Finder** button; click reveals the file.
- Hover the parent item → submenu opens after ~150 ms.
- Right-arrow on parent → submenu opens and focuses first item.
- Left-arrow inside submenu → returns to parent.
- Escape → closes both menus.

## Files changed (target diff)

- `src/SessionManager.ts` — one dispatcher + four extractors + one markdown
  renderer. ~250 lines added.
- `src/SessionSwitcherViewProvider.ts` — three command handlers. ~60 lines
  added.
- `src/webview/main.js` — submenu utility + one parent item + three postMessage
  wiring cases. ~90 lines added.
- `src/webview/styles.css` — submenu style. ~15 lines added.
- `src/test/SessionManager.test.ts` — new describe blocks. ~150 lines added.
- `package.json` — version bump `0.0.8 → 0.0.9` in the final task.

Total: ~560 lines, similar to the medium tasks in PR #10.

## Risk

Low. Read-only across all sources. The only interaction with a live session
is placing text on the clipboard / in an editor tab / in a temp file — none
of which affects the source. Chat delta-replay is the most complex
extractor and has a real one-off example (the manual exercise) proving it
works. Codex full-walk mirrors the preview logic, just doesn't tail-slice.
Bob uses the same Python subprocess pattern as the existing preview.

The submenu utility is the highest-risk piece of the diff — it's UI code
that has to interact with keyboard nav, focus management, and pointer
events. A pass with the manual verification checklist will catch UX bugs.

## Divergence from user's original sketch

The user asked for `Copy/Move to <destination>` framing. This spec renames
the top-level action to **`Copy transcript`** for two reasons: (1)
"move" oversells what any mechanism here can actually guarantee (the source
keeps existing), and (2) reserving "Send to <target-session> ▸" for the
follow-up PR keeps the two features linguistically distinct — `Copy
transcript ▸ …` is a data export, `Send to ▸ …` is a live-injection.
