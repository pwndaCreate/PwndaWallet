/**
 * Earnings breakdown card — hero day-number in coin units, USD/day
 * caption, then per-hour / per-day / per-week / per-month rows.
 *
 * Extracted from MineLandscapeView per ease-of-use-improvement-plan T2.1.
 * Portrait MiningView consumes this directly under the hashrate hero
 * so the "is this making me money?" P1 question gets a time-horizon
 * answer (per day → per month) the user can reason about.
 */

import type { EarningsEstimate } from "../earnings";
import { formatCoinAmount } from "../earnings";
import { KvRow } from "../../../design/primitives/KvRow";
import { ST } from "../../../components/Primitives";

interface EarningsPerPeriodProps {
  earnings: EarningsEstimate | null;
  ticker: string;
  /** Spot USD price for the ticker. When undefined the ≈ USD/day
   *  caption shows "— / day · price unavailable" instead of hiding. */
  priceUsd?: number;
  /** "live" / "estimated" / similar — surfaces in a small footer line so
   *  the user knows how much to trust the number. */
  coinStatsSource?: string;
  coinStatsStale?: boolean;
  /** Stagger base delay for the section-heading scramble. Optional. */
  delayBase?: number;
}

export function EarningsPerPeriod({
  earnings,
  ticker,
  priceUsd,
  coinStatsSource,
  coinStatsStale,
  delayBase = 140,
}: EarningsPerPeriodProps) {
  const dayUsd =
    earnings && priceUsd != null && priceUsd > 0
      ? earnings.day * priceUsd
      : null;
  const active = earnings != null && earnings.day > 0;

  return (
    <div>
      <div
        style={{
          fontSize: 9.5,
          color: "var(--text-muted)",
          letterSpacing: 1.5,
          textTransform: "uppercase",
          marginBottom: 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        <ST delay={delayBase}>earnings · est.</ST>
      </div>
      <div
        className="tnum"
        style={{
          fontSize: 22,
          color: active ? "var(--accent)" : "var(--text-dim)",
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          textShadow: active ? "0 0 14px rgba(0,255,102,0.30)" : "none",
        }}
      >
        {earnings ? formatCoinAmount(earnings.day, "").trim() : "—"}
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginLeft: 4,
          }}
        >
          {ticker}
        </span>
      </div>
      <div
        className="tnum"
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginTop: 4,
          fontFamily: "var(--font-mono)",
        }}
      >
        ≈{" "}
        {dayUsd != null
          ? `$${dayUsd.toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })} / day`
          : earnings
            ? "— / day · price unavailable"
            : "— / day"}
      </div>
      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        <KvRow
          k="per hour"
          v={earnings ? formatCoinAmount(earnings.hour, ticker) : "—"}
        />
        <KvRow
          k="per day"
          v={earnings ? formatCoinAmount(earnings.day, ticker) : "—"}
        />
        <KvRow
          k="per week"
          v={earnings ? formatCoinAmount(earnings.week, ticker) : "—"}
        />
        <KvRow
          k="per month"
          v={earnings ? formatCoinAmount(earnings.month, ticker) : "—"}
        />
      </div>
      {coinStatsSource && (
        <div
          style={{
            marginTop: 8,
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 0.5,
            fontFamily: "var(--font-mono)",
          }}
        >
          source · {coinStatsSource}
          {coinStatsStale ? " (stale)" : ""}
        </div>
      )}
    </div>
  );
}
