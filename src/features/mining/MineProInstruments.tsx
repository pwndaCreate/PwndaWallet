/**
 * src/features/mining/MineProInstruments.tsx
 *
 * The PRO console's instrument block — canvas frame 3b.
 *
 * # What 3b is, and what it is not
 *
 * The frame's own label is the brief: *"MINE · PRO expanded — same page,
 * console instruments slide in; nothing from today's UI is lost."* So this is
 * a re-ARRANGEMENT, not a replacement. It renders the numbers a tuning user
 * came for, in the order the mock puts them:
 *
 *   header strip     coin · algo, the CPU/LOAD/threads chip, live rate + uptime,
 *                    the projected balance pinned right, and the way back
 *   row 1            hashrate chart | ACCEPTED / REJECTED / SHARES·MIN /
 *                    POOL DIFF tiles, then per-hour/day/month projections
 *   row 2            pool card (+ amber unreachable strip) | STOP | EARN promo
 *
 * # What is deliberately absent, and where it went
 *
 * 3b shows no coin picker and no hardware selector. That is coherent rather
 * than lossy: SIMPLE owns the CONTROLS (which coin, which lane, which load)
 * and PRO owns the INSTRUMENTS, with `◂ SIMPLE` as the way back. The header's
 * `CPU · MED · 32T` chip reports that state read-only.
 *
 * The panels 3b does not draw — proxy mode, the device profile, the miner
 * console toggle — are still rendered by `MineLandscapeView` BELOW this block.
 * The operator's instruction was explicit about not "hiding any data", and the
 * mock leaves that area empty anyway, so nothing had to be cut to match it.
 *
 * # Amber, not red
 *
 * A pool that cannot be reached is retrying, not broken: the strip is
 * `--warn`, with RETRY and SWITCH POOL beside it. Red stays reserved for
 * states the user cannot recover from, per the handoff.
 */
import type { ReactNode } from "react";
import { MicroLabel, Mark, Panel } from "./components/mine-simple";

const mono = { fontFamily: "var(--font-mono)" } as const;

export function StatTile({
  label,
  value,
  tone = "text",
}: {
  label: string;
  value: string;
  tone?: "text" | "accent" | "warn";
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "10px 12px",
        flex: 1,
        minWidth: 0,
      }}
    >
      <MicroLabel>{label}</MicroLabel>
      <div
        style={{
          ...mono,
          fontSize: 17,
          marginTop: 6,
          fontVariantNumeric: "tabular-nums",
          color:
            tone === "accent"
              ? "var(--accent)"
              : tone === "warn"
                ? "var(--warn)"
                : "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** `PER HOUR / PER DAY / PER MONTH`, right-aligned like the mock. */
export function ProjectionRows({
  rows,
}: {
  rows: readonly { label: string; value: string }[];
}) {
  return (
    <Panel pad="10px 12px">
      {rows.map((r) => (
        <div
          key={r.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 10,
            padding: "3px 0",
          }}
        >
          <MicroLabel>{r.label}</MicroLabel>
          <span
            style={{
              ...mono,
              fontSize: 10,
              color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </Panel>
  );
}

/**
 * `pool unreachable · retrying in Ns` — amber, with the two actions.
 *
 * Renders only when there is something to say. An always-present strip that
 * usually reads "ok" is noise; this is an exception surface.
 */
export function PoolTroubleStrip({
  message,
  onRetry,
  onSwitchPool,
}: {
  message: string;
  onRetry?: () => void;
  onSwitchPool?: () => void;
}) {
  const btn = {
    ...mono,
    border: "1px solid rgba(255,170,0,0.4)",
    background: "transparent",
    color: "var(--warn)",
    padding: "2px 9px",
    fontSize: 8,
    letterSpacing: 1,
    textTransform: "uppercase" as const,
    cursor: "pointer",
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 8,
        border: "1px solid rgba(255,170,0,0.4)",
        background: "rgba(255,170,0,0.06)",
        padding: "6px 10px",
      }}
    >
      <Mark tone="warn" size={7} pulse />
      <span style={{ ...mono, flex: 1, fontSize: 9, color: "var(--warn)" }}>
        {message}
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry} style={btn}>
          retry
        </button>
      )}
      {onSwitchPool && (
        <button type="button" onClick={onSwitchPool} style={btn}>
          switch pool
        </button>
      )}
    </div>
  );
}

/** The header strip: identity left, state middle, balance + way-back right. */
export function ProHeader({
  coinLabel,
  algoLabel,
  hardwareChip,
  running,
  rateLabel,
  uptimeLabel,
  right,
}: {
  coinLabel: ReactNode;
  algoLabel: string;
  hardwareChip: string;
  running: boolean;
  rateLabel: string | null;
  uptimeLabel: string;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        flex: "none",
        flexWrap: "wrap",
        ...mono,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--text)" }}>{coinLabel}</span>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>·</span>
      <span style={{ fontSize: 11, color: "var(--text)" }}>{algoLabel}</span>
      <span
        style={{
          border: "1px solid var(--border)",
          color: "var(--text-dim)",
          padding: "2px 8px",
          fontSize: 8,
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {hardwareChip}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 9,
          color: running ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        <Mark tone={running ? "accent" : "dim"} size={7} pulse={running} />
        {running ? `${rateLabel ?? "—"} · uptime ${uptimeLabel}` : "idle"}
      </span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}
