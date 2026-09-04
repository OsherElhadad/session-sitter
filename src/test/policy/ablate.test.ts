/**
 * Ablation, the ceiling, and displacement — `12-validation.md` §5, invariants T21–T28 and T36–T44.
 *
 * The invariant that matters most here is negative: **T36**, that a red or an orange never becomes a
 * retirement candidate, in any window, for any evidence class. A confident-looking zero on a safety
 * clause is worse than no output, because it launders "I have no evidence" as "I have evidence of
 * nothing".
 *
 * Every fixture is invented.
 */

import { describe, it, expect } from 'vitest';
import type { DecisionRecord } from '../../audit/trail';
import type { CompiledClause } from '../../policy/compile';
import { parsePractices } from '../../policy/practices';
import { DecidedReplay, rungOf } from '../../policy/replay';
import {
  CEILING_PER_TIER,
  GREEN_PERSISTENCE_NOTE,
  Incumbent,
  RED_NOT_PROPOSED,
  YELLOW_ABLATION_BLIND,
  RED_RETIREMENT_CAVEAT,
  ablate,
  ablateAll,
  ablationWindow,
  ceilingTierOf,
  classify,
  displace,
  evictionTarget,
  firesFor,
  nearMisses,
  relaxations,
  renderedCount,
} from '../../policy/ablate';
import { coreClauses, renderCore } from '../../policy/compile';
import { selectClauses } from '../../policy/select';

// --------------------------------------------------------------------------- fixtures

const clauses = (body: string) => parsePractices(body, 'project', 'practices.md');

const entry = (id: string, level: string, match: string, title = id) =>
  `### Intention: ${title}\n\n| Field | Value |\n|---|---|\n| id | ${id} |\n`
  + `| level | ${level} |\n\nMatch: ${match}\n\nA rationale sentence for ${id}.\n`;

// `bucket-drop` matters: `aws s3 rb` is on no built-in destructive pattern and no correction rule, so
// it is the one red here that nothing else in the ladder would decide. `sql-drop` is deliberately the
// opposite — rung 5 covers `drop table` too — which is what the shadowing tests below exercise.
const ENTRIES = [
  entry('git-force', 'red', '/git\\s+push\\b.*(--force(?!-with-lease)|\\s-f\\b)/'),
  entry('sql-drop', 'red', '/drop\\s+table/i'),
  entry('bucket-drop', 'red', '/aws s3 rb s3:\\/\\/prod-/'),
  entry('learned-fetch', 'green', '/git fetch/'),
];
const CORPUS = clauses(ENTRIES.join('\n---\n\n'));

let seq = 0;
const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  const command = (over.call?.input?.command as string | undefined) ?? over.inputSummary ?? 'npm test';
  return {
    ts: over.ts ?? `2026-08-${String((seq % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
    sessionId: `sess-${seq}`,
    cwd: '/w/checkout',
    tool: 'Bash',
    inputSummary: command,
    light: null,
    decision: 'deny',
    clause: null,
    actor: 'timeout',
    latencyMs: 1,
    rewritten: false,
    call: { tool_name: over.tool ?? 'Bash', input: { command } },
    ...over,
  };
};

const cited = (clauseId: string, command: string, decision: 'allow' | 'deny', ts?: string) =>
  record({
    inputSummary: command, call: { tool_name: 'Bash', input: { command } },
    decision, actor: 'policy', clause: `practices §${clauseId}`,
    ...(ts ? { ts } : {}),
  });

const noise = (n: number, command = 'yarn build') =>
  Array.from({ length: n }, () => record({
    inputSummary: command, call: { tool_name: 'Bash', input: { command } },
    decision: 'deny', actor: 'timeout',
  }));

// --------------------------------------------------------------------------- windows

describe('the ablation window', () => {
  it('green and yellow take whichever is larger of the decision count and the day span', () => {
    const old = Array.from({ length: 50 }, (_, i) => record({
      ts: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
    }));
    const recent = Array.from({ length: 10 }, () => record({ ts: '2026-08-20T09:00:00.000Z' }));
    const all = [...old, ...recent];
    const now = new Date('2026-08-25T00:00:00.000Z');
    // 90 days back reaches only the 10 recent ones, but the last 30 decisions is a bigger window.
    expect(ablationWindow(all, 'green', { decisions: 30, days: 90, now }).records).toHaveLength(30);
    // Shrink the decision count and the day window wins instead.
    expect(ablationWindow(all, 'green', { decisions: 5, days: 90, now }).records).toHaveLength(10);
  });

  it('T39: a red reads the lifetime record, so shrinking the configured window changes nothing', () => {
    const all = noise(200);
    const tight = ablationWindow(all, 'red', { decisions: 5, days: 1 });
    const loose = ablationWindow(all, 'red', { decisions: 5000, days: 3650 });
    expect(tight.records).toHaveLength(200);
    expect(loose.records).toHaveLength(200);
    expect(tight.window.lifetime).toBe(true);
  });

  it('an orange reads the lifetime record too', () => {
    expect(ablationWindow(noise(30), 'orange').window.lifetime).toBe(true);
  });
});

// --------------------------------------------------------------------------- near-misses

describe('the near-miss index (§5.5)', () => {
  it('drops the anchors, the final path segment, and keeps the longest literal', () => {
    expect(relaxations('/^aws s3 rb s3:\\/\\/prod-backups$/'))
      .toContain('/aws s3 rb s3:\\/\\/prod-backups/');
    expect(relaxations('deploy/prod/apply.sh')).toContain('deploy/prod');
    expect(relaxations('/^terraform\\s+apply$/').some(r => r.includes('terraform'))).toBe(true);
  });

  it('ignores a relaxation shorter than six literal characters', () => {
    expect(relaxations('rm -f')).not.toContain('rm -f');
  });

  it('counts records whose shape matches even though the clause never fired', () => {
    const records = [
      record({
        inputSummary: 'aws s3 rb s3://prod-backups-eu --force',
        call: { tool_name: 'Bash', input: { command: 'aws s3 rb s3://prod-backups-eu --force' } },
      }),
      ...noise(5),
    ];
    expect(nearMisses({ clauseId: 'bucket', patterns: ['/^aws s3 rb s3:\\/\\/prod-backups$/'] }, records))
      .toBe(1);
  });

  it('does not count a record the clause actually cited — a fire is not a near-miss', () => {
    const fire = cited('bucket', 'aws s3 rb s3://prod-backups', 'deny');
    expect(nearMisses({ clauseId: 'bucket', patterns: ['/^aws s3 rb s3:\\/\\/prod-backups$/'] }, [fire]))
      .toBe(0);
  });

  it('a clause with no patterns has no near-misses to count', () => {
    expect(nearMisses({ clauseId: 'prose', patterns: [] }, noise(10))).toBe(0);
  });
});

// --------------------------------------------------------------------------- one clause

describe('ablating one clause', () => {
  it('T21: a clause that is the sole cause of a recorded deny changes >0 and is no candidate', () => {
    // `bucket-drop` is the sole cause: nothing else in the ladder covers `aws s3 rb`, so removing it
    // leaves the call undecided. (`git-force` would be the wrong fixture — rung 2 shadows it; see the
    // shadowing block below.)
    const records = [cited('bucket-drop', 'aws s3 rb s3://prod-backups', 'deny'), ...noise(20)];
    const report = ablate('bucket-drop', CORPUS, records);
    expect(report.changed).toBeGreaterThan(0);
    expect(report.evidence_class).toBe('in-service');
    expect(report.retirement_candidate).toBe(false);
  });

  it('T22: a green with zero matches over the window is a candidate, with the window recorded', () => {
    const report = ablate('learned-fetch', CORPUS, noise(300), { decisions: 300 });
    expect(report.changed).toBe(0);
    expect(report.retirement_candidate).toBe(true);
    expect(report.evidence).toContain('300 decisions');
    expect(report.evidence).toContain('changes 0 of 300 decisions');
    expect(report.evidence_class).toBe('retire');
  });

  it('a green that is still doing work is `in-service`, not a retirement candidate', () => {
    const records = [cited('learned-fetch', 'git fetch --all', 'allow'), ...noise(20)];
    const report = ablate('learned-fetch', CORPUS, records);
    expect(report.changed).toBe(1);
    expect(report.retirement_candidate).toBe(false);
    expect(report.evidence_class).toBe('in-service');
  });

  it('T25: a green retirement candidate carries the settings-persistence note', () => {
    expect(ablate('learned-fetch', CORPUS, noise(200)).note).toBe(GREEN_PERSISTENCE_NOTE);
  });

  it('a yellow retirement candidate says its zero is not evidence on its own', () => {
    // The same blind spot replay has, on the other side of the loop: an accepted yellow's whole
    // effect is "send this to a human", which ablation reads as `none` — the value an undecided call
    // already had. So a yellow with nothing to withhold in this window ablates to exactly zero
    // whether it is dead weight or whether the green it holds back has not been proposed yet.
    // Without this note the pipeline proposes retiring every yellow it ever got accepted.
    const corpus = clauses(
      [...ENTRIES, entry('learned-lint-ask', 'yellow', '/pnpm lint/')].join('\n---\n\n'));
    const report = ablate('learned-lint-ask', corpus, noise(200));
    expect(report.changed).toBe(0);
    expect(report.evidence_class).toBe('retire');
    expect(report.note).toContain(YELLOW_ABLATION_BLIND);
  });

  it('T24: an `audit`-only shadow match does not keep a clause alive', () => {
    // An audit clause is never handed to the ladder, so its shadow match cannot change a verdict —
    // which is exactly what makes it invisible to ablation. Encoded here as the corpus the gate is
    // given: only accepted clauses reach `ablate`, so a shadow match is structurally absent.
    const audited = clauses(entry('shadow-fetch', 'green', '/git fetch/'));
    const records = noise(200);
    const report = ablate('learned-fetch', CORPUS, records);
    expect(audited).toHaveLength(1);
    expect(report.retirement_candidate).toBe(true);
  });

  it('throws rather than guess when asked to ablate a clause the corpus does not hold', () => {
    expect(() => ablate('no-such-clause', CORPUS, noise(10))).toThrow('no clause no-such-clause');
  });

  it('counts fires from the citation, which is the only honest source for one', () => {
    const records = [cited('sql-drop', 'drop table users', 'deny'), ...noise(5)];
    expect(firesFor('sql-drop', records)).toBe(1);
    expect(firesFor('git-force', records)).toBe(0);
  });
});

// --------------------------------------------------------------------------- the three-way red read

describe('T36–T38 — why a zero means less for a red', () => {
  it('T36: a red with zero changes is never a retirement candidate, in any window', () => {
    for (const decisions of [10, 100, 5000]) {
      const report = ablate('sql-drop', CORPUS, noise(200), { decisions });
      expect(report.changed).toBe(0);
      expect(report.retirement_candidate).toBe(false);
    }
  });

  it('T36: neither is an orange', () => {
    const corpus = clauses(entry('deploy-gate', 'orange', '/terraform apply/'));
    expect(ablate('deploy-gate', corpus, noise(200)).retirement_candidate).toBe(false);
  });

  it('T37: one lifetime fire and zero window fires is `deterrent`, not `dead-weight?`', () => {
    // Zero *recent* fires is precisely what success looks like for a deterrent, so it is never
    // proposed for retirement — the clause fired once, behaviour changed, and it stopped firing. Its
    // own fire replays to the same deny via rung 7, which does not count as shadowing.
    // The fire is passed in rather than mined from the window, because the trail rotates: a clause that
    // fired six months ago has its only fire in a file that no longer exists. See `lifetimeFires`.
    const report = ablate('bucket-drop', CORPUS, noise(50), { lifetimeFires: 1 });
    expect(report.lifetime_fires).toBe(1);
    expect(report.evidence_class).toBe('deterrent');
    expect(report.retirement_candidate).toBe(false);
  });

  it('T38: zero lifetime fires and zero near-misses is `insufficient-exposure`', () => {
    const report = ablate('bucket-drop', CORPUS, noise(50));
    expect({ fires: report.lifetime_fires, misses: report.near_misses })
      .toEqual({ fires: 0, misses: 0 });
    expect(report.evidence_class).toBe('insufficient-exposure');
  });

  it('T38: adding one near-miss reclassifies it `dead-weight?`', () => {
    // Same literal core (`aws s3 rb s3`), different bucket: the hazard's shape occurs in this traffic
    // even though the clause, which only names `prod-`, never triggers.
    const almost = record({
      inputSummary: 'aws s3 rb s3://staging-artifacts --force',
      call: {
        tool_name: 'Bash',
        input: { command: 'aws s3 rb s3://staging-artifacts --force' },
      },
    });
    const report = ablate('bucket-drop', CORPUS, [almost, ...noise(50)]);
    expect(report.near_misses).toBe(1);
    expect(report.evidence_class).toBe('dead-weight?');
    expect(report.retirement_candidate).toBe(false);
  });

  it('every red ablation says it is a listing, not a proposal', () => {
    // `RED_RETIREMENT_CAVEAT` belongs to a displacement packet that actually retires a red. An ablation
    // listing retires nothing, so saying "this retires a red clause" would misdescribe the output.
    expect(ablate('bucket-drop', CORPUS, noise(50)).note).toBe(RED_NOT_PROPOSED);
  });

  /**
   * #85's fix, end to end. The `lifetimeFires` seam above is now filled by a *corpus-wide* durable
   * count (`pipeline/citations.json`), because `ablateAll` ablates every clause against one options
   * object and a single number cannot serve a corpus.
   *
   * The window here is the post-rotation window: it contains the hazard's shape (a near-miss) and not
   * one fire, which is exactly the state that produced the misclassification — `dead-weight?` on a
   * clause whose whole value is that it stopped something being tried.
   */
  const almostBucket = () => record({
    inputSummary: 'aws s3 rb s3://staging-artifacts --force',
    call: { tool_name: 'Bash', input: { command: 'aws s3 rb s3://staging-artifacts --force' } },
  });

  it('#85: the durable count reclassifies a post-rotation `dead-weight?` as `deterrent`', () => {
    const records = [almostBucket(), ...noise(50)];
    // What the trail alone can say now that the months of fires have rotated away.
    expect(ablate('bucket-drop', CORPUS, records).evidence_class).toBe('dead-weight?');
    // What the durable counter knows.
    const report = ablate('bucket-drop', CORPUS, records, {
      citations: { 'bucket-drop': 37, 'git-force': 4 },
    });
    expect(report.lifetime_fires).toBe(37);
    expect(report.evidence_class).toBe('deterrent');
    expect(report.retirement_candidate).toBe(false);
  });

  it('#85: the durable count and the record scan combine by max, so neither can lower the other', () => {
    // A fire inside the window that the counter has not folded yet: the counter is *present* and says
    // zero, the scan says one, and the scan is the one that is right. A `??` here instead of a `max`
    // would take the stale zero and report a live clause as never having fired.
    const fired = record({
      clause: 'practices §bucket-drop',
      inputSummary: 'aws s3 rb s3://prod-artifacts --force',
      call: { tool_name: 'Bash', input: { command: 'aws s3 rb s3://prod-artifacts --force' } },
    });
    const stale = ablate('bucket-drop', CORPUS, [fired, ...noise(50)], {
      citations: { 'bucket-drop': 0, 'git-force': 2 },
    });
    expect(stale.lifetime_fires).toBe(1);
    expect(stale.evidence_class).toBe('deterrent');
    // And a counter ahead of a rotated window wins the other way.
    const rotated = ablate('bucket-drop', CORPUS, noise(50), { citations: { 'bucket-drop': 9 } });
    expect(rotated.lifetime_fires).toBe(9);
  });

  it('#85: no count makes a red a retirement candidate, and none makes a green stop being one', () => {
    // The blast radius. `retirement_candidate` is `changed === 0 && !isSafetyLevel(level)`, which does
    // not read the count at all — so filling `lifetimeFires` differently cannot propose anything new.
    for (const fires of [0, 1, 10_000]) {
      expect(ablate('bucket-drop', CORPUS, noise(50), { citations: { 'bucket-drop': fires } })
        .retirement_candidate).toBe(false);
      expect(ablate('learned-fetch', CORPUS, noise(50), { citations: { 'learned-fetch': fires } })
        .retirement_candidate).toBe(true);
    }
  });

  it('the classifier reads a lifetime fire ahead of everything else', () => {
    expect(classify('red', 0, 1, 99)).toBe('deterrent');
    expect(classify('red', 0, 0, 1)).toBe('dead-weight?');
    expect(classify('red', 0, 0, 0)).toBe('insufficient-exposure');
    expect(classify('green', 0, 0, 0)).toBe('retire');
    expect(classify('green', 3, 0, 0)).toBe('in-service');
  });
});

// --------------------------------------------------------------------------- shadowing

describe('shadowed — a zero because another rung decides, not because the clause is dead', () => {
  it('names the rung and the rule that pre-empts a red from above', () => {
    // The real finding, on the real corpus: the correction lane at rung 2 rewrites `--force` into
    // `--force-with-lease` and allows, and `git-force`'s own negative lookahead says the rewritten form
    // is acceptable. So the clause matches the traffic and never decides it. That is correct behaviour
    // and a redundant clause — not dead weight, and the two need opposite responses.
    const records = [...Array.from({ length: 5 }, (_, i) => record({
      inputSummary: `git push --force origin feature-${i}`,
      call: { tool_name: 'Bash', input: { command: `git push --force origin feature-${i}` } },
      decision: 'allow', actor: 'policy', clause: 'practices §force-push', light: 'yellow',
      rewritten: true,
    })), ...noise(30)];
    const report = ablate('git-force', CORPUS, records);
    expect(report.changed).toBe(0);
    expect(report.evidence_class).toBe('shadowed');
    expect(report.matches).toBe(5);
    expect(report.shadowed_by).toContain("rung 2's corrected");
    expect(report.shadowed_by).toContain('force-push');
    expect(report.evidence).toContain('5 pre-empted call(s)');
  });

  it('the same clause without its `-with-lease` lookahead is NOT shadowed — it blocks the rewrite', () => {
    // The lookahead is what makes the clause assert that `--force-with-lease` is acceptable. Drop it and
    // rung 2's re-check of the *rewritten* input hits the clause, so the correction is refused and the
    // clause is doing real work. Same traffic, opposite reading — which is why the shadow finding has to
    // be measured rather than inferred from the ladder's rung order.
    const strict = clauses(entry('git-force', 'red', '/git\\s+push\\b.*--force\\b/'));
    const records = [...Array.from({ length: 5 }, (_, i) => record({
      inputSummary: `git push --force origin feature-${i}`,
      call: { tool_name: 'Bash', input: { command: `git push --force origin feature-${i}` } },
      decision: 'deny', actor: 'policy', clause: 'practices §git-force', light: 'red',
    })), ...noise(30)];
    const report = ablate('git-force', strict, records);
    expect(report.changed).toBe(5);
    expect(report.evidence_class).toBe('in-service');
  });

  it('names the rung that pre-empts a red from below', () => {
    // `sql-drop` fires, and removing it still changes nothing, because rung 5's built-in destructive
    // table denies the same calls. `deterrent` would be the wrong word: it has not stopped firing, it
    // is redundant with a default.
    const records = [
      ...Array.from({ length: 4 }, (_, i) => cited('sql-drop', `drop table tmp_import_${i}`, 'deny')),
      ...noise(30),
    ];
    const report = ablate('sql-drop', CORPUS, records);
    expect(report.changed).toBe(0);
    expect(report.lifetime_fires).toBe(4);
    expect(report.evidence_class).toBe('shadowed');
    expect(report.shadowed_by).toContain("rung 5's denied — built-in destructive-action rule");
  });

  it('a shadowed clause is never `dead-weight?`, which would invite the wrong action', () => {
    const records = [...Array.from({ length: 3 }, () => cited('sql-drop', 'drop table t', 'deny')),
      ...noise(30)];
    expect(ablate('sql-drop', CORPUS, records).evidence_class).not.toBe('dead-weight?');
  });

  it('carries a note naming both available responses, because the gate cannot choose', () => {
    const records = [...Array.from({ length: 3 }, () => cited('learned-fetch', 'git fetch --all', 'allow')),
      ...noise(30)];
    // A green clause on `git fetch --all` — rung 1 does not cover it (`fetch` is not a safe command),
    // so shadow it with a second accepted green instead.
    const pair = [...CORPUS, ...clauses(entry('other-fetch', 'green', '/git fetch/'))];
    const report = ablate('learned-fetch', pair, records);
    expect(report.evidence_class).toBe('shadowed');
    expect(report.note).toContain('redundant, not dead');
    expect(report.note).toContain('narrow it to cover what the other rung does not');
  });

  it('rung 7 is not a shadower: a fail-closed deny is the absence of a decision', () => {
    // `bucket-drop`'s own deny replays to the same deny via the fail-closed rung. Calling that
    // redundancy would argue for deleting exactly the clauses that carry the policy — it is the only
    // thing that would still deny in observe mode, or once a green covers the call.
    const report = ablate('bucket-drop', CORPUS,
      [cited('bucket-drop', 'aws s3 rb s3://prod-backups', 'deny'), ...noise(30)]);
    expect(report.matches).toBe(0);
    expect(report.evidence_class).not.toBe('shadowed');
  });

  it('a clause that matches nothing is `retire`/`insufficient-exposure`, not shadowed', () => {
    // Matching nothing and being pre-empted are different facts, and only one of them means delete.
    expect(ablate('learned-fetch', CORPUS, noise(200)).evidence_class).toBe('retire');
    expect(ablate('bucket-drop', CORPUS, noise(200)).evidence_class).toBe('insufficient-exposure');
  });

  it('the ladder rung is derived from the actor and the note', () => {
    const label = (over: Partial<DecidedReplay>) => rungOf({
      verdict: 'deny', clause: null, from: 'ladder', actor: 'policy', note: 'x', ...over,
    });
    expect(label({ actor: 'deterministic', verdict: 'allow' })).toBe(1);
    expect(label({ note: 'corrected — practices §fp: …', verdict: 'allow' })).toBe(2);
    expect(label({ verdict: 'deny' })).toBe(3);
    expect(label({ verdict: 'allow' })).toBe(4);
    expect(label({ actor: 'deterministic', verdict: 'deny' })).toBe(5);
    expect(label({ from: 'injected', actor: 'model' })).toBe(6);
    expect(label({ from: 'fallback', actor: 'timeout' })).toBe(7);
  });
});

// --------------------------------------------------------------------------- mutual ablation

describe('T23 — mutual ablation', () => {
  it('two mutually covering clauses do not both become retirement candidates', () => {
    // Both match the same traffic, so against one shared corpus each ablates to zero and a batch run
    // would propose deleting both — and the coverage would be gone. Re-ablating after each acceptance
    // is what catches it.
    const pair = clauses([
      entry('cover-a', 'green', '/git fetch/'),
      entry('cover-b', 'green', '/git fetch/'),
    ].join('\n---\n\n'));
    const records = [cited('cover-a', 'git fetch --all', 'allow'), ...noise(20)];

    // Individually, against the full corpus, each really does ablate to zero.
    expect(ablate('cover-a', pair, records).changed).toBe(0);
    expect(ablate('cover-b', pair, records).changed).toBe(0);

    const reports = ablateAll(pair, records);
    expect(reports.filter(r => r.retirement_candidate).map(r => r.clause_id)).toEqual(['cover-a']);
    expect(reports.find(r => r.clause_id === 'cover-b')?.changed).toBe(1);
  });

  it('is deterministic: the run is ordered by clause id, so two runs agree', () => {
    const pair = clauses([
      entry('zz-cover', 'green', '/git fetch/'),
      entry('aa-cover', 'green', '/git fetch/'),
    ].join('\n---\n\n'));
    const records = noise(30);
    const first = ablateAll(pair, records).map(r => [r.clause_id, r.retirement_candidate]);
    const second = ablateAll([...pair].reverse(), records)
      .map(r => [r.clause_id, r.retirement_candidate]);
    expect(first).toEqual(second);
    expect(first[0][0]).toBe('aa-cover');
  });

  it('leaves independent clauses alone', () => {
    const records = [
      cited('git-force', 'git push --force origin main', 'deny'),
      cited('learned-fetch', 'git fetch --all', 'allow'),
      ...noise(20),
    ];
    expect(ablateAll(CORPUS, records).filter(r => r.retirement_candidate)).toEqual([]);
  });
});

// --------------------------------------------------------------------------- ceiling

describe('the ceiling (§5.3)', () => {
  const compiled = (over: Partial<CompiledClause>): CompiledClause => ({
    id: 'c', citation: 'practices §c', origin: 'learned', tier: 'user', level: 'red',
    status: 'accepted', kind: 'intention', title: 't', body: 'b', patterns: [], fix: null,
    weight: 'medium', expires: null, supersedes: [], source_file: null, deletable: null,
    ...over,
  });

  it('T40b: a deterministic-only clause does not count; the same clause without patterns does', () => {
    const withPattern = compiled({
      id: 'det', patterns: [{ raw: '/rm -rf/', is_regex: true, flags: 'i' }],
    });
    const asProse = compiled({ id: 'prose' });
    expect(renderedCount([withPattern], 'learned-red')).toBe(0);
    expect(renderedCount([asProse], 'learned-red')).toBe(1);
  });

  it('counts only accepted clauses: an audit clause is never rendered', () => {
    expect(renderedCount([compiled({ status: 'audit' })], 'learned-red')).toBe(0);
  });

  it('buckets by direction, so a permissive yellow sits with the greens', () => {
    expect(ceilingTierOf('learned', 'red')).toBe('learned-red');
    expect(ceilingTierOf('learned', 'orange')).toBe('learned-red');
    expect(ceilingTierOf('learned', 'green')).toBe('learned-green');
    expect(ceilingTierOf('learned', 'yellow', true)).toBe('learned-green');
    expect(ceilingTierOf('learned', 'yellow', false)).toBe('learned-red');
    expect(ceilingTierOf('human', 'red')).toBe('human-red');
  });

  it('is one number in config, not adaptive', () => {
    expect(CEILING_PER_TIER).toBe(25);
  });
});

// ------------------------------------------------------- the exemption's cross-module dependency

/**
 * #81. `renderedCount` exempts every matchable clause from the per-tier ceiling, and that exemption
 * is what makes a mining pipeline structurally unable to consume the prompt budget: every mined
 * candidate carries an anchored matcher, so `renderedCount` is always 0 for it.
 *
 * The exemption is **not** a property of the schema. It holds only because `selectClauses` tests a
 * patterned clause against the call and drops it as `evaluated-missed` rather than rendering it. That
 * is a different module, and simplifying it into an unfiltered bundle would make the exemption false
 * while `renderedCount` kept returning 0 — the count would simply be over the wrong population.
 *
 * So these assertions name the selector's *behaviour* alongside the count. Asserting `renderedCount`
 * alone passes for the wrong reason the day the selector stops dropping.
 */
describe('#81 — the rendered-ceiling exemption is a selector behaviour, not a schema property', () => {
  const mined = (id: string, pattern: string, level = 'red'): CompiledClause => ({
    id, citation: `practices §${id}`, origin: 'learned', tier: 'user',
    level: level as CompiledClause['level'], status: 'accepted', kind: 'intention',
    title: id, body: `- ${id}\n`, patterns: [{ raw: pattern, is_regex: false, flags: '' }],
    fix: null, weight: 'medium', expires: null, supersedes: [], source_file: null, deletable: null,
  });

  // A corpus of matchable mined clauses well past the ceiling, so a count over the wrong population
  // could not be mistaken for a corpus that merely happens to fit.
  const MINED = Array.from({ length: CEILING_PER_TIER + 10 }, (_, i) =>
    mined(`mined-${i}`, `shape-${i} --now`, i % 2 === 0 ? 'red' : 'green'));

  const select = (haystack: string) =>
    selectClauses(MINED, { haystack, today: '2026-09-04' });

  it('a corpus of matchable clauses is exempt, and the selector is why: every one is evaluated-missed',
    () => {
      expect(MINED.length).toBeGreaterThan(CEILING_PER_TIER);
      expect(renderedCount(MINED, 'learned-red')).toBe(0);
      expect(renderedCount(MINED, 'learned-green')).toBe(0);

      // The load-bearing half. `renderedCount` is 0 *because* the selector evaluated each clause
      // against this call and dropped it — not because the clauses are absent from the artifact.
      const selection = select('git status --short');
      expect(selection.dropped['evaluated-missed']).toBe(MINED.length);
      expect(selection.selected).toEqual([]);
      // Nothing reached the fill order at all, so no byte of the per-call budget was spent.
      expect(selection.dropped.budget).toBe(0);
    });

  it('a clause that matches is rendered and the rest are still dropped — the exemption is per call',
    () => {
      const selection = select('shape-3 --now please');
      expect(selection.matched).toEqual(['mined-3']);
      expect(selection.dropped['evaluated-missed']).toBe(MINED.length - 1);
      // And the ceiling count does not move, because a matched clause is decided deterministically
      // at rungs 2–4: it is rendered for *this* call and costs no standing instruction.
      expect(renderedCount(MINED, 'learned-red')).toBe(0);
      expect(renderedCount(MINED, 'learned-green')).toBe(0);
    });

  it('the exemption is exactly the pattern test: the same clauses as prose consume the whole ceiling',
    () => {
      const prose = MINED.map(c => ({ ...c, patterns: [] }));
      const reds = MINED.filter(c => c.level === 'red').length;
      expect(renderedCount(prose, 'learned-red')).toBe(reds);
      expect(renderedCount(prose, 'learned-green')).toBe(MINED.length - reds);
      const selection = selectClauses(prose, { haystack: 'git status', today: '2026-09-04' });
      expect(selection.dropped['evaluated-missed']).toBe(0);
      expect(selection.selected.length).toBeGreaterThan(0);
    });

  /**
   * The second module the exemption leans on, which #81 does not name. `renderedCount` counts
   * patternless clauses, and there are *two* channels a patternless clause can reach the prompt
   * through: `prompt_core` (`coreClauses`, reds and oranges, inside the cache breakpoint) and the
   * per-call block (`selectClauses`'s `fill`). `coreClauses` filters on `patterns.length === 0` for
   * the same reason, so relaxing *it* would push every mined red into the cached core — the standing
   * instruction budget, and a revision-hash change on every running session's prefix. Strictly worse
   * than the per-call case, and equally silent.
   */
  it('the core channel exempts them too: no matchable clause reaches prompt_core', () => {
    expect(coreClauses(MINED)).toEqual([]);
    expect(renderCore(MINED)).toBe('');
    // The same reds as prose do reach it, so the emptiness above is the pattern test and not the
    // fixture failing to be a red at all.
    const prose = MINED.filter(c => c.level === 'red').map(c => ({ ...c, patterns: [] }));
    expect(coreClauses(prose)).toHaveLength(prose.length);
  });
});

// --------------------------------------------------------------------------- displacement

describe('displacement (§5.4)', () => {
  const incumbent = (over: Partial<Incumbent> = {}): Incumbent => ({
    id: 'inc', level: 'green', tier: 'learned-green', citations: 0, ablationChanged: 0,
    lastCited: null, evidenceClass: 'retire', ...over,
  });

  it('admits without an eviction when the tier is below its ceiling', () => {
    const d = displace({
      candidateTier: 'learned-green', candidateChanged: 3, renderedCount: 10, incumbents: [],
    });
    expect({ outcome: d.outcome, at: d.at_ceiling }).toEqual({ outcome: 'admit', at: false });
  });

  it('T26: at ceiling, a candidate weaker than the weakest incumbent is rejected', () => {
    const d = displace({
      candidateTier: 'learned-green', candidateChanged: 1, renderedCount: 25,
      incumbents: [incumbent({ id: 'strong', citations: 40 })],
    });
    expect(d.outcome).toBe('reject');
    expect(d.reason).toContain('E12');
    expect(d.reason).toContain('Newest does not win by default');
    expect(d.displaced).toBeUndefined();
  });

  it('T27: at ceiling, a stronger candidate displaces exactly one target', () => {
    const d = displace({
      candidateTier: 'learned-green', candidateChanged: 12, renderedCount: 25,
      incumbents: [incumbent({ id: 'weak', citations: 2 }), incumbent({ id: 'strong', citations: 40 })],
    });
    expect({ outcome: d.outcome, displaced: d.displaced })
      .toEqual({ outcome: 'displace', displaced: 'weak' });
    expect(d.target).toEqual({ id: 'weak', value: 2, level: 'green' });
  });

  it('T41: at ceiling with nothing in the tier, the candidate is rejected and nothing is evicted', () => {
    const d = displace({
      candidateTier: 'learned-red', candidateChanged: 99, renderedCount: 25,
      incumbents: [incumbent({ id: 'other-tier', tier: 'learned-green' })],
    });
    expect(d.outcome).toBe('reject');
    expect(d.reason).toContain('nothing evictable');
    expect(d.displaced).toBeUndefined();
  });

  it('T42, T43: the search never leaves the candidate\'s tier', () => {
    const d = displace({
      candidateTier: 'learned-green', candidateChanged: 99, renderedCount: 25,
      incumbents: [
        incumbent({ id: 'a-red', level: 'red', tier: 'learned-red', citations: 0 }),
        incumbent({ id: 'a-green', level: 'green', tier: 'learned-green', citations: 1 }),
      ],
    });
    expect(d.target?.id).toBe('a-green');
    expect(d.target?.level).toBe('green');
    expect(d.reduces_coverage).toBe(false);
  });

  it('T28: a learned clause never displaces a human one — a declared cross-tier target is refused', () => {
    const d = displace({
      candidateTier: 'learned-red', candidateChanged: 99, renderedCount: 25,
      declared: ['human-rule'],
      incumbents: [incumbent({ id: 'human-rule', level: 'red', tier: 'human-red' })],
    });
    expect(d.outcome).toBe('reject');
    expect(d.reason).toContain('same-tier only');
    expect(d.reason).toContain('never displaces a human one');
  });

  it('T43b: a packet that retires a red carries the caveat and the outgoing evidence class', () => {
    const d = displace({
      candidateTier: 'learned-red', candidateChanged: 8, renderedCount: 25,
      incumbents: [incumbent({
        id: 'old-red', level: 'red', tier: 'learned-red', citations: 0,
        evidenceClass: 'insufficient-exposure',
      })],
    });
    expect(d.outcome).toBe('displace');
    expect(d.reduces_coverage).toBe(true);
    expect(d.caveats).toEqual([
      RED_RETIREMENT_CAVEAT, 'Outgoing old-red evidence class: insufficient-exposure.',
    ]);
  });

  it('a rejected red displacement still carries the caveat: the reviewer saw a red proposed', () => {
    const d = displace({
      candidateTier: 'learned-red', candidateChanged: 0, renderedCount: 25,
      incumbents: [incumbent({
        id: 'old-red', level: 'red', tier: 'learned-red', citations: 0, evidenceClass: 'deterrent',
      })],
    });
    expect(d.outcome).toBe('reject');
    expect(d.caveats[0]).toBe(RED_RETIREMENT_CAVEAT);
  });
});

// --------------------------------------------------------------------------- eviction ranking

describe('the eviction ranking (§5.4)', () => {
  const inc = (over: Partial<Incumbent>): Incumbent => ({
    id: 'x', level: 'green', tier: 'learned-green', citations: 0, ablationChanged: 0,
    lastCited: null, evidenceClass: 'retire', ...over,
  });

  it('class 1 first: zero citations in 90 days AND an ablation zero', () => {
    const target = evictionTarget('learned-green', [
      inc({ id: 'dead', citations: 0, ablationChanged: 0 }),
      inc({ id: 'quiet', citations: 0, ablationChanged: 4 }),
      inc({ id: 'busy', citations: 30, ablationChanged: 9 }),
    ]);
    expect(target?.id).toBe('dead');
  });

  it('class 2 next: zero citations, even with a non-zero ablation', () => {
    const target = evictionTarget('learned-green', [
      inc({ id: 'quiet', citations: 0, ablationChanged: 4 }),
      inc({ id: 'busy', citations: 30, ablationChanged: 9 }),
    ]);
    expect(target?.id).toBe('quiet');
  });

  it('class 3 last: ascending value when everything is still cited', () => {
    const target = evictionTarget('learned-green', [
      inc({ id: 'least', citations: 2, lastCited: new Date('2026-08-01T00:00:00Z') }),
      inc({ id: 'most', citations: 30, lastCited: new Date('2026-08-20T00:00:00Z') }),
    ]);
    expect(target?.id).toBe('least');
  });

  it('T44: among two zero-citation greens, the one dead longest goes first', () => {
    const target = evictionTarget('learned-green', [
      inc({ id: 'recent', citations: 0, lastCited: new Date('2026-07-01T00:00:00Z') }),
      inc({ id: 'ancient', citations: 0, lastCited: new Date('2026-02-01T00:00:00Z') }),
    ]);
    expect(target?.id).toBe('ancient');
  });

  it('a clause never cited at all is deader than one cited long ago', () => {
    const target = evictionTarget('learned-green', [
      inc({ id: 'once', citations: 0, lastCited: new Date('2026-02-01T00:00:00Z') }),
      inc({ id: 'never', citations: 0, lastCited: null }),
    ]);
    expect(target?.id).toBe('never');
  });

  it('breaks a total tie on the clause id, so the run is reproducible', () => {
    const target = evictionTarget('learned-green', [
      inc({ id: 'bbb', citations: 0 }), inc({ id: 'aaa', citations: 0 }),
    ]);
    expect(target?.id).toBe('aaa');
  });

  it('returns nothing when the tier is empty', () => {
    expect(evictionTarget('learned-red', [inc({ tier: 'learned-green' })])).toBeUndefined();
  });
});
