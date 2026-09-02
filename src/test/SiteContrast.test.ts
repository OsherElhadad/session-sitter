import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The landing page's palette, counted.
 *
 * This project already shipped one contrast bug: src/webview/styles.css painted the four
 * supervision labels with VS Code's chart *fill* colours, and the orange label measured 2.77:1 on
 * Light Modern. Nothing caught it because nothing was counting. docs/site/site.css encodes the
 * lesson structurally — one text-legible colour per light per theme — and this test is the thing
 * that counts, so it cannot silently drift back.
 *
 * The hexes are read out of the shipped stylesheet, not duplicated here: a token edited in the CSS
 * has to survive this test or the test is theatre.
 */

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'site', 'site.css'), 'utf8');

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.1 contrast ratio. */
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The value of `--token` inside the block that starts at `marker`. Light lives on bare `:root`,
 * dark on `:root[data-theme="dark"]`, so the marker picks the theme.
 */
function token(marker: string, name: string): string {
  const from = css.indexOf(marker);
  expect(from, `${marker} is missing from site.css`).toBeGreaterThan(-1);
  const block = css.slice(from, css.indexOf('}', from));
  const hit = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block);
  expect(hit, `--${name} is missing from ${marker}`).not.toBeNull();
  return (hit as RegExpExecArray)[1];
}

const LIGHT = ':root {';
const DARK = ':root[data-theme="dark"] {';
const LIGHTS = ['green', 'yellow', 'orange', 'red'] as const;

describe('docs/site/site.css: every text token clears 4.5:1', () => {
  for (const [theme, marker] of [['light', LIGHT], ['dark', DARK]] as const) {
    // The terminal is dark in both themes, so its ground is read from :root either way.
    const surfaces = ['bg', 'card'].map((s) => [s, token(marker, s)] as const);

    for (const name of [...LIGHTS, 'fg', 'fg-muted', 'accent'] as const) {
      const fg = token(marker, name);
      for (const [where, bg] of surfaces) {
        it(`${theme}: --${name} ${fg} on --${where} ${bg}`, () => {
          expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    it(`${theme}: the focus ring clears 3:1 on both surfaces`, () => {
      const focus = token(marker, 'focus');
      for (const [, bg] of surfaces) { expect(ratio(focus, bg)).toBeGreaterThanOrEqual(3); }
    });

    it(`${theme}: the primary button's label clears 4.5:1 on --accent`, () => {
      expect(ratio(token(marker, 'bg'), token(marker, 'accent'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  // The ink bands (§3, §7) are #141A2E in BOTH themes and re-declare the dark tokens on .band,
  // so light-theme readers see dark-theme text there. Count that surface too.
  it('the ink band carries the dark tokens legibly', () => {
    const band = '.band {';
    for (const name of [...LIGHTS, 'fg', 'fg-muted', 'accent'] as const) {
      expect(ratio(token(band, name), '#141A2E')).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('docs/site/site.css: the vivid brand fills stay on the dark terminal', () => {
  // --term-bg is #0E1424 in both themes on purpose: a terminal that turns white stops reading as
  // one. These four are the hexes docs/diagrams/*.svg and the real activity feed use.
  it('every vivid fill clears 4.5:1 on --term-bg', () => {
    const term = token(LIGHT, 'term-bg');
    expect(term).toBe('#0E1424');
    for (const name of LIGHTS) {
      expect(ratio(token(LIGHT, `vivid-${name}`), term)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the terminal ink clears 4.5:1 on --term-bg', () => {
    for (const name of ['term-fg', 'term-dim', 'term-user', 'term-mint']) {
      expect(ratio(token(LIGHT, name), '#0E1424')).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The 4px top rule on a §2 card is the graphic that says which light the card is about, so it
  // needs 3:1 — and the vivid hexes do NOT clear it on paper (#3fb950 is 2.54:1 on #FFFFFF). The
  // rule therefore uses the theme-aware token. This asserts it never gets "unified" back.
  it('the §2 card rules use the theme-aware token, not the vivid fill', () => {
    for (const name of LIGHTS) {
      expect(css).toMatch(new RegExp(`\\.claim-${name}\\s*\\{\\s*--rule:\\s*var\\(--${name}\\)`));
    }
  });
});
