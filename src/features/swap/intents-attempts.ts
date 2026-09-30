/**
 * One NEAR Intents quote, one deposit attempt (2026-09-29 send-safety audit, F2).
 *
 * # Why this exists
 *
 * A 1Click quote carries a deposit address, and the swap is "whatever lands at
 * that address before the deadline". Signing a second deposit for the same
 * address is therefore a second payment for the same swap. Before this file,
 * nothing stopped it:
 *
 *  - a relay error from `notifyIntentsDeposit` AFTER the broadcast rejected
 *    the whole call, and the modal's Retry went back to the password stage
 *    with the SAME quote — a fresh nonce, a second signed deposit;
 *  - closing the modal and reopening it showed the same quote at "review"
 *    for up to 30 s, with a working Sign button.
 *
 * `executeIntentsTrade` claims the deposit address here before it signs, and
 * refuses to sign for an address that has already been claimed. The confirm
 * modal also retires a quote on any failure, so "try again" always means a
 * new quote and a new deposit address.
 *
 * # Why in memory
 *
 * A quote exists only in memory: it is not persisted, so after a restart the
 * old deposit address cannot be reached through the UI at all. The durable
 * record of an attempt is the swap-history row, written with the deposit
 * address as soon as the broadcast returns a hash (or reports an unknown
 * outcome).
 */

export interface IntentsDepositAttempt {
  depositAddress: string;
  /** ms epoch of the claim (or of the retirement, for a quote never signed). */
  at: number;
  /** Source-chain hash, once known. */
  txHash?: string;
  /**
   * `claimed` — signing was about to start; `broadcast` — a hash came back;
   * `unknown` — the deposit may have gone out and its outcome is unknown;
   * `retired` — the quote failed before or during execution and must not be
   * offered again.
   */
  state: "claimed" | "broadcast" | "unknown" | "retired";
}

/**
 * Thrown by `claimIntentsDeposit` when the deposit address was already used.
 * An ordinary refusal, decided before anything is signed.
 */
export class IntentsQuoteAlreadyUsedError extends Error {
  readonly name = "IntentsQuoteAlreadyUsedError";
  readonly depositAddress: string;
  readonly attempt: IntentsDepositAttempt;
  constructor(attempt: IntentsDepositAttempt) {
    super(
      attempt.txHash
        ? `This quote was already used for a deposit (${attempt.txHash}). ` +
            `Nothing new was signed. Check that transaction before swapping again; ` +
            `a new swap needs a new quote.`
        : `This quote was already used. Nothing new was signed. Close this window ` +
            `and let the form fetch a new quote.`,
    );
    this.depositAddress = attempt.depositAddress;
    this.attempt = attempt;
    Object.setPrototypeOf(this, IntentsQuoteAlreadyUsedError.prototype);
  }
}

const attempts = new Map<string, IntentsDepositAttempt>();

/**
 * Deposit addresses compare case-insensitively when they are 0x-hex (EVM,
 * where checksum casing is display only) and exactly otherwise (base58,
 * bech32 and friends are case-sensitive or canonical-lowercase already).
 */
function keyOf(depositAddress: string): string {
  const a = depositAddress.trim();
  return /^0x[0-9a-fA-F]+$/.test(a) ? a.toLowerCase() : a;
}

/** The recorded attempt for `depositAddress`, if any. */
export function intentsDepositAttempt(
  depositAddress: string | null | undefined,
): IntentsDepositAttempt | undefined {
  if (!depositAddress) return undefined;
  return attempts.get(keyOf(depositAddress));
}

/** True when `depositAddress` has been claimed or retired. */
export function isIntentsDepositUsed(depositAddress: string | null | undefined): boolean {
  return !!intentsDepositAttempt(depositAddress);
}

/**
 * Claim `depositAddress` for ONE signing attempt. Throws
 * `IntentsQuoteAlreadyUsedError` if it was claimed or retired before.
 * Synchronous on purpose: two overlapping submits cannot both pass it.
 */
export function claimIntentsDeposit(
  depositAddress: string,
  now: number = Date.now(),
): IntentsDepositAttempt {
  const key = keyOf(depositAddress);
  const prior = attempts.get(key);
  if (prior) throw new IntentsQuoteAlreadyUsedError(prior);
  const rec: IntentsDepositAttempt = { depositAddress, at: now, state: "claimed" };
  attempts.set(key, rec);
  return rec;
}

/**
 * Record what became of an attempt. Creates the record when absent, so the
 * modal can retire a quote that failed before the executor claimed it.
 * A later state never downgrades a hash that is already known.
 */
export function recordIntentsDeposit(
  depositAddress: string,
  patch: { state: IntentsDepositAttempt["state"]; txHash?: string },
  now: number = Date.now(),
): IntentsDepositAttempt {
  const key = keyOf(depositAddress);
  const prior = attempts.get(key);
  const rec: IntentsDepositAttempt = {
    depositAddress: prior?.depositAddress ?? depositAddress,
    at: prior?.at ?? now,
    txHash: patch.txHash ?? prior?.txHash,
    // A quote that broadcast (or may have) is never re-labelled "retired": the
    // hash is the thing the user needs to see if they reopen it.
    state:
      patch.state === "retired" && prior && prior.state !== "claimed" && prior.state !== "retired"
        ? prior.state
        : patch.state,
  };
  attempts.set(key, rec);
  return rec;
}

/** Test-only: forget every attempt. */
export function __resetIntentsAttemptsForTests(): void {
  attempts.clear();
}
