/**
 * Where a peer-to-peer bid's bought coin is paid.
 *
 * # Why (2026-10-01)
 *
 * The confirm screen showed a payout address, and the bid sent it as
 * `addr_to`, a key the deployed engine never reads: `js_bids` reads
 * `destination_address` (`js_server.py:770-778`, deployed tree). So every
 * swap paid the swap node's own wallet, not the address on the screen. The
 * operator's decision: the engine pays the address the user confirmed. It now
 * goes out as `destination_address` (`src-tauri/src/swap_bid.rs`).
 *
 * # Why a table and not "send it"
 *
 * The engine does not pay every address form as written. For BTC, LTC and BCH
 * it keeps only the address's hash (`decodeAddress`) and pays a P2WPKH (BCH:
 * P2PKH) output to it, so a legacy `1…`/`L…` address is paid as a different
 * address of the same key, one this wallet does not show, and a P2SH `3…`/
 * `M…` address is paid to an output no key can spend. DOGE and DASH redeem the
 * same way, as P2PKH. XMR, ZEPH and ZANO check the address fully and refuse an
 * integrated one, so the bid would fail. The whole trace, coin by coin and with
 * the engine's file:line, is in `swap_bid.rs` above `PAYOUT_ADDRESS_SHAPES`.
 *
 * So each coin has ONE form that is sent: the one the wallet derives by
 * default. Any other address is not sent, and the coin lands in the swap
 * node's own wallet for that coin, which the confirm screen says before the
 * user confirms.
 *
 * # One rule, two places
 *
 * This decides what the confirm screen says and whether the address goes in
 * the bid. Rust re-checks it against the engine's own copy of the offer
 * (`payout_destination`) and refuses the bid on a mismatch, so a renderer bug
 * cannot send an address the engine would pay elsewhere. The two shape tables
 * are pinned equal by `payoutDestination.test.ts`.
 */
import { SWAP_TYPE_XMR } from "./offers";
import { tickerForCoin } from "./types";

/**
 * The one address form per coin that the deployed engine pays exactly as
 * written. The same patterns as `swap_bid.rs::PAYOUT_ADDRESS_SHAPES`, which
 * the test compares source to source. Shape only: the engine verifies the
 * checksum, and a bad checksum is refused there, not paid elsewhere.
 */
export const PAYOUT_ADDRESS_SHAPES: Readonly<Record<string, RegExp>> = {
  BTC: /^bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/,
  LTC: /^ltc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/,
  BCH: /^bitcoincash:q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/,
  DOGE: /^D[1-9A-HJ-NP-Za-km-z]{33}$/,
  DASH: /^X[1-9A-HJ-NP-Za-km-z]{33}$/,
  XMR: /^[48][1-9A-HJ-NP-Za-km-z]{94}$/,
  ZEPH: /^(?:ZEPHYR[1-9A-HJ-NP-Za-km-z]{95}|ZEPHs[1-9A-HJ-NP-Za-km-z]{94})$/,
  ZANO: /^Zx[1-9A-HJ-NP-Za-km-z]{95}$/,
};

/** The form each coin's rule accepts, as the confirm screen names it. */
export const PAYOUT_ADDRESS_FORM: Readonly<Record<string, string>> = {
  BTC: "bc1q…",
  LTC: "ltc1q…",
  BCH: "bitcoincash:q…",
  DOGE: "D…",
  DASH: "X…",
  XMR: "4… or 8…",
  ZEPH: "ZEPHYR… or ZEPHs…",
  ZANO: "Zx…",
};

/** Why a bid leaves the payout to the swap node's own wallet. */
export type NodeWalletReason =
  /** No payout address was given. */
  | "no-address"
  /** The offer's protocol is not the adaptor-signature one: the engine reads
   *  no destination for it (`postBid`), whatever is sent. */
  | "protocol"
  /** A coin with no rule above. */
  | "coin"
  /** An address form the engine would pay somewhere else, or refuse. */
  | "form";

export type PayoutPlan =
  /** Sent as `destination_address`; the engine pays exactly this address. */
  | { to: "address"; ticker: string; address: string }
  /** Not sent; the engine pays its own wallet for `ticker`. */
  | { to: "node-wallet"; ticker: string; reason: NodeWalletReason; address: string | null };

/** What the plan needs to know about the offer. */
export interface PayoutOffer {
  /** The coin the bid buys: the offer's `coin_from`, as the node names it. */
  receiveCoin: string;
  /** The offer's `swap_type` (5 = the adaptor-signature protocol). */
  swapType: number | null | undefined;
}

/** A CashAddr written without its prefix gets it: the engine's decoder
 *  refuses one without ("Cash address is missing prefix"). Mixed case is not
 *  a valid CashAddr and is left for the shape test to reject. */
function normalize(ticker: string, address: string): string {
  if (ticker !== "BCH") return address;
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) return address;
  return lower.startsWith("bitcoincash:") ? lower : `bitcoincash:${lower}`;
}

/**
 * Where the coin a bid buys will be paid, given the address the user is
 * shown. Pure; the confirm screen renders it and `submitSidecarBid` sends
 * `address` only for `to: "address"`.
 */
export function planPayout(
  offer: PayoutOffer,
  reviewedAddress: string | null | undefined,
): PayoutPlan {
  const ticker = (tickerForCoin(offer.receiveCoin) ?? offer.receiveCoin ?? "")
    .trim()
    .toUpperCase();
  const address = (reviewedAddress ?? "").trim();
  if (!address) return { to: "node-wallet", ticker, reason: "no-address", address: null };
  if (offer.swapType !== SWAP_TYPE_XMR) {
    return { to: "node-wallet", ticker, reason: "protocol", address };
  }
  const shape = PAYOUT_ADDRESS_SHAPES[ticker];
  if (!shape) return { to: "node-wallet", ticker, reason: "coin", address };
  const normalized = normalize(ticker, address);
  if (!shape.test(normalized)) return { to: "node-wallet", ticker, reason: "form", address };
  return { to: "address", ticker, address: normalized };
}

/**
 * One sentence for a plan that leaves the coin in the swap node's wallet:
 * where it lands and why. `null` for a plan that pays the address.
 */
export function nodeWalletPayoutNote(plan: PayoutPlan): string | null {
  if (plan.to === "address") return null;
  const where = `It lands in your swap node's ${plan.ticker} wallet`;
  switch (plan.reason) {
    case "form":
      return `${where}, not at this address: the swap engine pays a ${plan.ticker} address as written only in the ${PAYOUT_ADDRESS_FORM[plan.ticker] ?? "default"} form, and would pay this one somewhere else.`;
    case "protocol":
      return `${where}: this offer's swap protocol pays the node's own wallet whatever address is given.`;
    case "coin":
      return `${where}: the wallet has no payout rule for this coin.`;
    case "no-address":
      return `${where}.`;
  }
}
