// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/paths.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Where the plugin keeps its own state.
 *
 * `${CLAUDE_PLUGIN_DATA}` is the directory Claude Code gives an installed plugin
 * (`~/.claude/plugins/data/<id>/`), and it survives plugin updates — unlike `${CLAUDE_PLUGIN_ROOT}`,
 * which changes on every version bump. It is exported into the hook process's environment, so a
 * hook reads it straight from `process.env`.
 *
 * It is absent when the plugin is loaded session-only with `--plugin-dir`, and when a hook is run
 * by hand or from a test. So there is a fallback under the user's `~/.claude/`, which keeps a
 * `--plugin-dir` development run and an installed run writing to a predictable place instead of
 * scattering state into whatever the current directory happens to be.
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
exports.claudeDir = claudeDir;
exports.dataDir = dataDir;
exports.decisionsPath = decisionsPath;
exports.activityPath = activityPath;
exports.sessionsDir = sessionsDir;
exports.sessionPath = sessionPath;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/**
 * The active Claude Code configuration directory.
 *
 * `CLAUDE_CONFIG_DIR` is how Claude Code is pointed somewhere other than `~/.claude`, and it is what
 * an isolated run exports so a test never touches real sessions. Nothing here read it, so every
 * path below resolved against the real home directory regardless — which made `session-sitter
 * status` walk the real session store while exiting 0 and printing a plausible table. A command that
 * ignores an isolation request loudly is recoverable; one that ignores it silently is not.
 *
 * An empty or whitespace-only value is treated as unset, because `export CLAUDE_CONFIG_DIR=` in a
 * sourced env file is how a variable gets cleared, and resolving that to `/session-sitter` would be
 * a worse answer than the default.
 */
function claudeDir(env = process.env, homedir = os.homedir()) {
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    return configured ? configured : path.join(homedir, '.claude');
}
/**
 * Root for everything this plugin writes. Override with `SESSION_SITTER_DATA_DIR` in tests.
 *
 * The two explicit variables still win: `CLAUDE_PLUGIN_DATA` is what Claude Code exports for an
 * installed plugin and already points inside the active config dir, so it needs no help.
 * `claudeDir` only replaces the bare fallback — the path a `--plugin-dir` run or a hand-run hook
 * actually takes, and the one an isolated run was silently escaping.
 */
function dataDir(env = process.env) {
    return env.SESSION_SITTER_DATA_DIR
        || env.CLAUDE_PLUGIN_DATA
        || path.join(claudeDir(env), 'session-sitter');
}
/** One JSON line per governance decision. */
function decisionsPath(env) {
    return path.join(dataDir(env), 'decisions.jsonl');
}
/** One JSON line per tool result — the wedge detector's input. */
function activityPath(env) {
    return path.join(dataDir(env), 'activity.jsonl');
}
/** One JSON file per registered session, named by session id. */
function sessionsDir(env) {
    return path.join(dataDir(env), 'sessions');
}
/** The registration file for one session. */
function sessionPath(sessionId, env) {
    // A session id comes from Claude Code and is a uuid, but it lands in a filename, so anything
    // that is not id-shaped is replaced rather than trusted.
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '-') || 'unknown';
    return path.join(sessionsDir(env), `${safe}.json`);
}
