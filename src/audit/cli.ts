#!/usr/bin/env node
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

import * as fs from 'fs';
import * as path from 'path';
import { DecisionRecord, readJsonl } from './trail';
import { activityPath, decisionsPath, sessionsDir } from '../hooks/paths';

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

interface Args {
  command: 'log' | 'digest' | 'status';
  since: number | null;
  session: string | null;
  denied: boolean;
  corrected: boolean;
  format: 'text' | 'json' | 'csv';
}

/** `30m` / `24h` / `7d` / `90s` → milliseconds. Returns null when it is not a duration. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(raw.trim().toLowerCase());
  if (!m) { return null; }
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]!;
  return Number.parseInt(m[1], 10) * unit;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'log', since: null, session: null, denied: false, corrected: false, format: 'text',
  };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('-')) {
    const cmd = rest.shift()!;
    if (cmd !== 'log' && cmd !== 'digest' && cmd !== 'status') {
      throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
    }
    args.command = cmd;
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) { throw new Error(`${a} needs a value`); }
      return v;
    };
    switch (a) {
      case '--since': {
        const raw = next();
        const ms = parseDuration(raw);
        if (ms === null) { throw new Error(`--since wants a duration like 24h, not ${raw}`); }
        args.since = ms;
        break;
      }
      case '--session': args.session = next(); break;
      case '--denied': args.denied = true; break;
      case '--corrected': args.corrected = true; break;
      case '--json': args.format = 'json'; break;
      case '--csv': args.format = 'csv'; break;
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break;
      default: throw new Error(`unknown option: ${a}\n\n${USAGE}`);
    }
  }
  return args;
}

export function filterRecords(records: DecisionRecord[], args: Args, now = Date.now()): DecisionRecord[] {
  const floor = args.since === null ? null : now - args.since;
  return records.filter(r => {
    if (args.session && r.sessionId !== args.session) { return false; }
    if (args.denied && r.decision !== 'deny') { return false; }
    if (args.corrected && !r.rewritten) { return false; }
    if (floor !== null && Date.parse(r.ts) < floor) { return false; }
    return true;
  });
}

const CSV_COLUMNS = [
  'ts', 'sessionId', 'cwd', 'tool', 'inputSummary', 'light', 'decision', 'clause', 'actor',
  'latencyMs', 'rewritten',
] as const;

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One line per decision, in the shape the product promises: the clause is always visible. */
export function formatLog(records: DecisionRecord[], format: Args['format']): string {
  if (format === 'json') { return `${JSON.stringify(records, null, 2)}\n`; }
  if (format === 'csv') {
    return [
      CSV_COLUMNS.join(','),
      ...records.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(',')),
    ].join('\n') + '\n';
  }
  if (records.length === 0) { return 'no decisions recorded\n'; }
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
export function formatDigest(records: DecisionRecord[]): string {
  if (records.length === 0) { return 'no decisions recorded\n'; }
  const bySession = new Map<string, DecisionRecord[]>();
  for (const r of records) {
    bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  }
  const lines: string[] = [];
  for (const [sessionId, rows] of bySession) {
    const denied = rows.filter(r => r.decision === 'deny');
    const passed = rows.filter(r => r.decision === 'none');
    const corrected = rows.filter(r => r.rewritten);
    const byModel = rows.filter(r => r.actor === 'model').length;
    const clauses = new Map<string, number>();
    for (const r of rows.filter(r => r.clause)) {
      clauses.set(r.clause!, (clauses.get(r.clause!) ?? 0) + 1);
    }
    const latencies = rows.map(r => r.latencyMs).sort((a, b) => a - b);
    lines.push(
      `session ${sessionId}  (${rows[0].cwd || 'unknown cwd'})`,
      `  ${rows.length} decisions — ${rows.length - denied.length - passed.length} allowed, `
      + `${denied.length} denied, ${corrected.length} corrected`
      + (passed.length ? `, ${passed.length} left to the human` : ''),
      `  ${byModel} needed the classifier; median latency ${latencies[Math.floor(latencies.length / 2)]}ms`,
      `  window ${rows[0].ts} → ${rows[rows.length - 1].ts}`,
    );
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
      if (denied.length > 10) { lines.push(`    … and ${denied.length - 10} more`); }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The sessions this plugin registered. Deliberately narrow: it reports what the hooks recorded, not
 * a cross-machine worklist — that reads live agent stores and is not this file's job.
 */
export function formatStatus(dir: string, records: DecisionRecord[]): string {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return 'no sessions registered — is the plugin enabled?\n';
  }
  if (files.length === 0) { return 'no sessions registered — is the plugin enabled?\n'; }
  const lines: string[] = [];
  for (const file of files.sort()) {
    let s: Record<string, unknown>;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const id = String(s.sessionId ?? path.basename(file, '.json'));
    const mine = records.filter(r => r.sessionId === id);
    const state = s.endedAt ? `ended ${String(s.endedAt)}` : 'running';
    lines.push(
      `${id}  ${state}`,
      `  ${String(s.cwd ?? '')}${s.name ? `  “${String(s.name)}”` : ''}`,
      `  ${mine.length} decisions, ${mine.filter(r => r.decision === 'deny').length} denied, `
      + `${mine.filter(r => r.rewritten).length} corrected`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const records = readJsonl<DecisionRecord>(decisionsPath());
  if (args.command === 'status') {
    process.stdout.write(formatStatus(sessionsDir(), records));
    process.stdout.write(`\ntrail: ${decisionsPath()}\nactivity: ${activityPath()}\n`);
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
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
    process.exit(2);
  }
}
