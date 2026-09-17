/**
 * Price, balance and value of the focused asset, with its 24h price spark.
 *
 * Landscape (the default) renders it in the right rail under "Market · TICKER".
 * Portrait (`compact`) renders it inside `AccountCard`. Portrait used to show
 * only a "≈ $x" line, which it hid while the balance was "--" and which printed
 * "$NaN" for a balance that was not a number (audit, 2026-09-16); it had no
 * price at all.
 *
 * Every figure uses the shared formatters in `wallet-surface.ts`, so "—" means
 * unknown and nothing else.
 */
import { MiniSpark } from "../../components/PrimitivesV2";
import { placeholderSparkFor } from "./spark-fallback";
import { formatAssetPrice, formatAssetUsd } from "./wallet-surface";

/** The price series to draw: real history, else the per-ticker placeholder. */
export function priceSparkFor(ticker: string, history: number[] | undefined): number[] {
  return history && history.length > 0 ? history : placeholderSparkFor(ticker.toUpperCase());
}

export function AssetMarketBlock({
  ticker,
  price,
  balanceText,
  usd,
  priceSpark,
  sparkColor,
  compact = false,
}: {
  ticker: string;
  price: number | null;
  /** Already formatted (`formatAssetBalance`, or a Zephyr asset's own string). */
  balanceText: string;
  /** `assetUsdValue`: null = unknown. */
  usd: number | null;
  priceSpark: number[];
  sparkColor: string;
  /** Portrait: sits inside a card, so no eyebrow of its own and a fluid spark. */
  compact?: boolean;
}) {
  return (
    <div data-asset-market={ticker} style={compact ? { marginTop: 8 } : undefined}>
      <div
        style={{
          fontSize: compact ? 9 : 9.5,
          color: compact ? "var(--text-dim)" : "var(--text-muted)",
          letterSpacing: compact ? 1.2 : 1.5,
          textTransform: "uppercase",
          marginBottom: compact ? 6 : 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        Market · {ticker}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: compact ? 4 : 6,
          fontSize: compact ? 10.5 : 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        <MarketRow k="price" v={formatAssetPrice(price)} />
        <MarketRow k="balance" v={balanceText} />
        <MarketRow k="value" v={formatAssetUsd(usd)} />
      </div>
      <div style={{ marginTop: compact ? 8 : 12 }}>
        {compact ? (
          <MiniSpark values={priceSpark} w={260} h={28} color={sparkColor} fluid />
        ) : (
          <MiniSpark values={priceSpark} w={260} h={36} color={sparkColor} />
        )}
      </div>
    </div>
  );
}

function MarketRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <span style={{ color: "var(--text-dim)", letterSpacing: 1, textTransform: "uppercase" }}>{k}</span>
      <span
        className="tnum"
        style={{
          color: "var(--text)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {v}
      </span>
    </div>
  );
}
