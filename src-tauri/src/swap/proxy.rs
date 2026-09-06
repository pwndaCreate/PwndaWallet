//! Typed client for the user-controlled wallet-proxy server.
//!
//! Contract: `wallet-proxy.yaml` (§7.3 of the integration plan) plus the
//! May 6 2026 X-Client-Sig amendment from the server agent. Every request
//! to `/api/*` carries four headers built from a canonical signing message:
//!
//! ```text
//! X-Client-Pubkey:    <base64 32-byte ed25519 pubkey>
//! X-Client-Timestamp: <unix-seconds-decimal, optionally offset for skew>
//! X-Client-Nonce:     <base64 16-byte random>
//! X-Client-Sig:       <base64 64-byte signature>
//! ```
//!
//! The path-classifier in `auth::path_requires_signature` keeps `/healthz`
//! and `/enroll` unsigned. Auth/rate-limit error codes returned by the
//! server are parsed into the typed [`ProxyError`] variants below so the
//! UI layer can show human-friendly toasts.
//!
//! Retry policy:
//! * `AUTH_CLOCK_SKEW` with a `serverTime` field — recompute the offset and
//!   retry the same request once. Persist the offset for future calls.
//! * `AUTH_REQUIRED` / `AUTH_UNKNOWN_PUBKEY` — caller (`commands.rs`) drives a
//!   single re-enroll attempt then bubbles the error to the UI.
//!
//! Everything else is surfaced verbatim — including 429 rate limits.

use crate::swap::auth;
use crate::swap::state::SwapState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// Limit on response body size we'll buffer in memory. Prevents a malicious
/// or malfunctioning proxy from forcing the wallet to hold gigabytes.
const MAX_RESPONSE_BYTES: usize = 1 << 20; // 1 MiB

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("proxy URL is not configured (call swap_set_proxy_url first)")]
    NoUrl,
    #[error("network error: {0}")]
    Network(String),
    #[error("proxy returned {0}: {1}")]
    Http(u16, String),
    #[error("response parse error: {0}")]
    Parse(String),

    // ---- auth-specific (mapped from the server's typed JSON error bodies)
    #[error("auth required (no client signature accepted)")]
    AuthRequired,
    #[error("server does not recognize this client's public key")]
    AuthUnknownPubkey,
    #[error("clock skew exceeds server tolerance (server time = {server_time:?})")]
    AuthClockSkew { server_time: Option<u64> },
    #[error("nonce replay rejected by server")]
    AuthNonceReplay,
    #[error("invalid signature (this is a client bug, not a user error)")]
    AuthBadSig,
    #[error("this client is banned by the server")]
    AuthBanned,

    // ---- rate-limit-specific
    #[error("rate limited per minute")]
    RateLimitMinute,
    #[error("rate limited per day")]
    RateLimitDay,
    #[error("enrollment rate limit hit on this IP")]
    EnrollRateLimit,

    // ---- swap-desk-specific (atomic-swap desk; mapped from the desk's typed
    // JSON error bodies, which carry the code in the `error` field). These flow
    // through the SAME send_signed_request rail as SwapKit/Intents — the desk is
    // just another `/api/*` consumer of the shared sigauth transport.
    #[error("quote expired or already consumed — re-quote before accepting")]
    DeskQuoteExpired,
    /// CC-7. **Retryable** — the same request succeeds once an in-flight swap
    /// settles, which is the opposite of [`DeskSizeOutOfRange`], where the
    /// caller must change the amount.
    ///
    /// `retry_after_secs` is the desk's `Retry-After` header. `None` means it
    /// did not tell us when, and that is deliberately NOT treated as "retry
    /// whenever you like": absent guidance is not permission to hammer a desk
    /// that just said it was short. A caller schedules a retry only on `Some`.
    #[error("desk inventory unavailable for this pair/size right now{}", match retry_after_secs {
        Some(n) => format!(" — the desk says retry in {n}s"),
        None => " — the desk gave no Retry-After, so no retry is scheduled".to_string(),
    })]
    DeskInventoryUnavailable { retry_after_secs: Option<u64> },
    #[error("swap-state conflict — this operation is not valid in the swap's current state")]
    DeskSwapStateConflict,
    #[error("this pair is halted (oracle stale or manual halt)")]
    DeskPairHalted,
    /// CC-20. The message is the DESK's, not ours, and that is the whole point.
    ///
    /// This used to read "outside the pair's allowed min/max range" — a unit
    /// variant asserting a cause it could not know. M31-2 added a SECOND source
    /// of `SIZE_OUT_OF_RANGE`: a per-swap USD cap, which is a different control
    /// in a different unit. Against that refusal the old sentence was not merely
    /// generic, it was CONFIDENTLY WRONG — it sends a user to change the pair
    /// size when the binding limit is a cap in dollars.
    ///
    /// So the desk's own explanation is carried through instead of replaced. A
    /// caller that wants to distinguish the two reads the message; a caller that
    /// does not is no worse off than before.
    #[error("the desk refused this size: {0}")]
    DeskSizeOutOfRange(String),
    /// **503 `desk_busy`.** The desk could not take its swap mutex within its own
    /// bound and declined rather than queueing. **This is a RETRY, not a failure.**
    ///
    /// Shipped by the desk 2026-07-26 after a convoy: three of our requests blocked
    /// behind one long engine call, exceeded our 20s client timeout, and surfaced as
    /// `error sending request` — which we then misread as the desk having restarted.
    /// It had not. Bounding the reader is the correct half to bound: in BUY the desk
    /// locks XMR inside that critical section, and a lock is funds-moving, so unlike
    /// a watch it must never be abandoned to a timeout.
    ///
    /// A caller that treats this as terminal aborts a perfectly live swap.
    #[error("the desk is busy (503 desk_busy) — retry")]
    DeskBusy,

    #[error("request rejected: a spend scalar was detected in a field that must never carry one")]
    DeskPrivateKeyRejected,

    // ---- the auth subsystem itself failed (keyring, file IO, etc.)
    #[error("local auth setup error: {0}")]
    AuthSetup(String),
}

impl From<auth::AuthError> for ProxyError {
    fn from(e: auth::AuthError) -> Self {
        ProxyError::AuthSetup(e.to_string())
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("reqwest client")
}

/// Extract the structured `error` and `serverTime` fields from a JSON body
/// the proxy returns on a non-2xx. Returns `(error_code, server_time)`.
fn parse_error_body(body: &str) -> (Option<String>, Option<u64>, Option<String>) {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (None, None, None),
    };
    let code = v
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string);
    let server_time = v
        .get("serverTime")
        .and_then(|x| x.as_u64().or_else(|| x.as_i64().map(|n| n as u64)));
    let scope = v
        .get("scope")
        .and_then(Value::as_str)
        .map(str::to_string);
    (code, server_time, scope)
}

/// CC-20: the desk's human-readable explanation, if it sent one. Tries
/// `message` then `error` — the two keys its envelope uses — and returns `None`
/// rather than an empty string so a caller can tell "no explanation" from "an
/// empty one".
fn desk_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    for key in ["message", "error"] {
        if let Some(m) = v.get(key).and_then(Value::as_str) {
            let m = m.trim();
            if !m.is_empty() {
                return Some(m.to_string());
            }
        }
    }
    None
}

/// Map a non-2xx status + body to the right [`ProxyError`] variant.
/// CC-7: parse `Retry-After`. The desk sends delta-seconds; the HTTP-date form
/// is accepted by the spec but the desk does not use it, so an unparseable
/// value returns `None` (could-not-look) rather than a guessed default.
fn parse_retry_after(v: Option<&str>) -> Option<u64> {
    let raw = v?.trim();
    raw.parse::<u64>().ok().filter(|n| *n > 0 && *n <= 86_400)
}

fn classify_error(status: u16, body: &str, retry_after: Option<u64>) -> ProxyError {
    let (code, server_time, scope) = parse_error_body(body);
    match (status, code.as_deref(), scope.as_deref()) {
        (401, Some("AUTH_REQUIRED"), _) => ProxyError::AuthRequired,
        (401, Some("AUTH_UNKNOWN_PUBKEY"), _) => ProxyError::AuthUnknownPubkey,
        (401, Some("AUTH_CLOCK_SKEW"), _) => ProxyError::AuthClockSkew { server_time },
        (401, Some("AUTH_NONCE_REPLAY"), _) => ProxyError::AuthNonceReplay,
        (401, Some("AUTH_BAD_SIG"), _) => ProxyError::AuthBadSig,
        (403, Some("AUTH_BANNED"), _) => ProxyError::AuthBanned,
        (429, Some("RATE_LIMIT_PUBKEY"), Some("minute")) => ProxyError::RateLimitMinute,
        (429, Some("RATE_LIMIT_PUBKEY"), Some("day")) => ProxyError::RateLimitDay,
        (429, Some("ENROLL_RATE_LIMIT"), _) => ProxyError::EnrollRateLimit,
        // Swap-desk codes. Matched on the code alone (the desk pins each to a
        // specific status — 400/409 — but the code is the unambiguous signal,
        // and matching the code keeps this robust if a status is ever adjusted).
        (_, Some("QUOTE_EXPIRED"), _) => ProxyError::DeskQuoteExpired,
        (_, Some("INVENTORY_UNAVAILABLE"), _) => {
            ProxyError::DeskInventoryUnavailable { retry_after_secs: retry_after }
        }
        (_, Some("SWAP_STATE_CONFLICT"), _) => ProxyError::DeskSwapStateConflict,
        (_, Some("PAIR_HALTED"), _) => ProxyError::DeskPairHalted,
        // CC-20: keep the desk's sentence. `message` is where it explains WHICH
        // limit bound — the pair window or the per-swap cap — and discarding it
        // is what made those two refusals indistinguishable.
        (_, Some("SIZE_OUT_OF_RANGE"), _) => ProxyError::DeskSizeOutOfRange(
            desk_message(body).unwrap_or_else(|| "no explanation given".to_string()),
        ),
        (_, Some("PRIVATE_KEY_REJECTED"), _) => ProxyError::DeskPrivateKeyRejected,
        // The desk emits this lowercase; match case-insensitively so a cosmetic
        // change on their side cannot silently turn a retry back into an abort.
        (_, Some(c), _) if c.eq_ignore_ascii_case("desk_busy") => ProxyError::DeskBusy,
        // Belt: a bare 503 with no code is still "come back later", never terminal.
        (503, _, _) => ProxyError::DeskBusy,
        _ => ProxyError::Http(status, body.to_string()),
    }
}

/// Read the response body up to [`MAX_RESPONSE_BYTES`] and return it as text.
/// CC-7: returns the `Retry-After` seconds alongside status and body.
///
/// It used to return only `(status, text)`, so the header was dropped here —
/// BEFORE `classify_error` ran. The distinction CC-7 exists to draw was not
/// being ignored downstream; the evidence for it never arrived.
async fn body_text(resp: reqwest::Response) -> Result<(u16, String, Option<u64>), ProxyError> {
    let status = resp.status().as_u16();
    let retry_after = parse_retry_after(
        resp.headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok()),
    );
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ProxyError::Network(e.to_string()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ProxyError::Parse(format!(
            "response body exceeds {MAX_RESPONSE_BYTES} bytes"
        )));
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok((status, text, retry_after))
}

/// Apply the four X-Client-* headers to a request builder. `body_bytes` MUST
/// be the exact bytes the request will send (or `b""` for a GET).
fn attach_signed_headers(
    builder: reqwest::RequestBuilder,
    seed: &[u8; 32],
    method: &str,
    path: &str,
    body_bytes: &[u8],
    clock_offset_secs: i64,
) -> reqwest::RequestBuilder {
    let h = auth::build_headers(seed, method, path, body_bytes, clock_offset_secs);
    builder
        .header("X-Client-Pubkey", h.pubkey)
        .header("X-Client-Timestamp", h.timestamp)
        .header("X-Client-Nonce", h.nonce)
        .header("X-Client-Sig", h.signature)
}

/// Build the URL by joining the configured base with a relative path.
fn make_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

/// Core sender: signs `/api/*` paths, retries once on AUTH_CLOCK_SKEW, and
/// surfaces typed errors. Body is JSON-encoded once into `body_bytes` so the
/// sha256 we sign over matches the bytes that go on the wire.
async fn send_signed_request<R>(
    state: &SwapState,
    method: &str,
    path: &str,
    body_bytes: Option<Vec<u8>>,
) -> Result<R, ProxyError>
where
    R: for<'de> Deserialize<'de>,
{
    let base = state.proxy_url().ok_or(ProxyError::NoUrl)?;
    let url = make_url(&base, path);
    let needs_sig = auth::path_requires_signature(path);
    let body_for_sign: &[u8] = body_bytes.as_deref().unwrap_or(&[]);

    // Build + send with current clock offset.
    let resp = send_once(state, method, &url, path, body_bytes.as_deref(), body_for_sign, needs_sig).await?;
    let (status, text, retry_after) = body_text(resp).await?;
    if status >= 200 && status < 300 {
        return serde_json::from_str(&text).map_err(|e| ProxyError::Parse(e.to_string()));
    }

    // Retry on AUTH_CLOCK_SKEW exactly once with a corrected offset.
    let err = classify_error(status, &text, retry_after);
    if let ProxyError::AuthClockSkew { server_time: Some(server_ts) } = err {
        let local_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let offset = server_ts as i64 - local_now;
        state.set_clock_offset_secs(offset);
        // Persist alongside enrollment state (keyed by server origin) so
        // future launches against THIS server start in sync.
        if let Some(dir) = state.data_dir() {
            if let Some(base) = state.proxy_url() {
                let mut s = auth::read_state(&dir, &base);
                s.clock_offset_secs = offset;
                // best-effort: don't fail the call if disk write fails
                let _ = auth::write_state(&dir, &base, &s);
            }
        }
        let resp2 = send_once(state, method, &url, path, body_bytes.as_deref(), body_for_sign, needs_sig).await?;
        let (status2, text2, retry_after2) = body_text(resp2).await?;
        if status2 >= 200 && status2 < 300 {
            return serde_json::from_str(&text2).map_err(|e| ProxyError::Parse(e.to_string()));
        }
        return Err(classify_error(status2, &text2, retry_after2));
    }
    Err(err)
}

#[allow(clippy::too_many_arguments)]
async fn send_once(
    state: &SwapState,
    method: &str,
    url: &str,
    path: &str,
    body_bytes: Option<&[u8]>,
    body_for_sign: &[u8],
    needs_sig: bool,
) -> Result<reqwest::Response, ProxyError> {
    let client = http_client();
    let mut builder = match method.to_uppercase().as_str() {
        "POST" => client.post(url),
        "GET" => client.get(url),
        m => return Err(ProxyError::Network(format!("unsupported method {m}"))),
    };
    if let Some(b) = body_bytes {
        builder = builder
            .header("content-type", "application/json")
            .body(b.to_vec());
    }
    if needs_sig {
        let offset = state.clock_offset_secs();
        let res = state.with_seed(|seed| {
            attach_signed_headers(builder, seed, method, path, body_for_sign, offset)
        });
        builder = match res {
            Some(b) => b,
            None => {
                return Err(ProxyError::AuthSetup(
                    "signing seed not initialized — call swap_set_proxy_url first".into(),
                ))
            }
        };
    }
    builder
        .send()
        .await
        .map_err(|e| ProxyError::Network(e.to_string()))
}

/// Signed POST of a JSON body. `pub(crate)` so sibling providers (the swap
/// desk) can reuse the SAME sigauth rail with their own typed DTOs — one
/// signing implementation, no duplicated crypto (see [`crate::desk::client`]).
pub(crate) async fn post_signed<T: Serialize, R: for<'de> Deserialize<'de>>(
    state: &SwapState,
    path: &str,
    body: &T,
) -> Result<R, ProxyError> {
    let body_bytes =
        serde_json::to_vec(body).map_err(|e| ProxyError::Parse(e.to_string()))?;
    send_signed_request(state, "POST", path, Some(body_bytes)).await
}

/// Signed GET. `pub(crate)` for the same reason as [`post_signed`].
pub(crate) async fn get_signed<R: for<'de> Deserialize<'de>>(
    state: &SwapState,
    path: &str,
) -> Result<R, ProxyError> {
    send_signed_request(state, "GET", path, None).await
}

// -------- Unsigned endpoints --------

/// `GET /healthz` — unsigned. Used by Settings → Test Connection.
pub async fn healthz(base: &str) -> Result<(u16, String), ProxyError> {
    let url = make_url(base, "/healthz");
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| ProxyError::Network(e.to_string()))?;
    // These return the raw (status, body) pair and never classify, so the
    // Retry-After is not theirs to carry.
    body_text(resp).await.map(|(s, t, _)| (s, t))
}

/// `POST /enroll` — unsigned. Auto-allowlists the client pubkey on the server
/// side. Returns `Ok((status, body))`; callers parse the body to decide
/// whether to set `enrolled_at`.
pub async fn enroll(base: &str, pubkey_b64: &str) -> Result<(u16, String), ProxyError> {
    let url = make_url(base, "/enroll");
    let body = serde_json::json!({ "pubkey": pubkey_b64 });
    let resp = http_client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| ProxyError::Network(e.to_string()))?;
    // These return the raw (status, body) pair and never classify, so the
    // Retry-After is not theirs to carry.
    body_text(resp).await.map(|(s, t, _)| (s, t))
}

/// Unsigned GET that decodes JSON. For genuinely PUBLIC endpoints that don't
/// require enrollment — e.g. the desk's `GET /api/desk/pairs`, which the
/// reference client calls unsigned (it populates the routable-pairs roster and
/// may run before the wallet has enrolled). `pub(crate)` for [`crate::desk`].
pub(crate) async fn get_unsigned<R: for<'de> Deserialize<'de>>(
    base: &str,
    path: &str,
) -> Result<R, ProxyError> {
    let url = make_url(base, path);
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| ProxyError::Network(e.to_string()))?;
    let (status, text, retry_after) = body_text(resp).await?;
    if (200..300).contains(&status) {
        serde_json::from_str(&text).map_err(|e| ProxyError::Parse(e.to_string()))
    } else {
        Err(classify_error(status, &text, retry_after))
    }
}

// -------- SwapKit (signed) --------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapKitQuoteRequest {
    pub sell_asset: String,
    pub buy_asset: String,
    pub sell_amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slippage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cf_boost: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_execution_time: Option<u32>,
}

pub async fn swapkit_quote(
    state: &SwapState,
    req: &SwapKitQuoteRequest,
) -> Result<Value, ProxyError> {
    post_signed(state, "/api/swapkit/quote", req).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapKitSwapRequest {
    pub route_id: String,
    pub source_address: String,
    pub destination_address: String,
}

pub async fn swapkit_swap(
    state: &SwapState,
    req: &SwapKitSwapRequest,
) -> Result<Value, ProxyError> {
    post_signed(state, "/api/swapkit/swap", req).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapKitTrackRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deposit_address: Option<String>,
}

pub async fn swapkit_track(
    state: &SwapState,
    req: &SwapKitTrackRequest,
) -> Result<Value, ProxyError> {
    post_signed(state, "/api/swapkit/track", req).await
}

/// Settings → Test Connection: signed GET /api/intents/tokens.
pub async fn intents_tokens(state: &SwapState) -> Result<(u16, String), ProxyError> {
    let base = state.proxy_url().ok_or(ProxyError::NoUrl)?;
    let path = "/api/intents/tokens";
    let url = make_url(&base, path);
    let resp = send_once(state, "GET", &url, path, None, &[], true).await?;
    // These return the raw (status, body) pair and never classify, so the
    // Retry-After is not theirs to carry.
    body_text(resp).await.map(|(s, t, _)| (s, t))
}

// -------- NEAR Intents 1Click (signed) --------

/// Mirror of the 1Click `/quote` request body the JS layer builds in
/// `useSwapQuote.ts::buildIntentsRequestSafely`. Every field listed in
/// the body-shape regression test MUST be a field here; serde_json's
/// default (and Tauri's IPC) silently drops unknown keys on deserialize,
/// which would re-serialize a partial body downstream and produce the
/// "dry should not be empty" upstream error from May 6 2026.
///
/// Keep this struct in lockstep with `useSwapQuote.test.ts::matches the
/// server agent's known-good body shape`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentsQuoteRequest {
    /// REQUIRED — boolean literal. Was missing from this struct until
    /// 2026-05-06; the JS body had it, but the Rust mirror didn't, so
    /// deserialize-then-reserialize stripped it before the proxy POST.
    pub dry: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slippage_tolerance: Option<u32>,
    pub origin_asset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deposit_type: Option<String>,
    pub destination_asset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_type: Option<String>,
    pub amount: String,
    pub recipient: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_type: Option<String>,
    pub refund_to: String,
    pub deadline: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_waiting_time_ms: Option<u32>,
}

pub async fn intents_quote(
    state: &SwapState,
    req: &IntentsQuoteRequest,
) -> Result<Value, ProxyError> {
    post_signed(state, "/api/intents/quote", req).await
}

#[cfg(test)]
mod intents_quote_tests {
    use super::*;

    /// Regression lock for the May 6 2026 "dry stripped between JS log
    /// and proxy POST" bug. The Rust struct mirror MUST round-trip
    /// `dry: false` byte-identical. If any required field gets removed
    /// from the struct definition, this test fails — which is the
    /// signal to update both `IntentsQuoteRequest` here AND the
    /// JS-side body-shape lock in `useSwapQuote.test.ts`.
    #[test]
    fn round_trip_preserves_dry_and_quote_waiting_time() {
        let body = serde_json::json!({
            "dry": false,
            "swapType": "EXACT_INPUT",
            "slippageTolerance": 200,
            "originAsset": "nep141:eth.omft.near",
            "depositType": "ORIGIN_CHAIN",
            "destinationAsset": "nep141:btc.omft.near",
            "recipientType": "DESTINATION_CHAIN",
            "amount": "5000000000000000",
            "recipient": "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
            "refundType": "ORIGIN_CHAIN",
            "refundTo": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            "deadline": "2026-05-06T21:41:05.077Z",
            "quoteWaitingTimeMs": 5000,
        });

        let parsed: IntentsQuoteRequest =
            serde_json::from_value(body.clone()).expect("body should deserialize");

        // The two fields the Rust mirror was missing in the May 6 bug.
        // These asserts are the regression lock.
        assert!(!parsed.dry, "dry must round-trip as boolean false");
        assert_eq!(parsed.quote_waiting_time_ms, Some(5000));

        // Sanity-check a few other fields so we catch broader drift.
        assert_eq!(parsed.amount, "5000000000000000");
        assert_eq!(parsed.origin_asset, "nep141:eth.omft.near");
        assert_eq!(parsed.recipient, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
        assert_eq!(
            parsed.refund_to,
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );

        // Re-serialize and verify the wire body still has every key the
        // server vector requires. Use camelCase comparison since serde
        // is configured with `rename_all = "camelCase"`.
        let serialized = serde_json::to_value(&parsed).expect("serialize back");
        for required in [
            "dry",
            "swapType",
            "slippageTolerance",
            "originAsset",
            "depositType",
            "destinationAsset",
            "recipientType",
            "amount",
            "recipient",
            "refundType",
            "refundTo",
            "deadline",
            "quoteWaitingTimeMs",
        ] {
            assert!(
                serialized.get(required).is_some(),
                "re-serialized body must contain field {required} (was stripped in the May 6 bug)",
            );
        }

        // And the boolean type stays boolean (not a string).
        assert!(
            serialized.get("dry").and_then(Value::as_bool).is_some(),
            "dry must serialize as boolean, not string",
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentsDepositSubmit {
    pub deposit_address: String,
    pub tx_hash: String,
}

pub async fn intents_deposit_submit(
    state: &SwapState,
    req: &IntentsDepositSubmit,
) -> Result<Value, ProxyError> {
    post_signed(state, "/api/intents/deposit-submit", req).await
}

pub async fn intents_status(state: &SwapState, deposit_address: &str) -> Result<Value, ProxyError> {
    let path = format!(
        "/api/intents/status?depositAddress={}",
        url::form_urlencoded::byte_serialize(deposit_address.as_bytes()).collect::<String>()
    );
    get_signed(state, &path).await
}

#[cfg(test)]
mod desk_busy_tests {
    use super::*;

    /// 503 `desk_busy` must classify as a RETRY, never as a generic HTTP failure.
    ///
    /// Before this, it fell through to `ProxyError::Http(503, ..)` and every
    /// one-shot caller treated it as terminal — which would abort a live swap
    /// because the desk was three seconds into an engine call. The desk added the
    /// bounded 503 on 2026-07-26 precisely so the reader fails fast; that is only
    /// an improvement if our side reads it as "come back", not "give up".
    #[test]
    fn desk_busy_is_typed_as_retryable_not_as_a_generic_http_error() {
        // NOTE the code lives under "error", not "code" — see `parse_error_body`.
        // The first draft of this test used "code" and passed anyway, because the
        // bare-503 arm caught it: the code-based arm was dead and the test could
        // not see that. Asserting a NON-503 status is what forces the code path.
        assert!(matches!(
            classify_error(503, r#"{"error":"desk_busy","message":"swap mutex"}"#, None),
            ProxyError::DeskBusy
        ));
        // Case must not decide the verdict — a cosmetic change on their side
        // cannot be allowed to silently turn a retry back into an abort.
        assert!(matches!(
            classify_error(503, r#"{"error":"DESK_BUSY"}"#, None),
            ProxyError::DeskBusy
        ));
        // The code alone must be enough, independent of status. This is the
        // assertion the first draft was missing.
        assert!(matches!(
            classify_error(429, r#"{"error":"desk_busy"}"#, None),
            ProxyError::DeskBusy
        ));
        // A bare 503 with no code is still "come back later".
        assert!(matches!(classify_error(503, "", None), ProxyError::DeskBusy));
        // And nothing else got swept into it.
        assert!(matches!(
            classify_error(500, r#"{"error":"INTERNAL"}"#, None),
            ProxyError::Http(500, _)
        ));
        assert!(matches!(
            classify_error(409, r#"{"error":"SWAP_STATE_CONFLICT"}"#, None),
            ProxyError::DeskSwapStateConflict
        ));
    }

    /// CC-7: the two refusals demand OPPOSITE responses, so they must not be
    /// the same shape. `INVENTORY_UNAVAILABLE` is retryable and carries the
    /// desk's own delay; `SIZE_OUT_OF_RANGE` is not retryable at any delay and
    /// carries the desk's explanation instead.
    #[test]
    fn the_two_refusals_are_distinguishable_cc7() {
        let inv = classify_error(409, r#"{"error":"INVENTORY_UNAVAILABLE"}"#, Some(30));
        assert!(matches!(
            inv,
            ProxyError::DeskInventoryUnavailable { retry_after_secs: Some(30) }
        ));
        assert!(inv.to_string().contains("retry in 30s"));

        let size = classify_error(
            400,
            r#"{"error":"SIZE_OUT_OF_RANGE","message":"0.20 XMR exceeds the per-swap cap of $25"}"#,
            None,
        );
        match size {
            ProxyError::DeskSizeOutOfRange(ref m) => {
                // CC-20: the desk's sentence survives, so the per-swap CAP is
                // distinguishable from a min/max window refusal - a different
                // control in a different unit.
                assert!(m.contains("per-swap cap"), "{m}");
            }
            other => panic!("expected DeskSizeOutOfRange, got {other:?}"),
        }
    }

    /// CC-7 FALSIFY: strip the header and the client must fall back to
    /// NON-retryable, never assume retryable. Absent guidance from a desk that
    /// just said it was short is not permission to hammer it.
    #[test]
    fn a_missing_retry_after_does_not_become_a_default_cc7() {
        let inv = classify_error(409, r#"{"error":"INVENTORY_UNAVAILABLE"}"#, None);
        assert!(matches!(
            inv,
            ProxyError::DeskInventoryUnavailable { retry_after_secs: None }
        ));
        assert!(
            inv.to_string().contains("no retry is scheduled"),
            "the message must say a retry is NOT scheduled: {inv}"
        );
        // A garbage or hostile header is could-not-look, not a guess.
        assert_eq!(parse_retry_after(Some("soon")), None);
        assert_eq!(parse_retry_after(Some("0")), None);
        assert_eq!(parse_retry_after(Some("999999")), None, "a week-long delay is not honoured");
        assert_eq!(parse_retry_after(Some(" 30 ")), Some(30));
    }

}
