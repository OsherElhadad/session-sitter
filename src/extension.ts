import * as vscode from 'vscode';
import { SessionManager } from './SessionManager';
import { SessionSwitcherViewProvider } from './SessionSwitcherViewProvider';

export function activate(context: vscode.ExtensionContext) {
  // Create SessionManager instance (registers itself for disposal)
  const sessionManager = new SessionManager(context);

  // Create SessionSwitcherViewProvider instance
  const provider = new SessionSwitcherViewProvider(context.extensionUri, sessionManager);

  // Register the WebviewViewProvider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionSwitcherViewProvider.viewType,
      provider,
    )
  );

  // Register the refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.refresh', () => {
      // SessionManager auto-refreshes via FileSystemWatcher
      // This command is a no-op as the watcher handles updates
    })
  );

  // Register the newSession command
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.newSession', () => {
      void vscode.commands.executeCommand('claude-vscode.newConversation');
    })
  );

  // Register provider for disposal
  context.subscriptions.push(provider);
}

export function deactivate() {}
