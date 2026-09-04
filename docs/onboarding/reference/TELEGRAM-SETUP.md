# Telegram, in the order that avoids doing anything twice

Two separate features share one bot and one group:

- **Decision cards** (layer 4) — an Orange reaches you with a countdown and your reply decides.
  Needs a group and a bot.
- **Remote control** (layer 5) — each active session becomes a **topic** you can read and type
  into. Needs the group to be a **forum** (Topics on), the bot to be an admin, and an allowlist.

Do the Telegram work first, in this order, then the settings. Every step below fails **quietly** if
skipped, which is why the order matters more than it looks.

---

## 1. Create the group

A **group**, not a channel. Add yourself and nobody else to start.

For remote control, also: *Manage group → Topics* → enable. **Topics cannot be enabled in a
one-to-one chat**, which is why a group is needed even for a single user.

Skip Topics and the session list still works — the extension says what to fix rather than failing
silently.

## 2. Create the bot, and disable privacy mode

Talk to [@BotFather](https://t.me/BotFather):

```
/newbot            → follow the prompts, keep the token it gives you
/setprivacy        → pick the bot → Disable
```

**Privacy mode is on by default, and leaving it on is the trap.** With it on, the bot sees commands
like `/sessions` but **not** the ordinary text you type into a session topic. The feature appears to
work and silently ignores everything you say to an agent — the worst possible failure, because
nothing reports it.

Only needed for remote control. Decision cards work either way, but disable it anyway: you will want
remote control eventually and this is the step nobody remembers.

## 3. Add the bot to the group as an admin

For remote control it needs **Manage Topics** — it creates, renames and deletes a topic per session,
none of which is possible without that right. Without it the extension closes topics instead of
deleting them and retries later, logging the reason to its output channel.

## 4. Find the chat id

Send any message in the group, then open, replacing `<TOKEN>`:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

The id is in `result[].message.chat.id`. **It is negative** — that is normal, and a supergroup id
starts `-100`. A positive id is a one-to-one chat, where Topics cannot be enabled; the doctor
reports that as `chat-id-not-a-group`.

> **Do this before the extension is running.** `getUpdates` is **destructive**: reading an update
> removes it from the bot's stream. If Session Sitter is already polling the same token, your
> browser and the extension split the messages between them. Stop the extension, or read the id from
> a bot the extension is not using.

## 5. Find your user id

Only for remote control, and the easiest way needs no third-party bot:

1. set `sessionSitter.telegram.remoteControl: true` with `allowedUserIds` still `[]`
2. send any message in the group
3. **View → Output → Session Sitter** — every rejected sender's id is logged, ready to copy in

**An empty allowlist authorises nobody**, so nothing is acted on while you do this. That is the
design: it fails closed, and it logs enough to fix itself.

## 6. Put the token in the environment, not in settings

```bash
# ~/.bashrc, your shell profile, or <workspaceRoot>/.supervisor.env
TELEGRAM_BOT_TOKEN=123456:ABC...
```

The setting `sessionSitter.supervisor.telegramBotToken` exists and is **read first if you set it**.
Preferring the environment is a recommendation with a specific reason — see below — not a
limitation.

The chat id is not a secret; `sessionSitter.supervisor.telegramChatId` in settings is fine.

The four remote-control settings have environment fallbacks too, which is how a machine with no IDE
configures `session-sitter daemon`:

```bash
SESSION_SITTER_TELEGRAM_REMOTE_CONTROL=1
SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS="123456789, 987654321"   # commas or whitespace
SESSION_SITTER_TELEGRAM_FULL_MESSAGES=1
SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS=4
```

A `settings.json` with none of them is therefore not proof the feature is off. `ss-config.mjs check`
resolves the environment as well, which is the only way to answer that from outside the IDE.

## 7. The settings

Cards only: [`../examples/04-telegram-cards.json`](../examples/04-telegram-cards.json).
Remote control: [`../examples/05-telegram-remote-control.json`](../examples/05-telegram-remote-control.json).

Then validate — with the token in the environment, so the doctor resolves it the way the extension
will:

```bash
node ../scripts/ss-config.mjs check
```

---

## One bot per machine

A bot token has a **single** message stream, and reading it **removes** each message from that
stream. Two machines polling the same token do not each get a copy: every message goes to whichever
asked first. Your reply then reaches the wrong machine, or looks ignored.

So give each machine its own bot and add them all to the same group. Each bot handles the sessions
on its own machine, and the group shows the union — the fleet view emerges without any machine
talking to another.

**This is why the token belongs in the environment.** Settings Sync would copy one machine's token
to all of them, recreating exactly this problem, invisibly. The doctor warns about a token in
settings while remote control is on (`token-in-settings`) for this reason and no other.

A machine with no bot still appears in the list — its sessions are pulled over SSH by peer
discovery — but they are marked read-only, because only that machine can write to them.

---

## What you get

**In General:** `/sessions` (redraw the active list), `/history` (earlier sessions, tap to bring one
back), `/new` (start a session — pick a workspace, then Claude or Bob), `/who` (which window owns
which session, and why a row is read-only), `/help`, and `/forget` **inside a topic** to delete that
topic.

**In a session topic:** that session's turns as they happen, its supervision cards, and a text box
that sends straight into the agent.

The list holds the **active** sessions and only those — the same ones the Sessions panel shows. A
session that leaves the active list has its topic **deleted** right then, not after a timeout, so the
topic list *is* the active list. Deleted rather than closed, because Telegram keeps a closed topic
visible in the group's list, so every session that ever ran would pile up there. Nothing is lost:
the transcript on disk is the source of truth and `/history` rebuilds a topic from it on request.

A topic you open by hand is left alone for ten minutes whichever list its session is in, so tapping a
`/history` row never leads to a thread that vanishes under you. A topic you close by hand **reopens
when there is a new turn to post** — those are the turns you would actually have missed.

Full behaviour, including the write limits and ownership model:
[`../../TELEGRAM.md`](../../TELEGRAM.md).

---

## When nothing arrives

| Symptom | Cause | Check |
|---|---|---|
| No cards at all | Token or chat id unresolved, so the **stub** channel was used — cards are in `<stateDir>/notifications/` | `check` reports `telegram-incomplete`; the output channel logs the fallback |
| Commands work, typing into a topic does nothing | Privacy mode still **on** | @BotFather → `/setprivacy` → Disable |
| Remote control does not start | Empty `allowedUserIds`, or no token resolved | `check` reports `remote-control-no-allowlist` / `remote-control-no-token` |
| Topics are not created | Not a forum group, or the bot lacks **Manage Topics** | *Manage group → Topics*; check the bot's admin rights |
| Messages go missing, or replies reach the wrong machine | Two machines sharing one bot token | one bot per machine |
| Turns arrive cut off | `telegram.maxMessageParts` budget reached | the last message names how many characters were left out |

The **Session Sitter** output channel names which source each value came from and why a feature
declined to start. Read it before theorising.
