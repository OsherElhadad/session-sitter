#!/usr/bin/env bash
# ============================================================================
# Guard: the onboarding skill tells the truth about this build's settings.
# ============================================================================
#
# `docs/onboarding/` is a skill an agent follows to configure Session Sitter for a user. It writes
# to a real `settings.json`, so a stale claim in it is not a documentation bug — it is a wrong
# setting in someone's configuration, applied confidently.
#
# Three ways that goes wrong, and the check for each:
#
#   1. The skill names a setting that no longer exists, or misses one that now does. Every
#      `sessionSitter.*` id mentioned anywhere under docs/onboarding/ is checked against
#      `contributes.configuration` in package.json — which `ci/check-settings.mjs` has already
#      matched against the code.
#
#   2. The doctor's own validations stop firing. `selftest.mjs` drives one fixture per finding code
#      and asserts the code comes back, so a validation silently turning into a no-op fails here.
#      It also re-validates every shipped example, because an example is offered to a user as
#      something to paste.
#
#   3. The offline snapshot drifts from the manifest. It is committed build output — regenerated
#      and diffed rather than trusted.
#
# Usage:  bash ci/check-onboarding.sh
# Exit:   0 clean · 1 a problem was found
# ============================================================================

set -uo pipefail

fail=0

echo "--- the doctor's self-test (every validation fires; every example validates)"
if node docs/onboarding/scripts/selftest.mjs; then
  :
else
  echo "::error::docs/onboarding/scripts/selftest.mjs failed"
  fail=1
fi

echo
echo "--- the offline schema snapshot matches package.json"
if node docs/onboarding/scripts/snapshot-schema.mjs --check; then
  :
else
  fail=1
fi

echo
echo "--- every sessionSitter.* setting the skill names is declared, and none is missing"
# The skill's prose, its examples and its reference tables all name setting ids. A single undeclared
# id is a setting a user would be told to set that VS Code then silently ignores.
#
# Only `.md` and `.json` are scanned — the documents an agent reads aloud and the examples it pastes.
# The two scripts are deliberately excluded from this scan and covered by `selftest.mjs` instead:
# they name ids that are not settings on purpose (a misspelling fixture that must produce a
# `did you mean` suggestion, the two removed keys, and one id assembled from a template literal),
# and teaching this scan about each exception would blunt it for the prose that matters.
if node -e '
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = new Set(
  [].concat(pkg.contributes.configuration).flatMap(s => Object.keys(s.properties ?? {})));

// Named in the prose deliberately, so a user whose configuration still carries one is told to
// delete it. They must not be presented as settings to set.
const REMOVED_ON_PURPOSE = new Set([
  "sessionSitter.uploadScriptPath",
  "sessionSitter.pythonPath",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(full)); }
    else if (/\.(md|json)$/.test(entry.name)) { out.push(full); }
  }
  return out;
}

// The generated snapshot lists every setting by construction, so counting it as coverage would
// make the second half of this check vacuous — it would pass however little the prose said.
const GENERATED = "docs/onboarding/reference/settings-schema.json";

const problems = [];
const mentioned = new Set();
for (const file of walk("docs/onboarding")) {
  const text = readFileSync(file, "utf8");
  for (const [, id] of text.matchAll(/\b(sessionSitter\.[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])\b/g)) {
    if (file !== GENERATED) { mentioned.add(id); }
    if (declared.has(id)) { continue; }
    if (REMOVED_ON_PURPOSE.has(id)) { continue; }
    problems.push(`${file}: names ${id}, which package.json does not declare`);
  }
}

// The other direction: a setting the extension has and the skill never explains is a knob the
// onboarding conversation cannot reach. That is a problem, because the skill promises to cover the
// whole configuration surface — and a new setting added to the extension should show up here as a
// reminder to teach the skill about it.
for (const id of declared) {
  if (!mentioned.has(id)) { problems.push(`docs/onboarding/ never explains ${id}`); }
}

for (const p of problems) { console.error(`::error::${p}`); }
console.log(`${mentioned.size} setting id(s) mentioned, ${declared.size} declared; ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
'; then
  :
else
  fail=1
fi

echo
echo "--- the doctor's environment table agrees with src/settingsBridge.ts"
# The drift this catches actually happened: `settingsBridge.ts` gave the four `telegram.*` settings
# environment equivalents, and the doctor went on resolving them from settings alone — so it reported
# remote control as off on a machine where the daemon had it on.
#
# The two tables answer different questions and are deliberately not equal (see the comment on
# ENV_FALLBACKS), so this asserts the one relationship that must hold: every setting the doctor claims
# has an environment fallback must be an `env` entry in the bridge, under the same variable name. The
# reverse is not required — `STATE_DIR` is in the bridge because the daemon reads it, and the extension
# does not.
if node -e '
const { readFileSync } = require("node:fs");

const doctor = readFileSync("docs/onboarding/scripts/ss-config.mjs", "utf8");
const bridge = readFileSync("src/settingsBridge.ts", "utf8");

// The doctor table: `"sessionSitter.x.y": ["VAR", "VAR2"],` inside the ENV_FALLBACKS literal.
const block = doctor.slice(
  doctor.indexOf("const ENV_FALLBACKS = {"),
  doctor.indexOf("};", doctor.indexOf("const ENV_FALLBACKS = {")));
const claimed = new Map();
for (const m of block.matchAll(/[\x27"](sessionSitter\.[^\x27"]+)[\x27"]:\s*\[([^\]]+)\]/g)) {
  claimed.set(m[1], [...m[2].matchAll(/[\x27"]([A-Z0-9_]+)[\x27"]/g)].map(v => v[1]));
}
if (claimed.size === 0) {
  console.error("::error::parsed no fallbacks out of ss-config.mjs — this check has gone blind");
  process.exit(1);
}

// The bridge: a `{ kind: "env", name: "VAR" }` entry, possibly wrapped across lines. TypeScript
// source uses single quotes, and this script is itself inside single quotes, so \x27 stands in for
// one throughout.
const flat = bridge.replace(/\s+/g, " ");
const Q = "[\x27\"]";
// The trailing comma is optional: an entry that fits on one line has none, and one wrapped across
// lines keeps its own — which is why eight entries went unseen the first time this was written.
const ENTRY = new RegExp(
  Q + "(sessionSitter\\.[^\x27\"]+)" + Q + ": \\{ kind: " + Q + "env" + Q
  + ", name: " + Q + "([A-Z0-9_]+)" + Q + ",? \\}", "g");
const bridged = new Map();
for (const m of flat.matchAll(ENTRY)) { bridged.set(m[1], m[2]); }
if (bridged.size === 0) {
  console.error("::error::parsed no env entries out of src/settingsBridge.ts — this check has gone blind");
  process.exit(1);
}

const problems = [];
for (const [setting, names] of claimed) {
  const inBridge = bridged.get(setting);
  if (inBridge === undefined) {
    problems.push(`ss-config.mjs claims ${setting} falls back to the environment, but `
      + "src/settingsBridge.ts does not list it as an env setting");
    continue;
  }
  // The doctor may list extra historical spellings (BOB_API_KEY, KB_SITTER_*), so the bridge name
  // must be among them rather than equal to the whole list.
  if (!names.includes(inBridge)) {
    problems.push(`${setting}: src/settingsBridge.ts uses ${inBridge}, `
      + `ss-config.mjs reads ${names.join(", ")}`);
  }
}

for (const p of problems) { console.error(`::error::${p}`); }
console.log(`${claimed.size} fallback(s) claimed, ${bridged.size} env setting(s) in the bridge; `
  + `${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
'; then
  :
else
  fail=1
fi

echo
echo "--- every example is valid JSON with comments, and holds only sessionSitter.* keys"
# An example is pasted into a real settings.json, so a stray key from another extension in one
# would be pasted too.
if node -e '
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

// Same JSONC handling ss-config.mjs applies, kept minimal: strings respected so a // inside a
// value survives.
function strip(text) {
  let out = "", inString = false, inLine = false, inBlock = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inLine) { if (ch === "\n") { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      out += ch;
      if (escaped) { escaped = false; } else if (ch === "\\") { escaped = true; }
      else if (ch === "\"") { inString = false; }
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const dir = "docs/onboarding/examples";
const problems = [];
let count = 0;
for (const name of readdirSync(dir).filter(f => f.endsWith(".json"))) {
  const path = join(dir, name);
  let parsed;
  try { parsed = JSON.parse(strip(readFileSync(path, "utf8"))); }
  catch (err) { problems.push(`${path}: does not parse — ${err.message}`); continue; }
  count++;
  for (const key of Object.keys(parsed)) {
    if (!key.startsWith("sessionSitter.")) {
      problems.push(`${path}: holds "${key}", which is not a sessionSitter.* setting`);
    }
  }
}
for (const p of problems) { console.error(`::error::${p}`); }
console.log(`${count} example(s) parsed; ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
'; then
  :
else
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "✓ the onboarding skill matches this build: every setting real, every check firing"
fi
exit "$fail"
