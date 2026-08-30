import * as fs from 'fs';
import * as path from 'path';
import { BobSender, type MessageSender } from './agents/BobSender';
import { BobApprover, decisionToPayload } from './agents/BobApprover';
import { claudeDecisionToPayload } from './agents/ClaudeApprover';

/**
 * Bridges the Python supervisor's interventions to the running Bob task.
 *
 * The supervisor writes one JSON delivery per intervention to `<stateDir>/outbox/<deliveryId>.json`.
 * Two delivery channels, chosen by whether a `requestId` is present:
 *  - `requestId` set (approval channel): Bob is blocked at a tool-approval prompt — resolve it
 *    (reject) through Bob's approval emitter via `BobApprover.resolve`. This is the ONLY channel
 *    that reaches a prompt-blocked task; `handleInputMessage` silently no-ops there.
 *  - no `requestId` (message channel): an idle task — inject a labeled chat message via `BobSender.send`.
 *
 * A delivery is moved to `outbox/done/` only on a CONFIRMED apply, so a failed/`notfound`
 * resolve is retried rather than silently marked done.
 */

export interface OutboxDelivery {
  deliveryId: string;
  sessionId: string;
  source: string;
  text: string;
  kind: string;
  requestId: string | null;
  channel: string; // "approval" | "message" | "question"
  decision: 'allow' | 'reject'; // approval-channel decision (default reject)
  answers?: Record<string, string[]>; // question-channel: chosen labels per question text
}

export function parseDelivery(raw: string): OutboxDelivery | null {
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (typeof d.deliveryId !== 'string' || typeof d.sessionId !== 'string' || typeof d.text !== 'string') {
    return null;
  }
  const requestId = typeof d.requestId === 'string' && d.requestId ? d.requestId : null;
  const answers = (d.answers && typeof d.answers === 'object' && !Array.isArray(d.answers))
    ? d.answers as Record<string, string[]>
    : undefined;
  return {
    deliveryId: d.deliveryId,
    sessionId: d.sessionId,
    source: typeof d.source === 'string' ? d.source : 'bob',
    text: d.text,
    kind: typeof d.kind === 'string' ? d.kind : 'guidance',
    requestId,
    channel: typeof d.channel === 'string' ? d.channel : (requestId ? 'approval' : 'message'),
    decision: d.decision === 'allow' ? 'allow' : 'reject',
    answers,
  };
}

export class SupervisorOutbox {
  private readonly _doneDir: string;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _watcher: fs.FSWatcher | undefined;
  private _polling = false;

  constructor(
    private readonly outboxDir: string,
    private readonly sender: BobSender,
    private readonly log: (msg: string) => void = () => { /* noop */ },
    private readonly approver?: BobApprover,
    // Resolves the "@active" sentinel to a concrete Bob session id (most-recent Bob task).
    // Used for Telegram messages the user sends that should go straight to Bob.
    private readonly resolveActiveSession?: () => string | undefined,
    // Sender/approver for source:"claude" deliveries (supervisor guidance into Claude).
    private readonly claudeSender?: MessageSender,
    private readonly claudeApprover?: BobApprover,
  ) {
    this._doneDir = path.join(outboxDir, 'done');
  }

  start(intervalMs = 1500): void {
    fs.mkdirSync(this.outboxDir, { recursive: true });
    fs.mkdirSync(this._doneDir, { recursive: true });
    // Interval is the safety net; the fs.watch below applies a new delivery near-instantly so a
    // Telegram approve/reject reaches Bob within a fraction of a second.
    this._timer = setInterval(() => { void this.poll(); }, intervalMs);
    try {
      this._watcher = fs.watch(this.outboxDir, () => { void this.poll(); });
    } catch { /* dir may not exist yet; the interval still covers it */ }
  }

  dispose(): void {
    if (this._timer !== undefined) { clearInterval(this._timer); this._timer = undefined; }
    if (this._watcher !== undefined) { this._watcher.close(); this._watcher = undefined; }
  }

  /** One pass: inject every pending delivery, then move it to done/. Returns count injected. */
  async poll(): Promise<number> {
    if (this._polling) { return 0; } // avoid overlapping passes
    this._polling = true;
    let injected = 0;
    try {
      fs.mkdirSync(this._doneDir, { recursive: true });
      let files: string[];
      try {
        files = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json'));
      } catch {
        return 0; // outbox dir not created yet
      }
      // Apply approval-channel deliveries (reject/approve) BEFORE message-channel ones, so a
      // blocked prompt is resolved (unblocking Bob) before we inject the user's relayed message
      // — otherwise the message no-ops against a prompt-blocked task and is lost.
      const parsed = files.sort().map(file => ({
        file, full: path.join(this.outboxDir, file),
        delivery: (() => { try { return parseDelivery(fs.readFileSync(path.join(this.outboxDir, file), 'utf8')); } catch { return null; } })(),
      }));
      parsed.sort((a, b) => Number(!a.delivery?.requestId) - Number(!b.delivery?.requestId));
      for (const { file, full, delivery } of parsed) {
        if (!delivery) { this.log(`outbox: skipping malformed ${file}`); this._archive(full, file); continue; }
        const isClaude = delivery.source === 'claude';
        if (delivery.source !== 'bob' && !isClaude) {
          this.log(`outbox: skipping delivery ${delivery.deliveryId} (unknown source=${delivery.source})`);
          this._archive(full, file);
          continue;
        }
        const activeSender: MessageSender = isClaude ? (this.claudeSender ?? this.sender) : this.sender;
        const activeApprover = isClaude ? this.claudeApprover : this.approver;
        try {
          if (delivery.channel === 'question') {
            // Question channel (Claude): answer the AskUserQuestion natively via resolveQuestion.
            const capp = activeApprover as (BobApprover & {
              resolveQuestion?: (id: string, a: Record<string, string[]>) => Promise<string>;
            }) | undefined;
            if (!isClaude || !capp?.resolveQuestion) {
              this.log(`outbox: question delivery ${delivery.deliveryId} needs a claude approver with resolveQuestion; retry`);
              continue;
            }
            if (!delivery.requestId) {
              this.log(`outbox: question ${delivery.deliveryId} missing requestId; archiving`);
              this._archive(full, file);
              continue;
            }
            const outcome = await capp.resolveQuestion(delivery.requestId, delivery.answers ?? {});
            if (outcome === 'ok') {
              injected++;
              this.log(`outbox: answered claude question ${delivery.requestId} (${delivery.deliveryId})`);
              this._archive(full, file);
            } else {
              this.log(`outbox: resolveQuestion ${delivery.requestId} → ${outcome}; leaving ${delivery.deliveryId} for retry`);
            }
            continue;
          }
          if (delivery.requestId) {
            // Approval channel: resolve the pending prompt through the source's approver.
            // Archive only on a confirmed 'ok' — 'notfound'/failure is left for the next pass.
            if (isClaude && !this.claudeSender) {
              this.log(`outbox: claude delivery ${delivery.deliveryId} but no claude sender/approver wired; retry`);
              continue;
            }
            if (!activeApprover) {
              this.log(`outbox: ${delivery.deliveryId} needs an approver but none is wired; leaving for retry`);
              continue;
            }
            const approvalDecision = delivery.decision === 'allow' ? 'approveOnce' : 'reject';
            const payload = isClaude
              ? claudeDecisionToPayload(approvalDecision, {})
              : decisionToPayload(approvalDecision, false);
            const outcome = await activeApprover.resolve(delivery.requestId, payload);
            if (outcome === 'ok') {
              injected++;
              this.log(`outbox: ${delivery.decision === 'allow' ? 'approved' : 'rejected'} ${delivery.source} approval ${delivery.requestId} (${delivery.deliveryId})`);
              this._archive(full, file);
            } else {
              this.log(`outbox: resolve ${delivery.requestId} → ${outcome}; leaving ${delivery.deliveryId} for retry`);
            }
          } else {
            // Message channel: inject a labeled chat message into a session. "@active" resolves to
            // the most-recent Bob session (Claude ignores the target — single-channel v1).
            let target = delivery.sessionId;
            if (target === '@active') {
              if (isClaude) {
                target = 'claude-active'; // ClaudeSender ignores the id (writes the sole channel)
              } else {
                const resolved = this.resolveActiveSession?.();
                if (!resolved) { this.log(`outbox: no active Bob session for ${delivery.deliveryId}; retry`); continue; }
                target = resolved;
              }
            }
            if (isClaude && !this.claudeSender) {
              this.log(`outbox: claude message ${delivery.deliveryId} but no claude sender wired; retry`);
              continue;
            }
            await activeSender.send(target, delivery.text);
            injected++;
            this.log(`outbox: injected ${delivery.source} ${delivery.deliveryId} into ${target}`);
            this._archive(full, file);
          }
        } catch (err) {
          // Leave the file in place to retry on the next pass.
          this.log(`outbox: delivery failed for ${delivery.deliveryId}: ${String(err)}`);
        }
      }
    } finally {
      this._polling = false;
    }
    return injected;
  }

  private _archive(fullPath: string, file: string): void {
    try { fs.renameSync(fullPath, path.join(this._doneDir, file)); } catch { /* ignore */ }
  }
}
