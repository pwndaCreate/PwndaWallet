# `<PwndaWordmark>`

## Purpose

The brand wordmark — Press Start 2P "PWNDA" with chromatic-split red/cyan shadow + CRT scanline overlay.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `size` | `number` | `14` | px font size; spacing/glow/scan density scale proportionally |
| `scan` | `boolean` | `true` | Overlay the scanline texture |
| `style` | `CSSProperties` | — | |

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Chromatic-split wordmark** (signature) — 1px red + -1px cyan `text-shadow` + soft white glow; scanline overlay scales with size.

The chromatic split is brand-defining. Do not "clean it up" — it reads as CRT artifact, which is the point.

## When to use / when NOT to use

**Use** for the brand mark anywhere: titlebar (size 11), landscape sidebar (size 14), login splash (size 32).

**Don't use** for general PWNDA text — only the wordmark gets this treatment.

## Related

- `<TitleBar>` uses it at `size={11} scan={false}`.
- `BEHAVIORS.md` "Chromatic-split wordmark"
