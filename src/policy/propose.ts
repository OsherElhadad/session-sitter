/**
 * Stage B — propose. Turn a cluster over the support floor into one `status: proposed` clause file.
 *
 * This is where all the judgement in the pipeline lives, and it is still judgement without a model:
 * nine gates, a literal derived by `prefixOf`, an anchored matcher, and `replay.ts`'s measured
 * blast radius. Zero tokens on the default path, and `pipeline.test.ts` asserts `model.calls === 0`.
 *
 * ## The output contract, whole
 *
 * `data/knowledge/<teams|projects|users>/<slug>/learned/<id>.md` at `status: proposed`, **and nothing
 * else.** `assertWritable` enforces it and throws, and a throw means the run writes nothing. A
 * `proposed` clause is inert by construction — `isEnforceable` is `status === 'accepted'` and nothing
 * else, and so is `rendersIntoPrompt` — so a run killed halfway through writing five files leaves
 * five inert files and no state to roll back. That is stronger than any transaction.
 *
 * ## Suppression is the filesystem
 *
 * The writer refuses to overwrite any file whose parsed `status` is not `proposed`. A `declined` file
 * is permanent suppression, an `accepted` one is add-only, a `retired` one stays retired. There is no
 * `suppressed.json`, no dedupe index and no callback from the governance step to keep in sync,
 * because the corpus already records the fact and a second source of truth for it would drift.
 *
 * That only works because ids are **dateless**: `<kind>-<slug>-<shape12>`, content-derived, with
 * `learned_at` carrying the date. A date in the filename moves the moment another matching call
 * lands, so a human declining a candidate today would see it re-proposed tomorrow under a new name —
 * a governance failure that looks exactly like normal operation.
 *
 * ## Why the emitted matcher cannot widen past its evidence
 *
 *  1. **No left slack.** The match begins at the first character of the `command` *value*: the anchor
 *     is `"command"\s*:\s*"` immediately followed by the literal. `rm -rf / # pnpm test` does not
 *     match — which is the failure a bare substring has, and why E5 forbids one.
 *  2. **No right slack.** `(?=[\s"\\])` ends the literal on a word boundary, so `git s` cannot
 *     license `git shove-everything`.
 *  3. **No compound slack, twice over.** The support set never contained the other segment (§4.1),
 *     *and* at runtime `constituentsOf` decomposes a compound and evaluates each constituent against
 *     its own `constituentHaystack`, so `git status && rm -rf /` is tested as two separate inputs and
 *     the matcher matches only the first.
 *  4. **Matched set ⊆ evidence-sharing set.** The literal is a token prefix of every supporting
 *     segment (E4), so the only direction it is wider than the evidence is "more arguments to the
 *     same subcommand" — the generalisation the product exists to provide.
 *  5. **It degrades closed downstream.** Because the matcher is a `/…/` regex,
 *     `generalisedPermission` returns null for it, so an accepted mined clause never becomes a
 *     persisted Claude Code `Bash(x:*)` rule in anyone's settings file behind their back.
 *
 * The anchor is inside the JSON rather than at `^` deliberately: the haystack is `haystackFor`
 * output and its key order is the caller's, because `constituentHaystack` does `{...toolInput,
 * command}` and preserves it — so `^Bash \{"command":"` is not guaranteed and `"command"\s*:\s*"` is.
 *
 * Spec: `11-mine-v2.md` §4.3 (the gates), §4.5 (non-widening), §7.3 (ids and suppression), §8.2
 * (retirement writes no file).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CLAUSE_STATUSES,
  assertWritable,
  isSafeId,
  learnedClausePath,
  parseFrontmatter,
} from '../supervisor/learnedClauses';
import { Tier } from '../supervisor/knowledge';
import { AblationReport, GREEN_PERSISTENCE_NOTE, RED_NOT_PROPOSED, SHADOWED_NOTE } from './ablate';
import { Cluster, Lane, SHELL_TOOLS, Support, evidenceIds } from './mine';
import { prefixOf } from './generalise';
import { escapeForMatcher } from './practices';
import { ReplayCandidate } from './replay';

// --------------------------------------------------------------------------- the emission rule

/**
 * The version of the rules below, recorded in the run line and in the clause body — and deliberately
 * **not** in the id hash.
 *
 * An earlier draft put a `schema:1` tag inside the hash. It bought rule-version separation and cost
 * suppression permanence: bump the tag and every `declined` file stops blocking its candidate.
 * Permanence is worth more, so the version informs a reader without moving a filename.
 */
export const EMISSION_RULE = 2;

/** Reviewer-fatigue caps, not runtime caps. A run proposing 40 clauses gets ignored. */
export const MAX_ADDITIONS = 5;
export const MAX_RETIREMENTS = 10;

/** Why a cluster produced nothing. One of these, verbatim, in the run line's `refusals[]`. */
export type RefusalReason =
  | 'no-call'
  | 'no-matcher-shape'
  | 'unconfident-split'
  | 'prefix-too-short'
  | 'contradicted'
  | 'mixed-light'
  | 'never-widen'
  | 'no-gap'
  | 'below-floor'
  | 'majority-unreplayable'
  | 'failed-replay';

export interface Refusal {
  cluster: string;
  why: RefusalReason;
  /** The never-widen axis, the citation that contradicted, or whatever names the refusal. */
  detail?: string;
}

// --------------------------------------------------------------------------- E8, the never-widen list

/**
 * Axes a candidate is **dropped** on, never narrowed onto.
 *
 * Each entry is a predicate over one segment, and the name is what the run line reports. Ordered so
 * the reported axis is the most specific one that applies.
 *
 * `pipe-to-interpreter` is expressed as "the segment *is* an interpreter": `splitShellCommand`
 * already splits on `|`, so a pipe into `sh` arrives here as its own `sh` segment. Testing for the
 * pipe character would test a string this stage never sees.
 */
export const NEVER_WIDEN: readonly { axis: string; hit(segment: string): boolean }[] = [
  { axis: 'redirect', hit: s => /(^|[^0-9<>&])(>>?|<)(?![(])/.test(stripQuoted(s)) },
  { axis: 'privilege', hit: s => /\b(sudo|doas|su|pkexec|chown|chgrp)\b/i.test(s) },
  { axis: 'egress', hit: s => /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet)\b/i.test(s) },
  { axis: 'rm', hit: s => /^\s*rm\b/i.test(s) },
  { axis: 'chmod', hit: s => /\b(chmod|chflags|setfacl)\b/i.test(s) },
  { axis: 'force-push', hit: s => /\bgit\b[\s\S]*\bpush\b[\s\S]*(--force|--delete|-f\b)/i.test(s) },
  { axis: 'hard-reset', hit: s => /\bgit\b[\s\S]*\b(reset\s+--hard|clean\s+-[a-z]*f)/i.test(s) },
  { axis: 'pipe-to-interpreter', hit: s => INTERPRETERS.has(argv0Of(s)) },
  { axis: 'corpus-path', hit: s => /(data\/knowledge|\/corpus(\/|\b))/.test(s) },
  { axis: 'traversal', hit: s => /(^|[\s=:"'])\.\.\//.test(s) },
];

const INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'node', 'python', 'python3', 'perl', 'ruby', 'php',
  'osascript', 'eval', 'source', 'env',
]);

function argv0Of(segment: string): string {
  return (segment.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** Blank out quoted spans so a `>` inside a commit message is not read as a redirect. */
function stripQuoted(segment: string): string {
  return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * An absolute path in the segment that is not under `cwd`.
 *
 * Separate from {@link NEVER_WIDEN} because it needs the cluster's own `cwd` to answer, and folding a
 * parameter into that table would make every other entry carry an argument it does not use.
 */
export function escapesCwd(segment: string, cwd: string | null): string | null {
  for (const token of stripQuoted(segment).split(/[\s=]+/)) {
    const clean = token.replace(/^["']|["']$/g, '');
    if (!clean.startsWith('/')) { continue; }
    if (cwd && (clean === cwd || clean.startsWith(`${cwd}/`))) { continue; }
    return clean;
  }
  return null;
}

/** The first never-widen axis this support set touches, or null. */
export function neverWidenAxis(segments: readonly string[], cwd: string | null): string | null {
  for (const segment of segments) {
    for (const rule of NEVER_WIDEN) {
      if (rule.hit(segment)) { return rule.axis; }
    }
    const outside = escapesCwd(segment, cwd);
    if (outside !== null) { return `out-of-cwd:${outside}`; }
  }
  return null;
}

// --------------------------------------------------------------------------- E4, the literal

/**
 * The longest common word-boundary token prefix of every supporting segment, ≥ 2 tokens.
 *
 * Two steps, and the second is the one that matters: take the token-wise longest common prefix, then
 * shrink a token at a time until `prefixOf(candidate, segment) !== null` for **every** supporting
 * segment. `prefixOf` is the *acceptance test*, not the generator — its word-boundary anchor is what
 * stops `git s` licensing `git shove-everything`, and it is already the function that decides which
 * Claude Code prefix rule a clause licenses, so there is one definition of "is a safe prefix of".
 *
 * A one-token prefix is a whole tool (`git`, `npm`, `rm`) and is never what anyone meant, so
 * shrinking below two tokens refuses instead of returning.
 */
export function commonLiteral(segments: readonly string[]): string | null {
  if (segments.length === 0) { return null; }
  const tokenised = segments.map(s => s.trim().split(/\s+/).filter(t => t.length > 0));
  let tokens = tokenised[0];
  for (const other of tokenised.slice(1)) {
    let i = 0;
    while (i < tokens.length && i < other.length && tokens[i] === other[i]) { i += 1; }
    tokens = tokens.slice(0, i);
  }
  while (tokens.length >= 2) {
    const candidate = tokens.join(' ');
    if (segments.every(s => prefixOf(candidate, s) !== null)) { return candidate; }
    tokens = tokens.slice(0, -1);
  }
  return null;
}

// --------------------------------------------------------------------------- E5, the matcher

/**
 * The anchored matcher for a command literal, as it is written on the `Match:` line.
 *
 * Wrapped in backticks because `splitPatterns` lifts backticked patterns out before splitting on
 * commas, so a literal containing a comma survives. `escapeForMatcher` is `substringMatcher`'s own
 * escaping, so the literal is escaped exactly the way a hand-written matcher's would be.
 */
export function commandMatcher(literal: string): string {
  return `/"command"\\s*:\\s*"${escapeForMatcher(literal)}(?=[\\s"\\\\])/`;
}

// --------------------------------------------------------------------------- the candidate

/** What the gates produce: everything the writer and the run line need, and nothing derived. */
export interface Candidate extends ReplayCandidate {
  id: string;
  kind: string;
  slug: string;
  shape12: string;
  /**
   * `green` from the fail-closed/repeat lane, `yellow` from the gap lane (§4.7). Never `red` or
   * `orange` — proposing a safety clause from the *absence* of one manufactures a deny from silence
   * — and never a yellow with a `fix`; see {@link gate}.
   */
  level: 'green' | 'yellow';
  tier: Tier;
  scope: string;
  /**
   * The other hosts that witnessed this shape, by published label — empty at every tier but `team`.
   * Labels and nothing else: a witness contributes a hash and three counts, never a command.
   */
  witnessHosts: string[];
  match: string[];
  literal: string;
  cluster: string;
  signal: string;
  support: Support;
  evidence: string[];
  /** Every distinct supporting segment, for the rationale's "observed variants". */
  variants: string[];
  failClosed: number;
  failClosedLatencyMs: number;
  modelDecided: number;
  modelLatencyMs: number;
  firstSeen: string;
  lastSeen: string;
  contradictions: number;
  windowRotated: boolean;
}

/** A human-scannable slug from the canonical segment — the same string the hash is taken over. */
export function slugOf(segment: string, tool: string): string {
  const base = (segment || tool).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'shape';
}

/** `<kind>-<slug>-<shape12>`. Dateless — see the module header for why that is load-bearing. */
export function candidateId(kind: string, slug: string, shape12: string): string {
  const id = `${kind}-${slug}-${shape12}`;
  if (!isSafeId(id)) { throw new Error(`derived an unsafe clause id: ${JSON.stringify(id)}`); }
  return id;
}

export interface GateOptions {
  /**
   * Which lane (see {@link Lane}). The caller's, never derived here: it is fixed by which support set
   * the cluster was built over, and re-deriving it from the counters would let the two disagree.
   */
  lane?: Lane;
  /** The project slug, when one is configured. Without it no candidate can be project-scoped. */
  projectSlug: string | null;
  userSlug: string;
  /** The team slug, when one is configured. Without it no candidate can be team-scoped. */
  teamSlug?: string | null;
  /** The hosts, other than this one, that witness this shape (`aggregates.ts`). Names, for the trace. */
  witnessHosts?: readonly string[];
  /** True when the trail's rotated generation existed: the window's head is truncated. */
  windowRotated: boolean;
  /** Repo instruction files already in the classifier's context (§10.4). */
  instructionText?: string;
}

export interface GateResult {
  candidate: Candidate | null;
  refusal: Refusal | null;
  /** Why team was declined, so the ceiling is visible rather than mysterious (§5.3). Null when not. */
  declinedTeam: string | null;
  /** True when the rule is already stated in a repo instruction file. */
  alreadyStated: boolean;
}

/**
 * Run every gate over one cluster. A failure refuses the **whole cluster** and writes nothing.
 *
 * The level follows the lane, and the two the lanes cannot produce are the interesting ones:
 *
 *  - **`green`, from the fail-closed / classifier-decided lane.** A widening: it asks for a
 *    permission, and it goes to the full widening bar.
 *  - **`yellow` with no fix, from the gap lane** (§4.7). A narrowing: its whole effect is to withhold
 *    an allow a *learned* green would have granted and send the call to a human
 *    (`permissionRequest.ts`'s `withholdingYellow`). It licenses nothing even if accepted carelessly.
 *  - **Never red or orange**, because proposing a safety clause from the *absence* of one manufactures
 *    a deny from silence. `orange` additionally has no rung and does not load (`checkFix`'s sibling
 *    check in `parseLearnedClause`).
 *  - **Never a yellow with a `fix`.** §4.7 routes `rewritten: true` records here, and the lane is
 *    deliberately not built. Two independent reasons, either one sufficient: (1) the only rewrite a
 *    learned clause may legally carry is one `applyCorrection` already performs (F2, `checkFix`) —
 *    and `applyCorrection` runs at ladder rung 2, *before* any clause is consulted, so such a clause
 *    can never change a decision; it is inert by construction, not by accident. (2) Every command
 *    the shipped correction table rewrites is on the E8 never-widen list — `git push --force` hits
 *    `force-push`, `chmod 777` hits `chmod`, and `--force-with-lease` still contains `--force` so
 *    the rewritten form hits it too. Making the lane reachable means repealing E8 for exactly the
 *    axes E8 exists for. Neither is worth doing; see the PR body.
 */
export function gate(
  cluster: Cluster, support: Support, tier: 'user' | 'project' | 'team' | null,
  declinedTeam: string | null, opts: GateOptions,
): GateResult {
  const refuse = (why: RefusalReason, detail?: string): GateResult => ({
    candidate: null, refusal: { cluster: cluster.key, why, detail }, declinedTeam,
    alreadyStated: false,
  });
  const lane: Lane = opts.lane ?? 'green';

  // E3a — an unconfident split refuses the whole cluster, not just the record. Per-record skipping
  // would let a cluster be assembled while silently dropping the one line we could not parse.
  if (cluster.unconfident) { return refuse('unconfident-split'); }

  // E2 — one tool, and a known shape. The directory lane for `file_path`-carrying tools is specified
  // in §4.3 and is NOT built here; those clusters refuse as `no-matcher-shape` and are reported.
  if (!SHELL_TOOLS.has(cluster.tool) || cluster.segment === '') {
    return refuse('no-matcher-shape', cluster.tool);
  }

  if (tier === null) { return refuse('below-floor'); }

  // E1 — `call` present on every supporting record. No `inputSummary` derivation, ever: it is a
  // 300-char display string, and `replay.ts` deleted exactly that fallback and says why.
  if (cluster.noCall > 0) { return refuse('no-call', `${cluster.noCall} record(s)`); }
  if (cluster.support.length === 0) { return refuse('below-floor'); }

  // E6 — a written red deny on this shape refuses a green candidate. A fail-closed deny is not a
  // contradiction; it is the gap itself.
  if (cluster.contradictedBy !== null) {
    return refuse('contradicted', cluster.contradictedBy);
  }

  // E7 — no widening across a light boundary. Rejected outright, not softened.
  if (cluster.lights.length > 1) { return refuse('mixed-light', cluster.lights.join('/')); }

  // The gap that justifies asking for a permission at all: a record where policy did not reach the
  // call. Without one there is nothing for the clause to close, and `replay.ts`'s INERT finding
  // would reject it anyway — refusing here says so in the ledger instead of in a replay report.
  //
  // The gap lane skips it because it cannot fail it: its support set *is* the `decision: 'none'`
  // records, so a non-empty support set is a non-empty gap. Running the check anyway would be a
  // branch that can only ever be true, which is the kind of thing that reads as a real guard later.
  if (lane === 'green'
    && cluster.failClosed === 0 && cluster.gaps === 0 && cluster.modelDecided === 0) {
    return refuse('no-gap');
  }

  // E8 — never-widen axes. Dropped, not narrowed.
  const axis = neverWidenAxis(cluster.segments, support.cwd);
  if (axis !== null) { return refuse('never-widen', axis); }

  // E4 — the literal, and E9 by construction: no literal, no `Match:`, no candidate.
  const literal = commonLiteral(cluster.segments);
  if (literal === null) { return refuse('prefix-too-short'); }

  // The kind is part of the id, so a shape that clears the floor in both lanes gets two distinct,
  // dateless ids and one lane's `declined` file cannot suppress the other's candidate.
  const kind = lane === 'gap' ? 'gap-ask' : 'green-repeat';
  const slug = slugOf(cluster.segment, cluster.tool);
  const scope = tier === 'team'
    ? (opts.teamSlug ?? '')
    : tier === 'project' ? (opts.projectSlug ?? '') : opts.userSlug;
  if (!scope) { return refuse('below-floor', 'no slug configured for the chosen tier'); }

  const times = cluster.support.map(r => r.ts).sort();
  return {
    candidate: {
      id: candidateId(kind, slug, cluster.shape12),
      kind,
      slug,
      shape12: cluster.shape12,
      level: lane === 'gap' ? 'yellow' : 'green',
      // Stated rather than left undefined: `directionOf` reads it, and a gap-lane yellow is a
      // narrowing precisely *because* there is no fix. The value is the load-bearing part.
      hasFix: false,
      tier,
      scope,
      title: titleFor(literal, lane),
      match: [commandMatcher(literal)],
      literal,
      cluster: cluster.key,
      signal: cluster.signal,
      support,
      evidence: evidenceIds(cluster),
      variants: [...cluster.segments].sort(),
      failClosed: cluster.failClosed,
      failClosedLatencyMs: cluster.failClosedLatencyMs,
      modelDecided: cluster.modelDecided,
      modelLatencyMs: cluster.modelLatencyMs,
      firstSeen: times[0] ?? '',
      lastSeen: times[times.length - 1] ?? '',
      contradictions: 0,
      windowRotated: opts.windowRotated,
      // Only meaningful at team tier, and named at every tier so a reader of a user-tier clause can
      // see that the answer is "none" rather than "not recorded".
      witnessHosts: tier === 'team' ? [...(opts.witnessHosts ?? [])] : [],
    },
    refusal: null,
    declinedTeam,
    // §10.4 — `CLAUDE.md` and `.claude/rules/**` are already in the classifier's context on every
    // call, so a clause restating one of them is pure duplicated instruction against a budget the
    // research says collapses. ponytail: the dedupe is lexical, which catches `Match:`-shaped
    // restatements — the case that matters. A semantic pass belongs to the LLM tier, not here.
    alreadyStated: opts.instructionText !== undefined
      && opts.instructionText.toLowerCase().includes(literal.toLowerCase()),
  };
}

function titleFor(literal: string, lane: Lane): string {
  return lane === 'gap'
    ? `Ask a human about \`${literal}\` rather than letting a learned green settle it`
    : `Allow \`${literal}\` without a classifier round-trip`;
}

// --------------------------------------------------------------------------- rendering

/**
 * The clause file, whole.
 *
 * Two shapes here are forced by `learnedClauses.ts`'s own grammar rather than chosen:
 *
 *  - `learned_from.decisions` is an **inline** list. The restricted frontmatter grammar rejects block
 *    lists by name ("block lists are not supported: write `key: [a, b]` on one line"), and
 *    `11-mine-v2.md` §11.3's worked example writes one — so the example as printed does not parse.
 *  - nothing writes `status:` anything but `proposed`, `weight`, `origin`, `confidence`, `expires`,
 *    `learned_from.sessions`, `adopted_at`, `retired_*` or `displaces`. `origin` in particular is
 *    assigned from the path the loader read, and writing it is itself an error finding.
 */
export function renderClause(candidate: Candidate, today: string): string {
  const bar = (n: number): string => `${(n / 1000).toFixed(1)}s`;
  const front = [
    '---',
    `id: ${candidate.id}`,
    'status: proposed',
    `level: ${candidate.level}`,
    'evidence: EXTRACTED',
    `support: ${candidate.support.occurrences}`,
    `contradictions: ${candidate.contradictions}`,
    `learned_at: ${today}`,
    'learned_from:',
    `  decisions: [${candidate.evidence.join(', ')}]`,
    '---',
    '',
  ];
  const table = [
    `### Intention: ${candidate.title}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| id | ${candidate.id} |`,
    `| level | ${candidate.level} |`,
    `| scope | ${TIER_DIR[candidate.tier]}/${candidate.scope} |`,
    `| added | ${today} |`,
    `| tags | learned, ${candidate.signal}, ${candidate.level === 'yellow' ? 'gap' : 'latency'} |`,
    '',
    `Match: \`${candidate.match[0]}\``,
    '',
  ];
  // The rationale is template-generated and no model is involved. It clears
  // `RATIONALE_MIN_CHARS` (80) by an order of magnitude, which is the point: a clause whose *why* is
  // gone cannot be deleted without risking a regression, and that is how a corpus becomes permanent.
  const isGap = candidate.level === 'yellow';
  const prose: string[] = [
    `Observed ${candidate.support.occurrences} times across ${candidate.support.sessions} `
      + `session(s) between ${candidate.firstSeen.slice(0, 10)} and `
      + `${candidate.lastSeen.slice(0, 10)}, `
      + (isGap
        ? 'and on every one of them this layer returned no verdict at all — no clause matched, so '
        + 'nothing judged the call in either direction.'
        : 'always allowed, never contradicted by a written rule.'),
  ];
  if (isGap) {
    prose.push('This clause does not permit anything and cannot. A yellow with no fix sits above the '
      + 'learned green rung and below the learned red one, so the only thing it can do to a decision '
      + 'is withhold an allow a *learned* green would have granted and send the call to a human. It '
      + 'can never take away a permission a human wrote, and it can never turn a denial into an '
      + 'allow. Accepting it wrongly costs a prompt that should not have appeared; deleting it undoes '
      + 'that completely.');
  }
  if (candidate.failClosed > 0 && !isGap) {
    prose.push(`${candidate.failClosed} call(s) on this shape were denied fail-closed because no `
      + `clause covered them, costing ${bar(candidate.failClosedLatencyMs)} before the developer `
      + 'retried.');
  }
  if (candidate.modelDecided > 0 && !isGap) {
    prose.push(`${candidate.modelDecided} were decided by the classifier at `
      + `${bar(candidate.modelLatencyMs)} of model time that a written clause makes free.`);
  }
  prose.push(`Observed variants: ${candidate.variants.map(v => `\`${v}\``).join(', ')}.`);
  // A team clause binds people who did not write it, so the one thing a reviewer cannot be left to
  // guess is where the second developer's evidence came from. The counts above are this host's; the
  // witnesses are named by their published label, and what each of them published is a hash of this
  // clause's shape and three counts — no command line from any other machine is quoted here or
  // anywhere else, because none crossed the boundary.
  if (candidate.tier === 'team') {
    prose.push(`Witnessed independently on ${candidate.witnessHosts.length} other host(s) `
      + `(${candidate.witnessHosts.join(', ')}), each of which cleared the whole user row on its own `
      + `counts for shape \`${candidate.shape12}\`. Per-host counts are never summed: this host's `
      + `${candidate.support.occurrences} occurrences clear the team row by themselves, and the `
      + 'witnesses answer a different question — whether anyone else does this too. Recompute '
      + '`sha256("<tool>\\0<segment>")[0..12]` over the shape above to check a witness row refers to '
      + 'this clause.');
  }
  prose.push('The matcher is anchored at the start of the command value and ends on a word boundary, '
    + `so it ${isGap ? 'covers' : 'licenses'} arguments to this command and nothing else; a compound `
    + 'line is decomposed into its constituents before matching, so it cannot reach a second command '
    + 'on the same line.');
  prose.push('Counts are scoped to the decision-trail window, which rotates at 4 MiB keeping one '
    + `generation${candidate.windowRotated ? ' and had rotated when this was mined' : ''}, so `
    + 'earlier occurrences may exist and are not counted here.');
  prose.push(`Proposed by the deterministic miner, emission rule ${EMISSION_RULE}. No model was `
    + 'consulted; support is historical evidence, not consent.');

  return [...front, ...table, wrap(prose.join(' ')), ''].join('\n');
}

const TIER_DIR: Record<Tier, string> = { team: 'teams', project: 'projects', user: 'users' };

/** Hard-wrap prose at 98 columns so a clause file reads in a terminal and diffs line by line. */
function wrap(text: string, width = 98): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') { line = word; continue; }
    if (line.length + 1 + word.length > width) { out.push(line); line = word; continue; }
    line += ` ${word}`;
  }
  if (line !== '') { out.push(line); }
  return out.join('\n');
}

// --------------------------------------------------------------------------- the write

export type WriteOutcome = 'written' | 'overwritten' | 'status-guard';

/**
 * Write one clause file, or refuse to.
 *
 * Three properties, in the order they matter:
 *
 *  1. **`assertWritable` first, and it throws.** A throw means the run writes nothing at all, which
 *     is what makes a partial proposal impossible rather than merely unlikely.
 *  2. **The status guard is the whole suppression mechanism.** An existing file whose parsed status
 *     is not `proposed` is never overwritten. A file that cannot be parsed at all is also never
 *     overwritten: we cannot confirm it is `proposed`, and fail-closed means refusing.
 *  3. **tmp + fsync + rename**, so no reader ever sees a half-parsed clause.
 *
 * Overwriting an existing `proposed` file with a re-derived candidate is the normal, correct path.
 * Support counts *are* refreshed by it, because the file is rewritten wholesale from the current
 * fold and its `proposed` status keeps it inert either way. A clause's `weight` is the thing that
 * must never move after accept, and this pipeline never writes one.
 */
export function writeClause(
  corpusRoot: string, candidate: Candidate, body: string,
): { outcome: WriteOutcome; file: string } {
  const rel = learnedClausePath(candidate.tier, candidate.scope, candidate.id);
  const target = path.join(corpusRoot, ...rel.split('/'));
  assertWritable(corpusRoot, target, candidate.id);

  let existed = false;
  try {
    const current = fs.readFileSync(target, 'utf8');
    existed = true;
    if (statusOf(current) !== 'proposed') { return { outcome: 'status-guard', file: rel }; }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // `ENOTDIR` means some *parent* of the target is not a directory, so there is no clause file here
    // and there never was one: a broken corpus root has to surface as an error rather than as a
    // suppression, which would read like a human had declined something.
    //
    // Anything else — a file we can see and cannot read — is refused. We cannot confirm it is
    // `proposed`, and overwriting a `declined` file would release a permanent suppression.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { outcome: 'status-guard', file: rel };
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return { outcome: existed ? 'overwritten' : 'written', file: rel };
}

/**
 * The `status` of an existing clause file, as the loader would read it, or null.
 *
 * Reuses `parseFrontmatter` rather than a regex so that the writer and the loader cannot disagree
 * about what a file's status is — a disagreement here would silently release a suppression.
 */
export function statusOf(text: string): string | null {
  const { frontmatter } = parseFrontmatter(text, '(existing)');
  const raw = frontmatter?.scalars.status ?? null;
  return raw !== null && (CLAUSE_STATUSES as readonly string[]).includes(raw) ? raw : null;
}

// --------------------------------------------------------------------------- retirement (§8.2)

export interface RetirementProposal {
  target: string;
  tier: string;
  level: string | null;
  evidence_class: string;
  evidence: string;
  note: string;
  windowRotated: boolean;
}

export interface RedundancyReport {
  target: string;
  tier: string;
  level: string | null;
  shadowed_by: string | null;
  note: string;
}

export interface Listing {
  target: string;
  level: string | null;
  evidence_class: string;
  why: string;
}

export interface RetirementPlan {
  /** Proposals. **No file is written for any of these** — see below. */
  retirements: RetirementProposal[];
  /** `shadowed`: delete as redundant *or* narrow. The gate cannot tell those apart. */
  redundancies: RedundancyReport[];
  /** Reported, never proposed: `dead-weight?`, `deterrent`, `insufficient-exposure`. */
  listings: Listing[];
}

/**
 * Turn ablation reports into retirement proposals.
 *
 * **A retirement writes no clause file at all.** The permitted output is `learned/<id>.md` at
 * `status: proposed`, and a retirement file would be a clause that is not a clause — no `Match:`,
 * nothing to enforce, and `status: retired` is outside the permitted set. It also changes no policy
 * until a human acts, so it belongs entirely in the run record. This asymmetry with merge is
 * deliberate; do not "fix" it into a file write.
 *
 * ## The condition is one comparison, and it is not the obvious boolean
 *
 * `evidence_class === 'retire'`, never `AblationReport.retirement_candidate`. That field is
 * `changed === 0 && !isSafetyLevel(level)` (`ablate.ts:400`), which is **broader**: a *shadowed*
 * green has `retirement_candidate: true` and `evidence_class: 'shadowed'`, and `ablateAll` iterates
 * that broader set. Keying off the boolean would propose bare retirement for exactly the clauses
 * `SHADOWED_NOTE` says to narrow instead.
 *
 * And it needs no level check of its own, because `classify` partitions the enum **by level**:
 * `retire` is reachable only for a green or a yellow, and `dead-weight?` only for a red or an orange.
 * The enum already enforces "never auto-propose retiring a red"; `RED_NOT_PROPOSED` stays as defence
 * in depth and as the line a reviewer reads, not as the mechanism.
 */
export function planRetirements(
  reports: readonly AblationReport[], windowRotated: boolean,
): RetirementPlan {
  const plan: RetirementPlan = { retirements: [], redundancies: [], listings: [] };
  for (const report of reports) {
    switch (report.evidence_class) {
      case 'retire':
        plan.retirements.push({
          target: report.clause_id,
          tier: report.tier,
          level: report.level,
          evidence_class: report.evidence_class,
          evidence: report.evidence,
          // Every green retirement carries this verbatim: the grant may already be persisted in
          // Claude Code's own settings, where our hook is never consulted, so retiring the clause
          // does not retire the grant.
          note: report.level === 'green'
            ? `${GREEN_PERSISTENCE_NOTE}`
            : (report.note ?? ''),
          windowRotated,
        });
        break;
      case 'shadowed':
        plan.redundancies.push({
          target: report.clause_id,
          tier: report.tier,
          level: report.level,
          shadowed_by: report.shadowed_by ?? null,
          note: `${SHADOWED_NOTE}${report.level === 'red' || report.level === 'orange'
            ? ` ${RED_NOT_PROPOSED}` : ''}`,
        });
        break;
      case 'dead-weight?':
      case 'deterrent':
      case 'insufficient-exposure':
        plan.listings.push({
          target: report.clause_id,
          level: report.level,
          evidence_class: report.evidence_class,
          why: `${report.evidence} ${RED_NOT_PROPOSED}`,
        });
        break;
      default:
        break;                                        // `in-service`: nothing to decide
    }
  }
  plan.retirements = plan.retirements.slice(0, MAX_RETIREMENTS);
  return plan;
}
