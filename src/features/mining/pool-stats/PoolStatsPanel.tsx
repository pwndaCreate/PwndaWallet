import { useEffect, useState } from "react";
import type { ChainType } from "../../../wallets";
import { getCoinMeta } from "../../../wallets/coin-metadata";
import type { PoolDef } from "../pools";
import type { MinerStats } from "./types";
import { formatAtomic, formatHashrate, formatRelative } from "./format";

interface Props {
  coin: ChainType;
  pool: PoolDef;
  stats: MinerStats | null;
  loading: boolean;
  error: string | null;
  /** True when the panel was just mounted and we haven't decided to poll yet. */
  awaitingOptIn: boolean;
  onShowStats: () => void;
  onRefresh: () => void;
  /** Optional callback to switch pools. When provided, the error
   *  surface exposes a "Try another pool" affordance. When omitted,
   *  the affordance falls back to focusing the `#mining-pool-select`
   *  element via DOM lookup. */
  onSwitchPool?: () => void;
}

/**
 * Categorize a raw error string from the pool-stats fetch into a
 * short, plain-language summary the user can act on. The full URL +
 * wallet address that some adapters embed in their error messages
 * must NEVER reach the rendered DOM — that's a privacy hazard
 * (clipboard-malware verification + screenshare leakage) and the
 * raw text spills off the panel besides. Categorization is a pure
 * function of the error string; bespoke per-pool failure modes go
 * here too.
 */
function categorizePoolError(raw: string): {
  short: string;
  hint: string | null;
  kind:
    | "submit-first-share"
    | "network-unreachable"
    | "timeout"
    | "tls"
    | "rate-limited"
    | "pool-5xx"
    | "pool-4xx"
    | "unknown";
} {
  const r = raw.toLowerCase();
  if (/(not\s*found|no\s*records|address\s*not\s*registered)/i.test(raw)) {
    return {
      kind: "submit-first-share",
      short: "No stats yet — submit your first share to populate.",
      hint: null,
    };
  }
  if (
    r.includes("sending request") ||
    r.includes("connect") ||
    r.includes("dns") ||
    r.includes("network") ||
    r.includes("unreachable") ||
    r.includes("blocked")
  ) {
    return {
      kind: "network-unreachable",
      short: "Pool is unreachable from your network right now.",
      hint:
        "Your firewall, VPN, or antivirus may be blocking the pool's API. Try toggling proxy mode in Settings, or pick another pool from the dropdown.",
    };
  }
  if (r.includes("timed out") || r.includes("timeout")) {
    return {
      kind: "timeout",
      short: "Pool API timed out.",
      hint: "Usually a transient pool-side hiccup. Retry in a moment; if it persists, try another pool.",
    };
  }
  if (r.includes("tls") || r.includes("certificate") || r.includes("ssl")) {
    return {
      kind: "tls",
      short: "TLS handshake with the pool failed.",
      hint: "Some networks (corporate / school) inspect HTTPS traffic and break the certificate chain. Try another pool, or use proxy mode.",
    };
  }
  if (r.includes("429") || r.includes("rate limit") || r.includes("too many requests")) {
    return {
      kind: "rate-limited",
      short: "Pool is rate-limiting requests.",
      hint: "Wait ~60 seconds and click Retry. Pool stats refresh on a slower cadence than the dashboard.",
    };
  }
  const status5xx = raw.match(/\b(50\d|5\d{2})\b/);
  if (status5xx) {
    return {
      kind: "pool-5xx",
      short: `Pool API returned ${status5xx[0]} — outage on their side.`,
      hint: "Nothing you can do but wait. If you want stats now, try another pool.",
    };
  }
  const status4xx = raw.match(/\b40\d|4\d{2}\b/);
  if (status4xx) {
    return {
      kind: "pool-4xx",
      short: `Pool API returned ${status4xx[0]}.`,
      hint: "The pool didn't recognize your request — usually means your worker hasn't registered yet. Mine a share and Retry.",
    };
  }
  return {
    kind: "unknown",
    short: "Couldn't load pool stats.",
    hint: null,
  };
}

/**
 * Strip URLs, query strings, long hex (wallet addresses), and
 * collapse whitespace so the tooltip-detail row stays one line and
 * never leaks the user's payout address. Empty string is OK — the
 * tooltip just shows the short categorized message in that case.
 */
function redactErrorForTooltip(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\b[a-fA-F0-9]{30,}\b/g, "[address]")
    .replace(/\b(addr(?:ess)?|wallet)=[^\s&)]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

/**
 * Renders pending balance / immature / hashrate / shares / workers for the
 * (coin, pool) pair currently selected in the Mining view. Behaviour is
 * pool-agnostic — all source-pool quirks live in the adapter that produced
 * `stats`.
 */
export function PoolStatsPanel(props: Props) {
  const {
    coin,
    pool,
    stats,
    loading,
    error,
    awaitingOptIn,
    onShowStats,
    onRefresh,
    onSwitchPool,
  } = props;
  const ticker = getCoinMeta(coin).ticker;

  const handleSwitchPool = () => {
    if (onSwitchPool) {
      onSwitchPool();
      return;
    }
    // Fallback: focus the pool selector by id. Caller (MiningView)
    // mounts the <select> with id="mining-pool-select"; this avoids
    // having to thread a callback through every consumer of the
    // panel just for the error CTA.
    if (typeof document === "undefined") return;
    const el = document.getElementById("mining-pool-select");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Brief delay so the scroll completes before the focus ring lands.
      window.setTimeout(() => (el as HTMLElement).focus(), 220);
    }
  };

  // Tick "Xs ago" labels every 5s so they don't go stale visually.
  const [, force] = useState(0);
  useEffect(() => {
    if (!stats) return;
    const t = setInterval(() => force((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [stats]);

  if (awaitingOptIn) {
    return (
      <div style={panelStyle}>
        <Header pool={pool} loading={false} onRefresh={null} />
        <div style={hintStyle}>
          Live stats from {pool.name} aren't fetched until you opt in
          (your address is sent to the pool to look up your balance).
        </div>
        <button type="button" style={primaryBtnStyle} onClick={onShowStats}>
          Show pool stats
        </button>
      </div>
    );
  }

  if (!stats && loading) {
    return (
      <div style={panelStyle}>
        <Header pool={pool} loading onRefresh={onRefresh} />
        <div style={hintStyle}>Fetching from {pool.name}…</div>
      </div>
    );
  }

  if (!stats && error) {
    // Reported 2026-05-16: the prior implementation interpolated the
    // raw error string directly, which on hashvault.pro contained a
    // wallet-address-bearing URL that spilled multi-line off the
    // panel. New behaviour: categorize → short summary + optional
    // hint + Retry + "Try another pool". Full error stays available
    // in the `title=` tooltip (sanitized).
    const categorized = categorizePoolError(error);
    const tooltip = `Raw: ${redactErrorForTooltip(error)}`;
    const isSubmitFirstShare = categorized.kind === "submit-first-share";
    return (
      <div style={panelStyle}>
        <Header pool={pool} loading={false} onRefresh={onRefresh} />
        <div style={errorTitleStyle} title={tooltip}>
          {categorized.short}
        </div>
        {categorized.hint && (
          <div style={errorHintStyle}>{categorized.hint}</div>
        )}
        {!isSubmitFirstShare && (
          <div style={errorActionRowStyle}>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              style={errorBtnStyle}
              title="Retry the pool-stats fetch now."
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
            <button
              type="button"
              onClick={handleSwitchPool}
              style={errorBtnSecondaryStyle}
              title="Jump to the pool dropdown so you can pick a different one."
            >
              Try another pool
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const payoutThreshold = stats.payoutThreshold;
  const balanceLabel = `${formatAtomic(stats.pendingBalance, coin)} ${ticker}`;
  const minPayoutLabel = payoutThreshold
    ? `min ${formatAtomic(payoutThreshold, coin)} ${ticker}`
    : `min ${pool.minPayout}`;

  const hashrateAvgs = [
    stats.hashrate1h !== null ? ["1h", formatHashrate(stats.hashrate1h)] : null,
    stats.hashrate6h !== null ? ["6h", formatHashrate(stats.hashrate6h)] : null,
    stats.hashrate24h !== null ? ["24h", formatHashrate(stats.hashrate24h)] : null,
  ].filter((x): x is [string, string] => x !== null);

  const showShares =
    stats.validShares !== null ||
    stats.invalidShares !== null ||
    stats.staleShares !== null;

  return (
    <div style={panelStyle}>
      <Header pool={pool} loading={loading} onRefresh={onRefresh} />

      <Row
        label="Pending"
        value={balanceLabel}
        sub={minPayoutLabel}
      />

      {stats.immatureBalance && stats.immatureBalance !== "0" && (
        <Row
          label="Maturing"
          value={`${formatAtomic(stats.immatureBalance, coin)} ${ticker}`}
        />
      )}

      {stats.totalPaid && (
        <Row
          label="Paid (lifetime)"
          value={`${formatAtomic(stats.totalPaid, coin)} ${ticker}`}
        />
      )}

      <Row
        label="Hashrate"
        value={stats.hashrate === 0 ? "Collecting…" : formatHashrate(stats.hashrate)}
        sub={
          hashrateAvgs.length > 0
            ? hashrateAvgs.map(([k, v]) => `${k}: ${v}`).join("  ·  ")
            : undefined
        }
      />

      {showShares && (
        <Row
          label="Shares"
          value={`${stats.validShares ?? "—"} valid${
            stats.invalidShares !== null ? ` / ${stats.invalidShares} invalid` : ""
          }${stats.staleShares !== null ? ` / ${stats.staleShares} stale` : ""}`}
        />
      )}

      {stats.lastShare !== null && (
        <Row label="Last share" value={formatRelative(stats.lastShare)} />
      )}

      {stats.workersOnline !== null && stats.workersOnline > 0 && (
        <Row
          label="Workers"
          value={`${stats.workersOnline} online`}
        />
      )}

      <div style={footerStyle}>
        Updated {formatRelative(stats.fetchedAt)}
        {error && <span style={{ color: "var(--danger, #f55)", marginLeft: 8 }}>· retry pending</span>}
      </div>
    </div>
  );
}

function Header({
  pool,
  loading,
  onRefresh,
}: {
  pool: PoolDef;
  loading: boolean;
  onRefresh: (() => void) | null;
}) {
  return (
    <div style={headerStyle}>
      <span>{pool.name} stats</span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          style={refreshBtnStyle}
          title="Refresh now"
        >
          {loading ? "…" : "↻"}
        </button>
      )}
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={rowStyle}>
      <span style={rowLabelStyle}>{label}</span>
      <span style={rowValueStyle}>
        {value}
        {sub && <span style={rowSubStyle}>{sub}</span>}
      </span>
    </div>
  );
}

// Inline styles match the existing terminal/hacktivist design tokens used
// elsewhere in the Mining view (var(--mono), var(--text-dim), etc.).

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.04)",
  padding: "10px 12px",
  fontFamily: "var(--mono)",
  fontSize: 10,
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 9,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: 0.8,
  marginBottom: 2,
};

const refreshBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "var(--text-dim)",
  fontFamily: "var(--mono)",
  fontSize: 11,
  padding: "1px 8px",
  cursor: "pointer",
  lineHeight: 1,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
};

const rowLabelStyle: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

const rowValueStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  textAlign: "right",
};

const rowSubStyle: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 8,
  marginTop: 2,
};

const footerStyle: React.CSSProperties = {
  marginTop: 4,
  paddingTop: 6,
  borderTop: "1px dashed rgba(255,255,255,0.08)",
  color: "var(--text-dim)",
  fontSize: 8,
  letterSpacing: 0.5,
};

const hintStyle: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 9,
  lineHeight: 1.5,
};

const errorTitleStyle: React.CSSProperties = {
  color: "var(--danger, #f55)",
  fontSize: 10,
  lineHeight: 1.4,
  fontWeight: 500,
  // Prevent the title line from blowing the panel out horizontally if
  // a future error-string sneaks past the short-message categorizer.
  // The categorizer's `.slice(0, 220)` already caps the tooltip; this
  // belt-and-suspenders cap applies to the visible cell too.
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "normal",
  wordBreak: "break-word",
  cursor: "help",
};

const errorHintStyle: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 9,
  lineHeight: 1.5,
  marginTop: 2,
};

const errorActionRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 6,
  flexWrap: "wrap",
};

const errorBtnStyle: React.CSSProperties = {
  background: "rgba(0,255,102,0.06)",
  border: "1px solid rgba(0,255,102,0.45)",
  color: "var(--accent, #00ff66)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  padding: "3px 10px",
  cursor: "pointer",
  letterSpacing: 0.4,
};

const errorBtnSecondaryStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "var(--text-dim)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  padding: "3px 10px",
  cursor: "pointer",
  letterSpacing: 0.4,
};

const primaryBtnStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "6px 10px",
  background: "rgba(242,242,242,0.9)",
  border: "1px solid rgba(242,242,242,0.9)",
  color: "#0a0a0a",
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: 0.5,
  cursor: "pointer",
};
