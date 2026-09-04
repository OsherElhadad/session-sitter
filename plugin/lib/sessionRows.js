// GENERATED FILE — DO NOT EDIT.
// Compiled from src/sessionRows.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
exports.bobRowToSession = bobRowToSession;
const path = __importStar(require("path"));
const sessionStatus_1 = require("./sessionStatus");
/**
 * Map one Bob task row to a session, or null when the row carries no usable title.
 *
 * `peer` tags a session that came from another machine; omit it for local rows.
 *
 * The status here is only what the row itself can support: `tasks.status` reads `running` whether
 * Bob is executing a tool or sitting on a permission prompt, so it cannot tell those apart. A live
 * pending approval is folded in later, once, by the view provider — see `resolveDisplayStatus`.
 */
function bobRowToSession(row, peer) {
    const title = (row.title || row.first_message || '').slice(0, 60);
    if (!title) {
        return null;
    }
    const projectPath = bobProjectPath(row);
    const session = {
        sessionId: row.id,
        projectName: projectPath ? path.basename(projectPath) : '',
        projectPath,
        title,
        updatedAt: new Date(row.updated_at),
        // Bob's 'running' means actively processing; its 'active' means a finished task. The rule,
        // and that trap, live in sessionStatus.ts alongside Claude's.
        status: (0, sessionStatus_1.bobStatus)(row.status),
        source: 'bob',
    };
    if (peer) {
        session.peer = peer;
    }
    return session;
}
/** Where a Bob task's workspace lives, preferring the richest source in its `env` blob. */
function bobProjectPath(row) {
    try {
        const env = JSON.parse(row.env);
        const fromEnv = env.staticEnvInfo?.primaryWorkspace ?? env.workspace ?? '';
        if (fromEnv) {
            return fromEnv;
        }
    }
    catch { /* fall through to project_id */ }
    // project_id is a "file:/path" URI.
    if (typeof row.project_id === 'string' && row.project_id.startsWith('file:')) {
        return row.project_id.slice('file:'.length);
    }
    return '';
}
