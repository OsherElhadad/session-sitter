import { describe, it, expect, vi } from 'vitest';


// BobInspector.ts imports 'vscode' and 'inspector' at module load; stub the
// parts unused by the pure helpers under test.
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));

import { parseOpenTaskIds, runExclusive } from '../agents/BobInspector';

describe('parseOpenTaskIds', () => {
  it('parses a JSON array of ids', () => {
    expect(parseOpenTaskIds('["a","b"]')).toEqual(['a', 'b']);
  });

  it('dedupes and drops empty/non-string entries', () => {
    expect(parseOpenTaskIds('["a","a","",1,null,"b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for a non-string input (inspector failure → undefined)', () => {
    expect(parseOpenTaskIds(undefined)).toEqual([]);
    expect(parseOpenTaskIds(42)).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseOpenTaskIds('not json')).toEqual([]);
  });

  it('returns [] when the JSON is not an array', () => {
    expect(parseOpenTaskIds('{"taskId":"a"}')).toEqual([]);
  });
});

describe('runExclusive (inspector serialization)', () => {
  it('serializes overlapping calls — no interleave', async () => {
    const events: string[] = [];
    const task = (id: string) => async () => {
      events.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`${id}:end`);
      return id;
    };
    // Both queued synchronously before either resolves.
    const p1 = runExclusive(task('A'));
    const p2 = runExclusive(task('B'));
    const results = await Promise.all([p1, p2]);
    expect(results).toEqual(['A', 'B']);
    // Strict ordering proves B did not start until A finished.
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('a rejecting run does not wedge the queue', async () => {
    await expect(runExclusive(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next call still runs (the chain was not left in a rejected state).
    await expect(runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the fn result to the caller', async () => {
    await expect(runExclusive(async () => 42)).resolves.toBe(42);
  });

  it('preserves FIFO order under load', async () => {
    const order: number[] = [];
    const calls = Array.from({ length: 8 }, (_, i) =>
      runExclusive(async () => { await new Promise((r) => setTimeout(r, 1)); order.push(i); }),
    );
    await Promise.all(calls);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
