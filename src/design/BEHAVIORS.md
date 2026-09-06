# PwndaWallet — Behavior Preservation Contract

The signature feel of PwndaWallet lives in interactions, not just static visuals. This file is the authoritative spec for every motion, animation, and interactive behavior the design system carries.

**Read this before redesigning anything.** Tier-1 (signature) behaviors are load-bearing brand — dropping them changes what the product is.

Every primitive's co-located `.md` cross-links the rows in this table that apply to it.

---

## Tiering

- **signature** — must replicate exactly. Brand-load-bearing.
- **structural** — replaceable with an equivalent that conveys the same feedback (a pulse → a fade is fine; *no* feedback is not).
- **decorative** — safe to drop, modify, or experiment with freely.

---

## Inventory

| Behavior | Tier | Owner | Tokens | Selective application |
|---|---|---|---|---|
| Scramble decode-on-mount | signature | `<ST>` / `useLoadScramble` | `motion.scramble.mount.speed = 26`, lockRate = `iter / 1.5` | Titles, hero numbers, section eyebrow labels, mining status line. **Asset list rows do NOT scramble** — noise at scale. |
| Scramble-on-hover | signature | `<Btn>` / `useScramble` | `motion.scramble.hover.speed = 38`, lockRate `iter / 1.6` | Fires on `onMouseEnter`, resets on `onMouseLeave`. Disabled buttons do NOT scramble. |
| Per-row scramble stagger | signature | `<ST>` consumers in lists | `motion.scramble.stagger = 55ms` | `delay = base + idx * 55` for lists. Tune `speed` per content kind: short labels=22, numerics=20, long strings (addresses, URLs)=16–18. |
| Chromatic-split wordmark | signature | `<PwndaWordmark>` | hard-coded RGB shadows, `glow = size * 0.32`, `spacing = size * 0.18` | Sized down for 11px titlebar variant, up to 32px on login splash. Scanline overlay scales with size (`scanStep = max(2, size/7)`). |
| CRT scanlines | signature | `.scanlines` + `--scan-opacity` | `--scan-opacity` (default 0.5; live control exists only in the design catalog — the Settings tweaks panel was removed 2026-04-28) | Applied to `.window-shell::after` (covers entire app). `.scanlines` utility class applies to any container. Uses `mix-blend-mode: multiply`. |
| Page vignette | signature | `.vignette` | none | Radial-gradient overlay, transparent center → black edges. Subtle focal cue. |
| Status dot pulse | structural | `<Dot color="green"\|"red"\|"amber">` | `motion.pulse.duration = 1400ms` | Opacity 0.25↔1 + scale 0.75↔1.25 ease-in-out infinite. `color="gray"` disables pulse. |
| Mining-status pulse | structural | `<Dot color="red">` on mining hero | `motion.miningPulse.duration = 1200ms` | Slightly faster than the standard pulse (1200ms vs 1400ms). |
| Login cursor blink | signature | `<BlinkCursor>` | `motion.blink.duration = 1000ms` | Step-end timing (hard on/off, not eased). Used in login screen prompt and landscape breadcrumb. |
| Fade-in on mount | structural | every `<Card>` / `<Box>` | `motion.fadeIn.duration = 250ms`, `translateY: 6` | `fade-in` class applies `opacity 0→1 + translateY 6→0`. Every primitive container uses this. |
| Login horizontal scanline | signature | `.login-view` | `motion.scan.duration = 6000ms linear infinite` | Single horizontal line scans top-to-bottom over the login splash. Aesthetic only. |
| XMR sync bar stripe | structural | `.syncbar` consumers | `motion.syncbar.duration = 1200ms`, step `40px` | Background-position scroll on a striped gradient. Used during XMR/Zephyr wallet sync. |
| Alert pulse | structural | `.alert-warn`, `.btn-setup-alert` | `motion.alertPulse.duration = 2000ms` | Opacity 1↔0.7 ease-in-out. Lower-energy than `pulse`. |
| Download progress pulse | structural | `.download-progress-bar.extracting` | `motion.progressPulse.duration = 1500ms` | Indeterminate state during miner binary extraction. Opacity 0.3↔1. |
| Hover state transitions | structural | every interactive primitive | `motion.hover.duration = 120ms ease` | bg + border + color swap. Standard `all .12s ease` everywhere. |
| Hover scramble cancel-on-leave | signature | `<Btn>` | n/a | `onMouseLeave` immediately restores the original text. Prevents stuck-scrambled labels. |
| Glow text-shadow | decorative | `<Glow>`, hero numbers | hard-coded `0 0 18px rgba(242,242,242,0.18)` for hero; `0 0 5px / 0 0 10px` for `<Glow>` | White halo around large numbers + branded text. |
| Status dot glow halo | decorative | `<Dot>` (non-gray) | derived `box-shadow: 0 0 size color` | Soft colored halo matches the dot color. Gray dots get no halo. |
| Progress bar lit-cell glow | decorative | `<ProgressBar>` filled cells | hard-coded `box-shadow: 0 0 4px color` | Each lit cell gets a 4px halo in the bar's accent color. |
| Focus-visible ring | structural | all buttons + links + `.field` | `--border-hi` | 1px solid outline, 2px offset. Universal a11y ring. Keyboard-only — does not appear on mouse focus. |
| Disabled opacity | structural | every interactive primitive | `--disabled-opacity = 0.4` | Plus `cursor: not-allowed`. Disabled buttons also do not scramble or transition. |

---

## Selective application rules

These tell you *where* signature behaviors should fire — applying them everywhere is noise:

- `<ST>` is for **titles, hero numbers, section eyebrow labels, mining status line**. NOT for asset rows, transaction rows, or any high-frequency list.
- `<Btn>` hover-scramble is intrinsic — every `<Btn>` does it. To disable, set the button disabled.
- Active-coin / tab swaps are **instant** — no animation, scramble would be too much.
- CRT scanlines are tunable via the `--scan-opacity` token; the only live slider is the design catalog's TokenInspector (`?design=1` / `npm run dev:catalog`). The in-app Settings → Tweaks panel was removed 2026-04-28 — do not document it as a user control. (Corrected 2026-08-28.)
- Per-row scramble stagger: `delay = base + idx * 55ms` with `speed` per content kind:
  - Short labels (Coin, Pool, HW tokens): `speed: 22`
  - Numeric values (balances, hashrate): `speed: 20`
  - Long strings (addresses, pool URLs): `speed: 16–18`

---

## How to retime everything at once

Every duration in this table maps to a `motion.*` token in `src/design/tokens.ts`. To change a duration project-wide:

1. Edit the token (e.g. `motion.pulse.duration = 700`).
2. Run `npm run gen-tokens` (or `prebuild` does this automatically).
3. The generated `styles/keyframes.css` and `styles/tokens.css` pick up the new value via CSS variables.
4. Every primitive that uses the affected keyframe or `var(--motion-*-duration)` updates without a code edit.

URL overrides (live, no rebuild): `?pulse=700&hover=240&theme=amber` rewrites `:root` for the page load.

---

## How to add a new behavior

1. Add the timing constant to `motion` in `tokens.ts`.
2. Run `npm run gen-tokens` — the generator emits `--motion-<name>-duration` automatically (extend the generator if the format differs).
3. Add a `@keyframes` rule (if needed) using `var(--motion-<name>-duration, <fallback>)`.
4. Add the behavior to the inventory table above with its tier + owner primitive + token reference.
5. Add a demo to `src/design/catalog/behaviors/<Name>Demo.tsx` with a slider for the parameter.
6. Update the owning primitive's `.md` to reference the new behavior row.

---

## Related

- `src/design/tokens.ts` — token source; `motion` block defines every timing.
- `src/design/behaviors.ts` — scramble hooks + motion helpers.
- `src/design/styles/keyframes.css` — generated keyframes (consume motion vars).
- `src/design/catalog/behaviors/` — sliderable demos for every behavior here.
- `PwndaWalletVault/wiki/concepts/design-system.md` — high-level aesthetic principles.
