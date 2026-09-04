/**
 * Plugin-side settings, read from the environment.
 *
 * A hook is a bare process with no VS Code settings and no CLI flags, so the environment is the
 * only channel. `SupervisorConfig` (`src/supervisor/config.ts`) already carries everything the
 * classifier and the knowledge loader need, and already layers `.env` files under the process
 * environment — so this module holds only what is specific to running as a Claude Code plugin.
 */

import { SupervisorConfig, loadConfig } from '../supervisor/config';
import { RULE_DESTINATIONS, RuleDestination } from '../policy/generalise';
import { waitSeconds } from './escalate';

/**
 * `enforce` applies the full ladder, including the fail-closed rule: a call that is not
 * deterministically safe and that no written clause covers is **denied** when no classifier answers.
 * That is the product's principle — silence is never approval — and it is the default.
 *
 * `observe` records every decision but returns no verdict for the ambiguous case, handing it back to
 * Claude Code's own prompt (and to Auto mode, if it is on). It exists because the honest
 * consequence of `enforce` with no practices file and no classifier is that every write is denied,
 * and someone evaluating the plugin should be able to watch it before they let it decide.
 */
export type Mode = 'enforce' | 'observe';

export interface PluginSettings {
  mode: Mode;
  /**
   * Whether an ambiguous call may spawn the classifier CLI. Off by default: `PermissionRequest`
   * sits in front of a human-visible prompt, so paying for a subprocess and a model round trip
   * there is a decision the operator makes, not one this plugin makes for them.
   */
  classifierEnabled: boolean;
  /**
   * Whether a settled allow made by a written clause may write a standing permission rule back, via
   * `decision.updatedPermissions`. Off by default — a plugin that silently edits your permission
   * rules is a bad citizen, however convenient.
   */
  persistRules: boolean;
  /**
   * Where such a rule is written. `session` by default: in memory, gone when the session ends. The
   * three file destinations all edit a settings file on disk, and `projectSettings` edits one that
   * is usually git-tracked, so both are opt-in rather than assumed.
   */
  ruleDestination: RuleDestination;
  /**
   * Whether the `PreToolUse` hook enforces red clauses on calls Claude Code never prompts about.
   * **On** by default: without it, a written clause governs only the calls that would have raised a
   * prompt anyway, which is not what "your practices decide" means. It is safe as a default because
   * its only two outcomes are a denial that cites a matched red clause — the same verdict
   * `PermissionRequest` would give the same call — and no decision at all.
   */
  preToolUse: boolean;
  /**
   * Whether rung 7 may ask a human before it fails closed.
   *
   * Off by default, and the default is not timidity: escalation holds the agent still for up to
   * `escalateWaitSeconds`, and it only works when a `session-sitter daemon` is running to serve the
   * ask. Turning it on is a statement that both of those are true.
   */
  escalate: boolean;
  /**
   * How long rung 7 waits for that answer. Capped below the event's own 60s budget, because being
   * killed mid-wait returns no JSON at all — which Claude Code reports as a hook error rather than as
   * a decision, and a governance layer whose failure mode is "no verdict" is not one.
   */
  escalateWaitSeconds: number;
  /** Knowledge-routing triple for the practices tiers. A missing tier is skipped, not an error. */
  user: string | null;
  project: string | null;
  team: string | null;
  /** A single practices markdown file, read instead of the three-tier repo. The simplest setup. */
  practicesFile: string | null;
  /** Everything the classifier and the tiered knowledge loader need. */
  supervisor: SupervisorConfig;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') { return fallback; }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** An unrecognised destination falls back to `session` — the one that changes nothing on disk. */
function ruleDestination(raw: string | undefined): RuleDestination {
  const v = (raw ?? '').trim();
  return (RULE_DESTINATIONS as readonly string[]).includes(v) ? (v as RuleDestination) : 'session';
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env, cwd?: string): PluginSettings {
  const mode = (env.SESSION_SITTER_MODE ?? '').trim().toLowerCase() === 'observe'
    ? 'observe' : 'enforce';
  return {
    mode,
    classifierEnabled: bool(env.SESSION_SITTER_CLASSIFIER, false),
    persistRules: bool(env.SESSION_SITTER_PERSIST_RULES, false),
    ruleDestination: ruleDestination(env.SESSION_SITTER_RULE_DESTINATION),
    preToolUse: bool(env.SESSION_SITTER_PRETOOL, true),
    escalate: bool(env.SESSION_SITTER_ESCALATE, false),
    escalateWaitSeconds: waitSeconds(env.SESSION_SITTER_ESCALATE_WAIT),
    user: env.SESSION_SITTER_USER || null,
    project: env.SESSION_SITTER_PROJECT || null,
    team: env.SESSION_SITTER_TEAM || null,
    practicesFile: env.SESSION_SITTER_PRACTICES || null,
    supervisor: loadConfig({ workspaceRoot: cwd }),
  };
}
