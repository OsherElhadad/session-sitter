import { callOnBobTaskManager } from './BobInspector';
import { callOnClaudeManager } from './ClaudeInspector';

/** Parse a probe's JSON string. Never throws — returns { parseError } on any failure. */
export function parseProbeJson(raw: unknown): unknown {
  if (typeof raw !== 'string') { return { parseError: 'not-a-string' }; }
  try { return JSON.parse(raw); }
  catch (e) { return { parseError: String(e) }; }
}

// Injected with `this` = Bob's TaskManager (Nh). READ-ONLY. For every pending
// ask_followup_question across all chat managers, dump: the full signature
// arguments (question + options/choices — the INPUT schema), the own-property
// names of the request object and its usage (to locate where a selected answer
// would be recorded), and the constructor + own-prop names of approvalHandler
// (to see whether questions use a separate emitter than approvals). Mutates nothing.
export const BOB_QUESTION_PROBE_FN = `function(){
  try {
    var cut = function(x){ try { var s = JSON.stringify(x); return s ? s.slice(0,1200) : (''+x); } catch(e){ return 'unstringifiable:'+(typeof x); } };
    var mgrs = this._chatManagers || [];
    var out = { managers: mgrs.length, questions: [], approvalHandlerShape: null };
    for (var i=0;i<mgrs.length;i++){
      var m = mgrs[i];
      var ah = m && m.approvalHandler;
      if (ah && !out.approvalHandlerShape){
        try {
          out.approvalHandlerShape = {
            ctor: (ah.constructor && ah.constructor.name) || '?',
            ownProps: Object.getOwnPropertyNames(ah),
            hasRequestEmitter: !!ah.requestEmitter,
            emitterCtor: (ah.requestEmitter && ah.requestEmitter.constructor && ah.requestEmitter.constructor.name) || '?'
          };
        } catch(e){}
      }
      var w = (ah && ah.requestsWaiting) || [];
      for (var j=0;j<w.length;j++){
        var r = w[j];
        var name = (r.usage && r.usage.signature && r.usage.signature.name) || '';
        if (name !== 'ask_followup_question') continue;
        out.questions.push({
          requestId: r.requestId,
          toolName: name,
          signatureArgs: cut((r.usage && r.usage.signature && r.usage.signature.arguments) || {}),
          requestOwnProps: Object.getOwnPropertyNames(r),
          usageOwnProps: r.usage ? Object.getOwnPropertyNames(r.usage) : [],
          requestSample: cut(r)
        });
      }
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

// Widened Bob probe. The narrow probe returned questions:[] even with a card on
// screen, so ask_followup_question may not sit in requestsWaiting in this Bob
// version. READ-ONLY. For every chat manager, dump: task ids, ALL requestsWaiting
// entries (toolName + bounded sample, not filtered), a bounded approvalQueue and
// requestContexts, and any manager own-field name matching question/pending/await/
// input — so one run with a live card reveals where the question actually lives
// (approval state vs a chat-message question answered by the next user message).
export const BOB_QUESTION_PROBE_FULL_FN = `function(){
  try {
    var cut = function(x){ try { var s = JSON.stringify(x); return s ? s.slice(0,1500) : (''+x); } catch(e){ return 'unstringifiable:'+(typeof x); } };
    var mgrs = this._chatManagers || [];
    var out = { managers: mgrs.length, perManager: [] };
    for (var i=0;i<mgrs.length;i++){
      var m = mgrs[i];
      var entry = { taskIds: [], waitingTools: [], approvalQueue: null, requestContexts: null, managerFieldsMatchingQuestion: [] };
      try { entry.taskIds = (m.currentTasks || []).map(function(t){ return t.getId ? t.getId() : '?'; }); } catch(e){}
      var ah = m && m.approvalHandler;
      if (ah){
        var w = ah.requestsWaiting || [];
        for (var j=0;j<w.length;j++){
          var r = w[j];
          entry.waitingTools.push({
            requestId: r.requestId,
            toolName: (r.usage && r.usage.signature && r.usage.signature.name) || '',
            sample: cut(r)
          });
        }
        try { entry.approvalQueue = cut(ah.approvalQueue); } catch(e){}
        try {
          var rc = ah.requestContexts;
          if (rc instanceof Map) entry.requestContexts = { t:'Map', size: rc.size, sample: cut(Array.from(rc.entries()).slice(0,3)) };
          else entry.requestContexts = cut(rc);
        } catch(e){}
      }
      try {
        var names = Object.getOwnPropertyNames(m);
        for (var k=0;k<names.length;k++){ if (/question|followup|pending|await|input/i.test(names[k])) entry.managerFieldsMatchingQuestion.push(names[k]); }
      } catch(e){}
      out.perManager.push(entry);
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

// Injected with `this` = Claude's manager (gB). READ-ONLY. Discovers how an
// AskUserQuestion is represented and answered. For every comm: hook nothing (do
// not mutate send); instead enumerate outstandingRequests and, for each request,
// inspect the deferred + any recorded request payload on the comm, dumping the
// request `type`, any toolName/inputs (the questions/options/multiSelect INPUT
// schema), and the deferred's own-property names (to locate the resolve join
// point + expected value shape). Also list every channel id. Mutates nothing.
export const CLAUDE_QUESTION_PROBE_FN = `function(){
  try {
    var cut = function(x){ try { var s = JSON.stringify(x); return s ? s.slice(0,1200) : (''+x); } catch(e){ return 'unstringifiable:'+(typeof x); } };
    var out = { comms: 0, channels: [], outstanding: [] };
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
      out.comms++;
      if (comm.channels && comm.channels.forEach) comm.channels.forEach(function(_ch, id){ out.channels.push(id); });
      var reqs = comm && comm.outstandingRequests;
      if (reqs && reqs.forEach) reqs.forEach(function(deferred, requestId){
        var entry = { requestId: requestId, deferredOwnProps: [], deferredSample: null };
        try { entry.deferredOwnProps = Object.getOwnPropertyNames(deferred); } catch(e){}
        try { entry.deferredSample = cut(deferred); } catch(e){}
        out.outstanding.push(entry);
      });
    });
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

// v2 Claude probe. The deferred in outstandingRequests carries NO metadata
// (confirmed by the live probe: deferredSample "{}", only resolve/reject), so —
// exactly like ClaudeApprover's permission-metadata hook — we must observe the
// request payload as it flows through comm.send. This install fn wraps each
// comm.send to RECORD (type + toolName + bounded payload) keyed by requestId,
// then ALWAYS delegates to the original send. It is observational, not read-only
// in the strict sense (it reassigns comm.send), but it never alters, resolves, or
// drops any message. Idempotent per comm. Must be installed BEFORE the question
// is created to capture it.
export const CLAUDE_QUESTION_HOOK_INSTALL_FN = `function(){
  try {
    if (!globalThis.__csw_claudeQProbe) globalThis.__csw_claudeQProbe = new Map();
    var store = globalThis.__csw_claudeQProbe;
    var cut = function(x){ try { var s = JSON.stringify(x); return s ? s.slice(0,4000) : (''+x); } catch(e){ return 'unstringifiable:'+(typeof x); } };
    var n = 0;
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
      if (!comm || comm.__csw_qProbeHooked) return;
      var orig = comm.send;
      if (typeof orig !== 'function') return;
      comm.send = function(m){
        try {
          if (m && m.type === 'request' && m.request) {
            store.set(m.requestId, { type: m.request.type, toolName: m.request.toolName, payload: cut(m.request) });
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      comm.__csw_qProbeHooked = true; n++;
    });
    return 'hooked:' + n;
  } catch (e) { return 'err:' + String(e); }
}`;

// v2 Claude capture. READ-ONLY. Joins every live outstandingRequests id with the
// payload recorded by the install hook, so we can read the AskUserQuestion request
// `type`, `toolName`, and inputs (questions/options/multiSelect). Also returns the
// most recent recorded-but-no-longer-live requests, so if you answer a question the
// resolved request's payload is still visible for schema confirmation. Mutates nothing.
export const CLAUDE_QUESTION_CAPTURE_FN = `function(){
  try {
    var store = globalThis.__csw_claudeQProbe || new Map();
    var out = { recordedCount: store.size, outstanding: [], recentRecorded: [] };
    var liveIds = new Set();
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
      var reqs = comm && comm.outstandingRequests;
      if (!reqs || !reqs.forEach) return;
      reqs.forEach(function(_d, requestId){
        liveIds.add(requestId);
        out.outstanding.push({ requestId: requestId, recorded: store.get(requestId) || null });
      });
    });
    store.forEach(function(v, k){ if (!liveIds.has(k)) out.recentRecorded.push({ requestId: k, recorded: v }); });
    out.recentRecorded = out.recentRecorded.slice(-5);
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

// v3 Claude answer-capture. The answer is delivered via deferred.resolve(payload)
// (NOT comm.send), so the v2 send-hook cannot see it. This install fn wraps the
// resolve of every outstanding request whose recorded toolName is 'AskUserQuestion'
// (cross-referenced against the v2 store), RECORDING the resolve argument into
// globalThis.__csw_claudeAnswers, then ALWAYS delegating to the original
// resolve so the answer still propagates normally. It is the one probe that wraps
// resolve — observational (records then delegates), never destructive. Install it
// AFTER the question appears (the deferred must exist) and BEFORE you answer it.
// Requires the v2 hook to have recorded the request's toolName first.
export const CLAUDE_ANSWER_HOOK_INSTALL_FN = `function(){
  try {
    if (!globalThis.__csw_claudeAnswers) globalThis.__csw_claudeAnswers = new Map();
    var answers = globalThis.__csw_claudeAnswers;
    var store = globalThis.__csw_claudeQProbe || new Map();
    var cut = function(x){ try { var s = JSON.stringify(x); return s ? s.slice(0,4000) : (''+x); } catch(e){ return 'unstringifiable:'+(typeof x); } };
    var n = 0;
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(comm){
      var reqs = comm && comm.outstandingRequests;
      if (!reqs || !reqs.forEach) return;
      reqs.forEach(function(deferred, requestId){
        var meta = store.get(requestId);
        if (!meta || meta.toolName !== 'AskUserQuestion') return;
        if (!deferred || deferred.__csw_answerHooked) return;
        var origResolve = deferred.resolve;
        if (typeof origResolve !== 'function') return;
        deferred.resolve = function(v){
          try { answers.set(requestId, cut(v)); } catch (e) {}
          return origResolve.apply(this, arguments);
        };
        deferred.__csw_answerHooked = true; n++;
      });
    });
    return 'answer-hooked:' + n;
  } catch (e) { return 'err:' + String(e); }
}`;

// v3 capture. READ-ONLY. Dumps the recorded answer payloads (requestId → the value
// passed to deferred.resolve) so we can read the exact answer encoding. Mutates nothing.
export const CLAUDE_ANSWER_CAPTURE_FN = `function(){
  try {
    var answers = globalThis.__csw_claudeAnswers || new Map();
    var out = { answerCount: answers.size, answers: [] };
    answers.forEach(function(v, k){ out.answers.push({ requestId: k, resolvedWith: v }); });
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

/** Debug: dump Bob's ask_followup_question internals as pretty JSON (or a diag). */
export async function dumpBobQuestionShape(log: (m: string) => void): Promise<string> {
  const raw = await callOnBobTaskManager(log, BOB_QUESTION_PROBE_FN, [], false);
  const parsed = parseProbeJson(raw);
  return typeof parsed === 'object' && parsed && 'parseError' in parsed
    ? `// could not read Bob question shape: ${JSON.stringify(parsed)}`
    : JSON.stringify(parsed, null, 2);
}

/** Debug: dump Bob's FULL approval state (all waiting tools, approvalQueue,
 *  requestContexts, question-ish fields) as pretty JSON (or a diag). Use when the
 *  narrow probe returns questions:[] to find where a live question actually lives. */
export async function dumpBobQuestionShapeFull(log: (m: string) => void): Promise<string> {
  const raw = await callOnBobTaskManager(log, BOB_QUESTION_PROBE_FULL_FN, [], false);
  const parsed = parseProbeJson(raw);
  return typeof parsed === 'object' && parsed && 'parseError' in parsed
    ? `// could not read Bob question shape: ${JSON.stringify(parsed)}`
    : JSON.stringify(parsed, null, 2);
}

/** Debug: dump Claude's AskUserQuestion internals as pretty JSON (or a diag). */
export async function dumpClaudeQuestionShape(log: (m: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(CLAUDE_QUESTION_PROBE_FN, log);
  if (typeof raw !== 'string') { return `// could not reach Claude manager: ${diag}`; }
  const parsed = parseProbeJson(raw);
  return JSON.stringify(parsed, null, 2);
}

/** v2: install the observational comm.send recorder. Returns 'hooked:N' or a diag.
 *  Run this BEFORE triggering a fresh AskUserQuestion so its payload is captured. */
export async function installClaudeQuestionHook(log: (m: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(CLAUDE_QUESTION_HOOK_INSTALL_FN, log);
  return typeof raw === 'string' ? raw : `diag:${diag}`;
}

/** v2: dump recorded request payloads joined to live outstanding requests, as
 *  pretty JSON (or a diag). Run while an AskUserQuestion is on screen (after the
 *  hook was installed) to read its input schema + confirm the resolve target. */
export async function captureClaudeQuestion(log: (m: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(CLAUDE_QUESTION_CAPTURE_FN, log);
  if (typeof raw !== 'string') { return `// could not reach Claude manager: ${diag}`; }
  const parsed = parseProbeJson(raw);
  return JSON.stringify(parsed, null, 2);
}

/** v3: wrap the AskUserQuestion deferred's resolve to record the answer payload.
 *  Returns 'answer-hooked:N' or a diag. Run AFTER the question appears, BEFORE you
 *  answer it (requires the v2 hook to have recorded the request's toolName). */
export async function installClaudeAnswerHook(log: (m: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(CLAUDE_ANSWER_HOOK_INSTALL_FN, log);
  return typeof raw === 'string' ? raw : `diag:${diag}`;
}

/** v3: dump the recorded answer payloads (the value passed to deferred.resolve),
 *  as pretty JSON (or a diag). Run AFTER you answer the question. */
export async function captureClaudeAnswer(log: (m: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(CLAUDE_ANSWER_CAPTURE_FN, log);
  if (typeof raw !== 'string') { return `// could not reach Claude manager: ${diag}`; }
  const parsed = parseProbeJson(raw);
  return JSON.stringify(parsed, null, 2);
}
