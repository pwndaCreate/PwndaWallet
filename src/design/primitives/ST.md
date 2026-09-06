# `<ST>` + `useScramble` + `useLoadScramble`

## Purpose

The scramble-decode primitive. Wraps any string to render it as random `GLITCH_CHARS` on mount, then decodes character-by-character until the real text appears.

This is the **signature behavior** of PwndaWallet — applied selectively, never to every string.

## Variants / props

`<ST>`:

| Prop | Type | Default | Notes |
|---|---|---|---|
| `children` | `ReactNode` | — | String content (stringified internally) |
| `delay` | `number` | `0` | ms before decode starts; use for staggered list rows |
| `speed` | `number` | `motion.scramble.mount.speed = 26` | ms per frame |
| `color` | `string` | — | Optional text color |
| `block` | `boolean` | `false` | Wraps in `display: block` |
| `style` | `CSSProperties` | — | Outer span override |

`useScramble(text)` — manual controller. Returns `{ display, active, scramble, reset }`. Used by `<Btn>` for hover.

`useLoadScramble(text, { delay, speed })` — fires on mount + every text change.

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Scramble decode-on-mount** (signature) — `motion.scramble.mount.speed = 26`, lockRate `iter / 1.5`.
- **Scramble-on-hover** (signature, via `useScramble`) — `motion.scramble.hover.speed = 38`, lockRate `iter / 1.6`.
- **Per-row scramble stagger** (signature) — `delay = base + idx * 55ms`.

## Selective application rules

`<ST>` is for:

- Page titles, section eyebrow labels
- Hero numbers (balance, hashrate)
- Status lines (`> MINING ACTIVE`)
- Address rows (occasional)

NOT for:

- Asset list rows — noise at scale
- Transaction rows
- Any high-frequency list

Speed by content kind:

| Content | `speed` |
|---|---|
| Short labels (Coin, Pool) | 22 |
| Numeric values | 20 |
| Long strings (addresses, URLs) | 16–18 |

Use the `scrambleSpeedFor(kind)` helper in `src/design/behaviors.ts`.

## When to use / when NOT to use

**Use** anywhere the brand benefits from the decode-in feel. **Don't use** for high-frequency content where the motion becomes noise.

## Related

- `behaviors.ts` exports `scrambleSpeedFor`, `staggerDelay`, `SCRAMBLE_PRESETS`.
- `<Btn>` uses `useScramble` internally.
- See `BEHAVIORS.md` "Scramble decode-on-mount" and surrounding rows.
