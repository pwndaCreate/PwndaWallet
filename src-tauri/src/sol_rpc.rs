//! Solana JSON-RPC POST proxy.
//!
//! Public Solana RPCs — including the official `api.mainnet-beta.solana.com`
//! and the popular community endpoints (PublicNode, Ankr, dRPC) — reject
//! browser-origin POSTs with HTTP 403 ("Access forbidden"). Tauri's webview
//! origin (`tauri://localhost` / `https://tauri.localhost`) trips that
//! filter, so a renderer-side `fetch` reliably fails on every endpoint in
//! the fallback chain. A normal Rust HTTP client has no Origin header and
//! is treated as ordinary client traffic, which the same endpoints accept.
//!
//! This is the same workaround already used for the Monero/Zephyr
//! `/get_info` probe in `wallet_rpc_common::probe_node` — route the call
//! through reqwest in the backend.

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize)]
pub struct SolRpcResponse {
    pub status: u16,
    pub body: String,
}

/// Shared reqwest client. Built once on first use and reused across
/// every `sol_rpc_call` invocation. Without this, the frontend's
/// parallel-race RPC pattern (7 simultaneous requests per balance fetch)
/// re-builds the TLS stack on every call, adding ~50ms of overhead per
/// endpoint per call. Sharing the client also enables connection pooling
/// for the common case where the user hits the same endpoint repeatedly.
static SHARED_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_client() -> &'static reqwest::Client {
    SHARED_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // 30s ceiling — frontend bails per-attempt at 12s and retries
            // once after 1.5s, so the longest a single Rust call can run
            // is ~12s before the frontend abandons it. The Rust ceiling
            // is held higher than that to avoid Rust-side errors when
            // frontend wants the full 12s response.
            .timeout(std::time::Duration::from_secs(30))
            // 5s connect timeout: if we can't even open a TCP socket in
            // 5s, the endpoint is firewalled or down — short-circuit
            // instead of waiting for the body timeout.
            .connect_timeout(std::time::Duration::from_secs(5))
            // The Tauri webview's User-Agent is empty by default, which
            // some RPC providers treat as suspicious. Identify Pwnda
            // explicitly so a future provider that wants to whitelist
            // legitimate wallet traffic can do so.
            .user_agent("PwndaWallet/1.0 (+https://pwnda.app)")
            .build()
            .expect("reqwest client build should not fail with default config")
    })
}

/// Proxy a single JSON-RPC POST to a Solana RPC endpoint.
///
/// Returns the raw body and HTTP status so the frontend `Response` shim can
/// preserve `response.ok` semantics — `@solana/web3.js` already classifies
/// non-2xx as a failure and the existing `runOnAnyRpc` fallback advances to
/// the next URL, no extra plumbing needed.
///
/// Restricted to `https://` URLs to avoid acting as a generic SSRF gadget.
/// Every public Solana RPC is https; non-https requests are refused.
#[tauri::command]
pub async fn sol_rpc_call(url: String, body: String) -> Result<SolRpcResponse, String> {
    if !url.starts_with("https://") {
        return Err(format!("Refusing to proxy non-https URL: {}", url));
    }

    let resp = shared_client()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("solana rpc request failed: {}", e))?;

    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("solana rpc body read failed: {}", e))?;

    Ok(SolRpcResponse { status, body: text })
}
