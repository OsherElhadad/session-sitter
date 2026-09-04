import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_INTERVAL_SECONDS, health, heartbeatPath, readHeartbeat, writeHeartbeat,
  type Heartbeat,
} from '../daemonHeartbeat';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-beat-'));
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
