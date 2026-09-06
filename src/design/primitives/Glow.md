# `<Glow>`

## Purpose

White text-shadow halo wrapper. Used for hero numbers and brand text.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `children` | `ReactNode` | — | |
| `style` | `CSSProperties` | — | |

## Behaviors

- **Glow text-shadow** (decorative) — hard-coded `0 0 5px rgba(242,242,242,0.4), 0 0 10px rgba(242,242,242,0.2)`.

## When to use / when NOT to use

**Use** for branded text accents — sparingly. Hero numbers prefer the `.hero-num` utility class (`0 0 18px rgba(242,242,242,0.18)`) because it's heavier.

**Don't use** on body text — reads as noise.

## Related

- `.hero-num` utility class for big USD readouts.
