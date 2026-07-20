import * as vscode from 'vscode';
import { SessionManager } from './SessionManager';
import { SessionSwitcherViewProvider } from './SessionSwitcherViewProvider';
import { InspectorBobSender, type AutoRespondRule } from './BobSender';
import { AutoResponder } from './AutoResponder';

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

  // Shared output channel + Bob sender for logging and auto-respond.
  const output = vscode.window.createOutputChannel('Claude Session Switcher');
  context.subscriptions.push(output);
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  const sender = new InspectorBobSender(log);

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

  // Manual test: send a message into the most-recently-active EXISTING Bob
  // session (not a new task) via the inspector-based sender.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.testBobSend', async () => {
      const target = sessionManager.getSessions()
        .filter(s => s.source === 'bob')
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      if (!target) { void vscode.window.showWarningMessage('No Bob sessions found.'); return; }
      if (!(await sender.isAvailable())) { void vscode.window.showErrorMessage('Bob API not available.'); return; }
      await sender.send(target.sessionId, 'Hello World — test send to existing session');
      void vscode.window.showInformationMessage(`Sent test message to existing session: ${target.title}`);
    })
  );

  // Auto-respond: watch Bob sessions and send configured replies on pattern match.
  const getRules = (): AutoRespondRule[] =>
    vscode.workspace.getConfiguration('claudeSessionSwitcher').get<AutoRespondRule[]>('autoRespond', []);
  const autoResponder = new AutoResponder(sessionManager, sender, getRules, log);
  autoResponder.start();
  context.subscriptions.push({ dispose: () => autoResponder.dispose() });

  context.subscriptions.push(provider);
}

export function deactivate() {}
