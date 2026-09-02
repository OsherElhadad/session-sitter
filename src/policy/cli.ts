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
 *
 *     node out/policy/cli.js compile [--corpus <dir>] [--dry-run]
 *     node out/policy/cli.js ablate
 *
 * `compile` is the write path's last gate. It reads the reviewed corpus and emits the artifact the
 * runtime loads — or emits nothing at all and exits non-zero, naming what is wrong. There is no
 * middle outcome on purpose: a broken corpus must never become live policy, and while it is broken
 * the runtime keeps serving the last good revision.
 *
 * `ablate` asks the question nobody can answer in production: **which of these clauses still matters?**
 * It removes each accepted clause from a clone of the corpus, re-decides the recorded window with the
 * same evaluator, and reports what moves. Zero changes over a meaningful window is a retirement
 * candidate with evidence — which is what makes deletion falsifiable instead of unfalsifiable, and why
 * a rule corpus does not have to only grow. It writes nothing.
 */

import * as fs from 'fs';
import { Clause, parsePractices } from './practices';
import { CORRECTION_RULES } from './corrections';
import { DecisionRecord, readJsonl } from '../audit/trail';
import { decisionsPath } from '../hooks/paths';
import { loadSettings } from '../hooks/settings';
import { clauseFromCompiled } from '../hooks/permissionRequest';
import {
  coreClauses, compilePolicy, currentPath, gatherCorpus, loadPolicy, writePolicy,
} from './compile';
import { replayWindow } from './replay';
import { AblationReport, ablateAll } from './ablate';

const USAGE = `session-sitter policy — lint a practices file, or compile the corpus

Usage:
  check <practices.md> [--replay] [--limit N]
  compile [--corpus DIR] [--user U] [--project P] [--team T] [--registry FILE]
          [--data-dir DIR] [--dry-run]
  ablate [--data-dir DIR] [--decisions N] [--days N]

Options:
  --replay        re-decide the recorded decisions with this file's clauses
  --limit N       how many recorded decisions to replay (default 50)
  --corpus DIR    knowledge checkout to compile (default: the configured local repo)
  --user U        routing triple; each defaults to the configured value
  --project P
  --team T
  --registry FILE registry markdown validating the triple
  --data-dir DIR  where to publish the artifact (default: $SESSION_SITTER_DATA_DIR,
                  else ~/.claude/session-sitter)
  --dry-run       compile and report, write no artifact
  --decisions N   green/yellow ablation window in decisions (default 2000)
  --days N        green/yellow ablation window in days (default 90); the larger wins
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

/**
 * Re-decide the recorded decisions with a candidate set of clauses, and list what would change.
 *
 * Delegates to `src/policy/replay.ts` rather than re-deciding here: that module reuses the very
 * `decideDeterministically` the hook calls, injects a recorded classifier / escalation / clock so
 * nothing reaches a model or the wall clock, and refuses to re-evaluate a record that has no `call`
 * field instead of reconstructing one from the display summary. This function used to do that
 * reconstruction, which made every number it printed approximate for reasons that had nothing to do
 * with the clause under test.
 */
export function replay(records: DecisionRecord[], clauses: Clause[]): string[] {
  const diff = replayWindow(records, clauses, null, { window: records.length });
  const lines = diff.changes.map(c =>
    `  ${c.orig} → ${c.next === 'none' ? 'ambiguous' : c.next}   `
    + `${c.record.tool}: ${c.record.inputSummary}`
    + (c.next_clause ? `  [${c.next_clause}]` : ''));
  if (diff.unreplayable > 0) {
    lines.push(`  (${diff.unreplayable} record(s) have no \`call\` field and could not be `
      + 're-evaluated — excluded, not counted as unchanged)');
  }
  return lines;
}

/** `--flag value`, or null when the flag is absent. */
function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
}

/**
 * Refuse a flag this command does not know.
 *
 * Accepting one and ignoring it is the worst available behaviour for a tool whose entire pitch is
 * not surprising the user: the command looks like it worked, and it wrote somewhere else. That is
 * not hypothetical — `--data-dir` was not a flag, so a compile aimed at a scratch directory silently
 * published into the user's live `~/.claude/session-sitter/`, and cleaning it up needed a `rm -rf`
 * inside a live config tree.
 */
function unknownFlag(argv: string[], known: readonly string[]): string | null {
  return argv.find(a => a.startsWith('--') && !known.includes(a.slice(2))) ?? null;
}

function rejectUnknownFlags(argv: string[], known: readonly string[]): number | null {
  const bad = unknownFlag(argv, known);
  if (bad === null) { return null; }
  process.stderr.write(`unknown option: ${bad}\n\n`
    + `known options: ${known.map(k => `--${k}`).join(', ')}\n\n${USAGE}`);
  return 2;
}

const COMPILE_FLAGS = [
  'corpus', 'user', 'project', 'team', 'registry', 'data-dir', 'dry-run',
] as const;
const CHECK_FLAGS = ['replay', 'limit'] as const;
const ABLATE_FLAGS = ['data-dir', 'decisions', 'days'] as const;

/** Below this the *run* is refused (exit 40), not the corpus. A short window proves nothing. */
export const MIN_ABLATION_WINDOW = 100;

/** One clause's ablation, as a human reads it. Retirement candidates lead with `RETIRE?`. */
export function renderAblation(report: AblationReport): string {
  const head = report.retirement_candidate ? 'RETIRE?' : '       ';
  const lines = [
    `${head} ${(report.level ?? '—').padEnd(6)} ${report.clause_id.padEnd(28)} `
    + `${report.evidence_class}`,
    `        ${report.evidence}`,
  ];
  if (report.note) { lines.push(`        note: ${report.note}`); }
  return lines.join('\n');
}

/**
 * `ablate` — for every accepted clause, what would change if it were not there?
 *
 * Writes no state. A retirement candidate here is *evidence for* a proposal, and governance's
 * `accept` / `displaces` are the only things that move a clause out of service. Reds and oranges are
 * listed with their evidence class and never proposed, because a confident zero on a safety clause
 * launders "I have no evidence" as "I have evidence of nothing".
 */
export async function ablateCommand(argv: string[]): Promise<number> {
  const rejected = rejectUnknownFlags(argv, ABLATE_FLAGS);
  if (rejected !== null) { return rejected; }
  const dataDirFlag = flag(argv, 'data-dir');
  if (dataDirFlag) { process.env.SESSION_SITTER_DATA_DIR = dataDirFlag; }

  const { policy } = loadPolicy();
  if (policy === null) {
    process.stderr.write('ablate needs a compiled artifact — run `policy compile` first\n');
    return 40;
  }
  const corpus = policy.clauses.filter(c => c.status === 'accepted').map(clauseFromCompiled);
  const records = readJsonl<DecisionRecord>(decisionsPath());
  if (records.length < MIN_ABLATION_WINDOW) {
    process.stderr.write(
      `ablate needs at least ${MIN_ABLATION_WINDOW} recorded decisions; the store holds `
      + `${records.length}. This refuses the *run*, not the corpus: a zero over a window this short `
      + 'is not evidence that a clause is dead.\n');
    return 40;
  }

  const reports = ablateAll(corpus, records, {
    decisions: Number.parseInt(flag(argv, 'decisions') ?? '', 10) || undefined,
    days: Number.parseInt(flag(argv, 'days') ?? '', 10) || undefined,
  });
  process.stdout.write(`ablating ${corpus.length} accepted clause(s) against `
    + `${records.length} recorded decision(s)\n\n`);
  for (const report of reports) { process.stdout.write(`${renderAblation(report)}\n`); }
  const candidates = reports.filter(r => r.retirement_candidate);
  process.stdout.write(`\n${candidates.length} retirement candidate(s). `
    + 'Nothing was retired — this run produces evidence, not state.\n');
  return 0;
}

/**
 * Compile the corpus into the artifact, or refuse.
 *
 * Exit 1 with nothing written is the *designed* outcome for a malformed corpus, and the asymmetry
 * against the loader is deliberate: the loader skips a broken file so the rest of the tier survives,
 * because dropping a tier removes reds nobody broke. Here, refusing outright is what keeps a broken
 * proposal from weakening production for even one decision.
 */
export async function compile(argv: string[]): Promise<number> {
  const rejected = rejectUnknownFlags(argv, COMPILE_FLAGS);
  if (rejected !== null) { return rejected; }

  // `dataDir()` reads the environment, so the flag is the front door onto the same mechanism rather
  // than a second one. Set before anything resolves a path.
  const dataDirFlag = flag(argv, 'data-dir');
  if (dataDirFlag) { process.env.SESSION_SITTER_DATA_DIR = dataDirFlag; }

  const settings = loadSettings(process.env);
  const corpus = flag(argv, 'corpus') ?? settings.supervisor.knowledgeLocalRepo;
  const user = flag(argv, 'user') ?? settings.user;
  if (!corpus) {
    process.stderr.write('compile needs a knowledge checkout: --corpus DIR\n');
    return 2;
  }
  if (!user) {
    process.stderr.write('compile needs a routing triple: --user U [--project P] [--team T]\n');
    return 2;
  }

  // Named in an expiry error, so a refused compile can say what is still live.
  const serving = loadPolicy().policy?.revision ?? null;
  const input = await gatherCorpus({
    corpusRoot: corpus,
    user,
    project: flag(argv, 'project') ?? settings.project,
    team: flag(argv, 'team') ?? settings.team,
    registryPath: flag(argv, 'registry') ?? (settings.supervisor.knowledgeRegistryPath || undefined),
  });
  const { policy, errors, warnings } = compilePolicy({ ...input, servingRevision: serving });

  for (const w of warnings) { process.stdout.write(`warn: ${w}\n`); }
  if (policy === null) {
    for (const e of errors) { process.stderr.write(`error: ${e}\n`); }
    process.stderr.write(`\nrefusing to compile: ${errors.length} error(s), no artifact written. `
      + 'The runtime keeps serving the last good revision.\n');
    return 1;
  }

  const core = coreClauses(policy.clauses);
  process.stdout.write(
    `${policy.clauses.length} clauses from ${policy.built_from.length} file(s)\n`
    + `  revision   ${policy.revision}\n`
    + `  corpus_ref ${policy.corpus_ref ?? '(not a git checkout)'}\n`
    + `  core       ${core.length} clause(s), `
    + `${Buffer.byteLength(policy.prompt_core, 'utf8')} bytes\n`);

  if (argv.includes('--dry-run')) {
    process.stdout.write('  (dry run — nothing written)\n');
    return 0;
  }
  const written = writePolicy(policy);
  process.stdout.write(`  wrote      ${written}\n  published  ${currentPath()}\n`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === 'compile') { return compile(argv.slice(1)); }
  if (argv[0] === 'ablate') { return ablateCommand(argv.slice(1)); }
  if (argv[0] !== 'check') {
    process.stderr.write(`unknown command: ${argv[0]}\n\n${USAGE}`);
    return 2;
  }
  const file = argv[1];
  if (!file || file.startsWith('-')) {
    process.stderr.write(`check needs a practices file\n\n${USAGE}`);
    return 2;
  }
  const badFlag = rejectUnknownFlags(argv.slice(2), CHECK_FLAGS);
  if (badFlag !== null) { return badFlag; }
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
