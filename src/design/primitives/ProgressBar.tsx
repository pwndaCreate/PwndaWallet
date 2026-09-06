/**
 * <ProgressBar> — terminal-style segmented blocks with glow halos.
 *
 * See src/design/BEHAVIORS.md — "Progress bar lit-cell glow".
 */

import type { CSSProperties } from "react";

export function ProgressBar({
  percent = 0,
  segments = 28,
  color = "var(--accent)",
  height = 6,
  style,
}: {
  percent?: number;
  segments?: number;
  color?: string;
  height?: number;
  style?: CSSProperties;
}) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * segments);
  const cells = [];
  for (let i = 0; i < segments; i++) {
    cells.push(
      <div
        key={i}
        style={{
          flex: 1,
          height,
          background: i < filled ? color : "rgba(255,255,255,0.05)",
          boxShadow: i < filled ? `0 0 4px ${color}` : "none",
        }}
      />
    );
  }
  return <div style={{ display: "flex", gap: 1.5, ...style }}>{cells}</div>;
}
