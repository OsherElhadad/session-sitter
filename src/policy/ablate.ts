/**
 * Ablation — the same replay engine pointed backwards, so that **deletion becomes falsifiable**.
 *
 * `12-validation.md` §5. Agent rule files grow +226% over their lifetime, +4.9 net instructions per
 * commit, and instruction-following collapses to 68% at 500 instructions. Nobody deletes rules, and
 * the reason is epistemic rather than lazy: *"to find out whether this rule matters I would have to
 * delete it and see if anything bad happens"* — over weeks, in production, with no control group.
 *
 * Replay is the control group. Remove one clause from a clone of the corpus, re-decide the window
 * with the *same* evaluator, and count what moves. Zero changes over a meaningful window is a
 * retirement candidate **with evidence attached**, which turns "our policy corpus only grows" from a
 * law of nature into a bug.
 *
 * ## The control group is computed, not read
 *
 * `changed` compares the ablated corpus against the corpus **as it is now**, both evaluated here —
 * not against what the trail recorded. Those differ whenever the corpus moved on since a decision was
 * made, and in that case the recording measures corpus drift while the question was about one clause.
 * The baseline costs one extra pass over a few thousand short strings.
 *
 * ## Why a zero means much less for a red (§5.5)
 *
 * A red that never fired has three explanations demanding opposite actions:
 *
 *  - **working deterrent** — it fired, behaviour changed, it stopped firing. Zero *recent* fires is
 *    precisely what success looks like. Never propose retiring it.
 *  - **dead weight?** — the hazard shape occurs in this traffic (a near-miss) and the clause still
 *    never triggers. A human may propose retirement.
 *  - **insufficient exposure** — the window never contained the situation. Not a candidate at all.
 *
 * So red and orange ablation reads the **lifetime** record rather than a 90-day slice, and **the gate
 * never auto-proposes retiring a red or orange**. A confident-looking zero on a safety clause is
 * worse than no output: it launders "I have no evidence" as "I have evidence of nothing".
 */

import { DecisionRecord } from '../audit/trail';
import { CompiledClause } from './compile';
import { Clause, ClauseLevel, ClauseMatcher, compileMatcher } from './practices';
import {
  Direction,
  ReplayInjections,
  ReplayVerdict,
  RECORDED,
  citedClauseId,
  directionOf,
  haystackOf,
  recordId,
  replayOne,
  replayWindow,
  replayableCall,
} from './replay';

// --------------------------------------------------------------------------- shapes

/**
 * How a zero should be read. `in-service` is not in the spec's enum, which has no value for "this
 * clause is doing work" — reporting a live clause as `deterrent` (a term that means *it fired and then
 * stopped*) would misdescribe it, so the value is added rather than the meaning bent.
 */
export type EvidenceClass =
  | 'retire'
  | 'dead-weight?'
  | 'deterrent'
  | 'insufficient-exposure'
  | 'in-service';

export interface AblationWindow {
  decisions: number;
  days: number;
  /** True when the window is every record the store holds — reds and oranges (§5.5). */
  lifetime: boolean;
}

export interface AblationReport {
  clause_id: string;
  level: ClauseLevel;
  tier: string;
  window: AblationWindow;
  /** Decisions whose verdict moves when this clause is removed. The whole measurement. */
  changed: number;
  /** Relaxed-pattern hits: the hazard's shape occurs even though the clause never triggered. */
  near_misses: number;
  /** Citations anywhere in the store. For a red this is what separates deterrent from dead weight. */
  lifetime_fires: number;
  /** Citations inside the window. */
  window_fires: number;
  evidence_class: EvidenceClass;
  retirement_candidate: boolean;
  /** The one line a reviewer needs: the window size and the zero. */
  evidence: string;
  note?: string;
}

export interface AblationOptions {
  /** Green/yellow window: 2,000 decisions or 90 days, whichever is larger. */
  decisions?: number;
  days?: number;
  now?: Date;
  injections?: ReplayInjections;
}

/**
 * The green-clause caveat (§6.3). A green that ablates to zero may look dead because the permission
 * it granted has already been persisted into Claude Code's own settings, where our hook is never
 * consulted. Retiring it then reads as harmless cleanup while the underlying grant stays.
 */
export const GREEN_PERSISTENCE_NOTE =
  'A green clause can ablate to zero because the permission it grants was already persisted into '
  + 'Claude Code\'s settings, so something else is doing its job. Retiring it removes the clause, not '
  + 'the grant. Confirm settings-persistence is off before treating this zero as dead weight.';

/** The line every packet that retires a red must carry (§5.4). */
export const RED_RETIREMENT_CAVEAT =
  'This retires a red clause. Its zero may be deterrence, not dead weight — see the evidence class '
  + 'below.';

// --------------------------------------------------------------------------- windows

/** Reds and oranges read the lifetime record: "did this ever matter" is not answerable in a slice. */
export function isSafetyLevel(level: ClauseLevel): boolean {
  return level === 'red' || level === 'orange';
}

/**
 * The ablation window for a clause.
 *
 * Green and yellow get *whichever is larger* of the last N decisions and the last D days — a quiet
 * month must not shrink the evidence, and a busy week must not stand in for a quarter. Red and orange
 * get everything, which is the whole of `T39`: shortening the configured window cannot change a red's
 * classification because the configured window is not what a red is read against.
 */
export function ablationWindow(
  records: DecisionRecord[], level: ClauseLevel, opts: AblationOptions = {},
): { records: DecisionRecord[]; window: AblationWindow } {
  const decisions = opts.decisions ?? 2000;
  const days = opts.days ?? 90;
  if (isSafetyLevel(level)) {
    return {
      records,
      window: { decisions: records.length, days: spanDays(records), lifetime: true },
    };
  }
  const byCount = records.slice(-decisions);
  const cutoff = (opts.now ?? new Date()).getTime() - days * 86_400_000;
  const byDays = records.filter(r => Date.parse(r.ts) >= cutoff);
  const chosen = byCount.length >= byDays.length ? byCount : byDays;
  return {
    records: chosen,
    window: { decisions: chosen.length, days: spanDays(chosen), lifetime: false },
  };
}

function spanDays(records: DecisionRecord[]): number {
  if (records.length < 2) { return 0; }
  const times = records.map(r => Date.parse(r.ts)).filter(t => Number.isFinite(t));
  if (times.length < 2) { return 0; }
  return Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000);
}

// --------------------------------------------------------------------------- near-misses (§5.5)

/**
 * The relaxations that turn "this clause never fired" into "the hazard's shape does / does not occur
 * in this traffic". Three string transforms, not a similarity model: drop the regex anchors, drop the
 * final path segment, and keep the longest 6-character literal run.
 *
 * `ponytail`: upgrade when a real red gets misclassified. Until then the point is only to tell an
 * untriggered clause apart from a dead one, and a blunt instrument does that.
 */
export function relaxations(raw: string): string[] {
  const out = new Set<string>();
  const body = raw.startsWith('/') && raw.lastIndexOf('/') > 0
    ? raw.slice(1, raw.lastIndexOf('/'))
    : raw;
  const unanchored = body.replace(/^\^/, '').replace(/\$$/, '');
  if (unanchored && unanchored !== body) { out.add(`/${unanchored}/`); }
  const trimmedPath = unanchored.replace(/[/\\][^/\\]+$/, '');
  if (trimmedPath && trimmedPath !== unanchored) { out.add(trimmedPath); }
  const literal = longestLiteral(unanchored);
  if (literal.length >= 6) { out.add(literal); }
  return [...out];
}

/** The longest run of characters carrying no regex metacharacter — the clause's literal core. */
function longestLiteral(pattern: string): string {
  let best = '';
  for (const run of pattern.split(/[^A-Za-z0-9 _.-]+/)) {
    const flat = run.trim();
    if (flat.length > best.length) { best = flat; }
  }
  return best;
}

/**
 * How often the hazard's *shape* occurs in the window without the clause firing.
 *
 * Records the clause actually cited are excluded: a fire is evidence the clause works, not a
 * near-miss, and counting it in both places would make every live clause look like dead weight.
 */
export function nearMisses(
  clause: Pick<Clause, 'clauseId'> & { patterns: readonly string[] },
  records: DecisionRecord[],
): number {
  const relaxed = clause.patterns
    .flatMap(relaxations)
    .map(compileMatcher)
    .filter((p): p is ClauseMatcher => p !== null);
  if (relaxed.length === 0) { return 0; }
  let hits = 0;
  for (const record of records) {
    if (citedClauseId(record.clause) === clause.clauseId) { continue; }
    const call = replayableCall(record);
    if (call === null) { continue; }
    const hay = haystackOf(call);
    if (relaxed.some(p => p.re.test(hay))) { hits += 1; }
  }
  return hits;
}

// --------------------------------------------------------------------------- the baseline

/** Verdicts under the corpus as it stands. Ablation's control group, computed not recorded. */
export function baselineVerdicts(
  records: DecisionRecord[], clauses: Clause[], inj: ReplayInjections = RECORDED,
): Map<string, ReplayVerdict> {
  const out = new Map<string, ReplayVerdict>();
  for (const record of records) {
    const decided = replayOne(record, clauses, inj);
    if (decided !== null) { out.set(recordId(record), decided.verdict); }
  }
  return out;
}

// --------------------------------------------------------------------------- one clause

/** How many records cite this clause. `fires` in the §5.5 sense. */
export function firesFor(clauseId: string, records: DecisionRecord[]): number {
  return records.filter(r => citedClauseId(r.clause) === clauseId).length;
}

/**
 * Ablate one clause: what changes if it is not there?
 *
 * `corpus` is the whole live clause set including the one being ablated. The clause is removed from a
 * clone; nothing here mutates the corpus, and nothing here writes retirement state — the gate
 * produces evidence and governance's `accept` / `displaces` write the states.
 */
export function ablate(
  clauseId: string,
  corpus: Clause[],
  records: DecisionRecord[],
  opts: AblationOptions = {},
): AblationReport {
  const target = corpus.find(c => c.clauseId === clauseId);
  if (!target) { throw new Error(`ablate: no clause ${clauseId} in the corpus`); }
  const inj = opts.injections ?? RECORDED;
  const { records: windowRecords, window } = ablationWindow(records, target.level, opts);
  const without = corpus.filter(c => c.clauseId !== clauseId);

  const baseline = baselineVerdicts(windowRecords, corpus, inj);
  const diff = replayWindow(windowRecords, without, null, {
    window: windowRecords.length,
    injections: inj,
    baseline,
  });

  // A loaded `Clause` carries each matcher's source text alongside its `RegExp`, so the relaxations
  // get exactly what the author typed — `RegExp.source` would hand back an escaped, whitespace-
  // loosened rewrite of a substring pattern and relax the wrong string.
  const rawPatterns = target.patterns.map(p => (p.isRegex ? `/${p.raw}/` : p.raw));
  const misses = nearMisses({ clauseId, patterns: rawPatterns }, windowRecords);
  const lifetimeFires = firesFor(clauseId, records);
  const windowFires = firesFor(clauseId, windowRecords);
  const evidenceClass = classify(target.level, diff.changed, lifetimeFires, misses);

  // Never for a red or an orange, in any window, for any evidence class (T36).
  const retirement = diff.changed === 0 && !isSafetyLevel(target.level);
  return {
    clause_id: clauseId,
    level: target.level,
    tier: target.tier,
    window,
    changed: diff.changed,
    near_misses: misses,
    lifetime_fires: lifetimeFires,
    window_fires: windowFires,
    evidence_class: evidenceClass,
    retirement_candidate: retirement,
    evidence: `removing ${target.citation} changes ${diff.changed} of ${diff.n} decisions over `
      + `${window.lifetime ? 'the lifetime record' : `${window.decisions} decisions`}`
      + ` (${window.days} days); ${lifetimeFires} lifetime fire(s), ${misses} near-miss(es)`,
    note: noteFor(target.level, retirement),
  };
}

/**
 * The three-way read of a zero, plus the two non-zero cases.
 *
 * Order matters: a lifetime fire makes a clause a `deterrent` whatever the window says, because that
 * is the reading a zero on a safety clause is *most likely* to have and the one whose misreading is
 * unrecoverable.
 */
export function classify(
  level: ClauseLevel, changed: number, lifetimeFires: number, misses: number,
): EvidenceClass {
  if (isSafetyLevel(level)) {
    if (lifetimeFires >= 1) { return 'deterrent'; }
    if (misses >= 1) { return 'dead-weight?'; }
    return 'insufficient-exposure';
  }
  if (changed > 0) { return 'in-service'; }
  return 'retire';
}

function noteFor(level: ClauseLevel, retirement: boolean): string | undefined {
  if (isSafetyLevel(level)) { return RED_RETIREMENT_CAVEAT; }
  if (retirement && level === 'green') { return GREEN_PERSISTENCE_NOTE; }
  return undefined;
}

// --------------------------------------------------------------------------- the whole corpus

/**
 * Ablate every clause, **one at a time, re-ablating after each acceptance**.
 *
 * This is the one place the design must not be lazy. Two clauses that each cover the other's cases
 * each ablate to zero against the same corpus, so a batch run proposes retiring both and the coverage
 * disappears. Accepting a retirement removes the clause from the corpus the *next* ablation is
 * measured against, which is exactly what makes the second one come back non-zero (`T23`).
 *
 * Order is by clause id so a run is reproducible; there is no cleverness about which of a mutually
 * covering pair survives, because there is no defensible basis for one — a human picks from the
 * report.
 */
export function ablateAll(
  corpus: Clause[], records: DecisionRecord[], opts: AblationOptions = {},
): AblationReport[] {
  const ordered = [...corpus].sort((a, b) => a.clauseId.localeCompare(b.clauseId));
  let live = [...corpus];
  const out: AblationReport[] = [];
  for (const clause of ordered) {
    const report = ablate(clause.clauseId, live, records, opts);
    out.push(report);
    if (report.retirement_candidate) {
      live = live.filter(c => c.clauseId !== clause.clauseId);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- ceiling (§5.3)

/** 25 *rendered* clauses per learned tier. One number, in config, not adaptive. */
export const CEILING_PER_TIER = 25;

/**
 * The four ceiling tiers. Direction, not level, decides the bucket: a permissive yellow sits with the
 * greens and a narrowing one with the reds, so the tier already encodes direction and the eviction
 * ranking does not have to re-derive it.
 */
export type CeilingTier = 'human-red' | 'human-green' | 'learned-red' | 'learned-green';

export function ceilingTierOf(
  origin: 'human' | 'learned', level: ClauseLevel, hasFix = false,
): CeilingTier {
  const side: Direction = directionOf(level, hasFix);
  return `${origin}-${side === 'widening' ? 'green' : 'red'}` as CeilingTier;
}

/** A compiled clause's ceiling tier, read off the artifact. */
export function tierOfCompiled(clause: CompiledClause): CeilingTier {
  return ceilingTierOf(clause.origin, clause.level, clause.fix !== null);
}

/**
 * How many clauses in a tier actually reach the prompt.
 *
 * The ceiling's justification is the compliance curve, and that curve is a property of *instructions
 * in a prompt*. A deterministic-only clause never enters one: by the time the classifier runs, every
 * matchable clause has already been tested against this call and missed, so rendering it is pure waste
 * — it cannot fire deterministically and as prose it claims to be about something its own pattern says
 * this call is not. So it costs a regex test, not an instruction, and it is exempt.
 *
 * That exemption is what dissolves the eviction hazard for the clauses that matter: a deterministic red
 * consumes no budget, so ceiling pressure against it cannot arise. It holds only while the selector
 * excludes evaluated-and-missed clauses — reintroduce an unfiltered bundle and this becomes untrue.
 */
export function renderedCount(clauses: readonly CompiledClause[], tier: CeilingTier): number {
  return clauses.filter(c =>
    c.status === 'accepted' && tierOfCompiled(c) === tier && c.patterns.length === 0).length;
}

// --------------------------------------------------------------------------- displacement (§5.4)

export interface Incumbent {
  id: string;
  level: ClauseLevel;
  tier: CeilingTier;
  /** Citations in the last 90 days. */
  citations: number;
  /** Ablation `changed` over the clause's window, when one was computed. */
  ablationChanged: number;
  /** Newest citing record, or null when it has never been cited. */
  lastCited: Date | null;
  evidenceClass: EvidenceClass;
}

export interface DisplacementDecision {
  tier: CeilingTier;
  at_ceiling: boolean;
  ceiling: number;
  rendered_count: number;
  target?: { id: string; value: number; level: ClauseLevel };
  /** Target is a red or an orange — governance's widening bar applies to the human approval. */
  reduces_coverage: boolean;
  outcome: 'admit' | 'displace' | 'reject';
  displaced?: string;
  reason?: string;
  /** Lines the packet must carry verbatim. */
  caveats: string[];
}

/** Citations in the last 90 days, tie-broken by ablation `changed`. The clause's measured worth. */
export function valueOf(incumbent: Incumbent): number {
  return incumbent.citations;
}

/**
 * The eviction target, confined to the candidate's own tier: walk the classes and take the first
 * non-empty one.
 *
 *   1. zero citations in 90 days **and** `ablation.changed === 0`
 *   2. zero citations in 90 days
 *   3. ascending value
 *
 * Ties break on longest time since last citation — the one dead longest goes first (`T44`).
 */
export function evictionTarget(
  tier: CeilingTier, incumbents: readonly Incumbent[],
): Incumbent | undefined {
  const inTier = incumbents.filter(i => i.tier === tier);
  const deadest = (a: Incumbent, b: Incumbent) => {
    const at = a.lastCited?.getTime() ?? -Infinity;
    const bt = b.lastCited?.getTime() ?? -Infinity;
    if (at !== bt) { return at - bt; }
    return a.id.localeCompare(b.id);
  };
  // Classes 1 and 2 are unordered sets of equally dead clauses, so the deadest goes first. Class 3 is
  // already ordered by value (with `deadest` as its own tie-break) and must not be re-sorted — doing
  // that throws the value ranking away and evicts by age alone, which is the opposite of the rule.
  const classes: Incumbent[][] = [
    [...inTier.filter(i => i.citations === 0 && i.ablationChanged === 0)].sort(deadest),
    [...inTier.filter(i => i.citations === 0)].sort(deadest),
    [...inTier].sort((a, b) => valueOf(a) - valueOf(b) || deadest(a, b)),
  ];
  for (const cls of classes) {
    if (cls.length > 0) { return cls[0]; }
  }
  return undefined;
}

export interface DisplacementInput {
  candidateTier: CeilingTier;
  /** The candidate's own evidence: `replay.changed`. Newest does not win by default. */
  candidateChanged: number;
  /** Rendered count for the candidate's tier, deterministic-only clauses already excluded. */
  renderedCount: number;
  incumbents: readonly Incumbent[];
  ceiling?: number;
  /** An explicitly declared `displaces:` from the candidate. Must be same-tier. */
  declared?: string[];
}

/**
 * Admit, displace, or reject.
 *
 * **Same tier only.** A `learned-red` candidate can only ever displace a `learned-red`. The
 * cross-tier disarm path — push a tier to its limit, then evict reds one at a time as routine
 * housekeeping, each eviction arriving as a tidy-up that never has to argue for a permission — does
 * not exist as a mechanism here, because no amount of ceiling pressure lets anyone trade a red away
 * for a green. That is structural rather than procedural, which is why it is the guard this relies on.
 *
 * *An eviction is not an improvement, and a tier's clause ceiling is not an excuse to disarm a safety
 * rule.* Keep that sentence: it is the kind of reasoning a refactor erases, after which the ceiling
 * quietly becomes an attack surface again.
 */
export function displace(input: DisplacementInput): DisplacementDecision {
  const ceiling = input.ceiling ?? CEILING_PER_TIER;
  const tier = input.candidateTier;
  const base = {
    tier, ceiling, rendered_count: input.renderedCount, reduces_coverage: false,
    caveats: [] as string[],
  };

  // A declared `displaces` outside the candidate's own tier is refused before anything is measured.
  // A learned clause can never displace a human one, and this is where that is enforced explicitly
  // rather than only implied by the search being tier-confined.
  const crossTier = (input.declared ?? []).find(id => {
    const inc = input.incumbents.find(i => i.id === id);
    return inc !== undefined && inc.tier !== tier;
  });
  if (crossTier) {
    return {
      ...base,
      at_ceiling: input.renderedCount >= ceiling,
      outcome: 'reject',
      reason: `E12 displaces ${crossTier} is in a different tier — displacement is same-tier only, `
        + 'and a learned clause never displaces a human one',
    };
  }

  if (input.renderedCount < ceiling) {
    return { ...base, at_ceiling: false, outcome: 'admit' };
  }

  const target = evictionTarget(tier, input.incumbents);
  if (!target) {
    return {
      ...base,
      at_ceiling: true,
      outcome: 'reject',
      reason: `E12 ${tier} is at its ceiling of ${ceiling} rendered clauses and holds nothing `
        + 'evictable. The ceiling is a hard budget, not a queue',
    };
  }

  const value = valueOf(target);
  const reducesCoverage = isSafetyLevel(target.level);
  const caveats = reducesCoverage
    ? [RED_RETIREMENT_CAVEAT, `Outgoing ${target.id} evidence class: ${target.evidenceClass}.`]
    : [];
  if (input.candidateChanged <= value) {
    return {
      ...base,
      at_ceiling: true,
      target: { id: target.id, value, level: target.level },
      reduces_coverage: reducesCoverage,
      outcome: 'reject',
      reason: `E12 the weakest incumbent in ${tier} (${target.id}, value ${value}) outranks this `
        + `candidate (${input.candidateChanged}). Newest does not win by default — that is the `
        + 'difference between a budget and a queue',
      caveats,
    };
  }
  return {
    ...base,
    at_ceiling: true,
    target: { id: target.id, value, level: target.level },
    reduces_coverage: reducesCoverage,
    outcome: 'displace',
    displaced: target.id,
    caveats,
  };
}
