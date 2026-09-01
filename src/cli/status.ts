/**
 * `session-sitter status` — the worklist, in the terminal.
 *
 * The one screen this whole command exists for: every session across Claude Code, IBM Bob, Codex
 * and VS Code Chat, on this machine and on peers, ordered so the ones waiting on a human are the
 * ones you read first.
 */

import { sortSessions, isSessionSortMode, SESSION_SORT_MODES } from '../sessionSort';
import type { ClaudeSession } from '../sessionScan';
import { SESSION_STATUSES, isBlockedOnYou, type SessionStatus } from '../sessionStatus';
import {
  collectSessions, filterSessions, localHost, peerHost,
  type CollectOptions, type Worklist,
} from './sessions';
import { CliError, flagBool, flagNumber, flagString, parseFlags, type FlagSpec } from './args';
import { humanAge, parseSince } from './time';
import {
  CLEAR_SCREEN, HIDE_CURSOR, SHOW_CURSOR, colorEnabled, painter, table,
  type ColorName, type Io, type Paint,
} from './render';

/** Every order `--sort` accepts — the same six the panel's sort menu offers. */
const SORT_MODES: readonly string[] = SESSION_SORT_MODES.map(m => m.id);

/**
 * The default order: `status`, which `sessionSort` ranks by urgency — approval, question,
 * finished, working, seen, dormant. That is the worklist order, so the terminal does not need one
 * of its own.
 */
const DEFAULT_SORT = 'status';

export const HELP = `session-sitter status — every agent session, and which of them need you

Usage:
  session-sitter status [options]

Options:
  --since WHEN        only sessions updated since WHEN (default: 24h)
                      WHEN is 2h, 45m, yesterday, 2026-08-30, or an ISO timestamp
  --all               no time window — every session on disk, however old
  --agent NAME        only claude, bob, codex or chat
  --needs-me          only sessions whose turn it is for a human
  --sort MODE         ${SORT_MODES.join(', ')}
                      (default: ${DEFAULT_SORT} — most urgent first)
  --peers             also pull sessions from peer machines over SSH
  --watch [SECONDS]   redraw in place every SECONDS (default: 5); Ctrl-C to stop
  --json              machine-readable output (see docs/CLI.md for the contract)
  -h, --help          show this help

Statuses, most urgent first (docs/STATUS-INDICATORS.md has the full rules):
  approval    paused on a permission prompt — your yes/no unblocks it
  question    asked you something — needs an answer typed
  finished    done, and you have not opened it since
  working     running a tool or writing a reply — nothing for you to do
  seen        done, and you have read it
  dormant     nothing happening, or no signal to tell

--needs-me keeps approval and question: the two states where nothing moves until you act.
`;

const SPEC: FlagSpec = {
  '--since': 'string',
  '--all': 'boolean',
  '--agent': 'string',
  '--needs-me': 'boolean',
  '--sort': 'string',
  '--peers': 'boolean',
  '--watch': 'optionalNumber',
  '--json': 'boolean',
  '--help': 'boolean',
  '-h': 'boolean',
};

const AGENTS: Readonly<Record<string, string>> = {
  claude: 'Claude', bob: 'Bob', codex: 'Codex', chat: 'Chat',
};

/**
 * One marker per state, matching `docs/STATUS-INDICATORS.md` in meaning and in urgency order.
 *
 * A distinct glyph per state, not merely a distinct colour, for the same reason the panel uses
 * distinct shapes: colour is the first thing a terminal theme overrides and the first thing a
 * colour-blind reader loses, and `NO_COLOR` drops it entirely. Keyed by every state, so a seventh
 * fails to compile here rather than rendering blank.
 */
const INDICATOR: Readonly<Record<SessionStatus, { glyph: string; label: string; color: ColorName }>> = {
  approval: { glyph: '!', label: 'approval', color: 'yellow' },
  question: { glyph: '?', label: 'question', color: 'yellow' },
  finished: { glyph: '◉', label: 'finished', color: 'green' },
  working: { glyph: '▸', label: 'working', color: 'cyan' },
  seen: { glyph: '·', label: 'seen', color: 'gray' },
  dormant: { glyph: '○', label: 'dormant', color: 'gray' },
};

const DEFAULT_WINDOW = '24h';
const DEFAULT_WATCH_SECONDS = 5;
const MIN_WATCH_SECONDS = 1;

/** Everything the two renderers need, resolved once from argv. */
interface StatusOptions {
  since?: Date;
  agent?: string;
  needsMe: boolean;
  sort: string;
  peers: boolean;
  json: boolean;
  watchSeconds?: number;
}

function parse(argv: readonly string[], io: Io): StatusOptions {
  const args = parseFlags(argv, SPEC);
  if (args.positional.length > 0) {
    throw new CliError(`status takes no arguments, got "${args.positional[0]}"`);
  }

  const sinceFlag = flagString(args, '--since');
  const all = flagBool(args, '--all');
  if (all && sinceFlag !== undefined) {
    throw new CliError('--all and --since contradict each other; pick one');
  }

  const sort = flagString(args, '--sort') ?? DEFAULT_SORT;
  if (!isSessionSortMode(sort)) {
    throw new CliError(`unknown --sort "${sort}" — one of ${SORT_MODES.join(', ')}`);
  }

  const agent = flagString(args, '--agent')?.toLowerCase();
  if (agent !== undefined && AGENTS[agent] === undefined) {
    throw new CliError(`unknown --agent "${agent}" — one of ${Object.keys(AGENTS).join(', ')}`);
  }

  const options: StatusOptions = {
    agent,
    needsMe: flagBool(args, '--needs-me'),
    sort,
    peers: flagBool(args, '--peers'),
    json: flagBool(args, '--json'),
  };
  if (!all) { options.since = parseSince(sinceFlag ?? DEFAULT_WINDOW, io.now()); }

  if (args.flags['--watch'] !== undefined) {
    if (options.json) { throw new CliError('--watch and --json cannot be combined'); }
    // Redrawing in place needs a screen to redraw. Into a pipe or a file the escapes would be
    // garbage and the frames would append forever, so refuse instead of producing that.
    if (!io.isTty) { throw new CliError('--watch needs a terminal; stdout is not one'); }
    const seconds = flagNumber(args, '--watch') ?? DEFAULT_WATCH_SECONDS;
    if (seconds < MIN_WATCH_SECONDS) {
      throw new CliError(`--watch needs at least ${MIN_WATCH_SECONDS} second`);
    }
    options.watchSeconds = seconds;
  }
  return options;
}

/** The rows, filtered and ordered, plus the peer reachability the JSON reports alongside them. */
async function worklist(
  options: StatusOptions, collect: Collect,
): Promise<{ sessions: ClaudeSession[]; source: Worklist }> {
  const source = await collect({ peers: options.peers });
  const filtered = filterSessions(source.sessions, {
    since: options.since, agent: options.agent, needsMe: options.needsMe,
  });
  return { sessions: sortSessions(filtered, options.sort), source };
}

// ── Plain text ──────────────────────────────────────────────────────────────

/** How many sessions are in each state. Every state is present, at zero if need be. */
function counts(sessions: readonly ClaudeSession[]): Record<SessionStatus, number> {
  const tally = Object.fromEntries(
    SESSION_STATUSES.map(s => [s, 0])) as Record<SessionStatus, number>;
  for (const s of sessions) { tally[s.status] += 1; }
  return tally;
}

function summary(
  sessions: readonly ClaudeSession[], options: StatusOptions, paint: Paint, now: Date,
): string {
  const tally = counts(sessions);
  const window = options.since ? `updated in the last ${humanAge(options.since, now)}` : 'all time';
  const blocked = tally.approval + tally.question;
  // Only the states actually present are named. Listing all six with four zeroes reads as noise,
  // and the count that matters is the one you have to act on.
  const parts = [
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    paint(`${blocked} blocked on you`, blocked > 0 ? 'yellow' : 'dim'),
    ...SESSION_STATUSES
      .filter(s => !isBlockedOnYou(s) && tally[s] > 0)
      .map(s => `${tally[s]} ${s}`),
  ];
  return `${parts.join(paint(' · ', 'dim'))}${paint(`  (${window})`, 'dim')}`;
}

export function renderText(
  sessions: readonly ClaudeSession[], source: Worklist, options: StatusOptions, io: Io,
): string {
  const paint = painter(colorEnabled(io));
  const now = io.now();
  const showMachine = sessions.some(s => s.peer) || source.peers.length > 0;

  const lines = [summary(sessions, options, paint, now), ''];

  if (sessions.length === 0) {
    lines.push(paint('No sessions match. Try --all, a wider --since, or drop --needs-me.', 'dim'));
  } else {
    const columns = [
      { header: '' },
      { header: 'STATUS' },
      { header: 'SESSION', max: Math.max(24, Math.min(56, io.columns - 60)) },
      { header: 'AGENT' },
      { header: 'WORKSPACE', max: 24 },
      ...(showMachine ? [{ header: 'MACHINE' }] : []),
      { header: 'UPDATED', right: true },
    ];
    const here = localHost();
    const rows = sessions.map(s => {
      const indicator = INDICATOR[s.status] ?? INDICATOR.dormant;
      return [
        paint(indicator.glyph, indicator.color),
        paint(indicator.label, indicator.color),
        s.title || paint('(untitled)', 'dim'),
        AGENTS[s.source] ?? s.source,
        s.projectName || paint('(no workspace)', 'dim'),
        ...(showMachine ? [s.peer ? peerHost(s.peer) : paint(here, 'dim')] : []),
        humanAge(s.updatedAt, now),
      ];
    });
    lines.push(table(columns, rows, paint));
  }

  for (const peer of source.peers) {
    lines.push(peer.reachable
      ? paint(`peer ${peerHost(peer.peer)}: ${peer.sessionCount ?? 0} sessions`, 'dim')
      : paint(`peer ${peerHost(peer.peer)}: unreachable — ${peer.error ?? 'no reason given'}`, 'red'));
  }
  if (source.peerError) {
    lines.push(paint(`peers could not be pulled: ${source.peerError}`, 'red'));
  }
  if (!options.peers) {
    lines.push('', paint('Peer machines not included. Add --peers to pull them over SSH.', 'dim'));
  }
  return `${lines.join('\n')}\n`;
}

// ── JSON ────────────────────────────────────────────────────────────────────

/**
 * The `--json` contract, version 1.
 *
 * Versioned and documented because other tools will read it. Two rules for changing it: fields are
 * added, never repurposed, and `version` goes up the day a field's meaning changes.
 *
 * `status` is one of the six states in `sessionStatus.ts`, the same value the panel renders — a
 * script and the IDE therefore agree about every session. `blockedOnYou` is carried alongside it so
 * a consumer does not have to hard-code which two of the six those are.
 */
export interface StatusJson {
  version: 1;
  generatedAt: string;
  host: string;
  counts: { total: number } & Record<SessionStatus, number>;
  sessions: Array<{
    sessionId: string;
    agent: string;
    title: string;
    workspace: { name: string; path: string };
    machine: string;
    local: boolean;
    status: SessionStatus;
    /** True for `approval` and `question` — the states where nothing moves until you act. */
    blockedOnYou: boolean;
    updatedAt: string;
    ageSeconds: number;
  }>;
  /** Reachability of each peer machine. Empty unless `--peers` was given. */
  peers: Array<{ peer: string; reachable: boolean; sessionCount: number | null; error: string | null }>;
}

export function renderJson(
  sessions: readonly ClaudeSession[], source: Worklist, now: Date,
): StatusJson {
  const here = localHost();
  return {
    version: 1,
    generatedAt: now.toISOString(),
    host: here,
    counts: { total: sessions.length, ...counts(sessions) },
    sessions: sessions.map(s => ({
      sessionId: s.sessionId,
      agent: s.source,
      title: s.title,
      workspace: { name: s.projectName, path: s.projectPath },
      machine: s.peer ? peerHost(s.peer) : here,
      local: !s.peer,
      status: s.status,
      blockedOnYou: isBlockedOnYou(s.status),
      updatedAt: s.updatedAt.toISOString(),
      ageSeconds: Math.max(0, Math.round((now.getTime() - s.updatedAt.getTime()) / 1000)),
    })),
    peers: source.peers.map(p => ({
      peer: p.peer,
      reachable: p.reachable,
      sessionCount: p.sessionCount ?? null,
      error: p.error ?? null,
    })),
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Injected so tests never touch a real home directory. */
export type Collect = (opts: CollectOptions) => Promise<Worklist>;

/**
 * Sleep between frames, but wake the instant Ctrl-C arrives.
 *
 * Without the wake, the refresh interval would also be the interrupt latency: Ctrl-C during
 * `--watch 60` would appear to do nothing for up to a minute, and the cursor would stay hidden for
 * just as long. The signal handler is handed `wake` and calls it.
 *
 * The timer is deliberately **not** unref'd. It is the only thing holding the event loop open
 * between frames, and unref'ing it exits the process after the first draw — with the cleanup in
 * `watch` never reached, so the terminal is left without a cursor.
 */
function interruptibleSleep(ms: number, register: (wake: () => void) => void): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    register(() => { clearTimeout(timer); resolve(); });
  });
}

export async function run(
  argv: readonly string[], io: Io, collect: Collect = collectSessions,
): Promise<number> {
  const args = parseFlags(argv, SPEC);
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(HELP); return 0; }

  const options = parse(argv, io);

  if (options.json) {
    const { sessions, source } = await worklist(options, collect);
    io.out(`${JSON.stringify(renderJson(sessions, source, io.now()), null, 2)}\n`);
    return 0;
  }

  if (options.watchSeconds === undefined) {
    const { sessions, source } = await worklist(options, collect);
    io.out(renderText(sessions, source, options, io));
    return 0;
  }

  return watch(options, io, collect);
}

/**
 * Redraw the worklist in place until Ctrl-C.
 *
 * Interrupt-clean is the whole requirement here: the cursor is hidden while drawing and restored on
 * the way out, whichever way we leave — including a scan that throws — so an interrupted watch
 * never leaves the terminal without a cursor.
 */
async function watch(options: StatusOptions, io: Io, collect: Collect): Promise<number> {
  let stopped = false;
  // Set while a frame's sleep is pending, so an interrupt cuts the sleep short instead of waiting
  // it out.
  let wake: (() => void) | undefined;
  const stop = (): void => { stopped = true; wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  io.out(HIDE_CURSOR);

  try {
    while (!stopped) {
      const { sessions, source } = await worklist(options, collect);
      if (stopped) { break; }
      const paint = painter(colorEnabled(io));
      io.out(CLEAR_SCREEN
        + renderText(sessions, source, options, io)
        + paint(`\nrefreshing every ${options.watchSeconds}s — Ctrl-C to stop\n`, 'dim'));
      await interruptibleSleep(options.watchSeconds! * 1000, w => { wake = w; });
      wake = undefined;
    }
  } finally {
    io.out(`${SHOW_CURSOR}\n`);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return 0;
}

/** Exported for the tests, which drive the parser directly rather than through a real terminal. */
export const parseStatusArgs = parse;
export type { StatusOptions };
