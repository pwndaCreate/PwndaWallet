# `<Mono>`

## Purpose

Inline text helper for monospace runs with configurable size/color/spacing/case/weight. Used by landscape views to keep call sites tight.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `size` | `number` | `11` | px |
| `color` | `string` | `"var(--text)"` | |
| `spacing` | `number` | `0` | letter-spacing |
| `upper` | `boolean` | `false` | Uppercase |
| `bold` | `boolean` | `false` | weight 600 |
| `children` | `ReactNode` | — | |
| `style` | `CSSProperties` | — | |

## Behaviors

None.

## When to use / when NOT to use

**Use** in landscape views for inline mono runs. Saves boilerplate vs writing the same inline style at every callsite.

**Don't use** for sized headings — use `.type-display` / `.type-hero` utilities instead.
