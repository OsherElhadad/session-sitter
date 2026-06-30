# Bob Session Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add IBM Bob task sessions to the unified Claude Session Switcher panel, interleaved with Claude sessions, with identical feature parity (status indicators, history, hover preview, cross-window focus, new session button).

**Architecture:** Approach A — add `source: 'claude' | 'bob'` to `ClaudeSession`, extend `SessionManager` with a Bob-specific scanner that reads `~/.config/IBM Bob/User/globalStorage/ibm.bob-code/tasks/`, and branch on `source` in `SessionSwitcherViewProvider` and the webview for dispatch and rendering.

**Tech Stack:** TypeScript, VS Code extension API, vitest, vanilla JS webview

## Global Constraints

- TypeScript strict mode; no `any` without a comment explaining why
- No new npm dependencies
- All new code follows the existing patterns in the files being modified
- Bob tasks directory: `~/.config/IBM Bob/User/globalStorage/ibm.bob-code/tasks`
- Bob panel command: `bobChatView.focus`
- Bob new task command: `bob-code.task.pickWorkspace`
- Bob tab viewType substring: `bobChatView`
- `source` field is `'claude'` for all existing sessions (no breaking change)
- Tests run with: `npm test` (vitest)
- Build with: `npm run compile`

---

## File Map

| File | Change |
|---|---|
| `src/SessionManager.ts` | Add `source` to `ClaudeSession`; add `_scanBobSessions` + `_parseBobTaskDir`; merge both scanners; extend `getRecentExchanges` for Bob; add second watcher |
| `src/SessionSwitcherViewProvider.ts` | Branch on `source` in `_openSessionLocal`, `addFromHistory`; add `newBobSession` handler; extend `_openClaudeTabLabels` for Bob viewType |
| `src/webview/main.js` | Add Bob source badge; hide `×` for Bob rows; add `+B` button |
| `src/webview/styles.css` | Add `.tab-badge--bob` style |
| `src/test/SessionManager.test.ts` | Add Bob parsing and merged scan tests |
| `src/test/SessionSwitcherViewProvider.test.ts` | Add Bob dispatch tests |

---

## Task 1: Add `source` field to `ClaudeSession` and default all Claude sessions to `'claude'`

**Files:**
- Modify: `src/SessionManager.ts`

**Interfaces:**
- Produces: `ClaudeSession.source: 'claude' | 'bob'` — used by Tasks 2, 3, 4, 5

- [ ] **Step 1: Add `source` to the `ClaudeSession` interface**

In `src/SessionManager.ts`, change the interface:

```typescript
export interface ClaudeSession {
  sessionId:   string;
  projectName: string;
  projectPath: string;
  title:       string;
  updatedAt:   Date;
  status:      'idle' | 'waiting' | 'active';
  source:      'claude' | 'bob';
}
```

- [ ] **Step 2: Set `source: 'claude'` in `_parseSessionFile`**

In `_parseSessionFile`, change the return statement (near end of method, line ~367):

```typescript
return { sessionId, projectName, projectPath, title, updatedAt, status, source: 'claude' };
```

- [ ] **Step 3: Compile to verify no type errors**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 4: Run existing tests to confirm no regressions**

```bash
npm test
```
Expected: all existing tests pass (≥29 passing, 0 failing).

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts
git commit -m "feat: add source field to ClaudeSession interface"
```

---

## Task 2: Bob session scanner in `SessionManager`

**Files:**
- Modify: `src/SessionManager.ts`
- Test: `src/test/SessionManager.test.ts`

**Interfaces:**
- Consumes: `ClaudeSession.source: 'claude' | 'bob'` (Task 1)
- Produces:
  - `_scanBobSessions(): Promise<ClaudeSession[]>` — called by merged `_scanSessions`
  - `_parseBobTaskDir(dir: string): Promise<ClaudeSession | null>` — parses one Bob task directory
  - `getBobTasksDir(): string` — exported helper returning the tasks directory path

- [ ] **Step 1: Write failing tests for `_parseBobTaskDir`**

Add to `src/test/SessionManager.test.ts` after the existing `describe` blocks:

```typescript
// ── Helpers for Bob task directories ─────────────────────────────────────────

async function writeBobTask(
  dir: string,
  taskId: string,
  uiMessages: object[],
  apiHistory: object[] = [],
): Promise<string> {
  const taskDir = path.join(dir, taskId);
  await fs.promises.mkdir(taskDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(taskDir, 'ui_messages.json'),
    JSON.stringify(uiMessages),
    'utf8',
  );
  if (apiHistory.length > 0) {
    await fs.promises.writeFile(
      path.join(taskDir, 'api_conversation_history.json'),
      JSON.stringify(apiHistory),
      'utf8',
    );
  }
  return taskDir;
}

type PrivateManagerBob = PrivateManager & {
  _parseBobTaskDir(dir: string): Promise<import('../SessionManager').ClaudeSession | null>;
  _scanBobSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
};

describe('SessionManager._parseBobTaskDir', () => {
  let tmpDir: string;
  let manager: PrivateManagerBob;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-test-'));
    const sm = new SessionManager(makeContext());
    manager = sm as unknown as PrivateManagerBob;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when ui_messages.json is missing', async () => {
    const taskDir = path.join(tmpDir, 'missing-ui');
    await fs.promises.mkdir(taskDir);
    expect(await manager._parseBobTaskDir(taskDir)).toBeNull();
  });

  it('returns null when ui_messages.json has no say:text user message', async () => {
    const taskDir = await writeBobTask(tmpDir, 'no-user', [
      { ts: Date.now(), type: 'say', say: 'api_req_started', text: '{}' },
    ]);
    expect(await manager._parseBobTaskDir(taskDir)).toBeNull();
  });

  it('uses directory name as sessionId', async () => {
    const id = 'f5e315d3-d883-4ec8-9ba5-7cd4865b9a45';
    const taskDir = await writeBobTask(tmpDir, id, [
      { ts: Date.now(), type: 'say', say: 'text', text: 'Hello Bob', images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.sessionId).toBe(id);
  });

  it('uses first say:text record as title, truncated to 60 chars', async () => {
    const taskDir = await writeBobTask(tmpDir, 'title-test', [
      { ts: Date.now(), type: 'say', say: 'text', text: 'A'.repeat(80), images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.title).toBe('A'.repeat(60));
  });

  it('source is always "bob"', async () => {
    const taskDir = await writeBobTask(tmpDir, 'source-test', [
      { ts: Date.now(), type: 'say', say: 'text', text: 'Hello', images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.source).toBe('bob');
  });

  it('extracts projectPath from api_conversation_history.json', async () => {
    const taskDir = await writeBobTask(
      tmpDir, 'cwd-test',
      [{ ts: Date.now(), type: 'say', say: 'text', text: 'Test task', images: [] }],
      [{
        role: 'user',
        content: [{
          type: 'text',
          text: '<environment_details>\n# Current Workspace Directory (/home/user/my-project) Files\nREADME.md\n</environment_details>',
        }],
      }],
    );
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.projectPath).toBe('/home/user/my-project');
    expect(result?.projectName).toBe('my-project');
  });

  it('projectPath defaults to empty string when api_conversation_history.json is absent', async () => {
    const taskDir = await writeBobTask(tmpDir, 'no-cwd', [
      { ts: Date.now(), type: 'say', say: 'text', text: 'Hello', images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.projectPath).toBe('');
    expect(result?.projectName).toBe('');
  });

  describe('Bob status inference', () => {
    it('api_req_started as last record → active', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-active', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now(), type: 'say', say: 'api_req_started', text: '{}' },
      ]);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('active');
    });

    it('ask:tool as last record → active', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-tool', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now(), type: 'ask', ask: 'tool', text: '{}' },
      ]);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('active');
    });

    it('ask:completion_result as last record → idle', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-idle', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now() - 60000, type: 'ask', ask: 'completion_result', text: 'Done!' },
      ]);
      // back-date the file so recency heuristic does not trigger
      const uiPath = path.join(taskDir, 'ui_messages.json');
      const old = new Date(Date.now() - 120_000);
      await fs.promises.utimes(uiPath, old, old);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('idle');
    });

    it('say:completion_result as last record → idle', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-idle2', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now() - 60000, type: 'say', say: 'completion_result', text: 'Done!' },
      ]);
      const uiPath = path.join(taskDir, 'ui_messages.json');
      const old = new Date(Date.now() - 120_000);
      await fs.promises.utimes(uiPath, old, old);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('idle');
    });

    it('user say:text with no api_req_started before it → waiting', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-waiting', [
        { ts: Date.now(), type: 'say', say: 'text', text: 'New request', images: [] },
      ]);
      // Back-date so recency heuristic does not trigger
      const uiPath = path.join(taskDir, 'ui_messages.json');
      const old = new Date(Date.now() - 120_000);
      await fs.promises.utimes(uiPath, old, old);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('waiting');
    });

    it('recently modified file → active regardless of last record', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-recent', [
        { ts: Date.now() - 60000, type: 'say', say: 'text', text: 'Old message', images: [] },
        { ts: Date.now() - 60000, type: 'ask', ask: 'completion_result', text: 'Done' },
      ]);
      // ui_messages.json was just written so its mtime is within 30 s → active
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('active');
    });
  });
});

describe('SessionManager._scanBobSessions merges with Claude sessions', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'merged-test-'));
    sm = new SessionManager(makeContext());
    // Point both dirs to our temp area
    (sm as unknown as { _projectsDir: string })._projectsDir = path.join(tmpDir, 'claude-projects');
    (sm as unknown as { _bobTasksDir: string })._bobTasksDir = path.join(tmpDir, 'bob-tasks');
    await fs.promises.mkdir(path.join(tmpDir, 'claude-projects'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, 'bob-tasks'), { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('merged _scanSessions returns both claude and bob sessions sorted by updatedAt', async () => {
    // Bob task (older)
    const bobTaskDir = path.join(tmpDir, 'bob-tasks');
    await writeBobTask(bobTaskDir, 'bob-uuid-1', [
      { ts: Date.now() - 10000, type: 'say', say: 'text', text: 'Bob task', images: [] },
    ]);
    const bobUiPath = path.join(bobTaskDir, 'bob-uuid-1', 'ui_messages.json');
    const olderDate = new Date(Date.now() - 10_000);
    await fs.promises.utimes(bobUiPath, olderDate, olderDate);

    // Claude session (newer)
    const claudeDir = path.join(tmpDir, 'claude-projects', '-home-user-proj');
    await fs.promises.mkdir(claudeDir, { recursive: true });
    await writeTempJsonl(claudeDir, 'claude-uuid-1', [
      { type: 'user', cwd: '/home/user/proj', message: { content: 'Claude task' } },
    ]);

    const sessions = await (sm as unknown as { _scanSessions(): Promise<import('../SessionManager').ClaudeSession[]> })._scanSessions();

    expect(sessions.length).toBe(2);
    // Sorted newest first — Claude session was just written so it's newer
    expect(sessions[0].source).toBe('claude');
    expect(sessions[1].source).toBe('bob');
    expect(sessions[0].title).toBe('Claude task');
    expect(sessions[1].title).toBe('Bob task');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```
Expected: new Bob tests fail with errors like `_parseBobTaskDir is not a function`.

- [ ] **Step 3: Implement `_parseBobTaskDir`, `_scanBobSessions`, and wire into `_scanSessions`**

Add the following to `src/SessionManager.ts`. Add the `_bobTasksDir` property and initialize it in the constructor, extend the watcher, and add the two new private methods.

**a) Add imports at top of file** (none needed — `fs`, `path`, `os` already imported):

**b) Add `_bobTasksDir` property** after `_projectsDir`:

```typescript
private readonly _bobTasksDir: string;
```

**c) Initialize in constructor** — add after `this._projectsDir = path.join(os.homedir(), '.claude', 'projects');`:

```typescript
this._bobTasksDir = path.join(
  os.homedir(),
  '.config', 'IBM Bob', 'User', 'globalStorage', 'ibm.bob-code', 'tasks',
);
```

**d) Add a second `FileSystemWatcher` for Bob JSON files** — add after the existing `this._watcher` initialization block (after `this._watcher.onDidDelete(refresh);`):

```typescript
// Watch Bob task JSON files for changes
const bobPattern = new vscode.RelativePattern(
  vscode.Uri.file(this._bobTasksDir),
  '**/*.json',
);
const bobWatcher = vscode.workspace.createFileSystemWatcher(bobPattern);
bobWatcher.onDidCreate(refresh);
bobWatcher.onDidChange(refresh);
bobWatcher.onDidDelete(refresh);
context.subscriptions.push({ dispose: () => bobWatcher.dispose() });
```

**e) Rename the current scan body** — rename the private method `_scanSessions` to `_scanClaudeSessions`:

```typescript
private async _scanClaudeSessions(): Promise<ClaudeSession[]> {
  // (existing body of _scanSessions — unchanged)
}
```

**f) Add new `_scanSessions` that merges both**:

```typescript
private async _scanSessions(): Promise<ClaudeSession[]> {
  const [claudeSessions, bobSessions] = await Promise.all([
    this._scanClaudeSessions(),
    this._scanBobSessions(),
  ]);
  const merged = [...claudeSessions, ...bobSessions];
  merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return merged;
}
```

**g) Add `_scanBobSessions`**:

```typescript
private async _scanBobSessions(): Promise<ClaudeSession[]> {
  const sessions: ClaudeSession[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(this._bobTasksDir, { withFileTypes: true });
  } catch {
    return sessions; // directory doesn't exist (not running in Bob)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    try {
      const session = await this._parseBobTaskDir(
        path.join(this._bobTasksDir, entry.name),
      );
      if (session !== null) { sessions.push(session); }
    } catch {
      // Silently skip malformed task directories
    }
  }
  return sessions;
}
```

**h) Add `_parseBobTaskDir`**:

```typescript
private async _parseBobTaskDir(taskDir: string): Promise<ClaudeSession | null> {
  const sessionId = path.basename(taskDir);
  const uiPath = path.join(taskDir, 'ui_messages.json');

  let uiStat: { mtime: Date };
  let uiMessages: Array<{ ts?: number; type?: string; say?: string; ask?: string; text?: string }>;
  try {
    uiStat = await fs.promises.stat(uiPath);
    const raw = await fs.promises.readFile(uiPath, 'utf8');
    uiMessages = JSON.parse(raw) as typeof uiMessages;
    if (!Array.isArray(uiMessages)) { return null; }
  } catch {
    return null;
  }

  // Title: first say:text record (user message)
  const firstUserMsg = uiMessages.find(m => m.type === 'say' && m.say === 'text');
  if (!firstUserMsg?.text) { return null; }
  const title = firstUserMsg.text.slice(0, 60);
  const updatedAt = uiStat.mtime;

  // Project path: extract from api_conversation_history.json
  let projectPath = '';
  let projectName = '';
  try {
    const histPath = path.join(taskDir, 'api_conversation_history.json');
    const histRaw = await fs.promises.readFile(histPath, 'utf8');
    const history = JSON.parse(histRaw) as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    for (const msg of history.slice(0, 1)) {
      for (const block of msg.content ?? []) {
        if (block.type === 'text' && block.text) {
          const m = block.text.match(/# Current Workspace Directory \((.+?)\)/);
          if (m) { projectPath = m[1]; projectName = path.basename(projectPath); break; }
        }
      }
      if (projectPath) { break; }
    }
  } catch {
    // api_conversation_history.json absent or malformed — leave projectPath empty
  }

  // Status: scan ui_messages backward
  const status = this._readBobStatus(uiMessages, updatedAt);

  this._sessionFilePaths.set(sessionId, uiPath);
  return { sessionId, projectName, projectPath, title, updatedAt, status, source: 'bob' };
}

private _readBobStatus(
  messages: Array<{ type?: string; say?: string; ask?: string }>,
  updatedAt: Date,
): 'idle' | 'waiting' | 'active' {
  const recentlyModified = (Date.now() - updatedAt.getTime()) < 30_000;

  // Check if any api_req_started exists (meaning a response was started)
  const hasApiReqStarted = messages.some(m => m.type === 'say' && m.say === 'api_req_started');

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'say' && m.say === 'api_req_started') { return 'active'; }
    if (m.type === 'ask' && m.ask === 'tool') { return 'active'; }
    if (m.type === 'ask' && m.ask === 'completion_result') {
      return recentlyModified ? 'active' : 'idle';
    }
    if (m.type === 'say' && m.say === 'completion_result') {
      return recentlyModified ? 'active' : 'idle';
    }
    if (m.type === 'say' && m.say === 'text') {
      // User message: waiting only if no api_req_started has happened yet
      if (!hasApiReqStarted) { return recentlyModified ? 'active' : 'waiting'; }
      return recentlyModified ? 'active' : 'idle';
    }
  }
  return recentlyModified ? 'active' : 'idle';
}
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: all Bob parser tests pass; existing Claude tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: add Bob session scanner to SessionManager"
```

---

## Task 3: Extend `getRecentExchanges` for Bob sessions

**Files:**
- Modify: `src/SessionManager.ts`
- Test: `src/test/SessionManager.test.ts`

**Interfaces:**
- Consumes: `_sessionFilePaths` stores `ui_messages.json` path for Bob sessions (set in Task 2's `_parseBobTaskDir`)
- Consumes: `ClaudeSession.source` (Task 1)
- Produces: `getRecentExchanges(sessionId)` returns correct exchanges for Bob sessions

- [ ] **Step 1: Write failing tests**

Add to `src/test/SessionManager.test.ts` after the existing `getRecentExchanges` describe block:

```typescript
describe('SessionManager.getRecentExchanges (Bob)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-preview-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function seedBobPath(sessionId: string, filePath: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, filePath);
    // Mark as bob source so getRecentExchanges uses the right reader
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob'> })
      ._sessionSources.set(sessionId, 'bob');
  }

  it('extracts user and assistant exchanges from ui_messages.json', async () => {
    const id = 'bob-preview-1';
    const uiPath = path.join(tmpDir, 'ui_messages.json');
    const messages = [
      { ts: 1000, type: 'say', say: 'text', text: 'Hello Bob', images: [] },
      { ts: 2000, type: 'say', say: 'api_req_started', text: '{}' },
      { ts: 3000, type: 'say', say: 'text', text: 'Bob response', partial: false },
      { ts: 4000, type: 'say', say: 'text', text: 'Second user message', images: [] },
      { ts: 5000, type: 'say', say: 'api_req_started', text: '{}' },
      { ts: 6000, type: 'say', say: 'text', text: 'Second Bob response', partial: false },
    ];
    await fs.promises.writeFile(uiPath, JSON.stringify(messages), 'utf8');
    seedBobPath(id, uiPath);

    const result = await sm.getRecentExchanges(id);
    expect(result.length).toBeGreaterThan(0);
    // User exchanges have role 'user', assistant have role 'assistant'
    const userExchanges = result.filter(e => e.role === 'user');
    const assistantExchanges = result.filter(e => e.role === 'assistant');
    expect(userExchanges[0].text).toBe('Hello Bob');
    expect(assistantExchanges[0].text).toBe('Bob response');
  });

  it('returns [] for unknown sessionId', async () => {
    expect(await sm.getRecentExchanges('not-bob')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```
Expected: Bob preview tests fail.

- [ ] **Step 3: Implement Bob exchange reader**

In `src/SessionManager.ts`, add a `_sessionSources` map property alongside `_sessionFilePaths`:

```typescript
private _sessionSources = new Map<string, 'claude' | 'bob'>();
```

In `_parseBobTaskDir`, after setting `_sessionFilePaths`, also set the source:

```typescript
this._sessionFilePaths.set(sessionId, uiPath);
this._sessionSources.set(sessionId, 'bob');
```

In `_scanClaudeSessions` (formerly `_scanSessions`), clear `_sessionSources` at the same point `_sessionFilePaths` is cleared. Find the line `this._sessionFilePaths.clear();` in `_scanClaudeSessions` and add:

```typescript
this._sessionFilePaths.clear();
this._sessionSources.clear();
```

Extend `getRecentExchanges` — at the top of the method, after the `if (!filePath)` check, add a branch for Bob:

```typescript
async getRecentExchanges(sessionId: string): Promise<MessageExchange[]> {
  const filePath = this._sessionFilePaths.get(sessionId);
  if (!filePath) { return []; }

  if (this._sessionSources.get(sessionId) === 'bob') {
    return this._getBobRecentExchanges(filePath);
  }

  // ... existing Claude JSONL logic unchanged ...
}
```

Add the new private method:

```typescript
private async _getBobRecentExchanges(uiPath: string): Promise<MessageExchange[]> {
  let uiMessages: Array<{
    ts?: number;
    type?: string;
    say?: string;
    text?: string;
    partial?: boolean;
  }>;
  try {
    const raw = await fs.promises.readFile(uiPath, 'utf8');
    uiMessages = JSON.parse(raw) as typeof uiMessages;
    if (!Array.isArray(uiMessages)) { return []; }
  } catch {
    return [];
  }

  // Classify each message as user or assistant:
  // - say:text before any api_req_started → user
  // - say:text after an api_req_started (and partial === false) → assistant
  const collected: MessageExchange[] = [];
  let inAssistantTurn = false;

  for (const msg of uiMessages) {
    if (msg.type === 'say' && msg.say === 'api_req_started') {
      inAssistantTurn = true;
      continue;
    }
    if (msg.type === 'say' && msg.say === 'text' && msg.text?.trim()) {
      if (inAssistantTurn && msg.partial === false) {
        const text = msg.text.length > 250 ? msg.text.slice(0, 250) + '…' : msg.text;
        collected.push({ role: 'assistant', text, timestamp: msg.ts ? new Date(msg.ts).toISOString() : undefined });
        inAssistantTurn = false;
      } else if (!inAssistantTurn) {
        const text = msg.text.length > 150 ? msg.text.slice(0, 150) + '…' : msg.text;
        collected.push({ role: 'user', text, timestamp: msg.ts ? new Date(msg.ts).toISOString() : undefined });
      }
    }
  }

  // Return last 6 exchanges
  return collected.slice(-6);
}
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: extend getRecentExchanges for Bob ui_messages.json"
```

---

## Task 4: Provider dispatch — switch, new session, history, tab detection

**Files:**
- Modify: `src/SessionSwitcherViewProvider.ts`
- Test: `src/test/SessionSwitcherViewProvider.test.ts`

**Interfaces:**
- Consumes: `ClaudeSession.source: 'claude' | 'bob'` (Task 1)
- Produces: correct VS Code command dispatch for Bob sessions

- [ ] **Step 1: Write failing tests**

Add to `src/test/SessionSwitcherViewProvider.test.ts` at the end:

```typescript
// ── Helpers for Bob sessions ──────────────────────────────────────────────────

function makeBobSession(overrides: Partial<import('../SessionManager').ClaudeSession> = {}): import('../SessionManager').ClaudeSession {
  return {
    sessionId: 'bob-sess-1',
    projectPath: '/home/user/proj',
    projectName: 'proj',
    title: 'My Bob Task',
    updatedAt: new Date(),
    status: 'idle' as const,
    source: 'bob' as const,
    ...overrides,
  };
}

function setOpenBobTabs(labels: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).tabGroups.all = [{
    tabs: labels.map(label => ({ input: { viewType: 'bobChatView' }, label })),
  }];
}

// ── Tests: Bob session switching ──────────────────────────────────────────────
describe('_openSessionLocal (Bob)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockClear();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
    setOpenBobTabs([]);
  });
  afterEach(() => { setOpenBobTabs([]); });

  it('calls bobChatView.focus for a Bob session (no open tab match)', () => {
    const p = makeProvider([makeBobSession()]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('bob-sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('bobChatView.focus');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', expect.anything());
  });

  it('does NOT call claude-vscode commands for a Bob session', () => {
    const p = makeProvider([makeBobSession()]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('bob-sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });
});

// ── Tests: newBobSession ──────────────────────────────────────────────────────
describe('webview message: newBobSession', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  it('calls bob-code.task.pickWorkspace', async () => {
    const provider = makeProvider();
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(),
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    const webviewView = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
    };
    provider.resolveWebviewView(
      webviewView as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    // Grab the message handler registered via onDidReceiveMessage
    const handler = (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: 'newBobSession' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('bob-code.task.pickWorkspace');
  });
});

// ── Tests: addFromHistory (Bob) ───────────────────────────────────────────────
describe('webview message: addFromHistory (Bob)', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  it('calls bobChatView.focus for a Bob history session', async () => {
    const bobSession = makeBobSession({ sessionId: 'bob-hist-1' });
    const provider = makeProvider([bobSession]);
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(),
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    const webviewView = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
    };
    provider.resolveWebviewView(
      webviewView as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    const handler = (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: 'addFromHistory', sessionId: 'bob-hist-1' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('bobChatView.focus');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', expect.anything());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```
Expected: new Bob dispatch tests fail.

- [ ] **Step 3: Implement provider changes**

**a) Extend `_openClaudeTabLabels()`** — change the viewType check to include Bob:

```typescript
private _openClaudeTabLabels(): Set<string> {
  const labels = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[] } | undefined;
  if (!tabGroups) { return labels; }
  for (const group of tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { viewType?: string } | null | undefined;
      if (input?.viewType?.includes('claudeVSCodePanel') ||
          input?.viewType?.includes('bobChatView')) {
        labels.add(tab.label);
      }
    }
  }
  return labels;
}
```

**b) Extend `_openSessionLocal(sessionId)`** — replace the entire method:

```typescript
private _openSessionLocal(sessionId: string): void {
  const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
  if (!session) { return; }

  if (session.source === 'bob') {
    void vscode.commands.executeCommand('bobChatView.focus');
    return;
  }

  // Claude: prefer revealing in editor tab, fall back to sidebar
  if (this._openClaudeTabLabels().has(session.title)) {
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  } else {
    void vscode.commands.executeCommand('claude-vscode.sidebar.open');
  }
}
```

**c) Add `newBobSession` handler** in `resolveWebviewView`'s `onDidReceiveMessage` switch:

```typescript
case 'newBobSession': {
  void vscode.commands.executeCommand('bob-code.task.pickWorkspace');
  break;
}
```

Add it directly after the existing `case 'newSession':` block.

**d) Extend `addFromHistory` handler** — replace the existing case:

```typescript
case 'addFromHistory': {
  const sessionId = message.sessionId as string | undefined;
  if (!sessionId) { break; }
  const allSessions = this._sessionManager.getSessions();
  const session = allSessions.find(s => s.sessionId === sessionId);
  if (session?.source === 'bob') {
    void vscode.commands.executeCommand('bobChatView.focus');
  } else {
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  }
  break;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/SessionSwitcherViewProvider.ts src/test/SessionSwitcherViewProvider.test.ts
git commit -m "feat: dispatch Bob session commands in SessionSwitcherViewProvider"
```

---

## Task 5: Webview UI — Bob badge, hide close button, add +B button

**Files:**
- Modify: `src/webview/main.js`
- Modify: `src/webview/styles.css`
- Modify: `src/SessionSwitcherViewProvider.ts` (HTML template only — adds second button)

**Interfaces:**
- Consumes: `session.source: 'claude' | 'bob'` in webview session objects (passed through `updateSessions` / `updateHistory` messages)

- [ ] **Step 1: Add `.tab-badge--bob` style to `styles.css`**

Open `src/webview/styles.css` and add after the existing `.tab-badge` rule:

```css
.tab-badge--bob {
  background: #1f70c1;
  color: #fff;
}
```

- [ ] **Step 2: Add Bob source badge to `buildTab` in `main.js`**

In `buildTab(session)`, after the `textEl` is created and `titleEl` is appended, add the Bob badge before the project badge:

```javascript
if (session.source === 'bob') {
  const sourceBadge = document.createElement('span');
  sourceBadge.className = 'tab-badge tab-badge--bob';
  sourceBadge.textContent = 'Bob';
  textEl.appendChild(sourceBadge);
}

if (session.projectName) {
  const badgeEl = document.createElement('span');
  // ... (existing project badge code unchanged)
```

The existing project badge code stays immediately after.

- [ ] **Step 3: Conditionally hide the close button for Bob sessions in `buildTab`**

In `buildTab(session)`, wrap the close button creation and append in a source check:

```javascript
if (session.source !== 'bob') {
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.setAttribute('aria-label', 'Remove from tab bar');
  closeBtn.setAttribute('title', 'Remove from tab bar');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    vscodeApi.postMessage({ type: 'removeTab', sessionId: session.sessionId });
  });
  tab.appendChild(closeBtn);
}
```

Remove the unconditional close button creation that was there before.

- [ ] **Step 4: Add Bob source badge to `buildHistoryItem` in `main.js`**

In `buildHistoryItem(session)`, after `titleEl` is appended to `textEl`, add the same Bob badge:

```javascript
if (session.source === 'bob') {
  const sourceBadge = document.createElement('span');
  sourceBadge.className = 'tab-badge tab-badge--bob';
  sourceBadge.textContent = 'Bob';
  textEl.appendChild(sourceBadge);
}
```

- [ ] **Step 5: Add the `+B` button to the HTML template in `SessionSwitcherViewProvider.ts`**

In `_getHtmlForWebview`, change the toolbar div:

```html
<div id="toolbar">
  <button id="about-btn" title="About Claude Session Switcher">&#x24D8;</button>
  <button id="new-session-btn" title="New Claude Session">+</button>
  <button id="new-bob-session-btn" title="New Bob Session">+B</button>
</div>
```

- [ ] **Step 6: Wire the `+B` button in `main.js` `init()`**

In the `init()` function, after the `newBtn` handler, add:

```javascript
const newBobBtn = document.getElementById('new-bob-session-btn');
if (newBobBtn) {
  newBobBtn.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'newBobSession' });
  });
}
```

- [ ] **Step 7: Compile and run tests**

```bash
npm run compile && npm test
```
Expected: all tests pass, no compile errors.

- [ ] **Step 8: Commit**

```bash
git add src/webview/main.js src/webview/styles.css src/SessionSwitcherViewProvider.ts
git commit -m "feat: add Bob badge, hide close button for Bob sessions, add +B button"
```

---

## Task 6: Final validation

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: all tests pass (≥29 original + new Bob tests), 0 failures.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Build the VSIX**

```bash
npx @vscode/vsce package --no-dependencies
```
Expected: generates `claude-session-switcher-*.vsix` with no errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: IBM Bob session support — full feature parity with Claude sessions"
```
