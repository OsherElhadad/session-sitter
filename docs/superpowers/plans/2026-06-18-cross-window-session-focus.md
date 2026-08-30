# Cross-Window Session Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks a session that belongs to a different IDE window, jump to that window and focus the correct Claude panel there instead of opening it locally.

**Architecture:** Each session switcher instance watches for a focus-request file addressed to its own PID (`~/.claude/session-sitter/focus-<pid>.json`). The clicking window identifies the foreign owner via `~/.claude/ide/*.lock` files, writes the signal file, and uses the owner's `VSCODE_IPC_HOOK_CLI` socket to bring the IDE window to the OS foreground. The target window's watcher fires, calls `claude-vscode.primaryEditor.open(sessionId)` locally, then deletes the file. If no foreign owner is found or any step fails, a warning toast is shown and nothing opens.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `child_process.execFile`, Vitest

## Global Constraints

- No new source files — changes to `src/SessionManager.ts` and `src/SessionSitterViewProvider.ts` only
- All tests go in `src/test/` and run with `npm test` (Vitest)
- Compile must pass: `npm run compile`
- `addFromHistory` handler is untouched — history sessions always open locally

---

### Task 1: Lock-file helpers in SessionManager.ts

**Files:**
- Modify: `src/SessionManager.ts` (append after the last export)
- Create: `src/test/lock-file-helpers.test.ts`

**Interfaces:**
- Produces: `export interface LockFileInfo { pid: number; workspaceFolders: string[]; port: number; }`
- Produces: `export async function readActiveLockFiles(): Promise<LockFileInfo[]>`
- Produces: `export async function getIPCSocketForPid(pid: number): Promise<string | null>`

---

- [ ] **Step 1: Write failing tests for `readActiveLockFiles`**

Create `src/test/lock-file-helpers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readActiveLockFiles, getIPCSocketForPid } from '../SessionManager';

describe('readActiveLockFiles', () => {
  let tmpDir: string;
  let ideDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
    ideDir = path.join(tmpDir, '.claude', 'ide');
    await fs.promises.mkdir(ideDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when ide directory does not exist', async () => {
    await fs.promises.rm(ideDir, { recursive: true });
    expect(await readActiveLockFiles()).toEqual([]);
  });

  it('returns empty array when all PIDs are dead', async () => {
    await fs.promises.writeFile(
      path.join(ideDir, '12345.lock'),
      JSON.stringify({ pid: 999999999, workspaceFolders: ['/home/user/project'] }),
    );
    expect(await readActiveLockFiles()).toEqual([]);
  });

  it('returns entry for a lock file whose PID is alive', async () => {
    await fs.promises.writeFile(
      path.join(ideDir, '8080.lock'),
      JSON.stringify({ pid: process.pid, workspaceFolders: ['/home/user/project'] }),
    );
    const result = await readActiveLockFiles();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ pid: process.pid, workspaceFolders: ['/home/user/project'], port: 8080 });
  });

  it('skips entries missing pid', async () => {
    await fs.promises.writeFile(
      path.join(ideDir, '9090.lock'),
      JSON.stringify({ workspaceFolders: ['/home/user/project'] }),
    );
    expect(await readActiveLockFiles()).toEqual([]);
  });

  it('skips malformed JSON', async () => {
    await fs.promises.writeFile(path.join(ideDir, '1111.lock'), 'not json');
    expect(await readActiveLockFiles()).toEqual([]);
  });
});

describe('getIPCSocketForPid', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns socket path when VSCODE_IPC_HOOK_CLI is present', async () => {
    const environ = Buffer.from('HOME=/root\0VSCODE_IPC_HOOK_CLI=/run/test.sock\0PATH=/usr/bin');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValueOnce(environ as unknown as string);
    expect(await getIPCSocketForPid(12345)).toBe('/run/test.sock');
  });

  it('returns null when VSCODE_IPC_HOOK_CLI is absent', async () => {
    const environ = Buffer.from('HOME=/root\0PATH=/usr/bin');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValueOnce(environ as unknown as string);
    expect(await getIPCSocketForPid(12345)).toBeNull();
  });

  it('returns null when /proc/<pid>/environ is unreadable', async () => {
    vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(new Error('EACCES'));
    expect(await getIPCSocketForPid(12345)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- lock-file-helpers
```
Expected: 8 failures — `readActiveLockFiles is not a function` / `getIPCSocketForPid is not a function`

- [ ] **Step 3: Implement the helpers in SessionManager.ts**

Append after the final closing brace of the `SessionManager` class (after line 352):

```typescript
export interface LockFileInfo {
  pid: number;
  workspaceFolders: string[];
  port: number;
}

// Read ~/.claude/ide/*.lock and return entries whose PID is still alive.
export async function readActiveLockFiles(): Promise<LockFileInfo[]> {
  const ideDir = path.join(os.homedir(), '.claude', 'ide');
  let files: string[];
  try {
    files = (await fs.promises.readdir(ideDir)).filter(f => f.endsWith('.lock'));
  } catch {
    return [];
  }
  const locks: LockFileInfo[] = [];
  for (const file of files) {
    try {
      const raw = await fs.promises.readFile(path.join(ideDir, file), 'utf8');
      const data = JSON.parse(raw) as { pid?: unknown; workspaceFolders?: unknown };
      if (typeof data.pid !== 'number') { continue; }
      if (!Array.isArray(data.workspaceFolders)) { continue; }
      if (!data.workspaceFolders.every((f: unknown) => typeof f === 'string')) { continue; }
      try {
        process.kill(data.pid, 0);
        locks.push({
          pid: data.pid,
          workspaceFolders: data.workspaceFolders as string[],
          port: parseInt(file.replace('.lock', ''), 10),
        });
      } catch { /* dead process — skip */ }
    } catch { /* malformed lock file — skip */ }
  }
  return locks;
}

// Read /proc/<pid>/environ and return the VSCODE_IPC_HOOK_CLI value, or null.
export async function getIPCSocketForPid(pid: number): Promise<string | null> {
  try {
    const buf = await fs.promises.readFile(`/proc/${pid}/environ`);
    for (const entry of buf.toString('utf8').split('\0')) {
      if (entry.startsWith('VSCODE_IPC_HOOK_CLI=')) {
        return entry.slice('VSCODE_IPC_HOOK_CLI='.length);
      }
    }
  } catch { /* unreadable — ignore */ }
  return null;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- lock-file-helpers
```
Expected: 8 passing

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/SessionManager.ts src/test/lock-file-helpers.test.ts
git commit -m "feat: add readActiveLockFiles and getIPCSocketForPid helpers"
```

---

### Task 2: Focus-request receiver in SessionSitterViewProvider.ts

**Files:**
- Modify: `src/SessionSitterViewProvider.ts`
- Create: `src/test/SessionSitterViewProvider.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (receiver is self-contained; it only calls the vscode command)
- Produces: `private _handleFocusRequest(uri: { fsPath: string }): Promise<void>` (tested directly)
- Produces: `private _startFocusRequestWatcher(): vscode.Disposable`
- Produces: `private _focusWatcher: vscode.Disposable | undefined` field

---

- [ ] **Step 1: Write failing tests for the receiver**

Create `src/test/SessionSitterViewProvider.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── VS Code stub ──────────────────────────────────────────────────────────────
const mockExecuteCommand = vi.fn();
const mockShowWarningMessage = vi.fn();

vi.mock('vscode', () => {
  const EventEmitter = class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  };
  const FileSystemWatcher = class {
    onDidCreate = vi.fn();
    onDidChange = vi.fn();
    onDidDelete = vi.fn();
    dispose = vi.fn();
  };
  return {
    EventEmitter,
    workspace: {
      createFileSystemWatcher: vi.fn(() => new FileSystemWatcher()),
    },
    window: {
      tabGroups: { all: [], onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
      showWarningMessage: mockShowWarningMessage,
    },
    commands: { executeCommand: mockExecuteCommand },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
  };
});

// ── SessionManager stub ────────────────────────────────────────────────────────
vi.mock('../SessionManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionManager')>();
  return {
    ...actual,
    readActiveLockFiles: vi.fn().mockResolvedValue([]),
    getIPCSocketForPid: vi.fn().mockResolvedValue(null),
    getActiveSessionIds: vi.fn().mockResolvedValue(new Set()),
  };
});

// ── child_process stub ─────────────────────────────────────────────────────────
vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { SessionSitterViewProvider } from '../SessionSitterViewProvider';
import { SessionManager } from '../SessionManager';

function makeProvider(sessions: import('../SessionManager').ClaudeSession[] = []) {
  const mockManager = {
    getSessions: vi.fn().mockReturnValue(sessions),
    onDidChangeSessions: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    dispose: vi.fn(),
  } as unknown as SessionManager;
  return new SessionSitterViewProvider(
    { fsPath: '/fake' } as unknown as import('vscode').Uri,
    mockManager,
  );
}

// ── Tests: _handleFocusRequest ────────────────────────────────────────────────
describe('_handleFocusRequest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'focus-recv-'));
    mockExecuteCommand.mockClear();
    mockShowWarningMessage.mockClear();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('calls primaryEditor.open with the sessionId for a fresh request', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now(),
    }));

    const provider = makeProvider();
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'abc-123');
  });

  it('deletes the file after handling', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now(),
    }));

    const provider = makeProvider();
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    await expect(fs.promises.access(focusFile)).rejects.toThrow();
  });

  it('does not call primaryEditor.open for a stale request (>10s)', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now() - 15_000,
    }));

    const provider = makeProvider();
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('does not throw for malformed JSON (still deletes the file)', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, 'not json');

    const provider = makeProvider();
    await expect(
      (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
        ._handleFocusRequest({ fsPath: focusFile })
    ).resolves.toBeUndefined();

    await expect(fs.promises.access(focusFile)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- SessionSitterViewProvider
```
Expected: 4 failures — `_handleFocusRequest is not a function`

- [ ] **Step 3: Add imports, field, constructor call, and methods to SessionSitterViewProvider.ts**

At the top of `src/SessionSitterViewProvider.ts`, replace:
```typescript
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession, getActiveSessionIds } from './SessionManager';
```
with:
```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession, getActiveSessionIds, readActiveLockFiles, getIPCSocketForPid } from './SessionManager';
```

After the existing `private _historyOpen = false;` field (line 14), add:
```typescript
  private _focusWatcher: vscode.Disposable | undefined;
```

Replace the constructor (lines 16–19):
```typescript
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
  ) {}
```
with:
```typescript
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
  ) {
    this._focusWatcher = this._startFocusRequestWatcher();
  }
```

Replace the `dispose()` method (lines 103–106):
```typescript
  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
  }
```
with:
```typescript
  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
    this._focusWatcher?.dispose();
  }
```

Append these two methods immediately before `_getHtmlForWebview` (before line 218):

```typescript
  // Called when a focus-<pid>.json file is created/changed in the session-sitter dir.
  // Reads the request, checks freshness, calls primaryEditor.open, and deletes the file.
  async _handleFocusRequest(uri: { fsPath: string }): Promise<void> {
    try {
      const raw = await fs.promises.readFile(uri.fsPath, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: unknown; requestedAt?: unknown };
      if (typeof data.sessionId !== 'string' || typeof data.requestedAt !== 'number') { return; }
      if (Date.now() - data.requestedAt > 10_000) { return; }
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', data.sessionId);
    } catch { /* malformed or missing */ } finally {
      try { await fs.promises.unlink(uri.fsPath); } catch { /* already gone */ }
    }
  }

  // Watch for focus requests addressed to this window's PID and handle them.
  private _startFocusRequestWatcher(): vscode.Disposable {
    const dir = path.join(os.homedir(), '.claude', 'session-sitter');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(dir),
      `focus-${process.pid}.json`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(uri => { void this._handleFocusRequest(uri); });
    watcher.onDidChange(uri => { void this._handleFocusRequest(uri); });
    return watcher;
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- SessionSitterViewProvider
```
Expected: 4 passing

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/test/SessionSitterViewProvider.test.ts
git commit -m "feat: add focus-request receiver to session switcher"
```

---

### Task 3: Focus-request sender + updated switchSession handler

**Files:**
- Modify: `src/SessionSitterViewProvider.ts`
- Modify: `src/test/SessionSitterViewProvider.test.ts` (append new describe blocks)

**Interfaces:**
- Consumes: `readActiveLockFiles(): Promise<LockFileInfo[]>` from Task 1
- Consumes: `getIPCSocketForPid(pid): Promise<string | null>` from Task 1
- Produces: `private async _tryFocusForeignWindow(sessionId: string): Promise<'focused' | 'foreign-failed' | 'local'>`
- Produces: updated `switchSession` case in `onDidReceiveMessage`

---

- [ ] **Step 1: Append failing tests for `_tryFocusForeignWindow` to SessionSitterViewProvider.test.ts**

Append to the end of `src/test/SessionSitterViewProvider.test.ts`:

```typescript
// ── Tests: _tryFocusForeignWindow ─────────────────────────────────────────────
import { readActiveLockFiles, getIPCSocketForPid } from '../SessionManager';
import { execFile } from 'child_process';

type PrivateProvider = {
  _tryFocusForeignWindow(id: string): Promise<'focused' | 'foreign-failed' | 'local'>;
};

describe('_tryFocusForeignWindow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'focus-send-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    mockExecuteCommand.mockClear();
    mockShowWarningMessage.mockClear();
    vi.mocked(readActiveLockFiles).mockResolvedValue([]);
    vi.mocked(getIPCSocketForPid).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns "local" when the session has no projectPath', async () => {
    const session = {
      sessionId: 'no-path', projectPath: '', projectName: '', title: 'T',
      updatedAt: new Date(), status: 'idle' as const,
    };
    const provider = makeProvider([session]) as unknown as PrivateProvider;
    expect(await provider._tryFocusForeignWindow('no-path')).toBe('local');
  });

  it('returns "local" when no lock file matches the session workspace', async () => {
    vi.mocked(readActiveLockFiles).mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/unrelated/path'], port: 1234 },
    ]);
    const session = {
      sessionId: 'no-match', projectPath: '/home/user/myproject', projectName: 'myproject',
      title: 'T', updatedAt: new Date(), status: 'idle' as const,
    };
    const provider = makeProvider([session]) as unknown as PrivateProvider;
    expect(await provider._tryFocusForeignWindow('no-match')).toBe('local');
  });

  it('returns "local" when the matching lock file has the current PID', async () => {
    vi.mocked(readActiveLockFiles).mockResolvedValue([
      { pid: process.pid, workspaceFolders: ['/home/user/myproject'], port: 1234 },
    ]);
    const session = {
      sessionId: 'same-pid', projectPath: '/home/user/myproject', projectName: 'myproject',
      title: 'T', updatedAt: new Date(), status: 'idle' as const,
    };
    const provider = makeProvider([session]) as unknown as PrivateProvider;
    expect(await provider._tryFocusForeignWindow('same-pid')).toBe('local');
  });

  it('returns "foreign-failed" when getIPCSocketForPid returns null', async () => {
    const foreignPid = process.pid + 1;
    vi.mocked(readActiveLockFiles).mockResolvedValue([
      { pid: foreignPid, workspaceFolders: ['/home/user/myproject'], port: 1234 },
    ]);
    vi.mocked(getIPCSocketForPid).mockResolvedValue(null);
    const session = {
      sessionId: 'no-socket', projectPath: '/home/user/myproject', projectName: 'myproject',
      title: 'T', updatedAt: new Date(), status: 'idle' as const,
    };
    const provider = makeProvider([session]) as unknown as PrivateProvider;
    expect(await provider._tryFocusForeignWindow('no-socket')).toBe('foreign-failed');
  });

  it('returns "foreign-failed" when execFile throws', async () => {
    const foreignPid = process.pid + 1;
    vi.mocked(readActiveLockFiles).mockResolvedValue([
      { pid: foreignPid, workspaceFolders: ['/home/user/myproject'], port: 1234 },
    ]);
    vi.mocked(getIPCSocketForPid).mockResolvedValue('/run/user/1000/vscode-ipc-test.sock');
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error('ENOENT'));
      }
    );
    const session = {
      sessionId: 'exec-fail', projectPath: '/home/user/myproject', projectName: 'myproject',
      title: 'T', updatedAt: new Date(), status: 'idle' as const,
    };
    const provider = makeProvider([session]) as unknown as PrivateProvider;
    expect(await provider._tryFocusForeignWindow('exec-fail')).toBe('foreign-failed');
  });

  it('returns "focused" on success and writes the signal file', async () => {
    const foreignPid = process.pid + 1;
    vi.mocked(readActiveLockFiles).mockResolvedValue([
      { pid: foreignPid, workspaceFolders: ['/home/user/myproject'], port: 1234 },
    ]);
    vi.mocked(getIPCSocketForPid).mockResolvedValue('/run/user/1000/vscode-ipc-test.sock');
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
      }
    );
    const session = {
      sessionId: 'success-id', projectPath: '/home/user/myproject', projectName: 'myproject',
      title: 'T', updatedAt: new Date(), status: 'idle' as const,
    };
    const provider = makeProvider([session]) as unknown as PrivateProvider;
    const result = await provider._tryFocusForeignWindow('success-id');

    expect(result).toBe('focused');
    const focusFile = path.join(tmpDir, '.claude', 'session-sitter', `focus-${foreignPid}.json`);
    const written = JSON.parse(await fs.promises.readFile(focusFile, 'utf8'));
    expect(written.sessionId).toBe('success-id');
    expect(written.workspacePath).toBe('/home/user/myproject');
    expect(typeof written.requestedAt).toBe('number');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- SessionSitterViewProvider
```
Expected: 6 new failures — `_tryFocusForeignWindow is not a function`

- [ ] **Step 3: Implement `_tryFocusForeignWindow` in SessionSitterViewProvider.ts**

Append this method immediately after `_startFocusRequestWatcher` (before `_getHtmlForWebview`):

```typescript
  private async _tryFocusForeignWindow(sessionId: string): Promise<'focused' | 'foreign-failed' | 'local'> {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session?.projectPath) { return 'local'; }

    const locks = await readActiveLockFiles();
    const ownerLock = locks.find(lock =>
      lock.pid !== process.pid &&
      lock.workspaceFolders.some(wf =>
        session.projectPath === wf || session.projectPath.startsWith(wf + '/')
      )
    );

    if (!ownerLock) { return 'local'; }

    // Foreign owner found — must focus it; do not fall back to local.
    try {
      const ipcSocket = await getIPCSocketForPid(ownerLock.pid);
      if (!ipcSocket) { return 'foreign-failed'; }

      const dir = path.join(os.homedir(), '.claude', 'session-sitter');
      await fs.promises.mkdir(dir, { recursive: true });

      const focusFile = path.join(dir, `focus-${ownerLock.pid}.json`);
      await fs.promises.writeFile(focusFile, JSON.stringify({
        sessionId,
        workspacePath: ownerLock.workspaceFolders[0],
        requestedAt: Date.now(),
      }), 'utf8');

      await new Promise<void>((resolve, reject) => {
        execFile(
          'code',
          [ownerLock.workspaceFolders[0]],
          { env: { ...process.env, VSCODE_IPC_HOOK_CLI: ipcSocket }, timeout: 3000 },
          err => { if (err) { reject(err); } else { resolve(); } },
        );
      });

      return 'focused';
    } catch {
      return 'foreign-failed';
    }
  }
```

- [ ] **Step 4: Update the `switchSession` case in `onDidReceiveMessage`**

In `SessionSitterViewProvider.ts`, find the `switchSession` case (around line 57):
```typescript
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            break;
          }
```
Replace it with:
```typescript
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._tryFocusForeignWindow(sessionId).then(result => {
              if (result === 'local') {
                void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
              } else if (result === 'foreign-failed') {
                void vscode.window.showWarningMessage('Could not switch to the window containing this session.');
              }
            });
            break;
          }
```

- [ ] **Step 5: Run all tests to confirm they pass**

```bash
npm test
```
Expected: all tests passing (including the existing SessionManager suite)

- [ ] **Step 6: Compile**

```bash
npm run compile
```
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/test/SessionSitterViewProvider.test.ts
git commit -m "feat: jump to foreign IDE window when switching sessions"
```

- [ ] **Step 8: Manual verification**

Open two IDE windows with different workspaces. In window A's session switcher, click a session that belongs to window B:
- Window B comes to the OS foreground
- The correct Claude panel (main editor or secondary sidebar) is focused in window B
- Nothing opens in window A

Click a session that belongs to the current window A:
- Panel switches locally in window A as before

Close window B, then click one of its sessions in window A:
- A warning toast appears: "Could not switch to the window containing this session."
- Nothing opens in window A
