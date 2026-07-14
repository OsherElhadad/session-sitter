import { describe, it, expect, vi } from 'vitest';

// AutoResponder.ts imports 'vscode' at module load; stub it.
vi.mock('vscode', () => ({ window: { createOutputChannel: vi.fn() } }));

import { matchRule, messageKey } from '../AutoResponder';
import type { AutoRespondRule } from '../BobSender';
import type { MessageExchange } from '../SessionManager';

const rules: AutoRespondRule[] = [
  { matchPattern: 'Do you want to continue', response: 'yes' },
  { matchPattern: 'Proceed\\?', response: 'y' },
];

describe('matchRule', () => {
  it('matches a plain substring pattern', () => {
    expect(matchRule('Do you want to continue?', rules)?.response).toBe('yes');
  });
  it('matches a regex pattern', () => {
    expect(matchRule('Proceed?', rules)?.response).toBe('y');
  });
  it('returns undefined when nothing matches', () => {
    expect(matchRule('All done.', rules)).toBeUndefined();
  });
  it('ignores an invalid regex without throwing', () => {
    expect(matchRule('anything', [{ matchPattern: '(', response: 'x' }])).toBeUndefined();
  });
});

describe('messageKey', () => {
  it('uses the timestamp when present', () => {
    const ex: MessageExchange = { role: 'assistant', text: 'hi', timestamp: '2026-07-14T10:00:00Z' };
    expect(messageKey(ex)).toBe('2026-07-14T10:00:00Z');
  });
  it('falls back to the text when no timestamp', () => {
    expect(messageKey({ role: 'assistant', text: 'hi' })).toBe('hi');
  });
});
