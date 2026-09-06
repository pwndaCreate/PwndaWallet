//! Generic HTTP proxy for chain-data sources that reject browser-origin
//! requests — the **RPC/CORS relay**.
//!
//! In the project's "proxy" taxonomy this is **(D) the RPC/CORS relay** —
//! distinct from the mining SOCKS5 privacy proxy (B, `proxy_pool.rs`) and
//! the wallet swap relay (C, `src/api/proxy.ts` + `swap_*` commands). The
//! `http_proxy` name / `http_proxy_call` command are kept as-is (API
//! contract); the pure-wallet cutover relabelled only comments + docs.
//!
//! Tauri's webview origin (`tauri://localhost` / `https://tauri.localhost`)
//! is treated as a hostile foreign origin by many public chain-data APIs:
//! some block at the application layer (Solana RPCs return HTTP 403 — see
//! `sol_rpc.rs`), some omit `Access-Control-Allow-Origin` and silently fail
//! the renderer's preflight (Monero/Zephyr `/get_info` — see
//! `wallet_rpc_common::probe_node`). Routing through reqwest in the
//! backend strips both the Origin header and the CORS preflight, so the
//! endpoint sees an ordinary HTTP client.
//!
//! This is the generalized form of `sol_rpc::sol_rpc_call`. Per-chain
//! frontend modules call `http_proxy_call` whenever their declared data
//! sources are 403'd by the webview origin.
//!
//! Security model:
//!   - Hard host-suffix allowlist enforced in [`is_host_allowed`].
//!     New endpoints REQUIRE updating that list — there is no escape hatch.
//!   - HTTPS only.
//!   - 30 s timeout.
//!   - The caller controls request body and headers, but the request never
//!     auto-attaches credentials, cookies, or anything from the host
//!     environment.

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct HttpProxyResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Deserialize)]
pub struct HttpProxyHeader {
    pub name: String,
    pub value: String,
}

/// Host suffixes whose **https** endpoints can be proxied. A request URL's
/// host must end with one of these suffixes (e.g. `eth.blockscout.com`
/// matches `blockscout.com`). Bare-domain matches require the suffix to be
/// the whole host or preceded by `.`.
///
/// Keep this list narrow. Each entry should be a public chain-data
/// provider that we actively use from a wallet adapter. Don't add general-
/// purpose hosts (e.g. `github.com`); use a dedicated command for those.
const ALLOWED_HOST_SUFFIXES: &[&str] = &[
    // Bitcoin / Litecoin / Bitcoin Cash — `blockchair.com` covers all three
    // (BTC history fallback, full LTC balance fallback, BCH primary for
    // balance/UTXO/history/broadcast/fee). `blockstream.info` and
    // `mempool.space` are BTC-only. `fullstack.cash` is BCH-native ElectrumX
    // REST (BCHN-backed); used as the BCH secondary for balance/UTXO/broadcast.
    "blockstream.info",
    "mempool.space",
    "blockchair.com",
    "fullstack.cash",
    // litecoinspace.org — Esplora (Blockstream-API-compatible) LTC instance,
    // the 3rd LTC provider for UTXO/balance/fee/broadcast redundancy (added
    // 2026-06-14 so a signed LTC tx has more than one way out).
    "litecoinspace.org",
    // Ethereum / EVM family — Blockscout instances and Routescan
    "blockscout.com",
    "routescan.io",
    "flare-explorer.flare.network",
    // Solana — public RPCs (also handled by `sol_rpc.rs`, allowlisted here
    // for chain-history calls that go through the generic proxy)
    "solana-rpc.publicnode.com",
    "rpc.ankr.com",
    "solana.drpc.org",
    "api.mainnet-beta.solana.com",
    "publicnode.com",
    // Cardano (Koios — keyless community endpoint)
    "koios.rest",
    "cexplorer.io",
    // XRP (REST fallback)
    "bithomp.com",
    // Tron
    "trongrid.io",
    "tronstack.io",
    "tronscanapi.com",
    // Hedera
    "mirrornode.hedera.com",
    "arkhia.io",
    "hgraph.io",
    // Algorand
    "algonode.cloud",
    "algoexplorerapi.io",
    // Dogecoin / Litecoin — BlockCypher serves both as `/v1/doge/main` and
    // `/v1/ltc/main`. LTC adapter uses it as the primary UTXO + broadcast
    // backend; DOGE uses it as the balance fallback.
    "dogechain.info",
    "blockcypher.com",
    // Bitpay Bitcore (`api.bitcore.io`) — keyless public node API for DOGE + BCH
    // balance. Primary balance source for both adapters (2026-06-17): unlike
    // BlockCypher (~100 req/hr) and Blockchair (free-tier IP blacklist) it isn't
    // rate-capped, and unlike dogechain.info / Trezor BlockBook it has NO
    // Cloudflare bot gate that 403s a programmatic client. The older hosts stay
    // as fallbacks. (Trezor BlockBook was tried first but 403s every request.)
    "bitcore.io",
    // haskoin-store (2026-09-04) — the BTC/BCH indexer behind blockchain.com's
    // own wallet (`api.blockchain.info/haskoin-store/{btc,bch}`) and the
    // project's public instance (`api.haskoin.com`). The ONLY keyless BTC/BCH
    // source with a BATCH balance endpoint (`/address/balances?addresses=…`,
    // 100 per call measured live), which is what makes a BIP-44 gap walk two
    // requests instead of ~90 — bitcore rate-limited the per-address walk at
    // ~10 and a funded BCH account read 0 as a result. Primary probe/UTXO/
    // history source for BCH, batch probe for BTC; the older hosts stay as
    // fallbacks. `blockchain.info` is the whole bare domain: its other paths
    // are the same operator's public explorer API.
    "blockchain.info",
    "haskoin.com",
    // Dash — official Insight explorer API. Keyless, no Cloudflare gate, and the
    // primary balance source for the DASH adapter (2026-06-17): BlockCypher (429)
    // + Blockchair (430) were DASH's only two backends and both fail under load.
    // Bitcore doesn't serve DASH, so Insight is the fix.
    "insight.dash.org",
    // Ravencoin
    "ravencoin.org",
    "ravencoin.network",
    "cryptoscope.io",
    // The official Trezor-style BlockBook for RVN: asset-aware, xpub-friendly,
    // and the most reliable public RVN backend in 2026. Used as the primary
    // history/UTXO source by `rvn-wallet.ts`. Lives at the same domain as the
    // generic Ravencoin org (`ravencoin.org`) so technically already matched
    // by that suffix, but listed explicitly so a future tightening of the
    // org-wide entry doesn't accidentally drop BlockBook coverage.
    "blockbook.ravencoin.org",
    // Conflux
    "confluxscan.io",
    "confluxscan.org",
    "confluxrpc.com",
    "confluxrpc.org",
    // Zephyr Protocol — Scanner API at `zephyrprotocol.com/api/v1/...`.
    // Used for live reserve ratio + asset prices + APY (no daemon RPC
    // exposes these directly). Read-only, unauthenticated, ~30s server
    // cache. See `src/wallets/zph-scanner-api.ts`.
    "zephyrprotocol.com",
    // Ergo — Explorer v1 REST. Primary upstream for the ERG wallet adapter
    // (balance, history, info, unspent boxes, mempool submit). Both bases
    // expose byte-identical schemas — verified via live `/info` probe
    // 2026-05-14. See `src/wallets/erg-rpc.ts` and `src/wallets/erg-wallet.ts`.
    "ergoplatform.com",
    "sigmaspace.io",
    // Sui — JSON-RPC mainnet. `fullnode.mainnet.sui.io` (formerly the
    // official public endpoint, still listed for org-suffix coverage) was
    // DEPRECATED upstream 2026-08-22: every `suix_*` method now returns
    // `-32601 Method not found ... migrate to gRPC or GraphQL`. The wallet
    // adapter no longer calls it — see `publicnode.com` below, which still
    // serves the legacy JSON-RPC surface. `nodereal.io` has no confirmed
    // keyless endpoint (probed 2026-08-22, no response); kept for org-suffix
    // coverage only, not actively used.
    "sui.io",
    "nodereal.io",
    // Stellar — Horizon mainnet REST. Used by `src/wallets/stellar-wallet.ts`
    // for balance/history (`fetchAccount`). Missing entirely until
    // 2026-08-22 — every call was rejected by `is_host_allowed` before ever
    // reaching the network, which is why the wallet showed "Stellar not
    // loaded" on every session, not intermittently.
    "horizon.stellar.org",
    // Pwnda's own swap proxy + NEAR Intents catalog at
    // `wallet.pwnda.org/api/intents/tokens`. The dedicated `swap_proxy_*`
    // Tauri commands have their own codepath, but the live token-catalog
    // refresh in `src/features/swap/near-intents-tokens.ts` goes through
    // the generic `proxyGetJson` and so needs this allowlist entry.
    // Without it the catalog falls back to stale cache and minimum-amount
    // enforcement on NEAR Intents quotes silently degrades to
    // "no min known, skip the check".
    "pwnda.org",
    // USD price providers — chain-agnostic price + 24h history. CoinGecko
    // is primary; CoinPaprika and CryptoCompare are anonymous-tier
    // fallbacks used when CoinGecko 429s the user's IP. See
    // `src/wallets/usd-prices.ts`. All read-only, no key required.
    "coingecko.com",
    "coinpaprika.com",
    "cryptocompare.com",
    "min-api.cryptocompare.com",
    // BasicSwap public market snapshot — the P2P order book as seen by a
    // third-party scraper of the Particl SMSG network, republished as static
    // JSON (`/orderbook.json`). Read by
    // `src/features/swap-sidecar/marketsSnapshot.ts` so the Swap and EARN
    // surfaces can show a real market BEFORE the user opts into running a
    // node — the point being that an empty P2P tab reads as a broken feature
    // rather than as "you have not turned this on yet".
    //
    // Deliberately the FULL host, not the bare `basicswapdex.com`: the
    // snapshot is one static file on one subdomain, and the wallet has no
    // business reaching the rest of that domain.
    //
    // Routed through here rather than a renderer `fetch()` even though the
    // endpoint sends `access-control-allow-origin: *` and would work
    // directly. Going through the backend strips the Origin header, attaches
    // no credentials or cookies, and keeps the third-party host out of the
    // webview's own network activity — and it is what makes routing this
    // over a privacy proxy later a change in ONE module instead of a
    // frontend rewrite. Read-only, no key, no user data in the request.
    "markets.basicswapdex.com",
];

fn is_host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ALLOWED_HOST_SUFFIXES.iter().any(|suffix| {
        let s = suffix.to_ascii_lowercase();
        host == s || host.ends_with(&format!(".{}", s))
    })
}

fn parse_https_host(url: &str) -> Result<String, String> {
    let stripped = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("Refusing to proxy non-https URL: {}", url))?;
    let host_end = stripped
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(stripped.len());
    let host_port = &stripped[..host_end];
    let host = match host_port.rfind(':') {
        Some(i) => &host_port[..i],
        None => host_port,
    };
    if host.is_empty() {
        return Err(format!("Empty host in URL: {}", url));
    }
    Ok(host.to_string())
}

/// Proxy a single HTTP request to an allowlisted https endpoint.
///
/// `method` is "GET" or "POST" (case-insensitive). `body` is sent only for
/// POST and may be omitted. `headers` is a flat list of `(name, value)`
/// pairs — the caller is responsible for content-type / accept headers.
#[tauri::command]
pub async fn http_proxy_call(
    method: String,
    url: String,
    body: Option<String>,
    headers: Option<Vec<HttpProxyHeader>>,
) -> Result<HttpProxyResponse, String> {
    let host = parse_https_host(&url)?;
    if !is_host_allowed(&host) {
        return Err(format!(
            "host '{}' is not on the http_proxy allowlist (see http_proxy.rs)",
            host
        ));
    }

    let method_upper = method.to_ascii_uppercase();
    // A real browser User-Agent. reqwest's default UA (or none) trips the
    // bot-detection / WAF on several chain-data hosts — dogechain.info and the
    // Trezor BlockBook instances return a Cloudflare 403 challenge to non-browser
    // clients, and some providers rate-limit unknown agents more aggressively.
    // A per-request `user-agent` header (set by a caller) still overrides this.
    const BROWSER_UA: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    // ONE client for the process, not one per request (2026-08-22). The
    // balance sweep fires ~30 proxied calls in the same instant, several to
    // the same hosts (BlockCypher, Blockchair, Koios); a fresh client per call
    // meant a fresh connection pool per call, so none of them could reuse a
    // TLS session and every one paid a full handshake. reqwest's Client is an
    // Arc around its pool and is designed to be cloned and shared.
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(BROWSER_UA)
                .pool_max_idle_per_host(4)
                .build()
                .map_err(|e| format!("client build: {}", e))
        })
        .clone()?;

    let mut req = match method_upper.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("unsupported method: {}", other)),
    };

    if let Some(hs) = headers {
        for h in hs {
            req = req.header(&h.name, &h.value);
        }
    }
    if method_upper == "POST" {
        req = req.body(body.unwrap_or_default());
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("http request to {} failed: {}", url, e))?;

    let status = resp.status().as_u16();
    let mut hdrs: Vec<(String, String)> = Vec::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(vs) = v.to_str() {
            hdrs.push((k.as_str().to_string(), vs.to_string()));
        }
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("response body read failed: {}", e))?;

    Ok(HttpProxyResponse {
        status,
        body: text,
        headers: hdrs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_subdomains() {
        assert!(is_host_allowed("eth.blockscout.com"));
        assert!(is_host_allowed("polygon.blockscout.com"));
        assert!(is_host_allowed("blockscout.com"));
        assert!(is_host_allowed("api.koios.rest"));
        assert!(is_host_allowed("preprod.koios.rest"));
        assert!(is_host_allowed("mainnet-public.mirrornode.hedera.com"));
        assert!(is_host_allowed("blockbook.ravencoin.org"));
        assert!(is_host_allowed("api.ravencoin.org"));
        // Bitcore DOGE/BCH balance primary (added 2026-06-17).
        assert!(is_host_allowed("api.bitcore.io"));
        // haskoin-store BTC/BCH batch probe (added 2026-09-04). Both public
        // deployments, because a single indexer host is a single point of
        // failure for every UTXO balance the batch walk produces.
        assert!(is_host_allowed("api.blockchain.info"));
        assert!(is_host_allowed("api.haskoin.com"));
        // Dash Insight balance primary (added 2026-06-17).
        assert!(is_host_allowed("insight.dash.org"));
        // Price providers (added 2026-05-06).
        assert!(is_host_allowed("api.coingecko.com"));
        assert!(is_host_allowed("api.coinpaprika.com"));
        assert!(is_host_allowed("min-api.cryptocompare.com"));
        // Stellar Horizon — added 2026-08-22. Was missing entirely, which
        // made every Stellar balance/history read fail deterministically;
        // see the "Stellar not loaded" bug in log.md.
        assert!(is_host_allowed("horizon.stellar.org"));
        // Sui — publicnode already covered by the org-wide suffix, asserted
        // here anyway so a future narrowing of that suffix can't silently
        // re-break the wallet adapter that was rewired to it 2026-08-22.
        assert!(is_host_allowed("sui-rpc.publicnode.com"));
    }

    #[test]
    fn allowlist_rejects_lookalikes_and_unknowns() {
        assert!(!is_host_allowed("evil-blockscout.com.attacker.io"));
        assert!(!is_host_allowed("notblockscout.com"));
        assert!(!is_host_allowed("github.com"));
        assert!(!is_host_allowed("example.com"));
    }

    /// The market-snapshot host is pinned to the exact subdomain.
    ///
    /// Added 2026-08-28 with the pre-opt-in market preview. Worth its own
    /// test because this entry is the first one that is NOT a chain-data RPC:
    /// it is a static file published by a third party on GitHub Pages, and
    /// the temptation on the next change is to widen it to the bare domain
    /// "because it is the same site". The wallet reads one file; it has no
    /// business reaching the rest of that domain, and a wider suffix would
    /// also admit any future subdomain the publisher adds.
    #[test]
    fn allowlist_pins_the_market_snapshot_host_exactly() {
        assert!(is_host_allowed("markets.basicswapdex.com"));
        // The bare domain and its other subdomains are NOT reachable.
        assert!(!is_host_allowed("basicswapdex.com"));
        assert!(!is_host_allowed("www.basicswapdex.com"));
        // And the usual suffix-confusion attempt.
        assert!(!is_host_allowed("markets.basicswapdex.com.attacker.io"));
        assert!(!is_host_allowed("notmarkets.basicswapdex.com"));
        assert!(!is_host_allowed(""));
    }

    #[test]
    fn parse_extracts_host_correctly() {
        assert_eq!(parse_https_host("https://eth.blockscout.com/api?x=1").unwrap(), "eth.blockscout.com");
        assert_eq!(parse_https_host("https://api.koios.rest:443/api/v1/tip").unwrap(), "api.koios.rest");
        assert_eq!(parse_https_host("https://mempool.space").unwrap(), "mempool.space");
    }

    #[test]
    fn parse_rejects_non_https() {
        assert!(parse_https_host("http://insecure.example.com").is_err());
        assert!(parse_https_host("ftp://example.com").is_err());
        assert!(parse_https_host("not-a-url").is_err());
    }
}
