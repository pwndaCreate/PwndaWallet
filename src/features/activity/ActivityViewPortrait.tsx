import { useMemo, useState } from "react";
import { ST } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import { getAdapter } from "../../wallets";
import { txDisplayTicker } from "../../wallets/tx-display";
import { coinMarkFor } from "../../wallets/stablecoins";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { dedupeTxRows, txRowKey } from "../../wallets/tx-row-key";
import type { ChainTx, ChainType } from "../../wallets";
import { TxDetailsSheet } from "./TxDetails";
import { HistoryStatusLine } from "./HistoryStatusLine";
import { chainHistoryStatuses, summarizeHistoryStatus } from "./historyStatus";
import { chainAddresses, compareTxNewestFirst } from "./useTxHistory";
import { fmtRelative } from "../../utils/format";
import { openExternal } from "../../utils/openExternal";
import { txFilterSide, txIsMeaningful } from "./txFilters";
import {
  computeDriftFraction,
  driftTone,
  formatActualReceived,
  formatDriftPercent,
  swapStatusLabel,
  SWAP_ROW_OPEN_STYLE,
  SwapDetailsModal,
  swapRowOpenProps,
  type SwapHistoryEntry,
} from "../swap";
import {
  dedupChainTxsAgainstSwaps,
  swapEntryTimestamp,
  swapHashSet,
  useSwapHistory,
} from "./swap-history-merge";

/**
 * Portrait variant of the activity tab — clean vertical list, one row
 * per transaction, matching the v2 design mock (dropin
 * `view-misc.jsx::PortraitActivity`). The landscape ActivityView keeps
 * its multi-column table because the wider canvas earns it.
 */

type DirectionFilter = "all" | "sent" | "received" | "swaps";
type AmountFilter = "meaningful" | "all";

function truncatePeer(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-3)}`;
}

export function ActivityViewPortrait({
  txByChain,
  loading,
  errors,
  chainsOwned,
  addressByChain,
  pricesByTicker,
  zphStats,
}: {
  txByChain: Record<string, ChainTx[]>;
  loading?: Record<string, boolean>;
  errors?: Record<string, string | null>;
  chainsOwned: ChainType[];
  addressByChain: Record<string, string>;
  /** For the details sheet's USD value. Absent → no USD shown. */
  pricesByTicker?: Record<string, number>;
  zphStats?: ZphLiveStats | null;
}) {
  const [filter, setFilter] = useState<DirectionFilter>("all");
  // T1.3 — default to MEANINGFUL so the panel doesn't open as 62 rows
  // of `+0 XRP` from third-party drops, faucets, and dust.
  const [amountFilter, setAmountFilter] = useState<AmountFilter>("meaningful");
  // The row whose details sheet is open (operator report 2026-09-30: "click
  // on transactions whether in or out and see the data on them"). A tap used
  // to open a block explorer straight away; the explorer is now one button
  // inside the details.
  const [selected, setSelected] = useState<ChainTx | null>(null);

  // Cross-chain swap history — loaded once on mount. Drives both the
  // dedup of `all`-mode chain-tx rows (suppress hashes that already
  // appear as a swap source/dest) and the rendering when
  // `filter === "swaps"`.
  const [swapHistory, reloadSwapHistory] = useSwapHistory();
  const swapHashes = useMemo(() => swapHashSet(swapHistory), [swapHistory]);
  // A swap row opens the shared swap details modal (2026-09-30).
  const [openSwapId, setOpenSwapId] = useState<string | null>(null);

  // One status per DISTINCT chain, merged across its address keys — the
  // same data path as landscape (`historyStatus.ts`, operator report
  // 2026-09-30: `chainsOwned` then repeated a UTXO chain per account
  // address, so this listed those rows once per address).
  const statuses = useMemo(
    () => chainHistoryStatuses(chainsOwned, { txByChain, loading, errors }),
    [chainsOwned, txByChain, loading, errors]
  );
  const statusSummary = useMemo(() => summarizeHistoryStatus(statuses), [statuses]);

  const allTxs = useMemo(() => {
    const out: ChainTx[] = [];
    for (const s of statuses) out.push(...s.txs);
    // Suppress chain-txs whose hash appears in a swap row (#19 dedup).
    // The swap row is the canonical representation of that hash in the
    // unified timeline; per-chain dashboards still surface it natively.
    // One row per key before rendering (2026-09-30): the rows are React keys,
    // and the operator's build listed one LTC send 7 times and one BCH receipt
    // 4 times under the same key. With duplicate keys React stopped updating
    // the list — ALL / SENT / RECEIVED changed the side panel and left the
    // rows as they were. The per-chain merge already gives one row per
    // transaction; this keeps a repeat from ever reaching the list again.
    const deduped = dedupChainTxsAgainstSwaps(dedupeTxRows(out), swapHashes);
    deduped.sort(compareTxNewestFirst);
    return deduped;
  }, [statuses, swapHashes]);

  const filteredTxs = useMemo(() => {
    let pool: ChainTx[];
    if (filter === "all") pool = allTxs;
    else if (filter === "sent") pool = allTxs.filter((t) => txFilterSide(t) === "sent");
    else if (filter === "received") pool = allTxs.filter((t) => txFilterSide(t) === "received");
    else pool = [];
    if (amountFilter === "meaningful") pool = pool.filter(txIsMeaningful);
    return pool;
  }, [allTxs, filter, amountFilter]);
  const hiddenZeroCount = useMemo(() => {
    if (amountFilter !== "meaningful") return 0;
    let pool: ChainTx[];
    if (filter === "all") pool = allTxs;
    else if (filter === "sent") pool = allTxs.filter((t) => txFilterSide(t) === "sent");
    else if (filter === "received") pool = allTxs.filter((t) => txFilterSide(t) === "received");
    else pool = [];
    return pool.filter((t) => !txIsMeaningful(t)).length;
  }, [allTxs, filter, amountFilter]);

  const loadingAny = statusSummary.loading.length > 0;
  const unreadable =
    statusSummary.unavailable.length + statusSummary.failures.reduce((n, f) => n + f.chains.length, 0);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        animation: "fade-in .2s ease",
        padding: "4px 2px",
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 2,
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
        }}
      >
        <ST>activity</ST>
      </div>
      <div
        style={{
          fontSize: 22,
          color: "var(--white)",
          fontWeight: 600,
          marginTop: 4,
          fontFamily: "var(--font-mono)",
        }}
      >
        <ST speed={18} delay={100}>
          {`${filteredTxs.length} ${filteredTxs.length === 1 ? "transaction" : "transactions"}`}
        </ST>
      </div>

      <div style={{ display: "flex", gap: 6, margin: "16px 0", flexWrap: "wrap" }}>
        {(["all", "sent", "received", "swaps"] as const).map((f) => {
          const active = filter === f;
          return (
            <button
              key={f}
              className="qbtn"
              onClick={() => setFilter(f)}
              style={{
                fontSize: 9.5,
                padding: "5px 10px",
                letterSpacing: 1,
                textTransform: "uppercase",
                borderColor: active ? "var(--accent-mid)" : "var(--border)",
                color: active ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              {f}
            </button>
          );
        })}
        <span style={{ width: 6 }} />
        {/* T1.3 — hide-zero toggle. Default ON. */}
        <button
          type="button"
          className="qbtn"
          onClick={() =>
            setAmountFilter(amountFilter === "meaningful" ? "all" : "meaningful")
          }
          title={
            amountFilter === "meaningful"
              ? "Currently hiding zero-amount transactions. Click to show all."
              : "Currently showing all transactions, including zero-amount."
          }
          style={{
            fontSize: 9.5,
            padding: "5px 10px",
            letterSpacing: 1,
            textTransform: "uppercase",
            borderColor:
              amountFilter === "meaningful" ? "var(--accent-mid)" : "var(--border)",
            color:
              amountFilter === "meaningful" ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          {amountFilter === "meaningful" ? "hide zero" : "show zero"}
        </button>
      </div>

      {/* Per chain, by name and reason (`historyStatus.ts`, operator report
          2026-09-30); was "N of M chain explorers unreachable" whatever had
          happened. T1.3 kept: failures stay in the dim tone here. */}
      <HistoryStatusLine
        summary={statusSummary}
        failureTone="var(--text-dim)"
        style={{ display: "block", marginBottom: 10 }}
      />

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
        }}
      >
        {filter === "swaps" ? (
          swapHistory.length === 0 ? (
            <EmptyRow msg="No cross-chain swaps yet. Visit the Swap tab to make one." />
          ) : (
            // Sort newest-first by completedAt or createdAt.
            [...swapHistory]
              .sort((a, b) => swapEntryTimestamp(b) - swapEntryTimestamp(a))
              .slice(0, 100)
              .map((s, i, arr) => (
                <SwapRow
                  key={s.id}
                  swap={s}
                  last={i === arr.length - 1}
                  onOpen={() => setOpenSwapId(s.id)}
                />
              ))
          )
        ) : filteredTxs.length === 0 ? (
          <EmptyRow
            msg={
              chainsOwned.length === 0
                ? "No wallets loaded."
                : loadingAny
                  ? "Fetching transactions…"
                  : amountFilter === "meaningful" && hiddenZeroCount > 0
                    ? `No meaningful transactions yet. ${hiddenZeroCount} zero-amount tx hidden — click "show zero" to view.`
                    : unreadable > 0 && allTxs.length === 0
                      ? "No transactions loaded. History could not be read for some chains — see above."
                      : "No transactions found."
            }
          />
        ) : (
          filteredTxs.slice(0, 100).map((tx, i, arr) => {
            const isLast = i === arr.length - 1;
            return (
              <TxRow
                key={txRowKey(tx)}
                tx={tx}
                last={isLast}
                onSelect={setSelected}
              />
            );
          })
        )}
      </div>

      {selected && (
        <TxDetailsSheet
          tx={selected}
          ownAddress={addressByChain[selected.chain]}
          ownAddresses={chainAddresses(txByChain, selected.chain)}
          pricesByTicker={pricesByTicker}
          zphStats={zphStats}
          onClose={() => setSelected(null)}
        />
      )}

      {/* The shared swap details modal (2026-09-30), opened by a SWAPS row. */}
      <SwapDetailsModal
        entry={openSwapId ? swapHistory.find((s) => s.id === openSwapId) ?? null : null}
        onClose={() => setOpenSwapId(null)}
        onHistoryChanged={reloadSwapHistory}
      />
    </div>
  );
}

function TxRow({
  tx,
  last,
  onSelect,
}: {
  tx: ChainTx;
  last: boolean;
  onSelect: (tx: ChainTx) => void;
}) {
  const adapter = getAdapter(tx.chain);
  const isIn = tx.direction === "in";
  const failed = tx.direction === "failed";
  const self = tx.direction === "self";
  const pending =
    tx.direction === "pending" ||
    (tx.confirmations !== undefined && tx.confirmations === 0);
  const directionLabel = failed
    ? "✗ failed"
    : isIn
      ? "▼ received"
      : self
        ? "⟲ to yourself"
        : tx.direction === "pending"
          ? tx.height
            ? "◌ transfer"
            : "◌ pending"
          : "▲ sent";
  const directionColor = isIn
    ? "var(--accent)"
    : failed
      ? "var(--danger)"
      : "var(--warn)";
  const peer = truncatePeer(tx.hash);
  const confLabel =
    tx.confirmations !== undefined && tx.confirmations > 0
      ? `${tx.confirmations} conf`
      : pending
        ? "pending"
        : "—";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(tx)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(tx);
        }
      }}
      title={`${tx.hash}\nClick for details`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderBottom: last ? "none" : "1px solid var(--border-soft)",
        cursor: "pointer",
        transition: "background .12s ease",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "rgba(255,255,255,0.02)")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {/* A USD₮0 row keeps the USD₮0 mark (2026-10-06), as in landscape. */}
      <CoinIcon sym={coinMarkFor(tx.chain, txDisplayTicker(tx, adapter.ticker))} size={22} glow={false} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            color: directionColor,
            letterSpacing: 0.3,
            fontFamily: "var(--font-mono)",
          }}
        >
          {directionLabel}
        </div>
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            marginTop: 2,
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {peer} · {confLabel}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div
          className="tnum"
          style={{
            fontSize: 11,
            color: isIn
              ? "var(--accent)"
              : failed
                ? "var(--danger)"
                : "var(--text)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {isIn ? "+" : failed || self || tx.direction === "pending" ? "" : "−"}
          {tx.amount || "—"} {txDisplayTicker(tx, adapter.ticker)}
        </div>
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            marginTop: 1,
            fontFamily: "var(--font-mono)",
          }}
        >
          {fmtRelative(tx.timestamp)}
        </div>
      </div>
    </div>
  );
}

function EmptyRow({ msg }: { msg: string }) {
  return (
    <div
      style={{
        padding: 28,
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-dim)",
      }}
    >
      {msg}
    </div>
  );
}

/**
 * Cross-chain swap row for the portrait Activity tab. Different visual
 * shape from `TxRow` because the source→dest hash pair + drift
 * indicator doesn't fit cleanly in the single-line TxRow layout.
 * Drift chip is hidden when `actualReceived` is undefined (historical
 * entries / in-flight swaps / SwapKit responses without a settled-
 * amount field).
 */
function SwapRow({
  swap,
  last,
  onOpen,
}: {
  swap: SwapHistoryEntry;
  last: boolean;
  /** Opens the swap's details (2026-09-30). */
  onOpen: () => void;
}) {
  const ts = swapEntryTimestamp(swap);
  const actualDisplay = formatActualReceived(swap.actualReceived, swap.toAsset);
  const drift = computeDriftFraction(swap.toAmount, actualDisplay ?? undefined);
  const tone = driftTone(drift);
  const driftText = formatDriftPercent(drift);
  const toneColor =
    tone === "neutral"
      ? "var(--text-dim)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "bad"
          ? "var(--danger)"
          : "var(--text-dim)";
  const statusColor =
    swap.failureReason
      ? "var(--text-dim)"
      : swap.status === "success"
        ? "var(--success)"
        : swap.status === "pending"
          ? "var(--warn)"
          : "var(--danger)";
  const shorten = (h: string) =>
    h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
  return (
    <div
      {...swapRowOpenProps(onOpen, "rgba(0,204,102,0.02)")}
      style={{
        padding: "12px 14px",
        borderBottom: last ? "none" : "1px solid var(--border)",
        background: "rgba(0,204,102,0.02)",
        ...SWAP_ROW_OPEN_STYLE,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
        }}
      >
        <span
          style={{
            fontSize: 8,
            color: "var(--accent)",
            border: "1px solid var(--accent)",
            padding: "1px 5px",
            letterSpacing: 0.8,
          }}
        >
          SWAP
        </span>
        <span style={{ color: "var(--text)" }}>
          {swap.fromAsset} → {swap.toAsset}
        </span>
        <span style={{ color: "var(--text-dim)" }}>·</span>
        <span style={{ color: "var(--text)" }}>
          {swap.fromAmount} → {actualDisplay ?? swap.toAmount}
          {actualDisplay && actualDisplay !== swap.toAmount && (
            <span style={{ color: "var(--text-dim)", fontSize: 10, marginLeft: 4 }}>
              (quote: {swap.toAmount})
            </span>
          )}
        </span>
        {tone && (
          <span
            style={{
              fontSize: 9,
              color: toneColor,
              border: `1px solid ${toneColor}`,
              padding: "1px 5px",
            }}
            title={`Drift: actual ${actualDisplay} vs quote ${swap.toAmount}`}
          >
            {driftText}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
          {fmtRelative(ts)}
        </span>
        <span
          style={{
            fontSize: 9,
            color: statusColor,
            padding: "1px 5px",
            border: `1px solid ${statusColor}`,
          }}
        >
          {swapStatusLabel(swap)}
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          color: "var(--text-dim)",
        }}
      >
        {swap.provider && (
          <>
            <span>{swap.provider}</span>
            <span>·</span>
          </>
        )}
        {/* Guarded like the dest chip below. A desk swap in ACCEPTED has not
            locked anything yet, so sourceTxHash is "" and this rendered a dead
            "source:" label over an empty <code> that copied the empty string.
            NOTE: this markup exists in THREE parallel Activity views
            (ActivityView / ActivityViewPortrait / ActivityLandscapeView) -
            fix all three together. */}
        {swap.sourceTxHash && (
          <span
            style={{ cursor: "pointer" }}
            title={`${swap.sourceTxHash}\n(click: open in explorer · shift-click: copy)`}
            onClick={(e) => {
              e.stopPropagation(); // the row behind opens the details
              if (e.shiftKey) {
                void navigator.clipboard.writeText(swap.sourceTxHash);
                return;
              }
              if (swap.sourceExplorerUrl) void openExternal(swap.sourceExplorerUrl);
              else void navigator.clipboard.writeText(swap.sourceTxHash);
            }}
          >
            source: <code>{shorten(swap.sourceTxHash)}</code>
          </span>
        )}
        {swap.destTxHash && (
          <>
            <span>→</span>
            <span
              style={{ cursor: "pointer" }}
              title={`${swap.destTxHash}\n(click: open in explorer · shift-click: copy)`}
              onClick={(e) => {
                e.stopPropagation(); // the row behind opens the details
                if (e.shiftKey) {
                  void navigator.clipboard.writeText(swap.destTxHash ?? "");
                  return;
                }
                if (swap.destExplorerUrl) void openExternal(swap.destExplorerUrl);
                else void navigator.clipboard.writeText(swap.destTxHash ?? "");
              }}
            >
              dest: <code>{shorten(swap.destTxHash)}</code>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
