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

  // Primary auto-add: watch onDidChangeSessions for session IDs that appear
  // after the initial scan. The first event is the initial scan result — we
  // record those as "pre-existing" and skip them. Every subsequent event that
  // brings a new ID gets auto-added to the registry.
  let initialSessionIds: Set<string> | null = null;
  context.subscriptions.push(
    sessionManager.onDidChangeSessions(sessions => {
      if (initialSessionIds === null) {
        // First fire = initial scan complete. These sessions existed before
        // the extension started — leave them in History, don't auto-add.
        initialSessionIds = new Set(sessions.map(s => s.sessionId));
        return;
      }
      for (const session of sessions) {
        if (!initialSessionIds.has(session.sessionId)) {
          initialSessionIds.add(session.sessionId); // prevent re-triggering
          if (!registry.getIds().includes(session.sessionId)) {
            registry.add(session.sessionId);
          }
        }
      }
    })
  );

  // Fast-path fallback: also catch the file creation event directly so the
  // placeholder tab appears before the first message is parsed.
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const creationWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl')
  );
  context.subscriptions.push(creationWatcher);
  context.subscriptions.push(
    creationWatcher.onDidCreate(uri => {
      // Only auto-add if the initial scan has already completed; otherwise
      // we cannot distinguish new files from pre-existing ones.
      if (initialSessionIds === null) { return; }
      try {
        const stat = fs.statSync(uri.fsPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs <= NEW_SESSION_WINDOW_MS) {
          const sessionId = path.basename(uri.fsPath, '.jsonl');
          if (!initialSessionIds.has(sessionId)) {
            initialSessionIds.add(sessionId);
            registry.add(sessionId);
          }
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
