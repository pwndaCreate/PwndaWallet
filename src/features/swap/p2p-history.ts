/**
 * Peer-to-peer (BasicSwap) swaps in the wallet's swap history.
 *
 * # Why (operator request, 2026-10-01)
 *
 *   "Is it possible to have the p2p swaps also tracked inside the swaps and
 *    recent swaps sections?"
 *
 * Both lists (SWAPS in Activity, RECENT SWAPS / HISTORY on the Swap tab) read
 * `swapHistory`. NEAR Intents rows are written by the confirm modal, desk rows
 * by `useDeskTracker`, and nothing that placed or followed a P2P bid wrote a
 * row, so P2P swaps appeared in neither list.
 *
 * # Where the rows come from
 *
 * `useSidecarSwap` (the P2P tracker, mounted in App.tsx above the view router)
 * reports to the sink built here, `p2pSwapHistory`:
 *
 * - `placed`: the node returned a bid id for a bid this wallet placed. A
 *   pending row with the coins and amounts the user reviewed, and where the
 *   bid asked the engine to pay the bought coin.
 * - `bidRead`: one `GET /json/bids/<id>` read. The state and the leg. When the
 *   state has moved since the last time, the sink also reads the bid's
 *   transactions (below).
 * - `activeRead`: one `/json/active` read. A row for each swap in progress,
 *   on either side of the bid, and on the first answer of a session the
 *   backfill below.
 *
 * The backfill reads `/json/sentbids` (every bid this node sent, finished ones
 * included) and `/json/bids` (every bid it received), and writes the swaps
 * history lacks or still has as pending, after reading each one's own record
 * for its protocol state, leg and transactions. Read-only: it places, accepts
 * and cancels nothing.
 *
 * # Transactions (2026-10-01)
 *
 * An adaptor-signature swap's transactions (any pair with XMR, ZEPH or ZANO)
 * are listed by the engine only for a read that asks (`show_extra`), and the
 * GET the tracker polls with cannot ask. `fetchBidTxns` is that read, a Rust
 * command of its own (`swap_bid.rs::swap_sidecar_bid_txns`). The sink calls it
 * once per state a bid reaches (a transaction appears with a state change),
 * the backfill uses it for each bid's record, and the details call
 * `refreshTxns` when opened, which is what fills a swap that ended unwatched.
 *
 * # Both sides of a bid (2026-10-01)
 *
 * Operator request: "Swaps where you were the maker (someone took your offer)
 * aren't listed." A bid this node RECEIVED is a swap on an offer it posted,
 * written in the user's own frame: the maker sends the offer's `coin_from`
 * and receives its `coin_to` (`js_active` and `describeBid` report both in
 * the offer's frame). Only one this node accepted gets a row: a bid that
 * expired or was refused before acceptance is a request, not a swap
 * (`makerSwapStarted`). The licence fee is charged on bids this node SENT
 * only (`sidecar_fees`), and nothing here reads or writes it.
 *
 * Which side a bid is comes from the engine's own flags: a sent bid has
 * `was_sent: true`; a received one `was_received: true` and `was_sent: null`
 * (`basicswap.py:13033`, the received bid sets only `was_received`). Until
 * 2026-10-01 the in-progress list's `null` read as "sent" (`was_sent !==
 * false`), so a received swap in progress was written as a taker row with its
 * legs swapped. Such a row is turned the right way round the first time a
 * read of its record says it was received.
 *
 * # One row per bid
 *
 * The row id is `p2p:<bidId>`, so the three sources above are one row. Every
 * write merges into the stored row in one serialized step
 * (`modifySwapHistory`):
 * - a finished row never goes back to pending: an answer read before the swap
 *   ended can be processed after one read after it (the in-progress list and
 *   the bid reads poll independently);
 * - what the user reviewed (coins, amounts, time) is kept, and the node's copy
 *   only fills blanks;
 * - a transaction id, once reported, stays.
 *
 * History is DISPLAY ONLY, as for desk rows: nothing reads it back to decide a
 * protocol step. The node, and `useSidecarSwap` in front of it, stay the
 * authority on what a swap is doing.
 *
 * # No `actualReceived`
 *
 * A P2P row never gets one, on purpose (checked 2026-10-01). The bid's own
 * record (`describeBid`, deployed `ui/util.py:353-402`) states the agreed
 * amounts, `amt_from` / `amt_to`, and no output value; with `show_extra` it
 * adds txids, still no amounts (`:412-486`). What arrives is less than the
 * agreed amount by the claim fee (`createSCLockSpendTx` pays `locked_coin -
 * pay_fee`), and after a swipe by more. Writing the agreed amount as
 * "received" would show a 0% drift chip for an amount nobody measured.
 */
import {
  fetchBid,
  fetchBids,
  fetchBidTxns,
  fetchSentBids,
  isApiError,
  type BasicSwapActiveSwap,
  type BasicSwapBidDetail,
  type BasicSwapBidSummary,
} from "../../api/basicswap";
import {
  activeSwapToTracked,
  classifyBidState,
  stageForBidState,
  swapLegOf,
  tickerForCoin,
  SIDECAR_SCRIPTLESS_TICKERS,
  type BidSeverity,
  type BidStage,
  type SidecarHistorySink,
  type SidecarSwapHandle,
  type SwapLeg,
} from "../swap-sidecar";
import {
  loadSwapHistory,
  modifySwapHistory,
  type SwapHistoryEntry,
  type SwapHistoryStatus,
} from "./swap-history-store";
import { destinationExplorerUrl } from "./swap-details";

/** The provider every P2P row carries: the wallet's swap node ("Pwnda
 *  Grove") trading on the peer-to-peer book. */
export const P2P_HISTORY_PROVIDER = "Grove P2P";

/** The history row id of one bid. */
export function p2pHistoryId(bidId: string): string {
  return `p2p:${bidId}`;
}

/** How many of the node's newest sent bids the backfill reads. History keeps
 *  200 rows across every route, so a deeper read would only evict them. */
export const P2P_BACKFILL_LIMIT = 100;

// ─── Bid state → history status ───────────────────────────────────────

/**
 * What each tracker stage means for a history row. A `Record` over every
 * stage, so a stage added to `bidStates.ts` fails the type check here until
 * somebody decides what it means for history.
 *
 * Only an ending is final. Everything the tracker still watches is
 * "pending", for the reason `deskStateToHistoryStatus` gives: a new or
 * unrecognized state must never make a swap in flight look finished.
 */
const STAGE_HISTORY: Readonly<Record<BidStage, SwapHistoryStatus>> = {
  requesting: "pending",
  accepted: "pending",
  locking: "pending",
  "waiting-counterparty": "pending",
  finalising: "pending",
  done: "success",
  // The refund is published and confirming, not finished (bidStates.ts,
  // 2026-09-06).
  refunding: "pending",
  refunded: "refunded",
  "timelock-unwinding": "pending",
  // Paid, but the bid is still moving: the node is handing the key share back.
  "swiped-settling": "pending",
  // The timelock paid this side the coin it was buying. Not a refund: nothing
  // came back, the swap delivered (bidStates.ts, `isRefundOutcome`).
  swiped: "success",
  // The other side of that ending (state 36, scripted leg only): the swipe
  // took the coin this side sold, the key share let it claim the coin it was
  // buying. Delivered, so "success". It was "refunded" until 2026-10-01,
  // through the tracker's old reading of 36 (operator request).
  "claimed-after-swipe": "success",
  // The other user took this side's locked coin after the deadline.
  "counterparty-recovered": "failed",
  recovering: "pending",
  // Ended before any funds were committed. Nothing was refunded, because
  // nothing was locked; the details say "Cancelled" in words.
  cancelled: "failed",
  // Not terminal on purpose: a timelock refund can still be ahead of it.
  "needs-attention": "pending",
  internal: "pending",
  unknown: "pending",
};

/**
 * A BasicSwap bid state as one of the four history statuses (operator
 * request, 2026-10-01). The P2P counterpart of `deskStateToHistoryStatus`.
 *
 * `state` is anything the node reports (`bid_state_ind`, upstream's display
 * string, or the protocol name), as for `classifyBidState`.
 *
 * `leg` is which coin this node locked (`swapLegOf`). Without it, a state
 * whose two readings disagree is "pending": `XMR_SWAP_FAILED_SWIPED` is
 * "success" for the side that swiped (it was paid the coin it was buying)
 * and "failed" for the side whose lock was taken. A neutral reading would be
 * a coin flip between those two, so the row waits for a read that names the
 * leg. Every other state reads the same from both sides.
 */
export function p2pBidStateToHistoryStatus(
  state: number | string | null | undefined,
  leg: SwapLeg = "unknown",
): SwapHistoryStatus {
  if (leg !== "unknown") return STAGE_HISTORY[stageForBidState(state, leg)];
  const scripted = STAGE_HISTORY[stageForBidState(state, "scripted")];
  const scriptless = STAGE_HISTORY[stageForBidState(state, "scriptless")];
  return scripted === scriptless ? scripted : "pending";
}

// ─── Observations: one thing the node said about one bid ──────────────

export type P2PBidTx = NonNullable<SwapHistoryEntry["bidTxns"]>[number];

/** The user's side of a swap: what they sent and what they received. */
export interface P2PFrame {
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
}

/** What one report says about one bid, before it is merged into a row. */
export interface P2PObservation {
  bidId: string;
  /** Who and what: used to create a row that does not exist, and to fill a
   *  stored row's blanks. Never overrides what is stored. */
  base?: P2PFrame & {
    createdAt: string;
    offerId?: string;
    /** The state a NEW row starts in. */
    bidState?: number | string;
  };
  /** The state now. Undefined: nothing usable (an internal pause such as
   *  `SWAP_DELAYING`), so the stored state is kept, as the tracker keeps its
   *  stage. */
  bidState?: number | string;
  leg?: "scriptless" | "scripted";
  txns?: P2PBidTx[];
  offerId?: string;
  /** When the node says the bid reached its current state (ISO), from the
   *  bid's own record. A finished row is dated by this, not by when the
   *  wallet first read it: a backfilled swap that ended two days ago read
   *  "just now" in the lists (sandbox, 2026-10-01). */
  stateAt?: string;
  /** Which side of the bid this node was (2026-10-01). */
  role?: "taker" | "maker";
  /** Present when the bid's own record named the role (`was_sent` /
   *  `was_received`): the user's side as that record states it. A list row
   *  or a tracker handle only infers the role. */
  recordFrame?: P2PFrame;
  /** Where the bid asked the engine to pay the bought coin: written when the
   *  bid is placed, from what `submitSidecarBid` sent (2026-10-01). */
  payout?: { to: "address" | "node-wallet"; address?: string };
  /** A missing row may be created. */
  mayCreate: boolean;
}

/** A coin as a history row names it: a ticker. The node names coins
 *  ("Monero"); `tickerForCoin` knows every coin this route trades. */
function tickerOf(coin: string | null | undefined): string {
  const t = tickerForCoin(coin);
  return (t ?? coin ?? "").trim().toUpperCase();
}

/** The node's times are unix SECONDS; history sorts ISO strings. */
function isoFromUnixSeconds(sec: number | null | undefined): string {
  const ms = Number(sec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return new Date().toISOString();
  return new Date(ms).toISOString();
}

function baseFromHandle(h: SidecarSwapHandle): NonNullable<P2PObservation["base"]> {
  return {
    fromAsset: tickerOf(h.sendCoin),
    toAsset: tickerOf(h.receiveCoin),
    fromAmount: h.sendAmount ?? "",
    toAmount: h.receiveAmount ?? "",
    createdAt: isoFromUnixSeconds(h.createdAt),
    ...(h.offerId ? { offerId: h.offerId } : {}),
  };
}

/** Is this a state worth recording? The four internal bookkeeping states
 *  (`SWAP_DELAYING` and co.) are pauses, not places in the protocol. */
function usableState(raw: number | string | null | undefined): raw is number | string {
  if (raw == null || raw === "") return false;
  return classifyBidState(raw).surface;
}

/**
 * The stages a bid this node RECEIVED reaches only once this node accepted
 * it. The same on both legs: the leg readings of the asymmetric states
 * (`timelock-unwinding`, `swiped`, `swiped-settling`) are listed with the
 * neutral ones.
 */
const MAKER_STARTED_STAGES: ReadonlySet<BidStage> = new Set<BidStage>([
  "accepted",
  "locking",
  "waiting-counterparty",
  "finalising",
  "done",
  "refunding",
  "refunded",
  "timelock-unwinding",
  "swiped-settling",
  "swiped",
  "claimed-after-swipe",
  "counterparty-recovered",
  "recovering",
]);

/**
 * Is a bid this node RECEIVED a swap yet (2026-10-01)? Yes once this node
 * accepted it, or once a lock transaction exists for it. A bid still waiting
 * for acceptance, or one that expired, was rejected or failed before
 * acceptance, is someone's request, not a swap the user made: no row.
 * `BID_AACCEPT_DELAY` reads "accepted" to the tracker but is the pause
 * BEFORE an automatic acceptance. `BID_ERROR` and the cancelled states count
 * only with a lock: an error on an incoming request is not a swap, an error
 * with coins locked is one the user must see.
 */
export function makerSwapStarted(
  state: number | string | null | undefined,
  lockSeen: boolean,
): boolean {
  if (lockSeen) return true;
  if (state == null || state === "") return false;
  const c = classifyBidState(state);
  if (c.state === "BID_AACCEPT_DELAY") return false;
  return MAKER_STARTED_STAGES.has(c.stage);
}

/** Lock states that mean a lock transaction exists (`strTxState`,
 *  `basicswap_util.py:414-429`). A missing one reads `"Unknown"` in
 *  `/json/bids` and `null` in `/json/active`; `"None"` is TX_NONE. */
const LOCK_PRESENT = new Set(["sent", "confirmed", "redeemed", "refunded", "in mempool", "in chain"]);

function lockSeenIn(row: { tx_state_a?: string | null; tx_state_b?: string | null }): boolean {
  const seen = (s: unknown) => typeof s === "string" && LOCK_PRESENT.has(s.trim().toLowerCase());
  return seen(row.tx_state_a) || seen(row.tx_state_b);
}

/** The bid this wallet just placed: what `adopt` was handed. */
export function observePlaced(h: SidecarSwapHandle): P2PObservation {
  const payout: P2PObservation["payout"] | undefined =
    h.payoutTo === "address" && h.payoutAddress
      ? { to: "address", address: h.payoutAddress }
      : h.payoutTo === "node-wallet"
        ? { to: "node-wallet" }
        : undefined;
  return {
    bidId: h.bidId,
    // A bid the node has just accepted is, by definition, sent: the same
    // starting state `adopt` gives the tracker.
    base: { ...baseFromHandle(h), bidState: "BID_SENT" },
    ...(h.offerId ? { offerId: h.offerId } : {}),
    role: "taker",
    ...(payout ? { payout } : {}),
    mayCreate: true,
  };
}

/** Which side the bid's own record says this node was. The engine sets one
 *  flag: `was_sent: true` on a bid this node sent (also on one it sent and
 *  received, a self-bid), `was_received: true` with `was_sent: null` on one
 *  it received (`postXmrBid` and `processXmrBid` in the deployed
 *  `basicswap.py`, `:7180` and `:13033`). */
function recordRole(d: BasicSwapBidDetail): "taker" | "maker" | null {
  if (d.was_sent === true) return "taker";
  if (d.was_received === true) return "maker";
  return null;
}

/** The user's side of a bid as its own record states it. `describeBid`
 *  reports in the offer's frame, `amt_from` belonging to the offer's
 *  `coin_from` on a reversed bid too (`ui/util.py:192-200`). */
function recordFrameOf(d: BasicSwapBidDetail, role: "taker" | "maker"): P2PFrame | null {
  const from = tickerOf(d.coin_from);
  const to = tickerOf(d.coin_to);
  if (!from || !to) return null;
  return role === "maker"
    ? { fromAsset: from, toAsset: to, fromAmount: d.amt_from ?? "", toAmount: d.amt_to ?? "" }
    : { fromAsset: to, toAsset: from, fromAmount: d.amt_to ?? "", toAmount: d.amt_from ?? "" };
}

/** Overlay what a bid's own record says: the protocol state (`bid_state_ind`,
 *  never reworded, unlike the display string), the leg, the side, the
 *  transactions. */
export function withBidDetail(obs: P2PObservation, d: BasicSwapBidDetail): P2PObservation {
  const leg = swapLegOf(d);
  const raw = d.bid_state_ind ?? d.bid_state;
  const txns = bidTxnsFrom(d);
  const merged = txns.length > 0 ? mergeTxns(obs.txns, txns) : obs.txns;
  const stateSec = d.state_time_timestamp;
  const role = recordRole(d);
  const frame = role ? recordFrameOf(d, role) : null;
  const sideOf = role ?? obs.role;
  const state = usableState(raw) ? raw : obs.bidState;
  return {
    ...obs,
    // A handle that guessed the side wrong (the in-progress list's
    // `was_sent: null` read as "sent" until 2026-10-06) gave a swapped
    // frame; the record's own frame replaces it.
    ...(obs.base && frame && role !== obs.role ? { base: { ...obs.base, ...frame } } : {}),
    ...(usableState(raw) ? { bidState: raw } : {}),
    ...(typeof stateSec === "number" && stateSec > 0
      ? { stateAt: isoFromUnixSeconds(stateSec) }
      : {}),
    ...(leg !== "unknown" ? { leg } : {}),
    ...(txns.length > 0 ? { txns: merged } : {}),
    ...(obs.offerId || !d.offer_id ? {} : { offerId: d.offer_id }),
    ...(role ? { role } : {}),
    ...(frame ? { recordFrame: frame } : {}),
    // A bid this node received is a row only once it is a swap.
    mayCreate:
      obs.mayCreate && (sideOf !== "maker" || makerSwapStarted(state, (merged?.length ?? 0) > 0)),
  };
}

/** One `/json/bids/<id>` read of a bid the tracker follows. */
export function observeBidRead(swap: SidecarSwapHandle, d: BasicSwapBidDetail): P2PObservation {
  return withBidDetail(
    {
      bidId: swap.bidId,
      base: baseFromHandle(swap),
      ...(swap.offerId ? { offerId: swap.offerId } : {}),
      mayCreate: true,
    },
    d,
  );
}

/** One row of `/json/active`: a swap in progress on either side of a bid. */
export function observeActive(r: BasicSwapActiveSwap): P2PObservation | null {
  if (!r || typeof r.bid_id !== "string" || !r.bid_id) return null;
  // The tracker's own reading of which leg this node sends, so the row and
  // the tracker cannot disagree about it. `was_sent` is `true` on a sent bid
  // and `null` on a received one (`activeSwapToTracked`).
  const t = activeSwapToTracked(r);
  const role = r.was_sent === true ? "taker" : "maker";
  return {
    bidId: r.bid_id,
    base: { ...baseFromHandle(t), bidState: r.bid_state },
    ...(usableState(r.bid_state) ? { bidState: r.bid_state } : {}),
    ...(r.offer_id ? { offerId: r.offer_id } : {}),
    role,
    mayCreate: role === "taker" || makerSwapStarted(r.bid_state, lockSeenIn(r)),
  };
}

/**
 * One row of `/json/sentbids`: a bid THIS node sent, so this node sends the
 * offer's `coin_to` and receives its `coin_from`, the frame `/json/active`
 * uses for a sent bid too (`activeSwaps.ts`, checked against the live
 * 2026-09-05 row). `amount_to` is null when the node no longer has the offer.
 */
export function observeSentBid(b: BasicSwapBidSummary): P2PObservation | null {
  if (!b || typeof b.bid_id !== "string" || !b.bid_id) return null;
  return {
    bidId: b.bid_id,
    base: {
      fromAsset: tickerOf(b.coin_to),
      toAsset: tickerOf(b.coin_from),
      fromAmount: b.amount_to ?? "",
      toAmount: b.amount_from ?? "",
      createdAt: isoFromUnixSeconds(b.created_at),
      ...(b.offer_id ? { offerId: b.offer_id } : {}),
      bidState: b.bid_state,
    },
    ...(usableState(b.bid_state) ? { bidState: b.bid_state } : {}),
    ...(b.offer_id ? { offerId: b.offer_id } : {}),
    role: "taker",
    mayCreate: true,
  };
}

/**
 * One row of `/json/bids`: a bid this node RECEIVED, on an offer it posted
 * (2026-10-01). The maker sends the offer's `coin_from` and receives its
 * `coin_to`. `formatBids` reports both in the offer's frame, `amount_from`
 * being the `coin_from` amount on a reversed offer too (`listBids` swaps them
 * back, deployed `basicswap.py:17093-17098`). A row only for a swap
 * (`makerSwapStarted`).
 */
export function observeReceivedBid(b: BasicSwapBidSummary): P2PObservation | null {
  if (!b || typeof b.bid_id !== "string" || !b.bid_id) return null;
  return {
    bidId: b.bid_id,
    base: {
      fromAsset: tickerOf(b.coin_from),
      toAsset: tickerOf(b.coin_to),
      fromAmount: b.amount_from ?? "",
      toAmount: b.amount_to ?? "",
      createdAt: isoFromUnixSeconds(b.created_at),
      ...(b.offer_id ? { offerId: b.offer_id } : {}),
      bidState: b.bid_state,
    },
    ...(usableState(b.bid_state) ? { bidState: b.bid_state } : {}),
    ...(b.offer_id ? { offerId: b.offer_id } : {}),
    role: "maker",
    mayCreate: makerSwapStarted(b.bid_state, lockSeenIn(b)),
  };
}

// ─── Transactions ─────────────────────────────────────────────────────

/** A txid worth storing and linking: 64 hex characters, the form every coin
 *  this route trades uses (the bitcoin family, XMR, ZEPH, ZANO). */
const TXID = /^[0-9a-f]{64}$/;

/**
 * The transaction ids a bid's record reports. Two upstream fields, both
 * written by `describeBid` (basicswap `ui/util.py`):
 *
 * - `txns`, for an adaptor-signature swap (`XMR_SWAP`): `{type, txid}` with
 *   the engine's names "Chain A Lock", "Chain A Lock Spend", "Chain B Lock",
 *   "Chain B Lock Spend", then the timelock path ("Chain A Lock Refund Tx",
 *   "Chain A Lock Refund Spend Tx", "Chain A Lock Refund Swipe Tx", "Mercy
 *   Tx", "Swipe Payout Sweep Tx"; `strTxType`, `basicswap_util.py:432-451`).
 *   The engine lists them ONLY when the request asks (`show_txns`, set by a
 *   POST carrying `show_extra`, deployed `js_server.py:845-846`). The
 *   tracker's GET cannot ask (the Rust allow-list keeps `bids/<id>`
 *   GET-only, because a POST body there can accept or abandon the bid), so
 *   they come from `fetchBidTxns`, a Rust command whose only body is
 *   `{"show_extra": true}` (2026-10-01).
 * - `initiate_tx` / `participate_tx`, for a scripted-to-scripted (HTLC) swap:
 *   always present, as "<txid> <TICKER>" or "None" (`getTxIdHex`). The two
 *   locks.
 */
export function bidTxnsFrom(d: BasicSwapBidDetail): P2PBidTx[] {
  const out: P2PBidTx[] = [];
  const add = (type: string, txid: unknown, ticker?: string) => {
    if (typeof txid !== "string") return;
    const id = txid.trim().toLowerCase();
    if (!TXID.test(id) || out.some((t) => t.txid === id)) return;
    out.push(ticker ? { type, txid: id, ticker } : { type, txid: id });
  };
  if (Array.isArray(d.txns)) {
    for (const t of d.txns) {
      const type = typeof t?.type === "string" ? t.type.trim() : "";
      if (type) add(type, t.txid);
    }
  }
  const rec = d as unknown as Record<string, unknown>;
  for (const [field, type] of [
    ["initiate_tx", "Initiate Tx"],
    ["participate_tx", "Participate Tx"],
  ] as const) {
    const raw = rec[field];
    if (typeof raw !== "string") continue;
    const m = raw.trim().match(/^([0-9a-f]{64})(?:\s+([a-z0-9_]{1,12}))?$/i);
    if (m) add(type, m[1], m[2]?.toUpperCase());
  }
  return out;
}

function mergeTxns(prior: P2PBidTx[] | undefined, more: P2PBidTx[]): P2PBidTx[] {
  const out = [...(prior ?? [])];
  for (const t of more) if (!out.some((p) => p.txid === t.txid)) out.push(t);
  return out;
}

/** Whose transaction it is and what it did, from the user's side. */
export type P2PTxRole =
  | "you-locked"
  | "they-locked"
  | "you-claimed"
  | "they-claimed"
  | "you-refunded"
  | "they-refunded"
  | "pre-refund"
  | "other";

export interface P2PLegTx {
  role: P2PTxRole;
  /** The engine's own name for it. */
  type: string;
  txid: string;
  /** The ticker of the chain it is on, or null when that is not known. */
  asset: string | null;
  /** The wallet's own explorer link (never one from a response), or null. */
  explorerUrl: string | null;
}

const SCRIPTLESS = new Set(SIDECAR_SCRIPTLESS_TICKERS.map((t) => t.toUpperCase()));

/** "Chain A Lock Refund Spend Tx" -> "chain a lock refund spend". */
function txKind(type: string): string {
  return type.toLowerCase().replace(/\s+tx$/, "").replace(/\s+/g, " ").trim();
}

/**
 * The reported transactions, each with its role from the user's side.
 *
 * On an adaptor-signature swap, chain A is the SCRIPTED coin's chain and chain
 * B the scriptless coin's (`describeBid`: `ci_leader` and `ci_follower`), so
 * which one is the user's own lock follows from which coin they sent: the
 * engine names the chain, the row names the coin. "Chain B Lock Spend" is the
 * one name with two meanings: the scripted side claiming the scriptless lock
 * (a completed swap, or a swipe answered with the key share), or the
 * scriptless side taking its own coin back after the other side refunded.
 * The transactions beside it say which.
 *
 * A scripted-to-scripted swap reports its two locks with the chain's ticker.
 *
 * Which chain is this node's comes from the bid's leg when a read of the bid
 * named it (`swapLegOf`: "scripted" locked chain A, "scriptless" chain B),
 * and only otherwise from which coin is XMR, ZEPH or ZANO. The leg is the
 * engine's own answer and covers the pairs that coin list cannot: the engine
 * puts DOGE and DASH on chain B too (`is_reverse_ads_bid`, deployed
 * `basicswap.py:3992`), and on BTC↔LTC chain A is whichever coin the offer
 * sells. Added 2026-10-06, when these ids started arriving.
 */
export function p2pLegTransactions(row: SwapHistoryEntry): P2PLegTx[] {
  const txns = row.bidTxns ?? [];
  if (txns.length === 0) return [];
  const from = row.fromAsset.toUpperCase();
  const to = row.toAsset.toUpperCase();
  // The chain this wallet locked on, for an adaptor swap.
  const mine: "A" | "B" | null =
    row.bidLeg === "scripted"
      ? "A"
      : row.bidLeg === "scriptless"
        ? "B"
        : SCRIPTLESS.has(from)
          ? "B"
          : SCRIPTLESS.has(to)
            ? "A"
            : null;
  const assetOf = (chain: "A" | "B"): string | null =>
    mine == null ? null : chain === mine ? from : to;
  const kinds = new Set(txns.map((t) => txKind(t.type)));
  const swiped = kinds.has("chain a lock refund swipe");
  const refundPath =
    !swiped && (kinds.has("chain a lock refund spend") || row.status === "refunded");

  /** The role of a transaction made by whoever locked `actor`'s chain. */
  const by = (actor: "A" | "B", ifYou: P2PTxRole, ifThem: P2PTxRole): P2PTxRole =>
    mine == null ? "other" : actor === mine ? ifYou : ifThem;

  const roleOf = (t: P2PBidTx): { role: P2PTxRole; asset: string | null } => {
    const kind = txKind(t.type);
    switch (kind) {
      case "chain a lock":
        return { role: by("A", "you-locked", "they-locked"), asset: assetOf("A") };
      case "chain b lock":
        return { role: by("B", "you-locked", "they-locked"), asset: assetOf("B") };
      // The chain-B locker claims the chain-A lock: the happy path.
      case "chain a lock spend":
        return { role: by("B", "you-claimed", "they-claimed"), asset: assetOf("A") };
      case "chain b lock spend":
        return refundPath
          ? // The chain-B locker took its own coin back after the other refunded.
            { role: by("B", "you-refunded", "they-refunded"), asset: assetOf("B") }
          : // The chain-A locker claimed it: on a completed swap, or with the
            // key share the swiper handed back after a swipe.
            { role: by("A", "you-claimed", "they-claimed"), asset: assetOf("B") };
      case "chain a lock refund":
        return { role: "pre-refund", asset: assetOf("A") };
      // The chain-A locker's coin back to it.
      case "chain a lock refund spend":
        return { role: by("A", "you-refunded", "they-refunded"), asset: assetOf("A") };
      // The chain-B locker took the chain-A coin after the second timelock.
      case "chain a lock refund swipe":
        return { role: by("B", "you-claimed", "they-claimed"), asset: assetOf("A") };
      // The swiper's follow-ups on chain A: the key share handed back, and
      // the sweep of the swipe payout into its wallet (`_spendSwipePayout`,
      // `_sweepSwipePayout`, deployed `basicswap.py:9813-9889`).
      case "mercy":
        return { role: "other", asset: assetOf("A") };
      case "swipe payout sweep":
        return { role: by("B", "you-claimed", "they-claimed"), asset: assetOf("A") };
      case "initiate":
      case "participate": {
        const ticker = t.ticker?.toUpperCase() ?? null;
        if (ticker === from) return { role: "you-locked", asset: from };
        if (ticker === to) return { role: "they-locked", asset: to };
        return { role: "other", asset: ticker };
      }
      default: {
        const chain = /^chain a\b/.test(kind) ? "A" : /^chain b\b/.test(kind) ? "B" : null;
        return { role: "other", asset: chain ? assetOf(chain) : null };
      }
    }
  };

  return txns.map((t) => {
    const { role, asset } = roleOf(t);
    return {
      role,
      type: t.type,
      txid: t.txid,
      asset,
      explorerUrl: asset ? destinationExplorerUrl(asset, t.txid) : null,
    };
  });
}

// ─── Merging an observation into a row ────────────────────────────────

/** Same protocol state, whatever form each came in (int, display string or
 *  name). */
function sameState(a: number | string, b: number | string): boolean {
  const na = classifyBidState(a).state;
  const nb = classifyBidState(b).state;
  return na != null && nb != null ? na === nb : a === b;
}

/**
 * The row after one observation, or null when nothing changes (or there is
 * no row and the observation may not create one). Pure: `nowIso` is when a
 * finished status is first recorded.
 */
export function applyP2PObservation(
  prior: SwapHistoryEntry | undefined,
  obs: P2PObservation,
  nowIso: string,
): SwapHistoryEntry | null {
  let row: SwapHistoryEntry;
  if (prior) {
    row = { ...prior };
  } else {
    if (!obs.mayCreate || !obs.base) return null;
    row = {
      id: p2pHistoryId(obs.bidId),
      fromAsset: obs.base.fromAsset,
      toAsset: obs.base.toAsset,
      fromAmount: obs.base.fromAmount,
      toAmount: obs.base.toAmount,
      status: "pending",
      sourceTxHash: "",
      sourceExplorerUrl: "",
      provider: P2P_HISTORY_PROVIDER,
      createdAt: obs.base.createdAt,
      bidId: obs.bidId,
      ...(obs.role ? { bidRole: obs.role } : {}),
      ...(obs.base.offerId ? { offerId: obs.base.offerId } : {}),
      ...(obs.base.bidState != null && obs.base.bidState !== ""
        ? { bidState: obs.base.bidState }
        : {}),
    };
  }

  // What the user reviewed stays; the node's copy only fills blanks.
  if (obs.base) {
    if (!row.fromAsset) row.fromAsset = obs.base.fromAsset;
    if (!row.toAsset) row.toAsset = obs.base.toAsset;
    if (!row.fromAmount) row.fromAmount = obs.base.fromAmount;
    if (!row.toAmount) row.toAmount = obs.base.toAmount;
  }
  if (!row.bidId) row.bidId = obs.bidId;
  if (!row.offerId && obs.offerId) row.offerId = obs.offerId;
  if (obs.leg) row.bidLeg = obs.leg;

  // Which side of the bid this node was (2026-10-01). The bid's own record
  // decides; a list row or a tracker handle only fills a blank.
  if (obs.recordFrame && obs.role) {
    const rf = obs.recordFrame;
    if (
      prior &&
      !prior.bidRole &&
      obs.role === "maker" &&
      prior.fromAsset === rf.toAsset &&
      prior.toAsset === rf.fromAsset
    ) {
      // A row with no side, legs the wrong way round for a bid its record
      // says this node RECEIVED: written from the in-progress list before
      // 2026-10-01, which read the engine's `was_sent: null` as "sent", the
      // taker frame. Turned the right way round once, and the two hashes
      // derived from that frame are worked out again below.
      row.fromAsset = rf.fromAsset;
      row.toAsset = rf.toAsset;
      row.fromAmount = rf.fromAmount;
      row.toAmount = rf.toAmount;
      row.sourceTxHash = "";
      row.sourceExplorerUrl = "";
      delete row.destTxHash;
      delete row.destExplorerUrl;
    }
    row.bidRole = obs.role;
  } else if (obs.role && !row.bidRole) {
    row.bidRole = obs.role;
  }

  // Where the bid asked the engine to pay the bought coin, as placed.
  if (obs.payout && !row.payoutTo) {
    row.payoutTo = obs.payout.to;
    if (obs.payout.to === "address" && obs.payout.address && !row.recipient) {
      row.recipient = obs.payout.address;
    }
  }

  const candidate = obs.bidState ?? row.bidState;
  if (candidate != null && candidate !== "") {
    const next = p2pBidStateToHistoryStatus(candidate, row.bidLeg ?? "unknown");
    // A finished row never goes back to pending. The tracker reads the
    // in-progress list and each bid on separate timers, so an answer read
    // just before the swap ended can be processed just after one read after
    // it. Finished to finished is allowed: that is the node changing its mind
    // with evidence.
    if (!(row.status !== "pending" && next === "pending")) {
      if (obs.bidState != null) {
        // Keep the stored form when it is the same state, preferring the
        // protocol int over a display string that upstream may reword.
        const stored = row.bidState;
        row.bidState =
          stored != null && sameState(stored, obs.bidState)
            ? typeof stored === "number"
              ? stored
              : obs.bidState
            : obs.bidState;
      }
      row.status = next;
    }
  }
  // Dated by the node's own time for the state, when the read carried it.
  if (row.status !== "pending" && !row.completedAt) row.completedAt = obs.stateAt ?? nowIso;

  if (obs.txns && obs.txns.length > 0) row.bidTxns = mergeTxns(row.bidTxns, obs.txns);

  // "What you sent" and "what you received" for every list and the details:
  // the user's own lock, and the transaction that paid them the coin they
  // bought. Filled once; a hash already on the row is never replaced.
  const legs = p2pLegTransactions(row);
  const sent = legs.find((t) => t.role === "you-locked");
  const got = legs.find((t) => t.role === "you-claimed");
  if (sent && !row.sourceTxHash) {
    row.sourceTxHash = sent.txid;
    row.sourceExplorerUrl = sent.explorerUrl ?? "";
  }
  if (got && !row.destTxHash) {
    row.destTxHash = got.txid;
    if (got.explorerUrl) row.destExplorerUrl = got.explorerUrl;
  }

  if (prior && JSON.stringify(prior) === JSON.stringify(row)) return null;
  return row;
}

/// ─── Writing ──────────────────────────────────────────────────────────

export interface P2PHistoryDeps {
  modify: typeof modifySwapHistory;
  load: typeof loadSwapHistory;
  fetchSentBids: typeof fetchSentBids;
  /** Bids this node RECEIVED, for the backfill's maker rows (2026-10-01). */
  fetchBids: typeof fetchBids;
  fetchBid: typeof fetchBid;
  /** One bid's record with its transactions (2026-10-01). */
  fetchBidTxns: typeof fetchBidTxns;
  now: () => number;
}

const DEFAULT_DEPS: P2PHistoryDeps = {
  modify: modifySwapHistory,
  load: loadSwapHistory,
  fetchSentBids,
  fetchBids,
  fetchBid,
  fetchBidTxns,
  now: () => Date.now(),
};

function newestFirst(a: SwapHistoryEntry, b: SwapHistoryEntry): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** Merge observations into history, in ONE store write (none if nothing
 *  changes). */
export async function writeP2PObservations(
  list: P2PObservation[],
  deps: Partial<P2PHistoryDeps> = {},
): Promise<void> {
  if (list.length === 0) return;
  const d = { ...DEFAULT_DEPS, ...deps };
  const nowIso = new Date(d.now()).toISOString();
  await d.modify((rows) => {
    let changed = false;
    let inserted = false;
    for (const o of list) {
      const id = p2pHistoryId(o.bidId);
      const i = rows.findIndex((r) => r.id === id);
      const next = applyP2PObservation(i >= 0 ? rows[i] : undefined, o, nowIso);
      if (!next) continue;
      changed = true;
      if (i >= 0) {
        rows[i] = next;
      } else {
        rows.unshift(next);
        inserted = true;
      }
    }
    if (!changed) return null;
    // A backfill can add many old swaps at once. Newest first, so the 200-row
    // cap drops the OLDEST swaps rather than whatever was added before them.
    return inserted ? rows.sort(newestFirst) : rows;
  });
}

/**
 * One bid's own record, with its transactions when the node gives them:
 * `fetchBidTxns` first, the plain GET when that read is missing (a Rust build
 * without the command) or fails. The GET still has the state and the leg.
 * `null` when neither answered with a record.
 */
async function readBidRecord(
  d: P2PHistoryDeps,
  bidId: string,
): Promise<BasicSwapBidDetail | null> {
  try {
    const r = await d.fetchBidTxns(bidId);
    if (r && !isApiError(r)) return r;
  } catch {
    // The plain read below.
  }
  try {
    const r = await d.fetchBid(bidId);
    if (r && !isApiError(r)) return r;
  } catch {
    // The list row alone still makes a row.
  }
  return null;
}

/**
 * Write the swaps the node already knows that history does not have, or has
 * as pending: the swaps from before this change, and ones that ended while
 * nothing was following them. Both sides of the book: the bids this node
 * SENT (`/json/sentbids`) and, since 2026-10-06, the ones it RECEIVED
 * (`/json/bids`), the newest 100 of each. Each bid's own record is read for
 * its protocol state, leg and transactions; when that read fails, the list
 * row is used. A received bid that never became a swap (not accepted, no
 * lock) is not read at all: its list row already says so. A bid on both
 * lists, one this node sent and received itself, is the user's own bid: one
 * row, the taker's. Returns how many bids were looked at. Read-only toward
 * the node.
 */
export async function backfillP2PHistory(
  deps: Partial<P2PHistoryDeps> = {},
): Promise<number> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const query = {
    limit: P2P_BACKFILL_LIMIT,
    sort_by: "created_at" as const,
    sort_dir: "desc" as const,
  };
  const sent = await d.fetchSentBids(query);
  if (isApiError(sent)) throw new Error(sent.error);
  if (!Array.isArray(sent)) throw new Error("the swap node's sent-bid list was not a list");
  // Both lists or neither: a backfill marked done after only the sent half
  // would not look at the received half again this session.
  const received = await d.fetchBids(query);
  if (isApiError(received)) throw new Error(received.error);
  if (!Array.isArray(received)) {
    throw new Error("the swap node's received-bid list was not a list");
  }
  const stored = await d.load();
  const finished = new Set(
    stored.filter((r) => r.bidId && r.status !== "pending").map((r) => r.bidId),
  );
  const storedIds = new Set(stored.map((r) => r.bidId).filter(Boolean));
  const sentIds = new Set(sent.map((b) => b?.bid_id).filter(Boolean));
  const candidates: P2PObservation[] = [];
  for (const b of sent) {
    const obs = observeSentBid(b);
    if (obs && !finished.has(obs.bidId)) candidates.push(obs);
  }
  for (const b of received) {
    const obs = observeReceivedBid(b);
    if (!obs || sentIds.has(obs.bidId) || finished.has(obs.bidId)) continue;
    if (!obs.mayCreate && !storedIds.has(obs.bidId)) continue;
    candidates.push(obs);
  }
  const list: P2PObservation[] = [];
  for (const obs of candidates) {
    const detail = await readBidRecord(d, obs.bidId);
    list.push(detail ? withBidDetail(obs, detail) : obs);
  }
  await writeP2PObservations(list, d);
  return list.length;
}

/** {@link SidecarHistorySink}, with the promises kept for tests. */
export interface P2PHistorySink extends SidecarHistorySink {
  placed(handle: SidecarSwapHandle): Promise<void>;
  bidRead(swap: SidecarSwapHandle, detail: BasicSwapBidDetail): Promise<void>;
  activeRead(rows: BasicSwapActiveSwap[]): Promise<void>;
  /**
   * Read one bid's transactions now and write them into its row; never
   * creates a row. For the swap details when they open (2026-10-01), which
   * is what fills a swap that ended while nothing was following it.
   * `"read"`: the node answered with the bid's record. `"failed"`: it did not
   * (not running, or no such bid).
   */
  refreshTxns(bidId: string): Promise<"read" | "failed">;
  reset(): void;
}

/**
 * The sink `useSidecarSwap` reports to. Writes never throw at the tracker: a
 * failed write is logged and the next report tries again from the store.
 * The backfill runs on the first in-progress answer of a session; if it
 * fails, the next answer tries again.
 *
 * Transactions (2026-10-01): after a bid read, the bid's transactions are
 * read too, once per state it reaches in a session. A transaction appears
 * with a state change, so that is enough, and it is one extra read per step
 * of a swap rather than one per poll. A bid still being requested has none.
 * A read that fails is tried again on the next poll.
 */
export function createP2PHistorySink(deps: Partial<P2PHistoryDeps> = {}): P2PHistorySink {
  const d = { ...DEFAULT_DEPS, ...deps };
  let backfill: "idle" | "running" | "done" = "idle";
  let session = 0;
  /** The state each bid's transactions were last read at, this session. */
  const txnsReadAt = new Map<string, string>();
  const write = (list: P2PObservation[]) =>
    writeP2PObservations(list, d).catch((e) => {
      console.warn("[p2p-history] swap history write failed", e);
    });
  /** Read one bid's transactions and merge them into `obs`'s row. */
  const readTxnsInto = async (obs: P2PObservation): Promise<boolean> => {
    let detail: Awaited<ReturnType<typeof fetchBidTxns>>;
    try {
      detail = await d.fetchBidTxns(obs.bidId);
    } catch {
      return false;
    }
    if (!detail || isApiError(detail)) return false;
    await write([withBidDetail(obs, detail)]);
    return true;
  };
  return {
    placed: (handle) => write([observePlaced(handle)]),
    bidRead: async (swap, detail) => {
      const obs = observeBidRead(swap, detail);
      await write([obs]);
      // The protocol int; the display string from an engine that omits it.
      const state = detail?.bid_state_ind ?? detail?.bid_state;
      if (state == null || String(state).trim() === "") return;
      if (classifyBidState(state).stage === "requesting") return;
      const key = String(state);
      if (txnsReadAt.get(swap.bidId) === key) return;
      txnsReadAt.set(swap.bidId, key);
      if (!(await readTxnsInto(obs))) txnsReadAt.delete(swap.bidId);
    },
    activeRead: (rows) => {
      const list = (Array.isArray(rows) ? rows : [])
        .map(observeActive)
        .filter((o): o is P2PObservation => o != null);
      const wrote = write(list);
      if (backfill !== "idle") return wrote;
      backfill = "running";
      const mine = session;
      const filled = wrote
        .then(() => backfillP2PHistory(d))
        .then(
          () => {
            if (mine === session) backfill = "done";
          },
          (e) => {
            if (mine === session) backfill = "idle";
            console.warn("[p2p-history] backfill failed; trying again on the node's next answer", e);
          },
        );
      return filled;
    },
    refreshTxns: async (bidId) =>
      (await readTxnsInto({ bidId, mayCreate: false })) ? "read" : "failed",
    reset: () => {
      session += 1;
      backfill = "idle";
      txnsReadAt.clear();
    },
  };
}

/** The app's one sink. `App.tsx` hands it to `useSidecarSwap`. */
export const p2pSwapHistory: P2PHistorySink = createP2PHistorySink();

// ─── The details' words ───────────────────────────────────────────────

export interface P2PStageView {
  key: BidStage | "timelock-undecided" | "recorded";
  label: string;
  description: string;
  severity: BidSeverity;
  terminal: boolean;
}

const RECORDED_WORDS: Readonly<Record<SwapHistoryStatus, string>> = {
  pending: "Pending",
  success: "Completed",
  refunded: "Refunded",
  failed: "Failed",
};

/**
 * The two stages whose tracker sentence is the TAKER's ("Your bid has been
 * sent…", "The other user accepted your bid…"), as the maker reads them
 * (2026-10-01). Every later stage is told by leg, not by side, and reads the
 * same for a maker.
 */
const MAKER_WORDS: Readonly<Partial<Record<BidStage, string>>> = {
  requesting:
    "The other user's bid on your offer reached your node and is waiting to be accepted.",
  accepted:
    "Your node accepted the other user's bid on your offer. Both sides are exchanging the messages that set the swap up.",
};

/**
 * The bid's stage in plain words: the tracker's own label and sentence
 * (`bidStates.ts`), read from the stored state and leg.
 *
 * With no leg, a state whose two readings tell opposite stories (the
 * pre-refund, the swipe) gets a sentence that claims neither: the tracker
 * itself says the neutral reading of those is the other side's story
 * (`bidStates.ts`, "A bid state does NOT determine the story on its own").
 */
export function p2pStageView(row: SwapHistoryEntry): P2PStageView {
  const state = row.bidState;
  const leg = row.bidLeg ?? "unknown";
  if (state != null && state !== "") {
    if (
      leg === "unknown" &&
      stageForBidState(state, "scripted") !== stageForBidState(state, "scriptless")
    ) {
      return {
        key: "timelock-undecided",
        label: "On the timelock path",
        description:
          "The other user stopped responding, and the swap's timelock is settling it. What that means for your coins depends on which side of the swap your node is on, which no read of this bid has said yet. The live tracker reads it.",
        severity: "normal",
        terminal: false,
      };
    }
    const c = classifyBidState(state, leg);
    if (c.surface && c.label) {
      return {
        key: c.stage,
        label: c.label,
        description:
          (row.bidRole === "maker" ? MAKER_WORDS[c.stage] : undefined) ?? c.description,
        severity: c.severity,
        terminal: c.terminal,
      };
    }
  }
  return {
    key: "recorded",
    label: RECORDED_WORDS[row.status],
    description: "The swap node has not reported a state for this swap.",
    severity: row.status === "pending" ? "progress" : "normal",
    terminal: row.status !== "pending",
  };
}

/** What the tracker needs to follow a history row's bid itself. No payout
 *  address, on purpose: that is what keeps an automatic re-bid from ever
 *  firing for a swap the tracker did not place this session. */
export function p2pTrackerHandle(row: SwapHistoryEntry): SidecarSwapHandle | null {
  if (!row.bidId) return null;
  const created = Date.parse(row.createdAt);
  return {
    bidId: row.bidId,
    offerId: row.offerId ?? "",
    sendCoin: row.fromAsset,
    receiveCoin: row.toAsset,
    sendAmount: row.fromAmount,
    receiveAmount: row.toAmount,
    createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : Math.floor(Date.now() / 1000),
  };
}
