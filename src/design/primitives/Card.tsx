/**
 * <Card> — quiet label-strip-on-top frame. Hot-path primitive.
 *
 * Replaces most Box / Panel uses. No bracketed [ ... ] decoration —
 * just a thin top strip with a tracked uppercase label. Body always
 * wrapped in the `fade-in` animation utility.
 *
 * See src/design/BEHAVIORS.md — "Fade-in on mount".
 */

import type { CSSProperties, ReactNode } from "react";

export function Card({
  title,
  right,
  children,
  style,
  bodyStyle,
  pad = 14,
  padded = true,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  pad?: number;
  padded?: boolean;
}) {
  return (
    <div
      className="fade-in"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...style,
      }}
    >
      {(title || right) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-soft)",
            flexShrink: 0,
            gap: 8,
          }}
        >
          {title && (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9.5,
                fontWeight: 500,
                color: "var(--text-muted)",
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              {title}
            </span>
          )}
          {right}
        </div>
      )}
      <div
        style={{
          padding: padded ? pad : 0,
          flex: 1,
          minHeight: 0,
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
