/**
 * Collecting the worklist for the terminal: every session, from every source, on every machine.
 *
 * This is the CLI's counterpart to `SessionManager._scanSessions` and it deliberately shares that
 * method's readers (`sessionScan`) rather than its structure. The extension holds a live cache and
 * a watcher; a CLI process runs once and exits, so it scans, reports and is gone.
 *
 * ## Why sessions are windowed by default
 *
 * `~/.claude/projects` is append-only and never pruned — a machine that has been in use for a
 * month holds hundreds of finished sessions. The panel hides the old ones behind process liveness;
 * a bare `session-sitter status` cannot, because that liveness check covers only sessions started
 * from the IDE and is currently broken on macOS. So the window is what keeps the worklist a
 * worklist, and `--all` is there for when you want the archive.
 */

import * as os from 'os';
import { discoverPeers } from '../remote/PeerDiscovery';
import { RemoteSessionSource, type PeerStatus } from '../remote/RemoteSessionSource';
import { SshRunner } from '../remote/SshRunner';
import {
  defaultStorePaths,
  parseSessionFile,
  scanBobSessions,
  scanChatSessions,
  scanClaudeSessions,
  scanCodexSessions,
  type ClaudeSession,
  type SessionStorePaths,
} from '../sessionScan';

/**
 * What a session is waiting on, which is the only question a worklist exists to answer.
 *
 * Derived from the raw `status` the stores report, and named from the human's side of the
 * transaction rather than the agent's:
 *
 *  - `working`   — tools are running or a reply is streaming. Nothing for you to do.
 *  - `queued`    — a prompt has landed and the agent has not started answering it. Waiting on the
 *                  agent. Normally momentary; a session stuck here is a wedged session.
 *  - `needs-you` — the agent finished and the transcript has been quiet. Your turn.
 */
export type Attention = 'working' | 'queued' | 'needs-you';

const ATTENTION: Readonly<Record<string, Attention>> = {
  active: 'working',
  waiting: 'queued',
  idle: 'needs-you',
};

// Takes a bare string, as `sessionSort.SortableSession` does: the value comes out of a file that
// another vendor writes, so the type system cannot promise it is one of the three.
export function attentionOf(session: { status: string }): Attention {
  return ATTENTION[session.status] ?? 'needs-you';
}

/**
 * The worklist's own order, and why it is not one of `sessionSort`'s six.
 *
 * `sessionSort` has a mode labelled "Needs you first" whose key ranks `waiting` ahead of `active`
 * ahead of `idle` — but by the rules in `readStatus`, `waiting` means the *agent* has not started
 * yet and `idle` means the agent finished and it is your turn. So that mode leads with the sessions
 * that need you least, which is fine in a panel you are watching and wrong for a command whose
 * whole output is a to-do list.
 *
 * Rather than change a comparator the panel depends on, the CLI adds this one order and leaves the
 * other six exactly as they are: `--sort status` still gives the panel's ordering, byte for byte.
 */
export const ATTENTION_RANK: Readonly<Record<Attention, number>> = {
  'needs-you': 0, working: 1, queued: 2,
};

/** The CLI's default `--sort`. Not a `SessionSortMode` — the other six all are. */
export const NEEDS_ME_SORT = 'needs-me';

/** Needs you first, then whatever is running, newest first inside each group. */
export function sortByAttention<T extends ClaudeSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) =>
    ATTENTION_RANK[attentionOf(a)] - ATTENTION_RANK[attentionOf(b)]
    || b.updatedAt.getTime() - a.updatedAt.getTime()
    // The same final tie-break every `sessionSort` comparator has: without it, equal keys leave the
    // order to whatever sequence the scan produced, and that changes between passes.
    || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}

export interface CollectOptions {
  /** Store locations; defaulted so callers only override them in tests. */
  paths?: SessionStorePaths;
  /**
   * Pull sessions from peer machines over SSH.
   *
   * Off unless asked. Peer discovery is a local file read, but the pull that follows it opens SSH
   * connections, and a command that reaches the network without being told to is a command people
   * stop running. `--peers` is the consent.
   */
  peers?: boolean;
  /** Injected in tests, so no test ever opens a connection. */
  remote?: RemoteReader;
}

/** The part of `RemoteSessionSource` this module uses, so tests can stand in for it. */
export interface RemoteReader {
  refresh(): Promise<void>;
  getSessions(): ClaudeSession[];
  getPeerStatuses(): PeerStatus[];
}

export interface Worklist {
  sessions: ClaudeSession[];
  peers: PeerStatus[];
  /** Set when peers were asked for and the pull failed outright, rather than per-peer. */
  peerError?: string;
}

/**
 * Scan every source and return the merged list, newest first.
 *
 * Sources are read in sequence, as `_scanSessions` reads them: they are all local file work, and a
 * failing source already returns an empty list rather than throwing.
 */
export async function collectSessions(opts: CollectOptions = {}): Promise<Worklist> {
  const paths = opts.paths ?? defaultStorePaths();
  const sessions = [
    ...(await scanClaudeSessions(paths.projectsDir)),
    ...(await scanBobSessions(paths.bobDbPath)),
    ...(await scanCodexSessions(paths.codexSessionsDir, paths.codexIndexPath)),
    ...(await scanChatSessions(paths.vscodeUserDir)),
  ];

  const result: Worklist = { sessions, peers: [] };
  if (!opts.peers && !opts.remote) {
    result.sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return result;
  }

  const remote = opts.remote ?? new RemoteSessionSource({
    runner: new SshRunner(),
    discover: () => discoverPeers(),
    // The real parser, so a peer's session is titled by exactly the code that titles a local one.
    parseSessionFile,
  });
  try {
    await remote.refresh();
    result.sessions.push(...remote.getSessions());
    result.peers = remote.getPeerStatuses();
  } catch (err) {
    // One unreachable peer must never cost you the local worklist — the same rule the panel keeps.
    result.peerError = String(err);
  }
  result.sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return result;
}

export interface FilterOptions {
  /** Drop sessions not updated since this instant. Undefined means no window. */
  since?: Date;
  /** Keep only this agent (`claude` | `bob` | `codex` | `chat`). */
  agent?: string;
  /** Keep only sessions whose turn it is for a human. */
  needsMe?: boolean;
}

export function filterSessions(
  sessions: readonly ClaudeSession[], opts: FilterOptions,
): ClaudeSession[] {
  return sessions.filter(s => {
    if (opts.since && s.updatedAt.getTime() < opts.since.getTime()) { return false; }
    if (opts.agent && s.source !== opts.agent) { return false; }
    if (opts.needsMe && attentionOf(s) !== 'needs-you') { return false; }
    return true;
  });
}

/** This machine's short name, for the column that says where a session lives. */
export function localHost(): string {
  return os.hostname().split('.')[0];
}

/** A peer's short name, matching how `sessionSort` keys the same field. */
export function peerHost(peer: string): string {
  return peer.split('@').pop()?.split('.')[0] ?? peer;
}
