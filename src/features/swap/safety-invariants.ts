/**
 * Safety invariants for the swap pipeline.
 *
 * Principle: every boundary between data layers must reject implausibly-
 * out-of-range values BEFORE the next stage runs. The wallet has no
 * recourse once a tx broadcasts to chain — invariant checks are the only
 * mechanism for catching bugs in the build / sign / broadcast layers
 * before they cost money.
 *
 * Each invariant catches a specific bug class:
 *
 *   1. assertQuoteAmountMatchesUserIntent — catches a quote that returns
 *      an amount-to-send wildly different from what the user typed (off-
 *      by-decimals, swapped-direction, malicious-server scenarios).
 *
 *   2. assertTxValueMatchesQuote — catches a tx-build step that produced
 *      a value field different from the quote's amountIn (the historical
 *      `decimalToBaseUnits(amountIn, 18)` over-conversion bug).
 *
 *   3. assertTxFundable — catches the case where value + gas exceeds the
 *      user's balance. Strict balance check (less aggressive than the 2×
 *      check below; this one fires even on near-overspend cases that are
 *      probably user error rather than wallet bugs).
 *
 *   4. assertTxNotPlausibleOverspend — catches catastrophic conversion
 *      bugs by refusing to broadcast a tx whose value > 2× balance. The
 *      threshold tolerates legitimate gas-eats-balance edge cases while
 *      rejecting any factor-of-10⁶+ unit-mistake.
 *
 *   5. assertSignedTxValueMatches — catches a signing layer that
 *      corrupted the value field or recipient between build and sign.
 *      Decodes the signed RLP-encoded EVM tx and re-checks every
 *      money-relevant field.
 *
 *   6. assertVerifiedHashMatches — catches an RPC that returned a
 *      different hash than the signed tx would actually produce on
 *      chain (RPC misbehavior, mid-flight signature corruption,
 *      replay-prevention bugs).
 *
 * On any violation, callers should:
 *   1. NOT retry — the bug is in the wallet, not the network
 *   2. Surface the invariant message to the user verbatim (it's
 *      copy-friendly so they can report it)
 *   3. Log to the local incident file via `logSafetyIncident` so they
 *      can attach diagnostic context when reporting
 *
 * Historical bugs this catches (verified by the regression suite):
 *
 *   - Asset id `ETH.ETH` (SwapKit shape) sent to NEAR Intents → rejected
 *     by quote-time validation, never reaches this layer (caught by
 *     `intents-asset-resolver.ts`).
 *
 *   - Recipient placeholder (e.g. EVM address in BTC `recipient` slot) →
 *     rejected at quote-time by `addressForAssetId` validators (caught
 *     by `intents-asset-resolver.ts`).
 *
 *   - Amount sent as display units `"0.005"` instead of wei → rejected
 *     by `assertQuoteAmountMatchesUserIntent` here.
 *
 *   - `dry: false` field missing → caught by `useSwapQuote.ts` body-shape
 *     test before this layer runs.
 *
 *   - `decimalToBaseUnits(amountIn, 18)` re-conversion (5-sextillion-ETH
 *     bug) → caught here by `assertQuoteAmountMatchesUserIntent` AND
 *     `assertTxValueMatchesQuote` AND `assertTxNotPlausibleOverspend`,
 *     three layers deep.
 */

import { invoke } from "../../lib/tauri";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---------------------------------------------------------------------------
// SafetyInvariantError
// ---------------------------------------------------------------------------

/**
 * Hard-stop error thrown by an invariant assertion. Distinct from
 * `InsufficientFundsValidationError` and `MockSwapAttemptedError` — those
 * are typed business outcomes; this one means "the wallet detected its
 * own bug and is refusing to proceed".
 *
 * Callers MUST NOT retry on this error class. The user should close the
 * modal and re-quote.
 */
export class SafetyInvariantError extends Error {
  readonly name = "SafetyInvariantError";
  /** Stable identifier for the invariant that fired. */
  readonly invariant: SafetyInvariantId;
  /** Money-relevant context, surfaced to the user via Copy Details. */
  readonly context: Record<string, string>;

  constructor(args: {
    invariant: SafetyInvariantId;
    message: string;
    context: Record<string, string>;
  }) {
    super(args.message);
    this.invariant = args.invariant;
    this.context = args.context;
    Object.setPrototypeOf(this, SafetyInvariantError.prototype);
  }

  /**
   * Format the error for the user-facing Copy Details button. Includes
   * the invariant id, message, all context, and a timestamp.
   */
  toCopyText(): string {
    const lines = [
      `[SafetyInvariantError]`,
      `invariant: ${this.invariant}`,
      `at: ${new Date().toISOString()}`,
      ``,
      this.message,
      ``,
      `Context:`,
      ...Object.entries(this.context).map(([k, v]) => `  ${k}: ${v}`),
    ];
    return lines.join("\n");
  }
}

export type SafetyInvariantId =
  | "QUOTE_AMOUNT_VS_USER_INTENT"
  | "TX_VALUE_VS_QUOTE"
  | "TX_NOT_FUNDABLE"
  | "TX_PLAUSIBLE_OVERSPEND"
  | "SIGNED_TX_VALUE_DRIFT"
  | "SIGNED_TX_RECIPIENT_DRIFT"
  | "VERIFIED_HASH_MISMATCH"
  | "SOL_PROGRAM_NOT_TRANSFER"
  | "SOL_RECIPIENT_DRIFT"
  | "NEAR_ACTION_NOT_TRANSFER"
  | "NEAR_RECIPIENT_DRIFT"
  | "PSBT_OUTPUT_VALUE_DRIFT"
  | "PSBT_RECIPIENT_DRIFT"
  // Phase 1 (ERC-20 source-tx pipeline) — fired when an ERC-20 source
  // tx escapes with a non-zero `value` field (would burn native gas to
  // the token contract for nothing) or with calldata that isn't
  // `transfer(address,uint256)`.
  | "ERC20_SOURCE_VALUE_DRIFT"
  | "ERC20_SOURCE_CALLDATA_DRIFT"
  // 2026-05-08 P0 (display-units bug): fired when any quote-display
  // numeric value exceeds 10M units of its labeled asset. Catches the
  // class of bug where atomic-units (wei / sat / lamport) leak into the
  // display layer (e.g. POL → AVAX showed 10269776004666684 AVAX when
  // it should have shown 0.01 AVAX). Threshold is intentionally aggressive:
  // virtually no real swap shows 10M+ of a major asset; the few exceptions
  // (very-low-value stables, very-high-decimal tokens) are surfaced via
  // an explicit allow-list when the need arises.
  | "DISPLAY_AMOUNT_OVER_THRESHOLD"
  // 2026-07-19 (pwnda-desk): the desk's analogues of
  // QUOTE_AMOUNT_VS_USER_INTENT, plus a freshness check the aggregators
  // don't need because only the desk publishes a hard quote expiry.
  | "DESK_QUOTE_AMOUNT_VS_USER_INTENT"
  | "DESK_QUOTE_EXPIRED";

// ---------------------------------------------------------------------------
// Invariant 1: quote.amountIn ≈ user-intended atomic amount
// ---------------------------------------------------------------------------

/**
 * Allow ±1% drift between the user-intended amount and the quote's
 * `amountIn`. The free tier of 1Click sometimes rounds the last few
 * digits or applies a tiny pre-fee deduction; we tolerate that, but
 * reject anything bigger.
 */
const QUOTE_AMOUNT_DRIFT_TOLERANCE = 0.01;

export interface QuoteAmountAssertArgs {
  /** Atomic-units bigint of what 1Click told us the source-chain tx will spend. */
  quoteAmountAtomic: bigint;
  /** Atomic-units bigint of what the user typed (display amount × 10^decimals). */
  userIntendedAtomic: bigint;
  /** Source ticker for error message context. */
  ticker: string;
  /** Source asset's display decimals — for human-readable context. */
  decimals: number;
}

export function assertQuoteAmountMatchesUserIntent(args: QuoteAmountAssertArgs): void {
  const { quoteAmountAtomic, userIntendedAtomic, ticker, decimals } = args;
  if (userIntendedAtomic === 0n) {
    throw new SafetyInvariantError({
      invariant: "QUOTE_AMOUNT_VS_USER_INTENT",
      message:
        `User-intended amount is zero — refusing to proceed. ` +
        `This usually indicates an upstream form-state bug.`,
      context: {
        ticker,
        quoteAmountAtomic: quoteAmountAtomic.toString(),
        userIntendedAtomic: userIntendedAtomic.toString(),
      },
    });
  }
  // Use BigInt math up front to avoid Number precision loss for large values.
  // The ratio is computed with Number only after we've established both
  // sides are within roughly the same order of magnitude.
  const orderOfMagnitudeMax =
    userIntendedAtomic > 0n
      ? quoteAmountAtomic / userIntendedAtomic
      : 0n;
  const orderOfMagnitudeMin =
    quoteAmountAtomic > 0n
      ? userIntendedAtomic / quoteAmountAtomic
      : 0n;
  if (orderOfMagnitudeMax >= 100n || orderOfMagnitudeMin >= 100n) {
    throw new SafetyInvariantError({
      invariant: "QUOTE_AMOUNT_VS_USER_INTENT",
      message:
        `Quote returned amountIn ${quoteAmountAtomic} (atomic units of ${ticker}) ` +
        `but user typed an amount equivalent to ${userIntendedAtomic} (atomic). ` +
        `Mismatch is ${orderOfMagnitudeMax > 0n ? orderOfMagnitudeMax.toString() : `1/${orderOfMagnitudeMin}`}× — ` +
        `this is far outside the ±1% rounding band. Refusing to proceed.`,
      context: {
        ticker,
        decimals: decimals.toString(),
        quoteAmountAtomic: quoteAmountAtomic.toString(),
        userIntendedAtomic: userIntendedAtomic.toString(),
      },
    });
  }
  // Within order of magnitude — now check the precise ratio in float space.
  const ratio = Number(quoteAmountAtomic) / Number(userIntendedAtomic);
  if (
    !Number.isFinite(ratio) ||
    ratio < 1 - QUOTE_AMOUNT_DRIFT_TOLERANCE ||
    ratio > 1 + QUOTE_AMOUNT_DRIFT_TOLERANCE
  ) {
    throw new SafetyInvariantError({
      invariant: "QUOTE_AMOUNT_VS_USER_INTENT",
      message:
        `Quote returned amountIn ${quoteAmountAtomic} (atomic units of ${ticker}) ` +
        `but user typed an amount equivalent to ${userIntendedAtomic} (atomic). ` +
        `Drift ratio ${ratio.toFixed(6)} is outside the ±${(QUOTE_AMOUNT_DRIFT_TOLERANCE * 100).toFixed(1)}% band. ` +
        `Refusing to proceed.`,
      context: {
        ticker,
        decimals: decimals.toString(),
        quoteAmountAtomic: quoteAmountAtomic.toString(),
        userIntendedAtomic: userIntendedAtomic.toString(),
        ratio: ratio.toFixed(9),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 2: built tx value === quote.amountIn (exact, no drift allowed)
// ---------------------------------------------------------------------------

export function assertTxValueMatchesQuote(args: {
  txValueAtomic: bigint;
  quoteAmountAtomic: bigint;
  ticker: string;
}): void {
  if (args.txValueAtomic !== args.quoteAmountAtomic) {
    throw new SafetyInvariantError({
      invariant: "TX_VALUE_VS_QUOTE",
      message:
        `Built tx value ${args.txValueAtomic} (${args.ticker} atomic) does not equal ` +
        `quote amountIn ${args.quoteAmountAtomic}. The build step corrupted the value ` +
        `field — refusing to sign.`,
      context: {
        ticker: args.ticker,
        txValueAtomic: args.txValueAtomic.toString(),
        quoteAmountAtomic: args.quoteAmountAtomic.toString(),
        differenceAtomic: (args.txValueAtomic - args.quoteAmountAtomic).toString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 3: tx is fundable (value + gas <= balance)
// ---------------------------------------------------------------------------

export function assertTxFundable(args: {
  valueAtomic: bigint;
  gasCostAtomic: bigint;
  balanceAtomic: bigint;
  ticker: string;
}): void {
  const total = args.valueAtomic + args.gasCostAtomic;
  if (total > args.balanceAtomic) {
    throw new SafetyInvariantError({
      invariant: "TX_NOT_FUNDABLE",
      message:
        `Tx requires ${total} ${args.ticker} atomic units (value ${args.valueAtomic} + ` +
        `gas ${args.gasCostAtomic}) but the source address has only ${args.balanceAtomic}. ` +
        `Either lower the swap amount or fund the source address before retrying.`,
      context: {
        ticker: args.ticker,
        valueAtomic: args.valueAtomic.toString(),
        gasCostAtomic: args.gasCostAtomic.toString(),
        totalAtomic: total.toString(),
        balanceAtomic: args.balanceAtomic.toString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 4: tx value <= 2× balance (catches catastrophic conversion bugs)
// ---------------------------------------------------------------------------

export function assertTxNotPlausibleOverspend(args: {
  valueAtomic: bigint;
  balanceAtomic: bigint;
  ticker: string;
}): void {
  if (args.balanceAtomic === 0n) {
    // Can't compute 2× of zero meaningfully. Defer to the funding check.
    return;
  }
  if (args.valueAtomic > 2n * args.balanceAtomic) {
    throw new SafetyInvariantError({
      invariant: "TX_PLAUSIBLE_OVERSPEND",
      message:
        `Tx value ${args.valueAtomic} ${args.ticker} atomic is more than 2× the source ` +
        `address's balance (${args.balanceAtomic}). This is the canonical signature of ` +
        `an amount-conversion bug — refusing to sign even if some part of the value ` +
        `would technically be fundable.`,
      context: {
        ticker: args.ticker,
        valueAtomic: args.valueAtomic.toString(),
        balanceAtomic: args.balanceAtomic.toString(),
        ratio: (Number(args.valueAtomic) / Number(args.balanceAtomic || 1n)).toFixed(3),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 5: signed-tx value + recipient match what we built (EVM)
// ---------------------------------------------------------------------------

/**
 * Decode an RLP-encoded signed EVM transaction (legacy or EIP-1559) and
 * extract its `value` and `to` fields. Throws on parse failure.
 *
 * RLP layouts:
 *   - Legacy:    [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
 *   - EIP-1559: 0x02 || rlp([chainId, nonce, maxPriority, maxFee, gasLimit, to, value, data, accessList, v, r, s])
 */
export function decodeEvmSignedTx(rawTxHex: string): { to: string; value: bigint } {
  const cleaned = rawTxHex.startsWith("0x") ? rawTxHex.slice(2) : rawTxHex;
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) {
    throw new SafetyInvariantError({
      invariant: "SIGNED_TX_VALUE_DRIFT",
      message: "Signed tx hex is empty or odd-length — cannot decode.",
      context: { rawTxHexLen: cleaned.length.toString() },
    });
  }
  const bytes = hexToBytes(cleaned);
  // EIP-2718 typed-tx envelope: leading byte 0x01 / 0x02 / 0x03.
  let payload: Uint8Array;
  let isLegacy = false;
  if (bytes[0] >= 0x01 && bytes[0] <= 0x7f) {
    // Typed envelope — strip the leading byte and RLP-decode the rest.
    payload = bytes.subarray(1);
  } else {
    // Legacy: full bytes are RLP.
    payload = bytes;
    isLegacy = true;
  }
  const list = rlpDecode(payload);
  if (!Array.isArray(list)) {
    throw new SafetyInvariantError({
      invariant: "SIGNED_TX_VALUE_DRIFT",
      message: "Signed EVM tx did not RLP-decode to a list.",
      context: { rlpKind: typeof list },
    });
  }
  // Field offsets:
  //   legacy:    [nonce(0), gasPrice(1), gasLimit(2), to(3), value(4), data(5), v(6), r(7), s(8)]
  //   1559/2930: [chainId(0), nonce(1), maxPriority(2)|gasPrice(2), maxFee(3)|gasLimit(3),
  //              gasLimit(4)|to(4), to(5)|value(5), value(6)|data(6), data(7)|accessList(7), …]
  // Robust approach: find `to` by checking 20-byte and `value` immediately after.
  let toIdx: number;
  let valueIdx: number;
  if (isLegacy) {
    toIdx = 3;
    valueIdx = 4;
  } else {
    // EIP-2930 (type 0x01): chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, v, r, s
    // EIP-1559 (type 0x02): chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList, v, r, s
    // EIP-4844 (type 0x03) is similar shape with extra blob fields.
    // Both 2930 and 1559 share the layout [..., to, value, data, accessList, ...] with `to` at index 4 (2930) or 5 (1559).
    if (bytes[0] === 0x01) {
      toIdx = 4;
      valueIdx = 5;
    } else if (bytes[0] === 0x02) {
      toIdx = 5;
      valueIdx = 6;
    } else if (bytes[0] === 0x03) {
      toIdx = 5;
      valueIdx = 6;
    } else {
      throw new SafetyInvariantError({
        invariant: "SIGNED_TX_VALUE_DRIFT",
        message: `Unrecognized EVM tx envelope type 0x${bytes[0].toString(16)} — cannot decode.`,
        context: { envelopeByte: `0x${bytes[0].toString(16)}` },
      });
    }
  }
  const toBytes = list[toIdx];
  const valueBytes = list[valueIdx];
  if (!(toBytes instanceof Uint8Array) || !(valueBytes instanceof Uint8Array)) {
    throw new SafetyInvariantError({
      invariant: "SIGNED_TX_VALUE_DRIFT",
      message: "Signed EVM tx fields decoded to non-bytes — corrupt structure.",
      context: { toIdx: toIdx.toString(), valueIdx: valueIdx.toString() },
    });
  }
  const to = "0x" + bytesToHex(toBytes).padStart(40, "0").slice(-40);
  let value = 0n;
  for (const b of valueBytes) {
    value = (value << 8n) | BigInt(b);
  }
  return { to, value };
}

export function assertSignedTxValueMatches(args: {
  rawSignedTxHex: string;
  expectedValueAtomic: bigint;
  expectedRecipient: string;
  ticker: string;
}): void {
  const decoded = decodeEvmSignedTx(args.rawSignedTxHex);
  if (decoded.value !== args.expectedValueAtomic) {
    throw new SafetyInvariantError({
      invariant: "SIGNED_TX_VALUE_DRIFT",
      message:
        `Signed EVM tx value ${decoded.value} ${args.ticker} does not match the value we built ` +
        `(${args.expectedValueAtomic}). Signing corrupted the value field — refusing to broadcast.`,
      context: {
        ticker: args.ticker,
        signedTxValue: decoded.value.toString(),
        expectedValue: args.expectedValueAtomic.toString(),
        rawTxHexHead: args.rawSignedTxHex.slice(0, 130),
      },
    });
  }
  if (decoded.to.toLowerCase() !== args.expectedRecipient.toLowerCase()) {
    throw new SafetyInvariantError({
      invariant: "SIGNED_TX_RECIPIENT_DRIFT",
      message:
        `Signed EVM tx recipient ${decoded.to} does not match the deposit address ` +
        `${args.expectedRecipient}. Refusing to broadcast.`,
      context: {
        ticker: args.ticker,
        signedTxTo: decoded.to,
        expectedTo: args.expectedRecipient,
        rawTxHexHead: args.rawSignedTxHex.slice(0, 130),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 6: verified hash matches local keccak256(signed-tx)
// ---------------------------------------------------------------------------

export function assertVerifiedHashMatches(args: {
  rawSignedTxHex: string;
  verifiedHash: string;
}): void {
  const cleaned = args.rawSignedTxHex.startsWith("0x")
    ? args.rawSignedTxHex.slice(2)
    : args.rawSignedTxHex;
  const expected = "0x" + bytesToHex(keccak_256(hexToBytes(cleaned)));
  const got = args.verifiedHash.toLowerCase();
  if (got !== expected.toLowerCase()) {
    throw new SafetyInvariantError({
      invariant: "VERIFIED_HASH_MISMATCH",
      message:
        `Network returned hash ${args.verifiedHash} but local keccak256 of the signed tx ` +
        `is ${expected}. Possible RPC misbehavior — investigate before declaring success. ` +
        `The tx may or may not have actually broadcast; check on the chain explorer.`,
      context: {
        verifiedHash: args.verifiedHash,
        expectedHash: expected,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 7-10: Non-EVM equivalents
// ---------------------------------------------------------------------------

export function assertSolTransferShape(args: {
  programIdBase58: string;
  expectedRecipient: string;
  recipientFromTx: string;
  amountAtomic: bigint;
  expectedAmountAtomic: bigint;
}): void {
  // Solana System Program is the canonical "11111111111111111111111111111111".
  // Any other program id in a swap-source tx is wrong by construction.
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  if (args.programIdBase58 !== SYSTEM_PROGRAM) {
    throw new SafetyInvariantError({
      invariant: "SOL_PROGRAM_NOT_TRANSFER",
      message:
        `Solana tx is calling program ${args.programIdBase58}, not the System Program ` +
        `(${SYSTEM_PROGRAM}). NEAR Intents source-chain transfers MUST be a plain ` +
        `SystemProgram.transfer — refusing to broadcast.`,
      context: {
        programId: args.programIdBase58,
        expectedProgramId: SYSTEM_PROGRAM,
      },
    });
  }
  if (args.recipientFromTx !== args.expectedRecipient) {
    throw new SafetyInvariantError({
      invariant: "SOL_RECIPIENT_DRIFT",
      message:
        `Solana tx recipient ${args.recipientFromTx} does not match the expected deposit ` +
        `address ${args.expectedRecipient}. Refusing to broadcast.`,
      context: {
        recipientFromTx: args.recipientFromTx,
        expectedRecipient: args.expectedRecipient,
      },
    });
  }
  if (args.amountAtomic !== args.expectedAmountAtomic) {
    throw new SafetyInvariantError({
      invariant: "TX_VALUE_VS_QUOTE",
      message:
        `Solana tx lamports ${args.amountAtomic} does not match the quote's amountIn ` +
        `${args.expectedAmountAtomic}. Refusing to broadcast.`,
      context: {
        ticker: "SOL",
        txValueAtomic: args.amountAtomic.toString(),
        quoteAmountAtomic: args.expectedAmountAtomic.toString(),
      },
    });
  }
}

export function assertNearTransferShape(args: {
  expectedRecipient: string;
  recipientFromTx: string;
  yoctoAmountFromTx: bigint;
  expectedYoctoAmount: bigint;
  /** The NEAR action enum tag — 3 = Transfer. */
  actionTag: number;
}): void {
  if (args.actionTag !== 3) {
    throw new SafetyInvariantError({
      invariant: "NEAR_ACTION_NOT_TRANSFER",
      message:
        `NEAR tx action tag is ${args.actionTag}, not Transfer (3). Refusing to broadcast.`,
      context: { actionTag: args.actionTag.toString(), expectedTag: "3" },
    });
  }
  if (args.recipientFromTx !== args.expectedRecipient) {
    throw new SafetyInvariantError({
      invariant: "NEAR_RECIPIENT_DRIFT",
      message:
        `NEAR tx receiver_id ${args.recipientFromTx} does not match the expected deposit ` +
        `address ${args.expectedRecipient}. Refusing to broadcast.`,
      context: {
        recipientFromTx: args.recipientFromTx,
        expectedRecipient: args.expectedRecipient,
      },
    });
  }
  if (args.yoctoAmountFromTx !== args.expectedYoctoAmount) {
    throw new SafetyInvariantError({
      invariant: "TX_VALUE_VS_QUOTE",
      message:
        `NEAR tx yoctoNEAR amount ${args.yoctoAmountFromTx} does not match the quote's ` +
        `amountIn ${args.expectedYoctoAmount}. Refusing to broadcast.`,
      context: {
        ticker: "NEAR",
        txValueAtomic: args.yoctoAmountFromTx.toString(),
        quoteAmountAtomic: args.expectedYoctoAmount.toString(),
      },
    });
  }
}

export function assertPsbtOutputShape(args: {
  outputs: Array<{ address: string; valueSat: bigint }>;
  expectedRecipient: string;
  expectedValueSat: bigint;
  ticker: string;
}): void {
  // A swap-source PSBT can have at most TWO outputs: the deposit + change
  // back to the source address. The deposit must be the first output and
  // its value must match the quote.
  const deposit = args.outputs.find((o) => o.address === args.expectedRecipient);
  if (!deposit) {
    throw new SafetyInvariantError({
      invariant: "PSBT_RECIPIENT_DRIFT",
      message:
        `PSBT has no output to the expected deposit address ${args.expectedRecipient}. ` +
        `Outputs: ${args.outputs.map((o) => o.address).join(", ")}. Refusing to broadcast.`,
      context: {
        ticker: args.ticker,
        expectedRecipient: args.expectedRecipient,
        outputAddresses: args.outputs.map((o) => o.address).join(","),
      },
    });
  }
  if (deposit.valueSat !== args.expectedValueSat) {
    throw new SafetyInvariantError({
      invariant: "PSBT_OUTPUT_VALUE_DRIFT",
      message:
        `PSBT output to ${args.expectedRecipient} has value ${deposit.valueSat} sat ` +
        `but quote.amountIn was ${args.expectedValueSat} sat. Refusing to broadcast.`,
      context: {
        ticker: args.ticker,
        actualValueSat: deposit.valueSat.toString(),
        expectedValueSat: args.expectedValueSat.toString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Telemetry — local incident log
// ---------------------------------------------------------------------------

/**
 * Append a one-line JSON record describing a safety-invariant violation
 * to %LOCALAPPDATA%\com.tauri-eth-wallet\safety-incidents.jsonl.
 *
 * Best-effort — never throws. Telemetry must not block the user's
 * error-banner render. Never auto-uploaded; this is a local file only.
 */
export async function logSafetyIncident(error: SafetyInvariantError, sessionContext: Record<string, string> = {}): Promise<void> {
  try {
    const record = {
      at: new Date().toISOString(),
      invariant: error.invariant,
      message: error.message,
      context: error.context,
      session: sessionContext,
    };
    await invoke("swap_log_safety_incident", { record: JSON.stringify(record) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[safety-invariants] failed to log incident; continuing.",
      String((e as Error)?.message ?? e),
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Minimal RLP decoder (returns Uint8Array | (Uint8Array|nested)[])
// Just enough to extract the `to` and `value` fields from a signed tx.
// ---------------------------------------------------------------------------

type RlpItem = Uint8Array | RlpItem[];

function rlpDecode(bytes: Uint8Array): RlpItem {
  const [item, consumed] = rlpDecodeItem(bytes, 0);
  if (consumed !== bytes.length) {
    throw new Error(`RLP trailing bytes: ${bytes.length - consumed}`);
  }
  return item;
}

function rlpDecodeItem(bytes: Uint8Array, offset: number): [RlpItem, number] {
  if (offset >= bytes.length) throw new Error("RLP: unexpected end of input");
  const b = bytes[offset];
  if (b <= 0x7f) {
    return [bytes.subarray(offset, offset + 1), offset + 1];
  }
  if (b <= 0xb7) {
    const len = b - 0x80;
    return [bytes.subarray(offset + 1, offset + 1 + len), offset + 1 + len];
  }
  if (b <= 0xbf) {
    const lenLen = b - 0xb7;
    const len = readBigEndianUint(bytes, offset + 1, lenLen);
    return [bytes.subarray(offset + 1 + lenLen, offset + 1 + lenLen + len), offset + 1 + lenLen + len];
  }
  if (b <= 0xf7) {
    const len = b - 0xc0;
    const inner = bytes.subarray(offset + 1, offset + 1 + len);
    return [rlpDecodeList(inner), offset + 1 + len];
  }
  // 0xf8..0xff — long list
  const lenLen = b - 0xf7;
  const len = readBigEndianUint(bytes, offset + 1, lenLen);
  const inner = bytes.subarray(offset + 1 + lenLen, offset + 1 + lenLen + len);
  return [rlpDecodeList(inner), offset + 1 + lenLen + len];
}

function rlpDecodeList(bytes: Uint8Array): RlpItem[] {
  const out: RlpItem[] = [];
  let off = 0;
  while (off < bytes.length) {
    const [item, next] = rlpDecodeItem(bytes, off);
    out.push(item);
    off = next;
  }
  return out;
}

function readBigEndianUint(bytes: Uint8Array, offset: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) {
    v = (v << 8) | bytes[offset + i];
  }
  return v;
}

// ---------------------------------------------------------------------------
// Display-amount safety invariant (2026-05-08)
// ---------------------------------------------------------------------------

/**
 * Hard cap on what counts as a sensible display-units value for any major
 * asset surfaced in the swap form. If we render anything above this, it's
 * almost certainly an atomic-units-shown-as-display-units bug.
 *
 * Tuned high enough to comfortably cover plausible memecoin amounts (a
 * thousand SHIB? sure) but low enough that wei (10^15+ for a small ETH
 * amount) and sat (10^4+ for a small BTC amount) ALWAYS trip it.
 */
const DISPLAY_AMOUNT_HARD_CAP = 10_000_000;

/**
 * Refuse to render a quote whose display amount is suspiciously huge.
 * Throws `SafetyInvariantError("DISPLAY_AMOUNT_OVER_THRESHOLD")`. Used by
 * the swap form / confirm modal at every numeric-render site (YOU RECEIVE,
 * RATE, MIN RECEIVED, FEE, TOTAL).
 *
 * The threshold is intentionally aggressive — almost no real swap would
 * display 10M+ of a major asset; the few exceptions (very-low-value
 * stables, very-high-decimal tokens) can opt out via the `allowHigh`
 * escape hatch once an allow-list is needed.
 */
export function assertDisplayedAmountReasonable(args: {
  displayAmount: number;
  ticker: string;
  /** Where in the quote the value is being rendered — useful for the
   *  user-facing error so they know which row triggered. */
  field: "you-receive" | "rate" | "min-received" | "fee" | "total" | "you-send";
  /** Optional escape hatch for known-low-value tokens (PEPE-class). Off by
   *  default so the bug-class catch is universal. */
  allowHigh?: boolean;
}): void {
  if (args.allowHigh) return;
  if (!Number.isFinite(args.displayAmount)) {
    // NaN / Infinity is also a render-layer bug — surface it.
    throw new SafetyInvariantError({
      invariant: "DISPLAY_AMOUNT_OVER_THRESHOLD",
      message: `Quote field "${args.field}" rendered ${args.ticker} as a non-finite number — refusing to display.`,
      context: {
        field: args.field,
        ticker: args.ticker,
        displayAmount: String(args.displayAmount),
      },
    });
  }
  if (args.displayAmount > DISPLAY_AMOUNT_HARD_CAP) {
    throw new SafetyInvariantError({
      invariant: "DISPLAY_AMOUNT_OVER_THRESHOLD",
      message:
        `Quote field "${args.field}" wants to render ${args.displayAmount} ${args.ticker} ` +
        `(> 10M units) — almost certainly an atomic-units-shown-as-display-units ` +
        `bug. Refusing to display the quote.`,
      context: {
        field: args.field,
        ticker: args.ticker,
        displayAmount: args.displayAmount.toString(),
        cap: DISPLAY_AMOUNT_HARD_CAP.toString(),
      },
    });
  }
}

/**
 * Convert an atomic-units string into a human-readable display string.
 *
 * Handles BigInt parsing, divides by 10^decimals, trims trailing zeros.
 * Tolerates a fractional tail in the input (1Click sometimes returns
 * `"5000000000000000.0000022936575480"` — we truncate the fraction since
 * on-chain values are always integers).
 *
 *   formatAtomicForDisplay("5000000000000000", 18) === "0.005"
 *   formatAtomicForDisplay("35127", 8)             === "0.00035127"
 *   formatAtomicForDisplay("100", 0)               === "100"
 *   formatAtomicForDisplay("0", 18)                === "0"
 *
 * Throws on negative or unparseable input.
 */
export function formatAtomicForDisplay(
  atomicStr: string,
  decimals: number,
): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const trimmed = atomicStr.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid atomic-units string: ${atomicStr}`);
  }
  const [intPartStr] = trimmed.split(".");
  const negative = intPartStr.startsWith("-");
  const intPart = negative ? intPartStr.slice(1) : intPartStr;
  const atomic = BigInt(intPart);
  if (atomic === 0n) return "0";
  if (decimals === 0) return (negative ? "-" : "") + atomic.toString();
  const padded = atomic.toString().padStart(decimals + 1, "0");
  const display = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  const out = frac.length > 0 ? `${display}.${frac}` : display;
  return negative ? "-" + out : out;
}

// ---------------------------------------------------------------------------
// Desk invariants (pwnda-desk, 2026-07-19)
// ---------------------------------------------------------------------------

/**
 * The desk's analogue of {@link assertQuoteAmountMatchesUserIntent}.
 *
 * A SEPARATE function is required, not a widened signature, because the two
 * upstreams speak different units. 1Click amounts are ATOMIC strings, so that
 * assert takes bigints. Desk wire amounts are DECIMAL strings ("0.1" XMR ->
 * "27" ADA), and feeding a decimal through an atomic parser truncates "0.1" to
 * 0n — which trips the zero-intent branch and reports a misleading "upstream
 * form-state bug" for what is actually a perfectly valid swap.
 *
 * Both sides are converted to atomic bigints here and then DELEGATED to the
 * existing comparison, so there is still exactly ONE drift tolerance in the
 * codebase rather than a second one that can drift apart from it.
 */
/**
 * Local decimal -> atomic conversion.
 *
 * Deliberately NOT imported from `swap-sources`: that module already imports
 * THIS one, so reaching back for its helper would close an import cycle.
 * safety-invariants sits at the bottom of the dependency order and must stay
 * there — a cycle here would risk `undefined` at module-init time in exactly
 * the layer whose whole job is to refuse to run on bad state.
 */
function decimalStringToAtomic(v: string, decimals: number): bigint {
  const s = String(v ?? "").trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) {
    throw new Error(`not a decimal amount: ${JSON.stringify(v)}`);
  }
  const [intPart, fracRaw = ""] = s.split(".");
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  return (
    BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0")
  );
}

export function assertDeskQuoteMatchesUserIntent(args: {
  /** The desk quote's `amountIn`, a DECIMAL string. */
  quoteAmountInDecimal: string;
  /** What the user typed, a DECIMAL string. */
  userTypedDecimal: string;
  /** Source asset display decimals. */
  decimals: number;
  /** Source ticker, for error context. */
  ticker: string;
}): void {
  const { quoteAmountInDecimal, userTypedDecimal, decimals, ticker } = args;

  const toAtomic = (v: string): bigint => {
    try {
      return decimalStringToAtomic(v, decimals);
    } catch {
      return 0n;
    }
  };
  const quoteAtomic = toAtomic(quoteAmountInDecimal);
  const userAtomic = toAtomic(userTypedDecimal);

  if (userAtomic === 0n) {
    throw new SafetyInvariantError({
      invariant: "DESK_QUOTE_AMOUNT_VS_USER_INTENT",
      message:
        `User-intended amount is zero or unparseable ("${userTypedDecimal}") — ` +
        `refusing to accept a desk swap against it.`,
      context: {
        ticker,
        quoteAmountInDecimal,
        userTypedDecimal,
        decimals: String(decimals),
      },
    });
  }

  try {
    assertQuoteAmountMatchesUserIntent({
      quoteAmountAtomic: quoteAtomic,
      userIntendedAtomic: userAtomic,
      ticker,
      decimals,
    });
  } catch (e) {
    // Re-label so the incident names the desk invariant rather than the
    // aggregator one, while keeping the shared tolerance.
    throw new SafetyInvariantError({
      invariant: "DESK_QUOTE_AMOUNT_VS_USER_INTENT",
      message:
        `Desk quote amountIn (${quoteAmountInDecimal} ${ticker}) does not match ` +
        `what you entered (${userTypedDecimal} ${ticker}). Refusing to accept.`,
      context: {
        ticker,
        quoteAmountInDecimal,
        userTypedDecimal,
        underlying: (e as Error)?.message ?? String(e),
      },
    });
  }
}

/**
 * Refuse to act on a desk quote whose TTL has lapsed.
 *
 * Only the desk publishes an expiry, and the quote hook pauses its background
 * refresh while a confirm modal is open — so a quote can sit on screen well
 * past its deadline. Accepting against it returns QUOTE_EXPIRED from the desk
 * at best; at worst it settles the user at a price they never agreed to.
 */
export function assertDeskQuoteFresh(args: {
  /** Quote expiry, unix SECONDS. */
  expiresAt: number | undefined;
  /** Current time, unix SECONDS. */
  nowSeconds: number;
  /** Refuse this many seconds BEFORE the stated deadline, to cover the
   *  round-trip between here and the desk accepting. */
  marginSeconds?: number;
}): void {
  const { expiresAt, nowSeconds, marginSeconds = 5 } = args;
  if (!expiresAt) return; // no published expiry -> nothing to enforce
  if (nowSeconds < expiresAt - marginSeconds) return;
  throw new SafetyInvariantError({
    invariant: "DESK_QUOTE_EXPIRED",
    message:
      `This desk quote expired (deadline ${expiresAt}, now ${nowSeconds}). ` +
      `Re-quote before accepting.`,
    context: {
      expiresAt: String(expiresAt),
      nowSeconds: String(nowSeconds),
      marginSeconds: String(marginSeconds),
    },
  });
}
