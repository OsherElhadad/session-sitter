#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/permissionRequest.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The `PermissionRequest` hook — the governance decision.
 *
 * This event fires only when Claude Code is about to prompt a human, or when it would auto-deny in
 * a session that cannot prompt. Which makes it the one place a policy layer can stand: it answers
 * the prompt, it can *rewrite* the call, and in an unattended session it is the difference between
 * a standing written policy and everything being silently denied.
 *
 * ## The ladder
 *
 * Cheapest and most certain first. The first rung that holds returns.
 *
 *  1. **Deterministic green** — a read-only tool or a safe shell command, via the engine's
 *     `preClassify`. Allow, no I/O beyond the audit append, no model call.
 *  2. **The correction lane** — a correction rule rewrites the call into its safer form. Allow with
 *     `updatedInput`, citing the clause. The rewritten input is re-checked against the written red
 *     clauses before it is returned, so a rewrite can never smuggle a denied call through.
 *  3. **A written red clause** matches. Deny, citing the clause.
 *  4. **A written green clause** matches. Allow, citing the clause. This is what makes an overnight
 *     run survivable: the standing policy that says what the agent may do without asking.
 *  5. **The engine's deterministic red table** (`preClassify` RED). Deny.
 *  6. **The classifier**, with the practices as context — only when explicitly enabled.
 *  7. **Fail closed.** Deny, saying plainly that the supervisor was unreachable.
 *
 * Written clauses are evaluated *before* the engine's built-in red table (rung 5), because the
 * built-in table is the fallback for a team that has written nothing, and a written rule that
 * cannot override a built-in default is not a policy layer. Red clauses are evaluated before green
 * ones regardless of tier: `knowledge.ts` leaves conflict *resolution* to the classifier, but a
 * deterministic matcher has to break the tie somehow, and safety is the only defensible way.
 *
 * ## Contract facts this hook obeys
 *
 *  - **Exit 2 is not honoured for this event.** Only `hookSpecificOutput.decision` decides, so the
 *    hook always prints valid JSON, including when it throws (see `FAIL_CLOSED_*` below).
 *  - `updatedInput` and `updatedPermissions` are **allow-only**; `message` is **deny-only**.
 *  - `permission_suggestions` is echoed back as `updatedPermissions` only for a settled allow, and
 *    only when the operator opted in. Writing permission rules behind someone's back is not ours
 *    to do by default.
 *
 * ## Latency
 *
 * Rungs 1–5 spawn nothing, read no transcript, and touch the filesystem only to read the practices
 * file and append one audit line. Rung 6 is the only rung that can pay for a model, and it is off
 * unless asked for.
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
exports.EXEMPT_TOOLS = void 0;
exports.failClosedOutput = failClosedOutput;
exports.loadClauses = loadClauses;
exports.decideDeterministically = decideDeterministically;
exports.handle = handle;
const fs = __importStar(require("fs"));
const tiers_1 = require("../supervisor/tiers");
const models_1 = require("../supervisor/models");
const prompt_1 = require("../supervisor/prompt");
const schema_1 = require("../supervisor/schema");
const factory_1 = require("../supervisor/factory");
const practices_1 = require("../policy/practices");
const corrections_1 = require("../policy/corrections");
const trail_1 = require("../audit/trail");
const paths_1 = require("./paths");
const io_1 = require("./io");
const settings_1 = require("./settings");
const session_1 = require("./session");
const UNREACHABLE_MESSAGE = 'Session Sitter denied this call because the supervisor could not reach a verdict, and silence '
    + 'is not approval. Nothing here says the call is unsafe — only that nothing said it was safe. '
    + 'To resolve it: write a practices clause covering this call, enable the classifier '
    + '(SESSION_SITTER_CLASSIFIER=on), or run in observe mode (SESSION_SITTER_MODE=observe) to hand '
    + 'the decision back to Claude Code.';
function out(decision) {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}
/**
 * The output printed when this hook throws. A thrown hook exits non-zero, and a non-zero exit on
 * this event is a *non-blocking error* — the prompt just appears as if no hook ran. That is the
 * fail-open case this product exists to prevent, so the wrapper prints a deny instead.
 */
function failClosedOutput(reason) {
    return out({ behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(supervisor error: ${reason})` });
}
/**
 * Load the practices. A single file when one is configured, otherwise the three knowledge tiers.
 * A configured-but-unreadable practices file is an error, not an empty policy: silently loading no
 * rules would turn a typo into "everything is ambiguous", and in enforce mode that denies the world
 * for a reason nobody can see.
 */
async function loadClauses(settings) {
    if (settings.practicesFile) {
        const text = await fs.promises.readFile(settings.practicesFile, 'utf8');
        return (0, practices_1.parsePractices)(text, 'project', settings.practicesFile);
    }
    if (!settings.user) {
        return [];
    }
    return (0, practices_1.loadPractices)({
        user: settings.user,
        project: settings.project,
        team: settings.team,
        registryPath: settings.supervisor.knowledgeRegistryPath || undefined,
        localRepo: settings.supervisor.knowledgeLocalRepo || undefined,
        knowledgeRepo: settings.supervisor.knowledgeRepo || undefined,
        knowledgeRef: settings.supervisor.knowledgeRef,
    });
}
/** The clauses, shaped as the bundle the existing prompt builder consumes. */
function bundleFor(clauses, settings) {
    return {
        user: settings.user ?? '',
        project: settings.project ?? '',
        team: settings.team ?? '',
        entries: clauses.map(c => ({
            kind: c.kind,
            title: `${c.title} [${c.citation}]`,
            tier: c.tier,
            text: c.text,
            id: c.clauseId,
            source: null,
            confidence: null,
            scope: c.tier,
            added: null,
            updated: null,
            tags: c.tags,
            level: c.level,
            supersedes: null,
            expires: null,
            sourceFile: c.sourceFile,
        })),
        loadedFiles: [],
        missingFiles: [],
    };
}
/**
 * Tools this layer must never decide for. Both are questions *to the human*, and answering one
 * programmatically is the thing this project has always refused to do (see the design record's
 * out-of-scope section). They are exempted rather than allowed: returning no verdict leaves the
 * question in front of the person it was addressed to.
 *
 * Exempting them is not cosmetic. An `AskUserQuestion` asking "should I force-push?" carries the
 * words `--force` in its own input, so without this the destructive-action matchers deny the
 * *question* as though it were the act — which is how this exemption was found, in a real session.
 */
exports.EXEMPT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** Rungs 1–5: everything decidable without a model. Returns null when the call is ambiguous. */
function decideDeterministically(input, clauses) {
    const toolName = input.tool_name ?? '';
    const toolInput = input.tool_input ?? null;
    const session = (0, session_1.sessionFromPermissionRequest)(input);
    const hay = (0, session_1.haystackFor)(toolName, toolInput);
    // 1. Deterministic green — a read or a safe command.
    if ((0, tiers_1.preClassify)(session) === models_1.TrafficLight.GREEN) {
        return {
            decision: { behavior: 'allow' },
            light: models_1.TrafficLight.GREEN,
            clause: null,
            actor: 'deterministic',
            note: `allowed — read-only or non-mutating (${(0, tiers_1.actionLabel)(session)})`,
            settled: true,
        };
    }
    // 2. The correction lane.
    const correction = (0, corrections_1.applyCorrection)(toolName, toolInput);
    if (correction) {
        // Re-check the *rewritten* input, so a rewrite can never produce a call a written red clause
        // forbids. Only written clauses are re-checked: the engine's built-in table lists
        // `--force-with-lease` as destructive too (correct when a human is watching in the IDE), and
        // re-applying it here would deny the very form this lane exists to produce.
        const rewrittenHay = (0, session_1.haystackFor)(toolName, correction.updatedInput);
        const blocked = (0, practices_1.findMatchingClause)(clauses, rewrittenHay, 'red');
        if (blocked) {
            return {
                decision: {
                    behavior: 'deny',
                    message: `denied — ${blocked.citation}: ${blocked.title}. The safer form of this call is `
                        + 'still forbidden by that clause, so it was not rewritten.',
                },
                light: models_1.TrafficLight.RED,
                clause: blocked.citation,
                actor: 'policy',
                note: `correction ${correction.ruleId} was rejected by ${blocked.citation}`,
                settled: false,
            };
        }
        return {
            decision: { behavior: 'allow', updatedInput: correction.updatedInput },
            light: models_1.TrafficLight.YELLOW,
            clause: `practices §${correction.clauseId}`,
            actor: 'policy',
            note: `corrected — practices §${correction.clauseId}: ${correction.note}`,
            settled: false, // a rewrite is per-call; it must never become a standing rule
        };
    }
    // 3. A written red clause.
    const red = (0, practices_1.findMatchingClause)(clauses, hay, 'red');
    if (red) {
        return {
            decision: {
                behavior: 'deny',
                message: `denied — ${red.citation}: ${red.title}`
                    + (red.text ? `\n\n${red.text}` : ''),
            },
            light: models_1.TrafficLight.RED,
            clause: red.citation,
            actor: 'policy',
            note: `denied — ${red.citation}: ${red.title}`,
            settled: false, // a deny is never persisted as a permission rule
        };
    }
    // 4. A written green clause — the standing policy that makes an overnight run survivable.
    const green = (0, practices_1.findMatchingClause)(clauses, hay, 'green');
    if (green) {
        return {
            decision: { behavior: 'allow' },
            light: models_1.TrafficLight.GREEN,
            clause: green.citation,
            actor: 'policy',
            note: `allowed — ${green.citation}: ${green.title}`,
            settled: true,
        };
    }
    // 5. The engine's built-in deterministic red table.
    if ((0, tiers_1.preClassify)(session) === models_1.TrafficLight.RED) {
        return {
            decision: {
                behavior: 'deny',
                message: 'denied — this matched Session Sitter\'s built-in destructive-action rule '
                    + `(${(0, tiers_1.actionLabel)(session)}). No written clause covers it; write one to override.`,
            },
            light: models_1.TrafficLight.RED,
            clause: null,
            actor: 'deterministic',
            note: `denied — built-in destructive-action rule (${(0, tiers_1.actionLabel)(session)})`,
            settled: false,
        };
    }
    return null;
}
/** Rung 6: the classifier, with the practices as context. Throws when it cannot produce a verdict. */
async function decideWithClassifier(input, clauses, settings) {
    const session = (0, session_1.sessionFromPermissionRequest)(input);
    const prompt = (0, prompt_1.buildSupervisionPrompt)(session, bundleFor(clauses, settings));
    const result = await (0, factory_1.buildEngine)(settings.supervisor).classify(prompt);
    const assessment = (0, schema_1.parseAndValidate)(result.raw);
    const light = assessment.traffic_light;
    // Only GREEN is an approval. Yellow, orange and red all mean a human's judgment was wanted, and
    // this hook has no way to ask for it — so they deny, and say what the classifier found.
    const allowed = light === models_1.TrafficLight.GREEN;
    return {
        decision: allowed
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: `denied — classifier returned ${light}: ${assessment.summary}` },
        light,
        clause: null,
        actor: 'model',
        note: `${allowed ? 'allowed' : 'denied'} — classifier returned ${light}`,
        settled: false, // a model verdict is about this call, not a standing rule
    };
}
async function handle(rawInput) {
    const started = Date.now();
    const input = rawInput;
    const toolName = input.tool_name ?? '';
    const settings = (0, settings_1.loadSettings)(process.env, input.cwd);
    if (exports.EXEMPT_TOOLS.has(toolName)) {
        (0, trail_1.appendJsonl)((0, paths_1.decisionsPath)(), {
            ts: new Date().toISOString(),
            sessionId: input.session_id ?? 'unknown',
            cwd: input.cwd ?? '',
            tool: toolName,
            inputSummary: (0, trail_1.summarizeInput)(input.tool_input),
            light: null,
            decision: 'none',
            clause: null,
            actor: 'human',
            latencyMs: Date.now() - started,
            rewritten: false,
            note: `${toolName} is a question to a human — no verdict returned, so the human answers it`,
        });
        return {};
    }
    let clauses = [];
    let loadError = null;
    try {
        clauses = await loadClauses(settings);
    }
    catch (err) {
        loadError = String(err);
    }
    let verdict = loadError === null ? decideDeterministically(input, clauses) : null;
    if (verdict === null && loadError !== null) {
        // The practices could not be read, so rungs 2–4 never ran. Refusing to guess is the point.
        verdict = {
            decision: { behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(practices: ${loadError})` },
            light: null, clause: null, actor: 'timeout',
            note: `denied — practices unreadable: ${loadError}`, settled: false,
        };
    }
    if (verdict === null && settings.classifierEnabled) {
        try {
            verdict = await decideWithClassifier(input, clauses, settings);
        }
        catch (err) {
            verdict = {
                decision: { behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(classifier: ${String(err)})` },
                light: null, clause: null, actor: 'timeout',
                note: `denied — classifier unreachable: ${String(err)}`, settled: false,
            };
        }
    }
    if (verdict === null) {
        if (settings.mode === 'observe') {
            // Observe mode returns no decision at all, which hands the prompt back to Claude Code. It is
            // still recorded, so the trail shows what enforce mode would have denied.
            (0, trail_1.appendJsonl)((0, paths_1.decisionsPath)(), {
                ts: new Date().toISOString(),
                sessionId: input.session_id ?? 'unknown',
                cwd: input.cwd ?? '',
                tool: toolName,
                inputSummary: (0, trail_1.summarizeInput)(input.tool_input),
                light: null,
                decision: 'none',
                clause: null,
                actor: 'timeout',
                latencyMs: Date.now() - started,
                rewritten: false,
                note: 'observe mode — no verdict returned; enforce mode would have denied',
            });
            // An empty object, not a `decision`-less `hookSpecificOutput`: schema-invalid JSON is
            // reported as a hook error in the transcript, and `{}` is unambiguously "no verdict".
            return {};
        }
        verdict = {
            decision: { behavior: 'deny', message: UNREACHABLE_MESSAGE },
            light: null, clause: null, actor: 'timeout',
            note: 'denied — no classifier configured and no written clause applied', settled: false,
        };
    }
    // `updatedPermissions` is allow-only, and only for a decision that is genuinely standing.
    if (verdict.decision.behavior === 'allow' && verdict.settled && settings.persistRules
        && Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0) {
        verdict.decision.updatedPermissions = input.permission_suggestions.map(s => ({
            ...s, destination: 'localSettings',
        }));
    }
    (0, trail_1.appendJsonl)((0, paths_1.decisionsPath)(), {
        ts: new Date().toISOString(),
        sessionId: input.session_id ?? 'unknown',
        cwd: input.cwd ?? '',
        tool: toolName,
        inputSummary: (0, trail_1.summarizeInput)(input.tool_input),
        light: verdict.light,
        decision: verdict.decision.behavior,
        clause: verdict.clause,
        actor: verdict.actor,
        latencyMs: Date.now() - started,
        rewritten: verdict.decision.updatedInput !== undefined,
        note: verdict.note,
    });
    return out(verdict.decision);
}
if (require.main === module) {
    void (0, io_1.runHook)(handle, { fallback: (_input, err) => failClosedOutput(String(err)) });
}
