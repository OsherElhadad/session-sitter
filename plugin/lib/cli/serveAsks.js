// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/serveAsks.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The daemon's side of hook escalation: turn an **ask** into a decision card, and a human's answer
 * back into a **verdict** the waiting hook can read.
 *
 * ## Why an ask becomes a real supervision record
 *
 * The tempting shortcut is for the daemon to post asks and read their replies with its own
 * `channel.pollResponses` call, separate from the orchestrator's. That reintroduces the bug this whole
 * design is built to avoid, *inside one process*: `getUpdates` has a single destructive cursor, so two
 * `pollResponses` calls per pass would each consume updates meant for the other, and each would look
 * like it was working while silently dropping half the answers.
 *
 * There is exactly one safe number of readers, and the orchestrator already is one. So an ask is
 * promoted into a `SupervisionRecord` in `orange_awaiting_user` with its `timeout_deadline` set to the
 * ask's own deadline, and from then on `Orchestrator.poll()` does the work it already does: correlate
 * the reply, or expire the card. This module only translates at the two edges.
 *
 * ## The record id carries the ask id
 *
 * `req-ask-<askId>`, so the mapping between an ask and its record needs no side table that could go
 * out of step with either.
 *
 * ## The verdict is derived from the orchestrator's own reading of the reply
 *
 * Not from a second parser. `Orchestrator.replyApproves` decides what counts as approval, and it is
 * the function that also resolves Bob approvals — one definition, so the two surfaces cannot come to
 * disagree about what "no, don't allow that" means.
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
exports.recordIdFor = recordIdFor;
exports.askIdFrom = askIdFrom;
exports.recordForAsk = recordForAsk;
exports.postNewAsks = postNewAsks;
exports.harvestVerdicts = harvestVerdicts;
exports.serveAsks = serveAsks;
exports.shortHost = shortHost;
const os = __importStar(require("os"));
const escalate_1 = require("../hooks/escalate");
const orchestrator_1 = require("../supervisor/orchestrator");
const models_1 = require("../supervisor/models");
/** The record id for an ask, and its inverse. One rule, in one place. */
function recordIdFor(askId) {
    return `req-ask-${askId}`;
}
function askIdFrom(requestId) {
    return requestId.startsWith('req-ask-') ? requestId.slice('req-ask-'.length) : null;
}
/**
 * The supervision record for an ask.
 *
 * `await_light: 'orange'` because that is the state the orchestrator's reply and timeout handling is
 * written for: orange denies and relays, which is exactly what a declined permission prompt should do.
 * The assessment carries the rendered question so the card reads the same wherever it is delivered.
 */
function recordForAsk(ask, now) {
    return (0, models_1.newRecord)({
        request_id: recordIdFor(ask.askId),
        session_id: ask.sessionId,
        source: 'claude',
        state: models_1.SupervisionState.ORANGE_AWAITING_USER,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        host: ask.host,
        assessment: {
            traffic_light: 'orange',
            summary: `${ask.tool}: ${ask.inputSummary}`,
            human_notification: (0, escalate_1.renderAsk)(ask),
            user_intent: ask.reason,
        },
        // `await_light: 'orange'` is what the orchestrator's reply and timeout handling is written for:
        // orange denies and relays, which is exactly what a declined permission prompt should do.
        await_light: 'orange',
        // There is no live approval prompt to resolve on the agent side — the hook *is* the thing
        // waiting, and it is waiting on a file. Null here is what keeps the outbox from being handed a
        // delivery addressed to a request id no agent has ever heard of.
        pending_request_id: null,
        timeout_deadline: ask.deadline,
    });
}
/**
 * Promote every new ask into a card, once.
 *
 * Idempotent by construction: an ask whose record already exists is skipped, so a pass that crashes
 * after saving but before sending does not double-post, and a pass that crashes after sending does not
 * lose the record.
 *
 * A send that fails leaves the record in place with no `notification_id`, and the next pass retries.
 * The reverse order — send first, save after — would post a card whose reply nothing could correlate.
 */
async function postNewAsks(deps) {
    const now = deps.now();
    let posted = 0;
    for (const ask of await (0, escalate_1.pendingAsks)(now, deps.env)) {
        const id = recordIdFor(ask.askId);
        const existing = await deps.store.get(id);
        if (existing !== null) {
            // Already known. Retry only the send, and only if it never landed.
            if (existing.notification_id) {
                continue;
            }
        }
        const record = existing ?? recordForAsk(ask, now);
        if (existing === null) {
            await deps.store.save(record);
        }
        try {
            const sent = await deps.channel.send(record, String((record.assessment ?? {}).human_notification ?? ''), true);
            record.notification_id = sent.messageId;
            record.notified_at = sent.sentAt ?? now.toISOString();
            await deps.store.save(record);
            posted++;
            deps.log(`asked a human about ${ask.tool} (${ask.askId}), ${Math.round((Date.parse(ask.deadline) - now.getTime()) / 1000)}s to answer`);
        }
        catch (err) {
            // The hook is waiting on a deadline, so a failed send costs it that deadline and nothing worse.
            // Saying which ask failed is the difference between debugging this and guessing.
            deps.log(`could not deliver ask ${ask.askId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return posted;
}
/**
 * Write verdict files for the asks the orchestrator has resolved.
 *
 * Only a record carrying a `user_response` produces a verdict: that field is set by
 * `resolveWithReply`, so its presence *is* "a human answered". A timed-out record produces nothing on
 * purpose — the hook has already applied its own deadline and denied, and writing a verdict for a
 * question nobody answered would be inventing an answer.
 */
async function harvestVerdicts(deps) {
    const now = deps.now();
    let written = 0;
    const resolved = await deps.store.byState(models_1.SupervisionState.ORANGE_RESOLVED_BY_USER, models_1.SupervisionState.YELLOW_READY, models_1.SupervisionState.YELLOW_DELIVERED, models_1.SupervisionState.ORANGE_TRANSITIONED_TO_YELLOW, models_1.SupervisionState.RED_BLOCKED);
    for (const record of resolved) {
        const askId = askIdFrom(record.request_id);
        if (askId === null) {
            continue;
        }
        const reply = record.user_response;
        if (typeof reply !== 'string' || reply.trim() === '') {
            continue;
        }
        // Already answered on a previous pass.
        if (await (0, escalate_1.readVerdict)((0, escalate_1.verdictPath)(askId, deps.env)) !== null) {
            continue;
        }
        // The ask file is what says the question was real; without it there is nothing to answer.
        if (await (0, escalate_1.readAsk)((0, escalate_1.askPath)(askId, deps.env)) === null) {
            continue;
        }
        const verdict = {
            askId,
            decision: orchestrator_1.Orchestrator.replyApproves(reply) ? 'allow' : 'deny',
            // The channel's InboundResponse carries no identity, so this does not claim one. "a human"
            // is what is actually known, and inventing a name in an audit record is worse than a vague one.
            by: 'a human',
            text: reply,
            at: record.user_response_at ?? now.toISOString(),
        };
        await (0, escalate_1.writeVerdict)(verdict, deps.env);
        written++;
        deps.log(`${askId}: ${verdict.decision} by ${verdict.by}`);
    }
    return written;
}
/** One pass of the ask service: post what is new, then write out what has been answered. */
async function serveAsks(deps) {
    const posted = await postNewAsks(deps);
    const answered = await harvestVerdicts(deps);
    return { posted, answered };
}
/** Short host name, as an ask records it. Exported so a test need not shell out. */
function shortHost() {
    return os.hostname().split('.')[0];
}
