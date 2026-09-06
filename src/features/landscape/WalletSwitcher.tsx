import { CSSProperties, useState } from "react";
import { useAppState } from "../../state/AppStateContext";
import {
  listContexts,
  shouldShowSwitcher,
  type WalletKind,
} from "../../vault-schema";

/**
 * Landscape rail wallet switcher (Phase 3). A compact control at the top of
 * the sidebar rail showing the active context; clicking opens a flyout with
 * every switchable context + "All Wallets" + a jump to Settings ▸ Wallets.
 *
 * Reads `walletEntries` / `activeWalletId` from AppStateContext; `onSwitch`
 * (switchWallet) and `onManageWallets` (nav to Settings) come from props.
 * Renders nothing for single-context installs (locked decision 2) so today's
 * single-wallet users see no new chrome.
 */

const KIND_META: Record<WalletKind, { label: string; color: string }> = {
  bip39: { label: "BIP39", color: "var(--accent)" },
  xmr: { label: "XMR", color: "#ff6b1a" },
  zph: { label: "ZPH", color: "#a78bfa" },
  zano: { label: "ZANO", color: "#f0a020" },
  privateKey: { label: "KEY", color: "#f59e0b" },
  watch: { label: "👁", color: "#60a5fa" },
};

export function WalletSwitcher({
  onSwitch,
  onManageWallets,
}: {
  onSwitch: (id: string) => void;
  onManageWallets: () => void;
}) {
  const { walletEntries, activeWalletId } = useAppState();
  const [open, setOpen] = useState(false);

  const v3 = { v: 3 as const, wallets: walletEntries };
  if (!shouldShowSwitcher(v3)) return null;

  const contexts = listContexts(v3);
  const activeName =
    activeWalletId === "all"
      ? "All Wallets"
      : contexts.find((c) => c.members.some((m) => m.id === activeWalletId))?.name ??
        "All Wallets";

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Switch wallet"
        style={{
          width: "100%",
          height: 52,
          background: open ? "rgba(0,255,102,0.06)" : "transparent",
          border: "none",
          borderBottom: "1px solid var(--border)",
          borderLeft: open ? "2px solid var(--accent)" : "2px solid transparent",
          color: "var(--text)",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          padding: "4px 2px",
          fontFamily: "var(--mono)",
        }}
      >
        <span style={{ fontSize: 15, color: "var(--accent)", lineHeight: 1 }}>◈</span>
        <span style={ellipsis}>{activeName}</span>
        <span style={{ fontSize: 7, color: "var(--text-dim)", letterSpacing: 0.5 }}>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={backdrop} />
          <div style={flyout} role="menu">
            <div style={flyoutHeader}>Switch wallet</div>

            <button
              style={rowStyle(activeWalletId === "all")}
              onClick={() => {
                onSwitch("all");
                setOpen(false);
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                <span style={{ color: "var(--accent)" }}>◈</span>
                <span>All Wallets</span>
              </span>
              {activeWalletId === "all" && <span style={check}>✓</span>}
            </button>

            <div style={divider} />

            {contexts.map((c) => {
              const active = c.members.some((m) => m.id === activeWalletId);
              return (
                <button
                  key={c.groupId}
                  style={rowStyle(active)}
                  onClick={() => {
                    onSwitch(c.id);
                    setOpen(false);
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      minWidth: 0,
                      flex: 1,
                      alignItems: "flex-start",
                    }}
                  >
                    <span style={{ ...ellipsisWide, fontSize: 11, color: "var(--text)" }}>
                      {c.name}
                    </span>
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {c.members.map((m) => (
                        <span
                          key={m.id}
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 7,
                            letterSpacing: 0.5,
                            color: KIND_META[m.kind].color,
                            border: `1px solid ${KIND_META[m.kind].color}`,
                            borderRadius: 2,
                            padding: "0 3px",
                            opacity: 0.85,
                          }}
                        >
                          {KIND_META[m.kind].label}
                        </span>
                      ))}
                    </div>
                  </div>
                  {active && <span style={check}>✓</span>}
                </button>
              );
            })}

            <div style={divider} />

            <button
              style={rowStyle(false)}
              onClick={() => {
                onManageWallets();
                setOpen(false);
              }}
            >
              <span style={{ color: "var(--text-dim)" }}>+ Add / Manage Wallets</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const ellipsis: CSSProperties = {
  fontSize: 8,
  letterSpacing: 0.3,
  color: "var(--text)",
  maxWidth: 64,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "center",
};
const ellipsisWide: CSSProperties = {
  maxWidth: 190,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
// Fixed positioning so the flyout is never clipped by the rail/body overflow.
// Anchored just right of the 72px rail, below the 36px titlebar.
const flyout: CSSProperties = {
  position: "fixed",
  top: 40,
  left: 76,
  width: 244,
  maxHeight: "calc(100vh - 60px)",
  overflowY: "auto",
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: 3,
  boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
  zIndex: 50,
  padding: 4,
  animation: "fade-in .12s ease",
};
const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 49,
  background: "transparent",
};
const flyoutHeader: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 8,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-dim)",
  padding: "6px 8px 4px",
};
const divider: CSSProperties = {
  height: 1,
  background: "var(--border-soft)",
  margin: "4px 0",
};
const check: CSSProperties = { color: "var(--accent)", fontSize: 11, flexShrink: 0 };

function rowStyle(active: boolean): CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 8px",
    background: active ? "rgba(0,255,102,0.06)" : "transparent",
    border: "none",
    borderRadius: 2,
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    textAlign: "left",
  };
}
