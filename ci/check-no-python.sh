#!/usr/bin/env bash
# ============================================================================
# Guard: this extension stays TypeScript, and internal names stay out of it.
# ============================================================================
#
# Two regressions this catches, both easy to reintroduce by copying code in:
#
#   1. A `.py` file appearing in the tree. The whole point of the consolidation
#      (PR #13) was that everything ships as TypeScript. The one place Python is
#      *executed* is the read-only SQLite shim in src/BobDatabase.ts, which calls
#      `python3 -c` — that is a runtime dependency, not a Python source file.
#
#   2. An internal team / project / user slug or host leaking in. The supervision
#      code was ported from a private repository; none of its roster belongs in a
#      public one.
#
# Usage:  bash ci/check-no-python.sh
# Exit:   0 clean · 1 a violation was found
# ============================================================================

set -uo pipefail

fail=0

echo "--- checking for Python source files"
# `-prune` on the generated/vendored trees: a dependency's own .py file is not ours.
py_files="$(find . \
  -path ./node_modules -prune -o \
  -path ./.git -prune -o \
  -path ./out -prune -o \
  -name '*.py' -print 2>/dev/null)"
if [ -n "$py_files" ]; then
  echo "::error::Python source files found — this extension is TypeScript only:"
  echo "$py_files" | sed 's/^/    /'
  fail=1
else
  echo "    none"
fi

echo "--- checking for internal names"
# Deliberately excludes the design record under docs/superpowers/, which *documents*
# that these names were not copied and so must be allowed to mention them.
leaks="$(grep -rniE 'osher|skillberry|github\.ibm\.com' \
  --include='*.ts' --include='*.js' --include='*.json' --include='*.md' \
  --include='*.css' --include='*.yml' --include='*.yaml' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out \
  --exclude-dir=superpowers \
  --exclude=package-lock.json \
  . 2>/dev/null)"
if [ -n "$leaks" ]; then
  echo "::error::internal names found — they must not appear in this repository:"
  echo "$leaks" | sed 's/^/    /'
  fail=1
else
  echo "    none"
fi

echo "--- checking the packaged extension carries no Python"
# The VSIX is what users actually install, so assert on its manifest rather than the
# working tree. `vsce ls` prints one path per line.
if command -v node >/dev/null 2>&1 && [ -d out ]; then
  packaged_py="$(npx --yes @vscode/vsce@3.9.2 ls --no-dependencies 2>/dev/null | grep -E '\.py$' || true)"
  if [ -n "$packaged_py" ]; then
    echo "::error::the .vsix would ship Python files:"
    echo "$packaged_py" | sed 's/^/    /'
    fail=1
  else
    echo "    none"
  fi
else
  echo "    skipped (compile first to check the package manifest)"
fi

echo "--- checking the packaged extension carries no repo tooling"
# CI scripts, the Makefile and the workflows are for developing this extension, not for
# running it. Shipping them to users is harmless but sloppy, and it is easy to reintroduce
# by adding a directory without touching .vscodeignore.
if command -v node >/dev/null 2>&1 && [ -d out ]; then
  packaged_tooling="$(npx --yes @vscode/vsce@3.9.2 ls --no-dependencies 2>/dev/null \
    | grep -E '^(ci/|Makefile|\.github/)' || true)"
  if [ -n "$packaged_tooling" ]; then
    echo "::error::the .vsix would ship repo tooling — add it to .vscodeignore:"
    echo "$packaged_tooling" | sed 's/^/    /'
    fail=1
  else
    echo "    none"
  fi
else
  echo "    skipped (compile first to check the package manifest)"
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "✓ TypeScript only, no internal names, no tooling shipped"
fi
exit "$fail"
