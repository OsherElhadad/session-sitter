---
description: Write the decision trail to one self-contained HTML file you can send someone.
argument-hint: [--since 7d] [--limit N] [--scope local|team]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" *)
---

!`out="session-sitter-report-$(date -u +%Y%m%dT%H%M%SZ).html"; node "${CLAUDE_PLUGIN_ROOT}/lib/cli/index.js" export --html $ARGUMENTS > "$out" && echo "wrote $out ($(wc -c < "$out") bytes)" || { rm -f "$out"; echo "export failed; no file written"; }`

Tell the user the path, and that the file is self-contained — one HTML file, no assets, no network,
so it survives being emailed or attached to a ticket.

**Do not read the file back or summarise its contents.** It is a report for a human to open, it can
be megabytes, and a summary of an audit trail that disagrees with the trail is worse than no summary.

Two things worth saying only if they asked something the answer bears on:

- `--scope team` is a **projection, not a redaction**: it drops the keys it excludes rather than
  blanking them, and HMACs `cwd` and `sessionId` under a per-machine key, so a session stays
  correlatable within itself but not back to a repository. There is no flag that ships the excluded
  set.
- It is a **snapshot**, not a live view. It says when it was written, and it does not update.

For piping the trail into a log store instead of handing someone a file, that is
`session-sitter export --jsonline` in a real terminal — the shape is documented in `docs/CLI.md`.
