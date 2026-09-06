/**
 * Pre-accept confirm surface for a `pwnda-desk` atomic swap.
 *
 * ## What this is NOT
 *
 * It is not `SwapConfirmModal` with the desk fields swapped in. That modal's
 * middle stage collects a vault password, hands it to `swap_unlock`, and gets
 * back a signing session -- because its flow builds, signs, and broadcasts a
 * transaction in TypeScript. This flow does none of that.
 *
 * `deskAccept` takes `{quoteId, payoutAddress, refundAddress}` and nothing
 * else. There is no `sessionId` parameter to fill, and the Rust desk store
 * reads its AES key from the OS keyring rather than from a user prompt -- a
 * deliberate design choice, so a refund watcher can decrypt its swap state at
 * process start with nobody sitting at the keyboard. Putting a password field
 * here would collect a secret that goes nowhere and imply an authorization
 * step that does not exist. So: review -> accept, and the surface says plainly
 * where the key actually comes from.
 *
 * ## Lifecycle
 *
 *   review (default)
 *     | user clicks "Accept & Start Swap"
 *   executing            <- phase list driven by startDeskSwap's onPhase
 *     |
 *   onAccepted(summary) -> onClose()      (success; the tracker takes over)
 *     or mockStop        (amber, deliberate stop, no history written)
 *     or error           (red; retryable, or terminal for a safety invariant)
 *
 * Note the accept path is one-way past `deskAccept`: it reserves desk
 * inventory and persists a swap. Everything this modal does before pressing
 * that button is reversible; nothing after it is.
 */
import { useEffect, useMemo, useState } from "react";
import { Backdrop, Row, Stat, truncate } from "./modal-parts";
import { Btn } from "../../components/PrimitivesV2";
import type { DeskSwapSummary } from "../../api/desk-rust";
import {
  DeskMockAttemptedError,
  startDeskSwap,
  type DeskStartPhase,
} from "./desk-execute";
import { SafetyInvariantError } from "./safety-invariants";
import type { NormalizedQuote } from "./useSwapQuote";

/**
 * Glyphs as escapes rather than pasted characters -- this file is ASCII-only
 * by project convention, and a stray multi-byte character in a money surface
 * is exactly the sort of thing that survives review and breaks a terminal
 * font later.
 */
const GLYPH_CLOSE = "\u00d7"; // multiplication sign, used as the close X
const GLYPH_STEP_DONE = "\u25cf"; // filled circle
const GLYPH_STEP_ACTIVE = "\u25cc"; // dotted circle
const GLYPH_STEP_PENDING = "\u25cb"; // hollow circle
const GLYPH_ELLIPSIS = "\u2026"; // horizontal ellipsis
const GLYPH_CHECK = "\u2713"; // check mark
const GLYPH_WARN = "\u26a0"; // warning sign

type Stage = "review" | "executing" | "mockStop" | "error";

export function DeskConfirmModal({
  open,
  quote,
  fromAsset,
  toAsset,
  fromAmount,
  fromDecimals,
  payoutAddress,
  refundAddress,
  onAccepted,
  onClose,
}: {
  open: boolean;
  quote: NormalizedQuote;
  /** Source ticker -- what the user pays. */
  fromAsset: string;
  /** Destination ticker -- what the user receives. */
  toAsset: string;
  /** Exactly what the user typed, a decimal string. */
  fromAmount: string;
  /** Source-asset display decimals, for the amount invariant. */
  fromDecimals: number;
  /** Where the bought coin lands. */
  payoutAddress: string;
  /** Where funds are reclaimed if the swap fails. NOT a signing address. */
  refundAddress: string;
  /** Called with the persisted swap summary; the tracker takes over. */
  onAccepted: (summary: DeskSwapSummary) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>("review");
  const [phase, setPhase] = useState<DeskStartPhase | null>(null);
  const [mockStop, setMockStop] = useState<DeskMockAttemptedError | null>(null);
  const [safetyError, setSafetyError] = useState<SafetyInvariantError | null>(
    null
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Ticking clock for the expiry countdown. Storing "now" rather than a
  // decrementing counter keeps the display honest if the tab is throttled or
  // the machine sleeps -- the next tick re-reads the wall clock instead of
  // resuming from a stale count.
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000)
  );

  // Reset on every open. A stale error or mock-stop panel from a previous
  // swap must never greet the user on a new one.
  useEffect(() => {
    if (!open) return;
    setStage("review");
    setPhase(null);
    setMockStop(null);
    setSafetyError(null);
    setErrorMessage(null);
    setNowSeconds(Math.floor(Date.now() / 1000));
  }, [open]);

  // Countdown ticker. Deliberately gated three ways: it does not run while
  // the modal is closed, and it does not run once the swap has reached a
  // terminal outcome (mockStop / error) -- at that point the quote's
  // remaining life is not information the user can act on, and a 1s
  // re-render behind a stopped flow is pure noise.
  useEffect(() => {
    if (!open) return;
    if (stage !== "review" && stage !== "executing") return;
    setNowSeconds(Math.floor(Date.now() / 1000));
    const id = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, stage]);

  const dq = quote.deskQuote;
  const expiresAt = quote.expiresAt ?? dq?.expiresAt;
  const secondsLeft = useMemo(
    () => (expiresAt ? Math.max(0, expiresAt - nowSeconds) : null),
    [expiresAt, nowSeconds]
  );
  const expired = secondsLeft !== null && secondsLeft <= 0;

  if (!open) return null;

  // A NormalizedQuote is structurally allowed to carry no desk quote (the
  // aggregators don't set one). Reaching this modal without one is a caller
  // wiring bug, so say so rather than rendering a grid of blanks.
  if (!dq) {
    return (
      <Shell onClose={onClose}>
        <div style={PANEL_RED}>
          This is not a desk quote -- DeskConfirmModal was opened for a route
          the Pwnda desk did not price. No swap was started. This is a client
          wiring bug, not a user error.
        </div>
        <div style={{ marginTop: 12 }}>
          <Btn variant="ghost" full caret={false} onClick={onClose}>
            Close
          </Btn>
        </div>
      </Shell>
    );
  }

  const runAccept = async () => {
    setStage("executing");
    setPhase("checking-quote");
    setMockStop(null);
    setSafetyError(null);
    setErrorMessage(null);
    try {
      const summary = await startDeskSwap({
        quote,
        fromAsset,
        toAsset,
        fromDecimals,
        typedAmount: fromAmount,
        payoutAddress,
        refundAddress,
        onPhase: (p) => setPhase(p),
      });
      onAccepted(summary);
      onClose();
    } catch (e) {
      // Order matters: both branches below are subclasses of Error, so the
      // typed checks have to precede the generic one.
      if (e instanceof DeskMockAttemptedError) {
        // A deliberate stop, not a failure. Nothing was reserved, nothing
        // signed, and NO history entry is written -- persisting one would
        // put a phantom swap in the user's ledger.
        setMockStop(e);
        setPhase(null);
        setStage("mockStop");
        return;
      }
      if (e instanceof SafetyInvariantError) {
        // The wallet caught its own bug and refused to proceed. No retry:
        // retrying re-enters the same code path and re-fires the same
        // invariant. The user must close and re-quote.
        setSafetyError(e);
        setPhase(null);
        setStage("error");
        return;
      }
      setErrorMessage(String((e as Error)?.message ?? e));
      setPhase(null);
      setStage("error");
    }
  };

  return (
    <Shell onClose={onClose}>
      {/* Where the two legs land. Address semantics are FLIPPED relative to
          the aggregator modal: payout is the destination-side wallet, refund
          is the source-side wallet, and refund is a reclaim target only --
          never a signing address. */}
      <Row
        label={`Payout (${toAsset})`}
        value={truncate(payoutAddress)}
        fullValue={payoutAddress}
      />
      <Row
        label={`Refund (${fromAsset})`}
        value={truncate(refundAddress)}
        fullValue={refundAddress}
      />

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
        <Stat k="pair" v={dq.pair} />
        <Stat k="direction" v={directionPlain(dq.direction, fromAsset, toAsset)} />
        <Stat k="desk side" v={deskSidePlain(dq.deskRole)} />
        <Stat k="rate" v={dq.rate} />
        <Stat k="you send" v={`${dq.amountIn} ${fromAsset}`} />
        <Stat k="you receive" v={`${dq.amountOut} ${toAsset}`} />
        {/* The desk rolls its entire spread into amountOut, so there is no
            separate source-side fee amount to show. `quote.totalFeesSource`
            is "0" for the desk BY DESIGN (see normalizeDesk) -- rendering it
            as a fee would tell the user this swap is free. `sTotal` is the
            real cost, and it is a FRACTION, so it belongs here as a percent. */}
        <Stat k="desk spread" v={formatSpreadPct(dq.sTotal)} />
        <Stat k="min confs in" v={String(dq.minConfsIn)} />
        <Stat k="min confs out" v={String(dq.minConfsOut)} />
        <Stat
          k="quote expires"
          v={secondsLeft === null ? "-" : formatCountdown(secondsLeft)}
        />
        {expired && (
          <div
            style={{
              marginTop: 6,
              padding: "8px 10px",
              background: "rgba(255,170,0,0.08)",
              border: "1px solid rgba(255,170,0,0.4)",
              color: "var(--warn)",
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            This quote has lapsed. Confirming re-prices it against the desk
            first -- the rate you accept may differ from the one above.
          </div>
        )}
      </div>

      {/* No password stage, and the modal says why. See the module header. */}
      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--text-muted)",
        }}
      >
        No vault password is required. Accepting reserves desk inventory and
        hands the swap to the Rust core, which holds its own per-swap keys and
        runs the refund timer on its own -- so it can recover this swap after a
        restart without you being here.
      </div>

      <div style={{ marginTop: 16 }}>
        {stage === "review" && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" full caret={false} onClick={onClose}>
              Cancel
            </Btn>
            {/* Never disabled on expiry: startDeskSwap re-quotes in place, so
                a lapsed quote is a re-price, not a dead end. */}
            <Btn variant="accent" full caret={false} onClick={runAccept}>
              {expired ? "Re-price & Accept" : "Accept & Start Swap"}
            </Btn>
          </div>
        )}
        {stage === "executing" && <AcceptingFooter phase={phase} />}
        {stage === "mockStop" && mockStop && (
          <MockStopFooter mockStop={mockStop} onClose={onClose} />
        )}
        {stage === "error" && safetyError && (
          <SafetyInvariantFooter error={safetyError} onClose={onClose} />
        )}
        {stage === "error" && !safetyError && (
          <ErrorFooter
            error={errorMessage ?? "Unknown error"}
            onClose={onClose}
            onRetry={() => {
              setErrorMessage(null);
              setPhase(null);
              setStage("review");
            }}
          />
        )}
      </div>
    </Shell>
  );
}

/* --- shell ------------------------------------------------------- */

/**
 * The modal shell, copied from `SwapConfirmModal` so the two confirm surfaces
 * are visually identical. Factored into a component here only because this
 * file renders it from two places (the normal path and the missing-desk-quote
 * guard) -- the values themselves are verbatim.
 */
function Shell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
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
            confirm desk swap
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
            {GLYPH_CLOSE}
          </button>
        </div>
        {children}
      </div>
    </Backdrop>
  );
}

/* --- footers ----------------------------------------------------- */

const PANEL_RED: React.CSSProperties = {
  padding: "10px 12px",
  background: "rgba(255,59,59,0.08)",
  border: "1px solid rgba(255,59,59,0.4)",
  color: "var(--danger)",
  fontSize: 11,
  lineHeight: 1.4,
};

/**
 * Phase list for the accept path. Mirrors `SwapConfirmModal`'s ExecutingFooter
 * idiom -- index-based, so a phase the run skipped renders as already done.
 * That is correct here: `requoting` only fires when the quote had lapsed, and
 * on the common fresh-quote path the flow jumps straight from `checking-quote`
 * to `accepting`.
 */
function AcceptingFooter({ phase }: { phase: DeskStartPhase | null }) {
  const steps: Array<{ key: DeskStartPhase; label: string }> = [
    { key: "checking-quote", label: "Checking quote freshness" },
    { key: "requoting", label: "Re-pricing against the desk" },
    { key: "accepting", label: "Reserving desk inventory" },
    { key: "accepted", label: "Swap accepted" },
  ];
  const currentIdx = steps.findIndex((s) => s.key === phase);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        Status
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {steps.map((s, i) => {
          const done = currentIdx > i || phase === "accepted";
          const active = currentIdx === i && phase !== "accepted";
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: active
                  ? "var(--accent)"
                  : done
                    ? "var(--text)"
                    : "var(--text-dim)",
              }}
            >
              <span style={{ width: 12 }}>
                {done
                  ? GLYPH_STEP_DONE
                  : active
                    ? GLYPH_STEP_ACTIVE
                    : GLYPH_STEP_PENDING}
              </span>
              <span>{s.label}</span>
              {active && (
                <span
                  style={{
                    color: "var(--accent)",
                    fontSize: 9,
                    letterSpacing: 1,
                    marginLeft: "auto",
                  }}
                >
                  {GLYPH_ELLIPSIS}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Do not close the wallet until the swap is accepted. Once it is, the
        Rust core owns it -- including the refund timer.
      </div>
    </div>
  );
}

/**
 * Mock-mode stop. Info tone (amber), NOT red: the desk refused to accept
 * because it is not enabled for live trading, which is a deliberate guard
 * firing exactly as designed. No inventory was reserved, no funds moved, and
 * no history entry was written.
 *
 * Unlike `SwapConfirmModal`'s equivalent there is no signed-transaction blob
 * to show -- this flow never signs anything in TypeScript. The desk-shaped
 * fields below are what actually existed at the moment of the stop.
 */
function MockStopFooter({
  mockStop,
  onClose,
}: {
  mockStop: DeskMockAttemptedError;
  onClose: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "10px 12px",
          background: "rgba(255,170,0,0.08)",
          border: "1px solid rgba(255,170,0,0.4)",
          color: "var(--warn)",
          fontSize: 11,
          lineHeight: 1.5,
          fontFamily: "var(--font-mono)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ fontSize: 14 }}>
            {GLYPH_CHECK}
          </span>
          <span>Checks passed {GLYPH_ELLIPSIS} accept skipped (testing mode)</span>
        </div>
        <div style={{ color: "var(--text-dim)", marginTop: 4, fontSize: 10 }}>
          {mockStop.message}
        </div>
      </div>

      {/* What WOULD have been accepted, so the user can audit that the quote
          and routing were correct even though nothing was committed. */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 5,
          fontSize: 11,
        }}
      >
        <Stat k="quote id" v={mockStop.quoteId} />
        <Stat k="pair" v={mockStop.pair} />
        <Stat k="direction" v={mockStop.direction} />
        <Stat k="amount in" v={mockStop.amountIn} />
        <Stat k="amount out" v={mockStop.amountOut} />
      </div>

      <Btn variant="ghost" full caret={false} onClick={onClose}>
        Close
      </Btn>
    </div>
  );
}

/**
 * Safety-invariant violation. Red, and deliberately WITHOUT a retry button:
 * the wallet detected an inconsistency in its own state and refused to
 * proceed, so retrying just re-fires the same invariant. Copy Details puts a
 * structured incident record on the clipboard for a bug report.
 */
function SafetyInvariantFooter({
  error,
  onClose,
}: {
  error: SafetyInvariantError;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(error.toCopyText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "12px 14px",
          background: "rgba(255,59,59,0.10)",
          border: "1.5px solid rgba(255,59,59,0.55)",
          color: "var(--danger)",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 12 }}>
          {GLYPH_WARN} Safety check failed before accepting
        </div>
        <div style={{ marginBottom: 6 }}>
          The wallet detected an inconsistency between the quote and what you
          asked for. <strong>No swap was created and no funds have moved.</strong>{" "}
          Please copy the details below and report it.
        </div>
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,59,59,0.3)",
            color: "var(--text)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {error.message}
        </div>
        <details style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
          <summary style={{ cursor: "pointer" }}>
            Diagnostic context ({Object.keys(error.context).length} fields)
          </summary>
          <div style={{ marginTop: 6, fontFamily: "var(--font-mono)" }}>
            {Object.entries(error.context).map(([k, v]) => (
              <div key={k} style={{ wordBreak: "break-all", marginBottom: 2 }}>
                <span style={{ color: "var(--text-dim)" }}>{k}:</span>{" "}
                <span className="tnum">{v}</span>
              </div>
            ))}
            <div style={{ marginTop: 4, color: "var(--text-dim)" }}>
              invariant: {error.invariant}
            </div>
          </div>
        </details>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full caret={false} onClick={onClose}>
          Close
        </Btn>
        <Btn variant="accent" full caret={false} onClick={handleCopy}>
          {copied ? "Copied" : "Copy Details"}
        </Btn>
      </div>
    </div>
  );
}

/** Generic failure -- network, desk 4xx/5xx, address validation. Retryable. */
function ErrorFooter({
  error,
  onClose,
  onRetry,
}: {
  error: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  // QUOTE_EXPIRED is the one desk rejection with an obvious next move, and
  // the retry path re-quotes on its own -- say so rather than leaving the
  // user to guess whether pressing Retry will just fail identically.
  const isExpired = /QUOTE_EXPIRED|expired/i.test(error);
  const guidance = isExpired
    ? "The quote lapsed before the desk accepted it. Retry re-prices against the desk first."
    : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={PANEL_RED}>
        {guidance && (
          <div style={{ fontWeight: 500, marginBottom: 6 }}>{guidance}</div>
        )}
        <div style={{ wordBreak: "break-word" }}>{error}</div>
        <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 10 }}>
          No swap was created. Nothing was reserved and no funds have moved.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full caret={false} onClick={onClose}>
          Close
        </Btn>
        <Btn variant="accent" full caret={false} onClick={onRetry}>
          Retry
        </Btn>
      </div>
    </div>
  );
}

/* --- formatters --------------------------------------------------- */

/**
 * `hh:mm:ss` countdown. Clamps at zero rather than going negative -- an
 * expired quote reads "00:00:00" and the surrounding copy explains that
 * confirming re-prices it.
 *
 * Exported for unit tests, matching the convention in `SwapConfirmModal`
 * (`formatPwndaFee`) of exporting pure formatters so their exact output
 * strings can be pinned without rendering React.
 */
export function formatCountdown(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/**
 * Render `sTotal` -- the desk's total spread, a FRACTION where 0.01 means 1%
 * -- as a percentage string.
 *
 * This is the row that stands in for a fee amount. `quote.totalFeesSource` is
 * "0" for every desk quote by design (the spread is already baked into
 * `amountOut`), so showing that number as the cost of the swap would be a
 * lie of omission. Always keeps at least one decimal place: "1.0%" reads as a
 * measured rate, where a bare "1%" reads as a rounded guess.
 */
export function formatSpreadPct(sTotal: number): string {
  if (!Number.isFinite(sTotal) || sTotal < 0) return "-";
  const pct = sTotal * 100;
  const fixed = pct >= 0.01 ? pct.toFixed(2) : pct.toFixed(4);
  const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
  return `${trimmed}%`;
}

/**
 * Plain-language rendering of the desk `direction` token. The raw
 * SELL_FOLLOWER / BUY_FOLLOWER values are protocol vocabulary about which
 * chain moves first -- meaningful to the engine, meaningless to a user
 * deciding whether to press the button.
 */
function directionPlain(
  direction: string,
  fromAsset: string,
  toAsset: string
): string {
  if (direction === "SELL_FOLLOWER") return `Selling ${fromAsset} for ${toAsset}`;
  if (direction === "BUY_FOLLOWER") return `Buying ${toAsset} with ${fromAsset}`;
  return direction || "-";
}

/**
 * Which side of the protocol the desk takes, and by implication which side
 * the client takes -- they are always opposite. Worth surfacing because the
 * roles are not symmetric: the leader locks first and the follower's refund
 * path differs, so this determines what "something went wrong" looks like.
 */
function deskSidePlain(deskRole: string): string {
  const role = String(deskRole ?? "").toUpperCase();
  if (role === "LEADER") return "Desk leads (locks first), you follow";
  if (role === "FOLLOWER") return "Desk follows, you lead (lock first)";
  return deskRole || "-";
}
