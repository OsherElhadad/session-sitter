/**
 * `policy compile` — turn the reviewed corpus into the one artifact the runtime loads.
 *
 * The corpus is markdown that a cron job and several humans write to. The runtime needs the exact
 * opposite: a byte-stable input it can read in under a millisecond and name in an audit record. So
 * the two are separated by a compile step, and this module is that step.
 *
 * ## What the artifact buys, in the order the reasons matter
 *
 *  1. **A stable prompt prefix.** The fast classifier puts practices in the `system` block behind a
 *     KV-cache breakpoint. *Any* byte change invalidates it, at a measured 6.8× cost on the first
 *     call of every session. A file three humans can edit is not a cacheable input; a
 *     content-addressed artifact is, and its name *is* its content.
 *  2. **A bounded prompt.** `renderKnowledge` prints every entry, untruncated. At 200 clauses that
 *     is ~11.5 k tokens of policy crowding out the transcript it is supposed to reason about. The
 *     artifact carries a pre-rendered, revision-stable core, and `select.ts` bounds the rest.
 *  3. **A citation that resolves forever.** A decision made in March must resolve to the clause text
 *     that actually fired, not to whatever the markdown says today.
 *  4. **A loud offline failure.** `practices.ts` drops an unparseable regex, which turns a red
 *     clause into decoration — silently. Here that refuses the compile by name, before it ships.
 *
 * ## Two files on disk, deliberately
 *
 *     <dataDir>/policy/<hex>.json     immutable, content-addressed, retained
 *     <dataDir>/policy/current.json   an atomically published *copy* of the current revision
 *
 * `current.json` is a copy rather than a pointer because the hot path must open exactly one file: a
 * `HEAD` pointer costs a second read in front of a human-visible permission prompt. The duplication
 * is ~112 KB at 200 clauses, measured, and accepted.
 *
 * ## What is deliberately *not* in the artifact
 *
 * `support`, `evidence`, `contradictions` — every mutable counter. They are real, and they live in
 * the corpus and the audit log where offline tools read them. In here they would be a disaster: the
 * revision is a content hash, so editing a support count would move the revision and invalidate the
 * cached prefix of every running session. The selector still needs a ranking signal, so a clause
 * carries `weight`, frozen when it was accepted and never updated (`learnedClauses.ts`).
 *
 * That is what makes selection reproducible from `(revision, selector, input)` alone.
 *
 * Spec: `10-schema.md` §5 (artifact) and §6 (bounding), `14-runtime-and-dashboard.md` §A1/§A4/§A6.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { KnowledgeEntry, TIER_ORDER, Tier, loadKnowledge } from '../supervisor/knowledge';
import {
  ClauseOrigin, ClauseStatus, ClauseWeight, Finding, LearnedClauseFile, RATIONALE_MIN_CHARS,
  didYouMean, rationaleOf, readLearnedDir,
} from '../supervisor/learnedClauses';
import { ClauseLevel, PatternSpec, clauseIdFor, patternSpecs } from './practices';
import { dataDir } from '../hooks/paths';
import { execFile } from 'child_process';

// --------------------------------------------------------------------------- constants

/** Bumped when a *reader* of the artifact would misread an older or newer one. */
export const POLICY_SCHEMA_VERSION = 1;

/**
 * The selection algorithm the artifact was built for. Stamped because an old decision's rendered
 * set can only be reproduced by the selector that produced it — the same reason the revision is.
 */
export const SELECTOR_VERSION = 'v1';

/** The revision-stable core, inside the cache breakpoint. Overflow fails the compile. */
export const CORE_BYTE_BUDGET = 8 * 1024;

/** How much of a clause body is rendered — the limit `renderTurns` already uses for payloads. */
export const CLAUSE_TEXT_LIMIT = 400;

/**
 * How many immutable artifacts to keep. Old ones exist so an old citation resolves offline; a
 * scheduled pipeline writing 112 KB forever does not. Same discipline as the audit trail's rotation.
 */
export const RETAINED_ARTIFACTS = 20;

// --------------------------------------------------------------------------- on-disk shape

/**
 * Field names are snake_case because this is JSON on disk and `SupervisionRecord` — written by the
 * same codebase, read by the same tools — is already snake_case on disk. One convention.
 */
export interface CompiledPattern {
  /** Exactly what the author typed between the commas of the `Match:` line. */
  raw: string;
  is_regex: boolean;
  flags: string;
}

export interface CompiledFix { from: string; to: string }

/**
 * The subset of provenance that makes a clause *deletable from the artifact alone*: the concrete
 * decisions that motivated it, and the replay that justified it. Both are immutable after
 * acceptance, which is why they can live in a hashed artifact and a support count cannot.
 */
export interface CompiledDeletable {
  decisions: string[];
  /** An ablation/replay run id. Null until the validation gate names one. */
  validation: string | null;
}

export interface CompiledClause {
  id: string;
  /** `practices §<id>` — built here, never model-generated. */
  citation: string;
  origin: ClauseOrigin;
  tier: string;
  level: ClauseLevel;
  /** `accepted` decides and renders; `audit` is matched and recorded, and never rendered. */
  status: ClauseStatus;
  kind: string;
  title: string;
  /** The body verbatim, `Match:` lines lifted. Carries both the why and the remediation. */
  body: string;
  patterns: CompiledPattern[];
  fix: CompiledFix | null;
  /** Frozen at accept time. The selector's ranking signal, and nothing else. */
  weight: ClauseWeight;
  expires: string | null;
  supersedes: string[];
  source_file: string | null;
  /** Null for a human clause: `bottom-line.md` is a human's file and needs no deletion dossier. */
  deletable: CompiledDeletable | null;
}

export interface CompiledPolicy {
  schema_version: number;
  /** `sha256:<hex>` over everything except itself, `built_at` and `corpus_ref`. */
  revision: string;
  /** `git:<short-sha>` / `dirty:<hash>` — informational, recoverable, never the identity. */
  corpus_ref: string | null;
  built_at: string;
  built_from: string[];
  selector: string;
  routing: { user: string; project: string; team: string };
  /** The revision-stable knowledge block, rendered once, byte-for-byte what the cache holds. */
  prompt_core: string;
  clauses: CompiledClause[];
}

// --------------------------------------------------------------------------- the revision

/** Keys deliberately outside the hash. Everything else is inside it. */
const UNHASHED = new Set(['revision', 'built_at', 'corpus_ref']);

/** Deterministic JSON: keys sorted recursively, no whitespace, no `undefined`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value) ?? 'null'; }
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(',')}]`; }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The revision: a content hash, which makes the artifact's name its identity.
 *
 * Three keys are excluded, each for its own reason:
 *
 *  - `revision` — it is the output.
 *  - `built_at` — a timestamp in the hash would give every recompile a new revision and defeat the
 *    entire point: recompiling an unchanged corpus must leave the cache warm.
 *  - `corpus_ref` — the git SHA is *recorded* so the markdown stays recoverable, but it is not the
 *    identity. It is volatile in exactly the way that matters: two commits with identical clause
 *    content must compile to the same revision, or a no-op commit moves the revision and invalidates
 *    every running session's cached prefix for nothing. Excluding it is what makes a content hash a
 *    content hash. **Do not add it back for completeness.**
 *
 * `prompt_core` **is** inside the hash, because it is the bytes the cache holds. If the core
 * changes the revision must change — the cache is supposed to be invalidated then.
 */
export function revisionOf(policy: CompiledPolicy): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (!UNHASHED.has(key)) { body[key] = value; }
  }
  return `sha256:${createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')}`;
}

/** The hex half of a revision — what a filename and a `§id@rev7` citation are built from. */
export function revisionHex(revision: string): string {
  return revision.startsWith('sha256:') ? revision.slice('sha256:'.length) : revision;
}

// --------------------------------------------------------------------------- rendering

const LEVEL_ORDER: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
const ORIGIN_ORDER: Record<ClauseOrigin, number> = { human: 0, learned: 1 };
const CORE_TIER_ORDER: Record<string, number> = { user: 0, project: 1, team: 2 };

function truncate(text: string, limit = CLAUSE_TEXT_LIMIT): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** The two-line form the existing prompt already uses, with the citation made explicit. */
export function renderClause(clause: CompiledClause): string {
  return `- [${clause.tier}] ${clause.level ?? '-'} ${clause.citation}\n`
    + `  ${clause.title}: ${truncate(clause.body)}`;
}

/**
 * The core's order: severity, then authorship, then narrowness, then id. Total, so the rendered
 * bytes are a pure function of the corpus and two compiles of one corpus are byte-identical.
 */
export function compareCore(a: CompiledClause, b: CompiledClause): number {
  return ((LEVEL_ORDER[a.level ?? ''] ?? 9) - (LEVEL_ORDER[b.level ?? ''] ?? 9))
    || (ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin])
    || ((CORE_TIER_ORDER[a.tier] ?? 9) - (CORE_TIER_ORDER[b.tier] ?? 9))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The core set: accepted red and orange clauses that have **no** patterns.
 *
 * The "no patterns" half is the part worth defending, because the spec's own two halves disagree
 * about it. Deterministic matching runs at rungs 2–4 of the hook ladder and the classifier is
 * rung 6, so by the time a prompt exists every matchable clause has already been tested against
 * this call and lost. Rendering one is prose claiming to be about something its own pattern says
 * this call is not: it cannot fire deterministically (already tried) and it spends compliance
 * budget to contribute nothing. A red *without* patterns can only ever speak as prose, so it goes
 * in the core at full cost — which is the right price signal against writing prose reds.
 *
 * Matching is never budgeted. This is about rendering, and only about rendering.
 */
export function coreClauses(clauses: readonly CompiledClause[]): CompiledClause[] {
  return clauses
    .filter(c => c.status === 'accepted' && (c.level === 'red' || c.level === 'orange')
      && c.patterns.length === 0)
    .sort(compareCore);
}

export function renderCore(clauses: readonly CompiledClause[]): string {
  return coreClauses(clauses).map(renderClause).join('\n');
}

// --------------------------------------------------------------------------- compile

export interface CompileInput {
  routing: { user: string; project: string; team: string };
  /** `bottom-line.md` entries as parsed today — the human lane, untouched. */
  human: readonly KnowledgeEntry[];
  /** `learned/<id>.md` files as parsed by `learnedClauses.ts` — the machine lane. */
  learned: readonly LearnedClauseFile[];
  /** Findings from the corpus walk. A single `error` refuses the compile. */
  findings?: readonly Finding[];
  /** Files the compile read, for the record. */
  builtFrom?: string[];
  corpusRef?: string | null;
  /** ISO date. Expiry is evaluated against it, never against a clock inside the hash. */
  today: string;
  /**
   * The revision the runtime is serving right now, named in an expiry error so whoever reads it at
   * 02:00 knows a refused compile changed nothing. Null when nothing is published yet.
   */
  servingRevision?: string | null;
  /** Injected so a test can pin it. Outside the hash either way. */
  builtAt?: string;
}

export interface CompileResult {
  /** Null whenever `errors` is non-empty: a refused compile writes nothing at all. */
  policy: CompiledPolicy | null;
  errors: string[];
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function patternsOf(specs: readonly PatternSpec[]): CompiledPattern[] {
  return specs.map(s => ({ raw: s.raw, is_regex: s.isRegex, flags: s.flags }));
}

/** `supersedes: a, b` in a hand-written metadata table is one comma-separated cell. */
function splitList(value: string | null): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function humanClause(entry: KnowledgeEntry): { clause: CompiledClause; specs: PatternSpec[] } {
  const specs = patternSpecs(entry.text);
  const id = clauseIdFor(entry);
  const level = (entry.level ?? '').trim().toLowerCase();
  return {
    specs,
    clause: {
      id,
      citation: `practices §${id}`,
      origin: 'human',
      tier: entry.tier,
      level: (level === 'red' || level === 'orange' || level === 'yellow' || level === 'green')
        ? level : null,
      // A hand-written entry has no status field and needs none: `bottom-line.md` is the human lane,
      // and a human writing a clause into it *is* the acceptance.
      status: 'accepted',
      kind: entry.kind,
      title: entry.title,
      body: rationaleOf(entry),
      patterns: patternsOf(specs),
      fix: null,
      // A hand-written clause has no evidence to weigh. It does not sort last for it: `origin` leads
      // the rendering order, so a human clause is above every learned one whatever its bucket.
      weight: 'low',
      expires: entry.expires,
      supersedes: splitList(entry.supersedes),
      source_file: entry.sourceFile,
      deletable: null,
    },
  };
}

function learnedClause(file: LearnedClauseFile): { clause: CompiledClause; specs: PatternSpec[] } {
  const specs = patternSpecs(file.entry.text);
  return {
    specs,
    clause: {
      id: file.id,
      citation: `practices §${file.id}`,
      origin: 'learned',
      tier: file.tier,
      level: file.level,
      status: file.status,
      kind: file.entry.kind,
      title: file.entry.title,
      body: file.rationale,
      patterns: patternsOf(specs),
      fix: file.fix,
      weight: file.weight,
      expires: file.expires,
      supersedes: file.supersedes,
      source_file: file.sourceFile,
      // Not `learned_from` wholesale: the sessions list and the counters are mutable, and mutable
      // in a hashed artifact means a revision bump per edit. These two are immutable after
      // acceptance, and they are what a deletion review actually needs.
      deletable: { decisions: file.learnedFrom.decisions, validation: null },
    },
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

/**
 * The expiry finding, written to be actionable at 02:00 rather than merely correct.
 *
 * Someone hitting this is blocked from publishing and needs four things in the text itself, not in a
 * doc they have to go find: which clause and where it lives, how stale it is, both remedies, and —
 * the part that stops a panic — that nothing is live-broken. A refused compile changes nothing: the
 * runtime keeps serving the revision it already has, and `policy block` is a channel outside the
 * artifact, so incident response never waits on a compile.
 */
function expiredMessage(clause: CompiledClause, input: CompileInput): string {
  const stale = daysBetween(clause.expires ?? input.today, input.today);
  const serving = input.servingRevision
    ? `the runtime keeps serving ${input.servingRevision}`
    : 'nothing is published yet, so no live policy changes';
  return `${clause.citation}: expired on ${clause.expires} (${stale} day${stale === 1 ? '' : 's'} `
    + `ago), ${clause.source_file ?? 'unknown file'}.\n`
    + '    Two remedies, both a reviewed diff: extend `expires:` through review, or retire it '
    + '(`status: retired` + `retired_reason: manual`).\n'
    + `    A refused compile blocks nothing that is already live — ${serving}, and \`policy block\` `
    + 'is outside the artifact, so incident response does not wait on this.';
}

/**
 * Every supersession cycle among accepted clauses, each rotated to start at its lowest id so the
 * message reads the same on every run whatever order the corpus walk produced.
 *
 * ponytail: a plain DFS over a graph of a few hundred nodes. Colour-marking (`done`) is what keeps
 * one ring from being reported once per member.
 */
function supersessionCycles(pairs: readonly { clause: CompiledClause }[]): CompiledClause[][] {
  const accepted = new Map<string, CompiledClause>();
  for (const { clause } of pairs) {
    if (clause.status === 'accepted') { accepted.set(clause.id, clause); }
  }

  const rings: CompiledClause[][] = [];
  const done = new Set<string>();
  const walk = (id: string, path: string[]): void => {
    const at = path.indexOf(id);
    if (at !== -1) {
      const ids = path.slice(at);
      const lowest = ids.indexOf([...ids].sort()[0]);
      const rotated = [...ids.slice(lowest), ...ids.slice(0, lowest)];
      rings.push(rotated.map(i => accepted.get(i)).filter((c): c is CompiledClause => c !== undefined));
      return;
    }
    if (done.has(id)) { return; }
    const clause = accepted.get(id);
    if (!clause) { return; }
    for (const next of clause.supersedes) { walk(next, [...path, id]); }
    done.add(id);
  };
  for (const { clause } of pairs) {
    if (clause.status === 'accepted') { walk(clause.id, []); }
  }
  return rings;
}

/**
 * Compile the corpus, or refuse.
 *
 * There is no middle outcome, and that asymmetry against the *loader* is the design. A malformed
 * file at load time is skipped so the rest of the tier survives — dropping the tier would remove
 * reds nobody broke. At compile time nothing is emitted at all, so a broken corpus never becomes
 * live policy while the runtime keeps serving the last good revision. Fail-loud and
 * never-silently-weaken, reconciled by putting them at different stages.
 */
export function compilePolicy(input: CompileInput): CompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const f of input.findings ?? []) {
    const where = `${f.file}${f.line === null ? '' : `:${f.line}`}`;
    if (f.severity === 'error') { errors.push(`${where}: ${f.message}`); }
    else if (f.severity === 'warn') { warnings.push(`${where}: ${f.message}`); }
  }

  const pairs = [
    ...input.human.map(humanClause),
    // `proposed` and `declined` never reach the artifact — a proposal that could affect a decision
    // is the one invariant this whole lane exists to keep. `audit` *does*, because the runtime
    // never reads markdown once an artifact exists: omit it and an audit trial can never record a
    // hit, and the promote gate waits forever for evidence that cannot arrive.
    ...input.learned.filter(f => f.status === 'accepted' || f.status === 'audit')
      .map(learnedClause),
  ];

  // A clause named by an accepted clause's `supersedes` is out: the replacement is present, and the
  // old text stays resolvable through the older artifact and the corpus. Which superseder did it is
  // kept, not just the fact — the warning below is the only record the removal happened, and a
  // reviewer needs to know whose edit removed their clause.
  // Only an accepted clause supersedes anything, and a clause still under review has said so
  // nowhere. `declined`, `superseded` and `retired` are past tense — their `supersedes` is history,
  // and warning about it on every compile forever would be noise.
  for (const f of input.learned) {
    if ((f.status === 'proposed' || f.status === 'audit') && f.supersedes.length > 0) {
      warnings.push(`practices §${f.id} (${f.sourceFile ?? '?'}) is \`${f.status}\`, so `
        + `\`supersedes: ${f.supersedes.join(', ')}\` has no effect until it is accepted`);
    }
  }

  const corpusIds = new Set(pairs.map(p => p.clause.id));
  const superseded = new Map<string, CompiledClause>();
  for (const { clause } of pairs) {
    if (clause.status !== 'accepted') { continue; }
    for (const id of clause.supersedes) {
      if (!corpusIds.has(id)) {
        // An error rather than a warning, because the author's stated intent did not happen: the
        // old clause keeps firing while its file's history says it was retired. Safe to refuse —
        // a refused compile writes nothing, the runtime keeps serving the last good revision, and
        // `policy block` is a deny-only channel outside the artifact, so no brake is lost.
        const near = didYouMean(id, corpusIds);
        errors.push(`${clause.citation} (${clause.source_file ?? '?'}): \`supersedes: ${id}\` names `
          + 'no clause in the corpus, so it retires nothing and the old rule keeps firing'
          + `${near === null ? '' : ` — did you mean ${JSON.stringify(near)}?`}`);
        continue;
      }
      superseded.set(id, clause);
    }
  }

  // Two clauses each claiming to replace the other is incoherent rather than a judgement call, and
  // the loop below would drop *every* clause in the ring — a cycle of reds removes every one of
  // those protections, and the per-clause warnings never say the ring annihilated. There is no
  // correct artifact to emit, so this refuses, on the same terms as an unknown id: a refused compile
  // writes nothing, the last good revision keeps serving, and `policy block` is outside the artifact.
  for (const ring of supersessionCycles(pairs)) {
    errors.push(`supersession cycle: ${ring.map(c => `${c.citation} (${c.source_file ?? '?'})`)
      .join(' → ')} → ${ring[0].citation}. Every clause in the cycle would be dropped and none of `
      + 'them replaced. Break it: one of these supersessions is the wrong direction');
  }

  const clauses: CompiledClause[] = [];
  const byId = new Map<string, CompiledClause>();
  for (const { clause, specs } of pairs) {
    const supersededBy = superseded.get(clause.id);
    if (supersededBy) {
      // A warning, not an error: superseding is legitimate. Doing it invisibly is not — on the human
      // lane there is no `status` field at all, so an edit to one file removes another file's entry
      // from live policy with nothing in that file, or its history, saying so.
      warnings.push(`${clause.citation} (${clause.source_file ?? '?'}) is superseded by `
        + `${supersededBy.citation} (${supersededBy.source_file ?? '?'}) and is not in this `
        + 'revision — nothing in its own file records that');
      continue;
    }

    // The highest-value check in this file. `practices.ts` drops an unparseable pattern so that one
    // bad clause cannot take a tier down at load time; the consequence is a red clause that
    // silently protects nothing. Offline, it is an error with a name.
    for (const spec of specs) {
      if (spec.compiled === null) {
        errors.push(`${clause.citation}: pattern ${JSON.stringify(spec.raw)} does not compile, so `
          + `this ${clause.level ?? 'prose'} clause would match nothing`);
      }
    }

    const clash = byId.get(clause.id);
    if (clash) {
      errors.push(`duplicate clause id ${JSON.stringify(clause.id)} in `
        + `${clash.source_file ?? '?'} and ${clause.source_file ?? '?'} — a citation must name `
        + 'exactly one clause');
      continue;
    }

    if (clause.origin === 'learned' && clause.body.length < RATIONALE_MIN_CHARS) {
      errors.push(`${clause.citation}: no rationale (${clause.body.length} of `
        + `${RATIONALE_MIN_CHARS} characters) — a clause whose *why* is gone cannot be deleted `
        + 'without risking a regression, which is how a corpus becomes permanent');
    }

    if (clause.expires !== null) {
      if (!ISO_DATE.test(clause.expires)) {
        // A learned file's dates are validated by the loader, so this can only be a hand-written
        // entry, where today's behaviour is a warning and zero breakage is the priority.
        warnings.push(`${clause.citation}: \`expires: ${clause.expires}\` is not an ISO date, so `
          + 'it will never expire');
      } else if (clause.expires < input.today) {
        // An audit clause is inert — never rendered, and its verdict never counted. It does not get
        // to halt a publish; it simply refuses to be promoted while it is lapsed.
        const message = expiredMessage(clause, input);
        if (clause.status === 'audit') { warnings.push(message); } else { errors.push(message); }
      }
    }

    byId.set(clause.id, clause);
    clauses.push(clause);
  }

  clauses.sort(compareCore);
  const promptCore = renderCore(clauses);
  const coreBytes = Buffer.byteLength(promptCore, 'utf8');
  if (coreBytes > CORE_BYTE_BUDGET) {
    errors.push(`the revision-stable core is ${coreBytes} bytes, over the ${CORE_BYTE_BUDGET}-byte `
      + `budget by ${coreBytes - CORE_BYTE_BUDGET}. Split the tier: a corpus whose mandatory rules `
      + 'do not fit in the prompt is better discovered here than from a truncated red rule at 3am');
  }

  if (errors.length > 0) { return { policy: null, errors, warnings }; }

  const policy: CompiledPolicy = {
    schema_version: POLICY_SCHEMA_VERSION,
    revision: '',
    corpus_ref: input.corpusRef ?? null,
    built_at: input.builtAt ?? new Date().toISOString(),
    built_from: [...(input.builtFrom ?? [])].sort(),
    selector: SELECTOR_VERSION,
    routing: input.routing,
    prompt_core: promptCore,
    clauses,
  };
  policy.revision = revisionOf(policy);
  return { policy, errors, warnings };
}

// --------------------------------------------------------------------------- disk

export function policyDir(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'policy');
}

/**
 * The immutable artifact's path. Named by the hex alone, not by `sha256:<hex>`: the colon is a
 * legal filename character here and a hostile one elsewhere, and the prefix is already inside the
 * file where the reader needs it.
 */
export function artifactPath(revision: string, env?: NodeJS.ProcessEnv): string {
  return path.join(policyDir(env), `${revisionHex(revision)}.json`);
}

/** The one file the hot path opens. */
export function currentPath(env?: NodeJS.ProcessEnv): string {
  return path.join(policyDir(env), 'current.json');
}

/**
 * Publish a revision: write the immutable copy, then swap `current.json` by rename.
 *
 * The rename is what makes this safe against a hook reading mid-write. A partially written
 * `current.json` would be discarded by the loader, which is not a failure — but it would be a
 * decision made against the markdown fallback for no reason, so it is worth one temp file to avoid.
 */
export function writePolicy(policy: CompiledPolicy, env?: NodeJS.ProcessEnv): string {
  const dir = policyDir(env);
  fs.mkdirSync(dir, { recursive: true });
  // Compact, not pretty-printed. This file is read by a hook on a 2 ms budget and by nothing else;
  // two-space indent costs ~45% more bytes and parse time to serve a `cat` that `jq` already serves.
  const body = `${JSON.stringify(policy)}\n`;
  const immutable = artifactPath(policy.revision, env);
  // Content-addressed, so an existing file with this name already has exactly these bytes.
  if (!fs.existsSync(immutable)) { fs.writeFileSync(immutable, body, 'utf8'); }

  const tmp = path.join(dir, `.current.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, currentPath(env));

  // Verify what was actually published, once, here — where 2 ms is free and a bad write is still
  // this process's fault. The hot path never pays for this again.
  const published = JSON.parse(fs.readFileSync(currentPath(env), 'utf8')) as CompiledPolicy;
  const bad = verifyPolicy(published);
  if (bad) { throw new Error(`published artifact did not round-trip: ${bad}`); }

  pruneArtifacts(env);
  return immutable;
}

/** Keep the newest {@link RETAINED_ARTIFACTS} so old citations resolve offline, and no more. */
export function pruneArtifacts(env?: NodeJS.ProcessEnv): void {
  const dir = policyDir(env);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  const artifacts = names
    .filter(n => /^[0-9a-f]{64}\.json$/.test(n))
    .map(n => {
      const full = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* raced with another compile */ }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of artifacts.slice(RETAINED_ARTIFACTS)) {
    try { fs.unlinkSync(stale.full); } catch { /* best effort; a leftover file is harmless */ }
  }
}

/**
 * Recompute the revision and say whether the artifact still matches it. Null means it does.
 *
 * **Not on the hot path, and that is measured rather than assumed.** At 200 clauses recomputing the
 * hash costs 1.7 ms on its own, against a 2 ms budget for the *whole* policy path — read, parse,
 * compile 414 patterns, match, and select all together come to 1.07 ms, so verification would be
 * more than half the budget and break it.
 *
 * Nothing is lost by moving it off that path, because it was never a security control: the hashing
 * algorithm is public and `current.json` is writable by whoever can write the corpus, so anyone able
 * to tamper can also produce a matching hash. What it genuinely catches is a *bad write* — a
 * truncated file, a hand-edited artifact, a stale copy — and those are caught where they happen:
 * `writePolicy` verifies the copy it just published, and the hot path relies on `JSON.parse`, the
 * schema check, the routing check, and the atomic rename that publishes the file.
 */
export function verifyPolicy(policy: CompiledPolicy): string | null {
  const recomputed = revisionOf(policy);
  return recomputed === policy.revision
    ? null
    : `revision ${policy.revision} does not match its contents (${recomputed})`;
}

export interface LoadedPolicy {
  policy: CompiledPolicy | null;
  /** Why there is no policy. Null on success. Never swallowed — the caller records it. */
  reason: string | null;
}

/**
 * Read the published artifact, or say why not.
 *
 * Every rejection falls back to the markdown corpus, and that is not fail-open: the corpus is the
 * source of truth, so a tampered artifact that *removed* a red clause is defeated by re-reading the
 * markdown. What it must never do is read as "no rules" — an empty policy in enforce mode denies
 * the world for a reason nobody can see.
 */
export function loadPolicy(
  expected?: { user: string; project: string; team: string } | null,
  env?: NodeJS.ProcessEnv,
): LoadedPolicy {
  return loadPolicyFile(currentPath(env), expected);
}

/**
 * The same read, against a named file — how `policy explain --rev` resolves a retained artifact.
 *
 * Split out rather than duplicated: a second reader would be a second set of answers to "is this
 * artifact usable", and the whole point of resolving an old citation is that it resolves to what
 * actually fired. `loadPolicy` is this function against `current.json`, and nothing else.
 */
export function loadPolicyFile(
  file: string,
  expected?: { user: string; project: string; team: string } | null,
): LoadedPolicy {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { policy: null, reason: 'absent' }; }

  let policy: CompiledPolicy;
  try { policy = JSON.parse(text) as CompiledPolicy; }
  catch (err) { return { policy: null, reason: `unparsable: ${String(err)}` }; }

  if (policy?.schema_version !== POLICY_SCHEMA_VERSION) {
    return { policy: null, reason: `schema_version ${String(policy?.schema_version)} is not ${POLICY_SCHEMA_VERSION}` };
  }
  if (!Array.isArray(policy.clauses)) { return { policy: null, reason: 'no clauses array' }; }
  // The revision is deliberately *not* recomputed here — see `verifyPolicy` for the measurement.
  // What *does* run on every load, and is now the only structural check between the file and a
  // decision: `JSON.parse`, the `schema_version` match, the clauses-array shape, and the routing
  // triple below. The residual is stated plainly so nobody discovers it later — a corrupt but
  // *parsable* artifact with a matching schema and routing is trusted on the hot path.
  if (expected && (policy.routing.user !== expected.user
    || policy.routing.project !== expected.project
    || policy.routing.team !== expected.team)) {
    return { policy: null, reason: 'compiled for a different routing triple' };
  }
  return { policy, reason: null };
}

// --------------------------------------------------------------------------- corpus gathering

/**
 * One git command, resolving to its exit code and output rather than throwing.
 *
 * `corpus/upload.ts` already exports exactly this as `runGit`, and reusing it was the first
 * instinct — but this module is imported by the `PermissionRequest` hook, and `plugin/lib/` ships
 * every module the hook's import graph reaches. Importing `upload.ts` for eight lines drags 39 KB of
 * corpus-upload and Bob-database code into the plugin a hook will never call. Eight duplicated
 * lines of `execFile` is the cheaper mistake.
 */
function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: stdout ?? '' });
    });
  });
}

/**
 * `git:<short-sha>` for a clean checkout, `dirty:<hash-of-inputs>` for a working tree.
 *
 * Informational, and outside the revision hash — but a compile from an uncommitted tree must be
 * visibly distinguishable in an audit trail, because the loader reads the working tree, not a
 * commit, and "which markdown was this?" has no answer otherwise.
 */
export async function corpusRefFor(corpusRoot: string, inputs: string[]): Promise<string | null> {
  const head = await git(['rev-parse', '--short', 'HEAD'], corpusRoot);
  if (head.code !== 0) { return null; }
  const status = await git(['status', '--porcelain'], corpusRoot);
  if (status.code === 0 && status.stdout.trim() === '') {
    return `git:${head.stdout.trim()}`;
  }
  const hash = createHash('sha256').update(inputs.join(' '), 'utf8').digest('hex').slice(0, 8);
  return `dirty:${hash}`;
}

export interface GatherOptions {
  /** Local checkout containing `data/knowledge/`. The compile runs where the checkout is. */
  corpusRoot: string;
  user: string;
  project?: string | null;
  team?: string | null;
  registryPath?: string;
  today?: string;
}

/**
 * Read the corpus: the three `bottom-line.md` tiers through the existing loader, and each tier's
 * `learned/` directory through the learned-clause walk.
 *
 * The human lane is loaded by `loadKnowledge` and nothing else, deliberately — a second knowledge
 * path would be a second source of truth for what a team's rules are.
 */
export async function gatherCorpus(opts: GatherOptions): Promise<CompileInput> {
  const bundle = await loadKnowledge({
    user: opts.user,
    project: opts.project,
    team: opts.team,
    registryPath: opts.registryPath,
    localRepo: opts.corpusRoot,
  });
  const routing = { user: bundle.user, project: bundle.project, team: bundle.team };
  const slugs: Record<Tier, string> = routing;

  const learned: LearnedClauseFile[] = [];
  const findings: Finding[] = [];
  const builtFrom = [...bundle.loadedFiles];
  for (const tier of TIER_ORDER) {
    const walk = readLearnedDir(opts.corpusRoot, tier, slugs[tier]);
    learned.push(...walk.clauses);
    findings.push(...walk.findings);
    builtFrom.push(...walk.clauses.map(c => c.sourceFile));
  }

  return {
    routing,
    human: bundle.entries,
    learned,
    findings,
    builtFrom,
    corpusRef: await corpusRefFor(opts.corpusRoot, builtFrom),
    today: opts.today ?? new Date().toISOString().slice(0, 10),
  };
}
