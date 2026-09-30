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

// ─── NEAR Intents: MAX on a NATIVE coin (2026-09-29 send-safety audit, F8) ──
//
// MAX set the whole balance as the swap amount. On a native coin the deposit
// also pays its own network fee out of that same balance, so every MAX swap
// from ETH, BNB, SOL, BTC, … was refused before signing — as a red "Safety
// check failed … please report it" (TX_NOT_FUNDABLE), which it is not. MAX
// now leaves a fee reserve behind on a native coin. A token leg keeps its full
// balance: its fee is paid in the chain's native coin, not in the token.

/**
 * Conservative fee reserve, in the coin's own units, for a NEAR Intents
 * deposit of a native coin. These are defaults sized for busy-but-not-extreme
 * fee markets, NOT measurements; EVM chains refine them with the live gas
 * price (`evmReserveFromGasPrice`). Where a chain also locks a minimum
 * balance (XRP's account reserve, Solana's rent-exempt minimum, NEAR storage)
 * the reserve includes it.
 */
const NATIVE_RESERVE_BY_TICKER: Record<string, number> = {
  ETH: 0.002,
  BNB: 0.0005,
  AVAX: 0.01,
  POL: 0.1,
  MON: 0.05,
  SOL: 0.002, // fee + rent-exempt minimum (~0.00089 SOL)
  NEAR: 0.05, // storage staking + gas
  BTC: 0.0002, // account-wide sends may spend many inputs
  LTC: 0.001,
  DOGE: 2,
  BCH: 0.0002,
  DASH: 0.001,
  ADA: 2, // fee + min-UTXO for the change output
  XRP: 1.5, // 1 XRP base reserve + fee + owner-reserve slack
  TRX: 2, // bandwidth burn + activating an unused deposit address
};

/**
 * The reserve MAX leaves behind for `meta`, in display units — 0 for a token
 * leg (its fee is paid in another coin) and for anything not listed.
 */
export function nativeMaxReserve(
  meta: { ticker: string; tokenContract?: string | null } | null | undefined,
): number {
  if (!meta || meta.tokenContract) return 0;
  return NATIVE_RESERVE_BY_TICKER[meta.ticker.toUpperCase()] ?? 0;
}

/**
 * EVM reserve from a live gas price: a native transfer's 21 000 gas, the
 * executor's +25 % estimate margin, and 2x headroom for the price moving
 * before the user signs. In the coin's display units.
 */
export function evmReserveFromGasPrice(gasPriceWei: bigint, decimals: number): number {
  if (gasPriceWei <= 0n) return 0;
  const wei = gasPriceWei * 21_000n * 125n * 2n / 100n;
  return Number(wei) / 10 ** decimals;
}

/**
 * A preset amount (MAX, 25 %, …) as the form's text: at most 8 decimals and
 * never more than the coin has, rounded DOWN. `toFixed` rounds half-up, so
 * MAX on an 18-decimal token (USDC on BSC) could ask for more than the
 * balance by a fraction of a unit and be refused as unfundable.
 */
export function formatPresetAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const dp = Math.max(0, Math.min(8, decimals));
  const s = value.toFixed(Math.min(20, dp + 6));
  const [whole, frac = ""] = s.split(".");
  const kept = frac.slice(0, dp).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}
