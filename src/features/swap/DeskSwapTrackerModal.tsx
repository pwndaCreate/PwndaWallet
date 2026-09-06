/**
 * Tracker for an in-flight `pwnda-desk` atomic swap (the 8.1 state machine).
 *
 * ## This component owns NO protocol state
 *
 * The Rust engine is the source of truth for a desk swap. It observes both
 * chains itself, advances the state machine on its own confirmations, and keeps
 * a refund watcher armed until T1. This modal is a PURE VIEW over
 * `deskStatus` (per-swap poll) and the `DeskSwapSummary` the parent rehydrated
 * from `deskListActive`. It holds exactly four pieces of local state -- the last
 * status poll, a clock tick, and the abort button's in-flight/error pair -- and
 * not one byte of protocol material.
 *
 * That constraint is not stylistic. A desk swap runs 10-60 minutes and the user
 * will navigate away during it, so this component gets unmounted and remounted
 * repeatedly. Anything it cached would be lost on every tab switch and would
 * silently disagree with the engine on the way back. Mount it OUTSIDE the view
 * conditionals (see the module footer note) so closing it is a user action, not
 * a side effect of tapping a nav tab.
 *
 * ## Why the desk's status is only advice
 *
 * `deskStatus` is the DESK's opinion. The Rust engine never signs on it -- it
 * re-derives every gate from its own chain observation. So a desk that lies in
 * this payload can mislead the pixels here but cannot induce a signature. The
 * numbers below are therefore labelled as the desk's view, and the refund
 * countdown is computed from the ABSOLUTE `summary.t1` we persisted at accept
 * time rather than from the desk's own `t1Remaining` -- a desk that under-
 * reports the remaining time cannot talk the user out of waiting for a refund
 * that is genuinely coming.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Backdrop, Row, Stat, truncate } from "./modal-parts";
import { Btn, ProgressBar } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import {
  deskAbort,
  deskStatus,
  type DeskStatusView,
  type DeskSwapSummary,
} from "../../api/desk-rust";
import { deskAmountsFor, deskCoinsFor } from "./asset-capabilities";
// NOTE: `getSwapCoinMeta` (TICKER-keyed) -- deliberately NOT the ChainType-keyed
// `explorerTxUrl` from `wallets/explorers.ts`. The two share a name; the desk
// speaks tickers, and reaching for the wrong one yields a silently dead link.
import { getSwapCoinMeta } from "./swap-data";

/** Poll cadence for the desk's `/status` view. */
const POLL_MS = 10_000;
/** Countdown repaint cadence. */
const TICK_MS = 1_000;
/** Below this many seconds to T1, the refund bar turns amber. */
const REFUND_WARN_SECONDS = 300;

/** Glyphs, written as escapes so this file stays plain ASCII on disk. */
const GLYPH_DONE = "\u25CF"; // filled circle
const GLYPH_ACTIVE = "\u25CC"; // dotted circle
const GLYPH_PENDING = "\u25CB"; // hollow circle
const GLYPH_STOPPED = "\u00D7"; // multiplication sign
const GLYPH_ARROW = "\u2192"; // rightwards arrow

/**
 * States the engine will never leave. Both intervals below are disabled once
 * the swap reaches one of these -- a settled swap that keeps polling forever is
 * how a background tab ends up hammering the desk for the rest of the session.
 */
const TERMINAL_STATES = new Set(["SETTLED", "A_REFUNDED", "FAILED", "ABORTED"]);

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Which chain leg a step's txid lands on.
 *
 * Chain A is the LEADER leg (the scriptable / timelock-capable side) and chain
 * B is the FOLLOWER leg (the privacy coin locked into a joint 2-of-2). Same
 * convention as `amountA` / `amountB` in `DeskSwapSummary` -- see the trap
 * documented on `deskAmountsFor`.
 */
type StepChain = "A" | "B";

type StepTxField = "lockATxid" | "lockBTxid" | "claimATxid" | "sweepBTxid";

interface DeskStep {
  /** The 8.1 state this row represents. */
  state: string;
  label: string;
  /** Field on `DeskStatusView` holding this step's txid, if it has one. */
  txField: StepTxField | null;
  /** Prefix for the tx line, e.g. "lock A: ". */
  txLabel: string;
  chain: StepChain;
}

/**
 * The happy path, in order. Index in this array IS the progress ordinal --
 * `HAPPY_INDEX` below is derived from it so the two can never drift.
 */
const DESK_STEPS: DeskStep[] = [
  {
    state: "ACCEPTED",
    label: "Swap accepted, keys exchanged",
    txField: null,
    txLabel: "",
    chain: "A",
  },
  {
    state: "A_LOCKED",
    label: "Chain A locked",
    txField: "lockATxid",
    txLabel: "lock A: ",
    chain: "A",
  },
  {
    state: "B_LOCKED",
    label: "Chain B locked",
    txField: "lockBTxid",
    txLabel: "lock B: ",
    chain: "B",
  },
  {
    state: "READY",
    label: "Both locks confirmed",
    txField: null,
    txLabel: "",
    chain: "A",
  },
  {
    state: "A_CLAIMED",
    label: "Chain A claimed",
    txField: "claimATxid",
    txLabel: "claim A: ",
    chain: "A",
  },
  {
    state: "SETTLED",
    label: "Settled, chain B swept",
    txField: "sweepBTxid",
    txLabel: "sweep B: ",
    chain: "B",
  },
];

const HAPPY_INDEX: Record<string, number> = DESK_STEPS.reduce(
  (acc, s, i) => {
    acc[s.state] = i;
    return acc;
  },
  {} as Record<string, number>
);

/** Terminal accent colour for the headline and the branch rows. */
function terminalTone(state: string): string {
  if (state === "SETTLED") return "var(--accent)";
  if (state === "A_REFUNDED") return "var(--warn)";
  if (state === "FAILED" || state === "ABORTED") return "var(--danger)";
  return "var(--text)";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Seconds -> hh:mm:ss. Negative clamps to all zeros. */
function hhmmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s % 60)}`;
}

/**
 * Explorer URL for a ticker + hash, or null when we have no explorer or no
 * hash. `DeskStatusView` txid fields are typed `string` and arrive as "" when
 * absent, so this is a FALSY check on purpose -- a null check would let "" pass
 * and render a link to a URL ending in "/tx/".
 */
function explorerFor(ticker: string | null, hash: string): string | null {
  if (!ticker || !hash) return null;
  const meta = getSwapCoinMeta(ticker);
  if (!meta) return null;
  return meta.explorerTxUrl(hash);
}

export function DeskSwapTrackerModal({
  open,
  summary,
  onClose,
  onTerminal,
}: {
  open: boolean;
  summary: DeskSwapSummary;
  onClose: () => void;
  onTerminal?: (state: string) => void;
}) {
  const [status, setStatus] = useState<DeskStatusView | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);

  const swapId = summary.swapId;

  // The engine-persisted summary is authoritative for the state the CLIENT has
  // committed to; the desk's poll is the fresher (but advisory) view. Prefer
  // the poll when we have one, fall back to the summary between mount and the
  // first response so the step list never renders blank.
  const state = status?.state || summary.state;
  const terminal = isTerminal(state);

  // -- Coins. Derived through the capability registry, never by splitting the
  // pair string here -- `splitDeskPair` is the single place allowed to do that.
  const coins = useMemo(
    () => deskCoinsFor(summary.pair, summary.direction),
    [summary.pair, summary.direction]
  );
  const amounts = useMemo(
    () =>
      deskAmountsFor({
        pair: summary.pair,
        direction: summary.direction,
        amountA: summary.amountA,
        amountB: summary.amountB,
      }),
    [summary.pair, summary.direction, summary.amountA, summary.amountB]
  );

  // Chain A is the leader leg, chain B the follower leg. `deskCoinsFor` hands
  // back in/out, so map back through the direction rather than re-deriving
  // roles from the registry a second time.
  const { leaderTicker, followerTicker } = useMemo(() => {
    if (!coins) return { leaderTicker: null, followerTicker: null };
    if (summary.direction === "SELL_FOLLOWER") {
      return { leaderTicker: coins.coinOut, followerTicker: coins.coinIn };
    }
    return { leaderTicker: coins.coinIn, followerTicker: coins.coinOut };
  }, [coins, summary.direction]);

  const tickerForChain = useCallback(
    (chain: StepChain) => (chain === "A" ? leaderTicker : followerTicker),
    [leaderTicker, followerTicker]
  );

  // -- Reset when the modal opens onto a different swap. Without this a stale
  // status from the previous swap paints for one poll interval.
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setAborting(false);
    setAbortError(null);
    setNowMs(Date.now());
  }, [open, swapId]);

  // -- Interval 1: the desk status poll.
  //
  // Gated three ways: not mounted-but-closed, not terminal, and cleared in the
  // cleanup. The effect re-runs on every state transition, which fires one
  // extra immediate poll at exactly the moment the view has the most to say.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await deskStatus(swapId);
        if (!cancelled) setStatus(next);
      } catch (e) {
        // A failed poll must not blank the tracker -- the engine is still
        // running and the last known status is better than nothing.
        console.warn("[desk-tracker] status poll failed", e);
      }
    };

    void poll();
    if (terminal) return () => { cancelled = true; };

    const id = setInterval(() => { void poll(); }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, swapId, terminal, state]);

  // -- Interval 2: the countdown tick. Same gating.
  useEffect(() => {
    if (!open || terminal) return;
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open, terminal]);

  // -- Terminal notification, fired once per swap id.
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!terminal) return;
    if (notifiedRef.current === swapId) return;
    notifiedRef.current = swapId;
    onTerminal?.(state);
  }, [terminal, state, swapId, onTerminal]);

  const handleAbort = useCallback(async () => {
    setAborting(true);
    setAbortError(null);
    try {
      await deskAbort(swapId, "user cancelled from tracker");
      // Pull the post-abort state immediately -- waiting a full poll interval
      // to learn the cancel worked reads as a hung button.
      const next = await deskStatus(swapId);
      setStatus(next);
    } catch (e) {
      setAbortError(e instanceof Error ? e.message : String(e));
    } finally {
      setAborting(false);
    }
  }, [swapId]);

  // -- Progress ordinals.
  //
  // For a happy state the ordinal is the state's own index. For a terminal
  // failure/refund we infer how far the swap actually got from the txids we
  // observed, and everything from that point on renders in the terminal tone
  // (the "branch point").
  const nowSec = Math.floor(nowMs / 1000);
  const happyIdx = HAPPY_INDEX[state];
  const inferredIdx = (() => {
    if (status?.sweepBTxid) return 5;
    if (status?.claimATxid) return 4;
    if (status?.lockBTxid) return 2;
    if (status?.lockATxid || summary.lockATxid) return 1;
    return 0;
  })();
  const branchIdx = happyIdx === undefined ? inferredIdx + 1 : DESK_STEPS.length;
  const currentIdx = happyIdx === undefined ? inferredIdx : happyIdx;
  // On a happy path the ACTIVE step is `currentIdx`, so everything strictly
  // before it is done. On a refund/abort branch there is no active step -- the
  // steps the swap genuinely completed run up TO the branch point, so the
  // threshold moves out by one. Without this, an ABORTED swap renders
  // "Swap accepted" as an un-started row, which is just false.
  const doneThreshold = happyIdx === undefined ? branchIdx : currentIdx;
  const settled = state === "SETTLED";
  const tone = terminalTone(state);

  // -- Refund countdown, from the ABSOLUTE t1 we persisted at accept time.
  const refundRemaining = summary.t1 - nowSec;
  const refundWindowStart =
    summary.t0 > 0 && summary.t0 < summary.t1 ? summary.t0 : summary.createdAt;
  const refundTotal = Math.max(1, summary.t1 - refundWindowStart);
  const refundElapsed = Math.max(
    0,
    Math.min(refundTotal, nowSec - refundWindowStart)
  );
  const refundPercent = (refundElapsed / refundTotal) * 100;
  const refundUrgent = refundRemaining < REFUND_WARN_SECONDS;

  // -- Abort eligibility. The desk 409s a cancel once either side has locked,
  // so offering the button post-lock would be a guaranteed error. Past that
  // point recovery is timeout-driven, not user-driven.
  const canAbort = state === "ACCEPTED";

  if (!open) return null;

  return (
    <Backdrop onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--bg-2)",
          border: "1px solid var(--border-hi)",
          padding: 22,
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "var(--accent)",
            }}
          >
            atomic swap
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            {GLYPH_STOPPED}
          </button>
        </div>

        {/* Amounts. Read through deskAmountsFor -- amountA/amountB are CHAIN
            legs, not in/out, and which is which flips with the direction. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            marginBottom: 10,
          }}
        >
          <CoinIcon sym={coins?.coinIn ?? ""} size={26} glow={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              you send
            </div>
            <div className="tnum" style={{ fontSize: 16, marginTop: 2 }}>
              {amounts?.amountIn ?? "?"}{" "}
              <span style={{ color: "var(--text-dim)" }}>
                {coins?.coinIn ?? ""}
              </span>
            </div>
          </div>
          <span style={{ color: "var(--text-dim)", fontSize: 14 }}>
            {GLYPH_ARROW}
          </span>
          <CoinIcon sym={coins?.coinOut ?? ""} size={26} glow={false} />
          <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
            <div
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              you receive
            </div>
            <div
              className="tnum"
              style={{ fontSize: 16, marginTop: 2, color: "var(--accent)" }}
            >
              {amounts?.amountOut ?? "?"}{" "}
              <span style={{ color: "var(--text-dim)" }}>
                {coins?.coinOut ?? ""}
              </span>
            </div>
          </div>
        </div>

        {/* Current state headline. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            background: "var(--surface)",
            border: `1px solid ${terminal ? tone : "var(--border)"}`,
            marginBottom: 10,
          }}
        >
          <span
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            state
          </span>
          <span
            className="tnum"
            style={{ color: terminal ? tone : "var(--accent)", fontSize: 12 }}
          >
            {state}
          </span>
        </div>

        <Row label="Swap id" value={truncate(swapId)} fullValue={swapId} />

        {/* -- Step list. Same idiom as SwapConfirmModal's ExecutingFooter:
            fixed-width glyph column, colour by done / active / pending. */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: 12,
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            Protocol
          </div>
          {DESK_STEPS.map((step, i) => {
            const branched = i >= branchIdx;
            const done = !branched && (settled || i < doneThreshold);
            const active = !branched && !terminal && i === currentIdx;
            const color = branched
              ? tone
              : active
                ? "var(--accent)"
                : done
                  ? "var(--text)"
                  : "var(--text-dim)";
            const glyph = branched
              ? GLYPH_STOPPED
              : done
                ? GLYPH_DONE
                : active
                  ? GLYPH_ACTIVE
                  : GLYPH_PENDING;

            // FALSY check, not a null check: DeskStatusView txids are `string`
            // and come back as "" when the desk has nothing to report.
            const hash = step.txField ? status?.[step.txField] || "" : "";
            const href = explorerFor(tickerForChain(step.chain), hash);

            return (
              <div key={step.state} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    color,
                  }}
                >
                  <span style={{ width: 12 }}>{glyph}</span>
                  <span>{step.label}</span>
                  {active && (
                    <span
                      style={{
                        color: "var(--accent)",
                        fontSize: 9,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        marginLeft: "auto",
                      }}
                    >
                      {"..."}
                    </span>
                  )}
                </div>
                {hash && (
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim)",
                      paddingLeft: 20,
                    }}
                  >
                    {step.txLabel}
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="tnum"
                        style={{ color: "var(--accent)" }}
                      >
                        {truncate(hash)}
                      </a>
                    ) : (
                      <span className="tnum">{truncate(hash)}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Refund / reclaim txids live off the happy path, so they get their
              own rows rather than a step. */}
          {status?.refundTxid ? (
            <TxLine
              label="refund: "
              hash={status.refundTxid}
              href={explorerFor(leaderTicker, status.refundTxid)}
            />
          ) : null}
          {status?.reclaimTxid ? (
            <TxLine
              label="reclaim: "
              hash={status.reclaimTxid}
              href={explorerFor(followerTicker, status.reclaimTxid)}
            />
          ) : null}
        </div>

        {/* -- Confirmations, as reported by the desk. */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: 12,
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 5,
            fontSize: 11,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 2,
            }}
          >
            Confirmations
          </div>
          <Stat
            k={`chain a${leaderTicker ? ` (${leaderTicker})` : ""}`}
            v={
              status
                ? `${status.confsA} / ${status.minConfsA}`
                : "-- / --"
            }
          />
          <Stat
            k={`chain b${followerTicker ? ` (${followerTicker})` : ""}`}
            v={
              status
                ? `${status.confsB} / ${status.minConfsB}`
                : "-- / --"
            }
          />
          <Stat k="ready ack" v={status?.readyAck ? "yes" : "no"} />
        </div>

        {/* -- Refund countdown. Absolute t1, not the desk's t1Remaining. */}
        {!terminal && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: 12,
              marginTop: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              fontSize: 11,
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
                  color: "var(--text-dim)",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  fontSize: 9,
                }}
              >
                {refundRemaining > 0
                  ? "refund available in"
                  : "refund deadline reached"}
              </span>
              <span
                className="tnum"
                style={{
                  color: refundUrgent ? "var(--warn)" : "var(--text)",
                  fontSize: 13,
                }}
              >
                {hhmmss(refundRemaining)}
              </span>
            </div>
            <ProgressBar
              percent={refundPercent}
              color={refundUrgent ? "var(--warn)" : "var(--accent)"}
              height={6}
            />
          </div>
        )}

        {/* -- Desk-reported error, if any. */}
        {status?.error ? (
          <div
            style={{
              marginTop: 10,
              padding: "10px 12px",
              background: "rgba(255,59,59,0.08)",
              border: "1px solid rgba(255,59,59,0.4)",
              color: "var(--danger)",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {status.error}
          </div>
        ) : null}

        {/* -- Cancel vs. the post-lock explanation. */}
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {!terminal && !canAbort && (
            <div
              style={{
                padding: "10px 12px",
                background: "rgba(255,170,0,0.08)",
                border: "1px solid rgba(255,170,0,0.4)",
                color: "var(--warn)",
                fontSize: 10,
                lineHeight: 1.5,
              }}
            >
              This swap has locked, so it can no longer be cancelled. If the
              counterparty stops responding, recovery happens automatically at
              the refund deadline above and your funds return to your refund
              address. Keep the app running until then so the refund watcher can
              broadcast.
            </div>
          )}
          {abortError && (
            <div
              style={{
                padding: "10px 12px",
                background: "rgba(255,59,59,0.08)",
                border: "1px solid rgba(255,59,59,0.4)",
                color: "var(--danger)",
                fontSize: 11,
                lineHeight: 1.4,
              }}
            >
              {abortError}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" full caret={false} onClick={onClose}>
              {terminal ? "Close" : "Run in background"}
            </Btn>
            {!terminal && canAbort && (
              <Btn
                variant="danger"
                full
                caret={false}
                disabled={aborting}
                onClick={() => { void handleAbort(); }}
              >
                {aborting ? "Cancelling" : "Cancel swap"}
              </Btn>
            )}
          </div>
        </div>
      </div>
    </Backdrop>
  );
}

/** Off-happy-path tx line (refund / reclaim). Same shape as a step's tx line. */
function TxLine({
  label,
  hash,
  href,
}: {
  label: string;
  hash: string;
  href: string | null;
}) {
  return (
    <div style={{ fontSize: 10, color: "var(--text-dim)", paddingLeft: 20 }}>
      {label}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="tnum"
          style={{ color: "var(--accent)" }}
        >
          {truncate(hash)}
        </a>
      ) : (
        <span className="tnum">{truncate(hash)}</span>
      )}
    </div>
  );
}
