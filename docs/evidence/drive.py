#!/usr/bin/env python3
"""Drive a real interactive `claude` in a pty and script the keystrokes.

Usage: drive.py <transcript-out> <step-file>
The step file is one JSON object per line:
  {"wait": "<substring to wait for>", "timeout": 60}
  {"send": "text to type"}          {"send": "\r"}  to press Enter
  {"sleep": 3}
Every byte the pty produces is written to <transcript-out> verbatim.
"""
import json, os, pty, re, select, subprocess, sys, time

CUF = re.compile(r'\x1b\[([0-9]+)C')
ANSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB0]|\r')
def clean(s):
    return ANSI.sub('', CUF.sub(lambda m: ' ' * int(m.group(1)), s))

def main():
    out_path, step_path, *cmd = sys.argv[1], sys.argv[2], *sys.argv[3:]
    steps = [json.loads(l) for l in open(step_path) if l.strip()]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execvp(cmd[0], cmd)
    raw = open(out_path, "wb")
    buf = ""
    started = time.time()

    def pump(deadline):
        nonlocal buf
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            raw.write(data); raw.flush()
            buf += clean(data.decode("utf8", "replace"))
            return True
        return True

    for step in steps:
        if "wait" in step:
            needle = step["wait"]; tmo = step.get("timeout", 60)
            deadline = time.time() + tmo
            while needle not in buf and time.time() < deadline:
                if not pump(min(deadline, time.time() + 1)):
                    break
            found = needle in buf
            print(f"[drive] wait {needle!r}: {'FOUND' if found else 'TIMEOUT'} at t+{time.time()-started:.1f}s", flush=True)
            if not found:
                print(f"[drive] last 900 chars of screen:\n{buf[-900:]}", flush=True)
        elif "send" in step:
            os.write(fd, step["send"].encode())
            print(f"[drive] sent {step['send']!r} at t+{time.time()-started:.1f}s", flush=True)
        elif "sleep" in step:
            deadline = time.time() + step["sleep"]
            while time.time() < deadline:
                if not pump(deadline):
                    break
            print(f"[drive] slept {step['sleep']}s (t+{time.time()-started:.1f}s)", flush=True)
    # drain
    deadline = time.time() + 5
    while time.time() < deadline:
        if not pump(deadline):
            break
    os.close(fd)
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    open(out_path + ".clean", "w").write(buf)
    print(f"[drive] done at t+{time.time()-started:.1f}s; clean transcript at {out_path}.clean", flush=True)

main()
