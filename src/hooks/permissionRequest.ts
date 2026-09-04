#!/usr/bin/env node
/**
 * The `PermissionRequest` hook — the governance decision.
 *
 * This event fires only when Claude Code is about to prompt a human, or when it would auto-deny in
 * a session that cannot prompt. Which makes it the one place a policy layer can stand: it answers
 * the prompt, it can *rewrite* the call, and in an unattended session it is the difference between
 * a standing written policy and everything being silently denied.
 *
 * ## The ladder
 *
 * Cheapest and most certain first. The first rung that holds returns.
 *
 *  1. **Deterministic green** — a read-only tool or a safe shell command, via the engine's
 *     `preClassify`. Allow, no I/O beyond the audit append, no model call.
 *  2. **The correction lane** — a correction rule rewrites the call into its safer form. Allow with
 *     `updatedInput`, citing the clause. The rewritten input is re-checked against the written red
 *     clauses before it is returned, so a rewrite can never smuggle a denied call through.
 *  3. **A written red clause** matches. Deny, citing the clause.
 *  4. **A written green clause** matches. Allow, citing the clause. This is what makes an overnight
 *     run survivable: the standing policy that says what the agent may do without asking.
 *  5. **The engine's deterministic red table** (`preClassify` RED). Deny.
 *  6. **The classifier**, with the practices as context — only when explicitly enabled.
 *  7. **Fail closed.** Deny, saying plainly that the supervisor was unreachable.
 *
 * Written clauses are evaluated *before* the engine's built-in red table (rung 5), because the
 * built-in table is the fallback for a team that has written nothing, and a written rule that
 * cannot override a built-in default is not a policy layer. Red clauses are evaluated before green
 * ones regardless of tier: `knowledge.ts` leaves conflict *resolution* to the classifier, but a
 * deterministic matcher has to break the tie somehow, and safety is the only defensible way.
 *
 * ## Contract facts this hook obeys
 *
 *  - **Exit 2 is not honoured for this event.** Only `hookSpecificOutput.decision` decides, so the
 *    hook always prints valid JSON, including when it throws (see `FAIL_CLOSED_*` below).
 *  - `updatedInput` and `updatedPermissions` are **allow-only**; `message` is **deny-only**.
 *  - `permission_suggestions` is echoed back as `updatedPermissions` only for a settled allow, and
 *    only when the operator opted in. Writing permission rules behind someone's back is not ours
 *    to do by default.
 *
 * ## Latency
 *
 * Rungs 1–5 spawn nothing, read no transcript, and touch the filesystem only to read the practices
 * file and append one audit line. Rung 6 is the only rung that can pay for a model, and it is off
 * unless asked for.
 */

import * as fs from 'fs';
import { preClassify, actionLabel, SHELL_TOOLS } from '../supervisor/tiers';
import { TrafficLight } from '../supervisor/models';
import { buildSupervisionPrompt } from '../supervisor/prompt';
import { parseAndValidate } from '../supervisor/schema';
import { buildEngine } from '../supervisor/factory';
import { KnowledgeBundle } from '../supervisor/knowledge';
import {
  Clause, ClauseMatcher, compileMatcher, findMatchingClause, loadPractices, parsePractices,
} from '../policy/practices';
import { CompiledClause, CompiledPolicy, loadPolicy } from '../policy/compile';
import { selectForPolicy } from '../policy/select';
import { splitShellCommand } from '../policy/shell';
import { generalisedPermission } from '../policy/generalise';
import { applyCorrection } from '../policy/corrections';
import { DecisionRecord, appendJsonl, summarizeInput } from '../audit/trail';
import { recordedCall } from '../supervisor/models';
import { decisionsPath } from './paths';
import { HookInput, runHook } from './io';
import { PluginSettings, loadSettings } from './settings';
import { askHuman, buildAsk } from './escalate';
import { health, heartbeatPath, readHeartbeat } from '../daemonHeartbeat';
import {
  PermissionRequestInput,
  haystackFor,
  sessionFromPermissionRequest,
} from './session';

/** The `decision` object Claude Code reads. `message` is deny-only, the rest allow-only. */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}

export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: PermissionDecision;
  };
}

/** What the hook decided, before it is split into wire output and an audit record. */
export interface Verdict {
  decision: PermissionDecision;
  light: string | null;
  clause: string | null;
  actor: DecisionRecord['actor'];
  /**
   * Which rung of the ladder returned this verdict, 1–7.
   *
   * Set where the verdict is built rather than inferred from `actor` and `light` afterwards. The
   * only other consumer is `policy explain`, which has to print it — and inferring it there would
   * make "which rung decided" a second derivation, free to disagree with the ladder it describes.
   */
  rung: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  note: string;
  /** A settled standing answer, so writing a standing permission rule is defensible. */
  settled: boolean;
  /**
   * The written green clause that allowed this call, when one did — the only thing a generalised
   * standing rule may be derived from. Null for a deny, for a correction, for the deterministic
   * tier, for the classifier, and for every compound call.
   */
  allowedBy: Clause | null;
  /**
   * What the model rung cost, when a model ran. Absent on rungs 1–5 and recorded as null there:
   * a rung that calls no model has no cache to hit, and a null must never be read as a miss.
   */
  telemetry?: DecisionRecord['telemetry'];
}

const UNREACHABLE_MESSAGE =
  'Session Sitter denied this call because the supervisor could not reach a verdict, and silence '
  + 'is not approval. Nothing here says the call is unsafe — only that nothing said it was safe. '
  + 'To resolve it: write a practices clause covering this call, enable the classifier '
  + '(SESSION_SITTER_CLASSIFIER=on), or run in observe mode (SESSION_SITTER_MODE=observe) to hand '
  + 'the decision back to Claude Code.';

function out(decision: PermissionDecision): PermissionRequestOutput {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * The output printed when this hook throws. A thrown hook exits non-zero, and a non-zero exit on
 * this event is a *non-blocking error* — the prompt just appears as if no hook ran. That is the
 * fail-open case this product exists to prevent, so the wrapper prints a deny instead.
 */
export function failClosedOutput(reason: string): PermissionRequestOutput {
  return out({ behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(supervisor error: ${reason})` });
}

/**
 * Load the practices. A single file when one is configured, otherwise the three knowledge tiers.
 * A configured-but-unreadable practices file is an error, not an empty policy: silently loading no
 * rules would turn a typo into "everything is ambiguous", and in enforce mode that denies the world
 * for a reason nobody can see.
 */
export async function loadClauses(settings: PluginSettings): Promise<Clause[]> {
  if (settings.practicesFile) {
    const text = await fs.promises.readFile(settings.practicesFile, 'utf8');
    return parsePractices(text, 'project', settings.practicesFile);
  }
  if (!settings.user) { return []; }
  return loadPractices({
    user: settings.user,
    project: settings.project,
    team: settings.team,
    registryPath: settings.supervisor.knowledgeRegistryPath || undefined,
    localRepo: settings.supervisor.knowledgeLocalRepo || undefined,
    knowledgeRepo: settings.supervisor.knowledgeRepo || undefined,
    knowledgeRef: settings.supervisor.knowledgeRef,
  });
}

/**
 * A compiled clause, shaped as the `Clause` every existing consumer already reads.
 *
 * The patterns are recompiled from the text the author wrote, not from a serialised `RegExp`: a
 * substring matcher has been escaped and had its whitespace loosened, so `RegExp.source` could not
 * be turned back into the original. 600 patterns recompile in 0.034 ms, so there is nothing here
 * worth caching.
 */
export function clauseFromCompiled(clause: CompiledClause): Clause {
  return {
    clauseId: clause.id,
    citation: clause.citation,
    kind: clause.kind,
    level: clause.level,
    title: clause.title,
    tier: clause.tier,
    text: clause.body,
    tags: [],
    patterns: clause.patterns
      .map(p => compileMatcher(p.raw))
      .filter((p): p is ClauseMatcher => p !== null),
    sourceFile: clause.source_file,
  };
}

/** What the hook decided to evaluate against, and where it came from. */
export interface PolicyInputs {
  clauses: Clause[];
  /** The artifact, when one was loaded — the selector needs the fields `Clause` drops. */
  compiled: CompiledPolicy | null;
  source: 'artifact' | 'markdown';
  /** Stamped on the decision record. Null on the markdown fallback. */
  rev: string | null;
  /**
   * Why the artifact did not answer, in `loadPolicy`'s own words. Null when it did.
   *
   * Carried rather than discarded because a fallback that cannot say *which* fallback it took is the
   * silent-source problem: `policy explain` prints this, so a degraded answer is visibly degraded.
   */
  reason: string | null;
}

/**
 * Load the policy: the compiled artifact when there is a usable one, the markdown corpus otherwise.
 *
 * Falling back is not fail-open. The corpus is the source of truth, so a tampered artifact that
 * *removed* a red clause is defeated by re-reading the markdown — and the existing rule still holds
 * above this: a configured-but-unreadable source is an error, never an empty policy.
 *
 * Only `accepted` clauses are handed to the deterministic ladder. `audit` clauses are in the
 * artifact so they *can* be matched, but they must not change an outcome.
 *
 * TODO: record their would-be verdicts. `learnedClauses.ts` already has `auditVerdicts()`; wiring it
 * needs `decideOne` replaced by the four-rung `decideByLadder`, which belongs with the governance
 * work rather than here. Until then an audit trial records nothing, and `accept --audit` should say so.
 */
export async function loadPolicyInputs(settings: PluginSettings): Promise<PolicyInputs> {
  if (!settings.practicesFile && settings.user) {
    const { policy, reason } = loadPolicy({
      user: settings.user, project: settings.project ?? '', team: settings.team ?? '',
    });
    if (policy) {
      return {
        clauses: policy.clauses.filter(c => c.status === 'accepted').map(clauseFromCompiled),
        compiled: policy,
        source: 'artifact',
        rev: policy.revision,
        reason: null,
      };
    }
    return {
      clauses: await loadClauses(settings), compiled: null, source: 'markdown', rev: null, reason,
    };
  }
  return {
    clauses: await loadClauses(settings),
    compiled: null,
    source: 'markdown',
    rev: null,
    reason: settings.practicesFile
      ? `a practicesFile is configured (${settings.practicesFile}), so no artifact is consulted`
      : 'no routing user is configured, so no artifact is consulted',
  };
}

/** The clauses, shaped as the bundle the existing prompt builder consumes. */
function bundleFor(
  clauses: Clause[], settings: PluginSettings, policyBlock: string | null = null,
): KnowledgeBundle {
  return {
    policyBlock,
    user: settings.user ?? '',
    project: settings.project ?? '',
    team: settings.team ?? '',
    entries: clauses.map(c => ({
      kind: c.kind,
      title: `${c.title} [${c.citation}]`,
      tier: c.tier,
      text: c.text,
      id: c.clauseId,
      source: null,
      confidence: null,
      scope: c.tier,
      added: null,
      updated: null,
      tags: c.tags,
      level: c.level,
      supersedes: null,
      expires: null,
      sourceFile: c.sourceFile,
    })),
    loadedFiles: [],
    missingFiles: [],
  };
}

/**
 * Tools this layer must never decide for. Both are questions *to the human*, and answering one
 * programmatically is the thing this project has always refused to do (see the design record's
 * out-of-scope section). They are exempted rather than allowed: returning no verdict leaves the
 * question in front of the person it was addressed to.
 *
 * Exempting them is not cosmetic. An `AskUserQuestion` asking "should I force-push?" carries the
 * words `--force` in its own input, so without this the destructive-action matchers deny the
 * *question* as though it were the act — which is how this exemption was found, in a real session.
 */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Everything the constituent commands of ONE call are scanned against: the tool name plus the tool
 * input with `command` replaced by that constituent. Keeping the whole input JSON means a clause
 * whose `Match:` looks at another field still sees it; the only thing that varies is the command.
 */
function constituentHaystack(
  toolName: string, toolInput: Record<string, unknown> | null | undefined, command: string,
): string {
  return haystackFor(toolName, { ...(toolInput ?? {}), command });
}

/**
 * The commands this call actually runs.
 *
 * `commands: null` with no reason means "not a shell call with a command line" — evaluate the input
 * as the single unit it is. `commands: null` **with** a reason means the line could not be split with
 * certainty, and the caller must fail closed rather than evaluate a guess.
 */
interface Constituents {
  commands: string[] | null;
  reason: string | null;
}

export function constituentsOf(
  toolName: string, toolInput: Record<string, unknown> | null | undefined,
): Constituents {
  if (!SHELL_TOOLS.has(toolName)) { return { commands: null, reason: null }; }
  const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
  if (command === null) { return { commands: null, reason: null }; }
  const split = splitShellCommand(command);
  return split.confident
    ? { commands: split.commands, reason: null }
    : { commands: null, reason: split.reason };
}

/** The first written red clause any constituent of this call trips, or null. */
function firstRedClause(
  toolName: string, toolInput: Record<string, unknown> | null | undefined, clauses: Clause[],
): Clause | null {
  const { commands } = constituentsOf(toolName, toolInput);
  if (commands === null) {
    return findMatchingClause(clauses, haystackFor(toolName, toolInput), 'red');
  }
  for (const command of commands) {
    const red = findMatchingClause(clauses, constituentHaystack(toolName, toolInput, command), 'red');
    if (red !== null) { return red; }
  }
  return null;
}

/**
 * Rung 1 — the free path: a read-only tool, or a shell line the engine's deterministic tier vouches
 * for. Factored out because it is checked twice: once against the call exactly as asked (ahead of the
 * correction lane, so a safe read is never "corrected"), and once per constituent of a compound.
 */
function deterministicGreen(
  toolName: string, toolInput: Record<string, unknown> | null | undefined,
): Verdict | null {
  const session = sessionFromPermissionRequest(
    { tool_name: toolName, tool_input: toolInput ?? undefined });
  if (preClassify(session) !== TrafficLight.GREEN) { return null; }
  return {
    decision: { behavior: 'allow' },
    light: TrafficLight.GREEN,
    clause: null,
    actor: 'deterministic',
    rung: 1,
    note: `allowed — read-only or non-mutating (${actionLabel(session)})`,
    settled: true,
    allowedBy: null,
  };
}

/**
 * Rungs 1, 3, 4 and 5 for a SINGLE tool input — no correction lane, which runs once over the whole
 * command line before anything is split. Returns null when this input is ambiguous.
 */
function decideOne(
  toolName: string, toolInput: Record<string, unknown> | null | undefined, clauses: Clause[],
): Verdict | null {
  const session = sessionFromPermissionRequest(
    { tool_name: toolName, tool_input: toolInput ?? undefined });
  const hay = haystackFor(toolName, toolInput);

  // 1. Deterministic green — a read or a safe command.
  const free = deterministicGreen(toolName, toolInput);
  if (free !== null) { return free; }

  // 3. A written red clause.
  const red = findMatchingClause(clauses, hay, 'red');
  if (red) {
    return {
      decision: {
        behavior: 'deny',
        message: `denied — ${red.citation}: ${red.title}`
          + (red.text ? `\n\n${red.text}` : ''),
      },
      light: TrafficLight.RED,
      clause: red.citation,
      actor: 'policy',
      rung: 3,
      note: `denied — ${red.citation}: ${red.title}`,
      settled: false, // a deny is never persisted as a permission rule
      allowedBy: null,
    };
  }

  // 4. A written green clause — the standing policy that makes an overnight run survivable.
  // Deliberately the identity haystack: a green clause must never be satisfied by the bytes a
  // Write happens to contain. See haystackFor.
  const green = findMatchingClause(
    clauses, haystackFor(toolName, toolInput, 'identity-only'), 'green');
  if (green) {
    return {
      decision: { behavior: 'allow' },
      light: TrafficLight.GREEN,
      clause: green.citation,
      actor: 'policy',
      rung: 4,
      note: `allowed — ${green.citation}: ${green.title}`,
      settled: true,
      allowedBy: green,
    };
  }

  // 5. The engine's built-in deterministic red table.
  if (preClassify(session) === TrafficLight.RED) {
    return {
      decision: {
        behavior: 'deny',
        message: 'denied — this matched Session Sitter\'s built-in destructive-action rule '
          + `(${actionLabel(session)}). No written clause covers it; write one to override.`,
      },
      light: TrafficLight.RED,
      clause: null,
      actor: 'deterministic',
      rung: 5,
      note: `denied — built-in destructive-action rule (${actionLabel(session)})`,
      settled: false,
      allowedBy: null,
    };
  }

  return null;
}

/**
 * Combine one verdict per constituent into the verdict for the whole command line.
 *
 * **Deny wins, then ambiguity, then allow** — a compound command is only as safe as its most
 * dangerous part, and "I could not decide about part 3" is not "part 3 is fine". Ambiguity ranking
 * above allow is the property that makes this fail closed: an unrecognised constituent sends the
 * whole line to the classifier or to the denial, never to an approval earned by its siblings.
 *
 * Exported as its own function rather than inlined: any tier that produces a per-constituent verdict
 * needs the same combining rule, and two copies of "which light wins" is two places for them to
 * disagree.
 */
export function combineVerdicts(
  parts: { command: string; verdict: Verdict | null }[],
): Verdict | null {
  // A single constituent is the un-compounded case: hand its verdict back untouched, so a plain
  // call behaves exactly as it did before this evaluator existed (and stays generalisable).
  if (parts.length === 1) { return parts[0].verdict; }

  const n = parts.length;
  const deniedAt = parts.findIndex(p => p.verdict?.decision.behavior === 'deny');
  if (deniedAt >= 0) {
    const { command, verdict } = parts[deniedAt];
    const v = verdict as Verdict;
    const where = `This call runs ${n} commands; sub-command ${deniedAt + 1} of ${n} is the one that `
      + `matched: ${command}`;
    return {
      ...v,
      decision: { behavior: 'deny', message: `${v.decision.message ?? 'denied'}\n\n${where}` },
      note: `${v.note} (sub-command ${deniedAt + 1} of ${n}: ${command})`,
      settled: false,
      allowedBy: null,
    };
  }

  const ambiguousAt = parts.findIndex(p => p.verdict === null);
  if (ambiguousAt >= 0) { return null; }

  const cited = parts.map(p => p.verdict?.clause).filter((c): c is string => !!c);
  return {
    decision: { behavior: 'allow' },
    light: TrafficLight.GREEN,
    clause: cited.length > 0 ? [...new Set(cited)].join(', ') : null,
    actor: cited.length > 0 ? 'policy' : 'deterministic',
    // The highest rung any sub-command needed: a line is only as cheaply decided as its most
    // expensive part, and reporting rung 1 for `git status && npm test` would hide the clause.
    rung: parts.reduce<number>((hi, p) => Math.max(hi, p.verdict?.rung ?? 1), 1) as Verdict['rung'],
    note: `allowed — all ${n} sub-commands cleared`
      + (cited.length > 0 ? ` (${[...new Set(cited)].join(', ')})` : ''),
    settled: true,
    // A standing rule derived from a compound is exactly the bug this evaluator exists to fix:
    // Claude Code matches rules on a command PREFIX, so a rule taken from `git status && rm -rf /`
    // would license the `rm` to anything starting with `git status`.
    allowedBy: null,
  };
}

/**
 * Rungs 1–5: everything decidable without a model. Returns null when the call is ambiguous.
 *
 * ## Compound commands
 *
 * `Bash(git:*)` does not match `git add . && git commit -m x`, because Claude Code matches on a
 * command prefix (#25441) — and per the community meta-issue #30519 that hole applies to **deny**
 * rules too, so a written deny can be walked past by appending `&& <the denied thing>`. This hook
 * therefore splits the command line (`src/policy/shell.ts`), evaluates **every** command in it, and
 * combines with deny > ambiguous > allow. A line that cannot be split with certainty is ambiguous,
 * never safe.
 */
export function decideDeterministically(
  input: PermissionRequestInput, clauses: Clause[],
): Verdict | null {
  const toolName = input.tool_name ?? '';
  const toolInput = input.tool_input ?? null;

  // 1. The free path, checked before anything else: a call the deterministic tier already vouches
  // for must never be routed through the correction lane. (`git log -f --grep=push` is a real
  // example — safe as asked, and the force-push rewrite's short-flag matcher would happily maul it.)
  const free = deterministicGreen(toolName, toolInput);
  if (free !== null) { return free; }

  // 2. The correction lane runs once, over the whole command line: the rewrites are textual
  // substitutions (`--force` → `--force-with-lease`) that are correct wherever they appear, and
  // splicing a rewritten constituent back into a command line is a class of bug worth not having.
  const correction = applyCorrection(toolName, toolInput);
  if (correction) {
    // Re-check the *rewritten* input — every constituent of it — so a rewrite can never produce a
    // call a written red clause forbids. Only written clauses are re-checked: the engine's built-in
    // table lists `--force-with-lease` as destructive too (correct when a human is watching in the
    // IDE), and re-applying it here would deny the very form this lane exists to produce.
    const blocked = firstRedClause(toolName, correction.updatedInput, clauses);
    if (blocked) {
      return {
        decision: {
          behavior: 'deny',
          message: `denied — ${blocked.citation}: ${blocked.title}. The safer form of this call is `
            + 'still forbidden by that clause, so it was not rewritten.',
        },
        light: TrafficLight.RED,
        clause: blocked.citation,
        // Rung 2, not rung 3. The correction lane decided this, and its rejection — "the safe form
        // is also forbidden" — is the lane's most interesting outcome; `policy` would make it
        // indistinguishable from a plain written red, and so would rung 3.
        actor: 'correction',
        rung: 2,
        note: `correction ${correction.ruleId} was rejected by ${blocked.citation}`,
        settled: false,
        allowedBy: null,
      };
    }
    // A correction rule names the clause it enforces, but the clause only exists if the team
    // actually wrote one with that id. Citing `practices §force-push` at a file that defines no
    // such clause points the reader at nothing — and a citation you cannot follow is worse than
    // an honest admission that this was a shipped default rather than your own rule.
    const cited = clauses.find(c => c.clauseId === correction.clauseId);
    const citation = cited ? cited.citation : `built-in §${correction.ruleId}`;
    return {
      decision: { behavior: 'allow', updatedInput: correction.updatedInput },
      light: TrafficLight.YELLOW,
      clause: citation,
      actor: 'correction',
      rung: 2,
      note: `corrected — ${citation}: ${correction.note}`,
      settled: false, // a rewrite is per-call; it must never become a standing rule
      allowedBy: null, // and it must never become a standing permission rule either
    };
  }

  const { commands, reason } = constituentsOf(toolName, toolInput);
  // Fail closed: a command line this scanner will not vouch for is ambiguous, so it goes to the
  // classifier or to the denial. It never inherits an approval.
  if (commands === null && reason !== null) { return null; }
  if (commands === null) { return decideOne(toolName, toolInput, clauses); }

  return combineVerdicts(commands.map(command => ({
    command,
    verdict: decideOne(toolName, { ...(toolInput ?? {}), command }, clauses),
  })));
}

/**
 * Rung 6: the classifier, with the practices as context. Throws when it cannot produce a verdict.
 *
 * When an artifact was loaded, the knowledge block is *bounded* by selector `v1` instead of dumping
 * every clause: at 200 clauses the unbounded render is ~11.5 k tokens of policy crowding out the
 * transcript it is supposed to reason about, which is a correctness bug rather than a cost line.
 *
 * TODO (PR #37's `fastClassifier`) — the split is already decided, so wire it rather than re-derive
 * it. Two regions, and which half goes where is not interchangeable:
 *
 *  - `policy.compiled.prompt_core` → the **`system` knowledge block**, inside `cache_control` on the
 *    last system block. It is revision-stable, so it belongs in the cached prefix; any byte change
 *    there is *supposed* to invalidate the cache, and the revision is what says one happened.
 *  - `selection.selected` + `selection.subsetLine` → the **trailing user turn**. There is no
 *    trailing-system channel, and nothing after the last breakpoint is cached, so per-call content
 *    costs nothing there. In the `system` block it would invalidate the prefix on every decision.
 *
 * This hook still calls `buildSupervisionPrompt`, which has one knowledge block and no breakpoint,
 * so both halves go in it — no worse than the unbounded dump, and strictly smaller.
 */
async function decideWithClassifier(
  input: PermissionRequestInput, policy: PolicyInputs, settings: PluginSettings,
): Promise<Verdict> {
  const session = sessionFromPermissionRequest(input);
  let clauses = policy.clauses;
  let policyBlock: string | null = null;
  if (policy.compiled) {
    const selection = selectForPolicy(policy.compiled, {
      haystack: haystackFor(input.tool_name ?? '', input.tool_input),
      today: new Date().toISOString().slice(0, 10),
    });
    clauses = selection.selected.map(clauseFromCompiled);
    policyBlock = `${policy.compiled.prompt_core}\n${selection.subsetLine}`;
  }
  const prompt = buildSupervisionPrompt(session, bundleFor(clauses, settings, policyBlock));
  const result = await buildEngine(settings.supervisor).classify(prompt);
  const assessment = parseAndValidate(result.raw);
  const light = assessment.traffic_light as string;
  // Only GREEN is an approval. Yellow, orange and red all mean a human's judgment was wanted, and
  // this hook has no way to ask for it — so they deny, and say what the classifier found.
  const allowed = light === TrafficLight.GREEN;
  return {
    decision: allowed
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: `denied — classifier returned ${light}: ${assessment.summary}` },
    light,
    clause: null,
    actor: 'model',
    rung: 6,
    telemetry: result.telemetry ?? null,
    note: `${allowed ? 'allowed' : 'denied'} — classifier returned ${light}`,
    settled: false, // a model verdict is about this call, not a standing rule
    allowedBy: null,
  };
}

/**
 * Where a call rungs 1–5 could not decide goes next. Determined entirely by two settings.
 *
 * Exported and used by `handle` itself so that `policy explain` — which must say what *would*
 * happen without paying for a model call — reads the routing from the enforcement path rather than
 * re-deriving it from the same two settings and being free to get it wrong.
 */
export type AmbiguousRoute = 'classifier' | 'handed-back' | 'fail-closed';

export function routeAmbiguous(settings: PluginSettings): AmbiguousRoute {
  if (settings.classifierEnabled) { return 'classifier'; }
  return settings.mode === 'observe' ? 'handed-back' : 'fail-closed';
}

/**
 * Ask a human, and turn their answer — or their silence — into a verdict.
 *
 * ## It refuses to wait for something nobody will answer
 *
 * An ask is served by `session-sitter daemon`, which is the only process allowed to read the human
 * channel (a bot token has one destructive update stream, and a hook runs *per prompt* — polling it
 * here would mean an unbounded number of competing readers). So with no live daemon the ask cannot be
 * delivered, and waiting out the deadline would hold the agent still for nothing. It denies at once
 * and says which command to run.
 *
 * A **wedged** daemon is treated the same as none, which is why `health()` distinguishes them: a
 * process that has stopped completing passes cannot serve an ask either, and "the pid exists" is not
 * the question.
 *
 * ## Silence is still never approval
 *
 * No verdict by the deadline is a deny, recorded with `actor: 'timeout'` and a note saying a human was
 * asked and did not answer. Escalation adds a way to say yes; it never adds a way to drift into one.
 */
async function escalateToHuman(args: {
  input: PermissionRequestInput;
  toolName: string;
  why: string;
  waitSeconds: number;
  unsplittable: string | null;
}): Promise<Verdict> {
  const { input, toolName, why, unsplittable } = args;
  const deny = (message: string, note: string): Verdict => ({
    decision: { behavior: 'deny', message },
    light: null, clause: null, actor: 'timeout', rung: 7, note, settled: false, allowedBy: null,
  });

  const beat = await readHeartbeat(heartbeatPath());
  const state = health(beat, Date.now(), pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  if (state !== 'running') {
    const because = state === 'stale'
      ? 'a daemon is running but has stopped completing passes, so it cannot deliver the question'
      : state === 'dead' ? 'the last daemon here has exited'
      : 'no daemon has run here';
    return deny(
      `${UNREACHABLE_MESSAGE}\n\n(escalation: ${because}. Start one with \`session-sitter daemon\`, `
      + 'or turn escalation off with SESSION_SITTER_ESCALATE=off.)',
      `denied — ${why}; escalation unavailable (${state})`);
  }

  const ask = buildAsk({
    sessionId: input.session_id ?? 'unknown',
    cwd: input.cwd ?? '',
    tool: toolName,
    inputSummary: summarizeInput(input.tool_input),
    reason: unsplittable === null ? why : `${why} (shell: ${unsplittable})`,
    now: new Date(),
    waitSeconds: args.waitSeconds,
  });

  const { verdict, waitedMs } = await askHuman({ ask });
  if (verdict === null) {
    return deny(
      'Session Sitter denied this call because a human was asked and did not answer within '
      + `${args.waitSeconds}s, and silence is not approval. Nothing here says the call is unsafe — `
      + 'only that nobody said it was safe.',
      `denied — ${why}; asked a human, no answer in ${Math.round(waitedMs / 1000)}s`);
  }
  if (verdict.decision === 'allow') {
    return {
      decision: { behavior: 'allow', updatedInput: input.tool_input ?? {} },
      light: 'green',
      clause: null,
      actor: 'human',
      rung: 7,
      note: `allowed by ${verdict.by} after ${Math.round(waitedMs / 1000)}s`
        + `${verdict.text ? `: ${verdict.text}` : ''}`,
      // Never settled: one human saying yes once is not a standing rule, and deriving a permission
      // rule from it would turn a single answer into policy nobody wrote.
      settled: false,
      allowedBy: null,
    };
  }
  return deny(
    `Session Sitter denied this call: ${verdict.by} declined it`
    + `${verdict.text ? ` — ${verdict.text}` : '.'}`,
    `denied by ${verdict.by} after ${Math.round(waitedMs / 1000)}s`);
}

export async function handle(
  rawInput: HookInput,
): Promise<PermissionRequestOutput | Record<string, never>> {
  const started = Date.now();
  const input = rawInput as PermissionRequestInput;
  const toolName = input.tool_name ?? '';
  const settings = loadSettings(process.env, input.cwd);

  if (EXEMPT_TOOLS.has(toolName)) {
    appendJsonl(decisionsPath(), {
      ts: new Date().toISOString(),
      sessionId: input.session_id ?? 'unknown',
      cwd: input.cwd ?? '',
      tool: toolName,
      inputSummary: summarizeInput(input.tool_input),
      call: recordedCall(toolName, input.tool_input ?? null),
      light: null,
      decision: 'none',
      clause: null,
      actor: 'human',
      latencyMs: Date.now() - started,
      rewritten: false,
      note: `${toolName} is a question to a human — no verdict returned, so the human answers it`,
      // No policy is loaded for an exempt tool, so there is no revision to name. `none` rather than
      // a null revision on the `markdown` source: nothing was consulted.
      rev: null,
      policySource: 'none',
    } satisfies DecisionRecord);
    return {};
  }

  let policy: PolicyInputs = {
    clauses: [], compiled: null, source: 'markdown', rev: null, reason: null,
  };
  let loadError: string | null = null;
  try {
    policy = await loadPolicyInputs(settings);
  } catch (err) {
    loadError = String(err);
  }

  let verdict = loadError === null ? decideDeterministically(input, policy.clauses) : null;

  // When the reason for ambiguity is that the command line could not be split with certainty, say
  // so — otherwise the fail-closed denial reads as "nothing covered this", which is a different and
  // much less actionable statement.
  const unsplittable = verdict === null
    ? constituentsOf(toolName, input.tool_input ?? null).reason
    : null;

  if (verdict === null && loadError !== null) {
    // The practices could not be read, so rungs 2–4 never ran. Refusing to guess is the point.
    verdict = {
      decision: { behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(practices: ${loadError})` },
      light: null, clause: null, actor: 'timeout', rung: 7,
      note: `denied — practices unreadable: ${loadError}`, settled: false, allowedBy: null,
    };
  }

  if (verdict === null && routeAmbiguous(settings) === 'classifier') {
    try {
      verdict = await decideWithClassifier(input, policy, settings);
    } catch (err) {
      verdict = {
        decision: { behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(classifier: ${String(err)})` },
        light: null, clause: null, actor: 'timeout', rung: 7,
        note: `denied — classifier unreachable: ${String(err)}`, settled: false, allowedBy: null,
      };
    }
  }

  if (verdict === null) {
    if (routeAmbiguous(settings) === 'handed-back') {
      // Observe mode returns no decision at all, which hands the prompt back to Claude Code. It is
      // still recorded, so the trail shows what enforce mode would have denied.
      appendJsonl(decisionsPath(), {
        ts: new Date().toISOString(),
        sessionId: input.session_id ?? 'unknown',
        cwd: input.cwd ?? '',
        tool: toolName,
        inputSummary: summarizeInput(input.tool_input),
        call: recordedCall(toolName, input.tool_input ?? null),
        light: null,
        decision: 'none',
        clause: null,
        actor: 'timeout',
        latencyMs: Date.now() - started,
        rewritten: false,
        note: 'observe mode — no verdict returned; enforce mode would have denied',
        rev: policy.rev,
        policySource: policy.source,
      } satisfies DecisionRecord);
      // An empty object, not a `decision`-less `hookSpecificOutput`: schema-invalid JSON is
      // reported as a hook error in the transcript, and `{}` is unambiguously "no verdict".
      return {};
    }
    const why = unsplittable === null
      ? 'no classifier configured and no written clause applied'
      : `the shell command line could not be split with certainty (${unsplittable}), so no part of `
        + 'it could be evaluated';

    // The last step of rung 7, before it fails closed: ask a human, if one can be reached.
    //
    // Still rung 7, deliberately not a rung 8. This is the last resort, and asking a human *is* the
    // last resort — `actor` is what separates the outcomes (`human` answered, `timeout` did not),
    // and it is already the field that answers "who decided". Renumbering would also have meant
    // rewriting `docs/EVIDENCE.md`, which is a dated record of real decisions; a record edited to
    // suit a later refactor is not a record.
    if (settings.escalate) {
      verdict = await escalateToHuman({
        input, toolName, why, waitSeconds: settings.escalateWaitSeconds, unsplittable,
      });
    } else {
      verdict = {
        decision: {
          behavior: 'deny',
          message: unsplittable === null ? UNREACHABLE_MESSAGE
            : `${UNREACHABLE_MESSAGE}\n\n(shell: ${unsplittable})`,
        },
        light: null, clause: null, actor: 'timeout', rung: 7,
        note: `denied — ${why}`, settled: false,
        allowedBy: null,
      };
    }
  }

  // `updatedPermissions` is allow-only, and only for a decision that is genuinely standing AND was
  // made by a written clause. The dialog's own `permission_suggestions` are deliberately NOT echoed:
  // they carry the literal command string, which is the bug (#6850, #11380) — the rule is derived
  // from the clause instead, and when nothing safe can be derived, nothing is emitted and the prompt
  // comes back. See `src/policy/generalise.ts`.
  if (verdict.decision.behavior === 'allow' && verdict.settled && settings.persistRules
      && verdict.allowedBy !== null) {
    const update = generalisedPermission(
      verdict.allowedBy, toolName, input.tool_input ?? null, settings.ruleDestination);
    if (update !== null) {
      verdict.decision.updatedPermissions = [update];
      verdict.note += ` — standing rule Bash(${update.rules[0].ruleContent}) written to `
        + `${update.destination}, derived from ${verdict.clause}`;
    }
  }

  appendJsonl(decisionsPath(), {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? 'unknown',
    cwd: input.cwd ?? '',
    tool: toolName,
    inputSummary: summarizeInput(input.tool_input),
    call: recordedCall(toolName, input.tool_input ?? null),
    light: verdict.light,
    decision: verdict.decision.behavior,
    clause: verdict.clause,
    actor: verdict.actor,
    latencyMs: Date.now() - started,
    rewritten: verdict.decision.updatedInput !== undefined,
    // Null on every rung that called no model, which is what makes a cache figure computable: a
    // reader filters to non-null and prints that count as its denominator.
    telemetry: verdict.telemetry ?? null,
    note: verdict.note,
    // Every decision names the revision it was evaluated against. Null on the markdown fallback,
    // which is a distinct answer from "before stamping existed" and must stay tellable apart.
    rev: policy.rev,
    policySource: policy.source,
  } satisfies DecisionRecord);

  return out(verdict.decision);
}

if (require.main === module) {
  void runHook(handle, { fallback: (_input, err) => failClosedOutput(String(err)) });
}
