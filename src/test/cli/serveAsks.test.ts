import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  askIdFrom, harvestVerdicts, postNewAsks, recordForAsk, recordIdFor, serveAsks,
  type ServeAsksDeps,
} from '../../cli/serveAsks';
import { readVerdict, verdictPath, writeAsk, type Ask } from '../../hooks/escalate';
import { StateStore } from '../../supervisor/store';
import { SupervisionState } from '../../supervisor/models';
import type { MessagingChannel } from '../../supervisor/messaging';

let dir: string;
let env: NodeJS.ProcessEnv;
let store: StateStore;
const NOW = new Date('2026-09-04T12:00:00.000Z');

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-serve-'));
  env = { SESSION_SITTER_DATA_DIR: dir };
  store = new StateStore(path.join(dir, 'records'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function ask(over: Partial<Ask> = {}): Ask {
  return {
    askId: 'a1',
    at: NOW.toISOString(),
    deadline: new Date(NOW.getTime() + 45_000).toISOString(),
    sessionId: 's-1',
    cwd: '/repo',
    host: 'buildbox',
    tool: 'Bash',
    inputSummary: 'terraform apply',
    reason: 'no written clause applied',
    pid: 4242,
    ...over,
  };
}

interface Spy {
  channel: MessagingChannel;
  sent: Array<{ requestId: string; text: string; interactive?: boolean }>;
}

function spyChannel(fail = false): Spy {
  const sent: Spy['sent'] = [];
  return {
    sent,
    channel: {
      send: async (record, text, interactive) => {
        if (fail) { throw new Error('telegram unreachable'); }
        sent.push({ requestId: record.request_id, text, interactive });
        return { messageId: `m-${sent.length}`, sentAt: NOW.toISOString() };
      },
      pollResponses: async () => [],
    },
  };
}

function deps(over: Partial<ServeAsksDeps> = {}): ServeAsksDeps {
  return {
    store,
    channel: spyChannel().channel,
    now: () => NOW,
    env,
    log: () => { /* quiet */ },
    ...over,
  };
}

describe('the ask ↔ record mapping', () => {
  it('round-trips through the record id, so no side table can go out of step', () => {
    expect(askIdFrom(recordIdFor('abc'))).toBe('abc');
  });

  it('ignores a request id that is not an ask', () => {
    expect(askIdFrom('req-12345')).toBeNull();
  });
});

describe('recordForAsk', () => {
  it('awaits a human, with the ask\'s own deadline as the record\'s', () => {
    const record = recordForAsk(ask(), NOW);
    expect(record.state).toBe(SupervisionState.ORANGE_AWAITING_USER);
    // Seconds-scale, from the hook — not the orchestrator's minutes-scale default.
    expect(record.timeout_deadline).toBe(ask().deadline);
    expect(record.await_light).toBe('orange');
  });

  /**
   * There is no live approval prompt on the agent side: the hook is the thing waiting, and it waits
   * on a file. A request id here would have the outbox trying to resolve a prompt no agent knows.
   */
  it('claims no pending approval to resolve', () => {
    expect(recordForAsk(ask(), NOW).pending_request_id).toBeNull();
  });

  it('carries the rendered question, so the card reads the same on any channel', () => {
    const record = recordForAsk(ask(), NOW);
    expect(String((record.assessment ?? {}).human_notification)).toContain('terraform apply');
    expect(String((record.assessment ?? {}).human_notification))
      .toContain('silence is never approval');
  });
});

describe('postNewAsks', () => {
  it('posts a live ask as an interactive card', async () => {
    await writeAsk(ask(), env);
    const spy = spyChannel();
    expect(await postNewAsks(deps({ channel: spy.channel }))).toBe(1);
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0].requestId).toBe(recordIdFor('a1'));
    // Interactive: it is a decision being asked for, not an update being broadcast.
    expect(spy.sent[0].interactive).toBe(true);
  });

  it('saves the record before sending, or a reply would have nothing to correlate to', async () => {
    await writeAsk(ask(), env);
    // The send fails, so only the save can account for the record existing.
    await postNewAsks(deps({ channel: spyChannel(true).channel }));
    expect(await store.get(recordIdFor('a1'))).not.toBeNull();
  });

  it('does not post the same ask twice', async () => {
    await writeAsk(ask(), env);
    const spy = spyChannel();
    await postNewAsks(deps({ channel: spy.channel }));
    await postNewAsks(deps({ channel: spy.channel }));
    expect(spy.sent).toHaveLength(1);
  });

  it('retries a send that failed, because the record has no notification yet', async () => {
    await writeAsk(ask(), env);
    await postNewAsks(deps({ channel: spyChannel(true).channel }));
    const spy = spyChannel();
    expect(await postNewAsks(deps({ channel: spy.channel }))).toBe(1);
    expect((await store.get(recordIdFor('a1')))?.notification_id).toBe('m-1');
  });

  it('says which ask could not be delivered, rather than failing silently', async () => {
    await writeAsk(ask(), env);
    const logged: string[] = [];
    await postNewAsks(deps({ channel: spyChannel(true).channel, log: m => { logged.push(m); } }));
    expect(logged.join('\n')).toContain('could not deliver ask a1');
    expect(logged.join('\n')).toContain('telegram unreachable');
  });

  it('does not post an ask whose deadline has already passed', async () => {
    await writeAsk(ask({ deadline: new Date(NOW.getTime() - 1).toISOString() }), env);
    const spy = spyChannel();
    expect(await postNewAsks(deps({ channel: spy.channel }))).toBe(0);
    expect(spy.sent).toHaveLength(0);
  });
});

describe('harvestVerdicts', () => {
  /** Set up an ask whose record the orchestrator has resolved with the given reply. */
  async function resolved(reply: string, state = SupervisionState.ORANGE_RESOLVED_BY_USER):
  Promise<void> {
    await writeAsk(ask(), env);
    const record = recordForAsk(ask(), NOW);
    record.state = state;
    record.user_response = reply;
    record.user_response_at = NOW.toISOString();
    await store.save(record);
  }

  it('writes an allow when the human approved', async () => {
    await resolved('yes go ahead');
    expect(await harvestVerdicts(deps())).toBe(1);
    const verdict = await readVerdict(verdictPath('a1', env));
    expect(verdict?.decision).toBe('allow');
    expect(verdict?.text).toBe('yes go ahead');
  });

  it('writes a deny for anything that is not plainly an approval', async () => {
    await resolved('no, use terraform plan first');
    await harvestVerdicts(deps());
    expect((await readVerdict(verdictPath('a1', env)))?.decision).toBe('deny');
  });

  /**
   * The bug that made this worth hardening: the reply parser used to approve on *any* approval word
   * anywhere, so this sentence — which is plainly a refusal — contained "allow" and approved the call.
   */
  it('denies "no, do not allow that", which used to be read as an approval', async () => {
    await resolved('no, do not allow that');
    await harvestVerdicts(deps());
    expect((await readVerdict(verdictPath('a1', env)))?.decision).toBe('deny');
  });

  it('claims no identity it does not have', async () => {
    await resolved('ok');
    await harvestVerdicts(deps());
    // The channel's InboundResponse carries no identity; inventing a name in an audit record is
    // worse than a vague one.
    expect((await readVerdict(verdictPath('a1', env)))?.by).toBe('a human');
  });

  it('writes each verdict once', async () => {
    await resolved('ok');
    expect(await harvestVerdicts(deps())).toBe(1);
    expect(await harvestVerdicts(deps())).toBe(0);
  });

  /**
   * Silence is never approval, and it is never an answer either. The hook has already applied its own
   * deadline and denied; writing a verdict here would be inventing an answer nobody gave.
   */
  it('writes nothing for a record that timed out', async () => {
    await writeAsk(ask(), env);
    const record = recordForAsk(ask(), NOW);
    record.state = SupervisionState.ORANGE_TIMED_OUT;
    await store.save(record);
    expect(await harvestVerdicts(deps())).toBe(0);
    expect(await readVerdict(verdictPath('a1', env))).toBeNull();
  });

  it('ignores an ordinary supervision record that is not an ask', async () => {
    const record = recordForAsk(ask(), NOW);
    record.request_id = 'req-ordinary';
    record.state = SupervisionState.ORANGE_RESOLVED_BY_USER;
    record.user_response = 'yes';
    await store.save(record);
    expect(await harvestVerdicts(deps())).toBe(0);
  });

  it('writes nothing when the ask file is gone, so there is nothing left to answer', async () => {
    await resolved('yes');
    await fs.promises.rm(path.join(dir, 'asks', 'a1.json'));
    expect(await harvestVerdicts(deps())).toBe(0);
  });
});

describe('serveAsks', () => {
  it('is one pass: post what is new, then write out what has been answered', async () => {
    await writeAsk(ask(), env);
    const spy = spyChannel();
    const first = await serveAsks(deps({ channel: spy.channel }));
    expect(first).toEqual({ posted: 1, answered: 0 });

    // The orchestrator resolves it between passes, as it would from a real reply.
    const record = await store.get(recordIdFor('a1'));
    record!.state = SupervisionState.ORANGE_RESOLVED_BY_USER;
    record!.user_response = 'approve';
    await store.save(record!);

    const second = await serveAsks(deps({ channel: spy.channel }));
    expect(second).toEqual({ posted: 0, answered: 1 });
    expect((await readVerdict(verdictPath('a1', env)))?.decision).toBe('allow');
  });
});
