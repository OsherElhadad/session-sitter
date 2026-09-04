#!/usr/bin/env bash
# ============================================================================
# Guard: the project carries exactly one name — Session Sitter.
# ============================================================================
#
# This extension has been renamed twice (from "Claude Session Switcher", and from a
# private project called "reckon" whose supervision runtime it absorbed). A leftover
# of either is a bug report waiting to happen: a setting id nobody can find, a URL
# that redirects, a doc telling the user to look for a panel that no longer exists
# under that name.
#
# Every forbidden spelling is checked, in code AND in prose, across the whole tree.
# There is no allowlist by design: if something here has to change, the name is
# wrong somewhere, not the check.
#
# Usage:  bash ci/check-naming.sh
# Exit:   0 clean · 1 a leftover was found
# ============================================================================

set -uo pipefail

fail=0

# Everything the project must never be called again. Matched case-insensitively.
FORBIDDEN=(
  'Claude Session Switcher'   # the old display name
  'claude-session-switcher'   # the old package / repo / container id
  'claudeSessionSwitcher'     # the old settings + command namespace
  'SessionSwitcher'           # the old class / webview-global name
  'session-switcher'          # the old on-disk directory and log name
  'reckon'                    # the private project the supervisor came from
  '__csw_'                    # the old ext-host global prefix
)

# Generated, vendored, or not ours to rewrite.
EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=out
  --exclude-dir=.vscode-test
  --exclude=package-lock.json
  # This script has to spell out what it forbids, so it is the one file it cannot scan.
  --exclude=check-naming.sh
  # The changelog documents the rename, so naming what the project used to be called is
  # exactly its job — an upgrading user searches their settings for the old key. It is the
  # only prose exemption, and the reason it stays narrow.
  --exclude=CHANGELOG.md
)

echo "--- checking for leftovers of a previous project name"
for pattern in "${FORBIDDEN[@]}"; do
  hits="$(grep -rniF "$pattern" "${EXCLUDES[@]}" . 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "::error::found '$pattern' — the project is called Session Sitter:"
    echo "$hits" | sed 's/^/    /' | head -40
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "    none"

# A filename carries the name just as visibly as its contents — and a stale one shows up in
# every link to it.
echo "--- checking tracked file paths"
path_hits=""
for pattern in "${FORBIDDEN[@]}"; do
  hits="$(git ls-files | grep -iF "$pattern" || true)"
  [ -n "$hits" ] && path_hits+="$hits"$'\n'
done
if [ -n "${path_hits// /}" ]; then
  echo "::error::file paths carry a previous project name:"
  echo "$path_hits" | sed '/^$/d; s/^/    /'
  fail=1
else
  echo "    none"
fi

# The identity a user actually sees. A rename that misses one of these leaves the
# extension listed, configured, or logged under the wrong name.
echo "--- checking the declared identity"
check_json() {
  local query="$1" want="$2" got
  got="$(node -p "const p=require('./package.json'); String($query)" 2>/dev/null || echo '<error>')"
  if [ "$got" != "$want" ]; then
    echo "::error::package.json $query is '$got', expected '$want'"
    fail=1
  else
    printf "    %-52s %s\n" "$query" "$got"
  fi
}
check_json "p.name"                                                      "session-sitter"
check_json "p.displayName"                                               "Session Sitter"
check_json "p.repository.url"                                            "https://github.com/eranra/session-sitter"
check_json "p.contributes.viewsContainers.secondarySidebar[0].id"        "session-sitter"
check_json "p.contributes.viewsContainers.secondarySidebar[0].title"     "Session Sitter"
check_json "p.contributes.views['session-sitter'][0].id"                 "sessionSitter.view"
check_json "[...new Set(p.contributes.commands.map(c=>c.category))].join()" "Session Sitter"
check_json "[...new Set(p.contributes.commands.map(c=>c.command.split('.')[0]))].join()" "sessionSitter"
# `configuration` is an array of titled sections, so every section's properties are checked.
check_json "[...new Set([].concat(p.contributes.configuration).flatMap(s=>Object.keys(s.properties)).map(k=>k.split('.')[0]))].join()" "sessionSitter"

# ---------------------------------------------------------------------------
# One version, too.
# ---------------------------------------------------------------------------
#
# The plugin manifest carries its own `version`, and it is what names the directory an install is
# cloned into (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`). It had already drifted
# five patch releases behind `package.json` before anyone noticed, because nothing read the two
# together — and once `plugin/lib/buildInfo.js` bakes `package.json`'s version, a manifest claiming a
# different one makes `session-sitter --version` inside the plugin disagree with the plugin the user
# installed. That is the kind of disagreement you only discover while trying to reproduce a bug.
echo
echo "--- checking one version across the manifests"
pkg_version="$(node -p "require('./package.json').version" 2>/dev/null || echo '<error>')"
plugin_version="$(node -p "require('./plugin/.claude-plugin/plugin.json').version" 2>/dev/null || echo '<error>')"
if [ "$pkg_version" != "$plugin_version" ]; then
  echo "::error::plugin/.claude-plugin/plugin.json version is '$plugin_version'," \
       "but package.json is '$pkg_version' — bump both"
  fail=1
else
  printf "    %-52s %s\n" "package.json == plugin.json" "$pkg_version"
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "✓ one name everywhere: Session Sitter"
fi
exit "$fail"
