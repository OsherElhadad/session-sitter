/**
 * Reading the evidence: what was decided, by whom, under which clause.
 *
 * Two writers feed this reader, and it has to be useful with either one alone:
 *
 *  1. **The audit trail** — `<stateDir>/audit.jsonl`, one JSON object per decision, written by the
 *     hook front end. This is the record designed for the query surface, and `AuditRecord` below is
 *     the contract this reader holds the writer to.
 *  2. **The supervision records** — `<stateDir>/records/req-*.json`, which the extension and
 *     `supervise` CLI have written since long before the audit trail existed. They carry a traffic
 *     light, a state and a rule trace but no clause citation, so they map into a decision with the
 *     clause field genuinely empty.
 *
 * Where a field is absent it stays absent. `log` and `digest` print "not recorded" for those, and
 * nothing in here fills a gap with a plausible-looking value.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordToItem } from '../SupervisionActivity';
import { loadConfig } from '../supervisor/config';
import { vscodeUserDir } from '../sessionScan';

// ── The audit-trail contract ────────────────────────────────────────────────

/**
 * One line of `<stateDir>/audit.jsonl`.
 *
 * **This is a contract with the writer, not a description of one.** The reader is deliberately
 * tolerant: every field but `at` is optional here, an unknown `v` is still read, and a line that
 * does not parse is skipped rather than fatal — a governance log that stops being queryable because
 * one line was half-written at the moment of a crash is a log you cannot use in the situation you
 * most need it.
 *
 * Snake_case throughout, matching `SupervisionRecord` in `src/supervisor/models.ts`, so the two
 * durable formats in this project read alike.
 */
export interface AuditRecord {
  /** Schema version. 1 is the shape below; a reader must tolerate a higher number. */
  v?: number;
  /** ISO 8601 instant the decision was taken. The one required field. */
  at: string;
  /** Which front end wrote it: `hook` | `extension` | `cli`. */
  via?: string;
  /** The agent session the call belongs to. */
  session_id?: string;
  /** Human-readable session name, when the writer knows one. */
  session_name?: string | null;
  /** Short host the decision was taken on. */
  host?: string | null;
  /** `claude` | `bob` | `codex` | `chat`. */
  agent?: string | null;
  /** The tool the agent asked to run, e.g. `Bash`, `Write`. */
  tool?: string | null;
  /**
   * What was decided.
   *
   *  `allow`    — the call ran as written
   *  `deny`     — the call was blocked
   *  `correct`  — the call was rewritten and the rewrite ran (see `updated_input`)
   *  `escalate` — a human was asked
   *  `timeout`  — a human was asked and did not answer, so the call was denied
   */
  outcome?: string | null;
  /** The traffic light the decision carried: `green` | `yellow` | `orange` | `red`. */
  light?: string | null;
  /** Who decided: `rule` (deterministic) | `classifier` (model) | `human`. */
  actor?: string | null;
  /**
   * The practices clause that was applied — the whole point of the trail.
   *
   * `id` is the citable reference (`practices§4`); `text` is the clause as written, so a record
   * stays readable after the practices file has moved on.
   */
  clause?: { id?: string | null; text?: string | null } | null;
  /** Present only on the correction lane: the tool input as rewritten. */
  updated_input?: unknown;
  /** The original input, when the writer keeps it alongside a rewrite. */
  original_input?: unknown;
  /** How long the decision took, milliseconds. */
  latency_ms?: number | null;
  /** One line of why, for a human reading the log. */
  reason?: string | null;
  /** What the session was asked to do, when the writer knows it. Used by `digest`. */
  ask?: string | null;
  /** Model cost of the decision, when the transcript records one. Never inferred. */
  cost_usd?: number | null;
}

/** The file the audit trail is written to, under the state dir. */
export const AUDIT_FILE = 'audit.jsonl';

// ── The reader's own view ──────────────────────────────────────────────────

export type DecisionOutcome =
  | 'allow' | 'deny' | 'correct' | 'escalate' | 'timeout' | 'resolved' | 'failed' | 'pending'
  | 'unknown';

/**
 * One decision, from either writer, in the shape `log` and `digest` render.
 *
 * A string field is `''` when the source did not record it — never a placeholder. The renderers own
 * the words "not recorded"; the reader owns knowing that it was not.
 */
export interface Decision {
  /** `audit` for a JSONL line, `supervision` for a `records/*.json` file. */
  from: 'audit' | 'supervision';
  /** Stable id for this decision — the request id, or the audit line's index. */
  id: string;
  at: Date;
  sessionId: string;
  sessionName: string;
  host: string;
  agent: string;
  tool: string;
  light: string;
  outcome: DecisionOutcome;
  actor: string;
  clauseId: string;
  clauseText: string;
  /** True only when the input was rewritten — the correction lane. */
  rewritten: boolean;
  reason: string;
  /** What the session was asked to do, when known. */
  ask: string;
  /**
   * The tool input the decision was taken on — the original where a record carries both, since
   * that is the call a replay has to re-decide.
   *
   * `undefined` when nothing recorded an input, which is the normal case for a supervision record:
   * those describe a paused session, not a single tool call.
   */
  input?: unknown;
  latencyMs: number | null;
  costUsd: number | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const OUTCOMES: ReadonlySet<string> = new Set<DecisionOutcome>([
  'allow', 'deny', 'correct', 'escalate', 'timeout', 'resolved', 'failed', 'pending', 'unknown',
]);

function toOutcome(value: string): DecisionOutcome {
  return OUTCOMES.has(value) ? (value as DecisionOutcome) : 'unknown';
}

/** Map one audit line into a decision. */
export function auditToDecision(record: AuditRecord, id: string): Decision {
  const light = str(record.light);
  const outcome = toOutcome(str(record.outcome));
  return {
    from: 'audit',
    id,
    at: new Date(record.at),
    sessionId: str(record.session_id),
    sessionName: str(record.session_name) || str(record.session_id),
    host: str(record.host),
    agent: str(record.agent),
    tool: str(record.tool),
    light,
    // A record that names no outcome but does name a light is still readable: red blocks, green
    // allows. Guessing beyond that pair would be inventing the decision.
    outcome: outcome !== 'unknown' ? outcome
      : light === 'red' ? 'deny' : light === 'green' ? 'allow' : 'unknown',
    actor: str(record.actor),
    clauseId: str(record.clause?.id),
    clauseText: str(record.clause?.text),
    rewritten: record.updated_input !== undefined && record.updated_input !== null,
    reason: str(record.reason),
    ask: str(record.ask),
    input: record.original_input ?? record.updated_input,
    latencyMs: num(record.latency_ms),
    costUsd: num(record.cost_usd),
  };
}

/**
 * Read `<stateDir>/audit.jsonl`.
 *
 * A missing file is not an error: the audit trail only exists once something has been decided, and
 * "nothing yet" is a legitimate answer to a query.
 */
export async function readAuditTrail(stateDir: string): Promise<Decision[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(path.join(stateDir, AUDIT_FILE), 'utf8');
  } catch {
    return [];
  }
  const decisions: Decision[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) { continue; }
    try {
      const record = JSON.parse(trimmed) as AuditRecord;
      if (typeof record.at !== 'string') { continue; }
      const decision = auditToDecision(record, `${AUDIT_FILE}:${i + 1}`);
      if (Number.isNaN(decision.at.getTime())) { continue; }
      decisions.push(decision);
    } catch { /* half-written or corrupt line — skip it, keep the rest of the trail */ }
  }
  return decisions;
}

// ── The supervision records, as decisions ──────────────────────────────────

/**
 * A supervision record's lifecycle state, read as an outcome.
 *
 * Two of these are worth stating out loud. `orange_timed_out` is a **deny**, because the project's
 * founding rule is that silence is never approval. And a rule decision is only an allow when the
 * rule was not a rejection — the record's `state` alone cannot tell those apart.
 */
const STATE_OUTCOME: Readonly<Record<string, DecisionOutcome>> = {
  green_completed: 'allow',
  yellow_ready: 'correct',
  yellow_delivered: 'correct',
  orange_awaiting_user: 'escalate',
  orange_awaiting_question: 'escalate',
  orange_resolved_by_user: 'resolved',
  orange_timed_out: 'timeout',
  orange_transitioned_to_yellow: 'correct',
  red_blocked: 'deny',
  analysis_pending: 'pending',
  failed: 'failed',
};

function supervisionOutcome(state: string, ruleDecision: string): DecisionOutcome {
  if (state === 'rule_applied') { return ruleDecision === 'reject' ? 'deny' : 'allow'; }
  return STATE_OUTCOME[state] ?? 'unknown';
}

/**
 * Read `<stateDir>/records/req-*.json` as decisions.
 *
 * Goes through `recordToItem` — the mapper the panel's activity feed already uses — so a decision
 * reads the same in the terminal as it does in the IDE. The raw JSON is parsed a second time only
 * for the two fields an `ActivityItem` does not carry: the tool the rule matched, and the rule's
 * own verdict.
 */
export async function readSupervisionRecords(stateDir: string): Promise<Decision[]> {
  const recordsDir = path.join(stateDir, 'records');
  let files: string[];
  try {
    files = (await fs.promises.readdir(recordsDir))
      .filter(f => f.startsWith('req-') && f.endsWith('.json'));
  } catch {
    return [];
  }

  const decisions: Decision[] = [];
  for (const file of files) {
    const full = path.join(recordsDir, file);
    try {
      const raw = await fs.promises.readFile(full, 'utf8');
      const stat = await fs.promises.stat(full);
      const item = recordToItem(raw, stat.mtimeMs);
      if (!item) { continue; }
      const parsed = JSON.parse(raw) as {
        source?: string;
        rule?: { tool_name?: string; decision?: string } | null;
        assessment?: { user_intent?: string; summary?: string } | null;
      };
      const at = new Date(item.at);
      if (Number.isNaN(at.getTime())) { continue; }
      decisions.push({
        from: 'supervision',
        id: item.requestId,
        at,
        sessionId: item.sessionId,
        sessionName: item.sessionName,
        host: item.host,
        agent: str(parsed.source),
        tool: str(parsed.rule?.tool_name),
        light: item.light,
        outcome: supervisionOutcome(item.state, str(parsed.rule?.decision)),
        // `decided_by` is 'rule' or 'supervisor'; the audit trail's word for the latter is
        // 'classifier', and one vocabulary across both readers is worth the translation.
        actor: item.decidedBy === 'supervisor' ? 'classifier' : item.decidedBy,
        // Supervision records predate clause citation. This gap is the reason the audit trail
        // exists, and printing it as empty is how the gap stays visible.
        clauseId: '',
        clauseText: item.ruleLabel,
        rewritten: false,
        reason: item.humanNotification || item.summary || item.error || '',
        ask: str(parsed.assessment?.user_intent),
        latencyMs: null,
        costUsd: null,
      });
    } catch { /* unreadable or half-written record — skip */ }
  }
  return decisions;
}

/** Every decision from both writers, oldest first. */
export async function readDecisions(stateDir: string): Promise<Decision[]> {
  const decisions = [
    ...(await readAuditTrail(stateDir)),
    ...(await readSupervisionRecords(stateDir)),
  ];
  decisions.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  return decisions;
}

// ── Finding the state dir ──────────────────────────────────────────────────

/**
 * Where supervision state might live, most specific first.
 *
 * The awkwardness here is real and not ours to fix: the extension defaults its state dir to its own
 * VS Code global storage, while `supervise` defaults to `<cwd>/.supervisor-state`. A terminal
 * command that only knew one of them would report an empty audit trail on a machine that has one,
 * which is the worst possible failure for an evidence tool — so it looks in both and says which it
 * used.
 */
export function stateDirCandidates(cwd: string = process.cwd()): string[] {
  const fromConfig = loadConfig({ workspaceRoot: cwd }).stateDir;
  const globalStorage = path.join(
    vscodeUserDir(), 'globalStorage', 'eranra.session-sitter', 'state');
  return [...new Set([fromConfig, globalStorage])];
}

export interface ResolvedState {
  dir: string;
  /** Whether anything a reader can use is actually there. */
  populated: boolean;
  /** Every place that was looked at, in order, for an honest "nothing found" message. */
  searched: string[];
}

/** Does this directory hold either writer's output? */
function hasState(dir: string): boolean {
  return fs.existsSync(path.join(dir, AUDIT_FILE)) || fs.existsSync(path.join(dir, 'records'));
}

/**
 * Resolve the state dir to read from: an explicit `--state-dir` wins outright, otherwise the first
 * candidate that actually holds records.
 *
 * An explicit path is honoured even when empty — being told where to look and looking somewhere
 * else is not a favour.
 */
export function resolveState(explicit: string | undefined, cwd: string = process.cwd()): ResolvedState {
  if (explicit !== undefined) {
    const dir = path.resolve(expandHome(explicit));
    return { dir, populated: hasState(dir), searched: [dir] };
  }
  const searched = stateDirCandidates(cwd);
  for (const dir of searched) {
    if (hasState(dir)) { return { dir, populated: true, searched }; }
  }
  return { dir: searched[0], populated: false, searched };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ── Filtering ──────────────────────────────────────────────────────────────

export interface DecisionFilter {
  since?: Date;
  until?: Date;
  /** Only decisions that blocked a call — `deny` and the timeouts that mean deny. */
  denied?: boolean;
  /** Only the correction lane. */
  corrected?: boolean;
  sessionId?: string;
  tool?: string;
}

/** A denial is any outcome that stopped the call, which includes a countdown running out. */
export function isDenial(decision: Decision): boolean {
  return decision.outcome === 'deny' || decision.outcome === 'timeout';
}

/** A correction is a rewrite: the outcome says so, or the record carries the rewritten input. */
export function isCorrection(decision: Decision): boolean {
  return decision.outcome === 'correct' || decision.rewritten;
}

export function filterDecisions(
  decisions: readonly Decision[], filter: DecisionFilter,
): Decision[] {
  const tool = filter.tool?.toLowerCase();
  return decisions.filter(d => {
    if (filter.since && d.at.getTime() < filter.since.getTime()) { return false; }
    if (filter.until && d.at.getTime() > filter.until.getTime()) { return false; }
    if (filter.denied && !isDenial(d)) { return false; }
    if (filter.corrected && !isCorrection(d)) { return false; }
    if (filter.sessionId && d.sessionId !== filter.sessionId) { return false; }
    if (tool && d.tool.toLowerCase() !== tool) { return false; }
    return true;
  });
}
