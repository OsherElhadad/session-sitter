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

import {
  filterDecisions, isCorrection, isDenial, readDecisions, readFrom, resolveState,
  type Decision, type DecisionFilter,
} from './audit';
import { CliError, flagBool, flagNumber, flagString, parseFlags, type FlagSpec } from './args';
import { parseSince, shortStamp } from './time';
import { colorEnabled, painter, table, type ColorName, type Io, type Paint } from './render';

export const HELP = `session-sitter log — the audit trail of supervision decisions

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

const SPEC: FlagSpec = {
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

const LIGHT_COLOR: Readonly<Record<string, ColorName>> = {
  green: 'green', yellow: 'yellow', orange: 'magenta', red: 'red',
};

/** What a reader sees where a writer recorded nothing. One phrase, used everywhere. */
export const NOT_RECORDED = 'not recorded';

/** Print a value, or say plainly that it was never recorded. */
export function orNotRecorded(value: string, paint: Paint): string {
  return value || paint(NOT_RECORDED, 'dim');
}

/**
 * The clause a decision cited, as one citable string.
 *
 * `practices§4: never force-push to a shared branch` is the whole product claim in one column, so
 * the id leads and the text follows it. A record with text but no id still prints the text — a
 * partial citation beats none.
 */
export function clauseOf(decision: Decision): string {
  if (decision.clauseId && decision.clauseText) {
    return `${decision.clauseId}: ${decision.clauseText}`;
  }
  return decision.clauseId || decision.clauseText;
}

interface LogOptions {
  filter: DecisionFilter;
  limit: number;
  stateDir?: string;
  json: boolean;
  csv: boolean;
}

function parse(argv: readonly string[], io: Io): LogOptions {
  const args = parseFlags(argv, SPEC);
  if (args.positional.length > 0) {
    throw new CliError(`log takes no arguments, got "${args.positional[0]}"`);
  }
  if (flagBool(args, '--json') && flagBool(args, '--csv')) {
    throw new CliError('--json and --csv cannot be combined');
  }
  const limit = flagNumber(args, '--limit') ?? DEFAULT_LIMIT;
  if (limit < 0 || !Number.isInteger(limit)) {
    throw new CliError('--limit needs a whole number of records (0 for no limit)');
  }

  const filter: DecisionFilter = {};
  const since = flagString(args, '--since');
  if (since !== undefined) { filter.since = parseSince(since, io.now()); }
  if (flagBool(args, '--denied')) { filter.denied = true; }
  if (flagBool(args, '--corrected')) { filter.corrected = true; }
  const session = flagString(args, '--session');
  if (session !== undefined) { filter.sessionId = session; }
  const tool = flagString(args, '--tool');
  if (tool !== undefined) { filter.tool = tool; }

  const options: LogOptions = {
    filter, limit, json: flagBool(args, '--json'), csv: flagBool(args, '--csv'),
  };
  const stateDir = flagString(args, '--state-dir');
  if (stateDir !== undefined) { options.stateDir = stateDir; }
  return options;
}

// ── Plain text ──────────────────────────────────────────────────────────────

export function renderText(decisions: readonly Decision[], io: Io): string {
  const paint = painter(colorEnabled(io));
  if (decisions.length === 0) { return ''; }

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
    shortStamp(d.at),
    d.light ? paint(d.light, LIGHT_COLOR[d.light] ?? 'gray') : paint(NOT_RECORDED, 'dim'),
    d.outcome === 'unknown' ? paint(NOT_RECORDED, 'dim') : d.outcome,
    orNotRecorded(d.tool, paint),
    orNotRecorded(clauseOf(d), paint),
    orNotRecorded(d.actor, paint),
    d.rewritten ? paint('rewritten', 'yellow') : paint('as written', 'dim'),
  ]);
  return `${table(columns, rows, paint)}\n`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180 quoting: quote anything containing a comma, a quote or a newline; double the quotes. */
export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const CSV_HEADER = [
  'at', 'session_id', 'session_name', 'host', 'agent', 'tool', 'light', 'outcome', 'actor',
  'clause_id', 'clause_text', 'rewritten', 'latency_ms', 'cost_usd', 'reason',
];

export function renderCsv(decisions: readonly Decision[]): string {
  const rows = decisions.map(d => [
    d.at.toISOString(), d.sessionId, d.sessionName, d.host, d.agent, d.tool, d.light, d.outcome,
    d.actor, d.clauseId, d.clauseText, String(d.rewritten),
    d.latencyMs === null ? '' : String(d.latencyMs),
    d.costUsd === null ? '' : String(d.costUsd),
    d.reason,
  ]);
  return [CSV_HEADER, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

// ── JSON ────────────────────────────────────────────────────────────────────

/**
 * The `--json` contract, version 1.
 *
 * A field the writer did not record is `null` or `""` — never omitted and never filled in. A
 * consumer can therefore tell "no clause was cited" from "this reader does not know about clauses",
 * which is exactly the distinction an audit trail is for.
 */
export interface LogJson {
  version: 1;
  generatedAt: string;
  /** The state dir that was read, so a surprising result is traceable to a directory. */
  stateDir: string;
  /**
   * The plugin's `decisions.jsonl`, when it was read — null when it does not exist, or when an
   * explicit `--state-dir` confined the read to one directory.
   *
   * Additive: `stateDir` keeps its meaning, so a consumer written against version 1 before this
   * field existed still reads the same value out of the same key.
   */
  hookTrail: string | null;
  /** True when either store actually holds something a reader can use. */
  populated: boolean;
  count: number;
  decisions: Array<{
    id: string;
    from: 'audit' | 'supervision';
    at: string;
    sessionId: string;
    sessionName: string;
    host: string;
    agent: string;
    tool: string;
    light: string;
    outcome: string;
    actor: string;
    clause: { id: string; text: string } | null;
    rewritten: boolean;
    reason: string;
    latencyMs: number | null;
    costUsd: number | null;
  }>;
}

export function decisionJson(d: Decision): LogJson['decisions'][number] {
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

// ── Entry point ─────────────────────────────────────────────────────────────

/** Injected so tests read a fixture directory rather than a real state dir. */
export type ReadDecisions = (stateDir: string, hookTrail?: string | null) => Promise<Decision[]>;

/** The most recent `limit` decisions, still in chronological order. */
export function applyLimit(decisions: readonly Decision[], limit: number): Decision[] {
  return limit > 0 ? decisions.slice(-limit) : [...decisions];
}

export async function run(
  argv: readonly string[], io: Io, read: ReadDecisions = readDecisions,
): Promise<number> {
  const args = parseFlags(argv, SPEC);
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(HELP); return 0; }

  const options = parse(argv, io);
  const state = resolveState(options.stateDir);
  const decisions = applyLimit(
    filterDecisions(await read(state.dir, state.hookTrail), options.filter), options.limit);

  if (options.json) {
    const payload: LogJson = {
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

  if (options.csv) { io.out(renderCsv(decisions)); return 0; }

  if (decisions.length === 0) {
    // Which directory was read matters more than the empty result: an evidence tool that says
    // "nothing" without saying "nothing, here" sends people looking for a bug that is a path.
    const paint = painter(colorEnabled(io));
    io.out(state.populated
      ? `${paint(`No decisions match, in ${readFrom(state)}.`, 'dim')}\n`
      : `${paint(`No supervision state found. Looked in:\n  ${state.searched.join('\n  ')}\n`
        + 'Point --state-dir at it, or set STATE_DIR.', 'dim')}\n`);
    return 0;
  }

  io.out(renderText(decisions, io));
  const paint = painter(colorEnabled(io));
  const denied = decisions.filter(isDenial).length;
  const corrected = decisions.filter(isCorrection).length;
  io.out(paint(
    `\n${decisions.length} decisions · ${denied} denied · ${corrected} corrected · ${readFrom(state)}\n`,
    'dim'));
  return 0;
}
