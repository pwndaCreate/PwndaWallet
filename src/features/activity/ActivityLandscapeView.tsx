import { useMemo, useState } from "react";
import { ST } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import { getAdapter } from "../../wallets";
import { txDisplayTicker, txUsdPrice } from "../../wallets/tx-display";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { txRowKey } from "../../wallets/tx-row-key";
import type { ChainTx, ChainType } from "../../wallets";
import { TxDetails } from "./TxDetails";
import { HistoryStatusLine } from "./HistoryStatusLine";
import { chainHistoryStatuses, summarizeHistoryStatus } from "./historyStatus";
import { chainAddresses, compareTxNewestFirst } from "./useTxHistory";
import { fmtRelative } from "../../utils/format";
import { openExternal } from "../../utils/openExternal";
import {
  computeDriftFraction,
  driftTone,
  formatActualReceived,
  formatDriftPercent,
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
 * Landscape activity view — v2 design.
 *
 * Two columns: left = filterable transaction table, right = selected-tx
 * detail panel. Mirrors `view-landscape-extras.jsx::LandscapeActivity`.
 *
 * `pricesByTicker` is consumed for per-row USD value and the
 * in/out/net totals at the top. Tickers without a price simply
 * contribute 0 to the totals — the rows still render.
 */

type Filter = "all" | "sent" | "received" | "swaps";

function truncMiddle(s: string, head = 8, tail = 6): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function fmtUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 1000) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${usd.toFixed(2)}`;
}

export interface ActivityLandscapeViewProps {
  txByChain: Record<string, ChainTx[]>;
  loading?: Record<string, boolean>;
  errors?: Record<string, string | null>;
  chainsOwned: ChainType[];
  addressByChain: Record<string, string>;
  pricesByTicker: Record<string, number>;
  /** Zephyr oracle prices, for ZEPHUSD/ZEPHRSV/ZEPHYRS rows. Absent → those
   *  rows show no USD value (never ZEPH's price). */
  zphStats?: ZphLiveStats | null;
}

export function ActivityLandscapeView({
  txByChain,
  loading,
  errors,
  chainsOwned,
  addressByChain,
  pricesByTicker,
  zphStats,
}: ActivityLandscapeViewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Cross-chain swap history — drives both the dedup of `all`-mode
  // chain-tx rows and the `swaps` filter's rendering.
  const [swapHistory, reloadSwapHistory] = useSwapHistory();
  const swapHashes = useMemo(() => swapHashSet(swapHistory), [swapHistory]);
  // A swap row opens the shared swap details modal (2026-09-30).
  const [openSwapId, setOpenSwapId] = useState<string | null>(null);

  // One status per DISTINCT chain, its rows merged across every address key
  // (`historyStatus.ts`, operator report 2026-09-30). This read one key per
  // entry of `chainsOwned`, which then repeated a UTXO chain once per account
  // address — so each of those rows was listed once per address — and it only
  // ever read the LAST address `addressByChain` held for the chain.
  const statuses = useMemo(
    () => chainHistoryStatuses(chainsOwned, { txByChain, loading, errors }),
    [chainsOwned, txByChain, loading, errors]
  );
  const statusSummary = useMemo(() => summarizeHistoryStatus(statuses), [statuses]);

  // Flatten + dedup against swap hashes + sort newest-first.
  const allTxs = useMemo(() => {
    const out: ChainTx[] = [];
    for (const s of statuses) out.push(...s.txs);
    const deduped = dedupChainTxsAgainstSwaps(out, swapHashes);
    deduped.sort(compareTxNewestFirst);
    return deduped;
  }, [statuses, swapHashes]);

  const filtered = useMemo(() => {
    if (filter === "all") return allTxs;
    if (filter === "sent")
      return allTxs.filter(
        (t) => t.direction === "out" || t.direction === "pending"
      );
    if (filter === "received") return allTxs.filter((t) => t.direction === "in");
    // Swap filter is handled separately in the render branch — return
    // an empty chain-tx array here so the existing tx-rendering path
    // doesn't try to display swap rows.
    return [];
  }, [allTxs, filter]);

  const sortedSwapHistory = useMemo(
    () =>
      [...swapHistory].sort(
        (a, b) => swapEntryTimestamp(b) - swapEntryTimestamp(a)
      ),
    [swapHistory]
  );

  // Inflow / outflow / net in USD across the unfiltered set.
  const { inflowUsd, outflowUsd } = useMemo(() => {
    let inU = 0;
    let outU = 0;
    for (const tx of allTxs) {
      const a = getAdapter(tx.chain);
      // A ZEPHUSD/ZEPHRSV/ZEPHYRS row is priced from the Zephyr oracle or not
      // at all, never at ZEPH's price (2026-09-15, `txUsdPrice`).
      const price = txUsdPrice(tx, a.ticker, pricesByTicker, zphStats);
      if (!price) continue;
      const amount = parseFloat(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const usd = amount * price;
      if (tx.direction === "in") inU += usd;
      else if (tx.direction === "out" || tx.direction === "pending")
        outU += usd;
    }
    return { inflowUsd: inU, outflowUsd: outU };
  }, [allTxs, pricesByTicker, zphStats]);

  const loadingAny = statusSummary.loading.length > 0;
  const unreadable = statusSummary.unavailable.length + statusSummary.failures.reduce((n, f) => n + f.chains.length, 0);

  // Detail = the selected tx, or the first row of the filtered set. Rows are
  // identified by `txRowKey` (was chain:hash:direction, which changes as a
  // row settles and collides for two legs of one transaction).
  const detail = useMemo(() => {
    if (filtered.length === 0) return null;
    if (selectedKey) {
      const found = filtered.find((t) => txRowKey(t) === selectedKey);
      if (found) return found;
    }
    return filtered[0];
  }, [filtered, selectedKey]);

  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "1fr 380px",
        gap: 1,
        background: "var(--border)",
        minHeight: 0,
        overflow: "hidden",
        animation: "fade-in .2s ease",
      }}
    >
      {/* ── LEFT: header + filters + table ──────────────────── */}
      <div
        style={{
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 24px 0", flexShrink: 0 }}>
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
              display: "flex",
              alignItems: "baseline",
              gap: 24,
              marginTop: 4,
              flexWrap: "wrap",
            }}
          >
            <div
              className="tnum"
              style={{
                fontSize: 28,
                color: "var(--white)",
                fontWeight: 600,
                lineHeight: 1.1,
                textShadow: "0 0 16px rgba(242,242,242,0.18)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <ST speed={18} delay={80}>{`${allTxs.length}`}</ST>
              <span
                style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 8 }}
              >
                transactions
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 18,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ color: "var(--text-dim)" }}>
                in{" "}
                <span className="tnum" style={{ color: "var(--accent)" }}>
                  +{fmtUsd(inflowUsd)}
                </span>
              </span>
              <span style={{ color: "var(--text-dim)" }}>
                out{" "}
                <span className="tnum" style={{ color: "var(--warn)" }}>
                  −{fmtUsd(outflowUsd)}
                </span>
              </span>
              <span style={{ color: "var(--text-dim)" }}>
                net{" "}
                <span className="tnum" style={{ color: "var(--text)" }}>
                  {fmtUsd(inflowUsd - outflowUsd)}
                </span>
              </span>
            </div>
          </div>

          {/* filter chips */}
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 16,
              flexWrap: "wrap",
            }}
          >
            {(["all", "sent", "received", "swaps"] as const).map((f) => {
              const a = f === filter;
              return (
                <button
                  key={f}
                  onClick={() => {
                    setFilter(f);
                    setSelectedKey(null);
                  }}
                  className="qbtn"
                  style={{
                    fontSize: 10,
                    padding: "6px 12px",
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    borderColor: a ? "var(--accent-mid)" : "var(--border)",
                    color: a ? "var(--accent)" : "var(--text-muted)",
                    background: a ? "var(--accent-soft)" : "transparent",
                  }}
                >
                  {f}
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            {/* Per chain, by name and reason — was "· errors on ETH, USDT,
                USDT, USDC, …", tickers only, with NEAR's missing history
                counted as an error (operator report 2026-09-30). */}
            <HistoryStatusLine
              summary={statusSummary}
              style={{ alignSelf: "center", textAlign: "right", maxWidth: "70%" }}
            />
          </div>
        </div>

        {/* table header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "32px 90px 1fr 140px 110px 90px",
            gap: 12,
            padding: "14px 24px 8px",
            marginTop: 14,
            borderBottom: "1px solid var(--border-soft)",
            flexShrink: 0,
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 1.5,
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span></span>
          <span>type</span>
          <span>peer</span>
          <span style={{ textAlign: "right" }}>amount</span>
          <span style={{ textAlign: "right" }}>usd</span>
          <span style={{ textAlign: "right" }}>when</span>
        </div>

        {/* rows */}
        <div className="no-scroll-bar" style={{ flex: 1, overflowY: "auto" }}>
          {filter === "swaps" ? (
            sortedSwapHistory.length === 0 ? (
              <div
                style={{
                  padding: 28,
                  textAlign: "center",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--text-dim)",
                }}
              >
                No cross-chain swaps yet. Visit the Swap tab to make one.
              </div>
            ) : (
              sortedSwapHistory
                .slice(0, 100)
                .map((s) => (
                  <LandscapeSwapRow key={s.id} swap={s} onOpen={() => setOpenSwapId(s.id)} />
                ))
            )
          ) : filtered.length === 0 ? (
            <div
              style={{
                padding: 28,
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-dim)",
              }}
            >
              {chainsOwned.length === 0
                ? "No wallets loaded."
                : loadingAny
                  ? "Fetching transactions…"
                  : unreadable > 0 && allTxs.length === 0
                    ? "No transactions loaded. History could not be read for some chains — see above."
                    : "No transactions found."}
            </div>
          ) : (
            filtered.map((tx) => {
              const adapter = getAdapter(tx.chain);
              const key = txRowKey(tx);
              const a = detail ? txRowKey(detail) === key : false;
              const isIn = tx.direction === "in";
              const failed = tx.direction === "failed";
              const self = tx.direction === "self";
              const pending = tx.direction === "pending";
              const dirColor = failed
                ? "var(--danger)"
                : isIn
                  ? "var(--accent)"
                  : "var(--warn)";
              // The asset this row moved, priced as that asset: a ZEPHUSD row
              // is neither labelled nor valued as ZEPH (2026-09-15).
              const rowTicker = txDisplayTicker(tx, adapter.ticker);
              const price = txUsdPrice(tx, adapter.ticker, pricesByTicker, zphStats);
              const amountNum = parseFloat(tx.amount);
              const usd =
                price && Number.isFinite(amountNum) ? amountNum * price : null;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedKey(key)}
                  style={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "32px 90px 1fr 140px 110px 90px",
                    gap: 12,
                    padding: "12px 24px",
                    alignItems: "center",
                    background: a ? "rgba(255,255,255,0.04)" : "transparent",
                    borderLeft: a
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    borderTop: "none",
                    borderRight: "none",
                    borderBottom: "1px solid var(--border-soft)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <CoinIcon sym={rowTicker} size={22} glow={false} />
                  <span
                    style={{
                      fontSize: 10,
                      color: dirColor,
                      letterSpacing: 0.5,
                    }}
                  >
                    {failed
                      ? "✗ failed"
                      : isIn
                        ? "▼ recv"
                        : self
                          ? "⟲ self"
                          : pending
                            ? tx.height
                              ? "◌ transfer"
                              : "◌ pending"
                            : "▲ sent"}
                  </span>
                  <span
                    className="tnum"
                    style={{
                      fontSize: 11,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {truncMiddle(tx.hash, 10, 6)}
                  </span>
                  <span
                    className="tnum"
                    style={{
                      fontSize: 11,
                      color: dirColor,
                      textAlign: "right",
                    }}
                  >
                    {failed || self || pending ? "" : isIn ? "+" : "−"}
                    {tx.amount || "—"} {rowTicker}
                  </span>
                  <span
                    className="tnum"
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      textAlign: "right",
                    }}
                  >
                    {usd != null ? fmtUsd(usd) : "—"}
                  </span>
                  <span
                    className="tnum"
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim)",
                      textAlign: "right",
                    }}
                  >
                    {fmtRelative(tx.timestamp)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── RIGHT: selected tx detail ────────────────────────── */}
      <div
        className="no-scroll-bar"
        style={{
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          padding: 22,
          gap: 14,
          minHeight: 0,
          overflow: "auto",
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
          <ST>transaction</ST>
        </div>

        {/* The shared details (`TxDetails.tsx`) — portrait opens the same
            component in a sheet (operator report 2026-09-30). */}
        {detail ? (
          <TxDetails
            tx={detail}
            ownAddress={addressByChain[detail.chain]}
            ownAddresses={chainAddresses(txByChain, detail.chain)}
            pricesByTicker={pricesByTicker}
            zphStats={zphStats}
          />
        ) : (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-dim)",
              padding: 8,
            }}
          >
            Select a transaction.
          </div>
        )}
      </div>

      {/* The shared swap details modal (2026-09-30), opened by a SWAPS row. */}
      <SwapDetailsModal
        entry={openSwapId ? swapHistory.find((s) => s.id === openSwapId) ?? null : null}
        onClose={() => setOpenSwapId(null)}
        onHistoryChanged={reloadSwapHistory}
      />
    </div>
  );
}

/**
 * Cross-chain swap row for the landscape Activity tab. Renders inside
 * the same scrollable region as `ChainTx` rows but with a different
 * visual shape — the swap is a multi-attribute event (source asset,
 * destination asset, source amount, destination amount, drift, source
 * tx hash, dest tx hash, provider, status) that doesn't compress
 * cleanly into the landscape's per-tx column layout. Two-line layout
 * matches the portrait `SwapRow`.
 */
function LandscapeSwapRow({
  swap,
  onOpen,
}: {
  swap: SwapHistoryEntry;
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
    swap.status === "success"
      ? "var(--accent)"
      : swap.status === "pending"
        ? "var(--warn)"
        : "var(--danger)";
  const shorten = (h: string) =>
    h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
  return (
    <div
      {...swapRowOpenProps(onOpen, "rgba(0,204,102,0.02)")}
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
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
          fontSize: 10,
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
            <span style={{ color: "var(--text-dim)", fontSize: 9, marginLeft: 4 }}>
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
        <span style={{ color: "var(--text-dim)", fontSize: 9 }}>
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
          {swap.status}
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
