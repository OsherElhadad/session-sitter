import { describe, it, expect, vi } from 'vitest';

// ClaudeApprover imports ClaudeInspector which imports 'vscode'; stub it.
vi.mock('vscode', () => ({ window: {}, extensions: { getExtension: () => undefined } }));

import { claudeDecisionToPayload, buildResolveFn, parseClaudePending, buildQuestionResolveFn } from '../agents/ClaudeApprover';

describe('claudeDecisionToPayload', () => {
  it('maps approveOnce to allow, echoing the original inputs as updatedInput', () => {
    expect(claudeDecisionToPayload('approveOnce', { command: 'ls' })).toEqual({
      result: { behavior: 'allow', updatedInput: { command: 'ls' } },
    });
  });

  it('maps approveForTask to allow as well (Claude has no per-task persistence here)', () => {
    expect(claudeDecisionToPayload('approveForTask', { a: 1 })).toEqual({
      result: { behavior: 'allow', updatedInput: { a: 1 } },
    });
  });

  it('maps reject to deny with a message', () => {
    expect(claudeDecisionToPayload('reject', { command: 'rm -rf /' })).toEqual({
      result: { behavior: 'deny', message: 'Denied by the session supervisor' },
    });
  });

  it('defaults updatedInput to {} when inputs are missing', () => {
    expect(claudeDecisionToPayload('approveOnce', undefined)).toEqual({
      result: { behavior: 'allow', updatedInput: {} },
    });
  });
});

describe('buildResolveFn', () => {
  it('embeds requestId and payload as safely-escaped JSON literals', () => {
    const fn = buildResolveFn('req"1', { result: { behavior: 'deny', message: 'no' } });
    expect(fn).not.toContain('req"1');            // raw quote must be escaped
    expect(fn).toContain('outstandingRequests');
    expect(fn).toContain('.resolve(payload)');
    // also dismisses the orphaned webview prompt card
    expect(fn).toContain('cancel_request');
    // payload round-trips
    const m = fn.match(/var payload = (\{.*?\});\n/s);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual({ result: { behavior: 'deny', message: 'no' } });
  });
});

describe('buildQuestionResolveFn', () => {
  it('embeds answers, echoes captured inputs, resolves allow, and dismisses the card', () => {
    const fn = buildQuestionResolveFn('req-1', { 'Pick': ['A', 'B'] });
    expect(fn).toContain('outstandingRequests');
    expect(fn).toContain('behavior');
    expect(fn).toContain('allow');
    expect(fn).toContain('answers');
    expect(fn).toContain('"Pick"');                        // the answers map is embedded
    expect(fn).toContain('__sessionSitter_claudePerms');   // reads captured inputs
    expect(fn).toContain('cancel_request');                // dismisses the orphaned card
    expect(fn).toContain('.resolve(payload)');
  });
});

describe('parseClaudePending', () => {
  it('parses a valid array', () => {
    const raw = JSON.stringify([{ requestId: 'r1', toolName: 'Bash', argsText: '{}', permission: '', hasCommandUse: false, taskId: 'c1' }]);
    expect(parseClaudePending(raw)).toHaveLength(1);
    expect(parseClaudePending(raw)[0].toolName).toBe('Bash');
  });
  it('returns [] for an error object, non-array, or garbage', () => {
    expect(parseClaudePending(JSON.stringify({ err: 'x' }))).toEqual([]);
    expect(parseClaudePending('not json')).toEqual([]);
    expect(parseClaudePending(undefined)).toEqual([]);
  });
});
