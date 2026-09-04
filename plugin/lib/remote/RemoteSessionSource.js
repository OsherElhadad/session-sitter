// GENERATED FILE — DO NOT EDIT.
// Compiled from src/remote/RemoteSessionSource.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
exports.RemoteSessionSource = void 0;
exports.localMachineId = localMachineId;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
const sessionRows_1 = require("../sessionRows");
const remoteProbe_1 = require("./remoteProbe");
/** Identity of this machine, in the same shape the probe reports. */
function localMachineId() {
    return `${os.hostname()}:${process.getuid?.() ?? 0}`;
}
class RemoteSessionSource {
    constructor(opts) {
        this._peers = new Map();
        this._order = [];
        this._runner = opts.runner;
        this._discover = opts.discover;
        this._parseSessionFile = opts.parseSessionFile;
        this._localMachineId = opts.localMachineId ?? localMachineId();
        this._tmpDir = opts.tmpDir ?? path.join(os.tmpdir(), 'session-sitter-remote');
    }
    /** Every remote session currently known, newest first. */
    getSessions() {
        const all = [];
        for (const peer of this._order) {
            const state = this._peers.get(peer.raw);
            if (state) {
                all.push(...state.sessions);
            }
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
    getPeerWindows() {
        const all = [];
        for (const peer of this._order) {
            const state = this._peers.get(peer.raw);
            if (state) {
                all.push(...state.windows);
            }
        }
        return all;
    }
    /** Per-peer reachability, so the panel can say which machines it could not reach. */
    getPeerStatuses() {
        return this._order
            .map(p => this._peers.get(p.raw)?.status)
            .filter((s) => s !== undefined);
    }
    /**
     * Which peer window owns a workspace path, for focusing a session on its own machine.
     * Mirrors the local containment test in `SessionSitterViewProvider._findOwnerWindow`.
     */
    findOwnerWindow(projectPath) {
        if (!projectPath) {
            return null;
        }
        for (const peer of this._order) {
            const state = this._peers.get(peer.raw);
            if (!state) {
                continue;
            }
            for (const window of state.windows) {
                const owns = (window.workspaceFolders ?? []).some(wf => projectPath === wf || projectPath.startsWith(wf + '/'));
                if (owns) {
                    return { peer, window };
                }
            }
        }
        return null;
    }
    /** Probe every discovered peer. Never throws: a failed peer becomes an unreachable status. */
    async refresh() {
        let peers;
        try {
            peers = await this._discover();
        }
        catch {
            return;
        }
        const order = [];
        for (const peer of peers) {
            const kept = await this._refreshPeer(peer);
            if (kept) {
                order.push(peer);
            }
            else {
                this._peers.delete(peer.raw);
            }
        }
        this._order = order;
    }
    /** Returns false when the peer should not be listed at all (it is this machine). */
    async _refreshPeer(peer) {
        const prev = this._peers.get(peer.raw);
        const known = prev?.known ?? {};
        let raw;
        try {
            // `python3 -` reads the program from stdin. See SshRunner: ssh hands its command words to a
            // remote shell, so the script travels on stdin and its argument travels as base64.
            const knownB64 = Buffer.from(JSON.stringify(known), 'utf8').toString('base64');
            raw = await this._runner.run(peer, ['python3', '-', knownB64], { stdin: remoteProbe_1.REMOTE_PROBE_PY });
        }
        catch (err) {
            this._setUnreachable(peer, prev, err instanceof Error ? err.message : String(err));
            return true;
        }
        let payload;
        try {
            payload = JSON.parse(raw);
            if (payload === null || typeof payload !== 'object') {
                throw new Error('not an object');
            }
        }
        catch {
            // A peer missing python3 prints nothing usable here.
            this._setUnreachable(peer, prev, 'peer returned no usable session data');
            return true;
        }
        // Discovery can name the machine we are already running on.
        if (payload.machineId && payload.machineId === this._localMachineId) {
            return false;
        }
        const windows = Array.isArray(payload.windows) ? payload.windows : [];
        const sessions = [];
        for (const row of Array.isArray(payload.bobRows) ? payload.bobRows : []) {
            try {
                const session = (0, sessionRows_1.bobRowToSession)(row, peer.raw);
                if (session) {
                    sessions.push(session);
                }
            }
            catch { /* skip a malformed row, keep the rest */ }
        }
        const claudeSessions = new Map();
        const nextKnown = {};
        for (const file of Array.isArray(payload.claudeFiles) ? payload.claudeFiles : []) {
            if (!file || typeof file.sessionId !== 'string') {
                continue;
            }
            const cached = prev?.claudeSessions.get(file.sessionId);
            let session = null;
            if (file.gz) {
                session = await this._parseRemoteTranscript(peer, file.sessionId, file.gz, file.mtime);
            }
            else if (cached && prev?.known[file.sessionId] === file.mtime) {
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
    async _parseRemoteTranscript(peer, sessionId, gz, mtime) {
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
            if (!session) {
                return null;
            }
            return { ...session, peer: peer.raw };
        }
        catch {
            return null;
        }
    }
    _setUnreachable(peer, prev, error) {
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
exports.RemoteSessionSource = RemoteSessionSource;
