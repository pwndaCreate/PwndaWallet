import { CSSProperties, ReactNode, useEffect, useState } from "react";
import { Dot } from "../../components/Primitives";
import { useAppState } from "../../state/AppStateContext";
import { shouldShowSwitcher, contextForWallet } from "../../vault-schema";
import { WalletSwitcher } from "./WalletSwitcher";

/* ══════ Types ═════════════════════════════════════════════════ */
export type LandscapeTab =
  | "wallet"
  | "swap"
  | "mine"
  /** The convert pipeline (canvas frame 1d). Landscape only — portrait
   *  reaches the same pipeline through the Swap tab's CONVERT segment,
   *  because a sixth bottom-nav tab does not fit (frame 1g showed why). */
  | "earn"
  | "activity"
  | "settings";

interface NavItem {
  id: LandscapeTab;
  icon: string;
  label: string;
  hint: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "wallet",   icon: "◈",  label: "Wallet",   hint: "F1" },
  { id: "swap",     icon: "⇄",  label: "Swap",     hint: "F2" },
  { id: "mine",     icon: "⛏",  label: "Mine",     hint: "F3" },
  { id: "earn",     icon: "◎",  label: "Earn",     hint: "F4" },
  { id: "activity", icon: "≡",  label: "Activity", hint: "F5" },
  { id: "settings", icon: "⚙",  label: "Settings", hint: "F6" },
];

const TAB_LABELS: Record<LandscapeTab, string> = {
  wallet:   "wallet · portfolio overview",
  swap:     "swap · asset exchange",
  mine:     "mine · hashrate console",
  earn:     "earn · mine x receive y",
  activity: "activity · transaction log",
  settings: "settings · configuration",
};

/* ══════ Sync dot + label helper ══════════════════════════════ */
function SyncBadge({ syncState, syncPercent }: { syncState: string; syncPercent: number }) {
  const color =
    syncState === "synced" ? "green" :
    syncState === "error" ? "red" :
    syncState === "connection-lost" || syncState === "starting" || syncState === "syncing" ? "amber" : "gray";
  const label =
    syncState === "synced" ? "synced" :
    syncState === "syncing" ? `sync ${syncPercent.toFixed(0)}%` :
    syncState === "starting" ? "starting" :
    syncState === "connection-lost" ? "reconnecting" :
    syncState === "error" ? "error" : "idle";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5,
      fontFamily: "var(--mono)", fontSize: 9, color: color === "green" ? "var(--accent)" :
      color === "red" ? "var(--danger)" : color === "amber" ? "var(--warn)" : "var(--text-dim)", letterSpacing: 0.5 }}>
      <Dot color={color} />
      {label}
    </span>
  );
}

/* ══════ UTC Clock ═════════════════════════════════════════════ */
function UtcClock() {
  const [time, setTime] = useState(() => {
    const now = new Date();
    return now.toUTCString().split(" ").slice(4, 5)[0] ?? "--:--:--";
  });
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, "0");
      const m = String(now.getUTCMinutes()).padStart(2, "0");
      const s = String(now.getUTCSeconds()).padStart(2, "0");
      setTime(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{time} UTC</span>;
}

/* ══════ BlinkCursor ═══════════════════════════════════════════ */
function BlinkCursor() {
  const [v, setV] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setV(x => !x), 600);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>
      {v ? "█" : " "}
    </span>
  );
}

/* ══════ LandscapeShell ════════════════════════════════════════ */
export function LandscapeShell({
  tab,
  setTab,
  syncState,
  syncPercent,
  onLock,
  onSwitchWallet,
  children,
  handleMinimize,
  handleClose,
}: {
  tab: LandscapeTab;
  setTab: (t: LandscapeTab) => void;
  syncState: string;
  syncPercent: number;
  onLock: () => void;
  /** Switch the active wallet context (Phase 3). */
  onSwitchWallet: (id: string) => void;
  children: ReactNode;
  handleMinimize: () => void;
  handleClose: () => void;
}) {
  // Active-context label for the breadcrumb — only shown once a 2nd wallet
  // exists (single-wallet installs keep the plain `~/tab` breadcrumb).
  const { walletEntries, activeWalletId } = useAppState();
  const ctxV3 = { v: 3 as const, wallets: walletEntries };
  const showWalletCrumb = shouldShowSwitcher(ctxV3);
  const walletCrumb = showWalletCrumb
    ? (activeWalletId === "all"
        ? "all"
        : contextForWallet(ctxV3, activeWalletId)?.name ?? "all"
      )
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
    : null;
  // v2 design: always-slim icon rail (56px). The brand/collapse-toggle
  // chrome from v1 is gone — the wordmark lives in the titlebar and the
  // tab labels live in tooltips (`title=`).
  // UXS-20260516-114: sidebar widened from 56 → 72px so each tab can
  // stack the icon over its plain-text label (Wallet / Swap / Mine /
  // Activity / Settings). Matches the portrait BottomNav's
  // icon+label pattern; P1 users no longer have to hover each glyph
  // to figure out which one is which.
  const sideW = 72;

  // Keyboard shortcuts, derived from NAV_ITEMS so a new tab cannot ship
  // with a hint that points at the wrong key. Adding EARN (2026-08-28) moved
  // Activity to F5 and Settings to F6; hardcoding the list here is how those
  // two would have kept their old bindings while the rail advertised new ones.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = NAV_ITEMS.find((n) => n.hint === e.key);
      if (hit) {
        e.preventDefault();
        setTab(hit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);

  const titlebarStyle: CSSProperties = {
    height: 36,
    minHeight: 36,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    background: "var(--bg-2)",
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    zIndex: 20,
    userSelect: "none",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh",
      width: "100%", background: "var(--bg)", overflow: "hidden" }}>

      {/* ── Landscape Titlebar ──────────────────────────────────── */}
      <div style={titlebarStyle} data-tauri-drag-region>
        {/* Left: breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10,
          flex: "0 0 auto" }} data-tauri-drag-region>
          <span style={{ color: "var(--accent)" }}>›</span>
          <span style={{ color: "var(--text-dim)" }}>pwnda@vault</span>
          <span style={{ color: "rgba(255,255,255,0.2)", margin: "0 2px" }}>:</span>
          <span style={{ color: "var(--text)" }}>
            ~/{walletCrumb ? `${walletCrumb}/` : ""}{tab}
          </span>
          <BlinkCursor />
        </div>

        {/* Center: tab label */}
        <div style={{ flex: 1, display: "flex", alignItems: "center",
          justifyContent: "center" }} data-tauri-drag-region>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9,
            color: "var(--text-muted)", letterSpacing: 1.5, textTransform: "uppercase" }}>
            {TAB_LABELS[tab]}
          </span>
        </div>

        {/* Right: sync + clock + version + window controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 12,
          paddingRight: 0, flex: "0 0 auto" }}>
          <SyncBadge syncState={syncState} syncPercent={syncPercent} />
          <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9,
            color: "var(--text-dim)", letterSpacing: 0.5 }}>
            <UtcClock />
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9,
            color: "var(--text-dim)", letterSpacing: 0.5, paddingRight: 8 }}>
            v2.0.1
          </span>
          {/* Window controls */}
          <button onClick={handleMinimize} title="Minimize"
            style={winBtnStyle}>
            <svg width="10" height="2" viewBox="0 0 10 2">
              <rect width="10" height="2" fill="currentColor"/>
            </svg>
          </button>
          <button onClick={handleClose} title="Close"
            style={{ ...winBtnStyle, color: "var(--danger)" }}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body row: Sidebar + Content ─────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>

        {/* ── Sidebar — slim icon rail ─────────────────────────── */}
        <div style={{
          width: sideW, minWidth: sideW, maxWidth: sideW,
          display: "flex", flexDirection: "column", alignItems: "stretch",
          borderRight: "1px solid var(--border)",
          background: "var(--bg-2)",
          flexShrink: 0,
        }}>
          <WalletSwitcher
            onSwitch={onSwitchWallet}
            onManageWallets={() => setTab("settings")}
          />
          {NAV_ITEMS.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                title={`${item.label} (${item.hint})`}
                style={{
                  height: 58,
                  background: active ? "rgba(0,255,102,0.06)" : "transparent",
                  border: "none",
                  borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                  color: active ? "var(--accent)" : "var(--text-dim)",
                  cursor: "pointer",
                  transition: "all .12s ease",
                  fontFamily: "var(--mono)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                  padding: "4px 0",
                }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
                <span
                  style={{
                    fontSize: 9,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    lineHeight: 1,
                  }}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          <div title={`sync: ${syncState}`} style={{
            display: "flex", justifyContent: "center",
            padding: "6px 0", borderTop: "1px solid var(--border)",
          }}>
            <SyncBadge syncState={syncState} syncPercent={syncPercent} />
          </div>
          <button
            onClick={onLock}
            title="Lock wallet"
            style={{
              height: 56,
              background: "transparent",
              border: "none",
              borderTop: "1px solid var(--border)",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 16,
              fontFamily: "var(--mono)",
              transition: "color .12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            ⏻
          </button>
        </div>

        {/* ── Main content area ────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column",
          minWidth: 0, overflow: "hidden", background: "var(--bg)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

const winBtnStyle: CSSProperties = {
  width: 32, height: 36, display: "flex", alignItems: "center",
  justifyContent: "center", background: "transparent", border: "none",
  color: "var(--text-dim)", cursor: "pointer", transition: "all .12s",
  flexShrink: 0,
};
