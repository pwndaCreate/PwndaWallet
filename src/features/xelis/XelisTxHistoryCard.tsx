import { Card } from "../../components/PrimitivesV2";
import type { XelisTransferEntry } from "../../wallets/xelis-rpc";
import type { XelisSyncState } from "./useXelisSession";
import { xelisTransferRow } from "./xelisDisplay";

const MAX_ROWS = 50;

/**
 * Xelis transaction history. Counterpart of `ZanoTxHistoryCard`, shared by
 * portrait `WalletTxHistorySubview` and landscape `LandscapeRoot`
 * (`xelisCenterSlot`).
 *
 * "No transactions yet" is said only after a read has SUCCEEDED and come back
 * empty. `txHistory` is null until then, and a failed read says it failed.
 */
export function XelisTxHistoryCard({
  syncState,
  txHistory,
  txLoading,
  txError,
  onCopy,
}: {
  syncState: XelisSyncState;
  txHistory: XelisTransferEntry[] | null;
  txLoading: boolean;
  txError: string | null;
  onCopy: (text: string) => void;
}) {
  const connected = syncState === "syncing" || syncState === "synced";
  const rows = (txHistory ?? []).slice(0, MAX_ROWS).map((e, i) => xelisTransferRow(e, i));

  let message: string | null = null;
  if (!connected) {
    message = "Transaction history appears once the wallet connects.";
  } else if (txHistory === null) {
    message = txError
      ? `Transaction history could not be read: ${txError}`
      : syncState === "syncing"
        ? "Transaction history appears once the wallet has scanned the chain."
        : "Loading transaction history…";
  } else if (txHistory.length === 0) {
    message = txError
      ? `Transaction history could not be read: ${txError}`
      : "No transactions yet. Transfers show up here once the wallet has seen them on chain.";
  }

  return (
    <Card
      title="TRANSACTION HISTORY"
      right={txLoading ? <span className="gas-info">Loading…</span> : undefined}
    >
      {message ? (
        <p className="no-wallet-msg" data-xelis-history="message">
          {message}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-xelis-history="list">
          {txError && (
            <div className="gas-info" style={{ color: "var(--warn)" }}>
              Refreshing failed, so this is the last list the wallet returned: {txError}
            </div>
          )}
          {rows.map((row) => (
            <div
              key={row.key}
              style={{
                borderTop: "1px solid #222",
                paddingTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span
                  style={{
                    color:
                      row.direction === "in"
                        ? "#66cc66"
                        : row.direction === "out"
                          ? "#ff9966"
                          : "var(--text-dim)",
                  }}
                >
                  {row.direction === "in" ? "▼ " : row.direction === "out" ? "▲ " : "• "}
                  {row.label}
                </span>
                <span style={{ fontWeight: "bold" }}>{row.amount}</span>
              </div>
              <div className="gas-info" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{row.when}</span>
                <span>{row.where}</span>
              </div>
              {row.fee && <div className="gas-info">{row.fee}</div>}
              <code
                className="gas-info"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.75em",
                  cursor: "copy",
                }}
                title={row.hash}
                onClick={() => onCopy(row.hash)}
              >
                {row.hash}
              </code>
            </div>
          ))}
          {txHistory && txHistory.length > MAX_ROWS && (
            <div className="gas-info" style={{ marginTop: 4 }}>
              Showing {MAX_ROWS} of {txHistory.length} transactions.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
