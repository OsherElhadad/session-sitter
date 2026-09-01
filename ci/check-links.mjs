#!/usr/bin/env node
/**
 * Offline relative-link check for the Markdown in this repo.
 *
 * A broken `[text](path)` in the README or the docs is the fastest way to lose a reader, and it
 * is invisible in review. This walks every tracked `.md` file and resolves each *relative* link
 * and image against the filesystem.
 *
 * Markdown syntax is not enough on its own. A theme-aware image has to be written as HTML — the
 * README hero is a `<picture>` with a `<source srcset>` and an `<img src>` — and those are exactly
 * the links least likely to be noticed when they break, because a missing image renders as alt
 * text rather than as an error. So HTML image attributes are resolved too.
 *
 * Offline on purpose: external URLs are not checked. A link-checker that hits the network is
 * flaky by construction (rate limits, transient 5xx, sites that block CI), and a flaky required
 * check trains people to ignore CI.
 *
 * `docs/superpowers/` is excluded: those are dated design records, kept as written. Rewriting a
 * historical document to satisfy a linter would falsify the record.
 *
 * Usage:  node ci/check-links.mjs
 * Exit:   0 clean · 1 broken links found
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', '.vscode-test']);
/** Dated historical records — kept as written, so not linted. */
const SKIP_PATHS = [join('docs', 'superpowers')];

/** `[text](target)` and `![alt](target)`. */
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** `<img src="target">` and `<source src="target">`. */
const HTML_SRC_RE = /<(?:img|source)\b[^>]*?\ssrc\s*=\s*["']([^"']*)["']/gi;
/** `<source srcset="a.png 2x, b.png 1x">` — a candidate list; each entry is a URL then descriptors. */
const HTML_SRCSET_RE = /<source\b[^>]*?\ssrcset\s*=\s*["']([^"']*)["']/gi;

/** Every link target in one file's text, from markdown and from HTML image attributes alike. */
function linkTargets(text) {
  const out = [];
  for (const [, target] of text.matchAll(LINK_RE)) { out.push(target); }
  for (const [, target] of text.matchAll(HTML_SRC_RE)) { out.push(target); }
  for (const [, list] of text.matchAll(HTML_SRCSET_RE)) {
    // Each candidate is `<url> [descriptor]`, comma-separated. Only the URL is a path.
    for (const candidate of list.split(',')) { out.push(candidate.trim().split(/\s+/)[0]); }
  }
  return out;
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) { continue; }
      out.push(...markdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function isSkipped(file) {
  const rel = relative(ROOT, file);
  return SKIP_PATHS.some(p => rel.startsWith(p));
}

const broken = [];
let checked = 0;

for (const file of markdownFiles(ROOT)) {
  if (isSkipped(file)) { continue; }
  const text = readFileSync(file, 'utf8');
  const dir = join(file, '..');
  for (const rawTarget of linkTargets(text)) {
    const target = rawTarget.trim();
    // External, mail, inline data, and same-page anchors are out of scope.
    if (/^(https?:|mailto:|data:|#)/.test(target)) { continue; }
    const [path] = target.split('#');
    if (!path) { continue; }
    checked++;
    const resolved = normalize(join(dir, path));
    if (!existsSync(resolved)) {
      broken.push({ file: relative(ROOT, file), target });
      continue;
    }
    // A link to a directory should name one, so the reader is not surprised.
    if (statSync(resolved).isDirectory() && !path.endsWith('/')) {
      broken.push({ file: relative(ROOT, file), target, note: 'is a directory; add a trailing /' });
    }
  }
}

for (const b of broken) {
  const note = b.note ? ` (${b.note})` : '';
  // The ::error:: prefix makes GitHub annotate the file in the PR diff.
  console.error(`::error file=${b.file}::broken relative link: ${b.target}${note}`);
}

console.log(`checked ${checked} relative link(s); ${broken.length} broken`);
process.exit(broken.length === 0 ? 0 : 1);
