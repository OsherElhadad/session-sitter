/**
 * Plugin-side settings, read from the environment.
 *
 * A hook is a bare process with no VS Code settings and no CLI flags, so the environment is the
 * only channel. `SupervisorConfig` (`src/supervisor/config.ts`) already carries everything the
 * classifier and the knowledge loader need, and already layers `.env` files under the process
 * environment — so this module holds only what is specific to running as a Claude Code plugin.
 */

import { SupervisorConfig, loadConfig } from '../supervisor/config';

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
   * Whether a settled allow may write a permission rule back into the user's local settings by
   * echoing the dialog's own `permission_suggestions`. Off by default — a plugin that silently
   * edits your permission rules is a bad citizen, however convenient.
   */
  persistRules: boolean;
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

export function loadSettings(env: NodeJS.ProcessEnv = process.env, cwd?: string): PluginSettings {
  const mode = (env.SESSION_SITTER_MODE ?? '').trim().toLowerCase() === 'observe'
    ? 'observe' : 'enforce';
  return {
    mode,
    classifierEnabled: bool(env.SESSION_SITTER_CLASSIFIER, false),
    persistRules: bool(env.SESSION_SITTER_PERSIST_RULES, false),
    user: env.SESSION_SITTER_USER || null,
    project: env.SESSION_SITTER_PROJECT || null,
    team: env.SESSION_SITTER_TEAM || null,
    practicesFile: env.SESSION_SITTER_PRACTICES || null,
    supervisor: loadConfig({ workspaceRoot: cwd }),
  };
}
