/**
 * Cache for `/api/intents/tokens` — the live NEAR Intents asset list +
 * per-token min-deposit / min-withdraw amounts + spot prices.
 *
 * Why we cache:
 *   - The dropdown + form re-renders frequently (input keystrokes, hover
 *     state, etc.). Re-fetching every render burns proxy quota.
 *   - Token-level fields (decimals, contract addresses, min-amounts)
 *     change rarely. Even prices update on a roughly 30s server cadence;
 *     stale-by-an-hour prices are fine for swap-form context.
 *   - Auto-refresh on a 1h TTL is cheap and keeps the cache from going
 *     stale across long-running sessions.
 *
 * Refresh is fire-and-forget — if the proxy is unreachable we keep
 * serving the previous cache. Callers receive `null` only on first-load
 * before any successful fetch.
 *
 * The map is keyed by NEP-141 `assetId` (`nep141:eth.omft.near`,
 * `nep141:base-0x83…omft.near`, etc.). For multi-chain symbols (USDC),
 * every chain entry has its own row.
 */

import { proxyGetJson } from "../../wallets/_proxy";
import {
  DEFAULT_PROXY_URL,
  getActiveProxyUrl,
  isCustomProxyActive,
  swapProxyHealthCheck,
} from "../../api/proxy";

export interface NearIntentsToken {
  /** NEP-141 asset id — what 1Click expects in the quote body. */
  assetId: string;
  /** Atomic-units decimals — wei/sat/lamport/yocto exponent. */
  decimals: number;
  /** Lowercase chain id (`eth` / `arb` / `base` / etc.). */
  blockchain: string;
  /** Underlying-asset symbol (`USDC`, `ETH`, `BTC`, …). */
  symbol: string;
  /** USD spot price (last server tick). */
  price?: number;
  /** ISO timestamp the price was last updated. */
  priceUpdatedAt?: string;
  /** ERC-20 / SPL token contract address. Native assets omit this. */
  contractAddress?: string;
  /**
   * Minimum deposit amount (atomic units, decimal string) NEAR Intents
   * accepts for routes ORIGINATING with this token. Below this, 1Click
   * returns a 4xx instead of a quote. Optional — not every asset has
   * one.
   */
  minDepositAmount?: string;
  /**
   * Minimum withdraw amount (atomic units, decimal string) NEAR Intents
   * accepts for routes DELIVERING to this token. Optional — not every
   * asset has one. The form surfaces this when the destination side
   * has a known minimum, but most enforcement is on the deposit side.
   */
  minWithdrawAmount?: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheState {
  /** Map keyed by assetId. */
  byAssetId: Map<string, NearIntentsToken>;
  /** ms epoch of last successful fetch. */
  fetchedAt: number;
  /** Number of tokens last sync produced (for diagnostic display). */
  size: number;
}

let cache: CacheState | null = null;
let inflight: Promise<CacheState> | null = null;

/**
 * Fetch + cache the `/api/intents/tokens` response. Returns the cache
 * map (keyed by assetId). Auto-refreshes when the cache is older than
 * the TTL. Concurrent callers share the same in-flight promise.
 *
 * On failure, returns the existing cache (possibly stale) — callers
 * should treat the result as best-effort, never block on it.
 */
export async function getNearIntentsTokens(): Promise<Map<string, NearIntentsToken>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.byAssetId;
  if (inflight) {
    const next = await inflight;
    return next.byAssetId;
  }

  inflight = (async () => {
    try {
      const next = await fetchTokensFromProxy();
      cache = next;
      return next;
    } catch (e) {
      // Proxy unreachable / 5xx / parse error. Keep serving the
      // previous cache (or an empty map for first-load). One-warn-
      // per-session so we don't spam the console on every form render.
      warnTokenFetchFailureOnce(String((e as Error)?.message ?? e));
      return (
        cache ?? { byAssetId: new Map(), fetchedAt: 0, size: 0 }
      );
    } finally {
      inflight = null;
    }
  })();
  const next = await inflight;
  return next.byAssetId;
}

/**
 * Synchronous accessor for the in-memory cache. Returns null when
 * nothing has been cached yet (first-load, or every fetch has failed).
 * Use this when the caller can't easily await — the form's inline
 * minimum hint, for example, falls back gracefully if the cache hasn't
 * primed yet.
 */
export function getCachedNearIntentsTokens(): Map<string, NearIntentsToken> | null {
  return cache?.byAssetId ?? null;
}

/**
 * Force-refresh the cache. Used by Settings → "Refresh asset list".
 * Returns the new size on success, or rethrows the network error.
 */
export async function refreshNearIntentsTokens(): Promise<number> {
  const next = await fetchTokensFromProxy();
  cache = next;
  return next.size;
}

/**
 * Resolve a token entry by `assetId` from the cache. Returns null when
 * the cache hasn't been primed yet — callers should treat that as "no
 * minimum known, skip the check" rather than failing.
 */
export function lookupTokenByAssetId(assetId: string): NearIntentsToken | null {
  return cache?.byAssetId.get(assetId) ?? null;
}

/** Cache freshness diagnostic — used by the Settings panel display. */
export function getTokensCacheStatus(): {
  fetchedAt: number | null;
  size: number;
  ageMs: number | null;
} {
  if (!cache) return { fetchedAt: null, size: 0, ageMs: null };
  return {
    fetchedAt: cache.fetchedAt,
    size: cache.size,
    ageMs: Date.now() - cache.fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ProxyTokenRow {
  // 1Click's response uses different field names depending on tier;
  // we tolerate a handful of common shapes. Field validation happens
  // in `normalize` below.
  assetId?: string;
  defuseAssetId?: string;
  id?: string;
  symbol?: string;
  ticker?: string;
  decimals?: number | string;
  assetDecimals?: number | string;
  blockchain?: string;
  chain?: string;
  network?: string;
  contractAddress?: string;
  contract?: string;
  price?: number;
  priceUpdatedAt?: string;
  minDepositAmount?: string;
  minimumDepositAmount?: string;
  minWithdrawAmount?: string;
  minimumWithdrawAmount?: string;
}

const BLOCKCHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth",
  arbitrum: "arb",
  optimism: "op",
  polygon: "pol",
  avalanche: "avax",
  "bnb-chain": "bnb",
  bitcoin: "btc",
  solana: "sol",
  dogecoin: "doge",
  ripple: "xrp",
  "ton-chain": "ton",
};

function normalize(row: ProxyTokenRow): NearIntentsToken | null {
  const assetId = row.assetId ?? row.defuseAssetId ?? row.id;
  const symbol = row.symbol ?? row.ticker;
  const decimalsRaw = row.decimals ?? row.assetDecimals;
  const decimals = decimalsRaw != null ? Number(decimalsRaw) : NaN;
  let blockchain = (row.blockchain ?? row.chain ?? row.network ?? "")
    .toString()
    .toLowerCase();
  if (BLOCKCHAIN_ALIASES[blockchain]) blockchain = BLOCKCHAIN_ALIASES[blockchain];
  if (!assetId || !symbol || !Number.isFinite(decimals) || !blockchain) {
    return null;
  }
  const out: NearIntentsToken = {
    assetId,
    symbol: String(symbol).toUpperCase(),
    decimals,
    blockchain,
  };
  const contract = row.contractAddress ?? row.contract;
  if (contract) out.contractAddress = contract;
  if (typeof row.price === "number") out.price = row.price;
  if (typeof row.priceUpdatedAt === "string") out.priceUpdatedAt = row.priceUpdatedAt;
  const minDep = row.minDepositAmount ?? row.minimumDepositAmount;
  if (typeof minDep === "string" && minDep.length > 0) {
    out.minDepositAmount = minDep;
  }
  const minWit = row.minWithdrawAmount ?? row.minimumWithdrawAmount;
  if (typeof minWit === "string" && minWit.length > 0) {
    out.minWithdrawAmount = minWit;
  }
  return out;
}

async function fetchTokensFromProxy(): Promise<CacheState> {
  // Proxy URL is set via `swap_set_proxy_url` at startup. The token
  // catalog is a public endpoint (server-side exempted from SigAuth on
  // 2026-05-26 — see log.md "Round 1 close-out / Fix A"), so we route
  // through the unsigned `proxyGetJson` helper: it gets us past the
  // Tauri webview's origin restriction via the `http_proxy_call`
  // host-allowlist, without attaching the `X-Client-Sig` header that
  // `swap_proxy_*` Tauri commands use for signed endpoints. If the
  // server ever flips this endpoint back to signed-required, swap
  // this fetch over to a new `swap_proxy_get_intents_tokens` Tauri
  // command instead of trying to add signing into `proxyGetJson`
  // (the generic helper is deliberately unsigned).
  const proxyBaseUrl = currentProxyBaseUrl();
  if (!proxyBaseUrl) {
    throw new Error("Proxy base URL not configured");
  }
  let json: unknown;
  if (isCustomProxyActive()) {
    // A user-configured server (Settings -> SWAP RELAY) is not on the
    // `http_proxy_call` host allowlist, so the unsigned webview-side path
    // would be refused in Rust. Route the catalog through the Rust relay
    // client instead — `full: true` returns the untruncated body.
    const r = await swapProxyHealthCheck({ full: true });
    if (r.tokens.error || r.tokens.status < 200 || r.tokens.status >= 300) {
      throw new Error(
        r.tokens.error ?? `tokens catalog HTTP ${r.tokens.status} from custom server`
      );
    }
    json = JSON.parse(r.tokens.body) as unknown;
  } else {
    const url = `${proxyBaseUrl.replace(/\/$/, "")}/api/intents/tokens`;
    json = await proxyGetJson<unknown>(url, {
      accept: "application/json",
    });
  }
  const rawList: ProxyTokenRow[] = Array.isArray(json)
    ? (json as ProxyTokenRow[])
    : Array.isArray((json as { tokens?: ProxyTokenRow[] }).tokens)
      ? (json as { tokens: ProxyTokenRow[] }).tokens
      : Array.isArray((json as { data?: ProxyTokenRow[] }).data)
        ? (json as { data: ProxyTokenRow[] }).data
        : [];
  const byAssetId = new Map<string, NearIntentsToken>();
  for (const row of rawList) {
    const t = normalize(row);
    if (t) byAssetId.set(t.assetId, t);
  }
  return { byAssetId, fetchedAt: Date.now(), size: byAssetId.size };
}

/**
 * The URL the Rust core is actually pointed at (set by `configureProxy` /
 * the Settings server override), falling back to the build-time env vars
 * and the production default for early callers and browser-dev mode where
 * `swap_set_proxy_url` hasn't run.
 */
function currentProxyBaseUrl(): string {
  const active = getActiveProxyUrl();
  if (active) return active;
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_PROXY_URL ?? env?.PWNDA_PROXY_URL ?? DEFAULT_PROXY_URL;
}

let _warnedTokenFetchFailure = false;
function warnTokenFetchFailureOnce(reason: string): void {
  if (_warnedTokenFetchFailure) return;
  _warnedTokenFetchFailure = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[network] near-intents-tokens: ${reason}. Falling back to last cache; ` +
      `minimum-amount enforcement degrades to "no min known, skip the check".`,
  );
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

export function _setCacheForTests(tokens: NearIntentsToken[]): void {
  const map = new Map<string, NearIntentsToken>();
  for (const t of tokens) map.set(t.assetId, t);
  cache = { byAssetId: map, fetchedAt: Date.now(), size: tokens.length };
  _warnedTokenFetchFailure = false;
}

export function _resetCacheForTests(): void {
  cache = null;
  inflight = null;
  _warnedTokenFetchFailure = false;
}
