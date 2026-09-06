/**
 * src/features/swap/components/p2p-ui.tsx
 *
 * The P2P "easy mode" instruments (canvas frames 1c landscape / 1f portrait).
 *
 * The redesign's thesis for this surface: the BasicSwap taker flow was
 * carrying its meaning in paragraphs — a spread verdict sentence, a
 * not-routable explanation, a refund education block, a transport notice.
 * Every one of those becomes an instrument here: a count, a gauge, a step
 * arc, a chip. The honesty content itself is NOT dropped (it is the
 * product's voice and, for refunds, load-bearing safety information) — it is
 * re-encoded so it can be read at a glance and cannot be skipped as prose.
 *
 * Shared by both layouts on purpose; see `swap-ui.tsx`'s header for why a
 * second copy of any of this would be a parity bug.
 */
import type { CSSProperties, ReactNode } from "react";
import { StatusSquare, HollowSquare } from "./swap-ui";

/* ─────────────────────────────────────────────────────────────
 * Offer book, as a count and a row of cells
 * ───────────────────────────────────────────────────────────── */

/** Quality band of a single offer, relative to the reference market rate. */
export type OfferBand = "good" | "mid" | "poor";

/**
 * `OFFERS` instrument: the number, then one cell per offer.
 *
 * Bands mirror `swap-sidecar/spread.ts`'s thresholds exactly — green within
 * `SPREAD_GREEN_MAX_PCT` (1%), amber to `SPREAD_AMBER_MAX_PCT` (5%), hollow
 * beyond. They are *derived* from the same numbers the confirm modal gates
 * on, never a second opinion about what counts as a good price.
 */
export function OffersInstrument({
  total,
  bands,
  maxCells = 12,
  caption = "ranked by price · best first",
  style,
}: {
  total: number;
  bands: readonly OfferBand[];
  maxCells?: number;
  caption?: string;
  style?: CSSProperties;
}) {
  const cells = bands.slice(0, maxCells);
  // Always draw a full row so the instrument reads as a gauge with capacity
  // rather than a list that happens to be short.
  const pad = Math.max(0, maxCells - cells.length);
  return (
    <div
      style={{
        flex: 1,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "10px 12px",
        fontFamily: "var(--mono)",
        minWidth: 0,
        ...style,
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
            fontSize: 8,
            color: "var(--text-dim)",
            letterSpacing: 1.5,
            textTransform: "uppercase",
          }}
        >
          offers
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--white)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {total}
        </span>
      </div>
      <div style={{ display: "flex", gap: 3, marginTop: 8, flexWrap: "wrap" }}>
        {cells.map((b, i) =>
          b === "poor" ? (
            <HollowSquare key={i} size={11} />
          ) : (
            <StatusSquare
              key={i}
              size={11}
              color={b === "good" ? "var(--accent)" : "rgba(255,170,0,0.75)"}
            />
          ),
        )}
        {Array.from({ length: pad }, (_, i) => (
          <HollowSquare key={`pad-${i}`} size={11} />
        ))}
      </div>
      <div
        style={{
          fontSize: 8,
          color: "var(--text-dim)",
          letterSpacing: 0.8,
          marginTop: 7,
          textTransform: "uppercase",
        }}
      >
        {caption}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Rate vs market — the spread gate as a gauge
 * ───────────────────────────────────────────────────────────── */

/**
 * `RATE VS MARKET`: a three-band gauge with a needle at the current spread.
 *
 * The bands are proportional to the thresholds they encode (1% green,
 * 1–5% amber, >5% red), so the needle's position is literally the number.
 * When the market price could not be read at all, `unverified` paints the
 * whole track neutral and the needle is withheld — the mock's way of saying
 * what the old copy said with "the wallet could not compare this offer to a
 * reference price", without pretending to a measurement it does not have.
 */
export function RateVsMarketGauge({
  spreadPct,
  unverified = false,
  style,
}: {
  /** Positive = worse than market (overpaying). Null when unknown. */
  spreadPct: number | null;
  unverified?: boolean;
  style?: CSSProperties;
}) {
  // Track is 1 : 2 : 3 flex units covering 0–1%, 1–5%, 5%+.
  const needlePct = (() => {
    if (spreadPct == null) return null;
    const s = Math.max(0, spreadPct);
    if (s <= 1) return (s / 1) * (1 / 6) * 100;
    if (s <= 5) return (1 / 6 + ((s - 1) / 4) * (2 / 6)) * 100;
    return Math.min(98, (3 / 6 + Math.min(1, (s - 5) / 10) * (3 / 6)) * 100);
  })();

  const headline =
    spreadPct == null
      ? "—"
      : `${spreadPct > 0 ? "+" : ""}${spreadPct.toFixed(1)}%`;
  const headlineColor =
    spreadPct == null || unverified
      ? "var(--text-dim)"
      : spreadPct <= 1
        ? "var(--accent)"
        : spreadPct <= 5
          ? "var(--warn)"
          : "var(--danger)";

  return (
    <div
      style={{
        flex: 1.2,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "10px 12px",
        fontFamily: "var(--mono)",
        minWidth: 0,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 8,
            color: "var(--text-dim)",
            letterSpacing: 1.5,
            textTransform: "uppercase",
          }}
        >
          rate vs market
        </span>
        <span
          style={{
            fontSize: 12,
            color: headlineColor,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {unverified ? "unverified" : headline}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          marginTop: 12,
          height: 6,
          display: "flex",
        }}
      >
        <span
          style={{
            flex: 1,
            background: unverified
              ? "var(--border-soft)"
              : "rgba(0,255,102,0.30)",
          }}
        />
        <span
          style={{
            flex: 2,
            background: unverified
              ? "var(--border-soft)"
              : "rgba(255,170,0,0.22)",
          }}
        />
        <span
          style={{
            flex: 3,
            background: unverified
              ? "var(--border-soft)"
              : "rgba(255,59,59,0.16)",
          }}
        />
        {needlePct != null && !unverified && (
          <span
            style={{
              position: "absolute",
              left: `${needlePct}%`,
              top: -3,
              width: 3,
              height: 12,
              background: headlineColor,
              boxShadow: `0 0 5px ${headlineColor}`,
            }}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          fontSize: 7,
          color: "var(--text-dim)",
          marginTop: 5,
          letterSpacing: 0.5,
        }}
      >
        <span style={{ flex: 1 }}>0</span>
        <span style={{ flex: 2 }}>1%</span>
        <span
          style={{ flex: 3, display: "flex", justifyContent: "space-between" }}
        >
          <span>5%</span>
          <span>OVERPAYING →</span>
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * In-progress tracker — six steps as an arc
 * ───────────────────────────────────────────────────────────── */

export interface TrackerStep {
  key: string;
  label: string;
}

/**
 * The six canonical taker steps, in order.
 *
 * These labels are the ones `swap-sidecar/bidStates.ts` already surfaces
 * (`Bid sent to the other user` → `Done`), lowercased to the mock's voice.
 * Keeping the ORDER identical to `bidStates` matters: the tracker's job is
 * to say where the swap is, and a step list that disagrees with the state
 * machine is worse than no list.
 */
export const P2P_TRACKER_STEPS: readonly TrackerStep[] = [
  { key: "requesting", label: "bid sent" },
  { key: "accepted", label: "bid accepted" },
  { key: "locking", label: "locking your funds" },
  { key: "waiting-counterparty", label: "waiting for the other user" },
  { key: "finalising", label: "finalising" },
  { key: "done", label: "done" },
];

export function TrackerArc({
  steps = P2P_TRACKER_STEPS,
  activeIndex,
}: {
  steps?: readonly TrackerStep[];
  /** Index of the current step; everything before it reads as done. */
  activeIndex: number;
}) {
  return (
    <div>
      {steps.map((s, i) => {
        const done = i < activeIndex;
        const now = i === activeIndex;
        return (
          <div key={s.key}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              {done || now ? (
                <StatusSquare size={10} pulse={now} />
              ) : (
                <HollowSquare size={10} />
              )}
              <span
                style={{
                  fontSize: 10,
                  color: now
                    ? "var(--white)"
                    : done
                      ? "var(--text)"
                      : "var(--text-dim)",
                  fontFamily: "var(--mono)",
                }}
              >
                {s.label}
              </span>
              {now && (
                <>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      fontSize: 8,
                      color: "var(--accent)",
                      letterSpacing: 1,
                      fontFamily: "var(--mono)",
                    }}
                  >
                    NOW
                  </span>
                </>
              )}
            </div>
            {i < steps.length - 1 && (
              <div
                style={{
                  width: 1,
                  height: 12,
                  background: done ? "var(--accent)" : "var(--border-soft)",
                  marginLeft: 5,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The framed tracker panel: pair header + elapsed timer + arc + controls.
 *
 * `elapsed` is passed in rather than ticked here so the 1 Hz re-render lives
 * in exactly one place. That is not style: `MiningView` measured ~43k
 * re-renders and multi-gigabyte WebView2 growth from an inline 1 Hz timer
 * over one overnight session, and a P2P swap runs 30–90 minutes.
 */
export function TrackerPanel({
  title = "in progress",
  fromTicker,
  toTicker,
  fromAmount,
  toAmount,
  elapsed,
  activeIndex,
  transportLabel,
  onCheckNow,
  onBackground,
  footNote,
  checking = false,
}: {
  title?: string;
  fromTicker: string;
  toTicker: string;
  fromAmount: string;
  toAmount: string;
  /** Pre-formatted HH:MM:SS. */
  elapsed: string;
  activeIndex: number;
  transportLabel: string;
  onCheckNow?: () => void;
  onBackground?: () => void;
  footNote?: ReactNode;
  checking?: boolean;
}) {
  return (
    <div style={{ fontFamily: "var(--mono)" }}>
      <div
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 2,
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-soft)",
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: "var(--text)",
              fontVariantNumeric: "tabular-nums",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fromAmount} {fromTicker} → {toAmount} {toTicker}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--warn)",
              fontVariantNumeric: "tabular-nums",
              flex: "none",
            }}
          >
            {elapsed}
          </span>
        </div>

        <div style={{ padding: "12px 14px" }}>
          <TrackerArc activeIndex={activeIndex} />

          <div
            style={{
              fontSize: 8,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
              marginTop: 12,
            }}
          >
            {transportLabel}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={onCheckNow}
              disabled={checking || !onCheckNow}
              style={{
                flex: 1,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text)",
                padding: "7px 0",
                fontFamily: "var(--mono)",
                fontSize: 9,
                letterSpacing: 1,
                textTransform: "uppercase",
                cursor: onCheckNow && !checking ? "pointer" : "not-allowed",
                opacity: onCheckNow && !checking ? 1 : "var(--disabled-opacity, 0.4)",
              }}
            >
              {checking ? "checking…" : "check now"}
            </button>
            <button
              type="button"
              onClick={onBackground}
              disabled={!onBackground}
              style={{
                flex: 1,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text)",
                padding: "7px 0",
                fontFamily: "var(--mono)",
                fontSize: 9,
                letterSpacing: 1,
                textTransform: "uppercase",
                cursor: onBackground ? "pointer" : "not-allowed",
                opacity: onBackground ? 1 : "var(--disabled-opacity, 0.4)",
              }}
            >
              background
            </button>
          </div>

          {footNote && (
            <div
              style={{
                fontSize: 8,
                color: "var(--text-dim)",
                marginTop: 10,
                lineHeight: 1.5,
              }}
            >
              {footNote}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Format seconds as HH:MM:SS for the tracker header. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
