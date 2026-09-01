# Security

## Reporting a vulnerability

Report it privately, through GitHub's **Report a vulnerability** button under
[Security → Advisories](https://github.com/eranra/session-sitter/security/advisories) on this
repository. That opens a draft advisory only the maintainers can see, so a fix can land before the
details are public.

Please do not open a public issue for a vulnerability. If a report turns out not to be one, it will
be moved to a normal issue and discussed in the open.

Useful in a report: the extension version (**☰ → About** in the panel, or `make version`), the IDE
and its version, the platform, and the smallest sequence of steps that shows the problem.

## What this extension can reach

Worth knowing when judging impact, because it is more than a typical extension:

- **It reads your agents' local state.** `~/.claude/projects/**`, `~/.claude/sessions/**`,
  `~/.bob/db/bob.db` (read-only), `~/.codex/sessions/**`, and VS Code's own
  `workspaceStorage/*/chatSessions/*.jsonl`. That is conversation content, file paths and process
  ids. It is read where the agents already wrote it, and it is **not transmitted anywhere** — it
  goes to the panel in your IDE and nowhere else.
- **Two things leave the machine, and only if you configure them.** Supervision runs a classifier
  CLI (`bob` or `claude`) which calls its own model endpoint with the pending action and the
  transcript export; and the Telegram channel posts decision cards to Telegram's API. Both are off
  until you set them up — supervision needs `sessionSitter.supervisorStateDir`, and the channel
  defaults to `stub`, which writes cards to files on disk.
- **Upload to Corpus** is the one command that commits session content to a repository, and only the
  session you pick. Secrets are masked before anything is written — see
  [`docs/CORPUS.md`](docs/CORPUS.md).
- **It can act on your agents.** Auto-respond rules approve, reject and reply on your behalf, and
  the supervisor does the same. Every such decision is recorded and shown in the Supervision
  activity panel; silence is never approval. A user-facing question is never auto-answered.
- **Peer discovery runs `ssh`**, only to addresses your IDE has already connected to, and only with
  `sessionSitter.remotePeers` left at `auto`. `BatchMode=yes` means it never prompts for
  credentials. Set it to `off` and no connection of any kind is made.

## Tokens in settings are stored in plain text

`sessionSitter.supervisor.bobApiKey`, `.anthropicAuthToken` and `.telegramBotToken` are ordinary VS
Code settings, and VS Code stores settings as plain text in `settings.json`. Anything that can read
that file can read the token.

The three settings are machine-scoped, so Settings Sync will not copy them to your other machines
and they cannot be set in a workspace file that might get committed. That limits the blast radius;
it does not encrypt anything.

If that matters to you, leave the setting empty and use the environment fallback instead
(`BOBSHELL_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, or a `.env` in the supervisor's
workspace root). A setting you do fill in always wins over the environment. See
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md#environment-legacy-fallback).

## Supported versions

This is a source-and-VSIX project with no long-term branches: fixes go onto `main` and out in the
next tagged release. Please reproduce against the latest release, or `main`, before reporting.
