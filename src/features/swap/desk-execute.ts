/**
 * The desk accept path — the swap-desk's counterpart to `swap-execute.ts`.
 *
 * ## Why this is a separate module
 *
 * `swap-execute.ts` implements a strictly ONE-SHOT swap: build -> sign ->
 * broadcast in TypeScript, returning a single `sourceTxHash`. A desk swap has
 * none of those steps. The TS layer's entire job is to accept a quote; the
 * Rust core then runs a multi-step atomic protocol over 10-60 minutes, gated
 * on its own chain observation, with a refund watcher behind it. Forcing that
 * into the one-shot executor would distort both.
 *
 * There is also a hard mechanical reason: `swap-execute.test.ts` mocks its
 * dependency graph with exhaustive `vi.mock` object literals, so adding a
 * Tauri-reaching import to that module breaks a pile of unrelated tests.
 *
 * ## The point of no return
 *
 * `deskAccept` is this flow's equivalent of `broadcast`: it reserves desk
 * inventory and creates a persisted swap. Everything before it is reversible;
 * nothing after it is. So every check — freshness, amount, addresses, and the
 * mock hard-stop — happens BEFORE that call, in that order, and any failure
 * means `deskAccept` is never reached.
 */
import {
  deskAccept,
  deskQuote,
  type DeskSwapSummary,
} from "../../api/desk-rust";
import type { NormalizedQuote } from "./useSwapQuote";
import {
  SafetyInvariantError,
  assertDeskQuoteFresh,
  assertDeskQuoteMatchesUserIntent,
  logSafetyIncident,
} from "./safety-invariants";
import { effectiveModeForSource } from "./router-modes";

/**
 * Thrown INSTEAD of accepting when the desk is not in live mode.
 *
 * A sibling of `MockSwapAttemptedError`, not a reuse of it: that error's
 * payload is `{signedTxHex, chainKind, destinationAddress}`, and surfacing it
 * here would make the shared mock-stop footer render a signed-transaction
 * textarea for a flow that never signed anything in TypeScript. Desk-shaped
 * fields keep the panel honest.
 */
export class DeskMockAttemptedError extends Error {
  readonly name = "DeskMockAttemptedError";
  readonly quoteId: string;
  readonly pair: string;
  readonly direction: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly payoutAddress: string;
  readonly refundAddress: string;
  readonly reason: "ENV_FLAG_MOCK";

  constructor(args: {
    message: string;
    quoteId: string;
    pair: string;
    direction: string;
    amountIn: string;
    amountOut: string;
    payoutAddress: string;
    refundAddress: string;
  }) {
    super(args.message);
    this.quoteId = args.quoteId;
    this.pair = args.pair;
    this.direction = args.direction;
    this.amountIn = args.amountIn;
    this.amountOut = args.amountOut;
    this.payoutAddress = args.payoutAddress;
    this.refundAddress = args.refundAddress;
    this.reason = "ENV_FLAG_MOCK";
    // Required so `instanceof` survives transpile-down.
    Object.setPrototypeOf(this, DeskMockAttemptedError.prototype);
  }
}

const DESK_MOCK_MESSAGE =
  "The Pwnda desk is in testing mode — accepting a swap is blocked by design. " +
  "No inventory was reserved and no funds will move. " +
  "This lifts when the desk is enabled for live trading.";

/**
 * Phases of the accept path, surfaced for progress UI. Deliberately NOT
 * `SwapExecutionPhase` — there is no build/sign/broadcast here, and reusing
 * that union would invite a shared progress component to render steps this
 * flow never performs.
 */
export type DeskStartPhase =
  | "checking-quote"
  | "requoting"
  | "accepting"
  | "accepted";

export interface StartDeskSwapArgs {
  /** The quote currently on screen. */
  quote: NormalizedQuote;
  /** Source ticker (what the user pays). */
  fromAsset: string;
  /** Destination ticker (what the user receives). */
  toAsset: string;
  /** Source asset display decimals, for the amount invariant. */
  fromDecimals: number;
  /** Exactly what the user typed, a decimal string. */
  typedAmount: string;
  /** Where the bought coin lands. */
  payoutAddress: string;
  /** Where funds are reclaimed if the swap fails. NOT a signing address. */
  refundAddress: string;
  onPhase?: (p: DeskStartPhase) => void;
  /** Injectable clock (unix SECONDS) for tests. */
  nowSeconds?: () => number;
}

/**
 * Validate and accept a desk swap. Resolves with the persisted swap summary;
 * the tracker takes over from there.
 */
export async function startDeskSwap(
  args: StartDeskSwapArgs
): Promise<DeskSwapSummary> {
  const {
    quote,
    fromAsset,
    toAsset,
    fromDecimals,
    typedAmount,
    payoutAddress,
    refundAddress,
    onPhase,
    nowSeconds = () => Math.floor(Date.now() / 1000),
  } = args;

  let dq = quote.deskQuote;
  if (!dq) {
    throw new Error(
      "Desk accept was called without a desk quote — this is a client bug."
    );
  }

  // ── 1. Freshness. The hook pauses its background refresh while a confirm
  // modal is open and desk TTLs run 30-120s, so a quote that rendered fine can
  // be well past its deadline by the time the user clicks.
  onPhase?.("checking-quote");
  let expired = false;
  try {
    assertDeskQuoteFresh({ expiresAt: dq.expiresAt, nowSeconds: nowSeconds() });
  } catch {
    expired = true;
  }
  if (expired) {
    onPhase?.("requoting");
    // Re-price in place rather than failing the user back to the form.
    dq = await deskQuote({
      pair: dq.pair,
      direction: dq.direction,
      amountIn: dq.amountIn,
    });
    // A re-quote that comes back already stale means something is wrong with
    // the clock or the desk; do not loop.
    assertDeskQuoteFresh({ expiresAt: dq.expiresAt, nowSeconds: nowSeconds() });
  }

  // ── 2. The amount actually being accepted is the amount the user typed.
  // Decimal-aware: passing these through an atomic parser would truncate
  // "0.1" to zero and report a bogus form-state bug.
  try {
    assertDeskQuoteMatchesUserIntent({
      quoteAmountInDecimal: dq.amountIn,
      userTypedDecimal: typedAmount,
      decimals: fromDecimals,
      ticker: fromAsset,
    });
  } catch (e) {
    if (e instanceof SafetyInvariantError) void logSafetyIncident(e);
    throw e;
  }

  // ── 3. Addresses. Both are required and must differ — the same address on
  // both sides means either a UI wiring bug or a pair whose two legs resolved
  // to one wallet, and either way the refund path would be meaningless.
  if (!payoutAddress || !refundAddress) {
    throw new Error(
      `A ${toAsset} payout address and a ${fromAsset} refund address are both required.`
    );
  }
  if (payoutAddress === refundAddress) {
    throw new Error(
      "Payout and refund addresses are identical — refusing to accept. " +
        "This is a client wiring bug, not a user error."
    );
  }

  // ── 4. Mock hard-stop. Positioned deliberately: AFTER the quote and every
  // invariant have proven out (so testing mode exercises the same validation
  // live mode will) and IMMEDIATELY BEFORE the irreversible call. Reads
  // router-modes rather than import.meta.env directly, so mock state is
  // painted from one place.
  if (!effectiveModeForSource("pwnda-desk").isLive) {
    throw new DeskMockAttemptedError({
      message: DESK_MOCK_MESSAGE,
      quoteId: dq.quoteId,
      pair: dq.pair,
      direction: dq.direction,
      amountIn: dq.amountIn,
      amountOut: dq.amountOut,
      payoutAddress,
      refundAddress,
    });
  }

  // ── 5. The point of no return.
  onPhase?.("accepting");
  // pair/direction come off the quote we just validated, not off `fromAsset`/
  // `toAsset`: `direction` is what the core derives the client's ROLE from, and
  // the role decides which key material this swap generates.
  const summary = await deskAccept({
    quoteId: dq.quoteId,
    pair: dq.pair,
    direction: dq.direction,
    payoutAddress,
    refundAddress,
  });
  onPhase?.("accepted");
  return summary;
}
