import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PeerAddress } from './PeerDiscovery';

/**
 * The one place this extension opens an SSH connection.
 *
 * Same discipline as `BobDatabase.ts` is for SQLite: a single module owns the transport, so the
 * flags that make it safe and the failure handling that keeps it quiet are in one auditable spot
 * instead of scattered across call sites.
 *
 * ## Why BatchMode is not optional
 *
 * Peers are discovered automatically, so the extension will try to reach hosts the user never
 * explicitly pointed it at. Without `BatchMode=yes`, a host needing a password or a key
 * passphrase would leave `ssh` waiting on a prompt that no one can see or answer — a background
 * timer wedged forever. With it, such a host fails immediately and is simply reported unreachable.
 *
 * ## Why ControlMaster
 *
 * Remote sessions refresh on a timer. A fresh TCP connect plus key exchange on every pass is real
 * load on both ends and slow over a VPN, so connections are multiplexed: the first call sets up a
 * master socket and later calls reuse it.
 *
 * ## Why anything substantial travels on stdin
 *
 * `ssh host cmd a b` does **not** preserve argv. ssh joins the words with spaces and hands the
 * result to a shell on the far side, which re-splits and expands it. A multi-line script passed
 * as an argument is therefore torn apart, and any value containing shell metacharacters is an
 * injection point.
 *
 * So the rule here is: send programs and data over **stdin**, and keep remote argv to short
 * literals the caller controls. Callers that must pass a value should encode it into a
 * shell-inert alphabet (base64) rather than trust quoting.
 */

/** First backoff window after a peer fails. */
export const BACKOFF_BASE_MS = 30_000;
/** Longest a peer is ever left alone; a host down for a week is retried every 15 minutes. */
export const BACKOFF_CAP_MS = 15 * 60_000;

const CONNECT_TIMEOUT_S = 10;
const CONTROL_PERSIST_S = 60;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface SshExecOptions {
  timeout: number;
  maxBuffer: number;
  /** Written to the remote command's stdin, then closed. */
  stdin?: string;
}

export type SshExec = (
  file: string,
  args: string[],
  opts: SshExecOptions,
) => Promise<{ stdout: string }>;

const realExec: SshExec = (file, args, opts) => new Promise((resolve, reject) => {
  // spawn rather than execFile, because the probe script is delivered on stdin.
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let overflowed = false;

  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeout);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > opts.maxBuffer) { overflowed = true; child.kill('SIGKILL'); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 8192) { stderr += chunk; } });

  child.on('error', err => { clearTimeout(timer); reject(err); });
  child.on('close', code => {
    clearTimeout(timer);
    if (timedOut) { reject(new Error(`ssh timed out after ${opts.timeout}ms`)); return; }
    if (overflowed) { reject(new Error('ssh output exceeded the size limit')); return; }
    if (code !== 0) { reject(new Error(stderr.trim() || `ssh exited with code ${code}`)); return; }
    resolve({ stdout });
  });

  // EPIPE is normal here: the remote command may exit before reading all of stdin.
  child.stdin.on('error', () => { /* ignore */ });
  child.stdin.end(opts.stdin ?? '');
});

interface FailureState {
  /** Consecutive failures, which sets the window width. */
  count: number;
  /** Wall clock after which this peer may be tried again. */
  retryAt: number;
  reason: string;
}

export interface SshRunnerOptions {
  exec?: SshExec;
  now?: () => number;
  controlDir?: string;
}

export class SshRunner {
  private readonly _exec: SshExec;
  private readonly _now: () => number;
  private readonly _controlDir: string;
  private readonly _failures = new Map<string, FailureState>();

  constructor(opts: SshRunnerOptions = {}) {
    this._exec = opts.exec ?? realExec;
    this._now = opts.now ?? Date.now;
    this._controlDir = opts.controlDir
      ?? path.join(os.tmpdir(), `session-sitter-ssh-${process.getuid?.() ?? 0}`);
  }

  /**
   * Run one command on a peer and return its stdout.
   *
   * Rejects without connecting when the peer is inside its backoff window, so a decommissioned
   * host costs nothing on later passes.
   */
  async run(
    peer: PeerAddress,
    argv: string[],
    opts: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<string> {
    const wait = this.retryInMs(peer);
    if (wait > 0) {
      throw new Error(
        `peer ${peer.raw} is backed off for another ${Math.ceil(wait / 1000)}s `
        + `(${this._failures.get(peer.raw)?.reason ?? 'unreachable'})`);
    }

    this._ensureControlDir();
    try {
      const { stdout } = await this._exec(
        'ssh', [...this._sshOptions(), peer.raw, ...argv],
        { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, stdin: opts.stdin });
      this._failures.delete(peer.raw);
      return stdout;
    } catch (err) {
      this._recordFailure(peer, err);
      throw err;
    }
  }

  /** Current backoff width for a peer; 0 when it is healthy. */
  backoffMs(peer: PeerAddress): number {
    const state = this._failures.get(peer.raw);
    if (!state) { return 0; }
    return Math.min(BACKOFF_BASE_MS * 2 ** (state.count - 1), BACKOFF_CAP_MS);
  }

  /** Milliseconds until this peer may be tried again; 0 when it may be tried now. */
  retryInMs(peer: PeerAddress): number {
    const state = this._failures.get(peer.raw);
    if (!state) { return 0; }
    return Math.max(0, state.retryAt - this._now());
  }

  /** Why this peer last failed, for display in the panel. */
  lastError(peer: PeerAddress): string | undefined {
    return this._failures.get(peer.raw)?.reason;
  }

  private _sshOptions(): string[] {
    return [
      // Never prompt. See the class comment: this is what keeps automatic discovery safe.
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
      // %C is a hash of (host, port, user), so one socket per peer.
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${path.join(this._controlDir, 'ss-%C')}`,
      '-o', `ControlPersist=${CONTROL_PERSIST_S}`,
    ];
  }

  private _ensureControlDir(): void {
    // 0o700: the control socket is a live authenticated channel to the peer.
    try { fs.mkdirSync(this._controlDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  }

  private _recordFailure(peer: PeerAddress, err: unknown): void {
    const prev = this._failures.get(peer.raw);
    const count = (prev?.count ?? 0) + 1;
    const width = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_CAP_MS);
    this._failures.set(peer.raw, {
      count,
      retryAt: this._now() + width,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
