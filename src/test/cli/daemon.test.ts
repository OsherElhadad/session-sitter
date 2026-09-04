import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_INTERVAL_SECONDS, gatedChannel, health, heartbeatPath, ideRefusal, outboxBacklog,
  readHeartbeat, runLoop, runStatus, writeHeartbeat, type DaemonDeps, type Heartbeat,
} from '../../cli/daemon';
import type { MessagingChannel } from '../../supervisor/messaging';
import type { Orchestrator } from '../../supervisor/orchestrator';
import type { SupervisorConfig } from '../../supervisor/config';
import type { SupervisionRecord } from '../../supervisor/models';
import { fakeIo } from './fakeIo';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-daemon-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-04T12:00:00.000Z');

function beat(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    pid: 4242,
    host: 'buildbox',
    startedAt: '2026-09-04T11:00:00.000Z',
    lastPassAt: '2026-09-04T11:59:58.000Z',
    passes: 700,
    processed: 3,
    reading: true,
    stateDir: '/repo/.supervisor-state',
    mode: 'loop',
    ...over,
  };
}

const alive = (): boolean => true;
const gone = (): boolean => false;

describe('health', () => {
  it('is none when no daemon has ever run', () => {
    expect(health(null, NOW.getTime(), alive)).toBe('none');
  });

  it('is running when the pid is live and a pass landed recently', () => {
    expect(health(beat(), NOW.getTime(), alive)).toBe('running');
  });

  it('is dead when the pid is gone', () => {
    expect(health(beat(), NOW.getTime(), gone)).toBe('dead');
  });

  /**
   * The distinction the whole heartbeat exists for. A pid alone cannot answer "are my timeouts being
   * applied": a wedged daemon is still a live pid, and reporting that as running is how someone comes
   * to believe supervision is working when it stopped hours ago.
   */
  it('is stale when the process is alive but has stopped completing passes', () => {
    const wedged = beat({ lastPassAt: '2026-09-04T11:00:00.000Z' }); // an hour ago
    expect(health(wedged, NOW.getTime(), alive)).toBe('stale');
  });

  it('scales staleness to the interval, so a slow daemon is not called wedged', () => {
    const fortySecondsAgo = beat({ lastPassAt: '2026-09-04T11:59:20.000Z' });
    // At the default 5s interval the wedge threshold is 30s, so 40s is over it.
    expect(health(fortySecondsAgo, NOW.getTime(), alive, DEFAULT_INTERVAL_SECONDS)).toBe('stale');
    // The same gap, for a daemon that only wakes every ten minutes, is perfectly healthy.
    expect(health(fortySecondsAgo, NOW.getTime(), alive, 600)).toBe('running');
  });

  it('is stale, not running, when the timestamp cannot be read at all', () => {
    expect(health(beat({ lastPassAt: 'not a date' }), NOW.getTime(), alive)).toBe('stale');
  });

  /**
   * A finished `--once` pass is a working cron configuration, not a fault. Reporting it as `dead`
   * with "nothing is applying timeouts" is a status line crying wolf at a correct setup, which is how
   * people learn to stop reading status lines.
   */
  it('is oneshot for a completed single pass, even though the pid is gone', () => {
    expect(health(beat({ mode: 'once' }), NOW.getTime(), gone)).toBe('oneshot');
    // And staleness does not apply to it either: a cron pass an hour ago is exactly normal.
    expect(health(beat({ mode: 'once', lastPassAt: '2026-09-04T09:00:00.000Z' }),
      NOW.getTime(), gone)).toBe('oneshot');
  });
});

describe('the heartbeat file', () => {
  it('round-trips, creating the directory it needs', async () => {
    const file = path.join(dir, 'nested', 'daemon.json');
    await writeHeartbeat(beat(), file);
    expect(await readHeartbeat(file)).toEqual(beat());
  });

  it('is absent rather than an error before the first pass', async () => {
    expect(await readHeartbeat(path.join(dir, 'daemon.json'))).toBeNull();
  });

  it('reads a corrupt or half-written file as absent, never as a daemon', async () => {
    const file = path.join(dir, 'daemon.json');
    await fs.promises.writeFile(file, '{"pid":42,"lastP', 'utf8');
    expect(await readHeartbeat(file)).toBeNull();
    await fs.promises.writeFile(file, '{"host":"x"}', 'utf8');
    expect(await readHeartbeat(file)).toBeNull();
  });

  it('leaves no temp file behind, so --status never sees a partial record', async () => {
    const file = path.join(dir, 'daemon.json');
    await writeHeartbeat(beat(), file);
    expect((await fs.promises.readdir(dir)).filter(f => f.includes('.tmp-'))).toEqual([]);
  });

  it('lives under the plugin data dir, so the hooks and the daemon agree where state is', () => {
    expect(heartbeatPath({ SESSION_SITTER_DATA_DIR: '/tmp/x' })).toBe('/tmp/x/daemon.json');
  });
});

describe('the IDE refusal', () => {
  it('names the pids, so the claim can be checked rather than believed', () => {
    const message = ideRefusal([
      { pid: 111, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: 0 },
      { pid: 222, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: 0 },
    ]);
    expect(message).toContain('2 VS Code extension hosts');
    expect(message).toContain('pid 111, 222');
    // The reason has to travel with the refusal, or it reads as an arbitrary restriction.
    expect(message).toContain('destructively');
    expect(message).toContain('--allow-with-ide');
  });

  it('says "host", not "hosts", for one', () => {
    expect(ideRefusal([
      { pid: 111, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: 0 },
    ])).toContain('1 VS Code extension host live');
  });
});

describe('gatedChannel', () => {
  function spyChannel(): { channel: MessagingChannel; polls: number; sends: number; ticks: number } {
    const state = { polls: 0, sends: 0, ticks: 0 };
    const channel: MessagingChannel = {
      send: async () => { state.sends++; return { messageId: '1' } as never; },
      pollResponses: async () => { state.polls++; return []; },
      refreshTimers: async () => { state.ticks++; },
    };
    return {
      channel,
      get polls() { return state.polls; },
      get sends() { return state.sends; },
      get ticks() { return state.ticks; },
    };
  }

  /**
   * This is where the lease actually bites. `Orchestrator.poll()` reads replies and applies timeouts
   * in one call and holds its channel privately, so taking the lease without gating the read would
   * consume the update stream whether the lease was won or not — the lease would be decoration.
   */
  it('does not read while the lease is held by someone else', async () => {
    const spy = spyChannel();
    let canRead = false;
    const gated = gatedChannel(spy.channel, () => canRead);

    expect(await gated.pollResponses([])).toEqual([]);
    expect(spy.polls).toBe(0);

    canRead = true;
    await gated.pollResponses([]);
    expect(spy.polls).toBe(1);
  });

  it('never gates a write, because writing a bot token is not exclusive', async () => {
    const spy = spyChannel();
    const gated = gatedChannel(spy.channel, () => false);
    await gated.send({} as SupervisionRecord, 'x', true);
    await gated.refreshTimers?.([]);
    // Gating these would stop a timeout being *reported* for no reason at all.
    expect(spy.sends).toBe(1);
    expect(spy.ticks).toBe(1);
  });

  it('leaves an absent optional absent, rather than adding a method that does nothing', () => {
    const gated = gatedChannel({
      send: async () => ({ messageId: '1' }) as never,
      pollResponses: async () => [],
    }, () => true);
    expect(gated.refreshTimers).toBeUndefined();
    expect(gated.ensurePollingReady).toBeUndefined();
  });
});

describe('outboxBacklog', () => {
  const config = (stateDir: string): SupervisorConfig => ({ stateDir } as SupervisorConfig);

  it('is zero when nothing has been written', async () => {
    expect(await outboxBacklog(config(dir))).toBe(0);
  });

  it('counts the deliveries waiting, and not the ones already applied', async () => {
    const outbox = path.join(dir, 'outbox');
    await fs.promises.mkdir(path.join(outbox, 'done'), { recursive: true });
    await fs.promises.writeFile(path.join(outbox, 'a.json'), '{}', 'utf8');
    await fs.promises.writeFile(path.join(outbox, 'b.json'), '{}', 'utf8');
    // `done/` holds confirmed applies; counting those would report a backlog that is not one.
    await fs.promises.writeFile(path.join(outbox, 'done', 'c.json'), '{}', 'utf8');
    expect(await outboxBacklog(config(dir))).toBe(2);
  });
});

// ── The loop ────────────────────────────────────────────────────────────────

interface FakeOrchestrator {
  polls: number;
  ticks: number;
  orchestrator: Orchestrator;
}

function fakeOrchestrator(
  onPoll: (n: number) => SupervisionRecord[] = () => [],
): FakeOrchestrator {
  const state = { polls: 0, ticks: 0 };
  const orchestrator = {
    poll: async () => { state.polls++; return onPoll(state.polls); },
    refreshTimers: async () => { state.ticks++; },
  } as unknown as Orchestrator;
  return {
    orchestrator,
    get polls() { return state.polls; },
    get ticks() { return state.ticks; },
  };
}

function deps(over: Partial<DaemonDeps> = {}): DaemonDeps {
  const logged: string[] = [];
  return {
    orchestrator: fakeOrchestrator().orchestrator,
    lease: null,
    config: { stateDir: dir } as SupervisorConfig,
    heartbeatFile: path.join(dir, 'daemon.json'),
    intervalSeconds: 1,
    once: true,
    now: () => NOW,
    sleep: async () => { /* no real time in a test */ },
    stopped: () => true,
    log: msg => { logged.push(msg); },
    backlog: async () => 0,
    ...over,
  };
}

describe('runLoop', () => {
  it('--once runs exactly one pass', async () => {
    const fake = fakeOrchestrator();
    const result = await runLoop(deps({ orchestrator: fake.orchestrator, once: true }));
    expect(fake.polls).toBe(1);
    // Both halves of a pass: correlate replies, then tick the countdowns.
    expect(fake.ticks).toBe(1);
    expect(result.passes).toBe(1);
  });

  it('keeps going until it is told to stop', async () => {
    const fake = fakeOrchestrator();
    let passes = 0;
    const result = await runLoop(deps({
      orchestrator: fake.orchestrator,
      once: false,
      stopped: () => ++passes > 6, // called twice per iteration
    }));
    expect(result.passes).toBeGreaterThan(1);
    expect(fake.polls).toBe(result.passes);
  });

  it('counts the records it transitioned, and logs each one', async () => {
    const fake = fakeOrchestrator(n => (n === 1
      ? [{ request_id: 'req-1', state: 'orange_timed_out' } as SupervisionRecord]
      : []));
    const logged: string[] = [];
    const result = await runLoop(deps({
      orchestrator: fake.orchestrator, log: m => { logged.push(m); },
    }));
    expect(result.processed).toBe(1);
    expect(logged.join('\n')).toContain('req-1 → orange_timed_out');
  });

  /**
   * The property that makes it a daemon rather than a script. A transient network error inside a
   * Telegram read is the likeliest thing to go wrong, and the whole point is to still be running in
   * an hour — so a failed pass is logged and the loop continues.
   */
  it('survives a failing pass instead of exiting', async () => {
    let polls = 0;
    const orchestrator = {
      poll: async () => {
        polls++;
        if (polls === 1) { throw new Error('getUpdates timed out'); }
        return [];
      },
      refreshTimers: async () => { /* noop */ },
    } as unknown as Orchestrator;

    const logged: string[] = [];
    let n = 0;
    const result = await runLoop(deps({
      orchestrator, once: false, stopped: () => ++n > 4, log: m => { logged.push(m); },
    }));
    expect(polls).toBeGreaterThan(1);
    expect(result.passes).toBeGreaterThan(1);
    expect(logged.join('\n')).toContain('pass failed, continuing: getUpdates timed out');
  });

  it('writes a heartbeat that says which mode it is in', async () => {
    const file = path.join(dir, 'daemon.json');
    await runLoop(deps({ once: true, heartbeatFile: file }));
    expect((await readHeartbeat(file))?.mode).toBe('once');

    let n = 0;
    await runLoop(deps({ once: false, heartbeatFile: file, stopped: () => ++n > 2 }));
    expect((await readHeartbeat(file))?.mode).toBe('loop');
  });

  describe('the reader lease', () => {
    function fakeLease(held: boolean): { tryAcquire: () => Promise<boolean> } {
      return { tryAcquire: async () => held };
    }

    it('tells the channel gate before the pass, or the lease is decoration', async () => {
      const seen: boolean[] = [];
      await runLoop(deps({
        lease: fakeLease(true) as never,
        onLease: held => { seen.push(held); },
      }));
      expect(seen).toEqual([true]);
    });

    it('counts only the passes that actually read', async () => {
      const yes = await runLoop(deps({ lease: fakeLease(true) as never }));
      expect(yes.reading).toBe(1);
      const no = await runLoop(deps({ lease: fakeLease(false) as never }));
      expect(no.reading).toBe(0);
    });

    it('still runs the pass when another reader holds the lease — silence must still expire', async () => {
      const fake = fakeOrchestrator();
      await runLoop(deps({ orchestrator: fake.orchestrator, lease: fakeLease(false) as never }));
      // Not holding the lease suppresses reading replies, never applying timeouts. A daemon that
      // stood fully down here would leave escalations pending past their deadline.
      expect(fake.polls).toBe(1);
      expect(fake.ticks).toBe(1);
    });

    it('says so when the lease is not held, and only when it changes', async () => {
      const logged: string[] = [];
      let n = 0;
      await runLoop(deps({
        lease: fakeLease(false) as never,
        once: false,
        stopped: () => ++n > 6,
        log: m => { logged.push(m); },
      }));
      const notices = logged.filter(m => m.includes('another reader holds'));
      // Once, not once per pass: a line repeated every few seconds is a line nobody reads.
      expect(notices).toHaveLength(1);
    });

    it('reports nothing about a lease when there is none to take', async () => {
      const logged: string[] = [];
      await runLoop(deps({ lease: null, log: m => { logged.push(m); } }));
      expect(logged.join('\n')).not.toContain('lease');
    });
  });

  describe('the outbox backlog', () => {
    it('says a window is needed, and says it once', async () => {
      const logged: string[] = [];
      let n = 0;
      await runLoop(deps({
        once: false, stopped: () => ++n > 6, backlog: async () => 3,
        log: m => { logged.push(m); },
      }));
      const notices = logged.filter(m => m.includes('waiting for an IDE window'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('3 deliveries');
    });

    it('says nothing at all when there is no backlog', async () => {
      const logged: string[] = [];
      await runLoop(deps({ backlog: async () => 0, log: m => { logged.push(m); } }));
      expect(logged.join('\n')).not.toContain('waiting for an IDE window');
    });
  });
});

describe('runStatus', () => {
  it('reports honestly, and exits non-zero, when nothing has run', async () => {
    const io = fakeIo({ now: NOW });
    const code = await runStatus(io, false, { SESSION_SITTER_DATA_DIR: dir });
    expect(code).toBe(1);
    // Saying "nothing" without saying "nothing, here" sends people hunting a bug that is a path.
    expect(io.text()).toContain(path.join(dir, 'daemon.json'));
  });

  it('--json carries the health verdict and the record it was read from', async () => {
    await writeHeartbeat(beat({ pid: process.pid }), path.join(dir, 'daemon.json'));
    const io = fakeIo({ now: NOW });
    const code = await runStatus(io, true, { SESSION_SITTER_DATA_DIR: dir });
    const json = JSON.parse(io.text());
    expect(json.version).toBe(1);
    expect(json.health).toBe('running');
    expect(json.daemon.passes).toBe(700);
    expect(code).toBe(0);
  });

  it('warns in as many words when the process is up but not working', async () => {
    await writeHeartbeat(
      beat({ pid: process.pid, lastPassAt: '2026-09-04T09:00:00.000Z' }),
      path.join(dir, 'daemon.json'));
    const io = fakeIo({ now: NOW });
    expect(await runStatus(io, false, { SESSION_SITTER_DATA_DIR: dir })).toBe(1);
    expect(io.text()).toContain('Timeouts are NOT being applied');
  });

  it('does not call a finished cron pass a failure', async () => {
    // pid 1 is alive but is certainly not this daemon; mode is what decides.
    await writeHeartbeat(beat({ mode: 'once', pid: 999999 }), path.join(dir, 'daemon.json'));
    const io = fakeIo({ now: NOW });
    await runStatus(io, false, { SESSION_SITTER_DATA_DIR: dir });
    expect(io.text()).toContain('single pass');
    expect(io.text()).not.toContain('Nothing is applying timeouts here');
  });
});
