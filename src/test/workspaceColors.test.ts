import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_COLOR_NAMES,
  autoColorFor,
  contrastingForeground,
  resolveWorkspaceColor,
} from '../workspaceColors';

// The setting is hand-written JSON, so most of the risk here is bad input: a typo'd colour, a
// pattern with regex punctuation in it, a Windows path, a value that is not a string at all. None
// of those may break the panel — the pill just stays on the theme colour.

const alpha = { projectName: 'alpha', projectPath: '/home/me/work/alpha' };

describe('resolveWorkspaceColor: matching', () => {
  it('returns nothing when no rules are configured', () => {
    expect(resolveWorkspaceColor(alpha, {})).toBeUndefined();
    expect(resolveWorkspaceColor(alpha, undefined)).toBeUndefined();
  });

  it('ignores a setting of the wrong shape instead of throwing', () => {
    expect(resolveWorkspaceColor(alpha, [])).toBeUndefined();
    expect(resolveWorkspaceColor(alpha, 'blue')).toBeUndefined();
    expect(resolveWorkspaceColor(alpha, null)).toBeUndefined();
  });

  it('matches a workspace by name', () => {
    expect(resolveWorkspaceColor(alpha, { alpha: 'green' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.green);
  });

  it('matches a workspace by full path', () => {
    expect(resolveWorkspaceColor(alpha, { '/home/me/work/alpha': 'teal' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.teal);
  });

  it('ignores case and a trailing slash on a path key', () => {
    expect(resolveWorkspaceColor(alpha, { '/Home/Me/Work/Alpha/': 'red' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.red);
  });

  it('matches a Windows-style path against a forward-slash key, and the reverse', () => {
    const win = { projectName: 'alpha', projectPath: 'C:\\work\\alpha' };
    expect(resolveWorkspaceColor(win, { 'c:/work/alpha': 'blue' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.blue);
    expect(resolveWorkspaceColor(win, { 'C:\\work\\alpha': 'blue' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.blue);
  });

  it('supports a glob over the path', () => {
    expect(resolveWorkspaceColor(alpha, { '/home/me/work/*': 'purple' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.purple);
    expect(resolveWorkspaceColor(alpha, { '/home/other/*': 'purple' })).toBeUndefined();
  });

  it('supports a glob over the name, with ? matching exactly one character', () => {
    expect(resolveWorkspaceColor(alpha, { 'alph?': 'pink' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.pink);
    expect(resolveWorkspaceColor(alpha, { 'alph??': 'pink' })).toBeUndefined();
  });

  it('treats regex punctuation in a key literally', () => {
    const dotted = { projectName: 'my.app', projectPath: '/w/my.app' };
    expect(resolveWorkspaceColor(dotted, { 'my.app': 'amber' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.amber);
    // 'my?app' is a single-character wildcard, so it still matches 'my.app' …
    expect(resolveWorkspaceColor(dotted, { 'my?app': 'amber' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.amber);
    // … but a literal key with a different character does not.
    expect(resolveWorkspaceColor({ projectName: 'myXapp', projectPath: '/w/myXapp' },
      { 'my.app': 'amber' })).toBeUndefined();
  });

  it('lets * claim every workspace', () => {
    expect(resolveWorkspaceColor(alpha, { '*': 'slate' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.slate);
  });

  it('gives the first matching key precedence, so a specific rule can sit above a glob', () => {
    const rules = { alpha: 'green', '*': 'slate' };
    expect(resolveWorkspaceColor(alpha, rules)?.background).toBe(WORKSPACE_COLOR_NAMES.green);
    expect(resolveWorkspaceColor({ projectName: 'beta', projectPath: '/w/beta' }, rules)?.background)
      .toBe(WORKSPACE_COLOR_NAMES.slate);
  });

  it('leaves a session with no workspace on the theme colour', () => {
    expect(resolveWorkspaceColor({ projectName: '', projectPath: '' }, { '*': 'green' }))
      .toBeUndefined();
    expect(resolveWorkspaceColor({}, { '*': 'green' })).toBeUndefined();
  });

  it('skips an empty key rather than matching everything with it', () => {
    expect(resolveWorkspaceColor(alpha, { '': 'green' })).toBeUndefined();
  });
});

describe('resolveWorkspaceColor: values', () => {
  it('accepts a #rrggbb hex value as given', () => {
    expect(resolveWorkspaceColor(alpha, { alpha: '#1A2B3C' })?.background).toBe('#1a2b3c');
  });

  it('expands a #rgb shorthand', () => {
    expect(resolveWorkspaceColor(alpha, { alpha: '#0f8' })?.background).toBe('#00ff88');
  });

  it('trims surrounding whitespace in a value', () => {
    expect(resolveWorkspaceColor(alpha, { alpha: '  green  ' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.green);
  });

  it('skips a value it cannot parse and tries the next key', () => {
    expect(resolveWorkspaceColor(alpha, { alpha: 'chartreuse', '*': 'blue' })?.background)
      .toBe(WORKSPACE_COLOR_NAMES.blue);
    expect(resolveWorkspaceColor(alpha, { alpha: 'chartreuse' })).toBeUndefined();
    expect(resolveWorkspaceColor(alpha, { alpha: '#12345' })).toBeUndefined();
    expect(resolveWorkspaceColor(alpha, { alpha: 42 })).toBeUndefined();
    expect(resolveWorkspaceColor(alpha, { alpha: '' })).toBeUndefined();
  });
});

describe('auto colours', () => {
  it('gives a workspace the same colour every time', () => {
    expect(autoColorFor('/home/me/work/alpha')).toBe(autoColorFor('/home/me/work/alpha'));
  });

  it('ignores case, so the same project on two machines matches', () => {
    expect(autoColorFor('/Work/Alpha')).toBe(autoColorFor('/work/alpha'));
  });

  it('picks a colour from the palette', () => {
    const palette = new Set(Object.values(WORKSPACE_COLOR_NAMES));
    expect(palette.has(autoColorFor('anything'))).toBe(true);
  });

  it('gives different projects different colours', () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    expect(new Set(names.map(autoColorFor)).size).toBeGreaterThan(1);
  });

  it('resolves "auto" through the setting, keyed by the workspace path', () => {
    const resolved = resolveWorkspaceColor(alpha, { '*': 'auto' });
    expect(resolved?.background).toBe(autoColorFor('/home/me/work/alpha'));
  });

  it('accepts "AUTO" in any case', () => {
    expect(resolveWorkspaceColor(alpha, { '*': 'Auto' })?.background)
      .toBe(autoColorFor('/home/me/work/alpha'));
  });

  it('keys auto off the name when the session has no path', () => {
    const nameOnly = { projectName: 'alpha', projectPath: '' };
    expect(resolveWorkspaceColor(nameOnly, { '*': 'auto' })?.background).toBe(autoColorFor('alpha'));
  });
});

describe('contrastingForeground', () => {
  it('uses white on a dark fill and near-black on a light one', () => {
    expect(contrastingForeground('#000000')).toBe('#ffffff');
    expect(contrastingForeground('#ffffff')).toBe('#1f1f1f');
    expect(contrastingForeground('#ffff00')).toBe('#1f1f1f');
    expect(contrastingForeground('#1f70c1')).toBe('#ffffff');
  });

  it('picks a readable foreground for every named colour', () => {
    for (const [name, hex] of Object.entries(WORKSPACE_COLOR_NAMES)) {
      const fg = contrastingForeground(hex);
      expect(['#ffffff', '#1f1f1f'], name).toContain(fg);
    }
  });

  it('falls back to white when the background is not a hex value', () => {
    expect(contrastingForeground('nonsense')).toBe('#ffffff');
  });

  it('always pairs a foreground with the background it resolved', () => {
    const resolved = resolveWorkspaceColor(alpha, { alpha: '#ffffff' });
    expect(resolved).toEqual({ background: '#ffffff', foreground: '#1f1f1f' });
  });
});
