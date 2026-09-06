# `<MiniSpark>`

## Purpose

Tiny SVG sparkline. Used in hero rows + asset rows + mining stats.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `values` | `number[]` | — | Required. Returns null on empty. |
| `w` | `number` | `80` | Width (px when not fluid) |
| `h` | `number` | `18` | Height |
| `color` | `string` | `"var(--accent)"` | Stroke color |
| `strokeWidth` | `number` | `1.2` | |
| `fluid` | `boolean` | `false` | When true, fills parent width via SVG viewBox + `vectorEffect="non-scaling-stroke"` |
| `minRangeFrac` | `number` | — | Floors the vertical domain to `\|midpoint\| * minRangeFrac` and centers the series. Use for value series (e.g. portfolio total) so a small % move renders small instead of filling the height. Omit for unitless trend sparks (hashrate) — auto-scale is correct there. |
| `style` | `CSSProperties` | — | |

## Behaviors

- **Default scale = auto-range (min→max).** The series always fills the full height, so the *shape* is legible but the *amplitude* is not to scale — a 0.1% move and a 50% move look identical. Correct for "is it trending up or down" sparks (hashrate); misleading for value series.
- **`minRangeFrac` opt-in (added 2026-06-17).** Sets a floor on the vertical span as a fraction of the series midpoint, then centers the data. e.g. `0.08` makes the chart represent at least ~8% peak-to-peak, so a sub-2% portfolio move reads as a gentle line, not a cliff. The default path (prop omitted) is byte-identical to before.

## When to use / when NOT to use

**Use** when a row needs a glance-trend over time without taking real estate.

**Don't use** for real charts — `<HashrateChart>` in `src/components/` is the heavyweight visualization.

## Related

- `<HashrateChart>` is the domain widget for mining hashrate (Task-Manager style).
- `<ProgressBar>` for current state, not historic trend.
