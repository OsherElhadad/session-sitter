import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SESSION_STATUSES } from '../sessionStatus';

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

describe('webview: the six status markers', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('styles every state the status module defines', () => {
    for (const status of SESSION_STATUSES) {
      expect(css).toMatch(new RegExp(`\\.status-${status}\\b`));
    }
  });

  it('names every state in a tooltip, so no marker is unexplained', () => {
    // Four are matched by their own case label; `seen` and `dormant` share the switch's default
    // path, so they are checked by the text they produce.
    for (const status of ['approval', 'question', 'finished', 'working']) {
      expect(main).toContain(`case '${status}':`);
    }
    expect(main).toContain('you have read it');
    expect(main).toContain('No liveness signal');
  });

  it('builds the class name styles.css defines, from the session status', () => {
    expect(main).toContain("'status-indicator status-' + status");
  });

  it('gives the marker an accessible name — the shape is its only content', () => {
    expect(main).toContain("setAttribute('role', 'img')");
    expect(main).toContain("setAttribute('aria-label'");
  });

  it('animates only the working state', () => {
    // Motion reads as "busy, leave it alone", which is the wrong thing to say about a session
    // blocked waiting for you. Only `working` may move.
    const animated = [...css.matchAll(/\.status-([a-z]+)\s*\{([^}]*)\}/g)]
      .filter(m => /animation\s*:\s*[a-z]/.test(m[2]) && !/animation\s*:\s*none/.test(m[2]))
      .map(m => m[1]);
    expect(animated).toEqual(['working']);
  });

  // The spinner used to stop under `prefers-reduced-motion: reduce`, and that is how it came to be
  // reported as broken. Windows exposes one switch here — Settings > Accessibility > Visual effects
  // > Animation effects — and turning it off makes Chromium report `reduce` for every page it
  // renders, the VS Code webview included. On a machine with that switch off the marker was a
  // complete, static green circle: the rule filled in the ring's missing top segment as well as
  // stopping the rotation, so the one state that is supposed to move looked like a state that never
  // does, with nothing on screen to say why.
  //
  // Turning is not decoration here — it is the whole signal. `working` is the only state in the set
  // that animates, and a static ring carries no information that the other five shapes do not
  // already carry better. So the carve-out is gone and the ring always turns.
  it('keeps the working spinner turning even under prefers-reduced-motion', () => {
    const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const reduced = normalized.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.status-working\s*\{([^}]*)\}/,
    );
    // Either there is no reduced-motion rule for the marker at all, or there is one that does not
    // stop it. Both are fine; stopping it is not.
    if (reduced) { expect(reduced[1]).not.toMatch(/animation\s*:\s*none/); }
  });

  it('separates seen from dormant by shape, not only by opacity', () => {
    // Both are quiet states, but they mean different things — "finished, you read it" versus
    // "nothing is happening, or we cannot tell". Two dim dots would rebuild the ambiguity the
    // six-state set exists to remove, so `dormant` must be an outline.
    const dormant = css.slice(css.indexOf('.status-dormant'));
    expect(dormant.slice(0, dormant.indexOf('}'))).toMatch(/border\s*:/);
  });
});

// ── The spinner has to survive being rebuilt ─────────────────────────────────
//
// `renderTabs()` clears the strip and recreates every row on every push, and a brand-new element
// starts its CSS animation at 0deg. The rows are pushed whenever `sessionsFingerprint` moves, which
// during a streaming session means every 250ms watcher debounce — Claude writes the transcript far
// faster than that. So the one state that animates is also the one rebuilt several times a second,
// and the ring was snapping back to 0 before it had turned a quarter. It reads as a ring that
// twitches in place rather than one that turns.
//
// The fix anchors the animation's phase to the wall clock with a negative `animation-delay`, so a
// fresh element picks up where the one it replaced left off. That only works while the delay and the
// CSS duration agree about the period, which is what these tests pin.
describe('webview: the working spinner is phase-anchored to the clock', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  /** The declared period of `.status-working`'s animation, in ms. */
  function cssSpinPeriodMs(): number {
    const block = css.slice(css.indexOf('.status-working'));
    const decl = block.slice(0, block.indexOf('}'));
    const match = /animation\s*:\s*spin\s+([\d.]+)(m?s)/.exec(decl);
    if (!match) { throw new Error('.status-working declares no spin animation'); }
    return match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * 1000;
  }

  it('sets a negative animation-delay on the working marker', () => {
    const fn = main.slice(main.indexOf('function buildStatusIndicator'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    // Negative, because that is what starts an animation mid-cycle rather than delaying it.
    expect(body).toMatch(/animationDelay\s*=\s*['"`]-/);
  });

  it('divides by the same period the stylesheet declares', () => {
    const declared = /SPIN_PERIOD_MS\s*=\s*(\d+)/.exec(main);
    expect(declared, 'main.js must name the spin period as SPIN_PERIOD_MS').not.toBeNull();
    // A mismatch is invisible in review and shows up only as a spinner that jumps on every push.
    expect(Number(declared![1])).toBe(cssSpinPeriodMs());
  });

  it('anchors only the state that animates', () => {
    // Every other marker is static by design — `approval` especially, where motion would say
    // "busy, leave it alone" about the one row that is waiting on you.
    const fn = main.slice(main.indexOf('function buildStatusIndicator'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/status\s*===\s*'working'/);
  });
});

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

// Accessibility of the panel chrome. No DOM here, so these assert the contract in the three files
// that have to agree — which is also where each of these bugs lived: a rule with no attribute, an
// attribute with no rule, a label that only ever existed as a tooltip.
describe('webview: keyboard and screen-reader access', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const menu = fs.readFileSync(path.join(dir, 'toolbarMenu.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'SessionSitterViewProvider.ts'), 'utf8');

  it('holds both infinite animations still when the OS asks for less motion', () => {
    // One per row, so a full list is twenty of them at once.
    const query = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
    expect(query).not.toBeNull();
    expect(query?.[0]).toContain('.status-waiting');
    expect(query?.[0]).toContain('.status-active');
    expect(query?.[0]).toContain('animation: none');
  });

  it('keeps the selected row and the status dots visible in forced colours', () => {
    expect(css).toMatch(/@media \(forced-colors: active\)/);
  });

  it('names every status the dot can be in, idle included', () => {
    expect(main).toContain("statusEl.setAttribute('aria-label', statusLabel)");
    expect(main).toContain("'Idle'");
  });

  it('reveals the close button when the focus lands on it directly', () => {
    expect(css).toMatch(/\.tab-close:focus-visible\s*\{[^}]*opacity: 1/);
  });

  it('gives both toolbar menus the same popup semantics', () => {
    const buttons = provider.match(/<button id="(menu|sort)-btn"[\s\S]*?>/g) ?? [];
    expect(buttons).toHaveLength(2);
    buttons.forEach(button => {
      expect(button).toContain('aria-haspopup="menu"');
      expect(button).toContain('aria-expanded="false"');
      expect(button).toContain('aria-label=');
    });
  });

  it('labels the new-session buttons, not just their tooltips', () => {
    expect(provider).toContain('aria-label="New Claude session"');
    expect(provider).toContain('aria-label="New Bob session"');
  });

  it('shares one menu-keyboard implementation between the two dropdowns', () => {
    expect(menu).toContain('function wireMenuKeys');
    expect(menu).toContain('wireMenuKeys: wireMenuKeys');
    // Escape has to put focus back on the button, or dismissing a menu drops the keyboard user at
    // the top of the document.
    expect(menu).toMatch(/Escape[\s\S]{0,200}trigger\.focus\(\)/);
    expect(main).toContain('window.SessionSitterMenu.wireMenuKeys(menu, sortBtn, closeSortMenu)');
  });

  it('makes the about box a real modal', () => {
    expect(provider).toContain('role="dialog"');
    expect(provider).toContain('aria-modal="true"');
    expect(provider).toContain('aria-labelledby="about-title"');
    // Focus moves in, is trapped on the single control, and goes back where it came from.
    // Opened from the ☰ menu, the element that had focus is a menu item about to be removed —
    // restoring focus to it would put it on a detached node.
    expect(menu).toContain('aboutOpener = menuEl ? menuBtn : document.activeElement');
    expect(menu).toContain('aboutOpener.focus()');
    expect(menu).toMatch(/'Tab'[\s\S]{0,160}aboutClose\.focus\(\)/);
  });

  it('announces a supervision decision instead of letting it appear silently', () => {
    expect(provider).toContain('id="activity-panel" aria-live="polite"');
    // …but only when it actually changed: the host re-pushes the whole feed on every poll, and a
    // live region re-reads everything it rebuilds.
    expect(main).toContain('renderedActivityKey');
  });

  it('keeps muted text above the barely-visible range', () => {
    // Every one of these stacked opacity on an already-muted colour.
    for (const selector of ['.tab-time', '.preview-path', '.preview-time', '.about-built']) {
      const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';
      const opacity = Number(rule.match(/opacity:\s*([\d.]+)/)?.[1] ?? '1');
      expect(opacity, selector).toBeGreaterThanOrEqual(0.75);
    }
    expect(css).toMatch(/\.activity-timeago[^}]*opacity: 0\.8/);
  });
});

// Layout: a session row used to stack title, source badge, machine pill, workspace pill and
// timestamp on five separate lines, and the two new-session buttons used to split every remaining
// pixel of the toolbar between them.
describe('webview: the row and the toolbar fit a narrow sidebar', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('puts the badges and the timestamp on one wrapping line', () => {
    expect(main).toContain("metaEl.className = 'tab-meta'");
    // The timestamp joins the line rather than starting a new one.
    expect(main).toMatch(/metaEl\.appendChild\(timeEl\)/);
    const rule = css.match(/\.tab-meta\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('flex-wrap: wrap');
  });

  it('keeps the new-session buttons a fixed width', () => {
    const rule = css.match(/#new-session-btn,\s*\n#new-bob-session-btn\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('flex: 0 0 auto');
    expect(rule).toMatch(/width: \d+px/);
    expect(rule).not.toContain('flex: 1 1 auto');
  });
});
