// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/sessionIdentity.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Who a supervision decision belongs to: the session's human name and the machine it runs on.
 *
 * A record's `session_id` is a UUID (Claude) or a task id (Bob) — unreadable, and identical in
 * shape on every machine. With one Telegram chat receiving decisions from several machines, and a
 * panel listing decisions from several sessions, that id cannot answer the only question the user
 * actually has: *which session was this?* So every record carries a name and a host, and both the
 * card and the feed render them through the helpers here — one format, one place to change it.
 *
 * Pure except for `localHostName`, the single reader of `os.hostname()`.
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
exports.shortHost = shortHost;
exports.localHostName = localHostName;
exports.hostFromPeer = hostFromPeer;
exports.sessionNameFrom = sessionNameFrom;
exports.sessionDisplayName = sessionDisplayName;
exports.sessionRefLine = sessionRefLine;
const os = __importStar(require("os"));
/** Drop the DNS domain from a host name: "box.lan" → "box". Trims whitespace. */
function shortHost(name) {
    return (name ?? '').trim().split('.')[0];
}
/** The short name of the machine this extension — and so this supervisor — runs on. */
function localHostName() {
    try {
        return shortHost(os.hostname());
    }
    catch {
        return '';
    }
}
/**
 * The host out of a peer spec ("user@host", as `ClaudeSession.peer` carries it). An empty or
 * malformed spec yields '' so the caller can fall back to the local host.
 */
function hostFromPeer(peer) {
    if (!peer) {
        return '';
    }
    const at = peer.lastIndexOf('@');
    return shortHost(at >= 0 ? peer.slice(at + 1) : peer);
}
/**
 * The name to record for a session: its title, else its project name. Null when it has neither,
 * so the display falls back to the id rather than showing an empty label.
 */
function sessionNameFrom(session) {
    const title = (session.title ?? '').trim();
    if (title) {
        return title;
    }
    const project = (session.projectName ?? '').trim();
    return project || null;
}
/** What a session is called, given its recorded name and its id. Never empty (unless both are). */
function sessionDisplayName(sessionName, sessionId) {
    const name = (sessionName ?? '').trim();
    return name || (sessionId ?? '');
}
/**
 * One line naming the session a decision belongs to:
 *
 *     session: fix the login flow @ devbox (a1b2c3d4-…)
 *
 * The id is appended only when the name is something other than the id itself, so a record
 * written before names existed still reads exactly `session: <id>`.
 */
function sessionRefLine(fields) {
    const id = fields.session_id ?? '';
    const name = sessionDisplayName(fields.session_name, id);
    const host = shortHost(fields.host);
    let line = `session: ${name}`;
    if (host) {
        line += ` @ ${host}`;
    }
    if (id && name !== id) {
        line += ` (${id})`;
    }
    return line;
}
