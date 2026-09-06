# `<Panel>` (shell)

## Purpose

Composition-layer card used by landscape views. Same visual surface as `<Card>` but takes a `label` + `tag` prop pair (history: was the bracketed `[ LABEL ]` lockup in v1).

Consider `<Card>` first in new code. `<Panel>` is retained for the landscape-shell layout primitives that already use it.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `label` | `string` | — | Header label (tracked uppercase) |
| `tag` | `string` | — | Secondary label after `label`, dimmer |
| `right` | `ReactNode` | — | Right-aligned header element |
| `pad` | `number` | `14` | Body padding |
| `bodyStyle` | `CSSProperties` | — | |
| `style` | `CSSProperties` | — | |

## Behaviors

None beyond a static surface.

## When to use / when NOT to use

**Use** in landscape views (`src/features/landscape/`) that already use it.

**Don't use** in new code — prefer `<Card>`.

## Related

- `<Card>` — modern equivalent.
- `<Box>` — earlier predecessor.
