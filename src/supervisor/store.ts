/**
 * Durable, restart-safe persistence for supervision records.
 *
 * Ported from `reckon_supervisor/store.py`. One JSON file per request under `records/`. Writes
 * are atomic (temp file + rename). Consumed messaging update-ids are persisted so duplicate or
 * late responses are idempotent. A per-session lock guards the check-and-create of a new Orange
 * so two active Orange notifications can never exist for one unresolved decision.
 *
 * ## Locking
 *
 * The original used POSIX `fcntl.flock`, chosen because the kernel releases it when the process
 * dies — so a crashed supervision run never strands the lock. Node exposes no `flock`, so the
 * lock is an atomic `O_EXCL` file carrying the owner's pid: a lock whose owner is no longer
 * alive (or which is older than `STALE_LOCK_MS`) is taken over. That restores the property that
 * made `flock` the right choice, without the syscall.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  SupervisionRecord,
  SupervisionState,
  newRecord,
  recordFrom,
} from './models';
import { Clock, nowUtc, toIso } from './timeutil';

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Raised when a per-session lock is already held by a live owner. */
export class LockBusy extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'LockBusy';
  }
}

/** A lock older than this is treated as abandoned even if its pid still resolves. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export function newRequestId(): string {
  return `req-${randomBytes(6).toString('hex')}`;
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, filePath); // atomic on POSIX
}

/** True when a pid is still running (or we cannot tell, which we treat as "alive"). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but belongs to another user.
    return e.code === 'EPERM';
  }
}

export class StateStore {
  private readonly dir: string;
  private readonly locksDir: string;
  private readonly consumedPath: string;
  private readonly clock: Clock;

  constructor(recordsDir: string, locksDir?: string, clock: Clock = nowUtc) {
    this.dir = recordsDir;
    this.locksDir = locksDir ?? path.join(path.dirname(recordsDir), 'locks');
    this.consumedPath = path.join(recordsDir, '_consumed_updates.json');
    this.clock = clock;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.locksDir, { recursive: true });
  }

  // ------------------------------------------------------------------ records

  private pathFor(requestId: string): string {
    return path.join(this.dir, `${requestId}.json`);
  }

  async save(record: SupervisionRecord): Promise<void> {
    record.updated_at = toIso(this.clock());
    await atomicWrite(this.pathFor(record.request_id), JSON.stringify(record, null, 2));
  }

  async create(
    sessionId: string, source: string, fields: Partial<SupervisionRecord> = {},
  ): Promise<SupervisionRecord> {
    const now = toIso(this.clock());
    const record = newRecord({
      ...fields,
      request_id: newRequestId(),
      session_id: sessionId,
      source,
      state: SupervisionState.ANALYSIS_PENDING,
      created_at: now,
      updated_at: now,
    });
    await this.save(record);
    return record;
  }

  async get(requestId: string): Promise<SupervisionRecord | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.pathFor(requestId), 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') { return null; }
      throw new StoreError(`failed to read record ${requestId}: ${String(err)}`);
    }
    try {
      return recordFrom(JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      throw new StoreError(`failed to read record ${requestId}: ${String(err)}`);
    }
  }

  async allRecords(): Promise<SupervisionRecord[]> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const records: SupervisionRecord[] = [];
    for (const f of files.filter(f => f.startsWith('req-') && f.endsWith('.json')).sort()) {
      try {
        const raw = await fs.promises.readFile(path.join(this.dir, f), 'utf8');
        records.push(recordFrom(JSON.parse(raw) as Record<string, unknown>));
      } catch {
        continue; // skip a corrupt record rather than crash the whole poll
      }
    }
    return records;
  }

  async recordsBySession(sessionId: string): Promise<SupervisionRecord[]> {
    return (await this.allRecords()).filter(r => r.session_id === sessionId);
  }

  async byState(...states: string[]): Promise<SupervisionRecord[]> {
    const wanted = new Set(states);
    return (await this.allRecords()).filter(r => wanted.has(r.state));
  }

  /** An existing Orange awaiting a user response for this session, if any (dedup). */
  async activeOrangeForSession(sessionId: string): Promise<SupervisionRecord | null> {
    for (const r of await this.recordsBySession(sessionId)) {
      if (r.state === SupervisionState.ORANGE_AWAITING_USER) { return r; }
    }
    return null;
  }

  // ------------------------------------------------------------------ consumed ids

  private async loadConsumed(): Promise<Set<string>> {
    try {
      const raw = await fs.promises.readFile(this.consumedPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  async isUpdateConsumed(updateId: string): Promise<boolean> {
    return (await this.loadConsumed()).has(updateId);
  }

  async markUpdateConsumed(updateId: string): Promise<void> {
    const consumed = await this.loadConsumed();
    consumed.add(updateId);
    await atomicWrite(this.consumedPath, JSON.stringify([...consumed].sort()));
  }

  // ------------------------------------------------------------------ locking

  private lockPath(sessionId: string): string {
    const safe = [...sessionId]
      .map(c => (/[A-Za-z0-9\-_.]/.test(c) ? c : '_'))
      .join('');
    return path.join(this.locksDir, `${safe}.lock`);
  }

  /**
   * Acquire an exclusive per-session lock, run `fn`, then release it. Throws `LockBusy` when a
   * live owner already holds the lock. A lock whose owner has died, or which is older than
   * `STALE_LOCK_MS`, is taken over.
   */
  async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const lockFile = this.lockPath(sessionId);
    await this.acquire(lockFile, sessionId);
    try {
      return await fn();
    } finally {
      // Only remove a lock we still own, so a takeover by another owner is not clobbered.
      try {
        const held = JSON.parse(await fs.promises.readFile(lockFile, 'utf8')) as { pid?: number };
        if (held.pid === process.pid) { await fs.promises.unlink(lockFile); }
      } catch { /* already gone or unreadable — nothing to release */ }
    }
  }

  private async acquire(lockFile: string, sessionId: string): Promise<void> {
    const payload = JSON.stringify({ pid: process.pid, at: toIso(this.clock()) });
    try {
      const handle = await fs.promises.open(lockFile, 'wx');
      try { await handle.writeFile(payload, 'utf8'); } finally { await handle.close(); }
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') { throw new StoreError(`failed to lock session ${sessionId}: ${String(err)}`); }
    }

    // The lock exists. Take it over only if its owner is gone or it is plainly stale.
    let ownerPid = -1;
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      const raw = await fs.promises.readFile(lockFile, 'utf8');
      const held = JSON.parse(raw) as { pid?: number; at?: string };
      ownerPid = typeof held.pid === 'number' ? held.pid : -1;
      if (held.at) { ageMs = this.clock().getTime() - new Date(held.at).getTime(); }
    } catch { /* unreadable/half-written lock → treat as stale */ }

    if (ownerPid === process.pid) { return; } // re-entrant within this process
    if (pidAlive(ownerPid) && ageMs < STALE_LOCK_MS) {
      throw new LockBusy(`session ${sessionId} is locked`);
    }
    // Stale: replace it, then confirm we are the recorded owner. Two racing takeovers both
    // rename, so the write alone proves nothing — the read-back is what decides a single winner.
    await atomicWrite(lockFile, payload);
    try {
      const held = JSON.parse(await fs.promises.readFile(lockFile, 'utf8')) as { pid?: number };
      if (held.pid !== process.pid) { throw new LockBusy(`session ${sessionId} is locked`); }
    } catch (err) {
      if (err instanceof LockBusy) { throw err; }
      throw new StoreError(`failed to confirm lock for session ${sessionId}: ${String(err)}`);
    }
  }
}
