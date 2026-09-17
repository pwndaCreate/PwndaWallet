/**
 * One row of the wallet's asset list, for both layouts.
 *
 * Landscape (the default) is the dense rail row: coin, name, `TICKER · addr`,
 * and balance over value on the right. Portrait (`compact`) is the card row:
 * framed coin, name over balance, value over 24h change on the right. The
 * shape differs because the columns do; what each figure MEANS does not, and
 * that is the part that lives here once:
 *
 *  - the balance is `formatAssetBalance` in both;
 *  - the value is `formatAssetUsd`: a known zero is "$0.00" and "—" is only
 *    ever "unknown". Portrait printed "—" for a known zero, which is the same
 *    glyph it used for a failed load (audit, 2026-09-16);
 *  - the swap node's holding is the same `SwapBalanceSubline`, in the name
 *    column, never beside the wallet's own figures.
 *
 * `ImportableAssetRow` below is the "not imported · import ▸" entry for an
 * independent-seed chain with no wallet (`importableChains`). Portrait had no
 * such row; it listed those chains as ordinary rows with a "—" balance, kept
 * visible by a hand list of tickers.
 */
import type { CSSProperties, ReactNode } from "react";
import { CoinIcon } from "../../components/CoinIcon";
import { SwapBalanceSubline } from "./SwapBalanceSubline";
import { formatAssetBalance, formatAssetUsd } from "./wallet-surface";

function truncAddr(addr: string): string {
  if (!addr) return "—";
  if (addr.length <= 22) return addr;
  return `${addr.slice(0, 11)}…${addr.slice(-8)}`;
}

export function AssetRow({
  name,
  ticker,
  iconSym,
  color,
  active,
  onSelect,
  balanceRaw,
  usd,
  address,
  swapBalanceRaw,
  delta24hPct = null,
  compact = false,
}: {
  name: string;
  ticker: string;
  /** Icon symbol when it differs from the ticker. */
  iconSym?: string;
  color: string;
  active: boolean;
  onSelect: () => void;
  balanceRaw: string | undefined;
  /** From `assetUsdValue`: null = unknown, 0 = a known zero. */
  usd: number | null;
  /** Landscape subline. Omit for a row with no single address (a stablecoin
   *  family); the subline then shows the ticker alone. */
  address?: string;
  /** The swap node's balance for this ticker, verbatim; null/undefined when none. */
  swapBalanceRaw: string | null | undefined;
  /** Portrait's 24h price change; null while history is loading. */
  delta24hPct?: number | null;
  compact?: boolean;
}) {
  const balanceText = formatAssetBalance(balanceRaw);
  const usdText = formatAssetUsd(usd);

  if (!compact) {
    return (
      <button
        type="button"
        onClick={onSelect}
        data-asset-row={ticker}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          background: active ? `${color}14` : "transparent",
          border: "none",
          borderLeft: active ? `2px solid ${color}` : "2px solid transparent",
          borderBottom: "1px solid var(--border-soft)",
          // The box glows with the coin, so focus is legible without colour
          // having to do double duty.
          boxShadow: active ? `inset 0 0 22px -6px ${color}66` : "none",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "var(--font-mono)",
          color: active ? color : "var(--text)",
          transition: "background .12s ease, box-shadow .12s ease",
        }}
      >
        {/* Every coin carries its OWN colour at rest (2026-09-02); focus is the
            halo plus the row's border/tint, so the two signals stay separate. */}
        <CoinIcon sym={iconSym ?? ticker} size={20} color={color} glow={active ? "accent" : false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* The display name, not the bare ticker: the EVM L2s all share
              "ETH" and one address, so a ticker-only label rendered several
              indistinguishable rows. */}
          <div style={ellipsis({ fontSize: 11, fontWeight: 600, letterSpacing: 0.4 })}>{name}</div>
          <div style={ellipsis({ fontSize: 8, color: "var(--text-dim)", marginTop: 1 })}>
            {address !== undefined ? `${ticker} · ${truncAddr(address)}` : ticker}
          </div>
          <SwapBalanceSubline raw={swapBalanceRaw} ticker={ticker} />
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div className="tnum" style={{ fontSize: 11 }}>{balanceText}</div>
          <div className="tnum" style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 1 }}>
            {usdText}
          </div>
        </div>
      </button>
    );
  }

  const positive = delta24hPct !== null && delta24hPct >= 0;
  const deltaColor =
    delta24hPct === null
      ? "var(--text-dim)"
      : positive
        ? "var(--accent)"
        : "var(--warn, #ff6b6b)";
  const deltaText =
    delta24hPct === null ? "—" : `${positive ? "+" : ""}${delta24hPct.toFixed(1)}%`;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-asset-row={ticker}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        // Focus is the coin's OWN colour glowing, not a generic accent border.
        background: active ? `${color}12` : "rgba(255,255,255,0.02)",
        border: active ? `1px solid ${color}` : "1px solid var(--border)",
        boxShadow: active ? `0 0 14px -4px ${color}` : "none",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "var(--font-mono)",
        color: "var(--text)",
        transition: "background .12s ease, border-color .12s ease, box-shadow .12s ease",
        width: "100%",
      }}
    >
      <IconFrame color={color} active={active}>
        <CoinIcon sym={iconSym ?? ticker} size={20} color={color} glow={active ? "accent" : false} />
      </IconFrame>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, gap: 2 }}>
        <span style={ellipsis({ fontSize: 13, fontWeight: 500, color: "var(--text)", letterSpacing: 0.2 })}>
          {name}
        </span>
        <span className="tnum" style={{ fontSize: 10.5, color: "var(--text-dim)", letterSpacing: 0.2 }}>
          {balanceText} {ticker}
        </span>
        <SwapBalanceSubline raw={swapBalanceRaw} ticker={ticker} size={9.5} />
      </div>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
          minWidth: 72,
        }}
      >
        <span
          className="tnum"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: usd != null && usd > 0 ? "var(--text)" : "var(--text-dim)",
            letterSpacing: 0.2,
          }}
        >
          {usdText}
        </span>
        <span
          className="tnum"
          style={{ fontSize: 10.5, color: deltaColor, letterSpacing: 0.2 }}
          title={
            delta24hPct === null
              ? "24h delta — fetching price history."
              : "24h price change for this asset."
          }
        >
          {deltaText}
        </span>
      </div>
    </button>
  );
}

/**
 * An independent-seed chain with no wallet yet: the entry point to its import
 * panel. Never carries a balance or a value — there is no wallet to have one.
 */
export function ImportableAssetRow({
  name,
  ticker,
  color,
  active,
  onSelect,
  compact = false,
}: {
  name: string;
  ticker: string;
  color: string;
  active: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  const icon = <CoinIcon sym={ticker} size={compact ? 20 : 22} color={color} glow={active ? "accent" : false} />;
  const label = (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: compact ? 13 : 11, color: "var(--text)" }}>
        {name}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: compact ? 10.5 : 9,
          color: "var(--text-dim)",
          marginTop: compact ? 2 : 1,
        }}
      >
        {ticker} · not imported
      </div>
    </div>
  );
  const cta = (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: compact ? 10.5 : 9,
        color: "var(--text-dim)",
        flexShrink: 0,
      }}
    >
      import ▸
    </div>
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      title={`Import a ${name} wallet`}
      data-importable-row={ticker}
      style={
        compact
          ? {
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              background: active ? `${color}12` : "transparent",
              border: active ? `1px solid ${color}` : "1px dashed var(--border)",
              cursor: "pointer",
              textAlign: "left",
              opacity: active ? 1 : 0.72,
            }
          : {
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px",
              background: active ? `${color}14` : "transparent",
              border: "none",
              borderLeft: active ? `2px solid ${color}` : "2px solid transparent",
              cursor: "pointer",
              textAlign: "left",
              opacity: active ? 1 : 0.72,
            }
      }
    >
      {compact ? <IconFrame color={color} active={active}>{icon}</IconFrame> : icon}
      {label}
      {cta}
    </button>
  );
}

function IconFrame({
  color,
  active,
  children,
}: {
  color: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        width: 36,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: active
          ? `1px solid ${color}`
          : "1px solid var(--border-soft, rgba(255,255,255,0.18))",
        background: "rgba(0,0,0,0.25)",
        transition: "border-color .12s ease",
      }}
    >
      {children}
    </div>
  );
}

function ellipsis(style: CSSProperties): CSSProperties {
  return { ...style, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
}
