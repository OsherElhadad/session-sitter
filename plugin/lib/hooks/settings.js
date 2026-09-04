// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/settings.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Plugin-side settings, read from the environment.
 *
 * A hook is a bare process with no VS Code settings and no CLI flags, so the environment is the
 * only channel. `SupervisorConfig` (`src/supervisor/config.ts`) already carries everything the
 * classifier and the knowledge loader need, and already layers `.env` files under the process
 * environment — so this module holds only what is specific to running as a Claude Code plugin.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_ENV = void 0;
exports.loadSettings = loadSettings;
exports.settingRows = settingRows;
const config_1 = require("../supervisor/config");
const generalise_1 = require("../policy/generalise");
const escalate_1 = require("./escalate");
function bool(raw, fallback) {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
/** An unrecognised destination falls back to `session` — the one that changes nothing on disk. */
function ruleDestination(raw) {
    const v = (raw ?? '').trim();
    return generalise_1.RULE_DESTINATIONS.includes(v) ? v : 'session';
}
function loadSettings(env = process.env, cwd) {
    const mode = (env.SESSION_SITTER_MODE ?? '').trim().toLowerCase() === 'observe'
        ? 'observe' : 'enforce';
    return {
        mode,
        classifierEnabled: bool(env.SESSION_SITTER_CLASSIFIER, false),
        persistRules: bool(env.SESSION_SITTER_PERSIST_RULES, false),
        ruleDestination: ruleDestination(env.SESSION_SITTER_RULE_DESTINATION),
        preToolUse: bool(env.SESSION_SITTER_PRETOOL, true),
        escalate: bool(env.SESSION_SITTER_ESCALATE, false),
        escalateWaitSeconds: (0, escalate_1.waitSeconds)(env.SESSION_SITTER_ESCALATE_WAIT),
        user: env.SESSION_SITTER_USER || null,
        project: env.SESSION_SITTER_PROJECT || null,
        team: env.SESSION_SITTER_TEAM || null,
        practicesFile: env.SESSION_SITTER_PRACTICES || null,
        supervisor: (0, config_1.loadConfig)({ workspaceRoot: cwd }),
    };
}
// ── How a terminal changes each of these ────────────────────────────────────
/**
 * The variable that sets each plugin setting, and the reason this table exists next to the loader
 * that reads them.
 *
 * `src/settingsBridge.ts` already answers "how does a terminal set this" for every
 * `sessionSitter.*` setting VS Code declares, and `ci/check-settings.mjs` keeps it honest in both
 * directions. These eleven are not in it, because they are not VS Code settings at all: a plugin
 * hook is a bare process with no settings host, so the environment is not a *fallback* for them, it
 * is the only channel. They had no table, so nothing could show a user how to change one.
 *
 * Kept in this file rather than in the bridge so that adding a setting to {@link loadSettings} and
 * forgetting to say how it is set is a change in one file, and so the drift is catchable: a test
 * parses the `env.SESSION_SITTER_*` reads out of this module's own source and compares the two
 * lists, which is the same shape of check `ci/check-settings.mjs` applies to the manifest. A grep
 * for the symbol would not do it — the assertion has to be over what the loader actually reads.
 */
exports.PLUGIN_ENV = {
    mode: 'SESSION_SITTER_MODE',
    classifierEnabled: 'SESSION_SITTER_CLASSIFIER',
    persistRules: 'SESSION_SITTER_PERSIST_RULES',
    ruleDestination: 'SESSION_SITTER_RULE_DESTINATION',
    preToolUse: 'SESSION_SITTER_PRETOOL',
    escalate: 'SESSION_SITTER_ESCALATE',
    escalateWaitSeconds: 'SESSION_SITTER_ESCALATE_WAIT',
    user: 'SESSION_SITTER_USER',
    project: 'SESSION_SITTER_PROJECT',
    team: 'SESSION_SITTER_TEAM',
    practicesFile: 'SESSION_SITTER_PRACTICES',
};
/**
 * The resolved configuration, each row carrying the command that changes it.
 *
 * **Read here, written in a terminal, and that asymmetry is the design.** Session Sitter's central
 * property is that the supervised agent cannot change the policy that governs it. A rendered page
 * that can POST a new mode is a write endpoint inside a fail-closed governance tool, reachable by
 * anything that can reach the page — which on the tier-2 path is a Grafana with anonymous admin
 * enabled on purpose. So every row shows what is in force and the one line that changes it, and
 * nothing here can change anything.
 *
 * Values come from {@link loadSettings}, never from a second read of the environment: a config view
 * that re-parses its own inputs is a view that can disagree with the code it claims to describe,
 * and it will, eventually, exactly when someone is relying on it.
 */
function settingRows(s) {
    const shown = {
        mode: s.mode,
        classifierEnabled: s.classifierEnabled,
        persistRules: s.persistRules,
        ruleDestination: s.ruleDestination,
        preToolUse: s.preToolUse,
        escalate: s.escalate,
        escalateWaitSeconds: s.escalateWaitSeconds,
        user: s.user,
        project: s.project,
        team: s.team,
        practicesFile: s.practicesFile,
    };
    return Object.keys(exports.PLUGIN_ENV).map(key => {
        const value = shown[key];
        const env = exports.PLUGIN_ENV[key];
        return {
            key,
            value: value === null || value === undefined ? null : String(value),
            env,
            // A boolean's command shows the value that FLIPS it, because the useful command is the one
            // that changes something. Everything else shows what is in force, ready to edit.
            command: typeof value === 'boolean'
                ? `export ${env}=${value ? '0' : '1'}`
                : `export ${env}=${value === null ? '<value>' : String(value)}`,
        };
    });
}
