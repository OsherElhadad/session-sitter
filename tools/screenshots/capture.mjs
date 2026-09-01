#!/usr/bin/env node
/**
 * Screenshot the real Session Sitter panel in a real browser.
 *
 * The panel is a webview built from plain files — src/webview/styles.css, src/webview/main.js,
 * src/webview/toolbarMenu.js — inside an HTML shell that SessionSitterViewProvider.ts generates.
 * That is all a browser needs. So this harness reads those files off disk at run time, lifts the
 * shell straight out of the provider's source, stubs the one API the panel depends on
 * (acquireVsCodeApi), supplies the `--vscode-*` custom properties the workbench would, and drives
 * the panel over its real postMessage protocol. Nothing about the UI is reimplemented here, which
 * is what stops a committed screenshot from drifting away from the shipped panel.
 *
 * It is not VS Code: no extension host, no real sessions, no CSP. Layout, colour, spacing and the
 * panel's own JavaScript are real; anything that depends on the host is not.
 *
 * Playwright is deliberately NOT a dependency of this repo (which has none). It is found in
 * whatever global or npx location already has it, and when it is missing this script says so and
 * exits 0 — so `make check` and CI never depend on a browser.
 *
 * Usage:  node tools/screenshots/capture.mjs [outDir] [--root <repo>]
 *
 * `--root` is which checkout's UI to photograph — its src/webview/ and its provider. It defaults to
 * the repo this script lives in, and pointing it at another worktree is how you get before/after
 * images of a branch that changes the webview:
 *
 *   node tools/screenshots/capture.mjs /tmp/before --root /path/to/main-worktree
 *   node tools/screenshots/capture.mjs /tmp/after  --root /path/to/branch-worktree
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — where a plain `make screenshots` writes its PNGs. */
const SELF_ROOT = resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
/** The checkout whose UI is photographed: its src/webview/, its provider, its version. */
const ROOT = rootFlag === -1 ? SELF_ROOT : resolve(args.splice(rootFlag, 2)[1] ?? '.');
const WEBVIEW = join(ROOT, 'src', 'webview');
// Deliberately relative to this checkout, not to --root: pointing the harness at another worktree
// must not write PNGs into it.
const OUT_DIR = resolve(args[0] ?? join(SELF_ROOT, 'docs', 'screenshots'));

const SIDEBAR_WIDTH = 340;
// Tall enough for the whole worklist plus a card or two of the feed, which is what a sidebar
// actually looks like on a laptop screen.
const SIDEBAR_HEIGHT = 980;
const WIDE_WIDTH = 620;
const SCALE = 2;

// ── Finding playwright without depending on it ──────────────────────────────

/** Every place a playwright install might already be, most likely first. */
function candidateRoots() {
  const roots = [join(ROOT, 'node_modules')];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no npm on PATH — keep looking */ }
  // `npx playwright` leaves an install behind in the npx cache; take any of them.
  try {
    const cache = join(process.env.HOME ?? '', '.npm', '_npx');
    for (const entry of execFileSync('ls', [cache], { encoding: 'utf8' }).split('\n')) {
      if (entry) { roots.push(join(cache, entry, 'node_modules')); }
    }
  } catch { /* no npx cache */ }
  return roots;
}

async function loadPlaywright() {
  for (const root of candidateRoots()) {
    try {
      const req = createRequire(join(root, 'noop.js'));
      const entry = req.resolve('playwright');
      const mod = await import(pathToFileURL(entry).href);
      // playwright is CommonJS, so the namespace hands it back under `default`.
      const api = mod.chromium ? mod : mod.default;
      const version = JSON.parse(
        readFileSync(req.resolve('playwright/package.json'), 'utf8')).version;
      return { api, version, from: root };
    } catch { /* not here */ }
  }
  return null;
}

// ── The HTML shell, taken from the provider rather than retyped ─────────────

/**
 * Lift the webview's HTML out of SessionSitterViewProvider.ts.
 *
 * The provider's `_getHtmlForWebview` is private and needs a live `vscode.Webview`, so there is no
 * clean seam to call it from a plain script. Rather than duplicate the shell — a copy would rot the
 * first time the real one gained an element — this reads the provider's own template literal and
 * fills its `${…}` holes in. If the template ever moves or is renamed, extraction fails loudly here
 * instead of silently screenshotting a stale panel.
 */
function providerHtmlTemplate() {
  const src = readFileSync(join(ROOT, 'src', 'SessionSitterViewProvider.ts'), 'utf8');
  const open = src.indexOf('`<!DOCTYPE html>');
  const close = src.indexOf('`', open + 1);
  if (open === -1 || close === -1) {
    throw new Error(
      'Could not find the webview HTML template in src/SessionSitterViewProvider.ts. '
      + 'It used to be the template literal starting `<!DOCTYPE html>` in _getHtmlForWebview(); '
      + 'if it moved, update providerHtmlTemplate() in tools/screenshots/capture.mjs.');
  }
  const template = src.slice(open + 1, close);
  // main.js finds its elements by id. If the provider renames one, the panel still renders — just
  // silently missing that piece — and the screenshot would quietly go wrong instead of failing.
  for (const id of ['tab-strip', 'sort-btn', 'menu-btn', 'session-preview', 'activity-panel',
    'history-panel', 'activity-toggle', 'history-toggle']) {
    if (!template.includes(`id="${id}"`)) {
      throw new Error(`The webview shell no longer renders id="${id}", which main.js looks up. `
        + 'Screenshotting it would silently omit that part of the panel.');
    }
  }
  return template;
}

/** The provider's template, resolved for a file:// page, with the harness pieces spliced in. */
function buildHarnessHtml(themeCss) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const fileUri = name => pathToFileURL(join(WEBVIEW, name)).href;
  const holes = {
    stylesUri: fileUri('styles.css'),
    mainScriptUri: fileUri('main.js'),
    menuScriptUri: fileUri('toolbarMenu.js'),
    'webview.cspSource': '',
    nonce: 'harness',
    BUILD_VERSION: version,
    buildDisplay: 'in the screenshot harness',
  };

  let html = providerHtmlTemplate().replace(/\$\{([^}]+)\}/g, (all, expr) => {
    if (!(expr in holes)) { throw new Error(`Unknown placeholder in the webview shell: ${all}`); }
    return holes[expr];
  });

  // The webview's CSP is about the extension host's asset scheme; a file:// page cannot satisfy it
  // and does not need to. Dropped rather than loosened, so nobody reads a relaxed policy as real.
  html = html.replace(/\n\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '');

  const harnessHead = `
  <style id="harness-theme">
${themeCss}
/* A screenshot must be identical on every run: no transitions, no animation, no blinking caret. */
*, *::before, *::after {
  transition: none !important;
  animation: none !important;
}
html, body { height: 100%; }
/* The panel lives in the secondary sidebar, which paints this behind it. */
body { background-color: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  </style>
  <script src="${pathToFileURL(join(HERE, 'vscodeApiStub.js')).href}"></script>`;

  return html.replace('</head>', `${harnessHead}\n</head>`);
}

// ── Shots ───────────────────────────────────────────────────────────────────

/**
 * Each shot names its viewport, the messages to feed the panel, and what to do once it has
 * rendered. `settle` is a predicate evaluated in the page — waiting for a real settled state
 * rather than for a fixed sleep is what makes two runs comparable.
 */
function shotList(fx, now) {
  const sessions = fx.sessions(now);
  const activity = fx.activity(now);
  // The green and yellow cards — short enough to leave the worklist its room.
  const compact = [activity[1], activity[2]];
  const base = {
    type: 'updateSessions',
    sessions,
    peers: fx.peers,
    sortMode: 'recent',
    sortModes: fx.sortModes,
  };

  return [
    {
      name: 'panel',
      width: SIDEBAR_WIDTH,
      height: SIDEBAR_HEIGHT,
      // The two compact cards, not all four: the feed is capped at 45vh and takes whatever of it
      // its content needs, so a tall card here would push the worklist — the subject of this
      // shot — out of frame. All four lights get their own shot below.
      messages: [base, { type: 'updateActivity', items: compact }],
      settle: `document.querySelectorAll('#tab-strip .tab').length === ${sessions.length}
        && document.querySelectorAll('.activity-item').length === ${compact.length}`,
    },
    {
      name: 'panel-wide',
      width: WIDE_WIDTH,
      height: SIDEBAR_HEIGHT,
      messages: [base, { type: 'updateActivity', items: compact }],
      settle: `document.querySelectorAll('#tab-strip .tab').length === ${sessions.length}
        && document.querySelectorAll('.activity-item').length === ${compact.length}`,
    },
    {
      name: 'panel-needs-you',
      width: SIDEBAR_WIDTH,
      height: SIDEBAR_HEIGHT,
      // 'Needs you first' — the order the panel offers for exactly this situation.
      messages: [
        { ...base, sortMode: 'status', sessions: [...sessions].sort(
          (a, b) => statusRank(a) - statusRank(b)) },
        { type: 'updateActivity', items: [activity[0]] },
      ],
      settle: `document.querySelector('#tab-strip .tab .status-waiting') !== null
        && document.querySelector('.activity-awaiting-badge') !== null`,
    },
    {
      name: 'hover-preview',
      width: SIDEBAR_WIDTH,
      height: SIDEBAR_HEIGHT,
      messages: [base, { type: 'updateActivity', items: activity.slice(0, 2) }],
      settle: `document.querySelectorAll('#tab-strip .tab').length === ${sessions.length}`,
      async act(page) {
        // A real hover: the row's mouseenter starts the 250 ms debounce, the panel asks the host
        // for the preview, and the stub answers over postMessage.
        await page.hover('#tab-strip .tab');
        await page.waitForSelector('#session-preview:not([hidden])');
      },
    },
    {
      name: 'sort-menu',
      width: SIDEBAR_WIDTH,
      height: SIDEBAR_HEIGHT,
      messages: [base, { type: 'updateActivity', items: activity.slice(0, 2) }],
      settle: `document.querySelectorAll('#tab-strip .tab').length === ${sessions.length}`,
      async act(page) {
        await page.click('#sort-btn');
        await page.waitForSelector('.session-sort-item');
      },
    },
    {
      name: 'toolbar-menu',
      width: SIDEBAR_WIDTH,
      height: SIDEBAR_HEIGHT,
      messages: [base, { type: 'updateActivity', items: activity.slice(0, 2) }],
      settle: `document.querySelectorAll('#tab-strip .tab').length === ${sessions.length}`,
      async act(page) {
        await page.click('#menu-btn');
        await page.waitForSelector('.session-context-menu-item');
      },
    },
    {
      name: 'activity',
      width: SIDEBAR_WIDTH,
      // The feed is capped at 45vh, so all four lights fit in one frame only in a very tall
      // window — and that window is mostly empty worklist. So: render tall, then crop to the feed.
      // Cropped, never composited: this is one frame of one real render.
      height: 1800,
      messages: [
        { ...base, sessions: sessions.slice(0, 2) },
        { type: 'updateActivity', items: activity },
      ],
      settle: `document.querySelectorAll('.activity-item').length === ${activity.length}`,
      clipTo: ['#activity-toggle', '#activity-panel'],
    },
  ];
}

/** The union of a shot's `clipTo` elements, or undefined to shoot the whole viewport. */
async function clipFor(page, shot) {
  if (!shot.clipTo) { return undefined; }
  const boxes = [];
  for (const selector of shot.clipTo) {
    boxes.push(await (await page.waitForSelector(selector)).boundingBox());
  }
  const top = Math.min(...boxes.map(b => b.y));
  const bottom = Math.max(...boxes.map(b => b.y + b.height));
  return { x: 0, y: Math.round(top), width: shot.width, height: Math.round(bottom - top) };
}

/** A PNG's real pixel size, off its IHDR — the only honest source for what was actually written. */
function pngSize(file) {
  const head = readFileSync(file).subarray(16, 24);
  return [head.readUInt32BE(0), head.readUInt32BE(4)];
}

const STATUS_RANK = { waiting: 0, active: 1, idle: 2 };
const statusRank = s => STATUS_RANK[s.status] ?? 3;

// ── Capture ─────────────────────────────────────────────────────────────────

async function main() {
  const loaded = await loadPlaywright();
  if (!loaded) {
    console.log('playwright is not installed — skipping screenshots.');
    console.log('Install it once (it is intentionally not a dependency of this repo):');
    console.log('  npm i -g playwright && npx playwright install chromium');
    return;
  }
  const { api: playwright, version, from } = loaded;

  const fx = await import(pathToFileURL(join(HERE, 'fixtures.mjs')).href);
  const { themes, themeCss } = await import(pathToFileURL(join(HERE, 'themes.mjs')).href);

  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (err) {
    console.log(`no chromium browser available (${err.message.split('\n')[0]}) — skipping screenshots.`);
    console.log('  npx playwright install chromium');
    return;
  }

  console.log(`playwright ${version} from ${from}`);
  console.log(`chromium ${browser.version()}`);
  if (ROOT !== SELF_ROOT) { console.log(`photographing the UI in ${ROOT}`); }

  mkdirSync(OUT_DIR, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'session-sitter-shots-'));

  // One frozen clock for every shot, so "6 minutes ago" is the same in all of them.
  const now = Date.now();
  const shots = shotList(fx, now);
  const previews = fx.previews(now);

  const problems = [];
  const results = [];
  const started = Date.now();

  for (const [themeName, theme] of Object.entries(themes)) {
    const page = join(scratch, `harness-${themeName}.html`);
    writeFileSync(page, buildHarnessHtml(themeCss(theme)), 'utf8');

    for (const shot of shots) {
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        deviceScaleFactor: SCALE,
        colorScheme: themeName === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      const tab = await context.newPage();
      tab.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          problems.push(`[${themeName}/${shot.name}] console.${msg.type()}: ${msg.text()}`);
        }
      });
      tab.on('pageerror', err => {
        problems.push(`[${themeName}/${shot.name}] pageerror: ${err.message}`);
      });

      await tab.addInitScript(`window.__ssHarnessPreviews = ${JSON.stringify(previews)};`);
      await tab.goto(pathToFileURL(page).href, { waitUntil: 'load' });
      // The panel posts 'ready' once main.js has wired itself up; until then a message would land
      // before the listener exists.
      await tab.waitForFunction(
        `Array.isArray(window.__ssHarnessSent)
         && window.__ssHarnessSent.some(m => m && m.type === 'ready')`);

      await tab.evaluate(msgs => {
        for (const m of msgs) { window.postMessage(m, '*'); }
      }, shot.messages);
      await tab.waitForFunction(shot.settle);
      if (shot.act) { await shot.act(tab); }

      // Fonts loaded and two frames painted: a settled state, not a guess at one.
      await tab.evaluate(() => document.fonts.ready);
      await tab.evaluate(() => new Promise(r =>
        requestAnimationFrame(() => requestAnimationFrame(r))));

      const file = join(OUT_DIR, `${shot.name}-${themeName}.png`);
      await tab.screenshot({ path: file, clip: await clipFor(tab, shot) });
      const { size } = statSync(file);
      const [w, h] = pngSize(file);
      results.push({
        file: `${shot.name}-${themeName}.png`,
        css: `${w / SCALE}x${h / SCALE}`,
        pixels: `${w}x${h}`,
        kb: (size / 1024).toFixed(1),
      });
      await context.close();
    }
  }

  await browser.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nwrote ${results.length} screenshot(s) to ${OUT_DIR} in ${seconds}s`);
  console.log(`viewport scale: deviceScaleFactor ${SCALE}`);
  for (const r of results) {
    console.log(`  ${r.file.padEnd(26)} ${r.css.padEnd(10)} css → ${r.pixels.padEnd(11)} px  ${r.kb} KB`);
  }
  if (problems.length) {
    console.log(`\n${problems.length} console problem(s) — these are real, report them:`);
    for (const p of problems) { console.log(`  ${p}`); }
  } else {
    console.log('\nno console errors or warnings');
  }
}

await main();
