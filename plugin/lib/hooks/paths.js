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
exports.dataDir = dataDir;
exports.decisionsPath = decisionsPath;
exports.activityPath = activityPath;
exports.sessionsDir = sessionsDir;
exports.sessionPath = sessionPath;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** Root for everything this plugin writes. Override with `SESSION_SITTER_DATA_DIR` in tests. */
function dataDir(env = process.env) {
    return env.SESSION_SITTER_DATA_DIR
        || env.CLAUDE_PLUGIN_DATA
        || path.join(os.homedir(), '.claude', 'session-sitter');
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
