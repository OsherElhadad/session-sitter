// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/telegram.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Real Telegram Bot API channel: decision cards with icon + description + choices + timer.
 *
 * Ported from the Python supervisor (`telegram.py`. Uses `fetch` (Node 18+) — no new dependency.
 *
 * - `send(record, notification, interactive=true)`: an ORANGE/RED decision goes out as an
 *   interactive card (inline-keyboard choices + "reply with text" + a countdown). GREEN/YELLOW
 *   go out non-interactively as a one-way update card.
 * - `pollResponses(pending)`: correlates button taps (callback_data `<requestId>|<idx>`) and
 *   text replies back to the pending records, so the user's answer drives the next decision.
 * - `refreshTimers(pending)`: best-effort `editMessageText` to tick the countdown down.
 *
 * Card and keyboard building are pure functions so they are testable without any network; the
 * HTTP call is a single injectable `api` callable.
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
exports.TelegramChannel = exports.ACTIVE_SESSION = exports.DEFAULT_OPTIONS = exports.LIGHT_ICON = void 0;
exports.optionsFor = optionsFor;
exports.buildCard = buildCard;
exports.applyToggle = applyToggle;
exports.questionOptionLabel = questionOptionLabel;
exports.buildQuestionCard = buildQuestionCard;
exports.defaultApi = defaultApi;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const messaging_1 = require("./messaging");
const models_1 = require("./models");
const sessionIdentity_1 = require("./sessionIdentity");
const timeutil_1 = require("./timeutil");
exports.LIGHT_ICON = {
    green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴',
};
exports.DEFAULT_OPTIONS = ['✅ Approve', '⛔ Reject'];
/**
 * A text message that is not a reply to a live decision card is a general instruction from the
 * user — forward it straight to the active agent session (correlationId set to this sentinel).
 */
exports.ACTIVE_SESSION = '@active';
function optionsFor(record) {
    const a = record.assessment ?? {};
    // Keep button labels short so they render cleanly and reliably as inline buttons.
    const raw = Array.isArray(a.human_options) ? a.human_options : [];
    const opts = raw
        .map(o => String(o).trim().slice(0, 28))
        .filter(o => o.length > 0);
    return opts.length ? opts.slice(0, 4) : exports.DEFAULT_OPTIONS;
}
function timerLine(minutesLeft, deadlineIso) {
    if (minutesLeft === null) {
        return '⏳ Waiting for your decision.';
    }
    const until = deadlineIso ? ` (until ${deadlineIso.slice(11, 16)} UTC)` : '';
    return `⏳ ${Math.max(0, minutesLeft)} min to respond${until} — no reply → safe fallback.`;
}
/** Return [text, replyMarkup]. `replyMarkup` is null for a one-way update. */
function buildCard(record, notification, opts = {}) {
    const interactive = opts.interactive ?? true;
    const minutesLeft = opts.minutesLeft ?? null;
    const deadlineIso = opts.deadlineIso ?? null;
    const a = record.assessment ?? {};
    const light = String(a.traffic_light ?? '');
    const icon = exports.LIGHT_ICON[light] ?? '';
    const summary = String(a.summary ?? '').trim();
    const userIntent = String(a.user_intent ?? '').trim();
    const agentIntent = String(a.agent_intent ?? '').trim();
    const header = `${icon} ${light.toUpperCase()} — ${summary}`.replace(/^[\s—]+|[\s—]+$/g, '');
    const lines = [
        header,
        '',
        `${messaging_1.SUPERVISOR_LABEL} ${interactive ? 'decision needed' : 'update'}`,
        (0, sessionIdentity_1.sessionRefLine)(record),
    ];
    if (userIntent) {
        lines.push(`🧑 request: ${userIntent}`);
    }
    if (agentIntent) {
        lines.push(`🤖 wants to: ${agentIntent}`);
    }
    if (interactive) {
        lines.push(`reply id: ${record.request_id}`);
    }
    lines.push('', notification.trim());
    let text = lines.join('\n').trim();
    if (!interactive) {
        return [text, null];
    }
    const options = optionsFor(record);
    const keyboard = options.map((o, i) => ([{ text: o, callback_data: `${record.request_id}|${i}` }]));
    text = `${text}\n\n${timerLine(minutesLeft, deadlineIso)}\nOr reply with text.`;
    return [text, { inline_keyboard: keyboard }];
}
/**
 * Toggle a label into `draft.answers[qkey]`. Single-select replaces the list; multi-select adds
 * the label, or removes it when already present. Mutates and returns the draft (as the original
 * did, so a caller can keep the same object identity).
 */
function applyToggle(draft, qkey, label, multi) {
    if (!draft.answers) {
        draft.answers = {};
    }
    const answers = draft.answers;
    const current = [...(answers[qkey] ?? [])];
    if (!multi) {
        answers[qkey] = [label];
    }
    else if (current.includes(label)) {
        answers[qkey] = current.filter(x => x !== label);
    }
    else {
        answers[qkey] = [...current, label];
    }
    return draft;
}
/** Resolve a `q<idx>` + option index to its label from the record's question spec. */
function questionOptionLabel(record, qkey, optidx) {
    if (!/^q\d+$/.test(qkey) || !/^\d+$/.test(optidx)) {
        return null;
    }
    const spec = record.question_spec ?? {};
    const questions = Array.isArray(spec.questions) ? spec.questions : [];
    const qi = Number(qkey.slice(1));
    const oi = Number(optidx);
    if (qi >= questions.length) {
        return null;
    }
    const q = questions[qi];
    const options = Array.isArray(q?.options) ? q.options : [];
    if (oi >= options.length) {
        return null;
    }
    const opt = options[oi];
    if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
        return String(opt.label ?? '');
    }
    return String(opt);
}
/**
 * Render a (possibly multi-question / multi-select) question as toggle buttons plus a Submit
 * button. callback_data: `<rid>|q<idx>|<optidx>` per option, `<rid>|__submit` to commit. A ✓
 * marks a currently-chosen option (read from the answer draft).
 */
function buildQuestionCard(record) {
    const spec = record.question_spec ?? {};
    const draftAnswers = ((record.question_answer ?? {}).answers ?? {});
    const rid = record.request_id;
    const lines = [
        `❓ QUESTION — ${String(spec.prompt ?? '').slice(0, 80)}`.replace(/[\s—]+$/, ''),
        '',
        (0, sessionIdentity_1.sessionRefLine)(record),
    ];
    const keyboard = [];
    const questions = Array.isArray(spec.questions) ? spec.questions : [];
    questions.forEach((qRaw, qi) => {
        const q = (qRaw ?? {});
        const qkey = `q${qi}`;
        const tag = q.multi_select ? ' [multi]' : '';
        lines.push(`\n${String(q.header || `Q${qi + 1}`)}: ${String(q.question ?? '')}${tag}`);
        const chosen = new Set(draftAnswers[qkey] ?? []);
        const options = Array.isArray(q.options) ? q.options : [];
        options.forEach((optRaw, oi) => {
            const label = (optRaw && typeof optRaw === 'object' && !Array.isArray(optRaw))
                ? String(optRaw.label ?? '')
                : String(optRaw);
            const mark = chosen.has(label) ? '✓ ' : '';
            keyboard.push([{ text: `${mark}${label}`, callback_data: `${rid}|${qkey}|${oi}` }]);
        });
    });
    keyboard.push([{ text: '✅ Submit answers', callback_data: `${rid}|__submit` }]);
    return [lines.join('\n'), { inline_keyboard: keyboard }];
}
/**
 * The real Bot API transport. Exported so the remote-control feature drives the same HTTP path —
 * including the timeout that must outlast a long poll — instead of growing a second one that
 * would drift from it.
 */
function defaultApi(token) {
    const base = `https://api.telegram.org/bot${token}`;
    return async (method, payload) => {
        // Must exceed the getUpdates long-poll timeout so the socket doesn't close mid-wait.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40000);
        try {
            const resp = await fetch(`${base}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            return await resp.json();
        }
        catch (err) {
            throw new messaging_1.DeliveryError(`telegram ${method} failed: ${String(err)}`);
        }
        finally {
            clearTimeout(timer);
        }
    };
}
class TelegramChannel {
    constructor(opts) {
        this.updateSource = opts.updateSource;
        this.chatId = opts.chatId;
        this.offsetPath = opts.offsetPath;
        this.timeoutMinutes = opts.timeoutMinutes ?? 30;
        this.api = opts.api ?? defaultApi(opts.token);
        this.clock = opts.clock ?? timeutil_1.nowUtc;
        this.longPoll = opts.longPollSeconds ?? 0;
        this.log = opts.log ?? (() => { });
    }
    /** Clear any stale webhook so getUpdates works (a webhook makes it 409). Best-effort. */
    async ensurePollingReady() {
        try {
            await this.api('deleteWebhook', { drop_pending_updates: false });
        }
        catch { /* best-effort */ }
    }
    // ------------------------------------------------------------------ outbound
    async send(record, notification, interactive = true) {
        // A multi-question / multi-select question renders as a toggle + Submit card.
        let text;
        let replyMarkup;
        if (interactive && record.state === models_1.SupervisionState.ORANGE_AWAITING_QUESTION && record.question_spec) {
            [text, replyMarkup] = buildQuestionCard(record);
        }
        else {
            [text, replyMarkup] = buildCard(record, notification, {
                interactive,
                minutesLeft: interactive ? this.timeoutMinutes : null,
                deadlineIso: null,
            });
        }
        const payload = { chat_id: this.chatId, text };
        if (replyMarkup !== null) {
            payload.reply_markup = replyMarkup;
        }
        const resp = await this.api('sendMessage', payload);
        if (resp.ok !== true) {
            throw new messaging_1.DeliveryError(`telegram sendMessage not ok: ${JSON.stringify(resp)}`);
        }
        const result = (resp.result ?? {});
        return { messageId: String(result.message_id ?? ''), sentAt: (0, timeutil_1.toIso)(this.clock()) };
    }
    // ------------------------------------------------------------------ inbound
    async pollResponses(pending) {
        const byId = new Map(pending.map(r => [r.request_id, r]));
        const byMessage = new Map(pending.filter(r => r.notification_id).map(r => [String(r.notification_id), r]));
        // Fallback target for a plain text reply with no reply-to: the most recently notified
        // awaiting card (there is normally exactly one live decision at a time).
        const latest = pending.length
            ? pending.reduce((best, r) => ((r.notified_at ?? r.created_at) > (best.notified_at ?? best.created_at) ? r : best))
            : null;
        const out = [];
        // Handed our updates by the remote control, which owns the single read on this token. It also
        // owns the offset, so nothing here touches it.
        if (this.updateSource !== undefined) {
            for (const u of this.updateSource()) {
                const update = (u ?? {});
                const uid = typeof update.update_id === 'number' ? update.update_id : 0;
                const resolved = await this.resolveUpdate(update, uid, byId, byMessage, latest);
                if (resolved !== null) {
                    out.push(resolved);
                }
            }
            return out;
        }
        const offset = await this.readOffset();
        let resp;
        try {
            resp = await this.api('getUpdates', { offset: offset + 1, timeout: this.longPoll });
        }
        catch (err) {
            // Surface it — a silent getUpdates failure looks identical to "no replies" and makes
            // every decision time out. (Most common cause: another consumer/webhook on this bot.)
            this.log(`telegram getUpdates failed: ${String(err)}`);
            return out;
        }
        const updates = Array.isArray(resp.result) ? resp.result : [];
        let maxSeen = offset;
        for (const u of updates) {
            const update = (u ?? {});
            const uid = typeof update.update_id === 'number' ? update.update_id : offset;
            maxSeen = Math.max(maxSeen, uid);
            const resolved = await this.resolveUpdate(update, uid, byId, byMessage, latest);
            if (resolved !== null) {
                out.push(resolved);
            }
        }
        if (maxSeen > offset) {
            await this.writeOffset(maxSeen);
        }
        return out;
    }
    async resolveUpdate(u, uid, byId, byMessage, latest) {
        const cq = u.callback_query;
        if (cq && typeof cq === 'object' && !Array.isArray(cq)) {
            const q = cq;
            const data = String(q.data ?? '');
            const sep = data.indexOf('|');
            const rid = sep >= 0 ? data.slice(0, sep) : data;
            const rest = sep >= 0 ? data.slice(sep + 1) : '';
            const rec = byId.get(rid) ?? latest;
            try { // acknowledge the tap immediately so the button's spinner clears
                await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Recorded ✓' });
            }
            catch { /* best-effort */ }
            if (rec === null || rec === undefined) {
                return null;
            } // stale tap on an already-resolved card
            // Question card taps: "__submit" commits; "q<idx>|<optidx>" toggles an option. The
            // orchestrator owns the answer draft, so we emit toggle/submit sentinels.
            if (rec.question_spec !== null) {
                if (rest === '__submit') {
                    return {
                        updateId: String(uid), correlationId: rec.request_id,
                        text: '__submit', receivedAt: (0, timeutil_1.toIso)(this.clock()),
                    };
                }
                const sep2 = rest.indexOf('|');
                const qkey = sep2 >= 0 ? rest.slice(0, sep2) : rest;
                const optidx = sep2 >= 0 ? rest.slice(sep2 + 1) : '';
                const label = questionOptionLabel(rec, qkey, optidx);
                if (label === null) {
                    return null;
                }
                return {
                    updateId: String(uid), correlationId: rec.request_id,
                    text: `__toggle|${qkey}|${label}`, receivedAt: (0, timeutil_1.toIso)(this.clock()),
                };
            }
            const opts = optionsFor(rec);
            const label = /^\d+$/.test(rest) && Number(rest) < opts.length ? opts[Number(rest)] : data;
            return {
                updateId: String(uid), correlationId: rec.request_id, text: label,
                receivedAt: (0, timeutil_1.toIso)(this.clock()),
            };
        }
        const msg = u.message;
        if (msg && typeof msg === 'object' && !Array.isArray(msg)
            && typeof msg.text === 'string') {
            const m = msg;
            const text = m.text.trim();
            // Reply to a live card → decision; otherwise a general instruction for the agent.
            const replyTo = (m.reply_to_message ?? {});
            const rec = (replyTo.message_id !== undefined
                ? byMessage.get(String(replyTo.message_id))
                : undefined) ?? latest;
            const correlation = rec ? rec.request_id : exports.ACTIVE_SESSION;
            return {
                updateId: String(uid), correlationId: correlation, text,
                receivedAt: (0, timeutil_1.toIso)(this.clock()),
            };
        }
        return null;
    }
    // ------------------------------------------------------------------ timers
    /** Best-effort countdown tick via editMessageText. Failures are ignored. */
    async refreshTimers(pending) {
        const now = this.clock();
        for (const rec of pending) {
            if (!rec.notification_id || !rec.timeout_deadline) {
                continue;
            }
            const minutesLeft = (0, timeutil_1.minutesUntil)(rec.timeout_deadline, now);
            const source = rec.original_orange_assessment ?? rec.assessment ?? {};
            const notification = String(source.human_notification ?? '');
            const [text, replyMarkup] = buildCard(rec, notification, {
                interactive: true, minutesLeft, deadlineIso: rec.timeout_deadline,
            });
            const messageId = Number(rec.notification_id);
            if (!Number.isFinite(messageId)) {
                continue;
            }
            const payload = {
                chat_id: this.chatId, message_id: messageId, text,
            };
            if (replyMarkup !== null) {
                payload.reply_markup = replyMarkup;
            }
            try {
                await this.api('editMessageText', payload);
            }
            catch { /* best-effort; the deadline text still stands and the timeout still fires */ }
        }
    }
    // ------------------------------------------------------------------ offset
    async readOffset() {
        try {
            const raw = (await fs.promises.readFile(this.offsetPath, 'utf8')).trim();
            const n = Number.parseInt(raw, 10);
            return Number.isFinite(n) ? n : 0;
        }
        catch {
            return 0;
        }
    }
    async writeOffset(value) {
        try {
            await fs.promises.mkdir(path.dirname(this.offsetPath), { recursive: true });
            await fs.promises.writeFile(this.offsetPath, String(value), 'utf8');
        }
        catch { /* best-effort */ }
    }
}
exports.TelegramChannel = TelegramChannel;
