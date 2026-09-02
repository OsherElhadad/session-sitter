import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { ClaudeSession } from '../sessionScan';
import type { WindowEntry } from '../WindowRegistry';
import { bobRowToSession, type BobTaskRow } from '../sessionRows';
import type { PeerAddress } from './PeerDiscovery';
import { REMOTE_PROBE_PY } from './remoteProbe';
import type { SshRunner } from './SshRunner';

/**
 * Sessions living on other machines.
 *
 * ## Why this is a cache, not another scanner
 *
 * `SessionManager._scanSessions` awaits its sources one after another. Putting an SSH call in that
 * chain would stall the whole panel behind the slowest peer — a VPN hiccup would freeze the local
 * session list, which is the thing the user actually depends on.
 *
 * So this class is refreshed by its own slower timer and only ever *holds* results. The merge in
 * `SessionManager` reads what is already here, synchronously, and never waits on the network.
 *
 * ## What it reuses rather than reimplements
 *
 * - Bob rows go through `bobRowToSession`, the same function the local scan uses.
 * - Claude transcripts are written to a temp file and handed to the injected
 *   `parseSessionFile` — in production `SessionManager`'s own parser. A peer's session therefore
 *   gets its title and status from exactly the code that titles a local one.
 */

export interface PeerStatus {
  peer: string;
  reachable: boolean;
  error?: string;
  sessionCount?: number;
}

export interface RemoteOwner {
  peer: PeerAddress;
  window: WindowEntry;
}

interface ProbePayload {
  machineId?: string;
  windows?: WindowEntry[];
  bobRows?: BobTaskRow[];
  claudeFiles?: Array<{
    sessionId: string;
    path: string;
    size?: number;
    mtime: number;
    gz?: string;
  }>;
}

interface PeerState {
  sessions: ClaudeSession[];
  windows: WindowEntry[];
  /** sessionId -> mtime of the transcript we last parsed, so unchanged ones are not re-sent. */
  known: Record<string, number>;
  /** sessionId -> the session we built from it, reused while the transcript is unchanged. */
  claudeSessions: Map<string, ClaudeSession>;
  status: PeerStatus;
}

export interface RemoteSessionSourceOptions {
  runner: SshRunner;
  discover: () => Promise<PeerAddress[]>;
  /** The real transcript parser, injected so there is only one implementation of its rules. */
  parseSessionFile: (filePath: string) => Promise<ClaudeSession | null>;
  localMachineId?: string;
  tmpDir?: string;
}

/** Identity of this machine, in the same shape the probe reports. */
export function localMachineId(): string {
  return `${os.hostname()}:${process.getuid?.() ?? 0}`;
}

export class RemoteSessionSource {
  private readonly _runner: SshRunner;
  private readonly _discover: () => Promise<PeerAddress[]>;
  private readonly _parseSessionFile: (filePath: string) => Promise<ClaudeSession | null>;
  private readonly _localMachineId: string;
  private readonly _tmpDir: string;
  private readonly _peers = new Map<string, PeerState>();
  private _order: PeerAddress[] = [];

  constructor(opts: RemoteSessionSourceOptions) {
    this._runner = opts.runner;
    this._discover = opts.discover;
    this._parseSessionFile = opts.parseSessionFile;
    this._localMachineId = opts.localMachineId ?? localMachineId();
    this._tmpDir = opts.tmpDir ?? path.join(os.tmpdir(), 'session-sitter-remote');
  }

  /** Every remote session currently known, newest first. */
  getSessions(): ClaudeSession[] {
    const all: ClaudeSession[] = [];
    for (const peer of this._order) {
      const state = this._peers.get(peer.raw);
      if (state) { all.push(...state.sessions); }
    }
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /**
   * Live window entries from every reachable peer.
   *
   * These are what tell the panel a peer's session is *open*, not merely present on disk. The
   * local equivalent, `readLiveWindows`, cannot help here twice over: it reads only this
   * machine's registry directory, and it tests liveness with `process.kill`, which says nothing
   * about a pid on another host. The probe already resolved liveness on the machine that owns the
   * pid, so these entries are as authoritative about their machine as local ones are about this
   * one, and the two sets simply union.
   */
  getPeerWindows(): WindowEntry[] {
    const all: WindowEntry[] = [];
    for (const peer of this._order) {
      const state = this._peers.get(peer.raw);
      if (state) { all.push(...state.windows); }
    }
    return all;
  }

  /** Per-peer reachability, so the panel can say which machines it could not reach. */
  getPeerStatuses(): PeerStatus[] {
    return this._order
      .map(p => this._peers.get(p.raw)?.status)
      .filter((s): s is PeerStatus => s !== undefined);
  }

  /**
   * Which peer window owns a workspace path, for focusing a session on its own machine.
   * Mirrors the local containment test in `SessionSitterViewProvider._findOwnerWindow`.
   */
  findOwnerWindow(projectPath: string): RemoteOwner | null {
    if (!projectPath) { return null; }
    for (const peer of this._order) {
      const state = this._peers.get(peer.raw);
      if (!state) { continue; }
      for (const window of state.windows) {
        const owns = (window.workspaceFolders ?? []).some(
          wf => projectPath === wf || projectPath.startsWith(wf + '/'));
        if (owns) { return { peer, window }; }
      }
    }
    return null;
  }

  /** Probe every discovered peer. Never throws: a failed peer becomes an unreachable status. */
  async refresh(): Promise<void> {
    let peers: PeerAddress[];
    try { peers = await this._discover(); } catch { return; }

    const order: PeerAddress[] = [];
    for (const peer of peers) {
      const kept = await this._refreshPeer(peer);
      if (kept) { order.push(peer); } else { this._peers.delete(peer.raw); }
    }
    this._order = order;
  }

  /** Returns false when the peer should not be listed at all (it is this machine). */
  private async _refreshPeer(peer: PeerAddress): Promise<boolean> {
    const prev = this._peers.get(peer.raw);
    const known = prev?.known ?? {};

    let raw: string;
    try {
      // `python3 -` reads the program from stdin. See SshRunner: ssh hands its command words to a
      // remote shell, so the script travels on stdin and its argument travels as base64.
      const knownB64 = Buffer.from(JSON.stringify(known), 'utf8').toString('base64');
      raw = await this._runner.run(peer, ['python3', '-', knownB64], { stdin: REMOTE_PROBE_PY });
    } catch (err) {
      this._setUnreachable(peer, prev, err instanceof Error ? err.message : String(err));
      return true;
    }

    let payload: ProbePayload;
    try {
      payload = JSON.parse(raw) as ProbePayload;
      if (payload === null || typeof payload !== 'object') { throw new Error('not an object'); }
    } catch {
      // A peer missing python3 prints nothing usable here.
      this._setUnreachable(peer, prev, 'peer returned no usable session data');
      return true;
    }

    // Discovery can name the machine we are already running on.
    if (payload.machineId && payload.machineId === this._localMachineId) { return false; }

    const windows = Array.isArray(payload.windows) ? payload.windows : [];
    const sessions: ClaudeSession[] = [];

    for (const row of Array.isArray(payload.bobRows) ? payload.bobRows : []) {
      try {
        const session = bobRowToSession(row, peer.raw);
        if (session) { sessions.push(session); }
      } catch { /* skip a malformed row, keep the rest */ }
    }

    const claudeSessions = new Map<string, ClaudeSession>();
    const nextKnown: Record<string, number> = {};
    for (const file of Array.isArray(payload.claudeFiles) ? payload.claudeFiles : []) {
      if (!file || typeof file.sessionId !== 'string') { continue; }
      const cached = prev?.claudeSessions.get(file.sessionId);
      let session: ClaudeSession | null = null;

      if (file.gz) {
        session = await this._parseRemoteTranscript(peer, file.sessionId, file.gz, file.mtime);
      } else if (cached && prev?.known[file.sessionId] === file.mtime) {
        // Unchanged since the last pass, so the peer sent no bytes and the old row still stands.
        session = cached;
      }

      // Remember the mtime for every transcript the peer reported, whether or not it yielded a
      // row. A transcript can legitimately parse to nothing — one with no user message yet — and
      // keying the cache on success would make the peer re-ship those bytes on every single pass.
      nextKnown[file.sessionId] = file.mtime;

      if (session) {
        claudeSessions.set(file.sessionId, session);
        sessions.push(session);
      }
    }

    this._peers.set(peer.raw, {
      sessions,
      windows,
      known: nextKnown,
      claudeSessions,
      status: { peer: peer.raw, reachable: true, sessionCount: sessions.length },
    });
    return true;
  }

  /**
   * Write a peer's transcript bytes to a local file and parse them with the real parser.
   *
   * The temp file is self-consistent even though its middle may be missing: the parser reads the
   * head for the title and, relative to the file's own size, the tail for the status.
   */
  private async _parseRemoteTranscript(
    peer: PeerAddress, sessionId: string, gz: string, mtime: number,
  ): Promise<ClaudeSession | null> {
    const dir = path.join(this._tmpDir, peer.raw.replace(/[^A-Za-z0-9._@-]/g, '_'));
    const file = path.join(dir, `${sessionId}.jsonl`);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const bytes = zlib.gunzipSync(Buffer.from(gz, 'base64'));
      await fs.promises.writeFile(file, bytes);
      // The parser takes updatedAt from mtime, so the copy must carry the peer's mtime or every
      // remote session would sort as if it had just been touched.
      const seconds = mtime / 1000;
      await fs.promises.utimes(file, seconds, seconds);

      const session = await this._parseSessionFile(file);
      if (!session) { return null; }
      return { ...session, peer: peer.raw };
    } catch {
      return null;
    }
  }

  private _setUnreachable(peer: PeerAddress, prev: PeerState | undefined, error: string): void {
    this._peers.set(peer.raw, {
      // Drop rows rather than show stale ones: a session we cannot confirm may be long gone.
      sessions: [],
      windows: [],
      known: prev?.known ?? {},
      claudeSessions: prev?.claudeSessions ?? new Map(),
      status: { peer: peer.raw, reachable: false, error },
    });
  }
}
