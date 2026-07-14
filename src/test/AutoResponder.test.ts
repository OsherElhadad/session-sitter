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

import { AutoResponder } from '../AutoResponder';
import type { BobSender } from '../BobSender';
import type { ClaudeSession } from '../SessionManager';

function bobSession(id: string): ClaudeSession {
  return { sessionId: id, projectName: 'p', projectPath: '/p', title: 't',
    updatedAt: new Date(), status: 'idle', source: 'bob' };
}

class FakeSender implements BobSender {
  public calls: Array<{ taskId: string; text: string }> = [];
  async isAvailable() { return true; }
  async send(taskId: string, text: string) { this.calls.push({ taskId, text }); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeManager(exchanges: Record<string, any[]>) {
  return {
    onDidChangeSessions: () => ({ dispose() {} }),
    getSessions: () => [] as ClaudeSession[],
    getRecentExchanges: async (id: string) => exchanges[id] ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('AutoResponder dedup', () => {
  const rules = [{ matchPattern: 'continue', response: 'yes' }];

  it('fires once on a matching assistant message', async () => {
    const ex = { assistant: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('assistant'));
    expect(sender.calls).toEqual([{ taskId: 'assistant', text: 'yes' }]);
  });

  it('does not re-fire for the same message key', async () => {
    const ex = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls.length).toBe(1);
  });

  it('does not fire when the latest message is from the user', async () => {
    const ex = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }, { role: 'user', text: 'ok', timestamp: 'T2' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls.length).toBe(0);
  });

  it('re-arms after a newer user message, then a new matching assistant message', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: Record<string, any[]> = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(store), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));            // fires on T1
    store.s = [{ role: 'user', text: 'ok', timestamp: 'T2' }]; // user replied
    await r.evaluateSession(bobSession('s'));            // no assistant tail → no fire
    store.s = [{ role: 'assistant', text: 'continue again', timestamp: 'T3' }];
    await r.evaluateSession(bobSession('s'));            // new key → fires
    expect(sender.calls.length).toBe(2);
  });
});
