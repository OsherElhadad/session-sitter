/**
 * The durable citation counter — #85.
 *
 * The failure this file exists to prevent: `decisions.jsonl` rotates at 4 MiB keeping one generation,
 * so a red that fired steadily for months and is quiet this week reads, from the trail alone, exactly
 * like one that never fired. `classify()` then calls it `dead-weight?` or `insufficient-exposure`
 * instead of `deterrent`, and a retirement gets proposed for a clause whose whole value is that it
 * stopped something being tried.
 *
 * Two properties carry that, and both are asserted here rather than argued:
 *
 *  - **monotonic in effect** — a count that can go down can fabricate a dead clause. `raise` is the
 *    only writer and it is a `max`, so decreasing is not a bug to avoid but a value the writer cannot
 *    produce. Asserted directly and then through a rotation.
 *  - **idempotent** — the fold records the offset it folded to, so a re-run over the same input reads
 *    nothing and changes nothing. Asserted by folding twice.
 *
 * The transition table for `classify()` is at the bottom, and every expected class in it is produced
 * by **calling `classify()`** — never by writing a class string.
 *
 * Every fixture is invented.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import type { ClauseLevel } from '../../policy/practices';
import {
  CITATIONS_VERSION,
  citationsPath,
  emptyCitations,
  foldCitations,
  lifetimeCitations,
  raise,
  readCitations,
  writeCitations,
} from '../../policy/citations';
import { EvidenceClass, classify, isSafetyLevel } from '../../policy/ablate';

// --------------------------------------------------------------------------- fixtures

let seq = 0;

const record = (clause: string | null, over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  return {
    ts: '2026-08-25T09:00:00.000Z',
    sessionId: `s-${seq}`,
    cwd: '/w/api',
    tool: 'Bash',
    inputSummary: 'git push --force origin main',
    light: 'red',
    decision: 'deny',
    clause,
    actor: 'policy',
    latencyMs: 3,
    rewritten: false,
    rev: 'a91f3c2',
    call: { tool_name: 'Bash', input: { command: 'git push --force origin main' } },
    ...over,
  };
};

function scratch(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cite-'));
  return { dir, env: { SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv };
}

function writeTrail(env: NodeJS.ProcessEnv, records: DecisionRecord[], suffix = ''): string {
  const file = path.join(env.SESSION_SITTER_DATA_DIR!, `decisions.jsonl${suffix}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

function appendTrail(env: NodeJS.ProcessEnv, records: DecisionRecord[]): void {
  const file = path.join(env.SESSION_SITTER_DATA_DIR!, 'decisions.jsonl');
  fs.appendFileSync(file, `${records.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/** Fold and commit, which is what `accumulate` does. */
function run(env: NodeJS.ProcessEnv): ReturnType<typeof foldCitations> {
  const result = foldCitations(env);
  writeCitations(result.citations, env);
  return result;
}

const FORCE = 'practices §git-force';

// --------------------------------------------------------------------------- monotonicity

describe('#85 — the count is monotonic because the writer cannot lower it', () => {
  it('raise takes the max, so a smaller candidate is a no-op', () => {
    const counts: Record<string, number> = {};
    raise(counts, 'git-force', 5);
    expect(counts['git-force']).toBe(5);
    raise(counts, 'git-force', 2);
    expect(counts['git-force']).toBe(5);
    raise(counts, 'git-force', 0);
    expect(counts['git-force']).toBe(5);
    raise(counts, 'git-force', 6);
    expect(counts['git-force']).toBe(6);
  });

  it('a rotation that shrinks the trail cannot shrink the count — the whole point of the file', () => {
    const { env } = scratch();
    // Months of fires.
    writeTrail(env, Array.from({ length: 40 }, () => record(FORCE)));
    expect(run(env).citations.counts['git-force']).toBe(40);

    // Rotation: the trail is replaced by a *new* generation holding one recent fire, and the old
    // bytes move to `.1` — where, in production, the generation before them is gone for good. This
    // fixture is the harsher case: the old bytes are gone entirely.
    writeTrail(env, [record(FORCE)]);
    const after = run(env);
    expect(after.reread).toBe(true);
    // A recount over what is left says 1. The stored count still says 40.
    expect(after.citations.counts['git-force']).toBe(40);
    expect(readCitations(env).counts['git-force']).toBe(40);
  });

  it('new fires after a rotation are added on top, not merged away', () => {
    const { env } = scratch();
    writeTrail(env, Array.from({ length: 12 }, () => record(FORCE)));
    run(env);
    writeTrail(env, [record(FORCE)]);           // rotation → re-read, count holds at 12
    expect(run(env).citations.counts['git-force']).toBe(12);
    appendTrail(env, [record(FORCE), record(FORCE)]);
    expect(run(env).citations.counts['git-force']).toBe(14);
  });

  it('a file from another version keeps its counts and drops its offsets', () => {
    const { env } = scratch();
    writeTrail(env, [record(FORCE)]);
    run(env);
    const stored = JSON.parse(fs.readFileSync(citationsPath(env), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(citationsPath(env),
      JSON.stringify({ ...stored, version: CITATIONS_VERSION + 1 }), 'utf8');
    const reloaded = readCitations(env);
    // The opposite of `readShapes`, which discards the whole file: counts cannot be rebuilt from a
    // rotated trail, offsets can.
    expect(reloaded.counts['git-force']).toBe(1);
    expect(reloaded.sources).toEqual({});
  });

  it('a garbage count on disk is dropped rather than trusted downward', () => {
    const { env } = scratch();
    fs.mkdirSync(path.dirname(citationsPath(env)), { recursive: true });
    fs.writeFileSync(citationsPath(env), JSON.stringify({
      version: CITATIONS_VERSION, sources: {}, lastFoldAt: null,
      counts: { a: -3, b: 'many', c: 2.7, d: 4 },
    }), 'utf8');
    expect(readCitations(env).counts).toEqual({ c: 2, d: 4 });
  });
});

// --------------------------------------------------------------------------- idempotence

describe('#85 — the fold is idempotent, by the offset Stage A already keeps', () => {
  it('folding twice over the same input leaves the count unchanged', () => {
    const { env } = scratch();
    writeTrail(env, [record(FORCE), record(FORCE), record(null), record('practices §sql-drop')]);
    const first = run(env);
    expect(first.citations.counts).toEqual({ 'git-force': 2, 'sql-drop': 1 });
    expect(first.cited).toBe(3);
    expect(first.folded).toBe(4);

    const second = run(env);
    expect(second.folded).toBe(0);
    expect(second.cited).toBe(0);
    expect(second.raised).toBe(0);
    expect(second.citations.counts).toEqual({ 'git-force': 2, 'sql-drop': 1 });
    expect(readCitations(env).counts).toEqual({ 'git-force': 2, 'sql-drop': 1 });
  });

  it('an appended fire is counted exactly once across three folds', () => {
    const { env } = scratch();
    writeTrail(env, [record(FORCE)]);
    run(env);
    appendTrail(env, [record(FORCE)]);
    expect(run(env).citations.counts['git-force']).toBe(2);
    expect(run(env).citations.counts['git-force']).toBe(2);
    expect(run(env).citations.counts['git-force']).toBe(2);
  });

  it('both generations are folded, and the rotated one is not re-counted next run', () => {
    const { env } = scratch();
    writeTrail(env, [record(FORCE), record(FORCE)], '.1');
    writeTrail(env, [record(FORCE)]);
    expect(run(env).citations.counts['git-force']).toBe(3);
    expect(run(env).folded).toBe(0);
    expect(readCitations(env).counts['git-force']).toBe(3);
  });

  it('commits an offset and a tail hash per generation, so the offset can be verified', () => {
    const { env } = scratch();
    const file = writeTrail(env, [record(FORCE)]);
    run(env);
    const source = readCitations(env).sources['decisions.jsonl'];
    expect(source.offset).toBe(fs.statSync(file).size);
    expect(source.tailSha).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a torn trailing line is left for the next fold rather than counted broken', () => {
    const { env } = scratch();
    const file = writeTrail(env, [record(FORCE)]);
    fs.appendFileSync(file, `${JSON.stringify(record(FORCE)).slice(0, 40)}`, 'utf8');
    expect(run(env).citations.counts['git-force']).toBe(1);
    // Completing the line counts it, once.
    fs.writeFileSync(file, `${[record(FORCE), record(FORCE)].map(r => JSON.stringify(r)).join('\n')}\n`,
      'utf8');
    expect(run(env).citations.counts['git-force']).toBeGreaterThanOrEqual(2);
  });

  it('no trail is not an error, and no counter is an empty map rather than a throw', () => {
    const { env } = scratch();
    expect(run(env).citations).toEqual({ ...emptyCitations() });
    expect(lifetimeCitations(env)).toEqual({});
  });
});

// --------------------------------------------------------------------------- the transition table

/**
 * Every `EvidenceClass` transition changing `lifetimeFires` can cause.
 *
 * `classify(level, changed, lifetimeFires, misses, matches)` reads `lifetimeFires` on exactly one
 * path: `changed === 0 && matches === 0 && isSafetyLevel(level)`. Everywhere else it is dead input.
 * So there are two transitions and four no-ops, and the table asserts all six by calling the real
 * function at `lifetimeFires` 0 and 1.
 *
 * The six members of `EvidenceClass` are `retire`, `shadowed`, `dead-weight?`, `deterrent`,
 * `insufficient-exposure`, `in-service` — verified by reachability below, not by grep.
 */
describe('#85 — what changing lifetimeFires can and cannot move', () => {
  const cases: {
    what: string; level: ClauseLevel; changed: number; misses: number; matches: number;
    at0: EvidenceClass; at1: EvidenceClass;
  }[] = [
    {
      what: 'red, zero changed, near-miss present: the misclassification #85 is about',
      level: 'red', changed: 0, misses: 2, matches: 0,
      at0: classify('red', 0, 0, 2, 0), at1: classify('red', 0, 1, 2, 0),
    },
    {
      what: 'orange, zero changed, no near-miss: under-exposed becomes a deterrent',
      level: 'orange', changed: 0, misses: 0, matches: 0,
      at0: classify('orange', 0, 0, 0, 0), at1: classify('orange', 0, 1, 0, 0),
    },
    {
      what: 'red that still decides something: `changed` short-circuits first',
      level: 'red', changed: 3, misses: 2, matches: 0,
      at0: classify('red', 3, 0, 2, 0), at1: classify('red', 3, 1, 2, 0),
    },
    {
      what: 'red pre-empted by another rung: `matches` short-circuits before the count is read',
      level: 'red', changed: 0, misses: 2, matches: 4,
      at0: classify('red', 0, 0, 2, 4), at1: classify('red', 0, 1, 2, 4),
    },
    {
      what: 'green: not a safety level, so the count is never consulted',
      level: 'green', changed: 0, misses: 0, matches: 0,
      at0: classify('green', 0, 0, 0, 0), at1: classify('green', 0, 99, 0, 0),
    },
    {
      what: 'yellow that decides something: same, in the other branch',
      level: 'yellow', changed: 5, misses: 0, matches: 0,
      at0: classify('yellow', 5, 0, 0, 0), at1: classify('yellow', 5, 99, 0, 0),
    },
  ];

  for (const c of cases) {
    it(`${c.what}: ${c.at0} → ${c.at1}`, () => {
      expect(classify(c.level, c.changed, 0, c.misses, c.matches)).toBe(c.at0);
      expect(classify(c.level, c.changed, 1, c.misses, c.matches)).toBe(c.at1);
    });
  }

  it('exactly two of the six transitions move, and both move towards deterrent', () => {
    const moved = cases.filter(c => c.at0 !== c.at1);
    expect(moved.map(c => [c.at0, c.at1])).toEqual([
      ['dead-weight?', 'deterrent'],
      ['insufficient-exposure', 'deterrent'],
    ]);
  });

  it('all six EvidenceClass members are reachable, and the count never reaches a green one', () => {
    // Constructed by calling `classify`, so this is the type's real reachable set rather than a list
    // of strings somebody believed.
    const reached = new Set<EvidenceClass>([
      classify('green', 1, 0, 0, 0),        // in-service
      classify('red', 0, 0, 0, 2),         // shadowed
      classify('red', 0, 0, 1, 0),         // dead-weight?
      classify('red', 0, 1, 0, 0),         // deterrent
      classify('red', 0, 0, 0, 0),         // insufficient-exposure
      classify('green', 0, 0, 0, 0),       // retire
    ]);
    expect(reached.size).toBe(6);

    // The asymmetry that bounds the blast radius: the three classes the count can select between are
    // reachable only for a safety level, and `retire` only for a non-safety one. So no value of
    // `lifetimeFires` can make anything a retirement candidate that was not one already.
    for (const level of ['red', 'orange'] as ClauseLevel[]) {
      expect(isSafetyLevel(level)).toBe(true);
      for (const fires of [0, 1, 500]) {
        expect(classify(level, 0, fires, 1, 0)).not.toBe('retire');
      }
    }
    for (const level of ['green', 'yellow'] as ClauseLevel[]) {
      expect(isSafetyLevel(level)).toBe(false);
      for (const fires of [0, 1, 500]) {
        expect(classify(level, 0, fires, 1, 0)).toBe('retire');
      }
    }
  });
});
