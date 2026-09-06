import { Card } from "../../components/PrimitivesV2";
import { atomicToZano, type ZanoTransferEntry } from "../../wallets/zano-rpc";

type SyncState = "idle" | "starting" | "ready" | "error";

/**
 * Dashboard transaction history for Zano. Structural parallel to
 * `XmrTxHistoryCard`, with one honest gap carried through from
 * `zano-rpc.ts::getRecentTransfers`: the per-entry field shape is INFERRED
 * from docs, not verified against a real transaction (no funded wallet was
 * available during this integration — broadcasting one is a funds-moving
 * action). No confirmations count is rendered because none was confirmed to
 * exist in the real response; only block height, which was.
 */
export function ZanoTxHistoryCard({
  syncState,
  txHistory,
  txLoading,
  onCopy,
}: {
  syncState: SyncState;
  txHistory: ZanoTransferEntry[];
  txLoading: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <Card
      title="TRANSACTION HISTORY"
      right={txLoading ? <span className="gas-info">Loading…</span> : undefined}
    >
      {syncState !== "ready" ? (
        <p className="no-wallet-msg">
          Transaction history will appear once the wallet connects.
        </p>
      ) : txHistory.length === 0 ? (
        <p className="no-wallet-msg">
          No transactions yet. Incoming transfers will show up here once
          confirmed on-chain.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {txHistory.slice(0, 50).map((tx, i) => {
            // `ZanoTransferEntry` carries an assetId but not that asset's
            // own decimal count (unlike `ZanoAssetBalance`, which embeds
            // `asset_info.decimal_point`) — the unverified history RPC shape
            // doesn't confirm one exists per-entry. Native ZANO's 12 is
            // verified; a non-native asset here would be mislabeled until
            // that shape is confirmed against a real transaction.
            const amount = atomicToZano(tx.amount, 12);
            const date = tx.timestamp
              ? new Date(tx.timestamp * 1000).toLocaleString()
              : "—";
            return (
              <div
                key={tx.txHash ?? `zano-tx-${i}`}
                style={{
                  borderTop: "1px solid #222",
                  paddingTop: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ color: tx.isIncome ? "#66cc66" : "#ff9966" }}>
                    {tx.isIncome ? "▼ Received" : "▲ Sent"}
                  </span>
                  <span style={{ fontWeight: "bold" }}>
                    {/* An amount the daemon did not give us must not render as
                        a signed number. "-0 ZANO" over a real received
                        transfer is what this replaces (2026-09-04) — it reads
                        as a fact, and the one thing it cannot be is the
                        truth. */}
                    {tx.amountUnknown ? (
                      <span
                        style={{ color: "var(--muted, #888)" }}
                        title="The wallet RPC returned this transfer without a readable amount. The transaction is real; only its value is unavailable."
                      >
                        amount unavailable
                      </span>
                    ) : (
                      <>
                        {tx.isIncome ? "+" : "-"}
                        {amount} ZANO
                      </>
                    )}
                  </span>
                </div>
                <div
                  className="gas-info"
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>{date}</span>
                  <span>
                    {tx.height > 0 ? `block ${tx.height.toLocaleString()}` : "unconfirmed"}
                  </span>
                </div>
                {tx.txHash && (
                  <code
                    className="gas-info"
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "0.75em",
                    }}
                    title={tx.txHash}
                    onClick={() => onCopy(tx.txHash!)}
                  >
                    {tx.txHash}
                  </code>
                )}
              </div>
            );
          })}
          {txHistory.length > 50 && (
            <div className="gas-info" style={{ marginTop: 4 }}>
              Showing 50 of {txHistory.length} transactions.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
