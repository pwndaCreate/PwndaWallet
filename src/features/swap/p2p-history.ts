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
 *   pending row with the coins and amounts the user reviewed.
 * - `bidRead`: one `GET /json/bids/<id>` read. The state, the leg, and any
 *   transaction ids the node reported.
 * - `activeRead`: one `/json/active` read. A row for each bid this node SENT
 *   that is in progress (one placed from the node's own console, or before
 *   this change, appears too), and on the first answer of a session the
 *   backfill below.
 *
 * The backfill reads `/json/sentbids` (every bid this node sent, finished ones
 * included) and writes the bids history lacks or still has as pending, after
 * reading each one's own record for its protocol state and leg. Read-only: it
 * places, accepts and cancels nothing.
 *
 * A bid this node RECEIVED (a swap on an offer it posted itself) is not
 * written: these lists show the swaps the user placed, and the backfill can
 * only see sent bids, so writing received ones from the in-progress list
 * alone would make history depend on whether the app happened to be open.
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
 */
import {
  fetchBid,
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

/** What one report says about one bid, before it is merged into a row. */
export interface P2PObservation {
  bidId: string;
  /** Who and what: used to create a row that does not exist, and to fill a
   *  stored row's blanks. Never overrides what is stored. */
  base?: {
    fromAsset: string;
    toAsset: string;
    fromAmount: string;
    toAmount: string;
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
  /** A bid this node sent: a missing row may be created. */
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

/** The bid this wallet just placed: what `adopt` was handed. */
export function observePlaced(h: SidecarSwapHandle): P2PObservation {
  return {
    bidId: h.bidId,
    // A bid the node has just accepted is, by definition, sent: the same
    // starting state `adopt` gives the tracker.
    base: { ...baseFromHandle(h), bidState: "BID_SENT" },
    ...(h.offerId ? { offerId: h.offerId } : {}),
    mayCreate: true,
  };
}

/** Overlay what a bid's own record says: the protocol state (`bid_state_ind`,
 *  never reworded, unlike the display string), the leg, the transactions. */
export function withBidDetail(obs: P2PObservation, d: BasicSwapBidDetail): P2PObservation {
  const leg = swapLegOf(d);
  const raw = d.bid_state_ind ?? d.bid_state;
  const txns = bidTxnsFrom(d);
  const stateSec = d.state_time_timestamp;
  return {
    ...obs,
    ...(usableState(raw) ? { bidState: raw } : {}),
    ...(typeof stateSec === "number" && stateSec > 0
      ? { stateAt: isoFromUnixSeconds(stateSec) }
      : {}),
    ...(leg !== "unknown" ? { leg } : {}),
    ...(txns.length > 0 ? { txns: mergeTxns(obs.txns, txns) } : {}),
    ...(obs.offerId || !d.offer_id ? {} : { offerId: d.offer_id }),
    // `was_sent` is upstream's own flag for "this node placed the bid".
    mayCreate: obs.mayCreate && d.was_sent !== false,
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

/** One row of `/json/active`, or null for a bid this node RECEIVED. */
export function observeActive(r: BasicSwapActiveSwap): P2PObservation | null {
  if (!r || typeof r.bid_id !== "string" || !r.bid_id) return null;
  if (r.was_sent === false) return null;
  // The tracker's own reading of which leg this node sends, so the row and
  // the tracker cannot disagree about it.
  const t = activeSwapToTracked(r);
  return {
    bidId: r.bid_id,
    base: { ...baseFromHandle(t), bidState: r.bid_state },
    ...(usableState(r.bid_state) ? { bidState: r.bid_state } : {}),
    ...(r.offer_id ? { offerId: r.offer_id } : {}),
    mayCreate: true,
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
    mayCreate: true,
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
 *   Tx", …). The engine lists them ONLY when the request asks
 *   (`show_txns`, set by a POST carrying `show_extra`, js_server.py:798-800).
 *   The wallet reads a bid with a GET (the Rust allow-list keeps `bids/<id>`
 *   GET-only, because a POST body there can accept or abandon the bid), so on
 *   today's reads this field is absent. Kept so the ids are recorded the
 *   moment a read carries them.
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
 */
export function p2pLegTransactions(row: SwapHistoryEntry): P2PLegTx[] {
  const txns = row.bidTxns ?? [];
  if (txns.length === 0) return [];
  const from = row.fromAsset.toUpperCase();
  const to = row.toAsset.toUpperCase();
  // The chain this wallet locked on, for an adaptor swap.
  const mine: "A" | "B" | null = SCRIPTLESS.has(from) ? "B" : SCRIPTLESS.has(to) ? "A" : null;
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

  const candidate = obs.bidState ?? row.bidState;
  if (candidate != null && candidate !== "") {
    const next = p2pBidStateToHistoryStatus(candidate, row.bidLeg ?? "unknown");
    // A finished row never goes back to pending. The tracker reads the
    // in-progress list and each bid on separate timers, so an answer read
    // just before the swap ended can be processed just after one read after
    // it. Finished to finished is allowed: that is the node changing its mind
    // with evidence (a refund the mercy key share turned around).
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

// ─── Writing ──────────────────────────────────────────────────────────

export interface P2PHistoryDeps {
  modify: typeof modifySwapHistory;
  load: typeof loadSwapHistory;
  fetchSentBids: typeof fetchSentBids;
  fetchBid: typeof fetchBid;
  now: () => number;
}

const DEFAULT_DEPS: P2PHistoryDeps = {
  modify: modifySwapHistory,
  load: loadSwapHistory,
  fetchSentBids,
  fetchBid,
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
 * Write the bids the node already sent that history does not have, or has
 * as pending: the swaps from before this change, and ones that ended while
 * nothing was following them. Each bid's own record is read for its protocol
 * state and leg; when that read fails, the list row is used. Returns how many
 * bids were looked at. Read-only toward the node.
 */
export async function backfillP2PHistory(
  deps: Partial<P2PHistoryDeps> = {},
): Promise<number> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const reply = await d.fetchSentBids({
    limit: P2P_BACKFILL_LIMIT,
    sort_by: "created_at",
    sort_dir: "desc",
  });
  if (isApiError(reply)) throw new Error(reply.error);
  if (!Array.isArray(reply)) throw new Error("the swap node's sent-bid list was not a list");
  const stored = await d.load();
  const finished = new Set(
    stored.filter((r) => r.bidId && r.status !== "pending").map((r) => r.bidId),
  );
  const list: P2PObservation[] = [];
  for (const b of reply) {
    const obs = observeSentBid(b);
    if (!obs || finished.has(obs.bidId)) continue;
    let full = obs;
    try {
      const detail = await d.fetchBid(obs.bidId);
      if (detail && !isApiError(detail)) full = withBidDetail(obs, detail);
    } catch {
      // The list row alone still makes a row.
    }
    list.push(full);
  }
  await writeP2PObservations(list, d);
  return list.length;
}

/** {@link SidecarHistorySink}, with the promises kept for tests. */
export interface P2PHistorySink extends SidecarHistorySink {
  placed(handle: SidecarSwapHandle): Promise<void>;
  bidRead(swap: SidecarSwapHandle, detail: BasicSwapBidDetail): Promise<void>;
  activeRead(rows: BasicSwapActiveSwap[]): Promise<void>;
  reset(): void;
}

/**
 * The sink `useSidecarSwap` reports to. Writes never throw at the tracker: a
 * failed write is logged and the next report tries again from the store.
 * The backfill runs on the first in-progress answer of a session; if it
 * fails, the next answer tries again.
 */
export function createP2PHistorySink(deps: Partial<P2PHistoryDeps> = {}): P2PHistorySink {
  const d = { ...DEFAULT_DEPS, ...deps };
  let backfill: "idle" | "running" | "done" = "idle";
  let session = 0;
  const write = (list: P2PObservation[]) =>
    writeP2PObservations(list, d).catch((e) => {
      console.warn("[p2p-history] swap history write failed", e);
    });
  return {
    placed: (handle) => write([observePlaced(handle)]),
    bidRead: (swap, detail) => write([observeBidRead(swap, detail)]),
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
    reset: () => {
      session += 1;
      backfill = "idle";
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
        description: c.description,
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
