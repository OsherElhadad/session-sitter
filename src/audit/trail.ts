/**
 * The audit trail — append-only JSONL, one record per governance decision.
 *
 * This is the evidence layer. Auto mode makes a decision and reports `Blocked by classifier`; the
 * trail exists so a lead can answer "what were my agents allowed to do last night, under which
 * rule, decided by what, and how long did it take" without asking anyone to remember.
 *
 * Two files, both append-only, both bounded:
 *
 *  - `decisions.jsonl` — one {@link DecisionRecord} per `PermissionRequest`. The product surface.
 *  - `activity.jsonl` — one {@link ActivityRecord} per tool result, the minimum a wedge detector
 *    needs (which tool, a fingerprint of the input, did it fail, when). Not a decision, so it is
 *    kept apart rather than diluting the decision log.
 *
 * ## Redaction
 *
 * A tool input can contain a credential — an `export ANTHROPIC_AUTH_TOKEN=…`, a `curl -H
 * "Authorization: Bearer …"`. The trail is written to disk and meant to be forwarded, so every
 * summary goes through `redactSecrets` from `src/corpus/mask.ts` first. That is the same detector
 * the corpus importer uses, so there is one list of what counts as a secret in this repository.
 *
 * ## Bounding
 *
 * A hook writes on every prompt, forever, with nobody watching. So each file is rotated at
 * {@link MAX_BYTES}: the current file becomes `<name>.1` (replacing any previous `.1`) and a fresh
 * one starts. One generation of history is kept on purpose — unbounded growth and unbounded
 * retention are both liabilities, and the interesting window for a wedge or an overnight digest is
 * the recent one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { redactSecrets } from '../corpus/mask';
import { RecordedCall } from '../supervisor/models';

/** Who actually made the call. `human` and `timeout` arrive from the escalation path. */
export type Actor = 'deterministic' | 'policy' | 'model' | 'human' | 'timeout';

/** Rotate at 4 MiB — roughly 20k decisions, far more than a digest ever reads. */
export const MAX_BYTES = 4 * 1024 * 1024;

/** How much of a tool input is kept in a summary. Enough to identify a call, not to replay it. */
export const SUMMARY_LIMIT = 300;

export interface DecisionRecord {
  ts: string;
  sessionId: string;
  cwd: string;
  tool: string;
  /** Redacted and truncated — never the raw input. */
  inputSummary: string;
  /** green | yellow | orange | red, or null when no light was assigned. */
  light: string | null;
  /**
   * What Claude Code was told. `none` means the hook returned no verdict — an exempt tool, or
   * observe mode — and is kept distinct from `deny` because recording a denial that never happened
   * would make the trail lie about the layer's own reach.
   */
  decision: 'allow' | 'deny' | 'none';
  /** The citation string, e.g. `practices §team-git-002`. Null when no written clause applied. */
  clause: string | null;
  actor: Actor;
  latencyMs: number;
  /** True when the correction lane replaced the tool input. */
  rewritten: boolean;
  /** One line a human can read without decoding the rest of the record. */
  note?: string;
  /**
   * The compiled policy revision this decision was evaluated against, `sha256:<hex>`. Null when the
   * decision came from the markdown fallback, and *absent* on a record written before stamping
   * existed.
   *
   * Added additively, and nothing already written is ever rewritten — an audit trail you edit is not
   * an audit trail. JSONL has no schema, so a reader normalises a missing key to null and reports
   * those records in their own bucket. Never folded into a real revision: that would fabricate
   * provenance, and it is why the pipeline may not mine unstamped records for before/after
   * comparisons.
   */
  rev?: string | null;
  /** Where the policy came from. Absent on a pre-stamping record. */
  policySource?: 'artifact' | 'markdown' | 'none';
  /**
   * The tool call this decision judged, in the shape a *re-evaluation* needs: the tool name and the
   * whole redacted input, not a display string.
   *
   * `inputSummary` cannot serve. It picks one field (`command`, else `file_path`, …), collapses
   * whitespace, and truncates at 300 characters — so a `Write` call's contents are gone, a
   * multi-field input is gone, and a long command line is a prefix. Handing that back to the
   * evaluator as `{ command: inputSummary }` produces verdicts that differ from the recorded ones
   * for reasons that have nothing to do with the clause under test, which makes every replay number
   * unfalsifiable. See `src/policy/replay.ts` and its calibration invariant.
   *
   * Additive and nullable exactly like `rev`: **absent** on a record written before this field
   * existed, and a reader must keep those in their own bucket rather than inventing a call for them.
   * Redaction is `recordedCall()`'s, so the trail and the supervision record share one definition of
   * what a stored tool input looks like.
   */
  call?: RecordedCall | null;
}

export interface ActivityRecord {
  ts: string;
  sessionId: string;
  tool: string;
  /** Short stable hash of the tool input, so a repeated identical call is visible without storing it. */
  fingerprint: string;
  ok: boolean;
}

/**
 * A redacted, bounded, human-readable one-liner for a tool input. `Bash` shows its command and
 * file tools show their path, because those are what a reviewer scans for; anything else falls
 * back to compact JSON.
 */
export function summarizeInput(
  toolInput: Record<string, unknown> | null | undefined,
): string {
  if (!toolInput) { return ''; }
  const pick = (key: string): string | null =>
    typeof toolInput[key] === 'string' ? (toolInput[key] as string) : null;
  const raw = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern')
    ?? JSON.stringify(toolInput);
  const redacted = redactSecrets(raw.replace(/\s+/g, ' ').trim());
  return redacted.length > SUMMARY_LIMIT ? `${redacted.slice(0, SUMMARY_LIMIT)}…` : redacted;
}

/** A stable short hash of a tool call, for spotting the same call repeated. */
export function fingerprint(
  toolName: string, toolInput: Record<string, unknown> | null | undefined,
): string {
  const body = `${toolName} ${JSON.stringify(toolInput ?? {})}`;
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}

/** Rotate when the file has reached the cap. Best-effort: a failed rotation must not lose a record. */
function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) { return; }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or a concurrent hook already rotated it. Either way, just append.
  }
}

/**
 * Append one record as a single JSON line. Synchronous on purpose: a hook process may exit the
 * moment its stdout is written, and an in-flight async append would be lost. Never throws — an
 * unwritable trail must not turn into a denied tool call.
 */
export function appendJsonl(file: string, record: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Deliberately silent: stderr from a hook on exit 0 is debug-log only, and the decision the
    // caller is about to return matters more than the record of it.
  }
}

/** Read a JSONL file newest-last, skipping malformed lines. Includes the rotated generation. */
export function readJsonl<T>(file: string): T[] {
  const out: T[] = [];
  for (const candidate of [`${file}.1`, file]) {
    let text: string;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A partially written last line, or a line from a crashed writer. Skip it.
      }
    }
  }
  return out;
}
