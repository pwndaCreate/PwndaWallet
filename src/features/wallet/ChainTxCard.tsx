import { Card } from "../../components/PrimitivesV2";
import { explorerTxUrl } from "../../wallets/explorers";
import type { ChainTx, ChainType } from "../../wallets";
import { getAdapter } from "../../wallets";
import { openExternal } from "../../utils/openExternal";

/**
 * Per-chain transaction history card for the portrait dashboard.
 *
 * Mirrors the XMR-specific block's vertical-list visual but works off the
 * generic `ChainTx[]` from `useTxHistory`, so every non-XMR chain
 * (BTC, ETH, SOL, RVN, CFX, …) gets its own list. XMR keeps its
 * dedicated block in App.tsx because it has additional sync-state UI
 * (waiting on monero-wallet-rpc) that doesn't apply elsewhere.
 *
 * Click-to-explorer behaviour matches the landscape ActivityView:
 *   - click txid → open in chain explorer (or fall back to copy)
 *   - shift-click txid → copy
 */

export function ChainTxCard({
  chain,
  txs,
  loading,
  error,
}: {
  chain: ChainType;
  txs: ChainTx[];
  loading: boolean;
  error: string | null;
}) {
  const adapter = getAdapter(chain);

  return (
    <Card
      title="TRANSACTION HISTORY"
      right={loading ? <span className="gas-info">Loading…</span> : undefined}
    >
      {error && txs.length === 0 ? (
        <p className="no-wallet-msg" style={{ color: "#ff9966" }}>
          Couldn't fetch {adapter.ticker} transactions: {error}
        </p>
      ) : txs.length === 0 ? (
        <p className="no-wallet-msg">
          No transactions yet. Incoming and outgoing transfers will show
          up here once they appear on-chain.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {txs.slice(0, 50).map((tx) => {
            const isIn = tx.direction === "in";
            const failed = tx.direction === "failed";
            const pending =
              tx.direction === "pending" ||
              (tx.confirmations !== undefined && tx.confirmations === 0);
            const date = tx.timestamp
              ? new Date(tx.timestamp * 1000).toLocaleString()
              : "—";
            return (
              <div
                key={`${tx.hash}-${tx.direction}`}
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
                  <span style={{
                    color: failed ? "#ff6666"
                      : isIn ? "#66cc66"
                      : "#ff9966",
                  }}>
                    {failed ? "✗ Failed"
                      : isIn ? "▼ Received"
                      : "▲ Sent"}
                    {pending && !failed && " (pending)"}
                  </span>
                  <span style={{ fontWeight: "bold" }}>
                    {isIn ? "+" : "-"}
                    {tx.amount} {adapter.ticker}
                  </span>
                </div>
                <div
                  className="gas-info"
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>{date}</span>
                  <span>
                    {tx.confirmations !== undefined && tx.confirmations > 0
                      ? `${tx.confirmations} conf`
                      : tx.height
                      ? `block ${tx.height.toLocaleString()}`
                      : pending ? "unconfirmed" : ""}
                    {tx.fee && !isIn && ` · fee ${tx.fee}`}
                  </span>
                </div>
                <code
                  className="gas-info"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "0.75em",
                    cursor: "pointer",
                  }}
                  title={`${tx.hash}\nClick: open in explorer · Shift-click: copy`}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      void navigator.clipboard.writeText(tx.hash);
                      return;
                    }
                    const url = explorerTxUrl(chain, tx.hash);
                    if (url) void openExternal(url);
                    else void navigator.clipboard.writeText(tx.hash);
                  }}
                >
                  {tx.hash}
                </code>
              </div>
            );
          })}
          {txs.length > 50 && (
            <div className="gas-info" style={{ marginTop: 4 }}>
              Showing 50 of {txs.length} transactions.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
