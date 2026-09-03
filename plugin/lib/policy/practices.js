// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/practices.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Practices as policy — the same bottom-line files the supervisor already reads, plus the one
 * thing a governance decision needs and the BDI loader does not provide: a **citable clause id**.
 *
 * Auto mode reads `CLAUDE.md` and reports the fixed string `Blocked by classifier`. The whole
 * wedge of this layer is being able to say *which* written rule was applied:
 *
 *     denied — practices §team-git-002: never force-push to a shared branch
 *
 * So this module deliberately adds nothing to the *loading* story. `src/supervisor/knowledge.ts`
 * already resolves the (user, project, team) triple, reads the three `bottom-line.md` tiers in
 * precedence order, and parses the BDI entries. A second knowledge path would be a second source
 * of truth for what a team's rules are. This module consumes that loader and layers on:
 *
 *  - a stable `clauseId` per entry, and the `citation` string built from it;
 *  - `patterns`, so a clause can be matched **deterministically** against a tool call rather than
 *    only handed to a classifier as prose;
 *  - tier ordering, narrowest first, so a user clause outranks a project clause outranks a team one.
 *
 * ## Making a clause matchable
 *
 * A clause is matched only if its body carries a `Match:` line. Everything else is still loaded and
 * still reaches the classifier as context — it simply cannot deny a call on its own. That is the
 * conservative default on purpose: prose is ambiguous, and a rule that denies work on a guess is
 * worse than a rule that defers to the model.
 *
 *     ### Intention: Never force-push to a shared branch
 *
 *     | Field | Value |
 *     |---|---|
 *     | id    | team-git-002 |
 *     | level | red |
 *
 *     Match: `git push --force`, `/git\s+push\b.*--delete/`
 *
 *     Rewriting history on a branch other people build on destroys their work.
 *
 * A pattern is a plain case-insensitive substring, or a `/regex/flags` literal when a substring is
 * not enough. Substrings are the documented default because a mis-written regex silently matches
 * nothing, and a red clause that silently matches nothing is the worst failure mode this file has.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeForMatcher = escapeForMatcher;
exports.compileMatcher = compileMatcher;
exports.patternSpecs = patternSpecs;
exports.clauseIdFor = clauseIdFor;
exports.clauseFrom = clauseFrom;
exports.rankClauses = rankClauses;
exports.parsePractices = parsePractices;
exports.loadPractices = loadPractices;
exports.matchingPattern = matchingPattern;
exports.clauseMatches = clauseMatches;
exports.findMatchingClause = findMatchingClause;
const knowledge_1 = require("../supervisor/knowledge");
/** Pulled off the front of a body line: `Match: a, b, c`. */
const MATCH_LINE = /^match\s*:\s*(.+)$/i;
/** A `/pattern/flags` literal, as opposed to a plain substring. */
const REGEX_LITERAL = /^\/(.+)\/([gimsuy]*)$/;
/** A heading that numbers itself — `4. Never force-push` or `§4 Never force-push`. */
const NUMBERED_TITLE = /^(?:§\s*)?(\d+)[.)\s]/;
function slug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'unnamed';
}
/**
 * Escape a substring so it can be used as a regex. Whitespace is deliberately loosened to `\s+`
 * so `git push --force` also matches `git  push   --force`, which is the same command.
 */
function escapeForMatcher(pattern) {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}
/**
 * Exported above because the miner emits an *anchored* regex around a literal it derived from real
 * calls (`src/policy/propose.ts`, gate E5) and has to escape that literal exactly the way a
 * hand-written substring matcher is escaped. Two escapers would mean a mined clause matches calls a
 * written one does not, which is the one difference nobody would think to look for.
 */
function substringMatcher(pattern) {
    return new RegExp(escapeForMatcher(pattern), 'i');
}
/** Split a `Match:` value on commas, honouring backtick quoting so a pattern may contain a comma. */
function splitPatterns(value) {
    const out = [];
    const backticked = /`([^`]+)`/g;
    let rest = value;
    let m;
    while ((m = backticked.exec(value)) !== null) {
        out.push(m[1].trim());
        rest = rest.replace(m[0], ',');
    }
    for (const piece of rest.split(',')) {
        const trimmed = piece.trim();
        if (trimmed) {
            out.push(trimmed);
        }
    }
    return out;
}
/**
 * Compile one pattern. An unparseable regex is dropped rather than thrown: a malformed clause must
 * not take the whole policy file down with it, and the clause is still handed to the classifier.
 *
 * Dropping it is right at *load* time and wrong at *compile* time — a red clause whose only matcher
 * was dropped silently protects nothing. So the drop is visible in {@link PatternSpec.compiled},
 * and `policy compile` refuses to emit an artifact when any spec carries a null (see
 * `src/policy/compile.ts`). Same parse, two policies.
 */
function compileMatcher(pattern) {
    const asRegex = REGEX_LITERAL.exec(pattern);
    try {
        return asRegex
            ? {
                raw: asRegex[1],
                isRegex: true,
                re: new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`),
            }
            : { raw: pattern, isRegex: false, re: substringMatcher(pattern) };
    }
    catch {
        return null;
    }
}
/**
 * Every `Match:` pattern in a body, in file order, compiled or not.
 *
 * The null-preserving counterpart to {@link extractPatterns}: that one drops what will not compile,
 * because a load must not fail on one bad line, and this one keeps the hole visible so
 * `policy compile` can refuse to emit an artifact around it.
 */
function patternSpecs(text) {
    const specs = [];
    for (const line of text.split('\n')) {
        const m = MATCH_LINE.exec(line.trim());
        if (!m) {
            continue;
        }
        for (const raw of splitPatterns(m[1])) {
            const compiled = compileMatcher(raw);
            specs.push({
                raw,
                isRegex: REGEX_LITERAL.test(raw),
                flags: compiled?.re.flags ?? 'i',
                compiled: compiled?.re ?? null,
            });
        }
    }
    return specs;
}
/** Lift the `Match:` lines out of an entry body, returning the remaining prose and the matchers. */
function extractPatterns(text) {
    const kept = [];
    const patterns = [];
    for (const line of text.split('\n')) {
        const m = MATCH_LINE.exec(line.trim());
        if (!m) {
            kept.push(line);
            continue;
        }
        for (const raw of splitPatterns(m[1])) {
            const compiled = compileMatcher(raw);
            if (compiled) {
                patterns.push(compiled);
            }
        }
    }
    return { prose: kept.join('\n').trim(), patterns };
}
function normalizeLevel(level) {
    const v = (level ?? '').trim().toLowerCase();
    return v === 'red' || v === 'orange' || v === 'yellow' || v === 'green' ? v : null;
}
/** Derive the citable id: the explicit `id` field, else a self-numbering heading, else a slug. */
function clauseIdFor(entry) {
    if (entry.id && entry.id.trim()) {
        return entry.id.trim();
    }
    const numbered = NUMBERED_TITLE.exec(entry.title.trim());
    return numbered ? numbered[1] : slug(entry.title);
}
/** Turn one loaded BDI entry into a citable clause. */
function clauseFrom(entry) {
    const { prose, patterns } = extractPatterns(entry.text);
    const clauseId = clauseIdFor(entry);
    return {
        clauseId,
        citation: `practices §${clauseId}`,
        kind: entry.kind,
        level: normalizeLevel(entry.level),
        title: entry.title,
        tier: entry.tier,
        text: prose,
        tags: entry.tags,
        patterns,
        sourceFile: entry.sourceFile,
    };
}
/** Narrowest tier first — a user clause outranks a project clause outranks a team clause. */
function rankClauses(clauses) {
    return [...clauses].sort((a, b) => (knowledge_1.TIER_PRECEDENCE[b.tier] ?? 0) - (knowledge_1.TIER_PRECEDENCE[a.tier] ?? 0));
}
/** Parse a single practices markdown file. `tier` labels where it came from. */
function parsePractices(text, tier = 'project', sourceFile = null) {
    return (0, knowledge_1.parseBottomLine)(text, tier, sourceFile).map(clauseFrom);
}
/**
 * Load every tier through the existing knowledge loader and return citable clauses, narrowest
 * tier first. Errors propagate: a policy layer that silently loads no policy is a policy layer
 * that silently permits everything.
 */
async function loadPractices(opts) {
    const bundle = await (0, knowledge_1.loadKnowledge)(opts);
    return rankClauses(bundle.entries.map(clauseFrom));
}
/** The first of the clause's matchers that appears in `haystack`, or null when none does. */
function matchingPattern(clause, haystack) {
    for (const p of clause.patterns) {
        p.re.lastIndex = 0;
        if (p.re.test(haystack)) {
            return p;
        }
    }
    return null;
}
/** True when any of the clause's compiled patterns appears in `haystack`. */
function clauseMatches(clause, haystack) {
    return matchingPattern(clause, haystack) !== null;
}
/**
 * The first clause at `level` whose patterns match, honouring tier precedence. Used for the red
 * lane: a written deny rule, named in the decision message.
 */
function findMatchingClause(clauses, haystack, level = 'red') {
    for (const clause of rankClauses(clauses)) {
        if (clause.level === level && clauseMatches(clause, haystack)) {
            return clause;
        }
    }
    return null;
}
