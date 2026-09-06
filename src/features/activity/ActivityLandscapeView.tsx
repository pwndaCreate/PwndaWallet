import { useMemo, useState } from "react";
import { ST } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { getAdapter } from "../../wallets";
import { explorerTxUrl } from "../../wallets/explorers";
import type { ChainTx, ChainType } from "../../wallets";
import { fmtRelative } from "../../utils/format";
import { openExternal } from "../../utils/openExternal";
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
}

export function ActivityLandscapeView({
  txByChain,
  loading,
  errors,
  chainsOwned,
  addressByChain,
  pricesByTicker,
}: ActivityLandscapeViewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Cross-chain swap history — drives both the dedup of `all`-mode
  // chain-tx rows and the `swaps` filter's rendering.
  const [swapHistory] = useSwapHistory();
  const swapHashes = useMemo(() => swapHashSet(swapHistory), [swapHistory]);

  // Flatten + dedup against swap hashes + sort newest-first.
  const allTxs = useMemo(() => {
    const out: ChainTx[] = [];
    for (const c of chainsOwned) {
      const k = `${c}:${addressByChain[c] ?? ""}`;
      const list = txByChain[k] ?? [];
      out.push(...list);
    }
    const deduped = dedupChainTxsAgainstSwaps(out, swapHashes);
    deduped.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return deduped;
  }, [chainsOwned, txByChain, addressByChain, swapHashes]);

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
      const price = pricesByTicker[a.ticker.toUpperCase()];
      if (!price) continue;
      const amount = parseFloat(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const usd = amount * price;
      if (tx.direction === "in") inU += usd;
      else if (tx.direction === "out" || tx.direction === "pending")
        outU += usd;
    }
    return { inflowUsd: inU, outflowUsd: outU };
  }, [allTxs, pricesByTicker]);

  const errorChains = useMemo(
    () =>
      chainsOwned.filter(
        (c) => errors?.[`${c}:${addressByChain[c] ?? ""}`]
      ),
    [chainsOwned, errors, addressByChain]
  );
  const loadingChains = useMemo(
    () =>
      chainsOwned.filter(
        (c) => loading?.[`${c}:${addressByChain[c] ?? ""}`]
      ),
    [chainsOwned, loading, addressByChain]
  );

  // Detail = the selected tx, or the first row of the filtered set.
  const detail = useMemo(() => {
    if (filtered.length === 0) return null;
    if (selectedKey) {
      const found = filtered.find(
        (t) => `${t.chain}:${t.hash}:${t.direction}` === selectedKey
      );
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
            {(loadingChains.length > 0 || errorChains.length > 0) && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "var(--text-dim)",
                  alignSelf: "center",
                }}
              >
                {loadingChains.length > 0 &&
                  `loading ${loadingChains
                    .map((c) => getAdapter(c).ticker)
                    .join(", ")}`}
                {errorChains.length > 0 && (
                  <span style={{ color: "var(--warn)", marginLeft: 6 }}>
                    · errors on{" "}
                    {errorChains.map((c) => getAdapter(c).ticker).join(", ")}
                  </span>
                )}
              </span>
            )}
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
                .map((s) => <LandscapeSwapRow key={s.id} swap={s} />)
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
                : loadingChains.length > 0
                  ? "Fetching transactions…"
                  : "No transactions found."}
            </div>
          ) : (
            filtered.map((tx) => {
              const adapter = getAdapter(tx.chain);
              const key = `${tx.chain}:${tx.hash}:${tx.direction}`;
              const a = detail
                ? `${detail.chain}:${detail.hash}:${detail.direction}` === key
                : false;
              const isIn = tx.direction === "in";
              const failed = tx.direction === "failed";
              const dirColor = failed
                ? "var(--danger)"
                : isIn
                  ? "var(--accent)"
                  : "var(--warn)";
              const price = pricesByTicker[adapter.ticker.toUpperCase()];
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
                  <CoinIcon sym={adapter.ticker} size={22} glow={false} />
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
                    {failed ? "" : isIn ? "+" : "−"}
                    {tx.amount} {adapter.ticker}
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

        {detail ? (
          <DetailPanel detail={detail} />
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
    </div>
  );
}

function DetailPanel({ detail }: { detail: ChainTx }) {
  const adapter = getAdapter(detail.chain);
  const isIn = detail.direction === "in";
  const failed = detail.direction === "failed";
  const dirLabel = failed
    ? "✗ failed"
    : isIn
      ? "▼ received"
      : "▲ sent";
  const dirColor = failed
    ? "var(--danger)"
    : isIn
      ? "var(--accent)"
      : "var(--warn)";
  const conf = detail.confirmations ?? 0;
  const finalThreshold = 6;
  const status =
    conf >= finalThreshold ? "confirmed" : conf > 0 ? "pending" : "unconfirmed";

  const onCopy = () => navigator.clipboard.writeText(detail.hash);
  const onExplorer = () => {
    const url = explorerTxUrl(detail.chain, detail.hash);
    if (url) void openExternal(url);
    else void navigator.clipboard.writeText(detail.hash);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <CoinIcon sym={adapter.ticker} size={42} accent={adapter.color} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: dirColor,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
            }}
          >
            {dirLabel}
          </div>
          <div
            className="tnum"
            style={{
              fontSize: 22,
              color: failed
                ? "var(--danger)"
                : isIn
                  ? "var(--accent)"
                  : "var(--white)",
              fontWeight: 600,
              marginTop: 2,
              lineHeight: 1.1,
              fontFamily: "var(--font-mono)",
            }}
          >
            {failed ? "" : isIn ? "+" : "−"}
            {detail.amount}{" "}
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {adapter.ticker}
            </span>
          </div>
          <div
            className="tnum"
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 2,
              fontFamily: "var(--font-mono)",
            }}
          >
            {detail.timestamp
              ? new Date(detail.timestamp * 1000).toLocaleString()
              : "—"}
          </div>
        </div>
      </div>

      <div
        style={{
          height: 1,
          background: "var(--border-soft)",
          margin: "4px 0",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        <DetailRow k="chain" v={adapter.displayName} />
        <DetailRow k="hash" v={truncMiddle(detail.hash, 12, 8)} title={detail.hash} />
        <DetailRow
          k="block"
          v={detail.height ? detail.height.toLocaleString() : "—"}
        />
        <DetailRow k="confirmations" v={`${conf}`} />
        <DetailRow
          k="fee"
          v={detail.fee ? `${detail.fee} ${adapter.ticker}` : "—"}
        />
        <DetailRow
          k="status"
          v={status}
          accent={status === "confirmed"}
          warn={status === "unconfirmed"}
        />
        <DetailRow k="when" v={fmtRelative(detail.timestamp)} />
      </div>

      {/* confirmations progress */}
      <div style={{ marginTop: 4 }}>
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 1.5,
            textTransform: "uppercase",
            marginBottom: 6,
            fontFamily: "var(--font-mono)",
          }}
        >
          confirmations
        </div>
        <ConfBar value={Math.min(conf, finalThreshold)} max={finalThreshold} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 6,
            fontSize: 9,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
          className="tnum"
        >
          <span>{Math.min(conf, finalThreshold)} / {finalThreshold} minimum</span>
          <span
            style={{
              color: conf >= finalThreshold ? "var(--accent)" : "var(--warn)",
            }}
          >
            {conf >= finalThreshold ? "FINAL" : "PENDING"}
          </span>
        </div>
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full size="md" onClick={onCopy}>
          Copy hash
        </Btn>
        <Btn variant="primary" full size="md" onClick={onExplorer}>
          View on explorer
        </Btn>
      </div>
    </>
  );
}

function DetailRow({
  k,
  v,
  title,
  accent,
  warn,
}: {
  k: string;
  v: string;
  title?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span
        style={{
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {k}
      </span>
      <span
        title={title}
        className="tnum"
        style={{
          color: accent ? "var(--accent)" : warn ? "var(--warn)" : "var(--text)",
          textAlign: "right",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {v}
      </span>
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
function LandscapeSwapRow({ swap }: { swap: SwapHistoryEntry }) {
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
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(0,204,102,0.02)",
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

function ConfBar({ value, max }: { value: number; max: number }) {
  const cells = [];
  for (let i = 0; i < max; i++) {
    cells.push(
      <div
        key={i}
        style={{
          flex: 1,
          height: 5,
          background:
            i < value ? "var(--accent)" : "rgba(255,255,255,0.06)",
          boxShadow: i < value ? "0 0 4px var(--accent)" : "none",
        }}
      />
    );
  }
  return <div style={{ display: "flex", gap: 2 }}>{cells}</div>;
}
