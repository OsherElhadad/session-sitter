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
const declared = Object.keys(pkg.contributes?.configuration?.properties ?? {});
const namespaces = new Set(declared.map(k => k.split('.')[0]));

/** Settings a user sets but no TypeScript reads directly. Keep this list empty if you can. */
const UI_ONLY = new Set();

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
    usedNamespaces.add(ns);
    if (!namespaces.has(ns)) {
      problems.push(
        `${file}: getConfiguration('${ns}') — no setting is declared under that namespace `
        + `(declared: ${[...namespaces].join(', ')})`);
    }
  }

  // `.get<T>('key', default)` / `.get('key')` / `.inspect<T>('key')` — the key is relative to
  // the namespace above it. `inspect` counts as a read: it is how the supervisor settings are
  // read, because it distinguishes "the user set this" from "this is the package.json default".
  for (const [, key] of text.matchAll(/\.(?:get|inspect)(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
    for (const ns of usedNamespaces) { readKeys.add(`${ns}.${key}`); }
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
