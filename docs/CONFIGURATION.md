# Configuration

Three places, by design: **VS Code settings** for what is per-user and harmless, the
**environment** for credentials and runtime choices, and **CLI flags** for one-off runs.

Nothing here is required to use the session switcher. Supervision needs
`reckon.supervisorStateDir`; everything else has a default.

On a remote setup (WSL, SSH, Bob IDE) put the settings in your **user** settings — they are read
from the client machine.

---

## VS Code settings

### The session panel

| Setting | Default | Purpose |
|---|---|---|
| `claudeSessionSwitcher.autoRespond` | `[]` | Auto-reply and auto-approve rules. See [below](#auto-respond-rules). |
| `claudeSessionSwitcher.probelessActiveWindowMinutes` | `120` | How recently a **Codex** or **VS Code Chat** session must have been updated to count as active. Those sources expose no live-process signal, so recency is the only proxy; Claude and Bob are judged by what their extension hosts report as open. `0` keeps them in History always. |

### Supervision

| Setting | Default | Purpose |
|---|---|---|
| `reckon.supervisorStateDir` | `""` | **Required to enable supervision.** Holds `history/`, `records/`, `outbox/`, `inbox/`, `notifications/`, `locks/`. |
| `reckon.autoSupervise` | `true` | Hand every prompt no rule handled to the supervisor, and poll for replies and timeouts. |
| `reckon.supervisorRepoPath` | `""` | Workspace root: where `.env` is read from and the classifier's working directory. Derived from the state dir's parent when empty. |

### Knowledge

| Setting | Default | Purpose |
|---|---|---|
| `reckon.dataRepoPath` | `""` | Corpus repo root — contains `data/sessions/` and `data/knowledge/`. Used by **Upload Session to Corpus** and, unless overridden, as the knowledge source. |
| `reckon.knowledge.user` | `""` | Routes to `data/knowledge/users/<user>/bottom-line.md` — highest precedence tier. |
| `reckon.knowledge.project` | `""` | Routes to `data/knowledge/projects/<project>/bottom-line.md`. |
| `reckon.knowledge.team` | `""` | Routes to `data/knowledge/teams/<team>/bottom-line.md` — lowest precedence. |
| `reckon.knowledge.registryPath` | `""` | Optional registry markdown. When set the triple is validated against it and the documented fallbacks apply; when empty the three slugs are used as given. See [`KNOWLEDGE.md`](KNOWLEDGE.md#routing-which-files-apply-to-this-session). |

A slug left empty means that tier is not configured: its file is reported missing and the others
still load. With **no** user configured at all, supervision still runs — the classifier judges the
pending action without BDI to weigh it against. A missing setting never fails a decision, because
the agent is blocked on it. Nothing is ever guessed.

### Deprecated

| Setting | Status |
|---|---|
| `reckon.uploadScriptPath` | **Deprecated.** The uploader is built in. Still read as a fallback: when `reckon.dataRepoPath` is empty, the corpus root is derived from this path, so an existing setup keeps working. Set `reckon.dataRepoPath` instead. |
| `reckon.pythonPath` | **Deprecated and unused.** The supervisor is TypeScript and runs in-process. Reading Bob's SQLite store still uses the `python3` on your `PATH`, but that is not configurable here — see [`ARCHITECTURE.md`](ARCHITECTURE.md#why-one-python3-call-remains). |

---

## Environment

Read from the process environment, then `<workspaceRoot>/.env`, then
`<workspaceRoot>/.supervisor.env`, then the parent directory's `.env`. **The process environment
wins**, and later files win over earlier ones.

Credentials live here rather than in settings so a token never ends up in a synced
`settings.json`.

### Classifier

| Variable | Default | Meaning |
|---|---|---|
| `SUPERVISOR_ENGINE` | `bob` | Which agent CLI classifies: `bob` (IBM Bob Shell) or `claude` (Claude Code). |
| `BOB_API_KEY` / `BOBSHELL_API_KEY` | — | Bob headless auth. Either name works. |
| `BOB_CLI_PATH` | `bob` | Override when `bob` is not on `PATH`. |
| `CLAUDE_CLI_PATH` | `claude` | Override when `claude` is not on `PATH`. |
| `CLAUDE_TIMEOUT_SECONDS` | `300` | Per-invocation classifier timeout (both engines). |
| `ANTHROPIC_BASE_URL` | — | Gateway passed into the `claude` subprocess. |
| `ANTHROPIC_AUTH_TOKEN` | — | Token passed into the `claude` subprocess. |

### Messaging

| Variable | Default | Meaning |
|---|---|---|
| `MESSAGING_CHANNEL` | `stub` | `stub` writes cards to files and reads replies from `inbox/`; `telegram` sends real decision cards. |
| `TELEGRAM_BOT_TOKEN` | — | From BotFather. Required for `telegram`. |
| `TELEGRAM_CHAT_ID` | — | Required for `telegram`. |
| `ORANGE_RESPONSE_TIMEOUT_MINUTES` | `30` | How long an Orange waits before it denies and falls back. |
| `RED_NOTIFY` | `true` | Whether a Red also posts an informational alert. `0` silences it; the block stands regardless. |

With `MESSAGING_CHANNEL=telegram` but the token or chat id missing, the stub is used and a warning
is logged — supervision degrades rather than failing silently.

### State and knowledge

| Variable | Default | Meaning |
|---|---|---|
| `STATE_DIR` | `<workspaceRoot>/.supervisor-state` | Only used by the CLI; the extension passes `reckon.supervisorStateDir`. Supports a leading `~`. |
| `KNOWLEDGE_LOCAL_REPO` | — | Local corpus checkout. Also accepted as `KB_SITTER_LOCAL_REPO`. |
| `KNOWLEDGE_REPO` | — | Git URL, used only when no local checkout is set. Also accepted as `KB_SITTER_KNOWLEDGE_REPO`. |
| `KNOWLEDGE_REF` | `main` | Ref to clone when reading remotely. |
| `KNOWLEDGE_REGISTRY_PATH` | — | Registry markdown, for the CLI. |

---

## Auto-respond rules

One array, two kinds of rule, evaluated in order — first match wins.

| Field | Kind | Meaning |
|---|---|---|
| `matchPattern` | text | JS regex tested against the latest assistant message. |
| `response` | text | Text sent into the session on a match. |
| `toolPattern` | approval | Glob against the pending tool name. `*` matches any run of characters, `\|` separates alternatives. |
| `argumentPattern` | approval | Optional JS regex against the tool arguments JSON. Unanchored. |
| `decision` | approval | `approveOnce`, `approveForTask`, or `reject`. |
| `sessionPattern` | scope | Optional JS regex against the session's project path. |
| `source` | scope | `bob` (default) or `claude`. |

`approveForTask` also suppresses future prompts for that permission group — and, for
execute-style tools, that specific command.

```jsonc
"claudeSessionSwitcher.autoRespond": [
  { "toolPattern": "read_file|list_files|glob|grep", "decision": "approveOnce" },
  { "toolPattern": "execute_command",
    "argumentPattern": "\"command\":\\s*\"(git (status|diff|log)|ls|pwd)",
    "decision": "approveOnce" },
  { "toolPattern": "*", "decision": "approveOnce", "sessionPattern": "/scratch/" },
  { "matchPattern": "Do you want to continue\\?", "response": "Yes" },
  { "matchPattern": "continue\\?", "response": "yes", "source": "claude" }
]
```

Two guards no rule can override:

- **A user-facing question is never auto-approved.** `ask_followup_question` and
  `AskUserQuestion` always go to a human, even against `toolPattern: "*"` — approving one makes
  the agent report that you gave no answer.
- **An uncaptured Claude request is never auto-approved.** If the metadata hook missed it we know
  neither the tool nor whether it is a question, so `*` must not allow it.

An invalid regex or glob skips that rule; it never throws.

---

## CLI flags

Both CLIs take `--help`.

**Supervisor** — `node out/supervisor/cli.js`

| Flag | Meaning |
|---|---|
| `run <sessionId>` | Classify one already-exported session. |
| `poll [--loop N]` | Apply replies and timeouts once, or every N seconds. |
| `--user` `--project` `--team` | The knowledge-routing triple. |
| `--transcript PATH` | Read a transcript export directly (offline runs). |
| `--workspace-root PATH` | Workspace root. `--repo-root` is accepted as an alias. |
| `--state-dir PATH` | Supervision state directory. |

**Corpus** — `node out/corpus/cli.js`

| Flag | Meaning |
|---|---|
| `upload <file>` | Upload one session. `--source` `--slug` `--user` `--force`. |
| `delete <filename>` | Remove a stored session and its sidecar. |
| `list` | List stored sessions. `--source` `--top N`. |
| `import` | Bulk-import from the local stores. `--bob` `--claude` `--limit N` `--no-push` `--no-mask` `--force`. |
| `mask` | Redact secrets in the store. `--report PATH`. |
| `fetch-knowledge` | Print the three tier files as JSON. `--user` `--project` `--team` `--local DIR` \| `--repo URL` `--ref REF`. |
| `--repo PATH` | Corpus repo root. Defaults to the current directory. |
| `--dry-run` | Print every step without touching git or the filesystem. |

---

## Commands

All under the **AI Sessions** category:

| Command | What it does |
|---|---|
| Refresh Sessions | Sessions update automatically; this just says so. |
| New Claude Session | Opens a fresh Claude conversation in the active editor column. |
| Upload Session to Corpus | Uploads the selected session (also on the row's right-click menu). |
| Export Session for Supervision | Writes a full transcript export by hand, for a manual classify. |
| Supervise the Blocked Session Now | Classifies the currently-blocked prompt on demand. |
| Test Bob Send / Test Claude Send | Sends a test message into the most recent session of that source. |
| Test Claude List Approvals | Lists Claude's pending permission prompts. |
| Probe … / Install … Hook / Capture … | Read-only internals probes for debugging the agent bridges. |

---

## See also

- [`SUPERVISION.md`](SUPERVISION.md) · [`KNOWLEDGE.md`](KNOWLEDGE.md) · [`CORPUS.md`](CORPUS.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md)
