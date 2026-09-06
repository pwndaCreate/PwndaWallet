/**
 * <PwndaWordmark> — chromatic-split brand wordmark.
 *
 * SIGNATURE behavior. See src/design/BEHAVIORS.md — "Chromatic-split wordmark".
 * Letter-spacing, glow blur, and scanline density scale with `size`.
 */

import type { CSSProperties } from "react";

export function PwndaWordmark({
  size = 14,
  scan = true,
  style,
}: {
  size?: number;
  scan?: boolean;
  style?: CSSProperties;
}) {
  const spacing = Math.max(1.5, size * 0.18);
  const glow = Math.max(3, size * 0.32);
  const scanStep = Math.max(2, Math.round(size / 7));
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        lineHeight: 1,
        filter: "contrast(1.05)",
        ...style,
      }}
    >
      <span
        style={{
          position: "relative",
          zIndex: 2,
          fontFamily: "'Press Start 2P', monospace",
          fontSize: size,
          letterSpacing: spacing,
          color: "#f2f2f2",
          textShadow:
            `1px 0 0 rgba(255,60,60,0.9), ` +
            `-1px 0 0 rgba(0,220,255,0.85), ` +
            `0 0 ${glow}px rgba(242,242,242,0.35)`,
        }}
      >
        PWNDA
      </span>
      {scan && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 3,
            pointerEvents: "none",
            mixBlendMode: "multiply",
            background:
              `repeating-linear-gradient(0deg, transparent 0 ${scanStep - 1}px, ` +
              `rgba(0,0,0,0.55) ${scanStep - 1}px ${scanStep}px)`,
          }}
        />
      )}
    </span>
  );
}
