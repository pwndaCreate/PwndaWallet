# PwndaWallet — Design Guide

If you're working on visual design (human, Claude Code, or the frontend-design agent), **read this first.**

The full system spec lives in two places:

- **Token + primitive contract** — `src/design/` (this codebase). The live source of truth.
- **Behavior contract** — `src/design/BEHAVIORS.md`. Every signature/structural/decorative interaction.
- **Concept overview** — `PwndaWalletVault/wiki/concepts/design-system.md`. Aesthetic principles, voice, copy.
- **Refactor plan** — `PwndaWalletVault/wiki/synthesis/design-system-modularization.md`. Why the layout is what it is.

---

## The four dev surfaces

| Command | What it runs | When to use |
|---|---|---|
| `npm run dev` | Full Tauri wallet (hot reload) | End-to-end testing; final QA |
| `npm run dev:lite` | Tauri PwndaLite (hot reload) | Lite-specific UX |
| `npm run dev:web` | Full wallet in browser, Tauri shimmed | **Most visual design work.** Browser DevTools, fast iteration, no OS sidecar needed |
| `npm run dev:catalog` | Standalone catalog (browser, no Tauri) | **Primary frontend-design agent surface.** Render every primitive in every state without the rest of the app. |
| `npm run dev:catalog:lite` | Lite-variant catalog (filtered showcases) | Same as `dev:catalog` but only shows lite-applicable primitives + lite-specific shells. |

The catalog is also reachable from inside the running apps via the `?design=1` query param when `import.meta.env.DEV` is true.

---

## Catalog URL quick reference

- Catalog: `http://localhost:1420/`  (with `npm run dev:catalog`)
- Catalog (lite): `http://localhost:1420/`  (with `npm run dev:catalog:lite`)
- Full app in browser: `http://localhost:1420/`  (with `npm run dev:web`)
- Catalog overlay on real app: `http://localhost:1420/?design=1`  (with `npm run dev` or `dev:web`)
- Theme override: append `?theme=amber` (or `green` / `cyan` / `red`)
- Motion override: append `?pulse=700&hover=240`

---

## File layout

```
src/design/
├── tokens.ts                  ← ALL design tokens (colors, type, spacing, motion). SOURCE OF TRUTH.
├── themes.ts                  ← Theme variants (green/amber/cyan/red, dark/light scaffold)
├── env.ts                     ← isTauri(), isWeb(), isLite() — env detection shim
├── behaviors.ts               ← Scramble hooks + motion helpers (re-exports + constants)
├── BEHAVIORS.md               ← Behavior preservation contract (signature/structural/decorative)
├── primitives/
│   ├── <Name>.tsx             ← Component
│   ├── <Name>.module.css      ← Hot-path primitives only (Btn, Card, etc.)
│   ├── <Name>.md              ← Co-located contract (5 sections)
│   └── index.ts               ← Barrel
├── shell/                     ← Composition-layer primitives (TitleBar, BottomNav, Box, Panel)
├── styles/
│   ├── tokens.css             ← GENERATED from tokens.ts (do not hand-edit)
│   ├── reset.css
│   ├── chrome.css
│   ├── keyframes.css          ← GENERATED from tokens.motion (do not hand-edit)
│   ├── utilities.css
│   └── legacy.css             ← Frozen — deprecated, only-touch-when-replacing
└── catalog/
    ├── DesignCatalog.tsx      ← Catalog root (4 sections: Tokens / Primitives / Behaviors / Compositions)
    ├── TokenInspector.tsx     ← Live token + theme + motion override panel
    ├── primitives/<Name>Showcase.tsx
    ├── behaviors/<Name>Demo.tsx
    └── compositions/<View>Composition.tsx  ← Real views wrapped in MockProvider
```

Domain widgets (`HashrateChart`, `PixelCoin`, `CoinIcon`, `DitherCanvas`, `TermBox`) live in `src/components/` — **not** the design layer.

---

## Scaffolding scripts

```bash
# Create a new primitive (Component.tsx + .module.css + .md + Showcase.tsx + barrel wiring)
npm run new-primitive <Name>

# Add a token to tokens.ts and regenerate outputs
npm run new-token <category> <name> <value>
# Example: npm run new-token accent extraGlow "rgba(0,255,102,0.5)"

# Regenerate token outputs (CSS / JSON / .d.ts / keyframes) manually
npm run gen-tokens

# Verify generated token files are in sync with tokens.ts
npm run check-tokens

# Snapshot the entire catalog for before/after PR diffs
npm run snapshot:catalog

# Report which legacy CSS classes are still in use and where
npm run legacy-css-usage
```

---

## Boundary rules (`src/design/` is pure-utility-tier)

The design layer MAY import:

- `src/lib/`, `src/utils/`, `src/types/`
- Type-only imports from `src/wallets/index` or `src/wallets/types` (e.g. `import type { ChainType }`)

The design layer MAY NOT import:

- Anything under `src/features/**`
- `src/store`, `src/crypto`, `src/state/*`, `src/App`
- Wallet adapters (`src/wallets/*-wallet`)

**Narrow exception:** files under `src/design/catalog/compositions/` MAY import real feature views (e.g. `import { DashboardView } from "../../features/wallet/DashboardView"`) — that's the entire purpose of compositions. Boundary check applies the exception scoped to that folder only.

Run `npm run check-boundaries` before declaring design work done.

---

## Behavior preservation

PwndaWallet's signature feel comes from interactions (scramble decode, CRT scan, blink, pulse, chromatic wordmark, hover transitions), not just static visuals. Every behavior is tiered in `src/design/BEHAVIORS.md`:

- **signature** — must be replicated exactly. Dropping the scramble or chromatic wordmark removes the brand.
- **structural** — replaceable with equivalent feedback (a pulse can become a fade, but *some* feedback must be present).
- **decorative** — safe to drop or modify freely.

Every primitive's `.md` includes a Behaviors section listing the motions it owns, their tier, and token references.

---

## When the catalog isn't enough — composing a redesign

For "redesign the dashboard" work:

1. Open `npm run dev:web?design=1`
2. Navigate to Compositions → `DashboardComposition`
3. The composition renders the real `DashboardView` against a `MockProvider`
4. Edit the actual view files in `src/features/wallet/` — composition updates live
5. When happy: `npm run snapshot:catalog`, diff against `main`, commit

The `MockProvider` lives at `src/design/catalog/compositions/MockProvider.tsx` and supplies fake `AppState`, `useVault`, `useMiner`, wallet/balance data.

---

## Tokens — fast reference

The full inventory is in `src/design/tokens.ts`. Key categories:

- `bg.{base, 2, surface, surface-2}` — black + 3 surface tints
- `border.{default, hi, soft}` — three border weights
- `text.{default, muted, dim, white}` — text scale
- `accent.{base, soft, mid, glow}` — terminal green (default `#00ff66`)
- `semantic.{success, danger, warn}` (each has `base` + `dim`)
- `type.scale` — 9px → 28px
- `type.tracking` — 0px → 4px
- `type.family` — pixel / mono / sans
- `space.1` → `space.10` (4px → 32px)
- `motion.{scramble, pulse, blink, fadeIn, scan, syncbar, hover}` — all timings

Themes swap `accent.*` only (for now); `themes.ts` has a `light` scaffold for future use.

---

## Reading order for a new contributor

1. This file (you are here).
2. `src/design/BEHAVIORS.md` — the signature behaviors that must be preserved.
3. `src/design/tokens.ts` — see what's available.
4. Run `npm run dev:catalog` — explore the live surface.
5. `PwndaWalletVault/wiki/synthesis/design-system-modularization.md` — only if the architecture itself confuses you.

---

## Related

- `BOUNDARIES.md` — module boundary contract (this layer is bound by the `design` row).
- `CLAUDE.md` § Wiki Maintenance — wiki edit requirements for design changes.
- `PwndaWalletVault/wiki/concepts/design-system.md` — concept-level overview.
