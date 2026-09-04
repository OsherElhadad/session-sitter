// GENERATED FILE — DO NOT EDIT.
// Compiled from src/SupervisionActivity.ts by scripts/build-plugin-lib.js (`make plugin`).
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
exports.SupervisionActivity = void 0;
exports.ruleLabelFor = ruleLabelFor;
exports.recordToItem = recordToItem;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const sessionIdentity_1 = require("./supervisor/sessionIdentity");
/**
 * A one-line description of the deterministic rule that produced a decision: the pattern that
 * matched and what it did. Empty when the record was not decided by a rule.
 */
function ruleLabelFor(rule) {
    if (!rule || typeof rule !== 'object') {
        return '';
    }
    const str = (v) => (typeof v === 'string' ? v : '');
    const pattern = str(rule.pattern);
    if (!pattern) {
        return '';
    }
    const kind = str(rule.kind);
    const args = str(rule.argument_pattern);
    const scope = kind === 'text' ? `/${pattern}/` : `'${pattern}'`;
    const narrowed = args ? ` + args /${args}/` : '';
    const did = kind === 'text' ? 'auto-reply' : (str(rule.decision) || 'auto-approve');
    return `${scope}${narrowed} → ${did}`;
}
/** Map a supervision record JSON (STATE_DIR/records/<id>.json) to a compact feed item. */
function recordToItem(raw, mtimeMs) {
    let r;
    try {
        r = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof r.request_id !== 'string') {
        return null;
    }
    const a = r.assessment ?? {};
    const events = Array.isArray(r.events) ? r.events : [];
    const lastAt = events.length ? events[events.length - 1].at : undefined;
    const str = (v) => (typeof v === 'string' ? v : '');
    const opts = Array.isArray(a.human_options) ? a.human_options.filter(o => typeof o === 'string') : [];
    // Failure reason: prefer the record's top-level `error`, fall back to the last `failed` event.
    const failedEvent = [...events].reverse().find(e => e.type === 'failed' && typeof e.error === 'string');
    const error = str(r.error) || (failedEvent?.error ?? '') || null;
    return {
        requestId: r.request_id,
        sessionId: str(r.session_id),
        // A card without these is unattributable: every session id looks the same, and one panel now
        // shows decisions taken on several machines. Falls back to the id, never to an empty label.
        sessionName: (0, sessionIdentity_1.sessionDisplayName)(str(r.session_name), str(r.session_id)),
        host: (0, sessionIdentity_1.shortHost)(str(r.host)),
        light: str(a.traffic_light),
        summary: str(a.summary),
        userIntent: str(a.user_intent),
        agentIntent: str(a.agent_intent),
        humanNotification: str(a.human_notification),
        options: opts,
        state: str(r.state),
        awaitLight: typeof r.await_light === 'string' ? r.await_light : null,
        userResponse: typeof r.user_response === 'string' ? r.user_response : null,
        error,
        at: lastAt || new Date(mtimeMs).toISOString(),
        decidedBy: str(r.decided_by) || 'supervisor',
        ruleLabel: ruleLabelFor(r.rule),
    };
}
/**
 * Watches the supervisor's `records/` dir and pushes a newest-first feed of decisions to the
 * webview. Polls (fs.watch is unreliable across platforms/WSL2); fires the callback only when
 * the set of records changes so the UI isn't spammed.
 */
class SupervisionActivity {
    constructor(stateDir, _onChange, _limit = 40) {
        this._onChange = _onChange;
        this._limit = _limit;
        this._fingerprint = '';
        this._recordsDir = path.join(stateDir, 'records');
    }
    start(intervalMs = 2000) {
        void this._scan();
        this._timer = setInterval(() => { void this._scan(); }, intervalMs);
    }
    /** Read + push the current feed immediately (used on webview 'ready'/toggle). */
    pushNow() { void this._scan(true); }
    dispose() {
        if (this._timer !== undefined) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }
    async _scan(force = false) {
        let files;
        try {
            files = (await fs.promises.readdir(this._recordsDir)).filter(f => f.endsWith('.json'));
        }
        catch {
            if (force) {
                this._onChange([]);
            }
            return; // dir not created yet
        }
        // Records accumulate for the life of the state dir, and every applied auto-respond rule adds
        // one — so this directory gets large. Stat everything (cheap), then parse only the newest
        // `_limit` files: the feed shows that many anyway, and the parse is what costs.
        const stats = [];
        for (const file of files) {
            try {
                const stat = await fs.promises.stat(path.join(this._recordsDir, file));
                stats.push({ file, mtimeMs: stat.mtimeMs });
            }
            catch { /* vanished between readdir and stat */ }
        }
        stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const items = [];
        for (const { file, mtimeMs } of stats.slice(0, this._limit)) {
            try {
                const raw = await fs.promises.readFile(path.join(this._recordsDir, file), 'utf8');
                const item = recordToItem(raw, mtimeMs);
                if (item) {
                    items.push(item);
                }
            }
            catch { /* skip unreadable/half-written */ }
        }
        // A record's own last-event timestamp is the display order; mtime only chose the candidates.
        items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        const trimmed = items.slice(0, this._limit);
        const fp = trimmed.map(i => `${i.requestId}:${i.state}:${i.at}`).join('|');
        if (force || fp !== this._fingerprint) {
            this._fingerprint = fp;
            this._onChange(trimmed);
        }
    }
}
exports.SupervisionActivity = SupervisionActivity;
