# Diagrams

Two hand-authored SVGs. Everything else in the docs that used to be ASCII art is now a mermaid
block in the document that needs it, because GitHub renders mermaid natively and a diagram that
lives next to its prose does not go stale as quietly as a picture does.

| File | What it explains | Referenced from |
|---|---|---|
| [`traffic-lights.svg`](traffic-lights.svg) | the four lights, what each one does, and the deny-on-timeout rule | `README.md`, `SUPERVISION.md` |
| [`architecture.svg`](architecture.svg) | one supervision engine under three front ends, and the three things it drives | `ARCHITECTURE.md` |

## Why they carry their own background

A GitHub page renders in the reader's theme, and an SVG referenced with `<img>` gets no theme
information from the page around it — `currentColor` inherits nothing, and the light/dark
`<picture>` trick the wordmark uses would mean maintaining two copies of a diagram that is mostly
text. So each one paints an opaque ink card, exactly as `branding/social-preview.svg` does, and
reads the same in either theme.

The consequence: **do not remove the background rect.** Without it the labels vanish on a dark
page.

## Palette

The frame, the text and the accent come from the project palette in
[`../branding/README.md`](../branding/README.md) — ink `#0F1424`, card `#181F33`, paper `#F6F4EF`,
mint `#37DCA6`, amber `#F7B93E`.

The four **decision** colours are a different set, and deliberately so: they are the four the
activity feed already uses in the panel, so a reader who has seen the extension recognises them —
green `#3fb950`, yellow `#d29922`, orange `#db6d28`, red `#f85149`. The mermaid decision-flow
diagram in [`../SUPERVISION.md`](../SUPERVISION.md) uses the same four.

## Editing

They are plain SVG text, hand-authored, no tool required — open one and read it. Both are laid out
on an explicit pixel grid rather than with nested groups, so moving a box means changing its `x`/`y`
and the coordinates of the one or two lines that point at it.

Keep the `aria-label` on the root `<svg>` in step with the content. It is the only description a
screen reader gets, since the diagram reaches the page as a single image.

There is no `regen.sh` step for these: an SVG in a document needs no PNG — with **one exception**.

`vsce` refuses to package an extension whose `README.md` references an SVG, so the copy of
`traffic-lights` in the repository root README is a PNG. Every document under `docs/` keeps the SVG,
which is sharper and scales. When you edit the SVG, regenerate that one PNG:

```sh
rsvg-convert -w 1760 -f png -o docs/diagrams/traffic-lights.png docs/diagrams/traffic-lights.svg
```

1760 is twice the 880 CSS pixels the README asks for, so it stays crisp on a retina display. The
`alt` text lives in the README and has to be edited there too — it is the only description a reader
on a text-only client gets.

