// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/session.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Adapt a Claude Code hook event into the shape the supervision engine already speaks.
 *
 * There is deliberately no tool-name translation here. `src/supervisor/tiers.ts` names Claude Code's
 * tools alongside IBM Bob's — `Read` next to `read_file`, `Bash` next to `execute_command` — so the
 * hook hands the engine the tool name it was given and the engine recognises it. An earlier version
 * of this file carried an alias table; it was removed once `tiers.ts` covered both vocabularies,
 * because a second mapping of the same names is a second place for them to disagree. (It had already
 * gone wrong once: it mapped `BashOutput` to `execute_command`, which has a `command` argument
 * `BashOutput` does not, so reading a background job's output fell through to a denial.)
 *
 * A tool the engine does not recognise makes `preClassify` return null, which sends the call to the
 * written clauses and the classifier. So an unknown tool fails toward scrutiny, never toward
 * approval.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.haystackFor = haystackFor;
exports.sessionFromPermissionRequest = sessionFromPermissionRequest;
/**
 * Argument keys whose value is a *payload* — the bytes being written — rather than something
 * identifying what the call does. A `Write`'s `content` is the file itself.
 */
const PAYLOAD_KEYS = new Set([
    'content', 'old_string', 'new_string', 'new_source', 'edits',
]);
/**
 * Everything the deterministic and clause matchers scan: the tool name plus its arguments.
 *
 * `payload` decides whether the bytes being written are included, and the two callers want
 * different answers. Matching is substring matching over serialised arguments, which cannot tell
 * "do this" from "this was done" — so a file that *describes* a command reads exactly like the
 * command. Observed for real: a NOTES.md summarising a session was denied by a clause about
 * rewriting git history because it quoted the command, and then a later draft was **allowed** by a
 * green clause about running the test suite because it contained the words `node --test`. A clause
 * about tests permitted a file write.
 *
 * A false deny is an annoyance; a false allow is a hole, and red-outranks-green does not save you
 * when only the wrong green matches. So the rule is that payload may make a decision **more**
 * restrictive and never less: red clauses scan it, green clauses do not. The cost is that a green
 * clause cannot be written about a file's contents, which is the right way round.
 */
function haystackFor(toolName, toolInput, payload = 'with-payload') {
    if (!toolInput) {
        return `${toolName} `;
    }
    const args = payload === 'with-payload'
        ? toolInput
        : Object.fromEntries(Object.entries(toolInput).filter(([k]) => !PAYLOAD_KEYS.has(k)));
    return `${toolName} ${JSON.stringify(args)}`;
}
/**
 * Build the minimal `NormalizedSession` the engine's tiers and prompt builder need.
 *
 * The transcript turns are left empty on purpose. The hook is given a `transcript_path`, but that
 * file is the entire session as JSONL and `PermissionRequest` runs in front of a live prompt — so
 * reading it would trade the plugin's whole latency budget for context the deterministic path never
 * consults. The consequence is real and worth naming: when the classifier tier does run, it judges
 * the pending action and the written practices, not the conversation that led there.
 */
function sessionFromPermissionRequest(input) {
    const toolName = input.tool_name ?? '';
    const toolInput = input.tool_input ?? null;
    const pendingAction = {
        kind: 'tool_call',
        description: `${toolName} requested permission`,
        name: toolName,
        arguments: toolInput,
        permission: 'ask',
        turnIndex: null,
        requestId: null,
    };
    return {
        sessionId: input.session_id ?? 'unknown',
        source: 'claude-code',
        turns: [],
        waitingReason: 'awaiting a permission decision',
        user: null,
        projectPath: input.cwd ?? '',
        projectName: '',
        status: 'waiting',
        approvalConfig: null,
        title: '',
        pendingAction,
    };
}
