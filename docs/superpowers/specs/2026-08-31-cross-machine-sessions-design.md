# Cross-machine sessions — design

*2026-08-31*

## Problem

Two IDE windows attached to two different machines show two different session lists. A window
whose workspace lives on machine A cannot see the agent sessions of a window attached to machine B.

This is not a bug. Every session source this extension reads is rooted at `os.homedir()`:

| What | Where | Reference |
| --- | --- | --- |
| Claude transcripts | `~/.claude/projects` | `SessionManager.ts` |
| Bob tasks | `~/.bob/db/bob.db` | `SessionManager.ts` |
| Codex rollouts | `~/.codex/sessions` | `SessionManager.ts` |
| Peer windows | `~/.claude/session-sitter/windows/` | `WindowRegistry.ts` |

The extension runs in the **remote** extension host on purpose, so it can reach the remote
filesystem (`docs/ARCHITECTURE.md`). One extension host per machine therefore means one `$HOME`
per machine, and "cross-window" has always meant cross-window *on a single machine*.

Observed case: a WSL window (`/home/eranra`) and a window attached to
`vpcuser@olapevolve...` (`/home/vpcuser`). Both run this extension, both publish a window entry,
neither can read the other's.

## Goals

- A window shows sessions from peer machines it can reach, with no user configuration.
- Clicking a peer session focuses the owning window on that machine.
- One setting turns all of it off, including discovery, so the extension opens no SSH connection.

## Non-goals

- **Symmetric visibility.** Reachability is one-way in practice: a laptop or WSL box behind NAT
  runs no reachable sshd, so the remote cannot pull back. Each window pulls from what it can
  reach and says in the UI which peers it could not.
- **Cross-machine supervision.** Supervision stays local to the host that owns the session.
  The supervisor writes state directories and drives agent CLIs; extending that across a
  network is a separate design.

## Architecture

Five units, each independently testable.

### 1. `remote/PeerDiscovery.ts` — who are my peers

The IDE already records every remote window the user has opened. Discovery mines that record, so
enumerating peers costs no SSH traffic at all.

Source: `globalStorage/state.vscdb` of each installed IDE, found by glob rather than by
hardcoded app or user name:

```
/mnt/c/Users/*/AppData/Roaming/*/User/globalStorage/state.vscdb   (WSL: hub reachable via /mnt/c)
<local appdata>/*/User/globalStorage/state.vscdb                  (local extension host)
```

Authorities appear in two forms, and both are mined:

- **Keys** — `remote.tunnels.toRestore.ssh-remote+<authority>.<windowId>`
- **Values** — folder URIs, percent-encoded: `vscode-remote://ssh-remote%2B<authority>/...`

Extraction rules, each one a test case:

- strip a trailing `.<windowId>`, where the id may be negative (`.-628450726`)
- percent-decode (`%2B` → `+`, `%40` → `@`)
- keep only authorities of the form `user@host`; a bare host has no username to connect as
- dedupe, then drop self (see below)

Reads go through the existing python3 SQLite shim in `BobDatabase.ts` — the one place this
extension reads SQLite. The DB is copied to a temp file before reading, because the IDE holds it
open and reading it in place over `/mnt/c` can fail on a lock.

Where no state DB is reachable, discovery returns nothing and the feature stays dormant.

### 2. `remote/SshRunner.ts` — the one place SSH runs

Mirrors the discipline of `BobDatabase.ts`: a single module owns the transport, so its options and
failure handling are in one auditable place.

```
-o BatchMode=yes                     never prompts, never hangs
-o ConnectTimeout=10
-o ControlMaster=auto
-o ControlPath=<dir>/ss-%C
-o ControlPersist=60
```

`BatchMode=yes` is what makes automatic discovery safe to ship: a peer that would ask for a
password or a key passphrase fails immediately and is reported unreachable, rather than blocking
the extension on a prompt nobody will see.

Every value crosses as `argv`. Nothing is interpolated into a shell string.

This module also owns the **negative cache**: a peer that fails backs off exponentially to a cap,
so a decommissioned host is not retried on every pass.

### 3. The remote probe — one round trip, one JSON payload

A python3 script sent with `ssh <peer> python3 -c <script>`, returning:

- a machine id, used for self-exclusion
- live window entries
- Bob task rows
- Claude session rows

Constraints:

- **Python 3.9 compatible.** The observed remote runs 3.9.25 — no `match`, no `X | Y` annotations.
- **Liveness is resolved on the remote.** `process.kill` and `/proc` describe the local machine
  only, so the probe filters windows with `kill -0` on the remote and returns only live ones.
  `readLiveWindows` is never applied to a remote entry.
- A peer without python3 fails the probe and is reported unreachable.

### 4. `remote/RemoteSessionSource.ts` — probe JSON to sessions

Converts a payload into `ClaudeSession[]` tagged with the peer, plus a `PeerStatus[]` for the UI.
Joins the merge in `SessionManager._scanSessions` as a fifth source.

**The merge must not await the network.** `_scanSessions` awaits its sources in sequence, so an
inline SSH call would stall the panel behind a slow link. Instead:

- a **separate, slower timer** refreshes a cache of remote rows
- the merge reads that cache synchronously

Local scanning keeps its present cadence and never waits on SSH.

Remote entries may come from an older build of this extension than the local one — the observed
pair is 0.5.0 remote against 0.6.3 local — so every field read tolerates absence.

### 5. Remote focus — the existing handshake, one hop further

`SessionSitterViewProvider._tryFocusForeignWindow` already focuses another window in two steps:

1. write `focus-<pid>.json` into the owner's `~/.claude/session-sitter/`
2. run the owner's `ideCli --reuse-window <folder>` with `VSCODE_IPC_HOOK_CLI` set to its socket

For a remote owner both steps move to the far side of one SSH call. The mechanism is unchanged;
only its location moves. The remote window entry already carries what is needed:

```json
{ "ideCli": "~/.bobide-server/bin/<hash>/bin/remote-cli/bobide",
  "ipcSocket": "/run/user/1000/vscode-ipc-<uuid>.sock" }
```

## Setting

```
sessionSitter.remotePeers: "auto" | "off"     default "auto"
```

`"off"` disables discovery, the refresh timer, and every SSH call — the extension opens no
connection. Follows the existing flat `sessionSitter.*` enum pattern.

## Error handling

Every failure collapses to *this peer is unreachable, with a reason shown in the UI*:

| Failure | Result |
| --- | --- |
| SSH connect/auth failure | unreachable, backoff |
| no python3 on peer | unreachable, backoff |
| malformed probe JSON | unreachable, backoff |
| timeout | unreachable, backoff |
| peer resolves to self | dropped silently, not an error |

Nothing prompts, and no failure blocks the local scan.

## Testing

`src/test/*.test.ts`, vitest, matching the existing suite.

| Unit | Cases |
| --- | --- |
| `PeerDiscovery` | window-id stripping incl. negative ids; percent-decoding; bare host rejected; dedupe; self-exclusion; no state DB reachable |
| `SshRunner` | `BatchMode`/`ControlMaster` present; argv never shell-interpolated; backoff schedule; cap |
| `RemoteSessionSource` | happy path; malformed JSON; missing fields (old remote build); peer tagging |
| focus | both handshake steps issued; `VSCODE_IPC_HOOK_CLI` set to the remote socket |

Remote focus is additionally verified once against the real remote window before UI is built on
top of it, since it is the one step in this design that could not be proven during exploration.
