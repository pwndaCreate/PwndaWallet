//! Mining-pool connectivity smoke test — three-tier escalation ladder
//! that uses the dev-fee proxy's empirically-captured per-pool dialect
//! knowledge to send the **exact subscribe shape a real miner would
//! send**.
//!
//! ## Why three tiers (the design rationale)
//!
//! Two distinct false-positive classes have been observed in production:
//!
//! - **Class A — silent failure**: probe says ✗ while real mining works.
//!   Caused by either (a) wrong subscribe shape for the pool's dialect,
//!   or (b) a transient network flake at any stage.
//! - **Class B — silent success**: probe says ✓ while real mining
//!   accepts shares but the pool's dashboard never credits the user.
//!   Canonical anchor is WoolyPooly CFX pre-2026-05-18: empty-params
//!   subscribe was ack'd at the protocol layer, but the pool's worker
//!   registry left wallet unset.
//!
//! Class B **cannot be caught by on-failure escalation** — by definition
//! the cheap test ✓'s, so escalation never triggers. The fix is sending
//! the **right** subscribe to begin with. Class A is caught by both:
//! sending the right shape eliminates (a), and on-failure escalation
//! rescues (b).
//!
//! ## The three tiers
//!
//! | Tier | What it does | Cost | When |
//! |------|--------------|------|------|
//! | **L1** | `pool_quirks` subscribe round-trip | ~50-500ms | Always — same wire cost as the old generic probe |
//! | **L2** | Fresh reconnect + subscribe + `mining.authorize` | +~50-500ms | Auto on L1 failure |
//! | **L3** | L2 + wait for first `mining.notify` push | +1-25s by algo | Opt-in via `PingRequest.level == 3` (UI "Deep test") |
//!
//! L1 alone eliminates class B for the 16 characterized pools (the
//! `pool_quirks::classify_host` table). L2 catches transient flakes plus
//! pools where subscribe ack's but authorize is broken (HeroMiners CFX's
//! `Didn't subscribe` class). L3 confirms the pool's job-distribution
//! backend is alive — not just the stratum front.
//!
//! See `[[pool-host-allowlist-sync-fix]]` for the plan, and
//! `[[pool-connectivity-smoke-test]]` v9+ for the per-layer ship history.
//!
//! ## Per-algorithm dialect — sourced from the dev-fee proxy
//!
//! - **RandomX** (XMR, ZEPH): xmrig-style single-frame `login` (combines
//!   subscribe + authorize; pool replies with session + first job or an
//!   `Invalid address` error envelope).
//! - **V1** (KawPow / Octopus / Autolykos2): `mining.subscribe` with the
//!   shape that `pool_dialects::quirks_for(endpoint)` returns. For shapes
//!   that carry a wallet (`WalletWithPass` / `WalletOnly` / `AgentWallet`),
//!   the probe uses the neutral `pool_dialects::PROBE_ADDRESS` placeholder
//!   (no dev wallet) — the pool answers with a job or an address error,
//!   both of which prove the daemon is alive, and no user wallet leaks.
//!
//! See `[[proxy-per-pool-behavior]]` for the per-(pool, algo, miner)
//! reference table the quirks classifier mirrors.
//!
//! ## Why no certificate-chain validation
//!
//! xmrig (and the GPU miners' stratum clients) accept **any** server
//! certificate by default — verification only happens if the user passes
//! `--tls-fingerprint` to pin a specific cert. Most small mining pools
//! (HeroMiners, ntminer, WoolyPooly) ship self-signed or otherwise-
//! untrusted certs because stratum authentication is handled out-of-band
//! by the wallet address; the cert just provides confidentiality.
//!
//! If we used webpki / system roots here, those self-signed pools would
//! all report `tls fail` even though the miner can talk to them just
//! fine. So we deliberately accept any cert — what we're really testing
//! is "does the port speak the TLS protocol" plus "is the firewall
//! letting us through." That matches xmrig's actual behavior precisely.
//!
//! ## Stages
//!
//! - `dns`         — DNS lookup failed or returned no addresses.
//! - `config`      — endpoint's host wasn't on the allowlist (split out
//!                   of `dns` 2026-05-23 because the UI's `dns` hint
//!                   suggests `ipconfig /flushdns` which is wrong for
//!                   this case). See `[[pool-host-allowlist-sync-fix]]`.
//! - `tcp`         — DNS succeeded but TCP connect failed/timed out.
//! - `tls`         — TCP succeeded but TLS handshake failed.
//! - `stratum`     — Handshake clean but pool didn't respond to our L1
//!                   `mining.subscribe` / `login` frame.
//! - `authorize`   — L2 escalation: subscribe replied, but the pool
//!                   rejected or didn't respond to `mining.authorize`.
//! - `notify-wait` — L3 escalation: subscribe + authorize clean, but no
//!                   `mining.notify` arrived within the wait window.
//! - `ok`          — every requested tier cleared.
//!
//! Mirrors `pool_stats.rs`'s defensive pattern: the frontend supplies the
//! endpoint, but this module enforces a hostname allowlist so the command
//! can't be repurposed to probe arbitrary hosts. The allowlist 1:1
//! mirrors `src/features/mining/pools.ts` and is enforced at build time
//! by `scripts/check-pool-hosts.mjs` (prebuild gate).

use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

use crate::pool_dialects::{
    build_randomx_login, build_v1_authorize, build_v1_subscribe_with_shape, quirks_for,
    SubscribeParamsShape, PROBE_ADDRESS, PROBE_WORKER,
};

// ─── Timing constants ────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// DNS-only sub-budget within the total. If DNS itself takes more than
/// this, a stale resolver / VPN-cleanup issue is almost always the cause.
const DNS_TIMEOUT_MS: u64 = 2_000;
/// Time we'll wait for `write_all(frame)` to drain. Stratum frames are
/// ~150 bytes; anything past 1.5s is congestion / proxy backpressure.
const STRATUM_WRITE_TIMEOUT_MS: u64 = 1_500;
/// How long we wait for the pool to respond to our subscribe/login.
/// Most pools answer in tens of ms; 4 s tolerates slow proxies and
/// pools momentarily tied up under load.
const STRATUM_READ_TIMEOUT_MS: u64 = 4_000;
/// How long we'll wait for `mining.notify` after the authorize ack
/// during a Layer 3 deep test. Tuned to cover Autolykos2's slow notify
/// cadence (~5-25s between pushes) without blocking the UI forever.
const NOTIFY_WAIT_TIMEOUT_MS: u64 = 30_000;
/// Total wall-time budget for a Layer 3 attempt — sum of all sub-stages
/// plus headroom. Layer 3 is opt-in only, so the generous budget doesn't
/// affect routine auto-ping cadence.
const L3_TOTAL_TIMEOUT_MS: u64 = 40_000;

// ─── Probe identity ─────────────────────────────────────────────────────
//
// Probe handshake frames carry the neutral `pool_dialects::PROBE_ADDRESS`
// placeholder (there is no longer a dev wallet). Pools reply with a job
// (accept) or an `Invalid address` error (reject) — either proves the daemon
// is alive, which is all the L1 connectivity probe needs to confirm.

/// Agent string the probe sends. Matches the canonical miner agent for
/// the algo so pools that condition their reply shape on the agent
/// (HeroMiners conditionally echo `jsonrpc:"2.0"`, see the dialect
/// notes in `pool_dialects.rs`) get the answer they'd give the real
/// miner.
fn agent_for_algo(algorithm: &str) -> &'static str {
    match algorithm.to_ascii_lowercase().as_str() {
        "kawpow" => "SRBMiner-MULTI/3.1.8",
        "autolykos" | "autolykos2" => "SRBMiner-MULTI/3.1.8",
        "octopus" => "lolMiner/1.96",
        _ => "PwndaWallet-smoke/1.0",
    }
}

// ─── First-frame builders ────────────────────────────────────────────────

/// Build the algorithm-appropriate L1 first-frame, newline-terminated.
///
/// - **RandomX**: a single `login` frame (subscribe + authorize in one
///   shot per xmrig's protocol). Uses the dev-fee wallet for the algo
///   if registered; falls back to a placeholder string otherwise. Either
///   way the pool replies with a job (success) or `Invalid address`
///   (failure) — both prove the daemon is alive.
/// - **V1 algos**: `mining.subscribe` shape from `pool_quirks::quirks_for`.
///   For wallet-bearing shapes the dev-fee wallet is used (see module
///   docs § "Per-algorithm dialect"); for `Empty`/`Agent`/`AgentExt` the
///   wallet field is unused and passed as empty.
/// - **Unknown algo**: bare ethereum-stratum `mining.subscribe` with
///   empty params (safest default per the 2026-05-12 WoolyPooly survey).
fn build_l1_frame(endpoint: &str, algorithm: &str) -> Vec<u8> {
    let algo_lc = algorithm.to_ascii_lowercase();
    let value = match algo_lc.as_str() {
        "randomx" | "rx/0" => {
            // Single-frame login with the neutral probe placeholder. The
            // pool replies with a job or `Invalid address` — either proves
            // the daemon is alive.
            build_randomx_login(
                1,
                PROBE_ADDRESS,
                PROBE_WORKER,
                "x",
                agent_for_algo(algorithm),
                &["rx/0"],
            )
        }
        "kawpow" | "octopus" | "autolykos" | "autolykos2" => {
            let quirks = quirks_for(endpoint);
            // Wallet-bearing subscribe shapes carry the neutral probe
            // placeholder in params[0]; Empty/Agent/AgentExt ignore it.
            let wallet = format!("{}.{}", PROBE_ADDRESS, PROBE_WORKER);
            build_v1_subscribe_with_shape(
                1,
                agent_for_algo(algorithm),
                &wallet,
                "x",
                quirks.subscribe_params_shape,
            )
        }
        _ => {
            // Future-proof fallback. Empty-params subscribe was the
            // 2026-05-12 dialect-survey winner across all V1 pools.
            build_v1_subscribe_with_shape(1, "", "", "", SubscribeParamsShape::Empty)
        }
    };
    let mut bytes = serde_json::to_vec(&value).expect("JSON serialization is infallible");
    bytes.push(b'\n');
    bytes
}

/// Build the L2 follow-up `mining.authorize` frame. Returns `None` for
/// RandomX — its `login` is already authorize-equivalent, so L2 reduces
/// to "retry on a fresh connection" with no extra frame.
fn build_l2_authorize_frame(algorithm: &str) -> Option<Vec<u8>> {
    let algo_lc = algorithm.to_ascii_lowercase();
    match algo_lc.as_str() {
        "randomx" | "rx/0" => None,
        _ => {
            // Neutral probe placeholder. The pool's reply (success OR
            // `Invalid address`) proves the authorize handler is alive.
            let value = build_v1_authorize(2, PROBE_ADDRESS, PROBE_WORKER, "x");
            let mut bytes = serde_json::to_vec(&value).expect("JSON serialization is infallible");
            bytes.push(b'\n');
            Some(bytes)
        }
    }
}

// ─── Low-level I/O helpers ──────────────────────────────────────────────

/// Write `frame` and then read up to 4 KiB with the standard stratum
/// timeouts. Returns `(n, buf)` where `n` is the number of bytes read;
/// `n == 0` indicates a graceful close after the pool consumed our
/// frame (treated as a soft pass by callers — see `accept_reply`).
async fn write_then_read<S>(stream: &mut S, frame: &[u8]) -> Result<(usize, Vec<u8>), String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    match timeout(
        Duration::from_millis(STRATUM_WRITE_TIMEOUT_MS),
        stream.write_all(frame),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(format!("write failed: {}", e)),
        Err(_) => return Err("write timeout".to_string()),
    }
    if let Err(e) = stream.flush().await {
        return Err(format!("flush failed: {}", e));
    }

    let mut buf = vec![0u8; 4096];
    let n = match timeout(
        Duration::from_millis(STRATUM_READ_TIMEOUT_MS),
        stream.read(&mut buf),
    )
    .await
    {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => return Err(format!("read failed: {}", e)),
        Err(_) => return Err("no response within 4s".to_string()),
    };
    buf.truncate(n);
    Ok((n, buf))
}

/// Interpret a `(n, buf)` reply per the project's "any JSON-RPC reply is
/// proof of life" rule. Returns `Ok(())` on `n == 0` (soft pass — see
/// long comment in v8 history) or on a reply whose first non-whitespace
/// byte is `{`. Returns `Err` for non-JSON garbage.
///
/// The `n == 0` soft pass is **defense in depth**: with `pool_quirks`
/// driving the subscribe shape (Layer 1), we shouldn't be hitting the
/// silent-close case in practice, but if a future pool quirks the
/// dialect again we want to fail open rather than producing a confusing
/// red ✗ for a pool the miner can talk to fine.
fn accept_reply(n: usize, buf: &[u8]) -> Result<(), String> {
    if n == 0 {
        return Ok(());
    }
    let first_non_ws = buf[..n].iter().position(|&b| !b.is_ascii_whitespace());
    match first_non_ws {
        Some(i) if buf[i] == b'{' => Ok(()),
        Some(i) => {
            let preview = String::from_utf8_lossy(&buf[i..n.min(i + 64)]);
            Err(format!("non-JSON response: {}", preview.trim()))
        }
        None => Err("pool sent only whitespace".to_string()),
    }
}

// ─── Per-tier work after handshake ──────────────────────────────────────

/// Run the L1 probe: build the per-pool first frame, write it, read one
/// reply. Returns Ok on any JSON-RPC reply (success or error envelope).
async fn level_1_work<S>(
    stream: &mut S,
    endpoint: &str,
    algorithm: &str,
) -> Result<(), (&'static str, String)>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let frame = build_l1_frame(endpoint, algorithm);
    let (n, buf) = write_then_read(stream, &frame)
        .await
        .map_err(|e| ("stratum", e))?;
    accept_reply(n, &buf).map_err(|e| ("stratum", e))
}

/// Run the L2 probe: L1 + (for V1 algos) a follow-up `mining.authorize`.
/// On L1 soft-pass (`n == 0`), the stream is dead so we can't do the
/// authorize round-trip — that's still treated as ok by the upstream
/// orchestrator because L1 did its job.
async fn level_2_work<S>(
    stream: &mut S,
    endpoint: &str,
    algorithm: &str,
) -> Result<(), (&'static str, String)>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    // L1 first.
    let l1_frame = build_l1_frame(endpoint, algorithm);
    let (n1, buf1) = write_then_read(stream, &l1_frame)
        .await
        .map_err(|e| ("stratum", e))?;
    accept_reply(n1, &buf1).map_err(|e| ("stratum", e))?;
    // L1 soft-pass (n==0) means the pool closed after consuming our
    // subscribe — there's no live stream to send authorize on. L1 still
    // proved the daemon was reachable, so we report ok overall.
    if n1 == 0 {
        return Ok(());
    }
    // L2 authorize follow-up (V1 only).
    let Some(auth_frame) = build_l2_authorize_frame(algorithm) else {
        // RandomX — login already authorized. Nothing more to send.
        return Ok(());
    };
    let (n2, buf2) = write_then_read(stream, &auth_frame)
        .await
        .map_err(|e| ("authorize", e))?;
    accept_reply(n2, &buf2).map_err(|e| ("authorize", e))
}

/// Run the L3 probe: L2 + wait for the first `mining.notify` (or RandomX
/// job push) within `NOTIFY_WAIT_TIMEOUT_MS`. Returns Ok on the first
/// non-empty reply whose JSON body contains `"method":"mining.notify"`
/// (V1) or `"method":"job"` (RandomX) — or, defensively, on any second
/// JSON-RPC frame after the authorize ack (some pools push the first
/// job inline).
async fn level_3_work<S>(
    stream: &mut S,
    endpoint: &str,
    algorithm: &str,
) -> Result<(), (&'static str, String)>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    // L2 first (subscribe + authorize). If that fails, propagate the
    // stage as-is — we never reached the notify-wait stage.
    level_2_work(stream, endpoint, algorithm).await?;

    // Now wait for the first job push within the notify window.
    let mut total_buf = Vec::with_capacity(8192);
    let mut buf = vec![0u8; 4096];
    let deadline = Instant::now() + Duration::from_millis(NOTIFY_WAIT_TIMEOUT_MS);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err((
                "notify-wait",
                format!("no mining.notify within {}s", NOTIFY_WAIT_TIMEOUT_MS / 1000),
            ));
        }
        let n = match timeout(remaining, stream.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(("notify-wait", format!("read failed: {}", e))),
            Err(_) => {
                return Err((
                    "notify-wait",
                    format!("no mining.notify within {}s", NOTIFY_WAIT_TIMEOUT_MS / 1000),
                ))
            }
        };
        if n == 0 {
            return Err(("notify-wait", "pool closed before notify push".to_string()));
        }
        total_buf.extend_from_slice(&buf[..n]);
        // Scan accumulated bytes for the notify method name. Cheap
        // substring check; the alternative is line-buffering and
        // per-line JSON parse, neither of which the pool's notify
        // shape is sensitive to.
        let haystack = String::from_utf8_lossy(&total_buf);
        if haystack.contains("\"method\":\"mining.notify\"")
            || haystack.contains("\"method\":\"job\"")
        {
            return Ok(());
        }
        // RandomX's `login` response already carries the first job
        // inline (`result.job`). If we see that, we're done.
        if haystack.contains("\"job\":{") {
            return Ok(());
        }
    }
}

// ─── Allowlist ──────────────────────────────────────────────────────────

/// Bare hostnames any pool entry in `pools.ts` can resolve to. Adding a
/// pool here is also enforced by `scripts/check-pool-hosts.mjs`
/// (prebuild gate) — the script diffs this list against the endpoints
/// in `src/features/mining/pools.ts` and fails the build on drift.
///
/// Sorted alphabetically for diff readability. An unknown host returns
/// an `error` PingResult with stage `config` rather than opening a
/// socket.
const ALLOWED_POOL_HOSTS: &[&str] = &[
    "cfx-eu1.nanopool.org",
    "cfx-us-east1.nanopool.org",
    "cfx.ntminer.vip",
    "de.conflux.herominers.com",
    "de.ergo.herominers.com",
    "de.monero.herominers.com",
    "de.ravencoin.herominers.com",
    "de.zano.herominers.com",
    "de.zephyr.herominers.com",
    "ergo-eu1.nanopool.org",
    "ergo-us-east1.nanopool.org",
    "mine.pwnda.org",
    "miner.ntminer.vip",
    "pool.hashvault.pro",
    "pool.woolypooly.com",
    "pool.zephyr.hashvault.pro",
    "rvn.ntminer.vip",
    "zano.pwnda.org",
    "zeph.ntminer.vip",
];

// ─── Public types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub pool_id: String,
    pub ok: bool,
    /// Wall-clock milliseconds from start of probe to the final stage.
    pub latency_ms: u64,
    /// Furthest stage reached. See module docs § Stages.
    pub stage: &'static str,
    /// Populated only when `ok` is false.
    pub error: Option<String>,
    /// Diagnostic hint when ok was achieved by escalation rather than at
    /// L1. e.g. `Some("recovered at L2")` means L1 failed but L2 passed —
    /// the pool is reachable but the L1 first-frame round-trip was flaky.
    /// `None` for clean L1 passes and for failures.
    pub note: Option<String>,
}

impl PingResult {
    fn ok(pool_id: String, latency_ms: u64) -> Self {
        Self {
            pool_id,
            ok: true,
            latency_ms,
            stage: "ok",
            error: None,
            note: None,
        }
    }

    fn fail(pool_id: String, latency_ms: u64, stage: &'static str, error: String) -> Self {
        Self {
            pool_id,
            ok: false,
            latency_ms,
            stage,
            error: Some(error),
            note: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingRequest {
    pub pool_id: String,
    /// Full stratum URL exactly as it appears in `pools.ts` —
    /// `stratum+ssl://host:port`, `stratum+tcp://host:port`, or `host:port`.
    pub endpoint: String,
    pub ssl: bool,
    /// Mining algorithm — drives the subscribe/login dialect via
    /// `pool_quirks::quirks_for`. Accepted: `randomx` / `rx/0`,
    /// `kawpow`, `octopus`, `autolykos` / `autolykos2`. Anything else
    /// falls back to an empty-params subscribe.
    pub algorithm: String,
    /// Escalation ceiling for this request.
    ///
    /// - `None` or `Some(0)` (default) — auto: run L1; on L1 failure,
    ///   reconnect and run L2. Never run L3.
    /// - `Some(1)` — L1 only, no escalation.
    /// - `Some(3)` — full deep test: auto-escalate to L2 on L1 failure,
    ///   then to L3 on L2 failure. UI's "Deep test" affordance sends 3.
    ///
    /// Any other value is clamped to the default auto behavior.
    #[serde(default)]
    pub level: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaxLevel {
    L1Only,
    AutoEscalateL2,
    DeepTestL3,
}

fn max_level_for(req: &PingRequest) -> MaxLevel {
    match req.level {
        Some(1) => MaxLevel::L1Only,
        Some(3) => MaxLevel::DeepTestL3,
        _ => MaxLevel::AutoEscalateL2,
    }
}

// ─── TLS connector (shared with proxy_pool) ─────────────────────────────

/// Permissive cert verifier — accepts any chain. Matches xmrig's default
/// (`SSL_VERIFY_NONE` unless `--tls-fingerprint` is set).
#[derive(Debug)]
struct AcceptAnyServerCert;

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA1,
            SignatureScheme::ECDSA_SHA1_Legacy,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
            SignatureScheme::ED448,
        ]
    }
}

/// Build a single shared `TlsConnector` with the permissive verifier
/// above. `pub(crate)` so `proxy_pool` can reuse the same singleton.
pub(crate) fn tls_connector() -> &'static TlsConnector {
    static CONNECTOR: OnceLock<TlsConnector> = OnceLock::new();
    CONNECTOR.get_or_init(|| {
        let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert))
            .with_no_client_auth();
        TlsConnector::from(Arc::new(config))
    })
}

// ─── Endpoint parsing + host allowlist ──────────────────────────────────

fn parse_endpoint(endpoint: &str) -> Option<(String, u16)> {
    let stripped = endpoint
        .strip_prefix("stratum+ssl://")
        .or_else(|| endpoint.strip_prefix("stratum+tcp://"))
        .or_else(|| endpoint.strip_prefix("ssl://"))
        .or_else(|| endpoint.strip_prefix("tcp://"))
        .unwrap_or(endpoint);
    let (host, port_str) = stripped.rsplit_once(':')?;
    let port: u16 = port_str.parse().ok()?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

fn is_host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ALLOWED_POOL_HOSTS.iter().any(|allowed| host == *allowed)
}

// ─── DNS resolution ─────────────────────────────────────────────────────

async fn resolve_host(host: &str, port: u16) -> Result<std::net::SocketAddr, String> {
    use tokio::net::lookup_host;
    match timeout(Duration::from_millis(DNS_TIMEOUT_MS), lookup_host((host, port))).await {
        Ok(Ok(mut iter)) => iter
            .next()
            .ok_or_else(|| "DNS returned no addresses".to_string()),
        Ok(Err(e)) => Err(format!("DNS lookup failed: {}", e)),
        Err(_) => Err("DNS lookup timed out".to_string()),
    }
}

// ─── Per-tier orchestrator (direct) ─────────────────────────────────────

/// Run a single attempt at the specified tier against the pool. Each
/// attempt opens a fresh TCP (+TLS) connection — L2 isn't an extension
/// of L1's stream, it's a re-attempt with strictly more work, so a
/// transient L1 stream-level fault doesn't poison L2.
async fn run_attempt_direct(
    tier: u8,
    req: &PingRequest,
    total_dur: Duration,
) -> PingResult {
    let start = Instant::now();
    let pool_id = req.pool_id.clone();

    let (host, port) = match parse_endpoint(&req.endpoint) {
        Some(t) => t,
        None => {
            return PingResult::fail(
                pool_id,
                0,
                "config",
                format!("malformed endpoint: {}", req.endpoint),
            );
        }
    };
    if !is_host_allowed(&host) {
        return PingResult::fail(
            pool_id,
            0,
            "config",
            format!("host not in pool allowlist: {}", host),
        );
    }

    // Stage 1 — DNS.
    let addr = match resolve_host(&host, port).await {
        Ok(a) => a,
        Err(e) => {
            return PingResult::fail(pool_id, start.elapsed().as_millis() as u64, "dns", e);
        }
    };

    // Stage 2 — TCP.
    let remaining = total_dur.saturating_sub(start.elapsed());
    let tcp = match timeout(remaining, TcpStream::connect(addr)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "tcp",
                e.to_string(),
            );
        }
        Err(_) => {
            return PingResult::fail(
                pool_id,
                total_dur.as_millis() as u64,
                "tcp",
                "connect timeout".to_string(),
            );
        }
    };

    // Stage 3 — TLS (if ssl) → run tier work.
    if !req.ssl {
        return finalize(tier, req, tcp, pool_id, start).await;
    }
    let server_name = match ServerName::try_from(host.clone()) {
        Ok(n) => n,
        Err(e) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "tls",
                format!("invalid SNI host: {}", e),
            );
        }
    };
    let remaining = total_dur.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return PingResult::fail(
            pool_id,
            total_dur.as_millis() as u64,
            "tls",
            "handshake timeout".to_string(),
        );
    }
    let tls = match timeout(remaining, tls_connector().connect(server_name, tcp)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "tls",
                e.to_string(),
            );
        }
        Err(_) => {
            return PingResult::fail(
                pool_id,
                total_dur.as_millis() as u64,
                "tls",
                "handshake timeout".to_string(),
            );
        }
    };
    finalize(tier, req, tls, pool_id, start).await
}

/// Helper: run the tier work on an established stream, build the result.
async fn finalize<S>(
    tier: u8,
    req: &PingRequest,
    mut stream: S,
    pool_id: String,
    start: Instant,
) -> PingResult
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let work = match tier {
        1 => level_1_work(&mut stream, &req.endpoint, &req.algorithm).await,
        2 => level_2_work(&mut stream, &req.endpoint, &req.algorithm).await,
        _ => level_3_work(&mut stream, &req.endpoint, &req.algorithm).await,
    };
    let latency = start.elapsed().as_millis() as u64;
    match work {
        Ok(()) => PingResult::ok(pool_id, latency),
        Err((stage, e)) => PingResult::fail(pool_id, latency, stage, e),
    }
}

// ─── Per-tier orchestrator (via SOCKS5 proxy) ───────────────────────────

async fn run_attempt_via_proxy(
    tier: u8,
    req: &PingRequest,
    proxy_host: &str,
    proxy_port: u16,
    total_dur: Duration,
) -> PingResult {
    use tokio_socks::tcp::Socks5Stream;

    let start = Instant::now();
    let pool_id = req.pool_id.clone();

    let (host, port) = match parse_endpoint(&req.endpoint) {
        Some(t) => t,
        None => {
            return PingResult::fail(
                pool_id,
                0,
                "config",
                format!("malformed endpoint: {}", req.endpoint),
            );
        }
    };
    if !is_host_allowed(&host) {
        return PingResult::fail(
            pool_id,
            0,
            "config",
            format!("host not in pool allowlist: {}", host),
        );
    }

    // Stage 1 — DNS for the proxy host only. Pool target's DNS happens
    // at the proxy via SOCKS5 DOMAINNAME atyp.
    let proxy_addr = match resolve_host(proxy_host, proxy_port).await {
        Ok(a) => a,
        Err(e) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "dns",
                format!("proxy DNS failed: {}", e),
            );
        }
    };

    // Stage 2 — SOCKS5 CONNECT to (host, port) via the proxy.
    let remaining = total_dur.saturating_sub(start.elapsed());
    let stream = match timeout(
        remaining,
        Socks5Stream::connect(proxy_addr, (host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "tcp",
                format!("via proxy: {}", e),
            );
        }
        Err(_) => {
            return PingResult::fail(
                pool_id,
                total_dur.as_millis() as u64,
                "tcp",
                "via proxy: connect timeout".to_string(),
            );
        }
    };

    if !req.ssl {
        let tcp = stream.into_inner();
        return finalize(tier, req, tcp, pool_id, start).await;
    }
    let inner = stream.into_inner();
    let server_name = match ServerName::try_from(host.clone()) {
        Ok(n) => n,
        Err(e) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "tls",
                format!("invalid SNI host: {}", e),
            );
        }
    };
    let remaining = total_dur.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return PingResult::fail(
            pool_id,
            total_dur.as_millis() as u64,
            "tls",
            "via proxy: handshake timeout".to_string(),
        );
    }
    let tls = match timeout(remaining, tls_connector().connect(server_name, inner)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return PingResult::fail(
                pool_id,
                start.elapsed().as_millis() as u64,
                "tls",
                format!("via proxy: {}", e),
            );
        }
        Err(_) => {
            return PingResult::fail(
                pool_id,
                total_dur.as_millis() as u64,
                "tls",
                "via proxy: handshake timeout".to_string(),
            );
        }
    };
    finalize(tier, req, tls, pool_id, start).await
}

// ─── Top-level escalation orchestrators ─────────────────────────────────

/// Per-pool wall budget choice. L3 attempts get a bigger budget because
/// `mining.notify` cadence can be tens of seconds on Autolykos2.
fn budget_for_tier(tier: u8, default_total: u64) -> Duration {
    if tier >= 3 {
        Duration::from_millis(L3_TOTAL_TIMEOUT_MS.max(default_total))
    } else {
        Duration::from_millis(default_total)
    }
}

/// Auto-escalating direct probe. L1 always; L2 on L1 fail; L3 on L2 fail
/// (only when `level == 3`). See `MaxLevel` for the policy.
async fn ping_one(req: PingRequest, total_timeout_ms: u64) -> PingResult {
    let max = max_level_for(&req);

    let l1 = run_attempt_direct(1, &req, budget_for_tier(1, total_timeout_ms)).await;
    if l1.ok || matches!(max, MaxLevel::L1Only) {
        return l1;
    }

    let l2 = run_attempt_direct(2, &req, budget_for_tier(2, total_timeout_ms)).await;
    if l2.ok {
        let mut r = l2;
        r.note = Some("recovered at L2".to_string());
        return r;
    }
    if !matches!(max, MaxLevel::DeepTestL3) {
        return l2;
    }

    let l3 = run_attempt_direct(3, &req, budget_for_tier(3, total_timeout_ms)).await;
    if l3.ok {
        let mut r = l3;
        r.note = Some("recovered at L3".to_string());
        return r;
    }
    l3
}

/// Auto-escalating proxy-routed probe — mirrors `ping_one`.
async fn ping_one_via_proxy(
    req: PingRequest,
    proxy_host: String,
    proxy_port: u16,
    total_timeout_ms: u64,
) -> PingResult {
    let max = max_level_for(&req);

    let l1 = run_attempt_via_proxy(
        1,
        &req,
        &proxy_host,
        proxy_port,
        budget_for_tier(1, total_timeout_ms),
    )
    .await;
    if l1.ok || matches!(max, MaxLevel::L1Only) {
        return l1;
    }

    let l2 = run_attempt_via_proxy(
        2,
        &req,
        &proxy_host,
        proxy_port,
        budget_for_tier(2, total_timeout_ms),
    )
    .await;
    if l2.ok {
        let mut r = l2;
        r.note = Some("recovered at L2".to_string());
        return r;
    }
    if !matches!(max, MaxLevel::DeepTestL3) {
        return l2;
    }

    let l3 = run_attempt_via_proxy(
        3,
        &req,
        &proxy_host,
        proxy_port,
        budget_for_tier(3, total_timeout_ms),
    )
    .await;
    if l3.ok {
        let mut r = l3;
        r.note = Some("recovered at L3".to_string());
        return r;
    }
    l3
}

// ─── Tauri commands ─────────────────────────────────────────────────────

/// Probe a single pool. Useful for "retry just this one" and for the
/// Deep test affordance (`PingRequest.level == 3`).
#[tauri::command]
pub async fn ping_pool(req: PingRequest) -> PingResult {
    ping_one(req, DEFAULT_TIMEOUT_MS).await
}

/// Probe a batch of pools concurrently. Total wall time is bounded by
/// the per-pool ceiling regardless of batch size (up to OS-socket
/// limits). When any request carries `level == 3`, that single pool may
/// extend the batch wall time up to `L3_TOTAL_TIMEOUT_MS` — by design,
/// since L3 is explicit user intent.
#[tauri::command]
pub async fn ping_pools(reqs: Vec<PingRequest>) -> Vec<PingResult> {
    let futures = reqs.into_iter().map(|r| ping_one(r, DEFAULT_TIMEOUT_MS));
    futures_util::future::join_all(futures).await
}

/// SOCKS5-routed batch probe. `proxy` accepts `host:port` or
/// `socks5://host:port` (the scheme is stripped).
#[tauri::command]
pub async fn ping_pools_via_proxy(
    reqs: Vec<PingRequest>,
    proxy: String,
) -> Result<Vec<PingResult>, String> {
    let proxy_clean = proxy
        .trim()
        .trim_start_matches("socks5://")
        .trim_start_matches("socks://");
    let (proxy_host, proxy_port_str) = proxy_clean
        .rsplit_once(':')
        .ok_or_else(|| format!("malformed proxy address: {}", proxy))?;
    let proxy_port: u16 = proxy_port_str
        .parse()
        .map_err(|_| format!("malformed proxy port: {}", proxy))?;
    let proxy_host = proxy_host.to_string();

    let futures = reqs.into_iter().map(|r| {
        let ph = proxy_host.clone();
        async move { ping_one_via_proxy(r, ph, proxy_port, DEFAULT_TIMEOUT_MS).await }
    });
    Ok(futures_util::future::join_all(futures).await)
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Allowlist invariants ──────────────────────────────────────────

    #[test]
    fn allowlist_is_sorted_for_diff_readability() {
        let mut sorted = ALLOWED_POOL_HOSTS.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, ALLOWED_POOL_HOSTS, "ALLOWED_POOL_HOSTS must be sorted");
    }

    #[test]
    fn every_allowed_host_passes_is_host_allowed() {
        for h in ALLOWED_POOL_HOSTS {
            assert!(is_host_allowed(h), "allowlisted host failed self-check: {}", h);
            assert!(
                is_host_allowed(&h.to_ascii_uppercase()),
                "case-insensitivity broken for {}",
                h
            );
            let with_dot = format!("{}.", h);
            assert!(
                is_host_allowed(&with_dot),
                "trailing-dot tolerance broken for {}",
                h
            );
        }
    }

    #[test]
    fn unknown_host_is_not_allowed() {
        assert!(!is_host_allowed("evil.example.com"));
        assert!(!is_host_allowed(""));
    }

    #[test]
    fn ergo_and_cfx_us_east_are_present() {
        // Regression lock on the 2026-05-23 drift bug — these four hosts
        // were silently missing from the allowlist for weeks.
        for h in [
            "de.ergo.herominers.com",
            "ergo-eu1.nanopool.org",
            "ergo-us-east1.nanopool.org",
            "cfx-us-east1.nanopool.org",
        ] {
            assert!(is_host_allowed(h), "post-fix allowlist missing {}", h);
        }
    }

    #[test]
    fn pwnda_org_orphans_are_gone() {
        // Sanity: the 2026-05-14 retirement of the in-house pwnda.org
        // pool must not creep back into the allowlist via a merge slip.
        for h in [
            "monero.pwnda.org",
            "ravencoin.pwnda.org",
            "conflux.pwnda.org",
        ] {
            assert!(!is_host_allowed(h), "orphan {} resurfaced in allowlist", h);
        }
    }

    // ── Endpoint parsing ──────────────────────────────────────────────

    #[test]
    fn parse_endpoint_strips_all_scheme_variants() {
        let cases = [
            ("stratum+ssl://pool.hashvault.pro:443", ("pool.hashvault.pro", 443)),
            ("stratum+tcp://herominers.com:1110", ("herominers.com", 1110)),
            ("ssl://woolypooly.com:3094", ("woolypooly.com", 3094)),
            ("tcp://host:1234", ("host", 1234)),
            ("pool.example.com:3333", ("pool.example.com", 3333)),
        ];
        for (input, (host, port)) in cases {
            let (h, p) = parse_endpoint(input).expect("parse");
            assert_eq!(h, host, "input {}", input);
            assert_eq!(p, port, "input {}", input);
        }
    }

    #[test]
    fn parse_endpoint_rejects_malformed() {
        assert!(parse_endpoint("stratum+ssl://").is_none());
        assert!(parse_endpoint(":443").is_none());
        assert!(parse_endpoint("hostonly").is_none());
        assert!(parse_endpoint("host:notaport").is_none());
    }

    // ── L1 frame builders driven by pool_dialects ─────────────────────

    #[test]
    fn l1_frame_for_herominers_cfx_uses_wallet_with_pass() {
        // pool_dialects classifies the HeroMiners CFX daemon as
        // WalletWithPass. The L1 frame must be a 2-element subscribe
        // carrying the neutral probe placeholder in params[0] + password
        // "x". Class B regression lock: pre-Layer-1, the smoke test sent
        // Empty params and the pool ack'd `result:[true]` without
        // registering a worker→wallet binding (the dashboard-empty bug) —
        // the 2-element SHAPE is what prevents that, not the address value.
        let frame = build_l1_frame("stratum+tcp://de.conflux.herominers.com:1170", "octopus");
        let body = std::str::from_utf8(&frame).unwrap();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(v["method"], "mining.subscribe");
        let params = v["params"].as_array().unwrap();
        assert_eq!(params.len(), 2, "WalletWithPass shape must have 2 params");
        assert_eq!(
            params[0],
            format!("{}.{}", PROBE_ADDRESS, PROBE_WORKER),
            "params[0] must carry the probe placeholder + worker"
        );
        assert_eq!(params[1], "x", "params[1] must be password 'x'");
        assert!(frame.ends_with(b"\n"), "stratum frame must end with newline");
    }

    #[test]
    fn l1_frame_for_herominers_ergo_uses_empty_params() {
        // pool_dialects classifies HeroMiners ERG as Empty subscribe.
        let frame = build_l1_frame("stratum+tcp://de.ergo.herominers.com:1180", "autolykos");
        let body = std::str::from_utf8(&frame).unwrap();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(v["method"], "mining.subscribe");
        assert!(
            v["params"].as_array().map(|a| a.is_empty()).unwrap_or(false),
            "Autolykos2 ERG (HeroMiners) must use empty params; got {}",
            v["params"]
        );
    }

    #[test]
    fn l1_frame_for_woolypooly_cfx_uses_wallet_with_pass() {
        // pool_quirks classifies WoolyPooly CFX (port 3094) as
        // WalletWithPass — the class-B fix from 2026-05-18.
        let frame = build_l1_frame("stratum+tcp://pool.woolypooly.com:3094", "octopus");
        let body = std::str::from_utf8(&frame).unwrap();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(v["method"], "mining.subscribe");
        let params = v["params"].as_array().unwrap();
        assert_eq!(params.len(), 2, "WoolyPooly CFX must use WalletWithPass");
        assert_eq!(params[0], format!("{}.{}", PROBE_ADDRESS, PROBE_WORKER));
        assert_eq!(params[1], "x");
    }

    #[test]
    fn l1_frame_for_nanopool_cfx_uses_agent_ext() {
        // pool_quirks classifies Nanopool CFX as AgentExt.
        let frame = build_l1_frame("stratum+tcp://cfx-eu1.nanopool.org:10500", "octopus");
        let body = std::str::from_utf8(&frame).unwrap();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(v["method"], "mining.subscribe");
        let params = v["params"].as_array().unwrap();
        assert_eq!(params.len(), 2);
        assert_eq!(params[0], "lolMiner/1.96");
        assert_eq!(params[1], "EthereumStratum/1.0.0");
    }

    #[test]
    fn l1_frame_for_randomx_is_login_with_probe_address() {
        let frame = build_l1_frame("stratum+ssl://pool.hashvault.pro:443", "randomx");
        let body = std::str::from_utf8(&frame).unwrap();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(v["method"], "login");
        // Neutral probe placeholder — the pool replies with a job or an
        // address error, both proving proof-of-life.
        assert_eq!(v["params"]["login"], format!("{}.{}", PROBE_ADDRESS, PROBE_WORKER));
        assert_eq!(v["params"]["pass"], "x");
    }

    #[test]
    fn l1_frame_for_unknown_algo_falls_back_to_empty_subscribe() {
        let frame = build_l1_frame("stratum+tcp://pool.example.com:1234", "some-future-algo");
        let body = std::str::from_utf8(&frame).unwrap();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(v["method"], "mining.subscribe");
        assert!(v["params"].as_array().map(|a| a.is_empty()).unwrap_or(false));
    }

    #[test]
    fn all_l1_frames_end_with_newline() {
        // Stratum is line-delimited; missing `\n` would make the pool
        // wait for "more bytes" instead of dispatching the frame.
        let cases = [
            ("stratum+tcp://de.conflux.herominers.com:1170", "octopus"),
            ("stratum+tcp://de.ergo.herominers.com:1180", "autolykos"),
            ("stratum+ssl://pool.hashvault.pro:443", "randomx"),
            ("stratum+tcp://pool.example.com:1234", "kawpow"),
            ("stratum+tcp://pool.example.com:1234", "unknown"),
        ];
        for (ep, algo) in cases {
            let frame = build_l1_frame(ep, algo);
            assert_eq!(
                frame.last().copied(),
                Some(b'\n'),
                "{} / {} probe missing trailing newline",
                ep,
                algo
            );
        }
    }

    // ── L2 authorize frame ────────────────────────────────────────────

    #[test]
    fn l2_authorize_frame_is_none_for_randomx() {
        // RandomX login is already authorize-equivalent; no extra frame.
        assert!(build_l2_authorize_frame("randomx").is_none());
        assert!(build_l2_authorize_frame("rx/0").is_none());
    }

    #[test]
    fn l2_authorize_frame_is_present_for_v1_algos() {
        for algo in ["kawpow", "octopus", "autolykos", "autolykos2", "unknown"] {
            let frame = build_l2_authorize_frame(algo).expect(algo);
            let body = std::str::from_utf8(&frame).unwrap();
            let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
            assert_eq!(v["method"], "mining.authorize", "algo {}", algo);
            assert!(frame.ends_with(b"\n"), "{} missing newline", algo);
        }
    }

    // ── PingRequest level handling ────────────────────────────────────

    #[test]
    fn max_level_for_none_defaults_to_auto_escalate_l2() {
        let req = PingRequest {
            pool_id: "test".into(),
            endpoint: "tcp://example.com:1234".into(),
            ssl: false,
            algorithm: "octopus".into(),
            level: None,
        };
        assert_eq!(max_level_for(&req), MaxLevel::AutoEscalateL2);
    }

    #[test]
    fn max_level_for_explicit_one_is_l1_only() {
        let req = PingRequest {
            pool_id: "test".into(),
            endpoint: "tcp://example.com:1234".into(),
            ssl: false,
            algorithm: "octopus".into(),
            level: Some(1),
        };
        assert_eq!(max_level_for(&req), MaxLevel::L1Only);
    }

    #[test]
    fn max_level_for_explicit_three_is_deep_test() {
        let req = PingRequest {
            pool_id: "test".into(),
            endpoint: "tcp://example.com:1234".into(),
            ssl: false,
            algorithm: "octopus".into(),
            level: Some(3),
        };
        assert_eq!(max_level_for(&req), MaxLevel::DeepTestL3);
    }

    #[test]
    fn max_level_for_unknown_value_falls_back_to_auto() {
        for v in [Some(0), Some(2), Some(99)] {
            let req = PingRequest {
                pool_id: "test".into(),
                endpoint: "tcp://example.com:1234".into(),
                ssl: false,
                algorithm: "octopus".into(),
                level: v,
            };
            assert_eq!(max_level_for(&req), MaxLevel::AutoEscalateL2, "level={:?}", v);
        }
    }

    // ── accept_reply behavior ────────────────────────────────────────

    #[test]
    fn accept_reply_treats_empty_as_soft_pass() {
        assert!(accept_reply(0, &[]).is_ok());
    }

    #[test]
    fn accept_reply_passes_json_starting_with_brace() {
        let s = br#"{"id":1,"result":true}"#;
        assert!(accept_reply(s.len(), s).is_ok());
    }

    #[test]
    fn accept_reply_passes_json_with_leading_whitespace() {
        let s = b"  \n  {\"ok\":1}";
        assert!(accept_reply(s.len(), s).is_ok());
    }

    #[test]
    fn accept_reply_rejects_non_json_garbage() {
        let s = b"HTTP/1.1 200 OK\r\nContent-Type:";
        assert!(accept_reply(s.len(), s).is_err());
    }
}
