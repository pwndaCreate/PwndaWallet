//! SOCKS5 proxy pool for "Proxy Mode" — when a user is behind an aggressive
//! firewall that blocks every direct stratum port we ship, they can flip a
//! toggle and the wallet will route mining/smoke-test traffic through a free
//! public SOCKS5 proxy harvested from rotating community lists.
//!
//! This is **(B) the mining SOCKS5 privacy proxy** — the canonical, unqualified
//! "proxy" in mining UI + code. Distinct from the wallet swap relay (C,
//! `src/api/proxy.ts`) and the RPC/CORS relay (D, `http_proxy.rs`). The former
//! dev-fee stratum proxy (A) was removed in the pure-wallet cutover.
//!
//! ## Pipeline
//!
//! 1. **Fetch** — round-robin pull from a small set of public proxy-list
//!    aggregators (GitHub-hosted text dumps + a couple of JSON APIs). Each
//!    refresh picks a random subset of sources to avoid hammering any one
//!    aggregator and to mix the pool of candidates.
//! 2. **Dedupe** — collapse to a unique `(host, port)` set.
//! 3. **Validate** — for each candidate concurrently (capped fan-out): open
//!    a SOCKS5 tunnel, CONNECT through to the user's *actual* pool target,
//!    optionally drive the permissive TLS handshake, measure round-trip
//!    latency. A proxy that works generically but is blocklisted by the
//!    pool will fail this stage — that's the point.
//! 4. **Rank** — sort working candidates by latency, expose the top N.
//!
//! ## What we deliberately don't do
//!
//! - Persist results to disk. Free proxies churn within hours; a fresh
//!   refresh on each app launch is the safer default.
//! - Authenticate with username/password. We only accept `0x00` (no-auth)
//!   SOCKS5 handshakes — those are what aggregator lists ship.
//! - Hide the security warning. Routing stratum through random proxies
//!   means the operator can MITM unencrypted traffic. The frontend renders
//!   a warning before letting the user toggle on; this module just provides
//!   the data plane.

use rand::seq::SliceRandom;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;
use tokio_socks::tcp::Socks5Stream;

use crate::pool_ping;

const FETCH_TIMEOUT_SECS: u64 = 8;
/// Per-candidate validation budget — TCP-to-proxy + SOCKS5 handshake +
/// CONNECT through to target + optional TLS + settle read + optional
/// stratum probe. Bumped from 6 s → 10 s (2026-05-24) to absorb the new
/// stratum-layer probe at the tail of the validation chain. Most
/// working proxies still respond in under 2 s; dead ones still bail
/// fast on the TCP layer.
const VALIDATE_TIMEOUT_SECS: u64 = 10;
/// Cap on concurrent validations. Bumped from 24 to keep total wall time
/// short even with the larger candidate pool. Trade-off is more open
/// sockets — Defender hasn't flagged us at this level so far.
const VALIDATE_CONCURRENCY: usize = 40;
/// Top-N working proxies the frontend cares about. Anything beyond that
/// is unused even if working — mostly noise. The mining proxy's
/// auto-rotation path (Gap 1, 2026-05-24) uses positions 2..=11 as the
/// rotation fallback pool when the primary dies mid-session, so this
/// number doubles as "max fallback rotations available."
const KEEP_TOP_N: usize = 12;
/// Per-port cap during ranking so the surfaced list isn't dominated by
/// one port (free-proxy harvesters tend to over-represent 4145, 1080).
/// Within-port we still sort by latency, so the cap picks the fastest
/// per port. If the candidate pool is too thin to fill `KEEP_TOP_N`
/// under the cap, leftover slots are filled by raw-latency order.
const PER_PORT_CAP: usize = 2;
/// Settle-check budget: after CONNECT (and TLS, if SSL) we attempt a
/// 1-byte read. Catches the common "proxy completes the handshake but
/// resets when application data starts flowing" failure that produced
/// the false-positive HeroMiners pass (smoke test ✓ → xmrig ECONNRESET).
///
/// 2026-05-24 — bumped from 1500 ms → 5000 ms (Gap 2). The shorter
/// window only caught proxies that died on the *first* byte; many free
/// SOCKS5 proxies pass byte-level checks then drop the connection within
/// 30 s. Five seconds is the longest we can wait without making refresh
/// painful; it catches the "dies in first 5 s" class of failures (a
/// strict subset of the 30 s class but the most common).
const SETTLE_TIMEOUT_MS: u64 = 5000;
/// Stratum-layer probe budget. After settle-read, optionally write a real
/// `mining.subscribe` (V1) or `login` (RandomX) frame and wait for any
/// well-formed JSON-RPC response. Catches proxies that pass byte-level
/// checks but mangle stratum framing (Gap 6, 2026-05-24). Tight cap so
/// it doesn't dominate validation latency.
const STRATUM_PROBE_TIMEOUT_MS: u64 = 3000;
/// Maximum candidates to validate per refresh. Sources can return 5k+
/// entries; validating them all would take forever and waste bandwidth.
///
/// 2026-05-24 — bumped from 100 → 200 (Gap 4). At 40-way concurrency ×
/// 10 s budget, worst-case wall time is ~50 s (up from ~15 s). Working
/// hit-rate from the lists is 10–15 %, so 200 candidates surfaces
/// 20–30 working entries — enough for the rotation pool (Gap 1) to
/// keep mining alive through multiple proxy failures without manual
/// refresh.
const VALIDATE_BUDGET: usize = 200;

/// Public proxy-list sources. Order matters: the first few are stable
/// GitHub-hosted text dumps that update on a CI cadence; the API hosts
/// further down rate-limit and occasionally 5xx. Each refresh picks a
/// random subset (`SOURCES_PER_REFRESH`) to spread load and mix
/// candidates.
const SOURCES: &[&str] = &[
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000",
    "https://www.proxy-list.download/api/v1/get?type=socks5",
    "https://proxylist.geonode.com/api/proxy-list?protocols=socks5&limit=200",
];

const SOURCES_PER_REFRESH: usize = 3;

/// Hosts the fetcher is allowed to talk to. Mirrors `pool_stats::ALLOWED_HOSTS`
/// pattern — even though SOURCES is hardcoded, the allowlist is a backstop
/// for any future bug that mis-routes a fetch.
const ALLOWED_SOURCE_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "api.proxyscrape.com",
    "www.proxy-list.download",
    "proxylist.geonode.com",
];

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
struct Candidate {
    host: String,
    port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHealth {
    /// `host:port` form, used as the stable identifier in the frontend.
    pub host_port: String,
    /// End-to-end latency: TCP-to-proxy + SOCKS5 + CONNECT + TLS (if ssl).
    pub latency_ms: u64,
    /// Whether the full validation chain succeeded against the target.
    pub ok: bool,
    /// Wall-clock unix-millis when validation finished.
    pub validated_at: u64,
    /// Furthest stage reached on failure: "tcp" / "socks" / "connect" /
    /// "tls" / "settle" / "stratum" / "ok".
    pub stage: &'static str,
    /// 2026-05-24 (Gap 2) — composite score blending latency, settle
    /// stability, and stratum-probe success. Higher = better. Range
    /// roughly [0.0, 100.0]. Used by the ranking step in `proxy_refresh`
    /// to prefer proxies that aren't just fast but also held the
    /// connection open under sustained load.
    #[serde(default)]
    pub stability_score: f64,
    /// 2026-05-24 (Gap 6) — true when the optional stratum-layer probe
    /// succeeded (got a well-formed JSON-RPC response to our subscribe/
    /// login frame). `false` when the probe was skipped (non-TLS target
    /// or stratum timeout); doesn't disqualify the proxy on its own.
    #[serde(default)]
    pub stratum_ok: bool,
    /// 2026-05-24 (Gap 3) — reputation score pulled from the persistent
    /// store at the moment of ranking. `0.0` for hosts we've never seen
    /// before; higher for hosts with recent successful mining sessions.
    /// Combined with `stability_score` in the final ranking sort.
    #[serde(default)]
    pub reputation_score: f64,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    /// All validated entries (working + failed), sorted with working first
    /// by latency. Frontend filters to working ones for display.
    pub validated: Vec<ProxyHealth>,
    /// Total candidates fetched across the chosen sources after dedupe —
    /// useful for the UI to show "tested 240 of 4128".
    pub candidates_fetched: usize,
    pub candidates_validated: usize,
    pub working_count: usize,
    pub last_refresh_at_ms: u64,
    /// Identifies the pool target this validation was for. The frontend
    /// re-validates when the user changes pool.
    pub target: TargetSummary,
    /// Sources actually hit this refresh (subset of `SOURCES`).
    pub sources: Vec<String>,
    /// Soft error — set when fetch partially failed but we still got
    /// usable candidates. Hard errors are returned via `Result::Err`.
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TargetSummary {
    pub host: String,
    pub port: u16,
    pub ssl: bool,
}

#[derive(Debug, Default)]
pub struct ProxyState {
    pub last: Option<RefreshResult>,
    pub refreshing: bool,
}

pub struct ProxyStateLock(pub Mutex<ProxyState>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extract the port from a `host:port` string. Returns 0 on parse failure
/// — that bucket then gets its own "unknown port" slot, which is fine for
/// diversity since well-formed entries dominate.
fn parse_port(host_port: &str) -> u16 {
    host_port
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse().ok())
        .unwrap_or(0)
}

fn url_host(url: &str) -> Option<&str> {
    let s = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let end = s.find(|c: char| c == '/' || c == '?' || c == '#').unwrap_or(s.len());
    Some(&s[..end])
}

/// Parse one source body into candidates. Handles both plaintext
/// `host:port` lines and the geonode `{"data": [{"ip", "port"}, …]}` JSON.
fn parse_candidates(body: &str) -> Vec<Candidate> {
    // JSON shape (geonode) — try first, only succeeds for valid JSON
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
            return data
                .iter()
                .filter_map(|item| {
                    let ip = item.get("ip").and_then(|v| v.as_str())?.to_string();
                    let port_v = item.get("port")?;
                    let port: u16 = match port_v {
                        Value::String(s) => s.parse().ok()?,
                        Value::Number(n) => n.as_u64()? as u16,
                        _ => return None,
                    };
                    Some(Candidate { host: ip, port })
                })
                .collect();
        }
    }

    // Plaintext fallback
    body.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            // Some sources prefix with the protocol scheme.
            let stripped = line
                .trim_start_matches("socks5://")
                .trim_start_matches("socks4://")
                .trim_start_matches("socks://");
            let (host, port_str) = stripped.rsplit_once(':')?;
            // Reject obvious garbage (whitespace, html fragments)
            if host.is_empty() || host.contains(' ') || host.contains('<') {
                return None;
            }
            let port: u16 = port_str.parse().ok()?;
            Some(Candidate {
                host: host.to_string(),
                port,
            })
        })
        .collect()
}

async fn fetch_source(client: &reqwest::Client, url: &str) -> Result<Vec<Candidate>, String> {
    let host = url_host(url).ok_or_else(|| format!("malformed source URL: {}", url))?;
    if !ALLOWED_SOURCE_HOSTS.iter().any(|h| h == &host) {
        return Err(format!("source host not in allowlist: {}", host));
    }
    let resp = timeout(Duration::from_secs(FETCH_TIMEOUT_SECS), client.get(url).send())
        .await
        .map_err(|_| format!("source timeout: {}", url))?
        .map_err(|e| format!("fetch error from {}: {}", host, e))?;
    if !resp.status().is_success() {
        return Err(format!("{} returned HTTP {}", host, resp.status()));
    }
    let body = timeout(Duration::from_secs(FETCH_TIMEOUT_SECS), resp.text())
        .await
        .map_err(|_| format!("body timeout: {}", url))?
        .map_err(|e| format!("body read error from {}: {}", host, e))?;
    Ok(parse_candidates(&body))
}

/// Run one batch of source fetches concurrently. Returns merged candidates,
/// the URLs that succeeded, and per-source errors. Pure helper — no
/// fallback / retry logic, that's `fetch_candidates`'s job.
async fn fetch_batch(
    client: &reqwest::Client,
    urls: &[&str],
) -> (HashSet<Candidate>, Vec<String>, Vec<String>) {
    let futures = urls.iter().map(|&url| {
        let client = client.clone();
        async move { (url.to_string(), fetch_source(&client, url).await) }
    });
    let results = futures_util::future::join_all(futures).await;

    let mut all: HashSet<Candidate> = HashSet::new();
    let mut errors: Vec<String> = Vec::new();
    let mut hit_sources: Vec<String> = Vec::new();
    for (url, result) in results {
        match result {
            Ok(cands) => {
                hit_sources.push(url);
                for c in cands {
                    all.insert(c);
                }
            }
            Err(e) => errors.push(e),
        }
    }
    (all, hit_sources, errors)
}

/// True when an error message looks like a network-layer failure (DNS
/// resolution, TCP connect refused, timeout). When all sources fail with
/// these patterns, the user almost certainly has a local network problem
/// (broken DNS / firewall / VPN cleanup) rather than every aggregator
/// being simultaneously down.
fn looks_like_network_failure(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("dns")
        || m.contains("resolve")
        || m.contains("getaddrinfo")
        || m.contains("connection refused")
        || m.contains("connection reset")
        || m.contains("permission denied")
        || m.contains("os error 10013") // Windows WSAEACCES
        || m.contains("os error 11001") // Windows WSAHOST_NOT_FOUND
        || m.contains("network is unreachable")
        || m.contains("timeout")
        || m.contains("timed out")
}

/// Fetch from a randomized subset of sources concurrently, dedupe, and
/// truncate to the validation budget. Falls back to the remaining sources
/// when the first subset comes back empty so a transient rate-limit on a
/// single CDN doesn't cause a "no proxies available" wall.
async fn fetch_candidates() -> Result<(Vec<Candidate>, Vec<String>, Option<String>), String> {
    let mut shuffled: Vec<&str> = SOURCES.to_vec();
    shuffled.shuffle(&mut rand::thread_rng());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    // First pass: random subset (`SOURCES_PER_REFRESH` = 3).
    let first_subset: Vec<&str> = shuffled
        .iter()
        .take(SOURCES_PER_REFRESH)
        .copied()
        .collect();
    let (mut all, mut hit_sources, mut errors) = fetch_batch(&client, &first_subset).await;

    // Fallback: if the random subset returned zero candidates, try the
    // remaining sources before giving up. Avoids a "no proxies" wall when
    // the picked aggregators all happened to be 5xx / rate-limited.
    if all.is_empty() {
        let remaining: Vec<&str> = shuffled
            .iter()
            .skip(SOURCES_PER_REFRESH)
            .copied()
            .collect();
        if !remaining.is_empty() {
            let (more, more_hit, more_err) = fetch_batch(&client, &remaining).await;
            for c in more {
                all.insert(c);
            }
            hit_sources.extend(more_hit);
            errors.extend(more_err);
        }
    }

    if all.is_empty() {
        // Categorize the failure mode. If every error looks like a local
        // network problem (DNS, TCP refused, timeout), surface remediation
        // tips inline so the user doesn't have to dig into the Rust error.
        let all_network = !errors.is_empty()
            && errors.iter().all(|e| looks_like_network_failure(e));
        let detail = errors.join("; ");
        if all_network {
            return Err(format!(
                "Proxy sources unreachable from PwndaWallet — looks like a local network issue. \
                 Try in order: (1) `ipconfig /flushdns` (cmd, no admin), \
                 (2) check Windows Firewall outbound rules for PwndaWallet, \
                 (3) `netsh winsock reset` (admin) + reboot if you recently used a VPN. \
                 [verbose: {}]",
                detail
            ));
        }
        return Err(format!(
            "All proxy sources failed (likely transient — try again in 30s). [verbose: {}]",
            detail
        ));
    }

    let mut deduped: Vec<Candidate> = all.into_iter().collect();
    deduped.shuffle(&mut rand::thread_rng());
    deduped.truncate(VALIDATE_BUDGET);

    let soft_error = if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    };
    Ok((deduped, hit_sources, soft_error))
}

async fn validate_one(
    candidate: Candidate,
    target_host: String,
    target_port: u16,
    ssl: bool,
) -> ProxyHealth {
    let host_port = format!("{}:{}", candidate.host, candidate.port);
    let start = Instant::now();
    let dur = Duration::from_secs(VALIDATE_TIMEOUT_SECS);

    let connect = timeout(
        dur,
        Socks5Stream::connect(
            (candidate.host.as_str(), candidate.port),
            (target_host.as_str(), target_port),
        ),
    )
    .await;
    let stream = match connect {
        Ok(Ok(s)) => s,
        Ok(Err(_)) => return fail_health(&host_port, start.elapsed().as_millis() as u64, "socks"),
        Err(_) => return fail_health(&host_port, dur.as_millis() as u64, "socks"),
    };

    // Settle check is run after handshake (TLS or none). Result of that
    // gates the stratum probe — no point probing a half-open socket.
    if !ssl {
        let mut tcp = stream.into_inner();
        let settled = settle_read_check(&mut tcp).await;
        if settled.is_err() {
            return ProxyHealth {
                host_port,
                latency_ms: start.elapsed().as_millis() as u64,
                ok: false,
                validated_at: now_ms(),
                stage: "settle",
                stability_score: 0.0,
                stratum_ok: false,
                reputation_score: 0.0,
            };
        }
        // Plain-TCP stratum probe (rare path — most modern pools require
        // TLS but some Monero pools still offer plain endpoints like
        // `pool.host:1111`).
        let stratum_ok = stratum_probe_check(&mut tcp).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        return ProxyHealth {
            host_port,
            latency_ms,
            ok: true,
            validated_at: now_ms(),
            stage: if stratum_ok { "ok" } else { "stratum" },
            stability_score: compute_stability_score(true, stratum_ok, latency_ms),
            stratum_ok,
            reputation_score: 0.0,
        };
    }

    // TLS handshake on the inner tunneled stream — same permissive verifier
    // as direct probes so self-signed pool certs don't false-fail.
    let inner = stream.into_inner();
    let server_name = match tokio_rustls::rustls::pki_types::ServerName::try_from(target_host.clone()) {
        Ok(n) => n,
        Err(_) => return fail_health(&host_port, start.elapsed().as_millis() as u64, "tls"),
    };

    let remaining = dur.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return fail_health(&host_port, dur.as_millis() as u64, "tls");
    }

    let mut tls_stream = match timeout(remaining, pool_ping::tls_connector().connect(server_name, inner)).await {
        Ok(Ok(s)) => s,
        _ => return fail_health(&host_port, start.elapsed().as_millis() as u64, "tls"),
    };
    let settled = settle_read_check(&mut tls_stream).await;
    if settled.is_err() {
        return ProxyHealth {
            host_port,
            latency_ms: start.elapsed().as_millis() as u64,
            ok: false,
            validated_at: now_ms(),
            stage: "settle",
            stability_score: 0.0,
            stratum_ok: false,
            reputation_score: 0.0,
        };
    }
    // Gap 6 (2026-05-24) — stratum-layer probe inside the TLS tunnel.
    // Catches proxies that pass byte-level but mangle the bidirectional
    // JSON-RPC framing pools use. Falls back to "ok but no stratum
    // confirmation" if the pool stays silent (some RandomX pools won't
    // respond to a bare `mining.subscribe` without a prior `login`).
    let stratum_ok = stratum_probe_check(&mut tls_stream).await;
    let latency_ms = start.elapsed().as_millis() as u64;
    ProxyHealth {
        host_port,
        latency_ms,
        ok: true,
        validated_at: now_ms(),
        stage: if stratum_ok { "ok" } else { "stratum" },
        stability_score: compute_stability_score(true, stratum_ok, latency_ms),
        stratum_ok,
        reputation_score: 0.0,
    }
}

/// Shorthand for the early-return fail paths in `validate_one`. Returns a
/// `ProxyHealth` flagged as failed at the given stage with all the
/// 2026-05-24 scoring fields zeroed out.
fn fail_health(host_port: &str, latency_ms: u64, stage: &'static str) -> ProxyHealth {
    ProxyHealth {
        host_port: host_port.to_string(),
        latency_ms,
        ok: false,
        validated_at: now_ms(),
        stage,
        stability_score: 0.0,
        stratum_ok: false,
        reputation_score: 0.0,
    }
}

/// 2026-05-24 (Gap 2) — composite score blending whether the proxy passed
/// every stage and how fast it did. Range roughly [0.0, 100.0]; higher is
/// better. `reputation_score` is added on top by the ranking step in
/// `proxy_refresh` so this function doesn't need to know about persistence.
fn compute_stability_score(ok: bool, stratum_ok: bool, latency_ms: u64) -> f64 {
    if !ok {
        return 0.0;
    }
    // Base: 50 for any working proxy. Capped at 80 once stratum confirms.
    let mut score = 50.0_f64;
    if stratum_ok {
        score += 30.0;
    }
    // Latency penalty: -1 per 100 ms over the network. Below 200 ms a
    // proxy is basically local-feeling; above 3 s it's borderline unusable
    // even if "ok."
    let latency_penalty = (latency_ms as f64) / 100.0;
    (score - latency_penalty).max(0.0)
}

/// Post-handshake liveness probe — read 1 byte with a short timeout.
/// Returns Ok if the connection is still alive (timeout = pool waiting
/// silently is the most common case; non-zero read = pool sent a banner
/// or initial difficulty notification, also fine). Returns Err if the
/// peer closed gracefully or the socket errored — those are the
/// "smoke test passed but mining will fail" cases we're filtering out.
async fn settle_read_check<S>(stream: &mut S) -> Result<(), String>
where
    S: AsyncReadExt + Unpin,
{
    let mut buf = [0u8; 1];
    match timeout(Duration::from_millis(SETTLE_TIMEOUT_MS), stream.read(&mut buf)).await {
        Ok(Ok(0)) => Err("peer closed connection".to_string()),
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("post-handshake error: {}", e)),
        Err(_) => Ok(()), // timeout — pool waiting silently for client; fine
    }
}

/// 2026-05-24 (Gap 6) — stratum-layer probe. Sends a bare
/// `mining.subscribe` frame and waits for any JSON-RPC response within
/// `STRATUM_PROBE_TIMEOUT_MS`. Returns `true` when the pool replies with
/// well-formed JSON (any response — accept, error, or unknown-method —
/// proves the bidirectional stratum path is intact through the proxy).
/// Returns `false` on write error, no response within timeout, or
/// malformed bytes.
///
/// Doesn't disqualify the proxy on its own; settle_read_check above
/// already passed. A `false` here just means "we couldn't get stratum
/// confirmation," which lowers `stability_score` but keeps the proxy in
/// the candidate pool. RandomX pools that strictly want `login` first
/// will return `false` here, which is fine — they'll still work for
/// mining once the miner sends a proper login frame.
async fn stratum_probe_check<S>(stream: &mut S) -> bool
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    const PROBE_FRAME: &[u8] = b"{\"id\":0,\"method\":\"mining.subscribe\",\"params\":[]}\n";
    if timeout(
        Duration::from_millis(STRATUM_PROBE_TIMEOUT_MS / 3),
        stream.write_all(PROBE_FRAME),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .is_none()
    {
        return false;
    }

    // Read up to 1 KB of response — enough for any reasonable JSON-RPC
    // reply. Don't strictly parse; just check that we got bytes that
    // look JSON-ish (start with `{` after optional whitespace).
    let mut buf = [0u8; 1024];
    match timeout(
        Duration::from_millis(STRATUM_PROBE_TIMEOUT_MS * 2 / 3),
        stream.read(&mut buf),
    )
    .await
    {
        Ok(Ok(n)) if n > 0 => {
            let head = std::str::from_utf8(&buf[..n]).unwrap_or("").trim_start();
            head.starts_with('{')
        }
        _ => false,
    }
}

async fn validate_candidates(
    candidates: Vec<Candidate>,
    target_host: String,
    target_port: u16,
    ssl: bool,
) -> Vec<ProxyHealth> {
    use futures_util::stream::StreamExt;

    let stream = futures_util::stream::iter(candidates.into_iter().map(|c| {
        let th = target_host.clone();
        async move { validate_one(c, th, target_port, ssl).await }
    }))
    .buffer_unordered(VALIDATE_CONCURRENCY);

    stream.collect::<Vec<_>>().await
}

/// Tauri command — fetch candidates, validate against the user's target
/// pool, return a ranked health list. State is persisted in
/// `ProxyStateLock` so the frontend can call `proxy_get_state` to re-read
/// the latest result without re-running validation.
#[tauri::command]
pub async fn proxy_refresh(
    app: tauri::AppHandle,
    target_host: String,
    target_port: u16,
    ssl: bool,
) -> Result<RefreshResult, String> {
    use tauri::Manager;

    if target_host.trim().is_empty() {
        return Err("empty target host".to_string());
    }

    {
        let state = app.state::<ProxyStateLock>();
        let mut lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if lock.refreshing {
            return Err("refresh already in progress".to_string());
        }
        lock.refreshing = true;
    }

    let outcome = async {
        let (candidates, hit_sources, soft_error) = fetch_candidates().await?;
        let candidates_fetched = candidates.len();
        let mut healths =
            validate_candidates(candidates, target_host.clone(), target_port, ssl).await;

        // 2026-05-24 (Gaps 3 + 5) — fold persistent reputation into each
        // health entry before ranking. Known-good proxies (recent
        // successful sessions, long uptime, few recent failures) get a
        // bonus that floats them above raw-latency-only winners.
        let reputation = reputation::load(&app);
        for h in healths.iter_mut() {
            h.reputation_score = reputation.score_for(&h.host_port);
        }

        // Working first; among working entries, sort by combined score
        // (stability + reputation) descending, falling back to latency
        // ascending when scores tie. Failed entries trail at the end so
        // the frontend can show "tested N, working M."
        healths.sort_by(|a, b| match (a.ok, b.ok) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let a_total = a.stability_score + a.reputation_score;
                let b_total = b.stability_score + b.reputation_score;
                b_total
                    .partial_cmp(&a_total)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.latency_ms.cmp(&b.latency_ms))
            }
        });
        let candidates_validated = healths.len();
        let working_count = healths.iter().filter(|h| h.ok).count();

        // Port-diverse top selection. Walk working entries in latency order
        // and admit each to the result while a `PER_PORT_CAP` budget per
        // port permits — that gives a mix of 1080 / 4145 / 9050 / etc.
        // instead of a list dominated by whichever port happens to be
        // overrepresented in the candidate pool. Backfill remaining slots
        // by raw latency so the list is never artificially short.
        let mut top: Vec<ProxyHealth> = Vec::with_capacity(KEEP_TOP_N);
        let mut port_count: HashMap<u16, usize> = HashMap::new();
        for h in healths.iter().filter(|h| h.ok) {
            if top.len() >= KEEP_TOP_N {
                break;
            }
            let port = parse_port(&h.host_port);
            let count = port_count.entry(port).or_insert(0);
            if *count >= PER_PORT_CAP {
                continue;
            }
            *count += 1;
            top.push(h.clone());
        }
        if top.len() < KEEP_TOP_N {
            for h in healths.iter().filter(|h| h.ok) {
                if top.len() >= KEEP_TOP_N {
                    break;
                }
                if top.iter().any(|p| p.host_port == h.host_port) {
                    continue;
                }
                top.push(h.clone());
            }
        }

        let failed_sample: Vec<ProxyHealth> = healths.iter().filter(|h| !h.ok).take(3).cloned().collect();
        top.extend(failed_sample);

        Ok::<_, String>(RefreshResult {
            validated: top,
            candidates_fetched,
            candidates_validated,
            working_count,
            last_refresh_at_ms: now_ms(),
            target: TargetSummary {
                host: target_host,
                port: target_port,
                ssl,
            },
            sources: hit_sources,
            error: soft_error,
        })
    }
    .await;

    let state = app.state::<ProxyStateLock>();
    let mut lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    lock.refreshing = false;
    match &outcome {
        Ok(r) => lock.last = Some(r.clone()),
        Err(_) => {}
    }
    outcome
}

/// Read the most recent refresh result without re-running validation.
/// Returns `None` if no refresh has run yet this session.
#[tauri::command]
pub async fn proxy_get_state(app: tauri::AppHandle) -> Result<Option<RefreshResult>, String> {
    use tauri::Manager;
    let state = app.state::<ProxyStateLock>();
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(lock.last.clone())
}

// -----------------------------------------------------------------------
// Reputation store (Gaps 3 + 5, 2026-05-24)
//
// Persistent per-proxy reliability tracking. Lives at
// `<app_local_data_dir>/socks5_reputation.json`. Keyed by `host:port`.
// Updated by:
//   * `proxy_pool_record_session_alive` — the mining session reports
//     "this proxy held the mining session open for N ms"
//   * `proxy_pool_record_failure` — reports "this proxy died mid-session"
// Read by:
//   * `proxy_refresh` — applies `reputation_score` to each candidate
//     before the ranking sort, so known-good proxies float above unknown
//     ones at the same latency
//   * `proxy_pool_get_rotation_pool` — the next candidate is the
//     highest-reputation entry in the validated list (excluding the one
//     that just failed)
//
// Store is tiny — at most ~12-30 entries (KEEP_TOP_N + a small history
// margin). Sync I/O is fine; mutation happens at most once per minute.
// -----------------------------------------------------------------------

pub(crate) mod reputation {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Manager};

    /// One row of the on-disk reputation store. All times in unix-ms.
    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    pub struct ReputationRow {
        /// Most recent unix-ms when a mining session using this proxy
        /// ended cleanly (i.e. not torn down by proxy failure). Used by
        /// the recency bonus.
        #[serde(default)]
        pub last_success_at_ms: u64,
        /// Cumulative wall-clock ms this proxy has held a mining session
        /// alive across all sessions. Cap'd at 24h-equivalent in the
        /// scoring formula so a single great proxy doesn't dominate.
        #[serde(default)]
        pub total_alive_ms: u64,
        /// Count of consecutive failures since the last clean session.
        /// Reset to 0 on any `record_success`. Used by the failure
        /// penalty term.
        #[serde(default)]
        pub recent_failures: u32,
        /// Most recent unix-ms when the row was touched in any way
        /// (success or failure). Lets us prune ancient entries during
        /// load to keep the file small.
        #[serde(default)]
        pub last_seen_at_ms: u64,
    }

    /// In-memory snapshot — owned by `proxy_refresh` for the duration of
    /// the ranking pass. Cheap to construct (one file read) and dropped
    /// immediately after; no long-lived cache to risk going stale across
    /// concurrent sessions.
    pub struct Snapshot {
        rows: BTreeMap<String, ReputationRow>,
    }

    impl Snapshot {
        /// 2026-05-24 — reputation score in [0.0, 50.0]. Combined with
        /// `stability_score` in [0.0, ~80.0] for ranking. Reputation can
        /// at most boost a proxy by half its stability — protects against
        /// stale-reputation overrides when a once-good proxy goes bad.
        ///
        /// Formula breakdown:
        ///
        ///   - recency_bonus: 30 × exp(-age_hours/24) for age <24h
        ///                    5 × exp(-age_hours/168) for age 24h..1wk
        ///                    0 for age > 1 week
        ///   - alive_bonus: min(total_alive_ms / 1h, 5) × 4   (max 20)
        ///   - failure_penalty: min(recent_failures × 5, 25)
        ///
        ///   raw = recency_bonus + alive_bonus - failure_penalty
        ///   score = raw.max(0.0)
        pub fn score_for(&self, host_port: &str) -> f64 {
            let Some(row) = self.rows.get(host_port) else {
                return 0.0;
            };
            let now = now_ms();
            let age_hours = if row.last_success_at_ms == 0 || now < row.last_success_at_ms {
                f64::INFINITY
            } else {
                ((now - row.last_success_at_ms) as f64) / 3_600_000.0
            };

            let recency_bonus = if age_hours < 24.0 {
                30.0 * (-age_hours / 24.0).exp()
            } else if age_hours < 168.0 {
                5.0 * (-(age_hours - 24.0) / 168.0).exp()
            } else {
                0.0
            };

            let alive_hours = (row.total_alive_ms as f64) / 3_600_000.0;
            let alive_bonus = alive_hours.min(5.0) * 4.0;

            let failure_penalty = ((row.recent_failures as f64) * 5.0).min(25.0);

            (recency_bonus + alive_bonus - failure_penalty).max(0.0)
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Resolve `<app_local_data_dir>/socks5_reputation.json`. Returns
    /// `None` when the path can't be resolved (rare; tests / very early
    /// startup). Caller treats `None` as "no persistence available" and
    /// degrades to in-memory-only behaviour.
    fn store_path(app: &AppHandle) -> Option<PathBuf> {
        let dir = app.path().app_local_data_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir.join("socks5_reputation.json"))
    }

    /// One global mutex around file I/O. Reputation mutations are rare
    /// (at most once per minute per session); the lock is held for
    /// microseconds. Avoids interleaved partial writes from concurrent
    /// `record_*` calls across multiple proxy sessions.
    static IO_LOCK: Mutex<()> = Mutex::new(());

    /// Load the store from disk. Missing file → empty snapshot. Malformed
    /// JSON → empty snapshot (silently — we don't want a corrupt file to
    /// block refresh; the next save overwrites it).
    pub fn load(app: &AppHandle) -> Snapshot {
        let Some(path) = store_path(app) else {
            return Snapshot { rows: BTreeMap::new() };
        };
        let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let rows = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<BTreeMap<String, ReputationRow>>(&s)
                .unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        };
        Snapshot { rows }
    }

    /// Persist updated rows. Atomic-replace via temp-file + rename so a
    /// crashed write doesn't truncate the existing store.
    fn save(app: &AppHandle, rows: &BTreeMap<String, ReputationRow>) {
        let Some(path) = store_path(app) else { return };
        let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let serialized = match serde_json::to_string_pretty(rows) {
            Ok(s) => s,
            Err(_) => return,
        };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serialized).is_err() {
            return;
        }
        let _ = std::fs::rename(&tmp, &path);
    }

    /// Record a clean mining session — proxy held the connection alive
    /// for `alive_ms`. Bumps `last_success_at_ms`, adds to
    /// `total_alive_ms`, resets `recent_failures` to 0.
    pub fn record_success(app: &AppHandle, host_port: &str, alive_ms: u64) {
        let Some(path) = store_path(app) else { return };
        let mut rows = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<BTreeMap<String, ReputationRow>>(&s)
                .unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        };
        let now = now_ms();
        let entry = rows
            .entry(host_port.to_string())
            .or_insert_with(ReputationRow::default);
        entry.last_success_at_ms = now;
        entry.total_alive_ms = entry.total_alive_ms.saturating_add(alive_ms);
        entry.recent_failures = 0;
        entry.last_seen_at_ms = now;
        save(app, &rows);
    }

    /// Record a failure — proxy died mid-session or never connected.
    /// Increments `recent_failures` (capped at u32::MAX) but does NOT
    /// touch `last_success_at_ms`. Five consecutive failures with no
    /// intervening success put the proxy at the floor of the ranking.
    pub fn record_failure(app: &AppHandle, host_port: &str) {
        let Some(path) = store_path(app) else { return };
        let mut rows = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<BTreeMap<String, ReputationRow>>(&s)
                .unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        };
        let now = now_ms();
        let entry = rows
            .entry(host_port.to_string())
            .or_insert_with(ReputationRow::default);
        entry.recent_failures = entry.recent_failures.saturating_add(1);
        entry.last_seen_at_ms = now;
        save(app, &rows);
    }
}

// -----------------------------------------------------------------------
// Tauri command surface for reputation + rotation
// -----------------------------------------------------------------------

/// Record that a mining session using `host_port` held the connection
/// alive for `alive_ms`. Called by the frontend at clean session end.
///
/// 2026-05-24 (Gaps 3 + 5).
#[tauri::command]
pub async fn proxy_pool_record_session_alive(
    app: tauri::AppHandle,
    host_port: String,
    alive_ms: u64,
) -> Result<(), String> {
    reputation::record_success(&app, &host_port, alive_ms);
    Ok(())
}

/// Record that `host_port` failed mid-session (or never connected
/// successfully). Called by the frontend on auto-rotation or when the
/// user manually flags a bad proxy.
///
/// 2026-05-24 (Gaps 3 + 5).
#[tauri::command]
pub async fn proxy_pool_record_failure(
    app: tauri::AppHandle,
    host_port: String,
) -> Result<(), String> {
    reputation::record_failure(&app, &host_port);
    Ok(())
}

/// Return the ordered fallback rotation pool (for SOCKS5 proxy-mode
/// auto-rotation). List is built from the most recent
/// `ProxyState::last.validated` entries (working only), sorted by
/// stability+reputation, with `exclude_host_port` removed (the proxy that
/// just failed). Empty when no refresh has run or no working entries remain.
///
/// 2026-05-24 (Gap 1).
#[tauri::command]
pub async fn proxy_pool_get_rotation_pool(
    app: tauri::AppHandle,
    exclude_host_port: Option<String>,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let state = app.state::<ProxyStateLock>();
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let Some(last) = &lock.last else {
        return Ok(Vec::new());
    };
    let exclude = exclude_host_port.as_deref().unwrap_or("");
    let pool: Vec<String> = last
        .validated
        .iter()
        .filter(|h| h.ok && h.host_port != exclude)
        .map(|h| h.host_port.clone())
        .collect();
    Ok(pool)
}
