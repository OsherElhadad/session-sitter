import * as vscode from 'vscode';
import { callOnBobTaskManager, pickClosureTaskManager } from './BobInspector';
import type { ApprovalDecision } from './BobApprover';

// Re-export so existing importers/tests keep their import path.
export { pickClosureTaskManager };

/** Rule that replies with text to a matching assistant message. */
export interface TextRule {
  matchPattern: string;
  response: string;
  sessionPattern?: string;    // optional JS regex; rule applies only to sessions whose projectPath matches
  source?: 'bob' | 'claude';  // which IDE the rule applies to (default 'bob')
}

/** Rule that resolves a matching pending tool-approval prompt. */
export interface ApprovalRule {
  toolPattern: string;        // glob against the pending tool name ('*' = any, '|' = alternatives)
  argumentPattern?: string;   // optional JS regex against the tool arguments (JSON)
  decision: ApprovalDecision; // approveOnce | approveForTask | reject
  sessionPattern?: string;    // optional JS regex; rule applies only to sessions whose projectPath matches
  source?: 'bob' | 'claude';  // which IDE the rule applies to (default 'bob')
}

/** A single unified auto-respond rule: either a text reply or an approval. */
export type AutoRespondRule = TextRule | ApprovalRule;

/** True when the rule is a text-reply rule. */
export function isTextRule(rule: AutoRespondRule): rule is TextRule {
  return typeof (rule as TextRule).matchPattern === 'string'
    && typeof (rule as TextRule).response === 'string';
}

/** True when the rule is an approval rule. */
export function isApprovalRule(rule: AutoRespondRule): rule is ApprovalRule {
  return typeof (rule as ApprovalRule).toolPattern === 'string'
    && typeof (rule as ApprovalRule).decision === 'string';
}

export interface BobSender {
  /** Send `text` as a user message into the existing Bob task `taskId`. */
  send(taskId: string, text: string): Promise<void>;
  /** Cheap capability probe: can we reach Bob's API at all? */
  isAvailable(): Promise<boolean>;
}

/** A sender that injects a user message into an existing session — Bob or Claude.
 *  Structurally identical to BobSender; the alias documents cross-IDE reuse. */
export type MessageSender = BobSender;

/** Pure guard: only attempt an injection for a non-empty task id + message. Isolated for
 *  testing so the fragile inspector path is never entered with junk input. */
export function shouldAttemptSend(taskId: unknown, text: unknown): boolean {
  return typeof taskId === 'string' && taskId.trim().length > 0
    && typeof text === 'string' && text.trim().length > 0;
}

const SEND_FN =
  'function(taskId, text){ return Promise.resolve(this.openTask({taskId})).then(m => m.handleInputMessage({type:"userMessage", content:text, mode:"agent", meta:{mask:text}})); }';

export class InspectorBobSender implements BobSender {
  constructor(private readonly log: (msg: string) => void) {}

  async isAvailable(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
    if (!bobExt) { return false; }
    const api = bobExt.isActive ? bobExt.exports : await Promise.resolve(bobExt.activate()).catch(() => undefined);
    return typeof api?.startTask === 'function';
  }

  async send(taskId: string, text: string): Promise<void> {
    if (!shouldAttemptSend(taskId, text)) {
      this.log('send skipped: empty taskId or text');
      return;
    }
    // openTask({taskId}) loads the task from Bob's shared DB and attaches it;
    // handleInputMessage sends the message into that existing conversation.
    // awaitPromise ensures the message is delivered before the inspector detaches.
    await callOnBobTaskManager(this.log, SEND_FN, [taskId, text], true);
    this.log(`sent to task ${taskId}`);
  }
}
