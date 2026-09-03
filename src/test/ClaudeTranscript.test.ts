import { describe, it, expect, vi } from 'vitest';

// SessionExporter → BobApprover → BobInspector imports 'vscode'; stub it.
vi.mock('vscode', () => ({ window: {}, extensions: {} }));

import { buildClaudeTranscript, type ClaudeSessionMeta } from '../SessionExporter';
import type { PendingApproval } from '../agents/BobApprover';

const session: ClaudeSessionMeta = {
  sessionId: 'sess-1', projectName: 'session-sitter', projectPath: '/home/me/session-sitter', status: 'working', title: 'demo',
};

function lines(...records: unknown[]): string[] {
  return records.map(r => JSON.stringify(r));
}

describe('buildClaudeTranscript', () => {
  it('builds text turns from user/assistant records and marks source claude', () => {
    const t = buildClaudeTranscript(session, lines(
      { type: 'user', timestamp: 'T1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', timestamp: 'T2', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
    ));
    expect(t.source).toBe('claude');
    expect(t.sessionId).toBe('sess-1');
    expect(t.turns.map(x => [x.role, x.text])).toEqual([['user', 'hello'], ['assistant', 'hi there']]);
  });

  it('extracts tool_use as toolCalls and tool_result as toolResult', () => {
    const t = buildClaudeTranscript(session, lines(
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'running' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt', is_error: false },
      ] } },
    ));
    expect(t.turns[0].toolCalls).toEqual([{ id: 'tu1', name: 'Bash', arguments: { command: 'ls' }, permission: null }]);
    expect(t.turns[1].toolResult).toEqual({ callId: 'tu1', name: '', permission: null, isError: false, content: 'file.txt' });
  });

  it('uses a live pending approval as the pending action with the Claude label + requestId', () => {
    const pending: PendingApproval = { requestId: 'r9', toolName: 'Bash', argsText: '{"command":"rm x"}', permission: '', hasCommandUse: false, taskId: 'chan-1' };
    const t = buildClaudeTranscript(session, lines(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'go' }] } },
    ), pending);
    expect(t.pendingAction?.requestId).toBe('r9');
    expect(t.pendingAction?.name).toBe('Bash');
    expect(t.pendingAction?.description).toContain('Claude');
    expect(t.pendingAction?.arguments).toEqual({ command: 'rm x' });
  });

  it('ignores blank lines, malformed JSON, and non user/assistant records', () => {
    const t = buildClaudeTranscript(session, [
      '', 'not json', JSON.stringify({ type: 'summary', text: 'x' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'kept' } }),
    ]);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].text).toBe('kept');
  });
});

// ── Yield assertion: a parse failure must not look like an empty transcript ──────
describe('buildClaudeTranscript yield assertion', () => {
  it('throws when every record has an unrecognised type, naming the counts', () => {
    const call = () => buildClaudeTranscript(session, lines(
      { type: 'human', message: { role: 'user', content: 'hello' } },
      { type: 'model', message: { role: 'assistant', content: 'hi' } },
    ));
    expect(call).toThrow(/produced no turns/);
    expect(call).toThrow(/2 non-empty line\(s\), 2 record\(s\) parsed, 0 turn\(s\)/);
    expect(call).toThrow(/record type values changed/);
  });

  it('throws when no line parses as JSON, and blames the envelope', () => {
    const call = () => buildClaudeTranscript(session, ['not json', '{oops']);
    expect(call).toThrow(/2 non-empty line\(s\), 0 record\(s\) parsed, 0 turn\(s\)/);
    expect(call).toThrow(/transcript envelope changed/);
  });

  it('does not throw on a genuinely empty session file', () => {
    expect(buildClaudeTranscript(session, []).turns).toEqual([]);
    expect(buildClaudeTranscript(session, ['', '   ', '\n']).turns).toEqual([]);
  });
});
