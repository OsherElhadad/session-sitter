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
import { preClassify, actionLabel } from '../supervisor/tiers';
import { TrafficLight } from '../supervisor/models';
import { buildSupervisionPrompt } from '../supervisor/prompt';
import { parseAndValidate } from '../supervisor/schema';
import { buildEngine } from '../supervisor/factory';
import { KnowledgeBundle } from '../supervisor/knowledge';
import {
  Clause, compileMatcher, findMatchingClause, loadPractices, parsePractices,
} from '../policy/practices';
import { CompiledClause, CompiledPolicy, loadPolicy } from '../policy/compile';
import { selectForPolicy } from '../policy/select';
import { applyCorrection } from '../policy/corrections';
import { DecisionRecord, appendJsonl, summarizeInput } from '../audit/trail';
import { recordedCall } from '../supervisor/models';
import { decisionsPath } from './paths';
import { HookInput, runHook } from './io';
import { PluginSettings, loadSettings } from './settings';
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
interface Verdict {
  decision: PermissionDecision;
  light: string | null;
  clause: string | null;
  actor: DecisionRecord['actor'];
  note: string;
  /** A settled standing answer, so echoing `permission_suggestions` back is defensible. */
  settled: boolean;
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
      .filter((p): p is RegExp => p !== null),
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
    const { policy } = loadPolicy({
      user: settings.user, project: settings.project ?? '', team: settings.team ?? '',
    });
    if (policy) {
      return {
        clauses: policy.clauses.filter(c => c.status === 'accepted').map(clauseFromCompiled),
        compiled: policy,
        source: 'artifact',
        rev: policy.revision,
      };
    }
  }
  return { clauses: await loadClauses(settings), compiled: null, source: 'markdown', rev: null };
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

/** Rungs 1–5: everything decidable without a model. Returns null when the call is ambiguous. */
export function decideDeterministically(
  input: PermissionRequestInput, clauses: Clause[],
): Verdict | null {
  const toolName = input.tool_name ?? '';
  const toolInput = input.tool_input ?? null;
  const session = sessionFromPermissionRequest(input);
  const hay = haystackFor(toolName, toolInput);

  // 1. Deterministic green — a read or a safe command.
  if (preClassify(session) === TrafficLight.GREEN) {
    return {
      decision: { behavior: 'allow' },
      light: TrafficLight.GREEN,
      clause: null,
      actor: 'deterministic',
      note: `allowed — read-only or non-mutating (${actionLabel(session)})`,
      settled: true,
    };
  }

  // 2. The correction lane.
  const correction = applyCorrection(toolName, toolInput);
  if (correction) {
    // Re-check the *rewritten* input, so a rewrite can never produce a call a written red clause
    // forbids. Only written clauses are re-checked: the engine's built-in table lists
    // `--force-with-lease` as destructive too (correct when a human is watching in the IDE), and
    // re-applying it here would deny the very form this lane exists to produce.
    const rewrittenHay = haystackFor(toolName, correction.updatedInput);
    const blocked = findMatchingClause(clauses, rewrittenHay, 'red');
    if (blocked) {
      return {
        decision: {
          behavior: 'deny',
          message: `denied — ${blocked.citation}: ${blocked.title}. The safer form of this call is `
            + 'still forbidden by that clause, so it was not rewritten.',
        },
        light: TrafficLight.RED,
        clause: blocked.citation,
        actor: 'policy',
        note: `correction ${correction.ruleId} was rejected by ${blocked.citation}`,
        settled: false,
      };
    }
    return {
      decision: { behavior: 'allow', updatedInput: correction.updatedInput },
      light: TrafficLight.YELLOW,
      clause: `practices §${correction.clauseId}`,
      actor: 'policy',
      note: `corrected — practices §${correction.clauseId}: ${correction.note}`,
      settled: false, // a rewrite is per-call; it must never become a standing rule
    };
  }

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
      note: `denied — ${red.citation}: ${red.title}`,
      settled: false, // a deny is never persisted as a permission rule
    };
  }

  // 4. A written green clause — the standing policy that makes an overnight run survivable.
  const green = findMatchingClause(clauses, hay, 'green');
  if (green) {
    return {
      decision: { behavior: 'allow' },
      light: TrafficLight.GREEN,
      clause: green.citation,
      actor: 'policy',
      note: `allowed — ${green.citation}: ${green.title}`,
      settled: true,
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
      note: `denied — built-in destructive-action rule (${actionLabel(session)})`,
      settled: false,
    };
  }

  return null;
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
 * This base has only `prompt.ts`'s single knowledge block, so both halves go in it — no worse than
 * today's unbounded dump, and strictly smaller.
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
    note: `${allowed ? 'allowed' : 'denied'} — classifier returned ${light}`,
    settled: false, // a model verdict is about this call, not a standing rule
  };
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

  let policy: PolicyInputs = { clauses: [], compiled: null, source: 'markdown', rev: null };
  let loadError: string | null = null;
  try {
    policy = await loadPolicyInputs(settings);
  } catch (err) {
    loadError = String(err);
  }

  let verdict = loadError === null ? decideDeterministically(input, policy.clauses) : null;

  if (verdict === null && loadError !== null) {
    // The practices could not be read, so rungs 2–4 never ran. Refusing to guess is the point.
    verdict = {
      decision: { behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(practices: ${loadError})` },
      light: null, clause: null, actor: 'timeout',
      note: `denied — practices unreadable: ${loadError}`, settled: false,
    };
  }

  if (verdict === null && settings.classifierEnabled) {
    try {
      verdict = await decideWithClassifier(input, policy, settings);
    } catch (err) {
      verdict = {
        decision: { behavior: 'deny', message: `${UNREACHABLE_MESSAGE}\n\n(classifier: ${String(err)})` },
        light: null, clause: null, actor: 'timeout',
        note: `denied — classifier unreachable: ${String(err)}`, settled: false,
      };
    }
  }

  if (verdict === null) {
    if (settings.mode === 'observe') {
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
    verdict = {
      decision: { behavior: 'deny', message: UNREACHABLE_MESSAGE },
      light: null, clause: null, actor: 'timeout',
      note: 'denied — no classifier configured and no written clause applied', settled: false,
    };
  }

  // `updatedPermissions` is allow-only, and only for a decision that is genuinely standing.
  if (verdict.decision.behavior === 'allow' && verdict.settled && settings.persistRules
      && Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0) {
    verdict.decision.updatedPermissions = input.permission_suggestions.map(s => ({
      ...(s as Record<string, unknown>), destination: 'localSettings',
    }));
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
