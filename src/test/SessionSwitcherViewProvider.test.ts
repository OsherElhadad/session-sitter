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
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => p }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath, ...parts].join('/'),
        toString: () => [base.fsPath, ...parts].join('/'),
      }),
    },
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

import * as vscode from 'vscode';
import { SessionSwitcherViewProvider } from '../SessionSwitcherViewProvider';
import { SessionManager } from '../SessionManager';
import { execFile } from 'child_process';

// Set the Claude editor tabs the mocked tabGroups API reports as open.
function setOpenClaudeTabs(labels: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).tabGroups.all = [{
    tabs: labels.map(label => ({ input: { viewType: 'claudeVSCodePanel' }, label })),
  }];
}

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

  it('triggers a local open for a fresh request', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now(),
    }));

    // Provide the session so _openSessionLocal can find it and dispatch
    const session = {
      sessionId: 'abc-123', projectPath: '/home/user/project', projectName: 'project',
      title: 'Test', updatedAt: new Date(), status: 'idle' as const, source: 'claude' as const,
    };
    const provider = makeProvider([session]);
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    // Routes through _openSessionLocal; no matching tab → focuses the side panel.
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.sidebar.open');
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
    updatedAt: new Date(), status: 'idle' as const, source: 'claude' as const,
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
  const session = {
    sessionId: 'sess-1', projectPath: '/p', projectName: 'p', title: 'My Session',
    updatedAt: new Date(), status: 'idle' as const, source: 'claude' as const,
  };

  beforeEach(() => {
    mockExecuteCommand.mockClear();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
    setOpenClaudeTabs([]);
  });
  afterEach(() => { setOpenClaudeTabs([]); });

  it('reveals in the editor when the session is an open editor tab', () => {
    setOpenClaudeTabs(['My Session']);
    const p = makeProvider([session]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });

  it('focuses the side panel when the session is not an open editor tab', () => {
    setOpenClaudeTabs([]);
    const p = makeProvider([session]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });
});

// ── Tests: _openNewSession ────────────────────────────────────────────────────
describe('_openNewSession', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  it('opens a fresh conversation in the current window editor', () => {
    const p = makeProvider() as unknown as { _openNewSession(): void };
    p._openNewSession();
    // primaryEditor.open with no sessionId creates a new conversation panel in
    // the active editor column — unlike newConversation, which only notifies
    // already-open panels and is a no-op when none exist.
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open');
  });
});

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

  it('calls bobChatView.focus for a Bob session', () => {
    const p = makeProvider([makeBobSession()]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('bob-sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('bobChatView.focus');
  });

  it('does NOT call claude-vscode commands for a Bob session', () => {
    const p = makeProvider([makeBobSession()]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('bob-sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', expect.anything());
  });
});

// ── Tests: newBobSession ──────────────────────────────────────────────────────
describe('webview message: newBobSession', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  function resolveWebview(provider: import('../SessionSwitcherViewProvider').SessionSwitcherViewProvider) {
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
    return (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
  }

  it('calls bob-code.task.pickWorkspace', async () => {
    const handler = resolveWebview(makeProvider());
    await handler({ type: 'newBobSession' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('bob-code.task.pickWorkspace');
  });
});

// ── Tests: addFromHistory (Bob) ───────────────────────────────────────────────
describe('webview message: addFromHistory (Bob)', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  function resolveWebview(provider: import('../SessionSwitcherViewProvider').SessionSwitcherViewProvider) {
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
    return (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
  }

  it('calls bobChatView.focus for a Bob history session', async () => {
    const bobSession = makeBobSession({ sessionId: 'bob-hist-1' });
    const handler = resolveWebview(makeProvider([bobSession]));
    await handler({ type: 'addFromHistory', sessionId: 'bob-hist-1' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('bobChatView.focus');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', expect.anything());
  });

  it('calls claude-vscode.primaryEditor.open for a Claude history session', async () => {
    const claudeSession = {
      sessionId: 'claude-hist-1', projectPath: '/p', projectName: 'p',
      title: 'Claude task', updatedAt: new Date(), status: 'idle' as const, source: 'claude' as const,
    };
    const handler = resolveWebview(makeProvider([claudeSession]));
    await handler({ type: 'addFromHistory', sessionId: 'claude-hist-1' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'claude-hist-1');
  });
});

// ── Tests: idle Bob session with open tab appears in Sessions, not History ────
describe('Bob open tab surfacing (_pushSessions / _pushHistory)', () => {
  afterEach(() => { setOpenBobTabs([]); });

  function resolveWebviewCapturing(provider: import('../SessionSwitcherViewProvider').SessionSwitcherViewProvider) {
    const postMessage = vi.fn();
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage,
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
    return postMessage;
  }

  it('surfaces an idle-and-old Bob session in Sessions when its tab is open, and keeps it out of History', async () => {
    // Idle Bob task last updated well outside the 2-hour recency window.
    const oldIdleBob = makeBobSession({
      sessionId: 'bob-old-idle',
      title: 'Old Bob task',
      status: 'idle',
      updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    setOpenBobTabs(['Old Bob task']);

    const provider = makeProvider([oldIdleBob]);
    const postMessage = resolveWebviewCapturing(provider);
    const priv = provider as unknown as {
      _pushSessions(): Promise<void>;
      _pushHistory(): Promise<void>;
    };
    await priv._pushSessions();
    await priv._pushHistory();

    const sessionsMsg = postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions: import('../SessionManager').ClaudeSession[] })
      .find(m => m.type === 'updateSessions');
    const historyMsg = postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions: import('../SessionManager').ClaudeSession[] })
      .find(m => m.type === 'updateHistory');

    expect(sessionsMsg?.sessions.map(s => s.sessionId)).toContain('bob-old-idle');
    expect(historyMsg?.sessions.map(s => s.sessionId)).not.toContain('bob-old-idle');
  });

  it('leaves an idle-and-old Bob session out of Sessions when no tab is open (unchanged behavior)', async () => {
    const oldIdleBob = makeBobSession({
      sessionId: 'bob-old-idle',
      title: 'Old Bob task',
      status: 'idle',
      updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    setOpenBobTabs([]);

    const provider = makeProvider([oldIdleBob]);
    const postMessage = resolveWebviewCapturing(provider);
    const priv = provider as unknown as {
      _pushSessions(): Promise<void>;
      _pushHistory(): Promise<void>;
    };
    await priv._pushSessions();
    await priv._pushHistory();

    const sessionsMsg = postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions: import('../SessionManager').ClaudeSession[] })
      .find(m => m.type === 'updateSessions');
    const historyMsg = postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions: import('../SessionManager').ClaudeSession[] })
      .find(m => m.type === 'updateHistory');

    expect(sessionsMsg?.sessions.map(s => s.sessionId)).not.toContain('bob-old-idle');
    expect(historyMsg?.sessions.map(s => s.sessionId)).toContain('bob-old-idle');
  });
});

