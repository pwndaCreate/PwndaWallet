import type { CSSProperties } from "react";
import type { ChainAdapter, ChainType, WalletInfo } from "../../wallets/types";
import { getAdapter } from "../../wallets";
import { PIXEL_ICONS, PixelCoin } from "../../components/PixelCoin";

/**
 * Portrait-mode chain selector — replaces the old horizontal chip strip
 * + native `<select>` combo with a tile grid that matches the design
 * vocabulary used in the Zephyr swap modal:
 *   - Color-coded badge per asset (the chain's brand color, with the
 *     pixel-art coin if available, ticker letters as fallback).
 *   - Ticker + balance stacked, mono font.
 *   - Active state: tinted background, brand-color border, glowing icon.
 *   - Disabled state: half-opacity, no hover.
 *
 * Independent-seed chains (Monero, Zephyr) are always selectable so the
 * dashboard can render their import panel for users who haven't loaded
 * a seed yet.
 */
export function ChainPickerGrid({
  chains,
  activeChain,
  walletsByChain,
  balancesByChain,
  onSelect,
}: {
  chains: readonly ChainType[];
  activeChain: ChainType;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  /** Optional balance map (raw display strings from adapter.getBalance).
   *  Skipped per-tile when undefined or "—". */
  balancesByChain?: Partial<Record<ChainType, string>>;
  onSelect: (chain: ChainType) => void;
}) {
  return (
    <div
      style={{
        margin: "0 0 14px",
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: 1.5,
          color: "var(--text-dim)",
          marginBottom: 8,
          paddingLeft: 2,
        }}
      >
        ACTIVE CHAIN
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
          gap: 6,
        }}
      >
        {chains.map((chain) => {
          const a = getAdapter(chain);
          const hasWallet = !!walletsByChain[chain];
          const alwaysSelectable = !!a.usesIndependentSeed;
          const selectable = hasWallet || alwaysSelectable;
          const active = chain === activeChain;
          const balance = balancesByChain?.[chain];
          return (
            <ChainTile
              key={chain}
              adapter={a}
              active={active}
              selectable={selectable}
              balance={balance}
              onClick={() => {
                if (selectable) onSelect(chain);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ChainTile({
  adapter,
  active,
  selectable,
  balance,
  onClick,
}: {
  adapter: ChainAdapter;
  active: boolean;
  selectable: boolean;
  balance?: string;
  onClick: () => void;
}) {
  const color = adapter.color;
  const hasPixelIcon = !!PIXEL_ICONS[adapter.ticker];

  const baseStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "10px 6px",
    background: active ? `${color}1f` : "rgba(255,255,255,0.025)",
    border: `1px solid ${active ? color : "rgba(255,255,255,0.10)"}`,
    borderRadius: 2,
    color: active ? color : "var(--text)",
    fontFamily: "var(--mono)",
    cursor: selectable ? "pointer" : "not-allowed",
    opacity: selectable ? 1 : 0.32,
    transition: "all .15s",
    minHeight: 72,
    position: "relative",
    overflow: "hidden",
  };

  const tickerStyle: CSSProperties = {
    fontSize: 11,
    letterSpacing: 0.8,
    fontWeight: 600,
    marginTop: 2,
  };

  const balanceStyle: CSSProperties = {
    fontSize: 9,
    letterSpacing: 0.4,
    color: "var(--text-dim)",
    marginTop: 1,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  // Active tile gets a thin colored top accent strip — small visual
  // anchor that reads from across the grid.
  const accentStrip: CSSProperties | undefined = active
    ? {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: color,
      }
    : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!selectable}
      title={`${adapter.displayName} (${adapter.ticker})${selectable ? "" : " — not imported"}`}
      style={baseStyle}
    >
      {accentStrip && <div style={accentStrip} />}

      {/* Icon: pixel-art coin if available, else colored letter badge */}
      {hasPixelIcon ? (
        <PixelCoin
          sym={adapter.ticker}
          size={26}
          color={active ? color : "rgba(242,242,242,0.85)"}
          glow={active}
        />
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            background: active ? color : `${color}80`,
            color: "#0a0a0a",
            borderRadius: 13,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}
        >
          {adapter.ticker.slice(0, 3)}
        </span>
      )}

      <span style={tickerStyle}>{adapter.ticker}</span>

      {balance && balance !== "—" && balance !== "Not initialized" && (
        <span style={balanceStyle}>{balance}</span>
      )}
    </button>
  );
}
