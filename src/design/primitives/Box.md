# `<Box>`

## Purpose

Composition-layer card. Predecessor of `<Card>`; retained for back-compat. Consider `<Card>` first in new code.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `title` | `string` | — | Tracked-uppercase eyebrow |
| `children` | `ReactNode` | — | |
| `style` | `CSSProperties` | — | |

## Behaviors

- **Fade-in on mount** (structural) — `animation: fade-in .2s ease`.

## When to use / when NOT to use

**Use** when migrating an existing `<Box>` call site and the changes are out of scope for swapping to `<Card>`.

**Don't use** in new code — prefer `<Card>`.

## Related

- `<Card>` — modern hot-path primitive.
