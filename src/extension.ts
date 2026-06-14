import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SessionManager } from './SessionManager';
import { SessionSwitcherViewProvider } from './SessionSwitcherViewProvider';
import { LiveSessionRegistry } from './LiveSessionRegistry';

// Auto-add sessions updated within this window to the tab bar on every scan.
const RECENT_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours

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

  // Auto-add any session updated within the last 8 hours that isn't already
  // in the registry. Fires on every scan (startup + file changes), so new
  // sessions appear as soon as their JSONL is written.
  context.subscriptions.push(
    sessionManager.onDidChangeSessions(sessions => {
      const now = Date.now();
      const registryIds = new Set(registry.getIds());
      for (const session of sessions) {
        if (!registryIds.has(session.sessionId)) {
          const ageMs = now - session.updatedAt.getTime();
          if (ageMs <= RECENT_SESSION_MS) {
            registry.add(session.sessionId);
          }
        }
      }
    })
  );

  // Fast-path: also watch for new JSONL file creation directly so a
  // "Starting…" placeholder appears in the tab bar before the first message
  // is parsed by the scanner.
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
        if (ageMs <= RECENT_SESSION_MS) {
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
