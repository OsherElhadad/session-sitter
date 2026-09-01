/**
 * Per-workspace colour for the workspace pill on a session row.
 *
 * Every pill used to be the theme's badge colour — one colour for every project, which is exactly
 * no help when the panel lists a dozen sessions across five checkouts. Colour is the fastest
 * property to scan, so `sessionSitter.workspaceColors` lets a workspace claim one and keeps the
 * theme colour as the default for everything unclaimed.
 *
 * Matching is first-match-wins over the setting's keys, the same rule `sessionSitter.autoRespond`
 * uses, so key order in your settings is the precedence order.
 *
 * Deliberately free of `vscode` and of any I/O, so it is pure and cheap to test.
 */

/** What the webview needs to paint one pill. */
export interface WorkspaceBadgeColor {
  background: string;
  /** Picked for contrast against `background`, so the label stays readable. */
  foreground: string;
}

/** The subset of a session this module colours by. */
export interface ColourableSession {
  projectName?: string;
  projectPath?: string;
}

/**
 * Colour names a user can write instead of a hex value.
 *
 * Chosen to stay legible on both a light and a dark editor background: mid-tone, saturated, and
 * far enough apart in hue that two adjacent pills are still telling apart at pill size.
 */
export const WORKSPACE_COLOR_NAMES: Readonly<Record<string, string>> = {
  red: '#c0392b',
  orange: '#d35400',
  amber: '#b7791f',
  yellow: '#a68b00',
  lime: '#5f8b1f',
  green: '#2e7d32',
  teal: '#00796b',
  cyan: '#00838f',
  blue: '#1f70c1',
  indigo: '#3f51b5',
  violet: '#6a3ab2',
  purple: '#8250df',
  magenta: '#a52a72',
  pink: '#c2185b',
  brown: '#795548',
  slate: '#4a5568',
  gray: '#5a5a5a',
  grey: '#5a5a5a',
};

/**
 * The value that means "pick one for me".
 *
 * Naming a colour per project is work, and the point is only that projects look different from
 * each other. `auto` hashes the workspace into the palette below: stable across restarts and
 * across machines, because it depends on the name and nothing else.
 */
export const AUTO_COLOR = 'auto';

/** The palette `auto` draws from — the named colours, minus the near-duplicates. */
const AUTO_PALETTE: readonly string[] = [
  WORKSPACE_COLOR_NAMES.blue,
  WORKSPACE_COLOR_NAMES.green,
  WORKSPACE_COLOR_NAMES.purple,
  WORKSPACE_COLOR_NAMES.orange,
  WORKSPACE_COLOR_NAMES.teal,
  WORKSPACE_COLOR_NAMES.pink,
  WORKSPACE_COLOR_NAMES.amber,
  WORKSPACE_COLOR_NAMES.indigo,
  WORKSPACE_COLOR_NAMES.red,
  WORKSPACE_COLOR_NAMES.lime,
  WORKSPACE_COLOR_NAMES.cyan,
  WORKSPACE_COLOR_NAMES.brown,
];

// ── Value parsing ───────────────────────────────────────────────────────────

/** `#rgb` or `#rrggbb`, normalised to lower-case `#rrggbb`. */
function parseHex(value: string): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) { return undefined; }
  const hex = m[1].toLowerCase();
  return hex.length === 3
    ? '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    : '#' + hex;
}

/**
 * A stable, case-insensitive hash of the workspace identity.
 *
 * FNV-1a: small, no dependency, and — the part that matters — deterministic, so the same project
 * gets the same colour in every window and on every machine.
 */
function hashKey(text: string): number {
  let hash = 0x811c9dc5;
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash ^= lower.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The `auto` colour for one workspace identity. */
export function autoColorFor(identity: string): string {
  return AUTO_PALETTE[hashKey(identity) % AUTO_PALETTE.length];
}

/**
 * Turn a setting value into a background colour: `auto`, a palette name, or a hex value.
 * Anything else returns undefined, so a typo leaves the pill on the theme colour instead of
 * painting it something arbitrary.
 */
function parseColorValue(value: unknown, identity: string): string | undefined {
  if (typeof value !== 'string') { return undefined; }
  const text = value.trim();
  if (!text) { return undefined; }
  if (text.toLowerCase() === AUTO_COLOR) { return autoColorFor(identity); }
  const named = WORKSPACE_COLOR_NAMES[text.toLowerCase()];
  if (named) { return named; }
  return parseHex(text);
}

/**
 * Black or white, whichever the background can carry.
 *
 * Relative luminance per WCAG, thresholded once — a pill is small text on a solid fill, so the
 * only real failure mode is white-on-yellow, and one threshold rules it out.
 */
export function contrastingForeground(background: string): string {
  const hex = parseHex(background) ?? '#000000';
  const channel = (from: number): number => {
    const c = parseInt(hex.slice(from, from + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? '#1f1f1f' : '#ffffff';
}

// ── Matching ────────────────────────────────────────────────────────────────

/** Path comparison has to survive Windows separators and a trailing slash. */
function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, '/').toLowerCase();
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * A key with `*` or `?` in it is a glob, matched against the whole string.
 *
 * `*` is any run of characters (path separators included) and `?` is exactly one; everything else
 * is escaped, so a key containing regex punctuation matches literally rather than surprising the
 * user who typed a `.` in a folder name.
 */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map(ch => {
      if (ch === '*') { return '.*'; }
      if (ch === '?') { return '.'; }
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp('^' + body + '$', 'i');
}

/**
 * Does this key claim this session?
 *
 * A key may be a workspace name, a full workspace path, or a glob over either. `*` on its own is
 * the catch-all, which is how "colour every project automatically" is written: `{"*": "auto"}`.
 */
function keyMatches(key: string, name: string, fullPath: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) { return false; }
  if (trimmed === '*') { return true; }
  if (/[*?]/.test(trimmed)) {
    const re = globToRegExp(normalizePath(trimmed));
    return re.test(fullPath) || re.test(name);
  }
  const wanted = normalizePath(trimmed);
  return wanted === name || wanted === fullPath;
}

/**
 * The colour for one session's workspace pill, or undefined to leave it on the theme colour.
 *
 * Keys are tried in the order they appear in the setting — first match wins — so a specific
 * project can override a broad glob by sitting above it.
 */
export function resolveWorkspaceColor(
  session: ColourableSession,
  rules: unknown,
): WorkspaceBadgeColor | undefined {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) { return undefined; }
  const name = normalizePath(session.projectName ?? '');
  const fullPath = normalizePath(session.projectPath ?? '');
  // A session with no workspace at all has nothing to colour by; its pill reads "(no workspace)".
  if (!name && !fullPath) { return undefined; }
  const identity = fullPath || name;

  for (const [key, value] of Object.entries(rules as Record<string, unknown>)) {
    if (!keyMatches(key, name, fullPath)) { continue; }
    const background = parseColorValue(value, identity);
    // An unparsable value is skipped rather than fatal: the next key still gets its turn, and a
    // typo shows up as "this project is not coloured", not as a broken panel.
    if (background) { return { background, foreground: contrastingForeground(background) }; }
  }
  return undefined;
}
