#!/usr/bin/env node
/**
 * The `PreToolUse` hook — the half of the promise `PermissionRequest` cannot keep.
 *
 * `PermissionRequest` fires only when Claude Code was **already going to prompt you**. That is the
 * right place for a governance decision, and it is why the whole ladder lives there. But it means a
 * call Claude Code allows on its own is never offered to this plugin at all, and a written practices
 * clause about it never fires. Proven in a real session under a config that granted nothing:
 * `cat .env` and `Read` on the same file both succeeded, the contents reached the model, and
 * `PermissionRequest` was not invoked once. `PreToolUse` was invoked for both.
 *
 * So this hook exists to close exactly that hole, and nothing more.
 *
 * ## Why this hook must fail OPEN when `PermissionRequest` fails closed
 *
 * `PermissionRequest` stands in front of a prompt the human was about to see, so denying when it
 * cannot reach a verdict costs a prompt. `PreToolUse` fires on **every tool call in the session** —
 * every read, every grep, every write. A hook that denied when it could not reach a verdict would
 * deny the entire session. Inverting the fail direction here is the whole risk of this file, so the
 * contract is deliberately narrow:
 *
 *  - Deny **only** on an explicit matched red clause, or the built-in destructive table.
 *  - In every other case return `{}` — no decision at all. Not `allow`: an `allow` here would
 *    suppress the prompt the human wanted, and `PermissionRequest` would never run. `{}` leaves the
 *    normal flow, `PermissionRequest` included, working exactly as it did before this hook existed.
 *  - Never call a model. No classifier, no escalation, no countdown. This is on the critical path of
 *    every tool call, so it is deterministic-only.
 *  - Any internal error is a no-decision (`runHook` with no `fallback` prints `{}`), never a block.
 *
 * ## Which tools it covers
 *
 * All of them. It matches the same haystack `PermissionRequest` does — `<tool name> <arguments as
 * JSON>` — so one clause forbidding `.env` covers `Bash {"command":"cat .env"}`, `Read`,
 * `Grep`, `Glob`, `NotebookRead`, `Write` and `Edit` without naming any of them. A per-tool
 * allowlist would be a second list to keep in agreement with the clause author's intent, and the
 * hole this hook closes was found precisely because one route was covered and another was not.
 * `AskUserQuestion` and `ExitPlanMode` stay exempt, as they are in `PermissionRequest`: both are
 * questions *to* the human, and matching a clause against the text of a question would deny the
 * asking rather than the act.
 *
 * ## What it deliberately does not do
 *
 * The correction lane. `PreToolUse` has no `updatedInput` — it can only allow, deny or ask — so it
 * cannot rewrite `git push --force` into `git push --force-with-lease`. When a correction rule would
 * fire, this hook returns no decision and leaves the rewrite to `PermissionRequest`, because denying
 * there would break the plugin's best feature to no one's benefit. The consequence is honest and
 * worth naming: a correctable call that Claude Code allows without prompting is still not corrected.
 */

import { preClassify } from '../supervisor/tiers';
import { TrafficLight } from '../supervisor/models';
import { Clause, findMatchingClause } from '../policy/practices';
import { applyCorrection } from '../policy/corrections';
import { DecisionRecord, appendJsonl, summarizeInput } from '../audit/trail';
import { decisionsPath } from './paths';
import { HookInput, runHook } from './io';
import { loadSettings } from './settings';
import { EXEMPT_TOOLS, loadClauses } from './permissionRequest';
import { PermissionRequestInput, haystackFor, sessionFromPermissionRequest } from './session';

/** The `PreToolUse` decision object. Only `deny` is ever produced here. */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/** No decision. The call proceeds into the normal flow, `PermissionRequest` included. */
export type NoDecision = Record<string, never>;

function deny(reason: string): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** A denial, with what the audit trail needs to explain it. */
interface Block {
  reason: string;
  clause: string | null;
  actor: DecisionRecord['actor'];
}

/**
 * The whole decision, minus the I/O. Returns null for "no decision", which is the answer for the
 * overwhelming majority of calls.
 *
 * The rung order matters and mirrors `PermissionRequest`'s: a written clause outranks the built-in
 * table in **both** directions, so a team that wrote `rm -rf ./build` as green keeps it, and does
 * not have it denied here by a default they deliberately overrode.
 */
export function decideBlock(
  input: PermissionRequestInput, clauses: Clause[],
): Block | null {
  const toolName = input.tool_name ?? '';
  const toolInput = input.tool_input ?? null;

  // The correction lane owns this call, and only `PermissionRequest` can rewrite it.
  if (applyCorrection(toolName, toolInput) !== null) { return null; }

  const hay = haystackFor(toolName, toolInput);

  const red = findMatchingClause(clauses, hay, 'red');
  if (red) {
    return {
      reason: `denied — ${red.citation}: ${red.title}`
        + `${red.text ? `\n\n${red.text}` : ''}`,
      clause: red.citation,
      actor: 'policy',
    };
  }

  // A written allowance outranks the built-in table below it.
  if (findMatchingClause(clauses, hay, 'green')) { return null; }

  if (preClassify(sessionFromPermissionRequest(input)) === TrafficLight.RED) {
    return {
      reason: 'denied — this matched Session Sitter\'s built-in destructive-action rule '
        + 'and no written practices clause allowed it.',
      clause: null,
      actor: 'deterministic',
    };
  }

  return null;
}

export async function handle(rawInput: HookInput): Promise<PreToolUseOutput | NoDecision> {
  const started = Date.now();
  const input = rawInput as PermissionRequestInput;
  const toolName = input.tool_name ?? '';
  const settings = loadSettings(process.env, input.cwd);

  if (!settings.preToolUse || EXEMPT_TOOLS.has(toolName)) { return {}; }

  // A practices file that cannot be read is a no-decision here, not a denial: `PermissionRequest`
  // is still behind this hook and still fails closed on the same error.
  let clauses: Clause[] = [];
  try {
    clauses = await loadClauses(settings);
  } catch {
    return {};
  }

  const block = decideBlock(input, clauses);
  // Only a denial is recorded. A record per no-decision would be a record per tool call in the
  // session, which would bury the decisions the trail exists to show — `activity.jsonl`, written by
  // `PostToolUse`, already carries every call.
  if (block === null) { return {}; }

  appendJsonl(decisionsPath(), {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? 'unknown',
    cwd: input.cwd ?? '',
    tool: toolName,
    inputSummary: summarizeInput(input.tool_input),
    light: TrafficLight.RED,
    decision: 'deny',
    clause: block.clause,
    actor: block.actor,
    latencyMs: Date.now() - started,
    rewritten: false,
    note: `${block.reason.split('\n')[0]} (PreToolUse — no prompt would have been shown)`,
  } satisfies DecisionRecord);

  return deny(block.reason);
}

if (require.main === module) {
  // No `fallback`: an exception here must print `{}` and let the call through, never become a block.
  void runHook(handle);
}
