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

---

## Turning it on

Supervision is off until you give it a state directory.

```jsonc
{
  // Required. Where transcripts, decisions and deliveries live.
  "reckon.supervisorStateDir": "/home/you/.ai-sessions/state",

  // Where your BDI knowledge lives (a repo containing data/knowledge/).
  "reckon.dataRepoPath": "/home/you/work/team-corpus",

  // Which knowledge applies to you.
  "reckon.knowledge.user": "your-slug",
  "reckon.knowledge.project": "your-project",
  "reckon.knowledge.team": "your-team",

  // On by default.
  "reckon.autoSupervise": true
}
```

Then pick a classifier and a channel in `<workspaceRoot>/.env` (or the process environment):

```bash
SUPERVISOR_ENGINE=bob          # or: claude
BOB_API_KEY=…                  # for the bob engine
MESSAGING_CHANNEL=telegram     # or: stub (writes to files — good for trying it out)
TELEGRAM_BOT_TOKEN=…
TELEGRAM_CHAT_ID=…
ORANGE_RESPONSE_TIMEOUT_MINUTES=30
```

Credentials stay in the environment on purpose — they never have to live in VS Code settings.
Full list: [`CONFIGURATION.md`](CONFIGURATION.md).

**You do not run anything by hand.** The extension classifies every un-handled prompt and polls
for replies and timeouts in-process. There is no daemon to start.

---

## What you see

The **Supervision activity** panel under the session list shows every decision, newest first:
the light, what you asked for, what the agent wanted to do, the notification text, the choices
offered, and your answer. An Orange awaiting you is highlighted with its countdown. A failed
supervision expands to the recorded error, with buttons to open the record JSON or copy its path
— a failure is debuggable from the panel instead of being a dead end.

---

## The lifecycle

```
analysis_pending
   ├── green_completed                    prompt approved, recorded
   ├── yellow_ready → yellow_delivered    guidance injected
   ├── orange_awaiting_question           a question is waiting for a human answer
   │      ├── orange_resolved_by_user     answer delivered to the agent
   │      └── orange_timed_out            no answer; the agent still waits for you
   ├── orange_awaiting_user               a decision card is live, countdown running
   │      ├── orange_resolved_by_user     you replied: approve, or deny + relay
   │      ├── orange_transitioned_to_yellow   timed out: denied + alternatives
   │      └── red_blocked                 timed out on a Red: the block stands
   └── failed                             with the reason recorded
```

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
"claudeSessionSwitcher.autoRespond": [
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

Run `poll` from the CLI **only** when `reckon.autoSupervise` is off. Two pollers both calling
Telegram `getUpdates` is one consumer too many, and Telegram answers the second with
`409 Conflict`.

Deliveries the CLI writes are applied by the extension when it next sees them, exactly as if the
extension had produced them.

---

## Trying it without Telegram

Set `MESSAGING_CHANNEL=stub`. Decision cards are written to `<stateDir>/notifications/<requestId>.txt`,
and you reply by dropping a file:

```bash
echo "Create PR" > <stateDir>/inbox/<requestId>.txt
```

The next poll picks it up and the full Orange lifecycle runs, offline.

---

## When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| No activity at all | no state dir | set `reckon.supervisorStateDir` |
| `supervision not started` in the log | no workspace root could be derived | set `reckon.supervisorRepoPath` |
| Decisions always time out | `getUpdates` is failing — usually a second consumer or a webhook | check the log for `getUpdates failed`; stop the other poller |
| Records say `classify: … not found` | the classifier CLI is not on `PATH` | fix `SUPERVISOR_ENGINE`, or set `BOB_CLI_PATH` / `CLAUDE_CLI_PATH` |
| `state: failed` with `knowledge:` | a slug is unknown to a configured registry | fix the slug, or drop `reckon.knowledge.registryPath` |
| An approval never lands | the delivery is being retried, not lost | the `outbox/` file stays until the agent confirms; check the log for `resolve … → notfound` |

Everything is logged to the **AI Sessions** output channel and mirrored to
`<stateDir>/session-switcher.log`, which is the one to read in a multi-window setup.

---

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit, and why the outbox exists
- [`KNOWLEDGE.md`](KNOWLEDGE.md) — the BDI schema and the three tiers
- [`CONFIGURATION.md`](CONFIGURATION.md) — every setting and environment variable
- [`CORPUS.md`](CORPUS.md) — feeding sessions in so the knowledge can grow
