// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/audit.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Reading the evidence: what was decided, by whom, under which clause.
 *
 * Three writers feed this reader, and it has to be useful with any one of them alone:
 *
 *  1. **The hook trail** — `<dataDir>/decisions.jsonl`, one `DecisionRecord` per decision, written
 *     by the plugin's hooks. This is the one that exists on a terminal-only machine, because the
 *     hooks are the only front end running there. It lives under the plugin's data directory
 *     (`$CLAUDE_PLUGIN_DATA`, else `~/.claude/session-sitter`) rather than under a state dir,
 *     because Claude Code owns that path and hands it to the hook in the environment.
 *  2. **The audit trail** — `<stateDir>/audit.jsonl`, one `AuditRecord` per decision. Nothing in
 *     this repository writes it yet; it is the shape a future exporter is held to, and it is read
 *     because a trail shipped from elsewhere arrives in it.
 *  3. **The supervision records** — `<stateDir>/records/req-*.json`, which the extension and
 *     `supervise` CLI have written since long before the audit trail existed. They carry a traffic
 *     light, a state and a rule trace but no clause citation, so they map into a decision with the
 *     clause field genuinely empty.
 *
 * The hook trail is read *in addition to* the state dir rather than as another candidate for it: the
 * two are different kinds of store in different places, and a machine that has both — an IDE window
 * and a terminal session governed by the same practices — must show the decisions from both. Picking
 * one and hiding the other is how `log` came to report "no supervision state found" on a machine
 * that had been recording decisions all along.
 *
 * Where a field is absent it stays absent. `log` and `digest` print "not recorded" for those, and
 * nothing in here fills a gap with a plausible-looking value.
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
exports.DECISIONS_FILE = exports.AUDIT_FILE = void 0;
exports.auditToDecision = auditToDecision;
exports.readAuditTrail = readAuditTrail;
exports.hookToDecision = hookToDecision;
exports.readHookTrail = readHookTrail;
exports.readSupervisionRecords = readSupervisionRecords;
exports.readDecisions = readDecisions;
exports.stateDirCandidates = stateDirCandidates;
exports.resolveState = resolveState;
exports.readFrom = readFrom;
exports.isDenial = isDenial;
exports.isCorrection = isCorrection;
exports.filterDecisions = filterDecisions;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const SupervisionActivity_1 = require("../SupervisionActivity");
const paths_1 = require("../hooks/paths");
const config_1 = require("../supervisor/config");
const sessionScan_1 = require("../sessionScan");
/** The file the audit trail is written to, under the state dir. */
exports.AUDIT_FILE = 'audit.jsonl';
/**
 * The file the plugin's hooks append to, under the plugin data dir — not under a state dir.
 *
 * Named here rather than imported from `src/hooks/paths.ts` because that module exports the whole
 * path and this reader needs the basename for a decision's id, so a record traces back to the line
 * it came from the same way an `audit.jsonl` one does.
 */
exports.DECISIONS_FILE = 'decisions.jsonl';
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const OUTCOMES = new Set([
    'allow', 'deny', 'correct', 'escalate', 'timeout', 'resolved', 'failed', 'pending', 'unknown',
]);
function toOutcome(value) {
    return OUTCOMES.has(value) ? value : 'unknown';
}
/** Map one audit line into a decision. */
function auditToDecision(record, id) {
    const light = str(record.light);
    const outcome = toOutcome(str(record.outcome));
    return {
        from: 'audit',
        id,
        at: new Date(record.at),
        sessionId: str(record.session_id),
        sessionName: str(record.session_name) || str(record.session_id),
        host: str(record.host),
        agent: str(record.agent),
        tool: str(record.tool),
        light,
        // A record that names no outcome but does name a light is still readable: red blocks, green
        // allows. Guessing beyond that pair would be inventing the decision.
        outcome: outcome !== 'unknown' ? outcome
            : light === 'red' ? 'deny' : light === 'green' ? 'allow' : 'unknown',
        actor: str(record.actor),
        clauseId: str(record.clause?.id),
        clauseText: str(record.clause?.text),
        rewritten: record.updated_input !== undefined && record.updated_input !== null,
        reason: str(record.reason),
        ask: str(record.ask),
        input: record.original_input ?? record.updated_input,
        latencyMs: num(record.latency_ms),
        costUsd: num(record.cost_usd),
    };
}
/**
 * Read `<stateDir>/audit.jsonl`.
 *
 * A missing file is not an error: the audit trail only exists once something has been decided, and
 * "nothing yet" is a legitimate answer to a query.
 */
async function readAuditTrail(stateDir) {
    let raw;
    try {
        raw = await fs.promises.readFile(path.join(stateDir, exports.AUDIT_FILE), 'utf8');
    }
    catch {
        return [];
    }
    const decisions = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) {
            continue;
        }
        try {
            const record = JSON.parse(trimmed);
            if (typeof record.at !== 'string') {
                continue;
            }
            const decision = auditToDecision(record, `${exports.AUDIT_FILE}:${i + 1}`);
            if (Number.isNaN(decision.at.getTime())) {
                continue;
            }
            decisions.push(decision);
        }
        catch { /* half-written or corrupt line — skip it, keep the rest of the trail */ }
    }
    return decisions;
}
// ── The hook trail, as decisions ───────────────────────────────────────────
/**
 * How a hook record's `actor` reads in this reader's vocabulary.
 *
 * Only `model` is translated. The supervision reader already turns its `supervisor` into
 * `classifier`, and one word for "a model decided this" across all three writers is worth the
 * translation. The rest pass through verbatim: `deterministic`, `policy` and `correction` say
 * *which* deterministic rung answered, and collapsing them into `rule` would throw away the only
 * record of that — the trail's own precision is not this reader's to spend.
 */
function hookActor(actor) {
    return actor === 'model' ? 'classifier' : actor;
}
/**
 * Map one hook record into a decision.
 *
 * The two shapes disagree about more than spelling, and each difference is resolved by recording
 * what the writer knew rather than by filling the gap:
 *
 *  - **`decision` is not an outcome.** `allow`/`deny` map straight across, but a rewrite is recorded
 *    as `decision: 'allow'` plus `rewritten: true`, and the correction lane is the distinction this
 *    whole trail exists to make — so a rewrite reads as `correct`. `none` means the hook reached no
 *    verdict (an exempt tool, or observe mode) and reads as `unknown`, never as `allow`: a layer
 *    that records a decision it did not take is a layer whose trail cannot be used as evidence.
 *  - **`clause` is a citation string, not a pair.** It becomes `clauseId`; `clauseText` stays empty,
 *    because the hook does not store the clause body and the renderers say "not recorded" for it.
 *  - **No host, and no session name.** Neither is in `DecisionRecord`. `sessionName` falls back to
 *    the session id, exactly as `auditToDecision` does for the same gap.
 *  - **The agent is `claude`.** Not inferred — `decisions.jsonl` is written only by the hooks of a
 *    Claude Code plugin, so there is no other agent it could have been.
 */
function hookToDecision(record, id) {
    const rewritten = record.rewritten === true;
    return {
        from: 'audit',
        id,
        at: new Date(record.ts),
        sessionId: str(record.sessionId),
        sessionName: str(record.sessionId),
        host: '',
        agent: 'claude',
        tool: str(record.tool),
        light: str(record.light),
        outcome: rewritten ? 'correct'
            : record.decision === 'allow' ? 'allow'
                : record.decision === 'deny' ? 'deny'
                    : 'unknown',
        actor: hookActor(str(record.actor)),
        clauseId: str(record.clause),
        clauseText: '',
        rewritten,
        reason: str(record.note),
        ask: '',
        // `call.input` is the whole redacted input, which is what a replay has to re-decide.
        // `inputSummary` cannot serve — it keeps one field and truncates at 300 characters.
        input: record.call?.input ?? undefined,
        latencyMs: num(record.latencyMs),
        // The hook records token counts, not money. Deriving a cost from them here would mean pinning
        // prices in a reader, and a figure nobody can trace is worse than an empty column.
        costUsd: null,
    };
}
/**
 * Read `<dataDir>/decisions.jsonl`.
 *
 * Tolerant in exactly the way {@link readAuditTrail} is, and for the same reason: a half-written
 * final line is the normal state of a JSONL file whose writer was killed, and it must not cost the
 * reader the rest of the trail.
 */
async function readHookTrail(trailPath) {
    let raw;
    try {
        raw = await fs.promises.readFile(trailPath, 'utf8');
    }
    catch {
        return [];
    }
    const decisions = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) {
            continue;
        }
        try {
            const record = JSON.parse(trimmed);
            if (typeof record.ts !== 'string') {
                continue;
            }
            const decision = hookToDecision(record, `${exports.DECISIONS_FILE}:${i + 1}`);
            if (Number.isNaN(decision.at.getTime())) {
                continue;
            }
            decisions.push(decision);
        }
        catch { /* half-written or corrupt line — skip it, keep the rest of the trail */ }
    }
    return decisions;
}
// ── The supervision records, as decisions ──────────────────────────────────
/**
 * A supervision record's lifecycle state, read as an outcome.
 *
 * Two of these are worth stating out loud. `orange_timed_out` is a **deny**, because the project's
 * founding rule is that silence is never approval. And a rule decision is only an allow when the
 * rule was not a rejection — the record's `state` alone cannot tell those apart.
 */
const STATE_OUTCOME = {
    green_completed: 'allow',
    yellow_ready: 'correct',
    yellow_delivered: 'correct',
    orange_awaiting_user: 'escalate',
    orange_awaiting_question: 'escalate',
    orange_resolved_by_user: 'resolved',
    orange_timed_out: 'timeout',
    orange_transitioned_to_yellow: 'correct',
    red_blocked: 'deny',
    analysis_pending: 'pending',
    failed: 'failed',
};
function supervisionOutcome(state, ruleDecision) {
    if (state === 'rule_applied') {
        return ruleDecision === 'reject' ? 'deny' : 'allow';
    }
    return STATE_OUTCOME[state] ?? 'unknown';
}
/**
 * Read `<stateDir>/records/req-*.json` as decisions.
 *
 * Goes through `recordToItem` — the mapper the panel's activity feed already uses — so a decision
 * reads the same in the terminal as it does in the IDE. The raw JSON is parsed a second time only
 * for the two fields an `ActivityItem` does not carry: the tool the rule matched, and the rule's
 * own verdict.
 */
async function readSupervisionRecords(stateDir) {
    const recordsDir = path.join(stateDir, 'records');
    let files;
    try {
        files = (await fs.promises.readdir(recordsDir))
            .filter(f => f.startsWith('req-') && f.endsWith('.json'));
    }
    catch {
        return [];
    }
    const decisions = [];
    for (const file of files) {
        const full = path.join(recordsDir, file);
        try {
            const raw = await fs.promises.readFile(full, 'utf8');
            const stat = await fs.promises.stat(full);
            const item = (0, SupervisionActivity_1.recordToItem)(raw, stat.mtimeMs);
            if (!item) {
                continue;
            }
            const parsed = JSON.parse(raw);
            const at = new Date(item.at);
            if (Number.isNaN(at.getTime())) {
                continue;
            }
            decisions.push({
                from: 'supervision',
                id: item.requestId,
                at,
                sessionId: item.sessionId,
                sessionName: item.sessionName,
                host: item.host,
                agent: str(parsed.source),
                tool: str(parsed.rule?.tool_name),
                light: item.light,
                outcome: supervisionOutcome(item.state, str(parsed.rule?.decision)),
                // `decided_by` is 'rule' or 'supervisor'; the audit trail's word for the latter is
                // 'classifier', and one vocabulary across both readers is worth the translation.
                actor: item.decidedBy === 'supervisor' ? 'classifier' : item.decidedBy,
                // Supervision records predate clause citation. This gap is the reason the audit trail
                // exists, and printing it as empty is how the gap stays visible.
                clauseId: '',
                clauseText: item.ruleLabel,
                rewritten: false,
                reason: item.humanNotification || item.summary || item.error || '',
                ask: str(parsed.assessment?.user_intent),
                latencyMs: null,
                costUsd: null,
            });
        }
        catch { /* unreadable or half-written record — skip */ }
    }
    return decisions;
}
/**
 * Every decision from every writer that is in play, oldest first.
 *
 * `hookTrail` is separate from `stateDir` because the hook writes outside any state dir, and it is a
 * parameter rather than a lookup so that a caller which was told exactly where to read — an explicit
 * `--state-dir` — can pass `null` and get only what it asked for. {@link resolveState} decides which
 * of those two situations holds; this function does not guess.
 */
async function readDecisions(stateDir, hookTrail) {
    const decisions = [
        ...(hookTrail ? await readHookTrail(hookTrail) : []),
        ...(await readAuditTrail(stateDir)),
        ...(await readSupervisionRecords(stateDir)),
    ];
    decisions.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
    return decisions;
}
// ── Finding the state dir ──────────────────────────────────────────────────
/**
 * Where supervision state might live, most specific first.
 *
 * The awkwardness here is real and not ours to fix: the extension defaults its state dir to its own
 * VS Code global storage, while `supervise` defaults to `<cwd>/.supervisor-state`. A terminal
 * command that only knew one of them would report an empty audit trail on a machine that has one,
 * which is the worst possible failure for an evidence tool — so it looks in both and says which it
 * used.
 */
function stateDirCandidates(cwd = process.cwd()) {
    const fromConfig = (0, config_1.loadConfig)({ workspaceRoot: cwd }).stateDir;
    const globalStorage = path.join((0, sessionScan_1.vscodeUserDir)(), 'globalStorage', 'eranra.session-sitter', 'state');
    return [...new Set([fromConfig, globalStorage])];
}
/** Does this directory hold either state-dir writer's output? */
function hasState(dir) {
    return fs.existsSync(path.join(dir, exports.AUDIT_FILE)) || fs.existsSync(path.join(dir, 'records'));
}
/**
 * Resolve what to read: an explicit `--state-dir` wins outright, otherwise the first candidate that
 * actually holds records, plus the plugin's hook trail whenever that exists.
 *
 * An explicit path is honoured even when empty, and to the exclusion of the hook trail — being told
 * where to look and reading somewhere else as well is not a favour either. Without one, the hook
 * trail is always in play: on a terminal-only machine it is the only writer there is, and a state
 * dir that happens to exist must not hide it.
 */
function resolveState(explicit, cwd = process.cwd(), env = process.env) {
    if (explicit !== undefined) {
        const dir = path.resolve(expandHome(explicit));
        return { dir, populated: hasState(dir), searched: [dir], hookTrail: null };
    }
    const trail = (0, paths_1.decisionsPath)(env);
    const hookTrail = fs.existsSync(trail) ? trail : null;
    const searched = [...stateDirCandidates(cwd), trail];
    for (const dir of stateDirCandidates(cwd)) {
        if (hasState(dir)) {
            return { dir, populated: true, searched, hookTrail };
        }
    }
    return { dir: searched[0], populated: hookTrail !== null, searched, hookTrail };
}
/**
 * What was actually read, for the line every command prints so a reader can tell an empty result
 * from a wrong path.
 *
 * Names both stores when both are in play. This is not cosmetic: once the hook trail is read
 * alongside the state dir, printing only `state.dir` tells someone their decisions came from a
 * directory that may not even exist — the precise failure this reader was changed to stop.
 */
function readFrom(state) {
    const parts = [];
    if (hasState(state.dir)) {
        parts.push(state.dir);
    }
    if (state.hookTrail !== null) {
        parts.push(state.hookTrail);
    }
    // Neither holds anything: name the directory that was chosen, so the message still points
    // somewhere rather than nowhere.
    return parts.length > 0 ? parts.join(' + ') : state.dir;
}
function expandHome(p) {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
/** A denial is any outcome that stopped the call, which includes a countdown running out. */
function isDenial(decision) {
    return decision.outcome === 'deny' || decision.outcome === 'timeout';
}
/** A correction is a rewrite: the outcome says so, or the record carries the rewritten input. */
function isCorrection(decision) {
    return decision.outcome === 'correct' || decision.rewritten;
}
function filterDecisions(decisions, filter) {
    const tool = filter.tool?.toLowerCase();
    return decisions.filter(d => {
        if (filter.since && d.at.getTime() < filter.since.getTime()) {
            return false;
        }
        if (filter.until && d.at.getTime() > filter.until.getTime()) {
            return false;
        }
        if (filter.denied && !isDenial(d)) {
            return false;
        }
        if (filter.corrected && !isCorrection(d)) {
            return false;
        }
        if (filter.sessionId && d.sessionId !== filter.sessionId) {
            return false;
        }
        if (tool && d.tool.toLowerCase() !== tool) {
            return false;
        }
        return true;
    });
}
