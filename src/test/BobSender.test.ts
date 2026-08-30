import { describe, it, expect, vi } from 'vitest';

// BobSender.ts imports 'vscode' at module load; stub it (unused by the pure helper).
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));
// Mock the shared inspector helper so we can assert send() delegates without touching V8.
vi.mock('../agents/BobInspector', () => ({
  callOnBobTaskManager: vi.fn(async () => undefined),
  pickClosureTaskManager: (probes: Array<{ name: string; isTaskManager: boolean }>) =>
    probes.find(p => p.isTaskManager)?.name,
}));

import { InspectorBobSender, pickClosureTaskManager, shouldAttemptSend } from '../agents/BobSender';
import { callOnBobTaskManager } from '../agents/BobInspector';

describe('InspectorBobSender.send', () => {
  it('no-ops on empty input (guard) without touching the inspector', async () => {
    const mock = vi.mocked(callOnBobTaskManager);
    mock.mockClear();
    const logs: string[] = [];
    await new InspectorBobSender((m) => logs.push(m)).send('', 'hi');
    expect(mock).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('skipped'))).toBe(true);
  });

  it('delegates a valid send to callOnBobTaskManager (awaitPromise=true)', async () => {
    const mock = vi.mocked(callOnBobTaskManager);
    mock.mockClear();
    await new InspectorBobSender(() => { /* noop */ }).send('task-1', 'hello');
    expect(mock).toHaveBeenCalledTimes(1);
    const call = mock.mock.calls[0];
    expect(call[2]).toEqual(['task-1', 'hello']); // args passed by value
    expect(call[3]).toBe(true);                    // awaitPromise
  });
});

describe('shouldAttemptSend', () => {
  it('accepts a non-empty taskId + text', () => {
    expect(shouldAttemptSend('task-1', 'hello')).toBe(true);
  });
  it('rejects empty/blank/non-string inputs', () => {
    expect(shouldAttemptSend('', 'hi')).toBe(false);
    expect(shouldAttemptSend('t', '   ')).toBe(false);
    expect(shouldAttemptSend(undefined, 'hi')).toBe(false);
    expect(shouldAttemptSend('t', 42)).toBe(false);
  });
});

describe('pickClosureTaskManager', () => {
  it('returns the name of the first TaskManager-like closure var', () => {
    const probes = [
      { name: 'e', isTaskManager: false },
      { name: 't', isTaskManager: true },
    ];
    expect(pickClosureTaskManager(probes)).toBe('t');
  });

  it('returns undefined when no probe is a TaskManager', () => {
    expect(pickClosureTaskManager([{ name: 'e', isTaskManager: false }])).toBeUndefined();
  });

  it('returns undefined for an empty probe list', () => {
    expect(pickClosureTaskManager([])).toBeUndefined();
  });
});
