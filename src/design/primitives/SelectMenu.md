# `<SelectMenu>`

## Purpose

A dropdown whose option list this design system renders, instead of the OS.

Native `<select>` popups are drawn outside the document: small, plain white,
system font, system background. `<option>` styling is substantially ignored
across browsers, so a terminal-aesthetic option list cannot be achieved with
CSS on a native control — it has to be built. Reported 2026-08-29 against the
Mine tab's asset picker: *"the text is small and its just plain white."*

Use it wherever a picker needs the app's own type, accent and per-item hints.
Keep the native `<select>` for long, plain, style-indifferent lists — the OS
control scrolls and searches better than this does.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `T extends string` | — | Selected item's `value` |
| `items` | `SelectMenuItem<T>[]` | — | See below |
| `onChange` | `(v: T) => void` | — | Fires on click or Enter/Space |
| `ariaLabel` | `string` | — | Required; labels trigger and listbox |
| `placeholder` | `string` | `"select"` | Shown when nothing matches `value` |
| `disabled` | `boolean` | `false` | |
| `align` | `"left" \| "right"` | `"left"` | Edge the panel hangs from |
| `minWidth` | `number` | `150` | Trigger width; panel is ≥ 172 |

`SelectMenuItem`: `{ value, label, hint?, glyph?, disabled?, title? }`. `hint`
is right-aligned secondary text (a balance, `2 tx`); `glyph` is a leading mark
(coin icon, status square).

## Behaviors

- **Signature:** none — this is structural chrome, not a signature behavior.
- Caret rotates 180° on open (120 ms), trigger takes accent border + tint.
- Selected item keeps a 2px accent left border; the keyboard-active item takes
  an accent-soft background. Hover sets active, so mouse and keyboard agree.
- Panel is the only place in this system with a `box-shadow`. The rule is
  otherwise shadow-free; a floating layer is where depth carries meaning.

## Accessibility

`aria-haspopup="listbox"` + `aria-expanded` on the trigger; `role="listbox"`
with `role="option"` and `aria-selected` children. Escape closes and returns
focus to the trigger, Arrow keys move, Home/End jump, Enter/Space commits.
Outside-click and Escape listeners are bound **only while open**.

Disabled items are skipped by arrow navigation and carry `aria-disabled`.

## When to use

- A picker with per-item metadata (balances, leg counts, route hints).
- Any dropdown where the OS popup's appearance would break the surface.

Not for: free-text combo boxes (no filtering here), or lists long enough to
need type-ahead — a native `<select>` is better at both.

## Testing note

Tests that drove the old native control by setting `.value` and dispatching
`change` will not work: there is no `<select>`. Click the trigger, then the
option. This is a real cost of the change and the reason the native control was
kept until its styling actually mattered.

## Related

- [[design-system]] — tokens used here (`--accent`, `--accent-soft`,
  `--accent-mid`, `--border-hi`, `--surface`, `--text-dim`)
- `Btn` — the trigger borrows its sizing conventions
