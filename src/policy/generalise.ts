/**
 * Turn "this clause allowed this call" into the permission rule the user actually meant.
 *
 * ## The bug this closes
 *
 * Claude Code's "Always allow" saves the *literal* command string it was shown, commit message and
 * all, so the rule it writes never matches a second time and `settings.local.json` silently fills
 * with hundreds of dead one-off entries — issues #6850 (45 reactions, open) and #11380 (64
 * reactions). #29187 is the same dialog getting it wrong in the other direction, offering a wildcard
 * far wider than the subcommand the user approved.
 *
 * `PermissionRequest` lets a hook return `decision.updatedPermissions`, and the docs say plainly
 * that echoing one of the `permission_suggestions` back "is equivalent to the user selecting that
 * 'always allow' option in the dialog". So a policy layer can decline the literal suggestion and
 * emit the *right* rule instead — derived from the written clause that approved the call, which is
 * the only thing in the system that actually knows what class of call is licensed.
 *
 * ## Why it is this conservative
 *
 * A too-wide rule is a security hole that outlives the session, and nobody will ever read it again.
 * So a rule is emitted only when every one of these holds, and otherwise nothing is emitted and the
 * prompt simply comes back:
 *
 *  1. **A green clause allowed the call.** Never a deny (`updatedPermissions` is allow-only anyway),
 *     never the correction lane (a rewrite is per-call, and a standing rule for a call the agent
 *     never actually made is nonsense), and never the deterministic tier (which has no clause to
 *     derive from, and grants that path for free on every call regardless).
 *  2. **The tool is `Bash`.** It is the tool with the prefix-rule syntax and the tool the reported
 *     issues are about. `execute_command` is IBM Bob's shell tool and has no Claude Code rules.
 *  3. **The call is a single command.** A rule derived from a compound is the very bug the compound
 *     evaluator exists to fix: `Bash(x:*)` matches on the prefix, so a rule written from
 *     `git status && rm -rf /` would license the `rm` to anything starting with `git status`.
 *  4. **The matcher was written as a substring, and the command starts with it, on a word boundary.**
 *     A `/regex/` clause says nothing a prefix rule can express, and a substring that matched in the
 *     *middle* of the command licenses no prefix at all.
 *
 * The result is strictly narrower than the clause: the clause allows its substring **anywhere** in a
 * command, and the emitted rule allows it only as a **prefix**.
 *
 * ## Where it is written
 *
 * `session` by default — in memory, gone when the session ends. A hook that edits a git-tracked
 * settings file behind someone's back is a bad citizen, and `projectSettings` is exactly that until
 * somebody asks for it. `SESSION_SITTER_RULE_DESTINATION` moves it.
 */

import * as path from 'path';
import { Clause, matchingPattern } from './practices';
import { splitShellCommand } from './shell';

/** Where a permission update is written. Same four values the hooks reference documents. */
export type RuleDestination = 'session' | 'localSettings' | 'projectSettings' | 'userSettings';

export const RULE_DESTINATIONS: readonly RuleDestination[] =
  ['session', 'localSettings', 'projectSettings', 'userSettings'];

/** One `addRules` permission update entry, the only kind this module ever emits. */
export interface PermissionUpdate {
  type: 'addRules';
  rules: { toolName: string; ruleContent: string }[];
  behavior: 'allow';
  destination: RuleDestination;
}

/** Only Claude Code's shell tool has prefix rules to generalise into. */
const SHELL_TOOL = 'Bash';

/**
 * Is `raw` a prefix of `command`, ending on a word boundary?
 *
 * The boundary check is the load-bearing half: without it a clause matching `git s` would emit
 * `Bash(git s:*)`, which also licenses `git shove-everything`. Whitespace is loosened the same way
 * `substringMatcher` loosens it, so `npm  test` and `npm test` are the same prefix.
 */
export function prefixOf(raw: string, command: string): string | null {
  const escaped = raw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const anchored = new RegExp(`^\\s*(${escaped})(?=\\s|$)`, 'i');
  const m = anchored.exec(command);
  return m ? m[1] : null;
}

/**
 * The rule this clause licenses for this call, or null when nothing safe can be derived.
 *
 * `clause` must be the green clause that actually allowed the call; the caller is responsible for
 * never passing a clause that denied, and for never calling this for a corrected call.
 */
export function generalisedPermission(
  clause: Clause,
  toolName: string,
  toolInput: Record<string, unknown> | null | undefined,
  destination: RuleDestination = 'session',
): PermissionUpdate | null {
  if (clause.level !== 'green') { return null; }
  if (toolName !== SHELL_TOOL) { return null; }

  const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
  if (command === null || command.trim() === '') { return null; }

  // A compound is never generalised — see rule 3 above.
  const split = splitShellCommand(command);
  if (!split.confident || split.commands.length !== 1) { return null; }

  // The clause matched the tool name + arguments JSON, so re-derive which matcher did it against
  // the same haystack shape the decision used, then require that matcher to be a usable prefix.
  const matched = matchingPattern(clause, `${toolName} ${JSON.stringify(toolInput ?? {})}`);
  if (matched === null || matched.isRegex) { return null; }

  const prefix = prefixOf(matched.raw, command);
  if (prefix === null) { return null; }

  return {
    type: 'addRules',
    rules: [{ toolName: SHELL_TOOL, ruleContent: `${prefix}:*` }],
    behavior: 'allow',
    destination,
  };
}

// --------------------------------------------------------------------------- the path seam

/**
 * The tools whose input names a file, and the argument key that names it.
 *
 * `models.ts` puts "the normalised call *shape* an offline miner keys on" in this module, so the path
 * normaliser lives here rather than in `mine.ts` or `propose.ts` — one definition of what a path
 * means, because two places deciding that will disagree the day one of them is changed.
 *
 * The set is derived from `session.ts`'s `PAYLOAD_KEYS`, which enumerates the four write tools by the
 * bytes they carry: `content` (Write), `old_string`/`new_string` (Edit), `edits` (MultiEdit),
 * `new_source` (NotebookEdit). Three deliberate exclusions:
 *
 *  - **`Read`, `Glob`, `Grep`, `NotebookRead`.** They are in `tiers.ts`'s `SAFE_TOOLS`, so
 *    `preClassify` returns GREEN and ladder rung 1 grants them on every call for free. A learned
 *    green over them could not change a decision — rule 1 above — and `replay.ts`'s INERT finding
 *    would reject it anyway. They also cannot fall closed or leave a gap, so neither lane has any
 *    evidence to mine about them in the first place.
 *  - **`Bash`.** A path inside a command line is the shell lane's problem, and already has E8's
 *    `escapesCwd`.
 *  - **IBM Bob's `write_to_file`.** The repo names the tool (`docs/onboarding/reference/
 *    AUTO-RESPOND.md`) but pins its path argument nowhere; `trail.ts`'s `pick('path')` is a display
 *    fallback tried across every tool, not a claim about Bob's schema. A matcher over a guessed key
 *    matches nothing, forever, and reads exactly like a clean run — the failure shape this wave is
 *    hunting. Add it with a real record in hand, not a guess.
 */
export const PATH_TOOLS: ReadonlyMap<string, string> = new Map([
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);

/**
 * Is this path unusable as the basis of a matcher?
 *
 * A double quote and a backslash are escaped by `JSON.stringify` on the way into `haystackFor`, so a
 * matcher built from the raw path would be anchored against a string the haystack never contains. A
 * control character is the same problem. Refusing beats escaping them as well: such a path is
 * pathological, and the whole value of this lane is that the matcher and the haystack agree exactly.
 *
 * Whitespace is *not* refused here, because a file with a space in its name is ordinary. It is refused
 * one level up, on the emitted directory literal — `propose.ts`'s `pathMatcher` says why.
 */
function unusableInPath(raw: string): boolean {
  return raw.includes('"') || raw.includes('\\') || [...raw].some(c => c < ' ');
}

/**
 * The absolute, lexically normalised path a record's tool input names — or null.
 *
 * `cwd` is required for a relative path and never defaulted: `path.resolve` would silently fall back
 * to `process.cwd()`, which is the miner's directory and has nothing to do with the session's. That
 * would resolve two records for the same file to two different strings and cluster them apart, which
 * is exactly the bug this function exists to prevent.
 *
 * Lexical, not filesystem: `.` and `..` are collapsed by `path.resolve`, and no symlink is followed
 * here. Resolution is `propose.ts`'s `symlinkEscape`, at gate time, where it can refuse.
 */
export function normalisedPath(
  toolName: string, toolInput: Record<string, unknown> | null | undefined, cwd: string | null,
): string | null {
  const key = PATH_TOOLS.get(toolName);
  if (key === undefined || !toolInput) { return null; }
  const raw = toolInput[key];
  if (typeof raw !== 'string' || raw.trim() === '') { return null; }
  if (unusableInPath(raw)) { return null; }
  if (path.isAbsolute(raw)) { return path.resolve(raw); }
  if (cwd === null || !path.isAbsolute(cwd)) { return null; }
  return path.resolve(cwd, raw);
}
