/**
 * Replay invariants from `12-validation.md` §4 and §10 (T14–T20, plus the four auto-rejects).
 *
 * `T16` — the calibration test — comes first on purpose. Every other number in this file depends on
 * it: if an empty-candidate replay cannot reproduce the recorded verdicts exactly, "would change 23
 * of your last 500" cannot be told apart from replay error.
 *
 * Every fixture here is invented. No real path, no real project.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import { parsePractices } from '../../policy/practices';
import {
  CHURN_LIMIT,
  RECORDED,
  ReplayCandidate,
  ReplayInjections,
  WIDENING_WARNING,
  autoReject,
  calibrate,
  candidateClause,
  citedClauseId,
  directionOf,
  excerpt,
  pickExamples,
  recordId,
  replayCandidate,
  replayWindow,
  replayableCall,
  verdictSourceOf,
} from '../../policy/replay';

// --------------------------------------------------------------------------- fixtures

const clauses = (body: string) => parsePractices(body, 'project', 'practices.md');

/** A three-clause invented corpus: one red, one green, one that matches nothing in this traffic. */
const CORPUS = clauses(
  '### Intention: Never force-push a shared branch\n\n| Field | Value |\n|---|---|\n'
  + '| id | git-force |\n| level | red |\n\nMatch: /git\\s+push\\b.*--force\\b/\n\n'
  + 'Rewriting history other people build on destroys their work.\n\n---\n\n'
  // `git log` would be a bad fixture here: rung 1's `preClassify` already allows it, so a *written*
  // green about it can never be the thing that decides. `git fetch` is not on the safe-command list
  // and is not destructive, so it genuinely reaches rung 4.
  + '### Belief: Fetching from the remote is fine\n\n| Field | Value |\n|---|---|\n'
  + '| id | git-fetch |\n| level | green |\n\nMatch: /git fetch/\n\n'
  + 'Fetching mutates no branch anyone has.\n\n---\n\n'
  + '### Intention: Never drop a production table\n\n| Field | Value |\n|---|---|\n'
  + '| id | sql-drop |\n| level | red |\n\nMatch: /drop\\s+table/i\n\n'
  + 'A dropped table takes its rows with it.\n');

let seq = 0;
const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  const command = (over.call?.input?.command as string | undefined) ?? over.inputSummary ?? 'npm test';
  return {
    ts: `2026-08-${String((seq % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
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

/** A record the corpus above genuinely denies, recorded as such. */
const deniedByRed = (over: Partial<DecisionRecord> = {}) => record({
  inputSummary: 'git push --force origin main',
  call: { tool_name: 'Bash', input: { command: 'git push --force origin main' } },
  decision: 'deny', actor: 'policy', clause: 'practices §git-force', light: 'red', ...over,
});

/** A record the corpus above genuinely allows, at rung 4 rather than rung 1. */
const allowedByGreen = (over: Partial<DecisionRecord> = {}) => record({
  inputSummary: 'git fetch --all --prune',
  call: { tool_name: 'Bash', input: { command: 'git fetch --all --prune' } },
  decision: 'allow', actor: 'policy', clause: 'practices §git-fetch', light: 'green', ...over,
});

/**
 * A record the *built-in* destructive table denied — rung 5, no written clause. Rung 4 sits above it,
 * so a written green really can overturn this one, which is what makes it the AR3 fixture.
 */
const deniedByBuiltIn = (over: Partial<DecisionRecord> = {}) => record({
  inputSummary: 'chmod -R 777 ./public',
  call: { tool_name: 'Bash', input: { command: 'chmod -R 777 ./public' } },
  decision: 'deny', actor: 'deterministic', clause: null, light: 'red', ...over,
});

/** A record nothing in the corpus covers: it fell closed. The named gap the pipeline mines. */
const fellClosed = (command: string) => record({
  inputSummary: command,
  call: { tool_name: 'Bash', input: { command } },
  decision: 'deny', actor: 'timeout', clause: null,
});

const candidate = (over: Partial<ReplayCandidate> = {}): ReplayCandidate => ({
  id: 'learned-npm-test', level: 'green', tier: 'user',
  title: 'Running the test suite needs no approval',
  match: ['/^Bash \\{"command":"npm test/'],
  ...over,
});

// --------------------------------------------------------------------------- T16 first

describe('T16 — calibration: the empty candidate must reproduce history exactly', () => {
  it('reproduces every deterministic recorded verdict over a mixed window', () => {
    const records = [
      ...Array.from({ length: 20 }, () => deniedByRed()),
      ...Array.from({ length: 20 }, () => allowedByGreen()),
      ...Array.from({ length: 20 }, () => fellClosed('npm test')),
      record({ decision: 'allow', actor: 'model', inputSummary: 'terraform plan' }),
      record({ decision: 'deny', actor: 'human', inputSummary: 'rm -rf ./build' }),
    ];
    const cal = calibrate(records, CORPUS);
    expect(cal.mismatches).toEqual([]);
    expect(cal.ok).toBe(true);
    expect(cal.n).toBe(62);
    expect(cal.message).toContain('62 recorded verdicts reproduced exactly');
  });

  it('reproduces the fail-closed deny, so a named gap is not reported as a change', () => {
    // Rung 7 lives in the hook wrapper, not in the ladder. Without reproducing it every fail-closed
    // record would read as a change and the report would be almost entirely noise.
    const cal = calibrate([fellClosed('terraform apply')], CORPUS);
    expect(cal.ok).toBe(true);
  });

  it('fails loudly, and says why every other number is then meaningless', () => {
    // A record whose recorded verdict disagrees with the corpus as it stands: the corpus moved on.
    const stale = record({
      inputSummary: 'git push --force origin main',
      call: { tool_name: 'Bash', input: { command: 'git push --force origin main' } },
      decision: 'allow', actor: 'policy', clause: 'practices §gone',
    });
    const cal = calibrate([stale], CORPUS);
    expect(cal.ok).toBe(false);
    expect(cal.message).toContain('CALIBRATION FAILED');
    expect(cal.message).toContain('meaningless');
    expect(cal.message).toContain('recorded allow, replayed deny');
  });

  it('excludes model-sourced records, whose originals were never deterministic', () => {
    const modelRecord = record({ decision: 'allow', actor: 'model', inputSummary: 'git push --force x' });
    // The ladder now denies it, so it *is* a change — but not a calibration failure.
    const cal = calibrate([modelRecord], CORPUS);
    expect(cal.ok).toBe(true);
    expect(replayWindow([modelRecord], CORPUS, null).advisory).toBe(1);
  });
});

// --------------------------------------------------------------------------- T14 / T15

describe('T14, T15 — one evaluator, and no model calls', () => {
  it('T14: exactly one definition of the evaluator exists, and replay imports it', () => {
    const root = path.join(__dirname, '..', '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) { continue; }
        const text = fs.readFileSync(full, 'utf8');
        if (/^export function decideDeterministically\b/m.test(text)
          || /^function decideDeterministically\b/m.test(text)) {
          found.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(found).toEqual(['hooks/permissionRequest.ts']);

    const replaySrc = fs.readFileSync(path.join(root, 'policy', 'replay.ts'), 'utf8');
    expect(replaySrc).toContain("import { EXEMPT_TOOLS, decideDeterministically } from '../hooks/permissionRequest'");
  });

  it('T15: a full 500-decision replay makes no model call', async () => {
    const factory = await import('../../supervisor/factory');
    const spy = vi.spyOn(factory, 'buildEngine');
    const records = Array.from({ length: 500 }, (_, i) => (i % 3 === 0
      ? deniedByRed()
      : i % 3 === 1 ? allowedByGreen() : record({ decision: 'allow', actor: 'model' })));
    const diff = replayWindow(records, CORPUS, candidate(), { window: 500 });
    expect(diff.n).toBe(500);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('replay never reads the wall clock: the injected clock is the record timestamp', () => {
    const rec = allowedByGreen({ ts: '2026-01-02T03:04:05.000Z' });
    expect(RECORDED.clock(rec).toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('the injections answer only from the record — a throwing model client is never consulted', () => {
    const throwing: ReplayInjections = {
      classify: () => { throw new Error('replay called a model'); },
      ask: RECORDED.ask,
      clock: RECORDED.clock,
    };
    const records = [deniedByRed(), allowedByGreen(), fellClosed('npm test')];
    expect(() => replayWindow(records, CORPUS, null, { injections: throwing })).not.toThrow();
  });
});

// --------------------------------------------------------------------------- the record

describe('reading a decision record', () => {
  it('a record with no `call` is unreplayable, and is never reconstructed from the summary', () => {
    const legacy = { ...record(), call: undefined };
    expect(replayableCall(legacy)).toBeNull();
    const diff = replayWindow([legacy], CORPUS, null);
    expect(diff.unreplayable).toBe(1);
    expect(diff.n).toBe(0);
    expect(diff.changed).toBe(0);
  });

  it('unreplayable records are held out of n rather than counted as unchanged', () => {
    const diff = replayWindow(
      [{ ...deniedByRed(), call: undefined }, allowedByGreen()], CORPUS, null);
    expect({ n: diff.n, unreplayable: diff.unreplayable }).toEqual({ n: 1, unreplayable: 1 });
  });

  it('an exempt tool is never replayed: the hook never decides one', () => {
    // `AskUserQuestion` records carry actor `human`, so replaying them would trip AR1 on a question.
    const ask = record({ tool: 'AskUserQuestion', decision: 'none', actor: 'human' });
    const diff = replayWindow([ask, allowedByGreen()], CORPUS, candidate({ match: ['Ask'] }));
    expect({ exempt: diff.exempt, n: diff.n, changed: diff.changed })
      .toEqual({ exempt: 1, n: 1, changed: 0 });
  });

  it('maps the record actor onto a verdict source', () => {
    expect(verdictSourceOf(record({ actor: 'human' }))).toBe('human');
    expect(verdictSourceOf(record({ actor: 'model' }))).toBe('model');
    expect(verdictSourceOf(record({ actor: 'policy' }))).toBe('clause');
    expect(verdictSourceOf(record({ actor: 'deterministic' }))).toBe('clause');
    expect(verdictSourceOf(record({ actor: 'timeout' }))).toBe('fallback');
  });

  it('parses a clause id out of a citation, with or without a revision', () => {
    expect(citedClauseId('practices §team-git-002')).toBe('team-git-002');
    expect(citedClauseId('practices §team-git-002@a1b2c3d')).toBe('team-git-002');
    expect(citedClauseId(null)).toBeNull();
    expect(citedClauseId('no marker here')).toBeNull();
  });

  it('a record id is stable across reads and unique per decision', () => {
    const rec = allowedByGreen();
    expect(recordId(rec)).toBe(recordId({ ...rec }));
    expect(recordId(rec)).not.toBe(recordId(deniedByRed()));
  });

  it('classifies direction: green widens, red narrows, yellow depends on its rewrite', () => {
    expect(directionOf('green')).toBe('widening');
    expect(directionOf('red')).toBe('narrowing');
    expect(directionOf('orange')).toBe('narrowing');
    expect(directionOf('yellow', true)).toBe('widening');
    expect(directionOf('yellow', false)).toBe('narrowing');
  });
});

// --------------------------------------------------------------------------- the diff

describe('the replay diff', () => {
  it('counts a newly caught call that previously fell closed', () => {
    const records = [fellClosed('npm test'), fellClosed('npm test')];
    const diff = replayWindow(records, [...CORPUS, candidateClause(candidate())], candidate());
    expect({ changed: diff.changed, newly: diff.newly_caught, rev: diff.reversals })
      .toEqual({ changed: 2, newly: 2, rev: 0 });
  });

  it('counts a reversal when a concrete verdict flips in either direction', () => {
    const records = [allowedByGreen()];
    const narrowing = candidate({ id: 'no-fetch', level: 'red', match: ['/git fetch/'] });
    const diff = replayWindow(records, [...CORPUS, candidateClause(narrowing)], narrowing);
    expect({ changed: diff.changed, rev: diff.reversals }).toEqual({ changed: 1, rev: 1 });
  });

  it('reports breadth as the union of the candidate patterns over the window', () => {
    const records = [
      ...Array.from({ length: 4 }, () => fellClosed('npm test')),
      ...Array.from({ length: 96 }, () => fellClosed('yarn build')),
    ];
    const diff = replayWindow(records, CORPUS, candidate());
    expect({ matched: diff.matched, n: diff.n, pct: diff.match_pct })
      .toEqual({ matched: 4, n: 100, pct: 0.04 });
  });

  it('T19: examples are deterministic across two runs over the same window', () => {
    const records = Array.from({ length: 40 }, (_, i) => fellClosed(`npm test -- shard-${i}`));
    const cand = candidate({ match: ['/npm test/'] });
    const a = replayWindow(records, [...CORPUS, candidateClause(cand)], cand);
    const b = replayWindow([...records], [...CORPUS, candidateClause(cand)], cand);
    expect(a.examples.map(e => e.record_id)).toEqual(b.examples.map(e => e.record_id));
    expect(a.examples).toHaveLength(3);
  });

  it('T19: the human-adjacent change is the first example', () => {
    const human = record({
      inputSummary: 'npm test --coverage',
      call: { tool_name: 'Bash', input: { command: 'npm test --coverage' } },
      decision: 'deny', actor: 'human',
    });
    const records = [fellClosed('npm test a'), fellClosed('npm test b'), human];
    const cand = candidate({ match: ['/npm test/'] });
    const diff = replayWindow(records, [...CORPUS, candidateClause(cand)], cand);
    expect(diff.examples[0].verdict_source).toBe('human');
  });

  it('T20: the excerpt is bounded at 100 chars and comes from the redacted record', () => {
    const long = 'a'.repeat(400);
    expect(excerpt(record({ inputSummary: long })).length).toBe(100);
    // `recordedCall`/`summarizeInput` redact on the way in, so replay is not a new place a secret
    // gets printed: it prints the record's own already-redacted text and adds no new source.
    expect(excerpt(record({ inputSummary: 'export TOKEN=sk-ant-MASKED-x' })))
      .toBe('export TOKEN=sk-ant-MASKED-x');
  });

  it('picks at most three examples even when everything changed', () => {
    const records = Array.from({ length: 50 }, () => fellClosed('npm test'));
    const cand = candidate({ match: ['/npm test/'] });
    const diff = replayWindow(records, [...CORPUS, candidateClause(cand)], cand);
    expect(diff.examples).toHaveLength(3);
    expect(pickExamples([], RECORDED)).toEqual([]);
  });
});

// --------------------------------------------------------------------------- auto-rejects

describe('the four auto-rejects (§4.3)', () => {
  const diffFor = (cand: ReplayCandidate, records: DecisionRecord[]) =>
    replayWindow(records, [...CORPUS, candidateClause(cand)], cand, { window: records.length });

  it('T12: AR1 — denying a call a human explicitly approved', () => {
    const approved = record({
      inputSummary: 'npm test --watch',
      call: { tool_name: 'Bash', input: { command: 'npm test --watch' } },
      decision: 'allow', actor: 'human',
    });
    const cand = candidate({ id: 'no-watch', level: 'red', match: ['/npm test --watch/'] });
    const rejection = autoReject(cand, diffFor(cand, [approved]));
    expect(rejection?.code).toBe('AR1');
    expect(rejection?.message).toContain('a human explicitly approved');
  });

  it('T13: AR1 — allowing a call a human explicitly denied', () => {
    const denied = record({
      inputSummary: 'npm test --watch',
      call: { tool_name: 'Bash', input: { command: 'npm test --watch' } },
      decision: 'deny', actor: 'human',
    });
    const cand = candidate({ match: ['/npm test/'] });
    const rejection = autoReject(cand, diffFor(cand, [denied]));
    expect(rejection?.code).toBe('AR1');
    expect(rejection?.message).toContain('a human explicitly denied');
  });

  it('AR2 — flipping a clause verdict with no declared supersedes', () => {
    const cand = candidate({ id: 'fetch-is-risky', level: 'red', match: ['/git fetch/'] });
    const rejection = autoReject(cand, diffFor(cand, [allowedByGreen()]));
    expect(rejection?.code).toBe('AR2');
    expect(rejection?.message).toContain('§git-fetch');
  });

  it('AR2 — declaring supersedes for that clause licenses the reversal', () => {
    const cand = candidate({
      id: 'fetch-is-risky', level: 'red', match: ['/git fetch/'], supersedes: ['git-fetch'],
    });
    expect(autoReject(cand, diffFor(cand, [allowedByGreen()]))).toBeNull();
  });

  it('AR2 — a declared `displaces` licenses it too', () => {
    const cand = candidate({
      id: 'fetch-is-risky', level: 'red', match: ['/git fetch/'], displaces: ['git-fetch'],
    });
    expect(autoReject(cand, diffFor(cand, [allowedByGreen()]))).toBeNull();
  });

  it('AR3 — a green candidate never turns a recorded deny into an allow', () => {
    // The built-in destructive table is rung 5 and a written green is rung 4, so the green really
    // would win here. AR3 is the thing that stops it: learned green beats nothing red.
    const cand = candidate({ id: 'chmod-is-fine', level: 'green', match: ['/chmod -R 777/'] });
    const rejection = autoReject(cand, diffFor(cand, [deniedByBuiltIn()]));
    expect(rejection?.code).toBe('AR3');
  });

  it('AR3 — a rewriting yellow is a widening too, and does not walk past it', () => {
    // This test used to assert the opposite, and the opposite was a hole. AR3 tested
    // `level === 'green'`, but `directionOf` reads a yellow WITH a fix as a widening — so the one
    // candidate class that could turn a recorded deny into an allow *and edit the command on the way
    // through* was the one class the gate could not see. The test now pins the direction, not the
    // level, so adding a third widening shape cannot reopen it.
    const cand = candidate({
      id: 'chmod-narrower', level: 'yellow', hasFix: true, match: ['/chmod -R 777/'],
    });
    expect(autoReject(cand, diffFor(cand, [deniedByBuiltIn()]))?.code).toBe('AR3');
  });

  it('AR3 — a yellow with no fix is a narrowing and is not caught by it', () => {
    // The other side of the same comparison: without a fix the clause cannot allow anything, so
    // there is no widening to refuse and AR3 must stay out of its way.
    const cand = candidate({
      id: 'chmod-ask', level: 'yellow', hasFix: false, match: ['/chmod -R 777/'],
    });
    expect(autoReject(cand, diffFor(cand, [deniedByBuiltIn()]))?.code).not.toBe('AR3');
  });

  it('AR3 — a fail-closed deny is not the kind of deny AR3 protects', () => {
    // Written literally, §4.3's "any recorded deny" would reject every green candidate ever proposed:
    // the highest-signal mining input *is* the call that fell closed, and its recorded decision is
    // `deny`. See the AR3 comment in replay.ts.
    const cand = candidate({ match: ['/npm test/'] });
    expect(autoReject(cand, diffFor(cand, [fellClosed('npm test')]))).toBeNull();
  });

  it('a written red still outranks a green candidate, so no reversal reaches AR3 at all', () => {
    // Rung 3 is above rung 4. The candidate cannot change this decision, which is why AR3 never has
    // to arbitrate between a written red and a learned green.
    const cand = candidate({ id: 'force-is-fine', level: 'green', match: ['/git push --force/'] });
    expect(diffFor(cand, [deniedByRed()]).changed).toBe(0);
  });

  it('AR4 — churn above the documented threshold is too-disruptive', () => {
    const records = [
      ...Array.from({ length: 30 }, () => fellClosed('npm test')),
      ...Array.from({ length: 70 }, () => fellClosed('yarn build')),
    ];
    const cand = candidate({ match: ['/npm test/'] });
    const rejection = autoReject(cand, diffFor(cand, records));
    expect(rejection?.code).toBe('AR4');
    expect(rejection?.message).toContain('30 of 100');
    expect(CHURN_LIMIT).toBe(0.2);
  });

  it('AR4 — exactly at the threshold passes; the limit is strictly greater-than', () => {
    const records = [
      ...Array.from({ length: 20 }, () => fellClosed('npm test')),
      ...Array.from({ length: 80 }, () => fellClosed('yarn build')),
    ];
    const cand = candidate({ match: ['/npm test/'] });
    expect(autoReject(cand, diffFor(cand, records))).toBeNull();
  });

  it('T17: a model-sourced difference is advisory and never rejects', () => {
    const modelDenied = record({
      inputSummary: 'npm test --ci',
      call: { tool_name: 'Bash', input: { command: 'npm test --ci' } },
      decision: 'deny', actor: 'model',
    });
    const cand = candidate({ match: ['/npm test/'] });
    const diff = diffFor(cand, [modelDenied]);
    expect({ changed: diff.changed, advisory: diff.advisory }).toEqual({ changed: 1, advisory: 1 });
    expect(autoReject(cand, diff)).toBeNull();
  });

  it('a narrowing candidate\'s model reversals do not count toward churn; a widening one\'s do', () => {
    const records = Array.from({ length: 100 }, (_, i) => (i < 30
      ? record({
        inputSummary: 'npm test', decision: 'deny', actor: 'model',
        call: { tool_name: 'Bash', input: { command: 'npm test' } },
      })
      : fellClosed('yarn build')));
    const widening = candidate({ level: 'green', match: ['/npm test/'] });
    const narrowing = candidate({ id: 'no-test', level: 'red', match: ['/npm test/'] });
    expect(autoReject(widening, diffFor(widening, records))?.code).toBe('AR4');
    expect(autoReject(narrowing, diffFor(narrowing, records))).toBeNull();
  });

  it('the auto-rejects are ordered: AR1 wins over AR2 and AR3', () => {
    const humanApproved = record({
      inputSummary: 'git push --force origin main', decision: 'allow', actor: 'human',
      call: { tool_name: 'Bash', input: { command: 'git push --force origin main' } },
    });
    const cand = candidate({ id: 'green-force', level: 'green', match: ['/git push --force/'] });
    expect(autoReject(cand, diffFor(cand, [humanApproved]))?.code).toBe('AR1');
  });
});

// --------------------------------------------------------------------------- the report (T18)

describe('T18 — the report renders §4.4 byte-for-byte', () => {
  it('matches the spec template for a fixed window', () => {
    const records = [
      record({
        ts: '2026-08-04T09:00:00.000Z', sessionId: 'sess-shard', tool: 'Bash',
        inputSummary: 'npm test -- --shard 2/4', decision: 'deny', actor: 'timeout',
        call: { tool_name: 'Bash', input: { command: 'npm test -- --shard 2/4' } },
      }),
      record({
        ts: '2026-08-10T09:00:00.000Z', sessionId: 'sess-harness', tool: 'Write',
        inputSummary: 'src/npm test/harness.ts', decision: 'deny', actor: 'timeout',
        call: { tool_name: 'Write', input: { file_path: 'src/npm test/harness.ts' } },
      }),
      ...Array.from({ length: 98 }, () => fellClosed('yarn build')),
    ];
    const result = replayCandidate(candidate({ match: ['/npm test/'] }), records, CORPUS, {
      window: 100, fixturePath: 'tests/fixtures/clauses/learned-npm-test.json',
    });
    expect(result.calibration.ok).toBe(true);
    expect(result.report_text).toBe(
      'Candidate learned-npm-test (green, widening)\n'
      + '\n'
      + 'Would have changed 2 of your last 100 decisions.\n'
      + '  0 reversals (0 of a human\'s own answer)\n'
      + '  0 advisory (original verdict came from the model, not a clause)\n'
      + '  2 calls newly caught that previously reached a prompt\n'
      + '\n'
      + 'Breadth: matches 2.0% of calls in this window (2 of 100).\n'
      + '\n'
      + 'Examples:\n'
      + '  1. [deny -> allow] Bash: npm test -- --shard 2/4\n'
      + '     session sess-shard, 2026-08-04T09:00:00Z\n'
      + '  2. [deny -> allow] Write: src/npm test/harness.ts\n'
      + '     session sess-harness, 2026-08-10T09:00:00Z\n'
      + '\n'
      + 'Verdict: PASS\n'
      + 'Fixture: tests/fixtures/clauses/learned-npm-test.json\n',
    );
  });

  it('pluralises the counted nouns — "1 reversal", not "1 reversals"', () => {
    // The §4.4 template writes `{reversals} reversals`; T18 asks for pluralisation, so the template
    // is read as shorthand. Flagged in the PR body as the one place the format was interpreted.
    const records = [allowedByGreen(), ...Array.from({ length: 99 }, () => fellClosed('yarn build'))];
    const cand = candidate({
      id: 'fetch-is-risky', level: 'red', match: ['/git fetch/'], supersedes: ['git-fetch'],
    });
    const result = replayCandidate(cand, records, CORPUS, { window: 100 });
    expect(result.report_text).toContain('  1 reversal (0 of a human\'s own answer)');
    expect(result.report_text).toContain('Would have changed 1 of your last 100 decisions.');
  });

  it('names the rejection in the Verdict line', () => {
    const denied = record({
      inputSummary: 'npm test', decision: 'deny', actor: 'human',
      call: { tool_name: 'Bash', input: { command: 'npm test' } },
    });
    const result = replayCandidate(candidate({ match: ['/npm test/'] }), [denied], CORPUS);
    expect(result.verdict).toBe('reject');
    expect(result.report_text).toContain('Verdict: REJECT AR1');
  });

  it('rejects a candidate that matches real calls and changes none of them', () => {
    // §4.4 calls this an internal inconsistency and exits 70. On this ladder it has an ordinary
    // explanation — a written red at rung 3 decides every call the green candidate matches at rung 4
    // — and it was the first thing a run against real records produced. It is a rejection, not a
    // crash: a reviewer shown "PASS, 0 of 126 changed" merges a clause that does nothing.
    const records = [deniedByRed(), ...Array.from({ length: 20 }, () => fellClosed('yarn build'))];
    const cand = candidate({ id: 'force-is-fine', level: 'green', match: ['/git push --force/'] });
    const result = replayCandidate(cand, records, CORPUS, { window: 21 });
    expect(result.diff.matched).toBe(1);
    expect(result.diff.changed).toBe(0);
    expect(result.rejection?.code).toBe('INERT');
    expect(result.report_text).toContain('Verdict: REJECT INERT');
  });

  it('does not call a narrowing yellow INERT: the verdict vocabulary cannot see an escalation', () => {
    // Same records, same shape, and the *only* difference from the test above is the candidate's
    // level. A no-fix yellow's whole effect is "send this to a human", which is `none` — the same
    // value the fail-closed records it was mined from already carry — so `changed` is zero for it no
    // matter how good the clause is. Rejecting it here would reject every yellow for the vocabulary's
    // blind spot rather than for its own behaviour, so it passes with a note instead.
    const records = [deniedByRed(), ...Array.from({ length: 20 }, () => fellClosed('yarn build'))];
    const cand = candidate({
      id: 'force-ask', level: 'yellow', hasFix: false, match: ['/git push --force/'],
    });
    const result = replayCandidate(cand, records, CORPUS, { window: 21 });
    expect(result.diff.matched).toBe(1);
    expect(result.diff.changed).toBe(0);
    expect(result.rejection).toBeNull();
    expect(result.verdict).toBe('pass');
    expect(result.notes.join()).toContain('cannot tell that apart');
    // And the exemption is exactly one shape wide: add a fix and it is a widening again, INERT and all.
    const withFix = candidate({
      id: 'force-fix', level: 'yellow', hasFix: true, match: ['/git push --force/'],
    });
    expect(replayCandidate(withFix, records, CORPUS, { window: 21 }).rejection?.code).toBe('INERT');
  });

  it('a candidate that matches nothing at all is not INERT — that is the static stage\'s E7', () => {
    const result = replayCandidate(
      candidate({ match: ['/nothing-here/'] }), [fellClosed('yarn build')], CORPUS);
    expect(result.rejection).toBeNull();
  });

  it('says "(none)" rather than an empty Examples block', () => {
    const result = replayCandidate(
      candidate({ match: ['/nothing-here/'] }), [fellClosed('yarn build')], CORPUS);
    expect(result.report_text).toContain('Examples:\n  (none)\n');
  });
});

// --------------------------------------------------------------------------- notes

describe('the notes a packet carries', () => {
  it('a widening candidate always carries the settings-persistence warning (§6.3)', () => {
    const result = replayCandidate(candidate(), [fellClosed('npm test')], CORPUS);
    expect(result.notes).toContain(WIDENING_WARNING);
  });

  it('a narrowing candidate does not', () => {
    const cand = candidate({ id: 'no-test', level: 'red', match: ['/npm test/'] });
    expect(replayCandidate(cand, [fellClosed('npm test')], CORPUS).notes)
      .not.toContain(WIDENING_WARNING);
  });

  it('names unreplayable records rather than hiding them in an unchanged count', () => {
    const result = replayCandidate(
      candidate(), [{ ...fellClosed('npm test'), call: undefined }], CORPUS);
    expect(result.notes.join(' ')).toContain('predate the `call` field');
    expect(result.notes.join(' ')).toContain('larger than reported');
  });

  it('flags single-session evidence, because one session is an anecdote', () => {
    const records = Array.from({ length: 3 }, () => fellClosed('npm test'))
      .map(r => ({ ...r, sessionId: 'only-one' }));
    const result = replayCandidate(candidate({ match: ['/npm test/'] }), records, CORPUS);
    expect(result.notes.join(' ')).toContain('single-session evidence');
  });

  it('a failed calibration suppresses the auto-rejects: nothing this run says is trustworthy', () => {
    const stale = record({
      inputSummary: 'git push --force origin main', decision: 'allow', actor: 'policy',
      call: { tool_name: 'Bash', input: { command: 'git push --force origin main' } },
    });
    const result = replayCandidate(candidate(), [stale], CORPUS);
    expect(result.calibration.ok).toBe(false);
    expect(result.rejection).toBeNull();
  });
});
