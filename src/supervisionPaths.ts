/**
 * Where supervision writes, and which of those destinations the user has to configure.
 *
 * Two very different things used to share one setting. `sessionSitter.supervisorStateDir` gated
 * BOTH the AI supervisor (which shells out to a classifier CLI, so it must stay opt-in) AND the
 * reporting of decisions (a record under `records/`, the panel's activity feed, the human
 * channel). That made every DETERMINISTIC `sessionSitter.autoRespond` decision invisible on a
 * default install: the rules fire without any supervisor, but with no state dir there was nowhere
 * to write the record, so nothing reached the panel or Telegram.
 *
 * Splitting them keeps both properties:
 *  - `dir` always resolves (falling back to the extension's own global storage), so a rule
 *    decision is ALWAYS recorded and always shows up in the activity feed.
 *  - `explicit` stays false until the user sets the setting, and the AI supervisor stays gated on
 *    that — defaulting the path must never start a classifier nobody asked for.
 */

import * as path from 'path';

export interface ResolvedStateDir {
  /** The directory supervision state is written to. Always non-empty. */
  dir: string;
  /** True only when the user set `sessionSitter.supervisorStateDir` themselves. */
  explicit: boolean;
}

/**
 * Resolve the supervision state dir: the configured setting when set, else `<globalStorage>/state`.
 *
 * `globalStorage` is the extension's own per-install directory, so the fallback is always writable
 * and never collides with another extension.
 */
export function resolveStateDir(
  configured: string | undefined, globalStorage: string,
): ResolvedStateDir {
  const trimmed = (configured ?? '').trim();
  if (trimmed) { return { dir: trimmed, explicit: true }; }
  return { dir: path.join(globalStorage, 'state'), explicit: false };
}

/**
 * The repo the supervisor reasons about: an explicit `supervisorRepoPath`, else the parent of an
 * EXPLICIT state dir (the `<repo>/.state` and `<repo>/supervisor/.state` convention), else the
 * first workspace folder.
 *
 * A defaulted state dir is deliberately not used here — its parent is the extension's global
 * storage, which is not a repo, and pointing the supervisor at it would be worse than having no
 * root at all.
 */
export function resolveWorkspaceRoot(
  configuredRepoPath: string | undefined,
  stateDir: ResolvedStateDir,
  firstWorkspaceFolder: string | undefined,
): string {
  const repo = (configuredRepoPath ?? '').trim();
  if (repo) { return repo; }
  if (stateDir.explicit) { return path.dirname(stateDir.dir); }
  return (firstWorkspaceFolder ?? '').trim();
}
