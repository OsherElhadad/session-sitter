#!/bin/sh
# Make a copy of the plugin whose PermissionRequest command tees the hook's stdin and
# stdout to disk. The hook code is untouched; only hooks.json's command is wrapped, so
# the decision is the shipped decision. Used to capture the hook JSON in docs/EVIDENCE.md.
set -eu
PLUGIN=${1:?usage: tap-plugin.sh <plugin-dir> <output-dir>}
CAP=${2:?usage: tap-plugin.sh <plugin-dir> <output-dir>}
TAP="${PLUGIN%/}-tap"
rm -rf "$TAP"; cp -R "$PLUGIN" "$TAP"; mkdir -p "$CAP"
CAP="$CAP" TAP="$TAP" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ['TAP']) / 'hooks' / 'hooks.json'
h = json.loads(p.read_text())
cap = os.environ['CAP']
h['hooks']['PermissionRequest'][0]['hooks'][0]['command'] = (
    f"sh -c 'tee -a {cap}/pr-stdin.jsonl "
    '| node "$CLAUDE_PLUGIN_ROOT/lib/hooks/permissionRequest.js" '
    f"| tee -a {cap}/pr-stdout.jsonl'")
p.write_text(json.dumps(h, indent=2))
PY
echo "$TAP"
