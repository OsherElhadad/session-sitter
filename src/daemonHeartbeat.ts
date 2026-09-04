/**
 * The daemon's heartbeat — written by `session-sitter daemon`, read by anyone who needs to know
 * whether supervision is actually running here.
 *
 * ## Why this is its own module
 *
 * Two very different processes need it, and only one of them can afford the other's dependencies.
 * `PermissionRequest` reads it to decide whether escalating to a human is even answerable, and that
 * hook runs **once per permission prompt** with a human waiting on the other side — its measured p50
 * is dominated by Node startup and module load. Importing it from `src/cli/daemon.ts` would drag the
 * orchestrator, the supervisor factory, the Telegram client and the window registry into the closure
 * of every prompt, to call three functions that touch one small JSON file.
 *
 * So the state lives here, the daemon writes it, and the hook reads it. Neither imports the other.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataDir } from './hooks/paths';

/**
 * Seconds between passes a daemon runs at by default.
 *
 * Here rather than in the daemon because {@link health} needs it as its own default: a reader that
 * has not been told the interval still has to make a staleness judgement, and importing the daemon to
 * learn one number is the coupling this module exists to avoid.
 */
export const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * What a running daemon writes after every pass, so `--status` can answer honestly.
 *
 * A pid alone cannot: pids are recycled, and a daemon that has wedged mid-pass is still a live pid.
 * `lastPassAt` is what distinguishes "running" from "the process exists" — the question anyone
 * actually has when they ask whether their timeouts are being applied.
 */
export interface Heartbeat {
  pid: number;
  host: string;
  startedAt: string;
  lastPassAt: string;
  passes: number;
  /** Records the loop has transitioned, cumulative. */
  processed: number;
  /** Whether this daemon currently holds the Telegram reader lease. */
  reading: boolean;
  stateDir: string;
  /**
   * `loop` for a resident daemon, `once` for a single pass.
   *
   * Without this, `--status` after a `--once` run reports `dead` and "nothing is applying timeouts",
   * which is wrong for the cron setup `--once` exists to serve: the pid being gone is the *expected*
   * end of a single pass, not a failure. A status line that cries wolf at a working configuration is
   * how people learn to stop reading it.
   */
  mode: 'loop' | 'once';
}

export function heartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), 'daemon.json');
}

export async function writeHeartbeat(beat: Heartbeat, file: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Atomic: `--status` in another process must never read half a record and call it stale.
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(beat, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
}

export async function readHeartbeat(file: string): Promise<Heartbeat | null> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const beat = JSON.parse(raw) as Heartbeat;
    return typeof beat.pid === 'number' && typeof beat.lastPassAt === 'string' ? beat : null;
  } catch {
    return null;
  }
}

/**
 * How a heartbeat reads right now.
 *
 * `stale` is the case worth having a word for: the process is alive but has not completed a pass in
 * far longer than its interval, which is a wedged daemon. Reporting that as "running" is how someone
 * comes to believe their timeouts are being applied when they are not.
 */
export type DaemonHealth = 'running' | 'stale' | 'dead' | 'none' | 'oneshot';

/** A pass is late once it is this many times the interval overdue. */
const STALE_FACTOR = 6;

export function health(
  beat: Heartbeat | null,
  now: number,
  isAlive: (pid: number) => boolean,
  intervalSeconds: number = DEFAULT_INTERVAL_SECONDS,
): DaemonHealth {
  if (beat === null) { return 'none'; }
  // A finished single pass is not a dead daemon. Check this before liveness, because the pid being
  // gone is exactly what `--once` is supposed to leave behind.
  if (beat.mode === 'once') { return 'oneshot'; }
  if (!isAlive(beat.pid)) { return 'dead'; }
  const last = Date.parse(beat.lastPassAt);
  if (Number.isNaN(last)) { return 'stale'; }
  return now - last > intervalSeconds * STALE_FACTOR * 1000 ? 'stale' : 'running';
}
