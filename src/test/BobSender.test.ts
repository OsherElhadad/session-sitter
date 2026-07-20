import { describe, it, expect, vi } from 'vitest';

// BobSender.ts imports 'vscode' at module load; stub it (unused by the pure helper).
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));

import { pickClosureTaskManager } from '../BobSender';

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
