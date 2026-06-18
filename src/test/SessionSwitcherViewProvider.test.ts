import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── VS Code stub ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before variable declarations, so mock fns must
// be created with vi.hoisted() to be accessible inside the factory.
const { mockExecuteCommand, mockShowWarningMessage } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockShowWarningMessage: vi.fn(),
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

// ── os stub (homedir is non-configurable, must use vi.mock) ───────────────────
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn().mockReturnValue(actual.homedir()) };
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

import { SessionSwitcherViewProvider } from '../SessionSwitcherViewProvider';
import { SessionManager, readActiveLockFiles, getIPCSocketForPid } from '../SessionManager';
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

// ── Tests: _tryFocusForeignWindow ─────────────────────────────────────────────
type PrivateProvider = {
  _tryFocusForeignWindow(id: string): Promise<'focused' | 'foreign-failed' | 'local'>;
};

describe('_tryFocusForeignWindow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'focus-send-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
    mockExecuteCommand.mockClear();
    mockShowWarningMessage.mockClear();
    vi.mocked(readActiveLockFiles).mockResolvedValue([]);
    vi.mocked(getIPCSocketForPid).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.mocked(os.homedir).mockReset();
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
    const focusFile = path.join(tmpDir, '.claude', 'session-switcher', `focus-${foreignPid}.json`);
    const written = JSON.parse(await fs.promises.readFile(focusFile, 'utf8'));
    expect(written.sessionId).toBe('success-id');
    expect(written.workspacePath).toBe('/home/user/myproject');
    expect(typeof written.requestedAt).toBe('number');
  });
});
