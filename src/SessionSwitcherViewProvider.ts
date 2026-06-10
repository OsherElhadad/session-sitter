import * as vscode from 'vscode';
import { SessionManager, ClaudeSession } from './SessionManager';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class SessionSwitcherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeSessionSwitcher.view';

  private _view?: vscode.WebviewView;
  private _removedSessionIds = new Set<string>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Listen for session changes from SessionManager and push filtered updates
    this._sessionManager.onDidChangeSessions(sessions => {
      this._pushSessions(sessions);
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'switchSession': {
          const sessionId = message.sessionId as string;
          void vscode.env.openExternal(
            vscode.Uri.parse('vscode://anthropic.claude-code/open?session=' + sessionId)
          );
          break;
        }
        case 'newSession': {
          void vscode.commands.executeCommand('claude-vscode.newConversation');
          break;
        }
        case 'removeTab': {
          const sessionId = message.sessionId as string;
          this._removedSessionIds.add(sessionId);
          this._pushSessions(this._sessionManager.getSessions());
          break;
        }
      }
    });

    // Immediately push the current session list
    const sessions = this._sessionManager.getSessions();
    this._pushSessions(sessions);
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
      &#9658; History <span id="history-count"></span>
    </button>
    <div id="history-content" hidden></div>
  </div>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
