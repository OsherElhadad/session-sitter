import { describe, it, expect, vi } from 'vitest';

// BobApprover.ts → BobInspector.ts imports 'vscode' at module load; stub it
// (unused by the pure helper under test).
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));

import { decisionToPayload } from '../agents/BobApprover';

describe('decisionToPayload', () => {
  it('approveOnce → allowOnce only', () => {
    expect(decisionToPayload('approveOnce', false)).toEqual({ allowOnce: true });
  });

  it('reject → allowOnce false', () => {
    expect(decisionToPayload('reject', false)).toEqual({ allowOnce: false });
    // hasCommandUse is irrelevant for reject
    expect(decisionToPayload('reject', true)).toEqual({ allowOnce: false });
  });

  it('approveForTask (no command) → allowOnce + groupApproved', () => {
    expect(decisionToPayload('approveForTask', false)).toEqual({ allowOnce: true, groupApproved: true });
  });

  it('approveForTask (execute command) → also persists the command', () => {
    expect(decisionToPayload('approveForTask', true)).toEqual({
      allowOnce: true, groupApproved: true, alwaysApproveCommand: true,
    });
  });
});
