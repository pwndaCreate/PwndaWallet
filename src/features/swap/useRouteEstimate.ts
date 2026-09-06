/**
 * src/features/swap/useRouteEstimate.ts
 *
 * Feeds {@link estimateRoute} from whichever order book the user is entitled
 * to, and hands the result to the EARN tab and the Mine tab's hero.
 *
 * # Source selection is the whole job
 *
 *   - **opted into the swap node** → the node's own `/json/offers`.
 *     Authoritative: current, revocation-aware, and the book they would
 *     actually bid into.
 *   - **not opted in** → the public `markets.basicswapdex.com` snapshot,
 *     adapted into the same offer shape.
 *
 * The estimate is produced EITHER WAY, on purpose. A user deciding whether to
 * turn on a background service, download a runtime and sync a chain deserves
 * to see what the conversion would return first — that is the operator's
 * stated reason for this feature ("so they can see what they would get"). The
 * gate belongs on the ACTION, not on the information: EARN renders the number
 * and disables its button until opt-in.
 *
 * # Why not fall back to the snapshot when a live read fails
 *
 * Silently substituting a public, minutes-old, revocation-blind book for the
 * user's own would change what the number means without changing how it looks.
 * An opted-in user reads their number as "what my node can do right now". So a
 * failed live read reports a failure and the surface says so, rather than
 * quietly answering a different question.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BasicSwapCoin, BasicSwapOffer } from "../../api/basicswap";
import { fetchCoins, fetchOffers, isApiError } from "../../api/basicswap";
import {
  fetchMarketSnapshot,
  marketOfferToBasicSwapOffer,
} from "../swap-sidecar/marketsSnapshot";
import {
  ROUTE_HOPS,
  ROUTE_SOURCE,
  estimateHop1,
  estimateRoute,
  type RouteEstimateFailure,
  type RouteEstimateResult,
  type RouteHop,
  type RouteSource,
} from "./routeEstimate";
import { CONVERT_ROUTE_HOP } from "./useConvertPipeline";
import { bucketAmount, quoteHop2 } from "./hop2Quote";

/**
 * The intermediates the convert pipeline can currently execute.
 *
 * Derived from `CONVERT_ROUTE_HOP` rather than written out, so adding BCH to
 * the pipeline widens the estimate in the same edit instead of leaving the two
 * to disagree — which is exactly what happened when the estimator gained BCH
 * on 2026-08-28 while `beginHop1` still seeded XMR->LTC only.
 */
export const CONVERT_PIPELINE_HOPS: readonly RouteHop[] = [
  CONVERT_ROUTE_HOP as RouteHop,
];

/**
 * How long a fetched book is reused.
 *
 * The public snapshot regenerates about every 5 minutes behind a 10-minute
 * CDN cache, so re-reading faster cannot produce fresher data. The live book
 * moves faster, but this drives a PROJECTION, not a quote — the real numbers
 * come from `fetchSidecarQuote` at confirm time. 60s satisfies the handoff's
 * "cache ≤ 60s" for both.
 */
export const BOOK_TTL_MS = 60_000;

interface Books {
  /**
   * True when the live read failed and this is the public snapshot standing
   * in. Surfaced so the UI can say so rather than passing a third party's
   * book off as the node's own.
   */
  fellBackFromLive?: boolean;
  offersByHop: Partial<Record<RouteHop, BasicSwapOffer[]>>;
  coins: readonly BasicSwapCoin[] | null;
  source: RouteSource;
  bookAgeSec: number;
  at: number;
  failure: RouteEstimateFailure | null;
}

/** Split a flat offer list into the per-intermediate books the estimator wants. */
function bucketByHop(
  offers: readonly BasicSwapOffer[],
): Partial<Record<RouteHop, BasicSwapOffer[]>> {
  const out: Partial<Record<RouteHop, BasicSwapOffer[]>> = {};
  for (const hop of ROUTE_HOPS) {
    const forHop = offers.filter((o) => {
      const a = String(o.coin_from ?? "").toUpperCase();
      const b = String(o.coin_to ?? "").toUpperCase();
      // Either direction — `filterOffersForDirection` decides takeability;
      // this only narrows to the pair.
      return (
        (a.includes(hop) && b.includes(ROUTE_SOURCE)) ||
        (a.includes(ROUTE_SOURCE) && b.includes(hop))
      );
    });
    if (forHop.length) out[hop] = forHop;
  }
  return out;
}

/**
 * Read the live book, ONE REQUEST PER PAIR.
 *
 * # The bug this replaced
 *
 * This used to be a single unfiltered `fetchOffers({sort_by:'rate'})`. That
 * endpoint pages at `OFFERS_PAGE_LIMIT = 50` and no offset was passed, so it
 * read the first 50 offers **on the whole network, across every pair** and
 * then filtered them client-side for XMR/LTC. With ~160 live offers spread
 * over 15 pairs, a rate-sorted page of 50 can easily contain no XMR/LTC row
 * at all — and the estimator then reported the book unreadable on a node that
 * had read it perfectly.
 *
 * `fetchSidecarQuote` had this right the whole time and this did not copy it:
 * pass `coin_from`/`coin_to` and the engine filters SERVER-side, so all 50
 * rows are for the pair being priced. One request per allowed hop — currently
 * one, since the pipeline runs XMR->LTC only.
 *
 * The filter speaks the OFFERER's frame: `coin_from` is what the offerer
 * sends, i.e. what the taker RECEIVES. Getting it backwards returns the other
 * side of the book — offers that look like better prices and cannot be taken
 * from this side at all.
 */
async function loadLiveBooks(hops: readonly RouteHop[]): Promise<Books> {
  // Advisory, exactly as `loadCoins` treats it inside the taker flow: without
  // the table `toTakerOffers` falls back to the static decimals map, and a
  // missing coin table must not fail an estimate.
  let coins: readonly BasicSwapCoin[] | null = null;
  try {
    const c = await fetchCoins();
    coins = isApiError(c) || !Array.isArray(c) ? null : c;
  } catch {
    coins = null;
  }

  const offersByHop: Partial<Record<RouteHop, BasicSwapOffer[]>> = {};
  let anyRead = false;
  let anyFailed = false;

  for (const hop of hops) {
    try {
      const raw = await fetchOffers({
        coin_from: hop,
        coin_to: ROUTE_SOURCE,
        sort_by: "rate",
        sort_dir: "asc",
      });
      if (isApiError(raw) || !Array.isArray(raw)) {
        anyFailed = true;
        continue;
      }
      anyRead = true;
      if (raw.length) offersByHop[hop] = raw;
    } catch {
      anyFailed = true;
    }
  }

  return {
    offersByHop,
    coins,
    source: "live-node",
    // The node's book is read live, so it has no staleness to declare.
    bookAgeSec: 0,
    at: Date.now(),
    /**
     * `no-book` means the READ failed — not that the read succeeded and found
     * nothing. Those are different facts and the operator hit the confusion
     * directly: "why is the estimator saying that the order book could not be
     * read if my swap node is synced?" It had been read; there was simply
     * nothing on this pair in it.
     */
    failure: anyRead ? null : anyFailed ? "no-book" : "empty-book",
  };
}

async function loadSnapshotBooks(): Promise<Books> {
  try {
    const snap = await fetchMarketSnapshot();
    const nowSec = Math.floor(Date.now() / 1000);
    const adapted = snap.liveOffers.map((o) =>
      marketOfferToBasicSwapOffer(o, nowSec),
    );
    return {
      offersByHop: bucketByHop(adapted),
      // The public feed carries no `/json/coins` table. `toTakerOffers` falls
      // back to `COIN_NAME_TO_TICKER` + `DEFAULT_COIN_DECIMALS`, which covers
      // XMR/LTC/BCH; a coin absent from that table simply does not rank.
      coins: null,
      source: "public-snapshot",
      bookAgeSec: snap.ageSec,
      at: Date.now(),
      failure: null,
    };
  } catch {
    return {
      offersByHop: {},
      coins: null,
      source: "public-snapshot",
      bookAgeSec: 0,
      at: Date.now(),
      failure: "no-book",
    };
  }
}
/**
 * Book cache, MODULE-level and keyed by source.
 *
 * It was per-hook-instance until 2026-08-28, which meant every mount started
 * from `null` and refetched: opening Mine, switching to Wallet and coming
 * back re-read the whole order book, and the hero sat on a dash for a round
 * trip each time. That is most of what "make it pop up faster" was about.
 *
 * Keyed by source because the live book and the public snapshot are different
 * answers to the same question — opting in must not serve a cached snapshot as
 * though it were the node's own book.
 */
const bookCache = new Map<RouteSource, Books>();
let bookInFlight: Promise<Books> | null = null;

/** Test seam. */
export function __resetRouteBookCache(): void {
  bookCache.clear();
  bookInFlight = null;
}

export interface RouteEstimateState extends RouteEstimateResult {
  loading: boolean;
  /** The live read failed and the public snapshot is standing in. */
  fellBackFromLive: boolean;
  /** Which book answered — surfaced so the UI can name it. */
  source: RouteSource;
  refresh: () => void;
}

export function useRouteEstimate(args: {
  enabled: boolean;
  /** `true` once the user has opted into running a node. */
  optedIn: boolean;
  sourceAmount: number | null;
  targetTicker: string;
  prices: Record<string, number>;
  /**
   * Resolves a wallet address for a NEAR asset id — needed so the dry hop-2
   * quote comes back in the same shape a real one would. Absent means hop 2
   * is not quoted and the estimate falls back to the price cross, labelled.
   */
  addressForAsset?: (assetId: string) => string;
  /**
   * Intermediates the conversion can actually run through.
   *
   * Defaults to `CONVERT_PIPELINE_HOPS`, which is what
   * `useConvertPipeline.beginHop1` will actually seed. The estimator can
   * price BCH, and does in its own tests — but quoting a route the CONVERT
   * button will not take is a promise the product cannot keep, so the
   * capability stays behind the pipeline until the pipeline can execute it.
   */
  allowedHops?: readonly RouteHop[];
}): RouteEstimateState {
  const { enabled, optedIn, sourceAmount, targetTicker, prices } = args;
  const allowedHops = args.allowedHops ?? CONVERT_PIPELINE_HOPS;
  const { addressForAsset } = args;

  /**
   * Hop-2 quotes, resolved asynchronously and read synchronously.
   *
   * `estimateRoute` is pure and stays that way; the async fetch and its
   * 20-minute cache live in `hop2Quote.ts`, and this holds the resolved
   * answers so the estimator can consult them without becoming async itself.
   * A miss simply means the estimate uses the price cross this round and
   * upgrades to `quoted` on a later render.
   */
  const [hop2, setHop2] = useState<Record<string, number | null>>({});

  /**
   * Quote requests already issued, so the effect is IDEMPOTENT.
   *
   * Belt and braces after the 2026-08-29 render loop. The loop's cause was an
   * unstable dependency, and that is fixed — but an effect that fires a
   * request and then setStates is one bad dependency away from doing it again,
   * and the symptom (frozen window, ~600 MB) is severe enough to be worth
   * making structurally impossible rather than merely currently-absent.
   *
   * Keyed by hop + target + amount bucket, matching `quoteHop2`'s own cache
   * key, so a re-render at the same size is a no-op rather than a request.
   */
  const requested = useRef(new Set<string>());
  const source: RouteSource = optedIn ? "live-node" : "public-snapshot";
  // Seeded from the module cache so a remount inside the TTL paints a number
  // on the FIRST render instead of after a round trip.
  const [books, setBooks] = useState<Books | null>(() => {
    const hit = bookCache.get(source);
    return hit && Date.now() - hit.at < BOOK_TTL_MS ? hit : null;
  });
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      const hit = bookCache.get(source);
      if (!force && hit && Date.now() - hit.at < BOOK_TTL_MS) {
        setBooks(hit);
        return;
      }
      // One fetch across every mounted consumer, not one each.
      if (bookInFlight) {
        setLoading(true);
        try {
          setBooks(await bookInFlight);
        } finally {
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      bookInFlight = (
        source === "live-node"
          ? loadLiveBooks(allowedHops).then(async (live) => {
              /**
               * Fall back to the public snapshot when the live READ fails.
               *
               * This reverses the earlier no-fallback rule, on the operator's
               * instruction: "could the website data be fetched and
               * aggregated ... and then every subsequent check will see if
               * the swap node orderbook could be read, if it cant then it
               * will keep doing the website fetcher." Showing a labelled
               * public number beats showing nothing.
               *
               * The earlier objection — that swapping the source silently
               * changes what the number means — is answered by LABELLING
               * rather than by refusing: `RouteEstimate.source` and
               * `bookAgeSec` ride all the way to the UI, which names the book
               * it priced from. What must never happen is a snapshot number
               * PRESENTED as the node's own, and that is a display property,
               * not a reason to withhold the estimate.
               *
               * Only a failed READ falls back. A successful read of an EMPTY
               * pair does not: that is the node's real answer about a real
               * book, and substituting a third party's view of a different
               * moment would be answering a different question.
               */
              if (live.failure !== "no-book") return live;
              const snap = await loadSnapshotBooks();
              return snap.failure ? live : { ...snap, fellBackFromLive: true };
            })
          : loadSnapshotBooks()
      )
        .then((next) => {
          bookCache.set(source, next);
          return next;
        })
        .finally(() => {
          bookInFlight = null;
        });
      try {
        setBooks(await bookInFlight);
      } finally {
        setLoading(false);
      }
    },
    [source],
  );

  useEffect(() => {
    if (!enabled) return;
    void load(false);
    // Re-read when the entitlement changes: opting in must switch the number
    // over to the user's own book rather than leave a snapshot estimate on
    // screen looking authoritative.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, source]);

  /**
   * Fire the hop-2 quote for whatever hop 1 can actually produce.
   *
   * Gated on `enabled` and on having a size, and rate-limited inside
   * `quoteHop2` — the operator's "cache and rate limit each poll" applies to
   * the upstream call, not to this effect, which is cheap and idempotent.
   */
  useEffect(() => {
    if (!enabled || !addressForAsset) return;
    if (sourceAmount == null || sourceAmount <= 0) return;
    if (!books || books.failure) return;
    let cancelled = false;
    for (const hop of allowedHops) {
      if (targetTicker === hop) continue;
      const offers = books.offersByHop[hop];
      if (!offers?.length) continue;
      /**
       * Quote on hop 1's OUTPUT, not on the source amount.
       *
       * The first cut passed `sourceAmount` — an XMR figure — as the amount of
       * LTC to sell, which quotes an unrelated size and would have produced a
       * confidently wrong second leg. `estimateHop1` is exported precisely so
       * the hop-1 output can be computed here, before the full estimate runs;
       * it comes from the order book and is exact regardless of how hop 2 ends
       * up being priced.
       */
      const h1 = estimateHop1({
        offers,
        coins: books.coins,
        sendAmount: sourceAmount,
        hop,
      });
      if (!h1 || "failure" in h1) continue;
      const stateKey = `${hop}/${targetTicker}`;
      // Same bucketing `quoteHop2` uses, so "already asked at this size" means
      // the same thing on both sides of the call.
      const askKey = `${stateKey}/${bucketAmount(h1.receiveAmount)}`;
      if (requested.current.has(askKey)) continue;
      requested.current.add(askKey);
      void quoteHop2({
        fromTicker: hop,
        toTicker: targetTicker,
        amount: h1.receiveAmount,
        addressFor: addressForAsset,
      }).then((out) => {
        if (cancelled) return;
        setHop2((prev) => {
          // Bail on an unchanged value. `{...prev, k: v}` allocates a new
          // object even when nothing changed, and a new state object is a
          // re-render — which is the fuel a loop runs on.
          if (prev[stateKey] === out) return prev;
          return { ...prev, [stateKey]: out };
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, addressForAsset, sourceAmount, targetTicker, books, allowedHops]);

  /**
   * Stable identity — see App's `addressForAssetStable` for the render loop
   * an inline arrow here produced. This one is a dependency of
   * `useMiningProjection`'s memo, so a fresh identity per render rebuilt the
   * projection object every render and re-rendered every consumer of it.
   */
  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const result = useMemo<RouteEstimateResult>(() => {
    if (!books) return { estimate: null, failure: null };
    if (books.failure) return { estimate: null, failure: books.failure };
    if (sourceAmount == null || sourceAmount <= 0) {
      return { estimate: null, failure: "invalid-amount" };
    }
    return estimateRoute({
      sourceAmount,
      targetTicker,
      allowedHops,
      offersByHop: books.offersByHop,
      coins: books.coins,
      prices,
      source: books.source,
      bookAgeSec: books.bookAgeSec,
      // The quote was taken on this same hop-1 output (see the effect), so it
      // is used as-is. `amountIn` is accepted only to assert that agreement
      // rather than to rescale — a quote for a different size would be a
      // different quote, and pretending otherwise is how a second leg becomes
      // confidently wrong.
      hop2QuotedOut: (hop, amountIn) =>
        amountIn > 0 ? (hop2[`${hop}/${targetTicker}`] ?? null) : null,
    });
  }, [books, sourceAmount, targetTicker, prices, allowedHops, hop2]);

  return {
    ...result,
    fellBackFromLive: books?.fellBackFromLive === true,
    loading: loading && !books,
    source: books?.source ?? source,
    refresh,
  };
}
