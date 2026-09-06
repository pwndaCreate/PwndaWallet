/**
 * In-flight view for a BasicSwap peer-to-peer swap.
 *
 * ## A pure view, on purpose
 *
 * All state lives in `useSidecarSwap`, which is mounted ABOVE the view router
 * next to `useDeskTracker`. A swap runs 30-90 minutes and `SwapView` unmounts
 * the moment the user looks at their wallet — a certainty over that span — so
 * this component gets unmounted and remounted repeatedly and must hold nothing
 * that matters. Every value it renders arrives as a prop.
 *
 * ## Refunds are shown as normal outcomes
 *
 * `bidStates.ts` maps `XMR_SWAP_FAILED_REFUNDED`,
 * `XMR_SWAP_NOSCRIPT_TX_RECOVERED` and `XMR_SWAP_SCRIPT_TX_PREREFUND` to the
 * `refunded` stage at severity `normal`. This file renders `normal` in the
 * ordinary text colour with no warning chrome, and the word "error" appears
 * nowhere near it. That is a compliance constraint, not a tone preference:
 * framing a timelock return as a failure invites support pressure to "fix" it
 * by intervening in a swap, and pwnda intervening in settlement is exactly the
 * coordinator posture this product must not have.
 *
 * Severity, not stage, drives the colour — so a state added upstream and
 * mapped later inherits the right treatment without a second edit here.
 *
 * ## What is deliberately absent
 *
 * No counterparty identity, no "N others viewing", no estimated queue
 * position. Bids are point-to-point encrypted and no endpoint exposes other
 * users' activity, so any such number would be invented.
 */
import { useEffect, useRef, useState } from "react";
import { Backdrop, Stat } from "../swap/modal-parts";
import { Btn } from "../../components/PrimitivesV2";
import { swapSidecarRecoverBid } from "../../api/basicswap";
import { BID_STATE_IDS } from "./bidStates";
import type { BidSeverity } from "./bidStates";
import type {
  SidecarSwapState,
  SidecarTrackedSwap,
} from "./useSidecarSwap";

const GLYPH_CLOSE = "×";

/** Colour per SEVERITY. `normal` is text colour — refunds live there. */
function severityColor(severity: BidSeverity): string {
  switch (severity) {
    case "success":
      return "var(--accent)";
    case "attention":
      return "var(--warn)";
    case "progress":
      return "var(--accent)";
    default:
      return "var(--text)";
  }
}

/**
 * The visible arc of a swap, in order. `refunded`, `counterparty-recovered`
 * and `cancelled` are ENDINGS rather than steps, so they replace the arc
 * instead of appearing on it — a progress bar that stops four fifths of the
 * way along reads as "stuck", which is precisely the wrong story for a
 * timelock that did its job.
 */
const ARC = [
  "requesting",
  "accepted",
  "locking",
  "waiting-counterparty",
  "finalising",
  "done",
] as const;

import {
  elapsedSeconds,
  etaSentence,
  etaStanding,
  etaWindow,
  formatElapsed,
} from "./swapEta";
import { COOLDOWN_MS } from "./offerCooldown";
import { useNowTick } from "./useNowTick";

export function SidecarSwapTracker({
  state,
}: {
  state: SidecarSwapState;
}) {
  const swap = state.tracked;
  if (!state.trackerOpen || !swap) return null;
  return (
    <Backdrop onClick={state.closeTracker}>
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
        <Header onClose={state.closeTracker} count={state.swaps.length} />
        <Body swap={swap} state={state} />
      </div>
    </Backdrop>
  );
}

function Header({
  onClose,
  count,
}: {
  onClose: () => void;
  count: number;
}) {
  return (
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
        peer-to-peer swap{count > 1 ? ` (${count} active)` : ""}
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
  );
}

/**
 * The way out of `BID_ERROR` — the one stage nothing in the engine resumes.
 *
 * # Why a button and not an automatic retry
 *
 * The engine's own recovery (PWNDA-PATCH-11) is safe to call repeatedly: it
 * commits nothing, takes no target state, and the step it re-queues is
 * idempotent against an on-chain duplicate (PWNDA-PATCH-10). So an automatic
 * retry would be defensible. It is still a button, for one reason: reaching
 * `BID_ERROR` means the engine hit something it could not resolve, and a
 * wallet that silently retries a fund-adjacent operation on a loop is a wallet
 * whose logs nobody reads. One deliberate press, with the outcome shown.
 *
 * # Why the refusal is rendered, not swallowed
 *
 * `recovered: false` is the engine declining a gate — "a refund is already in
 * flight", "this never reached the claim stage" — and each of those is the
 * actual answer to "what happened to my money". Showing it is the point.
 */
function RecoveryPanel({
  swap,
  onRefresh,
}: {
  swap: SidecarTrackedSwap;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const run = () => {
    setBusy(true);
    setResult(null);
    setFailed(false);
    void swapSidecarRecoverBid(swap.bidId)
      .then((r) => {
        setFailed(!r.recovered);
        setResult(
          r.settled
            ? `Settled. Your claim on the other chain was already confirmed${
                r.confirmations ? ` (${r.confirmations} confirmations)` : ""
              } — the swap node had lost track of it, not the coins. It is now marked Completed.`
            : r.recovered
              ? `Restarted. The swap node will retry the claim${
                  r.retryInSeconds ? ` in about ${r.retryInSeconds}s` : ""
                }, and this screen will follow it again.`
              : (r.reason ?? "The swap node declined to restart this swap."),
        );
        // Whether it took or not, the bid's state may have moved — re-read
        // rather than leaving the screen asserting the pre-call state.
        onRefresh();
      })
      .catch((e) => {
        setFailed(true);
        setResult(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      style={{
        ...PANEL,
        borderColor: "rgba(255,170,0,0.4)",
        background: "rgba(255,170,0,0.06)",
      }}
    >
      <div style={{ ...LABEL, color: "var(--warn)" }}>try to restart it</div>
      <div style={{ ...NOTE, marginTop: 6, color: "var(--text)" }}>
        The swap node stopped following this swap. That often means the step it
        was on had already succeeded on-chain and it could not tell. Restarting
        asks it to look again — it does not send anything or move any coins, and
        it cannot spend twice.
      </div>
      {result && (
        <div
          style={{
            ...NOTE,
            marginTop: 8,
            color: failed ? "var(--warn)" : "var(--accent)",
          }}
        >
          {result}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Btn variant="ghost" caret={false} disabled={busy} onClick={run}>
          {busy ? "Restarting…" : "Restart this swap"}
        </Btn>
      </div>
    </div>
  );
}

function Body({
  swap,
  state,
}: {
  swap: SidecarTrackedSwap;
  state: SidecarSwapState;
}) {
  const { stage } = swap;
  const color = severityColor(stage.severity);
  const arcIndex = ARC.indexOf(stage.stage as (typeof ARC)[number]);
  const onArc = arcIndex >= 0;
  // A stage with no label (the engine's internal pause, or a state this
  // build does not know) must still SAY something: the engine's own
  // sentence is better than a blank box (2026-09-05, "Delaying").
  const stepLabelText = stage.label || "Working";
  const stepDescription =
    stage.description ||
    swap.detail?.state_description ||
    "The swap node is between steps.";
  const pausing = swap.detail?.bid_state_ind === BID_STATE_IDS.SWAP_DELAYING;
  const confirming = confirmationsFromEvents(swap.detail?.events);
  // How long this has been running, and how long it should. Between steps a
  // swap can look identical to a dead one for twenty minutes at a stretch;
  // a moving clock is the only thing on this panel that says otherwise.
  const now = useNowTick(!stage.terminal);
  const elapsed = elapsedSeconds(swap.createdAt, now);
  const window = etaWindow(swap.sendCoin, swap.receiveCoin);
  const standing = etaStanding(elapsed, window);
  const clockColor =
    standing === "overdue" ? "var(--warn)" : stage.terminal ? "var(--text)" : "var(--accent)";

  // ── a bid nobody answered ───────────────────────────────────────────────
  //
  // `cancelled` is BID_EXPIRED / BID_ABANDONED: the swap ended **before any
  // funds were committed**, which on a taker's own bid almost always means the
  // maker never woke up. The operator hit this on 2026-09-05 — a bid sat at
  // `Sent` for 56 minutes and then closed as "Bid expired before being
  // accepted" — and the natural next move, quoting again, walks straight back
  // to the same sleeping maker, because they are still the best price and are
  // still advertising.
  //
  // So the offer AND the maker go on a timed skip list here, automatically,
  // the moment the tracker sees the state. Not a ban: `offerCooldown` prunes
  // on read, and every quote path already consults it, so "quote again" is
  // the whole retry — it just reaches somebody else now.
  // Rendered here, WRITTEN in `useSidecarSwap`. The hook runs whether or not
  // this modal is mounted, and a bid expires precisely when nobody is looking
  // at it.
  const expiredUnanswered = stage.stage === "cancelled";

  // ── the OTHER kind of waiting ───────────────────────────────────────────
  //
  // "Waiting for the other user" covers two situations that could not be more
  // different, and the operator hit the second one and correctly asked what to
  // do differently:
  //
  //   * nobody accepted the bid   -> nothing was committed, re-bid elsewhere
  //   * both legs are LOCKED and the counterparty has stopped
  //
  // In the second, coins are committed and there is nothing to re-bid. It is
  // also not a failure: the refund is PRE-SIGNED, the node publishes it on its
  // own once the chain-A lock matures, and the funds come back. What the user
  // needs is the deadline and the reassurance — not a retry button, and
  // emphatically not the "abandon" the console offers, which would stop the
  // node driving the very recovery that returns the coins.
  const lockedAndWaiting = counterpartyHoldsLockedFunds(swap.detail);

  return (
    <>
      {elapsed != null && (
        <div
          data-swap-clock
          style={{
            padding: "10px 14px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div style={LABEL}>{stage.terminal ? "took" : "running for"}</div>
            <div
              style={{
                fontSize: 22,
                marginTop: 2,
                color: clockColor,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatElapsed(elapsed)}
            </div>
          </div>
          {!stage.terminal && (
            <div style={{ ...NOTE, textAlign: "right", maxWidth: "62%" }}>
              {etaSentence(elapsed, window)}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          padding: "12px 14px",
          background: "var(--surface)",
          border: `1px solid ${stage.severity === "attention" ? "rgba(255,170,0,0.4)" : "var(--border)"}`,
        }}
      >
        <div style={LABEL}>current step</div>
        <div style={{ fontSize: 15, color, marginTop: 4 }}>{stepLabelText}</div>
        <div style={{ ...NOTE, marginTop: 6 }}>{stepDescription}</div>
        {confirming && (
          <div style={{ ...NOTE, marginTop: 6, color: "var(--text)" }}>
            Waiting for the other chain's lock to reach {confirming.needed}{" "}
            confirmations — {confirming.have} so far. The node retries on its
            own; nothing is stuck.
          </div>
        )}
        {pausing && (
          <div style={{ ...NOTE, marginTop: 6 }}>
            The swap node is pausing briefly before its next step. It does
            this on purpose, on every swap.
          </div>
        )}
      </div>

      {/* Only for the stage the engine does not resume on its own. Everything
          else either progresses or is genuinely finished. */}
      {stage.stage === "needs-attention" && (
        <RecoveryPanel swap={swap} onRefresh={state.refresh} />
      )}

      {lockedAndWaiting && (
        <div
          style={{ ...PANEL, borderColor: "rgba(255,170,0,0.4)" }}
          data-locked-waiting
        >
          <div style={{ ...LABEL, color: "var(--warn)" }}>
            your coins are locked, and the other user has gone quiet
          </div>
          <div style={{ ...NOTE, marginTop: 6, color: "var(--text)" }}>
            Both sides locked their funds, and the other user has not released
            theirs. This is the one case where a swap is waiting on somebody
            rather than on a chain — and the protocol already has the answer:
            the refund that returns your coins was signed before either side
            locked anything.
          </div>
          <div style={{ marginTop: 8 }}>
            <Stat
              k="refund becomes available"
              v={refundDeadlineLabel(swap.detail)}
            />
          </div>
          <div style={{ ...NOTE, marginTop: 6 }}>
            Measured against the chain's own clock, which runs behind real time.
            Nothing for you to do: this node publishes the refund itself and
            resumes after a restart. Leave the swap alone — do not abandon it,
            which would stop the node driving the recovery.
          </div>
        </div>
      )}

      {/* Nobody took the bid. Say what was done about it, because the skip
          list is otherwise invisible and would look like the book changing
          on its own. */}
      {expiredUnanswered && (
        <div style={{ ...PANEL, borderColor: "var(--border-hi)" }} data-maker-cooldown>
          <div style={LABEL}>no funds moved</div>
          <div style={{ ...NOTE, marginTop: 6, color: "var(--text)" }}>
            The other user never accepted, so this bid closed on its own. Your
            coins were never committed — nothing to recover.
          </div>
          <div style={{ ...NOTE, marginTop: 6 }}>
            That offer and its maker are now skipped for{" "}
            {Math.round(COOLDOWN_MS / 60000)} minutes, so quoting again reaches
            a different one. They are not blocked — the skip expires by itself.
          </div>
        </div>
      )}

      {onArc && (
        <div style={{ ...PANEL, gap: 4 }}>
          {ARC.map((step, i) => {
            const done = i < arcIndex;
            const active = i === arcIndex;
            return (
              <div
                key={step}
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
                  {done ? "●" : active ? "◌" : "○"}
                </span>
                <span>{stepLabel(step)}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={PANEL}>
        <Stat k="you send" v={`${swap.sendAmount} ${swap.sendCoin}`} />
        <Stat k="you receive" v={`${swap.receiveAmount} ${swap.receiveCoin}`} />
        <Stat k="bid id" v={shortId(swap.bidId)} />
        <Stat k="offer id" v={shortId(swap.offerId)} />
        {swap.detail?.state_description && (
          <div style={{ ...NOTE, marginTop: 4 }}>
            Swap node detail: {swap.detail.state_description}
          </div>
        )}
      </div>

      {/* Refund copy, shown while the swap is still in flight rather than only
          once it happens. A user who first meets the word "refund" at the
          moment their swap ends reads it as something going wrong. */}
      {!stage.terminal && (
        <div style={PANEL}>
          <div style={LABEL}>if the other user walks away</div>
          <div style={NOTE}>
            The timelock returns your funds to the swap node's wallet
            automatically. That is a normal outcome of this protocol, not an
            error, and no coins are lost. You do not have to be here for it —
            the node runs the timer itself and resumes after a restart.
          </div>
        </div>
      )}

      <div style={PANEL}>
        <div style={LABEL}>updates</div>
        <div style={NOTE}>
          {state.transport === "websocket"
            ? "Live — connected to the swap node's event feed, with a background check every 15 seconds as a backstop."
            : "Checking the swap node every 15 seconds. The live event feed is not connected, which slows updates but changes nothing about the swap."}
          {swap.lastPolledAt
            ? ` Last checked ${agoSentence(swap.lastPolledAt)}.`
            : " Waiting for the first check."}
        </div>
        {swap.error && (
          // A read failure, not a swap failure — and the difference is the
          // whole point of this line. The swap is running on two chains and a
          // node the wallet cannot reach for a moment is a display problem.
          <div style={{ ...NOTE, color: "var(--warn)", marginTop: 6 }}>
            The wallet could not read the swap's status just now, so what is
            shown above may be behind. The swap itself is unaffected. ({swap.error})
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <Btn
          variant="ghost"
          full
          caret={false}
          disabled={state.checking}
          onClick={state.refresh}
        >
          {state.checking ? "Checking…" : "Check now"}
        </Btn>
        <Btn variant="accent" full caret={false} onClick={state.closeTracker}>
          {stage.terminal ? "Done" : "Run in background"}
        </Btn>
      </div>
      {!stage.terminal && (
        <div style={{ ...NOTE, marginTop: 8, textAlign: "center" }}>
          Closing this does not stop the swap. It takes 30 to 90 minutes and
          continues whether or not the wallet is open.
        </div>
      )}
    </>
  );
}

/**
 * "Failed to publish lock tx B spend: Chain B lock tx still confirming 6 / 10."
 *
 * That is upstream's event wording for a WAIT — the engine will not spend the
 * other chain's lock until it has enough confirmations, and it logs each
 * retry as a failure. Read the numbers out of the newest such event so the
 * tracker can say what is actually happening. `null` when there is none.
 */
export function confirmationsFromEvents(
  events: unknown[] | undefined,
): { have: number; needed: number } | null {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { desc?: unknown; event_msg?: unknown } | null;
    const text = String(e?.desc ?? e?.event_msg ?? "");
    const m = text.match(/still confirming\s+(\d+)\s*\/\s*(\d+)/i);
    if (m) return { have: Number(m[1]), needed: Number(m[2]) };
    // The newest event decides: a "published" after a "confirming" means the
    // wait is over, and an older confirming line must not resurrect it.
    if (/spend tx published|redeemed|completed/i.test(text)) return null;
  }
  return null;
}

/**
 * Is this swap waiting on a counterparty who has stopped **with both legs
 * locked**?
 *
 * `XMR_SWAP_NOSCRIPT_COIN_LOCKED` (11) is the state: both lock transactions
 * confirmed, and the offerer has yet to release the scripted leg. Keyed on the
 * state id rather than on `state_description`, which is upstream prose and has
 * changed before.
 *
 * Observed live 2026-09-05 on bid `000000006a9c9d96…`: locks confirmed at
 * 19:12 and then nothing for over an hour, with
 * `coin_a_lock_refund_tx_est_final` a day out.
 */
export function counterpartyHoldsLockedFunds(
  detail: { bid_state_ind?: number | null } | null | undefined,
): boolean {
  return detail?.bid_state_ind === BID_STATE_IDS.XMR_SWAP_NOSCRIPT_COIN_LOCKED;
}

/**
 * When the pre-signed refund becomes publishable, in the chain's own terms.
 *
 * Deliberately expressed as time REMAINING ON THE CHAIN'S CLOCK
 * (`coin_a_lock_refund_tx_est_final` minus `coin_a_last_median_time`) rather
 * than as a wall-clock countdown: a CSV lock matures against median-time-past
 * — the median of the last 11 block timestamps, so ~5.5 blocks behind the tip.
 * That is about 14 minutes on Litecoin's 2.5-minute blocks (measured live on
 * 2026-09-06) and nearer 55 on Bitcoin or Bitcoin Cash. A wall-clock countdown
 * would promise the refund before the chain would accept it.
 */
export function refundDeadlineLabel(
  detail:
    | {
        coin_a_lock_refund_tx_est_final?: number | null;
        coin_a_last_median_time?: number | null;
      }
    | null
    | undefined,
): string {
  const at = detail?.coin_a_lock_refund_tx_est_final;
  if (!at || !Number.isFinite(at)) return "as soon as the chain allows it";
  const stamp = new Date(at * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const median = detail?.coin_a_last_median_time;
  if (!median || !Number.isFinite(median) || median >= at) return stamp;
  const hours = Math.round((at - median) / 3600);
  return `${stamp} — about ${hours}h of chain time away`;
}

function stepLabel(step: (typeof ARC)[number]): string {
  switch (step) {
    case "requesting":
      return "Bid sent to the other user";
    case "accepted":
      return "Bid accepted";
    case "locking":
      return "Locking your funds";
    case "waiting-counterparty":
      return "Waiting for the other user";
    case "finalising":
      return "Finalising";
    default:
      return "Done";
  }
}

function shortId(id: string): string {
  if (!id) return "—";
  return id.length <= 18 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function agoSentence(atMillis: number): string {
  const secs = Math.max(1, Math.floor((Date.now() - atMillis) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

const PANEL: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  padding: 12,
  marginTop: 10,
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 11,
};

const LABEL: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const NOTE: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text-muted)",
};
