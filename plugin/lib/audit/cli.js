#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/audit/cli.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Query the audit trail from the terminal.
 *
 *     node out/audit/cli.js log [--since 24h] [--denied] [--corrected] [--session ID] [--json|--csv]
 *     node out/audit/cli.js digest [--since 24h]
 *     node out/audit/cli.js status
 *
 * The plugin's slash commands are thin wrappers around these, so there is one implementation of
 * "what happened" rather than a prose version in a command file and a real version here.
 *
 * Nobody has built the query surface over agent decisions — that is the point of this file. It is
 * deliberately read-only: it opens the JSONL files, filters, and prints.
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
exports.parseDuration = parseDuration;
exports.parseArgs = parseArgs;
exports.filterRecords = filterRecords;
exports.formatLog = formatLog;
exports.formatDigest = formatDigest;
exports.formatStatus = formatStatus;
exports.main = main;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const trail_1 = require("./trail");
const paths_1 = require("../hooks/paths");
const USAGE = `session-sitter — read the governance audit trail

Usage:
  log [options]        every decision, newest last
  digest [options]     one summary per session — what the agents did
  status               the sessions this plugin knows about

Options:
  --since DURATION     only records newer than e.g. 30m, 24h, 7d (default: all)
  --session ID         only this session
  --denied             only denied decisions
  --corrected         only decisions whose input was rewritten
  --json               one JSON array
  --csv                comma-separated, with a header row
  -h, --help           show this help
`;
/** `30m` / `24h` / `7d` / `90s` → milliseconds. Returns null when it is not a duration. */
function parseDuration(raw) {
    const m = /^(\d+)\s*([smhd])$/.exec(raw.trim().toLowerCase());
    if (!m) {
        return null;
    }
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
    return Number.parseInt(m[1], 10) * unit;
}
function parseArgs(argv) {
    const args = {
        command: 'log', since: null, session: null, denied: false, corrected: false, format: 'text',
    };
    const rest = [...argv];
    if (rest.length && !rest[0].startsWith('-')) {
        const cmd = rest.shift();
        if (cmd !== 'log' && cmd !== 'digest' && cmd !== 'status') {
            throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
        }
        args.command = cmd;
    }
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        const next = () => {
            const v = rest[++i];
            if (v === undefined) {
                throw new Error(`${a} needs a value`);
            }
            return v;
        };
        switch (a) {
            case '--since': {
                const raw = next();
                const ms = parseDuration(raw);
                if (ms === null) {
                    throw new Error(`--since wants a duration like 24h, not ${raw}`);
                }
                args.since = ms;
                break;
            }
            case '--session':
                args.session = next();
                break;
            case '--denied':
                args.denied = true;
                break;
            case '--corrected':
                args.corrected = true;
                break;
            case '--json':
                args.format = 'json';
                break;
            case '--csv':
                args.format = 'csv';
                break;
            case '-h':
            case '--help':
                process.stdout.write(USAGE);
                process.exit(0);
                break;
            default: throw new Error(`unknown option: ${a}\n\n${USAGE}`);
        }
    }
    return args;
}
function filterRecords(records, args, now = Date.now()) {
    const floor = args.since === null ? null : now - args.since;
    return records.filter(r => {
        if (args.session && r.sessionId !== args.session) {
            return false;
        }
        if (args.denied && r.decision !== 'deny') {
            return false;
        }
        if (args.corrected && !r.rewritten) {
            return false;
        }
        if (floor !== null && Date.parse(r.ts) < floor) {
            return false;
        }
        return true;
    });
}
const CSV_COLUMNS = [
    'ts', 'sessionId', 'cwd', 'tool', 'inputSummary', 'light', 'decision', 'clause', 'actor',
    'latencyMs', 'rewritten',
];
function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** One line per decision, in the shape the product promises: the clause is always visible. */
function formatLog(records, format) {
    if (format === 'json') {
        return `${JSON.stringify(records, null, 2)}\n`;
    }
    if (format === 'csv') {
        return [
            CSV_COLUMNS.join(','),
            ...records.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(',')),
        ].join('\n') + '\n';
    }
    if (records.length === 0) {
        return 'no decisions recorded\n';
    }
    return `${records.map(r => [
        r.ts,
        { deny: 'DENY ', none: 'PASS ', allow: r.rewritten ? 'FIX  ' : 'ALLOW' }[r.decision] ?? '?    ',
        (r.tool || '-').padEnd(10),
        (r.clause ?? `(${r.actor})`).padEnd(28),
        `${r.latencyMs}ms`.padStart(7),
        r.inputSummary,
    ].join('  ')).join('\n')}\n`;
}
/** "What did my agents do last night" — one block per session. */
function formatDigest(records) {
    if (records.length === 0) {
        return 'no decisions recorded\n';
    }
    const bySession = new Map();
    for (const r of records) {
        bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
    }
    const lines = [];
    for (const [sessionId, rows] of bySession) {
        const denied = rows.filter(r => r.decision === 'deny');
        const passed = rows.filter(r => r.decision === 'none');
        const corrected = rows.filter(r => r.rewritten);
        const byModel = rows.filter(r => r.actor === 'model').length;
        const clauses = new Map();
        for (const r of rows.filter(r => r.clause)) {
            clauses.set(r.clause, (clauses.get(r.clause) ?? 0) + 1);
        }
        const latencies = rows.map(r => r.latencyMs).sort((a, b) => a - b);
        lines.push(`session ${sessionId}  (${rows[0].cwd || 'unknown cwd'})`, `  ${rows.length} decisions — ${rows.length - denied.length - passed.length} allowed, `
            + `${denied.length} denied, ${corrected.length} corrected`
            + (passed.length ? `, ${passed.length} left to the human` : ''), `  ${byModel} needed the classifier; median latency ${latencies[Math.floor(latencies.length / 2)]}ms`, `  window ${rows[0].ts} → ${rows[rows.length - 1].ts}`);
        if (clauses.size) {
            lines.push('  clauses applied:');
            for (const [clause, count] of [...clauses].sort((a, b) => b[1] - a[1])) {
                lines.push(`    ${count.toString().padStart(4)}  ${clause}`);
            }
        }
        if (denied.length) {
            lines.push('  denied:');
            for (const r of denied.slice(0, 10)) {
                lines.push(`    ${r.tool}: ${r.inputSummary}`);
            }
            if (denied.length > 10) {
                lines.push(`    … and ${denied.length - 10} more`);
            }
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}
/**
 * The sessions this plugin registered. Deliberately narrow: it reports what the hooks recorded, not
 * a cross-machine worklist — that reads live agent stores and is not this file's job.
 */
function formatStatus(dir, records) {
    let files;
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    }
    catch {
        return 'no sessions registered — is the plugin enabled?\n';
    }
    if (files.length === 0) {
        return 'no sessions registered — is the plugin enabled?\n';
    }
    const lines = [];
    for (const file of files.sort()) {
        let s;
        try {
            s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        }
        catch {
            continue;
        }
        const id = String(s.sessionId ?? path.basename(file, '.json'));
        const mine = records.filter(r => r.sessionId === id);
        const state = s.endedAt ? `ended ${String(s.endedAt)}` : 'running';
        lines.push(`${id}  ${state}`, `  ${String(s.cwd ?? '')}${s.name ? `  “${String(s.name)}”` : ''}`, `  ${mine.length} decisions, ${mine.filter(r => r.decision === 'deny').length} denied, `
            + `${mine.filter(r => r.rewritten).length} corrected`);
    }
    return `${lines.join('\n')}\n`;
}
function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const records = (0, trail_1.readJsonl)((0, paths_1.decisionsPath)());
    if (args.command === 'status') {
        process.stdout.write(formatStatus((0, paths_1.sessionsDir)(), records));
        process.stdout.write(`\ntrail: ${(0, paths_1.decisionsPath)()}\nactivity: ${(0, paths_1.activityPath)()}\n`);
        return 0;
    }
    const filtered = filterRecords(records, args);
    process.stdout.write(args.command === 'digest'
        ? formatDigest(filtered)
        : formatLog(filtered, args.format));
    return 0;
}
if (require.main === module) {
    try {
        process.exit(main());
    }
    catch (err) {
        process.stderr.write(`${String(err)}\n`);
        process.exit(2);
    }
}
