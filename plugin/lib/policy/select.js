// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/select.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Selector `v1` — which compiled clauses reach the model for *this* call, and the citation lookup.
 *
 * Two jobs, both about the same property: a decision must be reproducible from
 * `(revision, selector, input)` alone. Nothing here reads a clock beyond a date, nothing here reads
 * a counter, nothing here iterates a map for order.
 *
 * ## The one rule that comes before the budget
 *
 * **Matching is never budgeted.** Deterministic matching runs over every compiled clause, with no
 * cap and no retrieval, and it happens at rungs 2–4 of the hook ladder. A red clause dropped by a
 * budget is a silent safety failure. What is bounded is only the *knowledge block* of the
 * classifier, which is rung 6 — reached only when deterministic matching decided nothing.
 *
 * ## Why a clause whose pattern missed is excluded
 *
 * Because rung 6 is *after* rungs 2–4: by the time a prompt exists, every matchable clause has
 * already been tested against this call and lost. Rendering one is prose claiming to be about
 * something its own pattern says this call is not — it cannot fire deterministically (already
 * tried), and it spends the model's finite compliance budget saying nothing. So the rendered set is
 * exactly (a) clauses with no patterns, by the documented ranking, and (b) clauses that actually
 * matched.
 *
 * The exclusion is *evaluated-and-missed*, not *carries a `Match:` field*, and the difference is
 * load-bearing: a red with no patterns still renders at full budget, which is the right price
 * signal against writing prose reds. The structural payoff is that a deterministic clause costs
 * zero rendered budget, so it can never create eviction pressure against a red — and evicting a red
 * is a widening.
 *
 * ## Overflow drops whole clauses
 *
 * Never a truncated body. A body cut mid-way can show the *why* and lose the remediation, or end
 * mid-sentence and read as a different rule than the one on disk — and then the rendered clause is
 * not the clause in the corpus, which is the one property that makes a decision explainable. So the
 * first clause that would cross the budget, and every clause after it, is dropped entirely, and the
 * subset line says so.
 *
 * Spec: `10-schema.md` §6, `12-validation.md` §5.3, `14-runtime-and-dashboard.md` §A3/§A4.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SELECTION_BYTE_BUDGET = void 0;
exports.clauseMatches = clauseMatches;
exports.matchingClauses = matchingClauses;
exports.compareFill = compareFill;
exports.selectClauses = selectClauses;
exports.selectForPolicy = selectForPolicy;
exports.renderSelection = renderSelection;
exports.clauseIndex = clauseIndex;
exports.cite = cite;
const learnedClauses_1 = require("../supervisor/learnedClauses");
const compile_1 = require("./compile");
const practices_1 = require("./practices");
/**
 * The per-call block, which lives *outside* the prompt-cache breakpoint on a trailing user turn.
 * There is no trailing-system channel, and nothing after the last breakpoint is cached — which is
 * exactly why per-call content belongs there and costs nothing in cache terms. Putting it in the
 * `system` block instead would invalidate the prefix on every single decision.
 */
exports.SELECTION_BYTE_BUDGET = 4 * 1024;
/** True when any of a compiled clause's patterns appears in the haystack. */
function clauseMatches(clause, haystack) {
    for (const pattern of clause.patterns) {
        const re = (0, practices_1.compileMatcher)(pattern.raw);
        // A pattern that no longer compiles cannot match. It also cannot reach here: `policy compile`
        // refuses an artifact carrying one, so this is a belt on a hand-edited file.
        if (re !== null && re.test(haystack)) {
            return true;
        }
    }
    return false;
}
/**
 * Every clause the deterministic layer should test — `accepted` *and* `audit`, uncapped.
 *
 * Audit clauses are matched and their would-be verdicts recorded; they contribute nothing to the
 * outcome and are never rendered, which is what makes a trial cost zero prompt tokens.
 */
function matchingClauses(clauses, haystack) {
    return clauses
        .filter(c => (c.status === 'accepted' || c.status === 'audit') && clauseMatches(c, haystack))
        .sort(learnedClauses_1.compareLadder);
}
const TIER_RANK = { user: 2, project: 1, team: 0 };
const ORIGIN_RANK = { human: 0, learned: 1 };
const WEIGHT_RANK = { high: 0, medium: 1, low: 2 };
/**
 * The fill order: **origin**, then narrowness, then the frozen weight, then the id. A total order,
 * so no tie is broken by insertion or map-iteration order — which is what makes the rendered set
 * replayable.
 *
 * `origin` leads, and it leads for a reading reason rather than a semantic one. This is rendering
 * order: it changes nothing about precedence, which the four-rung ladder decides. But a reviewer who
 * sees a machine clause listed above a human's will reasonably conclude precedence is broken. With
 * origin first, the rendered order visibly agrees with the ladder — a machine proposal never appears
 * to outrank a human's explicit practice.
 *
 * `weight` is frozen at accept time rather than derived from the live support count, because
 * anything mutable that reaches the artifact moves its revision and rewrites every running
 * session's cached prefix. A hand-written clause has no support signal and ties at 0, falling
 * through to the id — and with origin ahead of weight, that tie can no longer put it last.
 */
function compareFill(a, b) {
    return ((ORIGIN_RANK[a.origin] ?? 9) - (ORIGIN_RANK[b.origin] ?? 9))
        || ((TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0))
        || ((WEIGHT_RANK[a.weight] ?? 9) - (WEIGHT_RANK[b.weight] ?? 9))
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Select the per-call knowledge block. Deterministic in every argument, including the date. */
function selectClauses(clauses, opts) {
    const budget = opts.budgetBytes ?? exports.SELECTION_BYTE_BUDGET;
    const coreIds = opts.coreIds ?? new Set();
    const dropped = {
        'not-active': 0, expired: 0, 'expired-safety': 0, 'in-core': 0,
        'evaluated-missed': 0, budget: 0,
    };
    const expiredSafety = [];
    const matched = [];
    const fill = [];
    for (const clause of clauses) {
        if (clause.status !== 'accepted') {
            dropped['not-active']++;
            continue;
        }
        if (clause.expires !== null && clause.expires < opts.today) {
            // An expiry date may prune the prompt; it may never disarm a block. A stale red that still
            // fires is loud and self-reporting; a red that silently stopped firing is invisible until the
            // incident it was written to prevent. Disarming one is a human act with a diff.
            if (clause.level === 'red' || clause.level === 'orange') {
                expiredSafety.push(clause.id);
                dropped['expired-safety']++;
            }
            else {
                dropped.expired++;
            }
            continue;
        }
        if (coreIds.has(clause.id)) {
            dropped['in-core']++;
            continue;
        }
        if (clause.patterns.length > 0) {
            if (clauseMatches(clause, opts.haystack)) {
                matched.push(clause);
            }
            else {
                dropped['evaluated-missed']++;
            }
            continue;
        }
        fill.push(clause);
    }
    matched.sort(learnedClauses_1.compareLadder);
    fill.sort(compareFill);
    const selected = [];
    let bytes = 0;
    let overflowed = false;
    for (const clause of [...matched, ...fill]) {
        const cost = Buffer.byteLength((0, compile_1.renderClause)(clause), 'utf8') + 1;
        if (overflowed || bytes + cost > budget) {
            // Once one clause has been dropped, everything after it is dropped too: emitting a later,
            // shorter clause would make the rendered set depend on clause lengths rather than on the
            // documented order, and the set would stop being replayable.
            overflowed = true;
            dropped.budget++;
            continue;
        }
        bytes += cost;
        selected.push(clause);
    }
    return {
        selected,
        matched: matched.map(c => c.id),
        dropped,
        expiredSafety,
        subsetLine: '',
    };
}
/**
 * Select against a whole artifact, and build the subset line from it.
 *
 * The line is always emitted, even when nothing was dropped: a prompt that silently shows a subset
 * is a prompt whose output nobody can reproduce, and "always" is one fewer branch to be wrong in.
 */
function selectForPolicy(policy, opts) {
    const coreIds = opts.coreIds
        ?? new Set(policy.clauses
            .filter(c => c.status === 'accepted' && (c.level === 'red' || c.level === 'orange')
            && c.patterns.length === 0)
            .map(c => c.id));
    const selection = selectClauses(policy.clauses, { ...opts, coreIds });
    const shown = coreIds.size + selection.selected.length;
    selection.subsetLine =
        `(${shown} of ${policy.clauses.length} clauses shown — policy revision `
            + `${(0, compile_1.revisionHex)(policy.revision).slice(0, 8)}, core ${coreIds.size}, `
            + `selected ${selection.selected.length})`;
    return selection;
}
/** The per-call block, rendered. Verbatim clause bodies, then the subset line. */
function renderSelection(selection) {
    return [...selection.selected.map(compile_1.renderClause), selection.subsetLine].join('\n');
}
/** Built once per load. A citation is a lookup, so it cannot be wrong by construction. */
function clauseIndex(policy) {
    return new Map(policy.clauses.map(c => [c.id, c]));
}
/**
 * Resolve a clause id to its citation, or nothing.
 *
 * The model writes an *id*, never citation text. An id that is not in the artifact is a
 * hallucination, and it is dropped: the caller keeps the model's light — its judgement is not
 * invalidated by its bad bookkeeping — but nothing unverifiable is ever printed to a human.
 */
function cite(policy, index, id) {
    const clause = index.get(id);
    if (!clause) {
        return null;
    }
    return {
        id: clause.id,
        citation: `${clause.citation}@${(0, compile_1.revisionHex)(policy.revision).slice(0, 7)}`,
        level: clause.level,
        message: clause.body,
        fix: clause.fix,
        sourceFile: clause.source_file,
    };
}
