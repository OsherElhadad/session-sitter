/**
 * Strict validation of the classifier's JSON output.
 *
 * Ported from `reckon_supervisor/schema.py`. Enforces required fields, types, enum
 * membership, the `confidence` range, and the per-traffic-light conditional requirements.
 * Throws `SchemaError` on the first problem so the orchestrator fails loud *before* any
 * messaging / guidance / block side effect.
 */

import {
  Assessment,
  AssessmentInput,
  Severity,
  TrafficLight,
  assessmentFrom,
} from './models';

export const VALID_LIGHTS: ReadonlySet<string> = new Set(Object.values(TrafficLight));
export const VALID_SEVERITIES: ReadonlySet<string> = new Set(Object.values(Severity));
export const VALID_SCOPES: ReadonlySet<string> = new Set(['user', 'project', 'team']);

const REQUIRED_TOP_LEVEL = [
  'traffic_light',
  'confidence',
  'summary',
  'agent_intent',
  'user_intent',
  'waiting_reason',
  'issues',
  'recommended_action',
] as const;

/** Raised when classifier output is malformed or violates the contract. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

function require_(cond: boolean, msg: string): void {
  if (!cond) { throw new SchemaError(msg); }
}

/** Yield each balanced top-level `{...}` substring, ignoring braces inside strings. */
export function iterTopLevelObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== '{') { i++; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let closed = false;
    for (let j = i; j < n; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') { inStr = false; }
        continue;
      }
      if (ch === '"') { inStr = true; }
      else if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j + 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) { return out; } // unterminated — stop scanning
  }
  return out;
}

/**
 * Recover the assessment JSON from a model response that may wrap it in prose, a markdown
 * fence, or trail it with other JSON (Bob's `--output-format json` appends a stats object).
 *
 * Scans ALL balanced top-level objects and returns the FIRST that looks like an assessment
 * (parses to an object with `traffic_light`); otherwise the first balanced object; else throws.
 */
export function extractJsonObject(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) { throw new SchemaError('output is empty'); }
  let text = raw.trim();
  if (text.startsWith('```')) { // strip a leading ```json / ``` fence and a trailing ```
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
    if (text.trimEnd().endsWith('```')) { text = text.trimEnd().slice(0, -3); }
    text = text.trim();
  }

  const objects = iterTopLevelObjects(text);
  if (objects.length === 0) {
    throw new SchemaError(`no JSON object found in output: ${JSON.stringify(text.slice(0, 120))}`);
  }
  for (const obj of objects) {
    let parsed: unknown;
    try { parsed = JSON.parse(obj); } catch { continue; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && 'traffic_light' in (parsed as Record<string, unknown>)) {
      return obj; // the real assessment (skips prose, stats blobs, etc.)
    }
  }
  return objects[0]; // nothing had traffic_light — return the first so the error is meaningful
}

const LIGHT_NEAR = /\b(red|orange|yellow|green)\b[\s-]*light/i;
const LIGHT_CLASSIFY = /classif\w*[^.\n]*?\b(red|orange|yellow|green)\b/i;
const LIGHT_WORD = /\b(red|orange|yellow|green)\b/gi;

/**
 * Best-effort recovery when an agentic CLI narrates its decision as PROSE instead of emitting
 * JSON. Detects the traffic light from the text and builds a minimal, schema-valid assessment
 * (the prose becomes the human message). Returns null when no light can be found, so a
 * non-JSON-but-clear response never hard-fails the whole classification.
 */
export function salvageAssessmentFromText(
  raw: string, actionLabel = 'the requested action',
): AssessmentInput | null {
  const text = (raw ?? '').trim();
  if (!text) { return null; }
  // If the model DID emit a structured assessment (has traffic_light), this is not a prose
  // case — don't salvage; let strict validation decide. A structured-but-invalid output should
  // fail loudly rather than be silently patched.
  try {
    const obj = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && 'traffic_light' in obj) { return null; }
  } catch { /* not structured — continue salvaging */ }

  const m = LIGHT_NEAR.exec(text) ?? LIGHT_CLASSIFY.exec(text);
  let light = m ? m[1].toLowerCase() : null;
  if (light === null) { // no "X light" phrasing — take the most severe light word present
    const present = new Set((text.match(LIGHT_WORD) ?? []).map(w => w.toLowerCase()));
    light = (['red', 'orange', 'yellow', 'green'] as const).find(lt => present.has(lt)) ?? null;
  }
  if (light === null) { return null; }

  const firstLine = text.split('\n', 1)[0].trim().slice(0, 200);
  const summary = firstLine || `${light} (recovered from a non-JSON response)`;
  const note = text.slice(0, 1500);
  const a: AssessmentInput = {
    traffic_light: light, confidence: 0.5, summary,
    agent_intent: actionLabel, user_intent: '(recovered)', waiting_reason: 'awaiting approval',
    issues: [], recommended_action: 'See message.',
    supervisor_message_to_agent: null, human_notification: null, human_options: [],
    allowed_actions_while_waiting: [], blocked_actions: [],
    should_block_agent: false, should_block_original_action: false,
    transitioned_from: null, transition_reason: null,
  };
  if (light === 'yellow') {
    a.supervisor_message_to_agent = note;
  } else if (light === 'orange') {
    a.human_notification = note;
    a.blocked_actions = [actionLabel];
    a.should_block_original_action = true;
  } else if (light === 'red') {
    a.human_notification = note;
    a.blocked_actions = [actionLabel];
    a.should_block_agent = true;
    a.should_block_original_action = true;
  }
  return a;
}

/**
 * Last-resort assessment when classifier output can't be parsed or salvaged: escalate to the
 * human (orange) rather than fail. Guarantees a blocked action is never silently dropped AND
 * the supervisor never hard-fails on flaky model output.
 */
export function unclassifiedOrangeAssessment(actionLabel: string, raw = ''): AssessmentInput {
  const detail = (raw ?? '').trim().replace(/\n/g, ' ').slice(0, 300);
  let note =
    'The supervisor could not automatically classify this action (the classifier returned an '
    + `unparseable response). Please decide.\nAction: ${actionLabel}`;
  if (detail) { note += `\nClassifier said: ${detail}`; }
  return {
    traffic_light: 'orange', confidence: 0.3,
    summary: `Could not auto-classify: ${actionLabel}`,
    agent_intent: actionLabel, user_intent: '(unknown)', waiting_reason: 'awaiting approval',
    issues: [], recommended_action: 'Ask the user to decide.',
    supervisor_message_to_agent: null, human_notification: note,
    human_options: ['Approve', 'Reject'], allowed_actions_while_waiting: [],
    blocked_actions: [actionLabel], should_block_agent: false,
    should_block_original_action: true, transitioned_from: null, transition_reason: null,
  };
}

/**
 * Parse a JSON string and validate it, returning a typed `Assessment`. Tolerant of markdown
 * fences / surrounding prose by recovering the first balanced JSON object before parsing.
 */
export function parseAndValidate(raw: string): Assessment {
  const candidate = extractJsonObject(raw);
  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch (err) {
    throw new SchemaError(`output is not valid JSON: ${String(err)}`);
  }
  return validate(data);
}

export function validate(data: unknown): Assessment {
  require_(!!data && typeof data === 'object' && !Array.isArray(data), 'output must be a JSON object');
  const d = data as Record<string, unknown>;

  for (const field of REQUIRED_TOP_LEVEL) {
    require_(field in d, `missing required field: ${field}`);
  }

  const light = d.traffic_light;
  require_(
    typeof light === 'string' && VALID_LIGHTS.has(light),
    `unsupported traffic_light: ${JSON.stringify(light)} (allowed: ${[...VALID_LIGHTS].sort().join(', ')})`,
  );

  const conf = d.confidence;
  require_(typeof conf === 'number' && Number.isFinite(conf), 'confidence must be a number');
  require_((conf as number) >= 0 && (conf as number) <= 1, 'confidence must be in [0.0, 1.0]');

  for (const f of ['summary', 'agent_intent', 'user_intent', 'waiting_reason', 'recommended_action'] as const) {
    require_(typeof d[f] === 'string', `${f} must be a string`);
  }

  require_(Array.isArray(d.issues), 'issues must be a list');
  (d.issues as unknown[]).forEach((issue, idx) => validateIssue(issue, idx));

  validateOptionalStringList(d, 'allowed_actions_while_waiting');
  validateOptionalStringList(d, 'blocked_actions');
  validateOptionalBool(d, 'should_block_agent');
  validateOptionalBool(d, 'should_block_original_action');
  validateOptionalStr(d, 'supervisor_message_to_agent');
  validateOptionalStr(d, 'human_notification');
  validateOptionalStringList(d, 'human_options');
  validateOptionalStr(d, 'transitioned_from');
  validateOptionalStr(d, 'transition_reason');

  validateConditionals(d, light as string);

  return assessmentFrom(d);
}

function validateIssue(issue: unknown, idx: number): void {
  require_(!!issue && typeof issue === 'object' && !Array.isArray(issue), `issues[${idx}] must be an object`);
  const o = issue as Record<string, unknown>;
  for (const f of ['description', 'severity', 'reasoning'] as const) {
    require_(f in o, `issues[${idx}] missing ${f}`);
    require_(typeof o[f] === 'string', `issues[${idx}].${f} must be a string`);
  }
  // `severity` and `relevant_knowledge[].scope` are DESCRIPTIVE metadata for humans/audit —
  // not control flow (only `traffic_light` + the per-light intervention fields drive behavior).
  // We deliberately do NOT hard-fail a whole decision on an off-enum value there (e.g. a model
  // citing a legacy tier as a scope). The prompt asks for the canonical values; a stray one is
  // tolerated so a good decision is never discarded over a label.
  const ev = o.evidence_from_session ?? [];
  require_(Array.isArray(ev), `issues[${idx}].evidence_from_session must be a list`);
  (ev as unknown[]).forEach((e, j) => {
    require_(!!e && typeof e === 'object' && !Array.isArray(e),
      `issues[${idx}].evidence_from_session[${j}] must be an object`);
    const ref = (e as Record<string, unknown>).reference ?? '';
    require_(typeof ref === 'string',
      `issues[${idx}].evidence_from_session[${j}].reference must be a string`);
  });
  const kn = o.relevant_knowledge ?? [];
  require_(Array.isArray(kn), `issues[${idx}].relevant_knowledge must be a list`);
  (kn as unknown[]).forEach((k, j) => {
    require_(!!k && typeof k === 'object' && !Array.isArray(k),
      `issues[${idx}].relevant_knowledge[${j}] must be an object`);
  });
}

/** Per-traffic-light required intervention fields. */
function validateConditionals(d: Record<string, unknown>, light: string): void {
  if (light === TrafficLight.YELLOW) {
    const msg = d.supervisor_message_to_agent;
    require_(typeof msg === 'string' && msg.trim() !== '',
      'yellow requires a non-empty supervisor_message_to_agent');
  } else if (light === TrafficLight.ORANGE) {
    // An Orange→Yellow timeout fallback is represented as traffic_light=yellow with
    // transitioned_from=orange, so a raw 'orange' here is a fresh human-in-loop case.
    const note = d.human_notification;
    require_(typeof note === 'string' && note.trim() !== '',
      'orange requires a non-empty human_notification');
    require_(Array.isArray(d.blocked_actions) && (d.blocked_actions as unknown[]).length > 0,
      'orange requires at least one blocked_action');
    require_('allowed_actions_while_waiting' in d && Array.isArray(d.allowed_actions_while_waiting),
      'orange requires allowed_actions_while_waiting (may be empty)');
  } else if (light === TrafficLight.RED) {
    require_(d.should_block_agent === true, 'red requires should_block_agent=true');
    // Red is an interactive card (block on timeout), so it needs the human message too.
    const note = d.human_notification;
    require_(typeof note === 'string' && note.trim() !== '',
      'red requires a non-empty human_notification');
  }

  // Orange→Yellow timeout fallback shape.
  if (d.transitioned_from !== undefined && d.transitioned_from !== null) {
    require_(d.transitioned_from === TrafficLight.ORANGE,
      "transitioned_from must be 'orange' when present");
    require_(light === TrafficLight.YELLOW,
      'a transitioned_from=orange result must have traffic_light=yellow');
    require_(d.transition_reason !== undefined && d.transition_reason !== null,
      'transition_reason is required when transitioned_from is set');
    const msg = d.supervisor_message_to_agent;
    require_(typeof msg === 'string' && msg.trim() !== '',
      'an orange->yellow fallback requires supervisor_message_to_agent');
  }
}

function validateOptionalStr(d: Record<string, unknown>, key: string): void {
  if (key in d && d[key] !== null && d[key] !== undefined) {
    require_(typeof d[key] === 'string', `${key} must be a string or null`);
  }
}

function validateOptionalStringList(d: Record<string, unknown>, key: string): void {
  if (key in d && d[key] !== null && d[key] !== undefined) {
    require_(Array.isArray(d[key]), `${key} must be a list`);
    (d[key] as unknown[]).forEach((v, i) => {
      require_(typeof v === 'string', `${key}[${i}] must be a string`);
    });
  }
}

function validateOptionalBool(d: Record<string, unknown>, key: string): void {
  if (key in d && d[key] !== null && d[key] !== undefined) {
    require_(typeof d[key] === 'boolean', `${key} must be a boolean`);
  }
}
