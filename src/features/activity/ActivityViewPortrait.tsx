import { useMemo, useState } from "react";
import { ST } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import { getAdapter } from "../../wallets";
import { explorerTxUrl } from "../../wallets/explorers";
import type { ChainTx, ChainType } from "../../wallets";
import { fmtRelative } from "../../utils/format";
import { openExternal } from "../../utils/openExternal";
import { txIsMeaningful } from "./txFilters";
import {
  computeDriftFraction,
  driftTone,
  formatActualReceived,
  formatDriftPercent,
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
}: {
  txByChain: Record<string, ChainTx[]>;
  loading?: Record<string, boolean>;
  errors?: Record<string, string | null>;
  chainsOwned: ChainType[];
  addressByChain: Record<string, string>;
}) {
  const [filter, setFilter] = useState<DirectionFilter>("all");
  // T1.3 — default to MEANINGFUL so the panel doesn't open as 62 rows
  // of `+0 XRP` from third-party drops, faucets, and dust.
  const [amountFilter, setAmountFilter] = useState<AmountFilter>("meaningful");
  // UXS-20260516-106: when many chains fail, the inline comma-list
  // becomes unreadable (and the ETH ticker repeats across arbitrum /
  // base / optimism, looking like a bug). Default to a summarized
  // chip; let the user expand to see the deduplicated full list.
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  // Cross-chain swap history — loaded once on mount. Drives both the
  // dedup of `all`-mode chain-tx rows (suppress hashes that already
  // appear as a swap source/dest) and the rendering when
  // `filter === "swaps"`.
  const [swapHistory] = useSwapHistory();
  const swapHashes = useMemo(() => swapHashSet(swapHistory), [swapHistory]);

  const allTxs = useMemo(() => {
    const out: ChainTx[] = [];
    for (const c of chainsOwned) {
      const k = `${c}:${addressByChain[c] ?? ""}`;
      const list = txByChain[k] ?? [];
      out.push(...list);
    }
    // Suppress chain-txs whose hash appears in a swap row (#19 dedup).
    // The swap row is the canonical representation of that hash in the
    // unified timeline; per-chain dashboards still surface it natively.
    const deduped = dedupChainTxsAgainstSwaps(out, swapHashes);
    deduped.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return deduped;
  }, [chainsOwned, txByChain, addressByChain, swapHashes]);

  const filteredTxs = useMemo(() => {
    let pool: ChainTx[];
    if (filter === "all") pool = allTxs;
    else if (filter === "sent")
      pool = allTxs.filter((t) => t.direction === "out" || t.direction === "pending");
    else if (filter === "received") pool = allTxs.filter((t) => t.direction === "in");
    else pool = [];
    if (amountFilter === "meaningful") pool = pool.filter(txIsMeaningful);
    return pool;
  }, [allTxs, filter, amountFilter]);
  const hiddenZeroCount = useMemo(() => {
    if (amountFilter !== "meaningful") return 0;
    let pool: ChainTx[];
    if (filter === "all") pool = allTxs;
    else if (filter === "sent")
      pool = allTxs.filter((t) => t.direction === "out" || t.direction === "pending");
    else if (filter === "received") pool = allTxs.filter((t) => t.direction === "in");
    else pool = [];
    return pool.filter((t) => !txIsMeaningful(t)).length;
  }, [allTxs, filter, amountFilter]);

  const errorChains = useMemo(
    () => chainsOwned.filter((c) => errors?.[`${c}:${addressByChain[c] ?? ""}`]),
    [chainsOwned, errors, addressByChain]
  );
  const loadingChains = useMemo(
    () => chainsOwned.filter((c) => loading?.[`${c}:${addressByChain[c] ?? ""}`]),
    [chainsOwned, loading, addressByChain]
  );
  // Deduplicate by ticker so ETH on mainnet + ETH on arbitrum + ETH on
  // base + ETH on optimism collapse to a single "ETH" entry (the
  // story called out 4 repeated ETH entries as confusing).
  const errorTickers = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const c of errorChains) {
      const t = getAdapter(c).ticker;
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    }
    return order;
  }, [errorChains]);
  const loadingTickers = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const c of loadingChains) {
      const t = getAdapter(c).ticker;
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    }
    return order;
  }, [loadingChains]);
  const totalOwned = chainsOwned.length;
  // Inline list only when ≤ 5 distinct tickers; otherwise summary chip
  // with a [show] / [hide] toggle.
  const ERROR_INLINE_THRESHOLD = 5;

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

      {(loadingChains.length > 0 || errorChains.length > 0) && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "var(--text-dim)",
            marginBottom: 10,
          }}
        >
          {loadingTickers.length > 0 && (
            <span>
              loading{" "}
              {loadingTickers.length <= ERROR_INLINE_THRESHOLD
                ? loadingTickers.join(", ")
                : `${loadingTickers.length} chain${loadingTickers.length === 1 ? "" : "s"}`}
            </span>
          )}
          {errorTickers.length > 0 && (
            // T1.3 — demoted from var(--warn) (red) to var(--text-dim).
            // The same UI fires whenever any explorer 503s in production,
            // so this should not pre-attention-grab in normal use. The
            // info still surfaces; the alarm tone does not.
            <span style={{ color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              {errorTickers.length <= ERROR_INLINE_THRESHOLD ? (
                <span>
                  {errorTickers.length} of {totalOwned} chain explorers unreachable: {errorTickers.join(", ")}
                </span>
              ) : (
                <>
                  <span>
                    {errorTickers.length} of {totalOwned} chain explorers unreachable
                  </span>
                  <button
                    type="button"
                    onClick={() => setErrorsExpanded((v) => !v)}
                    aria-expanded={errorsExpanded}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border)",
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      padding: "1px 6px",
                      letterSpacing: 0.5,
                    }}
                  >
                    {errorsExpanded ? "hide" : "show"}
                  </button>
                  {errorsExpanded && (
                    <span style={{ flexBasis: "100%", color: "var(--text-dim)", opacity: 0.85, marginTop: 2 }}>
                      {errorTickers.join(", ")}
                    </span>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      )}

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
                <SwapRow key={s.id} swap={s} last={i === arr.length - 1} />
              ))
          )
        ) : filteredTxs.length === 0 ? (
          <EmptyRow
            msg={
              chainsOwned.length === 0
                ? "No wallets loaded."
                : loadingChains.length > 0
                  ? "Fetching transactions…"
                  : amountFilter === "meaningful" && hiddenZeroCount > 0
                    ? `No meaningful transactions yet. ${hiddenZeroCount} zero-amount tx hidden — click "show zero" to view.`
                    : "No transactions found."
            }
          />
        ) : (
          filteredTxs.slice(0, 100).map((tx, i, arr) => {
            const isLast = i === arr.length - 1;
            return (
              <TxRow
                key={`${tx.chain}-${tx.hash}-${tx.direction}`}
                tx={tx}
                last={isLast}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function TxRow({ tx, last }: { tx: ChainTx; last: boolean }) {
  const adapter = getAdapter(tx.chain);
  const isIn = tx.direction === "in";
  const failed = tx.direction === "failed";
  const pending =
    tx.direction === "pending" ||
    (tx.confirmations !== undefined && tx.confirmations === 0);
  const directionLabel = failed
    ? "✗ failed"
    : isIn
      ? "▼ received"
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
      onClick={(e) => {
        if (e.shiftKey) {
          void navigator.clipboard.writeText(tx.hash);
          return;
        }
        const url = explorerTxUrl(tx.chain, tx.hash);
        if (url) void openExternal(url);
        else void navigator.clipboard.writeText(tx.hash);
      }}
      title={`${tx.hash}\nClick: open in explorer · Shift-click: copy`}
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
      <CoinIcon sym={adapter.ticker} size={22} glow={false} />
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
          {isIn ? "+" : failed ? "" : "−"}
          {tx.amount} {adapter.ticker}
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
function SwapRow({ swap, last }: { swap: SwapHistoryEntry; last: boolean }) {
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
      ? "var(--success)"
      : swap.status === "pending"
        ? "var(--warn)"
        : "var(--danger)";
  const shorten = (h: string) =>
    h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
  return (
    <div
      style={{
        padding: "12px 14px",
        borderBottom: last ? "none" : "1px solid var(--border)",
        background: "rgba(0,204,102,0.02)",
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
