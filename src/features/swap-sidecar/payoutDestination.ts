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
 * # Only where the node can follow it (2026-10-06)
 *
 * The address is also sent only when the swap node can confirm a payment to
 * an address outside its wallet for that coin. BTC, LTC and BCH are bought on
 * a normal bid and paid by this node's chain-A redeem, which the engine reads
 * again to settle a bid that errored after publishing it (PWNDA-PATCH-27, run
 * by the wallet's janitor): an electrum connection finds any transaction, an
 * RPC node finds a confirmed one only with txindex (which the engine neither
 * turns on for these coins nor reports) or when it is its wallet's own (which
 * a payment to the user's address is not). So they are sent only when the
 * node reports `connection_type: "electrum"` for the coin, in the
 * `/json/wallets` read the quote already makes
 * (`SidecarQuote.receiveConnection`). DOGE and DASH have no electrum
 * connection in this engine, so they are never sent. XMR, ZEPH and ZANO are
 * bought on a reversed bid, which the engine completes as soon as its redeem
 * to an outside address is submitted, so the connection decides nothing for
 * them. The trace, with the engine's file:line, is in `swap_bid.rs` above
 * `PAYOUT_CONNECTION_REQUIRED`.
 *
 * # Never on a purchase the licence fee is charged on (2026-10-06)
 *
 * Operator decision: the taker-side licence fee is collected after the swap
 * completes from the swap node's own wallet of the scripted coin. A bid that
 * BUYS a coin the fee schedule charges (LTC, BCH, BTC) with a scriptless one
 * (XMR, ZEPH, ZANO) is paying for the very coin the fee is taken from, so
 * that coin stays in the node's wallet and no address is sent, whatever its
 * form or the connection ({@link feeBearingPurchase}; Rust's
 * `fee_bearing_purchase` is built on the predicates the fee watcher charges
 * by). The confirm screen, the swap's details and EARN say so, in one
 * sentence ({@link FEE_KEPT_TAIL}). Selling a scripted coin for a scriptless
 * one still pays the user's address: that fee is taken from the coin the
 * node sold from. Scripted to scripted carries no fee.
 *
 * # One rule, two places
 *
 * This decides what the confirm screen says and whether the address goes in
 * the bid. Rust re-checks it against the engine's own copy of the offer and
 * the node's own report of the connection (`payout_destination`) and refuses
 * the bid on a mismatch, so a renderer bug cannot send an address the engine
 * would pay elsewhere or could not follow. Both sides run one ordered list of
 * checks (`PAYOUT_CHECKS`, here and in `swap_bid.rs`): a new rule is one entry
 * in each, and `payoutDestination.test.ts` pins the lists and the tables
 * equal.
 */
import { feeBearingPurchase } from "./licenceFee";
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

/**
 * How the swap node must reach a coin's chain before a payout to an outside
 * address is sent (2026-10-06): `"electrum"`, or `"any"` for a coin whose
 * outside payout the engine never reads again. A coin missing here is never
 * sent. The same table as `swap_bid.rs::PAYOUT_CONNECTION_REQUIRED`, which
 * the test compares source to source.
 */
export const PAYOUT_CONNECTION_REQUIRED: Readonly<Record<string, "electrum" | "any">> = {
  BTC: "electrum",
  LTC: "electrum",
  BCH: "electrum",
  DOGE: "electrum",
  DASH: "electrum",
  XMR: "any",
  ZEPH: "any",
  ZANO: "any",
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
  /** A purchase the licence fee is charged on: the coin bought stays in the
   *  node's wallet so the fee can be taken from it (2026-10-06). */
  | "fee"
  /** An address form the engine would pay somewhere else, or refuse. */
  | "form"
  /** The node follows this coin through a full node (RPC), which can confirm
   *  a payment only to its own wallet (2026-10-06). */
  | "connection"
  /** The node did not say how it reaches this coin's chain (2026-10-06). */
  | "connection-unknown";

export type PayoutPlan =
  /** Sent as `destination_address`; the engine pays exactly this address. */
  | { to: "address"; ticker: string; address: string }
  /** Not sent; the engine pays its own wallet for `ticker`. */
  | { to: "node-wallet"; ticker: string; reason: NodeWalletReason; address: string | null };

/** What the plan needs to know about the offer. */
export interface PayoutOffer {
  /** The coin the bid buys: the offer's `coin_from`, as the node names it. */
  receiveCoin: string;
  /** The coin the bid pays with: the offer's `coin_to` (2026-10-06). */
  sendCoin: string;
  /** The offer's `swap_type` (5 = the adaptor-signature protocol). */
  swapType: number | null | undefined;
  /**
   * How the swap node reports it reaches the chain of the coin bought:
   * `connection_type` in `/json/wallets` (`"electrum"`, `"rpc"`), or `null`
   * when that read failed or did not list the coin (2026-10-06).
   */
  receiveConnection: string | null;
}

/**
 * What each check looks at. A rule that needs more of the swap adds its input
 * to {@link PayoutOffer} and is one more entry in {@link PAYOUT_CHECKS}.
 */
export interface PayoutCase {
  offer: PayoutOffer;
  /** The coin bought, as an UPPERCASE ticker. */
  ticker: string;
  /** The coin paid with, as an UPPERCASE ticker. */
  sold: string;
  /** The reviewed address, trimmed, a bare CashAddr given its prefix. */
  address: string;
}

/**
 * Every check an address passes before it is sent, in order; the first that
 * refuses decides where the coin goes and why. `swap_bid.rs::PAYOUT_CHECKS`
 * is the same list in the same order (`check_<name>` there), pinned by the
 * test: a new rule is one entry in each.
 */
export const PAYOUT_CHECKS: readonly {
  name: string;
  refuse: (c: PayoutCase) => NodeWalletReason | null;
}[] = [
  { name: "protocol", refuse: (c) => (c.offer.swapType === SWAP_TYPE_XMR ? null : "protocol") },
  { name: "coin", refuse: (c) => (PAYOUT_ADDRESS_SHAPES[c.ticker] ? null : "coin") },
  // Before the form and the connection: for these swaps the fee is THE reason
  // the coin stays with the node, whatever the address (2026-10-06).
  { name: "fee", refuse: (c) => (feeBearingPurchase(c.sold, c.ticker) ? "fee" : null) },
  {
    name: "form",
    refuse: (c) => (PAYOUT_ADDRESS_SHAPES[c.ticker]?.test(c.address) ? null : "form"),
  },
  { name: "connection", refuse: (c) => connectionRefusal(c.ticker, c.offer.receiveConnection) },
];

/** `null` when the node can follow a payout of `ticker` to an outside address. */
function connectionRefusal(ticker: string, connection: string | null): NodeWalletReason | null {
  const need = PAYOUT_CONNECTION_REQUIRED[ticker];
  if (need === "any") return null;
  if (need === "electrum" && connection === "electrum") return null;
  return connection == null ? "connection-unknown" : "connection";
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
  const sold = (tickerForCoin(offer.sendCoin) ?? offer.sendCoin ?? "").trim().toUpperCase();
  const c: PayoutCase = { offer, ticker, sold, address: normalize(ticker, address) };
  for (const check of PAYOUT_CHECKS) {
    const reason = check.refuse(c);
    if (reason) return { to: "node-wallet", ticker, reason, address };
  }
  return { to: "address", ticker, address: c.address };
}

/**
 * Why a purchase the licence fee is charged on stays in the swap node's
 * wallet, and how to move it (2026-10-06): one tail for the confirm screen,
 * the swap's details and EARN, so the three say the same thing. "Sweep back"
 * is the Settings card that moves coins the node holds into this wallet
 * (`SweepBackSection`); a coin whose node wallet IS this wallet's (a shared
 * account) is not offered there, because it is already here.
 */
export const FEE_KEPT_TAIL =
  "so the swap fee can be taken from it. Sweep back (in Settings) moves it to your wallet, unless that wallet is already shared with this one.";

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
    case "fee":
      return `${where} ${FEE_KEPT_TAIL}`;
    case "connection":
      return `${where}: your swap node follows ${plan.ticker} through a full node, which can confirm a payment only to its own wallet, so this address is not sent.`;
    case "connection-unknown":
      return `${where}: the wallet could not read how your swap node connects to ${plan.ticker}, so this address is not sent.`;
    case "no-address":
      return `${where}.`;
  }
}
