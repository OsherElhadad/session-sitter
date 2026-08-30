# Codex + VS Code Chat Session Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex CLI and VS Code Chat as first-class session sources in the Session Sitter view, with full parity to Claude/Bob (list, preview, upload to the corpus).

**Architecture:** Two new private scanners (`_scanCodexSessions`, `_scanChatSessions`) on `SessionManager`, mirroring the existing `_scanBobSessions` shape. Widen `ClaudeSession.source` and `_sessionSources` to include `'codex' | 'chat'`. All downstream call sites (preview extractor, upload exporter, view provider open-behavior, webview badges) grow one dispatch branch per new source. No refactor of the existing architecture.

**Tech Stack:** TypeScript, Node.js `fs`/`path`, Vitest, VS Code extension API. Existing `python3` subprocess pattern (used by Bob) is not needed — Codex and Chat are pure JSONL, parseable in Node.

## Global Constraints

- `ClaudeSession.source` union widens exactly to `'claude' | 'bob' | 'codex' | 'chat'`. No other values.
- `_sessionSources` map key type widens to match. Value type stays `string` at the class field level but is treated as one of the four literals.
- Codex scan scope: only rollout files whose mtime is within the last 90 days. Chat scan scope: **all workspaces** (all `~/Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.jsonl`).
- Both scanners are read-only. No file writes anywhere outside `os.tmpdir()`.
- Skip and log (per-file) any parse error. A top-level scanner failure (e.g., root directory missing) yields `[]` for that source and does not abort other sources.
- Preview extractors cap at 6 records (matches Claude's cap).
- Title truncation cap for both new sources: 60 characters (matches existing Bob code).
- Preview text truncation: user ≤ 150 chars, assistant ≤ 250 chars (matches Claude).
- Package version bumps from `0.0.6` to `0.0.7` in the final task.
- Every task ends with tests passing (`npm test`), lint clean (`npm run lint` — 0 errors; the one pre-existing warning in `SessionManager.test.ts:451` is expected), and TS compiling (`npm run compile`).
- Every task ends with a git commit on branch `feat_1/add-codex-and-chat-sessions`.

---

### Task 1: Widen `ClaudeSession.source` and `_sessionSources` to include `'codex' | 'chat'`

**Files:**
- Modify: `src/SessionManager.ts:20` (the `ClaudeSession` interface)
- Modify: `src/SessionManager.ts:108` (the `_sessionSources` map declaration)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClaudeSession.source: 'claude' | 'bob' | 'codex' | 'chat'` — required by every subsequent task.

- [ ] **Step 1: Read the current interface and map to confirm exact lines**

Run: `grep -n "source: 'claude'" src/SessionManager.ts`
Expected: two hits — the interface definition around line 20 and the map declaration around line 108.

- [ ] **Step 2: Widen the interface**

Change `src/SessionManager.ts` line 20 from:
```ts
  source: 'claude' | 'bob'; // which AI IDE this session belongs to
```
to:
```ts
  source: 'claude' | 'bob' | 'codex' | 'chat'; // which AI IDE this session belongs to
```

- [ ] **Step 3: Widen the map**

Change `src/SessionManager.ts` line 108 from:
```ts
  private _sessionSources = new Map<string, 'claude' | 'bob'>();
```
to:
```ts
  private _sessionSources = new Map<string, 'claude' | 'bob' | 'codex' | 'chat'>();
```

- [ ] **Step 4: Compile and test**

Run: `npm run compile && npm test`
Expected: `tsc` clean; 82/82 tests pass. No behavior change yet.

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts
git commit -m "feat: widen ClaudeSession.source to include codex and chat"
```

---

### Task 2: Codex scanner — `_scanCodexSessions`

**Files:**
- Modify: `src/SessionManager.ts` — add path constants near the other constants (~line 117), add `_scanCodexSessions()` method next to `_scanBobSessions` (~line 388), call it from `_scanSessions` (~line 362).
- Modify: `src/test/SessionManager.test.ts` — append a new `describe('SessionManager._scanCodexSessions', ...)` block at the bottom.

**Interfaces:**
- Consumes: `ClaudeSession` from Task 1.
- Produces: `private async _scanCodexSessions(): Promise<ClaudeSession[]>` — later tasks assume it populates `_sessionSources.set(id, 'codex')` and `_sessionFilePaths.set(id, absoluteJsonlPath)`.

- [ ] **Step 1: Add the path constant and constructor field**

In `src/SessionManager.ts`, after the `_bobDbPath` declaration (around line 111), add:
```ts
  private readonly _codexSessionsDir: string;
  private readonly _codexIndexPath: string;
```

In the constructor, after `this._bobDbPath = …` (line 117):
```ts
    this._codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    this._codexIndexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
```

- [ ] **Step 2: Write the failing test**

In `src/test/SessionManager.test.ts` append (mirroring the existing Bob describe block's shape):

```ts
// ── SessionManager._scanCodexSessions ────────────────────────────────────────
describe('SessionManager._scanCodexSessions', () => {
  let tmpHome: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-scan-'));
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    // Skeleton .codex/ layout
    await fs.promises.mkdir(path.join(tmpHome, '.codex', 'sessions', '2026', '07', '13'), { recursive: true });
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  it('extracts sessions using session_index.jsonl for title + updated_at', async () => {
    const rollout = path.join(tmpHome, '.codex/sessions/2026/07/13/rollout-2026-07-13T10-00-00-abc.jsonl');
    await fs.promises.writeFile(rollout,
      JSON.stringify({ timestamp: '2026-07-13T10:00:00Z', type: 'session_meta',
        payload: { id: 'codex-1', cwd: '/home/u/proj' } }) + '\n');
    await fs.promises.writeFile(path.join(tmpHome, '.codex/session_index.jsonl'),
      JSON.stringify({ id: 'codex-1', thread_name: 'Fix the parser', updated_at: '2026-07-13T10:05:00Z' }) + '\n');

    const results = await (sm as unknown as { _scanCodexSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanCodexSessions();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionId: 'codex-1',
      title: 'Fix the parser',
      projectPath: '/home/u/proj',
      projectName: 'proj',
      source: 'codex',
      status: 'idle',
    });
    expect(results[0].updatedAt.toISOString()).toBe('2026-07-13T10:05:00.000Z');
  });

  it('falls back to file mtime and cwd basename when index has no entry', async () => {
    const rollout = path.join(tmpHome, '.codex/sessions/2026/07/13/rollout-2026-07-13T10-00-00-def.jsonl');
    await fs.promises.writeFile(rollout,
      JSON.stringify({ timestamp: '2026-07-13T10:00:00Z', type: 'session_meta',
        payload: { id: 'codex-2', cwd: '/home/u/other-proj' } }) + '\n');
    // No session_index.jsonl.

    const results = await (sm as unknown as { _scanCodexSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanCodexSessions();

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('codex-2');
    expect(results[0].title).toBe('other-proj');
    expect(results[0].projectName).toBe('other-proj');
    expect(results[0].source).toBe('codex');
  });

  it('returns [] when the sessions directory does not exist', async () => {
    await fs.promises.rm(path.join(tmpHome, '.codex'), { recursive: true, force: true });
    const results = await (sm as unknown as { _scanCodexSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanCodexSessions();
    expect(results).toEqual([]);
  });
});
```

Also add `makeContext` at the top of the file if not present (check first — `SessionManager.test.ts` has a helper — reuse it). Look for `function makeContext()` and confirm it exists; if not, adapt from another describe block.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/test/SessionManager.test.ts`
Expected: FAIL — `TypeError: (sm as any)._scanCodexSessions is not a function`.

- [ ] **Step 4: Implement `_scanCodexSessions`**

Add these helper types and the method to `src/SessionManager.ts`, next to `_scanBobSessions` (after line ~452):

```ts
  private async _scanCodexSessions(): Promise<ClaudeSession[]> {
    // Codex CLI stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    // and an index at ~/.codex/session_index.jsonl mapping id -> {thread_name, updated_at}.
    const index = await this._readCodexIndex();

    let rolloutFiles: string[];
    try {
      rolloutFiles = await this._findCodexRollouts(this._codexSessionsDir);
    } catch {
      return [];
    }

    const sessions: ClaudeSession[] = [];
    for (const filePath of rolloutFiles) {
      try {
        // Read line 0 (session_meta) only.
        const fd = await fs.promises.open(filePath, 'r');
        let firstLine = '';
        try {
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await fd.read(buf, 0, 4096, 0);
          const chunk = buf.subarray(0, bytesRead).toString('utf8');
          const nl = chunk.indexOf('\n');
          firstLine = nl >= 0 ? chunk.slice(0, nl) : chunk;
        } finally {
          await fd.close();
        }
        if (!firstLine.trim()) { continue; }

        const record = JSON.parse(firstLine) as {
          type?: string;
          payload?: { id?: string; cwd?: string };
        };
        if (record.type !== 'session_meta') { continue; }

        const sessionId = record.payload?.id;
        const cwd = record.payload?.cwd ?? '';
        if (!sessionId) { continue; }

        const idx = index.get(sessionId);
        const stat = await fs.promises.stat(filePath);
        const updatedAt = idx?.updatedAt ?? stat.mtime;
        const title = (idx?.threadName ?? (cwd ? path.basename(cwd) : '')).slice(0, 60);
        if (!title) { continue; }

        this._sessionFilePaths.set(sessionId, filePath);
        this._sessionSources.set(sessionId, 'codex');
        sessions.push({
          sessionId,
          projectPath: cwd,
          projectName: cwd ? path.basename(cwd) : '',
          title,
          updatedAt,
          status: 'idle',
          source: 'codex',
        });
      } catch { /* skip malformed rollout */ }
    }
    return sessions;
  }

  private async _readCodexIndex(): Promise<Map<string, { threadName: string; updatedAt: Date }>> {
    const map = new Map<string, { threadName: string; updatedAt: Date }>();
    try {
      const raw = await fs.promises.readFile(this._codexIndexPath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const rec = JSON.parse(trimmed) as { id?: string; thread_name?: string; updated_at?: string };
          if (rec.id && rec.thread_name && rec.updated_at) {
            map.set(rec.id, { threadName: rec.thread_name, updatedAt: new Date(rec.updated_at) });
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* file may not exist */ }
    return map;
  }

  private async _findCodexRollouts(root: string): Promise<string[]> {
    const results: string[] = [];
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            const st = await fs.promises.stat(full);
            if (st.mtime.getTime() >= ninetyDaysAgo) { results.push(full); }
          } catch { /* skip */ }
        }
      }
    };
    await walk(root);
    return results;
  }
```

Then wire it into `_scanSessions` — locate the existing merge (around line 362):
```ts
    const claudeSessions = await this._scanClaudeSessions();
    const bobSessions = await this._scanBobSessions();
    const merged = [...claudeSessions, ...bobSessions];
```
Change to:
```ts
    const claudeSessions = await this._scanClaudeSessions();
    const bobSessions = await this._scanBobSessions();
    const codexSessions = await this._scanCodexSessions();
    const merged = [...claudeSessions, ...bobSessions, ...codexSessions];
```

- [ ] **Step 5: Add a file watcher on the session index**

In the constructor, after the existing `bobWatcher` block (around line 156), append:

```ts
    // Watch ~/.codex/session_index.jsonl for changes (Codex CLI updates it on every session write).
    const codexIndexDir = path.dirname(this._codexIndexPath);
    const codexIndexName = path.basename(this._codexIndexPath);
    const codexPattern = new vscode.RelativePattern(vscode.Uri.file(codexIndexDir), codexIndexName);
    const codexWatcher = vscode.workspace.createFileSystemWatcher(codexPattern);
    codexWatcher.onDidCreate(refresh);
    codexWatcher.onDidChange(refresh);
    context.subscriptions.push({ dispose: () => codexWatcher.dispose() });
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npm test -- src/test/SessionManager.test.ts`
Expected: 82 + 3 new = 85 tests pass (or similar; the exact prior count depends on branch state).

- [ ] **Step 7: Run full checks**

Run: `npm test && npm run lint && npm run compile`
Expected: all tests pass; lint 0 errors (1 pre-existing warning OK); tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: scan Codex CLI sessions from ~/.codex/sessions"
```

---

### Task 3: Codex preview extractor — `_getCodexRecentExchanges`

**Files:**
- Modify: `src/SessionManager.ts` — add `_getCodexRecentExchanges`; extend `getRecentExchanges` dispatch.
- Modify: `src/test/SessionManager.test.ts` — add test at the bottom.

**Interfaces:**
- Consumes: `_sessionFilePaths` and `_sessionSources` populated by Task 2.
- Produces: `getRecentExchanges(sessionId)` correctly dispatches for `'codex'` sessions and returns `MessageExchange[]` (existing exported type).

- [ ] **Step 1: Write the failing test**

Append to `src/test/SessionManager.test.ts`:

```ts
describe('SessionManager.getRecentExchanges (Codex)', () => {
  let tmpHome: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-preview-'));
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    await fs.promises.mkdir(path.join(tmpHome, '.codex/sessions/2026/07/13'), { recursive: true });
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  it('extracts user/assistant text from response_item records', async () => {
    const rollout = path.join(tmpHome, '.codex/sessions/2026/07/13/rollout-x.jsonl');
    const lines = [
      { timestamp: '2026-07-13T10:00:00Z', type: 'session_meta', payload: { id: 'cx-1', cwd: '/x' } },
      { timestamp: '2026-07-13T10:00:01Z', type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: 'Hello Codex' }] } },
      { timestamp: '2026-07-13T10:00:02Z', type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] } },
    ];
    await fs.promises.writeFile(rollout, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    // Seed session maps directly, like the Bob preview tests do.
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-1', rollout);
    (sm as unknown as { _sessionSources: Map<string, string> })._sessionSources.set('cx-1', 'codex');

    const ex = await sm.getRecentExchanges('cx-1');
    expect(ex).toHaveLength(2);
    expect(ex[0]).toMatchObject({ role: 'user', text: 'Hello Codex' });
    expect(ex[1]).toMatchObject({ role: 'assistant', text: 'Hi there' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "extracts user/assistant text from response_item"`
Expected: FAIL — likely returns `[]` because getRecentExchanges falls into the Claude branch and finds no `type === 'user'` records.

- [ ] **Step 3: Implement**

Add to `src/SessionManager.ts` next to `_getBobRecentExchanges`:

```ts
  private async _getCodexRecentExchanges(filePath: string): Promise<MessageExchange[]> {
    let stat: { size: number };
    try {
      stat = await fs.promises.stat(filePath);
    } catch { return []; }

    const TAIL = 32768;
    const offset = Math.max(0, stat.size - TAIL);
    const size = stat.size - offset;
    const buf = Buffer.alloc(size);

    const fh = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      const collected: MessageExchange[] = [];

      for (let i = lines.length - 1; i >= 0 && collected.length < 6; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) { continue; }
        try {
          const rec = JSON.parse(trimmed) as {
            timestamp?: string;
            type?: string;
            payload?: { role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (rec.type !== 'response_item') { continue; }
          const role = rec.payload?.role;
          if (role !== 'user' && role !== 'assistant') { continue; }
          const first = (rec.payload?.content ?? []).find(
            b => typeof b.text === 'string' && b.text.trim().length > 0,
          );
          const text = first?.text?.trim();
          if (!text) { continue; }
          const cap = role === 'user' ? 150 : 250;
          const truncated = text.length > cap ? text.slice(0, cap) + '…' : text;
          collected.push({ role, text: truncated, timestamp: rec.timestamp });
        } catch { /* skip malformed line */ }
      }
      return collected.reverse();
    } finally {
      await fh.close();
    }
  }
```

Then extend `getRecentExchanges` — find the existing early dispatch:
```ts
    if (this._sessionSources.get(sessionId) === 'bob') {
      return this._getBobRecentExchanges(filePath);
    }
```
and add above (or below — order doesn't matter but adjacent reads best):
```ts
    if (this._sessionSources.get(sessionId) === 'codex') {
      return this._getCodexRecentExchanges(filePath);
    }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/test/SessionManager.test.ts`
Expected: all pass. Also run: `npm run lint && npm run compile`.

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: extract user/assistant exchanges from Codex rollouts"
```

---

### Task 4: Codex upload export — pass through the raw JSONL

**Files:**
- Modify: `src/SessionManager.ts:181-185` (the `exportSessionAsJson` Claude branch — add a Codex branch adjacent to it).
- Modify: `src/test/SessionManager.test.ts` — add test.

**Interfaces:**
- Consumes: `_sessionFilePaths` populated by Task 2.
- Produces: `exportSessionAsJson(id)` returns `{filePath, cleanup: noop}` where `filePath` is the original rollout `.jsonl` for `'codex'` sessions.

- [ ] **Step 1: Write the failing test**

Append to `src/test/SessionManager.test.ts`:

```ts
describe('SessionManager.exportSessionAsJson (Codex)', () => {
  let tmpHome: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-export-'));
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns the raw .jsonl path with a no-op cleanup for Codex sessions', async () => {
    const rollout = path.join(tmpHome, 'rollout.jsonl');
    await fs.promises.writeFile(rollout, '{"type":"session_meta","payload":{"id":"cx-e","cwd":"/x"}}\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cx-e', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'idle', source: 'codex',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-e', rollout);
    (sm as unknown as { _sessionSources: Map<string, string> })._sessionSources.set('cx-e', 'codex');

    const out = await sm.exportSessionAsJson('cx-e');
    expect(out).not.toBeNull();
    expect(out!.filePath).toBe(rollout);
    // cleanup must be safe to invoke and NOT delete the source file.
    out!.cleanup();
    await expect(fs.promises.access(rollout)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "Codex sessions"`
Expected: FAIL — `exportSessionAsJson` currently only handles `'claude'` and treats everything else as Bob.

- [ ] **Step 3: Implement**

In `src/SessionManager.ts`, refactor `exportSessionAsJson`. Find:
```ts
    if (session.source === 'claude') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      return { filePath, cleanup: () => { /* nothing to clean up */ } };
    }

    // Bob session — build a minimal .bob.json envelope from DB data.
```
Replace the first branch with:
```ts
    if (session.source === 'claude' || session.source === 'codex') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      return { filePath, cleanup: () => { /* nothing to clean up */ } };
    }

    // Bob session — build a minimal .bob.json envelope from DB data.
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run lint && npm run compile`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: pass through the raw Codex .jsonl on upload"
```

---

### Task 5: Codex UI wiring — click routing, badge, style, preview label

**Files:**
- Modify: `src/SessionSitterViewProvider.ts` — extend `_openSessionLocal` (around line 191) and `addFromHistory` case (around line 128-135).
- Modify: `src/webview/main.js` — extend `buildTab` and `buildHistoryItem` for `source === 'codex'`; extend the `sessionPreview` handler's `assistantName` choice.
- Modify: `src/webview/styles.css` — add `.tab-badge--codex` rule.

**Interfaces:**
- Consumes: sessions with `source === 'codex'` from Task 2.
- Produces: user-visible Codex integration.

- [ ] **Step 1: Update `_openSessionLocal` in view provider**

Find in `src/SessionSitterViewProvider.ts` (around line 188):
```ts
    if (session.source === 'bob') {
      void vscode.commands.executeCommand('bobChatView.focus');
      return;
    }
```
Add below it:
```ts
    if (session.source === 'codex') {
      void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
      return;
    }
```

Note the command ID: this is the standard VS Code view-container focus command derived from the OpenAI ChatGPT extension's `viewsContainers` id. If your Codex/ChatGPT extension uses a different container id, replace `openai-chatgpt` accordingly. Verify the exact id with:

```bash
cat ~/.vscode/extensions/openai.chatgpt-*/package.json 2>/dev/null | python3 -c "
import sys, json, glob
for f in sorted(glob.glob('/Users/*/.vscode/extensions/openai.chatgpt-*/package.json')):
    p = json.load(open(f))
    print(f, '\n  viewsContainers:', list((p.get('contributes',{}).get('viewsContainers') or {}).keys()))
"
```
Substitute the correct container id into the command name (`workbench.view.extension.<id>`).

- [ ] **Step 2: Update the `addFromHistory` case in view provider**

Find in `src/SessionSitterViewProvider.ts` (around line 125-135):
```ts
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            const allSessions = this._sessionManager.getSessions();
            const histSession = allSessions.find(s => s.sessionId === sessionId);
            if (histSession?.source === 'bob') {
              void vscode.commands.executeCommand('bobChatView.focus');
            } else {
              void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            }
            break;
          }
```
Replace with:
```ts
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            const allSessions = this._sessionManager.getSessions();
            const histSession = allSessions.find(s => s.sessionId === sessionId);
            if (histSession?.source === 'bob') {
              void vscode.commands.executeCommand('bobChatView.focus');
            } else if (histSession?.source === 'codex') {
              void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
            } else {
              void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            }
            break;
          }
```

- [ ] **Step 3: Add the `Codex` badge in the webview**

In `src/webview/main.js`, find (both in `buildTab` around line 152 and `buildHistoryItem` around line 229 — same shape):
```js
    if (session.source === 'bob') {
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'tab-badge tab-badge--bob';
      sourceBadge.textContent = 'Bob';
      textEl.appendChild(sourceBadge);
    }
```
Immediately after each occurrence, add:
```js
    if (session.source === 'codex') {
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'tab-badge tab-badge--codex';
      sourceBadge.textContent = 'Codex';
      textEl.appendChild(sourceBadge);
    }
```

- [ ] **Step 4: Update the preview `assistantName` choice**

Find in `src/webview/main.js` (around line 327):
```js
          const assistantName = previewSession && previewSession.source === 'bob' ? 'Bob' : 'Claude';
```
Replace with:
```js
          const assistantName =
            previewSession && previewSession.source === 'bob' ? 'Bob' :
            previewSession && previewSession.source === 'codex' ? 'Codex' :
            'Claude';
```

- [ ] **Step 5: Add the CSS badge color**

In `src/webview/styles.css`, after the `.tab-badge--bob` rule (around line 239), append:
```css
.tab-badge--codex {
  background: #00a67d;
  color: #fff;
}
```

- [ ] **Step 6: Verify**

Run: `npm test && npm run lint && npm run compile`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/webview/main.js src/webview/styles.css
git commit -m "feat: surface Codex sessions in webview with badge and click routing"
```

---

### Task 6: Chat scanner — `_scanChatSessions`

**Files:**
- Modify: `src/SessionManager.ts` — add `_vscodeUserDir` field, add `_scanChatSessions`, call it from `_scanSessions`.
- Modify: `src/test/SessionManager.test.ts` — append test block.

**Interfaces:**
- Consumes: `ClaudeSession`, existing pattern from Codex.
- Produces: `_scanChatSessions(): Promise<ClaudeSession[]>` populating `_sessionSources.set(id, 'chat')` and `_sessionFilePaths.set(id, absoluteJsonlPath)`.

- [ ] **Step 1: Add path constant + constructor field**

In `src/SessionManager.ts`, near the other paths:
```ts
  private readonly _vscodeUserDir: string;
```
In the constructor:
```ts
    this._vscodeUserDir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
```

Note: this is macOS-specific. Linux would be `~/.config/Code/User`. Windows would be `%APPDATA%/Code/User`. For this PR we're targeting macOS (matches the project's existing Bob path assumption). A follow-up PR can add platform detection.

- [ ] **Step 2: Write failing tests**

Append to `src/test/SessionManager.test.ts`:

```ts
// ── SessionManager._scanChatSessions ─────────────────────────────────────────
describe('SessionManager._scanChatSessions', () => {
  let tmpHome: string;
  let sm: SessionManager;
  let wsHash: string;
  let chatDir: string;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-scan-'));
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    wsHash = 'abc123';
    chatDir = path.join(tmpHome, 'Library/Application Support/Code/User/workspaceStorage', wsHash, 'chatSessions');
    await fs.promises.mkdir(chatDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(path.dirname(chatDir), 'workspace.json'),
      JSON.stringify({ folder: 'file:///home/u/my-proj' }),
    );
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  it('extracts title from requests[0].message.text and folder from workspace.json', async () => {
    const chatFile = path.join(chatDir, 'sess-1.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'sess-1',
        creationDate: '2026-07-13T10:00:00Z',
        requests: [{ message: { text: 'How do I compile this project?' } }],
      },
    }) + '\n');

    const results = await (sm as unknown as { _scanChatSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanChatSessions();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionId: 'sess-1',
      title: 'How do I compile this project?',
      projectPath: '/home/u/my-proj',
      projectName: 'my-proj',
      source: 'chat',
      status: 'idle',
    });
  });

  it("falls back to 'Chat in <basename>' when requests is empty", async () => {
    const chatFile = path.join(chatDir, 'sess-2.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: { sessionId: 'sess-2', requests: [] },
    }) + '\n');

    const results = await (sm as unknown as { _scanChatSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanChatSessions();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Chat in my-proj');
  });

  it("uses '(no workspace)' when workspace.json is missing", async () => {
    await fs.promises.rm(path.join(path.dirname(chatDir), 'workspace.json'));
    const chatFile = path.join(chatDir, 'sess-3.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: { sessionId: 'sess-3', requests: [{ message: { text: 'hi' } }] },
    }) + '\n');

    const results = await (sm as unknown as { _scanChatSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanChatSessions();
    expect(results[0].projectName).toBe('(no workspace)');
    expect(results[0].projectPath).toBe('');
  });

  it('returns [] when workspaceStorage does not exist', async () => {
    await fs.promises.rm(path.join(tmpHome, 'Library'), { recursive: true, force: true });
    const results = await (sm as unknown as { _scanChatSessions(): Promise<import('../SessionManager').ClaudeSession[]> })
      ._scanChatSessions();
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "_scanChatSessions"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 4: Implement**

Add to `src/SessionManager.ts` near `_scanCodexSessions`:

```ts
  private async _scanChatSessions(): Promise<ClaudeSession[]> {
    const wsRoot = path.join(this._vscodeUserDir, 'workspaceStorage');
    let workspaceHashes: string[];
    try {
      const entries = await fs.promises.readdir(wsRoot, { withFileTypes: true });
      workspaceHashes = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch { return []; }

    const sessions: ClaudeSession[] = [];
    for (const hash of workspaceHashes) {
      const chatDir = path.join(wsRoot, hash, 'chatSessions');
      let chatFiles: string[];
      try {
        const entries = await fs.promises.readdir(chatDir, { withFileTypes: true });
        chatFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(chatDir, e.name));
      } catch { continue; }

      // Resolve workspace folder path once per hash.
      let projectPath = '';
      let projectName = '(no workspace)';
      try {
        const wsMeta = await fs.promises.readFile(path.join(wsRoot, hash, 'workspace.json'), 'utf8');
        const parsed = JSON.parse(wsMeta) as { folder?: string };
        if (parsed.folder?.startsWith('file://')) {
          projectPath = decodeURIComponent(parsed.folder.slice('file://'.length));
          projectName = path.basename(projectPath) || '(no workspace)';
        }
      } catch { /* keep fallback */ }

      for (const filePath of chatFiles) {
        try {
          const fd = await fs.promises.open(filePath, 'r');
          let firstLine = '';
          try {
            const buf = Buffer.alloc(65536);
            const { bytesRead } = await fd.read(buf, 0, 65536, 0);
            const chunk = buf.subarray(0, bytesRead).toString('utf8');
            const nl = chunk.indexOf('\n');
            firstLine = nl >= 0 ? chunk.slice(0, nl) : chunk;
          } finally {
            await fd.close();
          }
          if (!firstLine.trim()) { continue; }

          const rec = JSON.parse(firstLine) as { kind?: number; v?: { sessionId?: string; requests?: Array<{ message?: { text?: string } }> } };
          if (rec.kind !== 0) { continue; }
          const sessionId = rec.v?.sessionId;
          if (!sessionId) { continue; }

          const firstText = rec.v?.requests?.[0]?.message?.text?.trim();
          const title = (firstText && firstText.length > 0
            ? firstText
            : `Chat in ${projectName}`).slice(0, 60);

          const stat = await fs.promises.stat(filePath);
          this._sessionFilePaths.set(sessionId, filePath);
          this._sessionSources.set(sessionId, 'chat');
          sessions.push({
            sessionId,
            projectPath,
            projectName,
            title,
            updatedAt: stat.mtime,
            status: 'idle',
            source: 'chat',
          });
        } catch { /* skip malformed chat file */ }
      }
    }
    return sessions;
  }
```

Then wire into `_scanSessions` — extend the merge from Task 2:
```ts
    const codexSessions = await this._scanCodexSessions();
    const chatSessions = await this._scanChatSessions();
    const merged = [...claudeSessions, ...bobSessions, ...codexSessions, ...chatSessions];
```

- [ ] **Step 5: Add a file watcher on chatSessions across workspaces**

In the constructor, near the other watchers, add:

```ts
    // Watch chatSessions/*.jsonl across all workspaces. Glob watcher pattern relative to
    // the VS Code User dir. Debounced by the shared `refresh` above (250 ms).
    const chatPattern = new vscode.RelativePattern(
      vscode.Uri.file(this._vscodeUserDir),
      'workspaceStorage/*/chatSessions/*.jsonl',
    );
    const chatWatcher = vscode.workspace.createFileSystemWatcher(chatPattern);
    chatWatcher.onDidCreate(refresh);
    chatWatcher.onDidChange(refresh);
    chatWatcher.onDidDelete(refresh);
    context.subscriptions.push({ dispose: () => chatWatcher.dispose() });
```

- [ ] **Step 6: Verify**

Run: `npm test && npm run lint && npm run compile`

- [ ] **Step 7: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: scan VS Code Chat sessions from workspaceStorage"
```

---

### Task 7: Chat preview extractor — `_getChatRecentExchanges`

**Files:**
- Modify: `src/SessionManager.ts` — add method; extend `getRecentExchanges` dispatch.
- Modify: `src/test/SessionManager.test.ts` — add test.

**Interfaces:**
- Consumes: `_sessionFilePaths`, `_sessionSources` populated by Task 6.
- Produces: `MessageExchange[]` for `'chat'` sessions via `getRecentExchanges`.

- [ ] **Step 1: Write the failing test**

```ts
describe('SessionManager.getRecentExchanges (Chat)', () => {
  let tmpHome: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-preview-'));
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  it('extracts user text and concatenated assistant response.value from requests[]', async () => {
    const chatFile = path.join(tmpHome, 'chat.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'ch-1',
        requests: [{
          message: { text: 'Explain flexbox' },
          response: [
            { kind: 'mcpServersStarting' },
            { value: 'Flexbox is ' },
            { value: 'a layout system.' },
          ],
          timestamp: 1721005200000,
        }],
      },
    }) + '\n');

    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ch-1', chatFile);
    (sm as unknown as { _sessionSources: Map<string, string> })._sessionSources.set('ch-1', 'chat');

    const ex = await sm.getRecentExchanges('ch-1');
    expect(ex.map(e => ({ role: e.role, text: e.text }))).toEqual([
      { role: 'user', text: 'Explain flexbox' },
      { role: 'assistant', text: 'Flexbox is a layout system.' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "getRecentExchanges \\(Chat\\)"`
Expected: FAIL — dispatch doesn't recognize `'chat'` yet.

- [ ] **Step 3: Implement**

Add to `src/SessionManager.ts` near the other `_get*RecentExchanges` methods:

```ts
  private async _getChatRecentExchanges(filePath: string): Promise<MessageExchange[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const firstNl = raw.indexOf('\n');
    const firstLine = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
    if (!firstLine.trim()) { return []; }

    let snapshot: {
      v?: { requests?: Array<{
        message?: { text?: string };
        response?: Array<{ kind?: string; value?: unknown }>;
        timestamp?: number;
      }> };
    };
    try {
      snapshot = JSON.parse(firstLine);
    } catch { return []; }

    const requests = snapshot.v?.requests ?? [];
    const collected: MessageExchange[] = [];

    // Take up to the last 3 requests → up to 6 exchanges.
    const startIdx = Math.max(0, requests.length - 3);
    for (let i = startIdx; i < requests.length; i++) {
      const r = requests[i];
      const iso = typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : undefined;

      const userText = r.message?.text?.trim();
      if (userText) {
        const cap = 150;
        const truncated = userText.length > cap ? userText.slice(0, cap) + '…' : userText;
        collected.push({ role: 'user', text: truncated, timestamp: iso });
      }

      const responseText = (r.response ?? [])
        .filter(el => typeof el.value === 'string')
        .map(el => el.value as string)
        .join('')
        .trim();
      if (responseText) {
        const cap = 250;
        const truncated = responseText.length > cap ? responseText.slice(0, cap) + '…' : responseText;
        collected.push({ role: 'assistant', text: truncated, timestamp: iso });
      }
    }
    return collected;
  }
```

Extend `getRecentExchanges` dispatch alongside the Codex one:
```ts
    if (this._sessionSources.get(sessionId) === 'chat') {
      return this._getChatRecentExchanges(filePath);
    }
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run lint && npm run compile`

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: extract user/assistant exchanges from VS Code Chat sessions"
```

---

### Task 8: Chat upload export — build `.chat.json` envelope

**Files:**
- Modify: `src/SessionManager.ts` — extend `exportSessionAsJson`.
- Modify: `src/test/SessionManager.test.ts` — add test.

**Interfaces:**
- Consumes: `_sessions`, `_getChatRecentExchanges` from Task 7.
- Produces: `exportSessionAsJson(id)` returns temp `.chat.json` envelope for `'chat'` sessions.

- [ ] **Step 1: Write the failing test**

```ts
describe('SessionManager.exportSessionAsJson (Chat)', () => {
  let tmpHome: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-export-'));
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  it('produces a .chat.json envelope with expected keys and cleans up', async () => {
    const chatFile = path.join(tmpHome, 'chat.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'ce-1',
        requests: [{ message: { text: 'hi' }, response: [{ value: 'hello' }] }],
      },
    }) + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'ce-1', projectPath: '/x', projectName: 'x',
      title: 'hi', updatedAt: new Date('2026-07-13T10:00:00Z'), status: 'idle', source: 'chat',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ce-1', chatFile);
    (sm as unknown as { _sessionSources: Map<string, string> })._sessionSources.set('ce-1', 'chat');

    const out = await sm.exportSessionAsJson('ce-1');
    expect(out).not.toBeNull();
    expect(out!.filePath).toMatch(/\.chat\.json$/);
    const written = JSON.parse(await fs.promises.readFile(out!.filePath, 'utf8'));
    expect(written).toMatchObject({
      session_id: 'ce-1',
      harness: 'chat',
      title: 'hi',
    });
    expect(written.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hi' }),
      expect.objectContaining({ role: 'assistant', content: 'hello' }),
    ]);
    // Cleanup removes the temp file.
    out!.cleanup();
    await expect(fs.promises.access(out!.filePath)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "exportSessionAsJson \\(Chat\\)"`
Expected: FAIL — falls through to the Bob branch which calls `_getBobRecentExchanges`, doesn't exist for Chat.

- [ ] **Step 3: Implement**

In `src/SessionManager.ts`, extend `exportSessionAsJson`. After the Claude/Codex branch, before the Bob envelope logic, insert:

```ts
    if (session.source === 'chat') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const exchanges = await this._getChatRecentExchanges(filePath);
      const envelope = {
        session_id: sessionId,
        harness: 'chat',
        username: os.userInfo().username,
        created_at: session.updatedAt.toISOString(),
        title: session.title,
        messages: exchanges.map(e => ({
          role: e.role,
          content: e.text,
          timestamp: e.timestamp ?? new Date().toISOString(),
        })),
      };
      const tmpFile = path.join(os.tmpdir(), `chat-session-${sessionId}.chat.json`);
      await fs.promises.writeFile(tmpFile, JSON.stringify(envelope, null, 2), 'utf8');
      return {
        filePath: tmpFile,
        cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
      };
    }

    // Bob session — build a minimal .bob.json envelope from DB data.
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run lint && npm run compile`

- [ ] **Step 5: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: build .chat.json envelope for Chat session upload"
```

---

### Task 9: Chat UI wiring — click routing, badge, style, preview label

**Files:**
- Modify: `src/SessionSitterViewProvider.ts` — extend `_openSessionLocal` and `addFromHistory`.
- Modify: `src/webview/main.js` — extend `buildTab` and `buildHistoryItem`; extend preview `assistantName`.
- Modify: `src/webview/styles.css` — add `.tab-badge--chat` rule.

**Interfaces:**
- Consumes: sessions with `source === 'chat'` from Task 6.
- Produces: user-visible Chat integration.

- [ ] **Step 1: Extend `_openSessionLocal`**

Below the Codex branch added in Task 5, add:
```ts
    if (session.source === 'chat') {
      void vscode.commands.executeCommand('workbench.action.chat.open');
      return;
    }
```

- [ ] **Step 2: Extend `addFromHistory`**

Extend the `else if` chain from Task 5:
```ts
            } else if (histSession?.source === 'codex') {
              void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
            } else if (histSession?.source === 'chat') {
              void vscode.commands.executeCommand('workbench.action.chat.open');
            } else {
              void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            }
```

- [ ] **Step 3: Add the `Chat` badge in the webview**

Right after each Codex-badge block added in Task 5 (both `buildTab` and `buildHistoryItem`):
```js
    if (session.source === 'chat') {
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'tab-badge tab-badge--chat';
      sourceBadge.textContent = 'Chat';
      textEl.appendChild(sourceBadge);
    }
```

- [ ] **Step 4: Update `assistantName`**

Replace the Codex-adjusted line from Task 5 with:
```js
          const assistantName =
            previewSession && previewSession.source === 'bob' ? 'Bob' :
            previewSession && previewSession.source === 'codex' ? 'Codex' :
            previewSession && previewSession.source === 'chat' ? 'Chat' :
            'Claude';
```

- [ ] **Step 5: Add the CSS badge color**

Below the `.tab-badge--codex` rule added in Task 5:
```css
.tab-badge--chat {
  background: #6b6b6b;
  color: #fff;
}
```

- [ ] **Step 6: Verify**

Run: `npm test && npm run lint && npm run compile`

- [ ] **Step 7: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/webview/main.js src/webview/styles.css
git commit -m "feat: surface Chat sessions in webview with badge and click routing"
```

---

### Task 10: Version bump, package `.vsix`, install, manual verification

**Files:**
- Modify: `package.json` — version `0.0.6` → `0.0.7`.
- Produce: `session-sitter-0.0.7.vsix` (git-ignored artifact).

**Interfaces:**
- Consumes: all prior tasks' code.
- Produces: an installable `.vsix` and a documented manual verification pass.

- [ ] **Step 1: Bump version**

In `package.json`, change:
```json
  "version": "0.0.6",
```
to:
```json
  "version": "0.0.7",
```

- [ ] **Step 2: Run full checks**

Run: `npm test && npm run lint && npm run compile`
Expected: all tests pass; 0 lint errors; tsc clean.

- [ ] **Step 3: Package**

Run: `rm -f session-sitter-*.vsix && npx --yes @vscode/vsce package`
Expected: `Packaged: /…/session-sitter-0.0.7.vsix`.

- [ ] **Step 4: Install**

Run: `code --install-extension $(pwd)/session-sitter-0.0.7.vsix --force`
Expected: `Extension 'session-sitter-0.0.7.vsix' was successfully installed.`

- [ ] **Step 5: Reload VS Code and verify manually**

Open VS Code (or press `Cmd+Shift+P` → **Developer: Reload Window**). In the Session Sitter view, confirm:

- A row appears for each recent Codex thread (green "Codex" badge), sorted correctly by recency alongside Claude and Bob rows.
- A row appears for each VS Code Chat session (gray "Chat" badge).
- Right-click a Codex row → **Show details** shows the last user/assistant exchanges with `assistantName === 'Codex'`.
- Right-click a Chat row → **Show details** shows the last user/assistant exchanges with `assistantName === 'Chat'`.
- Right-click a Codex row → **Copy title** places the title on the clipboard.
- Right-click a Codex row → **Upload to the corpus** (if `sessionSitter.uploadScriptPath` is configured) succeeds.
- Right-click a Chat row → **Upload to the corpus** produces a `.chat.json` in `/tmp/` (verify by adding a temporary `console.log` if unsure, or by inspecting the extension host output).
- Clicking a Codex row focuses the OpenAI/Codex sidebar panel.
- Clicking a Chat row opens the VS Code Chat panel.

- [ ] **Step 6: Commit + push**

```bash
git add package.json
git commit -m "chore: bump version to 0.0.7 for Codex + Chat support"
git push -u bcarmeli feat_1/add-codex-and-chat-sessions
```
