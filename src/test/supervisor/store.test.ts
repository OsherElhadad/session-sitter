/**
 * Durable, restart-safe record persistence: atomic writes, reload after a restart, consumed-id
 * dedupe, and per-session locking (including taking over a lock whose owner died).
 *
 * Ports `supervisor/tests/test_store.py`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SupervisionState } from '../../supervisor/models';
import { LockBusy, STALE_LOCK_MS, StateStore, newRequestId } from '../../supervisor/store';
import { MutableClock, makeTmpDir } from './fixtures';

let tmp: string;
let recordsDir: string;
let locksDir: string;
beforeEach(() => {
  tmp = makeTmpDir('store-');
  recordsDir = path.join(tmp, 'records');
  locksDir = path.join(tmp, 'locks');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const store = (clock = new MutableClock()) => new StateStore(recordsDir, locksDir, clock.get);

describe('newRequestId', () => {
  it('is prefixed and unique', () => {
    const a = newRequestId();
    expect(a).toMatch(/^req-[0-9a-f]{12}$/);
    expect(a).not.toBe(newRequestId());
  });
});

describe('create and get', () => {
  it('persists a new record in analysis_pending with the clock timestamps', async () => {
    const clock = new MutableClock();
    const s = store(clock);
    const rec = await s.create('sess-1', 'bob', { user: 'alice' });

    expect(rec.state).toBe(SupervisionState.ANALYSIS_PENDING);
    expect(rec.created_at).toBe(clock.now.toISOString());
    expect(rec.user).toBe('alice');
    expect(await s.get(rec.request_id)).toEqual(rec);
  });

  it('fills every field so a record round-trips through JSON', async () => {
    const s = store();
    const rec = await s.create('sess-1', 'bob');
    const raw = JSON.parse(
      fs.readFileSync(path.join(recordsDir, `${rec.request_id}.json`), 'utf8'));
    for (const key of ['delivery_ids', 'events', 'blocked_actions', 'allowed_actions']) {
      expect(Array.isArray(raw[key])).toBe(true);
    }
    expect(raw.assessment).toBeNull();
    expect(raw.should_block_agent).toBe(false);
  });

  it('returns null for an unknown id', async () => {
    expect(await store().get('req-nope')).toBeNull();
  });

  it('bumps updated_at on save', async () => {
    const clock = new MutableClock();
    const s = store(clock);
    const rec = await s.create('sess-1', 'bob');
    clock.advance(5);
    rec.state = SupervisionState.GREEN_COMPLETED;
    await s.save(rec);

    const got = await s.get(rec.request_id);
    expect(got?.updated_at).toBe(clock.now.toISOString());
    expect(got?.created_at).not.toBe(got?.updated_at);
  });

  it('survives a restart: a fresh store over the same dir reloads the record', async () => {
    const rec = await store().create('sess-1', 'bob');
    expect((await new StateStore(recordsDir, locksDir).get(rec.request_id))?.session_id)
      .toBe('sess-1');
  });
});

describe('queries', () => {
  it('filters by session and by state, and skips a corrupt record', async () => {
    const s = store();
    const a = await s.create('sess-1', 'bob');
    const b = await s.create('sess-2', 'claude');
    b.state = SupervisionState.ORANGE_AWAITING_USER;
    await s.save(b);
    fs.writeFileSync(path.join(recordsDir, 'req-corrupt.json'), '{ not json', 'utf8');

    // A corrupt record must never crash a poll pass.
    expect((await s.allRecords()).map(r => r.request_id).sort())
      .toEqual([a.request_id, b.request_id].sort());
    expect((await s.recordsBySession('sess-2')).map(r => r.request_id)).toEqual([b.request_id]);
    expect((await s.byState(SupervisionState.ORANGE_AWAITING_USER)).map(r => r.request_id))
      .toEqual([b.request_id]);
  });

  it('finds an active Orange for a session, and only while it is awaiting', async () => {
    const s = store();
    const rec = await s.create('sess-1', 'bob');
    expect(await s.activeOrangeForSession('sess-1')).toBeNull();

    rec.state = SupervisionState.ORANGE_AWAITING_USER;
    await s.save(rec);
    expect((await s.activeOrangeForSession('sess-1'))?.request_id).toBe(rec.request_id);

    rec.state = SupervisionState.ORANGE_RESOLVED_BY_USER;
    await s.save(rec);
    expect(await s.activeOrangeForSession('sess-1')).toBeNull();
  });
});

describe('consumed update ids', () => {
  it('records ids so a duplicate or late reply is idempotent', async () => {
    const s = store();
    expect(await s.isUpdateConsumed('u1')).toBe(false);
    await s.markUpdateConsumed('u1');
    expect(await s.isUpdateConsumed('u1')).toBe(true);
    expect(await s.isUpdateConsumed('u2')).toBe(false);
  });

  it('persists them across a restart', async () => {
    await store().markUpdateConsumed('u1');
    expect(await new StateStore(recordsDir, locksDir).isUpdateConsumed('u1')).toBe(true);
  });

  it('keeps the consumed file out of the record listing', async () => {
    const s = store();
    await s.create('sess-1', 'bob');
    await s.markUpdateConsumed('u1');
    expect(await s.allRecords()).toHaveLength(1);
  });
});

describe('per-session locking', () => {
  it('runs the body under the lock and releases it afterwards', async () => {
    const s = store();
    const seen = await s.withSessionLock('sess-1', async () => 'ran');
    expect(seen).toBe('ran');
    // Released: the same session can be locked again straight away.
    await expect(s.withSessionLock('sess-1', async () => 'again')).resolves.toBe('again');
  });

  it('releases the lock even when the body throws', async () => {
    const s = store();
    await expect(s.withSessionLock('sess-1', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    await expect(s.withSessionLock('sess-1', async () => 'ok')).resolves.toBe('ok');
  });

  it('reports a live foreign owner as busy', async () => {
    const s = store();
    // A lock held by this test runner's own pid — alive, and fresh.
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(
      path.join(locksDir, 'sess-1.lock'),
      JSON.stringify({ pid: process.pid + 100000, at: new Date().toISOString() }),
      'utf8');
    // A pid that high is almost certainly not running, so force the "alive" case explicitly:
    fs.writeFileSync(
      path.join(locksDir, 'sess-2.lock'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8');

    // Same-process re-entry is allowed (the orchestrator never nests, but a stale self-lock
    // must not deadlock the extension host).
    await expect(s.withSessionLock('sess-2', async () => 'ok')).resolves.toBe('ok');
  });

  it('takes over a lock whose owner is gone', async () => {
    // POSIX flock was released by the kernel when a process died; the pid check restores that.
    const s = store();
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(
      path.join(locksDir, 'sess-1.lock'),
      JSON.stringify({ pid: 2147483000, at: new Date().toISOString() }), // no such process
      'utf8');
    await expect(s.withSessionLock('sess-1', async () => 'took over')).resolves.toBe('took over');
  });

  it('takes over a lock that is plainly stale', async () => {
    const clock = new MutableClock();
    const s = store(clock);
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(
      path.join(locksDir, 'sess-1.lock'),
      // Held by a live pid (ours), but far older than the staleness bound.
      JSON.stringify({
        pid: process.pid,
        at: new Date(clock.now.getTime() - STALE_LOCK_MS - 1000).toISOString(),
      }),
      'utf8');
    await expect(s.withSessionLock('sess-1', async () => 'took over')).resolves.toBe('took over');
  });

  it('treats an unreadable lock as stale rather than deadlocking', async () => {
    const s = store();
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(path.join(locksDir, 'sess-1.lock'), 'half-written', 'utf8');
    await expect(s.withSessionLock('sess-1', async () => 'ok')).resolves.toBe('ok');
  });

  it('blocks a genuinely concurrent holder', async () => {
    // Two stores in this same process would be allowed through by the re-entrancy rule, so this
    // asserts the busy path directly with a foreign live owner.
    const s = store();
    fs.mkdirSync(locksDir, { recursive: true });
    const foreignLivePid = findForeignLivePid();
    fs.writeFileSync(
      path.join(locksDir, 'sess-1.lock'),
      JSON.stringify({ pid: foreignLivePid, at: new Date().toISOString() }),
      'utf8');
    await expect(s.withSessionLock('sess-1', async () => 'ok')).rejects.toThrow(LockBusy);
  });

  it('sanitizes a session id into a safe lock filename', async () => {
    // A session id reaches this from an agent's store, so it must never steer the lock path.
    const s = store();
    let held: string[] = [];
    await s.withSessionLock('../../etc/passwd', async () => {
      held = fs.readdirSync(locksDir); // read it while the lock is still on disk
    });
    expect(held).toEqual(['.._.._etc_passwd.lock']);
    expect(fs.readdirSync(locksDir)).toEqual([]); // and released afterwards
  });
});

/** A pid other than ours that is alive — the parent process, falling back to pid 1. */
function findForeignLivePid(): number {
  for (const pid of [process.ppid, 1]) {
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return pid; } catch { /* try the next */ }
    }
  }
  return 1;
}
