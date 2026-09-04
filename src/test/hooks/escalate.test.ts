import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, askHuman, askPath, asksDir, buildAsk, newAskId,
  pendingAsks, readAsk, readVerdict, renderAsk, sweepAsks, verdictPath, waitSeconds, writeAsk,
  writeVerdict, type Ask,
} from '../../hooks/escalate';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-ask-'));
  env = { SESSION_SITTER_DATA_DIR: dir };
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-04T12:00:00.000Z');

function ask(over: Partial<Ask> = {}): Ask {
  return {
    askId: 'a1',
    at: NOW.toISOString(),
    deadline: new Date(NOW.getTime() + 45_000).toISOString(),
    sessionId: 's-1',
    cwd: '/repo',
    host: 'buildbox',
    tool: 'Write',
    inputSummary: 'src/index.ts',
    reason: 'no classifier configured and no written clause applied',
    pid: 4242,
    ...over,
  };
}

describe('waitSeconds', () => {
  it('defaults when unset or unreadable', () => {
    expect(waitSeconds(undefined)).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds('')).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds('not a number')).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds('0')).toBe(DEFAULT_WAIT_SECONDS);
  });

  /**
   * The cap is load-bearing. The event's budget is 60s, and a hook killed mid-wait returns no JSON at
   * all — which Claude Code reports as a hook error rather than as a decision. A governance layer
   * whose failure mode is "no verdict" is not one.
   */
  it('never exceeds the cap, whatever is asked for', () => {
    expect(waitSeconds('600')).toBe(MAX_WAIT_SECONDS);
    expect(MAX_WAIT_SECONDS).toBeLessThan(60);
  });

  it('takes a whole number of seconds', () => {
    expect(waitSeconds('10')).toBe(10);
    expect(waitSeconds('10.9')).toBe(10);
  });
});

describe('buildAsk', () => {
  it('sets a deadline from the wait, and records the process that will wait', () => {
    const a = buildAsk({
      sessionId: 's-1', cwd: '/repo', tool: 'Bash', inputSummary: 'terraform apply',
      reason: 'ambiguous', now: NOW, waitSeconds: 30, askId: 'x',
    });
    expect(a.deadline).toBe('2026-09-04T12:00:30.000Z');
    expect(a.pid).toBe(process.pid);
  });

  it('mints ids that do not collide within a millisecond', () => {
    expect(new Set([newAskId(), newAskId(), newAskId()]).size).toBe(3);
  });
});

describe('renderAsk', () => {
  it('carries enough to decide without opening the session', () => {
    const text = renderAsk(ask());
    expect(text).toContain('Write');
    expect(text).toContain('src/index.ts');
    expect(text).toContain('buildbox:/repo');
    expect(text).toContain('no classifier configured');
  });

  /**
   * A decision prompt that hides its own default is how people learn the default the hard way — and
   * here the default is a denial, which is the property the whole product rests on.
   */
  it('says what silence will do, in as many words', () => {
    const text = renderAsk(ask());
    expect(text).toContain('45s denies it');
    expect(text).toContain('silence is never approval');
  });
});

describe('the ask files', () => {
  it('round-trip, creating the directory they need', async () => {
    await writeAsk(ask(), env);
    expect(await readAsk(askPath('a1', env))).toEqual(ask());
  });

  it('read a half-written or corrupt file as absent, never as a question', async () => {
    await fs.promises.mkdir(asksDir(env), { recursive: true });
    await fs.promises.writeFile(askPath('a1', env), '{"askId":"a1","dead', 'utf8');
    expect(await readAsk(askPath('a1', env))).toBeNull();
  });

  it('leave no temp file behind, so the daemon never reads a partial question', async () => {
    await writeAsk(ask(), env);
    expect((await fs.promises.readdir(asksDir(env))).filter(f => f.includes('.tmp-'))).toEqual([]);
  });

  it('only accept a verdict that actually decides something', async () => {
    await fs.promises.mkdir(asksDir(env), { recursive: true });
    await fs.promises.writeFile(
      verdictPath('a1', env), JSON.stringify({ askId: 'a1', decision: 'maybe' }), 'utf8');
    expect(await readVerdict(verdictPath('a1', env))).toBeNull();
  });
});

describe('pendingAsks', () => {
  it('is empty when nothing has ever escalated', async () => {
    expect(await pendingAsks(NOW, env)).toEqual([]);
  });

  it('returns a live ask', async () => {
    await writeAsk(ask(), env);
    expect((await pendingAsks(NOW, env)).map(a => a.askId)).toEqual(['a1']);
  });

  it('skips one that already has a verdict', async () => {
    await writeAsk(ask(), env);
    await writeVerdict({ askId: 'a1', decision: 'allow', by: 'x', text: 'ok', at: '' }, env);
    expect(await pendingAsks(NOW, env)).toEqual([]);
  });

  /**
   * The hook applies its own deadline and has already denied by now, so posting an expired ask would
   * invite a human to answer a question with nowhere left to go — and then to watch their answer do
   * nothing.
   */
  it('skips one whose deadline has passed', async () => {
    await writeAsk(ask({ deadline: new Date(NOW.getTime() - 1000).toISOString() }), env);
    expect(await pendingAsks(NOW, env)).toEqual([]);
  });

  it('never mistakes a verdict file for an ask', async () => {
    await writeAsk(ask(), env);
    await writeVerdict({ askId: 'zz', decision: 'deny', by: 'x', text: '', at: '' }, env);
    expect((await pendingAsks(NOW, env)).map(a => a.askId)).toEqual(['a1']);
  });
});

describe('sweepAsks', () => {
  it('keeps an expired ask through its grace period', async () => {
    await writeAsk(ask({ deadline: new Date(NOW.getTime() - 1000).toISOString() }), env);
    // A human answering a second late should still find the question they were answering.
    expect(await sweepAsks(NOW, 60_000, env)).toBe(0);
    expect(await readAsk(askPath('a1', env))).not.toBeNull();
  });

  it('removes an ask and its verdict once the grace period is past', async () => {
    await writeAsk(ask({ deadline: new Date(NOW.getTime() - 120_000).toISOString() }), env);
    await writeVerdict({ askId: 'a1', decision: 'deny', by: 'x', text: '', at: '' }, env);
    expect(await sweepAsks(NOW, 60_000, env)).toBe(1);
    expect(await readAsk(askPath('a1', env))).toBeNull();
    expect(await readVerdict(verdictPath('a1', env))).toBeNull();
  });

  it('sweeps a temp file left by a killed writer, on age alone', async () => {
    await fs.promises.mkdir(asksDir(env), { recursive: true });
    const orphan = path.join(asksDir(env), 'a9.json.tmp-999');
    await fs.promises.writeFile(orphan, '{', 'utf8');
    const old = new Date(Date.now() + 3600_000);
    expect(await sweepAsks(old, 1000, env)).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('is not an error when nothing has escalated yet', async () => {
    expect(await sweepAsks(NOW, 1000, env)).toBe(0);
  });
});

describe('askHuman', () => {
  it('returns the verdict as soon as one appears', async () => {
    const a = ask();
    let ticks = 0;
    const outcome = await askHuman({
      ask: a,
      env,
      now: () => NOW.getTime() + ticks * 250,
      pollIntervalMs: 250,
      sleep: async () => {
        ticks++;
        // A human answers on the third check.
        if (ticks === 3) {
          await writeVerdict(
            { askId: 'a1', decision: 'allow', by: 'eranra', text: 'yes', at: '' }, env);
        }
      },
    });
    expect(outcome.verdict?.decision).toBe('allow');
    expect(outcome.verdict?.by).toBe('eranra');
    expect(outcome.waitedMs).toBeGreaterThan(0);
  });

  it('writes the ask before it starts waiting, or nothing could answer it', async () => {
    let sawAskWhileWaiting = false;
    let ticks = 0;
    await askHuman({
      // Far enough out that the loop genuinely waits rather than expiring on its first check.
      ask: ask({ deadline: new Date(NOW.getTime() + 10_000).toISOString() }),
      env,
      now: () => NOW.getTime() + ticks * 250,
      pollIntervalMs: 250,
      sleep: async () => {
        ticks++;
        // The question has to be on disk by the time anything could be answering it.
        sawAskWhileWaiting = sawAskWhileWaiting || fs.existsSync(askPath('a1', env));
        await writeVerdict({ askId: 'a1', decision: 'deny', by: 'x', text: 'no', at: '' }, env);
      },
    });
    expect(sawAskWhileWaiting).toBe(true);
  });

  /** Silence is never approval: the deadline passing returns no verdict, and the caller denies. */
  it('gives up at the deadline with no verdict', async () => {
    const outcome = await askHuman({
      ask: ask({ deadline: new Date(NOW.getTime() + 1000).toISOString() }),
      env,
      now: (() => { let t = NOW.getTime() - 250; return () => (t += 250); })(),
      pollIntervalMs: 250,
      sleep: async () => { /* time advances via now() */ },
    });
    expect(outcome.verdict).toBeNull();
  });

  it('never sleeps past the deadline', async () => {
    const slept: number[] = [];
    await askHuman({
      ask: ask({ deadline: new Date(NOW.getTime() + 400).toISOString() }),
      env,
      now: (() => { let t = NOW.getTime() - 250; return () => (t += 250); })(),
      pollIntervalMs: 250,
      sleep: async ms => { slept.push(ms); },
    });
    // Overshooting the deadline is time the agent is held still for nothing.
    expect(Math.max(...slept)).toBeLessThanOrEqual(250);
    expect(slept.every(ms => ms >= 0)).toBe(true);
  });
});
