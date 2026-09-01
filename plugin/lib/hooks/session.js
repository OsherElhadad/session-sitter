// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/session.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Adapt a Claude Code hook event into the shape the supervision engine already speaks.
 *
 * `src/supervisor/tiers.ts` was written against the IBM Bob / Cline tool vocabulary — `read_file`,
 * `execute_command` — because that is what the VS Code front end sees. Claude Code names the same
 * tools `Read` and `Bash`. Translating here is the front end's whole job: no decision logic moves
 * into this file, and `tiers.ts` is not touched, so both front ends keep asking the same engine the
 * same question.
 *
 * The mapping is deliberately partial. Only tools whose Claude Code semantics are *identical* to an
 * engine tool are mapped; everything else keeps its own name, which makes `preClassify` return null
 * and sends the call to the written clauses and the classifier. An unmapped tool therefore fails
 * toward scrutiny, never toward approval.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_ALIASES = void 0;
exports.engineToolName = engineToolName;
exports.haystackFor = haystackFor;
exports.sessionFromPermissionRequest = sessionFromPermissionRequest;
/**
 * Claude Code tool name → engine tool name. `Write`, `Edit` and `NotebookEdit` are deliberately
 * absent: they mutate the workspace, and the engine's deterministic green tier is for reads.
 */
exports.TOOL_ALIASES = {
    Read: 'read_file',
    Glob: 'glob',
    Grep: 'grep',
    Bash: 'execute_command',
    BashOutput: 'execute_command',
};
function engineToolName(toolName) {
    return exports.TOOL_ALIASES[toolName] ?? toolName;
}
/** Everything the deterministic and clause matchers scan: the tool name plus its arguments. */
function haystackFor(toolName, toolInput) {
    return `${toolName} ${toolInput ? JSON.stringify(toolInput) : ''}`;
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
        name: engineToolName(toolName),
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
