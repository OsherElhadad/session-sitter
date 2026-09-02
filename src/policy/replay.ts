/**
 * Replay — re-decide real recorded decisions against a candidate clause, and say what would change.
 *
 * This is the validation gate's stage 3 (`12-validation.md` §4). A human reads its output to decide
 * whether a machine-proposed clause enters the corpus, so the report is a product surface, not debug
 * output: *"would have changed 23 of your last 500 decisions, 0 reversals, here are 3 examples"*.
 *
 * ## Why this reuses `decideDeterministically` and refuses to own an evaluator
 *
 * A second evaluator makes the report a lie. Not approximately — structurally: the number a reviewer
 * acts on would describe a program that never runs, and every divergence between the two would look
 * exactly like a finding. So replay imports the *same* exported ladder the `PermissionRequest` hook
 * calls (`src/hooks/permissionRequest.ts:decideDeterministically`, rungs 1–5) and varies everything
 * else by parameter. `T14` asserts there is exactly one definition of it in the repository.
 *
 * The three things replay must vary are injected, never branched on inside the evaluator:
 *
 *  - **the clause set** — a clone with the candidate added (replay) or a clause removed (ablation);
 *  - **the classifier** — rung 6 is replaced by {@link ReplayInjections.classify}, which returns the
 *    verdict *recorded for that decision*. Replay never calls a model: it is free, deterministic, and
 *    honest about the one part it cannot re-derive;
 *  - **the escalation** — a decision a human answered replays as that answer
 *    ({@link ReplayInjections.ask}). No countdown runs, so no wall clock is consulted.
 *
 * The cost is that replay is blind to changes in *model-mediated* outcomes. That is the right trade:
 * a second evaluator could guess at them, and its guesses would be indistinguishable in the report
 * from the deterministic facts. Model-sourced differences are therefore reported as **advisory** and
 * can never auto-reject a candidate — a non-deterministic original verdict cannot falsify anything.
 *
 * ## Why the record needs `call`
 *
 * `DecisionRecord.inputSummary` is a *display* string: one field of the input, whitespace collapsed,
 * truncated at 300 characters. Feeding it back as `{ command: inputSummary }` — which is what this
 * module replaced — silently changes the haystack the matchers read, so verdicts differ for reasons
 * unrelated to the clause under test. `DecisionRecord.call` (added alongside this module, in the
 * shape `#43` gave `SupervisionRecord`) is the re-evaluable form. A record written before that field
 * existed is **unreplayable** and is reported in its own bucket — never silently counted as
 * "unchanged", which would understate a candidate's blast radius, and never reconstructed from prose.
 *
 * ## The calibration invariant
 *
 * {@link calibrate} replays the window with the corpus *unmodified* and asserts every deterministic
 * recorded verdict comes back identical. If that fails, every other number this module prints is
 * meaningless, so it is checked first and its failure says so (`T16`).
 */

import { DecisionRecord, fingerprint } from '../audit/trail';
import { RecordedCall } from '../supervisor/models';
import { EXEMPT_TOOLS, decideDeterministically } from '../hooks/permissionRequest';
import { haystackFor } from '../hooks/session';
import { Clause, ClauseLevel, ClauseMatcher, clauseMatches, compileMatcher } from './practices';

// --------------------------------------------------------------------------- shapes

/** What kind of authority produced the recorded verdict. Drives which auto-rejects may fire. */
export type VerdictSource =
  /** A human answered an escalation, or wrote the practice that was cited. */
  | 'human'
  /** A deterministic rung decided: a written clause, a correction, or the built-in table. */
  | 'clause'
  /** The classifier decided. Non-deterministic, so a difference here can never auto-reject. */
  | 'model'
  /**
   * Nothing decided, and the hook fell closed (or observe mode returned no verdict). Not a judgement
   * about the call, so changing it is not a *reversal* — it is the named gap the pipeline exists to
   * close. Spec §4.3 folds this into `clause`; kept apart here because AR2 would otherwise demand a
   * `supersedes` for a clause that never existed.
   */
  | 'fallback';

/** The three outcomes a replayed decision can have. `none` is "the ladder stayed silent". */
export type ReplayVerdict = 'allow' | 'deny' | 'none';

export type Direction = 'narrowing' | 'widening';

/**
 * The candidate under test. A subset of the pipeline's `ClauseCandidate` — this module needs the
 * matchable shape and the two declarations that license a reversal, and nothing else. Provenance is
 * the static stage's business (§3, §6.1).
 */
export interface ReplayCandidate {
  id: string;
  level: ClauseLevel;
  /** `team` | `project` | `user`, as the corpus uses it. */
  tier: string;
  title?: string;
  body?: string;
  /** Raw pattern literals from the `Match:` line, uncompiled. */
  match: string[];
  /** A rewrite, when the candidate is a permissive yellow. Decides direction for a yellow. */
  hasFix?: boolean;
  supersedes?: string[];
  displaces?: string[];
}

export interface ReplayExample {
  record_id: string;
  session_id: string;
  when: string;
  tool: string;
  /** ≤100 chars. Already redacted: it comes from the record, which redacted on the way in. */
  call_excerpt: string;
  orig_verdict: string;
  new_verdict: string;
  verdict_source: VerdictSource;
}

export interface ReplayDiff {
  /** Replayable window size actually available — the denominator every rate is over. */
  n: number;
  changed: number;
  reversals: number;
  human_reversals: number;
  /** Model-sourced originals. Counted, never an auto-reject. */
  advisory: number;
  newly_caught: number;
  /** Fraction, 0–1. The union of the candidate's patterns over the window. */
  match_pct: number;
  /** Numerator behind {@link match_pct}. */
  matched: number;
  examples: ReplayExample[];
  /**
   * Records with no `call` field: written before it existed, so they cannot be re-evaluated. Held
   * out of `n` and reported, because counting them as unchanged understates the blast radius.
   */
  unreplayable: number;
  /** Records for an {@link EXEMPT_TOOLS} tool. The hook never decides these, so replay must not. */
  exempt: number;
  /** Every changed record, for the auto-rejects and the fixture. Not rendered. */
  changes: ReplayChange[];
}

export interface ReplayChange {
  record: DecisionRecord;
  source: VerdictSource;
  orig: ReplayVerdict;
  next: ReplayVerdict;
  /** The clause id the *recorded* verdict cited, when it cited one. Drives AR2. */
  cited: string | null;
  /** The clause the replayed verdict cited. */
  next_clause: string | null;
  /** allow↔deny in either direction, as opposed to newly caught or newly silent. */
  reversal: boolean;
}

/** All three replace a real dependency with a recorded one. None is a branch inside the evaluator. */
export interface ReplayInjections {
  /** Rung 6's stand-in: the verdict the classifier gave for *this* decision. Never a model call. */
  classify(record: DecisionRecord): ReplayVerdict;
  /** The countdown's stand-in: the answer the human gave for *this* decision. No countdown runs. */
  ask(record: DecisionRecord): ReplayVerdict;
  /** Frozen to the record's own timestamp, so replay never depends on wall time. */
  clock(record: DecisionRecord): Date;
}

/**
 * The recorded injections: every question is answered from the record itself.
 *
 * This is the whole of "replay never calls a model and never reads the clock". There is no other
 * implementation and no fallback that reaches outward — a missing recorded answer replays as `none`,
 * which is the fail-closed reading.
 */
export const RECORDED: ReplayInjections = {
  classify: r => r.decision,
  ask: r => r.decision,
  clock: r => new Date(r.ts),
};

// --------------------------------------------------------------------------- reading the record

/**
 * A stable id for a decision record.
 *
 * The trail has no id field — it is append-only JSONL and nothing ever needed to name a line. Replay
 * does: `§4.4` requires a deterministic tie-break so two runs order their examples identically, and
 * a fixture has to point at the record it was built from. Timestamp plus session plus the existing
 * input fingerprint is unique in practice and derived only from data already on the record, so it is
 * stable across reads and needs nothing written.
 */
export function recordId(record: DecisionRecord): string {
  return `${record.ts}:${record.sessionId}:`
    + fingerprint(record.tool, record.call?.input ?? { s: record.inputSummary });
}

/**
 * The re-evaluable call, or null when this record predates the `call` field.
 *
 * Deliberately does **not** fall back to `{ command: inputSummary }`. That fallback is what made the
 * previous replay approximate, and an approximate replay whose error is invisible is worse than a
 * smaller honest window: the reviewer cannot tell a real behaviour change from a truncated haystack.
 */
export function replayableCall(record: DecisionRecord): RecordedCall | null {
  const call = record.call;
  if (!call || !call.tool_name) { return null; }
  return call;
}

/**
 * Which authority produced the recorded verdict.
 *
 * `deterministic` and `policy` both mean *a deterministic rung decided* — the built-in destructive
 * table is not a written clause, but reversing it is just as falsifiable as reversing one, and that
 * is the only property the auto-rejects care about. `timeout` is the fail-closed deny (or observe
 * mode's silence), which is not a judgement at all.
 */
export function verdictSourceOf(record: DecisionRecord): VerdictSource {
  switch (record.actor) {
    case 'human': return 'human';
    case 'model': return 'model';
    case 'timeout': return 'fallback';
    default: return 'clause';
  }
}

/** `practices §team-git-002@a1b2c3d` → `team-git-002`. Null when nothing was cited. */
export function citedClauseId(citation: string | null | undefined): string | null {
  if (!citation) { return null; }
  const at = citation.indexOf('§');
  if (at < 0) { return null; }
  return citation.slice(at + 1).split('@')[0].trim() || null;
}

/** The haystack the deterministic matchers read, rebuilt from the record's own call. */
export function haystackOf(call: RecordedCall): string {
  return haystackFor(call.tool_name, call.input);
}

/** Narrowing fails as friction and is reversible; widening fails as an unreviewed action (§3.4). */
export function directionOf(level: ClauseLevel, hasFix = false): Direction {
  if (level === 'green') { return 'widening'; }
  if (level === 'yellow') { return hasFix ? 'widening' : 'narrowing'; }
  return 'narrowing';
}

/** The candidate as the corpus's own `Clause`, so the evaluator sees no special case. */
export function candidateClause(candidate: ReplayCandidate): Clause {
  return {
    clauseId: candidate.id,
    citation: `practices §${candidate.id}`,
    kind: 'intention',
    level: candidate.level,
    title: candidate.title ?? candidate.id,
    tier: candidate.tier,
    text: candidate.body ?? '',
    tags: [],
    patterns: candidate.match
      .map(compileMatcher)
      .filter((p): p is ClauseMatcher => p !== null),
    sourceFile: null,
  };
}

// --------------------------------------------------------------------------- one decision

export interface DecidedReplay {
  verdict: ReplayVerdict;
  clause: string | null;
  /** Which rung answered. `injected` means the ladder stayed silent and a recording was used. */
  from: 'ladder' | 'injected' | 'fallback';
}

/**
 * Re-decide one record against a clause set. The only place the production evaluator is called.
 *
 * When the ladder stays silent, replay reproduces *what actually happened next* rather than guessing:
 * the recorded model verdict, the recorded human answer, or — for a record the hook failed closed on
 * — the same fail-closed deny. Reproducing the fallback matters: without it the empty-candidate
 * calibration would report every fail-closed deny as a change and the whole report would be noise.
 */
export function replayOne(
  record: DecisionRecord, clauses: Clause[], inj: ReplayInjections = RECORDED,
): DecidedReplay | null {
  const call = replayableCall(record);
  if (call === null) { return null; }
  const verdict = decideDeterministically(
    {
      tool_name: call.tool_name,
      tool_input: call.input ?? undefined,
      session_id: record.sessionId,
      cwd: record.cwd,
    },
    clauses,
  );
  if (verdict !== null) {
    return { verdict: verdict.decision.behavior, clause: verdict.clause, from: 'ladder' };
  }
  const source = verdictSourceOf(record);
  if (source === 'model') { return { verdict: inj.classify(record), clause: null, from: 'injected' }; }
  if (source === 'human') { return { verdict: inj.ask(record), clause: null, from: 'injected' }; }
  if (source === 'fallback') {
    // The hook denies when nothing decided, because silence is never approval. Rung 7, reproduced.
    return { verdict: record.decision, clause: null, from: 'fallback' };
  }
  return { verdict: 'none', clause: null, from: 'fallback' };
}

// --------------------------------------------------------------------------- the window

export interface ReplayOptions {
  /** How many of the newest records to replay. §4.1's N; 500 is the number the report prints. */
  window?: number;
  injections?: ReplayInjections;
  /** Compare against these verdicts instead of the recording. Ablation's control group. */
  baseline?: Map<string, ReplayVerdict>;
}

/** The newest `window` records that replay can actually use, oldest-first for stable ordering. */
export function replayableWindow(records: DecisionRecord[], window: number): DecisionRecord[] {
  return records.filter(r => !EXEMPT_TOOLS.has(r.tool)).slice(-window);
}

/**
 * Replay a window against `clauses` and diff the result against what was recorded.
 *
 * `clauses` is the *whole* set to evaluate against — the caller decides whether that is the corpus
 * plus a candidate (replay) or the corpus minus a clause (ablation). Passing the corpus unchanged is
 * the calibration case and must produce a diff of zero; see {@link calibrate}.
 */
export function replayWindow(
  records: DecisionRecord[],
  clauses: Clause[],
  candidate: ReplayCandidate | null,
  opts: ReplayOptions = {},
): ReplayDiff {
  const inj = opts.injections ?? RECORDED;
  const window = opts.window ?? 500;
  const all = records.slice(-window);
  const exempt = all.filter(r => EXEMPT_TOOLS.has(r.tool)).length;
  const usable = all.filter(r => !EXEMPT_TOOLS.has(r.tool));

  const cand = candidate ? candidateClause(candidate) : null;
  const changes: ReplayChange[] = [];
  let unreplayable = 0;
  let matched = 0;
  let n = 0;

  for (const record of usable) {
    const call = replayableCall(record);
    if (call === null) { unreplayable += 1; continue; }
    n += 1;
    if (cand && clauseMatches(cand, haystackOf(call))) { matched += 1; }

    const decided = replayOne(record, clauses, inj);
    if (decided === null) { continue; } // unreachable: `call` is non-null here
    const orig = opts.baseline?.get(recordId(record)) ?? record.decision;
    if (decided.verdict === orig) { continue; }

    const source = verdictSourceOf(record);
    const concrete = (v: ReplayVerdict) => v === 'allow' || v === 'deny';
    changes.push({
      record,
      source,
      orig,
      next: decided.verdict,
      cited: citedClauseId(record.clause),
      next_clause: decided.clause,
      // A fail-closed deny is not a judgement about the call — nothing said it was unsafe, only that
      // nothing said it was safe. Overturning it is therefore *newly caught*, not a reversal. Counting
      // it as one would make every candidate that closes a policy gap look like it contradicts the
      // corpus, which is the opposite of what it does.
      reversal: source !== 'fallback' && concrete(orig) && concrete(decided.verdict),
    });
  }

  const reversals = changes.filter(c => c.reversal);
  return {
    n,
    changed: changes.length,
    reversals: reversals.length,
    human_reversals: reversals.filter(c => c.source === 'human').length,
    advisory: changes.filter(c => c.source === 'model').length,
    // "Newly caught": nothing judged this call before — it reached a prompt, or fell closed.
    newly_caught: changes.filter(c => !c.reversal && c.next !== 'none').length,
    match_pct: n === 0 ? 0 : matched / n,
    matched,
    examples: pickExamples(changes, inj),
    unreplayable,
    exempt,
    changes,
  };
}

/**
 * The ≤3 examples the report shows: the human-adjacent change first, then the two most distinct by
 * tool name. Ties break on {@link recordId}, so two runs over one window order identically (`T19`).
 */
export function pickExamples(changes: ReplayChange[], inj: ReplayInjections): ReplayExample[] {
  const byId = [...changes].sort((a, b) => recordId(a.record).localeCompare(recordId(b.record)));
  const chosen: ReplayChange[] = [];
  const human = byId.find(c => c.source === 'human');
  if (human) { chosen.push(human); }
  const tools = new Set(chosen.map(c => c.record.tool));
  for (const c of byId) {
    if (chosen.length >= 3) { break; }
    if (chosen.includes(c) || tools.has(c.record.tool)) { continue; }
    chosen.push(c);
    tools.add(c.record.tool);
  }
  for (const c of byId) {
    if (chosen.length >= 3) { break; }
    if (!chosen.includes(c)) { chosen.push(c); }
  }
  return chosen.map(c => ({
    record_id: recordId(c.record),
    session_id: c.record.sessionId,
    when: inj.clock(c.record).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tool: c.record.tool,
    call_excerpt: excerpt(c.record),
    orig_verdict: c.orig,
    new_verdict: c.next,
    verdict_source: c.source,
  }));
}

/** ≤100 chars of the call. Taken from the record, which redacted it on the way in (`T20`). */
export function excerpt(record: DecisionRecord): string {
  const flat = record.inputSummary.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}

// --------------------------------------------------------------------------- calibration (T16)

export interface Calibration {
  ok: boolean;
  n: number;
  /** Records whose deterministic verdict did not come back identical. Each one is a gate bug. */
  mismatches: ReplayChange[];
  message: string;
}

/**
 * Replay the window with the corpus **unmodified** and require every deterministic recorded verdict
 * back, exactly.
 *
 * This is the gate's self-test and it runs before anything else. A mismatch here does not mean the
 * candidate is bad — it means the *replay* is wrong (a stale record, a corpus that has moved on since
 * the decision, a truncated call) and therefore that no number the gate prints can be trusted. Model-
 * sourced records are excluded because their originals were never deterministic to begin with.
 */
export function calibrate(
  records: DecisionRecord[], clauses: Clause[], opts: ReplayOptions = {},
): Calibration {
  const diff = replayWindow(records, clauses, null, opts);
  const mismatches = diff.changes.filter(c => c.source === 'human' || c.source === 'clause');
  const ok = mismatches.length === 0;
  return {
    ok,
    n: diff.n,
    mismatches,
    message: ok
      ? `calibration ok — ${diff.n} recorded verdicts reproduced exactly`
      : `CALIBRATION FAILED: ${mismatches.length} of ${diff.n} recorded verdicts did not reproduce `
        + 'against the unmodified corpus. Every replay and ablation number in this run is therefore '
        + 'meaningless — a candidate\'s "23 of 500 changed" cannot be told apart from replay error. '
        + 'Fix the window (records missing `call`, or a corpus that has moved on since these '
        + 'decisions were made) before reading any other output. First mismatch: '
        + `${mismatches[0].record.tool} ${excerpt(mismatches[0].record)} `
        + `(recorded ${mismatches[0].orig}, replayed ${mismatches[0].next})`,
  };
}

// --------------------------------------------------------------------------- auto-rejects (§4.3)

/** Churn ceiling: above this the "here are 3 examples" packet stops being representative. */
export const CHURN_LIMIT = 0.2;

/** AR4 needs a denominator worth dividing by. Matches §9's exit-40 window floor. */
export const CHURN_MIN_WINDOW = 100;

export interface AutoReject {
  code: 'AR1' | 'AR2' | 'AR3' | 'AR4' | 'INERT';
  message: string;
  evidence?: string;
}

/**
 * A candidate whose patterns match real calls and yet change nothing.
 *
 * §4.4 calls this "an internal inconsistency (exit 70)", and that is wrong on this ladder: it has an
 * ordinary explanation, and it was the first thing a run against real records produced. A green
 * candidate matching `drop table tmp_…` matched 3 of 126 real calls and changed zero of them, because
 * rung 3 — a written red — decides every one of them before rung 4 is reached. Nothing is broken; the
 * clause is simply inert.
 *
 * It still has to be a rejection rather than a pass. A reviewer shown "PASS, 0 of 126 changed" merges
 * a clause that does nothing, and a corpus that grows by clauses that do nothing is the exact failure
 * this gate exists to prevent — a clause with no effect cannot be ablated into evidence later either,
 * because its zero is indistinguishable from dead weight the day it lands.
 */
export function inertFinding(diff: ReplayDiff): AutoReject | null {
  if (diff.matched === 0 || diff.changed > 0) { return null; }
  return {
    code: 'INERT',
    message: `this matches ${diff.matched} real call(s) in the window and changes none of them — a `
      + 'higher rung already decides every call it matches, so the clause would be inert. It cannot '
      + 'be falsified by replay and its ablation zero would be indistinguishable from dead weight',
  };
}

/**
 * The four auto-rejects, ordered; the first match wins and becomes the rejection reason.
 *
 * A model-sourced difference is never one of them. We know the original verdict was
 * non-deterministic, so a difference may be replay artefact rather than behaviour change, and
 * rejecting a candidate on it would be rejecting it for our own uncertainty. They are counted and
 * reported as advisory instead — except in AR4's churn, where a *widening* candidate's model
 * reversals do count, because the review packet's representativeness is what churn measures and a
 * widening candidate is the one whose failure nobody sees (§6.2).
 */
export function autoReject(
  candidate: ReplayCandidate, diff: ReplayDiff,
): AutoReject | null {
  const declared = new Set([...(candidate.supersedes ?? []), ...(candidate.displaces ?? [])]);

  const humanFlip = diff.changes.find(c => c.source === 'human');
  if (humanFlip) {
    return {
      code: 'AR1',
      message: `this would ${humanFlip.next} a call a human explicitly ${verbFor(humanFlip.orig)} `
        + '— a learned clause never overturns a human\'s own answer',
      evidence: `${humanFlip.record.tool}: ${excerpt(humanFlip.record)}`,
    };
  }

  // Only a decision that actually *cited* a clause can be superseded, because `supersedes` names a
  // clause id. A built-in-table deny cites nothing, so there is nothing to declare and AR2 cannot
  // apply — overriding the built-in defaults with a written rule is documented, intended behaviour
  // ("a written rule that cannot override a built-in default is not a policy layer"). Such a change
  // falls through to AR3, which is what stops the dangerous direction of it.
  const undeclared = diff.changes.find(
    c => c.source === 'clause' && c.cited !== null && !declared.has(c.cited),
  );
  if (undeclared) {
    return {
      code: 'AR2',
      message: `this flips a decision §${undeclared.cited} made, without declaring supersedes or `
        + 'displaces for it — a clause that silently outranks another is how a corpus becomes '
        + 'unexplainable',
      evidence: `${undeclared.record.tool}: ${excerpt(undeclared.record)}`,
    };
  }

  if (candidate.level === 'green') {
    // §4.3 writes AR3 as "any recorded deny, regardless of `verdict_source`" — which contradicts the
    // same section's rule that a model-sourced verdict can never auto-reject. Two exclusions resolve
    // it, and both are deliberate:
    //
    //  - `fallback`. Taken literally, "any recorded deny" rejects every green candidate ever
    //    proposed: the highest-signal mining input *is* the call that fell closed, and a fail-closed
    //    record's `decision` is `deny`. That deny means "nothing said this was safe", not "something
    //    said it was unsafe", and closing that gap is the entire purpose of a learned green.
    //  - `model`. The stronger of the two contradicting rules wins: a non-deterministic original
    //    verdict cannot falsify anything, so it is counted and reported as advisory instead.
    //
    // What remains is every deny a *deterministic* rung or a human actually decided, which is the
    // class AR3 exists for — including the built-in destructive table, which cites no clause and so
    // is out of AR2's reach.
    const overRed = diff.changes.find(
      c => (c.source === 'clause' || c.source === 'human')
        && c.orig === 'deny' && c.next === 'allow');
    if (overRed) {
      return {
        code: 'AR3',
        message: 'a green candidate would turn a recorded deny into an allow. Learned green never '
          + 'beats anything red, whatever produced the deny',
        evidence: `${overRed.record.tool}: ${excerpt(overRed.record)}`,
      };
    }
  }

  const churnable = directionOf(candidate.level, candidate.hasFix) === 'widening'
    ? diff.changed
    : diff.changed - diff.advisory;
  // A rate needs a denominator. Below the minimum window §9 refuses the *run* anyway, and computing
  // "100% churn" over one record would reject a candidate for the window's size rather than for its
  // own behaviour — the one auto-reject that could fire on an artefact of how little history exists.
  if (diff.n >= CHURN_MIN_WINDOW && churnable / diff.n > CHURN_LIMIT) {
    return {
      code: 'AR4',
      message: `too-disruptive: ${churnable} of ${diff.n} decisions change `
        + `(${pct(churnable / diff.n)}, limit ${pct(CHURN_LIMIT)}). Above this the packet's three `
        + 'examples are not representative of what the reviewer is approving',
    };
  }
  return null;
}

function verbFor(v: ReplayVerdict): string {
  return v === 'allow' ? 'approved' : v === 'deny' ? 'denied' : 'left to a prompt';
}

// --------------------------------------------------------------------------- the report (§4.4)

/** One decimal and a `%`, always — so `0.0%` and `4.2%` line up in a column of reports. */
export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface ReportInput {
  candidate: ReplayCandidate;
  diff: ReplayDiff;
  verdict: 'pass' | 'reject';
  reason?: string;
  fixturePath: string;
}

/**
 * The report, as `§4.4` writes it. Second person and concrete on purpose: the reviewer's question is
 * "what does this do to me", not "what is this clause's F1".
 */
export function renderReport(input: ReportInput): string {
  const { candidate, diff } = input;
  const direction = directionOf(candidate.level, candidate.hasFix);
  const lines: string[] = [
    `Candidate ${candidate.id} (${candidate.level ?? 'no level'}, ${direction})`,
    '',
    `Would have changed ${diff.changed} of your last ${plural(diff.n, 'decision')}.`,
    `  ${plural(diff.reversals, 'reversal')} (${diff.human_reversals} of a human's own answer)`,
    `  ${diff.advisory} advisory (original verdict came from the model, not a clause)`,
    `  ${plural(diff.newly_caught, 'call')} newly caught that previously reached a prompt`,
    '',
    `Breadth: matches ${pct(diff.match_pct)} of calls in this window `
      + `(${diff.matched} of ${diff.n}).`,
    '',
    'Examples:',
  ];
  diff.examples.forEach((e, i) => {
    lines.push(`  ${i + 1}. [${e.orig_verdict} -> ${e.new_verdict}] ${e.tool}: ${e.call_excerpt}`);
    lines.push(`     session ${e.session_id}, ${e.when}`);
  });
  if (diff.examples.length === 0) { lines.push('  (none)'); }
  lines.push('');
  lines.push(`Verdict: ${input.verdict === 'pass' ? 'PASS' : 'REJECT'}`
    + (input.reason ? ` ${input.reason}` : ''));
  lines.push(`Fixture: ${input.fixturePath}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The fixed warning a widening packet always carries (§6.3).
 *
 * An allowed call can persist a standing rule into Claude Code's own settings, after which our hook
 * is never consulted for matching calls — so revoking the clause reaches nothing. It is the one
 * failure in this design with no undo, which is why the line is a constant and not a judgement.
 */
export const WIDENING_WARNING =
  'This clause can allow calls. If settings-persistence is enabled, revoking it later may not '
  + 'revoke the permission it grants.';

// --------------------------------------------------------------------------- the entry point

export interface ReplayResult {
  candidate_id: string;
  direction: Direction;
  calibration: Calibration;
  diff: ReplayDiff;
  rejection: AutoReject | null;
  verdict: 'pass' | 'reject';
  reason?: string;
  report_text: string;
  /** Warnings a human should read, not errors. Empty on a clean pass. */
  notes: string[];
}

export interface ReplayGateOptions extends ReplayOptions {
  /** Below this the *run* is refused, not the candidate (exit 40). §9. */
  minWindow?: number;
  fixturePath?: string;
}

/**
 * Validate one candidate by replay: calibrate, replay, auto-reject, render.
 *
 * Returns a `reject` verdict for a candidate the evidence refuses; a *run* that cannot produce
 * evidence at all (a window under `minWindow`, or a failed calibration) is reported through
 * `calibration.ok` / `diff.n` and is the caller's exit 40 / exit 70, because that is a statement
 * about the gate rather than about the clause.
 */
export function replayCandidate(
  candidate: ReplayCandidate,
  records: DecisionRecord[],
  corpus: Clause[],
  opts: ReplayGateOptions = {},
): ReplayResult {
  const calibration = calibrate(records, corpus, opts);
  const diff = replayWindow(records, [...corpus, candidateClause(candidate)], candidate, opts);
  const rejection = calibration.ok
    ? autoReject(candidate, diff) ?? inertFinding(diff)
    : null;
  const direction = directionOf(candidate.level, candidate.hasFix);

  const notes: string[] = [];
  if (direction === 'widening') { notes.push(WIDENING_WARNING); }
  if (diff.unreplayable > 0) {
    notes.push(`${diff.unreplayable} record(s) in this window predate the \`call\` field and could `
      + 'not be re-evaluated. They are excluded from every number above rather than counted as '
      + 'unchanged, so the real blast radius may be larger than reported.');
  }
  if (new Set(diff.changes.map(c => c.record.sessionId)).size === 1 && diff.changed > 0) {
    notes.push('single-session evidence: every change is in one session. One session is an anecdote.');
  }

  const verdict: 'pass' | 'reject' = rejection === null ? 'pass' : 'reject';
  return {
    candidate_id: candidate.id,
    direction,
    calibration,
    diff,
    rejection,
    verdict,
    reason: rejection ? `${rejection.code} ${rejection.message}` : undefined,
    report_text: renderReport({
      candidate,
      diff,
      verdict,
      reason: rejection ? `${rejection.code} ${rejection.message}` : undefined,
      fixturePath: opts.fixturePath ?? `tests/fixtures/clauses/${candidate.id}.json`,
    }),
    notes,
  };
}
