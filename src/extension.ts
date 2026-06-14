import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SessionManager } from './SessionManager';
import { SessionSwitcherViewProvider } from './SessionSwitcherViewProvider';
import { LiveSessionRegistry } from './LiveSessionRegistry';

const NEW_SESSION_WINDOW_MS = 60_000;

export function activate(context: vscode.ExtensionContext) {
  const sessionManager = new SessionManager(context);

  // context.globalState satisfies IRegistryStorage structurally (get/update)
  const registry = new LiveSessionRegistry(context.globalState);
  context.subscriptions.push(registry);

  const provider = new SessionSwitcherViewProvider(
    context.extensionUri,
    sessionManager,
    registry,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionSwitcherViewProvider.viewType,
      provider,
    )
  );

  // Auto-add newly created JSONL sessions that are recent (≤60 s old)
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const creationWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl')
  );
  context.subscriptions.push(creationWatcher);
  context.subscriptions.push(
    creationWatcher.onDidCreate(uri => {
      try {
        const stat = fs.statSync(uri.fsPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs <= NEW_SESSION_WINDOW_MS) {
          const sessionId = path.basename(uri.fsPath, '.jsonl');
          registry.add(sessionId);
        }
      } catch {
        // File deleted immediately after creation — ignore
      }
    })
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
