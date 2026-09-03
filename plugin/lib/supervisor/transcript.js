// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/transcript.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Consume the full session transcript exported by the extension.
 *
 * Ported from the Python supervisor (`transcript.py`. `SessionExporter` is the single reader of
 * the agents' stores; it writes a JSON *export contract* to `STATE_DIR/history/<sessionId>.json`
 * and this module loads and validates that contract into a `NormalizedSession`.
 *
 * Export contract (camelCase, TS-native). Keys are accepted case-tolerantly so a file written
 * by the original Python-era tooling (snake_case) still loads.
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
exports.FileTranscriptSource = exports.TranscriptError = exports.EXPORT_SCHEMA_VERSION = void 0;
exports.originalRequest = originalRequest;
exports.lastUserMessage = lastUserMessage;
exports.sessionFromDict = sessionFromDict;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** The one definition. `SessionExporter` imports it from here — this module has no `vscode`
 *  dependency, so it is the half of the pair both sides can reach. Two copies drift. */
exports.EXPORT_SCHEMA_VERSION = '1.0';
/** Raised when a transcript export is missing or malformed. Fails loud, never silent. */
class TranscriptError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TranscriptError';
    }
}
exports.TranscriptError = TranscriptError;
/** The first genuine user turn — the user's original ask. */
function originalRequest(s) {
    for (const turn of s.turns) {
        if (turn.role === 'user' && turn.text.trim()) {
            return turn.text;
        }
    }
    return '';
}
function lastUserMessage(s) {
    for (let i = s.turns.length - 1; i >= 0; i--) {
        const turn = s.turns[i];
        if (turn.role === 'user' && turn.text.trim()) {
            return turn.text;
        }
    }
    return '';
}
function pick(d, keys, fallback = undefined) {
    for (const k of keys) {
        if (k in d && d[k] !== null && d[k] !== undefined) {
            return d[k];
        }
    }
    return fallback;
}
const asRecord = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
function parseToolCall(d) {
    const raw = pick(d, ['arguments', 'args'], {});
    const args = asRecord(raw) ?? { _raw: raw };
    return {
        id: String(pick(d, ['id'], '')),
        name: String(pick(d, ['name'], '')),
        arguments: args,
        permission: pick(d, ['permission'], null),
    };
}
function parseToolResult(d) {
    return {
        callId: String(pick(d, ['callId', 'call_id', 'id'], '')),
        name: String(pick(d, ['name'], '')),
        permission: pick(d, ['permission'], null),
        isError: Boolean(pick(d, ['isError', 'is_error'], false)),
        content: String(pick(d, ['content'], '')),
    };
}
function parseTurn(d, fallbackIndex) {
    const o = asRecord(d);
    if (!o) {
        throw new TranscriptError(`turn #${fallbackIndex} is not an object`);
    }
    const role = pick(o, ['role']);
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
        throw new TranscriptError(`turn #${fallbackIndex} has invalid role: ${JSON.stringify(role)}`);
    }
    const callsRaw = pick(o, ['toolCalls', 'tool_calls'], []);
    const resultRaw = asRecord(pick(o, ['toolResult', 'tool_result']));
    const idx = pick(o, ['index'], fallbackIndex);
    return {
        index: typeof idx === 'number' ? idx : Number(idx),
        role,
        text: String(pick(o, ['text'], '')),
        timestamp: pick(o, ['timestamp'], null),
        toolCalls: Array.isArray(callsRaw)
            ? callsRaw.map(asRecord).filter((c) => c !== null).map(parseToolCall)
            : [],
        toolResult: resultRaw ? parseToolResult(resultRaw) : null,
    };
}
function parsePending(d) {
    const o = asRecord(d);
    if (!o) {
        return null;
    }
    const args = asRecord(pick(o, ['arguments', 'args']));
    const turnIndex = pick(o, ['turnIndex', 'turn_index'], null);
    return {
        kind: String(pick(o, ['kind'], 'unknown')),
        description: String(pick(o, ['description'], '')),
        name: pick(o, ['name'], null),
        arguments: args,
        permission: pick(o, ['permission'], null),
        turnIndex: typeof turnIndex === 'number' ? turnIndex : null,
        requestId: pick(o, ['requestId', 'request_id'], null),
    };
}
function sessionFromDict(data) {
    const d = asRecord(data);
    if (!d) {
        throw new TranscriptError('transcript export must be a JSON object');
    }
    const sessionId = pick(d, ['sessionId', 'session_id']);
    if (!sessionId) {
        throw new TranscriptError('transcript export missing sessionId');
    }
    // The version pin is load-bearing or it is decoration. An export that declares a version we
    // do not know is refused rather than half-read: the fields we recognise may mean something
    // else in that version. Absent stays tolerated — the Python-era exports this loader still
    // documents support for predate the field, and every export we write carries it.
    const declared = pick(d, ['schemaVersion', 'schema_version'], null);
    if (declared != null && String(declared) !== exports.EXPORT_SCHEMA_VERSION) {
        throw new TranscriptError(`unsupported transcript export schemaVersion '${String(declared)}' `
            + `(expected '${exports.EXPORT_SCHEMA_VERSION}')`);
    }
    const turnsRaw = pick(d, ['turns'], null);
    if (!Array.isArray(turnsRaw)) {
        throw new TranscriptError("transcript export missing 'turns' list");
    }
    return {
        sessionId: String(sessionId),
        source: String(pick(d, ['source'], 'bob')),
        turns: turnsRaw.map((t, i) => parseTurn(t, i)),
        waitingReason: String(pick(d, ['waitingReason', 'waiting_reason'], '')),
        user: pick(d, ['user'], null),
        projectPath: String(pick(d, ['projectPath', 'project_path'], '')),
        projectName: String(pick(d, ['projectName', 'project_name'], '')),
        status: String(pick(d, ['status'], '')),
        approvalConfig: pick(d, ['approvalConfig', 'approval_config'], null),
        title: String(pick(d, ['title'], '')),
        pendingAction: parsePending(pick(d, ['pendingAction', 'pending_action'])),
    };
}
/**
 * Loads the export produced by `SessionExporter` at `history/<sessionId>.json`.
 * An explicit `overridePath` lets the CLI point at any export file for offline runs.
 */
class FileTranscriptSource {
    constructor(historyDir, overridePath) {
        this.historyDir = historyDir;
        this.overridePath = overridePath;
    }
    pathFor(sessionId) {
        return this.overridePath ?? path.join(this.historyDir, `${sessionId}.json`);
    }
    async load(sessionId) {
        const p = this.pathFor(sessionId);
        let raw;
        try {
            raw = await fs.promises.readFile(p, 'utf8');
        }
        catch (err) {
            const e = err;
            if (e.code === 'ENOENT') {
                throw new TranscriptError(`no transcript export at ${p}. Produce it with SessionExporter `
                    + '(or pass --transcript <path>).');
            }
            throw new TranscriptError(`failed to read transcript export ${p}: ${String(err)}`);
        }
        let data;
        try {
            data = JSON.parse(raw);
        }
        catch (err) {
            throw new TranscriptError(`failed to read transcript export ${p}: ${String(err)}`);
        }
        const session = sessionFromDict(data);
        // The export filename is authoritative for the id we were asked about.
        if (session.sessionId !== sessionId && this.overridePath === undefined) {
            throw new TranscriptError(`transcript export sessionId ${JSON.stringify(session.sessionId)} != requested ${JSON.stringify(sessionId)}`);
        }
        return session;
    }
}
exports.FileTranscriptSource = FileTranscriptSource;
