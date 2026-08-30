# Plan: Consolidate the Session Sitter supervision runtime into session-sitter

Spec: [`2026-08-30-supervision-consolidation-design.md`](../specs/2026-08-30-supervision-consolidation-design.md)

Every step ends green: `npx tsc -p ./ --noEmit && npx vitest run && npx eslint src`.

---

## Phase 1 — Foundation (merge, don't overwrite)

1. **`WindowRegistry.ts`** — add `openBobTaskIds?` / `openClaudeSessionIds?` to `WindowEntry`.
   Keep `~/.claude/session-sitter/windows` (this repo's path). Tests: entries round-trip
   with and without the new fields.
2. **`SessionManager.ts`** — merge:
   - keep this repo's Codex + Chat scanners, `exportFullTranscript`, markdown renderer;
   - restore the supervision project's **atomic map swap** (build local `filePaths`/`sources` maps, swap at the
     end) so a concurrent reader never sees an emptied map mid-scan;
   - all four scanners record both `filePaths` *and* `sources` (Claude currently records
     neither source nor path atomically);
   - restore `getBobDbPath()` and `getSessionFilePath()` (supervision needs them);
   - `getFullTranscript()` delegates to `SessionExporter.readBobTranscript`;
   - VS Code user dir becomes cross-platform (macOS / Linux / Windows) instead of macOS-only —
     required for WSL, where the supervisor actually runs.
   Tests: existing 59 stay green; add atomic-swap + cross-platform dir + accessor tests.

## Phase 2 — Agent bridges (`src/agents/`)

3. `BobInspector.ts` — `runExclusive` serialization, `callOnBobTaskManager`,
   `getOpenBobTaskIds`, `parseOpenTaskIds`, `pickClosureTaskManager`.
4. `BobSender.ts` — rewrite over `BobInspector`; add `TextRule` / `ApprovalRule` /
   `AutoRespondRule` union + guards + `shouldAttemptSend`; re-export
   `pickClosureTaskManager` so existing imports and tests keep working.
5. `BobApprover.ts`, `ClaudeInspector.ts`, `ClaudeSender.ts`, `ClaudeApprover.ts`,
   `QuestionProbe.ts` — port as-is.
6. `AutoResponder.ts` — the supervision project's superset (text + approval sweeps, Claude sweep, question
   guards, unhandled-prompt handoff).

## Phase 3 — Export + supervisor core

7. `SessionExporter.ts` — port whole (Bob + Claude transcript builders, `pendingFromApproval`,
   `derivePendingAction`, atomic `writeExport`).
8. `src/supervisor/` in dependency order: `timeutil` → `models` → `schema` → `questions` →
   `transcript` → `knowledge` → `tiers` → `prompt` → `engine` → `store` → `messaging` →
   `telegram` → `agentControl` → `orchestrator` → `config`.
   Each file gets its tests in the same step.
9. `src/supervisor/cli.ts` — `run <id> [--user --project --team --transcript]`, `poll [--loop N]`,
   argv-shorthand normalization. Same contract as `supervise.py`.

## Phase 4 — Wire-up

10. `SupervisorOutbox.ts`, `SupervisionActivity.ts` — port as-is.
11. `SupervisionService.ts` — replaces `SupervisionTrigger`: owns the in-process
    `Orchestrator`, dedupes per `requestId`, exports the transcript, classifies, then kicks
    `outbox.poll()`; runs a `poll()` timer for Telegram replies and timeouts.
12. `SessionSitterViewProvider.ts` — merge: keep Codex/Chat routing + the three
    `copyTranscript*` handlers; add the activity feed, `openSettings`,
    `openSupervisionRecord` / `copySupervisionRecordPath` (with the `req-<hex>` path guard),
    the per-source active/history partition, and publication of open ids.
13. `webview/` — merge `main.js` (keep the transcript submenu + 4-source badges, add the
    activity feed and hover preview), add `toolbarMenu.js`, merge `styles.css`.
14. `extension.ts` — wire senders, approvers, `AutoResponder`, `SupervisionService`,
    `SupervisorOutbox`, the probe commands, and the in-process uploader.
15. `package.json` — supervision + corpus settings, new commands, `autoRespond` schema
    covering both rule kinds, version bump.

## Phase 5 — Corpus (`src/corpus/`)

16. `mask.ts` — port the rule set + deterministic replacements + report.
17. `upload.ts` — upload / delete / list / import (Bob DB + Claude JSONL), masking before
    commit, git via `child_process`.
18. `kbFetch.ts` + `cli.ts` — the knowledge loader CLI the kb-sitter skill calls.
19. Wire `sessionSitter.uploadToCorpus` to `upload.ts` (no shell-out), with the
    `uploadScriptPath` → `dataRepoPath` fallback.

## Phase 6 — Docs + knowledge assets

20. `docs/ARCHITECTURE.md` rewrite (four sources, supervision layer, module map).
21. New: `docs/SUPERVISION.md`, `docs/KNOWLEDGE.md`, `docs/CORPUS.md`,
    `docs/CONFIGURATION.md`.
22. `skills/kb-sitter/SKILL.md` (generic), `knowledge/REGISTRY.example.md`,
    `knowledge/bottom-line.template.md`.
23. `README.md` — merge the switcher intro with the supervision story.

## Phase 7 — Verify

24. Full `tsc` + `vitest` + `eslint`; `npm run package` builds a VSIX.
25. Confirm zero `.py` files ship, and no internal slug (`osher`, `skillberry`,
    `optimization`, `github.ibm.com`) appears anywhere in the tree.
