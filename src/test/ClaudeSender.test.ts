import { describe, it, expect, vi } from 'vitest';

// ClaudeSender imports 'vscode' (and ClaudeInspector, which imports it too); stub it.
vi.mock('vscode', () => ({ window: {}, extensions: { getExtension: () => undefined } }));

import { buildClaudeUserMessage, buildInjectFn } from '../agents/ClaudeSender';

describe('buildClaudeUserMessage', () => {
  it('produces the exact envelope Claude writes to the CLI', () => {
    expect(buildClaudeUserMessage('hello')).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    });
  });

  it('preserves text with quotes and newlines verbatim', () => {
    const text = 'say "hi"\nthen stop';
    const env = buildClaudeUserMessage(text) as { message: { content: { text: string }[] } };
    expect(env.message.content[0].text).toBe(text);
  });
});

describe('buildInjectFn', () => {
  it('embeds the JSON payload as a safely-escaped literal and appends a newline', () => {
    const fn = buildInjectFn('say "hi"\nbye');
    // The payload is embedded as a JSON-encoded string literal, so the raw quote/newline
    // in the text must NOT appear unescaped in the function source.
    expect(fn).not.toContain('say "hi"\nbye');
    // Newline is written via char code 10 (no literal newline injected into the write).
    expect(fn).toContain('String.fromCharCode(10)');
    // v1 single-channel guardrails are present.
    expect(fn).toContain("'no-channel'");
    expect(fn).toContain("'ambiguous:'");
    expect(fn).toContain('query.transport');
  });

  it('round-trips the embedded literal back to the envelope', () => {
    const fn = buildInjectFn('hello');
    // Extract the `var payload = <literal>;` and evaluate the literal as JSON-of-JSON.
    const m = fn.match(/var payload = (".*?");\n/s);
    expect(m).not.toBeNull();
    const jsonString = JSON.parse(m![1]) as string; // outer: JS string literal → JSON string
    expect(JSON.parse(jsonString)).toEqual(buildClaudeUserMessage('hello'));
  });
});
