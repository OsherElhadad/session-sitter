// GENERATED FILE — DO NOT EDIT.
// Compiled from src/telegram/bus.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The per-machine command bus between VS Code windows.
 *
 * ## What it is for
 *
 * Exactly one window per machine reads Telegram (see `lease.ts`), but the session a message is
 * aimed at usually belongs to a *different* window. The bus carries that command across.
 *
 * Commands are addressed by **session id, not by window**. The reader does not need a routing
 * table and never has to know which window holds what: it drops a file, and whichever window owns
 * that session picks it up. Ownership is computed independently by every window from the same
 * registry (`ownership.ts`), so they agree without talking.
 *
 * ## How a command is claimed
 *
 * `rename()` is the only atomic claim primitive available across unrelated processes on one
 * filesystem, so that is the whole protocol: a window that owns the session renames
 * `cmd/<id>.json` to `cmd/<id>.taken.<pid>`. Exactly one rename can succeed, so exactly one
 * window runs the command — no lock, no coordination, no window able to steal another's work.
 *
 * This is the same shape as `SupervisorOutbox`, deliberately: atomic write via a temp file plus
 * rename, `fs.watch` for immediate pickup, and an interval as the safety net for the platforms
 * where watch is unreliable.
 *
 * ## Why results are files too
 *
 * The window that applies a command is not the window that must report back to Telegram. So the
 * outcome is written to `res/<id>.json` and the reader posts it. A command that no window ever
 * claims simply has no result, and the reader turns that into a visible "no owner" message once
 * it expires — silence is never allowed to be the outcome.
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
exports.COMMAND_TTL_MS = void 0;
exports.busDir = busDir;
exports.cmdDir = cmdDir;
exports.resDir = resDir;
exports.topicsDir = topicsDir;
exports.leasePath = leasePath;
exports.newCommandId = newCommandId;
exports.parseCommand = parseCommand;
exports.parseResult = parseResult;
exports.postCommand = postCommand;
exports.postResult = postResult;
exports.readPendingCommands = readPendingCommands;
exports.claimCommand = claimCommand;
exports.takeResults = takeResults;
exports.expiredCommands = expiredCommands;
exports.dropCommand = dropCommand;
exports.sweep = sweep;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const paths_1 = require("../hooks/paths");
/** Root for all cross-window state, beside the existing `windows/` registry. */
function busDir(homedir = os.homedir()) {
    return path.join((0, paths_1.claudeDir)(process.env, homedir), 'session-sitter', 'bus');
}
function cmdDir(homedir) {
    return path.join(busDir(homedir), 'cmd');
}
function resDir(homedir) {
    return path.join(busDir(homedir), 'res');
}
function topicsDir(homedir) {
    return path.join(busDir(homedir), 'topics');
}
function leasePath(homedir) {
    return path.join(busDir(homedir), 'telegram.lock');
}
/** How long a command may sit unclaimed before the reader reports it as having no owner. */
exports.COMMAND_TTL_MS = 20000;
function newCommandId() {
    return `cmd-${Date.now().toString(36)}-${(0, crypto_1.randomBytes)(4).toString('hex')}`;
}
function parseCommand(raw) {
    try {
        const d = JSON.parse(raw);
        if (typeof d.cmdId !== 'string' || typeof d.kind !== 'string') {
            return null;
        }
        if (typeof d.threadId !== 'number') {
            return null;
        }
        const source = d.source;
        if (source !== 'claude' && source !== 'bob' && source !== 'codex' && source !== 'chat') {
            return null;
        }
        return {
            cmdId: d.cmdId,
            kind: d.kind,
            sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
            source,
            text: typeof d.text === 'string' ? d.text : '',
            targetPid: typeof d.targetPid === 'number' ? d.targetPid : undefined,
            threadId: d.threadId,
            issuedAt: typeof d.issuedAt === 'number' ? d.issuedAt : 0,
        };
    }
    catch {
        return null;
    }
}
function parseResult(raw) {
    try {
        const d = JSON.parse(raw);
        if (typeof d.cmdId !== 'string' || typeof d.ok !== 'boolean') {
            return null;
        }
        return {
            cmdId: d.cmdId,
            ok: d.ok,
            detail: typeof d.detail === 'string' ? d.detail : '',
            sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
            threadId: typeof d.threadId === 'number' ? d.threadId : 0,
            pid: typeof d.pid === 'number' ? d.pid : 0,
            finishedAt: typeof d.finishedAt === 'number' ? d.finishedAt : 0,
        };
    }
    catch {
        return null;
    }
}
/** Write `data` to `target` atomically, so a reader never sees a half-written file. */
async function writeAtomic(target, data) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${(0, crypto_1.randomBytes)(4).toString('hex')}`;
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, target);
}
/** Publish a command for whichever window owns its session. */
async function postCommand(cmd, homedir) {
    await writeAtomic(path.join(cmdDir(homedir), `${cmd.cmdId}.json`), JSON.stringify(cmd, null, 2));
}
/** Publish the outcome of a command, for the reader to report into Telegram. */
async function postResult(result, homedir) {
    await writeAtomic(path.join(resDir(homedir), `${result.cmdId}.json`), JSON.stringify(result, null, 2));
}
/** Every unclaimed command currently on the bus, oldest first. */
async function readPendingCommands(homedir) {
    const dir = cmdDir(homedir);
    let files;
    try {
        files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json') && !f.includes('.tmp-'));
    }
    catch {
        return [];
    }
    const out = [];
    for (const file of files.sort()) {
        try {
            const cmd = parseCommand(await fs.promises.readFile(path.join(dir, file), 'utf8'));
            if (cmd !== null) {
                out.push(cmd);
            }
        }
        catch { /* vanished mid-read — another window claimed it */ }
    }
    return out.sort((a, b) => a.issuedAt - b.issuedAt);
}
/**
 * Try to take ownership of a command by renaming it aside.
 *
 * The rename IS the lock: it fails for every window but one. A false return means another window
 * already has it, which is a normal outcome and not an error.
 */
async function claimCommand(cmdId, pid, homedir) {
    const from = path.join(cmdDir(homedir), `${cmdId}.json`);
    const to = path.join(cmdDir(homedir), `${cmdId}.taken.${pid}`);
    try {
        await fs.promises.rename(from, to);
        return true;
    }
    catch {
        return false;
    }
}
/** Drain finished results, deleting each as it is taken so it is reported exactly once. */
async function takeResults(homedir) {
    const dir = resDir(homedir);
    let files;
    try {
        files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json') && !f.includes('.tmp-'));
    }
    catch {
        return [];
    }
    const out = [];
    for (const file of files.sort()) {
        const full = path.join(dir, file);
        try {
            const result = parseResult(await fs.promises.readFile(full, 'utf8'));
            if (result !== null) {
                out.push(result);
            }
            await fs.promises.unlink(full);
        }
        catch { /* already taken */ }
    }
    return out;
}
/**
 * Commands issued before `now - COMMAND_TTL_MS` that are still unclaimed.
 *
 * These are the ones no window owns. The caller reports them and removes them, so an
 * unroutable message produces a visible answer rather than nothing at all.
 */
function expiredCommands(pending, now) {
    return pending.filter(c => now - c.issuedAt > exports.COMMAND_TTL_MS);
}
/** Remove a command file outright — used for expiry, after it has been reported. */
async function dropCommand(cmdId, homedir) {
    try {
        await fs.promises.unlink(path.join(cmdDir(homedir), `${cmdId}.json`));
    }
    catch { /* gone */ }
}
/**
 * Delete claimed-but-abandoned command files and stale results.
 *
 * A window that dies mid-apply leaves a `.taken.<pid>` behind. Nothing retries it — a half-sent
 * prompt must not be replayed hours later into a session that has moved on — so cleanup only
 * stops the directory growing without bound.
 */
async function sweep(olderThanMs, now, homedir) {
    let removed = 0;
    for (const dir of [cmdDir(homedir), resDir(homedir)]) {
        let files;
        try {
            files = await fs.promises.readdir(dir);
        }
        catch {
            continue;
        }
        for (const file of files) {
            const full = path.join(dir, file);
            try {
                const stat = await fs.promises.stat(full);
                if (now - stat.mtimeMs > olderThanMs) {
                    await fs.promises.unlink(full);
                    removed++;
                }
            }
            catch { /* ignore */ }
        }
    }
    return removed;
}
