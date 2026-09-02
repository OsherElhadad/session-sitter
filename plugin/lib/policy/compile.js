// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/compile.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETAINED_ARTIFACTS = exports.CLAUSE_TEXT_LIMIT = exports.CORE_BYTE_BUDGET = exports.SELECTOR_VERSION = exports.POLICY_SCHEMA_VERSION = void 0;
exports.canonicalJson = canonicalJson;
exports.revisionOf = revisionOf;
exports.revisionHex = revisionHex;
exports.renderClause = renderClause;
exports.compareCore = compareCore;
exports.coreClauses = coreClauses;
exports.renderCore = renderCore;
exports.compilePolicy = compilePolicy;
exports.policyDir = policyDir;
exports.artifactPath = artifactPath;
exports.currentPath = currentPath;
exports.writePolicy = writePolicy;
exports.pruneArtifacts = pruneArtifacts;
exports.verifyPolicy = verifyPolicy;
exports.loadPolicy = loadPolicy;
exports.corpusRefFor = corpusRefFor;
exports.gatherCorpus = gatherCorpus;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const knowledge_1 = require("../supervisor/knowledge");
const learnedClauses_1 = require("../supervisor/learnedClauses");
const practices_1 = require("./practices");
const paths_1 = require("../hooks/paths");
const child_process_1 = require("child_process");
// --------------------------------------------------------------------------- constants
/** Bumped when a *reader* of the artifact would misread an older or newer one. */
exports.POLICY_SCHEMA_VERSION = 1;
/**
 * The selection algorithm the artifact was built for. Stamped because an old decision's rendered
 * set can only be reproduced by the selector that produced it — the same reason the revision is.
 */
exports.SELECTOR_VERSION = 'v1';
/** The revision-stable core, inside the cache breakpoint. Overflow fails the compile. */
exports.CORE_BYTE_BUDGET = 8 * 1024;
/** How much of a clause body is rendered — the limit `renderTurns` already uses for payloads. */
exports.CLAUSE_TEXT_LIMIT = 400;
/**
 * How many immutable artifacts to keep. Old ones exist so an old citation resolves offline; a
 * scheduled pipeline writing 112 KB forever does not. Same discipline as the audit trail's rotation.
 */
exports.RETAINED_ARTIFACTS = 20;
// --------------------------------------------------------------------------- the revision
/** Keys deliberately outside the hash. Everything else is inside it. */
const UNHASHED = new Set(['revision', 'built_at', 'corpus_ref']);
/** Deterministic JSON: keys sorted recursively, no whitespace, no `undefined`. */
function canonicalJson(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const entries = Object.entries(value)
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
function revisionOf(policy) {
    const body = {};
    for (const [key, value] of Object.entries(policy)) {
        if (!UNHASHED.has(key)) {
            body[key] = value;
        }
    }
    return `sha256:${(0, crypto_1.createHash)('sha256').update(canonicalJson(body), 'utf8').digest('hex')}`;
}
/** The hex half of a revision — what a filename and a `§id@rev7` citation are built from. */
function revisionHex(revision) {
    return revision.startsWith('sha256:') ? revision.slice('sha256:'.length) : revision;
}
// --------------------------------------------------------------------------- rendering
const LEVEL_ORDER = { red: 0, orange: 1, yellow: 2, green: 3 };
const ORIGIN_ORDER = { human: 0, learned: 1 };
const CORE_TIER_ORDER = { user: 0, project: 1, team: 2 };
function truncate(text, limit = exports.CLAUSE_TEXT_LIMIT) {
    const flat = text.replace(/\s*\n\s*/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
/** The two-line form the existing prompt already uses, with the citation made explicit. */
function renderClause(clause) {
    return `- [${clause.tier}] ${clause.level ?? '-'} ${clause.citation}\n`
        + `  ${clause.title}: ${truncate(clause.body)}`;
}
/**
 * The core's order: severity, then authorship, then narrowness, then id. Total, so the rendered
 * bytes are a pure function of the corpus and two compiles of one corpus are byte-identical.
 */
function compareCore(a, b) {
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
function coreClauses(clauses) {
    return clauses
        .filter(c => c.status === 'accepted' && (c.level === 'red' || c.level === 'orange')
        && c.patterns.length === 0)
        .sort(compareCore);
}
function renderCore(clauses) {
    return coreClauses(clauses).map(renderClause).join('\n');
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function patternsOf(specs) {
    return specs.map(s => ({ raw: s.raw, is_regex: s.isRegex, flags: s.flags }));
}
/** `supersedes: a, b` in a hand-written metadata table is one comma-separated cell. */
function splitList(value) {
    return (value ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
}
function humanClause(entry) {
    const specs = (0, practices_1.patternSpecs)(entry.text);
    const id = (0, practices_1.clauseIdFor)(entry);
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
            body: (0, learnedClauses_1.rationaleOf)(entry),
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
function learnedClause(file) {
    const specs = (0, practices_1.patternSpecs)(file.entry.text);
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
function daysBetween(from, to) {
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
function expiredMessage(clause, input) {
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
 * Compile the corpus, or refuse.
 *
 * There is no middle outcome, and that asymmetry against the *loader* is the design. A malformed
 * file at load time is skipped so the rest of the tier survives — dropping the tier would remove
 * reds nobody broke. At compile time nothing is emitted at all, so a broken corpus never becomes
 * live policy while the runtime keeps serving the last good revision. Fail-loud and
 * never-silently-weaken, reconciled by putting them at different stages.
 */
function compilePolicy(input) {
    const errors = [];
    const warnings = [];
    for (const f of input.findings ?? []) {
        const where = `${f.file}${f.line === null ? '' : `:${f.line}`}`;
        if (f.severity === 'error') {
            errors.push(`${where}: ${f.message}`);
        }
        else if (f.severity === 'warn') {
            warnings.push(`${where}: ${f.message}`);
        }
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
    // old text stays resolvable through the older artifact and the corpus.
    const superseded = new Set();
    for (const { clause } of pairs) {
        if (clause.status === 'accepted') {
            clause.supersedes.forEach(id => superseded.add(id));
        }
    }
    const clauses = [];
    const byId = new Map();
    for (const { clause, specs } of pairs) {
        if (superseded.has(clause.id)) {
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
        if (clause.origin === 'learned' && clause.body.length < learnedClauses_1.RATIONALE_MIN_CHARS) {
            errors.push(`${clause.citation}: no rationale (${clause.body.length} of `
                + `${learnedClauses_1.RATIONALE_MIN_CHARS} characters) — a clause whose *why* is gone cannot be deleted `
                + 'without risking a regression, which is how a corpus becomes permanent');
        }
        if (clause.expires !== null) {
            if (!ISO_DATE.test(clause.expires)) {
                // A learned file's dates are validated by the loader, so this can only be a hand-written
                // entry, where today's behaviour is a warning and zero breakage is the priority.
                warnings.push(`${clause.citation}: \`expires: ${clause.expires}\` is not an ISO date, so `
                    + 'it will never expire');
            }
            else if (clause.expires < input.today) {
                // An audit clause is inert — never rendered, and its verdict never counted. It does not get
                // to halt a publish; it simply refuses to be promoted while it is lapsed.
                const message = expiredMessage(clause, input);
                if (clause.status === 'audit') {
                    warnings.push(message);
                }
                else {
                    errors.push(message);
                }
            }
        }
        byId.set(clause.id, clause);
        clauses.push(clause);
    }
    clauses.sort(compareCore);
    const promptCore = renderCore(clauses);
    const coreBytes = Buffer.byteLength(promptCore, 'utf8');
    if (coreBytes > exports.CORE_BYTE_BUDGET) {
        errors.push(`the revision-stable core is ${coreBytes} bytes, over the ${exports.CORE_BYTE_BUDGET}-byte `
            + `budget by ${coreBytes - exports.CORE_BYTE_BUDGET}. Split the tier: a corpus whose mandatory rules `
            + 'do not fit in the prompt is better discovered here than from a truncated red rule at 3am');
    }
    if (errors.length > 0) {
        return { policy: null, errors, warnings };
    }
    const policy = {
        schema_version: exports.POLICY_SCHEMA_VERSION,
        revision: '',
        corpus_ref: input.corpusRef ?? null,
        built_at: input.builtAt ?? new Date().toISOString(),
        built_from: [...(input.builtFrom ?? [])].sort(),
        selector: exports.SELECTOR_VERSION,
        routing: input.routing,
        prompt_core: promptCore,
        clauses,
    };
    policy.revision = revisionOf(policy);
    return { policy, errors, warnings };
}
// --------------------------------------------------------------------------- disk
function policyDir(env) {
    return path.join((0, paths_1.dataDir)(env), 'policy');
}
/**
 * The immutable artifact's path. Named by the hex alone, not by `sha256:<hex>`: the colon is a
 * legal filename character here and a hostile one elsewhere, and the prefix is already inside the
 * file where the reader needs it.
 */
function artifactPath(revision, env) {
    return path.join(policyDir(env), `${revisionHex(revision)}.json`);
}
/** The one file the hot path opens. */
function currentPath(env) {
    return path.join(policyDir(env), 'current.json');
}
/**
 * Publish a revision: write the immutable copy, then swap `current.json` by rename.
 *
 * The rename is what makes this safe against a hook reading mid-write. A partially written
 * `current.json` would be discarded by the loader, which is not a failure — but it would be a
 * decision made against the markdown fallback for no reason, so it is worth one temp file to avoid.
 */
function writePolicy(policy, env) {
    const dir = policyDir(env);
    fs.mkdirSync(dir, { recursive: true });
    // Compact, not pretty-printed. This file is read by a hook on a 2 ms budget and by nothing else;
    // two-space indent costs ~45% more bytes and parse time to serve a `cat` that `jq` already serves.
    const body = `${JSON.stringify(policy)}\n`;
    const immutable = artifactPath(policy.revision, env);
    // Content-addressed, so an existing file with this name already has exactly these bytes.
    if (!fs.existsSync(immutable)) {
        fs.writeFileSync(immutable, body, 'utf8');
    }
    const tmp = path.join(dir, `.current.${process.pid}.tmp`);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, currentPath(env));
    // Verify what was actually published, once, here — where 2 ms is free and a bad write is still
    // this process's fault. The hot path never pays for this again.
    const published = JSON.parse(fs.readFileSync(currentPath(env), 'utf8'));
    const bad = verifyPolicy(published);
    if (bad) {
        throw new Error(`published artifact did not round-trip: ${bad}`);
    }
    pruneArtifacts(env);
    return immutable;
}
/** Keep the newest {@link RETAINED_ARTIFACTS} so old citations resolve offline, and no more. */
function pruneArtifacts(env) {
    const dir = policyDir(env);
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return;
    }
    const artifacts = names
        .filter(n => /^[0-9a-f]{64}\.json$/.test(n))
        .map(n => {
        const full = path.join(dir, n);
        let mtime = 0;
        try {
            mtime = fs.statSync(full).mtimeMs;
        }
        catch { /* raced with another compile */ }
        return { full, mtime };
    })
        .sort((a, b) => b.mtime - a.mtime);
    for (const stale of artifacts.slice(exports.RETAINED_ARTIFACTS)) {
        try {
            fs.unlinkSync(stale.full);
        }
        catch { /* best effort; a leftover file is harmless */ }
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
function verifyPolicy(policy) {
    const recomputed = revisionOf(policy);
    return recomputed === policy.revision
        ? null
        : `revision ${policy.revision} does not match its contents (${recomputed})`;
}
/**
 * Read the published artifact, or say why not.
 *
 * Every rejection falls back to the markdown corpus, and that is not fail-open: the corpus is the
 * source of truth, so a tampered artifact that *removed* a red clause is defeated by re-reading the
 * markdown. What it must never do is read as "no rules" — an empty policy in enforce mode denies
 * the world for a reason nobody can see.
 */
function loadPolicy(expected, env) {
    const file = currentPath(env);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return { policy: null, reason: 'absent' };
    }
    let policy;
    try {
        policy = JSON.parse(text);
    }
    catch (err) {
        return { policy: null, reason: `unparsable: ${String(err)}` };
    }
    if (policy?.schema_version !== exports.POLICY_SCHEMA_VERSION) {
        return { policy: null, reason: `schema_version ${String(policy?.schema_version)} is not ${exports.POLICY_SCHEMA_VERSION}` };
    }
    if (!Array.isArray(policy.clauses)) {
        return { policy: null, reason: 'no clauses array' };
    }
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
function git(args, cwd) {
    return new Promise(resolve => {
        (0, child_process_1.execFile)('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
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
async function corpusRefFor(corpusRoot, inputs) {
    const head = await git(['rev-parse', '--short', 'HEAD'], corpusRoot);
    if (head.code !== 0) {
        return null;
    }
    const status = await git(['status', '--porcelain'], corpusRoot);
    if (status.code === 0 && status.stdout.trim() === '') {
        return `git:${head.stdout.trim()}`;
    }
    const hash = (0, crypto_1.createHash)('sha256').update(inputs.join(' '), 'utf8').digest('hex').slice(0, 8);
    return `dirty:${hash}`;
}
/**
 * Read the corpus: the three `bottom-line.md` tiers through the existing loader, and each tier's
 * `learned/` directory through the learned-clause walk.
 *
 * The human lane is loaded by `loadKnowledge` and nothing else, deliberately — a second knowledge
 * path would be a second source of truth for what a team's rules are.
 */
async function gatherCorpus(opts) {
    const bundle = await (0, knowledge_1.loadKnowledge)({
        user: opts.user,
        project: opts.project,
        team: opts.team,
        registryPath: opts.registryPath,
        localRepo: opts.corpusRoot,
    });
    const routing = { user: bundle.user, project: bundle.project, team: bundle.team };
    const slugs = routing;
    const learned = [];
    const findings = [];
    const builtFrom = [...bundle.loadedFiles];
    for (const tier of knowledge_1.TIER_ORDER) {
        const walk = (0, learnedClauses_1.readLearnedDir)(opts.corpusRoot, tier, slugs[tier]);
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
