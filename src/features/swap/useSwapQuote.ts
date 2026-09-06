/**
 * Debounced swap-quote hook for the cross-chain swap form.
 *
 *   - Debounces on (from, to, amount, slippage, preferredRouter) for 500 ms.
 *   - Re-quotes every 30 s while the user stays on the screen.
 *   - Routing dispatch:
 *       'swapkit'  → getSwapKitQuote only
 *       'intents'  → getIntentsQuote only
 *       'auto'     → quoteDual (parallel), pick the larger expectedReceive
 *   - Returns a unified `NormalizedQuote` that carries which upstream
 *     answered (`source`), whether SwapKit's response is the mock-server
 *     placeholder UUID (`mockDetected`), and a single normalized fee/eta
 *     view so the form can render either source identically.
 *
 * The hook does NOT itself call the build/sign path; that lives on the
 * Swap button click in the SwapView. This hook is read-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getIntentsQuote, getSwapKitQuote } from "../../api/proxy";
import type {
  IntentsQuote,
  IntentsQuoteResponse,
  SwapKitQuoteResponse,
  SwapKitRoute,
} from "../../lib/proxy-types";
import {
  SWAP_COIN_META,
  getSwapCoinMeta,
  isIntentsRoutable,
  isSwapKitRoutable,
  type SwapCoinMeta,
} from "./swap-data";
import type { IntentsBlockchain } from "./near-intents-assets.generated";
import {
  getCachedNearIntentsTokens,
  getNearIntentsTokens,
  lookupTokenByAssetId,
  type NearIntentsToken,
} from "./near-intents-tokens";
import {
  IntentsValidationError,
  addressForAssetId,
  type WalletAddresses,
} from "./asset-address-resolver";
import { decimalToBaseUnitsBigInt } from "./swap-sources";
import {
  assertDisplayedAmountReasonable,
  formatAtomicForDisplay,
} from "./safety-invariants";
import {
  getPairMinimum,
  getPairMinimumEntry,
  parseMinAtomicFromUpstreamError,
  setPairMinimum,
} from "./intents-pair-min-cache";
import {
  bisectExactInputMinimum,
  FLOOR_PROBE_WAIT_MS,
  probeExactInputFallback,
  probePairFloor,
  probePerPairMinimum,
} from "./intents-pair-min-probe";

/** When `VITE_DEBUG_QUOTE === "true"` (set in `.env.local`), the hook
 *  logs each outgoing quote-request body to the console AND stashes it
 *  on `window.__lastIntentsBody` / `window.__lastSwapKitBody`. The
 *  globals let a developer grab the body without hunting through
 *  console output:
 *
 *    > copy(__lastIntentsBody)        ← copies pretty-printed JSON to clipboard
 *    > __lastIntentsBody              ← inspect interactively
 *
 *  Off by default to avoid leaking addresses + amounts into the
 *  production log. */
function debugQuote(label: string, payload: unknown): void {
  if (import.meta.env.VITE_DEBUG_QUOTE !== "true") return;
  // eslint-disable-next-line no-console
  console.log(`[QUOTE-DEBUG] ${label}`, payload);
  // Stash on window so a one-liner `copy(__lastIntentsBody)` in
  // devtools puts the body on the clipboard.
  const body = (payload as { body?: unknown })?.body;
  if (body && typeof window !== "undefined") {
    if (label.startsWith("intents")) {
      (window as unknown as { __lastIntentsBody?: unknown }).__lastIntentsBody = body;
    } else if (label.startsWith("swapkit")) {
      (window as unknown as { __lastSwapKitBody?: unknown }).__lastSwapKitBody = body;
    }
    // Always set a generic "last body of any kind" so the user only has
    // to remember one variable name.
    (window as unknown as { __lastQuoteBody?: unknown }).__lastQuoteBody = body;
    // Also pretty-print a one-liner with a tag the user can grep for.
    // eslint-disable-next-line no-console
    console.log(
      `[QUOTE-COPY] ${label} — paste this back, OR run \`copy(__lastQuoteBody)\` to clipboard:`,
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(body, null, 2));
  }
}
import {
  ROUTER_MODES,
  isMockSwapKitResponse,
  type RouterPreference,
  type RouterSource,
} from "./router-modes";
import {
  deskQuote as fetchDeskQuote,
  type DeskQuote,
} from "../../api/desk-rust";
import {
  deskDirectionFor,
  deskPairLabel,
  isDeskRoutableFromRegistry,
} from "./asset-capabilities";
// Cross-feature import into `swap-sidecar`. The BasicSwap route's I/O, its
// price-only ranking and its spread gate all live in that feature because they
// are shared with the Settings-side sidecar surfaces; duplicating them here to
// satisfy a folder rule would fork the safety core, which is the one module
// that must have exactly one implementation. `swap-sidecar` publishes no
// `index.ts` yet — when it does, retarget these two imports at it.
import {
  fetchSidecarQuote,
  isBasicswapRoutable,
  SidecarQuoteError,
  type SidecarQuote,
} from "../swap-sidecar/useSidecarSwap";
import { formatAmount } from "../swap-sidecar/types";

export interface NormalizedQuote {
  /** Which upstream answered. `auto` mode resolves to one or the other. */
  source: RouterSource;
  /** Display name for the upstream (e.g. "SwapKit", "NEAR Intents"). */
  routerLabel: string;
  /** Sub-provider tag (e.g. "THORCHAIN", "Chainflip", "solver-relay"). */
  providerName: string;
  /** True when the SwapKit response carries the mock server's UUID — the
   *  UI uses this to force the yellow banner regardless of env config. */
  mockDetected: boolean;

  /** SwapKit route (when source === 'swapkit'). */
  swapKitRoute?: SwapKitRoute;
  /** NEAR Intents quote (when source === 'intents'). */
  intentsQuote?: IntentsQuote;
  /** Swap-desk quote (when source === 'pwnda-desk'). */
  deskQuote?: DeskQuote;
  /**
   * Local BasicSwap book result (when source === 'basicswap'). Carries the
   * chosen offer, the whole price-ranked book slice, the local validation
   * mirror and — load-bearing — the spread assessment the confirm modal
   * gates on. The confirm modal must read the band from HERE rather than
   * recomputing it, so the number the user was shown is the number that
   * gated them.
   */
  basicswapQuote?: SidecarQuote;

  /**
   * Hard expiry for this quote, unix SECONDS. Undefined means the upstream
   * gives no expiry (SwapKit and 1Click both do today).
   *
   * The desk DOES set it — its quotes live 30-120s — and the hook pauses its
   * background refresh while a confirm modal is open, so a desk quote can
   * lapse on screen. Anything about to act on a quote must re-check this
   * rather than trusting that a rendered quote is still valid.
   */
  expiresAt?: number;

  /** Display amount the user receives, in destination units (decimal string). */
  expectedReceive: string;
  /** After-slippage minimum (decimal string). */
  minReceived: string;
  /** Aggregated fees in source units. */
  totalFeesSource: string;
  /** Affiliate fee in source units. 0 today. */
  affiliateFeeSource: string;
  /** Total estimated time in seconds. */
  etaSeconds: number;
  /** Pretty-formatted "~Xm Ys" or "~Xs". */
  etaPretty: string;
  /** Provider warnings to surface. */
  warnings: string[];
}

export interface SwapQuoteState {
  loading: boolean;
  quote: NormalizedQuote | null;
  error: string | null;
  rawSwapKit: SwapKitQuoteResponse | null;
  rawIntents: IntentsQuoteResponse | null;
  rawDesk: DeskQuote | null;
  fetchedAt: string | null;
  refetch: () => void;
  /**
   * Re-quote the desk and RETURN the fresh quote.
   *
   * Distinct from `refetch` for two reasons. `refetch` is `() => void`, and
   * React state written inside it is not readable by the caller in the same
   * closure — but the confirm flow needs the new quote *in hand* to accept
   * against it. And a desk quote can lapse while the confirm modal is open
   * (the background refresh is paused there, and desk TTLs are 30-120s), so
   * this is the escape hatch that re-prices immediately before committing.
   *
   * Returns null when the pair isn't desk-routable or the desk declines.
   */
  requoteDesk: () => Promise<NormalizedQuote | null>;
  /**
   * Ask NEAR for this pair's minimum on demand, with a schedule that starts
   * where the automatic probe's ends ($10 → $400). Behind the MIN button
   * (2026-09-04): the automatic probe tops out at $5, so a pair whose floor
   * is higher — ADA → LTC on the day — reported no minimum and MIN sat
   * greyed out while a $200 quote was live. Resolves to the display amount
   * in the source coin, or null when nothing up to $400 filled.
   */
  probeMinimumNow: (
    hiAmountDisplay?: string,
  ) => Promise<{ amount: string | null; detail: string | null }>;
  /**
   * Effective NEAR Intents minimum for the currently-selected source
   * asset + pair. Form renders this as the inline hint below YOU SEND
   * and uses `belowMinimum` to gate the Swap button.
   *
   * `source` says where the value came from:
   *   - `"probe"` — adaptive descending EXACT_OUTPUT probe found a
   *     viable level. `expectedAmountOutUsd` carries the destination
   *     dollar value so the hint can render the USD anchor sub-line.
   *   - `"upstream-error"` — parsed from a real-quote rejection (the
   *     existing reactive path).
   *   - `"loading"` — probe is in flight; render a placeholder hint.
   *
   * Null when no minimum is known and no probe is in flight (e.g. the
   * pair isn't NEAR-Intents-routable).
   */
  intentsMinimum: {
    displayAmount: string;
    ticker: string;
    source: "probe" | "upstream-error" | "loading";
    /** Destination USD value the minimum was derived against (probe
     *  entries only). Used to render "(receives ~$X of TICKER)". */
    expectedAmountOutUsd?: string;
    /** USD-equivalent of `displayAmount` itself, at the source asset's
     *  live price from the tokens cache — "this 87 POL is worth ~$6.16".
     *  Independent of which mechanism produced the atomic minimum (probe
     *  or reactive parse); undefined only when the source token's price
     *  isn't cached yet. */
    minimumUsd?: string;
    /** Display name of the destination asset for the hint copy
     *  ("for ETH → BTC"). */
    destinationDisplayName?: string;
  } | null;
  /**
   * True when the user's typed amount is BELOW `intentsMinimum`.
   * Form uses this to disable the Swap button + show a red below-min
   * hint without re-doing the comparison itself.
   */
  belowMinimum: boolean;
}

interface UseSwapQuoteArgs {
  from: string;
  to: string;
  amount: string;
  slippage?: number;
  /** 'auto' | 'swapkit' | 'intents'. Defaults to 'intents'. */
  preferredRouter?: RouterPreference;
  /** Source-chain address for the SwapKit quote (`sourceAddress` field).
   *  SwapKit allows callers to omit this and just route by asset id;
   *  Intents does not — Intents recipient/refundTo come from the
   *  `walletAddresses` bundle below. */
  sourceAddress?: string;
  destinationAddress?: string;
  /** All known per-chain addresses for the user, sourced from the App's
   *  `walletsByChain` map. The hook resolves the correct one for each
   *  side of the Intents request via `addressForAssetId`. */
  walletAddresses?: WalletAddresses;
  /**
   * Optional blockchain selection for the source side. When the user
   * picks a multi-chain symbol (USDC on Base vs USDC on Arbitrum, ETH on
   * Arbitrum vs ETH L1), the form supplies the chosen blockchain and
   * we resolve the right NEAR Intents asset id + decimals via
   * `getSwapCoinMeta(from, fromBlockchain)` instead of the static
   * SWAP_COIN_META lookup. Omit for single-chain symbols (BTC, NEAR).
   */
  fromBlockchain?: IntentsBlockchain;
  /** Same as `fromBlockchain`, for the destination side. */
  toBlockchain?: IntentsBlockchain;
  /** When true, the 30 s auto-refresh interval is suspended. Used by
   *  the confirm modal flow — once the user has clicked Sign & Send
   *  the active route is locked; refreshing it from under them risks
   *  a stale-route execution AND burns rate-limit quota on the same
   *  RPCs the broadcast needs. The 500 ms debounce on input change
   *  still fires; only the 30 s background refresh is paused. */
  paused?: boolean;
}

const DEBOUNCE_MS = 500;
const AUTO_REFRESH_MS = 30_000;
/** The MIN button's on-demand probe schedule, in USD of destination: it
 *  starts where `DEFAULT_SCHEDULE_USD` ($0.05 → $5) ends, because MIN is
 *  only pressed when that schedule found nothing. Five levels, one
 *  request each. */
const MIN_BUTTON_SCHEDULE_USD = [10, 25, 60, 150, 400];
/**
 * Solver wait for MIN's fallback probes.
 *
 * **Corrected 2026-09-05 (same day, later).** This was set to 5 000 ms on the
 * theory that ADA "answers nothing in 0 ms". Measured against the live API —
 * twelve dry quotes per setting, ADA -> BTC above the floor — that was wrong:
 * `wait=0` quoted 11/12 with a median of 0.51 s, `wait=5000` quoted 12/12 with
 * a median of 5.18 s. The parameter is a floor on latency, not a timeout, so
 * five seconds was charged on every one of up to nineteen sequential probes:
 * about a hundred seconds of a button that looks dead. That is the "MIN is
 * slow or doesn't respond" reported right after the change.
 *
 * Zero now, and mostly moot: `probePairFloor` gets the answer in one call.
 */
const MIN_BUTTON_QUOTE_WAIT_MS = FLOOR_PROBE_WAIT_MS;

/** Probe debounce. Slightly shorter than the quote debounce so on
 *  fast pair-pickers the probe response lands before the user finishes
 *  typing — they see the inline hint, never the rejection. */
const PROBE_DEBOUNCE_MS = 250;

/** Placeholder addresses used by the per-pair probe ONLY when the user
 *  hasn't derived a wallet for one side yet. The probe is `dry: true`,
 *  so 1Click never touches these addresses — they're pure request-shape
 *  filler. Real swap flows always use the user's derived addresses
 *  via `addressForAssetId`; this fallback only fires for the dry probe.
 *
 *  These are well-known test vectors: the ABANDON BIP-39 BIP-84 first
 *  receive address (BTC), the Hardhat test account 0 (EVM), the SLIP-10
 *  address from the same ABANDON seed (Solana). */
const PLACEHOLDER_ADDRESSES = {
  evm: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  btc: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  ltc: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
  doge: "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC",
  bch: "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
  dash: "XbBKwyVpYDoXcAYUdJ1XBQzfAkr8aLBmL2",
  sol: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
  // Added 2026-09-05. Its absence is why MIN did nothing on every ADA pair:
  // `addressForAssetId` throws for `cardano.omft.near` without one, so the
  // probe died before any network call — and the thrown sentence contains
  // "CIP-1852", which the minimum parser then read as a floor of 1852 atomic
  // units. The ADA address from the same ABANDON test vector as the others
  // (pinned in `wallets/cardano-cip1852.test.ts`).
  cardano:
    "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv",
  near: "0000000000000000000000000000000000000000000000000000000000000000",
  stellar: "GBVHKLWRPAW7NZRKILYU7AHBZL3NVRNUCNDAVCGW2WLMOOOMSQI4UWE3",
  sui: "0x0000000000000000000000000000000000000000000000000000000000000001",
} as const;

function walletAddressesWithPlaceholders(
  user: WalletAddresses | undefined,
): WalletAddresses {
  return {
    evm: user?.evm ?? PLACEHOLDER_ADDRESSES.evm,
    btc: user?.btc ?? PLACEHOLDER_ADDRESSES.btc,
    ltc: user?.ltc ?? PLACEHOLDER_ADDRESSES.ltc,
    doge: user?.doge ?? PLACEHOLDER_ADDRESSES.doge,
    bch: user?.bch ?? PLACEHOLDER_ADDRESSES.bch,
    dash: user?.dash ?? PLACEHOLDER_ADDRESSES.dash,
    sol: user?.sol ?? PLACEHOLDER_ADDRESSES.sol,
    cardano: user?.cardano ?? PLACEHOLDER_ADDRESSES.cardano,
    near: user?.near ?? PLACEHOLDER_ADDRESSES.near,
    stellar: user?.stellar ?? PLACEHOLDER_ADDRESSES.stellar,
    sui: user?.sui ?? PLACEHOLDER_ADDRESSES.sui,
  };
}

export function useSwapQuote(args: UseSwapQuoteArgs): SwapQuoteState {
  const {
    from,
    to,
    amount,
    slippage = 0.02,
    preferredRouter = "intents",
    sourceAddress,
    destinationAddress,
    walletAddresses,
    fromBlockchain,
    toBlockchain,
    paused = false,
  } = args;

  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<NormalizedQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawSwapKit, setRawSwapKit] = useState<SwapKitQuoteResponse | null>(null);
  const [rawIntents, setRawIntents] = useState<IntentsQuoteResponse | null>(null);
  const [rawDesk, setRawDesk] = useState<DeskQuote | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  // ── per-pair probe state ───────────────────────────────────────
  // `probingPair` is true while the descending probe loop is in flight.
  // `cacheBumpKey` increments after every cache mutation (probe success
  // OR upstream-error capture) so the `intentsMinimum` useMemo re-runs
  // and reads the freshly-cached entry. Without the bump, useMemo's
  // (from, to, fromBlockchain, toBlockchain) deps don't change during
  // the same pair selection, so the post-probe re-render wouldn't pick
  // up the cache update.
  const [probingPair, setProbingPair] = useState(false);
  const [cacheBumpKey, setCacheBumpKey] = useState(0);
  const probeReqIdRef = useRef(0);

  const reqIdRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const numericAmount = useMemo(() => {
    const n = parseFloat(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amount]);

  // Routability differs per upstream — SwapKit and NEAR Intents have
  // disjoint asset namespaces. Eligibility for the user's preferred
  // router determines whether we even kick off the quote.
  const eligible = useMemo(() => {
    if (numericAmount <= 0) return false;
    if (preferredRouter === "swapkit") return isSwapKitRoutable(from, to);
    if (preferredRouter === "intents") return isIntentsRoutable(from, to);
    if (preferredRouter === "pwnda-desk") return isDeskRoutableFromRegistry(from, to);
    if (preferredRouter === "basicswap") return isBasicswapRoutable(from, to);
    // auto: at least one venue has to be routable.
    return (
      isSwapKitRoutable(from, to) ||
      isIntentsRoutable(from, to) ||
      isDeskRoutableFromRegistry(from, to) ||
      isBasicswapRoutable(from, to)
    );
  }, [numericAmount, from, to, preferredRouter]);

  const fetchOnce = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    if (!eligible) {
      setQuote(null);
      setError(null);
      setRawSwapKit(null);
      setRawIntents(null);
      setRawDesk(null);
      setLoading(false);
      return;
    }
    // Resolve effective metadata for each side. When the user has a
    // blockchain hint (multi-chain symbol like USDC), route through
    // `getSwapCoinMeta` which synthesizes per-(symbol, blockchain) meta.
    // Otherwise the canonical static SWAP_COIN_META entry is used.
    const fromMeta =
      getSwapCoinMeta(from, fromBlockchain) ??
      SWAP_COIN_META[from.toUpperCase()];
    const toMeta =
      getSwapCoinMeta(to, toBlockchain) ??
      SWAP_COIN_META[to.toUpperCase()];
    if (!fromMeta || !toMeta) {
      setError("Pair is not routable in v1.");
      setQuote(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      let normalized: NormalizedQuote | null = null;
      let nextRawSwap: SwapKitQuoteResponse | null = null;
      let nextRawIntents: IntentsQuoteResponse | null = null;
      let nextRawDesk: DeskQuote | null = null;
      let firstErr: string | null = null;

      // SwapKit RETIRED for users (operator decision 2026-08-19) — the wallet
      // routes cross-chain through NEAR Intents only. Removing the option from
      // ROUTER_PREFERENCE_OPTIONS makes it unpickable, but `auto` fanned out on
      // this flag independently, so leaving it live would keep SwapKit
      // reachable through the back door and could still win the auto race.
      // Forced false: `auto` now means Intents (plus the local BasicSwap book
      // where that route applies). The explicit `preferredRouter === "swapkit"`
      // branch is left intact and archived — a persisted preference migrates
      // through it rather than crashing. See router-modes.ts.
      const SWAPKIT_RETIRED = true;
      const canSwapKit =
        !SWAPKIT_RETIRED && !!(fromMeta.swapKitAsset && toMeta.swapKitAsset);
      const canIntents = !!(fromMeta.nearIntentsAsset && toMeta.nearIntentsAsset);
      // Desk ARCHIVED 2026-08-22, same treatment as SWAPKIT_RETIRED above.
      // Removing the option from ROUTER_PREFERENCE_OPTIONS (+ SwapView.tsx's
      // own copy) makes it unpickable going forward, but `auto` fans out on
      // this flag independently — leaving it live would keep the desk
      // reachable through the back door and able to win the auto race. The
      // explicit `preferredRouter === "pwnda-desk"` branch below is left
      // intact: a persisted preference throws its own friendly "not
      // routable" error rather than crashing, exactly like SwapKit's. The
      // desk is a THIRD, independent axis when it WAS live: it needs one
      // leader and one follower rather than a shared asset id on both sides,
      // so it is asked of the capability registry rather than derived from
      // the metas.
      const DESK_RETIRED = true;
      const canDesk = !DESK_RETIRED && isDeskRoutableFromRegistry(from, to);
      // A FOURTH axis, and the only one that can carry XMR or ZEPH against a
      // bitcoin-family coin: both are null on `swapKitAsset` AND
      // `nearIntentsAsset`, and the desk only settles the `ada-xmr` engine.
      const canBasicswap = isBasicswapRoutable(from, to);

      if (preferredRouter === "swapkit") {
        if (!canSwapKit) {
          throw new Error(
            `${fromMeta.ticker} → ${toMeta.ticker} is not SwapKit-routable.`
          );
        }
        const swapKitReq = {
          sellAsset: fromMeta.swapKitAsset!,
          buyAsset: toMeta.swapKitAsset!,
          sellAmount: amount,
          slippage,
          sourceAddress,
          destinationAddress,
        };
        debugQuote("swapkit request body", { reqId, body: swapKitReq });
        const resp = await getSwapKitQuote(swapKitReq);
        nextRawSwap = resp;
        normalized = normalizeSwapKit(resp, slippage, toMeta);
        if (!normalized) firstErr = friendlySwapKitNoRoute(resp);
      } else if (preferredRouter === "intents") {
        if (!canIntents) {
          throw new Error(
            `${fromMeta.ticker} → ${toMeta.ticker} is not NEAR Intents-routable. ` +
              `Either side lacks a 1Click asset id (${fromMeta.nearIntentsAsset ? "" : fromMeta.ticker} ` +
              `${toMeta.nearIntentsAsset ? "" : toMeta.ticker}).`
          );
        }
        // Prime the tokens cache on the first eligible Intents quote.
        // After the initial fetch, subsequent quotes read from the
        // synchronous in-memory cache (1-hour TTL) and add zero
        // network latency.
        void getNearIntentsTokens();
        // Asset-validity guard — refuse quotes for asset ids that
        // aren't in the live `/api/intents/tokens` response. Catches
        // the "tokenIn is not valid" 400 class (e.g. POL native, AVAX
        // native — not all chains' gas tokens are bridged via OMFT).
        // Skips silently when the cache hasn't primed yet so the first
        // session-load doesn't reject every Intents quote.
        assertAssetIsRoutable(fromMeta.nearIntentsAsset!, fromMeta.ticker, "source");
        assertAssetIsRoutable(toMeta.nearIntentsAsset!, toMeta.ticker, "destination");
        // Below-minimum local check — saves a 4xx round-trip when the
        // user has typed an amount under 1Click's per-asset floor.
        // Skips silently when the cache hasn't primed yet OR when the
        // asset has no recorded minimum.
        const fromToken = lookupTokenByAssetId(fromMeta.nearIntentsAsset!);
        if (fromToken?.minDepositAmount) {
          const minAtomic = BigInt(fromToken.minDepositAmount);
          let inputAtomic = 0n;
          try {
            inputAtomic = decimalToBaseUnitsBigInt(amount, fromMeta.decimals);
          } catch {
            // Malformed amount → buildIntentsRequestSafely surfaces a
            // clean error message; let it handle that case.
          }
          if (inputAtomic > 0n && inputAtomic < minAtomic) {
            throw new IntentsValidationError(
              `Below minimum: NEAR Intents requires at least ` +
                `${formatAtomicAmount(minAtomic, fromMeta.decimals)} ${fromMeta.ticker} ` +
                `for this route.`
            );
          }
        }
        // Resolve recipient + refundTo BEFORE calling the proxy. Saves a
        // daily-cap point on a guaranteed-bad upstream call when the
        // wallet hasn't derived an address for one of the chains yet.
        const intentsReq = buildIntentsRequestSafely({
          fromAsset: fromMeta.nearIntentsAsset!,
          toAsset: toMeta.nearIntentsAsset!,
          fromMeta,
          amount,
          slippage,
          sourceAddress,
          destinationAddress,
          walletAddresses,
        });
        debugQuote("intents request body", { reqId, body: intentsReq });
        const resp = await getIntentsQuote(intentsReq);
        nextRawIntents = resp;
        normalized = normalizeIntents(resp, slippage, toMeta);
        if (!normalized) firstErr = "No NEAR Intents quote returned.";
      } else if (preferredRouter === "pwnda-desk") {
        if (!canDesk) {
          throw new Error(
            `${fromMeta.ticker} → ${toMeta.ticker} is not routable on the Pwnda desk.`
          );
        }
        // Note what is NOT here: no tokens-cache prime, no assertAssetIsRoutable,
        // no buildIntentsRequestSafely. Those guard the 1Click asset namespace,
        // which the desk does not share — it speaks plain tickers via the
        // FOLLOWER/LEADER pair label.
        const deskReq = {
          pair: deskPairLabel(from, to)!,
          direction: deskDirectionFor(from, to)!,
          amountIn: amount,
        };
        debugQuote("desk request body", { reqId, body: deskReq });
        const resp = await fetchDeskQuote(deskReq);
        nextRawDesk = resp;
        normalized = normalizeDesk(resp, toMeta);
        if (!normalized) firstErr = "No desk quote returned.";
      } else if (preferredRouter === "basicswap") {
        if (!canBasicswap) {
          throw new Error(
            `${fromMeta.ticker} → ${toMeta.ticker} is not a pair the local swap node can hold a book for.`
          );
        }
        // Note what is NOT here: no proxy call, no asset-id namespace, no
        // slippage. The "quote" is a read of a LOCAL offer book over the Rust
        // API proxy, and its price is another user's posted rate — not a
        // routed execution estimate. `fetchSidecarQuote` also owns the price
        // feed and the fee estimate, both absorbed to advisory lines there,
        // so nothing in this branch can fail a quote for a missing advisory.
        debugQuote("basicswap book request", {
          reqId,
          body: { from, to, amount },
        });
        const book = await fetchSidecarQuote({ from, to, amount });
        normalized = normalizeBasicswap(book, toMeta);
        if (!normalized) firstErr = "No usable offer on the local swap book.";
      } else {
        // auto — fan out to whichever upstream(s) the pair is routable on.
        const calls: Promise<unknown>[] = [];
        if (canSwapKit) {
          const swapKitReq = {
            sellAsset: fromMeta.swapKitAsset!,
            buyAsset: toMeta.swapKitAsset!,
            sellAmount: amount,
            slippage,
            sourceAddress,
            destinationAddress,
          };
          debugQuote("swapkit request body (auto)", { reqId, body: swapKitReq });
          calls.push(getSwapKitQuote(swapKitReq));
        } else {
          calls.push(Promise.reject(new Error("not SwapKit-routable")));
        }
        if (canIntents) {
          // Same prime-the-cache + asset-validity + below-minimum guards
          // as the non-auto branch. Saves a 4xx on Intents when the
          // asset isn't in the live tokens list or the user is below
          // the per-asset floor; SwapKit may still be routable so the
          // fan-out continues with just one rejected leg.
          void getNearIntentsTokens();
          try {
            assertAssetIsRoutable(fromMeta.nearIntentsAsset!, fromMeta.ticker, "source");
            assertAssetIsRoutable(toMeta.nearIntentsAsset!, toMeta.ticker, "destination");
            const fromToken = lookupTokenByAssetId(fromMeta.nearIntentsAsset!);
            if (fromToken?.minDepositAmount) {
              const minAtomic = BigInt(fromToken.minDepositAmount);
              let inputAtomic = 0n;
              try {
                inputAtomic = decimalToBaseUnitsBigInt(amount, fromMeta.decimals);
              } catch {
                /* fall through to buildIntentsRequestSafely's error */
              }
              if (inputAtomic > 0n && inputAtomic < minAtomic) {
                throw new IntentsValidationError(
                  `Below minimum: NEAR Intents requires at least ` +
                    `${formatAtomicAmount(minAtomic, fromMeta.decimals)} ${fromMeta.ticker} ` +
                    `for this route.`
                );
              }
            }
            // Pre-flight resolver — lets the auto-mode fan-out gracefully
            // skip Intents when the wallet can't fill recipient/refundTo,
            // rather than the upstream returning 5xx.
            const intentsReq = buildIntentsRequestSafely({
              fromAsset: fromMeta.nearIntentsAsset!,
              toAsset: toMeta.nearIntentsAsset!,
              fromMeta,
              amount,
              slippage,
              sourceAddress,
              destinationAddress,
              walletAddresses,
            });
            debugQuote("intents request body (auto)", { reqId, body: intentsReq });
            calls.push(getIntentsQuote(intentsReq));
          } catch (e) {
            calls.push(Promise.reject(e as Error));
          }
        } else {
          calls.push(Promise.reject(new Error("not Intents-routable")));
        }
        if (canDesk) {
          const deskReq = {
            pair: deskPairLabel(from, to)!,
            direction: deskDirectionFor(from, to)!,
            amountIn: amount,
          };
          debugQuote("desk request body (auto)", { reqId, body: deskReq });
          calls.push(fetchDeskQuote(deskReq));
        } else {
          calls.push(Promise.reject(new Error("not desk-routable")));
        }
        if (canBasicswap) {
          debugQuote("basicswap book request (auto)", {
            reqId,
            body: { from, to, amount },
          });
          calls.push(fetchSidecarQuote({ from, to, amount }));
        } else {
          calls.push(Promise.reject(new Error("not BasicSwap-routable")));
        }
        const [swapResult, intentsResult, deskResult, basicswapResult] =
          await Promise.allSettled(calls);

        let normSwap: NormalizedQuote | null = null;
        let normIntents: NormalizedQuote | null = null;
        let normDesk: NormalizedQuote | null = null;
        let normBasicswap: NormalizedQuote | null = null;

        if (swapResult.status === "fulfilled") {
          nextRawSwap = swapResult.value as SwapKitQuoteResponse;
          normSwap = normalizeSwapKit(nextRawSwap, slippage, toMeta);
        }
        if (intentsResult.status === "fulfilled") {
          nextRawIntents = intentsResult.value as IntentsQuoteResponse;
          normIntents = normalizeIntents(nextRawIntents, slippage, toMeta);
        }
        if (deskResult.status === "fulfilled") {
          nextRawDesk = deskResult.value as DeskQuote;
          normDesk = normalizeDesk(nextRawDesk, toMeta);
        }
        if (basicswapResult.status === "fulfilled") {
          normBasicswap = normalizeBasicswap(
            basicswapResult.value as SidecarQuote,
            toMeta
          );
        }

        normalized = pickAutoBest(
          normSwap,
          normIntents,
          normDesk,
          normBasicswap
        );

        if (!normalized) {
          // ── learn pair-specific minimum from auto-mode rejections ────
          // Same shape as the catch block below — auto-mode aggregates
          // both upstreams via Promise.allSettled, so the rejection
          // never hits the catch. Parse here so the cache populates and
          // the loud error is suppressed.
          const intentsMsg =
            intentsResult.status === "rejected"
              ? ((intentsResult.reason as { message?: unknown })?.message
                ?? String(intentsResult.reason))
              : "";
          const swapkitMsg =
            swapResult.status === "rejected"
              ? ((swapResult.reason as { message?: unknown })?.message
                ?? String(swapResult.reason))
              : "";
          const learnedAuto =
            maybeLearnPairMinimum(String(intentsMsg), fromMeta, toMeta) ||
            maybeLearnPairMinimum(String(swapkitMsg), fromMeta, toMeta);
          if (learnedAuto) {
            // Bump the cache key so the intentsMinimum useMemo re-runs
            // with the freshly-cached entry. Suppress firstErr — the
            // inline hint will surface "Below minimum" in the same
            // render cycle.
            setCacheBumpKey((k) => k + 1);
            firstErr = null;
          } else {
            // Surface the most informative error we can. The desk leg is
            // included here but deliberately NOT fed to maybeLearnPairMinimum
            // above: that helper caches a pair minimum keyed on nearIntentsAsset
            // ids, so parsing a desk rejection into it would poison the Intents
            // cache with a floor from a different venue.
            // Only a venue the pair is actually ROUTABLE on can explain a
            // failure. The fan-out pushes a synthetic
            // `Promise.reject("not <venue>-routable")` for every venue it
            // skipped, and before this filter existed those synthetic
            // rejections won the chain — so an XMR→LTC quote (BasicSwap-only)
            // would have reported "not SwapKit-routable" instead of whatever
            // the swap node actually said.
            const rejection = (
              r: PromiseSettledResult<unknown>,
              routable: boolean
            ): string | null =>
              routable && r.status === "rejected"
                ? humanizeError(r.reason)
                : null;
            firstErr =
              rejection(swapResult, canSwapKit) ??
              rejection(intentsResult, canIntents) ??
              rejection(deskResult, canDesk) ??
              rejection(basicswapResult, canBasicswap) ??
              (nextRawSwap ? friendlySwapKitNoRoute(nextRawSwap) : null) ??
              "No route returned by any upstream.";
          }
        }
      }

      if (reqId !== reqIdRef.current) return;
      setRawSwapKit(nextRawSwap);
      setRawIntents(nextRawIntents);
      setRawDesk(nextRawDesk);
      if (normalized) {
        setQuote(normalized);
        setError(null);
        setFetchedAt(new Date().toISOString());
      } else {
        setQuote(null);
        // firstErr === null means we learned a min and want the inline
        // hint to do the talking — render no top-level error.
        setError(firstErr ?? null);
      }
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      // ── learn pair-specific minimum from upstream rejection ───────
      // The proxy wraps 1Click's 4xx rejections in a wider envelope:
      //   {"error":"UPSTREAM","upstreamMessage":"Amount is too low for
      //    bridge, try at least <N>","upstreamStatus":400,...}
      // The largest atomic integer in the message body is the bridge
      // floor; cache it so the next quote attempt for the same pair
      // surfaces the inline hint immediately rather than re-rejecting.
      const errMsg = (e as Error)?.message ?? String(e);
      const fromMetaForLearn =
        getSwapCoinMeta(from, fromBlockchain) ??
        SWAP_COIN_META[from.toUpperCase()];
      const toMetaForLearn =
        getSwapCoinMeta(to, toBlockchain) ??
        SWAP_COIN_META[to.toUpperCase()];
      const learnedMinimum = maybeLearnPairMinimum(
        errMsg,
        fromMetaForLearn,
        toMetaForLearn,
      );
      setQuote(null);
      if (learnedMinimum) {
        // Below-pair-minimum is communicated by the inline `intentsMinimum`
        // hint (green "Min: X TICKER" → red "Below minimum: X TICKER"
        // when the typed amount is under the floor). Showing the raw
        // proxy 400 envelope on top of that just buries the actionable
        // hint under JSON.
        setCacheBumpKey((k) => k + 1);
        setError(null);
      } else {
        setError(humanizeError(e));
      }
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [
    eligible,
    from,
    to,
    amount,
    slippage,
    preferredRouter,
    sourceAddress,
    destinationAddress,
    walletAddresses,
    fromBlockchain,
    toBlockchain,
  ]);

  const probeMinimumNow = useCallback(async (
    hiAmountDisplay?: string,
  ): Promise<{ amount: string | null; detail: string | null }> => {
    const none = (detail: string | null) => ({ amount: null, detail });
    const fromMeta =
      getSwapCoinMeta(from, fromBlockchain) ?? SWAP_COIN_META[from.toUpperCase()];
    const toMeta = getSwapCoinMeta(to, toBlockchain) ?? SWAP_COIN_META[to.toUpperCase()];
    if (!fromMeta?.nearIntentsAsset || !toMeta?.nearIntentsAsset) {
      return none("this pair is not on NEAR Intents");
    }
    try {
      await getNearIntentsTokens();
    } catch (e) {
      return none(`could not load NEAR's token list: ${(e as Error)?.message ?? String(e)}`);
    }
    const fromToken = lookupTokenByAssetId(fromMeta.nearIntentsAsset);
    const toToken = lookupTokenByAssetId(toMeta.nearIntentsAsset);
    if (!fromToken || !toToken) return none("NEAR's token list does not carry both assets");
    // Already learned for this pair (the pair-change probe usually has it):
    // answer with zero network calls. This is what makes MIN feel instant.
    const cached = getPairMinimum(fromToken.assetId, toToken.assetId);
    if (cached) {
      return {
        amount: formatAtomicForDisplay(cached, fromMeta.decimals),
        detail: null,
      };
    }
    const probeWallet = walletAddressesWithPlaceholders(walletAddresses);
    let lastError: string | null = null;
    setProbingPair(true);
    try {
      // One call, ~0.8 s: ask for deliberately too little and let 1Click name
      // the floor ("Amount is too low for bridge, try at least N"). Everything
      // below is a fallback for a pair that answers some other way.
      let hiSeed: bigint | null = null;
      if (hiAmountDisplay) {
        try {
          hiSeed = decimalToBaseUnitsBigInt(hiAmountDisplay, fromMeta.decimals);
        } catch {
          hiSeed = null;
        }
      }
      let result = await probePairFloor({
        fromAsset: fromToken,
        toAsset: toToken,
        walletAddresses: probeWallet,
        seedAtomic: hiSeed && hiSeed > 0n ? hiSeed.toString() : undefined,
        onError: (m) => {
          lastError = m;
        },
      });
      if (!result) {
        result = await probePerPairMinimum({
          fromAsset: fromToken,
          toAsset: toToken,
          walletAddresses: probeWallet,
          scheduleOverride: MIN_BUTTON_SCHEDULE_USD,
          quoteWaitingTimeMs: MIN_BUTTON_QUOTE_WAIT_MS,
        });
      }
      if (!result) {
        result = await probeExactInputFallback({
          fromAsset: fromToken,
          toAsset: toToken,
          walletAddresses: probeWallet,
          scheduleOverride: MIN_BUTTON_SCHEDULE_USD,
          quoteWaitingTimeMs: MIN_BUTTON_QUOTE_WAIT_MS,
        });
      }
      // Both schedules size their rungs in USD and skip every rung when the
      // tokens list carries no price for the source (ADA, 2026-09-05). The
      // bisection needs no price — only a size that quotes, which the form
      // knows: the amount behind a live quote, or the wallet balance.
      if (!result && hiAmountDisplay) {
        const hiAtomic = hiSeed;
        if (hiAtomic && hiAtomic > 0n) {
          result = await bisectExactInputMinimum({
            fromAsset: fromToken,
            toAsset: toToken,
            walletAddresses: probeWallet,
            hiAtomic: hiAtomic.toString(),
            quoteWaitingTimeMs: MIN_BUTTON_QUOTE_WAIT_MS,
            onError: (m) => {
              lastError = m;
            },
          });
        } else {
          lastError = lastError ?? "no size to search from — enter an amount or fund the wallet";
        }
      }
      if (!result) return none(lastError);
      return { amount: formatAtomicForDisplay(result.minAtomicIn, fromMeta.decimals), detail: null };
    } catch (e) {
      return none((e as Error)?.message ?? String(e));
    } finally {
      setProbingPair(false);
      setCacheBumpKey((k) => k + 1);
    }
  }, [from, to, fromBlockchain, toBlockchain, walletAddresses]);

  const requoteDesk = useCallback(async (): Promise<NormalizedQuote | null> => {
    if (!isDeskRoutableFromRegistry(from, to)) return null;
    const toMeta =
      getSwapCoinMeta(to, toBlockchain) ?? SWAP_COIN_META[to.toUpperCase()];
    if (!toMeta) return null;
    // Claim the request slot BEFORE awaiting. A background refresh already in
    // flight would otherwise resolve after us and clobber the fresh quote —
    // including its quoteId, which is the thing the caller is about to accept
    // against. Bumping first makes that late arrival a no-op.
    const reqId = ++reqIdRef.current;
    const resp = await fetchDeskQuote({
      pair: deskPairLabel(from, to)!,
      direction: deskDirectionFor(from, to)!,
      amountIn: amount,
    });
    const normalized = normalizeDesk(resp, toMeta);
    if (reqId === reqIdRef.current) {
      setRawDesk(resp);
      if (normalized) {
        setQuote(normalized);
        setError(null);
        setFetchedAt(new Date().toISOString());
      }
    }
    // Returned regardless of whether we still own the state slot: the caller
    // explicitly asked for a fresh quote and must be able to act on it even if
    // the user has since changed the form underneath.
    return normalized;
  }, [from, to, amount, toBlockchain]);

  // Debounced kickoff on every input change.
  useEffect(() => {
    if (!eligible) {
      setQuote(null);
      setError(null);
      setRawSwapKit(null);
      setRawIntents(null);
      setRawDesk(null);
      setLoading(false);
      return;
    }
    const handle = setTimeout(fetchOnce, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [eligible, fetchOnce]);

  // 30s auto-refresh while a quote is on screen — suspended when
  // `paused` is true (e.g. confirm modal open). Refreshing under an
  // active commit step risks a stale-route execution AND burns rate-
  // limit quota on the same RPCs the broadcast needs.
  useEffect(() => {
    if (!eligible || paused) return;
    // Most upstreams publish no hard expiry, so the flat cadence applies. The
    // desk does publish one, and its TTL can be exactly AUTO_REFRESH_MS (30s) —
    // meaning a desk quote would go stale at precisely the refresh tick. Aim a
    // few seconds inside the deadline instead, with a 5s floor so a
    // nearly-expired quote can't spin the timer.
    const expiresAt = quote?.expiresAt;
    const delay = expiresAt
      ? Math.max(
          5_000,
          Math.min(
            AUTO_REFRESH_MS,
            (expiresAt - Math.floor(Date.now() / 1000) - 5) * 1000
          )
        )
      : AUTO_REFRESH_MS;
    refreshTimerRef.current = setInterval(fetchOnce, delay);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [eligible, paused, fetchOnce, quote?.expiresAt]);

  // ── per-pair probe effect ──────────────────────────────────────
  // Fires `probePerPairMinimum` on (from, to) change after a short
  // debounce — INDEPENDENT of whether the user has typed an amount.
  // The whole point of the probe is to surface the minimum before
  // they start typing.
  //
  // The effect self-primes:
  //   1. Awaits `getNearIntentsTokens()` so the token cache (price +
  //      decimals) is ready, regardless of whether a real quote has
  //      run yet.
  //   2. Falls back to placeholder addresses when the user hasn't
  //      derived all wallet sides yet — the probe is `dry: true`, no
  //      funds move, the addresses are just request-shape filler.
  //
  // Stale probes (user changes pair before result returns) are
  // dropped via the reqId pattern.
  useEffect(() => {
    if (preferredRouter === "swapkit") return; // Intents-only feature
    if (preferredRouter === "pwnda-desk") return; // ditto — the desk has its own sizing
    // ditto — the BasicSwap route's floor is the PROTOCOL minimum + the
    // maker's own `min_bid_amount`, computed locally by `protocolFloorForPair`
    // against the chosen offer. A 1Click probe would both burn a daily-cap
    // point and produce a number from a venue that cannot carry this pair.
    if (preferredRouter === "basicswap") return;
    const fromMeta =
      getSwapCoinMeta(from, fromBlockchain) ??
      SWAP_COIN_META[from.toUpperCase()];
    const toMeta =
      getSwapCoinMeta(to, toBlockchain) ??
      SWAP_COIN_META[to.toUpperCase()];
    if (!fromMeta?.nearIntentsAsset || !toMeta?.nearIntentsAsset) return;
    // Skip if cached + fresh.
    if (getPairMinimumEntry(fromMeta.nearIntentsAsset, toMeta.nearIntentsAsset)) {
      return;
    }

    const probeReq = ++probeReqIdRef.current;
    const handle = setTimeout(async () => {
      // Prime the token cache first — the probe needs `price` + `decimals`
      // from there, and on a fresh page-load the cache is empty until
      // some quote attempt fires. Calling here makes the probe work
      // BEFORE the user has typed anything.
      try {
        await getNearIntentsTokens();
      } catch {
        // Token-cache priming failed — leave the probe unrun. The
        // reactive parser still catches the eventual real-quote
        // rejection.
        return;
      }
      if (probeReq !== probeReqIdRef.current) return;

      const fromToken = lookupTokenByAssetId(fromMeta.nearIntentsAsset!);
      const toToken = lookupTokenByAssetId(toMeta.nearIntentsAsset!);
      if (!fromToken || !toToken) return;

      // Use real addresses when available, placeholder otherwise. The
      // probe is `dry: true` so even on the placeholder path no funds
      // can move — the addresses are pure request-shape filler.
      const probeWallet = walletAddressesWithPlaceholders(walletAddresses);

      setProbingPair(true);
      try {
        // One call, ~0.8 s, and it doubles as MIN's prefetch: by the time the
        // user reaches for the button the answer is already cached, so MIN
        // fills instantly instead of starting a search on click.
        const floor = await probePairFloor({
          fromAsset: fromToken,
          toAsset: toToken,
          walletAddresses: probeWallet,
        });
        const primary = floor
          ? floor
          : await probePerPairMinimum({
              fromAsset: fromToken,
              toAsset: toToken,
              walletAddresses: probeWallet,
            });
        if (!primary) {
          // EXACT_OUTPUT found nothing parseable. Some bridge families
          // (e.g. HOT Omni-Bridge `nep245:` asset ids, first seen on
          // POL) answer EXACT_OUTPUT dry-quotes with a generic,
          // digit-free rejection — confirmed live against 1Click — so
          // the primary probe silently gives up. A small EXACT_INPUT
          // dry probe asks the same question differently and gets the
          // specific "try at least N" shape those bridges DO return.
          await probeExactInputFallback({
            fromAsset: fromToken,
            toAsset: toToken,
            walletAddresses: probeWallet,
          });
        }
      } catch {
        // Network / address-resolver failure — fall through. The
        // reactive parser on a real quote attempt still kicks in.
      } finally {
        if (probeReq === probeReqIdRef.current) {
          setProbingPair(false);
          setCacheBumpKey((k) => k + 1);
        }
      }
    }, PROBE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [from, to, fromBlockchain, toBlockchain, walletAddresses, preferredRouter]);

  // ── effective Intents minimum for the current pair ──────────────
  // Sources, in priority order:
  //   1. Probe-derived entry (anchored to a specific dest USD value)
  //   2. Upstream-error-derived entry (parsed from a real-quote 4xx)
  //   3. Per-asset minDepositAmount from /tokens cache (today's /tokens
  //      response doesn't carry this field — see research doc — so
  //      this branch is functionally inert, kept only as a safety net
  //      in case 1Click ships the field later)
  //   4. "loading" placeholder while a probe is in flight
  const intentsMinimum = useMemo(() => {
    // A BasicSwap-routed pair has no NEAR Intents minimum, and the per-asset
    // fallback at the bottom of this memo keys on the SOURCE asset alone — so
    // on BTC→XMR (BTC has a 1Click asset id, XMR does not) it could hand back
    // a floor from a venue that cannot carry the pair, and `belowMinimum`
    // would then disable the Swap button against a perfectly fillable offer.
    if (preferredRouter === "basicswap") return null;
    const fromMeta =
      getSwapCoinMeta(from, fromBlockchain) ??
      SWAP_COIN_META[from.toUpperCase()];
    const toMeta =
      getSwapCoinMeta(to, toBlockchain) ??
      SWAP_COIN_META[to.toUpperCase()];
    if (!fromMeta?.nearIntentsAsset) return null;

    let cachedEntry = null;
    if (toMeta?.nearIntentsAsset) {
      cachedEntry = getPairMinimumEntry(
        fromMeta.nearIntentsAsset,
        toMeta.nearIntentsAsset,
      );
    }

    if (cachedEntry) {
      const displayAmount = formatAtomicForDisplay(
        cachedEntry.atomic,
        fromMeta.decimals,
      );
      const result: SwapQuoteState["intentsMinimum"] = {
        displayAmount,
        ticker: fromMeta.ticker,
        source: cachedEntry.source,
      };
      if (cachedEntry.expectedAmountOutUsd) {
        result.expectedAmountOutUsd = cachedEntry.expectedAmountOutUsd;
      }
      const usd = minimumUsdFor(fromMeta.nearIntentsAsset, displayAmount);
      if (usd) result.minimumUsd = usd;
      if (toMeta) {
        result.destinationDisplayName = toMeta.ticker;
      }
      return result;
    }

    // No cache. If a probe is in flight, render "loading".
    if (probingPair && toMeta?.nearIntentsAsset) {
      return {
        displayAmount: "",
        ticker: fromMeta.ticker,
        source: "loading" as const,
        destinationDisplayName: toMeta?.ticker,
      };
    }

    // Per-asset fallback (functionally dead today; kept defensively).
    const fromToken = lookupTokenByAssetId(fromMeta.nearIntentsAsset);
    const perAsset = fromToken?.minDepositAmount
      ? safeBigInt(fromToken.minDepositAmount)
      : null;
    if (perAsset === null) return null;
    const perAssetDisplay = formatAtomicForDisplay(
      perAsset.toString(),
      fromMeta.decimals,
    );
    const perAssetUsd = minimumUsdFor(fromMeta.nearIntentsAsset, perAssetDisplay);
    return {
      displayAmount: perAssetDisplay,
      ticker: fromMeta.ticker,
      source: "upstream-error" as const,
      ...(perAssetUsd ? { minimumUsd: perAssetUsd } : {}),
      ...(toMeta ? { destinationDisplayName: toMeta.ticker } : {}),
    };
  }, [
    from,
    to,
    fromBlockchain,
    toBlockchain,
    cacheBumpKey,
    probingPair,
    preferredRouter,
  ]);

  const belowMinimum = useMemo(() => {
    if (!intentsMinimum) return false;
    // Loading placeholder doesn't gate input — we don't know the floor yet.
    if (intentsMinimum.source === "loading") return false;
    if (!intentsMinimum.displayAmount) return false;
    const fromMeta =
      getSwapCoinMeta(from, fromBlockchain) ??
      SWAP_COIN_META[from.toUpperCase()];
    if (!fromMeta) return false;
    let inputAtomic: bigint;
    try {
      inputAtomic = decimalToBaseUnitsBigInt(amount, fromMeta.decimals);
    } catch {
      return false; // malformed input; let other validation surface it
    }
    if (inputAtomic <= 0n) return false;
    const minDisplayAtomic = decimalToBaseUnitsBigInt(
      intentsMinimum.displayAmount,
      fromMeta.decimals,
    );
    return inputAtomic < minDisplayAtomic;
  }, [intentsMinimum, amount, from, fromBlockchain]);

  return {
    loading,
    quote,
    error,
    rawSwapKit,
    rawIntents,
    rawDesk,
    fetchedAt,
    refetch: fetchOnce,
    requoteDesk,
    probeMinimumNow,
    intentsMinimum,
    belowMinimum,
  };
}

/** Tolerant BigInt parse — returns null on garbage input. */
function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/**
 * USD-equivalent of a minimum's display-units amount, at the source
 * asset's live price from the tokens cache. Returns undefined when the
 * price isn't cached yet or the amount doesn't parse — the caller treats
 * that as "no USD hint available" rather than showing a misleading "$0.00".
 *
 * Exported (instead of file-local) so unit tests can pin the computation
 * against regression, matching the rest of this file's testing convention.
 */
export function minimumUsdFor(
  nearIntentsAssetId: string,
  displayAmount: string,
): string | undefined {
  const token = lookupTokenByAssetId(nearIntentsAssetId);
  if (!token?.price || token.price <= 0) return undefined;
  const n = Number(displayAmount);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const usd = n * token.price;
  return Number.isFinite(usd) && usd > 0 ? usd.toString() : undefined;
}

/**
 * Detect that an upstream rejection carries a parseable bridge-minimum
 * integer ("Amount is too low for bridge, try at least N", "minimum
 * amount of N wei", etc.) and cache it as the per-pair floor. Returns
 * true on success so the caller can suppress the loud error message —
 * the inline hint already conveys the below-min state.
 *
 * Patterns we accept come in three families:
 *   1. Wording-based: "minimum", "too low", "too small", "below",
 *      "less than", "at least", "min...amount"
 *   2. Numeric-only with at-least keywords surrounding the integer
 *   3. The proxy's wrapper envelope passing the upstream message in an
 *      `upstreamMessage` JSON field (string still gets searched)
 */
function maybeLearnPairMinimum(
  errMsg: string,
  fromMeta: SwapCoinMeta | undefined,
  toMeta: SwapCoinMeta | undefined,
): boolean {
  if (!errMsg) return false;
  if (!fromMeta?.nearIntentsAsset || !toMeta?.nearIntentsAsset) return false;
  // Trigger pattern is intentionally permissive — both 1Click's direct
  // wording ("Amount is too low for bridge") AND the proxy's wrapped
  // shape match. False positives populate the cache with a parsed
  // integer that the form's `belowMinimum` gate uses to compare against
  // user input — even a slightly-off value is better than no hint.
  const TRIGGER =
    /minimum|too\s+(small|low)|below|less\s+than|at\s+least|min(imum)?[\s_-]*(deposit|amount|in)/i;
  if (!TRIGGER.test(errMsg)) return false;
  const learned = parseMinAtomicFromUpstreamError(errMsg);
  if (!learned) return false;
  setPairMinimum(fromMeta.nearIntentsAsset, toMeta.nearIntentsAsset, learned, {
    source: "upstream-error",
  });
  return true;
}

/* ─── helpers ───────────────────────────────────────────────── */

/**
 * Pick the better of two simultaneous quotes ("Auto best" routing).
 *
 * **Post-fee, destination-side comparison.** Both sides' `expectedReceive`
 * is already the NET amount the user receives on the destination chain:
 *
 *   - SwapKit's `expectedBuyAmount` is the final receive amount AFTER
 *     inbound + network + outbound + service + affiliate fees are
 *     deducted by the protocol. Verified against SwapKit spec; the
 *     2026-05-25 SwapKit live cutover injects the Pwnda affiliate fee
 *     server-side and SwapKit deducts it before the route reaches us.
 *   - NEAR Intents' `amountOut` rolls all solver-side costs into the
 *     single output number — no separate fees field (see
 *     `normalizeIntents`).
 *
 * Source-side gas is NOT in either `expectedReceive` — gas comes out of
 * the user's source balance separately. That's the correct semantics
 * for "how much will I receive": the destination address gets exactly
 * `expectedReceive`, and gas is the cost of broadcasting the deposit tx.
 *
 * Tie-break: SwapKit wins (`a >= b`). Rarely actually tied — the post-
 * fee numbers diverge unless both upstreams routed through the exact
 * same venue at the exact same instant, which doesn't happen in
 * practice.
 *
 * Exported (instead of file-local) so unit tests can pin the post-fee
 * comparison rule against regression.
 */
export function pickAutoBest(
  swap: NormalizedQuote | null,
  intents: NormalizedQuote | null,
  desk?: NormalizedQuote | null,
  basicswap?: NormalizedQuote | null
): NormalizedQuote | null {
  if (swap && intents) {
    const a = Number(swap.expectedReceive) || 0;
    const b = Number(intents.expectedReceive) || 0;
    return a >= b ? swap : intents;
  }
  // The desk is a LAST RESORT, not a ranked candidate. It is deliberately not
  // compared on expectedReceive against the aggregators: a desk swap is a
  // 10-60 minute atomic protocol that locks the user's funds and runs refund
  // timers, versus a ~30 second one-shot. Letting a rate tiebreak silently
  // move someone between those two is a product decision, not a ranking
  // detail, so `auto` only reaches for the desk when no aggregator answered.
  //
  // This is unobservable today: every desk pair contains XMR or ZEPH, which
  // are null on BOTH swapKitAsset and nearIntentsAsset, so a desk-routable
  // pair is never aggregator-routable. It becomes a live decision the moment
  // that stops being true.
  //
  // BasicSwap sits at the same tier and for the same reason — it is a 30-90
  // minute peer-to-peer atomic swap, not a one-shot route — so it is likewise
  // a fallback and never a rate-ranked candidate. Its position AFTER the desk
  // is unobservable today and deliberately so: the desk settles only the
  // `ada-xmr` engine (an ADA leg) while BasicSwap settles XMR/ZEPH against the
  // bitcoin family, so no pair reaches both. If that ever stops being true,
  // choosing between two atomic venues is a product decision to escalate, not
  // an ordering detail to fix here.
  return swap ?? intents ?? desk ?? basicswap ?? null;
}

/**
 * Normalize a desk quote into the upstream-agnostic shape.
 *
 * UNITS — the trap this function exists to avoid. Desk amounts are ALREADY
 * display-units decimal strings ("27" ADA, "0.1" XMR), exactly like SwapKit
 * and unlike 1Click. Do NOT run them through `formatAtomicForDisplay`: the
 * desk and 1Click responses are structurally similar and numerically
 * opposite, so treating "27" as atomic would render 0.000000000027 ADA — and
 * that would sail past every existing guard, because
 * `assertDisplayedAmountReasonable` only catches values that are too LARGE.
 * The unit test pinning the pass-through is the highest-value test in the
 * desk seam.
 *
 * Takes no `slippage` parameter, unlike its two siblings. An atomic swap has
 * no slippage band — the amount is fixed at accept time by the protocol — so
 * `minReceived` equals `expectedReceive`. Applying `(1 - slippage)` here
 * would invent a tolerance the protocol does not have.
 */
export function normalizeDesk(
  resp: DeskQuote,
  toMeta: SwapCoinMeta
): NormalizedQuote | null {
  const expectedNum = Number(resp.amountOut);
  if (!Number.isFinite(expectedNum) || expectedNum <= 0) return null;

  assertDisplayedAmountReasonable({
    displayAmount: expectedNum,
    ticker: toMeta.ticker,
    field: "you-receive",
  });

  const etaSeconds = Math.max(0, Math.floor(Number(resp.t0Seconds ?? 0)));

  return {
    source: "pwnda-desk",
    routerLabel: ROUTER_MODES["pwnda-desk"].label,
    // The desk's side of THIS swap — LEADER when the user sells the follower
    // coin, FOLLOWER when they buy it.
    providerName: `desk-${String(resp.deskRole ?? "").toLowerCase()}`,
    mockDetected: false,
    deskQuote: resp,
    expiresAt: resp.expiresAt,
    expectedReceive: resp.amountOut,
    // No slippage band on an atomic swap — see the note above.
    minReceived: resp.amountOut,
    // The desk rolls its entire spread into amountOut, so there is no separate
    // source-side fee to show. This MUST stay "0" rather than carrying
    // markup/sTotal: those are FRACTIONS (0.1 = 10%), while the form renders
    // totalFeesSource as an AMOUNT in source units — writing 0.1 here would
    // print "0.1 XMR of fees" on a 0.1 XMR swap. The real spread is shown as a
    // percentage row read off quote.deskQuote.sTotal.
    totalFeesSource: "0",
    affiliateFeeSource: "0",
    etaSeconds,
    etaPretty: prettyDuration(etaSeconds),
    warnings: [],
  };
}

/**
 * Normalize a local BasicSwap book result into the upstream-agnostic shape.
 *
 * ## Three traps this function closes
 *
 * **Units.** Every amount on `SidecarQuote` is already a display-units NUMBER
 * snapped to the coin's own precision by `validateBid`. It is rendered with
 * `formatAmount(value, decimals)` and never `String(value)`: `String(1e-7)` is
 * `"1e-7"`, and an exponent string is both unreadable in the form and rejected
 * by upstream's amount parser on the way back out.
 *
 * **No slippage band.** Like the desk, an atomic swap fixes the amount at
 * accept time — the rate is the offer's, pinned to within 0.01% by upstream's
 * own tolerance. So `minReceived === expectedReceive`. Applying `(1 -
 * slippage)` here would invent a tolerance the protocol does not have, which
 * is why this function takes no `slippage` parameter to apply by accident.
 *
 * **Fees.** `totalFeesSource` stays `"0"`. The route's real cost is the offer's
 * price — already inside `expectedReceive` — plus an advisory on-chain fee that
 * is denominated in whichever coin carries the SCRIPTED leg, which is not
 * necessarily the source coin. The form renders `totalFeesSource` as an amount
 * in SOURCE units, so putting a receive-denominated fee there would print a
 * confidently wrong number. The chain cost gets its own labelled line in
 * `SidecarConfirmModal` instead, and says which coin it is in.
 *
 * Returns `null` when the book result cannot be rendered as a swap, which the
 * caller reports rather than papering over.
 */
export function normalizeBasicswap(
  book: SidecarQuote,
  toMeta: SwapCoinMeta
): NormalizedQuote | null {
  if (!Number.isFinite(book.receiveAmount) || book.receiveAmount <= 0) {
    return null;
  }

  const expected = formatAmount(book.receiveAmount, book.receiveDecimals);
  assertDisplayedAmountReasonable({
    displayAmount: book.receiveAmount,
    ticker: toMeta.ticker,
    field: "you-receive",
  });

  // 30-90 minutes is the protocol's published window and the wallet has no
  // basis for a tighter number: it depends on two chains' confirmation times
  // and on when the counterparty's node next wakes. `etaSeconds` carries the
  // midpoint for any caller doing arithmetic; `etaPretty` states the RANGE,
  // because "~45m" would be a precision the wallet does not have.
  const etaSeconds = 45 * 60;

  return {
    source: "basicswap",
    routerLabel: ROUTER_MODES.basicswap.label,
    // The counterparty is another user on an open network. Naming a maker
    // here — even the offer's `addr_from` — would read as a venue endorsing a
    // particular counterparty, which is exactly the posture this route must
    // not have, and the address is not a name anyway.
    providerName: "peer-to-peer offer",
    mockDetected: false,
    basicswapQuote: book,
    // The chosen OFFER's expiry. Unlike an aggregator's quote TTL this is a
    // real deadline on the other side: past it the offer is gone from the
    // book and a bid against it is refused.
    expiresAt: book.expiresAt,
    expectedReceive: expected,
    minReceived: expected,
    totalFeesSource: "0",
    affiliateFeeSource: "0",
    etaSeconds,
    etaPretty: "~30-90m",
    warnings: book.warnings,
  };
}

/**
 * True when a quote carries a hard expiry that has passed (or is within
 * `skewSec` of passing). Quotes with no `expiresAt` are never stale — the
 * aggregators don't publish one.
 */
export function isDeskQuoteStale(
  q: NormalizedQuote | null | undefined,
  nowSec?: number,
  skewSec = 5
): boolean {
  if (!q?.expiresAt) return false;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  return now >= q.expiresAt - skewSec;
}

/**
 * Normalize a SwapKit `/quote` response into the upstream-agnostic
 * `NormalizedQuote` shape the form renders. Picks the best route by
 * `expectedBuyAmount`, sums fees in source units, sets `mockDetected`
 * when the route id is the MOCK UUID (defense-in-depth — fires
 * regardless of the `VITE_SWAPKIT_LIVE` env flag).
 *
 * Exported for unit tests; the hook still references the file-local
 * symbol. Same behavior as before — adding `export` only widens
 * visibility.
 */
export function normalizeSwapKit(
  resp: SwapKitQuoteResponse,
  slippage: number,
  toMeta: SwapCoinMeta
): NormalizedQuote | null {
  if (!resp.routes || resp.routes.length === 0) return null;
  const route = resp.routes
    .filter((r) => Number(r.expectedBuyAmount) > 0)
    .sort((a, b) => Number(b.expectedBuyAmount) - Number(a.expectedBuyAmount))[0];
  if (!route) return null;

  // SwapKit's `expectedBuyAmount` is already a display-units string per
  // their public spec (decimals/tier handled server-side). The display
  // safety invariant still fires if a bad upstream response leaks atomic
  // units — defence in depth.
  const expected = route.expectedBuyAmount;
  const expectedNum = Number(expected) || 0;
  assertDisplayedAmountReasonable({
    displayAmount: expectedNum,
    ticker: toMeta.ticker,
    field: "you-receive",
  });
  const minReceivedNum = expectedNum * Math.max(0, 1 - slippage);
  assertDisplayedAmountReasonable({
    displayAmount: minReceivedNum,
    ticker: toMeta.ticker,
    field: "min-received",
  });

  // SwapKit serves fees in two shapes — the legacy `{ inbound, outbound,
  // ... }` object map (mock-mode proxy + older endpoints) and the live
  // array of `{ type, amount, amountBps? }` entries (post-2026-05-25
  // cutover). Detect via Array.isArray and parse accordingly. Falling
  // back to 0 keeps the math safe if a shape ever drifts again — the
  // `expectedBuyAmount` is the load-bearing value, fees are a display
  // breakdown.
  const fees = route.fees;
  let inbound = 0;
  let network = 0;
  let outbound = 0;
  let service = 0;
  let affiliate = 0;
  if (Array.isArray(fees)) {
    for (const entry of fees) {
      const amt = Number(entry?.amount ?? 0);
      if (!Number.isFinite(amt)) continue;
      switch (entry?.type) {
        case "inbound":   inbound   = amt; break;
        case "network":   network   = amt; break;
        case "outbound":  outbound  = amt; break;
        case "service":   service   = amt; break;
        case "affiliate": affiliate = amt; break;
        // Unknown fee types are silently dropped — a defensive choice so
        // a new SwapKit fee category doesn't crash the modal. If it
        // surprises us in telemetry, add the case here + a test.
      }
    }
  } else if (fees) {
    inbound   = Number(fees.inbound   ?? 0);
    network   = Number(fees.network   ?? 0);
    outbound  = Number(fees.outbound  ?? 0);
    service   = Number(fees.service   ?? 0);
    affiliate = Number(fees.affiliate ?? 0);
  }

  const eta = route.estimatedTime ?? {};
  const etaSeconds = Math.max(
    0,
    Math.floor(
      eta.total ?? (Number(eta.inbound ?? 0) + Number(eta.swap ?? 0) + Number(eta.outbound ?? 0))
    )
  );

  const provider = route.providers?.[0] ?? "SwapKit";

  return {
    source: "swapkit",
    routerLabel: ROUTER_MODES.swapkit.label,
    providerName: provider,
    mockDetected: isMockSwapKitResponse(route),
    swapKitRoute: route,
    expectedReceive: expected,
    minReceived: trimFloat(minReceivedNum),
    totalFeesSource: trimFloat(inbound + network + outbound + service),
    affiliateFeeSource: trimFloat(affiliate),
    etaSeconds,
    etaPretty: prettyDuration(etaSeconds),
    warnings: route.warnings ?? [],
  };
}

function normalizeIntents(
  resp: IntentsQuoteResponse,
  slippage: number,
  toMeta: SwapCoinMeta
): NormalizedQuote | null {
  const q = resp.quote;
  if (!q) return null;

  // 1Click returns `amountOut` and `minAmountOut` as ATOMIC-units strings
  // (wei / sat / lamport / yocto). The display layer expects display-units
  // strings — converting here means every render site downstream
  // (YOU RECEIVE / RATE / MIN RECEIVED in SwapForm + SwapConfirmModal)
  // sees the right value with no per-call-site formatter.
  //
  // P0 fix 2026-05-08: previous code stored `q.amountOut` directly into
  // `expectedReceive`, which then surfaced as e.g. "10269776004666684 AVAX"
  // for a 1 POL → AVAX swap — atomic units (wei) labeled as display.
  // The safety invariant below is the second line of defence.
  const toDecimals = toMeta.decimals;
  const amountOutAtomic = q.amountOut ?? q.minAmountOut ?? "0";
  const expectedDisplay = formatAtomicForDisplay(amountOutAtomic, toDecimals);
  const expectedNum = Number(expectedDisplay);
  if (!Number.isFinite(expectedNum) || expectedNum <= 0) return null;

  // 1Click already returns a `minAmountOut` (atomic) derived from the
  // slippageTolerance we asked for. Prefer that when present; otherwise
  // apply slippage to the display number here.
  const minReceivedDisplay = q.minAmountOut
    ? formatAtomicForDisplay(q.minAmountOut, toDecimals)
    : trimFloat(expectedNum * Math.max(0, 1 - slippage));

  // ─── Display-amount safety invariant ────────────────────────────
  // Catches the atomic-units-as-display class of bug. Threshold is 10M
  // units of the labeled asset; almost no real swap of any major asset
  // produces a number that big.
  assertDisplayedAmountReasonable({
    displayAmount: expectedNum,
    ticker: toMeta.ticker,
    field: "you-receive",
  });
  assertDisplayedAmountReasonable({
    displayAmount: Number(minReceivedDisplay),
    ticker: toMeta.ticker,
    field: "min-received",
  });

  const etaSeconds = Math.max(0, Math.floor(Number(q.timeEstimate ?? 0)));

  return {
    source: "intents",
    routerLabel: ROUTER_MODES.intents.label,
    providerName: "solver-relay",
    mockDetected: false,
    intentsQuote: q,
    expectedReceive: expectedDisplay,
    minReceived: minReceivedDisplay,
    // 1Click rolls all costs into amountOut — no separate fees field. Show 0.
    totalFeesSource: "0",
    affiliateFeeSource: "0",
    etaSeconds,
    etaPretty: prettyDuration(etaSeconds),
    warnings: [],
  };
}

/**
 * Build a NEAR Intents 1Click quote request body. Critical pieces:
 *
 * 1. **`amount` MUST be in atomic units** of the origin asset, as a
 *    decimal string. Display-units leak (`"0.005"` instead of
 *    `"5000000000000000"` wei) was the residual cause of upstream 5xx
 *    after the address-resolver fix landed. Diagnosed 2026-05-06 by the
 *    server agent's telemetry (38/38 calls produced the same 162-byte
 *    upstream error) plus our static walk.
 * 2. **`recipient` MUST match the destination chain's address format**,
 *    and **`refundTo` MUST match the origin chain's**. Falling back to
 *    `sourceAddress` for a different-chain destination produces a 502
 *    when 1Click can't parse a hex EVM address as a BTC recipient.
 *
 * The function refuses to construct a request when either of those
 * invariants fails — throws `IntentsValidationError` so the form can
 * render the message inline without burning a daily-cap point.
 *
 * Exported (instead of file-local) so the unit tests can pin the body
 * shape, including the wei conversion, against regression.
 */
export function buildIntentsRequestSafely(args: {
  fromAsset: string;
  toAsset: string;
  /** Source-chain metadata used to resolve `decimals` for the atomic-
   *  unit conversion. Required — if missing we'd silently send the
   *  user's display string and reproduce the 5xx. */
  fromMeta: SwapCoinMeta;
  amount: string;
  slippage: number;
  sourceAddress?: string;
  destinationAddress?: string;
  walletAddresses?: WalletAddresses;
}) {
  if (!args.fromMeta) {
    throw new IntentsValidationError(
      "Internal: missing source-chain metadata — cannot convert amount to atomic units.",
    );
  }

  // 1Click slippage is in basis points — 0.02 fraction → 200 bps.
  const slippageBps = Math.max(0, Math.round(args.slippage * 10_000));
  // Deadline: 10 min from now in ISO8601.
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();

  // ─── amount conversion (display units → atomic units) ─────────
  // 1Click's quote endpoint expects `amount` in the smallest unit of
  // the ORIGIN asset, as a decimal string. ETH source: 0.005 ETH →
  // "5000000000000000" wei. BTC source: 0.001 BTC → "100000" sat.
  // Same `decimalToBaseUnitsBigInt` helper that `executeIntentsTrade`
  // already uses for the broadcast-side conversion, so the quote and
  // the broadcast agree.
  let amountAtomic: string;
  try {
    amountAtomic = decimalToBaseUnitsBigInt(
      args.amount,
      args.fromMeta.decimals,
    ).toString();
  } catch (e) {
    throw new IntentsValidationError(
      `Invalid amount "${args.amount}" for ${args.fromMeta.ticker} ` +
        `(decimals ${args.fromMeta.decimals}): ${(e as Error).message}`,
    );
  }
  if (amountAtomic === "0") {
    throw new IntentsValidationError(
      `Amount "${args.amount}" rounds to zero in atomic units of ${args.fromMeta.ticker}.`,
    );
  }

  // ─── address resolution ───────────────────────────────────────
  // Resolver path — the source-of-truth for which derived address
  // matches each side's chain. `walletAddresses` is preferred; fall
  // back to the explicit per-side strings for backwards compatibility
  // with callers that already select the right address themselves.
  const wallet = args.walletAddresses ?? {};
  let recipient: string;
  let refundTo: string;
  try {
    recipient = addressForAssetId(args.toAsset, wallet);
  } catch (e) {
    if (e instanceof IntentsValidationError && args.destinationAddress) {
      recipient = args.destinationAddress;
    } else {
      throw e;
    }
  }
  try {
    refundTo = addressForAssetId(args.fromAsset, wallet);
  } catch (e) {
    if (e instanceof IntentsValidationError && args.sourceAddress) {
      refundTo = args.sourceAddress;
    } else {
      throw e;
    }
  }

  if (!recipient) {
    throw new IntentsValidationError(
      `No derived address for destination asset ${args.toAsset}.`
    );
  }
  if (!refundTo) {
    throw new IntentsValidationError(
      `No derived address for origin asset ${args.fromAsset}.`
    );
  }

  // Field order + types match the 1Click `/api/intents/quote` schema
  // verified against the server agent's 2026-05-06 known-good curl. If
  // any required field is missing or the wrong type, 1Click returns a
  // structured 4xx whose message names the offending field — see the
  // body-shape test in `useSwapQuote.test.ts`.
  return {
    dry: false, // ← boolean literal, NOT string. Required by 1Click.
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: slippageBps,
    originAsset: args.fromAsset,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: args.toAsset,
    recipientType: "DESTINATION_CHAIN" as const,
    amount: amountAtomic,
    recipient,
    refundType: "ORIGIN_CHAIN" as const,
    refundTo,
    deadline,
    // The window the solver-relay holds the route open for execution.
    // Server agent's known-good = 5000 ms.
    quoteWaitingTimeMs: 5000,
  };
}

/**
 * Reject quote attempts for assets that 1Click doesn't recognize.
 *
 * Cross-checks the wallet's `nearIntentsAsset` value against the live
 * `/api/intents/tokens` cache: if the cache is primed AND the asset id
 * isn't in it, throws a clean `IntentsValidationError` BEFORE the
 * proxy round-trip. Catches the upstream "tokenIn is not valid" 400
 * class — most commonly tripped by chain-native gas tokens (POL, AVAX,
 * BNB) that the wallet's hand-curated asset list optimistically includes
 * but OMFT doesn't actually bridge.
 *
 * Skips silently when the cache hasn't primed yet (first session-load,
 * or transient proxy outage) — graceful degradation: the upstream's
 * own validation surfaces the error in that window. Once the cache is
 * primed once, subsequent same-session quotes get the local check.
 */
function assertAssetIsRoutable(
  assetId: string,
  ticker: string,
  side: "source" | "destination"
): void {
  // Lazy import avoids a circular dep with near-intents-tokens (which
  // pulls in proxy types this file already imports).
  const tokens = lookupTokenByAssetId(assetId);
  if (tokens) return; // present in cache → known-routable
  // Not in cache. Two possibilities:
  //   1. Cache hasn't primed (first quote of session). Skip the check
  //      — let the upstream reject if it's a real bad-asset.
  //   2. Cache HAS primed but this assetId isn't in it. Definite reject.
  // We distinguish via a synchronous accessor that reports whether the
  // cache has any entries at all.
  const cacheStatus = getCachedTokensSize();
  if (cacheStatus === 0) return; // cache empty → degrade gracefully
  // Cache primed but this asset is missing — refuse with a clean message.
  const sideLabel = side === "source" ? "source" : "destination";
  throw new IntentsValidationError(
    `${ticker} is not currently routable as a ${sideLabel} via NEAR Intents. ` +
      `The 1Click asset id "${assetId}" is not in the live tokens list. ` +
      `Pick a different ${sideLabel} asset.`
  );
}

/** Synchronous read of the cache's current size. 0 when empty / not primed. */
function getCachedTokensSize(): number {
  return getCachedNearIntentsTokens()?.size ?? 0;
}

/**
 * Format an atomic-units amount into a human display string. Trailing
 * zeros are stripped; the result has no thousands separators (the form
 * pastes this directly into hint copy where unambiguity matters).
 *
 * Mirrors the inverse of `decimalToBaseUnitsBigInt`. Used by the form's
 * minimum-amount hint and the IntentsValidationError thrown above so
 * the user sees the same number from quote-side and form-side.
 */
export function formatAtomicAmount(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const padded = atomic.toString().padStart(decimals + 1, "0");
  const intPart = padded.slice(0, -decimals);
  const fracPart = padded.slice(-decimals).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Look up the deposit minimum (atomic units, BigInt) for a NEP-141
 * asset id. Returns null when:
 *   - the cache hasn't primed yet
 *   - the asset has no minimum recorded
 *   - the asset id isn't in the cache (unknown asset)
 *
 * The form uses this to render the inline "Min: …" hint and to gate
 * the Swap button. Same source the quote-side validation reads from,
 * so the two are guaranteed to agree.
 */
export function getMinDepositAtomicForAsset(assetId: string): bigint | null {
  const t = lookupTokenByAssetId(assetId);
  if (!t?.minDepositAmount) return null;
  try {
    return BigInt(t.minDepositAmount);
  } catch {
    return null;
  }
}

function trimFloat(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  const s = n.toFixed(8);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

function prettyDuration(secs: number): string {
  if (secs <= 0) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `~${s}s`;
  if (s === 0) return `~${m}m`;
  return `~${m}m ${s}s`;
}

function friendlySwapKitNoRoute(resp: SwapKitQuoteResponse): string | null {
  if (resp.providerErrors && resp.providerErrors.length > 0) {
    const e = resp.providerErrors[0];
    return `${e.provider}: ${e.error}`;
  }
  return null;
}

function humanizeError(e: unknown): string {
  // Pre-flight resolver/format errors get rendered verbatim — they
  // already carry a clear actionable message ("No derived BTC address
  // — open the Bitcoin chain in the dashboard…") and were thrown
  // BEFORE any proxy round-trip, so no rate-limit point was burned.
  if (e instanceof IntentsValidationError) {
    return e.message;
  }
  // Same treatment for the BasicSwap route. Every `SidecarQuoteError` message
  // is already a finished plain sentence written for a user ("No one is
  // currently offering LTC for XMR…") and several are the offer book's own
  // validation copy — running them through the pattern table below could only
  // damage them.
  if (e instanceof SidecarQuoteError) {
    return e.message;
  }
  const msg = String((e as { message?: unknown })?.message ?? e);
  if (/AUTH_REQUIRED|AuthRequired|not enrolled/.test(msg)) {
    return "This wallet is not registered with the server. Try the Re-enroll button in Settings.";
  }
  if (/AuthBanned/.test(msg)) {
    return "This wallet has been blocked by the server.";
  }
  if (/RateLimitMinute|rate limited per minute/.test(msg)) {
    return "You're swapping too fast. Wait a moment and try again.";
  }
  if (/RateLimitDay|rate limited per day/.test(msg)) {
    return "Daily swap limit reached. Resets at UTC midnight.";
  }
  if (/AuthClockSkew|clock skew/.test(msg)) {
    return "Your system clock is off — please sync time and retry.";
  }
  if (/AuthBadSig|AuthNonceReplay/.test(msg)) {
    return "Auth error, please retry.";
  }
  // ── swap-desk codes ────────────────────────────────────────────────
  // These arrive as the Rust `ProxyError` Display text (already friendly)
  // when `classify_error` matched, or as the bare code inside an HTTP error
  // envelope when it did not. Match the CODE so both shapes land here.
  // Transcribed from src-tauri/src/swap/proxy.rs's desk variants — do not
  // invent codes the desk does not send.
  if (/QUOTE_EXPIRED|quote expired/i.test(msg)) {
    return "That desk quote expired. Re-quote to get a fresh price.";
  }
  if (/INVENTORY_UNAVAILABLE|inventory unavailable/i.test(msg)) {
    // CC-7: this used to end "Try a smaller amount or another pair" — which is
    // the advice for SIZE_OUT_OF_RANGE, the OTHER error. These two refusals
    // demand opposite responses: inventory is RETRYABLE (the same request
    // succeeds once an in-flight swap settles), and telling a user to change
    // the amount sends them to alter the one thing that was never the problem.
    return "The desk is short on inventory for this pair right now — this is temporary, and the same amount should work once an in-flight swap settles. Try again shortly.";
  }
  if (/PAIR_HALTED|pair is halted/i.test(msg)) {
    return "This desk pair is halted right now (stale pricing or a manual pause). Try again later.";
  }
  if (/SIZE_OUT_OF_RANGE|outside the pair's allowed/i.test(msg)) {
    return "That amount is outside the desk's allowed range for this pair.";
  }
  if (/SWAP_STATE_CONFLICT|swap-state conflict/i.test(msg)) {
    return "That swap has already moved on — refresh to see its current state.";
  }
  if (/PRIVATE_KEY_REJECTED|spend scalar was detected/i.test(msg)) {
    return "The desk rejected the request for carrying key material. This is a client bug — please report it.";
  }
  // Upstream-bad-gateway: the proxy got a 5xx from SwapKit / 1Click.
  // Most often: malformed asset id or the upstream API is having a moment.
  if (/proxy returned 50[0-9]/.test(msg) || /\b50[0-9]\b.*error code/.test(msg)) {
    return (
      "Upstream router returned an error (5xx). " +
      "Either the route isn't available right now, or the asset ids are not " +
      "recognized. Try a different pair, smaller amount, or wait a moment."
    );
  }
  // 1Click's wording for "nothing fills at this size on this route" — seen
  // for ADA → BTC at 0.0027 ADA (an amount carried over from a BTC → ADA
  // quote by the flip button, 2026-09-04). It is not an outage.
  if (/No liquidity available/i.test(msg)) {
    return (
      "NEAR Intents has no route for this pair at this size right now. " +
      "Amounts below the pair's minimum fail this way — press MIN to fill the " +
      "smallest size NEAR will quote, or try the other direction."
    );
  }
  if (/proxy returned 4[0-9]{2}/.test(msg)) {
    return `Quote request rejected by upstream: ${msg}`;
  }
  return msg;
}
