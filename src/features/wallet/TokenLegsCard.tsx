/**
 * Tokens held on this account, and the other networks of this token
 * (2026-09-29).
 *
 * A token leg — USDT on TRON, USDC on Solana, … — is a real chain the wallet
 * can receive into, hold, send and swap. But both layouts listed a stablecoin
 * family only once something was held (until 2026-09-29), and portrait's
 * family row opens the network holding the MOST. So USDT on TRON could not be
 * reached to receive into on a wallet holding no USDT anywhere, and in
 * portrait not at all while another network held more.
 *
 * Mounted under the coin panel in BOTH layouts (portrait `DashboardView`,
 * landscape `WalletLandscapeView`), one component so they cannot drift:
 *   - on a parent chain (TRON, Solana, Ethereum…) it lists the token legs that
 *     account holds, each one click from its own panel;
 *   - on a token leg it lists the token's other networks, and names the parent
 *     coin that pays its fees.
 * Renders nothing on a chain with no token legs.
 */
import type { ChainType, WalletInfo } from "../../wallets/types";
import { getAdapter } from "../../wallets";
import {
  STABLECOIN_NETWORKS,
  stablecoinNetworkFor,
  stablecoinRailGroups,
} from "../../wallets/stablecoins";
import { Card } from "../../components/PrimitivesV2";

interface Row {
  chain: ChainType;
  label: string;
  sub?: string;
  ticker: string;
  balance?: string;
  active: boolean;
}

export function TokenLegsCard({
  activeChain,
  walletsByChain,
  balancesByChain,
  onSelect,
}: {
  activeChain: ChainType;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  onSelect: (chain: ChainType) => void;
}) {
  const leg = stablecoinNetworkFor(activeChain);
  let title: string;
  let rows: Row[];
  let feeNote: { chain: ChainType; text: string } | null = null;

  if (leg) {
    // The same grouping the rail shows (`stablecoinRailGroups`), so USDT's
    // list includes "Arbitrum · USD₮0" exactly as the rail and the swap
    // picker do, and a USD₮0 leg lists the USDT networks beside it.
    const group = stablecoinRailGroups(balancesByChain).find((g) =>
      g.rows.some((r) => r.chain === activeChain),
    );
    const unit = group?.symbol ?? leg.symbol;
    rows = (group?.rows ?? [])
      .filter((r) => !!walletsByChain[r.chain])
      .map((r) => ({
        chain: r.chain,
        label: r.network,
        ticker: unit,
        balance: r.balance,
        active: r.chain === activeChain,
      }));
    title = `${unit} on other networks`;
    if (walletsByChain[leg.parent]) {
      const parent = getAdapter(leg.parent);
      feeNote = {
        chain: leg.parent,
        text: `Fees for ${leg.symbol} on ${leg.network} are paid in ${parent.ticker} — open ${parent.displayName} ›`,
      };
    }
  } else {
    rows = STABLECOIN_NETWORKS.filter(
      (n) => n.parent === activeChain && !!walletsByChain[n.chain],
    ).map((n) => ({
      chain: n.chain,
      label: n.symbol,
      sub: `on ${n.network}`,
      ticker: n.symbol,
      balance: balancesByChain[n.chain],
      active: false,
    }));
    title = "Tokens on this account";
  }

  if (rows.length === 0) return null;

  return (
    <Card style={{ marginTop: 10 }}>
      <div data-token-legs={activeChain}>
        <div
          className="label"
          style={{
            color: "var(--accent)",
            fontSize: 10,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        {rows.map((r, i) => (
          <button
            key={r.chain}
            data-token-leg={r.chain}
            onClick={() => onSelect(r.chain)}
            disabled={r.active}
            title={r.active ? "You are viewing this network" : `Open ${r.ticker} ${r.sub ?? `on ${r.label}`}`}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              padding: "7px 0",
              background: "transparent",
              border: "none",
              borderTop: i === 0 ? "none" : "1px solid var(--border-soft)",
              color: r.active ? "var(--accent)" : "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              cursor: r.active ? "default" : "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ minWidth: 0 }}>
              {r.label}
              {r.sub && (
                <span style={{ color: "var(--text-dim)", fontSize: 9 }}> {r.sub}</span>
              )}
              {r.active && (
                <span style={{ color: "var(--text-dim)", fontSize: 9 }}> · viewing</span>
              )}
            </span>
            <span className="tnum" style={{ flexShrink: 0 }}>
              {r.balance ?? "—"} <span style={{ color: "var(--text-dim)" }}>{r.ticker}</span>
            </span>
          </button>
        ))}
        {feeNote && (
          <button
            data-token-leg-parent={feeNote.chain}
            onClick={() => onSelect(feeNote!.chain)}
            style={{
              marginTop: 6,
              padding: 0,
              background: "transparent",
              border: "none",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              lineHeight: 1.5,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {feeNote.text}
          </button>
        )}
      </div>
    </Card>
  );
}
