// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/log.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * `session-sitter log` — query the audit trail.
 *
 * The trail is only worth writing if someone can ask it a question, and the questions people
 * actually ask are narrow: what got blocked, what got rewritten, what happened in this session,
 * what happened since two o'clock. Each of those is one flag here.
 *
 * Output is chronological — oldest first, like every log — and `--limit` keeps the most recent N,
 * which is what you want when you are reading the end of it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CSV_HEADER = exports.NOT_RECORDED = exports.HELP = void 0;
exports.orNotRecorded = orNotRecorded;
exports.clauseOf = clauseOf;
exports.renderText = renderText;
exports.csvCell = csvCell;
exports.renderCsv = renderCsv;
exports.decisionJson = decisionJson;
exports.applyLimit = applyLimit;
exports.run = run;
const audit_1 = require("./audit");
const args_1 = require("./args");
const time_1 = require("./time");
const render_1 = require("./render");
exports.HELP = `session-sitter log — the audit trail of supervision decisions

Usage:
  session-sitter log [options]

Options:
  --since WHEN      only decisions since WHEN: 2h, yesterday, 2026-08-30, or an ISO timestamp
  --denied          only decisions that blocked a call (including countdowns that ran out)
  --corrected       only the correction lane — calls that were rewritten
  --session ID      only this session
  --tool NAME       only this tool, e.g. Bash
  --limit N         keep the most recent N (default: 50; 0 for no limit)
  --state-dir PATH  read this state dir instead of searching for one
  --json            machine-readable output (see docs/CLI.md for the contract)
  --csv             comma-separated, for a spreadsheet
  -h, --help        show this help

A field the writer did not record prints as "not recorded". Nothing here is inferred.
`;
const SPEC = {
    '--since': 'string',
    '--denied': 'boolean',
    '--corrected': 'boolean',
    '--session': 'string',
    '--tool': 'string',
    '--limit': 'number',
    '--state-dir': 'string',
    '--json': 'boolean',
    '--csv': 'boolean',
    '--help': 'boolean',
    '-h': 'boolean',
};
const DEFAULT_LIMIT = 50;
const LIGHT_COLOR = {
    green: 'green', yellow: 'yellow', orange: 'magenta', red: 'red',
};
/** What a reader sees where a writer recorded nothing. One phrase, used everywhere. */
exports.NOT_RECORDED = 'not recorded';
/** Print a value, or say plainly that it was never recorded. */
function orNotRecorded(value, paint) {
    return value || paint(exports.NOT_RECORDED, 'dim');
}
/**
 * The clause a decision cited, as one citable string.
 *
 * `practices§4: never force-push to a shared branch` is the whole product claim in one column, so
 * the id leads and the text follows it. A record with text but no id still prints the text — a
 * partial citation beats none.
 */
function clauseOf(decision) {
    if (decision.clauseId && decision.clauseText) {
        return `${decision.clauseId}: ${decision.clauseText}`;
    }
    return decision.clauseId || decision.clauseText;
}
function parse(argv, io) {
    const args = (0, args_1.parseFlags)(argv, SPEC);
    if (args.positional.length > 0) {
        throw new args_1.CliError(`log takes no arguments, got "${args.positional[0]}"`);
    }
    if ((0, args_1.flagBool)(args, '--json') && (0, args_1.flagBool)(args, '--csv')) {
        throw new args_1.CliError('--json and --csv cannot be combined');
    }
    const limit = (0, args_1.flagNumber)(args, '--limit') ?? DEFAULT_LIMIT;
    if (limit < 0 || !Number.isInteger(limit)) {
        throw new args_1.CliError('--limit needs a whole number of records (0 for no limit)');
    }
    const filter = {};
    const since = (0, args_1.flagString)(args, '--since');
    if (since !== undefined) {
        filter.since = (0, time_1.parseSince)(since, io.now());
    }
    if ((0, args_1.flagBool)(args, '--denied')) {
        filter.denied = true;
    }
    if ((0, args_1.flagBool)(args, '--corrected')) {
        filter.corrected = true;
    }
    const session = (0, args_1.flagString)(args, '--session');
    if (session !== undefined) {
        filter.sessionId = session;
    }
    const tool = (0, args_1.flagString)(args, '--tool');
    if (tool !== undefined) {
        filter.tool = tool;
    }
    const options = {
        filter, limit, json: (0, args_1.flagBool)(args, '--json'), csv: (0, args_1.flagBool)(args, '--csv'),
    };
    const stateDir = (0, args_1.flagString)(args, '--state-dir');
    if (stateDir !== undefined) {
        options.stateDir = stateDir;
    }
    return options;
}
// ── Plain text ──────────────────────────────────────────────────────────────
function renderText(decisions, io) {
    const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
    if (decisions.length === 0) {
        return '';
    }
    const columns = [
        { header: 'WHEN' },
        { header: 'LIGHT' },
        { header: 'OUTCOME' },
        { header: 'TOOL', max: 16 },
        { header: 'CLAUSE', max: Math.max(20, io.columns - 62) },
        { header: 'ACTOR' },
        { header: 'INPUT' },
    ];
    const rows = decisions.map(d => [
        (0, time_1.shortStamp)(d.at),
        d.light ? paint(d.light, LIGHT_COLOR[d.light] ?? 'gray') : paint(exports.NOT_RECORDED, 'dim'),
        d.outcome === 'unknown' ? paint(exports.NOT_RECORDED, 'dim') : d.outcome,
        orNotRecorded(d.tool, paint),
        orNotRecorded(clauseOf(d), paint),
        orNotRecorded(d.actor, paint),
        d.rewritten ? paint('rewritten', 'yellow') : paint('as written', 'dim'),
    ]);
    return `${(0, render_1.table)(columns, rows, paint)}\n`;
}
// ── CSV ─────────────────────────────────────────────────────────────────────
/** RFC 4180 quoting: quote anything containing a comma, a quote or a newline; double the quotes. */
function csvCell(value) {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
exports.CSV_HEADER = [
    'at', 'session_id', 'session_name', 'host', 'agent', 'tool', 'light', 'outcome', 'actor',
    'clause_id', 'clause_text', 'rewritten', 'latency_ms', 'cost_usd', 'reason',
];
function renderCsv(decisions) {
    const rows = decisions.map(d => [
        d.at.toISOString(), d.sessionId, d.sessionName, d.host, d.agent, d.tool, d.light, d.outcome,
        d.actor, d.clauseId, d.clauseText, String(d.rewritten),
        d.latencyMs === null ? '' : String(d.latencyMs),
        d.costUsd === null ? '' : String(d.costUsd),
        d.reason,
    ]);
    return [exports.CSV_HEADER, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}
function decisionJson(d) {
    return {
        id: d.id,
        from: d.from,
        at: d.at.toISOString(),
        sessionId: d.sessionId,
        sessionName: d.sessionName,
        host: d.host,
        agent: d.agent,
        tool: d.tool,
        light: d.light,
        outcome: d.outcome,
        actor: d.actor,
        clause: d.clauseId || d.clauseText ? { id: d.clauseId, text: d.clauseText } : null,
        rewritten: d.rewritten,
        reason: d.reason,
        latencyMs: d.latencyMs,
        costUsd: d.costUsd,
    };
}
/** The most recent `limit` decisions, still in chronological order. */
function applyLimit(decisions, limit) {
    return limit > 0 ? decisions.slice(-limit) : [...decisions];
}
async function run(argv, io, read = audit_1.readDecisions) {
    const args = (0, args_1.parseFlags)(argv, SPEC);
    if ((0, args_1.flagBool)(args, '--help') || (0, args_1.flagBool)(args, '-h')) {
        io.out(exports.HELP);
        return 0;
    }
    const options = parse(argv, io);
    const state = (0, audit_1.resolveState)(options.stateDir);
    const decisions = applyLimit((0, audit_1.filterDecisions)(await read(state.dir, state.hookTrail), options.filter), options.limit);
    if (options.json) {
        const payload = {
            version: 1,
            generatedAt: io.now().toISOString(),
            stateDir: state.dir,
            hookTrail: state.hookTrail,
            populated: state.populated,
            count: decisions.length,
            decisions: decisions.map(decisionJson),
        };
        io.out(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
    }
    if (options.csv) {
        io.out(renderCsv(decisions));
        return 0;
    }
    if (decisions.length === 0) {
        // Which directory was read matters more than the empty result: an evidence tool that says
        // "nothing" without saying "nothing, here" sends people looking for a bug that is a path.
        const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
        io.out(state.populated
            ? `${paint(`No decisions match, in ${(0, audit_1.readFrom)(state)}.`, 'dim')}\n`
            : `${paint(`No supervision state found. Looked in:\n  ${state.searched.join('\n  ')}\n`
                + 'Point --state-dir at it, or set STATE_DIR.', 'dim')}\n`);
        return 0;
    }
    io.out(renderText(decisions, io));
    const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
    const denied = decisions.filter(audit_1.isDenial).length;
    const corrected = decisions.filter(audit_1.isCorrection).length;
    io.out(paint(`\n${decisions.length} decisions · ${denied} denied · ${corrected} corrected · ${(0, audit_1.readFrom)(state)}\n`, 'dim'));
    return 0;
}
