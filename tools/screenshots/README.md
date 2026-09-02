# Screenshot harness

Renders the **real** Session Sitter panel in a real browser and writes the PNGs in
`docs/screenshots/`.

```sh
make screenshots            # or: node tools/screenshots/capture.mjs [outDir]
```

`--root` picks which checkout's UI to photograph — its `src/webview/` and its provider — and
defaults to the repo the script lives in. Pointing it at another worktree is how you get before/after
images of a branch that touches the webview:

```sh
node tools/screenshots/capture.mjs /tmp/before --root /path/to/main-worktree
node tools/screenshots/capture.mjs /tmp/after  --root /path/to/branch-worktree
# rendering is byte-deterministic, so `cmp` names exactly which shots the branch changed
```

The output directory is always relative to *this* checkout, never to `--root`, so aiming the harness
at a sibling worktree cannot write PNGs into it.

## Why this works at all

The panel is a webview built from plain files — `src/webview/styles.css`, `src/webview/main.js`,
`src/webview/toolbarMenu.js` — inside an HTML shell that `SessionSitterViewProvider.ts` generates,
talking to the extension host over `postMessage`. A browser can run all of that. So the harness:

- reads the three webview files **off disk at run time**, and lifts the HTML shell out of the
  provider's own source. Nothing about the UI is copied or reimplemented here, which is what stops a
  committed screenshot from drifting away from the shipped panel;
- stubs `acquireVsCodeApi()` (`vscodeApiStub.js`) so `main.js` runs unmodified;
- supplies the `--vscode-*` custom properties the workbench would, for **both** VS Code Dark Modern
  and Light Modern (`themes.mjs`);
- drives the panel over its real protocol — `updateSessions`, `updateHistory`, `updateActivity`,
  `sessionPreview` — with synthetic fixtures (`fixtures.mjs`).

It is **not** VS Code. Layout, colour, spacing and the panel's own JavaScript are real; anything
that depends on the extension host is not. A shot is one frame of one real render — cropped
sometimes, never composited.

## Privacy rule — fixtures stay synthetic

Every value in `fixtures.mjs` is invented: `acme-api`, `checkout-service`, `docs-site`,
`ledger-worker`, and prose written for the screenshot. Nothing is read from, sampled out of, or
derived from `~/.claude/sessions`, `~/.claude/projects`, `~/.claude/history.jsonl` or any other real
session store. These PNGs are committed and shown in the README, so a real project name, path or
message that leaks into a fixture leaks into the README with it. Keep it that way.

## Playwright is not a dependency

This repo has zero runtime dependencies and no browser in its lockfile, and that stays true. The
capture script finds playwright wherever one already exists — the local `node_modules`, the global
install, the `npx` cache — and when it finds none it prints how to get one and exits **0**. So
`make check`, `make guards` and CI never depend on a browser.

To get one:

```sh
npm i -g playwright && npx playwright install chromium
```

## The shots

Each is captured in both themes, at a 340 px sidebar width (`panel-wide` at 620 px), with
`deviceScaleFactor: 2`.

| File | What it shows |
|---|---|
| `panel-{dark,light}.png` | the worklist: six sessions, all four agents, the three status dots, four workspace pill colours, the `(no workspace)` fallback, one peer-machine row |
| `panel-wide-{dark,light}.png` | the same at 620 px, for a widened sidebar |
| `panel-needs-you-{dark,light}.png` | "Needs you first" order, the waiting session leading, and the awaiting-your-decision card |
| `hover-preview-{dark,light}.png` | the hover preview card open over a row |
| `sort-menu-{dark,light}.png` | the ⇅ sort menu, all six orders, the active one checked |
| `toolbar-menu-{dark,light}.png` | the ☰ menu |
| `activity-{dark,light}.png` | the supervision feed with one decision of each traffic light, cropped to the feed |

## The PNGs are committed artifacts

`docs/screenshots/*.png` is checked in — a reader of the README must see the panel without running
anything, and `ci/check-links.mjs` validates that every image a doc references exists. Regenerate
them with `make screenshots` whenever the webview's markup, CSS or fixtures change, and commit the
result.

Rendering is deterministic on purpose — fixed viewport, animations and transitions disabled,
timestamps computed as fixed offsets from the capture clock, and a wait for a real settled state
(the rows and cards actually present, fonts loaded, two frames painted) rather than a sleep. Two
runs on the same machine produce **byte-identical** PNGs, so a diff in `git status` means the UI
changed.

## What the light theme exposes

The activity feed's traffic-light colours are hardcoded GitHub-dark hexes in `styles.css`
(`#3fb950`, `#d29922`, `#db6d28`, `#f85149`), not `--vscode-charts-*`. Against Light Modern's
background that is a real contrast failure, and `activity-light.png` shows it honestly rather than
working around it. See the harness report for the measured ratios.
