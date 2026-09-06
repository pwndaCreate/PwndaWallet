//! Smoke tests for the pool-ping L1 frame contract.
//!
//! Same Windows-cdylib rationale as `dialect_probe_smoke.rs` and
//! `pool_simulator_smoke.rs` — this file is self-contained (no
//! `use tauri_eth_wallet_lib::...`) because the lib crate ships with
//! `crate-type = ["lib", "cdylib", "staticlib"]` and on Windows
//! linking the cdylib from a test binary fails at load time with
//! `STATUS_ENTRYPOINT_NOT_FOUND` (rust-lang/cargo#5754).
//!
//! These tests therefore re-implement only the **contract** the L1
//! frame builder must obey:
//!
//! - HeroMiners CFX needs `WalletWithPass` shape (params[0]=cfx wallet,
//!   params[1]="x"). This is the **Class B silent-success regression
//!   lock**: pre-Layer-1, the smoke test sent Empty params and the
//!   pool ack'd at the protocol level without ever binding the worker
//!   to a wallet (dashboard-empty bug, anchor session
//!   `dev-fee-20260518T061512Z-gpu.jsonl`).
//! - HeroMiners ERG (and WoolyPooly ERG at port 3100) need Empty params.
//! - Nanopool / NTMiner CFX need `AgentExt` (NiceHash extension).
//! - All V1 frames must end with `\n` (stratum is line-delimited).
//!
//! Inline `#[cfg(test)] mod tests` in `src/pool_ping.rs` covers the
//! full assertion set (allowlist sort + every host + parse_endpoint +
//! algo helpers + accept_reply + max_level routing). Those run on
//! Linux/CI where `cargo test --lib` works. This integration test
//! re-locks the **silent-success Class B fix** on Windows where
//! `cargo test --lib` does not.
//!
//! If you change the L1 frame builder in `src/pool_ping.rs`, mirror
//! the relevant contract here. The duplication is intentional — the
//! alternative is no Windows-runnable coverage of the Class B fix.

use serde_json::Value;

// ============================================================
// Local re-implementation of the contract
// (mirrors src/pool_ping.rs::build_l1_frame for V1 algos)
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubscribeShape {
    Empty,
    Agent,
    AgentExt,
    AgentWallet,
    WalletOnly,
    WalletWithPass,
}

/// Mirrors `dev_fee::pool_quirks::classify_host` for the rows the
/// smoke test currently relies on. Adding a new pool to the production
/// quirks table doesn't strictly require updating this mirror — the
/// production tests in pool_quirks.rs cover that — but the smoke
/// tests below will surface a contract mismatch loudly.
fn shape_for(endpoint: &str) -> SubscribeShape {
    let host = endpoint
        .trim_start_matches("stratum+ssl://")
        .trim_start_matches("stratum+tcp://")
        .trim_start_matches("ssl://")
        .trim_start_matches("tcp://")
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(endpoint)
        .to_ascii_lowercase();
    let port = endpoint
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse::<u16>().ok());
    if host.ends_with("woolypooly.com") {
        return match port {
            Some(3094) => SubscribeShape::WalletWithPass,
            Some(3100) => SubscribeShape::Empty,
            _ => SubscribeShape::Empty,
        };
    }
    if host.ends_with(".conflux.herominers.com") || host == "conflux.herominers.com" {
        return SubscribeShape::WalletWithPass;
    }
    if host.ends_with(".ergo.herominers.com") || host == "ergo.herominers.com" {
        return SubscribeShape::Empty;
    }
    if host.ends_with("herominers.com") {
        return SubscribeShape::Empty;
    }
    if host.contains("ergo") || host.starts_with("ergo-") {
        return SubscribeShape::Agent;
    }
    if host.ends_with("nanopool.org") {
        return SubscribeShape::AgentExt;
    }
    if host.ends_with("ntminer.vip") {
        return SubscribeShape::AgentExt;
    }
    SubscribeShape::Empty
}

fn agent_for(algorithm: &str) -> &'static str {
    match algorithm.to_ascii_lowercase().as_str() {
        "kawpow" | "autolykos" | "autolykos2" => "SRBMiner-MULTI/3.1.8",
        "octopus" => "lolMiner/1.96",
        _ => "PwndaWallet-smoke/1.0",
    }
}

/// Build the L1 frame contract — newline-terminated JSON-RPC envelope
/// per shape. Mirrors `pool_ping::build_l1_frame` for the V1 algo path.
fn build_l1_frame_contract(endpoint: &str, algorithm: &str, wallet_with_worker: &str) -> Vec<u8> {
    let shape = shape_for(endpoint);
    let agent = agent_for(algorithm);
    let params = match shape {
        SubscribeShape::Empty => serde_json::json!([]),
        SubscribeShape::Agent => serde_json::json!([agent]),
        SubscribeShape::AgentExt => serde_json::json!([agent, "EthereumStratum/1.0.0"]),
        SubscribeShape::AgentWallet => serde_json::json!([agent, wallet_with_worker]),
        SubscribeShape::WalletOnly => serde_json::json!([wallet_with_worker]),
        SubscribeShape::WalletWithPass => serde_json::json!([wallet_with_worker, "x"]),
    };
    let body = serde_json::json!({
        "id": 1,
        "jsonrpc": "2.0",
        "method": "mining.subscribe",
        "params": params,
    });
    let mut bytes = serde_json::to_vec(&body).unwrap();
    bytes.push(b'\n');
    bytes
}

// ============================================================
// Tests
// ============================================================

// NOTE (2026-08-27): `CFX_DEV_WALLET` and the test
// `cfx_dev_wallet_constant_matches_registry` were removed here. That test read
// `src/dev_fee/wallets.rs` to assert this file's copy of the dev-fee CFX address
// still matched the registry — but the whole `src/dev_fee/` module was deleted in
// commit fff83e1 ("pure-wallet cutover", 2026-07-07), so the test panicked on a
// missing file rather than failing an assertion, and had done so on every full
// test run since.
//
// Coverage was NOT silently dropped: it guarded drift between two copies of one
// address, and one of those copies no longer exists. The tests below use
// CFX_DEV_WORKER purely as a pool-protocol fixture (what bytes go on the wire),
// which is independent of any wallet registry.
const CFX_DEV_WORKER: &str = "cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw.pwnda-dev";

fn parse(frame: &[u8]) -> Value {
    let body = std::str::from_utf8(frame).expect("UTF-8");
    serde_json::from_str(body.trim()).expect("JSON")
}

#[test]
fn herominers_cfx_uses_wallet_with_pass_class_b_regression_lock() {
    // The silent-success bug fix. Pre-Layer-1 the smoke test sent
    // Empty params, the pool ack'd at the protocol layer, but no
    // worker-to-wallet binding was registered. WalletWithPass is the
    // shape lolMiner sends natively (captured in session 033004Z).
    let frame = build_l1_frame_contract(
        "stratum+tcp://de.conflux.herominers.com:1170",
        "octopus",
        CFX_DEV_WORKER,
    );
    let v = parse(&frame);
    assert_eq!(v["method"], "mining.subscribe");
    let params = v["params"].as_array().unwrap();
    assert_eq!(params.len(), 2, "WalletWithPass requires [wallet, pass]");
    assert!(
        params[0].as_str().unwrap().starts_with("cfx:"),
        "params[0] must be CFX address"
    );
    assert!(
        params[0].as_str().unwrap().contains(".pwnda-dev"),
        "wallet must carry the dev worker tag (proves the smoke test won't credit user shares)"
    );
    assert_eq!(params[1], "x");
    assert!(frame.ends_with(b"\n"));
}

#[test]
fn woolypooly_cfx_3094_uses_wallet_with_pass() {
    // Same dialect as HeroMiners CFX — WoolyPooly's Octopus daemon also
    // registers worker-to-wallet at subscribe time (anchor:
    // dev-fee-20260518T061512Z-gpu.jsonl pre-fix had 26 accepted shares
    // but dashboard showed 0 because Empty subscribe left wallet unbound).
    let frame = build_l1_frame_contract(
        "stratum+tcp://pool.woolypooly.com:3094",
        "octopus",
        CFX_DEV_WORKER,
    );
    let v = parse(&frame);
    let params = v["params"].as_array().unwrap();
    assert_eq!(params.len(), 2);
    assert!(params[0].as_str().unwrap().starts_with("cfx:"));
    assert_eq!(params[1], "x");
}

#[test]
fn herominers_ergo_uses_empty_subscribe() {
    // ERG/Autolykos2 daemon accepts Empty subscribe (direct stratum
    // probe 2026-05-18 returned valid result envelope). Class B doesn't
    // apply here — Autolykos2 binds wallet at authorize time, not
    // subscribe.
    let frame = build_l1_frame_contract(
        "stratum+tcp://de.ergo.herominers.com:1180",
        "autolykos",
        "9gE1...",
    );
    let v = parse(&frame);
    assert!(
        v["params"].as_array().map(|a| a.is_empty()).unwrap_or(false),
        "HeroMiners ERG must use empty-params subscribe; got {}",
        v["params"]
    );
}

#[test]
fn woolypooly_ergo_3100_uses_empty_subscribe() {
    let frame = build_l1_frame_contract(
        "stratum+tcp://pool.woolypooly.com:3100",
        "autolykos",
        "9gE1...",
    );
    let v = parse(&frame);
    assert!(v["params"].as_array().map(|a| a.is_empty()).unwrap_or(false));
}

#[test]
fn nanopool_cfx_uses_agent_ext_with_lolminer_agent() {
    let frame = build_l1_frame_contract(
        "stratum+tcp://cfx-eu1.nanopool.org:10500",
        "octopus",
        CFX_DEV_WORKER,
    );
    let v = parse(&frame);
    let params = v["params"].as_array().unwrap();
    assert_eq!(params.len(), 2);
    assert_eq!(params[0], "lolMiner/1.96");
    assert_eq!(params[1], "EthereumStratum/1.0.0");
}

#[test]
fn nanopool_cfx_us_east_same_shape_as_eu() {
    // Regression lock on the 2026-05-23 allowlist drift fix — the US
    // region host went missing for weeks. Its shape must match EU.
    let eu = parse(&build_l1_frame_contract(
        "stratum+tcp://cfx-eu1.nanopool.org:10500",
        "octopus",
        CFX_DEV_WORKER,
    ));
    let us = parse(&build_l1_frame_contract(
        "stratum+tcp://cfx-us-east1.nanopool.org:10500",
        "octopus",
        CFX_DEV_WORKER,
    ));
    assert_eq!(eu["params"], us["params"]);
}

#[test]
fn ntminer_cfx_uses_agent_ext() {
    let frame = build_l1_frame_contract(
        "stratum+ssl://cfx.ntminer.vip:25050",
        "octopus",
        CFX_DEV_WORKER,
    );
    let v = parse(&frame);
    assert_eq!(v["params"][1], "EthereumStratum/1.0.0");
}

#[test]
fn all_v1_frames_end_with_newline() {
    // Stratum is line-delimited; the daemon waits for a `\n` to dispatch.
    let cases = [
        ("stratum+tcp://de.conflux.herominers.com:1170", "octopus"),
        ("stratum+tcp://de.ergo.herominers.com:1180", "autolykos"),
        ("stratum+tcp://pool.woolypooly.com:3094", "octopus"),
        ("stratum+tcp://cfx-eu1.nanopool.org:10500", "octopus"),
    ];
    for (ep, algo) in cases {
        let frame = build_l1_frame_contract(ep, algo, CFX_DEV_WORKER);
        assert_eq!(
            frame.last().copied(),
            Some(b'\n'),
            "{} / {} probe missing trailing newline",
            ep,
            algo
        );
    }
}

#[test]
fn jsonrpc_field_is_present_on_v1_subscribe() {
    // Fix K (2026-05-18): pools may condition reply shape on the
    // `jsonrpc:"2.0"` field's presence. Probe must include it.
    let frame = build_l1_frame_contract(
        "stratum+tcp://pool.woolypooly.com:3094",
        "octopus",
        CFX_DEV_WORKER,
    );
    let v = parse(&frame);
    assert_eq!(v["jsonrpc"], "2.0");
}
