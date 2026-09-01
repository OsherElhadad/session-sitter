# Launch

A working checklist for whoever ships this, not marketing copy. Everything here comes from an
ecosystem survey done on 2026-09-01; the star counts and velocities are that day's, and they age.
Where a claim is a judgment rather than a measurement it says so.

The one framing decision to make first: **do not launch this as a session dashboard.** Claude Code
shipped Agent view (a first-party session worklist) and Auto mode (a first-party permission
classifier, on by default on Pro, Max and Team). A post that leads with either half reads as a
re-implementation of something the reader already has. Lead with what is unclaimed — written policy,
the correction, the evidence — and be first to name the first-party features yourself. The README's
*"Isn't this already in Claude Code?"* section is the tone to reuse.

---

## Vectors, in priority order

### 1. A PR into awesome-claude-code — day one

<https://github.com/hesreallyhim/awesome-claude-code> (~53k★, ~107★/day). This is the
highest-leverage single action available, and it is a pull request, not a launch.

Then take the badge, which is native social proof in this ecosystem:

```markdown
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)
```

Two more lists worth a PR at the same time:

- <https://github.com/quemsah/awesome-claude-plugins> (~1.2k★) — tracks plugin adoption metrics,
  so being listed there is measurable rather than decorative.
- ClaudeLog — carries its own badge, which several high-velocity repos display.

**Do not add any of these badges before the PR merges.** A badge claiming a listing that does not
exist is the exact opposite of the credibility this project is trying to signal.

### 2. Ship as a plugin marketplace repo

Install has to be two slash commands, because the repos that move in this ecosystem all have a
one-line install with no config file, no API key and no account:

```
/plugin marketplace add eranra/session-sitter
/plugin install session-sitter@session-sitter
```

That needs `.claude-plugin/marketplace.json` at the repo root and the plugin itself under
`plugin/` — the shape is in
[`superpowers/specs/2026-09-01-claude-code-plugin-design.md`](superpowers/specs/2026-09-01-claude-code-plugin-design.md).
While installation is still `git clone && make install`, most of the traffic from any of the vectors
below is wasted.

Also register, so Claude Code suggests the plugin itself:

- plugin hints — <https://code.claude.com/docs/en/plugin-hints>
- a relevance block — <https://code.claude.com/docs/en/plugin-relevance>

And submit to the official marketplace through the Console form when the plugin validates
(`claude plugin validate ./plugin --strict` exiting 0 is the precondition, and it is already
required in CI by the design).

### 3. Show HN — but the artifact is the post

Submit at <https://news.ycombinator.com/submit>.

The framing that works is a night's evidence, not a feature list:

> *I let Claude Code run overnight and it did 200 things — here's the log, and here are the 3 it
> asked me about.*

So the post is a screenshot of one real overnight digest: the decision count, the three escalations,
and one correction with the practice it cited. That is a stronger post than any description of the
product, and it is only writable once the audit-query surface exists. **Do not submit before you
have a real night to show.** *(Judgment, not measurement.)*

### 4. r/ClaudeAI and r/ClaudeCode

Lead with the concrete, narrow thing: the wedged-agent detector, or a before/after count of how many
prompts a week of real work produced. Not the dashboard — that reads as Agent view with extra steps.

### 5. The 20-second GIF

One loop, silent, no narration: a `git push --force` prompt becoming `--force-with-lease`
automatically, with the cited practice visible on screen. That single loop is the whole product, and
every high-velocity repo in this ecosystem puts a demo above the fold before it explains anything.

The capture instructions are in [`screenshots/README.md`](screenshots/README.md). It is the first
asset to make and the last thing missing.

---

## The badge set worth carrying

Ecosystem badges carry weight here; generic CI badges mostly do not. Current README already has CI,
TypeScript-only, VS Code version and MIT — keep those, and add each of the following **only when it
is true**:

| Badge | Earn it by |
|---|---|
| Mentioned in Awesome Claude Code | the PR in vector 1 merging |
| ClaudeLog | being listed there |
| Agent Skills compatible | shipping the skills the plugin design commits to |
| Marketplace version / installs | publishing the extension to the VS Code Marketplace |

One more thing the fast-growing repos share, and it costs nothing: **a visible changelog**. This repo
has a long, real [`CHANGELOG.md`](../CHANGELOG.md), and nothing links to it from the README's
navigation. A reader deciding whether a project is abandoned looks for exactly that.
*(Judgment, not measurement.)*

---

## Anti-patterns, from the same survey

- **Stars are not a moat.** The two largest session-management repos in this space are a workflow
  shell around an agent — one is sunsetting and one has stopped pushing. The layer that keeps getting
  absorbed by the vendor is the workflow shell; the layer that does not is policy and evidence,
  because the policy belongs to the organisation. Build and market that half.
- **Do not wrap the binary.** Wrapping the `claude` executable works and is fragile against every
  release. Hooks and a plugin are the durable surface.
- **Do not ship a Telegram bridge as the headline.** Six independent repos do it at 0–2 stars each,
  first-party Channels exists, and users are filing bugs to make phone prompts *stop*. Escalation
  stays in the product, framed as the rare case.

## What to check before any of this

- Whether a `PermissionRequest` hook is fast enough to sit in front of every prompt without wrecking
  flow. The deterministic-tier-first design exists for this reason and it needs measuring, not
  assuming.
- Name availability, if the project ever leads with a name other than Session Sitter — npm, the
  GitHub org, and a trademark search. The survey's naming suggestions were never verified.
