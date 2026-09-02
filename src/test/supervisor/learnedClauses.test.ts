/**
 * Learned clauses: the restricted frontmatter subset, the `learned/` walk, the status semantics,
 * the four-rung precedence ladder, and the write boundary.
 *
 * The invariant numbers in the test names are `10-schema.md` §10's, so a reader can go from a
 * failing test to the paragraph that argues for it.
 *
 * Every rejection test also asserts that **nothing was written**. A guard that refuses and leaves a
 * partial file behind has not refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  LadderClause,
  CLAUSE_STATUSES,
  RATIONALE_MIN_CHARS,
  assertWritable,
  auditVerdicts,
  compareLadder,
  decideByLadder,
  hasErrors,
  isEnforceable,
  isMatched,
  learnedClausePath,
  learnedDir,
  parseFrontmatter,
  parseLearnedClause,
  readLearnedDir,
  rendersIntoPrompt,
  sortByLadder,
} from '../../supervisor/learnedClauses';
import { Tier } from '../../supervisor/knowledge';
import { makeTmpDir } from './fixtures';

let tmp: string;
beforeEach(() => { tmp = makeTmpDir('learned-test-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const TEAM = 'platform';

/** Two sentences of real prose, comfortably over the floor. */
const RATIONALE =
  'Rewriting history on a branch other people build on destroys their work: their next pull is a\n'
  + 'conflict against commits that no longer exist. Push a follow-up commit instead.';

interface ClauseOpts {
  id?: string;
  status?: string;
  level?: string;
  evidence?: string;
  extraFrontmatter?: string;
  body?: string;
  title?: string;
  learnedFrom?: string;
}

function clauseFile(opts: ClauseOpts = {}): string {
  const {
    id = 'no-force-push',
    status = 'accepted',
    level = 'red',
    evidence = 'EXTRACTED',
    extraFrontmatter = '',
    body = RATIONALE,
    title = 'Never force-push to a shared branch',
    learnedFrom = '  sessions: [20260812_nightly-release-a1b2c3d4]\n  decisions: [d-8f21e0, d-8f2244]',
  } = opts;
  return `---
id: ${id}
status: ${status}
level: ${level}
evidence: ${evidence}
support: 47
contradictions: 0
learned_at: 2026-08-30
adopted_at: 2026-09-01
${extraFrontmatter}learned_from:
${learnedFrom}
---

### Intention: ${title}

Match: \`git push --force\`

${body}
`;
}

/**
 * A hand-parked clause: no `learned_from` sources, and therefore no `evidence` either — `evidence`
 * describes an extraction, and a human parking a clause did not do one.
 */
function parkedClause(opts: ClauseOpts = {}): string {
  return clauseFile({ ...opts, learnedFrom: '  sessions: []\n  decisions: []' })
    .replace(/^evidence: .*\n/m, '');
}

/** Write one learned clause into a temp corpus and return the corpus root. */
function corpusWith(files: Record<string, string>, tier: Tier = 'team', slug = TEAM): string {
  const dir = path.join(tmp, ...learnedDir(tier, slug).split('/'));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return tmp;
}

function parse(text: string, name = 'no-force-push.md') {
  return parseLearnedClause(text, 'team', path.posix.join(learnedDir('team', TEAM), name));
}

function errors(findings: { severity: string; message: string }[]): string[] {
  return findings.filter(f => f.severity === 'error').map(f => f.message);
}

// --------------------------------------------------------------------------- frontmatter subset

describe('parseFrontmatter — the restricted subset', () => {
  it('reads scalars, inline lists and the one nested block', () => {
    const { frontmatter, findings } = parseFrontmatter(clauseFile(), 'f.md');
    expect(errors(findings)).toEqual([]);
    expect(frontmatter?.scalars.id).toBe('no-force-push');
    expect(frontmatter?.scalars.support).toBe('47');
    expect(frontmatter?.nested.lists.decisions).toEqual(['d-8f21e0', 'd-8f2244']);
    expect(frontmatter?.body.trim().startsWith('### Intention:')).toBe(true);
  });

  it('takes a scalar as the rest of the line, unquoted and untrimmed of inner spaces', () => {
    const { frontmatter } = parseFrontmatter('---\nfix_from: --force  \n---\nbody\n', 'f.md');
    expect(frontmatter?.scalars.fix_from).toBe('--force');
  });

  it('treats an empty inline list as empty, not as a one-element list', () => {
    const { frontmatter } = parseFrontmatter('---\ndisplaces: []\n---\n', 'f.md');
    expect(frontmatter?.lists.displaces).toEqual([]);
  });

  it('ignores a comment only at the start of a line', () => {
    const ok = parseFrontmatter('---\n# a note\nid: x\n---\n', 'f.md');
    expect(errors(ok.findings)).toEqual([]);
    expect(ok.frontmatter?.scalars.id).toBe('x');
  });

  // T9. A non-subset construct is a loud error naming the line — never a silently-empty field.
  it.each([
    ['a block list', '---\nsupersedes:\n  - old-id\n---\n', 'block lists'],
    ['a literal scalar', '---\nnote: |\n  two\n  lines\n---\n', 'multi-line scalars'],
    ['a folded scalar', '---\nnote: >\n  wrapped\n---\n', 'multi-line scalars'],
    ['a quoted key', '---\n"id": x\n---\n', 'quoted keys'],
    ['an anchor', '---\nid: &a x\n---\n', 'anchors'],
    ['a tab indent', '---\nlearned_from:\n\tsessions: [a]\n---\n', 'tab'],
    ['a deeper indent', '---\nlearned_from:\n    sessions: [a]\n---\n', 'indent'],
    ['an unclosed list', '---\nsupersedes: [a, b\n---\n', 'same line'],
    ['a duplicate key', '---\nid: a\nid: b\n---\n', 'duplicate key'],
    ['a second nested block', '---\nlearned_from:\n  sessions: [a]\nother:\n  x: 1\n---\n', 'nested block'],
    ['no fence at all', 'id: x\n\n### Intention: t\n', 'frontmatter fence'],
    ['an unterminated fence', '---\nid: x\n', 'unterminated'],
  ])('T9: rejects %s', (_name, text, needle) => {
    const { frontmatter, findings } = parseFrontmatter(text, 'f.md');
    expect(frontmatter).toBeNull();
    const errs = findings.filter(f => f.severity === 'error');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(f => f.message.includes(needle))).toBe(true);
    // Every error names a line, so the author can go straight to it.
    expect(errs.every(f => typeof f.line === 'number' && f.line > 0)).toBe(true);
  });

  it('T9: a rejected construct yields no clause at all rather than a half-parsed one', () => {
    const { clause, findings } = parse(clauseFile({ extraFrontmatter: 'supersedes:\n  - old\n' }));
    expect(clause).toBeNull();
    expect(hasErrors(findings)).toBe(true);
  });
});

// --------------------------------------------------------------------------- required fields

describe('parseLearnedClause — required fields', () => {
  it('parses a complete clause, reusing parseBottomLine for the body', () => {
    const { clause, findings } = parse(clauseFile());
    expect(errors(findings)).toEqual([]);
    expect(clause?.id).toBe('no-force-push');
    expect(clause?.status).toBe('accepted');
    expect(clause?.level).toBe('red');
    expect(clause?.evidence).toBe('EXTRACTED');
    expect(clause?.support).toBe(47);
    expect(clause?.learnedFrom.decisions).toEqual(['d-8f21e0', 'd-8f2244']);
    // The body went through the existing loader, unchanged.
    expect(clause?.entry.kind).toBe('intention');
    expect(clause?.entry.title).toBe('Never force-push to a shared branch');
    expect(clause?.entry.text).toContain('Match: `git push --force`');
    expect(clause?.tier).toBe('team');
  });

  // T10. One test per required field; each error names the field *and* the file.
  it.each([
    ['id', /^id: .*\n/m, 'missing `id`'],
    ['status', /^status: .*\n/m, 'missing `status`'],
    ['evidence (with learned_from sources)', /^evidence: .*\n/m, 'missing `evidence`'],
  ])('T10: a missing %s is an error naming the field and the file', (_field, strip, needle) => {
    const { findings } = parse(clauseFile().replace(strip, ''));
    const errs = findings.filter(f => f.severity === 'error');
    expect(errs.some(f => f.message.includes(needle))).toBe(true);
    expect(errs.every(f => f.file.endsWith('learned/no-force-push.md'))).toBe(true);
  });

  it('T10: a missing status leaves the clause inert rather than shipping it', () => {
    const { clause } = parse(clauseFile().replace(/^status: .*\n/m, ''));
    expect(clause?.status).toBe('proposed');
    expect(isEnforceable(clause!.status)).toBe(false);
  });

  it('requires `evidence` when `learned_from` names sources', () => {
    const { findings } = parse(clauseFile().replace(/^evidence: .*\n/m, ''));
    expect(errors(findings).join()).toContain('missing `evidence`');
  });

  it('rejects `evidence` when `learned_from` is empty — there is no extraction to describe', () => {
    const { findings } = parse(clauseFile({ learnedFrom: '  sessions: []\n  decisions: []' }));
    expect(errors(findings).join()).toContain('with no `learned_from` sources');
  });

  it('a hand-parked clause with neither is clean, and evidence stays null', () => {
    const { clause, findings } = parse(parkedClause());
    expect(errors(findings)).toEqual([]);
    expect(clause?.evidence).toBeNull();
  });

  it('requires evidence when only sessions, or only decisions, are named', () => {
    for (const learnedFrom of ['  sessions: [20260812_a-b-c1d2e3f4]\n  decisions: []',
      '  sessions: []\n  decisions: [d-8f21e0]']) {
      const text = clauseFile({ learnedFrom }).replace(/^evidence: .*\n/m, '');
      expect(errors(parse(text).findings).join(), learnedFrom).toContain('missing `evidence`');
    }
  });

  it('rejects an unknown status, level and evidence by name', () => {
    expect(errors(parse(clauseFile({ status: 'live' })).findings).join()).toContain('unknown `status: live`');
    expect(errors(parse(clauseFile({ level: 'PURPLE' })).findings).join()).toContain('unknown `level: purple`');
    expect(errors(parse(clauseFile({ evidence: 'GUESSED' })).findings).join()).toContain('unknown `evidence:');
  });

  it('normalizes an unknown level to null so it can never decide', () => {
    // The review's `level: PURPLE` finding: today it is passed through and silently unenforced.
    // Here it still normalizes to null — but loudly.
    const { clause } = parse(clauseFile({ level: 'PURPLE' }));
    expect(clause?.level).toBeNull();
  });

  it('rejects a scalar key given as an inline list, rather than silently dropping it', () => {
    // `status: [accepted]` is valid frontmatter syntax (an inline list), so `scalar('status')`
    // reads it as absent and the field is lost with no finding at all — the opposite of this
    // module's fail-loud goal.
    const { clause, findings } = parse(clauseFile({ extraFrontmatter: 'status: [accepted]\n' })
      .replace(/^status: .*\n/m, ''));
    expect(clause?.status).toBe('proposed'); // the inert default: never the one that ships
    expect(errors(findings).join()).toContain('`status` must be a scalar');
  });

  it('rejects a list key given as a scalar, rather than silently dropping it', () => {
    // `supersedes: old` is a valid scalar line, so `list('supersedes')` reads it as absent and
    // the supersession is lost with no finding at all.
    const { clause, findings } = parse(clauseFile({ extraFrontmatter: 'supersedes: old-id\n' }));
    expect(clause?.supersedes).toEqual([]);
    expect(errors(findings).join()).toContain('`supersedes` must be an inline list');
  });

  it('rejects orange and yellow: the ladder only has red/green rungs for a learned clause', () => {
    // `orange`/`yellow` are recognised level words (a human bottom-line.md clause can use all
    // four), but `decideByLadder` can only return red or green — so an `accepted` learned clause
    // at `orange`/`yellow` would match and then never be selected: inert, but not visibly so.
    for (const level of ['orange', 'yellow']) {
      const { clause, findings } = parse(clauseFile({ level }));
      expect(clause?.level, level).toBeNull();
      expect(errors(findings).join(), level).toContain('not enforceable');
    }
  });

  it('accepts a prose-only clause with no level', () => {
    const { clause, findings } = parse(clauseFile().replace(/^level: .*\n/m, ''));
    expect(errors(findings)).toEqual([]);
    expect(clause?.level).toBeNull();
  });

  it('requires the id to equal the filename, so the citation and the path cannot disagree', () => {
    const { findings } = parse(clauseFile({ id: 'something-else' }));
    expect(errors(findings).join()).toContain('disagrees with the filename');
  });

  it('errors when the body has no heading, because there is then no clause', () => {
    const text = clauseFile().replace(/^### Intention:.*$/m, 'just prose, no heading');
    const { clause, findings } = parse(text);
    expect(clause).toBeNull();
    expect(errors(findings).join()).toContain('no clause body');
  });

  it('errors on two entries in one file — a learned clause is one clause per file', () => {
    const text = clauseFile() + `\n### Belief: A second entry\n\n${RATIONALE}\n`;
    expect(errors(parse(text).findings).join()).toContain('one clause per file');
  });

  it('rejects a non-numeric support count', () => {
    const text = clauseFile().replace('support: 47', 'support: many');
    expect(errors(parse(text).findings).join()).toContain('not a whole number');
  });

  it('rejects a malformed ISO date', () => {
    const text = clauseFile().replace('learned_at: 2026-08-30', 'learned_at: last Tuesday');
    expect(errors(parse(text).findings).join()).toContain('not an ISO date');
  });

  // T11.
  it('T11: fix_from without fix_to is an error, and vice versa', () => {
    expect(errors(parse(clauseFile({ extraFrontmatter: 'fix_from: --force\n' })).findings).join())
      .toContain('both-or-neither');
    expect(errors(parse(clauseFile({ extraFrontmatter: 'fix_to: --force-with-lease\n' })).findings).join())
      .toContain('both-or-neither');
    const both = parse(clauseFile({ extraFrontmatter: 'fix_from: --force\nfix_to: --force-with-lease\n' }));
    expect(errors(both.findings)).toEqual([]);
    expect(both.clause?.fix).toEqual({ from: '--force', to: '--force-with-lease' });
  });

  // T8.
  it('T8: an unknown field is preserved in `extra`, not dropped, and gets a did-you-mean', () => {
    const { clause, findings } = parse(clauseFile({
      extraFrontmatter: 'bogusfield: kept verbatim\nlevle: red\nexpries: 2027-01-01\n',
    }));
    expect(clause?.extra.bogusfield).toBe('kept verbatim');
    expect(clause?.extra.levle).toBe('red');
    const warns = findings.filter(f => f.severity === 'warn').map(f => f.message);
    expect(warns.some(m => m.includes('`levle`') && m.includes('did you mean `level`'))).toBe(true);
    expect(warns.some(m => m.includes('`expries`') && m.includes('did you mean `expires`'))).toBe(true);
    // No suggestion is offered where there is nothing plausible to suggest.
    expect(warns.some(m => m.includes('`bogusfield`') && !m.includes('did you mean'))).toBe(true);
  });

  it('preserves an unknown inline list in `extra` too', () => {
    const { clause } = parse(clauseFile({ extraFrontmatter: 'reviewers: [alice, bob]\n' }));
    expect(clause?.extra.reviewers).toBe('[alice, bob]');
  });

  it('warns when the contradictions count is absent, because absent reads as the optimistic 0', () => {
    const { clause, findings } = parse(clauseFile().replace(/^contradictions: .*\n/m, ''));
    expect(clause?.contradictions).toBe(0);
    expect(findings.some(f => f.severity === 'warn' && f.message.includes('contradictions'))).toBe(true);
  });
});

// --------------------------------------------------------------------------- origin

describe('origin comes from the path', () => {
  // T5.
  it('T5: `origin: human` in a learned file cannot forge authorship', () => {
    const { clause, findings } = parse(clauseFile({ extraFrontmatter: 'origin: human\n' }));
    expect(clause?.origin).toBe('learned');
    expect(clause?.extra.origin).toBe('human');
    const errs = errors(findings);
    expect(errs.some(m => m.includes('`origin` is not a field'))).toBe(true);
  });

  it('T5: a clause read from `learned/` is `learned` whatever it says about itself', () => {
    const root = corpusWith({ 'no-force-push.md': clauseFile() });
    const { clauses } = readLearnedDir(root, 'team', TEAM);
    expect(clauses.map(c => c.origin)).toEqual(['learned']);
  });
});

// --------------------------------------------------------------------------- rationale

describe('the rationale is mandatory under learned/ (§2.5)', () => {
  const eighty = 'x'.repeat(RATIONALE_MIN_CHARS);

  // T37.
  it.each([
    ['an empty body', ''],
    ['a whitespace-only body', '   \n\n  \t\n'],
    ['a body that is only a Match: line', 'Match: `git push --force`'],
    ['a body one character under the floor', 'y'.repeat(RATIONALE_MIN_CHARS - 1)],
  ])('T37: %s is an error', (_name, body) => {
    const { findings } = parse(clauseFile({ body }));
    expect(errors(findings).join()).toContain('no rationale');
  });

  it(`T37: a body of exactly ${RATIONALE_MIN_CHARS} characters passes — the boundary, asserted`, () => {
    const { clause, findings } = parse(clauseFile({ body: eighty }));
    expect(errors(findings)).toEqual([]);
    expect(clause?.rationale).toBe(eighty);
  });

  it('T37: `Match:` lines and the title do not count toward the floor', () => {
    // A body whose only prose is a Match: line plus a title-length string still fails.
    const { findings } = parse(clauseFile({
      title: 'A very long title that on its own would clear the eighty character floor easily',
      body: 'Match: `git push --force`\nMatch: `git push -f`\nshort.',
    }));
    expect(errors(findings).join()).toContain('no rationale');
  });

  // T39.
  it('T39: the rationale check does not key on learned_from — hand-parked with no rationale fails', () => {
    const { findings } = parse(parkedClause({ body: '' }));
    expect(errors(findings).join()).toContain('no rationale');
  });

  it('T39: hand-parked *with* a rationale parses, and produces exactly one info', () => {
    const { clause, findings } = parse(parkedClause());
    expect(errors(findings)).toEqual([]);
    const infos = findings.filter(f => f.severity === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0].message).toContain('belongs in `bottom-line.md`');
    expect(clause?.origin).toBe('learned');
  });

  it('does not emit the parking info when there is evidence', () => {
    const { findings } = parse(clauseFile());
    expect(findings.filter(f => f.severity === 'info')).toEqual([]);
  });
});

// --------------------------------------------------------------------------- retirement

describe('retirement is a state (§4.4)', () => {
  const retired = (reason: string | null, by: string | null): string => clauseFile({
    status: 'retired',
    extraFrontmatter: 'retired_at: 2026-11-14\n'
      + (reason === null ? '' : `retired_reason: ${reason}\n`)
      + (by === null ? '' : `retired_by: ${by}\n`),
  });

  // T40.
  it('T40: `status: retired` with no `retired_reason` is an error', () => {
    expect(errors(parse(retired(null, null)).findings).join()).toContain('requires `retired_reason`');
  });

  it.each([['ablation'], ['displacement']])(
    'T40: `retired_reason: %s` with no `retired_by` is an error', reason => {
      expect(errors(parse(retired(reason, null)).findings).join()).toContain('requires `retired_by`');
    });

  it('T40: `retired_reason: manual` with no `retired_by` passes', () => {
    const { clause, findings } = parse(retired('manual', null));
    expect(errors(findings)).toEqual([]);
    expect(clause?.retiredReason).toBe('manual');
    expect(clause?.retiredBy).toBeNull();
  });

  it('T40: `retired_reason: ablation` with a run id passes and carries it', () => {
    const { clause, findings } = parse(retired('ablation', 'abl-2026-11-14-7c3f'));
    expect(errors(findings)).toEqual([]);
    expect(clause?.retiredBy).toBe('abl-2026-11-14-7c3f');
    expect(clause?.retiredAt).toBe('2026-11-14');
  });

  it('rejects an unknown retired_reason by name', () => {
    expect(errors(parse(retired('boredom', 'x')).findings).join()).toContain('unknown `retired_reason: boredom`');
  });

  it('rejects retirement fields on a clause that is not retired', () => {
    const text = clauseFile({ extraFrontmatter: 'retired_reason: manual\n' });
    expect(errors(parse(text).findings).join()).toContain('`status` is `accepted`');
  });

  it('records `displaces` separately from `supersedes` — an eviction is not an improvement', () => {
    const { clause } = parse(clauseFile({
      extraFrontmatter: 'supersedes: [ask-before-force-push]\ndisplaces: [unrelated-clause]\n',
    }));
    expect(clause?.supersedes).toEqual(['ask-before-force-push']);
    expect(clause?.displaces).toEqual(['unrelated-clause']);
  });

  // T43's loader half: a retired clause still loads, body intact. The `policy retire` command that
  // writes the state change is des-governance's, so only the read side is asserted here.
  it('T43 (loader half): a retired clause still loads with its body byte-identical', () => {
    const text = retired('manual', null);
    const { clause } = parse(text);
    expect(clause?.rationale).toBe(RATIONALE.trim());
    expect(clause?.status).toBe('retired');
  });
});

// --------------------------------------------------------------------------- the walk

describe('the learned/ walk', () => {
  it('reads zero clauses from an absent learned/ directory, and reports nothing', () => {
    fs.mkdirSync(path.join(tmp, 'data', 'knowledge', 'teams', TEAM), { recursive: true });
    const result = readLearnedDir(tmp, 'team', TEAM);
    expect(result.clauses).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.exists).toBe(false);
  });

  it('reads zero clauses from a corpus with no data/knowledge at all', () => {
    expect(readLearnedDir(tmp, 'team', TEAM).clauses).toEqual([]);
  });

  it('reports an error, not a silent skip, when learned/ exists but is not readable', () => {
    // A permission error or an IO error must not degrade into an empty policy — the same rule
    // `readLearnedDir` already applies to an individual unreadable file. Only ENOENT (the
    // directory is genuinely absent) is a non-error.
    const learned = path.join(tmp, ...learnedDir('team', TEAM).split('/'));
    fs.mkdirSync(learned, { recursive: true });
    fs.writeFileSync(path.join(learned, 'x.md'), clauseFile({ id: 'x' }), 'utf8');
    fs.chmodSync(learned, 0o000);
    try {
      const result = readLearnedDir(tmp, 'team', TEAM);
      expect(result.clauses).toEqual([]);
      expect(hasErrors(result.findings)).toBe(true);
      expect(result.findings[0].message).toContain('unreadable');
    } finally {
      fs.chmodSync(learned, 0o755);
    }
  });

  it('reads zero clauses when learned/ is a file, not a directory, and reports an error', () => {
    fs.mkdirSync(path.join(tmp, 'data', 'knowledge', 'teams', TEAM), { recursive: true });
    fs.writeFileSync(path.join(tmp, ...learnedDir('team', TEAM).split('/')), 'not a directory', 'utf8');
    const result = readLearnedDir(tmp, 'team', TEAM);
    expect(result.clauses).toEqual([]);
    expect(hasErrors(result.findings)).toBe(true);
  });

  it('reads zero clauses for an unconfigured tier, without touching the filesystem', () => {
    expect(readLearnedDir(tmp, 'project', '').clauses).toEqual([]);
  });

  it('walks in sorted order, so the result is deterministic', () => {
    const root = corpusWith({
      'zulu.md': clauseFile({ id: 'zulu' }),
      'alpha.md': clauseFile({ id: 'alpha' }),
      'mike.md': clauseFile({ id: 'mike' }),
      'notes.txt': 'not markdown, not read',
    });
    expect(readLearnedDir(root, 'team', TEAM).clauses.map(c => c.id)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('records the repo-relative source path on each clause', () => {
    const root = corpusWith({ 'no-force-push.md': clauseFile() });
    expect(readLearnedDir(root, 'team', TEAM).clauses[0].sourceFile)
      .toBe(`data/knowledge/teams/${TEAM}/learned/no-force-push.md`);
  });

  it('loads all three tiers from their own directories', () => {
    corpusWith({ 'team-rule.md': clauseFile({ id: 'team-rule' }) }, 'team', TEAM);
    corpusWith({ 'proj-rule.md': clauseFile({ id: 'proj-rule' }) }, 'project', 'demo-project');
    corpusWith({ 'user-rule.md': clauseFile({ id: 'user-rule' }) }, 'user', 'alice');
    expect(readLearnedDir(tmp, 'team', TEAM).clauses.map(c => c.id)).toEqual(['team-rule']);
    expect(readLearnedDir(tmp, 'project', 'demo-project').clauses.map(c => c.tier)).toEqual(['project']);
    expect(readLearnedDir(tmp, 'user', 'alice').clauses.map(c => c.tier)).toEqual(['user']);
  });

  it('collects findings across every file rather than stopping at the first', () => {
    const root = corpusWith({
      'good.md': clauseFile({ id: 'good' }),
      'bad-one.md': clauseFile({ id: 'bad-one', body: '' }),
      'bad-two.md': clauseFile({ id: 'bad-two', status: 'live' }),
    });
    const { findings } = readLearnedDir(root, 'team', TEAM);
    const files = new Set(findings.filter(f => f.severity === 'error').map(f => path.posix.basename(f.file)));
    expect([...files].sort()).toEqual(['bad-one.md', 'bad-two.md']);
  });

  it('skips a malformed file and keeps every other clause in the tier', () => {
    // Failing the whole tier would remove the other reds too, which is worse than losing the
    // broken file. The compile is what refuses to emit an artifact while an error stands.
    const root = corpusWith({
      'good.md': clauseFile({ id: 'good' }),
      'also-good.md': clauseFile({ id: 'also-good' }),
      'broken.md': clauseFile({ id: 'broken', body: '' }),
      'unparseable.md': 'no frontmatter here\n',
    });
    const { clauses, findings } = readLearnedDir(root, 'team', TEAM);
    expect(clauses.map(c => c.id)).toEqual(['also-good', 'good']);
    for (const bad of ['broken.md', 'unparseable.md']) {
      expect(findings.some(f => f.severity === 'error' && f.file.endsWith(bad)), bad).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------- status semantics

describe('status semantics', () => {
  it('only `accepted` is enforceable', () => {
    expect(isEnforceable('accepted')).toBe(true);
    for (const s of ['proposed', 'audit', 'declined', 'superseded', 'retired'] as const) {
      expect(isEnforceable(s)).toBe(false);
    }
  });

  it('`accepted` and `audit` are matched; nothing else is', () => {
    expect(isMatched('accepted')).toBe(true);
    expect(isMatched('audit')).toBe(true);
    for (const s of ['proposed', 'declined', 'superseded', 'retired'] as const) {
      expect(isMatched(s)).toBe(false);
    }
  });

  it('only `accepted` is rendered into a prompt — audit deliberately is not', () => {
    expect(rendersIntoPrompt('accepted')).toBe(true);
    // A clause the model can read influences the outcome, which is the opposite of audit.
    expect(rendersIntoPrompt('audit')).toBe(false);
    for (const s of ['proposed', 'declined', 'superseded', 'retired'] as const) {
      expect(rendersIntoPrompt(s)).toBe(false);
    }
  });

  // T50. The vocabulary drifted apart across three design documents once already; this pins it.
  it('T50: the enum is exactly six values, and `rejected`/`deprecated` are not among them', () => {
    expect([...CLAUSE_STATUSES]).toEqual(
      ['proposed', 'audit', 'accepted', 'declined', 'superseded', 'retired']);
    for (const dropped of ['rejected', 'deprecated']) {
      expect(CLAUSE_STATUSES).not.toContain(dropped);
      // and the loader refuses them rather than quietly accepting an old spelling
      expect(errors(parse(clauseFile({ status: dropped })).findings).join())
        .toContain(`unknown \`status: ${dropped}\``);
    }
  });

  it('a human disarming a red is `retired` + `retired_reason: manual`, not a second enum value', () => {
    const { clause, findings } = parse(clauseFile({
      status: 'retired', extraFrontmatter: 'retired_at: 2026-11-14\nretired_reason: manual\n',
    }));
    expect(errors(findings)).toEqual([]);
    expect(clause?.status).toBe('retired');
    expect(isEnforceable(clause!.status)).toBe(false);
  });
});

// --------------------------------------------------------------------------- the ladder

describe('the four-rung precedence ladder (§3.3)', () => {
  const clause = (
    id: string, origin: 'human' | 'learned', level: 'red' | 'green' | null,
    tier = 'team', status = 'accepted',
  ): LadderClause => ({ id, origin, tier, level, status: status as LadderClause['status'] });

  /** Everything matches — so only the ladder order decides which clause wins. */
  const all = () => true;

  // T3.
  it('T3: a learned red never overrides a human green', () => {
    const hit = decideByLadder(
      [clause('learned-npm', 'learned', 'red'), clause('human-npm-test', 'human', 'green')], all);
    expect(hit?.level).toBe('green');
    expect(hit?.clause.id).toBe('human-npm-test');
  });

  // T4.
  it('T4: a learned green never overrides a human red', () => {
    const hit = decideByLadder(
      [clause('learned-npm', 'learned', 'green'), clause('human-npm', 'human', 'red')], all);
    expect(hit?.level).toBe('red');
    expect(hit?.clause.id).toBe('human-npm');
  });

  // T5a.
  it('T5a: a learned red beats a learned green', () => {
    const hit = decideByLadder(
      [clause('learned-green', 'learned', 'green'), clause('learned-red', 'learned', 'red')], all);
    expect(hit?.clause.id).toBe('learned-red');
  });

  // T6.
  it('T6: within one origin, safety still wins — a team red beats a user green', () => {
    const hit = decideByLadder(
      [clause('user-green', 'human', 'green', 'user'), clause('team-red', 'human', 'red', 'team')], all);
    expect(hit?.clause.id).toBe('team-red');
  });

  it('orders narrower tier first within a rung', () => {
    const hit = decideByLadder([
      clause('team-red', 'human', 'red', 'team'),
      clause('user-red', 'human', 'red', 'user'),
      clause('project-red', 'human', 'red', 'project'),
    ], all);
    expect(hit?.clause.id).toBe('user-red');
  });

  // T5b's loader half: rung 5's built-in destructive-action table is the engine's, not this
  // module's, so only the "learned red still fires" half is asserted here.
  it('T5b: a learned red still fires where no human clause covers the call', () => {
    const hit = decideByLadder([clause('learned-red', 'learned', 'red')], all);
    expect(hit?.level).toBe('red');
    expect(hit?.clause.origin).toBe('learned');
  });

  it('T5b: a human clause that does not match does not shield the call from a learned red', () => {
    const hit = decideByLadder(
      [clause('human-green', 'human', 'green'), clause('learned-red', 'learned', 'red')],
      c => c.origin === 'learned');
    expect(hit?.clause.id).toBe('learned-red');
  });

  // T1 / T2 / T41.
  it.each([['proposed'], ['declined'], ['superseded'], ['retired']])(
    'T1/T2/T41: a `%s` clause never affects a decision', status => {
      const proposal = clause('would-deny-everything', 'human', 'red', 'user', status);
      // The verdict is identical with and without it.
      expect(decideByLadder([proposal], all)).toBeNull();
      const withGreen = [clause('human-green', 'human', 'green'), proposal];
      expect(decideByLadder(withGreen, all)?.clause.id).toBe('human-green');
    });

  it('an `audit` clause never affects a decision either', () => {
    const trial = clause('trial-red', 'learned', 'red', 'team', 'audit');
    expect(decideByLadder([trial], all)).toBeNull();
  });

  it('but an audit clause that matched is recorded as a would-be verdict', () => {
    const trial = clause('trial-red', 'learned', 'red', 'team', 'audit');
    const verdicts = auditVerdicts([trial, clause('live', 'human', 'green')], all);
    expect(verdicts).toEqual([{ clause: trial, wouldBeLevel: 'red' }]);
  });

  it('records nothing for an audit clause that did not match', () => {
    const trial = clause('trial-red', 'learned', 'red', 'team', 'audit');
    expect(auditVerdicts([trial], () => false)).toEqual([]);
  });

  it('a prose-only clause never decides on its own', () => {
    expect(decideByLadder([clause('prose', 'human', null)], all)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(decideByLadder([clause('red', 'human', 'red')], () => false)).toBeNull();
  });

  // T7.
  it('T7: the ladder order is total — a stable winner across 1,000 shuffles', () => {
    const clauses = [
      clause('bbb', 'human', 'red', 'team'),
      clause('aaa', 'human', 'red', 'team'),
      clause('ccc', 'human', 'red', 'team'),
    ];
    const winners = new Set<string>();
    const orders = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const shuffled = [...clauses].sort(() => Math.random() - 0.5);
      winners.add(decideByLadder(shuffled, all)!.clause.id);
      orders.add(sortByLadder(shuffled).map(c => c.id).join(','));
    }
    // Two clauses identical but for their id have one documented winner: the lower id.
    expect([...winners]).toEqual(['aaa']);
    expect([...orders]).toEqual(['aaa,bbb,ccc']);
  });

  it('T7: the order is total across origin, level, tier and id together', () => {
    const clauses = [
      clause('z-learned-green-team', 'learned', 'green', 'team'),
      clause('a-learned-red-team', 'learned', 'red', 'team'),
      clause('m-human-green-user', 'human', 'green', 'user'),
      clause('b-human-green-team', 'human', 'green', 'team'),
      clause('c-human-red-project', 'human', 'red', 'project'),
    ];
    const orders = new Set<string>();
    for (let i = 0; i < 100; i++) {
      orders.add(sortByLadder([...clauses].sort(() => Math.random() - 0.5)).map(c => c.id).join('|'));
    }
    expect([...orders]).toEqual([
      'c-human-red-project|m-human-green-user|b-human-green-team|a-learned-red-team|z-learned-green-team',
    ]);
  });

  it('compareLadder is a consistent comparator (antisymmetric, reflexive on equals)', () => {
    const a = clause('a', 'human', 'red');
    const b = clause('b', 'learned', 'green', 'user');
    expect(compareLadder(a, a)).toBe(0);
    expect(Math.sign(compareLadder(a, b))).toBe(-Math.sign(compareLadder(b, a)));
  });
});

// --------------------------------------------------------------------------- the write boundary

describe('the write boundary (§3.3.2)', () => {
  const ID = 'no-force-push';

  it('learnedClausePath is the path, for every tier', () => {
    expect(learnedClausePath('team', TEAM, ID)).toBe(`data/knowledge/teams/${TEAM}/learned/${ID}.md`);
    expect(learnedClausePath('project', 'demo-project', ID))
      .toBe(`data/knowledge/projects/demo-project/learned/${ID}.md`);
    expect(learnedClausePath('user', 'alice', ID)).toBe(`data/knowledge/users/alice/learned/${ID}.md`);
  });

  it('refuses to build a path from an id that carries path syntax', () => {
    for (const bad of ['../escape', 'a/b', '..', '.hidden/../x', '']) {
      expect(() => learnedClausePath('team', TEAM, bad)).toThrow(/unsafe clause id/);
    }
  });

  it('accepts the path it produces', () => {
    fs.mkdirSync(path.join(tmp, ...learnedDir('team', TEAM).split('/')), { recursive: true });
    const target = path.join(tmp, ...learnedClausePath('team', TEAM, ID).split('/'));
    expect(() => assertWritable(tmp, target, ID)).not.toThrow();
  });

  /** Every file under the corpus root, so a refusal can be shown to have written nothing. */
  function snapshot(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) { out.push(`${full}->${fs.readlinkSync(full)}`); } else if (e.isDirectory()) {
          walk(full);
        } else { out.push(`${full}:${fs.readFileSync(full, 'utf8')}`); }
      }
    };
    walk(root);
    return out;
  }

  /**
   * The guard is what a writer calls *before* writing, so "wrote nothing" is asserted by taking a
   * full snapshot of the corpus, running a write that is guarded exactly as the pipeline must guard
   * it, and comparing. A guard that threw after the write would fail this.
   */
  function guardedWrite(root: string, target: string, id: string): void {
    assertWritable(root, target, id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, clauseFile({ id }), 'utf8');
  }

  // T34.
  it('T34: rejects each of the five losses, and writes nothing', () => {
    const root = corpusWith({ 'existing.md': clauseFile({ id: 'existing' }) });
    fs.writeFileSync(path.join(root, 'data', 'knowledge', 'teams', TEAM, 'bottom-line.md'), '# human lane\n');

    // A `learned/` that is a symlink to a directory outside the corpus root.
    const outside = fs.mkdtempSync(path.join(tmp, '..', 'learned-outside-'));
    fs.mkdirSync(path.join(root, 'data', 'knowledge', 'teams', 'escaped'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'data', 'knowledge', 'teams', 'escaped', 'learned'));
    const otherRoot = fs.mkdtempSync(path.join(tmp, '..', 'other-corpus-'));

    const cases: [string, string, string][] = [
      [
        'a bottom-line.md target',
        path.join(root, 'data', 'knowledge', 'teams', TEAM, 'bottom-line.md'), ID,
      ],
      [
        'a filename that is not <id>.md',
        path.join(root, ...learnedDir('team', TEAM).split('/'), 'other-name.md'), ID,
      ],
      [
        'a `..` traversal out of learned/',
        path.join(root, ...learnedDir('team', TEAM).split('/'), '..', '..', `${ID}.md`), ID,
      ],
      [
        'a learned/ symlinked outside the corpus root',
        path.join(root, 'data', 'knowledge', 'teams', 'escaped', 'learned', `${ID}.md`), ID,
      ],
      [
        'a corpus root other than the configured one',
        path.join(otherRoot, ...learnedClausePath('team', TEAM, ID).split('/')), ID,
      ],
    ];

    try {
      for (const [name, target, id] of cases) {
        const before = snapshot(root);
        const existed = fs.existsSync(target);
        expect(() => guardedWrite(root, target, id), name).toThrow(/refusing to write/);
        expect(snapshot(root), `${name} wrote something`).toEqual(before);
        expect(fs.existsSync(target), `${name} changed its target's existence`).toBe(existed);
      }
      // The other corpus root is untouched too — a refusal writes nothing *anywhere*.
      expect(fs.readdirSync(otherRoot)).toEqual([]);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('T34: refuses a symlink loop rather than treating it as resolved', () => {
    // A `learned/` that is a symlink to itself: `fs.realpathSync` throws ELOOP for it (caught,
    // same as any other unresolvable path), and the manual chase that steps in afterwards would
    // otherwise recurse forever following the link back to itself. `depth > 8` is the guard —
    // before the fix it gave up and returned the *unresolved* path, which `assertWritable` then
    // treated as trustworthy; it must refuse instead.
    // The corpus root itself is resolved (`fs.realpathSync`), matching how a caller normally hands
    // it in — otherwise a platform where the tmp dir is itself reached through a symlink (macOS:
    // /tmp -> /private/tmp) makes the *old*, buggy code refuse for an unrelated string-mismatch
    // reason, masking the loop it never actually detected.
    const root = fs.realpathSync(corpusWith({ 'existing.md': clauseFile({ id: 'existing' }) }));
    const learned = path.join(root, ...learnedDir('team', TEAM).split('/'));
    fs.rmSync(learned, { recursive: true, force: true });
    fs.symlinkSync(learned, learned); // points to itself
    const target = path.join(learned, `${ID}.md`);
    try {
      const before = snapshot(root);
      expect(() => guardedWrite(root, target, ID)).toThrow(/symlink loop/);
      expect(snapshot(root)).toEqual(before);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.unlinkSync(learned);
    }
  });

  it('T34: rejects a target outside data/knowledge entirely', () => {
    const root = corpusWith({ 'existing.md': clauseFile({ id: 'existing' }) });
    for (const rel of ['learned/x.md', 'data/learned/x.md', `data/knowledge/${TEAM}/learned/x.md`,
      `data/knowledge/teams/${TEAM}/x.md`, `data/knowledge/teams/${TEAM}/learned/deeper/x.md`]) {
      const before = snapshot(root);
      expect(() => guardedWrite(root, path.join(root, ...rel.split('/')), 'x'), rel)
        .toThrow(/refusing to write/);
      expect(snapshot(root)).toEqual(before);
    }
  });

  it('T34: rejects a target that is itself a symlink pointing out of the corpus', () => {
    const root = corpusWith({ 'existing.md': clauseFile({ id: 'existing' }) });
    const outside = fs.mkdtempSync(path.join(tmp, '..', 'sneak-'));
    const target = path.join(root, ...learnedClausePath('team', TEAM, ID).split('/'));
    fs.symlinkSync(path.join(outside, 'stolen.md'), target);
    try {
      expect(() => assertWritable(root, target, ID)).toThrow(/outside the configured corpus root/);
      expect(fs.existsSync(path.join(outside, 'stolen.md'))).toBe(false);
    } finally {
      fs.unlinkSync(target);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('T34: refuses an unsafe id before looking at the path at all', () => {
    expect(() => assertWritable(tmp, path.join(tmp, 'x.md'), '../escape')).toThrow(/unsafe clause id/);
  });

  it('resolves a symlinked corpus root rather than refusing it', () => {
    // A corpus reached through a symlinked path is normal (a checkout under /var → /private/var on
    // macOS, for one), so the comparison is between two *resolved* paths, not two strings.
    const root = corpusWith({ 'existing.md': clauseFile({ id: 'existing' }) });
    const link = path.join(tmp, '..', `link-${path.basename(tmp)}`);
    fs.symlinkSync(root, link);
    try {
      const target = path.join(link, ...learnedClausePath('team', TEAM, ID).split('/'));
      expect(() => assertWritable(link, target, ID)).not.toThrow();
      expect(() => assertWritable(root, target, ID)).not.toThrow();
    } finally {
      fs.unlinkSync(link);
    }
  });

  // T35. Crude on purpose, and it is the only thing that stops the invariant decaying the first
  // time somebody adds a second writer.
  it('T35: the loader module writes nothing at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../supervisor/learnedClauses.ts'), 'utf8')
      .split('\n')
      .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    for (const call of ['writeFile', 'appendFile', 'rename', 'rmSync', 'mkdir', 'unlink', 'createWriteStream']) {
      expect(src, `learnedClauses.ts must not call ${call} — writes route through the pipeline, `
        + 'which is the only thing allowed to produce a path, via learnedClausePath').not.toContain(call);
    }
  });
});

// --------------------------------------------------------------------------- hand-authored files

describe('a hand-written file under learned/ (§3.3.2)', () => {
  // T36.
  it('T36: loads as `learned`, and therefore loses to a contradicting bottom-line.md clause', () => {
    const root = corpusWith({
      'my-own-rule.md': parkedClause({ id: 'my-own-rule', level: 'red' }),
    });
    const { clauses, findings } = readLearnedDir(root, 'team', TEAM);
    expect(hasErrors(findings)).toBe(false);
    expect(clauses[0].origin).toBe('learned');

    // The precedence consequence, asserted rather than described: a human green in bottom-line.md
    // beats it, so the author has downgraded their own clause.
    const humanGreen: LadderClause = {
      id: 'human-green', origin: 'human', tier: 'team', level: 'green', status: 'accepted',
    };
    const parked: LadderClause = {
      id: clauses[0].id, origin: clauses[0].origin, tier: clauses[0].tier,
      level: clauses[0].level, status: clauses[0].status,
    };
    expect(decideByLadder([parked, humanGreen], () => true)?.clause.id).toBe('human-green');
  });

  it('T36: produces exactly one info finding, not an error', () => {
    const root = corpusWith({
      'my-own-rule.md': parkedClause({ id: 'my-own-rule' }),
    });
    const { findings } = readLearnedDir(root, 'team', TEAM);
    expect(findings.filter(f => f.severity === 'error')).toEqual([]);
    expect(findings.filter(f => f.severity === 'info')).toHaveLength(1);
    // Parking is legitimate — a reviewer who is not yet sure can deliberately give a clause the
    // lower precedence — so it can never be an error.
    expect(readLearnedDir(root, 'team', TEAM).clauses).toHaveLength(1);
  });
});
