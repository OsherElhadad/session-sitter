/**
 * Selector `v1` — what reaches the model, what is deliberately withheld, and cite-by-construction.
 *
 * Two properties dominate these tests, and both are safety properties rather than cost ones:
 *
 *  - **matching is never budgeted** — a red clause dropped by a byte budget is a silent safety
 *    failure, so the budget applies to rendering and to nothing else;
 *  - **a rendered clause is the clause on disk** — overflow drops whole clauses, never a truncated
 *    body, because a body cut mid-way can show the *why* and lose the remediation.
 *
 * Every fixture is invented.
 */

import { describe, it, expect } from 'vitest';
import {
  CompiledClause, CompiledPolicy, POLICY_SCHEMA_VERSION, SELECTOR_VERSION, renderClause, revisionOf,
} from '../../policy/compile';
import {
  SELECTION_BYTE_BUDGET,
  cite,
  clauseIndex,
  clauseMatches,
  matchingClauses,
  renderSelection,
  selectClauses,
  selectForPolicy,
} from '../../policy/select';

const TODAY = '2026-09-02';

function clause(over: Partial<CompiledClause> = {}): CompiledClause {
  const id = over.id ?? 'pay-git-001';
  return {
    id,
    citation: `practices §${id}`,
    origin: 'learned',
    tier: 'team',
    level: 'red',
    status: 'accepted',
    kind: 'intention',
    title: 'Never force-push to a shared branch',
    body: 'Rewriting history on a branch other people build on destroys their work.',
    patterns: [{ raw: 'git push --force', is_regex: false, flags: 'i' }],
    fix: null,
    weight: 0,
    expires: null,
    supersedes: [],
    source_file: `data/knowledge/teams/payments/learned/${id}.md`,
    deletable: null,
    ...over,
  };
}

function policyOf(clauses: CompiledClause[]): CompiledPolicy {
  const policy: CompiledPolicy = {
    schema_version: POLICY_SCHEMA_VERSION,
    revision: '',
    corpus_ref: 'git:1a2b3c4',
    built_at: '2026-09-02T00:00:00.000Z',
    built_from: ['data/knowledge/teams/payments/bottom-line.md'],
    selector: SELECTOR_VERSION,
    routing: { user: 'dana', project: 'ledger-api', team: 'payments' },
    prompt_core: '',
    clauses,
  };
  policy.revision = revisionOf(policy);
  return policy;
}

const HAY = 'Bash {"command":"git push --force origin main"}';

const select = (clauses: CompiledClause[], haystack = HAY, budgetBytes?: number) =>
  selectClauses(clauses, { haystack, today: TODAY, budgetBytes });

// --------------------------------------------------------------------------- what renders

describe('selector v1 — the rendered set', () => {
  it('renders a clause whose patterns actually matched', () => {
    const s = select([clause({ id: 'matched' })]);
    expect(s.selected.map(c => c.id)).toEqual(['matched']);
    expect(s.matched).toEqual(['matched']);
  });

  it('excludes a clause whose patterns were evaluated and missed', () => {
    // The classifier is rung 6, and deterministic matching runs at rungs 2-4. By the time a prompt
    // exists this clause has already been tested against this call and lost, so rendering it is
    // prose claiming to be about something its own pattern says this call is not.
    const s = select([clause({ id: 'missed', patterns: [{ raw: 'terraform apply', is_regex: false, flags: 'i' }] })]);
    expect(s.selected).toEqual([]);
    expect(s.dropped['evaluated-missed']).toBe(1);
  });

  it('renders a red with no patterns at full budget, which prices prose reds honestly', () => {
    // The exclusion is *evaluated-and-missed*, not *anything carrying a Match: field*.
    const s = select([clause({ id: 'prose-red', patterns: [] })]);
    expect(s.selected.map(c => c.id)).toEqual(['prose-red']);
  });

  it('never renders an audit clause, so a trial cannot influence the outcome', () => {
    const s = select([clause({ id: 'trial', status: 'audit' })]);
    expect(s.selected).toEqual([]);
    expect(s.dropped['not-active']).toBe(1);
  });

  it('does not repeat a clause already in the revision-stable core', () => {
    const s = selectClauses([clause({ id: 'in-core', patterns: [] })], {
      haystack: HAY, today: TODAY, coreIds: new Set(['in-core']),
    });
    expect(s.selected).toEqual([]);
    expect(s.dropped['in-core']).toBe(1);
  });
});

// --------------------------------------------------------------------------- matching is not budgeted

describe('matching is never budgeted', () => {
  it('matches every compiled clause regardless of any rendering budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => clause({
      id: `pay-noise-${i}`,
      patterns: [{ raw: `noise-${i}`, is_regex: false, flags: 'i' }],
    }));
    const hidden = clause({ id: 'the-red-one' });
    // A byte budget so small that nothing renders at all.
    const s = select([...many, hidden], HAY, 1);
    expect(s.selected).toEqual([]);
    expect(matchingClauses([...many, hidden], HAY).map(c => c.id)).toEqual(['the-red-one']);
  });

  it('matches audit clauses too, which is the whole point of a trial', () => {
    const trial = clause({ id: 'trial', status: 'audit' });
    expect(matchingClauses([trial], HAY).map(c => c.id)).toEqual(['trial']);
  });

  it('does not match a proposed clause', () => {
    expect(matchingClauses([clause({ status: 'proposed' })], HAY)).toEqual([]);
  });

  it('matches a regex pattern as written', () => {
    const re = clause({ patterns: [{ raw: '/git\\s+push\\s+--force/', is_regex: true, flags: 'i' }] });
    expect(clauseMatches(re, HAY)).toBe(true);
    expect(clauseMatches(re, 'Bash {"command":"git status"}')).toBe(false);
  });
});

// --------------------------------------------------------------------------- expiry

describe('expiry prunes the prompt and never disarms a block', () => {
  it('keeps an expired red out of the prompt and names it, without dropping it from evaluation', () => {
    const expired = clause({ id: 'stale-red', expires: '2026-01-01', patterns: [] });
    const s = select([expired]);
    expect(s.selected).toEqual([]);
    expect(s.expiredSafety).toEqual(['stale-red']);
    expect(s.dropped['expired-safety']).toBe(1);
    // Still matchable: a red requires a human act to disarm, not the passage of time.
    expect(matchingClauses([clause({ id: 'stale-red', expires: '2026-01-01' })], HAY))
      .toHaveLength(1);
  });

  it('drops an expired yellow or green entirely — that direction is the safe one', () => {
    const s = select([clause({ id: 'stale-green', level: 'green', expires: '2026-01-01', patterns: [] })]);
    expect(s.selected).toEqual([]);
    expect(s.expiredSafety).toEqual([]);
    expect(s.dropped.expired).toBe(1);
  });

  it('reads the date it is given, not a clock, so a replay selects what it selected then', () => {
    const c = clause({ id: 'sunset', level: 'yellow', expires: '2026-06-01', patterns: [] });
    expect(selectClauses([c], { haystack: HAY, today: '2026-05-31' }).selected).toHaveLength(1);
    expect(selectClauses([c], { haystack: HAY, today: '2026-06-02' }).selected).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------- order and determinism

describe('the fill order is total', () => {
  const patternless = (over: Partial<CompiledClause>) => clause({ patterns: [], ...over });

  it('orders by tier, then frozen weight, then id', () => {
    const s = select([
      patternless({ id: 'c-team-low', tier: 'team', weight: 1 }),
      patternless({ id: 'a-user', tier: 'user', weight: 0 }),
      patternless({ id: 'b-team-high', tier: 'team', weight: 90 }),
      patternless({ id: 'a-project', tier: 'project', weight: 0 }),
    ]);
    expect(s.selected.map(c => c.id))
      .toEqual(['a-user', 'a-project', 'b-team-high', 'c-team-low']);
  });

  it('puts matched clauses before the patternless fill', () => {
    const s = select([patternless({ id: 'zz-prose' }), clause({ id: 'aa-matched' })]);
    expect(s.selected.map(c => c.id)).toEqual(['aa-matched', 'zz-prose']);
  });

  it('is a pure function of its inputs, whatever order the clauses arrive in', () => {
    const clauses = Array.from({ length: 12 }, (_, i) => patternless({
      id: `pay-fill-${String(i).padStart(2, '0')}`, weight: i % 4, tier: ['team', 'project', 'user'][i % 3],
    }));
    const forward = select(clauses).selected.map(c => c.id);
    const backward = select([...clauses].reverse()).selected.map(c => c.id);
    expect(backward).toEqual(forward);
  });
});

// --------------------------------------------------------------------------- overflow

describe('overflow drops whole clauses', () => {
  const long = (id: string) => clause({
    id, patterns: [],
    body: `${id} `.repeat(60),
  });

  it('never truncates a body: a rendered clause is the clause on disk', () => {
    const clauses = Array.from({ length: 40 }, (_, i) => long(`pay-long-${String(i).padStart(2, '0')}`));
    const s = select(clauses);
    expect(s.dropped.budget).toBeGreaterThan(0);
    for (const rendered of s.selected) {
      const onDisk = clauses.find(c => c.id === rendered.id);
      expect(rendered.body).toBe(onDisk?.body);
    }
    expect(renderSelection(s).length).toBeLessThan(SELECTION_BYTE_BUDGET + 200);
  });

  it('drops everything after the first clause that does not fit, so length cannot reorder the set', () => {
    const s = select([long('pay-big-1'), clause({ id: 'pay-tiny', patterns: [] }), long('pay-big-2')],
      HAY, Buffer.byteLength(renderClause(long('pay-big-1')), 'utf8') + 1);
    expect(s.selected.map(c => c.id)).toEqual(['pay-big-1']);
    expect(s.dropped.budget).toBe(2);
  });
});

// --------------------------------------------------------------------------- the subset line

describe('the subset line', () => {
  it('is always emitted, naming the revision, the core count and the selected count', () => {
    const policy = policyOf([clause({ id: 'prose-red', patterns: [] }), clause({ id: 'matched' })]);
    const s = selectForPolicy(policy, { haystack: HAY, today: TODAY });
    expect(s.subsetLine).toBe(
      `(2 of 2 clauses shown — policy revision ${policy.revision.slice(7, 15)}, core 1, selected 1)`);
  });

  it('says so when clauses were withheld', () => {
    const policy = policyOf([
      clause({ id: 'matched' }),
      clause({ id: 'missed', patterns: [{ raw: 'terraform apply', is_regex: false, flags: 'i' }] }),
    ]);
    const s = selectForPolicy(policy, { haystack: HAY, today: TODAY });
    expect(s.subsetLine).toContain('1 of 2 clauses shown');
  });

  it('is the last line of the rendered block', () => {
    const policy = policyOf([clause({ id: 'matched' })]);
    const s = selectForPolicy(policy, { haystack: HAY, today: TODAY });
    const lines = renderSelection(s).split('\n');
    expect(lines[lines.length - 1]).toBe(s.subsetLine);
    expect(lines[0]).toBe('- [team] red practices §matched');
  });
});

// --------------------------------------------------------------------------- cite by construction

describe('cite-by-construction', () => {
  const policy = policyOf([clause({
    id: 'pay-git-002',
    body: 'Force-pushing rewrites history other people already pulled. Push a follow-up commit.',
    fix: { from: '--force', to: '--force-with-lease' },
  })]);
  const index = clauseIndex(policy);

  it('emits the verbatim body and fix from the artifact, never model text', () => {
    const cited = cite(policy, index, 'pay-git-002');
    expect(cited?.message).toBe(policy.clauses[0].body);
    expect(cited?.fix).toEqual({ from: '--force', to: '--force-with-lease' });
    expect(cited?.sourceFile).toBe(policy.clauses[0].source_file);
  });

  it('stamps the revision into the citation so it resolves forever', () => {
    expect(cite(policy, index, 'pay-git-002')?.citation)
      .toBe(`practices §pay-git-002@${policy.revision.slice(7, 14)}`);
  });

  it('drops an unknown id rather than printing something unverifiable', () => {
    // The light still stands elsewhere: the model's judgement is not invalidated by its bad
    // bookkeeping. What must never happen is a citation nobody can look up.
    expect(cite(policy, index, 'pay-git-999')).toBeNull();
  });
});
