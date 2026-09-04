/**
 * `session-sitter daemon` — the part of supervision that has to keep running.
 *
 * ## What actually needed a home
 *
 * Most of the supervision loop is started only from `extension.ts`, and most of it could not be
 * lifted out, because on a terminal-only machine **its input does not exist**. `SupervisionService`
 * is driven by IBM Bob's pending-approval queue, read through the VS Code extension host; Bob is an
 * IDE, so there is no queue to drive it. `AutoResponder` and `PendingWatcher` are the same story. A
 * daemon that constructed those would be a daemon watching an empty room.
 *
 * Two jobs are different, and they are the reason this command exists:
 *
 *  1. **Correlating a human's reply to an escalation.** A card goes out, someone answers it hours
 *     later, and something has to be running to notice.
 *  2. **Applying the timeout.** A card nobody answers must expire into the fallback. This is the
 *     load-bearing one, because it is the mechanism behind *silence is never approval*: with nothing
 *     running, an escalated call does not fail closed at the deadline — it sits in
 *     `orange_awaiting_user` for as long as the state dir survives, which is the one outcome this
 *     project says it will not produce.
 *
 * Both are already host-free in `Orchestrator.poll()` and `refreshTimers()`, and both were reachable
 * only as `supervise poll --loop` — a command with no service, no supervision of its own, and no way
 * to answer "is it running?". This wraps them as something you can actually leave on.
 *
 * ## One reader per machine, enforced, not documented
 *
 * A Telegram bot token has **one** update stream and `getUpdates` consumes it destructively. Two
 * pollers do not each get a copy: each update goes to whichever asked first, and the shared offset
 * advances past updates the other never saw. So replies are silently split at random — the failure
 * mode where both halves look like they are working.
 *
 * This takes the same `ReaderLease` the Telegram remote control uses (`~/.claude/session-sitter/bus/
 * telegram.lock`), and **polls only while it holds it**. Not holding it is not an error: it means a
 * VS Code window is the reader on this machine, that window is already doing both jobs, and the
 * correct behaviour is to stand down rather than race it.
 *
 * It also refuses to start when a live extension host is registered here, because
 * `SupervisionService` polls Telegram *without* taking that lease when remote control is off — so
 * the lease alone would not protect against it. `--allow-with-ide` is the override, and the refusal
 * names the pids so it can be checked rather than guessed at.
 *
 * ## What it deliberately does not do
 *
 * **It does not apply deliveries.** The orchestrator's decisions land as JSON in `<stateDir>/outbox/`
 * and reaching a paused agent from there needs the VS Code extension host: `SupervisorOutbox` resolves
 * a blocked prompt through the agent's approval emitter, which lives inside another extension's
 * process. A terminal cannot get there. So the daemon **counts** the backlog and says a window is
 * needed, and leaves every delivery where it is. The outbox only ever moves a delivery to `done/` on
 * a confirmed apply, so nothing is lost by waiting — and a daemon that deleted what it could not
 * deliver would be worse than one that never ran.
 */

import * as os from 'os';
import * as fs from 'fs';
import { readLiveWindows, type WindowEntry } from '../WindowRegistry';
import {
  DEFAULT_INTERVAL_SECONDS, health, heartbeatPath, readHeartbeat, writeHeartbeat,
  type DaemonHealth, type Heartbeat,
} from '../daemonHeartbeat';
import { leasePath } from '../telegram/bus';
import { ReaderLease } from '../telegram/lease';
import { loadConfig, outboxDir, recordsDir, type SupervisorConfig } from '../supervisor/config';
import { StateStore } from '../supervisor/store';
import { sweepAsks } from '../hooks/escalate';
import { harvestVerdicts, postNewAsks } from './serveAsks';
import { buildChannel, buildOrchestrator } from '../supervisor/factory';
import type { Orchestrator } from '../supervisor/orchestrator';
import type { MessagingChannel } from '../supervisor/messaging';
import type { SupervisionRecord } from '../supervisor/models';
import { CliError, flagBool, flagString, parseFlags, type FlagSpec } from './args';
import { colorEnabled, painter, type Io } from './render';
import { shortStamp } from './time';

export const HELP = `session-sitter daemon — keep supervision running without an IDE

Usage:
  session-sitter daemon [options]
  session-sitter daemon --status

What one pass does:
  correlate replies to escalated decisions, and expire the ones nobody answered.
  The second is why this exists: with nothing running, an escalation never reaches
  its deadline, and "silence is never approval" stops being true.

Options:
  --once             one pass, then exit — for cron, or a smoke check
  --interval SECONDS seconds between passes (default 5, minimum 1)
  --status           is a daemon running here? then exit
  --state-dir PATH   read this state dir instead of searching for one
  --workspace-root PATH  the repo this supervises (default: the working directory)
  --allow-with-ide   run even though a VS Code extension host is live here
  --json             machine-readable output
  -h, --help         show this help

It never applies a decision into a paused agent — that needs the extension host — so
it reports the outbox backlog instead of pretending to drain it.
`;

const SPEC: FlagSpec = {
  '--once': 'boolean',
  '--interval': 'string',
  '--status': 'boolean',
  '--state-dir': 'string',
  '--workspace-root': 'string',
  '--allow-with-ide': 'boolean',
  '--json': 'boolean',
  '--help': 'boolean',
  '-h': 'boolean',
};

// Re-exported so `session-sitter daemon`'s own surface stays the place to look for it, while the
// value itself lives beside `health()`, which needs it as a default.
export { DEFAULT_INTERVAL_SECONDS, type DaemonHealth, type Heartbeat };

/**
 * How long an expired ask and its verdict are kept before being swept.
 *
 * Not deleted the moment the deadline passes: a human answering a second late should still find the
 * question they were answering, and someone inspecting what just happened should be able to see it.
 * Housekeeping only — the decision itself is in the audit trail, which is never pruned here.
 */
export const ASK_SWEEP_GRACE_MS = 10 * 60_000;

// ── Standing down for an IDE ────────────────────────────────────────────────

/**
 * Live extension hosts on this machine, which are the reason a daemon may have to refuse.
 *
 * A window entry proves an extension host is running and publishing — not that a human is looking at
 * it (a remote host outlives its client), and that distinction does not matter here. What matters is
 * that something else may be polling the same bot token.
 */
export async function liveIdeWindows(homedir: string = os.homedir()): Promise<WindowEntry[]> {
  return readLiveWindows({ homedir });
}

export function ideRefusal(windows: readonly WindowEntry[]): string {
  const pids = windows.map(w => w.pid).join(', ');
  return `refusing to start: ${windows.length} VS Code extension host`
    + `${windows.length === 1 ? '' : 's'} live on this machine (pid ${pids}).\n\n`
    + 'A window with supervision on polls the same Telegram bot token, and `getUpdates` consumes\n'
    + 'its stream destructively — two readers split the replies at random and both look like they\n'
    + 'are working. The window already does the work this daemon would.\n\n'
    + 'Close the window, turn its supervision off, or pass --allow-with-ide if you know the window\n'
    + 'is not supervising this state dir.';
}

// ── The channel wrapper that stops a second read ────────────────────────────

/**
 * The channel, with reading gated on holding the lease.
 *
 * This wrapper is where the lease actually bites, and it has to be: `Orchestrator.poll()` reads
 * replies and applies timeouts in one call, and the orchestrator holds its channel privately. Taking
 * the lease and then calling `poll()` on an ungated channel would consume the update stream whether
 * the lease was won or not — the lease would be decoration.
 *
 * Only `pollResponses` is gated. `send` and `refreshTimers` write, and writing a bot token is not
 * exclusive (`sendMessage` has no shared cursor to corrupt) — which is why the lease covers reading
 * only, and why gating writes here would stop a timeout from being *reported* for no reason.
 *
 * Returning no responses is the honest semantics rather than an error: *this process sees no replies,
 * and silence still expires.*
 */
export function gatedChannel(inner: MessagingChannel, canRead: () => boolean): MessagingChannel {
  const gated: MessagingChannel = {
    send: (record, notification, interactive) => inner.send(record, notification, interactive),
    pollResponses: async pending => (canRead() ? inner.pollResponses(pending) : []),
  };
  if (inner.refreshTimers) {
    gated.refreshTimers = pending => inner.refreshTimers!(pending);
  }
  if (inner.ensurePollingReady) {
    gated.ensurePollingReady = () => inner.ensurePollingReady!();
  }
  return gated;
}

// ── The outbox backlog ──────────────────────────────────────────────────────

/**
 * Deliveries waiting for an extension host, which this daemon cannot apply.
 *
 * Counted rather than drained. `done/` is excluded because the outbox moves a delivery there only on
 * a confirmed apply, so what is left at the top level is exactly the backlog.
 */
export async function outboxBacklog(config: SupervisorConfig): Promise<number> {
  try {
    const entries = await fs.promises.readdir(outboxDir(config), { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// ── The loop ────────────────────────────────────────────────────────────────

export interface DaemonDeps {
  orchestrator: Orchestrator;
  /** Null when this build is not to poll Telegram at all (no lease to take). */
  lease: ReaderLease | null;
  /**
   * Told whether this pass holds the lease, *before* the pass runs.
   *
   * This is the wire between the lease and {@link gatedChannel}: the orchestrator owns its channel
   * privately, so the only way the lease can gate a read is for the gate to be told first. Without
   * it the lease would be decoration and both readers would consume the stream.
   */
  onLease?: (held: boolean) => void;
  /**
   * Post asks written by `PermissionRequest` escalation, before the pass reads replies.
   *
   * Optional so the loop can be tested without the ask machinery, and injected rather than built
   * here so the daemon's own wiring decides whether escalation is served at all.
   */
  serveAsks?: () => Promise<unknown>;
  /** Translate resolved asks into verdict files, after the pass has read replies. */
  harvestAsks?: () => Promise<unknown>;
  config: SupervisorConfig;
  heartbeatFile: string;
  intervalSeconds: number;
  once: boolean;
  now: () => Date;
  /** Injected so a test does not wait in real time. Resolves false to stop the loop. */
  sleep: (ms: number) => Promise<void>;
  /** Checked between passes; true ends the loop cleanly. */
  stopped: () => boolean;
  log: (msg: string) => void;
  backlog?: (config: SupervisorConfig) => Promise<number>;
}

export interface DaemonResult {
  passes: number;
  processed: number;
  /** Passes in which this process held the reader lease. */
  reading: number;
}

/**
 * Run passes until stopped.
 *
 * Self-scheduling — the next pass is scheduled after this one finishes, never on a fixed interval.
 * A Telegram long-poll can block inside `poll()` for seconds, and overlapping passes would
 * double-consume the destructive update stream. `SupervisionService` and `RemoteControlService` are
 * written the same way for the same reason; a third variant of this decision would be a bug waiting
 * for a slow network.
 */
export async function runLoop(deps: DaemonDeps): Promise<DaemonResult> {
  const startedAt = deps.now().toISOString();
  const backlogOf = deps.backlog ?? outboxBacklog;
  let passes = 0;
  let processed = 0;
  let reading = 0;
  // Reported when it changes, not every pass: a daemon that logs an unchanging number every five
  // seconds is a daemon whose log nobody reads.
  let lastBacklog = -1;
  let lastHeld: boolean | null = null;

  for (;;) {
    // No lease to take means nothing to arbitrate — a stub channel reads local files — so such a
    // pass reads freely. `held` is about Telegram, and `reading` below counts only that.
    const held = deps.lease === null ? false : await deps.lease.tryAcquire();
    deps.onLease?.(held);
    if (deps.lease !== null && held !== lastHeld) {
      deps.log(held
        ? 'holding the Telegram reader lease — replies and timeouts'
        : 'another reader holds the Telegram lease — timeouts only, no replies read');
      lastHeld = held;
    }
    if (held) { reading++; }

    let records: SupervisionRecord[] = [];
    try {
      // Order matters, and it is the order of one round trip. Post new asks *first*, so a question
      // written by a hook a moment ago is on its card before `poll()` looks for replies; `poll()`
      // then does the single read that correlates every kind of pending record, asks included;
      // `harvest` translates whatever it resolved back into verdict files the waiting hooks can see.
      // Any other order costs an ask a whole pass, which for a hook holding a prompt open is most of
      // its deadline.
      await deps.serveAsks?.();
      records = await deps.orchestrator.poll();
      await deps.orchestrator.refreshTimers();
      await deps.harvestAsks?.();
    } catch (err) {
      // A failed pass must not end the daemon. The whole point is to still be running in an hour,
      // and a transient network error inside a Telegram read is the most likely thing to go wrong.
      deps.log(`pass failed, continuing: ${err instanceof Error ? err.message : String(err)}`);
    }
    passes++;
    processed += records.length;
    for (const record of records) {
      deps.log(`${record.request_id} → ${record.state}`);
    }

    const waiting = await backlogOf(deps.config);
    if (waiting !== lastBacklog) {
      if (waiting > 0) {
        deps.log(`${waiting} deliver${waiting === 1 ? 'y' : 'ies'} waiting for an IDE window — `
          + 'a terminal cannot reach a paused agent, so they stay queued');
      }
      lastBacklog = waiting;
    }

    await writeHeartbeat({
      pid: process.pid,
      host: os.hostname().split('.')[0],
      startedAt,
      lastPassAt: deps.now().toISOString(),
      passes,
      processed,
      reading: held,
      stateDir: deps.config.stateDir,
      mode: deps.once ? 'once' : 'loop',
    }, deps.heartbeatFile);

    if (deps.once || deps.stopped()) { break; }
    await deps.sleep(deps.intervalSeconds * 1000);
    if (deps.stopped()) { break; }
  }

  return { passes, processed, reading };
}

// ── Entry point ─────────────────────────────────────────────────────────────

function parseInterval(args: ReturnType<typeof parseFlags>): number {
  const raw = flagString(args, '--interval');
  if (raw === undefined) { return DEFAULT_INTERVAL_SECONDS; }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new CliError('--interval needs a whole number of seconds, 1 or more');
  }
  return n;
}

/** `--status`: is a daemon running here, and is it actually completing passes? */
export async function runStatus(
  io: Io, json: boolean, env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const file = heartbeatPath(env);
  const beat = await readHeartbeat(file);
  const state = health(beat, io.now().getTime(), pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });

  if (json) {
    io.out(`${JSON.stringify({
      version: 1,
      generatedAt: io.now().toISOString(),
      heartbeat: file,
      health: state,
      daemon: beat,
    }, null, 2)}\n`);
    return state === 'running' ? 0 : 1;
  }

  const paint = painter(colorEnabled(io));
  if (beat === null) {
    io.out(`${paint(`No daemon has run here. Looked in ${file}.`, 'dim')}\n`);
    return 1;
  }
  const headline = state === 'running' ? paint('running', 'green')
    // A completed single pass is a working configuration, not a fault.
    : state === 'oneshot' ? paint('single pass', 'dim')
    : paint(state, 'red');
  const lines = [
    `${headline} · pid ${beat.pid} · ${beat.host}`,
    paint(`  started   ${shortStamp(new Date(beat.startedAt))}`, 'dim'),
    paint(`  last pass ${shortStamp(new Date(beat.lastPassAt))}`, 'dim'),
    paint(`  passes    ${beat.passes}, ${beat.processed} record(s) transitioned`, 'dim'),
    paint(`  reading   ${beat.reading ? 'yes — holds the Telegram lease' : 'no — timeouts only'}`,
      'dim'),
    paint(`  state dir ${beat.stateDir}`, 'dim'),
  ];
  if (state === 'stale') {
    // The distinction that matters: the process is up, and it is not doing the job.
    lines.push('', paint(
      'The process is alive but has not finished a pass in a long time. Timeouts are NOT being '
      + 'applied.', 'red'));
  }
  if (state === 'dead') {
    lines.push('', paint('That pid is gone. Nothing is applying timeouts here.', 'red'));
  }
  if (state === 'oneshot') {
    lines.push('', paint(
      'This was a --once run, so the process exiting is expected. Nothing is resident: timeouts are '
      + 'applied only when it next runs.', 'dim'));
  }
  io.out(`${lines.join('\n')}\n`);
  return state === 'running' ? 0 : 1;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const args = parseFlags(argv, SPEC);
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(HELP); return 0; }
  if (args.positional.length > 0) {
    throw new CliError(`daemon takes no arguments, got "${args.positional[0]}"`);
  }
  const json = flagBool(args, '--json');
  if (flagBool(args, '--status')) { return runStatus(io, json); }

  const interval = parseInterval(args);
  const stateDir = flagString(args, '--state-dir');
  // The working directory decides the state dir and where a `.env` is read from, and for a service it
  // is set by a unit file rather than by a shell — so it is worth being able to say it outright.
  const workspaceRoot = flagString(args, '--workspace-root') ?? process.cwd();
  const config = loadConfig({
    workspaceRoot,
    ...(stateDir !== undefined ? { stateDir } : {}),
  });

  const windows = await liveIdeWindows();
  if (windows.length > 0 && !flagBool(args, '--allow-with-ide')) {
    io.err(`session-sitter daemon: ${ideRefusal(windows)}\n`);
    return 1;
  }

  const log = (msg: string): void => {
    io.err(`${shortStamp(io.now())} ${msg}\n`);
  };
  log(`state dir ${config.stateDir}`);
  if (windows.length > 0) {
    log(`--allow-with-ide: running alongside ${windows.length} live extension host(s)`);
  }

  const lease = new ReaderLease({
    leasePath: leasePath(),
    pid: process.pid,
    host: os.hostname().split('.')[0],
    log,
  });
  // Polling Telegram is only meaningful for a channel that reads it; the stub reads local files and
  // has no shared cursor to corrupt, so it needs no lease and is always allowed to read.
  const leased = config.messagingChannel === 'telegram';
  let holdsLease = false;

  const orchestrator = buildOrchestrator({
    config,
    log,
    channel: gatedChannel(buildChannel(config, log), () => !leased || holdsLease),
  });
  // Clear a stale webhook once, or `getUpdates` returns nothing at all — the same thing
  // `supervise poll` does before its loop.
  await orchestrator.channel.ensurePollingReady?.();

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) { return; }
    stopping = true;
    log(`${signal} — finishing this pass and stopping`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // The ask service shares the orchestrator's store and channel, which is the point: one store so
  // an ask is a record like any other, and one channel so there is still exactly one reader.
  const askDeps = {
    store: new StateStore(recordsDir(config)),
    channel: orchestrator.channel,
    now: () => io.now(),
    log,
  };
  await sweepAsks(io.now(), ASK_SWEEP_GRACE_MS);

  const once = flagBool(args, '--once');
  const result = await runLoop({
    orchestrator,
    serveAsks: () => postNewAsks(askDeps),
    harvestAsks: () => harvestVerdicts(askDeps),
    lease: leased ? lease : null,
    // Kept in step with the loop's own view, so the channel gate and the log agree about which
    // passes read Telegram.
    onLease: held => { holdsLease = held; },
    config,
    heartbeatFile: heartbeatPath(),
    intervalSeconds: interval,
    once,
    now: () => io.now(),
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
    stopped: () => stopping,
    log,
  });

  await lease.release?.();

  if (json) {
    io.out(`${JSON.stringify({ version: 1, ...result }, null, 2)}\n`);
  } else if (once) {
    io.out(`${result.processed} record(s) transitioned in 1 pass\n`);
  } else {
    log(`stopped after ${result.passes} pass(es), ${result.processed} record(s) transitioned`);
  }
  return 0;
}
