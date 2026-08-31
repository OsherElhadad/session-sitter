import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession, MessageExchange } from './SessionManager';
import { readLiveWindows, writeWindowEntry, removeWindowEntry, discoverOwnIpcSocket, detectIdeCli, type WindowEntry } from './WindowRegistry';
import { getOpenBobTaskIds } from './agents/BobInspector';
import { getOpenClaudeSessionIds } from './agents/ClaudeInspector';
import { BUILD_TIME, BUILD_VERSION } from './buildInfo';
import { SupervisionActivity, type ActivityItem } from './SupervisionActivity';
import { uploadSession } from './corpus/upload';

// The Sessions view is a live worklist: only sessions the user can currently act on.
// Everything else goes to History. Both partitions stay sorted by recency and capped.
const SESSIONS_LIMIT = 20;
const HISTORY_LIMIT = 50;

// Sources that expose no live-process signal at all (no extension host to ask). For those,
// recency is the only available proxy for "you are working in this right now" — see
// `_partitionSessions`. Named and configurable rather than hidden.
const PROBELESS_SOURCES: ReadonlySet<string> = new Set(['codex', 'chat']);
const DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES = 120;

// How long a non-idle status alone keeps a Claude/Bob session in the worklist when no probe
// reports it open. The fallback exists to survive a momentary probe failure (a WSL2 /
// inspector hiccup), so it only needs to outlast the hiccup — not the session. Without a
// bound, one abandoned mid-turn transcript sits in the worklist forever, because its status
// is read from a file that will never change again.
const STALE_FALLBACK_WINDOW_MS = 120 * 60_000;

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export class SessionSitterViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sessionSitter.view';

  private _view?: vscode.WebviewView;
  private _viewDisposables: vscode.Disposable[] = [];
  private _historyOpen = false;
  private _focusWatcher: vscode.Disposable | undefined;
  private _registryTimer: ReturnType<typeof setInterval> | undefined;
  private _activity: SupervisionActivity | undefined;
  private _lastActivity: ActivityItem[] = [];
  private readonly _recordsDir: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
    private readonly _log: (msg: string) => void = () => { /* no-op */ },
    stateDir = '',
  ) {
    this._recordsDir = stateDir ? path.join(stateDir, 'records') : '';
    this._focusWatcher = this._startFocusRequestWatcher();
    void this._publishWindowEntry();
    this._registryTimer = setInterval(() => { void this._publishWindowEntry(); }, 60_000);

    // Observability feed: mirror the supervisor's decisions (records/) into the panel.
    if (stateDir) {
      this._activity = new SupervisionActivity(stateDir, items => {
        this._lastActivity = items;
        void this._view?.webview.postMessage({ type: 'updateActivity', items });
      });
      this._activity.start();
    }
  }

  /**
   * Resolve a supervision record's JSON path from its requestId (records live at
   * `<stateDir>/records/<requestId>.json`). Returns '' when no state dir is configured or the id
   * is malformed — the requestId must match the store's `req-<hex>` shape, so a value coming
   * from the webview can never escape the records directory.
   */
  private _supervisionRecordPath(requestId: string | undefined): string {
    if (!this._recordsDir || !requestId || !/^req-[A-Za-z0-9]+$/.test(requestId)) { return ''; }
    return path.join(this._recordsDir, `${requestId}.json`);
  }

  // Publish this window's identity + IPC socket so other windows can focus it.
  private async _publishWindowEntry(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    await writeWindowEntry({
      pid: process.pid,
      workspaceFolders: folders,
      ideCli: detectIdeCli(undefined, vscode.env.appName),
      ipcSocket: discoverOwnIpcSocket() ?? process.env.VSCODE_IPC_HOOK_CLI ?? '',
      openBobTaskIds: await getOpenBobTaskIds(this._log),
      openClaudeSessionIds: (await getOpenClaudeSessionIds(this._log)).open,
      updatedAt: Date.now(),
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Refresh when session file metadata changes (status, titles)
    this._viewDisposables.push(
      this._sessionManager.onDidChangeSessions(() => {
        void this._pushSessions();
        if (this._historyOpen) { void this._pushHistory(); }
      })
    );

    // Refresh when Claude Code tabs open, close, or get renamed (tabGroups API added in VS Code 1.65)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { onDidChangeTabs: vscode.Event<unknown> } | undefined;
    if (tabGroups) {
      this._viewDisposables.push(
        tabGroups.onDidChangeTabs(() => {
          void this._pushSessions();
          if (this._historyOpen) { void this._pushHistory(); }
        })
      );
    }

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async message => {
        switch (message.type) {
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._tryFocusForeignWindow(sessionId).then(result => {
              if (result === 'local') {
                void this._openSessionLocal(sessionId);
              } else if (result === 'foreign-failed') {
                void vscode.window.showWarningMessage('Could not switch to the window containing this session.');
              }
            });
            break;
          }
          case 'newSession': {
            this._openNewSession();
            break;
          }
          case 'newBobSession': {
            void vscode.commands.executeCommand('bob-code.task.pickWorkspace');
            break;
          }
          case 'removeTab': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            this._closeTabForSession(sessionId);
            break;
          }
          case 'loadHistory': {
            this._historyOpen = true;
            void this._pushHistory();
            break;
          }
          case 'closeHistory': {
            this._historyOpen = false;
            break;
          }
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            const allSessions = this._sessionManager.getSessions();
            const histSession = allSessions.find(s => s.sessionId === sessionId);
            if (histSession?.source === 'bob') {
              void vscode.commands.executeCommand('bobChatView.focus');
            } else if (histSession?.source === 'codex') {
              void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
            } else if (histSession?.source === 'chat') {
              void vscode.commands.executeCommand('workbench.action.chat.open');
            } else {
              // Same rule as switching: a history row can still be live in this window
              // (the side bar especially), so focus it there rather than duplicating it.
              await this._openClaudeSessionLocal(sessionId);
            }
            break;
          }
          case 'ready': {
            void this._pushSessions();
            if (this._lastActivity.length) {
              void this._view?.webview.postMessage({
                type: 'updateActivity', items: this._lastActivity,
              });
            }
            this._activity?.pushNow();
            break;
          }
          case 'getSessionPreview': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId || !this._view) { break; }
            const exchanges: MessageExchange[] = await this._sessionManager.getRecentExchanges(sessionId);
            const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
            void this._view.webview.postMessage({
              type: 'sessionPreview',
              sessionId,
              projectPath: session?.projectPath ?? '',
              exchanges,
            });
            break;
          }
          case 'openSettings': {
            // `query` jumps straight to one group of settings. With none, defer to the
            // `sessionSitter.openSettings` command, which owns the "all of them" filter.
            const query = message.query as string | undefined;
            if (query) {
              void vscode.commands.executeCommand('workbench.action.openSettings', query);
            } else {
              void vscode.commands.executeCommand('sessionSitter.openSettings');
            }
            break;
          }
          case 'loadActivity': {
            this._activity?.pushNow();
            break;
          }
          case 'openSupervisionRecord': {
            const recordPath = this._supervisionRecordPath(message.requestId as string | undefined);
            if (!recordPath) { break; }
            void vscode.workspace.openTextDocument(vscode.Uri.file(recordPath)).then(
              doc => vscode.window.showTextDocument(doc),
              () => vscode.window.showWarningMessage(`Supervision record not found: ${recordPath}`),
            );
            break;
          }
          case 'copySupervisionRecordPath': {
            const recordPath = this._supervisionRecordPath(message.requestId as string | undefined);
            if (!recordPath) { break; }
            void vscode.env.clipboard.writeText(recordPath);
            break;
          }
          case 'uploadToCorpus': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._uploadSessionToCorpus(sessionId);
            break;
          }
          case 'copyToClipboard': {
            const text = message.text as string | undefined;
            if (typeof text === 'string') {
              void vscode.env.clipboard.writeText(text);
            }
            break;
          }
          case 'copyTranscriptToEditor': {
            const sid = message.sessionId as string | undefined;
            if (!sid) { break; }
            void (async () => {
              const md = await this._sessionManager.exportFullTranscript(sid);
              if (md === null) {
                void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
                return;
              }
              const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
              await vscode.window.showTextDocument(doc);
            })();
            break;
          }
          case 'copyTranscriptToClipboard': {
            const sid = message.sessionId as string | undefined;
            if (!sid) { break; }
            void (async () => {
              const md = await this._sessionManager.exportFullTranscript(sid);
              if (md === null) {
                void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
                return;
              }
              await vscode.env.clipboard.writeText(md);
              const bytes = Buffer.byteLength(md, 'utf8');
              vscode.window.setStatusBarMessage(
                `Transcript copied — ${(bytes / 1024).toFixed(1)} KB`,
                4000,
              );
            })();
            break;
          }
          case 'copyTranscriptToFile': {
            const sid = message.sessionId as string | undefined;
            if (!sid) { break; }
            void (async () => {
              const md = await this._sessionManager.exportFullTranscript(sid);
              if (md === null) {
                void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
                return;
              }
              const tmpPath = path.join(os.tmpdir(), `transcript-${sid}.md`);
              await fs.promises.writeFile(tmpPath, md, 'utf8');
              const pick = await vscode.window.showInformationMessage(
                `Transcript saved: ${tmpPath}`,
                'Reveal in Finder',
              );
              if (pick === 'Reveal in Finder') {
                void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(tmpPath));
              }
            })();
            break;
          }
        }
      })
    );

    this._viewDisposables.push(
      vscode.window.onDidChangeWindowState(() => { void this._publishWindowEntry(); })
    );

    this._viewDisposables.push(
      webviewView.onDidDispose(() => { this._view = undefined; })
    );

    void this._pushSessions();
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
    this._focusWatcher?.dispose();
    if (this._registryTimer) { clearInterval(this._registryTimer); }
    this._activity?.dispose();
    void removeWindowEntry(process.pid);
  }

  // Open a brand-new Claude conversation in the current window's editor.
  // `primaryEditor.open` with no sessionId creates a fresh panel in the active
  // editor column. We do NOT use `claude-vscode.newConversation` here: it only
  // notifies already-open Claude panels and is a no-op when none exist.
  private _openNewSession(): void {
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
  }

  // Reveal a session in the current window, in the place it is ALREADY open.
  private async _openSessionLocal(sessionId: string): Promise<void> {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }

    if (session.source === 'bob') {
      void vscode.commands.executeCommand('bobChatView.focus');
      return;
    }

    if (session.source === 'codex') {
      void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
      return;
    }

    if (session.source === 'chat') {
      void vscode.commands.executeCommand('workbench.action.chat.open');
      return;
    }

    await this._openClaudeSessionLocal(sessionId);
  }

  /**
   * Focus a Claude session where it already lives, instead of opening a duplicate.
   *
   * `primaryEditor.open` is not a "focus" command — it calls Claude's `createPanel`,
   * which reveals an existing panel ONLY when `sessionPanels` holds the session id, and
   * otherwise creates a brand-new editor panel. A session living in the side bar is never
   * in `sessionPanels`, so calling it unconditionally spawned a second view of a session
   * that was already on screen. Hence the three-way split:
   *
   *  1. **Open as an editor panel** (`panels` holds the id) — `primaryEditor.open` is
   *     exactly right here: it reveals that panel in whatever editor group it sits in and
   *     creates nothing. This is also Claude's own definition of "open": it broadcasts
   *     `sessionPanels.keys()` to its UI as `openSessionIds`.
   *  2. **Held by this window but not an editor panel, while the user's Claude layout is
   *     the side bar** — then the side bar is where it is showing, so focus that.
   *     `claude-vscode.sidebar.open` is the extension's own entry point and picks
   *     `claudeVSCodeSidebarSecondary` or `claudeVSCodeSidebar` per host support.
   *  3. **Anything else** (a closed or older session, or panel layout) — open it by id,
   *     which reopens the conversation. Pre-existing behaviour, unchanged.
   *
   * Known limit: Claude exposes no per-session side bar API and does not track which
   * session the side bar is showing — `sessionStates` accumulates, and the side bar's
   * session-change reports are discarded by its manager. So in case 2 we can focus the
   * side bar but not force it to a specific session. That still beats opening a duplicate
   * panel, and it matches what Claude's own `editor.openLast` does.
   */
  private async _openClaudeSessionLocal(sessionId: string): Promise<void> {
    const state = await getOpenClaudeSessionIds(this._log);

    if (state.panels.includes(sessionId)) {
      this._log(`switch: ${sessionId} is an open editor panel — revealing it`);
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
      return;
    }

    if (state.states.includes(sessionId) && this._claudePrefersSidebar()) {
      this._log(`switch: ${sessionId} is held by this window in side bar layout — focusing the side bar`);
      void vscode.commands.executeCommand('claude-vscode.sidebar.open');
      return;
    }

    this._log(`switch: ${sessionId} has no open view here — opening it by id`);
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  }

  /**
   * Whether Claude is configured to open conversations in the side bar.
   *
   * `claudeCode.preferredLocation` ('sidebar' | 'panel', default 'panel') is a normal
   * setting, so we read it directly — no inspector needed. Claude keeps it current on its
   * own: `sidebar.open` writes 'sidebar' and `editor.open` writes 'panel', so it tracks
   * where the user last opened Claude. We mirror Claude's own comparison, where anything
   * that is not exactly 'sidebar' means panel.
   */
  private _claudePrefersSidebar(): boolean {
    return vscode.workspace.getConfiguration('claudeCode').get<string>('preferredLocation') === 'sidebar';
  }

  // Returns labels of all currently open Claude Code or Bob editor tabs.
  // Uses duck-typing (not instanceof) so it works from both the local and
  // remote extension hosts.
  private _openClaudeTabLabels(): Set<string> {
    const labels = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[] } | undefined;
    if (!tabGroups) { return labels; }
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        // Duck-type: Claude Code panels have 'claudeVSCodePanel', Bob panels have 'bobChatView'
        const input = tab.input as { viewType?: string } | null | undefined;
        if (input?.viewType?.includes('claudeVSCodePanel') ||
            input?.viewType?.includes('bobChatView')) {
          labels.add(tab.label);
        }
      }
    }
    return labels;
  }

  private _sortedByRecency(): ClaudeSession[] {
    return [...this._sessionManager.getSessions()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /** How long a probeless session (Codex / VS Code Chat) counts as active. */
  private _probelessWindowMs(): number {
    const minutes = vscode.workspace.getConfiguration('sessionSitter')
      .get<number>('probelessActiveWindowMinutes', DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES);
    const safe = typeof minutes === 'number' && minutes >= 0
      ? minutes : DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES;
    return safe * 60_000;
  }

  /**
   * Split sessions into the active worklist vs everything else (History).
   *
   * Active means a session the user can act on right now. How that is decided depends on what
   * the source can actually tell us:
   *
   *  - **Bob / Claude** — their extension hosts hold the truth. Bob reports its open task ids
   *    from the live `TaskManager`; Claude reports its open session ids from its manager. We
   *    read this window fresh and union it with what other live windows published to the
   *    registry, so the answer is cross-window. A session is also treated as active when its
   *    status is not idle, so one you are actively in still shows up if the probe is
   *    momentarily silent (a WSL2 / inspector hiccup) — but only while it is recent, see
   *    `STALE_FALLBACK_WINDOW_MS`. A live report from a probe is authoritative at any age.
   *  - **Codex / VS Code Chat** — no extension host to ask, no liveness signal of any kind.
   *    Recency is the only honest proxy, so they count as active while updated within
   *    `sessionSitter.probelessActiveWindowMinutes`.
   *
   * Both partitions stay sorted by recency.
   */
  private async _partitionSessions(): Promise<{ active: ClaudeSession[]; history: ClaudeSession[] }> {
    const localClaude = await getOpenClaudeSessionIds(this._log);
    const localBobIds = await getOpenBobTaskIds(this._log);
    const windows = await readLiveWindows();
    const claudeOpenIds = new Set<string>([
      ...localClaude.open,
      ...windows.flatMap(w => w.openClaudeSessionIds ?? []),
    ]);
    const bobOpenIds = new Set<string>([
      ...localBobIds,
      ...windows.flatMap(w => w.openBobTaskIds ?? []),
    ]);
    const cutoff = Date.now() - this._probelessWindowMs();

    const isActive = (s: ClaudeSession): boolean => {
      if (PROBELESS_SOURCES.has(s.source)) { return s.updatedAt.getTime() >= cutoff; }
      const reportedOpen = s.source === 'bob'
        ? bobOpenIds.has(s.sessionId)
        : claudeOpenIds.has(s.sessionId);
      if (reportedOpen) { return true; }
      // Non-idle status is a fallback, not a live signal — it must not outlive its window.
      return s.status !== 'idle'
        && s.updatedAt.getTime() >= Date.now() - STALE_FALLBACK_WINDOW_MS;
    };

    const all = this._sortedByRecency();
    return { active: all.filter(isActive), history: all.filter(s => !isActive(s)) };
  }

  private async _pushSessions(): Promise<void> {
    if (!this._view) { return; }
    const { active } = await this._partitionSessions();
    void this._view.webview.postMessage({
      type: 'updateSessions', sessions: active.slice(0, SESSIONS_LIMIT),
    });
  }

  private async _pushHistory(): Promise<void> {
    if (!this._view) { return; }
    const { history } = await this._partitionSessions();
    void this._view.webview.postMessage({
      type: 'updateHistory', sessions: history.slice(0, HISTORY_LIMIT),
    });
  }

  // Close the Claude Code editor tab whose label matches the session's title.
  private _closeTabForSession(sessionId: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[]; close(tab: unknown): unknown } | undefined;
    if (!tabGroups) { return; }
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { viewType?: string } | null | undefined;
        if (input?.viewType?.includes('claudeVSCodePanel') && tab.label === session.title) {
          void tabGroups.close(tab);
          return;
        }
      }
    }
  }

  // Called when a focus-<pid>.json file is created/changed in the session-sitter dir.
  // Reads the request, checks freshness, calls primaryEditor.open, and deletes the file.
  async _handleFocusRequest(uri: { fsPath: string }): Promise<void> {
    try {
      const raw = await fs.promises.readFile(uri.fsPath, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: unknown; requestedAt?: unknown };
      if (typeof data.sessionId !== 'string' || typeof data.requestedAt !== 'number') { return; }
      if (Date.now() - data.requestedAt > 10_000) { return; }
      await this._openSessionLocal(data.sessionId);
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

  // Find the live registry entry for a different window whose workspace owns the
  // session's project. Returns null when the session belongs to this window (local)
  // or has no live owner.
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

  /** The corpus repo root the uploader writes into (`sessionSitter.dataRepoPath`). */
  private _corpusRepoRoot(): string {
    return (vscode.workspace.getConfiguration('sessionSitter')
      .get<string>('dataRepoPath') ?? '').trim();
  }

  /**
   * Upload one session to the corpus repository, in-process. This used to shell out to
   * `upload_session.py`; the uploader is TypeScript now, so there is no subprocess and no
   * Python involved.
   */
  private async _uploadSessionToCorpus(sessionId: string): Promise<void> {
    const repoRoot = this._corpusRepoRoot();
    if (!repoRoot || !fs.existsSync(repoRoot)) {
      void vscode.window.showErrorMessage(
        'Set `sessionSitter.dataRepoPath` to your corpus repository before uploading sessions.');
      return;
    }

    const exported = await this._sessionManager.exportSessionAsJson(sessionId);
    if (!exported) {
      void vscode.window.showErrorMessage('corpus: could not resolve session file.');
      return;
    }

    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    const source = session?.source ?? 'other';
    const slug = this._slugify(session?.title ?? sessionId);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Uploading session to the corpus…',
        cancellable: false,
      },
      async () => {
        try {
          const result = await uploadSession({
            repoRoot,
            sessionFile: exported.filePath,
            source,
            slug,
            log: msg => this._log(`[corpus upload] ${msg}`),
          });
          void vscode.window.showInformationMessage(
            `Session uploaded ✓ — ${result.storedName}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Upload failed — ${message}`);
        } finally {
          exported.cleanup();
        }
      },
    );
  }
  private _slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'session'
    );
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const mainScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'main.js')
    );
    const menuScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'toolbarMenu.js')
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles.css')
    );
    const nonce = getNonce();

    const buildDisplay = BUILD_TIME.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Session Sitter</title>
</head>
<body>
  <div id="tab-bar">
    <div id="toolbar">
      <button id="menu-btn" title="Menu">&#x2630;</button>
      <button id="new-session-btn" title="New Claude Session">+</button>
      <button id="new-bob-session-btn" title="New Bob Session">+B</button>
    </div>
    <div id="tab-strip" role="tablist" aria-label="Claude Sessions"></div>
    <button id="history-toggle" aria-expanded="false">History &#x25B6;</button>
    <div id="history-panel" hidden></div>
    <button id="activity-toggle" aria-expanded="true">Supervision activity &#x25BC;</button>
    <div id="activity-panel"></div>
  </div>
  <div id="about-box" hidden>
    <div class="about-name">Session Sitter</div>
    <div class="about-version">v${BUILD_VERSION}</div>
    <div class="about-built">Built ${buildDisplay}</div>
    <button id="about-close">Close</button>
  </div>
  <div id="session-preview" hidden></div>
  <script nonce="${nonce}" src="${menuScriptUri}"></script>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
