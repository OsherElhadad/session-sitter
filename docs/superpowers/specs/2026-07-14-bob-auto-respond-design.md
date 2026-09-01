# Design: Bob Auto-Respond

**Date:** 2026-07-14
**Status:** Approved (brainstorming) — pending spec review, then implementation plan
**Related:** [2026-07-14-bob-send-message-research.md](2026-07-14-bob-send-message-research.md)

---

## Goal

From the Session Sitter, detect a configured text pattern in a Bob
session's most recent **assistant** message and automatically send a configured
reply **into that same existing session** — fully automatically, deduplicated so
each rule fires at most once per message. This lets Bob continue without manual
intervention (e.g. auto-answer "Do you want to continue?" with "yes").

Covers both **free-text replies** and, as a sequenced follow-up, **approval
prompts**.

---

## Key findings that shape the design

These come from reading Bob's compiled bundle
(`…/IBM Bob/resources/app/extensions/bob-code/dist/extension.js`, ~14 MB) and
inspecting the running process tree. They supersede parts of the earlier research
doc.

1. **No reachable in-process send-to-existing-session API.** All 40 `bob-code.*`
   commands and all 6 exported API methods were enumerated. `startTask` and
   `sendMessageWithHiddenPrompt` both call `openTask({useWorkspace})` /
   `openTask({})` with **no `taskId`**, so they always create a *new* task.
2. **The only real send primitive is `manager.handleInputMessage(...)`**, and the
   only way to obtain the chat manager for an arbitrary `taskId` is
   `t.openTask({taskId})`, where `t` is the module-local `TaskManager` instance
   (`Nh`). `Nh` is **not** on any exports object or singleton — no property-graph
   path from another extension.
3. **`require.cache` / reflection cannot reach `Nh`** — it is a module-scoped
   `let` created inside `activate()`, never assigned to `module.exports` or a
   static. Confirmed dead end.
4. **The `messageQueue` path does not auto-send to an idle session.**
   `restoreQueue()` only *displays* the queue; `drainQueue()` (which calls
   `handleInputMessage`) only fires *after a turn completes*. An idle/waiting
   session never drains. Confirms the research doc's caveat.
5. **The cross-window bus reliably *reuses* a session** — its handler calls
   `openTask({taskId, location:"mainPanel"})`, loading the real conversation from
   the DB. But it **rejects same-window requests** (`sourceWindowId !== windowId`),
   so it only helps across windows, and it sends nothing on its own.
6. **Runtime architecture (decisive):** Bob's extension host runs as a **remote
   Linux Node process in WSL2** (`bobide-server … --type=extensionHost`; one
   process per open Bob window). The Windows app is only the UI client across the
   remote channel. Therefore:
   - **PowerShell / SendKeys UI automation is not reachable** from where our
     extension code runs (Linux remote host cannot drive the Windows client's
     webview keyboard). `powershell.exe` is not on PATH in this environment.
   - **The Node inspector IS reachable**: the ext-host is a normal Node process on
     the same machine; `SIGUSR1` opens its inspector on `127.0.0.1:9229` at
     runtime. Via CDP, `Runtime.getProperties` on an exported API method function
     exposes its `[[Scopes]]` closure, from which `t` (`Nh`) can be extracted, then
     `t.openTask({taskId}).handleInputMessage(...)` called directly.

**Conclusion:** true auto-send is only achievable by going *around* Bob's private
JS via the local Node inspector. UI automation is dead in this remote setup.

---

## Components

Three decoupled units, each independently testable.

### 1. `AutoResponder`

- **Does:** watches Bob sessions and fires configured replies on pattern match.
- **Depends on:** `SessionManager` (`onDidChangeSessions`, `getRecentExchanges`),
  a `BobSender`, and VS Code configuration.
- **Behaviour:**
  - Subscribes to `SessionManager.onDidChangeSessions` (fired from the existing
    5 s `_runScan()` loop).
  - For each `source === 'bob'` session, reads recent exchanges and takes the
    latest **assistant** message.
  - Matches its text against each rule in `sessionSitter.autoRespond`
    (`{matchPattern, response, source}`); `matchPattern` is a JS regex string.
  - **Dedup:** `Map<sessionId, string>` of the last-fired message key (message
    `created_at`/id). Fire only when the matched message key differs from the
    stored one. Reset/allow again once a *newer* user message appears in the
    session (so the same rule can fire on a later prompt).
  - On a fresh match → `await sender.send(taskId, rule.response)`.
- **Interface:** `start()` / `dispose()`. No UI; logs actions to an output channel.

### 2. `BobSender` (interface + implementations)

```ts
interface BobSender {
  /** Send `text` as a user message into the existing Bob task `taskId`. */
  send(taskId: string, text: string): Promise<void>;
  /** Cheap capability probe used at startup to pick a working sender. */
  isAvailable(): Promise<boolean>;
}
```

- **`InspectorSender` (primary):**
  1. Locate the correct ext-host PID for the target Bob window (multiple hosts run;
     match by workspace/task ownership — resolved during the spike).
  2. `process.kill(pid, 'SIGUSR1')` to open the inspector; discover the ws URL via
     `http://127.0.0.1:9229/json`.
  3. CDP session: `Runtime.evaluate` to obtain Bob's exported API object (via the
     ext-host's extension registry), then `Runtime.getProperties` on one of its
     method functions to walk `[[Scopes]]` → closure variable `t` (`Nh`).
  4. Call `t.openTask({taskId}).handleInputMessage({type:'userMessage',
     content:text, mode:'agent', meta:{mask:text}})` via `Runtime.callFunctionOn`.
  5. Detach; the port closes with the CDP session. Bind localhost-only.
- **`UiAutomationSender` (fallback / negative spike):** attempts PowerShell
  SendKeys purely to *document* that it is unreachable from the remote host. Kept
  as a recorded negative result, not a shipping path.

### 3. Configuration + wiring

- `package.json` → `contributes.configuration`:
  ```json
  "sessionSitter.autoRespond": {
    "type": "array",
    "items": { "type": "object",
      "properties": {
        "matchPattern": { "type": "string" },
        "response":     { "type": "string" },
        "source":       { "type": "string", "enum": ["bob"] }
      }, "required": ["matchPattern", "response"] },
    "default": []
  }
  ```
- `extension.ts` constructs `AutoResponder` with the selected `BobSender` and pushes
  it to `context.subscriptions`.
- The existing `sessionSitter.testBobSend` command is **repurposed** into a
  manual "send to *this existing* session" test that exercises the chosen sender
  (replacing the current `startTask` new-task test). Removed once auto-respond is
  confirmed.

---

## Data flow

```
_runScan() every 5 s
  └─ onDidChangeSessions(sessions)
       └─ AutoResponder: for each Bob session
            └─ getRecentExchanges(sessionId) → latest assistant message
                 └─ match vs autoRespond rules
                      └─ if match AND messageKey != lastFired[sessionId]:
                           └─ sender.send(taskId, rule.response)
                                └─ InspectorSender → CDP → Nh.openTask(taskId)
                                                        .handleInputMessage(...)
                           └─ lastFired[sessionId] = messageKey
```

---

## Phased implementation

1. **Spike A — `InspectorSender` (make-or-break).** Prove end-to-end:
   SIGUSR1 → CDP attach → extract `Nh` from a method's `[[Scopes]]` → one real
   `handleInputMessage` into a chosen existing session. Verify the reply appears
   in that session (not a new task).
2. **Spike B — `UiAutomationSender` (bounded, ~15 min).** Confirm and document that
   PowerShell/SendKeys is unreachable from the remote Linux ext host.
3. **Build.** `BobSender` interface + winning implementation; then `AutoResponder`
   with dedup; then config schema + `extension.ts` wiring; repurpose `testBobSend`.
4. **Follow-up (separate).** Approval-prompt answering (`ask_followup_question`
   and tool-approval requests) through the same `Nh` handle, once free-text send is
   proven.

---

## Risks & mitigations

- **Fragility (high):** `InspectorSender` depends on Node honoring `SIGUSR1`, on the
  minified closure being walkable (variable found by structure, not by the name
  `t`), and on Bob's bundle shape. → Re-verify on Bob updates; fail safe (log +
  no-op) if extraction fails; pin the discovery logic behind clear probes.
- **Security:** opens a local debug port. → Bind `127.0.0.1` only, attach for the
  minimum time, detach immediately after the call.
- **Multiple ext hosts:** several Bob windows → several `Nh`. → Select the host that
  owns the target `taskId`; if ambiguous, skip and log rather than send to the wrong
  session.
- **Wrong-session send / false positive match:** dedup + regex specificity; fully
  automatic per the approved design, but every fire is logged for auditability.
- **UI automation is not viable** in the remote setup — recorded as a negative
  result, not shipped.

---

## Spike results (2026-07-14)

- **Spike A — `InspectorBobSender`: PASS.** Built the throwaway
  `sessionSitter.spikeInspectorSend` command, installed the extension into
  the live Bob, and ran it. Result toast: `[spike] OK: sent to 2349128589afc99…`.
  The message `SPIKE OK — auto-respond test` appeared as a **user message in the
  existing conversation** (not a new task) and Bob began responding. Confirms:
  our extension shares the ext-host with `IBM.bob-code`; the exported API method's
  `[[Scopes]]` closure yields the `TaskManager` (`Nh`); `Nh.openTask({taskId})`
  loads the task from the shared DB and `handleInputMessage(...)` sends into it.
  The mechanism is viable — proceed with the full build.
- **Spike B — UI automation: N/A / non-viable.** `powershell.exe` is unreachable
  from the remote Linux extension host; not implemented (see Task 2).

## Out of scope

- Claude (non-Bob) auto-respond — the send mechanism differs; this design is
  Bob-only (`source: "bob"`).
- Any change to Bob itself; filing an IBM feature request for a supported
  `sendMessageToTask(taskId, content)` API remains the recommended long-term fix
  and is tracked separately.
