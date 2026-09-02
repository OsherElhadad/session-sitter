#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/sessionEnd.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The `SessionEnd` hook — close the session's audit record out.
 *
 * The registration file written at `SessionStart` says a session exists; without this, it says so
 * forever, and a worklist cannot tell a running session from one that ended two days ago. So the
 * same file is stamped with an end time, the reason, and the decision count — which is what makes
 * the overnight digest a bounded question ("this run", not "everything on disk").
 *
 * `SessionEnd` shares a **1.5 second** budget across all hooks, and a plugin's own `timeout` cannot
 * raise it. So this reads one small file, counts lines already on disk, and writes one file. It
 * never loads policy and never spawns anything.
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
exports.handle = handle;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const trail_1 = require("../audit/trail");
const paths_1 = require("./paths");
const io_1 = require("./io");
async function handle(input) {
    const sessionId = input.session_id ?? 'unknown';
    const file = (0, paths_1.sessionPath)(sessionId);
    let existing = {};
    try {
        existing = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    }
    catch {
        // No registration — a session that started before the plugin was enabled, or a cleared data
        // dir. Close it out anyway rather than dropping the record.
    }
    const mine = (0, trail_1.readJsonl)((0, paths_1.decisionsPath)()).filter(r => r.sessionId === sessionId);
    const closed = {
        ...existing,
        sessionId,
        endedAt: new Date().toISOString(),
        endReason: typeof input.reason === 'string' ? input.reason : null,
        decisions: mine.length,
        denied: mine.filter(r => r.decision === 'deny').length,
        corrected: mine.filter(r => r.rewritten).length,
    };
    try {
        // The directory may not exist: a session that started before the plugin was enabled never had
        // a registration written, and closing it out is still worth doing.
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, `${JSON.stringify(closed, null, 2)}\n`, 'utf8');
    }
    catch {
        // Nothing useful to do inside a 1.5 s budget with no way to report it. The decisions
        // themselves are already durable in the trail.
    }
    return {};
}
if (require.main === module) {
    void (0, io_1.runHook)(handle);
}
