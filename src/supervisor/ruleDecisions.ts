/**
 * Make the DETERMINISTIC tier's decisions as visible as the supervisor's.
 *
 * `sessionSitter.autoRespond` rules resolve tool prompts and send canned replies without ever
 * reaching the supervisor. Those are real interventions in the user's session, so they belong in
 * the same two places every supervisor decision goes: the panel's activity feed (a record under
 * `<stateDir>/records/`) and the human channel (a one-way Telegram update).
 *
 * This writes exactly the same record shape the orchestrator writes, with `decided_by: 'rule'`
 * and a `rule` trace, so the feed reader, the record viewer, and the Telegram card builder all
 * work unchanged.
 *
 * Nothing here may ever throw into the caller: a failed record write or a failed notification
 * must not stop an auto-approve from reaching a blocked agent.
 */

import { SupervisorConfig } from './config';
import { DeliveryError, MessagingChannel } from './messaging';
import {
  AssessmentInput,
  DecidedBy,
  RuleTrace,
  SupervisionRecord,
  SupervisionState,
  TrafficLight,
} from './models';
import { StateStore } from './store';
import { toIso } from './timeutil';

/** One deterministic intervention, as reported by the auto-responder. */
export interface RuleDecision {
  /** The agent session the rule acted on (Bob taskId / Claude sessionId). */
  sessionId: string;
  /** 'bob' | 'claude' */
  source: string;
  /** 'approval' resolved a pending tool prompt; 'text' sent a canned reply. */
  kind: 'approval' | 'text';
  /** The rule pattern that matched (toolPattern glob, or matchPattern regex for a text rule). */
  pattern: string;
  /** Optional narrowing regex over the pending arguments JSON (approval rules). */
  argumentPattern?: string;
  /** approveOnce | approveForTask | reject (approval rules). */
  decision?: string;
  /** The text sent into the session (text rules). */
  response?: string;
  /** The pending tool name (approval rules). */
  toolName?: string;
  /** The pending arguments as JSON (approval rules) — used for the human-readable detail. */
  argsText?: string;
  /** The live approval requestId, recorded for traceability. */
  requestId?: string;
  /** What the user originally asked, when the caller can cheaply supply it. */
  userIntent?: string;
}

/** Traffic light a rule outcome maps to: approve → green, reject → red, canned reply → yellow. */
export function ruleLight(d: RuleDecision): TrafficLight {
  if (d.kind === 'text') { return TrafficLight.YELLOW; }
  return d.decision === 'reject' ? TrafficLight.RED : TrafficLight.GREEN;
}

/** A short human phrase for what the rule did — reused by the summary and the notification. */
export function ruleOutcomeLabel(d: RuleDecision): string {
  if (d.kind === 'text') { return 'auto-replied'; }
  switch (d.decision) {
    case 'reject': return 'auto-rejected';
    case 'approveForTask': return 'auto-approved (for the rest of the task)';
    default: return 'auto-approved';
  }
}

/** What the rule acted on: `tool(args…)` for an approval, the sent text for a text rule. */
export function ruleActionLabel(d: RuleDecision): string {
  if (d.kind === 'text') { return `reply: ${truncate(d.response ?? '', 120)}`; }
  const tool = d.toolName || 'unknown tool';
  const args = (d.argsText ?? '').trim();
  return args && args !== '{}' ? `${tool}(${truncate(args, 120)})` : tool;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The rule trace persisted on the record (snake_case, like every other record field). */
export function ruleTrace(d: RuleDecision): RuleTrace {
  return {
    kind: d.kind,
    pattern: d.pattern,
    argument_pattern: d.argumentPattern ?? null,
    decision: d.decision ?? null,
    response: d.response ?? null,
    tool_name: d.toolName ?? null,
  };
}

/**
 * A schema-shaped assessment for a rule decision. It is NOT a model output — `confidence` is 1.0
 * because the rule is deterministic, and the summary names the rule so the user can find and
 * change the setting that caused it.
 */
export function ruleAssessment(d: RuleDecision): AssessmentInput {
  const light = ruleLight(d);
  const outcome = ruleOutcomeLabel(d);
  const action = ruleActionLabel(d);
  const patternLabel = d.kind === 'text' ? `/${d.pattern}/` : `'${d.pattern}'`;
  const argsNote = d.argumentPattern ? ` + args /${d.argumentPattern}/` : '';
  return {
    traffic_light: light,
    confidence: 1.0,
    summary: `Rule ${outcome}: ${action}.`,
    agent_intent: action,
    user_intent: d.userIntent || '(unknown)',
    waiting_reason: d.kind === 'approval' ? 'awaiting approval' : 'awaiting a reply',
    issues: [],
    recommended_action: `Matched your auto-respond rule ${patternLabel}${argsNote}.`,
    supervisor_message_to_agent: null,
    human_notification:
      `Deterministic rule ${patternLabel}${argsNote} ${outcome}: ${action}. `
      + 'No supervisor decision was needed. Change it under '
      + '`sessionSitter.autoRespond` if this is not what you want.',
    human_options: [],
    allowed_actions_while_waiting: [],
    blocked_actions: d.decision === 'reject' ? [action] : [],
    should_block_agent: false,
    should_block_original_action: d.decision === 'reject',
    transitioned_from: null,
    transition_reason: null,
  };
}

export interface RuleDecisionRecorderOptions {
  store: StateStore;
  channel: MessagingChannel;
  config: Pick<SupervisorConfig, 'notifyRuleDecisions'>;
  log?: (msg: string) => void;
}

/**
 * Records deterministic rule decisions and reports them to the human channel.
 *
 * Deduped per `requestId` so a rule that fires once is reported once, even if the caller retries.
 */
export class RuleDecisionRecorder {
  private readonly store: StateStore;
  private readonly channel: MessagingChannel;
  private readonly notify: boolean;
  private readonly log: (msg: string) => void;
  private readonly reported = new Set<string>();

  constructor(opts: RuleDecisionRecorderOptions) {
    this.store = opts.store;
    this.channel = opts.channel;
    this.notify = opts.config.notifyRuleDecisions;
    this.log = opts.log ?? (() => { /* silent */ });
  }

  /**
   * Persist one rule decision as a supervision record and post a one-way update. Returns the
   * record, or undefined when it was already reported or the write failed. Never throws.
   */
  async report(d: RuleDecision): Promise<SupervisionRecord | undefined> {
    const dedupKey = d.requestId ?? `${d.sessionId}:${d.kind}:${d.pattern}:${d.response ?? ''}`;
    if (this.reported.has(dedupKey)) { return undefined; }
    this.reported.add(dedupKey);
    // Bound the dedup set: rules can fire indefinitely over a long-lived window.
    if (this.reported.size > 5000) {
      for (const k of [...this.reported].slice(0, 2500)) { this.reported.delete(k); }
    }

    let record: SupervisionRecord;
    try {
      record = await this.store.create(d.sessionId, d.source);
      record.decided_by = DecidedBy.RULE;
      record.rule = ruleTrace(d);
      record.pending_request_id = d.requestId ?? null;
      record.assessment = ruleAssessment(d);
      record.state = SupervisionState.RULE_APPLIED;
      record.blocked_actions = d.decision === 'reject' ? [ruleActionLabel(d)] : [];
      record.should_block_original_action = d.decision === 'reject';
      record.events.push({
        type: 'rule_applied',
        at: toIso(new Date()),
        kind: d.kind,
        pattern: d.pattern,
        decision: d.decision ?? null,
      });
      await this.store.save(record);
    } catch (err) {
      this.reported.delete(dedupKey); // let a later sweep retry the record
      this.log(`rule decision: failed to record ${d.pattern}: ${String(err)}`);
      return undefined;
    }

    if (!this.notify) { return record; }
    const text = String(record.assessment?.human_notification ?? '');
    try {
      const res = await this.channel.send(record, text, false); // one-way: never a decision card
      record.notification_id = res.messageId;
      record.notified_at = res.sentAt;
      await this.store.save(record);
    } catch (err) {
      if (!(err instanceof DeliveryError)) {
        this.log(`rule decision: unexpected notify error: ${String(err)}`);
      }
      record.events.push({
        type: 'rule_notify_failed', at: toIso(new Date()), error: String(err),
      });
      try { await this.store.save(record); } catch { /* best-effort */ }
      this.log(`rule decision: notify failed for ${record.request_id}: ${String(err)}`);
    }
    return record;
  }
}
