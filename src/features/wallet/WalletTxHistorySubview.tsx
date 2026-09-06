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
import { ChainTxCard } from "./ChainTxCard";
import { getAdapter, type ChainType, type ChainTx } from "../../wallets";
import type { XmrTransfer } from "../../wallets/xmr-wallet";
import type { ZanoTransferEntry } from "../../wallets/zano-rpc";
import { mergeChainTx } from "../activity/useTxHistory";

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

export function WalletTxHistorySubview({
  activeChain,
  xmrSession,
  zanoSession,
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
  chainTxByKey: Record<string, ChainTx[]>;
  chainTxLoading: Record<string, boolean>;
  chainTxErrors: Record<string, string | null>;
  addressByChain: Record<string, string>;
  onCopy: (text: string) => void;
  onBack: () => void;
}) {
  const adapter = getAdapter(activeChain);
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

      {/* The same per-chain tx history cards that used to render
          inline on the dashboard — moved here unchanged. XMR has its
          own card with sync-state UI; everything else uses the
          generic ChainTxCard. */}
      {activeChain === "monero" && xmrSession.syncState !== "idle" && (
        <XmrTxHistoryCard
          syncState={xmrSession.syncState}
          txHistory={xmrSession.txHistory}
          txLoading={xmrSession.txLoading}
          onCopy={onCopy}
        />
      )}
      {activeChain === "monero" && xmrSession.syncState === "idle" && (
        <Card>
          <p className="no-wallet-msg">
            Monero session hasn't started yet. Import your Monero seed
            from the wallet dashboard, then return here once sync
            begins to view transaction history.
          </p>
        </Card>
      )}
      {activeChain === "zano" && zanoSession.syncState !== "idle" && (
        <ZanoTxHistoryCard
          syncState={zanoSession.syncState}
          txHistory={zanoSession.txHistory}
          txLoading={zanoSession.txLoading}
          onCopy={onCopy}
        />
      )}
      {activeChain === "zano" && zanoSession.syncState === "idle" && (
        <Card>
          <p className="no-wallet-msg">
            Zano session hasn't started yet. Import your Zano seed from
            the wallet dashboard, then return here once the wallet
            connects to view transaction history.
          </p>
        </Card>
      )}
      {activeChain !== "monero" && activeChain !== "zano" && (
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
