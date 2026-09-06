/**
 * AssetsListLegacy — frozen 2026-05-16 backup of the original portrait
 * dashboard assets list. Kept so the user can revert the v2 card-style
 * redesign with a one-line swap in DashboardView.tsx:
 *
 *     // import { AssetsList } from "./AssetsList";        // <-- v2
 *     import { AssetsList } from "./AssetsListLegacy";     // <-- legacy
 *
 * The current production component is the v2 redesign defined inline
 * inside DashboardView.tsx::AssetsList. If you want the old single-
 * row look back, swap the inline call site to import from here
 * instead and delete the inline definition.
 *
 * Diff vs v2:
 *   - Single horizontal row per asset (icon + ticker + name + balance + usd)
 *   - No card border / no per-row separation other than border-bottom
 *   - No 24h delta percentage
 *   - Active row indicated by tinted background only
 */

import { useMemo } from "react";
import {
  ALL_CHAINS,
  getAdapter,
  type ChainType,
  type WalletInfo,
} from "../../wallets";
import { Card } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";

export function AssetsList({
  activeChain,
  walletsByChain,
  balancesByChain,
  pricesByTicker,
  onSelect,
}: {
  activeChain: ChainType;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  pricesByTicker: Record<string, number>;
  onSelect: (chain: ChainType) => void;
  // v2 added priceHistoryByTicker — accepted but ignored here so the
  // call site stays compatible if the user toggles back.
  priceHistoryByTicker?: Record<string, number[]>;
}) {
  const rows = useMemo(() => {
    const list = ALL_CHAINS.map((chain) => {
      const a = getAdapter(chain);
      const hasWallet = !!walletsByChain[chain];
      const independent = !!a.usesIndependentSeed;
      const selectable = hasWallet || independent;
      const bal = balancesByChain[chain];
      const numeric =
        bal && bal !== "—" && bal !== "Not initialized"
          ? parseFloat(bal.replace(/,/g, ""))
          : NaN;
      const price = pricesByTicker[a.ticker.toUpperCase()];
      const usd =
        Number.isFinite(numeric) && price && Number.isFinite(price)
          ? numeric * price
          : 0;
      return { chain, adapter: a, selectable, bal, usd };
    }).filter((r) => r.selectable);
    list.sort((a, b) => b.usd - a.usd);
    return list;
  }, [walletsByChain, balancesByChain, pricesByTicker]);

  if (rows.length === 0) return null;

  return (
    <Card title="ASSETS">
      <div style={{ display: "flex", flexDirection: "column", marginTop: -4 }}>
        {rows.map(({ chain, adapter, bal, usd }) => {
          const active = chain === activeChain;
          return (
            <button
              key={chain}
              onClick={() => onSelect(chain)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 4px",
                background: active ? `${adapter.color}14` : "transparent",
                border: "none",
                borderBottom: "1px solid var(--border-soft)",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                color: active ? adapter.color : "var(--text)",
                transition: "background .12s ease",
              }}
            >
              <CoinIcon
                sym={adapter.ticker}
                size={22}
                color={active ? adapter.color : "var(--white)"}
                glow={false}
              />
              <span style={{ fontSize: 12, fontWeight: 600, flex: "0 0 60px" }}>
                {adapter.ticker}
              </span>
              <span style={{ flex: 1, fontSize: 10, color: "var(--text-dim)" }}>
                {adapter.displayName}
              </span>
              <span
                className="tnum"
                style={{ fontSize: 11, textAlign: "right", minWidth: 60 }}
              >
                {bal && bal !== "—" && bal !== "Not initialized" ? bal : "—"}
              </span>
              <span
                className="tnum"
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  textAlign: "right",
                  minWidth: 64,
                }}
              >
                {usd > 0
                  ? `$${usd.toLocaleString("en-US", {
                      maximumFractionDigits: usd >= 100 ? 0 : 2,
                    })}`
                  : ""}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
