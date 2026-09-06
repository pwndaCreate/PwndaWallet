//! Per-pool Stratum dialect knowledge — hostname-keyed subscribe shapes +
//! the V1/RandomX handshake frame builders.
//!
//! **This module is fee-free.** It was extracted from the (removed) dev-fee
//! proxy on 2026-07-06 ([[pure-wallet-transition-plan]] Workstream A) because
//! `pool_ping.rs`'s connectivity smoke test depends on the hand-tuned pool
//! dialect table — production corpus knowledge (HeroMiners empty-params /
//! WoolyPooly class-B bug / Nanopool AgentExt shape) that must survive the
//! dev-fee removal. It documents "what shape does pool X's daemon accept on
//! `mining.subscribe`/`login`", nothing about fees or dev wallets.
//!
//! ## Hostname-keyed
//!
//! Quirks are looked up by the pool's **hostname** (between scheme and port).
//! `quirks_for` takes the raw stratum URL and parses the host/port internally.
//!
//! ## Default = safe
//!
//! Unknown hostnames get [`PoolQuirks::SAFE_DEFAULTS`] — `Empty` subscribe
//! params, the only shape all three observed V1 daemons accept (silent
//! rejection is the worst outcome; the default biases against it).
//!
//! ## Probe identity
//!
//! Smoke-test frames need *some* address in wallet-bearing subscribe shapes.
//! Since there is no longer a dev wallet, probes use [`PROBE_ADDRESS`] — a
//! neutral placeholder. Pools that validate the address answer with
//! `Invalid address`, which still proves the daemon is alive and speaks
//! stratum (which is all the L1 probe needs to confirm).

use serde_json::Value;

/// Neutral placeholder address used in smoke-test handshake frames (no dev
/// wallet). Pools reply with a job (accept) or an address error (reject) —
/// either way the daemon proved it's alive.
pub const PROBE_ADDRESS: &str = "PwndaWallet-smoke-test";
/// Worker suffix for probe frames.
pub const PROBE_WORKER: &str = "smoke";

/* ══════ Subscribe params shape ═══════════════════════════════════════ */

/// Shape of the `params` array on the upstream `mining.subscribe` frame.
///
/// 2026-05-12 finding: WoolyPooly's V1 daemon **silently EOFs** on any
/// subscribe carrying an agent string. `Empty` is the only universally
/// accepted form, so it's the default for unknown hostnames in `quirks_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum SubscribeParamsShape {
    /// `params: []` — safe default; works against HeroMiners / Nanopool / WoolyPooly.
    Empty,
    /// `params: [agent]`. Triggers a silent EOF on WoolyPooly.
    Agent,
    /// `params: [agent, "EthereumStratum/1.0.0"]` — NiceHash extension negotiation.
    AgentExt,
    /// `params: [agent, "<wallet>"]` — ethproxy-hybrid (params[1] = wallet).
    AgentWallet,
    /// `params: ["<wallet>.<worker>"]` — wallet at params[0], no agent (HeroMiners CFX legacy).
    WalletOnly,
    /// `params: ["<wallet>.<worker>", "<pass>"]` — HeroMiners/WoolyPooly CFX native (lolMiner shape).
    WalletWithPass,
}

/* ══════ Pool quirks + classification table ══════════════════════════ */

/// Pool-specific behavioural flags that drive upstream Stratum framing.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct PoolQuirks {
    /// Shape of `params` on the upstream `mining.subscribe` frame.
    pub subscribe_params_shape: SubscribeParamsShape,
    /// True when the pool sends `mining.set_difficulty` for V1 algorithms
    /// (false for Autolykos2 — target embedded in the notify's `b` field).
    pub set_difficulty_expected: bool,
    /// True when the pool may push `mining.set_extranonce` mid-session.
    pub may_push_set_extranonce: bool,
}

impl PoolQuirks {
    /// Default for any hostname not explicitly mapped. Biased toward silence
    /// avoidance — empty subscribe params is the only shape all three
    /// observed V1 daemons accept.
    pub const SAFE_DEFAULTS: Self = Self {
        subscribe_params_shape: SubscribeParamsShape::Empty,
        set_difficulty_expected: true,
        may_push_set_extranonce: true,
    };
}

/// Extract the lowercased hostname portion of a stratum URL.
fn hostname_of(pool_url: &str) -> String {
    let stripped = pool_url
        .trim_start_matches("stratum+ssl://")
        .trim_start_matches("stratum+tcp://")
        .trim_start_matches("stratum://")
        .trim_start_matches("tcp://");
    let host_with_port = stripped.split('/').next().unwrap_or(stripped);
    let host = host_with_port
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host_with_port);
    host.to_ascii_lowercase()
}

/// Extract the port from a stratum URL for per-port dialect routing
/// (WoolyPooly runs CFX/ERG/RVN daemons behind one hostname on different
/// ports, each speaking a slightly different dialect).
fn port_of(pool_url: &str) -> Option<u16> {
    let stripped = pool_url
        .trim_start_matches("stratum+ssl://")
        .trim_start_matches("stratum+tcp://")
        .trim_start_matches("stratum://")
        .trim_start_matches("tcp://");
    let host_with_port = stripped.split('/').next().unwrap_or(stripped);
    let (_, port_str) = host_with_port.rsplit_once(':')?;
    port_str.parse().ok()
}

/// Look up the quirks for a given pool URL. Unknown hosts get the safe
/// defaults — never silently degrade because of a missing mapping.
pub fn quirks_for(pool_url: &str) -> PoolQuirks {
    let host = hostname_of(pool_url);
    let port = port_of(pool_url);
    classify_host(&host, port)
}

/// Classification table. Each branch is independent; add a `_ if ... =>`
/// arm + a unit test for a new pool.
fn classify_host(host: &str, port: Option<u16>) -> PoolQuirks {
    // WoolyPooly — split per coin (CFX vs ERG vs RVN) by PORT.
    // 3094 → CFX (Octopus) → WalletWithPass (pool registers worker→wallet
    // binding at SUBSCRIBE time; Empty leaves it unset → shares accepted
    // but never credited on the dashboard — the 2026-05-18 class-B bug).
    // 3100 → ERG (Autolykos2) → Empty. 16060 → RVN → safe default.
    if host.ends_with("woolypooly.com") {
        return match port {
            Some(3094) => PoolQuirks {
                subscribe_params_shape: SubscribeParamsShape::WalletWithPass,
                set_difficulty_expected: true,
                may_push_set_extranonce: true,
            },
            Some(3100) => PoolQuirks {
                subscribe_params_shape: SubscribeParamsShape::Empty,
                set_difficulty_expected: false,
                may_push_set_extranonce: false,
            },
            _ => PoolQuirks {
                subscribe_params_shape: SubscribeParamsShape::Empty,
                set_difficulty_expected: true,
                may_push_set_extranonce: true,
            },
        };
    }

    // HeroMiners — split per coin. CFX uses WalletWithPass (2-element shape
    // with password captured from lolMiner native traffic); ERG uses Empty
    // (verified via direct stratum probe); catch-all Empty. Sits ABOVE the
    // generic Autolykos branch because HeroMiners ERG is verified to accept
    // Empty (not the generic Autolykos default of Agent).
    if host.ends_with(".conflux.herominers.com") || host == "conflux.herominers.com" {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::WalletWithPass,
            set_difficulty_expected: true,
            may_push_set_extranonce: true,
        };
    }
    if host.ends_with(".ergo.herominers.com") || host == "ergo.herominers.com" {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::Empty,
            set_difficulty_expected: false,
            may_push_set_extranonce: false,
        };
    }
    if host.ends_with("herominers.com") {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::Empty,
            set_difficulty_expected: true,
            may_push_set_extranonce: true,
        };
    }

    // Generic Autolykos2 (non-HeroMiners, non-WoolyPooly ERG pools). Target
    // embedded in mining.notify; SRBMiner sends Agent-only subscribe.
    let is_autolykos_pool = host.contains("ergo") || host.starts_with("ergo-");
    if is_autolykos_pool {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::Agent,
            set_difficulty_expected: false,
            may_push_set_extranonce: false,
        };
    }

    // Nanopool — real V1 sessions use AgentExt (EthereumStratum/1.0.0),
    // defensive against the silent-empty-reject failure mode.
    if host.ends_with("nanopool.org") {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::AgentExt,
            set_difficulty_expected: true,
            may_push_set_extranonce: true,
        };
    }

    // NTMiner — AgentExt (same reasoning as Nanopool).
    if host.ends_with("ntminer.vip") {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::AgentExt,
            set_difficulty_expected: true,
            may_push_set_extranonce: true,
        };
    }

    // HashVault — RandomX (subscribe shape N/A; login is used instead).
    if host.ends_with("hashvault.pro") {
        return PoolQuirks {
            subscribe_params_shape: SubscribeParamsShape::Empty,
            set_difficulty_expected: true,
            may_push_set_extranonce: true,
        };
    }

    PoolQuirks::SAFE_DEFAULTS
}

/* ══════ Handshake frame builders ════════════════════════════════════ */

/// Build a Stratum V1 `mining.subscribe` frame with an explicit params-array
/// shape (driven by `quirks_for`). `wallet` is consumed by AgentWallet /
/// WalletOnly / WalletWithPass; `pass` only by WalletWithPass. Includes
/// `jsonrpc:"2.0"` to match SRBMiner-MULTI's native frame (Fix K, 2026-05-18).
pub fn build_v1_subscribe_with_shape(
    id: u64,
    agent: &str,
    wallet: &str,
    pass: &str,
    shape: SubscribeParamsShape,
) -> Value {
    let params = match shape {
        SubscribeParamsShape::Empty => serde_json::json!([]),
        SubscribeParamsShape::Agent => serde_json::json!([agent]),
        SubscribeParamsShape::AgentExt => serde_json::json!([agent, "EthereumStratum/1.0.0"]),
        SubscribeParamsShape::AgentWallet => serde_json::json!([agent, wallet]),
        SubscribeParamsShape::WalletOnly => serde_json::json!([wallet]),
        SubscribeParamsShape::WalletWithPass => serde_json::json!([wallet, pass]),
    };
    serde_json::json!({
        "id": id,
        "jsonrpc": "2.0",
        "method": "mining.subscribe",
        "params": params,
    })
}

/// Build a Stratum V1 `mining.authorize` frame.
pub fn build_v1_authorize(id: u64, wallet: &str, worker: &str, pass: &str) -> Value {
    let user = if worker.is_empty() {
        wallet.to_string()
    } else {
        format!("{}.{}", wallet, worker)
    };
    serde_json::json!({
        "id": id,
        "jsonrpc": "2.0",
        "method": "mining.authorize",
        "params": [user, pass],
    })
}

/// Build a RandomX `login` frame (xmrig dialect: subscribe + authorize in one).
pub fn build_randomx_login(
    id: u64,
    wallet: &str,
    worker: &str,
    pass: &str,
    agent: &str,
    algos: &[&str],
) -> Value {
    let user = if worker.is_empty() {
        wallet.to_string()
    } else {
        format!("{}.{}", wallet, worker)
    };
    serde_json::json!({
        "id": id,
        "jsonrpc": "2.0",
        "method": "login",
        "params": { "login": user, "pass": pass, "agent": agent, "algo": algos }
    })
}

/* ══════ Tests — validate the dialect corpus ═════════════════════════ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_strips_scheme_and_port() {
        assert_eq!(hostname_of("stratum+ssl://pool.hashvault.pro:443"), "pool.hashvault.pro");
        assert_eq!(hostname_of("stratum+tcp://de.conflux.herominers.com:1170"), "de.conflux.herominers.com");
        assert_eq!(hostname_of("stratum://example.com:3333"), "example.com");
        assert_eq!(hostname_of("tcp://example.com:3333"), "example.com");
        assert_eq!(hostname_of("pool.example.com:3333"), "pool.example.com");
        assert_eq!(hostname_of("POOL.EXAMPLE.COM:3333"), "pool.example.com");
    }

    #[test]
    fn unknown_host_gets_safe_defaults() {
        let q = quirks_for("stratum+tcp://pool.nonexistent.example:1234");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Empty);
        assert!(q.set_difficulty_expected);
        assert!(q.may_push_set_extranonce);
    }

    #[test]
    fn port_of_extracts_port_correctly() {
        assert_eq!(port_of("stratum+tcp://pool.woolypooly.com:3094"), Some(3094));
        assert_eq!(port_of("stratum+ssl://pool.woolypooly.com:16060"), Some(16060));
        assert_eq!(port_of("stratum+tcp://example.com"), None);
    }

    #[test]
    fn woolypooly_cfx_3094_uses_wallet_with_pass() {
        let q = quirks_for("stratum+tcp://pool.woolypooly.com:3094");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::WalletWithPass);
        assert!(q.set_difficulty_expected);
    }

    #[test]
    fn woolypooly_erg_3100_stays_empty() {
        let q = quirks_for("stratum+tcp://pool.woolypooly.com:3100");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Empty);
        assert!(!q.set_difficulty_expected);
        assert!(!q.may_push_set_extranonce);
    }

    #[test]
    fn woolypooly_rvn_16060_falls_through_to_default() {
        let q = quirks_for("stratum+ssl://pool.woolypooly.com:16060");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Empty);
        assert!(q.set_difficulty_expected);
    }

    #[test]
    fn herominers_octopus_uses_wallet_with_pass_shape() {
        let q = quirks_for("stratum+tcp://de.conflux.herominers.com:1170");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::WalletWithPass);
        assert!(q.set_difficulty_expected);
    }

    #[test]
    fn herominers_ergo_uses_empty_subscribe_with_autolykos_quirks() {
        let q = quirks_for("stratum+tcp://de.ergo.herominers.com:1180");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Empty);
        assert!(!q.set_difficulty_expected);
        assert!(!q.may_push_set_extranonce);
    }

    #[test]
    fn herominers_kawpow_uses_empty_shape_catchall() {
        let q = quirks_for("stratum+tcp://de.ravencoin.herominers.com:1140");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Empty);
        assert!(q.set_difficulty_expected);
    }

    #[test]
    fn nanopool_cfx_uses_agent_ext() {
        let q = quirks_for("stratum+tcp://cfx-eu1.nanopool.org:10500");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::AgentExt);
    }

    #[test]
    fn nanopool_ergo_uses_autolykos_quirks() {
        let q = quirks_for("stratum+tcp://ergo-eu1.nanopool.org:11111");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Agent);
        assert!(!q.set_difficulty_expected);
    }

    #[test]
    fn ntminer_cfx_uses_agent_ext() {
        let q = quirks_for("stratum+ssl://cfx.ntminer.vip:25050");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::AgentExt);
    }

    #[test]
    fn hashvault_xmr_safe() {
        let q = quirks_for("stratum+ssl://pool.hashvault.pro:443");
        assert_eq!(q.subscribe_params_shape, SubscribeParamsShape::Empty);
    }

    #[test]
    fn v1_subscribe_includes_jsonrpc_for_all_shapes() {
        for shape in [
            SubscribeParamsShape::Empty,
            SubscribeParamsShape::Agent,
            SubscribeParamsShape::AgentExt,
            SubscribeParamsShape::AgentWallet,
            SubscribeParamsShape::WalletOnly,
            SubscribeParamsShape::WalletWithPass,
        ] {
            let v = build_v1_subscribe_with_shape(1, "SRBMiner-MULTI/3.1.8", "wallet.worker", "x", shape);
            assert_eq!(v["jsonrpc"], "2.0", "shape {:?} missing jsonrpc", shape);
        }
    }

    #[test]
    fn v1_authorize_format() {
        let v = build_v1_authorize(2, "RTg", "rig", "x");
        assert_eq!(v["method"], "mining.authorize");
        assert_eq!(v["params"][0], "RTg.rig");
        assert_eq!(v["params"][1], "x");
    }

    #[test]
    fn randomx_login_format() {
        let v = build_randomx_login(1, "addr", "rig", "x", "pwnda/1.0", &["rx/0"]);
        assert_eq!(v["method"], "login");
        assert_eq!(v["params"]["login"], "addr.rig");
        assert_eq!(v["params"]["agent"], "pwnda/1.0");
    }
}
