/**
 * One transaction's details, opened from a wallet's own history (operator
 * request, 2026-10-01): "In each respective asset in the wallet under the
 * recent subheader … click on each given recent transaction … and a mini
 * window or panel appears with the transaction details".
 *
 * The wallet feature may not import Activity's files (BOUNDARIES.md: only
 * `useTxHistory`), so the shells that mount the wallet views hold the open
 * transaction and render the details: `LandscapeRoot` as a centred window,
 * `ViewRouter` as portrait's bottom sheet. The wallet views and the history
 * cards only call `onOpenTx`. Same details component as Activity
 * (`TxDetails`), so a transaction reads the same wherever it is opened.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ChainTx } from "../../wallets";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { TxDetailsSheet } from "./TxDetails";
import { chainAddresses } from "./useTxHistory";

export interface TxDetailsWindowOptions {
  placement: "sheet" | "window";
  /** False when the surface that opened it is no longer shown (another tab
   *  or view): the details close, and do not come back with it. */
  visible: boolean;
  addressByChain: Record<string, string>;
  /** `useTxHistory`'s per-`chain:address` rows; their keys are the wallet's
   *  addresses on each chain, which the details mark as "you". */
  txByChain: Record<string, unknown>;
  pricesByTicker?: Record<string, number>;
  zphStats?: ZphLiveStats | null;
}

export function useTxDetailsWindow({
  placement,
  visible,
  addressByChain,
  txByChain,
  pricesByTicker,
  zphStats,
}: TxDetailsWindowOptions): { open: (tx: ChainTx) => void; element: ReactNode } {
  const [tx, setTx] = useState<ChainTx | null>(null);
  const open = useCallback((t: ChainTx) => setTx(t), []);
  const close = useCallback(() => setTx(null), []);
  useEffect(() => {
    if (!visible) setTx(null);
  }, [visible]);
  const element =
    tx && visible ? (
      <TxDetailsSheet
        key={`${tx.chain}:${tx.hash}`}
        tx={tx}
        placement={placement}
        ownAddress={addressByChain[tx.chain]}
        ownAddresses={chainAddresses(txByChain, tx.chain)}
        pricesByTicker={pricesByTicker}
        zphStats={zphStats}
        onClose={close}
      />
    ) : null;
  return { open, element };
}
