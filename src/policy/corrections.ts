/**
 * The correction lane — rewrite an unsafe call into the safe one instead of blocking it.
 *
 * `PermissionRequest` can return `decision.updatedInput`, so a hook is allowed to hand Claude Code
 * a *different* tool input than the one it asked about. Nothing else in the ecosystem uses that:
 * Auto mode can only permit or block. Turning `git push --force` into `git push --force-with-lease`
 * lets the agent keep working AND protects the branch, which is strictly better than either answer
 * a binary gate can give.
 *
 * ## The rule for adding a rule
 *
 * A wrong rewrite is far worse than no rewrite. The agent believes it ran the command it asked for,
 * and the human sees an `allow`. So a rule ships only when **all** of these hold:
 *
 *  1. The safer form is **unambiguous** — exactly one sensible replacement, not a choice among
 *     several. (`git push --force` has one; `npm install <pkg>` without a version has many.)
 *  2. The rewrite is **semantically equivalent or strictly narrower** — it never grants the call
 *     more reach than it asked for, and it never changes what the agent was trying to accomplish.
 *  3. The rewrite is **verifiable by reading the command**, with no knowledge of repository state,
 *     network state, or the user's intent.
 *  4. Failure of the rewritten form is **loud** — if the safer version refuses, the agent sees the
 *     refusal and can escalate, rather than silently doing less than it thinks it did.
 *
 * If a candidate fails any of those, the answer is a red clause (deny, citing the rule) or nothing
 * at all — not a guess. Rules that were considered and **deliberately rejected**:
 *
 *  - `rm -rf <path>` → nothing. Deletion has no narrower form. Routing it through a trash utility
 *    depends on that utility existing, on the path being inside the project, and on the agent not
 *    needing the space back — three guesses. Deny it with a clause instead.
 *  - `git checkout .` / `git reset --hard` → nothing. Both discard uncommitted work. `git stash`
 *    looks like a narrower form but changes the outcome the agent is relying on (the tree is clean
 *    *and* the work is recoverable, which is a different command). Deny.
 *  - `npm install <pkg>` with no version → nothing. Pinning to a version is a dependency decision
 *    that belongs to the humans on the project, not to a rewrite rule reading one command line.
 *  - `git push origin main` → nothing. Whether that is destructive depends on branch protection,
 *    which this file cannot see. That is exactly the ambiguity the classifier tier exists for.
 */

export interface Correction {
  /** Which rule fired, for the audit trail. */
  ruleId: string;
  /** The practices clause this rule enforces, cited in the note shown to the human. */
  clauseId: string;
  /** The full replacement tool input, ready for `decision.updatedInput`. */
  updatedInput: Record<string, unknown>;
  /** One human-readable line naming what changed and why. */
  note: string;
}

export interface CorrectionRule {
  ruleId: string;
  clauseId: string;
  /** Which tool this rule reads. Claude Code's shell tool is `Bash`. */
  toolName: string;
  /** Cheap pre-filter so the rewrite function is only called on a plausible command. */
  test: RegExp;
  /** Return the rewritten command, or null when this particular call needs no change. */
  rewrite(command: string): { command: string; note: string } | null;
}

/**
 * `--force` overwrites whatever is on the remote. `--force-with-lease` does the same rewrite but
 * refuses when the remote moved since you last fetched, which is precisely the case where a force
 * push destroys someone else's commits. Same intent, strictly narrower, and a refusal is loud.
 *
 * `--force-if-includes` is not substituted: it is a *modifier* of `--force-with-lease`, and adding
 * it changes which pushes are refused rather than only narrowing them.
 */
const FORCE_PUSH: CorrectionRule = {
  ruleId: 'force-push-to-lease',
  clauseId: 'force-push',
  toolName: 'Bash',
  test: /\bgit\b[\s\S]*\bpush\b/i,
  rewrite(command) {
    // Long form first, so `--force-with-lease` is never matched by the `--force` branch.
    if (/--force-with-lease\b/.test(command)) { return null; }
    const long = /--force\b/;
    // Short form. The cluster is restricted to `git push`'s own short options so a filename like
    // `-final` can never be read as a `-f` cluster and silently rewritten.
    const short = /(?<=\s)-([fnqvud]*)f([fnqvud]*)(?=\s|$)/;
    if (long.test(command)) {
      return {
        command: command.replace(long, '--force-with-lease'),
        note: '--force replaced with --force-with-lease so the push refuses rather than '
          + 'overwriting commits pushed by someone else',
      };
    }
    const m = short.exec(command);
    if (m) {
      const others = `${m[1]}${m[2]}`;
      // The lookbehind consumed nothing, so the whitespace before the cluster is still in place.
      const replacement = others ? `-${others} --force-with-lease` : '--force-with-lease';
      return {
        command: command.replace(short, replacement),
        note: '-f replaced with --force-with-lease so the push refuses rather than '
          + 'overwriting commits pushed by someone else',
      };
    }
    return null;
  },
};

/**
 * `777` makes a path world-writable, which is almost never what was wanted — the usual intent is
 * "make it executable" or "stop the permission error". `755` keeps owner write and everyone's read
 * and execute, so the command still does its job with a strictly smaller grant. If the agent
 * genuinely needed group or world write it will fail loudly on the next write and can say so.
 */
const CHMOD_777: CorrectionRule = {
  ruleId: 'chmod-777-to-755',
  clauseId: 'least-privilege',
  toolName: 'Bash',
  test: /\bchmod\b/i,
  rewrite(command) {
    const mode = /(\bchmod\b(?:\s+-[a-zA-Z]+)*\s+)0?777\b/i;
    const m = mode.exec(command);
    if (!m) { return null; }
    return {
      command: command.replace(mode, `${m[1]}755`),
      note: 'chmod 777 replaced with 755 — the path stays owner-writable and world-readable '
        + 'without becoming world-writable',
    };
  },
};

export const CORRECTION_RULES: readonly CorrectionRule[] = [FORCE_PUSH, CHMOD_777];

/**
 * The correction lane. Returns the rewritten input plus the clause and note, or null when nothing
 * in the table applies — which is the common case and must stay cheap: a regex pre-filter per rule,
 * no I/O, no model call.
 */
export function applyCorrection(
  toolName: string, toolInput: Record<string, unknown> | null | undefined,
): Correction | null {
  if (!toolInput) { return null; }
  const command = typeof toolInput.command === 'string' ? toolInput.command : null;
  if (command === null) { return null; }

  for (const rule of CORRECTION_RULES) {
    if (rule.toolName !== toolName || !rule.test.test(command)) { continue; }
    const result = rule.rewrite(command);
    if (!result || result.command === command) { continue; }
    return {
      ruleId: rule.ruleId,
      clauseId: rule.clauseId,
      updatedInput: { ...toolInput, command: result.command },
      note: result.note,
    };
  }
  return null;
}
