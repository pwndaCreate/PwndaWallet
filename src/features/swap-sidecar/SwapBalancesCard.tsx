/**
 * What the swap node holds — a **pure presentational** card.
 *
 * Zero `invoke` calls, zero hooks, zero polling: props in, markup out. The
 * mount site owns `useSidecarBalances` and passes the result down. That split
 * is what lets the same block render in the landscape Swap column, the
 * portrait Swap view, and the wallet dashboard without three copies of the
 * poll (contract §2.2, §D6).
 *
 * Copy constraints it exists to hold:
 *
 *  - These are the **swap node's** wallets, not the PwndaWallet vault's. Two
 *    different balances for the same coin is confusing enough that the card
 *    says which it is in its own subtitle rather than relying on the title.
 *  - A **null deposit address is not an error.** Upstream returns
 *    placeholders ("Refresh necessary", "WARNING: Unknown wallet seed",
 *    "Error: unowned address") in that field; `normalizeDepositAddress` maps
 *    them to null, and the card renders "not available yet" rather than
 *    offering an unpayable string behind a copy button (contract §R18).
 *  - A **per-coin error is a row**, not a screen. One unreachable daemon must
 *    not blank the coins that are fine.
 */
import { useState, type CSSProperties } from "react";
import { Card, Btn, Dot } from "../../design/primitives";
import type { SidecarBalanceRow } from "./useSidecarBalances";
import { isZeroAmount } from "./useSidecarBalances";

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
};

/** Ticker order that puts the coins this wallet actually swaps first, then
 *  everything else alphabetically. Particl last: it is the engine's own
 *  bookkeeping coin, not something the user chose to hold. */
const PRIORITY = ["XMR", "ZEPH", "BTC", "LTC", "DOGE", "DASH", "BCH"];

function sortRows(rows: Record<string, SidecarBalanceRow>): SidecarBalanceRow[] {
  return Object.values(rows).sort((a, b) => {
    const ia = PRIORITY.indexOf(a.ticker);
    const ib = PRIORITY.indexOf(b.ticker);
    const ra = ia === -1 ? (a.ticker === "PART" ? 999 : 500) : ia;
    const rb = ib === -1 ? (b.ticker === "PART" ? 999 : 500) : ib;
    if (ra !== rb) return ra - rb;
    return a.ticker.localeCompare(b.ticker);
  });
}

/** Trim a long address for display without ever handing a trimmed string to
 *  the clipboard — `copy` always uses the full value. */
function shortAddr(a: string): string {
  return a.length <= 22 ? a : `${a.slice(0, 10)}…${a.slice(-8)}`;
}

function DepositLine({ row }: { row: SidecarBalanceRow }) {
  const [copied, setCopied] = useState(false);
  const addr = row.depositAddress;

  if (!addr) {
    return (
      <span style={{ color: "var(--text-dim)" }}>
        deposit address not available yet
      </span>
    );
  }

  const copy = () => {
    void navigator.clipboard
      ?.writeText(addr)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard denied — the address is still on screen */
      });
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
      <span style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>
        {shortAddr(addr)}
      </span>
      <button
        type="button"
        onClick={copy}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: copied ? "var(--accent)" : "var(--text-muted)",
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

function BalanceRow({
  row,
  compact,
}: {
  row: SidecarBalanceRow;
  compact: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: compact ? "5px 0" : "7px 0",
        borderBottom: "1px solid var(--border-soft)",
      }}
    >
      <div
        style={{
          ...mono,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <span
          style={{
            color: "var(--text)",
            letterSpacing: 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {row.ticker}
          {row.locked && (
            <span
              title="This wallet is encrypted and locked — the node cannot sign for it."
              style={{
                fontSize: 9.5,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: "var(--warn)",
              }}
            >
              locked
            </span>
          )}
        </span>
        {row.error ? (
          <span
            className="tnum"
            style={{ color: "var(--danger)", textAlign: "right", wordBreak: "break-word" }}
          >
            {row.error}
          </span>
        ) : (
          <span className="tnum" style={{ color: "var(--text)", textAlign: "right" }}>
            {/* Amounts are decimal STRINGS end to end — never parsed to a
                float for display, which is where precision goes to die. */}
            {row.balance ?? "—"}
          </span>
        )}
      </div>

      {!row.error && !isZeroAmount(row.pending) && (
        <div style={{ ...mono, fontSize: 10.5, color: "var(--warn)" }}>
          +{row.pending} pending
        </div>
      )}

      {!compact && !row.error && (
        <div style={{ ...mono, fontSize: 10.5 }}>
          <DepositLine row={row} />
        </div>
      )}
    </div>
  );
}

/**
 * @param rows      keyed by UPPERCASE ticker, from `useSidecarBalances`
 * @param loading   a poll is in flight — shown as a dot, never as a spinner
 *                  that replaces already-good rows
 * @param error     transport / whole-body error; per-coin errors are on rows
 * @param onRefresh omit to hide the refresh control entirely
 * @param compact   portrait strip (no deposit addresses) vs landscape card
 */
export function SwapBalancesCard({
  rows,
  loading,
  error,
  onRefresh,
  compact = false,
}: {
  rows: Record<string, SidecarBalanceRow>;
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const list = sortRows(rows);

  return (
    <Card
      title="SWAP NODE BALANCES"
      right={
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          <Dot color={error ? "red" : loading ? "amber" : list.length > 0 ? "green" : "gray"} />
          {error ? "error" : loading ? "reading" : list.length > 0 ? "live" : "idle"}
          {onRefresh && (
            <Btn variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
              Refresh
            </Btn>
          )}
        </span>
      }
    >
      <div style={{ ...mono, fontSize: 10.5, color: "var(--text-dim)", marginBottom: 8 }}>
        Held by the local swap node — separate from your wallet balances.
      </div>

      {error && (
        <div
          style={{
            ...mono,
            fontSize: 11,
            color: "var(--danger)",
            wordBreak: "break-word",
            marginBottom: list.length > 0 ? 8 : 0,
          }}
        >
          {error}
        </div>
      )}

      {list.length === 0 && !error && (
        <div style={{ ...mono, color: "var(--text-muted)" }}>
          {/* Deliberately covers both "node stopped" and "no coins configured":
              the read cannot tell them apart, and inventing a distinction here
              would be a guess rendered as fact. */}
          No wallets reported. The swap node may not be running yet.
        </div>
      )}

      {list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {list.map((row) => (
            <BalanceRow key={row.ticker} row={row} compact={compact} />
          ))}
        </div>
      )}
    </Card>
  );
}
