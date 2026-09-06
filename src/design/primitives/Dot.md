# `<Dot>`

## Purpose

Pulsing status indicator with colored halo. Drop-in for "this thing is alive" UI affordances (sync state, mining live, alerts).

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `color` | `"green" \| "red" \| "amber" \| "gray"` | `"green"` | Maps to accent/danger/warn/dim |
| `size` | `number` | `6` | px square |

`color="gray"` disables both the pulse and the halo.

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Status dot pulse** (structural) — opacity 0.25↔1 + scale 0.75↔1.25 over `motion.pulse.duration = 1400ms`.
- **Status dot glow halo** (decorative) — `box-shadow: 0 0 size color`; gray dots get no halo.

## When to use / when NOT to use

**Use** for status indicators in titlebar, sidebar, mining hero, alert banners.

**Don't use** for decorative bullet glyphs — use `•` or `◇` directly.

## Related

- `<TitleBar>` uses `<Dot>` for the sync chip.
- `<BlinkCursor>` for a step-end blink instead of an eased pulse.
- See `BEHAVIORS.md` "Status dot pulse" + "Status dot glow halo".
