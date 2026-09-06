//! Direct chain RPC broadcasts.
//!
//! The integration plan's "step 6" (the linchpin): the signed transaction
//! goes from the Tauri Rust core *directly* to a chain RPC, never through the
//! proxy. This keeps the proxy non-custodial — it can never see signed bytes.
//!
//! v1 chain coverage:
//! * EVM (any chain ID) — `eth_sendRawTransaction` against the configured RPC.
//! * Bitcoin / Litecoin / Dogecoin / BCH — Esplora `POST /tx`.
//! * NEAR — JSON-RPC `broadcast_tx_async` (used only when sending NEP-413
//!   intents that wrap an on-chain action; deposits via 1Click never broadcast
//!   here, the user signs an EVM/UTXO/SOL tx on the source chain).
//! * Solana — JSON-RPC `sendTransaction`.
//!
//! RPC endpoints are passed in by the caller (the webview supplies them from
//! its existing chain-config UI). We do NOT hard-code Infura/Alchemy keys;
//! that would put a third-party secret in the binary.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum BroadcastError {
    #[error("network error: {0}")]
    Network(String),
    #[error("RPC returned {0}: {1}")]
    Rpc(u16, String),
    #[error("RPC error: {0}")]
    RpcLogical(String),
    #[error("response parse error: {0}")]
    Parse(String),
    #[error("unsupported chain: {0}")]
    Unsupported(String),
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("reqwest client")
}

/// `eth_sendRawTransaction` — works for every EVM chain.
pub async fn evm_broadcast(rpc_url: &str, raw_tx_hex: &str) -> Result<String, BroadcastError> {
    let raw = if raw_tx_hex.starts_with("0x") {
        raw_tx_hex.to_string()
    } else {
        format!("0x{raw_tx_hex}")
    };
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_sendRawTransaction",
        "params": [raw],
    });
    let resp = http_client()
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(BroadcastError::Rpc(status.as_u16(), text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| BroadcastError::Parse(e.to_string()))?;
    if let Some(err) = v.get("error") {
        return Err(BroadcastError::RpcLogical(err.to_string()));
    }
    v.get("result")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BroadcastError::Parse("missing result".into()))
}

/// Esplora-compatible `POST /tx` — Blockstream Esplora and forks for LTC/DOGE/BCH.
pub async fn utxo_broadcast(esplora_url: &str, raw_tx_hex: &str) -> Result<String, BroadcastError> {
    let url = format!("{}/tx", esplora_url.trim_end_matches('/'));
    let resp = http_client()
        .post(&url)
        .body(raw_tx_hex.trim().to_string())
        .send()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(BroadcastError::Rpc(status.as_u16(), text));
    }
    Ok(text.trim().to_string()) // Esplora returns the txid as plain text
}

/// Solana JSON-RPC `sendTransaction` — base64 input.
pub async fn solana_broadcast(rpc_url: &str, raw_tx_b64: &str) -> Result<String, BroadcastError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [raw_tx_b64, { "encoding": "base64" }],
    });
    let resp = http_client()
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(BroadcastError::Rpc(status.as_u16(), text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| BroadcastError::Parse(e.to_string()))?;
    if let Some(err) = v.get("error") {
        return Err(BroadcastError::RpcLogical(err.to_string()));
    }
    v.get("result")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BroadcastError::Parse("missing result".into()))
}

/// NEAR JSON-RPC `broadcast_tx_async` — base64 of borsh-serialized SignedTransaction.
pub async fn near_broadcast(rpc_url: &str, signed_tx_b64: &str) -> Result<String, BroadcastError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "broadcast_tx_async",
        "params": [signed_tx_b64],
    });
    let resp = http_client()
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(BroadcastError::Rpc(status.as_u16(), text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| BroadcastError::Parse(e.to_string()))?;
    if let Some(err) = v.get("error") {
        return Err(BroadcastError::RpcLogical(err.to_string()));
    }
    v.get("result")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BroadcastError::Parse("missing result".into()))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastInput {
    /// One of: "EVM", "UTXO", "SOLANA", "NEAR".
    pub chain_kind: String,
    pub rpc_url: String,
    /// EVM: 0x-prefixed hex. UTXO: hex (no prefix). Solana: base64. NEAR: base64.
    pub raw_tx: String,
}

pub async fn broadcast(input: &BroadcastInput) -> Result<String, BroadcastError> {
    match input.chain_kind.to_uppercase().as_str() {
        "EVM" => evm_broadcast(&input.rpc_url, &input.raw_tx).await,
        "UTXO" | "BTC" | "LTC" | "DOGE" | "BCH" => {
            utxo_broadcast(&input.rpc_url, &input.raw_tx).await
        }
        "SOLANA" | "SOL" => solana_broadcast(&input.rpc_url, &input.raw_tx).await,
        "NEAR" => near_broadcast(&input.rpc_url, &input.raw_tx).await,
        other => Err(BroadcastError::Unsupported(other.to_string())),
    }
}

// ─── Verified broadcast (P0 fix, 2026-05-06) ─────────────────────
//
// The original `evm_broadcast` returned `Ok(hash)` whenever the RPC
// returned 200 with a `result` field. That hash is what the node
// COMPUTES from the bytes — not proof that the network actually
// accepted the tx. Some nodes (especially when rate-limited or under
// stress) respond 200 with a hash but never propagate the tx; the
// hash never reaches a miner. Etherscan shows nothing. The wallet's
// UI displays a "successful broadcast" with a tx hash that is
// effectively a forgery from the user's perspective.
//
// `evm_broadcast_verified` adds the missing step: after the RPC
// returns a hash, immediately call `eth_getTransactionByHash` on the
// SAME node. If the node returns null (tx not in pool), the broadcast
// is rejected and we move to the next URL in the fallback list. Only
// when the SAME node confirms the tx exists do we return the hash to
// the caller.
//
// Iteration also moves into Rust here. The TS side previously did
// `tryRpcUrls(urls, url => broadcastTx(url))` — that worked but kept
// each per-URL result inside the JS catch chain. With the iteration
// in Rust, we get a typed `BroadcastError` with the per-URL audit
// trail and a single Tauri round-trip instead of N.

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBroadcastInput {
    pub rpc_urls: Vec<String>,
    /// 0x-prefixed hex of the signed EVM transaction.
    pub raw_tx_hex: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBroadcastResult {
    pub tx_hash: String,
    pub url_used: String,
    /// Per-URL trace of broadcast + verification attempts. The
    /// successful URL appears at the end of `errors` only if it had
    /// to retry verification; usually empty for a clean run. Used by
    /// the UI's diagnostic display when broadcasting succeeds against
    /// a non-primary endpoint.
    pub attempts: Vec<BroadcastAttempt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastAttempt {
    pub url: String,
    pub stage: String, // "broadcast" or "verify"
    pub error: String,
}

/// `eth_getTransactionByHash` against a single URL. Returns:
///   - Ok(true)  — the node returns a tx object (in pool or mined)
///   - Ok(false) — the node returns null (tx not in this node's view)
///   - Err(...)  — RPC error / network failure
async fn evm_get_tx_by_hash(rpc_url: &str, tx_hash: &str) -> Result<bool, BroadcastError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getTransactionByHash",
        "params": [tx_hash],
    });
    let resp = http_client()
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| BroadcastError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(BroadcastError::Rpc(status.as_u16(), text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| BroadcastError::Parse(e.to_string()))?;
    if let Some(err) = v.get("error") {
        return Err(BroadcastError::RpcLogical(err.to_string()));
    }
    let result = v.get("result");
    Ok(matches!(result, Some(r) if !r.is_null()))
}

/// Iterate through `rpc_urls`, broadcasting + verifying each. Returns
/// the first URL that produces a network-accepted tx. If every URL
/// fails (broadcast or verification), returns `BroadcastError::Rpc`
/// with the per-URL audit trail in the body.
pub async fn evm_broadcast_verified(
    input: &VerifiedBroadcastInput,
) -> Result<VerifiedBroadcastResult, (BroadcastError, Vec<BroadcastAttempt>)> {
    let mut attempts = Vec::new();
    for url in &input.rpc_urls {
        let hash = match evm_broadcast(url, &input.raw_tx_hex).await {
            Ok(h) => h,
            Err(e) => {
                attempts.push(BroadcastAttempt {
                    url: url.clone(),
                    stage: "broadcast".into(),
                    error: e.to_string(),
                });
                continue;
            }
        };
        // Verify with the SAME node — if the node accepted the tx,
        // it should appear in its pool view immediately. A null
        // return means the broadcast was a no-op (rate-limited,
        // node-internal rejection, or a network that swallows
        // submissions).
        match evm_get_tx_by_hash(url, &hash).await {
            Ok(true) => {
                return Ok(VerifiedBroadcastResult {
                    tx_hash: hash,
                    url_used: url.clone(),
                    attempts,
                });
            }
            Ok(false) => {
                attempts.push(BroadcastAttempt {
                    url: url.clone(),
                    stage: "verify".into(),
                    error: format!(
                        "broadcast accepted hash {hash} but eth_getTransactionByHash returned null on the same node — the submission likely never reached the mempool",
                    ),
                });
                continue;
            }
            Err(e) => {
                // Verification call itself failed (timeout, 5xx). We
                // can't be sure the broadcast is good — be strict and
                // try the next URL. The retry costs little; the cost
                // of declaring fake success is high.
                attempts.push(BroadcastAttempt {
                    url: url.clone(),
                    stage: "verify".into(),
                    error: format!("verification call failed: {e}"),
                });
                continue;
            }
        }
    }
    Err((
        BroadcastError::Rpc(
            0,
            format!(
                "All {} EVM RPCs failed broadcast or verification",
                input.rpc_urls.len()
            ),
        ),
        attempts,
    ))
}
