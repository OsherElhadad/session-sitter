import { callOnBobTaskManager } from './BobInspector';

export type ApprovalDecision = 'approveOnce' | 'approveForTask' | 'reject';

export interface PendingApproval {
  requestId: string;    // the key we emit to resolve the request
  toolName: string;     // usage.signature.name, e.g. "glob", "execute_command"
  argsText: string;     // JSON of usage.signature.arguments, for argumentPattern matching + logging
  permission: string;   // usage.permission: read | execute | write | edit | mcp
  hasCommandUse: boolean; // true for execute-style tools; drives approveForTask persistence
  taskId: string;       // owning Bob task id (for logging / correlation)
  captured?: boolean;   // Claude only: false when tool metadata was missed by the send-hook
                        // (an empty toolName → never auto-approve, force a supervisor handoff)
}

export interface BobApprover {
  /** Every pending tool-approval request across all open Bob tasks. One inspector
   *  walk; independent of session status (a waiting task always has an open manager). */
  listAllPending(): Promise<PendingApproval[]>;
  /** Resolve one pending request by emitting the decision payload (as a button click would).
   *  Returns the emitter result: 'ok' when the request was found and resolved, 'notfound'
   *  otherwise, so callers can confirm the block actually landed (fail loud, not silent). */
  resolve(requestId: string, payload: Record<string, unknown>): Promise<string>;
}

/**
 * Pure: map an approval decision to the payload Bob's `applyApprovalResponse`
 * consumes (verified against the bundle + the 2026-07-15 spike).
 *  - approveOnce   → proceed this once
 *  - reject        → cancel the operation
 *  - approveForTask→ proceed AND persist: the permission group always; for
 *                    execute-style tools also persist the specific command.
 */
export function decisionToPayload(decision: ApprovalDecision, hasCommandUse: boolean): Record<string, unknown> {
  switch (decision) {
    case 'approveOnce': return { allowOnce: true };
    case 'reject': return { allowOnce: false };
    case 'approveForTask':
      return hasCommandUse
        ? { allowOnce: true, groupApproved: true, alwaysApproveCommand: true }
        : { allowOnce: true, groupApproved: true };
  }
}

// Injected into Bob's ext-host with `this` = the TaskManager (Nh). Enumerates all
// chat managers (robust — does not rely on getChatManagerByTaskId or session
// status) and returns every pending approval, tagged with its task id, as JSON.
const LIST_ALL_FN = `function(){
  const mgrs = this._chatManagers || [];
  const out = [];
  for (const m of mgrs) {
    let tid = '';
    try { const ids = (m.currentTasks || []).map(t => t.getId()); tid = ids[0] || ''; } catch (e) {}
    const w = (m.approvalHandler && m.approvalHandler.requestsWaiting) || [];
    for (const r of w) {
      out.push({
        taskId: tid,
        requestId: r.requestId,
        toolName: (r.usage && r.usage.signature && r.usage.signature.name) || '',
        argsText: JSON.stringify((r.usage && r.usage.signature && r.usage.signature.arguments) || {}),
        permission: (r.usage && r.usage.permission) || '',
        hasCommandUse: !!(r.usage && r.usage.commandUse)
      });
    }
  }
  return JSON.stringify(out);
}`;

// Finds the manager holding `requestId` and emits the decision payload on its
// approval requestEmitter — the exact join point a real button click funnels
// through. Returns 'ok' / 'notfound'.
const RESOLVE_FN = `function(requestId, payload){
  const mgrs = this._chatManagers || [];
  for (const m of mgrs) {
    const w = (m.approvalHandler && m.approvalHandler.requestsWaiting) || [];
    if (w.some(r => r.requestId === requestId)) {
      m.approvalHandler.requestEmitter.emit(requestId, payload);
      return 'ok';
    }
  }
  return 'notfound';
}`;

export class InspectorBobApprover implements BobApprover {
  constructor(private readonly log: (msg: string) => void) {}

  async listAllPending(): Promise<PendingApproval[]> {
    const raw = await callOnBobTaskManager(this.log, LIST_ALL_FN, [], false);
    if (typeof raw !== 'string') { return []; }
    try {
      const parsed = JSON.parse(raw) as PendingApproval[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async resolve(requestId: string, payload: Record<string, unknown>): Promise<string> {
    const result = await callOnBobTaskManager(this.log, RESOLVE_FN, [requestId, payload], false);
    const outcome = typeof result === 'string' ? result : 'error';
    this.log(`approval resolve ${requestId} → ${outcome}`);
    return outcome;
  }
}
