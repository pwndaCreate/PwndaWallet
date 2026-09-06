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

    // PWNDA pool ids ("pwnda-monero", etc.) intentionally don't appear in
    // POOLS — the Mining UI hides the panel for them, but if a future caller
    // tries one we want a clear error rather than a generic "Unknown".

    let url = pool.url_template.replace("{addr}", &address);

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


