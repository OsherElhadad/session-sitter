# Review artifacts

Images referenced from pull-request reviews on this repository. Not part of the product, and not
merged into `main` — this branch exists only so a review can show a real render rather than describe
one.

Every image here was produced by `tools/screenshots/capture.mjs`, which renders the repository's
actual `src/webview/` files in headless chromium. All fixture data is synthetic; no real session,
project name or path appears in any image.

| File | What it shows |
|---|---|
| `webview/row-height-before.png` | the worklist before the layout pass — a session row is four to five lines |
| `webview/row-height-after.png` | the same fixtures after — two lines, median row height 90px → 56px |
| `contrast/labels-before.png` | the activity feed on a light theme with the traffic-light labels painted in `charts-*` colours (yellow 2.70:1, orange 2.77:1 — both below 4.5:1) |
| `contrast/labels-after.png` | the same feed with the labels on `editor-foreground` (10.55:1) and the colour moved to the dot and border |
| `panel/panel-dark.png`, `panel/panel-light.png` | the panel as shipped, both themes |
