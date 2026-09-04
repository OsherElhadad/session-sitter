// GENERATED FILE — DO NOT EDIT.
// Compiled from src/daemonHeartbeat.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The daemon's heartbeat — written by `session-sitter daemon`, read by anyone who needs to know
 * whether supervision is actually running here.
 *
 * ## Why this is its own module
 *
 * Two very different processes need it, and only one of them can afford the other's dependencies.
 * `PermissionRequest` reads it to decide whether escalating to a human is even answerable, and that
 * hook runs **once per permission prompt** with a human waiting on the other side — its measured p50
 * is dominated by Node startup and module load. Importing it from `src/cli/daemon.ts` would drag the
 * orchestrator, the supervisor factory, the Telegram client and the window registry into the closure
 * of every prompt, to call three functions that touch one small JSON file.
 *
 * So the state lives here, the daemon writes it, and the hook reads it. Neither imports the other.
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
exports.DEFAULT_INTERVAL_SECONDS = void 0;
exports.heartbeatPath = heartbeatPath;
exports.writeHeartbeat = writeHeartbeat;
exports.readHeartbeat = readHeartbeat;
exports.health = health;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const paths_1 = require("./hooks/paths");
/**
 * Seconds between passes a daemon runs at by default.
 *
 * Here rather than in the daemon because {@link health} needs it as its own default: a reader that
 * has not been told the interval still has to make a staleness judgement, and importing the daemon to
 * learn one number is the coupling this module exists to avoid.
 */
exports.DEFAULT_INTERVAL_SECONDS = 5;
function heartbeatPath(env = process.env) {
    return path.join((0, paths_1.dataDir)(env), 'daemon.json');
}
async function writeHeartbeat(beat, file) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // Atomic: `--status` in another process must never read half a record and call it stale.
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(beat, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
}
async function readHeartbeat(file) {
    try {
        const raw = await fs.promises.readFile(file, 'utf8');
        const beat = JSON.parse(raw);
        return typeof beat.pid === 'number' && typeof beat.lastPassAt === 'string' ? beat : null;
    }
    catch {
        return null;
    }
}
/** A pass is late once it is this many times the interval overdue. */
const STALE_FACTOR = 6;
function health(beat, now, isAlive, intervalSeconds = exports.DEFAULT_INTERVAL_SECONDS) {
    if (beat === null) {
        return 'none';
    }
    // A finished single pass is not a dead daemon. Check this before liveness, because the pid being
    // gone is exactly what `--once` is supposed to leave behind.
    if (beat.mode === 'once') {
        return 'oneshot';
    }
    if (!isAlive(beat.pid)) {
        return 'dead';
    }
    const last = Date.parse(beat.lastPassAt);
    if (Number.isNaN(last)) {
        return 'stale';
    }
    return now - last > intervalSeconds * STALE_FACTOR * 1000 ? 'stale' : 'running';
}
