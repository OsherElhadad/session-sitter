import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The webview toggles panel visibility via the `hidden` attribute
// (e.g. `historyPanel.hidden = !open` in main.js). Elements like
// #history-panel / #activity-panel also set `display: flex` in styles.css.
// An id selector (specificity 1,0,0) beats the UA stylesheet's
// `[hidden] { display: none }`, so without a defensive rule the panels
// never collapse. This test guards the defensive rule that makes the
// `hidden` attribute win.
describe('webview styles.css: hidden attribute is honored', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'styles.css'),
    'utf8',
  );

  it('has a [hidden] rule that forces display:none with !important', () => {
    // Strip comments and whitespace to make matching robust to formatting.
    const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/i;
    expect(normalized).toMatch(rule);
  });
});

// The webview is plain JS with no DOM in the test environment, so what is checkable here is the
// contract between the feed and the renderer: `recordToItem` produces `sessionName`/`host`, and
// main.js must read those exact names and style them. A silent rename on either side is what turns
// the line back into an unattributable row, which is the bug this feature exists to fix.
describe('webview: the activity row names its session and machine', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('reads the session name and host off the feed item', () => {
    expect(main).toContain('item.sessionName');
    expect(main).toContain('item.host');
  });

  it('styles the classes it puts them in', () => {
    expect(main).toContain('activity-session-name');
    expect(main).toContain('activity-session-host');
    expect(css).toMatch(/\.activity-session\s*\{/);
    expect(css).toMatch(/\.activity-session-name\s*\{/);
    expect(css).toMatch(/\.activity-session-host\s*\{/);
  });
});
