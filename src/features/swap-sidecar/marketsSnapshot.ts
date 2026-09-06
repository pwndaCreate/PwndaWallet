/**
 * src/features/swap-sidecar/marketsSnapshot.ts
 *
 * The public BasicSwap market snapshot — what the P2P DEX looks like right
 * now, readable **without a Particl node and without opting in**.
 *
 * # Why this exists
 *
 * Taking a P2P offer needs a synced Particl node: a bid is an SMSG message,
 * and there is no HTTP path to sending one. But *seeing* the market needs
 * nothing. Until this module, the Swap tab's P2P route and the EARN tab showed
 * a bare sentence ("the swap node is not enabled on this wallet") to anyone who
 * had not opted in — so the feature's shop window was an empty room, and a user
 * had to enable a background service on faith to find out whether the market
 * was worth anything.
 *
 * `markets.basicswapdex.com` scrapes the Particl SMSG network itself and
 * republishes the parsed offers as a static file. We read it to answer "is
 * there a market here, and what does it look like" before the user commits to
 * anything.
 *
 * # What this data is NOT
 *
 * **Not an order book you can trade against.** Three independent reasons, all
 * measured on 2026-08-28 and all still true of any snapshot:
 *
 *   1. **Revoked offers are not flagged.** The feed reports `revokes_seen: 3`
 *      alongside `revokes_matched_offer: 0` and `revoked_offers_dropped: 0` —
 *      it observes revocations but does not reconcile them against the offers
 *      it lists, and no field on an offer says "revoked". A dead offer can sit
 *      in the list looking exactly like a live one.
 *   2. **It is a snapshot, ~5 minutes old**, behind a 10-minute CDN cache.
 *   3. **It is a third party.** Not our node, not signed, not authenticated.
 *
 * So everything derived here is labelled as a preview in the UI, and none of it
 * may reach a quote, a spread gate, a confirmation, or any signing path. When
 * the user's own node is up, `/json/offers` through the sidecar is the
 * authority and this steps aside.
 *
 * # Why the numbers are recomputed instead of read
 *
 * The publisher's own aggregates disagree across its surfaces — the same
 * snapshot was rendered as "live offers 73" and "now 105 live" on one page,
 * with `$98K` and `$232K` liquidity in two places. And `active_offers: 93` is
 * not reproducible from the offer records: `timestamp + time_valid > now`
 * gives 85. Their definition of "active" is undocumented and not ours, so we
 * apply {@link isLive} and count it ourselves. A number we show is a number we
 * can defend.
 */
import { proxyGetJson } from "../../wallets/_proxy";

/** The published snapshot. HTTPS, no key, `access-control-allow-origin: *`. */
export const MARKETS_SNAPSHOT_URL =
  "https://markets.basicswapdex.com/orderbook.json";

/** Shown in the UI beside anything derived from it. Never omit the source. */
export const MARKETS_SNAPSHOT_HOST = "markets.basicswapdex.com";

/**
 * One offer, as the publisher emits it.
 *
 * This is the SMSG wire shape, **not** our {@link BasicSwapOffer}. The
 * differences are load-bearing and every one of them is a silent failure if
 * assumed away: `msg_id` not `offer_id`, `timestamp` not `created_at`, no
 * `expire_at` (compute from `time_valid`), no `is_revoked`/`is_expired`, and
 * `fee_rate_from` where ours says `feerate_from` — one underscore apart, which
 * type-checks as `undefined` and renders blank.
 */
export interface RawMarketOffer {
  msg_id?: unknown;
  timestamp?: unknown;
  coin_from?: unknown;
  coin_to?: unknown;
  amount_from_str?: unknown;
  amount_to_str?: unknown;
  time_valid?: unknown;
  addr_from?: unknown;
  amount_negotiable?: unknown;
  rate_negotiable?: unknown;
  min_bid_amount_str?: unknown;
  swap_type?: unknown;
}

/** One offer, normalised to what a preview surface can honestly render. */
export interface MarketOffer {
  /** The SMSG message id — this network's offer identity. */
  id: string;
  /** UPPERCASE ticker the maker is giving. */
  fromTicker: string;
  /** UPPERCASE ticker the maker wants. */
  toTicker: string;
  /**
   * Decimal STRINGS, straight from the feed's `_str` fields.
   *
   * The feed also carries `rate` as a JS number, and some are `2.4e-10`. This
   * codebase moves amounts as decimal strings and parses at the edge precisely
   * so a double never sits between a user and a number they act on; taking the
   * float here would walk that back for a cosmetic saving.
   */
  fromAmount: string;
  toAmount: string;
  /** Unix seconds the offer was posted. */
  postedAt: number;
  /** Unix seconds the offer stops being valid, per the maker's `time_valid`. */
  expiresAt: number;
  /** Maker's Particl address, for display truncation only. */
  maker: string;
  /** `A/B` with the two tickers sorted, so both directions share one key. */
  pairKey: string;
  /**
   * Smallest bid the maker accepts, in {@link fromTicker} units. Decimal
   * string. Falls back to the full amount when the feed omits it — treating an
   * absent minimum as "no minimum" would let the estimator pick an offer that
   * cannot actually be bid on.
   */
  minFromAmount: string;
  /** Upstream `SwapTypes` int; `5` is XMR_SWAP. Needed by `deriveBidReversed`. */
  swapType: number;
  amountNegotiable: boolean;
  rateNegotiable: boolean;
}

/** One pair, aggregated across the live offers on it. */
export interface MarketPair {
  /** `BTC/XMR`, tickers sorted. */
  pairKey: string;
  tickerA: string;
  tickerB: string;
  /** How many live offers touch this pair. */
  offerCount: number;
  /** Distinct makers on this pair. */
  makerCount: number;
  /** Newest offer's age in seconds — how fresh this pair is. */
  freshestAgeSec: number;
}

export interface MarketSnapshot {
  /** Unix seconds the publisher took the snapshot. */
  takenAt: number;
  /** Seconds between the snapshot and when we read it. */
  ageSec: number;
  /** Offers we judged live by {@link isLive}. */
  liveOffers: MarketOffer[];
  /** Live pairs, busiest first. */
  pairs: MarketPair[];
  /** Distinct makers across live offers. */
  makerCount: number;
  /** Distinct tickers quotable on the network right now, sorted. */
  tickers: string[];
  /**
   * What the publisher itself claimed, kept for the record and deliberately
   * NOT rendered — see the module header on why their counts are not ours.
   */
  publisherClaimed: { numOffers: number | null; activeOffers: number | null };
}

/** Thrown so callers can distinguish "unavailable" from "no market". */
export class MarketSnapshotError extends Error {}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Our liveness rule, stated once so the UI can state it too.
 *
 * `postedAt + time_valid > now`. This is NOT the publisher's `active_offers`
 * (measured: theirs 93, ours 85 on the same snapshot) and does not pretend to
 * be — theirs is undocumented. It is also **not** a claim the offer is takeable:
 * nothing here can see revocations. It only means the maker's own validity
 * window has not elapsed.
 */
export function isLive(offer: MarketOffer, nowSec: number): boolean {
  return offer.expiresAt > nowSec;
}

/** `BTC/XMR` — sorted, so BTC→XMR and XMR→BTC aggregate together. */
export function pairKeyFor(a: string, b: string): string {
  return [a.toUpperCase(), b.toUpperCase()].sort().join("/");
}

/**
 * Normalise one raw record, or `null` if it is unusable.
 *
 * Drops rather than defaults. A preview that renders an offer with a blank
 * ticker or a zero amount is worse than one that renders fewer offers, because
 * the blank looks like a fact about the market.
 */
export function normalizeOffer(raw: RawMarketOffer): MarketOffer | null {
  const id = str(raw.msg_id);
  const fromTicker = str(raw.coin_from)?.toUpperCase() ?? null;
  const toTicker = str(raw.coin_to)?.toUpperCase() ?? null;
  const fromAmount = str(raw.amount_from_str);
  const toAmount = str(raw.amount_to_str);
  const postedAt = num(raw.timestamp);
  const timeValid = num(raw.time_valid);
  if (
    !id ||
    !fromTicker ||
    !toTicker ||
    !fromAmount ||
    !toAmount ||
    postedAt == null ||
    timeValid == null
  ) {
    return null;
  }
  return {
    id,
    fromTicker,
    toTicker,
    fromAmount,
    toAmount,
    postedAt,
    expiresAt: postedAt + timeValid,
    maker: str(raw.addr_from) ?? "",
    pairKey: pairKeyFor(fromTicker, toTicker),
    minFromAmount: str(raw.min_bid_amount_str) ?? fromAmount,
    swapType: num(raw.swap_type) ?? 5,
    amountNegotiable: raw.amount_negotiable === true,
    rateNegotiable: raw.rate_negotiable === true,
  };
}

/**
 * Turn a parsed payload into a snapshot.
 *
 * Split from the fetch so it can be tested against a captured body, and so a
 * shape change upstream fails in one identifiable place. The publisher offers
 * no schema version and no changelog, so a rename ships silently — hence the
 * explicit throw rather than an empty result: "the market has no offers" and
 * "we could not read the market" must never render the same way.
 */
export function parseSnapshot(
  payload: unknown,
  nowSec: number,
): MarketSnapshot {
  if (!payload || typeof payload !== "object") {
    throw new MarketSnapshotError("market snapshot was not an object");
  }
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.offers)) {
    throw new MarketSnapshotError(
      "market snapshot has no `offers` array — the publisher's schema may have changed",
    );
  }

  const takenAt = num(p.timestamp) ?? nowSec;
  const liveOffers = (p.offers as RawMarketOffer[])
    .map(normalizeOffer)
    .filter((o): o is MarketOffer => o != null)
    .filter((o) => isLive(o, nowSec));

  const byPair = new Map<string, MarketOffer[]>();
  for (const o of liveOffers) {
    const list = byPair.get(o.pairKey);
    if (list) list.push(o);
    else byPair.set(o.pairKey, [o]);
  }

  const pairs: MarketPair[] = [...byPair.entries()]
    .map(([pairKey, list]) => {
      const [tickerA, tickerB] = pairKey.split("/");
      return {
        pairKey,
        tickerA,
        tickerB,
        offerCount: list.length,
        makerCount: new Set(list.map((o) => o.maker).filter(Boolean)).size,
        freshestAgeSec: Math.max(
          0,
          nowSec - Math.max(...list.map((o) => o.postedAt)),
        ),
      };
    })
    // Busiest first; ties broken by name so the order is stable between polls
    // and a pair does not jump around while the user is reading it.
    .sort((a, b) => b.offerCount - a.offerCount || a.pairKey.localeCompare(b.pairKey));

  return {
    takenAt,
    ageSec: Math.max(0, nowSec - takenAt),
    liveOffers,
    pairs,
    makerCount: new Set(liveOffers.map((o) => o.maker).filter(Boolean)).size,
    tickers: [
      ...new Set(liveOffers.flatMap((o) => [o.fromTicker, o.toTicker])),
    ].sort(),
    publisherClaimed: {
      numOffers: num(p.num_offers),
      activeOffers: num(p.active_offers),
    },
  };
}

/**
 * Fetch and parse the snapshot.
 *
 * Goes through `proxyGetJson` → `http_proxy_call` → reqwest in Rust, NOT the
 * renderer's `fetch`. The endpoint sends `access-control-allow-origin: *` and
 * a direct call would work, so this is a deliberate choice: the backend path
 * sends no Origin header, attaches no cookies or credentials, keeps a
 * third-party host out of the webview's own network activity, and is the
 * reason routing this over a privacy proxy later is a change in one Rust
 * module rather than a frontend rewrite.
 *
 * The host must be on `http_proxy.rs`'s allowlist or this is refused before
 * any packet leaves — that refusal is the intended behaviour, not a bug.
 */
export async function fetchMarketSnapshot(
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<MarketSnapshot> {
  let payload: unknown;
  try {
    payload = await proxyGetJson<unknown>(MARKETS_SNAPSHOT_URL, {
      Accept: "application/json",
    });
  } catch (e) {
    throw new MarketSnapshotError(
      e instanceof Error ? e.message : String(e ?? "market snapshot fetch failed"),
    );
  }
  return parseSnapshot(payload, nowSec);
}

/** `Pprz…AZR7` — the publisher's own truncation, matched for recognisability. */
export function shortMaker(addr: string): string {
  if (addr.length <= 9) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/** `3m` / `2h` / `4d`, for offer age and snapshot age alike. */
export function shortAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Adapt a public-snapshot offer into the shape the taker pipeline speaks.
 *
 * # Why adapt instead of writing a second ranker
 *
 * The route estimator has to price the XMR leg from an order book, and there
 * are two books: the public snapshot (no opt-in) and the user's own node
 * (opted in). Writing a ranking/fill path for the snapshot would mean two
 * implementations of "which offer would actually fill this size" that must
 * agree forever — and the day they diverge, the number the Mine tab shows a
 * non-opted-in user stops matching what they get after opting in. That is the
 * worst possible place for a discrepancy, because opting in is the exact
 * action the number is arguing for.
 *
 * So the snapshot is adapted UP into `BasicSwapOffer` and both sources run
 * through `toTakerOffers` → `rankOffers` → `pickOfferForSendAmount`
 * identically. One ranker, one fill rule, one place for a bug.
 *
 * # The fields that cannot be faked, and are not
 *
 * `is_revoked` is set **false** because the feed genuinely cannot see
 * revocations (`revokes_matched_offer: 0`). That is a limitation of the data,
 * not an assertion about the offer, and every surface built on a snapshot
 * estimate has to say so — which is why `RouteEstimate` carries its source and
 * the UI prints it. Marking them all revoked would be equally wrong and would
 * simply empty the book.
 *
 * `addr_to` is empty (the feed omits it) and is not read by the taker path.
 */
export function marketOfferToBasicSwapOffer(
  o: MarketOffer,
  nowSec: number,
): import("../../api/basicswap").BasicSwapOffer {
  return {
    offer_id: o.id,
    swap_type: o.swapType,
    addr_from: o.maker,
    addr_to: "",
    created_at: o.postedAt,
    expire_at: o.expiresAt,
    coin_from: o.fromTicker,
    coin_to: o.toTicker,
    amount_from: o.fromAmount,
    amount_to: o.toAmount,
    // Left to the taker pipeline to derive from the amounts: the feed's own
    // `rate` is a float (some are 2.4e-10) and this codebase carries prices as
    // decimal strings for exactly that reason.
    rate: "",
    min_bid_amount: o.minFromAmount,
    is_expired: o.expiresAt <= nowSec,
    // Not "we checked and it is live" — see the header. The snapshot has no
    // revocation view at all.
    is_revoked: false,
    // A public snapshot only ever contains other people's public offers.
    is_own_offer: false,
    is_public: true,
    amount_negotiable: o.amountNegotiable,
    rate_negotiable: o.rateNegotiable,
  } as import("../../api/basicswap").BasicSwapOffer;
}
