import { Card } from "../../components/PrimitivesV2";
import { piconeroToXmr } from "../../wallets/xmr-rpc";
import type { XmrTransfer } from "../../wallets/xmr-wallet";

type SyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "connection-lost"
  | "error";

/**
 * Dashboard transaction history for Monero. Renders only when an XMR
 * session is initialized (`xmrSeedLoaded` is set and sync is past
 * idle). Until sync completes, shows a "transactions appear once
 * sync finishes" placeholder; once synced, lists the most recent 50
 * transfers from `useXmrSession.txHistory`.
 *
 * Each row: direction icon + amount (in XMR), date, confirmations or
 * block height, fee for outgoing transactions, and the txid (click to
 * copy).
 */
export function XmrTxHistoryCard({
  syncState,
  txHistory,
  txLoading,
  onCopy,
}: {
  syncState: SyncState;
  txHistory: XmrTransfer[];
  txLoading: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <Card
      title="TRANSACTION HISTORY"
      right={txLoading ? <span className="gas-info">Loading…</span> : undefined}
    >
      {syncState !== "synced" ? (
        <p className="no-wallet-msg">
          Transaction history will appear once the wallet finishes syncing.
        </p>
      ) : txHistory.length === 0 ? (
        <p className="no-wallet-msg">
          No transactions yet. Incoming transfers will show up here once
          confirmed on-chain.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {txHistory.slice(0, 50).map((tx) => {
            const isIn = tx.type === "in" || tx.type === "pool";
            const pending =
              tx.type === "pending" ||
              tx.type === "pool" ||
              tx.confirmations === 0;
            const amountXmr = piconeroToXmr(tx.amount);
            const feeXmr = tx.fee ? piconeroToXmr(tx.fee) : null;
            const date = tx.timestamp
              ? new Date(tx.timestamp * 1000).toLocaleString()
              : "—";
            return (
              <div
                key={`${tx.txid}-${tx.type}`}
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
                  <span style={{ color: isIn ? "#66cc66" : "#ff9966" }}>
                    {isIn ? "▼ Received" : "▲ Sent"}
                    {pending && " (pending)"}
                    {tx.type === "failed" && " (failed)"}
                  </span>
                  <span style={{ fontWeight: "bold" }}>
                    {isIn ? "+" : "-"}
                    {amountXmr} XMR
                  </span>
                </div>
                <div
                  className="gas-info"
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>{date}</span>
                  <span>
                    {tx.confirmations > 0
                      ? `${tx.confirmations} conf`
                      : tx.height > 0
                      ? `block ${tx.height.toLocaleString()}`
                      : "unconfirmed"}
                    {feeXmr && !isIn && ` · fee ${feeXmr}`}
                  </span>
                </div>
                <code
                  className="gas-info"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "0.75em",
                  }}
                  title={tx.txid}
                  onClick={() => onCopy(tx.txid)}
                >
                  {tx.txid}
                </code>
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
