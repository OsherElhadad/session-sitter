// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/digest.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * `session-sitter digest` — what your agents did last night.
 *
 * One page per session, over a window that defaults to 18:00 yesterday, because the question is
 * always asked in the morning about the evening before. This is the output people screenshot, so
 * two properties matter more than features:
 *
 *  - it is **aligned and scannable** — the numbers sit in a column, not in a sentence;
 *  - it is **honest** — a session with no recorded cost says `not recorded`, and a clause nobody
 *    cited is absent rather than zero. A digest that invents a plausible number is worse than no
 *    digest, because someone will forward it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HELP = void 0;
exports.summarise = summarise;
exports.renderText = renderText;
exports.renderJson = renderJson;
exports.run = run;
const audit_1 = require("./audit");
const args_1 = require("./args");
const log_1 = require("./log");
const time_1 = require("./time");
const render_1 = require("./render");
exports.HELP = `session-sitter digest — what your agents did last night, one page per session

Usage:
  session-sitter digest [options]

Options:
  --since WHEN      window start (default: 18:00 yesterday)
                    WHEN is 2h, yesterday, 2026-08-30, or an ISO timestamp
  --session ID      only this session
  --state-dir PATH  read this state dir instead of searching for one
  --json            machine-readable output (see docs/CLI.md for the contract)
  -h, --help        show this help

Anything the writer did not record is reported as "not recorded", never as zero.
`;
const SPEC = {
    '--since': 'string',
    '--session': 'string',
    '--state-dir': 'string',
    '--json': 'boolean',
    '--help': 'boolean',
    '-h': 'boolean',
};
/**
 * Group decisions into one page per session.
 *
 * The `ask` is taken from the first record that carries one rather than the last: a session is
 * asked something once, and later records restate it as the agent understood it by then.
 */
function summarise(decisions) {
    const bySession = new Map();
    for (const d of decisions) {
        const list = bySession.get(d.sessionId);
        if (list) {
            list.push(d);
        }
        else {
            bySession.set(d.sessionId, [d]);
        }
    }
    const pages = [];
    for (const [sessionId, group] of bySession) {
        const sorted = [...group].sort((a, b) => a.at.getTime() - b.at.getTime());
        const clauses = new Map();
        for (const d of sorted) {
            const clause = (0, log_1.clauseOf)(d);
            if (clause) {
                clauses.set(clause, (clauses.get(clause) ?? 0) + 1);
            }
        }
        // Null, not zero: no decision recording a cost is a different fact from a cost of nothing.
        const costs = sorted.map(d => d.costUsd).filter((c) => c !== null);
        pages.push({
            sessionId,
            sessionName: sorted.find(d => d.sessionName)?.sessionName || sessionId,
            agent: sorted.find(d => d.agent)?.agent ?? '',
            host: sorted.find(d => d.host)?.host ?? '',
            ask: sorted.find(d => d.ask)?.ask ?? '',
            decisions: sorted.length,
            corrected: sorted.filter(audit_1.isCorrection).length,
            escalated: sorted.filter(d => d.outcome === 'escalate' || d.outcome === 'resolved').length,
            denied: sorted.filter(audit_1.isDenial).length,
            clauses: [...clauses.entries()]
                .map(([clause, count]) => ({ clause, count }))
                .sort((a, b) => b.count - a.count || a.clause.localeCompare(b.clause)),
            firstAt: sorted[0].at,
            lastAt: sorted[sorted.length - 1].at,
            costUsd: costs.length > 0 ? costs.reduce((a, c) => a + c, 0) : null,
        });
    }
    // Busiest session first: on a morning read, the one that did the most is the one to check.
    pages.sort((a, b) => b.decisions - a.decisions || b.lastAt.getTime() - a.lastAt.getTime());
    return pages;
}
// ── Plain text ──────────────────────────────────────────────────────────────
const LABEL_WIDTH = 10;
function field(label, value, paint) {
    return `  ${paint(label.padEnd(LABEL_WIDTH), 'dim')}${value}`;
}
/** A rule that fills the width, with the session name on the left and its origin on the right. */
function heading(page, width, paint) {
    const right = [page.agent, page.host].filter(Boolean).join(' · ');
    const name = (0, render_1.truncate)(page.sessionName, Math.max(12, width - (0, render_1.visibleWidth)(right) - 8));
    const left = `── ${paint(name, 'bold')} `;
    const fill = Math.max(1, width - (0, render_1.visibleWidth)(left) - (0, render_1.visibleWidth)(right) - 1);
    return `${left}${paint('─'.repeat(fill), 'dim')} ${paint(right, 'dim')}`;
}
function renderText(pages, since, io) {
    const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
    const width = Math.max(60, Math.min(100, io.columns));
    const now = io.now();
    const totals = pages.reduce((acc, p) => acc + p.decisions, 0);
    const lines = [
        paint(`digest ${(0, time_1.shortStamp)(since)} → ${(0, time_1.shortStamp)(now)}`, 'bold'),
        paint(`${pages.length} session${pages.length === 1 ? '' : 's'} · ${totals} decision`
            + `${totals === 1 ? '' : 's'}`, 'dim'),
    ];
    if (pages.length === 0) {
        lines.push('', paint('Nothing was decided in this window.', 'dim'));
        return `${lines.join('\n')}\n`;
    }
    for (const page of pages) {
        lines.push('', heading(page, width, paint));
        lines.push(field('session', paint(page.sessionId, 'dim'), paint));
        lines.push(field('asked', page.ask
            ? (0, render_1.truncate)(page.ask, width - LABEL_WIDTH - 2)
            : paint(log_1.NOT_RECORDED, 'dim'), paint));
        lines.push(field('window', paint(`${(0, time_1.shortStamp)(page.firstAt)} → ${(0, time_1.shortStamp)(page.lastAt)}`, 'dim'), paint));
        lines.push(field('decisions', [
            `${page.decisions}`,
            `${page.corrected} corrected`,
            `${page.escalated} escalated`,
            page.denied > 0 ? paint(`${page.denied} denied`, 'red') : '0 denied',
        ].join(paint(' · ', 'dim')), paint));
        if (page.clauses.length === 0) {
            lines.push(field('clauses', paint('none cited', 'dim'), paint));
        }
        else {
            for (const [i, entry] of page.clauses.entries()) {
                lines.push(field(i === 0 ? 'clauses' : '', `${(0, render_1.truncate)(entry.clause, width - LABEL_WIDTH - 8)}${entry.count > 1 ? paint(` (${entry.count}×)`, 'dim') : ''}`, paint));
            }
        }
        lines.push(field('cost', page.costUsd === null
            ? paint(log_1.NOT_RECORDED, 'dim')
            : `$${page.costUsd.toFixed(4)}`, paint));
    }
    return `${lines.join('\n')}\n`;
}
function renderJson(pages, since, until, stateDir, populated, hookTrail = null) {
    const costs = pages.map(p => p.costUsd).filter((c) => c !== null);
    return {
        version: 1,
        generatedAt: until.toISOString(),
        window: { since: since.toISOString(), until: until.toISOString() },
        stateDir,
        hookTrail,
        populated,
        totals: {
            sessions: pages.length,
            decisions: pages.reduce((a, p) => a + p.decisions, 0),
            corrected: pages.reduce((a, p) => a + p.corrected, 0),
            escalated: pages.reduce((a, p) => a + p.escalated, 0),
            denied: pages.reduce((a, p) => a + p.denied, 0),
            costUsd: costs.length > 0 ? costs.reduce((a, c) => a + c, 0) : null,
        },
        sessions: pages.map(p => ({
            ...p,
            firstAt: p.firstAt.toISOString(),
            lastAt: p.lastAt.toISOString(),
        })),
    };
}
async function run(argv, io, read = audit_1.readDecisions) {
    const args = (0, args_1.parseFlags)(argv, SPEC);
    if ((0, args_1.flagBool)(args, '--help') || (0, args_1.flagBool)(args, '-h')) {
        io.out(exports.HELP);
        return 0;
    }
    if (args.positional.length > 0) {
        throw new args_1.CliError(`digest takes no arguments, got "${args.positional[0]}"`);
    }
    const now = io.now();
    const sinceFlag = (0, args_1.flagString)(args, '--since');
    const since = sinceFlag === undefined ? (0, time_1.lastEveningSix)(now) : (0, time_1.parseSince)(sinceFlag, now);
    const state = (0, audit_1.resolveState)((0, args_1.flagString)(args, '--state-dir'));
    const filter = { since, ...((0, args_1.flagString)(args, '--session') !== undefined
            ? { sessionId: (0, args_1.flagString)(args, '--session') } : {}) };
    const pages = summarise((0, audit_1.filterDecisions)(await read(state.dir, state.hookTrail), filter));
    if ((0, args_1.flagBool)(args, '--json')) {
        io.out(`${JSON.stringify(renderJson(pages, since, now, state.dir, state.populated, state.hookTrail), null, 2)}\n`);
        return 0;
    }
    io.out(renderText(pages, since, io));
    if (!state.populated) {
        const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
        io.out(paint(`\nNo supervision state found. Looked in:\n  ${state.searched.join('\n  ')}\n`, 'dim'));
    }
    return 0;
}
