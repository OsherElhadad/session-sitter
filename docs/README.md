# Documentation index

Everything in `docs/`, and what each file is for. Start with whichever question you actually have.

## The extension

| Document | Read it when you want to know |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how sessions are detected, what each component does, how a click switches a session, how peer machines are reached, and how a blocked prompt is resolved through the agent bridges |
| [`CONFIGURATION.md`](CONFIGURATION.md) | every setting, every environment-variable fallback, every CLI flag and every command — the reference, not a tutorial |

## Supervision

| Document | Read it when you want to know |
|---|---|
| [`SUPERVISION.md`](SUPERVISION.md) | what the four lights mean, how to turn supervision on, the record lifecycle, how a reply is interpreted, and what to check when a decision does not land |
| [`KNOWLEDGE.md`](KNOWLEDGE.md) | the BDI entry format, the three `bottom-line.md` tiers and how a session is routed to them |
| [`CORPUS.md`](CORPUS.md) | how sessions are collected into the store the rules are learned from, bulk import, and how secrets are redacted first |

## Brand and assets

| Document | Read it when you want to know |
|---|---|
| [`branding/README.md`](branding/README.md) | the logo, the palette, which file is the source of truth, and how to regenerate the PNGs |
| [`diagrams/README.md`](diagrams/README.md) | the hand-authored SVG explainers, and why they carry their own background |
| [`screenshots/README.md`](screenshots/README.md) | the shot list: which screenshots and which GIF the docs still need, and the exact state to capture in each |

## Working documents

| Document | Read it when you want to know |
|---|---|
| [`LAUNCH.md`](LAUNCH.md) | where to submit the project, in what order, and which badges are worth carrying |

## The design record

[`superpowers/`](superpowers/) holds dated plans and specs — one per feature, written before it was
built. They are a record of *why*, kept as written: they are deliberately not updated when the code
moves on, and they are excluded from the link and spell checks for that reason. The newest one,
[`superpowers/specs/2026-09-01-claude-code-plugin-design.md`](superpowers/specs/2026-09-01-claude-code-plugin-design.md),
is the design for shipping the supervision engine as a Claude Code plugin and a terminal binary.
