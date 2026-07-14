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

  // TEST COMMAND: send "Hello World" to the current Bob session.
  // Uses IBM Bob's exported extension API (vscode.extensions.getExtension('IBM.bob-code').exports)
  // which exposes startTask({workspaceFolder, mode, content, mask}).
  // Run "Claude Session Switcher: Test Bob Send Hello World" from the Command
  // Palette while a Bob session is open. Remove once confirmed working.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.testBobSend', async () => {
      try {
        // 1. Find the most-recently-active Bob session.
        const sessions = sessionManager.getSessions();
        const bobSession = sessions
          .filter(s => s.source === 'bob')
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

        if (!bobSession) {
          void vscode.window.showWarningMessage('No Bob sessions found.');
          return;
        }

        // 2. Get IBM Bob's exported extension API.
        //    Bob's activate() returns the LUn object which includes startTask().
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
        if (!bobExt) {
          void vscode.window.showErrorMessage('IBM Bob extension (IBM.bob-code) not found.');
          return;
        }
        const bobApi = bobExt.isActive ? bobExt.exports : await bobExt.activate();
        if (!bobApi?.startTask) {
          void vscode.window.showErrorMessage('IBM Bob API does not expose startTask.');
          return;
        }

        // 3. Resolve the Bob workspace folder from the session's projectPath.
        //    bobSession.projectPath is a Windows path (e.g. "C:/Users/.../project").
        //    vscode.workspace.workspaceFolders holds the currently open folders —
        //    find the one matching the session's project if available.
        let workspaceFolder: vscode.WorkspaceFolder | undefined;
        if (bobSession.projectPath) {
          workspaceFolder = vscode.workspace.workspaceFolders?.find(wf =>
            wf.uri.fsPath === bobSession.projectPath ||
            bobSession.projectPath.startsWith(wf.uri.fsPath)
          );
        }
        // Fall back to the first open workspace folder if no direct match.
        workspaceFolder ??= vscode.workspace.workspaceFolders?.[0];

        // 4. Send the message via Bob's startTask API.
        //    This sends "Hello World" as the user message in the Bob chat.
        await bobApi.startTask({
          workspaceFolder,
          mode: 'agent',
          content: 'Hello World',
          mask: 'Hello World',
        });
        void vscode.window.showInformationMessage(
          `✅ Sent "Hello World" via Bob API (session: ${bobSession.title})`
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`❌ Test Bob Send failed: ${String(err)}`);
      }
    })
  );

  // SPIKE (throwaway): prove inspector-based send into an EXISTING Bob session.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionSwitcher.spikeInspectorSend', async () => {
      const { spikeInspectorSend } = await import('./spikeInspector');
      const sessions = sessionManager.getSessions()
        .filter(s => s.source === 'bob')
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      if (sessions.length === 0) { void vscode.window.showWarningMessage('No Bob sessions.'); return; }
      const target = sessions[0];
      const result = await spikeInspectorSend(target.sessionId, 'SPIKE OK — auto-respond test');
      void vscode.window.showInformationMessage(`[spike] ${result} (session: ${target.title})`);
    })
  );

  context.subscriptions.push(provider);
}

export function deactivate() {}
