/**
 * <Box> — quiet card (v2: no [ ] brackets). Composition-layer primitive.
 *
 * Consider <Card> first — it's the modern hot-path primitive. <Box>
 * is retained for back-compat with existing call sites.
 *
 * See src/design/BEHAVIORS.md — "Fade-in on mount".
 */

import type { CSSProperties, ReactNode } from "react";

export function Box({
  title,
  children,
  style,
}: {
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "12px 14px",
        marginBottom: 12,
        animation: "fade-in .2s ease",
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: 1.5,
            color: "var(--text-muted)",
            marginBottom: 10,
            paddingBottom: 8,
            borderBottom: "1px solid var(--border-soft)",
            textTransform: "uppercase",
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
