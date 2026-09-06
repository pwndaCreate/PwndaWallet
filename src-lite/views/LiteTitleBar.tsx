import type { CSSProperties } from "react";
import { Dot } from "../../src/components/Primitives";

const LITE_VERSION = "v0.5.0";

/**
 * PwndaLite titlebar — same shape as the full wallet's `<TitleBar>` from
 * `components/PrimitivesV2.tsx` but with "LITE" branding and no sync
 * status chip (lite never syncs anything — no wallet, no vault). Kept
 * separate from the shared primitive so neither product carries the
 * other's labels.
 */
export function LiteTitleBar({
  onMin,
  onClose,
}: {
  onMin: () => void;
  onClose: () => void;
}) {
  const winBtn: CSSProperties = {
    width: 38,
    height: 34,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
  };

  return (
    <div
      data-tauri-drag-region
      style={{
        height: 34,
        minHeight: 34,
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-2)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-muted)",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          flex: 1,
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--white)",
            letterSpacing: 1,
            textTransform: "uppercase",
            textShadow: "0 0 4px rgba(242,242,242,0.4)",
          }}
        >
          pwnda
        </span>
        <span style={{ color: "var(--accent)", letterSpacing: 1, fontSize: 11 }}>
          ::
        </span>
        <span
          style={{
            color: "var(--text-muted)",
            letterSpacing: 1,
            fontSize: 11,
            textTransform: "uppercase",
          }}
        >
          lite
        </span>
        <span
          style={{
            color: "var(--text-dim)",
            letterSpacing: 1,
            fontSize: 9,
            marginLeft: 6,
          }}
        >
          MINING · {LITE_VERSION}
        </span>
      </div>
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          pointerEvents: "none",
        }}
      >
        <Dot color="gray" />
        <span style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 0.8 }}>
          standalone
        </span>
      </div>
      <div style={{ display: "flex" }}>
        <button onClick={onMin} title="Minimize" style={winBtn}>
          <svg width="9" height="2" viewBox="0 0 9 2">
            <rect width="9" height="2" fill="currentColor" />
          </svg>
        </button>
        <button
          onClick={onClose}
          title="Close"
          style={{ ...winBtn, color: "var(--danger)" }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9">
            <line x1="0" y1="0" x2="9" y2="9" stroke="currentColor" strokeWidth="1.4" />
            <line x1="9" y1="0" x2="0" y2="9" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
