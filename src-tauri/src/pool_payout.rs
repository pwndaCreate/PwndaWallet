//! Pool minimum-payout fetcher.
//!
//! Hits each pool's public config endpoint and returns the live minimum
//! payout. The mining UI's pool dropdown prefers this value over the
//! static fallback in `src/features/mining/pools.ts`.
//!
//! ## Coverage
//!
//! Two flavors:
//!
//! 1. **Pool-wide** (`{addr}`-less endpoints) — gives the pool's floor /
//!    default. Used when no wallet address is available, or when the
//!    pool doesn't expose per-account settings publicly:
//!    - **HeroMiners** (XMR / ZEPH / CFX / RVN) — `/api/stats` returns
//!      `config.minPaymentThreshold` (atomic) and `config.coinUnits`
//!      (atomic per whole coin). Divide for the decimal display.
//!    - **WoolyPooly** (CFX / RVN) — `/api/<pool>-1/stats` returns
//!      top-level `minPay` already in coin units.
//!
//! 2. **Per-user** (`{addr}` substituted) — gives the user's actual
//!    configured threshold, which can differ from the pool default:
//!    - **Nanopool** (CFX) — `/v1/cfx/usersettings/{addr}` returns
//!      `data.minpayout` in coin units. Nanopool's marketing page
//!      advertises "1 CFX minimum" (the pool floor, lowest configurable),
//!      but the settings UI's per-account default for new miners is
//!      **100 CFX** (verified live 2026-05-12). User can configure
//!      anywhere in the 1–100 range. The endpoint returns
//!      `{"status":false,"error":"no data"}` until the user has
//!      submitted at least one valid share — Nanopool has no signup,
//!      accounts come into being on first share. That's why a fresh
//!      CFX miner sees the static fallback for a while before the live
//!      override lands.
//!
//! For pool-wide endpoints, the address argument is ignored. For
//! Nanopool, if no address is passed (or the user isn't yet in the
//! pool DB) the fetcher returns `Ok(None)` and the frontend falls back
//! to the static `minPayout` in `pools.ts` (set to 100 CFX, matching
//! what a brand-new account sees in the Nanopool dashboard).
//!
//! NTMiner, HashVault, PWNDA: no public per-account or pool-wide
//! endpoint we've identified; return `Ok(None)`, frontend falls back to
//! the static value.
//!
//! ## Allowlist + timeout
//!
//! Mirrors `pool_stats.rs`: hard-coded URL list, hostname re-validated
//! before reqwest fires, 8 s timeout per call. The frontend hook fires
//! all visible pools in parallel and merges with the static fallbacks,
//! so a slow / failing endpoint doesn't block the others.

use serde::Serialize;
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 8;

/// Pool-side payout config for one pool. Display string is pre-formatted
/// (e.g. `"1 CFX"`, `"5 RVN"`, `"0.001 XMR"`) so the frontend doesn't
/// have to know about atomic-unit conversion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolPayoutInfo {
    pub pool_id: String,
    pub display: String,
}

struct PayoutEndpoint {
    /// Matches the `id` field in `pools.ts`.
    id: &'static str,
    /// URL template. `{addr}` is substituted with the wallet address;
    /// pool-wide endpoints (HeroMiners / WoolyPooly) don't include the
    /// placeholder and ignore the address argument.
    url_template: &'static str,
    kind: PayoutKind,
    /// Coin ticker for display formatting (e.g. `XMR`, `CFX`).
    ticker: &'static str,
    /// When true the URL contains `{addr}` and the fetcher requires an
    /// address — without one we short-circuit to `Ok(None)`.
    requires_address: bool,
}

#[derive(Copy, Clone)]
enum PayoutKind {
    /// HeroMiners-style: `config.minPaymentThreshold` (atomic, decimal
    /// string), divide by `config.coinUnits` to get whole-coin units.
    HerominersJson,
    /// WoolyPooly-style: top-level `minPay` already in whole-coin units.
    WoolypoolyJson,
    /// Nanopool per-user settings: `data.minpayout` in whole-coin units.
    /// `status: false` → user not registered, return Ok(None) so the
    /// frontend uses the static fallback.
    NanopoolUserSettingsJson,
}

const ENDPOINTS: &[PayoutEndpoint] = &[
    // HeroMiners — one stats endpoint per coin subdomain.
    PayoutEndpoint {
        id: "herominers-monero",
        url_template: "https://monero.herominers.com/api/stats",
        kind: PayoutKind::HerominersJson,
        ticker: "XMR",
        requires_address: false,
    },
    PayoutEndpoint {
        id: "herominers-zephyr",
        url_template: "https://zephyr.herominers.com/api/stats",
        kind: PayoutKind::HerominersJson,
        ticker: "ZEPH",
        requires_address: false,
    },
    PayoutEndpoint {
        id: "herominers-conflux",
        url_template: "https://conflux.herominers.com/api/stats",
        kind: PayoutKind::HerominersJson,
        ticker: "CFX",
        requires_address: false,
    },
    PayoutEndpoint {
        id: "herominers-ravencoin",
        url_template: "https://ravencoin.herominers.com/api/stats",
        kind: PayoutKind::HerominersJson,
        ticker: "RVN",
        requires_address: false,
    },
    // WoolyPooly — uses `<pool-id>-1` slugs, not bare tickers. Same
    // convention as `pool_stats.rs`.
    PayoutEndpoint {
        id: "woolypooly-conflux",
        url_template: "https://api.woolypooly.com/api/cfx-1/stats",
        kind: PayoutKind::WoolypoolyJson,
        ticker: "CFX",
        requires_address: false,
    },
    PayoutEndpoint {
        id: "woolypooly-ravencoin",
        url_template: "https://api.woolypooly.com/api/raven-1/stats",
        kind: PayoutKind::WoolypoolyJson,
        ticker: "RVN",
        requires_address: false,
    },
    // Nanopool — per-user settings endpoint. Returns the user's actual
    // configured `minpayout`, which the user may have set anywhere from
    // the pool floor (1 CFX) to the cap (100 CFX). Same endpoint exists
    // for the EU/US/SSL aliases — they all share the Nanopool backend
    // so the URL template is identical (host doesn't change with region).
    PayoutEndpoint {
        id: "nanopool-conflux",
        url_template: "https://api.nanopool.org/v1/cfx/usersettings/{addr}",
        kind: PayoutKind::NanopoolUserSettingsJson,
        ticker: "CFX",
        requires_address: true,
    },
    PayoutEndpoint {
        id: "nanopool-conflux-ssl",
        url_template: "https://api.nanopool.org/v1/cfx/usersettings/{addr}",
        kind: PayoutKind::NanopoolUserSettingsJson,
        ticker: "CFX",
        requires_address: true,
    },
    PayoutEndpoint {
        id: "nanopool-conflux-us",
        url_template: "https://api.nanopool.org/v1/cfx/usersettings/{addr}",
        kind: PayoutKind::NanopoolUserSettingsJson,
        ticker: "CFX",
        requires_address: true,
    },
    // Ergo (ERG) — Autolykos v2 GPU mining. HeroMiners + WoolyPooly both
    // expose the same JSON schemas as their RVN/CFX siblings, so the
    // existing HerominersJson + WoolypoolyJson parsers handle them as-is.
    // 2Miners ERG and K1Pool ERG have different JSON shapes (not yet
    // parsed) — they fall through to the static `minPayout` in pools.ts.
    PayoutEndpoint {
        id: "herominers-ergo",
        url_template: "https://ergo.herominers.com/api/stats",
        kind: PayoutKind::HerominersJson,
        ticker: "ERG",
        requires_address: false,
    },
    // Slug typo fix (2026-05-15): WoolyPooly's ERG pool ID is `ergo-1`,
    // not `erg-1`. The 3-letter pattern from RVN (`raven-1`) and CFX
    // (`cfx-1`) doesn't generalise to ERG — they use the full coin
    // name. See the matching note in `pool_stats.rs`.
    PayoutEndpoint {
        id: "woolypooly-ergo",
        url_template: "https://api.woolypooly.com/api/ergo-1/stats",
        kind: PayoutKind::WoolypoolyJson,
        ticker: "ERG",
        requires_address: false,
    },
    // Nanopool ERG — per-user min-payout endpoint, same shape as the
    // Conflux variant above. The URL template is identical across EU
    // and US-East regional aliases because Nanopool's API is account-
    // scoped, not pool-scoped.
    PayoutEndpoint {
        id: "nanopool-ergo-eu",
        url_template: "https://api.nanopool.org/v1/ergo/usersettings/{addr}",
        kind: PayoutKind::NanopoolUserSettingsJson,
        ticker: "ERG",
        requires_address: true,
    },
    PayoutEndpoint {
        id: "nanopool-ergo-us",
        url_template: "https://api.nanopool.org/v1/ergo/usersettings/{addr}",
        kind: PayoutKind::NanopoolUserSettingsJson,
        ticker: "ERG",
        requires_address: true,
    },
];

/// Bare hosts these endpoints can reach. Defense in depth — if someone
/// edits a `url` above to a non-pool host the request still gets caught
/// here.
const ALLOWED_HOSTS: &[&str] = &[
    "monero.herominers.com",
    "zephyr.herominers.com",
    "conflux.herominers.com",
    "ravencoin.herominers.com",
    "ergo.herominers.com",
    "api.woolypooly.com",
    "api.nanopool.org",
];

fn is_host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|h| *h == host)
}

fn host_of(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://")?.1;
    Some(after_scheme.split('/').next()?.split(':').next()?)
}

/// Live-fetch the minimum payout for a single pool. `address` is used
/// only by per-user endpoints (Nanopool today) — passing it for a
/// pool-wide endpoint is harmless and ignored. Returns `Ok(None)` when:
///   - the pool isn't in the registry,
///   - the endpoint requires an address and none was passed,
///   - the response indicates the user isn't registered with that pool yet.
/// In all those cases the frontend falls back to the static `minPayout`
/// string in `pools.ts`.
#[tauri::command]
pub async fn fetch_pool_min_payout(
    pool_id: String,
    address: Option<String>,
) -> Result<Option<PoolPayoutInfo>, String> {
    let endpoint = match ENDPOINTS.iter().find(|e| e.id == pool_id) {
        Some(e) => e,
        None => return Ok(None),
    };

    let url = if endpoint.requires_address {
        let Some(addr) = address.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        endpoint.url_template.replace("{addr}", addr)
    } else {
        endpoint.url_template.to_string()
    };

    let host = host_of(&url).ok_or_else(|| "malformed endpoint URL".to_string())?;
    if !is_host_allowed(host) {
        return Err(format!("host not in pool-payout allowlist: {}", host));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent("PwndaWallet-payout-fetcher/1.0")
        .build()
        .map_err(|e| format!("http client build: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {}", resp.status(), url));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("json parse failed: {}", e))?;

    let display_opt = match endpoint.kind {
        PayoutKind::HerominersJson => Some(parse_herominers(&body, endpoint.ticker)?),
        PayoutKind::WoolypoolyJson => Some(parse_woolypooly(&body, endpoint.ticker)?),
        PayoutKind::NanopoolUserSettingsJson => parse_nanopool_user_settings(&body, endpoint.ticker)?,
    };

    Ok(display_opt.map(|display| PoolPayoutInfo {
        pool_id,
        display,
    }))
}

fn parse_herominers(v: &serde_json::Value, ticker: &str) -> Result<String, String> {
    let config = v
        .get("config")
        .ok_or_else(|| "no config field in herominers response".to_string())?;
    let threshold = extract_u128(config, "minPaymentThreshold")
        .ok_or_else(|| "minPaymentThreshold missing or unparseable".to_string())?;
    let units = extract_u128(config, "coinUnits")
        .ok_or_else(|| "coinUnits missing or unparseable".to_string())?;
    if units == 0 {
        return Err("coinUnits is zero".to_string());
    }
    // Decimal division: precision is not load-bearing because this
    // string is for display only.
    let amount = (threshold as f64) / (units as f64);
    Ok(format_amount(amount, ticker))
}

fn parse_woolypooly(v: &serde_json::Value, ticker: &str) -> Result<String, String> {
    let amount = v
        .get("minPay")
        .and_then(|x| x.as_f64().or_else(|| x.as_u64().map(|n| n as f64)))
        .ok_or_else(|| "minPay missing or not a number".to_string())?;
    Ok(format_amount(amount, ticker))
}

/// Nanopool `/v1/<coin>/usersettings/<addr>` response shapes:
///
/// Registered miner:
/// ```json
/// {"status":true,"data":{"email":"...","minpayout":100.0}}
/// ```
/// Unregistered miner (haven't sent at least one share yet):
/// ```json
/// {"status":false,"error":"no data"}
/// ```
///
/// Returns `Ok(None)` for the unregistered case so the frontend falls
/// back to the static `minPayout` from `pools.ts` (Nanopool's account
/// default is 5 CFX). Surfaces an error only when the response is
/// shape-broken (status=true but missing/malformed data).
fn parse_nanopool_user_settings(
    v: &serde_json::Value,
    ticker: &str,
) -> Result<Option<String>, String> {
    let status = v.get("status").and_then(|x| x.as_bool()).unwrap_or(false);
    if !status {
        return Ok(None);
    }
    let data = v
        .get("data")
        .ok_or_else(|| "nanopool usersettings: status=true but no data field".to_string())?;
    let amount = data
        .get("minpayout")
        .and_then(|x| {
            x.as_f64()
                .or_else(|| x.as_u64().map(|n| n as f64))
                .or_else(|| x.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .ok_or_else(|| {
            "nanopool usersettings: minpayout missing or unparseable".to_string()
        })?;
    Ok(Some(format_amount(amount, ticker)))
}

/// Atomic-unit fields come back as decimal strings on some HeroMiners
/// builds (`"1000000000000000000"`) and as raw numbers on others
/// (`100000000`). Accept both. f64 precision is fine because we're going
/// to divide and render to a display string anyway.
fn extract_u128(obj: &serde_json::Value, key: &str) -> Option<u128> {
    let v = obj.get(key)?;
    if let Some(s) = v.as_str() {
        return s.parse::<u128>().ok();
    }
    if let Some(n) = v.as_u64() {
        return Some(n as u128);
    }
    None
}

fn format_amount(amount: f64, ticker: &str) -> String {
    if amount.is_nan() || amount.is_infinite() {
        return format!("? {}", ticker);
    }
    // Trim trailing zeros, max 6 decimal places. `"0.0010 XMR"` → `"0.001 XMR"`.
    let mut s = format!("{:.6}", amount);
    if s.contains('.') {
        s = s
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string();
    }
    if s.is_empty() {
        s = "0".to_string();
    }
    format!("{} {}", s, ticker)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn herominers_cfx_parses() {
        let body = json!({
            "config": {
                "minPaymentThreshold": "1000000000000000000",
                "coinUnits": 1_000_000_000_000_000_000u64,
            }
        });
        let display = parse_herominers(&body, "CFX").expect("parse");
        assert_eq!(display, "1 CFX");
    }

    #[test]
    fn herominers_rvn_parses() {
        let body = json!({
            "config": {
                "minPaymentThreshold": "500000000",
                "coinUnits": 100_000_000u64,
            }
        });
        let display = parse_herominers(&body, "RVN").expect("parse");
        assert_eq!(display, "5 RVN");
    }

    #[test]
    fn herominers_xmr_fractional() {
        let body = json!({
            "config": {
                "minPaymentThreshold": "100000000", // 0.0001 XMR
                "coinUnits": 1_000_000_000_000u64, // 1 XMR = 1e12 piconero
            }
        });
        let display = parse_herominers(&body, "XMR").expect("parse");
        assert_eq!(display, "0.0001 XMR");
    }

    #[test]
    fn woolypooly_parses_int() {
        let body = json!({ "minPay": 1 });
        let display = parse_woolypooly(&body, "CFX").expect("parse");
        assert_eq!(display, "1 CFX");
    }

    #[test]
    fn woolypooly_parses_decimal() {
        let body = json!({ "minPay": 0.5 });
        let display = parse_woolypooly(&body, "RVN").expect("parse");
        assert_eq!(display, "0.5 RVN");
    }

    #[test]
    fn host_extraction() {
        assert_eq!(host_of("https://api.woolypooly.com/api/cfx-1/stats"), Some("api.woolypooly.com"));
        assert_eq!(host_of("https://conflux.herominers.com/api/stats"), Some("conflux.herominers.com"));
        assert_eq!(host_of("notaurl"), None);
    }

    #[test]
    fn unknown_pool_returns_none_without_network() {
        // Don't actually invoke #[tauri::command] body, but sanity-check
        // that the registry lookup returns None for an unknown id.
        assert!(ENDPOINTS.iter().find(|e| e.id == "made-up-pool").is_none());
    }

    #[test]
    fn format_amount_trims_zeros() {
        assert_eq!(format_amount(1.0, "CFX"), "1 CFX");
        assert_eq!(format_amount(0.001, "XMR"), "0.001 XMR");
        assert_eq!(format_amount(5.0, "RVN"), "5 RVN");
    }

    #[test]
    fn nanopool_registered_user_returns_minpayout() {
        let body = json!({
            "status": true,
            "data": { "email": "x@example.com", "minpayout": 100.0 }
        });
        let display = parse_nanopool_user_settings(&body, "CFX")
            .expect("parse")
            .expect("registered user should yield Some");
        assert_eq!(display, "100 CFX");
    }

    #[test]
    fn nanopool_integer_minpayout_parses() {
        // The settings UI's default for fresh CFX accounts is 100. This
        // also verifies integer (not float) values round-trip correctly.
        let body = json!({
            "status": true,
            "data": { "minpayout": 100 }
        });
        let display = parse_nanopool_user_settings(&body, "CFX")
            .expect("parse")
            .expect("Some");
        assert_eq!(display, "100 CFX");
    }

    #[test]
    fn nanopool_floor_minpayout_parses() {
        // User has dialed it down to the pool floor (1 CFX).
        let body = json!({
            "status": true,
            "data": { "minpayout": 1 }
        });
        let display = parse_nanopool_user_settings(&body, "CFX")
            .expect("parse")
            .expect("Some");
        assert_eq!(display, "1 CFX");
    }

    #[test]
    fn nanopool_unregistered_user_returns_none() {
        let body = json!({ "status": false, "error": "no data" });
        let result = parse_nanopool_user_settings(&body, "CFX").expect("parse");
        assert!(result.is_none(), "unregistered user should fall back");
    }

    #[test]
    fn nanopool_account_not_found_returns_none() {
        let body = json!({ "status": false, "error": "Account not found" });
        let result = parse_nanopool_user_settings(&body, "CFX").expect("parse");
        assert!(result.is_none());
    }

    #[test]
    fn nanopool_string_minpayout_parses() {
        // Defensive: older Nanopool variants used a string field.
        let body = json!({
            "status": true,
            "data": { "minpayout": "10.5" }
        });
        let display = parse_nanopool_user_settings(&body, "CFX")
            .expect("parse")
            .expect("Some");
        assert_eq!(display, "10.5 CFX");
    }

    #[test]
    fn nanopool_broken_shape_surfaces_error() {
        // status=true but no data field — that's a bug we want to know about.
        let body = json!({ "status": true });
        let result = parse_nanopool_user_settings(&body, "CFX");
        assert!(result.is_err());
    }
}
