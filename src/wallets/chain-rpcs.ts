/**
 * Centralized chain RPC defaults — single source of truth.
 *
 * Every per-chain default endpoint list lives here. The wallet adapter
 * layer (`eth-wallet.ts`), the swap broadcast layer (`swap-execute.ts`
 * EVM branch + `swap-sources.ts` for SOL/NEAR/UTXO), and the Settings
 * → NETWORK test panel all read from this same `RPC_DEFAULTS` map.
 *
 * Each list is iterated in order on every read/broadcast. Three failure
 * categories are caught + skipped before the next URL is tried:
 *   1. Connection-level — TCP RESET, timeout, DNS failure
 *   2. HTTP-level — anything other than 2xx
 *   3. JSON-RPC-level — `error.code` field on a 200 OK response,
 *      including `-32046` "Cannot fulfill request" (the Cloudflare-eth
 *      pattern) and `-32000` "Unauthorized: API key required" (the
 *      Ankr-everywhere pattern that emerged in 2025).
 *
 * Per-chain env override: `VITE_<KEY>_RPC_URL` (or `_API_URL` for the
 * REST-style UTXO/blockchair chains) takes precedence over the defaults
 * but does NOT replace them — the defaults stay as a fallback in case
 * the override URL itself flakes.
 *
 * ## Audit history
 *
 * Re-audit with:  npm run check-rpc-endpoints
 *
 * That script probes every entry below with the request shape each endpoint
 * actually expects, sequentially (a concurrent burst rate-limits us and
 * reports healthy hosts as dead), and fails if any chain's PRIMARY is down.
 *
 * It exists because the 2026-05-06 hand-audit had rotted by 2026-08-13: two of
 * ETH's four endpoints had died and BOTH were ordered ahead of the two that
 * still worked, so every ETH balance read burned a failed request first. The
 * only user-visible symptom was "the wallet feels slow". A hand audit is a
 * snapshot of a system that changes without telling you — run the script.
 *
 * `✗` markers below are from the 2026-08-13 sweep. See `RPC_AUDIT.md` for the
 * older per-endpoint record. Providers paywall public access more often than
 * they used to. Specifically, the following providers' formerly-free
 * endpoints turned hostile in 2025:
 *   - `rpc.ankr.com/<chain>` — now `-32000 Unauthorized` for ETH /
 *     AVAX / POL / ARB / BASE / OP / BSC. Strangely still works for
 *     Flare. Treat as paywalled — only listed when verified.
 *   - `polygon-rpc.com` — `-32051 API key disabled, tenant disabled`
 *     (different from generic 401 — they explicitly disabled the
 *     anonymous tenant).
 *   - `cloudflare-eth.com` — `-32046 Cannot fulfill request` on most
 *     methods. Live HTTP, dead RPC. NEVER add it back.
 *   - `polygon.llamarpc.com` — DNS does not resolve. LlamaNodes never
 *     published Polygon under that subdomain pattern.
 */

export type ChainKey =
  | "ETH"
  | "AVAX"
  | "POL"
  | "FLR"
  | "ARB"
  | "BASE"
  | "OP"
  | "BSC"
  | "MONAD"
  | "SOL"
  | "NEAR"
  | "BTC"
  | "LTC"
  | "DOGE"
  | "BCH"
  | "DASH"
  | "STELLAR"
  | "SUI";

/** What method the Test panel uses to verify a chain's endpoints. */
export type ProbeKind =
  | "evm" // POST eth_blockNumber → expect "result":"0x…"
  | "solana" // POST getSlot → expect "result":<integer>
  | "near" // POST status → expect "chain_id":"mainnet"
  | "esplora" // GET /blocks/tip/height → expect plain integer body
  | "blockchair" // GET /stats → expect "data":{"blocks":<n>}
  | "graphql"; // POST {chainIdentifier} → expect "data":{"chainIdentifier":…}

export interface ChainConfig {
  /** Display label for Settings → NETWORK. */
  label: string;
  probe: ProbeKind;
  /** Env-var name. `_RPC_URL` for JSON-RPC chains, `_API_URL` for REST. */
  envVar: string;
  /** Audited-and-verified defaults (see RPC_AUDIT.md). Tried in order. */
  defaults: readonly string[];
}

/* eslint-disable @typescript-eslint/quotes */
export const RPC_DEFAULTS: Record<ChainKey, ChainConfig> = {
  // ── EVM family ────────────────────────────────────────────────
  ETH: {
    label: "Ethereum",
    probe: "evm",
    envVar: "VITE_ETH_RPC_URL",
    defaults: [
      // REORDERED 2026-08-13 after re-probing every entry. The list was
      // ordered by a 2026-05-06 audit; two of those endpoints have since
      // gone down, and both sat AHEAD of working ones — so every ETH
      // balance read burned a failed request (and, for blockrazor, risked
      // a full connect-timeout stall) before reaching a live node.
      //   eth.llamarpc.com    -> HTTP 521 (Cloudflare: origin down)
      //   eth.blockrazor.xyz  -> connection failure, no HTTP response
      // Re-probe with: curl -s -o /dev/null -w '%{http_code} %{time_total}' \
      //   -X POST -H 'content-type: application/json' \
      //   -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' <url>
      "https://eth.drpc.org", // ✓ re-verified 2026-08-13, 134ms
      "https://ethereum-rpc.publicnode.com", // ✓ re-verified 2026-08-13, 113ms (blocked on some networks)
      // Kept as last resorts in case they come back; both dead as of 2026-08-13.
      "https://eth.llamarpc.com", // ✗ 521 as of 2026-08-13 (was ✓ 281ms 2026-05-06)
      "https://eth.blockrazor.xyz", // ✗ no response as of 2026-08-13 (was ✓ 549ms)
      // REMOVED 2026-05-06 (post-audit, devtools repro): `eth.merkle.io`
      // — server returns no Access-Control-Allow-Origin for
      // localhost:1420 (Tauri dev origin). ethers v6 then infinitely
      // retries `_detectNetwork` (1s backoff, no max-retry by default),
      // spamming the console hundreds of lines/min. The curl-based
      // audit didn't catch it because curl ignores CORS. We now add
      // `staticNetwork: true` to JsonRpcProvider so future browser-
      // hostile RPCs at least don't loop, and we drop merkle.io
      // because even with the loop fixed, every call would still error.
    ],
  },
  AVAX: {
    label: "Avalanche",
    probe: "evm",
    envVar: "VITE_AVAX_RPC_URL",
    defaults: [
      "https://avalanche.drpc.org", // ✓ 252ms, fastest
      "https://api.avax.network/ext/bc/C/rpc", // ✓ 381ms, official
      "https://avalanche-c-chain-rpc.publicnode.com", // ✓ 466ms
      "https://1rpc.io/avax/c", // ✓ 798ms, 4th provider
    ],
  },
  POL: {
    label: "Polygon",
    probe: "evm",
    envVar: "VITE_POL_RPC_URL",
    defaults: [
      // polygon-rpc.com (2025) and polygon.llamarpc.com (no DNS) BOTH
      // dropped — see RPC_AUDIT.md.
      "https://polygon.drpc.org", // ✓ 267ms, fastest verified
      "https://polygon-bor-rpc.publicnode.com", // ✓ 491ms
      "https://1rpc.io/matic", // ✓ 518ms
      // ✗ 2026-08-13: HTTP 403 — key required. Already last; harmless.
      "https://polygon-pokt.nodies.app", // ✓ 934ms
    ],
  },
  FLR: {
    label: "Flare",
    probe: "evm",
    envVar: "VITE_FLR_RPC_URL",
    defaults: [
      // Flare has the thinnest public ecosystem of any chain we list.
      // Note: drpc.org explicitly returns "Unknown network" for Flare;
      // publicnode.com has no Flare endpoint at all.
      "https://flare-api.flare.network/ext/C/rpc", // ✓ 466ms, official
      "https://rpc.ankr.com/flare", // ✓ 408ms (Ankr Flare is one of the few still-free Ankr endpoints)
      "https://flare.gateway.tenderly.co", // ✓ 744ms, third option
    ],
  },
  ARB: {
    label: "Arbitrum One",
    probe: "evm",
    envVar: "VITE_ARB_RPC_URL",
    defaults: [
      "https://arbitrum.drpc.org", // ✓ 355ms
      "https://arbitrum-one-rpc.publicnode.com", // ✓ 379ms
      "https://arb1.arbitrum.io/rpc", // ✓ 446ms, official
      "https://1rpc.io/arb", // ✓ 444ms
    ],
  },
  BASE: {
    label: "Base",
    probe: "evm",
    envVar: "VITE_BASE_RPC_URL",
    defaults: [
      "https://base.drpc.org", // ✓ 280ms, fastest
      "https://base-rpc.publicnode.com", // ✓ 372ms
      "https://mainnet.base.org", // ✓ 434ms, official
      // ✗ 2026-08-13: HTTP 521 (origin down), same as eth.llamarpc.com.
      // Already last, so it costs nothing.
      "https://base.llamarpc.com", // ✓ 459ms
    ],
  },
  OP: {
    label: "Optimism",
    probe: "evm",
    envVar: "VITE_OP_RPC_URL",
    defaults: [
      "https://optimism.drpc.org", // ✓ 326ms, fastest
      "https://optimism-rpc.publicnode.com", // ✓ 394ms
      "https://1rpc.io/op", // ✓ 409ms
      "https://mainnet.optimism.io", // ✓ 703ms, official
    ],
  },
  BSC: {
    label: "BNB Smart Chain",
    probe: "evm",
    envVar: "VITE_BSC_RPC_URL",
    defaults: [
      "https://bsc-dataseed2.binance.org", // ✓ 245ms, fastest
      "https://bsc.drpc.org", // ✓ 294ms
      "https://bsc-dataseed1.binance.org", // ✓ 334ms
      "https://bsc-rpc.publicnode.com", // ✓ 467ms
    ],
  },
  MONAD: {
    label: "Monad",
    probe: "evm",
    envVar: "VITE_MONAD_RPC_URL",
    defaults: [
      // Monad mainnet — chain id 143. Public RPC infrastructure is new
      // (Monad launched 2026 Q1) so the list is conservative; expand
      // post-launch verification.
      "https://rpc.monad.xyz",
      // ✗ 2026-08-13: HTTP 404 — endpoint gone. MONAD has no live fallback.
      "https://monad-rpc.publicnode.com",
    ],
  },

  // ── Other chains ─────────────────────────────────────────────
  SOL: {
    label: "Solana",
    probe: "solana",
    envVar: "VITE_SOL_RPC_URL",
    defaults: [
      // Solana public RPC is the most paywalled across the major chains.
      // The official node here rate-limits aggressively (~100/min); most
      // alternative providers require a key. For light wallet use this
      // is enough; serious volume → set VITE_SOL_RPC_URL to a paid
      // service.
      "https://api.mainnet-beta.solana.com", // ✓ 1233ms (slow, often the only one)
      // ✗ 2026-08-13: no response at all (connection refused).
      "https://solana-rpc.publicnode.com", // not verifiable from sandbox; reported working from user networks
      // ✗ 2026-08-13: HTTP 400 "chain is not available on free plan, please
      // upgrade" — drpc paywalled Solana. Never going to serve a balance.
      //
      // NOTE: with both fallbacks dead, SOL rides on api.mainnet-beta alone —
      // a public endpoint that DOES rate-limit under load. This is the least
      // redundant chain in the map. A replacement must also be added to
      // ALLOWED_HOST_SUFFIXES in src-tauri/src/http_proxy.rs, and the
      // allowlisted candidates were all checked on 2026-08-13:
      // rpc.ankr.com/solana -> 403 (key), *.publicnode -> 404, nodereal -> dead.
      "https://solana.drpc.org", // free-tier limited; included as last resort
    ],
  },
  NEAR: {
    label: "NEAR",
    probe: "near",
    envVar: "VITE_NEAR_RPC_URL",
    defaults: [
      "https://near.drpc.org", // ✓ 368ms, fastest
      "https://1rpc.io/near", // ✓ 490ms
      "https://rpc.fastnear.com", // ✓ 633ms
      "https://near.lava.build", // ✓ 899ms
      "https://rpc.mainnet.near.org", // ✓ 2363ms, official but heavily rate-limited
    ],
  },

  // ── UTXO / REST API chains ───────────────────────────────────
  BTC: {
    label: "Bitcoin",
    probe: "esplora",
    envVar: "VITE_BTC_API_URL",
    defaults: [
      "https://mempool.space/api", // ✓ 1262ms
      "https://mempool.emzy.de/api", // ✓ 658ms, mempool mirror
      "https://blockstream.info/api", // ✓ 312ms (was the original)
    ],
  },
  LTC: {
    label: "Litecoin",
    probe: "esplora",
    envVar: "VITE_LTC_API_URL",
    defaults: [
      // LTC is thin on public esplora-style hosts. Atomicwallet uses
      // blockbook (different API), so dropped from here.
      "https://litecoinspace.org/api", // ✓ 666ms, only verified esplora-compatible
    ],
  },
  DOGE: {
    label: "Dogecoin",
    probe: "blockchair",
    envVar: "VITE_DOGE_API_URL",
    defaults: [
      // BlockCypher rate-limits aggressively from any single IP; using
      // Blockchair as the primary instead. Endpoint format:
      // <base>/<chain>/stats returns {data: {blocks: N, ...}}.
      "https://api.blockchair.com/dogecoin", // ✓ verified
    ],
  },
  BCH: {
    label: "Bitcoin Cash",
    probe: "blockchair",
    envVar: "VITE_BCH_API_URL",
    defaults: [
      "https://api.blockchair.com/bitcoin-cash", // ✓ verified
      // haskoin.com/bch — verified working but uses a different REST
      // API (custom format, not blockchair-compatible). Listed as a
      // fallback because the existing BCH wallet adapter knows that
      // shape.
      // ✗ 2026-08-13: HTTP 404 on every path tried — endpoint gone.
      "https://api.haskoin.com/bch", // ✓ verified (custom format)
    ],
  },
  DASH: {
    label: "Dash",
    probe: "blockchair",
    envVar: "VITE_DASH_API_URL",
    defaults: [
      // BlockCypher Dash mainnet endpoint — broad surface (UTXO + tx + broadcast).
      "https://api.blockcypher.com/v1/dash/main",
      // Blockchair Dash — fallback for stats / UTXO / broadcast.
      "https://api.blockchair.com/dash",
    ],
  },
  STELLAR: {
    label: "Stellar",
    probe: "evm", // Horizon doesn't speak JSON-RPC; probe re-uses the EVM kind for compatibility but is not actually probed.
    envVar: "VITE_STELLAR_RPC_URL",
    defaults: [
      "https://horizon.stellar.org",
      "https://horizon.stellar.lobstr.co",
    ],
  },
  SUI: {
    label: "Sui",
    // GraphQL, NOT JSON-RPC — see the migration note below.
    probe: "graphql",
    envVar: "VITE_SUI_RPC_URL",
    defaults: [
      // MIGRATED 2026-08-14 from JSON-RPC to GraphQL.
      //
      // Mysten permanently deactivated JSON-RPC on public Sui fullnodes on
      // 2026-07-31 (announced; full code removal lands mid-Oct 2026). The old
      // primary, fullnode.mainnet.sui.io, still answers HTTP 200 — but every
      // method, `rpc.discover` included, returns
      //   -32601 "JSON-RPC on public fullnodes has been deprecated.
      //           Please migrate to gRPC or GraphQL endpoints."
      // so SUI balances silently stopped loading two weeks before anyone
      // noticed. A health check that reads only status codes sees a 200 and
      // calls that healthy, which is why `check-rpc-endpoints.mjs` now probes
      // for the DATA each chain is supposed to return, not just for a reply.
      //
      // Verified live 2026-08-14 — returns Sui mainnet's real chain id
      // (4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S):
      //   curl -X POST https://graphql.mainnet.sui.io/graphql \
      //     -H 'content-type: application/json' -d '{"query":"{chainIdentifier}"}'
      "https://graphql.mainnet.sui.io/graphql",
      //
      // ⚠ SUI HAS NO FALLBACK. This is the only public mainnet GraphQL
      // endpoint that could be verified working, and listing a dead URL next
      // to it would buy latency, not redundancy. Probed and rejected
      // 2026-08-14 — re-check before adding any of them back:
      //   sui-mainnet.mystenlabs.com  TLS handshake aborts (unexpected EOF).
      //                               DNS + TCP fine, so it is decommissioned,
      //                               not blocked. Sui's own docs still name
      //                               it — the docs are stale.
      //   sui-mainnet.public.blastapi.io  HTTP 403, retired to Alchemy.
      //   rpc.ankr.com/sui            now demands an API key (and is still
      //                               JSON-RPC, so it dies in Oct 2026 anyway).
      //   sui-mainnet-rpc.nodereal.io no response since 2026-08-13.
      //   *.blockvision.org, sui.publicnode.com  404 — no GraphQL route.
    ],
  },
};
/* eslint-enable @typescript-eslint/quotes */

/* ─── env override resolution ────────────────────────────────── */

function envOrDefaults(envName: string, defaults: readonly string[]): string[] {
  const env = import.meta.env as Record<string, string | undefined>;
  const primary = env[envName];
  // Back-compat: also honor `VITE_<KEY>_RPC` (without `_URL`) and
  // `VITE_<KEY>_API` for the older naming.
  const legacy = env[envName.replace(/_(URL|RPC_URL|API_URL)$/, "_RPC")] ??
    env[envName.replace(/_URL$/, "")];
  const override =
    primary && primary.length > 0
      ? primary
      : legacy && legacy.length > 0
        ? legacy
        : null;
  return override ? [override, ...defaults] : [...defaults];
}

/**
 * Browser-without-Tauri: hoist a CORS-permissive ETH endpoint to
 * position 0 so the dev-only Vite dashboard (`npm run dev:sandbox`)
 * doesn't spam the console with `Access-Control-Allow-Origin`
 * rejections from `eth.llamarpc.com`.
 *
 * Why this exists at all: production Tauri builds route every chain
 * RPC through the Rust `http_proxy_call` + `evm_broadcast_verified`
 * paths, which use `reqwest` — no browser CORS involvement. But
 * `dev:sandbox` (browser-only Vite, no Tauri runtime) makes the same
 * `fetch()` calls directly from the webview, and `eth.llamarpc.com`
 * returns no `Access-Control-Allow-Origin` for `http://localhost:1421`.
 * The dashboard hits ETH balance on mount, the call fails-then-retries,
 * and the console fills with red CORS errors that drown out real signal.
 *
 * Trigger: only when `window` is defined (so it's a browser, not a
 * vitest/node context) AND `__TAURI_INTERNALS__` is NOT defined (so
 * Tauri's webview bridge isn't there, meaning we ARE in a plain
 * browser tab — likely `dev:sandbox`). In Tauri runtime both
 * conditions fail and the list stays in production order.
 *
 * Scope: only `ETH` today. Add other chains here if their `dev:sandbox`
 * console gets noisy with the same shape of error. See
 * `wiki/concepts/dev-mode-cors.md` for the audit + criteria.
 */
function reorderForBrowserCors(chain: ChainKey, list: string[]): string[] {
  if (chain !== "ETH") return list;
  const w = typeof window !== "undefined" ? (window as { __TAURI_INTERNALS__?: unknown }) : null;
  const isBrowserWithoutTauri = w !== null && w.__TAURI_INTERNALS__ == null;
  if (!isBrowserWithoutTauri) return list;
  // CORS-permissive — verified to send `Access-Control-Allow-Origin: *`
  // from the publicnode infrastructure (2026-05-26). The pre-existing
  // comment on this entry in `RPC_DEFAULTS.ETH` called it "last-resort:
  // blocked on some networks" — that's a corporate-firewall concern
  // (publicnode is sometimes filtered), NOT a CORS concern. For the
  // dev-mode console-spam case, CORS-permissive trumps firewall risk
  // since the dev environment is the developer's own machine.
  const CORS_FRIENDLY = "https://ethereum-rpc.publicnode.com";
  const idx = list.indexOf(CORS_FRIENDLY);
  if (idx === 0) return list;
  if (idx === -1) return [CORS_FRIENDLY, ...list];
  return [CORS_FRIENDLY, ...list.slice(0, idx), ...list.slice(idx + 1)];
}

/** Resolve the active fallback list for a chain. Env override (if set)
 *  is prepended; defaults stay as fallback. Browser-without-Tauri also
 *  gets a CORS reorder for ETH — see `reorderForBrowserCors` above. */
export function rpcsFor(chain: ChainKey): string[] {
  const cfg = RPC_DEFAULTS[chain];
  const withEnvOverride = envOrDefaults(cfg.envVar, cfg.defaults);
  return reorderForBrowserCors(chain, withEnvOverride);
}

// Per-chain convenience wrappers (back-compat with the prior round's
// API). Each returns the resolved fallback list, env override prepended.
export const ETH_RPCS = (): string[] => rpcsFor("ETH");
export const AVAX_RPCS = (): string[] => rpcsFor("AVAX");
export const POL_RPCS = (): string[] => rpcsFor("POL");
export const FLR_RPCS = (): string[] => rpcsFor("FLR");
export const ARB_RPCS = (): string[] => rpcsFor("ARB");
export const BASE_RPCS = (): string[] => rpcsFor("BASE");
export const OP_RPCS = (): string[] => rpcsFor("OP");
export const BSC_RPCS = (): string[] => rpcsFor("BSC");
export const MONAD_RPCS = (): string[] => rpcsFor("MONAD");
export const SOL_RPCS = (): string[] => rpcsFor("SOL");
export const NEAR_RPCS = (): string[] => rpcsFor("NEAR");
export const BTC_APIS = (): string[] => rpcsFor("BTC");
export const LTC_APIS = (): string[] => rpcsFor("LTC");
export const DOGE_APIS = (): string[] => rpcsFor("DOGE");
export const BCH_APIS = (): string[] => rpcsFor("BCH");
export const DASH_APIS = (): string[] => rpcsFor("DASH");
export const STELLAR_APIS = (): string[] => rpcsFor("STELLAR");
export const SUI_APIS = (): string[] => rpcsFor("SUI");

/* ─── error type ─────────────────────────────────────────────── */

export class AllRpcsFailedError extends Error {
  readonly name = "AllRpcsFailedError";
  readonly urlsAttempted: string[];
  readonly perUrlErrors: Array<{ url: string; error: string }>;

  constructor(args: {
    message: string;
    urlsAttempted: string[];
    perUrlErrors: Array<{ url: string; error: string }>;
  }) {
    super(args.message);
    this.urlsAttempted = args.urlsAttempted;
    this.perUrlErrors = args.perUrlErrors;
    Object.setPrototypeOf(this, AllRpcsFailedError.prototype);
  }
}

/* ─── fallback iteration ─────────────────────────────────────── */

/**
 * Try `fn` against each URL in `urls`, returning the first success.
 * Throws `AllRpcsFailedError` only when every URL has failed.
 */
export async function tryRpcUrls<T>(
  urls: string[],
  fn: (url: string) => Promise<T>,
  ticker?: string,
): Promise<T> {
  const errors: Array<{ url: string; error: string }> = [];
  for (const url of urls) {
    try {
      return await fn(url);
    } catch (e) {
      errors.push({ url, error: String((e as Error)?.message ?? e) });
      continue;
    }
  }
  const chainLabel = ticker ? ` for ${ticker}` : "";
  throw new AllRpcsFailedError({
    message:
      `Cannot reach the network${chainLabel}. ` +
      `Tried ${urls.length} RPC${urls.length === 1 ? "" : "s"}; ` +
      `all failed. Set VITE_${ticker ? `${ticker}_` : ""}RPC_URL ` +
      `in .env.local to a working endpoint and rebuild.`,
    urlsAttempted: urls,
    perUrlErrors: errors,
  });
}

/* ─── single-URL probes (one per probe kind) ─────────────────── */

async function probeEvm(url: string, timeoutMs = 6000): Promise<string> {
  return jsonRpcSingleUrl(url, "eth_blockNumber", [], timeoutMs);
}

/**
 * GraphQL liveness probe (Sui).
 *
 * Asks for `chainIdentifier` and insists on getting one back. GraphQL reports
 * errors inside a 200 body, so "did it reply?" is not the question — a
 * decommissioned API replies all day. Checking for the field means the probe
 * fails when the API stops answering, which is the whole point.
 */
async function probeGraphQl(url: string, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ chainIdentifier }" }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = (await resp.json()) as {
      data?: { chainIdentifier?: string };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
    const id = j.data?.chainIdentifier;
    if (!id) throw new Error("200 OK but no chainIdentifier — API may be retired");
    return id;
  } finally {
    clearTimeout(timer);
  }
}

async function probeSolana(url: string, timeoutMs = 8000): Promise<string> {
  const result = await jsonRpcSingleUrlAny(url, "getSlot", [], timeoutMs);
  if (typeof result === "number") return result.toString();
  if (typeof result === "string") return result;
  throw new Error(`unexpected getSlot result type: ${typeof result}`);
}

async function probeNear(url: string, timeoutMs = 8000): Promise<string> {
  // NEAR's `status` RPC returns `chain_id` inside the result envelope,
  // not at top level. We accept any non-error response with a
  // `chain_id` somewhere.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!/"chain_id"\s*:\s*"mainnet"/.test(text)) {
      throw new Error(`no mainnet chain_id in response (got ${text.slice(0, 120)})`);
    }
    return "ok";
  } finally {
    clearTimeout(timer);
  }
}

async function probeEsplora(url: string, timeoutMs = 6000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/blocks/tip/height`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = (await resp.text()).trim();
    if (!/^\d+$/.test(text)) {
      throw new Error(`expected plain integer, got ${text.slice(0, 80)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function probeBlockchair(url: string, timeoutMs = 6000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Blockchair stats endpoints take the chain name as path segment
    // (e.g. https://api.blockchair.com/dogecoin/stats). When the URL
    // already ends in a chain name, we just append /stats. The custom
    // haskoin BCH endpoint is the exception — it's just /health or
    // similar; we accept any 200 OK with JSON containing a number.
    let probeUrl = url.replace(/\/$/, "");
    if (!/\/(stats|health)$/.test(probeUrl)) {
      probeUrl = `${probeUrl}/stats`;
    }
    const resp = await fetch(probeUrl, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (/"blocks"\s*:\s*\{/.test(text)) {
      // haskoin shape: "blocks":{"blocks":N,...}
      const m = text.match(/"blocks"\s*:\s*(\d+)/);
      if (m) return m[1];
    }
    if (/"blocks"\s*:\s*\d+/.test(text)) {
      // blockchair shape: "data":{"blocks":N,...}
      const m = text.match(/"blocks"\s*:\s*(\d+)/);
      if (m) return m[1];
    }
    throw new Error(`no block height in response`);
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRpcSingleUrl(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = 6000,
): Promise<string> {
  const result = await jsonRpcSingleUrlAny(url, method, params, timeoutMs);
  if (typeof result !== "string") {
    throw new Error(`expected string result from ${method}, got ${typeof result}`);
  }
  return result;
}

async function jsonRpcSingleUrlAny(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = 6000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (json.error) {
      const code = json.error.code;
      const msg = json.error.message ?? "rpc error";
      // Specific dedicated diagnostics for the patterns we know about:
      if (code === -32046) {
        throw new Error(
          `${url} returned -32046 "Cannot fulfill request" — endpoint reachable but neutered. Skipping.`,
        );
      }
      if (
        code === -32000 &&
        /Unauthorized|API key/i.test(msg)
      ) {
        throw new Error(`${url} now requires an API key (${msg}).`);
      }
      if (
        code === -32051 &&
        /tenant disabled|API key disabled/i.test(msg)
      ) {
        throw new Error(`${url} closed anonymous tenant (${msg}).`);
      }
      throw new Error(`${msg} (code ${code ?? "?"})`);
    }
    if (json.result === undefined || json.result === null) {
      throw new Error("missing result");
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── public probe API ───────────────────────────────────────── */

/** Probe an entire fallback list with the right method per chain.
 *  Returns the first URL that responds, the response value, and the
 *  measured latency. Throws `AllRpcsFailedError` on total failure. */
export async function probeChain(
  chain: ChainKey,
  urls: string[],
): Promise<{ value: string; latencyMs: number; urlUsed: string }> {
  const cfg = RPC_DEFAULTS[chain];
  const errors: Array<{ url: string; error: string }> = [];
  for (const url of urls) {
    const t0 = performance.now();
    try {
      const value = await runProbe(cfg.probe, url);
      return {
        value,
        latencyMs: Math.round(performance.now() - t0),
        urlUsed: url,
      };
    } catch (e) {
      errors.push({ url, error: String((e as Error)?.message ?? e) });
      continue;
    }
  }
  throw new AllRpcsFailedError({
    message: `All ${urls.length} ${cfg.label} RPCs failed.`,
    urlsAttempted: urls,
    perUrlErrors: errors,
  });
}

async function runProbe(kind: ProbeKind, url: string): Promise<string> {
  switch (kind) {
    case "evm":
      return probeEvm(url);
    case "solana":
      return probeSolana(url);
    case "near":
      return probeNear(url);
    case "esplora":
      return probeEsplora(url);
    case "blockchair":
      return probeBlockchair(url);
    case "graphql":
      return probeGraphQl(url);
  }
}

/* ─── JSON-RPC convenience for swap-execute callers ──────────── */

/**
 * Iterate `urls` calling JSON-RPC `method` with `params` until one
 * returns a string `result`. Used by the EVM swap broadcast path for
 * `eth_getTransactionCount` / `eth_gasPrice`. Same three-layer
 * failure detection (connection / HTTP / json-rpc-error) applies.
 */
export async function jsonRpcCall(
  urls: string[],
  method: string,
  params: unknown[] = [],
  opts: { timeoutMs?: number; ticker?: string } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return tryRpcUrls(
    urls,
    (url) => jsonRpcSingleUrl(url, method, params, timeoutMs),
    opts.ticker,
  );
}

/** Latency-measuring `eth_blockNumber` (back-compat with v1 of this
 *  module). New callers should use `probeChain(chain, urls)`. */
export async function probeRpcList(
  urls: string[],
  ticker?: string,
): Promise<{ blockNumber: string; latencyMs: number; urlUsed: string }> {
  // Equivalent to `probeChain("ETH", urls)` but doesn't require a chain
  // key — kept for the old Settings-panel call site.
  const errors: Array<{ url: string; error: string }> = [];
  for (const url of urls) {
    const t0 = performance.now();
    try {
      const result = await probeEvm(url);
      return {
        blockNumber: result,
        latencyMs: Math.round(performance.now() - t0),
        urlUsed: url,
      };
    } catch (e) {
      errors.push({ url, error: String((e as Error)?.message ?? e) });
      continue;
    }
  }
  throw new AllRpcsFailedError({
    message: `All RPCs failed${ticker ? ` for ${ticker}` : ""}.`,
    urlsAttempted: urls,
    perUrlErrors: errors,
  });
}

/* ─── grouped startup-warn helper ────────────────────────────── */

/** Suppresses repeated console warns for the same chain in a single
 *  session. Use for non-critical balance/init failures so a wallet that
 *  isn't actively using a chain doesn't spam the console with that
 *  chain's RPC failures. */
const _warnedChains = new Set<ChainKey>();

export function warnChainOnce(chain: ChainKey, urlsAttempted: number): void {
  if (_warnedChains.has(chain)) return;
  _warnedChains.add(chain);
  const cfg = RPC_DEFAULTS[chain];
  // eslint-disable-next-line no-console
  console.warn(
    `[network] ${cfg.label.toLowerCase()}: 0 of ${urlsAttempted} RPCs reachable; ` +
      `balance unavailable. Set ${cfg.envVar} in .env.local to override.`,
  );
}
