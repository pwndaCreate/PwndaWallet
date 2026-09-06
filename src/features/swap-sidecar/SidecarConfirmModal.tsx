/**
 * Pre-submit confirm surface for a BasicSwap peer-to-peer swap.
 *
 * This is the last screen before a bid goes onto an open network, so almost
 * everything in it is a constraint rather than a design choice. The list below
 * is the file's contract; each item names the failure it prevents.
 *
 * ## 1. Three separate lines, never one blended "cost"
 *
 * The spread versus market, the on-chain costs, and the pwnda licence fee are
 * three different things paid to three different places, and rolling them into
 * a single number is how a user ends up unable to tell a 0.3% swap from a 14%
 * one. They render as three labelled rows and the spread renders as a PLAIN
 * SENTENCE ("This swap is 3.2% worse than market."), because a raw rate is not
 * a disclosure — a novice cannot tell `0.00412` from `0.00470`.
 *
 * ## 2. The three-band gate, and why red needs TYPING
 *
 * Green proceeds. Amber proceeds with the spread shown prominently. Red BLOCKS
 * until the user types {@link SPREAD_OVERRIDE_PHRASE}. A checkbox was
 * considered and rejected: a checkbox is clicked reflexively, and the measured
 * BasicSwap book runs to +14% with stale bait beyond that, so the single worst
 * outcome this route can produce is a novice one click away from a +14% fill.
 * The gate is computed by `evaluateSpreadGate` (pure, exhaustively tested) and
 * this file only renders its verdict — it never re-derives a band.
 *
 * A missing price feed is RED and `verified: false`, not green. "Cannot
 * verify" must never render as "verified fine". The typed override still
 * clears it, so a dead feed can never make a swap impossible.
 *
 * ## 3. The fee NEVER gates
 *
 * The pwnda licence fee is a PER-USE LICENCE FEE for the software — never a
 * commission, a spread, or a share of the trade. Collection is counsel-gated
 * and the fee module does not exist, so the row renders as a disabled
 * not-yet-charged line. Nothing in this component reads a fee value to decide
 * whether the submit button is enabled, and nothing ever may: the swap must
 * run and settle identically whether a fee is ever paid.
 *
 * ## 4. pwnda is not the counterparty, and there is no taker feed
 *
 * The copy says the user is swapping with another user on an open network.
 * The only "how busy is it" number shown is how many offers are on the book
 * for this direction, which is read directly from `/json/offers` — there is NO
 * endpoint exposing other users' bids or swaps, so fill rates, demand and "N
 * others viewing" are not merely omitted, they are unavailable and would have
 * to be invented.
 *
 * ## 5. Expectations are set BEFORE the click, not after
 *
 * 30-90 minutes; the app can be closed because the node keeps running and
 * resumes on restart; and REFUNDS ARE A NORMAL OUTCOME of the timelock, not an
 * error. A user who learns the third fact only when it happens reads it as
 * theft.
 */
import { useEffect, useMemo, useState } from "react";
import { Backdrop, Row, Stat, truncate } from "../swap/modal-parts";
import { licenceFeeLabel, useLicenceFee } from "./licenceFee";
import { etaWindow, formatEtaWindow } from "./swapEta";
import { Btn } from "../../components/PrimitivesV2";
import type { NormalizedQuote } from "../swap/useSwapQuote";
import {
  SPREAD_OVERRIDE_PHRASE,
  evaluateSpreadGate,
  formatBandNote,
} from "./spread";
import {
  sidecarBookDepth,
  sidecarSwapSentence,
  submitSidecarBid,
  type SidecarQuote,
  type SidecarSwapHandle,
} from "./useSidecarSwap";
import { formatAmount } from "./types";

/** ASCII-only source, per project convention — a money surface should not
 *  depend on a font shipping a particular multi-byte glyph. */
const GLYPH_CLOSE = "×";

type Stage = "review" | "submitting" | "writeDisabled" | "error";

export function SidecarConfirmModal({
  open,
  quote,
  fromAsset,
  toAsset,
  payoutAddress,
  onSubmitted,
  onClose,
}: {
  open: boolean;
  /** The quote on screen. Must carry `basicswapQuote`. */
  quote: NormalizedQuote;
  /** Source ticker — what the user pays. */
  fromAsset: string;
  /** Destination ticker — what the user receives. */
  toAsset: string;
  /**
   * Where the bought coin should land. Address semantics match the desk and
   * are FLIPPED versus the aggregators: this is the DESTINATION-side wallet,
   * and it is a payout target, never a signing address.
   */
  payoutAddress: string;
  /** Handed the accepted swap so the app-level tracker can adopt it. */
  onSubmitted: (handle: SidecarSwapHandle) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>("review");
  const [typedOverride, setTypedOverride] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [writeDeniedMessage, setWriteDeniedMessage] = useState<string | null>(
    null,
  );
  // Wall-clock rather than a decrementing counter, so a throttled tab or a
  // sleeping machine re-reads the truth on the next tick instead of resuming
  // from a stale count.
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  // Reset on every open. A stale error panel — or worse, a stale TYPED
  // OVERRIDE — must never greet the user on a new swap: carrying the override
  // across opens would mean a phrase typed for a +14% offer silently clearing
  // the gate on the next one.
  useEffect(() => {
    if (!open) return;
    setStage("review");
    setTypedOverride("");
    setErrorMessage(null);
    setWriteDeniedMessage(null);
    setNowSeconds(Math.floor(Date.now() / 1000));
  }, [open]);

  useEffect(() => {
    if (!open || stage !== "review") return;
    const id = window.setInterval(
      () => setNowSeconds(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [open, stage]);

  const book: SidecarQuote | undefined = quote.basicswapQuote;

  // The gate. Read off the assessment the QUOTE carries rather than recomputed
  // here, so the band that blocks is provably the band that was displayed.
  const gate = useMemo(
    () =>
      book
        ? evaluateSpreadGate(book.spread, typedOverride)
        : null,
    [book, typedOverride],
  );

  const secondsLeft = book ? Math.max(0, book.expiresAt - nowSeconds) : null;
  const expired = secondsLeft !== null && secondsLeft <= 0;

  // ABOVE the early returns, deliberately: this is a hook, and the two
  // `return`s below are conditional. With no book the legs are empty strings,
  // `feeLegFor` answers null, and no request is made.
  //
  // The fee comes from the SAME `engine::decide` branch the watcher runs
  // after settlement, so the number shown here and the number charged cannot
  // disagree. It replaced a hardcoded zero, labelled as not-collected, that
  // never asked the backend — and went on saying so after collection was
  // turned on (2026-09-05). The exact literal is deliberately not repeated in
  // this file: `collection_is_on_only_alongside_a_surface_that_shows_it`
  // greps for it, and a comment quoting the bug would keep the test red.
  const licenceFee = useLicenceFee(
    book?.offer.sendCoin ?? "",
    book ? formatAmount(book.sendAmount, book.sendDecimals) : "",
    book?.offer.receiveCoin ?? "",
    book ? formatAmount(book.receiveAmount, book.receiveDecimals) : "",
  );

  if (!open) return null;

  if (!book || !gate) {
    return (
      <Shell onClose={onClose}>
        <div style={PANEL_RED}>
          This is not a BasicSwap quote — the confirm modal was opened for a
          route the local swap node did not price. Nothing was submitted. This
          is a client wiring bug, not a user error.
        </div>
        <div style={{ marginTop: 12 }}>
          <Btn variant="ghost" full caret={false} onClick={onClose}>
            Close
          </Btn>
        </div>
      </Shell>
    );
  }

  const depth = sidecarBookDepth(book);
  // Per PAIR, from the two chains' confirmation depths — the flat "30 to 90
  // minutes" this replaced overstates LTC↔XMR by about three times.
  const etaWin = etaWindow(book.offer.sendCoin, book.offer.receiveCoin);
  const etaLabel = etaWin ? formatEtaWindow(etaWin) : "about 30–90 min";
  const bandColor =
    book.spread.band === "green"
      ? "var(--accent)"
      : book.spread.band === "amber"
        ? "var(--warn)"
        : "var(--danger)";

  const runSubmit = async () => {
    // Belt and braces: the button is disabled when the gate is closed, but a
    // gate this cheap to re-check should not depend on a `disabled` attribute
    // being the only thing between a red offer and a submitted bid.
    if (!gate.canProceed) return;
    // A bid the node cannot fund is refused when the lock is built, so
    // refusing it here is the same answer, earlier and legible. `unknown`
    // deliberately does NOT block — see `assessBidFunding`.
    if (book.funding.state === "short") return;
    // Same belt-and-braces reasoning: the engine refuses this identically
    // (`checkCoinsReady`'s restrict_unknown_seed_wallets check), so catching
    // it here is the same answer, earlier and legible.
    if (book.walletReadiness.state === "not-ready") return;
    setStage("submitting");
    setErrorMessage(null);
    setWriteDeniedMessage(null);
    const result = await submitSidecarBid({ quote: book, addrTo: payoutAddress });
    if (result.ok) {
      onSubmitted({
        bidId: result.bidId,
        offerId: book.offer.offerId,
        sendCoin: book.offer.sendCoin,
        receiveCoin: book.offer.receiveCoin,
        sendAmount: formatAmount(book.sendAmount, book.sendDecimals),
        receiveAmount: formatAmount(book.receiveAmount, book.receiveDecimals),
        createdAt: Math.floor(Date.now() / 1000),
        // Carried so an automatic re-bid pays the address the user reviewed
        // on THIS screen rather than re-deriving one later.
        payoutAddress,
      });
      onClose();
      return;
    }
    if (result.kind === "write-path-unavailable") {
      setWriteDeniedMessage(result.message);
      setStage("writeDisabled");
      return;
    }
    setErrorMessage(result.message);
    setStage("error");
  };

  return (
    <Shell onClose={onClose}>
      {/* Payout only. There is no refund address to collect: on an atomic swap
          the timelock returns funds to the swap node's OWN wallet, which is
          why the tracker's refund copy points there rather than at a wallet
          address the user chose. */}
      <Row
        label={`Payout (${toAsset})`}
        value={truncate(payoutAddress)}
        fullValue={payoutAddress}
      />

      {/* ── what the swap is ─────────────────────────────────────────── */}
      <div style={PANEL}>
        <Stat
          k="you send"
          v={`${formatAmount(book.sendAmount, book.sendDecimals)} ${fromAsset}`}
        />
        <Stat
          k="you receive"
          v={`${formatAmount(book.receiveAmount, book.receiveDecimals)} ${toAsset}`}
        />
        <Stat
          k="rate"
          v={`${formatAmount(book.offer.effectiveRate, book.sendDecimals)} ${fromAsset} per ${toAsset}`}
        />
        <Stat
          k="offer expires"
          v={secondsLeft === null ? "-" : formatCountdown(secondsLeft)}
        />
        {/* The ONLY book-activity number shown, and it comes straight from
            /json/offers. No fill rate, no demand, no "N others viewing" —
            there is no endpoint that could supply one. */}
        <Stat
          k="offers on book"
          v={`${depth.total} in this direction`}
        />
        {/* The licence fee as a NUMBER, in the quote (operator, 2026-09-05:
            "just make it a percentage or scaler number"). It replaced a
            five-line paragraph AND a hardcoded zero labelled as not-collected
            — a string that never asked the backend, dated from when collection
            was off, and stayed put after it was turned on. So the modal
            claimed no fee while the watcher was charging one. */}
        <Stat k="pwnda licence fee" v={licenceFeeLabel(licenceFee)} />
      </div>

      {/* ── LINE 1 of 3: the spread, as a plain sentence ─────────────── */}
      <div
        style={{
          ...PANEL,
          borderColor: bandColor,
          background:
            book.spread.band === "green"
              ? "var(--surface)"
              : book.spread.band === "amber"
                ? "rgba(255,170,0,0.07)"
                : "rgba(255,59,59,0.07)",
        }}
      >
        <div style={SECTION_LABEL}>rate vs market</div>
        <div
          style={{
            color: bandColor,
            fontSize: book.spread.band === "green" ? 12 : 14,
            fontWeight: book.spread.band === "green" ? 400 : 600,
            lineHeight: 1.4,
          }}
        >
          {book.spread.sentence}
        </div>
        {formatBandNote(book.spread) && (
          <div style={{ ...NOTE, marginTop: 6 }}>
            {formatBandNote(book.spread)}
          </div>
        )}
      </div>

      {/* ── LINE 2 of 3: chain costs ─────────────────────────────────── */}
      <div style={PANEL}>
        <div style={SECTION_LABEL}>on-chain costs</div>
        {book.chainCost && book.chainCost.fee !== null ? (
          <>
            <Stat
              k="network fee"
              v={`${book.chainCost.fee} ${book.chainCost.coin}`}
            />
          </>
        ) : (
          // Advisory data degrades to "unavailable" and NEVER blocks. This
          // branch must stay a missing line item, not a disabled button.
          <Stat k="network fee" v="unavailable — does not affect the swap" />
        )}
      </div>

      {/* ── funding: can the NODE pay the send leg? (audit 2026-08-22) ── */}
      {book.funding.state !== "ok" && (
        <div
          style={
            book.funding.state === "short"
              ? { ...PANEL, borderColor: "var(--danger)", background: "rgba(255,59,59,0.07)" }
              : PANEL
          }
        >
          <div
            style={
              book.funding.state === "short"
                ? { ...SECTION_LABEL, color: "var(--danger)" }
                : SECTION_LABEL
            }
          >
            swap node funding
          </div>
          <div style={{ lineHeight: 1.5 }}>
            {book.funding.state === "short"
              ? book.funding.message
              : book.funding.reason}
          </div>
          {book.funding.state === "unknown" && (
            <div style={{ ...NOTE, marginTop: 6 }}>
              This does not block the swap. The node checks its own balance when
              it builds the lock.
            </div>
          )}
        </div>
      )}

      {/* ── wallet readiness: would the engine refuse this on
          restrict_unknown_seed_wallets? (incident 2026-08-22, see
          assessWalletSeedReadiness's doc for the full trace) ─────────── */}
      {book.walletReadiness.state === "not-ready" && (
        <WalletNotReadyPanel message={book.walletReadiness.message} />
      )}

      {/* ── what happens next ────────────────────────────────────────────
          Two lines. It was a paragraph plus three bullets, and the operator
          read past all of it ("its just too much"). What stays is the only
          thing a reader has to know before pressing the button and cannot
          find out afterwards: how long, and that walking away is safe. The
          tracker repeats both once the swap is running, so nothing is lost
          by saying it once here. */}
      <div style={PANEL}>
        <Stat k="takes about" v={etaLabel} />
        <div style={NOTE}>
          Peer-to-peer: pwnda is not the counterparty and never holds your
          coins. If the other user walks away the timelock returns your funds
          automatically — a normal outcome, and nothing is lost.
        </div>
      </div>

      {expired && (
        <div style={PANEL_AMBER}>
          This offer has expired and can no longer be bid on. Close and re-quote
          to price against the current book.
        </div>
      )}

      {/* ── the gate ─────────────────────────────────────────────────── */}
      {gate.requiresTypedOverride && (
        <div style={{ ...PANEL_RED, marginTop: 10 }}>
          <div style={{ ...SECTION_LABEL, color: "var(--danger)" }}>
            blocked — confirmation required
          </div>
          <div style={{ lineHeight: 1.5 }}>{gate.message}</div>
          <div style={{ ...NOTE, marginTop: 8, color: "var(--danger)" }}>
            To take this offer anyway, type{" "}
            <strong>{gate.overridePhrase ?? SPREAD_OVERRIDE_PHRASE}</strong>{" "}
            below.
          </div>
          <input
            value={typedOverride}
            onChange={(e) => setTypedOverride(e.target.value)}
            aria-label={`Type ${gate.overridePhrase ?? SPREAD_OVERRIDE_PHRASE} to continue`}
            placeholder={gate.overridePhrase ?? SPREAD_OVERRIDE_PHRASE}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: "100%",
              marginTop: 8,
              padding: "8px 10px",
              background: "var(--bg-2)",
              border: `1px solid ${gate.overrideSatisfied ? "var(--accent)" : "rgba(255,59,59,0.5)"}`,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              letterSpacing: 1,
            }}
          />
        </div>
      )}

      {/* ── footer ───────────────────────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        {stage === "review" && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" full caret={false} onClick={onClose}>
              Cancel
            </Btn>
            <Btn
              variant="accent"
              full
              caret={false}
              disabled={
                !gate.canProceed ||
                expired ||
                book.funding.state === "short" ||
                book.walletReadiness.state === "not-ready"
              }
              onClick={() => void runSubmit()}
            >
              {expired
                ? "Offer expired"
                : book.funding.state === "short"
                  ? "Swap node cannot fund this"
                  : book.walletReadiness.state === "not-ready"
                    ? "Swap node wallet not ready"
                    : gate.canProceed
                      ? "Send bid to the other user"
                      : "Confirmation required"}
            </Btn>
          </div>
        )}
        {stage === "submitting" && (
          <div style={{ ...NOTE, color: "var(--accent)" }}>
            Sending the bid over the peer-to-peer network. Do not close the
            wallet until this returns.
          </div>
        )}
        {stage === "writeDisabled" && (
          <WriteDisabledFooter
            message={writeDeniedMessage ?? ""}
            onClose={onClose}
          />
        )}
        {stage === "error" && (
          <ErrorFooter
            error={errorMessage ?? "Unknown error"}
            onClose={onClose}
            onRetry={() => {
              setErrorMessage(null);
              setStage("review");
            }}
          />
        )}
      </div>
    </Shell>
  );
}

/* --- shell -------------------------------------------------------- */

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
            confirm peer-to-peer swap
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

/**
 * The `walletReadiness.state === "not-ready"` panel.
 *
 * Pure status, no action — and that is now correct rather than a gap.
 *
 * History worth keeping, because it reversed twice in three days. On
 * 2026-08-23 this panel gained an "Open BasicSwap console" button: the
 * condition would not clear on its own, so the only way forward was the
 * console's own unlock, and the modal offered no way to get there. On
 * 2026-08-25 the button was REMOVED again — not because that reasoning was
 * wrong, but because its premise stopped being true. `useSwapAutoSetup` now
 * re-runs the engine's unlock after the account-key push (the step that
 * actually flips `expected_seed`), so this state clears itself within a
 * retry tick. A button whose whole job was to work around a condition that
 * no longer persists is a button that mostly fires when it is not needed.
 *
 * `walletReadiness` is re-derived from a poll, so when the condition clears
 * this panel disappears and the footer CTA flips back to "Send bid to the
 * other user" with no interaction at all. The console remains reachable
 * from Settings for the case where something genuinely is wrong — one door,
 * not three (see BasicswapStrip's own note in SwapView.tsx).
 */
function WalletNotReadyPanel({ message }: { message: string }) {
  return (
    <div
      style={{
        ...PANEL,
        borderColor: "var(--danger)",
        background: "rgba(255,59,59,0.07)",
      }}
    >
      <div style={{ ...SECTION_LABEL, color: "var(--danger)" }}>
        swap node wallet not ready
      </div>
      <div style={{ lineHeight: 1.5 }}>{message}</div>
    </div>
  );
}

/* --- footers ------------------------------------------------------ */

/**
 * The write path is closed in Rust, on purpose.
 *
 * Tone matters here and is not cosmetic: this is a deliberate guard firing
 * exactly as designed, in the same family as the desk's mock-stop. Nothing was
 * submitted, nothing was reserved, and NO swap record is written — persisting
 * one would put a phantom swap in the user's ledger. The verbatim backend
 * message is shown because it names which barrier fired, which is the only
 * detail that helps whoever reads a bug report.
 */
function WriteDisabledFooter({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={PANEL_AMBER}>
        <div style={{ ...SECTION_LABEL, color: "var(--warn)" }}>
          not submitted — bid submission is not enabled yet
        </div>
        <div style={{ lineHeight: 1.5 }}>
          This build can read the offer book but cannot place a bid: the wallet
          only allows the swap node's read-only endpoints, and placing a bid
          commits funds. Nothing was sent and no funds moved. Everything above
          is exactly what would have been submitted.
        </div>
        {/* Points at Settings rather than carrying its own console button
            (2026-08-25). The console is upstream's own UI with surfaces this
            wallet neither wraps nor vets; it now has exactly one entry point
            in the app, and a second one inside the swap flow read as though
            it were part of that flow. */}
        <div style={{ ...NOTE, marginTop: 8 }}>
          You can still place this bid yourself in the BasicSwap console —
          open it from Settings.
        </div>
      </div>
      {message && (
        <div
          style={{
            ...NOTE,
            fontFamily: "var(--font-mono)",
            wordBreak: "break-word",
          }}
        >
          Swap node said: {message}
        </div>
      )}
      <Btn variant="ghost" full caret={false} onClick={onClose}>
        Close
      </Btn>
    </div>
  );
}

function ErrorFooter({
  error,
  onClose,
  onRetry,
}: {
  error: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={PANEL_RED}>
        <div style={{ ...SECTION_LABEL, color: "var(--danger)" }}>
          bid not placed
        </div>
        <div style={{ lineHeight: 1.5, wordBreak: "break-word" }}>{error}</div>
        <div style={{ ...NOTE, marginTop: 8, color: "var(--danger)" }}>
          No funds moved. Offers come and go on their own, so the offer may
          simply have been taken by someone else — re-quoting will price against
          whatever is on the book now.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full caret={false} onClick={onClose}>
          Close
        </Btn>
        <Btn variant="accent" full caret={false} onClick={onRetry}>
          Back to review
        </Btn>
      </div>
    </div>
  );
}

/* --- style constants ---------------------------------------------- */

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

const PANEL_RED: React.CSSProperties = {
  padding: "10px 12px",
  background: "rgba(255,59,59,0.08)",
  border: "1px solid rgba(255,59,59,0.4)",
  color: "var(--danger)",
  fontSize: 11,
  lineHeight: 1.4,
};

const PANEL_AMBER: React.CSSProperties = {
  padding: "10px 12px",
  marginTop: 10,
  background: "rgba(255,170,0,0.08)",
  border: "1px solid rgba(255,170,0,0.4)",
  color: "var(--warn)",
  fontSize: 11,
  lineHeight: 1.4,
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-dim)",
  marginBottom: 2,
};

const NOTE: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text-muted)",
};

const LIST: React.CSSProperties = {
  margin: "8px 0 0",
  paddingLeft: 16,
  fontSize: 10,
  lineHeight: 1.6,
  color: "var(--text-muted)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

/** `m:ss` while under an hour, `h:mm:ss` above it. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
