/**
 * Multi-chain activity view.
 *
 * Renders a unified table backed by `ChainTx[]` from every chain the user
 * holds. Filter chips are derived dynamically from the wallets passed in
 * (no more hardcoded XMR/ETH/BTC chip set). Per-chain loading and error
 * state shows up at the top so the user knows when a source is dragging.
 */

import { useEffect, useMemo, useState } from "react";
import { Panel, Mono } from "../../components/Primitives";
import { getAdapter } from "../../wallets";
import { explorerTxUrl } from "../../wallets/explorers";
import type { ChainTx, ChainType } from "../../wallets";
import { openExternal } from "../../utils/openExternal";
import { txIsMeaningful } from "./txFilters";
import {
  computeDriftFraction,
  driftTone,
  formatActualReceived,
  formatDriftPercent,
  loadSwapHistory,
  type SwapHistoryEntry,
} from "../swap";

type DirectionFilter = "all" | "in" | "out";
type AmountFilter = "meaningful" | "all";

/** Pseudo-chain filter value for "show only cross-chain swap entries". */
const SWAP_FILTER = "_swap";
type ChainFilter = ChainType | "all" | typeof SWAP_FILTER;

/**
 * Unified Activity row — either a per-chain transaction or a
 * cross-chain swap entry. The swap-history surface (#19, 2026-05-26)
 * uses this discriminated union to keep one timeline sort + one
 * render-switch path; per-chain dashboards still consume only
 * `ChainTx` directly.
 *
 * `timestamp` is normalized to Unix-seconds at flatten time so the
 * sort step doesn't have to know about either side's native shape
 * (ChainTx → Unix seconds optional; SwapHistoryEntry → ISO8601
 * `completedAt` or `createdAt`). Missing timestamps sort to the
 * bottom (treated as 0).
 */
type ActivityRow =
  | { kind: "chain"; tx: ChainTx; timestamp: number }
  | { kind: "swap"; swap: SwapHistoryEntry; timestamp: number };

function swapRowTimestamp(s: SwapHistoryEntry): number {
  const iso = s.completedAt ?? s.createdAt;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

export interface ActivityViewProps {
  /** Map of chain → its ChainTx[]. Missing entries render as empty. */
  txByChain: Record<string, ChainTx[]>;
  /** Per-chain loading flag from useTxHistory. */
  loading?: Record<string, boolean>;
  /** Per-chain last-error from useTxHistory. */
  errors?: Record<string, string | null>;
  /** Chains the user actually has wallets for — drives the chip set. */
  chainsOwned: ChainType[];
  /** Per-chain ⟨chain, address⟩ for the cache key. Used to look up entries. */
  addressByChain: Record<string, string>;
}

export function ActivityView({
  txByChain,
  loading,
  errors,
  chainsOwned,
  addressByChain,
}: ActivityViewProps) {
  const [chainFilter, setChainFilter] = useState<ChainFilter>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  // T1.3 — default to "meaningful" (amount > 0) so the panel doesn't
  // open as 62 rows of `+0 XRP`. User can flip to "all" to see every row.
  const [amountFilter, setAmountFilter] = useState<AmountFilter>("meaningful");

  // Cross-chain swap history. Loaded once on mount and re-loaded on
  // every History-tab focus elsewhere in the app would have notified;
  // here we keep it simple — the swap store is small (capped at 200
  // entries) so a 1-shot read at mount + refresh-on-mount is enough.
  const [swapHistory, setSwapHistory] = useState<SwapHistoryEntry[]>([]);
  useEffect(() => {
    let cancel = false;
    loadSwapHistory()
      .then((rows) => {
        if (!cancel) setSwapHistory(rows);
      })
      .catch(() => {
        /* swap history is best-effort here — Activity tab still renders
           per-chain txs if the swap store is unreachable. */
      });
    return () => {
      cancel = true;
    };
  }, []);

  /**
   * Dedup hash set — every source/destination tx hash from any
   * cross-chain swap. Per-chain txs whose hash appears here are
   * suppressed from the unified timeline (the swap row is the
   * canonical representation of that hash in this view; per-chain
   * dashboards still show the tx natively).
   *
   * Dedup strategy: SUPPRESS, not TAG (per the spec's primary option).
   * Rationale: the user's mental model is "one swap = one event". A
   * tag-and-show approach would put 2-3 rows for the same swap in the
   * timeline — the source-chain row, optionally the destination-chain
   * row, AND the swap row — which is exactly the double-counting the
   * acceptance criteria forbid. Suppress keeps the timeline clean.
   * Per-chain dashboards retain the source/dest rows independently,
   * so the developer-debug "is the tx really on-chain?" check still
   * works from the per-chain panels.
   *
   * Hashes are normalized to lowercase so the dedup is case-insensitive
   * (Ethereum hex hashes round-trip through EIP-55 checksumming
   * sometimes, and some indexers serve them in mixed case).
   */
  const swapHashes = useMemo(() => {
    const set = new Set<string>();
    for (const s of swapHistory) {
      if (s.sourceTxHash) set.add(s.sourceTxHash.toLowerCase());
      if (s.destTxHash) set.add(s.destTxHash.toLowerCase());
    }
    return set;
  }, [swapHistory]);

  // Flatten all txs from owned chains, suppress hashes that already
  // appear in a swap row, normalize timestamps, then merge swap rows
  // and sort newest-first.
  const allRows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [];
    for (const c of chainsOwned) {
      const k = `${c}:${addressByChain[c] ?? ""}`;
      const list = txByChain[k] ?? [];
      for (const tx of list) {
        if (swapHashes.has(tx.hash.toLowerCase())) continue;
        out.push({ kind: "chain", tx, timestamp: tx.timestamp ?? 0 });
      }
    }
    for (const s of swapHistory) {
      out.push({ kind: "swap", swap: s, timestamp: swapRowTimestamp(s) });
    }
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }, [chainsOwned, txByChain, addressByChain, swapHashes, swapHistory]);

  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      // Chain filter — handles per-chain ("ethereum"), "all", and the
      // SWAP pseudo-chain filter.
      if (chainFilter === SWAP_FILTER) {
        if (row.kind !== "swap") return false;
      } else if (chainFilter !== "all") {
        if (row.kind !== "chain" || row.tx.chain !== chainFilter) return false;
      }
      // Direction / amount filters only apply to chain rows. Swap
      // entries are always "shown" — they aren't directional in the
      // per-chain sense and they aren't 0-amount even when in flight.
      if (row.kind === "chain") {
        const tx = row.tx;
        if (directionFilter === "in" && tx.direction !== "in") return false;
        if (
          directionFilter === "out" &&
          tx.direction !== "out" &&
          tx.direction !== "pending"
        )
          return false;
        if (amountFilter === "meaningful" && !txIsMeaningful(tx)) return false;
      }
      return true;
    });
  }, [allRows, chainFilter, directionFilter, amountFilter]);

  const hiddenZeroCount = useMemo(() => {
    if (amountFilter !== "meaningful") return 0;
    return allRows.filter(
      (row) =>
        row.kind === "chain" &&
        (chainFilter === "all" || row.tx.chain === chainFilter) &&
        !txIsMeaningful(row.tx)
    ).length;
  }, [allRows, chainFilter, amountFilter]);

  const errorChains = useMemo(
    () => chainsOwned.filter((c) => errors?.[`${c}:${addressByChain[c] ?? ""}`]),
    [chainsOwned, errors, addressByChain]
  );
  const loadingChains = useMemo(
    () => chainsOwned.filter((c) => loading?.[`${c}:${addressByChain[c] ?? ""}`]),
    [chainsOwned, loading, addressByChain]
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        padding: 10,
        gap: 10,
        animation: "fade-in .2s ease",
      }}
    >
      {/* Filter bar */}
      <Panel
        label="Activity"
        pad={10}
        right={
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <FilterButton
              label="All"
              active={chainFilter === "all"}
              onClick={() => setChainFilter("all")}
            />
            {chainsOwned.map((c) => {
              const a = getAdapter(c);
              return (
                <FilterButton
                  key={c}
                  label={a.ticker}
                  active={chainFilter === c}
                  onClick={() => setChainFilter(c)}
                  color={a.color}
                />
              );
            })}
            {/* Cross-chain swap pseudo-filter — shown only when there
                are any swaps to filter to, so a fresh-vault user
                doesn't see a chip for an empty bucket. */}
            {swapHistory.length > 0 && (
              <FilterButton
                label="SWAP"
                active={chainFilter === SWAP_FILTER}
                onClick={() => setChainFilter(SWAP_FILTER)}
                color="var(--accent)"
              />
            )}
            <span style={{ width: 8 }} />
            <FilterButton
              label="In"
              active={directionFilter === "in"}
              onClick={() =>
                setDirectionFilter(directionFilter === "in" ? "all" : "in")
              }
            />
            <FilterButton
              label="Out"
              active={directionFilter === "out"}
              onClick={() =>
                setDirectionFilter(directionFilter === "out" ? "all" : "out")
              }
            />
            <span style={{ width: 8 }} />
            <FilterButton
              label={amountFilter === "meaningful" ? "Hide zero" : "Show zero"}
              active={amountFilter === "meaningful"}
              onClick={() =>
                setAmountFilter(amountFilter === "meaningful" ? "all" : "meaningful")
              }
            />
          </div>
        }
        style={{ flexShrink: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Mono size={9} color="var(--text-dim)">
            {filteredRows.length}{" "}
            {chainFilter === SWAP_FILTER
              ? `cross-chain swap${filteredRows.length !== 1 ? "s" : ""}`
              : `transaction${filteredRows.length !== 1 ? "s" : ""}`}
            {chainFilter !== "all" &&
              chainFilter !== SWAP_FILTER &&
              ` · ${getAdapter(chainFilter).ticker}`}
            {directionFilter !== "all" && ` · ${directionFilter.toUpperCase()}`}
          </Mono>
          {loadingChains.length > 0 && (
            <Mono size={9} color="var(--text-dim)">
              · loading {loadingChains.map((c) => getAdapter(c).ticker).join(", ")}
            </Mono>
          )}
          {hiddenZeroCount > 0 && (
            <Mono size={9} color="var(--text-dim)">
              · {hiddenZeroCount} zero-amount hidden
            </Mono>
          )}
          {errorChains.length > 0 && (
            <Mono size={9} color="var(--text-dim)">
              · {errorChains.length} of {chainsOwned.length} chain explorers unreachable
            </Mono>
          )}
        </div>
      </Panel>

      {/* Table */}
      <Panel
        style={{ flex: 1, minHeight: 0 }}
        pad={0}
        bodyStyle={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <TableHeader />
        <div style={{ flex: 1, overflow: "auto" }}>
          {filteredRows.length === 0 ? (
            <EmptyState
              chainFilter={chainFilter}
              hasAnyChain={chainsOwned.length > 0}
              loading={loadingChains.length > 0}
              hiddenByMeaningful={
                amountFilter === "meaningful" && hiddenZeroCount > 0
              }
              onShowAll={() => setAmountFilter("all")}
            />
          ) : (
            filteredRows.map((row) =>
              row.kind === "chain" ? (
                <TxRow
                  key={`chain-${row.tx.chain}-${row.tx.hash}-${row.tx.direction}`}
                  tx={row.tx}
                />
              ) : (
                <SwapRow key={`swap-${row.swap.id}`} swap={row.swap} />
              )
            )
          )}
        </div>
      </Panel>
    </div>
  );
}

function FilterButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={props.onClick}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9,
        letterSpacing: 0.8,
        padding: "3px 8px",
        background: props.active ? "rgba(242,242,242,0.9)" : "transparent",
        border: `1px solid ${props.color ?? "rgba(255,255,255,0.18)"}`,
        color: props.active ? "#0a0a0a" : "var(--text-dim)",
        cursor: "pointer",
        transition: "all .12s",
      }}
    >
      {props.label}
    </button>
  );
}

function TableHeader() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 80px 60px 1fr 130px 80px 80px",
        padding: "6px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        background: "rgba(255,255,255,0.02)",
        flexShrink: 0,
      }}
    >
      {["Chain", "Date", "Type", "TxID", "Amount", "Confs", "Status"].map((col) => (
        <Mono key={col} size={8} color="var(--text-dim)" upper spacing={0.8}>
          {col}
        </Mono>
      ))}
    </div>
  );
}

function TxRow({ tx }: { tx: ChainTx }) {
  const adapter = getAdapter(tx.chain);
  const pending =
    tx.direction === "pending" ||
    (tx.confirmations !== undefined && tx.confirmations === 0);
  const failed = tx.direction === "failed";
  const isIn = tx.direction === "in";
  const date = tx.timestamp
    ? new Date(tx.timestamp * 1000).toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "2-digit",
      })
    : "—";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 80px 60px 1fr 130px 80px 80px",
        padding: "7px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        alignItems: "center",
        transition: "background .1s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: adapter.color }}>
        {adapter.ticker}
      </span>
      <Mono size={9} color="var(--text-dim)">
        {date}
      </Mono>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: isIn ? "var(--success)" : failed ? "var(--danger)" : "var(--warn)",
        }}
      >
        {isIn ? "▼ IN" : failed ? "✗ FAIL" : "▲ OUT"}
      </span>
      <code
        style={{
          fontFamily: "var(--mono)",
          fontSize: 8,
          color: "var(--text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
        title={`${tx.hash}\n(click: open in explorer · shift-click: copy)`}
        onClick={(e) => {
          if (e.shiftKey) {
            void navigator.clipboard.writeText(tx.hash);
            return;
          }
          const url = explorerTxUrl(tx.chain, tx.hash);
          if (url) void openExternal(url);
          else void navigator.clipboard.writeText(tx.hash);
        }}
      >
        {tx.hash.length > 28 ? `${tx.hash.slice(0, 20)}...${tx.hash.slice(-8)}` : tx.hash}
      </code>
      <Mono size={9} color={isIn ? "var(--success)" : "var(--text)"}>
        {isIn ? "+" : "-"}
        {tx.amount} {adapter.ticker}
        {tx.fee && !isIn && (
          <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>(fee {tx.fee})</span>
        )}
      </Mono>
      <Mono size={9} color="var(--text-dim)">
        {tx.confirmations !== undefined && tx.confirmations > 0
          ? `${tx.confirmations}`
          : pending
          ? "pending"
          : "—"}
      </Mono>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 8,
          padding: "2px 6px",
          background: pending
            ? "rgba(255,170,0,0.1)"
            : failed
            ? "rgba(255,68,68,0.1)"
            : "rgba(0,204,102,0.1)",
          color: pending ? "var(--warn)" : failed ? "var(--danger)" : "var(--success)",
          border: `1px solid ${
            pending
              ? "rgba(255,170,0,0.3)"
              : failed
              ? "rgba(255,68,68,0.3)"
              : "rgba(0,204,102,0.3)"
          }`,
        }}
      >
        {pending ? "pending" : failed ? "failed" : "confirmed"}
      </span>
    </div>
  );
}

function EmptyState(props: {
  chainFilter: ChainFilter;
  hasAnyChain: boolean;
  loading: boolean;
  hiddenByMeaningful?: boolean;
  onShowAll?: () => void;
}) {
  let msg: string;
  if (!props.hasAnyChain) msg = "No wallets loaded.";
  else if (props.loading) msg = "Fetching transactions…";
  else if (props.hiddenByMeaningful)
    msg = "No meaningful transactions yet. Send or receive funds to populate this view.";
  else if (props.chainFilter === SWAP_FILTER)
    msg = "No cross-chain swaps yet. Visit the Swap tab to make one.";
  else if (props.chainFilter === "all") msg = "No transactions found.";
  else msg = `No ${getAdapter(props.chainFilter).ticker} transactions found.`;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: 160,
        gap: 8,
      }}
    >
      <Mono size={10} color="var(--text-dim)">
        {msg}
      </Mono>
      {props.hiddenByMeaningful && props.onShowAll && (
        <button
          type="button"
          className="btn-link"
          onClick={props.onShowAll}
          style={{ fontSize: 10 }}
        >
          show zero-amount transactions ▾
        </button>
      )}
    </div>
  );
}

/**
 * Cross-chain swap row. Uses a different layout than TxRow because the
 * 7-column grid can't fit the source→dest hash pair + drift indicator
 * cleanly. Instead: full-width row with the swap-direction header on
 * top and the source/dest hash chips below. Visually distinct enough
 * that the user can scan the timeline and tell at a glance which rows
 * are chain txs vs cross-chain swaps.
 *
 * Drift indicator (the user-facing payoff of #22): when
 * `swap.actualReceived` is populated, render a chip next to the
 * amount with the percent + a color tone (neutral / yellow / red)
 * per `driftTone`. When it's undefined (historical entries pre-fix,
 * or SwapKit responses without a settled-amount field, or in-flight
 * swaps), the chip is hidden entirely — no zero-drift fake.
 */
function SwapRow({ swap }: { swap: SwapHistoryEntry }) {
  const date = (() => {
    const iso = swap.completedAt ?? swap.createdAt;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "—";
    return new Date(t).toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "2-digit",
    });
  })();
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
  const statusBg =
    swap.status === "success"
      ? "rgba(0,204,102,0.1)"
      : swap.status === "pending"
        ? "rgba(255,170,0,0.1)"
        : "rgba(255,68,68,0.1)";
  const shorten = (h: string) =>
    h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
  return (
    <div
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        background: "rgba(0,204,102,0.02)",
      }}
    >
      {/* Header row: SWAP tag + direction + amounts + drift + status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "var(--mono)",
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
              opacity: 0.85,
            }}
            title={`Drift: actual ${actualDisplay} vs quote ${swap.toAmount}`}
          >
            {driftText}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Mono size={9} color="var(--text-dim)">
          {date}
        </Mono>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 8,
            padding: "2px 6px",
            background: statusBg,
            color: statusColor,
            border: `1px solid ${statusColor}`,
          }}
        >
          {swap.status}
        </span>
      </div>
      {/* Sub-row: provider + source/dest hashes */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 6,
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: "var(--text-dim)",
        }}
      >
        {swap.provider && <span>{swap.provider}</span>}
        {swap.provider && <span>·</span>}
        {/* Guarded the same way the dest chip below already is. A desk swap in
            ACCEPTED state has not locked anything yet, so sourceTxHash is ""
            and this rendered a dead "source:" label over an empty <code>
            whose click handler copied the empty string. SwapView's own history
            list guards correctly; this was the one unguarded consumer. */}
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
