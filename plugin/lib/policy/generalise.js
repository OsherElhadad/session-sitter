// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/generalise.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Turn "this clause allowed this call" into the permission rule the user actually meant.
 *
 * ## The bug this closes
 *
 * Claude Code's "Always allow" saves the *literal* command string it was shown, commit message and
 * all, so the rule it writes never matches a second time and `settings.local.json` silently fills
 * with hundreds of dead one-off entries — issues #6850 (45 reactions, open) and #11380 (64
 * reactions). #29187 is the same dialog getting it wrong in the other direction, offering a wildcard
 * far wider than the subcommand the user approved.
 *
 * `PermissionRequest` lets a hook return `decision.updatedPermissions`, and the docs say plainly
 * that echoing one of the `permission_suggestions` back "is equivalent to the user selecting that
 * 'always allow' option in the dialog". So a policy layer can decline the literal suggestion and
 * emit the *right* rule instead — derived from the written clause that approved the call, which is
 * the only thing in the system that actually knows what class of call is licensed.
 *
 * ## Why it is this conservative
 *
 * A too-wide rule is a security hole that outlives the session, and nobody will ever read it again.
 * So a rule is emitted only when every one of these holds, and otherwise nothing is emitted and the
 * prompt simply comes back:
 *
 *  1. **A green clause allowed the call.** Never a deny (`updatedPermissions` is allow-only anyway),
 *     never the correction lane (a rewrite is per-call, and a standing rule for a call the agent
 *     never actually made is nonsense), and never the deterministic tier (which has no clause to
 *     derive from, and grants that path for free on every call regardless).
 *  2. **The tool is `Bash`.** It is the tool with the prefix-rule syntax and the tool the reported
 *     issues are about. `execute_command` is IBM Bob's shell tool and has no Claude Code rules.
 *  3. **The call is a single command.** A rule derived from a compound is the very bug the compound
 *     evaluator exists to fix: `Bash(x:*)` matches on the prefix, so a rule written from
 *     `git status && rm -rf /` would license the `rm` to anything starting with `git status`.
 *  4. **The matcher was written as a substring, and the command starts with it, on a word boundary.**
 *     A `/regex/` clause says nothing a prefix rule can express, and a substring that matched in the
 *     *middle* of the command licenses no prefix at all.
 *
 * The result is strictly narrower than the clause: the clause allows its substring **anywhere** in a
 * command, and the emitted rule allows it only as a **prefix**.
 *
 * ## Where it is written
 *
 * `session` by default — in memory, gone when the session ends. A hook that edits a git-tracked
 * settings file behind someone's back is a bad citizen, and `projectSettings` is exactly that until
 * somebody asks for it. `SESSION_SITTER_RULE_DESTINATION` moves it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RULE_DESTINATIONS = void 0;
exports.prefixOf = prefixOf;
exports.generalisedPermission = generalisedPermission;
const practices_1 = require("./practices");
const shell_1 = require("./shell");
exports.RULE_DESTINATIONS = ['session', 'localSettings', 'projectSettings', 'userSettings'];
/** Only Claude Code's shell tool has prefix rules to generalise into. */
const SHELL_TOOL = 'Bash';
/**
 * Is `raw` a prefix of `command`, ending on a word boundary?
 *
 * The boundary check is the load-bearing half: without it a clause matching `git s` would emit
 * `Bash(git s:*)`, which also licenses `git shove-everything`. Whitespace is loosened the same way
 * `substringMatcher` loosens it, so `npm  test` and `npm test` are the same prefix.
 */
function prefixOf(raw, command) {
    const escaped = raw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const anchored = new RegExp(`^\\s*(${escaped})(?=\\s|$)`, 'i');
    const m = anchored.exec(command);
    return m ? m[1] : null;
}
/**
 * The rule this clause licenses for this call, or null when nothing safe can be derived.
 *
 * `clause` must be the green clause that actually allowed the call; the caller is responsible for
 * never passing a clause that denied, and for never calling this for a corrected call.
 */
function generalisedPermission(clause, toolName, toolInput, destination = 'session') {
    if (clause.level !== 'green') {
        return null;
    }
    if (toolName !== SHELL_TOOL) {
        return null;
    }
    const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
    if (command === null || command.trim() === '') {
        return null;
    }
    // A compound is never generalised — see rule 3 above.
    const split = (0, shell_1.splitShellCommand)(command);
    if (!split.confident || split.commands.length !== 1) {
        return null;
    }
    // The clause matched the tool name + arguments JSON, so re-derive which matcher did it against
    // the same haystack shape the decision used, then require that matcher to be a usable prefix.
    const matched = (0, practices_1.matchingPattern)(clause, `${toolName} ${JSON.stringify(toolInput ?? {})}`);
    if (matched === null || matched.isRegex) {
        return null;
    }
    const prefix = prefixOf(matched.raw, command);
    if (prefix === null) {
        return null;
    }
    return {
        type: 'addRules',
        rules: [{ toolName: SHELL_TOOL, ruleContent: `${prefix}:*` }],
        behavior: 'allow',
        destination,
    };
}
