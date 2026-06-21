import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── VS Code stub ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before variable declarations, so mock fns must
// be created with vi.hoisted() to be accessible inside the factory.
const { mockExecuteCommand, mockShowWarningMessage, mockGetConfiguration } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockGetConfiguration: vi.fn((): { get: (key?: string) => string | undefined } => ({ get: () => 'panel' })),
}));

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
      getConfiguration: mockGetConfiguration,
      workspaceFolders: [],
    },
    window: {
      tabGroups: { all: [], onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
      showWarningMessage: mockShowWarningMessage,
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: { appName: 'IBM Bob' },
    commands: { executeCommand: mockExecuteCommand },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
  };
});

// ── os stub (homedir is non-configurable, must use vi.mock) ───────────────────
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn().mockReturnValue(actual.homedir()) };
});

// ── SessionManager stub ────────────────────────────────────────────────────────
vi.mock('../SessionManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionManager')>();
  return { ...actual, getActiveSessionIds: vi.fn().mockResolvedValue(new Set()) };
});

// ── WindowRegistry stub ──────────────────────────────────────────────────────
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

// ── child_process stub ─────────────────────────────────────────────────────────
vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { SessionSwitcherViewProvider } from '../SessionSwitcherViewProvider';
import { SessionManager } from '../SessionManager';
import { execFile } from 'child_process';

function makeProvider(sessions: import('../SessionManager').ClaudeSession[] = []) {
  const mockManager = {
    getSessions: vi.fn().mockReturnValue(sessions),
    onDidChangeSessions: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    dispose: vi.fn(),
  } as unknown as SessionManager;
  return new SessionSwitcherViewProvider(
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

// ── Tests: _findOwnerWindow & _tryFocusForeignWindow ──────────────────────────
type PrivateProvider = {
  _findOwnerWindow(id: string): Promise<unknown>;
  _tryFocusForeignWindow(id: string): Promise<'focused' | 'foreign-failed' | 'local'>;
};

function providerWithSession(projectPath: string): PrivateProvider {
  const session = {
    sessionId: 'S', projectPath, projectName: 'proj', title: 'S',
    updatedAt: new Date(), status: 'idle' as const,
  };
  return makeProvider([session]) as unknown as PrivateProvider;
}

describe('_findOwnerWindow', () => {
  beforeEach(() => {
    mockReadLiveWindows.mockReset();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
  });

  it('returns null when the only match is our own pid', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s', updatedAt: Date.now() },
    ]);
    expect(await providerWithSession('/ws/proj')._findOwnerWindow('S')).toBeNull();
  });

  it('returns a foreign window whose workspace contains the project', async () => {
    const owner = { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() };
    mockReadLiveWindows.mockResolvedValue([owner]);
    expect(await providerWithSession('/ws/proj')._findOwnerWindow('S')).toEqual(owner);
  });
});

describe('_tryFocusForeignWindow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'focus-send-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
    mockReadLiveWindows.mockReset();
    (execFile as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(async () => {
    vi.mocked(os.homedir).mockReset();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns "local" when no foreign owner', async () => {
    mockReadLiveWindows.mockResolvedValue([]);
    expect(await providerWithSession('/ws/proj')._tryFocusForeignWindow('S')).toBe('local');
  });

  it('returns "foreign-failed" when owner has no ipcSocket', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now() },
    ]);
    expect(await providerWithSession('/ws/proj')._tryFocusForeignWindow('S')).toBe('foreign-failed');
  });

  it('execs the owner CLI with its socket and returns "focused"', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => cb(null),
    );
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() },
    ]);
    const result = await providerWithSession('/ws/proj')._tryFocusForeignWindow('S');
    expect(result).toBe('focused');
    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('bobide');
    expect(call[1]).toEqual(['--reuse-window', '/ws']);
    expect(call[2].env.VSCODE_IPC_HOOK_CLI).toBe('/s.sock');
  });

  it('returns "foreign-failed" when execFile throws', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => cb(new Error('ENOENT')),
    );
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() },
    ]);
    expect(await providerWithSession('/ws/proj')._tryFocusForeignWindow('S')).toBe('foreign-failed');
  });
});

// ── Tests: _openSessionLocal ──────────────────────────────────────────────────
describe('_openSessionLocal', () => {
  beforeEach(() => {
    mockExecuteCommand.mockClear();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
  });

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
