/**
 * Focusing a window that lives on another machine.
 *
 * The mechanism is not new. `SessionSitterViewProvider._tryFocusForeignWindow` already focuses
 * another window on *this* machine in two steps:
 *
 *   1. write `focus-<pid>.json` into the owner's `~/.claude/session-sitter/`, telling that window
 *      which session to reveal
 *   2. run the owner's `ideCli --reuse-window <folder>` with `VSCODE_IPC_HOOK_CLI` set to its
 *      socket, which brings the window to the front
 *
 * Both steps simply have to happen on the machine that owns the window, so they cross as one
 * script over one SSH connection. Nothing about the handshake changes.
 *
 * `requestedAt` is stamped by the **remote** clock on purpose: the receiving window rejects a
 * request older than 10 seconds, so stamping it locally would make the handshake fail whenever the
 * two machines' clocks disagree.
 *
 * Delivered on stdin with a single base64 argument, for the reason documented in `SshRunner`: ssh
 * hands its command words to a shell on the far side, so neither a script nor a path can safely
 * travel as an argument.
 *
 * Must parse on Python 3.9.
 */
export const REMOTE_FOCUS_PY = String.raw`
import base64, json, os, subprocess, sys, time

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf8"))

d = os.path.join(os.path.expanduser("~"), ".claude", "session-sitter")
try:
    os.makedirs(d)
except OSError:
    pass

fh = open(os.path.join(d, "focus-%d.json" % int(cfg["pid"])), "w")
try:
    json.dump({"sessionId": cfg["sessionId"], "requestedAt": int(time.time() * 1000)}, fh)
finally:
    fh.close()

env = dict(os.environ)
env["VSCODE_IPC_HOOK_CLI"] = cfg["ipcSocket"]
subprocess.check_call([cfg["ideCli"], "--reuse-window", cfg["folder"]], env=env)
print("focused")
`;
