// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/messaging.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Messaging boundary for human-in-the-loop notifications.
 *
 * Ported from the Python supervisor (`messaging.py`. `StubChannel` writes notifications to files and
 * reads simulated replies from `inbox/<requestId>.txt`, so the full Orange lifecycle is
 * exercisable with no network. `TelegramChannel` (telegram.ts) is the real channel. Correlation,
 * dedupe, and failure handling live in the orchestrator/store — not here — so they hold for
 * every channel.
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
exports.FakeChannel = exports.StubChannel = exports.DeliveryError = exports.SUPERVISOR_LABEL = void 0;
exports.formatNotification = formatNotification;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const sessionIdentity_1 = require("./sessionIdentity");
const timeutil_1 = require("./timeutil");
exports.SUPERVISOR_LABEL = '[Session Supervisor]';
/** Raised when an outbound notification cannot be delivered. */
class DeliveryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DeliveryError';
    }
}
exports.DeliveryError = DeliveryError;
/**
 * Prefix a notification with the supervisor label + a session reference. Never phrased as the
 * user or as the agent — this is unambiguously a supervisor notification.
 */
function formatNotification(record, notification) {
    return (`${exports.SUPERVISOR_LABEL} human input needed\n`
        + `${(0, sessionIdentity_1.sessionRefLine)(record)}\n`
        + `reply id: ${record.request_id}\n\n`
        + `${notification}`);
}
/** Logs notifications to files; reads simulated replies from `inbox/<requestId>.txt`. */
class StubChannel {
    constructor(notificationsDir, inboxDir, clock = timeutil_1.nowUtc, log = () => { }) {
        this.notificationsDir = notificationsDir;
        this.inboxDir = inboxDir;
        this.clock = clock;
        this.log = log;
        fs.mkdirSync(this.notificationsDir, { recursive: true });
        fs.mkdirSync(this.inboxDir, { recursive: true });
    }
    async send(record, notification) {
        const sentAt = (0, timeutil_1.toIso)(this.clock());
        const body = formatNotification(record, notification);
        await fs.promises.writeFile(path.join(this.notificationsDir, `${record.request_id}.txt`), body, 'utf8');
        this.log(`\n=== NOTIFICATION (stub) ===\n${body}\n===========================\n`);
        return { messageId: `stub-${record.request_id}`, sentAt };
    }
    async pollResponses(pending) {
        const out = [];
        for (const record of pending) {
            const drop = path.join(this.inboxDir, `${record.request_id}.txt`);
            let text;
            try {
                text = (await fs.promises.readFile(drop, 'utf8')).trim();
            }
            catch {
                continue;
            }
            const digest = (0, crypto_1.createHash)('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
            out.push({
                updateId: `${record.request_id}:${digest}`,
                correlationId: record.request_id,
                text,
                receivedAt: (0, timeutil_1.toIso)(this.clock()),
            });
        }
        return out;
    }
}
exports.StubChannel = StubChannel;
/** In-memory channel for tests. Records sends; returns queued replies. */
class FakeChannel {
    constructor(fail = false, clock = timeutil_1.nowUtc) {
        this.clock = clock;
        this.sent = [];
        this.fail = false;
        this.queued = new Map();
        this.counter = 0;
        this.fail = fail;
    }
    queueResponse(correlationId, text) {
        const list = this.queued.get(correlationId) ?? [];
        list.push(text);
        this.queued.set(correlationId, list);
    }
    async send(record, notification, interactive = true) {
        if (this.fail) {
            throw new DeliveryError('simulated delivery failure');
        }
        this.sent.push({ requestId: record.request_id, notification, interactive });
        this.counter++;
        return { messageId: `fake-${this.counter}`, sentAt: (0, timeutil_1.toIso)(this.clock()) };
    }
    async pollResponses(pending) {
        const pendingIds = new Set(pending.map(r => r.request_id));
        const out = [];
        for (const [cid, texts] of [...this.queued.entries()]) {
            // "@active" = a general message (not tied to a card) — always delivered.
            if (!pendingIds.has(cid) && cid !== '@active') {
                continue;
            }
            texts.forEach((text, i) => {
                const digest = (0, crypto_1.createHash)('sha1').update(`${cid}:${i}:${text}`, 'utf8').digest('hex').slice(0, 12);
                out.push({
                    updateId: `${cid}:${digest}`,
                    correlationId: cid,
                    text,
                    receivedAt: (0, timeutil_1.toIso)(this.clock()),
                });
            });
        }
        return out;
    }
}
exports.FakeChannel = FakeChannel;
