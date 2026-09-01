// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/models.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Typed models for the supervisor: traffic lights, assessments, and lifecycle records.
 *
 * Ported from the Python supervisor (`models.py`. `Assessment` mirrors the structured JSON the
 * classifier must return; `SupervisionRecord` is the durable lifecycle object the store
 * persists. Record field names stay **snake_case** so records written by either the Python
 * original or this port round-trip through the same JSON files, and so the activity feed's
 * reader keeps working.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecidedBy = exports.TERMINAL_STATES = exports.SupervisionState = exports.Severity = exports.TrafficLight = void 0;
exports.assessmentFrom = assessmentFrom;
exports.assessmentLight = assessmentLight;
exports.newRecord = newRecord;
exports.recordFrom = recordFrom;
exports.TrafficLight = {
    GREEN: 'green',
    YELLOW: 'yellow',
    ORANGE: 'orange',
    RED: 'red',
};
exports.Severity = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical',
};
/** Lifecycle states. Transitions are enforced in the store/orchestrator. */
exports.SupervisionState = {
    ANALYSIS_PENDING: 'analysis_pending',
    GREEN_COMPLETED: 'green_completed',
    YELLOW_READY: 'yellow_ready',
    YELLOW_DELIVERED: 'yellow_delivered',
    ORANGE_AWAITING_USER: 'orange_awaiting_user',
    ORANGE_RESOLVED_BY_USER: 'orange_resolved_by_user',
    ORANGE_TIMED_OUT: 'orange_timed_out',
    ORANGE_TRANSITIONED_TO_YELLOW: 'orange_transitioned_to_yellow',
    ORANGE_AWAITING_QUESTION: 'orange_awaiting_question',
    RED_BLOCKED: 'red_blocked',
    /** A deterministic auto-respond rule decided this action — no model was consulted. */
    RULE_APPLIED: 'rule_applied',
    FAILED: 'failed',
};
/** Terminal states — no further automatic processing. */
exports.TERMINAL_STATES = new Set([
    exports.SupervisionState.GREEN_COMPLETED,
    exports.SupervisionState.YELLOW_DELIVERED,
    exports.SupervisionState.ORANGE_RESOLVED_BY_USER,
    exports.SupervisionState.ORANGE_TRANSITIONED_TO_YELLOW,
    exports.SupervisionState.RED_BLOCKED,
    exports.SupervisionState.RULE_APPLIED,
    exports.SupervisionState.FAILED,
]);
/** Who decided: the deterministic rule tier, or the supervisor (model + BDI). */
exports.DecidedBy = {
    SUPERVISOR: 'supervisor',
    RULE: 'rule',
};
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const strList = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
const nullableStr = (v) => (typeof v === 'string' ? v : null);
function evidenceFrom(d) {
    const o = (d ?? {});
    return { reference: str(o.reference), description: str(o.description) };
}
function knowledgeFrom(d) {
    const o = (d ?? {});
    return {
        scope: str(o.scope),
        entry: str(o.entry),
        source_file: nullableStr(o.source_file),
        provenance: nullableStr(o.provenance),
        confidence: typeof o.confidence === 'number' ? o.confidence : null,
    };
}
function issueFrom(d) {
    const o = (d ?? {});
    return {
        description: str(o.description),
        severity: str(o.severity),
        reasoning: str(o.reasoning),
        evidence_from_session: Array.isArray(o.evidence_from_session)
            ? o.evidence_from_session.map(evidenceFrom) : [],
        relevant_knowledge: Array.isArray(o.relevant_knowledge)
            ? o.relevant_knowledge.map(knowledgeFrom) : [],
    };
}
/** Normalize a raw assessment object into the full `Assessment` shape (all keys present). */
function assessmentFrom(d) {
    return {
        traffic_light: String(d.traffic_light),
        confidence: Number(d.confidence),
        summary: str(d.summary),
        agent_intent: str(d.agent_intent),
        user_intent: str(d.user_intent),
        waiting_reason: str(d.waiting_reason),
        recommended_action: str(d.recommended_action),
        issues: Array.isArray(d.issues) ? d.issues.map(issueFrom) : [],
        supervisor_message_to_agent: nullableStr(d.supervisor_message_to_agent),
        human_notification: nullableStr(d.human_notification),
        human_options: strList(d.human_options),
        allowed_actions_while_waiting: strList(d.allowed_actions_while_waiting),
        blocked_actions: strList(d.blocked_actions),
        should_block_agent: d.should_block_agent === true,
        should_block_original_action: d.should_block_original_action === true,
        transitioned_from: nullableStr(d.transitioned_from),
        transition_reason: nullableStr(d.transition_reason),
    };
}
/** The traffic light an assessment carries. */
function assessmentLight(a) {
    return a.traffic_light;
}
/** Field defaults for a fresh record — every key present, so JSON round-trips are stable. */
function newRecord(fields) {
    return {
        session_name: null,
        host: null,
        decided_by: exports.DecidedBy.SUPERVISOR,
        rule: null,
        user: null,
        project: null,
        team: null,
        engine_invocation_id: null,
        assessment: null,
        pending_request_id: null,
        await_light: null,
        original_orange_assessment: null,
        original_orange_assessment_id: null,
        question_spec: null,
        question_answer: null,
        notification_id: null,
        notified_at: null,
        timeout_deadline: null,
        user_response: null,
        user_response_at: null,
        transitioned_from: null,
        transition_reason: null,
        delivered_message: null,
        delivery_ids: [],
        blocked_actions: [],
        allowed_actions: [],
        should_block_agent: false,
        should_block_original_action: false,
        error: null,
        events: [],
        ...fields,
    };
}
/** Rehydrate a record from disk, filling any field a older/partial file omitted. */
function recordFrom(d) {
    return newRecord({
        ...d,
        request_id: String(d.request_id ?? ''),
        session_id: String(d.session_id ?? ''),
        session_name: nullableStr(d.session_name),
        host: nullableStr(d.host),
        source: String(d.source ?? 'unknown'),
        state: String(d.state ?? exports.SupervisionState.ANALYSIS_PENDING),
        created_at: String(d.created_at ?? ''),
        updated_at: String(d.updated_at ?? ''),
        decided_by: String(d.decided_by ?? exports.DecidedBy.SUPERVISOR),
    });
}
