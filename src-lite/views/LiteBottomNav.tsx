import type { LiteView } from "../state/AppStateLite";

const TABS: { id: LiteView; icon: string; label: string }[] = [
  { id: "mining", icon: "⛏", label: "Mine" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

/**
 * PwndaLite bottom tab nav. Two tabs only (Mine, Settings) — there's no
 * Wallet / Swap / Activity in lite, so the shared `BottomNav` from
 * `components/Primitives.tsx` (which hardcodes the full wallet's
 * five-tab layout) isn't reusable here.
 */
export function LiteBottomNav({
  tab,
  setTab,
}: {
  tab: LiteView;
  setTab: (t: LiteView) => void;
}) {
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
              transition: "all .12s ease",
              padding: "4px 0",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{t.icon}</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
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
