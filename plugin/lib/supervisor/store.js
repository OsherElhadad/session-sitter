// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/store.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Durable, restart-safe persistence for supervision records.
 *
 * Ported from the Python supervisor (`store.py`. One JSON file per request under `records/`. Writes
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateStore = exports.STALE_LOCK_MS = exports.LockBusy = exports.StoreError = void 0;
exports.newRequestId = newRequestId;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const models_1 = require("./models");
const timeutil_1 = require("./timeutil");
class StoreError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StoreError';
    }
}
exports.StoreError = StoreError;
/** Raised when a per-session lock is already held by a live owner. */
class LockBusy extends StoreError {
    constructor(message) {
        super(message);
        this.name = 'LockBusy';
    }
}
exports.LockBusy = LockBusy;
/** A lock older than this is treated as abandoned even if its pid still resolves. */
exports.STALE_LOCK_MS = 10 * 60 * 1000;
function newRequestId() {
    return `req-${(0, crypto_1.randomBytes)(6).toString('hex')}`;
}
async function atomicWrite(filePath, text) {
    const tmp = `${filePath}.tmp-${(0, crypto_1.randomBytes)(4).toString('hex')}`;
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, filePath); // atomic on POSIX
}
/** True when a pid is still running (or we cannot tell, which we treat as "alive"). */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const e = err;
        // EPERM means the process exists but belongs to another user.
        return e.code === 'EPERM';
    }
}
class StateStore {
    constructor(recordsDir, locksDir, clock = timeutil_1.nowUtc) {
        this.dir = recordsDir;
        this.locksDir = locksDir ?? path.join(path.dirname(recordsDir), 'locks');
        this.consumedPath = path.join(recordsDir, '_consumed_updates.json');
        this.clock = clock;
        fs.mkdirSync(this.dir, { recursive: true });
        fs.mkdirSync(this.locksDir, { recursive: true });
    }
    // ------------------------------------------------------------------ records
    pathFor(requestId) {
        return path.join(this.dir, `${requestId}.json`);
    }
    async save(record) {
        record.updated_at = (0, timeutil_1.toIso)(this.clock());
        await atomicWrite(this.pathFor(record.request_id), JSON.stringify(record, null, 2));
    }
    async create(sessionId, source, fields = {}) {
        const now = (0, timeutil_1.toIso)(this.clock());
        const record = (0, models_1.newRecord)({
            ...fields,
            request_id: newRequestId(),
            session_id: sessionId,
            source,
            state: models_1.SupervisionState.ANALYSIS_PENDING,
            created_at: now,
            updated_at: now,
        });
        await this.save(record);
        return record;
    }
    async get(requestId) {
        let raw;
        try {
            raw = await fs.promises.readFile(this.pathFor(requestId), 'utf8');
        }
        catch (err) {
            const e = err;
            if (e.code === 'ENOENT') {
                return null;
            }
            throw new StoreError(`failed to read record ${requestId}: ${String(err)}`);
        }
        try {
            return (0, models_1.recordFrom)(JSON.parse(raw));
        }
        catch (err) {
            throw new StoreError(`failed to read record ${requestId}: ${String(err)}`);
        }
    }
    async allRecords() {
        let files;
        try {
            files = await fs.promises.readdir(this.dir);
        }
        catch {
            return [];
        }
        const records = [];
        for (const f of files.filter(f => f.startsWith('req-') && f.endsWith('.json')).sort()) {
            try {
                const raw = await fs.promises.readFile(path.join(this.dir, f), 'utf8');
                records.push((0, models_1.recordFrom)(JSON.parse(raw)));
            }
            catch {
                continue; // skip a corrupt record rather than crash the whole poll
            }
        }
        return records;
    }
    async recordsBySession(sessionId) {
        return (await this.allRecords()).filter(r => r.session_id === sessionId);
    }
    async byState(...states) {
        const wanted = new Set(states);
        return (await this.allRecords()).filter(r => wanted.has(r.state));
    }
    /** An existing Orange awaiting a user response for this session, if any (dedup). */
    async activeOrangeForSession(sessionId) {
        for (const r of await this.recordsBySession(sessionId)) {
            if (r.state === models_1.SupervisionState.ORANGE_AWAITING_USER) {
                return r;
            }
        }
        return null;
    }
    // ------------------------------------------------------------------ consumed ids
    async loadConsumed() {
        try {
            const raw = await fs.promises.readFile(this.consumedPath, 'utf8');
            const parsed = JSON.parse(raw);
            return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
        }
        catch {
            return new Set();
        }
    }
    async isUpdateConsumed(updateId) {
        return (await this.loadConsumed()).has(updateId);
    }
    async markUpdateConsumed(updateId) {
        const consumed = await this.loadConsumed();
        consumed.add(updateId);
        await atomicWrite(this.consumedPath, JSON.stringify([...consumed].sort()));
    }
    // ------------------------------------------------------------------ locking
    lockPath(sessionId) {
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
    async withSessionLock(sessionId, fn) {
        const lockFile = this.lockPath(sessionId);
        await this.acquire(lockFile, sessionId);
        try {
            return await fn();
        }
        finally {
            // Only remove a lock we still own, so a takeover by another owner is not clobbered.
            try {
                const held = JSON.parse(await fs.promises.readFile(lockFile, 'utf8'));
                if (held.pid === process.pid) {
                    await fs.promises.unlink(lockFile);
                }
            }
            catch { /* already gone or unreadable — nothing to release */ }
        }
    }
    async acquire(lockFile, sessionId) {
        const payload = JSON.stringify({ pid: process.pid, at: (0, timeutil_1.toIso)(this.clock()) });
        try {
            const handle = await fs.promises.open(lockFile, 'wx');
            try {
                await handle.writeFile(payload, 'utf8');
            }
            finally {
                await handle.close();
            }
            return;
        }
        catch (err) {
            const e = err;
            if (e.code !== 'EEXIST') {
                throw new StoreError(`failed to lock session ${sessionId}: ${String(err)}`);
            }
        }
        // The lock exists. Take it over only if its owner is gone or it is plainly stale.
        let ownerPid = -1;
        let ageMs = Number.POSITIVE_INFINITY;
        try {
            const raw = await fs.promises.readFile(lockFile, 'utf8');
            const held = JSON.parse(raw);
            ownerPid = typeof held.pid === 'number' ? held.pid : -1;
            if (held.at) {
                ageMs = this.clock().getTime() - new Date(held.at).getTime();
            }
        }
        catch { /* unreadable/half-written lock → treat as stale */ }
        if (ownerPid === process.pid) {
            return;
        } // re-entrant within this process
        if (pidAlive(ownerPid) && ageMs < exports.STALE_LOCK_MS) {
            throw new LockBusy(`session ${sessionId} is locked`);
        }
        // Stale: replace it, then confirm we are the recorded owner. Two racing takeovers both
        // rename, so the write alone proves nothing — the read-back is what decides a single winner.
        await atomicWrite(lockFile, payload);
        try {
            const held = JSON.parse(await fs.promises.readFile(lockFile, 'utf8'));
            if (held.pid !== process.pid) {
                throw new LockBusy(`session ${sessionId} is locked`);
            }
        }
        catch (err) {
            if (err instanceof LockBusy) {
                throw err;
            }
            throw new StoreError(`failed to confirm lock for session ${sessionId}: ${String(err)}`);
        }
    }
}
exports.StateStore = StateStore;
