#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/sessionStart.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The `SessionStart` hook — register this session so it exists to the rest of the product.
 *
 * A bare `claude` in a terminal is invisible to a VS Code panel and, being local, invisible to a
 * peer machine. Writing one small file per session is what makes it appear in the worklist, and it
 * is what lets the audit trail say whose decision a record belongs to: the trail stores a session
 * id, and without this file that id names nothing.
 *
 * `SessionStart` runs on every session *including resume*, so it is written to be cheap and
 * idempotent — one small JSON file, overwritten.
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
exports.modelName = modelName;
exports.handle = handle;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const io_1 = require("./io");
const paths_1 = require("./paths");
/** The model id, whether it arrived as a string or as a `{id, display_name}` object. */
function modelName(model) {
    if (typeof model === 'string') {
        return model || null;
    }
    if (model && typeof model === 'object') {
        const m = model;
        for (const key of ['id', 'display_name']) {
            if (typeof m[key] === 'string' && m[key]) {
                return m[key];
            }
        }
    }
    return null;
}
async function handle(input) {
    const sessionId = input.session_id ?? 'unknown';
    const record = {
        sessionId,
        cwd: input.cwd ?? '',
        // The hook process's own parent is the `claude` process, which is what a worklist wants to
        // know about — `process.pid` here is this short-lived hook.
        pid: typeof process.ppid === 'number' ? process.ppid : process.pid,
        name: typeof input.session_title === 'string' ? input.session_title : null,
        // `model` is documented as optional and arrives as a bare id in some versions and as
        // `{id, display_name}` in others, so both are accepted rather than one being assumed.
        model: modelName(input.model),
        source: typeof input.source === 'string' ? input.source : null,
        startedAt: new Date().toISOString(),
        host: os.hostname(),
    };
    const file = (0, paths_1.sessionPath)(sessionId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    // No decision fields: this event only accepts context, and this hook has none to add.
    return {};
}
if (require.main === module) {
    void (0, io_1.runHook)(handle);
}
