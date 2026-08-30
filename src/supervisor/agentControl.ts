/**
 * Deliver supervisor guidance back to the coding agent.
 *
 * Ported from the Python supervisor (`agent_control.py`. The orchestrator writes a labeled delivery
 * to `<stateDir>/outbox/<deliveryId>.json`; the extension's `SupervisorOutbox` watcher reads it
 * and applies it — through the agent's approval emitter for a prompt-blocked task, or as an
 * injected chat message for an idle one. This module owns the *write* side + the outbox
 * contract; the outbox owns the applying. Messages are never phrased as the user.
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SUPERVISOR_LABEL } from './messaging';

export class DeliveryFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryFailed';
  }
}

export type DeliveryKind =
  | 'yellow_guidance' | 'red_block' | 'reject_approval' | 'approve_approval'
  | 'timeout_fallback' | 'answer_question' | 'orange_alternatives' | 'user_relay'
  | 'telegram_message' | string;

export type DeliveryChannel = 'message' | 'approval' | 'question';

export interface Delivery {
  deliveryId: string;
  sessionId: string;
  source: string;
  text: string;
  kind: DeliveryKind;
  /** When set, the extension resolves this via the agent's approval emitter instead of
   *  injecting a chat message — the only channel that reaches a task blocked at a prompt. */
  requestId: string | null;
  channel: DeliveryChannel;
  /** approval-channel decision. */
  decision: 'reject' | 'allow';
  /** question-channel: chosen labels per question text (answers a question natively). */
  answers: Record<string, string[]> | null;
}

export interface DeliverArgs {
  sessionId: string;
  source: string;
  text: string;
  kind: DeliveryKind;
  requestId?: string | null;
  decision?: 'reject' | 'allow';
  answers?: Record<string, string[]> | null;
  channel?: DeliveryChannel | null;
}

function labeled(text: string): string {
  const t = text.trim();
  return t.startsWith(SUPERVISOR_LABEL) ? t : `${SUPERVISOR_LABEL} ${t}`;
}

/**
 * Stable per (session, kind, text, requestId) so a re-run dedupes downstream, while distinct
 * approval requests get distinct deliveries.
 */
export function deliveryId(
  sessionId: string, kind: string, text: string, requestId: string | null,
): string {
  const digest = createHash('sha1')
    .update(`${sessionId}:${kind}:${requestId ?? ''}:${text}`, 'utf8')
    .digest('hex').slice(0, 12);
  return `del-${digest}`;
}

export function buildDelivery(args: DeliverArgs): Delivery {
  // A question answer reads as the user's own choice, so it is NOT labeled as the supervisor;
  // every other delivery carries the supervisor label.
  const text = args.kind === 'answer_question' ? args.text.trim() : labeled(args.text);
  const requestId = args.requestId ?? null;
  const channel: DeliveryChannel = args.channel ?? (requestId ? 'approval' : 'message');
  return {
    deliveryId: deliveryId(args.sessionId, args.kind, text, requestId),
    sessionId: args.sessionId,
    source: args.source,
    text,
    kind: args.kind,
    requestId,
    channel,
    decision: args.decision ?? 'reject',
    answers: args.answers ?? null,
  };
}

export interface AgentController {
  /**
   * Deliver a supervisor intervention toward the agent. Returns the Delivery.
   * With `requestId` the delivery targets the agent's approval emitter (resolve the live prompt
   * with `decision`); without it, a labeled chat message (idle task).
   */
  deliver(args: DeliverArgs): Promise<Delivery>;
}

/** Writes one JSON delivery per message into `outbox/` for the extension bridge. */
export class OutboxAgentController implements AgentController {
  constructor(
    private readonly outboxDir: string,
    /** Called after each successful write so the applier can run immediately instead of on its
     *  next poll tick. Optional; failures are swallowed (the poll timer is the safety net). */
    private readonly onDelivered?: () => void,
  ) {
    fs.mkdirSync(this.outboxDir, { recursive: true });
  }

  async deliver(args: DeliverArgs): Promise<Delivery> {
    const delivery = buildDelivery(args);
    const payload = {
      deliveryId: delivery.deliveryId,
      sessionId: delivery.sessionId,
      source: delivery.source,
      text: delivery.text,
      kind: delivery.kind,
      requestId: delivery.requestId,
      channel: delivery.channel,
      decision: delivery.decision,
      answers: delivery.answers,
    };
    const target = path.join(this.outboxDir, `${delivery.deliveryId}.json`);
    // Atomic write so the applier never reads a half-written file.
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
    try { this.onDelivered?.(); } catch { /* the poll timer still covers it */ }
    return delivery;
  }
}

/** Test controller: records deliveries in memory, no filesystem / extension. */
export class RecordOnlyController implements AgentController {
  readonly deliveries: Delivery[] = [];

  async deliver(args: DeliverArgs): Promise<Delivery> {
    const delivery = buildDelivery(args);
    this.deliveries.push(delivery);
    return delivery;
  }
}
