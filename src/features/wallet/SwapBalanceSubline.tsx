import { swapBalanceLabel } from "./swap-balance-subline";

/**
 * The compact "held by the swap node" line on a wallet asset row (C0.1).
 *
 * # What this must NOT be
 *
 * It must never read as the wallet's own money. Coins in the BasicSwap node's
 * wallet sit under a different key set and a different spend authority — the
 * wallet's Send button cannot reach them — so a number that merged into the
 * balance column, or picked up the accent colour the wallet uses for its own
 * funds, would be a custody lie in one glance. Hence: no accent colour, a
 * smaller type size than the balance it sits under, and an explicit
 * `SWAP NODE` chip carrying the custody claim in words rather than by
 * position.
 *
 * # What it must not do either
 *
 * Render for a user who does not swap. `swapBalanceLabel` returns `null` for
 * an absent, zero or malformed amount and this component returns `null` with
 * it — no empty row, no "—" placeholder, no reserved space. Callers pass
 * `undefined` when the sidecar is off, which lands in the same branch.
 */
export function SwapBalanceSubline({
  raw,
  ticker,
  size = 8,
}: {
  /** The swap node's balance for this ticker, verbatim from the engine.
   *  `undefined`/`null` when the sidecar is off or holds no such coin. */
  raw: string | null | undefined;
  ticker: string;
  /** Type size in px. Landscape rows run 8; the portrait asset card 9.5.
   *  Always smaller than the balance the line sits beneath. */
  size?: number;
}) {
  const label = swapBalanceLabel(raw, ticker);
  if (!label) return null;

  return (
    <div
      title={`${label} is held by the local swap node, not by this wallet. Swaps are funded from it; the wallet's Send cannot spend it.`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        marginTop: 2,
        fontFamily: "var(--font-mono)",
        fontSize: size,
        color: "var(--text-dim)",
        letterSpacing: 0.2,
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          padding: "0 3px",
          border: "1px solid var(--border-soft)",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          lineHeight: 1.5,
          // Explicitly NOT var(--accent): the accent is the wallet's own
          // money in every other row of this list.
          color: "var(--text-dim)",
        }}
      >
        Swap node
      </span>
      <span
        className="tnum"
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </div>
  );
}
