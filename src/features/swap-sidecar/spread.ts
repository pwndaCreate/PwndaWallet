/**
 * **The safety core.** Spread exposure and extreme-offer gating for the
 * BasicSwap route.
 *
 * The measured BasicSwap book runs roughly +0.2% to +14% over CoinGecko mid,
 * with stale-bait offers beyond that. A novice taking a +14% offer is the
 * single worst outcome this route can produce, and it is entirely preventable
 * by comparing the offer against the wallet's own price feed before commit.
 * That comparison is this file. Everything here is pure — no I/O, no React —
 * so it can be exhaustively tested, which is the only reason to trust it.
 *
 * ## The four rules, and why each is load-bearing
 *
 * 1. **The spread is shown as a plain sentence, never only as a raw rate.**
 *    "This swap is 3.2% worse than market." is legible; `0.00412 LTC/XMR` is
 *    not. {@link formatSpreadSentence} is the only approved rendering.
 * 2. **Three bands: green ≤1%, amber ≤5%, red >5%.** Thresholds are exported
 *    constants ({@link SPREAD_THRESHOLDS}) because the right numbers are an
 *    operator decision, not a code decision.
 * 3. **Red BLOCKS, and clearing it takes a TYPED override — not a checkbox.**
 *    A checkbox is clicked reflexively; typing a phrase is not. See
 *    {@link evaluateSpreadGate}.
 * 4. **A missing price feed is RED, never green.** If `fetchUsdPrices` returned
 *    `{}` (every provider down) or simply has no entry for one of the two
 *    tickers, we *cannot verify* the rate — and "cannot verify" must never
 *    render as "verified fine".
 *
 * ## Why "red blocks" and "advisory data must never block" are both true
 *
 * `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` §3 requires advisory data to degrade to
 * "unavailable" and never block; the execution plan requires an unavailable
 * feed to read as red. Those look contradictory and are not: **red is not a
 * hard block.** The typed override is always available, so a dead price feed
 * can never make a swap impossible (walk-away test) — it can only stop the
 * wallet from silently blessing a rate it did not check. Do not "fix" this by
 * removing the override (breaks walk-away) or by defaulting an unverifiable
 * rate to green (breaks the anti-trap layer).
 *
 * ## What this file must never do
 *
 * It never reads, mentions, or is influenced by the pwnda licence fee. The
 * swap must run and settle identically whether a fee is ever paid, so no fee
 * value may enter a gating decision — including this one.
 */

// =========================================================================
// Thresholds
// =========================================================================

/** Upper edge of the green band, in percent. Inclusive. */
export const SPREAD_GREEN_MAX_PCT = 1;

/** Upper edge of the amber band, in percent. Inclusive; above it is red. */
export const SPREAD_AMBER_MAX_PCT = 5;

/** The bands as one configurable object. */
export interface SpreadThresholds {
  /** Inclusive upper edge of green, in percent. */
  greenMaxPct: number;
  /** Inclusive upper edge of amber, in percent. Above → red. */
  amberMaxPct: number;
}

export const SPREAD_THRESHOLDS: SpreadThresholds = {
  greenMaxPct: SPREAD_GREEN_MAX_PCT,
  amberMaxPct: SPREAD_AMBER_MAX_PCT,
};

/**
 * The phrase the user must TYPE to clear a red band.
 *
 * Deliberately not a checkbox and deliberately not "yes": it has to be long
 * enough that typing it is a decision. Compared case-insensitively with
 * whitespace collapsed ({@link isOverrideTyped}) so the check is not a
 * keyboard-accuracy test.
 */
export const SPREAD_OVERRIDE_PHRASE = "I ACCEPT THIS RATE";

// =========================================================================
// Types
// =========================================================================

export type SpreadBand = "green" | "amber" | "red";

export type SpreadReason =
  /** Inside the green band and effectively at market. */
  | "within-tolerance"
  /** Priced better than the reference for the user. */
  | "better-than-market"
  /** Worse than the reference, but inside green or amber. */
  | "worse-than-market"
  /** Worse than the reference by more than the amber ceiling — red. */
  | "far-worse-than-market"
  /** No usable reference price. Red, and explicitly unverified. */
  | "feed-unavailable"
  /** The offer's own rate could not be read. Red, and explicitly unverified. */
  | "rate-unusable";

export interface SpreadAssessment {
  band: SpreadBand;
  /**
   * True only when a real comparison happened. A `false` here with
   * `band === "red"` is the cannot-verify case, which reads very differently
   * to the user than a genuinely bad price — keep them distinguishable.
   */
  verified: boolean;
  /**
   * Signed percentage. **Positive means worse for the user.** `null` when
   * unverified.
   */
  spreadPct: number | null;
  /** What the user pays, in send-coin per 1 receive-coin. */
  offerRate: number | null;
  /** The reference for the same quantity. */
  marketRate: number | null;
  reason: SpreadReason;
  /** True iff `band === "red"`. Convenience for the gate. */
  blocked: boolean;
  /** The plain sentence. Never render a spread without it. */
  sentence: string;
}

// =========================================================================
// Reference rate
// =========================================================================

/**
 * Turn two USD prices into the reference rate this module compares against:
 * **send-coin units per 1 receive-coin**, the same quantity as a BasicSwap
 * offer's `rate` for a taker.
 *
 * Returns `null` if either price is missing or non-positive — which is the
 * cannot-verify path, not a zero.
 */
export function marketRateFromUsd(
  sendUsd: number | null | undefined,
  receiveUsd: number | null | undefined,
): number | null {
  if (!isUsableRate(sendUsd) || !isUsableRate(receiveUsd)) return null;
  return (receiveUsd as number) / (sendUsd as number);
}

/**
 * Reference rate straight from a `fetchUsdPrices` result.
 *
 * `fetchUsdPrices` returns `{}` when every provider failed and simply omits
 * tickers it could not price — both of which land here as `null`, i.e. RED.
 * That is the intended behaviour and the reason this helper exists rather than
 * callers indexing the record inline (an inline `prices[t] ?? 0` would produce
 * a *zero* rate and a nonsense spread instead of an honest "cannot verify").
 */
export function marketRateFromPrices(
  sendTicker: string | null | undefined,
  receiveTicker: string | null | undefined,
  prices: Readonly<Record<string, number>> | null | undefined,
): number | null {
  if (!prices || !sendTicker || !receiveTicker) return null;
  const send = prices[sendTicker.toUpperCase()];
  const receive = prices[receiveTicker.toUpperCase()];
  return marketRateFromUsd(send, receive);
}

function isUsableRate(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// =========================================================================
// The computation
// =========================================================================

/**
 * Compare an offer's rate against a reference rate.
 *
 * **Both arguments must be the same quantity**: send-coin per 1 receive-coin,
 * so that a *higher* number is *worse* for the user. Feeding an inverted rate
 * in flips the sign of every verdict, so build `marketRate` with
 * {@link marketRateFromUsd} / {@link marketRateFromPrices} rather than by hand.
 *
 * `marketRate` of `null` / `undefined` / `0` / `NaN` is the feed-unavailable
 * case and returns RED with `verified: false`.
 */
export function computeSpread(
  offerRate: number | null | undefined,
  marketRate: number | null | undefined,
  thresholds: SpreadThresholds = SPREAD_THRESHOLDS,
): SpreadAssessment {
  if (!isUsableRate(offerRate)) {
    return unverified("rate-unusable", null, toNumberOrNull(marketRate));
  }
  if (!isUsableRate(marketRate)) {
    return unverified("feed-unavailable", offerRate as number, null);
  }

  const offer = offerRate as number;
  const market = marketRate as number;
  const spreadPct = ((offer - market) / market) * 100;
  const rounded = roundPct(spreadPct);

  let band: SpreadBand;
  if (spreadPct <= thresholds.greenMaxPct) band = "green";
  else if (spreadPct <= thresholds.amberMaxPct) band = "amber";
  else band = "red";

  let reason: SpreadReason;
  if (band === "red") reason = "far-worse-than-market";
  else if (rounded > 0) reason = "worse-than-market";
  else if (rounded < 0) reason = "better-than-market";
  else reason = "within-tolerance";

  const assessment: SpreadAssessment = {
    band,
    verified: true,
    spreadPct,
    offerRate: offer,
    marketRate: market,
    reason,
    blocked: band === "red",
    sentence: "",
  };
  assessment.sentence = formatSpreadSentence(assessment);
  return assessment;
}

function toNumberOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function unverified(
  reason: Extract<SpreadReason, "feed-unavailable" | "rate-unusable">,
  offerRate: number | null,
  marketRate: number | null,
): SpreadAssessment {
  const assessment: SpreadAssessment = {
    band: "red",
    verified: false,
    spreadPct: null,
    offerRate,
    marketRate,
    reason,
    blocked: true,
    sentence: "",
  };
  assessment.sentence = formatSpreadSentence(assessment);
  return assessment;
}

/** One decimal place — the precision the plan's example sentence uses. */
function roundPct(pct: number): number {
  const r = Math.round(pct * 10) / 10;
  // Normalise -0 so `rounded < 0` and `rounded > 0` both read false at zero.
  return r === 0 ? 0 : r;
}

// =========================================================================
// The plain sentence
// =========================================================================

/**
 * The user-facing sentence. This is the ONLY approved way to present a spread:
 * a raw rate on its own is not a disclosure, because a novice cannot tell
 * `0.00412` from `0.00470`.
 *
 * Mechanical framing on purpose — a band against a disclosed reference price,
 * never advice about whether to trade.
 */
export function formatSpreadSentence(assessment: SpreadAssessment): string {
  switch (assessment.reason) {
    case "feed-unavailable":
      return "The market price is unavailable, so this rate cannot be checked.";
    case "rate-unusable":
      return "This offer's rate could not be read, so it cannot be checked.";
    default:
      break;
  }
  const pct = assessment.spreadPct;
  if (pct == null) {
    return "The market price is unavailable, so this rate cannot be checked.";
  }
  const rounded = roundPct(pct);
  if (rounded === 0) return "This swap matches the market rate.";
  const magnitude = Math.abs(rounded).toFixed(1);
  return rounded > 0
    ? `This swap is ${magnitude}% worse than market.`
    : `This swap is ${magnitude}% better than market.`;
}

/**
 * One extra line for the amber/red cases, naming what the band means without
 * telling the user what to do. Empty string for green.
 */
export function formatBandNote(assessment: SpreadAssessment): string {
  if (!assessment.verified) {
    return "You are swapping with another user on an open network, and the wallet could not compare this offer to a reference price.";
  }
  switch (assessment.band) {
    case "amber":
      return "That is above the usual range for this book. The rate is the counterparty's, not the wallet's.";
    case "red":
      return "That is far outside the usual range. Offers this far from market are often stale or set as traps.";
    default:
      return "";
  }
}

// =========================================================================
// The gate
// =========================================================================

export interface SpreadGate {
  /** Whether the UI may enable the confirm control. */
  canProceed: boolean;
  /** True when a red band is in force and a typed phrase is the only way past. */
  requiresTypedOverride: boolean;
  /** The exact phrase to display and require, or `null` when none is needed. */
  overridePhrase: string | null;
  /** Whether the text the user typed matches. */
  overrideSatisfied: boolean;
  /** Full sentence(s) to render at the gate. */
  message: string;
}

/** Collapse whitespace and case so the check is not a typing-accuracy test. */
export function normalizeOverrideInput(typed: string | null | undefined): string {
  return (typed ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Whether the typed text clears a red band. */
export function isOverrideTyped(
  typed: string | null | undefined,
  phrase: string = SPREAD_OVERRIDE_PHRASE,
): boolean {
  const input = normalizeOverrideInput(typed);
  if (input === "") return false;
  return input === normalizeOverrideInput(phrase);
}

/**
 * Turn an assessment plus whatever the user typed into the state the UI
 * enforces.
 *
 * Green and amber proceed (amber shows the spread prominently — that is a
 * rendering decision, not a gating one). Red proceeds ONLY once the phrase is
 * typed. There is no third path, and in particular there is no "the fee was
 * paid so skip the gate" path: gating on anything fee-shaped is exactly the
 * coordinator posture this product must not have.
 */
export function evaluateSpreadGate(
  assessment: SpreadAssessment,
  typedOverride?: string | null,
  phrase: string = SPREAD_OVERRIDE_PHRASE,
): SpreadGate {
  const note = formatBandNote(assessment);
  const message = note ? `${assessment.sentence} ${note}` : assessment.sentence;
  if (assessment.band !== "red") {
    return {
      canProceed: true,
      requiresTypedOverride: false,
      overridePhrase: null,
      overrideSatisfied: false,
      message,
    };
  }
  const satisfied = isOverrideTyped(typedOverride, phrase);
  return {
    canProceed: satisfied,
    requiresTypedOverride: true,
    overridePhrase: phrase,
    overrideSatisfied: satisfied,
    message,
  };
}
