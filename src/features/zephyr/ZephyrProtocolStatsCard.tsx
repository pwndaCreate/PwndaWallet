import {
  classifyReserveRatio,
  worstOfRatio,
  type ReserveRatioBand,
  type ZphLiveStats,
} from "../../wallets/zph-scanner-api";
import { Card } from "../../components/PrimitivesV2";

/**
 * Live Zephyr protocol stats card — reserve ratio (spot + 24h MA),
 * asset USD prices, ZYS yield APY. Source: scanner API
 * (`zephyrprotocol.com/api/v1/livestats`), polled by `useZphReserveInfo`.
 *
 * Renders even before the first fetch completes (skeleton state); the
 * `loading` flag is shown as "(refreshing…)" once the user has seen
 * real numbers at least once, so a transient API hiccup doesn't blank
 * the panel.
 *
 * Reserve-ratio band coloring:
 *   - normal      (400–800%) → green
 *   - below-mint  (200–400%) → amber  (ZSD mint + ZRS redeem paused)
 *   - below-yield (<200%)    → red    (ZYS yield generation paused)
 *   - above-cap   (>800%)    → blue   (ZRS minting paused — not bad)
 */

const BAND_COLORS: Record<ReserveRatioBand, string> = {
  normal: "var(--success, #4ad97a)",
  "below-mint": "#f0a020",
  "below-yield": "#e34646",
  "above-cap": "#3aa0ff",
};

const BAND_LABELS: Record<ReserveRatioBand, string> = {
  normal: "HEALTHY (400–800%)",
  "below-mint": "ZSD MINT PAUSED (<400%)",
  "below-yield": "ZYS YIELD PAUSED (<200%)",
  "above-cap": "ZRS MINT PAUSED (>800%)",
};

function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtUsd(value: number): string {
  if (value >= 1000) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (value >= 1) {
    return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function fmtSupply(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function fmtAge(ms: number | null): string {
  if (ms == null) return "—";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

export function ZephyrProtocolStatsCard({
  stats,
  loading,
  error,
  fetchedAt,
}: {
  stats: ZphLiveStats | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}) {
  if (!stats) {
    return (
      <Card title="ZEPHYR PROTOCOL">
        <p className="gas-info" style={{ marginTop: 0 }}>
          {error
            ? `Couldn't reach scanner API: ${error}`
            : loading
              ? "Loading live protocol stats…"
              : "Waiting for first snapshot…"}
        </p>
      </Card>
    );
  }

  const worst = worstOfRatio(stats);
  const band = classifyReserveRatio(worst);
  const bandColor = BAND_COLORS[band];
  const bandLabel = BAND_LABELS[band];

  const cellStyle: React.CSSProperties = {
    padding: "6px 0",
    fontFamily: "var(--mono)",
    fontSize: 11,
  };
  const labelStyle: React.CSSProperties = {
    ...cellStyle,
    color: "var(--text-dim)",
  };
  const valueStyle: React.CSSProperties = {
    ...cellStyle,
    textAlign: "right",
  };

  return (
    <Card
      title="ZEPHYR PROTOCOL"
      right={
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 9,
            color: "var(--text-dim)",
          }}
          title={
            fetchedAt
              ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}`
              : undefined
          }
        >
          {loading ? "(refreshing…)" : `updated ${fmtAge(fetchedAt)}`}
        </span>
      }
    >
      {/* Reserve-ratio block — the headline number */}
      <div
        style={{
          padding: "10px 12px",
          marginBottom: 10,
          border: `1px solid ${bandColor}`,
          borderRadius: 2,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              letterSpacing: 0.8,
              color: "var(--text-dim)",
            }}
          >
            RESERVE RATIO
          </span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 9,
              letterSpacing: 1,
              color: bandColor,
            }}
          >
            {bandLabel}
          </span>
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 26,
            color: bandColor,
            marginTop: 2,
            letterSpacing: 1,
          }}
        >
          {fmtPercent(stats.reserve_ratio)}
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            marginTop: 2,
          }}
        >
          24h MA: {fmtPercent(stats.reserve_ratio_ma)} · gates use{" "}
          {fmtPercent(worst)} (worst-of)
        </div>
      </div>

      {/* Reserve detail */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={labelStyle}>ZEPH in reserve</td>
            <td style={valueStyle}>
              {fmtSupply(stats.zeph_in_reserve)} ZEPH
              <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>
                ({fmtUsd(stats.zeph_in_reserve_value)})
              </span>
            </td>
          </tr>
          <tr>
            <td style={labelStyle}>ZSD circulating</td>
            <td style={valueStyle}>{fmtSupply(stats.zsd_circ)} ZSD</td>
          </tr>
          <tr>
            <td style={labelStyle}>ZRS circulating</td>
            <td style={valueStyle}>{fmtSupply(stats.zrs_circ)} ZRS</td>
          </tr>
          <tr>
            <td style={labelStyle}>ZYS circulating</td>
            <td style={valueStyle}>{fmtSupply(stats.zys_circ)} ZYS</td>
          </tr>
          <tr>
            <td style={labelStyle}>ZSD in yield reserve</td>
            <td style={valueStyle}>
              {fmtSupply(stats.zsd_in_yield_reserve)} ZSD
            </td>
          </tr>
        </tbody>
      </table>

      {/* Oracle prices */}
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: 0.5,
            color: "var(--text-dim)",
            marginBottom: 4,
          }}
        >
          ORACLE PRICES (USD)
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={labelStyle}>ZEPH</td>
              <td style={valueStyle}>{fmtUsd(stats.zeph_price)}</td>
              <td style={labelStyle}>ZSD</td>
              <td style={valueStyle}>{fmtUsd(stats.zsd_price)}</td>
            </tr>
            <tr>
              <td style={labelStyle}>ZRS</td>
              <td style={valueStyle}>{fmtUsd(stats.zrs_price)}</td>
              <td style={labelStyle}>ZYS</td>
              <td style={valueStyle}>{fmtUsd(stats.zys_price)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ZYS APY */}
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: 0.5,
            color: "var(--text-dim)",
          }}
        >
          ZYS VARIABLE APY
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 14,
            color: "var(--success, #4ad97a)",
          }}
        >
          {stats.zys_current_variable_apy.toFixed(2)}%
        </span>
      </div>

      <p className="gas-info" style={{ marginTop: 8, marginBottom: 0, fontSize: 9 }}>
        Source: zephyrprotocol.com scanner API. Cached server-side ~30s.
      </p>
    </Card>
  );
}
