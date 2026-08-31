/**
 * The script that runs on a peer machine to report its sessions.
 *
 * ## Why python3, and why one round trip
 *
 * The peer has no guaranteed `node` on `PATH` and no checkout of this extension, so the probe has
 * to be self-contained and written in something already installed. `python3` is the same
 * dependency `BobDatabase.ts` already relies on for SQLite, so this adds no new requirement — and
 * a peer without it simply reports as unreachable.
 *
 * Everything the panel needs comes back in a single `ssh` invocation, because each extra round
 * trip is another connection setup on the poll path.
 *
 * ## What it deliberately does NOT do
 *
 * It does not derive titles or statuses. Those rules live in TypeScript
 * (`sessionRows.ts`, `SessionManager._parseSessionFile`) and reimplementing them here would give
 * remote rows a second, drifting implementation. The probe ships raw material only: Bob's own DB
 * rows, and the transcript bytes for Claude sessions.
 *
 * ## Scope
 *
 * Only sessions currently **open in a live window** on the peer are reported. That is what makes
 * the payload small enough to poll, and it matches what the panel is for — seeing what is alive
 * now, not scanning another machine's whole history across the network.
 *
 * Compatibility: must parse on **Python 3.9** (the observed peer runs 3.9.25). No `match`, no
 * `X | Y` annotations, no `removeprefix`.
 *
 * ## Delivery
 *
 * Run as `ssh <peer> python3 - <base64-known>` with this text piped to stdin. It cannot be passed
 * as an argument: ssh hands its command words to a **remote shell**, which would tear a
 * multi-line script apart. Its one argument is base64 for the same reason — that alphabet has no
 * characters a shell would act on, so no quoting is involved anywhere.
 */
export const REMOTE_PROBE_PY = String.raw`
import base64, glob, gzip, json, os, socket, sqlite3, sys, time

HOME = os.path.expanduser("~")

# Transcripts the caller already holds, as {sessionId: mtimeMs}, base64-encoded JSON. Anything
# unchanged is reported without its bytes, so a steady-state poll transfers almost nothing.
known = {}
if len(sys.argv) > 1 and sys.argv[1]:
    try:
        known = json.loads(base64.b64decode(sys.argv[1]).decode("utf8")) or {}
    except Exception:
        known = {}

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False

STALE_MS = 24 * 60 * 60 * 1000
now_ms = int(time.time() * 1000)

# Liveness must be decided here. A pid means nothing on the machine that asked.
windows = []
pattern = os.path.join(HOME, ".claude", "session-sitter", "windows", "*.json")
for f in glob.glob(pattern):
    try:
        fh = open(f)
        try:
            d = json.load(fh)
        finally:
            fh.close()
    except Exception:
        continue
    pid = d.get("pid")
    if not isinstance(pid, int):
        continue
    if not isinstance(d.get("workspaceFolders"), list):
        continue
    if not alive(pid):
        continue
    try:
        if now_ms - int(d.get("updatedAt") or 0) > STALE_MS:
            continue
    except Exception:
        continue
    windows.append(d)

open_bob = set()
open_claude = set()
for w in windows:
    for t in (w.get("openBobTaskIds") or []):
        open_bob.add(t)
    for s in (w.get("openClaudeSessionIds") or []):
        open_claude.add(s)

# Bob's DB already holds title and status, so the rows go back verbatim.
bob_rows = []
db = os.path.join(HOME, ".bob", "db", "bob.db")
if open_bob and os.path.exists(db):
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
        conn.row_factory = sqlite3.Row
        holes = ",".join(["?"] * len(open_bob))
        # Same visibility rules as the local scan's BOB_TASKS_SQL, so a peer's empty new chat is
        # hidden exactly like a local one instead of arriving as an untitled row.
        sql = ("SELECT id, project_id, title, status, first_message, created_at, updated_at, env "
               "FROM tasks WHERE id IN (%s) "
               "AND time_archived IS NULL AND first_message IS NOT NULL" % holes)
        for r in conn.execute(sql, tuple(open_bob)):
            bob_rows.append(dict((k, r[k]) for k in r.keys()))
        conn.close()
    except Exception:
        pass

# Claude keeps no title in a queryable store, so the transcript itself has to travel and be
# parsed by the local parser. Head carries the title, tail carries the status; the middle of a
# large transcript is never read by either, so it is not sent.
HEAD = 262144
TAIL = 32768

claude_files = []
projects = os.path.join(HOME, ".claude", "projects")
for sid in open_claude:
    found = None
    for f in glob.glob(os.path.join(projects, "*", sid + ".jsonl")):
        found = f
        break
    if not found:
        continue
    try:
        st = os.stat(found)
    except Exception:
        continue
    mtime = int(st.st_mtime * 1000)
    entry = {"sessionId": sid, "path": found, "size": st.st_size, "mtime": mtime}
    if known.get(sid) != mtime:
        try:
            fh = open(found, "rb")
            try:
                head = fh.read(min(HEAD, st.st_size))
                tail = b""
                if st.st_size > HEAD:
                    fh.seek(max(HEAD, st.st_size - TAIL))
                    tail = fh.read()
            finally:
                fh.close()
            blob = head + tail
            entry["gz"] = base64.b64encode(gzip.compress(blob)).decode("ascii")
            entry["bytes"] = len(blob)
        except Exception:
            pass
    claude_files.append(entry)

# machineId lets the caller notice a peer that is really itself.
print(json.dumps({
    "machineId": "%s:%s" % (socket.gethostname(), os.getuid()),
    "windows": windows,
    "bobRows": bob_rows,
    "claudeFiles": claude_files,
}))
`;
