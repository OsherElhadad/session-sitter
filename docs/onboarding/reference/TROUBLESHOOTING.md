# Symptom, cause, check

Run the doctor first. It finds most of what follows and it names the file it read, which is more than
half of every diagnosis here:

```bash
node ../scripts/ss-config.mjs where     # which settings.json is live
node ../scripts/ss-config.mjs check     # what resolves, and what is broken
```

Then read the **Session Sitter** output channel — `View → Output`, pick *Session Sitter*. It names
which source each value came from and why a feature declined to start. It is also mirrored to
`<stateDir>/session-sitter.log`, which is the one to read in a multi-window setup, because the panel
you are looking at may not be the window that made the decisions.

**Do not theorise before reading one of those two.** Every symptom below has exactly one common
cause, and both tools name it.

---

## A setting has no effect

Almost always one of three things, in this order of likelihood.

**1. The wrong `settings.json`.** Run `where`. Several files usually exist and only one is read.

On WSL with a Windows-side VS Code, the live user settings are on the **Windows** side under
`/mnt/c/Users/<you>/AppData/Roaming/Code/User/settings.json`, and a Linux-side
`~/.config/Code/User/settings.json` left over from a native install is never read while looking
entirely plausible. On a remote or SSH setup these settings are read from the **client** machine.

**2. A key VS Code does not recognise.** A typo, or a name that was renamed in 0.5.0 or 0.6.0. There
is no error — `config.get()` just returns the default. `check` reports it as `unknown-key` and names
the nearest real setting.

**3. A value of the wrong type.** `"true"` is a string, not a boolean, and VS Code falls back to the
default. `check` reports `wrong-type`.

Then reload the window: `Ctrl+Shift+P` → **Developer: Reload Window**. Most settings apply live, but
this rules it out.

---

## The panel

| Symptom | Cause | Check |
|---|---|---|
| No sessions at all | The panel is in the **Secondary** Sidebar, not the primary one | `Ctrl+Alt+B`, or **View → Secondary Side Bar** |
| Rows keep re-ordering | `sessionSort` is `recent`, which sorts by newest activity | pick `hostWorkspace`, `workspace`, `source` or `title` — those hold rows still |
| A Codex or Chat session vanishes too soon | No liveness signal exists for those sources, so recency is the only proxy | raise `probelessActiveWindowMinutes`, or `0` to keep them in History always |
| A session I am working in moves to History | On a **remote** setup, the server-side host outlives the client window | `windowAttentionMinutes` bounds how long a report survives silence — **raise** it, or leave it `0` |
| No peer sessions | The peer is unreachable, or `remotePeers` is `off` | SSH runs with `BatchMode=yes`, so a host that would prompt for a password is reported unreachable — try `ssh <host>` by hand |
| A workspace pill is the theme colour | The value is not a colour, so it was ignored rather than painted arbitrarily | `check` reports `bad-colour` and lists every accepted form |

---

## Auto-respond rules

| Symptom | Cause | Check |
|---|---|---|
| A rule never fires | Half a pair — `toolPattern` without `decision`, or `matchPattern` without `response` | `check` reports `rule-shape` |
| A rule never fires, and looks complete | The other agent's tool names. `source` defaults to `"bob"`, and Claude's names are capitalised | compare against a real pending prompt; the panel shows the tool name on the row |
| A rule never fires, and the names are right | An invalid regex skips the whole rule silently | `check` reports `rule-bad-regex`; remember JSON doubles every backslash |
| A later rule never fires | A `toolPattern: "*"` rule earlier **in the same `source` lane** shadows it — first match wins | `check` reports `rule-unreachable` and names the shadowing index |
| A Claude rule with `sessionPattern` never fires | Scoped Claude approval rules are **skipped** — Claude approvals cannot be tied to a session yet | `check` reports `rule-claude-scoped`; drop the `sessionPattern` |
| A question is still asked despite `"*"` | Deliberate: a user-facing question is never auto-approved, and the guard cannot be overridden | `check` reports `rule-question-tool` |
| Rules fire but nothing is recorded | They are recorded — under the extension's global storage when no state dir is set | the `state dir: …` line the log prints on activation says where |

To watch a rule fire, read the output channel: every applied rule logs the tool name, the glob that
matched, and the decision.

---

## Supervision

| Symptom | Cause | Check |
|---|---|---|
| No **🧠 AI** activity, only **⚙ rule** | The AI supervisor is off | set `sessionSitter.supervisorStateDir` — rule decisions need no state dir, the supervisor does |
| No activity at all | The panel is reading a different state dir than the window that made the decisions | the `state dir: …` log line on activation is the one in use; on WSL/SSH/Bob IDE the setting must be in the settings **that window** reads |
| `supervision not started` in the log | No workspace root could be derived | set `sessionSitter.supervisorRepoPath` |
| Records say `classify: … not found` | The classifier CLI is not on the `PATH` the **extension host** sees | fix `supervisor.engine`, or set `supervisor.bobCliPath` / `.claudeCliPath`. On a remote setup that is the host machine's `PATH`, not your terminal's |
| The classifier cannot run at all | Engine is `bob` (the default) with no key resolved | `check` reports `engine-needs-key`; set a key or switch to `"claude"` |
| Decisions always time out | `getUpdates` is failing — usually a **second consumer** or a webhook | the log says `getUpdates failed`; stop the other poller. Never run `cli.js poll` while `autoSupervise` is on — Telegram answers the second consumer with `409 Conflict` |
| `state: failed` with `knowledge:` | A slug is unknown to a **configured registry** | fix the slug, or drop `knowledge.registryPath` |
| Decisions cite no practices | No knowledge source, or the tier files are absent | `check` reports `knowledge-no-source`. Supervision still runs, judging the action without written practices — that is by design, not a failure |
| An approval never lands | The delivery is being **retried**, not lost | the `outbox/` file stays until the agent confirms; the log shows `resolve … → notfound` |
| Everything is slower than expected | The fast tier is inert, so every ambiguous action pays for an agent CLI | `check` reports `fast-classifier-inert` naming what is missing. Expected on an OAuth subscription |

### Trying supervision offline

`messagingChannel: "stub"` writes each card to `<stateDir>/notifications/<requestId>.txt`. Reply by
dropping a file:

```bash
echo "Create PR" > <stateDir>/inbox/<requestId>.txt
```

The next poll picks it up and the full Orange lifecycle runs with nothing leaving the machine. This is
the right way to see what supervision would have asked before wiring a phone to it.

**A reply is interpreted deterministically, with no model call.** A reply containing an approval word
— `approve`, `allow`, `yes`, `ok`, `proceed`, `accept`, `go`, `confirm` — lets the action proceed;
**anything else denies it**, including a redirect like "Create PR" or "Just commit". Either way your
own words are relayed into the session, so the agent follows the new direction rather than just seeing
a rejection.

---

## Telegram

The full table is in [`TELEGRAM-SETUP.md`](TELEGRAM-SETUP.md#when-nothing-arrives). The three that
account for most of it:

| Symptom | Cause |
|---|---|
| No cards at all | Token or chat id unresolved, so the **stub** channel was used — the cards are in `<stateDir>/notifications/`. `check` reports `telegram-incomplete` |
| Commands work, typing into a topic does nothing | Privacy mode still **on**. @BotFather → `/setprivacy` → Disable |
| Messages go missing, replies reach the wrong machine | Two machines sharing one bot token. Reading an update removes it from the stream — give each machine its own bot |

---

## The Claude Code plugin

| Symptom | Cause |
|---|---|
| Nothing is decided | `permissions.defaultMode` is `auto`, so nothing prompts and the ladder never runs — use `--permission-mode manual` |
| Everything is denied | `enforce` with no practices file and no classifier denies every call that is not deterministically safe. That is the design: start with a practices file, or with `SESSION_SITTER_MODE=observe` |
| A clause never denies anything | It carries a `level` and no `Match:` line, so it reaches the classifier as prose and cannot deny on its own — `/session-sitter:policy` reports it as an `error` |
| A correction comes back as a denial | A red clause written as a plain **substring** also matches the corrected call. `Match: git push --force` matches `--force-with-lease` too, so it vetoes the rewrite the correction lane just made. Use `/git\s+push\b.*--force(?!-with-lease)/` |

---

## When you are stuck

Collect these three, in this order — together they answer almost every remaining question:

```bash
node ../scripts/ss-config.mjs where
node ../scripts/ss-config.mjs check --json
```

3. the **Session Sitter** output channel from activation onward — the `state dir: …` line, and any
   line saying a feature declined to start

They are also what to attach to an issue: <https://github.com/eranra/session-sitter/issues>.
