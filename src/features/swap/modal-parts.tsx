/**
 * Shared presentational parts for the swap modals.
 *
 * Extracted from `SwapConfirmModal.tsx` on 2026-07-19 so the desk's own modals
 * (`DeskConfirmModal`, `DeskSwapTrackerModal`) render identically to the
 * aggregator confirm modal without importing it — the desk flow shares none of
 * that module's password/execute machinery and should not pull it in.
 *
 * Values are copied VERBATIM. `Backdrop` in particular keeps its exact
 * `zIndex: 60` and `fade-in .15s ease`: the legacy `.modal-overlay` class in
 * legacy.css uses z-index 2000, and building the desk modals on that idiom
 * would stack them above every other swap surface in a way nothing else does.
 *
 * `formatPwndaFee` deliberately did NOT move — `swapkit-live.test.ts` imports
 * it from `./SwapConfirmModal` with no module mocking, and eight exact-string
 * assertions depend on that path.
 */
import { useState } from "react";

export function Backdrop({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        animation: "fade-in .15s ease",
      }}
    >
      {children}
    </div>
  );
}

export function Row({ label, value, fullValue }: { label: string; value: string; fullValue: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        marginTop: 6,
        fontSize: 11,
      }}
    >
      <span style={{ color: "var(--text-dim)", letterSpacing: 1, textTransform: "uppercase", fontSize: 9 }}>
        {label}
      </span>
      <span className="tnum" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>{value}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(fullValue).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: copied ? "var(--accent)" : "var(--text-dim)",
            padding: "2px 6px",
            fontSize: 9,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </span>
    </div>
  );
}

export function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-dim)", letterSpacing: 1, textTransform: "uppercase", fontSize: 9 }}>{k}</span>
      <span className="tnum" style={{ color: "var(--text)" }}>{v}</span>
    </div>
  );
}

export function truncate(s: string): string {
  if (!s) return "—";
  if (s.length <= 18) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}
