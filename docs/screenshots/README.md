# Shot list

This directory is empty on purpose. Session Sitter is a visual extension whose whole pitch is "one
panel shows you everything", and a reader currently never sees the panel — but a screenshot cannot
be produced by CI or by an agent, because it needs a running IDE on a real screen. So instead of a
placeholder image, here is a list precise enough to execute in about ten minutes on a machine with a
display.

Rules for all of them:

- **Dark theme**, default VS Code Dark Modern, so the wordmark and the panel agree.
- Crop to the **Secondary Sidebar only** for panel shots (roughly 320 × 700), except where noted.
- Use **real sessions with harmless titles**. No customer names, no internal hostnames, no absolute
  paths carrying a username — rename the workspace folders first if you have to.
- Save as PNG, at 2× device pixel ratio, named exactly as below, into this directory.
- Then add the reference at the place named in the last column, and re-run `node ci/check-links.mjs`.

## The GIF

| File | Length | What to capture | Referenced from |
|---|---|---|---|
| `demo.gif` | ~20 s, silent, looping | One thing only: an agent stops at a `git push --force` prompt; the decision card appears with the practice that applies; the action is denied and the agent is handed `--force-with-lease` as the alternative; the agent retries and succeeds. Nothing else on screen. Record the panel and the agent's own view side by side. | `README.md`, replacing the `TODO(demo)` comment directly under the badges |

That single loop is the product. If only one asset ever gets made, make this one.

## The screenshots

| File | What to capture | Referenced from |
|---|---|---|
| `panel-worklist.png` | The worklist with **all four sources visible at once** — at least one Claude Code, one IBM Bob, one Codex and one VS Code Chat row — showing three different status dots (running / waiting on the agent / idle), each row's source badge, and two different workspace pill colours. This is the one screenshot that carries the whole "four sources in one panel" claim. | `README.md` §*How it finds your sessions* |
| `panel-cross-machine.png` | The same list including at least one **peer-machine session**, so the machine label is visible, plus one peer named as unreachable. Requires two hosts with SSH between them. | `docs/ARCHITECTURE.md` §*Cross-machine sessions* |
| `hover-preview.png` | A row hovered, with the preview popover open on the last few messages. Include the cursor. | `README.md` §*First run* |
| `sort-menu.png` | The ⇅ menu open, all six orders visible, one of them checked. | `docs/CONFIGURATION.md` §*Sorting the session list* |
| `activity-feed.png` | The **Supervision activity** panel with at least four decisions in it: one tagged ⚙ rule, one 🟢, one 🟡, and one failed decision **expanded to show its recorded error**. The mix is the point — it shows that rule decisions are recorded too, and that failures are not hidden. | `docs/SUPERVISION.md` §*What you see* |
| `decision-card.png` | One Orange decision card as it actually arrives on the messaging channel, with the countdown visible and the options tappable. Crop tightly; redact the chat name. Capture it from Telegram if you have it configured, otherwise from the `stub` channel's rendered file so nothing needs an account. | `README.md` §*Supervision*, next to the traffic-light table |

## Marketplace

Publishing needs its own set, and the Marketplace listing page crops differently from GitHub:

| File | What to capture |
|---|---|
| `marketplace-1.png` | `panel-worklist.png` again, but uncropped at 1280 × 800 with the editor visible beside the panel, so the panel is shown in context |
| `marketplace-2.png` | The activity feed, same framing |

`docs/branding/social-preview.png` already exists at the right size for GitHub's social preview, but
nothing in this repo can verify that somebody actually uploaded it under **Settings → General →
Social preview**. Check that too while you are in there.
