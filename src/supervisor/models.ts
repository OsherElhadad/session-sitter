/**
 * Typed models for the supervisor: traffic lights, assessments, and lifecycle records.
 *
 * Ported from the Python supervisor (`models.py`. `Assessment` mirrors the structured JSON the
 * classifier must return; `SupervisionRecord` is the durable lifecycle object the store
 * persists. Record field names stay **snake_case** so records written by either the Python
 * original or this port round-trip through the same JSON files, and so the activity feed's
 * reader keeps working.
 */

import { redactSecrets } from '../corpus/mask';

export const TrafficLight = {
  GREEN: 'green',
  YELLOW: 'yellow',
  ORANGE: 'orange',
  RED: 'red',
} as const;
export type TrafficLight = (typeof TrafficLight)[keyof typeof TrafficLight];

export const Severity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export type KnowledgeScope = 'user' | 'project' | 'team';

/** Lifecycle states. Transitions are enforced in the store/orchestrator. */
export const SupervisionState = {
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
} as const;
export type SupervisionState = (typeof SupervisionState)[keyof typeof SupervisionState];

/** Terminal states — no further automatic processing. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set<string>([
  SupervisionState.GREEN_COMPLETED,
  SupervisionState.YELLOW_DELIVERED,
  SupervisionState.ORANGE_RESOLVED_BY_USER,
  SupervisionState.ORANGE_TRANSITIONED_TO_YELLOW,
  SupervisionState.RED_BLOCKED,
  SupervisionState.RULE_APPLIED,
  SupervisionState.FAILED,
]);

/** Who decided: the deterministic rule tier, or the supervisor (model + BDI). */
export const DecidedBy = {
  SUPERVISOR: 'supervisor',
  RULE: 'rule',
} as const;
export type DecidedBy = (typeof DecidedBy)[keyof typeof DecidedBy];

/** What a deterministic auto-respond rule did, recorded so the UI/Telegram can show it. */
export interface RuleTrace {
  /** 'approval' resolved a pending tool prompt; 'text' sent a canned reply. */
  kind: string;
  /** The rule pattern that matched (toolPattern glob or matchPattern regex). */
  pattern: string;
  /** Optional narrowing regex over the pending arguments JSON. */
  argument_pattern?: string | null;
  /** approveOnce | approveForTask | reject (approval rules only). */
  decision?: string | null;
  /** The text sent into the session (text rules only). */
  response?: string | null;
  /** The pending tool name, when known. */
  tool_name?: string | null;
}

/**
 * The tool call a decision judged, as persisted (snake_case on disk, like every record field).
 *
 * `input` holds the tool's arguments **after masking** — a record is not file content, so a
 * credential in a command line or an env assignment is redacted, not shape-preserved.
 */
export interface RecordedCall {
  tool_name: string;
  input: Record<string, unknown> | null;
}

/**
 * Build the record's call from a tool name and its arguments, masking the arguments on the way in.
 *
 * Both record writers go through here — the orchestrator's pending action and the deterministic
 * tier's rule decision — so there is exactly one place where a tool input is redacted before it
 * reaches disk. No tool name means no call: a call is never invented, and never reconstructed
 * from an assessment's prose.
 *
 * The masking is load-bearing, not incidental: this is a NEW path along which a tool input reaches
 * a durable file. Today's rules in `src/corpus/mask.ts` miss `sk-ant-`/`sk-proj-` keys containing
 * an underscore *entirely* (the character sets are `[A-Za-z0-9-]` / `[A-Za-z0-9]`), so such a key
 * in a command line is written to the record unmasked. Upstream PR #40 fixes exactly those two
 * character sets; this field's masking is only as good as that. Fix it there, never here — a
 * second masker would drift out of step with the first.
 */
export function recordedCall(
  toolName: string | null | undefined,
  args: Record<string, unknown> | null,
): RecordedCall | null {
  if (!toolName) { return null; }
  return {
    tool_name: toolName,
    input: args === null ? null : redactDeep(args) as Record<string, unknown>,
  };
}

/** Redact credentials in every string the input holds, at any depth. */
function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') { return redactSecrets(v); }
  if (Array.isArray(v)) { return v.map(redactDeep); }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x)]));
  }
  return v;
}

export interface EvidenceRef {
  /** Stable session-history reference (e.g. turn index / message id). */
  reference: string;
  description: string;
}

export interface KnowledgeRef {
  scope: string; // user | project | team
  entry: string;
  source_file?: string | null;
  provenance?: string | null;
  confidence?: number | null;
}

export interface Issue {
  description: string;
  severity: string;
  reasoning: string;
  evidence_from_session: EvidenceRef[];
  relevant_knowledge: KnowledgeRef[];
}

/** The structured classifier result. Field names match the required output schema. */
export interface Assessment {
  traffic_light: string;
  confidence: number;
  summary: string;
  agent_intent: string;
  user_intent: string;
  waiting_reason: string;
  recommended_action: string;
  issues: Issue[];
  supervisor_message_to_agent: string | null;
  human_notification: string | null;
  /** Short tappable choices for an Orange card (2-4). Empty → Approve/Reject. */
  human_options: string[];
  allowed_actions_while_waiting: string[];
  blocked_actions: string[];
  should_block_agent: boolean;
  should_block_original_action: boolean;
  transitioned_from: string | null;
  transition_reason: string | null;
}

/** A partially-specified assessment as it arrives from the classifier / a builder. */
export type AssessmentInput = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function evidenceFrom(d: unknown): EvidenceRef {
  const o = (d ?? {}) as Record<string, unknown>;
  return { reference: str(o.reference), description: str(o.description) };
}

function knowledgeFrom(d: unknown): KnowledgeRef {
  const o = (d ?? {}) as Record<string, unknown>;
  return {
    scope: str(o.scope),
    entry: str(o.entry),
    source_file: nullableStr(o.source_file),
    provenance: nullableStr(o.provenance),
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
  };
}

function issueFrom(d: unknown): Issue {
  const o = (d ?? {}) as Record<string, unknown>;
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
export function assessmentFrom(d: AssessmentInput): Assessment {
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
export function assessmentLight(a: Assessment): TrafficLight {
  return a.traffic_light as TrafficLight;
}

/** One entry in a record's audit trail. */
export interface SupervisionEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

/** Durable lifecycle object persisted per supervision request (snake_case on disk). */
export interface SupervisionRecord {
  request_id: string;
  session_id: string;
  /**
   * The session's human name (its panel title, else its project name). Null on a record written
   * before names existed, or when the transcript could not be read — never assume it is set.
   */
  session_name: string | null;
  /** Short name of the machine the session runs on, so one chat can carry several machines. */
  host: string | null;
  source: string;
  state: string;
  /** 'supervisor' (default) or 'rule' — which tier produced this decision. */
  decided_by: string;
  /** Present only when `decided_by === 'rule'`: which rule fired and what it did. */
  rule: RuleTrace | null;
  /**
   * The tool call this decision judged, when known. Additive and nullable: records written before
   * this field existed have none, and a pending action the transcript never showed leaves it null
   * — so no reader may assume it is set. It is the only structured tool identity a
   * supervisor-decided record carries (`source` is the channel; `rule.tool_name` exists only for
   * the deterministic tier), which is what lets the audit trail say what was actually allowed.
   *
   * TODO: the normalised call *shape* an offline miner keys on belongs with
   * `src/policy/generalise.ts`, not here — this field is the seam it reads.
   */
  call: RecordedCall | null;
  created_at: string; // ISO 8601, UTC
  updated_at: string; // ISO 8601, UTC
  // Resolved knowledge routing triple.
  user: string | null;
  project: string | null;
  team: string | null;
  engine_invocation_id: string | null;
  assessment: Record<string, unknown> | null;
  /** The live approval requestId for the paused action, so an "approve" reply can resolve the
   *  exact prompt. Set when the pending action is a live tool-approval prompt. */
  pending_request_id: string | null;
  /** Which light awaits a human decision: "red" | "orange". Drives what a denial/timeout does
   *  — red blocks; orange denies and sends the agent alternatives to continue. */
  await_light: string | null;
  /** The original Orange assessment, preserved verbatim across an Orange→Yellow transition. */
  original_orange_assessment: Record<string, unknown> | null;
  original_orange_assessment_id: string | null;
  /** A pending structured question and the accumulating answer draft. */
  question_spec: Record<string, unknown> | null;
  question_answer: Record<string, unknown> | null;
  // Messaging / Orange lifecycle.
  notification_id: string | null;
  notified_at: string | null;
  timeout_deadline: string | null; // ISO 8601, UTC
  user_response: string | null;
  user_response_at: string | null;
  transitioned_from: string | null;
  transition_reason: string | null;
  // Delivery to the agent.
  delivered_message: string | null;
  delivery_ids: string[];
  blocked_actions: string[];
  allowed_actions: string[];
  should_block_agent: boolean;
  should_block_original_action: boolean;
  // Failures / audit trail.
  error: string | null;
  events: SupervisionEvent[];
}

/** Field defaults for a fresh record — every key present, so JSON round-trips are stable. */
export function newRecord(fields: {
  request_id: string;
  session_id: string;
  source: string;
  state: string;
  created_at: string;
  updated_at: string;
} & Partial<SupervisionRecord>): SupervisionRecord {
  return {
    session_name: null,
    host: null,
    decided_by: DecidedBy.SUPERVISOR,
    rule: null,
    call: null,
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
export function recordFrom(d: Record<string, unknown>): SupervisionRecord {
  return newRecord({
    ...(d as Partial<SupervisionRecord>),
    request_id: String(d.request_id ?? ''),
    session_id: String(d.session_id ?? ''),
    session_name: nullableStr(d.session_name),
    host: nullableStr(d.host),
    source: String(d.source ?? 'unknown'),
    state: String(d.state ?? SupervisionState.ANALYSIS_PENDING),
    created_at: String(d.created_at ?? ''),
    updated_at: String(d.updated_at ?? ''),
    decided_by: String(d.decided_by ?? DecidedBy.SUPERVISOR),
    call: callFrom(d.call),
  });
}

/** Parse a persisted call. An older record has none, and a hand-edited one may hold anything. */
function callFrom(v: unknown): RecordedCall | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) { return null; }
  const d = v as Record<string, unknown>;
  const toolName = nullableStr(d.tool_name);
  if (toolName === null) { return null; } // a call with no tool identity records nothing
  const input = d.input;
  const isPlainObject = input !== null && typeof input === 'object' && !Array.isArray(input);
  return { tool_name: toolName, input: isPlainObject ? input as Record<string, unknown> : null };
}
