import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './SessionManager';
import { SessionSitterViewProvider } from './SessionSitterViewProvider';
import { InspectorBobSender, type AutoRespondRule } from './agents/BobSender';
import { InspectorBobApprover, type PendingApproval } from './agents/BobApprover';
import { AutoResponder } from './AutoResponder';
import {
  dumpClaudeManagerShape,
  dumpClaudeSendApprovalShape,
  getOpenClaudeSessionIds,
} from './agents/ClaudeInspector';
import {
  captureClaudeAnswer,
  captureClaudeQuestion,
  dumpBobQuestionShape,
  dumpBobQuestionShapeFull,
  dumpClaudeQuestionShape,
  installClaudeAnswerHook,
  installClaudeQuestionHook,
} from './agents/QuestionProbe';
import { InspectorClaudeSender } from './agents/ClaudeSender';
import { InspectorClaudeApprover } from './agents/ClaudeApprover';
import { BUILD_TIME, BUILD_VERSION } from './buildInfo';
import { SessionExporter } from './SessionExporter';
import { SupervisorOutbox } from './SupervisorOutbox';
import { SupervisionService } from './SupervisionService';

export function activate(context: vscode.ExtensionContext) {
  const sessionManager = new SessionManager(context);

  // The supervisor's state directory also feeds the panel's activity feed.
  const supervisionCfg = () => vscode.workspace.getConfiguration('sessionSitter');
  const stateDir = supervisionCfg().get<string>('supervisorStateDir', '');

  // Shared output channel for logging. Also mirror to a durable file under the state dir: in a
  // multi-window (or WSL) setup the in-memory Output channel is per-extension-host and easy to
  // read from the wrong window, so a single on-disk log is the reliable record of what each
  // window's sweep/handoff actually did. Best-effort — a failed append must never break logging.
  const output = vscode.window.createOutputChannel('Session Sitter');
  context.subscriptions.push(output);
  const logFile = stateDir ? path.join(stateDir, 'session-sitter.log') : undefined;
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] [pid:${process.pid}] ${msg}`;
    output.appendLine(line);
    if (logFile) {
      try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* best-effort */ }
    }
  };
  log(`Session Sitter activated — build v${BUILD_VERSION} @ ${BUILD_TIME}`);

  const provider = new SessionSitterViewProvider(
    context.extensionUri, sessionManager, log, stateDir);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionSitterViewProvider.viewType, provider),
  );

  const sender = new InspectorBobSender(log);
  const approver = new InspectorBobApprover(log);
  const claudeSender = new InspectorClaudeSender(log);
  const claudeApprover = new InspectorClaudeApprover(log);

  // ── Commands ──────────────────────────────────────────────────────────────

  const openJson = async (header: string, body: string) => {
    const doc = await vscode.workspace.openTextDocument({ content: header + body, language: 'json' });
    void vscode.window.showTextDocument(doc);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.refresh', () => {
      void vscode.window.showInformationMessage('Sessions update automatically.');
    }),
    vscode.commands.registerCommand('sessionSitter.newSession', () => {
      // Open a fresh conversation in the current window's editor. We avoid
      // `claude-vscode.newConversation` — it only notifies already-open Claude panels and does
      // nothing when none is open. `primaryEditor.open` with no sessionId creates a new panel.
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    }),
  );

  // Manual test: send a message into the most-recently-active EXISTING Bob session.
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.testBobSend', async () => {
      const target = mostRecent(sessionManager, 'bob');
      if (!target) { void vscode.window.showWarningMessage('No Bob sessions found.'); return; }
      if (!(await sender.isAvailable())) {
        void vscode.window.showErrorMessage('Bob API not available.');
        return;
      }
      await sender.send(target.sessionId, 'Hello World — test send to existing session');
      void vscode.window.showInformationMessage(`Sent test message to: ${target.title}`);
    }),
  );

  // Manual test: inject a message into the running Claude session (v1 single-channel targeting).
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.testClaudeSend', async () => {
      const target = mostRecent(sessionManager, 'claude');
      if (!target) { void vscode.window.showWarningMessage('No Claude sessions found.'); return; }
      if (!(await claudeSender.isAvailable())) {
        void vscode.window.showErrorMessage('Claude extension not available.');
        return;
      }
      const result = await claudeSender.inject('Hello from Session Sitter — test Claude send');
      const msg = `Claude send result: ${result} (target: ${target.title})`;
      if (result === 'ok') { void vscode.window.showInformationMessage(msg); }
      else { void vscode.window.showWarningMessage(msg); }
    }),
  );

  // Diagnostic: install the metadata hook and list Claude's pending tool-permission prompts.
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.testClaudeListApprovals', async () => {
      const hook = await claudeApprover.installHook();
      const pending = await claudeApprover.listAllPending();
      const summary = pending.length
        ? pending.map(p => `${p.toolName}(${p.argsText.slice(0, 40)})`).join(', ')
        : '(none — trigger a permission prompt, then run again)';
      void vscode.window.showInformationMessage(
        `Claude pending approvals: ${pending.length} — ${summary} [${hook}]`);
    }),
  );

  // ── Read-only internals probes (debugging the agent bridges) ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.probeClaudeOpen', async () => {
      const state = await getOpenClaudeSessionIds(log);
      const shape = await dumpClaudeManagerShape(log);
      await openJson(
        `// Claude open panels: ${state.open.length} [${state.open.join(', ')}] · `
        + `active=${state.active ?? '(none)'} · ${state.diag ?? ''}\n`
        + '// Manager field shape (find which field holds your open session id):\n',
        shape);
    }),
    vscode.commands.registerCommand('sessionSitter.probeClaudeInternals', async () => {
      await openJson(
        '// Claude send + approval shape probe (read-only). Find:\n'
        + '//  - a message-inject method on a session state or one of its children\n'
        + '//  - where a pending permission request + its resolver live\n',
        await dumpClaudeSendApprovalShape(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeBobQuestion', async () => {
      await openJson(
        '// Bob ask_followup_question shape probe (read-only). Find:\n'
        + '//  - signatureArgs: the question + options/choices INPUT schema\n'
        + '//  - requestOwnProps / approvalHandlerShape: how a selected answer resolves\n',
        await dumpBobQuestionShape(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeBobQuestionFull', async () => {
      await openJson(
        '// Bob FULL approval-state probe (read-only). Use when "Probe Bob Question" returns\n'
        + '// questions:[] to locate where a live question actually lives.\n',
        await dumpBobQuestionShapeFull(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeClaudeQuestion', async () => {
      await openJson(
        '// Claude AskUserQuestion shape probe (read-only). Find:\n'
        + '//  - the request type + inputs (questions/options/multiSelect)\n'
        + '//  - the deferred resolve join point + expected value shape\n',
        await dumpClaudeQuestionShape(log));
    }),
    vscode.commands.registerCommand('sessionSitter.installClaudeQuestionHook', async () => {
      const result = await installClaudeQuestionHook(log);
      void vscode.window.showInformationMessage(
        `Claude question hook: ${result}. Now trigger a NEW AskUserQuestion, then run `
        + '"Capture Claude Question".');
    }),
    vscode.commands.registerCommand('sessionSitter.captureClaudeQuestion', async () => {
      await openJson(
        '// Claude AskUserQuestion capture (needs the hook installed first). Find:\n'
        + '//  - outstanding[].recorded.type / .toolName / .payload = the request + input schema\n'
        + '//  - recentRecorded[] = recently-resolved requests (answer-flow confirmation)\n',
        await captureClaudeQuestion(log));
    }),
    vscode.commands.registerCommand('sessionSitter.installClaudeAnswerHook', async () => {
      const result = await installClaudeAnswerHook(log);
      void vscode.window.showInformationMessage(
        `Claude answer hook: ${result}. Now ANSWER the question, then run "Capture Claude Answer".`);
    }),
    vscode.commands.registerCommand('sessionSitter.captureClaudeAnswer', async () => {
      await openJson(
        '// Claude AskUserQuestion answer capture (needs the answer hook installed before\n'
        + '// answering). answers[].resolvedWith = the exact value passed to deferred.resolve.\n',
        await captureClaudeAnswer(log));
    }),
  );

  // ── Supervision ───────────────────────────────────────────────────────────
  // This extension is the single session reader: it exports full transcripts for the supervisor
  // and applies the supervisor's decisions back into the running agent.

  const cfg = supervisionCfg();
  const autoSupervise = cfg.get<boolean>('autoSupervise', true);
  // Workspace root: an explicit setting, else derived from the state dir (<root>/.state or
  // <root>/supervisor/.state), else the first workspace folder.
  const workspaceRoot = cfg.get<string>('supervisorRepoPath', '')
    || (stateDir ? path.dirname(stateDir) : '')
    || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');

  // The outbox applies supervisor decisions: an approval-channel delivery goes through the
  // agent's approval emitter (the only channel that reaches a prompt-blocked task); a
  // message-channel delivery is injected as a labeled chat message into an idle task.
  let outbox: SupervisorOutbox | undefined;
  if (stateDir) {
    const resolveActiveSession = (): string | undefined => mostRecent(sessionManager, 'bob')?.sessionId;
    outbox = new SupervisorOutbox(
      path.join(stateDir, 'outbox'), sender, log, approver, resolveActiveSession,
      claudeSender, claudeApprover);
    outbox.start(1500); // the interval is the safety net; deliveries are also kicked directly
    context.subscriptions.push({ dispose: () => outbox?.dispose() });
  }

  // The supervisor itself runs in-process (no interpreter, no child process). Deliveries kick
  // the outbox immediately so an approval reaches a blocked agent in milliseconds.
  let supervision: SupervisionService | undefined;
  if (autoSupervise && stateDir && workspaceRoot) {
    supervision = new SupervisionService({
      enabled: true,
      stateDir,
      workspaceRoot,
      user: cfg.get<string>('knowledge.user', ''),
      project: cfg.get<string>('knowledge.project', ''),
      team: cfg.get<string>('knowledge.team', ''),
      knowledgeRegistryPath: cfg.get<string>('knowledge.registryPath', ''),
      knowledgeLocalRepo: cfg.get<string>('dataRepoPath', '') || workspaceRoot,
      bobDbPath: sessionManager.getBobDbPath(),
    }, log, () => { void outbox?.poll(); });
    supervision.start();
    context.subscriptions.push({ dispose: () => supervision?.dispose() });
  } else if (autoSupervise) {
    log('supervision not started: set sessionSitter.supervisorStateDir '
      + '(and sessionSitter.supervisorRepoPath if it cannot be derived from it).');
  }

  // Export the most-recent Claude session's transcript (with its live pending approval) for the
  // supervisor, then return its id. Undefined when no Claude session / file path resolves
  // (v1: single-session correlation, because a Claude approval carries a channelId, not a
  // session id).
  const exportClaudeForSupervision = async (p: PendingApproval): Promise<string | undefined> => {
    if (!stateDir) { log('supervision(claude): no stateDir configured'); return undefined; }
    const recent = mostRecent(sessionManager, 'claude');
    if (!recent) {
      log(`supervision(claude): 0 claude sessions (total=${sessionManager.getSessions().length})`);
      return undefined;
    }
    const filePath = sessionManager.getSessionFilePath(recent.sessionId);
    if (!filePath) {
      log(`supervision(claude): no filePath for ${recent.sessionId}`);
      return undefined;
    }
    const exporter = new SessionExporter(sessionManager.getBobDbPath());
    await exporter.exportClaude(
      {
        sessionId: recent.sessionId, projectName: recent.projectName,
        projectPath: recent.projectPath, status: recent.status, title: recent.title,
      },
      filePath, path.join(stateDir, 'history'), p,
    );
    log(`supervision(claude): exported ${recent.sessionId} for ${p.toolName} req=${p.requestId}`);
    return recent.sessionId;
  };

  // Auto-respond: watch sessions and send configured text replies on a pattern match, resolve
  // pending tool-approval prompts per configured approval rules, and hand any UNHANDLED pending
  // prompt to the supervisor (export + classify).
  const getRules = (): AutoRespondRule[] =>
    vscode.workspace.getConfiguration('sessionSitter')
      .get<AutoRespondRule[]>('autoRespond', []);

  const autoResponder = new AutoResponder(
    sessionManager, sender, getRules, log, approver,
    supervision ? (p) => { void supervision!.maybeTrigger(p); } : undefined,
    supervision ? (ids) => supervision!.prune(ids) : undefined,
    claudeSender,
    claudeApprover,
    supervision
      ? (p) => { void supervision!.maybeTriggerClaude(p, exportClaudeForSupervision); }
      : undefined,
    supervision ? (ids) => supervision!.pruneClaude(ids) : undefined,
  );
  autoResponder.start();
  context.subscriptions.push({ dispose: () => autoResponder.dispose() });

  // Manual export of a Bob session's full transcript, for classifying it by hand.
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.exportSessionForSupervision', async () => {
      if (!stateDir) {
        void vscode.window.showErrorMessage('Set sessionSitter.supervisorStateDir first.');
        return;
      }
      // The interrupt point is a LIVE pending approval in Bob's memory. Read it first and target
      // the task that owns it — a task blocked mid-prompt often isn't in getSessions() yet (its
      // title/first_message hasn't been flushed to bob.db). Fall back to the most recent Bob
      // session only when nothing is pending (idle-task / message case).
      let pending: PendingApproval[] = [];
      try {
        pending = await approver.listAllPending();
      } catch (err) {
        log(`listAllPending failed: ${String(err)}`);
      }
      log(`listAllPending → ${pending.length} pending: `
        + pending.map(p => `${p.taskId.slice(0, 12)}:${p.toolName}`).join(', '));

      let targetId: string | undefined = pending[0]?.taskId;
      let targetLabel = targetId ?? '';
      if (!targetId) {
        const recent = mostRecent(sessionManager, 'bob');
        if (!recent) {
          void vscode.window.showWarningMessage('No Bob sessions or pending approvals found.');
          return;
        }
        targetId = recent.sessionId;
        targetLabel = recent.title;
      }
      const livePending = pending.find(p => p.taskId === targetId);
      try {
        const exporter = new SessionExporter(sessionManager.getBobDbPath());
        const out = await exporter.exportBob(
          targetId, path.join(stateDir, 'history'), livePending);
        log(`exported transcript for ${targetId} -> ${out}`
          + (livePending
            ? ` (pending: ${livePending.toolName} req=${livePending.requestId})`
            : ' (no live pending)'));
        void vscode.window.showInformationMessage(
          `Exported session for supervision: ${targetLabel}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
      }
    }),
  );

  // Classify the currently-blocked session on demand (useful with autoSupervise off).
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.superviseNow', async () => {
      if (!supervision) {
        void vscode.window.showErrorMessage(
          'Supervision is not running. Set sessionSitter.supervisorStateDir and enable '
          + 'sessionSitter.autoSupervise.');
        return;
      }
      const pending = await approver.listAllPending();
      if (pending.length === 0) {
        void vscode.window.showInformationMessage('No pending approval to supervise.');
        return;
      }
      const record = await supervision.maybeTrigger(pending[0]);
      void vscode.window.showInformationMessage(
        record ? `Supervision: ${record.state}` : 'Supervision: already handled.');
    }),
  );

  context.subscriptions.push(provider);
}

/** Most recently updated session for one source, or undefined. */
function mostRecent(sessionManager: SessionManager, source: 'bob' | 'claude') {
  return sessionManager.getSessions()
    .filter(s => s.source === source)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}

export function deactivate() { /* nothing to tear down beyond the disposables */ }
