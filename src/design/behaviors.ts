/**
 * src/design/behaviors.ts
 *
 * Behavior helpers + re-exports. Single home for motion constants
 * referenced by code (CSS reads the same values via var(--motion-*)).
 *
 * See src/design/BEHAVIORS.md for the full behavior inventory and
 * preservation contract.
 */

import { tokens } from "./tokens";

// Re-export scramble hooks from their primitive home so callers can
// `import { useScramble } from "../design/behaviors"` without knowing
// which file they live in.
export { useScramble, useLoadScramble, ST, GLITCH_CHARS } from "./primitives/ST";

/** Scramble speed for the canonical content kinds. Apply via <ST speed={scrambleSpeedFor("numeric")} />. */
export function scrambleSpeedFor(kind: "short" | "numeric" | "long"): number {
  return tokens.motion.scramble.speedByKind[kind];
}

/** Stagger delay for the idx-th row in a scrolling/scrambling list. */
export function staggerDelay(idx: number, base = 0): number {
  return base + idx * tokens.motion.scramble.stagger;
}

/** CSS transition string for hover state changes. */
export const hoverTransition = `all ${tokens.motion.hover.duration}ms ${tokens.motion.hover.easing}`;

/** Useful default speed/delay pairs for common screens. */
export const SCRAMBLE_PRESETS = {
  pageTitle: { speed: tokens.motion.scramble.mount.speed, delay: 0 },
  heroNumber: { speed: 18, delay: 120 },
  sectionEyebrow: { speed: 22, delay: 60 },
  statusLine: { speed: 20, delay: 0 },
} as const;

/** Re-export motion tokens for code-side reference. */
export const motion = tokens.motion;
