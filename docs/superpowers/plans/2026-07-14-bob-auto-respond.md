# Bob Auto-Respond Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a configured text pattern in a Bob session's latest assistant message and automatically send a configured reply into that same existing Bob session, fully automatically and deduplicated per message.

**Architecture:** A `BobSender` abstraction sends text into an existing Bob task. Its production implementation, `InspectorBobSender`, uses Node's built-in `inspector` module to connect to our own extension-host process, walks the closure scope of IBM Bob's exported API to recover the private `TaskManager` instance (`Nh`), and calls `Nh.openTask({taskId}).handleInputMessage(...)` — which loads any task from Bob's shared SQLite DB by id and sends the message into it. An `AutoResponder` watches `SessionManager.onDidChangeSessions`, matches the latest assistant message of each Bob session against user-configured rules, dedupes, and fires the sender.

**Tech Stack:** TypeScript, VS Code Extension API (`^1.64.0`), Node built-in `inspector` module, vitest.

## Global Constraints

- VS Code engine floor: `^1.64.0` (copied from `package.json` `engines.vscode`).
- No new runtime dependencies — use only Node built-ins (`inspector`) and existing deps.
- Tests run with `npm test` (`vitest run`). Test files live in `src/test/*.test.ts`.
- Compile with `npm run compile` (runs `gen-build-info.js` then `tsc -p ./`). Lint with `npm run lint` (`eslint src`).
- Auto-respond is **Bob-only**: rules apply only to sessions with `source === 'bob'`.
- Sending is **fully automatic** with per-message dedup; every send is logged to an output channel for auditability.
- The mechanism is knowingly fragile (depends on Bob's minified bundle). Every failure path must **fail safe**: log and no-op, never throw out of the scan loop.

---

## Mechanism reference (read before Task 1)

Facts established from Bob's bundle (`…/IBM Bob/resources/app/extensions/bob-code/dist/extension.js`) and the running process tree. See `docs/superpowers/specs/2026-07-14-bob-auto-respond-design.md`.

- Our extension and `IBM.bob-code` run in the **same** VS Code extension-host Node process (per window). So Bob's private objects are in our own heap.
- `vscode.extensions.getExtension('IBM.bob-code').exports` returns Bob's public API object `I`. `I` was created by `LUn(t, e)` and its methods (`startTask`, `setChatContent`, etc.) **close over `t`** — the `TaskManager` instance (`Nh`). `t` is not a property of `I`; it is only reachable as a closure variable.
- The V8 inspector exposes closure variables: `Runtime.getProperties` on a **function**'s `objectId` (with `ownProperties:false`) returns an internal property `[[Scopes]]`; walking into the `Closure` scope yields `t`.
- `t.openTask({taskId})` (panel `TaskManager`, class `_E`): if the task is not already open it calls `newTask({taskId})`, **loading it from the shared DB by id**, then returns the chat manager. `manager.handleInputMessage({type:'userMessage', content, mode:'agent', meta:{mask:content}})` sends the message into that task and triggers the agent.
- Confirmed non-options: no `bob-code.*` command or exported method accepts a `taskId` to send; `require.cache` cannot reach `Nh`; the `messageQueue` path does not drain when idle; PowerShell/SendKeys is unreachable from the remote Linux ext host.

---

## File Structure

- Create: `src/BobSender.ts` — `BobSender` interface, `AutoRespondRule` type, `InspectorBobSender`, and the pure closure-walk helper `pickClosureTaskManager`.
- Create: `src/AutoResponder.ts` — `AutoResponder` class (rule matching + dedup + wiring to `SessionManager`), and pure helpers `matchRule` and `messageKey`.
- Create: `src/test/BobSender.test.ts` — tests for `pickClosureTaskManager` against mocked CDP `getProperties` shapes.
- Create: `src/test/AutoResponder.test.ts` — tests for `matchRule`, `messageKey`, and dedup behaviour.
- Modify: `src/extension.ts` — construct `AutoResponder`; repurpose `claudeSessionSwitcher.testBobSend` into a manual send-to-existing-session test.
- Modify: `package.json` — add `contributes.configuration` for `claudeSessionSwitcher.autoRespond`; keep the `testBobSend` command entry.

---

## Task 1 (SPIKE — GO/NO-GO GATE): Prove `Nh` extraction + send into an existing session

**This task is a manual feasibility gate. Do NOT start Task 3+ until this passes.** If it cannot be made to work, stop and report; the whole true-auto-send approach depends on it.

**Files:**
- Create (throwaway): `src/spikeInspector.ts`
- Modify: `src/extension.ts` (temporarily register `claudeSessionSwitcher.spikeInspectorSend`)

**Interfaces:**
- Produces (for Task 3): a proven CDP call sequence and the closure-walk shape that `InspectorBobSender` will productionize.

- [ ] **Step 1: Write the spike module**

Create `src/spikeInspector.ts`:

```ts
import * as vscode from 'vscode';
import * as inspector from 'inspector';

// Throwaway spike: extract Bob's private TaskManager (Nh) via the V8 inspector
// and send a message into an EXISTING task (by taskId). Verifies feasibility.
export async function spikeInspectorSend(taskId: string, text: string): Promise<string> {
  const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
  if (!bobExt) { return 'FAIL: IBM.bob-code not found'; }
  const api = bobExt.isActive ? bobExt.exports : await bobExt.activate();
  if (!api?.startTask) { return 'FAIL: no api.startTask'; }

  // Expose the api object so Runtime.evaluate can obtain an objectId for it.
  (globalThis as any).__csw_bobApi = api;

  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: any): Promise<any> =>
    new Promise((res, rej) => session.post(method, params, (e: any, r: any) => e ? rej(e) : res(r)));

  try {
    await post('Runtime.enable');

    // 1. objectId of one of the api's closure-bearing methods.
    const fn = await post('Runtime.evaluate', {
      expression: 'globalThis.__csw_bobApi.startTask',
      returnByValue: false,
    });
    const fnId = fn.result.objectId as string;

    // 2. Function internals → [[Scopes]].
    const fnProps = await post('Runtime.getProperties', { objectId: fnId, ownProperties: false, generatePreview: false });
    const scopesEntry = (fnProps.internalProperties || []).find((p: any) => p.name === '[[Scopes]]');
    if (!scopesEntry) { return 'FAIL: no [[Scopes]] on startTask'; }

    // 3. Enumerate scopes; for each Closure scope, look for a var that is the TaskManager.
    const scopes = await post('Runtime.getProperties', { objectId: scopesEntry.value.objectId, ownProperties: false });
    for (const scope of scopes.result || []) {
      if (!scope.value?.objectId) { continue; }
      const vars = await post('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      for (const v of vars.result || []) {
        if (!v.value?.objectId) { continue; }
        // Probe: does this object have openTask + getChatManagerByTaskId + mainPanelTask?
        const probe = await post('Runtime.callFunctionOn', {
          objectId: v.value.objectId,
          functionDeclaration: 'function(){return typeof this.openTask==="function" && typeof this.getChatManagerByTaskId==="function";}',
          returnByValue: true,
        });
        if (probe.result?.value === true) {
          // Found Nh. Send into the existing task.
          const send = await post('Runtime.callFunctionOn', {
            objectId: v.value.objectId,
            functionDeclaration:
              'function(taskId, text){ return Promise.resolve(this.openTask({taskId})).then(m => m.handleInputMessage({type:"userMessage", content:text, mode:"agent", meta:{mask:text}})); }',
            arguments: [{ value: taskId }, { value: text }],
            awaitPromise: true,
            returnByValue: false,
          });
          if (send.exceptionDetails) { return 'FAIL: send threw: ' + JSON.stringify(send.exceptionDetails); }
          return 'OK: sent to ' + taskId;
        }
      }
    }
    return 'FAIL: TaskManager not found in any closure scope';
  } finally {
    session.disconnect();
    delete (globalThis as any).__csw_bobApi;
  }
}
```

- [ ] **Step 2: Register a temporary command in `src/extension.ts`**

Add inside `activate()` (near the existing `testBobSend` registration):

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('claudeSessionSwitcher.spikeInspectorSend', async () => {
    const { spikeInspectorSend } = await import('./spikeInspector');
    const sessions = sessionManager.getSessions()
      .filter(s => s.source === 'bob')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (sessions.length === 0) { void vscode.window.showWarningMessage('No Bob sessions.'); return; }
    const target = sessions[0];
    const result = await spikeInspectorSend(target.sessionId, 'SPIKE OK — auto-respond test');
    void vscode.window.showInformationMessage(`[spike] ${result} (session: ${target.title})`);
  })
);
```

Add the command to `package.json` `contributes.commands`:

```json
{ "command": "claudeSessionSwitcher.spikeInspectorSend", "title": "Claude Session Switcher: SPIKE Inspector Send", "category": "Claude Session Switcher" }
```

- [ ] **Step 3: Compile**

Run: `npm run compile`
Expected: no TypeScript errors.

- [ ] **Step 4: Manual verification (the gate)**

1. Package/install the extension into Bob (`vsce package` → install the `.vsix`, or run the Extension Development Host if available in Bob).
2. Open a Bob session and note it as the most-recently-updated Bob session.
3. Run **"Claude Session Switcher: SPIKE Inspector Send"** from the Command Palette.
4. Observe the info message. **PASS** = `OK: sent to <taskId>` AND the text `SPIKE OK — auto-respond test` appears as a **user message in that existing session** (verify with:
   `python3 -c "import sqlite3;c=sqlite3.connect('/home/eranra/.bob/db/bob.db');[print(r) for r in c.execute(\"SELECT role,substr(data,1,60),created_at FROM messages WHERE task_id=? ORDER BY created_at DESC LIMIT 3\", ('<taskId>',))]"`)
   and Bob begins responding — **not** a brand-new empty task.
5. Record the outcome (PASS/FAIL + the `[[Scopes]]` shape observed) in the design doc under a new "Spike results" section.

- [ ] **Step 5: Decision**

- **PASS** → commit the spike as a checkpoint, proceed to Task 3.
- **FAIL** → stop. Report the failure detail; the true-auto-send path is not viable and requires re-brainstorming (fallback to semi-automatic / IBM feature request).

```bash
git add src/spikeInspector.ts src/extension.ts package.json docs/superpowers/specs/2026-07-14-bob-auto-respond-design.md
git commit -m "spike: prove inspector-based send into existing Bob session"
```

---

## Task 2 (SPIKE — bounded, ~15 min): Record UI-automation as non-viable

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-bob-auto-respond-design.md` (append to "Spike results").

- [ ] **Step 1: Confirm the negative**

Run: `which powershell.exe; echo "---"; ls /mnt/c/Windows/System32/WindowsPowerShell/ 2>/dev/null | head -1`
Expected: `powershell.exe` not on PATH from the ext-host environment (confirming SendKeys is unreachable from the remote Linux host).

- [ ] **Step 2: Document and commit**

Append to the design doc "Spike results": "UI automation (PowerShell SendKeys) confirmed non-viable — `powershell.exe` unreachable from the remote Linux extension host. Not implemented."

```bash
git add docs/superpowers/specs/2026-07-14-bob-auto-respond-design.md
git commit -m "docs: record UI-automation sender as non-viable (spike B)"
```

---

## Task 3: `BobSender` interface + `InspectorBobSender` (productionized from the spike)

**Files:**
- Create: `src/BobSender.ts`
- Test: `src/test/BobSender.test.ts`

**Interfaces:**
- Produces: `interface BobSender { send(taskId: string, text: string): Promise<void>; isAvailable(): Promise<boolean>; }`, `interface AutoRespondRule { matchPattern: string; response: string; source?: 'bob'; }`, `class InspectorBobSender implements BobSender`, and `function pickClosureTaskManager(scopeVarProbes: Array<{name: string; isTaskManager: boolean}>): string | undefined` (returns the variable name of the first TaskManager-like closure var, or `undefined`).
- Consumes: nothing from prior tasks (spike is throwaway).

- [ ] **Step 1: Write the failing test for the pure closure-pick helper**

Create `src/test/BobSender.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickClosureTaskManager } from '../BobSender';

describe('pickClosureTaskManager', () => {
  it('returns the name of the first TaskManager-like closure var', () => {
    const probes = [
      { name: 'e', isTaskManager: false },
      { name: 't', isTaskManager: true },
    ];
    expect(pickClosureTaskManager(probes)).toBe('t');
  });

  it('returns undefined when no probe is a TaskManager', () => {
    expect(pickClosureTaskManager([{ name: 'e', isTaskManager: false }])).toBeUndefined();
  });

  it('returns undefined for an empty probe list', () => {
    expect(pickClosureTaskManager([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- BobSender`
Expected: FAIL — `pickClosureTaskManager` not exported / module missing.

- [ ] **Step 3: Write `src/BobSender.ts`**

```ts
import * as vscode from 'vscode';
import * as inspector from 'inspector';

export interface AutoRespondRule {
  matchPattern: string;
  response: string;
  source?: 'bob';
}

export interface BobSender {
  /** Send `text` as a user message into the existing Bob task `taskId`. */
  send(taskId: string, text: string): Promise<void>;
  /** Cheap capability probe: can we reach Bob's API at all? */
  isAvailable(): Promise<boolean>;
}

/** Pure helper: given probe results for each closure variable, pick the first
 *  variable whose object looks like Bob's TaskManager. Isolated for testing. */
export function pickClosureTaskManager(
  scopeVarProbes: Array<{ name: string; isTaskManager: boolean }>,
): string | undefined {
  return scopeVarProbes.find(p => p.isTaskManager)?.name;
}

const TASK_MANAGER_PROBE =
  'function(){return typeof this.openTask==="function" && typeof this.getChatManagerByTaskId==="function";}';
const SEND_FN =
  'function(taskId, text){ return Promise.resolve(this.openTask({taskId})).then(m => m.handleInputMessage({type:"userMessage", content:text, mode:"agent", meta:{mask:text}})); }';

export class InspectorBobSender implements BobSender {
  constructor(private readonly log: (msg: string) => void) {}

  async isAvailable(): Promise<boolean> {
    const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
    if (!bobExt) { return false; }
    const api = bobExt.isActive ? bobExt.exports : await bobExt.activate().catch(() => undefined);
    return typeof api?.startTask === 'function';
  }

  async send(taskId: string, text: string): Promise<void> {
    const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
    if (!bobExt) { this.log('send skipped: IBM.bob-code not found'); return; }
    const api = bobExt.isActive ? bobExt.exports : await bobExt.activate();
    if (typeof api?.startTask !== 'function') { this.log('send skipped: no api.startTask'); return; }

    (globalThis as any).__csw_bobApi = api;
    const session = new inspector.Session();
    session.connect();
    const post = (method: string, params?: any): Promise<any> =>
      new Promise((res, rej) => session.post(method, params, (e: any, r: any) => e ? rej(e) : res(r)));

    try {
      await post('Runtime.enable');
      const fn = await post('Runtime.evaluate', { expression: 'globalThis.__csw_bobApi.startTask', returnByValue: false });
      const fnId = fn.result?.objectId;
      if (!fnId) { this.log('send failed: no objectId for api.startTask'); return; }

      const fnProps = await post('Runtime.getProperties', { objectId: fnId, ownProperties: false, generatePreview: false });
      const scopesEntry = (fnProps.internalProperties || []).find((p: any) => p.name === '[[Scopes]]');
      if (!scopesEntry?.value?.objectId) { this.log('send failed: no [[Scopes]]'); return; }

      const scopes = await post('Runtime.getProperties', { objectId: scopesEntry.value.objectId, ownProperties: false });
      for (const scope of scopes.result || []) {
        if (!scope.value?.objectId) { continue; }
        const vars = await post('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
        const probes: Array<{ name: string; isTaskManager: boolean; objectId: string }> = [];
        for (const v of vars.result || []) {
          if (!v.value?.objectId) { continue; }
          const probe = await post('Runtime.callFunctionOn', {
            objectId: v.value.objectId, functionDeclaration: TASK_MANAGER_PROBE, returnByValue: true,
          });
          probes.push({ name: v.name, isTaskManager: probe.result?.value === true, objectId: v.value.objectId });
        }
        const pick = pickClosureTaskManager(probes.map(p => ({ name: p.name, isTaskManager: p.isTaskManager })));
        if (!pick) { continue; }
        const nh = probes.find(p => p.name === pick)!;
        const sendRes = await post('Runtime.callFunctionOn', {
          objectId: nh.objectId, functionDeclaration: SEND_FN,
          arguments: [{ value: taskId }, { value: text }], awaitPromise: true, returnByValue: false,
        });
        if (sendRes.exceptionDetails) { this.log('send threw: ' + JSON.stringify(sendRes.exceptionDetails)); return; }
        this.log(`sent to task ${taskId}`);
        return;
      }
      this.log('send failed: TaskManager not found in any closure scope');
    } catch (err) {
      this.log('send error: ' + String(err));
    } finally {
      session.disconnect();
      delete (globalThis as any).__csw_bobApi;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- BobSender`
Expected: PASS (3 tests).

- [ ] **Step 5: Compile and lint**

Run: `npm run compile && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/BobSender.ts src/test/BobSender.test.ts
git commit -m "feat: BobSender interface + InspectorBobSender"
```

---

## Task 4: Config schema + rule matching + message key (pure logic)

**Files:**
- Create: `src/AutoResponder.ts` (helpers only in this task)
- Test: `src/test/AutoResponder.test.ts`
- Modify: `package.json` (`contributes.configuration`)

**Interfaces:**
- Consumes: `AutoRespondRule` from `src/BobSender.ts`; `MessageExchange` from `src/SessionManager.ts`.
- Produces: `function matchRule(assistantText: string, rules: AutoRespondRule[]): AutoRespondRule | undefined` and `function messageKey(ex: MessageExchange): string`.

- [ ] **Step 1: Write failing tests**

Create `src/test/AutoResponder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchRule, messageKey } from '../AutoResponder';
import type { AutoRespondRule } from '../BobSender';
import type { MessageExchange } from '../SessionManager';

const rules: AutoRespondRule[] = [
  { matchPattern: 'Do you want to continue', response: 'yes' },
  { matchPattern: 'Proceed\\?', response: 'y' },
];

describe('matchRule', () => {
  it('matches a plain substring pattern', () => {
    expect(matchRule('Do you want to continue?', rules)?.response).toBe('yes');
  });
  it('matches a regex pattern', () => {
    expect(matchRule('Proceed?', rules)?.response).toBe('y');
  });
  it('returns undefined when nothing matches', () => {
    expect(matchRule('All done.', rules)).toBeUndefined();
  });
  it('ignores an invalid regex without throwing', () => {
    expect(matchRule('anything', [{ matchPattern: '(', response: 'x' }])).toBeUndefined();
  });
});

describe('messageKey', () => {
  it('uses the timestamp when present', () => {
    const ex: MessageExchange = { role: 'assistant', text: 'hi', timestamp: '2026-07-14T10:00:00Z' };
    expect(messageKey(ex)).toBe('2026-07-14T10:00:00Z');
  });
  it('falls back to the text when no timestamp', () => {
    expect(messageKey({ role: 'assistant', text: 'hi' })).toBe('hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- AutoResponder`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement the helpers in `src/AutoResponder.ts`**

```ts
import type { AutoRespondRule } from './BobSender';
import type { MessageExchange } from './SessionManager';

/** Return the first rule whose pattern matches the assistant text. Invalid
 *  regex patterns are skipped (never throw). */
export function matchRule(assistantText: string, rules: AutoRespondRule[]): AutoRespondRule | undefined {
  for (const rule of rules) {
    let re: RegExp;
    try { re = new RegExp(rule.matchPattern); } catch { continue; }
    if (re.test(assistantText)) { return rule; }
  }
  return undefined;
}

/** Stable identity for a message, used for dedup. */
export function messageKey(ex: MessageExchange): string {
  return ex.timestamp ?? ex.text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- AutoResponder`
Expected: PASS (6 tests).

- [ ] **Step 5: Add configuration to `package.json`**

Under `contributes`, add:

```json
"configuration": {
  "title": "Claude Session Switcher",
  "properties": {
    "claudeSessionSwitcher.autoRespond": {
      "type": "array",
      "default": [],
      "markdownDescription": "Auto-reply rules for Bob sessions. On each scan, if the latest assistant message of a Bob session matches `matchPattern` (a JavaScript regular expression), `response` is sent into that same session automatically.",
      "items": {
        "type": "object",
        "required": ["matchPattern", "response"],
        "properties": {
          "matchPattern": { "type": "string", "description": "JavaScript regex tested against the latest assistant message." },
          "response": { "type": "string", "description": "Text sent into the session on a match." },
          "source": { "type": "string", "enum": ["bob"], "default": "bob", "description": "Which IDE the rule applies to (Bob only)." }
        }
      }
    }
  }
}
```

- [ ] **Step 6: Compile, lint, commit**

Run: `npm run compile && npm run lint`
Expected: no errors.

```bash
git add src/AutoResponder.ts src/test/AutoResponder.test.ts package.json
git commit -m "feat: autoRespond config schema + rule matching helpers"
```

---

## Task 5: `AutoResponder` class (dedup + wiring to SessionManager)

**Files:**
- Modify: `src/AutoResponder.ts` (add the class)
- Test: `src/test/AutoResponder.test.ts` (add dedup tests)

**Interfaces:**
- Consumes: `matchRule`, `messageKey` (Task 4); `BobSender`, `AutoRespondRule` (Task 3); `SessionManager` (`onDidChangeSessions`, `getSessions`, `getRecentExchanges`), `ClaudeSession`, `MessageExchange` (from `src/SessionManager.ts`).
- Produces: `class AutoResponder { constructor(sessionManager, sender: BobSender, getRules: () => AutoRespondRule[], log: (m: string) => void); start(): void; dispose(): void; }` and (for testing) `async evaluateSession(session: ClaudeSession): Promise<void>`.

- [ ] **Step 1: Write failing dedup tests**

Append to `src/test/AutoResponder.test.ts`:

```ts
import { AutoResponder } from '../AutoResponder';
import type { BobSender } from '../BobSender';
import type { ClaudeSession } from '../SessionManager';

function bobSession(id: string): ClaudeSession {
  return { sessionId: id, projectName: 'p', projectPath: '/p', title: 't',
    updatedAt: new Date(), status: 'idle', source: 'bob' };
}

class FakeSender implements BobSender {
  public calls: Array<{ taskId: string; text: string }> = [];
  async isAvailable() { return true; }
  async send(taskId: string, text: string) { this.calls.push({ taskId, text }); }
}

function fakeManager(exchanges: Record<string, any[]>) {
  return {
    onDidChangeSessions: () => ({ dispose() {} }),
    getSessions: () => [] as ClaudeSession[],
    getRecentExchanges: async (id: string) => exchanges[id] ?? [],
  } as any;
}

describe('AutoResponder dedup', () => {
  const rules = [{ matchPattern: 'continue', response: 'yes' }];

  it('fires once on a matching assistant message', async () => {
    const ex = { assistant: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('assistant'));
    expect(sender.calls).toEqual([{ taskId: 'assistant', text: 'yes' }]);
  });

  it('does not re-fire for the same message key', async () => {
    const ex = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls.length).toBe(1);
  });

  it('does not fire when the latest message is from the user', async () => {
    const ex = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }, { role: 'user', text: 'ok', timestamp: 'T2' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls.length).toBe(0);
  });

  it('re-arms after a newer user message, then a new matching assistant message', async () => {
    const store: Record<string, any[]> = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(store), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));            // fires on T1
    store.s = [{ role: 'user', text: 'ok', timestamp: 'T2' }]; // user replied
    await r.evaluateSession(bobSession('s'));            // no assistant tail → no fire
    store.s = [{ role: 'assistant', text: 'continue again', timestamp: 'T3' }];
    await r.evaluateSession(bobSession('s'));            // new key → fires
    expect(sender.calls.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- AutoResponder`
Expected: FAIL — `AutoResponder` not exported.

- [ ] **Step 3: Implement the `AutoResponder` class**

Append to `src/AutoResponder.ts`:

```ts
import * as vscode from 'vscode';
import type { BobSender } from './BobSender';
import type { SessionManager, ClaudeSession } from './SessionManager';

// Minimal shape of SessionManager this class needs (keeps tests light).
type SessionSource = Pick<SessionManager, 'onDidChangeSessions' | 'getSessions' | 'getRecentExchanges'>;

export class AutoResponder {
  private disposable: vscode.Disposable | undefined;
  private readonly lastFired = new Map<string, string>(); // sessionId -> messageKey
  private running = false;

  constructor(
    private readonly sessionManager: SessionSource,
    private readonly sender: BobSender,
    private readonly getRules: () => import('./BobSender').AutoRespondRule[],
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    this.disposable = this.sessionManager.onDidChangeSessions((sessions: ClaudeSession[]) => {
      void this.evaluateAll(sessions);
    });
  }

  private async evaluateAll(sessions: ClaudeSession[]): Promise<void> {
    if (this.running) { return; } // avoid overlapping scans
    this.running = true;
    try {
      for (const s of sessions) {
        if (s.source !== 'bob') { continue; }
        await this.evaluateSession(s);
      }
    } finally {
      this.running = false;
    }
  }

  async evaluateSession(session: ClaudeSession): Promise<void> {
    const rules = this.getRules().filter(r => (r.source ?? 'bob') === 'bob');
    if (rules.length === 0) { return; }

    let exchanges;
    try { exchanges = await this.sessionManager.getRecentExchanges(session.sessionId); }
    catch (err) { this.log(`getRecentExchanges failed for ${session.sessionId}: ${String(err)}`); return; }
    if (!exchanges || exchanges.length === 0) { return; }

    const last = exchanges[exchanges.length - 1];
    if (last.role !== 'assistant') {
      // User has spoken since; re-arm this session so a future assistant prompt can fire.
      this.lastFired.delete(session.sessionId);
      return;
    }

    const { matchRule, messageKey } = await import('./AutoResponder');
    const rule = matchRule(last.text, rules);
    if (!rule) { return; }

    const key = messageKey(last);
    if (this.lastFired.get(session.sessionId) === key) { return; } // already fired for this message

    this.lastFired.set(session.sessionId, key);
    this.log(`auto-respond: session ${session.sessionId} matched /${rule.matchPattern}/ → sending "${rule.response}"`);
    try { await this.sender.send(session.sessionId, rule.response); }
    catch (err) { this.log(`send failed for ${session.sessionId}: ${String(err)}`); }
  }

  dispose(): void {
    this.disposable?.dispose();
    this.lastFired.clear();
  }
}
```

> Note: the `await import('./AutoResponder')` self-import is only to reuse the pure helpers within the same module during tests without a circular top-level import. If the executing engineer finds `tsc`/vitest resolves the direct call fine, replace it with a direct top-level call to `matchRule`/`messageKey` (they are defined in this same file) — simpler and preferred.

**Preferred simpler form (use this if top-level references resolve cleanly):** call `matchRule(last.text, rules)` and `messageKey(last)` directly, since both are defined at the top of `src/AutoResponder.ts`. Remove the dynamic `import('./AutoResponder')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- AutoResponder`
Expected: PASS (all AutoResponder tests, including the 4 dedup tests).

- [ ] **Step 5: Compile, lint, commit**

Run: `npm run compile && npm run lint`
Expected: no errors.

```bash
git add src/AutoResponder.ts src/test/AutoResponder.test.ts
git commit -m "feat: AutoResponder with per-message dedup and re-arm"
```

---

## Task 6: Wire into `extension.ts`; repurpose `testBobSend`; remove the spike

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `AutoResponder` (Task 5), `InspectorBobSender`, `AutoRespondRule` (Task 3).

- [ ] **Step 1: Add sender + AutoResponder wiring in `activate()`**

In `src/extension.ts`, after `provider` is created, add:

```ts
import { InspectorBobSender, type AutoRespondRule } from './BobSender';
import { AutoResponder } from './AutoResponder';

// ...inside activate(), after provider setup:
const output = vscode.window.createOutputChannel('Claude Session Switcher');
context.subscriptions.push(output);
const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

const sender = new InspectorBobSender(log);
const getRules = (): AutoRespondRule[] =>
  vscode.workspace.getConfiguration('claudeSessionSwitcher').get<AutoRespondRule[]>('autoRespond', []);

const autoResponder = new AutoResponder(sessionManager, sender, getRules, log);
autoResponder.start();
context.subscriptions.push({ dispose: () => autoResponder.dispose() });
```

- [ ] **Step 2: Repurpose `testBobSend` to send into the EXISTING session via the sender**

Replace the body of the `claudeSessionSwitcher.testBobSend` command registration with:

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('claudeSessionSwitcher.testBobSend', async () => {
    const target = sessionManager.getSessions()
      .filter(s => s.source === 'bob')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    if (!target) { void vscode.window.showWarningMessage('No Bob sessions found.'); return; }
    if (!(await sender.isAvailable())) { void vscode.window.showErrorMessage('Bob API not available.'); return; }
    await sender.send(target.sessionId, 'Hello World — test send to existing session');
    void vscode.window.showInformationMessage(`Sent test message to existing session: ${target.title}`);
  })
);
```

- [ ] **Step 3: Remove the throwaway spike**

Delete `src/spikeInspector.ts`, remove the `claudeSessionSwitcher.spikeInspectorSend` command registration from `src/extension.ts`, and remove its entry from `package.json` `contributes.commands`.

Run: `rm src/spikeInspector.ts`

- [ ] **Step 4: Compile, lint, test**

Run: `npm run compile && npm run lint && npm test`
Expected: no errors; all tests pass.

- [ ] **Step 5: Manual end-to-end verification**

1. Install the built extension into Bob.
2. Set a rule in settings, e.g.:
   ```json
   "claudeSessionSwitcher.autoRespond": [
     { "matchPattern": "Do you want to continue", "response": "yes", "source": "bob" }
   ]
   ```
3. In a Bob session, get Bob to emit a message containing "Do you want to continue".
4. Within ~5 s (one scan cycle), confirm "yes" is sent into **that same session** and Bob continues. Check the "Claude Session Switcher" output channel for the `auto-respond:` and `sent to task` log lines.
5. Confirm it fires only once for that message (no repeat on subsequent scans).

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json
git rm --cached src/spikeInspector.ts 2>/dev/null || true
git commit -m "feat: wire AutoResponder + InspectorBobSender; repurpose testBobSend; drop spike"
```

---

## Follow-up (separate plan, out of scope here)

- **Approval-prompt answering** (`ask_followup_question` and tool-approval requests) through the same `Nh` handle, once free-text send is proven in production.
- **Cross-window / cross-ext-host sends** if a target session's task ever cannot be loaded by the current window's `Nh` (would require `SIGUSR1` remote attach as described in the spec's risk section). Only build if Task 1/production shows same-process `openTask({taskId})` cannot load a foreign-window task.

---

## Self-Review

**Spec coverage:**
- Detect pattern in latest assistant message → Task 4 (`matchRule`) + Task 5 (`evaluateSession`). ✓
- Send into same existing session → Task 3 (`InspectorBobSender`) proven by Task 1 spike. ✓
- Fully automatic + per-message dedup → Task 5 (`lastFired` map, re-arm on user message). ✓
- Config `autoRespond` (`matchPattern`/`response`/`source`) → Task 4 (`package.json`). ✓
- Bob-only → Task 5 (`source !== 'bob'` skip; rule `source` filter). ✓
- Fail-safe logging, no throw out of scan loop → Task 5 (try/catch per session + running guard) + Task 3 (send swallows errors, logs). ✓
- UI-automation recorded non-viable → Task 2. ✓
- Repurpose/remove `testBobSend`; remove spike → Task 6. ✓
- Localhost-only / no persistent debug port → satisfied by using the in-process `inspector` module (no port opened) — noted in Mechanism reference and Task 1.

**Placeholder scan:** No TBD/TODO; every code step contains full code; commands have expected output. The only conditional is the `matchRule`/`messageKey` call form in Task 5, which gives an explicit preferred concrete form. ✓

**Type consistency:** `BobSender.send(taskId, text)` / `isAvailable()`, `AutoRespondRule {matchPattern, response, source?}`, `matchRule(text, rules)`, `messageKey(ex)`, `AutoResponder(sessionManager, sender, getRules, log)` — used consistently across Tasks 3–6. `MessageExchange`/`ClaudeSession` match `src/SessionManager.ts`. ✓
