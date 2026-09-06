/**
 * Which swaps have to hold back a fee, and how much of the balance is left.
 *
 * The fee is charged on the SCRIPTED leg of a peer-to-peer swap whose other
 * leg is scriptless, taken (not made), and completed — see `FEE.md`. Only one
 * of those four is knowable while the form is being filled in: the pair. So
 * this decides the pair question, and the amount comes from Rust's own
 * schedule (`sidecarFeesReserve`), never from a second copy of the maths here.
 *
 * Why it exists at all: MAX used to set the whole balance. A taker selling
 * their entire BCH into XMR therefore had nothing left when the watcher came
 * to collect, and the record deferred forty times before expiring. Reserving
 * is the difference between a fee that is charged and a fee that is merely
 * declared.
 */

/** Coins whose leg carries no script — the fee is never charged on these. */
export const SCRIPTLESS_TICKERS = ["XMR", "ZEPH", "ZANO"] as const;

/** Scripted coins with a schedule row. Mirrors `sidecar_fees/schedule.rs`. */
export const FEE_SCRIPTED_TICKERS = ["LTC", "BCH", "BTC"] as const;

/**
 * Does a swap of `from` → `to` on this router put the fee on the amount the
 * user is about to type? True only when the user SENDS the scripted leg: a
 * receive-scripted swap leaves the wallet up by the notional, so there is
 * nothing to reserve.
 */
export function feeAppliesToSend(args: {
  router: string | null | undefined;
  fromTicker: string;
  toTicker: string;
}): boolean {
  if (args.router !== "basicswap") return false;
  const from = args.fromTicker.toUpperCase();
  const to = args.toTicker.toUpperCase();
  return (
    (FEE_SCRIPTED_TICKERS as readonly string[]).includes(from) &&
    (SCRIPTLESS_TICKERS as readonly string[]).includes(to)
  );
}

/** `balance - reserve`, never below zero, formatted like the other presets. */
export function spendableAfterReserve(balance: number, reserve: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  if (!Number.isFinite(reserve) || reserve <= 0) return balance;
  return Math.max(0, balance - reserve);
}
