#!/usr/bin/env node
/**
 * Keep the settings the code reads and the settings `package.json` declares in agreement.
 *
 * This exists because of a real bug. During the rename, a search-and-replace rewrote the
 * namespace string inside `getConfiguration(...)` to the hyphenated package name while the
 * declarations in `package.json` became camelCase. Nothing failed — `config.get(...)` simply
 * returned the fallback for every key, so supervision and the uploader would have silently done
 * nothing. Neither the compiler nor a string search catches that class of drift; comparing the
 * two sides does.
 *
 * Three checks:
 *   1. every `getConfiguration('<ns>')` uses the one declared namespace
 *   2. every key the code reads is declared
 *   3. every declared setting is read somewhere, or is deliberately listed as UI-only
 *
 * Usage:  node ci/check-settings.mjs
 * Exit:   0 in agreement · 1 drift found
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/**
 * `contributes.configuration` is either one object or an array of titled sections — VS Code
 * accepts both, and this extension uses the array form so the Settings UI groups 29 settings
 * under headings instead of one alphabetical wall. Flatten before comparing, so the shape of the
 * manifest never changes what this guard checks.
 */
function declaredProperties(configuration) {
  const sections = Array.isArray(configuration) ? configuration : [configuration ?? {}];
  return Object.keys(Object.assign({}, ...sections.map(s => s?.properties ?? {})));
}

const declared = declaredProperties(pkg.contributes?.configuration);
const namespaces = new Set(declared.map(k => k.split('.')[0]));

/**
 * Settings a user sets but no TypeScript reads directly. Keep this list empty if you can.
 *
 *  - `sessionSitter.debugCommands` — read by VS Code itself, not by us: it is the `enablement`
 *    expression on the developer probe commands (`config.sessionSitter.debugCommands`), so the
 *    palette hides them unless it is on. No extension code ever needs its value.
 */
const UI_ONLY = new Set(['sessionSitter.debugCommands']);

/**
 * Namespaces owned by ANOTHER extension that we deliberately read. Session Sitter drives other
 * agents' views, so it sometimes has to honour their configuration. We cannot validate these keys
 * against our own `package.json` — the owning extension declares them — so the check we can make
 * is that every such namespace is listed here on purpose, and that its keys are never mistaken for
 * ours. Add one only with a comment naming the owner and the key, and verify the key against that
 * extension's `package.json`.
 *
 *  - `claudeCode` — Anthropic.claude-code. We read `claudeCode.preferredLocation`
 *    ('sidebar' | 'panel') to focus a session where the user's Claude layout actually puts it.
 */
const FOREIGN_NAMESPACES = new Set(['claudeCode']);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests may reference settings that only exist in a fixture, so they are not evidence.
      if (entry.name === 'test') { continue; }
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const problems = [];
const readKeys = new Set();
const usedNamespaces = new Set();

for (const file of sourceFiles('src')) {
  const text = readFileSync(file, 'utf8');

  for (const [, ns] of text.matchAll(/getConfiguration\(\s*'([^']+)'\s*\)/g)) {
    // A foreign namespace is not ours to declare, and its keys must not be attributed to ours,
    // so it never joins `usedNamespaces`.
    if (FOREIGN_NAMESPACES.has(ns)) { continue; }
    usedNamespaces.add(ns);
    if (!namespaces.has(ns)) {
      problems.push(
        `${file}: getConfiguration('${ns}') — no setting is declared under that namespace `
        + `(declared: ${[...namespaces].join(', ')}; `
        + `to read another extension's setting, add the namespace to FOREIGN_NAMESPACES)`);
    }
  }

  // A read chained straight onto a foreign namespace, e.g.
  // `getConfiguration('claudeCode').get<string>('preferredLocation')`. Record where it sits so the
  // generic scan below cannot attribute that key to OUR namespace — key attribution is otherwise
  // a deliberate cross-product (a `cfg` handle is often read far from where it was created, and
  // through the `supervisorSettings.ts` helpers), which would claim `sessionSitter.<foreign key>`.
  const foreignReadSpans = [];
  for (const m of text.matchAll(/getConfiguration\(\s*'([^']+)'\s*\)\s*\.(?:get|inspect)(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
    if (FOREIGN_NAMESPACES.has(m[1])) { foreignReadSpans.push([m.index, m.index + m[0].length]); }
  }
  const insideForeignRead = i => foreignReadSpans.some(([from, to]) => i >= from && i < to);

  // `.get<T>('key', default)` / `.get('key')` / `.inspect<T>('key')` — the key is relative to
  // the namespace above it. `inspect` counts as a read: it is how the supervisor settings are
  // read, because it distinguishes "the user set this" from "this is the package.json default".
  for (const m of text.matchAll(/\.(?:get|inspect)(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
    if (insideForeignRead(m.index)) { continue; }
    for (const ns of usedNamespaces) { readKeys.add(`${ns}.${m[1]}`); }
  }

  // The same read through the two `supervisorSettings.ts` helpers, which wrap `inspect()` so an
  // unset setting can fall back to the environment: `userValue<T>(cfg, 'key')` / `userText(cfg,
  // 'key')`. Without this the whole `sessionSitter.supervisor.*` group looks unread.
  for (const [, key] of text.matchAll(/\buser(?:Value|Text)(?:<[^>]*>)?\(\s*\w+\s*,\s*'([^']+)'/g)) {
    for (const ns of usedNamespaces) { readKeys.add(`${ns}.${key}`); }
  }
}

for (const key of readKeys) {
  // Only judge keys under a real namespace; a `.get()` on some other object is not our business.
  if (!namespaces.has(key.split('.')[0])) { continue; }
  if (!declared.includes(key)) {
    problems.push(`code reads '${key}' but package.json does not declare it`);
  }
}

for (const key of declared) {
  if (UI_ONLY.has(key)) { continue; }
  if (!readKeys.has(key)) {
    problems.push(`package.json declares '${key}' but no source file reads it`);
  }
}

for (const p of problems) { console.error(`::error::${p}`); }
console.log(
  `${declared.length} declared setting(s), namespace '${[...namespaces].join(', ')}'; `
  + `${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
