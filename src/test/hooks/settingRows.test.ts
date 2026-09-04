/**
 * The config view's data, and the guard that keeps it from lying.
 *
 * `settingRows` is what the snapshot's config table renders, and its whole value is that it agrees
 * with the ladder's own loader. Two ways that goes wrong, and a test for each:
 *
 *  1. A setting is added to `loadSettings` and nobody says how a terminal sets it, so the table
 *     silently stops covering the configuration surface. Asserted by parsing the
 *     `env.SESSION_SITTER_*` reads out of `settings.ts` itself — a grep for the *symbol* would pass
 *     against a dead constant, so the assertion is over what the loader actually reads.
 *  2. The rendered value drifts from the resolved one, because something re-parsed the environment
 *     instead of asking the loader. Asserted by setting a variable and checking the row moves.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PLUGIN_ENV, loadSettings, settingRows } from '../../hooks/settings';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

/** Every `SESSION_SITTER_*` variable `loadSettings` reads, taken from its own source. */
function readByLoader(): Set<string> {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'hooks', 'settings.ts'), 'utf8');
  // The body of loadSettings only — PLUGIN_ENV is in the same file and would make this vacuous by
  // matching itself.
  const body = source.slice(source.indexOf('export function loadSettings'));
  return new Set([...body.matchAll(/env\.(SESSION_SITTER_[A-Z_]+)/g)].map(m => m[1]));
}

describe('PLUGIN_ENV covers the loader', () => {
  it('names every SESSION_SITTER_* variable loadSettings reads', () => {
    const declared = new Set(Object.values(PLUGIN_ENV));
    for (const name of readByLoader()) {
      expect(declared, `loadSettings reads ${name}, PLUGIN_ENV does not name it`).toContain(name);
    }
  });

  it('and names no variable the loader does not read, so a stale row cannot survive', () => {
    const read = readByLoader();
    for (const name of Object.values(PLUGIN_ENV)) {
      expect(read, `PLUGIN_ENV names ${name}, which loadSettings never reads`).toContain(name);
    }
  });

  it('parsed something at all — this check has gone blind otherwise', () => {
    expect(readByLoader().size).toBeGreaterThan(5);
  });
});

describe('settingRows', () => {
  it('reports the resolved value, not a second read of the environment', () => {
    process.env.SESSION_SITTER_MODE = 'observe';
    const rows = settingRows(loadSettings(process.env));
    expect(rows.find(r => r.key === 'mode')?.value).toBe('observe');
  });

  it('carries a copy-pasteable command per row, which is the only write path', () => {
    const rows = settingRows(loadSettings({}));
    for (const row of rows) {
      expect(row.command).toMatch(/^export SESSION_SITTER_[A-Z_]+=/);
    }
  });

  it('shows the value that flips a boolean, because that is the useful command', () => {
    // preToolUse defaults on, so the command a reader wants is the one that turns it off.
    const rows = settingRows(loadSettings({}));
    const preTool = rows.find(r => r.key === 'preToolUse');
    expect(preTool?.value).toBe('true');
    expect(preTool?.command).toBe('export SESSION_SITTER_PRETOOL=0');
  });

  it('says null for an unset value rather than inventing an empty string', () => {
    const rows = settingRows(loadSettings({}));
    expect(rows.find(r => r.key === 'team')?.value).toBeNull();
  });
});
