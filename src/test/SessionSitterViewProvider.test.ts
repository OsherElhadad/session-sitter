import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── VS Code stub ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before variable declarations, so mock fns must
// be created with vi.hoisted() to be accessible inside the factory.
const {
  mockExecuteCommand,
  mockShowWarningMessage,
  mockGetConfiguration,
  mockOpenTextDocument,
  mockShowTextDocument,
  mockSetStatusBarMessage,
  mockShowInformationMessage,
  mockClipboardWriteText,
} = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockGetConfiguration: vi.fn((): { get: (key?: string, fallback?: unknown) => unknown } => ({ get: () => 'panel' })),
  mockOpenTextDocument: vi.fn().mockResolvedValue({ uri: 'doc://untitled' }),
  mockShowTextDocument: vi.fn().mockResolvedValue(undefined),
  mockSetStatusBarMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  mockShowInformationMessage: vi.fn().mockResolvedValue(undefined),
  mockClipboardWriteText: vi.fn().mockResolvedValue(undefined),
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
      openTextDocument: mockOpenTextDocument,
    },
    window: {
      tabGroups: { all: [], onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
      showWarningMessage: mockShowWarningMessage,
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      showTextDocument: mockShowTextDocument,
      setStatusBarMessage: mockSetStatusBarMessage,
      showInformationMessage: mockShowInformationMessage,
    },
    env: {
      appName: 'IBM Bob',
      clipboard: { writeText: mockClipboardWriteText },
    },
    commands: { executeCommand: mockExecuteCommand },
    // The open-session probes reach the agents' extension hosts through vscode.extensions.
    // With none present they report nothing open, which is what these tests want.
    extensions: { getExtension: vi.fn(() => undefined), all: [] },
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

// ── ClaudeInspector stub ─────────────────────────────────────────────────────
// The real probe reaches Claude's live extension host over the V8 inspector, which
// does not exist under test. Stubbing it lets us state exactly WHERE a session is
// open — as an editor panel, or held by the window with no panel (the side bar).
const { mockGetOpenClaudeSessionIds } = vi.hoisted(() => ({
  mockGetOpenClaudeSessionIds: vi.fn(),
}));
vi.mock('../agents/ClaudeInspector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/ClaudeInspector')>();
  return { ...actual, getOpenClaudeSessionIds: mockGetOpenClaudeSessionIds };
});

/** Point the stubbed probe at a given layout. Defaults to "this window holds nothing". */
function setClaudeOpenState(state: { panels?: string[]; states?: string[]; active?: string | null }): void {
  const panels = state.panels ?? [];
  const states = state.states ?? [];
  mockGetOpenClaudeSessionIds.mockResolvedValue({
    open: [...new Set([...panels, ...states])],
    panels,
    states,
    active: state.active ?? null,
  });
}

/** Set Claude's `claudeCode.preferredLocation` as the extension would read it. */
function setClaudePreferredLocation(location: 'sidebar' | 'panel'): void {
  mockGetConfiguration.mockImplementation((section?: string) => ({
    get: (key?: string, fallback?: unknown) => {
      if (section === 'claudeCode' && key === 'preferredLocation') { return location; }
      return fallback;
    },
  }));
}

// ── child_process stub ─────────────────────────────────────────────────────────
vi.mock('child_process', () => ({ execFile: vi.fn() }));

import * as vscode from 'vscode';
import { SessionSitterViewProvider } from '../SessionSitterViewProvider';
import { SessionManager } from '../SessionManager';
import { execFile } from 'child_process';

// Set the Claude editor tabs the mocked tabGroups API reports as open.
function setOpenClaudeTabs(labels: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).tabGroups.all = [{
    tabs: labels.map(label => ({ input: { viewType: 'claudeVSCodePanel' }, label })),
  }];
}

function makeProvider(
  sessions: import('../SessionManager').ClaudeSession[] = [],
  extra: Partial<Record<string, unknown>> = {},
) {
  const mockManager = {
    getSessions: vi.fn().mockReturnValue(sessions),
    onDidChangeSessions: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    dispose: vi.fn(),
    ...extra,
  } as unknown as SessionManager;
  return new SessionSitterViewProvider(
    { fsPath: '/fake' } as unknown as import('vscode').Uri,
    mockManager,
  );
}

// Every test starts from "this window holds no Claude session, panel layout", so the
// tests that care about location opt in explicitly and cannot leak into each other.
beforeEach(() => {
  setClaudeOpenState({});
  mockGetConfiguration.mockImplementation(() => ({ get: () => 'panel' }));
});

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

    // Routes through _openSessionLocal, which opens the session by id.
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'claude-vscode.primaryEditor.open', 'abc-123');
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

  type Openable = { _openSessionLocal(id: string): Promise<void> };

  beforeEach(() => {
    mockExecuteCommand.mockClear();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
    setOpenClaudeTabs([]);
    setClaudeOpenState({});
    setClaudePreferredLocation('panel');
  });
  afterEach(() => {
    setOpenClaudeTabs([]);
    mockGetConfiguration.mockImplementation(() => ({ get: () => 'panel' }));
  });

  it('reveals the existing editor panel when the session is open as one', async () => {
    // `primaryEditor.open` with an id that IS in Claude's sessionPanels reveals that
    // panel in place — createPanel returns early and creates nothing.
    setClaudeOpenState({ panels: ['sess-1'], states: ['sess-1'] });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });

  it('focuses the side bar for a live session that has no editor panel, in side bar layout', async () => {
    // The reported bug: the session is live in the secondary side bar, so it is held by
    // the window but absent from sessionPanels. Opening it "by id" made Claude create a
    // SECOND view of a session already on screen. It must focus the side bar instead.
    setClaudeOpenState({ panels: [], states: ['sess-1'] });
    setClaudePreferredLocation('sidebar');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.sidebar.open');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });

  it('prefers the editor panel over the side bar when the session has both', async () => {
    // A panel is an unambiguous, per-session target; the side bar is not. Panel wins.
    setClaudeOpenState({ panels: ['sess-1'], states: ['sess-1'] });
    setClaudePreferredLocation('sidebar');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });

  it('opens by id in panel layout even when the window holds the session', async () => {
    // Panel layout means conversations live in editor panels, so there is no side bar
    // view to focus — open it by id.
    setClaudeOpenState({ panels: [], states: ['sess-1'] });
    setClaudePreferredLocation('panel');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });

  it('opens a closed session by id rather than focusing the side bar', async () => {
    // Not in panels and not held by this window at all: nothing to focus. Reopen by id.
    // Regression guard for the old `sidebar.open` fallback, which did not target a
    // specific session, so a closed session appeared to "not be found".
    setClaudeOpenState({ panels: [], states: [] });
    setClaudePreferredLocation('sidebar');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });

  it('falls back to opening by id when the probe cannot reach Claude', async () => {
    // Probe failure reports an empty state. Degrade to the old behaviour rather than
    // silently doing nothing.
    mockGetOpenClaudeSessionIds.mockResolvedValue({
      open: [], panels: [], states: [], active: null, diag: 'gB-not-found',
    });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
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

  function resolveWebview(provider: import('../SessionSitterViewProvider').SessionSitterViewProvider) {
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

  function resolveWebview(provider: import('../SessionSitterViewProvider').SessionSitterViewProvider) {
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

// ── Tests: latest-sessions-by-activity view (_pushSessions / _pushHistory) ────
// The Sessions view is a live worklist, not a recency slice: only sessions the user can act on
// right now. Bob/Claude are judged by what their extension hosts report as open (unioned across
// windows) plus a not-idle status; Codex and VS Code Chat have no such signal, so they fall back
// to a recency window. Everything else is History.
describe('Sessions view: active-vs-history partition', () => {
  function resolveWebviewCapturing(provider: import('../SessionSitterViewProvider').SessionSitterViewProvider) {
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

  function makeSession(
    sessionId: string,
    minutesAgo: number,
    source: 'claude' | 'bob' | 'codex' | 'chat' = 'claude',
    status: 'active' | 'waiting' | 'idle' = 'idle',
  ): import('../SessionManager').ClaudeSession {
    return {
      sessionId,
      projectPath: '/p',
      projectName: 'p',
      title: `t-${sessionId}`,
      updatedAt: new Date(Date.now() - minutesAgo * 60 * 1000),
      status,
      source,
    };
  }

  function capture(postMessage: ReturnType<typeof vi.fn>, type: 'updateSessions' | 'updateHistory') {
    return postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions: import('../SessionManager').ClaudeSession[] })
      .find(m => m.type === type);
  }

  beforeEach(() => {
    // Each push partitions independently, so the registry is read more than once per test.
    mockReadLiveWindows.mockResolvedValue([]);
  });

  it('keeps a Bob task the IDE reports open, and files the rest under History', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: 42, workspaceFolders: [], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now(),
        openBobTaskIds: ['b-open'] },
    ]);
    const all = [
      makeSession('b-open', 90, 'bob'),
      makeSession('b-closed', 1, 'bob'),
    ];
    const provider = makeProvider(all);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    // Recency does NOT decide membership: the older-but-open task is the active one.
    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId)).toEqual(['b-open']);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId)).toEqual(['b-closed']);
  });

  it('unions open ids across windows so another window\'s session still counts', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: 1, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-elsewhere'] },
    ]);
    const provider = makeProvider([makeSession('c-elsewhere', 30, 'claude')]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-elsewhere']);
  });

  it('treats a non-idle session as active even when no probe reports it open', async () => {
    // Fallback for a WSL2 / inspector hiccup: a task that is running or waiting on you must not
    // vanish into History just because the live probe was momentarily silent.
    const provider = makeProvider([
      makeSession('b-running', 60, 'bob', 'active'),
      makeSession('b-idle', 5, 'bob', 'idle'),
    ]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['b-running']);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['b-idle']);
  });

  it('ages a stale non-idle session into History', async () => {
    // The non-idle fallback covers a momentary probe hiccup, not a session abandoned weeks ago.
    // A month-old transcript has no live process behind it whatever its inferred status says.
    const provider = makeProvider([
      makeSession('c-stale-waiting', 60 * 24 * 29, 'claude', 'waiting'),
      makeSession('c-stale-active', 60 * 24 * 3, 'claude', 'active'),
    ]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions).toHaveLength(0);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['c-stale-active', 'c-stale-waiting']);
  });

  it('keeps a stale session active when a probe still reports it open', async () => {
    // The age bound only gates the fallback. A live report is authoritative at any age.
    mockReadLiveWindows.mockResolvedValue([
      { pid: 3, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-old-but-open'] },
    ]);
    const provider = makeProvider([makeSession('c-old-but-open', 60 * 24 * 29, 'claude', 'waiting')]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-old-but-open']);
  });

  it('keeps recent Codex/Chat sessions active and ages older ones into History', async () => {
    // Neither source exposes a liveness signal, so the recency window is the rule.
    const provider = makeProvider([
      makeSession('codex-fresh', 10, 'codex'),
      makeSession('chat-fresh', 20, 'chat'),
      makeSession('codex-stale', 60 * 5, 'codex'),
      makeSession('chat-stale', 60 * 9, 'chat'),
    ]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['codex-fresh', 'chat-fresh']);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['codex-stale', 'chat-stale']);
  });

  it('honors probelessActiveWindowMinutes = 0 by parking Codex/Chat in History', async () => {
    mockGetConfiguration.mockImplementation(() => ({ get: () => 0 }));
    try {
      const provider = makeProvider([makeSession('codex-fresh', 1, 'codex')]);
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
      await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

      expect(capture(postMessage, 'updateSessions')?.sessions).toHaveLength(0);
      expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
        .toEqual(['codex-fresh']);
    } finally {
      mockGetConfiguration.mockImplementation(() => ({ get: () => 'panel' }));
    }
  });

  it('sorts each partition by recency and caps them', async () => {
    // 30 open Bob tasks + 60 closed ones: Sessions caps at 20, History at 50, both newest first.
    const openIds = Array.from({ length: 30 }, (_, i) => `open-${i}`);
    mockReadLiveWindows.mockResolvedValue([
      { pid: 7, workspaceFolders: [], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now(),
        openBobTaskIds: openIds },
    ]);
    const all = [
      ...openIds.map((id, i) => makeSession(id, 30 - i, 'bob')),
      ...Array.from({ length: 60 }, (_, i) => makeSession(`closed-${i}`, 1000 - i, 'bob')),
    ];
    const provider = makeProvider(all);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    const sessions = capture(postMessage, 'updateSessions')?.sessions ?? [];
    expect(sessions).toHaveLength(20);
    expect(sessions.map(s => s.sessionId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `open-${29 - i}`));
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].updatedAt.getTime()).toBeGreaterThanOrEqual(
        sessions[i].updatedAt.getTime());
    }
  });

  it('caps History at 50 newest', async () => {
    const all = Array.from({ length: 75 }, (_, i) => makeSession(`s${i}`, 1000 - i, 'bob'));
    const provider = makeProvider(all);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    const sessions = capture(postMessage, 'updateHistory')?.sessions ?? [];
    expect(sessions).toHaveLength(50);
    expect(sessions[0].sessionId).toBe('s74'); // newest of the inactive set
  });

  // ── Peer windows count as live reporters ───────────────────────────────────
  //
  // `readLiveWindows` only ever sees this machine's registry, and its liveness test is
  // `process.kill`, which cannot say anything about a pid on another host. So a peer's session
  // could never be "reported open" and fell back to the status check — which an idle session at a
  // prompt fails. The result was a peer session that was pulled correctly and then filed under
  // History, looking to the user exactly like a session that was never found at all.
  //
  // The probe already resolves liveness on the owning machine (`kill -0` there, 24 h staleness),
  // so a peer window entry is as authoritative about its own machine as a local one is about this
  // one, and the two sets simply union.

  function peerSession(
    sessionId: string, minutesAgo: number, source: 'claude' | 'bob' = 'claude',
  ): import('../SessionManager').ClaudeSession {
    return { ...makeSession(sessionId, minutesAgo, source, 'idle'), peer: 'vpcuser@olap.ibm.com' };
  }

  it('keeps an idle peer session active when the peer window reports it open', async () => {
    const provider = makeProvider([peerSession('c-remote', 45)], {
      getPeerWindows: () => [{
        pid: 2881165, workspaceFolders: ['/home/vpcuser/proj'], ideCli: 'bobide',
        ipcSocket: '/run/user/1000/x.sock', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-remote'],
      }],
    });
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-remote']);
  });

  it('keeps an idle peer Bob task active when the peer window reports it open', async () => {
    const provider = makeProvider([peerSession('b-remote', 45, 'bob')], {
      getPeerWindows: () => [{
        pid: 99, workspaceFolders: ['/home/vpcuser/proj'], ideCli: 'bobide',
        ipcSocket: '', updatedAt: Date.now(), openBobTaskIds: ['b-remote'],
      }],
    });
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['b-remote']);
  });

  it('still files a peer session no peer window reports under History', async () => {
    // Union, not blanket promotion: a closed session on a peer is still history.
    const provider = makeProvider([peerSession('c-closed', 45)], {
      getPeerWindows: () => [{
        pid: 1, workspaceFolders: ['/home/vpcuser/proj'], ideCli: 'bobide',
        ipcSocket: '', updatedAt: Date.now(), openClaudeSessionIds: ['c-other'],
      }],
    });
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions ?? []).toEqual([]);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['c-closed']);
  });

  it('partitions normally for a manager with no peer support at all', async () => {
    // `getPeerWindows` is additive; a manager without it must behave exactly as before.
    mockReadLiveWindows.mockResolvedValue([
      { pid: 1, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-local'] },
    ]);
    const provider = makeProvider([makeSession('c-local', 30, 'claude')]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-local']);
  });
});

// ── Tests: copy transcript handlers ──────────────────────────────────────────
describe('webview message: copy transcript handlers', () => {
  beforeEach(() => {
    mockOpenTextDocument.mockClear();
    mockShowTextDocument.mockClear();
    mockClipboardWriteText.mockClear();
    mockSetStatusBarMessage.mockClear();
    mockShowInformationMessage.mockClear();
    mockShowWarningMessage.mockClear();
    mockExecuteCommand.mockClear();
  });

  function resolveWebview(provider: SessionSitterViewProvider) {
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

  it('copyTranscriptToEditor opens an untitled markdown document with the transcript', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue('# transcript\n\nbody'),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToEditor', sessionId: 'sess-1' });
    await vi.waitFor(() => expect(mockShowTextDocument).toHaveBeenCalled(), { timeout: 2000 });
    expect(mockOpenTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: '# transcript\n\nbody' });
  });

  it('copyTranscriptToClipboard writes to env.clipboard and shows a status message', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue('some transcript'),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToClipboard', sessionId: 'sess-1' });
    await vi.waitFor(() => expect(mockSetStatusBarMessage).toHaveBeenCalled(), { timeout: 2000 });
    expect(mockClipboardWriteText).toHaveBeenCalledWith('some transcript');
  });

  it('copyTranscriptToFile writes to os.tmpdir() and offers Reveal in Finder', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue('# on disk'),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToFile', sessionId: 'sess-1' });

    // Handler is fire-and-forget; poll until showInformationMessage lands
    // (the IIFE has to `await exportFullTranscript` then `await fs.writeFile`).
    await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalled(), { timeout: 2000 });

    const call = mockShowInformationMessage.mock.calls[0];
    expect(call[0]).toMatch(/Transcript saved/);
    expect(call).toContain('Reveal in Finder');

    const tmpPath = (call[0] as string).match(/\/[^\s]+\.md/)?.[0];
    expect(tmpPath).toBeTruthy();
    const content = await fs.promises.readFile(tmpPath!, 'utf8');
    expect(content).toBe('# on disk');
    await fs.promises.unlink(tmpPath!);
  });

  it('shows a warning toast when exportFullTranscript returns null (session gone)', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue(null),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToEditor', sessionId: 'gone' });
    await vi.waitFor(() => expect(mockShowWarningMessage).toHaveBeenCalled(), { timeout: 2000 });
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });
});

