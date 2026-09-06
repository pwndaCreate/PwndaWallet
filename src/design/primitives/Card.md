# `<Card>`

## Purpose

Quiet container with optional label-strip header. The hot-path container primitive — replaces every `<div className="card">` site and most `<Box>` usage.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `title` | `ReactNode` | — | Tracked uppercase eyebrow strip; omitted means no header |
| `right` | `ReactNode` | — | Right-aligned element in the header strip (e.g. close button) |
| `pad` | `number` | `14` | Body padding (px) |
| `padded` | `boolean` | `true` | Set false to render body flush (e.g. nested table) |
| `style` | `CSSProperties` | — | Outer container override |
| `bodyStyle` | `CSSProperties` | — | Body div override |

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Fade-in on mount** (structural) — `.fade-in` class applies `opacity 0→1 + translateY 6→0` over `--motion-fadein-duration = 250ms`.

No internal motion beyond fade-in. The card is a passive frame.

### ⚠ Layout gotcha — Card is `display:flex; flexDirection:column; minHeight:0`

The outer is a flex column and the body is `flex:1; minHeight:0`. That's correct
inside a *fixed-height* parent (the body fills and scrolls). But if you put Cards
as direct children of a **height-constrained flex column** that is itself
scrollable, the Cards have default `flex-shrink:1` and `minHeight:0`, so when the
content overflows the column **compresses the Cards** and their `flex:1` bodies
spill out and **overlap the next sibling** (this caused the 2026-06-17 Zephyr
"jumbled text" bug in the landscape wallet center column). Fix: make the outer a
plain `overflow:auto` scroll container and put the Cards in an **inner flowing
`div`** (not height-constrained), so the column scrolls instead of compressing
them — see `WalletLandscapeView` center column. (Or give each Card `flexShrink:0`.)

**Same trap applies to `<Panel>`** and any bordered child of a scrollable flex
column. Hit again 2026-06-18 in `SettingsLandscapeView` (both columns were
`display:flex; flexDirection:column; overflow:auto` with `<Panel>` children — the
panels compressed and their text spilled across each other once Derivation was
expanded). Fixed the same way: outer `overflow:auto` scroll container + inner
flowing `div`. When you build a scrollable landscape column of cards/panels, reach
for the inner-wrapper pattern by default.

## When to use / when NOT to use

**Use** as the default container for dashboard sections, settings groups, modal bodies, etc.

**Don't use** for:
- Single-row chrome (titlebar, bottom nav) — those have dedicated shell components.
- Hero focal frames where you need the bracketed `[ LABEL ]` look (rare in v2) — use `<Panel>`.

## Related

- `<Box>` — composition-layer equivalent; prefer `<Card>` in new code.
- `<Panel>` — bracketed-label variant for landscape views.
- See `BEHAVIORS.md` "Fade-in on mount".
