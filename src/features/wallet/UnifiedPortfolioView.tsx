import { useMemo } from "react";
import type { ChainType } from "../../wallets";
import { getAdapter } from "../../wallets";
import { ST } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import { aggregatePortfolio, type Holding, type PortfolioRow } from "./portfolio-aggregate";

/**
 * Unified aggregated portfolio (Phase 4) — the "All Wallets" view. Sums every
 * wallet's holdings into a grand total and groups rows by wallet so each row's
 * ownership is unambiguous (the plan's wallet-chip requirement, expressed as
 * per-wallet sections). Read-only overview: clicking "Open" switches into that
 * wallet's own view where send/swap act on exactly one wallet.
 */

function parseNum(raw: string | undefined): number | null {
  if (!raw || raw === "--" || raw === "—") return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}
function usdFor(chain: ChainType, balance: string | undefined, prices: Record<string, number>): number | null {
  const price = prices[getAdapter(chain).ticker.toUpperCase()];
  const n = parseNum(balance);
  if (price == null || n == null) return null;
  return n * price;
}
function fmtUsd(usd: number): string {
  if (usd >= 1000) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${usd.toFixed(2)}`;
}
function fmtBalance(raw: string | undefined): string {
  const n = parseNum(raw);
  if (n == null) return "—";
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

const MAX_ROWS_PER_WALLET = 6;

export function UnifiedPortfolioView({
  holdings,
  pricesByTicker,
  onOpenWallet,
}: {
  holdings: Holding[];
  pricesByTicker: Record<string, number>;
  onOpenWallet: (walletId: string) => void;
}) {
  const agg = useMemo(
    () => aggregatePortfolio(holdings, (chain, bal) => usdFor(chain, bal, pricesByTicker)),
    [holdings, pricesByTicker]
  );

  // Rows grouped by wallet, each wallet's rows sorted by USD desc then balance.
  const rowsByWallet = useMemo(() => {
    const map = new Map<string, PortfolioRow[]>();
    for (const r of agg.rows) {
      const arr = map.get(r.walletId) ?? [];
      arr.push(r);
      map.set(r.walletId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        if ((b.usd ?? 0) !== (a.usd ?? 0)) return (b.usd ?? 0) - (a.usd ?? 0);
        return (parseNum(b.balance) ?? 0) - (parseNum(a.balance) ?? 0);
      });
    }
    return map;
  }, [agg.rows]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: 14,
        maxWidth: 900,
        width: "100%",
        margin: "0 auto",
        boxSizing: "border-box",
        animation: "fade-in .2s ease",
      }}
    >
      {/* ── Grand total header ─────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--text-dim)",
            marginBottom: 4,
          }}
        >
          <ST speed={22}>All Wallets · Unified Portfolio</ST>
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 34,
            fontWeight: 600,
            color: "var(--text)",
            letterSpacing: -0.5,
          }}
        >
          {fmtUsd(agg.grandTotalUsd)}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>
          {agg.perWallet.length} wallet{agg.perWallet.length === 1 ? "" : "s"} ·{" "}
          {agg.rows.length} holdings
        </div>
      </div>

      {/* ── Per-wallet sections ────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {agg.perWallet.map((w) => {
          const rows = rowsByWallet.get(w.walletId) ?? [];
          const shown = rows.filter((r) => parseNum(r.balance) !== null).slice(0, MAX_ROWS_PER_WALLET);
          const hidden = rows.length - shown.length;
          return (
            <div
              key={w.walletId}
              style={{
                border: "1px solid var(--border-soft)",
                background: "var(--surface-2)",
                borderRadius: 3,
              }}
            >
              {/* section header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
                    {w.walletName}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)" }}>
                    {fmtUsd(w.usd)}
                  </div>
                </div>
                <button
                  onClick={() => onOpenWallet(w.walletId)}
                  title={`Open ${w.walletName}`}
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 2,
                    padding: "5px 10px",
                    cursor: "pointer",
                  }}
                >
                  Open ↗
                </button>
              </div>

              {/* chain rows */}
              <div style={{ display: "flex", flexDirection: "column" }}>
                {shown.map((r) => {
                  const meta = getAdapter(r.chain);
                  return (
                    <button
                      key={`${r.chain}:${r.address}`}
                      onClick={() => onOpenWallet(r.walletId)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "7px 12px",
                        background: "transparent",
                        border: "none",
                        borderTop: "1px solid rgba(255,255,255,0.04)",
                        cursor: "pointer",
                        textAlign: "left",
                        width: "100%",
                      }}
                    >
                      <CoinIcon sym={meta.ticker} size={18} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>
                          {meta.displayName}
                        </span>{" "}
                        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>
                          {meta.ticker}
                        </span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>
                          {fmtBalance(r.balance)}
                        </div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>
                          {r.usd != null ? fmtUsd(r.usd) : "—"}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {shown.length === 0 && (
                  <div style={{ padding: "10px 12px", fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>
                    No balances captured yet — open this wallet to sync.
                  </div>
                )}
                {hidden > 0 && (
                  <button
                    onClick={() => onOpenWallet(w.walletId)}
                    style={{
                      padding: "7px 12px",
                      background: "transparent",
                      border: "none",
                      borderTop: "1px solid rgba(255,255,255,0.04)",
                      fontFamily: "var(--mono)",
                      fontSize: 9,
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    + {hidden} more chain{hidden === 1 ? "" : "s"} · open wallet ↗
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
