/**
 * <AsciiDivider> — section separator with optional centered label.
 */

import type { CSSProperties, ReactNode } from "react";

export function AsciiDivider({
  label,
  style,
}: {
  label?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--mono)",
        fontSize: 9,
        color: "var(--text-dim)",
        letterSpacing: 1.5,
        textTransform: "uppercase",
        margin: "12px 0",
        ...style,
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
      {label && <span>{label}</span>}
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
    </div>
  );
}
