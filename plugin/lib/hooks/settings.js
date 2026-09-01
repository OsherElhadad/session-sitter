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
exports.loadSettings = loadSettings;
const config_1 = require("../supervisor/config");
const generalise_1 = require("../policy/generalise");
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
        user: env.SESSION_SITTER_USER || null,
        project: env.SESSION_SITTER_PROJECT || null,
        team: env.SESSION_SITTER_TEAM || null,
        practicesFile: env.SESSION_SITTER_PRACTICES || null,
        supervisor: (0, config_1.loadConfig)({ workspaceRoot: cwd }),
    };
}
