/**
 * <BlinkCursor> — `█` with step-end blink.
 *
 * SIGNATURE behavior. See src/design/BEHAVIORS.md — "Login cursor blink".
 */

import type { CSSProperties } from "react";

export function BlinkCursor({
  color = "var(--accent)",
  style,
}: {
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        color,
        fontFamily: "var(--mono)",
        animation: "blink 1s step-end infinite",
        ...style,
      }}
    >
      █
    </span>
  );
}
