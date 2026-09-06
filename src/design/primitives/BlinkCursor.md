# `<BlinkCursor>`

## Purpose

Terminal-style `█` cursor that blinks. Used in login splash and landscape breadcrumbs.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `color` | `string` | `"var(--accent)"` | |
| `style` | `CSSProperties` | — | |

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Login cursor blink** (signature) — `step-end` timing (hard on/off) over `motion.blink.duration = 1000ms`. NOT eased.

The step-end timing is load-bearing — an eased blink reads as decorative; step-end reads as a terminal cursor.

## When to use / when NOT to use

**Use** for terminal-cursor affordances. Login prompt, breadcrumb, command-line-evoking inputs.

**Don't use** for general attention-grabbing — use `<Dot>` (pulse) or `Alert pulse` (calmer).

## Related

- `BEHAVIORS.md` "Login cursor blink"
