/**
 * Messaging boundary for human-in-the-loop notifications.
 *
 * Ported from `reckon_supervisor/messaging.py`. `StubChannel` writes notifications to files and
 * reads simulated replies from `inbox/<requestId>.txt`, so the full Orange lifecycle is
 * exercisable with no network. `TelegramChannel` (telegram.ts) is the real channel. Correlation,
 * dedupe, and failure handling live in the orchestrator/store — not here — so they hold for
 * every channel.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SupervisionRecord } from './models';
import { Clock, nowUtc, toIso } from './timeutil';

export const SUPERVISOR_LABEL = '[Session Supervisor]';

/** Raised when an outbound notification cannot be delivered. */
export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export interface SendResult {
  messageId: string;
  sentAt: string; // ISO 8601
}

export interface InboundResponse {
  updateId: string;      // stable id for dedupe
  correlationId: string; // == supervision request id, or the "@active" sentinel
  text: string;
  receivedAt: string;
}

export interface MessagingChannel {
  /**
   * Deliver a notification. `interactive = true` (orange/red) asks for a decision (buttons +
   * timer); `interactive = false` (green/yellow) is a one-way update. Throws `DeliveryError`
   * on failure.
   */
  send(record: SupervisionRecord, notification: string, interactive?: boolean): Promise<SendResult>;
  /** Return replies correlated to the given pending records (by request id). */
  pollResponses(pending: SupervisionRecord[]): Promise<InboundResponse[]>;
  /** Optional: tick the countdown on awaiting cards. */
  refreshTimers?(pending: SupervisionRecord[]): Promise<void>;
  /** Optional: one-time setup before polling (e.g. clearing a stale webhook). */
  ensurePollingReady?(): Promise<void>;
}

/**
 * Prefix a notification with the supervisor label + a session reference. Never phrased as the
 * user or as the agent — this is unambiguously a supervisor notification.
 */
export function formatNotification(record: SupervisionRecord, notification: string): string {
  return (
    `${SUPERVISOR_LABEL} human input needed\n`
    + `session: ${record.session_id}\n`
    + `reply id: ${record.request_id}\n\n`
    + `${notification}`
  );
}

/** Logs notifications to files; reads simulated replies from `inbox/<requestId>.txt`. */
export class StubChannel implements MessagingChannel {
  constructor(
    private readonly notificationsDir: string,
    private readonly inboxDir: string,
    private readonly clock: Clock = nowUtc,
    private readonly log: (msg: string) => void = () => { /* silent by default */ },
  ) {
    fs.mkdirSync(this.notificationsDir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  async send(record: SupervisionRecord, notification: string): Promise<SendResult> {
    const sentAt = toIso(this.clock());
    const body = formatNotification(record, notification);
    await fs.promises.writeFile(
      path.join(this.notificationsDir, `${record.request_id}.txt`), body, 'utf8');
    this.log(`\n=== NOTIFICATION (stub) ===\n${body}\n===========================\n`);
    return { messageId: `stub-${record.request_id}`, sentAt };
  }

  async pollResponses(pending: SupervisionRecord[]): Promise<InboundResponse[]> {
    const out: InboundResponse[] = [];
    for (const record of pending) {
      const drop = path.join(this.inboxDir, `${record.request_id}.txt`);
      let text: string;
      try {
        text = (await fs.promises.readFile(drop, 'utf8')).trim();
      } catch {
        continue;
      }
      const digest = createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
      out.push({
        updateId: `${record.request_id}:${digest}`,
        correlationId: record.request_id,
        text,
        receivedAt: toIso(this.clock()),
      });
    }
    return out;
  }
}

/** In-memory channel for tests. Records sends; returns queued replies. */
export class FakeChannel implements MessagingChannel {
  readonly sent: Array<{ requestId: string; notification: string; interactive: boolean }> = [];
  fail = false;
  private readonly queued = new Map<string, string[]>();
  private counter = 0;

  constructor(fail = false, private readonly clock: Clock = nowUtc) {
    this.fail = fail;
  }

  queueResponse(correlationId: string, text: string): void {
    const list = this.queued.get(correlationId) ?? [];
    list.push(text);
    this.queued.set(correlationId, list);
  }

  async send(
    record: SupervisionRecord, notification: string, interactive = true,
  ): Promise<SendResult> {
    if (this.fail) { throw new DeliveryError('simulated delivery failure'); }
    this.sent.push({ requestId: record.request_id, notification, interactive });
    this.counter++;
    return { messageId: `fake-${this.counter}`, sentAt: toIso(this.clock()) };
  }

  async pollResponses(pending: SupervisionRecord[]): Promise<InboundResponse[]> {
    const pendingIds = new Set(pending.map(r => r.request_id));
    const out: InboundResponse[] = [];
    for (const [cid, texts] of [...this.queued.entries()]) {
      // "@active" = a general message (not tied to a card) — always delivered.
      if (!pendingIds.has(cid) && cid !== '@active') { continue; }
      texts.forEach((text, i) => {
        const digest = createHash('sha1').update(`${cid}:${i}:${text}`, 'utf8').digest('hex').slice(0, 12);
        out.push({
          updateId: `${cid}:${digest}`,
          correlationId: cid,
          text,
          receivedAt: toIso(this.clock()),
        });
      });
    }
    return out;
  }
}
