# Branding

The project's logo: three agents tucked in a cradle, with the red / amber / green supervision
light underneath. It says what the extension does — it sits with your agent sessions, and it
grades what they pause on.

<p align="center">
  <img src="logo-256.png" alt="Session Sitter logo" width="160">
</p>

All of it is original artwork. It borrows no vendor's mark — not Claude's, not Anthropic's, not
VS Code's — and the palette deliberately avoids Claude's orange so the logo never reads as a
derivative of one of the agents the extension supervises.

## Files

| File | Size | Use |
|------|------|-----|
| `logo.svg` | 512×512 | The source. Edit this, then regenerate the PNGs. |
| `logo-1024.png` | 1024×1024 | General use, print, anything that needs headroom. |
| `logo-256.png` | 256×256 | Docs and web. Copied to `resources/logo.png` as the marketplace icon. |
| `wordmark-light.svg` / `.png` | 1000×300 | Logo + name, dark text on transparent. The README header on a light theme. |
| `wordmark-dark.svg` / `.png` | 1000×300 | Same, light text on a dark ground. The README header on a dark theme. |
| `lockup-light.svg` / `.png` | 1440×380 | Logo + name + tagline. Slides, blog posts, release notes. |
| `lockup-dark.svg` / `.png` | 1440×380 | Same, on an ink ground. |
| `social-preview.svg` / `.png` | 1280×640 | The GitHub social preview (Settings → General → Social preview). |

`resources/logo.png` is a copy, not a symlink, because `docs/` is listed in `.vscodeignore` —
anything the packaged `.vsix` needs has to live outside `docs/`. If you change the logo, change
both.

> **The lockup and social-preview PNGs are one regeneration behind their new SVG sources.** Those
> three PNGs were hand-composed with no source file, which made them un-editable; the SVGs now exist
> and carry the current tagline, but regenerating the PNGs needs `inkscape`, which was not available
> where the sources were written. Anyone with `inkscape` should run `regen.sh` and commit the three
> PNGs it rewrites. Until then the PNGs still read *"a babysitter for your AI coding sessions"* and
> *"see every agent session · supervise what they pause on"*, which is the pre-0.9 positioning.

`resources/icon.svg` is a different thing and stays as it is: the monochrome activity-bar glyph.
It is drawn with `currentColor` so VS Code can tint it to match the user's theme, which a
full-colour logo cannot do.

## Palette

| Token | Hex | Use |
|-------|-----|-----|
| ink | `#141A2E` | Badge ground, dark text. Badge is a gradient `#242F52` → `#0F1424`. |
| paper | `#F6F4EF` | Agents, cradle rail, rocker, light text. |
| mint | `#37DCA6` | The cradle. The accent colour everywhere else. |
| amber | `#F7B93E` | The middle light. |
| coral | `#F4595E` | The left light. |

The three light colours are the same three the supervisor classifies into — see
[SUPERVISION.md](../SUPERVISION.md).

## Regenerating the PNGs

The SVGs are the source of truth. After editing one:

```bash
bash docs/branding/regen.sh
```

Needs `inkscape` on PATH. It re-exports **every** PNG in this folder — logo, wordmarks, lockups and
the social preview — and refreshes `resources/logo.png`. Nothing here is composed by hand any more,
so there is no asset that cannot be edited and regenerated.

The explainer diagrams in [`../diagrams/`](../diagrams/) are SVG only and are not part of this
script: a diagram inside a document needs no PNG.
