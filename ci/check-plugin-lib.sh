#!/usr/bin/env bash
# ============================================================================
# Guard: plugin/lib/ is the current build of src/, not a stale copy of it.
# ============================================================================
#
# `plugin/lib/` is committed build output, because a Claude Code plugin is installed by
# cloning a git ref and nothing compiles it on the way in (see docs/PLUGIN.md). Committed
# build output has exactly one failure mode: someone edits the TypeScript, forgets
# `make plugin`, and ships a plugin whose governance logic is a version behind the tests
# that vouch for it. That is worse than not shipping — the tests pass and the plugin is
# wrong.
#
# So this rebuilds the tree and diffs. A difference means the working copy is stale, and
# the fix is always `make plugin && git add plugin/lib`.
#
# The rebuild is deterministic by construction (sorted traversal, no timestamps in the
# generated header), so a clean tree diffs clean.
#
# Usage:  bash ci/check-plugin-lib.sh   (run `make compile` first, or via `make guards`)
# Exit:   0 fresh · 1 stale, or the tree could not be rebuilt
# ============================================================================

set -uo pipefail

fail=0

echo "--- rebuilding plugin/lib from out/"
if ! node scripts/build-plugin-lib.js >/dev/null; then
  echo "::error::could not rebuild plugin/lib — run 'make compile' first"
  exit 1
fi

echo "--- checking plugin/lib matches the rebuild"
if ! git diff --exit-code -- plugin/lib; then
  echo "::error::plugin/lib is stale — run 'make plugin' and commit the result"
  fail=1
fi

# The generated tree must never be hand-edited, and the header says so. Assert the header is
# actually there, or the warning is only in the build script.
echo "--- checking every generated file carries the generated-file header"
missing="$(find plugin/lib -name '*.js' -print0 2>/dev/null \
  | xargs -0 grep -L 'GENERATED FILE' 2>/dev/null || true)"
if [ -n "$missing" ]; then
  echo "::error::these files under plugin/lib lack the generated-file header:"
  echo "$missing" | sed 's/^/    /'
  fail=1
else
  echo "    all present"
fi

# The plugin runs in a bare Node process. `build-plugin-lib.js` refuses to copy a module that
# imports 'vscode', but assert on the shipped tree too — that is what users run.
echo "--- checking the shipped plugin imports no vscode"
vscode_hits="$(grep -rn "require(\"vscode\")\|require('vscode')" plugin/ 2>/dev/null || true)"
if [ -n "$vscode_hits" ]; then
  echo "::error::the plugin imports 'vscode', which does not exist in a hook process:"
  echo "$vscode_hits" | sed 's/^/    /'
  fail=1
else
  echo "    none"
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "✓ plugin/lib is the current build of src/"
fi
exit "$fail"
