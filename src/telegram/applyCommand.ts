/**
 * Applying one bus command inside the window that owns the target session.
 *
 * Split out of the service so the decision logic — which sender, what to report, when to refuse —
 * is testable with fakes. The real senders reach into another extension's process through the V8
 * inspector and can only run in a live IDE, so everything *around* them has to be coverable
 * without one.
 *
 * ## Every outcome is a sentence
 *
 * The result goes straight into a Telegram topic, where a bare `ambiguous:3` or a silence is
 * useless: the user cannot see the log, and cannot tell a failed send from an agent that is
 * thinking. So each branch produces text that says what happened and what to do about it.
 */

import type { BusCommand, BusResult } from './bus';
import type { MessageSender } from '../agents/BobSender';
import { describeSendStatus, sendLanded } from '../agents/ClaudeSender';

/** A Claude sender that can aim at one named session. `InspectorClaudeSender` satisfies it. */
export interface TargetedClaudeSender extends MessageSender {
  sendToSession(sessionId: string, text: string): Promise<string>;
}

/** Starts a new session in this window. Implemented over `vscode.commands` by the extension. */
export interface SessionLauncher {
  /** Open a fresh session for `source`, returning a sentence describing the outcome. */
  launch(source: 'claude' | 'bob', workspace: string): Promise<{ ok: boolean; detail: string }>;
  /** Bring the given session to the front in this window. */
  focus(sessionId: string, source: string): Promise<boolean>;
}

export interface ApplyDeps {
  pid: number;
  bobSender: MessageSender;
  claudeSender: TargetedClaudeSender;
  launcher: SessionLauncher;
  now?: () => number;
  log?: (msg: string) => void;
  /**
   * Why this process cannot write into a session — null when it can.
   *
   * Set by an owner that is responsible for a session but unable to type into it, which is the
   * `session-sitter daemon` on a machine with no VS Code: injection goes through the agent's own
   * extension host over the V8 inspector, and there is no extension host in a terminal.
   *
   * Checked *before* any sender is called rather than left to fail inside one. The senders' failure
   * modes are `no-channel` and `ambiguous`, which describe a window that could not find the right
   * conversation — a completely different problem with a completely different fix, and reporting one
   * as the other sends someone looking for a session that was never reachable from here at all.
   *
   * The sentence comes from `injectionBlocker` in `ownership.ts`, so what an owner can do and how that
   * is explained stay in one place.
   */
  writeBlocker?: string | null;
}

function result(cmd: BusCommand, deps: ApplyDeps, ok: boolean, detail: string): BusResult {
  return {
    cmdId: cmd.cmdId,
    ok,
    detail,
    threadId: cmd.threadId,
    pid: deps.pid,
    finishedAt: (deps.now ?? (() => Date.now()))(),
  };
}

/**
 * Run a command and describe the outcome.
 *
 * Never throws: a command that fails must still produce a result, or the reader has nothing to
 * report and the user is left staring at a message that appears to have vanished.
 */
export async function applyCommand(cmd: BusCommand, deps: ApplyDeps): Promise<BusResult> {
  const log = deps.log ?? (() => { /* silent */ });
  try {
    switch (cmd.kind) {
      case 'sendText': return await applySendText(cmd, deps);
      case 'focus': return await applyFocus(cmd, deps);
      case 'newSession': return await applyNewSession(cmd, deps);
      default: return result(cmd, deps, false, `Unknown command kind "${String(cmd.kind)}".`);
    }
  } catch (err) {
    log(`remote control: command ${cmd.cmdId} threw: ${String(err)}`);
    return result(cmd, deps, false, `Failed: ${String(err)}`);
  }
}

async function applySendText(cmd: BusCommand, deps: ApplyDeps): Promise<BusResult> {
  if (!cmd.text.trim()) { return result(cmd, deps, false, 'Nothing to send.'); }
  if (deps.writeBlocker) { return result(cmd, deps, false, deps.writeBlocker); }

  if (cmd.source === 'bob') {
    // Bob takes a task id directly and reaches any task from any window, live or historical, so
    // there is nothing to disambiguate and no status to interpret.
    await deps.bobSender.send(cmd.sessionId, cmd.text);
    return result(cmd, deps, true, 'Sent to this session.');
  }

  if (cmd.source === 'claude') {
    const status = await deps.claudeSender.sendToSession(cmd.sessionId, cmd.text);
    return result(cmd, deps, sendLanded(status), describeSendStatus(status));
  }

  const name = cmd.source === 'codex' ? 'Codex' : 'VS Code Chat';
  return result(cmd, deps, false, `${name} has no message API, so this session is read-only.`);
}

async function applyFocus(cmd: BusCommand, deps: ApplyDeps): Promise<BusResult> {
  // Focus raises a window to the front, which is meaningless without one.
  if (deps.writeBlocker) {
    return result(cmd, deps, false,
      `There is no IDE window here to bring to the front — ${deps.writeBlocker}`);
  }
  const ok = await deps.launcher.focus(cmd.sessionId, cmd.source);
  return ok
    ? result(cmd, deps, true, 'Brought to the front on its machine.')
    : result(cmd, deps, false, 'Could not focus that session.');
}

async function applyNewSession(cmd: BusCommand, deps: ApplyDeps): Promise<BusResult> {
  if (cmd.source !== 'claude' && cmd.source !== 'bob') {
    return result(cmd, deps, false, 'Only Claude and Bob sessions can be started.');
  }
  // Starting a session is a VS Code command, so it needs a window to run in.
  if (deps.writeBlocker) {
    return result(cmd, deps, false,
      `Cannot start a session from here — ${deps.writeBlocker}`);
  }
  const outcome = await deps.launcher.launch(cmd.source, cmd.text);
  return result(cmd, deps, outcome.ok, outcome.detail);
}

/**
 * Whether this window should take a command, given the sessions it owns.
 *
 * `newSession` is addressed by pid rather than by session, because the session it will create does
 * not exist yet — there is no id to own. Everything else is addressed by session id, which is what
 * lets the reader stay ignorant of which window holds what.
 */
export function commandIsMine(
  cmd: BusCommand, pid: number, ownedSessionIds: Set<string>,
): boolean {
  if (cmd.kind === 'newSession') { return cmd.targetPid === pid; }
  return ownedSessionIds.has(cmd.sessionId);
}
