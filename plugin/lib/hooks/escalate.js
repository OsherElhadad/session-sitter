// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/escalate.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Asking a human, from inside the hook — the last step of rung 7 before it fails closed.
 *
 * ## Why this belongs in the hook, not in an injector
 *
 * The obvious way to answer a terminal session from a phone is to *write into it*: find the process
 * and inject the keystrokes. This project already has that machinery for the IDE — `ClaudeSender`
 * reaches into the `anthropic.claude-code` extension host over the V8 inspector — and it cannot work
 * for a bare `claude` in a terminal, which has no extension host to reach into.
 *
 * Inverting it is strictly better, not merely available. `PermissionRequest` is **already** the
 * synchronous decision point, and it is allowed 60 seconds. So the hook does not need anything to
 * write into the session: it can hold the prompt open, ask, and answer it itself. That gets a real
 * permission decision carrying a clause citation, rather than simulated typing — and it works
 * identically for a session in a tmux pane, over SSH, or in an IDE.
 *
 * ## The hook must never read Telegram
 *
 * A bot token has one update stream and `getUpdates` consumes it destructively. A hook process runs
 * *per prompt*, so a hook that polled Telegram would be an unbounded number of competing readers —
 * far worse than the two-window case the reader lease already exists to prevent.
 *
 * So the hook does no network at all. It writes an **ask** to a file and polls for a **verdict**
 * file beside it. The daemon (`session-sitter daemon`) is the single reader: it picks the ask up,
 * posts it to the human channel, correlates the reply, and writes the verdict. Two processes, one
 * directory, no shared cursor to corrupt.
 *
 * ## It refuses to wait for something nobody will answer
 *
 * Escalation is only meaningful when a daemon is running to serve it. If none is, the hook denies
 * **immediately** and says why, rather than holding the agent still for fifty seconds first. This is
 * what the daemon's heartbeat is for: `health()` distinguishes a live daemon from a wedged one, and a
 * wedged daemon cannot answer an ask either.
 *
 * ## Silence is still never approval
 *
 * A deadline that passes with no verdict is a **deny**, recorded with `actor: 'human'`-adjacent
 * honesty as `actor: 'timeout'`, and the ask is stamped so the trail shows a human was asked and did
 * not answer. That is the same rule the rest of the ladder obeys; escalation adds a chance to say
 * yes, never a chance to drift into a default yes.
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
exports.POLL_INTERVAL_MS = exports.MAX_WAIT_SECONDS = exports.DEFAULT_WAIT_SECONDS = void 0;
exports.asksDir = asksDir;
exports.askPath = askPath;
exports.verdictPath = verdictPath;
exports.waitSeconds = waitSeconds;
exports.newAskId = newAskId;
exports.writeAsk = writeAsk;
exports.readAsk = readAsk;
exports.writeVerdict = writeVerdict;
exports.readVerdict = readVerdict;
exports.pendingAsks = pendingAsks;
exports.sweepAsks = sweepAsks;
exports.askHuman = askHuman;
exports.buildAsk = buildAsk;
exports.renderAsk = renderAsk;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const paths_1 = require("./paths");
/** Where asks and their verdicts live. Under the plugin data dir, beside the audit trail. */
function asksDir(env = process.env) {
    return path.join((0, paths_1.dataDir)(env), 'asks');
}
function askPath(askId, env) {
    return path.join(asksDir(env), `${askId}.json`);
}
function verdictPath(askId, env) {
    return path.join(asksDir(env), `${askId}.verdict.json`);
}
/**
 * The hook's 60-second budget is the hard ceiling, and being killed mid-wait would return no JSON at
 * all — which Claude Code reports as a hook error rather than a decision. So the default deadline
 * leaves real headroom for the ask write, the poll loop and the audit append.
 */
exports.DEFAULT_WAIT_SECONDS = 45;
/** Never wait past this, whatever is configured: the event's own budget is 60s. */
exports.MAX_WAIT_SECONDS = 55;
/** How often the verdict file is checked. Local stat, so this is cheap. */
exports.POLL_INTERVAL_MS = 250;
function waitSeconds(raw) {
    if (raw === undefined || raw.trim() === '') {
        return exports.DEFAULT_WAIT_SECONDS;
    }
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 1) {
        return exports.DEFAULT_WAIT_SECONDS;
    }
    return Math.min(Math.floor(n), exports.MAX_WAIT_SECONDS);
}
function isAsk(value) {
    const a = value;
    return !!a && typeof a.askId === 'string' && typeof a.deadline === 'string'
        && typeof a.tool === 'string';
}
function isVerdict(value) {
    const v = value;
    return !!v && typeof v.askId === 'string' && (v.decision === 'allow' || v.decision === 'deny');
}
function newAskId() {
    // Time-ordered prefix so `ls` sorts usefully, plus randomness so two hooks in the same
    // millisecond cannot collide.
    return `${Date.now().toString(36)}-${(0, crypto_1.randomBytes)(4).toString('hex')}`;
}
/** Write an ask atomically, so the daemon never reads a half-written question. */
async function writeAsk(ask, env) {
    const file = askPath(ask.askId, env);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(ask, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
}
async function readAsk(file) {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        return isAsk(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
async function writeVerdict(verdict, env) {
    const file = verdictPath(verdict.askId, env);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
}
async function readVerdict(file) {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        return isVerdict(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * Every ask still waiting for an answer — what the daemon serves.
 *
 * An ask with a verdict beside it is done. An ask past its deadline is not returned either: the hook
 * that wrote it has already given up and denied, so posting it to a human would invite an answer to
 * a question that no longer has anywhere to go.
 */
async function pendingAsks(now, env) {
    const dir = asksDir(env);
    let files;
    try {
        files = (await fs.promises.readdir(dir))
            .filter(f => f.endsWith('.json') && !f.endsWith('.verdict.json') && !f.includes('.tmp-'));
    }
    catch {
        return [];
    }
    const out = [];
    for (const file of files.sort()) {
        const ask = await readAsk(path.join(dir, file));
        if (ask === null) {
            continue;
        }
        if (Date.parse(ask.deadline) <= now.getTime()) {
            continue;
        }
        if (await readVerdict(verdictPath(ask.askId, env)) !== null) {
            continue;
        }
        out.push(ask);
    }
    return out;
}
/**
 * Delete an ask and its verdict once nobody can still be waiting on them.
 *
 * Kept for a grace period past the deadline rather than removed the moment it expires, so a human
 * answering a second late still finds the record they were answering, and so `--status`-style
 * inspection can see what just happened. This is housekeeping, not policy: the decision itself is
 * already in the audit trail, which is never pruned here.
 */
async function sweepAsks(now, graceMs, env) {
    const dir = asksDir(env);
    let files;
    try {
        files = await fs.promises.readdir(dir);
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const file of files) {
        const full = path.join(dir, file);
        // A tmp file from a killed writer is swept on age alone; it has no parseable deadline. Checked
        // BEFORE the `.json` guard, because an atomic write's temp name is `<name>.json.tmp-<pid>` and
        // so does not end in `.json` at all — testing that first made this branch unreachable and
        // leaked every interrupted write forever.
        if (file.includes('.tmp-')) {
            try {
                const stat = await fs.promises.stat(full);
                if (now.getTime() - stat.mtimeMs > graceMs) {
                    await fs.promises.unlink(full);
                    removed++;
                }
            }
            catch { /* already gone */ }
            continue;
        }
        if (!file.endsWith('.json')) {
            continue;
        }
        if (file.endsWith('.verdict.json')) {
            continue;
        } // removed with its ask
        const ask = await readAsk(full);
        if (ask === null) {
            continue;
        }
        if (now.getTime() - Date.parse(ask.deadline) <= graceMs) {
            continue;
        }
        try {
            await fs.promises.unlink(full);
            removed++;
        }
        catch { /* already gone */ }
        try {
            await fs.promises.unlink(verdictPath(ask.askId, env));
        }
        catch { /* none written */ }
    }
    return removed;
}
/**
 * Write the ask, then wait for a verdict until the deadline.
 *
 * Polling a local file rather than waiting on a watcher: `fs.watch` misses events on some platforms
 * and network filesystems, and a missed event here would hold the agent still until the deadline for
 * an answer that had already arrived. A 250 ms stat is cheap enough that the simpler mechanism wins.
 */
async function askHuman(opts) {
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms) => new Promise(r => { setTimeout(r, ms); }));
    const interval = opts.pollIntervalMs ?? exports.POLL_INTERVAL_MS;
    const startedAt = now();
    const deadline = Date.parse(opts.ask.deadline);
    await writeAsk(opts.ask, opts.env);
    const file = verdictPath(opts.ask.askId, opts.env);
    for (;;) {
        const verdict = await readVerdict(file);
        if (verdict !== null) {
            return { verdict, waitedMs: now() - startedAt };
        }
        if (now() >= deadline) {
            return { verdict: null, waitedMs: now() - startedAt };
        }
        // Never sleep past the deadline: overshooting it is time the agent is held for nothing.
        await sleep(Math.min(interval, Math.max(0, deadline - now())));
    }
}
/** Build the ask for one tool call. Pure, so the wording is testable. */
function buildAsk(args) {
    return {
        askId: args.askId ?? newAskId(),
        at: args.now.toISOString(),
        deadline: new Date(args.now.getTime() + args.waitSeconds * 1000).toISOString(),
        sessionId: args.sessionId,
        cwd: args.cwd,
        host: args.host ?? os.hostname().split('.')[0],
        tool: args.tool,
        inputSummary: args.inputSummary,
        reason: args.reason,
        pid: args.pid ?? process.pid,
    };
}
/**
 * How an ask reads to the human answering it.
 *
 * It has to carry enough to decide without opening the session: which host, which directory, which
 * call, and why the deterministic ladder could not settle it. And it has to say what silence will do,
 * because a decision prompt that hides its own default is how people learn the default the hard way.
 */
function renderAsk(ask) {
    const seconds = Math.max(0, Math.round((Date.parse(ask.deadline) - Date.parse(ask.at)) / 1000));
    return [
        `Session Sitter needs a decision — ${ask.tool}`,
        '',
        ask.inputSummary,
        '',
        `why    ${ask.reason}`,
        `where  ${ask.host}:${ask.cwd}`,
        `session ${ask.sessionId}`,
        '',
        `Reply "allow" to let it run, anything else denies it.`,
        `No answer within ${seconds}s denies it — silence is never approval.`,
    ].join('\n');
}
/**
 * Reading a reply as a decision is **not** defined here, deliberately.
 *
 * `Orchestrator.replyApproves` owns it, and the daemon routes an ask through the orchestrator, so
 * that is the definition which actually decides. A second copy in this module would be a second
 * answer to "what counts as approval" — and the one that lost would be the one nobody noticed had
 * stopped matching.
 */
