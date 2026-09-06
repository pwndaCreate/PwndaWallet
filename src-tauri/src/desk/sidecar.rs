//! The engine sidecar transport: line-delimited JSON over a child's stdio.
//!
//! # What this is
//!
//! The vendored ADA<>XMR/ZEPH crypto ([[swap-desk-engine]]) is a Python program
//! (`desk_helper.py`) we run as a long-lived child and drive over **line-
//! delimited JSON on stdin/stdout** — one request object per line, one response
//! per line. This module is the Rust half of that pipe. It is the analog of the
//! desk's own Go driver (`pwnda-engine-handoff/reference/bridge.go`); the two
//! sides run the SAME helper with mirrored roles, which is what keeps them in
//! byte agreement (the whole point of "lift verbatim" — no crypto is
//! reimplemented here).
//!
//! ```text
//! request  {"id":N,"method":"...","params":{...}}
//! response {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":"<Type>: <msg>"}
//! ```
//!
//! # Why a serialized round-trip and not an async correlation map
//!
//! The helper processes exactly one request per line and blocks until it has
//! written the response, so a single in-flight call at a time is the protocol's
//! own model (see `bridge.go`'s mutex). We mirror that with one async `Mutex`
//! over the pipe: `call` locks, writes a line, reads a line. `id` still travels
//! and is asserted on every response — not to correlate concurrent calls (there
//! are none) but to catch a desynced pipe immediately rather than reading a
//! stale frame as the answer to the wrong request.
//!
//! # The invariants this transport is required to enforce
//!
//! These came out of the client's own review of the engine and are the reason
//! the transport is more than a JSON pipe:
//!
//! - **`ADA_ENGINE_ENV` is REQUIRED, no default.** A forgotten variable must
//!   never silently pick a network. [`SidecarConfig::new`] takes it by value.
//! - **A startup config fault is PERMANENT.** A bad config (missing env, a
//!   non-loopback `XMR_WALLET_RPC`, a non-dev preset on a non-extractable
//!   backend, a bad state key) makes the helper print `ENGINE-CONFIG-FAULT:` on
//!   stderr and exit **78** (`EX_CONFIG`) BEFORE the request loop. We surface
//!   that as [`SidecarError::ConfigFault`], which the supervisor must treat as
//!   "fix the config", NOT as a restartable crash.
//! - **`ok:false` is NEVER retried.** It is a caller/theft-class rejection (a
//!   torsion point at `ingest_counterparty`, a pre-sig that does not bind). A
//!   retry loop that is correct for a dead process is catastrophic here, so it
//!   gets its own variant, [`SidecarError::EngineRejected`], distinct from
//!   [`SidecarError::SidecarDied`].
//! - **PID-only teardown.** We kill the exact child by pid
//!   ([`crate::platform::kill_pid_force`]) — never by image name, which would
//!   also kill the user's unrelated Python processes.
//! - **No `-O`, no `pythonw`.** `-O` strips the fresh-pre-sig `assert` in
//!   `swap.py`; `pythonw` has no usable stdio. We control the argv (we never add
//!   `-O`) and reject a `pythonw` interpreter in [`SidecarConfig::new`].
//! - **Loopback-only `XMR_WALLET_RPC`.** The joint spend key is POSTed there in
//!   the clear; the engine refuses a non-loopback URL and so do we, before spawn
//!   (defense in depth).

#![allow(dead_code)] // the transport is wired to the DeskCrypto seam in a later unit

use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// The exit code the helper uses for a startup config fault (`EX_CONFIG` from
/// `sysexits.h`). Distinct from any mid-run crash code.
const EX_CONFIG: i32 = 78;

/// The env presets `config.py` accepts. We validate against this list at config
/// construction so a TYPO in the preset is a pre-spawn `BadConfig`, not a
/// process failure.
///
/// Originally (client v5 review) this closed a real hole: a MISSING
/// `ADA_ENGINE_ENV` faulted cleanly (exit 78 + `ENGINE-CONFIG-FAULT:`), but an
/// INVALID one (`ADA_ENGINE_ENV=preprodd`) exited **1** with no prefix — which
/// the transport reads as a restartable crash and would loop into forever.
/// **Engine v6 fixed that** (2026-07-21): an invalid preset now also exits 78
/// with the prefix (`SystemExit: unknown env ...`), which `classify_death` maps
/// to a sticky `ConfigFault`. So this guard is now BELT-AND-SUSPENDERS — it fails
/// a typo BEFORE spawn with a cleaner error, rather than being the sole defense.
/// Trade-off: the list must track `config.py`, so a preset the desk adds but we
/// do not yet know is refused here. Kept because a pre-spawn reject is tidier
/// than a spawned-then-faulted one; relaxable to engine-as-authority now that v6
/// signals invalid presets correctly.
const KNOWN_ENV_PRESETS: &[&str] = &[
    "dev",
    "preview",
    "preprod",
    "mainnet",
    "zeph-dev",
    "zeph-preprod",
    "zeph-mainnet",
];

/// CC-16: which leg's engine a sidecar drives.
///
/// The spawn machinery is already engine-agnostic — [`SidecarConfig`] has taken
/// `python` and `engine_dir` from the start — so this discriminates the ENV
/// BLOCK and nothing else. `Ada` is the default and every pre-CC-16 call site
/// keeps its exact behaviour.
///
/// The two legs name their network with different variables and different
/// vocabularies, and neither accepts the other's: `preprod` is meaningless to
/// the LTC engine and `regtest` is meaningless to the ADA one. Carrying the leg
/// explicitly is what lets the pre-spawn refusal stay as strict for both.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Leg {
    /// ADA <-> XMR/ZEPH — `pwnda-engine-handoff/engine/`.
    Ada,
    /// LTC <-> XMR/ZEPH — `pwnda-engine-handoff/engine-ltc/`, a SEPARATE venv
    /// (its coincurve is a source build; see CC-16b).
    Ltc,
}

impl Leg {
    /// The env var this leg names its own chain-A network with.
    fn network_var(self) -> &'static str {
        match self {
            Leg::Ada => "ADA_ENGINE_ENV",
            Leg::Ltc => "LTC_ENGINE_NETWORK",
        }
    }

    /// The networks this leg's engine accepts. ADA's mirror `config.py`'s
    /// presets; LTC's mirror `chainparams_ltc.py::LTC_NETWORKS`.
    fn known_networks(self) -> &'static [&'static str] {
        match self {
            Leg::Ada => KNOWN_ENV_PRESETS,
            Leg::Ltc => KNOWN_LTC_NETWORKS,
        }
    }

    /// The env var for this leg's per-swap checkpoint directory.
    fn data_dir_var(self) -> &'static str {
        match self {
            Leg::Ada => "ADA_ENGINE_DATA_DIR",
            Leg::Ltc => "LTC_ENGINE_DATA_DIR",
        }
    }
}

/// The networks `engine-ltc` accepts, mirroring `chainparams_ltc.py:184`
/// (`LTC_NETWORKS`). Litecoin has **no `testnet4`** — that is Bitcoin Core 28
/// vocabulary, and a desk provisioning script died on its own network name over
/// it. Validating here means the same typo is refused before a child exists.
const KNOWN_LTC_NETWORKS: &[&str] = &["mainnet", "testnet", "regtest"];

/// CC-15 (desk Z31-1 / A31-3): the chain-B network, NAMED rather than left to a
/// raw address-prefix integer, and DERIVED from `ADA_ENGINE_ENV` rather than set
/// beside it.
///
/// ## The check that was not running
///
/// We set no `XMR_ADDRESS_PREFIX` anywhere in this tree, so the engine formed no
/// chain-B joint ADDRESS at all and answered `chainBJointAddrAbsent` with its
/// reason. Nothing was broken by that — but the M2 cross-check could then only
/// compare the joint KEY (derivable with no network knowledge) and never the
/// address. A cross-check that silently drops half its comparison is this
/// campaign's most-repeated shape, and it is why this is worth one env var.
///
/// ## Why derived and not configured
///
/// Two variables naming one fact is the D5/D7/D48 family: they agree until the
/// day they do not, and the disagreement surfaces as a signature or address
/// mismatch wearing a protocol fault's clothes. The preset already names the
/// network; this is a projection of it, so there is no second place to get wrong.
///
/// Returns `Err` for a preset with no mapping rather than guessing — and
/// `every_known_preset_maps_to_a_chain_b_network_cc15` enumerates
/// [`KNOWN_ENV_PRESETS`] so adding a preset without a mapping goes red here
/// rather than at a swap.
fn chain_b_network_for(env_preset: &str) -> Result<&'static str, SidecarError> {
    Ok(match env_preset {
        // Cardano preprod/preview pair with Monero STAGENET (addresses begin `5`).
        "preprod" | "preview" => "xmr-stagenet",
        // `dev` is the local devnet, and Monero REGTEST runs as the mainnet
        // nettype — its addresses begin `4`, exactly like real mainnet. That is
        // the trap: the safe-looking name and the dangerous-looking prefix belong
        // to the same network, so the mapping is written out rather than inferred.
        "dev" => "xmr-mainnet",
        "mainnet" => "xmr-mainnet",
        // Every Zephyr preset maps to `zeph-mainnet`: ZEPH addresses begin
        // `ZEPHYR` on every network the desk runs, so there is no prefix
        // distinction to carry (desk v80 CC-15b).
        "zeph-dev" | "zeph-preprod" | "zeph-mainnet" => "zeph-mainnet",
        other => {
            return Err(SidecarError::BadConfig(format!(
                "no CHAIN_B_NETWORK mapping for ADA_ENGINE_ENV {other:?}. Add one to \
                 chain_b_network_for rather than letting the engine fall back to no chain-B \
                 address — an absent address silently disables the M2 address cross-check"
            )))
        }
    })
}

/// CC-16: the same projection for the LTC leg, whose chain B is also XMR/ZEPH
/// (`engine-ltc` reads `CHAIN_B_NETWORK` at `desk_helper.py:681` and says so at
/// `ltc_swap.py:865` — "cannot say whether its chain B is XMR or ZEPH").
///
/// **The desk specified the ADA mapping in v80 CC-15b and did not specify this
/// one**, so it is written by analogy and flagged to them rather than assumed
/// silently. A disagreement is not silent — it is exactly what CC-15 makes the
/// M2 address cross-check able to catch — but it would abort a drive, so it is
/// worth one line of confirmation before an LTC swap runs.
fn chain_b_network_for_ltc(ltc_network: &str) -> Result<&'static str, SidecarError> {
    Ok(match ltc_network {
        "mainnet" => "xmr-mainnet",
        // LTC testnet pairs with Monero STAGENET, the same pairing ADA preprod
        // gets — the test networks both sides actually hold coins on.
        "testnet" => "xmr-stagenet",
        // Same trap as ADA `dev`: Monero regtest runs as the MAINNET nettype, so
        // its addresses begin `4` exactly like real mainnet.
        "regtest" => "xmr-mainnet",
        other => {
            return Err(SidecarError::BadConfig(format!(
                "no CHAIN_B_NETWORK mapping for LTC_ENGINE_NETWORK {other:?}"
            )))
        }
    })
}

/// The `XMR_WALLET_RPC` used by tests that never touch Monero.
///
/// Required since engine v12 (D5), so it has to be SOMETHING — and the whole
/// point of D5 is that the something matters. The engine's old default was
/// `http://127.0.0.1:18083/json_rpc`, which on the desk host was a **live
/// mainnet wallet**, and it sailed through the loopback guard because
/// `127.0.0.1` is loopback. These tests run the `dev` preset, whose
/// `address_prefix` is 18 — the same as mainnet — so a wrong wallet there would
/// have transfers ACCEPTED rather than rejected.
///
/// So this deliberately names **no real resource**: port 1 on loopback, which
/// nothing binds. It satisfies the requirement and the loopback guard while any
/// actual connection attempt fails immediately. Not the stagenet port either —
/// an offline test has no business being able to reach even our own wallet.
///
/// The rule it follows, from the desk's D5 write-up: *a default that names a
/// real resource is a guess about whose funds to spend, and there is no safe
/// guess.*
const OFFLINE_TEST_WALLET_RPC: &str = "http://127.0.0.1:1/json_rpc";

/// Prefix the helper writes to stderr on a config fault, before exit 78.
const CONFIG_FAULT_PREFIX: &str = "ENGINE-CONFIG-FAULT:";

/// Default per-call read timeout. The offline handshake methods return in
/// milliseconds; live chain methods pass their own longer bound via
/// [`EngineSidecar::call_with_timeout`].
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for the child to be reaped after the pipe closes, so
/// [`EngineSidecar`] can read its exit code to classify a config fault vs a
/// crash.
const REAP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    /// The config is invalid before we even spawn (bad env, non-loopback wallet
    /// URL, `pythonw`). Never reaches a process.
    #[error("engine sidecar misconfigured: {0}")]
    BadConfig(String),

    /// Could not spawn the child at all (interpreter not found, engine dir
    /// missing). This IS worth surfacing to the user as a setup problem.
    #[error("cannot start the engine sidecar: {0}")]
    Spawn(String),

    /// A startup config fault: the helper printed `ENGINE-CONFIG-FAULT:` and/or
    /// exited 78 before the request loop. **Permanent — do not restart.**
    #[error("engine sidecar refused to start (config fault): {0}")]
    ConfigFault(String),

    /// The pipe framing broke (unparseable line, id mismatch). The pipe is
    /// desynced; the caller should tear down and respawn.
    #[error("engine sidecar framing error on {method}: {detail}")]
    Framing { method: String, detail: String },

    /// A call exceeded its timeout with the child still alive (a hung or
    /// genuinely slow method).
    ///
    /// C47b: after this error the transport ABANDONS the pipe (the child is
    /// dropped; the next call spawns fresh). The request we walked away from is
    /// still being processed engine-side, and the line protocol has no
    /// cancellation — so the pipe now holds an in-flight request whose response
    /// nobody will claim. Reusing it hands the NEXT caller a stale frame
    /// (id mismatch → `Framing`) after first making it wait behind work nobody
    /// wants; that is exactly how the 2026-07-28 BUY lane died its second death:
    /// `set_lock_b_txid` acquired the mutex cleanly and then sat 12s behind an
    /// ABANDONED cold-restore watch the engine was still running. A desynced
    /// pipe is desynced at the moment we stop waiting, not at the moment the
    /// stale frame is finally read — so it is marked dead here, deterministically,
    /// instead of sacrificing whichever innocent call arrives next.
    #[error("engine sidecar timed out on {method} after {seconds}s")]
    Timeout { method: String, seconds: u64 },

    /// C32: the call never reached the child — it spent its whole budget waiting
    /// for the ONE serialized sidecar, which another call was holding.
    ///
    /// Deliberately NOT [`Timeout`]. A hung method and a starved one look
    /// identical from the caller's side and demand opposite responses: a hung
    /// method means the child is wedged and should be torn down, a starved one
    /// means the child is healthy and busy and tearing it down would kill the
    /// work that was about to finish. Collapsing them is the same
    /// caller-collapses-the-distinction shape as D26/D27/C26.
    #[error(
        "engine sidecar was busy for the whole {seconds}s budget of {method} — another call held \
         the serialized sidecar and this one never reached the child (contention, not a hang)"
    )]
    Contended { method: String, seconds: u64 },

    /// The child died mid-run (not a config fault). Restart-and-rehydrate is the
    /// correct recovery; carries the last method and exit code for the log.
    #[error("engine sidecar died during {last_method} (exit {code:?})")]
    SidecarDied {
        last_method: String,
        code: Option<i32>,
    },

    /// The engine returned `ok:false` — a structured, EXPECTED rejection. This
    /// is NEVER a reason to retry or restart. `error_type` is the Python
    /// exception class name (e.g. `EngineError`, `WireError`), split off the
    /// wire string so callers match on it rather than the free-text message.
    #[error("engine rejected {method}: {error_type}: {message}")]
    EngineRejected {
        method: String,
        error_type: String,
        message: String,
    },

    /// The result JSON did not deserialize into the caller's expected type.
    #[error("engine sidecar result for {method} did not match the expected shape: {detail}")]
    BadResult { method: String, detail: String },
}

impl SidecarError {
    /// True when the right response is to fix configuration and NOT respawn.
    pub fn is_permanent(&self) -> bool {
        matches!(
            self,
            SidecarError::BadConfig(_) | SidecarError::ConfigFault(_)
        )
    }

    /// True when this is the engine's own structured rejection, which must never
    /// be retried.
    pub fn is_engine_rejection(&self) -> bool {
        matches!(self, SidecarError::EngineRejected { .. })
    }

    /// True when a respawn-and-rehydrate is the appropriate recovery.
    pub fn is_transient_death(&self) -> bool {
        matches!(
            self,
            SidecarError::SidecarDied { .. } | SidecarError::Framing { .. }
        )
    }
}

/// Locates and parameterizes the Python helper. Mirrors `bridge.go`'s
/// `bridgeConfig`, with the client's stricter invariants baked into
/// construction rather than left to the caller.
#[derive(Clone)]
pub struct SidecarConfig {
    /// The interpreter to run. Must NOT be a `pythonw` (no usable stdio). In
    /// production this is resolved by the packaging layer (a bundled
    /// interpreter or a system `python3`); in tests it is the venv python.
    python: String,
    /// Directory containing `desk_helper.py`.
    engine_dir: String,
    /// `ADA_ENGINE_ENV` preset. REQUIRED — there is deliberately no default.
    env_preset: String,
    /// `ADA_ENGINE_DATA_DIR` for the encrypted per-swap checkpoints. `None` =>
    /// in-memory only (no restart-safety); fine for the offline handshake tests.
    data_dir: Option<String>,
    /// CC-15: `CHAIN_B_NETWORK`, derived from `env_preset` at construction so it
    /// cannot drift from it. Resolved here rather than at spawn so an unmapped
    /// preset is refused BEFORE a child exists, like every other bad config.
    chain_b_network: &'static str,
    /// CC-16: which engine this drives. Decides which variable names the chain-A
    /// network, which vocabulary validates it, and which secrets are required
    /// before spawn. Defaults to [`Leg::Ada`] via [`SidecarConfig::new`].
    leg: Leg,
    /// Additional `KEY=VALUE` env passed through (the state key, the wallet-rpc
    /// URL, Blockfrost access). Validated where the client has an invariant.
    extra_env: Vec<(String, String)>,
}

impl SidecarConfig {
    /// `env_preset` is required and must be non-empty. Fails if the interpreter
    /// looks like a `pythonw` (which has no console stdio).
    pub fn new(
        python: impl Into<String>,
        engine_dir: impl Into<String>,
        env_preset: impl Into<String>,
    ) -> Result<Self, SidecarError> {
        Self::new_for_leg(Leg::Ada, python, engine_dir, env_preset)
    }

    /// CC-16: an LTC sidecar. `network` is `LTC_ENGINE_NETWORK`
    /// (`mainnet`/`testnet`/`regtest`), and `engine_dir` must point at
    /// `engine-ltc/` with an interpreter from THAT engine's venv — its coincurve
    /// is a BasicSwap fork built from source and the ADA venv cannot serve it.
    pub fn new_ltc(
        python: impl Into<String>,
        engine_dir: impl Into<String>,
        network: impl Into<String>,
    ) -> Result<Self, SidecarError> {
        Self::new_for_leg(Leg::Ltc, python, engine_dir, network)
    }

    fn new_for_leg(
        leg: Leg,
        python: impl Into<String>,
        engine_dir: impl Into<String>,
        env_preset: impl Into<String>,
    ) -> Result<Self, SidecarError> {
        let python = python.into();
        let env_preset = env_preset.into();
        let var = leg.network_var();
        if env_preset.trim().is_empty() {
            return Err(SidecarError::BadConfig(format!(
                "{var} is required and has no default"
            )));
        }
        if !leg.known_networks().contains(&env_preset.as_str()) {
            return Err(SidecarError::BadConfig(format!(
                "{var} {env_preset:?} is not a known network {:?}; a typo here exits the engine 1 \
                 (not the config-fault 78), so we refuse it before spawn",
                leg.known_networks()
            )));
        }
        // `pythonw.exe` (or bare `pythonw`) is the windowless interpreter: it has
        // no stdin/stdout we can drive. Reject it before it produces a silent
        // hang at the first read.
        let stem = python
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&python)
            .to_ascii_lowercase();
        if stem.starts_with("pythonw") {
            return Err(SidecarError::BadConfig(format!(
                "interpreter {python:?} is a windowless pythonw with no usable stdio; use python/python3"
            )));
        }
        let chain_b_network = match leg {
            Leg::Ada => chain_b_network_for(&env_preset)?,
            Leg::Ltc => chain_b_network_for_ltc(&env_preset)?,
        };
        Ok(Self {
            python,
            engine_dir: engine_dir.into(),
            env_preset,
            data_dir: None,
            chain_b_network,
            leg,
            extra_env: Vec::new(),
        })
    }

    /// CC-16: the secrets this leg cannot spawn without, checked BEFORE a child
    /// exists so a missing one is a config error rather than a startup fault
    /// read out of a dying process's stderr.
    ///
    /// ADA has nothing here — its state key is optional and its engine faults
    /// cleanly (78) without one. LTC's `Helper.__init__` calls
    /// `keys.seed_from_env(required=True)` at construction, so a missing seed is
    /// discovered only after spawn; and `desk_store_ltc` needs a state key
    /// whenever a data dir is set. Both are the same fail-closed shape the ADA
    /// preset check already has.
    fn validate_secrets_for_spawn(&self) -> Result<(), SidecarError> {
        if self.leg != Leg::Ltc {
            return Ok(());
        }
        let has = |k: &str| {
            self.extra_env
                .iter()
                .any(|(ek, ev)| ek == k && !ev.trim().is_empty())
        };
        // The engine accepts either the value or a file holding it.
        if !has("LTC_ENGINE_KEY_SEED") && !has("LTC_ENGINE_KEY_SEED_FILE") {
            return Err(SidecarError::BadConfig(
                "LTC_ENGINE_KEY_SEED (or _FILE) is required: engine-ltc's Helper calls \
                 seed_from_env(required=True) at construction, so without it the failure is a \
                 dead child rather than a refused config"
                    .into(),
            ));
        }
        if self.data_dir.is_some()
            && !has("LTC_ENGINE_STATE_KEY")
            && !has("LTC_ENGINE_STATE_KEYFILE")
        {
            return Err(SidecarError::BadConfig(
                "LTC_ENGINE_STATE_KEY (or _KEYFILE) is required whenever a data dir is set: the \
                 per-swap checkpoints are encrypted with it, and a swap whose key is lost is a \
                 swap whose refund cannot be signed"
                    .into(),
            ));
        }
        Ok(())
    }

    pub fn with_data_dir(mut self, dir: impl Into<String>) -> Self {
        self.data_dir = Some(dir.into());
        self
    }

    /// Add a passthrough env var. Applies the client's loopback invariant to
    /// `XMR_WALLET_RPC` here so a non-loopback URL is refused before spawn — the
    /// engine also refuses it, but this keeps the joint spend key from ever
    /// reaching a process pointed at a remote host.
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Result<Self, SidecarError> {
        let key = key.into();
        let value = value.into();
        if key == "XMR_WALLET_RPC" && !url_host_is_loopback(&value) {
            return Err(SidecarError::BadConfig(format!(
                "XMR_WALLET_RPC {value:?} is not loopback: the joint spend key is POSTed there in the \
                 clear, so it must be a 127.0.0.1/localhost/[::1] wallet-rpc"
            )));
        }
        // `-O`-style tampering cannot be smuggled through env, but ADA_ENGINE_ENV
        // must not be overridden to empty here either.
        if key == "ADA_ENGINE_ENV" && value.trim().is_empty() {
            return Err(SidecarError::BadConfig(
                "ADA_ENGINE_ENV cannot be set empty".into(),
            ));
        }
        // CC-15: both names for the chain-B network are refused here, for two
        // different reasons.
        //
        // `CHAIN_B_NETWORK` is DERIVED from the preset (see `chain_b_network_for`);
        // accepting an override would recreate the two-places-holding-one-quantity
        // fault the derivation exists to remove — and `extra_env` is applied AFTER
        // it in `spawn`, so an override would silently win.
        //
        // `XMR_ADDRESS_PREFIX` is the legacy spelling. It still works engine-side,
        // and the engine REFUSES a disagreeing pair rather than resolving by
        // precedence — which is the right call, and also means a caller setting it
        // would turn a config slip into a spawn failure. Refusing here names the
        // replacement instead.
        if key == "CHAIN_B_NETWORK" || key == "XMR_ADDRESS_PREFIX" {
            return Err(SidecarError::BadConfig(format!(
                "{key} must not be set through the env passthrough: the chain-B network is \
                 DERIVED from {} so the two can never disagree. If you need a different chain B, \
                 change the network",
                self.leg.network_var()
            )));
        }
        // CC-16: the OTHER leg's network variable is refused too. `spawn` writes
        // only this leg's, so smuggling the other one through would leave a
        // sidecar carrying two network names — one honoured, one inert and
        // reassuring. Refusing keeps "which network is this" a single answer.
        let other_var = match self.leg {
            Leg::Ada => Leg::Ltc.network_var(),
            Leg::Ltc => Leg::Ada.network_var(),
        };
        if key == other_var {
            return Err(SidecarError::BadConfig(format!(
                "{key} belongs to the other leg; this sidecar is {:?} and names its network with \
                 {}. Setting both leaves one of them inert",
                self.leg,
                self.leg.network_var()
            )));
        }
        self.extra_env.push((key, value));
        Ok(self)
    }
}

/// True for `localhost` or any address that the stdlib considers loopback
/// (127.0.0.0/8, `::1`). Anything we cannot confidently prove is loopback
/// returns false (fail closed) — notably a domain that merely BEGINS with
/// `127.` (`127.0.0.1.evil.com`) is not an IP and is rejected.
fn url_host_is_loopback(url: &str) -> bool {
    // Strip scheme, then take the authority (up to the first '/'), then drop any
    // `userinfo@` so a fake `127.0.0.1@evil.com` cannot smuggle a host past us.
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    // Host is either an `[ipv6]:port` literal or `host:port`.
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host == "localhost" {
        return true;
    }
    // Parse as a real IP and use the stdlib's loopback definition. A hostname
    // that is not a valid IP literal is never loopback here.
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

/// Split an engine wire error (`"<Type>: <message>"`) into its exception class
/// name and message. Splits on the FIRST `": "` only — `KeyError.__str__`
/// returns a `repr` with embedded quotes, so matching on the type name is the
/// only stable discriminator.
fn parse_engine_error(wire: &str) -> (String, String) {
    match wire.split_once(": ") {
        Some((ty, msg)) => (ty.trim().to_string(), msg.trim().to_string()),
        None => ("EngineError".to_string(), wire.trim().to_string()),
    }
}

/// The live child + its pipe. Held behind a `Mutex` inside [`EngineSidecar`].
struct Inner {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// The last `ENGINE-CONFIG-FAULT:` line the stderr drain saw, if any.
    fault_line: Arc<StdMutex<Option<String>>>,
}

/// A long-lived engine sidecar. Constructed cheaply; the child is spawned lazily
/// on the first [`call`](Self::call), matching `bridge.go` so a swap tier that
/// never runs a desk swap never pays for a process.
pub struct EngineSidecar {
    cfg: SidecarConfig,
    inner: Mutex<Option<Inner>>,
    /// Set once a permanent config fault is seen, so subsequent calls fail fast
    /// with the same verdict instead of re-spawning into the same fault.
    permanent_fault: StdMutex<Option<String>>,
    /// C47a: how many PROTOCOL calls are currently waiting to acquire the pipe.
    ///
    /// The 2026-07-28 armed pair died on queue order: four background watchers
    /// (two lanes × observer + reclaim watch, 15s cadence each) kept the FIFO
    /// mutex occupied, and `set_lock_b_txid` — a call with a funded deadline
    /// behind it — spent 18 of its 30 seconds waiting in line behind reads that
    /// could have happened any time. C32 made that starvation LEGIBLE
    /// (`Contended`, not `Timeout`); this makes it not happen: watch-lane calls
    /// consult this counter and yield instead of queueing, so the queue only
    /// ever contains protocol calls.
    critical_pending: std::sync::atomic::AtomicUsize,
}

/// RAII guard for [`EngineSidecar::critical_pending`]: the increment must be
/// undone on every exit path (acquired, contended, permanent-fault
/// short-circuit), and early returns are exactly where a manual decrement gets
/// forgotten.
struct CriticalPending<'a>(&'a std::sync::atomic::AtomicUsize);

impl<'a> CriticalPending<'a> {
    fn register(counter: &'a std::sync::atomic::AtomicUsize) -> Self {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for CriticalPending<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl EngineSidecar {
    pub fn new(cfg: SidecarConfig) -> Self {
        Self {
            cfg,
            inner: Mutex::new(None),
            permanent_fault: StdMutex::new(None),
            critical_pending: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Spawn the child. Caller holds the `inner` lock (passed as the guard's
    /// slot). Wires a stderr drain that captures the config-fault line and logs
    /// everything else under `[desk-engine]`.
    fn spawn(&self) -> Result<Inner, SidecarError> {
        // CC-16: refuse a leg missing its required secrets BEFORE the child
        // exists, so the failure names the variable rather than arriving as a
        // dead process.
        self.cfg.validate_secrets_for_spawn()?;
        let helper = format!("{}/desk_helper.py", self.cfg.engine_dir.trim_end_matches(['/', '\\']));
        let mut cmd = Command::new(&self.cfg.python);
        // argv is exactly [python, helper] — never `-O`.
        cmd.arg(&helper);
        cmd.current_dir(&self.cfg.engine_dir);
        // CC-16: the env block is the only leg-shaped part of this transport.
        cmd.env(self.cfg.leg.network_var(), &self.cfg.env_preset);
        // CC-15: names chain B so the engine can FORM the joint address, which is
        // what lets M2 compare an address rather than only a key. Set before
        // `extra_env` is applied, and `with_env` refuses both spellings, so there
        // is exactly one writer. Both legs read it — chain B is XMR/ZEPH either way.
        cmd.env("CHAIN_B_NETWORK", self.cfg.chain_b_network);
        if let Some(dir) = &self.cfg.data_dir {
            cmd.env(self.cfg.leg.data_dir_var(), dir);
        }
        for (k, v) in &self.cfg.extra_env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        // Windows: no console window flashes for the helper.
        crate::platform::apply_hidden_spawn(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| SidecarError::Spawn(format!("{} {}: {e}", self.cfg.python, helper)))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SidecarError::Spawn("child has no stdin pipe".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SidecarError::Spawn("child has no stdout pipe".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SidecarError::Spawn("child has no stderr pipe".into()))?;

        let fault_line = Arc::new(StdMutex::new(None));
        let fl = fault_line.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(rest) = line.strip_prefix(CONFIG_FAULT_PREFIX) {
                    let msg = rest.trim().to_string();
                    if let Ok(mut slot) = fl.lock() {
                        *slot = Some(msg.clone());
                    }
                    eprintln!("[desk-engine] CONFIG FAULT: {msg}");
                } else {
                    eprintln!("[desk-engine] {line}");
                }
            }
        });

        Ok(Inner {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
            fault_line,
        })
    }

    /// One request/response round-trip with the default timeout.
    pub async fn call<P: Serialize>(
        &self,
        method: &str,
        params: P,
    ) -> Result<serde_json::Value, SidecarError> {
        self.call_with_timeout(method, params, DEFAULT_CALL_TIMEOUT)
            .await
    }

    /// One round-trip, deserializing the `result` into `T`.
    pub async fn call_as<P: Serialize, T: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<T, SidecarError> {
        let value = self.call(method, params).await?;
        serde_json::from_value(value).map_err(|e| SidecarError::BadResult {
            method: method.to_string(),
            detail: e.to_string(),
        })
    }

    /// One round-trip with an explicit read timeout (for slow live-chain
    /// methods).
    pub async fn call_with_timeout<P: Serialize>(
        &self,
        method: &str,
        params: P,
        timeout: Duration,
    ) -> Result<serde_json::Value, SidecarError> {
        // A config fault already seen is permanent; do not respawn into it.
        //
        // Poison is RECOVERED rather than swallowed. `.lock().ok()` would yield
        // `None` on a poisoned mutex, the guard would silently not fire, and a
        // permanent fault would degrade into a respawn-per-request loop — the
        // exact failure the exit-78 contract exists to prevent, reached through
        // an unrelated panic and with nothing to notice it. There is no
        // invariant here a panicking thread could have half-broken: the cell
        // holds one `Option<String>`. Same idiom as `DeskWatchers::lock_map`.
        if let Some(msg) = self.permanent_fault_slot().clone() {
            return Err(SidecarError::ConfigFault(msg));
        }

        // C32: acquire the ONE serialized sidecar within the CALLER's budget.
        //
        // This used to be a bare `self.inner.lock().await` — unbounded. The
        // timeout was applied only to the read below, so a call queued behind a
        // long holder waited here with no deadline and no line, and the budget it
        // was given did not begin to apply until it got in. The counterparty's
        // `procTransport.Call` respects the caller's context for exactly this
        // reason, and its comment credits the incident that taught it: *"The
        // wallet client lost a funded drive to exactly this shape on their side:
        // their recovery observer monopolised their sidecar and starved a
        // protocol call 75 seconds in."* **The desk was fixed by our incident and
        // our copy still had the version that caused it.**
        //
        // The acquisition cost is DEDUCTED from the read budget rather than added
        // to it. A caller that asked for 30s asked for 30s in total; spending 25s
        // queueing and then starting a fresh 30s read would silently double a
        // bound that other timing decisions are built on.
        //
        // C47a: this is the PROTOCOL lane. Registering in `critical_pending`
        // makes every watch-lane call yield until we have the pipe — so the FIFO
        // queue this call joins can only contain other protocol calls, never a
        // backlog of 15s-cadence reads.
        let _pending = CriticalPending::register(&self.critical_pending);
        let acquire_start = std::time::Instant::now();
        let mut guard = match tokio::time::timeout(timeout, self.inner.lock()).await {
            Ok(g) => g,
            Err(_) => {
                return Err(SidecarError::Contended {
                    method: method.to_string(),
                    seconds: timeout.as_secs(),
                })
            }
        };
        // What is left of the caller's budget for the round trip itself. Floored
        // at 1s rather than 0: having waited, a call should get one real attempt
        // instead of an instant timeout that reads as a hang.
        let timeout = timeout
            .checked_sub(acquire_start.elapsed())
            .unwrap_or_default()
            .max(Duration::from_secs(1));
        self.round_trip_locked(&mut guard, method, params, timeout)
            .await
    }

    /// C47a: the WATCH lane — a call that must never cost a protocol call its
    /// window.
    ///
    /// Two differences from [`call_with_timeout`], both deliberate:
    ///
    /// - **It never queues.** If a protocol call is pending, or the pipe is held
    ///   by anyone, this returns [`SidecarError::Contended`] immediately. A
    ///   watcher polls again in 15 seconds and its callers already treat every
    ///   transport error as COULD-NOT-LOOK (observer) or CouldNotLook-and-retry
    ///   (reclaim watch), so a skipped round costs nothing — while a QUEUED
    ///   round is a slot a funded call may die behind, which is what happened on
    ///   2026-07-28.
    /// - **Its budget is not deducted for acquisition** — it spent nothing
    ///   acquiring (try-or-yield), so the full budget covers the round trip.
    pub async fn call_watch<P: Serialize>(
        &self,
        method: &str,
        params: P,
        timeout: Duration,
    ) -> Result<serde_json::Value, SidecarError> {
        if let Some(msg) = self.permanent_fault_slot().clone() {
            return Err(SidecarError::ConfigFault(msg));
        }
        if self
            .critical_pending
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
        {
            // Checked BEFORE try_lock, not instead of it: between two protocol
            // calls the pipe is momentarily free, and a watcher grabbing it
            // there would put a read in front of the second protocol call —
            // the same starvation with an extra step.
            return Err(SidecarError::Contended {
                method: method.to_string(),
                seconds: 0,
            });
        }
        let mut guard = match self.inner.try_lock() {
            Ok(g) => g,
            Err(_) => {
                return Err(SidecarError::Contended {
                    method: method.to_string(),
                    seconds: 0,
                })
            }
        };
        self.round_trip_locked(&mut guard, method, params, timeout)
            .await
    }

    /// The shared round trip: spawn-if-needed, write one request line, read one
    /// response line within `timeout`, parse and classify. Caller holds the pipe.
    async fn round_trip_locked<P: Serialize>(
        &self,
        guard: &mut tokio::sync::MutexGuard<'_, Option<Inner>>,
        method: &str,
        params: P,
        timeout: Duration,
    ) -> Result<serde_json::Value, SidecarError> {
        if guard.is_none() {
            **guard = Some(self.spawn()?);
        }
        let inner = guard.as_mut().expect("spawned above");

        inner.next_id += 1;
        let id = inner.next_id;
        let req = serde_json::json!({ "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&req).map_err(|e| SidecarError::Framing {
            method: method.to_string(),
            detail: format!("cannot serialize request: {e}"),
        })?;
        line.push('\n');

        // Write the request. A broken pipe here means the child already exited —
        // classify it (config fault vs crash) before returning.
        if let Err(e) = inner.stdin.write_all(line.as_bytes()).await {
            let verdict = self.classify_death(inner, method, Some(e.to_string())).await;
            **guard = None;
            return Err(verdict);
        }
        if let Err(e) = inner.stdin.flush().await {
            let verdict = self.classify_death(inner, method, Some(e.to_string())).await;
            **guard = None;
            return Err(verdict);
        }

        // Read exactly one response line, bounded by the timeout.
        let mut resp_line = String::new();
        let read = tokio::time::timeout(timeout, inner.stdout.read_line(&mut resp_line)).await;
        let n = match read {
            Err(_) => {
                // Timed out — and the pipe now carries an in-flight request we
                // are abandoning (there is no cancellation in the line
                // protocol). C47b: mark it dead HERE, deterministically. Reused,
                // it would make the next caller wait behind work nobody wants
                // and then hand it a stale frame (id mismatch -> Framing) — the
                // second half of the 2026-07-28 BUY-lane death. Dropping the
                // child also kills a genuinely hung one, which is the correct
                // recovery for that case too; a merely-slow call loses its
                // result either way the moment we stop waiting for it.
                **guard = None;
                return Err(SidecarError::Timeout {
                    method: method.to_string(),
                    seconds: timeout.as_secs(),
                });
            }
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                let verdict = self.classify_death(inner, method, Some(e.to_string())).await;
                **guard = None;
                return Err(verdict);
            }
        };
        if n == 0 {
            // EOF: the child closed stdout, i.e. it exited. Classify.
            let verdict = self.classify_death(inner, method, None).await;
            **guard = None;
            return Err(verdict);
        }

        let resp: serde_json::Value =
            serde_json::from_str(resp_line.trim_end()).map_err(|e| SidecarError::Framing {
                method: method.to_string(),
                detail: format!("unparseable response line {:?}: {e}", resp_line.trim_end()),
            })?;

        // The id must echo. A mismatch means the pipe is one frame off — refuse
        // to treat a stale frame as this call's answer.
        let resp_id = resp.get("id").and_then(|v| v.as_u64());
        if resp_id != Some(id) {
            let detail = format!("expected id {id}, got {resp_id:?}");
            **guard = None; // desynced pipe: force a respawn on the next call
            return Err(SidecarError::Framing {
                method: method.to_string(),
                detail,
            });
        }

        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            return Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null));
        }

        // ok:false — a structured rejection. NEVER retried. Split the type name
        // off so callers match on it, not the free-text message.
        let wire = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown engine rejection");
        let (error_type, message) = parse_engine_error(wire);
        Err(SidecarError::EngineRejected {
            method: method.to_string(),
            error_type,
            message,
        })
    }

    /// The sticky-fault cell, with lock poisoning RECOVERED.
    ///
    /// Both users of this cell fail silently and dangerously if the lock is
    /// simply skipped on poison — the read stops short-circuiting and the write
    /// stops recording — so neither is allowed to treat poison as "no fault".
    fn permanent_fault_slot(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.permanent_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Decide whether a dead child is a permanent config fault or a restartable
    /// crash. Reaps the child (bounded) to read its exit code, and consults the
    /// stderr drain's captured fault line. Records a permanent fault so later
    /// calls short-circuit.
    async fn classify_death(
        &self,
        inner: &mut Inner,
        method: &str,
        io_detail: Option<String>,
    ) -> SidecarError {
        // Give the process a moment to be reaped so we can read its exit code.
        let code = match tokio::time::timeout(REAP_TIMEOUT, inner.child.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => None,
        };
        let fault = inner.fault_line.lock().ok().and_then(|g| g.clone());

        if code == Some(EX_CONFIG) || fault.is_some() {
            let msg = fault.unwrap_or_else(|| {
                io_detail
                    .clone()
                    .map(|d| format!("exit {EX_CONFIG} ({d})"))
                    .unwrap_or_else(|| format!("exit {EX_CONFIG}"))
            });
            // Recover poison rather than skipping the write: failing to record
            // the fault is what turns "permanent" back into "retry forever".
            *self.permanent_fault_slot() = Some(msg.clone());
            return SidecarError::ConfigFault(msg);
        }

        SidecarError::SidecarDied {
            last_method: method.to_string(),
            code,
        }
    }

    /// Gracefully stop the child: close stdin so the helper's read loop hits EOF
    /// and exits 0 on its own, then PID-kill if it lingers. PID-only — never by
    /// image name (that would kill the user's unrelated Python processes).
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        let Some(inner) = guard.take() else {
            return;
        };
        // Destructure so we can drop stdin explicitly BEFORE waiting: closing the
        // write half is exactly the clean EOF shutdown `bridge.go` performs.
        let Inner {
            mut child, stdin, ..
        } = inner;
        let pid = child.id();
        drop(stdin);
        if tokio::time::timeout(REAP_TIMEOUT, child.wait())
            .await
            .is_err()
        {
            if let Some(pid) = pid {
                let _ = crate::platform::kill_pid_force(pid).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// C32: a call starved of the serialized sidecar fails AS CONTENTION, on its
    /// own budget, and never reaches the child.
    ///
    /// Before the fix `self.inner.lock().await` was unbounded and the timeout
    /// applied only to the read, so a call queued behind a long holder waited
    /// with no deadline and no line. The desk hit the same shape and its comment
    /// credits the incident that taught it — our incident — while our copy still
    /// had the version that caused it.
    ///
    /// The interpreter name is deliberately one that cannot exist. This test must
    /// never reach `spawn()`, and asserting that is half the value: if the
    /// acquisition regressed to unbounded, the call would get in, try to spawn,
    /// and fail with a DIFFERENT error — which is precisely the confusion this
    /// distinction removes.
    #[tokio::test]
    async fn a_starved_call_fails_as_contention_not_as_a_hang_c32() {
        let cfg = SidecarConfig::new("nonexistent-python-c32", ".", "preprod")
            .expect("config should build; it is never spawned");
        let sc = EngineSidecar::new(cfg);

        // Hold the ONE sidecar the way a cold chain-B watch would.
        let held = sc.inner.lock().await;

        let t0 = std::time::Instant::now();
        let r = sc
            .call_with_timeout(
                "watch_lock",
                serde_json::json!({}),
                Duration::from_millis(300),
            )
            .await;
        let waited = t0.elapsed();

        match r {
            Err(SidecarError::Contended { method, .. }) => {
                assert_eq!(method, "watch_lock", "the error must name the starved call")
            }
            Err(SidecarError::Timeout { .. }) => panic!(
                "a starved call reported as a HANG. The two demand opposite responses — a hung \
                 child should be torn down, a busy one must be left alone — so collapsing them \
                 is the caller-collapses-the-distinction shape this variant exists to prevent"
            ),
            Err(_) => panic!(
                "the starved call reached spawn(), so the mutex acquisition is unbounded again"
            ),
            Ok(_) => panic!("a call completed while the sidecar was held by someone else"),
        }
        assert!(
            waited < Duration::from_secs(3),
            "the call must give up on its own ~300ms budget rather than block; waited {waited:?}"
        );
        drop(held);
    }

    /// C47a: a WATCH call must never QUEUE. Held pipe → immediate `Contended`,
    /// not a wait.
    ///
    /// The contrast with the C32 test above is the point: a PROTOCOL call
    /// waits out its budget in the FIFO queue (C32 made that wait legible);
    /// a watch call is not allowed to be in that queue at all, because four
    /// watchers on a 15s cadence kept the 2026-07-28 queue occupied and a
    /// funded call died behind them. Falsified by routing this through the
    /// queueing lane: the call then waits its full 10s and the elapsed
    /// assertion goes red.
    #[tokio::test]
    async fn a_watch_call_never_queues_behind_a_holder_c47() {
        let cfg = SidecarConfig::new("nonexistent-python-c47", ".", "preprod")
            .expect("config should build; it is never spawned");
        let sc = EngineSidecar::new(cfg);

        let held = sc.inner.lock().await;

        let t0 = std::time::Instant::now();
        let r = sc
            .call_watch(
                "watch_lock",
                serde_json::json!({}),
                Duration::from_secs(10),
            )
            .await;
        let waited = t0.elapsed();

        assert!(
            matches!(r, Err(SidecarError::Contended { .. })),
            "a watch call with the pipe held must yield as Contended"
        );
        assert!(
            waited < Duration::from_secs(2),
            "the watch call QUEUED ({waited:?}) — it must yield instantly, never wait; a queued \
             watcher is a slot a funded protocol call can die behind"
        );
        drop(held);
    }

    /// C47a, second half: a watch call yields to a PENDING protocol call even
    /// when the pipe is momentarily free. Between two protocol calls the mutex
    /// is released; a watcher grabbing that gap puts a read in front of the
    /// second protocol call — the same starvation with an extra step.
    ///
    /// Falsified by removing the `critical_pending` check: try_lock then
    /// succeeds (the pipe IS free), the call proceeds to spawn a nonexistent
    /// interpreter, and the error is `Spawn`, not `Contended` — red.
    #[tokio::test]
    async fn a_watch_call_yields_to_a_pending_protocol_call_c47() {
        let cfg = SidecarConfig::new("nonexistent-python-c47b", ".", "preprod")
            .expect("config should build; it is never spawned");
        let sc = EngineSidecar::new(cfg);

        // A protocol call is registered as waiting; the pipe itself is FREE.
        let pending = CriticalPending::register(&sc.critical_pending);

        let r = sc
            .call_watch("watch_lock", serde_json::json!({}), Duration::from_secs(5))
            .await;
        assert!(
            matches!(r, Err(SidecarError::Contended { .. })),
            "with a protocol call pending, a watch call must yield even though the pipe is free \
             — got a non-Contended result, meaning the pending check is gone and the watcher \
             would race the protocol call for the gap between two acquisitions"
        );

        // And the RAII guard must release: once no protocol call is pending and
        // the pipe is free, a watch call proceeds (here: to a Spawn error,
        // because the interpreter deliberately does not exist — reaching spawn
        // IS the proof the lane is open again).
        drop(pending);
        let r2 = sc
            .call_watch("watch_lock", serde_json::json!({}), Duration::from_secs(5))
            .await;
        assert!(
            matches!(r2, Err(SidecarError::Spawn(_))),
            "with nothing pending the watch lane must be open again (expected the Spawn error \
             from the nonexistent interpreter); a still-closed lane means the pending counter \
             leaked and every future watch poll is blind"
        );
    }

    // ── Pure-logic tests: always run, no process ──────────────────────────

    // NOTE: `SidecarConfig` deliberately derives no `Debug` — `extra_env` carries
    // the AES state key and the wallet-rpc URL, and a derived `Debug` would leak
    // them into logs and panic messages (same discipline as `store::StoredSwap`).
    // So these tests pattern-match the Result rather than `.unwrap_err()`, which
    // would require `Debug` on the Ok type.

    /// CC-15: every preset we accept must map to a named chain-B network.
    ///
    /// The enumeration is the point. `chain_b_network_for` has a catch-all arm
    /// that refuses, so an unmapped preset cannot silently produce a sidecar with
    /// no chain B — but without this test the refusal would first be seen at a
    /// swap. Driving the list means adding a preset to `KNOWN_ENV_PRESETS` and
    /// forgetting the mapping goes red HERE.
    #[test]
    fn every_known_preset_maps_to_a_chain_b_network_cc15() {
        for preset in KNOWN_ENV_PRESETS {
            let net = chain_b_network_for(preset)
                .unwrap_or_else(|_| panic!("preset {preset:?} has no CHAIN_B_NETWORK mapping"));
            assert!(
                matches!(
                    net,
                    "xmr-mainnet" | "xmr-stagenet" | "xmr-testnet" | "zeph-mainnet" | "zeph-regtest"
                ),
                "preset {preset:?} mapped to {net:?}, which is not one of the engine's accepted \
                 network names"
            );
            // A ZEPH preset must not resolve to a Monero network, or the engine
            // would form an address with the wrong prefix and the cross-check
            // this whole item exists to enable would compare two wrong things.
            assert_eq!(
                preset.starts_with("zeph-"),
                net.starts_with("zeph-"),
                "preset {preset:?} and network {net:?} disagree about which chain B this is"
            );
        }
        // And the catch-all actually refuses, rather than defaulting.
        assert!(matches!(
            chain_b_network_for("preprodd"),
            Err(SidecarError::BadConfig(_))
        ));
    }

    /// CC-15: the derived value has exactly one writer. `extra_env` is applied
    /// AFTER `CHAIN_B_NETWORK` in `spawn`, so an accepted override would silently
    /// win — and the legacy `XMR_ADDRESS_PREFIX` would make the engine refuse a
    /// disagreeing pair at spawn instead. Both are refused at construction.
    #[test]
    fn the_chain_b_network_cannot_be_overridden_through_env_cc15() {
        let cfg = SidecarConfig::new("python3", "/eng", "preprod").expect("valid config");
        assert!(matches!(
            cfg.clone().with_env("CHAIN_B_NETWORK", "xmr-mainnet"),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(matches!(
            cfg.clone().with_env("XMR_ADDRESS_PREFIX", "18"),
            Err(SidecarError::BadConfig(_))
        ));
        // ...and an unrelated passthrough still works, so the guard is narrow.
        assert!(cfg.with_env("XMR_WALLET_RPC", OFFLINE_TEST_WALLET_RPC).is_ok());
    }

    /// CC-16 FALSIFY, both halves the desk named.
    ///
    /// An LTC config is refused BEFORE spawn for a missing network exactly as a
    /// missing `ADA_ENGINE_ENV` is — and `testnet4` is refused as unknown.
    /// Litecoin has no `testnet4`; that is Bitcoin Core 28 vocabulary, and it
    /// killed a desk provisioning script that errored on its own network name.
    #[test]
    fn an_ltc_config_refuses_a_missing_or_unknown_network_cc16() {
        assert!(matches!(
            SidecarConfig::new_ltc("python3", "/eng-ltc", ""),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(matches!(
            SidecarConfig::new_ltc("python3", "/eng-ltc", "testnet4"),
            Err(SidecarError::BadConfig(_))
        ));
        for ok in KNOWN_LTC_NETWORKS {
            assert!(
                SidecarConfig::new_ltc("python3", "/eng-ltc", *ok).is_ok(),
                "LTC network {ok:?} must be accepted"
            );
        }
        // And the vocabularies do not cross: an ADA preset is not an LTC
        // network, nor the reverse. Each engine would reject the other's name.
        assert!(matches!(
            SidecarConfig::new_ltc("python3", "/eng-ltc", "preprod"),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(matches!(
            SidecarConfig::new("python3", "/eng", "regtest"),
            Err(SidecarError::BadConfig(_))
        ));
    }

    /// CC-16: LTC's required secrets are refused pre-spawn, because its
    /// `Helper.__init__` demands the seed at construction — so without this the
    /// failure is a dead child, not a refused config.
    #[test]
    fn an_ltc_config_requires_its_secrets_before_spawn_cc16() {
        let base = SidecarConfig::new_ltc("python3", "/eng-ltc", "regtest").expect("valid");
        // No seed at all.
        assert!(matches!(
            base.clone().validate_secrets_for_spawn(),
            Err(SidecarError::BadConfig(_))
        ));
        // An EMPTY seed is not a seed.
        let empty = base.clone().with_env("LTC_ENGINE_KEY_SEED", "   ").expect("accepted");
        assert!(matches!(
            empty.validate_secrets_for_spawn(),
            Err(SidecarError::BadConfig(_))
        ));
        // Seed present, no data dir -> fine.
        let seeded = base
            .clone()
            .with_env("LTC_ENGINE_KEY_SEED", "aa".repeat(32))
            .expect("accepted");
        assert!(seeded.validate_secrets_for_spawn().is_ok());
        // Data dir set demands a state key, or the checkpoints are unencryptable.
        let with_dir = seeded.clone().with_data_dir("/tmp/ltc");
        assert!(matches!(
            with_dir.validate_secrets_for_spawn(),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(with_dir
            .with_env("LTC_ENGINE_STATE_KEY", "bb".repeat(32))
            .expect("accepted")
            .validate_secrets_for_spawn()
            .is_ok());
        // ADA is unaffected: it has no such requirement and must not grow one.
        assert!(SidecarConfig::new("python3", "/eng", "preprod")
            .expect("valid")
            .validate_secrets_for_spawn()
            .is_ok());
    }

    /// CC-16: each leg refuses the other's network variable. `spawn` writes only
    /// its own, so accepting the other would leave a sidecar carrying two names
    /// with one silently inert.
    #[test]
    fn each_leg_refuses_the_other_legs_network_var_cc16() {
        let ada = SidecarConfig::new("python3", "/eng", "preprod").expect("valid");
        assert!(matches!(
            ada.clone().with_env("LTC_ENGINE_NETWORK", "regtest"),
            Err(SidecarError::BadConfig(_))
        ));
        let ltc = SidecarConfig::new_ltc("python3", "/eng-ltc", "regtest").expect("valid");
        assert!(matches!(
            ltc.clone().with_env("ADA_ENGINE_ENV", "preprod"),
            Err(SidecarError::BadConfig(_))
        ));
        // The loopback invariant is leg-INDEPENDENT and still applies to both.
        assert!(matches!(
            ltc.clone().with_env("XMR_WALLET_RPC", "http://203.0.113.9:18083/json_rpc"),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(ltc.with_env("XMR_WALLET_RPC", OFFLINE_TEST_WALLET_RPC).is_ok());
    }

    /// CC-16: every LTC network maps to a chain B, and never to the wrong family.
    #[test]
    fn every_ltc_network_maps_to_a_chain_b_network_cc16() {
        for net in KNOWN_LTC_NETWORKS {
            let b = chain_b_network_for_ltc(net)
                .unwrap_or_else(|_| panic!("LTC network {net:?} has no CHAIN_B_NETWORK mapping"));
            assert!(
                matches!(b, "xmr-mainnet" | "xmr-stagenet" | "xmr-testnet"),
                "LTC network {net:?} mapped to {b:?}"
            );
        }
        assert_eq!(chain_b_network_for_ltc("testnet").unwrap(), "xmr-stagenet");
        assert!(matches!(
            chain_b_network_for_ltc("testnet4"),
            Err(SidecarError::BadConfig(_))
        ));
    }

    #[test]
    fn env_preset_is_required() {
        assert!(matches!(
            SidecarConfig::new("python3", "/eng", ""),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(SidecarConfig::new("python3", "/eng", "dev").is_ok());
    }

    #[test]
    fn an_unknown_env_preset_is_refused_before_spawn() {
        // A typo must be a pre-spawn BadConfig, because the engine exits an
        // invalid env with code 1 (not the config-fault 78), which the transport
        // would otherwise treat as a restartable death.
        assert!(matches!(
            SidecarConfig::new("python3", "/eng", "preprodd"),
            Err(SidecarError::BadConfig(_))
        ));
        assert!(matches!(
            SidecarConfig::new("python3", "/eng", "PREPROD"),
            Err(SidecarError::BadConfig(_))
        ));
        // Every real preset is accepted.
        for ok in KNOWN_ENV_PRESETS {
            assert!(
                SidecarConfig::new("python3", "/eng", *ok).is_ok(),
                "{ok:?} should be a valid preset"
            );
        }
    }

    #[test]
    fn pythonw_interpreter_is_refused() {
        for bad in [
            "pythonw",
            "pythonw.exe",
            r"C:\Python\pythonw.exe",
            "/usr/bin/pythonw3",
        ] {
            assert!(
                matches!(
                    SidecarConfig::new(bad, "/eng", "dev"),
                    Err(SidecarError::BadConfig(_))
                ),
                "{bad:?} should be refused"
            );
        }
        // A normal interpreter whose path merely contains "python" is fine.
        assert!(SidecarConfig::new(r"C:\Python\python.exe", "/eng", "dev").is_ok());
    }

    #[test]
    fn xmr_wallet_rpc_must_be_loopback() {
        let cfg = SidecarConfig::new("python3", "/eng", "dev").unwrap();
        // Non-loopback is refused, before any process exists.
        assert!(cfg
            .clone()
            .with_env("XMR_WALLET_RPC", "http://203.0.113.9:18083/json_rpc")
            .is_err());
        assert!(cfg
            .clone()
            .with_env("XMR_WALLET_RPC", "http://evil.example.com:18083/json_rpc")
            .is_err());
        // Loopback forms are accepted.
        for ok in [
            "http://127.0.0.1:18083/json_rpc",
            "http://localhost:18083/json_rpc",
            "http://[::1]:18083/json_rpc",
        ] {
            assert!(
                cfg.clone().with_env("XMR_WALLET_RPC", ok).is_ok(),
                "{ok:?} should be accepted"
            );
        }
    }

    #[test]
    fn loopback_detection_fails_closed_on_ambiguity() {
        assert!(url_host_is_loopback("http://127.0.0.1:1/x"));
        assert!(url_host_is_loopback("http://localhost/x"));
        assert!(url_host_is_loopback("http://[::1]:18083/json_rpc"));
        // userinfo must not smuggle a fake host past the check.
        assert!(!url_host_is_loopback("http://127.0.0.1@evil.com/x"));
        assert!(!url_host_is_loopback("http://10.0.0.5/x"));
        assert!(!url_host_is_loopback("http://127.0.0.1.evil.com/x"));
        assert!(!url_host_is_loopback("garbage"));
    }

    #[test]
    fn engine_error_splits_on_the_first_colon_space_and_keeps_the_type() {
        let (ty, msg) = parse_engine_error("EngineError: counterparty not ingested yet");
        assert_eq!(ty, "EngineError");
        assert_eq!(msg, "counterparty not ingested yet");

        // KeyError renders a repr with embedded quotes and could itself contain
        // ": " — we split on the FIRST occurrence only, so the type is clean.
        let (ty, msg) = parse_engine_error(r#"KeyError: "unknown swap 'abc': not in state""#);
        assert_eq!(ty, "KeyError");
        assert_eq!(msg, r#""unknown swap 'abc': not in state""#);

        // No delimiter => attributed to EngineError, whole string as the message.
        let (ty, msg) = parse_engine_error("something opaque");
        assert_eq!(ty, "EngineError");
        assert_eq!(msg, "something opaque");
    }

    #[test]
    fn error_classification_predicates_are_disjoint_where_it_matters() {
        let rejected = SidecarError::EngineRejected {
            method: "ingest_counterparty".into(),
            error_type: "EngineError".into(),
            message: "torsion".into(),
        };
        assert!(rejected.is_engine_rejection());
        assert!(!rejected.is_transient_death());
        assert!(!rejected.is_permanent());

        let fault = SidecarError::ConfigFault("no ADA_ENGINE_ENV".into());
        assert!(fault.is_permanent());
        assert!(!fault.is_transient_death());

        let died = SidecarError::SidecarDied {
            last_method: "claim".into(),
            code: Some(1),
        };
        assert!(died.is_transient_death());
        assert!(!died.is_permanent());
        assert!(!died.is_engine_rejection());
    }

    // ── Live tests: gated on a configured interpreter + engine dir ─────────
    //
    // Set PWNDA_ENGINE_TEST_PYTHON and PWNDA_ENGINE_TEST_DIR to the venv python
    // and the engine dir to exercise the real pipe. Absent either, these skip so
    // `cargo test` stays green on a box without the Python engine.

    fn test_cfg() -> Option<SidecarConfig> {
        let python = std::env::var("PWNDA_ENGINE_TEST_PYTHON").ok()?;
        let dir = std::env::var("PWNDA_ENGINE_TEST_DIR").ok()?;
        Some(
            SidecarConfig::new(python, dir, "dev")
                .unwrap()
                .with_env("XMR_WALLET_RPC", OFFLINE_TEST_WALLET_RPC)
                .unwrap(),
        )
    }

    /// C47b, live-gated: a timed-out call ABANDONS the pipe, and the next call
    /// gets a fresh child instead of a stale frame.
    ///
    /// Uses a self-contained fake helper (no engine imports) whose `slow`
    /// method sleeps far past the budget — the shape of the abandoned
    /// cold-restore watch that the 2026-07-28 `set_lock_b_txid` died behind.
    /// Before the fix this sequence was: `slow` times out (child kept), `ping`
    /// waits behind the abandoned request and then reads its stale frame →
    /// `Framing` → the INNOCENT call pays. After: `slow` times out AND marks
    /// the pipe dead; `ping` spawns fresh and round-trips cleanly.
    #[tokio::test]
    async fn a_timed_out_call_abandons_the_pipe_and_the_next_call_starts_fresh_c47() {
        let Some(python) = std::env::var("PWNDA_ENGINE_TEST_PYTHON").ok() else {
            eprintln!("skipping: set PWNDA_ENGINE_TEST_PYTHON (any python works for this one)");
            return;
        };
        // A minimal stand-in helper: answers ping immediately, sleeps 30s on
        // "slow". Written to a scratch dir so the real engine is not involved.
        let dir = std::env::temp_dir().join("pwnda-sidecar-c47b-test");
        std::fs::create_dir_all(&dir).expect("scratch dir");
        std::fs::write(
            dir.join("desk_helper.py"),
            r#"import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    if req.get("method") == "slow":
        time.sleep(30)
    sys.stdout.write(json.dumps({"id": req["id"], "ok": True, "result": {"pong": True}}) + "\n")
    sys.stdout.flush()
"#,
        )
        .expect("write fake helper");

        let cfg = SidecarConfig::new(python, dir.to_string_lossy().to_string(), "dev")
            .expect("config builds");
        let sc = EngineSidecar::new(cfg);

        // Prove the child works at all.
        let r = sc.call("ping", serde_json::json!({})).await.expect("first ping");
        assert_eq!(r.get("pong").and_then(|v| v.as_bool()), Some(true));

        // Abandon a slow call on a small budget.
        let err = sc
            .call_with_timeout("slow", serde_json::json!({}), Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(
            matches!(err, SidecarError::Timeout { .. }),
            "the slow call should time out, got {err}"
        );

        // The next call must get a FRESH child and answer cleanly — never wait
        // behind the abandoned request, never read its stale frame.
        let t0 = std::time::Instant::now();
        let r2 = sc.call("ping", serde_json::json!({})).await;
        let took = t0.elapsed();
        match r2 {
            Ok(v) => assert_eq!(v.get("pong").and_then(|x| x.as_bool()), Some(true)),
            Err(SidecarError::Framing { .. }) => panic!(
                "the call after a timeout read the ABANDONED call's stale frame — the pipe was \
                 reused after we stopped waiting for it, which is the second half of the \
                 2026-07-28 BUY-lane death"
            ),
            Err(e) => panic!("the call after a timeout failed: {e}"),
        }
        assert!(
            took < Duration::from_secs(10),
            "the follow-up call took {took:?} — it waited behind the abandoned request instead \
             of getting a fresh child"
        );
        sc.shutdown().await;
    }

    #[tokio::test]
    async fn live_ping_round_trips_and_ids_correlate() {
        let Some(cfg) = test_cfg() else {
            eprintln!("skipping: set PWNDA_ENGINE_TEST_PYTHON + PWNDA_ENGINE_TEST_DIR");
            return;
        };
        let sc = EngineSidecar::new(cfg);
        for _ in 0..3 {
            let r = sc.call("ping", serde_json::json!({})).await.unwrap();
            assert_eq!(r.get("pong").and_then(|v| v.as_bool()), Some(true));
            assert_eq!(r.get("env").and_then(|v| v.as_str()), Some("dev"));
        }
        sc.shutdown().await;
    }

    #[tokio::test]
    async fn live_ok_false_is_an_engine_rejection_not_a_death() {
        let Some(cfg) = test_cfg() else {
            eprintln!("skipping: engine test env not set");
            return;
        };
        let sc = EngineSidecar::new(cfg);
        // status on an unknown swap is a structured rejection.
        let err = sc
            .call("status", serde_json::json!({ "swapId": "does-not-exist" }))
            .await
            .unwrap_err();
        assert!(err.is_engine_rejection(), "got {err:?}");
        assert!(!err.is_transient_death());
        // And the transport is still usable afterwards — a rejection is not a
        // death, so the very next call must succeed on the same child.
        let r = sc.call("ping", serde_json::json!({})).await.unwrap();
        assert_eq!(r.get("pong").and_then(|v| v.as_bool()), Some(true));
        sc.shutdown().await;
    }

    #[tokio::test]
    async fn live_startup_config_fault_is_permanent_and_sticky() {
        let Some(python) = std::env::var("PWNDA_ENGINE_TEST_PYTHON").ok() else {
            eprintln!("skipping: engine test env not set");
            return;
        };
        let Some(dir) = std::env::var("PWNDA_ENGINE_TEST_DIR").ok() else {
            return;
        };
        // A reachable exit-78 fault: a data dir is set but no ADA_ENGINE_STATE_KEY,
        // so the encrypted store fails closed at startup with
        // `ENGINE-CONFIG-FAULT: StoreError: no state key ...` and exit 78. (An
        // invalid env value, by contrast, exits 1 and is refused at construction
        // instead — see `an_unknown_env_preset_is_refused_before_spawn`.)
        let cfg = SidecarConfig::new(python, dir, "dev")
            .unwrap()
            .with_data_dir(format!(
                "{}/pwnda-sidecar-nokey-test",
                std::env::temp_dir().display()
            ));
        let sc = EngineSidecar::new(cfg);
        let err = sc.call("ping", serde_json::json!({})).await.unwrap_err();
        assert!(
            err.is_permanent(),
            "expected a permanent config fault, got {err:?}"
        );
        assert!(matches!(err, SidecarError::ConfigFault(_)));
        // A second call must NOT respawn into the same fault — it short-circuits
        // on the recorded permanent fault.
        let err2 = sc.call("ping", serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err2, SidecarError::ConfigFault(_)));
    }
}
