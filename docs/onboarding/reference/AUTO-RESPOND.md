# Auto-respond rules

`sessionSitter.autoRespond` is **one array holding two kinds of rule**, evaluated in order, first
match wins. It needs no other configuration: rules apply, and every decision one takes is recorded
and shown in the **Supervision activity** panel even with the AI supervisor off.

This is the part of the configuration that decides what an agent may do while nobody is watching.
**Read every rule you propose back to the user in words before writing it** — "this approves any read
in any session without asking you" — and let them say no.

---

## The two shapes

An **approval rule** resolves a pending tool-permission prompt:

```jsonc
{
  "toolPattern": "read_file|list_files",   // required: glob against the TOOL NAME
  "argumentPattern": "\"path\":\\s*\"src/", // optional: regex against the arguments JSON
  "decision": "approveOnce",               // required: approveOnce | approveForTask | reject
  "sessionPattern": "/work/payments",      // optional: regex against the session's project path
  "source": "bob"                          // optional: "bob" (default) or "claude"
}
```

A **text rule** types a reply into the session:

```jsonc
{
  "matchPattern": "Do you want to continue\\?", // required: regex against the latest assistant message
  "response": "Yes",                            // required: what gets typed
  "sessionPattern": "/work/payments",           // optional
  "source": "claude"                            // optional
}
```

| Field | Kind | Meaning |
|---|---|---|
| `toolPattern` | approval | **Glob** against the pending tool name. `*` is any run of characters, `\|` separates alternatives. Anchored at both ends, so `Read` matches `Read` and not `ReadFile`. |
| `argumentPattern` | approval | **JavaScript regex** against the arguments as JSON. **Unanchored** — it matches anywhere in the JSON. |
| `decision` | approval | `approveOnce`, `approveForTask`, or `reject`. |
| `matchPattern` | text | **JavaScript regex** against the latest assistant message. |
| `response` | text | The text sent into the session on a match. |
| `sessionPattern` | both | Optional **regex** against the session's project path. Omitted, the rule applies everywhere. |
| `source` | both | `"bob"` (the default) or `"claude"`. |

`approveOnce` answers this one prompt. `approveForTask` also suppresses future prompts for that
permission group — and, for execute-style tools, that specific command. It is the equivalent of
clicking "always allow", so use it where they would have.

---

## The six ways a rule silently does nothing

Every one of these parses, loads, and never fires. The doctor
(`node ../scripts/ss-config.mjs check`) reports all six.

### 1. Half a pair

A rule is a text rule when it has **both** `matchPattern` and `response`; an approval rule when it
has **both** `toolPattern` and `decision`. Anything else is neither, and neither matcher looks at
it.

```jsonc
{ "toolPattern": "Read" }                          // ✗ no decision — never fires
{ "matchPattern": "continue\\?" }                  // ✗ no response — never fires
{ "toolPattern": "Read", "decision": "approveOnce" } // ✓
```

### 2. The wrong agent's tool names

Bob and Claude name their tools differently, and a rule applies to **one agent only**. `source`
defaults to `"bob"`, so a rule written with Claude's tool names and no `source` matches nothing.

These are the names this repository's own code matches on, so they are safe to write:

| | Bob | Claude |
|---|---|---|
| reads | `read_file`, `list_files`, `search_files`, `list_code_definition_names`, `glob`, `grep`, `codebase_search` | `Read`, `Glob`, `Grep`, `NotebookRead` |
| shell | `execute_command` | `Bash` |
| questions | `ask_followup_question` | `AskUserQuestion` |
| writes | `write_to_file` | — |

**Any name not in that table, verify against a real prompt rather than guessing it.** Agent CLIs
rename and retire tools between versions, and a rule naming a tool that no longer exists matches
nothing and reports nothing. Two ways to read the real name:

- the panel shows the tool name on a session row waiting for approval
- with `sessionSitter.debugCommands` on, **Test Claude List Approvals** prints Claude's pending
  prompts with their names

The read-only names above are also the ones the deterministic tier already treats as safe with no
rule at all, so a rule approving only reads is often redundant — worth saying before writing one.

### 3. A regex that JSON ate

`matchPattern`, `argumentPattern` and `sessionPattern` are JavaScript regexes **inside JSON
strings**, so every backslash is doubled. An invalid pattern makes the whole rule skip — it never
throws.

```jsonc
{ "matchPattern": "continue?", "response": "yes" }     // ✗ matches "continu" — ? is a quantifier
{ "matchPattern": "continue\\?", "response": "yes" }   // ✓ a literal question mark
{ "argumentPattern": "\"command\":\\s*\"git " }        // ✓ \\s is \s in the regex
```

### 4. Shadowed by a catch-all

First match wins **within an agent's lane**. A `toolPattern: "*"` rule with no `sessionPattern`
makes every later rule with the same `source` unreachable. The two lanes are matched separately, so
a Bob catch-all shadows nothing in the Claude lane.

```jsonc
[
  { "toolPattern": "*", "decision": "approveOnce" },
  { "toolPattern": "execute_command", "decision": "reject" }  // ✗ unreachable
]
```

```jsonc
[
  { "source": "bob", "toolPattern": "*", "decision": "approveForTask" },
  { "source": "claude", "toolPattern": "Read", "decision": "approveOnce" }  // ✓ different lane
]
```

Put the narrow rules first and the catch-all last.

### 5. A scoped Claude approval rule

`sessionPattern` is honoured for Bob rules. A **Claude approval rule carrying one is skipped
entirely** — Claude approvals cannot yet be tied to a session, so a scoped rule is dropped rather
than applied to the wrong session. Drop the `sessionPattern`, or make it a Bob rule.

### 6. A rule aimed at a question

`ask_followup_question` and `AskUserQuestion` **always** go to a human, even against
`toolPattern: "*"`. Resolving a question through the approval channel makes the agent report that
you gave no answer at all. The guard cannot be overridden, and an uncaptured Claude request — one
whose metadata the hook missed — is never auto-approved either, because neither the tool nor whether
it is a question is known.

---

## Worked rules

Every rule below is valid against the real schema.
[`../examples/02-auto-respond-rules.json`](../examples/02-auto-respond-rules.json) holds them as a
file the doctor validates on every CI run.

**Reads never need a prompt.** The cheapest, safest rule there is, and where to start.

```jsonc
{ "toolPattern": "read_file|list_files|glob|grep", "decision": "approveOnce" }
{ "source": "claude", "toolPattern": "Read|Glob|Grep|LS", "decision": "approveOnce" }
```

**A safe subset of commands.** The tool glob matches, and then the argument regex has to match too.

```jsonc
{
  "toolPattern": "execute_command",
  "argumentPattern": "\"command\":\\s*\"(git (status|diff|log)|ls|pwd)",
  "decision": "approveOnce"
}
```

**Tests and builds, for the whole task.** They write only into build output, and an overnight run
that stalls on them is a run that did nothing.

```jsonc
{
  "source": "claude",
  "toolPattern": "Bash",
  "argumentPattern": "\"command\":\\s*\"(npm (test|run build)|npx vitest)",
  "decision": "approveForTask"
}
```

**Anything, but only in a throwaway checkout.** Scoped by project path, so it cannot leak into real
work. Bob only — see trap 5.

```jsonc
{ "toolPattern": "*", "decision": "approveOnce", "sessionPattern": "/scratch/" }
```

**A hard no.** A rejection is a rule too, and it is the honest way to write "never, without asking
me".

```jsonc
{
  "toolPattern": "execute_command",
  "argumentPattern": "\"command\":\\s*\"[^\"]*(rm -rf /|git push --force(?!-with-lease))",
  "decision": "reject"
}
```

**A canned answer.** Keep `matchPattern` narrow: an over-broad pattern answers questions nobody read.

```jsonc
{ "matchPattern": "Do you want to continue\\?", "response": "Yes" }
```

---

## Rules are never silent

Every applied rule is written as a supervision record under `<stateDir>/records/` — the same files
the supervisor writes, with `decided_by: "rule"` and a trace naming the pattern that fired — and
posted to the messaging channel as a **one-way update**, never a decision card. The decision is
already made.

In the **Supervision activity** panel the tiers are tagged: **⚙ rule** for a deterministic rule,
**🧠 AI** for the supervisor. The light follows the outcome — an approve is 🟢, a reject is 🔴, a
canned reply is 🟡.

This needs no configuration. Records go to the extension's own global storage when
`sessionSitter.supervisorStateDir` is unset, and they are written even with
`sessionSitter.autoSupervise: false`, since no classifier is involved. Telegram is the only part that
must be configured; `sessionSitter.supervisor.notifyRuleDecisions: false` keeps rule decisions out of
the channel while still recording them.

---

## Checking a rule before trusting it

```bash
node ../scripts/ss-config.mjs check --json
```

Every finding whose code starts `rule-` concerns this setting: `rule-shape` (half a pair, an unknown
decision, a bad `source`), `rule-bad-regex`, `rule-unreachable`, `rule-claude-scoped`,
`rule-question-tool`, `rule-unknown-field`.

To watch a rule actually fire, open **View → Output → Session Sitter**. Every applied rule logs the
tool name, the glob that matched and the decision taken.
