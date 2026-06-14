import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession } from './SessionManager';

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export class SessionSwitcherViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'claudeSessionSwitcher.view';

  private _view?: vscode.WebviewView;
  private _viewDisposables: vscode.Disposable[] = [];
  private _historyOpen = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
  ) {}

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
        this._pushSessions();
        if (this._historyOpen) { this._pushHistory(); }
      })
    );

    // Refresh when Claude Code tabs open, close, or get renamed
    this._viewDisposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this._pushSessions();
        if (this._historyOpen) { this._pushHistory(); }
      })
    );

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(message => {
        switch (message.type) {
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            break;
          }
          case 'newSession': {
            void vscode.commands.executeCommand('claude-vscode.newConversation');
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
            this._pushHistory();
            break;
          }
          case 'closeHistory': {
            this._historyOpen = false;
            break;
          }
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            break;
          }
          case 'ready': {
            this._pushSessions();
            break;
          }
        }
      })
    );

    this._viewDisposables.push(
      webviewView.onDidDispose(() => { this._view = undefined; })
    );

    this._pushSessions();
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
  }

  // Returns labels of all currently open Claude Code editor tabs.
  private _openClaudeTabLabels(): Set<string> {
    const labels = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.includes('claudeVSCodePanel')
        ) {
          labels.add(tab.label);
        }
      }
    }
    return labels;
  }

  private _pushSessions(): void {
    if (!this._view) { return; }

    const allSessions = this._sessionManager.getSessions();
    const openLabels = this._openClaudeTabLabels();

    // Build a title → session map (most-recently-updated wins on collisions)
    const byTitle = new Map<string, ClaudeSession>();
    for (const s of allSessions) {
      const existing = byTitle.get(s.title);
      if (!existing || s.updatedAt > existing.updatedAt) {
        byTitle.set(s.title, s);
      }
    }

    // Main list = sessions whose title matches an open Claude Code tab.
    // Tabs still loading (label "Claude Code") are skipped — they appear
    // once Claude Code sets their AI-generated title.
    const sessions: ClaudeSession[] = [];
    for (const label of openLabels) {
      const session = byTitle.get(label);
      if (session) { sessions.push(session); }
    }
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    void this._view.webview.postMessage({ type: 'updateSessions', sessions });
  }

  private _pushHistory(): void {
    if (!this._view) { return; }
    const openLabels = this._openClaudeTabLabels();
    const history = this._sessionManager.getSessions()
      .filter(s => !openLabels.has(s.title))
      .slice(0, 50);
    void this._view.webview.postMessage({ type: 'updateHistory', sessions: history });
  }

  // Close the Claude Code editor tab whose label matches the session's title.
  private _closeTabForSession(sessionId: string): void {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.includes('claudeVSCodePanel') &&
          tab.label === session.title
        ) {
          void vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const mainScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'main.js')
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Claude Session Switcher</title>
</head>
<body>
  <div id="tab-bar">
    <button id="new-session-btn" title="New Session">+</button>
    <div id="tab-strip" role="tablist" aria-label="Claude Sessions"></div>
    <button id="history-toggle" aria-expanded="false">History &#x25B6;</button>
    <div id="history-panel" hidden></div>
  </div>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
