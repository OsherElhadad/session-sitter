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

import {
  KnowledgeEntry,
  LoadKnowledgeOptions,
  TIER_PRECEDENCE,
  loadKnowledge,
  parseBottomLine,
} from '../supervisor/knowledge';

/** How a clause was written to be treated: red denies, yellow corrects, green permits. */
export type ClauseLevel = 'red' | 'orange' | 'yellow' | 'green' | null;

export interface Clause {
  /** Stable, citable identity — the `id` field, a leading heading number, or a title slug. */
  clauseId: string;
  /** The string a decision message shows the human: `practices §<clauseId>`. */
  citation: string;
  /** belief | desire | intention */
  kind: string;
  level: ClauseLevel;
  title: string;
  /** team | project | user */
  tier: string;
  /** The clause body, minus the `Match:` line. This is what the classifier reads. */
  text: string;
  tags: string[];
  /** Compiled matchers from the `Match:` line. Empty means "not deterministically matchable". */
  patterns: RegExp[];
  sourceFile: string | null;
}

/** Pulled off the front of a body line: `Match: a, b, c`. */
const MATCH_LINE = /^match\s*:\s*(.+)$/i;
/** A `/pattern/flags` literal, as opposed to a plain substring. */
const REGEX_LITERAL = /^\/(.+)\/([gimsuy]*)$/;
/** A heading that numbers itself — `4. Never force-push` or `§4 Never force-push`. */
const NUMBERED_TITLE = /^(?:§\s*)?(\d+)[.)\s]/;

function slug(title: string): string {
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
function substringMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(escaped, 'i');
}

/** Split a `Match:` value on commas, honouring backtick quoting so a pattern may contain a comma. */
function splitPatterns(value: string): string[] {
  const out: string[] = [];
  const backticked = /`([^`]+)`/g;
  let rest = value;
  let m: RegExpExecArray | null;
  while ((m = backticked.exec(value)) !== null) {
    out.push(m[1].trim());
    rest = rest.replace(m[0], ',');
  }
  for (const piece of rest.split(',')) {
    const trimmed = piece.trim();
    if (trimmed) { out.push(trimmed); }
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
export function compileMatcher(pattern: string): RegExp | null {
  const asRegex = REGEX_LITERAL.exec(pattern);
  try {
    return asRegex ? new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`)
      : substringMatcher(pattern);
  } catch {
    return null;
  }
}

/**
 * One `Match:` pattern, as written and as compiled.
 *
 * The `raw` text is kept because the compiled `RegExp` is not the source: a substring matcher has
 * been escaped and had its whitespace loosened, so `RegExp.source` cannot be turned back into what
 * the author typed. The compiled artifact stores what the author typed and recompiles it, which is
 * what makes the artifact a faithful copy of the corpus rather than a lossy derivative.
 */
export interface PatternSpec {
  /** Exactly the text between the commas on the `Match:` line. */
  raw: string;
  /** True when `raw` was a `/…/flags` literal rather than a substring. */
  isRegex: boolean;
  /** Flags of the compiled matcher — `i` is always among them. */
  flags: string;
  /** Null when the pattern would not compile. A red clause with a null here enforces nothing. */
  compiled: RegExp | null;
}

/** Every `Match:` pattern in a body, in file order, compiled or not. */
export function patternSpecs(text: string): PatternSpec[] {
  const specs: PatternSpec[] = [];
  for (const line of text.split('\n')) {
    const m = MATCH_LINE.exec(line.trim());
    if (!m) { continue; }
    for (const raw of splitPatterns(m[1])) {
      const compiled = compileMatcher(raw);
      specs.push({
        raw,
        isRegex: REGEX_LITERAL.test(raw),
        flags: compiled?.flags ?? 'i',
        compiled,
      });
    }
  }
  return specs;
}

/** Lift the `Match:` lines out of an entry body, returning the remaining prose and the matchers. */
function extractPatterns(text: string): { prose: string; patterns: RegExp[] } {
  const kept = text.split('\n').filter(line => !MATCH_LINE.test(line.trim()));
  const patterns = patternSpecs(text)
    .map(s => s.compiled)
    .filter((p): p is RegExp => p !== null);
  return { prose: kept.join('\n').trim(), patterns };
}

function normalizeLevel(level: string | null): ClauseLevel {
  const v = (level ?? '').trim().toLowerCase();
  return v === 'red' || v === 'orange' || v === 'yellow' || v === 'green' ? v : null;
}

/** Derive the citable id: the explicit `id` field, else a self-numbering heading, else a slug. */
export function clauseIdFor(entry: KnowledgeEntry): string {
  if (entry.id && entry.id.trim()) { return entry.id.trim(); }
  const numbered = NUMBERED_TITLE.exec(entry.title.trim());
  return numbered ? numbered[1] : slug(entry.title);
}

/** Turn one loaded BDI entry into a citable clause. */
export function clauseFrom(entry: KnowledgeEntry): Clause {
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
export function rankClauses(clauses: Clause[]): Clause[] {
  return [...clauses].sort(
    (a, b) => (TIER_PRECEDENCE[b.tier] ?? 0) - (TIER_PRECEDENCE[a.tier] ?? 0));
}

/** Parse a single practices markdown file. `tier` labels where it came from. */
export function parsePractices(
  text: string, tier = 'project', sourceFile: string | null = null,
): Clause[] {
  return parseBottomLine(text, tier, sourceFile).map(clauseFrom);
}

/**
 * Load every tier through the existing knowledge loader and return citable clauses, narrowest
 * tier first. Errors propagate: a policy layer that silently loads no policy is a policy layer
 * that silently permits everything.
 */
export async function loadPractices(opts: LoadKnowledgeOptions): Promise<Clause[]> {
  const bundle = await loadKnowledge(opts);
  return rankClauses(bundle.entries.map(clauseFrom));
}

/** True when any of the clause's compiled patterns appears in `haystack`. */
export function clauseMatches(clause: Clause, haystack: string): boolean {
  return clause.patterns.some(p => { p.lastIndex = 0; return p.test(haystack); });
}

/**
 * The first clause at `level` whose patterns match, honouring tier precedence. Used for the red
 * lane: a written deny rule, named in the decision message.
 */
export function findMatchingClause(
  clauses: Clause[], haystack: string, level: ClauseLevel = 'red',
): Clause | null {
  for (const clause of rankClauses(clauses)) {
    if (clause.level === level && clauseMatches(clause, haystack)) { return clause; }
  }
  return null;
}
