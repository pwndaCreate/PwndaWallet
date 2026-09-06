//! The rung-3 arm gate: the ONLY path that installs the real (vendored) engine.
//!
//! # Why this is a gate, not a config read
//!
//! Installing the vendored engine turns the desk from "quote/accept for real,
//! but placeholder crypto that cannot lock a coin" into "can move funds". That
//! transition must be **impossible to reach by accident and impossible to reach
//! in a shipped build**, and a partial/incomplete arm must fail LOUD rather than
//! look armed while inert. So arming is an AND of independent gates:
//!
//! 1. an explicit operator opt-in (`PWNDA_DESK_ARM`),
//! 2. a debug build (`cfg!(debug_assertions)`) — a shipped MSI can never arm,
//! 3. a **testnet-only** preset — mainnet is rejected at this rung by construction,
//! 4. a complete, valid config.
//!
//! If `PWNDA_DESK_ARM` is set but any later gate fails, that is a **fault**, not a
//! silent fall-back: we log `DESK-ARM-FAULT:`, install nothing (stay on Mock),
//! and never take the wallet down. The two failure modes we refuse to choose
//! between are "crash the wallet" and "look armed while the engine is Mock" — so
//! we do neither: the engine stays uninstalled, loudly.
//!
//! The gate DECISION ([`evaluate_arm`]) is a pure function so it can be tested
//! for every case; the install itself is downstream of a `Proceed`.

#![allow(dead_code)] // wired from lib.rs setup

use std::sync::OnceLock;

use super::crypto::{self, install_vendored};
use super::sidecar::{EngineSidecar, SidecarConfig};

const ENV_ARM: &str = "PWNDA_DESK_ARM";
const ENV_PYTHON: &str = "PWNDA_ENGINE_PYTHON";
const ENV_DIR: &str = "PWNDA_ENGINE_DIR";
const ENV_PRESET: &str = "ADA_ENGINE_ENV";
const ENV_BLOCKFROST: &str = "BLOCKFROST_PROJECT_ID";
const ENV_XMR_RPC: &str = "XMR_WALLET_RPC";
/// C39 / M7a. The WATCH wallet-rpc, split from the SPEND one by PURPOSE.
///
/// A chain-B watch re-points its rpc at a per-swap VIEW-ONLY joint wallet so it
/// can see the counterparty's lock. That is harmless with one swap in flight and
/// a hard blocker for two: a SELL's watch re-points the rpc while a concurrent
/// BUY needs the RESERVE open to sign, and `lock_xmr` correctly refuses a wallet
/// that cannot sign — turning a wrong-wallet SPEND into a refusal, which is the
/// right trade and also means the BUY stalls.
///
/// **Optional on purpose.** `desk_engine.py::watch_wallet_url` falls back to the
/// spend URL when unset, so a single-rpc deployment behaves exactly as it does
/// today and nothing has to be provisioned before it is wanted.
const ENV_XMR_WATCH_RPC: &str = "XMR_WATCH_WALLET_RPC";
const ENV_STATE_KEY: &str = "ADA_ENGINE_STATE_KEY";
const ENV_FUNDING_SKEY: &str = "ADA_FUNDING_SKEY_HEX"; // optional (BUY leg only)

/// The preset the engine was armed against, set once on a successful install.
/// Read by [`arm_status`] so the UI can show WHAT it is armed for, not just that
/// it is.
static ARMED_PRESET: OnceLock<String> = OnceLock::new();

/// What the gate decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArmDecision {
    /// `PWNDA_DESK_ARM` is not set. The normal state; not a fault. Stay on Mock.
    Skip,
    /// Armed, but a gate failed. LOUD, never silent — carries the reason.
    Fault(String),
    /// All gates pass. Carries the config the engine will be installed with.
    Proceed(ArmParams),
}

/// The validated config for a `Proceed`. Not `Debug`-printed with the secrets in
/// production paths — the funding key and state key are secrets.
#[derive(Clone, PartialEq, Eq)]
pub struct ArmParams {
    pub python: String,
    pub engine_dir: String,
    pub preset: String,
    pub blockfrost_project_id: String,
    pub xmr_wallet_rpc: String,
    /// C39: the WATCH connection, when provisioned. `None` means the engine uses
    /// the spend URL for both — today's behaviour, and correct for one swap.
    pub xmr_watch_wallet_rpc: Option<String>,
    pub state_key: String,
    pub funding_skey_hex: Option<String>,
}

impl std::fmt::Debug for ArmParams {
    /// Redacts the secrets; only the shape is loggable.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArmParams")
            .field("preset", &self.preset)
            .field("engine_dir", &self.engine_dir)
            .field("has_funding_key", &self.funding_skey_hex.is_some())
            .finish_non_exhaustive()
    }
}

/// True for a preset that touches mainnet value. Rejected at this rung.
/// C41 / desk D39: `contains`, not `ends_with`.
///
/// This is a REFUSAL gate, and the two failure directions are not comparable.
/// Over-refusing a preset that merely looks mainnet-ish costs an operator one
/// rename. Under-refusing arms a funded desk against real money. So the guard is
/// deliberately over-broad.
///
/// `ends_with` caught `mainnet` and `zeph-mainnet` — which is every preset that
/// exists today, and is exactly why the test could not see the hole. A composite
/// name with the word anywhere but the end (`mainnet-fork`, `xmr-mainnet-eu`)
/// walked straight through it.
///
/// It was saved by accident rather than by design: `SidecarConfig::new`
/// validates against `KNOWN_ENV_PRESETS` afterwards and would have rejected such
/// a name as unknown. But that is a DIFFERENT check catching it for a DIFFERENT
/// reason, and it stops catching it the moment the whitelist gains a composite
/// entry. A gate that only works because a later gate exists is not a gate.
///
/// The counterparty hit this shape as D39 and relayed it as directly checkable
/// on our side. It was.
fn is_mainnet_preset(preset: &str) -> bool {
    preset.to_ascii_lowercase().contains("mainnet")
}

/// The pure gate. `get` looks up an env var; `is_debug` is `cfg!(debug_assertions)`
/// at the call site. Testable for every branch without touching the process env
/// or a real engine.
pub fn evaluate_arm(get: impl Fn(&str) -> Option<String>, is_debug: bool) -> ArmDecision {
    let nonempty = |k: &str| get(k).filter(|v| !v.trim().is_empty());

    // Gate 1: explicit opt-in. Absent -> Skip (the normal case), never a fault.
    if nonempty(ENV_ARM).is_none() {
        return ArmDecision::Skip;
    }
    // From here we are ARMED: every problem is a loud fault, not a silent skip.
    let fault = |msg: String| ArmDecision::Fault(msg);

    // Gate 2: never in a shipped build.
    if !is_debug {
        return fault(format!(
            "{ENV_ARM} is set but this is a RELEASE build. The funded desk is testnet-only and \
             must never arm in a shipped binary. Refusing."
        ));
    }

    // Gate 4a: required config present.
    let required = [
        (ENV_PYTHON, "the engine interpreter"),
        (ENV_DIR, "the engine directory"),
        (ENV_PRESET, "the ADA_ENGINE_ENV preset"),
        (ENV_BLOCKFROST, "the Blockfrost project id"),
        (ENV_XMR_RPC, "the loopback XMR wallet-rpc"),
        (ENV_STATE_KEY, "the engine state key"),
    ];
    for (key, what) in required {
        if nonempty(key).is_none() {
            return fault(format!(
                "{ENV_ARM} is set but {key} ({what}) is not. Source client-testnet.env.sh before \
                 launching. Refusing to arm on an incomplete config."
            ));
        }
    }
    let preset = nonempty(ENV_PRESET).expect("checked above");

    // Gate 3: testnet only.
    if is_mainnet_preset(&preset) {
        return fault(format!(
            "{ENV_ARM} is set with a MAINNET preset ({preset:?}). Mainnet is rejected at this rung \
             by construction - it is the whole M7/M8 track, not a preset flip. Refusing."
        ));
    }

    ArmDecision::Proceed(ArmParams {
        python: nonempty(ENV_PYTHON).expect("checked"),
        engine_dir: nonempty(ENV_DIR).expect("checked"),
        preset,
        blockfrost_project_id: nonempty(ENV_BLOCKFROST).expect("checked"),
        xmr_wallet_rpc: nonempty(ENV_XMR_RPC).expect("checked"),
        // C39: optional. Not in the `required` list above, deliberately — an
        // operator who has not provisioned a second rpc must still be able to
        // arm, and gets exactly today's behaviour.
        xmr_watch_wallet_rpc: nonempty(ENV_XMR_WATCH_RPC),
        state_key: nonempty(ENV_STATE_KEY).expect("checked"),
        // Optional: SELL_FOLLOWER never locks ADA, so the funding key is not
        // required to arm - passed through only if the operator set it.
        funding_skey_hex: nonempty(ENV_FUNDING_SKEY),
    })
}

/// Build the `SidecarConfig` from validated params. Secrets go into the config's
/// `extra_env` (no `Debug`) and never touch a log line.
fn build_config(p: &ArmParams, data_dir: std::path::PathBuf) -> Result<SidecarConfig, String> {
    let mut cfg = SidecarConfig::new(&p.python, &p.engine_dir, &p.preset)
        .map_err(|e| format!("{e}"))?
        .with_data_dir(data_dir.display().to_string())
        .with_env(ENV_STATE_KEY, &p.state_key)
        .map_err(|e| format!("{e}"))?
        .with_env(ENV_XMR_RPC, &p.xmr_wallet_rpc) // loopback re-checked here
        .map_err(|e| format!("{e}"))?
        .with_env(ENV_BLOCKFROST, &p.blockfrost_project_id)
        .map_err(|e| format!("{e}"))?;
    // C39: goes through the same `with_env`, so the watch URL gets the identical
    // loopback re-check as the spend URL. A watch connection cannot move a coin,
    // but it does carry the joint VIEW key, and that is not something to POST off
    // the machine either.
    if let Some(watch) = &p.xmr_watch_wallet_rpc {
        cfg = cfg
            .with_env(ENV_XMR_WATCH_RPC, watch)
            .map_err(|e| format!("{e}"))?;
    }
    if let Some(skey) = &p.funding_skey_hex {
        cfg = cfg.with_env(ENV_FUNDING_SKEY, skey).map_err(|e| format!("{e}"))?;
    }
    Ok(cfg)
}

/// Real entry point: evaluate the process env, and on `Proceed` install the
/// vendored engine into `data_dir`. Called once from `lib.rs::setup`, BEFORE
/// `rehydrate::start`, so a restart mid-swap rehydrates its watchers against a
/// real engine.
///
/// Never returns an error and never panics: a swap-desk arm problem must not
/// block the wallet from launching. Every non-proceed path logs and returns.
pub fn install_from_env(data_dir: std::path::PathBuf) {
    match evaluate_arm(|k| std::env::var(k).ok(), cfg!(debug_assertions)) {
        ArmDecision::Skip => {} // normal: not armed, stay on Mock, say nothing.
        ArmDecision::Fault(reason) => {
            eprintln!("DESK-ARM-FAULT: {reason}");
        }
        ArmDecision::Proceed(params) => {
            let preset = params.preset.clone();
            let cfg = match build_config(&params, data_dir) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("DESK-ARM-FAULT: config rejected before install: {e}");
                    return;
                }
            };
            match install_vendored(EngineSidecar::new(cfg)) {
                Ok(()) => {
                    let _ = ARMED_PRESET.set(preset.clone());
                    eprintln!(
                        "[desk::arm] vendored engine INSTALLED for preset {preset:?} (testnet). \
                         The desk can now move testnet funds - drive deliberately."
                    );
                    // Ping-on-arm (desk-endorsed): verify the sidecar actually
                    // spawns and answers NOW, so a config fault surfaces at startup
                    // rather than on the first funds-moving call.
                    ping_after_arm(preset);
                }
                Err(e) => {
                    // Already installed, or a seam error. Loud - a failed install
                    // must not look like a success.
                    eprintln!("DESK-ARM-FAULT: install_vendored refused: {e}");
                }
            }
        }
    }
}

/// Spawn a one-shot liveness ping of the freshly-installed engine. Logs
/// `DESK-ARM-PING-OK` on success and `DESK-ARM-PING-FAULT` on failure. A fault
/// here does NOT un-install — the conductor's first call (M3, before any lock)
/// fails closed regardless — it is an early warning so the operator learns of a
/// bad config at startup rather than at proceed-time.
fn ping_after_arm(preset: String) {
    let crypto::ActiveCrypto::Vendored(v) = crypto::active_crypto() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        match v.ping().await {
            Ok(env) => eprintln!(
                "DESK-ARM-PING-OK: the armed engine answered (env={env:?}, preset={preset:?})"
            ),
            Err(e) => eprintln!(
                "DESK-ARM-PING-FAULT: the armed engine did not answer a ping ({e}). The install \
                 stands, but the first funded call will fail until this is fixed - check the \
                 interpreter, the engine dir, and the testnet config."
            ),
        }
    });
}

/// Synchronous setup-time entry. Resolves the engine data dir under app-data and
/// arms if the env says to. **Must run before `rehydrate::start`** and must be
/// synchronous (not spawned), so a rehydrated swap sees the real engine rather
/// than racing an async install.
pub fn arm_at_setup(app: &tauri::AppHandle) {
    use tauri::Manager;
    match app.path().app_local_data_dir() {
        Ok(d) => install_from_env(d.join("desk-engine")),
        Err(e) => eprintln!("[desk::arm] cannot resolve app data dir ({e}); not arming"),
    }
}

/// What the UI needs to present the desk's true arm state - so it can show "live"
/// only when the engine is actually installed, closing the
/// `VITE_DESK_LIVE=true` + Mock-engine footgun.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmStatus {
    /// The real engine is installed and this build can move testnet funds.
    pub engine_installed: bool,
    /// The preset it was armed for, if installed.
    pub preset: Option<String>,
}

pub fn arm_status() -> ArmStatus {
    ArmStatus {
        engine_installed: crypto::crypto_is_production_ready(),
        preset: ARMED_PRESET.get().cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| m.get(k).cloned()
    }

    /// A complete, valid testnet arm config.
    fn complete() -> Vec<(&'static str, &'static str)> {
        vec![
            (ENV_ARM, "preprod-stagenet"),
            (ENV_PYTHON, "C:/py/python.exe"),
            (ENV_DIR, "/engine"),
            (ENV_PRESET, "preprod"),
            (ENV_BLOCKFROST, "preprodXXXX"),
            (ENV_XMR_RPC, "http://127.0.0.1:38088/json_rpc"),
            (ENV_STATE_KEY, "22"),
        ]
    }

    #[test]
    fn unarmed_is_skip_not_fault() {
        assert_eq!(evaluate_arm(env(&[]), true), ArmDecision::Skip);
    }

    #[test]
    fn a_complete_config_proceeds() {
        match evaluate_arm(env(&complete()), true) {
            ArmDecision::Proceed(p) => {
                assert_eq!(p.preset, "preprod");
                assert!(p.funding_skey_hex.is_none()); // optional, absent here
            }
            other => panic!("expected Proceed, got {other:?}"),
        }
    }

    #[test]
    fn armed_in_a_release_build_is_a_fault() {
        match evaluate_arm(env(&complete()), false) {
            ArmDecision::Fault(m) => assert!(m.contains("RELEASE build"), "{m}"),
            other => panic!("a release build must never arm: {other:?}"),
        }
    }

    #[test]
    fn a_mainnet_preset_is_rejected_at_this_rung() {
        let mut c = complete();
        // ADA_ENGINE_ENV is the 4th entry.
        c[3] = (ENV_PRESET, "mainnet");
        match evaluate_arm(env(&c), true) {
            ArmDecision::Fault(m) => assert!(m.contains("MAINNET"), "{m}"),
            other => panic!("mainnet must be rejected: {other:?}"),
        }
        c[3] = (ENV_PRESET, "zeph-mainnet");
        assert!(matches!(evaluate_arm(env(&c), true), ArmDecision::Fault(_)));

        // C41 / desk D39. Both cases above END with "mainnet", which is every
        // preset that exists today — so the old `ends_with` guard passed this
        // test while a composite name walked straight through it. These are the
        // cases that were invisible.
        for composite in [
            "mainnet-fork",
            "xmr-mainnet-eu",
            "MAINNET",
            "preprod-mainnet-mirror",
        ] {
            c[3] = (ENV_PRESET, composite);
            assert!(
                matches!(evaluate_arm(env(&c), true), ArmDecision::Fault(_)),
                "{composite:?} must be refused: this is a REFUSAL gate, so over-refusing costs a \
                 rename and under-refusing arms a funded desk against real money"
            );
        }

        // And the gate must still let the testnet presets through, or it has
        // simply stopped being a gate and started being a wall.
        for ok in ["preprod", "preview", "dev", "zeph-preprod", "zeph-dev"] {
            c[3] = (ENV_PRESET, ok);
            assert!(
                !matches!(evaluate_arm(env(&c), true), ArmDecision::Fault(m) if m.contains("MAINNET")),
                "{ok:?} is a testnet preset and must not be refused as mainnet"
            );
        }
    }

    #[test]
    fn armed_but_incomplete_is_a_loud_fault_not_a_silent_skip() {
        // Drop the Blockfrost id.
        let c: Vec<_> = complete()
            .into_iter()
            .filter(|(k, _)| *k != ENV_BLOCKFROST)
            .collect();
        match evaluate_arm(env(&c), true) {
            ArmDecision::Fault(m) => {
                assert!(m.contains(ENV_BLOCKFROST), "names the missing var: {m}");
                assert!(m.contains("incomplete"), "{m}");
            }
            // The one thing it must never be: Skip. Armed-but-incomplete that
            // silently skipped would look unarmed while the operator believed
            // otherwise.
            other => panic!("armed+incomplete must FAULT, not {other:?}"),
        }
    }

    #[test]
    fn the_funding_key_is_optional_and_passes_through_when_present() {
        let mut c = complete();
        c.push((ENV_FUNDING_SKEY, "deadbeef"));
        match evaluate_arm(env(&c), true) {
            ArmDecision::Proceed(p) => assert_eq!(p.funding_skey_hex.as_deref(), Some("deadbeef")),
            other => panic!("{other:?}"),
        }
    }

    /// ArmParams must not leak the funding key through Debug.
    #[test]
    fn arm_params_debug_redacts_secrets() {
        let p = ArmParams {
            python: "py".into(),
            engine_dir: "/e".into(),
            preset: "preprod".into(),
            blockfrost_project_id: "bfSECRET".into(),
            xmr_wallet_rpc: "http://127.0.0.1:38088/json_rpc".into(),
            xmr_watch_wallet_rpc: Some("http://127.0.0.1:38089/json_rpc".into()),
            state_key: "STATESECRET".into(),
            funding_skey_hex: Some("KEYSECRET".into()),
        };
        let dbg = format!("{p:?}");
        assert!(!dbg.contains("KEYSECRET"), "funding key leaked: {dbg}");
        assert!(!dbg.contains("STATESECRET"), "state key leaked: {dbg}");
        assert!(dbg.contains("preprod"), "preset should show: {dbg}");
    }
}
