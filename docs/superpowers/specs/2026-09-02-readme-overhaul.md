# Spec: README overhaul — what "repo of the day" READMEs actually do

**Date:** 2026-09-02
**Status:** Proposed
**Scope:** `README.md` only. This document is the deliverable; it does not touch the README.

---

## Why this document exists

The current README is 403 lines and well written. Being well written is not the same as
converting a stranger. Eighteen high-star developer-tool READMEs were read as raw markdown
(not rendered) to extract what the ones that trend actually do in their first screenful. The
current README fails four of the patterns that every single one of those eighteen follows, and
it fails them in the first twenty lines — which is the only part most visitors read.

The core problem, stated once: **a reader who lands on this repo learns what it *believes*
before they learn what it *is*.** Line 8 is a slogan, lines 11–14 are a promise, and the first
statement of the actual mechanism — cites your clause, rewrites the unsafe call, keeps the
receipt — does not arrive until line 98, below a section titled with an objection.

---

## (a) The repos studied, and the one pattern each proves

| Repo | URL | The one pattern it proves |
|---|---|---|
| astral-sh/uv | <https://github.com/astral-sh/uv> | **One sentence, then proof.** H1, then *"An extremely fast Python package and project manager, written in Rust."*, then a benchmark chart. Nothing else above the fold. Three badges. No TOC. |
| astral-sh/ruff | <https://github.com/astral-sh/ruff> | **Proof asset earns the length.** Same one-sentence opener + benchmark `<picture>`; length comes from lookup material (900 rules, adopter list), not prose. Testimonials live at the *bottom*. |
| charmbracelet/gum | <https://github.com/charmbracelet/gum> | **Demo GIF before any tutorial.** Logo → 3 badges → one sentence → GIF → first runnable command. Install's rare platforms are hidden in `<details>`. |
| charmbracelet/crush | <https://github.com/charmbracelet/crush> | **Two badges is enough.** Logo, tagline, then a full-width demo screenshot before a word of prose. Uncommon installers collapsed. |
| sst/opencode | <https://github.com/sst/opencode> | **Lean landing page.** Logo, one tagline, 3 badges, one screenshot, install, then link out to docs. No comparison section at all. |
| Aider-AI/aider | <https://github.com/Aider-AI/aider> | **Demo above the badges.** Screencast sits between tagline and badge row. Features are 10 icon+H3 pairs. 30+ attributed testimonials — at the very end. |
| block/goose | <https://github.com/block/goose> | **A short README is a valid choice.** ~7 short sections, mostly links; a Trendshift badge doing the social-proof work no prose can. |
| ollama/ollama | <https://github.com/ollama/ollama> | **Zero badges, install as the first thing.** First code block is a `curl` one-liner under `## Download`, before any explanation. |
| anthropics/claude-code | <https://github.com/anthropics/claude-code> | **~40 lines total.** Title, 2 badges, one sentence, docs link, demo GIF, `Get started`. The direct competitor's README is a tenth of this one's length. |
| openai/codex | <https://github.com/openai/codex> | **Splash image, then Quickstart, then out.** No badges, no TOC, no feature list. Sibling products get a link line, not a section. |
| zed-industries/zed | <https://github.com/zed-industries/zed> | **Dispatch page.** 2 badges, one intro sentence, everything else deferred to linked docs. |
| gitleaks/gitleaks | <https://github.com/gitleaks/gitleaks> | **A real terminal transcript is a legitimate demo asset.** No GIF, no screenshot — a captured `gitleaks git -v` finding in a code block, doubling as a tutorial. Also: project status as a `[!WARNING]` above the badges. |
| sharkdp/bat | <https://github.com/sharkdp/bat> | **Compact centered nav row instead of a TOC**, plus screenshots interleaved with the feature they prove rather than batched. |
| tursodatabase/turso | <https://github.com/tursodatabase/turso> | **Position with the incumbent, not against it** — "compatible with SQLite" — and state maturity honestly ("not yet reached 1.0") rather than hiding it. |
| oven-sh/bun | <https://github.com/oven-sh/bun> | **The differentiator as one bolded clause**: "a **drop-in replacement for Node.js**". Length is a link directory, not argument. |
| open-policy-agent/opa | <https://github.com/open-policy-agent/opa> | **The anti-pattern, from the closest category.** A policy engine whose README shows no policy example until past the midpoint. Governance tools *especially* need the artifact early. |
| microsoft/markitdown | <https://github.com/microsoft/markitdown> | **GitHub admonitions (`> [!IMPORTANT]`) carry status and caveats** better than a prose paragraph. |
| browser-use/browser-use | <https://github.com/browser-use/browser-use> | **Hero → badges → "What can it do?" with two embedded demos** before the first install line. Capability shown, never asserted. |

### The patterns, distilled

1. **One declarative sentence, before anything else.** 18/18. It says what the thing *is*, in the
   reader's vocabulary. Never a slogan first.
2. **A proof asset inside the first screenful.** 16/18 (uv/ruff use a benchmark chart; gitleaks
   uses captured text; only goose and zed ship none, and both lean on a Trendshift badge or brand).
3. **2–6 badges, every one linked and load-bearing.** Static "we use TypeScript" badges appear in
   none of the eighteen.
4. **First runnable command within ~20 lines of the top.** ollama, codex, claude-code, goose,
   opencode, crush.
5. **No mermaid.** Zero of eighteen embed a mermaid diagram in the README. Architecture diagrams
   live in docs.
6. **Length is permitted only when it is lookup material.** ruff, bat, gitleaks are long because
   they are *reference* — you scan for your platform or your rule. None of them is long because of
   argument.
7. **Comparison sections are rare and, when present, are tables or a single bolded clause** — never
   three paragraphs of prose reasoning.
8. **Social proof at the bottom, or absent.** Nobody fakes it.

---

## (b) Ranked, concrete changes

### 1. Replace the header block. The first sentence must say what it is.

Today, in order: wordmark, an `<h3>` slogan, a three-line promise naming four host applications
and two topologies, four badges, a nav row, an invisible HTML comment, a 340px screenshot. A
Claude Code user reading lines 8–14 concludes "a multi-IDE session dashboard" — which is
precisely the positioning the plugin design document declares dead. The governance wedge is
absent from the fold entirely.

Proposed replacement for lines 1–47:

```markdown
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/branding/wordmark-light.png">
    <img src="docs/branding/wordmark-dark.png" alt="Session Sitter" width="480">
  </picture>
</p>

<p align="center">
  <b>Agent governance for the terminal.</b><br>
  Your coding agents run unattended under your team's written rules — every decision citing the
  rule it applied, unsafe calls rewritten into safe ones, and one durable record per action.
</p>

<p align="center"><em>Silence is never approval.</em></p>

<p align="center">
  <a href="https://github.com/eranra/session-sitter/actions/workflows/ci.yml"><img src="https://github.com/eranra/session-sitter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/eranra/session-sitter/releases/latest"><img src="https://img.shields.io/github/v/release/eranra/session-sitter?include_prereleases&sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-informational" alt="MIT"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/panel-wide-light.png">
    <img src="docs/screenshots/panel-wide-dark.png" alt="Session Sitter supervising live agent sessions: a worklist across four agents above the supervision activity feed, showing one auto-approved, one auto-corrected and one escalated decision" width="900">
  </picture>
</p>
```

Rationale: the description now leads with the category and the three differentiators, in one
sentence, in the shape uv and bun use. The slogan is *kept* — it is genuinely good — but demoted
to its own line under the description, where a slogan works. The four host names and the
cross-machine claim move down into Features; they are capabilities, not the pitch.

### 2. Cut two badges, link the rest, add a release badge.

`TypeScript-only` and `VS Code 1.65+` are unlinked static shields. `TypeScript-only` is an
internal contributor rule; `VS Code 1.65+` is a requirement already stated in the *What you need*
table. Neither belongs in the fold. Every studied repo's badges are links a visitor clicks:
version, CI, license, chat. Replace with CI + release + MIT (all linked), as in the block above.

### 3. Promote the demo screenshot to full width, and use the wide shot.

`width="340"` on a hero image is a thumbnail — on a desktop browser it occupies under a quarter
of the column. `docs/screenshots/panel-wide-dark.png` and `panel-wide-light.png` already exist
and are unused in the README. crush, aider and opencode all run their hero at full column width.
Use 900px, as in change #1. Keep the 340px `panel-dark.png` for the *First run* section where a
narrow shot is contextually right.

### 4. Add a real, captured artifact block directly under the hero — the "30-second proof".

This is the highest-leverage change after the header, and gitleaks proves it can be done without
a GIF: a captured terminal transcript in a code block is a legitimate proof asset. This repo
produces exactly the right artifact already — one durable JSON record per decision — and shows
it nowhere in the README. The competitor category's cautionary tale is OPA: a policy engine whose
README never shows a policy.

Proposed new section, immediately after the hero, before Install:

```markdown
## What one decision looks like

The agent asked to force-push. It was not blocked — it was corrected, and told why:

<!-- CAPTURE: run the supervisor against a real `git push --force` prompt and paste the
     genuine record from records/ here, trimmed to the fields below. Do not hand-write it. -->

Every decision names the practice it applied. That is the whole difference between a governance
layer and a classifier: `Blocked by classifier` is not something you can hand to your security
lead, and it is not something an agent can act on.
```

**Hard requirement:** the code block is left empty in this spec on purpose. It must be filled by
running the supervisor against a real prompt and pasting the genuine record. A hand-written
sample in the README of a project whose entire pitch is *evidence* would be self-refuting. The
same rule already governs the two existing `TODO` comments at lines 32 and 72 — this change just
raises one of them from "someday" to "the single most valuable missing asset", and makes it
capturable *today* without a screen.

### 5. Move Install above the argument, and stop leading it with what does not exist.

Install currently sits at line 135, and its first sentence is:

> **A Claude Code plugin is the plan, and is not built yet.**

The first thing a visitor reads in the section where they decide whether to try it is a sentence
about a thing they cannot have. The honesty is right; the position is wrong. Every studied repo
leads Install with the fastest working path in a copyable block — ollama makes it the first code
block in the file.

Proposed rewrite of the section head:

````markdown
## Install

```bash
# Grab the .vsix from the latest release, then:
code --install-extension session-sitter-*.vsix
```

[Latest release ↓](https://github.com/eranra/session-sitter/releases/latest) · or in the IDE:
Extensions panel → `···` → **Install from VSIX…** · reload the window and you are done.

> [!NOTE]
> Not on the VS Code Marketplace yet, so installation is by VSIX. A Claude Code plugin and a
> `session-sitter` CLI are designed and in review — until they land, the extension is the way in.
> [The design](docs/superpowers/specs/2026-09-01-claude-code-plugin-design.md).
````

Then keep the from-source block and both `<details>` blocks unchanged. The plugin caveat survives
verbatim in substance, as a `[!NOTE]` admonition (markitdown, gitleaks, claude-code all use this
pattern for exactly this job) rather than as the section's opening paragraph.

### 6. Convert "Isn't this already in Claude Code?" to a table, and move it below Supervision.

The content is the best strategic thinking in the repo and it must stay. But 24 lines of prose at
position #2, under a heading that is an objection, means the second thing a visitor reads is a
defensive argument. Turso's model: state the relationship to the incumbent compactly, in the
middle, once. Only bun does it above the fold, and it takes bun five words.

Proposed replacement for lines 79–102:

```markdown
## How this relates to Claude Code's own features

Leave Auto mode on. It is a better default than approving by reflex. What it does not do is the
part that has to be yours, because the policy is yours:

| | Claude Code, first-party | Session Sitter |
|---|---|---|
| **Who decides** | Auto mode, with Anthropic's judgment | your team's written practices |
| **What you are told** | `Blocked by classifier` | the clause it applied — `denied — practices §4: never force-push to a shared branch` |
| **An unsafe call** | blocked | rewritten into the safe one — `git push --force` → `--force-with-lease` — so the run continues |
| **Afterwards** | nothing to hand anyone | one durable JSONL record per decision, queryable |
| **Unattended** | a session that cannot prompt denies silently | a standing policy decides, and deny-on-timeout is explicit |
| **Scope** | Claude Code, one machine (Agent view is local by design) | Claude Code, IBM Bob, Codex, VS Code Chat — unioned across windows and peer machines |

Both layers run at once, and the supervision half of this extension is off until you turn it on.
```

Six rows a reader scans in ten seconds, versus three paragraphs they scan in none. Every claim in
the table is already made in the current prose — nothing new is asserted.

### 7. Delete both mermaid diagrams from the README.

Zero of the eighteen studied READMEs embed mermaid. The README carries two, totalling ~55 lines:
the supervision flowchart (lines 247–281) and the session-detection graph (lines 313–321).

- The **supervision flowchart** is redundant with `docs/diagrams/traffic-lights.svg` sitting eight
  lines above it, which already states the four lights and both timeout edges — and states them in
  a hand-authored asset that renders identically everywhere, which mermaid does not. Delete the
  flowchart; keep the SVG, keep the two sentences after it about the deterministic tier and the
  timeout edges. Move the flowchart to `docs/SUPERVISION.md`.
- The **session-detection graph** and the whole *How it finds your sessions* section (lines
  308–330) are architecture. Move to `docs/ARCHITECTURE.md`; replace with two sentences in
  Features (see #8) plus the existing link.

Net saving: ~55 lines of diagram and ~20 lines of surrounding prose, with no information lost from
the project — only from the front door.

### 8. Cut Features from 14 bullets to 8, differentiators first.

The current list opens with panel mechanics — four sources, peers, cross-window, live status, sort
orders, a colour per workspace, hover preview — and reaches the governance bullets at positions
10 through 13. A reader who came for governance quits at "A colour per workspace". ruff's 11
bullets work because each is a distinct capability claim; six of these fourteen are UI options.

Proposed list:

```markdown
## Features

- **Practices as policy, with the clause cited** — every decision names the rule it applied, not a
  fixed string.
- **The correction lane** — an unsafe call is rewritten into the safe one and re-checked against
  your deny rules, so a blocked agent gets a way forward instead of a wall.
- **Deny on timeout, always** — an escalated decision with no answer is denied. Silence never
  writes an approval.
- **A durable record per decision** — which light, who decided (🧠 AI or ⚙ rule), what was asked,
  what happened. JSON on disk, plus an activity feed that expands failures to their recorded error.
- **A deterministic tier in front of the classifier** — read-only actions never cost a model call,
  so governance stays off the critical path.
- **Four agents, one policy** — Claude Code, IBM Bob IDE, Codex CLI, VS Code Chat, by reading only
  what they already write to disk. → [how](docs/ARCHITECTURE.md)
- **Across windows and across machines** — peers are discovered from the remote windows your IDE
  already opened and probed over SSH, with nothing to install on the far side. One click focuses
  the window that owns a session, even on another box.
- **Copy transcript** as handoff-clean markdown — prose only, tool calls stripped, all four sources.
```

Cut to docs, and mentioned in *First run* where they are actually used: sort orders, per-workspace
colour, hover preview, live-status refresh interval, smart titles, upload-to-corpus, auto-respond
scoping. Every one is real and none of them sells the project.

### 9. Fix a now-false limitation, and shorten the list.

Line 388 claims **"No screenshots or demo yet"**. `docs/screenshots/` holds fifteen PNGs, six of
them already used in the README. The limitation is stale and, in a project selling accuracy, it is
the worst possible line to be wrong. Replace with the narrower true claim:

```markdown
- **No motion demo yet** — the screenshots are real; the 20-second GIF of a correction being made
  needs a machine with a screen. Shot list: [`docs/screenshots/README.md`](docs/screenshots/README.md).
```

Then cut the ten-item list to the four a prospective user's decision actually turns on — Windows
loses the recycled-PID guard, `python3` is required for Bob sessions, supervision needs a
classifier CLI on `PATH`, peer visibility is one-way — and link the rest:

```markdown
The full list, including the per-agent liveness caveats, is in
[`docs/ARCHITECTURE.md#limitations`](docs/ARCHITECTURE.md).
```

Keeping four is the point: turso states its maturity plainly and gitleaks puts a `[!WARNING]`
above its badges. Honesty is a feature; an exhaustive audit of your own edge cases at line 370 of
a README is not honesty, it is burial by completeness.

### 10. Move Development out, keep three lines.

Lines 347–365 duplicate `CONTRIBUTING.md`: the make-target list, the CI claim, the release
procedure. zed, opencode and codex all reduce this to a link. Keep only:

```markdown
## Contributing

`make check` — type-check, lint and tests, the same gate CI applies. Then `make` on its own lists
every target. Issues and pull requests welcome; the guards, the TypeScript-only rule and the
release process are in [`CONTRIBUTING.md`](CONTRIBUTING.md). For a vulnerability please use the
private path in [`SECURITY.md`](SECURITY.md) rather than an issue.
```

Merge Development into Contributing entirely — two sections become one.

### 11. Trim the nav row and drop the 0.5.0 upgrade notice.

The nav row (lines 23–30) points at the objection section; retarget it. bat's model is four to
five destinations, no more:

```markdown
<p align="center">
  <a href="#what-changes">What changes</a> ·
  <a href="#install">Install</a> ·
  <a href="#supervision">Supervision</a> ·
  <a href="#how-this-relates-to-claude-codes-own-features">vs. first-party</a> ·
  <a href="docs/">Docs</a>
</p>
```

The 0.5.0 rename notice (lines 198–200) is a migration note for existing users of an extension
that is not on any marketplace. It belongs in `CHANGELOG.md`, which it already links to. Delete
from the README.

### 12. Keep *What changes* almost untouched — it is the strongest asset in the file.

The without/with table is genuinely excellent and has no equivalent in any of the eighteen. Two
edits only: drop the trailing paragraph about the three front ends (its content is now in the
Install `[!NOTE]` and Features), and drop the `TODO(cli)` comment at lines 72–77 now that change
#4 gives the captured-artifact idea a real home and a real section.

---

## (c) Proposed section order

| # | Section | Change |
|---|---|---|
| 1 | Wordmark | narrower (480px) |
| 2 | One-sentence description + slogan | **rewritten** (#1) |
| 3 | Badges — CI, release, MIT | **cut from 4 to 3, all linked** (#2) |
| 4 | Nav row | **retargeted** (#11) |
| 5 | Hero screenshot, full width | **promoted to `panel-wide-*`, 900px** (#3) |
| 6 | **What one decision looks like** | **new — captured record** (#4) |
| 7 | Install | **moved up, rewritten head** (#5) |
| 8 | What changes | kept (#12) |
| 9 | Supervision | traffic-lights SVG + activity shot, **mermaid deleted** (#7) |
| 10 | How this relates to Claude Code's own features | **prose → table, moved down** (#6) |
| 11 | Features | **14 → 8, reordered** (#8) |
| 12 | First run | kept; absorbs the cut UI features (#8) |
| 13 | What you need | kept, unchanged |
| 14 | Documentation | kept, unchanged |
| 15 | Known limitations | **10 → 4, stale item fixed** (#9) |
| 16 | Contributing | **absorbs Development** (#10) |
| 17 | License | kept |

Two structural moves define this order: **the proof moves above the argument** (6 and 7 before 8,
9, 10), and **the objection moves below the offer** (10 after 9, not before everything).

## (d) What to cut

| Cut | Lines today | Where it goes | Why |
|---|---|---|---|
| Supervision mermaid flowchart | 247–281 (35) | `docs/SUPERVISION.md` | redundant with the SVG eight lines above it; no studied README uses mermaid |
| *How it finds your sessions* + its mermaid | 308–330 (23) | `docs/ARCHITECTURE.md` (already covered there) | architecture, not a selling point |
| *Development* section | 347–365 (19) | merged into Contributing / already in `CONTRIBUTING.md` | duplication |
| Six of fourteen Features | within 106–131 | `docs/CONFIGURATION.md`, *First run* | UI options, not capability claims |
| Six of ten Known limitations | within 369–390 | `docs/ARCHITECTURE.md` | keep the four that change a decision |
| 0.5.0 upgrade blockquote | 198–200 (3) | `CHANGELOG.md` (already there) | migration note for a pre-marketplace extension |
| `TypeScript-only` and `VS Code 1.65+` badges | 18–19 | *What you need* table (already there) | unlinked static shields; contributor rules are not badges |
| `TODO(cli)` comment | 72–77 (6) | superseded by section #6 | the idea gets a real home |
| Trailing paragraph of *What changes* | 66–70 (5) | Install `[!NOTE]` + Features | says the same thing twice |

Estimated result: **403 lines → roughly 250**, with the value proposition, a real artifact, and a
copyable install command all above the point most readers stop.

---

## What this project still cannot claim, and must not

Stated explicitly so no future edit quietly crosses these lines:

- **No demo GIF.** It needs a machine with a screen. Do not ship a placeholder image — a broken
  image is worse than none, and `ci/check-links.mjs` resolves image paths.
- **Not on the VS Code Marketplace.** No install-count badge, no Marketplace badge, no rating.
- **The Claude Code plugin and the `session-sitter` CLI are not merged** (PRs #31–#34). Install
  instructions for them stay in the future tense, in a `[!NOTE]`.
- **No users, so no social proof.** No testimonials section, no adopter list, no star-history
  chart, no Trendshift badge, no invented download numbers. aider and ruff earned theirs and put
  them at the bottom; this repo omits the section entirely until it has one real quote.
- **No invented terminal output, ever.** Change #4 is only valid when filled from a genuine run.
  Until it is, leave the section out rather than mock it up. Fabricated evidence in the README of
  an evidence product is the one mistake this project cannot recover from.
