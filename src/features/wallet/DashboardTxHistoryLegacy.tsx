/**
 * DashboardTxHistoryLegacy — frozen 2026-05-16 backup of the inline
 * transaction-history rendering that used to sit underneath the
 * AccountCard on the portrait dashboard. Kept so the user can revert
 * the v2 sub-view design with a one-line swap in DashboardView.tsx:
 *
 *     // To bring back the inline-on-dashboard tx history,
 *     //  1. import { DashboardInlineTxHistory } from "./DashboardTxHistoryLegacy";
 *     //  2. Render <DashboardInlineTxHistory .../> in place of the
 *     //     "▶ Transaction history" button block.
 *     //  3. Delete the WalletTxHistorySubview branch + walletSubview
 *     //     state from DashboardView.tsx.
 *
 * The v2 behaviour replaces the inline cards with a dashboard button
 * that opens a dedicated per-asset transaction-history sub-view
 * (`WalletTxHistorySubview.tsx`). The cards themselves
 * (`XmrTxHistoryCard`, `ChainTxCard`) are unchanged — only the
 * surface they render on moved.
 */

import { XmrTxHistoryCard } from "../monero/XmrTxHistoryCard";
import { ChainTxCard } from "./ChainTxCard";
import type { ChainType, ChainTx } from "../../wallets";

type SyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "connection-lost"
  | "error";

import type { XmrTransfer } from "../../wallets/xmr-wallet";

interface XmrSlice {
  syncState: SyncState;
  txHistory: XmrTransfer[];
  txLoading: boolean;
}

export function DashboardInlineTxHistory({
  activeChain,
  walletsByChain,
  xmrSession,
  chainTxByKey,
  chainTxLoading,
  chainTxErrors,
  addressByChain,
  onCopy,
}: {
  activeChain: ChainType;
  walletsByChain: Partial<Record<ChainType, unknown>>;
  xmrSession: XmrSlice;
  chainTxByKey: Record<string, ChainTx[]>;
  chainTxLoading: Record<string, boolean>;
  chainTxErrors: Record<string, string | null>;
  addressByChain: Record<string, string>;
  onCopy: (text: string) => void;
}) {
  return (
    <>
      {/* XMR transaction history — only on the Monero panel once a
          session is initialized. */}
      {activeChain === "monero" &&
        xmrSession.syncState !== "idle" && (
          <XmrTxHistoryCard
            syncState={xmrSession.syncState}
            txHistory={xmrSession.txHistory}
            txLoading={xmrSession.txLoading}
            onCopy={onCopy}
          />
        )}

      {/* Generic per-chain tx history for everything except Monero
          (which has its own block above with sync-state UI). */}
      {activeChain !== "monero" && walletsByChain[activeChain] && (
        <ChainTxCard
          chain={activeChain}
          txs={
            chainTxByKey[
              `${activeChain}:${addressByChain[activeChain] ?? ""}`
            ] ?? []
          }
          loading={
            !!chainTxLoading[
              `${activeChain}:${addressByChain[activeChain] ?? ""}`
            ]
          }
          error={
            chainTxErrors[
              `${activeChain}:${addressByChain[activeChain] ?? ""}`
            ] ?? null
          }
        />
      )}
    </>
  );
}
