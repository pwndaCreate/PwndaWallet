/**
 * WalletTxHistorySubview — dedicated per-asset transaction-history
 * sub-page inside the Wallet tab.
 *
 * Replaces the inline tx-history cards that used to render directly
 * below the AccountCard on the dashboard (those cards still exist as
 * `XmrTxHistoryCard` + `ChainTxCard`; only their mount surface
 * changed). The user clicks a "▶ Transaction history" button on the
 * dashboard and lands here; clicking the ◄ back arrow returns to the
 * dashboard. The BottomNav stays on Wallet the whole time — this is
 * an internal sub-view of the wallet tab, not a top-level view.
 *
 * Reverting: see the note at the top of
 * `DashboardTxHistoryLegacy.tsx`. Two-line revert in DashboardView.
 */

import { ST } from "../../components/Primitives";
import { Card } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { XmrTxHistoryCard } from "../monero/XmrTxHistoryCard";
import { ZanoTxHistoryCard } from "../zano/ZanoTxHistoryCard";
import { XelisTxHistoryCard, type XelisSessionApi } from "../xelis";
import { ChainTxCard } from "./ChainTxCard";
import { getAdapter, type ChainType, type ChainTx } from "../../wallets";
import type { XmrTransfer } from "../../wallets/xmr-wallet";
import type { ZanoTransferEntry } from "../../wallets/zano-rpc";
import { mergeChainTx } from "../activity/useTxHistory";
import { historySurfaceFor } from "./wallet-surface";

type SyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "connection-lost"
  | "error";

interface XmrSlice {
  syncState: SyncState;
  txHistory: XmrTransfer[];
  txLoading: boolean;
}

interface ZanoSlice {
  syncState: "idle" | "starting" | "ready" | "error";
  txHistory: ZanoTransferEntry[];
  txLoading: boolean;
}

/** Xelis history comes from its own wallet process, like Zano's. */
type XelisSlice = Pick<XelisSessionApi, "syncState" | "txHistory" | "txLoading" | "txError">;

export function WalletTxHistorySubview({
  activeChain,
  xmrSession,
  zanoSession,
  xelisSession,
  chainTxByKey,
  chainTxLoading,
  chainTxErrors,
  addressByChain,
  onCopy,
  onBack,
}: {
  activeChain: ChainType;
  xmrSession: XmrSlice;
  zanoSession: ZanoSlice;
  xelisSession: XelisSlice;
  chainTxByKey: Record<string, ChainTx[]>;
  chainTxLoading: Record<string, boolean>;
  chainTxErrors: Record<string, string | null>;
  addressByChain: Record<string, string>;
  onCopy: (text: string) => void;
  onBack: () => void;
}) {
  const adapter = getAdapter(activeChain);
  const surface = historySurfaceFor(activeChain);
  const merged = mergeChainTx(
    { txByChain: chainTxByKey, loading: chainTxLoading, errors: chainTxErrors },
    activeChain
  );

  return (
    <div className="dashboard">
      {/* Sub-view header: back arrow + per-asset title. Mirrors the
          Mining / Miner Setup back-arrow pattern so the affordance is
          consistent across wallet sub-pages. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <button
          className="btn-icon"
          onClick={onBack}
          aria-label="Back to wallet dashboard"
          title="Back to wallet dashboard"
          style={{
            padding: "4px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          ◄
        </button>
        <h2
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            letterSpacing: 1.2,
          }}
        >
          <CoinIcon sym={adapter.ticker} size={18} glow={false} />
          <ST delay={0} speed={20}>
            {`${adapter.displayName.toUpperCase()} — TRANSACTIONS`}
          </ST>
        </h2>
      </div>

      {/* Asset eyebrow — small reminder of which address the history
          is for, so the user has context after navigating in. */}
      <Card style={{ marginBottom: 12 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "2px 0",
          }}
        >
          <span
            style={{
              fontSize: 9,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Address
          </span>
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text)",
              wordBreak: "break-all",
              lineHeight: 1.4,
            }}
          >
            {addressByChain[activeChain] || "—"}
          </code>
        </div>
      </Card>

      {/* One card per history source, chosen by `historySurfaceFor` — the
          rule landscape follows too. Monero, Zano and Xelis read history
          from their own wallet session and render in every sync state: each
          card says itself that history appears once the wallet connects or
          syncs. (Monero and Zano had an idle-only card here telling the user
          to "import your seed", which this page cannot be reached without —
          it opens only for a chain that has a wallet. Landscape now renders
          the same cards ungated, 2026-09-16.) */}
      {surface === "monero" && (
        <XmrTxHistoryCard
          syncState={xmrSession.syncState}
          txHistory={xmrSession.txHistory}
          txLoading={xmrSession.txLoading}
          onCopy={onCopy}
        />
      )}
      {surface === "zano" && (
        <ZanoTxHistoryCard
          syncState={zanoSession.syncState}
          txHistory={zanoSession.txHistory}
          txLoading={zanoSession.txLoading}
          onCopy={onCopy}
        />
      )}
      {surface === "xelis" && (
        <XelisTxHistoryCard
          syncState={xelisSession.syncState}
          txHistory={xelisSession.txHistory}
          txLoading={xelisSession.txLoading}
          txError={xelisSession.txError}
          onCopy={onCopy}
        />
      )}
      {surface === "generic" && (
        <ChainTxCard
          chain={activeChain}
          txs={merged.txs}
          loading={merged.loading}
          error={merged.error}
        />
      )}
    </div>
  );
}
