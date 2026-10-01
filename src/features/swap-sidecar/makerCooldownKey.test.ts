/**
 * The maker half of the offer cool-down never named a maker (flagged
 * 2026-10-01 while building P2P swap history; fixed the same day on the
 * operator's request to verify it).
 *
 * When a bid expires unanswered, `useSidecarSwap` cools two keys for 90
 * minutes: the offer, and the maker who posted it, because makers re-post
 * continuously and the offer id alone hands the user the same sleeping
 * counterparty under a new number (`offerCooldown.ts`, the operator's
 * request of 2026-09-05). Two halves were broken, and either one alone kept
 * the maker key dead:
 *
 *  - WRITE. The maker was read from the bid's own record,
 *    `swap.detail?.addr_from`. On a bid this node sent that is this node's
 *    own address: the deployed engine's `describeBid` reports `bid.bid_addr`
 *    there (`ui/util.py:367`), and `postXmrBid` takes that from
 *    `prepareSMSGAddress` (`basicswap.py:6965`). The maker is the OFFER's
 *    `addr_from`, now carried on the handle from the offer the bid was
 *    placed on.
 *  - READ. Both quote pools filter `TakerOffer`s through `applyCooldown`,
 *    which looks at `makerAddress`, and `TakerOffer` had no such field, so
 *    only offer ids were ever compared. `toTakerOffer` now copies
 *    `addr_from` into it.
 *
 * The automatic re-bid's own refusal (`shouldAutoRetry`) already read the
 * offer's `addr_from`; with the write key wrong it could never match. What an
 * automatic re-bid may do is unchanged: it now meets the cool-down it was
 * always meant to meet.
 *
 * Nothing here reaches a swap node: the API is stubbed, and the bid placer
 * throws if anything calls it. Addresses and ids are invented, in the
 * engine's layouts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The opt-in flag `fetchSidecarQuote` checks first (its own plugin-store file).
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => (k === "pwnda.swapSidecarOptedInAt" ? 1_790_000_000_000 : undefined),
    set: async () => undefined,
    save: async () => undefined,
    delete: async () => undefined,
  }),
}));

// The swap node. The book is the test's; every advisory read fails, which the
// quote absorbs by design; placing a bid is an error.
vi.mock("../../api/basicswap", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/basicswap")>();
  const absent = (what: string) => async () => {
    throw new Error(`${what} is not part of this test`);
  };
  return {
    ...real,
    fetchOffers: vi.fn(),
    fetchCoins: vi.fn(absent("the coin table")),
    fetchOfferFeeEstimate: vi.fn(absent("the fee estimate")),
    fetchWallets: vi.fn(absent("the node balances")),
    swapSidecarPlaceBid: vi.fn(async () => {
      throw new Error("a test must never place a bid");
    }),
  };
});

import * as api from "../../api/basicswap";
import type { BasicSwapBidDetail, BasicSwapOffer } from "../../api/basicswap";
import { toTakerOffers } from "./offers";
import {
  COOLDOWN_REASON_EXPIRED,
  clearCooldowns,
  coolDown,
  isCooledDown,
  loadCooldowns,
} from "./offerCooldown";
import { shouldAutoRetry } from "./autoRetry";
import { classifyBidState } from "./bidStates";
import { activeSwapToTracked } from "./activeSwaps";
import {
  cooldownTargetForUnansweredBid,
  fetchSidecarQuote,
  resetSidecarCoinCache,
  type SidecarTrackedSwap,
} from "./useSidecarSwap";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

// Invented ids with the engine's layout: 28-byte object ids.
const objId = (fill: string) => "00000000" + fill.repeat(24);
const BID = objId("b1");
const OFFER_UNANSWERED = objId("01");
const OFFER_REPOSTED = objId("02");
const OFFER_OTHER_MAKER = objId("03");

const MAKER_ASLEEP = "pInventedMakerAsleepXXXXXXXXXXXXXXX";
const MAKER_AWAKE = "pInventedMakerAwakeXXXXXXXXXXXXXXXX";
/** `bid.bid_addr`: the address THIS node sent the bid from. */
const OWN_BID_ADDR = "pInventedOwnBidAddrXXXXXXXXXXXXXXXX";

const PRICES = { XMR: 162.3, LTC: 117 };
const CREATED = 1_790_100_000; // unix seconds

/** A `/json/offers` row: a maker selling LTC for XMR, so a taker sends XMR. */
function row(offerId: string, maker: string, rate: string): BasicSwapOffer {
  return {
    offer_id: offerId,
    swap_type: 5, // SwapTypes.XMR_SWAP
    addr_from: maker,
    addr_to: "pInventedNetworkAddrXXXXXXXXXXXXXXX",
    created_at: CREATED,
    expire_at: CREATED + 3600,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amount_from: "10.00000000",
    amount_to: (10 * Number(rate)).toFixed(12),
    rate,
    min_bid_amount: "0.01000000",
    is_expired: false,
    is_own_offer: false,
    is_revoked: false,
    is_public: true,
    amount_negotiable: true,
    rate_negotiable: false,
  };
}

/** `GET /json/bids/<id>` for the expired bid, in `describeBid`'s fields. */
function expiredBidDetail(): BasicSwapBidDetail {
  return {
    offer_id: OFFER_UNANSWERED,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amt_from: "0.69988801",
    amt_to: "0.500000000000",
    bid_rate: "0.714400000000",
    ticker_from: "LTC",
    ticker_to: "XMR",
    bid_state: "Expired",
    bid_state_ind: 31, // BID_EXPIRED
    state_description: "Bid expired before being accepted",
    itx_state: "None",
    ptx_state: "None",
    // `describeBid`: "addr_from": bid.bid_addr. On a SENT bid, this node.
    addr_from: OWN_BID_ADDR,
    created_at_timestamp: CREATED,
    expired_at: CREATED + 3600,
    was_sent: true,
    was_received: false,
    can_abandon: false,
    reverse_bid: false,
  };
}

/** The tracked swap as the hook holds it once the expired bid was read. */
function expiredSwap(over: Partial<SidecarTrackedSwap> = {}): SidecarTrackedSwap {
  const offer = toTakerOffers([row(OFFER_UNANSWERED, MAKER_ASLEEP, "0.714400000000")])[0];
  return {
    // The handle exactly as SidecarConfirmModal builds it.
    bidId: BID,
    offerId: offer.offerId,
    sendCoin: offer.sendCoin,
    receiveCoin: offer.receiveCoin,
    sendAmount: "0.500000000000",
    receiveAmount: "0.69988801",
    createdAt: CREATED,
    payoutAddress: "ltc1qinventedpayout000000000000000000000",
    makerAddress: offer.makerAddress ?? null,
    // What the tracker learned.
    detail: expiredBidDetail(),
    stage: classifyBidState(31, "scriptless"),
    lastPolledAt: (CREATED + 3700) * 1000,
    error: null,
    ...over,
  };
}

function memoryLocalStorage(): void {
  const jar = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => jar.get(k) ?? null,
    setItem: (k: string, v: string) => void jar.set(k, String(v)),
    removeItem: (k: string) => void jar.delete(k),
  };
}

/** XMR -> LTC, 0.5 XMR, priced against the stubbed book. */
async function quoteXmrToLtc(book: BasicSwapOffer[]) {
  vi.mocked(api.fetchOffers).mockResolvedValue(book);
  return fetchSidecarQuote({ from: "XMR", to: "LTC", amount: "0.5", prices: PRICES });
}

beforeEach(() => {
  memoryLocalStorage();
  clearCooldowns();
  resetSidecarCoinCache();
  vi.mocked(api.fetchOffers).mockReset();
});

// ═══════════════════════════════════════════════════════════════════════
// The write: which address is cooled
// ═══════════════════════════════════════════════════════════════════════

describe("an unanswered bid cools the offer's maker", () => {
  it("not the address its own record names, which is this node's", () => {
    const swap = expiredSwap();
    expect(swap.stage.stage).toBe("cancelled");
    expect(swap.detail?.addr_from).toBe(OWN_BID_ADDR);

    const target = cooldownTargetForUnansweredBid(swap);
    expect(target).toEqual({ offerId: OFFER_UNANSWERED, makerAddress: MAKER_ASLEEP });
  });

  it("a swap with no maker on its handle cools its offer alone, never the bid's own address", () => {
    // A swap rehydrated from the node, or one whose offer carried no address.
    expect(cooldownTargetForUnansweredBid(expiredSwap({ makerAddress: undefined }))).toEqual({
      offerId: OFFER_UNANSWERED,
      makerAddress: null,
    });
    expect(cooldownTargetForUnansweredBid(expiredSwap({ makerAddress: "   " })).makerAddress).toBeNull();
    const rehydrated = activeSwapToTracked({
      bid_id: BID,
      offer_id: OFFER_UNANSWERED,
      created_at: CREATED,
      expire_at: CREATED + 3600,
      bid_state: "Expired",
      coin_from: "Litecoin",
      coin_to: "Monero",
      amount_from: "0.69988801",
      amount_to: "0.500000000000",
      addr_from: MAKER_ASLEEP,
      was_sent: true,
    });
    expect(cooldownTargetForUnansweredBid(rehydrated).makerAddress).toBeNull();
  });

  it("carries the maker from the offer: toTakerOffer copies addr_from", () => {
    const [t] = toTakerOffers([row(OFFER_UNANSWERED, MAKER_ASLEEP, "0.714400000000")]);
    expect(t.makerAddress).toBe(MAKER_ASLEEP);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The read: what the next quote and the automatic re-bid do with it
// ═══════════════════════════════════════════════════════════════════════

describe("the next quote after an unanswered bid", () => {
  /** The sleeping maker re-posted at the same, best, price; another maker sits behind. */
  const book = () => [
    row(OFFER_REPOSTED, MAKER_ASLEEP, "0.714400000000"),
    row(OFFER_OTHER_MAKER, MAKER_AWAKE, "0.716000000000"),
  ];

  it("goes to another maker, not the sleeping one under a new offer id", async () => {
    coolDown(cooldownTargetForUnansweredBid(expiredSwap()), COOLDOWN_REASON_EXPIRED);
    const q = await quoteXmrToLtc(book());
    // The real quote path ran: one book read, in the offerer's frame.
    expect(api.fetchOffers).toHaveBeenCalledTimes(1);
    expect(api.fetchOffers).toHaveBeenCalledWith(
      expect.objectContaining({ coin_from: "LTC", coin_to: "XMR" }),
    );
    expect(q.offer.offerId).toBe(OFFER_OTHER_MAKER);
    expect(q.offer.makerAddress).toBe(MAKER_AWAKE);
    expect(q.rankedOffers.map((o) => o.offerId)).toEqual([OFFER_OTHER_MAKER]);
    expect(api.swapSidecarPlaceBid).not.toHaveBeenCalled();
  });

  it("negative control: keyed on the bid's own record, the same book hands the sleeping maker back", async () => {
    // The old write, kept here so this suite can show it would go red.
    const swap = expiredSwap();
    coolDown({ offerId: swap.offerId, makerAddress: swap.detail?.addr_from ?? null }, COOLDOWN_REASON_EXPIRED);
    const q = await quoteXmrToLtc(book());
    expect(q.offer.offerId).toBe(OFFER_REPOSTED);
    expect(q.offer.raw.addr_from).toBe(MAKER_ASLEEP);
  });

  it("with no cool-down the sleeping maker's price wins, as a price-only ranking should", async () => {
    const q = await quoteXmrToLtc(book());
    expect(q.offer.offerId).toBe(OFFER_REPOSTED);
  });

  it("never empties a non-empty book: the cooled maker alone is still quoted", async () => {
    coolDown(cooldownTargetForUnansweredBid(expiredSwap()), COOLDOWN_REASON_EXPIRED);
    const q = await quoteXmrToLtc([row(OFFER_REPOSTED, MAKER_ASLEEP, "0.714400000000")]);
    expect(q.offer.offerId).toBe(OFFER_REPOSTED);
  });
});

describe("the automatic re-bid meets the cool-down it was meant to", () => {
  /** `attemptAutoRetry`'s own call, field for field. */
  async function decide() {
    const q = await quoteXmrToLtc([row(OFFER_REPOSTED, MAKER_ASLEEP, "0.714400000000")]);
    expect(q.spread.band).toBe("green");
    expect(q.spread.verified).toBe(true);
    return shouldAutoRetry({
      spread: q.spread,
      offer: {
        offerId: q.offer.offerId,
        tradable: q.offer.tradable,
        isExpired: q.offer.isExpired,
        isOwnOffer: q.offer.isOwnOffer,
        makerAddress: q.offer.raw?.addr_from ?? null,
      },
      cooldowns: loadCooldowns(),
      nowMs: Date.now(),
      sendAmount: q.sendAmount,
      approvedSendAmount: 0.5,
      attemptsSoFar: 0,
    });
  }

  it("refuses the sleeping maker's re-post when it is all the book has", async () => {
    coolDown(cooldownTargetForUnansweredBid(expiredSwap()), COOLDOWN_REASON_EXPIRED);
    const d = await decide();
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/went quiet/);
  });

  it("negative control: with the old key it would have re-bid the same maker", async () => {
    const swap = expiredSwap();
    coolDown({ offerId: swap.offerId, makerAddress: swap.detail?.addr_from ?? null }, COOLDOWN_REASON_EXPIRED);
    expect(isCooledDown(loadCooldowns(), { offerId: OFFER_REPOSTED, makerAddress: MAKER_ASLEEP }, Date.now())).toBe(false);
    const d = await decide();
    expect(d.proceed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Wiring
// ═══════════════════════════════════════════════════════════════════════

describe("wired: both placing paths carry the maker, and the hook cools it", () => {
  const hook = read("./useSidecarSwap.ts");

  it("the hook's cool-down uses the offer's maker, not the bid record", () => {
    const effect = hook.slice(
      hook.indexOf("const retriedRef = useRef"),
      hook.indexOf("const attemptAutoRetry = useCallback"),
    );
    expect(effect).toContain("coolDown(cooldownTargetForUnansweredBid(swap), COOLDOWN_REASON_EXPIRED);");
    expect(effect).not.toMatch(/makerAddress:\s*swap\.detail/);
  });

  it("the automatic re-bid's handle carries its offer's maker", () => {
    const retry = hook.slice(
      hook.indexOf("const attemptAutoRetry = useCallback"),
      hook.indexOf("const openTracker = useCallback"),
    );
    expect(retry).toMatch(/adopt\(\{[\s\S]*makerAddress: quote\.offer\.makerAddress \?\? null,[\s\S]*\}\);/);
  });

  it("the confirm modal's handle carries the reviewed offer's maker", () => {
    const modal = read("./SidecarConfirmModal.tsx");
    const submitted = modal.slice(modal.indexOf("onSubmitted({"), modal.indexOf("onClose();", modal.indexOf("onSubmitted({")));
    expect(submitted).toContain("makerAddress: book.offer.makerAddress ?? null,");
  });
});
