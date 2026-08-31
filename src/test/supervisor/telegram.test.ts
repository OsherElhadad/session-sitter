/**
 * The Telegram channel: card and keyboard building, the answer-draft toggles, callback and reply
 * correlation, offset persistence, and the countdown refresh — all without a network call.
 *
 * Ports `supervisor/tests/test_telegram.py`, `test_telegram_bridge.py`, and `test_question_relay.py`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SupervisionRecord, SupervisionState, newRecord } from '../../supervisor/models';
import {
  ACTIVE_SESSION,
  ApiFn,
  DEFAULT_OPTIONS,
  TelegramChannel,
  TelegramChannelOptions,
  applyToggle,
  buildCard,
  buildQuestionCard,
  optionsFor,
  questionOptionLabel,
} from '../../supervisor/telegram';
import { MutableClock, assessment, makeTmpDir } from './fixtures';

let tmp: string;
beforeEach(() => { tmp = makeTmpDir('telegram-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function record(overrides: Partial<SupervisionRecord> = {}): SupervisionRecord {
  return newRecord({
    request_id: 'req-1',
    session_id: 'sess-1',
    source: 'bob',
    state: SupervisionState.ORANGE_AWAITING_USER,
    created_at: '2026-07-14T10:00:00.000Z',
    updated_at: '2026-07-14T10:00:00.000Z',
    assessment: assessment('orange'),
    ...overrides,
  });
}

/** A recording API stub. */
function fakeApi(responses: Record<string, Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api: ApiFn = async (method, payload) => {
    calls.push({ method, payload });
    return responses[method] ?? { ok: true, result: { message_id: 555 } };
  };
  return { api, calls };
}

function channel(api: ApiFn, opts: Partial<TelegramChannelOptions> = {}) {
  return new TelegramChannel({
    token: 'tok', chatId: '42', offsetPath: path.join(tmp, 'offset.txt'),
    timeoutMinutes: 30, api, clock: new MutableClock().get, ...opts,
  });
}

describe('optionsFor', () => {
  it('uses the assessment\'s human options, capped and trimmed', () => {
    expect(optionsFor(record())).toEqual(['Approve', 'Create PR', 'Cancel']);
    expect(optionsFor(record({
      assessment: assessment('orange', { human_options: ['a', 'b', 'c', 'd', 'e'] }),
    }))).toHaveLength(4);
    expect(optionsFor(record({
      assessment: assessment('orange', { human_options: ['x'.repeat(40)] }),
    }))[0]).toHaveLength(28);
  });

  it('falls back to Approve/Reject when none are offered', () => {
    expect(optionsFor(record({ assessment: assessment('orange', { human_options: [] }) })))
      .toEqual(DEFAULT_OPTIONS);
    expect(optionsFor(record({ assessment: null }))).toEqual(DEFAULT_OPTIONS);
  });

  it('drops blank options', () => {
    expect(optionsFor(record({
      assessment: assessment('orange', { human_options: ['Approve', '  ', ''] }),
    }))).toEqual(['Approve']);
  });
});

describe('buildCard', () => {
  it('renders an interactive decision card with a keyboard and a countdown', () => {
    const [text, markup] = buildCard(record(), 'Please decide.', {
      interactive: true, minutesLeft: 12, deadlineIso: '2026-07-14T10:30:00.000Z',
    });

    expect(text).toContain('🟠 ORANGE');
    expect(text).toContain('[Session Supervisor] decision needed');
    expect(text).toContain('session: sess-1');
    expect(text).toContain('reply id: req-1');
    expect(text).toContain('🧑 request:');
    expect(text).toContain('🤖 wants to:');
    expect(text).toContain('Please decide.');
    expect(text).toContain('12 min to respond (until 10:30 UTC)');
    expect(text).toContain('Or reply with text.');
    expect(markup?.inline_keyboard.map(row => row[0].text))
      .toEqual(['Approve', 'Create PR', 'Cancel']);
    expect(markup?.inline_keyboard[1][0].callback_data).toBe('req-1|1');
  });

  it('renders a one-way update with no keyboard', () => {
    const [text, markup] = buildCard(
      record({ assessment: assessment('green') }), 'Auto-approved.', { interactive: false });
    expect(text).toContain('🟢 GREEN');
    expect(text).toContain('[Session Supervisor] update');
    expect(text).not.toContain('reply id');
    expect(text).not.toContain('Or reply with text.');
    expect(markup).toBeNull();
  });

  it('says it is waiting when no countdown is known', () => {
    const [text] = buildCard(record(), 'note', { interactive: true, minutesLeft: null });
    expect(text).toContain('⏳ Waiting for your decision.');
  });

  it('never shows a negative countdown', () => {
    const [text] = buildCard(record(), 'note', { interactive: true, minutesLeft: -5 });
    expect(text).toContain('0 min to respond');
  });

  // One chat receives decisions from every session on every machine, so a card that names only a
  // session id cannot be answered — the reader has no way to tell which session it is about.
  it('names the session and the machine when the record carries them', () => {
    const [text] = buildCard(
      record({ session_name: 'fix the login flow', host: 'devbox' }), 'note',
      { interactive: false },
    );
    expect(text).toContain('session: fix the login flow @ devbox (sess-1)');
  });

  it('handles a record with no assessment yet', () => {
    const [text] = buildCard(record({ assessment: null }), 'note', { interactive: false });
    expect(text).toContain('note');
  });
});

describe('applyToggle', () => {
  it('replaces the selection for a single-select question', () => {
    const draft: { answers?: Record<string, string[]> } = {};
    applyToggle(draft, 'q0', 'Postgres', false);
    applyToggle(draft, 'q0', 'SQLite', false);
    expect(draft.answers?.q0).toEqual(['SQLite']);
  });

  it('adds and removes for a multi-select question', () => {
    const draft: { answers?: Record<string, string[]> } = {};
    applyToggle(draft, 'q0', 'a', true);
    applyToggle(draft, 'q0', 'b', true);
    expect(draft.answers?.q0).toEqual(['a', 'b']);
    applyToggle(draft, 'q0', 'a', true); // tapping again clears it
    expect(draft.answers?.q0).toEqual(['b']);
  });

  it('keeps sub-question drafts independent', () => {
    const draft: { answers?: Record<string, string[]> } = {};
    applyToggle(draft, 'q0', 'x', false);
    applyToggle(draft, 'q1', 'y', false);
    expect(draft.answers).toEqual({ q0: ['x'], q1: ['y'] });
  });
});

describe('question cards', () => {
  const spec = {
    request_id: 'req-q',
    source: 'claude',
    prompt: 'Which auth?',
    questions: [
      {
        question: 'Which auth?', header: 'Auth', multi_select: true,
        options: [{ label: 'OAuth' }, { label: 'JWT' }],
      },
      { question: 'Which store?', header: 'Store', multi_select: false, options: [{ label: 'SQL' }] },
    ],
  };

  it('renders one toggle per option plus a submit button', () => {
    const [text, markup] = buildQuestionCard(record({
      state: SupervisionState.ORANGE_AWAITING_QUESTION,
      question_spec: spec as unknown as Record<string, unknown>,
    }));

    expect(text).toContain('❓ QUESTION — Which auth?');
    expect(text).toContain('Auth: Which auth? [multi]');
    expect(text).toContain('Store: Which store?');
    const labels = markup.inline_keyboard.map(row => row[0].text);
    expect(labels).toEqual(['OAuth', 'JWT', 'SQL', '✅ Submit answers']);
    expect(markup.inline_keyboard[0][0].callback_data).toBe('req-1|q0|0');
    expect(markup.inline_keyboard[3][0].callback_data).toBe('req-1|__submit');
  });

  it('marks options already chosen in the draft', () => {
    const [, markup] = buildQuestionCard(record({
      state: SupervisionState.ORANGE_AWAITING_QUESTION,
      question_spec: spec as unknown as Record<string, unknown>,
      question_answer: { answers: { q0: ['JWT'] } },
    }));
    expect(markup.inline_keyboard.map(row => row[0].text))
      .toEqual(['OAuth', '✓ JWT', 'SQL', '✅ Submit answers']);
  });

  it('resolves a callback index back to its option label', () => {
    const rec = record({ question_spec: spec as unknown as Record<string, unknown> });
    expect(questionOptionLabel(rec, 'q0', '1')).toBe('JWT');
    expect(questionOptionLabel(rec, 'q1', '0')).toBe('SQL');
    expect(questionOptionLabel(rec, 'q9', '0')).toBeNull(); // out of range
    expect(questionOptionLabel(rec, 'q0', '9')).toBeNull();
    expect(questionOptionLabel(rec, 'nope', '0')).toBeNull();
  });
});

describe('send', () => {
  it('posts an interactive card and returns the message id', async () => {
    const { api, calls } = fakeApi();
    const res = await channel(api).send(record(), 'Please decide.', true);

    expect(calls[0].method).toBe('sendMessage');
    expect(calls[0].payload.chat_id).toBe('42');
    expect(calls[0].payload.reply_markup).toBeDefined();
    expect(res.messageId).toBe('555');
  });

  it('posts a one-way update with no keyboard', async () => {
    const { api, calls } = fakeApi();
    await channel(api).send(record({ assessment: assessment('green') }), 'FYI', false);
    expect(calls[0].payload.reply_markup).toBeUndefined();
  });

  it('renders a question card when the record is awaiting an answer', async () => {
    const { api, calls } = fakeApi();
    await channel(api).send(record({
      state: SupervisionState.ORANGE_AWAITING_QUESTION,
      question_spec: {
        prompt: 'Which db?',
        questions: [{ question: 'Which db?', options: [{ label: 'SQLite' }], multi_select: false }],
      },
    }), 'ignored', true);

    expect(String(calls[0].payload.text)).toContain('❓ QUESTION');
    const markup = calls[0].payload.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> };
    expect(markup.inline_keyboard.at(-1)?.[0].text).toBe('✅ Submit answers');
  });

  it('raises when the API reports failure, so the decision fails loud', async () => {
    const { api } = fakeApi({ sendMessage: { ok: false, description: 'chat not found' } });
    await expect(channel(api).send(record(), 'note')).rejects.toThrow(/not ok/);
  });
});

describe('pollResponses', () => {
  const update = (payload: Record<string, unknown>) => ({ ok: true, result: [payload] });

  it('maps a button tap to its option label', async () => {
    const { api, calls } = fakeApi({
      getUpdates: update({ update_id: 7, callback_query: { id: 'cb1', data: 'req-1|1' } }),
    });
    const got = await channel(api).pollResponses([record()]);

    expect(got).toEqual([expect.objectContaining({
      updateId: '7', correlationId: 'req-1', text: 'Create PR',
    })]);
    // The tap is acknowledged so the button's spinner clears.
    expect(calls.some(c => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('turns a question tap into a toggle sentinel and a submit into __submit', async () => {
    const rec = record({
      state: SupervisionState.ORANGE_AWAITING_QUESTION,
      question_spec: {
        prompt: 'Which db?',
        questions: [{
          question: 'Which db?', multi_select: true,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        }],
      },
    });
    const toggle = await channel(fakeApi({
      getUpdates: update({ update_id: 1, callback_query: { id: 'c', data: 'req-1|q0|1' } }),
    }).api).pollResponses([rec]);
    expect(toggle[0].text).toBe('__toggle|q0|SQLite');

    const submit = await channel(fakeApi({
      getUpdates: update({ update_id: 2, callback_query: { id: 'c', data: 'req-1|__submit' } }),
    }).api).pollResponses([rec]);
    expect(submit[0].text).toBe('__submit');
  });

  it('correlates a text reply to the card it replies to', async () => {
    const rec = record({ notification_id: '555', notified_at: '2026-07-14T10:00:00.000Z' });
    const { api } = fakeApi({
      getUpdates: update({
        update_id: 9,
        message: { text: ' just commit ', reply_to_message: { message_id: 555 } },
      }),
    });
    const got = await channel(api).pollResponses([rec]);
    expect(got[0]).toMatchObject({ correlationId: 'req-1', text: 'just commit' });
  });

  it('sends a plain message with no live card to the active-session sentinel', async () => {
    const { api } = fakeApi({
      getUpdates: update({ update_id: 9, message: { text: 'run the linter' } }),
    });
    const got = await channel(api).pollResponses([]); // nothing awaiting
    expect(got[0]).toMatchObject({ correlationId: ACTIVE_SESSION, text: 'run the linter' });
  });

  it('falls back to the most recently notified card for an untargeted reply', async () => {
    const older = record({ request_id: 'req-old', notified_at: '2026-07-14T10:00:00.000Z' });
    const newer = record({ request_id: 'req-new', notified_at: '2026-07-14T10:05:00.000Z' });
    const { api } = fakeApi({
      getUpdates: update({ update_id: 9, message: { text: 'approve' } }),
    });
    const got = await channel(api).pollResponses([older, newer]);
    expect(got[0].correlationId).toBe('req-new');
  });

  it('drops a stale tap on an already-resolved card', async () => {
    const { api } = fakeApi({
      getUpdates: update({ update_id: 9, callback_query: { id: 'c', data: 'req-gone|0' } }),
    });
    expect(await channel(api).pollResponses([])).toEqual([]);
  });

  it('ignores updates that are neither a tap nor a text message', async () => {
    const { api } = fakeApi({
      getUpdates: update({ update_id: 9, edited_message: { text: 'x' } }),
    });
    expect(await channel(api).pollResponses([record()])).toEqual([]);
  });

  it('persists and advances the update offset', async () => {
    const offsetPath = path.join(tmp, 'offset.txt');
    const { api, calls } = fakeApi({
      getUpdates: update({ update_id: 42, message: { text: 'hi' } }),
    });
    const ch = channel(api, { offsetPath });
    await ch.pollResponses([record()]);

    expect(fs.readFileSync(offsetPath, 'utf8')).toBe('42');
    expect(calls[0].payload.offset).toBe(1); // first poll starts from 0 + 1
    await ch.pollResponses([record()]);
    expect(calls.filter(c => c.method === 'getUpdates')[1].payload.offset).toBe(43);
  });

  it('surfaces a getUpdates failure instead of looking like "no replies"', async () => {
    // A silent failure here makes every decision time out, so it must be logged.
    const logs: string[] = [];
    const api: ApiFn = async () => { throw new Error('409 Conflict'); };
    const got = await channel(api, { log: (m: string) => logs.push(m) }).pollResponses([record()]);
    expect(got).toEqual([]);
    expect(logs.join('\n')).toContain('getUpdates failed');
  });
});

describe('refreshTimers', () => {
  it('edits each awaiting card with the remaining minutes', async () => {
    const clock = new MutableClock();
    const { api, calls } = fakeApi();
    const rec = record({
      notification_id: '555',
      timeout_deadline: new Date(clock.now.getTime() + 12 * 60_000).toISOString(),
      original_orange_assessment: assessment('orange'),
    });
    await channel(api, { clock: clock.get }).refreshTimers([rec]);

    const edit = calls.find(c => c.method === 'editMessageText');
    expect(edit?.payload.message_id).toBe(555);
    expect(String(edit?.payload.text)).toContain('12 min to respond');
  });

  it('skips records with no message id or no deadline', async () => {
    const { api, calls } = fakeApi();
    await channel(api).refreshTimers([record(), record({ notification_id: '5' })]);
    expect(calls).toHaveLength(0);
  });

  it('ignores an edit failure, because the deadline still stands', async () => {
    const clock = new MutableClock();
    const api: ApiFn = async (method) => {
      if (method === 'editMessageText') { throw new Error('message not modified'); }
      return { ok: true };
    };
    await expect(channel(api, { clock: clock.get }).refreshTimers([record({
      notification_id: '555',
      timeout_deadline: new Date(clock.now.getTime() + 60_000).toISOString(),
    })])).resolves.toBeUndefined();
  });
});

describe('ensurePollingReady', () => {
  it('clears a stale webhook, and tolerates that failing', async () => {
    const { api, calls } = fakeApi();
    await channel(api).ensurePollingReady();
    expect(calls[0].method).toBe('deleteWebhook');

    const failing: ApiFn = async () => { throw new Error('nope'); };
    await expect(channel(failing).ensurePollingReady()).resolves.toBeUndefined();
  });
});
