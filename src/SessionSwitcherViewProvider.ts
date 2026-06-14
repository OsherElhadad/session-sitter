import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession } from './SessionManager';
import { LiveSessionRegistry } from './LiveSessionRegistry';

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
    private readonly _registry: LiveSessionRegistry,
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

    // Refresh tab metadata when session files change on disk.
    // Also push history so it updates automatically when the panel is open.
    this._viewDisposables.push(
      this._sessionManager.onDidChangeSessions(() => {
        this._pushSessions();
        if (this._historyOpen) {
          this._pushHistory();
        }
      })
    );

    // Rebuild tab list when the registry changes (add/remove)
    this._viewDisposables.push(
      this._registry.onDidChange(() => {
        this._pushSessions();
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
            this._registry.remove(sessionId);
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
            this._registry.add(sessionId);
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
      webviewView.onDidDispose(() => {
        this._view = undefined;
      })
    );

    this._pushSessions();
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
  }

  private _pushSessions(): void {
    if (!this._view) { return; }

    const ids = this._registry.getIds();
    const byId = new Map(this._sessionManager.getSessions().map(s => [s.sessionId, s]));

    const sessions: ClaudeSession[] = ids.map(id => {
      const found = byId.get(id);
      if (found) { return found; }
      // File not yet parseable (session just created) — show placeholder
      return {
        sessionId: id,
        projectName: '',
        projectPath: '',
        title: 'Starting…',
        updatedAt: new Date(),
        status: 'waiting' as const,
      };
    });

    void this._view.webview.postMessage({ type: 'updateSessions', sessions });
  }

  private _pushHistory(): void {
    if (!this._view) { return; }
    const registryIds = new Set(this._registry.getIds());
    const history = this._sessionManager.getSessions()
      .filter(s => !registryIds.has(s.sessionId))
      .slice(0, 50);
    void this._view.webview.postMessage({ type: 'updateHistory', sessions: history });
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
