/**
 * Where the plugin keeps its own state.
 *
 * `${CLAUDE_PLUGIN_DATA}` is the directory Claude Code gives an installed plugin
 * (`~/.claude/plugins/data/<id>/`), and it survives plugin updates — unlike `${CLAUDE_PLUGIN_ROOT}`,
 * which changes on every version bump. It is exported into the hook process's environment, so a
 * hook reads it straight from `process.env`.
 *
 * It is absent when the plugin is loaded session-only with `--plugin-dir`, and when a hook is run
 * by hand or from a test. So there is a fallback under the user's `~/.claude/`, which keeps a
 * `--plugin-dir` development run and an installed run writing to a predictable place instead of
 * scattering state into whatever the current directory happens to be.
 */

import * as os from 'os';
import * as path from 'path';

/** Root for everything this plugin writes. Override with `SESSION_SITTER_DATA_DIR` in tests. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SESSION_SITTER_DATA_DIR
    || env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'session-sitter');
}

/** One JSON line per governance decision. */
export function decisionsPath(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'decisions.jsonl');
}

/** One JSON line per tool result — the wedge detector's input. */
export function activityPath(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'activity.jsonl');
}

/** One JSON file per registered session, named by session id. */
export function sessionsDir(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'sessions');
}

/** The registration file for one session. */
export function sessionPath(sessionId: string, env?: NodeJS.ProcessEnv): string {
  // A session id comes from Claude Code and is a uuid, but it lands in a filename, so anything
  // that is not id-shaped is replaced rather than trusted.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '-') || 'unknown';
  return path.join(sessionsDir(env), `${safe}.json`);
}
