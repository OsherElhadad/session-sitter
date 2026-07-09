# Latest Sessions by Activity

**Date:** 2026-07-09
**Status:** Approved

## Goal

Show the user's 20 most recently active sessions in the sidebar's Sessions view, mixed across Claude and Bob, sorted by `updatedAt` descending. Retire the current "active-only" filter that gates list membership behind tab-open / PID-liveness / 2-hour-recency signals. The History panel continues to exist and covers the deeper archive.

Also rename the sidebar container title from **"Claude Sessions"** to **"AI Sessions"** to reflect that the view lists both Claude and Bob sessions.

## Motivation

Today the Sessions view only surfaces sessions the extension classifies as "currently active" — meaning at least one of: the session's editor tab is open in this window, the session's PID is alive, its `status` is not idle, or it was updated within the last 2 hours. Users with older idle sessions they still care about (e.g. context from a project they came back to after lunch) can't see them without expanding History. Feedback: users want a scrollable view of "the latest sessions I've touched," ordered by recency, without pre-filtering.

## Approach

Simplify `_pushSessions` and `_pushHistory` in `src/SessionSwitcherViewProvider.ts` to pure slice-and-sort operations against the full session list:

- **Sessions**: all sessions, sorted by `updatedAt` desc, take the first 20.
- **History**: same list, skip 20, take the next 50.

The tab-open / PID / 2-hour signals are removed from list-membership decisions. They remain in use for `_openSessionLocal` (which uses `_openClaudeTabLabels()` to decide whether to reveal an editor tab or focus a side panel) and for `session.status`, which the webview continues to render as a green/gray dot.

Rename the sidebar container title in `package.json` from `"Claude Sessions"` to `"AI Sessions"`. No other name/branding surface changes in this PR.

## Behavior Details

**Ordering.** `Array.prototype.sort` with `(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()`. Ties broken arbitrarily (JS sort is stable in Node — order among ties matches insertion order from `SessionManager.getSessions()`).

**Sessions view constant.** `const SESSIONS_LIMIT = 20;` at the top of `SessionSwitcherViewProvider.ts`. History uses the existing `.slice(0, 50)` post-skip.

**Cross-source mixing.** Claude and Bob sessions occupy the same list. The renderer already draws a "Bob" badge next to Bob titles ([src/webview/main.js:152-156](src/webview/main.js#L152-L156)) and no badge for Claude, so no CSS or template changes are needed.

**Visual state.** `session.status` continues to drive the dot color — green for `active`, gray for `idle`. No new visual for tab-open or PID-alive state. If two sessions both show a green dot, the one on top is the more recently updated.

**Empty-state text.** The placeholder "No active sessions — click + to start one" in [src/webview/main.js:272](src/webview/main.js#L272) is updated to "No sessions yet — click + to start one" (the "active" qualifier is no longer accurate).

## Behavior Change Callout

An idle session (Claude or Bob) whose editor tab is currently open in the IDE, but whose `updatedAt` is old enough that 20 more-recently-touched sessions sit above it, will drop into History under the new design. Under today's filter it would always appear in Sessions when its tab is open.

Rationale for accepting this: if 20 other sessions have been touched more recently, the user's actual focus has moved elsewhere; showing a stale-but-open tab at position 21 in a 20-slot view offers no obvious win and complicates the mental model. The tab is still reachable from History (or from the editor tab itself).

## Files Changed

- `src/SessionSwitcherViewProvider.ts` — replace both `_pushSessions` and `_pushHistory` bodies with the slice-and-sort logic. Delete now-unused code paths that consulted `_openClaudeTabLabels()`, `getActiveSessionIds()`, and the 2-hour recency window for list membership. Keep `_openClaudeTabLabels()` itself — still used by `_openSessionLocal`.
- `src/webview/main.js` — update the empty-state placeholder text.
- `package.json` — change `contributes.viewsContainers.secondarySidebar[0].title` from `"Claude Sessions"` to `"AI Sessions"`.
- `src/test/SessionSwitcherViewProvider.test.ts` — the existing "Bob open tab surfacing" and Copilot-flagged regression tests test filter behavior that is going away. Replace them with tests for the new slice-and-sort behavior.
- `docs/superpowers/specs/2026-07-09-latest-sessions-by-activity-design.md` — this spec.

## Testing

New unit tests in `src/test/SessionSwitcherViewProvider.test.ts`:

1. **`Sessions view returns top 20 across sources, sorted by updatedAt desc`** — construct 25 sessions with monotonically decreasing `updatedAt` (mixed Claude and Bob). Assert Sessions message contains exactly 20 sessionIds, in the expected order, and History contains the remaining 5.
2. **`History skips the first 20 and caps at 50`** — construct 75 sessions. Assert Sessions has 20, History has 50 starting from index 20 through 69, dropping the last 5.
3. **`Fewer than 20 total sessions → all in Sessions, History empty`** — 5 sessions. Sessions has all 5, History has 0.
4. **`Sessions view mixes Claude and Bob interleaved by updatedAt`** — alternating sources with descending timestamps. Assert the returned list mirrors the alternation.
5. **`Bob session's status='running' does not force position — only updatedAt does`** — one older Bob with `status='running'` and one newer Claude with `status='idle'`. Assert Claude is at index 0, Bob is at index 1.

Delete (or rewrite as slice-and-sort tests):

- The two "Bob open tab surfacing (`_pushSessions` / `_pushHistory`)" tests — they assert filter behavior that no longer exists.
- The two Copilot regression tests ("does not hide recent Claude sessions when only a Bob tab is open" / "does not push a recent Claude session into History just because a Bob tab is open") — same reason.

The regressions those tests guarded against are also gone: with no tab-open gate, the pre-Copilot bug where a Bob tab could suppress the Claude branch cannot happen.

## Non-Goals

Explicitly deferred:

- Filter chips (All / Claude / Bob) on the Sessions view.
- User-configurable `SESSIONS_LIMIT` via `settings.json`.
- New visual state for "editor tab is open" (as distinct from `status === 'active'`).
- Renaming `displayName`, command titles, or command category. Those touch marketplace listings and command palette entries and are worth a separate PR.

## Risk

Low. The change is a filter loosening (no data loss, no schema change, no new dependencies). The renamed sidebar title is a package.json string change that takes effect on next window reload after install. Rollback is a straightforward revert of the commit.
