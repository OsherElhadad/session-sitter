#!/usr/bin/env node
/**
 * Lint a practices file, and replay real decisions against it.
 *
 *     node out/policy/cli.js check <practices.md>
 *     node out/policy/cli.js check <practices.md> --replay [--limit 50]
 *
 * `check` answers the question a practices file cannot answer for itself: **which of my clauses can
 * actually deny anything?** A clause with no `Match:` line is still context for the classifier, but
 * it can never make a deterministic decision — and a red clause somebody believed was enforcing
 * something is the most expensive kind of quiet failure this design has.
 *
 * `--replay` runs the last N recorded decisions back through the deterministic ladder with *this*
 * file's clauses, and prints where the verdict would change. That is how you ship a policy change
 * without discovering its blast radius in production.
 */

import * as fs from 'fs';
import { Clause, parsePractices } from './practices';
import { CORRECTION_RULES } from './corrections';
import { DecisionRecord, readJsonl } from '../audit/trail';
import { decisionsPath } from '../hooks/paths';
import { decideDeterministically } from '../hooks/permissionRequest';

const USAGE = `session-sitter policy — lint a practices file

Usage:
  check <practices.md> [--replay] [--limit N]

Options:
  --replay        re-decide the recorded decisions with this file's clauses
  --limit N       how many recorded decisions to replay (default 50)
  -h, --help      show this help
`;

export interface Finding {
  level: 'error' | 'warn' | 'info';
  message: string;
}

/**
 * Lint the clauses. Errors are things that make the file lie about what it enforces; warnings are
 * things that are probably a mistake but might be deliberate.
 */
export function lint(clauses: Clause[]): Finding[] {
  const findings: Finding[] = [];
  if (clauses.length === 0) {
    findings.push({ level: 'error', message: 'no clauses found — is this a bottom-line.md file?' });
    return findings;
  }

  const seen = new Map<string, number>();
  for (const clause of clauses) {
    seen.set(clause.clauseId, (seen.get(clause.clauseId) ?? 0) + 1);
    if (clause.level === null) {
      findings.push({
        level: 'warn',
        message: `${clause.citation}: no level — it will never deny or allow deterministically. `
          + 'Add `| level | red |` (or green) to the metadata table.',
      });
    } else if ((clause.level === 'red' || clause.level === 'green') && clause.patterns.length === 0) {
      findings.push({
        level: 'error',
        message: `${clause.citation}: level ${clause.level} but no \`Match:\` line, so it cannot `
          + 'match a tool call. It reaches the classifier as prose only.',
      });
    }
    if (!clause.text.trim()) {
      findings.push({
        level: 'warn',
        message: `${clause.citation}: no body — a denial message citing this clause will say only `
          + 'its title.',
      });
    }
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      findings.push({
        level: 'warn',
        message: `clause id "${id}" appears ${count} times — a citation will be ambiguous. `
          + 'Give each clause its own `id`.',
      });
    }
  }

  // A correction rule cites a clause id. If the file has no such clause the rewrite still happens,
  // but the citation names nothing a reader can look up.
  const ids = new Set(clauses.map(c => c.clauseId));
  for (const rule of CORRECTION_RULES) {
    if (!ids.has(rule.clauseId)) {
      findings.push({
        level: 'info',
        message: `correction rule "${rule.ruleId}" cites practices §${rule.clauseId}, which this `
          + 'file does not define. The rewrite still applies; the citation just points nowhere.',
      });
    }
  }
  return findings;
}

/** Re-decide a recorded decision with a candidate set of clauses. */
export function replay(records: DecisionRecord[], clauses: Clause[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    // The trail stores a redacted *summary*, not the original input — replaying is therefore
    // approximate for a Bash call and honest about it: the summary is the command line, which is
    // what every deterministic rule reads anyway.
    const verdict = decideDeterministically(
      { tool_name: record.tool, tool_input: { command: record.inputSummary } }, clauses);
    const now = verdict === null ? 'ambiguous' : verdict.decision.behavior;
    const before = record.decision;
    if (now !== before) {
      lines.push(`  ${before} → ${now}   ${record.tool}: ${record.inputSummary}`
        + (verdict?.clause ? `  [${verdict.clause}]` : ''));
    }
  }
  return lines;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] !== 'check') {
    process.stderr.write(`unknown command: ${argv[0]}\n\n${USAGE}`);
    return 2;
  }
  const file = argv[1];
  if (!file || file.startsWith('-')) {
    process.stderr.write(`check needs a practices file\n\n${USAGE}`);
    return 2;
  }
  const wantReplay = argv.includes('--replay');
  const limitAt = argv.indexOf('--limit');
  const limit = limitAt >= 0 ? Number.parseInt(argv[limitAt + 1] ?? '50', 10) || 50 : 50;

  const clauses = parsePractices(await fs.promises.readFile(file, 'utf8'), 'project', file);
  process.stdout.write(`${file}: ${clauses.length} clauses\n`);
  for (const clause of clauses) {
    process.stdout.write(`  ${(clause.level ?? '—').padEnd(6)} ${clause.citation.padEnd(28)} `
      + `${clause.patterns.length} pattern(s)  ${clause.title}\n`);
  }

  const findings = lint(clauses);
  process.stdout.write('\n');
  for (const f of findings) {
    process.stdout.write(`${f.level}: ${f.message}\n`);
  }
  if (findings.length === 0) { process.stdout.write('no findings\n'); }

  if (wantReplay) {
    const records = readJsonl<DecisionRecord>(decisionsPath()).slice(-limit);
    const changes = replay(records, clauses);
    process.stdout.write(`\nreplayed ${records.length} recorded decisions — `
      + `${changes.length} would change\n`);
    for (const line of changes) { process.stdout.write(`${line}\n`); }
  }

  return findings.some(f => f.level === 'error') ? 1 : 0;
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    err => { process.stderr.write(`${String(err)}\n`); process.exit(2); },
  );
}
