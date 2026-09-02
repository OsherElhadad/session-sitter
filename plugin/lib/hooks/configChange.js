#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/configChange.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The `ConfigChange` hook — stop the agent from widening its own permissions.
 *
 * An agent that can edit `.claude/settings.json` can add itself an allow rule, delete the deny rule
 * that was stopping it, or set `defaultMode` to `bypassPermissions`. Everything else this plugin does
 * is decided by rules that live in a file the agent can write, so this is the escalation path that
 * makes the rest of it theatre. `Pantheon-Security/medusa` (973 stars) scans `.claude/` for exactly
 * this reason, and `claude-settings-guard` exists for nothing else.
 *
 * ## The contract, verified against the hooks reference on 2026-09-02
 *
 *  - Matchers are `user_settings | project_settings | local_settings | policy_settings | skills`.
 *  - Input carries `source` and optionally `file_path`, on top of the common fields.
 *  - Output is a **top-level** `decision`, not a `hookSpecificOutput`: `{"decision": "block"}`
 *    prevents the change from being applied to the running session. `reason` is, verbatim,
 *    "Accepted but never shown".
 *  - `policy_settings` **cannot be blocked**: "any blocking decision is ignored. This ensures
 *    enterprise-managed settings always take effect." So those are recorded and allowed through,
 *    and this hook never claims otherwise.
 *  - "A blocked change surfaces no message to you or to Claude ... Claude Code only writes a line to
 *    the debug log." Which is why the audit record below is not a nice-to-have: it is the **only**
 *    place a block is visible to a human.
 *
 * ## How "widened" is decided
 *
 * The hook is told a file changed, not what it changed *from* — so it keeps a snapshot of the
 * permissions it last accepted, under {@link snapshotPath}, and diffs against that. Three widenings
 * are recognised, and they are the three that grant reach:
 *
 *  - an entry appears in `permissions.allow`;
 *  - an entry disappears from `permissions.deny`;
 *  - `permissions.defaultMode` moves up {@link MODE_RANK}.
 *
 * Narrowing — adding a deny, dropping an allow, moving the mode down — is allowed and recorded.
 *
 * Two honest limits, both recorded rather than papered over:
 *
 *  - **The first change to a file is always allowed.** With no snapshot there is nothing to compare,
 *    and blocking on ignorance would block the first legitimate edit of every session.
 *  - **A blocked change is still on disk.** Blocking only stops the running session from applying it,
 *    so the snapshot is deliberately *not* advanced on a block: the file is still wide, and the next
 *    edit is still measured against the last permissions that were actually accepted.
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
exports.MODE_RANK = exports.GUARD_CITATION = void 0;
exports.permissionShape = permissionShape;
exports.widenings = widenings;
exports.snapshotPath = snapshotPath;
exports.handle = handle;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const trail_1 = require("../audit/trail");
const paths_1 = require("./paths");
const io_1 = require("./io");
/** The citation a decision made by this guard carries. It is a built-in rule, not a written clause. */
exports.GUARD_CITATION = 'built-in §config-guard';
/**
 * Permission modes, least permissive first, so a move up the list is a widening.
 *
 * `manual` is documented as an alias for `default`, so it ranks the same. Placing `auto` above
 * `acceptEdits` is a judgement call: `acceptEdits` waives the prompt for edits only, while `auto`
 * hands every category of call to a classifier. An **unrecognised** mode ranks above all of them, so
 * a mode this table has never heard of is treated as the widest thing it could be.
 */
exports.MODE_RANK = {
    plan: 0,
    default: 1,
    manual: 1,
    acceptEdits: 2,
    auto: 3,
    dontAsk: 4,
    bypassPermissions: 5,
};
const UNKNOWN_MODE_RANK = 99;
function rank(mode) {
    if (mode === null) {
        return exports.MODE_RANK.default;
    }
    const known = exports.MODE_RANK[mode];
    return known === undefined ? UNKNOWN_MODE_RANK : known;
}
function stringList(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
/** Lift the permission shape out of a parsed settings object. A missing block is an empty shape. */
function permissionShape(settings) {
    const root = settings && typeof settings === 'object' ? settings : {};
    const perms = root.permissions && typeof root.permissions === 'object'
        ? root.permissions : {};
    return {
        allow: stringList(perms.allow),
        deny: stringList(perms.deny),
        defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null,
    };
}
/**
 * Every way `next` grants more than `before`, as lines a human can read. Empty means the change
 * narrows, or leaves the agent's reach exactly where it was.
 */
function widenings(before, next) {
    const found = [];
    const had = new Set(before.allow);
    for (const rule of next.allow) {
        if (!had.has(rule)) {
            found.push(`permissions.allow gained "${rule}"`);
        }
    }
    const keeps = new Set(next.deny);
    for (const rule of before.deny) {
        if (!keeps.has(rule)) {
            found.push(`permissions.deny lost "${rule}"`);
        }
    }
    if (rank(next.defaultMode) > rank(before.defaultMode)) {
        found.push(`permissions.defaultMode widened from "${before.defaultMode ?? 'default'}" `
            + `to "${next.defaultMode ?? 'default'}"`);
    }
    return found;
}
/** Where the last-accepted shape for one config file is kept. Named by a hash so any path is safe. */
function snapshotPath(source, filePath, env) {
    const key = (0, crypto_1.createHash)('sha256').update(`${source} ${filePath}`, 'utf8').digest('hex').slice(0, 16);
    return path.join((0, paths_1.dataDir)(env), 'config-snapshots', `${key}.json`);
}
function readSnapshot(file) {
    try {
        return permissionShape({ permissions: JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
    catch {
        return null;
    }
}
/** Best-effort: a snapshot we could not write means the next change is compared against the old one. */
function writeSnapshot(file, shape) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(shape), 'utf8');
    }
    catch {
        // Deliberately silent, as in appendJsonl. A failed snapshot must not deny a config change.
    }
}
/** Sources whose `permissions` block this guard actually adjudicates. */
const SETTINGS_SOURCES = new Set(['user_settings', 'project_settings', 'local_settings']);
function record(input, blocked, note, started) {
    (0, trail_1.appendJsonl)((0, paths_1.decisionsPath)(), {
        ts: new Date().toISOString(),
        sessionId: input.session_id ?? 'unknown',
        cwd: input.cwd ?? '',
        tool: 'ConfigChange',
        inputSummary: `${input.source ?? 'unknown'} ${input.file_path ?? ''}`.trim(),
        light: blocked ? 'red' : 'green',
        decision: blocked ? 'deny' : 'allow',
        clause: exports.GUARD_CITATION,
        actor: 'deterministic',
        latencyMs: Date.now() - started,
        rewritten: false,
        note,
    });
}
async function handle(rawInput) {
    const started = Date.now();
    const input = rawInput;
    const source = (input.source ?? '').trim();
    const filePath = input.file_path ?? '';
    // Documented as unblockable. Recording it is the whole of what this hook can honestly do.
    if (source === 'policy_settings') {
        record(input, false, 'recorded — managed policy settings changed; the platform documents these '
            + 'as unblockable, so no decision was returned', started);
        return {};
    }
    if (!SETTINGS_SOURCES.has(source) || filePath === '') {
        record(input, false, `recorded — ${source || 'an unknown source'} carries no permissions block `
            + 'to adjudicate', started);
        return {};
    }
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    }
    catch (err) {
        // Unreadable is not evidence of widening, and Claude Code will make its own sense of a file it
        // cannot read either. Recorded and allowed, rather than blocked on a guess.
        record(input, false, `recorded — ${source} changed but could not be read (${String(err)}); no `
            + 'comparison was possible', started);
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        // Read fine, parsed as nothing. That is the shape of an attempt to get past this guard with
        // syntax it cannot follow, so this one blocks.
        record(input, true, `blocked — ${source} is not parseable JSON (${String(err)}), so the `
            + 'permissions it grants could not be checked', started);
        return {
            decision: 'block',
            reason: `${filePath} could not be parsed, so Session Sitter could not check whether it widens `
                + 'permissions.',
        };
    }
    const next = permissionShape(parsed);
    const snapshot = snapshotPath(source, filePath);
    const before = readSnapshot(snapshot);
    if (before === null) {
        writeSnapshot(snapshot, next);
        record(input, false, `recorded — first observation of ${source}; nothing to compare against, so `
            + 'this shape is now the baseline', started);
        return {};
    }
    const widened = widenings(before, next);
    if (widened.length === 0) {
        writeSnapshot(snapshot, next);
        record(input, false, `allowed — ${source} changed without widening what the agent may do`, started);
        return {};
    }
    // The snapshot is NOT advanced: the file on disk is still wide, and the baseline stays the last
    // shape that was actually accepted.
    record(input, true, `blocked — ${source} widened the agent's own permissions: ${widened.join('; ')}`, started);
    return {
        decision: 'block',
        reason: `Session Sitter blocked this change to ${filePath} because it widens what the agent may `
            + `do: ${widened.join('; ')}.`,
    };
}
if (require.main === module) {
    // No fallback output: a thrown ConfigChange hook exits non-zero, and exit 2 on this event blocks
    // the change, which is the safe direction, so there is nothing to substitute.
    void (0, io_1.runHook)(handle);
}
