#!/usr/bin/env node
/**
 * Build `plugin/lib/` — the committed JavaScript the Claude Code plugin actually runs.
 *
 * A plugin is installed by cloning a git ref into `~/.claude/plugins/cache/…`. Nothing compiles it
 * on the way in, so a plugin written in TypeScript has to ship JavaScript. The alternative —
 * hand-writing the hooks in JS — would fork the decision logic away from the tested engine and give
 * this repository two definitions of what "red" means. Committing build output is the smaller cost.
 *
 * The file list is **derived, not maintained**: this script walks the relative `require()` graph out
 * from the hook and CLI entry points, so adding an import to a hook cannot leave a missing module to
 * be discovered by a user at a permission prompt. Two invariants are enforced while walking:
 *
 *  - no module in the closure may import `vscode` — the plugin runs in a bare Node process;
 *  - no module may reach outside `out/`.
 *
 * Output is deterministic (no timestamps, sorted traversal) because CI rebuilds it and runs
 * `git diff --exit-code plugin/lib`, so a stale artifact fails the build rather than shipping.
 *
 * Usage:  node scripts/build-plugin-lib.js   (via `make plugin`)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'out');
const libDir = path.join(repoRoot, 'plugin', 'lib');

/** Everything the plugin invokes directly, as paths relative to `out/`. */
const ENTRY_POINTS = [
  'hooks/permissionRequest.js',
  'hooks/configChange.js',
  'hooks/sessionStart.js',
  'hooks/postToolUse.js',
  'hooks/sessionEnd.js',
  'hooks/notification.js',
  'audit/cli.js',
  'policy/cli.js',
];

const HEADER = (rel) => `// GENERATED FILE — DO NOT EDIT.
// Compiled from src/${rel.replace(/\.js$/, '.ts')} by scripts/build-plugin-lib.js (\`make plugin\`).
// Edit the TypeScript source and re-run \`make plugin\`; CI fails if this tree is stale.
`;

/** Every relative `require('./x')` in a compiled CommonJS module. */
function relativeRequires(source) {
  const found = new Set();
  const re = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) { found.add(m[1]); }
  return [...found].sort();
}

/** Bare (non-relative) requires, so the vscode invariant can be checked. */
function bareRequires(source) {
  const found = new Set();
  const re = /require\(\s*["']([^.'"][^"']*)["']\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) { found.add(m[1]); }
  return [...found];
}

/** Resolve a relative require to a path relative to `out/`, tolerating a missing `.js`. */
function resolveRel(fromRel, spec) {
  const base = path.join(path.dirname(fromRel), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(path.join(outDir, candidate))) { return candidate; }
  }
  throw new Error(`cannot resolve require('${spec}') from out/${fromRel} — run \`make compile\` first`);
}

function collect() {
  const closure = new Set();
  const queue = [...ENTRY_POINTS];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (closure.has(rel)) { continue; }
    const full = path.join(outDir, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`missing out/${rel} — run \`make compile\` first`);
    }
    if (path.relative(outDir, full).startsWith('..')) {
      throw new Error(`out/${rel} escapes out/`);
    }
    const source = fs.readFileSync(full, 'utf8');
    for (const bare of bareRequires(source)) {
      if (bare === 'vscode' || bare.startsWith('vscode/')) {
        throw new Error(`out/${rel} imports 'vscode'; the plugin runs in a bare Node process`);
      }
    }
    closure.add(rel);
    for (const spec of relativeRequires(source)) { queue.push(resolveRel(rel, spec)); }
  }
  return [...closure].sort();
}

function main() {
  const files = collect();

  // Rebuild the tree from scratch, so a module that stops being needed also stops being shipped.
  fs.rmSync(libDir, { recursive: true, force: true });
  for (const rel of files) {
    const source = fs.readFileSync(path.join(outDir, rel), 'utf8')
      // The .map files are not shipped, so a sourceMappingURL pointing at nothing is just noise.
      .replace(/^\/\/# sourceMappingURL=.*$\n?/m, '');
    // A shebang is only a shebang on line 1, so the header goes underneath it when there is one.
    const shebang = /^#!.*\n/.exec(source);
    const body = shebang
      ? shebang[0] + HEADER(rel) + source.slice(shebang[0].length)
      : HEADER(rel) + source;
    const dest = path.join(libDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }

  process.stdout.write(`plugin/lib: ${files.length} modules\n`);
  for (const rel of files) { process.stdout.write(`  ${rel}\n`); }
}

main();
