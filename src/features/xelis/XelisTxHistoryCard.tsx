import { Card } from "../../components/PrimitivesV2";
import { openableRowProps } from "../../components/openableRow";
import type { ChainTx } from "../../wallets/types";
import type { XelisTransferEntry } from "../../wallets/xelis-rpc";
import { xelisTransfersToChainTx } from "../../wallets/xelis-wallet";
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
 *
 * With `onOpenTx`, a row opens its transaction's details, as the row
 * Activity shows (`xelisTransfersToChainTx`), 2026-10-01.
 */
export function XelisTxHistoryCard({
  syncState,
  txHistory,
  txLoading,
  txError,
  onCopy,
  onOpenTx,
}: {
  syncState: XelisSyncState;
  txHistory: XelisTransferEntry[] | null;
  txLoading: boolean;
  txError: string | null;
  onCopy: (text: string) => void;
  onOpenTx?: (tx: ChainTx) => void;
}) {
  const connected = syncState === "syncing" || syncState === "synced";
  const entries = (txHistory ?? []).slice(0, MAX_ROWS);
  const rows = entries.map((e, i) => xelisTransferRow(e, i));
  // Same order as `rows`: one mapping per entry, made only when opened.
  const openFor = (i: number) =>
    onOpenTx ? () => onOpenTx(xelisTransfersToChainTx([entries[i]])[0]) : undefined;

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
          {rows.map((row, i) => (
            <div
              key={row.key}
              {...openableRowProps(openFor(i))}
              style={{
                borderTop: "1px solid #222",
                paddingTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                cursor: onOpenTx ? "pointer" : undefined,
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
                title={`${row.hash}\nClick: copy`}
                onClick={(e) => {
                  // Copies; does not also open the row's details.
                  e.stopPropagation();
                  onCopy(row.hash);
                }}
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
