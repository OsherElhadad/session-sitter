/**
 * `session-sitter learn` — sessions in, reviewed practices out.
 *
 * The command that closes the write path. It reads the decision trail, finds the calls that cost
 * somebody work because no written rule covered them, and writes one `status: proposed` clause file
 * per pattern that clears the support bars — for a human to accept, decline, or ignore, in a PR.
 *
 * **No model is called on this path, at all.** Every number in the output is counted or measured:
 * occurrences, distinct sessions, calendar days, and `replay.ts`'s blast radius over the real
 * decisions on disk. `session-sitter learn --json` reports `model.calls: 0` and a test asserts it.
 *
 *     session-sitter learn                 propose from the trail, write proposed clause files
 *     session-sitter learn --dry-run       everything except the writes
 *     session-sitter learn --accumulate    fold new records only (what `SessionEnd` runs)
 *     session-sitter learn --status        the last five run lines from `pipeline.jsonl`
 *     session-sitter learn --quiet         no output; the identical code path, for a scheduler
 *
 * Exit codes follow the rest of the CLI: 0 answered, 1 something it needed was missing or broke,
 * 2 the arguments were wrong — plus 2 when another `learn` holds the lock, which is a statement about
 * the run rather than about the arguments and is the one place the two overlap.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CliError, flagBool, parseFlags, type FlagSpec } from './args';
import { loadSettings } from '../hooks/settings';
import { loadPolicyInputs } from '../hooks/permissionRequest';
import { DecisionRecord, readJsonl } from '../audit/trail';
import { decisionsPath } from '../hooks/paths';
import { ablateAll } from '../policy/ablate';
import { lifetimeCitations } from '../policy/citations';
import { accumulate, propose, recentRuns, type RunLine } from '../policy/pipeline';
import type { Io } from './render';

const FLAGS: FlagSpec = {
  '--accumulate': 'boolean',
  '--dry-run': 'boolean',
  '--status': 'boolean',
  '--quiet': 'boolean',
  '--no-retire': 'boolean',
  '--json': 'boolean',
  '--help': 'boolean',
  '-h': 'boolean',
};

const USAGE = `session-sitter learn — propose practices from the decision trail

Usage:
  session-sitter learn [options]

Options:
  --accumulate   fold new records and stop (what the SessionEnd hook runs)
  --dry-run      run every gate and every replay, write no files
  --status       print the last five pipeline runs
  --no-retire    skip ablation, so no retirement is proposed
  --quiet        print nothing; same code path, for an unattended trigger
  --json         print the run line instead of the summary
  -h, --help     this

Everything it writes is \`status: proposed\` under the corpus's \`learned/\` directories, which is
inert: a proposed clause cannot decide, cannot be matched and cannot reach the prompt. A human
accepts it in a PR, or declines it — and a declined file is never re-proposed.
`;

/**
 * The repo instruction files already in the classifier's context on every call.
 *
 * A clause restating one of these is pure duplicated instruction against a budget the research says
 * collapses, so a candidate that does it is suppressed and counted. The line falls exactly where
 * first-party draws it for itself: `CLAUDE.md` and `.claude/rules/` are repo-resident, git-tracked,
 * human-authored and *already in the prompt*, so reading them is reading the policy we are adding to.
 * The per-project `memory/` directory under `~/.claude` is none of those, and is **never opened** —
 * not here, not anywhere on this path.
 */
export function instructionText(cwd: string): string | undefined {
  const parts: string[] = [];
  const add = (file: string): void => {
    try { parts.push(fs.readFileSync(file, 'utf8')); } catch { /* absent is normal */ }
  };
  add(path.join(cwd, 'CLAUDE.md'));
  const rules = path.join(cwd, '.claude', 'rules');
  try {
    for (const name of fs.readdirSync(rules).sort()) {
      if (name.endsWith('.md')) { add(path.join(rules, name)); }
    }
  } catch { /* no rules directory */ }
  return parts.length === 0 ? undefined : parts.join('\n');
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const args = parseFlags(argv, FLAGS);
  if (args.positional.length > 0) {
    throw new CliError(`learn takes no arguments, got "${args.positional[0]}"`);
  }
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(USAGE); return 0; }

  const json = flagBool(args, '--json');
  const quiet = flagBool(args, '--quiet');
  const say = (text: string): void => { if (!quiet) { io.out(`${text}\n`); } };

  if (flagBool(args, '--status')) {
    const runs = recentRuns(5);
    if (json) { io.out(`${JSON.stringify(runs, null, 2)}\n`); return 0; }
    if (runs.length === 0) {
      say('session-sitter: `learn` has never run — no pipeline.jsonl yet');
      return 0;
    }
    for (const line of runs) { say(statusRow(line)); }
    return 0;
  }

  if (flagBool(args, '--accumulate')) {
    const result = accumulate('cli');
    if (json) { io.out(`${JSON.stringify(result.line, null, 2)}\n`); return 0; }
    say(result.nudge ?? result.line.headline);
    return result.line.exitReason === 'error' ? 1 : 0;
  }

  // Fold first, so `learn` never proposes from a stale aggregate. It is the same offset-driven fold
  // the hook runs, so a session that ended without its hook firing costs nothing here either.
  accumulate('cli');

  const settings = loadSettings();
  const corpusRoot = settings.supervisor.knowledgeLocalRepo;
  if (!corpusRoot) {
    throw new CliError('no corpus checkout configured: set KNOWLEDGE_LOCAL_REPO to the '
      + 'checkout containing `data/knowledge/`. Nothing can be proposed without somewhere to '
      + 'propose it', 1);
  }
  const inputs = await loadPolicyInputs(settings);

  const records = readJsonl<DecisionRecord>(decisionsPath());
  // Ablation measures against the corpus *as it is now*, not against what the trail recorded, and it
  // is the only thing that can say a clause has gone dead. Skippable because it is the slowest part
  // of the run and it proposes nothing that writes a file.
  const ablations = flagBool(args, '--no-retire') || records.length === 0
    ? []
    // `accumulate('cli')` above has just folded the citation counter, so this is the freshest lifetime
    // count available. Without it a clause that fired for months before the last rotation reads as
    // `insufficient-exposure` or `dead-weight?` instead of `deterrent`.
    : ablateAll(inputs.clauses, records, { citations: lifetimeCitations() });

  const { line, written, exitCode } = propose({
    settings,
    corpusRoot,
    corpus: inputs.clauses,
    rev: inputs.rev,
    trigger: 'cli',
    ablations,
    instructionText: instructionText(process.cwd()),
    dryRun: flagBool(args, '--dry-run'),
  });

  if (json) { io.out(`${JSON.stringify(line, null, 2)}\n`); return exitCode; }
  for (const text of summarise(line, written, flagBool(args, '--dry-run'))) { say(text); }
  return exitCode;
}

function statusRow(line: RunLine): string {
  return `${line.ts}  ${line.stage.padEnd(10)} ${line.exitReason.padEnd(28)} ${line.headline}`;
}

/** The report a human reads. Leads with what changed, then with why nothing else did. */
function summarise(line: RunLine, written: readonly string[], dryRun: boolean): string[] {
  const out: string[] = [line.headline, ''];
  if (line.exitReason === 'calibration-failed' || line.exitReason === 'error') {
    out.push(line.error ?? 'the run failed and did not say why, which is itself a bug');
    return out;
  }
  if (line.exitReason === 'lock-held') { return [line.headline]; }

  if (line.proposals.clauses.length === 0) {
    out.push(`Nothing proposed: ${WHY[line.exitReason] ?? line.exitReason}.`);
  }
  for (const clause of line.proposals.clauses) {
    out.push(`+ ${clause.id}`);
    out.push(`    ${clause.tier}/${clause.scope} · ${clause.level} · ${clause.signal} · `
      + `support ${clause.support}`);
  }
  for (const file of written) { out.push(`    wrote ${file}`); }
  if (dryRun && line.proposals.clauses.length > 0) { out.push('    (dry run — nothing written)'); }

  for (const r of line.proposals.retirements) {
    out.push(`− ${r.target} (${r.evidence_class}) — proposed for retirement, no file written`);
  }
  for (const r of line.proposals.redundancies) {
    out.push(`? ${r.target} — redundant with ${r.shadowed_by ?? 'another rung'}: narrow it or `
      + 'delete it');
  }

  const bits: string[] = [];
  if (line.clusters.belowFloor > 0) { bits.push(`${line.clusters.belowFloor} below the floor`); }
  if (line.suppressed.statusGuard > 0) {
    bits.push(`${line.suppressed.statusGuard} suppressed by a human's own decision`);
  }
  if (line.suppressed.alreadyInClaudeMd > 0) {
    bits.push(`${line.suppressed.alreadyInClaudeMd} already stated in a repo instruction file`);
  }
  if (line.suppressed.failedReplay > 0) {
    bits.push(`${line.suppressed.failedReplay} refused by replay`);
  }
  if (line.suppressed.proseOnly > 0) {
    bits.push(`${line.suppressed.proseOnly} with no derivable matcher`);
  }
  if (line.candidates.held > 0) {
    bits.push(`${line.candidates.held} held back by the per-run cap`);
  }
  if (bits.length > 0) { out.push('', `Shapes: ${bits.join(', ')}.`); }
  if (line.window.rotated) {
    out.push('The trail had rotated, so counts are scoped to the window that survives and earlier '
      + 'occurrences may exist.');
  }
  out.push('', `Every proposal is inert until a human accepts it. ${line.model.calls} model call(s).`);
  return out;
}

const WHY: Partial<Record<RunLine['exitReason'], string>> = {
  'no-input': 'nothing has been supervised yet, so there is no trail to mine',
  'no-shape-cleared-floor': 'no repeated pattern cleared the support bars',
  'all-candidates-failed-replay': 'every candidate would have reversed a settled decision',
  'all-candidates-suppressed': 'every candidate was suppressed',
  'caps-hit': 'the per-run cap was reached',
};
