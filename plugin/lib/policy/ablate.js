// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/ablate.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CEILING_PER_TIER = exports.RED_RETIREMENT_CAVEAT = exports.RED_NOT_PROPOSED = exports.SHADOWED_NOTE = exports.GREEN_PERSISTENCE_NOTE = void 0;
exports.isSafetyLevel = isSafetyLevel;
exports.ablationWindow = ablationWindow;
exports.relaxations = relaxations;
exports.nearMisses = nearMisses;
exports.baselineDecisions = baselineDecisions;
exports.baselineVerdicts = baselineVerdicts;
exports.shadowOf = shadowOf;
exports.firesFor = firesFor;
exports.ablate = ablate;
exports.classify = classify;
exports.ablateAll = ablateAll;
exports.ceilingTierOf = ceilingTierOf;
exports.tierOfCompiled = tierOfCompiled;
exports.renderedCount = renderedCount;
exports.valueOf = valueOf;
exports.evictionTarget = evictionTarget;
exports.displace = displace;
const practices_1 = require("./practices");
const replay_1 = require("./replay");
/**
 * The green-clause caveat (§6.3). A green that ablates to zero may look dead because the permission
 * it granted has already been persisted into Claude Code's own settings, where our hook is never
 * consulted. Retiring it then reads as harmless cleanup while the underlying grant stays.
 */
exports.GREEN_PERSISTENCE_NOTE = 'A green clause can ablate to zero because the permission it grants was already persisted into '
    + 'Claude Code\'s settings, so something else is doing its job. Retiring it removes the clause, not '
    + 'the grant. Confirm settings-persistence is off before treating this zero as dead weight.';
/**
 * What to do about a shadowed clause. Deliberately two options, because the gate cannot tell them
 * apart and guessing would be the same overreach as auto-proposing a red's retirement.
 */
exports.SHADOWED_NOTE = 'This clause matches real calls and changes none of them: another rung decides every one. It is '
    + 'redundant, not dead. Either delete it as redundant, or narrow it to cover what the other rung '
    + 'does not — the named rung above is what to read first.';
/**
 * What an ablation listing for a red or an orange says. It is a *listing*, never a proposal — see
 * {@link classify} and §5.5.
 */
exports.RED_NOT_PROPOSED = 'Reds and oranges are listed, never proposed for retirement: a zero here may be deterrence rather '
    + 'than dead weight, and a confident zero on a safety clause launders "I have no evidence" as "I '
    + 'have evidence of nothing". A human initiates.';
/** The line every packet that *retires* a red must carry (§5.4) — displacement, not ablation. */
exports.RED_RETIREMENT_CAVEAT = 'This retires a red clause. Its zero may be deterrence, not dead weight — see the evidence class '
    + 'below.';
// --------------------------------------------------------------------------- windows
/** Reds and oranges read the lifetime record: "did this ever matter" is not answerable in a slice. */
function isSafetyLevel(level) {
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
function ablationWindow(records, level, opts = {}) {
    const decisions = opts.decisions ?? 2000;
    const days = opts.days ?? 90;
    if (isSafetyLevel(level)) {
        return {
            records,
            window: { decisions: records.length, days: spanDays(records), lifetime: true },
        };
    }
    const byCount = records.slice(-decisions);
    const cutoff = (opts.now ?? new Date()).getTime() - days * 86400000;
    const byDays = records.filter(r => Date.parse(r.ts) >= cutoff);
    const chosen = byCount.length >= byDays.length ? byCount : byDays;
    return {
        records: chosen,
        window: { decisions: chosen.length, days: spanDays(chosen), lifetime: false },
    };
}
function spanDays(records) {
    if (records.length < 2) {
        return 0;
    }
    const times = records.map(r => Date.parse(r.ts)).filter(t => Number.isFinite(t));
    if (times.length < 2) {
        return 0;
    }
    return Math.round((Math.max(...times) - Math.min(...times)) / 86400000);
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
function relaxations(raw) {
    const out = new Set();
    const body = raw.startsWith('/') && raw.lastIndexOf('/') > 0
        ? raw.slice(1, raw.lastIndexOf('/'))
        : raw;
    const unanchored = body.replace(/^\^/, '').replace(/\$$/, '');
    if (unanchored && unanchored !== body) {
        out.add(`/${unanchored}/`);
    }
    const trimmedPath = unanchored.replace(/[/\\][^/\\]+$/, '');
    if (trimmedPath && trimmedPath !== unanchored) {
        out.add(trimmedPath);
    }
    const literal = longestLiteral(unanchored);
    if (literal.length >= 6) {
        out.add(literal);
    }
    return [...out];
}
/** The longest run of characters carrying no regex metacharacter — the clause's literal core. */
function longestLiteral(pattern) {
    let best = '';
    for (const run of pattern.split(/[^A-Za-z0-9 _.-]+/)) {
        const flat = run.trim();
        if (flat.length > best.length) {
            best = flat;
        }
    }
    return best;
}
/**
 * How often the hazard's *shape* occurs in the window without the clause firing.
 *
 * Records the clause actually cited are excluded: a fire is evidence the clause works, not a
 * near-miss, and counting it in both places would make every live clause look like dead weight.
 */
function nearMisses(clause, records) {
    const relaxed = clause.patterns
        .flatMap(relaxations)
        .map(practices_1.compileMatcher)
        .filter((p) => p !== null);
    if (relaxed.length === 0) {
        return 0;
    }
    let hits = 0;
    for (const record of records) {
        if ((0, replay_1.citedClauseId)(record.clause) === clause.clauseId) {
            continue;
        }
        const call = (0, replay_1.replayableCall)(record);
        if (call === null) {
            continue;
        }
        const hay = (0, replay_1.haystackOf)(call);
        if (relaxed.some(p => p.re.test(hay))) {
            hits += 1;
        }
    }
    return hits;
}
// --------------------------------------------------------------------------- the baseline
/**
 * What the corpus as it stands decides, per record. Ablation's control group, computed not recorded.
 *
 * Keeps the whole {@link DecidedReplay} rather than just the verdict, because naming the rung that
 * shadows a clause needs to know *what answered*, not only what it answered.
 */
function baselineDecisions(records, clauses, inj = replay_1.RECORDED) {
    const out = new Map();
    for (const record of records) {
        const decided = (0, replay_1.replayOne)(record, clauses, inj);
        if (decided !== null) {
            out.set((0, replay_1.recordId)(record), decided);
        }
    }
    return out;
}
/** Just the verdicts, for {@link replayWindow}'s baseline. */
function baselineVerdicts(records, clauses, inj = replay_1.RECORDED) {
    return new Map([...baselineDecisions(records, clauses, inj)].map(([k, v]) => [k, v.verdict]));
}
/**
 * When a clause matches real calls and removing it changes nothing, *something else decides them* —
 * find out what.
 *
 * This is the finding the first real ablation run produced, twice, on a corpus a human wrote:
 *
 *  - a force-push red matched five real `git push --force` calls and never fired, because the
 *    correction lane at **rung 2** rewrites `--force` into `--force-with-lease` and allows, and the
 *    clause's own negative lookahead says that rewritten form is acceptable. The clause is pre-empted
 *    from above, and correctly so;
 *  - a `drop table` red fired four times and removing it still changed nothing, because the built-in
 *    destructive table at **rung 5** denies the same calls. Pre-empted from below.
 *
 * Neither is dead weight, and neither is a bug. Both are redundancy with a rung, and the reviewer's
 * next move — delete as redundant, or narrow the clause to what the other rung does not cover — is
 * decidable only once the report names which rung and which rule.
 *
 * The whole verdict must be unchanged for this to be the reading, which is why the caller only asks
 * when `changed === 0`; the ranking is by frequency so the answer is the rung that does most of it.
 */
function shadowOf(target, records, without, inj = replay_1.RECORDED) {
    const tally = new Map();
    for (const record of records) {
        const call = (0, replay_1.replayableCall)(record);
        if (call === null || !(0, practices_1.clauseMatches)(target, (0, replay_1.haystackOf)(call))) {
            continue;
        }
        const decided = (0, replay_1.replayOne)(record, without, inj);
        if (decided === null) {
            continue;
        }
        // Rung 7 is not a shadower. A fail-closed deny is the *absence* of a decision — "nothing said this
        // call was safe" — so a red whose deny is merely reproduced by it is not redundant with anything:
        // it is the only thing that would still deny in observe mode, or once a green covers the call. Same
        // reasoning as AR3's fallback exclusion; treating it as redundancy would argue for deleting exactly
        // the clauses that carry the policy.
        if (decided.from === 'fallback') {
            continue;
        }
        const label = (0, replay_1.deciderLabel)(decided);
        tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    const ranked = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // `matches` counts only the calls a real rung would take over, so it is the shadowing count rather
    // than the pattern's breadth — breadth is `ReplayDiff.match_pct`'s job.
    return { matches: [...tally.values()].reduce((a, b) => a + b, 0), by: ranked[0]?.[0] ?? null };
}
// --------------------------------------------------------------------------- one clause
/** How many records cite this clause. `fires` in the §5.5 sense. */
function firesFor(clauseId, records) {
    return records.filter(r => (0, replay_1.citedClauseId)(r.clause) === clauseId).length;
}
/**
 * Ablate one clause: what changes if it is not there?
 *
 * `corpus` is the whole live clause set including the one being ablated. The clause is removed from a
 * clone; nothing here mutates the corpus, and nothing here writes retirement state — the gate
 * produces evidence and governance's `accept` / `displaces` write the states.
 */
function ablate(clauseId, corpus, records, opts = {}) {
    const target = corpus.find(c => c.clauseId === clauseId);
    if (!target) {
        throw new Error(`ablate: no clause ${clauseId} in the corpus`);
    }
    const inj = opts.injections ?? replay_1.RECORDED;
    const { records: windowRecords, window } = ablationWindow(records, target.level, opts);
    const without = corpus.filter(c => c.clauseId !== clauseId);
    const baseline = baselineDecisions(windowRecords, corpus, inj);
    const diff = (0, replay_1.replayWindow)(windowRecords, without, null, {
        window: windowRecords.length,
        injections: inj,
        baseline: new Map([...baseline].map(([k, v]) => [k, v.verdict])),
    });
    // Only meaningful when nothing moved: with a non-zero `changed` the clause is demonstrably deciding
    // something, and "what would decide these instead" is not the question a reviewer has.
    const shadow = diff.changed === 0
        ? shadowOf(target, windowRecords, without, inj)
        : { matches: 0, by: null };
    // A loaded `Clause` carries each matcher's source text alongside its `RegExp`, so the relaxations
    // get exactly what the author typed — `RegExp.source` would hand back an escaped, whitespace-
    // loosened rewrite of a substring pattern and relax the wrong string.
    const rawPatterns = target.patterns.map(p => (p.isRegex ? `/${p.raw}/` : p.raw));
    const misses = nearMisses({ clauseId, patterns: rawPatterns }, windowRecords);
    const lifetimeFires = opts.lifetimeFires ?? firesFor(clauseId, records);
    const windowFires = firesFor(clauseId, windowRecords);
    const evidenceClass = classify(target.level, diff.changed, lifetimeFires, misses, shadow.matches);
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
        matches: shadow.matches,
        shadowed_by: evidenceClass === 'shadowed' ? shadow.by ?? undefined : undefined,
        retirement_candidate: retirement,
        evidence: `removing ${target.citation} changes ${diff.changed} of ${diff.n} decisions over `
            + `${window.lifetime ? 'the lifetime record' : `${window.decisions} decisions`}`
            + ` (${window.days} days); ${lifetimeFires} lifetime fire(s), ${misses} near-miss(es)`
            + (evidenceClass === 'shadowed' ? `, ${shadow.matches} pre-empted call(s)` : ''),
        note: noteFor(target.level, retirement, evidenceClass),
    };
}
/**
 * How to read the number, in the order the readings are specific.
 *
 *  1. **`in-service`** — it changed something. Nothing else needs deciding.
 *  2. **`shadowed`** — it matches real calls and changed none of them, so another rung decides them
 *     all. Checked before `deterrent` because it is the *more specific* explanation of the same zero,
 *     and it is the only one that names something the reviewer can act on. A red that fired four times
 *     and still ablates to zero is not "a deterrent that stopped firing"; it is redundant with the
 *     built-in table, and only one of those two sentences tells anyone what to do.
 *  3. **`deterrent`** — for a red or an orange, a lifetime fire with nothing left to shadow it means
 *     the traffic moved on after it fired. Never proposed for retirement: zero recent fires is exactly
 *     what success looks like.
 *  4. **`dead-weight?` / `insufficient-exposure`** — the near-miss index separates "the hazard's shape
 *     occurs and this still never triggers" from "the window never contained the situation".
 *  5. **`retire`** — a green or yellow that matches nothing and changes nothing. Genuinely dead.
 */
function classify(level, changed, lifetimeFires, misses, matches = 0) {
    if (changed > 0) {
        return 'in-service';
    }
    if (matches > 0) {
        return 'shadowed';
    }
    if (isSafetyLevel(level)) {
        if (lifetimeFires >= 1) {
            return 'deterrent';
        }
        if (misses >= 1) {
            return 'dead-weight?';
        }
        return 'insufficient-exposure';
    }
    return 'retire';
}
/**
 * The note a reviewer reads. Composed rather than picked, because a shadowed red needs both halves:
 * what to do about the redundancy, *and* that the gate is not proposing anything.
 */
function noteFor(level, retirement, evidenceClass) {
    const parts = [];
    if (evidenceClass === 'shadowed') {
        parts.push(exports.SHADOWED_NOTE);
    }
    if (isSafetyLevel(level)) {
        parts.push(exports.RED_NOT_PROPOSED);
    }
    if (retirement && level === 'green') {
        parts.push(exports.GREEN_PERSISTENCE_NOTE);
    }
    return parts.length === 0 ? undefined : parts.join(' ');
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
function ablateAll(corpus, records, opts = {}) {
    const ordered = [...corpus].sort((a, b) => a.clauseId.localeCompare(b.clauseId));
    let live = [...corpus];
    const out = [];
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
exports.CEILING_PER_TIER = 25;
function ceilingTierOf(origin, level, hasFix = false) {
    const side = (0, replay_1.directionOf)(level, hasFix);
    return `${origin}-${side === 'widening' ? 'green' : 'red'}`;
}
/** A compiled clause's ceiling tier, read off the artifact. */
function tierOfCompiled(clause) {
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
function renderedCount(clauses, tier) {
    return clauses.filter(c => c.status === 'accepted' && tierOfCompiled(c) === tier && c.patterns.length === 0).length;
}
/** Citations in the last 90 days, tie-broken by ablation `changed`. The clause's measured worth. */
function valueOf(incumbent) {
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
function evictionTarget(tier, incumbents) {
    const inTier = incumbents.filter(i => i.tier === tier);
    const deadest = (a, b) => {
        const at = a.lastCited?.getTime() ?? -Infinity;
        const bt = b.lastCited?.getTime() ?? -Infinity;
        if (at !== bt) {
            return at - bt;
        }
        return a.id.localeCompare(b.id);
    };
    // Classes 1 and 2 are unordered sets of equally dead clauses, so the deadest goes first. Class 3 is
    // already ordered by value (with `deadest` as its own tie-break) and must not be re-sorted — doing
    // that throws the value ranking away and evicts by age alone, which is the opposite of the rule.
    const classes = [
        [...inTier.filter(i => i.citations === 0 && i.ablationChanged === 0)].sort(deadest),
        [...inTier.filter(i => i.citations === 0)].sort(deadest),
        [...inTier].sort((a, b) => valueOf(a) - valueOf(b) || deadest(a, b)),
    ];
    for (const cls of classes) {
        if (cls.length > 0) {
            return cls[0];
        }
    }
    return undefined;
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
function displace(input) {
    const ceiling = input.ceiling ?? exports.CEILING_PER_TIER;
    const tier = input.candidateTier;
    const base = {
        tier, ceiling, rendered_count: input.renderedCount, reduces_coverage: false,
        caveats: [],
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
        ? [exports.RED_RETIREMENT_CAVEAT, `Outgoing ${target.id} evidence class: ${target.evidenceClass}.`]
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
