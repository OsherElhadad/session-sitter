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

// The webview is plain JS with no DOM under test, so what is checkable here is the contract
// between the three files that have to agree: the extension host renders the button, main.js
// looks it up by that exact id and posts the message the host handles, and styles.css styles the
// classes main.js puts on the elements. A rename on any one side is silent at runtime — the
// button simply does nothing, or the pill silently ignores its colour.
describe('webview: the sort control', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'SessionSitterViewProvider.ts'), 'utf8');

  it('renders the toolbar button main.js looks for', () => {
    expect(provider).toContain('id="sort-btn"');
    expect(main).toContain("getElementById('sort-btn')");
  });

  it('posts the message the extension host handles, under the name it handles it by', () => {
    expect(main).toContain("type: 'setSessionSort'");
    expect(provider).toContain("case 'setSessionSort'");
  });

  it('builds the menu from the modes the host sends, not from its own list', () => {
    expect(main).toContain('message.sortModes');
    expect(main).toContain('message.sortMode');
    expect(provider).toContain('sortModes: SESSION_SORT_MODES');
  });

  it('styles the button and the menu items it creates', () => {
    expect(main).toContain('session-sort-item');
    expect(main).toContain('session-sort-check');
    expect(css).toMatch(/#sort-btn\s*[,{]/);
    expect(css).toMatch(/\.session-sort-item\s*\{/);
    expect(css).toMatch(/\.session-sort-check\s*\{/);
  });
});

describe('webview: the coloured workspace pill', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('reads the colour pair the host resolved off the session row', () => {
    expect(main).toContain('session.workspaceColor');
    expect(main).toContain('.background');
    expect(main).toContain('.foreground');
  });

  it('styles the class it marks a coloured pill with', () => {
    expect(main).toContain('tab-badge--colored');
    expect(css).toMatch(/\.tab-badge--colored\s*\{/);
  });
});

// styles.css has always had a `.tab[aria-selected="true"]` rule, but nothing ever set the
// attribute — so the panel whose whole job is switching between sessions gave no indication of
// which one you were in, and the rule was dead. These assert both halves are present, since
// either one alone is silent at runtime.
describe('webview: the current session is marked on its row', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'SessionSitterViewProvider.ts'), 'utf8');

  it('sets aria-selected on the row, from the id the host sends', () => {
    expect(main).toContain("setAttribute('aria-selected'");
    expect(main).toContain('message.currentSessionId');
    expect(provider).toContain('currentSessionId: current');
  });

  it('still styles the selected row it now marks', () => {
    expect(css).toMatch(/\.tab\[aria-selected="true"\]\s*\{/);
  });

  it('gives the list one tab stop and moves inside it with the arrow keys', () => {
    // 20 rows with tabindex="0" each is 20 presses of Tab before History.
    expect(main).toContain('applyRovingTabindex');
    expect(main).toContain("'ArrowDown'");
    expect(main).toContain("'ArrowUp'");
    expect(main).toContain("'Home'");
    expect(main).toContain("'End'");
  });
});
