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

import {
  filterDecisions, isCorrection, isDenial, readDecisions, resolveState, type Decision,
} from './audit';
import { CliError, flagBool, flagString, parseFlags, type FlagSpec } from './args';
import { clauseOf, NOT_RECORDED } from './log';
import { lastEveningSix, parseSince, shortStamp } from './time';
import { colorEnabled, painter, truncate, visibleWidth, type Io, type Paint } from './render';

export const HELP = `session-sitter digest — what your agents did last night, one page per session

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

const SPEC: FlagSpec = {
  '--since': 'string',
  '--session': 'string',
  '--state-dir': 'string',
  '--json': 'boolean',
  '--help': 'boolean',
  '-h': 'boolean',
};

/** One session's page. */
export interface SessionDigest {
  sessionId: string;
  sessionName: string;
  agent: string;
  host: string;
  /** What the session was asked to do; `''` when no record carried it. */
  ask: string;
  decisions: number;
  corrected: number;
  escalated: number;
  denied: number;
  /** Clauses that fired, most-cited first. */
  clauses: Array<{ clause: string; count: number }>;
  firstAt: Date;
  lastAt: Date;
  /** Summed cost, or null when no decision in the window recorded one. */
  costUsd: number | null;
}

/**
 * Group decisions into one page per session.
 *
 * The `ask` is taken from the first record that carries one rather than the last: a session is
 * asked something once, and later records restate it as the agent understood it by then.
 */
export function summarise(decisions: readonly Decision[]): SessionDigest[] {
  const bySession = new Map<string, Decision[]>();
  for (const d of decisions) {
    const list = bySession.get(d.sessionId);
    if (list) { list.push(d); } else { bySession.set(d.sessionId, [d]); }
  }

  const pages: SessionDigest[] = [];
  for (const [sessionId, group] of bySession) {
    const sorted = [...group].sort((a, b) => a.at.getTime() - b.at.getTime());
    const clauses = new Map<string, number>();
    for (const d of sorted) {
      const clause = clauseOf(d);
      if (clause) { clauses.set(clause, (clauses.get(clause) ?? 0) + 1); }
    }
    // Null, not zero: no decision recording a cost is a different fact from a cost of nothing.
    const costs = sorted.map(d => d.costUsd).filter((c): c is number => c !== null);
    pages.push({
      sessionId,
      sessionName: sorted.find(d => d.sessionName)?.sessionName || sessionId,
      agent: sorted.find(d => d.agent)?.agent ?? '',
      host: sorted.find(d => d.host)?.host ?? '',
      ask: sorted.find(d => d.ask)?.ask ?? '',
      decisions: sorted.length,
      corrected: sorted.filter(isCorrection).length,
      escalated: sorted.filter(d => d.outcome === 'escalate' || d.outcome === 'resolved').length,
      denied: sorted.filter(isDenial).length,
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

function field(label: string, value: string, paint: Paint): string {
  return `  ${paint(label.padEnd(LABEL_WIDTH), 'dim')}${value}`;
}

/** A rule that fills the width, with the session name on the left and its origin on the right. */
function heading(page: SessionDigest, width: number, paint: Paint): string {
  const right = [page.agent, page.host].filter(Boolean).join(' · ');
  const name = truncate(page.sessionName, Math.max(12, width - visibleWidth(right) - 8));
  const left = `── ${paint(name, 'bold')} `;
  const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1);
  return `${left}${paint('─'.repeat(fill), 'dim')} ${paint(right, 'dim')}`;
}

export function renderText(
  pages: readonly SessionDigest[], since: Date, io: Io,
): string {
  const paint = painter(colorEnabled(io));
  const width = Math.max(60, Math.min(100, io.columns));
  const now = io.now();
  const totals = pages.reduce((acc, p) => acc + p.decisions, 0);

  const lines = [
    paint(`digest ${shortStamp(since)} → ${shortStamp(now)}`, 'bold'),
    paint(
      `${pages.length} session${pages.length === 1 ? '' : 's'} · ${totals} decision`
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
      ? truncate(page.ask, width - LABEL_WIDTH - 2)
      : paint(NOT_RECORDED, 'dim'), paint));
    lines.push(field('window', paint(
      `${shortStamp(page.firstAt)} → ${shortStamp(page.lastAt)}`, 'dim'), paint));
    lines.push(field('decisions', [
      `${page.decisions}`,
      `${page.corrected} corrected`,
      `${page.escalated} escalated`,
      page.denied > 0 ? paint(`${page.denied} denied`, 'red') : '0 denied',
    ].join(paint(' · ', 'dim')), paint));

    if (page.clauses.length === 0) {
      lines.push(field('clauses', paint('none cited', 'dim'), paint));
    } else {
      for (const [i, entry] of page.clauses.entries()) {
        lines.push(field(i === 0 ? 'clauses' : '', `${
          truncate(entry.clause, width - LABEL_WIDTH - 8)}${
          entry.count > 1 ? paint(` (${entry.count}×)`, 'dim') : ''}`, paint));
      }
    }
    lines.push(field('cost', page.costUsd === null
      ? paint(NOT_RECORDED, 'dim')
      : `$${page.costUsd.toFixed(4)}`, paint));
  }
  return `${lines.join('\n')}\n`;
}

// ── JSON ────────────────────────────────────────────────────────────────────

/**
 * The `--json` contract, version 1.
 *
 * `costUsd` is `null` when nothing in the window recorded a cost, and a number when something did.
 * A consumer must not read `null` as `0`; that distinction is the whole reason the field is
 * nullable rather than defaulted.
 */
export interface DigestJson {
  version: 1;
  generatedAt: string;
  window: { since: string; until: string };
  stateDir: string;
  populated: boolean;
  totals: {
    sessions: number;
    decisions: number;
    corrected: number;
    escalated: number;
    denied: number;
    costUsd: number | null;
  };
  sessions: Array<{
    sessionId: string;
    sessionName: string;
    agent: string;
    host: string;
    ask: string;
    decisions: number;
    corrected: number;
    escalated: number;
    denied: number;
    clauses: Array<{ clause: string; count: number }>;
    firstAt: string;
    lastAt: string;
    costUsd: number | null;
  }>;
}

export function renderJson(
  pages: readonly SessionDigest[], since: Date, until: Date, stateDir: string, populated: boolean,
): DigestJson {
  const costs = pages.map(p => p.costUsd).filter((c): c is number => c !== null);
  return {
    version: 1,
    generatedAt: until.toISOString(),
    window: { since: since.toISOString(), until: until.toISOString() },
    stateDir,
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

// ── Entry point ─────────────────────────────────────────────────────────────

export type ReadDecisions = (stateDir: string) => Promise<Decision[]>;

export async function run(
  argv: readonly string[], io: Io, read: ReadDecisions = readDecisions,
): Promise<number> {
  const args = parseFlags(argv, SPEC);
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(HELP); return 0; }
  if (args.positional.length > 0) {
    throw new CliError(`digest takes no arguments, got "${args.positional[0]}"`);
  }

  const now = io.now();
  const sinceFlag = flagString(args, '--since');
  const since = sinceFlag === undefined ? lastEveningSix(now) : parseSince(sinceFlag, now);
  const state = resolveState(flagString(args, '--state-dir'));

  const filter = { since, ...(flagString(args, '--session') !== undefined
    ? { sessionId: flagString(args, '--session') } : {}) };
  const pages = summarise(filterDecisions(await read(state.dir), filter));

  if (flagBool(args, '--json')) {
    io.out(`${JSON.stringify(
      renderJson(pages, since, now, state.dir, state.populated), null, 2)}\n`);
    return 0;
  }

  io.out(renderText(pages, since, io));
  if (!state.populated) {
    const paint = painter(colorEnabled(io));
    io.out(paint(`\nNo supervision state found. Looked in:\n  ${
      state.searched.join('\n  ')}\n`, 'dim'));
  }
  return 0;
}
