/**
 * The run, end to end — `11-mine-v2.md` §12.1, §12.3, §12.16–12.18, §12.22 and §12.23.
 *
 * The one that carries the most weight is §12.22, **the zero is always explained**: every run appends
 * exactly one `pipeline.jsonl` line, every key is present, and a run that produced no output carries a
 * non-`ok` `exitReason`. Without it, a correctly-empty run, a crashed run and a hook that has been
 * silently broken for three weeks are the same observation from outside.
 *
 * §12.27 and §12.25 — zero model calls, and `memory/` never opened — live in `noModel.test.ts`, which
 * has to mock the module graph and so cannot share a file with runs that use the real filesystem.
 *
 * Every fixture is invented. No real path and no real project name.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import type { PluginSettings } from '../../hooks/settings';
import { parsePractices } from '../../policy/practices';
import { readShapes } from '../../policy/mine';
import {
  RunLine, accumulate, acquireLock, appendRunLine, exitReasonFor, headlineFor, pipelinePath,
  propose, recentRuns, runFingerprint, stalenessLine,
} from '../../policy/pipeline';

// --------------------------------------------------------------------------- fixtures

let seq = 0;
const bash = (command: string, over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  return {
    ts: '2026-08-25T09:00:00.000Z',
    sessionId: `s-${seq}`,
    cwd: '/w/api',
    tool: 'Bash',
    inputSummary: command,
    light: 'green',
    decision: 'allow',
    clause: null,
    actor: 'model',
    latencyMs: 2000,
    rewritten: false,
    rev: 'a91f3c2',
    call: { tool_name: 'Bash', input: { command } },
    ...over,
  };
};

/** The worked example: a fail-closed deny plus five allows over three sessions and nine days. */
const WINDOW: DecisionRecord[] = [
  bash('pnpm test --filter core', {
    sessionId: 's-A', ts: '2026-08-25T09:12:03.000Z', decision: 'deny', light: null,
    actor: 'timeout', latencyMs: 8014,
  }),
  bash('pnpm test --filter core', { sessionId: 's-A', ts: '2026-08-25T09:14:40.000Z' }),
  bash('pnpm test --filter cli', { sessionId: 's-B', ts: '2026-08-27T14:02:55.000Z' }),
  bash('pnpm test --filter cli', { sessionId: 's-B', ts: '2026-08-27T14:31:08.000Z' }),
  bash('pnpm test', { sessionId: 's-C', ts: '2026-09-01T10:20:11.000Z' }),
  bash('pnpm test --watch', { sessionId: 's-C', ts: '2026-09-01T10:41:02.000Z' }),
];

const CORPUS = parsePractices(
  '### Intention: Never force-push a shared branch\n\n| Field | Value |\n|---|---|\n'
  + '| id | git-force |\n| level | red |\n\nMatch: /git\\s+push\\b.*--force\\b/\n\n'
  + 'Rewriting history other people build on destroys their work, and there is no undo.\n',
  'team', 'bottom-line.md');

interface Rig {
  dir: string;
  corpus: string;
  env: NodeJS.ProcessEnv;
  settings: PluginSettings;
}

function rig(records: DecisionRecord[] = WINDOW, suffix = ''): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-corpus-'));
  const env = { SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv;
  if (records.length > 0) {
    fs.writeFileSync(path.join(dir, `decisions.jsonl${suffix}`),
      records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  const settings = {
    user: 'devon', project: null, team: null,
  } as unknown as PluginSettings;
  return { dir, corpus, env, settings };
}

function run(r: Rig, over: Partial<Parameters<typeof propose>[0]> = {}) {
  return propose({
    settings: r.settings,
    corpusRoot: r.corpus,
    corpus: CORPUS,
    rev: 'a91f3c2',
    env: r.env,
    now: new Date('2026-09-03T18:41:07.221Z'),
    ...over,
  });
}

function lines(r: Rig): RunLine[] {
  return fs.readFileSync(pipelinePath(r.env), 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as RunLine);
}

function clauseFiles(r: Rig): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); } else { out.push(path.relative(r.corpus, full)); }
    }
  };
  if (fs.existsSync(path.join(r.corpus, 'data'))) { walk(path.join(r.corpus, 'data')); }
  return out.sort();
}

// --------------------------------------------------------------------------- the happy path

describe('a run that proposes', () => {
  it('writes exactly one proposed clause file, and nothing else', () => {
    const r = rig();
    const { line, written } = run(r);
    expect(line.exitReason).toBe('ok');
    expect(line.candidates.proposed).toBe(1);
    expect(written).toHaveLength(1);
    const files = clauseFiles(r);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      /^data\/knowledge\/users\/devon\/learned\/green-repeat-pnpm-test-[0-9a-f]{12}\.md$/);
    expect(fs.readFileSync(path.join(r.corpus, files[0]), 'utf8')).toContain('status: proposed');
  });

  it('§12.3 — what it wrote is inert: `proposed` cannot decide or render', async () => {
    const r = rig();
    run(r);
    const { isEnforceable, rendersIntoPrompt, isMatched } =
      await import('../../supervisor/learnedClauses');
    expect(isEnforceable('proposed')).toBe(false);
    expect(rendersIntoPrompt('proposed')).toBe(false);
    expect(isMatched('proposed')).toBe(false);
  });

  it('§12.1 — a second run over identical records is byte-identical and adds no file', () => {
    const r = rig();
    run(r);
    const first = clauseFiles(r).map(f => fs.readFileSync(path.join(r.corpus, f), 'utf8'));
    const shapesBefore = JSON.stringify(readShapes(r.env).shapes);

    const second = run(r);
    const after = clauseFiles(r).map(f => fs.readFileSync(path.join(r.corpus, f), 'utf8'));
    expect(after).toEqual(first);
    expect(clauseFiles(r)).toHaveLength(1);
    expect(second.line.candidates.overwritten).toBe(1);
    expect(second.line.candidates.proposed).toBe(0);
    // The fold is offset-driven, so a second run over the same bytes moves nothing.
    expect(JSON.stringify(readShapes(r.env).shapes)).toBe(shapesBefore);
  });

  it('the id carries no date, so a decline is never re-proposed under a new name (§7.3)', () => {
    const r = rig();
    run(r);
    const id = path.basename(clauseFiles(r)[0], '.md');
    // The next day, with one more matching call — the two things an id derived from the newest
    // supporting record or from the run date would both move on. Same candidate, so same filename,
    // so the human's decision about it still binds.
    fs.appendFileSync(path.join(r.dir, 'decisions.jsonl'),
      JSON.stringify(bash('pnpm test --filter api',
        { sessionId: 's-D', ts: '2026-09-04T08:00:00.000Z' })) + '\n', 'utf8');
    const second = run(r, { now: new Date('2026-09-04T19:00:00.000Z') });
    expect(clauseFiles(r).map(f => path.basename(f, '.md'))).toEqual([id]);
    expect(second.line.candidates.overwritten).toBe(1);
    expect(second.line.candidates.proposed).toBe(0);
    // `learned_at` is where the date belongs, and it did move.
    expect(fs.readFileSync(path.join(r.corpus, clauseFiles(r)[0]), 'utf8'))
      .toContain('learned_at: 2026-09-04');
  });

  it('the status guard survives that, permanently, with no side index', () => {
    const r = rig();
    run(r);
    const file = path.join(r.corpus, clauseFiles(r)[0]);
    fs.writeFileSync(file,
      fs.readFileSync(file, 'utf8').replace('status: proposed', 'status: declined'), 'utf8');

    const second = run(r);
    expect(second.line.suppressed.statusGuard).toBe(1);
    expect(second.line.candidates.proposed).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toContain('status: declined');
    // There is no suppression index anywhere: the corpus is the index.
    expect(fs.existsSync(path.join(r.dir, 'pipeline', 'suppressed.json'))).toBe(false);
  });

  it('--dry-run writes no file but reports the same proposal', () => {
    const r = rig();
    const { line } = run(r, { dryRun: true });
    expect(line.proposals.clauses).toHaveLength(1);
    expect(clauseFiles(r)).toEqual([]);
  });
});

// --------------------------------------------------------------------------- §12.22 the run line

describe('§12.22 — the zero is always explained', () => {
  it('appends exactly one line per run, always', () => {
    const r = rig();
    run(r);
    run(r);
    expect(lines(r).filter(l => l.stage === 'propose')).toHaveLength(2);
  });

  it('appends its line on emptiness and on failure, not only on success', () => {
    // The whole reason this file exists. A run that correctly produced nothing must not be
    // indistinguishable from a run that never happened — so every one of these leaves a line.
    const cases: [string, () => Rig][] = [
      ['no-input', () => rig([])],
      ['no-shape-cleared-floor', () => rig([bash('pnpm test')])],
      ['calibration-failed', () => rig([bash('git push --force origin main', {
        sessionId: 's-K', decision: 'allow', light: 'green', actor: 'policy',
        clause: 'practices §git-ok',
      })])],
      ['all-candidates-failed-replay', () => rig([...WINDOW, bash('pnpm test --filter core', {
        sessionId: 's-H', decision: 'deny', light: 'red', actor: 'human',
      })])],
    ];
    for (const [expected, build] of cases) {
      const r = build();
      const { line } = run(r);
      expect(line.exitReason, expected).toBe(expected);
      expect(lines(r).filter(l => l.stage === 'propose'), expected).toHaveLength(1);
      expect(lines(r).at(-1)!.exitReason, expected).toBe(expected);
    }
  });

  it('appends a line even when the run throws', () => {
    const r = rig();
    // A corpus root that cannot hold a file: `assertWritable` resolves through it and the write
    // fails. The run reports `error` and still leaves its account behind.
    fs.writeFileSync(path.join(r.corpus, 'blocker'), 'x', 'utf8');
    const { line } = run(r, { corpusRoot: path.join(r.corpus, 'blocker') });
    expect(line.exitReason).toBe('error');
    expect(line.error).toContain('propose:');
    expect(lines(r).filter(l => l.stage === 'propose')).toHaveLength(1);
  });

  it('omits no key and no array, on the produced-nothing line (§9.1)', () => {
    const r = rig([bash('pnpm test')]);            // one record: nothing can clear a bar
    const { line } = run(r);
    expect(line.exitReason).not.toBe('ok');
    for (const key of [
      'v', 'ts', 'runId', 'stage', 'trigger', 'rev', 'emissionRule', 'corpusRoot', 'window',
      'signals', 'shapes', 'clusters', 'candidates', 'suppressed', 'refusals', 'replay', 'ceiling',
      'declinedPromotions', 'proposals', 'model', 'durationMs', 'exitReason', 'error',
    ]) {
      expect(line, key).toHaveProperty(key);
    }
    expect(line.refusals).toEqual([]);
    expect(line.declinedPromotions).toEqual([]);
    expect(line.proposals.merges).toEqual([]);
    expect(line.proposals.retirements).toEqual([]);
    expect(line.proposals.clauses).toEqual([]);
  });

  it('says `no-input` rather than `no-shape-cleared-floor` when nothing was ever supervised', () => {
    const r = rig([]);
    const { line } = run(r);
    expect(line.exitReason).toBe('no-input');
    expect(line.window.scanned).toBe(0);
  });

  it('no output implies a non-`ok` reason, and output implies `ok`', () => {
    const base = { candidates: { proposed: 0, overwritten: 0, retired: 0, considered: 0 },
      suppressed: { failedReplay: 0, statusGuard: 0, alreadyInClaudeMd: 0 } } as unknown as RunLine;
    expect(exitReasonFor(base, 0, 0)).not.toBe('ok');
    const withOutput = { ...base,
      candidates: { ...base.candidates, proposed: 1, considered: 1 } } as RunLine;
    expect(exitReasonFor(withOutput, 1, 1)).toBe('ok');
    const capped = { ...withOutput } as RunLine;
    expect(exitReasonFor(capped, 5, 9)).toBe('caps-hit');
  });

  it('reports the window buckets apart from each other (§3.3)', () => {
    const r = rig([
      ...WINDOW,
      bash('pnpm test', { rev: undefined, sessionId: 's-u' }),
      bash('pnpm test', { rev: 'deadbee', sessionId: 's-m' }),
      { ...bash('pnpm test', { sessionId: 's-n' }), call: null },
      bash('anything', { tool: 'AskUserQuestion', sessionId: 's-x' }),
    ]);
    const { line } = run(r);
    expect(line.window.unstamped).toBe(1);
    expect(line.window.mixedRev).toBe(1);
    expect(line.window.noCall).toBe(1);
    expect(line.window.exempt).toBe(1);
    expect(line.window.rotated).toBe(false);
  });

  it('flags a rotated window, because every count is then window-scoped', () => {
    const r = rig(WINDOW.slice(0, 3), '.1');
    fs.writeFileSync(path.join(r.dir, 'decisions.jsonl'),
      WINDOW.slice(3).map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    expect(run(r).line.window.rotated).toBe(true);
  });

  it('records the declined team promotion, so the ceiling is visible (§5.3)', () => {
    const heavy = Array.from({ length: 20 }, (_, i) => bash('pnpm test', {
      sessionId: `s-t${i % 10}`,
      ts: `2026-08-${String((i % 20) + 5).padStart(2, '0')}T09:00:00.000Z`,
    }));
    const r = rig([WINDOW[0], ...heavy]);
    const { line } = run(r);
    const declined = line.declinedPromotions.find(d => d.cluster.includes('pnpm test'));
    expect(declined?.to).toBe('team');
    expect(declined?.why).toContain('single-machine corpus');
    // And it was still written, at the narrowest tier that fits, not dropped.
    expect(line.proposals.clauses[0].tier).toBe('user');
  });

  it('records every below-floor shape\'s distance from every bar (§5.2)', () => {
    const r = rig([bash('pnpm test'), bash('pnpm test')]);
    const { line } = run(r);
    expect(line.clusters.belowFloor).toBeGreaterThan(0);
    const entry = line.belowFloor[0];
    expect(entry.distances.map(d => d.tier)).toEqual(['user', 'project', 'team']);
    expect(entry.distances[0].sessions).toBeLessThan(0);
  });

  it('is stable across two identical runs, ignoring the clock', () => {
    const a = rig();
    const b = rig();
    const first = run(a).line;
    const second = run(b).line;
    expect(runFingerprint(second)).toBe(runFingerprint(first));
  });
});

// --------------------------------------------------------------------------- replay gating

describe('replay is the authority (§4.4, §12.16-12.18)', () => {
  it('§12.16 — refuses a candidate that would flip a human\'s own answer', () => {
    // Six allows on `pnpm test`, and one record where a *human* denied that very command. The
    // candidate would turn that deny into an allow, and no learned clause overturns a human.
    const r = rig([
      ...WINDOW,
      bash('pnpm test --filter core', {
        sessionId: 's-H', ts: '2026-09-02T16:05:44.000Z', decision: 'deny', light: 'red',
        actor: 'human', latencyMs: 41002,
      }),
    ]);
    const { line } = run(r);
    expect(line.candidates.proposed).toBe(0);
    expect(line.suppressed.failedReplay).toBe(1);
    expect(line.exitReason).toBe('all-candidates-failed-replay');
    expect(clauseFiles(r)).toEqual([]);
  });

  it('counts the fail-closed deny as the change, and nothing else', () => {
    // Worth pinning because `11-mine-v2.md` §11.3 gets this wrong: it reports `changed: 6,
    // advisory: 6` for this exact window. Five of those six records were already `allow`, so
    // replaying them as `allow` is not a change at all. The one decision that moves is the
    // fail-closed deny the clause exists to close — and it is *newly caught*, not a reversal,
    // because "nothing said this was safe" was never a judgement about the call.
    const { line } = run(rig());
    expect(line.candidates.proposed).toBe(1);
    expect(line.replay.changed).toBe(1);
    expect(line.replay.reversals).toBe(0);
    expect(line.replay.human_reversals).toBe(0);
    expect(line.replay.advisory).toBe(0);
  });

  it('§12.17 — a failed calibration stops the run and writes nothing', () => {
    // A record whose recorded verdict the corpus cannot reproduce: a written red denies it now, but
    // the trail says a *clause* allowed it. Nothing in this run can then be trusted.
    const r = rig([
      ...WINDOW,
      bash('git push --force origin main', {
        sessionId: 's-K', decision: 'allow', light: 'green', actor: 'policy',
        clause: 'practices §git-ok',
      }),
    ]);
    const { line } = run(r);
    expect(line.exitReason).toBe('calibration-failed');
    expect(line.replay.calibrated).toBe(false);
    expect(line.error).toContain('CALIBRATION FAILED');
    expect(clauseFiles(r)).toEqual([]);
  });

  it('§12.18 — unreplayable records are held out of `n`, never counted as unchanged', () => {
    const r = rig([...WINDOW, { ...bash('pnpm build', { sessionId: 's-nc' }), call: null }]);
    const { line } = run(r);
    expect(line.replay.unreplayable).toBe(1);
    expect(line.replay.n).toBe(WINDOW.length);
  });
});

// --------------------------------------------------------------------------- §12.23 the lock

describe('§12.23 — the lock', () => {
  it('lets Stage A exit 0 silently when it is held', () => {
    const r = rig();
    const held = acquireLock(r.env)!;
    try {
      const result = accumulate('session-end', r.env);
      expect(result.line.exitReason).toBe('lock-held');
      expect(result.nudge).toBeNull();
      // Still leaves a trace: an invisible no-op is the thing `pipeline.jsonl` exists to prevent.
      expect(lines(r).some(l => l.exitReason === 'lock-held')).toBe(true);
    } finally { held(); }
  });

  it('makes Stage B exit 2, saying so', () => {
    const r = rig();
    const held = acquireLock(r.env)!;
    try {
      const { line, exitCode } = run(r);
      expect(exitCode).toBe(2);
      expect(line.exitReason).toBe('lock-held');
      expect(clauseFiles(r)).toEqual([]);
    } finally { held(); }
  });

  it('takes over a lock whose owner is gone', () => {
    const r = rig();
    const held = acquireLock(r.env)!;
    fs.writeFileSync(path.join(r.dir, 'pipeline', 'pipeline.lock', 'owner'),
      JSON.stringify({ pid: 0x7fffffff, at: Date.now() }), 'utf8');
    const second = acquireLock(r.env);
    expect(second).not.toBeNull();
    second?.();
    held();
  });

  it('releases on the way out, so two sequential runs both work', () => {
    const r = rig();
    expect(run(r).line.exitReason).toBe('ok');
    expect(run(r).line.exitReason).toBe('ok');
  });
});

// --------------------------------------------------------------------------- Stage A

describe('Stage A on its own', () => {
  it('folds, nudges once, and proposes nothing', () => {
    const r = rig();
    const result = accumulate('session-end', r.env);
    expect(result.line.stage).toBe('accumulate');
    expect(result.line.candidates.proposed).toBe(0);
    expect(result.nudge).toContain('crossed the support floor');
    expect(clauseFiles(r)).toEqual([]);
  });

  it('says `no-new-records` on a second fold rather than going quiet', () => {
    const r = rig();
    accumulate('session-end', r.env);
    const second = accumulate('session-end', r.env);
    expect(second.line.exitReason).toBe('no-new-records');
    expect(second.nudge).toBeNull();
  });

  it('does not nudge twice for the same crossing', () => {
    const r = rig();
    expect(accumulate('session-end', r.env).nudge).not.toBeNull();
    expect(accumulate('session-end', r.env).nudge).toBeNull();
  });
});

// --------------------------------------------------------------------------- reporting surfaces

describe('the surfaces a human reads', () => {
  it('opens with the arithmetic', () => {
    const { line } = run(rig());
    expect(headlineFor(line)).toMatch(/^clauses: \+1 −0 merge 0 = net 1/);
  });

  it('lists the last runs newest-first', () => {
    const r = rig();
    run(r);
    accumulate('cli', r.env);
    const recent = recentRuns(5, r.env);
    expect(recent[0].stage).toBe('accumulate');
    expect(recent.length).toBeGreaterThan(1);
  });

  it('nags when `learn` has gone stale, and not before', () => {
    const r = rig();
    run(r);
    expect(stalenessLine(new Date('2026-09-04T00:00:00Z'), r.env)).toBeNull();
    expect(stalenessLine(new Date('2026-09-20T00:00:00Z'), r.env)).toContain('last `learn`');
  });

  it('says nothing at all when the pipeline has never run', () => {
    expect(stalenessLine(new Date(), rig([]).env)).toBeNull();
  });

  it('appends a line that round-trips as JSON', () => {
    const r = rig();
    const { line } = run(r);
    appendRunLine(line, r.env);
    expect(lines(r).at(-1)!.runId).toBe(line.runId);
  });
});
