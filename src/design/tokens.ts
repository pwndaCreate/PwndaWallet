/**
 * src/design/tokens.ts
 *
 * SINGLE SOURCE OF TRUTH for every design token. CSS variables, JSON
 * exports, and TypeScript types are all generated from this file by
 * `scripts/generate-tokens-css.mjs` (run via `prebuild` or
 * `npm run gen-tokens`).
 *
 * DO NOT edit the generated files (`styles/tokens.css`, `tokens.json`,
 * `tokens.d.ts`, `styles/keyframes.css`) directly — change this file
 * and regenerate.
 *
 * Categories:
 *   bg        — base + surface backgrounds (pure black + tints)
 *   border    — three weights (soft / default / hi)
 *   text      — default / muted / dim / white
 *   accent    — terminal green + soft/mid/glow variants
 *   semantic  — success / danger / warn (+ dim variants)
 *   crt       — scanline opacity (user-tunable via Settings slider)
 *   type      — scale / tracking / leading / family
 *   space     — 4px → 32px ladder
 *   radius    — all zero (terminal aesthetic)
 *   motion    — animation timings (durations, easings, scramble speeds)
 *   ui        — misc UI constants (disabledOpacity)
 *
 * See `src/design/BEHAVIORS.md` for how motion tokens map to behaviors.
 */

export const tokens = {
  bg: {
    base: "#000000",
    "2": "#0a0a0a",
    surface: "#0d0d0d",
    "surface-2": "#111111",
  },
  border: {
    default: "rgba(255,255,255,0.14)",
    hi: "rgba(255,255,255,0.32)",
    soft: "rgba(255,255,255,0.06)",
  },
  text: {
    default: "#e8e8e8",
    muted: "#909090",
    dim: "#555555",
    white: "#f2f2f2",
  },
  accent: {
    base: "#00ff66",
    soft: "rgba(0,255,102,0.10)",
    mid: "rgba(0,255,102,0.25)",
    glow: "rgba(0,255,102,0.06)",
  },
  semantic: {
    success: { base: "#00cc66", dim: "rgba(0,204,102,0.15)" },
    danger: { base: "#ff3b3b", dim: "rgba(255,59,59,0.15)" },
    warn: { base: "#ffaa00", dim: "rgba(255,170,0,0.15)" },
    positive: "#00cc66",
    negative: "#ff3b3b",
  },
  crt: {
    scanOpacity: 0.5,
  },
  type: {
    scale: {
      "2xs": 9,
      xs: 10,
      sm: 11,
      base: 12,
      input: 13,
      lg: 14,
      xl: 24,
      "2xl": 28,
    },
    tracking: {
      tight: 0,
      normal: 0.5,
      wide: 1,
      wider: 1.5,
      widest: 2,
      hero: 4,
    },
    leading: {
      tight: 1.4,
      normal: 1.5,
      relaxed: 1.6,
    },
    family: {
      pixel: "'Press Start 2P', cursive",
      mono: "'JetBrains Mono', 'Share Tech Mono', 'Consolas', monospace",
      sans: "'Share Tech Mono', 'JetBrains Mono', monospace",
    },
  },
  space: {
    1: 4,
    2: 6,
    3: 8,
    4: 10,
    5: 12,
    6: 14,
    7: 16,
    8: 20,
    9: 24,
    10: 32,
  },
  radius: {
    default: 0,
    sm: 0,
    xs: 0,
    window: 0,
  },
  motion: {
    scramble: {
      mount: { speed: 26, lockRate: 1.5 },
      hover: { speed: 38, lockRate: 1.6 },
      stagger: 55,
      speedByKind: { short: 22, numeric: 20, long: 17 },
    },
    pulse: { duration: 1400 },
    blink: { duration: 1000 },
    fadeIn: { duration: 250, translateY: 6 },
    scan: { duration: 6000 },
    syncbar: { duration: 1200, step: 40 },
    alertPulse: { duration: 2000 },
    progressPulse: { duration: 1500 },
    miningPulse: { duration: 1200 },
    loadingPulse: { duration: 1500 },
    hover: { duration: 120, easing: "ease" },
    transition: { fast: 120, medium: 150, slow: 200 },
  },
  ui: {
    disabledOpacity: 0.4,
  },
} as const;

export type DesignTokens = typeof tokens;
