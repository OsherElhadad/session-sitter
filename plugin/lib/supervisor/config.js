// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/config.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Configuration for the runtime supervisor.
 *
 * Ported from the Python supervisor (`config.py`. Values come from (highest precedence first):
 * explicit overrides, the process environment, a `.env` file, then built-in defaults.
 *
 * The extension builds this from its `sessionSitter.*` settings; the CLI builds it from the
 * environment + `.env`, so both drive the same orchestrator.
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
exports.DEFAULT_BOB_CLI_PATH = exports.DEFAULT_SUPERVISOR_ENGINE = exports.DEFAULT_CLASSIFIER_TIMEOUT_SECONDS = exports.DEFAULT_CLAUDE_CLI_PATH = exports.DEFAULT_ORANGE_TIMEOUT_MINUTES = void 0;
exports.historyDir = historyDir;
exports.outboxDir = outboxDir;
exports.inboxDir = inboxDir;
exports.recordsDir = recordsDir;
exports.notificationsDir = notificationsDir;
exports.ensureDirs = ensureDirs;
exports.loadDotenv = loadDotenv;
exports.loadConfig = loadConfig;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
exports.DEFAULT_ORANGE_TIMEOUT_MINUTES = 30;
exports.DEFAULT_CLAUDE_CLI_PATH = 'claude';
exports.DEFAULT_CLASSIFIER_TIMEOUT_SECONDS = 300;
/** "bob" (IBM Bob Shell) | "claude" (Claude Code) */
exports.DEFAULT_SUPERVISOR_ENGINE = 'bob';
exports.DEFAULT_BOB_CLI_PATH = 'bob';
function historyDir(c) { return path.join(c.stateDir, 'history'); }
function outboxDir(c) { return path.join(c.stateDir, 'outbox'); }
function inboxDir(c) { return path.join(c.stateDir, 'inbox'); }
function recordsDir(c) { return path.join(c.stateDir, 'records'); }
function notificationsDir(c) {
    return path.join(c.stateDir, 'notifications');
}
function ensureDirs(c) {
    for (const d of [
        c.stateDir, historyDir(c), outboxDir(c), inboxDir(c), recordsDir(c), notificationsDir(c),
    ]) {
        fs.mkdirSync(d, { recursive: true });
    }
}
/**
 * Parse a minimal `.env` file (KEY=VALUE lines). Never throws on a missing file. Supports
 * optional surrounding quotes and `#` comments. Does not mutate `process.env`.
 */
function loadDotenv(filePath) {
    const values = {};
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return values;
    }
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) {
            continue;
        }
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === "'" || val[0] === '"')) {
            val = val.slice(1, -1);
        }
        if (key) {
            values[key] = val;
        }
    }
    return values;
}
function get(env, key, fallback) {
    // Process env wins over the .env file.
    return process.env[key] ?? env[key] ?? fallback;
}
function getInt(env, key, fallback) {
    const raw = get(env, key);
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}
function getBool(env, key, fallback) {
    const raw = get(env, key);
    if (raw === undefined) {
        return fallback;
    }
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
function expandHome(p) {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
/** Build a `SupervisorConfig`, layering the process env over any `.env` files. */
function loadConfig(overrides = {}) {
    const root = path.resolve(overrides.workspaceRoot ?? process.cwd());
    // Layer (lowest→highest): parent-of-root .env < root .env < any explicitly listed file.
    // Process env still wins over all of these (see `get`).
    const env = Object.assign({}, loadDotenv(path.join(path.dirname(root), '.env')), loadDotenv(path.join(root, '.env')), ...(overrides.envFiles ?? []).map(loadDotenv));
    const envStateDir = get(env, 'STATE_DIR');
    const stateDir = path.resolve(overrides.stateDir ?? (envStateDir ? expandHome(envStateDir) : path.join(root, '.supervisor-state')));
    return {
        workspaceRoot: root,
        stateDir,
        orangeResponseTimeoutMinutes: getInt(env, 'ORANGE_RESPONSE_TIMEOUT_MINUTES', exports.DEFAULT_ORANGE_TIMEOUT_MINUTES),
        supervisorEngine: (get(env, 'SUPERVISOR_ENGINE', exports.DEFAULT_SUPERVISOR_ENGINE)
            ?? exports.DEFAULT_SUPERVISOR_ENGINE).toLowerCase(),
        claudeCliPath: get(env, 'CLAUDE_CLI_PATH', exports.DEFAULT_CLAUDE_CLI_PATH) ?? exports.DEFAULT_CLAUDE_CLI_PATH,
        classifierTimeoutSeconds: getInt(env, 'CLAUDE_TIMEOUT_SECONDS', exports.DEFAULT_CLASSIFIER_TIMEOUT_SECONDS),
        bobCliPath: get(env, 'BOB_CLI_PATH', exports.DEFAULT_BOB_CLI_PATH) ?? exports.DEFAULT_BOB_CLI_PATH,
        // Bob's headless auth. Accept either BOBSHELL_API_KEY or BOB_API_KEY.
        bobShellApiKey: get(env, 'BOBSHELL_API_KEY') ?? get(env, 'BOB_API_KEY') ?? null,
        anthropicBaseUrl: get(env, 'ANTHROPIC_BASE_URL') ?? null,
        anthropicAuthToken: get(env, 'ANTHROPIC_AUTH_TOKEN') ?? null,
        messagingChannel: (get(env, 'MESSAGING_CHANNEL', 'stub') ?? 'stub').toLowerCase(),
        redNotify: getBool(env, 'RED_NOTIFY', true),
        notifyRuleDecisions: getBool(env, 'NOTIFY_RULE_DECISIONS', true),
        telegramBotToken: get(env, 'TELEGRAM_BOT_TOKEN') ?? null,
        telegramChatId: get(env, 'TELEGRAM_CHAT_ID') ?? null,
        knowledgeRegistryPath: get(env, 'KNOWLEDGE_REGISTRY_PATH', '') ?? '',
        knowledgeLocalRepo: get(env, 'KNOWLEDGE_LOCAL_REPO') ?? get(env, 'KB_SITTER_LOCAL_REPO', '') ?? '',
        knowledgeRepo: get(env, 'KNOWLEDGE_REPO') ?? get(env, 'KB_SITTER_KNOWLEDGE_REPO', '') ?? '',
        knowledgeRef: get(env, 'KNOWLEDGE_REF', 'main') ?? 'main',
    };
}
