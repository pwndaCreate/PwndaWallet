/**
 * <BottomNav> — 5-tab bottom navigation (Wallet · Swap · Mine · Activity · Settings).
 *
 * Active tab: 1px accent top-border + accent-soft fill + accent text.
 * Shown only when a wallet exists in the full app; lite uses its own
 * LiteBottomNav.
 */

import type { ReactNode } from "react";

export type TabId = "wallet" | "swap" | "mine" | "activity" | "settings";

const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: "wallet", icon: "◈", label: "Wallet" },
  { id: "swap", icon: "⇄", label: "Swap" },
  { id: "mine", icon: "⛏", label: "Mine" },
  { id: "activity", icon: "≡", label: "Activity" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

export function BottomNav({
  tab,
  setTab,
}: {
  tab: TabId;
  setTab: (t: TabId) => void;
}): ReactNode {
  return (
    <div
      style={{
        height: 50,
        minHeight: 50,
        display: "flex",
        alignItems: "stretch",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-2)",
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      {TABS.map((t, i) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              background: active ? "var(--accent-soft)" : "transparent",
              border: "none",
              borderRight:
                i < TABS.length - 1 ? "1px solid var(--border-soft)" : "none",
              borderTop: active
                ? "1px solid var(--accent)"
                : "1px solid transparent",
              cursor: "pointer",
              color: active ? "var(--accent)" : "var(--text-dim)",
              transition:
                "all var(--motion-hover-duration, 120ms) var(--motion-hover-easing, ease)",
              padding: "4px 0",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{t.icon}</span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 8,
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
