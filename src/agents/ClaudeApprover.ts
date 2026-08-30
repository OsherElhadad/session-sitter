import { callOnClaudeManager } from './ClaudeInspector';
import type { BobApprover, PendingApproval, ApprovalDecision } from './BobApprover';

/**
 * Pure: map an approval decision to the response payload Claude's permission
 * deferred consumes. Confirmed from the bundle (v2.1.138):
 * `requestToolPermission` returns `O.result`, where `O` is the value the
 * deferred is resolved with — i.e. `{ result: <PermissionResult> }` and a
 * PermissionResult is `{behavior:"allow", updatedInput}` or
 * `{behavior:"deny", message}`.
 *
 *  - approveOnce / approveForTask → allow (Claude has no per-task persistence via
 *    this path, so both map to allow; `updatedInput` echoes the original inputs).
 *  - reject → deny with a message.
 */
export function claudeDecisionToPayload(
  decision: ApprovalDecision,
  inputs: unknown,
): Record<string, unknown> {
  if (decision === 'reject') {
    return { result: { behavior: 'deny', message: 'Denied by the session supervisor' } };
  }
  return { result: { behavior: 'allow', updatedInput: inputs ?? {} } };
}

// Global (in Claude's ext-host) where the send-hook records requestId →
// {toolName, inputs} for tool_permission_request payloads, since the
// outstandingRequests deferred itself carries no tool metadata.
const PERMS_GLOBAL = '__csw_claudePerms';

// Idempotently wrap each comm's `send` so tool_permission_request payloads are
// recorded before they reach the webview. Defensive: always calls the original,
// never throws. Must be installed BEFORE a prompt is created to capture it.
const INSTALL_HOOK_FN = `function(){
  try {
    if (!globalThis.${PERMS_GLOBAL}) globalThis.${PERMS_GLOBAL} = new Map();
    var store = globalThis.${PERMS_GLOBAL};
    var n = 0;
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
      if (!comm || comm.__csw_sendHooked) return;
      var orig = comm.send;
      if (typeof orig !== 'function') return;
      comm.send = function(m){
        try {
          if (m && m.type === 'request' && m.request && m.request.type === 'tool_permission_request') {
            store.set(m.requestId, { toolName: m.request.toolName, inputs: m.request.inputs });
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      comm.__csw_sendHooked = true; n++;
    });
    return 'hooked:' + n;
  } catch (e) { return 'err:' + String(e); }
}`;

// List every pending request across all comms, joined with the captured metadata.
// A request WITH captured metadata carries its real toolName/inputs. A request
// WITHOUT metadata (the send-hook was installed after it was sent, or on a comm
// added later) is still surfaced — with an empty toolName — so a prompt that
// predates the hook is handed to the supervisor rather than silently stranded.
// `outstandingRequests` only holds sendRequest-based prompts (tool_permission_request /
// user_dialog_request), not fire-and-forget RPCs (auth_url/update_state go through a
// bare `send` with no resolver), so surfacing uncaptured entries does not leak generic
// RPCs. Consumers must NOT auto-approve an empty toolName (unknown → force handoff).
// Prunes stale metadata entries.
const LIST_FN = `function(){
  try {
    var store = globalThis.${PERMS_GLOBAL} || new Map();
    var out = [];
    var liveIds = new Set();
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
      var reqs = comm && comm.outstandingRequests;
      if (!reqs || !reqs.forEach) return;
      var channelId = '';
      try { if (comm.channels && comm.channels.forEach) comm.channels.forEach(function(_c, id){ if (!channelId) channelId = id; }); } catch (e) {}
      reqs.forEach(function(_deferred, requestId){
        liveIds.add(requestId);
        var meta = store.get(requestId);
        out.push({
          requestId: requestId,
          toolName: meta ? (meta.toolName || '') : '', // '' = uncaptured → supervisor handoff, never auto-approve
          argsText: JSON.stringify((meta && meta.inputs) || {}),
          permission: '',
          hasCommandUse: false,
          taskId: channelId,
          captured: !!meta
        });
      });
    });
    // prune metadata for requests no longer pending
    store.forEach(function(_v, k){ if (!liveIds.has(k)) store.delete(k); });
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

/** Build the resolve function with requestId + payload embedded as JSON literals. */
export function buildResolveFn(requestId: string, payload: Record<string, unknown>): string {
  return `function(){
    try {
      var requestId = ${JSON.stringify(requestId)};
      var payload = ${JSON.stringify(payload)};
      // For an allow with no explicit updatedInput (e.g. a supervisor "allow"),
      // fall back to the captured original tool inputs so the tool runs unchanged.
      try {
        if (payload && payload.result && payload.result.behavior === 'allow') {
          var ui = payload.result.updatedInput;
          var empty = !ui || (typeof ui === 'object' && Object.keys(ui).length === 0);
          var store = globalThis.${PERMS_GLOBAL};
          if (empty && store && store.get) {
            var meta = store.get(requestId);
            if (meta && meta.inputs) payload.result.updatedInput = meta.inputs;
          }
        }
      } catch (e) {}
      var done = 'notfound';
      if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
        if (done === 'ok') return;
        var reqs = comm && comm.outstandingRequests;
        if (reqs && reqs.has && reqs.has(requestId)) {
          var d = reqs.get(requestId);
          if (d && typeof d.resolve === 'function') {
            d.resolve(payload);
            done = 'ok';
            // Dismiss the (now-orphaned) webview prompt card: the extension answered
            // out-of-band, so the webview still shows it. cancel_request makes the
            // webview abort its pending request controller for this id — the same
            // mechanism the extension uses to cancel an in-flight request.
            try { if (typeof comm.send === 'function') comm.send({ type: 'cancel_request', targetRequestId: requestId }); } catch (e) {}
          }
        }
      });
      try { if (globalThis.${PERMS_GLOBAL}) globalThis.${PERMS_GLOBAL}.delete(requestId); } catch (e) {}
      return done;
    } catch (e) { return 'err:' + String(e); }
  }`;
}

/** Build the injected fn that ANSWERS an AskUserQuestion: resolve its deferred with a
 *  tool_permission_response whose updatedInput echoes the captured inputs and adds the
 *  `answers` map (question text -> chosen labels). Reads captured inputs from the existing
 *  perms store; dismisses the orphaned webview card. Confirmed shape (findings §Claude):
 *  deferred.resolve; behavior "allow"; updatedInput.answers. */
export function buildQuestionResolveFn(requestId: string, answers: Record<string, string[]>): string {
  return `function(){
    try {
      var requestId = ${JSON.stringify(requestId)};
      var answers = ${JSON.stringify(answers)};
      var inputs = {};
      try {
        var store = globalThis.${PERMS_GLOBAL};
        if (store && store.get) { var meta = store.get(requestId); if (meta && meta.inputs) inputs = meta.inputs; }
      } catch (e) {}
      var updatedInput = Object.assign({}, inputs, { answers: answers });
      var payload = { type: 'tool_permission_response', result: { behavior: 'allow', updatedInput: updatedInput, updatedPermissions: [] } };
      var done = 'notfound';
      if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
        if (done === 'ok') return;
        var reqs = comm && comm.outstandingRequests;
        if (reqs && reqs.has && reqs.has(requestId)) {
          var d = reqs.get(requestId);
          if (d && typeof d.resolve === 'function') {
            d.resolve(payload);
            done = 'ok';
            try { if (typeof comm.send === 'function') comm.send({ type: 'cancel_request', targetRequestId: requestId }); } catch (e) {}
          }
        }
      });
      try { if (globalThis.${PERMS_GLOBAL}) globalThis.${PERMS_GLOBAL}.delete(requestId); } catch (e) {}
      return done;
    } catch (e) { return 'err:' + String(e); }
  }`;
}

/** Parse the LIST_FN JSON into PendingApproval[]; [] on any malformed input. Pure. */
export function parseClaudePending(raw: unknown): PendingApproval[] {
  if (typeof raw !== 'string') { return []; }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingApproval[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolves Claude tool-permission prompts by reaching the live manager via the
 * inspector. Implements the same `BobApprover` interface the AutoResponder's
 * approval sweep consumes. Never throws — logs and returns safe defaults.
 *
 * Requires the send-hook to be installed (via {@link installHook}) before a
 * prompt is created, so tool metadata is available for rule matching.
 */
export class InspectorClaudeApprover implements BobApprover {
  constructor(private readonly log: (msg: string) => void) {}

  /** Install the metadata-capture hook on all comms (idempotent). */
  async installHook(): Promise<string> {
    const { raw, diag } = await callOnClaudeManager(INSTALL_HOOK_FN, this.log);
    const outcome = raw ?? `diag:${diag}`;
    this.log(`claude approver: install hook → ${outcome}`);
    return outcome;
  }

  async listAllPending(): Promise<PendingApproval[]> {
    const { raw } = await callOnClaudeManager(LIST_FN, this.log);
    return parseClaudePending(raw);
  }

  async resolve(requestId: string, payload: Record<string, unknown>): Promise<string> {
    const { raw, diag } = await callOnClaudeManager(buildResolveFn(requestId, payload), this.log);
    const outcome = raw ?? `diag:${diag}`;
    this.log(`claude approver: resolve ${requestId} → ${outcome}`);
    return outcome;
  }

  /** Answer an AskUserQuestion by resolving its deferred with the chosen labels
   *  (question text → labels). Echoes the captured inputs; never allow/deny. */
  async resolveQuestion(requestId: string, answers: Record<string, string[]>): Promise<string> {
    const { raw, diag } = await callOnClaudeManager(buildQuestionResolveFn(requestId, answers), this.log);
    const outcome = raw ?? `diag:${diag}`;
    this.log(`claude approver: resolveQuestion ${requestId} → ${outcome}`);
    return outcome;
  }
}
