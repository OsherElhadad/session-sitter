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

// The activity feed's four traffic lights were fixed GitHub-dark hexes, so the yellow was
// unreadable on a light theme. The brand badges (Claude terracotta, Bob blue, …) are fixed on
// purpose and stay that way — this asserts only that the lights are theme tokens.
describe('webview styles.css: the panel follows the theme', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'styles.css'),
    'utf8',
  );

  it('paints the four traffic lights from theme tokens', () => {
    for (const light of ['green', 'yellow', 'orange']) {
      expect(css).toMatch(
        new RegExp(`\\.activity-${light}\\s*\\{[^}]*var\\(--vscode-charts-${light}`),
      );
    }
    expect(css).toMatch(/\.activity-red\s*\{[^}]*var\(--vscode-charts-red/);
  });

  it('leaves no bare GitHub-dark hex as a light colour', () => {
    // Still allowed as the last fallback inside a var(), never as the whole value.
    for (const hex of ['#3fb950', '#d29922', '#db6d28', '#f85149']) {
      expect(css).not.toMatch(new RegExp(`color:\\s*${hex}`, 'i'));
    }
  });

  it('keeps the brand badges deliberately fixed', () => {
    expect(css).toMatch(/\.tab-badge--claude\s*\{[^}]*#cc785c/);
    expect(css).toMatch(/\.tab-badge--bob\s*\{[^}]*#1f70c1/);
  });

  it('draws separators and shadows with the widget tokens', () => {
    expect(css).not.toMatch(/border-bottom:[^;]*rgba\(128, 128, 128, 0\.14\)\s*;/);
    expect(css).toMatch(/border-bottom: 1px solid var\(--vscode-widget-border/);
    // Every shadow goes through the token; the black is only its last-resort fallback.
    const shadows = css.match(/box-shadow:[^;]+;/g) ?? [];
    expect(shadows.length).toBeGreaterThan(0);
    shadows.forEach(rule => expect(rule).toContain('var(--vscode-widget-shadow'));
  });

  it('declares .activity-item and .activity-summary once each', () => {
    // Both were declared twice — a redesign appended instead of edited — which is how you end up
    // debugging a rule that never applied.
    expect(css.match(/^\.activity-item\s*\{/gm)?.length).toBe(1);
    expect(css.match(/^\.activity-summary\s*\{/gm)?.length).toBe(1);
  });
});

// The default messaging channel is `stub`, which writes the decision card to
// `<stateDir>/notifications/`. The panel used to say "awaiting your decision on Telegram" whatever
// the channel was, sending a first-time user — whom the README points at `stub` — to check nothing.
describe('webview: an awaiting card names where it went', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'main.js'), 'utf8');
  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'SessionSitterViewProvider.ts'), 'utf8');
  const extension = fs.readFileSync(
    path.join(__dirname, '..', 'extension.ts'), 'utf8');

  it('says Telegram only when the channel is telegram', () => {
    expect(main).toMatch(/messagingChannel === 'telegram'/);
    expect(main).toContain('notifications/');
  });

  it('gets the channel from the host over the existing activity push', () => {
    expect(main).toContain('message.channel');
    expect(main).toContain('message.notificationsDir');
    expect(provider).toContain('channel: this._messagingChannel');
    expect(provider).toContain('notificationsDir: this._notificationsDir');
  });

  it('is told the channel the supervisor config actually resolved', () => {
    expect(extension).toContain('provider.setMessagingChannel(supervisorConfig.messagingChannel)');
  });
});

// The list holds Claude, Bob, Codex and Chat rows, so "Claude Sessions" was the wrong accessible
// name for it.
describe('webview: the session list is named for what it holds', () => {
  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'SessionSitterViewProvider.ts'), 'utf8');

  it('does not call the list Claude-only', () => {
    expect(provider).toContain('aria-label="Agent sessions"');
    expect(provider).not.toContain('aria-label="Claude Sessions"');
  });
});
