//! Pool stats fetcher — pulls pending balance, immature balance, hashrate
//! and (where exposed) share counts from the user-selected mining pool's
//! public address-keyed API.
//!
//! Same allowlist pattern as `http_proxy.rs`: only the pool API hosts hard-
//! coded below are reachable. The frontend passes a `pool_id` matching the
//! registry in `src/features/mining/pools.ts`; this module resolves it to a
//! URL template and a parser, fetches, and normalises the response into a
//! shared `MinerStatsDto` shape.
//!
//! All atomic-unit balance fields come back as **decimal strings** to dodge
//! JS number precision. Hashrate is **f64 H/s**, normalised on this side
//! regardless of whether the pool reports KH/s, MH/s, or already H/s.
//!
//! Phase 1 covers JSON pools: HashVault, HeroMiners, Nanopool, WoolyPooly.
//! Ntminer (HTML scrape) is allowlisted here so Phase 2 only adds parser
//! code, but its dispatch arm currently returns a "not yet implemented"
//! error.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 10;

/// Normalised stats — shape mirrors the TS `MinerStats` type, see
/// `wiki/synthesis/pool-stats-implementation-plan.md` §2.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MinerStatsDto {
    pub pending_balance: String,
    pub immature_balance: Option<String>,
    pub total_paid: Option<String>,
    pub payout_threshold: Option<String>,
    pub hashrate: f64,
    pub hashrate1h: Option<f64>,
    pub hashrate6h: Option<f64>,
    pub hashrate24h: Option<f64>,
    pub valid_shares: Option<u64>,
    pub invalid_shares: Option<u64>,
    pub stale_shares: Option<u64>,
    pub last_share: Option<u64>,
    pub workers_online: Option<u64>,
    pub fetched_at: u64,
}

/// One entry per `pool_id` in `pools.ts`. URL templates use `{addr}` for the
/// wallet-address substitution. Hostname is derived from the URL and
/// re-validated against [`is_host_allowed`] before reqwest fires — defence
/// in depth so a typo here can't open a non-pool host.
struct PoolEndpoint {
    /// Matches the `id` field in `pools.ts`.
    id: &'static str,
    /// Stats URL template; `{addr}` substituted with the wallet address.
    url_template: &'static str,
    /// Which parser handles the response. Branching here (rather than per-pool
    /// parser modules) keeps the dispatcher in one place and easy to audit.
    kind: ParserKind,
}

#[derive(Clone, Copy)]
enum ParserKind {
    HashvaultJson,
    HerominersJson,
    NanopoolCfxJson,
    /// Nanopool ERG account schema. Same skeleton as the CFX variant
    /// (`{status, data: {balance, hashrate, avgHashrate: {h1, h6, h24},
    /// workers: [...]}}`) but balance is in ERG (9 decimals) instead of
    /// CFX (18 decimals). Added 2026-05-15 alongside the ERG mining
    /// integration.
    NanopoolErgJson,
    WoolypoolyJson,
    /// K1Pool miner account (`GET /api/miner/<coin>/<address>`), added
    /// 2026-09-15 for Xelis. Verified against a live active account that day:
    /// balances are whole-coin FLOATS (`pendingBalance`, `immatureBalance`,
    /// `paidBalance`, `payoutThreshold`), hashrates are plain H/s numbers
    /// (`curHashrate`, `dayHashrate`), `lastShare` is unix seconds, and the
    /// account is keyed by the address WITHOUT its `xel:` prefix — a prefixed
    /// query returns an all-zero account, not an error.
    K1poolMinerJson,
    /// Pwnda's own XEL pool account (`GET /xelis-api/stats/<xel:address>`),
    /// added 2026-09-16. Read against the live API and the pwnda.org site's
    /// own consumer of it that day. Balances are whole-XEL numbers: the site
    /// multiplies them by its `atomicUnits: 1e8`. `hashrate` is H/s. The
    /// account is keyed by the address WITH its `xel:` prefix: a bare address
    /// is an HTTP 404 page, and an unknown prefixed one is all zeros.
    PwndaXelisJson,
    /// Phase 2 — server-rendered HTML scraping. Currently returns an error
    /// so callers fall back to "open dashboard" UI gracefully.
    NtminerHtml,
}

const POOLS: &[PoolEndpoint] = &[
    PoolEndpoint {
        id: "hashvault-monero",
        url_template:
            "https://api.hashvault.pro/v3/monero/wallet/{addr}/stats?chart=false&workers=false",
        kind: ParserKind::HashvaultJson,
    },
    PoolEndpoint {
        id: "hashvault-zephyr",
        url_template:
            "https://api.hashvault.pro/v3/zephyr/wallet/{addr}/stats?chart=false&workers=false",
        kind: ParserKind::HashvaultJson,
    },
    PoolEndpoint {
        id: "herominers-monero",
        url_template:
            "https://monero.herominers.com/api/stats_address?address={addr}&longpoll=false",
        kind: ParserKind::HerominersJson,
    },
    PoolEndpoint {
        id: "herominers-conflux",
        url_template:
            "https://conflux.herominers.com/api/stats_address?address={addr}&longpoll=false",
        kind: ParserKind::HerominersJson,
    },
    PoolEndpoint {
        id: "herominers-ravencoin",
        url_template:
            "https://ravencoin.herominers.com/api/stats_address?address={addr}&longpoll=false",
        kind: ParserKind::HerominersJson,
    },
    PoolEndpoint {
        id: "nanopool-conflux",
        url_template: "https://api.nanopool.org/v1/cfx/user/{addr}",
        kind: ParserKind::NanopoolCfxJson,
    },
    // WoolyPooly's path uses pool IDs (`raven-1`, `cfx-1`), NOT bare tickers
    // (`rvn`, `cfx`). The bare-ticker URL returns 404. See
    // mining-pool-commands.md / -implementation-plan.md §1.
    PoolEndpoint {
        id: "woolypooly-conflux",
        url_template: "https://api.woolypooly.com/api/cfx-1/accounts/{addr}",
        kind: ParserKind::WoolypoolyJson,
    },
    PoolEndpoint {
        id: "woolypooly-ravencoin",
        url_template: "https://api.woolypooly.com/api/raven-1/accounts/{addr}",
        kind: ParserKind::WoolypoolyJson,
    },
    PoolEndpoint {
        id: "ntminerpool-zephyr",
        url_template: "https://ntminerpool.com/zeph/index?back={addr}",
        kind: ParserKind::NtminerHtml,
    },
    // ── Ergo (ERG / Autolykos v2 GPU) pools, added 2026-05-15. The Mining
    // UI hides PoolStatsPanel unless an adapter is registered for the
    // selected pool, so before this block landed ERG miners couldn't see
    // Pending / Payout / Hashrate live. HeroMiners and WoolyPooly re-use
    // the existing JSON parsers; Nanopool ERG goes through a dedicated
    // `NanopoolErgJson` parser (CFX schema with 1e9 atomic conversion).
    PoolEndpoint {
        id: "herominers-ergo",
        url_template:
            "https://ergo.herominers.com/api/stats_address?address={addr}&longpoll=false",
        kind: ParserKind::HerominersJson,
    },
    PoolEndpoint {
        // Pool-slug typo fix (2026-05-15): WoolyPooly's ERG pool ID is
        // `ergo-1`, not `erg-1`. The `<3-letter>-1` pattern from RVN /
        // CFX (`raven-1`, `cfx-1`) doesn't generalise — for ERG they
        // use the full coin name. Verified via direct probe:
        //   `/api/ergo-1/stats`     → HTTP 200 (671 B)
        //   `/api/erg-1/stats`      → HTTP 404
        //   `/api/erg/stats`        → HTTP 404
        //   `/api/ergo/stats`       → HTTP 404
        id: "woolypooly-ergo",
        url_template: "https://api.woolypooly.com/api/ergo-1/accounts/{addr}",
        kind: ParserKind::WoolypoolyJson,
    },
    // Nanopool ERG — same API host as CFX/ETH, separate `/v1/ergo/`
    // path. The EU/US regional aliases share one account-scoped backend
    // so the URL template is identical for both pool IDs.
    PoolEndpoint {
        id: "nanopool-ergo-eu",
        url_template: "https://api.nanopool.org/v1/ergo/user/{addr}",
        kind: ParserKind::NanopoolErgJson,
    },
    PoolEndpoint {
        id: "nanopool-ergo-us",
        url_template: "https://api.nanopool.org/v1/ergo/user/{addr}",
        kind: ParserKind::NanopoolErgJson,
    },
    // ── Xelis (XEL), added 2026-09-15. K1Pool only: its account API was
    // fetched live for a real active account that day. The three pools.ts
    // entries are three PORTS (CPU 9350 / GPU 9351 / TLS 9352) of one account
    // backend, so they share a URL. `{addr}` receives the address with its
    // `xel:` prefix removed — see `api_address`. Kryptex (no discoverable
    // per-address API) and HeroMiners (site blocked from the dev box, so no
    // response was ever captured) are deliberately absent.
    PoolEndpoint {
        id: "k1pool-xelis-cpu",
        url_template: "https://k1pool.com/api/miner/xel/{addr}",
        kind: ParserKind::K1poolMinerJson,
    },
    PoolEndpoint {
        id: "k1pool-xelis-gpu",
        url_template: "https://k1pool.com/api/miner/xel/{addr}",
        kind: ParserKind::K1poolMinerJson,
    },
    PoolEndpoint {
        id: "k1pool-xelis-ssl",
        url_template: "https://k1pool.com/api/miner/xel/{addr}",
        kind: ParserKind::K1poolMinerJson,
    },
    // Pwnda's own XEL pool (2026-09-16). One port serves both lanes, so one
    // entry. The site fetches the same URL with the colon left unencoded.
    PoolEndpoint {
        id: "pwnda-xelis",
        url_template: "https://pwnda.org/xelis-api/stats/{addr}",
        kind: ParserKind::PwndaXelisJson,
    },
];

const ALLOWED_HOSTS: &[&str] = &[
    "api.hashvault.pro",
    "monero.herominers.com",
    "conflux.herominers.com",
    "ravencoin.herominers.com",
    // Ergo subdomain on the HeroMiners cluster (added 2026-05-15).
    "ergo.herominers.com",
    "api.nanopool.org",
    "api.woolypooly.com",
    "ntminerpool.com",
    // K1Pool account API (Xelis, added 2026-09-15).
    "k1pool.com",
    // Pwnda XEL pool account API (added 2026-09-16).
    "pwnda.org",
];

fn is_host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ALLOWED_HOSTS.iter().any(|allowed| host == *allowed)
}

fn parse_https_host(url: &str) -> Result<String, String> {
    let stripped = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("Refusing to fetch non-https URL: {}", url))?;
    let host_end = stripped
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(stripped.len());
    let host_port = &stripped[..host_end];
    let host = match host_port.rfind(':') {
        Some(i) => &host_port[..i],
        None => host_port,
    };
    if host.is_empty() {
        return Err("URL has no host".to_string());
    }
    Ok(host.to_string())
}

#[tauri::command]
pub async fn fetch_pool_stats(
    pool_id: String,
    address: String,
) -> Result<MinerStatsDto, String> {
    if address.trim().is_empty() {
        return Err("Empty address".to_string());
    }

    let pool = POOLS
        .iter()
        .find(|p| p.id == pool_id)
        .ok_or_else(|| format!("Unknown pool_id: {}", pool_id))?;

    // Most PWNDA pool ids ("pwnda-zephyr", "pwnda-zano") intentionally don't
    // appear in POOLS — the Mining UI hides the panel for them, but if a
    // future caller tries one we want a clear error rather than a generic
    // "Unknown". `pwnda-xelis` is the exception (2026-09-16): its pool
    // publishes a per-address API.

    let url = pool
        .url_template
        .replace("{addr}", api_address(pool.kind, &address));

    let host = parse_https_host(&url)?;
    if !is_host_allowed(&host) {
        return Err(format!("Host not in pool stats allowlist: {}", host));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        // Generic UA so pools don't single-app-throttle us. No cookies / no auth.
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Pool fetch failed: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Pool body read failed: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "Pool returned HTTP {} — body: {}",
            status.as_u16(),
            truncate(&body, 200)
        ));
    }

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut stats = match pool.kind {
        ParserKind::HashvaultJson => parse_hashvault(&body)?,
        ParserKind::HerominersJson => parse_herominers(&body)?,
        ParserKind::NanopoolCfxJson => parse_nanopool_cfx(&body)?,
        ParserKind::NanopoolErgJson => parse_nanopool_erg(&body)?,
        ParserKind::WoolypoolyJson => {
            // Decimals depend on which WoolyPooly coin pool we hit:
            //   - CFX → 18 (drip per CFX)
            //   - ERG → 9  (nanoErg per ERG, added 2026-05-15)
            //   - RVN / everything else → 8 (sats per RVN)
            let decimals = if pool.id.contains("conflux") {
                18
            } else if pool.id.contains("ergo") {
                9
            } else {
                8
            };
            parse_woolypooly(&body, decimals)?
        }
        // XEL is the only coin on this parser today: 8 decimals.
        ParserKind::K1poolMinerJson => parse_k1pool_miner(&body, 8)?,
        ParserKind::PwndaXelisJson => parse_pwnda_xelis(&body)?,
        ParserKind::NtminerHtml => parse_ntminer_html(&body)?,
    };
    stats.fetched_at = now_secs;
    Ok(stats)
}

// ── Parsers ──────────────────────────────────────────────────────────

/// HashVault v3 schema. Field map locked in
/// `wiki/synthesis/pool-stats-implementation-plan.md` §3.
fn parse_hashvault(body: &str) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("HashVault JSON parse: {}", e))?;

    let revenue = &v["revenue"];
    let collective = &v["collective"];

    Ok(MinerStatsDto {
        pending_balance: atomic_string(&revenue["confirmedBalance"]).unwrap_or_else(|| "0".into()),
        immature_balance: atomic_string(&revenue["unconfirmedBalance"]["collective"]["total"]),
        total_paid: atomic_string(&revenue["totalPaid"]),
        payout_threshold: atomic_string(&revenue["payoutThreshold"]),
        hashrate: as_f64(&collective["hashRate"]).unwrap_or(0.0),
        hashrate1h: as_f64(&collective["avg1hashRate"]),
        hashrate6h: as_f64(&collective["avg6hashRate"]),
        hashrate24h: as_f64(&collective["avg24hashRate"]),
        valid_shares: as_u64(&collective["validShares"]),
        invalid_shares: as_u64(&collective["invalidShares"]),
        stale_shares: as_u64(&collective["staleShares"]),
        last_share: as_u64(&collective["lastShare"]),
        workers_online: None, // explicitly suppressed via ?workers=false
        fetched_at: 0,
    })
}

/// HeroMiners (cryptonote-nodejs-pool fork) schema. The `hashrate` and the
/// `_1h/_6h/_24h` siblings live at the *top level* of the response, not
/// under `stats`. Field names for share counters are `shares_good`,
/// `shares_invalid`, `shares_stale` — verified against a live RVN address.
/// Hashrate is sometimes a number (H/s) and sometimes a pre-formatted
/// string like `"1.42 KH/s"`; we accept both via `parse_hashrate_field`.
fn parse_herominers(body: &str) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("HeroMiners JSON parse: {}", e))?;

    if v.get("error").is_some() && v.get("stats").is_none() {
        return Err(format!(
            "HeroMiners: {}",
            v["error"].as_str().unwrap_or("address not found")
        ));
    }

    let stats = &v["stats"];
    let workers = v["workers"].as_array().map(|a| a.len() as u64);

    Ok(MinerStatsDto {
        pending_balance: atomic_string(&stats["balance"]).unwrap_or_else(|| "0".into()),
        immature_balance: None, // cryptonote-nodejs-pool has no immature tier
        total_paid: atomic_string(&stats["paid"]),
        payout_threshold: None, // exposed by /api/config; not fetched in Phase 1
        hashrate: parse_hashrate_field(&v["hashrate"]).unwrap_or(0.0),
        hashrate1h: parse_hashrate_field(&v["hashrate_1h"]),
        hashrate6h: parse_hashrate_field(&v["hashrate_6h"]),
        hashrate24h: parse_hashrate_field(&v["hashrate_24h"]),
        valid_shares: as_u64(&stats["shares_good"]),
        invalid_shares: as_u64(&stats["shares_invalid"]),
        stale_shares: as_u64(&stats["shares_stale"]),
        last_share: as_u64(&stats["lastShare"]),
        workers_online: workers,
        fetched_at: 0,
    })
}

/// Nanopool CFX schema. balance is a float in CFX (×1e18 → drip),
/// hashrate is MH/s (×1e6 → H/s).
fn parse_nanopool_cfx(body: &str) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("Nanopool JSON parse: {}", e))?;

    if v["status"] == Value::Bool(false) {
        return Err(format!(
            "Nanopool: {}",
            v["error"].as_str().unwrap_or("account not found")
        ));
    }

    let data = &v["data"];

    let last_share = data["workers"]
        .as_array()
        .and_then(|workers| {
            workers
                .iter()
                .filter_map(|w| as_u64(&w["lastShare"]))
                .max()
        });

    Ok(MinerStatsDto {
        pending_balance: cfx_to_drip(&data["balance"]).unwrap_or_else(|| "0".into()),
        immature_balance: None,
        total_paid: None, // separate /payments endpoint, deferred
        payout_threshold: None, // /usersettings, deferred
        hashrate: as_f64(&data["hashrate"]).map(|h| h * 1_000_000.0).unwrap_or(0.0),
        hashrate1h: as_f64(&data["avgHashrate"]["h1"]).map(|h| h * 1_000_000.0),
        hashrate6h: as_f64(&data["avgHashrate"]["h6"]).map(|h| h * 1_000_000.0),
        hashrate24h: as_f64(&data["avgHashrate"]["h24"]).map(|h| h * 1_000_000.0),
        valid_shares: None,
        invalid_shares: None,
        stale_shares: None,
        last_share,
        workers_online: data["workers"].as_array().map(|a| a.len() as u64),
        fetched_at: 0,
    })
}

/// WoolyPooly schema. Verified against a live active RVN address — three
/// gotchas vs the original assumption:
///
/// 1. `stats.balance`, `stats.immature_balance` (NOT `immature`), `stats.paid`
///    are **floats in display units**, not integer atomic units.
///    Need ×decimals to reach atomic. Decimals derive from the pool_id
///    passed in by the dispatcher (RVN=8, CFX=18).
/// 2. Hashrate lives in `mode_stats.pplns.default.{currentHashrate,
///    hashrate, dayHashrate}` (top-level `currentHashrate` doesn't exist).
///    `mode_stats: {}` for miners that have never submitted a share.
/// 3. `lastShare` lives in `workers[].lastBeat` (Unix seconds), max across
///    workers. Top-level `lastShare` doesn't exist.
fn parse_woolypooly(body: &str, decimals: u32) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("WoolyPooly JSON parse: {}", e))?;

    let stats = &v["stats"];
    let mode = &v["mode_stats"]["pplns"]["default"];

    let last_share = v["workers"]
        .as_array()
        .and_then(|workers| {
            workers
                .iter()
                .filter_map(|w| as_u64(&w["lastBeat"]))
                .max()
        });

    Ok(MinerStatsDto {
        pending_balance: float_to_atomic_string(&stats["balance"], decimals)
            .unwrap_or_else(|| "0".into()),
        immature_balance: float_to_atomic_string(&stats["immature_balance"], decimals),
        total_paid: float_to_atomic_string(&stats["paid"], decimals),
        // payoutThreshold lives on /api/{poolId}/stats?simple=false; not
        // fetched in Phase 1 (UI falls back to pools.ts minPayout).
        payout_threshold: None,
        hashrate: as_f64(&mode["currentHashrate"]).unwrap_or(0.0),
        hashrate1h: None,
        hashrate6h: None,
        // dayHashrate is the 24h average per the active-account probe
        hashrate24h: as_f64(&mode["dayHashrate"]).or_else(|| as_f64(&mode["hashrate"])),
        valid_shares: None,
        invalid_shares: None,
        stale_shares: None,
        last_share,
        workers_online: as_u64(&v["workersOnline"]),
        fetched_at: 0,
    })
}

/// Ntminerpool's ZEPH dashboard is server-rendered HTML — no JSON API.
/// The page is a Chinese-localised template that renders each metric as a
/// `<div class="sl_m"><div class="top">VALUE</div><div class="bottom">LABEL</div></div>`
/// block, plus two balance rows of the form `<h3>LABEL</h3><div ...><b>0.0123 ZEPH</b></div>`.
///
/// We key off the Chinese row labels because they're CSS-styled rows, not
/// positional — far more stable than counting tags. If the markup shifts
/// significantly, individual extractions return None and the panel falls
/// back to its empty state without throwing.
fn parse_ntminer_html(body: &str) -> Result<MinerStatsDto, String> {
    let pending_zeph = extract_balance_zeph(body, "未支付余额");
    let immature_zeph = extract_balance_zeph(body, "待成熟额度");

    // Pool returns ZEPH as a decimal — convert to piconero (×1e12) for the
    // shared MinerStats atomic-unit representation.
    let pending_atomic = pending_zeph
        .map(zeph_to_piconero_string)
        .unwrap_or_else(|| "0".to_string());
    let immature_atomic = immature_zeph.map(zeph_to_piconero_string);

    let hashrate = extract_sl_m_value(body, "当前有效算力")
        .and_then(|s| parse_hashrate_field(&Value::String(s)));
    let hashrate24h = extract_sl_m_value(body, "24小时平均有效")
        .and_then(|s| parse_hashrate_field(&Value::String(s)));

    let valid_shares = extract_sl_m_with_prefix(body, "有效(").and_then(parse_share_count);
    let stale_shares = extract_sl_m_with_prefix(body, "过期(").and_then(parse_share_count);
    let invalid_shares = extract_sl_m_with_prefix(body, "无效(").and_then(parse_share_count);

    // Surface a clearer error than a wall of zeros when the page came back
    // but the regex set found nothing — very likely a markup change.
    if pending_zeph.is_none()
        && immature_zeph.is_none()
        && hashrate.is_none()
        && valid_shares.is_none()
    {
        return Err(
            "Ntminer: dashboard markup didn't match expected layout. \
             Open https://ntminerpool.com/ to view stats directly."
                .to_string(),
        );
    }

    Ok(MinerStatsDto {
        pending_balance: pending_atomic,
        immature_balance: immature_atomic,
        total_paid: None, // pool's "已支付" surface varies; not reliably parseable
        payout_threshold: None, // static 0.1 ZEPH; UI falls back to pools.ts minPayout
        hashrate: hashrate.unwrap_or(0.0),
        hashrate1h: None, // page only exposes current + 24h
        hashrate6h: None,
        hashrate24h,
        valid_shares,
        invalid_shares,
        stale_shares,
        last_share: None, // not on the dashboard page
        workers_online: None,
        fetched_at: 0,
    })
}

// Lazy-compiled regexes — `OnceLock` so we pay the compile cost once per
// process even though `parse_ntminer_html` runs on every poll.
fn balance_re(label: &str) -> Regex {
    // Match `<h3>LABEL</h3>` then the next `<b>NUM ZEPH</b>` somewhere
    // shortly after. Use `[\s\S]*?` to span across whitespace + intervening
    // tags without requiring exact positional matching.
    let pattern = format!(r"<h3>\s*{}\s*</h3>[\s\S]{{0,200}}?<b>\s*([\d.]+)\s*ZEPH", regex::escape(label));
    Regex::new(&pattern).expect("static regex compiles")
}

fn extract_balance_zeph(body: &str, label: &str) -> Option<f64> {
    balance_re(label)
        .captures(body)?
        .get(1)?
        .as_str()
        .parse::<f64>()
        .ok()
}

/// Pull the `<div class="top">VALUE</div>` paired with a specific
/// `<div class="bottom">LABEL</div>` in the Ntminer template.
fn extract_sl_m_value(body: &str, exact_label: &str) -> Option<String> {
    static CACHE: OnceLock<Regex> = OnceLock::new();
    let re = CACHE.get_or_init(|| {
        Regex::new(
            r#"<div class="top">\s*([^<]+?)\s*</div>\s*<div class="bottom">\s*([^<]+?)\s*</div>"#,
        )
        .expect("static regex compiles")
    });
    for cap in re.captures_iter(body) {
        let label = cap.get(2)?.as_str().trim();
        if label == exact_label {
            return Some(cap.get(1)?.as_str().trim().to_string());
        }
    }
    None
}

/// Same as `extract_sl_m_value` but matches when the label STARTS WITH a
/// prefix (for "有效(99.45%)" / "过期(0.33%)" / "无效(0.22%)" rows where
/// the percentage portion varies).
fn extract_sl_m_with_prefix(body: &str, prefix: &str) -> Option<String> {
    static CACHE: OnceLock<Regex> = OnceLock::new();
    let re = CACHE.get_or_init(|| {
        Regex::new(
            r#"<div class="top">\s*([^<]+?)\s*</div>\s*<div class="bottom">\s*([^<]+?)\s*</div>"#,
        )
        .expect("static regex compiles")
    });
    for cap in re.captures_iter(body) {
        let label = cap.get(2)?.as_str().trim();
        if label.starts_with(prefix) {
            return Some(cap.get(1)?.as_str().trim().to_string());
        }
    }
    None
}

/// Convert "135.94K" / "1.5M" / "447" to a u64 share count.
fn parse_share_count(s: String) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Detect a single-letter suffix (K / M / G / T).
    let (num_part, mult): (&str, f64) = match s.chars().last() {
        Some('K') | Some('k') => (&s[..s.len() - 1], 1_000.0),
        Some('M') | Some('m') => (&s[..s.len() - 1], 1_000_000.0),
        Some('G') | Some('g') => (&s[..s.len() - 1], 1_000_000_000.0),
        Some('T') | Some('t') => (&s[..s.len() - 1], 1_000_000_000_000.0),
        _ => (s, 1.0),
    };
    let n: f64 = num_part.parse().ok()?;
    Some((n * mult).round() as u64)
}

/// Convert a decimal ZEPH amount (e.g. 0.061305) to its piconero string
/// representation (×1e12). Wraps the generic `float_to_atomic_string`.
fn zeph_to_piconero_string(zeph: f64) -> String {
    float_to_atomic_string(&Value::from(zeph), 12).unwrap_or_else(|| "0".into())
}

// ── Helpers ──────────────────────────────────────────────────────────

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

/// Stringify an atomic-unit balance/threshold field. Accepts either a JSON
/// number or a JSON string (some pools emit big integers as strings to
/// dodge JS precision); preserves the integer form so JS BigInt stays happy.
fn atomic_string(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => {
            // Prefer integer rendering when the pool emits a clean integer.
            if let Some(u) = n.as_u64() {
                Some(u.to_string())
            } else if let Some(i) = n.as_i64() {
                Some(i.to_string())
            } else {
                n.as_f64().map(|f| format!("{}", f as u64))
            }
        }
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// Convert a JSON-number display-unit balance (e.g. 0.123 CFX, 5648.8 RVN)
/// to an atomic-unit string by shifting the decimal point `decimals`
/// places. Uses fixed-point intermediate to avoid f64 precision loss on
/// the multiplication.
fn float_to_atomic_string(v: &Value, decimals: u32) -> Option<String> {
    let n = as_f64(v)?;
    if n.is_nan() || n.is_infinite() || n < 0.0 {
        return None;
    }
    let s = format!("{:.*}", decimals as usize, n);
    let mut parts = s.split('.');
    let int_part = parts.next().unwrap_or("0");
    let frac_part = parts.next().unwrap_or("");
    let combined: String = int_part
        .chars()
        .chain(frac_part.chars())
        .filter(|c| c.is_ascii_digit())
        .collect();
    let trimmed = combined.trim_start_matches('0');
    Some(if trimmed.is_empty() { "0".into() } else { trimmed.into() })
}

/// Backwards-compatible alias. Nanopool CFX float → drip (×1e18).
fn cfx_to_drip(v: &Value) -> Option<String> {
    float_to_atomic_string(v, 18)
}

/// Nanopool ERG schema. Same shape as the CFX variant in
/// [`parse_nanopool_cfx`] but balances scale by 1e9 (nanoErg per ERG)
/// instead of 1e18 (drip per CFX), and the documented hashrate field is
/// reported in **H/s** for ERG (not MH/s like CFX), so we don't multiply.
///
/// The avgHashrate buckets (`h1`, `h6`, `h24`) carry the same units as
/// the live `hashrate` field, so they pass through verbatim. If a future
/// Nanopool API change starts reporting ERG hashrate with a multiplier,
/// the unit normalisation belongs here in one place — the rest of the
/// pool-stats pipeline treats `hashrate` as plain H/s.
fn parse_nanopool_erg(body: &str) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("Nanopool ERG JSON parse: {}", e))?;

    if v["status"] == Value::Bool(false) {
        return Err(format!(
            "Nanopool: {}",
            v["error"].as_str().unwrap_or("account not found")
        ));
    }

    let data = &v["data"];

    let last_share = data["workers"]
        .as_array()
        .and_then(|workers| {
            workers
                .iter()
                .filter_map(|w| as_u64(&w["lastShare"]))
                .max()
        });

    Ok(MinerStatsDto {
        pending_balance: float_to_atomic_string(&data["balance"], 9)
            .unwrap_or_else(|| "0".into()),
        immature_balance: None,
        total_paid: None,
        payout_threshold: None,
        hashrate: as_f64(&data["hashrate"]).unwrap_or(0.0),
        hashrate1h: as_f64(&data["avgHashrate"]["h1"]),
        hashrate6h: as_f64(&data["avgHashrate"]["h6"]),
        hashrate24h: as_f64(&data["avgHashrate"]["h24"]),
        valid_shares: None,
        invalid_shares: None,
        stale_shares: None,
        last_share,
        workers_online: data["workers"].as_array().map(|a| a.len() as u64),
        fetched_at: 0,
    })
}

/// HeroMiners hashrate is sometimes "1.42 KH/s" (string with unit) and
/// sometimes raw H/s as a number. Handle both.
fn parse_hashrate_field(v: &Value) -> Option<f64> {
    if let Some(n) = as_f64(v) {
        return Some(n);
    }
    let s = v.as_str()?.trim();
    if s.is_empty() || s == "0" || s == "0 H/s" {
        return Some(0.0);
    }
    let (num_part, unit_part) = s
        .split_once(' ')
        .or_else(|| s.split_once(|c: char| c.is_alphabetic()).map(|(a, b)| (a, b)))
        .unwrap_or((s, ""));
    let num: f64 = num_part.trim().parse().ok()?;
    let multiplier = match unit_part.trim().to_ascii_uppercase().as_str() {
        "" | "H/S" | "H" => 1.0,
        "KH/S" | "KH" => 1_000.0,
        "MH/S" | "MH" => 1_000_000.0,
        "GH/S" | "GH" => 1_000_000_000.0,
        "TH/S" | "TH" => 1_000_000_000_000.0,
        _ => 1.0,
    };
    Some(num * multiplier)
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max { s } else { &s[..max] }
}

/// The address in the form the pool's API expects for `{addr}`.
///
/// K1Pool keys a Xelis account by the address WITHOUT its `xel:` network
/// prefix. Verified 2026-09-15: `/api/miner/xel/xel:nm46…` returned an
/// all-zero account (3.4 KB) while `/api/miner/xel/nm46…` returned the real
/// one (180 KB, two workers, 259.57 XEL paid). The prefixed query is not an
/// error, so without this a user's stats panel would read a confident zero.
/// Every other parser takes the address exactly as given.
fn api_address(kind: ParserKind, address: &str) -> &str {
    match kind {
        ParserKind::K1poolMinerJson => {
            let trimmed = address.trim();
            trimmed.strip_prefix("xel:").unwrap_or(trimmed)
        }
        _ => address,
    }
}

/// K1Pool account schema (`GET /api/miner/<coin>/<address>`). Field map pinned
/// against a real, active XEL account on 2026-09-15:
///
/// - `miner.pendingBalance` / `immatureBalance` / `paidBalance` /
///   `payoutThreshold` — whole-coin FLOATS (`immatureBalance: 0.37876`,
///   `payoutThreshold: 3`), shifted to atomic strings here like WoolyPooly's.
/// - `miner.curHashrate` / `dayHashrate` — plain H/s numbers
///   (`393451` ⇔ `curHashrateStr: "393.45 KH/s"`).
/// - `miner.lastShare` — unix seconds; `miner.workersOnline` — a count.
///
/// `avgHashrate` is deliberately NOT mapped to a 1h/6h tile: the API gives no
/// window for it, and a mislabelled average is worse than an absent one.
/// An address the pool has never seen returns this same object with every
/// number zero — passed through as zeros, with `lastShare: 0` → `None`
/// ("never"), not as an error.
fn parse_k1pool_miner(body: &str, decimals: u32) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("K1Pool JSON parse: {}", e))?;
    let m = &v["miner"];
    if !m.is_object() {
        return Err("K1Pool: response has no `miner` object".to_string());
    }
    Ok(MinerStatsDto {
        pending_balance: float_to_atomic_string(&m["pendingBalance"], decimals)
            .unwrap_or_else(|| "0".into()),
        immature_balance: float_to_atomic_string(&m["immatureBalance"], decimals),
        total_paid: float_to_atomic_string(&m["paidBalance"], decimals),
        payout_threshold: float_to_atomic_string(&m["payoutThreshold"], decimals),
        hashrate: as_f64(&m["curHashrate"]).unwrap_or(0.0),
        hashrate1h: None,
        hashrate6h: None,
        hashrate24h: as_f64(&m["dayHashrate"]),
        valid_shares: None,
        invalid_shares: None,
        stale_shares: None,
        last_share: as_u64(&m["lastShare"]).filter(|t| *t > 0),
        workers_online: as_u64(&m["workersOnline"]),
        fetched_at: 0,
    })
}

/// pwnda-xelis's published minimum payout: `minPayout: "0.05 XEL"` in the
/// pwnda.org pool config (and `pools.ts`). The account API doesn't return it,
/// and the panel's "min … XEL" line needs it.
const PWNDA_XEL_MIN_PAYOUT: f64 = 0.05;

/// Pwnda XEL account schema (`GET /xelis-api/stats/<xel:address>`). Field
/// map pinned 2026-09-16 against the live API and the labels pwnda.org itself
/// shows for these fields:
///
/// - `balance` — "UNPAID - accrues until the payout threshold" → pending.
/// - `balance_pending` — "awaiting 200 block confirmations" → maturing.
/// - `paid` — "TOTAL_PAID" → lifetime paid.
/// - `hashrate` — current H/s.
///
/// All three balances are whole-XEL numbers. `est_pending` (the running
/// round estimate) has no field in the shared shape, so it is dropped.
/// `hr_chart` and `withdrawals` are not mapped either. The site reports no
/// 1h/6h/24h averages, last share or worker count, so those stay `None`
/// rather than a made-up zero. An address the pool has never seen returns
/// zeros with `hr_chart: null`, passed through as zeros like K1Pool's.
fn parse_pwnda_xelis(body: &str) -> Result<MinerStatsDto, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("Pwnda XEL JSON parse: {}", e))?;
    if as_f64(&v["balance"]).is_none() {
        return Err("Pwnda XEL: response has no numeric `balance`".to_string());
    }
    Ok(MinerStatsDto {
        pending_balance: float_to_atomic_string(&v["balance"], 8)
            .unwrap_or_else(|| "0".into()),
        immature_balance: float_to_atomic_string(&v["balance_pending"], 8),
        total_paid: float_to_atomic_string(&v["paid"], 8),
        payout_threshold: float_to_atomic_string(&Value::from(PWNDA_XEL_MIN_PAYOUT), 8),
        hashrate: as_f64(&v["hashrate"]).unwrap_or(0.0),
        hashrate1h: None,
        hashrate6h: None,
        hashrate24h: None,
        valid_shares: None,
        invalid_shares: None,
        stale_shares: None,
        last_share: None,
        workers_online: None,
        fetched_at: 0,
    })
}

#[cfg(test)]
mod pwnda_xelis_tests {
    use super::*;

    /// The live response for the operator's address, 2026-09-16, just after
    /// a session ended (the chart's last points are 0).
    const OPERATOR: &str = r#"{"balance":0,"balance_pending":0,"est_pending":0,"hashrate":0,"hr_chart":[{"t":1789602284,"h":2750},{"t":1789603184,"h":6831},{"t":1789604084,"h":7276},{"t":1789604984,"h":1971},{"t":1789605884,"h":4139},{"t":1789606784,"h":5147},{"t":1789607684,"h":0},{"t":1789608584,"h":0}],"paid":0,"withdrawals":[]}"#;

    /// An address the pool has never seen, same day.
    const NEVER_SEEN: &str = r#"{"balance":0,"balance_pending":0,"est_pending":0,"hashrate":0,"hr_chart":null,"paid":0,"withdrawals":[]}"#;

    /// The live shape with non-zero values filled in, so the unit conversion
    /// is actually exercised: whole XEL in, atomic (1e8) strings out.
    const FUNDED: &str = r#"{"balance":0.0412,"balance_pending":0.00731,"est_pending":0.001,"hashrate":7276.5,"hr_chart":[],"paid":1.25,"withdrawals":[{"time":1789600000,"amount":0.05,"txid":"ab"}]}"#;

    #[test]
    fn converts_whole_xel_to_atomic_strings() {
        let s = parse_pwnda_xelis(FUNDED).expect("parse");
        assert_eq!(s.pending_balance, "4120000");
        assert_eq!(s.immature_balance.as_deref(), Some("731000"));
        assert_eq!(s.total_paid.as_deref(), Some("125000000"));
        assert_eq!(s.payout_threshold.as_deref(), Some("5000000"), "0.05 XEL");
        assert_eq!(s.hashrate, 7276.5);
    }

    #[test]
    fn the_live_operator_response_parses_as_zeros_with_no_invented_fields() {
        for body in [OPERATOR, NEVER_SEEN] {
            let s = parse_pwnda_xelis(body).expect("parse");
            assert_eq!(s.pending_balance, "0");
            assert_eq!(s.hashrate, 0.0);
            assert_eq!(s.hashrate24h, None);
            assert_eq!(s.last_share, None);
            assert_eq!(s.workers_online, None);
        }
    }

    #[test]
    fn a_body_without_a_balance_is_an_error() {
        // What the bare-address 404 would be if it ever came back as JSON.
        assert!(parse_pwnda_xelis(r#"{"error":"not found"}"#).is_err());
        assert!(parse_pwnda_xelis("<!doctype html>").is_err());
    }

    #[test]
    fn the_address_keeps_its_xel_prefix_and_the_host_is_allowed() {
        let pool = POOLS.iter().find(|p| p.id == "pwnda-xelis").expect("registered");
        let url = pool
            .url_template
            .replace("{addr}", api_address(pool.kind, "xel:lfmtabc"));
        assert_eq!(url, "https://pwnda.org/xelis-api/stats/xel:lfmtabc");
        assert!(is_host_allowed(&parse_https_host(&url).unwrap()));
    }
}

#[cfg(test)]
mod k1pool_tests {
    use super::*;

    /// Trimmed from the live response for a real, active K1Pool XEL account
    /// (`/api/miner/xel/nm46…`, 2026-09-15; 180 KB of charts removed).
    const ACTIVE: &str = r#"{"miner":{"workersTotal":2,"workersOnline":2,"workersOffline":0,"workers":{"rig01":{"mineZil":false,"lastBeat":1789509667,"startedAt":1789423800,"hr":214445,"hr2":199611,"hr24":221155,"offline":false}},"curHashrate":393451,"curHashrateStr":"393.45 KH/s","avgHashrate":435196,"avgHashrateStr":"435.2 KH/s","dayHashrate":339855,"dayHashrateStr":"339.86 KH/s","coinsPerDay":47.08813,"lastShare":1789509667,"lastShareDiff":0,"paymentsTotal":47,"payoutThreshold":3,"immatureBalance":0.37876,"pendingBalance":0,"paidBalance":259.56861},"pool":{}}"#;

    /// The throwaway address the pool had never seen, same day: the SAME
    /// object with every number zero (note `workers` is an array here).
    const NEVER_SEEN: &str = r#"{"miner":{"workersTotal":0,"workersOnline":0,"workersOffline":0,"workers":[],"curHashrate":0,"curHashrateStr":"0 H/s","avgHashrate":0,"dayHashrate":0,"lastShare":0,"payoutThreshold":3,"immatureBalance":0,"pendingBalance":0,"paidBalance":0}}"#;

    #[test]
    fn parses_a_live_active_account() {
        let s = parse_k1pool_miner(ACTIVE, 8).expect("parse");
        assert_eq!(s.hashrate, 393_451.0);
        assert_eq!(s.hashrate24h, Some(339_855.0));
        assert_eq!(s.hashrate1h, None, "avgHashrate has no documented window");
        assert_eq!(s.pending_balance, "0");
        assert_eq!(s.immature_balance.as_deref(), Some("37876000"));
        assert_eq!(s.total_paid.as_deref(), Some("25956861000"));
        assert_eq!(s.payout_threshold.as_deref(), Some("300000000"));
        assert_eq!(s.last_share, Some(1_789_509_667));
        assert_eq!(s.workers_online, Some(2));
    }

    #[test]
    fn a_never_seen_address_is_zeros_not_an_error() {
        let s = parse_k1pool_miner(NEVER_SEEN, 8).expect("parse");
        assert_eq!(s.hashrate, 0.0);
        assert_eq!(s.pending_balance, "0");
        assert_eq!(s.last_share, None, "lastShare 0 means never");
        assert_eq!(s.workers_online, Some(0));
    }

    #[test]
    fn a_body_without_a_miner_object_is_an_error() {
        assert!(parse_k1pool_miner(r#"{"error":"nope"}"#, 8).is_err());
    }

    #[test]
    fn strips_the_xel_prefix_only_for_k1pool() {
        assert_eq!(api_address(ParserKind::K1poolMinerJson, "xel:nm46abc"), "nm46abc");
        assert_eq!(api_address(ParserKind::K1poolMinerJson, " nm46abc "), "nm46abc");
        assert_eq!(api_address(ParserKind::HerominersJson, "xel:nm46abc"), "xel:nm46abc");
    }

    #[test]
    fn every_xel_k1pool_pool_resolves_to_an_allowlisted_unprefixed_url() {
        for id in ["k1pool-xelis-cpu", "k1pool-xelis-gpu", "k1pool-xelis-ssl"] {
            let pool = POOLS.iter().find(|p| p.id == id).expect(id);
            let url = pool
                .url_template
                .replace("{addr}", api_address(pool.kind, "xel:nm46abc"));
            assert_eq!(url, "https://k1pool.com/api/miner/xel/nm46abc", "{id}");
            let host = parse_https_host(&url).expect("https");
            assert!(is_host_allowed(&host), "{id}: {host} not allowlisted");
        }
    }
}


