# `<ProgressBar>`

## Purpose

Terminal-style segmented progress bar — discrete cells, lit ones glow.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `percent` | `number` | `0` | 0–100 (clamped) |
| `segments` | `number` | `28` | Cell count |
| `color` | `string` | `"var(--accent)"` | Fill color |
| `height` | `number` | `6` | px |
| `style` | `CSSProperties` | — | |

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Progress bar lit-cell glow** (decorative) — each filled cell gets `box-shadow: 0 0 4px color`.

## When to use / when NOT to use

**Use** for determinate progress (XMR sync, miner download, multi-step onboarding).

**Don't use** for indeterminate states — use `.download-progress-bar.extracting` (legacy) or a future `<IndeterminateProgress>`.

## Related

- `BEHAVIORS.md` "Progress bar lit-cell glow"
- `.syncbar` (legacy.css) for indeterminate stripe scroll.
