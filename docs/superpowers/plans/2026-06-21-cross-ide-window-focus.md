# Cross-IDE Cross-Window Session Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clicking a session reliably reveal it on both IBM Bob and VS Code — locally or in another window, in the main editor or the secondary side panel — instead of failing with "Could not switch to the window containing this session."

**Architecture:** Replace the broken reliance on the Claude lock-file pid (which is the shared remote *server* process, not the per-window extension host) with a self-published per-window registry. Each window discovers its own `VSCODE_IPC_HOOK_CLI` socket (by scanning its descendant processes) and its IDE CLI (`bobide`/`code`), writes them to `~/.claude/session-sitter/windows/<pid>.json`, and peers read those files to raise and focus each other.

**Tech Stack:** TypeScript, VS Code extension API, Node `fs`/`child_process`/`/proc`, Vitest.

## Global Constraints

- VS Code engine floor: `^1.64.0` (do not use APIs newer than this without a guard) — copied from `package.json`.
- Must work under both IBM Bob (`.bobide-server`, CLI `bobide`) and VS Code (CLI `code`), and on remote (`/proc` present) and desktop (no `/proc`) hosts.
- All new file-system helpers must be unit-testable with an injectable home dir / proc reader (follow the existing `vi.mock('os', …)` + dependency-injection pattern in `src/test/`).
- The Claude extension exposes **no** API to switch the secondary side panel to a specific session (`claude-vscode.sidebar.open` takes no args). Sidebar mode = focus the panel only.
- Keep `_tryFocusForeignWindow`'s existing return contract: `'focused' | 'foreign-failed' | 'local'`.

---

## File Structure

- **Create** `src/WindowRegistry.ts` — window identity: IDE-CLI detection, self-socket discovery, and read/write/remove of per-window registry files. One responsibility: "who am I and how is each live window reached."
- **Create** `src/test/WindowRegistry.test.ts` — unit tests for the above.
- **Modify** `src/SessionSitterViewProvider.ts` — use the registry for owner detection and foreign focus; add a location-aware local-open helper; wire registry lifecycle.
- **Modify** `src/test/SessionSitterViewProvider.test.ts` — update mocks to the registry; add location-aware + owner-detection tests.
- **Modify** `src/SessionManager.ts` — only if removing the now-unused `readActiveLockFiles`/`getIPCSocketForPid` focus exports (Task 6); `getActiveSessionIds` stays.

---

## Task 1: WindowRegistry — types + IDE CLI detection

**Files:**
- Create: `src/WindowRegistry.ts`
- Test: `src/test/WindowRegistry.test.ts`

**Interfaces:**
- Produces:
  - `interface WindowEntry { pid: number; workspaceFolders: string[]; ideCli: string; ipcSocket: string; updatedAt: number }`
  - `function detectIdeCli(execPath?: string, appName?: string, readdir?: (p: string) => string[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/test/WindowRegistry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectIdeCli } from '../WindowRegistry';

describe('detectIdeCli', () => {
  it('returns the remote-cli executable path when present (IBM Bob)', () => {
    const execPath = '/home/u/.bobide-server/bin/abc123/node';
    const readdir = vi.fn().mockReturnValue(['helpers', 'bobide', '.keep']);
    expect(detectIdeCli(execPath, 'IBM Bob', readdir)).toBe(
      '/home/u/.bobide-server/bin/abc123/bin/remote-cli/bobide',
    );
    expect(readdir).toHaveBeenCalledWith('/home/u/.bobide-server/bin/abc123/bin/remote-cli');
  });

  it('falls back to "bobide" by appName when remote-cli dir is unreadable', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'IBM Bob', readdir)).toBe('bobide');
  });

  it('falls back to "code" for VS Code desktop', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'Visual Studio Code', readdir)).toBe('code');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/WindowRegistry.test.ts`
Expected: FAIL — `detectIdeCli` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/WindowRegistry.ts
import * as fs from 'fs';
import * as path from 'path';

export interface WindowEntry {
  pid: number;
  workspaceFolders: string[];
  ideCli: string;
  ipcSocket: string;
  updatedAt: number;
}

const HELPER_NAMES = new Set(['helpers']);

// Determine the CLI used to focus a window. On remote IDEs the launcher lives in
// <serverBin>/bin/remote-cli/ next to the node execPath (Bob → "bobide", VS Code → "code").
// Returns an absolute path when found, else a bare name resolved via PATH.
export function detectIdeCli(
  execPath: string = process.execPath,
  appName = '',
  readdir: (p: string) => string[] = fs.readdirSync,
): string {
  const cliDir = path.join(path.dirname(execPath), 'bin', 'remote-cli');
  try {
    const exec = readdir(cliDir).find(e => !HELPER_NAMES.has(e) && !e.startsWith('.'));
    if (exec) { return path.join(cliDir, exec); }
  } catch { /* not a remote IDE layout */ }
  if (appName.toLowerCase().includes('bob')) { return 'bobide'; }
  return 'code';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/WindowRegistry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/WindowRegistry.ts src/test/WindowRegistry.test.ts
git commit -m "feat: WindowRegistry types + IDE CLI detection"
```

---

## Task 2: WindowRegistry — self IPC-socket discovery

**Files:**
- Modify: `src/WindowRegistry.ts`
- Test: `src/test/WindowRegistry.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface ProcFs { listPids(): number[]; readEnviron(pid: number): string; readPpid(pid: number): number }`
  - `function discoverOwnIpcSocket(selfPid?: number, proc?: ProcFs): string | null`

The discovery rule: find a process whose `environ` contains `VSCODE_IPC_HOOK_CLI=` **and** whose parent-chain includes `selfPid` (the extension host); return that socket. The ext-host process itself does not carry the var — only its descendants do.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/test/WindowRegistry.test.ts
import { discoverOwnIpcSocket, type ProcFs } from '../WindowRegistry';

function fakeProc(tree: Record<number, { ppid: number; environ?: string }>): ProcFs {
  return {
    listPids: () => Object.keys(tree).map(Number),
    readPpid: (pid) => tree[pid]?.ppid ?? 1,
    readEnviron: (pid) => tree[pid]?.environ ?? '',
  };
}

describe('discoverOwnIpcSocket', () => {
  const SOCK = '/run/user/1000/vscode-ipc-abc.sock';

  it('returns the socket carried by a descendant of selfPid', () => {
    const proc = fakeProc({
      100: { ppid: 1 },                                   // server
      200: { ppid: 100 },                                 // our ext host (selfPid)
      300: { ppid: 200, environ: `PATH=/x\0VSCODE_IPC_HOOK_CLI=${SOCK}\0` }, // descendant
    });
    expect(discoverOwnIpcSocket(200, proc)).toBe(SOCK);
  });

  it('ignores sockets carried by processes from another window', () => {
    const proc = fakeProc({
      200: { ppid: 1 },                                   // our ext host
      900: { ppid: 1 },                                   // another window ext host
      901: { ppid: 900, environ: `VSCODE_IPC_HOOK_CLI=/run/other.sock\0` },
    });
    expect(discoverOwnIpcSocket(200, proc)).toBeNull();
  });

  it('returns null when no descendant carries the var', () => {
    const proc = fakeProc({ 200: { ppid: 1 }, 300: { ppid: 200, environ: 'PATH=/x\0' } });
    expect(discoverOwnIpcSocket(200, proc)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/WindowRegistry.test.ts`
Expected: FAIL — `discoverOwnIpcSocket` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/WindowRegistry.ts
export interface ProcFs {
  listPids(): number[];
  readEnviron(pid: number): string;
  readPpid(pid: number): number;
}

const realProcFs: ProcFs = {
  listPids: () => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number),
  readEnviron: (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return ''; } },
  readPpid: (pid) => {
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may contain spaces/parens,
      // so parse after the last ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return parseInt(after[1], 10) || 1; // fields after comm: state(0), ppid(1)
    } catch { return 1; }
  },
};

function isDescendantOf(pid: number, ancestor: number, proc: ProcFs): boolean {
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const ppid = proc.readPpid(cur);
    if (ppid === ancestor) { return true; }
    if (ppid === cur) { break; }
    cur = ppid;
  }
  return false;
}

// Find this window's own VSCODE_IPC_HOOK_CLI by scanning descendant processes.
// Returns null on platforms without /proc or when no descendant carries the var.
export function discoverOwnIpcSocket(
  selfPid: number = process.pid,
  proc: ProcFs = realProcFs,
): string | null {
  let pids: number[];
  try { pids = proc.listPids(); } catch { return null; }
  for (const pid of pids) {
    const env = proc.readEnviron(pid);
    const m = env.split('\0').find(e => e.startsWith('VSCODE_IPC_HOOK_CLI='));
    if (!m) { continue; }
    if (pid === selfPid || isDescendantOf(pid, selfPid, proc)) {
      return m.slice('VSCODE_IPC_HOOK_CLI='.length);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/WindowRegistry.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/WindowRegistry.ts src/test/WindowRegistry.test.ts
git commit -m "feat: discover own VSCODE_IPC_HOOK_CLI via descendant procs"
```

---

## Task 3: WindowRegistry — write / read-live / remove entries

**Files:**
- Modify: `src/WindowRegistry.ts`
- Test: `src/test/WindowRegistry.test.ts`

**Interfaces:**
- Consumes: `WindowEntry` (Task 1).
- Produces:
  - `function windowsDir(homedir?: string): string`
  - `async function writeWindowEntry(entry: WindowEntry, homedir?: string): Promise<void>`
  - `async function removeWindowEntry(pid: number, homedir?: string): Promise<void>`
  - `async function readLiveWindows(opts?: { homedir?: string; isAlive?: (pid: number) => boolean; now?: number }): Promise<WindowEntry[]>`

`readLiveWindows` filters out dead pids (`isAlive`) and entries older than 24 h; best-effort unlinks dead files.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/test/WindowRegistry.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeWindowEntry, readLiveWindows, removeWindowEntry, windowsDir, type WindowEntry } from '../WindowRegistry';

describe('window registry files', () => {
  let home: string;
  beforeEach(async () => { home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wr-')); });
  afterEach(async () => { await fs.promises.rm(home, { recursive: true, force: true }); });

  const entry = (pid: number): WindowEntry => ({
    pid, workspaceFolders: [`/ws/${pid}`], ideCli: 'bobide', ipcSocket: `/s/${pid}.sock`, updatedAt: 1000,
  });

  it('round-trips a live entry', async () => {
    await writeWindowEntry(entry(42), home);
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 2000 });
    expect(live).toEqual([entry(42)]);
  });

  it('drops dead pids and unlinks their files', async () => {
    await writeWindowEntry(entry(42), home);
    const live = await readLiveWindows({ homedir: home, isAlive: () => false, now: 2000 });
    expect(live).toEqual([]);
    expect(fs.existsSync(path.join(windowsDir(home), '42.json'))).toBe(false);
  });

  it('drops entries older than 24h', async () => {
    await writeWindowEntry(entry(42), home); // updatedAt 1000
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 1000 + 25 * 3600 * 1000 });
    expect(live).toEqual([]);
  });

  it('removeWindowEntry deletes the file', async () => {
    await writeWindowEntry(entry(42), home);
    await removeWindowEntry(42, home);
    expect(fs.existsSync(path.join(windowsDir(home), '42.json'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/WindowRegistry.test.ts`
Expected: FAIL — these functions are not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/WindowRegistry.ts
import * as os from 'os';

const STALE_MS = 24 * 60 * 60 * 1000;

export function windowsDir(homedir: string = os.homedir()): string {
  return path.join(homedir, '.claude', 'session-sitter', 'windows');
}

export async function writeWindowEntry(entry: WindowEntry, homedir: string = os.homedir()): Promise<void> {
  const dir = windowsDir(homedir);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${entry.pid}.json`), JSON.stringify(entry), 'utf8');
}

export async function removeWindowEntry(pid: number, homedir: string = os.homedir()): Promise<void> {
  try { await fs.promises.unlink(path.join(windowsDir(homedir), `${pid}.json`)); } catch { /* gone */ }
}

export async function readLiveWindows(opts: {
  homedir?: string;
  isAlive?: (pid: number) => boolean;
  now?: number;
} = {}): Promise<WindowEntry[]> {
  const homedir = opts.homedir ?? os.homedir();
  const isAlive = opts.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const now = opts.now ?? Date.now();
  const dir = windowsDir(homedir);
  let files: string[];
  try { files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json')); } catch { return []; }
  const out: WindowEntry[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(dir, file), 'utf8')) as WindowEntry;
      if (typeof data.pid !== 'number' || !Array.isArray(data.workspaceFolders)) { continue; }
      if (!isAlive(data.pid) || now - data.updatedAt > STALE_MS) {
        try { await fs.promises.unlink(path.join(dir, file)); } catch { /* ignore */ }
        continue;
      }
      out.push(data);
    } catch { /* malformed — skip */ }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/WindowRegistry.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/WindowRegistry.ts src/test/WindowRegistry.test.ts
git commit -m "feat: per-window registry file read/write/remove with liveness + staleness"
```

---

## Task 4: Location-aware local open helper

**Files:**
- Modify: `src/SessionSitterViewProvider.ts`
- Test: `src/test/SessionSitterViewProvider.test.ts`

**Interfaces:**
- Produces (private, but tested via cast like existing tests): `_openSessionLocal(sessionId: string): void`
  - Reads `claudeCode.preferredLocation`; `'sidebar'` → `claude-vscode.sidebar.open` (no arg), else → `claude-vscode.primaryEditor.open(sessionId)`.

This replaces the three current unconditional `executeCommand('claude-vscode.primaryEditor.open', sessionId)` call sites.

- [ ] **Step 1: Add `workspace.getConfiguration` to the vscode mock**

In `src/test/SessionSitterViewProvider.test.ts`, extend the `vi.hoisted` block and the `vscode` mock:

```ts
const { mockExecuteCommand, mockShowWarningMessage, mockGetConfiguration } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockGetConfiguration: vi.fn(() => ({ get: () => 'panel' })),
}));
```

and inside the returned `workspace` object add:

```ts
    workspace: {
      createFileSystemWatcher: vi.fn(() => new FileSystemWatcher()),
      getConfiguration: mockGetConfiguration,
      workspaceFolders: [],
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
    },
```

Also add `onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() }))` under `window` in the mock.

- [ ] **Step 2: Write the failing test**

```ts
// append to src/test/SessionSitterViewProvider.test.ts
describe('_openSessionLocal', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  it('opens in the primary editor when preferredLocation is panel', () => {
    mockGetConfiguration.mockReturnValueOnce({ get: () => 'panel' });
    const p = makeProvider() as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });

  it('focuses the sidebar when preferredLocation is sidebar', () => {
    mockGetConfiguration.mockReturnValueOnce({ get: () => 'sidebar' });
    const p = makeProvider() as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/test/SessionSitterViewProvider.test.ts`
Expected: FAIL — `_openSessionLocal` is not a function.

- [ ] **Step 4: Implement `_openSessionLocal` and route existing call sites through it**

In `src/SessionSitterViewProvider.ts`, add the method:

```ts
  // Reveal a session in the current window, respecting where Claude is docked.
  // Sidebar mode can only be focused (the Claude extension exposes no per-session
  // sidebar API); editor mode reveals the exact session.
  private _openSessionLocal(sessionId: string): void {
    const loc = vscode.workspace.getConfiguration('claudeCode').get<string>('preferredLocation');
    if (loc === 'sidebar') {
      void vscode.commands.executeCommand('claude-vscode.sidebar.open');
    } else {
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
    }
  }
```

Then replace these three call sites:
- In `switchSession` (`result === 'local'` branch) — replace `void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);` with `this._openSessionLocal(sessionId);`
- In `addFromHistory` — replace `void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);` with `this._openSessionLocal(sessionId);`
- In `_handleFocusRequest` — replace `void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', data.sessionId);` with `this._openSessionLocal(data.sessionId);`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/test/SessionSitterViewProvider.test.ts`
Expected: PASS (existing `_handleFocusRequest` tests still pass — they assert `executeCommand` was called; under default `'panel'` config they now call `primaryEditor.open`, unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/test/SessionSitterViewProvider.test.ts
git commit -m "feat: location-aware local open (editor vs secondary panel)"
```

---

## Task 5: Owner detection + rewired foreign focus via registry

**Files:**
- Modify: `src/SessionSitterViewProvider.ts`
- Test: `src/test/SessionSitterViewProvider.test.ts`

**Interfaces:**
- Consumes: `readLiveWindows`, `WindowEntry` (Task 3); `_openSessionLocal` (Task 4).
- Produces:
  - `async _findOwnerWindow(sessionId: string): Promise<WindowEntry | null>` — live registry entry whose `workspaceFolders` contains the session's `projectPath` and whose `pid !== process.pid`; else `null`.
  - Rewritten `_tryFocusForeignWindow(sessionId): Promise<'focused' | 'foreign-failed' | 'local'>` using the owner entry's `ideCli` + `ipcSocket`.

- [ ] **Step 1: Swap the SessionManager mock for a WindowRegistry mock**

In `src/test/SessionSitterViewProvider.test.ts`, replace the `vi.mock('../SessionManager', …)` block's focus exports and add a `WindowRegistry` mock:

```ts
vi.mock('../SessionManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionManager')>();
  return { ...actual, getActiveSessionIds: vi.fn().mockResolvedValue(new Set()) };
});

const { mockReadLiveWindows } = vi.hoisted(() => ({ mockReadLiveWindows: vi.fn().mockResolvedValue([]) }));
vi.mock('../WindowRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../WindowRegistry')>();
  return {
    ...actual,
    readLiveWindows: mockReadLiveWindows,
    writeWindowEntry: vi.fn().mockResolvedValue(undefined),
    removeWindowEntry: vi.fn().mockResolvedValue(undefined),
    discoverOwnIpcSocket: vi.fn().mockReturnValue('/run/self.sock'),
    detectIdeCli: vi.fn().mockReturnValue('bobide'),
  };
});
```

Remove the now-unused `readActiveLockFiles`/`getIPCSocketForPid` imports from this test file. Keep the `child_process` mock. Update `makeProvider` to attach `projectPath` to sessions where tests need it.

- [ ] **Step 2: Write the failing tests**

```ts
// replace the old `_tryFocusForeignWindow` describe block with:
import { execFile } from 'child_process';
import { readLiveWindows } from '../WindowRegistry';

function providerWithSession(projectPath: string) {
  const session = { sessionId: 'S', title: 'S', projectPath, updatedAt: new Date(), status: 'idle' };
  return makeProvider([session as never]) as unknown as {
    _findOwnerWindow(id: string): Promise<unknown>;
    _tryFocusForeignWindow(id: string): Promise<'focused' | 'foreign-failed' | 'local'>;
  };
}

describe('_findOwnerWindow', () => {
  beforeEach(() => mockReadLiveWindows.mockReset());

  it('returns null when the only match is our own pid', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s', updatedAt: Date.now() },
    ]);
    const p = providerWithSession('/ws/proj');
    expect(await p._findOwnerWindow('S')).toBeNull();
  });

  it('returns a foreign window whose workspace contains the project', async () => {
    const owner = { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() };
    mockReadLiveWindows.mockResolvedValue([owner]);
    const p = providerWithSession('/ws/proj');
    expect(await p._findOwnerWindow('S')).toEqual(owner);
  });
});

describe('_tryFocusForeignWindow', () => {
  beforeEach(() => { mockReadLiveWindows.mockReset(); (execFile as unknown as ReturnType<typeof vi.fn>).mockReset(); });

  it('returns "local" when no foreign owner', async () => {
    mockReadLiveWindows.mockResolvedValue([]);
    const p = providerWithSession('/ws/proj');
    expect(await p._tryFocusForeignWindow('S')).toBe('local');
  });

  it('returns "foreign-failed" when owner has no ipcSocket', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now() },
    ]);
    const p = providerWithSession('/ws/proj');
    expect(await p._tryFocusForeignWindow('S')).toBe('foreign-failed');
  });

  it('execs the owner CLI with its socket and returns "focused"', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => cb(null),
    );
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() },
    ]);
    const p = providerWithSession('/ws/proj');
    expect(await p._tryFocusForeignWindow('S')).toBe('focused');
    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('bobide');
    expect(call[1]).toEqual(['--reuse-window', '/ws']);
    expect(call[2].env.VSCODE_IPC_HOOK_CLI).toBe('/s.sock');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/test/SessionSitterViewProvider.test.ts`
Expected: FAIL — `_findOwnerWindow` undefined / `_tryFocusForeignWindow` still uses lock files.

- [ ] **Step 4: Rewrite the methods in `src/SessionSitterViewProvider.ts`**

Update the import line (drop `readActiveLockFiles, getIPCSocketForPid`):

```ts
import { SessionManager, ClaudeSession, MessageExchange, getActiveSessionIds } from './SessionManager';
import { readLiveWindows, writeWindowEntry, removeWindowEntry, discoverOwnIpcSocket, detectIdeCli, type WindowEntry } from './WindowRegistry';
```

Replace `_tryFocusForeignWindow` and add `_findOwnerWindow`:

```ts
  private async _findOwnerWindow(sessionId: string): Promise<WindowEntry | null> {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session?.projectPath) { return null; }
    const windows = await readLiveWindows();
    return windows.find(w =>
      w.pid !== process.pid &&
      w.workspaceFolders.some(wf => session.projectPath === wf || session.projectPath.startsWith(wf + '/')),
    ) ?? null;
  }

  private async _tryFocusForeignWindow(sessionId: string): Promise<'focused' | 'foreign-failed' | 'local'> {
    const owner = await this._findOwnerWindow(sessionId);
    if (!owner) { return 'local'; }
    if (!owner.ipcSocket || !owner.ideCli) { return 'foreign-failed'; }
    try {
      const dir = path.join(os.homedir(), '.claude', 'session-sitter');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, `focus-${owner.pid}.json`),
        JSON.stringify({ sessionId, requestedAt: Date.now() }),
        'utf8',
      );
      await new Promise<void>((resolve, reject) => {
        execFile(
          owner.ideCli,
          ['--reuse-window', owner.workspaceFolders[0]],
          { env: { ...process.env, VSCODE_IPC_HOOK_CLI: owner.ipcSocket }, timeout: 3000 },
          err => { if (err) { reject(err); } else { resolve(); } },
        );
      });
      return 'focused';
    } catch {
      return 'foreign-failed';
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/test/SessionSitterViewProvider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/test/SessionSitterViewProvider.test.ts
git commit -m "feat: owner detection + foreign focus via per-window registry"
```

---

## Task 6: Registry lifecycle wiring + remove dead lock-file code

**Files:**
- Modify: `src/SessionSitterViewProvider.ts`
- Modify: `src/SessionManager.ts`
- Modify: `src/test/SessionManager.test.ts` (only if it referenced removed exports)

**Interfaces:**
- Consumes: `writeWindowEntry`, `removeWindowEntry`, `discoverOwnIpcSocket`, `detectIdeCli` (Tasks 1–3).

- [ ] **Step 1: Publish + refresh the window entry on activation**

In `SessionSitterViewProvider`, add a publisher and a timer field, call it from the constructor (the watcher is already started there), and refresh on window focus changes inside `resolveWebviewView`:

```ts
  private _registryTimer: ReturnType<typeof setInterval> | undefined;

  // in the constructor, after starting the focus watcher:
  void this._publishWindowEntry();
  this._registryTimer = setInterval(() => { void this._publishWindowEntry(); }, 60_000);

  private async _publishWindowEntry(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    await writeWindowEntry({
      pid: process.pid,
      workspaceFolders: folders,
      ideCli: detectIdeCli(undefined, vscode.env.appName),
      ipcSocket: discoverOwnIpcSocket() ?? process.env.VSCODE_IPC_HOOK_CLI ?? '',
      updatedAt: Date.now(),
    });
  }
```

In `resolveWebviewView`, add a window-state listener to `_viewDisposables`:

```ts
    this._viewDisposables.push(
      vscode.window.onDidChangeWindowState(() => { void this._publishWindowEntry(); }),
    );
```

In `dispose()`, clear the timer and remove the file:

```ts
  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
    this._focusWatcher?.dispose();
    if (this._registryTimer) { clearInterval(this._registryTimer); }
    void removeWindowEntry(process.pid);
  }
```

- [ ] **Step 2: Run the provider tests**

Run: `npx vitest run src/test/SessionSitterViewProvider.test.ts`
Expected: PASS — the mocked `writeWindowEntry`/`onDidChangeWindowState`/`vscode.env` resolve to no-ops. If `vscode.env` is undefined in the mock, add `env: { appName: 'IBM Bob' }` to the `vscode` mock object.

- [ ] **Step 3: Remove the now-unused lock-file focus exports**

In `src/SessionManager.ts`, delete `readActiveLockFiles`, `getIPCSocketForPid`, and the `LockFileInfo` interface (they are no longer imported anywhere — confirm with `grep -rn "readActiveLockFiles\|getIPCSocketForPid\|LockFileInfo" src`). Leave `getActiveSessionIds` untouched.

- [ ] **Step 4: Verify nothing references the removed symbols**

Run: `grep -rn "readActiveLockFiles\|getIPCSocketForPid\|LockFileInfo" src`
Expected: no matches.

- [ ] **Step 5: Full test + typecheck + lint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/SessionManager.ts src/test
git commit -m "feat: publish window registry on activation; drop dead lock-file focus code"
```

---

## Task 7: Manual verification on IBM Bob

**Files:** none (manual).

- [ ] **Step 1: Build / reload**

Run: `npm run compile` (or the project's build), then reload the IBM Bob window(s).

- [ ] **Step 2: Confirm registry files appear**

Run: `ls ~/.claude/session-sitter/windows/ && cat ~/.claude/session-sitter/windows/*.json`
Expected: one JSON per open window, each with a non-empty `ipcSocket` and `ideCli` ending in `bobide`.

- [ ] **Step 3: Cross-window focus (editor)**

Two Bob windows, different workspaces, Claude in the main editor. Click a session from the other window in the switcher.
Expected: the other window comes to the foreground and the exact session is revealed; **no** "Could not switch…" toast.

- [ ] **Step 4: Secondary-panel focus**

Target window has `claudeCode.preferredLocation: "sidebar"`. Click its session.
Expected: window foregrounds and the secondary panel is focused; no error toast. (Switching to a *specific* session in the sidebar is a documented limitation.)

- [ ] **Step 5: Local + history + dead-window paths**

- Click a session owned by the current window → opens locally (editor or sidebar per preference).
- Open a History session → opens locally.
- Close a window, then click its (now stale) session → warning toast, nothing opens; its `windows/<pid>.json` is cleaned up on next read.

- [ ] **Step 6: Commit any doc updates**

If `README.md`/`docs/ARCHITECTURE.md` describe the old lock-file focus mechanism, update them to the registry mechanism and commit.

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: describe per-window registry focus mechanism"
```

---

## Self-Review

**Spec coverage:**
- §1 per-window registry → Tasks 1, 3, 6. ✓
- §2 self socket discovery → Task 2. ✓
- §3 IDE CLI detection → Task 1. ✓
- §4 owner detection → Task 5. ✓
- §5 OS raise via `--reuse-window` + socket → Task 5. ✓
- §6 location-aware receiver/local open → Task 4 (+ `_handleFocusRequest` routed through it). ✓
- Edge cases (dead pid, staleness, missing dir, no socket, non-/proc fallback) → Tasks 3, 5, 6. ✓
- Limitation (sidebar can't target a session) → encoded in Task 4 behavior + Task 7 step 4. ✓
- Tests (WindowRegistry unit, owner/local/receiver) → Tasks 1–6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `WindowEntry`, `ProcFs`, `detectIdeCli`, `discoverOwnIpcSocket`, `readLiveWindows`, `writeWindowEntry`, `removeWindowEntry`, `windowsDir`, `_findOwnerWindow`, `_tryFocusForeignWindow`, `_openSessionLocal`, `_publishWindowEntry` are used with consistent names/signatures across tasks. ✓
