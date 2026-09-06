/**
 * <Panel> — bracketed-card composition layer (v2: brackets removed,
 * matches the quiet Card label-strip).
 *
 * Used by landscape views. Prop API unchanged from v1 so existing call
 * sites pick up the new look without modification.
 */

import type { CSSProperties, ReactNode } from "react";

export function Panel({
  label,
  tag,
  right,
  children,
  style,
  bodyStyle,
  pad = 14,
}: {
  label?: ReactNode;
  tag?: string;
  right?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  pad?: number;
}) {
  return (
    <div
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...style,
      }}
    >
      {(label || right) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 30,
            flexShrink: 0,
            padding: "0 14px",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 9.5,
            lineHeight: 1,
            fontFamily: "var(--mono)",
          }}
        >
          {label && (
            <span
              style={{
                color: "var(--text-muted)",
                letterSpacing: 1.5,
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
              {label}
            </span>
          )}
          {tag && (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9,
                color: "var(--text-dim)",
                letterSpacing: 0.8,
                marginLeft: 8,
              }}
            >
              {tag}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {right}
        </div>
      )}
      <div style={{ padding: pad, flex: 1, minHeight: 0, ...bodyStyle }}>
        {children}
      </div>
    </div>
  );
}
