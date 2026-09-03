/**
 * `policy explain` — what would happen if the agent tried this, and which clause decides.
 *
 * ## Why this file contains no policy logic
 *
 * A retrieval surface that evaluates the policy itself is a second evaluator, and two evaluators
 * disagree on the day it matters — which is the day somebody asks "why was this denied?" and the
 * answer they get is not the answer the hook gave. So every question here is answered by calling the
 * enforcement path's own functions:
 *
 *   `loadPolicyInputs`        → the artifact when there is a usable one, the corpus otherwise
 *   `decideDeterministically` → rungs 1–5, verbatim, including the compound-command splitter
 *   `routeAmbiguous`          → where rungs 1–5 send what they could not decide
 *   `selectForPolicy` / `cite`→ the bounded per-call set, and the citation
 *
 * There is nothing left over. The only thing this module adds is a way to render the result and a
 * `--rev` argument, and `--rev` reuses `loadPolicyFile` rather than reading an artifact its own way.
 *
 * ## Why it cannot authorise anything
 *
 * Structurally, not by promise:
 *
 *  - it calls `decideDeterministically`, which is pure, and **never** `handle`, which is the only
 *    function that appends to the decisions trail. This module imports nothing that can write — no
 *    `audit/trail`, no `fs` write call — so there is no code path from a query to a record;
 *  - its output field is `would`, not `behavior`, and it emits no `hookSpecificOutput`. Nothing
 *    downstream can read it as a `PermissionRequest` response even by accident.
 *
 * The hook is the enforcement path. This is a question about it.
 */

import {
  CompiledClause, artifactPath, loadPolicy, loadPolicyFile, policyDir, revisionHex,
} from './compile';
import { CitedClause, cite, clauseIndex, selectForPolicy } from './select';
import { Clause } from './practices';
import {
  PolicyInputs, Verdict, clauseFromCompiled, decideDeterministically, loadPolicyInputs,
  routeAmbiguous,
} from '../hooks/permissionRequest';
import { PluginSettings, loadSettings } from '../hooks/settings';
import { haystackFor } from '../hooks/session';

/** What the caller asked about. A hypothetical call — it is never run. */
export interface ExplainQuery {
  tool: string;
  input: Record<string, unknown> | null;
  /** A revision hex, `sha256:<hex>`, or `current`. Absent means `current.json`. */
  rev?: string | null;
}

export interface ExplainAnswer {
  /**
   * `allow` / `deny` mirror the hook's `behavior`. `ask` is the case the hook returns no verdict
   * for — the classifier rung, or observe mode handing the prompt back.
   *
   * Deliberately not called `behavior`: this object must not be paste-compatible with a hook
   * response, because it is not one.
   */
  would: 'allow' | 'deny' | 'ask';
  rung: number;
  rungLabel: string;
  light: string | null;
  /** The citation exactly as the hook would put it on the record. */
  clause: string | null;
  /** `practices §<id>@<rev7>` when an artifact answered — resolvable against a retained artifact. */
  citation: string | null;
  title: string | null;
  /** The clause body, verbatim from the policy. Never generated here. */
  message: string | null;
  sourceFile: string | null;
  /** The clause's own remediation, when it carries one. */
  fix: { from: string; to: string } | null;
  /** The input as the correction lane would rewrite it, when it would. */
  rewritten: Record<string, unknown> | null;
  note: string;
  policy: {
    /** Which source actually answered. A query that changes source silently is a lie. */
    source: 'artifact' | 'markdown';
    rev: string | null;
    /** Why the artifact did not answer. Null when it did. */
    degraded: string | null;
    /** How many clauses were evaluated. Zero means no policy is loaded. */
    clauses: number;
    /** Wall-clock milliseconds of policy work: load, parse, match, select. No model, no network. */
    elapsedMs: number;
  };
  /** The bounded set the classifier would be handed. Null unless an artifact answered. */
  selection: { matched: string[]; shown: number; subsetLine: string } | null;
}

/** The one place a rung number is turned into words. */
const RUNG_LABELS: Record<number, string> = {
  1: 'deterministic safe — read-only or non-mutating',
  2: 'the correction lane — rewritten into its safer form',
  3: 'written red clause',
  4: 'written green clause',
  5: 'built-in destructive-action rule',
  6: 'the classifier',
  7: 'fail closed',
};

/** Why an explain could not be answered at all. Never thrown — printed, and exited on. */
export class ExplainRefusal extends Error {
  constructor(message: string, readonly exitCode: 1 | 2) { super(message); }
}

/**
 * Load the policy the same way the hook does, or from a named revision.
 *
 * The `--rev` branch deliberately does **not** fall back to `current.json`. A caller who named a
 * revision is asking what that revision said; answering from a different one under its name is the
 * same class of lie as a second evaluator, so a missing or unusable revision refuses instead.
 */
async function inputsFor(
  query: ExplainQuery, settings: PluginSettings,
): Promise<PolicyInputs> {
  const rev = query.rev ?? null;
  if (rev !== null && rev !== 'current') {
    const hex = revisionHex(rev);
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new ExplainRefusal(
        `"${rev}" is not a revision — expected 64 hex characters, or "current"`, 2);
    }
    const file = artifactPath(`sha256:${hex}`);
    const { policy, reason } = loadPolicyFile(file, {
      user: settings.user ?? '', project: settings.project ?? '', team: settings.team ?? '',
    });
    if (policy === null) {
      throw new ExplainRefusal(
        reason === 'absent'
          ? `revision ${hex.slice(0, 8)} is not retained in ${policyDir()} — only the newest `
            + 'artifacts are kept, and nothing was answered from a different revision instead'
          : `revision ${hex.slice(0, 8)} could not be read: ${reason}. Nothing was answered from a `
            + 'different revision instead',
        1);
    }
    return {
      clauses: policy.clauses.filter(c => c.status === 'accepted').map(clauseFromCompiled),
      compiled: policy,
      source: 'artifact',
      rev: policy.revision,
      reason: null,
    };
  }

  try {
    return await loadPolicyInputs(settings);
  } catch (err) {
    // `loadPolicyInputs` throws when the markdown source is configured-but-unreadable, and the hook
    // turns that into a rung-7 deny. An explain must report the *same* verdict — anything else would
    // be the two disagreeing — so this degrades to an empty policy carrying the diagnosis, rather
    // than refusing to answer. The exit code still says something was missing.
    return {
      clauses: [], compiled: null, source: 'markdown', rev: null,
      reason: unreadableReason(settings, err),
    };
  }
}

/**
 * Why nothing could be read, naming both sources when both were tried.
 *
 * The `practicesFile` case gets its own sentence deliberately: it is a configuration error the user
 * fixes in one edit, and telling them "the supervisor failed" about their own typo is the same bug
 * class as a loader that throws where it should degrade.
 */
function unreadableReason(settings: PluginSettings, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (settings.practicesFile) {
    return `your configured practicesFile ${settings.practicesFile} could not be read: ${detail}`;
  }
  // Ask the same loader the hook uses why the artifact did not answer, so the two halves of the
  // failure are both named rather than one hiding the other.
  const artifact = settings.user
    ? loadPolicy({
      user: settings.user, project: settings.project ?? '', team: settings.team ?? '',
    }).reason
    : 'no routing user is configured';
  return `no usable compiled artifact (${artifact}) and the markdown corpus could not be read `
    + `(${detail})`;
}

/** The clause the verdict cited, found in the very set that was evaluated. */
function decidingClause(clauses: readonly Clause[], citation: string | null): Clause | null {
  if (citation === null) { return null; }
  return clauses.find(c => c.citation === citation) ?? null;
}

/** The `@rev7` citation and the clause's `fix`, from the artifact. Null on the markdown fallback. */
function citedFrom(inputs: PolicyInputs, citation: string | null): CitedClause | null {
  if (inputs.compiled === null || citation === null) { return null; }
  const byCitation = new Map<string, CompiledClause>(
    inputs.compiled.clauses.map(c => [c.citation, c]));
  const clause = byCitation.get(citation);
  return clause ? cite(inputs.compiled, clauseIndex(inputs.compiled), clause.id) : null;
}

/**
 * Answer the question. Reads; writes nothing; spawns nothing.
 *
 * The classifier rung is reported, never run: `explain` prices itself as costing no tokens, and a
 * query that quietly bills a model call is a query nobody runs twice.
 */
export async function explainCall(
  query: ExplainQuery, settings: PluginSettings = loadSettings(),
): Promise<ExplainAnswer> {
  const started = process.hrtime.bigint();
  const inputs = await inputsFor(query, settings);
  const verdict: Verdict | null = decideDeterministically(
    { tool_name: query.tool, tool_input: query.input ?? undefined }, inputs.clauses);

  const clause = decidingClause(inputs.clauses, verdict?.clause ?? null);
  const cited = citedFrom(inputs, verdict?.clause ?? null);

  let selection: ExplainAnswer['selection'] = null;
  if (inputs.compiled) {
    const chosen = selectForPolicy(inputs.compiled, {
      haystack: haystackFor(query.tool, query.input),
      today: new Date().toISOString().slice(0, 10),
    });
    selection = {
      matched: chosen.matched,
      shown: chosen.selected.length,
      subsetLine: chosen.subsetLine,
    };
  }

  const policy: ExplainAnswer['policy'] = {
    source: inputs.source,
    rev: inputs.rev,
    degraded: inputs.reason,
    clauses: inputs.clauses.length,
    // Printed so the "no model call" claim is checkable at the point of use rather than believed:
    // load, parse, compile every pattern, match, and select, end to end.
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };

  if (verdict === null) {
    const route = routeAmbiguous(settings);
    const [would, rung, note] = route === 'classifier'
      ? ['ask', 6, 'no written clause and nothing deterministic applies, so this would go to the '
        + 'classifier. Not run here — an explain costs no tokens.'] as const
      : route === 'handed-back'
        ? ['ask', 7, 'observe mode: no verdict is returned, so Claude Code asks you itself. In '
          + 'enforce mode this would be denied at rung 7.'] as const
        : ['deny', 7, 'nothing said this call is safe, and silence is not approval.'] as const;
    return {
      would, rung, rungLabel: RUNG_LABELS[rung], light: null, clause: null, citation: null,
      title: null, message: null, sourceFile: null, fix: null, rewritten: null, note,
      policy, selection,
    };
  }

  return {
    would: verdict.decision.behavior,
    rung: verdict.rung,
    rungLabel: RUNG_LABELS[verdict.rung],
    light: verdict.light,
    clause: verdict.clause,
    citation: cited?.citation ?? null,
    title: clause?.title ?? null,
    message: cited?.message ?? clause?.text ?? null,
    sourceFile: cited?.sourceFile ?? clause?.sourceFile ?? null,
    fix: cited?.fix ?? null,
    rewritten: verdict.decision.updatedInput ?? null,
    note: verdict.note,
    policy,
    selection,
  };
}

// --------------------------------------------------------------------------- rendering

const HEADLINE: Record<ExplainAnswer['would'], string> = {
  allow: 'WOULD ALLOW',
  deny: 'WOULD DENY',
  ask: 'WOULD ASK',
};

export function renderExplain(answer: ExplainAnswer): string {
  const rev = answer.policy.rev === null
    ? 'no artifact'
    : `revision ${revisionHex(answer.policy.rev).slice(0, 8)}`;
  const lines = [
    `${HEADLINE[answer.would]}  ·  rung ${answer.rung} (${answer.rungLabel})  ·  ${rev}`,
  ];

  if (answer.clause !== null) {
    lines.push(`  ${answer.citation ?? answer.clause}`
      + (answer.title ? ` — ${answer.title}` : ''));
    if (answer.message) {
      for (const line of answer.message.trim().split('\n')) { lines.push(`  ${line}`); }
    }
    if (answer.sourceFile) { lines.push(`  ↳ source: ${answer.sourceFile}`); }
    // The ladder's own note, when it says more than the header already did. It carries the two facts
    // the clause body cannot: which sub-command of a compound tripped, and whether a rewrite was
    // attempted and then refused by this very clause. Dropping it was losing the useful half.
    const boilerplate = `${answer.would === 'deny' ? 'denied' : 'allowed'} — ${answer.clause}: `
      + `${answer.title ?? ''}`;
    const extra = answer.note.startsWith(boilerplate)
      ? answer.note.slice(boilerplate.length).trim().replace(/^\((.*)\)$/, '$1')
      : answer.note;
    if (extra !== '') { lines.push(`  ↳ ${extra}`); }
  } else {
    lines.push(`  ${answer.note}`);
  }

  if (answer.rewritten !== null) {
    lines.push('', '  The call would be rewritten to:',
      `  ${JSON.stringify(answer.rewritten)}`,
      '  That rewrite is what the practices already accept; it is not a negotiation.');
  } else if (answer.fix !== null) {
    lines.push('', `  This clause names a fix: ${answer.fix.from}  →  ${answer.fix.to}`);
  }

  lines.push('');
  if (answer.policy.clauses === 0) {
    lines.push('  no policy is loaded, so nothing was consulted and a governed call fails closed at '
      + 'rung 7.'
      + (answer.policy.degraded === null ? '' : `\n  why: ${answer.policy.degraded}`)
      + '\n  fix: compile the corpus (`session-sitter policy compile`), or point '
      + 'SESSION_SITTER_PRACTICES at a practices file.');
  } else if (answer.policy.degraded !== null) {
    lines.push(`  answered from the markdown corpus, not a compiled artifact: `
      + `${answer.policy.degraded}`);
  }
  lines.push(`  ${answer.policy.clauses} clause(s) evaluated from the `
    + `${answer.policy.source === 'artifact' ? 'compiled artifact' : 'markdown corpus'}`);
  lines.push(`  no model call · 0 tokens · ${answer.policy.elapsedMs.toFixed(2)} ms of policy work`);
  lines.push('  this decides nothing — the PermissionRequest hook decides, and it will decide again '
    + 'when the call actually runs.');
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------------- the command

const USAGE = `session-sitter policy explain — what would happen to this call, and which clause decides

Usage:
  policy explain <tool> [--command CMD | --input JSON] [--rev REVISION|current] [--json]

Arguments:
  <tool>          the tool name, e.g. Bash, Write, WebFetch

Options:
  --command CMD   shorthand for --input '{"command":"CMD"}'
  --input JSON    the whole tool input, as a JSON object
  --rev REV       explain against a retained revision instead of the published one
  --json          machine-readable, including which source answered
  -h, --help      show this help

Exit codes: 0 answered · 1 no policy was loaded, or the named revision is gone · 2 bad arguments.
This command never enforces anything and never writes a record.
`;

const FLAGS = ['command', 'input', 'rev', 'json', 'help'] as const;

export interface ExplainIo {
  out(text: string): void;
  err(text: string): void;
}

function valueOf(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) { return null; }
  const value = argv[at + 1];
  if (value === undefined) { throw new ExplainRefusal(`--${name} needs a value`, 2); }
  return value;
}

/** Parse, answer, print. The only function that knows about argv or about exit codes. */
export async function runExplain(
  argv: readonly string[], io: ExplainIo, settings: PluginSettings = loadSettings(),
): Promise<number> {
  try {
    if (argv.includes('-h') || argv.includes('--help')) { io.out(USAGE); return 0; }
    const bad = argv.find(a => a.startsWith('--') && !(FLAGS as readonly string[]).includes(a.slice(2)));
    if (bad !== undefined) {
      throw new ExplainRefusal(`unknown option: ${bad}\n\n${USAGE}`, 2);
    }
    const tool = argv[0];
    if (tool === undefined || tool.startsWith('-')) {
      throw new ExplainRefusal(`explain needs a tool name\n\n${USAGE}`, 2);
    }

    const command = valueOf(argv, 'command');
    const raw = valueOf(argv, 'input');
    if (command !== null && raw !== null) {
      throw new ExplainRefusal('--input and --command are two ways to say the same thing; pass one', 2);
    }
    let input: Record<string, unknown> | null = command === null ? null : { command };
    if (raw !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch (err) {
        throw new ExplainRefusal(
          `--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 2);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ExplainRefusal('--input must be a JSON object of tool arguments', 2);
      }
      input = parsed as Record<string, unknown>;
    }

    const answer = await explainCall({ tool, input, rev: valueOf(argv, 'rev') }, settings);
    io.out(argv.includes('--json')
      ? `${JSON.stringify(answer, null, 2)}\n`
      : renderExplain(answer));
    // Exit 1 with an answer printed, not instead of one: the arguments were fine and the ladder ran,
    // but the thing it needed — a policy — was not there. That is the CLI's existing exit-1 meaning.
    return answer.policy.clauses === 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof ExplainRefusal) {
      io.err(`policy explain: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}
