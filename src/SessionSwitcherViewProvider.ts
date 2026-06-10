import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession } from './SessionManager';

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export class SessionSwitcherViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'claudeSessionSwitcher.view';

  private _view?: vscode.WebviewView;
  private _removedSessionIds = new Set<string>();
  private _viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    // Dispose any listeners from a previous resolve
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Listen for session changes from SessionManager and push filtered updates
    this._viewDisposables.push(
      this._sessionManager.onDidChangeSessions(sessions => {
        this._pushSessions(sessions);
      })
    );

    // Handle messages from the webview
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(message => {
        switch (message.type) {
          case 'switchSession': {
            const sessionId = message.sessionId;
            if (typeof sessionId !== 'string' || sessionId.length === 0) { break; }
            const known = this._sessionManager.getSessions();
            if (!known.some(s => s.sessionId === sessionId)) { break; }
            void vscode.env.openExternal(
              vscode.Uri.parse('vscode://anthropic.claude-code/open?session=' + encodeURIComponent(sessionId))
            );
            break;
          }
          case 'newSession': {
            void vscode.commands.executeCommand('claude-vscode.newConversation');
            break;
          }
          case 'removeTab': {
            const sessionId = message.sessionId;
            if (typeof sessionId !== 'string' || sessionId.length === 0) { break; }
            this._removedSessionIds.add(sessionId);
            this._pushSessions(this._sessionManager.getSessions());
            break;
          }
        }
      })
    );

    // Clear _view when the webview is disposed
    this._viewDisposables.push(
      webviewView.onDidDispose(() => {
        this._view = undefined;
      })
    );

    // Immediately push the current session list
    const sessions = this._sessionManager.getSessions();
    this._pushSessions(sessions);
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
  }

  private _pushSessions(sessions: ClaudeSession[]): void {
    if (!this._view) {
      return;
    }
    const filtered = sessions.filter(s => !this._removedSessionIds.has(s.sessionId));
    void this._view.webview.postMessage({ type: 'updateSessions', sessions: filtered });
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
  </div>
  <div id="history-section">
    <button id="history-toggle" aria-expanded="false">
      <span class="history-arrow">&#9658;</span> History <span id="history-count"></span>
    </button>
    <div id="history-content" hidden>
      <p class="history-placeholder">History coming in a future version.</p>
    </div>
  </div>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
