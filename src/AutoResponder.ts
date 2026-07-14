import * as vscode from 'vscode';
import type { AutoRespondRule, BobSender } from './BobSender';
import type { MessageExchange, SessionManager, ClaudeSession } from './SessionManager';

/** Return the first rule whose pattern matches the assistant text. Invalid
 *  regex patterns are skipped (never throw). */
export function matchRule(assistantText: string, rules: AutoRespondRule[]): AutoRespondRule | undefined {
  for (const rule of rules) {
    let re: RegExp;
    try { re = new RegExp(rule.matchPattern); } catch { continue; }
    if (re.test(assistantText)) { return rule; }
  }
  return undefined;
}

/** Stable identity for a message, used for dedup. */
export function messageKey(ex: MessageExchange): string {
  return ex.timestamp ?? ex.text;
}

// Minimal shape of SessionManager this class needs (keeps tests light).
type SessionSource = Pick<SessionManager, 'onDidChangeSessions' | 'getSessions' | 'getRecentExchanges'>;

export class AutoResponder {
  private disposable: vscode.Disposable | undefined;
  private readonly lastFired = new Map<string, string>(); // sessionId -> messageKey
  private running = false;

  constructor(
    private readonly sessionManager: SessionSource,
    private readonly sender: BobSender,
    private readonly getRules: () => AutoRespondRule[],
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    this.disposable = this.sessionManager.onDidChangeSessions((sessions: ClaudeSession[]) => {
      void this.evaluateAll(sessions);
    });
  }

  private async evaluateAll(sessions: ClaudeSession[]): Promise<void> {
    if (this.running) { return; } // avoid overlapping scans
    this.running = true;
    try {
      for (const s of sessions) {
        if (s.source !== 'bob') { continue; }
        await this.evaluateSession(s);
      }
    } finally {
      this.running = false;
    }
  }

  async evaluateSession(session: ClaudeSession): Promise<void> {
    const rules = this.getRules().filter(r => (r.source ?? 'bob') === 'bob');
    if (rules.length === 0) { return; }

    let exchanges: MessageExchange[] | undefined;
    try { exchanges = await this.sessionManager.getRecentExchanges(session.sessionId); }
    catch (err) { this.log(`getRecentExchanges failed for ${session.sessionId}: ${String(err)}`); return; }
    if (!exchanges || exchanges.length === 0) { return; }

    const last = exchanges[exchanges.length - 1];
    if (last.role !== 'assistant') {
      // User has spoken since; re-arm this session so a future assistant prompt can fire.
      this.lastFired.delete(session.sessionId);
      return;
    }

    const rule = matchRule(last.text, rules);
    if (!rule) { return; }

    const key = messageKey(last);
    if (this.lastFired.get(session.sessionId) === key) { return; } // already fired for this message

    this.lastFired.set(session.sessionId, key);
    this.log(`auto-respond: session ${session.sessionId} matched /${rule.matchPattern}/ → sending "${rule.response}"`);
    try { await this.sender.send(session.sessionId, rule.response); }
    catch (err) { this.log(`send failed for ${session.sessionId}: ${String(err)}`); }
  }

  dispose(): void {
    this.disposable?.dispose();
    this.lastFired.clear();
  }
}
