# Research: Sending Messages Programmatically to IBM Bob Sessions

**Goal:** From the Session Sitter panel, detect a specific text pattern in the
last messages of a Bob session and automatically send a configured reply into that session
as if the user typed it — so Bob continues without manual intervention.

---

## Environment

| Item | Value |
|---|---|
| Host OS | Windows (Bob IDE runs natively on Windows) |
| Dev environment | WSL2 (extension is developed and compiled here) |
| Bob IDE install | `C:\Users\332543756\AppData\Local\Programs\IBM Bob` |
| Bob DB | `~/.bob/db/bob.db` (SQLite, queried from WSL via `python3`) |
| Bob extension ID | `IBM.bob-code` (built-in, not in user extensions folder) |
| Bob extension source | `…\IBM Bob\resources\app\extensions\bob-code\dist\extension.js` |

---

## What Was Tried — Chronologically

### Attempt 1 — `bob-code.sendMessageWithHiddenPrompt` directly

**Command:** `bob-code.sendMessageWithHiddenPrompt(mask, content)`

**Result:** ✅ The command exists and works. Bob received "Hello World" and replied.

**Problem:** It always opened a **new session** instead of sending to the existing one.

**Root cause (found by reading Bob's compiled source):**

```js
// Zas() in extension.js
registerCommand("bob-code.sendMessageWithHiddenPrompt", async (mask, content) => {
  await commands.executeCommand("bobChatView.focus");
  (await t.openTask({})).handleInputMessage({   // ← openTask({}) with NO taskId
    type: "userMessage", content, mode: "agent", meta: { mask }
  });
});
```

`openTask({})` — called with no `taskId` — **always detaches the current task and
creates a brand-new empty task**. There is no way to make this command target an
existing session.

---

### Attempt 2 — Cross-window task-open bus (first try)

Bob has an internal `TaskOpenBus` that watches a directory for JSON request files.
When it finds one it calls `openTask({taskId})`, which **does** reuse an existing task.

**Directory:** `%APPDATA%\IBM Bob\User\globalStorage\ibm.bob-code\cross-window-task-open\requests\`

**Request file format:**
```json
{
  "requestId": "<uuid>",
  "sourceWindowId": "<uuid>",
  "taskId": "<bob-task-id>",
  "targetWorkspaceUri": "file:C:/Users/…/project",
  "createdAt": 1234567890
}
```

**`shouldHandle()` logic:**
```js
shouldHandle(e) {
  return e.sourceWindowId !== this.windowId   // reject same-window requests
    && this.options.getWorkspaceUris().includes(e.targetWorkspaceUri);
}
```

**Result:** Still opened a new session.

**Root cause:** Our code used `vscode.Uri.file(path).toString()` which produces
`file:///mnt/c/Users/…` (WSL path). Bob's `formatUri` produces `file:C:/Users/…`
(Windows path, single colon, no `//`). The `targetWorkspaceUri` never matched so
`shouldHandle()` returned `false` and the request was silently ignored.

---

### Attempt 3 — Cross-window bus (fixed URI format)

Fixed by constructing the URI directly from the raw Windows path stored in Bob's DB:

```ts
const winPath = bobSession.projectPath.replace(/\\/g, '/');
const targetWorkspaceUri = `file:${winPath}`;   // → "file:C:/Users/…"
```

**Result:** Still opened a new session (untested definitively — likely still fails).

**Root cause (deeper analysis):** Even if the bus delivers the request and Bob calls
`openTask({taskId})` to load the right task into the main panel, the subsequent call
to `sendMessageWithHiddenPrompt` immediately calls `openTask({})` again which
**detaches and replaces** whatever is in the main panel. The two steps fight each other.

The cross-window bus + `sendMessageWithHiddenPrompt` cannot work together.

---

### Attempt 4 — Extension exports API (`IBM.bob-code` exports)

IBM Bob's `activate()` function returns a public API object `I` (source: `LUn(Nh, findings)`):

```js
function LUn(t, e) {
  return {
    registerSource(n, a) { … },
    setFindings(n, a, o) { … },
    setChatContent(n, a) { t.getTopLevelChatManager()?.setChatInput(n, a) },
    async openNewTask(n) { … openTask({useWorkspace, defaultMode}) … },
    async startTask(n) {
      await commands.executeCommand("bobChatView.focus");
      (await t.openTask({useWorkspace: n.workspaceFolder, defaultMode: n.mode}))
        .handleInputMessage({type:"userMessage", content:n.content, mode:n.mode, meta:{mask:n.mask}});
    },
    async startWorkflow(n) { … },
  };
}
```

Accessible via:
```ts
const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
const bobApi = bobExt.isActive ? bobExt.exports : await bobExt.activate();
await bobApi.startTask({ workspaceFolder, mode: 'agent', content: 'Hello World', mask: 'Hello World' });
```

**Current status:** This is the current implementation in `src/extension.ts` as
`sessionSitter.testBobSend`. **Not yet tested.**

**Limitation:** `startTask` calls `openTask({useWorkspace})` — no `taskId` — so it
**still creates a new task** in the given workspace. It won't continue an existing
conversation. It is Bob's intended public API for programmatically starting a task.

---

## What `openTask({taskId})` Does (the right path — not yet reachable)

From Bob's compiled source, `openTask` with a `taskId` **does** work correctly:

```js
async openTask(e) {
  let n = this.mainPanelTask;
  let o;
  if (e.taskId && (o = this.getChatManagerByTaskId(e.taskId), o)) {
    if (o.hasView()) return o.view?.focus(), o;            // already open → focus it
    if (a) return n && n.setWebview(void 0),               // detach current
               o.setWebview(this._mainPanel), o;           // attach existing task
  }
  // no taskId or not found → fall through to new task...
  let r = o || this.newTaskInstance();
  o || (e.taskId && c
    ? await r.newTask({taskId: e.taskId})    // ← load from DB by ID!
    : await r.newTask({cwf: e.useWorkspace}) // ← brand new
  );
  …
}
```

Key: `openTask({taskId})` will **load an existing conversation from the DB** even if
it isn't currently open in any panel. After loading, `handleInputMessage` sends the
message into that existing conversation thread.

**Problem:** `openTask` is on `Nh` (the internal `TaskManager` instance) which is a
module-level `let` in Bob's extension bundle. It is **not exported** and is not
reachable via any public API or `vscode.commands`.

---

## Full Map of Bob's Public Surface

### Registered VS Code commands (`bob-code.*`)

| Command | What it does |
|---|---|
| `bob-code.task.history` | Toggle the session history panel in the sidebar |
| `bob-code.task.historyWithNotification` | Same with notification |
| `bob-code.openSettings` | Open Bob settings |
| `bob-code.task.export` / `import` / `wipe` | Task data management |
| `bob-code.task.pickWorkspace` | New Bob session — workspace picker UI |
| `bob-code.task.pickWorkspaceInEditor` | Same, in editor tab |
| `bob-code.task.exportCurrent` | Export the currently-open task |
| `bob-code.task.workflow` | Start a workflow |
| `bob-code.explainFile` / `explainFolder` / `explainCode` | Contextual explain actions |
| `bob-code.improveCode` | Code improvement action |
| `bob-code.addToContext` | Add selection to current chat context |
| `bob-code.generateCommitMessage` | AI commit message |
| `bob-code.createPullRequest` | AI PR creation |
| `bob-code.sendMessageWithHiddenPrompt` | **Send message — always new task** |
| `bob-code.SidebarProvider.focus` | Toggle Bob sidebar visibility |
| `bob-code.getRulesText` | Get workspace rules text |
| `bob-code.getInlineEditSlashCommands` | Get inline edit commands |
| `bob-code.getAIContributions` | Get AI contributions |
| `bob-code.reportIssue` | Report issue |
| `bob-code.captureTelemetryEvent` | Telemetry |
| `bobChatView.focus` | Focus Bob chat view (built-in view command) |

### Exported extension API (`IBM.bob-code` exports)

| Method | Signature | Notes |
|---|---|---|
| `startTask` | `{workspaceFolder, mode, content, mask}` | Sends message, **always new task** |
| `openNewTask` | `{workspaceFolder, defaultMode, defaultContent}` | Opens task, no send |
| `setChatContent` | `(text, append?)` | Sets input box text only, does not submit |
| `startWorkflow` | `{workspaceFolder, id, defaultMeta}` | Starts a workflow |
| `registerSource` | `(name, handler)` | Register a findings source |
| `setFindings` | `(source, name, findings)` | Push findings to Bob |

### Internal (not reachable)

| Symbol | Description |
|---|---|
| `Nh` | The `TaskManager` instance — has `openTask({taskId})`, `getTopLevelChatManager()` |
| `Fos()` | `Nh?.getTopLevelChatManager()?.getTaskId()` — not exported |
| `t.openTask({taskId})` | The key method — loads existing task from DB and makes it active |
| `chat.handleInputMessage(…)` | Sends a message to the currently-loaded task |

---

## The Correct Solution (Not Yet Implemented)

To send a message to a **specific existing Bob session** without creating a new task,
we need to call:

```js
Nh.openTask({ taskId: "<bob-task-id>" })
  .then(manager => manager.handleInputMessage({
    type: "userMessage",
    content: "your message",
    mode: "agent",
    meta: { mask: "your message" }
  }));
```

Since `Nh` is not exported, there are three realistic paths forward:

### Path A — Request IBM to expose the API (recommended long-term)

File a feature request with IBM Bob asking for either:
- `bob-code.sendMessageToTask(taskId, content)` — a new command that takes a task ID
- OR adding an optional `taskId` parameter to `sendMessageWithHiddenPrompt`

**Precedent:** An identical request was filed for Claude Code:
[github.com/anthropics/claude-code/issues/27873](https://github.com/anthropics/claude-code/issues/27873)

### Path B — Reach `Nh` via reflection (hacky, fragile)

Bob's compiled bundle is a single IIFE. In Node.js (which is what VS Code extensions
run in), module-level variables of other extensions' bundles are **not reachable** via
`global` or `require` because the extension is loaded in its own module scope.

However, the exports API object `I = LUn(Nh, …)` holds a closure over `Nh`. It may
be possible to extract `Nh` by:

1. Patching `I.setChatContent` temporarily and inspecting the closure
2. Using Node.js `vm` module inspection (blocked by VS Code's extension host sandbox)
3. Reading `Nh` from the extension host's module registry via `require.cache`

All of these are fragile and may break on Bob updates.

### Path C — Write directly to Bob's SQLite DB (medium risk)

Bob reads messages from `~/.bob/db/bob.db`. The `messages` table stores all
conversation history. A new user message could be inserted directly, then the task
triggered to resume via `bob-code.task.history` or similar.

**Risk:** Bob may validate message ownership, IDs, or ordering. Writing to a live
SQLite DB without Bob's ORM could cause corruption or be ignored entirely.
The `message_queue` column in `tasks` is used for restore-on-open only, not
for injecting new messages into running tasks.

---

## Pattern-Matching Feature Design (for when send is solved)

Once reliable message sending is available, the auto-respond feature works as follows:

### Configuration (VS Code settings)

```json
"sessionSitter.autoRespond": [
  {
    "matchPattern": "Do you want to continue",
    "response": "yes",
    "source": "bob"
  },
  {
    "matchPattern": "Proceed\\?",
    "response": "y",
    "source": "bob"
  }
]
```

### Implementation sketch

```
SessionManager._runScan()  (every 5 s)
  └─ for each Bob session:
       └─ getRecentExchanges(sessionId)
            └─ check last assistant message against autoRespond rules
                 └─ if match AND not already fired for this (sessionId, messageTimestamp):
                      └─ sendToBobSession(sessionId, rule.response)
                           └─ [calls whatever mechanism is available]
```

**Deduplication:** Keep a `Map<string, string>` of `sessionId → lastFiredTimestamp` to
prevent re-firing the same rule on the same message. Clear when the session gets a
new user message.

**Location:** Add to `SessionSitterViewProvider` or a new `AutoResponder` class
that `SessionManager.onDidChangeSessions` feeds into.

---

## Files Modified in This Investigation

| File | Change |
|---|---|
| `src/extension.ts` | Added `sessionSitter.testBobSend` command (test only) |
| `package.json` | Registered `sessionSitter.testBobSend` in `contributes.commands` |

The test command (`sessionSitter.testBobSend`) should be **removed** once a
working send mechanism is confirmed. It currently calls `bobApi.startTask(…)` which
creates a new task — useful for proving the API surface works but not the final goal.

---

## Next Steps

1. **Test current code** — run `sessionSitter.testBobSend` and confirm
   `bobApi.startTask` at least sends "Hello World" into Bob (new task is acceptable
   for now as a proof-of-concept for the API path)

2. **Investigate Path B** — check whether `require.cache` in the VS Code extension
   host exposes Bob's module scope, e.g.:
   ```ts
   const cache = (require as any).cache;
   const bobModule = Object.values(cache).find((m: any) =>
     m?.exports?.startTask && m?.exports?.setChatContent
   );
   // then inspect bobModule for Nh
   ```

3. **File IBM Bob feature request** — request `bob-code.sendMessageToTask(taskId, content)`

4. **Implement pattern-matching engine** — once send works, wire
   `autoRespond` settings into `SessionManager`'s scan loop
