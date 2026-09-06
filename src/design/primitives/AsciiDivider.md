# `<AsciiDivider>`

## Purpose

Section separator — two 1px hairlines flanking an optional centered tracked uppercase label.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `label` | `ReactNode` | — | Centered label; omitted means plain hairline-only divider |
| `style` | `CSSProperties` | — | |

## Behaviors

None.

## When to use / when NOT to use

**Use** to break up long stacks of cards or to denote a content shift inside a single card.

**Don't use** for purely decorative spacing — use `gap` on flex containers.

## Related

- `BEHAVIORS.md` — no rows apply directly; this is purely visual.
