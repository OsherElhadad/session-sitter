// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/factory.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Build a wired `Orchestrator` from a `SupervisorConfig`.
 *
 * Replaces the `_build_*` helpers in `supervise.py`. Shared by the CLI and by the extension's
 * in-process `SupervisionService`, so both drive an identically-configured supervisor.
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
exports.buildChannel = buildChannel;
exports.buildEngine = buildEngine;
exports.buildOrchestrator = buildOrchestrator;
const path = __importStar(require("path"));
const agentControl_1 = require("./agentControl");
const config_1 = require("./config");
const engine_1 = require("./engine");
const messaging_1 = require("./messaging");
const orchestrator_1 = require("./orchestrator");
const store_1 = require("./store");
const telegram_1 = require("./telegram");
const transcript_1 = require("./transcript");
function buildChannel(config, log = () => { }) {
    if (config.messagingChannel === 'telegram') {
        if (config.telegramBotToken && config.telegramChatId) {
            return new telegram_1.TelegramChannel({
                token: config.telegramBotToken,
                chatId: config.telegramChatId,
                offsetPath: path.join(config.stateDir, 'telegram_offset.txt'),
                timeoutMinutes: config.orangeResponseTimeoutMinutes,
                longPollSeconds: 10, // getUpdates returns instantly on a tap/reply
                log,
            });
        }
        log('warning: messaging channel is telegram but the bot token / chat id are missing; '
            + 'using the stub channel instead.');
    }
    return new messaging_1.StubChannel((0, config_1.notificationsDir)(config), (0, config_1.inboxDir)(config), undefined, log);
}
/** Select the classifier CLI. Default: IBM Bob Shell; `SUPERVISOR_ENGINE=claude` for Claude. */
function buildEngine(config) {
    if (config.supervisorEngine === 'claude') {
        return new engine_1.ClaudeCodeEngine({
            cliPath: config.claudeCliPath,
            cwd: config.workspaceRoot,
            timeoutSeconds: config.classifierTimeoutSeconds,
            anthropicBaseUrl: config.anthropicBaseUrl,
            anthropicAuthToken: config.anthropicAuthToken,
        });
    }
    return new engine_1.BobCliEngine({
        cliPath: config.bobCliPath,
        // cwd omitted on purpose: an isolated empty temp dir, never the workspace (see BobCliEngine).
        timeoutSeconds: config.classifierTimeoutSeconds,
        apiKey: config.bobShellApiKey,
    });
}
function buildOrchestrator(opts) {
    const { config } = opts;
    (0, config_1.ensureDirs)(config);
    const log = opts.log ?? (() => { });
    return new orchestrator_1.Orchestrator({
        config,
        store: new store_1.StateStore((0, config_1.recordsDir)(config)),
        transcriptSource: new transcript_1.FileTranscriptSource((0, config_1.historyDir)(config), opts.transcriptOverride),
        engine: opts.engine ?? buildEngine(config),
        channel: opts.channel ?? buildChannel(config, log),
        agentController: opts.agentController
            ?? new agentControl_1.OutboxAgentController((0, config_1.outboxDir)(config), opts.onDelivered),
        knowledgeFetch: opts.knowledgeFetch,
        log,
    });
}
