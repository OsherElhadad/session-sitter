/**
 * Starting and focusing sessions in *this* window, on behalf of a Telegram command.
 *
 * The one place in the feature that talks to `vscode.commands`, so everything else stays testable
 * without an extension host.
 *
 * ## A new session used to be unreachable from the place it was started
 *
 * This file used to say a new session "cannot be confirmed" — no id comes back from
 * `primaryEditor.open` — and reported that its topic would appear "once it writes its first message".
 * That never happened, because **a panel nobody has spoken to writes no transcript**, and the worklist
 * is built from transcripts. So `/new` produced a session visible in the IDE, absent from Telegram,
 * and impossible to continue from the phone it was started on.
 *
 * The id was available the whole time, in a different place: Claude's live manager knows the panel
 * immediately, which is what `getOpenClaudeSessionIds` reads. So this now
 *
 *  1. reads the open ids **before** opening anything,
 *  2. opens the panel,
 *  3. waits briefly for exactly one new id to appear, and refuses to guess if two do,
 *  4. sends it a first message, which is what makes the CLI write a transcript and the session real,
 *  5. returns the id, so a topic can be created for it straight away.
 *
 * Step 4 is the load-bearing one. Without it the session stays a panel with no transcript, and a topic
 * pointing at it would mirror nothing and accept nothing.
 *
 * ## What it still cannot promise
 *
 * **Which folder** the session lands in, when the target window has several open. Nothing in Claude's
 * API takes a workspace folder — `primaryEditor.open` accepts a session id and nothing else — so the
 * folder is Claude's choice. `chooseLaunchTarget` prefers a window that has *only* the chosen folder,
 * which makes the common case exact, and the menu says so when it cannot. Guessing an undocumented
 * option name would be worse than saying which part is not ours to decide.
 */

import * as vscode from 'vscode';
import { getOpenClaudeSessionIds, type ClaudeOpenState } from '../agents/ClaudeInspector';
import { sendLanded } from '../agents/ClaudeSender';
import type { SessionLauncher } from './applyCommand';
import {
  APPEAR_POLL_MS, APPEAR_TIMEOUT_MS, classifyAppearance, firstMessage,
} from './newSession';

/** Focus behaviour is shared with the panel, so it is injected rather than duplicated here. */
export interface FocusFn {
  (sessionId: string, source: string): Promise<boolean>;
}

/** Sending the first message. Satisfied by `InspectorClaudeSender.sendToSession`. */
export interface SendToSessionFn {
  (sessionId: string, text: string): Promise<string>;
}

export interface LauncherDeps {
  /** Reads Claude's live manager. Injected so the wait is testable without an extension host. */
  readOpen?: (log: (msg: string) => void) => Promise<ClaudeOpenState>;
  sendToSession?: SendToSessionFn;
  host?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  appearTimeoutMs?: number;
}

export class VsCodeSessionLauncher implements SessionLauncher {
  private readonly readOpen: (log: (msg: string) => void) => Promise<ClaudeOpenState>;
  private readonly sendToSession?: SendToSessionFn;
  private readonly host: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly appearTimeoutMs: number;

  constructor(
    private readonly log: (msg: string) => void,
    private readonly focusFn?: FocusFn,
    deps: LauncherDeps = {},
  ) {
    this.readOpen = deps.readOpen ?? getOpenClaudeSessionIds;
    this.sendToSession = deps.sendToSession;
    this.host = deps.host ?? '';
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? (ms => new Promise<void>(r => { setTimeout(r, ms); }));
    this.appearTimeoutMs = deps.appearTimeoutMs ?? APPEAR_TIMEOUT_MS;
  }

  /** Panels open in this window right now, or an empty list when the manager is unreachable. */
  private async openPanels(): Promise<string[]> {
    try {
      // `panels`, not `open`: it is Claude's own definition of "open in the editor" and it is
      // self-pruning, so a session closed an hour ago cannot mask a new one appearing.
      return (await this.readOpen(this.log)).panels;
    } catch (err) {
      this.log(`remote control: could not read Claude's open sessions: ${String(err)}`);
      return [];
    }
  }

  async launch(
    source: 'claude' | 'bob', workspace: string,
  ): Promise<{ ok: boolean; detail: string; sessionId?: string }> {
    const name = workspace.split(/[/\\]/).pop() ?? workspace;

    if (source === 'bob') { return this.launchBob(name, workspace); }

    const before = await this.openPanels();
    try {
      // `primaryEditor.open` with no session id creates a fresh panel. The alternative,
      // `claude-vscode.newConversation`, only notifies panels that are already open and does
      // nothing when none is — see the note on sessionSitter.newSession.
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    } catch (err) {
      this.log(`remote control: launch claude in ${workspace} failed: ${String(err)}`);
      return { ok: false, detail: `Could not start a Claude session in ${name}: ${String(err)}` };
    }

    const outcome = await this.awaitNewSession(before);
    if (outcome.kind !== 'started') {
      // The panel is open either way, so this is not a failure of the open — it is a failure to
      // *name* what was opened, and the two need different words. Saying "could not start" would
      // send someone looking for a window that is sitting there in front of them.
      const why = outcome.kind === 'ambiguous'
        ? `${outcome.count} sessions appeared at once, so it is not clear which is this one`
        : 'it did not register within '
          + `${Math.round(this.appearTimeoutMs / 1000)}s`;
      this.log(`remote control: opened a claude panel in ${workspace}, but ${why}`);
      return {
        ok: true,
        detail: `Opened a Claude panel in ${name}, but could not identify the session — ${why}. `
          + 'Send it a message in the IDE and it will appear here on the next pass.',
      };
    }

    const kickoff = await this.sendFirstMessage(outcome.sessionId);
    this.log(`remote control: opened claude session ${outcome.sessionId} in ${workspace}`
      + `${kickoff.ok ? '' : ` (first message not delivered: ${kickoff.detail})`}`);

    return {
      ok: true,
      sessionId: outcome.sessionId,
      detail: kickoff.ok
        ? `Started a Claude session in ${name}. Its topic is ready — reply there to continue.`
        // Honest split: the session exists and has an id, so a topic can be made for it, but until
        // something is said to it there is no transcript to mirror.
        : `Opened a Claude session in ${name}, but its first message did not land `
          + `(${kickoff.detail}). Say something to it in the IDE to bring it to life.`,
    };
  }

  /**
   * Wait for exactly one new panel id, polling Claude's manager.
   *
   * Polled rather than awaited on an event, because the manager exposes no event this side of the
   * inspector — and bounded, because a wait with no deadline would hold the bus command open and take
   * the window's whole pass with it.
   */
  private async awaitNewSession(
    before: readonly string[],
  ): Promise<ReturnType<typeof classifyAppearance>> {
    const deadline = this.now() + this.appearTimeoutMs;
    let outcome = classifyAppearance(before, await this.openPanels());
    while (outcome.kind === 'no-session' && this.now() < deadline) {
      await this.sleep(APPEAR_POLL_MS);
      outcome = classifyAppearance(before, await this.openPanels());
    }
    return outcome;
  }

  /**
   * Send the message that makes the session real.
   *
   * A missing sender is reported rather than thrown: the session is open and identified, and a topic
   * for it is still worth having. Silence here would leave the user with a topic that mirrors nothing
   * and no idea why.
   */
  private async sendFirstMessage(sessionId: string): Promise<{ ok: boolean; detail: string }> {
    if (this.sendToSession === undefined) {
      return { ok: false, detail: 'no Claude sender is wired up in this window' };
    }
    try {
      const status = await this.sendToSession(sessionId, firstMessage(this.host));
      return { ok: sendLanded(status), detail: status };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }

  private async launchBob(
    name: string, workspace: string,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const ext = vscode.extensions.getExtension('IBM.bob-code');
      if (!ext) { return { ok: false, detail: 'Bob is not installed in that window.' }; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (ext.isActive ? ext.exports : await ext.activate()) as any;
      if (typeof api?.startTask !== 'function') {
        return { ok: false, detail: 'Bob is installed but exposes no startTask API.' };
      }
      await api.startTask();
    } catch (err) {
      this.log(`remote control: launch bob in ${workspace} failed: ${String(err)}`);
      return { ok: false, detail: `Could not start a Bob session in ${name}: ${String(err)}` };
    }
    this.log(`remote control: opened a new bob session in ${workspace}`);
    // Bob's `startTask` returns nothing and its tasks live in a SQLite store this window does not
    // read synchronously, so there is no id to hand back. Unchanged, and stated rather than implied.
    return {
      ok: true,
      detail: `Opened a new Bob session in ${name}. Its topic appears once it writes its first `
        + 'message.',
    };
  }

  async focus(sessionId: string, source: string): Promise<boolean> {
    if (this.focusFn !== undefined) {
      try {
        return await this.focusFn(sessionId, source);
      } catch (err) {
        this.log(`remote control: focus ${sessionId} failed: ${String(err)}`);
        return false;
      }
    }
    // Without the panel's focus helper, the best available action for Claude is to open the
    // session's own editor panel by id.
    if (source !== 'claude') { return false; }
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', { sessionId });
      return true;
    } catch (err) {
      this.log(`remote control: focus ${sessionId} failed: ${String(err)}`);
      return false;
    }
  }
}
