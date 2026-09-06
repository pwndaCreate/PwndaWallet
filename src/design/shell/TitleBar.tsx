/**
 * <TitleBar> — 34px chrome with chromatic wordmark + sync chip + window controls.
 *
 * In Tauri, the bar is drag-region. In browser (dev:web), drag attrs
 * are inert; OS controls are hidden via the isTauri() shim.
 *
 * See src/design/BEHAVIORS.md — "Chromatic-split wordmark".
 */

import type { CSSProperties, ReactNode } from "react";
import { Dot } from "../primitives/Dot";
import { PwndaWordmark } from "../primitives/PwndaWordmark";
import { isTauri } from "../env";

const WIN_BTN: CSSProperties = {
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

export function TitleBar({
  syncLabel = "synced",
  syncColor = "green",
  onMin,
  onClose,
  version = "v2.0.1",
  middle,
}: {
  syncLabel?: string;
  syncColor?: "green" | "red" | "amber" | "gray";
  onMin?: () => void;
  onClose?: () => void;
  version?: string;
  middle?: ReactNode;
}) {
  // In a Tauri build, OS min/close buttons render. In browser mode
  // (dev:web / dev:catalog), they're hidden. The drag-region attribute
  // is ALWAYS emitted — browsers ignore unknown HTML attributes, Tauri
  // uses them. Conditionally omitting it caused a regression where some
  // Tauri 2 contexts had __TAURI_INTERNALS__ undefined at first render.
  const showOsControls = isTauri();
  const syncFg =
    syncColor === "green"
      ? "var(--accent)"
      : syncColor === "red"
      ? "var(--danger)"
      : syncColor === "amber"
      ? "var(--warn)"
      : "var(--text-dim)";
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
        fontFamily: "var(--mono)",
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
          minWidth: 0,
          pointerEvents: "none",
        }}
      >
        <PwndaWordmark size={11} scan={false} />
        <span
          style={{
            color: "var(--text-dim)",
            letterSpacing: 1,
            fontSize: 9,
            textTransform: "uppercase",
          }}
        >
          wallet · {version}
        </span>
        {middle}
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
        <Dot color={syncColor} size={5} />
        <span style={{ fontSize: 9, color: syncFg, letterSpacing: 0.8 }}>
          {syncLabel}
        </span>
      </div>
      {showOsControls && (
        <div style={{ display: "flex" }}>
          <button onClick={onMin} title="Minimize" style={WIN_BTN}>
            <svg width="9" height="2" viewBox="0 0 9 2">
              <rect width="9" height="2" fill="currentColor" />
            </svg>
          </button>
          <button
            onClick={onClose}
            title="Close"
            style={{ ...WIN_BTN, color: "var(--danger)" }}
          >
            <svg width="9" height="9" viewBox="0 0 9 9">
              <line x1="0" y1="0" x2="9" y2="9" stroke="currentColor" strokeWidth="1.4" />
              <line x1="9" y1="0" x2="0" y2="9" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
