import { describe, it, expect, vi } from 'vitest';

// QuestionProbe imports inspector modules that import 'vscode'; stub it.
vi.mock('vscode', () => ({ window: {}, extensions: { all: [], getExtension: () => undefined } }));

import {
  parseProbeJson,
  BOB_QUESTION_PROBE_FN,
  BOB_QUESTION_PROBE_FULL_FN,
  CLAUDE_QUESTION_PROBE_FN,
  CLAUDE_QUESTION_HOOK_INSTALL_FN,
  CLAUDE_QUESTION_CAPTURE_FN,
  CLAUDE_ANSWER_HOOK_INSTALL_FN,
  CLAUDE_ANSWER_CAPTURE_FN,
} from '../agents/QuestionProbe';

describe('parseProbeJson', () => {
  it('parses valid JSON', () => {
    expect(parseProbeJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('returns a parseError object for a non-string', () => {
    expect(parseProbeJson(undefined)).toEqual({ parseError: 'not-a-string' });
  });
  it('returns a parseError object for malformed JSON', () => {
    const out = parseProbeJson('{bad');
    expect(out).toHaveProperty('parseError');
  });
});

describe('BOB_QUESTION_PROBE_FN', () => {
  it('reads requestsWaiting and never mutates (no emit/resolve/write)', () => {
    expect(BOB_QUESTION_PROBE_FN).toContain('requestsWaiting');
    expect(BOB_QUESTION_PROBE_FN).toContain('ask_followup_question');
    expect(BOB_QUESTION_PROBE_FN).not.toContain('.emit(');
    expect(BOB_QUESTION_PROBE_FN).not.toContain('.resolve(');
    expect(BOB_QUESTION_PROBE_FN).not.toContain('.write(');
  });
});

describe('BOB_QUESTION_PROBE_FULL_FN', () => {
  it('dumps waiting tools + approvalQueue + requestContexts read-only', () => {
    expect(BOB_QUESTION_PROBE_FULL_FN).toContain('requestsWaiting');
    expect(BOB_QUESTION_PROBE_FULL_FN).toContain('approvalQueue');
    expect(BOB_QUESTION_PROBE_FULL_FN).toContain('requestContexts');
    expect(BOB_QUESTION_PROBE_FULL_FN).not.toContain('.emit(');
  });
});

describe('CLAUDE_QUESTION_PROBE_FN', () => {
  it('walks outstandingRequests read-only and captures request payloads', () => {
    expect(CLAUDE_QUESTION_PROBE_FN).toContain('outstandingRequests');
    expect(CLAUDE_QUESTION_PROBE_FN).not.toContain('.resolve(');
    expect(CLAUDE_QUESTION_PROBE_FN).not.toContain('t.write(');
  });
});

describe('CLAUDE_QUESTION_HOOK_INSTALL_FN', () => {
  it('wraps comm.send observationally — records then always delegates to the original', () => {
    expect(CLAUDE_QUESTION_HOOK_INSTALL_FN).toContain('comm.send');
    expect(CLAUDE_QUESTION_HOOK_INSTALL_FN).toContain('orig.apply');
    // observational only: it must never resolve/reject a request
    expect(CLAUDE_QUESTION_HOOK_INSTALL_FN).not.toContain('.resolve(');
    expect(CLAUDE_QUESTION_HOOK_INSTALL_FN).not.toContain('.reject(');
  });
});

describe('CLAUDE_QUESTION_CAPTURE_FN', () => {
  it('joins outstandingRequests with recorded payloads read-only', () => {
    expect(CLAUDE_QUESTION_CAPTURE_FN).toContain('outstandingRequests');
    expect(CLAUDE_QUESTION_CAPTURE_FN).not.toContain('.resolve(');
    expect(CLAUDE_QUESTION_CAPTURE_FN).not.toContain('.send(');
  });
});

describe('CLAUDE_ANSWER_HOOK_INSTALL_FN', () => {
  it('wraps only AskUserQuestion deferreds and always delegates to the original resolve', () => {
    expect(CLAUDE_ANSWER_HOOK_INSTALL_FN).toContain('AskUserQuestion');
    expect(CLAUDE_ANSWER_HOOK_INSTALL_FN).toContain('outstandingRequests');
    expect(CLAUDE_ANSWER_HOOK_INSTALL_FN).toContain('origResolve.apply');
    // observational: it records the answer then delegates; it must never reject.
    expect(CLAUDE_ANSWER_HOOK_INSTALL_FN).not.toContain('.reject(');
  });
});

describe('CLAUDE_ANSWER_CAPTURE_FN', () => {
  it('dumps the recorded answers map read-only', () => {
    expect(CLAUDE_ANSWER_CAPTURE_FN).toContain('__csw_claudeAnswers');
    expect(CLAUDE_ANSWER_CAPTURE_FN).not.toContain('.resolve(');
  });
});
