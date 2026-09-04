import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { claudeDir, dataDir } from '../hooks/paths';
import { defaultStorePaths } from '../sessionScan';

// `CLAUDE_CONFIG_DIR` is how Claude Code is pointed at a configuration other than `~/.claude` — and
// it is the mechanism every isolated run in docs/EVIDENCE.md and docs/TERMINAL.md relies on to keep a
// test run away from real sessions. Nothing in src/ read it, so `session-sitter status` walked the
// real `~/.claude/projects` no matter what was exported: the command exited 0 and printed a
// plausible table, which is the worst possible way to ignore an isolation request.
//
// Two directions matter and both are asserted, because a fix that only reads the variable when it is
// set is right, and a fix that reads it unconditionally silently relocates every default install.
describe('claudeDir', () => {
  it('honours CLAUDE_CONFIG_DIR when it is set', () => {
    expect(claudeDir({ CLAUDE_CONFIG_DIR: '/tmp/iso/cfg' }, '/home/u')).toBe('/tmp/iso/cfg');
  });

  it('falls back to <homedir>/.claude when it is unset, empty or whitespace', () => {
    const fallback = path.join('/home/u', '.claude');
    expect(claudeDir({}, '/home/u')).toBe(fallback);
    expect(claudeDir({ CLAUDE_CONFIG_DIR: '' }, '/home/u')).toBe(fallback);
    expect(claudeDir({ CLAUDE_CONFIG_DIR: '   ' }, '/home/u')).toBe(fallback);
  });
});

describe('the session store follows CLAUDE_CONFIG_DIR', () => {
  it('reads projects from the isolated config, not from the real home', () => {
    const paths = defaultStorePaths('/home/u', { CLAUDE_CONFIG_DIR: '/tmp/iso/cfg' });
    expect(paths.projectsDir).toBe(path.join('/tmp/iso/cfg', 'projects'));
    // Bob and Codex are other tools with their own configuration; CLAUDE_CONFIG_DIR says nothing
    // about where they keep their sessions, so they stay anchored to the home directory.
    expect(paths.bobDbPath).toBe(path.join('/home/u', '.bob', 'db', 'bob.db'));
    expect(paths.codexSessionsDir).toBe(path.join('/home/u', '.codex', 'sessions'));
  });

  it('still reads the real home when no isolated config is requested', () => {
    const paths = defaultStorePaths('/home/u', {});
    expect(paths.projectsDir).toBe(path.join('/home/u', '.claude', 'projects'));
  });
});

describe("the plugin's own data dir follows CLAUDE_CONFIG_DIR", () => {
  // The explicit overrides still win: SESSION_SITTER_DATA_DIR is what a test sets, and
  // CLAUDE_PLUGIN_DATA is what Claude Code exports for an installed plugin (already inside the
  // active config dir). CLAUDE_CONFIG_DIR only replaces the bare `~/.claude` fallback, which is the
  // path a `--plugin-dir` run or a hand-run hook actually takes.
  it('prefers SESSION_SITTER_DATA_DIR, then CLAUDE_PLUGIN_DATA', () => {
    expect(dataDir({
      SESSION_SITTER_DATA_DIR: '/tmp/d', CLAUDE_PLUGIN_DATA: '/tmp/p', CLAUDE_CONFIG_DIR: '/tmp/c',
    })).toBe('/tmp/d');
    expect(dataDir({ CLAUDE_PLUGIN_DATA: '/tmp/p', CLAUDE_CONFIG_DIR: '/tmp/c' })).toBe('/tmp/p');
  });

  it('falls back inside the isolated config rather than the real home', () => {
    expect(dataDir({ CLAUDE_CONFIG_DIR: '/tmp/iso/cfg' }))
      .toBe(path.join('/tmp/iso/cfg', 'session-sitter'));
  });
});
