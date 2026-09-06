/**
 * USD price + 24h-history lookup with multi-provider fallback and
 * Tauri-proxy routing.
 *
 * Three things this module does that the previous (browser-fetch +
 * CoinGecko-only) version didn't:
 *
 * 1. **Routes everything through the Rust http-proxy** (`proxyGetJson`).
 *    Every supported provider rejects requests carrying the Tauri
 *    webview origin (`tauri://localhost`) with either a CORS preflight
 *    failure or — for CoinGecko's free tier — an aggressive WAF block
 *    that the user can't whitelist. Routing through reqwest in the
 *    backend strips the Origin header so the endpoint sees a normal
 *    HTTP client.
 *
 * 2. **Multiple providers** — CoinGecko first, CoinPaprika second,
 *    CryptoCompare third. Each provider has independent rate-limit
 *    state; the iterator falls through on 429 / 5xx / network error.
 *    Spot prices and 24h history each have their own provider chains
 *    because the candidate APIs differ.
 *
 * 3. **Smart caching + cooldown after rate-limit**:
 *    - Spot price cache: 60s TTL (was 60s).
 *    - History cache: 15 minutes (was 5).
 *    - On a 429 from any provider, that provider goes into a 5-minute
 *      cooldown — subsequent calls skip it without burning a request.
 *    - Stagger between history requests stretched to 1500 ms (from 1000)
 *      and skipped entirely after a cache hit.
 *
 * Net effect: a fresh dashboard load makes ~1 spot-price call (single
 * batched URL) + N staggered history calls. After the cache warms, all
 * subsequent dashboard / wallet-tab entries reuse cached values for
 * 1–15 minutes and burn zero network. A rate-limit blip degrades
 * gracefully: the spot-price cache stays valid, history sparklines
 * continue to render the previous values until the cache expires.
 *
 * 4. **Spot prices survive a restart (2026-08-23).** Everything above this
 *    point only helps WITHIN one process lifetime — `spotCache` and
 *    `lastGoodByTicker` started every fresh app launch empty, unlike
 *    `src/wallets/balance-cache.ts`'s balances, which persist to disk and
 *    hydrate before the first network attempt. That asymmetry is why a
 *    portfolio full of correctly-loaded balances could still show every
 *    held asset's $ column blank on open: the balance side had already
 *    solved this, the price side never had. `lastGoodByTicker` now
 *    persists to its own store (`usd-price-cache.json`) and hydrates on
 *    the first `fetchUsdPrices` call of a session — serving yesterday's
 *    prices instantly while a real refresh runs in the background, the
 *    same hydrate-then-fetch split `useTxHistory`/`balance-cache.ts`
 *    already use elsewhere in this codebase.
 */

import { proxyGetJson } from "./_proxy";

/** Map ticker → CoinGecko coin id. Stable for years. */
export const TICKER_TO_COINGECKO_ID: Record<string, string> = {
  XMR:   "monero",
  ETH:   "ethereum",
  BTC:   "bitcoin",
  SOL:   "solana",
  ADA:   "cardano",
  RVN:   "ravencoin",
  CFX:   "conflux-token",
  DOGE:  "dogecoin",
  ZEPH:  "zephyr-protocol",
  AVAX:  "avalanche-2",
  POL:   "polygon-ecosystem-token",
  MATIC: "polygon-ecosystem-token",
  FLR:   "flare-networks",
  XRP:   "ripple",
  TRX:   "tron",
  HBAR:  "hedera-hashgraph",
  ALGO:  "algorand",
  USDT:  "tether",
  // Stablecoin families added 2026-09-02. Priced like any other asset rather
  // than pinned to 1.00: a depeg is exactly when the number matters, and a
  // hardcoded $1 would hide it.
  USDC:  "usd-coin",
  USDT0: "tether",
  LTC:   "litecoin",
  BCH:   "bitcoin-cash",
  ERG:   "ergo",
  // 2026-06-14 — these chains had a balance but rendered "—" for USD value
  // AND 24h % (and contributed nothing to the portfolio total/spark) because
  // they were absent here, so fetchSpotFromCoinGecko + fetchUsdPriceHistory
  // both silently dropped them. Ids verified live against CoinGecko.
  BNB:   "binancecoin",
  MON:   "monad",
  DASH:  "dash",
  XLM:   "stellar",
  SUI:   "sui",
  NEAR:  "near",
  ZANO:  "zano",
};

/** Map ticker → CoinPaprika coin id (slug-uppercase format). */
const TICKER_TO_COINPAPRIKA_ID: Record<string, string> = {
  XMR:   "xmr-monero",
  ETH:   "eth-ethereum",
  BTC:   "btc-bitcoin",
  SOL:   "sol-solana",
  ADA:   "ada-cardano",
  RVN:   "rvn-ravencoin",
  CFX:   "cfx-conflux-network",
  DOGE:  "doge-dogecoin",
  AVAX:  "avax-avalanche",
  POL:   "pol-polygon-ecosystem-token",
  MATIC: "pol-polygon-ecosystem-token",
  FLR:   "flr-flare-network",     // was "flr-flare" — stale, fixed 2026-06-17
  XRP:   "xrp-xrp",
  TRX:   "trx-tron",
  HBAR:  "hbar-hedera-hashgraph", // was "hbar-hedera" — stale, fixed 2026-06-17
  ALGO:  "algo-algorand",
  USDT:  "usdt-tether",
  USDC:  "usdc-usd-coin",
  USDT0: "usdt-tether",
  LTC:   "ltc-litecoin",
  BCH:   "bch-bitcoin-cash",
  ERG:   "efyt-ergo",             // was "erg-ergo" — stale, fixed 2026-06-17
  // Fallback-provider parity for the 2026-06-14 additions (MON omitted —
  // too new to have a stable CoinPaprika slug; CoinGecko + CryptoCompare
  // raw-symbol fallback still cover it). With the merge logic in
  // fetchUsdPrices a wrong slug here is now genuinely harmless (that
  // provider yields no price for the coin and the next provider fills it).
  BNB:   "bnb-binance-coin",
  DASH:  "dash-dash",
  XLM:   "xlm-stellar",
  SUI:   "sui-sui",
  NEAR:  "near-near-protocol",
  // ZEPH (Zephyr Protocol) is NOT listed on CoinPaprika at all — verified
  // live 2026-06-17, no entry with symbol ZEPH in /v1/tickers. The old
  // "zeph2-zephyr-protocol" id matched nothing, so every CoinGecko 429
  // cooldown blanked ZEPH's USD value. Intentionally absent: ZEPH is priced
  // by CoinGecko, and the last-known-good cache in fetchUsdPrices keeps its
  // value on screen through any cooldown window.
  ZANO:  "zano-zano", // verified live 2026-08-27 via /v1/search?q=zano
};

const COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_CHART_URL = "https://api.coingecko.com/api/v3/coins";
const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";
const COINPAPRIKA_TICKER_URL = "https://api.coinpaprika.com/v1/tickers";
const CRYPTOCOMPARE_PRICE_URL = "https://min-api.cryptocompare.com/data/pricemulti";
const CRYPTOCOMPARE_HISTOHOUR = "https://min-api.cryptocompare.com/data/v2/histohour";

const SPOT_CACHE_TTL_MS = 60_000;
const HISTORY_CACHE_TTL_MS = 900_000; // 15 minutes — was 5; 429s come from over-fetching
const HISTORY_TARGET_POINTS = 24;
const STAGGER_MS = 1500;
/**
 * Most tickers the per-ticker history fallback will fetch in one sweep.
 *
 * The fallback is sequential with `STAGGER_MS` between calls, so cost is
 * `N * 1.5s`. Uncapped, a ~19-asset wallet whose batched call got 429'd spends
 * ~28s per refresh for the whole 5-minute cooldown. 4 keeps the worst case
 * under ~6s; the 15-minute history cache means successive sweeps make progress
 * rather than repeating the same work.
 */
const HISTORY_FALLBACK_MAX = 4;
const COOLDOWN_AFTER_429_MS = 300_000; // 5 minutes — well past most rate-limit windows

// ---------------------------------------------------------------------------
// Provider cooldown tracking
// ---------------------------------------------------------------------------

type Provider = "coingecko" | "coinpaprika" | "cryptocompare";

const cooldownUntil: Record<Provider, number> = {
  coingecko: 0,
  coinpaprika: 0,
  cryptocompare: 0,
};

function isOnCooldown(p: Provider): boolean {
  return Date.now() < cooldownUntil[p];
}
function markCooldown(p: Provider, reason: string): void {
  cooldownUntil[p] = Date.now() + COOLDOWN_AFTER_429_MS;
  warnPriceFailureOnce(`${p}: ${reason}`);
}

// ---------------------------------------------------------------------------
// One-warn-per-session
// ---------------------------------------------------------------------------

const _warnedReasons = new Set<string>();
function warnPriceFailureOnce(reason: string): void {
  if (_warnedReasons.has(reason)) return;
  _warnedReasons.add(reason);
  // eslint-disable-next-line no-console
  console.warn(
    `[network] price-source: ${reason}. Falling through to next provider; ` +
      `cached values continue to render until the next refresh window.`,
  );
}

// ---------------------------------------------------------------------------
// Spot price — multi-provider fallback
// ---------------------------------------------------------------------------

let spotCache: { at: number; prices: Record<string, number> } | null = null;
let spotInflight: Promise<Record<string, number>> | null = null;

// Last-known-good price per uppercase ticker, accumulated across every
// successful fetch and NEVER wholesale-cleared. A provider that can't price
// a given coin (e.g. CoinPaprika doesn't list ZEPH, or CoinGecko is on its
// 429 cooldown) must not cause that coin's value to regress to "—" in the
// UI — we keep showing its last real price until a provider returns a fresh
// one. Before this, a CoinGecko cooldown that fell through to CoinPaprika
// overwrote the whole cache with CoinPaprika's partial coverage, blanking
// every coin CoinPaprika couldn't map. That was the "balance but no USD
// price" bug.
let lastGoodByTicker: Record<string, number> = {};

/**
 * Disk persistence for `lastGoodByTicker` (2026-08-23).
 *
 * Everything above this point is in-memory only — `spotCache` and
 * `lastGoodByTicker` both start empty on every process launch, unlike
 * `src/wallets/balance-cache.ts`'s balance figures, which hydrate from a
 * persisted store before the first network round-trip even starts. That
 * asymmetry is why the portfolio header's "N NOT LOADED" count (chains held
 * but not valued — `DashboardView.tsx`'s `missingNames`) is disproportionately
 * a PRICE gap, not a balance gap: balances survive a restart instantly,
 * prices do not, so a cold launch shows every held asset's $ column blank
 * until the first spot-price round completes, no matter how many times the
 * wallet has already priced that ticker before. Mirrors
 * `balance-cache.ts`'s exact pattern: a separate store file, a lazy loader,
 * fire-and-forget writes, hydrate-then-fetch.
 */
const PRICE_STORE_FILE = "usd-price-cache.json";
const PRICE_CACHE_KEY = "lastGoodByTicker";

type PriceStoreLike = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let _priceStore: Promise<PriceStoreLike | null> | null = null;
function getPriceStore(): Promise<PriceStoreLike | null> {
  if (!_priceStore) {
    _priceStore = import("@tauri-apps/plugin-store")
      .then((m) => m.Store.load(PRICE_STORE_FILE) as unknown as Promise<PriceStoreLike>)
      .catch(() => null);
  }
  return _priceStore;
}

// Resolves once hydration has been attempted (success or failure) — awaited
// at the top of `fetchUsdPrices` so the very first call of a fresh launch
// checks disk before making a network decision, without needing every
// caller to separately hydrate the way `useTxHistory`'s two-effect pattern
// does. A single promise, not a boolean flag, so concurrent early callers
// all wait on the SAME attempt rather than racing separate reads.
let hydrated: Promise<void> | null = null;
function ensurePriceCacheHydrated(): Promise<void> {
  if (!hydrated) {
    hydrated = (async () => {
      try {
        const store = await getPriceStore();
        if (!store) return;
        const cached = await store.get<Record<string, number>>(PRICE_CACHE_KEY);
        if (cached && typeof cached === "object") {
          // Merge under whatever a fetch already completed before hydration
          // landed (possible if a caller raced ahead) — never regress a
          // fresher in-memory price with a stale disk one.
          lastGoodByTicker = { ...cached, ...lastGoodByTicker };
        }
      } catch {
        /* cache read failure is non-fatal — behaves as a fresh install */
      }
    })();
  }
  return hydrated;
}

/** Fire-and-forget; failure is non-fatal, matching `writeBalanceCache`. */
function writePriceCache(prices: Readonly<Record<string, number>>): void {
  void (async () => {
    try {
      const store = await getPriceStore();
      if (!store) return;
      await store.set(PRICE_CACHE_KEY, prices);
      await store.save();
    } catch {
      /* cache write failure is non-fatal */
    }
  })();
}

async function fetchSpotFromCoinGecko(tickers: string[]): Promise<Record<string, number>> {
  if (isOnCooldown("coingecko")) throw new Error("coingecko on cooldown");
  const ids = Array.from(
    new Set(
      tickers
        .map((t) => TICKER_TO_COINGECKO_ID[t.toUpperCase()])
        .filter((id): id is string => !!id)
    )
  );
  if (ids.length === 0) return {};
  const url = `${COINGECKO_PRICE_URL}?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`;
  const json = await proxyGetJson<Record<string, { usd?: number }>>(url, {
    accept: "application/json",
  });
  const out: Record<string, number> = {};
  for (const [ticker, id] of Object.entries(TICKER_TO_COINGECKO_ID)) {
    const price = json[id]?.usd;
    if (typeof price === "number" && Number.isFinite(price)) {
      out[ticker] = price;
    }
  }
  return out;
}

async function fetchSpotFromCoinPaprika(tickers: string[]): Promise<Record<string, number>> {
  if (isOnCooldown("coinpaprika")) throw new Error("coinpaprika on cooldown");
  // CoinPaprika doesn't have a "prices for many ids" endpoint that's
  // anonymous-friendly, but it serves the entire ticker list in one
  // call at /v1/tickers (top 5000 by mcap). One request gets us every
  // supported coin.
  type Row = { symbol?: string; id?: string; quotes?: { USD?: { price?: number } } };
  const all = await proxyGetJson<Row[]>(`${COINPAPRIKA_TICKER_URL}`, {
    accept: "application/json",
  });
  const byId = new Map<string, number>();
  for (const r of all) {
    const px = r.quotes?.USD?.price;
    if (r.id && typeof px === "number") byId.set(r.id, px);
  }
  const out: Record<string, number> = {};
  for (const t of tickers.map((x) => x.toUpperCase())) {
    const id = TICKER_TO_COINPAPRIKA_ID[t];
    if (id && byId.has(id)) out[t] = byId.get(id)!;
  }
  return out;
}

async function fetchSpotFromCryptoCompare(tickers: string[]): Promise<Record<string, number>> {
  if (isOnCooldown("cryptocompare")) throw new Error("cryptocompare on cooldown");
  const upper = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  if (upper.length === 0) return {};
  // CryptoCompare's "fsyms" parameter takes a comma-list; tsyms is the
  // target currency (USD).
  const url = `${CRYPTOCOMPARE_PRICE_URL}?fsyms=${encodeURIComponent(upper.join(","))}&tsyms=USD`;
  const json = await proxyGetJson<Record<string, { USD?: number }>>(url, {
    accept: "application/json",
  });
  const out: Record<string, number> = {};
  for (const t of upper) {
    const px = json[t]?.USD;
    if (typeof px === "number" && Number.isFinite(px)) out[t] = px;
  }
  return out;
}

const SPOT_PROVIDERS: Array<{
  name: Provider;
  fetch: (tickers: string[]) => Promise<Record<string, number>>;
}> = [
  { name: "coingecko", fetch: fetchSpotFromCoinGecko },
  { name: "coinpaprika", fetch: fetchSpotFromCoinPaprika },
  { name: "cryptocompare", fetch: fetchSpotFromCryptoCompare },
];

/**
 * Fetch current USD prices for the given tickers (any case). Unknown
 * tickers are silently dropped. Result is keyed by uppercase ticker.
 *
 * On every-provider failure, returns the last successful cache if one
 * exists, otherwise an empty object. Callers should treat missing keys
 * as "no price".
 */
export async function fetchUsdPrices(
  tickers: string[],
  { force = false }: { force?: boolean } = {}
): Promise<Record<string, number>> {
  // Cheap after the first call (same resolved promise every time) — but on
  // a fresh launch this is what lets the very first call see yesterday's
  // prices instead of nothing, closing the cold-start gap described above.
  await ensurePriceCacheHydrated();
  if (!force && !spotCache && Object.keys(lastGoodByTicker).length > 0) {
    // Cold start: hydration found yesterday's prices and no fetch has run
    // yet this session. Serve them immediately — instant render beats a
    // correct number a few seconds later, the same trade-off
    // `hydrateBalances` already makes for balances — and kick off a REAL
    // refresh in the background rather than blocking this call on it.
    // `at: 0` guarantees the recursive call's own TTL check treats this
    // snapshot as already-expired, so it proceeds straight to a live fetch
    // instead of re-serving the same stale prices back to itself.
    spotCache = { at: 0, prices: { ...lastGoodByTicker } };
    void fetchUsdPrices(tickers, { force: true });
    return spotCache.prices;
  }
  const now = Date.now();
  if (!force && spotCache && now - spotCache.at < SPOT_CACHE_TTL_MS) {
    return spotCache.prices;
  }
  if (spotInflight) return spotInflight;

  spotInflight = (async () => {
    const wanted = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
    const fresh: Record<string, number> = {};
    let lastError: unknown = null;

    // Accumulate across providers instead of "first non-empty result wins".
    // Each provider is asked ONLY for the tickers still missing a price, and
    // its results are merged in. With a healthy CoinGecko the first provider
    // covers everything and the rest are never called; when CoinGecko is on
    // cooldown (or lacks a coin), CoinPaprika / CryptoCompare backfill the
    // gaps rather than a partial first answer being cached as complete.
    for (const provider of SPOT_PROVIDERS) {
      const missing = wanted.filter((t) => fresh[t] == null);
      if (missing.length === 0) break; // fully covered — stop early
      if (isOnCooldown(provider.name)) continue;
      try {
        const result = await provider.fetch(missing);
        for (const [t, p] of Object.entries(result)) {
          if (typeof p === "number" && Number.isFinite(p)) {
            fresh[t.toUpperCase()] = p;
          }
        }
      } catch (e: any) {
        lastError = e;
        const msg = String(e?.message ?? e);
        if (/HTTP 429/.test(msg)) {
          markCooldown(provider.name, "rate-limit (HTTP 429)");
        } else if (/HTTP 40[13]/.test(msg)) {
          // 401/403 = auth required. CryptoCompare's free `pricemulti`
          // endpoint now demands an API key; back off for the full cooldown
          // window instead of re-hitting it on every 60s refresh.
          markCooldown(provider.name, "auth required (HTTP 401/403)");
        } else if (/HTTP 5\d\d/.test(msg)) {
          markCooldown(provider.name, "provider error (HTTP 5xx)");
        } else if (/CORS|Failed to fetch|NetworkError/i.test(msg)) {
          // Should never happen now that we route through the proxy,
          // but defense in depth.
          markCooldown(provider.name, "transport failure");
        }
        // Continue to next provider for whatever is still missing.
      }
    }

    // Merge this round into the persistent last-known-good map so a ticker
    // priced earlier survives a later round that couldn't cover it (provider
    // gap or cooldown). The cache we hand back is the union — never a regression.
    lastGoodByTicker = { ...lastGoodByTicker, ...fresh };
    spotCache = { at: Date.now(), prices: { ...lastGoodByTicker } };
    if (Object.keys(fresh).length > 0) writePriceCache(lastGoodByTicker);

    if (Object.keys(fresh).length === 0 && lastError) {
      // eslint-disable-next-line no-console
      console.warn(
        "[network] all spot-price providers failed this round; serving last-known-good cache.",
        String((lastError as Error)?.message ?? lastError),
      );
    }
    return spotCache.prices;
  })().finally(() => {
    spotInflight = null;
  });

  return spotInflight;
}

// ---------------------------------------------------------------------------
// 24h history — multi-provider fallback
// ---------------------------------------------------------------------------

const historyCache = new Map<string, { at: number; values: number[] }>();
const historyInflight = new Map<string, Promise<number[] | null>>();

function downsample(points: [number, number][], target: number): number[] {
  if (points.length === 0) return [];
  if (points.length <= target) return points.map(([, p]) => p);
  const step = points.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.floor(i * step);
    out.push(points[idx][1]);
  }
  out[out.length - 1] = points[points.length - 1][1];
  return out;
}

async function fetchHistoryFromCoinGecko(ticker: string): Promise<number[] | null> {
  if (isOnCooldown("coingecko")) return null;
  const id = TICKER_TO_COINGECKO_ID[ticker.toUpperCase()];
  if (!id) return null;
  const url = `${COINGECKO_CHART_URL}/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=1`;
  try {
    const json = await proxyGetJson<{ prices?: [number, number][] }>(url, {
      accept: "application/json",
    });
    const points = Array.isArray(json.prices) ? json.prices : [];
    return downsample(points, HISTORY_TARGET_POINTS);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/HTTP 429/.test(msg)) markCooldown("coingecko", "rate-limit (history HTTP 429)");
    return null;
  }
}

async function fetchHistoryFromCryptoCompare(ticker: string): Promise<number[] | null> {
  if (isOnCooldown("cryptocompare")) return null;
  const t = ticker.toUpperCase();
  // 24 hours @ 1-hour granularity = 24 points. Matches HISTORY_TARGET_POINTS exactly.
  const url = `${CRYPTOCOMPARE_HISTOHOUR}?fsym=${encodeURIComponent(t)}&tsym=USD&limit=23`;
  try {
    type Row = { time: number; close: number };
    const json = await proxyGetJson<{ Response?: string; Data?: { Data?: Row[] } }>(url, {
      accept: "application/json",
    });
    if (json.Response !== "Success") return null;
    const rows = json.Data?.Data ?? [];
    const closes = rows.map((r) => r.close).filter((n) => Number.isFinite(n) && n > 0);
    if (closes.length === 0) return null;
    return closes.slice(-HISTORY_TARGET_POINTS);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/HTTP 429/.test(msg)) markCooldown("cryptocompare", "rate-limit (history HTTP 429)");
    return null;
  }
}

/**
 * 2026-06-14 — BATCHED 24h history. One CoinGecko `/coins/markets` request
 * returns the 7-day hourly sparkline for EVERY id at once; we slice the last
 * ~24 points (≈24h) per asset. This replaces the per-ticker `/market_chart`
 * fan-out (one call per coin, staggered) that reliably tripped CoinGecko's
 * free-tier 429 → 5-min cooldown, which blanked `priceHistoryByTicker` so
 * every chart fell back to the SAME shared placeholder array — the reported
 * "all charts look identical" bug. A single request also dodges the stagger
 * budget and warms the cache for all held assets in one shot.
 */
async function fetchHistoryBatchedFromCoinGecko(
  tickers: string[]
): Promise<Record<string, number[]>> {
  if (isOnCooldown("coingecko")) return {};
  // id → tickers (POL/MATIC share one id; map the result back to both).
  const idToTickers = new Map<string, string[]>();
  for (const t of tickers) {
    const id = TICKER_TO_COINGECKO_ID[t.toUpperCase()];
    if (!id) continue;
    const arr = idToTickers.get(id) ?? [];
    arr.push(t.toUpperCase());
    idToTickers.set(id, arr);
  }
  const ids = Array.from(idToTickers.keys());
  if (ids.length === 0) return {};
  const url =
    `${COINGECKO_MARKETS_URL}?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}` +
    `&sparkline=true&price_change_percentage=24h&per_page=250&page=1`;
  try {
    type Row = { id: string; sparkline_in_7d?: { price?: number[] } };
    const rows = await proxyGetJson<Row[]>(url, { accept: "application/json" });
    if (!Array.isArray(rows)) return {};
    const out: Record<string, number[]> = {};
    for (const row of rows) {
      const spark = row.sparkline_in_7d?.price;
      if (!Array.isArray(spark) || spark.length === 0) continue;
      // Last HISTORY_TARGET_POINTS hourly points ≈ the trailing 24h window,
      // so the views' first-vs-last 24h delta math stays a 24h delta.
      const last = spark
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(-HISTORY_TARGET_POINTS);
      if (last.length === 0) continue;
      for (const tk of idToTickers.get(row.id) ?? []) {
        out[tk] = last;
        historyCache.set(tk, { at: Date.now(), values: last });
      }
    }
    return out;
  } catch (e: any) {
    // 2026-06-14 REGRESSION FIX: do NOT markCooldown here. A 429 on the
    // (heavy) batched markets endpoint must not poison the SHARED coingecko
    // cooldown — that gate also guards the per-ticker history FALLBACK below
    // (`fetchHistoryFromCoinGecko`) AND the spot price path, so poisoning it
    // made portrait charts go flat and dropped USD values for 5 min on every
    // batch 429. Returning {} simply hands off to the per-ticker fallback,
    // which has its own (correct, per-light-endpoint) 429 handling.
    void e;
    return {};
  }
}

async function fetchHistoryForTicker(ticker: string): Promise<number[] | null> {
  const cached = historyCache.get(ticker);
  if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL_MS) {
    return cached.values;
  }
  const existing = historyInflight.get(ticker);
  if (existing) return existing;

  const promise = (async () => {
    // Try CoinGecko first (richer 5-min data), then CryptoCompare
    // (1-hour granularity, more lenient rate limits).
    const a = await fetchHistoryFromCoinGecko(ticker);
    if (a && a.length > 0) {
      historyCache.set(ticker, { at: Date.now(), values: a });
      return a;
    }
    const b = await fetchHistoryFromCryptoCompare(ticker);
    if (b && b.length > 0) {
      historyCache.set(ticker, { at: Date.now(), values: b });
      return b;
    }
    return cached?.values ?? null;
  })().finally(() => {
    historyInflight.delete(ticker);
  });
  historyInflight.set(ticker, promise);
  return promise;
}

/**
 * Fetch 24h USD price history for each ticker. Returns a map keyed by
 * uppercase ticker; tickers we couldn't fetch are simply absent.
 *
 * Calls stagger to stay well under any provider's free-tier rate limit,
 * but cached tickers don't add to the stagger budget — we only sleep
 * after a fetch that actually hit the network. With a warm 15-minute
 * cache, a full 19-coin sweep is instant (zero network).
 */
export async function fetchUsdPriceHistory(
  tickers: string[]
): Promise<Record<string, number[]>> {
  const upper = Array.from(
    new Set(tickers.map((t) => t.toUpperCase()).filter((t) => TICKER_TO_COINGECKO_ID[t]))
  );
  const out: Record<string, number[]> = {};

  // 1) Serve warm cache (zero network).
  const need: string[] = [];
  for (const ticker of upper) {
    const cached = historyCache.get(ticker);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL_MS) {
      out[ticker] = cached.values;
    } else {
      need.push(ticker);
    }
  }
  if (need.length === 0) return out;

  // 2) ONE batched request covers everything we still need.
  Object.assign(out, await fetchHistoryBatchedFromCoinGecko(need));

  // 3) Per-ticker fallback ONLY for whatever the batch didn't return (rare:
  //    a brand-new coin absent from /markets, or a batch 429). Staggered, and
  //    CAPPED.
  //
  //    The cap matters because of how the two failure modes compose. If the
  //    batch 429s, `isOnCooldown("coingecko")` suppresses it for
  //    COOLDOWN_AFTER_429_MS (5 min) — during which EVERY ticker lands here,
  //    and this loop is sequential with a 1.5s sleep between each. A ~19-asset
  //    wallet then spends ~28s per refresh, for five minutes, re-requesting
  //    from a provider that just rate-limited us. That is slower than useless:
  //    it's the behaviour most likely to extend the rate limit.
  //
  //    Sparklines are decorative — a missing one renders as a flat placeholder
  //    and costs the user nothing. So we fetch a handful and drop the rest;
  //    the 15-minute history cache means the next sweep picks up where this
  //    one stopped, and a warm cache skips this path entirely.
  const stillMissing = need.filter((t) => !out[t]);
  const budget = stillMissing.slice(0, HISTORY_FALLBACK_MAX);
  for (let i = 0; i < budget.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_MS));
    const values = await fetchHistoryForTicker(budget[i]);
    if (values && values.length > 0) out[budget[i]] = values;
  }
  if (stillMissing.length > budget.length) {
    console.warn(
      `[usd-prices] history fallback capped: fetched ${budget.length} of ` +
        `${stillMissing.length} missing tickers (${stillMissing
          .slice(budget.length)
          .join(", ")} skipped this pass). Their sparklines stay empty until ` +
        `the next sweep — the batched /markets call is the fast path and is ` +
        `likely on 429 cooldown right now.`
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test/diagnostic helpers (not part of the public surface but useful for
// the Settings panel and integration tests)
// ---------------------------------------------------------------------------

export function _resetCachesForTests(): void {
  spotCache = null;
  lastGoodByTicker = {};
  historyCache.clear();
  cooldownUntil.coingecko = 0;
  cooldownUntil.coinpaprika = 0;
  cooldownUntil.cryptocompare = 0;
  _warnedReasons.clear();
  // Disk-persistence state (2026-08-23). Reset so each test's hydration
  // attempt is independent rather than reusing a previous test's resolved
  // (and in the vitest environment, always store-less) attempt.
  hydrated = null;
  _priceStore = null;
}

export function _getProviderCooldowns(): Record<Provider, number> {
  return { ...cooldownUntil };
}
