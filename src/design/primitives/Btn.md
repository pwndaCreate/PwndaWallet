# `<Btn>`

## Purpose

Unified scramble-on-hover button. The standard interactive primitive — replaces the old `ScrambleBtn` + `PixelScrambleBtn` split.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `"primary" \| "ghost" \| "accent" \| "danger"` | `"ghost"` | Visual treatment |
| `size` | `"sm" \| "md" \| "lg"` | `"md"` | Padding + font size |
| `full` | `boolean` | `false` | Width 100% |
| `caret` | `boolean` | `false` | Render `►` glyph before label |
| `disabled` | `boolean` | `false` | Cursor not-allowed, opacity = `--disabled-opacity`, no scramble |
| `onClick` | `() => void` | — | |
| `type` | `"button" \| "submit" \| "reset"` | `"button"` | |
| `title` | `string` | — | tooltip |

### Variant guide

- **primary** — confirmations, primary CTAs. White fill, dark text.
- **ghost** — default, dismissive actions. Transparent + border.
- **accent** — mining start, brand actions. `--accent-soft` fill.
- **danger** — destructive (stop mining, forget wallet).

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Scramble-on-hover** (signature) — `useScramble` fires on `onMouseEnter`, resets on `onMouseLeave`. Speed `motion.scramble.hover.speed = 38`.
- **Hover scramble cancel-on-leave** (signature) — `reset()` immediately restores original text.
- **Hover state transitions** (structural) — bg + border swap on `--motion-hover-duration`.
- **Disabled opacity** (structural) — `--disabled-opacity = 0.4`, disabled buttons do NOT scramble.

## When to use / when NOT to use

**Use** for any clickable action — sends, mining start/stop, confirmations, cancels.

**Don't use** for:
- Navigation chips → use `.chain-chip` (legacy) or future `<Chip>`
- Tile/quick filter actions → use `.qbtn` (legacy utility)
- Icon-only controls → use `.qbtn` with single glyph

## Related

- `<TitleBar>` uses 2 bespoke icon buttons (min/close) that don't go through `<Btn>` — too small.
- `Buttons.tsx` wrappers (`BtnPrimary`, `BtnGhost`) shorthand this primitive.
- See `BEHAVIORS.md` "Scramble-on-hover" + "Hover scramble cancel-on-leave".
