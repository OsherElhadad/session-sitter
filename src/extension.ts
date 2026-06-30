import * as vscode from 'vscode';
import { SessionManager } from './SessionManager';
import { SessionSwitcherViewProvider } from './SessionSwitcherViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const sessionManager = new SessionManager(context);

  const provider = new SessionSwitcherViewProvider(
    context.extensionUri,
    sessionManager,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionSwitcherViewProvider.viewType,
      provider,
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.refresh', () => {
      void vscode.window.showInformationMessage('Claude sessions update automatically.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.newSession', () => {
      // Open a fresh conversation in the current window's editor. We avoid
      // `claude-vscode.newConversation` — it only notifies already-open Claude
      // panels and does nothing when none is open. `primaryEditor.open` with no
      // sessionId creates a new panel in the active editor column.
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    })
  );

  context.subscriptions.push(provider);
}

export function deactivate() {}
