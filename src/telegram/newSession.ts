/**
 * Starting a session from Telegram, and making it usable from Telegram.
 *
 * ## The gap this closes
 *
 * `/new` opened a Claude panel and stopped there. The launcher's own comment said a new session
 * "cannot be confirmed" — no id comes back — so the report was "opened, its topic appears once it
 * writes its first message". That last clause never came true, because **a panel with no message
 * writes no transcript**: `scanClaudeSessions` reads the per-project `.jsonl` files under
 * `~/.claude/projects`, so a session nobody has spoken to does not exist as far as the worklist is
 * concerned. No row, no topic, and nothing in Telegram to continue in — the session was visible in
 * the IDE and unreachable from the place it was started from.
 *
 * Two facts make it fixable, and neither was being used:
 *
 *  1. **A fresh panel does have a session id**, immediately. `getOpenClaudeSessionIds` reads Claude's
 *     live manager (`sessionPanels` / `sessionStates`), which knows about the panel before any
 *     transcript exists. So the id is available; it just was not being asked for.
 *  2. **`BusResult.sessionId` already exists** for this, documented as "set by `newSession` once the
 *     started session is identified" — and nothing set it and nothing read it. The plumbing was
 *     designed and left unfinished.
 *
 * So: open the panel, diff the open ids to learn which session appeared, send it a first message so
 * it becomes real, and hand the id back so a topic can be created for it.
 *
 * ## Why a first message rather than only a topic
 *
 * A topic pointing at a session with no transcript would mirror nothing and accept nothing useful:
 * the mirror tracks turns, and the send path needs a session the CLI has acknowledged. The first
 * message is what turns an open panel into a session — it is the same act that would have made it
 * appear eventually, done deliberately instead of waited for.
 *
 * Everything here is pure or injected, so the decisions are unit-tested without an extension host —
 * which the inspector-backed parts can never be.
 */

/** How long to wait for a freshly opened panel to appear in Claude's live manager. */
export const APPEAR_TIMEOUT_MS = 8_000;
/** How often to re-read the open ids while waiting. */
export const APPEAR_POLL_MS = 200;

/**
 * What a launch managed to establish about the session it started.
 *
 * The two failures are kept apart because they need different words. **Nothing appeared** means the
 * open failed or the manager had not registered the panel yet. **More than one appeared** means
 * something else opened a session at the same moment, and picking either would be a guess — this layer
 * never acts on a session it cannot positively identify, and a first message sent into the wrong
 * conversation is worse than no message at all.
 *
 * Neither is reported as "could not start": the panel is open in both cases, and saying otherwise
 * sends someone looking for a window sitting in front of them.
 */
export type LaunchOutcome =
  | { kind: 'started'; sessionId: string }
  | { kind: 'no-session' }
  | { kind: 'ambiguous'; count: number };

export function classifyAppearance(
  before: readonly string[], after: readonly string[],
): LaunchOutcome {
  const was = new Set(before);
  const appeared = [...new Set(after)].filter(id => id.length > 0 && !was.has(id));
  if (appeared.length === 1) { return { kind: 'started', sessionId: appeared[0] }; }
  if (appeared.length === 0) { return { kind: 'no-session' }; }
  return { kind: 'ambiguous', count: appeared.length };
}

// ── Choosing where to open it ───────────────────────────────────────────────

/** A window the menu could start a session in. */
export interface LaunchCandidate {
  pid: number;
  workspaceFolders: string[];
}

/**
 * Which window to start a session in for a chosen workspace folder, and how sure we are.
 *
 * `exact` means the window has that folder and **only** that folder, so opening a panel there lands
 * in the folder the user picked and nowhere else. `contains` means the window has the folder among
 * several: the panel opens in that window, but which of its folders the session gets is Claude's
 * choice, not ours — nothing in its API takes a folder.
 *
 * That distinction is the whole point of this function. The old menu paired a folder with *whichever
 * window listed it first*, so picking a folder in a multi-root window would open a session that
 * reported a different workspace, with nothing said about it. Preferring an exact window fixes the
 * common case, and naming the ambiguity is the honest answer for the rest — better than a silent
 * mismatch the user has to notice for themselves.
 */
export type LaunchTarget =
  | { certainty: 'exact'; pid: number; workspace: string }
  | { certainty: 'contains'; pid: number; workspace: string; folders: string[] }
  | { certainty: 'none' };

export function chooseLaunchTarget(
  windows: readonly LaunchCandidate[], workspace: string,
): LaunchTarget {
  const holding = windows.filter(w => w.workspaceFolders.includes(workspace));
  if (holding.length === 0) { return { certainty: 'none' }; }
  // Lowest pid among equals, so every window and every retry reaches the same answer — the same
  // tie-break ownership uses, for the same reason.
  const byPid = [...holding].sort((a, b) => a.pid - b.pid);
  const exact = byPid.find(w => w.workspaceFolders.length === 1);
  if (exact !== undefined) {
    return { certainty: 'exact', pid: exact.pid, workspace };
  }
  const first = byPid[0];
  return {
    certainty: 'contains', pid: first.pid, workspace, folders: [...first.workspaceFolders],
  };
}

/**
 * What to warn the user about before they tap, or null when there is nothing to warn about.
 *
 * Said at the menu rather than after the fact: once the session exists in the wrong folder the only
 * remedy is to close it and start again, and a warning that arrives then has cost the user the round
 * trip it was meant to save.
 */
export function targetCaveat(target: LaunchTarget): string | null {
  if (target.certainty !== 'contains') { return null; }
  const others = target.folders.filter(f => f !== target.workspace);
  const name = (p: string): string => p.split(/[/\\]/).pop() ?? p;
  return `that window also has ${others.map(name).join(', ')} open, and Claude picks the folder `
    + 'itself — the session may land in one of those instead';
}

// ── The first message ───────────────────────────────────────────────────────

/**
 * The message that turns an open panel into a session.
 *
 * Deliberately a plain instruction rather than a question. It has to make the CLI write a transcript
 * record — that is the whole job — and it should leave the agent ready for the real prompt rather than
 * part-way through answering a pleasantry it invented work for.
 *
 * It names Telegram and the host because the transcript is the durable record of how the session
 * started, and "who opened this and from where" is the first thing anyone asks of a session they did
 * not start themselves.
 */
export function firstMessage(host: string): string {
  return `This session was started from Telegram on ${host}. `
    + 'Reply in its topic to continue. Nothing to do yet — wait for the next message.';
}
