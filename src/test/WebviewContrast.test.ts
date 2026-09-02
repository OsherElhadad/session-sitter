import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// WCAG 2.1 contrast, computed from the real files: the colours come out of
// `src/webview/styles.css`, the `--vscode-*` values they resolve to come out of
// `tools/screenshots/themes.mjs` (VS Code's own Dark Modern / Light Modern defaults).
//
// This exists because the traffic-light labels were painted with `--vscode-charts-*`, which are
// chart *fill* colours: on Light Modern the yellow label sat at 2.70:1 and the orange at 2.77:1
// against the panel, and nothing measured it, so nothing complained. The numbers below are the
// check that was missing.

const AA_NORMAL = 4.5;

const ROOT = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'styles.css'), 'utf8');
const THEMES_SRC = fs.readFileSync(
  path.join(ROOT, 'tools', 'screenshots', 'themes.mjs'), 'utf8');

// ── WCAG maths ─────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What `opacity: a` on text actually renders as: the colour composited over its background. */
function fade(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg), b = parseHex(bg);
  return '#' + f
    .map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('');
}

// ── Reading the two real files ─────────────────────────────────────────────

/** The `--vscode-*` values from themes.mjs, read as text so the test needs no ESM interop. */
function theme(name: 'dark' | 'light'): Record<string, string> {
  const block = THEMES_SRC.match(
    new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`))?.[1];
  expect(block, `themes.mjs exports ${name}`).toBeTruthy();
  const values: Record<string, string> = {};
  for (const [, key, value] of (block as string).matchAll(
    /^\s*'?([\w-]+)'?:\s*'(#[0-9a-fA-F]{3,8})'/gm)) {
    values[key] = value;
  }
  return values;
}

const THEMES = { dark: theme('dark'), light: theme('light') };

/** The declaration block of a rule, by its exact selector text. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`(?:^|\\n)${escaped}[^{}]*\\{([^}]*)\\}`));
  expect(match, `styles.css has a rule for ${selector}`).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

/** The token a rule paints its text with — or `editor-foreground`, inherited from `body`. */
function colorToken(body: string): string {
  return body.match(/color:\s*var\(--vscode-([\w-]+)/)?.[1] ?? 'editor-foreground';
}

function opacityOf(body: string): number {
  return Number(body.match(/(?:^|;)\s*opacity:\s*([\d.]+)/)?.[1] ?? '1');
}

/**
 * The rendered contrast of one selector's text against one background token, in one theme.
 * `parent` names an ancestor whose own `opacity` multiplies this one's — CSS opacity compounds.
 */
function ratioFor(
  selector: string, themeName: 'dark' | 'light', bgToken: string, parent?: string,
): number {
  const t = THEMES[themeName];
  const body = ruleBody(selector);
  const fg = t[colorToken(body)];
  const bg = t[bgToken];
  expect(fg, `${themeName} defines ${colorToken(body)}`).toBeTruthy();
  expect(bg, `${themeName} defines ${bgToken}`).toBeTruthy();
  const alpha = opacityOf(body) * (parent ? opacityOf(ruleBody(parent)) : 1);
  return contrast(alpha < 1 ? fade(fg, bg, alpha) : fg, bg);
}

// Both, because the panel's own rule paints `editor-background` while the sidebar it lives in is
// `sideBar-background` — and each is the stricter of the pair in one theme.
const BACKGROUNDS = ['sideBar-background', 'editor-background'] as const;

/** Every selector whose text must clear AA at normal size. All of these are small text. */
const TEXT: Array<[selector: string, parent?: string]> = [
  // The four traffic-light labels and the state badge beside them.
  ['.activity-light'],
  ['.activity-item.activity-failed .activity-light'],
  ['.activity-state'],
  ['.activity-awaiting-badge'],
  // Muted feed and row text — every one of these dims an already-muted colour.
  ['.activity-meta'],
  ['.activity-timeago'],
  ['.activity-line'],
  ['.activity-line-label'],
  ['.activity-you'],
  ['.activity-note'],
  ['.activity-session'],
  ['.activity-session-host', '.activity-session'],
  ['.tab-time'],
  ['.preview-path'],
  ['.preview-time'],
  ['.about-built'],
  // Toolbar buttons and the two section toggles, at their resting (dimmed) opacity.
  ['#menu-btn'],
  ['#sort-btn'],
  ['#new-session-btn,\n#new-bob-session-btn'],
  ['#history-toggle'],
  ['#activity-toggle'],
];

describe('webview styles.css: text clears WCAG AA on Dark Modern and Light Modern', () => {
  for (const themeName of ['dark', 'light'] as const) {
    for (const bgToken of BACKGROUNDS) {
      for (const [selector, parent] of TEXT) {
        it(`${selector.replace(/\n/g, ' ')} on ${themeName} ${bgToken}`, () => {
          const ratio = ratioFor(selector, themeName, bgToken, parent);
          expect(
            Number(ratio.toFixed(2)),
            `${selector} is ${ratio.toFixed(2)}:1, needs ${AA_NORMAL}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
  }

  // The labels are no longer coloured, so the colour has to still be carried somewhere or the four
  // lights become one. It is: the left border (here) and the emoji dot main.js writes.
  it('still tells the four lights apart by the border colour', () => {
    for (const light of ['green', 'yellow', 'orange', 'red']) {
      expect(CSS).toMatch(new RegExp(
        `\\.activity-item\\.activity-${light}\\s*\\{[^}]*border-left-color:\\s*var\\(--vscode-charts-${light}`));
    }
  });

  // The regression itself: `charts-*` are fills, and this asserts they are not used as label text
  // again. (They stay legitimate for the border above and the .status-waiting dot.)
  it('does not paint the label text from the chart palette', () => {
    for (const rule of CSS.match(/[^{}]*\.activity-light[^{}]*\{[^}]*\}/g) ?? []) {
      expect(rule, rule).not.toMatch(/color:\s*var\(--vscode-charts-/);
    }
    expect(ruleBody('.activity-awaiting-badge')).not.toContain('--vscode-charts-');
  });
});
