// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/agentControl.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Deliver supervisor guidance back to the coding agent.
 *
 * Ported from the Python supervisor (`agent_control.py`. The orchestrator writes a labeled delivery
 * to `<stateDir>/outbox/<deliveryId>.json`; the extension's `SupervisorOutbox` watcher reads it
 * and applies it — through the agent's approval emitter for a prompt-blocked task, or as an
 * injected chat message for an idle one. This module owns the *write* side + the outbox
 * contract; the outbox owns the applying. Messages are never phrased as the user.
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
exports.RecordOnlyController = exports.OutboxAgentController = exports.DeliveryFailed = void 0;
exports.deliveryId = deliveryId;
exports.buildDelivery = buildDelivery;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const messaging_1 = require("./messaging");
class DeliveryFailed extends Error {
    constructor(message) {
        super(message);
        this.name = 'DeliveryFailed';
    }
}
exports.DeliveryFailed = DeliveryFailed;
function labeled(text) {
    const t = text.trim();
    return t.startsWith(messaging_1.SUPERVISOR_LABEL) ? t : `${messaging_1.SUPERVISOR_LABEL} ${t}`;
}
/**
 * Stable per (session, kind, text, requestId) so a re-run dedupes downstream, while distinct
 * approval requests get distinct deliveries.
 */
function deliveryId(sessionId, kind, text, requestId) {
    const digest = (0, crypto_1.createHash)('sha1')
        .update(`${sessionId}:${kind}:${requestId ?? ''}:${text}`, 'utf8')
        .digest('hex').slice(0, 12);
    return `del-${digest}`;
}
function buildDelivery(args) {
    // A question answer reads as the user's own choice, so it is NOT labeled as the supervisor;
    // every other delivery carries the supervisor label.
    const text = args.kind === 'answer_question' ? args.text.trim() : labeled(args.text);
    const requestId = args.requestId ?? null;
    const channel = args.channel ?? (requestId ? 'approval' : 'message');
    return {
        deliveryId: deliveryId(args.sessionId, args.kind, text, requestId),
        sessionId: args.sessionId,
        source: args.source,
        text,
        kind: args.kind,
        requestId,
        channel,
        decision: args.decision ?? 'reject',
        answers: args.answers ?? null,
    };
}
/** Writes one JSON delivery per message into `outbox/` for the extension bridge. */
class OutboxAgentController {
    constructor(outboxDir, 
    /** Called after each successful write so the applier can run immediately instead of on its
     *  next poll tick. Optional; failures are swallowed (the poll timer is the safety net). */
    onDelivered) {
        this.outboxDir = outboxDir;
        this.onDelivered = onDelivered;
        fs.mkdirSync(this.outboxDir, { recursive: true });
    }
    async deliver(args) {
        const delivery = buildDelivery(args);
        const payload = {
            deliveryId: delivery.deliveryId,
            sessionId: delivery.sessionId,
            source: delivery.source,
            text: delivery.text,
            kind: delivery.kind,
            requestId: delivery.requestId,
            channel: delivery.channel,
            decision: delivery.decision,
            answers: delivery.answers,
        };
        const target = path.join(this.outboxDir, `${delivery.deliveryId}.json`);
        // Atomic write so the applier never reads a half-written file.
        const tmp = `${target}.tmp-${(0, crypto_1.randomBytes)(4).toString('hex')}`;
        await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await fs.promises.rename(tmp, target);
        try {
            this.onDelivered?.();
        }
        catch { /* the poll timer still covers it */ }
        return delivery;
    }
}
exports.OutboxAgentController = OutboxAgentController;
/** Test controller: records deliveries in memory, no filesystem / extension. */
class RecordOnlyController {
    constructor() {
        this.deliveries = [];
    }
    async deliver(args) {
        const delivery = buildDelivery(args);
        this.deliveries.push(delivery);
        return delivery;
    }
}
exports.RecordOnlyController = RecordOnlyController;
