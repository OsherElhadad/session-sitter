# Research: what Claude Code users actually lack, and which of it Session Sitter should build

**Date:** 2026-09-02
**Status:** Research — input to a design, not a design
**Method:** GitHub REST/search API against `anthropics/claude-code` (fetched 2026-09-02), HN Algolia
search API, GitHub repository API for star counts, and the live hook reference at
`https://code.claude.com/docs/en/hooks` (fetched as `hooks.md`, 317 KB, 2026-09-02).

**Honest caveats up front.**

- **Reddit could not be reached.** `reddit.com`, `old.reddit.com` and the `.json` search endpoints
  all returned an interstitial or were blocked by the fetch tool from this machine. There is
  therefore **no r/ClaudeAI, r/ClaudeCode or r/LocalLLaMA evidence in this document.** Rather than
  paraphrase threads I could not open, they are absent. Anything below that looks like community
  sentiment comes from a GitHub issue or an HN thread whose URL is cited and was actually fetched.
- **Reaction and comment counts are as of the fetch on 2026-09-02** and move.
- **Issue state is reported as fetched.** Several issues cited inside #30519 have since been closed
  without the underlying behaviour demonstrably changing; where an issue is closed, it says so.
- Star counts are from `api.github.com/repos/<slug>` on 2026-09-02.

---

## (a) Evidence table

### The permission system is the single loudest governance-adjacent failure

| Source | Signal | Weight | Date |
|---|---|---|---|
| [#30519](https://github.com/anthropics/claude-code/issues/30519) — *Permissions matching is fundamentally broken — 30+ open issues, no staff engagement, community building workarounds* | A community-written meta-issue. Enumerates ten sub-issues and states the outcome plainly: users' three options are click through everything, `bypassPermissions` (which disables deny rules too), or **"build custom hooks to reimplement matching"** — and option 3 is "what people are actually doing." | 79 reactions, 27 comments, **open** | 2026-03-03 |
| [#6850](https://github.com/anthropics/claude-code/issues/6850) — *`settings.local.json` allow not working — keeps asking and wanting to add existing items again* | "Always Allow" persists the literal command string, commit message and all, so it never matches again; `settings.local.json` accumulates hundreds of dead one-off rules. | 45 reactions, 42 comments, **open** | 2025-08-30 |
| [#11380](https://github.com/anthropics/claude-code/issues/11380) — *Claude continually asks for permission, even after selecting yes, always allow* | Same failure, larger audience. | 64 reactions, 82 comments, closed | 2025-11-10 |
| [#29187](https://github.com/anthropics/claude-code/issues/29187) — *"Always allow" suggests overly broad wildcard instead of specific subcommand* | The generalisation the dialog offers is wrong in the *other* direction too. Labelled `regression`. | 0 reactions, 4 comments, closed | 2026-02-27 |
| [#25441](https://github.com/anthropics/claude-code/issues/25441) — *Bash permission wildcards don't match multiline/heredoc commands* | `Bash(git:*)` does not match `git add x && git commit -m y`. Per #30519 this applies to **deny** rules as well, so configured safety constraints are not enforced. | 7 reactions, closed | 2026-02-13 |
| [#29616](https://github.com/anthropics/claude-code/issues/29616) | Wildcards in `settings.local.json` not matching. | 3 reactions, closed | 2026-02-28 |
| [#18846](https://github.com/anthropics/claude-code/issues/18846) — *Bash permissions in settings.json not enforced — requires custom hook workaround* | The title is the finding: a hook is the accepted workaround. | 21 reactions, 12 comments, closed | 2026-01-17 |
| [#28240](https://github.com/anthropics/claude-code/issues/28240) — *Permission prompt incorrectly triggers on `cd` instead of the actual command in compound bash statements* | Compound-command handling again, from the prompting side. Labelled `regression`, `area:permissions`. | 205 reactions, 47 comments, open | 2026-02-24 |
| [#13340](https://github.com/anthropics/claude-code/issues/13340), [#18160](https://github.com/anthropics/claude-code/issues/18160), [#5140](https://github.com/anthropics/claude-code/issues/5140) | Three separate reports that `allow` rules in user-level `settings.json` are not honoured. | 51 / 50 / 34 reactions, all open | 2025-12 → 2026-01 |
| [#18950](https://github.com/anthropics/claude-code/issues/18950) — *Skills/subagents do not inherit user-level permissions from `settings.json`* | Permission state is not uniform across the session tree. | 70 reactions, open | 2026-01-18 |
| [#36168](https://github.com/anthropics/claude-code/issues/36168) — *Bypass/dangerously skip permissions now broken in all versions newer than v2.1.77* | The escape hatch people fled to also breaks. | 65 reactions, 55 comments, open | 2026-03-19 |
| [HN 47343927](https://news.ycombinator.com/item?id=47343927) — *Show HN: A context-aware permission guard for Claude Code* (`nah`) | The best-performing third-party permission tool on HN. Thread themes, verbatim from the fetched page: the allow/deny model "doesn't really scale"; the system is "unbelievably poor for a product with this much traction"; Claude "keeps asking for permissions for various pipelined grep and find incantations"; and — the interesting one — danger emerges from *sequences* of individually safe calls (read credentials → write script → execute), where "each component is secure on its own." | **127 points, 94 comments** | 2026-03-11 |
| [HN 47402187](https://news.ycombinator.com/item?id=47402187) — *Claude Code's permission system misses compound commands — here's a fix* | Independent confirmation of the compound-command hole. | 1 point | 2026-03-16 |
| [HN 46695467](https://news.ycombinator.com/item?id=46695467) — *Show HN: Fence — sandbox CLI commands with network/filesystem restrictions* | The other popular answer to the same pain: contain instead of adjudicate. | 78 points, 23 comments | 2026-01-20 |
| [HN 47233127](https://news.ycombinator.com/item?id=47233127) (*Claude Code Permission Policy*), [HN 47452894](https://news.ycombinator.com/item?id=47452894) (*delegate permission approval to LLM*), [HN 46719447](https://news.ycombinator.com/item?id=46719447) (*Mother May I? — auto-approve safe Bash*), [HN 47111171](https://news.ycombinator.com/item?id=47111171) (*approve from your phone via ntfy*), [HN 47167242](https://news.ycombinator.com/item?id=47167242) (*ccperm — audit permissions across projects*) | Five more independent attempts at the same problem in seven months, none above 5 points. The demand is real; nobody has landed it. | 1–5 points each | 2026-02 → 2026-03 |

### Unattended runs are silently denied

| Source | Signal | Weight | Date |
|---|---|---|---|
| [#83166](https://github.com/anthropics/claude-code/issues/83166) — *Scheduled routines: no way to grant standing tool permissions — unattended runs stall on permission prompts* | Exactly the gap the plugin design names. | 1 reaction, open | 2026-08-01 |
| [#77817](https://github.com/anthropics/claude-code/issues/77817) — *v2.1.206 silently broke unattended scheduled tasks: runs no longer inherit `permissions.default…`* | Standing permission via settings is fragile across versions. | 3 reactions, 6 comments, open | 2026-07-15 |
| [#47180](https://github.com/anthropics/claude-code/issues/47180) — *Cowork scheduled tasks ignore "Always allow" folder/tool permissions — prompts reappear every run* | Same class, larger surface. | 45 reactions, 34 comments, open | 2026-04-13 |
| [#86391](https://github.com/anthropics/claude-code/issues/86391) — *Cowork scheduled tasks: WebFetch permission gate blocks unattended runs* | Same class. | 2 reactions, open | 2026-08-13 |
| `hooks.md` §PermissionRequest | Documented: in sessions that cannot show a prompt, **"if no hook returns a decision, it denies the tool call."** So today, unattended means silently denied unless a hook decides. | — | current docs |

### Escalation to a phone is *anti*-demand

| Source | Signal | Weight | Date |
|---|---|---|---|
| [#29214](https://github.com/anthropics/claude-code/issues/29214) — *Remote Control: mobile app shows permission prompts despite `--dangerously-skip-permissions`* | The top permission-titled issue by reactions is a request to make phone prompts **stop**. | 81 reactions, 30 comments, open | 2026-02-27 |
| [#51267](https://github.com/anthropics/claude-code/issues/51267), [#81036](https://github.com/anthropics/claude-code/issues/81036), [#76109](https://github.com/anthropics/claude-code/issues/76109) | Remote Control hangs, gives up after 3 retries in ~1.3 s, goes silent overnight. Building on the phone path means inheriting its reliability. | 18 / 1 / 0 reactions, open | 2026-04 → 2026-07 |

### Agents that are wedged, not working

| Source | Signal | Weight | Date |
|---|---|---|---|
| [#26224](https://github.com/anthropics/claude-code/issues/26224) — *Claude Code is hanging / freezing / stuck on heaps of prompts for 5–20 minutes or more* | 151 reactions, 129 comments, open | 2026-02-17 |
| [#33949](https://github.com/anthropics/claude-code/issues/33949) — *SSE streaming hangs indefinitely (no timeout) + ESC cannot fully cancel* | 25 reactions, 39 comments, open | 2026-03-13 |
| [#24585](https://github.com/anthropics/claude-code/issues/24585) — *Opus 4.6 continuously stuck in explore and thinking loops* | 38 reactions, open | 2026-02-10 |
| [#13240](https://github.com/anthropics/claude-code/issues/13240) — *hangs indefinitely during processing with no error output* | 14 reactions, 18 comments, open | 2025-12-06 |

### Adjacent, verified, and useful for scope decisions

| Source | Signal | Weight | Date |
|---|---|---|---|
| [#16157](https://github.com/anthropics/claude-code/issues/16157) — *Instantly hitting usage limits with Max subscription* | **1,491 comments**, 724 reactions — the single most-discussed open issue in the repo. Cost and quota anxiety dwarfs everything else. | open | 2026-01-03 |
| [#38335](https://github.com/anthropics/claude-code/issues/38335) — *Max plan session limits exhausted abnormally fast* | 545 reactions, 839 comments, open | 2026-03-24 |
| [#12619](https://github.com/anthropics/claude-code/issues/12619) — *Allow setting plan naming scheme per-repo* | 167 reactions with only 10 comments — a quiet, broadly-wanted naming/identification request. | open | 2025-11-28 |
| [#40346](https://github.com/anthropics/claude-code/issues/40346) — *Programmatic session/thread renaming via hooks or tools* | 13 reactions, 7 comments, open — **and already satisfiable:** `SessionStart` accepts `hookSpecificOutput.sessionTitle`. Users don't know. | open | 2026-03-28 |
| [#23983](https://github.com/anthropics/claude-code/issues/23983) — *PermissionRequest hooks not triggered for subagent permission requests in Agent Teams* | 14 reactions, 11 comments, **open** — a hole in *our* coverage story, not a feature. | open | 2026-02-07 |
| [#24057](https://github.com/anthropics/claude-code/issues/24057) — *MCP servers, hooks, and plugins should auto-reload when config changes* | 20 reactions, 34 comments, open — a policy file edited mid-session needs a restart today. Affects our reload story. | open | 2026-02-08 |
| [#89595](https://github.com/anthropics/claude-code/issues/89595) — *Authoritative session-finalization contract for audit and security integrations* | 0 reactions, but it is precisely the contract an audit product needs, filed by somebody with the same problem. | open | 2026-08-25 |
| [#32733](https://github.com/anthropics/claude-code/issues/32733) — *Secure secrets injection for Claude Code on the web* | 183 reactions, 7 comments, `area:security` — high reaction-to-comment ratio, i.e. broad silent agreement. | open | 2026-03-10 |
| [#45596](https://github.com/anthropics/claude-code/issues/45596) — *Bring Back Buddy* | 2,078 reactions — the repo's loudest issue overall, and entirely unrelated to governance. Useful only as a calibration point for what "loud" means here. | open | 2026-04-09 |

---

## (b) Ecosystem table

Stars fetched 2026-09-02.

| Tool | Stars | What it does | What it proves |
|---|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | 280,312 | Agentic skills framework and development methodology | Prescriptive, opinionated *process* delivered as files an agent reads is the highest-leverage form factor in this ecosystem by an order of magnitude. Written practices are a product. |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 53,328 | Curated list | Discovery is the scarce resource; a plugin nobody lists does not exist. |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | 35,785 | First-party plugin directory | The official channel is where distribution happens. |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 37,015 | Model routing / local control plane | People will install an intercepting layer if it saves money. Do not compete here. |
| [SuperClaude-Org/SuperClaude_Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework) | 23,856 | Commands, personas, workflows | Same lesson as superpowers: configuration-as-product. |
| [slopus/happy](https://github.com/slopus/happy) | 23,577 | Mobile/web client with voice + encryption | Mobile control is *owned*, by a 23k-star project and by first-party Remote Control. |
| [ccusage/ccusage](https://github.com/ccusage/ccusage) | 18,269 | `npx ccusage` — token/cost reporting | Cost measurement is settled. |
| [getagentseal/codeburn](https://github.com/getagentseal/codeburn) | 9,977 | Token/cost tracking across 37 agents | Even the *cross-vendor* cost niche is taken. |
| [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | 12,704 | Statusline | A statusline is a feature of somebody else's product now, not a differentiator. |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8,409 | Multi-agent terminal session manager | Session *multiplexing* is crowded — plus first-party `claude agents`. |
| [matt1398/claude-devtools](https://github.com/matt1398/claude-devtools) | 3,892 | Inspect session logs, tool calls, tokens, subagents | Post-hoc transcript inspection is well served. An audit trail must be *decisions*, not transcripts, or it is this. |
| [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | 1,529 | Hook-event dashboard | "Stream every hook event to a dashboard" is a solved demo. Generic observability is not the wedge. |
| [uber/ADR](https://github.com/uber/ADR) | 1,522 | Enterprise agent observability, security benchmarking, threat detection | Enterprise agent security has a serious entrant. Session Sitter must be the *team-scale, your-own-rules* layer, not an enterprise ADR clone. |
| [FailproofAI/failproofai](https://github.com/FailproofAI/failproofai) | 1,667 | Observability *and enforcement* for agent harnesses | The closest competitor by category. Differentiator must be clause citation + correction, not "we log and enforce." |
| [superagent-ai/vibekit](https://github.com/superagent-ai/vibekit) | 1,853 | Run agents in an isolated sandbox with secret redaction | Containment is a mature alternative strategy. Do not build a sandbox. |
| [sipyourdrink-ltd/bernstein](https://github.com/sipyourdrink-ltd/bernstein) | 1,053 | "Open-source governance layer for AI agents. No model in the coordination loop" | The word "governance" is claimed. Our claim has to be narrower and demonstrable. |
| [Pantheon-Security/medusa](https://github.com/Pantheon-Security/medusa) | 973 | Security scanner; vets `.claude/` hooks for compromise | Somebody already treats `.claude/` config as an attack surface worth scanning. Corroborates candidate 3 below. |
| [vivekchand/clawmetry](https://github.com/vivekchand/clawmetry) | 401 | Zero-config observability/governance for 26 runtimes | Cross-runtime observability alone is not defensible. |
| [ldayton/Dippy](https://github.com/ldayton/Dippy) | 243 | "Less permission fatigue" — knows what's safe to run | The best-performing dedicated permission tool. 243 stars against a problem with 500+ reactions across issues = the need is unmet, not the market saturated. |
| [infinri/Writ](https://github.com/infinri/Writ) | 189 | "Governance runtime for Claude Code. Enforces workflow gates at tool time" | Workflow gating ≠ policy adjudication. Adjacent, not overlapping. |
| [kbwo/ccmanager](https://github.com/kbwo/ccmanager) | 1,230 | Cross-agent session manager (Claude/Gemini/Codex/Cursor/Copilot/Cline) | **Cross-vendor session listing is no longer unique.** 1.2k stars, and first-party `claude agents` above it. Our worklist is not the pitch. |
| [kornysietsma/claude-code-permissions-hook](https://github.com/kornysietsma/claude-code-permissions-hook) | 40 | `PreToolUse` hook for granular permissions | The literal thing #30519 predicted people would write. |
| [dwarvesf/claude-guardrails](https://github.com/dwarvesf/claude-guardrails) | 33 | Deny rules + shell hooks + prompt hardening | Same. |
| [synthesisengineering/claude-settings-guard](https://github.com/synthesisengineering/claude-settings-guard) | 1 | "Protects Claude Code settings from being silently changed" | The self-modifying-config hole is real enough that someone built for it, and unowned enough that they got one star. |
| [varmabudharaju/agent-pd](https://github.com/varmabudharaju/agent-pd) | 21 | Logging-only hook + CLI auditing the agent | Nearest thing to our audit-trail CLI. 21 stars. Unowned. |
| [selimllc/cc-audit](https://github.com/selimllc/cc-audit) | 1 | Local zero-telemetry `PreToolUse` logging | Unowned. |
| [yyy900/claude-night-guard](https://github.com/yyy900/claude-night-guard) | 2 | "Safety guardrails for Claude Code running unattended" | Our exact thesis, built by someone else, at 2 stars. The thesis is not proven by demand — it is proven by the *issues*, not by this repo. |
| [eckardt/cchistory](https://github.com/eckardt/cchistory) | 137 | Shell-history-like view of sessions | Query surfaces over on-disk session data are a legitimate small category. |
| [chongdashu/cc-statusline](https://github.com/chongdashu/cc-statusline) | 632 | Statusline generator | — |
| [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community) | 3,128 | Community marketplace mirror — **contains only 4 plugins** (`eli5`, `quickdesign`, `testdino`, `tres-finance-plugin`) as of this fetch | The community catalog is nearly empty. Being an early, well-documented governance plugin there is cheap and high-visibility. |

**The synthesis of (a) and (b):** there is a large, sustained, well-documented demand for
*permission adjudication that actually works*, and the supply is a long tail of 1–250 star hooks.
Everything adjacent to it — cost, statuslines, session lists, mobile, sandboxes, generic hook
dashboards — is saturated by projects two to four orders of magnitude larger. Session Sitter should
move *toward* the permission decision and *away* from everything around it.

---

## (c) Ranked shortlist

Effort assumes the plugin scaffolding in the 2026-09-01 design already exists.
"Reachable" means: I read the field in `hooks.md` on 2026-09-02 and quote it below.

### 1. Generalised "always allow" — write the rule the user actually meant · **S** · **Reachable**

**Pain:** clicking "Always Allow" saves the literal command string, so it never matches again and
`settings.local.json` fills with dead rules (#6850, 45 reactions, open; #11380, 64 reactions) — or
it suggests a wildcard far too broad (#29187, `regression`).

**Mechanism:** `PermissionRequest` input carries `permission_suggestions`, "the 'always allow'
options the user would normally see in the permission dialog." On allow, `decision.updatedPermissions`
takes `addRules` entries with `{toolName, ruleContent}` and a `destination` of
`session | localSettings | projectSettings | userSettings`. The docs state plainly: "A hook can echo
one of the `permission_suggestions` it received as its own `updatedPermissions` output, which is
equivalent to the user selecting that 'always allow' option in the dialog."

So Session Sitter can decline to echo the bad suggestion and emit the *right* rule instead — derived
from the practice clause that approved the call, at the destination that clause's scope implies.
`destination: "projectSettings"` is the point: a rule that came from a team practice belongs in the
team's file, not in one developer's `settings.local.json`.

**Why here:** the clause is already the unit of decision. Turning "this clause allowed this call"
into "this clause's rule, written down where the team can see it" is one function on the existing
decision object. Nobody in the ecosystem does this; the 2026-09-01 design mentions `updatedPermissions`
only as "so a settled question stops coming back," which undersells it.

### 2. Compound-command policy evaluation · **M** · **Reachable**

**Pain:** `Bash(git:*)` does not match `git add x && git commit -m y`; per #30519 this defeats
**deny** rules too, so configured safety constraints are not enforced. #28240 (205 reactions,
`regression`, `area:permissions`) is the same hole from the prompting side. HN 47343927's most
substantive comment is the generalisation: risk lives in *sequences* of individually safe calls.

**Mechanism:** `PermissionRequest` receives the whole `tool_input.command`. Split it into simple
commands and evaluate each against the practices; the decision is the strictest result. A verdict
that names the offending sub-command (`denied — practices §4, in sub-command 3 of 4:
git push --force`) is something the first-party matcher structurally cannot produce.

**Why here:** this *is* the governance decision, done correctly. It is also the honest answer to
"why not just use `settings.json`" — because `settings.json` demonstrably does not do this.

**Caveat:** shell parsing is where security tools get bypassed. This needs an explicit
fail-closed rule (unparseable → treat as ambiguous → classifier or escalate, never allow) and
adversarial tests. Do not hand-roll a tokeniser without them.

### 3. Guard the agent's own permission config · **S** · **Reachable**

**Pain:** an agent that can edit `.claude/settings.json` can widen its own allow list, and an audit
trail that a governed process can rewrite is not an audit trail. Corroborated by
[medusa](https://github.com/Pantheon-Security/medusa) (973 stars) vetting `.claude/` hooks for
compromise, and by `claude-settings-guard` existing at all.

**Mechanism:** the `ConfigChange` hook, matchers `user_settings | project_settings | local_settings |
policy_settings | skills`, receives `source` and `file_path`, and blocks with
`{"decision": "block"}`. Documented limits, both important: `policy_settings` changes **cannot** be
blocked (hooks still fire, so they can be logged), and "a blocked change surfaces no message to you
or to Claude … Claude Code only writes a line to the debug log" — so Session Sitter's own record and
activity feed are the *only* place the block becomes visible. That is an argument for us, not
against.

**Why here:** it closes the loop on every other candidate. Effort is near-zero: one hook, one
matcher set, the existing audit writer.

### 4. Standing policy for unattended runs, with the deny made explicit · **M** · **Reachable**

**Pain:** #83166, #77817, #47180 (45 reactions), #86391 — unattended and scheduled runs stall or are
silently denied, and standing permission via settings keeps breaking across versions.

**Mechanism:** documented in `hooks.md` §PermissionRequest: "In sessions that can't show a prompt,
such as background subagents in non-interactive mode, Claude Code still runs these hooks, and if no
hook returns a decision, it denies the tool call." A `PermissionRequest` hook is therefore *the*
mechanism, not one of several. Pair with `SessionEnd` for the digest.

**Why here:** this is the project's founding thesis and it is now provable from the vendor's own
docs. It is also the one place where "silence is never approval" is the *literal* platform default
rather than a slogan — the honest framing is "Claude Code already denies on silence; we make the
denial a decision you wrote, with a record, instead of an unexplained stall."

**Note:** `PermissionDenied` (fires only in auto mode, receives `reason`, returns
`hookSpecificOutput.retry: true`) is a cheap complement: log what auto mode blocked, and where a
practice clause covers the call, tell the model it may retry. It does **not** reverse the denial —
"Claude Code doesn't reverse the denial itself" — and `retry` is ignored for no-verdict denials.
Small, real, and honest about its limits.

### 5. `policy check` — lint a practices file, replay real decisions against it · **M** · **Reachable**

**Pain:** nobody can safely change a policy they cannot test. #24057 (20 reactions, 34 comments)
adds the operational sting: hooks and settings don't auto-reload, so a policy edit mid-session needs
a restart — all the more reason to validate before shipping.

**Mechanism:** entirely offline. Reads the audit JSONL Session Sitter itself wrote and re-runs the
deterministic tier against a proposed practices file. No hook contract involved, so no platform risk.

**Why here:** only the project that owns the decision log can replay it. This is the feature that
turns the audit trail from a receipt into a tool, and it is the one thing on this list with no
external dependency at all.

### 6. Audit trail as a queryable surface · **M** · **Reachable**

**Pain:** auto mode reports the fixed string `Blocked by classifier` (confirmed verbatim in the
`PermissionDenied` docs) and keeps nothing you can hand to anyone. #89595 is somebody else asking
Anthropic for exactly the finalization contract an audit integration needs.

**Mechanism:** the hooks write it; `session-sitter log --since --denied --corrected --json --csv`
reads it. Nearest existing work is `agent-pd` (21 stars) and `cc-audit` (1 star) — unowned.

**Why here:** already in the design. Ranked below the above because the *decision quality* is the
product and the log is its exhaust; a log of mediocre decisions is `claude-devtools` (3.9k stars)
with extra steps.

### 7. The correction lane · **M** · **Reachable**

**Pain:** a blocked agent stops. `--force` → `--force-with-lease` is the shape of most real
"unsafe" calls: the intent is fine, the flag is wrong.

**Mechanism:** `decision.updatedInput`, allow-only, "replaces the entire input object, so include
unchanged fields alongside modified ones. The modified input is re-evaluated against deny and ask
rules." The re-evaluation is the safety property, and it is documented.

**Why here:** it is the demo, and the 2026-09-01 design already has it as capability #2. Ranked
seventh only because nothing in the fetched evidence shows users *asking* for rewriting — it is a
correct inference from "blocked agents stop," not a measured demand. Build it; do not lead the
pitch with it until a real user has said they wanted it.

### 8. Wedge detection · **L** · **Partly speculative**

**Pain:** #26224 (151 reactions, 129 comments), #33949, #24585, #13240 — agents hang, loop, or go
silent, and nothing distinguishes working from wedged.

**Mechanism, split honestly:**
- *Observing* is reachable: `PostToolUse` and `PostToolUseFailure` for repeated identical calls;
  `Notification` matchers `idle_prompt` (~60 s after a response with no typing), `agent_needs_input`
  and `agent_completed` (both require v2.1.198+, and both fire **only while agent view is open in a
  terminal** — a real constraint on coverage); `SessionStart` on `resume`/`fork` supplies
  `seconds_since_last_response`.
- *Acting* is thinner than it looks. `Notification` hooks "can't block or modify notifications" and
  Claude Code "discards their `systemMessage` and `continue` fields," keeping only `terminalSequence`
  (restricted to OSC 0/1/2/9/99/777 and BEL, interactive sessions only). `Stop`/`SubagentStop` can
  push a turn onward via `decision: "block"` or `additionalContext`; `TeammateIdle` can hold a
  teammate open with exit 2 or stop it with `continue: false`. None of these can un-hang a stalled
  SSE stream.

**Verdict:** ship the *detection and the record*. A claim that Session Sitter unwedges a hung agent
is not supported by the contract and should not be made.

### 9. Automatic session titles · **S** · **Reachable**

**Pain:** #12619 (167 reactions, 10 comments — high ratio, broad quiet agreement) wants per-repo
naming; #40346 asks for programmatic renaming via hooks and is **already satisfiable**.

**Mechanism:** `SessionStart` returns `hookSpecificOutput.sessionTitle` — "the same effect as
`/rename`," applies on `startup`/`resume`/`fork`, ignored on `clear`/`compact` — and the input
carries `session_title` so a hook can avoid overwriting a title the user set. `watchPaths` and
`reloadSkills` are on the same object if wanted later.

**Why here:** an unnamed session is an unauditable one, and the worklist is only as good as its
titles. Hours of work, and it makes the existing panel visibly better.

### 10. Resume-cost warning · **S** · **Reachable, but off-thesis**

**Pain:** the two most-discussed open issues in the repo are quota exhaustion (#16157, 1,491
comments; #38335, 839 comments). Resuming a stale session silently re-writes the whole context to
cache.

**Mechanism:** `SessionStart` on `resume`/`fork` supplies `context_tokens`,
`prompt_cache_likely_expired`, and `estimated_cache_write_usd` (v2.1.251+); surface it via
`systemMessage`. Roughly ten lines.

**Verdict:** genuinely reachable, genuinely wanted, and genuinely *not governance*. It is the
cheapest thing on this list and the easiest to mistake for scope creep — ccusage (18k) and codeburn
(10k) own cost. Include only as a one-line `systemMessage` from a hook we are already running. If it
needs a settings page, it is the wrong feature.

---

## (d) Do NOT build

| | Why |
|---|---|
| **Telegram / phone escalation as a feature** | First-party Remote Control and Channels exist. The top permission-titled issue by reactions (#29214, 81 reactions) is a plea to make phone prompts *stop*. Remote Control's own reliability issues (#51267, #81036, #76109) would become ours. `happy` has 23.6k stars. Keep escalation as the rare path; never lead with it. |
| **Anything cost, token or quota focused beyond candidate 10** | ccusage 18,269 stars; codeburn 9,977 across 37 tools. The 2026-09-01 design already scoped this out and was right. |
| **A statusline** | ccstatusline 12,704; cc-statusline 632. Ship the minimum the plugin needs, market nothing. |
| **Session multiplexing / worktree orchestration** | claude-squad 8,409; ccmanager 1,230; plus first-party `claude agents`. |
| **Cross-vendor session *listing* as the pitch** | ccmanager already lists Claude, Gemini, Codex, Cursor, Copilot and Cline. Keep the worklist as supporting evidence for governance coverage; it is no longer a headline. |
| **Model routing or a proxy** | claude-code-router 37,015. Different product. |
| **A sandbox** | Fence (HN 78 pts), vibekit 1,853. Containment is a complementary strategy, not ours. A governance layer that also sandboxes is two products done badly. |
| **Generic hook-event observability** | disler's dashboard 1,529 stars, clawmetry 401, claude-devtools 3,892. "Stream every hook event somewhere" is a solved demo. Our log must be *decisions and clauses*, or it is a worse version of these. |
| **Answering `AskUserQuestion` / `ExitPlanMode`** | Already out of scope in the 2026-09-01 design and it should stay out — a question to the human stays a question to the human. |
| **A general secret scanner** | vibekit and medusa (973) do this. `PostToolUse` `updatedToolOutput` makes redaction *reachable*, which is exactly the trap: reachable is not a reason. |
| **Anything relying on `defer`** | `PreToolUse` `permissionDecision: "defer"` is documented as narrow; the 2026-09-01 design already ruled it out. Unchanged. |
| **Blocking `policy_settings` changes** | Explicitly impossible: "`policy_settings` changes can't be blocked … any blocking decision is ignored. This ensures enterprise-managed settings always take effect." Log them; never claim to enforce against them. |
| **Claiming to un-wedge a hung agent** | See candidate 8. `Notification` hooks cannot act, and no hook can recover a stalled stream. Detection and record only. |
| **Claiming coverage of subagents in Agent Teams** | #23983 is open: `PermissionRequest` hooks are not triggered for subagent permission requests in Agent Teams. This must appear in "Known limitations," not be quietly assumed. |

---

## Open questions this research does not answer

1. **No Reddit evidence.** Everything here is GitHub + HN. The community-sentiment half of the brief
   is missing and should be redone from a machine that can reach Reddit before any of this is
   treated as settled.
2. **Nobody asked for the correction lane.** It is the best demo on the list and the only headline
   capability with zero measured demand behind it. Worth building, worth watching.
3. **Is `updatedPermissions` writing to `projectSettings` acceptable to users?** A hook that edits a
   git-tracked settings file is a strong move and possibly an unwelcome one. Default to `session`,
   make `projectSettings` opt-in, and say so.
4. **The permission tools that exist are all small.** Dippy's 243 stars against 500+ reactions of
   documented pain reads as an unmet need. It could also read as a market that installs nothing and
   just complains. Candidate 1 is the cheap probe: it is small, it fixes a named 45-reaction bug, and
   it will tell us which reading is right.
