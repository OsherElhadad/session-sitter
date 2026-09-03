/**
 * `policy compile` — the artifact, the revision, and every reason to refuse.
 *
 * The test names carry the property each one pins, because most of them exist to stop a *silent*
 * failure rather than a loud one: a refusal that emitted a partial artifact, a revision that moved
 * when nothing about the policy changed, a red clause whose only matcher was dropped.
 *
 * Every fixture is invented — no real path, no real project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CORE_BYTE_BUDGET,
  CompileInput,
  CompiledPolicy,
  POLICY_SCHEMA_VERSION,
  RETAINED_ARTIFACTS,
  artifactPath,
  canonicalJson,
  compilePolicy,
  coreClauses,
  currentPath,
  gatherCorpus,
  loadPolicy,
  policyDir,
  revisionOf,
  verifyPolicy,
  writePolicy,
} from '../../policy/compile';
import { parseBottomLine } from '../../supervisor/knowledge';
import { learnedDir, parseLearnedClause } from '../../supervisor/learnedClauses';

let tmp: string;
const saved = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-compile-'));
  process.env.SESSION_SITTER_DATA_DIR = path.join(tmp, 'data');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...saved };
});

const ROUTING = { user: 'dana', project: 'ledger-api', team: 'payments' };

/** Two sentences of real prose, comfortably over the rationale floor. */
const RATIONALE =
  'Rewriting history on a branch other people build on destroys their work: their next pull is a '
  + 'conflict against commits that no longer exist. Push a follow-up commit instead.';

interface LearnedOpts {
  id?: string;
  status?: string;
  level?: string;
  match?: string | null;
  body?: string;
  frontmatter?: string;
  tier?: 'team' | 'project' | 'user';
  slug?: string;
}

function learnedText(opts: LearnedOpts = {}): string {
  const {
    id = 'no-force-push', status = 'accepted', level = 'red',
    match = '`git push --force`', body = RATIONALE, frontmatter = '',
  } = opts;
  return `---
id: ${id}
status: ${status}
level: ${level}
evidence: EXTRACTED
support: 47
weight: high
contradictions: 0
learned_at: 2026-08-30
adopted_at: 2026-09-01
${frontmatter}learned_from:
  sessions: [20260812_nightly-release-a1b2c3d4]
  decisions: [d-8f21e0, d-8f2244]
---

### Intention: Never force-push to a shared branch

${match === null ? '' : `Match: ${match}\n`}
${body}
`;
}

function learned(opts: LearnedOpts = {}) {
  const tier = opts.tier ?? 'team';
  const slug = opts.slug ?? ROUTING.team;
  const rel = path.posix.join(learnedDir(tier, slug), `${opts.id ?? 'no-force-push'}.md`);
  const parsed = parseLearnedClause(learnedText(opts), tier, rel);
  if (!parsed.clause) { throw new Error(`fixture does not parse: ${JSON.stringify(parsed.findings)}`); }
  return parsed.clause;
}

/** A hand-written `bottom-line.md` entry, through the real parser. */
function human(body: string, tier = 'team') {
  return parseBottomLine(body, tier, `data/knowledge/teams/${ROUTING.team}/bottom-line.md`);
}

const HUMAN_RED = `
### Intention: Credentials are referenced by an environment variable

| Field | Value |
|---|---|
| id | pay-sec-001 |
| level | red |

A live key pasted into a prompt or a config file is a leak, and rotating it is somebody's evening.
Reference it as \`$LEDGER_TOKEN\` instead.
`;

function input(over: Partial<CompileInput> = {}): CompileInput {
  return {
    routing: ROUTING,
    human: [],
    learned: [],
    today: '2026-09-02',
    builtAt: '2026-09-02T00:00:00.000Z',
    corpusRef: 'git:1a2b3c4',
    ...over,
  };
}

function ok(over: Partial<CompileInput> = {}): CompiledPolicy {
  const result = compilePolicy(input(over));
  expect(result.errors).toEqual([]);
  if (!result.policy) { throw new Error('expected a policy'); }
  return result.policy;
}

// --------------------------------------------------------------------------- canonical json

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: null } }))
      .toBe('{"a":{"c":null,"d":[3,2]},"b":1}');
  });

  it('is stable under key insertion order, which is what makes the hash a content hash', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('drops undefined rather than emitting it, so an optional field cannot move the revision', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

// --------------------------------------------------------------------------- the revision

describe('the revision is a content hash', () => {
  it('is sha256 over the artifact, excluding revision, built_at and corpus_ref', () => {
    const policy = ok({ human: human(HUMAN_RED) });
    expect(policy.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(revisionOf(policy)).toBe(policy.revision);
  });

  it('does not move when only the build timestamp changes', () => {
    const a = ok({ human: human(HUMAN_RED), builtAt: '2026-09-02T00:00:00.000Z' });
    const b = ok({ human: human(HUMAN_RED), builtAt: '2027-01-01T12:34:56.000Z' });
    expect(b.revision).toBe(a.revision);
  });

  it('does not move when only the corpus git sha changes', () => {
    // Two commits with identical clause content must compile to one revision, or a no-op commit
    // invalidates every running session's cached prefix for nothing.
    const a = ok({ human: human(HUMAN_RED), corpusRef: 'git:1a2b3c4' });
    const b = ok({ human: human(HUMAN_RED), corpusRef: 'dirty:9f8e7d6c' });
    expect(b.revision).toBe(a.revision);
    expect(b.corpus_ref).toBe('dirty:9f8e7d6c');
  });

  it('does not move when a mutable counter changes, which is why they are not in the artifact', () => {
    const a = ok({ learned: [learned()] });
    const b = ok({ learned: [learned({ frontmatter: '' })] });
    const bumped = learned();
    bumped.support = 4711;
    bumped.contradictions = 3;
    const c = ok({ learned: [bumped] });
    expect(b.revision).toBe(a.revision);
    expect(c.revision).toBe(a.revision);
  });

  it('moves when a clause body changes, because the cache is supposed to be invalidated then', () => {
    const a = ok({ learned: [learned()] });
    const b = ok({ learned: [learned({ body: `${RATIONALE} And never on a release branch.` })] });
    expect(b.revision).not.toBe(a.revision);
  });

  it('moves when the rendered core changes', () => {
    const a = ok({ human: human(HUMAN_RED) });
    const b = ok({ human: human(HUMAN_RED.replace('| red |', '| orange |')) });
    expect(b.prompt_core).not.toBe(a.prompt_core);
    expect(b.revision).not.toBe(a.revision);
  });
});

// --------------------------------------------------------------------------- what is compiled in

describe('what reaches the artifact', () => {
  it('compiles accepted and audit clauses, and omits proposed and declined', () => {
    const policy = ok({
      learned: [
        learned({ id: 'live', status: 'accepted' }),
        learned({ id: 'trial', status: 'audit' }),
        learned({ id: 'candidate', status: 'proposed' }),
        learned({ id: 'refused', status: 'declined' }),
      ],
    });
    expect(policy.clauses.map(c => c.id).sort()).toEqual(['live', 'trial']);
  });

  it('keeps an audit clause compiled so it can match, and out of the rendered core', () => {
    // Omitting it would make an audit trial unable to record a hit — the runtime never reads
    // markdown once an artifact exists — and the promote gate would wait forever.
    const policy = ok({ learned: [learned({ id: 'trial', status: 'audit', match: null })] });
    expect(policy.clauses[0].status).toBe('audit');
    expect(coreClauses(policy.clauses)).toEqual([]);
    expect(policy.prompt_core).toBe('');
  });

  it('excludes a clause named by an accepted clause supersedes', () => {
    const policy = ok({
      learned: [
        learned({ id: 'new-rule', frontmatter: 'supersedes: [old-rule]\n' }),
        learned({ id: 'old-rule' }),
      ],
    });
    expect(policy.clauses.map(c => c.id)).toEqual(['new-rule']);
  });

  it('warns naming both clauses and both files when it drops a superseded clause', () => {
    // The drop is legitimate; doing it invisibly is not. Nothing in the superseded clause's own
    // file records that an edit to a *different* file removed it from live policy, so the compile
    // report is the only place a reviewer can find out.
    const result = compilePolicy(input({
      learned: [
        learned({ id: 'new-rule', frontmatter: 'supersedes: [old-rule]\n' }),
        learned({ id: 'old-rule' }),
      ],
    }));
    expect(result.errors).toEqual([]);
    const warning = result.warnings.join('\n');
    expect(warning).toContain('practices §old-rule');
    expect(warning).toContain('learned/old-rule.md');
    expect(warning).toContain('practices §new-rule');
    expect(warning).toContain('learned/new-rule.md');
  });

  it('refuses a supersedes naming an id no clause has, because it retires nothing silently', () => {
    // The observable failure of a typo is that the old rule keeps firing while its author believes
    // it is gone — a permissive clause you think you retired and did not.
    const result = compilePolicy(input({
      learned: [
        learned({ id: 'new-rule', frontmatter: 'supersedes: [teh-old-rule]\n' }),
        learned({ id: 'the-old-rule' }),
      ],
    }));
    expect(result.policy).toBeNull();
    const error = result.errors.join('\n');
    expect(error).toContain('teh-old-rule');
    expect(error).toContain('learned/new-rule.md');
    expect(error).toContain('the-old-rule');
  });

  it('refuses a supersession cycle of any length, naming every clause in a stable order', () => {
    // Three, not two: a length-2 special case is wrong the first time someone writes a chain. Every
    // clause in the cycle is dropped, so a ring of reds removes every one of those protections and
    // the individual drop warnings never say the pair annihilated.
    const result = compilePolicy(input({
      learned: [
        learned({ id: 'rule-a', frontmatter: 'supersedes: [rule-b]\n' }),
        learned({ id: 'rule-b', frontmatter: 'supersedes: [rule-c]\n' }),
        learned({ id: 'rule-c', frontmatter: 'supersedes: [rule-a]\n' }),
      ],
    }));
    expect(result.policy).toBeNull();
    const cycle = result.errors.filter(e => e.includes('supersession cycle'));
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toContain('practices §rule-a (data/knowledge/teams/payments/learned/rule-a.md)'
      + ' → practices §rule-b (data/knowledge/teams/payments/learned/rule-b.md)'
      + ' → practices §rule-c (data/knowledge/teams/payments/learned/rule-c.md)'
      + ' → practices §rule-a');
  });

  it('warns that a clause not yet accepted supersedes nothing yet', () => {
    const result = compilePolicy(input({
      learned: [
        learned({ id: 'candidate', status: 'proposed', frontmatter: 'supersedes: [old-rule]\n' }),
        learned({ id: 'old-rule' }),
      ],
    }));
    expect(result.errors).toEqual([]);
    expect(result.policy?.clauses.map(c => c.id)).toEqual(['old-rule']);
    expect(result.warnings.join('\n'))
      .toContain('practices §candidate (data/knowledge/teams/payments/learned/candidate.md) is '
        + '`proposed`, so `supersedes: old-rule` has no effect until it is accepted');
  });

  it('carries no mutable provenance at all', () => {
    const policy = ok({ learned: [learned()] });
    const keys = Object.keys(policy.clauses[0]);
    for (const banned of ['support', 'evidence', 'contradictions', 'learned_at', 'adopted_at',
      'learned_from', 'tags', 'confidence', 'scope', 'source']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('rejects a numeric weight, because three buckets are what cannot be recomputed', () => {
    const parsed = parseLearnedClause(learnedText().replace('weight: high', 'weight: 47'), 'team',
      'data/knowledge/teams/payments/learned/no-force-push.md');
    expect(parsed.findings.some(f => f.severity === 'error' && f.message.includes('weight: 47')))
      .toBe(true);
  });

  it('reads an absent weight as the lowest bucket', () => {
    const text = learnedText().replace('weight: high\n', '');
    const parsed = parseLearnedClause(text, 'team',
      'data/knowledge/teams/payments/learned/no-force-push.md');
    expect(parsed.clause?.weight).toBe('low');
  });

  it('carries the frozen weight and the deletion dossier', () => {
    const clause = ok({ learned: [learned()] }).clauses[0];
    expect(clause.weight).toBe('high');
    expect(clause.deletable).toEqual({ decisions: ['d-8f21e0', 'd-8f2244'], validation: null });
  });

  it('carries the pattern as written, not as compiled, so the artifact is a faithful copy', () => {
    const clause = ok({ learned: [learned({ match: '`git push --force`, `/git\\s+push\\s+-f\\b/`' })] })
      .clauses[0];
    expect(clause.patterns).toEqual([
      { raw: 'git push --force', is_regex: false, flags: 'i' },
      { raw: '/git\\s+push\\s+-f\\b/', is_regex: true, flags: 'i' },
    ]);
  });

  it('names a human clause as human and a learned clause as learned, from the path', () => {
    const policy = ok({ human: human(HUMAN_RED), learned: [learned()] });
    const byId = new Map(policy.clauses.map(c => [c.id, c]));
    expect(byId.get('pay-sec-001')?.origin).toBe('human');
    expect(byId.get('pay-sec-001')?.deletable).toBeNull();
    expect(byId.get('no-force-push')?.origin).toBe('learned');
  });

  it('is snake_case on disk, the same convention SupervisionRecord already uses', () => {
    const policy = ok({ learned: [learned()] });
    expect(Object.keys(policy)).toEqual(expect.arrayContaining(
      ['schema_version', 'corpus_ref', 'built_at', 'built_from', 'prompt_core']));
    expect(Object.keys(policy.clauses[0])).toEqual(expect.arrayContaining(['source_file']));
    expect(JSON.stringify(policy)).not.toMatch(/schemaVersion|builtAt|sourceFile|promptCore/);
  });
});

// --------------------------------------------------------------------------- refusals

describe('compile refuses, and emits nothing at all', () => {
  const refused = (over: Partial<CompileInput>) => {
    const result = compilePolicy(input(over));
    expect(result.policy).toBeNull();
    return result.errors.join('\n');
  };

  it('refuses a pattern that does not compile, naming the clause and the pattern', () => {
    // The highest-value check here: `practices.ts` drops an unparseable regex at load time, which
    // turns a red clause into decoration. Offline it must be loud.
    const errors = refused({ learned: [learned({ match: '`/git push (--force/`' })] });
    expect(errors).toContain('/git push (--force/');
    expect(errors).toContain('would match nothing');
  });

  it('refuses a duplicate id, because a citation must name exactly one clause', () => {
    const errors = refused({
      learned: [learned({ id: 'dup' }), learned({ id: 'dup', tier: 'project', slug: ROUTING.project })],
    });
    expect(errors).toContain('duplicate clause id "dup"');
  });

  it('refuses a learned clause with no rationale body', () => {
    const errors = refused({ learned: [{ ...learned(), rationale: 'because.' }] });
    expect(errors).toContain('no rationale');
  });

  it('refuses on any error finding from the corpus walk', () => {
    const errors = refused({
      findings: [{ severity: 'error', file: 'data/knowledge/teams/payments/learned/broken.md', line: 4, message: 'missing `status`' }],
    });
    expect(errors).toContain('learned/broken.md:4: missing `status`');
  });

  it('passes a warn finding through without refusing', () => {
    const result = compilePolicy(input({
      findings: [{ severity: 'warn', file: 'f.md', line: null, message: 'no `contradictions` count' }],
    }));
    expect(result.policy).not.toBeNull();
    expect(result.warnings).toEqual(['f.md: no `contradictions` count']);
  });

  it('refuses an expired accepted clause: leaving service is a diff, not the passage of time', () => {
    const errors = refused({
      learned: [learned({ frontmatter: 'expires: 2026-01-01\n' })],
      servingRevision: 'sha256:abc1234',
    });
    // Actionable at 02:00, not merely correct: how stale, which file, both remedies, and the fact
    // that a refused compile has changed nothing that is live.
    expect(errors).toContain('expired on 2026-01-01 (244 days ago)');
    expect(errors).toContain('learned/no-force-push.md');
    expect(errors).toContain('extend `expires:` through review');
    expect(errors).toContain('`retired_reason: manual`');
    expect(errors).toContain('the runtime keeps serving sha256:abc1234');
    expect(errors).toContain('`policy block` is outside the artifact');
  });

  it('says so plainly when nothing is published yet', () => {
    expect(refused({ learned: [learned({ frontmatter: 'expires: 2026-01-01\n' })] }))
      .toContain('nothing is published yet');
  });

  it('does not let a lapsed audit clause halt a publish — an inert clause has no such power', () => {
    const result = compilePolicy(input({
      learned: [learned({ status: 'audit', frontmatter: 'expires: 2026-01-01\n' })],
    }));
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('expired on 2026-01-01');
    expect(result.policy?.clauses).toHaveLength(1);
  });

  it('accepts a clause whose expiry is still ahead', () => {
    expect(ok({ learned: [learned({ frontmatter: 'expires: 2099-01-01\n' })] }).clauses).toHaveLength(1);
  });

  it('warns rather than refusing on a hand-written non-ISO expiry, for zero breakage', () => {
    const result = compilePolicy(input({ human: human(HUMAN_RED.replace('| level | red |', '| level | red |\n| expires | next quarter |')) }));
    expect(result.policy).not.toBeNull();
    expect(result.warnings.join('\n')).toContain('is not an ISO date');
  });

  it('refuses when the revision-stable core does not fit, naming the byte count', () => {
    // A prose red costs full budget by design, so enough of them overflow the core.
    const many = Array.from({ length: 400 }, (_, i) => `
### Intention: Rule number ${i} about a thing that needs a long explanation

| Field | Value |
|---|---|
| id | pay-long-${String(i).padStart(3, '0')} |
| level | red |

${RATIONALE}
`).join('\n');
    const errors = refused({ human: human(many) });
    expect(errors).toContain(`over the ${CORE_BYTE_BUDGET}-byte budget`);
  });

  it('reports every error in one pass rather than stopping at the first', () => {
    const result = compilePolicy(input({
      learned: [learned({ id: 'a', match: '`/(/`' }), learned({ id: 'b', match: '`/)/`' })],
    }));
    expect(result.errors).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------- the core

describe('the revision-stable core', () => {
  it('renders red and orange clauses that have no patterns, and nothing else', () => {
    const policy = ok({
      human: human(HUMAN_RED),
      learned: [
        learned({ id: 'deterministic-red', match: '`git push --force`' }),
        learned({ id: 'prose-green', level: 'green', match: null }),
      ],
    });
    expect(coreClauses(policy.clauses).map(c => c.id)).toEqual(['pay-sec-001']);
  });

  it('renders a clause in the two-line citable form, body truncated', () => {
    const policy = ok({ human: human(HUMAN_RED) });
    expect(policy.prompt_core.split('\n')[0]).toBe('- [team] red practices §pay-sec-001');
    expect(policy.prompt_core).toContain('Credentials are referenced by an environment variable:');
  });

  it('is byte-identical across two compiles of one corpus', () => {
    expect(ok({ human: human(HUMAN_RED), learned: [learned()] }).prompt_core)
      .toBe(ok({ learned: [learned()], human: human(HUMAN_RED) }).prompt_core);
  });
});

// --------------------------------------------------------------------------- disk

describe('publishing the artifact', () => {
  it('writes the immutable revision and publishes current.json as a copy, not a pointer', () => {
    const policy = ok({ learned: [learned()] });
    const written = writePolicy(policy);
    expect(written).toBe(artifactPath(policy.revision));
    // One file open on the hot path: `current.json` is the artifact, not a `HEAD` indirection.
    expect(JSON.parse(fs.readFileSync(currentPath(), 'utf8')).revision).toBe(policy.revision);
    expect(fs.readFileSync(written, 'utf8')).toBe(fs.readFileSync(currentPath(), 'utf8'));
    expect(fs.existsSync(path.join(policyDir(), 'HEAD'))).toBe(false);
  });

  it('leaves no temp file behind, because the publish is a rename', () => {
    writePolicy(ok({ learned: [learned()] }));
    expect(fs.readdirSync(policyDir()).filter(n => n.includes('tmp'))).toEqual([]);
  });

  it('round-trips through loadPolicy', () => {
    const policy = ok({ learned: [learned()] });
    writePolicy(policy);
    const loaded = loadPolicy(ROUTING);
    expect(loaded.reason).toBeNull();
    expect(loaded.policy?.revision).toBe(policy.revision);
    expect(loaded.policy?.clauses[0].body).toBe(policy.clauses[0].body);
  });

  it('reports an absent artifact rather than an empty policy', () => {
    expect(loadPolicy(ROUTING)).toEqual({ policy: null, reason: 'absent' });
  });

  it('verifies the copy it published, so a bad write is this process\'s problem', () => {
    const policy = ok({ learned: [learned()] });
    writePolicy(policy);
    expect(verifyPolicy(JSON.parse(fs.readFileSync(currentPath(), 'utf8')))).toBeNull();
  });

  it('detects an edited artifact through verifyPolicy — which the hot path does not run', () => {
    // 1.7 ms of hashing at 200 clauses against a 2 ms budget for the whole policy path. It was never
    // a security control either: whoever can write this file can also recompute the hash.
    const policy = ok({ learned: [learned()] });
    writePolicy(policy);
    const tampered = JSON.parse(fs.readFileSync(currentPath(), 'utf8')) as CompiledPolicy;
    tampered.clauses = [];                                   // a removed red clause
    fs.writeFileSync(currentPath(), JSON.stringify(tampered), 'utf8');
    expect(verifyPolicy(tampered)).toContain('does not match its contents');
    expect(loadPolicy(ROUTING).policy?.clauses).toEqual([]);
  });

  it('discards an unparsable or wrong-schema artifact', () => {
    fs.mkdirSync(policyDir(), { recursive: true });
    fs.writeFileSync(currentPath(), '{ not json', 'utf8');
    expect(loadPolicy(ROUTING).reason).toContain('unparsable');
    fs.writeFileSync(currentPath(), JSON.stringify({ schema_version: 99 }), 'utf8');
    expect(loadPolicy(ROUTING).reason)
      .toBe(`schema_version 99 is not ${POLICY_SCHEMA_VERSION}`);
  });

  it('discards an artifact compiled for a different routing triple', () => {
    writePolicy(ok({ learned: [learned()] }));
    expect(loadPolicy({ ...ROUTING, project: 'other-service' }).reason)
      .toBe('compiled for a different routing triple');
  });

  it('rewrites nothing when the same revision is published twice', () => {
    const policy = ok({ learned: [learned()] });
    const file = writePolicy(policy);
    const before = fs.statSync(file).mtimeMs;
    writePolicy(policy);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it(`retains the newest ${RETAINED_ARTIFACTS} artifacts and no more`, () => {
    for (let i = 0; i < RETAINED_ARTIFACTS + 5; i++) {
      writePolicy(ok({ learned: [learned({ body: `${RATIONALE} Variation ${i}.` })] }));
    }
    const kept = fs.readdirSync(policyDir()).filter(n => /^[0-9a-f]{64}\.json$/.test(n));
    expect(kept).toHaveLength(RETAINED_ARTIFACTS);
  });
});

// --------------------------------------------------------------------------- end to end

describe('gatherCorpus', () => {
  it('reads the human tiers and each tier learned directory from a checkout', async () => {
    const teamDir = path.join(tmp, 'corpus', 'data', 'knowledge', 'teams', ROUTING.team);
    fs.mkdirSync(path.join(teamDir, 'learned'), { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'bottom-line.md'), HUMAN_RED, 'utf8');
    fs.writeFileSync(path.join(teamDir, 'learned', 'no-force-push.md'), learnedText(), 'utf8');

    const gathered = await gatherCorpus({
      corpusRoot: path.join(tmp, 'corpus'),
      user: ROUTING.user, project: ROUTING.project, team: ROUTING.team,
      today: '2026-09-02',
    });
    expect(gathered.routing).toEqual(ROUTING);
    expect(gathered.human).toHaveLength(1);
    expect(gathered.learned.map(c => c.id)).toEqual(['no-force-push']);
    expect(gathered.builtFrom).toContain(
      `data/knowledge/teams/${ROUTING.team}/learned/no-force-push.md`);
    // Not a git checkout, so there is no ref to record — and that is said, not guessed.
    expect(gathered.corpusRef).toBeNull();

    const { policy } = compilePolicy(gathered);
    expect(policy?.clauses.map(c => c.id).sort()).toEqual(['no-force-push', 'pay-sec-001']);
  });

  it('treats an absent learned directory as zero clauses, not an error', async () => {
    const teamDir = path.join(tmp, 'corpus', 'data', 'knowledge', 'teams', ROUTING.team);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'bottom-line.md'), HUMAN_RED, 'utf8');
    const gathered = await gatherCorpus({
      corpusRoot: path.join(tmp, 'corpus'), user: ROUTING.user,
      project: ROUTING.project, team: ROUTING.team,
    });
    expect(gathered.learned).toEqual([]);
    expect(gathered.findings).toEqual([]);
  });
});
