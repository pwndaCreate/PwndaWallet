/**
 * Node management entry points for the sidecar-backed wallets, in both
 * Settings layouts.
 *
 * Until 2026-09-16 each layout wrote its own: landscape a `PrivacyNodeRow`
 * list that showed Monero/Zephyr with a "not imported" chip and hid Zano/Xelis
 * when absent, portrait four buttons that hid all of them when absent. The
 * same user saw different chains listed depending on which way the window was
 * turned. Now one list, one rule: every sidecar chain is listed; a loaded one
 * offers "Manage Nodes", an absent one says "not imported". The chip is text,
 * not a link, so it is never a dead end.
 */
import type { CSSProperties } from "react";

interface NodeEntry {
  chain: string;
  loaded: boolean;
  onManage: () => void;
}

export function NodeEntryList({
  xmrSeedLoaded,
  zphSeedLoaded,
  zanoSeedLoaded,
  xelisSeedLoaded,
  onOpenMoneroNodes,
  onOpenZephyrNodes,
  onOpenZanoNodes,
  onOpenXelisNodes,
  compact = false,
}: {
  xmrSeedLoaded: string | null;
  zphSeedLoaded: string | null;
  zanoSeedLoaded: string | null;
  xelisSeedLoaded: string | null;
  onOpenMoneroNodes: () => void;
  onOpenZephyrNodes: () => void;
  onOpenZanoNodes: () => void;
  onOpenXelisNodes: () => void;
  /** Portrait: larger type and touch targets. */
  compact?: boolean;
}) {
  const entries: NodeEntry[] = [
    { chain: "Monero", loaded: !!xmrSeedLoaded, onManage: onOpenMoneroNodes },
    { chain: "Zephyr", loaded: !!zphSeedLoaded, onManage: onOpenZephyrNodes },
    { chain: "Zano", loaded: !!zanoSeedLoaded, onManage: onOpenZanoNodes },
    { chain: "Xelis", loaded: !!xelisSeedLoaded, onManage: onOpenXelisNodes },
  ];

  const labelStyle: CSSProperties = {
    fontFamily: "var(--mono, var(--font-mono))",
    fontSize: compact ? 12 : 10,
    color: "var(--text)",
    minWidth: 64,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-node-entry-list>
      {entries.map(({ chain, loaded, onManage }) => (
        <div
          key={chain}
          data-node-entry={chain}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: compact ? "10px 12px" : "8px 10px",
            border: "1px solid var(--border-soft)",
            background: "var(--surface-2)",
          }}
        >
          <span style={labelStyle}>{chain}</span>
          <div style={{ flex: 1 }} />
          {loaded ? (
            <button
              type="button"
              onClick={onManage}
              title={`Manage ${chain} nodes`}
              style={{
                fontFamily: "var(--mono, var(--font-mono))",
                fontSize: compact ? 11 : 9,
                letterSpacing: 0.6,
                padding: compact ? "8px 12px" : "5px 10px",
                textTransform: "uppercase",
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              Manage Nodes
            </button>
          ) : (
            <span
              style={{
                fontFamily: "var(--mono, var(--font-mono))",
                fontSize: compact ? 10.5 : 9,
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              not imported
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
