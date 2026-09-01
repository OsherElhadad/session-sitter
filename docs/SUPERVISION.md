# Supervision

Coding agents do not stop when you close the laptop. They keep working — overnight, through your
meetings — and every prompt they pause on is either a decision nobody makes or a decision made
carelessly. Supervision is the layer for the moments you are not there.

When an agent pauses for approval, the extension classifies **that specific pending action**
against knowledge learned from your team's past sessions, and acts:

| Light | Meaning | What happens |
|:---:|---|---|
| 🟢 **Green** | the action is fine | Approve the prompt so the agent proceeds. Record it. No human contact. |
| 🟡 **Yellow** | a safe, unambiguous correction | Inject a labeled `[Session Supervisor]` message. The agent self-corrects. No human contact. |
| 🟠 **Orange** | your call | Block the action and send a decision card with a countdown. On timeout: deny, and hand the agent safe alternatives. |
| 🔴 **Red** | policy, not judgment | Block outright. Send an alert. On timeout the block stands. |

Two rules are absolute. **Silence is never approval** — a timeout denies. And a **question is
never auto-answered** — `ask_followup_question` and `AskUserQuestion` go to a human who picks a
real option, because resolving them through the approval channel makes the agent report that you
gave no answer at all.

## The path a paused action takes

```mermaid
flowchart TD
  P["an agent pauses at a prompt"] --> AR{"an auto-respond<br>rule matches?"}
  AR -->|yes| RULE["apply it and record it<br>no model call"]
  AR -->|no| Q{"a question<br>for the human?"}
  Q -->|yes| RELAY["never auto-answered —<br>relayed to you with its options"]
  Q -->|no| DET{"deterministic tier<br>supervisor/tiers.ts"}
  DET -->|"read-only or plainly safe"| G
  DET -->|"unambiguously destructive"| R
  DET -->|ambiguous| BDI["load the three knowledge tiers<br>team, project, user"]
  BDI --> CLS["classify — one CLI call,<br>transcript and practices on stdin"]
  CLS --> G["green — approve the prompt"]
  CLS --> Y["yellow — inject labeled guidance<br>the agent self-corrects"]
  CLS --> O["orange — your call"]
  CLS --> R["red — policy"]
  CLS -->|"unparsable output"| O
  O --> W["decision card posted<br>countdown running"]
  R --> W
  W -->|you reply| ACT["approve, or deny<br>and relay your own words"]
  W -->|"orange times out"| DENY["deny, and hand the agent<br>the safe alternatives"]
  W -->|"red times out"| BLOCK["the block stands"]
  RULE --> L[("records/ — one durable<br>JSON record per decision")]
  G --> L
  Y --> L
  ACT --> L
  DENY --> L
  BLOCK --> L

  classDef green fill:#3fb950,stroke:#2a7f38,color:#141A2E
  classDef yellow fill:#d29922,stroke:#8f6a17,color:#141A2E
  classDef orange fill:#db6d28,stroke:#95491b,color:#141A2E
  classDef red fill:#f85149,stroke:#a83731,color:#ffffff
  class G green
  class Y yellow
  class O,W orange
  class R red
```

Three edges in there are the whole design. The **deterministic tier** keeps a governance layer off
the critical path of every read: a `read_file` never costs a model call. The two **timeout** edges
are what "silence is never approval" means in code. And **unparsable output escalates to Orange**
rather than failing open — see *Recovery, and why it never fails closed* in
[`ARCHITECTURE.md`](ARCHITECTURE.md#recovery-and-why-it-never-fails-closed).

---

## Turning it on

Supervision is off until you give it a state directory.

```jsonc
{
  // Required. Where transcripts, decisions and deliveries live.
  "sessionSitter.supervisorStateDir": "/home/you/.ai-sessions/state",

  // Where your BDI knowledge lives (a repo containing data/knowledge/).
  "sessionSitter.dataRepoPath": "/home/you/work/team-corpus",

  // Which knowledge applies to you.
  "sessionSitter.knowledge.user": "your-slug",
  "sessionSitter.knowledge.project": "your-project",
  "sessionSitter.knowledge.team": "your-team",

  // On by default.
  "sessionSitter.autoSupervise": true
}
```

Then pick a classifier and a channel — settings again, no environment needed:

```jsonc
{
  "sessionSitter.supervisor.engine": "bob",                 // or: "claude"
  "sessionSitter.supervisor.bobApiKey": "…",                // for the bob engine
  "sessionSitter.supervisor.messagingChannel": "telegram",  // or: "stub" (writes to files)
  "sessionSitter.supervisor.telegramBotToken": "…",
  "sessionSitter.supervisor.telegramChatId": "…",
  "sessionSitter.supervisor.orangeResponseTimeoutMinutes": 30
}
```

VS Code stores settings in plain text, so if you would rather keep a token out of
`settings.json`, leave that setting empty: the matching environment variable or `.env` entry
(`BOBSHELL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) is still read as a fallback. Full
list: [`CONFIGURATION.md`](CONFIGURATION.md).

**You do not run anything by hand.** The extension classifies every un-handled prompt and polls
for replies and timeouts in-process. There is no daemon to start.

---

## What you see

The **Supervision activity** panel under the session list shows every decision, newest first:
the light, what you asked for, what the agent wanted to do, the notification text, the choices
offered, and your answer. An Orange awaiting you is highlighted with its countdown. A failed
supervision expands to the recorded error, with buttons to open the record JSON or copy its path
— a failure is debuggable from the panel instead of being a dead end.

**Every row and every card names its session and its machine** — `🗂 fix the login flow` with
`🖥 devbox` — because one panel lists decisions from several sessions and one Telegram chat receives
them from several machines, and a session id answers neither question. The Telegram card carries the
same thing on its `session:` line, with the raw id kept in parentheses for support. A record written
before this existed still reads as it always did: the id alone.

**Both tiers appear here.** A decision your `sessionSitter.autoRespond` rules took is tagged
**⚙ rule**; one the supervisor took is tagged **🧠 AI**. Rule decisions also go out as one-way
updates on your messaging channel, so nothing Session Sitter does to a session is invisible —
whether you are looking at the panel or at your phone. They are recorded even with
`sessionSitter.autoSupervise: false`, since no classifier is involved; silence them on the channel
(but keep the records) with `sessionSitter.supervisor.notifyRuleDecisions: false`.

---

## The lifecycle

```mermaid
stateDiagram-v2
  [*] --> analysis_pending

  analysis_pending --> rule_applied: an auto-respond rule decided it
  analysis_pending --> green_completed: green, prompt approved
  analysis_pending --> yellow_ready: yellow, guidance built
  analysis_pending --> orange_awaiting_user: orange or red, card posted
  analysis_pending --> orange_awaiting_question: the agent asked the human
  analysis_pending --> failed: with the reason recorded

  yellow_ready --> yellow_delivered: injected into the session

  orange_awaiting_user --> orange_resolved_by_user: you replied
  orange_awaiting_user --> orange_transitioned_to_yellow: orange timed out, denied + alternatives
  orange_awaiting_user --> red_blocked: red timed out, the block stands

  orange_awaiting_question --> orange_resolved_by_user: you picked an option
  orange_awaiting_question --> orange_timed_out: no answer, the agent still waits for you

  note right of failed
    Terminal, no further automatic processing:
    rule_applied, green_completed, yellow_delivered,
    orange_resolved_by_user, orange_transitioned_to_yellow,
    red_blocked, failed.
    orange_timed_out is deliberately not terminal —
    the question is still open for you.
  end note
```

Orange and Red share `orange_awaiting_user` because they wait the same way: a card, a countdown, and
a human. What differs is only where a timeout lands. There is no `red_awaiting_user`.

Each state is one JSON file under `<stateDir>/records/`, written atomically, carrying its own
event trail. That is what makes the whole thing restart-safe: kill the window mid-Orange, reopen
it, and the pending decision is still there with its deadline intact.

### How a reply is interpreted

Deterministically, with no second model call — that path was slow and fragile.

- A reply containing an approval word (`approve`, `allow`, `yes`, `ok`, `proceed`, `accept`, `go`,
  `confirm`) lets the original action proceed.
- **Anything else denies it** — including a redirect like "Create PR", "Just commit" or "Cancel".

Either way your own words are relayed into the session, so the agent follows the new direction
rather than just seeing a rejection. A message that is not a reply to a live card is forwarded to
the active session as a plain instruction.

---

## Auto-approve rules come first

The supervisor is the fallback, not the first responder. A prompt that a rule handles never
reaches it — which keeps a read-only sweep from spending a model call.

```jsonc
"sessionSitter.autoRespond": [
  // Approval rules: resolve a pending prompt.
  { "toolPattern": "read_file|list_files|glob|grep", "decision": "approveOnce" },
  { "toolPattern": "execute_command", "argumentPattern": "\"command\":\\s*\"git (status|diff)",
    "decision": "approveOnce" },

  // Text rules: reply to a matching assistant message.
  { "matchPattern": "Do you want to continue\\?", "response": "Yes" },

  // Scope a rule to one project, or to Claude instead of Bob.
  { "toolPattern": "*", "decision": "approveOnce", "sessionPattern": "/scratch/" },
  { "matchPattern": "continue\\?", "response": "yes", "source": "claude" }
]
```

Rules are evaluated in order; the first match wins. No matching rule means: hand it to the
supervisor, or leave it for you if supervision is off.

---

## Running it by hand

The supervisor also ships as a CLI, for offline runs, replays and debugging. Same argument
contract the Python entrypoint had:

```bash
npm run compile

# Classify one already-exported session
node out/supervisor/cli.js run <sessionId> --user you --project p --team t

# Point straight at a transcript export (no state dir needed for the read)
node out/supervisor/cli.js run <sessionId> --transcript ./export.json

# Apply replies and timeouts once, or on an interval
node out/supervisor/cli.js poll
node out/supervisor/cli.js poll --loop 5
```

Run `poll` from the CLI **only** when `sessionSitter.autoSupervise` is off. Two pollers both calling
Telegram `getUpdates` is one consumer too many, and Telegram answers the second with
`409 Conflict`.

Deliveries the CLI writes are applied by the extension when it next sees them, exactly as if the
extension had produced them.

---

## Trying it without Telegram

Set `sessionSitter.supervisor.messagingChannel` to `stub`. Decision cards are written to
`<stateDir>/notifications/<requestId>.txt`,
and you reply by dropping a file:

```bash
echo "Create PR" > <stateDir>/inbox/<requestId>.txt
```

The next poll picks it up and the full Orange lifecycle runs, offline.

---

## When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| No activity at all | the panel is reading a different state dir than the window that made the decisions | the `state dir: …` line the log prints on activation is the one in use; on a remote setup (WSL, SSH, Bob IDE) `sessionSitter.supervisorStateDir` must be in the settings that window actually reads |
| No **🧠 AI** activity, only **⚙ rule** | the AI supervisor is off | set `sessionSitter.supervisorStateDir` — rule decisions need no state dir, the supervisor does |
| `supervision not started` in the log | no workspace root could be derived | set `sessionSitter.supervisorRepoPath` |
| Decisions always time out | `getUpdates` is failing — usually a second consumer or a webhook | check the log for `getUpdates failed`; stop the other poller |
| Records say `classify: … not found` | the classifier CLI is not on `PATH` | fix `sessionSitter.supervisor.engine`, or set `sessionSitter.supervisor.bobCliPath` / `.claudeCliPath` |
| Rule decisions show in the panel but not on Telegram | reporting is off, or the channel is `stub` | check `sessionSitter.supervisor.notifyRuleDecisions` and `.messagingChannel` |
| `state: failed` with `knowledge:` | a slug is unknown to a **configured registry** | fix the slug, or drop `sessionSitter.knowledge.registryPath` |
| Decisions cite no BDI | no `sessionSitter.knowledge.user`, or the tier files are absent | supervision still runs, just without knowledge; set the routing slugs and check `sessionSitter.dataRepoPath` |
| An approval never lands | the delivery is being retried, not lost | the `outbox/` file stays until the agent confirms; check the log for `resolve … → notfound` |

Everything is logged to the **Session Sitter** output channel and mirrored to
`<stateDir>/session-sitter.log`, which is the one to read in a multi-window setup.

---

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit, and why the outbox exists
- [`KNOWLEDGE.md`](KNOWLEDGE.md) — the BDI schema and the three tiers
- [`CONFIGURATION.md`](CONFIGURATION.md) — every setting and environment variable
- [`CORPUS.md`](CORPUS.md) — feeding sessions in so the knowledge can grow
