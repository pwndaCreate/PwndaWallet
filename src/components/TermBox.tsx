import type { CSSProperties, ReactNode } from "react";

export function TermBox({
  label,
  children,
  style,
  labelColor = "var(--text)",
  accent = "rgba(242,242,242,0.4)",
}: {
  label: string;
  children: ReactNode;
  style?: CSSProperties;
  labelColor?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        position: "relative",
        border: "1px solid rgba(255,255,255,0.18)",
        background: "var(--surface)",
        padding: "0 14px 14px",
        boxShadow:
          "inset 0 0 20px rgba(0,0,0,0.5), 0 0 10px rgba(242,242,242,0.04)",
        fontFamily: "'JetBrains Mono','Share Tech Mono',monospace",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginTop: -8,
          marginLeft: -4,
          marginRight: -4,
          marginBottom: 10,
          fontSize: 10,
          lineHeight: 1,
        }}
      >
        <span style={{ color: accent, paddingRight: 4, background: "var(--surface)" }}>┌─[</span>
        <span
          style={{
            color: labelColor,
            padding: "0 6px",
            background: "var(--surface)",
            letterSpacing: 1,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        <span style={{ color: accent, paddingRight: 4, background: "var(--surface)" }}>]</span>
        <span
          style={{
            flex: 1,
            color: accent,
            overflow: "hidden",
            whiteSpace: "nowrap",
            background: "var(--surface)",
          }}
        >
          {"─".repeat(200)}
        </span>
        <span style={{ color: accent, paddingLeft: 4, background: "var(--surface)" }}>┐</span>
      </div>
      {children}
    </div>
  );
}
