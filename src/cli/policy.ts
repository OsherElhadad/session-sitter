/**
 * `session-sitter policy check` — lint a practices file, and replay real decisions against it.
 *
 * ## The seam
 *
 * The practices parser lives in `src/policy/` and is built separately. This module deliberately
 * does **not** parse a practices file: a second parser would have to be deleted the day the first
 * one lands, and until then the two would disagree about what a clause is — which is precisely the
 * failure a citable clause exists to prevent.
 *
 * So the contract is stated here as `PolicyModule` and loaded at runtime. When the parser is
 * absent, the command says so and exits 1; it never falls back to a guess. Everything in this file
 * is reading and reporting: which clauses were found, what could not be parsed, and which of the
 * last N real decisions a policy edit would change.
 */

import * as fs from 'fs';
import * as path from 'path';
import { filterDecisions, readDecisions, resolveState, type Decision } from './audit';
import { CliError, flagBool, flagNumber, flagString, parseFlags, type FlagSpec } from './args';
import { clauseOf } from './log';
import { colorEnabled, painter, table, type ColorName, type Io } from './render';
import { runExplain } from '../policy/explain';

// ── The contract with src/policy/ ───────────────────────────────────────────

/** One clause of a practices file, with the id a decision cites it by. */
export interface PolicyClause {
  /** Citable reference, e.g. `practices§4`. Stable across reformatting of the file. */
  id: string;
  /** The clause as written, so a record stays readable after the file has moved on. */
  text: string;
  /** What the clause does when it matches: `green` | `yellow` | `orange` | `red`. */
  light: string;
  /** 1-based line in the source file, for pointing a reader at it. */
  line?: number;
}

/** Something in the file the parser could not turn into a clause. */
export interface PolicyIssue {
  /** 1-based line, or 0 when the problem is the file as a whole. */
  line: number;
  message: string;
  /** The offending source text, when quoting it helps. */
  text?: string;
}

export interface ParsedPolicy {
  /** Where it was read from. */
  path: string;
  clauses: PolicyClause[];
  /** Empty means the whole file parsed. */
  issues: PolicyIssue[];
}

/** One recorded call, handed back to the policy for a second opinion. */
export interface PolicyCall {
  tool: string;
  input?: unknown;
  sessionId?: string;
  agent?: string;
}

/** What the policy would decide about a call now. */
export interface PolicyVerdict {
  outcome: 'allow' | 'deny' | 'correct' | 'escalate';
  /** The clause it applied, or `''` when nothing matched. */
  clauseId: string;
  light?: string;
  /** Present when the verdict is `correct`: the input as it would be rewritten. */
  updatedInput?: unknown;
}

/**
 * What `src/policy/` must export for this command to work.
 *
 * `evaluate` is optional because linting is useful without it — `--replay` is the only thing that
 * needs a decision function, and it says so rather than failing the whole command.
 */
export interface PolicyModule {
  parsePractices(source: string, filePath: string): ParsedPolicy | Promise<ParsedPolicy>;
  evaluate?(policy: ParsedPolicy, call: PolicyCall): PolicyVerdict;
}

/** Where the parser is expected to live, relative to this module in `out/`. */
const POLICY_MODULE = '../policy';

/**
 * Load the parser, or return why it could not be loaded.
 *
 * A variable path on purpose: a static import would make this file fail to compile until the parser
 * exists, which would couple two independently built pieces at build time for no benefit at run
 * time.
 */
export function loadPolicyModule(specifier: string = POLICY_MODULE): PolicyModule | string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(specifier) as Partial<PolicyModule>;
    if (typeof mod.parsePractices !== 'function') {
      return `${specifier} does not export parsePractices(source, path)`;
    }
    return mod as PolicyModule;
  } catch (err) {
    return `the practices parser is not installed (${specifier}): ${
      err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Finding the practices file ──────────────────────────────────────────────

/** Where a practices file conventionally lives, in the order they are tried. */
export const PRACTICES_CANDIDATES = [
  'PRACTICES.md',
  'practices.md',
  path.join('docs', 'PRACTICES.md'),
  path.join('.claude', 'PRACTICES.md'),
];

export function findPracticesFile(cwd: string, exists = fs.existsSync): string | undefined {
  for (const candidate of PRACTICES_CANDIDATES) {
    const full = path.join(cwd, candidate);
    if (exists(full)) { return full; }
  }
  return undefined;
}

// ── The command ─────────────────────────────────────────────────────────────

export const HELP = `session-sitter policy — lint a practices file, or ask what it would decide

Usage:
  session-sitter policy check [PATH] [options]
  session-sitter policy explain <tool> [--command CMD | --input JSON] [--rev REV] [--json]

Arguments:
  PATH              the practices file. Defaults to the first of
                    ${PRACTICES_CANDIDATES.join(', ')} that exists.

Options:
  --replay N        re-decide the last N real decisions against this policy and report which
                    would change, so an edit can be reviewed before it ships
  --state-dir PATH  read this state dir for --replay instead of searching for one
  --json            machine-readable output (see docs/CLI.md for the contract)
  -h, --help        show this help

Exit codes: 0 the file parsed · 1 it did not parse, or the parser is not installed · 2 bad arguments
`;

const SPEC: FlagSpec = {
  '--replay': 'number',
  '--state-dir': 'string',
  '--json': 'boolean',
  '--help': 'boolean',
  '-h': 'boolean',
};

const LIGHT_COLOR: Readonly<Record<string, ColorName>> = {
  green: 'green', yellow: 'yellow', orange: 'magenta', red: 'red',
};

/** One decision whose outcome a policy edit would change. */
export interface ReplayChange {
  decision: Decision;
  was: string;
  now: string;
  clauseId: string;
}

export interface ReplayResult {
  considered: number;
  /** Decisions that carried no tool input, so there was nothing to re-decide. */
  skipped: number;
  changes: ReplayChange[];
}

/**
 * Re-decide recorded calls against a parsed policy.
 *
 * A decision with no recorded input is **skipped and counted**, never treated as unchanged: a
 * replay that quietly ignores half the trail reports a reassuring number about the wrong half.
 */
export function replay(
  policy: ParsedPolicy, decisions: readonly Decision[], evaluate: NonNullable<PolicyModule['evaluate']>,
): ReplayResult {
  const result: ReplayResult = { considered: 0, skipped: 0, changes: [] };
  for (const decision of decisions) {
    if (decision.input === undefined || !decision.tool) { result.skipped += 1; continue; }
    result.considered += 1;
    const verdict = evaluate(policy, {
      tool: decision.tool,
      input: decision.input,
      sessionId: decision.sessionId,
      agent: decision.agent,
    });
    if (verdict.outcome !== decision.outcome) {
      result.changes.push({
        decision, was: decision.outcome, now: verdict.outcome, clauseId: verdict.clauseId,
      });
    }
  }
  return result;
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * The `--json` contract, version 1.
 *
 * `ok` is the single field a CI step should branch on: true when every clause parsed. `replay` is
 * `null` when `--replay` was not asked for, and carries `skipped` so a consumer can see how much of
 * the trail could not be re-decided.
 */
export interface PolicyJson {
  version: 1;
  generatedAt: string;
  path: string;
  ok: boolean;
  clauses: PolicyClause[];
  issues: PolicyIssue[];
  replay: {
    considered: number;
    skipped: number;
    changed: number;
    changes: Array<{ id: string; at: string; tool: string; was: string; now: string; clauseId: string }>;
  } | null;
}

function renderText(
  policy: ParsedPolicy, replayed: ReplayResult | null, io: Io,
): string {
  const paint = painter(colorEnabled(io));
  const lines = [
    paint(`${policy.path}`, 'bold'),
    paint(`${policy.clauses.length} clause${policy.clauses.length === 1 ? '' : 's'} · ${
      policy.issues.length} unparseable`, 'dim'),
    '',
  ];

  if (policy.clauses.length > 0) {
    lines.push(table(
      [{ header: 'ID' }, { header: 'LIGHT' }, { header: 'LINE', right: true },
        { header: 'CLAUSE', max: Math.max(24, io.columns - 26) }],
      policy.clauses.map(c => [
        c.id,
        paint(c.light, LIGHT_COLOR[c.light] ?? 'gray'),
        c.line === undefined ? '' : String(c.line),
        c.text,
      ]),
      paint));
  }

  if (policy.issues.length > 0) {
    lines.push('', paint('Could not parse:', 'red'));
    for (const issue of policy.issues) {
      const where = issue.line > 0 ? `${policy.path}:${issue.line}` : policy.path;
      lines.push(`  ${paint(where, 'dim')} ${issue.message}${
        issue.text ? paint(`  — ${issue.text}`, 'dim') : ''}`);
    }
  }

  if (replayed) {
    lines.push('', paint(
      `replay: ${replayed.considered} decisions re-decided · ${replayed.changes.length} would change`
      + `${replayed.skipped > 0 ? ` · ${replayed.skipped} had no recorded input` : ''}`, 'bold'));
    for (const change of replayed.changes) {
      lines.push(`  ${change.decision.tool || '(no tool)'}: ${
        paint(change.was, 'yellow')} → ${paint(change.now, 'green')}${
        change.clauseId ? paint(` (${change.clauseId})`, 'dim') : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export type ReadDecisions = (stateDir: string, hookTrail?: string | null) => Promise<Decision[]>;

export interface PolicyDeps {
  load?: (specifier?: string) => PolicyModule | string;
  read?: ReadDecisions;
  cwd?: string;
}

export async function run(
  argv: readonly string[], io: Io, deps: PolicyDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === '-h' || subcommand === '--help' || subcommand === undefined) {
    io.out(HELP);
    return subcommand === undefined ? 2 : 0;
  }
  // `explain` is the query surface, and it is deliberately not implemented here: it must call the
  // enforcement path's own evaluator, which is exactly what this module refuses to duplicate for
  // `check`. So it is forwarded, unparsed, to the one implementation.
  if (subcommand === 'explain') {
    return runExplain(rest, { out: io.out, err: io.err });
  }
  if (subcommand !== 'check') {
    throw new CliError(
      `unknown policy subcommand "${subcommand}" — the two are "check" and "explain"`);
  }

  const args = parseFlags(rest, SPEC);
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(HELP); return 0; }
  if (args.positional.length > 1) {
    throw new CliError(`policy check takes one path, got "${args.positional.join('", "')}"`);
  }

  const cwd = deps.cwd ?? process.cwd();
  const filePath = args.positional[0] ?? findPracticesFile(cwd);
  if (filePath === undefined) {
    throw new CliError(
      `no practices file found in ${cwd} — looked for ${PRACTICES_CANDIDATES.join(', ')}; `
      + 'pass one as an argument');
  }

  let source: string;
  try {
    source = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`, 1);
  }

  const loaded = (deps.load ?? loadPolicyModule)();
  if (typeof loaded === 'string') {
    // Exit 1, not 2: the arguments were fine, the tool is incomplete. Saying which is the
    // difference between "you typed it wrong" and "this build cannot answer that".
    throw new CliError(`${loaded}\nUntil it is, policy check cannot parse a practices file.`, 1);
  }

  const policy = await loaded.parsePractices(source, filePath);

  const replayCount = flagNumber(args, '--replay');
  let replayed: ReplayResult | null = null;
  if (replayCount !== undefined) {
    if (replayCount <= 0 || !Number.isInteger(replayCount)) {
      throw new CliError('--replay needs a positive whole number of decisions');
    }
    if (!loaded.evaluate) {
      throw new CliError(
        `${POLICY_MODULE} exports no evaluate(policy, call), so --replay cannot re-decide anything`,
        1);
    }
    const state = resolveState(flagString(args, '--state-dir'), cwd);
    const read = deps.read ?? readDecisions;
    const recent = filterDecisions(await read(state.dir, state.hookTrail), {}).slice(-replayCount);
    replayed = replay(policy, recent, loaded.evaluate);
  }

  if (flagBool(args, '--json')) {
    const payload: PolicyJson = {
      version: 1,
      generatedAt: io.now().toISOString(),
      path: policy.path,
      ok: policy.issues.length === 0,
      clauses: policy.clauses,
      issues: policy.issues,
      replay: replayed === null ? null : {
        considered: replayed.considered,
        skipped: replayed.skipped,
        changed: replayed.changes.length,
        changes: replayed.changes.map(c => ({
          id: c.decision.id,
          at: c.decision.at.toISOString(),
          tool: c.decision.tool,
          was: c.was,
          now: c.now,
          clauseId: c.clauseId,
        })),
      },
    };
    io.out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.out(renderText(policy, replayed, io));
  }
  // A file that did not fully parse is a failed lint, whatever else the run reported.
  return policy.issues.length === 0 ? 0 : 1;
}

/** Re-exported so `digest` and `log` share one idea of how a clause is written out. */
export { clauseOf };
