# `<Px>`

## Purpose

Inline text helper for pixel-font runs. Sibling of `<Mono>` for `Press Start 2P` text.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `size` | `number` | `12` | px |
| `color` | `string` | `"var(--white)"` | |
| `spacing` | `number` | `1` | letter-spacing |
| `children` | `ReactNode` | — | |
| `style` | `CSSProperties` | — | |

## Behaviors

None.

## When to use / when NOT to use

**Use** for short pixel-font runs in landscape views (titlebar accents, tab labels).

**Don't use** for body copy — pixel font at small sizes is hard to read.
