# Design: the Session Sitter landing page

**Date:** 2026-09-02
**Status:** Approved — ready to implement
**Deliverable:** one GitHub Pages page, served from `main` / `/docs`, no build step, no runtime
dependencies, no external fetches.

---

## Why this document exists

Session Sitter's pitch is hard to hear and easy to prove. Hard to hear, because "agent governance"
is a category name and not a benefit, and because the two obvious objections — *isn't this Auto
mode?* and *isn't this Agent view?* — arrive before the reader has seen anything. Easy to prove,
because the product's single best moment fits in eighteen seconds: an agent proposes
`git push --force` on a shared branch at 2 a.m., the hook rewrites it to `--force-with-lease`,
names the clause it applied, and writes a record.

So the page has exactly one job: **make that moment visible above the fold, then answer the
objection before the reader can raise it.** Everything else is supporting material.

This document is written so another agent can build the page without making a single design
decision. Every colour has a hex value and a measured contrast ratio; every frame of the demo has
its exact text; every image path has been checked against the filesystem.

---

## 1. Research: eleven developer-tool landing pages

Fetched and read on 2026-09-02. The last column is the one transferable thing each page proves —
not what it does, but what it teaches us.

| Site | URL | The one thing it proves |
|---|---|---|
| **Bun** | https://bun.sh | The strongest hero is a **provable claim you can watch resolve**. Bun puts an animated benchmark race directly under the install command — the value is not asserted, it is demonstrated in the first screenful, with a "reproduce" link beside it. This is the single most important lesson for us: our demo belongs in the hero, not in section 4. |
| **Effect** | https://effect.website | An **interactive code visualisation as the hero** works even when the product is abstract. Effect's `Effect.all` demo with concurrency toggles turns a type-system pitch into something you poke at. Also: a `Problem / With Effect` comparison section placed early, before features. |
| **Biome** | https://biomejs.dev | **Before/after, side by side, static, and instantly legible.** No animation needed when the transformation is the product. Their `CODE → OUTPUT` pair plus a benchmark stat block is the cheapest possible proof. Full light/dark asset pairs for every image — the discipline we already have in `docs/screenshots/`. |
| **Zed** | https://zed.dev | A hero that shows the **actual product surface, in motion**, beats any illustration. Also a tight three-word feature triad ("Fast · Agentic · Collaborative") immediately under the hero as a spine for everything below. |
| **Vite** | https://vite.dev | **Section rhythm**: hero → trust strip → four features → four more features → community → CTA. Short sections, one idea each, install snippet with copy-to-clipboard in the hero. Nothing is longer than a screen. |
| **Tailwind CSS** | https://tailwindcss.com | **Pair the input with the rendered output in the same frame.** Their hero shows utility classes beside the thing those classes produce. Oversized, tightly-tracked display type; a long feature grid where each tile is itself a working demo. |
| **Astral** | https://astral.sh | **Restraint plus one benchmark.** Two CTAs ("Get started" / "Browse docs"), a single comparison teaser, three attributed quotes, and a repeated CTA band at the bottom. Proof that a very short page converts if the one number is good. Their social proof is *named humans with titles* — which is exactly why we will have none: we have no such quotes and will not invent them. |
| **SST** | https://sst.dev | **The config file *is* the hero.** A single `sst.config.ts` snippet that provisions a whole app says more than a paragraph. Our equivalent is the BDI practices entry: show the input file, then show the decision it produced. |
| **Drizzle ORM** | https://orm.drizzle.team | **Competitive positioning through data and self-deprecation**, not a feature matrix. A live benchmark widget against the named alternative, and a testimonial wall that includes hostile tweets. Voice can carry a comparison that a table would make defensive. |
| **Charm** | https://charm.land | **Terminal aesthetic as brand.** A CLI-first product can look designed. Playful eyebrow tags on every card, one loud tagline, and a credibility line that is a fact rather than a boast ("in over 25,000 applications"). |
| **Turso** | https://turso.tech | **The headline as an architectural claim** ("Millions of Databases. One Architecture."), with the subhead doing the technical qualification. Also a machine-readable footer (`llms.txt`, OpenAPI, MCP manifest) — a small, cheap signal of seriousness we can echo by linking the real docs.

### What the good ones have in common

1. **Value is provable within the first screenful.** Ten of eleven put either a benchmark, a
   before/after, or a live demo above the fold. None asks you to scroll to find out what it does.
2. **Two CTAs, never three.** One primary (do the thing), one secondary (read about the thing).
3. **A code or terminal block is the primary visual.** Not one of eleven uses stock illustration or
   a 3-D render. Monospace *is* the imagery in this category.
4. **The comparison section is early and specific.** Effect, Drizzle, Bun and Biome all name the
   alternative and give a number or a diff. The pages that hedge read as weaker.
5. **Short sections, one idea each.** Nothing runs past a screen. Vite's rhythm is the model.
6. **Dark mode is not optional.** Every single one ships paired light/dark assets.
7. **Social proof is named, or absent.** Astral and Zed quote real people with titles. Nobody uses
   anonymous filler. Since we have no quotes, we substitute *verifiable facts* — 868 passing
   tests, zero runtime dependencies, TypeScript only — which is the honest version of the same move.

### What we deliberately do *not* copy

- **No star count.** It would date instantly and we are not going to hardcode a number we cannot
  keep true. (A GitHub badge would need a network fetch; see §6 constraints.)
- **No testimonials, no logo wall, no adoption figures.** We have none. Inventing them on the site
  of a product whose entire value proposition is *evidence* would be self-refuting.
- **No install command as the hero CTA.** The Claude Code plugin is designed and not built. The
  hero must not imply a one-line install that does not exist.
- **No newsletter capture, no Discord, no pricing.** None exists.

---

## 2. Information architecture

Eleven sections. Order is load-bearing: **prove, then defend, then explain, then install.**

| # | Section | id | Purpose | Content | Visual treatment |
|---|---|---|---|---|---|
| 0 | Skip link + nav | — | Accessibility and orientation | Skip-to-content link; wordmark → `#top`; `Demo` `Why` `Practices` `Install` `Docs` `GitHub`; theme toggle | Sticky, 56px, hairline bottom border, `backdrop-filter: blur(8px)` with a solid fallback. Nav links collapse to `Docs` + `GitHub` + toggle under 640px — no hamburger, no JS menu |
| 1 | **Hero** | `top` | Make the value provable in one screenful | Headline, subhead, two CTAs, three-fact credibility line. **Right column: the animated demo terminal**, autoplaying Scene A once on load | Two-column grid at ≥900px (copy 45% / terminal 55%); stacked below, copy first. Dark ink band edge-to-edge in dark mode; in light mode the page is paper and only the terminal stays dark |
| 2 | **The four claims** | `claims` | Give the reader a spine to hang everything on | Four cards, straight from the design record: *Cites the clause* · *Rewrites, doesn't just block* · *Survives unattended* · *Leaves an audit trail*. Each card: a one-line title, two lines of body, and a monospace fragment of real output | Four-up grid at ≥1120px, two-up at ≥640px, one-up below. Each card carries a 4px top rule in its light's colour (green / yellow / orange / red respectively) — the same rule the traffic-lights SVG uses |
| 3 | **Silence is never approval** | `silence` | The philosophy beat; the one line people will repeat | The slogan as an oversized display line, one paragraph on deny-on-timeout, then `docs/diagrams/traffic-lights.svg` full width. Below it: **Scene B of the demo** — the timeout case — as a 4-frame replay | Full-bleed ink band in **both** themes (the SVG paints its own ink card and must not sit on paper). Slogan at display size, centred, `text-wrap: balance` |
| 4 | **Isn't this already in Claude Code?** | `why` | Answer the objection before it is raised | Verbatim in substance from `README.md`: Agent view is a first-party worklist, local to one machine and one agent; Auto mode is a first-party classifier, on by default, and you should leave it on. Then what is left over: your clause, the rewrite, the deny-on-timeout, the record, four vendors, many machines | Two stacked comparison rows, not a matrix. Each row: `First-party today` on the left in muted type, `What is left over` on the right in full-contrast type with a mint left rule. The generous framing of the competitor is the credibility — do not sharpen it |
| 5 | **See it in your editor** | `panel` | Show the shipped surface | Three theme-aware `<picture>` pairs: the panel, the needs-you-first worklist, the activity feed. One caption each | Horizontal scroll-snap rail on mobile, three-up grid at ≥900px. `<picture>` with `prefers-color-scheme` sources, exactly as the README does. Real alt text (given in §7) |
| 6 | **Your practices are the policy** | `practices` | Close the loop: show the input file *and* the decision it caused | Left: a real BDI entry in the format from `docs/KNOWLEDGE.md`. Right: the decision line that entry produced, and the JSONL record. An arrow/rule between them | Two-column code panels at ≥900px, stacked below with a `↓` glyph between. This is the SST move: the config file is the hero of its own section |
| 7 | **One engine, three front ends** | `engine` | Explain the shape, and be honest about status | `docs/diagrams/architecture.svg`, then a three-row status table: **VS Code panel — shipping** · **Supervisor CLI — shipping** · **Claude Code plugin — designed, not built**, linking the design record | Ink band (again: the SVG carries its own background). Status pills: `shipping` in mint, `designed` in muted grey with a dashed border — visibly *not* a green tick |
| 8 | **Install** | `install` | The honest path in | The VSIX from the latest release, or `make install` from source; the "installing into Bob / Cursor" variants; the requirements table. An explicit callout: *the Claude Code plugin is the plan and is not built yet* | Copy-to-clipboard code blocks (`navigator.clipboard` with a `document.execCommand` fallback and a visible "Copied" state). Requirements as a two-column definition list |
| 9 | **Docs** | `docs` | Send the serious reader onward | Five cards: ARCHITECTURE, SUPERVISION, KNOWLEDGE, CORPUS, CONFIGURATION — each with the one-line description already written in `README.md`. **All five link to `github.com/…/blob/main/docs/…`**, never to a path on the Pages site (see §6) | Two-up card grid, hairline borders, whole card is the hit target |
| 10 | Footer | — | Close | Wordmark, MIT, the repo, `SECURITY.md`, `CONTRIBUTING.md`, and the slogan one last time in muted type | Hairline top border, small type, no columns below 640px |

### Why this order and not another

- **Demo in the hero, not section 3.** This is the biggest single decision on the page. Bun,
  Effect and Zed all put the proof above the fold, and our proof is unusually good — it is a
  transformation, which reads instantly, rather than a number, which needs trust.
- **The objection at §4, not §9.** A reader who has heard of Auto mode is *already* thinking about
  it during the hero. Answering it early converts scepticism into interest; answering it at the
  bottom answers nobody, because they left.
- **Screenshots after the objection, not before.** The panel is the *shipped* half and it is
  beautiful, but it is also the half that overlaps with Agent view. Showing it before §4 invites
  exactly the wrong comparison.
- **Install second-to-last.** The install story is honestly weak right now (VSIX, no marketplace,
  no plugin). Leading with it would be leading with the weakest asset. Anyone who reaches §8 has
  already decided.

---

## 3. Hero copy

### Ship this

> ### Agents run unattended. Your written rules decide.
>
> Session Sitter answers every permission prompt against your team's own practices — naming the
> clause it applied, rewriting an unsafe command into the safe one instead of blocking the run, and
> writing one durable record per decision.
>
> **[ Watch a force-push get corrected ]**  ·  [ Read the docs → ]
>
> <small>Claude Code · IBM Bob IDE · Codex CLI · VS Code Chat — across windows, across machines.<br>
> Zero runtime dependencies · TypeScript only · 868 tests · MIT</small>

**Eyebrow** (above the headline, micro type, letterspaced, muted):
`AGENT GOVERNANCE FOR CODING AGENTS`

**Primary CTA:** `Watch a force-push get corrected` — an in-page anchor to `#top` that *restarts
the hero demo* rather than scrolling. On mobile, where the demo sits below the copy, it scrolls to
the demo and starts it.

This is an unusual primary CTA and it is the right one. There is no install command worth
promoting: the plugin is not built, and the extension install is a VSIX download. So the most
valuable thing a first-time reader can do is watch eighteen seconds of proof. The CTA says exactly
what will happen, which is why it will be clicked.

**Secondary CTA:** `Read the docs →` linking to `github.com/eranra/session-sitter/tree/main/docs`.

**Tertiary, small, beneath:** `Install the extension` → `#install`. Present for the reader who is
already sold, deliberately not competing for attention.

### Alternative headlines

| | Headline | For | Against |
|---|---|---|---|
| **A ✅ recommended** | **Agents run unattended. Your written rules decide.** | Two clauses, two beats: the problem (unattended) and the answer (your rules). "Written" is the whole wedge in one adjective — it distinguishes us from a vendor's classifier without naming it. Nine words, scans in one glance, survives being read at display size on a phone. | "Decide" is slightly abstract on its own; it needs the subhead. Acceptable — the subhead is one line away and does the work. |
| B | Governance for coding agents, with the clause cited. | Most precise. Lands hardest with the security-minded lead who is the actual buyer, and "the clause cited" is the single most defensible differentiator in the product. | "Governance" is a category word that makes a curious developer bounce. It describes the product rather than the reader's day. Better as the eyebrow — which is where it went. |
| C | It doesn't block the run. It fixes the call. | The most memorable line of the four, and the only one that conveys the correction lane, which is the demo. Great as a section heading. | Hides the governance frame entirely; a reader arriving cold cannot tell what kind of tool this is. Also implicitly promises the rewrite always works. **Use this as the heading of §2's second card.** |
| D | Unattended agents, under written policy. | The README's current line. Accurate and compact. | "Policy" reads as enterprise boilerplate to an individual developer, and the noun-phrase form has no verb — it states a category, not a benefit. Keep it in the README, where the reader has already opted in. |

**Recommendation: A.** It is the only one that names both the reader's problem and the mechanism,
and the only one whose two halves can be typeset on two lines at display size without either half
looking like a fragment. B's precision is preserved by using it as the eyebrow; C's memorability is
preserved by using it as a section heading. Nothing is lost.

---

## 4. Design system

Every value below is a token. Nothing in the stylesheet may use a raw colour that is not one of
these. Contrast ratios are WCAG 2.1, computed from these exact hex pairs — the same arithmetic
`src/test/WebviewContrast.test.ts` runs.

### 4.1 Why the traffic lights get two sets of values

This repo has already been bitten by this. `src/webview/styles.css` painted the four supervision
labels with VS Code's `--vscode-charts-*` palette, which is a set of chart **fill** colours: chosen
to be distinguishable from one another, never to be read against a background. On Light Modern the
yellow label measured **2.70:1** and the orange **2.77:1**, both far under the 4.5:1 normal text
needs, and nothing caught it because nothing was counting. Commit `72379c3` fixed it and added the
test that keeps it fixed.

The lesson generalises, so the site encodes it structurally: **each light has one colour per theme,
and that colour is chosen to be legible as text.** Because a text-safe colour is automatically
safe as a fill (4.5:1 clears the 3:1 bar for non-text), one token per light per theme covers dots,
left rules, chips and words alike. There is no second "fill" palette to drift out of contrast.

The vivid brand hexes (`#3fb950` `#d29922` `#db6d28` `#f85149`) are kept **unchanged for dark
mode**, where they all measure above 4.8:1. Light mode gets darkened equivalents. The hue stays
recognisable in both; only the lightness moves.

### 4.2 Neutrals and surfaces

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0B1020` | `#F6F4EF` | Page ground. Light is the brand's *paper*. |
| `--surface` | `#141A2E` | `#FFFFFF` | Raised bands, nav. Dark is the brand's *ink*. |
| `--card` | `#181F33` | `#FFFFFF` | Cards, code panels. Dark matches the diagrams' card fill. |
| `--term-bg` | `#0E1424` | `#0E1424` | **The terminal is dark in both themes.** Same choice bun.sh makes: a terminal that turns white stops reading as a terminal. |
| `--fg` | `#F6F4EF` | `#141A2E` | Body and headings. |
| `--fg-muted` | `#A7B3CC` | `#4E5A73` | Secondary prose, captions, labels. |
| `--border` | `#2C3654` | `#D9D5CB` | Hairlines. Decorative only — never the sole carrier of state. |
| `--border-strong` | `#3A4870` | `#C9C4B8` | Card borders in light mode, dividers. |
| `--accent` | `#37DCA6` | `#076A4E` | Links, mint rules, `shipping` pills. Dark is the brand mint verbatim. |
| `--accent-hover` | `#5BE9BC` | `#0B7A5A` | Hover / focus. |
| `--focus` | `#5BE9BC` | `#076A4E` | Focus ring, 2px solid + 2px offset. |

**Measured contrast, dark theme:**

| Pair | Ratio | Bar | Verdict |
|---|---|---|---|
| `--fg` `#F6F4EF` on `--bg` `#0B1020` | **17.22:1** | 4.5 | pass AAA |
| `--fg` `#F6F4EF` on `--card` `#181F33` | **14.90:1** | 4.5 | pass AAA |
| `--fg-muted` `#A7B3CC` on `--bg` | **8.98:1** | 4.5 | pass AAA |
| `--fg-muted` `#A7B3CC` on `--card` | **7.77:1** | 4.5 | pass AAA |
| `--accent` `#37DCA6` on `--bg` | **10.77:1** | 4.5 | pass AAA |
| `--accent` `#37DCA6` on `--card` | **9.32:1** | 4.5 | pass AAA |
| `--focus` `#5BE9BC` on `--card` | **10.78:1** | 3.0 | pass |

**Measured contrast, light theme** (against `--bg` `#F6F4EF` and `--card` `#FFFFFF`):

| Pair | on `--bg` | on `--card` | Bar | Verdict |
|---|---|---|---|---|
| `--fg` `#141A2E` | **15.70:1** | **17.26:1** | 4.5 | pass AAA |
| `--fg-muted` `#4E5A73` | **6.30:1** | **6.92:1** | 4.5 | pass AA |
| `--accent` `#076A4E` | **6.01:1** | **6.60:1** | 4.5 | pass AA |
| `--focus` `#076A4E` | **6.01:1** | **6.60:1** | 3.0 | pass |

### 4.3 The four lights

One token per light per theme. Used for the word, the dot, the left rule and the chip border alike.

| Light | Dark hex | on `--card` `#181F33` | on `--term-bg` `#0E1424` | Light hex | on `--bg` `#F6F4EF` | on `--card` `#FFFFFF` |
|---|---|---|---|---|---|---|
| 🟢 `--green` | `#56D364` | **8.50:1** | **9.52:1** | `#14762F` | **5.22:1** | **5.73:1** |
| 🟡 `--yellow` | `#E3B341` | **8.41:1** | **9.43:1** | `#8A5A00` | **5.39:1** | **5.93:1** |
| 🟠 `--orange` | `#F0883E` | **6.47:1** | **7.25:1** | `#B54708` | **4.94:1** | **5.43:1** |
| 🔴 `--red` | `#FF7B72` | **6.49:1** | **7.28:1** | `#B42318` | **5.98:1** | **6.57:1** |

Every one of the eight clears 4.5:1 against every surface it can land on, with the tightest margin
being orange-on-light at 4.94:1. That is deliberate headroom: it is the pair that failed before, at
2.77:1.

**The vivid brand hexes are still used, in one place only:** the 4px top rule on the §2 cards and
the dots inside the dark terminal, where `#3fb950` (6.45:1 on card), `#d29922` (6.49:1),
`#db6d28` (4.86:1) and `#f85149` (4.88:1) all pass. They keep the page recognisable against the
`traffic-lights.svg` diagram and the real activity feed, both of which use them. A comment in the
stylesheet must say so, or someone will "unify" the two sets and break the light theme again.

**Never rely on colour alone.** Every light is accompanied by its word (`corrected`, `denied`,
`allowed`, `blocked`) and, inside the terminal, its emoji dot. A monochrome print of this page
must still be readable — that is the test.

### 4.4 Type

Self-hosted nothing, fetched nothing. Two system stacks. `Liberation Sans` and `DejaVu Sans` are
first in the sans stack **on purpose**: they are the faces `docs/diagrams/*.svg` and
`docs/branding/*.svg` name, so the page's type and the diagrams' type agree on a Linux reader's
screen instead of disagreeing by a hair.

```css
--font-sans: "Liberation Sans", "DejaVu Sans", system-ui, -apple-system,
             "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
             "Liberation Mono", "DejaVu Sans Mono", monospace;
```

| Token | Size | Line height | Tracking | Weight | Use |
|---|---|---|---|---|---|
| `--t-display` | `clamp(2.5rem, 1.55rem + 3.7vw, 4.25rem)` | 1.04 | `-0.03em` | 700 | Hero headline, the slogan in §3 |
| `--t-h2` | `clamp(1.75rem, 1.3rem + 1.8vw, 2.5rem)` | 1.12 | `-0.02em` | 700 | Section headings |
| `--t-h3` | `1.375rem` | 1.25 | `-0.01em` | 600 | Card titles |
| `--t-lead` | `clamp(1.0625rem, 1rem + 0.45vw, 1.3125rem)` | 1.55 | `0` | 400 | Hero subhead, section intros |
| `--t-body` | `1rem` | 1.65 | `0` | 400 | Prose |
| `--t-small` | `0.875rem` | 1.5 | `0` | 400 | Captions, table cells |
| `--t-micro` | `0.75rem` | 1.4 | `0.08em` | 600 | Eyebrows, pills — **uppercase** |
| `--t-code` | `0.875rem` | 1.6 | `0` | 400 | Code panels |
| `--t-term` | `clamp(0.75rem, 0.66rem + 0.35vw, 0.875rem)` | 1.62 | `0` | 400 | The demo terminal. Must not overflow at 320px |

Prose measure `max-width: 68ch`. Headings get `text-wrap: balance`, lead paragraphs
`text-wrap: pretty`. Base `font-size` is never set below `100%` — no `14px` body.

### 4.5 Spacing, radii, elevation, layout

```css
--sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px; --sp-5: 24px;
--sp-6: 32px; --sp-7: 48px; --sp-8: 64px; --sp-9: 96px; --sp-10: 128px;

--r-1: 6px;    /* chips, pills-with-corners, inline code */
--r-2: 10px;   /* buttons, small cards */
--r-3: 14px;   /* cards, code panels — matches rx="14" in traffic-lights.svg */
--r-4: 18px;   /* the terminal, hero panels — matches rx="18" in the same file */
--r-full: 999px; /* dots, status pills */

--section-y: clamp(4rem, 8vw, 7.5rem);   /* block padding per section */
--gutter:    clamp(1.25rem, 4vw, 2.5rem); /* inline page padding */
--w-content: 1120px;                      /* max content width */
--w-prose:   68ch;

/* Dark mode uses borders, not shadows. Light mode uses both. */
--shadow-1: 0 1px 2px rgba(20, 26, 46, .06), 0 8px 24px -14px rgba(20, 26, 46, .18);
--shadow-2: 0 2px 4px rgba(20, 26, 46, .07), 0 18px 44px -20px rgba(20, 26, 46, .24);
```

Breakpoints, min-width, three only: **640px** (one-up → two-up, nav condenses back),
**900px** (hero becomes two columns; three-up grids), **1120px** (four-up grids; content hits its
max width).

### 4.6 Theming mechanics

Light is defined on bare `:root`. Dark is redefined twice — once under
`@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])`, and once under
`:root[data-theme="dark"]` — so the toggle wins in both directions and the system default needs no
attribute. A three-state toggle (`system → light → dark`) writes `localStorage.ssTheme`, wrapped in
`try/catch` because a private window throws. An inline script in the document head reads it and
stamps `data-theme` **before first paint**, so there is no flash. `<meta name="color-scheme"
content="light dark">` is set. `body` gets an explicit `background: var(--bg)` — never transparent.

---

## 5. The interactive centrepiece: the demo terminal

A self-contained fake terminal that plays out two scenes. Pure HTML/CSS/JS, one `<pre>`, no
canvas, no library, no build step. Roughly 160 lines of JavaScript.

### 5.1 What it must be honest about

The terminal chrome carries a permanent, always-visible chip reading
**`Demonstration · not a recording`** in muted micro type, beside the three window dots. This is
not optional. A page whose product claim is *evidence* cannot show synthetic terminal output that
a reader might mistake for a capture. The README already refuses to mock up `session-sitter status`
output for exactly this reason; the site holds the same line, and buys the freedom to animate by
labelling the thing plainly.

The field names in the audit record below are real where the record already exists:
`request_id`, `session_name`, `host`, `source`, `state`, `decided_by` are the on-disk snake_case
fields of `SupervisionRecord` in `src/supervisor/models.ts`, and `yellow_delivered` /
`rule` are real values of `SupervisionState` and `DecidedBy`. The additions — `clause`, `tool`,
`from`, `to`, `latency_ms`, `at` — come from the plugin design record's audit-JSONL section. Do not
change them casually; they are the contract the CLI will query.

### 5.2 The frame model

```js
// A scene is an ordered list of frames. Each frame either APPENDS lines to a
// growing transcript, or MUTATES a line already in it (the counters).
// { caption, hold, lines: [[cls, text], …] }        → append
// { caption, hold, mutate: { at: -3, text, cls } }  → rewrite one line in place
// { caption, hold, type: [cls, text] }              → append, typed char by char
```

Classes map to tokens: `dim` → `#8B97AF` · `fg` → `#F6F4EF` · `user` → `#79C0FF` ·
`mint` → `#37DCA6` · `green` → `#3fb950` · `yellow` → `#d29922` · `orange` → `#db6d28` ·
`red` → `#f85149` · `add` → `#3fb950` · `del` → `#f85149`. All measured against `--term-bg`
`#0E1424` in §4.3 and §4.2; the lowest is `#db6d28` at 5.62:1.

**Authoring rule: every line is ≤ 56 characters.** The `<pre>` is `white-space: pre-wrap;
overflow-wrap: anywhere` with a hanging indent (`text-indent: -2ch; padding-left: 2ch`) so a line
that does wrap at 320px reads as a continuation rather than a new line. There is no horizontal
scrollbar at any width. The panel has a fixed `min-height` equal to its tallest scene so the page
does not reflow as frames append.

### 5.3 Scene A — "A force-push, corrected" (default, autoplays once)

Tab label: **`A force-push, corrected`**. Total ≈ 18 s.

| # | Caption (shown under the terminal, `aria-live="polite"`) | Hold | Lines appended — exact text |
|---|---|---|---|
| A1 | `02:14 · nobody is watching` | 1000 | `dim` `~/w/payments-api  release/2.4  ·  claude code` |
| A2 | `the last instruction of the night` | 700 | *(blank)*<br>**typed**, 18 ms/char: `mint` `> ` then `fg` `ship the retry-backoff fix to the release branch` |
| A3 | `the agent proposes a tool call` | 1200 | *(blank)*<br>`fg` `● Bash(git push --force origin release/2.4)`<br>`dim` `  dropping the reverted commit from the branch` |
| A4 | `Claude Code would stop here and ask you` | 1400 | *(blank)*<br>`dim` `⟳ session-sitter · PermissionRequest`<br>`dim` `  deterministic tier · no model call · 0 ms`<br>then **mutate** that last line's `0 ms` → `8 ms`, counting up over 500 ms |
| A5 | `the clause that applied, by name` | 2600 | *(blank)*<br>`yellow` `🟡 corrected — practices §4`<br>`fg` `   "Never force-push a shared branch. Use`<br>`fg` `    --force-with-lease, so a concurrent push`<br>`fg` `    fails loudly instead of being overwritten."`<br>`dim` `   team/bottom-line.md · team-git-004 · high` |
| A6 | `the call is rewritten, not blocked` | 2200 | *(blank)*<br>`dim` `  decision.updatedInput`<br>`del` `- git push --force origin release/2.4`<br>`add` `+ git push --force-with-lease origin release/2.4`<br>`dim` `  re-checked against your deny rules · allowed` |
| A7 | `the run continues` | 1600 | *(blank)*<br>`dim` `To github.com:acme/payments-api.git`<br>`dim` ` + 9f1c2ad...4b7e0d1 release/2.4 -> release/2.4`<br>`green` `✓ Bash completed · no human was woken` |
| A8 | `one durable record, written at the time` | 2800 | *(blank)*<br>`dim` `$ tail -1 ~/.session-sitter/audit.jsonl`<br>`fg` `{"request_id":"req-8f3c1a","state":"yellow_delivered",`<br>`fg` ` "session_name":"payments-api","host":"nomad",`<br>`fg` ` "source":"claude-code","decided_by":"rule",`<br>`fg` ` "clause":"team-git-004","tool":"Bash","latency_ms":8,`<br>`fg` ` "from":"git push --force origin release/2.4",`<br>`fg` ` "to":"git push --force-with-lease origin release/2.4",`<br>`fg` ` "at":"2026-09-02T02:14:37Z"}` |
| A9 | `and it is queryable in the morning` | 3000 | *(blank)*<br>`dim` `$ session-sitter log --since 22:00 --corrected`<br>`yellow` `02:14  corrected  §4  --force → --force-with-lease`<br>`yellow` `03:02  corrected  §7  rm -rf → git clean -nd`<br>`red` `04:41  denied     §2  Write .github/workflows/`<br>`dim` `3 decisions · 2 corrected · 1 denied · 0 escalated` |
| A10 | `Silence is never approval.` | end | *(blank)*<br>`mint` `Silence is never approval.` |

A9's three rows are illustrative sibling decisions in the same fictional repository, which is what
the `Demonstration · not a recording` chip exists to declare. They are not counts of anything real.

### 5.4 Scene B — "Nobody answered" (second tab, plays on demand)

Tab label: **`Nobody answered`**. Total ≈ 11 s. This scene exists because the headline slogan is
*silence is never approval*, and Scene A — a correction — cannot demonstrate it. Deny-on-timeout is
the principle the whole project is built on; it needs its own eleven seconds.

| # | Caption | Hold | Lines appended — exact text |
|---|---|---|---|
| B1 | `03:58 · a genuine judgment call` | 900 | `dim` `~/w/payments-api  release/2.4  ·  claude code`<br>*(blank)*<br>`fg` `● Bash(gh release create v2.4.0 --latest)`<br>`dim` `  publishing the release the fix went into` |
| B2 | `no clause covers it — so it is your call` | 1300 | *(blank)*<br>`dim` `⟳ session-sitter · PermissionRequest`<br>`orange` `🟠 escalated — no clause covers a public release`<br>`dim` `   decision card sent · nomad · replies to you` |
| B3 | `the countdown is compressed for this demo` | 3600 | *(blank)*<br>`orange` `   waiting on you   15:00`<br>`dim` `   Approve · Deny · Deny and tell it why`<br>then **mutate** the `waiting on you` line, `15:00` ticking to `00:00` in ~24 steps over 3.5 s |
| B4 | `the timeout is a denial, never an approval` | 2800 | *(blank)*<br>`red` `🔴 denied — timeout · 15:00 elapsed, no answer`<br>`fg` `   the agent was handed the alternatives:`<br>`dim` `    · open a draft release and stop`<br>`dim` `    · wait for a human at 09:00`<br>`green` `✓ the run continued on the safe path` |
| B5 | `Silence is never approval.` | end | *(blank)*<br>`mint` `An unanswered card denies. It never approves.` |

### 5.5 Controls and interaction

Below the terminal, one row: two tab buttons (`A force-push, corrected` / `Nobody answered`), a
frame-dot strip (10 dots for A, 5 for B, current one filled), and `▶ Replay`. Nothing else.

- **Autoplay:** Scene A plays **once** on load, and only if the terminal is at least 50% visible
  (`IntersectionObserver`) and `prefers-reduced-motion` is not `reduce`. It never loops. A hero
  animation that loops forever is the single most common way these pages become annoying.
- **Tabs:** real `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-selected`, arrow-key
  navigation, and `tabindex="-1"` on unselected tabs. Switching tabs resets and plays that scene.
- **Frame dots:** buttons, each with `aria-label="Frame 4 of 10: the clause that applied, by name"`.
  Clicking one jumps to the *end state* of that frame — no re-typing, instant.
- **Keyboard, when the demo has focus:** `Space` play/pause · `→` next frame · `←` previous frame ·
  `Home` restart. Documented in visible micro type beneath the controls, not hidden in a tooltip.
- **Pause on blur:** `document.hidden` pauses; visibility returning does *not* auto-resume.

### 5.6 Reduced motion and screen readers

- `@media (prefers-reduced-motion: reduce)`: **no autoplay, no typing, no counters, no blinking
  caret.** The terminal renders the complete final transcript of Scene A immediately, statically.
  The caption line reads `Animation off — the full transcript is shown.` `▶ Replay` becomes
  `Show the timeout case`, which swaps in Scene B's full static transcript. The information is
  identical; only the motion is gone.
- The animated `<pre>` is `aria-hidden="true"`. Beside it sits the same content as a
  visually-hidden `<div>` containing both scenes in full as static text with a heading each, so a
  screen reader gets the whole story in reading order without being interrupted by frame updates.
- The caption element is the only `aria-live="polite"` region, so a screen-reader user hears the ten
  captions — which are themselves a complete summary of the scene — rather than the whole buffer.
- A visible `<details>` disclosure, **`Read the demo as text`**, expands the same static transcript
  for anyone who would rather read than watch. This is also the no-JS fallback: the `<details>`
  content is in the HTML, so with JavaScript disabled the demo degrades to a readable transcript
  and the controls are hidden by a `.js-only { display: none }` rule that a tiny inline script
  removes.
- The blinking caret is a CSS `@keyframes` on `opacity`, disabled under reduced motion, and never
  faster than 1 Hz (WCAG 2.3.1 flash safety is nowhere near threatened, but 1 Hz is also simply
  calmer).

---

## 6. Constraints, and how each is satisfied

| Constraint | How |
|---|---|
| **GitHub Pages, no build step** | Settings → Pages → *Deploy from a branch* → `main`, folder `/docs`. `docs/index.html` becomes the site root. No Actions workflow, no Jekyll config, nothing to compile. |
| **Jekyll must not touch it** | Add an empty `docs/.nojekyll`. Without it, Jekyll would try to process the `.md` design records under `docs/superpowers/` and could rewrite or omit files. |
| **The docs stay on GitHub** | With `.nojekyll`, `docs/*.md` is served as raw text, which is a worse read than GitHub's own renderer — and GitHub renders the mermaid blocks in `SUPERVISION.md` natively, which the raw file cannot. So **every documentation link on the site points at `https://github.com/eranra/session-sitter/blob/main/docs/…`**. No site-relative `.md` links. |
| **No external fetches** | System font stacks only (§4.4). No CDN, no analytics, no GitHub star badge (it would be a network call to shields.io *and* an unverifiable number). Two local files: `site/site.css`, `site/demo.js`. |
| **Zero runtime dependencies holds** | The page adds no entry to `package.json`. Verified today: `dependencies` is `{}`. |
| **Assets are reused, never duplicated** | `docs/index.html` sits beside `docs/screenshots/`, `docs/branding/` and `docs/diagrams/`, so every image is a short relative path. Nothing is copied. |
| **Responsive** | Three min-width breakpoints; fluid `clamp()` type and spacing; no fixed pixel widths on containers; images `max-width: 100%; height: auto`; the terminal wraps rather than scrolls. Must be checked at 320, 375, 768, 1024, 1440. |
| **Accessible** | Skip link; one `<h1>`; landmarks (`header`/`nav`/`main`/`footer`) and `<section aria-labelledby>`; visible 2px focus ring at 2px offset on every interactive element; real `<button>`s and `<a>`s only; 4.5:1 on all text and 3:1 on the ring, measured in §4; reduced-motion honoured; alt text per §7; state never carried by colour alone. |
| **`ci/check-links.mjs` stays green** | It walks tracked `.md` files only, and skips `docs/superpowers/`, so `index.html` is outside its scope and this design record is not linted. The implementer should still not break any existing `.md`. |
| **Spellcheck** | CI runs a spellchecker over the docs. New product nouns in this file and in `index.html` may need entries in the project dictionary — check before pushing. |

### One prerequisite, and one judgement call left open

- **`docs/branding/social-preview.png` is one regeneration behind its SVG source.** Per
  `docs/branding/README.md`, the PNG still reads the pre-0.9 tagline *"a babysitter for your AI
  coding sessions"*. It is the natural `og:image`. **If `inkscape` is available, run
  `bash docs/branding/regen.sh` first and commit the refreshed PNGs.** If it is not, ship the page
  with the stale PNG as `og:image` anyway — a missing social card is worse than a slightly old
  tagline, and the file is correct in size and composition. Do not hand-edit it.
- `package.json` has no `license` field even though `LICENSE` is MIT and the README badge says MIT.
  Unrelated to this page; noted here because the footer asserts MIT. Not this change's job to fix.

---

## 7. Every image the page uses

All fourteen paths below were checked against the filesystem on 2026-09-02. **No other image may
be referenced, and none may be invented.** Paths are relative to `docs/index.html`.

| Path | Where | Alt text (exact) |
|---|---|---|
| `branding/wordmark-light.svg` | nav + footer, light theme | *(decorative beside a text link — `alt=""`, the adjacent link carries the name)* |
| `branding/wordmark-dark.svg` | nav + footer, dark theme | *(as above)* |
| `branding/logo.svg` | favicon (`<link rel="icon" type="image/svg+xml">`) | — |
| `branding/logo-256.png` | fallback favicon (`<link rel="icon" sizes="256x256">`) | — |
| `branding/social-preview.png` | `og:image` / `twitter:image`, 1280×640 | `Session Sitter` |
| `diagrams/traffic-lights.svg` | §3 | `The four supervision lights. Green: the action is fine — approve, record, no human contact. Yellow: a safe correction — inject labeled guidance and the agent self-corrects. Orange: your call — block it and send a decision card with a countdown; on timeout, deny and hand over safe alternatives. Red: policy, not judgment — block outright and alert; on timeout the block stands. Silence is never approval: an unanswered card denies the action and never writes an approval.` |
| `diagrams/architecture.svg` | §7 | `One supervision engine beneath three front ends — the VS Code panel, the Claude Code plugin's hooks, and the terminal CLI — driving the decision, the record, and the notification.` |
| `screenshots/panel-light.png` | §5, light | `The Session Sitter panel: a worklist of live sessions across four agents, above the supervision activity feed.` |
| `screenshots/panel-dark.png` | §5, dark | *(same alt)* |
| `screenshots/panel-needs-you-light.png` | §5, light | `The worklist sorted needs-you-first, with one session waiting on a human decision.` |
| `screenshots/panel-needs-you-dark.png` | §5, dark | *(same alt)* |
| `screenshots/activity-light.png` | §5, light | `The supervision activity feed, one card per decision, each naming its light and whether an AI or a rule decided it.` |
| `screenshots/activity-dark.png` | §5, dark | *(same alt)* |
| `screenshots/panel-wide-dark.png` | §1 hero, behind/below the terminal at ≥1120px only, `loading="lazy"` | `The panel open beside an editor, showing the session list in context.` |

Also present on disk and **available but unused** by this design, listed so nobody hunts for them:
`screenshots/hover-preview-{light,dark}.png`, `screenshots/sort-menu-{light,dark}.png`,
`screenshots/toolbar-menu-{light,dark}.png`, `branding/lockup-{light,dark}.{svg,png}`,
`branding/wordmark-{light,dark}.png`, `branding/logo-1024.png`, `branding/social-preview.svg`.
`hover-preview-*` is the obvious candidate if §5 ever wants a fourth card.

Note that `docs/screenshots/README.md` still opens with *"This directory is empty on purpose"* and
lists filenames (`panel-worklist.png`, `activity-feed.png`) that were never used — the real shots
landed under different names. That file is stale, not authoritative. **Trust the filesystem, and
the table above.**

Every `<picture>` follows the pattern the README already uses, and every raster image gets
`width`/`height` attributes to reserve space:

```html
<picture>
  <source media="(prefers-color-scheme: light)" srcset="screenshots/panel-light.png">
  <img src="screenshots/panel-dark.png" width="680" height="1400" loading="lazy"
       decoding="async" alt="The Session Sitter panel: …">
</picture>
```

Because the theme toggle can override `prefers-color-scheme`, `<picture>` alone is not enough: the
CSS also renders both images and hides one with `[data-theme="light"] .shot-dark { display: none }`
and its mirror. Both approaches together mean the correct image shows whether the reader used the
toggle or their OS setting. Cost: one extra image download on the screenshot section only, which is
`loading="lazy"` and below the fold.

---

## 8. Wireframe — desktop (≥1120px)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [logo] Session Sitter      Demo  Why  Practices  Install  Docs  GitHub      [◐ theme]    │ 56px sticky
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  AGENT GOVERNANCE FOR CODING AGENTS      ┌───────────────────────────────────────────┐   │
│                                          │ ● ● ●   Demonstration · not a recording   │   │
│  Agents run unattended.                  ├───────────────────────────────────────────┤   │
│  Your written rules decide.              │ ~/w/payments-api  release/2.4  · claude   │   │
│                                          │                                           │   │
│  Session Sitter answers every             │ > ship the retry-backoff fix to the      │   │  §1 HERO
│  permission prompt against your          │   release branch                          │   │  demo autoplays
│  team's own practices — naming the        │                                           │   │  once, right col
│  clause it applied, rewriting an         │ ● Bash(git push --force origin release…)  │   │
│  unsafe command into the safe one        │                                           │   │
│  instead of blocking the run, and        │ ⟳ session-sitter · PermissionRequest      │   │
│  writing one durable record per          │   deterministic tier · no model · 8 ms    │   │
│  decision.                               │                                           │   │
│                                          │ 🟡 corrected — practices §4               │   │
│  ┌───────────────────────────┐ ┌───────┐ │    "Never force-push a shared branch…"    │   │
│  │ Watch a force-push get    │ │ Read  │ │                                           │   │
│  │ corrected                 │ │ docs →│ │ - git push --force origin release/2.4     │   │
│  └───────────────────────────┘ └───────┘ │ + git push --force-with-lease origin …    │   │
│  Install the extension                   │ ✓ Bash completed · no human was woken     │   │
│                                          └───────────────────────────────────────────┘   │
│  Claude Code · IBM Bob IDE · Codex CLI    [A force-push, corrected][Nobody answered]     │
│  · VS Code Chat — across windows,         ●●●●○○○○○○   ▶ Replay                          │
│  across machines.                         Space play/pause · ← → step · Home restart     │
│  Zero runtime deps · TS only · 868        ▸ Read the demo as text                        │
│  tests · MIT                                                                             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  ▬▬▬green▬▬▬        ▬▬▬yellow▬▬▬        ▬▬▬orange▬▬▬        ▬▬▬red▬▬▬                    │
│ ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │
│ │ It cites the │   │ It doesn't   │   │ It survives  │   │ It leaves an │                │  §2 CLAIMS
│ │ clause       │   │ block the    │   │ the night    │   │ audit trail  │                │  four-up
│ │              │   │ run. It      │   │              │   │              │                │
│ │ two lines of │   │ fixes the    │   │ two lines    │   │ two lines    │                │
│ │ body         │   │ call.        │   │              │   │              │                │
│ │ ┄mono frag┄  │   │ ┄mono frag┄  │   │ ┄mono frag┄  │   │ ┄mono frag┄  │                │
│ └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘                │
├══════════════════════════════════ ink band, both themes ═════════════════════════════════┤
│                          Silence is never approval.                                      │
│        An orange card that nobody answers denies the action. It never writes an           │
│        approval. A red one that nobody answers stays blocked. That is the whole rule.     │  §3 SILENCE
│                                                                                          │
│  ┌────────────────────────── diagrams/traffic-lights.svg ─────────────────────────────┐  │
│  │  🟢 Green        🟡 Yellow        🟠 Orange        🔴 Red                            │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│               ┌── Scene B replay: "Nobody answered" (5 frames) ──┐                       │
├══════════════════════════════════════════════════════════════════════════════════════════┤
│  Isn't this already in Claude Code?                                                      │
│  Partly, and it is worth being exact about which parts.                                   │
│                                                                                          │
│  ┌ First-party today ─────────────────┐ ▎┌ What is left over ────────────────────────┐   │  §4 WHY
│  │ Agent view is a worklist of Claude │ ▎│ Four agents wide, unioned across every    │   │  two rows,
│  │ Code sessions… local to that       │ ▎│ window and across peer machines over SSH  │   │  not a matrix
│  │ machine and that one agent.        │ ▎│                                            │   │
│  └────────────────────────────────────┘ ▎└────────────────────────────────────────────┘   │
│  ┌ First-party today ─────────────────┐ ▎┌ What is left over ────────────────────────┐   │
│  │ Auto mode blocks the irreversible  │ ▎│ Your clause, by name. The rewrite. The    │   │
│  │ calls, on by default. Leave it on. │ ▎│ deny-on-timeout. One durable record.      │   │
│  │ It reports "Blocked by classifier."│ ▎│ Both layers can be on at once.            │   │
│  └────────────────────────────────────┘ ▎└────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  See it in your editor                                                                   │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐                               │  §5 PANEL
│  │ panel-*.png   │   │ panel-needs-  │   │ activity-*.png│                               │  three-up
│  │               │   │ you-*.png     │   │               │                               │  theme-aware
│  └───────────────┘   └───────────────┘   └───────────────┘                               │
│  caption            caption             caption                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Your practices are the policy                                                           │
│  ┌ team/bottom-line.md ───────────────┐  →  ┌ the decision it produced ──────────────┐   │  §6 PRACTICES
│  │ ### Intention: never force-push a  │     │ 🟡 corrected — practices §4            │   │  input → output
│  │ shared branch                      │     │    team-git-004 · confidence high      │   │
│  │ | id | team-git-004 |              │     │                                        │   │
│  │ | level | yellow |                 │     │ {"clause":"team-git-004",              │   │
│  │ | confidence | high |              │     │  "state":"yellow_delivered", …}        │   │
│  └────────────────────────────────────┘     └────────────────────────────────────────┘   │
├══════════════════════════════════════════════════════════════════════════════════════════┤
│  One engine, three front ends                                                            │
│  ┌───────────────────── diagrams/architecture.svg ─────────────────────────────────────┐ │  §7 ENGINE
│  └─────────────────────────────────────────────────────────────────────────────────────┘ │
│  VS Code panel  (shipping)   ·   Supervisor CLI  (shipping)   ·   Claude Code plugin     │
│                                                        (designed, not built → the spec)  │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Install                                          What you need                          │
│  ⚠ The Claude Code plugin is the plan and is      VS Code / IBM Bob IDE   1.65+          │  §8 INSTALL
│    not built yet.                                 Linux, WSL or macOS     liveness       │
│  ┌ From the latest release ────────┐ [copy]       python3                 Bob only       │
│  │ code --install-extension …vsix  │              Node 20+                from source    │
│  └─────────────────────────────────┘                                                     │
│  ┌ From source ────────────────────┐ [copy]                                              │
│  │ git clone … && make install     │                                                     │
│  └─────────────────────────────────┘                                                     │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Documentation                                                                           │
│  ┌ ARCHITECTURE ──────┐ ┌ SUPERVISION ───────┐                                           │  §9 DOCS
│  ┌ KNOWLEDGE ─────────┐ ┌ CORPUS ────────────┐   ┌ CONFIGURATION ─────┐                  │  → github.com
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ [logo] Session Sitter    MIT · GitHub · Security · Contributing   Silence is never appr. │ FOOTER
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 9. Wireframe — mobile (320–639px)

```
┌────────────────────────────┐
│ [logo] Sitter  Docs ⌂  ◐   │ sticky, nav condensed
├────────────────────────────┤
│ AGENT GOVERNANCE FOR       │
│ CODING AGENTS              │
│                            │
│ Agents run                 │
│ unattended.                │  display type wraps
│ Your written               │  to 3–4 lines
│ rules decide.              │
│                            │
│ Session Sitter answers     │
│ every permission prompt    │
│ against your team's own    │
│ practices — naming the     │
│ clause it applied, …       │
│                            │
│ ┌────────────────────────┐ │
│ │ Watch a force-push get │ │  primary CTA, full width
│ │ corrected              │ │  → scrolls to the demo
│ └────────────────────────┘ │     and starts it
│ ┌────────────────────────┐ │
│ │ Read the docs →        │ │
│ └────────────────────────┘ │
│ Install the extension      │
│                            │
│ ┌────────────────────────┐ │
│ │●●● Demonstration ·     │ │  the demo, full bleed
│ │    not a recording     │ │  minus the gutter.
│ ├────────────────────────┤ │  Lines ≤56ch wrap with
│ │ > ship the retry-      │ │  a 2ch hanging indent.
│ │   backoff fix to the   │ │  Fixed min-height so
│ │   release branch       │ │  the page never jumps.
│ │                        │ │
│ │ ● Bash(git push        │ │
│ │   --force origin       │ │
│ │   release/2.4)         │ │
│ │                        │ │
│ │ 🟡 corrected —         │ │
│ │    practices §4        │ │
│ │                        │ │
│ │ - git push --force …   │ │
│ │ + git push --force-    │ │
│ │   with-lease …         │ │
│ └────────────────────────┘ │
│ ┌──────────┐┌────────────┐ │  tabs stack to two
│ │ corrected││ Nobody     │ │  full-width buttons
│ └──────────┘└ answered ──┘ │
│ ●●●●○○○○○○      ▶ Replay   │
│ ▸ Read the demo as text    │
│                            │
│ Claude Code · IBM Bob IDE  │
│ · Codex CLI · VS Code Chat │
│ Zero runtime deps · TS     │
│ only · 868 tests · MIT     │
├────────────────────────────┤
│ ▬▬green▬▬                  │
│ ┌────────────────────────┐ │  §2, one-up
│ │ It cites the clause    │ │
│ └────────────────────────┘ │
│ ▬▬yellow▬▬                 │
│ ┌────────────────────────┐ │
│ │ It doesn't block the   │ │
│ │ run. It fixes the call.│ │
│ └────────────────────────┘ │
│ … orange, red …            │
├════════════════════════════┤
│ Silence is never           │  §3 ink band
│ approval.                  │
│ ┌────────────────────────┐ │
│ │ traffic-lights.svg     │ │  scales to width;
│ │ (scrolls in its own    │ │  it is 1200×440, so
│ │  overflow-x container) │ │  it also gets an
│ └────────────────────────┘ │  overflow-x wrapper
│ ┌ Scene B replay ────────┐ │
├════════════════════════════┤
│ Isn't this already in      │  §4, rows stack:
│ Claude Code?               │  "First-party today"
│ ┌ First-party today ─────┐ │  then "What is left
│ └────────────────────────┘ │  over" beneath it,
│ ┌ What is left over ─────┐ │  mint left rule kept
│ └────────────────────────┘ │
│ (× 2)                      │
├────────────────────────────┤
│ See it in your editor      │  §5 becomes a
│ ┌──────┐┌──────┐┌──────┐   │  scroll-snap rail,
│ │panel ││needs ││activ.│ → │  one card per view,
│ └──────┘└──────┘└──────┘   │  dots beneath
│ ● ○ ○                      │
├────────────────────────────┤
│ Your practices are         │  §6 stacks with a
│ the policy                 │  ↓ glyph between
│ ┌ bottom-line.md ────────┐ │  the two panels
│ └────────────────────────┘ │
│            ↓               │
│ ┌ the decision ──────────┐ │
│ └────────────────────────┘ │
├════════════════════════════┤
│ One engine, three          │  §7; the SVG gets
│ front ends                 │  an overflow-x
│ ┌ architecture.svg ──────┐ │  container too
│ └────────────────────────┘ │
│ panel      [shipping]      │  status rows stack
│ CLI        [shipping]      │
│ plugin     [designed]      │
├────────────────────────────┤
│ Install                    │  §8
│ ⚠ the plugin is not        │
│   built yet                │
│ ┌ code --install-… ─┐[⧉]  │  copy button inside
│ └───────────────────┘      │  the block, top-right
│ What you need              │
│ VS Code / Bob    1.65+     │  definition list
├────────────────────────────┤
│ Documentation              │  §9, one-up cards
│ ┌ ARCHITECTURE ──────────┐ │
│ ┌ SUPERVISION ───────────┐ │
│ … 3 more …                 │
├────────────────────────────┤
│ [logo] Session Sitter      │
│ MIT · GitHub · Security    │
│ Silence is never approval. │
└────────────────────────────┘
```

---

## 10. File layout

```
docs/
├── index.html            NEW — the whole page. One file, ~600 lines including all
│                              copy and the static demo transcripts. No templating.
├── .nojekyll             NEW — empty. Stops Jekyll processing docs/.
├── site/                 NEW
│   ├── site.css                the design tokens from §4, then the sections in
│   │                           document order. Mobile-first. ~700 lines.
│   └── demo.js                 the frame player from §5. ~160 lines. Also carries
│                               the copy-to-clipboard handler and the scroll-snap
│                               dots, because they are ten lines each and a third
│                               file would be a third HTTP request for nothing.
├── branding/             existing — wordmarks, logo, social preview. Untouched.
├── diagrams/             existing — traffic-lights.svg, architecture.svg. Untouched.
├── screenshots/          existing — the ten panel PNGs. Untouched.
├── ARCHITECTURE.md       existing — linked to on github.com, not served.
├── CONFIGURATION.md      existing
├── CORPUS.md             existing
├── KNOWLEDGE.md          existing
├── LAUNCH.md             existing
├── README.md             existing — the docs index.
├── SUPERVISION.md        existing
└── superpowers/specs/2026-09-02-site-design.md   THIS FILE
```

The inline `<script>` in the head is the only fourth piece of code, and it is four lines: read
`localStorage.ssTheme` in a `try/catch`, stamp `data-theme`, strip the `no-js` class.

Nothing else changes. In particular:

- **No change to `package.json`.** No dependency, no script. The zero-dependency claim holds.
- **No change to `README.md`** in this commit. Once the site is live, a single line linking to it
  belongs at the top of the README — a separate, one-line change.
- **No CI workflow.** Pages deploys from the branch. If a Pages build check is wanted later, it is a
  separate decision.
- **No `CNAME`.** The site lives at `https://eranra.github.io/session-sitter/`, so every asset path
  must be **relative** (`site/site.css`, not `/site/site.css`) or the sub-path deployment breaks.
  This is the single most common way a GitHub Pages project site ships broken.

---

## 11. Acceptance — how we will know it is right

1. `docs/index.html` opens correctly from `file://` with no console errors and no network requests.
   Verify the latter in the browser's network panel: the count must be **three** — the HTML, the
   CSS, the JS — plus local images. Any fourth origin is a bug.
2. Scene A plays to its last frame, once, and stops. Scene B plays on demand. Both are readable at
   320px with no horizontal scrollbar anywhere on the page.
3. `prefers-reduced-motion: reduce` (DevTools → Rendering → Emulate CSS media feature): nothing
   animates, and the full Scene A transcript is present as static text.
4. With JavaScript disabled: the page reads completely, the demo controls are hidden, and
   `Read the demo as text` is open or openable with both transcripts inside.
5. Keyboard only, from the address bar: skip link → nav → CTAs → demo tabs → frame dots → replay →
   every link and copy button, in document order, each with a visible ring. No focus trap.
6. Every ratio in §4 re-measured against the shipped CSS. The cheapest way is to extend the pattern
   `src/test/WebviewContrast.test.ts` already establishes: read the hexes out of `docs/site/site.css`
   and assert ≥ 4.5:1 for text tokens and ≥ 3:1 for the focus ring, in both themes. **Do this.** The
   contrast bug this project already shipped once existed precisely because nothing was counting.
7. Theme toggle: system → light → dark → system, surviving a reload, with no flash of the wrong
   theme on load, and the screenshots swapping with it.
8. `node ci/check-links.mjs` and the full `make check` stay green.
9. Read the page aloud in a screen reader once. The ten captions must, on their own, tell the story.
10. Nothing on the page states a fact that is not verified: no star count, no testimonial, no user
    number, no claim that the Claude Code plugin exists. The three credibility facts were measured
    on 2026-09-02 — `dependencies: {}` in `package.json`, TypeScript-only enforced by
    `ci/check-no-python.sh` and `ci/check-naming.sh`, and `868 passed (868)` across 41 files from
    `npx vitest run`. Re-run the suite before shipping and correct the number if it moved.
