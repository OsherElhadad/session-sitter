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
      void vscode.commands.executeCommand('claude-vscode.newConversation');
    })
  );

  context.subscriptions.push(provider);
}

export function deactivate() {}
