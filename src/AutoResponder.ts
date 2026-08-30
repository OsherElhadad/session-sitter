import * as vscode from 'vscode';
import type { AutoRespondRule, BobSender, TextRule, ApprovalRule, MessageSender } from './agents/BobSender';
import { isTextRule, isApprovalRule } from './agents/BobSender';
import type { BobApprover, PendingApproval } from './agents/BobApprover';
import { decisionToPayload } from './agents/BobApprover';
import { claudeDecisionToPayload } from './agents/ClaudeApprover';
import type { MessageExchange, SessionManager, ClaudeSession } from './SessionManager';
import type { RuleDecision } from './supervisor/ruleDecisions';

/** How often the approval sweep runs (ms). Approvals live in Bob's memory and
 *  may not change the DB, so they need their own tick independent of scans. */
const APPROVAL_SWEEP_MS = 5_000;

/** Whether a rule applies to a session, given the session's project path. A rule
 *  with no `sessionPattern` applies everywhere. A scoped rule applies only when
 *  its regex matches `projectPath`; an unknown path or invalid regex → does not
 *  apply (never throws). */
export function ruleAppliesToSession(rule: AutoRespondRule, projectPath: string | undefined): boolean {
  const pattern = rule.sessionPattern;
  if (!pattern) { return true; }
  if (projectPath === undefined) { return false; }
  let re: RegExp;
  try { re = new RegExp(pattern); } catch { return false; }
  return re.test(projectPath);
}

/** Return the first TEXT rule whose pattern matches the assistant text. Approval
 *  rules and invalid regex patterns are skipped (never throw). */
export function matchRule(assistantText: string, rules: AutoRespondRule[]): TextRule | undefined {
  for (const rule of rules) {
    if (!isTextRule(rule)) { continue; }
    let re: RegExp;
    try { re = new RegExp(rule.matchPattern); } catch { continue; }
    if (re.test(assistantText)) { return rule; }
  }
  return undefined;
}

/** Compile a tool-name glob to an anchored RegExp. `*` matches any run of
 *  characters; `|` separates alternatives; all other characters are literal. */
export function globToRegExp(glob: string): RegExp {
  const escapeSeg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = glob.split('|').map(part =>
    part.split('*').map(escapeSeg).join('.*')
  );
  return new RegExp('^(' + alternatives.join('|') + ')$');
}

/** Return the first APPROVAL rule matching a pending approval: `toolPattern`
 *  (glob) must match the tool name, and any `argumentPattern` (regex) must match
 *  the arguments JSON. Text rules and invalid patterns are skipped (never throw). */
export function matchApprovalRule(pending: PendingApproval, rules: AutoRespondRule[]): ApprovalRule | undefined {
  for (const rule of rules) {
    if (!isApprovalRule(rule)) { continue; }
    let toolRe: RegExp;
    try { toolRe = globToRegExp(rule.toolPattern); } catch { continue; }
    if (!toolRe.test(pending.toolName)) { continue; }
    if (rule.argumentPattern) {
      let argRe: RegExp;
      try { argRe = new RegExp(rule.argumentPattern); } catch { continue; }
      if (!argRe.test(pending.argsText)) { continue; }
    }
    return rule;
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
  private approvalTimer: ReturnType<typeof setInterval> | undefined;
  private claudeApprovalTimer: ReturnType<typeof setInterval> | undefined;
  private readonly lastFired = new Map<string, string>(); // sessionId -> messageKey (text dedup)
  private readonly resolvedRequestIds = new Set<string>(); // approval dedup (requestId is globally unique)
  private readonly claudeResolvedIds = new Set<string>(); // Claude approval dedup (separate from Bob's)
  private running = false;
  private sweeping = false;
  private claudeSweeping = false;

  constructor(
    private readonly sessionManager: SessionSource,
    private readonly sender: BobSender,
    private readonly getRules: () => AutoRespondRule[],
    private readonly log: (msg: string) => void,
    private readonly approver?: BobApprover,
    // Called for each pending approval that NO auto-approve rule handled — the supervision
    // trigger (export + spawn supervisor). Runs AFTER auto-approve so reads never reach it.
    private readonly onUnhandledPending?: (p: PendingApproval) => void,
    // Lets the trigger prune requestIds that are no longer pending (re-arm on a new request).
    private readonly pruneTriggered?: (stillPending: Set<string>) => void,
    // Sender for Claude sessions; when absent, Claude sessions are skipped.
    private readonly claudeSender?: MessageSender,
    // Approver for Claude tool-permission prompts; when absent, Claude approvals are skipped.
    // installHook (if present) is called once at start so tool metadata is captured.
    private readonly claudeApprover?: BobApprover & { installHook?: () => Promise<string> },
    // Called for each pending Claude approval that NO auto-approve rule handled (supervisor handoff).
    private readonly onUnhandledClaudePending?: (p: PendingApproval) => void,
    // Lets the Claude supervision trigger prune requestIds no longer pending (re-arm on a new request).
    private readonly pruneClaudeTriggered?: (stillPending: Set<string>) => void,
    // Called for every decision a DETERMINISTIC rule took (auto-approve, auto-reject, auto-reply)
    // so it is recorded and reported to the human channel, exactly like a supervisor decision.
    // Fire-and-forget: reporting must never delay or block applying the decision.
    private readonly onRuleDecision?: (d: RuleDecision) => void,
  ) {}

  start(): void {
    this.disposable = this.sessionManager.onDidChangeSessions((sessions: ClaudeSession[]) => {
      void this.evaluateAll(sessions);
    });
    // Approvals are in-memory in Bob; poll on a fixed tick independent of DB scans.
    if (this.approver) {
      this.approvalTimer = setInterval(() => { void this.sweepApprovals(); }, APPROVAL_SWEEP_MS);
    }
    // Claude approvals live in the ext-host; install the metadata hook once, then
    // poll on its own tick with its own dedup set (never entangles Bob's sweep).
    if (this.claudeApprover) {
      void this.claudeApprover.installHook?.();
      this.claudeApprovalTimer = setInterval(() => { void this.sweepClaudeApprovals(); }, APPROVAL_SWEEP_MS);
    }
  }

  /** Resolve any pending Bob tool-approval prompts per the configured approval
   *  rules. One inspector walk for all tasks — independent of session status.
   *  Deduped per requestId; no matching rule leaves the prompt for the user. */
  async sweepApprovals(): Promise<void> {
    if (this.sweeping || !this.approver) { return; } // avoid overlapping sweeps
    this.sweeping = true;
    try {
      const allRules = this.getRules().filter(r => (r.source ?? 'bob') === 'bob');
      // Still sweep when there are no rules but a supervision trigger is wired — every pending
      // then falls through to onUnhandledPending.
      if (allRules.length === 0 && !this.onUnhandledPending) { return; }

      let pending: PendingApproval[];
      try { pending = await this.approver.listAllPending(); }
      catch (err) { this.log(`listAllPending failed: ${String(err)}`); return; }
      if (pending.length === 0) { return; }

      // Correlate each pending approval's task to its session project path so
      // session-scoped rules can be filtered per task.
      const pathByTask = new Map<string, string>();
      for (const s of this.sessionManager.getSessions()) { pathByTask.set(s.sessionId, s.projectPath); }

      // Prune ids no longer pending so the same requestId can never be re-processed,
      // but a genuinely new request (different id) re-arms naturally.
      const pendingIds = new Set(pending.map(p => p.requestId));
      for (const id of [...this.resolvedRequestIds]) { if (!pendingIds.has(id)) { this.resolvedRequestIds.delete(id); } }
      this.pruneTriggered?.(pendingIds);

      for (const p of pending) {
        if (this.resolvedRequestIds.has(p.requestId)) { continue; }
        // A user-facing question must NEVER be resolved via the approval emitter — that consumes
        // the request and Bob stops rendering its multiple-choice options. Always relay it.
        if (p.toolName === 'ask_followup_question') { this.onUnhandledPending?.(p); continue; }
        const rules = allRules.filter(r => ruleAppliesToSession(r, pathByTask.get(p.taskId)));
        const rule = matchApprovalRule(p, rules);
        if (!rule) {
          // No auto-approve rule → deterministic tier declines it; hand off to the supervisor.
          this.onUnhandledPending?.(p);
          continue;
        }
        this.resolvedRequestIds.add(p.requestId); // mark before emitting to avoid a double-emit race
        const payload = decisionToPayload(rule.decision, p.hasCommandUse);
        this.log(`auto-approve: task ${p.taskId} tool ${p.toolName} matched glob /${rule.toolPattern}/ → ${rule.decision}`);
        try {
          await this.approver.resolve(p.requestId, payload);
          this.reportRule(p, rule, 'bob');
        } catch (err) { this.log(`approval resolve failed for ${p.requestId}: ${String(err)}`); }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Resolve pending Claude tool-permission prompts per configured `source:'claude'`
   *  approval rules. Separate from the Bob sweep: own dedup set, own inspector walk.
   *  v1 does not honor `sessionPattern` for Claude (channel↔session is unmapped);
   *  scoped Claude approval rules are skipped rather than mis-applied. No matching
   *  rule leaves the prompt for the user. */
  async sweepClaudeApprovals(): Promise<void> {
    if (this.claudeSweeping || !this.claudeApprover) { return; } // avoid overlapping sweeps
    this.claudeSweeping = true;
    try {
      const rules = this.getRules().filter(r => r.source === 'claude' && !r.sessionPattern);
      // Still sweep with no rules when a supervisor handoff is wired — every pending then
      // falls through to onUnhandledClaudePending.
      if (rules.length === 0 && !this.onUnhandledClaudePending) { return; }

      // Re-install the metadata-capture hook every sweep (idempotent — it skips already-hooked
      // comms). Claude holds comms in a live per-webview Set (manager.allComms), so a conversation
      // opened AFTER activation has an unhooked comm; the one-time install at start() misses it and
      // its permission requests are never recorded. Re-hooking here wraps any comm added since the
      // last tick, closing the coverage gap for future prompts.
      await this.claudeApprover.installHook?.();

      let pending: PendingApproval[];
      try { pending = await this.claudeApprover.listAllPending(); }
      catch (err) { this.log(`claude listAllPending failed: ${String(err)}`); return; }
      if (pending.length === 0) { return; }

      // Prune ids no longer pending so a new request with the same id could re-arm.
      const pendingIds = new Set(pending.map(p => p.requestId));
      for (const id of [...this.claudeResolvedIds]) { if (!pendingIds.has(id)) { this.claudeResolvedIds.delete(id); } }
      this.pruneClaudeTriggered?.(pendingIds);

      for (const p of pending) {
        if (this.claudeResolvedIds.has(p.requestId)) { continue; }
        // A user-facing question must NEVER be resolved via allow/deny — that answers it
        // wrong. Hand it to the supervisor, which collects the real answer and resolves it
        // natively (mirrors the Bob ask_followup_question guard in sweepApprovals).
        if (p.toolName === 'AskUserQuestion') { this.onUnhandledClaudePending?.(p); continue; }
        // Uncaptured request (send-hook missed its metadata): we know neither the tool nor
        // whether it's a question, so a '*' rule must not silently allow it. Always hand it
        // to the supervisor instead of auto-approving.
        if (!p.toolName) { this.onUnhandledClaudePending?.(p); continue; }
        const rule = matchApprovalRule(p, rules);
        if (!rule) {
          // No auto-approve rule → hand off to the supervisor (or leave for the user).
          this.onUnhandledClaudePending?.(p);
          continue;
        }
        this.claudeResolvedIds.add(p.requestId); // mark before resolving to avoid a double-resolve race
        let inputs: unknown = {};
        try { inputs = JSON.parse(p.argsText); } catch { /* leave {} */ }
        const payload = claudeDecisionToPayload(rule.decision, inputs);
        this.log(`claude auto-approve: tool ${p.toolName} matched glob /${rule.toolPattern}/ → ${rule.decision}`);
        try {
          await this.claudeApprover.resolve(p.requestId, payload);
          this.reportRule(p, rule, 'claude');
        } catch (err) { this.log(`claude approval resolve failed for ${p.requestId}: ${String(err)}`); }
      }
    } finally {
      this.claudeSweeping = false;
    }
  }

  private async evaluateAll(sessions: ClaudeSession[]): Promise<void> {
    if (this.running) { return; } // avoid overlapping scans
    this.running = true;
    try {
      for (const s of sessions) {
        await this.evaluateSession(s);
      }
    } finally {
      this.running = false;
    }
  }

  async evaluateSession(session: ClaudeSession): Promise<void> {
    const sender = session.source === 'claude' ? this.claudeSender : this.sender;
    if (!sender) { return; } // no sender configured for this source → skip

    const rules = this.getRules()
      .filter(r => (r.source ?? 'bob') === session.source)
      .filter(r => ruleAppliesToSession(r, session.projectPath));
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
    try { await sender.send(session.sessionId, rule.response); }
    catch (err) { this.log(`send failed for ${session.sessionId}: ${String(err)}`); return; }
    this.report({
      sessionId: session.sessionId,
      source: session.source,
      kind: 'text',
      pattern: rule.matchPattern,
      response: rule.response,
    });
  }

  /** Report one applied approval rule. */
  private reportRule(p: PendingApproval, rule: ApprovalRule, source: 'bob' | 'claude'): void {
    this.report({
      sessionId: p.taskId,
      source,
      kind: 'approval',
      pattern: rule.toolPattern,
      argumentPattern: rule.argumentPattern,
      decision: rule.decision,
      toolName: p.toolName,
      argsText: p.argsText,
      requestId: p.requestId,
    });
  }

  /**
   * Hand one applied rule decision to the reporter. Never throws: the decision has already
   * reached the agent, so a reporting problem must be logged and dropped, not surfaced as a
   * failure to apply it.
   */
  private report(d: RuleDecision): void {
    if (!this.onRuleDecision) { return; }
    try { this.onRuleDecision(d); }
    catch (err) {
      this.log(`rule decision report failed for ${d.requestId ?? d.sessionId}: ${String(err)}`);
    }
  }

  dispose(): void {
    this.disposable?.dispose();
    if (this.approvalTimer !== undefined) { clearInterval(this.approvalTimer); }
    if (this.claudeApprovalTimer !== undefined) { clearInterval(this.claudeApprovalTimer); }
    this.resolvedRequestIds.clear();
    this.claudeResolvedIds.clear();
    this.lastFired.clear();
  }
}
