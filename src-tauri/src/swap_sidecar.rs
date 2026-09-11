//! BasicSwap sidecar supervisor (PHASE 3 / W3 of [[basicswap-sidecar-ultracode-plan]]).
//!
//! Manages a **Pwnda Grove** node — upstream BasicSwap at the tag pinned in
//! `upstream/README.md`, plus the `upstream/patches/` series — as a PwndaWallet
//! sidecar on Windows: generates its config through upstream's own
//! `basicswap-prepare`, spawns `python -m basicswap.bin.run`, polls it healthy
//! over the authenticated loopback JSON API, proxies a *narrow* slice of that
//! API to the frontend, and stops it through a fixed shutdown ladder.
//!
//! The concrete version is deliberately **not restated here**. It lives in
//! [`crate::grove::EXPECTED_UPSTREAM_VERSION`], which a test pins against
//! `scripts/fetch-swap-runtime.mjs`'s `PIN_BASICSWAP_TAG`. This paragraph said
//! `v0.17.9` for two days after the pin moved to `v0.18.4` — a restated constant
//! in prose is a constant that goes stale, which is the same mirror-drift class
//! `upstream/README.md` calls out against its own "two patches" paragraph.
//!
//! Everything lives under `<app_data>/swap-sidecar/`:
//!
//! ```text
//!   runtime/   embedded CPython + site-packages (basicswap, coincurve fork, pyzmq)
//!   bin/       pre-seeded chain daemons (particld.exe, …) — `--nocores --bindir=`
//!   datadir/   basicswap.json, basicswap.log, wallets, per-coin datadirs, .pids
//! ```
//!
//! # Why config is generated, never hand-written
//!
//! `basicswap.json` carries an rfc2440 S2K hash (`client_auth_hash`), curve
//! ZMQ keypairs, a network key, and a per-coin `chainclients` block whose
//! schema moves with upstream. Hand-writing it guarantees drift. Instead the
//! supervisor builds the **argv + env** for upstream's own
//! `basicswap.bin.prepare` and lets it write the file
//! ([`build_prepare_plan`]). Remote-XMR wiring rides on prepare's own
//! semantics: setting `XMR_RPC_HOST` / `XMR_RPC_PORT` makes
//! `shouldManageDaemon("XMR")` return false (upstream `prepare.py:292-311`),
//! so prepare flips `manage_daemon` off for us — we never poke that key.
//!
//! # THE SHUTDOWN LADDER — order is load-bearing
//!
//! [`run_shutdown_ladder`] executes exactly these steps, in exactly this
//! order, and no other:
//!
//! 1. **`GracefulParent`** — ask the python parent to shut *itself* down
//!    (upstream's `/shutdown/<token>` endpoint, `http_server.py:891-897`).
//!    The parent then interrupts its own children and waits on them
//!    (`run.py:624-659`), which is the only path that lets each chain daemon
//!    flush its LevelDB chainstate.
//! 2. **`BoundedWait`** — poll for the parent to exit, ceiling ~120 s, chosen
//!    to match upstream's own per-child `wait(timeout=120)`.
//! 3. **`StopChainDaemons`** — only if the parent is *still* alive (the
//!    documented Monero-RPC-timeout hang): reach past it and graceful-stop
//!    each chain daemon through **its own RPC** (`stop` for bitcoin-family,
//!    `stop_wallet` / `stop_daemon` for the monero family), then let LevelDB
//!    flush.
//! 4. **`TerminateParent`** — terminate the python parent **last**, by PID
//!    with an image-name filter
//!    (`wallet_rpc_common::kill_process_by_pid_and_image`).
//!
//! **Never `TerminateProcess` a chain daemon, and never kill the parent
//! before step 1 has been attempted.** Killing the coordinator first orphans
//! daemons that nothing then stops gracefully; hard-killing a daemon mid-write
//! is the chainstate-corruption path. That is also why the parent is spawned
//! **without `kill_on_drop`** — dropping the supervisor state must not become
//! an implicit "kill the coordinator first".
//!
//! # App exit
//!
//! `lib.rs`'s `RunEvent::ExitRequested` hook `block_on`s the miner stops. A
//! 120 s ladder cannot live there, but neither can a detached one: the swap
//! tree is spawned `CREATE_NEW_PROCESS_GROUP` and **without `kill_on_drop`**,
//! so nothing else will ever stop it, and a task spawned onto a runtime that is
//! being torn down is not guaranteed to run at all.
//!
//! So [`on_exit_requested`] **blocks**, bounded by [`EXIT_LADDER_BUDGET_MS`],
//! and only when [`should_run_exit_ladder`] says there is a live node — a
//! wallet with no swap node closes exactly as fast as it always did. What
//! blocking cannot cover (power loss, Task Manager, a panic) still falls to
//! **orphan now, reconcile next launch**: [`reconcile_stale_instance`], whose
//! tiers mirror `xmr_rpc.rs:698-827`, is the backstop rather than the primary
//! mechanism it used to be.
//!
//! # Credential custody
//!
//! The web-UI/API password is generated **once per install**, persisted next
//! to the pidfile exactly like `xmr_rpc`'s credsfile, and **never returned to
//! the frontend**. All API traffic goes through [`swap_sidecar_api_get`] /
//! [`swap_sidecar_api_post`], which inject `Authorization: Basic` server-side
//! and pin every request under `/json/`.
//!
//! # THE API ALLOW-LIST — deny by default
//!
//! [`check_endpoint`] is an **allow-list**, not a denylist. Every
//! `(endpoint, path-tail, HTTP verb)` triple the wrapper UI may reach is
//! written out explicitly; everything else is refused. A denylist was tried
//! first and failed on the wire: `wallets/<coin>/withdraw` is not the name of
//! any denied endpoint, yet it routes to `withdraw_coin(...)` →
//! `swap_client.withdrawCoin` (upstream `js_server.py:316-330`) and moves
//! coins on-chain, with this module helpfully injecting the auth header. The
//! `/json/` routes do **not** pass through upstream's `checkForm` CSRF
//! control, so nothing downstream would have stopped it either.
//!
//! Three consequences worth keeping in mind when extending the list:
//!
//! * **Sub-commands are refused, not just endpoints.** `wallets` allows
//!   exactly one tail segment (a coin ticker). A second segment is always a
//!   command (`withdraw`, `createutxo`, `nextdepositaddr`, `reseed`, …) and
//!   never matches.
//! * **The policy is verb-aware.** Several upstream endpoints are readers on
//!   GET and writers on POST: `/json/bids/<id>` renders a bid, but the same
//!   URL with a POST body carrying `accept` calls `swap_client.acceptBid`
//!   (`js_server.py:773-776`), which commits funds. So `bids/<id>` is GET-only
//!   while bare `bids` (list + filters) takes both.
//! * **[`DENIED_ENDPOINTS`] is a second, independent barrier**, matched against
//!   *every* segment in *any* position, case-insensitively. It is redundant
//!   with the allow-list by construction — that is the point.
//!
//! Any endpoint the UI later needs is a deliberate, reviewed addition to
//! [`check_endpoint`], with a test.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use crate::wallet_rpc_common::CREATE_NO_WINDOW;

/// Windows `CREATE_NEW_PROCESS_GROUP`. Paired with `CREATE_NO_WINDOW` so the
/// python parent and every daemon it spawns inherit no console — upstream's
/// `run.py` uses plain `Popen` with no `creationflags` (run.py:182-193), so
/// console suppression has to happen on our side, at the root of the tree.
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

// =========================================================================
// Constants
// =========================================================================

/// Upstream's default UI HTTP port (`UI_HTML_PORT`, prepare.py:233).
pub const DEFAULT_HTML_PORT: u16 = 12700;
/// Upstream's default UI websocket port (`UI_WS_PORT`, prepare.py:234).
pub const DEFAULT_WS_PORT: u16 = 11700;

/// Step between candidate port offsets. `--portoffset=n` raises **every**
/// port in the config by `n` (prepare.py:1308), including the chain daemons',
/// so the step has to be wide enough that a shifted set can't land back on
/// the previous set's daemon ports.
pub const PORT_OFFSET_STEP: u16 = 100;
/// How many offsets (including 0) to try before giving up.
pub const PORT_OFFSET_TRIES: u16 = 8;

/// Health-poll budget after spawn. Generous because a first run pays for
/// Defender scanning a freshly extracted CPython plus particld's initial
/// chainstate open.
pub const READY_BUDGET_MS: u64 = 180_000;
/// Health-poll interval.
pub const READY_POLL_MS: u64 = 1_000;

/// Ladder step 2's ceiling — matches upstream's own child `wait(timeout=120)`
/// (run.py:634-641).
pub const LADDER_WAIT_MS: u64 = 120_000;
/// Ladder poll interval while waiting for the parent to exit.
pub const LADDER_POLL_MS: u64 = 500;

/// Total budget the exit-path ladder gets, and — since 2026-08-19 — how long
/// app exit will actually **block** for it.
///
/// # Why this is no longer fire-and-forget
///
/// It used to be 2 s on a *detached* `tauri::async_runtime::spawn`, on the
/// theory that the graceful request would land inside the ~100 ms `lib.rs`
/// already blocks for the miner stops and anything left over would be cleaned
/// up by [`reconcile_stale_instance`] on the next launch.
///
/// Two of those three assumptions do not hold:
///
/// 1. **The detached task is not guaranteed to run at all.** It is spawned onto
///    the same runtime the process is tearing down, and the only thing keeping
///    that runtime alive is `lib.rs`'s miner `block_on` — which returns almost
///    immediately when no miner is running (the common case for a swap user).
///    So the window is not "~100 ms", it is "however long the miner stops
///    happen to take", which can be ~0.
/// 2. **The request is two round trips, not one.**
///    [`graceful_shutdown_via_http`] must first render a page to mint the
///    one-shot shutdown token, *then* call `/shutdown/<token>`. Losing the race
///    between them leaves the node fully alive.
///
/// And the child cannot die on its own: it is spawned with
/// `CREATE_NEW_PROCESS_GROUP` and deliberately **without** `kill_on_drop`, so
/// the whole tree — python parent, particld, litecoind, monerod,
/// monero-wallet-rpc — survives the wallet exiting. The user-visible symptom is
/// five processes still holding ~320 MB after the window has closed.
///
/// So exit now blocks on the ladder, bounded by this budget. The cost is a
/// pause on close **only when a swap node is actually running**;
/// [`should_run_exit_ladder`] returns false otherwise and the exit path is
/// untouched. `reconcile_stale_instance` stays as the backstop for the cases
/// blocking cannot cover (power loss, Task Manager kill, a panic).
///
/// Sized from a measured teardown rather than a guess (2026-08-19, live node):
///
/// | step | measured |
/// |---|---|
/// | login + token + `/shutdown` returns | **483 ms** |
/// | [`EXIT_PARENT_WAIT_MS`] for the parent to exit on its own | 2 000 ms |
/// | daemon stops via their own RPCs, incl. the 2 s LevelDB settle | ~3–4 s |
/// | terminate the parent (usually already gone) | ~100 ms |
///
/// ≈ 6 s typical, so 12 s leaves headroom without approaching a hang.
pub const EXIT_LADDER_BUDGET_MS: u64 = 12_000;

/// Step (b)'s ceiling **on the exit path only** — deliberately far below
/// [`LADDER_WAIT_MS`].
///
/// A user-driven stop can afford to wait out upstream's own `wait(timeout=120)`
/// on the chance the parent finishes by itself. App exit cannot, and on Windows
/// it would be waiting for something that never happens: the parent's daemon
/// interrupts are `CTRL_C_EVENT` to console-less children, so it will sit in
/// that wait until it times out 120 s later, per daemon. Waiting longer here
/// buys nothing and delays the daemon-RPC tier that actually works.
pub const EXIT_PARENT_WAIT_MS: u64 = 2_000;

/// Bytes of `basicswap.log` attached to a failure message.
const LOG_TAIL_BYTES: u64 = 4096;

/// Interpreter-isolation flags, emitted **before** `-m` in every plan.
///
/// * `-s` — do not add the *user* site-packages directory
///   (`%APPDATA%\Python\Python312\site-packages`) to `sys.path`.
/// * `-E` — ignore `PYTHONPATH` / `PYTHONHOME` from the inherited environment.
///
/// Without them the embedded runtime is not embedded in any meaningful sense:
/// a bare `python -m basicswap.bin.run` was observed importing `babel` out of
/// the *user's* site-packages directory, i.e. the swap node's dependency set
/// silently depends on whatever the machine's system Python has installed.
/// That is a supply-chain surface and a reproducibility hole at once, and it
/// only shows up on machines that happen to have a conflicting package.
///
/// Order matters: these are interpreter options, so they must precede `-m`,
/// after which every remaining argv entry belongs to the module.
pub const ISOLATION_FLAGS: &[&str] = &["-s", "-E"];

/// Progress event name. Payload is [`SidecarProgress`], shaped like
/// `miners::DownloadProgress` (miners.rs:455-462).
pub const PROGRESS_EVENT: &str = "swap-sidecar-progress";

/// Path segments the API proxy refuses in **any position**, no matter who
/// asks. This is the *second* barrier — [`check_endpoint`]'s allow-list
/// already refuses everything not written into it, and every name here is
/// outside that allow-list. The redundancy is deliberate: an accidental
/// widening of the allow-list (a new tail shape, a new verb) still runs into
/// this list.
///
/// * `getcoinseed` hands out wallet seeds; `setpassword` / `unlock` / `lock`
///   are wallet-encryption controls.
/// * The `js_wallets` sub-commands (`js_server.py:316-395`) either move coin
///   (`withdraw`), mint UTXOs (`createutxo`), or mutate wallet key/derivation
///   state (`reseed`, `fixseedid`, `nextdepositaddr`, …).
/// * `new` is the creation verb on `offers`, `bids` and `smsgaddresses`.
/// * `revokeoffer` / `vacuumdb` / `generatenotification` mutate node state;
///   `readurl` and `electrumdiscover` make the node fetch an attacker-chosen
///   URL; `getsubfeebidtx` builds a spending transaction.
///
/// Matching is per **path segment** after normalization
/// ([`normalize_api_path`]) and case-insensitive, so `unlock`,
/// `/json/unlock`, `json/Unlock/part` and `//unlock?x=1` are all refused.
pub const DENIED_ENDPOINTS: &[&str] = &[
    "getcoinseed",
    "setpassword",
    "unlock",
    "lock",
    // js_wallets sub-commands
    "withdraw",
    "createutxo",
    "nextdepositaddr",
    "reseed",
    "rescan",
    "newstealthaddress",
    "newmwebaddress",
    "convertmweb",
    "watchaddress",
    "fixseedid",
    // creation verb on offers / bids / smsgaddresses
    "new",
    // node-state mutation and attacker-controlled egress
    "revokeoffer",
    "vacuumdb",
    "generatenotification",
    "readurl",
    "electrumdiscover",
    "getsubfeebidtx",
    // C8 (PWNDA-PATCH-4): takes an account-level private key. A renderer that
    // could reach it could hand the engine a wallet of the attacker's
    // choosing, which is strictly worse than reading one.
    "pwndasetaccountkey",
];

// =========================================================================
// Paths
// =========================================================================

/// `<app_data>/swap-sidecar` — follows `data_paths.rs`'s `base.join("<name>")`
/// convention so the Settings "where is my data" card can surface it.
/// Root of everything the sidecar owns: `runtime/`, `bin/`, `datadir/`, and the
/// parent pidfile.
///
/// `PWNDA_SWAP_SIDECAR_HOME` redirects the whole set for development.
///
/// Why this exists: production installs the runtime under
/// `<app-data>/swap-sidecar/`, which the setup wizard populates. During
/// development that directory does not exist — the working runtime lives in the
/// gitignored build workspace — so `npm run tauri dev` could reach the UI but
/// every start failed with "the swap runtime is not installed". The only escape
/// was a full `tauri build` + install, which is a terrible iteration loop for
/// UI work.
///
/// Pointing this at the build workspace makes `npm run tauri dev` drive the
/// REAL node with no build and no install:
///
/// ```text
/// PWNDA_SWAP_SIDECAR_HOME=G:\PwndaWalletDevelopment\.swap-sidecar-work
/// ```
///
/// The layout it expects is exactly what the workspace already has —
/// `runtime/`, `bin/`, `datadir/` — so nothing needs copying.
///
/// Dev-only by construction: unset (the shipped case) it resolves to app-data
/// exactly as before, so this cannot change behaviour for a user.
pub fn sidecar_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("PWNDA_SWAP_SIDECAR_HOME") {
        let p = p.trim();
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("swap-sidecar"))
}

/// Embedded CPython + site-packages.
pub fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("runtime"))
}

/// Pre-seeded chain daemons — what `--bindir=` points at.
pub fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("bin"))
}

/// BasicSwap's own `--datadir` (basicswap.json, basicswap.log, wallets, .pids).
pub fn datadir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("datadir"))
}

/// Our own parent pidfile — records the python coordinator so the next launch
/// can target *exactly* that process instead of every `python.exe` on the box.
pub fn pidfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("basicswap-run.pid"))
}

/// Per-install API password file. Same custody model as
/// `xmr_rpc::get_credsfile` — persisted so the *next* session can authenticate
/// a graceful shutdown against an orphan we couldn't tear down ourselves.
pub fn credsfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("basicswap-api.creds"))
}

/// Opt-in marker. Nothing downloads, prepares or spawns until this exists.
pub fn optin_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("opt-in.json"))
}

/// Path to the interpreter that runs both `basicswap.bin.prepare` and
/// `basicswap.bin.run`. `PWNDA_SWAP_SIDECAR_PYTHON` overrides it for
/// development against a hand-built venv (W3.0's WSL/dev node).
///
/// # The two `python-build-standalone` layouts are not the same shape
///
/// Found 2026-08-29 while wiring the Linux Grove bundle: this returned
/// `runtime/python{EXE_SUFFIX}` on every platform, which is correct for
/// Windows — the `install_only` Windows archive is flat, `python.exe` sits at
/// the tree root (confirmed against the staged `.swap-sidecar-work/runtime/`)
/// — and silently wrong for Linux, where `install_only` follows the POSIX
/// convention: the interpreter lives under `bin/`, as `bin/python` (a real
/// symlink the archive ships to `bin/python3.12`, not something we would need
/// to create) — confirmed against `.swap-sidecar-work/linux-runtime/bin/`.
///
/// `runtime/python` on Linux therefore resolves to nothing. Every caller of
/// this function would have failed at first use on a real Linux install, in a
/// way `check-bundle-payloads.mjs` cannot catch — that gate verifies the
/// `.enc` archive's own integrity, not that the Rust side agrees with the
/// archive's internal layout. This was caught by inspecting the actual staged
/// tree before wiring the Linux bundling step in, not by a failing build.
pub fn python_exe(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("PWNDA_SWAP_SIDECAR_PYTHON") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    Ok(python_exe_under(&runtime_dir(app)?, cfg!(windows)))
}

/// The branch `python_exe` decides on, pulled out so both shapes are
/// unit-testable from a single host OS — the whole bug this exists to prevent
/// a repeat of was one shape working and the other silently not, and the two
/// only ever diverge in a build running on the platform that was already
/// right.
fn python_exe_under(runtime: &std::path::Path, windows: bool) -> PathBuf {
    if windows {
        runtime.join(format!("python{}", crate::platform::EXE_SUFFIX))
    } else {
        runtime.join("bin").join("python")
    }
}

// =========================================================================
// Lifecycle state
// =========================================================================

/// Supervisor lifecycle. `Stopped -> Preparing -> Starting -> Healthy ->
/// Stopping -> Stopped`, with `Failed{reason}` reachable from any of the
/// transitional phases.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    Stopped,
    Preparing,
    Starting,
    Healthy,
    Stopping,
    Failed { reason: String },
}

impl Phase {
    /// Whether a transition is one the state machine allows. Kept explicit so
    /// the illegal ones (e.g. `Stopped -> Healthy`, skipping the spawn) are a
    /// test assertion rather than a code-reading exercise.
    pub fn can_transition_to(&self, next: &Phase) -> bool {
        use Phase::*;
        match (self, next) {
            (_, Failed { .. }) => true,
            (Failed { .. }, Stopped) => true,
            (Failed { .. }, Preparing) => true,
            (Stopped, Preparing) => true,
            (Preparing, Starting) => true,
            (Starting, Healthy) => true,
            // A start that never reached Healthy still has to be torn down —
            // including one that already Failed, which can have left a child
            // process behind that the ladder still has to clear.
            (Preparing, Stopping) => true,
            (Starting, Stopping) => true,
            (Healthy, Stopping) => true,
            (Failed { .. }, Stopping) => true,
            (Stopping, Stopped) => true,
            // Idempotent re-entry.
            (a, b) if a == b => true,
            _ => false,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self, Phase::Starting | Phase::Healthy | Phase::Stopping)
    }

    /// May `swap_sidecar_start` begin a NEW start from this phase?
    ///
    /// Distinct from [`Phase::is_running`] on exactly one variant:
    /// `Preparing`. A preparing node is not running (the HTML server is not
    /// up, the console cannot open), but a second start beginning underneath
    /// it races the first over ports and the config file — so for the start
    /// gate, `Preparing` is as busy as `Healthy`.
    pub fn blocks_new_start(&self) -> bool {
        self.is_running() || matches!(self, Phase::Preparing)
    }
}

/// Progress payload — mirrors `miners::DownloadProgress`'s `{stage, percent,
/// message}` shape so the frontend's existing progress components can consume
/// it unchanged.
#[derive(Clone, Serialize)]
pub struct SidecarProgress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

/// Emit one progress event. Paired `emit_meter::bump` per repo convention —
/// an unmetered emit stream is how the 2026-05 WebView2 leak stayed invisible.
pub fn emit_progress(app: &AppHandle, stage: &str, percent: f64, message: impl Into<String>) {
    crate::emit_meter::bump(PROGRESS_EVENT);
    let _ = app.emit(
        PROGRESS_EVENT,
        SidecarProgress {
            stage: stage.to_string(),
            percent,
            message: message.into(),
        },
    );
}

/// The engine datadir belongs to one wallet, and this session was started with
/// another. Carries both fingerprints so the message can name the gap.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedMismatch {
    /// What created the datadir.
    pub datadir_seed: String,
    /// What this session was started with.
    pub session_seed: String,
}

/// Managed state. Mirrors `XmrRpcChild`'s shape: a `Mutex` over the child
/// handle plus the session's resolved facts.
pub struct SwapSidecarInner {
    pub phase: Phase,
    pub child: Option<tokio::process::Child>,
    pub pid: Option<u32>,
    pub port_offset: u16,
    pub html_port: u16,
    pub ws_port: u16,
    /// Held in memory for the API proxy. **Never serialized, never returned.**
    pub auth_password: Option<String>,
    /// Set at start when the seed this session was launched with does NOT match
    /// the one that created the datadir (see [`seed_fingerprint`]). While true,
    /// account-key pushes are refused: pushing the active wallet's BTC/LTC
    /// account keys into another wallet's engine reaches funds.
    pub seed_mismatch: Option<SeedMismatch>,
    /// C5 - the engine's wallet-encryption password, set by
    /// [`swap_sidecar_set_wallet_key`] BEFORE a start and consumed by
    /// [`build_config`] on the way into prepare/addcoin and by
    /// [`unlock_wallets`] after the health check.
    ///
    /// **Memory only, and cleared on stop.** It is never written to disk and
    /// never reaches [`SidecarStatus`]; the frontend re-derives it from the
    /// vault mnemonic and re-sets it on the next start, so a stopped node
    /// leaves nothing behind that a memory dump could yield.
    pub wallet_pwd: Option<Secret>,
}

impl Default for SwapSidecarInner {
    fn default() -> Self {
        Self {
            phase: Phase::Stopped,
            child: None,
            pid: None,
            port_offset: 0,
            html_port: DEFAULT_HTML_PORT,
            ws_port: DEFAULT_WS_PORT,
            auth_password: None,
            seed_mismatch: None,
            wallet_pwd: None,
        }
    }
}

pub struct SwapSidecarState(pub Mutex<SwapSidecarInner>);

impl SwapSidecarState {
    pub fn new() -> Self {
        Self(Mutex::new(SwapSidecarInner::default()))
    }
}

impl Default for SwapSidecarState {
    fn default() -> Self {
        Self::new()
    }
}

/// What the frontend is allowed to know. Deliberately carries **no**
/// credential field.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub phase: Phase,
    pub running: bool,
    pub opted_in: bool,
    pub html_port: u16,
    pub ws_port: u16,
    pub port_offset: u16,
    /// True once `basicswap.json` exists — i.e. prepare has run at least once.
    pub configured: bool,
    /// True once the interpreter is present — i.e. the runtime is installed.
    pub runtime_installed: bool,
    pub datadir: String,
    /// Persisted "start with the wallet" preference. Reports the **record**,
    /// not the effective value: a dev run forcing autostart through
    /// [`AUTOSTART_ENV`] must not make the Settings toggle lie about what the
    /// installed wallet will do.
    pub autostart: bool,
    /// Coins the node is configured for, read back from `basicswap.json`'s
    /// `chainclients`. Empty before the first prepare.
    pub coins: Vec<String>,
    /// Coins in [`WALLET_SIDECAR_COINS`] that are **not** configured and cannot
    /// be added because no daemon binary is seeded for them. Surfaced so the
    /// gap is visible in the UI instead of looking like an empty order book.
    pub coins_unavailable: Vec<String>,
    /// binary-bundling-plan: true when this build ships an encrypted `grove`
    /// bundle in its resources, so the UI can offer "install the swap engine"
    /// (the setup step) offline instead of only via a (future) download.
    #[serde(default)]
    pub bundle_available: bool,
    /// WHICH engine is on disk — `pwnda-grove <tag>+p<N>` read from the runtime's
    /// own stamp, and whether it matches what this build expects.
    ///
    /// Until 2026-08-29 nothing in Rust ever looked: the supervisor's only
    /// runtime test was "does `python.exe` exist", so a node running an engine
    /// several patches behind the repo was indistinguishable from a current one.
    /// That is precisely how PWNDA-PATCH-9 ran missing on mainnet for three days.
    /// See [`crate::grove`].
    pub engine: crate::grove::EngineIdentity,
    /// Set when the engine datadir belongs to a different wallet than the one
    /// this session started with. While present, account-key sharing is refused.
    pub seed_mismatch: Option<SeedMismatch>,
    /// WHICH wallet's seed created this engine datadir ([`seed_fingerprint`]),
    /// persisted rather than session-scoped.
    ///
    /// The frontend compares it against a fingerprint of the ACTIVE wallet's
    /// swap mnemonic to decide whether the engine's balances belong to the
    /// wallet on screen. That comparison is why this is exposed at all: the
    /// engine keeps reporting a coin as verified-shared after a wallet switch,
    /// because from its side nothing changed — so "is this MY engine?" cannot be
    /// answered from the coin status alone.
    pub swap_seed_fingerprint: Option<String>,
    /// True when this datadir's Particl chain was synced on the OLD full-index
    /// layout, so Option A's `prune=` cannot engage on it.
    ///
    /// A3. Detection only — nothing here deletes a chain. `-prune` and
    /// `txindex`/`spentindex` are mutually exclusive in particl-core, and a
    /// chain already synced with the indexes cannot have them removed in place
    /// (`init.cpp:2302`, "best block of the index goes beyond pruned data"), so
    /// an existing install keeps its ~2.9 GB until someone chooses to re-sync
    /// into a fresh datadir. Silence would be the wrong answer: the user would
    /// read the wizard's new "about 1.5 GB" and see three times that on disk
    /// with nothing explaining the gap.
    ///
    /// `false` also for "no chain yet" and "already pruned" — see
    /// [`particl_chain_mode`]. It answers "is this node stuck on the old
    /// layout", not "is this node pruned".
    #[serde(default)]
    pub particl_unpruned: bool,
}

// =========================================================================
// Config generation — argv/env for upstream's own prepare + run
// =========================================================================

/// Which chain the node runs on. Testnet is deliberately absent: upstream
/// defaults `port_offset = 300` for testnet (prepare.py:1428), which would
/// silently fight our own offset selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Regtest,
}

impl Network {
    pub fn flag(&self) -> &'static str {
        match self {
            Network::Mainnet => "--mainnet",
            Network::Regtest => "--regtest",
        }
    }
}

/// Dev-only default network, same shape and same reasoning as
/// [`AUTOSTART_ENV`]/[`should_autostart`]: `swap_sidecar_start`'s own
/// `network: Option<Network>` argument already lets ANY caller request
/// regtest — the gap this closes is that the shipped UI never exposes that
/// argument (`SidecarSetupWizard.tsx` always calls it with none), so a
/// regtest rehearsal against the REAL supervisor + REAL UI had no path that
/// did not mean editing frontend code for one session. An env var closes it
/// the same way autostart's does: it can only ever WIDEN what a dev run does
/// relative to a normal one, never narrow it, and it is silently inert
/// (`std::env::var` returns `Err`) in every shipped build.
///
/// Precedence, and why it is ordered this way: an EXPLICIT caller argument
/// always wins over the env var — a future caller that actually does pass
/// `network` (the wizard, once it grows a picker) must not have a stale dev
/// env var silently override its own choice.
pub const NETWORK_ENV: &str = "PWNDA_SWAP_SIDECAR_NETWORK";

/// Pure so the precedence is testable without touching the environment.
pub fn resolve_network(explicit: Option<Network>, env_value: Option<&str>) -> Network {
    if let Some(n) = explicit {
        return n;
    }
    match env_value.map(|v| v.trim()) {
        Some(v) if v.eq_ignore_ascii_case("regtest") => Network::Regtest,
        Some(v) if v.eq_ignore_ascii_case("mainnet") => Network::Mainnet,
        _ => Network::Mainnet,
    }
}

/// The **only** carrier for a secret string in this subsystem (contract 1.1).
///
/// Two things travel through [`SidecarConfig`] that must never be printed:
/// the BIP85 child phrase that seeds the engine's Particl wallet (C1) and the
/// wallet-encryption password (C5). `SidecarConfig` derives `Debug` - a single
/// `eprintln!("{:?}", cfg)` anywhere in the supervisor, or a `Debug` on a type
/// that contains it, would otherwise put a recovery phrase in the log. The
/// manual `Debug` below is what makes that structurally impossible, which is
/// why it is not derived.
///
/// Deliberately **no** `Display`, **no** `Serialize`, **no** `Deref`: every one
/// of those is a way for the value to reach a string without the author having
/// typed [`Secret::expose`]. `expose()` is the single, greppable exit.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Self {
        Self(s)
    }
    /// The plaintext. Every call site is a place a secret can escape - keep
    /// them countable, and never pass the result anywhere that logs.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// C9 — the four `mainwalletrpc*` values [`apply_host_xmr_wallet_to_config`]
/// writes, bundled so they travel (and are absent) together rather than as
/// three parallel `Option`s that could disagree. `auth` is a wallet-rpc
/// credential, so it's a [`Secret`] — the same redaction discipline
/// `particl_mnemonic`/`wallet_encryption_pwd` already use on this struct —
/// rather than a plain `String` that would print in full via `{:?}`.
#[derive(Clone, Debug)]
pub struct XmrHostWalletParams {
    pub host: String,
    pub port: u16,
    /// Kept as the SAME two separate values `xmr_start_rpc` generates them
    /// as, all the way to the JSON write — never joined into one "user:pass"
    /// string. `callrpc_xmr` (rpc_xmr.py) does `auth[0]`/`auth[1]`, so a
    /// joined string would silently index by CHARACTER instead of by field;
    /// see `apply_host_xmr_wallet_to_config`'s own comment for the incident
    /// this is fixing.
    pub auth_user: Secret,
    pub auth_pass: Secret,
    pub wallet_name: String,
    /// [`engine_package_dir`]'s result — needed by
    /// [`apply_host_xmr_wallet_to_config`]'s patch-marker gate. Resolved once
    /// where `AppHandle` is available (`build_config`'s caller) rather than
    /// adding an `AppHandle` parameter to [`apply_local_config_policy`],
    /// which stays synchronous and Tauri-free like its neighbours.
    pub engine_pkg_dir: PathBuf,
}

/// ZEPH's twin of [`XmrHostWalletParams`] (Grove expansion plan, Phase C,
/// unit C-RZ). Same four values, same reasons: `ZEPHInterface` subclasses
/// `XMRInterface` unchanged (see `upstream/patches/0013`'s own header) and
/// inherits its `__init__` wholesale, so `chainclients.zephyr` reads the
/// exact same `mainwalletrpc*` keys `chainclients.monero` does — just under
/// a different coin block, written by [`apply_host_zph_wallet_to_config`]
/// rather than [`apply_host_xmr_wallet_to_config`]. `auth` stays a
/// [`Secret`] pair, never joined into one string, for the identical
/// `auth[0]`/`auth[1]` reason [`XmrHostWalletParams`]'s own doc comment
/// names — this struct is built with the 2-element-array fix already in
/// place from the start, rather than needing a live incident to find it.
#[derive(Clone, Debug)]
pub struct ZphHostWalletParams {
    pub host: String,
    pub port: u16,
    pub auth_user: Secret,
    pub auth_pass: Secret,
    pub wallet_name: String,
    /// See [`XmrHostWalletParams::engine_pkg_dir`] — identical role.
    pub engine_pkg_dir: PathBuf,
}

/// Zano's twin of [`XmrHostWalletParams`] / [`ZphHostWalletParams`] (Grove
/// expansion plan, Phase C, unit C-RX) — shaped differently from both,
/// because Zano's own sharing mechanism is: `upstream/patches/0015-zano-coin-module.patch`'s
/// `ZanoInterface.__init__` reads Main (`walletrpcport`/`walletrpcjwt`) and
/// Scratch (`scratchwalletrpcport`/`scratchwalletrpcjwt`) as TWO SEPARATE
/// wallet-rpc connections — never one process leased between two owners the
/// way XMR/ZEPH's `mainwalletrpc*` is. See `src-tauri/src/zano_rpc.rs`'s
/// own top-of-file doc comment ("a SECOND instance, not a lease on the
/// first") for the full "why" — Zano's `generate_from_keys` is destructive
/// and one-way, so it can never be aimed at the process serving the user's
/// funded Main wallet.
///
/// Auth is a SINGLE HS256 secret per instance (Zano's JWT scheme —
/// `zano_rpc::build_jwt`), not a Digest `(user, pass)` pair, so there is
/// one [`Secret`] field per instance rather than XMR/ZEPH's `auth_user`/
/// `auth_pass` two.
#[derive(Clone, Debug)]
pub struct ZanoHostWalletParams {
    /// Same host for both instances — both are loopback processes pwnda
    /// itself runs.
    pub host: String,
    pub main_port: u16,
    /// Main's live JWT secret, READ (never generated or rotated) by
    /// [`maybe_activate_zano_host_wallet`] — Main is host-managed, and this
    /// unit never opens, creates, or re-keys it. See
    /// [`XmrHostWalletParams::auth_user`]'s own doc comment for why this is
    /// a [`Secret`], not a plain `String`.
    pub main_jwt: Secret,
    pub scratch_port: u16,
    /// Scratch's freshly-generated JWT secret for THIS engine start — see
    /// `zano_rpc::zano_scratch_start`.
    pub scratch_jwt: Secret,
    /// See [`XmrHostWalletParams::engine_pkg_dir`] — identical role.
    pub engine_pkg_dir: PathBuf,
}

/// Everything [`build_prepare_plan`] / [`build_run_plan`] need. Split out as
/// plain data so both plans are pure functions and can be asserted without
/// spawning anything.
#[derive(Clone, Debug)]
pub struct SidecarConfig {
    pub python: PathBuf,
    pub datadir: PathBuf,
    pub bin_dir: PathBuf,
    pub network: Network,
    /// Coins passed to `--withcoins=`. `particl` is mandatory (SMSG).
    pub coins: Vec<String>,
    /// C7 - the subset of [`Self::coins`] to run WITHOUT a local chain.
    ///
    /// Only BTC and LTC can appear here; see [`CoinMode`] for what lean mode
    /// buys and what it trades away, and [`lean_mode_flags`] for how it
    /// reaches argv.
    pub lean_coins: Vec<String>,
    /// Generated per install; becomes `client_auth_hash` inside basicswap.json.
    pub client_auth_password: String,
    pub html_base_port: u16,
    pub ws_base_port: u16,
    pub port_offset: u16,
    /// Remote Monero node. Setting these env vars is what flips
    /// `manage_daemon` off for XMR (prepare.py `shouldManageDaemon`).
    pub xmr_rpc_host: Option<String>,
    pub xmr_rpc_port: Option<u16>,
    /// `--trustremotenode`. Only meaningful with a remote XMR node.
    pub trust_remote_node: bool,
    /// C9 — where the engine's MAIN Monero wallet-rpc lives, when it is the
    /// user's own (pwnda's `xmr_rpc.rs`) rather than the engine's. Distinct
    /// axis from `xmr_rpc_host`/`xmr_rpc_port` above, which pin the Monero
    /// DAEMON (chainclient) the engine talks to — this pins the WALLET-RPC
    /// the engine's main-wallet operations go through. `None` is the default
    /// and every existing install's behaviour: the engine runs its own.
    /// Computed by the caller BEFORE the node spawns (see
    /// `maybe_activate_xmr_host_wallet`) because `run.py` reads
    /// `basicswap.json` once, at start — there is no live reload path.
    pub xmr_host_wallet: Option<XmrHostWalletParams>,
    /// C-RZ — ZEPH's twin of [`Self::xmr_host_wallet`]: where the engine's
    /// `chainclients.zephyr` main wallet-rpc lives, when it is the user's
    /// own `zephyr-wallet-rpc` (`crate::zph_rpc`) rather than one the engine
    /// would otherwise run itself. `None` is the default — every install
    /// before this unit's own consent flow ships, and ZEPH not being
    /// enabled at all. Computed the same way and for the same reason as
    /// `xmr_host_wallet` (see `maybe_activate_zph_host_wallet`): before the
    /// swap node spawns, because `run.py` reads `basicswap.json` once, at
    /// start.
    pub zph_host_wallet: Option<ZphHostWalletParams>,
    /// C-RX — Zano's twin of [`Self::zph_host_wallet`] / [`Self::xmr_host_wallet`]:
    /// the Main + Scratch instance ports/secrets [`apply_host_zano_wallet_to_config`]
    /// writes into `chainclients.zano`, when Zano sharing is consented and
    /// Main is confirmed running. `None` is the default — every install
    /// before this unit's own activation ships, Zano not enabled, or Main
    /// not yet started (see [`maybe_activate_zano_host_wallet`]'s "ladder
    /// ordering" doc comment). Computed the same way and for the same
    /// reason as [`Self::xmr_host_wallet`]/[`Self::zph_host_wallet`]: before
    /// the swap node spawns, because `run.py` reads `basicswap.json` once,
    /// at start.
    pub zano_host_wallet: Option<ZanoHostWalletParams>,
    /// C1 - the BIP85 child phrase that seeds the engine's own Particl wallet,
    /// so one vault backup restores the swap wallet too.
    ///
    /// Reaches upstream on **prepare's argv only** (`--particl_mnemonic=`,
    /// prepare.py:1311) and never on `--addcoin` or on the run plan - see the
    /// env/argv placement table in the interface contract, and R1 for why the
    /// argv exposure is bounded.
    pub particl_mnemonic: Option<Secret>,
    /// Mirror of [`OptInRecord::archival_chain`], read once when the config is
    /// built so the prepare env is a pure function of the config.
    pub archival_chain: bool,
    /// C3 - the coins the user has enabled for the DEX, in
    /// [`WALLET_SIDECAR_COINS`] order and always including `particl`.
    ///
    /// Distinct from [`SidecarConfig::coins`], which is the `--withcoins` list
    /// (this set MINUS anything with no seeded daemon binary). This one is the
    /// intent; that one is what a first prepare can actually act on.
    pub enabled_coins: Vec<String>,
    /// C8 - lowercase TICKERS whose lean wallet is initialised from the
    /// wallet's own account key (`btc`, `ltc`).
    ///
    /// Emitted as `BSX_PWNDA_ACCOUNT_KEY_COINS` on **every** plan including the
    /// run plan, unlike the wallet-encryption password: the value is a coin
    /// LIST, not a secret, and the run process is exactly where PWNDA-PATCH-3
    /// consults it. Naming a coin here makes the engine refuse to initialise
    /// that wallet from its OWN seed — fail-closed, so a push that never
    /// arrives leaves no wallet rather than the wrong one.
    pub adoption_coins: Vec<String>,
    /// C5 - the wallets are KNOWN encrypted (learned marker, see
    /// [`OptInRecord::wallet_encrypted`]). With this true and no key in
    /// [`Self::wallet_encryption_pwd`], an `--addcoin` cannot succeed and is
    /// deferred instead of attempted.
    pub wallet_encrypted: bool,
    /// C5 - `WALLET_ENCRYPTION_PWD`, the engine's wallet-encryption password.
    ///
    /// Emitted into **prepare's and addcoin's** env only. `run.py:361-371`
    /// *raises* when it is set at start, so it must never reach
    /// [`build_run_plan`] or [`shared_envs`] (R5).
    pub wallet_encryption_pwd: Option<Secret>,
}

impl SidecarConfig {
    /// What `base + offset` *would* resolve to. **Not the session port** —
    /// that comes from [`plan_session_ports`], because an existing
    /// `basicswap.json` can carry a port this arithmetic does not reproduce
    /// and is the only thing `run.py` reads. Kept for the prepare-plan tests,
    /// which do assert upstream's own `UI_HTML_PORT + port_offset` formula.
    #[allow(dead_code)]
    pub fn html_port(&self) -> u16 {
        self.html_base_port + self.port_offset
    }
    /// See [`SidecarConfig::html_port`] — same caveat.
    #[allow(dead_code)]
    pub fn ws_port(&self) -> u16 {
        self.ws_base_port + self.port_offset
    }
}

/// How an elided secret renders. The same token [`Secret`] uses, so one grep
/// over a log finds every place a value was withheld - and so a reader can tell
/// "withheld" from "was never set", which a silently dropped field cannot.
const REDACTED: &str = "<redacted>";

/// argv flags whose **value** is a secret.
///
/// Both are pushed by [`build_prepare_plan`] as plain `String`s: [`Secret`]
/// protects the value inside [`SidecarConfig`], but the moment it is formatted
/// into an argv element the newtype is gone. This list is what [`SpawnPlan`]'s
/// `Debug` uses to put the guarantee back.
///
/// **Add a flag here in the same commit that adds it to a plan builder.**
///
/// # Why ZEPH's wallet-rpc credential and ZANO's JWT secret are NOT here
///
/// (Grove expansion plan, Phase C, unit C-R0 — checked while widening
/// [`WALLET_SIDECAR_COINS`], since "a Zano JWT or ZEPH wallet-rpc credential
/// must never land in a log line" was this unit's own brief.) Neither reaches
/// `basicswap.bin.prepare`/`run`'s argv at all: both are `chainclients.<coin>`
/// JSON keys (`walletrpcjwt`/`scratchwalletrpcjwt` for ZANO —
/// `upstream/patches/0016`; the ZEPH analogue of XMR's `mainwalletrpcauth` for
/// ZEPH), written directly into `basicswap.json` by a Rust function analogous
/// to [`apply_host_xmr_wallet_to_config`] — never printed, never argv. This
/// table has nothing to redact for them; a speculative entry here for a flag
/// that is never emitted would be untested dead weight, not protection.
///
/// **What actually has to happen instead, when C-RZ/C-RX add
/// `ZphHostWalletParams`/`ZanoHostWalletParams`:** follow
/// [`XmrHostWalletParams`]'s own pattern — wrap the credential in [`Secret`],
/// not `String`. `SidecarConfig` derives `Debug`
/// ([`secret_debug_is_redacted`] is what proves that composition safe today),
/// so a `Secret`-typed field is automatically covered by that same derive;
/// a plain `String` field would not be, and nothing in this file would catch
/// it — the same "a check that cannot fail for the reason you run it" shape
/// this session's own `adoption_coins_ignores_coins_that_cannot_run_lean` fix
/// hit, just one level up: no test here can fail for a struct that does not
/// exist yet, so the discipline has to be documented at the point future
/// authors will actually be looking, which is [`XmrHostWalletParams`] and
/// this comment, not a table entry with nothing to match.
const SECRET_ARG_FLAGS: &[&str] = &["--particl_mnemonic", "--client-auth-password"];

/// Env keys whose **value** is a secret. The KEY stays visible: "was
/// `WALLET_ENCRYPTION_PWD` set on this plan at all?" is the most useful single
/// question to ask of a prepare that failed, and it is answerable without
/// knowing the value.
const SECRET_ENV_KEYS: &[&str] = &["WALLET_ENCRYPTION_PWD"];

/// `Some((flag, inline))` when this argv element is, or introduces, a secret.
///
/// Two spellings, because both are producible from Rust:
/// * `--flag=<secret>` - one element. What every builder here emits (`inline`).
/// * `--flag` `<secret>` - two elements. **No builder produces this today**, and
///   that is exactly why it is handled: a `Debug` that only knew the inline
///   spelling would keep passing its own test while going blind the day someone
///   switched a builder to the two-element form. That is the "a check that
///   cannot fail for the reason you run it" shape this repo keeps hitting, so
///   the two-element case is covered rather than assumed away.
fn secret_arg_flag(arg: &str) -> Option<(&'static str, bool)> {
    for flag in SECRET_ARG_FLAGS {
        if arg == *flag {
            return Some((flag, false));
        }
        // `strip_prefix` alone is not enough: `--particl_mnemonicX=y` starts
        // with the flag but is a different option. The `=` is what makes it
        // this flag carrying a value.
        if let Some(rest) = arg.strip_prefix(*flag) {
            if rest.starts_with('=') {
                return Some((flag, true));
            }
        }
    }
    None
}

/// argv with every secret value elided, flags and structure intact.
fn redact_argv(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut elide_next = false;
    for a in args {
        if elide_next {
            elide_next = false;
            out.push(REDACTED.to_string());
            continue;
        }
        match secret_arg_flag(a) {
            Some((flag, true)) => out.push(format!("{}={}", flag, REDACTED)),
            Some((_, false)) => {
                // Keep the flag itself - it is the diagnostic - and eat its
                // value on the next iteration.
                out.push(a.clone());
                elide_next = true;
            }
            None => out.push(a.clone()),
        }
    }
    out
}

/// env pairs with every secret value elided, keys intact.
fn redact_envs(envs: &[(String, String)]) -> Vec<(String, String)> {
    envs.iter()
        .map(|(k, v)| {
            if SECRET_ENV_KEYS.iter().any(|s| k == s) {
                (k.clone(), REDACTED.to_string())
            } else {
                (k.clone(), v.clone())
            }
        })
        .collect()
}

/// A spawnable command, fully resolved but not yet spawned.
///
/// `Debug` is **hand-written, not derived** - see the impl below. `PartialEq` /
/// `Eq` stay derived: plan comparisons are structural and compare the real
/// values, which is what the plan tests need.
#[derive(Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
    pub cwd: PathBuf,
}

/// F3 - [`Secret`]'s guarantee stops at [`SidecarConfig`]; this is where it is
/// picked back up.
///
/// The newtype makes `format!("{:?}", cfg)` safe, but a plan is built by
/// *formatting those secrets into plain `String`s*: [`build_prepare_plan`]
/// pushes `--particl_mnemonic=<phrase>` onto `args` and [`prepare_time_envs`]
/// pushes `WALLET_ENCRYPTION_PWD=<key>` onto `envs`. From there the values are
/// ordinary strings in a struct that used to `#[derive(Debug)]`, so a single
/// `eprintln!("{:?}", plan)` - the most natural thing in the world to add while
/// debugging a spawn that will not start - would print a 24-word recovery
/// phrase and the wallet-encryption password into the log.
///
/// `secret_debug_is_redacted` would **not** have caught that: it asserts over
/// [`SidecarConfig`], and a `SpawnPlan` is not a `SidecarConfig`. So the
/// redaction is re-stated here, structurally, at the second place the values
/// exist - and `spawn_plan_debug_redacts_argv_and_env` is the test that goes
/// red the moment this impl is replaced by a derive.
///
/// What survives on purpose: the program, every non-secret argv element
/// (`--datadir`, `--withcoins`, `--portoffset`, the network flag), the secret
/// *flags themselves*, every env KEY including the secret ones, and the cwd. A
/// redaction that ate the whole struct would be safe and useless; the point is
/// a plan you can still diagnose from.
impl std::fmt::Debug for SpawnPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnPlan")
            .field("program", &self.program)
            .field("args", &redact_argv(&self.args))
            .field("envs", &redact_envs(&self.envs))
            .field("cwd", &self.cwd)
            .finish()
    }
}

impl SpawnPlan {
    // Accessors used by the config-generation tests (and by any future caller
    // that needs to inspect a plan before spawning it). `allow(dead_code)`
    // because the production path spawns the plan wholesale via
    // `command_from_plan` rather than reading individual entries.
    #[allow(dead_code)]
    pub fn env(&self, key: &str) -> Option<&str> {
        self.envs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    #[allow(dead_code)]
    pub fn has_arg(&self, needle: &str) -> bool {
        self.args.iter().any(|a| a == needle)
    }
}

/// Env block shared by prepare and run.
///
/// * `BASICSWAP_DATADIR` — the runtime datadir default (config.py:10).
/// * `DATADIRS` — feeds `TEST_DATADIRS`, which defaults to `/tmp/basicswap`
///   (config.py:17). Harmless at runtime, fatal under the test tiers on
///   Windows, so it is pinned to a Windows path unconditionally.
/// * `UI_HTML_PORT` / `UI_WS_PORT` — the **base** ports; `--portoffset` does
///   the shifting, exactly as upstream computes it (`UI_HTML_PORT +
///   port_offset`, prepare.py:2021/2048).
/// * `XMR_RPC_HOST` / `XMR_RPC_PORT` — presence is the signal that flips
///   `manage_daemon` off for XMR. Omitted entirely when no remote node is
///   configured, because an empty value would still count as "set".
/// * `PYTHONIOENCODING` / `PYTHONUTF8` — the parent is spawned with no
///   console; without these CPython picks a legacy code page and upstream's
///   unicode log lines raise `UnicodeEncodeError` into a null stdout.
fn shared_envs(cfg: &SidecarConfig) -> Vec<(String, String)> {
    let dd = cfg.datadir.to_string_lossy().into_owned();
    let mut envs = vec![
        ("BASICSWAP_DATADIR".to_string(), dd.clone()),
        ("DATADIRS".to_string(), dd),
        ("UI_HTML_PORT".to_string(), cfg.html_base_port.to_string()),
        ("UI_WS_PORT".to_string(), cfg.ws_base_port.to_string()),
        ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
        ("PYTHONUTF8".to_string(), "1".to_string()),
    ];
    // W-9: host and port are a PAIR, not two independent knobs. Upstream flips
    // `manage_daemon` off for XMR if EITHER var is set (prepare.py:305-309), so
    // emitting a port with no host would silently disable the local XMR daemon
    // while configuring nothing to replace it. Emit the port only inside a
    // present host; a port with no host is dropped (XMR stays locally managed —
    // the safe default).
    if let Some(host) = &cfg.xmr_rpc_host {
        envs.push(("XMR_RPC_HOST".to_string(), host.clone()));
        if let Some(port) = cfg.xmr_rpc_port {
            envs.push(("XMR_RPC_PORT".to_string(), port.to_string()));
        }
    }
    // U-3: BasicSwap's per-coin pid-file wait is a hardcoded 10s (20×0.5s,
    // basicswap.py). particld is spawned LAST but checked FIRST, and under
    // multi-daemon startup contention its pid file can land past 10s, which
    // terminates the whole node ("Mismatched pid → Error, terminating").
    // We cannot interleave the daemon starts ourselves — run.py owns spawning
    // and launches them all at once — so the supervisor's lever is to size the
    // readiness window to the contention it will create. PWNDA-PATCH-2 makes
    // that window honour BSX_PID_WAIT_ITERS (absent == upstream's 20). The
    // ceiling is only *consumed* when a daemon is genuinely slow: the wait
    // breaks the instant the pid appears (~2–3s in the low-contention case),
    // so a generous ceiling is free in the fast path and only lengthens a
    // genuine-failure wait. Remote XMR (no local monerod) → fewer competitors
    // → 40 iters (20s); a full-local config → 80 (40s).
    let pid_wait_iters = if cfg.xmr_rpc_host.is_some() { 40 } else { 80 };
    envs.push((
        "BSX_PID_WAIT_ITERS".to_string(),
        pid_wait_iters.to_string(),
    ));
    // C8 / PWNDA-PATCH-3. Emitted only when non-empty: the patch treats an
    // absent or empty variable as "no coin is host-owned", which is exactly the
    // behaviour an install without shared wallets needs, and an empty-but-set
    // value would read the same while looking deliberate to anyone debugging.
    if !cfg.adoption_coins.is_empty() {
        envs.push((
            "BSX_PWNDA_ACCOUNT_KEY_COINS".to_string(),
            cfg.adoption_coins.join(","),
        ));
    }
    envs
}

/// [`shared_envs`] plus the env vars that are legal **only on a prepare-family
/// run** (`prepare` and `--addcoin`).
///
/// C5 / R5: `WALLET_ENCRYPTION_PWD` is read by prepare to encrypt each coin's
/// wallet as it is initialised, and is **fatal** at node start -
/// `run.py:361-371` raises `ValueError("Please unset the WALLET_ENCRYPTION_PWD
/// environment variable.")`. Keeping it out of [`shared_envs`] is what makes
/// that structurally impossible: [`build_run_plan`] can only reach
/// `shared_envs`, so there is no edit to the run plan that leaks it.
fn prepare_time_envs(cfg: &SidecarConfig) -> Vec<(String, String)> {
    let mut envs = shared_envs(cfg);
    if let Some(pwd) = &cfg.wallet_encryption_pwd {
        envs.push((
            "WALLET_ENCRYPTION_PWD".to_string(),
            pwd.expose().to_string(),
        ));
    }
    // Option A, and it has to be HERE rather than in a post-prepare rewrite.
    // PWNDA-PATCH-31 makes upstream's Particl conf writer honour this, so the
    // conf is generated pruned and index-less in the first place.
    //
    // The ordering is not a preference. `prepare` STARTS particld to
    // initialise wallets, so a conf corrected after prepare returns is already
    // too late — particld aborts with "You need to rebuild the database using
    // -reindex to change -spentindex … Aborted block database rebuild." That
    // was observed, not predicted: it is what a snapshot-seeded datadir did
    // when prepare wrote the index lines over it (2026-09-09).
    //
    // Harmless on an unpatched runtime: `os.getenv` on a name nothing reads is
    // a no-op, so a runtime one deploy behind simply keeps upstream behaviour.
    // [`apply_particl_prune_policy`] is the belt-and-braces for that case and
    // for configs generated before this existed.
    // `0` is PWNDA-PATCH-31's explicit "archival, no pruning": it takes
    // upstream's path and writes both index lines back. Sent rather than
    // omitted so the value always says which node was asked for, instead of
    // the absence of a variable meaning two different things.
    envs.push((
        "PART_PRUNE".to_string(),
        if cfg.archival_chain {
            "0".to_string()
        } else {
            PARTICL_PRUNE_MIB.to_string()
        },
    ));
    // S0 (PWNDA-PATCH-32). ONLY when a chain is already on disk that prepare
    // did not put there — i.e. a restored snapshot.
    //
    // `-1` skips the wallet's birthday scan. That is right for a wallet this
    // process is about to derive (it has no history to find) and would be wrong
    // for a chain the node synced itself, where upstream's default costs
    // nothing because the wallet grew with the chain. Gating on the datadir
    // rather than on a flag keeps the two in step: the condition IS the
    // situation, not a claim about it.
    //
    // Without this, a restored snapshot cannot be brought up at all — the
    // wallet either rescans 475,213 blocks past the engine's 10 s RPC timeout,
    // or is created against an empty chain and ends up below `pruneheight`,
    // where particld refuses to start.
    if crate::snapshot::chain_awaiting_first_prepare(&cfg.datadir) {
        envs.push(("PART_WALLET_SCAN_FROM".to_string(), "-1".to_string()));
    }
    envs
}

/// argv + env for upstream's `basicswap.bin.prepare`.
///
/// Module invocation (`-m basicswap.bin.prepare`), never the
/// `basicswap-prepare` console-script shim — the shim is a generated `.exe`
/// in `Scripts/` that an embeddable CPython layout doesn't reliably produce,
/// and going through `-m` keeps the interpreter we picked authoritative.
///
/// `--nocores --bindir=<bin>` because we pre-seed and hash-verify the daemons
/// ourselves; prepare must never reach the network for a binary.
///
/// `-s -E` come **before** `-m` — see [`ISOLATION_FLAGS`].
/// The `--<prefix>-mode=electrum` flags for a config's lean coins.
///
/// # Why this is a function and not a hardcoded `--ltc-mode=electrum`
///
/// It used to be the latter: one literal, always emitted, for the one coin the
/// original bring-up happened to run lean. That is the project's recurring
/// defect shape — *a precondition copied from a neighbouring operation*.
/// Litecoin being electrum-backed was never a property of litecoin; it was a
/// property of that install, and hardcoding it silently made LTC the one coin
/// that could never do zero-move adoption ([`crate::descriptors`]) no matter
/// what the user chose.
///
/// Emitting nothing for a coin means upstream's default, which is a local
/// daemon — so `Full` is expressed by ABSENCE and needs no flag.
///
/// Only [`ELECTRUM_CAPABLE`] coins are consulted, because plain upstream
/// parses `--btc-mode`/`--ltc-mode` and nothing else (`prepare.py:1549-1552`):
/// a `--doge-mode=electrum` would be an "Unknown argument" abort at startup.
/// Grove's own patched engine additionally parses `--bch-mode` —
/// `upstream/patches/0018` adds `"bitcoincash"` to `prepare.py`'s
/// `electrum_supported_coins`, and `--bch-mode`/`--bch-electrum-server`
/// already parsed generically once that dict has the entry, so no separate
/// flag-name branch was needed on the Python side.
fn lean_mode_flags(cfg: &SidecarConfig) -> Vec<String> {
    ELECTRUM_CAPABLE
        .iter()
        .filter(|(coin, _)| {
            cfg.coins.iter().any(|c| c == coin) && cfg.lean_coins.iter().any(|c| c == coin)
        })
        .map(|(_, prefix)| format!("--{prefix}-mode=electrum"))
        .collect()
}

/// The coins a first prepare's `--withcoins` names: everything enabled EXCEPT
/// the host-wallet coins, whose blocks the supervisor writes itself. Pure, so
/// the exclusion is assertable.
pub fn prepare_coins(coins: &[String]) -> Vec<String> {
    coins
        .iter()
        .filter(|c| !HOST_MANAGED_DAEMON_COINS.contains(&c.as_str()))
        .cloned()
        .collect()
}

pub fn build_prepare_plan(cfg: &SidecarConfig) -> SpawnPlan {
    let mut args: Vec<String> = ISOLATION_FLAGS.iter().map(|s| s.to_string()).collect();
    args.extend([
        "-m".to_string(),
        "basicswap.bin.prepare".to_string(),
        format!("--datadir={}", cfg.datadir.to_string_lossy()),
        cfg.network.flag().to_string(),
        // Host-wallet coins (zephyr/zano) are NOT handed to prepare
        // (2026-09-04): its `initialise_wallets` would wait on their wallet-rpc
        // with credentials only this supervisor knows, retry for ten minutes
        // and fail the whole first prepare. Their blocks are written by
        // `ensure_host_wallet_coin_block` from the engine's own config segment
        // right after prepare, on the reconcile path.
        format!("--withcoins={}", prepare_coins(&cfg.coins).join(",")),
        "--nocores".to_string(),
        format!("--bindir={}", cfg.bin_dir.to_string_lossy()),
        format!("--portoffset={}", cfg.port_offset),
        // W-7: the credential rides argv, where any local process can read it
        // via `Win32_Process.CommandLine` for prepare's lifetime. Upstream
        // exposes no env-var alternative (prepare.py:1370-1371 reads argv only),
        // and computing the rfc2440 S2K hash in Rust to write `client_auth_hash`
        // directly was not done here because byte-equality with upstream's
        // implementation is unproven. The exposure is bounded: prepare runs only
        // on first-time setup / explicit reconfigure (the `run_prepare` gate in
        // `swap_sidecar_start`), never on an ordinary start, so the window is a
        // one-shot subprocess, not the node's whole lifetime.
        format!("--client-auth-password={}", cfg.client_auth_password),
    ]);
    // Per-coin lean mode. Absence = upstream's default = a local daemon.
    args.extend(lean_mode_flags(cfg));
    // `--trustremotenode` is only coherent when there IS a remote node.
    if cfg.trust_remote_node && cfg.xmr_rpc_host.is_some() {
        args.push("--trustremotenode".to_string());
    }
    // C1 / R1: the recovery phrase for the engine's Particl wallet. Absent
    // unless the caller supplied one - passing an EMPTY value is NOT the same
    // as passing nothing, because `particl_wallet_mnemonic = s[1]`
    // (prepare.py:1311) would then be a set-but-empty phrase. Only on PREPARE:
    // `--addcoin` must never carry it, and the run plan has no argv for it.
    //
    // The phrase rides argv, readable via `Win32_Process.CommandLine` for
    // prepare's lifetime, exactly like `--client-auth-password` above. Upstream
    // reads argv only (prepare.py:1280-1313); there is no env alternative. The
    // window is one short-lived subprocess on first-run/reconfigure, never the
    // node's lifetime.
    if let Some(m) = &cfg.particl_mnemonic {
        args.push(format!("--particl_mnemonic={}", m.expose()));
    }
    SpawnPlan {
        program: cfg.python.to_string_lossy().into_owned(),
        args,
        envs: prepare_time_envs(cfg),
        cwd: cfg.datadir.clone(),
    }
}

/// argv + env for a single `--addcoin=<coin>` prepare run — the only way to
/// widen an install that already has a `basicswap.json`.
///
/// Deliberately **not** a variant of [`build_prepare_plan`] with an extra flag:
///
/// * `--withcoins` is absent. Passing both makes prepare do the first-run
///   thing for the withcoins set and the add thing for the addcoin, and the
///   first of those is already a no-op on an existing config — so including it
///   would only make the argv lie about what the run does.
/// * `--client-auth-password` is absent, and that is the important one. It is
///   what triggers `prepare.py:1436-1461`'s early `return 0` on an existing
///   config, which would make this run rewrite the auth hash and exit
///   **without ever adding the coin**. Same short-circuit, third victim (after
///   `--portoffset` and `--withcoins`). The credential is already correct in
///   the config by the time any addcoin runs; there is nothing to re-set.
///
/// One coin per invocation, because upstream's `add_coin` is a single string
/// (`prepare.py:1326-1328`) and errors out if the coin is already present.
pub fn build_addcoin_plan(cfg: &SidecarConfig, coin: &str) -> SpawnPlan {
    let mut args: Vec<String> = ISOLATION_FLAGS.iter().map(|s| s.to_string()).collect();
    args.extend([
        "-m".to_string(),
        "basicswap.bin.prepare".to_string(),
        format!("--datadir={}", cfg.datadir.to_string_lossy()),
        cfg.network.flag().to_string(),
        format!("--addcoin={}", coin),
        "--nocores".to_string(),
        format!("--bindir={}", cfg.bin_dir.to_string_lossy()),
    ]);
    // The mode flag for THIS coin only.
    //
    // W-13 was "a gate applied to --addcoin but not --withcoins"; this is the
    // same seam from the other side, and getting it wrong is silent: a coin
    // enabled later would start a local daemon the user never asked for and
    // begin a multi-GB sync, with no error anywhere. Scoped to the coin being
    // added, because `--btc-mode` while adding litecoin would be a directive
    // about a coin this run is not touching.
    if cfg.lean_coins.iter().any(|c| c == coin) {
        if let Some((_, prefix)) = ELECTRUM_CAPABLE.iter().find(|(c, _)| *c == coin) {
            args.push(format!("--{prefix}-mode=electrum"));
        }
    }
    // Mirrors build_prepare_plan: only coherent with a remote node, and the
    // XMR add is exactly the run that needs it.
    if cfg.trust_remote_node && cfg.xmr_rpc_host.is_some() {
        args.push("--trustremotenode".to_string());
    }
    // R1: **no `--particl_mnemonic` here, ever.** The Particl wallet exists by
    // the time any addcoin runs; re-passing the phrase would ask prepare to
    // import a master key into a wallet that already has one, and would widen
    // the argv exposure from one first-run subprocess to every coin-set
    // widening for the life of the install. `prepare_time_envs` IS shared with
    // the prepare plan, because `WALLET_ENCRYPTION_PWD` is what makes the newly
    // added coin's wallet encrypted at birth - an addcoin without it leaves
    // that one coin's wallet unencrypted while every other coin is locked.
    SpawnPlan {
        program: cfg.python.to_string_lossy().into_owned(),
        args,
        envs: prepare_time_envs(cfg),
        cwd: cfg.datadir.clone(),
    }
}

/// argv + env for upstream's `basicswap.bin.run` — the python parent this
/// module supervises.
///
/// `-s -E` come **before** `-m` — see [`ISOLATION_FLAGS`].
pub fn build_run_plan(cfg: &SidecarConfig) -> SpawnPlan {
    let mut args: Vec<String> = ISOLATION_FLAGS.iter().map(|s| s.to_string()).collect();
    args.extend([
        "-m".to_string(),
        "basicswap.bin.run".to_string(),
        format!("--datadir={}", cfg.datadir.to_string_lossy()),
        cfg.network.flag().to_string(),
    ]);
    SpawnPlan {
        program: cfg.python.to_string_lossy().into_owned(),
        args,
        envs: shared_envs(cfg),
        cwd: cfg.datadir.clone(),
    }
}

// =========================================================================
// Port selection
// =========================================================================

/// Candidate offsets, in probe order: `0, STEP, 2*STEP, …`.
pub fn candidate_offsets() -> Vec<u16> {
    (0..PORT_OFFSET_TRIES).map(|i| i * PORT_OFFSET_STEP).collect()
}

/// Every port a candidate offset would need. Used to build the probe set.
pub fn ports_for_offset(html_base: u16, ws_base: u16, offset: u16) -> [u16; 2] {
    [html_base + offset, ws_base + offset]
}

/// Pure core of offset selection: the first candidate offset whose HTML *and*
/// WS ports are both free. `is_bound` is injected so the decision can be
/// tested without opening a socket.
pub fn select_port_offset<F>(html_base: u16, ws_base: u16, is_bound: F) -> Option<u16>
where
    F: Fn(u16) -> bool,
{
    candidate_offsets().into_iter().find(|&offset| {
        ports_for_offset(html_base, ws_base, offset)
            .iter()
            .all(|p| !is_bound(*p))
    })
}

/// Live version: probes every candidate port once with
/// `wallet_rpc_common::port_is_bound`, then runs the pure selector over the
/// snapshot. Probing up front (rather than inside the predicate) keeps the
/// decision function pure and bounds the probe count at `2 * PORT_OFFSET_TRIES`.
pub async fn resolve_port_offset(html_base: u16, ws_base: u16) -> Option<u16> {
    let mut bound: std::collections::HashSet<u16> = std::collections::HashSet::new();
    for offset in candidate_offsets() {
        for p in ports_for_offset(html_base, ws_base, offset) {
            if crate::wallet_rpc_common::port_is_bound(p).await {
                bound.insert(p);
            }
        }
    }
    select_port_offset(html_base, ws_base, |p| bound.contains(&p))
}

// =========================================================================
// Session ports — the config file is authoritative, not the offset scan
// =========================================================================

/// Ports upstream's own `basicswap.json` says the node will bind.
///
/// `htmlport` is written by prepare's settings block (`prepare.py:2021`) and
/// read back by `basicswap.py:1540/1550` — `run.py` takes **no** port
/// arguments, so this file is the only thing that decides where the node
/// listens. `wsport` is optional: prepare omits it when `wshost == "none"`
/// (`prepare.py:2048`).
pub fn read_configured_ports(config_json: &str) -> Result<(u16, Option<u16>), String> {
    let v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not JSON: {}", e))?;
    let html = v
        .get("htmlport")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| "basicswap.json has no htmlport".to_string())?;
    if html == 0 || html > u16::MAX as u64 {
        return Err(format!("basicswap.json htmlport {} is out of range", html));
    }
    let ws = v
        .get("wsport")
        .and_then(|x| x.as_u64())
        .filter(|p| *p > 0 && *p <= u16::MAX as u64)
        .map(|p| p as u16);
    Ok((html as u16, ws))
}

/// The ports this session will target, and whether prepare has to run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionPorts {
    /// True only when there is no config yet — prepare is first-time setup.
    pub run_prepare: bool,
    pub port_offset: u16,
    pub html_port: u16,
    pub ws_port: u16,
}

/// Decide the session ports. **An existing `basicswap.json` always wins.**
///
/// # Why the offset scan cannot be trusted once a config exists
///
/// `--portoffset` is applied by prepare's settings block, and prepare never
/// reaches that block on a second run: when the config file already exists
/// *and* a `--client-auth-password` (or the disable flag) is passed, it
/// rewrites `client_auth_hash` and `return 0`s immediately
/// (`prepare.py:1436-1461`). [`build_prepare_plan`] always passes
/// `--client-auth-password`, so from run #2 the offset is **inert**.
///
/// The failure that produced this function: something holds 11700 while 12700
/// is free, so [`select_port_offset`] rejects offset 0 (it needs *both* ports)
/// and returns 100. The supervisor then believes `html_port = 12800`, prepare
/// no-ops, `run.py` binds the configured 12700 and is perfectly healthy — and
/// the supervisor polls 12800 for the whole `READY_BUDGET_MS` and reports
/// `Failed{"health timeout"}`. Worse, `swap_sidecar_stop` then builds a
/// `LiveLadder{html_port: 12800}` whose `parent_alive` probe (a bind check on
/// 12800) reads *false*, so the ladder returns `clean: true` after
/// `[GracefulParent, BoundedWait]` and never touches `particld` or
/// `monero-wallet-rpc`. That is precisely the orphan the ladder exists to
/// prevent.
///
/// So: read the config's own ports and target those. The offset scan is only
/// consulted on a genuinely first run, when nothing is configured yet and
/// prepare will actually apply what it picks.
pub fn plan_session_ports(
    configured: Option<(u16, Option<u16>)>,
    fresh_offset: Option<u16>,
    html_base: u16,
    ws_base: u16,
) -> Result<SessionPorts, String> {
    match configured {
        Some((html, ws)) => {
            let port_offset = html.saturating_sub(html_base);
            Ok(SessionPorts {
                run_prepare: false,
                port_offset,
                html_port: html,
                ws_port: ws.unwrap_or_else(|| ws_base.saturating_add(port_offset)),
            })
        }
        None => {
            let offset = fresh_offset.ok_or_else(|| {
                format!(
                    "no free loopback port pair near {}/{} — something else is using them",
                    html_base, ws_base
                )
            })?;
            Ok(SessionPorts {
                run_prepare: true,
                port_offset: offset,
                html_port: html_base.saturating_add(offset),
                ws_port: ws_base.saturating_add(offset),
            })
        }
    }
}

// =========================================================================
// Coin set — `--withcoins` is a FIRST-RUN-ONLY argument
// =========================================================================

/// Every coin this wallet can both derive an address for **and** the swap
/// engine can settle, plus `particl`, which is not optional: it carries SMSG,
/// the only transport offers and bids travel over.
///
/// The intersection, derived rather than guessed:
/// upstream's settleable set is `prepare.py`'s `known_coins`
/// (particl, bitcoin, litecoin, decred, namecoin, monero, wownero, pivx, dash,
/// firo, navcoin, bitcoincash, dogecoin); the wallet's is `ChainType`
/// (`src/wallets/types.ts`). Decred, Namecoin, Wownero, PIVX, Firo and Navcoin
/// are dropped because the wallet holds no key for them — a coin the user
/// cannot pay from or receive into is a book they can look at and never trade.
///
/// **Zephyr and Zano go the other way: the wallet has them, plain upstream
/// does not** — they reach `known_coins` only on Grove's own patched engine
/// (`upstream/patches/0013`-`0016`), which is why this table is pinned
/// against the PATCHED engine's `known_coins`, not literal upstream — see
/// [`coin_names_are_engine_known_coins`]. They are followers, never leaders
/// (see [[grove-expansion-master-plan]] § 1): PART/BTC/LTC/BCH only, no
/// direct ZEPH↔ZANO pair, no XMR pair. Unlike BTC/LTC/BCH they have no
/// [`ELECTRUM_CAPABLE`]/lean option at all — the ONLY way the engine trades
/// them is against the user's own `zephyr-wallet-rpc` / `simplewallet`
/// process, the same C9 host-wallet mechanism XMR uses (see
/// [[c9-xmr-lifecycle-design]], [[wallet-sharing-with-bsx]]) — which is why
/// [`est_disk_gb`] returns zero for them unconditionally rather than only in
/// a particular [`CoinMode`].
///
/// The names are the (patched) engine's own `known_coins` keys, which is also
/// what `chainclients` is keyed by — `bitcoincash`, not `bitcoin-cash` or
/// `BCH`; `zephyr`, not `ZEPH`; `zano`, not `ZANO`.
/// [`coin_names_are_engine_known_coins`] pins them.
pub const WALLET_SIDECAR_COINS: &[&str] = &[
    // Mandatory: SMSG transport. Never remove.
    "particl",
    "bitcoin",
    "litecoin",
    "monero",
    "dogecoin",
    "dash",
    "bitcoincash",
    // Followers (host-wallet-only, no lean option, no local chain — see the
    // doc comment above). Added by the Grove expansion plan's Phase C; the
    // engine-side registration is patches 0013-0016.
    "zephyr",
    "zano",
];

/// Coins whose daemon and wallet processes **this app owns**, not the engine.
///
/// For these the engine is a client of a process pwnda already runs (the C9
/// host-wallet mechanism — [[c9-xmr-lifecycle-design]],
/// [[wallet-sharing-with-bsx]]), so `manage_daemon` must be `false`
/// unconditionally: `true` tells the engine to spawn its own daemon, and for
/// zano it aborts startup outright because `bin/run.py` has no launcher that
/// can start `zanod` (PWNDA-PATCH-20 makes that refusal explicit rather than
/// letting it fall into the Bitcoin launcher).
///
/// # Why this exists (2026-09-03)
///
/// [`apply_coin_enablement_to_config`] used to write `manage_daemon = <coin is
/// enabled>` for every rpc-mode chainclient in [`WALLET_SIDECAR_COINS`]. Both
/// follower modules hardcode `manage_daemon: False` in their own
/// `core.py` — and `interface/zano/core.py` even carried a comment asserting
/// that "Grove's own supervisor … forces manage_daemon False at runtime, the
/// same way it already does for XMR/ZEPH." That was the exact inverse of what
/// this function did: it wrote `true`, silently overriding the Python
/// hardcoding on every start.
///
/// It went unseen because the check that would have caught it was source-level
/// (unit B-Z1 read `zephyr/core.py`, confirmed the hardcoded `False`, and
/// concluded the toggle was bypassed) and structurally could not observe a
/// write performed in another language in another process. Monero was already
/// forced false by a separate special case further down this file, which is
/// why only the two new followers were affected.
pub const HOST_MANAGED_DAEMON_COINS: &[&str] = &["zephyr", "zano"];

/// Coins already present in a `basicswap.json`'s `chainclients` map.
///
/// `Err` for unreadable/!JSON input, `Ok(vec![])` for a config with no
/// `chainclients` at all — the caller treats those differently: the first is a
/// config we must not act on, the second is one we can add every coin to.
pub fn read_configured_coins(config_json: &str) -> Result<Vec<String>, String> {
    let v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not JSON: {}", e))?;
    let Some(cc) = v.get("chainclients") else {
        return Ok(Vec::new());
    };
    let obj = cc
        .as_object()
        .ok_or_else(|| "basicswap.json chainclients is not an object".to_string())?;
    Ok(obj.keys().cloned().collect())
}

/// Which of `desired` a config does not already carry, in `desired` order.
///
/// # This function is the whole reason the coin list is not just a `Vec` edit
///
/// `--withcoins` is honoured **only on a first prepare**. Once `basicswap.json`
/// exists, prepare rewrites `client_auth_hash` and `return 0`s before it ever
/// reaches the chainclients block (`prepare.py:1436-1461` — the same
/// short-circuit that made `--portoffset` inert, see [`plan_session_ports`]).
/// So widening [`WALLET_SIDECAR_COINS`] changes what a *fresh* install gets and
/// **nothing at all** for every install that already ran setup: the new coins
/// would silently never appear, and the only symptom would be an empty book on
/// the new pairs — indistinguishable from "nobody is making offers".
///
/// Upstream's supported path for an existing install is `--addcoin=<coin>`,
/// which takes exactly one coin per invocation and hard-errors with
/// `"<coin> is already in the settings file"` if it is present
/// (`prepare.py:1711-1787`). Hence: diff first, then one prepare run per
/// missing coin.
pub fn missing_coins(configured: &[String], desired: &[&str]) -> Vec<String> {
    let have: std::collections::HashSet<String> =
        configured.iter().map(|c| c.to_ascii_lowercase()).collect();
    desired
        .iter()
        .filter(|d| !have.contains(&d.to_ascii_lowercase()))
        .map(|d| (*d).to_string())
        .collect()
}

/// `basicswap.json`'s configured coins, or `None` when there is no readable
/// config. `None` and `Some(vec![])` are different: the first means "no config,
/// prepare will run with `--withcoins`", the second "config exists but names no
/// coins", which is a broken config, not an empty one.
pub fn configured_coins_in(datadir: &Path) -> Option<Vec<String>> {
    let raw = std::fs::read_to_string(datadir.join("basicswap.json")).ok()?;
    read_configured_coins(&raw).ok()
}

/// `basicswap.json`'s ports, or `None` when there is no readable config.
pub fn configured_ports_in(datadir: &Path) -> Option<(u16, Option<u16>)> {
    let raw = std::fs::read_to_string(datadir.join("basicswap.json")).ok()?;
    read_configured_ports(&raw).ok()
}

// =========================================================================
// API surface — auth injection, path pinning, denylist
// =========================================================================

/// `Authorization: Basic …` value. Upstream compares only the **password**
/// half against `client_auth_hash` (http_server.py:985-997), so the username
/// is cosmetic; a fixed one keeps the header deterministic.
pub fn basic_auth_header(password: &str) -> String {
    use base64::Engine;
    let raw = format!("pwnda:{}", password);
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
    )
}

/// Normalize a caller-supplied API path into the segment list we will actually
/// request, or reject it.
///
/// Rejects: absolute URLs, `..` traversal, backslashes (a Windows caller could
/// otherwise smuggle a separator past a `/`-only check), percent-encoding, any
/// character outside `[A-Za-z0-9._-]`, and empty paths. Query strings and
/// fragments are stripped — the proxy takes query params through its own
/// argument, never smuggled inside the path.
///
/// # Why percent-encoding is refused outright
///
/// A literal `".."` check is **not sufficient**, and the difference is
/// observable on the wire. `build_api_url` returns a *string*; `reqwest` then
/// hands that string to the WHATWG URL parser, which percent-**decodes** each
/// segment and *then* collapses dot-segments. `%2e%2e`, `%2E%2E`, `.%2e` and
/// `%2e.` are all double-dot segments to that parser, so a path that looked
/// pinned under `/json/` when we built it left this process as, verbatim:
///
/// ```text
/// PROBE input="x/%2e%2e/%2e%2e/shutdown/0123456789abcdef"
///   build_api_url=Ok("http://127.0.0.1:12700/json/x/%2e%2e/%2e%2e/shutdown/0123456789abcdef")
///   wire request line = "GET /shutdown/0123456789abcdef HTTP/1.1"
/// ```
///
/// No BasicSwap JSON endpoint needs percent-encoding — endpoint names are
/// ASCII words, object ids are hex, coin tickers are alphanumeric — so the
/// whole encoding is refused rather than decoded and re-checked. Decoding then
/// re-checking would leave the next encoding layer (double-encoding, overlong
/// UTF-8) to be re-argued; refusing `%` closes the class.
pub fn normalize_api_path(path: &str) -> Result<Vec<String>, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("empty API path".to_string());
    }
    if raw.contains("://") {
        return Err("absolute URLs are not accepted".to_string());
    }
    if raw.contains('\\') {
        return Err("backslashes are not accepted in an API path".to_string());
    }
    let no_query = raw.split(['?', '#']).next().unwrap_or("");
    let mut segs: Vec<String> = Vec::new();
    for seg in no_query.split('/') {
        let s = seg.trim();
        if s.is_empty() || s == "." {
            continue;
        }
        if s.contains('%') {
            return Err(
                "percent-encoding is not accepted in an API path (it decodes to a dot-segment \
                 inside the URL parser, after this check would have run)"
                    .to_string(),
            );
        }
        if s == ".." {
            return Err("path traversal is not accepted".to_string());
        }
        if !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(format!(
                "unexpected character in API path segment {:?}",
                s
            ));
        }
        segs.push(s.to_string());
    }
    // A caller may or may not include the `json` prefix; strip it so the
    // policy sees the endpoint name in a fixed position.
    if segs.first().map(|s| s.eq_ignore_ascii_case("json")) == Some(true) {
        segs.remove(0);
    }
    if segs.is_empty() {
        return Err("API path resolved to nothing".to_string());
    }
    Ok(segs)
}

/// Which proxy verb is about to be used. The endpoint policy is verb-aware
/// because several upstream endpoints read on GET and write on POST — see the
/// module docs' allow-list section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiMethod {
    Get,
    Post,
}

impl ApiMethod {
    fn label(self) -> &'static str {
        match self {
            ApiMethod::Get => "GET",
            ApiMethod::Post => "POST",
        }
    }
}

/// True if **any** segment, in any position, names something on
/// [`DENIED_ENDPOINTS`].
fn segments_hit_denylist(segs: &[String]) -> bool {
    segs.iter()
        .any(|s| DENIED_ENDPOINTS.iter().any(|d| s.eq_ignore_ascii_case(d)))
}

/// True if the path touches a denied name. Fail-closed: a path that cannot be
/// normalized is treated as denied.
///
/// The production path calls [`segments_hit_denylist`] directly (it already
/// holds the normalized segments), so this string-level wrapper exists for the
/// tests and for any future caller that only has the raw path. It is kept
/// rather than inlined because `DENIED_ENDPOINTS`'s "any segment, any
/// position, case-insensitive" contract is worth being able to assert on its
/// own, separately from the allow-list.
#[allow(dead_code)]
pub fn is_denied_endpoint(path: &str) -> bool {
    match normalize_api_path(path) {
        Err(_) => true,
        Ok(segs) => segments_hit_denylist(&segs),
    }
}

/// A BasicSwap object id: bid ids and offer ids are 28 bytes, hex-encoded
/// (`ensure(len(bid_id) == 28)`, js_server.py:766). Requiring the exact shape
/// is what keeps a *word* — `new`, `withdraw` — out of an id position.
fn is_object_id(s: &str) -> bool {
    s.len() == 56 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A coin ticker as `getCoinIdFromTicker` expects it (`PART`, `LTC`, `XMR`,
/// `PART_ANON`, …).
fn is_coin_ticker(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 12
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// **THE ALLOW-LIST.** Deny by default: every reachable
/// `(endpoint, tail, verb)` triple is written out here and nothing else
/// matches.
///
/// Derived by auditing upstream's `endpoints` map (js_server.py:2152-2189)
/// entry by entry. What is deliberately **absent**, and why:
///
/// | upstream endpoint | why it is not here |
/// |---|---|
/// | `getcoinseed`, `setpassword`, `unlock`, `lock` | key material / wallet-encryption control |
/// | `wallets/<c>/withdraw`, `createutxo`, `nextdepositaddr`, `reseed`, `rescan`, `fixseedid`, `watchaddress`, `newstealthaddress`, `newmwebaddress`, `convertmweb` | move coin or mutate wallet key state |
/// | `offers/new`, `bids/new`, `smsgaddresses/new`, `getsubfeebidtx` | create an offer/bid/address or build a spend |
/// | `bids/<id>` **on POST** | a body carrying `accept`/`abandon` calls `acceptBid`/`abandonBid` (js_server.py:773-776) |
/// | `revokeoffer`, `vacuumdb`, `generatenotification`, `checkupdates`, `updatestatus` | mutate node state |
/// | `readurl`, `electrumdiscover`, `coinprices`, `coinvolume`, `coinhistory` | make the node fetch an attacker-chosen or third-party URL |
/// | `identities`, `automationstrategies`, `smsgaddresses`, `messageroutes`, `modeswitchinfo`, `help` | read-only, but no wrapper-UI need yet — add deliberately, with a test |
pub fn check_endpoint(segs: &[String], method: ApiMethod) -> Result<(), String> {
    let deny = |why: &str| {
        Err(format!(
            "{} /json/{} is not reachable through the wallet ({})",
            method.label(),
            segs.join("/"),
            why
        ))
    };
    let Some(name) = segs.first() else {
        return deny("no endpoint");
    };
    let tail: Vec<&str> = segs[1..].iter().map(|s| s.as_str()).collect();

    use ApiMethod::{Get, Post};
    // Endpoint names are matched case-sensitively, exactly as upstream's own
    // `endpoints.get(url_split[2])` dispatch does.
    let allowed = match (name.as_str(), tail.as_slice(), method) {
        // ── flat readers ───────────────────────────────────────────────
        ("coins", [], Get) => true,
        ("walletbalances", [], Get) => true,
        ("network", [], Get) => true,
        ("notifications", [], Get) => true,
        ("active", [], Get) => true,
        ("rateslist", [], Get) => true,
        // ── pure computations over a POST body ────────────────────────
        ("rate", [], Post) => true,
        ("rates", [], Post) => true,
        ("offerfeeestimate", [], Post) => true,
        ("validateamount", [], Post) => true,
        // ── wallet reads. ONE tail segment (the ticker) only: a second
        //    segment is always a command (js_server.py:324-395). ────────
        ("wallets", [], Get) => true,
        ("wallets", [t], Get) => is_coin_ticker(t),
        ("wallettransactions", [t], Get | Post) => is_coin_ticker(t),
        // ── offer / bid reads. The bare form takes a POST body because
        //    that is where upstream reads its filters from; the id form is
        //    GET-only because a POST body there is an ACTION. ───────────
        ("offers", [], Get | Post) => true,
        ("offers", [id], Get) => is_object_id(id),
        ("sentoffers", [], Get | Post) => true,
        ("bids", [], Get | Post) => true,
        ("bids", [id], Get) => is_object_id(id),
        ("bids", [id, "states"], Get) => is_object_id(id),
        ("sentbids", [], Get | Post) => true,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        deny("not on the read-only allow-list")
    }
}

/// Normalize, screen against [`DENIED_ENDPOINTS`], then run the allow-list.
/// Returns the segments that will actually be requested.
pub fn allow_api_path(path: &str, method: ApiMethod) -> Result<Vec<String>, String> {
    let segs = normalize_api_path(path)?;
    if segments_hit_denylist(&segs) {
        return Err(format!(
            "endpoint '{}' is not reachable through the wallet (sensitive endpoints are refused)",
            path.trim()
        ));
    }
    check_endpoint(&segs, method)?;
    Ok(segs)
}

/// Build the loopback URL for an allowed endpoint. Every request is pinned
/// under `/json/`, which is what structurally puts `/shutdown/<token>`,
/// `/login` and the HTML pages out of the proxy's reach.
pub fn build_api_url(port: u16, path: &str, method: ApiMethod) -> Result<String, String> {
    let segs = allow_api_path(path, method)?;
    Ok(format!("http://127.0.0.1:{}/json/{}", port, segs.join("/")))
}

/// One entry of `/json/coins` (js_server.py:107-132).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoinEntry {
    pub id: i64,
    pub ticker: String,
    pub name: String,
    pub active: bool,
}

/// Parse a `/json/coins` body into the health verdict.
///
/// A node that is up but not yet usable answers `{"error": …}` rather than an
/// array — that must read as *not healthy*, not as a parse failure, which is
/// why the error shape is matched explicitly before the array shape.
pub fn parse_coins_health(body: &str) -> Result<Vec<CoinEntry>, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("/json/coins is not JSON: {} — body: {}", e, snippet(body)))?;
    if let Some(err) = v.get("error") {
        return Err(format!("/json/coins returned an error: {}", err));
    }
    let arr = v
        .as_array()
        .ok_or_else(|| format!("/json/coins is not an array — body: {}", snippet(body)))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let entry: CoinEntry = serde_json::from_value(item.clone())
            .map_err(|e| format!("/json/coins entry malformed: {}", e))?;
        out.push(entry);
    }
    if out.is_empty() {
        return Err("/json/coins returned an empty coin list".to_string());
    }
    Ok(out)
}

fn snippet(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Pull the one-shot shutdown token out of a rendered BasicSwap page.
///
/// Upstream mints it per render into `session_tokens["shutdown"]` and embeds
/// `/shutdown/<token>` in the page (http_server.py:494-497), so the only way
/// to obtain it is to render a page first. Token is 8 random bytes hex-encoded
/// → exactly 16 lowercase hex chars.
pub fn extract_shutdown_token(html: &str) -> Option<String> {
    let needle = "/shutdown/";
    let mut from = 0usize;
    while let Some(idx) = html[from..].find(needle) {
        let start = from + idx + needle.len();
        let tail = &html[start..];
        // W-8: collect the WHOLE hex run, then require exactly 16. The prior
        // `.take_while(hex).take(16)` truncated a 17+ char run to its first 16
        // and returned a WRONG token that still passed `len == 16` — a value
        // that looks valid but shuts nothing down. An over-long run is not a
        // token; skip it and keep scanning.
        let run: String = tail.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if run.len() == 16 {
            return Some(run.to_ascii_lowercase());
        }
        from = start.max(from + idx + 1);
        if from >= html.len() {
            break;
        }
    }
    None
}

// =========================================================================
// Chain-daemon targets (ladder step 3)
// =========================================================================

/// How a managed chain daemon is stopped gracefully.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonKind {
    /// bitcoin-family JSON-RPC `stop` (particl, litecoin, …).
    BitcoinRpc,
    /// monerod `/stop_daemon`.
    MoneroDaemon,
    /// monero-wallet-rpc `stop_wallet`.
    MoneroWalletRpc,
}

/// One daemon we may have to reach past a hung parent to stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonTarget {
    pub coin: String,
    pub kind: DaemonKind,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    /// The chainclient's own `datadir`, where a bitcoin-family daemon writes
    /// its `.cookie`. Carried because the generated config has **no**
    /// `rpcuser`/`rpcpassword` for those coins — see [`cookie_auth`].
    pub chain_datadir: Option<PathBuf>,
}

/// Bitcoin-family RPC credentials from the daemon's own `.cookie` file.
///
/// # Why this exists (P3, 2026-08-18)
///
/// A generated `chainclients.particl` block is exactly:
///
/// ```json
/// {"connection_type": "rpc", "manage_daemon": true, "rpchost": "127.0.0.1",
///  "rpcport": 19792, "datadir": "…\\datadir\\particl", …}
/// ```
///
/// — **no `rpcuser`, no `rpcpassword`.** BasicSwap authenticates to
/// bitcoin-family daemons with the auth cookie the daemon writes at startup
/// (`basicswap.py:1253`, `<datadir>/<chain>/.cookie`, contents
/// `__cookie__:<random>`), not with a static credential. So a
/// [`DaemonTarget`] built from that config carries `user: None,
/// password: None`, and any `stop` we POST goes out unauthenticated and comes
/// back `401` — meaning ladder step (c) could never actually stop a
/// bitcoin-family daemon. It was only ever exercised against fakes, so nothing
/// said so.
///
/// The chain sub-directory is `""` on mainnet and the chain's own name
/// otherwise (`base.py:252 getChainDatadirPath`), so both are probed rather
/// than threading the `Network` through every call site.
pub(crate) fn cookie_auth(chain_datadir: &Path) -> Option<(String, String)> {
    for sub in ["", "regtest", "testnet"] {
        let path = if sub.is_empty() {
            chain_datadir.join(".cookie")
        } else {
            chain_datadir.join(sub).join(".cookie")
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some((user, pass)) = raw.trim().split_once(':') {
            if !pass.is_empty() {
                return Some((user.to_string(), pass.to_string()));
            }
        }
    }
    None
}

/// Derive the graceful-stop targets from a `basicswap.json`.
///
/// Only entries with `manage_daemon: true` (or `manage_wallet_daemon: true`
/// for the monero wallet daemon) are included — a daemon we did not start is
/// never ours to stop. `connection_type: "electrum"` entries have no daemon at
/// all, so LTC-in-electrum-mode contributes nothing here.
pub fn parse_chain_daemon_targets(config_json: &str) -> Result<Vec<DaemonTarget>, String> {
    let v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not JSON: {}", e))?;
    let clients = match v.get("chainclients").and_then(|c| c.as_object()) {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for (coin, cc) in clients {
        let conn = cc
            .get("connection_type")
            .and_then(|x| x.as_str())
            .unwrap_or("none");
        if conn != "rpc" {
            continue;
        }
        let host = cc
            .get("rpchost")
            .and_then(|x| x.as_str())
            .unwrap_or("127.0.0.1")
            .to_string();
        let is_xmr_group = cc.get("core_type_group").and_then(|x| x.as_str()) == Some("xmr");
        let manage_daemon = cc
            .get("manage_daemon")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let chain_datadir = cc
            .get("datadir")
            .and_then(|x| x.as_str())
            .map(PathBuf::from);

        if manage_daemon {
            if let Some(port) = cc.get("rpcport").and_then(|x| x.as_u64()) {
                out.push(DaemonTarget {
                    coin: coin.clone(),
                    kind: if is_xmr_group {
                        DaemonKind::MoneroDaemon
                    } else {
                        DaemonKind::BitcoinRpc
                    },
                    host: host.clone(),
                    port: port as u16,
                    user: cc
                        .get("rpcuser")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    password: cc
                        .get("rpcpassword")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    chain_datadir: chain_datadir.clone(),
                });
            }
        }

        if is_xmr_group
            && cc
                .get("manage_wallet_daemon")
                .and_then(|x| x.as_bool())
                .unwrap_or(false)
        {
            if let Some(port) = cc.get("walletrpcport").and_then(|x| x.as_u64()) {
                out.push(DaemonTarget {
                    coin: format!("{}-wallet", coin),
                    kind: DaemonKind::MoneroWalletRpc,
                    host: cc
                        .get("walletrpchost")
                        .and_then(|x| x.as_str())
                        .unwrap_or("127.0.0.1")
                        .to_string(),
                    port: port as u16,
                    user: cc
                        .get("walletrpcuser")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    password: cc
                        .get("walletrpcpassword")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    chain_datadir: chain_datadir.clone(),
                });
            }
        }
    }
    // Deterministic order so a log line (and a test) reads the same every run.
    // Stop wallet daemons BEFORE the chain daemons they depend on (U-4
    // ordering, adversarial-audit finding): a monero-wallet-rpc wedged on a
    // just-killed monerod can make its own `store`/`stop_wallet` time out. A
    // plain coin-name sort put "monero" (daemon) before "monero-wallet". Give
    // wallet daemons priority 0, everything else 1, then sort by coin so the
    // order stays deterministic for the log and the tests.
    fn stop_priority(k: &DaemonKind) -> u8 {
        match k {
            DaemonKind::MoneroWalletRpc => 0,
            _ => 1,
        }
    }
    out.sort_by(|a, b| {
        stop_priority(&a.kind)
            .cmp(&stop_priority(&b.kind))
            .then_with(|| a.coin.cmp(&b.coin))
    });
    Ok(out)
}

// =========================================================================
// Daemon-port preflight — the offset scan only ever looked at TWO ports
// =========================================================================

/// Whether an `rpchost` names this machine.
///
/// Hoisted out of [`managed_loopback_ports`], where it started life as a
/// nested fn, because [`crate::swap_daemon`] needs the **same** predicate: a
/// daemon-direct send is only ever allowed to a loopback daemon, and two
/// copies of "what counts as loopback" is exactly the drift that turns a
/// safety gate into decoration.
pub(crate) fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// Every **loopback** port the node's own processes will bind under this
/// config: each managed chain daemon's RPC port, plus the ZMQ publishers.
///
/// Returned as `(label, port)` where `label` is human-facing
/// (`"particl rpc"`, `"particl zmq"`), because the whole point of this list is
/// an error message a user can act on.
///
/// Non-loopback hosts are skipped: a remote XMR node's `rpcport` is someone
/// else's socket, and probing it would either succeed (it is *supposed* to be
/// listening) or fail for network reasons — either way it says nothing about
/// whether *we* can bind. Tor `onionport`s are skipped too: with `listen=0`
/// (see [`harden_daemon_confs`]) nothing binds them, so including them would
/// invent conflicts on ports like litecoin's 9333.
pub fn managed_loopback_ports(config_json: &str) -> Result<Vec<(String, u16)>, String> {
    let mut out: Vec<(String, u16)> = Vec::new();
    for t in parse_chain_daemon_targets(config_json)? {
        if is_loopback(&t.host) {
            out.push((format!("{} rpc", t.coin), t.port));
        }
    }

    let v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not JSON: {}", e))?;

    // particld publishes SMSG on the TOP-LEVEL zmqport (prepare.py:2019 writes
    // `PART_ZMQ_PORT + port_offset` there, and the particl.conf gets
    // `zmqpubsmsg=tcp://<zmqhost>:<that>`), so it is not under `chainclients`
    // like every other port. Only ours to claim if we manage particld.
    let particl_managed = v
        .pointer("/chainclients/particl/manage_daemon")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if particl_managed {
        if let Some(p) = v.get("zmqport").and_then(|x| x.as_u64()) {
            if p > 0 && p <= u16::MAX as u64 {
                out.push(("particl zmq".to_string(), p as u16));
            }
        }
    }

    // monerod's own zmq lives under its chainclient.
    if let Some(clients) = v.get("chainclients").and_then(|c| c.as_object()) {
        for (coin, cc) in clients {
            let managed = cc
                .get("manage_daemon")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if !managed {
                continue;
            }
            let host = cc
                .get("rpchost")
                .and_then(|x| x.as_str())
                .unwrap_or("127.0.0.1");
            if !is_loopback(host) {
                continue;
            }
            if let Some(p) = cc.get("zmqport").and_then(|x| x.as_u64()) {
                if p > 0 && p <= u16::MAX as u64 {
                    out.push((format!("{} zmq", coin), p as u16));
                }
            }
        }
    }

    // The node's OWN sockets — the UI/API port the supervisor health-checks
    // and the websocket the frontend's live feed uses.
    //
    // 2026-08-28: these were missing, and their absence is what turned a
    // squatted UI port into the opaque failure this whole function exists to
    // prevent. A container (`docker-swapclient-1`, a SEPARATE BasicSwap
    // install) had published 127.0.0.1:12700 and 127.0.0.1:11700 for 29
    // hours. The daemon ports were all free, so this preflight passed;
    // `run.py` then reached `swap_client.start()`, `HttpThread` could not bind
    // 12700, and run.py's broad `except Exception` printed the traceback to
    // **stderr** — which never reaches `basicswap.log` — before falling
    // through to `finalise()`. The log showed `Starting HTTP server` followed
    // by `Finalising` in the same second, and the user got
    // `Failed{"health timeout"}` a full budget later, naming the one thing
    // that was not wrong. `Exit with Ctrl + c.` (run.py's very next statement
    // after `start()`) appeared 0 times in 2.4 MB of log — that absence is
    // what identified the swallowed raise. See PwndaWalletVault/log.md
    // 2026-08-28.
    //
    // Skipped when the host is not loopback, for the same reason as the
    // daemon ports above: someone else's socket says nothing about ours.
    for (key_host, key_port, label) in [
        ("htmlhost", "htmlport", "node http"),
        ("wshost", "wsport", "node websocket"),
    ] {
        let host = v
            .get(key_host)
            .and_then(|x| x.as_str())
            .unwrap_or("127.0.0.1");
        if !is_loopback(host) {
            continue;
        }
        if let Some(p) = v.get(key_port).and_then(|x| x.as_u64()) {
            if p > 0 && p <= u16::MAX as u64 {
                out.push((label.to_string(), p as u16));
            }
        }
    }

    out.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    out.dedup_by(|a, b| a.1 == b.1);
    Ok(out)
}

/// Pre-spawn check: is any port this config's daemons need already taken?
/// `Some(message)` names every conflict and, where the OS will say, what holds
/// it. `None` means "nothing in the way" **or** "no readable config" — an
/// unreadable config is the spawn's problem to report, not this one's.
///
/// # Why this exists (P3, 2026-08-18 — found on the supervisor's first live run)
///
/// [`select_port_offset`] probes exactly two ports, `html_base + offset` and
/// `ws_base + offset`. But `--portoffset=n` shifts **every** port in the
/// generated config (prepare.py:1308 → `<COIN>_RPC_PORT + ctx.port_offset` in
/// each `interface/*/core.py`), so "offset 0's UI pair is free" says nothing
/// about particl's RPC port. With another BasicSwap holding regtest 19792, the
/// scan happily chose offset 0 and the observable failure was:
///
/// ```text
/// 2026-08-18T18:04:29Z Binding RPC on address 127.0.0.1 port 19792 failed.
/// 2026-08-18T18:04:29Z Unable to bind any endpoint for RPC server
/// ```
///
/// which the *user* never sees, because it lands in particld's own
/// `debug.log`. What reaches the supervisor is 79 seconds of
///
/// ```text
/// WARNING : Error, iteration 61: [Errno 2] No such file or directory: '…\particl.pid'
/// ERROR : Unable to read authcookie for PART, …, datadir pid -1, daemon pid 62632. Error: Mismatched pid
/// ```
///
/// and then `the swap node exited with code 0 before becoming ready` — a
/// message that points at the pid-file wait (U-3) and invites raising
/// `BSX_PID_WAIT_ITERS`, which cannot ever fix it. Probing the config's own
/// ports turns 80 s of misdirection into an immediate, correct sentence.
///
/// Deliberately **fatal**: a bound daemon RPC port has no recovery path inside
/// this start — particld exits before writing its pid file every single time.
pub async fn daemon_port_conflict(datadir: &Path) -> Option<String> {
    let raw = std::fs::read(datadir.join("basicswap.json")).ok()?;
    let text = strip_bom(&raw).ok()?;
    let ports = managed_loopback_ports(text).ok()?;
    let mut conflicts: Vec<String> = Vec::new();
    for (label, port) in ports {
        if crate::wallet_rpc_common::port_is_bound(port).await {
            let holder = match crate::platform::find_pid_holding_port(port).await {
                Some(pid) => match crate::platform::pid_image_name(pid).await {
                    Some(img) => format!(" (held by {} pid {})", img, pid),
                    None => format!(" (held by pid {})", pid),
                },
                None => String::new(),
            };
            conflicts.push(format!("{} port {}{}", label, port, holder));
        }
    }
    if conflicts.is_empty() {
        return None;
    }
    Some(format!(
        "the swap node cannot start: {} already in use. \
         Every one of these ports comes from the node's own basicswap.json, so \
         freeing the port — or changing it in that file — is the only fix. A \
         chain-daemon port exits before writing its pid file (which otherwise \
         reads as a pid-file timeout no wait length can cure); a squatted \
         node http/websocket port makes run.py raise inside start(), which it \
         swallows to stderr, and the only symptom left is a health timeout.",
        conflicts.join(", ")
    ))
}

// =========================================================================
// THE SHUTDOWN LADDER
// =========================================================================

/// The ladder steps, in the only order they may occur.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LadderStep {
    /// (a) ask the python parent to shut itself (and therefore its children) down.
    GracefulParent,
    /// (b) bounded wait for the parent to exit.
    BoundedWait,
    /// (b') INSIDE the bounded wait, once the parent has finalised (closed its
    /// HTTP port) and stayed alive past a short grace: stop the chain daemons
    /// through their own RPCs so the parent's wait on them returns.
    ///
    /// Measured 2026-09-04: every stop took ~124 s because `run.py`'s
    /// `CTRL_C_EVENT` cannot reach a `CREATE_NO_WINDOW` particld, so the
    /// parent sat in `d.handle.wait(timeout=120)` with nothing left to do.
    /// The RPC `stop` is the same graceful path step (c) already uses — this
    /// just sends it while the parent is waiting instead of after it has
    /// given up. The parent still exits on its own, so the stop counts as
    /// clean.
    StopChainDaemonsEarly,
    /// (c) parent hung — stop the chain daemons through their own RPCs.
    StopChainDaemons,
    /// (d) terminate the python parent, last, by PID + image filter.
    TerminateParent,
}

/// Ladder tuning. `max_wait_ms` is the step-(b) ceiling; `finalised_grace_ms`
/// is how long a finalised-but-alive parent gets before (b') fires.
#[derive(Clone, Copy, Debug)]
pub struct LadderConfig {
    pub max_wait_ms: u64,
    pub poll_ms: u64,
    pub finalised_grace_ms: u64,
}

/// Grace between "the parent closed its HTTP port" and the early daemon stop.
/// `finalise()` does a little more after the server thread goes (network stop,
/// pool close, thread joins bounded at 15 s each); three seconds covers the
/// common case, and a parent that legitimately exits inside the grace is seen
/// by the liveness poll first.
pub const LADDER_FINALISED_GRACE_MS: u64 = 3_000;

impl Default for LadderConfig {
    fn default() -> Self {
        Self {
            max_wait_ms: LADDER_WAIT_MS,
            poll_ms: LADDER_POLL_MS,
            finalised_grace_ms: LADDER_FINALISED_GRACE_MS,
        }
    }
}

/// What the ladder did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LadderOutcome {
    /// Steps actually executed, in execution order.
    pub steps: Vec<LadderStep>,
    /// True when the parent exited on its own — i.e. every daemon got the
    /// coordinator's own graceful interrupt and nothing had to be forced.
    pub clean: bool,
    /// Daemons stopped by step (c).
    pub daemons_stopped: usize,
    /// Non-fatal problems, kept for the log/error message.
    pub notes: Vec<String>,
}

/// The side-effecting half of the ladder, behind a trait so the ordering can
/// be driven by a scripted fake in tests.
///
/// Generic (not `dyn`) dispatch on purpose: async-fn-in-trait is not
/// object-safe, and there is exactly one production implementor.
pub trait LadderActions {
    /// (a) Graceful shutdown request to the python parent.
    fn graceful_parent(&self) -> impl std::future::Future<Output = Result<(), String>>;
    /// Is the parent still alive?
    fn parent_alive(&self) -> impl std::future::Future<Output = bool>;
    /// Has the parent reached `finalise()` — closed its HTTP port — and is now
    /// only waiting on its children? The signal (b') keys on.
    fn parent_finalised(&self) -> impl std::future::Future<Output = bool>;
    /// (c) Graceful-stop each managed chain daemon through its own RPC.
    /// Returns how many were stopped.
    fn stop_chain_daemons(&self) -> impl std::future::Future<Output = Result<usize, String>>;
    /// (d) Terminate the python parent by PID with an image-name filter.
    fn terminate_parent(&self) -> impl std::future::Future<Output = Result<(), String>>;
    /// Wait — a seam so tests don't sleep for real.
    fn wait(&self, ms: u64) -> impl std::future::Future<Output = ()>;
}

/// Execute the shutdown ladder. **This function is the definition of the
/// order**; nothing else in this module may stop a daemon or the parent.
///
/// Invariants asserted by the unit tests:
/// * `GracefulParent` is always first, and is attempted even when it fails.
/// * `StopChainDaemons` can only appear after `GracefulParent` **and**
///   `BoundedWait`.
/// * `TerminateParent`, if it happens at all, is last.
pub async fn run_shutdown_ladder<A: LadderActions>(
    actions: &A,
    cfg: LadderConfig,
) -> LadderOutcome {
    let mut steps = Vec::new();
    let mut notes = Vec::new();
    // Per-step timing. The reconcile has twice been reported as the largest
    // item in a slow boot (48.6 s on 2026-09-05) with no way to say WHICH step
    // spent it — the aggregate was the only number anyone had. A ladder that
    // cannot be attributed cannot be optimised, so it now reports itself.
    let ladder_started = std::time::Instant::now();
    let mut step_started = ladder_started;
    let lap = |notes: &mut Vec<String>, step: &str, started: &mut std::time::Instant| {
        let ms = started.elapsed().as_millis();
        if ms >= 250 {
            notes.push(format!("{step} took {:.1}s", ms as f64 / 1000.0));
        }
        *started = std::time::Instant::now();
    };

    // ── (a) graceful ────────────────────────────────────────────────
    steps.push(LadderStep::GracefulParent);
    if let Err(e) = actions.graceful_parent().await {
        // A failed *attempt* still satisfies the ordering rule; what is
        // forbidden is skipping straight to killing something.
        notes.push(format!("graceful shutdown request failed: {}", e));
    }
    lap(&mut notes, "graceful", &mut step_started);

    // ── (b) bounded wait ────────────────────────────────────────────
    steps.push(LadderStep::BoundedWait);
    let mut waited = 0u64;
    let poll = cfg.poll_ms.max(1);
    // (b') bookkeeping: when the parent was first seen finalised, and whether
    // the early daemon stop has already been sent (once, ever).
    let mut finalised_at: Option<u64> = None;
    let mut early_stopped = 0usize;
    let mut early_sent = false;
    loop {
        if !actions.parent_alive().await {
            return LadderOutcome {
                steps,
                clean: true,
                daemons_stopped: early_stopped,
                notes,
            };
        }
        if waited >= cfg.max_wait_ms {
            break;
        }
        if !early_sent {
            if actions.parent_finalised().await {
                let since = *finalised_at.get_or_insert(waited);
                if waited.saturating_sub(since) >= cfg.finalised_grace_ms {
                    early_sent = true;
                    steps.push(LadderStep::StopChainDaemonsEarly);
        lap(&mut notes, "early daemon stop (entered after)", &mut step_started);
                    match actions.stop_chain_daemons().await {
                        Ok(n) => early_stopped = n,
                        Err(e) => notes.push(format!("early chain-daemon graceful stop failed: {}", e)),
                    }
                }
            } else {
                finalised_at = None;
            }
        }
        actions.wait(poll).await;
        waited = waited.saturating_add(poll);
    }
    notes.push(format!(
        "python parent still alive after {} ms — escalating",
        cfg.max_wait_ms
    ));

    // ── (c) chain daemons via their OWN RPCs, never TerminateProcess ─
    steps.push(LadderStep::StopChainDaemons);
    lap(&mut notes, "daemon stop (entered after)", &mut step_started);
    let daemons_stopped = match actions.stop_chain_daemons().await {
        Ok(n) => n.max(early_stopped),
        Err(e) => {
            notes.push(format!("chain-daemon graceful stop failed: {}", e));
            early_stopped
        }
    };

    // ── (d) terminate the parent LAST ───────────────────────────────
    steps.push(LadderStep::TerminateParent);
    lap(&mut notes, "terminate (entered after)", &mut step_started);
    if let Err(e) = actions.terminate_parent().await {
        notes.push(format!("terminating python parent failed: {}", e));
    }

    LadderOutcome {
        steps,
        clean: false,
        daemons_stopped,
        notes,
    }
}

// =========================================================================
// Live implementation of the ladder actions
// =========================================================================

/// Production [`LadderActions`]: HTTP graceful shutdown, TCP liveness probe,
/// per-daemon RPC stops read out of `basicswap.json`, image-filtered taskkill.
pub struct LiveLadder {
    pub html_port: u16,
    pub password: String,
    pub parent_pid: Option<u32>,
    pub datadir: PathBuf,
    /// Image name the PID-filtered kill is allowed to match.
    pub parent_image: String,
}

impl LadderActions for LiveLadder {
    async fn graceful_parent(&self) -> Result<(), String> {
        graceful_shutdown_via_http(self.html_port, &self.password).await
    }

    async fn parent_alive(&self) -> bool {
        // ── THE PORT IS NOT THE PARENT (measured 2026-08-19) ────────────
        //
        // This used to probe `port_is_bound(html_port)`, on the reasoning that
        // "the parent owns the HTTP server thread, so the port going away means
        // the parent exited — strictly stronger than the PID being gone."
        //
        // The opposite is true. Timed against a live node, from the instant the
        // shutdown request returns:
        //
        //     T+  1.5 s   HTTP server stopped   <- port released HERE
        //     T+  1.5 s   Interrupting particld / litecoind / monerod / …
        //     T+121.5 s   ERROR: Waiting for particld.exe to shutdown:
        //                 … timed out after 120 seconds
        //
        // `basicswap.py`'s `finalise` stops the HTTP server FIRST and only then
        // interrupts the daemons — and those interrupts are `CTRL_C_EVENT`,
        // which cannot reach a `CREATE_NO_WINDOW` child (the exact mechanism
        // `sweep_prepare_daemons` already documents for prepare; it applies to
        // the run path too). So the parent sits in a 120-s-per-daemon wait that
        // never completes, with the port closed the whole time.
        //
        // A port probe therefore reports "parent gone" ~1.5 s in, the ladder
        // returns `clean: true` after [GracefulParent, BoundedWait], steps (c)
        // and (d) never run — and python, particld, litecoind, monerod and
        // monero-wallet-rpc are all still alive. Confirmed by watching all five
        // survive 180 s after a successful shutdown request.
        //
        // This is the failure this ladder exists to prevent, and it was hiding
        // behind the auth bug in `graceful_shutdown_via_http`: while step (a)
        // could never succeed, the port never closed early, so the probe never
        // got the chance to lie. Fixing the login without fixing this would
        // have converted a working-by-accident teardown into a guaranteed
        // orphan.
        //
        // So: ask about the PROCESS. The port is only a fallback for the case
        // where no pid was recorded (an orphan adopted from a previous
        // session), where a false "alive" is the safe direction — it costs a
        // bounded wait and then runs the rest of the ladder anyway.
        match self.parent_pid {
            Some(pid) => match crate::platform::pid_image_name(pid).await {
                // Image-checked so a recycled PID cannot make an unrelated
                // process look like our parent — the same guard
                // `terminate_parent` uses before it kills anything.
                Some(image) => image.eq_ignore_ascii_case(&self.parent_image),
                None => false,
            },
            None => crate::wallet_rpc_common::port_is_bound(self.html_port).await,
        }
    }

    async fn parent_finalised(&self) -> bool {
        // The HTTP port closing is the one thing finalise() does that is
        // visible from outside, and it does it FIRST (measured 2026-08-19:
        // "T+1.5 s HTTP server stopped"). It is deliberately NOT the liveness
        // signal — see `parent_alive` — only the "now waiting on children"
        // signal that (b') keys on.
        !crate::wallet_rpc_common::port_is_bound(self.html_port).await
    }

    async fn stop_chain_daemons(&self) -> Result<usize, String> {
        let cfg_path = self.datadir.join("basicswap.json");
        let raw = std::fs::read_to_string(&cfg_path)
            .map_err(|e| format!("cannot read {}: {}", cfg_path.display(), e))?;
        let targets = parse_chain_daemon_targets(&raw)?;
        // CONCURRENT. Each stop is an independent RPC with its own 15 s
        // timeout, and serially a boot-time reconcile paid them one after
        // another — the 48.6 s reconcile of 2026-09-05 was mostly two daemons
        // timing out back to back. The cost is now the slowest one.
        let results =
            futures_util::future::join_all(targets.iter().map(stop_daemon_gracefully)).await;
        let stopped = results.iter().filter(|r| r.is_ok()).count();
        // Let LevelDB finish flushing before anyone considers the tree dead.
        tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
        Ok(stopped)
    }

    async fn terminate_parent(&self) -> Result<(), String> {
        let Some(pid) = self.parent_pid else {
            return Err("no recorded parent pid".to_string());
        };
        #[cfg(target_os = "windows")]
        {
            let code =
                crate::platform::kill_process_by_pid_and_image(pid, &self.parent_image)
                    .await?;
            // 128 = "no process matched the filter", which is the desired
            // end state (already gone, or the PID was recycled).
            if code == 0 || code == 128 {
                Ok(())
            } else {
                Err(format!("taskkill returned {}", code))
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = pid;
            Err("terminate_parent is only implemented on Windows".to_string())
        }
    }

    async fn wait(&self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

/// Ladder step (a): **log in**, render a page to mint the one-shot shutdown
/// token, then call `/shutdown/<token>`.
///
/// A CTRL_BREAK to the process group is deliberately **not** used as the
/// primary path: the parent is spawned with `CREATE_NO_WINDOW`, so there is no
/// console attached to that group for `GenerateConsoleCtrlEvent` to deliver
/// through, and upstream's `run.py` registers its SIGINT handler expecting a
/// console (run.py:604-606). HTTP is the path upstream itself exposes.
///
/// # The login is not optional, and leaving it out made this step dead code
///
/// (Found 2026-08-19 by fetching `/` against a live node and finding no token
/// in 14,807 bytes of HTML.) Upstream has **two independent** auth mechanisms
/// and they do not compose the way the API surface suggests:
///
/// * `Authorization: Basic` is checked at the request gate
///   (`http_server.py:985-997`) — it is what stops `/json/*` returning 401,
///   and it is what [`health_check`] relies on.
/// * `render_template` decides which page to draw from
///   `is_authenticated() or not client_auth_hash` (`http_server.py:441`), and
///   `is_authenticated()` reads **only the session cookie**
///   (`http_server.py:322-336`). Basic auth never sets one.
///
/// So with a `client_auth_hash` configured — which this supervisor always
/// configures — `GET /` carrying only Basic auth returns **200 with the Login
/// page**, and the shutdown link lives in `header.html`, which the Login page
/// does not include. The token is minted server-side on every render and
/// stashed in `session_tokens["shutdown"]`, so it exists; it is simply never
/// disclosed to us. `extract_shutdown_token` then returns `None` and step (a)
/// fails **every single time**, on every install, for the whole life of this
/// module.
///
/// The ladder tolerates a failed step (a) by design, so this never surfaced as
/// an error — it surfaced as every shutdown silently escalating to steps (c)
/// and (d). Which is also why fixing this **alone** would have been worse than
/// leaving it broken: see [`LadderActions::parent_alive`] for the port-vs-PID
/// trap a *working* graceful request springs.
///
/// `POST /login` with a JSON body answers 200 + `Set-Cookie`
/// (`http_server.py:600-641`); the cookie is carried by hand rather than
/// through a `cookie_store`, so the one header this depends on is visible here
/// instead of behind a reqwest feature flag.
/// `Set-Cookie` name=value pairs from a successful `POST /login`.
///
/// Split out of [`graceful_shutdown_via_http`], which proved the flow: upstream
/// answers the JSON login with 200 + `Set-Cookie: basicswap_session_id=…`
/// (`http_server.py:624-632`), and a redirect-following client would swallow
/// that header — which is why the caller's `Client` must carry
/// `redirect::Policy::none()`.
///
/// Only the `name=value` prefix of each cookie survives: `Path`, `HttpOnly` and
/// `SameSite` are RESPONSE attributes, and a request `Cookie:` header carrying
/// them is malformed.
pub async fn login_for_session(
    client: &reqwest::Client,
    port: u16,
    password: &str,
) -> Result<String, String> {
    let login = client
        .post(format!("http://127.0.0.1:{}/login", port))
        .header("Authorization", basic_auth_header(password))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "password": password }).to_string())
        .send()
        .await
        .map_err(|e| format!("could not reach the node to log in: {}", e))?;
    if !login.status().is_success() {
        return Err(format!(
            "the swap node rejected the stored console credential (HTTP {})",
            login.status().as_u16()
        ));
    }
    let cookie = cookie_pairs_from(
        login
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok()),
    );
    if cookie.is_empty() {
        return Err("login succeeded but set no session cookie".to_string());
    }
    Ok(cookie)
}

/// `Set-Cookie` values -> a `Cookie:` request header value.
///
/// Pure so the attribute-stripping is testable without a server: a cookie whose
/// value legitimately contains `;`-free base64 must survive intact, and the
/// attributes must not.
pub fn cookie_pairs_from<'a>(values: impl Iterator<Item = &'a str>) -> String {
    values
        .filter_map(|v| v.split(';').next())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty() && v.contains('='))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The page whose HTML carries `/shutdown/<token>`.
///
/// **Not `/`** (2026-09-05). Upstream's `page_index` does not render anything:
/// it answers `302 → /offers` with an EMPTY BODY (`http_server.py:939`), and
/// this client runs `redirect::Policy::none()` — deliberately, so the login's
/// `Set-Cookie` cannot be dropped by a redirect. So the scrape was reading an
/// empty string on every attempt and reporting
/// `no shutdown token in the node's index page (is the session cookie being
/// rejected?)` — a diagnostic that pointed at auth when the truth was that
/// there was no page.
///
/// The cost was not cosmetic. Graceful shutdown failed at **every app exit**,
/// so the exit ladder escalated to `TerminateParent` every time, and the next
/// start found a stale instance and spent up to 41 s reconciling it. That is
/// the single largest item in a 129-second boot, and it had been failing since
/// at least the p22 runtime — every staged engine back to it carries the same
/// redirect.
///
/// `offers` is where `/` points, is what the console already loads first, and
/// renders `header.html`, which is the only template that carries the token.
const SHUTDOWN_TOKEN_PAGE: &str = "offers";

pub async fn graceful_shutdown_via_http(port: u16, password: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        // The login answers 302 to /offers in form mode; JSON mode answers 200,
        // but do not follow redirects in either case — a redirect chain here
        // would silently swallow the Set-Cookie we came for.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let auth = basic_auth_header(password);
    let cookie = login_for_session(&client, port, password).await?;

    let index = client
        .get(format!("http://127.0.0.1:{}/{}", port, SHUTDOWN_TOKEN_PAGE))
        .header("Authorization", &auth)
        .header("Cookie", &cookie)
        .send()
        .await
        .map_err(|e| format!("could not reach the node to shut it down: {}", e))?
        .text()
        .await
        .map_err(|e| format!("could not read the node's index page: {}", e))?;

    let token = extract_shutdown_token(&index).ok_or_else(|| {
        "no shutdown token in the node's index page (is the session cookie being rejected?)"
            .to_string()
    })?;

    let resp = client
        .get(format!("http://127.0.0.1:{}/shutdown/{}", port, token))
        .header("Authorization", &auth)
        .header("Cookie", &cookie)
        .send()
        .await
        .map_err(|e| format!("shutdown request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("shutdown returned HTTP {}", resp.status().as_u16()));
    }
    Ok(())
}

/// Ladder step (c) for one daemon. Always a **graceful RPC**, never a kill.
async fn stop_daemon_gracefully(t: &DaemonTarget) -> Result<(), String> {
    match t.kind {
        DaemonKind::BitcoinRpc => {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| format!("http client build failed: {}", e))?;
            let mut req = client
                .post(format!("http://{}:{}/", t.host, t.port))
                .json(&serde_json::json!({
                    "jsonrpc": "1.0", "id": "pwnda", "method": "stop", "params": []
                }));
            // Static credentials if the config has them; otherwise the daemon's
            // own auth cookie, which is what a generated bitcoin-family
            // chainclient actually uses. Without this the request is anonymous
            // and particld answers 401 — see [`cookie_auth`].
            let cookie = match (t.user.as_ref(), t.password.as_ref()) {
                (Some(_), Some(_)) => None,
                _ => t.chain_datadir.as_deref().and_then(cookie_auth),
            };
            if let (Some(u), Some(p)) = (t.user.as_ref(), t.password.as_ref()) {
                req = req.basic_auth(u, Some(p));
            } else if let Some((u, p)) = cookie.as_ref() {
                req = req.basic_auth(u, Some(p));
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("{} stop failed: {}", t.coin, e))?;
            if resp.status().is_success() {
                Ok(())
            } else {
                Err(format!("{} stop returned {}", t.coin, resp.status()))
            }
        }
        DaemonKind::MoneroDaemon => {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| format!("http client build failed: {}", e))?;
            let resp = client
                .post(format!("http://{}:{}/stop_daemon", t.host, t.port))
                .send()
                .await
                .map_err(|e| format!("{} stop_daemon failed: {}", t.coin, e))?;
            if resp.status().is_success() {
                Ok(())
            } else {
                Err(format!("{} stop_daemon returned {}", t.coin, resp.status()))
            }
        }
        DaemonKind::MoneroWalletRpc => {
            // Reuse the Digest-aware raw-TCP caller — monero-wallet-rpc's
            // nonces are connection-scoped, which is why this path exists at
            // all (see wallet_rpc_common's module docs).
            let creds = match (t.user.as_ref(), t.password.as_ref()) {
                (Some(u), Some(p)) => Some((u.clone(), p.clone())),
                _ => None,
            };
            let url = format!("http://{}:{}/json_rpc", t.host, t.port);
            // `store` first so scan state hits disk even if the stop times
            // out — same reasoning as xmr_rpc.rs:735-758.
            let _ = crate::wallet_rpc_common::do_rpc_call_at(
                &url,
                creds.as_ref(),
                "store",
                serde_json::json!({}),
                std::time::Duration::from_secs(10),
            )
            .await;
            crate::wallet_rpc_common::do_rpc_call_at(
                &url,
                creds.as_ref(),
                "stop_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(10),
            )
            .await
            .map(|_| ())
            .map_err(|e| format!("{} stop_wallet failed: {}", t.coin, e))
        }
    }
}

// =========================================================================
// Credentials + opt-in custody
// =========================================================================

/// Read the per-install API password, generating and persisting one on first
/// use. Never leaves the backend.
pub fn read_or_create_auth_password(app: &AppHandle) -> Result<String, String> {
    let path = credsfile(app)?;
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let pwd = crate::wallet_rpc_common::random_hex(24);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
    }
    std::fs::write(&path, &pwd)
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    Ok(pwd)
}

/// The opt-in record. Deliberately a file, not a store key: the *backend* is
/// what must refuse to prepare or spawn before consent, so the backend owns
/// the fact.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OptInRecord {
    pub opted_in: bool,
    /// RFC3339 timestamp of the decision.
    pub at: Option<String>,
    /// Start the node when the wallet starts, instead of waiting for the
    /// Settings card's Start button.
    ///
    /// Defaults to **false** and `#[serde(default)]` so a record written before
    /// this field existed keeps meaning "manual" — the subsystem costs five
    /// processes and a chain sync, which is not something to switch on for
    /// somebody who opted in once and swaps twice a year.
    #[serde(default)]
    pub autostart: bool,
    /// Keep the full chain and both transaction indexes instead of pruning.
    ///
    /// A **one-time setup choice**, not a live toggle: particl-core cannot add
    /// `txindex`/`spentindex` to a chain that was pruned, nor prune one that
    /// has them, so this can only be honoured at the first prepare. Flipping it
    /// afterwards would be a preference the node can never act on.
    ///
    /// Defaults to **false** — pruned — because the two indexes serve only
    /// PART-as-a-swap-leg, which this wallet does not offer, and they cost
    /// ~1.6 GB. Someone who wants to trade PART itself needs them, which is the
    /// entire reason the choice exists.
    #[serde(default)]
    pub archival_chain: bool,
    /// Which wallet's seed created this engine datadir — see
    /// [`seed_fingerprint`]. `None` on installs prepared before this existed,
    /// which is treated as "unknown", never as "matches".
    #[serde(default)]
    pub swap_seed_fingerprint: Option<String>,
    /// C5 - the engine's wallets are known to be encrypted.
    ///
    /// Set when a wallet key is pushed (`swap_sidecar_set_wallet_key`) — the
    /// only reason a key exists is that encryption was set up. Read by
    /// [`build_config`] so a KEYLESS start can know an `--addcoin` is doomed
    /// before paying for it: prepare must read the master key out of the
    /// Particl wallet, and against an encrypted wallet with no
    /// `WALLET_ENCRYPTION_PWD` it fails after ~2 minutes of daemon start/stop
    /// — per coin, per boot, forever, because reconcile has no memory
    /// (observed live 2026-08-20: bitcoin + litecoin, every launch).
    ///
    /// `#[serde(default)]` = false: an install that never pushed a key keeps
    /// the old behaviour (attempt the addcoin), which is correct for the
    /// pre-C5 unencrypted population.
    #[serde(default)]
    pub wallet_encrypted: bool,
    /// C3 - per-coin DEX enablement, keyed by the engine's lowercase coin name.
    ///
    /// `#[serde(default)]` is load-bearing and NOT cosmetic: a pre-C3 record
    /// deserializes with an EMPTY map, and an empty map means *every seedable
    /// coin is enabled* (legacy). See [`enabled_coins`] for the full rule and
    /// [`materialize_coin_map`] for why the first explicit toggle has to freeze
    /// the effective set before it writes.
    #[serde(default)]
    pub coins: std::collections::BTreeMap<String, CoinOptIn>,
}

/// C8 - which coins are set up to share the wallet's own keys, as lowercase
/// tickers for `BSX_PWNDA_ACCOUNT_KEY_COINS`.
///
/// Pure, and deliberately strict on all four conditions at once: the coin must
/// be electrum-capable (nothing else can run lean), actually in lean mode
/// (a full-mode coin adopts by descriptor import instead — C3.5), explicitly
/// enabled, and carry an explicit [`CoinOptIn::share_wallet_ack_at`].
///
/// The strictness is the safety: naming a coin here makes the engine REFUSE to
/// stand its wallet up without a pushed key, so a coin listed by accident does
/// not get the wrong wallet — it gets no wallet, visibly.
///
/// # Why CONSENT and not [`Adoption::AccountKey`]
///
/// Adoption is written only after a push has been verified, so keying on it
/// would leave the guard disarmed on exactly the run that needs it most: the
/// first one after the user opts in. The engine would reach its lazy
/// initialisation before any key arrived, build a wallet from its OWN seed
/// because nothing told it not to, and the later push would then RE-initialise
/// over it. Consent is known before the node starts; verification is not.
/// Driving the guard from intent is what makes the first run behave like every
/// other one.
/// Does this coin's LEAN wallet use the user's own account keys? (C8)
///
/// Pure, and the single place the three inputs are combined:
///
/// 1. **opted in** — no consent to the DEX at all means no consent to
///    anything downstream of it;
/// 2. **enabled AND in lean mode** — a full-mode coin adopts by descriptor
///    import (C3.5) instead, and a disabled coin shares nothing;
/// 3. **not explicitly declined** — see
///    [`CoinOptIn::share_wallet_declined_at`] for why the NO needs its own
///    field once the default is YES.
///
/// Note what is deliberately NOT consulted: `share_wallet_ack_at`. Since
/// 2026-08-20 the DEX opt-in carries the disclosure and the consent, so an
/// untouched coin shares. The ack timestamp survives as an audit trail of
/// who pressed what, not as the gate.
///
/// The caller supplies `opted_in` rather than this reading it off a record,
/// so the rule can be exercised against every combination without building
/// one — the same shape as [`should_autostart`] and
/// [`xmr_shared_wallet_in_use`].
/// A one-way fingerprint of the engine's seed phrase.
///
/// Recorded when the sidecar datadir is first prepared, so a LATER session can
/// tell whether the engine wallet it is about to use belongs to the wallet the
/// user is currently on.
///
/// **Why this exists.** The datadir is a single fixed path with no wallet id in
/// it (`sidecar_base_dir`), and `--particl_mnemonic` reaches upstream on
/// prepare's argv only. So the engine's Particl wallet is created ONCE, from
/// whichever vault was active at first prepare, and keeps those keys forever
/// across wallet switches. Meanwhile `swap_sidecar_push_account_keys` would
/// happily push the NEWLY-active wallet's BTC/LTC account keys into that old
/// engine wallet — a cross-wallet mismatch that reaches funds, not a display
/// bug. This turns it from silent into refused.
///
/// One-way and truncated: the fingerprint is stored in a plaintext opt-in
/// record, so it must not be reversible to a seed and must not be usable as a
/// seed-equality oracle beyond this narrow check.
pub fn seed_fingerprint(mnemonic: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalised = mnemonic.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut h = Sha256::new();
    h.update(b"pwnda-swap-seed-v1:");
    h.update(normalised.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

pub fn shares_lean_wallet(opted_in: bool, entry: &CoinOptIn) -> bool {
    opted_in
        && entry.enabled
        && entry.mode == CoinMode::Lean
        && entry.share_wallet_declined_at.is_none()
}

/// Is the engine's MAIN Monero wallet pointed at the user's own
/// `monero-wallet-rpc`? (C9)
///
/// Same default-on rule as [`shares_lean_wallet`], and the same reason the
/// decline needs its own field. `coin` must be the monero entry; nothing here
/// checks that, because the only caller keys the map by `"monero"` — see
/// [`swap_sidecar_set_xmr_host_wallet`], which refuses every other coin.
///
/// Mode is not consulted: monero has no lean/full choice in this sense (it
/// runs against a remote node, which is why its `est_disk_gb` is zero), so
/// gating on `CoinMode` here would silently never fire.
pub fn shares_xmr_host_wallet(opted_in: bool, entry: &CoinOptIn) -> bool {
    opted_in && entry.enabled && entry.xmr_host_wallet_declined_at.is_none()
}

/// Is the engine's main Zephyr wallet pointed at the user's own
/// `zephyr-wallet-rpc`? Same shape as [`shares_xmr_host_wallet`] — `coin` must
/// be the `"zephyr"` entry; nothing here checks that, so the caller (C-RZ's
/// activation path) is what scopes it. Mode is not consulted for the same
/// reason it is not for XMR: Zephyr has no lean/full choice at all (it is
/// never [`ELECTRUM_CAPABLE`]), so gating on [`CoinMode`] here would silently
/// never fire.
pub fn shares_zph_host_wallet(opted_in: bool, entry: &CoinOptIn) -> bool {
    opted_in && entry.enabled && entry.zph_host_wallet_declined_at.is_none()
}

/// Zano's twin of [`shares_zph_host_wallet`]. `coin` must be the `"zano"`
/// entry.
pub fn shares_zano_host_wallet(opted_in: bool, entry: &CoinOptIn) -> bool {
    opted_in && entry.enabled && entry.zano_host_wallet_declined_at.is_none()
}

pub fn adoption_coins(rec: &OptInRecord) -> Vec<String> {
    ELECTRUM_CAPABLE
        .iter()
        .filter_map(|(coin, _)| {
            let entry = rec.coins.get(*coin)?;
            if shares_lean_wallet(rec.opted_in, entry) {
                // PWNDA-PATCH-3 compares against `Coins(coin_type).name.lower()`,
                // i.e. the TICKER lowercased - not the engine's coin name. A
                // "bitcoin" here would silently match nothing and the fail-closed
                // guard would never arm.
                Some(ticker_for(coin).to_ascii_lowercase())
            } else {
                None
            }
        })
        .collect()
}

/// Env override for [`OptInRecord::autostart`], for the `tauri dev` loop.
///
/// Set (to anything but `0`/`false`/empty) it forces autostart on **without
/// touching the persisted record**, so a dev session cannot silently change
/// what the installed wallet does. It does **not** override `opted_in`: consent
/// is still consent, and the dev launcher seeds that record explicitly rather
/// than the code weakening the gate. See `scripts/swap/dev-sidecar-env.mjs`.
pub const AUTOSTART_ENV: &str = "PWNDA_SWAP_SIDECAR_AUTOSTART";

/// Whether a launch should start the node by itself.
///
/// Pure so the precedence is testable: consent is mandatory and neither source
/// can grant it; the env var can only turn autostart **on**, never off, because
/// its whole purpose is to add a behaviour to a dev run.
pub fn should_autostart(rec_opted_in: bool, rec_autostart: bool, env_flag: Option<&str>) -> bool {
    if !rec_opted_in {
        return false;
    }
    let env_on = match env_flag {
        None => false,
        Some(v) => {
            let v = v.trim();
            !(v.is_empty() || v == "0" || v.eq_ignore_ascii_case("false"))
        }
    };
    rec_autostart || env_on
}

pub fn read_optin(app: &AppHandle) -> OptInRecord {
    let Ok(path) = optin_file(app) else {
        return OptInRecord::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<OptInRecord>(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn write_optin(app: &AppHandle, rec: &OptInRecord) -> Result<(), String> {
    let path = optin_file(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("cannot write {}: {}", path.display(), e))
}

// =========================================================================
// C3 — per-coin DEX enablement + the selection gate (R9)
// =========================================================================

/// How a coin's pre-existing funds reach the swap node.
///
/// Frozen spelling: serialized lowercase (`"descriptor"`, `"hostwallet"`),
/// which is what `src/api/basicswap.ts`'s `DexAdoption` union expects — that
/// TS union does not carry `"hostwallet"` yet as of this enum gaining
/// [`Adoption::HostWallet`] (Grove expansion plan, Phase C, unit C-R0); the TS
/// side is a separate unit's (`C-T1`) job, not this one's, and reads
/// `adoption` as an opaque string for any coin it does not special-case, so
/// the two sides do not need to land in the same commit for either to compile
/// — but they must land before ANY code sets a ZEPH/ZANO entry's `adoption`
/// to `HostWallet` in a build the webview also runs.
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Adoption {
    /// C3.5 — the user's account descriptors are imported so the node can
    /// spend what is already there. Zero on-chain movement.
    Descriptor,
    /// The coin cannot take a descriptor import, so funds move once.
    Consolidate,
    /// C8 - the coin runs LEAN, and the engine's own wallet was initialised
    /// from the wallet's **account key**, so the two are one wallet.
    ///
    /// Distinct from [`Adoption::Descriptor`] in mechanism and in what it
    /// needs: there is no daemon and therefore no daemon wallet to import
    /// descriptors into, so the sharing happens at the key layer instead
    /// (`upstream/patches/0003`). Distinct from [`Adoption::Deposit`] in the
    /// only way a user cares about — nothing has to be sent anywhere.
    AccountKey,
    /// C9-shaped — the engine's main wallet for this coin IS a wallet-rpc (or
    /// JWT-RPC) process the user's own app runs, rather than a wallet the
    /// engine built itself. Zero on-chain movement, like [`Adoption::Descriptor`]
    /// and [`Adoption::AccountKey`], but at neither the daemon layer nor the
    /// key layer — the engine is simply pointed at a process it does not own.
    ///
    /// Introduced for ZEPH and ZANO, which have neither a C8 option (not
    /// [`ELECTRUM_CAPABLE`]) nor a C3.5 option (no local daemon wallet to
    /// import into — Grove always runs their daemons remotely): this is their
    /// ONLY adoption mechanism. Generalises XMR's C9 mechanism, which predates
    /// this variant and still reports itself out-of-band via
    /// `CoinEnableStatus::xmr_host_wallet_active` rather than through this
    /// enum (see [[wallet-sharing-with-bsx]], [[c9-xmr-lifecycle-design]]) —
    /// that stays as-is here; migrating it is a separate decision, not a side
    /// effect of adding a second and third host-wallet coin.
    ///
    /// **Verified, not intent**, exactly like [`Adoption::AccountKey`]: set
    /// only once a coin's host-wallet activation is confirmed against the
    /// config the node actually booted from — never by
    /// [`shares_zph_host_wallet`]/[`shares_zano_host_wallet`] alone, which are
    /// consent gates, not verification.
    HostWallet,
    /// Nothing is adopted; the user funds the node by depositing.
    ///
    /// **The default**, because it is the only mode that is always available,
    /// and because a wrong default here reads as "your keys are already in the
    /// swap node" when they are not.
    #[default]
    Deposit,
}

/// Does the pre-share balance gate apply to a coin in this adoption state?
///
/// The gate exists for ONE situation: the engine built this coin's wallet from
/// its own seed, funds landed on those addresses, and installing the host's
/// account key would make PWNDA-PATCH-3 discard the address table that watches
/// them. That is real, and for `Deposit` / `HostWallet` it stays enforced.
///
/// [`Adoption::AccountKey`] is the one state where it cannot be true.
/// It is VERIFIED, not intent: the engine was confirmed to have built this
/// wallet from THIS host's account key. A re-push rebuilds the same table from
/// the same key, and the balance the gate would call "stranded" is already in
/// the user's own wallet. `swap_sidecar_push_account_keys` refuses outright
/// when the session's seed differs from the datadir's, which is what makes
/// "the same key" a fact rather than an assumption.
///
/// Pinned 2026-09-08. A share pass runs on every node start for every sharing
/// coin, adopted ones INCLUDED -- and must, because PATCH-3 needs the key
/// again to rebuild the wallet after a restart. With the gate applied
/// unconditionally, a node with BTC, LTC and BCH all adopted and all funded
/// produced three red errors on every start, telling the user to sweep back
/// first. They could not: `sweepableCoins` excludes adopted coins on purpose,
/// because for those a sweep is a fee-paying self-transfer. Gate said sweep,
/// sweep list said nothing to sweep.
pub fn balance_gate_applies(adoption: &Adoption) -> bool {
    !matches!(adoption, Adoption::AccountKey)
}

/// One coin's explicit choice inside [`OptInRecord::coins`].
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoinOptIn {
    pub enabled: bool,
    /// RFC3339 of the decision.
    pub at: Option<String>,
    #[serde(default)]
    pub adoption: Adoption,
    /// RFC3339 of a successful C3.5 import.
    #[serde(default)]
    pub descriptors_imported_at: Option<String>,
    /// The node has begun syncing this chain at least once.
    ///
    /// R12's only guard: a pruned node cannot rescan history it has discarded,
    /// so a descriptor import issued after first sync returns `success: true`
    /// per descriptor and finds nothing. Set by [`mark_first_sync_started`]
    /// once the node reports healthy with the coin configured.
    #[serde(default)]
    pub first_sync_started: bool,
    /// C7 - whether this coin runs a local chain. See [`CoinMode`].
    ///
    /// `#[serde(default)]` lands on [`CoinMode::Lean`], which is deliberate for
    /// records written before C7: those installs have no mode recorded, and
    /// [`swap_sidecar_set_coin_mode`]'s R20 refuses to change a coin already in
    /// `basicswap.json`, so an existing full node keeps running full. The
    /// default only decides what a NEWLY enabled coin does.
    #[serde(default)]
    pub mode: CoinMode,
    /// C8 — RFC3339 of the user's explicit "use my existing wallet for this
    /// coin" decision, or `None`.
    ///
    /// **Consent, not state.** [`CoinOptIn::adoption`] records what the engine
    /// was VERIFIED to have done; this records what the user asked for. The
    /// two are deliberately separate because they arm different things: the
    /// claim in the UI needs the fact, and the fail-closed env guard needs the
    /// intent — see [`adoption_coins`].
    ///
    /// `#[serde(default)]` = `None`: every record written before C8 reads as
    /// "never consented", which is the only safe default. Enabling a coin is
    /// not consent to share its keys, and a coin enabled before this field
    /// existed must not be treated as if its owner had seen the disclosure.
    #[serde(default)]
    pub share_wallet_ack_at: Option<String>,
    /// C8 — RFC3339 of an explicit "do NOT use my wallet for this coin".
    ///
    /// # Why sharing defaults ON, and why the OFF switch needs its own field
    ///
    /// Opting into the DEX *is* the decision to swap with this wallet — that
    /// is the product's whole thesis, and a second per-coin confirmation was
    /// friction the operator correctly rejected (2026-08-20). So an
    /// enabled, lean, electrum-capable coin shares by default and the
    /// disclosure lives in the opt-in wizard, where the one decision is made.
    ///
    /// That inversion is exactly why "never chose" and "chose no" can no
    /// longer be the same value. With sharing default-on, a null
    /// [`Self::share_wallet_ack_at`] means "hasn't touched it, so share" —
    /// which would silently re-enable sharing for a user who deliberately
    /// turned it off, on the next write that re-materialised their coin map.
    /// This field is the durable NO. [`shares_lean_wallet`] is the only
    /// place the two are combined.
    #[serde(default)]
    pub share_wallet_declined_at: Option<String>,
    /// C9 — RFC3339 of the user's explicit "point the swap engine's Monero
    /// wallet at my own monero-wallet-rpc" decision. Only meaningful on the
    /// `"monero"` entry.
    ///
    /// **Deliberately a SEPARATE field from [`Self::share_wallet_ack_at`],**
    /// not a reuse of it for a second coin. The two consents authorise
    /// mechanistically different things — C8 hands the engine an ACCOUNT KEY
    /// so its own lean wallet becomes the user's; C9 repoints the engine at a
    /// wallet-rpc PROCESS the user's own app already runs, with per-swap
    /// wallets kept on the engine's own second client (`PWNDA-PATCH-5`).
    /// Reusing one flag for both would mean the SAME toggle silently means
    /// two different security properties depending on which coin it's read
    /// for — exactly the "a precondition copied from a neighbouring
    /// operation" shape this project's bug log names by number, and the third
    /// copy-contradiction this session alone would have produced had it been
    /// caught later instead of avoided here.
    ///
    /// monero is in [`DEFAULT_ENABLED_COINS`] — most installs have it enabled
    /// from first run — so this field existing and defaulting to `None` is
    /// what stops every existing user's XMR wallet from being silently
    /// repointed the moment C9's config writer is wired to the start path.
    #[serde(default)]
    pub xmr_host_wallet_ack_at: Option<String>,
    /// C9 — RFC3339 of an explicit "do NOT point the engine at my Monero
    /// wallet". The durable NO, for the same reason as
    /// [`Self::share_wallet_declined_at`]; see [`shares_xmr_host_wallet`].
    ///
    /// Monero shares by default too (operator's call, 2026-08-20), which
    /// carries a consequence the other coins' sharing does not: Lock Wallet
    /// and Forget Monero refuse while a swap is in flight. The opt-in wizard
    /// must therefore disclose that, not just the Electrum privacy cost.
    #[serde(default)]
    pub xmr_host_wallet_declined_at: Option<String>,

    /// C9-shaped — RFC3339 of the user's explicit "point the swap engine's
    /// Zephyr wallet at my own `zephyr-wallet-rpc`" decision. Only meaningful
    /// on the `"zephyr"` entry.
    ///
    /// Zephyr has no C8 option (not [`ELECTRUM_CAPABLE`]) and no C3.5 option
    /// (no local daemon wallet to import descriptors into — Grove always
    /// points the daemon at a remote node), so this is its ONLY sharing
    /// mechanism, structurally identical to XMR's C9
    /// ([`Self::xmr_host_wallet_ack_at`]). **Deliberately its OWN field, not a
    /// reuse of the XMR one** — reusing one flag across coins is the exact
    /// "same toggle silently means two different security properties" shape
    /// [`Self::xmr_host_wallet_ack_at`]'s own doc comment names, and reusing
    /// ZEPH's flag for ZANO (or vice versa) would be the same mistake a third
    /// time. See [[wallet-sharing-with-bsx]], [[c9-xmr-lifecycle-design]] for
    /// the proven pattern this follows.
    #[serde(default)]
    pub zph_host_wallet_ack_at: Option<String>,
    /// C9-shaped — RFC3339 of an explicit "do NOT point the engine at my
    /// Zephyr wallet". The durable NO twin of
    /// [`Self::zph_host_wallet_ack_at`], for the same reason
    /// [`Self::xmr_host_wallet_declined_at`] needs its own field: sharing
    /// defaults on once the coin is enabled (the DEX-coins card carries the
    /// disclosure), so "never touched" and "said no" must not collapse into
    /// one value.
    #[serde(default)]
    pub zph_host_wallet_declined_at: Option<String>,

    /// Zano's twin of [`Self::zph_host_wallet_ack_at`]. Only meaningful on the
    /// `"zano"` entry — Zano's main wallet is a stock `simplewallet` shared
    /// the same C9-shaped way, over JWT rather than HTTP Digest (see
    /// `src-tauri/src/zano_rpc.rs`).
    #[serde(default)]
    pub zano_host_wallet_ack_at: Option<String>,
    /// The durable NO twin of [`Self::zano_host_wallet_ack_at`].
    #[serde(default)]
    pub zano_host_wallet_declined_at: Option<String>,
}

/// Engine coin name -> UPPERCASE ticker, for every coin in
/// [`WALLET_SIDECAR_COINS`].
///
/// Two spellings exist for the same coin and both reach this module: the
/// engine's `chainclients` key (`bitcoincash`) and the ticker the wallet UI
/// uses (`BCH`). [`coin_key_from`] collapses them so a caller cannot half-work
/// by picking the wrong one.
pub const COIN_TICKERS: &[(&str, &str)] = &[
    ("particl", "PART"),
    ("bitcoin", "BTC"),
    ("litecoin", "LTC"),
    ("monero", "XMR"),
    ("dogecoin", "DOGE"),
    ("dash", "DASH"),
    ("bitcoincash", "BCH"),
    ("zephyr", "ZEPH"),
    ("zano", "ZANO"),
];

/// The coin that is never optional: `particl` carries SMSG, the only transport
/// offers and bids travel over. A config without it is not a swap node.
pub const MANDATORY_COIN: &str = "particl";

/// What a **fresh** install gets enabled on consent (P1: light by default,
/// heavy only on an explicit per-coin opt-in).
///
/// `particl` because it is mandatory; `monero` because the whole reason this
/// wallet embeds BasicSwap is XMR atomic swaps, and PwndaWallet pins a remote
/// Monero node (C0.2 / R17), which means `manage_daemon: false` and **no local
/// chaindata at all**. `bitcoin` and `litecoin` joined 2026-08-22 for the same
/// "no local chaindata" reason, by a different mechanism: [`CoinOptIn::mode`]
/// defaults to [`CoinMode::Lean`] (`#[default]`), and both are
/// [`ELECTRUM_CAPABLE`], so a newly-enabled BTC/LTC costs **zero** disk here —
/// `est_disk_gb` returns `0.0` for exactly this `mode == Lean && can_run_lean`
/// case. The operator's own wallet already ran this trio (BTC/LTC/XMR, plus
/// Particl only as transport) before this default existed; this makes that
/// the shape a fresh install starts in, rather than something to rediscover
/// per-install in Settings.
///
/// `dogecoin`/`dash` are NOT in this list and must stay out: neither is
/// [`ELECTRUM_CAPABLE`], so each is a multi-hundred-GB full-chain download
/// with no lean option, and has to be asked for explicitly.
///
/// `bitcoincash` is also NOT in this list, but for a *different* reason as of
/// [`ELECTRUM_CAPABLE`] gaining a `bitcoincash` entry (Grove expansion plan,
/// Phase C): it now COULD default in at zero disk cost the same way BTC/LTC
/// do, and deliberately does not, because default-enabling is a product
/// decision about which pairs a fresh install trades sight-unseen, not just a
/// disk-cost check — BCH's book is thin relative to BTC/LTC's
/// (`fee-reserve-and-swap-minimums.md` § 4b), so it stays an explicit,
/// individual opt-in (the "Light toggle appears for BCH, default Lean" row of
/// the acceptance table) rather than joining the always-on trio.
///
/// `zephyr`/`zano` are NOT in this list either, and for a third reason again:
/// they have no [`ELECTRUM_CAPABLE`] entry at all (host-wallet-only, see
/// [`WALLET_SIDECAR_COINS`]'s doc comment) AND they are followers nobody
/// else's book makes — enabling one is "start sharing my wallet-rpc with the
/// swap engine", which the wizard's card + consent step must show, never
/// something a fresh install does silently.
///
/// Only applied to an install with no `basicswap.json` — see
/// [`coins_on_consent`], because applying it to an existing install would
/// retroactively disable coins the user is already running.
// The coins a fresh install enables (and therefore SYNCS) by default.
//
// binary-bundling-plan T6 note (2026-08-28): this set is DELIBERATELY NOT the
// same as the bundled-binary set (particl/btc/ltc/bch/xmr). BUNDLING a binary
// and DEFAULT-ENABLING a coin are different decisions:
//   * bundling = the binary is shipped so opting into the coin works offline;
//   * default-enabling = the coin SYNCS (or, for a host-wallet coin, starts
//     sharing a wallet-rpc) on a fresh install.
// A coin with no lean/electrum option (dogecoin, dash) must never be
// default-enabled — default-on there means a full multi-hundred-GB chain
// sync, the P1 "750 GB must never be a default" footgun. bitcoincash CAN run
// lean (zero disk) but stays an explicit per-coin opt-in for the thin-book
// reason above; zephyr/zano stay explicit because enabling them is a wallet-
// sharing consent, not just a sync toggle. So bitcoincash is BUNDLED (its
// binary ships) but stays default-OFF: enabling it is a per-coin opt-in that
// then runs lean, and the bundled binary just spares the download if the user
// later picks Full.
// The default set is exactly the coins a fresh install trades WITHOUT being
// asked coin-by-coin: particl (mandatory transport), bitcoin/litecoin/
// bitcoincash (electrum/lean, zero disk), monero (remote/host wallet, zero
// disk).
//
// bitcoincash JOINED on 2026-09-04, reversing the "thin book" exception in
// the doc comment above (kept as history). The operator's decision: BCH
// light mode is at BTC/LTC parity on every mechanical axis this table cares
// about — `ELECTRUM_CAPABLE` (`--bch-mode=electrum`, zero disk), a bundled
// daemon for anyone who later picks Full, C8 account-key admissibility
// (`adoption_coins`), its own invariant suite (`verify-bch-electrum.py`) and
// the live-mainnet defect fixes (PATCH-23/24) — and the thinness of a book
// is a property of the market, not of the install; a coin that is off by
// default contributes nothing to that book.
//
// zephyr and zano JOINED later the same day, on the operator's instruction
// ("make zano and zephyr, bch default for pwnda grove opt-in"). Both are
// [`REMOTE_ONLY_COINS`]: zero disk, no daemon, and their wallet is this app's
// own wallet-rpc process — so "enabled" here means the engine may use that
// process, which is the same opt-OUT rule C8 applies to BTC/LTC/BCH (the
// disclosure lives in the opt-in wizard; `shares_zph_host_wallet` /
// `shares_zano_host_wallet` read the DECLINE, not an ack). A default-on
// host-wallet coin whose wallet process is not running this session is
// PARKED by `apply_host_wallet_coin_policy` (connection_type "none") rather
// than allowed to stall the node — see that function. What is NOT in this
// table on purpose: dogecoin/dash (no lean option — a full chain sync).
pub const DEFAULT_ENABLED_COINS: &[&str] = &[
    MANDATORY_COIN,
    "monero",
    "bitcoin",
    "litecoin",
    "bitcoincash",
    "zephyr",
    "zano",
];

/// How a coin is hosted: with a local chain, or without one.
///
/// # The tradeoff, because neither side is free
///
/// `Lean` points the engine at public ElectrumX servers (upstream ships the
/// default list at `interface/electrumx.py:30`, so it needs no configuration).
/// The coin then costs **zero disk and zero sync time** — for Bitcoin that is
/// about 15 GB and several hours that a user never pays.
///
/// What it costs instead:
///
/// * there is no daemon, so `connection_type` is `electrum` and
///   [`crate::swap_daemon::resolve_send_target`] refuses the coin — **no C2
///   daemon-direct routing**;
/// * with no daemon wallet to import into, **no C3.5 zero-move adoption**: the
///   user's pre-existing coins on that chain are not spendable by the swap
///   node, and funding it means a deposit (the C4 bridge);
/// * a third-party server sees the addresses it is asked about.
///
/// So `Lean` is the right DEFAULT — it is P1, light unless the user asks for
/// more — and `Full` is what a user picks when they want their existing coins
/// tradeable without moving them. Neither is universally better, which is why
/// this is a per-coin choice and not an install-wide switch.
///
/// Only BTC, LTC and (on Grove's patched engine — `upstream/patches/0018`)
/// BCH have a choice ([`ELECTRUM_CAPABLE`]). DOGE and DASH have no electrum
/// support at all; particl is always `Full` and cannot even be pruned;
/// monero/zephyr/zano have no `Lean`/`Full` choice in this sense either — they
/// run against a remote daemon unconditionally and share the host's own
/// wallet-rpc process instead, handled by `apply_xmr_node_to_config` /
/// [`shares_zph_host_wallet`] / [`shares_zano_host_wallet`], which is why
/// [`est_disk_gb`] returns zero for those three whatever `CoinMode` says.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CoinMode {
    /// No local chain, where upstream supports it.
    #[default]
    Lean,
    /// A local (pruned) daemon — required for routing and zero-move adoption.
    Full,
}

/// Coins the engine can host without a local chain (`prepare.py:1549-1552`),
/// with the argv prefix its `--<prefix>-mode=` option uses.
///
/// Plain upstream parses `--btc-mode` and `--ltc-mode` and nothing else.
/// Grove's patched engine additionally parses `--bch-mode` /
/// `--bch-electrum-server` (`upstream/patches/0018` adds `"bitcoincash"` to
/// `prepare.py`'s `electrum_supported_coins`, which is the only gate — the
/// flag parsing itself is generic over that dict). This table is also the
/// guard against emitting a flag that would abort prepare with "Unknown
/// argument", so an entry here without the matching engine patch would be a
/// silent prepare crash on any runtime older than 0.18.5+p18.
///
/// `zephyr` and `zano` are deliberately **not** here: they have no electrum
/// mode at all (see [`WALLET_SIDECAR_COINS`]'s doc comment) — they are always
/// `Full`-shaped (a remote daemon, never a local chain) and share the host's
/// own wallet-rpc process instead of running lean.
pub const ELECTRUM_CAPABLE: &[(&str, &str)] = &[
    ("bitcoin", "btc"),
    ("litecoin", "ltc"),
    ("bitcoincash", "bch"),
];

/// True when this coin can be hosted without a local chain at all.
pub fn can_run_lean(coin: &str) -> bool {
    ELECTRUM_CAPABLE.iter().any(|(c, _)| *c == coin)
}

/// Rough on-disk cost of a coin's chaindata, in GB — **as this engine actually
/// configures it**, which is PRUNED.
///
/// # These were wrong by up to 50x, and the direction mattered
///
/// The first version of this table carried full-archive sizes (bitcoin 750,
/// litecoin 250, bitcoincash 250). Upstream writes `prune=` into every
/// bitcoin-family conf it generates — `prune=2000` for BTC
/// (`interface/btc/core.py:123`), `prune=4000` for LTC/DOGE/DASH/BCH — so block
/// storage is CAPPED at that many MiB and the real cost is the cap plus an
/// unpruneable chainstate (the UTXO set). Bitcoin is therefore about 15 GB, not
/// 750.
///
/// Overstating is not the safe direction for this particular number: it is
/// rendered on the enable toggle, so a 50x-too-large figure talks the user out
/// of a coin that would have cost them a few GB. Understating would be worse
/// still, so these lean high WITHIN the pruned reality.
///
/// Several exceptions are derived rather than tabled, in [`est_disk_gb`]:
/// * **monero** — a pinned remote node means no local `monerod` at all, so zero;
/// * **litecoin, bitcoincash** — either runs `--<x>-mode=electrum` when the user
///   picks [`CoinMode::Lean`], which manages no daemon and stores no chain, so
///   zero in that mode (see [`ELECTRUM_CAPABLE`]);
/// * **zephyr, zano** ([`REMOTE_ONLY_COINS`]) — no local-chain option exists AT
///   ALL for these two (host-wallet-only, see [`WALLET_SIDECAR_COINS`]'s doc
///   comment), so they are zero unconditionally rather than only in one mode.
///
/// **particl is pruned like the rest** since Option A
/// (`particl-pruned-node-and-snapshot-plan.md`): upstream's `txindex=1` +
/// `spentindex=1` (`interface/part/core.py:123-124`) serve PART-as-a-swap-leg
/// only, which this wallet never offers, so [`apply_particl_prune_policy`]
/// strips them and writes `prune=`[`PARTICL_PRUNE_MIB`].
///
/// Still order-of-magnitude budget figures, not measurements — **except
/// particl**, whose row is a measurement (see below). UI copy must say
/// "about" — [`crate::swap_sidecar`]'s footprint page carries the sourcing.
const COIN_DISK_GB: &[(&str, f64)] = &[
    // MEASURED 2026-09-08 on a synced `prune=550` probe: 1,155 MB — block
    // files 330 MiB (oscillating to the 550 MiB target between prunes),
    // block index 766 MB (headers + per-block records; unprunable and the
    // real floor), chainstate 66 MB. Quoted 1.3 rather than 1.15 so the
    // number stays true just BEFORE a prune fires, not only just after.
    // Was 8.0 while the node ran unpruned, itself an over-estimate: the
    // unpruned node measured 2.9 GB.
    ("particl", 1.3),
    // prune=2000 MiB blocks + ~12 GB chainstate
    ("bitcoin", 15.0),
    // prune=4000 MiB + chainstate; zero in electrum mode (see est_disk_gb)
    ("litecoin", 6.0),
    // prune-blockchain=1, roughly a third of full; zero with a remote node
    ("monero", 80.0),
    ("dogecoin", 9.0),
    ("dash", 6.0),
    // prune=4000 MiB + chainstate; zero in electrum mode (see est_disk_gb)
    ("bitcoincash", 8.0),
];

/// Coins with **no local-chain option at all** — see
/// [`WALLET_SIDECAR_COINS`]'s doc comment. Grove always runs their daemons
/// remotely and shares the host's own wallet-rpc process, so
/// [`est_disk_gb`] returns zero for them unconditionally, the same way
/// `monero_is_remote` does for a pinned-remote Monero — except there is no
/// "unless" here, because unlike Monero these two have no local-daemon mode
/// to fall back to at all.
///
/// A member of this list deliberately has NO [`COIN_DISK_GB`] row: there is
/// no "if you ran it locally" figure to quote, because that configuration
/// does not exist. [`coin_tickers_cover_every_sidecar_coin`] checks this list
/// as the alternative to a `COIN_DISK_GB` row, not an addition to it.
pub const REMOTE_ONLY_COINS: &[&str] = &["zephyr", "zano"];

/// The engine coin name for `input`, accepting either spelling
/// (`"bitcoincash"`, `"BCH"`, `"bch"`), or `None` for anything else.
///
/// Returns a `&'static str` from [`WALLET_SIDECAR_COINS`] so a caller cannot
/// carry a differently-cased copy forward: everything downstream — the opt-in
/// map key, the chainclients key, the watch file name — is the lowercase engine
/// name, and one normalisation point is what keeps them equal.
pub fn coin_key_from(input: &str) -> Option<&'static str> {
    let want = input.trim();
    if want.is_empty() {
        return None;
    }
    for (coin, ticker) in COIN_TICKERS {
        if want.eq_ignore_ascii_case(coin) || want.eq_ignore_ascii_case(ticker) {
            return Some(coin);
        }
    }
    None
}

/// UPPERCASE ticker for an engine coin name. Falls back to the uppercased name
/// so a coin added to [`WALLET_SIDECAR_COINS`] without a ticker row still
/// renders — `coin_tickers_cover_every_sidecar_coin` is what actually keeps
/// the table complete.
pub fn ticker_for(coin: &str) -> String {
    COIN_TICKERS
        .iter()
        .find(|(c, _)| *c == coin)
        .map(|(_, t)| (*t).to_string())
        .unwrap_or_else(|| coin.to_ascii_uppercase())
}

/// Chaindata budget for one coin.
///
/// `monero_is_remote` collapses XMR to zero (a pinned remote node runs no local
/// `monerod`). `mode` collapses BTC/LTC/BCH to zero the same way, when the
/// coin is [`ELECTRUM_CAPABLE`] and lean. [`REMOTE_ONLY_COINS`] (ZEPH/ZANO)
/// collapse to zero unconditionally — neither `monero_is_remote` nor `mode`
/// need consulting for them, because no other configuration exists.
///
/// # This used to be `ltc_is_electrum() -> true`
///
/// A hardcoded predicate that answered for the whole install, because the
/// bring-up happened to run LTC electrum and nothing else could. It is the
/// project's recurring shape — *a precondition copied from a neighbouring
/// operation* — and it was load-bearing twice over: it made LTC the one coin
/// that could never do zero-move adoption, and it reported 0 GB for a regtest
/// LTC that runs a real litecoind and does pay the cost. Pass the mode.
pub fn est_disk_gb(coin: &str, monero_is_remote: bool, mode: CoinMode) -> f64 {
    if coin == "monero" && monero_is_remote {
        return 0.0;
    }
    // ZEPH/ZANO have no local-chain option at all (unlike monero, which
    // COULD in principle run its own daemon): Grove always points them at a
    // remote daemon and shares the host's own wallet-rpc process instead
    // (grove-expansion-master-plan.md § 1, "Zero disk for all three"). So this
    // is unconditional, unlike the `mode`-gated check below — there is no
    // `CoinMode::Full` for either coin to fall back to.
    if REMOTE_ONLY_COINS.contains(&coin) {
        return 0.0;
    }
    // A lean BTC/LTC/BCH runs against public ElectrumX servers: no daemon, no
    // chain, no disk. Quoting a chaindata cost for it would be quoting a cost
    // that is never paid.
    if mode == CoinMode::Lean && can_run_lean(coin) {
        return 0.0;
    }
    COIN_DISK_GB
        .iter()
        .find(|(c, _)| *c == coin)
        .map(|(_, gb)| *gb)
        .unwrap_or(0.0)
}

/// The coins the node should actually run, in [`WALLET_SIDECAR_COINS`] order.
///
/// # The migration rule is load-bearing (contract 1.4)
///
/// An **empty map** is a record written before C3 existed, and it means
/// *every* coin — legacy behaviour, because that install is already running
/// them and silently switching seven chains off on upgrade would look like a
/// broken node, not like a new feature.
///
/// A **non-empty map** is an explicit set of choices, and a coin absent from it
/// is *not* enabled. That is what makes a later widening of
/// [`WALLET_SIDECAR_COINS`] require an opt-in instead of quietly starting a
/// 750 GB download (P1).
///
/// `particl` is always present regardless of what the record says.
pub fn enabled_coins(rec: &OptInRecord) -> Vec<String> {
    WALLET_SIDECAR_COINS
        .iter()
        .filter(|c| {
            **c == MANDATORY_COIN
                || rec.coins.is_empty()
                || rec.coins.get(**c).map(|e| e.enabled).unwrap_or(false)
        })
        .map(|c| (*c).to_string())
        .collect()
}

/// Turn the *effective* set into an explicit map, preserving every existing
/// entry.
///
/// Called before the first explicit toggle. Without it, disabling one coin on a
/// legacy record would write `{bitcoin: {enabled: false}}` — a non-empty map —
/// and every OTHER coin would become disabled by the rule above. One toggle,
/// six chains silently switched off, no error anywhere.
pub fn materialize_coin_map(rec: &OptInRecord, at: &str) -> std::collections::BTreeMap<String, CoinOptIn> {
    let effective = enabled_coins(rec);
    let mut out = rec.coins.clone();
    for coin in WALLET_SIDECAR_COINS {
        let entry = out.entry((*coin).to_string()).or_insert_with(|| CoinOptIn {
            enabled: false,
            at: Some(at.to_string()),
            ..CoinOptIn::default()
        });
        if entry.at.is_none() {
            entry.at = Some(at.to_string());
        }
        if rec.coins.get(*coin).is_none() {
            entry.enabled = effective.iter().any(|c| c == coin);
        }
    }
    out
}

/// The coin map to write when consent is (re)recorded.
///
/// * an existing explicit map is preserved — consent is not a coin decision;
/// * an install that already has a `basicswap.json` keeps the empty/legacy map,
///   because seeding the light default there would retroactively disable coins
///   it is already syncing;
/// * a genuinely fresh install gets [`DEFAULT_ENABLED_COINS`].
pub fn coins_on_consent(
    existing: &std::collections::BTreeMap<String, CoinOptIn>,
    config_exists: bool,
    at: &str,
) -> std::collections::BTreeMap<String, CoinOptIn> {
    if !existing.is_empty() || config_exists {
        return existing.clone();
    }
    WALLET_SIDECAR_COINS
        .iter()
        .map(|coin| {
            (
                (*coin).to_string(),
                CoinOptIn {
                    enabled: DEFAULT_ENABLED_COINS.contains(coin),
                    at: Some(at.to_string()),
                    ..CoinOptIn::default()
                },
            )
        })
        .collect()
}

/// Write `manage_daemon` for every managed bitcoin-family chainclient to match
/// the enabled set. Returns `true` when the file changed.
///
/// # Why "disable" is not the inverse of "enable"
///
/// It does **not** delete the chainclient block and it does **not** touch
/// chaindata. The chain simply stops being started. Every string the UI shows
/// has to say that, because "disable" reads as "remove" and a user who believes
/// they reclaimed 750 GB will be unpleasantly surprised.
///
/// `particl` is never touched (SMSG transport). `monero` is written here like
/// any other coin and then **overwritten** by [`apply_xmr_node_to_config`] when
/// a remote node is pinned — which is why the call order inside
/// [`apply_local_config_policy`] is coin policy first, node pin second. A
/// pinned remote node must always win: `manage_daemon: true` next to a remote
/// `rpchost` makes the engine try to launch a daemon it has no binary for.
///
/// Contract 4.3 item 4: that `manage_daemon: false` is a *working* disable is
/// **not yet regtest-proven**. The engine may still try to reach a
/// configured-but-unmanaged chainclient. Copy stays descriptive until it is.
///
/// BOM-less write and idempotent, same discipline as
/// [`apply_xmr_node_to_config`] (W-10).
fn apply_coin_enablement_to_config(datadir: &Path, enabled: &[String]) -> Result<bool, String> {
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(clients) = v.get_mut("chainclients").and_then(|c| c.as_object_mut()) else {
        return Ok(false);
    };

    let mut changed = false;
    for coin in WALLET_SIDECAR_COINS {
        if *coin == MANDATORY_COIN {
            continue;
        }
        let Some(cc) = clients.get_mut(*coin).and_then(|c| c.as_object_mut()) else {
            continue;
        };
        // Only chainclients the engine talks JSON-RPC to have a daemon to
        // manage; an electrum-mode client's `manage_daemon` means nothing.
        if cc.get("connection_type").and_then(|x| x.as_str()) != Some("rpc") {
            continue;
        }
        // Host-managed coins are never engine-managed, enabled or not: this app
        // owns the daemon and wallet processes, so the engine must be told to
        // start nothing. See [`HOST_MANAGED_DAEMON_COINS`] for why this is an
        // explicit false rather than "whatever `enabled` says".
        let want = serde_json::Value::Bool(
            !HOST_MANAGED_DAEMON_COINS.contains(coin) && enabled.iter().any(|e| e == coin),
        );
        if cc.get("manage_daemon") != Some(&want) {
            cc.insert("manage_daemon".to_string(), want);
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))?;
    Ok(true)
}

/// The mode the config on disk actually encodes, or `None` when the coin has
/// no `chainclients` block yet.
///
/// This is the counterpart to [`CoinOptIn::mode`], which is only *intent*.
/// They can disagree, and the disagreement is the interesting state: upstream
/// bakes `connection_type` in at prepare/addcoin time and `run.py` never
/// re-reads the file, so a mode changed after the fact is a preference the
/// running node knows nothing about. Reporting both is the same honesty the
/// `enabled` / `configured` pair already provides on [`CoinEnableStatus`].
///
/// Anything that is not `"electrum"` reads as [`CoinMode::Full`], because the
/// only other `connection_type` upstream emits (`rpc`) manages a local daemon.
/// An unknown future value is therefore reported as the HEAVIER of the two,
/// which is the safe direction for a figure rendered next to an enable toggle.
pub fn config_coin_mode(config_json: &str, coin: &str) -> Option<CoinMode> {
    let ct = serde_json::from_str::<serde_json::Value>(config_json)
        .ok()?
        .get("chainclients")?
        .get(coin)?
        .get("connection_type")?
        .as_str()?
        .to_string();
    Some(if ct == "electrum" {
        CoinMode::Lean
    } else {
        CoinMode::Full
    })
}

/// Is C9 host-wallet sharing ACTIVE in the config the node is running from?
///
/// True when `chainclients.monero.mainwalletrpcport` is present — the key
/// [`apply_host_xmr_wallet_to_config`] writes, and the one PWNDA-PATCH-5's
/// `XMRInterface::__init__` reads to set `_external_main_wallet`. Its presence
/// is therefore the same fact the engine itself branches on.
///
/// # Why this exists rather than reusing `adoption == "accountkey"`
///
/// `Adoption::AccountKey` is set only by C8's `pwndasetaccountkey` push, which
/// is a BTC/LTC mechanism. Monero never reaches it — C9 shares by pointing the
/// engine at this app's own `monero-wallet-rpc` instead, so a shared Monero
/// wallet sits at `adoption: "deposit"` forever. A UI keying "is it shared" on
/// `accountkey` is therefore permanently false for XMR (found 2026-08-21, when
/// exactly that mis-keying shipped: the operator's own record read
/// `monero: adoption = "deposit"` while the engine was demonstrably running on
/// their wallet).
///
/// Reads the config rather than the opt-in record on purpose: the record holds
/// CONSENT (`xmr_host_wallet_ack_at`), which is true from the moment the user
/// clicks and before any node restart has acted on it. This answers the later
/// question — did the write actually land in the config the node booted from.
pub fn config_xmr_host_wallet_active(config_json: &str) -> bool {
    config_host_wallet_active(config_json, "monero")
}

/// Is host-wallet sharing ACTIVE in the config the node booted from, for
/// `coin` — one of the three coins that share a wallet PROCESS rather than an
/// account key?
///
/// * **monero / zephyr** — `chainclients.<coin>.mainwalletrpcport`, written
///   by `apply_host_xmr_wallet_to_config` / `apply_host_zph_wallet_to_config`
///   and read by the engine (PATCH-5 / PATCH-13) to set
///   `_external_main_wallet`.
/// * **zano** — `chainclients.zano.scratchwalletrpcport`. Zano's block has no
///   `mainwalletrpc*` keys at all: Main is read-only for the engine
///   (`walletrpcjwt`, never opened or re-keyed), and the process the engine
///   owns is the SCRATCH one, whose port is the key that only exists once
///   `apply_host_zano_wallet_to_config` has run (unit C-RX).
///
/// Any other coin is `false` — they share by account key (C8) and report
/// that through `adoption`, not here.
pub fn config_host_wallet_active(config_json: &str, coin: &str) -> bool {
    let key = match coin {
        "monero" | "zephyr" => "mainwalletrpcport",
        "zano" => "scratchwalletrpcport",
        _ => return false,
    };
    serde_json::from_str::<serde_json::Value>(config_json)
        .ok()
        .and_then(|v| v.get("chainclients")?.get(coin)?.get(key).cloned())
        .is_some()
}

/// The two wallet-sharing flags a [`CoinEnableStatus`] row carries —
/// `(can_share_wallet, shares_wallet)` — decided from facts only, so the
/// routing can be asserted without an `AppHandle`.
///
/// Three mechanisms behind one user-facing question:
///
/// * lean [`ELECTRUM_CAPABLE`] coins (BTC/LTC/BCH) — C8 account-key push,
///   [`shares_lean_wallet`];
/// * monero — C9 wallet-rpc sharing, [`shares_xmr_host_wallet`];
/// * zephyr / zano ([`REMOTE_ONLY_COINS`]) — the C9-shaped host-wallet
///   sharing units C-RZ / C-RX built on 2026-09-03,
///   [`shares_zph_host_wallet`] / [`shares_zano_host_wallet`].
///
/// Until 2026-09-04 the status builder routed zephyr and zano through the
/// LEAN predicate — unconditionally false for both, since neither is
/// electrum-capable — so the API reported "cannot share, not sharing" for
/// two coins whose Rust default already shared, and the consent card built
/// for them (unit C-T2) had nothing to read and no command to write. The
/// mechanism was on; the switch was not connected to it.
pub fn share_flags(
    coin: &str,
    opted_in: bool,
    entry: Option<&CoinOptIn>,
    effective: CoinMode,
) -> (bool, bool) {
    let host_wallet = coin == "monero" || REMOTE_ONLY_COINS.contains(&coin);
    let can_share = (can_run_lean(coin) && effective == CoinMode::Lean) || host_wallet;
    // `shares` is gated on `can_share`: the old builder reported the lean
    // predicate on its own, so a coin whose on-disk mode is Full while the
    // record still asks for Lean read "cannot share, IS sharing" — a state
    // the UI has no rendering for. (`adoption_coins`, which arms the engine,
    // still consults `shares_lean_wallet` directly and is unchanged.)
    let shares = can_share
        && entry
            .map(|e| match coin {
                "monero" => shares_xmr_host_wallet(opted_in, e),
                "zephyr" => shares_zph_host_wallet(opted_in, e),
                "zano" => shares_zano_host_wallet(opted_in, e),
                _ => shares_lean_wallet(opted_in, e),
            })
            .unwrap_or(false);
    (can_share, shares)
}

/// Will `coin` actually run this session — `chainclients.<coin>.connection_type`
/// is `rpc` or `electrum` — or is it parked at `none`? `None` when the coin
/// has no block at all. See [`CoinEnableStatus::active`].
pub fn config_coin_active(config_json: &str, coin: &str) -> Option<bool> {
    let v = serde_json::from_str::<serde_json::Value>(config_json).ok()?;
    let cc = v.get("chainclients")?.get(coin)?;
    let ct = cc
        .get("connection_type")
        .and_then(|x| x.as_str())
        .unwrap_or("none");
    Some(ct == "rpc" || ct == "electrum")
}

/// `chainclients.<coin>.manage_daemon`, or `None` when the coin has no block.
pub fn coin_manage_daemon(config_json: &str, coin: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(config_json)
        .ok()?
        .get("chainclients")?
        .get(coin)?
        .get("manage_daemon")?
        .as_bool()
}

/// One row of [`swap_sidecar_coin_status`].
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoinEnableStatus {
    /// The engine's `chainclients` key, lowercase: `bitcoin`, `bitcoincash`,
    /// `particl`. This is the value `swap_sidecar_set_coin` and
    /// `swap_sidecar_selection_gate` take back, and the key inside
    /// [`OptInRecord::coins`].
    ///
    /// **Not** the short key `src/features/swap-sidecar/descriptorAdoption.ts`
    /// keys its plan table by (`btc`, `ltc`, `doge`, `dash`, `bch`). Join that
    /// table on [`CoinEnableStatus::ticker`] instead — `adoptionPlanFor`
    /// lowercases and trims, so `adoptionPlanFor(status.ticker)` resolves and
    /// `adoptionPlanFor(status.coin)` silently returns `null` for every row.
    pub coin: String,
    /// UPPERCASE ticker: `BTC`, `BCH`, `PART`. The key to join
    /// `descriptorAdoption.ts` on.
    pub ticker: String,
    pub enabled: bool,
    pub binary_present: bool,
    pub configured: bool,
    pub adoption: Adoption,
    pub descriptors_imported: bool,
    /// What the user has ASKED for: Lean (no local chain) or Full (a local
    /// pruned daemon). See [`CoinMode`]. Compare against [`Self::configured_mode`].
    pub mode: CoinMode,
    /// What `basicswap.json` actually encodes right now, or `None` when the
    /// coin has no block in it yet.
    ///
    /// Differs from [`Self::mode`] exactly when a change has been requested but
    /// not yet applied — the same relationship `enabled` has to `configured`,
    /// and for the same reason: upstream bakes the mode in at prepare/addcoin
    /// time and never re-reads it.
    pub configured_mode: Option<CoinMode>,
    /// Whether this coin has a lean option at all — only BTC and LTC do. A UI
    /// must not offer the toggle where it does not exist.
    pub can_run_lean: bool,
    /// Is there a wallet-sharing choice to offer on this row at all?
    ///
    /// True for a lean electrum-capable coin (C8's account-key sharing) and
    /// for monero (C9's wallet-rpc sharing) — two different mechanisms, one
    /// user-facing question, so the UI renders one control and the caller
    /// routes to the right command. False everywhere else: a full-mode coin
    /// adopts by descriptor import, which has its own gate, and offering a
    /// control the backend would refuse is worse than offering none.
    pub can_share_wallet: bool,
    /// Is this coin's wallet CURRENTLY shared with the swap node?
    ///
    /// Defaults **true** for any capable coin once the user has opted into the
    /// DEX — opting in is the decision, and the disclosure lives in the opt-in
    /// wizard (2026-08-20). False only when explicitly declined.
    ///
    /// Distinct from `adoption == "accountkey"`, which means the engine was
    /// VERIFIED to have done it. Between the two lies the ordinary case of
    /// "will share, node not started yet"; a UI conflating them would either
    /// claim a shared wallet that is not shared, or show the control off when
    /// it is on.
    pub shares_wallet: bool,
    /// **Monero only.** C9 sharing is ACTIVE in the config the node booted
    /// from — see [`config_xmr_host_wallet_active`]. Always false for every
    /// other coin, which share via C8's account-key push and report that
    /// through [`Self::adoption`] instead.
    ///
    /// This is XMR's answer to the question `adoption == "accountkey"` answers
    /// for BTC/LTC. They are NOT interchangeable: Monero never reaches
    /// `Adoption::AccountKey`, so a UI asking `adoption == "accountkey"` about
    /// XMR gets a permanent `false` no matter how thoroughly the wallet is
    /// shared.
    pub xmr_host_wallet_active: bool,
    /// Host-wallet sharing is ACTIVE in the config the node booted from, for
    /// ANY of the three host-wallet coins — monero (`mainwalletrpcport`),
    /// zephyr (`mainwalletrpcport` on its own chainclient block) and zano
    /// (`scratchwalletrpcport`, the engine-owned Scratch process that only
    /// exists once `apply_host_zano_wallet_to_config` ran). See
    /// [`config_host_wallet_active`]. Always false for every other coin.
    ///
    /// Added 2026-09-04 so the ZEPH/ZANO consent cards can tell "asked for"
    /// from "the write landed in the config the running node read" — the
    /// same distinction [`Self::xmr_host_wallet_active`] draws for Monero.
    /// That field is now derived from this one (`coin == "monero" && this`),
    /// one source of truth rather than two.
    pub host_wallet_active: bool,
    /// The coin is configured AND will actually run this session:
    /// `chainclients.<coin>.connection_type` is `rpc` or `electrum`, not
    /// `none` (upstream's own "present but inactive" spelling, the one its
    /// prepare flips back with "Enabling coin").
    ///
    /// Added 2026-09-04 with [`apply_host_wallet_coin_policy`]: a host-wallet
    /// coin (zephyr/zano) whose wallet process is not running when the node
    /// starts is PARKED at `none` for that session rather than allowed to
    /// retry an unreachable wallet-rpc for ten minutes and then exit the
    /// whole node. "Configured" alone would let the swap picker offer a coin
    /// the engine is deliberately not running. `None`/absent when the coin has
    /// no block (`configured == false`).
    pub active: Option<bool>,
    /// Why the coin is parked this session, when `active == Some(false)`
    /// (2026-09-04): the supervisor's own sentence from the decision that
    /// parked it — Main not running, scratch wallet failed, no wallet file —
    /// so the DEX-coins row can say what happened instead of guessing.
    #[serde(default)]
    pub parked_reason: Option<String>,
    /// Chaindata budget for the mode the node WILL run — i.e.
    /// [`Self::configured_mode`] when the coin is configured, and the requested
    /// [`Self::mode`] before that. Quoting the requested mode for a coin already
    /// configured the other way would show "no chain stored locally" beside a
    /// daemon that is syncing.
    pub est_disk_gb: f64,
}

/// May PwndaWallet select this coin's UTXOs itself right now? (R9)
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelectionGate {
    pub allowed: bool,
    /// Display copy. **Never branch on it** — it will be reworded, and a test
    /// that asserts on it passes for the wrong reason.
    pub reason: String,
    pub locked_utxos: usize,
    pub active_bids: usize,
    /// The reading came from disk because the node could not be reached.
    pub stale: bool,
    pub as_of: String,
}

/// One measurement of what the engine has reserved for a coin.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GateReading {
    pub locked_utxos: usize,
    pub active_bids: usize,
    /// RFC3339 of the measurement.
    pub as_of: String,
}

/// Whether a collision is even possible for this coin, decided from the config
/// alone.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum GateScope {
    /// The swap node's own daemon holds a wallet Pwnda may also select from.
    Shared(Box<crate::swap_daemon::SendTarget>),
    /// Nothing to collide with, and the config proves it.
    NotShared(String),
    /// We could not tell. Never an allow.
    Unknown(String),
}

/// Classify a coin for the gate.
///
/// The three-way split matters because "no" and "cannot tell" must not share a
/// branch. A coin the engine has no chainclient for cannot be holding a
/// reservation on our UTXOs, and answering `false` there would give the user a
/// send button that is permanently disabled for a reason that does not exist —
/// which teaches them to ignore the gate on the coins where it is real.
/// A config we cannot parse is the opposite case and fails closed.
pub(crate) fn gate_scope(config_json: Option<&str>, coin: &str) -> GateScope {
    let Some(cfg) = config_json else {
        return GateScope::NotShared(
            "the swap node has no configuration yet, so it holds no coins".to_string(),
        );
    };
    if serde_json::from_str::<serde_json::Value>(cfg).is_err() {
        return GateScope::Unknown("the swap node's configuration could not be read".to_string());
    }
    match crate::swap_daemon::resolve_send_target(cfg, coin) {
        Ok(t) => GateScope::Shared(Box::new(t)),
        // Every `resolve_send_target` refusal — not configured, not
        // bitcoin-family, `manage_daemon: false`, electrum, remote host —
        // means the swap node is not the authority for that wallet, so it
        // cannot be reserving an output we would also pick.
        Err(why) => GateScope::NotShared(why),
    }
}

/// Turn a reading (or the absence of one) into the gate's answer.
///
/// **`fresh == None` is always a refusal.** An unreachable daemon cannot prove
/// the absence of locks, and the persisted numbers are a photograph of a moment
/// that has already passed — a swap can be accepted in the interval. The
/// persisted values are carried into the answer purely so the UI can say *what*
/// the last known state was, never to decide with.
pub(crate) fn decide_gate(
    fresh: Option<GateReading>,
    persisted: Option<GateReading>,
    now: &str,
) -> SelectionGate {
    match fresh {
        Some(r) => {
            let allowed = r.locked_utxos == 0 && r.active_bids == 0;
            SelectionGate {
                allowed,
                reason: if allowed {
                    "the swap node has nothing reserved for this coin".to_string()
                } else {
                    format!(
                        "the swap node has {} reserved output(s) and {} swap(s) in flight for \
                         this coin",
                        r.locked_utxos, r.active_bids
                    )
                },
                locked_utxos: r.locked_utxos,
                active_bids: r.active_bids,
                stale: false,
                as_of: now.to_string(),
            }
        }
        None => {
            let (locked, bids, as_of) = match persisted {
                Some(p) => (p.locked_utxos, p.active_bids, p.as_of),
                None => (0, 0, String::new()),
            };
            SelectionGate {
                allowed: false,
                reason: "the swap node could not be reached, so this is the last known reading; \
                         an unreachable node cannot show that it has nothing reserved"
                    .to_string(),
                locked_utxos: locked,
                active_bids: bids,
                stale: true,
                as_of,
            }
        }
    }
}

/// Where the last-known gate readings live.
pub fn selection_gate_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("selection-gate.json"))
}

fn read_gate_state(app: &AppHandle) -> std::collections::BTreeMap<String, GateReading> {
    let Ok(path) = selection_gate_file(app) else {
        return Default::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_gate_state(app: &AppHandle, coin: &str, reading: &GateReading) -> Result<(), String> {
    let path = selection_gate_file(app)?;
    let mut all = read_gate_state(app);
    all.insert(coin.to_string(), reading.clone());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("cannot write {}: {}", path.display(), e))
}

/// Count the engine's in-flight bids that involve `coin` — **both roles**.
///
/// `POST /json/bids` and `POST /json/sentbids`, each with
/// `with_available_or_active` (upstream's own filter, `js_server.py` ->
/// `basicswap.py::activeBidsQueryStr`), unioned by `bid_id`. Both endpoints
/// are already on the allow-list for both verbs (`check_endpoint`), so this
/// widens nothing: the body carries a read filter, not a write. `bids/<id>` on
/// POST — the one that calls `acceptBid` — stays refused.
///
/// # Why two lists (2026-09-05)
///
/// `bids` is not the book; it is the half this node RECEIVED. `js_bids` calls
/// `listBids(sent=False)`, which appends `AND bids.was_received = 1`. A
/// taker's own swaps carry `was_sent = 1` and appear only on `sentbids`. This
/// function read `bids` alone, so for a wallet that is a taker — every user of
/// this app — it answered **zero while that user's own BCH → XMR swap was
/// funding its lock**, and the reserved-balance gate that protects a sweep or
/// a shared-wallet send from draining the coin mid-swap was open exactly when
/// it mattered. The same half-of-the-book fault the fee sweep had until
/// 2026-09-04, one gate over.
///
/// # Why an unreadable reply is an error, not zero
///
/// `count_bids_for_coin` used to turn a non-array body (the engine's own
/// `{"error": …, "locked": true}` when a wallet is locked) into `0`, and every
/// caller treats `0` as "nothing in flight — proceed". A count we could not
/// read is not a count of zero; it now surfaces as `Err`, which the callers'
/// `.ok()` turns into the `None` the gates already refuse on.
pub(crate) async fn active_bids_for(
    state: &tauri::State<'_, SwapSidecarState>,
    coin: &str,
) -> Result<usize, String> {
    let (port, password) = api_context(state)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut matching = 0usize;
    for endpoint in ["bids", "sentbids"] {
        let url = build_api_url(port, endpoint, ApiMethod::Post)?;
        let resp = client
            .post(&url)
            .header("Authorization", basic_auth_header(&password))
            .json(&serde_json::json!({ "with_available_or_active": true }))
            .send()
            .await
            .map_err(|e| format!("swap node request failed: {}", e))?;
        let body = decode_api_response(resp).await?;
        let Some(rows) = body.as_array() else {
            return Err(format!(
                "{endpoint} did not return a list, so the in-flight count is unknown: {body}"
            ));
        };
        for row in rows {
            // Dedupe across the two lists by id; a bid with no id still counts
            // once per list rather than being dropped, because the gate must
            // never under-count.
            let id = row.get("bid_id").and_then(|v| v.as_str()).map(str::to_string);
            if let Some(id) = &id {
                if !seen.insert(id.clone()) {
                    continue;
                }
            }
            if count_bids_for_coin(&serde_json::Value::Array(vec![row.clone()]), coin)
                .unwrap_or(0)
                > 0
            {
                matching += 1;
            }
        }
    }
    Ok(matching)
}

/// Every live bid, on any pair — the restart-safety question.
///
/// Not a sum over `active_bids_for` per coin: a bid names a coin on BOTH legs,
/// so a BTC<->XMR swap would be counted twice and a two-coin install could
/// report bids it does not have. The reply is already the whole list; its
/// length is the answer.
pub(crate) async fn active_bids_total(
    state: &tauri::State<'_, SwapSidecarState>,
) -> Result<usize, String> {
    let (port, password) = api_context(state)?;
    let url = build_api_url(port, "bids", ApiMethod::Post)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", basic_auth_header(&password))
        .json(&serde_json::json!({ "with_available_or_active": true }))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    let body = decode_api_response(resp).await?;
    Ok(body.as_array().map(|r| r.len()).unwrap_or(0))
}

/// How many entries of a `/json/bids` reply touch `coin`, on either leg.
///
/// The reply names coins by **display name** (`formatBids` ->
/// `ci.coin_name()`), not by the `chainclients` key: `"Bitcoin Cash"`, and the
/// variant interfaces append a suffix — `"Litecoin MWEB"`, `"Particl Blind"`,
/// `"Particl Anon"`. Matching is therefore on a normalised name plus an
/// explicit alias list, **not** a prefix test: `"Bitcoin Cash".starts_with`
/// would count every BCH bid as a BTC bid and open the gate on a coin that
/// really is reserved.
pub fn count_bids_for_coin(body: &serde_json::Value, coin: &str) -> Option<usize> {
    // A non-array body is the engine REFUSING (a locked wallet answers
    // `{"error": …, "locked": true}` with a 200), not an empty book. It was
    // `0` until 2026-09-05, and `0` is what every gate reads as "go ahead".
    let rows = body.as_array()?;
    Some(
        rows.iter()
            .filter(|b| {
                ["coin_from", "coin_to"].iter().any(|k| {
                    b.get(*k)
                        .and_then(|v| v.as_str())
                        .map(|name| bid_coin_matches(name, coin))
                        .unwrap_or(false)
                })
            })
            .count(),
    )
}

/// Normalise a coin label to lowercase alphanumerics: `"Bitcoin Cash"` ->
/// `"bitcoincash"`.
fn normalize_coin_label(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Does a bid's coin label refer to `coin` (an engine `chainclients` key)?
pub(crate) fn bid_coin_matches(label: &str, coin: &str) -> bool {
    let n = normalize_coin_label(label);
    if n == coin {
        return true;
    }
    // Variant interfaces that share a chainclient with their base coin.
    matches!(
        (coin, n.as_str()),
        ("litecoin", "litecoinmweb")
            | ("particl", "particlblind")
            | ("particl", "particlanon")
    )
}

/// Mark every configured, enabled coin as having begun syncing (R12).
///
/// Called once the node reports healthy: from that moment the chain is being
/// pulled, and a later descriptor import can no longer be guaranteed to see the
/// history it needs.
///
/// **Only touches coins that already have an explicit entry.** Creating entries
/// here would turn a legacy (empty-map) record into an explicit one as a side
/// effect of starting the node, which changes what a later widening of
/// [`WALLET_SIDECAR_COINS`] does. The consequence is stated rather than hidden:
/// on a record with no explicit choices this flag stays `false`, so C3.5 must
/// not treat it as the *only* evidence — the chaindata directory on disk is the
/// fact, this is the bookkeeping.
fn mark_first_sync_started(app: &AppHandle) {
    let mut rec = read_optin(app);
    // NO early return on an empty map, and entries are CREATED rather than only
    // updated.
    //
    // Both were bugs, and they composed into R12 being inert on precisely the
    // installs it exists to protect (found by adversarial review, 2026-08-19).
    // A record written before C3 carries `coins: {}`. `enabled_coins` reads an
    // empty map as "every coin enabled" (the legacy-migration rule), so a
    // descriptor import was ALLOWED; meanwhile this function returned
    // immediately on the empty map and its `get_mut` would have skipped any
    // coin without an entry anyway, so `first_sync_started` was never recorded
    // — and `descriptors.rs` reads a missing entry as `false`, i.e. "has not
    // synced yet". Net effect on an already-synced pre-C3 install: the import
    // is permitted and the guard that should stop it can never fire. The user
    // sees `success: true` per descriptor, a zero balance, and no error.
    //
    // Materialising the entry as `enabled: true` is what keeps the legacy
    // semantics intact: writing a non-empty map flips `enabled_coins` out of
    // its "empty means all" branch, so an entry created here must say what the
    // empty map used to mean, or marking a sync would silently disable coins.
    let Ok(dd) = datadir(app) else { return };
    let configured = configured_coins_in(&dd).unwrap_or_default();
    let enabled = enabled_coins(&rec);
    let mut changed = false;
    for coin in configured {
        if !enabled.iter().any(|e| *e == coin) {
            continue;
        }
        let entry = rec.coins.entry(coin).or_insert_with(|| CoinOptIn {
            enabled: true,
            at: None,
            ..CoinOptIn::default()
        });
        if !entry.first_sync_started {
            entry.first_sync_started = true;
            changed = true;
        }
    }
    if changed {
        if let Err(e) = write_optin(app, &rec) {
            eprintln!("[swap-sidecar] could not record first-sync state: {}", e);
        }
    }
}

/// Enable or disable one coin for the DEX.
///
/// Persists intent only. The config write happens through
/// [`apply_local_config_policy`] on the next start, deliberately: mutating
/// `basicswap.json` under a running engine changes a file it read at startup
/// and will not re-read, so the file and the process would disagree until the
/// next restart with nothing saying so. `configured` in
/// [`swap_sidecar_coin_status`] is what shows the difference.
#[tauri::command]
pub async fn swap_sidecar_set_coin(
    app: AppHandle,
    coin: String,
    enabled: bool,
) -> Result<OptInRecord, String> {
    let mut rec = read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    if key == MANDATORY_COIN && !enabled {
        return Err(
            "particl carries the offer and bid transport (SMSG); the swap node cannot run \
             without it"
                .to_string(),
        );
    }
    if enabled && key != MANDATORY_COIN && !coin_binaries_present(&bin_dir(&app)?, key) {
        return Err(format!(
            "no daemon binary is seeded for {}, so the swap node cannot run it — the coin would \
             be written into the config and then fail to start",
            key
        ));
    }

    let at = chrono::Utc::now().to_rfc3339();
    // Before the FIRST explicit choice, freeze the effective set. Skipping this
    // turns one toggle into six silent disables — see [`materialize_coin_map`].
    if rec.coins.is_empty() {
        rec.coins = materialize_coin_map(&rec, &at);
    }
    let entry = rec.coins.entry(key.to_string()).or_default();
    entry.enabled = enabled;
    entry.at = Some(at);
    write_optin(&app, &rec)?;
    Ok(rec)
}

/// The mode to REPORT for a coin, given what its record says.
///
/// `materialize_coin_map` freezes records with `CoinOptIn::default()`, which
/// stamps the serde default — `Lean` — on every coin, including the six that
/// have no lean option (particl, monero, dogecoin, dash, zephyr, zano — see
/// [`ELECTRUM_CAPABLE`]; `bitcoincash` moved OFF this list 2026-09-03, `zephyr`
/// and `zano` moved on). That value is inert everywhere mechanical (argv
/// generation and `est_disk_gb` both re-check [`ELECTRUM_CAPABLE`] /
/// [`REMOTE_ONLY_COINS`]), but reporting it would make the API describe an
/// impossible state: a `"lean"` dogecoin. Clamp at the reporting boundary
/// rather than rewriting stored records.
pub fn reported_mode(coin: &str, recorded: CoinMode) -> CoinMode {
    if can_run_lean(coin) {
        recorded
    } else {
        CoinMode::Full
    }
}

/// The mode the node will ACTUALLY run: what the config encodes if the coin is
/// already in it, otherwise what has been requested.
///
/// One line, and it has its own function because it was one line INSIDE a
/// `#[tauri::command]`, where nothing can assert on it. A mutation that made
/// `swap_sidecar_coin_status` quote the requested mode instead survived the
/// whole suite — the exact "no chain stored locally" beside a syncing daemon
/// that [`CoinEnableStatus::est_disk_gb`]'s doc comment promises cannot happen.
/// A promise in a doc comment with no test behind it is a promise about intent.
pub fn effective_mode(requested: CoinMode, on_disk: Option<CoinMode>) -> CoinMode {
    on_disk.unwrap_or(requested)
}

/// What [`swap_sidecar_set_coin_mode`] should do, decided from facts only.
#[derive(PartialEq, Eq, Debug, Clone, Copy)]
pub enum ModeChange {
    /// Record the request; it takes effect at the next start.
    Persist,
    /// The config already encodes this mode — nothing to do.
    AlreadyApplied,
}

/// Human wording for a mode, for error copy only. Never parsed.
fn mode_label(m: CoinMode) -> &'static str {
    match m {
        CoinMode::Lean => "light (no local chain)",
        CoinMode::Full => "a local pruned node",
    }
}

/// R18 / R19 / R20, extracted from the command so the refusals are reachable
/// from a test rather than only from a running node.
///
/// `on_disk` is the mode `basicswap.json` currently encodes; `None` when the
/// coin has no block in it yet.
pub fn decide_mode_change(
    key: &str,
    mode: CoinMode,
    on_disk: Option<CoinMode>,
) -> Result<ModeChange, String> {
    // R19 before R18: particl is not electrum-capable either, so R18 would fire
    // on it and say something technically true and useless. "SMSG needs a full
    // node" is the reason a user can act on.
    if key == MANDATORY_COIN && mode == CoinMode::Lean {
        // "synced", not "full": since Option A the node IS pruned (~1.3 GB),
        // so saying it needs a full node would be a claim the install itself
        // contradicts. What Lean cannot do is point SMSG at a third-party
        // server — there is no light-client protocol for it to speak.
        return Err(
            "particl carries the offer and bid transport (SMSG), which needs a local synced \
             node — it cannot run against a third-party server. The node is pruned, so this \
             is about a GB or so of disk, not the whole chain"
                .to_string(),
        );
    }
    // R18
    if mode == CoinMode::Lean && !can_run_lean(key) {
        return Err(format!(
            "{} has no light-client option in this engine, so it always runs a local pruned \
             daemon — only {} can run without a local chain",
            key,
            ELECTRUM_CAPABLE
                .iter()
                .map(|(c, _)| *c)
                .collect::<Vec<_>>()
                .join(" and ")
        ));
    }
    // R20
    match on_disk {
        Some(current) if current == mode => Ok(ModeChange::AlreadyApplied),
        Some(current) => Err(format!(
            "{} was set up as {} when it was first enabled, and the swap node cannot change an \
             existing coin's mode — the choice is made before a coin is enabled for the first \
             time. (Re-creating {} as {} from the app is not supported yet.)",
            key,
            mode_label(current),
            key,
            mode_label(mode)
        )),
        None => Ok(ModeChange::Persist),
    }
}

/// Choose how a coin is hosted: `Lean` (no local chain) or `Full` (a local
/// pruned daemon).
///
/// # Three refusals, and why each is loud rather than a silent clamp
///
/// **R18 — Lean is refused where upstream has no electrum support.** Only BTC
/// and LTC have it (`prepare.py:1549-1552`). Silently clamping a `doge` request
/// to `Full` would put the record and the user's belief permanently out of
/// step, and the UI would go on reporting "no chain stored locally" beside a
/// 9 GB sync. Worse, `--doge-mode=electrum` is not a flag upstream parses, so
/// the *node itself* would abort at startup with "Unknown argument" — a failure
/// three layers away from the toggle that caused it.
///
/// **R19 — the mandatory coin has no choice.** particl carries SMSG, and
/// upstream cannot run it against an electrum server at all.
///
/// **R20 — no change once the coin is in `basicswap.json`.** The mode IS
/// `connection_type`, written by prepare/addcoin, and `run.py` reads that file
/// exactly once at startup. Accepting a change here would persist an intent the
/// node will never act on.
///
/// The first version of this message told the user to disable the coin,
/// restart, and re-enable it — **which does not work**: disable keeps the
/// chainclient block (`manage_daemon: false`), and `reconcile_coin_set` only
/// ever `--addcoin`s coins MISSING from the config, so a re-enable never
/// re-creates anything. A remedy in an error message is a claim like any
/// other; this one shipped unverified for a few hours. The honest message says
/// the choice is made before first enable and that re-creation is not
/// supported yet.
///
/// Like [`swap_sidecar_set_coin`], this persists intent only; the config is
/// written on the next start.
#[tauri::command]
pub async fn swap_sidecar_set_coin_mode(
    app: AppHandle,
    coin: String,
    mode: CoinMode,
) -> Result<OptInRecord, String> {
    let mut rec = read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;

    // Read the CONFIG rather than the record: `connection_type` is the fact
    // that decides whether the node has already baked a mode in.
    let on_disk = datadir(&app).ok().and_then(|dd| {
        std::fs::read(dd.join("basicswap.json"))
            .ok()
            .and_then(|raw| strip_bom(&raw).ok().map(|c| c.to_string()))
            .and_then(|c| config_coin_mode(&c, key))
    });
    if decide_mode_change(key, mode, on_disk)? == ModeChange::AlreadyApplied {
        return Ok(rec);
    }

    let at = chrono::Utc::now().to_rfc3339();
    // Same freeze as `swap_sidecar_set_coin`: writing an entry into an empty map
    // turns the "empty means every coin" migration rule into "one coin".
    if rec.coins.is_empty() {
        rec.coins = materialize_coin_map(&rec, &at);
    }
    let entry = rec.coins.entry(key.to_string()).or_default();
    entry.mode = mode;
    entry.at = Some(at);
    write_optin(&app, &rec)?;
    Ok(rec)
}

/// Effective per-coin state: the opt-in record joined with what is actually on
/// disk and seeded.
///
/// `state` is taken for signature parity with the rest of the C3 surface; this
/// read needs nothing from the supervisor, because every field it reports is a
/// fact about files rather than about the running process.
#[tauri::command]
pub async fn swap_sidecar_coin_status(
    app: AppHandle,
    _state: tauri::State<'_, SwapSidecarState>,
) -> Result<Vec<CoinEnableStatus>, String> {
    let rec = read_optin(&app);
    let enabled = enabled_coins(&rec);
    let dd = datadir(&app)?;
    let bin = bin_dir(&app)?;
    let config_text = std::fs::read(dd.join("basicswap.json"))
        .ok()
        .and_then(|raw| strip_bom(&raw).ok().map(|s| s.to_string()));
    let configured = config_text
        .as_deref()
        .and_then(|c| read_configured_coins(c).ok())
        .unwrap_or_default();
    let monero_is_remote = config_text
        .as_deref()
        .and_then(|c| coin_manage_daemon(c, "monero"))
        .map(|managed| !managed)
        .unwrap_or(false);

    Ok(WALLET_SIDECAR_COINS
        .iter()
        .map(|coin| {
            let entry = rec.coins.get(*coin);
            let requested_mode =
                reported_mode(coin, entry.map(|e| e.mode).unwrap_or_default());
            let on_disk_mode = config_text
                .as_deref()
                .and_then(|c| config_coin_mode(c, coin));
            let (can_share_wallet, shares_wallet) = share_flags(
                coin,
                rec.opted_in,
                entry,
                effective_mode(requested_mode, on_disk_mode),
            );
            let host_wallet_active = config_text
                .as_deref()
                .map(|c| config_host_wallet_active(c, coin))
                .unwrap_or(false);
            let active = config_text
                .as_deref()
                .and_then(|c| config_coin_active(c, coin));
            CoinEnableStatus {
                coin: (*coin).to_string(),
                ticker: ticker_for(coin),
                enabled: enabled.iter().any(|e| e == coin),
                binary_present: coin_binaries_present(&bin, coin),
                configured: configured.iter().any(|c| c.eq_ignore_ascii_case(coin)),
                adoption: entry.map(|e| e.adoption).unwrap_or_default(),
                descriptors_imported: entry
                    .map(|e| e.descriptors_imported_at.is_some())
                    .unwrap_or(false),
                mode: requested_mode,
                configured_mode: on_disk_mode,
                can_run_lean: can_run_lean(coin),
                can_share_wallet,
                shares_wallet,
                xmr_host_wallet_active: *coin == "monero" && host_wallet_active,
                host_wallet_active,
                active,
                parked_reason: if active == Some(false) { park_reason(coin) } else { None },
                est_disk_gb: est_disk_gb(
                    coin,
                    monero_is_remote,
                    effective_mode(requested_mode, on_disk_mode),
                ),
            }
        })
        .collect())
}

/// C8 — record (or withdraw) consent for a coin's lean wallet to use the
/// wallet's own account keys.
///
/// Consent is per coin and explicit. Enabling a coin for the DEX is NOT
/// consent: it says "sync this chain", and sharing keys is a different
/// question with a different cost (the chosen ElectrumX servers can see that
/// account's addresses, balance and history — `DEX_COINS_LIGHT_PRIVACY_NOTE`
/// is the copy that has to be on screen before this is called).
///
/// Refuses on a coin that cannot run lean, because there is nothing to consent
/// to: a full-mode coin shares by descriptor import (C3.5), which has its own
/// gate, and DOGE/DASH/BCH have no lean mode at all.
///
/// Takes effect on the next start: [`adoption_coins`] reads this to decide
/// what `BSX_PWNDA_ACCOUNT_KEY_COINS` names, and that variable is what makes
/// the engine refuse to build the wallet from its own seed.
///
/// Withdrawing consent clears [`CoinOptIn::adoption`] back to the default too
/// — leaving it reading `accountkey` would keep the UI claiming a shared
/// wallet the next start will not create.
#[tauri::command]
pub async fn swap_sidecar_set_share_wallet(
    app: AppHandle,
    coin: String,
    share: bool,
) -> Result<OptInRecord, String> {
    let mut rec = read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    if !can_run_lean(key) {
        return Err(format!(
            "{} has no light mode, so there is no lean wallet to share — its existing funds \
             are adopted by descriptor import instead",
            key
        ));
    }

    let at = chrono::Utc::now().to_rfc3339();
    if rec.coins.is_empty() {
        rec.coins = materialize_coin_map(&rec, &at);
    }
    let entry = rec.coins.entry(key.to_string()).or_default();
    if share {
        entry.share_wallet_ack_at = Some(at);
        // Clearing the decline is what actually turns sharing back ON — the
        // ack above is an audit trail, not the gate (see `shares_lean_wallet`).
        entry.share_wallet_declined_at = None;
    } else {
        entry.share_wallet_declined_at = Some(at);
        entry.share_wallet_ack_at = None;
        // A withdrawn share must drop the VERIFIED claim too, or the row goes
        // on saying "same wallet as your own" about a wallet the next start
        // will not build.
        if entry.adoption == Adoption::AccountKey {
            entry.adoption = Adoption::default();
        }
    }
    write_optin(&app, &rec)?;
    Ok(rec)
}

/// C9 — record (or withdraw) consent to point the swap engine's Monero
/// wallet at the user's own `monero-wallet-rpc`.
///
/// Refuses for every coin except `"monero"` — this is not a general
/// "share this wallet" toggle (see [`swap_sidecar_set_share_wallet`] for
/// that, and [`CoinOptIn::xmr_host_wallet_ack_at`]'s own doc comment for why
/// the two are deliberately separate fields).
///
/// Recording consent here takes effect on the NEXT swap-node start (see
/// `maybe_activate_xmr_host_wallet`, called from `swap_sidecar_start` before
/// the config write) — not immediately, since `run.py` reads
/// `basicswap.json` once, at process start, with no live reload path.
/// `#[serde(default)]` on the underlying field is why this is safe on an
/// existing install: monero is enabled by default, so a record predating
/// this field reads "never consented" rather than silently repointing an
/// XMR wallet nobody agreed to share.
#[tauri::command]
pub async fn swap_sidecar_set_xmr_host_wallet(
    app: AppHandle,
    coin: String,
    share: bool,
) -> Result<OptInRecord, String> {
    let mut rec = read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    if key != "monero" {
        return Err(
            "only Monero's wallet can be pointed at this app's own monero-wallet-rpc — every              other coin uses swap_sidecar_set_share_wallet instead"
                .to_string(),
        );
    }

    let at = chrono::Utc::now().to_rfc3339();
    if rec.coins.is_empty() {
        rec.coins = materialize_coin_map(&rec, &at);
    }
    let entry = rec.coins.entry(key.to_string()).or_default();
    if share {
        entry.xmr_host_wallet_ack_at = Some(at);
        entry.xmr_host_wallet_declined_at = None;
    } else {
        entry.xmr_host_wallet_declined_at = Some(at);
        entry.xmr_host_wallet_ack_at = None;
    }
    write_optin(&app, &rec)?;
    Ok(rec)
}

/// C-RZ / C-RX — record (or withdraw) consent to point the swap engine's
/// Zephyr main wallet at this app's own `zephyr-wallet-rpc`, or to run
/// Zano's engine-owned SCRATCH `simplewallet` beside the app's own Main.
///
/// The ZEPH/ZANO twin of [`swap_sidecar_set_xmr_host_wallet`], and a separate
/// command for the same reason that one is separate from
/// [`swap_sidecar_set_share_wallet`]: the three consents authorise
/// mechanistically different things — an account key handed over (C8), a
/// wallet-rpc process repointed (C9), a scratch process started next to a
/// read-only Main (C-RX) — and one flag meaning three security properties
/// depending on which coin reads it is how a toggle stops meaning what it
/// says. Refuses every coin except `zephyr` and `zano`, by name.
///
/// Takes effect on the next start: `maybe_activate_zph_host_wallet` /
/// `maybe_activate_zano_host_wallet` read the ack timestamp from
/// `swap_sidecar_start`. `#[serde(default)]` on both field pairs keeps a
/// record written before they existed reading "never consented".
///
/// Until 2026-09-04 nothing set these fields: the activation path (C-RZ /
/// C-RX, 2026-09-03) and the consent card (C-T2, same day) both existed and
/// were not connected, so ZEPH/ZANO sharing could not be reached from the UI
/// at all — `swap_sidecar_coin_status` also reported both as "cannot share"
/// (see [`share_flags`]). Two of the three host-wallet coins were therefore
/// not at Monero's parity despite carrying the same backend.
#[tauri::command]
pub async fn swap_sidecar_set_cn_host_wallet(
    app: AppHandle,
    coin: String,
    share: bool,
) -> Result<OptInRecord, String> {
    let mut rec = read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    let at = chrono::Utc::now().to_rfc3339();
    if rec.coins.is_empty() {
        rec.coins = materialize_coin_map(&rec, &at);
    }
    let entry = rec.coins.entry(key.to_string()).or_default();
    apply_cn_host_wallet_consent(key, entry, share, &at)?;
    write_optin(&app, &rec)?;
    Ok(rec)
}

/// The pure half of [`swap_sidecar_set_cn_host_wallet`]: which field pair the
/// decision lands in, or the refusal. Extracted so the coin routing and the
/// refusals are reachable from a test without an `AppHandle`.
pub fn apply_cn_host_wallet_consent(
    key: &str,
    entry: &mut CoinOptIn,
    share: bool,
    at: &str,
) -> Result<(), String> {
    let (ack, declined) = match key {
        "zephyr" => (
            &mut entry.zph_host_wallet_ack_at,
            &mut entry.zph_host_wallet_declined_at,
        ),
        "zano" => (
            &mut entry.zano_host_wallet_ack_at,
            &mut entry.zano_host_wallet_declined_at,
        ),
        "monero" => {
            return Err(
                "Monero's wallet-rpc sharing is recorded by swap_sidecar_set_xmr_host_wallet — \
                 this command is for zephyr and zano only"
                    .to_string(),
            )
        }
        other => {
            return Err(format!(
                "{other} has no host wallet process to share — only zephyr and zano run against \
                 this app's own wallet-rpc; a bitcoin-family coin shares its account key through \
                 swap_sidecar_set_share_wallet instead"
            ))
        }
    };
    if share {
        *ack = Some(at.to_string());
        *declined = None;
    } else {
        *declined = Some(at.to_string());
        *ack = None;
    }
    Ok(())
}

/// C-RZ / C-RX — is a swap actively using the shared ZEPH or ZANO wallet
/// right now? The ZEPH/ZANO twin of [`swap_sidecar_xmr_shared_in_use`], same
/// fail-closed decision ([`xmr_shared_wallet_in_use`] is coin-agnostic: it
/// only ever sees the three booleans). `Ok(true)` means "refuse the caller's
/// Lock / Forget action and say why"; refuses every coin except the two.
#[tauri::command]
pub async fn swap_sidecar_cn_shared_in_use(
    app: AppHandle,
    sc: tauri::State<'_, SwapSidecarState>,
    coin: String,
) -> Result<bool, String> {
    let key = coin_key_from(&coin).ok_or_else(|| format!("{coin:?} is not a swap-node coin"))?;
    let rec = read_optin(&app);
    let consented = match key {
        "zephyr" => rec
            .coins
            .get("zephyr")
            .map(|e| e.zph_host_wallet_ack_at.is_some())
            .unwrap_or(false),
        "zano" => rec
            .coins
            .get("zano")
            .map(|e| e.zano_host_wallet_ack_at.is_some())
            .unwrap_or(false),
        _ => {
            return Err(format!(
                "{key} does not share a host wallet process — this check is for zephyr and zano"
            ))
        }
    };
    if !consented {
        return Ok(false);
    }
    let node_running = api_context(&sc).is_ok();
    if !node_running {
        return Ok(false);
    }
    let in_flight = active_bids_for(&sc, key).await.ok();
    Ok(xmr_shared_wallet_in_use(consented, node_running, in_flight))
}

/// C9 — is a swap actively using the shared Monero wallet right now?
///
/// Pure decision, separated from the network read the same way
/// [`reserved_balance_gate`] is: given the pieces (consent, whether the node
/// is running, and an in-flight bid count), decide whether Lock Wallet or
/// Forget Monero must refuse. Testable without any Tauri machinery.
///
/// **Fails closed in both missing-information directions**, matching
/// [`reserved_balance_gate`]'s own philosophy:
/// - not consented, or the node is not running → `false` (nothing to
///   refuse for — there is no live engine process that could be using the
///   wallet).
/// - consented AND the node is running, but the bid count could not be
///   measured → `true` (refuse). An unmeasured count is not a count of
///   zero, and the cost of wrongly refusing a Lock click is an extra
///   confirmation; the cost of wrongly allowing one is a corrupted swap or a
///   security control that silently stopped meaning what it says.
pub(crate) fn xmr_shared_wallet_in_use(
    consented: bool,
    node_running: bool,
    in_flight: Option<usize>,
) -> bool {
    if !consented || !node_running {
        return false;
    }
    match in_flight {
        None => true,
        Some(n) => n > 0,
    }
}

/// C9 — may Lock Wallet / Forget Monero proceed right now?
///
/// Thin Tauri wrapper around [`xmr_shared_wallet_in_use`]: reads consent from
/// the opt-in record, checks whether the node is running, and — only if
/// both are true — asks the engine for Monero's in-flight bid count via the
/// same [`active_bids_for`] read [`reserved_balance_gate`]'s callers use.
///
/// `Ok(true)` means "in use — refuse the caller's action and say why";
/// `Ok(false)` means "safe to proceed". Never used to CANCEL an in-flight
/// swap — only to stop the user from starting an action that would.
#[tauri::command]
pub async fn swap_sidecar_xmr_shared_in_use(
    app: AppHandle,
    sc: tauri::State<'_, SwapSidecarState>,
) -> Result<bool, String> {
    let rec = read_optin(&app);
    let consented = rec
        .coins
        .get("monero")
        .map(|e| e.xmr_host_wallet_ack_at.is_some())
        .unwrap_or(false);
    if !consented {
        return Ok(false);
    }
    let node_running = api_context(&sc).is_ok();
    if !node_running {
        return Ok(false);
    }
    let in_flight = active_bids_for(&sc, "monero").await.ok();
    Ok(xmr_shared_wallet_in_use(consented, node_running, in_flight))
}

/// May the wallet spend this coin from its own selector right now? (R9)
///
/// Reads `listlockunspent` off the coin's own daemon and the engine's active
/// bid list, and **fails closed** on anything it cannot measure. See
/// [`decide_gate`] for why a persisted zero is not an allow.
#[tauri::command]
pub async fn swap_sidecar_selection_gate(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
    coin: String,
) -> Result<SelectionGate, String> {
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    let now = chrono::Utc::now().to_rfc3339();
    let dd = datadir(&app)?;
    let config_text = std::fs::read(dd.join("basicswap.json"))
        .ok()
        .and_then(|raw| strip_bom(&raw).ok().map(|s| s.to_string()));

    match gate_scope(config_text.as_deref(), key) {
        GateScope::NotShared(why) => Ok(SelectionGate {
            allowed: true,
            reason: format!("the swap node is not the authority for this coin's wallet: {}", why),
            locked_utxos: 0,
            active_bids: 0,
            stale: false,
            as_of: now,
        }),
        GateScope::Unknown(why) => {
            let mut gate = decide_gate(None, read_gate_state(&app).remove(key), &now);
            gate.reason = format!("{} — holding the wallet back", why);
            Ok(gate)
        }
        GateScope::Shared(target) => {
            let fresh = read_gate_fresh(&state, &target, key).await;
            if let Some(r) = fresh.as_ref() {
                if let Err(e) = write_gate_state(&app, key, r) {
                    eprintln!("[swap-sidecar] could not persist the selection gate: {}", e);
                }
            }
            Ok(decide_gate(fresh, read_gate_state(&app).remove(key), &now))
        }
    }
}

/// One live reading, or `None` for "could not measure".
///
/// Both halves must succeed. A lock count with no bid count is not a partial
/// answer, it is a different question — the engine can have accepted a bid
/// whose lock has not been placed yet, so a zero lock count on its own proves
/// nothing.
async fn read_gate_fresh(
    state: &tauri::State<'_, SwapSidecarState>,
    target: &crate::swap_daemon::SendTarget,
    coin: &str,
) -> Option<GateReading> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let (ep, _info) = crate::swap_daemon::resolve_endpoint(&client, target)
        .await
        .ok()?;
    let listed = crate::swap_daemon::daemon_rpc(
        &client,
        &ep,
        "listlockunspent",
        serde_json::json!([]),
    )
    .await
    .ok()?;
    let locked = crate::swap_daemon::locked_outpoints(&listed).len();
    let bids = active_bids_for(state, coin).await.ok()?;
    Some(GateReading {
        locked_utxos: locked,
        active_bids: bids,
        as_of: chrono::Utc::now().to_rfc3339(),
    })
}

// =========================================================================
// Health
// =========================================================================

/// One authenticated `/json/coins` poll. `Ok` iff the node answered with a
/// usable coin list.
pub async fn health_check(port: u16, password: &str) -> Result<Vec<CoinEntry>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .get(format!("http://127.0.0.1:{}/json/coins", port))
        .header("Authorization", basic_auth_header(password))
        .send()
        .await
        .map_err(|e| format!("health request failed: {}", e))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("health body read failed: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(format!("/json/coins HTTP {}: {}", status, snippet(&body)));
    }
    parse_coins_health(&body)
}

// =========================================================================
// C5 - wallet encryption: the two calls the WEBVIEW may never make
// =========================================================================

/// The only engine endpoints a Rust-side caller may reach past the allow-list.
///
/// Both are on [`DENIED_ENDPOINTS`] and stay there: `check_endpoint` alone
/// still refuses them, so no `swap_sidecar_api_post` from the renderer can
/// reach either. This list is the *Rust* surface, and it is deliberately two
/// literals - every call site below passes a `&'static str` constant, never a
/// caller-supplied path.
const PRIVILEGED_POST_PATHS: &[&str] = &["unlock", "setpassword", "pwndasetaccountkey"];

/// One authenticated POST to a privileged `/json/` endpoint.
///
/// Contract 0.4: the allow-list is never widened; privileged engine calls get
/// their own Rust-only door that asserts a literal path. Widening
/// [`check_endpoint`] instead would hand the same power to the renderer, which
/// is the regression `webview_route_still_denied` exists to catch.
async fn privileged_post(
    port: u16,
    auth: &str,
    path: &'static str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !PRIVILEGED_POST_PATHS.contains(&path) {
        return Err(format!(
            "'{}' is not a privileged swap-node endpoint",
            path
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .post(format!("http://127.0.0.1:{}/json/{}", port, path))
        .header("Authorization", basic_auth_header(auth))
        // `Content-Type: application/json` is what makes upstream parse the
        // body with `json.loads` instead of `urllib.parse.parse_qs`
        // (http_server.py:1361 -> js_server.py:55-63). Form-encoding it would
        // hand `getFormData` a dict of LISTS, and `get_data_entry` would then
        // pass `["<pwd>"]` to `unlockWallets`.
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    decode_api_response(resp).await
}

/// Unlock every encrypted wallet the engine manages.
///
/// Wire shape, verified against `js_server.py:1483-1497`: `POST /json/unlock`,
/// `Content-Type: application/json`, body exactly `{"password": "..."}`.
/// Omitting `coin` is what makes it `unlockWallets(password)` - all coins.
///
/// Upstream answers `{"success": true}`; an exception is rendered as a JSON
/// body carrying `error`, so a 200 is NOT by itself proof of an unlock. Both
/// shapes are checked.
pub async fn unlock_wallets(port: u16, auth: &str, wallet_pwd: &str) -> Result<(), String> {
    let body = serde_json::json!({ "password": wallet_pwd });
    let v = privileged_post(port, auth, "unlock", body).await?;
    if let Some(err) = v.get("error") {
        return Err(format!("the swap node refused the unlock: {}", err));
    }
    Ok(())
}

/// C8 - hand the engine one coin's **account key** so its lean wallet is the
/// user's wallet.
///
/// Wire shape, against `upstream/patches/0004`: `POST /json/pwndasetaccountkey`
/// with `{"coin": "<TICKER>", "key": "<74-byte hex>"}`. The engine answers
/// `{"success", "coin", "initialized", "deposit_address"}` — `initialized` is
/// false when the wallets were still locked, which is not an error: the key is
/// stored and the engine's own lazy path picks it up after the unlock.
///
/// Returns the deposit address the engine derived, so the caller can compare it
/// against the address the WALLET derives for the same account. That comparison
/// is the whole safety property of C8 and is why the address is plumbed back
/// rather than discarded — see [`account_key_mismatch`].
///
/// `key` is spending authority for the coin's whole branch. It is passed
/// straight into the request body and is **never** logged, never placed on
/// argv, never in env, and never returned.
pub async fn push_account_key(
    port: u16,
    auth: &str,
    ticker: &str,
    key: &str,
    address_type: &str,
) -> Result<(bool, Option<String>), String> {
    let body =
        serde_json::json!({ "coin": ticker, "key": key, "addressType": address_type });
    let v = privileged_post(port, auth, "pwndasetaccountkey", body).await?;

    // An engine without PWNDA-PATCH-4 routes unknown paths to `js_404`, which
    // answers 200 with this body. Without this branch the caller would read a
    // missing `deposit_address` as "the engine derived nothing" instead of
    // "this runtime has no such endpoint".
    if v.get("Error").and_then(|e| e.as_str()) == Some("path unknown") {
        return Err(
            "this swap-node runtime does not carry the account-key patches \
             (upstream/patches/0003-0004); rebuild the runtime or turn shared \
             wallets off for this coin"
                .to_string(),
        );
    }
    if let Some(err) = v.get("error") {
        return Err(format!("the swap node refused the account key: {}", err));
    }
    let initialized = v
        .get("initialized")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let addr = v
        .get("deposit_address")
        .and_then(|a| a.as_str())
        .map(|a| a.to_string());
    Ok((initialized, addr))
}

/// Does the engine's derived deposit address disagree with the wallet's own?
///
/// `Some(reason)` means **stop and tell the user**. A disagreement means the
/// engine stood up a wallet we did not intend — funds would arrive at addresses
/// the wallet cannot see, and nothing else in the system would report a fault.
///
/// A `None` engine address is NOT a mismatch: the engine answers that way when
/// the wallets are locked, having stored the key for its own lazy path. Treating
/// "not yet" as "wrong" would fire on the ordinary push-before-unlock sequence.
///
/// ## CashAddr is compared without its prefix (2026-09-05)
///
/// BCH addresses are `bitcoincash:q…`, and the prefix is optional in the
/// canonical encoding — the same address is the same address with or without
/// it, and the two sides here happen to emit it today (the engine via
/// `cashaddress.Address.cash_address()`, the wallet via `encodeCashAddr`).
/// Comparing the payloads keeps a genuine disagreement red — a different
/// payload fails, and a `bchtest:` address arriving where a mainnet one
/// belongs still fails, because only the mainnet prefix is stripped. It is
/// not leniency about WHICH address; it is refusing to call one address two.
pub fn account_key_mismatch(
    ticker: &str,
    engine_addr: Option<&str>,
    wallet_addr: &str,
) -> Option<String> {
    let engine = engine_addr?;
    let strip = |a: &str| {
        let lower = a.to_ascii_lowercase();
        match lower.strip_prefix("bitcoincash:") {
            Some(rest) => rest.to_string(),
            None => lower,
        }
    };
    if engine.eq_ignore_ascii_case(wallet_addr)
        || (ticker.eq_ignore_ascii_case("BCH") && strip(engine) == strip(wallet_addr))
    {
        return None;
    }
    Some(format!(
        "{} shared-wallet check FAILED: the swap node derived {} but this \
         wallet derives {}. Shared wallets are not active for {}.",
        ticker, engine, wallet_addr, ticker
    ))
}

/// `(encrypted, locked)` for one coin, from the `wallets/<ticker>` read.
///
/// Read-only and on the allow-list, so it goes through the ordinary URL
/// builder rather than [`privileged_post`]. C3.5 needs it to refuse a
/// descriptor import into an unencrypted wallet; C5 uses it to report state.
#[allow(dead_code)]
pub async fn wallet_lock_state(
    port: u16,
    auth: &str,
    ticker: &str,
) -> Result<(bool, bool), String> {
    let url = build_api_url(port, &format!("wallets/{}", ticker), ApiMethod::Get)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", basic_auth_header(auth))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    let v = decode_api_response(resp).await?;
    let encrypted = v.get("encrypted").and_then(|b| b.as_bool()).unwrap_or(false);
    let locked = v.get("locked").and_then(|b| b.as_bool()).unwrap_or(false);
    Ok((encrypted, locked))
}

/// `<datadir>/basicswap.log` tail, for log-tail-in-error (xmr_rpc.rs:940-985).
fn log_tail(datadir: &Path) -> String {
    crate::wallet_rpc_common::read_log_tail(&datadir.join("basicswap.log"), LOG_TAIL_BYTES)
}

// =========================================================================
// The chain daemon's own verdict
// =========================================================================

/// What particld's own log says killed it, if it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainDaemonFatal {
    /// The `Error: …` line minus its stamp — the sentence the user should see.
    pub line: String,
    /// The txindex is inconsistent and can be rebuilt by deleting it.
    pub txindex_rebuildable: bool,
}

/// The one particld error this supervisor repairs on its own.
pub const PARTICL_TXINDEX_MARKER: &str = "txindex: best block of the index not found";

/// Prefix `start_node_core` puts on the error it returns for that case, so
/// the caller can repair and retry without parsing prose.
pub const PARTICL_TXINDEX_ERR_PREFIX: &str = "[particl-txindex] ";

/// Classify a particld `debug.log` tail: did the daemon report an `Error:` and
/// then shut itself down, both AFTER `since`?
///
/// Pure. Lines are `YYYY-MM-DDTHH:MM:SSZ text`. Both stamps must postdate our
/// own spawn — the log carries every previous session too, and the last
/// session's clean shutdown must never read as this session's death. An
/// `Error:` without a `Shutdown: done` after it is a warning-grade line the
/// daemon survived; only the pair is fatal.
///
/// # Why this exists (2026-09-05, 19:16 UTC)
///
/// particld started, loaded the block index, and ten seconds later wrote
/// `Error: txindex: best block of the index not found. Please rebuild the
/// index.` followed by `Shutdown: done`. The engine then retried PART RPC for
/// ten and a half minutes against a daemon that was already gone, the
/// supervisor reported "health timeout" after three, and the sentence that
/// actually explained it was in a file nothing read.
pub fn classify_particld_log(
    tail: &str,
    since: chrono::DateTime<chrono::Utc>,
) -> Option<ChainDaemonFatal> {
    let mut error_line: Option<String> = None;
    let mut shut_down = false;
    for line in tail.lines() {
        let Some((stamp, rest)) = line.split_once(' ') else {
            continue;
        };
        let Ok(at) = chrono::DateTime::parse_from_rfc3339(stamp) else {
            continue;
        };
        if at.with_timezone(&chrono::Utc) < since {
            continue;
        }
        if let Some(msg) = rest.strip_prefix("Error: ") {
            error_line = Some(msg.trim().to_string());
            shut_down = false;
        }
        if rest.trim() == "Shutdown: done" && error_line.is_some() {
            shut_down = true;
        }
    }
    let line = error_line?;
    if !shut_down {
        return None;
    }
    let txindex_rebuildable = line.contains(PARTICL_TXINDEX_MARKER);
    Some(ChainDaemonFatal { line, txindex_rebuildable })
}

/// The particl chainclient's own directory under the node datadir.
pub fn particl_datadir(datadir: &Path) -> PathBuf {
    datadir.join("particl")
}

/// Read particld's log and classify it — see [`classify_particld_log`].
pub fn chain_daemon_fatal(
    datadir: &Path,
    since: chrono::DateTime<chrono::Utc>,
) -> Option<ChainDaemonFatal> {
    let tail = crate::wallet_rpc_common::read_log_tail(
        &particl_datadir(datadir).join("debug.log"),
        32_768,
    );
    classify_particld_log(&tail, since)
}

fn particl_rpc_port(datadir: &Path) -> Option<u16> {
    let raw = std::fs::read(datadir.join("basicswap.json")).ok()?;
    let text = strip_bom(&raw).ok()?;
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.get("chainclients")?
        .get("particl")?
        .get("rpcport")?
        .as_u64()
        .map(|p| p as u16)
}

/// Repair an inconsistent Particl txindex by deleting it.
///
/// The txindex is DERIVED data: particld rebuilds it from the block files on
/// the next start, in a background thread, while already serving RPC. Nothing
/// else is touched — not the chainstate, not the wallet, not the blocks.
/// Refuses while the daemon's RPC port is bound, because a running daemon owns
/// that directory. Returns the path it removed.
pub async fn repair_particl_txindex(datadir: &Path) -> Result<PathBuf, String> {
    let dir = particl_datadir(datadir).join("indexes").join("txindex");
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    if let Some(port) = particl_rpc_port(datadir) {
        if crate::wallet_rpc_common::port_is_bound(port).await {
            return Err(format!(
                "particld is still serving on port {port}; not touching its index"
            ));
        }
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {}", dir.display(), e))?;
    Ok(dir)
}

// =========================================================================
// Spawn helpers
// =========================================================================

/// Turn a [`SpawnPlan`] into a configured `tokio::process::Command`.
///
/// `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`, explicit working directory,
/// null stdio, and — critically — **no `kill_on_drop`**: dropping the handle
/// must never become an implicit "kill the coordinator first", which is the
/// forbidden shutdown order.
fn command_from_plan(plan: &SpawnPlan) -> tokio::process::Command {
    command_from_plan_ex(plan, false)
}

/// As [`command_from_plan`], but `capture_output` pipes stdout/stderr instead
/// of nulling them.
///
/// W-4: the run parent nulls its stdio (it is long-lived and logs to a file),
/// but **prepare** is a one-shot whose only output channel is stdout
/// (`prepare.py:222` = `logging.StreamHandler(sys.stdout)`) — it never opens
/// `basicswap.log`. Nulling prepare's stdio and then tailing `basicswap.log`
/// on failure (the old behaviour) discarded every first-run cause — a missing
/// daemon under `--nocores`, an import error, an "Unknown argument" — and
/// surfaced "(log file unavailable)". Capturing lets the failure carry its
/// real reason.
fn command_from_plan_ex(plan: &SpawnPlan, capture_output: bool) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&plan.program);
    cmd.args(&plan.args);
    for (k, v) in &plan.envs {
        cmd.env(k, v);
    }
    cmd.current_dir(&plan.cwd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    cmd.stdin(std::process::Stdio::null());
    if capture_output {
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
    } else {
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }
    cmd
}

/// How long to keep draining prepare's pipes after prepare itself has exited.
///
/// Only reached when a daemon prepare spawned is still holding the inherited
/// handles, i.e. exactly the case [`output_after_process_exit`] exists for.
pub const PIPE_DRAIN_MS: u64 = 5_000;

/// Run a command and collect its output, waiting on the **process**, not on
/// its pipes reaching EOF.
///
/// # The deadlock this replaces
///
/// `Command::output()` resolves when stdout and stderr reach EOF — which needs
/// *every* holder of those handles to close them, not just the child. Prepare
/// spawns coin daemons that **inherit** its stdout/stderr, and on the failing
/// path (`finalise_daemon`'s CTRL_C cannot reach a console-less child — the
/// same mechanism the shutdown ladder documents) those daemons outlive it.
///
/// So on 2026-08-20 a prepare that had already printed `Finalising` and exited
/// left `particld` holding the pipe, `output()` never resolved, and the
/// supervisor sat in `Phase::Preparing` — rendered as "Configuring" — forever.
/// Not a slow start: a permanent one, with no error and no timeout.
///
/// **The cleanup was on the wrong side of the await that needed it.**
/// `run_prepare_step` already swept those daemons, twenty lines below a call
/// that could not return until they were gone. A cleanup that cannot run for
/// the reason you need it is the same defect shape as a check that cannot fail
/// for the reason you run it — both look correct in review.
///
/// The fix is ordering, not a timeout: `child.wait()` resolves on process
/// exit regardless of who holds the pipes, so the caller gets the exit status,
/// stops the stragglers, and only then drains. Draining is bounded anyway
/// (`PIPE_DRAIN_MS`), because a daemon we failed to stop must cost a truncated
/// log tail, never the start.
///
/// Both pipes are read on their own tasks from the moment of spawn: a child
/// that fills the OS pipe buffer blocks on write until someone reads, which
/// would deadlock `wait()` just as thoroughly.
async fn output_after_process_exit(
    cmd: tokio::process::Command,
    datadir: &Path,
) -> std::io::Result<std::process::Output> {
    output_after_process_exit_with(cmd, datadir, PIPE_DRAIN_MS).await
}

/// [`output_after_process_exit`] with an injectable drain budget.
///
/// The budget is a parameter purely so the regression test can use a short one
/// and stay in the DEFAULT suite. Behind `#[ignore]` it would protect nothing:
/// this deadlock is invisible to every other check in the project, so the one
/// test that catches it has to be one that actually runs.
async fn output_after_process_exit_with(
    mut cmd: tokio::process::Command,
    datadir: &Path,
    drain_ms: u64,
) -> std::io::Result<std::process::Output> {
    use tokio::io::AsyncReadExt;

    let mut child = cmd.spawn()?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();

    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf).await;
        }
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf).await;
        }
        buf
    });

    let status = child.wait().await?;

    // Prepare has exited. Anything still holding its pipes is a daemon it
    // spawned and failed to stop, and stopping them is both the cleanup this
    // function's caller wants AND what lets the drain below finish.
    // Stop only. Waiting for the ports to FREE is the caller's job and
    // belongs after the LAST prepare in a batch — doing it here made two
    // addcoins pay two full chainstate flushes back to back.
    let swept = stop_prepare_daemons(datadir).await;
    if !swept.is_empty() {
        eprintln!(
            "[swap-sidecar] stopped {} daemon(s) still holding prepare's output pipe",
            swept.len()
        );
    }

    let drain = std::time::Duration::from_millis(drain_ms);
    let stdout = tokio::time::timeout(drain, out_task)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    let stderr = tokio::time::timeout(drain, err_task)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// Last `LOG_TAIL_BYTES` of a captured stream, lossy-decoded and trimmed.
/// Empty input yields an empty string (no noise for the common success path).
fn tail_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    // REDACT FIRST, THEN SLICE. The order is load-bearing and the reverse is a
    // real leak: slicing first can cut away the "IMPORTANT - Save your particl
    // wallet recovery phrase:" header and leave the bare phrase line as the
    // first thing in the tail, where no header-anchored rule can find it.
    // `redact_secrets` therefore also carries context-free rules for exactly
    // that case. See [`redact_secrets`] for what prepare prints and why this
    // function is the only chokepoint.
    let whole = String::from_utf8_lossy(bytes);
    let redacted = redact_secrets(&whole);
    let start = redacted.len().saturating_sub(LOG_TAIL_BYTES as usize);
    // Slice on a char boundary — redaction can shift byte offsets, and the
    // arithmetic above is byte-based.
    let cut = if redacted.is_char_boundary(start) {
        start
    } else {
        (start..redacted.len())
            .find(|i| redacted.is_char_boundary(*i))
            .unwrap_or(0)
    };
    redacted[cut..].trim().to_string()
}

/// Number of whitespace-separated BIP39 words that makes a line a suspected
/// recovery phrase. The shortest real BIP39 mnemonic is 12.
const MIN_MNEMONIC_WORDS: usize = 12;

/// Strip anything that could be a recovery phrase or an extended private key
/// out of text that is about to reach a log or a UI error string.
///
/// # Why this exists (C1.4)
///
/// `basicswap.bin.prepare` prints **secrets to stdout on the success path**:
///
/// ```text
/// IMPORTANT - Save your particl wallet recovery phrase:
/// <24 words>
///
/// Extended private keys (for external wallet import):
///   Litecoin: zprv…
/// ```
///
/// (`prepare.py:1092-1105`, and again at `:1770-1772` — that second site is
/// **not** gated on `generated_mnemonic`, so it fires on every `--addcoin`.)
///
/// W-4 made the supervisor capture prepare's stdout and attach its tail to
/// failure messages, and `PrepareError.detail` is returned to the webview
/// verbatim. Those two facts compose into: *a prepare that fails after wallet
/// init can render the user's recovery phrase into a UI error string.* Nothing
/// else in the pipeline is positioned to catch it, so [`tail_bytes`] is the
/// single chokepoint and this is its filter.
///
/// # The rules, and why each is needed
///
/// 1. **Header-anchored** — the line following the `IMPORTANT - Save your…`
///    banner, and the `  <Coin>: <key>` lines under the extended-keys banner.
///    Precise, but useless once truncation removes the banner.
/// 2. **Extended keys, context-free** — `xprv/yprv/zprv/tprv/vprv/Ltpv/…`
///    base58 runs. These are unambiguous on sight.
/// 3. **Long BIP39 word runs, context-free** — any line of ≥12 whitespace-
///    separated tokens that are *all* BIP39 English words. This is the rule
///    that survives a truncated header.
///
/// Rule 3 is deliberately narrow: it requires **every** token to be in the
/// wordlist, so ordinary diagnostics ("Binding RPC on address 127.0.0.1 port
/// 19792 failed") cannot trip it — those contain numbers and non-wordlist
/// tokens. Over-broadening it would swallow the error text this tail exists to
/// deliver, which is why the test suite pins both directions.
pub fn redact_secrets(text: &str) -> String {
    const REDACTED: &str = "[redacted: possible recovery phrase]";
    const REDACTED_KEY: &str = "[redacted: extended private key]";

    let mut out: Vec<String> = Vec::new();
    let mut expect_phrase_next = false;
    let mut in_extended_keys = false;

    for line in text.lines() {
        let trimmed = line.trim();

        // Rule 1a: the line right after the recovery-phrase banner.
        if expect_phrase_next {
            expect_phrase_next = false;
            if !trimmed.is_empty() {
                out.push(REDACTED.to_string());
                continue;
            }
            // A blank line between banner and phrase: keep looking.
            expect_phrase_next = true;
            out.push(line.to_string());
            continue;
        }
        if trimmed.starts_with("IMPORTANT - Save your")
            || trimmed.starts_with("IMPORTANT - Save this")
        {
            expect_phrase_next = true;
            out.push(line.to_string());
            continue;
        }

        // Rule 1b: the indented `  <Coin>: <key>` block under the banner.
        if trimmed.starts_with("Extended private keys") {
            in_extended_keys = true;
            out.push(line.to_string());
            continue;
        }
        if in_extended_keys {
            if trimmed.is_empty() {
                in_extended_keys = false;
                out.push(line.to_string());
                continue;
            }
            if trimmed.contains(':') && !trimmed.starts_with("NOTE") && !trimmed.starts_with("WARNING") {
                out.push(REDACTED_KEY.to_string());
                continue;
            }
            in_extended_keys = false;
        }

        // Rules 2 and 3 are context-free and run on every remaining line.
        if line_has_extended_private_key(trimmed) {
            out.push(REDACTED_KEY.to_string());
            continue;
        }
        if line_is_probable_mnemonic(trimmed) {
            out.push(REDACTED.to_string());
            continue;
        }
        out.push(line.to_string());
    }
    out.join("\n")
}

/// True when a line contains a base58 extended **private** key.
///
/// Matches the private prefixes only (`xprv`, `yprv`, `zprv`, `tprv`, `vprv`,
/// `uprv`, and Litecoin's `Ltpv`). Public forms (`xpub`/`zpub`/…) are left
/// alone deliberately: they are not secret, and redacting them would remove
/// genuinely useful diagnostics.
fn line_has_extended_private_key(line: &str) -> bool {
    const PRIVATE_PREFIXES: &[&str] = &["xprv", "yprv", "zprv", "tprv", "vprv", "uprv", "Ltpv"];
    for token in line.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',') {
        let t = token.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        if t.len() < 50 {
            continue;
        }
        if PRIVATE_PREFIXES.iter().any(|p| t.starts_with(p))
            && t.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return true;
        }
    }
    false
}

/// True when every whitespace-separated token on the line is a BIP39 English
/// word and there are at least [`MIN_MNEMONIC_WORDS`] of them.
///
/// The all-tokens requirement is what keeps ordinary log lines safe: a real
/// diagnostic almost always carries a number, a path, or punctuation, none of
/// which are wordlist entries.
fn line_is_probable_mnemonic(line: &str) -> bool {
    // Find the longest RUN of consecutive BIP39 words anywhere in the line,
    // after splitting on every non-alphabetic character.
    //
    // The first version of this required *every* whitespace token to be a
    // wordlist entry, which an adversarial review broke in three ways with one
    // adjacent character each — all of which reach the webview verbatim through
    // `PrepareError.detail`:
    //
    //   abandon … about.                               (trailing period)
    //   Unknown argument --particl_mnemonic=abandon …  (prepare.py:1403 echoes argv)
    //   ValueError: bad phrase 'abandon … about'       (quoted in an exception)
    //
    // A whole-line predicate cannot see a phrase embedded in anything. A run
    // detector can, and splitting on non-alphabetic characters is what makes
    // `--particl_mnemonic=abandon` yield `abandon` as the start of a run.
    //
    // The false-positive risk is bounded by the wordlist itself: BIP39 English
    // deliberately excludes short function words ("the", "of", "is", "a"), so a
    // run of twelve *consecutive* entries essentially cannot occur in prose.
    // `tail_preserves_diagnostics` pins that direction.
    let mut run = 0usize;
    for token in line.split(|c: char| !c.is_ascii_alphabetic()) {
        if token.is_empty() {
            continue;
        }
        if is_bip39_english_word(token) {
            run += 1;
            if run >= MIN_MNEMONIC_WORDS {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// Membership test against the real BIP39 English wordlist.
///
/// Uses the `bip39` crate the wallet already depends on rather than a
/// hand-rolled heuristic ("12+ short lowercase tokens"), because a heuristic
/// would redact ordinary prose diagnostics — "the system cannot find the file
/// specified please check that the path exists" is twelve lowercase words — and
/// swallowing the error text is the failure this redaction must not cause.
fn is_bip39_english_word(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    bip39::Language::English.find_word(&lower).is_some()
}

/// Drop a leading UTF-8 BOM if present, returning the rest as `&str`.
///
/// We READ tolerantly (a BOM someone else wrote must not break us) but always
/// WRITE without one — see [`disable_update_ping`].
pub(crate) fn strip_bom(bytes: &[u8]) -> Result<&str, String> {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    std::str::from_utf8(body).map_err(|e| format!("basicswap.json is not UTF-8: {}", e))
}

/// Disable the P2P inbound listener on every btc-family coin daemon
/// (`listen=0`) — the fix for the Windows Defender Firewall "allow access"
/// prompt.
///
/// A full node binds a P2P listening socket on **all** interfaces to accept
/// inbound peers, and Windows prompts the first time an unregistered binary
/// opens a non-loopback listener. That is why BasicSwap prompts (it runs full
/// `particld`/`litecoind`/… daemons) while the base wallet never does (it uses
/// light/remote clients — outbound-only, no listener). A swap client needs
/// only OUTBOUND connectivity: SMSG propagates over the peers we dial, so
/// listening is unnecessary. `listen=0` removes the prompt and trims startup
/// work. RPC and ZMQ already bind loopback, so they never prompt.
///
/// Prepended as a global option so it applies under every network section.
/// Idempotent: a conf that already sets `listen=` is left untouched. Monero is
/// not btc-family — a *local* monerod would need its own p2p-bind handling, but
/// the production config runs XMR on a remote node, so no local monerod exists.
fn harden_daemon_confs(datadir: &Path) -> Result<(), String> {
    const BTC_FAMILY: &[&str] = &[
        "particl",
        "litecoin",
        "bitcoin",
        "dogecoin",
        "dash",
        "firo",
        "namecoin",
        "bitcoincash",
    ];
    let dbcache = daemon_dbcache_mb();
    for coin in BTC_FAMILY {
        let conf = datadir.join(coin).join(format!("{}.conf", coin));
        if !conf.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&conf)
            .map_err(|e| format!("read {}.conf: {}", coin, e))?;

        // Each setting is prepended only if the conf does not already carry it,
        // so a user hand-edit is never clobbered and a re-run is a no-op. Both
        // are cheap line scans, so the file is written at most once.
        let mut prefix = String::new();
        if !conf_has_key(&text, "listen") {
            prefix.push_str("listen=0\n");
        }
        // dbcache is the IBD accelerator. The 450 MB default forces the
        // chainstate to flush to LevelDB constantly, which on a machine with
        // RAM to spare is pure disk thrash (measured: particld ~0% CPU, disk
        // queue ~3 during sync). Sizing it from real RAM keeps a 4 GB machine
        // safe while letting a 64 GB one actually use its memory. dbcache is a
        // CEILING, not a reservation — Core releases it after IBD — so it is
        // safe to leave set permanently and needs no post-sync cleanup.
        if !conf_has_key(&text, "dbcache") {
            prefix.push_str(&format!("dbcache={}\n", dbcache));
        }

        if prefix.is_empty() {
            continue;
        }
        let out = format!("{}{}", prefix, text);
        std::fs::write(&conf, out.as_bytes())
            .map_err(|e| format!("write {}.conf: {}", coin, e))?;
    }
    Ok(())
}

/// True when a bitcoind-style conf already sets `key=` on some line.
fn conf_has_key(text: &str, key: &str) -> bool {
    let needle = format!("{}=", key);
    text.lines().any(|l| l.trim_start().starts_with(&needle))
}

// =========================================================================
// Particl pruning (Option A) — particl-pruned-node-and-snapshot-plan.md
// =========================================================================

/// Block-file budget for a pruned Particl node, in MiB.
///
/// 550 is particl-core's own floor (`MIN_DISK_SPACE_FOR_BLOCK_FILES`; a node
/// started with it reports `prune_target_size` 576,716,800). It is not a
/// compromise: a Particl block is ~250 bytes (one coinstake), so a measured
/// probe at tip 2,239,559 still retained from height 1,764,346 — **475,213
/// blocks, about 1.8 years**. Every swap lock window is 24-96 h, so the
/// retained span is three orders of magnitude larger than anything the engine
/// needs to look back at.
pub const PARTICL_PRUNE_MIB: u64 = 550;

/// The Particl daemon this build ships, as `scripts/fetch-swap-runtime.mjs`
/// pins it.
///
/// Used to refuse a chain snapshot built for a different daemon: a LevelDB
/// chainstate and Particl's own block-index fields belong to the version that
/// wrote them, and loading one under another version is how a "corrupt
/// chainstate" report arrives from a user whose disk is fine. Pinned against
/// the fetcher by [`tests::particld_version_matches_the_fetcher_pin`], so the
/// two cannot drift silently — the same guard shape `grove.rs` uses for the
/// engine tag.
pub const PARTICLD_VERSION: &str = "27.2.4.0";

/// What a Particl datadir on disk allows us to do with `prune=`.
///
/// The distinction exists because `-prune` and the two indexes are mutually
/// exclusive in particl-core (`init.cpp:1130`, `:1136-1140`), and a chain that
/// was *already synced* with `txindex`/`spentindex` cannot simply have them
/// removed: the node aborts with "best block of the index goes beyond pruned
/// data" (`init.cpp:2302`). Converting needs a `-reindex` (measured ~8 h,
/// slower than a fresh network sync) or a fresh datadir, and neither is a
/// thing a config writer may decide to do to a user's node behind their back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticlChainMode {
    /// No chain yet, or a chain that already carries no indexes. Safe to write
    /// the pruned conf.
    Prunable,
    /// An existing chain synced WITH the indexes. Leave the conf alone; the
    /// migration is the operator's (fresh datadir, or a snapshot).
    IndexedChainPresent,
}

/// Classify a Particl datadir by what is on disk.
///
/// Deliberately a pure function of two path probes so the decision can be
/// tested without a node:
///
/// * no `blocks/` → nothing has synced yet → [`Prunable`](ParticlChainMode::Prunable)
/// * `blocks/` **and** `indexes/txindex` → an indexed chain →
///   [`IndexedChainPresent`](ParticlChainMode::IndexedChainPresent)
/// * `blocks/` and no `indexes/txindex` → already index-less (a previous
///   pruned run, or a restored snapshot) → `Prunable`
///
/// The `indexes/txindex` probe rather than a conf read is deliberate: the conf
/// is what we are about to rewrite, so trusting it would let one bad write
/// make every later run agree with it. The directory is the evidence.
pub fn particl_chain_mode(particl_dir: &Path) -> ParticlChainMode {
    if !particl_dir.join("blocks").is_dir() {
        return ParticlChainMode::Prunable;
    }
    if particl_dir.join("indexes").join("txindex").is_dir() {
        return ParticlChainMode::IndexedChainPresent;
    }
    ParticlChainMode::Prunable
}

/// Rewrite a `particl.conf` for pruned operation, or `None` when it already is.
///
/// Upstream's `interface/part/core.py:123-124` writes `spentindex=1` and
/// `txindex=1` into every Particl conf it generates. Those two lines serve
/// exactly one thing the engine does — swaps in which **PART itself is a leg**
/// (`basicswap.py:9659` `getrawtransaction`, `:10897` `getspentinfo`) — and
/// pwnda never offers PART as a leg ([`MANDATORY_COIN`] is transport;
/// `FOLLOWER_COUNTERPARTY_TICKERS` omits it). SMSG, which is the reason
/// particld is mandatory at all, reads a synced *tip* and nothing else: no
/// txindex reference exists anywhere in particl-core's `smsg/`, and its keys
/// live in SMSG's own database. So dropping the indexes costs a capability we
/// do not use and keeps the one we depend on. Full argument, with the
/// measurements: `particl-coin-vs-transport.md`.
///
/// Returns `None` when nothing needs to change, so a re-run is a no-op and the
/// file is written at most once — the same contract
/// [`harden_daemon_confs`] holds.
///
/// A hand-set `prune=` is honoured as-is (any value, including `prune=0` for
/// someone who deliberately wants an archival node); the index lines are still
/// stripped, because leaving them beside a `prune=` is the one combination
/// particld refuses to start on.
pub fn prune_particl_conf(text: &str, prune_mib: u64) -> Option<String> {
    let has_index_lines = text
        .lines()
        .any(|l| is_conf_line(l, "txindex") || is_conf_line(l, "spentindex"));
    let has_prune = conf_has_key(text, "prune");
    if !has_index_lines && has_prune {
        return None;
    }
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !is_conf_line(l, "txindex") && !is_conf_line(l, "spentindex"))
        .collect();
    let mut out = String::new();
    if !has_prune {
        out.push_str(&format!("prune={}\n", prune_mib));
    }
    out.push_str(&kept.join("\n"));
    if text.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    Some(out)
}

/// True when a conf line sets `key`, ignoring leading whitespace.
///
/// Separate from [`conf_has_key`] because this one is applied per line to
/// decide what to DELETE, and deleting on a prefix match would eat a
/// hypothetical `txindexfoo=`. Both halves matter: `txindex=1` must go and
/// `# txindex=1` must stay (a comment is a user's note, not a setting).
fn is_conf_line(line: &str, key: &str) -> bool {
    let t = line.trim_start();
    t.starts_with(key) && t[key.len()..].starts_with('=')
}

/// Apply [`prune_particl_conf`] to a datadir, if the chain on disk allows it.
///
/// `Ok(true)` = the conf was rewritten, `Ok(false)` = nothing to do (already
/// pruned, no conf yet, or an indexed chain we must not touch). Non-fatal at
/// the call site like its neighbours: a disk-size preference must never block
/// a start.
fn apply_particl_prune_policy(datadir: &Path) -> Result<bool, String> {
    let particl_dir = datadir.join(MANDATORY_COIN);
    let conf = particl_dir.join(format!("{}.conf", MANDATORY_COIN));
    if !conf.is_file() {
        return Ok(false);
    }
    if particl_chain_mode(&particl_dir) == ParticlChainMode::IndexedChainPresent {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&conf).map_err(|e| format!("read particl.conf: {}", e))?;
    let Some(out) = prune_particl_conf(&text, PARTICL_PRUNE_MIB) else {
        return Ok(false);
    };
    std::fs::write(&conf, out.as_bytes()).map_err(|e| format!("write particl.conf: {}", e))?;
    Ok(true)
}

/// dbcache size in MB, sized from system RAM.
///
/// `total_mb / 8`, clamped to `[512, 4096]`:
///
/// * the floor keeps it at least as large as Core's 450 MB default even on a
///   tiny box, so this can never make sync SLOWER;
/// * the `/8` leaves the other seven-eighths of RAM for the OS, the webview,
///   any sibling daemons, and the user's own machine — three full nodes each
///   taking this is still a fraction of a modest install;
/// * the ceiling is 4 GB because Particl's UTXO set is far smaller than
///   Bitcoin's, so the resident-working-set benefit saturates well below it —
///   past ~4 GB you are reserving RAM the IBD cannot use.
///
/// A machine whose RAM cannot be read falls back to 1024 MB: still more than
/// double the default, and safe anywhere that can run the node at all.
pub fn daemon_dbcache_mb() -> u64 {
    let total = system_ram_mb().unwrap_or(8 * 1024);
    (total / 8).clamp(512, 4096)
}

/// Total physical RAM in MB, or `None` if it cannot be determined.
///
/// Kept dependency-free: a raw FFI on Windows and `/proc/meminfo` on Linux,
/// so it adds nothing to `Cargo.toml` and compiles on both the Windows dev
/// target and the Linux release build.
fn system_ram_mb() -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }
        extern "system" {
            fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
        }
        let mut m = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };
        // Safe: `m` is a valid, fully-initialised buffer of the size we
        // declared in `dw_length`, and the call only writes into it.
        let ok = unsafe { GlobalMemoryStatusEx(&mut m) };
        if ok != 0 && m.ull_total_phys > 0 {
            return Some(m.ull_total_phys / (1024 * 1024));
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        // `MemTotal:      16311072 kB`
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
                return Some(kb / 1024);
            }
        }
        None
    }
}

/// Set `check_updates: false` in `<datadir>/basicswap.json` (DEC-3), writing
/// the file back as **BOM-less UTF-8** (W-10).
///
/// W-10 is not cosmetic: PowerShell's `Set-Content -Encoding utf8` emits a BOM,
/// and upstream opens the config with a plain `json.load` that rejects it
/// (`JSONDecodeError: Unexpected UTF-8 BOM`), so the node dies at startup with
/// a decode error. Rust's `fs::write` adds no BOM; the risk is only in
/// "helpfully" adding one, so this path is asserted BOM-free by test.
/// Idempotent: if the key is already `false` the file is left untouched.
fn disable_update_ping(datadir: &Path) -> Result<(), String> {
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    if v.get("check_updates") == Some(&serde_json::Value::Bool(false)) {
        return Ok(());
    }
    match v.as_object_mut() {
        Some(obj) => {
            obj.insert("check_updates".to_string(), serde_json::Value::Bool(false));
        }
        None => return Err("basicswap.json is not a JSON object".to_string()),
    }
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    // BOM-less UTF-8 (W-10). `fs::write` does not prepend a BOM.
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))
}

// =========================================================================
// C0.2 - the user's Monero node, all the way into basicswap.json
// =========================================================================

/// Parse a node URL into `(host, port)`.
///
/// Accepts what the wallet's own node picker produces and what a user is
/// likely to paste: `http://host:port`, `https://host:port`, and a bare
/// `host:port`. A path/query/fragment is discarded.
///
/// **A missing port is filled in from the SCHEME, never guessed for Monero.**
/// `https://node.example.org` is port 443 because that is what the URL means;
/// a bare `node.example.org` with no scheme and no port yields `None`, because
/// the only way to produce a number there is to invent one, and an invented
/// port silently points the swap engine at nothing. Refusing is the honest
/// answer: the caller then leaves the node unpinned instead of writing a
/// broken `rpcport` into `basicswap.json`.
pub fn parse_node_url(raw: &str) -> Option<(String, u16)> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let (scheme_port, rest) = if let Some(r) = t.strip_prefix("http://") {
        (Some(80u16), r)
    } else if let Some(r) = t.strip_prefix("https://") {
        (Some(443u16), r)
    } else if t.contains("://") {
        // Some other scheme entirely (ftp://, ssh://, ...) - not ours.
        return None;
    } else {
        (None, t)
    };
    // Drop credentials, path, query and fragment.
    let rest = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    if authority.is_empty() {
        return None;
    }
    // Bracketed IPv6 literal: `[::1]:18081` or `[::1]`.
    if let Some(close) = authority.strip_prefix('[').and_then(|_| authority.find(']')) {
        let host = &authority[..=close];
        let tail = &authority[close + 1..];
        let port = match tail.strip_prefix(':') {
            Some(p) => p.parse::<u16>().ok()?,
            None => scheme_port?,
        };
        return non_empty_host(host).map(|h| (h, port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => {
            // A bare IPv6 literal has several colons and no port at all -
            // `rsplit_once` would hand back a "port" cut out of the address.
            if host.contains(':') {
                return None;
            }
            let port: u16 = port.parse().ok()?;
            if port == 0 {
                return None;
            }
            non_empty_host(host).map(|h| (h, port))
        }
        None => {
            if authority.matches(':').count() > 0 {
                return None;
            }
            let port = scheme_port?;
            non_empty_host(authority).map(|h| (h, port))
        }
    }
}

fn non_empty_host(h: &str) -> Option<String> {
    let h = h.trim();
    if h.is_empty() || h.contains(char::is_whitespace) {
        None
    } else {
        Some(h.to_string())
    }
}

/// The store key the wallet's Monero node picker writes
/// (`src/wallets/xmr-nodes.ts:83`, `SELECTED_NODE_KEY`).
pub const XMR_SELECTED_NODE_STORE_KEY: &str = "xmr_selected_node";

/// The node the wallet's AUTO selection last actually used, written by
/// `src/wallets/xmr-nodes.ts` whenever a node answers a real RPC.
///
/// # Why a second key exists
///
/// `xmr_selected_node` is the user's explicit pin, and `""` means auto — which
/// is the DEFAULT, so on most installs the key never exists at all. The pin
/// reader below was therefore a reader with no writer for the population that
/// matters, and every argless start (autostart, the Settings Start button)
/// resolved no node, which let prepare default the Monero chainclient to a
/// LOCAL monerod. Found on 2026-08-20 with 6.6 GB of unasked-for monerod
/// chaindata on disk and `manage_daemon: true` in a config whose owner runs a
/// remote node in the wallet one panel over.
pub const XMR_LAST_ACTIVE_NODE_STORE_KEY: &str = "xmr_last_active_node";

/// Recently-healthy Monero nodes, best first, written by
/// `src/wallets/xmr-nodes.ts` as nodes prove themselves on real RPCs.
///
/// The candidate POOL for the swap node, and the reason it exists separately
/// from the two single-value keys above: the sidecar bakes one node into
/// `basicswap.json`, `run.py` reads that file once at startup, and a node that
/// is down at that moment yields a swap node whose Monero wallet errors for
/// the whole session with no recovery (`getWalletsInfo: XMR timed out`,
/// observed live 2026-08-20). One candidate cannot be redundant; a list can.
///
/// Deliberately NOT a second copy of the Feather pool in Rust. The wallet
/// already owns node discovery, health-ranking and fallback; duplicating that
/// table here would give the two layers separate opinions about which nodes
/// exist. This key is the wallet TELLING the supervisor what it has found.
pub const XMR_RECENT_NODES_STORE_KEY: &str = "xmr_recent_nodes";

/// How long a single candidate gets to answer `/get_info` before we move on.
///
/// Short on purpose: this runs on the start path, once per dead candidate, and
/// a node that cannot greet us in 4s is not one to hand a swap to.
pub const XMR_PROBE_TIMEOUT_MS: u64 = 4_000;

/// Ordered, de-duplicated Monero node candidates from a `tauri-plugin-store`
/// payload: the user's explicit pin first, then whatever the wallet has
/// recently found healthy.
///
/// The explicit pin leads but does **not** veto: if the user's chosen node is
/// down, falling through to a working one beats handing them a swap node whose
/// Monero wallet times out all session. Which node was actually used is logged,
/// so "my pin was ignored" is answerable rather than mysterious.
pub fn xmr_node_candidates_from_store_json(text: &str) -> Vec<(String, u16)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut out: Vec<(String, u16)> = Vec::new();
    let mut push = |hit: Option<(String, u16)>| {
        if let Some(h) = hit {
            if !out.contains(&h) {
                out.push(h);
            }
        }
    };
    for key in [XMR_SELECTED_NODE_STORE_KEY, XMR_LAST_ACTIVE_NODE_STORE_KEY] {
        push(v.get(key).and_then(|x| x.as_str()).and_then(parse_node_url));
    }
    if let Some(arr) = v.get(XMR_RECENT_NODES_STORE_KEY).and_then(|x| x.as_array()) {
        for item in arr {
            push(item.as_str().and_then(parse_node_url));
        }
    }
    out
}

/// Read the candidate list from the wallet's store file.
pub fn xmr_node_candidates(app: &AppHandle) -> Vec<(String, u16)> {
    let Ok(base) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(base.join("wallet.dat")) else {
        return Vec::new();
    };
    xmr_node_candidates_from_store_json(&text)
}

/// First candidate whose `/get_info` answers, probed in order.
///
/// Sequential rather than raced: the order encodes preference (the user's pin
/// leads), and racing would hand the swap node whichever stranger replied
/// fastest. The cost of sequential probing is bounded by
/// [`XMR_PROBE_TIMEOUT_MS`] per DEAD candidate, and the common case — the
/// first one is alive — costs one round trip.
///
/// `None` means every candidate failed, which is NOT the same as having no
/// candidates: the caller must not silently fall back to a local monerod after
/// a real outage, because that is an ~80 GB decision made on a network blip.
pub async fn pick_healthy_xmr_node(candidates: &[(String, u16)]) -> Option<(String, u16)> {
    for (host, port) in candidates {
        let url = format!("http://{}:{}", host, port);
        let r = crate::wallet_rpc_common::probe_node(url, XMR_PROBE_TIMEOUT_MS).await;
        if r.ok {
            return Some((host.clone(), *port));
        }
        eprintln!(
            "[swap-sidecar] monero node {}:{} did not answer ({}), trying the next",
            host,
            port,
            r.error.unwrap_or_else(|| "no reason given".to_string())
        );
    }
    None
}

/// Resolve the Monero node for a session: **explicit args > stored pin > none**.
///
/// Pure so the precedence is a test rather than a code-reading exercise. An
/// explicit host wins outright, including the case where the caller passed a
/// host and no port - answering that with the pin's port would silently mix
/// two different nodes' halves.
pub fn resolve_xmr_node(
    explicit_host: Option<String>,
    explicit_port: Option<u16>,
    pinned: Option<(String, u16)>,
) -> (Option<String>, Option<u16>) {
    match explicit_host {
        Some(h) => (Some(h), explicit_port),
        None => match pinned {
            Some((h, p)) => (Some(h), Some(p)),
            // W-9: a port with no host is dropped by `shared_envs` anyway;
            // carrying it no further keeps that decision in one place.
            None => (None, None),
        },
    }
}

/// Write the pinned Monero node into `<datadir>/basicswap.json`'s
/// `chainclients.monero`, returning `true` when the file was changed.
///
/// # Why the env var alone is a no-op (R17)
///
/// `XMR_RPC_HOST` is read by `interface/xmr/core.py:26` **at import time**, and
/// `getConfigSegment` bakes its value into `basicswap.json` as `rpchost`
/// (`:48`). That happens during **prepare**. `run.py` never looks at the env
/// var - it loads the settings FILE. So on any install that already has a
/// config, exporting `XMR_RPC_HOST` into the run plan changes nothing at all,
/// and a test that only asserts the env was emitted cannot fail for the reason
/// we run it. The node pin only takes effect if it is written HERE.
///
/// `manage_daemon: false` goes with it: a remote node means there is no local
/// monerod for the engine to start, and leaving `manage_daemon: true` next to a
/// remote `rpchost` makes the engine try to launch a daemon it has no binary
/// for.
///
/// `rpcport` is written verbatim - **not** offset. Upstream applies
/// `+ ctx.port_offset` to it at prepare time, which is right for a daemon it
/// launches itself and wrong for somebody else's node on a fixed port.
///
/// BOM-less write, same discipline as [`disable_update_ping`] (W-10), and
/// idempotent: an already-correct block is left byte-identical.
fn apply_xmr_node_to_config(datadir: &Path, host: &str, port: u16) -> Result<bool, String> {
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(monero) = v
        .get_mut("chainclients")
        .and_then(|c| c.get_mut("monero"))
        .and_then(|m| m.as_object_mut())
    else {
        // XMR is not a configured coin on this install. Creating the block
        // ourselves would invent every other key upstream's own
        // `getConfigSegment` fills in, so this is deliberately a no-op.
        return Ok(false);
    };
    let want_host = serde_json::Value::String(host.to_string());
    let want_port = serde_json::Value::from(port);
    let already = monero.get("rpchost") == Some(&want_host)
        && monero.get("rpcport") == Some(&want_port)
        && monero.get("manage_daemon") == Some(&serde_json::Value::Bool(false));
    if already {
        return Ok(false);
    }
    monero.insert("rpchost".to_string(), want_host);
    monero.insert("rpcport".to_string(), want_port);
    monero.insert("manage_daemon".to_string(), serde_json::Value::Bool(false));
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    // BOM-less UTF-8 (W-10).
    std::fs::write(&path, out.as_bytes())
        .map_err(|e| format!("write basicswap.json: {}", e))?;
    Ok(true)
}

/// C9 — point the engine's MAIN Monero wallet at the wallet's own
/// `monero-wallet-rpc`, so swaps run from the user's actual XMR balance.
///
/// # Why this is config and not code
///
/// `xmr.py:123,191-197` reads the wallet-rpc host, port, auth and the main
/// wallet's filename straight from the coin's `chainclients` block. Writing
/// four keys is therefore the whole of "the engine's main wallet is now the
/// user's wallet" — the engine already supports being pointed somewhere else;
/// it simply has never been pointed at a wallet it does not own.
///
/// What is NOT config, and is why `PWNDA-PATCH-5` exists: the engine
/// multiplexes ONE wallet-rpc between the main wallet and each swap's b-lock
/// wallet. Sharing the process without the patch would let the engine open a
/// swap wallet on OUR rpc, and a concurrent pwnda `transfer` would then spend
/// from the swap's wallet. The patch adds `mainwalletrpc*` as a SECOND client
/// so per-swap wallets stay on the engine's own process; these keys are what
/// activate it.
///
/// Refuses on an engine that does not carry the patch: without it,
/// `mainwalletrpcport` is an unread key and the caller would believe wallets
/// were shared while the engine quietly ran its own — with the user's XMR
/// sitting where no swap can reach it.
///
/// Returns `Ok(false)` when nothing needed changing.
///
/// Called from `apply_local_config_policy` when `SidecarConfig::xmr_host_wallet`
/// is `Some` — see `maybe_activate_xmr_host_wallet` for how that gets populated.
pub fn apply_host_xmr_wallet_to_config(
    datadir: &Path,
    engine_pkg: &Path,
    host: &str,
    port: u16,
    auth_user: &str,
    auth_pass: &str,
    wallet_name: &str,
) -> Result<bool, String> {
    if !engine_has_patch(engine_pkg, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-5") {
        return Err(
            "this swap-node runtime does not carry the Monero wallet-split patch \
             (upstream/patches/0005); sharing the wallet with it would let the \
             swap node open its own wallets on this wallet's RPC"
                .to_string(),
        );
    }
    if !engine_has_patch(engine_pkg, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-8")
        || !engine_has_patch(engine_pkg, XMR_HOST_WALLET_CHECKS_PATCH_FILE, "PWNDA-PATCH-8")
    {
        return Err(
            "this swap-node runtime does not carry the host-wallet-checks patch \
             (upstream/patches/0008); without it checkWalletSeed refuses every \
             XMR swap against a host-managed wallet, and publishBLockTx has no \
             guard against sending from a wallet that changed underneath it"
                .to_string(),
        );
    }
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(monero) = v
        .get_mut("chainclients")
        .and_then(|c| c.get_mut("monero"))
        .and_then(|m| m.as_object_mut())
    else {
        return Ok(false);
    };

    let want: Vec<(&str, serde_json::Value)> = vec![
        ("mainwalletrpchost", serde_json::Value::String(host.to_string())),
        ("mainwalletrpcport", serde_json::Value::from(port)),
        // A 2-element JSON ARRAY, not a "user:pass" string: `callrpc_xmr`
        // (rpc_xmr.py) does `auth[0]`/`auth[1]`, exactly the tuple shape
        // upstream's own `walletrpcauth` already uses
        // (`(chain_client_settings["walletrpcuser"],
        // chain_client_settings["walletrpcpassword"])` in `initialiseWallet`).
        // A JSON array round-trips through `json.load` into a Python list,
        // which indexes identically to a tuple for this purpose. A plain
        // string would silently index by CHARACTER (`"ab:cd"[0] == "a"`) --
        // no exception, just a wallet-rpc auth request that can never
        // succeed. Found live, 2026-08-21: see PwndaWalletVault/log.md.
        (
            "mainwalletrpcauth",
            serde_json::Value::Array(vec![
                serde_json::Value::String(auth_user.to_string()),
                serde_json::Value::String(auth_pass.to_string()),
            ]),
        ),
        // The engine opens `wallet_name` as its main wallet. Pointing it at the
        // wallet's own file is what makes "the main wallet" mean the user's.
        ("wallet_name", serde_json::Value::String(wallet_name.to_string())),
    ];
    if want.iter().all(|(k, val)| monero.get(*k) == Some(val)) {
        return Ok(false);
    }
    for (k, val) in want {
        monero.insert(k.to_string(), val);
    }
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))?;
    Ok(true)
}

/// Relative path of the file carrying `PWNDA-PATCH-5`, inside the engine
/// package.
pub const XMR_SPLIT_PATCH_FILE: &str = "interface/xmr/xmr.py";
/// Relative path of the file carrying `PWNDA-PATCH-3`.
pub const ACCOUNT_KEY_PATCH_FILE: &str = "wallet_manager.py";
/// `PWNDA-PATCH-8` touches two files; `basicswap.py`'s hunk is the one
/// `apply_host_xmr_wallet_to_config` gates on IN ADDITION to `xmr.py`'s
/// (already covered by [`XMR_SPLIT_PATCH_FILE`] since 8 depends on 5's
/// `_external_main_wallet`) — a half-applied 8 (only one file patched) is
/// worse than an absent one: `checkWalletSeed` would refuse every swap
/// while `publishBLockTx` sends unguarded, or vice versa.
pub const XMR_HOST_WALLET_CHECKS_PATCH_FILE: &str = "basicswap.py";

/// Is a given engine patch present in an installed package?
///
/// The marker grep the patch series' README calls "the cheap check the
/// supervisor can run on a runtime image it did not build". Cheap is the point:
/// it answers *before* anything is configured, so a runtime that cannot honour
/// a setting is refused rather than silently ignoring it.
///
/// A marker proves the patch was applied, NOT that the patched engine still
/// behaves — that is what `scripts/swap/verify-account-key-patches.py` and
/// `scripts/swap/verify-xmr-wallet-split.py` are for, and they must be re-run
/// on every upstream bump.
pub fn engine_has_patch(engine_pkg: &Path, rel: &str, marker: &str) -> bool {
    let mut path = engine_pkg.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    std::fs::read_to_string(path)
        .map(|s| s.contains(marker))
        .unwrap_or(false)
}

/// The installed `basicswap` package inside the sidecar runtime.
///
/// Windows embeddable CPython lays site-packages out as `Lib/site-packages`;
/// the lowercase `lib/` spelling is checked too so a Linux-built runtime is
/// not silently reported as unpatched (which would refuse a feature for the
/// wrong reason).
pub fn engine_package_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let rt = runtime_dir(app)?;
    for rel in ["Lib/site-packages/basicswap", "lib/site-packages/basicswap"] {
        let mut p = rt.clone();
        for part in rel.split('/') {
            p.push(part);
        }
        if p.is_dir() {
            return Ok(p);
        }
    }
    // Linux venvs interpose a python3.x directory.
    if let Ok(entries) = std::fs::read_dir(rt.join("lib")) {
        for e in entries.flatten() {
            let p = e.path().join("site-packages").join("basicswap");
            if p.is_dir() {
                return Ok(p);
            }
        }
    }
    Err("the swap runtime's basicswap package was not found".to_string())
}

/// A public Monero remote node already in `xmr-nodes-feather.ts`'s baked-in
/// pool (`FEATHER_NODES`, operator "cakewallet") — reused here rather than
/// invented, since it's a node the frontend's own code already trusts.
///
/// Only a BOOTSTRAP value: it makes `monero-wallet-rpc`'s startup probe
/// (`get_languages`, no wallet, no daemon dependency) succeed so the process
/// is listening in time for the swap engine's own startup probe. It is never
/// used to move funds — the user's own session, whenever the vault unlocks,
/// live-switches this SAME process to the user's actual preferred/pinned
/// node via `switchXmrDaemon`'s `set_daemon` RPC (no restart, so it does not
/// touch the lease this function acquires).
const XMR_BOOTSTRAP_DAEMON: &str = "http://xmr-node.cakewallet.com:18081";

/// C9 — activate Monero wallet sharing for this swap-node start, if consent
/// and capability both hold. Returns `None` on ANYTHING short of full
/// success — no consent, no patched engine, the wallet-rpc process failing
/// to start — and NEVER propagates an error to the caller: XMR sharing is
/// additive, and a failure to activate it must degrade to "the engine runs
/// its own Monero wallet, same as every install before C9", never to "the
/// swap node — including BTC/LTC, which have nothing to do with this —
/// doesn't start". See blocker 1 in
/// PwndaWalletVault/wiki/synthesis/c9-xmr-lifecycle-design.md for exactly
/// what happens if this reasoning is wrong: the engine's own startup probe
/// for a MISSING host wallet-rpc retries for 600s and then exits.
///
/// Primary-wallet only, deliberately: `wallet_name` here is always
/// [`crate::xmr_rpc::XMR_PRIMARY_WALLET_FILENAME`]. A per-wallet (Phase-2
/// multi-wallet) filename is not knowable at autostart with the vault
/// locked (no session, no active-wallet selection yet exists), and
/// `wallet_name` is written once into a config the engine reads once — it
/// cannot be changed under a running engine the way switching the ACTIVE
/// wallet in pwnda's own UI can. Sharing a secondary XMR wallet is
/// future work, not a narrower version of this one.
async fn maybe_activate_xmr_host_wallet(app: &AppHandle) -> Option<XmrHostWalletParams> {
    let rec = read_optin(app);
    let consented = rec
        .coins
        .get("monero")
        .map(|e| e.xmr_host_wallet_ack_at.is_some())
        .unwrap_or(false);
    if !consented {
        return None;
    }

    let engine_pkg_dir = match engine_package_dir(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[swap-sidecar] C9: engine package not found, skipping: {}", e);
            return None;
        }
    };

    // Pre-check both patches before starting anything — starting the
    // wallet-rpc process (acquiring the SwapEngine lease) only to have
    // `apply_host_xmr_wallet_to_config` refuse the config write afterward
    // would leave a process running for nothing, holding a lease nobody
    // ends up using.
    let patched = engine_has_patch(&engine_pkg_dir, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-5")
        && engine_has_patch(&engine_pkg_dir, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-8")
        && engine_has_patch(
            &engine_pkg_dir,
            XMR_HOST_WALLET_CHECKS_PATCH_FILE,
            "PWNDA-PATCH-8",
        );
    if !patched {
        eprintln!(
            "[swap-sidecar] C9: consented but this engine runtime does not carry \
             patches 0005+0008 — not activating XMR wallet sharing this start"
        );
        return None;
    }

    if let Err(e) = crate::xmr_rpc::xmr_start_rpc(
        app.clone(),
        XMR_BOOTSTRAP_DAEMON.to_string(),
        crate::xmr_rpc::XmrLease::SwapEngine,
    )
    .await
    {
        eprintln!(
            "[swap-sidecar] C9: could not start the Monero wallet-rpc for sharing: {}",
            e
        );
        return None;
    }

    let state = app.state::<crate::xmr_rpc::XmrRpcChild>();
    let creds = match state.0.lock() {
        Ok(guard) => guard.creds.clone(),
        Err(_) => None,
    };
    let Some((user, pass)) = creds else {
        eprintln!(
            "[swap-sidecar] C9: wallet-rpc started but no credentials were recorded \
             — not activating XMR wallet sharing this start"
        );
        return None;
    };

    Some(XmrHostWalletParams {
        host: "127.0.0.1".to_string(),
        port: crate::xmr_rpc::XMR_RPC_PORT,
        auth_user: Secret::new(user),
        auth_pass: Secret::new(pass),
        wallet_name: crate::xmr_rpc::XMR_PRIMARY_WALLET_FILENAME.to_string(),
        engine_pkg_dir,
    })
}

// =========================================================================
// C-RZ — ZEPH host wallet-rpc sharing (Grove expansion plan, Phase C)
//
// Same shape as the C9 block immediately above, ported per this unit's own
// brief ("PRODUCE: ... ported from the existing XmrLease pattern in
// xmr_rpc.rs; activation gated on Grove patch markers 13 AND 14 both being
// present"). See [[c9-xmr-lifecycle-design]] and [[wallet-sharing-with-bsx]]
// for why this is the proven pattern to follow rather than reinvent —
// `ZEPHInterface` subclasses `XMRInterface` unchanged (patch 0013's own
// header), so the same `mainwalletrpc*` keys, the same write-once-at-start
// config constraint, and the same "process listening vs. wallet open" split
// all apply verbatim, just on `chainclients.zephyr` instead of
// `chainclients.monero`.
// =========================================================================

/// Relative path of the file carrying `PWNDA-PATCH-13` (the Zephyr coin
/// module) inside the engine package — mirrors [`XMR_SPLIT_PATCH_FILE`].
pub const ZEPH_MODULE_PATCH_FILE: &str = "interface/zephyr/zephyr.py";
/// Relative path of the file carrying `PWNDA-PATCH-14` (Zephyr's
/// registration hunks: `chainparams.py`'s `Coins.ZEPH`, `basicswap.py`'s
/// coin-loop entry, `bin/prepare.py`'s provisioning wiring, `bin/run.py`'s
/// daemon-start, `ui/page_settings.py`'s settings form) that
/// [`apply_host_zph_wallet_to_config`] gates on IN ADDITION to
/// [`ZEPH_MODULE_PATCH_FILE`] — mirrors [`XMR_HOST_WALLET_CHECKS_PATCH_FILE`].
/// `basicswap.py` is the canonical single file checked for the marker (the
/// patch spans five files; a marker check is the cheap smoke test
/// `engine_has_patch`'s own doc comment describes, not full verification —
/// `scripts/swap/verify-zeph-host-wallet.py`, Phase D unit D-Z2, is what
/// proves behaviour).
pub const ZEPH_REGISTRATION_PATCH_FILE: &str = "basicswap.py";

/// C-RZ — point the engine's MAIN Zephyr wallet at the wallet's own
/// `zephyr-wallet-rpc`, so ZEPH swaps run from the user's actual balance.
/// Structurally identical to [`apply_host_xmr_wallet_to_config`] — same four
/// keys, same 2-element-array auth shape, same idempotent no-op-on-no-change
/// return — targeting `chainclients.zephyr` instead of `chainclients.monero`.
///
/// **Gate, per this unit's brief:** markers 13 AND 14 both present, queried
/// through the SAME `engine_has_patch` mechanism [`apply_host_xmr_wallet_to_config`]
/// uses — not a new marker-check invented for this coin. Unlike XMR's own
/// gate (which separately checks 0005 AND 0008 because those are TWO
/// distinct behavioural changes to the same interface), ZEPH's sharing only
/// needs the coin to exist in the engine at all (13) and be registered (14)
/// — `ZEPHInterface` inherits patch 0005/0008's `mainwalletrpc*` handling
/// from `XMRInterface` with no ZEPH-specific override, so there is no third
/// marker analogous to 0008 to check here. (Patches 0005/0008 are
/// themselves numbered earlier in the same cumulative series a runtime
/// carrying 13/14 has necessarily already applied — Grove's
/// `apply-engine-patches.mjs` applies 0001..N in order — so this is a
/// simplification the series' own monotonicity makes safe, not an
/// unchecked assumption.)
///
/// Returns `Ok(false)` when nothing needed changing.
pub fn apply_host_zph_wallet_to_config(
    datadir: &Path,
    engine_pkg: &Path,
    host: &str,
    port: u16,
    auth_user: &str,
    auth_pass: &str,
    wallet_name: &str,
) -> Result<bool, String> {
    if !engine_has_patch(engine_pkg, ZEPH_MODULE_PATCH_FILE, "PWNDA-PATCH-13") {
        return Err(
            "this swap-node runtime does not carry the Zephyr coin-module patch \
             (upstream/patches/0013); the engine has no `zephyr` interface to \
             point at this wallet-rpc at all"
                .to_string(),
        );
    }
    if !engine_has_patch(engine_pkg, ZEPH_REGISTRATION_PATCH_FILE, "PWNDA-PATCH-14") {
        return Err(
            "this swap-node runtime does not carry the Zephyr registration patch \
             (upstream/patches/0014); `zephyr` is not a coin the engine's \
             prepare/run machinery knows about"
                .to_string(),
        );
    }
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(zephyr) = v
        .get_mut("chainclients")
        .and_then(|c| c.get_mut("zephyr"))
        .and_then(|m| m.as_object_mut())
    else {
        return Ok(false);
    };

    let want: Vec<(&str, serde_json::Value)> = vec![
        ("mainwalletrpchost", serde_json::Value::String(host.to_string())),
        ("mainwalletrpcport", serde_json::Value::from(port)),
        // A 2-element JSON ARRAY, not a "user:pass" string — see
        // `XmrHostWalletParams`'s and `apply_host_xmr_wallet_to_config`'s
        // own comments for the incident this shape avoids from the start.
        (
            "mainwalletrpcauth",
            serde_json::Value::Array(vec![
                serde_json::Value::String(auth_user.to_string()),
                serde_json::Value::String(auth_pass.to_string()),
            ]),
        ),
        ("wallet_name", serde_json::Value::String(wallet_name.to_string())),
        // The engine's SWAP-wallet client (`_rpc_wallet_swap`, per-swap
        // wallets) talks to the SAME host process: Zephyr's block carries
        // `manage_wallet_daemon: false` (the engine spawns nothing), so
        // `walletrpcport` must be this process and `walletrpcuser`/
        // `walletrpcpassword` its credentials -- not the placeholder constants
        // prepare's segment ships (2026-09-04). Before this, the swap client
        // pointed at 17768 with `zeph_wallet_user`, where nothing listens.
        ("walletrpchost", serde_json::Value::String(host.to_string())),
        ("walletrpcport", serde_json::Value::from(port)),
        ("walletrpcuser", serde_json::Value::String(auth_user.to_string())),
        ("walletrpcpassword", serde_json::Value::String(auth_pass.to_string())),
    ];
    if want.iter().all(|(k, val)| zephyr.get(*k) == Some(val)) {
        return Ok(false);
    }
    for (k, val) in want {
        zephyr.insert(k.to_string(), val);
    }
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))?;
    Ok(true)
}

/// A real Zephyr remote node already at the HEAD of `zph-nodes-default.ts`'s
/// baked-in pool (`ZPH_DEFAULT_NODES[0]`, operator "zephyrprotocol
/// (official)") — reused here rather than invented, per this unit's own
/// brief ("bootstrap daemon selection = the pool head"), same reasoning as
/// `XMR_BOOTSTRAP_DAEMON` reusing a node the frontend's own code already
/// trusts.
///
/// Only a BOOTSTRAP value: it makes `zephyr-wallet-rpc`'s startup probe
/// (`get_languages`, no wallet, no daemon dependency) succeed so the process
/// is listening in time for the swap engine's own startup probe. It is
/// never used to move funds — the user's own session, whenever the vault
/// unlocks, live-switches this SAME process to the user's actual
/// preferred/pinned node via `setDaemon`'s `set_daemon` RPC
/// (`zph-rpc.ts::setDaemon`, no restart, so it does not touch the lease
/// this function acquires) — the "set_daemon live-switch matching XMR's"
/// this unit's brief also asks for already exists at that layer and needs
/// no Rust-side change: `zph_rpc_call` is a generic JSON-RPC proxy, so
/// `set_daemon` reaches the running process the same way every other
/// wallet-rpc method does.
const ZPH_BOOTSTRAP_DAEMON: &str = "http://remote-node.zephyrprotocol.com:17767";

/// C-RZ — activate Zephyr wallet sharing for this swap-node start, if
/// consent and capability both hold. Mirrors
/// [`maybe_activate_xmr_host_wallet`] exactly, including its NEVER-fail
/// contract: returns `None` on ANYTHING short of full success (no consent,
/// no patched engine, the wallet-rpc process failing to start) and never
/// propagates an error to the caller — ZEPH sharing is additive, and a
/// failure to activate it must degrade to "the engine runs no zephyr main
/// wallet-rpc at all" (ZEPH simply isn't tradeable this session), never to
/// "the swap node — including every OTHER coin — doesn't start".
///
/// Primary-wallet only, for the identical reason
/// [`maybe_activate_xmr_host_wallet`]'s own doc comment gives:
/// `wallet_name` here is always
/// [`crate::zph_rpc::ZPH_PRIMARY_WALLET_FILENAME`], because a per-wallet
/// filename is not knowable at autostart with the vault locked, and
/// `wallet_name` is written once into a config the engine reads once.
async fn maybe_activate_zph_host_wallet(app: &AppHandle) -> Option<ZphHostWalletParams> {
    let rec = read_optin(app);
    // Opt-OUT since 2026-09-04, the same rule the status row already reported
    // (`shares_zph_host_wallet`: enabled and not declined). Until then this
    // read `zph_host_wallet_ack_at.is_some()` while the status row said
    // "sharing" — the two disagreed, and nothing wrote the ack, so ZEPH could
    // never activate. Enabling the coin IS the decision; the disclosure lives
    // in the opt-in wizard and on the Swap tab's card, where the decline is.
    let consented = rec
        .coins
        .get("zephyr")
        .map(|e| shares_zph_host_wallet(rec.opted_in, e))
        .unwrap_or(false);
    if !consented {
        return None;
    }

    let engine_pkg_dir = match engine_package_dir(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[swap-sidecar] C-RZ: engine package not found, skipping: {}", e);
            return None;
        }
    };

    // Pre-check both markers before starting anything — starting the
    // wallet-rpc process (acquiring the SwapEngine lease) only to have
    // `apply_host_zph_wallet_to_config` refuse the config write afterward
    // would leave a process running for nothing, holding a lease nobody
    // ends up using. Same reasoning as `maybe_activate_xmr_host_wallet`.
    let patched = engine_has_patch(&engine_pkg_dir, ZEPH_MODULE_PATCH_FILE, "PWNDA-PATCH-13")
        && engine_has_patch(&engine_pkg_dir, ZEPH_REGISTRATION_PATCH_FILE, "PWNDA-PATCH-14");
    if !patched {
        eprintln!(
            "[swap-sidecar] C-RZ: consented but this engine runtime does not carry \
             patches 0013+0014 — not activating ZEPH wallet sharing this start"
        );
        return None;
    }

    if let Err(e) = crate::zph_rpc::zph_start_rpc(
        app.clone(),
        ZPH_BOOTSTRAP_DAEMON.to_string(),
        Some(crate::zph_rpc::ZphLease::SwapEngine),
    )
    .await
    {
        eprintln!(
            "[swap-sidecar] C-RZ: could not start the Zephyr wallet-rpc for sharing: {}",
            e
        );
        return None;
    }

    let state = app.state::<crate::zph_rpc::ZphRpcChild>();
    let creds = match state.0.lock() {
        Ok(guard) => guard.creds.clone(),
        Err(_) => None,
    };
    let Some((user, pass)) = creds else {
        eprintln!(
            "[swap-sidecar] C-RZ: wallet-rpc started but no credentials were recorded \
             — not activating ZEPH wallet sharing this start"
        );
        return None;
    };

    Some(ZphHostWalletParams {
        host: "127.0.0.1".to_string(),
        port: crate::zph_rpc::ZPH_RPC_PORT,
        auth_user: Secret::new(user),
        auth_pass: Secret::new(pass),
        wallet_name: crate::zph_rpc::ZPH_PRIMARY_WALLET_FILENAME.to_string(),
        engine_pkg_dir,
    })
}

// =========================================================================
// C-RX — ZANO host wallet-rpc sharing (Grove expansion plan, Phase C)
//
// NOT the same shape as the XMR/ZEPH blocks above, and deliberately so —
// see `ZanoHostWalletParams`'s own doc comment and `src-tauri/src/zano_rpc.rs`'s
// top-of-file doc comment ("a SECOND instance, not a lease on the first")
// for the full reasoning: Zano runs TWO processes (Main :18084, host-
// managed, read/confirm only; Scratch :18086, engine-owned, ephemeral)
// rather than one process two owners lease. What IS the same shape as
// XMR/ZEPH: the activation gate (consent + patch markers, best-effort,
// never blocks the swap node), the config-writer's own patch-marker
// refusal, and the placement inside `apply_local_config_policy` (LAST among
// the fund-relevant writes, non-fatal).
// =========================================================================

/// Relative path of the file carrying `PWNDA-PATCH-15` (the Zano coin
/// module) inside the engine package — mirrors [`ZEPH_MODULE_PATCH_FILE`].
/// Also the file `PWNDA-PATCH-17`'s guard hunk (`_confirmMainWalletIdentity`)
/// lands in, per `upstream/patches/0017-cn-follower-host-wallet-guards.patch`
/// — both markers are checked against this SAME path, unlike XMR's 5/8
/// split across two files.
pub const ZANO_MODULE_PATCH_FILE: &str = "interface/zano/zano.py";
/// Relative path of the file carrying `PWNDA-PATCH-16` (Zano's registration
/// hunks: `chainparams.py`'s `Coins.ZANO`, `basicswap.py`'s
/// `createInterface`/`setCoinConnectParams`/`getTotalBalance` branches,
/// `bin/prepare.py`'s provisioning wiring) that
/// [`apply_host_zano_wallet_to_config`] gates on IN ADDITION to
/// [`ZANO_MODULE_PATCH_FILE`] — mirrors [`ZEPH_REGISTRATION_PATCH_FILE`].
pub const ZANO_REGISTRATION_PATCH_FILE: &str = "basicswap.py";

/// C-RX — point the engine's Zano wallet-rpc connections at pwnda's own
/// Main (host-managed) and Scratch (engine-owned) `simplewallet`
/// processes, so ZANO swaps run from the user's actual balance while never
/// letting the engine's destructive `generate_from_keys` primitive touch
/// that wallet — see `ZanoHostWalletParams`'s own doc comment.
///
/// **Gate, per this unit's brief:** markers 15, 16 AND 17 all present,
/// through the SAME [`engine_has_patch`] mechanism [`apply_host_xmr_wallet_to_config`]
/// uses. Three markers (not XMR's two, not ZEPH's two) because Zano's
/// sharing depends on THREE independent behavioural changes: 15 is the coin
/// existing in the engine at all (and carrying the Main/Scratch split
/// itself), 16 is the registration wiring that lets `setCoinConnectParams`'s
/// fixed allowlist actually pass `scratchwalletrpcport`/`walletrpcjwt`/
/// `scratchwalletrpcjwt`/`external_main_wallet` through from raw JSON into
/// `self.coin_clients[coin]` at all (the exact "an allowlist with a missing
/// entry is invisible to a diff of the lines that changed" shape
/// [[c9-xmr-lifecycle-design]]'s Blocker 7 names — already fixed by 16, not
/// re-derived here), and 17 is the wrong-wallet guard on `publishBLockTx`/
/// `withdrawCoin` — without it, sharing Zano's host wallet would be exactly
/// the "activates the mechanism but leaves the fund-safety guard off" shape
/// this codebase's bug log already has one incident of (XMR's Blocker 6).
///
/// Returns `Ok(false)` when nothing needed changing.
pub fn apply_host_zano_wallet_to_config(
    datadir: &Path,
    engine_pkg: &Path,
    host: &str,
    main_port: u16,
    main_jwt: &str,
    scratch_port: u16,
    scratch_jwt: &str,
) -> Result<bool, String> {
    if !engine_has_patch(engine_pkg, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-15") {
        return Err(
            "this swap-node runtime does not carry the Zano coin-module patch \
             (upstream/patches/0015); the engine has no `zano` interface to \
             point at these wallet-rpcs at all"
                .to_string(),
        );
    }
    if !engine_has_patch(engine_pkg, ZANO_REGISTRATION_PATCH_FILE, "PWNDA-PATCH-16") {
        return Err(
            "this swap-node runtime does not carry the Zano registration patch \
             (upstream/patches/0016); `zano` is not a coin the engine's \
             prepare/run machinery knows about, and setCoinConnectParams' fixed \
             allowlist would silently drop scratchwalletrpcport/walletrpcjwt/ \
             scratchwalletrpcjwt/external_main_wallet even if written"
                .to_string(),
        );
    }
    if !engine_has_patch(engine_pkg, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-17") {
        return Err(
            "this swap-node runtime does not carry the host-wallet-guards patch \
             (upstream/patches/0017); publishBLockTx and withdrawCoin would have \
             no guard against sending from a Zano wallet that changed underneath \
             them"
                .to_string(),
        );
    }
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(zano) = v
        .get_mut("chainclients")
        .and_then(|c| c.get_mut("zano"))
        .and_then(|m| m.as_object_mut())
    else {
        return Ok(false);
    };

    let want: Vec<(&str, serde_json::Value)> = vec![
        ("walletrpchost", serde_json::Value::String(host.to_string())),
        ("walletrpcport", serde_json::Value::from(main_port)),
        // A single HS256 secret, not a `(user, pass)` array — Zano's own
        // auth scheme (`zano_rpc::build_jwt`), never HTTP Digest. See
        // `ZanoHostWalletParams`'s own doc comment.
        ("walletrpcjwt", serde_json::Value::String(main_jwt.to_string())),
        ("scratchwalletrpcport", serde_json::Value::from(scratch_port)),
        (
            "scratchwalletrpcjwt",
            serde_json::Value::String(scratch_jwt.to_string()),
        ),
        // `ZanoInterface.initialiseWallet` (PWNDA-PATCH-15 (a)) treats this
        // as the deliberate-Grove-divergence flag: True -> a logged no-op
        // instead of REU26's engine-owned-wallet provisioning path. Written
        // explicitly here (not left to `getConfigSegment`'s own default)
        // for the same reason `apply_host_xmr_wallet_to_config` writes
        // `wallet_name` explicitly rather than trusting prepare's default:
        // `getConfigSegment` only runs on a FIRST prepare, and an existing
        // `basicswap.json` this function is editing may predate it.
        ("external_main_wallet", serde_json::Value::Bool(true)),
    ];
    if want.iter().all(|(k, val)| zano.get(*k) == Some(val)) {
        return Ok(false);
    }
    for (k, val) in want {
        zano.insert(k.to_string(), val);
    }
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))?;
    Ok(true)
}

/// A real Zano remote node already at the HEAD of `zano-nodes-default.ts`'s
/// baked-in pool (`ZANO_DEFAULT_NODES[0]`, operator "Zano project (official
/// dev node)") — reused here rather than invented, same reasoning as
/// `XMR_BOOTSTRAP_DAEMON`/`ZPH_BOOTSTRAP_DAEMON`.
///
/// Only a BOOTSTRAP value for Scratch's `--daemon-address` — it is never
/// used to move funds (Scratch never holds anything but a per-swap joint
/// address for the life of one swap) and Main's own daemon preference is
/// entirely separate, set by the user's own Zano panel.
const ZANO_BOOTSTRAP_DAEMON: &str = "http://37.27.100.59:10500";
/// How long a start waits for the app's Zano Main wallet before parking ZANO.
///
/// Measured 14 s on 2026-09-04 and up to 41 s since, so the bound stays where
/// it was — but it is now only ever charged when a wallet is ACTUALLY starting
/// (see [`ZanoWarmup::NotStarting`]). Before 2026-09-05 it was charged on every
/// cold autostart, where the vault is locked, no wallet-rpc has been spawned,
/// and the wait could not be won: 45 seconds of a 129-second boot, spent to
/// reach the same park it would have reached immediately.
pub const ZANO_MAIN_WARMUP_SECS: u64 = 45;
const ZANO_MAIN_WARMUP_POLL_MS: u64 = 1_500;

/// What a start should do about Zano's Main wallet. Pure, so the rule is
/// testable without an app handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZanoWarmup {
    /// Not consented, or Main is already answering — nothing to wait for.
    Skip,
    /// Consented, Main not up, and no wallet file on disk: the app has no
    /// Zano wallet to open, so waiting would only delay the start. ZANO
    /// parks this session; the DEX-coins row says how to change that.
    NoWallet,
    /// Consented, Main not up, wallet file present — but **this app has not
    /// spawned a wallet-rpc**, so nothing is on its way and waiting cannot
    /// succeed.
    ///
    /// This is the autostart case, and it is the common one: autostart fires
    /// before the user logs in, the Main wallet needs the unlocked vault to
    /// open, so at that moment the wallet is not merely absent but
    /// *unopenable*. The old plan could not tell this apart from "starting"
    /// and waited the full [`ZANO_MAIN_WARMUP_SECS`] every cold boot before
    /// parking anyway. Park immediately instead; the unpark watcher adds ZANO
    /// once the wallet really is up.
    NotStarting,
    /// Consented, Main not up, wallet file present, and a wallet-rpc child
    /// HAS been spawned: it is still opening — wait, bounded.
    Wait,
}

/// `spawned` is "this app has a Zano wallet-rpc child" — `child.is_some()` in
/// `ZanoRpcChild`, which is true the moment the process is launched and long
/// before its port answers. That is exactly the difference between a wallet
/// that is coming and one that is not, and it is why the wait is no longer
/// charged on a boot that cannot win it.
pub fn zano_warmup_plan(
    consented: bool,
    running: bool,
    wallet_present: bool,
    spawned: bool,
) -> ZanoWarmup {
    if !consented || running {
        ZanoWarmup::Skip
    } else if !wallet_present {
        ZanoWarmup::NoWallet
    } else if spawned {
        ZanoWarmup::Wait
    } else {
        ZanoWarmup::NotStarting
    }
}

async fn wait_for_zano_main_wallet(app: &AppHandle) {
    let rec = read_optin(app);
    let consented = rec
        .coins
        .get("zano")
        .map(|e| shares_zano_host_wallet(rec.opted_in, e))
        .unwrap_or(false);
    let running = crate::zano_rpc::zano_rpc_is_running(app.clone())
        .await
        .unwrap_or(false);
    let spawned = crate::zano_rpc::zano_rpc_child_spawned(app).await;
    match zano_warmup_plan(
        consented,
        running,
        crate::zano_rpc::main_wallet_present(app),
        spawned,
    ) {
        ZanoWarmup::Skip => {}
        ZanoWarmup::NotStarting => {
            set_park_reason(
                "zano",
                "the Zano wallet was not open when the swap node started — it is added \
                 automatically once the wallet is running",
            );
            supervisor_log(
                app,
                "C-RX: no Zano wallet-rpc has been started yet (the vault is usually still \
                 locked at autostart) — ZANO parks now rather than waiting for something \
                 that is not coming; the unpark watcher adds it once the wallet is up",
            );
        }
        ZanoWarmup::NoWallet => {
            set_park_reason(
                "zano",
                "no Zano wallet file exists in this app yet — add or import a Zano wallet, \
                 then restart the swap node",
            );
            supervisor_log(
                app,
                "C-RX: no Zano wallet file in this app — ZANO parks this session (add or \
                 import a Zano wallet, then restart the swap node)",
            );
        }
        ZanoWarmup::Wait => {
            supervisor_log(
                app,
                &format!(
                    "C-RX: the app's Zano wallet (Main, :{}) is not up yet — waiting up to \
                     {}s for it before writing the ZANO chainclient block",
                    crate::zano_rpc::ZANO_RPC_PORT,
                    ZANO_MAIN_WARMUP_SECS
                ),
            );
            let started = std::time::Instant::now();
            let deadline = started + std::time::Duration::from_secs(ZANO_MAIN_WARMUP_SECS);
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(ZANO_MAIN_WARMUP_POLL_MS))
                    .await;
                if crate::zano_rpc::zano_rpc_is_running(app.clone())
                    .await
                    .unwrap_or(false)
                {
                    supervisor_log(
                        app,
                        &format!(
                            "C-RX: Main came up after {:.1}s — activating ZANO",
                            started.elapsed().as_secs_f64()
                        ),
                    );
                    clear_park_reason("zano");
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    set_park_reason(
                        "zano",
                        format!(
                            "the Zano wallet was not open within {}s of the start",
                            ZANO_MAIN_WARMUP_SECS
                        ),
                    );
                    supervisor_log(
                        app,
                        &format!(
                            "C-RX: Main did not come up within {}s — ZANO parks this session; \
                             the unpark watcher restarts the node once Main is up and no swap \
                             is in flight",
                            ZANO_MAIN_WARMUP_SECS
                        ),
                    );
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod zano_warmup_tests {
    use super::*;

    /// The 2026-09-04 case: consented, wallet on disk, Main still starting.
    #[test]
    fn a_present_wallet_that_is_not_up_yet_is_waited_for() {
        assert_eq!(zano_warmup_plan(true, false, true, true), ZanoWarmup::Wait);
    }

    #[test]
    fn nothing_to_wait_for_when_main_is_up_or_sharing_is_off() {
        assert_eq!(zano_warmup_plan(true, true, true, true), ZanoWarmup::Skip);
        assert_eq!(zano_warmup_plan(false, false, true, false), ZanoWarmup::Skip);
        assert_eq!(zano_warmup_plan(false, false, false, false), ZanoWarmup::Skip);
    }

    /// No wallet file means no wallet is coming: park immediately rather
    /// than serve a 45 s wait the user would read as "start is slow".
    #[test]
    fn an_absent_wallet_parks_without_waiting() {
        assert_eq!(zano_warmup_plan(true, false, false, true), ZanoWarmup::NoWallet);
    }

    #[test]
    fn the_warmup_covers_the_measured_gap_with_margin() {
        // 14 s measured on 2026-09-04, and 38-41 s observed since. The bound
        // stays generous BECAUSE it is now only charged when a wallet is
        // actually opening — see `a_wallet_that_is_not_starting_does_not_wait`.
        assert!(ZANO_MAIN_WARMUP_SECS >= 30 && ZANO_MAIN_WARMUP_SECS <= 90);
    }

    /// The 2026-09-05 boot fault: a cold autostart waited the full 45 s for a
    /// wallet that could not open (vault locked, nothing spawned), then parked
    /// ZANO anyway — and the unpark watcher restarted the whole node minutes
    /// later, mid-use. Waiting is now conditional on something being on its way.
    #[test]
    fn a_wallet_that_is_not_starting_does_not_wait() {
        // consented, not up, wallet file present, NOTHING spawned -> park now.
        assert_eq!(
            zano_warmup_plan(true, false, true, false),
            ZanoWarmup::NotStarting
        );
        // ...and the same situation WITH a child spawned still waits.
        assert_eq!(zano_warmup_plan(true, false, true, true), ZanoWarmup::Wait);
        // A missing wallet file beats both: nothing to open at all.
        assert_eq!(zano_warmup_plan(true, false, false, true), ZanoWarmup::NoWallet);
        assert_eq!(zano_warmup_plan(true, false, false, false), ZanoWarmup::NoWallet);
    }
}

async fn maybe_activate_zano_host_wallet(app: &AppHandle) -> Option<ZanoHostWalletParams> {
    let rec = read_optin(app);
    // Opt-OUT since 2026-09-04 — see `maybe_activate_zph_host_wallet`.
    let consented = rec
        .coins
        .get("zano")
        .map(|e| shares_zano_host_wallet(rec.opted_in, e))
        .unwrap_or(false);
    if !consented {
        return None;
    }

    let engine_pkg_dir = match engine_package_dir(app) {
        Ok(p) => p,
        Err(e) => {
            set_park_reason("zano", format!("the swap engine package was not found: {e}"));
            supervisor_log(app, &format!("C-RX: engine package not found, skipping: {}", e));
            return None;
        }
    };

    // Pre-check all three markers before touching Scratch at all — starting
    // it (acquiring a real OS process) only to have
    // `apply_host_zano_wallet_to_config` refuse the config write afterward
    // would leave a process running for nothing. Same reasoning as
    // `maybe_activate_xmr_host_wallet`/`maybe_activate_zph_host_wallet`.
    let patched = engine_has_patch(&engine_pkg_dir, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-15")
        && engine_has_patch(&engine_pkg_dir, ZANO_REGISTRATION_PATCH_FILE, "PWNDA-PATCH-16")
        && engine_has_patch(&engine_pkg_dir, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-17");
    if !patched {
        set_park_reason(
            "zano",
            "this swap-engine runtime does not carry patches 0015+0016+0017 — deploy the \
             staged runtime",
        );
        supervisor_log(
            app,
            "C-RX: consented but this engine runtime does not carry patches \
             0015+0016+0017 — not activating ZANO wallet sharing this start",
        );
        return None;
    }

    // LADDER: Main confirmed before Scratch is ever spun up. Read-only —
    // never starts, creates, or re-keys Main.
    let Some(main_jwt) = crate::zano_rpc::main_instance_jwt(app).await else {
        if park_reason("zano").is_none() {
            set_park_reason(
                "zano",
                format!(
                    "the Zano wallet (Main, :{}) was not running when the swap node started",
                    crate::zano_rpc::ZANO_RPC_PORT
                ),
            );
        }
        supervisor_log(
            app,
            &format!(
                "C-RX: consented but the host's Zano wallet-rpc (Main, :{}) is not running — \
                 not activating ZANO wallet sharing this start",
                crate::zano_rpc::ZANO_RPC_PORT
            ),
        );
        return None;
    };

    // Only now — Main confirmed — start the Scratch instance the engine
    // fully owns.
    let scratch = match crate::zano_rpc::zano_scratch_start(app, ZANO_BOOTSTRAP_DAEMON).await {
        Ok(s) => s,
        Err(e) => {
            set_park_reason(
                "zano",
                format!("the swap node's scratch wallet could not start: {e}"),
            );
            supervisor_log(
                app,
                &format!("C-RX: could not start the Zano scratch wallet-rpc: {}", e),
            );
            return None;
        }
    };
    clear_park_reason("zano");

    Some(ZanoHostWalletParams {
        host: "127.0.0.1".to_string(),
        main_port: crate::zano_rpc::ZANO_RPC_PORT,
        main_jwt: Secret::new(main_jwt),
        scratch_port: scratch.port,
        scratch_jwt: Secret::new(scratch.jwt_secret),
        engine_pkg_dir,
    })
}

/// Build the session config from app paths + caller options.
pub fn build_config(
    app: &AppHandle,
    network: Network,
    port_offset: u16,
    xmr_rpc_host: Option<String>,
    xmr_rpc_port: Option<u16>,
    xmr_host_wallet: Option<XmrHostWalletParams>,
    zph_host_wallet: Option<ZphHostWalletParams>,
    zano_host_wallet: Option<ZanoHostWalletParams>,
    particl_mnemonic: Option<Secret>,
    wallet_encryption_pwd: Option<Secret>,
) -> Result<SidecarConfig, String> {
    let rec = read_optin(app);
    let enabled = enabled_coins(&rec);
    let enabled_refs: Vec<&str> = enabled.iter().map(|c| c.as_str()).collect();
    Ok(SidecarConfig {
        python: python_exe(app)?,
        wallet_encrypted: rec.wallet_encrypted,
        archival_chain: rec.archival_chain,
        adoption_coins: adoption_coins(&rec),
        // Only the electrum-capable coins can be lean, so the record is
        // consulted for those and ignored for the rest. A record that somehow
        // says `dogecoin: lean` (hand-edited, or written by an older build)
        // therefore cannot reach argv — `lean_mode_flags` filters again on the
        // same table, and its test drives exactly that case.
        lean_coins: ELECTRUM_CAPABLE
            .iter()
            .filter(|(coin, _)| {
                rec.coins
                    .get(*coin)
                    .map(|e| e.mode == CoinMode::Lean)
                    // Absent entry = never chosen = the default, which is Lean.
                    .unwrap_or(true)
            })
            .map(|(coin, _)| (*coin).to_string())
            .collect(),
        datadir: datadir(app)?,
        bin_dir: bin_dir(app)?,
        network,
        // Every coin the wallet holds a key for that upstream can settle, plus
        // mandatory particl — see WALLET_SIDECAR_COINS — MINUS any whose daemon
        // binary is not seeded. Only meaningful on a FIRST prepare; an existing
        // install is widened by `reconcile_coin_set` through `--addcoin`,
        // because `--withcoins` is inert from run #2.
        // C3: the user's enabled set, not the whole constant. A legacy
        // (empty-map) record still yields every coin, so this is a no-op for
        // an install that predates per-coin enablement.
        coins: seedable_coins(&bin_dir(app)?, &enabled_refs),
        enabled_coins: enabled.clone(),
        client_auth_password: read_or_create_auth_password(app)?,
        html_base_port: DEFAULT_HTML_PORT,
        ws_base_port: DEFAULT_WS_PORT,
        port_offset,
        trust_remote_node: xmr_rpc_host.is_some(),
        xmr_rpc_host,
        xmr_rpc_port,
        xmr_host_wallet,
        zph_host_wallet,
        zano_host_wallet,
        particl_mnemonic,
        wallet_encryption_pwd,
    })
}

// =========================================================================
// Stale-instance reconcile (next-launch half of orphan-and-reconcile)
// =========================================================================

/// Staged cleanup of an instance a previous session left behind, mirroring
/// `xmr_rpc::xmr_start_rpc`'s four tiers (xmr_rpc.rs:715-827):
///
/// 1. graceful, authenticated shutdown of whatever answers the UI port;
/// 2. bounded wait for the port to free;
/// 3. chain daemons via their own RPCs;
/// 4. image-filtered kill of the recorded parent PID.
///
/// This is the other half of the app-exit rule: `ExitRequested` orphans, this
/// reconciles. Returns a human-readable note, never an error — a failed
/// reconcile must not block a launch.
///
/// The orphan's port is **discovered**, not assumed: the previous session may
/// have landed on any candidate offset, and reconciling against
/// `DEFAULT_HTML_PORT` alone would silently skip the graceful tier for an
/// orphan on 12800 and go straight to killing it.
pub async fn reconcile_stale_instance(app: &AppHandle) -> String {
    let Ok(pid_path) = pidfile(app) else {
        return "no pidfile path".to_string();
    };
    let recorded_pid = crate::wallet_rpc_common::read_pidfile(&pid_path);

    // The port recorded in `basicswap.json` is probed FIRST: it is the only
    // port `run.py` can bind (basicswap.py:1540/1550), so an orphan is on it
    // unless the config changed under us. Falling straight to the offset scan
    // would still find it, but only if it happens to sit on a candidate — a
    // hand-edited htmlport would be missed and the orphan left running.
    let configured_html = datadir(app)
        .ok()
        .and_then(|d| configured_ports_in(&d))
        .map(|(h, _)| h);
    let mut html_port = configured_html.unwrap_or(DEFAULT_HTML_PORT);
    let mut port_busy = false;
    let probe_order: Vec<u16> = configured_html
        .into_iter()
        .chain(candidate_offsets().into_iter().map(|o| DEFAULT_HTML_PORT + o))
        .collect();
    for p in probe_order {
        if crate::wallet_rpc_common::port_is_bound(p).await {
            html_port = p;
            port_busy = true;
            break;
        }
    }
    if !port_busy && recorded_pid.is_none() {
        return "nothing to reconcile".to_string();
    }

    // W-6: ownership gate. A bound port is only OUR orphan if the process
    // holding it is our python parent. Without this check, ANY unrelated
    // service on 12700..=13400 (a dev server, someone else's tool) would be
    // handed a `stop` RPC and then an image-filtered kill. Confirm via the OS
    // before touching it: the listener must be a `python*` image, and — when we
    // still have a recorded pid — that exact pid. No match ⇒ leave it alone.
    // W-6 (refined after the adversarial audit): only tier (d) — terminate by
    // PID — can harm an UNRELATED process. Tier (a) graceful-HTTP and tier (c)
    // daemon-RPC target OUR config (our password, our daemon list) and are
    // harmless against a stranger on the port. The first cut of this gate
    // skipped the WHOLE ladder when the owner could not be attributed, which
    // leaked OUR OWN orphan whenever `find_pid_holding_port` disagreed with the
    // bind probe (a non-loopback htmlhost, a transient netstat miss). So gate
    // ONLY the PID-terminate tier, and only on a POSITIVE foreign match.
    let mut terminate_pid = recorded_pid;
    if port_busy {
        if let Some(p) = crate::platform::find_pid_holding_port(html_port).await {
            let img = crate::platform::pid_image_name(p)
                .await
                .unwrap_or_default()
                .to_ascii_lowercase();
            // EXACT image (not `starts_with`: pythonw/python3 are not our node)
            // and, when we recorded a pid, that exact pid.
            let node_image = format!("python{}", crate::platform::EXE_SUFFIX);
            let is_our_node = img == node_image && recorded_pid.map_or(true, |r| r == p);
            if !is_our_node {
                // A stranger holds the port: never PID-kill it. The graceful
                // and daemon-RPC tiers still run and cannot harm it.
                terminate_pid = None;
            }
        }
        // `find_pid_holding_port` == None: the port is bound but netstat could
        // not attribute it. Keep `recorded_pid` — tier (d) is self-protecting
        // via its exact IMAGENAME filter, so it still cannot kill a stranger.
    }

    let password = match read_or_create_auth_password(app) {
        Ok(p) => p,
        Err(e) => return format!("no stored credentials, cannot reconcile gracefully: {}", e),
    };
    let dd = match datadir(app) {
        Ok(d) => d,
        Err(e) => return format!("no datadir: {}", e),
    };

    let outcome = stop_node_core(
        html_port,
        &password,
        terminate_pid,
        dd,
        LadderConfig {
            // Reconcile at launch must not stall the app for two minutes; the
            // orphan is already running safely, so a short attempt then a
            // forced tier is the right trade here.
            max_wait_ms: 15_000,
            poll_ms: 500, finalised_grace_ms: LADDER_FINALISED_GRACE_MS,
        },
    )
    .await;
    crate::wallet_rpc_common::delete_pidfile(&pid_path);
    format!(
        "reconciled: clean={} steps={:?} daemons_stopped={} notes={:?}",
        outcome.clean, outcome.steps, outcome.daemons_stopped, outcome.notes
    )
}

// =========================================================================
// App-launch hook
// =========================================================================

/// `setup()` integration: start the node in the background when the user (or a
/// dev run) has asked for it.
///
/// **Detached on purpose, and this is not the same call as the exit path.**
/// A start can take minutes — prepare, a possible `--addcoin` per coin, then a
/// [`READY_BUDGET_MS`] health poll — so blocking `setup()` on it would hold the
/// window closed. Nothing is orphaned by returning early either: the phase
/// machine and the pidfile are written by the sink as the start progresses, so
/// a close mid-start finds a live pid and runs the ladder over it.
///
/// Silent when autostart is off, which is the default. Errors are logged, never
/// surfaced as a modal — a wallet whose swap node failed to come up is still a
/// wallet, and the Settings card shows the failed phase with its reason.
/// How long autostart will wait for the app to become READY before starting
/// the swap node without waiting.
///
/// Five minutes: long enough for a user to type a vault password, short enough
/// that a wallet left sitting on the login screen still ends up with a running
/// node (its Particl chain has syncing to do either way).
pub const AUTOSTART_READY_BUDGET: std::time::Duration = std::time::Duration::from_secs(300);

/// How often the readiness gate re-checks. Cheap — three local port probes.
const AUTOSTART_READY_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// What autostart is still waiting for, or `None` when nothing is missing.
///
/// # Why the node must not start before this
///
/// A coin whose wallet lives in THIS app — Monero, Zephyr and Zano share a
/// wallet-rpc with the engine rather than letting it build its own — can only
/// be written into `basicswap.json` if its wallet-rpc is answering when the
/// config is written. That happens once, at start. Miss it and the coin is
/// PARKED for the session (`connection_type: "none"`), and the only way to add
/// it afterwards is to stop and start the whole node.
///
/// Autostart runs at app boot, before any login. The vault is locked, so those
/// wallets cannot be open, so the coins park — every single cold start. The
/// unpark watcher then notices the wallet come up after login and asks for the
/// restart, which is what the operator saw as the node "stopping unprompted"
/// minutes into a session, twice reported.
///
/// So the ordering was simply wrong: the node was being started before the
/// things it needs exist. This gate inverts it — wait for the wallets, then
/// start once, with everything.
///
/// Only coins the user has actually consented to share are waited for; a
/// wallet with no host-wallet coins starts exactly as it did before.
/// Is a host wallet-rpc actually ANSWERING — spawned by this app **and** bound
/// to its port — rather than merely spawned?
///
/// `xmr_rpc_is_running` / `zph_rpc_is_running` report `child.is_some()`, which
/// is true the instant the process is launched and long before it serves a
/// request: monero-wallet-rpc opens and refreshes its wallet for tens of
/// seconds first. The first cut of the autostart gate keyed on that, so it
/// released while the wallet was still opening, and the engine's own
/// host-wallet budget (`HOST_WALLET_STARTUP_TRIES` × `HOST_WALLET_STARTUP_DELAY_SECS`,
/// about 18 s) then had to absorb the difference — the very race the gate
/// exists to remove. Zano already checked its port; Monero and Zephyr now do
/// the same. A bound port is the wallet-rpc's own statement that it is serving.
pub async fn host_wallet_answering(app: &AppHandle, coin: &str) -> bool {
    match coin {
        "monero" => {
            crate::xmr_rpc::xmr_rpc_is_running(app.clone()).await.unwrap_or(false)
                && crate::wallet_rpc_common::port_is_bound(crate::xmr_rpc::XMR_RPC_PORT).await
        }
        "zephyr" => {
            crate::zph_rpc::zph_rpc_is_running(app.clone()).await.unwrap_or(false)
                && crate::wallet_rpc_common::port_is_bound(crate::zph_rpc::ZPH_RPC_PORT).await
        }
        "zano" => crate::zano_rpc::zano_rpc_is_running(app.clone()).await.unwrap_or(false),
        _ => false,
    }
}

pub async fn autostart_not_ready_because(app: &AppHandle) -> Option<String> {
    let rec = read_optin(app);
    let mut waiting: Vec<&str> = Vec::new();

    // NOT the wallet key. The first cut of this gate waited for
    // `wallet_pwd.is_some()` as its "the user has logged in" signal, and that
    // DEADLOCKED the boot (2026-09-05): the app only pushes the key once the
    // node is already running (`useSwapAutoSetup` returns early on
    // `!status.running`), so the gate waited for the key, the key waited for
    // the node, and the node waited for the gate. The operator had to start it
    // by hand, and the log sat on
    // `autostart: waiting for the vault to be unlocked` forever.
    //
    // A host wallet being UP is the better signal anyway, and cannot deadlock:
    // those wallet-rpcs are opened from the unlock path itself
    // (`useVault` → `startZanoSync` and friends), so one answering IS proof the
    // vault was unlocked — with no dependency on the node.

    for (coin, label) in [
        ("monero", "Monero"),
        ("zephyr", "Zephyr"),
        ("zano", "Zano"),
    ] {
        let entry = rec.coins.get(coin);
        let consented = entry
            .map(|e| match coin {
                "monero" => shares_xmr_host_wallet(rec.opted_in, e),
                "zephyr" => shares_zph_host_wallet(rec.opted_in, e),
                _ => shares_zano_host_wallet(rec.opted_in, e),
            })
            .unwrap_or(false);
        if !consented {
            continue;
        }
        // A coin consented but with no wallet in this app is never going to
        // start one; waiting for it would cost the whole budget on every boot.
        if coin == "zano" && !crate::zano_rpc::main_wallet_present(app) {
            continue;
        }
        if !host_wallet_answering(app, coin).await {
            waiting.push(label);
        }
    }

    if waiting.is_empty() {
        None
    } else {
        Some(waiting.join(", "))
    }
}

pub fn on_app_ready(app: &AppHandle) {
    let rec = read_optin(app);
    let env_flag = std::env::var(AUTOSTART_ENV).ok();
    if !should_autostart(rec.opted_in, rec.autostart, env_flag.as_deref()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wait for the app to be READY before starting — see
        // `autostart_not_ready_because`. Starting first and restarting later
        // is what produced "zano parked this session" on every boot and a node
        // that stopped itself mid-session.
        let deadline = std::time::Instant::now() + AUTOSTART_READY_BUDGET;
        let mut said: Option<String> = None;
        loop {
            match autostart_not_ready_because(&app).await {
                None => {
                    if said.is_some() {
                        supervisor_log(&app, "autostart: everything is ready — starting now");
                    }
                    break;
                }
                Some(missing) => {
                    if std::time::Instant::now() >= deadline {
                        supervisor_log(
                            &app,
                            &format!(
                                "autostart: gave up waiting for {} after {}s — starting anyway; \
                                 coins whose wallet is not up will park and be added by the \
                                 unpark watcher later",
                                missing,
                                AUTOSTART_READY_BUDGET.as_secs()
                            ),
                        );
                        break;
                    }
                    // Say it once, and again only when what we are waiting for
                    // changes — a line a second for five minutes is not a log.
                    if said.as_deref() != Some(missing.as_str()) {
                        supervisor_log(
                            &app,
                            &format!(
                                "autostart: waiting for {} before starting the swap node (up to \
                                 {}s) — starting first is what parks a coin for the whole session",
                                missing,
                                AUTOSTART_READY_BUDGET.as_secs()
                            ),
                        );
                        said = Some(missing);
                    }
                    tokio::time::sleep(AUTOSTART_READY_POLL).await;
                }
            }
        }
        supervisor_log(&app, "autostart: starting the swap node");
        let state = app.state::<SwapSidecarState>();
        match swap_sidecar_start(app.clone(), state, None, None, None, None, None).await {
            Ok(s) => supervisor_log(
                &app,
                &format!(
                    "autostart: {} on port {}",
                    if s.running { "healthy" } else { "not running" },
                    s.html_port
                ),
            ),
            Err(e) => {
                // A fresh datadir cannot be prepared from here: the first
                // prepare needs the BIP85 child phrase, which only the
                // UNLOCKED vault can derive, and autostart runs before any
                // unlock. That is the R3 gate working as designed, not a
                // fault — but it must not read as an opaque failure, because
                // the symptom a user sees is "the swap UI never comes up" with
                // nothing in the app explaining why.
                if e.contains("vault must be unlocked") {
                    eprintln!(
                        "[swap-sidecar] autostart skipped: this install has no swap                          node yet, and creating one needs the unlocked vault. Open                          Settings -> swap setup once; autostart works from then on."
                    );
                } else {
                    supervisor_log(&app, &format!("autostart failed: {}", e));
                }
            }
        }
    });
}

// =========================================================================
// App-exit hook
// =========================================================================

/// `RunEvent::ExitRequested` integration.
///
/// **Adds nothing to `lib.rs`'s existing `block_on`.** It spawns the ladder on
/// a detached task with a ≤[`EXIT_LADDER_BUDGET_MS`] budget and returns at
/// once; the graceful request usually completes inside the ~100 ms the miner
/// stops already take. Anything unfinished is safe: the daemons keep running,
/// and [`reconcile_stale_instance`] stops them gracefully on the next launch.
/// W-5: whether the app-exit ladder should fire. A live child (`pid.is_some()`)
/// must be torn down whatever the phase — including `Failed`, which a health
/// timeout produces WITH the child still running. Gating on `is_running()`
/// alone (which excludes `Failed`) is the bug this predicate exists to prevent.
fn should_run_exit_ladder(running: bool, pid: Option<u32>) -> bool {
    running || pid.is_some()
}

pub fn on_exit_requested(app: &AppHandle) {
    let state = app.state::<SwapSidecarState>();
    let (running, port, password, pid) = {
        let Ok(guard) = state.0.lock() else {
            return;
        };
        (
            guard.phase.is_running(),
            guard.html_port,
            guard.auth_password.clone(),
            guard.pid,
        )
    };
    // W-5: gate on the pure predicate below so the fix is unit-testable.
    if !should_run_exit_ladder(running, pid) {
        return;
    }
    let Some(password) = password else {
        return;
    };
    let datadir = match datadir(app) {
        Ok(d) => d,
        Err(_) => return,
    };

    // BLOCKING, bounded — see EXIT_LADDER_BUDGET_MS for why this is not a
    // detached spawn any more. `lib.rs` already `block_on`s in this same
    // handler for the miner stops, so the pattern is not new here; what is new
    // is that the swap tree is no longer allowed to outlive the window.
    //
    // Reached only when `should_run_exit_ladder` said there is something to
    // stop, so a wallet with no swap node closes exactly as fast as before.
    let outcome = tauri::async_runtime::block_on(async move {
        tokio::time::timeout(
            std::time::Duration::from_millis(EXIT_LADDER_BUDGET_MS),
            stop_node_core(
                port,
                &password,
                pid,
                datadir,
                LadderConfig {
                    // NOT the whole budget: the rest of it belongs to steps
                    // (c) and (d), which are what actually stop the tree on
                    // Windows. See EXIT_PARENT_WAIT_MS.
                    max_wait_ms: EXIT_PARENT_WAIT_MS,
                    poll_ms: 200, finalised_grace_ms: LADDER_FINALISED_GRACE_MS,
                },
            ),
        )
        .await
    });
    match outcome {
        Ok(o) => {
            supervisor_log(
                app,
                &format!(
                    "exit ladder: clean={} steps={:?} daemons_stopped={} notes={:?}",
                    o.clean, o.steps, o.daemons_stopped, o.notes
                ),
            );
            // Only drop the pidfile when the tree is actually down. Deleting it
            // after a timeout would throw away the one thing the next launch's
            // reconcile needs for its terminate tier, and leave an orphan that
            // only a port scan could find.
            if let Ok(path) = pidfile(app) {
                crate::wallet_rpc_common::delete_pidfile(&path);
            }
        }
        // Timing out is not a failure to act — the graceful request and the
        // daemon stops have already been issued by then. Keep the pidfile so
        // the next launch's reconcile can finish the job.
        Err(_) => supervisor_log(
            app,
            &format!(
                "exit ladder hit its {} ms budget — pidfile kept; the next launch will \
                 reconcile whatever is left",
                EXIT_LADDER_BUDGET_MS
            ),
        ),
    }
}

// =========================================================================
// Orchestration core — the AppHandle-free half of start/stop
// =========================================================================
//
// P3: `swap_sidecar_start` / `swap_sidecar_stop` take `&AppHandle` and
// `tauri::State`, neither of which a plain `cargo test` can construct, so the
// glue between config-gen, spawn, health-poll and the ladder was the one part
// of this module that had never been executed against a live node. The
// sequencing now lives in [`start_node_core`] / [`stop_node_core`], which take
// explicit paths and a [`SessionSink`]; the `#[tauri::command]` wrappers
// resolve paths from the `AppHandle` and delegate. The integration test
// (`swap_sidecar::tests::itest_*`) drives the SAME functions with its own sink,
// so the ordering that ships is the ordering that was exercised.

/// The environment-owning half of a start: phase bookkeeping, progress
/// emission, and custody of the spawned child handle.
///
/// Split out as a trait purely so [`start_node_core`] has no Tauri types in its
/// signature. The production implementor ([`TauriSessionSink`]) does exactly
/// what the inline code used to do, in the same order.
pub trait SessionSink {
    /// Guarded phase write. Must reject the transitions
    /// [`Phase::can_transition_to`] forbids.
    fn set_phase(&self, next: Phase) -> Result<(), String>;
    /// One progress event.
    fn progress(&self, stage: &str, percent: f64, message: &str);
    /// Called immediately after a successful spawn and **before** the health
    /// poll, so a concurrent stop / app-exit can already see the pid.
    fn on_spawned(
        &self,
        child: tokio::process::Child,
        pid: Option<u32>,
        ports: &SessionPorts,
        password: &str,
    ) -> Result<(), String>;
    /// Exit code of the spawned child if it has already exited, else `None`.
    /// `None` also covers "the handle is gone" — a concurrent stop clearing it
    /// must not be reported as an exit.
    fn child_exit_code(&self) -> Option<i32>;
}

/// Upstream's ceiling for `session_timeout_minutes` (basicswap.py:15727:
/// "must be between 1 and 10080 minutes"). Seven days.
pub const CONSOLE_SESSION_TIMEOUT_MINUTES: u64 = 10080;

/// Pure half of [`ensure_console_session_timeout`]: returns the rewritten
/// config and whether anything changed. Raises the value, never lowers it —
/// a hand-set longer limit (there is none longer than the ceiling, but the
/// rule costs nothing) is the operator's.
pub fn ensure_session_timeout_in_config(config_json: &str) -> Result<(String, bool), String> {
    let mut v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not valid JSON: {}", e))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "basicswap.json is not a JSON object".to_string())?;
    let current = obj
        .get("session_timeout_minutes")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    if current >= CONSOLE_SESSION_TIMEOUT_MINUTES {
        return Ok((config_json.to_string(), false));
    }
    obj.insert(
        "session_timeout_minutes".to_string(),
        serde_json::Value::from(CONSOLE_SESSION_TIMEOUT_MINUTES),
    );
    let out = serde_json::to_string_pretty(&v)
        .map_err(|e| format!("serialize basicswap.json: {}", e))?;
    Ok((out, true))
}

/// Write [`ensure_session_timeout_in_config`]'s result back. `Ok(false)` when
/// the file already carried the ceiling.
pub fn ensure_console_session_timeout(datadir: &Path) -> Result<bool, String> {
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let text = strip_bom(&raw)?;
    let (out, changed) = ensure_session_timeout_in_config(text)?;
    if changed {
        std::fs::write(&path, out).map_err(|e| format!("write {}: {}", path.display(), e))?;
    }
    Ok(changed)
}

/// The engine's retry budget for the Particl daemon, written into the
/// `particl` chainclient block.
///
/// Upstream's default is `startup_tries = 15` at `startup_delay = 5`, and the
/// wait grows per try — `tries(1+tries)/2 × delay` — so a daemon that never
/// answers costs **ten minutes** before the engine exits. That is sized for a
/// daemon loading a large chain. Here the supervisor already abandons a start
/// at [`READY_BUDGET_MS`] (three minutes), so the other seven minutes only ever
/// bought a python process that outlived its supervisor, holding the UI port
/// and the pidfile the next start needed. Observed 2026-09-05 19:16–19:27 UTC:
/// particld exited ten seconds in on a broken txindex, the engine retried
/// PART RPC fifteen times, and the failed node was still running when the
/// operator tried again.
///
/// 8 tries at 5 s = 8·9/2 × 5 = 180 s: the engine gives up when the
/// supervisor does. Pinned to [`READY_BUDGET_MS`] by
/// `particl_startup_budget_matches_the_supervisors`.
pub const PARTICL_STARTUP_TRIES: u64 = 8;
pub const PARTICL_STARTUP_DELAY_SECS: u64 = 5;

/// Pure half of [`ensure_particl_startup_budget`]: the rewritten config and
/// whether anything changed. A config with no `particl` block is left alone.
pub fn ensure_particl_startup_budget_in_config(
    config_json: &str,
) -> Result<(String, bool), String> {
    let mut v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not valid JSON: {}", e))?;
    let Some(cc) = v
        .get_mut("chainclients")
        .and_then(|c| c.get_mut("particl"))
        .and_then(|p| p.as_object_mut())
    else {
        return Ok((config_json.to_string(), false));
    };
    let want = [
        ("startup_tries", serde_json::Value::from(PARTICL_STARTUP_TRIES)),
        ("startup_delay", serde_json::Value::from(PARTICL_STARTUP_DELAY_SECS)),
    ];
    if want.iter().all(|(k, val)| cc.get(*k) == Some(val)) {
        return Ok((config_json.to_string(), false));
    }
    for (k, val) in want {
        cc.insert(k.to_string(), val);
    }
    let out = serde_json::to_string_pretty(&v)
        .map_err(|e| format!("serialize basicswap.json: {}", e))?;
    Ok((out, true))
}

/// Write the Particl startup budget into `basicswap.json`. Idempotent.
pub fn ensure_particl_startup_budget(datadir: &Path) -> Result<bool, String> {
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let text = strip_bom(&raw)?;
    let (out, changed) = ensure_particl_startup_budget_in_config(text)?;
    if changed {
        std::fs::write(&path, out).map_err(|e| format!("write {}: {}", path.display(), e))?;
    }
    Ok(changed)
}

/// Config-file policy applied after every prepare **and** on the
/// existing-config path: turn off the update ping (DEC-3 / W-10) and close the
/// daemons' P2P listeners (F-1). Both are idempotent and both are
/// **non-fatal** — a privacy preference must not block a start.
///
/// # Dispatch shape, and where ZEPH/ZANO's host-wallet writes join it
///
/// (Grove expansion plan, Phase C: this function's dispatch is unit C-R0's to
/// own; the actual ZEPH/ZANO calls are C-RZ's and C-RX's, added here after
/// this unit lands — same file, disjoint call sites, exactly like C9's own
/// block below joined C8's `apply_coin_enablement_to_config` call without
/// touching it.) Two different dispatch shapes coexist on purpose:
///
/// * [`apply_coin_enablement_to_config`] is **already fully generic** over
///   [`WALLET_SIDECAR_COINS`] — it loops the table and reads
///   `connection_type` out of the config for each coin — so `zephyr`/`zano`
///   joining that table (this unit) is the entire change their `manage_daemon`
///   dispatch needed. Nothing to add here for that half.
/// * The C9-shaped host-wallet write (the `xmr_host_wallet` block below) is
///   **per-coin by construction**, because each coin's wallet-rpc shape
///   differs (XMR: HTTP Digest, `mainwalletrpc*`; ZEPH: HTTP Digest again but
///   a distinct `chainclients.zephyr` block; ZANO: JWT, `walletrpcjwt`/
///   `scratchwalletrpcjwt` — see [`SECRET_ARG_FLAGS`]'s doc comment for why
///   none of the three ever reaches argv). C-RZ/C-RX each add one block here,
///   gated the same way this one is (`if let Some(hw) = &cfg.zph_host_wallet`
///   / `cfg.zano_host_wallet` — new `SidecarConfig` fields those units add,
///   analogous to [`SidecarConfig::xmr_host_wallet`]), non-fatal, and ordered
///   LAST among the fund-relevant writes for the same reason C9's already is.
fn apply_local_config_policy(cfg: &SidecarConfig) {
    let datadir = cfg.datadir.as_path();
    // C3 (D9). FIRST, so the XMR pin below can overrule it: a pinned remote
    // Monero node must end at `manage_daemon: false` whatever the enable
    // toggle says, or the engine tries to launch a monerod it has no binary
    // for. Non-fatal like its neighbours.
    match apply_coin_enablement_to_config(datadir, &cfg.enabled_coins) {
        Ok(true) => eprintln!(
            "[swap-sidecar] coin enablement written to basicswap.json: {:?}",
            cfg.enabled_coins
        ),
        Ok(false) => {}
        Err(e) => eprintln!("[swap-sidecar] could not write coin enablement: {}", e),
    }
    if let Err(e) = disable_update_ping(datadir) {
        eprintln!("[swap-sidecar] could not disable update ping: {}", e);
    }
    // The console signed the operator out in the middle of a swap
    // (2026-09-05): upstream's session idles out after
    // `SESSION_DURATION_MINUTES = 15` (http_server.py:84) unless
    // `session_timeout_minutes` says otherwise. This wallet logs the console
    // in itself, on a loopback port only this machine can reach, so an idle
    // limit protects nothing here and costs a maker their AMM screen. Set to
    // upstream's own maximum (10080 = 7 days; basicswap.py:15727 rejects
    // more). Non-fatal like its neighbours.
    match ensure_console_session_timeout(datadir) {
        Ok(true) => eprintln!(
            "[swap-sidecar] console session timeout set to {} minutes",
            CONSOLE_SESSION_TIMEOUT_MINUTES
        ),
        Ok(false) => {}
        Err(e) => eprintln!("[swap-sidecar] could not set the console session timeout: {}", e),
    }
    // The engine must give up on a dead Particl daemon when the supervisor
    // does, not seven minutes later — see `PARTICL_STARTUP_TRIES`.
    match ensure_particl_startup_budget(datadir) {
        Ok(true) => eprintln!(
            "[swap-sidecar] particl startup budget capped at {} tries × {} s",
            PARTICL_STARTUP_TRIES, PARTICL_STARTUP_DELAY_SECS
        ),
        Ok(false) => {}
        Err(e) => eprintln!("[swap-sidecar] could not cap the particl startup budget: {}", e),
    }
    if let Err(e) = harden_daemon_confs(datadir) {
        eprintln!("[swap-sidecar] could not harden daemon confs: {}", e);
    }
    // Option A: Particl carries SMSG and the swap keys, never a swap leg, so
    // the two indexes upstream writes buy us nothing and cost the ability to
    // prune. Measured on a synced probe: 2.9 GB -> 1.15 GB. Refuses itself on
    // a datadir that already synced WITH the indexes, because that conversion
    // needs a reindex or a fresh datadir and is not a config writer's call.
    match apply_particl_prune_policy(datadir) {
        Ok(true) => eprintln!(
            "[swap-sidecar] particl set to prune={} MiB (no txindex/spentindex — \
             PART is transport here, never a swap leg)",
            PARTICL_PRUNE_MIB
        ),
        Ok(false) => {
            // A3: say WHY when the answer is "this install keeps its old
            // footprint". Declining silently is how a user ends up reading
            // "about 1.5 GB" in the wizard while ~2.9 GB sits on disk.
            if particl_chain_mode(&datadir.join(MANDATORY_COIN))
                == ParticlChainMode::IndexedChainPresent
            {
                eprintln!(
                    "[swap-sidecar] particl keeps its full-index chain (~2.9 GB): this datadir \
                     was synced with txindex/spentindex, and particl-core cannot drop them in \
                     place. A pruned chain (~{:.1} GB) needs a fresh Particl datadir.",
                    COIN_DISK_GB
                        .iter()
                        .find(|(c, _)| *c == MANDATORY_COIN)
                        .map(|(_, gb)| *gb)
                        .unwrap_or(1.3)
                );
            }
        }
        Err(e) => eprintln!("[swap-sidecar] could not apply the particl prune policy: {}", e),
    }
    // C0.2 / R17. Runs on BOTH paths - after a prepare (where upstream has just
    // baked the env var in, so this is usually a no-op) and on the
    // existing-config path (where it is the ONLY thing that can move the node,
    // because run.py reads the file and never the env). Non-fatal for the same
    // reason as its neighbours: a node preference must not block a start.
    if let (Some(host), Some(port)) = (cfg.xmr_rpc_host.as_deref(), cfg.xmr_rpc_port) {
        match apply_xmr_node_to_config(datadir, host, port) {
            Ok(true) => eprintln!(
                "[swap-sidecar] pinned the swap node's Monero chainclient to {}:{}",
                host, port
            ),
            Ok(false) => {}
            Err(e) => eprintln!("[swap-sidecar] could not pin the Monero node: {}", e),
        }
    }
    // C9. LAST, deliberately: this pins the MAIN WALLET-RPC (whose wallet
    // holds the user's XMR), an entirely different axis from the chainclient
    // pin above (which daemon the engine talks to) — order between the two
    // doesn't matter, but doing the fund-relevant one last means a failure
    // here can never prevent the (unrelated, lower-stakes) node pin from
    // landing. Non-fatal like every other policy write in this function: a
    // failure to activate C9 sharing must degrade to "the engine runs its
    // own Monero wallet, same as before" — never to "the swap node doesn't
    // start". `apply_host_xmr_wallet_to_config` itself refuses on an
    // unpatched engine, so this is additionally a no-op there.
    if let Some(hw) = &cfg.xmr_host_wallet {
        match apply_host_xmr_wallet_to_config(
            datadir,
            &hw.engine_pkg_dir,
            &hw.host,
            hw.port,
            hw.auth_user.expose(),
            hw.auth_pass.expose(),
            &hw.wallet_name,
        ) {
            Ok(true) => eprintln!(
                "[swap-sidecar] C9: pinned the swap node's Monero MAIN wallet to the \
                 user's own wallet-rpc ({}:{})",
                hw.host, hw.port
            ),
            Ok(false) => {}
            Err(e) => eprintln!("[swap-sidecar] C9: could not activate XMR wallet sharing: {}", e),
        }
    }
    // Host-wallet coins: park or run (2026-09-04). BEFORE the two writers
    // below, which fill in the live wallet-rpc credentials on top of this.
    // A zephyr/zano block whose wallet process is not available this session
    // is set to `connection_type: "none"` so the engine skips it; one that is
    // gets `rpc`, the remote bootstrap daemon, and a short startup budget.
    // Without this a default-enabled ZANO whose Main wallet was closed would
    // have the engine retry an unreachable wallet-rpc for ten minutes and
    // then exit the WHOLE node.
    for coin in HOST_MANAGED_DAEMON_COINS {
        let enabled = cfg.enabled_coins.iter().any(|c| c == coin);
        let available = match *coin {
            "zephyr" => cfg.zph_host_wallet.is_some(),
            "zano" => cfg.zano_host_wallet.is_some(),
            _ => false,
        };
        match apply_host_wallet_coin_policy(datadir, coin, enabled && available) {
            Ok(Some(true)) => {
                clear_park_reason(coin);
                eprintln!("[swap-sidecar] {coin}: active this session");
            }
            Ok(Some(false)) => {
                if enabled && park_reason(coin).is_none() {
                    set_park_reason(
                        coin,
                        "its wallet process was not available when the swap node started",
                    );
                }
                eprintln!(
                    "[swap-sidecar] {coin}: parked this session (connection_type none) — {}",
                    if !enabled {
                        "not enabled".to_string()
                    } else {
                        park_reason(coin).unwrap_or_else(|| "no reason recorded".to_string())
                    }
                );
            }
            Ok(None) => {}
            Err(e) => eprintln!("[swap-sidecar] {coin}: could not apply the host-wallet policy: {}", e),
        }
    }
    // C-RZ. Same placement reasoning as C9's block immediately above: LAST
    // among the fund-relevant writes, non-fatal — a failure to activate ZEPH
    // sharing must degrade to "the engine runs no zephyr main wallet-rpc",
    // never to "the swap node doesn't start". `apply_host_zph_wallet_to_config`
    // itself refuses on an unpatched engine, so this is additionally a no-op
    // there.
    if let Some(hw) = &cfg.zph_host_wallet {
        match apply_host_zph_wallet_to_config(
            datadir,
            &hw.engine_pkg_dir,
            &hw.host,
            hw.port,
            hw.auth_user.expose(),
            hw.auth_pass.expose(),
            &hw.wallet_name,
        ) {
            Ok(true) => eprintln!(
                "[swap-sidecar] C-RZ: pinned the swap node's Zephyr MAIN wallet to the \
                 user's own wallet-rpc ({}:{})",
                hw.host, hw.port
            ),
            Ok(false) => {}
            Err(e) => eprintln!("[swap-sidecar] C-RZ: could not activate ZEPH wallet sharing: {}", e),
        }
    }
    // C-RX. Same placement reasoning as the two blocks immediately above:
    // LAST among the fund-relevant writes, non-fatal — a failure to
    // activate ZANO sharing must degrade to "the engine has no zano main
    // wallet-rpc at all", never to "the swap node doesn't start".
    // `apply_host_zano_wallet_to_config` itself refuses on an unpatched
    // engine, so this is additionally a no-op there.
    if let Some(hw) = &cfg.zano_host_wallet {
        match apply_host_zano_wallet_to_config(
            datadir,
            &hw.engine_pkg_dir,
            &hw.host,
            hw.main_port,
            hw.main_jwt.expose(),
            hw.scratch_port,
            hw.scratch_jwt.expose(),
        ) {
            Ok(true) => eprintln!(
                "[swap-sidecar] C-RX: pinned the swap node's Zano wallet-rpcs to \
                 Main {}:{} + Scratch {}:{}",
                hw.host, hw.main_port, hw.host, hw.scratch_port
            ),
            Ok(false) => {}
            Err(e) => eprintln!("[swap-sidecar] C-RX: could not activate ZANO wallet sharing: {}", e),
        }
    }
}

/// `http://host:port` → `(host, port)`, for the `rpchost`/`rpcport` pair a
/// chainclient block takes. The bootstrap daemons are stored as URLs because
/// the wallet-rpc `--daemon-address` argument takes one; the engine's config
/// wants the parts.
pub fn split_daemon_url(url: &str) -> Option<(String, u16)> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    let rest = rest.trim_end_matches('/');
    let (host, port) = rest.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

/// The remote daemon each host-wallet coin's chainclient points at — the same
/// bootstrap node the app's own wallet-rpc uses, so the engine and the wallet
/// see one chain.
pub fn host_wallet_coin_daemon(coin: &str) -> Option<(String, u16)> {
    match coin {
        "zephyr" => split_daemon_url(ZPH_BOOTSTRAP_DAEMON),
        "zano" => split_daemon_url(ZANO_BOOTSTRAP_DAEMON),
        _ => None,
    }
}

/// Startup budget written into a host-wallet coin's block: `startup_tries`
/// × growing `startup_delay` is what upstream's `waitForDaemonRPC` spends
/// before giving up. The default (15 tries, 5 s base) is ten minutes — sized
/// for a local daemon that is still loading its chain. A host wallet-rpc on
/// localhost either answers at once or is not there; three tries at 3 s
/// (≈18 s) is generous.
pub const HOST_WALLET_STARTUP_TRIES: u64 = 3;
pub const HOST_WALLET_STARTUP_DELAY_SECS: u64 = 3;

/// Park or run one host-wallet coin for this session, in `basicswap.json`.
///
/// Returns `Ok(None)` when the coin has no block, `Ok(Some(run))` otherwise —
/// `run` being what the block now says. Pure file editing; the decision
/// (`run`) is the caller's, from "enabled AND the wallet process is
/// available", so this function can be tested without a wallet-rpc.
///
/// Always written, whichever way it goes: `manage_daemon`/
/// `manage_wallet_daemon` false (this app owns both processes), the remote
/// bootstrap daemon as `rpchost`/`rpcport` (prepare's segment names a
/// localhost daemon that Grove never runs), and the short startup budget.
/// `connection_type` is `rpc` to run and `none` to park — upstream's own
/// "present but inactive" spelling, which its `activeCoins()` honours and its
/// prepare knows how to flip back.
pub fn apply_host_wallet_coin_policy(
    datadir: &Path,
    coin: &str,
    run: bool,
) -> Result<Option<bool>, String> {
    let path = datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let text = strip_bom(&raw)?;
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(cc) = v
        .get_mut("chainclients")
        .and_then(|c| c.get_mut(coin))
        .and_then(|m| m.as_object_mut())
    else {
        return Ok(None);
    };
    let mut want: Vec<(&str, serde_json::Value)> = vec![
        ("manage_daemon", serde_json::Value::Bool(false)),
        ("manage_wallet_daemon", serde_json::Value::Bool(false)),
        (
            "connection_type",
            serde_json::Value::String(if run { "rpc" } else { "none" }.to_string()),
        ),
        ("startup_tries", serde_json::Value::from(HOST_WALLET_STARTUP_TRIES)),
        ("startup_delay", serde_json::Value::from(HOST_WALLET_STARTUP_DELAY_SECS)),
    ];
    if let Some((host, port)) = host_wallet_coin_daemon(coin) {
        want.push(("rpchost", serde_json::Value::String(host)));
        want.push(("rpcport", serde_json::Value::from(port)));
    }
    let changed = want.iter().any(|(k, val)| cc.get(*k) != Some(val));
    if changed {
        for (k, val) in want {
            cc.insert(k.to_string(), val);
        }
        let out = serde_json::to_string_pretty(&v)
            .map_err(|e| format!("serialize basicswap.json: {}", e))?;
        std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))?;
    }
    Ok(Some(run))
}

/// Why a prepare run failed. `reason` is the short phase reason; `detail` is
/// the user-facing message, which carries prepare's captured stdout/stderr.
#[derive(Debug, Clone)]
pub struct PrepareError {
    pub reason: String,
    pub detail: String,
}

/// Run upstream's own `basicswap.bin.prepare` and apply the local config
/// policy on top of what it wrote.
///
/// Split out of [`start_node_core`] so the config-generation half can be driven
/// on its own — the live integration test uses it to learn a config's real
/// daemon ports before committing to a port offset.
pub async fn run_prepare_step(cfg: &SidecarConfig) -> Result<(), PrepareError> {
    let prepare_plan = build_prepare_plan(cfg);
    // Captured (W-4): prepare logs only to stdout, so pipe it and surface it
    // on failure rather than tailing a basicswap.log prepare never writes.
    // NOT `.output()` — see `output_after_process_exit` for the deadlock that
    // is, and why the daemon sweep has to happen inside the wait rather than
    // after it.
    let prepare_out = output_after_process_exit(
        command_from_plan_ex(&prepare_plan, true),
        &cfg.datadir,
    )
    .await
    .map_err(|e| PrepareError {
        reason: format!("prepare could not start: {}", e),
        detail: format!("could not run basicswap-prepare: {}", e),
    })?;
    if !prepare_out.status.success() && !cfg.datadir.join("basicswap.json").is_file() {
        let reason = format!(
            "basicswap-prepare exited with {}",
            prepare_out.status.code().unwrap_or(-1)
        );
        let out_tail = tail_bytes(&prepare_out.stdout);
        let err_tail = tail_bytes(&prepare_out.stderr);
        let mut detail = reason.clone();
        if !out_tail.is_empty() {
            detail.push_str(&format!("\n--- prepare stdout ---\n{}", out_tail));
        }
        if !err_tail.is_empty() {
            detail.push_str(&format!("\n--- prepare stderr ---\n{}", err_tail));
        }
        if out_tail.is_empty() && err_tail.is_empty() {
            detail.push_str(&format!("\n{}", log_tail(&cfg.datadir)));
        }
        if let Some(hint) = half_prepared_hint(&cfg.datadir) {
            detail.push_str(&format!("\n\n{}", hint));
        }
        return Err(PrepareError { reason, detail });
    }
    // The sweep that used to live here now runs INSIDE
    // `output_after_process_exit`, before the pipe drain — it has to, or it
    // could never run at all (it was unreachable behind the very await it
    // would have unblocked). A second call here would be a no-op; the ordering
    // requirement it documented is still met, and more strictly: the daemons
    // are stopped before `apply_local_config_policy`'s `harden_daemon_confs`
    // rewrites a conf they have already read, and before the caller's spawn.
    apply_local_config_policy(cfg);
    Ok(())
}

/// True when `<bin_dir>/<coin>/` holds at least one file — the same
/// pre-seeded-binary test `Start-BasicswapDev.ps1` makes before it will let a
/// coin into `--withcoins`.
///
/// It has to be asked, because [`build_prepare_plan`] and
/// [`build_addcoin_plan`] both pass `--nocores`: prepare will **not** fetch a
/// daemon it is missing, it will write the coin into `chainclients` and then
/// fail later trying to start something that isn't there. Checking first turns
/// "the node dies on next launch" into "this coin is not enabled yet".
pub fn coin_binaries_present(bin_dir: &Path, coin: &str) -> bool {
    let dir = bin_dir.join(coin);
    match std::fs::read_dir(&dir) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => false,
    }
}

/// `desired`, minus any coin with no seeded daemon binary. **Both** entry
/// points to a coin list must go through this.
///
/// # The bug this exists to stop happening a second time
///
/// (2026-08-19, found on the operator's first real `tauri dev` mainnet run.)
/// `coin_binaries_present` was applied to the `--addcoin` reconcile path only,
/// on the reasoning that the reconcile is where new coins enter. It is not: a
/// **fresh datadir** takes the other path, where the whole list goes to
/// `--withcoins` on a first prepare. So prepare happily wrote `chainclients`
/// entries and `<coin>.conf` files for dogecoin, dash and bitcoincash — none of
/// which had a binary — and the node then died:
///
/// ```text
/// ERROR : stopDaemon [WinError 2] The system cannot find the file specified
///   File "basicswap/basicswap.py", line 1630, in stopDaemon
///     self.callcoincli(coin, "stop", timeout=10)
/// FileNotFoundError: [WinError 2] The system cannot find the file specified
/// ```
///
/// The UI port never opened, so the failure looked like "localhost unreachable"
/// rather than "three coins have no daemon". Guarding one caller and not the
/// other is the same shape as a precondition copied from a neighbouring
/// operation — it was a fact about the reconcile, not about coin lists.
///
/// `particl` is never filtered: it is the SMSG transport, and a config without
/// it is not a swap node at all. If its binary is missing the start must fail
/// loudly at the runtime check rather than silently produce a transport-less
/// node.
pub fn seedable_coins(bin_dir: &Path, desired: &[&str]) -> Vec<String> {
    desired
        .iter()
        .filter(|c| **c == "particl" || coin_binaries_present(bin_dir, c))
        .map(|c| (*c).to_string())
        .collect()
}

/// What [`reconcile_coin_set`] did, so the caller can log it and the tests can
/// assert it without a filesystem.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CoinReconcile {
    /// Coins successfully added by an `--addcoin` run this session.
    pub added: Vec<String>,
    /// Coins wanted but skipped because no daemon binary is seeded for them.
    pub skipped_no_binary: Vec<String>,
    /// Coins whose `--addcoin` run failed, with the reason.
    pub failed: Vec<(String, String)>,
    /// Coins deferred because the wallets are encrypted and no key is in
    /// memory. Not failures: they stay wanted, and the next KEYED start adds
    /// them. Kept separate so the UI can say "unlock to add bitcoin" instead
    /// of surfacing a 2 KB prepare tail.
    pub deferred_locked: Vec<String>,
}

impl CoinReconcile {
    /// True when nothing was attempted — the common case on every launch after
    /// the coin set has settled.
    pub fn is_noop(&self) -> bool {
        self.added.is_empty()
            && self.skipped_no_binary.is_empty()
            && self.failed.is_empty()
            && self.deferred_locked.is_empty()
    }
}

/// Bring an existing install's coin set up to [`WALLET_SIDECAR_COINS`].
///
/// Runs one `--addcoin` prepare per missing coin, skipping any whose daemon
/// binary is not seeded. **Never fails the start**: a coin that cannot be added
/// leaves the node exactly as capable as it was a moment ago, and refusing to
/// launch over it would take away the pairs that *do* work. The outcome is
/// returned for the log and for the status surface.
///
/// Called on every start, not only after a config change, because the
/// alternative — remembering whether we already tried — is a cache that can
/// disagree with `basicswap.json`. The diff against the config is cheap and
/// cannot drift.
/// Would an `--addcoin` run be DOOMED right now?
///
/// True exactly when the wallets are known encrypted and no key is in memory:
/// prepare must extract the master key from the Particl wallet to initialise
/// the new coin's wallet, and it cannot unlock without
/// `WALLET_ENCRYPTION_PWD`. Everything else — including "we do not know
/// whether the wallets are encrypted" — attempts the run, so the pre-C5
/// unencrypted population keeps working.
pub fn addcoins_are_doomed(wallet_encrypted: bool, has_key: bool) -> bool {
    wallet_encrypted && !has_key
}

/// The one-line failure classification for a keyless addcoin against an
/// encrypted wallet — matched on the phrase upstream's prepare logs
/// (`"Particl Wallet is encrypted"`) right before it gives up. Replaces a
/// 2 KB captured tail with the sentence the user can act on, and stops the
/// rest of the batch: every sibling addcoin fails for the same reason.
pub fn addcoin_failed_for_lock(tail: &str) -> bool {
    tail.contains("Particl Wallet is encrypted")
}

/// The Python that prints a host-wallet coin's `chainclients` block exactly as
/// upstream's own prepare would write it — the coin's Grove-owned
/// `getConfigSegment` (PATCH-13 for zephyr, PATCH-15 for zano) — so this
/// supervisor never carries a second, hand-typed copy of that key set.
/// `should_manage_daemon` is a constant False: Grove never lets prepare manage
/// a ZEPH/ZANO daemon (they are `HOST_MANAGED_DAEMON_COINS`).
pub fn host_wallet_segment_script(coin: &str) -> String {
    format!(
        "import json, sys\n\
         from basicswap.interface.{coin}.core import prepare_module as m\n\
         from basicswap.interface.prepare_util import PrepareContext\n\
         ctx = PrepareContext(data_dir=sys.argv[1], bin_dir=sys.argv[2], \
         port_offset=int(sys.argv[3]), should_manage_daemon=lambda c: False)\n\
         print(json.dumps(m.getConfigSegment(ctx)))\n"
    )
}

/// Insert `segment` as `chainclients.<coin>` when the block is absent. Pure
/// JSON editing; returns whether anything was written. Never overwrites an
/// existing block — an existing block carries the host's live credentials
/// (`apply_local_config_policy` writes those), which a fresh segment's
/// placeholders would clobber.
pub fn insert_chainclient_block(
    config_json: &str,
    coin: &str,
    segment: serde_json::Value,
) -> Result<Option<String>, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(config_json).map_err(|e| format!("parse basicswap.json: {}", e))?;
    let Some(clients) = v.get_mut("chainclients").and_then(|c| c.as_object_mut()) else {
        return Err("basicswap.json has no chainclients object".to_string());
    };
    if clients.contains_key(coin) {
        return Ok(None);
    }
    if !segment.is_object() {
        return Err(format!("{coin}: config segment is not an object"));
    }
    clients.insert(coin.to_string(), segment);
    let out =
        serde_json::to_string_pretty(&v).map_err(|e| format!("serialize basicswap.json: {}", e))?;
    Ok(Some(out))
}

/// Add a host-wallet coin's `chainclients` block WITHOUT prepare, from the
/// engine's own segment (see [`host_wallet_segment_script`]). `Ok(true)` when
/// the block was written, `Ok(false)` when it was already there. Requires the
/// coin's module patch to be present on this runtime — an unpatched engine
/// has no interface to run the block with, and upstream's own prepare would
/// refuse the coin name outright.
pub async fn ensure_host_wallet_coin_block(cfg: &SidecarConfig, coin: &str) -> Result<bool, String> {
    let (module_file, marker) = match coin {
        "zephyr" => (ZEPH_MODULE_PATCH_FILE, "PWNDA-PATCH-13"),
        "zano" => (ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-15"),
        other => return Err(format!("{other} is not a host-wallet coin")),
    };
    let engine_pkg = engine_package_dir_for_python(&cfg.python)?;
    if !engine_has_patch(&engine_pkg, module_file, marker) {
        return Err(format!(
            "this swap-node runtime does not carry {marker} (the {coin} coin module), so the \
             engine has no {coin} interface to configure"
        ));
    }
    let mut cmd = tokio::process::Command::new(&cfg.python);
    cmd.args(ISOLATION_FLAGS)
        .arg("-c")
        .arg(host_wallet_segment_script(coin))
        .arg(cfg.datadir.as_os_str())
        .arg(cfg.bin_dir.as_os_str())
        .arg(cfg.port_offset.to_string())
        .current_dir(&cfg.datadir)
        .stdin(std::process::Stdio::null());
    crate::platform::apply_hidden_spawn(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| format!("{coin}: emitting the config segment timed out"))?
        .map_err(|e| format!("{coin}: could not run the engine's python: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "{coin}: config segment exited {}: {}",
            out.status.code().unwrap_or(-1),
            tail_bytes(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| format!("{coin}: the config segment printed no JSON object"))?;
    let segment: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("{coin}: config segment is not JSON: {}", e))?;

    let path = cfg.datadir.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| format!("read basicswap.json: {}", e))?;
    let cfg_text = strip_bom(&raw)?;
    let Some(rewritten) = insert_chainclient_block(cfg_text, coin, segment)? else {
        return Ok(false);
    };
    // The segment names `datadir/<coin>` for wallet files; upstream's prepare
    // would have created it. A missing directory is a confusing failure three
    // layers away, so make it exist.
    let _ = std::fs::create_dir_all(cfg.datadir.join(coin));
    std::fs::write(&path, rewritten.as_bytes()).map_err(|e| format!("write basicswap.json: {}", e))?;
    eprintln!("[swap-sidecar] {coin}: chainclient block written from the engine's own config segment");
    Ok(true)
}

/// [`engine_package_dir`] without an `AppHandle`: from the runtime's python.
fn engine_package_dir_for_python(python: &Path) -> Result<PathBuf, String> {
    let rt = crate::grove::runtime_root_for(python)
        .ok_or_else(|| "the swap runtime's root could not be derived from its python".to_string())?;
    for rel in ["Lib/site-packages/basicswap", "lib/site-packages/basicswap"] {
        let mut p = rt.clone();
        for part in rel.split('/') {
            p.push(part);
        }
        if p.is_dir() {
            return Ok(p);
        }
    }
    if let Ok(entries) = std::fs::read_dir(rt.join("lib")) {
        for e in entries.flatten() {
            let p = e.path().join("site-packages").join("basicswap");
            if p.is_dir() {
                return Ok(p);
            }
        }
    }
    Err("the swap runtime's basicswap package was not found".to_string())
}

pub async fn reconcile_coin_set(cfg: &SidecarConfig, desired: &[&str]) -> CoinReconcile {
    let mut out = CoinReconcile::default();
    let Some(configured) = configured_coins_in(&cfg.datadir) else {
        // No readable config — a first prepare is what runs, and `--withcoins`
        // is live on that path. Nothing to reconcile.
        return out;
    };
    let missing = missing_coins(&configured, desired);
    if missing.is_empty() {
        return out;
    }

    // Host-wallet coins (zephyr/zano) never go through `--addcoin`
    // (2026-09-04). prepare's `initialise_wallets` insists on reaching the new
    // coin's wallet-rpc and initialising a wallet there — with credentials
    // only this supervisor knows at run time, against a process this app may
    // not even have started yet. Observed on the live node: `--addcoin=zano`
    // retried a JWT the wallet could never accept 15 times with growing
    // backoff (~10 minutes), failed, was never added, and repeated the same
    // ten minutes on the next start — while the UI read "CONFIGURING". Their
    // blocks come from the engine's OWN config segment instead, and the
    // Particl key plays no part, so this runs before the doomed-run gate.
    let (host_wallet, missing): (Vec<String>, Vec<String>) = missing
        .into_iter()
        .partition(|c| HOST_MANAGED_DAEMON_COINS.contains(&c.as_str()));
    for coin in host_wallet {
        match ensure_host_wallet_coin_block(cfg, &coin).await {
            Ok(true) => out.added.push(coin),
            Ok(false) => {}
            Err(e) => out.failed.push((coin, e)),
        }
    }
    if missing.is_empty() {
        if !out.added.is_empty() {
            apply_local_config_policy(cfg);
        }
        return out;
    }

    // The doomed-run gate. Deferring is not a failure: the coins stay wanted,
    // and the next start that carries the key (Settings ▸ Start with the
    // vault unlocked) adds them.
    if addcoins_are_doomed(cfg.wallet_encrypted, cfg.wallet_encryption_pwd.is_some()) {
        out.deferred_locked = missing;
        if !out.added.is_empty() {
            apply_local_config_policy(cfg);
        }
        return out;
    }

    let mut remaining = missing.into_iter();
    while let Some(coin) = remaining.next() {
        if !coin_binaries_present(&cfg.bin_dir, &coin) {
            out.skipped_no_binary.push(coin);
            continue;
        }
        let plan = build_addcoin_plan(cfg, &coin);
        // Same deadlock as `run_prepare_step`: `--addcoin` starts the new
        // coin's daemon and leaves it holding this pipe.
        match output_after_process_exit(command_from_plan_ex(&plan, true), &cfg.datadir).await {
            Ok(o) if o.status.success() => out.added.push(coin),
            Ok(o) => {
                let tail = tail_bytes(&o.stdout);
                // The learned-too-late case: the marker was not set (first
                // keyless boot after C5, or a hand-edited record) and prepare
                // just told us the wallet is encrypted. One clear line, and
                // the REST of the batch is deferred rather than paying the
                // same ~2 minutes to fail identically.
                if cfg.wallet_encryption_pwd.is_none() && addcoin_failed_for_lock(&tail) {
                    out.deferred_locked.push(coin);
                    out.deferred_locked.extend(remaining);
                    break;
                }
                let mut why = format!("prepare exited {}", o.status.code().unwrap_or(-1));
                if !tail.is_empty() {
                    why.push_str(&format!(": {}", tail));
                }
                out.failed.push((coin, why));
            }
            Err(e) => out.failed.push((coin, format!("could not run prepare: {}", e))),
        }
    }

    // `--addcoin` starts daemons to seed the new coin's wallet, and leaves
    // them running for exactly the reason `sweep_prepare_daemons` documents —
    // the CTRL_C_EVENT teardown cannot reach a console-less child. That is
    // true of a FAILED addcoin too, and the first cut swept only on success:
    // a prepare that aborted mid-way (2026-08-20, "Mismatched pid") left its
    // particld running, which then wedged the run.py spawned seconds later.
    // Sweep whenever any prepare ran; re-apply the config policy only when one
    // actually added a coin (that is the only path that rewrote confs).
    if !out.added.is_empty() || !out.failed.is_empty() {
        // ONE sweep after the whole batch, not one per coin. Each `--addcoin`
        // above already released its own pipe via `stop_prepare_daemons`; this
        // is the wait that has to happen before the caller's spawn, and it
        // only has to happen once.
        let swept = stop_prepare_daemons(&cfg.datadir).await;
        if !swept.is_empty() {
            eprintln!(
                "[swap-sidecar] stopped {} daemon(s) left running by --addcoin",
                swept.len()
            );
        }
        wait_for_swept_ports(&expand_swept(&cfg.datadir, &swept)).await;
        if !out.added.is_empty() {
            apply_local_config_policy(cfg);
        }
    }
    out
}

/// How long to wait for a prepare-orphaned daemon's port to come free after its
/// graceful `stop`. particld flushes LevelDB on the way out.
/// 30s was measured too short in production: a particld with a 1.3 GB
/// partly-synced chainstate takes longer than that to flush after accepting
/// `stop`, the sweep gave up, and the next spawn collided with the still-bound
/// port — turning a slow-but-correct shutdown into a failed start. The wait is
/// only ever spent on a daemon that ACCEPTED its stop (see the sweep), so a
/// large ceiling costs nothing in the healthy case.
pub const PREPARE_SWEEP_WAIT_MS: u64 = 120_000;

/// Stop every chain daemon that `basicswap.bin.prepare` left running.
/// Returns how many were stopped.
///
/// # THE FIRST-RUN KILLER (P3, 2026-08-18 — found on the first live run)
///
/// `basicswap.bin.prepare` does not merely write files: for each managed coin
/// it **starts the daemon** to create and seed the wallet
/// (`prepare.py:978 startDaemon` inside `initialise_wallets`), then stops it in
/// a `finally` via `finalise_daemon` (`prepare.py:854`):
///
/// ```python
/// d.handle.send_signal(signal.CTRL_C_EVENT if os.name == "nt" else signal.SIGINT)
/// d.handle.wait(timeout=120)
/// … except Exception as e:
///     logging.info(f"Error stopping {d.name}, process {d.handle.pid}: {e}")
/// ```
///
/// On Windows that cannot work **for us**: `CTRL_C_EVENT` is delivered by
/// `GenerateConsoleCtrlEvent` through the caller's *console*, and this
/// supervisor spawns prepare with `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`
/// ([`command_from_plan`]) — there is no console for the event to travel
/// through. This module already documents that exact mechanism as the reason
/// the shutdown ladder uses HTTP instead of a CTRL_BREAK
/// ([`graceful_shutdown_via_http`]); what nothing accounted for is that
/// **prepare's own teardown depends on the same broken channel**. And because
/// `finalise_daemon` swallows the exception, prepare exits **0** with a live
/// `particld` behind it.
///
/// The consequence is not subtle — it is a guaranteed first-run failure:
///
/// ```text
/// particld debug.log:  Binding RPC on address 127.0.0.1 port 19792 failed.
///                      Unable to bind any endpoint for RPC server
/// basicswap.log:       WARNING : Error, iteration 61: [Errno 2] No such file or
///                        directory: '…\particl\regtest\particl.pid'
///                      ERROR : Unable to read authcookie for PART, …,
///                        datadir pid -1, daemon pid 62632. Error: Mismatched pid
/// supervisor:          the swap node exited with code 0 before becoming ready
/// ```
///
/// Every visible symptom points at the pid-file wait (U-3), which invites
/// raising `BSX_PID_WAIT_ITERS` — a knob that cannot fix a bind failure. The
/// actual cause is one process this supervisor started and never accounted for.
/// Detected by putting the orphan's PID next to its command line
/// (`Get-CimInstance Win32_Process`) after a failing run: six `particld.exe`,
/// one per prepare, each `-datadir=` pointing at *our own* attempt directories.
///
/// The stop is a **graceful RPC**, never a kill — same rule as ladder step (c),
/// and the same helper. A hard kill mid-write is the chainstate-corruption path.
pub async fn sweep_prepare_daemons(datadir: &Path) -> usize {
    let swept = stop_prepare_daemons(datadir).await;
    let n = swept.len();
    // Expand to EVERY loopback port those coins bind — a particld holds a ZMQ
    // publisher as well as its RPC port, and waiting only for the RPC one let
    // the next start collide with the ZMQ socket. See
    // `ports_a_stopped_daemon_holds`.
    wait_for_swept_ports(&expand_swept(datadir, &swept)).await;
    n
}

/// Wait for every swept port to actually free.
///
/// Split out of [`sweep_prepare_daemons`] so a caller running SEVERAL prepares
/// back to back pays this once instead of per run. `--addcoin` takes one coin
/// per invocation (upstream's `add_coin` is a single string), so adding two
/// coins meant two prepares — each starting particld, stopping it, and then
/// blocking on a 1.3 GB chainstate flush before the next could begin. Serial,
/// on every launch, and rendered as "Configuring" the whole time.
/// Every port a stopped daemon might still be holding, given the ports whose
/// RPC we just stopped.
///
/// # The gap this closes
///
/// `parse_chain_daemon_targets` yields RPC ports, so the sweep stopped a
/// daemon, waited for its RPC port, and moved on — while the SAME process was
/// still holding its ZMQ publisher. particld binds both, and the next start
/// then died with `particl zmq port 20792 (held by particld.exe pid 72140)
/// already in use`, costing a failed run.py plus a full retry (~17s and a
/// second start, observed 2026-08-20 13:00).
///
/// `managed_loopback_ports` already enumerated both — it exists for the
/// port-conflict preflight — so the sweep was waiting on a strict subset of
/// the ports it had to. Waiting on a subset of what you must wait for looks
/// exactly like waiting.
pub fn ports_a_stopped_daemon_holds(
    config_json: &str,
    swept: &[(String, u16)],
) -> Vec<(String, u16)> {
    let Ok(all) = managed_loopback_ports(config_json) else {
        return swept.to_vec();
    };
    // Any coin we stopped: take EVERY loopback port that coin binds. Labels
    // are `"<coin> rpc"` / `"<coin> zmq"`, so the coin is the label's head.
    let coins: Vec<String> = swept.iter().map(|(c, _)| c.to_ascii_lowercase()).collect();
    let mut out: Vec<(String, u16)> = swept.to_vec();
    for (label, port) in all {
        let coin = label.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if coins.contains(&coin) && !out.iter().any(|(_, p)| *p == port) {
            out.push((label, port));
        }
    }
    out
}

pub async fn wait_for_swept_ports(swept: &[(String, u16)]) {
    // CONCURRENT, so the cost is the slowest daemon rather than the sum of
    // all of them. Serially, a particld flushing a multi-GB chainstate had to
    // finish before a monero-wallet-rpc that was already gone could even be
    // checked — the waits are independent and there is nothing to order.
    let waits = ports_worth_awaiting(swept).into_iter().map(|(coin, port)| async move {
        let freed =
            crate::wallet_rpc_common::wait_for_port_free(port, PREPARE_SWEEP_WAIT_MS).await;
        if !freed {
            eprintln!(
                "[swap-sidecar] {} port {} still bound {} ms after a graceful stop",
                coin, port, PREPARE_SWEEP_WAIT_MS
            );
        }
    });
    futures_util::future::join_all(waits).await;
}

/// [`ports_a_stopped_daemon_holds`] against the config on disk.
pub fn expand_swept(datadir: &Path, swept: &[(String, u16)]) -> Vec<(String, u16)> {
    std::fs::read(datadir.join("basicswap.json"))
        .ok()
        .and_then(|raw| strip_bom(&raw).ok().map(|s| s.to_string()))
        .map(|c| ports_a_stopped_daemon_holds(&c, swept))
        .unwrap_or_else(|| swept.to_vec())
}

/// Stop every daemon of ours currently holding a configured port, WITHOUT
/// waiting for the ports to free. Returns the `(coin, port)` pairs stopped.
///
/// This is what [`output_after_process_exit`] needs: releasing the inherited
/// stdout handle only requires the process to be told to exit, not to have
/// finished flushing.
pub async fn stop_prepare_daemons(datadir: &Path) -> Vec<(String, u16)> {
    let Ok(raw) = std::fs::read(datadir.join("basicswap.json")) else {
        return Vec::new();
    };
    let Ok(text) = strip_bom(&raw) else {
        return Vec::new();
    };
    let Ok(targets) = parse_chain_daemon_targets(text) else {
        return Vec::new();
    };

    let mut stopped = 0usize;
    // (port, coin) pairs whose daemon ACCEPTED a stop (or was terminated).
    // Only these are worth waiting on below — the first cut waited on every
    // target, so two orphans whose stops FAILED cost 30s each of pure delay
    // per start, all of it rendered as "Configuring".
    let mut swept: Vec<(String, u16)> = Vec::new();
    // Bind-probe every target CONCURRENTLY. Serially this was one round trip
    // per configured coin before any stop could even begin.
    let bound: Vec<bool> = futures_util::future::join_all(
        targets
            .iter()
            .map(|t| crate::wallet_rpc_common::port_is_bound(t.port)),
    )
    .await;
    for (t, is_bound) in targets.iter().zip(bound) {
        if !is_bound {
            continue;
        }
        match stop_daemon_gracefully(t).await {
            Ok(()) => {
                stopped += 1;
                swept.push((t.coin.clone(), t.port));
            }
            Err(e) => {
                eprintln!(
                    "[swap-sidecar] sweep: graceful stop of {} failed: {}",
                    t.coin, e
                );
                // A monero-wallet-rpc that will not stop gracefully cannot be
                // left holding its port. `stop_wallet` is its only shutdown
                // RPC, and when that fails — whether with -13 ("No wallet
                // file": the hard-killed-session orphan) or with a timeout
                // (wedged) — the port never frees and the swap node cannot
                // start AT ALL. Observed 2026-08-20: two consecutive starts
                // died on port 29998, each after paying three 10s stop
                // attempts, because the failure was a timeout rather than
                // the -13 the first version of this gate matched.
                //
                // See `may_terminate_after_failed_stop` for why this is safe
                // for a wallet SERVER and deliberately refused for a chain
                // DATABASE. Image- and port-verified below (W-6): only a
                // process that IS monero-wallet-rpc, and only the one holding
                // OUR port, so a stranger squatting it is never touched.
                if may_terminate_after_failed_stop(&t.kind) {
                    if wallet_rpc_stop_is_walletless(&e) {
                        eprintln!(
                            "[swap-sidecar] sweep: {} has no wallet open, so a \
                             graceful stop can never work here",
                            t.coin
                        );
                    }
                    let Some(pid) =
                        crate::platform::find_pid_holding_port(t.port).await
                    else {
                        continue;
                    };
                    // EXE_SUFFIX, not a literal ".exe": on Unix `pids_for_image`
                    // shells out to `pgrep -x`, whose name must carry NO suffix
                    // (platform.rs:70-74). A hardcoded "monero-wallet-rpc.exe"
                    // matches nothing there, so the kill silently no-ops and the
                    // orphan survives -- U-4/U-5's fault class, ported to Linux
                    // and made invisible by succeeding.
                    match crate::platform::kill_process_by_pid_and_image(
                        pid,
                        &format!("monero-wallet-rpc{}", crate::platform::EXE_SUFFIX),
                    )
                    .await
                    {
                        Ok(_) => {
                            eprintln!(
                                "[swap-sidecar] sweep: terminated walletless                                  monero-wallet-rpc (pid {}) — RPC stop cannot                                  reach a wallet-rpc with no wallet open",
                                pid
                            );
                            stopped += 1;
                            swept.push((t.coin.clone(), t.port));
                        }
                        Err(k) => eprintln!(
                            "[swap-sidecar] sweep: could not terminate                              walletless monero-wallet-rpc: {}",
                            k
                        ),
                    }
                }
            }
        }
    }
    let _ = stopped;
    swept
}

/// The stop failure that identifies a wallet-rpc with no wallet open.
///
/// monero-wallet-rpc's only RPC shutdown is `stop_wallet`, and with no wallet
/// loaded it answers `-13` / "No wallet file" — which simultaneously means the
/// graceful path is a dead end AND that terminating the process cannot corrupt
/// a wallet, because there is none open to corrupt. Matched on both spellings
/// so a transport-layer rewording of one cannot silently disable the
/// escalation.
pub fn wallet_rpc_stop_is_walletless(err: &str) -> bool {
    err.contains("No wallet file") || err.contains("-13")
}

/// May a daemon of this kind be TERMINATED after its graceful stop failed?
///
/// # Why this is per-kind, and why the first version of the gate was wrong
///
/// The first rule escalated only on RPC `-13` ("No wallet file"), reasoning
/// that -13 proves no wallet is open, so a kill cannot corrupt one. True — and
/// not the whole question. It priced the risk of killing and never priced the
/// risk of NOT killing.
///
/// Observed 2026-08-20: a wedged `monero-wallet-rpc` answered `RPC timed out
/// after 10s` rather than -13, so nothing escalated, port 29998 stayed held,
/// and **the swap node could not start at all** — twice, each attempt paying
/// three 10s stop attempts first. An unstoppable process had acquired a veto
/// over the entire subsystem.
///
/// The asymmetry that resolves it is what each kind guards:
///
/// * **`MoneroWalletRpc`** — a wallet SERVER. The swap node's Monero wallet is
///   derived from the BIP85 child of the vault seed, so it is reproducible;
///   BasicSwap re-opens or re-creates it on the next start. Worst case is a
///   regenerable cache file. **Terminate.**
/// * **`BitcoinRpc` / `MoneroDaemon`** — a chain DATABASE. A hard kill
///   mid-write is the chainstate-corruption path this module documents, and
///   recovery is re-syncing millions of blocks. **Graceful only**, even at the
///   cost of a failed start: a failed start is retryable in seconds, a corrupt
///   chainstate is hours.
///
/// Termination stays image- and port-verified at the call site (W-6), so a
/// stranger holding the port is never touched.
pub fn may_terminate_after_failed_stop(kind: &DaemonKind) -> bool {
    match kind {
        DaemonKind::MoneroWalletRpc => true,
        DaemonKind::BitcoinRpc | DaemonKind::MoneroDaemon => false,
    }
}

/// Which swept (coin, port) pairs the sweep should wait on. Identity today —
/// the selection already happened when `swept` was built — but it is the seam
/// the test drives, so "wait on every target" cannot quietly come back.
fn ports_worth_awaiting(swept: &[(String, u16)]) -> Vec<(String, u16)> {
    swept.to_vec()
}

/// Recognise a datadir where a previous prepare died **after** writing a coin
/// conf but **before** writing `basicswap.json`, and say what that means.
///
/// # Why this is a trap and not just an error (P3, 2026-08-18)
///
/// Upstream's prepare refuses to touch a coin whose conf already exists:
///
/// ```text
/// Error: …\swap-sidecar\datadir\particl\particl.conf exists, exiting.
/// ```
///
/// (`prepare.py`'s per-coin `prepareCore`/`writeConfig` guard). Meanwhile
/// `plan_session_ports` decides `run_prepare` purely on whether
/// `basicswap.json` exists. So a first-run setup interrupted between those two
/// writes — a crash, a killed process, an antivirus quarantine — lands in a
/// state that is **permanently** unstartable: every subsequent start still sees
/// no config, still runs prepare, and prepare still refuses. Nothing in the
/// loop ever changes, and the raw message ("exiting.") does not say why or what
/// to do. Observed live: the integration test's second attempt inherited a
/// `particl/particl.conf` from an attempt whose `remove_dir_all` had only
/// partly succeeded, and every retry after it failed identically in 366 ms.
///
/// This does not auto-repair. Deleting a datadir is not a decision a supervisor
/// gets to make silently — it can hold wallets. It names the state and the
/// remedy instead.
fn half_prepared_hint(datadir: &Path) -> Option<String> {
    if datadir.join("basicswap.json").is_file() {
        return None;
    }
    let leftovers: Vec<String> = std::fs::read_dir(datadir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let conf = e.path().join(format!("{}.conf", name));
            conf.is_file().then_some(name)
        })
        .collect();
    if leftovers.is_empty() {
        return None;
    }
    Some(format!(
        "This data directory is half-prepared: {} already has a coin configuration \
         but there is no basicswap.json, and BasicSwap's setup refuses to overwrite an \
         existing coin conf. A start will keep re-running setup and keep hitting this, \
         so it cannot recover on its own. Remove {} (it holds no wallet yet if setup \
         never finished) and run setup again.",
        leftovers.join(", "),
        datadir.display()
    ))
}

/// prepare → spawn → health-poll, with no Tauri types.
///
/// Returns the ports the session actually landed on (prepare can write a
/// different `htmlport` than the one we asked for, and what it wrote wins —
/// see [`plan_session_ports`]).
///
/// `run_prepare` is the caller's decision, not this function's: it depends on
/// whether a config and a credsfile already exist, which only the caller can
/// see.
pub async fn start_node_core<S: SessionSink>(
    sink: &S,
    cfg: &SidecarConfig,
    ports: SessionPorts,
    run_prepare: bool,
    budget_ms: u64,
    poll_ms: u64,
) -> Result<SessionPorts, String> {
    let mut ports = ports;

    // ── Say which engine this is, BEFORE starting it ────────────────
    // The 2026-08-25 fault was not that the runtime was wrong; it was that
    // nothing ever said which runtime it was, so a node missing PWNDA-PATCH-9
    // looked exactly like a current one for three days while the fund-stranding
    // bug it fixes kept happening.
    //
    // This WARNS and proceeds rather than refusing. The stamp is a claim, not
    // evidence (the markers are the evidence — `apply-engine-patches.mjs
    // --check` is the authority), and refusing to start on a metadata mismatch
    // would let a stale stamp strand a working node. Detection is the
    // deliverable; the remedy is the operator's call.
    if let Some(root) = crate::grove::runtime_root_for(&cfg.python) {
        let identity = crate::grove::identify(&root, cfg.python.is_file());
        let line = crate::grove::describe(&identity);
        if identity.is_concerning() {
            eprintln!("[swap_sidecar] WARNING: {line}");
            sink.progress("preparing", 15.0, &line);
        } else {
            eprintln!("[swap_sidecar] {line}");
        }
    }

    // ── Preparing (first-time setup / explicit reconfigure only) ────
    if run_prepare {
        sink.set_phase(Phase::Preparing)?;
        sink.progress("preparing", 20.0, "Writing the node configuration");
        if let Err(e) = run_prepare_step(cfg).await {
            let _ = sink.set_phase(Phase::Failed { reason: e.reason });
            return Err(e.detail);
        }
        // Re-read: what prepare actually wrote beats what we asked for.
        if let Some(written) = configured_ports_in(&cfg.datadir) {
            ports = plan_session_ports(Some(written), None, DEFAULT_HTML_PORT, DEFAULT_WS_PORT)?;
        }
    } else {
        sink.set_phase(Phase::Preparing)?;
        sink.progress(
            "preparing",
            20.0,
            &format!(
                "Using the existing node configuration (UI port {})",
                ports.html_port
            ),
        );
        // DEC-3 / F-1 on upgrade: a config written before these fixes still has
        // the update ping on and the P2P listener open. Idempotent.
        // C0.2: also where an existing install picks up a CHANGED node pin.
        apply_local_config_policy(cfg);
    }

    // ── Coin-set reconcile ──────────────────────────────────────────
    // An install prepared before a coin joined WALLET_SIDECAR_COINS keeps the
    // narrower set forever otherwise: `--withcoins` is inert from run #2
    // (prepare.py:1436-1461), so the widening has to go through `--addcoin`.
    // See [`missing_coins`]. Runs BEFORE the port preflight because each added
    // coin brings its own daemon ports into the config.
    // C3: the DESIRED set is what the user enabled, not the whole constant -
    // otherwise a disabled coin is re-added by `--addcoin` on the very next
    // start and the toggle appears to do nothing.
    let desired: Vec<&str> = cfg.enabled_coins.iter().map(|c| c.as_str()).collect();
    let coin_report = reconcile_coin_set(cfg, &desired).await;
    if !coin_report.is_noop() {
        eprintln!(
            "[swap-sidecar] coin reconcile: added={:?} skipped_no_binary={:?} failed={:?}",
            coin_report.added, coin_report.skipped_no_binary, coin_report.failed
        );
        if !coin_report.deferred_locked.is_empty() {
            eprintln!(
                "[swap-sidecar] deferred (wallets are encrypted, no key this start): {:?} —                  start the node from Settings with the vault unlocked to add them",
                coin_report.deferred_locked
            );
        }
        if !coin_report.added.is_empty() {
            sink.progress(
                "preparing",
                35.0,
                &format!("Enabled {}", coin_report.added.join(", ")),
            );
            // addcoin rewrote the config; re-read rather than trusting the
            // ports we planned from the pre-addcoin file.
            if let Some(written) = configured_ports_in(&cfg.datadir) {
                ports =
                    plan_session_ports(Some(written), None, DEFAULT_HTML_PORT, DEFAULT_WS_PORT)?;
            }
        }
    }

    // ── Daemon-port preflight ───────────────────────────────────────
    // The offset scan only ever probed the UI pair; `--portoffset` shifts the
    // chain daemons' ports too. Probe what the config ACTUALLY asks for before
    // spawning — see [`daemon_port_conflict`] for the 80-second misdiagnosis
    // this replaces.
    if let Some(conflict) = daemon_port_conflict(&cfg.datadir).await {
        sink.set_phase(Phase::Failed {
            reason: "daemon port conflict".to_string(),
        })?;
        return Err(conflict);
    }

    // ── Starting ────────────────────────────────────────────────────
    sink.set_phase(Phase::Starting)?;
    sink.progress("starting", 50.0, "Starting the swap node");
    let run_plan = build_run_plan(cfg);
    // Stamped BEFORE the spawn so a daemon error written after it is ours.
    let spawned_at = chrono::Utc::now();
    let child = command_from_plan(&run_plan).spawn().map_err(|e| {
        let _ = sink.set_phase(Phase::Failed {
            reason: format!("spawn failed: {}", e),
        });
        format!("could not start the swap node: {}", e)
    })?;
    let pid = child.id();
    sink.on_spawned(child, pid, &ports, &cfg.client_auth_password)?;

    // ── Health poll ─────────────────────────────────────────────────
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(poll_ms)).await;

        // Early child death → surface the real reason from the log, exactly
        // like xmr_rpc.rs:948-971 rather than a bare timeout.
        if let Some(code) = sink.child_exit_code() {
            let tail = log_tail(&cfg.datadir);
            sink.set_phase(Phase::Failed {
                reason: format!("node exited with code {}", code),
            })?;
            return Err(format!(
                "the swap node exited with code {} before becoming ready. Last log lines:\n{}",
                code, tail
            ));
        }

        // The chain daemon can die while the engine is still alive and
        // retrying an RPC that will never answer (run.py's own budget is up
        // to ten minutes). Read particld's verdict in its own log and fail in
        // seconds, with the daemon's sentence rather than "health timeout".
        if let Some(fatal) = chain_daemon_fatal(&cfg.datadir, spawned_at) {
            sink.set_phase(Phase::Failed {
                reason: format!("particld exited: {}", fatal.line),
            })?;
            let prefix = if fatal.txindex_rebuildable { PARTICL_TXINDEX_ERR_PREFIX } else { "" };
            return Err(format!(
                "{prefix}the Particl daemon shut itself down before the swap node was ready — {}",
                fatal.line
            ));
        }

        if health_check(ports.html_port, &cfg.client_auth_password)
            .await
            .is_ok()
        {
            // C5 / R6: the unlock is part of becoming healthy, not something
            // that happens after. [`finalize_healthy`] owns that ordering.
            finalize_healthy(sink, unlock_if_configured(cfg, ports.html_port)).await?;
            return Ok(ports);
        }
    }

    let tail = log_tail(&cfg.datadir);
    sink.set_phase(Phase::Failed {
        reason: "health timeout".to_string(),
    })?;
    Err(format!(
        "the swap node did not become ready within {}s. Last log lines:\n{}",
        budget_ms / 1000,
        tail
    ))
}

/// The unlock a session needs, or a no-op when C5 encryption is not configured.
///
/// An `async fn` is LAZY: calling this builds a future and sends no request.
/// [`finalize_healthy`] is what decides when - and whether - it runs.
async fn unlock_if_configured(cfg: &SidecarConfig, port: u16) -> Result<(), String> {
    match &cfg.wallet_encryption_pwd {
        None => Ok(()),
        Some(pwd) => unlock_wallets(port, &cfg.client_auth_password, pwd.expose()).await,
    }
}

/// The tail of a successful start: unlock, **then** declare `Healthy`.
///
/// # R6 - why this is its own function
///
/// Every consumer downstream reads `Healthy` as "this node can sign". A node
/// that came up but whose wallets are still locked answers every later request
/// with a lock error, and each of those looks like a different bug. So a failed
/// unlock ends the session at `Failed`, and `Healthy` is never reached.
///
/// Extracted so the ORDER is unit-testable without spawning a python parent:
/// the caller passes the unlock future, this function awaits it before any
/// phase write. Moving the await below `set_phase(Phase::Healthy)` is exactly
/// the mutation `unlock_failure_prevents_healthy` catches.
pub(crate) async fn finalize_healthy<S: SessionSink, F>(
    sink: &S,
    unlock: F,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    if let Err(e) = unlock.await {
        // `set_phase` can itself fail on an illegal transition; the unlock
        // failure is the interesting one, so its result is what propagates.
        let _ = sink.set_phase(Phase::Failed {
            reason: "wallet unlock failed".to_string(),
        });
        return Err(format!(
            "the swap node started but its wallets could not be unlocked: {}",
            e
        ));
    }
    sink.set_phase(Phase::Healthy)?;
    sink.progress("healthy", 100.0, "Swap node ready");
    Ok(())
}

/// The shutdown ladder against a live node, with no Tauri types.
///
/// **The only place a [`LiveLadder`] is built.** `swap_sidecar_stop`,
/// [`reconcile_stale_instance`] and [`on_exit_requested`] all go through here,
/// so there is exactly one construction site for the parent-image filter.
pub async fn stop_node_core(
    html_port: u16,
    password: &str,
    parent_pid: Option<u32>,
    datadir: PathBuf,
    ladder: LadderConfig,
) -> LadderOutcome {
    let live = LiveLadder {
        html_port,
        password: password.to_string(),
        parent_pid,
        datadir,
        parent_image: format!("python{}", crate::platform::EXE_SUFFIX),
    };
    run_shutdown_ladder(&live, ladder).await
}

// =========================================================================
// Tauri commands
// =========================================================================

/// Current supervisor state. Carries no credential.
#[tauri::command]
pub async fn swap_sidecar_status(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
) -> Result<SidecarStatus, String> {
    let (phase, html_port, ws_port, port_offset) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (
            guard.phase.clone(),
            guard.html_port,
            guard.ws_port,
            guard.port_offset,
        )
    };
    let dd = datadir(&app)?;
    let rec = read_optin(&app);
    let coins = configured_coins_in(&dd).unwrap_or_default();
    let bin = bin_dir(&app)?;
    let coins_unavailable = missing_coins(&coins, WALLET_SIDECAR_COINS)
        .into_iter()
        .filter(|c| !coin_binaries_present(&bin, c))
        .collect();
    let py = python_exe(&app).ok();
    let runtime_installed = py.as_ref().map(|p| p.is_file()).unwrap_or(false);
    let engine = py
        .as_deref()
        .and_then(crate::grove::runtime_root_for)
        .map(|rt| crate::grove::identify(&rt, runtime_installed))
        .unwrap_or(crate::grove::EngineIdentity::NoRuntime);
    Ok(SidecarStatus {
        running: phase.is_running(),
        phase,
        opted_in: rec.opted_in,
        autostart: rec.autostart,
        html_port,
        ws_port,
        port_offset,
        configured: dd.join("basicswap.json").is_file(),
        runtime_installed,
        datadir: dd.to_string_lossy().into_owned(),
        coins,
        coins_unavailable,
        bundle_available: app
            .path()
            .resource_dir()
            .map(|r| crate::bundle::bundle_has(&r, "grove"))
            .unwrap_or(false),
        engine,
        seed_mismatch: {
            let g = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
            g.seed_mismatch.clone()
        },
        swap_seed_fingerprint: rec.swap_seed_fingerprint.clone(),
        particl_unpruned: particl_chain_mode(&dd.join(MANDATORY_COIN))
            == ParticlChainMode::IndexedChainPresent,
    })
}

/// Install the swap engine from the installer's encrypted bundle — the "setup
/// step" the runtime-missing error tells the user to run (binary-bundling-plan
/// T5; Task 0 found no command implemented it).
///
/// Extracts the bundled Grove runtime + the 5 bundled coin daemons (particl,
/// bitcoin, litecoin, bitcoincash, monero) into `<app-data>/swap-sidecar/`, after
/// which `python_exe` exists (`runtime_installed` flips true) and `seedable_coins`
/// sees the five. Offline-reliable: no network. doge/dash are not bundled and are
/// added later on demand by `reconcile_coin_set` when the user enables them.
///
/// Returns whether the runtime is installed after the attempt. Requires opt-in —
/// nothing in this module acts before consent.
#[tauri::command]
pub async fn swap_sidecar_install_bundled(app: AppHandle) -> Result<bool, String> {
    if !read_optin(&app).opted_in {
        return Err(
            "enable the swap sidecar first (accept the setup screen) before installing the engine"
                .to_string(),
        );
    }
    let base = sidecar_base_dir(&app)?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot resolve resource dir: {e}"))?;
    // A missing bundle is a BUILD defect, not a missing feature. `tauri.conf.json`
    // ships `bundle.resources: ["binaries/*"]`, so a correctly-produced installer
    // always carries `grove.enc`; getting here means the installer was assembled
    // without `scripts/bundle-binaries.mjs` having run. Saying "download-on-demand
    // is not yet wired" (the wording until 2026-08-29) pointed the reader at an
    // unbuilt feature instead of at the real cause, and there is nothing the user
    // can do about it in-app. `scripts/check-bundle-payloads.mjs` now fails the
    // build so this message should be unreachable in a released binary.
    if !crate::bundle::bundle_has(&resource_dir, "grove") {
        return Err(
            "this installer was built without its swap-engine bundle (grove.enc is missing \
             from the app's resources) — that is a packaging fault in this build, not a \
             setting you can change. Please report the build version; a correctly packaged \
             installer carries the engine and installs it offline."
                .to_string(),
        );
    }
    crate::bundle::extract_encrypted_bundle(&resource_dir, "grove", &base)?;
    Ok(python_exe(&app).map(|p| p.is_file()).unwrap_or(false))
}

/// Install the engine this build expects, from the payload this build ships.
///
/// # The hole this closes
///
/// `swap_sidecar_install_bundled` runs once, at setup. After that the engine
/// in app-data is frozen: install v0.6.0 (which ships engine p26) -> the tree
/// lands in app-data -> update to v0.6.1 (which ships p27 and *expects* p27)
/// -> the old p26 tree still wins, and every start reports engine drift with
/// nothing the user can do about it from inside the app.
///
/// That is exactly the shape `sidecar_update.rs` was written for on the
/// Monero/Zephyr wallet-rpc binaries -- "install wallet vX -> binary lands in
/// app-data -> upgrade to vY -> the *old* app-data copy still wins" -- and its
/// tier 1 is the same answer: reconcile against the bundled payload, offline,
/// no network, not behind any toggle, because it is not an update. It is
/// finishing the application of an update the user already installed.
///
/// Reported by the operator on 2026-09-05 as "what is the p26 and p27 stuff,
/// stop slowly upgrading" -- which is the right complaint: a version number
/// the user has to reconcile by hand is a defect, not a status line.
///
/// # What it refuses to do
///
/// * **Never while the node is running.** A live engine holds file handles and,
///   more to the point, in-flight swap state. Callers run this from the start
///   path (before anything spawns) or from a stopped card.
/// * **Never when there is no bundle.** A dev tree (`PWNDA_SWAP_SIDECAR_DIR`
///   pointed at `.swap-sidecar-work/runtime`) is hand-staged and is not this
///   function's business -- it returns `Ok(None)` and the drift note keeps
///   telling the operator to run `Swap-EngineRuntime.ps1`.
/// * **Never the datadir.** The grove payload is `runtime/` + `bin/<coin>/`
///   only (`scripts/bundle-binaries.mjs`); wallets, `basicswap.json` and the
///   database live in `datadir/` and are not in the archive.
/// * **Never silently, when it did not work.** If the freshly-extracted tree
///   still does not identify as the expected engine, that is an error with
///   both ids in it, not a shrug.
///
/// Returns `Some(message)` when it actually replaced the engine.
pub async fn reconcile_bundled_engine(
    app: &AppHandle,
    running: bool,
) -> Result<Option<String>, String> {
    if !read_optin(app).opted_in || running {
        return Ok(None);
    }
    let rt = runtime_dir(app)?;
    let installed = python_exe(app).map(|p| p.is_file()).unwrap_or(false);
    let before = crate::grove::identify(&rt, installed);
    // `Ok` needs nothing; `NoRuntime` is first-install, which the setup path
    // already owns. Only a stamped disagreement (or a tree whose level we
    // cannot read) is ours.
    let stamped_before = match &before {
        crate::grove::EngineIdentity::Drift { stamped, .. } => stamped.clone(),
        crate::grove::EngineIdentity::Unstamped => "unstamped".to_string(),
        _ => return Ok(None),
    };

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot resolve resource dir: {e}"))?;
    if !crate::bundle::bundle_has(&resource_dir, "grove") {
        // A dev checkout, or a build assembled without the payload. Either way
        // there is nothing here to install FROM, and guessing is worse than the
        // note the card already shows.
        return Ok(None);
    }

    let base = sidecar_base_dir(app)?;
    supervisor_log(
        app,
        &format!(
            "engine: installed runtime is {}, this build expects {} — reinstalling from the bundle",
            stamped_before,
            crate::grove::expected_id()
        ),
    );
    crate::bundle::extract_encrypted_bundle(&resource_dir, "grove", &base)?;

    let installed_now = python_exe(app).map(|p| p.is_file()).unwrap_or(false);
    match crate::grove::identify(&rt, installed_now) {
        crate::grove::EngineIdentity::Ok { id } => {
            let msg = format!("swap engine updated to {} (was {})", id, stamped_before);
            supervisor_log(app, &format!("engine: {}", msg));
            Ok(Some(msg))
        }
        other => Err(format!(
            "reinstalled the bundled swap engine but it still does not match: this build \
             expects {}, the tree now reports {:?}. The installer's payload and this build \
             disagree — that is a packaging fault, not a setting.",
            crate::grove::expected_id(),
            other
        )),
    }
}

/// Renderer-facing wrapper: the Settings card's "Update swap engine" action.
/// Refuses while the node is running rather than stopping it — deciding to
/// stop a node that may be watching a timelock is the operator's call, and the
/// card asks for it in words.
#[tauri::command]
pub async fn swap_sidecar_update_engine(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
) -> Result<String, String> {
    let running = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.phase.is_running() || guard.phase.blocks_new_start()
    };
    if running {
        return Err(
            "stop the swap node first — replacing the engine under a running node would drop \
             a process that may be watching a swap's timelocks"
                .to_string(),
        );
    }
    // Distinguish the two reasons `reconcile_bundled_engine` does nothing, so
    // the answer is true on BOTH machines: a user's install can be repaired
    // from the bundle it shipped with; a dev checkout is hand-staged and
    // cannot be.
    let rt = runtime_dir(&app)?;
    let installed = python_exe(&app).map(|p| p.is_file()).unwrap_or(false);
    let drifted = matches!(
        crate::grove::identify(&rt, installed),
        crate::grove::EngineIdentity::Drift { .. } | crate::grove::EngineIdentity::Unstamped
    );
    if drifted {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("cannot resolve resource dir: {e}"))?;
        if !crate::bundle::bundle_has(&resource_dir, "grove") {
            return Err(
                "this build ships no engine payload to install from — it is a development \
                 checkout pointed at a hand-staged runtime. Deploy the staged tree with \
                 scripts/swap/Swap-EngineRuntime.ps1, then start the node."
                    .to_string(),
            );
        }
    }
    match reconcile_bundled_engine(&app, false).await? {
        Some(msg) => Ok(msg),
        None => Ok("the swap engine is already the one this build expects".to_string()),
    }
}

/// Record (or revoke) the user's opt-in. Nothing else in this module runs
/// before this says yes.
#[tauri::command]
///
/// `archival`: `Some(true)` keeps the full chain and its indexes; `None` leaves
/// the stored choice alone, so a re-consent from a caller that does not know
/// about this cannot silently reset it.
pub async fn swap_sidecar_opt_in(
    app: AppHandle,
    accepted: bool,
    archival: Option<bool>,
) -> Result<OptInRecord, String> {
    let at = chrono::Utc::now().to_rfc3339();
    let prev = read_optin(&app);
    let rec = OptInRecord {
        opted_in: accepted,
        at: Some(at.clone()),
        // Learned fact, not a preference: whether the wallets are encrypted
        // does not change with consent, so a re-consent must not forget it.
        wallet_encrypted: prev.wallet_encrypted,
        // Also a learned fact about the DATADIR, not a preference — it survives
        // a revoke/re-consent because the engine wallet on disk survives one.
        swap_seed_fingerprint: prev.swap_seed_fingerprint.clone(),
        // Preserve the autostart preference across a re-consent. Revoking
        // clears it, because an autostart flag on a revoked record is a
        // loaded gun: re-consenting later would start the node immediately
        // without the user having asked for that.
        autostart: accepted && prev.autostart,
        // A fact about the chain on disk, not a preference, so it survives a
        // revoke/re-consent exactly as `wallet_encrypted` does. Clearing it
        // would silently promise a pruned node over an archival datadir.
        archival_chain: archival.unwrap_or(prev.archival_chain),
        // C3 / P1. Same "cleared on revoke" reasoning as `autostart`: a coin
        // set surviving a revoke would re-enable whatever was chosen the
        // instant the user re-consented, and the safe direction on a fresh
        // consent is the light default.
        coins: if accepted {
            coins_on_consent(
                &read_optin(&app).coins,
                datadir(&app)
                    .map(|d| d.join("basicswap.json").is_file())
                    .unwrap_or(false),
                &at,
            )
        } else {
            Default::default()
        },
    };
    write_optin(&app, &rec)?;
    Ok(rec)
}

#[tauri::command]
pub async fn swap_sidecar_opt_in_status(app: AppHandle) -> Result<OptInRecord, String> {
    Ok(read_optin(&app))
}

/// Turn "start with the wallet" on or off. Refuses before opt-in — there is no
/// coherent meaning to autostarting a subsystem the user has not enabled.
/// Put the swap node's web credential on the clipboard, **without returning it
/// to the webview**.
///
/// # Why not just show it, and why not turn auth off
///
/// Two easier options were rejected on purpose.
///
/// *Returning it* would break the property `status_payload_carries_no_credential`
/// exists to hold: the renderer must not hold a credential that authenticates
/// against `/json/`, because the whole point of `check_endpoint` is that even
/// our own UI cannot reach `withdraw`, `getcoinseed` or `setpassword`. Handing
/// the renderer the password would let a compromised one bypass the allow-list
/// entirely by talking to the node directly.
///
/// *Disabling client auth* (`--disableclientauth`) is worse still. The node
/// binds loopback, but loopback is not a trust boundary on a desktop: any
/// process running as the user could then call
/// `wallets/<coin>/withdraw` and drain the swap wallet — which, after C3.5,
/// holds spending authority over the user's pre-existing coins. That would make
/// an arbitrary local program MORE privileged than this application's own
/// renderer, which is a strange place to end up.
///
/// So the credential stays in Rust and reaches the user through the clipboard,
/// which is the same exposure the on-disk `basicswap-api.creds` already has.
/// Windows-only for now: `clip.exe` receives it on **stdin**, never argv, so it
/// does not appear in any process listing.
/// Open the BasicSwap console in a pwnda-owned window, **already logged in**.
///
/// # Why the credential is kept rather than removed
///
/// Upstream supports running with no password at all: an empty
/// `--client-auth-password` makes prepare DELETE `client_auth_hash`
/// (`prepare.py:1450`), after which `is_authenticated()` returns `True`
/// unconditionally (`http_server.py:326`). That was the obvious way to grant
/// the "no password to worry about" request, and it is the wrong one.
///
/// What auth is and is not defending, read out of upstream rather than assumed:
///
/// * **Browser attacks are not its job.** `is_allowed_host` (DNS-rebinding) and
///   `is_same_origin_request` (CSRF) are enforced independently of
///   `client_auth_hash`, so a malicious web page is blocked either way.
/// * **Same-user local processes are not really its job either.** The password
///   sits in `basicswap-api.creds` in the user's own app-data; malware running
///   as the user reads the file and authenticates. The bar is "read one file".
/// * **Other local user accounts ARE its job, and only its job.** Loopback is
///   reachable by every account on the machine, but NTFS ACLs stop another
///   account reading this user's app-data. Deleting `client_auth_hash` would
///   hand any other account on the box an unauthenticated, fund-moving API on
///   127.0.0.1. That is the case that makes removal a real downgrade, and it is
///   why this command exists instead.
///
/// So: the credential stays, and the user never handles it.
///
/// # How
///
/// Rust performs the JSON login itself and keeps the session cookie, then opens
/// a webview whose init script installs that cookie before the first
/// authenticated navigation. **The password never enters the webview** — only a
/// session id, which is what a browser would have held anyway. The window loads
/// a loopback URL with no pwnda IPC injected (Tauri does not expose IPC to
/// external URLs unless a domain is explicitly allow-listed, and none is), so
/// the console cannot call a `swap_sidecar_*` command.
///
/// The first navigation goes to `/login` deliberately: it is on upstream's
/// `exempt_pages` list, so it renders without a session, which gives the init
/// script somewhere to run. It sets the cookie and redirects to `/offers`,
/// which then carries it. Landing on `/offers` first would just 302 back.
#[tauri::command]
pub async fn swap_sidecar_open_console(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
) -> Result<(), String> {
    if !read_optin(&app).opted_in {
        return Err("the swap node has not been enabled".to_string());
    }
    console_trace(&app, "--- open console requested ---");
    let (phase, port) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (guard.phase.clone(), guard.html_port)
    };
    // Healthy only. `is_running()` admits `Starting`, and a console opened
    // during the 86-second prepare failed its login against a port nothing
    // was listening on yet (2026-09-05: "login FAILED: could not reach the
    // node to log in"). The card disables the button too; this is the floor.
    match phase {
        Phase::Healthy => {}
        Phase::Starting | Phase::Preparing => {
            return Err(
                "the swap node is still starting — the console opens once the dot is green"
                    .to_string(),
            );
        }
        _ => {
            return Err(
                "the swap node is not running — start it from Settings first".to_string(),
            );
        }
    }
    let password = read_or_create_auth_password(&app)?;

    // `Policy::none()` is not a preference: upstream answers the JSON login
    // 200 + Set-Cookie, but a redirect-following client would drop the header
    // on any future change to that response. Same rule as the shutdown ladder.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let cookie = match login_for_session(&client, port, &password).await {
        Ok(c) => {
            // Length only — never the cookie itself. Enough to distinguish
            // "login returned nothing" from "login returned something".
            console_trace(&app, &format!("login OK, cookie {} chars", c.len()));
            c
        }
        Err(e) => {
            console_trace(&app, &format!("login FAILED: {}", e));
            return Err(e);
        }
    };

    // Build the window on a DEDICATED WORKER THREAD — never the main thread.
    //
    // # The bug this exists for (2026-08-22), and the wrong fix before it
    //
    // Tauri's own documentation for `WebviewWindowBuilder::new` is explicit:
    //
    //   "On Windows, this function deadlocks when used in a synchronous
    //    command and event handlers, see the Webview2 issue. You should use
    //    `async` commands and separate threads when creating windows."
    //
    // On 2026-08-21 this code was changed to call `build()` inside
    // `app.run_on_main_thread(...)` on the theory that WebView2 must be
    // created on the UI thread. That is the **opposite** of the documented
    // requirement, and `run_on_main_thread` runs its closure as an event-loop
    // callback — the exact "event handlers" case the warning names. The
    // result was a hard deadlock: `build()` never returned, so the main
    // thread sat inside it forever, the window existed as an unpainted white
    // rectangle, and no window could be closed.
    //
    // The host trace is what proved it, and is why the tracing went in first:
    //
    //   --- open console requested ---
    //   login OK, cookie 64 chars
    //   dispatching window build to the main thread
    //   <nothing — no "window build OK", no FAILED, ever>
    //
    // A build that neither succeeds nor fails has not been *refused*, it has
    // *hung*. That single absent line is the whole diagnosis, and no amount
    // of reasoning about WebView2 threading got there without it.
    //
    // `std::thread::spawn` rather than relying on the async runtime's thread:
    // an `async` Tauri command borrowing `State<'_, _>` does not have a
    // guaranteed off-main-thread execution context, and this deadlock is not
    // worth re-litigating on a runtime-scheduling assumption. An explicit
    // thread is unambiguous. The result returns over a oneshot so a window
    // that fails to build reaches the user as an error rather than silence.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    let cookie_for_main = cookie.clone();
    // The password rides along for the re-login path only. It stays in Rust:
    // the page is only ever handed a cookie (see `console_init_script`'s test
    // `console_init_script_carries_no_password`).
    let password_for_relogin = password.clone();
    console_trace(&app, "dispatching window build to a worker thread");
    std::thread::spawn(move || {
        let _ = tx.send(open_console_window(
            &app_for_main,
            port,
            &cookie_for_main,
            password_for_relogin,
        ));
    });

    let out = rx
        .await
        .map_err(|_| "the console window task did not report back".to_string())?;
    console_trace(&app, &format!("open console finished: {:?}", out));
    out
}

/// The main window's `additionalBrowserArgs`, read from the live config.
///
/// Exists for one reason: **WebView2 refuses to create a second environment
/// with different options in the same user-data folder.** The main window is
/// created from `tauri.conf.json`, whose `additionalBrowserArgs` carry the
/// mining-driven tuning (`--expose-gc` from the heap-leak rounds,
/// `--disable-gpu --disable-gpu-compositing` from the GPU-TDR fix — see
/// [[webview2-memory-management]] Round 14). A runtime-built webview that
/// does not repeat those args EXACTLY gets a controller that silently fails
/// to initialize: window chrome, dead white webview, zero navigation or
/// page-load events, devtools a no-op. tauri-apps/tauri#13092 is this bug,
/// and PwndaWallet reproduced it 2026-08-20 through 2026-08-22.
///
/// Read from `app.config()` rather than duplicated as a literal so the two
/// can never drift — a drift would resurrect the white window with nothing
/// going red at compile time.
fn main_window_additional_browser_args(app: &AppHandle) -> Option<String> {
    let cfg = app.config();
    cfg.app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .or_else(|| cfg.app.windows.first())
        .and_then(|w| w.additional_browser_args.clone())
}

/// Build (or re-focus) the console window. Split out so the command above is
/// only network work and this is only Tauri work.
fn open_console_window(
    app: &AppHandle,
    port: u16,
    cookie: &str,
    password: String,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // How many times this window has landed on `/login`. The first arrival is
    // the entry URL; each later one means the session we installed did not
    // take. Bounded by `CONSOLE_LOGIN_ATTEMPTS`.
    let login_arrivals = Arc::new(std::sync::atomic::AtomicU32::new(0));
    // A re-login in flight must not be joined by a second one from the next
    // page-load event of the same document.
    let relogin_busy = Arc::new(AtomicBool::new(false));

    console_trace(app, "open_console_window: entered (worker thread)");

    // Re-focus rather than stack a second console on every click.
    if let Some(w) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        console_trace(app, "existing console window found — refocusing");
        let _ = w.set_focus();
        return Ok(());
    }

    let url = format!("http://127.0.0.1:{}/login", port)
        .parse()
        .map_err(|e| format!("could not build the console URL: {}", e))?;

    let script = console_init_script(cookie);
    let on_load_script = script.clone();

    let browser_args = main_window_additional_browser_args(app);

    #[allow(unused_mut)] // mut is only exercised on the Windows branch below
    let mut builder = WebviewWindowBuilder::new(app, CONSOLE_WINDOW_LABEL, WebviewUrl::External(url))
        .title("PWNDA — BasicSwap console (upstream UI)")
        .inner_size(1280.0, 860.0)
        // Pin the window to the engine's own loopback origin. See
        // `console_navigation_allowed` for why a chromeless window needs this
        // and a browser tab does not: there is no address bar here for the
        // user to notice a redirect with.
        .on_navigation({
            let app = app.clone();
            move |url| {
                let ok = console_navigation_allowed(url, port);
                // BOTH outcomes are traced, not just refusals. A refusal that
                // is never logged looks identical to a page that simply did
                // not load — exactly the ambiguity that made this blank window
                // hard to pin down twice running.
                console_trace(
                    &app,
                    &format!(
                        "on_navigation {} url={}",
                        if ok { "ALLOW" } else { "REFUSE" },
                        url
                    ),
                );
                ok
            }
        })
        // Fast path. When it wins the race it authenticates before the first
        // byte renders, so there is no flash of the login form.
        .initialization_script(&script)
        // Slow path, and the one that actually made this work.
        //
        // # The bug this exists for
        //
        // WebView2 registers `initialization_script` through
        // `AddScriptToExecuteOnDocumentCreated`, which is **asynchronous** —
        // the registration can lose to the builder's own first navigation, so
        // the script never runs on the page it was written for. Observed
        // 2026-08-20: the window opened, the cookie was never installed, and
        // the user was handed the login form the whole feature exists to
        // remove.
        //
        // `on_page_load(Finished)` cannot race anything: the document is
        // already there. Running BOTH is deliberate — they are idempotent
        // (the script no-ops when a session cookie is present), so the fast
        // path keeps its no-flash behaviour and the slow path is the floor.
        .on_page_load({
            let app = app.clone();
            let login_arrivals = login_arrivals.clone();
            let relogin_busy = relogin_busy.clone();
            move |webview, payload| {
                // Started is traced too: "Started but never Finished" and
                // "never Started at all" are different faults with different
                // causes, and only the trace tells them apart.
                console_trace(
                    &app,
                    &format!("on_page_load {:?} url={}", payload.event(), payload.url()),
                );
                if payload.event() != PageLoadEvent::Finished {
                    return;
                }
                if payload.url().path() != "/login" {
                    // Past the gate. Keep the cookie fresh on every page so a
                    // long-lived console does not drift out of session, but
                    // never navigate — the user is browsing now.
                    let _ = webview.eval(&on_load_script);
                    return;
                }

                // ── at /login ────────────────────────────────────────────
                //
                // Arrival 1 is the entry URL. Any later one means the session
                // we installed was not accepted. Either way the answer is the
                // same shape: make sure a cookie is written, then NAVIGATE
                // FROM RUST. The old code asked the page to redirect itself
                // and gated that on `document.cookie` being readable, which it
                // is not for an HttpOnly cookie — see `console_init_script`.
                let n = login_arrivals.fetch_add(1, Ordering::SeqCst) + 1;
                if n > CONSOLE_LOGIN_ATTEMPTS {
                    console_trace(
                        &app,
                        &format!(
                            "landed on /login {n} times — leaving upstream's form up rather \
                             than looping; the console can still be used by hand"
                        ),
                    );
                    return;
                }
                if relogin_busy.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app2 = app.clone();
                let wv = webview.clone();
                let pwd = password.clone();
                let busy = relogin_busy.clone();
                let first = n == 1;
                let entry_script = on_load_script.clone();
                tauri::async_runtime::spawn(async move {
                    // The first arrival can reuse the cookie the caller just
                    // minted; a later one needs a fresh session, because
                    // arriving here at all is the server saying the last one
                    // was not good.
                    if first {
                        let _ = wv.eval(&entry_script);
                        console_trace(&app2, "login arrival 1 — cookie written");
                    } else {
                        console_trace(&app2, &format!("login arrival {n} — re-login in Rust"));
                        let client = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(10))
                            .redirect(reqwest::redirect::Policy::none())
                            .build();
                        match match client {
                            Ok(c) => login_for_session(&c, port, &pwd).await,
                            Err(e) => Err(format!("http client build failed: {}", e)),
                        } {
                            Ok(c) => {
                                console_trace(
                                    &app2,
                                    &format!("re-login OK, cookie {} chars", c.len()),
                                );
                                let _ = wv.eval(&console_init_script(&c));
                            }
                            Err(e) => {
                                console_trace(&app2, &format!("re-login FAILED: {}", e));
                                busy.store(false, Ordering::SeqCst);
                                return;
                            }
                        }
                    }
                    // Rust drives the navigation. Not `location.replace` from
                    // the page: that is what silently did nothing whenever the
                    // cookie write was shadowed, and it is the difference
                    // between the two console opens one minute apart in the
                    // 2026-09-05 trace.
                    match format!("http://127.0.0.1:{}{}", port, CONSOLE_HOME_PATH).parse() {
                        Ok(u) => match wv.navigate(u) {
                            Ok(()) => console_trace(&app2, "navigating to the console home"),
                            Err(e) => console_trace(&app2, &format!("navigate FAILED: {}", e)),
                        },
                        Err(e) => console_trace(&app2, &format!("bad console url: {}", e)),
                    }
                    busy.store(false, Ordering::SeqCst);
                });
            }
        });

    // The fix for the white window (2026-08-22, tauri-apps/tauri#13092):
    // mirror the main window's browser args so this webview's WebView2
    // environment options match the one already running in this process.
    // Without this the controller never initializes and the window stays a
    // white rectangle with no navigation, no page-load, and no devtools.
    // Mirroring is also CORRECT here on its own merits: --disable-gpu is the
    // GPU-TDR protection, and the user mines while this console is open.
    #[cfg(target_os = "windows")]
    {
        if let Some(args) = &browser_args {
            console_trace(app, &format!("mirroring main-window browser args: {}", args));
            builder = builder.additional_browser_args(args);
        } else {
            console_trace(app, "main window has no additionalBrowserArgs to mirror");
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &browser_args;

    // The line immediately before the call that hung on 2026-08-21. If a
    // future trace ends here, `build()` is blocking again and the thread it
    // runs on is the first thing to check.
    console_trace(app, "calling WebviewWindowBuilder::build()");

    builder
        .build()
        .map_err(|e| {
            console_trace(app, &format!("window build FAILED: {}", e));
            format!("could not open the console window: {}", e)
        })?;

    console_trace(app, "window build OK");

    // Dev builds only: open devtools alongside the console so the webview's
    // own errors are visible without attaching a debugger. A blank window
    // whose host-side trace looks clean is a renderer-side failure, and this
    // is the only surface that shows it. Compiled out of release.
    #[cfg(debug_assertions)]
    if let Some(w) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        w.open_devtools();
        console_trace(app, "devtools opened (debug build)");
    }

    Ok(())
}

/// Append one line to the console trace, and echo it to stderr.
///
/// # Why a dedicated file and not just `eprintln!`
///
/// The blank-console bug has now survived two diagnoses (see
/// `PwndaWalletVault/log.md`, 2026-08-20 and 2026-08-21), and both times the
/// reason was the same: **nothing on the host recorded what the window
/// actually did.** The webview's own `console.log` goes to devtools the user
/// does not have open, `eprintln!` goes to a terminal that is only present
/// under `tauri dev`, and a shipped build left no evidence at all. So every
/// decision on this path is written somewhere the operator can retrieve after
/// the fact and paste back.
///
/// Best-effort by construction: tracing must never be able to break the thing
/// it traces, so every filesystem error here is swallowed and the stderr echo
/// still happens.
pub(crate) fn console_trace(app: &AppHandle, line: &str) {
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    eprintln!("[bsx-console] {}", line);
    let Ok(dir) = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("logs")))
    else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("bsx-console-trace.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "{} {}", stamp, line);
    }
}

/// The supervisor's own log line — to stderr AND to `swap-sidecar.log` next to
/// `bsx-console-trace.log` (2026-09-04).
///
/// Until this existed every decision the supervisor made about a host-wallet
/// coin — "Main is not running", "scratch wallet could not start", "waited
/// 45 s", the janitor's settles, an unpark restart — was `eprintln!` only:
/// visible in a developer's terminal and nowhere else. The operator hit
/// "parked this session" three starts in a row, and nothing on the machine
/// could say why. `swap_sidecar_supervisor_log` returns the tail; the
/// Settings card's "Copy console diagnostic log" carries it with the console
/// trace.
pub fn supervisor_log(app: &AppHandle, line: &str) {
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    eprintln!("[swap-sidecar] {}", line);
    let Some(p) = supervisor_log_path(app) else {
        return;
    };
    if let Some(dir) = p.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write;
        let _ = writeln!(f, "{} {}", stamp, line);
    }
}

/// Where [`supervisor_log`] writes.
pub fn supervisor_log_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("logs")))
        .ok()
        .map(|d| d.join("swap-sidecar.log"))
}

/// The tail of the supervisor log, for the diagnostic-copy button.
#[tauri::command]
pub async fn swap_sidecar_supervisor_log(app: AppHandle) -> Result<String, String> {
    let Some(p) = supervisor_log_path(&app) else {
        return Err("no log directory".to_string());
    };
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(_) => return Ok(String::new()),
    };
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(300);
    Ok(lines[start..].join("\n"))
}

/// Why a host-wallet coin was parked at the last start, per coin (2026-09-04).
///
/// Written by the activation path that made the decision, read by
/// `swap_sidecar_coin_status` into `CoinEnableStatus::parked_reason`, cleared
/// at every start. Module-level rather than a `SwapSidecarInner` field so the
/// activators — which hold no state guard — can record it without a lock
/// held across an `.await`.
static PARK_REASONS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

fn park_reasons() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    PARK_REASONS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn set_park_reason(coin: &str, reason: impl Into<String>) {
    if let Ok(mut m) = park_reasons().lock() {
        m.insert(coin.to_string(), reason.into());
    }
}

pub fn clear_park_reason(coin: &str) {
    if let Ok(mut m) = park_reasons().lock() {
        m.remove(coin);
    }
}

pub fn clear_park_reasons() {
    if let Ok(mut m) = park_reasons().lock() {
        m.clear();
    }
}

pub fn park_reason(coin: &str) -> Option<String> {
    park_reasons().lock().ok().and_then(|m| m.get(coin).cloned())
}

/// Where [`console_trace`] writes, for the UI to show the operator.
pub fn console_trace_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("logs")))
        .ok()
        .map(|d| d.join("bsx-console-trace.log"))
}

/// Read the tail of the console trace so the operator can hand it back
/// without hunting for a file under AppData.
#[tauri::command]
pub async fn swap_sidecar_console_trace(app: AppHandle) -> Result<String, String> {
    let Some(p) = console_trace_path(&app) else {
        return Err("no log directory".to_string());
    };
    let text = std::fs::read_to_string(&p)
        .map_err(|e| format!("could not read {}: {}", p.display(), e))?;
    // Tail, not head: the interesting part of a repeated failure is the most
    // recent attempt, and the file accumulates across every open.
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(200);
    Ok(lines[start..].join("
"))
}

/// May the console window navigate to `url`?
///
/// The console renders **upstream's** UI, which this project does not audit and
/// does not control. Without this, any link in it — an update notice, a docs
/// link, a support forum, anything a future upstream release adds — navigates a
/// window wearing PWNDA's own title bar to an arbitrary site. The user has no
/// address bar to notice with, which is exactly what makes a chromeless window
/// worse than a browser tab for this one property.
///
/// So the window is pinned to the loopback origin it was opened for. Both the
/// host and the port must match: `127.0.0.1` alone is not enough, because every
/// other local service — including other users' — also lives there, and the
/// engine's own port is the only one this window has a session for.
///
/// Fails **closed**: anything unparseable, any non-http scheme (`file:`,
/// `data:`, `javascript:`), any other host, and any other port are all refused.
/// `localhost` is deliberately NOT accepted — it resolves through the hosts
/// file, which is user-writable, so it is not a synonym for the loopback
/// address here.
pub fn console_navigation_allowed(url: &url::Url, engine_port: u16) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if url.port() != Some(engine_port) {
        return false;
    }
    matches!(url.host_str(), Some("127.0.0.1"))
}

/// Window label; also the re-focus key.
const CONSOLE_WINDOW_LABEL: &str = "bsx-console";

/// The init script that installs the session cookie.
///
/// Pure and exported for test, because the interesting property is a NEGATIVE
/// one: the password must not appear in it. A future edit that "simplifies"
/// this by posting the password from JS would put a fund-moving credential into
/// a page context, and `console_init_script_carries_no_password` is what stops
/// it landing silently.
///
/// ## Why it ALWAYS writes, and why it no longer DECIDES (2026-09-05)
///
/// The first version returned early when a cookie of that name was already
/// visible to `document.cookie`. But `document.cookie` cannot see an
/// `HttpOnly` cookie at all — and upstream's session cookie IS HttpOnly
/// (`http_server.py::_set_session_cookie`) — so the only cookie that guard
/// could ever find was our own earlier write.
///
/// The second version dropped the early return but kept the same read as the
/// **redirect condition** (`ok && pathname === "/login"`), and that is the bug
/// the operator hit: *"whenever I open the console the bsx ui says login, but
/// when I close out and do it again it logs me in automatically."* The trace
/// shows both halves of it, one minute apart:
///
/// ```text
/// 21:08:59.818 on_page_load Started  /login
/// 21:08:59.942 on_page_load Finished /login      <- init script never ran
/// 21:08:59.942 cookie install script eval OK     <- fallback ran, NO redirect
///
/// 21:09:58.108 on_page_load Started  /login
/// 21:09:58.111 on_navigation ALLOW   /offers     <- init script, 3 ms in
/// ```
///
/// `initialization_script` is registered through WebView2's **asynchronous**
/// `AddScriptToExecuteOnDocumentCreated`, so it wins some navigations and
/// loses others — that race is already documented at its call site. The
/// fallback that exists to cover the loss ran and then declined to navigate,
/// because `ok` was false: a JS write is silently ignored when an HttpOnly
/// cookie of the same name is in the jar, and WebView2 keeps that jar for the
/// life of the app. So the fallback could only work on the runs that did not
/// need it.
///
/// Now the script only WRITES. The navigation is issued from Rust
/// (`webview.navigate`), which cannot be shadowed by a cookie, lost to a
/// script-registration race, or blocked by page JS — and it works whether the
/// jar's own cookie or ours is the valid one, since the server decides.
pub fn console_init_script(cookie: &str) -> String {
    // The cookie is a server-generated `name=value` pair, but it is
    // interpolated into JS, so quote-escape rather than trust its shape.
    let safe = cookie.replace('\\', "\\\\").replace('"', "\\\"");
    // `console.log` rather than silence: this runs in a window with no
    // devtools open by default, but WebView2 forwards console output to the
    // host, so a failed install leaves a trace instead of an unexplained login
    // form. That absence is exactly what made the first failure hard to place.
    format!(
        r#"(function () {{
  try {{
    document.cookie = "{safe}; path=/";
    console.log("[pwnda] console session write attempted");
  }} catch (e) {{
    console.log("[pwnda] console session install threw:", e);
  }}
}})();"#,
        safe = safe
    )
}

/// The page the console opens on once it holds a session.
pub const CONSOLE_HOME_PATH: &str = "/offers";

/// How many times a single console window will try to get past `/login`.
///
/// Two: the first arrival installs and navigates; a bounce back means the
/// cookie did not take, so the second re-logs in and tries once more. A third
/// would be a loop, and the honest end state for a console that cannot
/// authenticate is upstream's own login form — which the user can still use.
pub const CONSOLE_LOGIN_ATTEMPTS: u32 = 2;

/// Upstream's session cookie name (`http_server.py:82`).
///
/// No production reader since 2026-09-05: the install script stopped checking
/// whether its own write was visible (it cannot be — the server's cookie is
/// `HttpOnly`), so nothing looks the name up any more. Kept as the documented
/// wire fact, and asserted by `console_init_script_only_writes_the_cookie`,
/// which is what would catch the script writing some OTHER name.
#[cfg_attr(not(test), allow(dead_code))]
pub const SESSION_COOKIE_NAME: &str = "basicswap_session_id";

#[tauri::command]
pub async fn swap_sidecar_set_autostart(
    app: AppHandle,
    enabled: bool,
) -> Result<OptInRecord, String> {
    let mut rec = read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    rec.autostart = enabled;
    write_optin(&app, &rec)?;
    Ok(rec)
}

/// R3 - refuse a FIRST prepare that would mint an unbacked-up Particl wallet.
///
/// A prepare on a datadir with no `basicswap.json` generates a fresh recovery
/// phrase inside the engine (prepare.py's `particl_wallet_mnemonic` default)
/// and prints it once. Nothing in the wallet has a copy, so the user ends up
/// with a swap wallet their vault backup cannot restore. Requiring the BIP85
/// child phrase - which only an UNLOCKED vault can derive - is what makes the
/// swap wallet a function of the seed the user already backed up.
///
/// The existing-config path is deliberately NOT gated: `prepare.py:1436-1461`
/// early-returns on an existing config without touching a wallet, so a
/// reconfigure or a credsfile-recovery run cannot regenerate anything.
pub fn check_first_prepare_gate(
    run_prepare: bool,
    has_mnemonic: bool,
    config_exists: bool,
) -> Result<(), String> {
    if run_prepare && !has_mnemonic && !config_exists {
        return Err("the vault must be unlocked to create the swap wallet".to_string());
    }
    Ok(())
}

/// Start the node and poll it healthy.
///
/// **Prepare runs on first-time setup or an explicit `reconfigure`, never on
/// every start.** Once `basicswap.json` exists it is the authority on which
/// ports the node binds — see [`plan_session_ports`] for the orphan this
/// prevents.
#[tauri::command]
pub async fn swap_sidecar_start(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
    network: Option<Network>,
    xmr_rpc_host: Option<String>,
    xmr_rpc_port: Option<u16>,
    reconfigure: Option<bool>,
    particl_mnemonic: Option<String>,
) -> Result<SidecarStatus, String> {
    if !read_optin(&app).opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }

    // Check-and-CLAIM under one lock acquisition, then drop the guard before
    // any `.await` (a held `MutexGuard` makes the future non-`Send`, which
    // `generate_handler!` rejects).
    //
    // # Why a claim and not just a check
    //
    // The first cut checked `is_running()` — which excludes `Preparing` — and
    // `Preparing` itself was only set deep inside `start_node_core`. Between
    // the check and that write sits reconcile (up to 15s) plus the daemon
    // sweep (worse when orphans are slow), so the Settings card showed an
    // enabled Start button while autostart was already mid-flight, the user
    // clicked it, and TWO starts ran concurrently: interleaved sweeps, the
    // config written twice, two run.py spawns fighting over the same ports.
    // Observed live on 2026-08-20 ("nothing to reconcile" twice in one boot).
    //
    // The write is direct rather than via `set_phase` because atomicity IS the
    // point — check-then-set across two lock acquisitions is the race again.
    // Both claimed transitions (Stopped→Preparing, Failed→Preparing) are legal
    // in `can_transition_to`, and `start_node_core`'s own later
    // `set_phase(Preparing)` is the idempotent self-transition.
    let already_busy = {
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.phase.blocks_new_start() {
            true
        } else {
            guard.phase = Phase::Preparing;
            false
        }
    };
    if already_busy {
        // The loser reports the winner's state instead of racing it. For the
        // Start-button click that means the card immediately shows
        // "Configuring" — which is true.
        return swap_sidecar_status(app.clone(), state).await;
    }

    // Every `?` between the claim and `start_node_core`'s own phase writes
    // would otherwise strand the phase at `Preparing` — permanently, since
    // `blocks_new_start` now refuses new starts while it holds. The guard
    // turns an abandoned claim into `Failed` on scope exit; on every healthy
    // path the phase has moved past `Preparing` by then and this is a no-op.
    struct StartClaim<'a>(&'a SwapSidecarState);
    impl Drop for StartClaim<'_> {
        fn drop(&mut self) {
            if let Ok(mut g) = self.0 .0.lock() {
                if matches!(g.phase, Phase::Preparing) {
                    g.phase = Phase::Failed {
                        reason: "the start was aborted before the node launched".to_string(),
                    };
                }
            }
        }
    }
    let claim = StartClaim(&state);

    let network = resolve_network(network, std::env::var(NETWORK_ENV).ok().as_deref());
    let base = sidecar_base_dir(&app)?;
    std::fs::create_dir_all(base.join("datadir"))
        .map_err(|e| format!("cannot create the sidecar datadir: {}", e))?;

    // Finish applying the app update before the engine runs, not after the
    // user reads a drift note and goes looking for a PowerShell script. Safe
    // here specifically: the start is CLAIMED (nothing else may start), and
    // nothing has spawned yet, so no engine process holds the tree. A dev
    // checkout has no bundle and this is a no-op there. See
    // `reconcile_bundled_engine`.
    match reconcile_bundled_engine(&app, false).await {
        Ok(Some(msg)) => supervisor_log(&app, &format!("start: {}", msg)),
        Ok(None) => {}
        // A failed reinstall must not block a start: the engine that IS on
        // disk may well run. Loud in the log, and the card still shows the
        // drift note.
        Err(e) => supervisor_log(&app, &format!("start: engine reinstall failed: {}", e)),
    }

    // Phase timings. "Why is starting slow" previously needed the engine's own
    // log plus arithmetic across two files; the supervisor is the only thing
    // that can see all of its own phases, so it reports them.
    let t0 = std::time::Instant::now();
    let mut mark = t0;
    let lap = |what: &str, mark: &mut std::time::Instant| {
        let d = mark.elapsed();
        *mark = std::time::Instant::now();
        if d.as_millis() >= 250 {
            supervisor_log(&app, &format!("timing: {} took {:.1}s", what, d.as_secs_f64()));
        }
    };

    emit_progress(&app, "reconciling", 2.0, "Checking for a previous session");
    let note = reconcile_stale_instance(&app).await;
    supervisor_log(&app, &note);
    lap("reconcile previous session", &mut mark);

    // ── Ports ───────────────────────────────────────────────────────
    // An existing basicswap.json is authoritative: prepare would NOT re-apply
    // a new --portoffset over it (prepare.py:1436-1461 returns 0 first), so
    // the only ports the node can bind are the ones already in that file.
    // The offset scan is consulted only when there is nothing configured yet.
    let dd = datadir(&app)?;

    // Coin daemons can outlive every parent this module tracks. A hard-killed
    // dev session (Ctrl-C tears the console down before the exit hook can run)
    // or a start that died between spawning daemons and becoming ready leaves
    // a particld/bitcoind holding the configured RPC ports — with no pidfile
    // and no HTML listener for `reconcile_stale_instance` to key on, so that
    // reconcile answers "nothing to reconcile" while the wedge sits one port
    // over. 2026-08-20: four consecutive mainnet starts died in
    // `basicswap.py:1284` ("Mismatched pid") against exactly such an orphan.
    // Same graceful-RPC sweep the post-addcoin path uses; on a clean install
    // no port is bound and this is a no-op.
    let swept = sweep_prepare_daemons(&dd).await;
    if swept > 0 {
        supervisor_log(
            &app,
            &format!("stopped {} coin daemon(s) surviving from a previous session", swept),
        );
    }
    lap("stop stale coin daemons", &mut mark);

    let configured = configured_ports_in(&dd);
    let fresh_offset = if configured.is_none() {
        emit_progress(&app, "ports", 5.0, "Choosing loopback ports");
        resolve_port_offset(DEFAULT_HTML_PORT, DEFAULT_WS_PORT).await
    } else {
        None
    };
    let ports = plan_session_ports(
        configured,
        fresh_offset,
        DEFAULT_HTML_PORT,
        DEFAULT_WS_PORT,
    )?;

    // A config we cannot authenticate against is worse than no config: prepare
    // is the only thing that rewrites `client_auth_hash`, so if the credsfile
    // went missing we must re-run it or every request 401s.
    let creds_present = credsfile(&app).map(|p| p.is_file()).unwrap_or(false);
    let run_prepare = ports.run_prepare || reconfigure.unwrap_or(false) || !creds_present;

    // R3: a first prepare with a locked vault would mint a swap wallet nobody
    // has a backup of. `configured.is_some()` is the existing-install test -
    // exactly the case prepare early-returns on, and therefore not gated.
    check_first_prepare_gate(run_prepare, particl_mnemonic.is_some(), configured.is_some())?;

    // C0.2 precedence: explicit args > stored pin > none. The store is read
    // ONLY when the caller named no host, so a UI that picked a node cannot be
    // silently overridden by a stale pin - and `on_app_ready`, which passes
    // nothing, gets the user's pin without a signature change of its own.
    // Redundancy: probe the candidate list and pin the first node that
    // actually answers, rather than writing a stored preference into
    // `basicswap.json` and discovering at runtime that it is down — which the
    // engine cannot recover from, because `run.py` reads that file once.
    //
    // An explicitly-passed host is never probed away: that is a caller saying
    // "use this one", and the setup wizard's node choice must not be silently
    // second-guessed.
    let pinned = if xmr_rpc_host.is_none() {
        let candidates = xmr_node_candidates(&app);
        let chosen = pick_healthy_xmr_node(&candidates).await;
        match (&chosen, candidates.first()) {
            (Some(c), Some(first)) if c != first => eprintln!(
                "[swap-sidecar] preferred monero node {}:{} is down; using {}:{}",
                first.0, first.1, c.0, c.1
            ),
            (None, Some(_)) => eprintln!(
                "[swap-sidecar] no monero node answered ({} tried) — leaving the \
                 chainclient as configured rather than switching to a local daemon",
                candidates.len()
            ),
            _ => {}
        }
        // Every candidate failing leaves the config untouched: a network blip
        // must not become an ~80 GB local-monerod decision.
        chosen
    } else {
        None
    };
    let (xmr_rpc_host, xmr_rpc_port) = resolve_xmr_node(xmr_rpc_host, xmr_rpc_port, pinned);

    // C5: set by `swap_sidecar_set_wallet_key` BEFORE the start, never
    // persisted. `None` means this install is not using wallet encryption, and
    // both the prepare env and the post-health unlock are skipped.
    let wallet_pwd = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.wallet_pwd.clone()
    };

    // C9. Before `build_config` so a consented+capable engine gets
    // `mainwalletrpc*` in the SAME config write `run_prepare_step`/
    // `apply_local_config_policy` are about to do — one write, not a
    // straggling second one after prepare already ran. Best-effort by
    // construction (see the function's own doc comment): its `None` path
    // and this call's own errors never reach the `?` below.
    clear_park_reasons();
    let xmr_host_wallet = maybe_activate_xmr_host_wallet(&app).await;
    // C-RZ. Same placement reasoning as the XMR call immediately above:
    // before `build_config`, so a consented+capable engine gets ZEPH's
    // `mainwalletrpc*` in the SAME config write, and best-effort by
    // construction (see the function's own doc comment) so a ZEPH-sharing
    // failure never blocks BTC/LTC/XMR/anything else from starting.
    let zph_host_wallet = maybe_activate_zph_host_wallet(&app).await;
    // C-RX. Same placement reasoning as the two calls immediately above:
    // before `build_config`, so a consented+capable engine gets Zano's
    // Main+Scratch wallet-rpc pointers in the SAME config write, and
    // best-effort by construction (see the function's own doc comment) so
    // a ZANO-sharing failure never blocks BTC/LTC/XMR/ZEPH/anything else
    // from starting.
    // 2026-09-04: give the app's own Zano wallet time to come up first —
    // see `wait_for_zano_main_wallet`. Without this, an autostart (or a
    // manual start right after unlock) reads "Main is not running", writes
    // `connection_type: none`, and ZANO is parked for the session on a
    // machine whose Zano wallet was 14 seconds from being ready.
    wait_for_zano_main_wallet(&app).await;
    let zano_host_wallet = maybe_activate_zano_host_wallet(&app).await;

    let cfg = build_config(
        &app,
        network,
        ports.port_offset,
        xmr_rpc_host,
        xmr_rpc_port,
        xmr_host_wallet,
        zph_host_wallet,
        zano_host_wallet,
        particl_mnemonic.map(Secret::new),
        wallet_pwd,
    )?;
    // ── Which wallet does this engine datadir belong to? ────────────
    //
    // The datadir is a single fixed path with no wallet id in it, and
    // `--particl_mnemonic` reaches upstream on PREPARE's argv only — so the
    // engine's Particl wallet is created once, from whichever vault was active
    // at first prepare, and keeps those keys across every later wallet switch.
    // Record the owner the first time we see it; after that, say so loudly when
    // this session's seed is a different one. Fingerprint only: a seed must not
    // land in a plaintext opt-in record.
    {
        let mut rec = read_optin(&app);
        let session_fp = cfg.particl_mnemonic.as_ref().map(|m| seed_fingerprint(m.expose()));
        match (&rec.swap_seed_fingerprint, &session_fp) {
            (None, Some(fp)) => {
                rec.swap_seed_fingerprint = Some(fp.clone());
                let _ = write_optin(&app, &rec);
                eprintln!("[swap_sidecar] engine datadir bound to wallet seed {fp}");
            }
            (Some(datadir_fp), Some(fp)) if datadir_fp != fp => {
                eprintln!(
                    "[swap_sidecar] WALLET MISMATCH: this datadir was created by seed {datadir_fp}                      but this session started with {fp}. Account-key pushes are refused."
                );
                if let Ok(mut g) = state.0.lock() {
                    g.seed_mismatch = Some(SeedMismatch {
                        datadir_seed: datadir_fp.clone(),
                        session_seed: fp.clone(),
                    });
                }
            }
            _ => {
                if let Ok(mut g) = state.0.lock() {
                    g.seed_mismatch = None;
                }
            }
        }
    }

    let python = cfg.python.clone();
    if !python.is_file() {
        set_phase(
            &state,
            Phase::Failed {
                reason: "runtime missing".to_string(),
            },
        )?;
        return Err(format!(
            "the swap runtime is not installed ({} is missing) — run the setup step first",
            python.display()
        ));
    }

    // Everything from here — prepare, spawn, health poll — is
    // [`start_node_core`]. The only thing this wrapper still owns is resolving
    // paths from the `AppHandle` and the state/progress bookkeeping the sink
    // performs on its behalf.
    // At most ONE automatic repair per start command: the txindex case is
    // the only failure this supervisor knows how to fix by itself, and a
    // second occurrence in the same start means the fix did not take.
    let mut txindex_repaired = false;
    let started = loop {
        let attempt = {
            let sink = TauriSessionSink {
                app: &app,
                state: &state,
            };
            start_node_core(
                &sink,
                &cfg,
                ports.clone(),
                run_prepare && !txindex_repaired,
                READY_BUDGET_MS,
                READY_POLL_MS,
            )
            .await
        };
        match attempt {
            Err(e) if e.starts_with(PARTICL_TXINDEX_ERR_PREFIX) && !txindex_repaired => {
                txindex_repaired = true;
                let plain = e.trim_start_matches(PARTICL_TXINDEX_ERR_PREFIX).to_string();
                supervisor_log(&app, &format!("start: {plain}"));
                // The engine is still alive, retrying a daemon that is gone.
                // Down first, then repair, then once more.
                teardown_failed_start(&app, &state).await;
                let _ = sweep_prepare_daemons(&dd).await;
                match repair_particl_txindex(&dd).await {
                    Ok(dir) => {
                        supervisor_log(
                            &app,
                            &format!(
                                "particl: deleted the inconsistent txindex at {} — particld \
                                 rebuilds it in the background on the next start; starting again",
                                dir.display()
                            ),
                        );
                        emit_progress(
                            &app,
                            "preparing",
                            12.0,
                            "Repaired the Particl transaction index — starting again",
                        );
                        continue;
                    }
                    Err(re) => {
                        supervisor_log(&app, &format!("particl: could not repair the txindex: {re}"));
                        break Err(plain);
                    }
                }
            }
            Err(e) => break Err(e.trim_start_matches(PARTICL_TXINDEX_ERR_PREFIX).to_string()),
            Ok(p) => break Ok(p),
        }
    };
    lap("prepare + coin reconcile + node launch", &mut mark);
    supervisor_log(&app, &format!("timing: start total {:.1}s", t0.elapsed().as_secs_f64()));
    if let Err(e) = started {
        supervisor_log(&app, &format!("start failed: {}", e.lines().next().unwrap_or("")));
        // A start that failed with the engine still ALIVE — the health budget
        // ran out, or the chain daemon died and run.py kept retrying — must
        // not leave that python running. On 2026-09-05 it held the UI port
        // and the pidfile for seven more minutes and the operator's next
        // start collided with it. The ladder is the only sanctioned way down.
        teardown_failed_start(&app, &state).await;
        // run.py can die AFTER spawning daemons (the "Mismatched pid" path
        // exits without stopping what it launched), and a daemon left here is
        // the pre-start sweep's problem one failure later — better to not
        // create it. Best effort: the error reported is the start's, never
        // the sweep's.
        let swept = sweep_prepare_daemons(&dd).await;
        if swept > 0 {
            supervisor_log(
                &app,
                &format!("stopped {} coin daemon(s) left behind by the failed start", swept),
            );
        }
        return Err(e);
    }
    // `start_node_core` has owned the phase from here on (Healthy on this
    // path); the abandoned-claim guard has nothing left to protect.
    drop(claim);
    // R12 bookkeeping: from here the enabled chains are being pulled, so a
    // later descriptor import can no longer be guaranteed the history it needs.
    mark_first_sync_started(&app);
    swap_sidecar_status(app.clone(), state).await
}

/// Tear down the engine process a FAILED start left running.
///
/// `start_node_core` reports `Failed` and returns, but the python it spawned
/// is still alive — retrying an RPC that cannot answer, holding the UI port
/// and the pidfile. Until 2026-09-05 nothing stopped it: on that day's failed
/// start it ran on for seven minutes after the supervisor had given up, and
/// the next start collided with it. Same ladder as a stop, short budget, and
/// the phase is left at `Failed` so the card still shows why.
async fn teardown_failed_start(app: &AppHandle, state: &tauri::State<'_, SwapSidecarState>) {
    let (port, password, pid, alive) = {
        let Ok(guard) = state.0.lock() else {
            return;
        };
        (guard.html_port, guard.auth_password.clone(), guard.pid, guard.child.is_some())
    };
    if !alive && pid.is_none() {
        return;
    }
    let Some(password) = password else {
        return;
    };
    let Ok(dd) = datadir(app) else {
        return;
    };
    let outcome = stop_node_core(
        port,
        &password,
        pid,
        dd,
        LadderConfig {
            max_wait_ms: 10_000,
            poll_ms: 500,
            finalised_grace_ms: LADDER_FINALISED_GRACE_MS,
        },
    )
    .await;
    supervisor_log(
        app,
        &format!(
            "failed start torn down: clean={} steps={:?} daemons_stopped={} notes={:?}",
            outcome.clean, outcome.steps, outcome.daemons_stopped, outcome.notes
        ),
    );
    if let Ok(mut guard) = state.0.lock() {
        guard.child = None;
        guard.pid = None;
    }
    if let Ok(path) = pidfile(app) {
        crate::wallet_rpc_common::delete_pidfile(&path);
    }
}

/// Production [`SessionSink`]: Tauri progress events, the guarded phase write,
/// the pidfile, and the managed-state child handle.
struct TauriSessionSink<'a, 'r> {
    app: &'a AppHandle,
    state: &'a tauri::State<'r, SwapSidecarState>,
}

impl SessionSink for TauriSessionSink<'_, '_> {
    fn set_phase(&self, next: Phase) -> Result<(), String> {
        set_phase(self.state, next)
    }

    fn progress(&self, stage: &str, percent: f64, message: &str) {
        emit_progress(self.app, stage, percent, message);
    }

    fn on_spawned(
        &self,
        child: tokio::process::Child,
        pid: Option<u32>,
        ports: &SessionPorts,
        password: &str,
    ) -> Result<(), String> {
        if let (Some(pid), Ok(path)) = (pid, pidfile(self.app)) {
            crate::wallet_rpc_common::write_pidfile(&path, pid);
        }
        let mut guard = self
            .state
            .0
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        guard.child = Some(child);
        guard.pid = pid;
        // From `ports`, never `cfg.html_port()`: the config file may carry a
        // port the base+offset arithmetic does not reproduce, and the ladder's
        // `parent_alive` probe is only meaningful on the port the node BOUND.
        guard.port_offset = ports.port_offset;
        guard.html_port = ports.html_port;
        guard.ws_port = ports.ws_port;
        guard.auth_password = Some(password.to_string());
        Ok(())
    }

    fn child_exit_code(&self) -> Option<i32> {
        match self.state.0.lock() {
            Ok(mut guard) => match guard.child.as_mut() {
                Some(ch) => match ch.try_wait() {
                    Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                    _ => None,
                },
                None => None,
            },
            Err(_) => None,
        }
    }
}

/// Stop the node through the ladder. Never kills a daemon first.
#[tauri::command]
pub async fn swap_sidecar_stop(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
) -> Result<SidecarStatus, String> {
    let (phase, port, password, pid) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (
            guard.phase.clone(),
            guard.html_port,
            guard.auth_password.clone(),
            guard.pid,
        )
    };
    // Stopping an already-stopped node is a no-op, not an error — the UI may
    // fire this on a view teardown it doesn't coordinate with the phase.
    if matches!(phase, Phase::Stopped) {
        return swap_sidecar_status(app.clone(), state).await;
    }
    let password = match password {
        Some(p) => p,
        None => read_or_create_auth_password(&app)?,
    };
    set_phase(&state, Phase::Stopping)?;
    emit_progress(&app, "stopping", 10.0, "Asking the swap node to shut down");

    let outcome = stop_node_core(
        port,
        &password,
        pid,
        datadir(&app)?,
        LadderConfig::default(),
    )
    .await;
    supervisor_log(
        &app,
        &format!(
            "stop: clean={} steps={:?} notes={:?}",
            outcome.clean, outcome.steps, outcome.notes
        ),
    );

    {
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.child = None;
        guard.pid = None;
        guard.auth_password = None;
        // C5: the wallet key lives for exactly one session. A stopped node
        // holds no key, so a later start has to be handed one again.
        guard.wallet_pwd = None;
        guard.phase = Phase::Stopped;
    }
    if let Ok(path) = pidfile(&app) {
        crate::wallet_rpc_common::delete_pidfile(&path);
    }
    // C9: release this stop's claim on the shared Monero wallet-rpc, if any
    // was ever acquired (a plain `Session`-only user never touched the
    // SwapEngine lease, so this is a no-op removal from an empty set for
    // them — see `XmrRpcInner::release_lease`). Unconditional, and
    // deliberately not gated on in-flight bids: the swap ENGINE is the
    // thing going away here, so nothing is left that could still call
    // `transfer` on the main wallet regardless of whether this lease is
    // held — the existing shutdown ladder already does not wait for
    // in-flight swaps (a separate, pre-existing decision this does not
    // change), and holding the lease open after the engine is gone would
    // just leave pwnda's own wallet-rpc listening for no reason.
    let _ = crate::xmr_rpc::xmr_stop_rpc(app.clone(), crate::xmr_rpc::XmrLease::SwapEngine).await;
    // C-RZ: ZEPH's twin release, same unconditional reasoning as the XMR
    // line immediately above — a plain-Session-only ZEPH user never
    // touched the SwapEngine lease, so this is a no-op removal from an
    // empty set for them.
    let _ = crate::zph_rpc::zph_stop_rpc(app.clone(), Some(crate::zph_rpc::ZphLease::SwapEngine))
        .await;
    emit_progress(&app, "stopped", 100.0, "Swap node stopped");
    swap_sidecar_status(app.clone(), state).await
}

/// C5 - hand the supervisor the wallet-encryption key for this session.
///
/// **Must be called BEFORE [`swap_sidecar_start`]**: the key is what makes
/// prepare encrypt each wallet as it initialises it, and what the post-health
/// unlock uses. Memory only - it is never written to disk, never returned in
/// [`SidecarStatus`], and cleared by [`swap_sidecar_stop`].
///
/// The key itself is derived frontend-side from the vault mnemonic
/// (`src/lib/swapWalletKey.ts`), so the user never types a second password and
/// the backend never sees a mnemonic.
#[tauri::command]
pub async fn swap_sidecar_set_wallet_key(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
    key: String,
) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("the swap wallet key cannot be empty".to_string());
    }
    {
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.wallet_pwd = Some(Secret::new(key));
    }
    // Learn — durably — that this install's wallets are encrypted. The only
    // reason a key exists is that C5 encryption was set up, and the marker is
    // what lets a later KEYLESS start know its addcoins are doomed before
    // paying two minutes per coin to find out (see `addcoins_are_doomed`).
    // Best-effort: a failed preference write must not fail the key push.
    let mut rec = read_optin(&app);
    if !rec.wallet_encrypted {
        rec.wallet_encrypted = true;
        if let Err(e) = write_optin(&app, &rec) {
            eprintln!(
                "[swap-sidecar] could not record the wallet-encrypted marker: {}",
                e
            );
        }
    }

    // If the node is ALREADY up, unlock it now. This is what makes the unlock
    // automatic: a keyless autostart leaves the wallets locked, and the key
    // arriving IS the event that can fix it — waiting for the user to find an
    // "Unlock" button afterwards is asking them to finish a job the app knows
    // how to finish. A start that happens later needs nothing extra:
    // `unlock_if_configured` runs at the end of it with the key in memory.
    //
    // Best-effort by design. The key push is the caller's request and it has
    // succeeded; a node that is down, or an unlock that fails, must not turn
    // that into an error — the state is reported, and `openConsole` and the
    // Unlock button both retry.
    // HEALTHY, not `is_running()`: that predicate is true during `Starting`,
    // when the HTTP server is not listening yet, and this fired three times
    // into a closed port during an 86-second prepare (2026-09-05, "automatic
    // unlock after key push failed: error sending request for url
    // .../json/unlock"). A start that is still under way finishes its own
    // unlock (`unlock_if_configured`) with the key that is now in memory, so
    // there is nothing to do here but not fail.
    let (healthy, port) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (matches!(guard.phase, Phase::Healthy), guard.html_port)
    };
    if healthy {
        match read_or_create_auth_password(&app) {
            Ok(auth) => {
                let pwd = {
                    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
                    guard.wallet_pwd.clone()
                };
                if let Some(pwd) = pwd {
                    match unlock_wallets(port, &auth, pwd.expose()).await {
                        Ok(()) => eprintln!(
                            "[swap-sidecar] wallets unlocked automatically on key push"
                        ),
                        Err(e) => eprintln!(
                            "[swap-sidecar] automatic unlock after key push failed: {}",
                            e
                        ),
                    }
                }
            }
            Err(e) => eprintln!("[swap-sidecar] no console credential for auto-unlock: {}", e),
        }
    }
    Ok(())
}

/// C8 - one coin's account key, from the renderer.
///
/// `account_key` is spending authority for that coin's whole branch. It exists
/// for the duration of one command and is never stored, never logged and never
/// echoed back — [`AccountKeyOutcome`] deliberately carries no field that could
/// hold it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountKeyPush {
    /// UPPERCASE ticker (`"BTC"`).
    pub ticker: String,
    /// The 74-byte account node, hex. Secret.
    pub account_key: String,
    /// The index-0 receive address the WALLET derives for this account. The
    /// engine must independently arrive at the same string.
    pub expected_address: String,
    /// How this wallet's addresses are encoded: `"p2wpkh"` (default) or
    /// `"p2pkh"` for a wallet whose funds live on legacy base58 addresses —
    /// the Exodus/Atomic import case. Travels with the key because it is a
    /// property of THAT wallet, and the engine must both watch and SPEND in
    /// the matching script type (PWNDA-PATCH-3 / PWNDA-PATCH-6).
    #[serde(default = "default_address_type")]
    pub address_type: String,
}

fn default_address_type() -> String {
    "p2wpkh".to_string()
}

/// What became of one push.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountKeyOutcome {
    pub ticker: String,
    /// The engine stood the wallet up now. False means "stored, pending
    /// unlock" — normal, not a failure.
    pub initialized: bool,
    /// True only when the engine's derived address equals the wallet's.
    pub shared: bool,
    /// Populated on refusal or on an address mismatch.
    pub error: Option<String>,
}

/// C8 - push account keys so the lean wallets ARE the user's wallets.
///
/// Called on vault unlock, after the wallet-encryption key. Idempotent: the
/// engine holds the key in memory only, so every start needs the push again,
/// and pushing twice in one session simply re-initialises to the same wallet.
///
/// # The mismatch check is the point
///
/// Each push returns the deposit address the ENGINE derived. It is compared
/// against the address the WALLET derives for the same account, and a
/// disagreement is reported as a failure for that coin — because it means the
/// engine stood up a wallet nobody intended, and every other signal in the
/// system would still look healthy while funds landed out of the user's reach.
/// Only a coin that matched is recorded as [`Adoption::AccountKey`].
///
/// A coin is never marked adopted on a merely-successful HTTP call.
#[tauri::command]
pub async fn swap_sidecar_push_account_keys(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
    keys: Vec<AccountKeyPush>,
) -> Result<Vec<AccountKeyOutcome>, String> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let (running, port) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (guard.phase.is_running(), guard.html_port)
    };
    if !running {
        // Not an error the user should see as a fault: the caller retries on
        // the next start, and the fail-closed env guard means an un-pushed
        // coin has no wallet rather than the wrong one.
        return Err("the swap node is not running".to_string());
    }

    // Refuse to hand THIS wallet's account keys to ANOTHER wallet's engine.
    // PATCH-3 initialises a lean coin's wallet from the pushed account key, so a
    // cross-wallet push does not mis-label anything — it makes the engine spend
    // from a wallet its Particl master does not belong to. Fund-affecting, and
    // silent until now.
    {
        let mismatch = state
            .0
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .seed_mismatch
            .clone();
        if let Some(m) = mismatch {
            return Err(format!(
                "refusing to share this wallet with the swap engine: the engine's datadir was                  created by a different wallet (seed {} vs {}). Switch back to that wallet, or                  reconfigure the swap node for this one.",
                m.datadir_seed, m.session_seed
            ));
        }
    }
    let auth = read_or_create_auth_password(&app)?;

    // Consent is checked HERE as well as in the caller's filter. The renderer
    // decides which coins to offer; it must not be able to decide which keys
    // leave the process. A caller bug, or a compromised one, would otherwise
    // share an account whose owner never saw the disclosure.
    let consented = read_optin(&app);

    let mut outcomes: Vec<AccountKeyOutcome> = Vec::with_capacity(keys.len());
    let mut adopted: Vec<String> = Vec::new();

    for k in &keys {
        let ticker = k.ticker.trim().to_ascii_uppercase();
        // Same rule the env guard uses — `shares_lean_wallet`, not the raw ack
        // timestamp. These two MUST agree: `adoption_coins` arms the engine to
        // REFUSE building its own wallet, and this decides whether the key
        // that unblocks it is allowed to leave. When they disagreed (they did,
        // between the default-ON inversion and this fix) a fresh install
        // deadlocked — engine refuses to build, host refuses to send — and the
        // coin ended up with no wallet at all.
        let entry = coin_key_from(&ticker).and_then(|c| consented.coins.get(c));
        let shares = entry
            .map(|e| shares_lean_wallet(consented.opted_in, e))
            .unwrap_or(false);
        if !shares {
            outcomes.push(AccountKeyOutcome {
                ticker,
                initialized: false,
                shared: false,
                error: Some(
                    "this coin is not set to use your existing wallet".to_string(),
                ),
            });
            continue;
        }
        // Installing the host's key makes the engine DISCARD the address table
        // it built from its own (PWNDA-PATCH-3). Anything already deposited to
        // that wallet would stop being watched, so refuse rather than strand
        // it — and fail closed when the balance cannot be read.
        //
        // ...but ONLY for a wallet that is still the engine's own.
        //
        // `Adoption::AccountKey` is VERIFIED state, not intent: the engine was
        // confirmed to have built this coin's wallet from THIS host's account
        // key. The address table a re-push discards is therefore rebuilt from
        // the same key, to the same addresses, and the balance being "stranded"
        // is already in the user's own wallet. There is nothing left for the
        // gate to protect.
        //
        // The seed guard above is what makes "the same key" a fact rather than
        // a hope: a session whose seed differs from the datadir's is refused
        // before this loop starts, so a push that reaches here is by the same
        // wallet that did the adopting.
        //
        // Why this had to change (2026-09-08): a share pass runs on every node
        // start, for every coin set to share, INCLUDING ones already adopted --
        // and it must, because PWNDA-PATCH-3 needs the key again to build the
        // wallet after a restart. So on a node where BTC, LTC and BCH were all
        // adopted and all held a balance, every start produced three permanent
        // red errors telling the user to "sweep it back first". They could not:
        // the sweep-back list excludes adopted coins ON PURPOSE ("the balance
        // is already in the user's wallet, and the sweep would pay a fee to
        // send coins from an address to itself"). Gate said sweep first, sweep
        // list said nothing to sweep, and the user was left with an
        // unclearable error about their own money. The operator's LTC row was
        // 3.65468546 -- the payout from the swap that had settled an hour
        // earlier, into the wallet this gate was calling unwatchable.
        let gate_applies = entry.map(|e| balance_gate_applies(&e.adoption)).unwrap_or(true);
        if gate_applies {
            let existing = crate::swap_bridge::wallet_balance(port, &auth, &ticker)
                .await
                .ok();
            // Only asked when the balance could not be read, because that is
            // the only case where it changes the answer: a coin with no
            // addresses has nothing to strand, and PWNDA-PATCH-3 guarantees
            // the engine cannot have built it a wallet behind our back.
            // Without this the gate was unpassable for a coin's FIRST push —
            // BCH read `NaN` for a day (2026-09-05) because "no wallet yet"
            // and "node not responding" were the same input.
            let addresses = if existing.is_none() {
                crate::swap_bridge::wallet_address_count(port, &auth, &ticker)
                    .await
                    .ok()
            } else {
                None
            };
            if let Err(reason) =
                crate::swap_bridge::pre_share_balance_gate(existing.as_deref(), addresses)
            {
                outcomes.push(AccountKeyOutcome {
                    ticker,
                    initialized: false,
                    shared: false,
                    error: Some(reason),
                });
                continue;
            }
        }
        match push_account_key(port, &auth, &ticker, &k.account_key, &k.address_type).await {
            Err(e) => outcomes.push(AccountKeyOutcome {
                ticker,
                initialized: false,
                shared: false,
                error: Some(e),
            }),
            Ok((initialized, addr)) => {
                match account_key_mismatch(&ticker, addr.as_deref(), &k.expected_address) {
                    Some(reason) => {
                        // Loud, and it stays loud: this is the failure the
                        // whole mechanism is built to make impossible.
                        eprintln!("[swap-sidecar] {}", reason);
                        outcomes.push(AccountKeyOutcome {
                            ticker,
                            initialized,
                            shared: false,
                            error: Some(reason),
                        });
                    }
                    None => {
                        if initialized {
                            adopted.push(ticker.clone());
                        }
                        outcomes.push(AccountKeyOutcome {
                            ticker,
                            initialized,
                            shared: true,
                            error: None,
                        });
                    }
                }
            }
        }
    }

    // Record only what actually stood up and matched. Best-effort: a failed
    // preference write must not turn a working push into an error.
    if !adopted.is_empty() {
        let mut rec = read_optin(&app);
        let mut changed = false;
        for ticker in &adopted {
            if let Some(coin) = coin_key_from(ticker) {
                if let Some(entry) = rec.coins.get_mut(coin) {
                    if entry.adoption != Adoption::AccountKey {
                        entry.adoption = Adoption::AccountKey;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            if let Err(e) = write_optin(&app, &rec) {
                eprintln!(
                    "[swap-sidecar] could not record account-key adoption: {}",
                    e
                );
            }
        }
    }
    Ok(outcomes)
}

/// Coins the user has enabled that the swap node has not been set up for.
///
/// Pure so the "is there anything to do" question is answerable without a
/// node: `enabled` is intent, `configured` is fact, and the gap between them
/// is what an `--addcoin` run exists to close.
pub fn pending_coins(enabled: &[String], configured: &[String]) -> Vec<String> {
    enabled
        .iter()
        .filter(|c| {
            *c != MANDATORY_COIN && !configured.iter().any(|k| k.eq_ignore_ascii_case(c))
        })
        .cloned()
        .collect()
}

/// May the node be restarted right now to add coins?
///
/// `None` = go. `Some(reason)` = refuse, with the reason to show.
///
/// The restart is the point: `--addcoin` starts its own particld to seed the
/// new coin's wallet, and a running node already holds that port — which is
/// the "Mismatched pid" failure this project chased for a day. So adding a
/// coin genuinely requires a stop/start, and the only question is whether the
/// app performs it or asks the user to.
///
/// It refuses on ANY live bid. A restart mid-swap drops the process that is
/// watching timelocks, and no coin is worth that.
pub fn may_restart_for_coins(
    has_key: bool,
    pending: usize,
    active_bids: usize,
) -> Option<String> {
    if pending == 0 {
        return Some("every enabled coin is already set up".to_string());
    }
    if !has_key {
        return Some(
            "the vault must be unlocked so the swap wallets can be opened".to_string(),
        );
    }
    if active_bids > 0 {
        return Some(format!(
            "{} swap(s) are in flight — adding coins restarts the node, which \
             would interrupt them. Try again once they settle.",
            active_bids
        ));
    }
    None
}

/// Add every enabled-but-unconfigured coin, restarting the node to do it.
///
/// Ask #1, 2026-08-20: "make BTC and LTC appear without me stopping and
/// starting the node". The restart cannot be removed — see
/// [`may_restart_for_coins`] — so it is performed here instead of being
/// homework. The key survives because this stops and starts within one call,
/// re-pushing it in between (`stop_node_core` deliberately clears it).
#[tauri::command]
pub async fn swap_sidecar_apply_pending_coins(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
) -> Result<Vec<String>, String> {
    if !read_optin(&app).opted_in {
        return Err("the swap node has not been enabled".to_string());
    }
    let (running, port, pwd) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (guard.phase.is_running(), guard.html_port, guard.wallet_pwd.clone())
    };

    let rec = read_optin(&app);
    let enabled = enabled_coins(&rec);
    let dd = datadir(&app)?;
    let configured = std::fs::read(dd.join("basicswap.json"))
        .ok()
        .and_then(|raw| strip_bom(&raw).ok().map(|s| s.to_string()))
        .and_then(|c| read_configured_coins(&c).ok())
        .unwrap_or_default();
    let pending = pending_coins(&enabled, &configured);

    // Live-swap check only matters if the node is up to be asked.
    // FAIL CLOSED on an unreadable bid list: an unreachable node cannot prove
    // it has nothing in flight, and this restarts the process that watches
    // timelocks. Same rule as `decide_gate`.
    let bids = if running {
        match active_bids_total(&state).await {
            Ok(n) => n,
            Err(e) => {
                return Err(format!(
                    "could not check for in-flight swaps, so the node was not                      restarted: {}",
                    e
                ))
            }
        }
    } else {
        0
    };
    let _ = port;
    if let Some(why) = may_restart_for_coins(pwd.is_some(), pending.len(), bids) {
        return Err(why);
    }

    eprintln!(
        "[swap-sidecar] adding {:?} — restarting the node (an addcoin needs the \
         coin daemons stopped)",
        pending
    );
    if running {
        swap_sidecar_stop(app.clone(), state.clone()).await?;
    }
    // `stop_node_core` clears the key ("the wallet key lives for exactly one
    // session"), so it has to be handed back before the start that needs it —
    // otherwise the addcoins defer for exactly the reason this command exists
    // to fix.
    {
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.wallet_pwd = pwd;
    }
    swap_sidecar_start(app.clone(), state.clone(), None, None, None, None, None).await?;

    let after = std::fs::read(datadir(&app)?.join("basicswap.json"))
        .ok()
        .and_then(|raw| strip_bom(&raw).ok().map(|s| s.to_string()))
        .and_then(|c| read_configured_coins(&c).ok())
        .unwrap_or_default();
    let added: Vec<String> = pending
        .into_iter()
        .filter(|c| after.iter().any(|k| k.eq_ignore_ascii_case(c)))
        .collect();
    Ok(added)
}

/// One coin's chain-sync progress, read straight from its daemon.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChainSync {
    /// Engine coin name, lowercase (`"particl"`).
    pub coin: String,
    /// UPPERCASE ticker (`"PART"`), the key pwnda's UI joins on.
    pub ticker: String,
    pub blocks: u64,
    pub headers: u64,
    /// Percent, `100 * verificationprogress`. Reported ALONGSIDE height, never
    /// alone: a chain with no blocks reports 100% verified.
    pub verified_pct: f64,
    /// This coin's own failure, isolated — one busy daemon must not blank the
    /// others.
    pub error: Option<String>,
}

/// Per-coin chain progress, read DIRECTLY from each managed daemon.
///
/// # Why not `/json/wallets`
///
/// That endpoint aggregates wallet + blockchain info across every coin under
/// one server-side timeout, and under IBD load it returns `error: Timeout`
/// for ALL of them (measured 2026-08-20: 10.0s, every coin timed out) — so the
/// sync UI it fed rendered nothing exactly when a user most wants to see
/// progress. A daemon's own `getblockchaininfo` is a local read that answers
/// in milliseconds even mid-sync.
///
/// Only bitcoin-family daemons WE manage on loopback are asked. A remote
/// Monero node is someone else's socket, and a light/electrum coin has no
/// daemon — both correctly absent here, which is also the honest answer to
/// "why is XMR not in this list": it has no local chain to sync.
#[tauri::command]
pub async fn swap_sidecar_chain_sync(
    app: AppHandle,
    _state: tauri::State<'_, SwapSidecarState>,
) -> Result<Vec<ChainSync>, String> {
    if !read_optin(&app).opted_in {
        return Ok(Vec::new());
    }
    let dd = datadir(&app)?;
    let Some(text) = std::fs::read(dd.join("basicswap.json"))
        .ok()
        .and_then(|raw| strip_bom(&raw).ok().map(|s| s.to_string()))
    else {
        return Ok(Vec::new());
    };
    let targets = parse_chain_daemon_targets(&text)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;

    // Query the daemons concurrently: one slow node must not serialise behind
    // the others, and a getblockchaininfo is cheap.
    let futures = targets
        .into_iter()
        .filter(|t| {
            matches!(t.kind, DaemonKind::BitcoinRpc) && is_loopback(&t.host)
        })
        .map(|t| {
            let client = client.clone();
            async move { chain_sync_one(&client, &t).await }
        });
    let rows = futures_util::future::join_all(futures).await;
    Ok(rows.into_iter().flatten().collect())
}

/// `getblockchaininfo` for one target, mapped to a [`ChainSync`] row. Returns
/// `None` only when the target has no usable auth — an RPC failure becomes a
/// row with `error` set, so a busy daemon still shows up in the UI as "syncing,
/// momentarily unreachable" rather than vanishing.
async fn chain_sync_one(client: &reqwest::Client, t: &DaemonTarget) -> Option<ChainSync> {
    let auth = match (t.user.as_ref(), t.password.as_ref()) {
        (Some(u), Some(p)) => Some((u.clone(), p.clone())),
        _ => t.chain_datadir.as_deref().and_then(cookie_auth),
    };
    let ep = crate::swap_daemon::DaemonEndpoint {
        url: format!("http://{}:{}", t.host, t.port),
        auth,
    };
    let ticker = ticker_for(&t.coin);
    match crate::swap_daemon::daemon_rpc_guarded(
        client,
        &ep,
        crate::swap_daemon::DAEMON_METHODS,
        "getblockchaininfo",
        serde_json::json!([]),
    )
    .await
    {
        Ok(v) => Some(ChainSync {
            coin: t.coin.clone(),
            ticker,
            blocks: v.get("blocks").and_then(|x| x.as_u64()).unwrap_or(0),
            headers: v.get("headers").and_then(|x| x.as_u64()).unwrap_or(0),
            verified_pct: v
                .get("verificationprogress")
                .and_then(|x| x.as_f64())
                .map(|p| p * 100.0)
                .unwrap_or(0.0),
            error: None,
        }),
        Err(e) => Some(ChainSync {
            coin: t.coin.clone(),
            ticker,
            blocks: 0,
            headers: 0,
            verified_pct: 0.0,
            error: Some(e.to_string()),
        }),
    }
}

/// The two prechecks for an on-demand unlock, pure so they are testable.
///
/// Order matters for the message: "not running" first — an unlock against a
/// stopped node is not a key problem, and "no key" would send the user to
/// re-unlock a vault that is not the issue.
pub fn unlock_wallets_precheck(running: bool, has_key: bool) -> Result<(), String> {
    if !running {
        return Err(
            "the swap node is not running — start it from Settings first".to_string(),
        );
    }
    if !has_key {
        return Err(
            "no wallet key in this session — the vault must be unlocked, then try again"
                .to_string(),
        );
    }
    Ok(())
}

/// Unlock the RUNNING swap node's wallets with the key this session holds.
///
/// # Why this exists as its own command
///
/// The engine's wallets are C5-encrypted with a key DERIVED from the vault —
/// deliberately never shown to the user, so the web UI's "Unlock BasicSwap"
/// page is a door no user-typed string should ever open (observed 2026-08-20:
/// the user pasted the CONSOLE password there — the right credential for the
/// wrong lock — and read "Invalid password" as auth being broken).
///
/// The keyed START already unlocks via `unlock_if_configured`, but autostart
/// is always keyless, so an autostarted node sits locked ("System is locked"
/// every 10s in the engine log) and the only remedy was a full stop/start.
/// This command is the missing half: push the key, unlock in place.
///
/// Idempotent in practice: upstream's `unlockwallets` re-arms per-coin
/// unlock timeouts, so unlocking an unlocked node succeeds.
#[tauri::command]
pub async fn swap_sidecar_unlock_wallets(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
) -> Result<(), String> {
    if !read_optin(&app).opted_in {
        return Err("the swap node has not been enabled".to_string());
    }
    let (running, port, pwd) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (guard.phase.is_running(), guard.html_port, guard.wallet_pwd.clone())
    };
    unlock_wallets_precheck(running, pwd.is_some())?;
    let pwd = pwd.expect("precheck guarantees the key");
    let password = read_or_create_auth_password(&app)?;
    unlock_wallets(port, &password, pwd.expose()).await
}

/// The refusals a rotation must clear, as a pure function so the precedence is
/// testable without an `AppHandle`, a `State` or a socket - the same idiom as
/// [`check_first_prepare_gate`].
///
/// Order is deliberate. Consent is checked **first**: a subsystem the user
/// never enabled must not answer questions about its phase, and "not opted in"
/// is the more accurate diagnosis than "not running" for an install that has no
/// swap node at all.
///
/// See [`rotate_wallet_password`] for why the *key* is not one of these
/// arguments.
pub(crate) fn check_rotation_gate(
    opted_in: bool,
    phase: &Phase,
    holds_current_key: bool,
) -> Result<(), String> {
    if !opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled - accept the setup screen first"
                .to_string(),
        );
    }
    if !matches!(phase, Phase::Healthy) {
        return Err("the swap node is not running".to_string());
    }
    if !holds_current_key {
        return Err("no wallet key is set for this session".to_string());
    }
    Ok(())
}

/// C5 - change the engine's wallet-encryption password on a RUNNING node.
///
/// # F4 - why this is NOT a `#[tauri::command]`
///
/// It used to be one, registered in `lib.rs`, taking `new_key: String` straight
/// off the IPC boundary with no opt-in check, no confirmation and no test. That
/// handed the renderer the effect of `setpassword` - an endpoint that is on
/// [`DENIED_ENDPOINTS`] precisely so the renderer cannot reach it. After C3.5
/// the node's `wallet.dat` holds the user's **account xprv**, protected by
/// nothing but this password, so a compromised renderer could have rotated it
/// to an attacker-chosen value: durable key escrow over pre-existing funds, and
/// a lockout of the honest wallet, from one invoke.
///
/// The obvious repair - "keep the command, derive the key backend-side" - does
/// not exist. Each candidate was considered and each fails:
///
/// * **Derive it from the vault mnemonic, in Rust.** The backend has never seen
///   a mnemonic and must not start: the point of `src/lib/swapWalletKey.ts`
///   (contract D3) is that only the renderer touches the phrase and Rust only
///   ever receives the already-derived key. Moving the phrase into Rust to fix
///   a renderer-trust problem trades a bigger secret for a smaller one.
/// * **Derive the new key from the OLD key we already hold.** Security theatre.
///   `swapWalletKey.ts`'s own threat model says to assume the wallet key *will*
///   be observed - it rides `WALLET_ENCRYPTION_PWD` in a networked Python
///   process's environment and is stretched into a Core `wallet.dat`. Anyone
///   who saw the old key can compute any deterministic function of it, so a
///   rotation an observer can predict rotates nothing against the only
///   adversary a rotation is for.
/// * **Generate a random key backend-side.** It would have to be persisted to
///   survive a restart, and this is the one secret in the subsystem that
///   deliberately never touches disk ([`SwapSidecarInner::wallet_pwd`]).
///   Writing it out is strictly worse than the vulnerability being fixed.
///
/// So the only correct source of a new key is the vault phrase, which lives on
/// the renderer side by construction - which is exactly the parameter that made
/// the command dangerous. No guard makes "the renderer names the new wallet
/// password" safe, so the command is **removed from the invoke handler** rather
/// than guarded, and the capability survives only as this crate-private helper.
///
/// Note the asymmetry with [`swap_sidecar_set_wallet_key`], which does still
/// take a caller-supplied key: that one only populates the **session** value
/// used to encrypt-at-prepare and unlock-after-health. A renderer that sets a
/// wrong one gets a failed unlock and a node that ends at [`Phase::Failed`]
/// (R6) - a denial of service against a wallet whose on-disk password is
/// unchanged. Rotation mutates *persistent* state on a wallet that already
/// holds value. Same shape of argument, different blast radius.
///
/// # Re-exposing it
///
/// `new_key: Secret` is load-bearing rather than cosmetic - but the compiler
/// catches it one step later than is obvious, and the difference matters to
/// anyone relying on it.
///
/// **Measured, not assumed** (2026-08-19). Adding `#[tauri::command]` to this
/// function *compiles cleanly*: the attribute only emits the wrapper module and
/// checks nothing about the parameters. The `Deserialize` bound is imposed at
/// the **registration** site, so the build breaks only once the name is also
/// added to `tauri::generate_handler![...]` in `lib.rs`:
///
/// ```text
/// error[E0277]: the trait bound `swap_sidecar::Secret:
///   CommandArg<'_, tauri_runtime_wry::Wry<EventLoopMessage>>` is not satisfied
///   = help: the trait `Deserialize<'_>` is not implemented for `swap_sidecar::Secret`
/// ```
///
/// So [`Secret`] makes the *reachable* mistake - attribute plus registration -
/// a compile error, which is the mistake that matters. It does not make the
/// half-step a compile error, which is why
/// `rotate_key_cannot_come_from_the_webview` asserts on the attribute itself
/// instead of trusting the compiler for both halves.
///
/// A future key-scheme migration (v1 -> v2) that genuinely needs this must gate
/// on a fresh vault unlock in its own purpose-built command and wrap the
/// derived key before calling here - it must not restore this function's
/// registration.
///
/// # The call itself
///
/// `POST /json/setpassword` with `{oldpassword, newpassword}`
/// (`js_server.py:1460-1481` -> `changeWalletPasswords`). Requires a healthy
/// node and a key already in memory, because upstream needs the OLD password
/// and there is nowhere else it could come from - we never persist it.
///
/// The stored key is replaced **only after** the engine confirms, so a failed
/// rotation leaves us still holding the password that does unlock the wallets.
/// The reverse order would lock us out of a node that is running fine.
// Unused in the shipped build by design - see "Re-exposing it" above. Kept
// rather than deleted because it is the only place the setpassword wire shape
// and the confirm-before-replace ordering are written down, and both are easy
// to get wrong from scratch.
#[allow(dead_code)]
pub(crate) async fn rotate_wallet_password(
    app: &AppHandle,
    state: &SwapSidecarState,
    new_key: Secret,
) -> Result<(), String> {
    if new_key.expose().trim().is_empty() {
        return Err("the new swap wallet key cannot be empty".to_string());
    }
    let (port, auth, old_key) = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        check_rotation_gate(
            read_optin(app).opted_in,
            &guard.phase,
            guard.wallet_pwd.is_some(),
        )?;
        let auth = guard
            .auth_password
            .clone()
            .ok_or_else(|| "no session credential".to_string())?;
        let old = guard
            .wallet_pwd
            .clone()
            .ok_or_else(|| "no wallet key is set for this session".to_string())?;
        (guard.html_port, auth, old)
    };
    let body = serde_json::json!({
        "oldpassword": old_key.expose(),
        "newpassword": new_key.expose(),
    });
    let v = privileged_post(port, &auth, "setpassword", body).await?;
    if let Some(err) = v.get("error") {
        return Err(format!("the swap node refused the change: {}", err));
    }
    let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    guard.wallet_pwd = Some(new_key);
    Ok(())
}

/// Narrow read proxy over the node's JSON API.
///
/// Auth is injected here; the webview never holds the credential. The path is
/// pinned under `/json/` and run through the allow-list ([`check_endpoint`]),
/// so no caller — including a compromised renderer — can reach `getcoinseed`,
/// `setpassword`, `unlock`, `lock`, `wallets/<coin>/withdraw`, the HTML pages,
/// or `/shutdown/<token>`.
#[tauri::command]
pub async fn swap_sidecar_api_get(
    state: tauri::State<'_, SwapSidecarState>,
    path: String,
    query: Option<String>,
) -> Result<serde_json::Value, String> {
    let (port, password) = api_context(&state)?;
    let mut url = build_api_url(port, &path, ApiMethod::Get)?;
    if let Some(q) = query {
        let q = q.trim_start_matches('?');
        if !q.is_empty() {
            url.push('?');
            url.push_str(q);
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", basic_auth_header(&password))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    decode_api_response(resp).await
}

/// Narrow POST proxy. Same auth injection, same path pinning, same allow-list
/// — but evaluated for `POST`, which is a **strictly different** verdict: the
/// endpoints upstream turns into writers when a body is present (`bids/<id>`
/// with `accept`, anything under `wallets/<coin>/…`) are not reachable here.
/// POST is permitted only where upstream uses the body to carry read filters
/// or a pure computation's inputs.
#[tauri::command]
pub async fn swap_sidecar_api_post(
    state: tauri::State<'_, SwapSidecarState>,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (port, password) = api_context(&state)?;
    let url = build_api_url(port, &path, ApiMethod::Post)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", basic_auth_header(&password))
        // Deliberately NO Origin/Referer header. Upstream's CSRF defence is
        // verify-WHEN-PRESENT (http_server.py:342-357): a header-less client
        // is not a browser and is allowed, while a header that IS present is
        // matched exactly against `html_port` (util/network.py:118-125). Since
        // we are not a browser, sending one would only add a way to fail — if
        // our port bookkeeping ever drifted from the server's own `port_no`,
        // every POST would 403. Omitting it is upstream's documented API path.
        .json(&body.unwrap_or(serde_json::Value::Null))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    decode_api_response(resp).await
}

/// The supervisor's current phase, copied out under the lock.
///
/// Exists for [`crate::swap_daemon`]: a daemon-direct send must refuse unless
/// the engine is actually up, because the whole safety argument for routing
/// through the engine's own daemon wallet is that the engine is the thing
/// holding the `lockunspent` reservations we are trying to honour. A send
/// issued while the node is down honours nothing.
///
/// Deliberately narrower than [`api_context`], which also hands out the API
/// session credential — daemon-direct routing never touches the engine's HTTP
/// API, so it must not be able to reach that password.
pub(crate) fn phase_snapshot(
    state: &tauri::State<'_, SwapSidecarState>,
) -> Result<Phase, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(guard.phase.clone())
}

/// Does this session hold a C5 wallet-encryption key? (R10)
///
/// Deliberately returns a **bool**, not the key. C3.5's encryption gate needs
/// to know that a key exists; it has no use for its value, and a getter that
/// handed the value out would put the one secret in this subsystem that never
/// touches disk into a second module's stack frames for no gain.
///
/// Narrower than [`api_context`] for the same reason that one is narrower than
/// a raw lock: each caller gets exactly the fact it needs.
pub(crate) fn wallet_key_is_set(
    state: &tauri::State<'_, SwapSidecarState>,
) -> Result<bool, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(guard.wallet_pwd.is_some())
}

pub(crate) fn api_context(
    state: &tauri::State<'_, SwapSidecarState>,
) -> Result<(u16, String), String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    if !matches!(guard.phase, Phase::Healthy) {
        return Err("the swap node is not running".to_string());
    }
    let pwd = guard
        .auth_password
        .clone()
        .ok_or_else(|| "no session credential".to_string())?;
    Ok((guard.html_port, pwd))
}

pub(crate) async fn decode_api_response(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("could not read the swap node's reply: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(format!("swap node HTTP {}: {}", status, snippet(&text)));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("swap node reply was not JSON: {} — {}", e, snippet(&text)))
}

/// Guarded phase write. Rejects transitions the state machine forbids so an
/// illegal sequence fails loudly here instead of producing an impossible
/// status downstream.
fn set_phase(
    state: &tauri::State<'_, SwapSidecarState>,
    next: Phase,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    if !guard.phase.can_transition_to(&next) {
        return Err(format!(
            "illegal sidecar transition {:?} -> {:?}",
            guard.phase, next
        ));
    }
    guard.phase = next;
    Ok(())
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    // ── python_exe layout, both platforms from one host ────────────────
    //
    // Found 2026-08-29 wiring the Linux Grove bundle: this returned
    // `runtime/python` unconditionally, correct for Windows (flat
    // `install_only` archive) and silently wrong for Linux, where
    // `python-build-standalone`'s POSIX layout puts the interpreter at
    // `runtime/bin/python` — a real symlink the archive ships, confirmed
    // against the staged `.swap-sidecar-work/linux-runtime/bin/`. Every
    // caller would have failed at first use on a real Linux install, in a way
    // `check-bundle-payloads.mjs` cannot catch (that gate verifies the `.enc`
    // archive's own integrity, not that Rust agrees with what is inside it).

    #[test]
    fn python_exe_is_flat_on_windows() {
        let got = python_exe_under(std::path::Path::new(r"C:\app\swap-sidecar\runtime"), true);
        assert_eq!(got, PathBuf::from(r"C:\app\swap-sidecar\runtime\python.exe"));
    }

    #[test]
    fn python_exe_is_under_bin_on_posix() {
        // Not runtime/python — that path does not exist in a real
        // python-build-standalone Linux archive, only runtime/bin/python does.
        let got = python_exe_under(std::path::Path::new("/app/swap-sidecar/runtime"), false);
        assert_eq!(got, PathBuf::from("/app/swap-sidecar/runtime/bin/python"));
    }

    fn test_config() -> SidecarConfig {
        SidecarConfig {
            archival_chain: false,
            python: PathBuf::from(r"C:\app\swap-sidecar\runtime\python.exe"),
            datadir: PathBuf::from(r"C:\app\swap-sidecar\datadir"),
            bin_dir: PathBuf::from(r"C:\app\swap-sidecar\bin"),
            network: Network::Mainnet,
            wallet_encrypted: false,
            adoption_coins: Vec::new(),
            coins: vec![
                "particl".to_string(),
                "litecoin".to_string(),
                "monero".to_string(),
            ],
            lean_coins: vec!["litecoin".to_string()],
            client_auth_password: "s3cr3t".to_string(),
            html_base_port: DEFAULT_HTML_PORT,
            ws_base_port: DEFAULT_WS_PORT,
            port_offset: 0,
            xmr_rpc_host: Some("node.example.org".to_string()),
            xmr_rpc_port: Some(18089),
            xmr_host_wallet: None,
            zph_host_wallet: None,
            zano_host_wallet: None,
            trust_remote_node: true,
            enabled_coins: vec![
                "particl".to_string(),
                "litecoin".to_string(),
                "monero".to_string(),
            ],
            particl_mnemonic: None,
            wallet_encryption_pwd: None,
        }
    }

    // ── config / argv generation ────────────────────────────────────

    /// Prepare must be invoked as a MODULE (`-m basicswap.bin.prepare`), never
    /// via the `basicswap-prepare` console-script shim, and must carry every
    /// flag the pinned upstream parses (prepare.py:1250-1388).
    #[test]
    fn prepare_plan_uses_module_invocation_and_pinned_flags() {
        let cfg = test_config();
        let plan = build_prepare_plan(&cfg);

        assert_eq!(plan.program, r"C:\app\swap-sidecar\runtime\python.exe");
        assert_eq!(plan.args[0], "-s");
        assert_eq!(plan.args[1], "-E");
        assert_eq!(plan.args[2], "-m");
        assert_eq!(plan.args[3], "basicswap.bin.prepare");
        assert!(
            !plan.args.iter().any(|a| a.contains("basicswap-prepare")),
            "must not use the console-script shim: {:?}",
            plan.args
        );

        assert!(plan.has_arg(r"--datadir=C:\app\swap-sidecar\datadir"));
        assert!(plan.has_arg("--mainnet"));
        assert!(plan.has_arg("--withcoins=particl,litecoin,monero"));
        assert!(plan.has_arg("--nocores"));
        assert!(plan.has_arg(r"--bindir=C:\app\swap-sidecar\bin"));
        assert!(plan.has_arg("--ltc-mode=electrum"));
        assert!(plan.has_arg("--client-auth-password=s3cr3t"));
        assert!(plan.has_arg("--trustremotenode"));
        assert!(plan.has_arg("--portoffset=0"));
        // SimpleX must stay absent by default — never pass --addnetwork.
        assert!(
            !plan.args.iter().any(|a| a.starts_with("--addnetwork")),
            "--addnetwork must not be passed: {:?}",
            plan.args
        );
    }

    /// The terminate asymmetry — the safety-critical half of the fix.
    ///
    /// A wallet SERVER may be terminated when it will not stop gracefully: the
    /// swap node's Monero wallet is derived from the vault seed, so the worst
    /// case is a regenerable cache file, and the alternative is a node that
    /// can never start (observed: port 29998 held, two failed starts).
    ///
    /// A chain DATABASE may NOT. A hard kill mid-write is the
    /// chainstate-corruption path, and recovery is re-syncing millions of
    /// blocks — strictly worse than a failed start, which is retryable in
    /// seconds. If this ever flips, a wedged particld becomes a corrupt
    /// particld.
    #[test]
    fn terminate_is_allowed_for_a_wallet_server_only() {
        assert!(
            may_terminate_after_failed_stop(&DaemonKind::MoneroWalletRpc),
            "a wallet-rpc that will not stop must not veto the whole node"
        );
        assert!(
            !may_terminate_after_failed_stop(&DaemonKind::BitcoinRpc),
            "killing a bitcoin-family daemon risks the chainstate"
        );
        assert!(
            !may_terminate_after_failed_stop(&DaemonKind::MoneroDaemon),
            "monerod owns a chain database too"
        );
    }

    /// The rule must not depend on WHY the stop failed. That dependency is
    /// exactly what shipped broken: gating on -13 meant a timeout escalated to
    /// nothing, and the port stayed held forever.
    #[test]
    fn terminate_does_not_depend_on_the_failure_reason() {
        for reason in [
            "monero-wallet stop_wallet failed: RPC error -13: No wallet file",
            "monero-wallet stop_wallet failed: RPC timed out after 10s",
            "connection refused",
            "",
        ] {
            // The classifier may disagree about the flavour...
            let _ = wallet_rpc_stop_is_walletless(reason);
            // ...but the decision to escalate is the daemon's KIND alone.
            assert!(may_terminate_after_failed_stop(&DaemonKind::MoneroWalletRpc));
        }
    }

    // -- adding coins without the user restarting -----------------------

    /// `enabled` is intent, `configured` is fact; the gap is the work.
    #[test]
    fn pending_coins_is_intent_minus_fact() {
        let enabled = vec![
            "particl".to_string(),
            "bitcoin".to_string(),
            "litecoin".to_string(),
            "monero".to_string(),
        ];
        // The user's actual install: 4 enabled, 2 in basicswap.json.
        let configured = vec!["particl".to_string(), "monero".to_string()];
        assert_eq!(
            pending_coins(&enabled, &configured),
            vec!["bitcoin".to_string(), "litecoin".to_string()]
        );

        // particl is never "pending": it is the mandatory transport and is
        // configured by the first prepare, never by an --addcoin.
        assert!(pending_coins(&["particl".to_string()], &[]).is_empty());

        // The config's spelling is upstream's; matching must not be
        // case-sensitive or a configured coin reads as pending forever and
        // the node restarts on every launch to "add" what it already has.
        assert!(pending_coins(
            &["bitcoin".to_string()],
            &["Bitcoin".to_string()]
        )
        .is_empty());

        assert!(pending_coins(&[], &[]).is_empty());
    }

    /// The restart guard. A node restart drops the process watching swap
    /// timelocks, so no coin is worth taking it while a bid is live.
    #[test]
    fn coin_restart_refuses_while_swaps_are_in_flight() {
        // Clear to go.
        assert_eq!(may_restart_for_coins(true, 2, 0), None);

        // A live bid outranks everything, and the message says why rather
        // than just refusing.
        let why = may_restart_for_coins(true, 2, 1).expect("must refuse");
        assert!(why.contains("in flight"), "{why}");
        assert!(why.contains("restart"), "the reason must be stated: {why}");

        // No key: the addcoin would defer anyway, so restarting would cost a
        // node cycle and change nothing.
        let why = may_restart_for_coins(false, 2, 0).expect("must refuse");
        assert!(why.contains("unlocked"), "{why}");

        // Nothing to do is a refusal too — this is the COMMON case on every
        // launch after the coins settle, and the automatic caller must be
        // able to tell it apart from a failure.
        let why = may_restart_for_coins(true, 0, 0).expect("must refuse");
        assert!(why.contains("already set up"), "{why}");

        // Precedence: nothing-to-do beats every other reason, so a healthy
        // install never reports "swaps in flight" as the thing stopping it.
        let why = may_restart_for_coins(false, 0, 3).expect("must refuse");
        assert!(why.contains("already set up"), "{why}");
    }

    /// Candidate ORDER is the whole feature: it encodes preference, and a
    /// redundancy list that reorders itself is one that ignores the user.
    #[test]
    fn xmr_candidates_are_ordered_pin_then_recent_and_deduped() {
        let store = r#"{
            "xmr_selected_node": "http://pinned.example.org:18081",
            "xmr_last_active_node": "http://active.example.org:18089",
            "xmr_recent_nodes": [
                "http://active.example.org:18089",
                "http://second.example.org:18089",
                "http://pinned.example.org:18081",
                "http://third.example.org:18089"
            ]
        }"#;
        let got = xmr_node_candidates_from_store_json(store);
        assert_eq!(
            got,
            vec![
                ("pinned.example.org".to_string(), 18081),
                ("active.example.org".to_string(), 18089),
                ("second.example.org".to_string(), 18089),
                ("third.example.org".to_string(), 18089),
            ],
            "explicit pin leads, then last-active, then the pool — each once"
        );
    }

    /// `""` is the store's spelling of AUTO. It must not become a candidate,
    /// and it must not stop the rest of the list being read.
    #[test]
    fn xmr_candidates_skip_auto_and_survive_junk() {
        let auto = r#"{"xmr_selected_node":"",
                       "xmr_recent_nodes":["http://a.example.org:18089"]}"#;
        assert_eq!(
            xmr_node_candidates_from_store_json(auto),
            vec![("a.example.org".to_string(), 18089)]
        );

        // A hand-edited or half-written store must not panic the start path.
        let junk = r#"{"xmr_recent_nodes":["", "not a url", 42, null,
                       "http://ok.example.org:18089"]}"#;
        assert_eq!(
            xmr_node_candidates_from_store_json(junk),
            vec![("ok.example.org".to_string(), 18089)]
        );
        assert!(xmr_node_candidates_from_store_json("not json").is_empty());
        assert!(xmr_node_candidates_from_store_json("{}").is_empty());
    }

    /// No candidates and ALL candidates dead are different states, and the
    /// start path must not conflate them: an empty list is a fresh install,
    /// while a dead list is an outage — and switching to a local monerod on
    /// an outage is an ~80 GB decision taken on a network blip.
    #[tokio::test]
    async fn every_candidate_dead_is_none_not_a_silent_local_daemon() {
        // Port 1 on loopback: nothing can be listening (privileged, unused).
        let dead = vec![("127.0.0.1".to_string(), 1u16)];
        assert_eq!(pick_healthy_xmr_node(&dead).await, None);
        assert_eq!(pick_healthy_xmr_node(&[]).await, None);
    }

    /// The ZMQ gap: a stopped particld holds TWO loopback ports, and waiting
    /// on only the RPC one let the next start collide with the publisher
    /// (`particl zmq port 20792 ... already in use`, 2026-08-20 13:00).
    #[test]
    fn a_swept_coin_waits_on_every_port_it_binds() {
        let cfg = r#"{
            "zmqport": 20792,
            "chainclients": {
                "particl":  {"connection_type":"rpc","manage_daemon":true,
                             "rpchost":"127.0.0.1","rpcport":19792},
                "litecoin": {"connection_type":"rpc","manage_daemon":true,
                             "rpchost":"127.0.0.1","rpcport":19795}
            }
        }"#;
        // We stopped particl, by its RPC port.
        let swept = vec![("particl".to_string(), 19792u16)];
        let ports = ports_a_stopped_daemon_holds(cfg, &swept);
        let nums: Vec<u16> = ports.iter().map(|(_, p)| *p).collect();

        assert!(nums.contains(&19792), "the RPC port must still be waited on");
        assert!(
            nums.contains(&20792),
            "the ZMQ publisher of a stopped particld must be waited on too: {:?}",
            ports
        );
        // A coin we did NOT stop must not be waited on — that was the earlier
        // defect in the other direction, costing a full timeout per orphan.
        assert!(
            !nums.contains(&19795),
            "litecoin was never stopped; waiting on it is pure delay: {:?}",
            ports
        );
    }

    /// The unlock precheck's two refusals, in the order a user can act on.
    ///
    /// "Not running" must win over "no key": an unlock against a stopped node
    /// is not a key problem, and the no-key message would send the user to
    /// re-unlock a vault that was never the issue.
    #[test]
    fn unlock_precheck_orders_its_refusals_actionably() {
        assert!(unlock_wallets_precheck(true, true).is_ok());

        let e = unlock_wallets_precheck(false, true).unwrap_err();
        assert!(e.contains("not running"), "{e}");
        let e = unlock_wallets_precheck(false, false).unwrap_err();
        assert!(
            e.contains("not running"),
            "stopped + keyless must diagnose the node, not the key: {e}"
        );
        let e = unlock_wallets_precheck(true, false).unwrap_err();
        assert!(e.contains("wallet key"), "{e}");
    }

    // -- keyless addcoins against an encrypted wallet -----------------

    /// The truth table behind "why do bitcoin and litecoin never get added".
    ///
    /// `--addcoin` must extract the master key from the Particl wallet; with
    /// C5 encryption and no `WALLET_ENCRYPTION_PWD` it fails after ~2 minutes
    /// of daemon start/stop — per coin, per boot, forever, since reconcile has
    /// no memory. Autostart is ALWAYS keyless (it runs before any unlock), so
    /// without this gate every boot of an encrypted install pays the doomed
    /// runs. Observed live 2026-08-20.
    #[test]
    fn keyless_addcoins_are_deferred_only_when_encryption_is_known() {
        // The one doomed combination.
        assert!(addcoins_are_doomed(true, false));

        // A key in memory makes the run viable — the whole point of the
        // Settings Start button now pushing the key first.
        assert!(!addcoins_are_doomed(true, true));

        // Encryption NOT known (pre-C5 install, or the marker simply never
        // learned): attempt the run. Deferring here would break the
        // unencrypted population, whose addcoins succeed keyless.
        assert!(!addcoins_are_doomed(false, false));
        assert!(!addcoins_are_doomed(false, true));
    }

    /// Classification of the failure tail, on the VERBATIM line from the
    /// user's console — prepare's own announcement, right before it gives up.
    ///
    /// Covers **W-4**: prepare's failures were invisible because its stdio was
    /// `Stdio::null()` and the error path tailed `basicswap.log`, a file
    /// prepare never writes. The tail asserted here only exists because the
    /// supervisor captures prepare's STDOUT instead. Naming the defect id is
    /// what `scripts/swap/check-defect-register.mjs` links against — a fix
    /// whose test does not name it reads as uncovered.
    #[test]
    fn locked_addcoin_failure_is_recognised_from_the_tail() {
        // As captured live (the tail also carries pid-wait noise; the
        // encryption line is the terminal fact).
        let tail = "INFO : Waiting for PART RPC. Trying again in 10 seconds, 2/15.\n\
                    INFO : Particl Wallet is encrypted\n\
                    2026-08-20 11:12:44 INFO : Finalising\n\
                    2026-08-20 11:12:44 INFO : Stopping threads.";
        assert!(addcoin_failed_for_lock(tail));

        // A timeout is a DIFFERENT flavour of unstoppable, and the log line
        // should say so — but it no longer changes whether we escalate.
        assert!(!addcoin_failed_for_lock("Unable to bind RPC port 19792"));
        assert!(!addcoin_failed_for_lock("Mismatched pid"));
        assert!(!addcoin_failed_for_lock(""));
    }

    // -- start serialization + sweep escalation ----------------------

    /// `Preparing` must gate NEW starts even though it is not "running".
    ///
    /// The distinction is the whole bug: `is_running()` correctly excludes
    /// `Preparing` (no HTML server, the console must not open), and the start
    /// guard used exactly that predicate — so the Settings card offered a
    /// clickable Start for the entire reconcile+sweep stretch of an autostart
    /// already in flight, and clicking it ran a SECOND start concurrently:
    /// interleaved sweeps, the config written twice, two run.py spawns
    /// fighting over the same ports (2026-08-20, "nothing to reconcile" twice
    /// in one boot).
    #[test]
    fn preparing_blocks_a_new_start_but_is_not_running() {
        let p = Phase::Preparing;
        assert!(p.blocks_new_start());
        assert!(!p.is_running(), "Preparing must NOT count as running — the \
            console gate and the status `running` field depend on that");

        // The rest of the table: busy phases block, terminal phases do not.
        for busy in [Phase::Starting, Phase::Healthy, Phase::Stopping] {
            assert!(busy.blocks_new_start(), "{busy:?}");
        }
        assert!(!Phase::Stopped.blocks_new_start());
        assert!(
            !Phase::Failed { reason: "x".into() }.blocks_new_start(),
            "a failed node must allow a retry"
        );
    }

    /// The claimed transitions must stay legal, or the atomic claim in
    /// `swap_sidecar_start` writes a phase `set_phase` would have refused —
    /// and `start_node_core`'s own `set_phase(Preparing)` right after must
    /// remain the idempotent self-transition.
    #[test]
    fn the_start_claim_transitions_are_legal() {
        assert!(Phase::Stopped.can_transition_to(&Phase::Preparing));
        assert!(Phase::Failed { reason: "x".into() }.can_transition_to(&Phase::Preparing));
        assert!(Phase::Preparing.can_transition_to(&Phase::Preparing));
        // The abandoned-claim guard's write:
        assert!(Phase::Preparing.can_transition_to(&Phase::Failed { reason: "x".into() }));
    }

    /// The -13 classifier. **No longer the escalation gate** — it only
    /// decides a log line now, because gating on it left a wedged wallet-rpc
    /// (which times out rather than answering -13) holding a port the swap
    /// node needed, and the node could not start at all. See
    /// `terminate_is_allowed_for_a_wallet_server_only`.
    #[test]
    fn walletless_wallet_rpc_error_is_recognised() {
        // The exact string from the user's console, 2026-08-20.
        assert!(wallet_rpc_stop_is_walletless(
            "monero-wallet stop_wallet failed: RPC error -13: No wallet file"
        ));
        // Either spelling alone suffices — a transport rewording of one must
        // not silently disable the escalation.
        assert!(wallet_rpc_stop_is_walletless("No wallet file"));
        assert!(wallet_rpc_stop_is_walletless("RPC error -13"));

        // Failures that do NOT prove the process is walletless. Terminating on
        // these could kill a wallet-rpc with a wallet OPEN mid-write.
        assert!(!wallet_rpc_stop_is_walletless(
            "monero-wallet stop_wallet failed: timed out"
        ));
        assert!(!wallet_rpc_stop_is_walletless("connection refused"));
        assert!(!wallet_rpc_stop_is_walletless(
            "monero-wallet stop_wallet failed: RPC error -1: internal error"
        ));
    }

    /// The sweep's wait list is the SWEPT list — identity, but the identity is
    /// the contract: the first cut iterated every configured target, so two
    /// orphans whose stops had already FAILED cost a full wait each per start
    /// (60s of "Configuring" per attempt, live), waiting for ports that were
    /// never going to free.
    #[test]
    fn sweep_waits_only_on_accepted_stops() {
        let swept = vec![("particl".to_string(), 19792u16)];
        assert_eq!(ports_worth_awaiting(&swept), swept);
        // Nothing accepted a stop -> nothing to wait on. Under the old
        // behaviour this case still waited on every configured port.
        assert!(ports_worth_awaiting(&[]).is_empty());
    }

    // -- the prepare pipe deadlock ----------------------------------

    /// **The regression test for "stuck Configuring forever".**
    ///
    /// Reproduces the real shape: a parent that exits immediately, leaving a
    /// grandchild holding the inherited stdout handle. `Command::output()`
    /// waits for pipe EOF, so it never returns; `output_after_process_exit`
    /// waits for process exit, so it does.
    ///
    /// The **control assertion is the point**. Without it this test would pass
    /// against a reverted fix, because "my function returned" proves nothing
    /// unless `.output()` demonstrably would not have. If the control ever
    /// stops hanging, the harness has stopped reproducing the bug and the
    /// test is worthless — so it fails loudly rather than passing quietly.
    ///
    /// Windows-only because the reproduction uses `cmd.exe`, and because the
    /// deadlock is a Windows console-inheritance problem in the first place.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    #[ignore = "spawns processes; ~15s, almost all of it teardown waiting on \
                the grandchild. Run with `cargo test --lib \
                output_returns_while -- --ignored`. The DEFAULT suite covers \
                the realistic regression via \
                `prepare_family_never_waits_on_pipe_eof`."]
    async fn output_returns_while_a_grandchild_still_holds_the_pipe() {
        use std::time::{Duration, Instant};

        // `start /b` keeps the grandchild attached to the same console and the
        // same stdout handle; `& exit` makes cmd itself leave at once. No
        // redirect on ping — a redirect would hand it a different handle and
        // quietly stop reproducing the bug.
        let spawn_cmd = || {
            let mut c = tokio::process::Command::new("cmd.exe");
            c.args(["/C", "start /b ping -n 3 127.0.0.1 & exit"]);
            c.stdin(std::process::Stdio::null());
            c.stdout(std::process::Stdio::piped());
            c.stderr(std::process::Stdio::piped());
            c
        };

        // A datadir with no basicswap.json: `sweep_prepare_daemons` finds
        // nothing and returns 0, so this measures the pipe behaviour alone
        // rather than the sweep's.
        let dir = std::env::temp_dir().join(format!(
            "pwnda-pipe-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");

        // ---- control: `.output()` must NOT return while the grandchild lives.
        // 1.5s is ample: undeadlocked, `.output()` returns in milliseconds
        // (cmd exits immediately). A longer wait would only make the suite
        // slower without making the control stronger.
        let control = Instant::now();
        let hung =
            tokio::time::timeout(Duration::from_millis(700), spawn_cmd().output()).await;
        assert!(
            hung.is_err(),
            "CONTROL FAILED after {:?}: `.output()` returned, so this test is \
             no longer reproducing the deadlock and proves nothing about the \
             fix. Fix the reproduction before trusting the assertion below.",
            control.elapsed()
        );

        // ---- the fix: returns on PROCESS exit, plus a bounded drain.
        const TEST_DRAIN_MS: u64 = 250;
        let started = Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(10),
            output_after_process_exit_with(spawn_cmd(), &dir, TEST_DRAIN_MS),
        )
        .await
        .expect("output_after_process_exit must not hang on a held pipe")
        .expect("spawn should succeed");

        // The exit status is the PARENT's, which is the whole point: we can
        // report success or failure without waiting on a daemon.
        assert!(out.status.success(), "cmd should have exited 0");
        // Process exit + two bounded drains. Anything near the control's
        // window would mean we are still waiting on pipes, not on the process.
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "returned, but too slowly to be the process-exit path: {:?}",
            started.elapsed()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fast guard for the pipe deadlock — this is the one that runs by
    /// default.
    ///
    /// The behavioural test above proves the mechanism but costs ~15s, so it
    /// is `#[ignore]`d. That would leave the deadlock protected by nothing a
    /// normal `cargo test` runs, and the realistic regression is not subtle:
    /// somebody simplifies `output_after_process_exit(cmd, dir)` back to
    /// `cmd.output()`, which reads better and reintroduces a permanent hang.
    ///
    /// So this asserts the SHAPE: no prepare-family command may be awaited
    /// with `.output()`. It is a source check and is honest about being one —
    /// it cannot prove the replacement works, only that the known-broken call
    /// is not back.
    ///
    /// Comments are stripped first. `output_after_process_exit`'s own doc
    /// comment discusses `.output()` at length, and a raw substring test would
    /// be tripped by that prose rather than by code — the exact way two
    /// earlier tests in this project passed for the wrong reason.
    #[test]
    fn prepare_family_never_waits_on_pipe_eof() {
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");

        /// Body of `fn <name>` up to the next line that is a bare `}` at
        /// column 0, with `//` comments removed.
        fn body_of(src: &str, name: &str) -> String {
            // Normalise line endings FIRST. `include_str!` preserves the
            // file's CRLF, so the CR-less end sentinel below silently never
            // matches and `body_of` returns the whole rest of the file --
            // which contains every `.output()` in the module, failing the
            // assertion for a reason unrelated to the code under test.
            // Hit on the first run of this very test.
            let src = &src.replace("\r\n", "\n");
            let start = src
                .find(name)
                .unwrap_or_else(|| panic!("{name} not found — rename?"));
            let rest = &src[start..];
            let end = rest.find("\n}\n").unwrap_or(rest.len());
            rest[..end]
                .lines()
                .map(|l| l.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n")
        }

        for name in [
            "pub async fn run_prepare_step(",
            "pub async fn reconcile_coin_set(",
        ] {
            let body = body_of(THIS_FILE, name);
            assert!(
                !body.contains(".output()"),
                "{name} awaits `.output()`, which resolves on PIPE EOF, not on \
                 process exit. Prepare's coin daemons inherit those handles and \
                 outlive it, so this hangs forever in Phase::Preparing with no \
                 error — the 2026-08-20 \"stuck Configuring\" defect. Use \
                 `output_after_process_exit`.\n--- body ---\n{body}"
            );
            assert!(
                body.contains("output_after_process_exit"),
                "{name} must collect output via `output_after_process_exit`\n\
                 --- body ---\n{body}"
            );
        }

        // Paired positive: the helper really is the thing that waits on the
        // process, so a mis-sliced or empty body cannot make the above pass.
        let helper = body_of(THIS_FILE, "async fn output_after_process_exit_with(");
        assert!(
            helper.contains("child.wait().await"),
            "the helper must wait on the PROCESS:\n{helper}"
        );
        // ...and it must stop the stragglers BEFORE draining, or the drain is
        // what blocks instead.
        // `stop_prepare_daemons`, not `sweep_prepare_daemons`: the helper must
        // STOP the pipe-holders but must NOT wait for their ports to free.
        // Waiting here is what made two back-to-back addcoins pay two full
        // chainstate flushes serially; the wait belongs after the last prepare
        // in a batch, which is `reconcile_coin_set`'s job.
        assert!(
            !helper.contains("sweep_prepare_daemons("),
            "the helper must not use the waiting variant:
{helper}"
        );
        let sweep = helper
            .find("stop_prepare_daemons")
            .expect("the helper must stop daemons still holding the pipe");
        let drain = helper
            .find("timeout(drain")
            .expect("the helper must bound the drain");
        assert!(
            sweep < drain,
            "the sweep must run BEFORE the drain — reversed, it is once again \
             a cleanup sitting behind the await it exists to unblock:\n{helper}"
        );
    }

    // -- console auto-auth (C7.1) ------------------------------------

    /// **The property that matters is a negative one.**
    ///
    /// The obvious way to auto-auth is to have the page POST the password from
    /// JS. That works, and it puts a credential with withdraw authority into a
    /// page context for the life of the window. This test is what makes that
    /// change fail loudly instead of shipping as a simplification.
    /// The console must be created with the SAME WebView2 browser args as the
    /// main window, or its controller silently fails to initialize.
    ///
    /// tauri-apps/tauri#13092, reproduced here 2026-08-20..22: the main
    /// window's `additionalBrowserArgs` (the mining GPU-TDR + expose-gc
    /// tuning) made every runtime-created webview a dead white rectangle —
    /// window chrome, no navigation, no page-load, devtools a no-op —
    /// because WebView2 requires identical environment options per
    /// user-data folder.
    #[test]
    fn console_mirrors_the_main_windows_browser_args() {
        let arg_of = |conf: &str| -> Option<String> {
            let v: serde_json::Value = serde_json::from_str(conf).expect("conf parses");
            v["app"]["windows"][0]["additionalBrowserArgs"]
                .as_str()
                .map(String::from)
        };
        let main_args = arg_of(include_str!("../tauri.conf.json"));
        let claude_args = arg_of(include_str!("../tauri.sandbox.conf.json"));

        // Prod and sandbox must stay in LOCKSTEP: they were edited together
        // when the GPU-TDR fix landed (2026-06-14), and a drift means the
        // sandbox console works while the shipped one is white, or the
        // reverse — the least debuggable version of this bug.
        assert_eq!(
            main_args, claude_args,
            "tauri.conf.json and tauri.sandbox.conf.json must carry IDENTICAL              additionalBrowserArgs"
        );

        // While the conf sets args at all, the console builder must mirror
        // them. Source-scan (this codebase's F6 discipline): the helper being
        // correct proves nothing about the build path actually calling it.
        if main_args.is_some() {
            let src = include_str!("swap_sidecar.rs");
            // Probes assembled with concat! so this test's own text cannot
            // satisfy them — a plain literal here matches ITSELF via
            // include_str!, which is precisely the "check that cannot fail"
            // class this codebase names. Caught in the act on 2026-08-22:
            // the first version of this test stayed green with the
            // mirroring deleted.
            let read_probe = concat!("main_window_additional_browser_", "args(app)");
            let apply_probe = concat!("builder.additional_browser_", "args(args)");
            assert!(
                src.contains(read_probe),
                "open_console_window must READ the main window's args"
            );
            assert!(
                src.contains(apply_probe),
                "open_console_window must APPLY them to the builder —                  without this the console webview's WebView2 controller                  never initializes (tauri#13092) and the window is white"
            );
        }
    }

    /// `mem_guard` must skip the console window, and the two constants that
    /// arrange it must not drift apart.
    ///
    /// They are deliberately NOT one shared constant: `mem_guard` compiles in
    /// the lite build and `swap_sidecar` does not, so importing across that
    /// gate would break `cargo build --no-default-features`. The cost of the
    /// duplication is that a rename here silently re-enables the reload
    /// `mem_guard` is meant to suppress — the console would start being
    /// reloaded mid-bid again with nothing going red. This test is what makes
    /// that loud, and it only compiles where both sides exist.
    #[test]
    fn the_console_window_is_exempt_from_the_memory_guard_reload() {
        assert!(
            crate::mem_guard::SKIP_RELOAD_LABELS.contains(&CONSOLE_WINDOW_LABEL),
            "mem_guard::SKIP_RELOAD_LABELS must contain CONSOLE_WINDOW_LABEL              ({CONSOLE_WINDOW_LABEL:?}) — otherwise the memory guard reloads              upstream's console and discards whatever the user had typed into              a bid form"
        );
    }

    /// The console window is pinned to the engine's own loopback origin.
    ///
    /// Table-driven because the interesting cases are all REFUSALS, and a
    /// guard that accepts everything passes any test that only checks the
    /// happy path.
    #[test]
    fn console_navigation_is_pinned_to_the_engine_origin() {
        const PORT: u16 = 12700;
        let allow = |u: &str| {
            console_navigation_allowed(&url::Url::parse(u).unwrap(), PORT)
        };

        // The only thing that may load: the engine itself.
        assert!(allow("http://127.0.0.1:12700/offers"));
        assert!(allow("http://127.0.0.1:12700/login"));
        assert!(allow("http://127.0.0.1:12700/bid/abc?x=1#f"));

        // A different port on loopback is a DIFFERENT service — including
        // other local users' — and this window holds no session for it.
        assert!(!allow("http://127.0.0.1:12701/offers"));
        assert!(!allow("http://127.0.0.1/offers"), "no port at all must refuse");

        // Off-box, however friendly the name looks.
        assert!(!allow("http://evil.com:12700/offers"));
        assert!(!allow("https://basicswap.io/"));
        assert!(!allow("http://127.0.0.1.evil.com:12700/"));

        // `localhost` resolves through the user-writable hosts file, so it is
        // NOT a synonym for the loopback address here.
        assert!(!allow("http://localhost:12700/offers"));

        // Other interfaces that are not loopback.
        assert!(!allow("http://0.0.0.0:12700/"));
        assert!(!allow("http://192.168.1.10:12700/"));

        // Non-http schemes never load, regardless of what follows.
        assert!(!allow("file:///C:/Windows/System32/drivers/etc/hosts"));
        assert!(!allow("data:text/html,<script>alert(1)</script>"));
    }

    #[test]
    fn console_init_script_carries_no_password() {
        let password = "s3cr3t-console-pw";
        let script = console_init_script("basicswap_session_id=abc123");
        assert!(
            !script.contains(password),
            "the password must never reach the webview: {script}"
        );
        assert!(
            !script.to_lowercase().contains("password"),
            "not even a field named `password` belongs in the page: {script}"
        );
        // What it SHOULD carry: the session id, and nothing else secret.
        assert!(script.contains("abc123"), "{script}");
        assert!(script.contains(SESSION_COOKIE_NAME), "{script}");
    }

    /// The guard is not cosmetic: `document.cookie` cannot overwrite an
    /// HttpOnly cookie, so a window that already holds a live server-set
     /// Upstream's console idles out after 15 minutes unless told otherwise
    /// (http_server.py:84). This wallet logs the console in itself on a
    /// loopback port, so the limit protected nothing and signed the operator
    /// out mid-swap (2026-09-05). The policy write sets upstream's ceiling.
    #[test]
    fn console_session_timeout_is_raised_to_upstreams_ceiling_and_never_lowered() {
        let (out, changed) = ensure_session_timeout_in_config(r#"{"htmlport": 12800}"#).unwrap();
        assert!(changed);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_timeout_minutes"], CONSOLE_SESSION_TIMEOUT_MINUTES);
        assert_eq!(v["htmlport"], 12800, "other keys untouched");
        // Upstream rejects anything above 10080 (basicswap.py:15727).
        assert!(CONSOLE_SESSION_TIMEOUT_MINUTES <= 10080);

        // The default (15) is raised...
        let (_, changed) =
            ensure_session_timeout_in_config(r#"{"session_timeout_minutes": 15}"#).unwrap();
        assert!(changed);
        // ...the ceiling is left alone (idempotent on the second start)...
        let (same, changed) = ensure_session_timeout_in_config(
            r#"{"session_timeout_minutes": 10080}"#,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(same, r#"{"session_timeout_minutes": 10080}"#, "unchanged text, byte for byte");
        // ...and a broken file is an error, not a silently rewritten one.
        assert!(ensure_session_timeout_in_config("{not json").is_err());
    }

    /// Autostart must not start the node before the things the node needs
    /// exist. Source-level: the fault is ORDERING, and the wait is a loop
    /// around an async probe that no unit test can drive without an app.
    ///
    /// The bug it pins: autostart ran at app boot, the vault was locked, so
    /// Monero/Zephyr/Zano wallet-rpcs could not be open, so those coins were
    /// written into `basicswap.json` as `connection_type: "none"` — parked for
    /// the whole session — and the unpark watcher then restarted the node
    /// mid-use to add them. Reported twice: "why does zano keep failing" and
    /// "the swap node started to stop/restart unprompted".
    #[test]
    fn autostart_waits_for_the_wallets_the_node_needs() {
        let f: &str = include_str!("swap_sidecar.rs");
        let body = &f[f.find("pub fn on_app_ready(").expect("on_app_ready moved")..];
        let body = &body[..body.find("swap_sidecar_start(").expect("start call moved")];
        assert!(
            body.contains("autostart_not_ready_because(&app).await"),
            "autostart must consult the readiness gate BEFORE starting: {body}"
        );
        assert!(
            body.contains("AUTOSTART_READY_BUDGET"),
            "the wait must be bounded — a wallet left on the login screen still              gets a running node eventually"
        );
        // The gate itself must consider the vault AND each consented host
        // wallet; checking only one of them would leave the other parking.
        let gate = &f[f
            .find("pub async fn autostart_not_ready_because(")
            .expect("gate moved")..];
        let gate = &gate[..gate.find("
pub fn on_app_ready(").expect("gate end moved")];
        // The vault is deliberately NOT part of ready: waiting on the key
        // deadlocked the boot (the key is pushed only once the node runs).
        // The old assertion here required `wallet_pwd.is_some()` and stayed
        // green after the condition was removed — satisfied by the COMMENT
        // that explains the removal. A check that cannot fail for the reason
        // it is run. So: the code, minus its comments, must not read the key.
        let code_only: String = gate
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code_only.contains("wallet_pwd"),
            "the gate must not wait on the wallet key — that is the deadlock"
        );
        // "Up" means ANSWERING: spawned and bound to its port, for every coin.
        assert!(
            gate.contains("host_wallet_answering("),
            "the gate must use the answering probe, not the spawned flag"
        );
        let probe = &f[f
            .find("pub async fn host_wallet_answering(")
            .expect("probe moved")..];
        let probe = &probe[..probe.find("\n}\n").expect("probe end")];
        assert!(
            probe.contains("XMR_RPC_PORT") && probe.contains("ZPH_RPC_PORT"),
            "Monero and Zephyr must be port-checked, not spawn-checked: {probe}"
        );
        for coin in ["monero", "zephyr", "zano"] {
            assert!(gate.contains(coin), "{coin} must be waited for when consented");
        }
        assert!(
            gate.contains("shares_xmr_host_wallet")
                && gate.contains("shares_zph_host_wallet")
                && gate.contains("shares_zano_host_wallet"),
            "only CONSENTED coins are waited for — a wallet with none must start              exactly as it did before"
        );
    }

    // ── the chain daemon's own verdict ───────────────────────────────────

    /// The real lines from 2026-09-05 19:16–19:17 UTC, with the previous
    /// session's clean shutdown in front of them. Only the pair — an `Error:`
    /// and a `Shutdown: done` both stamped after our spawn — is fatal.
    #[test]
    fn particld_log_is_classified_against_our_own_spawn_time() {
        let tail = "\
2026-09-05T18:19:39Z Shutdown: done
2026-09-05T19:16:56Z Particl Core version v27.2.4.0 (release build)
2026-09-05T19:17:06Z Opening LevelDB in G:\\dev-home\\datadir\\particl\\indexes\\txindex
2026-09-05T19:17:06Z Error: txindex: best block of the index not found. Please rebuild the index.
2026-09-05T19:17:06Z Shutdown: In progress...
2026-09-05T19:17:06Z Shutdown: done
";
        let since = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc)
        };
        let fatal = classify_particld_log(tail, since("2026-09-05T19:16:50Z"))
            .expect("an error followed by a shutdown after our spawn is fatal");
        assert!(fatal.line.starts_with("txindex: best block"), "{}", fatal.line);
        assert!(fatal.txindex_rebuildable);

        // Spawned AFTER those lines: they belong to a previous session.
        assert_eq!(classify_particld_log(tail, since("2026-09-05T19:18:00Z")), None);
        // The previous session's clean shutdown alone is not an error.
        assert_eq!(
            classify_particld_log("2026-09-05T18:19:39Z Shutdown: done\n", since("2026-09-05T18:00:00Z")),
            None
        );
        // An error the daemon SURVIVED (no shutdown after it) is not fatal.
        let survived = "2026-09-05T19:17:06Z Error: something recoverable\n\
2026-09-05T19:17:07Z UpdateTip: new best=abc height=1\n";
        assert_eq!(classify_particld_log(survived, since("2026-09-05T19:16:50Z")), None);
        // A different fatal error is reported, but not marked repairable.
        let other = "2026-09-05T19:17:06Z Error: Cannot obtain a lock on data directory\n\
2026-09-05T19:17:06Z Shutdown: done\n";
        let f = classify_particld_log(other, since("2026-09-05T19:16:50Z")).unwrap();
        assert!(!f.txindex_rebuildable);
        assert!(f.line.contains("lock on data directory"));
    }

    /// The repair removes exactly the txindex directory and nothing beside it,
    /// and refuses when there is nothing to remove.
    #[test]
    fn txindex_repair_removes_only_the_index() {
        let root = std::env::temp_dir()
            .join(format!("pwnda-txindex-repair-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let part = particl_datadir(&root);
        std::fs::create_dir_all(part.join("indexes").join("txindex")).unwrap();
        std::fs::create_dir_all(part.join("blocks")).unwrap();
        std::fs::create_dir_all(part.join("chainstate")).unwrap();
        std::fs::write(part.join("indexes").join("txindex").join("000001.log"), b"x").unwrap();
        std::fs::write(part.join("wallet.dat"), b"keep").unwrap();
        // No basicswap.json here, so no port to probe — the repair may run.
        let removed = tauri::async_runtime::block_on(repair_particl_txindex(&root)).unwrap();
        assert!(removed.ends_with(std::path::Path::new("indexes").join("txindex")));
        assert!(!part.join("indexes").join("txindex").exists());
        assert!(part.join("blocks").is_dir(), "blocks untouched");
        assert!(part.join("chainstate").is_dir(), "chainstate untouched");
        assert_eq!(std::fs::read(part.join("wallet.dat")).unwrap(), b"keep");
        // Second call: nothing to repair is an error, not a silent success.
        assert!(tauri::async_runtime::block_on(repair_particl_txindex(&root)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The health loop must consult the daemon's verdict, and the start path
    /// must both tear down its own child on failure and retry the txindex
    /// case at most once. Source-level: all three need a live node to drive.
    #[test]
    fn a_failed_start_reads_particld_tears_down_and_repairs_once() {
        let f: &str = include_str!("swap_sidecar.rs");
        let core = &f[f.find("pub async fn start_node_core<").expect("core moved")..];
        let core = &core[..core.find("async fn unlock_if_configured").expect("core end")];
        assert!(core.contains("chain_daemon_fatal(&cfg.datadir, spawned_at)"), "health loop must read particld");
        let spawn_at = core.find("let spawned_at = chrono::Utc::now();").expect("stamp");
        let spawn = core.find(".spawn().map_err(").expect("spawn");
        assert!(spawn_at < spawn, "the stamp must precede the spawn or a fresh error looks old");

        let start = &f[f.find("pub async fn swap_sidecar_start(").expect("start moved")..];
        let start = &start[..start.find("async fn teardown_failed_start(").expect("teardown fn")];
        let teardown = start.find("teardown_failed_start(&app, &state).await").expect("teardown call");
        let sweep = start.find("sweep_prepare_daemons(&dd).await;\n        if swept > 0").expect("sweep");
        assert!(teardown < sweep, "the engine comes down before its daemons are swept");
        assert!(start.contains("&& !txindex_repaired =>"), "the repair is bounded to once per start");
        assert!(start.contains("repair_particl_txindex(&dd).await"), "the txindex case is repaired");
    }

    /// The engine's PART retry budget equals the supervisor's health budget:
    /// a daemon that never answers is given up on by both at the same moment.
    #[test]
    fn particl_startup_budget_matches_the_supervisors() {
        let engine_wait_ms =
            PARTICL_STARTUP_TRIES * (1 + PARTICL_STARTUP_TRIES) / 2 * PARTICL_STARTUP_DELAY_SECS * 1000;
        assert_eq!(engine_wait_ms, READY_BUDGET_MS, "upstream's wait is tries(1+tries)/2 × delay");

        let (out, changed) = ensure_particl_startup_budget_in_config(
            r#"{"chainclients": {"particl": {"rpcport": 19792}}}"#,
        )
        .unwrap();
        assert!(changed);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["chainclients"]["particl"]["startup_tries"], PARTICL_STARTUP_TRIES);
        assert_eq!(v["chainclients"]["particl"]["startup_delay"], PARTICL_STARTUP_DELAY_SECS);
        assert_eq!(v["chainclients"]["particl"]["rpcport"], 19792, "other keys untouched");
        // Idempotent on the second start.
        let (same, changed) = ensure_particl_startup_budget_in_config(&out).unwrap();
        assert!(!changed);
        assert_eq!(same, out);
        // No particl block: nothing to write, and not an error.
        let (_, changed) =
            ensure_particl_startup_budget_in_config(r#"{"chainclients": {}}"#).unwrap();
        assert!(!changed);
        assert!(ensure_particl_startup_budget_in_config("{nope").is_err());
    }

    /// The ladder's daemon stops run concurrently — the reconcile cost is the
    /// slowest daemon, not the sum. Source-level; the live ladder needs daemons.
    #[test]
    fn the_ladder_stops_chain_daemons_concurrently() {
        let f: &str = include_str!("swap_sidecar.rs");
        let live = &f[f.find("impl LadderActions for LiveLadder").expect("impl moved")..];
        let body = &live[live.find("async fn stop_chain_daemons").expect("fn")..];
        let body = &body[..body.find("async fn terminate_parent").expect("end")];
        assert!(body.contains("join_all(targets.iter().map(stop_daemon_gracefully))"), "{body}");
        assert!(!body.contains("for t in targets"), "no serial loop over the daemons");
    }

    /// Every swap/fee command registered in `lib.rs` must sit behind
    /// `#[cfg(feature = "full")]`, or `cargo build --no-default-features` — the
    /// PwndaLite build — fails to resolve a module that is not compiled there.
    /// Three commands were registered bare (one on 2026-09-04, two on
    /// 2026-09-05) and the lite build was red until the audit that day ran it.
    /// BOUNDARIES.md § Backend states the rule; this makes it a test.
    #[test]
    fn every_swap_command_in_the_invoke_handler_is_gated_on_full() {
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").expect("handler moved");
        let body = &lib[start..];
        let body = &body[..body.find("])").expect("handler end")];
        let lines: Vec<&str> = body.lines().collect();
        let mut bare = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            let l = line.trim();
            // The fee module's name is SPLIT here so this file does not
            // mention it: `the_swap_path_does_not_depend_on_the_fee` scans
            // every non-fee source for that word, and a test that named it
            // would read as the dependency it exists to forbid.
            let fee_prefix = concat!("sidecar_", "fees::");
            let is_swap_cmd = ["swap_sidecar::", "swap_bid::", "swap_bridge::", fee_prefix]
                .iter()
                .any(|m| l.starts_with(m));
            if !is_swap_cmd {
                continue;
            }
            let gated = i > 0 && lines[i - 1].trim() == r#"#[cfg(feature = "full")]"#;
            if !gated {
                bare.push(l.to_string());
            }
        }
        assert!(bare.is_empty(), "registered without the full gate: {bare:?}");
    }

    /// **Removing the consent UI must not remove the consent** (2026-09-05).
    ///
    /// The Settings sections that carried "Using my wallet" for ZEPH and ZANO
    /// were deleted as redundant: sharing is the DEFAULT
    /// (`opted_in && enabled && declined_at.is_none()`), and those two coins
    /// have no local daemon and no light-client option, so declining does not
    /// select an alternative — it turns the coin off. The button could only
    /// ever affirm what was already true.
    ///
    /// That is safe ONLY because the predicate defaults to sharing. If it were
    /// ever inverted to require a recorded acknowledgement, deleting the UI
    /// would silently stop both coins from trading, with nothing on screen to
    /// say why. This is the test that would catch that, and it is deliberately
    /// in Rust rather than beside the UI test that checks the sections are
    /// gone: the surface is the removable half, the predicate is not.
    #[test]
    fn host_wallet_sharing_is_on_by_default_with_no_consent_ui() {
        let mut e = CoinOptIn::default();
        e.enabled = true;
        // No acknowledgement of any kind recorded — a fresh install that has
        // never seen a consent control, which is now every install.
        assert!(
            shares_zph_host_wallet(true, &e),
            "ZEPH must share by default; there is no UI left to turn it on"
        );
        assert!(
            shares_zano_host_wallet(true, &e),
            "ZANO must share by default; there is no UI left to turn it on"
        );

        // The two things that still turn it off, both reachable without the
        // deleted sections: the coin toggle, and the sidecar opt-in itself.
        let mut off = e.clone();
        off.enabled = false;
        assert!(!shares_zph_host_wallet(true, &off));
        assert!(!shares_zano_host_wallet(true, &off));
        assert!(!shares_zph_host_wallet(false, &e), "no sidecar opt-in, no sharing");

        // A decline recorded by an OLDER build is still honoured, so upgrading
        // does not quietly re-enable something the user switched off.
        let mut declined = e.clone();
        declined.zph_host_wallet_declined_at = Some("2026-09-01T00:00:00Z".to_string());
        assert!(!shares_zph_host_wallet(true, &declined));
        let mut declined_z = e.clone();
        declined_z.zano_host_wallet_declined_at = Some("2026-09-01T00:00:00Z".to_string());
        assert!(!shares_zano_host_wallet(true, &declined_z));
    }

    /// The shutdown token is scraped from a page that RENDERS.
    ///
    /// `/` is a 302 with an empty body (`http_server.py::page_index`), and
    /// this client does not follow redirects, so scraping it could only ever
    /// return `None`. Every app exit therefore escalated past graceful
    /// shutdown, and every next start paid to reconcile the stale instance.
    /// Source-level because the fault is WHICH url is fetched.
    #[test]
    fn graceful_shutdown_does_not_scrape_the_index_redirect() {
        let f: &str = include_str!("swap_sidecar.rs");
        let body = &f[f
            .find("pub async fn graceful_shutdown_via_http(")
            .expect("shutdown fn moved")..];
        let body = &body[..body.find("extract_shutdown_token").expect("scrape moved")];
        assert!(
            body.contains("SHUTDOWN_TOKEN_PAGE"),
            "the fetch must name the page constant, not a bare url: {body}"
        );
        assert!(
            !body.contains(r#"format!("http://127.0.0.1:{}/", port)"#),
            "fetching `/` scrapes a 302 with no body — that is the 2026-09-05 fault"
        );
        assert_eq!(
            SHUTDOWN_TOKEN_PAGE, "offers",
            "offers is where / redirects and the only page rendering header.html"
        );
    }

    /// **The script writes the cookie and does nothing else** (2026-09-05).
    ///
    /// Both halves of this test used to assert the opposite. The script used
    /// to read `document.cookie` back and redirect only if it could see its
    /// own write — a guard whose stated purpose was to bound a redirect loop.
    /// It could not do that job: upstream's session cookie is `HttpOnly`
    /// (`http_server.py::_set_session_cookie`), a JS write is silently ignored
    /// while one of the same name is in the jar, and WebView2 keeps that jar
    /// for the life of the app. So the read-back returned false on exactly the
    /// runs where the fallback was needed, and the console showed the login
    /// form — the operator's *"it says login, but when I close out and do it
    /// again it logs me in automatically."*
    ///
    /// Navigation now happens in Rust (`webview.navigate`), where nothing can
    /// shadow it, and the loop is bounded by a COUNTER rather than by a proxy
    /// for one. So the script must not carry navigation at all: a second
    /// navigator would be a second thing to reason about, and the page-side
    /// one is the half that did not work.
    #[test]
    fn console_init_script_only_writes_the_cookie() {
        let script = console_init_script("basicswap_session_id=abc123");
        assert!(script.contains("document.cookie = "), "it must write: {script}");
        assert!(script.contains("abc123"), "the fresh cookie, not a placeholder: {script}");
        assert!(
            !script.contains("already present"),
            "must not defer to a cookie that is merely present: {script}"
        );
        // The three things that made the old script decide for itself.
        for banned in ["location.replace", "location.href", "indexOf(\"basicswap"] {
            assert!(
                !script.contains(banned),
                "the page must not navigate or self-check any more ({banned}): {script}"
            );
        }
        // A throw must leave the normal form usable rather than blank the page.
        assert!(script.contains("catch"), "{script}");
    }

    /// **Rust navigates, and the attempt count is what bounds the loop.**
    ///
    /// Source-level: the handler needs a live WebView2 to drive. The property
    /// is that `/login` arrivals are counted, capped at
    /// [`CONSOLE_LOGIN_ATTEMPTS`], and that the thing which moves the window
    /// off the login page is `navigate`, not page script.
    #[test]
    fn the_console_navigates_from_rust_and_bounds_its_attempts() {
        let f: &str = include_str!("swap_sidecar.rs");
        let body = &f[f.find("fn open_console_window(").expect("opener moved")..];
        let body = &body[..body.find("\n    // The fix for the white window").expect("end")];
        assert!(body.contains("login_arrivals.fetch_add"), "arrivals must be COUNTED: {body}");
        assert!(
            body.contains("n > CONSOLE_LOGIN_ATTEMPTS"),
            "the count must be what stops the loop"
        );
        assert!(body.contains("wv.navigate(u)"), "Rust must issue the navigation");
        assert!(
            body.contains("CONSOLE_HOME_PATH"),
            "and it must go to the console home, not back to /login"
        );
        // Two, not one: a bounce back must get a fresh session before giving up.
        assert!(CONSOLE_LOGIN_ATTEMPTS >= 2, "one attempt cannot recover a stale cookie");
        assert!(
            body.contains("login_for_session(&c, port, &pwd).await"),
            "the second attempt re-logs in rather than reusing the cookie the \
             server has just refused"
        );
    }

    /// A silent failure here is indistinguishable from "auth is disabled", so
    /// the script says what it did.
    #[test]
    fn console_init_script_reports_its_outcome() {
        let script = console_init_script("basicswap_session_id=abc123");
        assert!(script.contains("console.log"), "{script}");
        assert!(script.contains("[pwnda]"), "must be greppable: {script}");
    }

    /// A cookie value is server-generated, but it is interpolated into JS.
    #[test]
    fn console_init_script_escapes_the_cookie() {
        let script = console_init_script("basicswap_session_id=a\"b\\c");
        // The raw quote must not survive to close the JS string literal.
        assert!(
            script.contains("a\\\"b\\\\c"),
            "quote and backslash must both be escaped: {script}"
        );
    }

    /// Only `name=value` may travel back; `Path`/`HttpOnly`/`SameSite` are
    /// RESPONSE attributes and a request `Cookie:` header carrying them is
    /// malformed.
    #[test]
    fn cookie_pairs_strips_response_attributes() {
        let got = cookie_pairs_from(
            [
                "basicswap_session_id=abc123; Path=/; HttpOnly; SameSite=Lax",
                "other=zzz; Path=/",
            ]
            .into_iter(),
        );
        assert_eq!(got, "basicswap_session_id=abc123; other=zzz");
        assert!(!got.contains("HttpOnly"), "{got}");
        assert!(!got.contains("Path"), "{got}");

        // Base64 session ids contain `=` padding - splitting on `=` rather
        // than `;` would truncate them.
        let padded = cookie_pairs_from(["basicswap_session_id=YWJjZA==; Path=/"].into_iter());
        assert_eq!(padded, "basicswap_session_id=YWJjZA==");

        // Junk that is not a pair is dropped rather than emitted as a bare
        // token, which would make the whole header unparseable.
        assert_eq!(cookie_pairs_from(["; Path=/", "   "].into_iter()), "");
        assert_eq!(cookie_pairs_from([].into_iter()), "");
    }

    // -- per-coin lean/full mode (C7) --------------------------------

    /// The flag must come from the CONFIG, not from a literal.
    ///
    /// This is the mutation that matters: restoring the old hardcoded
    /// `--ltc-mode=electrum` push makes the first two cases below wrong in
    /// opposite directions, so no literal can satisfy both.
    #[test]
    fn lean_mode_flags_follow_the_config_not_a_literal() {
        let mut cfg = test_config();

        // 1. a lean coin that is NOT litecoin
        cfg.coins = vec!["particl".into(), "bitcoin".into()];
        cfg.lean_coins = vec!["bitcoin".into()];
        let plan = build_prepare_plan(&cfg);
        assert!(plan.has_arg("--btc-mode=electrum"), "{:?}", plan.args);
        assert!(
            !plan.args.iter().any(|a| a.starts_with("--ltc-mode")),
            "litecoin is not even in the coin set: {:?}",
            plan.args
        );

        // 2. litecoin present but FULL. Absence is how Full is expressed, so a
        //    stray flag here silently costs the user zero-move adoption.
        cfg.coins = vec!["particl".into(), "litecoin".into()];
        cfg.lean_coins = vec![];
        let plan = build_prepare_plan(&cfg);
        assert!(
            !plan.args.iter().any(|a| a.contains("-mode=electrum")),
            "Full must emit NO mode flag: {:?}",
            plan.args
        );

        // 3. both lean
        cfg.coins = vec!["particl".into(), "bitcoin".into(), "litecoin".into()];
        cfg.lean_coins = vec!["bitcoin".into(), "litecoin".into()];
        let plan = build_prepare_plan(&cfg);
        assert!(plan.has_arg("--btc-mode=electrum"), "{:?}", plan.args);
        assert!(plan.has_arg("--ltc-mode=electrum"), "{:?}", plan.args);
    }

    /// A lean request for a coin the engine has no `--<prefix>-mode` for must
    /// never reach argv: prepare aborts with "Unknown argument", which is a
    /// startup failure three layers from the toggle that caused it.
    ///
    /// **`bitcoincash` moved OUT of this list 2026-09-03** (Grove expansion
    /// plan, Phase C, unit C-R0): it is exactly the coin that stopped being
    /// impossible, once `upstream/patches/0018` and this unit's
    /// [`ELECTRUM_CAPABLE`] entry landed — keeping it here would have made
    /// this test assert BCH light mode is unreachable, the opposite of what
    /// shipped. `zephyr`/`zano` took its place: genuinely impossible, since
    /// neither is (or will ever be) [`ELECTRUM_CAPABLE`] — see
    /// [`REMOTE_ONLY_COINS`].
    #[test]
    fn lean_mode_flags_never_invent_a_flag_upstream_cannot_parse() {
        let mut cfg = test_config();
        cfg.coins = vec![
            "particl".into(),
            "dogecoin".into(),
            "dash".into(),
            "monero".into(),
            "zephyr".into(),
            "zano".into(),
        ];
        // A record asking for the impossible. `decide_mode_change` refuses this
        // at the API, but argv generation must not depend on that being the
        // only writer of the file.
        cfg.lean_coins = cfg.coins.clone();
        let plan = build_prepare_plan(&cfg);
        assert!(
            !plan.args.iter().any(|a| a.contains("-mode=electrum")),
            "no electrum flag exists for any of these coins: {:?}",
            plan.args
        );
    }

    /// The positive twin: `bitcoincash` DOES now get a real electrum flag
    /// when requested lean — pins the behaviour the test above stopped
    /// covering once BCH moved out of the "impossible" list.
    #[test]
    fn lean_mode_flags_cover_bitcoincash() {
        let mut cfg = test_config();
        cfg.coins = vec!["particl".into(), "bitcoincash".into()];
        cfg.lean_coins = vec!["bitcoincash".into()];
        let plan = build_prepare_plan(&cfg);
        assert!(plan.has_arg("--bch-mode=electrum"), "{:?}", plan.args);
    }

    /// A mode flag for a coin this run is not installing must not be emitted.
    ///
    /// This is not hypothetical: `build_config` fills `lean_coins` with EVERY
    /// electrum-capable coin (absent record entry = the Lean default), so an
    /// install running only BTC would otherwise hand prepare an `--ltc-mode`
    /// alongside `--withcoins=particl,bitcoin` — a directive about a coin that
    /// is not being set up. The `cfg.coins` half of the filter is what stops
    /// it, and this test is what stops that half from being deleted.
    #[test]
    fn lean_mode_flags_are_scoped_to_the_coins_being_installed() {
        let mut cfg = test_config();
        cfg.coins = vec!["particl".into(), "bitcoin".into()];
        // What `build_config` actually produces: both capable coins marked
        // lean, only one of them installed.
        cfg.lean_coins = vec!["bitcoin".into(), "litecoin".into()];
        let plan = build_prepare_plan(&cfg);
        assert!(plan.has_arg("--btc-mode=electrum"), "{:?}", plan.args);
        assert!(
            !plan.args.iter().any(|a| a.starts_with("--ltc-mode")),
            "litecoin is not in --withcoins, so its mode is not this run's business: {:?}",
            plan.args
        );
    }

    // ===================================================================
    // C8 — shared wallets on lean coins
    // ===================================================================

    fn coin_entry(enabled: bool, mode: CoinMode, adoption: Adoption) -> CoinOptIn {
        coin_entry_ack(enabled, mode, adoption, true)
    }

    /// `ack` is the C8 consent flag. Defaulted ON in `coin_entry` so the
    /// existing cases read as "a consented coin", and varied explicitly where
    /// consent itself is the subject.
    fn coin_entry_ack(
        enabled: bool,
        mode: CoinMode,
        adoption: Adoption,
        ack: bool,
    ) -> CoinOptIn {
        CoinOptIn {
            enabled,
            at: None,
            adoption,
            descriptors_imported_at: None,
            first_sync_started: false,
            mode,
            share_wallet_ack_at: ack.then(|| "2026-08-20T00:00:00Z".to_string()),
            share_wallet_declined_at: (!ack).then(|| "2026-08-20T00:00:00Z".to_string()),
            xmr_host_wallet_ack_at: None,
            xmr_host_wallet_declined_at: None,
            zph_host_wallet_ack_at: None,
            zph_host_wallet_declined_at: None,
            zano_host_wallet_ack_at: None,
            zano_host_wallet_declined_at: None,
        }
    }

    /// `adoption_coins` decides whether the engine is told to REFUSE its own
    /// derivation for a coin, so every condition it checks has to be load
    /// bearing — a false positive strands a wallet, a false negative silently
    /// hands the user a wallet that is not theirs.
    #[test]
    fn adoption_coins_names_only_fully_qualified_coins() {
        let mut rec = OptInRecord::default();
        rec.opted_in = true;
        rec.coins.insert(
            "bitcoin".into(),
            coin_entry(true, CoinMode::Lean, Adoption::AccountKey),
        );
        assert_eq!(adoption_coins(&rec), vec!["btc".to_string()]);

        // TICKER, lowercased — not the engine's coin name. PWNDA-PATCH-3
        // compares against `Coins(coin_type).name.lower()`, so "bitcoin" here
        // would match nothing and the fail-closed guard would never arm.
        assert!(!adoption_coins(&rec).contains(&"bitcoin".to_string()));

        // DEFAULT ON (2026-08-20): an UNTOUCHED coin — no ack, no decline —
        // shares, because opting into the DEX is the decision and the wizard
        // carries the disclosure. This is the case the old per-coin gate got
        // backwards, and the one a fresh install actually hits.
        let mut untouched = OptInRecord::default();
        untouched.opted_in = true;
        let mut e = CoinOptIn::default();
        e.enabled = true;
        e.mode = CoinMode::Lean;
        untouched.coins.insert("bitcoin".into(), e);
        assert_eq!(
            adoption_coins(&untouched),
            vec!["btc".to_string()],
            "an untouched coin must share by default once the user has opted in"
        );

        // Each condition alone must remove it.
        for (label, entry) in [
            ("disabled", coin_entry(false, CoinMode::Lean, Adoption::AccountKey)),
            ("full mode", coin_entry(true, CoinMode::Full, Adoption::AccountKey)),
            // The DURABLE decline — the only thing that turns sharing off now
            // that the default is on. `coin_entry_ack(.., false)` writes
            // `share_wallet_declined_at`.
            (
                "explicitly declined",
                coin_entry_ack(true, CoinMode::Lean, Adoption::AccountKey, false),
            ),
            (
                "explicitly declined, deposit",
                coin_entry_ack(true, CoinMode::Lean, Adoption::Deposit, false),
            ),
        ] {
            let mut r = OptInRecord::default();
            r.opted_in = true;
            r.coins.insert("bitcoin".into(), entry);
            assert!(
                adoption_coins(&r).is_empty(),
                "{label} must not be named for account-key adoption"
            );
        }

        // NOT OPTED IN is its own refusal, independent of every per-coin
        // field: no consent to the DEX means no consent to anything under it.
        let mut never = OptInRecord::default();
        never.opted_in = false;
        never.coins.insert(
            "bitcoin".into(),
            coin_entry(true, CoinMode::Lean, Adoption::AccountKey),
        );
        assert!(
            adoption_coins(&never).is_empty(),
            "a record that never opted into the DEX must share nothing"
        );
    }

    /// Only electrum-capable coins can be lean at all, so nothing else may
    /// reach the env var however the record was written.
    ///
    /// **BUG FOUND while adding `bitcoincash` to [`ELECTRUM_CAPABLE`] (Grove
    /// expansion plan, Phase C, unit C-R0), fixed in the same change: this
    /// test never set `rec.opted_in = true`.** `OptInRecord::default()`
    /// leaves it `false`, and `adoption_coins` refuses on that alone
    /// (`shares_lean_wallet`'s first condition) — so the assertion passed
    /// regardless of whether the ELECTRUM_CAPABLE filter this test is named
    /// for did anything at all. It is exactly the "a check that cannot fail
    /// for the reason you run it" shape the project's bug-documentationumentation
    /// protocol names by number: had `adoption_coins` been changed to skip
    /// the ELECTRUM_CAPABLE filter entirely, this test would still have gone
    /// green. Caught by asking, of every existing test near code being
    /// touched, "would this go red if the behaviour it names were broken" —
    /// per the same protocol's detection-technique menu — rather than by any
    /// tool. `bitcoincash` also had to move OUT of the "cannot run lean" list
    /// it was in, since it now legitimately can; `zephyr`/`zano` (which never
    /// gained an [`ELECTRUM_CAPABLE`] entry — see [`REMOTE_ONLY_COINS`]) took
    /// its place, alongside a new positive-case assertion below pinning that
    /// BCH DOES get named when genuinely lean and consented.
    #[test]
    fn adoption_coins_ignores_coins_that_cannot_run_lean() {
        let mut rec = OptInRecord::default();
        rec.opted_in = true;
        for coin in ["dogecoin", "dash", "monero", "particl", "zephyr", "zano"] {
            rec.coins.insert(
                coin.into(),
                coin_entry(true, CoinMode::Lean, Adoption::AccountKey),
            );
        }
        assert!(
            adoption_coins(&rec).is_empty(),
            "a hand-edited record must not be able to name a coin the engine's \
             WalletManager cannot serve"
        );
    }

    /// The positive case `adoption_coins_ignores_coins_that_cannot_run_lean`
    /// does not cover: BCH is now [`ELECTRUM_CAPABLE`] (Grove expansion plan,
    /// Phase C), so a genuinely lean, consented, opted-in BCH entry MUST be
    /// named — mirroring `adoption_coins_names_only_fully_qualified_coins`'s
    /// bitcoin case, but for the coin this unit actually widened the table
    /// for.
    #[test]
    fn adoption_coins_admits_a_lean_consented_bitcoincash() {
        let mut rec = OptInRecord::default();
        rec.opted_in = true;
        rec.coins.insert(
            "bitcoincash".into(),
            coin_entry(true, CoinMode::Lean, Adoption::AccountKey),
        );
        assert_eq!(adoption_coins(&rec), vec!["bch".to_string()]);
    }

    // ── Sharing defaults ON once the DEX is opted into (2026-08-20) ──

    /// The inversion's core rule, stated once for both mechanisms: an
    /// untouched capable coin shares; only an explicit decline stops it.
    #[test]
    fn sharing_defaults_on_and_only_an_explicit_decline_stops_it() {
        let untouched = |mode: CoinMode| {
            let mut e = CoinOptIn::default();
            e.enabled = true;
            e.mode = mode;
            e
        };

        // C8 — lean, untouched, opted in: shares.
        assert!(shares_lean_wallet(true, &untouched(CoinMode::Lean)));
        // C9 — monero, untouched, opted in: shares. Mode is NOT consulted,
        // because monero has no lean/full choice in this sense; gating on it
        // would make this predicate silently never fire.
        assert!(shares_xmr_host_wallet(true, &untouched(CoinMode::Full)));
        // C9-shaped — zephyr/zano, same shape as monero and for the same
        // reason: neither has a lean/full choice, so mode must not gate it.
        assert!(shares_zph_host_wallet(true, &untouched(CoinMode::Full)));
        assert!(shares_zano_host_wallet(true, &untouched(CoinMode::Full)));

        // Not opted into the DEX at all: neither shares, whatever the entry says.
        assert!(!shares_lean_wallet(false, &untouched(CoinMode::Lean)));
        assert!(!shares_xmr_host_wallet(false, &untouched(CoinMode::Full)));
        assert!(!shares_zph_host_wallet(false, &untouched(CoinMode::Full)));
        assert!(!shares_zano_host_wallet(false, &untouched(CoinMode::Full)));

        // Disabled coin: nothing to share.
        let mut off = untouched(CoinMode::Lean);
        off.enabled = false;
        assert!(!shares_lean_wallet(true, &off));
        assert!(!shares_xmr_host_wallet(true, &off));
        assert!(!shares_zph_host_wallet(true, &off));
        assert!(!shares_zano_host_wallet(true, &off));

        // Full mode is C3.5's descriptor-import path, not C8's.
        assert!(!shares_lean_wallet(true, &untouched(CoinMode::Full)));

        // The durable decline is the only OFF switch.
        let mut declined = untouched(CoinMode::Lean);
        declined.share_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_lean_wallet(true, &declined));

        let mut xmr_declined = untouched(CoinMode::Full);
        xmr_declined.xmr_host_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_xmr_host_wallet(true, &xmr_declined));

        let mut zph_declined = untouched(CoinMode::Full);
        zph_declined.zph_host_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_zph_host_wallet(true, &zph_declined));

        let mut zano_declined = untouched(CoinMode::Full);
        zano_declined.zano_host_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_zano_host_wallet(true, &zano_declined));
    }

    /// The four sharing mechanisms' declines must not cross-talk — the same
    /// property [`c8_and_c9_declines_are_independent`] pins for C8/C9,
    /// extended to ZEPH and ZANO now that a THIRD and FOURTH host-wallet-style
    /// flag exist on the same struct. Reusing one flag across coins is the
    /// exact "same toggle silently means two different security properties"
    /// shape [`CoinOptIn::xmr_host_wallet_ack_at`]'s own doc comment names —
    /// worth re-proving now that there are four fields, not two, to confuse.
    #[test]
    fn zph_and_zano_declines_are_independent_of_each_other_and_of_c8_c9() {
        let base = || {
            let mut e = CoinOptIn::default();
            e.enabled = true;
            e.mode = CoinMode::Lean;
            e
        };

        let mut zph_only = base();
        zph_only.zph_host_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_zph_host_wallet(true, &zph_only));
        assert!(
            shares_lean_wallet(true, &zph_only)
                && shares_xmr_host_wallet(true, &zph_only)
                && shares_zano_host_wallet(true, &zph_only),
            "declining ZEPH sharing must not decline anything else"
        );

        let mut zano_only = base();
        zano_only.zano_host_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_zano_host_wallet(true, &zano_only));
        assert!(
            shares_lean_wallet(true, &zano_only)
                && shares_xmr_host_wallet(true, &zano_only)
                && shares_zph_host_wallet(true, &zano_only),
            "declining ZANO sharing must not decline anything else"
        );
    }

    /// The two mechanisms' declines must not cross-talk. Declining Monero's
    /// wallet-rpc sharing has nothing to do with Bitcoin's account keys, and a
    /// single shared flag would have made one silently turn off the other.
    #[test]
    fn c8_and_c9_declines_are_independent() {
        let mut e = CoinOptIn::default();
        e.enabled = true;
        e.mode = CoinMode::Lean;
        e.share_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_lean_wallet(true, &e));
        assert!(
            shares_xmr_host_wallet(true, &e),
            "declining C8 must not also decline C9"
        );

        let mut e2 = CoinOptIn::default();
        e2.enabled = true;
        e2.mode = CoinMode::Lean;
        e2.xmr_host_wallet_declined_at = Some("2026-08-20T00:00:00Z".into());
        assert!(!shares_xmr_host_wallet(true, &e2));
        assert!(
            shares_lean_wallet(true, &e2),
            "declining C9 must not also decline C8"
        );
    }

    /// The env guard and the key-push gate must agree, for every state.
    ///
    /// They did NOT between the default-ON inversion and 2026-08-21, and the
    /// failure mode was a DEADLOCK rather than a wrong wallet:
    /// `adoption_coins` (new rule) armed the engine to refuse building its own
    /// wallet, while `swap_sidecar_push_account_keys` (old rule, still keyed
    /// on `share_wallet_ack_at`) refused to send the key that would unblock
    /// it. A fresh install — which never presses the toggle, because sharing
    /// is now the default — would therefore end up with NO wallet for that
    /// coin: zero balance, "Expected Seed: false", and a Reseed that fails.
    ///
    /// Both sides now call `shares_lean_wallet`. This asserts they cannot
    /// drift again, by exercising the combinations that differ between the
    /// two rules — an untouched coin is exactly the case the old gate got
    /// wrong.
    #[test]
    fn the_env_guard_and_the_push_gate_agree() {
        let cases: [(&str, bool, bool, Option<&str>, Option<&str>); 5] = [
            // (label, opted_in, enabled, ack_at, declined_at)
            ("untouched — the fresh-install case", true, true, None, None),
            ("explicitly acked", true, true, Some("t"), None),
            ("explicitly declined", true, true, None, Some("t")),
            ("declined after acking", true, true, Some("t"), Some("t")),
            ("never opted into the DEX", false, true, Some("t"), None),
        ];

        for (label, opted_in, enabled, ack, declined) in cases {
            let mut entry = CoinOptIn::default();
            entry.enabled = enabled;
            entry.mode = CoinMode::Lean;
            entry.share_wallet_ack_at = ack.map(str::to_string);
            entry.share_wallet_declined_at = declined.map(str::to_string);

            let mut rec = OptInRecord::default();
            rec.opted_in = opted_in;
            rec.coins.insert("bitcoin".into(), entry.clone());

            // What the ENGINE is told (armed => it will refuse its own seed).
            let armed = adoption_coins(&rec).contains(&"btc".to_string());
            // What the PUSH decides (may the key leave?).
            let pushes = shares_lean_wallet(rec.opted_in, &entry);

            assert_eq!(
                armed, pushes,
                "{label}: the engine guard ({armed}) and the key push                  ({pushes}) disagree — that combination deadlocks the coin"
            );
        }

        // The value comparison above is necessary but NOT sufficient, and
        // this half is why: it computes `pushes` by calling
        // `shares_lean_wallet` itself, so it agrees with `adoption_coins`
        // trivially — reverting the COMMAND to the old ack-based gate leaves
        // it green (verified by mutation, 2026-08-21). Only a source scan
        // notices that the command stopped asking the shared question.
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_push_account_keys(")
            .expect("the push command must exist");
        // Wide enough to cover the whole command body — it grew when the
        // pre-share balance gate landed, and a slice that ends early makes
        // the assertions below fail for the wrong reason.
        let end = (at + 8000).min(THIS_FILE.len());
        let body = &THIS_FILE[at..end];
        assert!(
            body.contains("shares_lean_wallet(consented.opted_in, e)"),
            "the push must gate on the SAME predicate as the env guard:
{body}"
        );
        assert!(
            !body.contains("e.share_wallet_ack_at.is_some()"),
            "the push must not re-introduce the raw ack gate — that is the              disagreement that deadlocked a fresh install:
{body}"
        );
        // The pre-share balance gate must run BEFORE the key is installed:
        // the install discards the engine's own address table, so a funded
        // deposit-mode wallet would stop being watched (2026-08-21).
        let gate_at = body
            .find("pre_share_balance_gate")
            .expect("the push must gate on the node's existing balance");
        let push_at = body
            .find("push_account_key(port")
            .expect("the push call must exist");
        assert!(
            gate_at < push_at,
            "the balance gate must run BEFORE push_account_key:
{body}"
        );
    }

    // ── C9 — the shared-XMR-wallet lifecycle gate ────────────────────

    #[test]
    fn xmr_shared_wallet_in_use_only_blocks_when_all_three_hold() {
        // Positive control first: every condition true is the one case that
        // must refuse.
        assert!(xmr_shared_wallet_in_use(true, true, Some(1)));

        // Each condition alone must clear it.
        assert!(!xmr_shared_wallet_in_use(false, true, Some(1)), "not consented");
        assert!(!xmr_shared_wallet_in_use(true, false, Some(1)), "node not running");
        assert!(
            !xmr_shared_wallet_in_use(true, true, Some(0)),
            "consented and running, but nothing in flight"
        );
    }

    #[test]
    fn xmr_shared_wallet_in_use_fails_closed_on_an_unmeasured_count() {
        // Mirrors reserved_balance_gate's own philosophy: an unmeasured count
        // is not a count of zero. Wrongly refusing a Lock click costs an
        // extra confirmation; wrongly allowing one risks a corrupted swap.
        assert!(
            xmr_shared_wallet_in_use(true, true, None),
            "an unmeasurable bid count must refuse, not pass"
        );
        // But ONLY when consent + running both hold — an unmeasured count for
        // a coin nobody consented to share, or a node that isn't running,
        // must not manufacture a refusal out of nothing.
        assert!(!xmr_shared_wallet_in_use(false, true, None));
        assert!(!xmr_shared_wallet_in_use(true, false, None));
    }

    #[test]
    fn set_xmr_host_wallet_refuses_every_coin_but_monero() {
        // The refusal message must name the RIGHT sibling command — a user
        // who tries to share BTC's wallet this way and gets pointed at
        // set_share_wallet (the C8 mechanism, which is what BTC actually
        // uses) is not stuck.
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_set_xmr_host_wallet(")
            .expect("the command must exist");
        let body = &THIS_FILE[at..at + 1500];
        assert!(
            body.contains("if key != \"monero\""),
            "the monero-only gate must be present:\n{body}"
        );
        assert!(
            body.contains("swap_sidecar_set_share_wallet"),
            "the refusal must point at the sibling command for every other coin:\n{body}"
        );
    }

    /// C9 and C8's consent fields must never be the same field. Reusing one
    /// flag for two mechanistically different sharing schemes is exactly the
    /// "precondition copied from a neighbouring operation" shape this
    /// project's bug log names — a toggle whose meaning silently depends on
    /// which coin it is read for.
    #[test]
    fn c8_and_c9_consent_are_independent_fields() {
        let mut entry = CoinOptIn::default();
        entry.share_wallet_ack_at = Some("2026-08-20T00:00:00Z".to_string());
        assert!(
            entry.xmr_host_wallet_ack_at.is_none(),
            "setting C8's consent must not also set C9's"
        );

        let mut entry2 = CoinOptIn::default();
        entry2.xmr_host_wallet_ack_at = Some("2026-08-20T00:00:00Z".to_string());
        assert!(
            entry2.share_wallet_ack_at.is_none(),
            "setting C9's consent must not also set C8's"
        );
    }

    /// monero is in DEFAULT_ENABLED_COINS — a fresh AND an upgraded install
    /// both have it enabled from day one. If `xmr_host_wallet_ack_at`
    /// defaulted to consented, the moment the config writer is wired to the
    /// start path every such install's XMR wallet would be silently
    /// repointed at pwnda's own wallet-rpc with no user action at all.
    /// 2026-09-04 — the ZEPH/ZANO consent command writes each coin's OWN
    /// field pair and nothing else's, and refuses the coins that share by a
    /// different mechanism. A toggle that landed in the wrong pair would
    /// consent one coin while the user pressed another's button.
    #[test]
    fn cn_host_wallet_consent_writes_the_coins_own_fields_and_refuses_others() {
        let at = "2026-09-04T20:00:00+00:00";
        let mut e = CoinOptIn::default();
        apply_cn_host_wallet_consent("zephyr", &mut e, true, at).unwrap();
        assert_eq!(e.zph_host_wallet_ack_at.as_deref(), Some(at));
        assert!(e.zph_host_wallet_declined_at.is_none());
        assert!(e.zano_host_wallet_ack_at.is_none(), "zano must be untouched");
        assert!(e.xmr_host_wallet_ack_at.is_none(), "monero must be untouched");

        apply_cn_host_wallet_consent("zephyr", &mut e, false, at).unwrap();
        assert!(e.zph_host_wallet_ack_at.is_none());
        assert_eq!(e.zph_host_wallet_declined_at.as_deref(), Some(at));

        apply_cn_host_wallet_consent("zano", &mut e, true, at).unwrap();
        assert_eq!(e.zano_host_wallet_ack_at.as_deref(), Some(at));
        assert!(e.zano_host_wallet_declined_at.is_none());
        // ...and zephyr's decline from a moment ago is still there.
        assert_eq!(e.zph_host_wallet_declined_at.as_deref(), Some(at));

        let err = apply_cn_host_wallet_consent("monero", &mut e, true, at).unwrap_err();
        assert!(err.contains("swap_sidecar_set_xmr_host_wallet"), "{err}");
        let err = apply_cn_host_wallet_consent("bitcoin", &mut e, true, at).unwrap_err();
        assert!(err.contains("swap_sidecar_set_share_wallet"), "{err}");
        // Refusals leave every field as it was.
        assert_eq!(e.zano_host_wallet_ack_at.as_deref(), Some(at));
        assert!(e.xmr_host_wallet_ack_at.is_none());
    }

    /// 2026-09-04 — the status builder used to route zephyr/zano through the
    /// LEAN predicate, which is unconditionally false for both. This pins the
    /// per-coin routing the consent card reads, for all three mechanisms.
    #[test]
    fn share_flags_route_each_coin_through_its_own_sharing_mechanism() {
        let on = CoinOptIn {
            enabled: true,
            mode: CoinMode::Lean,
            ..CoinOptIn::default()
        };
        // Default-on for every capable coin once opted in.
        assert_eq!(share_flags("bitcoin", true, Some(&on), CoinMode::Lean), (true, true));
        assert_eq!(share_flags("bitcoincash", true, Some(&on), CoinMode::Lean), (true, true));
        assert_eq!(share_flags("monero", true, Some(&on), CoinMode::Full), (true, true));
        assert_eq!(share_flags("zephyr", true, Some(&on), CoinMode::Full), (true, true));
        assert_eq!(share_flags("zano", true, Some(&on), CoinMode::Full), (true, true));
        // No sharing choice exists for a full-mode bitcoin-family coin, or for
        // coins with no lean option and no host wallet.
        assert_eq!(share_flags("bitcoin", true, Some(&on), CoinMode::Full), (false, false));
        assert_eq!(share_flags("dogecoin", true, Some(&on), CoinMode::Full), (false, false));
        assert_eq!(share_flags("particl", true, Some(&on), CoinMode::Full), (false, false));

        // Each coin's DECLINE is its own field: declining zephyr must not read
        // as declining zano or monero, and vice versa.
        let mut declined_zph = on.clone();
        declined_zph.zph_host_wallet_declined_at = Some("t".into());
        assert_eq!(share_flags("zephyr", true, Some(&declined_zph), CoinMode::Full), (true, false));
        assert_eq!(share_flags("zano", true, Some(&declined_zph), CoinMode::Full), (true, true));
        assert_eq!(share_flags("monero", true, Some(&declined_zph), CoinMode::Full), (true, true));
        let mut declined_zano = on.clone();
        declined_zano.zano_host_wallet_declined_at = Some("t".into());
        assert_eq!(share_flags("zano", true, Some(&declined_zano), CoinMode::Full), (true, false));
        assert_eq!(share_flags("zephyr", true, Some(&declined_zano), CoinMode::Full), (true, true));
        // A lean decline is the bitcoin-family's and nobody else's.
        let mut declined_lean = on.clone();
        declined_lean.share_wallet_declined_at = Some("t".into());
        assert_eq!(share_flags("bitcoincash", true, Some(&declined_lean), CoinMode::Lean), (true, false));
        assert_eq!(share_flags("zephyr", true, Some(&declined_lean), CoinMode::Full), (true, true));

        // Not opted in, or no record: nothing shares.
        assert_eq!(share_flags("zephyr", false, Some(&on), CoinMode::Full), (true, false));
        assert_eq!(share_flags("zano", true, None, CoinMode::Full), (true, false));
    }

    /// 2026-09-04 — "active" reads each coin's OWN key: the key the engine
    /// branches on for monero/zephyr, and the scratch port for zano, whose
    /// block never carries `mainwalletrpc*` at all.
    #[test]
    fn config_host_wallet_active_reads_each_coins_own_key() {
        let cfg = r#"{"chainclients":{
            "monero":{"mainwalletrpcport":28083},
            "zephyr":{"mainwalletrpcport":28183},
            "zano":{"walletrpcport":18084,"walletrpcjwt":"m","scratchwalletrpcport":18086,"scratchwalletrpcjwt":"s"},
            "bitcoin":{"connection_type":"electrum"}
        }}"#;
        assert!(config_host_wallet_active(cfg, "monero"));
        assert!(config_host_wallet_active(cfg, "zephyr"));
        assert!(config_host_wallet_active(cfg, "zano"));
        assert!(!config_host_wallet_active(cfg, "bitcoin"));
        assert!(!config_host_wallet_active(cfg, "particl"));
        // The old single-coin reader is the same fact, not a second one.
        assert_eq!(config_xmr_host_wallet_active(cfg), config_host_wallet_active(cfg, "monero"));

        // A zano block WITHOUT the scratch port — consented, node not yet
        // restarted, or Main was not running at start — is not active.
        let zano_unstarted = r#"{"chainclients":{"zano":{"walletrpcport":18084}}}"#;
        assert!(!config_host_wallet_active(zano_unstarted, "zano"));
        // Zephyr's key on monero's block must not read as zephyr active.
        let only_xmr = r#"{"chainclients":{"monero":{"mainwalletrpcport":28083}}}"#;
        assert!(!config_host_wallet_active(only_xmr, "zephyr"));
        assert!(!config_host_wallet_active("not json", "monero"));
    }

    /// 2026-09-04 — the host-wallet coin block path. prepare never sees these
    /// coins; the block comes from the engine's own segment and the policy
    /// parks or runs it per session.
    #[test]
    fn prepare_coins_leaves_host_wallet_coins_to_the_supervisor() {
        let all: Vec<String> = WALLET_SIDECAR_COINS.iter().map(|c| c.to_string()).collect();
        let kept = prepare_coins(&all);
        for c in HOST_MANAGED_DAEMON_COINS {
            assert!(!kept.iter().any(|k| k == c), "{c} must not reach --withcoins");
        }
        for c in ["particl", "bitcoin", "monero", "bitcoincash"] {
            assert!(kept.iter().any(|k| k == c), "{c} must still reach --withcoins");
        }
    }

    #[test]
    fn split_daemon_url_yields_the_rpchost_rpcport_pair() {
        assert_eq!(
            split_daemon_url("http://remote-node.zephyrprotocol.com:17767"),
            Some(("remote-node.zephyrprotocol.com".to_string(), 17767))
        );
        assert_eq!(
            split_daemon_url("http://37.27.100.59:10500/"),
            Some(("37.27.100.59".to_string(), 10500))
        );
        assert_eq!(split_daemon_url("nonsense"), None);
        assert_eq!(split_daemon_url("http://:10"), None);
        // Both bootstrap constants parse — a typo there would park nothing and
        // point the engine at localhost.
        assert!(host_wallet_coin_daemon("zephyr").is_some());
        assert!(host_wallet_coin_daemon("zano").is_some());
        assert!(host_wallet_coin_daemon("bitcoin").is_none());
    }

    #[test]
    fn insert_chainclient_block_adds_once_and_never_overwrites() {
        let cfg = r#"{"chainclients":{"particl":{"connection_type":"rpc"}}}"#;
        let seg = serde_json::json!({"connection_type":"rpc","walletrpcjwt":""});
        let out = insert_chainclient_block(cfg, "zano", seg.clone()).unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["chainclients"]["zano"]["walletrpcjwt"], "");
        assert_eq!(v["chainclients"]["particl"]["connection_type"], "rpc");
        // Second insert is a no-op: the existing block may carry live secrets.
        let live = out.replace(r#""walletrpcjwt": """#, r#""walletrpcjwt": "live-secret""#);
        assert!(live.contains("live-secret"), "fixture must have the live value");
        assert!(insert_chainclient_block(&live, "zano", seg).unwrap().is_none());
        assert!(insert_chainclient_block(r#"{"foo":1}"#, "zano", serde_json::json!({})).is_err());
    }

    #[test]
    fn host_wallet_policy_parks_or_runs_and_always_pins_the_remote_daemon() {
        let dir = std::env::temp_dir().join(format!("pwnda-hw-policy-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let cfg = r#"{"chainclients":{
            "zano":{"connection_type":"rpc","manage_daemon":false,"manage_wallet_daemon":false,
                    "rpchost":"127.0.0.1","rpcport":22212,"walletrpcport":18084,"walletrpcjwt":""},
            "particl":{"connection_type":"rpc","manage_daemon":true}
        }}"#;
        std::fs::write(dir.join("basicswap.json"), cfg).unwrap();

        // Not available this session -> parked.
        assert_eq!(apply_host_wallet_coin_policy(&dir, "zano", false).unwrap(), Some(false));
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("basicswap.json")).unwrap()).unwrap();
        let z = &v["chainclients"]["zano"];
        assert_eq!(z["connection_type"], "none");
        assert_eq!(z["rpchost"], "37.27.100.59", "the remote bootstrap, never localhost");
        assert_eq!(z["rpcport"], 10500);
        assert_eq!(z["startup_tries"], HOST_WALLET_STARTUP_TRIES);
        assert_eq!(z["startup_delay"], HOST_WALLET_STARTUP_DELAY_SECS);
        assert_eq!(z["manage_daemon"], false);
        assert_eq!(z["manage_wallet_daemon"], false);
        // Untouched keys survive; particl is not this function's business.
        assert_eq!(z["walletrpcport"], 18084);
        assert_eq!(v["chainclients"]["particl"]["manage_daemon"], true);
        assert_eq!(config_coin_active(&v.to_string(), "zano"), Some(false));

        // Available -> runs.
        assert_eq!(apply_host_wallet_coin_policy(&dir, "zano", true).unwrap(), Some(true));
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("basicswap.json")).unwrap()).unwrap();
        assert_eq!(v["chainclients"]["zano"]["connection_type"], "rpc");
        assert_eq!(config_coin_active(&v.to_string(), "zano"), Some(true));
        // No block -> None, and nothing written.
        assert_eq!(apply_host_wallet_coin_policy(&dir, "zephyr", true).unwrap(), None);
        assert_eq!(config_coin_active(&v.to_string(), "zephyr"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The script hands the segment work to the engine's OWN module — the
    /// one place the key set lives — and never types a key itself.
    #[test]
    fn host_wallet_segment_script_names_the_engine_module_not_a_copy() {
        for coin in HOST_MANAGED_DAEMON_COINS {
            let s = host_wallet_segment_script(coin);
            assert!(s.contains(&format!("basicswap.interface.{coin}.core")), "{s}");
            assert!(s.contains("getConfigSegment(ctx)"), "{s}");
            assert!(s.contains("should_manage_daemon=lambda c: False"), "{s}");
            assert!(!s.contains("walletrpcjwt"), "the script must not carry keys of its own: {s}");
        }
    }

    #[test]
    fn a_default_enabled_monero_never_reads_as_xmr_host_wallet_consented() {
        assert!(DEFAULT_ENABLED_COINS.contains(&"monero"));
        let fresh = CoinOptIn::default();
        assert!(fresh.xmr_host_wallet_ack_at.is_none());
        // And the same for a record written before this field existed.
        let legacy: OptInRecord = serde_json::from_str(
            r#"{"optedIn":true,"coins":{"monero":{"enabled":true,"mode":"full"}}}"#,
        )
        .expect("a pre-C9 record must still deserialize");
        assert!(legacy.coins["monero"].xmr_host_wallet_ack_at.is_none());
    }

    /// The env var reaches the RUN plan — unlike the wallet-encryption
    /// password, which run.py refuses. PWNDA-PATCH-3 reads it inside the
    /// The engine reconcile must be unable to run under a live node, and must
    /// be reachable from the start path — the two properties that make it safe
    /// and make it actually fire.
    ///
    /// Source-level because both are about WHERE the call sits: a unit test
    /// with an `AppHandle` cannot be built here, and the failure mode is
    /// ordering (reconcile after a spawn would swap files under a running
    /// engine), which no runtime assertion in this process would catch.
    #[test]
    fn the_engine_reconcile_runs_before_anything_spawns_and_never_while_running() {
        let f: &str = include_str!("swap_sidecar.rs");
        // 1. The start path calls it...
        let start = &f[f
            .find("pub async fn swap_sidecar_start(")
            .expect("start moved")..];
        let call_at = start
            .find("reconcile_bundled_engine(&app, false)")
            .expect("the start path must reconcile the engine");
        // ...before it builds the config or spawns anything.
        let spawn_at = start
            .find("start_node_core(")
            .expect("start must still call start_node_core");
        assert!(
            call_at < spawn_at,
            "the engine must be replaced BEFORE the node launches, never after"
        );

        // 2. The function itself refuses when told the node is running.
        let body = &f[f
            .find("pub async fn reconcile_bundled_engine(")
            .expect("reconcile moved")..];
        let body = &body[..body.find("/// Renderer-facing wrapper").expect("end moved")];
        assert!(
            body.contains("if !read_optin(app).opted_in || running {"),
            "a running node (or an un-opted-in wallet) must short-circuit before any write"
        );
        assert!(
            body.contains("return Ok(None);"),
            "the running case returns, it does not fall through"
        );

        // 3. It extracts into the sidecar base, which holds runtime/ and bin/
        //    — never into datadir/, where the wallets and the database live.
        assert!(
            body.contains("extract_encrypted_bundle(&resource_dir, \"grove\", &base)"),
            "the reconcile must unpack the grove payload into the sidecar base"
        );
        assert!(
            !body.contains("datadir"),
            "the reconcile must not name the datadir at all"
        );
    }

    /// running node, so keeping it out of `shared_envs` would disarm the
    /// fail-closed guard exactly where it is needed.
    #[test]
    fn account_key_coins_reach_the_run_plan_and_are_absent_when_unused() {
        let mut cfg = test_config();
        cfg.adoption_coins = vec!["btc".into(), "ltc".into()];
        let plan = build_run_plan(&cfg);
        let got = plan
            .envs
            .iter()
            .find(|(k, _)| k == "BSX_PWNDA_ACCOUNT_KEY_COINS")
            .map(|(_, v)| v.clone());
        assert_eq!(got.as_deref(), Some("btc,ltc"), "{:?}", plan.envs);

        // Absent, not empty: the patch treats "" and unset identically, and an
        // empty-but-present value reads as deliberate to anyone debugging.
        let mut clean = test_config();
        clean.adoption_coins = Vec::new();
        assert!(
            !build_run_plan(&clean)
                .envs
                .iter()
                .any(|(k, _)| k == "BSX_PWNDA_ACCOUNT_KEY_COINS"),
            "an install without shared wallets must not set the variable at all"
        );
    }

    /// The address comparison is C8's only line of defence against the engine
    /// standing up a wallet nobody intended.
    #[test]
    fn account_key_mismatch_catches_a_different_wallet() {
        let ours = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

        assert!(account_key_mismatch("BTC", Some(ours), ours).is_none());
        // Case is not a mismatch: bech32 is case-insensitive by spec, and
        // failing on it would report a fault that does not exist.
        assert!(
            account_key_mismatch("BTC", Some(&ours.to_uppercase()), ours).is_none(),
            "bech32 case must not read as a different wallet"
        );

        let wrong = account_key_mismatch("BTC", Some("bc1qsomeotheraddress"), ours);
        assert!(wrong.is_some());
        let msg = wrong.unwrap();
        assert!(msg.contains("FAILED"), "{msg}");
        assert!(msg.contains("not active"), "must say what it means: {msg}");

        // No address yet is "the wallets are still locked", which is the
        // ordinary push-before-unlock order — not a wrong wallet.
        assert!(
            account_key_mismatch("BTC", None, ours).is_none(),
            "a pending initialisation must not be reported as a mismatch"
        );
    }

    // ── C8 for BCH (Grove expansion plan, Phase C, unit C-RB) ──────────
    //
    // `account_key_mismatch` above is already coin-agnostic — it never
    // inspects the ticker, only compares two address strings — so BCH
    // needs no new production code to be protected by it (the "additive
    // only" nature of this unit's OWNS). What was UNPROVEN was that a BCH
    // cashaddr string computed on the Rust side and one computed on the
    // TypeScript side, for the SAME seed and the SAME path
    // (`m/44'/145'/0'/0/0`), are the exact same bytes — if they were not,
    // C8 for BCH would deadlock EVERY install (the mismatch check would
    // always fire) rather than fail loudly once for a real wrong wallet.

    /// PRODUCE (this unit): the account node at `m/44'/145'/0'`,
    /// `address_type: "p2pkh"`, proven — not assumed — to round-trip
    /// byte-identically against `src/wallets/bch-wallet.ts`'s `bchAdapter`
    /// cashaddr encoding for the same key, with a real negative control.
    ///
    /// # How the round trip was actually proven
    ///
    /// Three independent implementations were run against the standard
    /// test mnemonic (the world-public `"abandon … about"` vector this
    /// whole repo uses, e.g. `VITE_SKIP_AUTH`) at `m/44'/145'/0'/0/0`:
    ///
    /// 1. Rust: [`crate::swap::derive::utxo_address`] (`UtxoChain::Bch`,
    ///    account 0, index 0) — pinned by
    ///    `crate::swap::derive::tests::vector_bch_cashaddr_p2pkh`, itself
    ///    checked against "electron-cash and the BCH BIP-44 reference
    ///    tools" per that test's own doc comment.
    /// 2. TypeScript: `bchAdapter.deriveFromMnemonic` in `bch-wallet.ts`,
    ///    run LIVE via `npx vitest run` against a throwaway, uncommitted
    ///    test file for this unit, which printed
    ///    `BCH_ADDR=bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6` —
    ///    see `PwndaWalletVault/log.md`'s "unit C-RB" entry for the
    ///    verbatim transcript.
    /// 3. The same string is ALSO the pre-existing fixture used by
    ///    `src/lib/tauri-mocks.ts`, `src/wallets/bch-account-send.test.ts`
    ///    and `src/features/swap/useSwapQuote.ts` — a fourth, independent
    ///    confirmation that predates this unit.
    ///
    /// All four agree, byte-for-byte, on the identical 43-character
    /// string. This test pins that agreement: a change to either
    /// implementation that broke it (wrong version byte, wrong polymod
    /// constants, wrong bit-grouping, wrong derivation path) goes red here
    /// before it ever reaches a fresh install.
    #[test]
    fn bch_account_key_round_trips_byte_identically_against_bch_wallet_ts() {
        use crate::swap::derive::{mnemonic_to_seed, utxo_address, UtxoChain};

        const ABANDON_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon about";
        // The TypeScript side of the proof — see the doc comment above for
        // how this was obtained. NOT copied from the Rust vector without
        // independently re-deriving it.
        const TS_BCHADAPTER_ADDRESS: &str =
            "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6";

        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").expect("valid BIP-39 vector");

        // The WALLET side of C8: what `swapAccountKey.ts` would compute as
        // `expectedAddress` for this account's index-0 receive address.
        let rust_addr =
            utxo_address(&seed[..], UtxoChain::Bch, 0, 0).expect("BCH P2PKH derivation");

        assert_eq!(
            rust_addr, TS_BCHADAPTER_ADDRESS,
            "Rust's cashaddr derivation and bch-wallet.ts's bchAdapter must \
             produce the IDENTICAL address for the same key, or C8 sharing \
             deadlocks every BCH install"
        );

        // The comparison C8 actually performs at runtime: the engine's own
        // derived address against the wallet's, coin-agnostically, via
        // `account_key_mismatch`. Standing in for "the engine" here is the
        // SAME independently-agreed value — that agreement is exactly what
        // the assertion above establishes.
        assert!(
            account_key_mismatch("BCH", Some(&rust_addr), &rust_addr).is_none(),
            "a genuine round trip must not be reported as a mismatch"
        );

        // ---- Negative control ------------------------------------------
        // Per this unit's GATE: prove the check can actually FAIL, with a
        // deliberately wrong derivation — index 1 instead of 0, a REAL,
        // different address on the same seed and coin, not a typo.
        // (Verified by temporarily flipping the final assertion below to
        // `.is_none()` and confirming it failed red, then reverting to the
        // correct `.is_some()` shown here — see this unit's UNIT_RESULT.)
        let wrong_index_addr =
            utxo_address(&seed[..], UtxoChain::Bch, 0, 1).expect("BCH P2PKH derivation");
        assert_ne!(
            wrong_index_addr, rust_addr,
            "the negative control must be a REAL different address — a \
             mismatch test that compares equal strings cannot fail either"
        );
        // The prefix is optional in CashAddr, and only the MAINNET one is
        // stripped: the same address written both ways is one address, a
        // testnet address is still a different one. Added 2026-09-05 so a
        // formatting choice on either side can never be reported to the user
        // as "shared-wallet check FAILED".
        let bare = rust_addr.strip_prefix("bitcoincash:").expect("mainnet cashaddr");
        assert!(
            account_key_mismatch("BCH", Some(bare), &rust_addr).is_none(),
            "the same address without its prefix is the same address"
        );
        assert!(
            account_key_mismatch("BCH", Some(&rust_addr.to_uppercase()), &rust_addr).is_none(),
            "cashaddr is case-insensitive"
        );
        assert!(
            account_key_mismatch("BCH", Some(&format!("bchtest:{}", bare)), &rust_addr).is_some(),
            "a testnet address must NOT pass as its mainnet twin"
        );
        assert!(
            account_key_mismatch("BTC", Some(bare), &rust_addr).is_some(),
            "the prefix rule is BCH's alone — no other coin gets a looser check"
        );
        let mismatch = account_key_mismatch("BCH", Some(&wrong_index_addr), &rust_addr);
        assert!(
            mismatch.is_some(),
            "a genuinely different BCH derivation must be caught as a \
             wallet mismatch, not silently accepted"
        );
        let msg = mismatch.unwrap();
        assert!(msg.contains("BCH"), "{msg}");
        assert!(msg.contains("FAILED"), "{msg}");
    }

    /// GATE (this unit): "adoption stays deposit ... if the round-trip
    /// fails at runtime". `swap_sidecar_push_account_keys` is only
    /// mock-testable through a live network round trip — this crate carries
    /// no HTTP-mock dependency (`Cargo.toml` has none) — so, following this
    /// file's own established pattern for this exact command
    /// (`the_env_guard_and_the_push_gate_agree`,
    /// `account_key_coins_reach_the_run_plan_and_are_absent_when_unused`),
    /// the control-flow guarantee is pinned two ways: the pure predicate it
    /// depends on, fed a real BCH mismatch; and a source-position check
    /// that the ONLY line writing `adopted.push` sits after the mismatch
    /// match's success arm, not before or outside it.
    #[test]
    fn bch_mismatch_at_runtime_cannot_flip_adoption_away_from_deposit() {
        // The default for an untouched coin is Deposit, never AccountKey —
        // BCH gets nothing special here; there is no coin-specific default
        // anywhere in this file.
        let fresh = CoinOptIn::default();
        assert_eq!(fresh.adoption, Adoption::Deposit);

        // A BCH mismatch, fed through the exact predicate the command
        // gates on.
        let mismatch = account_key_mismatch(
            "BCH",
            Some("bitcoincash:qp8sfdhgjlq68hlzka9lcsxtcnvuvnd0xqxugfzzc5"),
            "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
        );
        assert!(mismatch.is_some(), "the fixture must itself be a real mismatch");

        // The source: `adopted.push` must sit textually AFTER the mismatch
        // match's `None => {` (success) arm, which is itself after the
        // `Some(reason) => {` (failure) arm — the exact shape read at
        // swap_sidecar.rs:9202-9224 when this test was written. A refactor
        // that hoisted the push outside the match, or above the success
        // arm, goes red here rather than silently starting to adopt a
        // mismatched wallet.
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");
        let cmd_at = THIS_FILE
            .find("pub async fn swap_sidecar_push_account_keys(")
            .expect("the push command must exist");
        let body = &THIS_FILE[cmd_at..(cmd_at + 8000).min(THIS_FILE.len())];

        let match_at = body
            .find("match account_key_mismatch(&ticker, addr.as_deref(), &k.expected_address)")
            .expect("the mismatch match must gate adoption");
        let some_at = body[match_at..]
            .find("Some(reason) => {")
            .map(|p| p + match_at)
            .expect("the failure arm must exist");
        let none_at = body[match_at..]
            .find("None => {")
            .map(|p| p + match_at)
            .expect("the success arm must exist");
        let push_at = body[match_at..]
            .find("adopted.push(ticker.clone())")
            .map(|p| p + match_at)
            .expect("the adoption write must exist");

        assert!(
            match_at < some_at && some_at < none_at,
            "expected the failure arm before the success arm in the mismatch \
             match:\n{body}"
        );
        assert!(
            push_at > none_at,
            "adopted.push must sit inside the mismatch match's None \
             (success) arm, never before or outside it:\n{body}"
        );
    }

    /// The push endpoint takes a private key. It must be Rust-only in both
    /// directions: reachable through `privileged_post`, and refused by
    /// `check_endpoint` so no renderer call can reach it.
    #[test]
    fn the_account_key_endpoint_is_privileged_and_webview_denied() {
        assert!(PRIVILEGED_POST_PATHS.contains(&"pwndasetaccountkey"));
        assert!(DENIED_ENDPOINTS.contains(&"pwndasetaccountkey"));

        // check_endpoint ALONE must reject, so this cannot pass on the
        // denylist doing the work — the same discipline as
        // `unlock_and_setpassword_stay_webview_denied`.
        let segs = vec!["pwndasetaccountkey".to_string()];
        for m in [ApiMethod::Get, ApiMethod::Post] {
            assert!(
                check_endpoint(&segs, m).is_err(),
                "check_endpoint alone must reject the account-key push ({:?})",
                m
            );
        }
        // …and every spelling the URL builder normalises to it.
        for probe in [
            "/json/pwndasetaccountkey",
            "json/PwndaSetAccountKey",
            "//pwndasetaccountkey?x=1",
        ] {
            assert!(
                build_api_url(12700, probe, ApiMethod::Post).is_err(),
                "the renderer must not reach {probe}"
            );
        }
    }

    /// C9 — sharing the wallet's own monero-wallet-rpc is only safe on an
    /// engine that keeps per-swap wallets off it. On an UNPATCHED engine
    /// `mainwalletrpcport` is a key nobody reads, so writing it would leave the
    /// caller believing the wallets were shared while the engine quietly ran
    /// Enabling a host-managed follower must NOT flip `manage_daemon` on.
    ///
    /// The bug this pins (fixed 2026-09-03): this function wrote
    /// `manage_daemon = <coin is enabled>` for every rpc-mode chainclient, so
    /// enabling ZANO or ZEPH told the engine to spawn its own daemon —
    /// overriding the `False` each follower's `core.py` hardcodes, and, for
    /// zano, aborting startup outright because `bin/run.py` has no launcher
    /// that can start `zanod`.
    ///
    /// It is asserted HERE, in Rust, on the bytes actually written, rather
    /// than by reading the Python that sets the default. The check that missed
    /// it read `zephyr/core.py`, found the hardcoded `False`, and concluded the
    /// toggle was bypassed — a check that could not observe the write that
    /// undid it, because that write happens in another language in another
    /// process. The only place both halves meet is the JSON on disk.
    #[test]
    fn enabling_a_host_managed_follower_leaves_manage_daemon_false() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-hostmanaged-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "chainclients": {
                    // Both followers start where their core.py leaves them.
                    "zephyr":  {"connection_type": "rpc", "manage_daemon": false},
                    "zano":    {"connection_type": "rpc", "manage_daemon": false},
                    "monero":  {"connection_type": "rpc", "manage_daemon": false},
                    // A normal engine-managed coin, as the positive control:
                    // without it this test would still pass if the function
                    // simply stopped writing anything at all.
                    "litecoin": {"connection_type": "rpc", "manage_daemon": false}
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let enabled: Vec<String> = ["zephyr", "zano", "monero", "litecoin"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        apply_coin_enablement_to_config(&dir, &enabled).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("basicswap.json")).unwrap())
                .unwrap();
        let md = |coin: &str| {
            v.pointer(&format!("/chainclients/{}/manage_daemon", coin))
                .and_then(|x| x.as_bool())
        };

        for coin in HOST_MANAGED_DAEMON_COINS {
            assert_eq!(
                md(coin),
                Some(false),
                "{coin} is host-managed: enabling it must not ask the engine to                  run its daemon (this app owns that process)"
            );
        }
        // Monero is the SUBTLE control: its wallet-rpc is host-owned, but its
        // daemon may legitimately be local, so it must still be flipped on.
        // An earlier draft of HOST_MANAGED_DAEMON_COINS included it and broke
        // `the_xmr_node_pin_overrules_a_monero_enable`; asserting it here too
        // keeps the distinction pinned from both sides.
        assert_eq!(
            md("monero"),
            Some(true),
            "monero's DAEMON is engine-managed unless a remote node is pinned —              only its wallet-rpc is host-owned"
        );
        // Positive control: the function still does its job for coins the
        // engine really does manage.
        assert_eq!(
            md("litecoin"),
            Some(true),
            "an engine-managed coin must still be flipped on when enabled —              otherwise this test passes for the wrong reason"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// its own — with the user's XMR where no swap can reach it.
    #[test]
    fn host_xmr_wallet_is_refused_on_an_unpatched_engine() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-c9-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let pkg = dir.join("basicswap");
        std::fs::create_dir_all(pkg.join("interface").join("xmr")).unwrap();
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "chainclients": { "monero": { "rpcport": 18081 } }
            }))
            .unwrap(),
        )
        .unwrap();

        let xmr_py = pkg.join("interface").join("xmr").join("xmr.py");

        // Unpatched: the marker is absent.
        std::fs::write(&xmr_py, "class XMRInterface:\n    pass\n").unwrap();
        assert!(!engine_has_patch(&pkg, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-5"));
        let refused = apply_host_xmr_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28083, "u", "p", "wallet",
        );
        let msg = refused.expect_err("an unpatched engine must be refused");
        assert!(msg.contains("0005"), "the message must name the patch: {msg}");
        let after = std::fs::read_to_string(dir.join("basicswap.json")).unwrap();
        assert!(
            !after.contains("mainwalletrpcport"),
            "a refusal must not have written anything: {after}"
        );

        // PATCH-5 present, PATCH-8 absent: still refused, and the message
        // names 0008 specifically — the half-applied state is worse than
        // neither being applied (checkWalletSeed would refuse every swap
        // while publishBLockTx sends with no wrong-wallet guard), so it must
        // not be silently treated as "good enough".
        std::fs::write(&xmr_py, "# PWNDA-PATCH-5: split clients\n").unwrap();
        let bsw_py = dir.join("basicswap").join("basicswap.py");
        std::fs::write(&bsw_py, "class BasicSwap:\n    pass\n").unwrap();
        let half_refused = apply_host_xmr_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28083, "u", "p", "wallet",
        );
        let half_msg = half_refused.expect_err("PATCH-5-only must still be refused");
        assert!(half_msg.contains("0008"), "the message must name the patch: {half_msg}");

        // Patched: the write goes through, and is idempotent.
        std::fs::write(
            &xmr_py,
            "# PWNDA-PATCH-5: split clients\n# PWNDA-PATCH-8: guard the transfer\n",
        )
        .unwrap();
        std::fs::write(
            &bsw_py,
            "class BasicSwap:\n    pass  # PWNDA-PATCH-8: accept host wallet\n",
        )
        .unwrap();
        assert!(engine_has_patch(&pkg, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-5"));
        assert!(engine_has_patch(&pkg, XMR_SPLIT_PATCH_FILE, "PWNDA-PATCH-8"));
        assert!(engine_has_patch(
            &pkg,
            XMR_HOST_WALLET_CHECKS_PATCH_FILE,
            "PWNDA-PATCH-8"
        ));
        assert!(
            apply_host_xmr_wallet_to_config(&dir, &pkg, "127.0.0.1", 28083, "u", "p", "mine")
                .unwrap(),
            "the first write must report a change"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("basicswap.json")).unwrap())
                .unwrap();
        let m = &v["chainclients"]["monero"];
        assert_eq!(m["mainwalletrpcport"], 28083);
        assert_eq!(m["mainwalletrpchost"], "127.0.0.1");
        assert_eq!(
            m["mainwalletrpcauth"],
            serde_json::json!(["u", "p"]),
            "must be a 2-element ARRAY, not a joined string -- callrpc_xmr 
             (rpc_xmr.py) does auth[0]/auth[1], and a string would silently 
             index by character instead of raising"
        );
        // The engine opens `wallet_name` as its main wallet — this is the key
        // that makes "main wallet" mean the user's file.
        assert_eq!(m["wallet_name"], "mine");
        // Untouched keys stay untouched.
        assert_eq!(m["rpcport"], 18081);

        assert!(
            !apply_host_xmr_wallet_to_config(&dir, &pkg, "127.0.0.1", 28083, "u", "p", "mine")
                .unwrap(),
            "an unchanged config must report no write"
        );

        // A coin block that does not exist is a no-op, not an error: inventing
        // one would mean inventing every key upstream's own config writer fills.
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({ "chainclients": {} })).unwrap(),
        )
        .unwrap();
        assert!(
            !apply_host_xmr_wallet_to_config(&dir, &pkg, "127.0.0.1", 28083, "u", "p", "mine")
                .unwrap()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C-RZ's twin of `host_xmr_wallet_is_refused_on_an_unpatched_engine` —
    /// same assertions, ZEPH types/markers/files, gated on 13 AND 14 per
    /// this unit's own brief (rather than 5/8's two-hunk shape, since ZEPH
    /// has no analogous third marker — see `apply_host_zph_wallet_to_config`'s
    /// own doc comment for why).
    #[test]
    fn host_zph_wallet_is_refused_on_an_unpatched_engine() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-c-rz-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let pkg = dir.join("basicswap");
        std::fs::create_dir_all(pkg.join("interface").join("zephyr")).unwrap();
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "chainclients": { "zephyr": { "rpcport": 17767 } }
            }))
            .unwrap(),
        )
        .unwrap();

        let zephyr_py = pkg.join("interface").join("zephyr").join("zephyr.py");

        // Unpatched: the marker is absent.
        std::fs::write(&zephyr_py, "class ZEPHInterface:\n    pass\n").unwrap();
        assert!(!engine_has_patch(&pkg, ZEPH_MODULE_PATCH_FILE, "PWNDA-PATCH-13"));
        let refused = apply_host_zph_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28183, "u", "p", "wallet",
        );
        let msg = refused.expect_err("an unpatched engine must be refused");
        assert!(msg.contains("0013"), "the message must name the patch: {msg}");
        let after = std::fs::read_to_string(dir.join("basicswap.json")).unwrap();
        assert!(
            !after.contains("mainwalletrpcport"),
            "a refusal must not have written anything: {after}"
        );

        // PATCH-13 present, PATCH-14 absent: still refused, and the message
        // names 0014 specifically.
        std::fs::write(&zephyr_py, "# PWNDA-PATCH-13: coin module\n").unwrap();
        let bsw_py = dir.join("basicswap").join("basicswap.py");
        std::fs::write(&bsw_py, "class BasicSwap:\n    pass\n").unwrap();
        let half_refused = apply_host_zph_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28183, "u", "p", "wallet",
        );
        let half_msg = half_refused.expect_err("PATCH-13-only must still be refused");
        assert!(half_msg.contains("0014"), "the message must name the patch: {half_msg}");

        // Patched: the write goes through, and is idempotent.
        std::fs::write(
            &bsw_py,
            "class BasicSwap:\n    pass  # PWNDA-PATCH-14: register zephyr\n",
        )
        .unwrap();
        assert!(engine_has_patch(&pkg, ZEPH_MODULE_PATCH_FILE, "PWNDA-PATCH-13"));
        assert!(engine_has_patch(&pkg, ZEPH_REGISTRATION_PATCH_FILE, "PWNDA-PATCH-14"));
        assert!(
            apply_host_zph_wallet_to_config(&dir, &pkg, "127.0.0.1", 28183, "u", "p", "mine")
                .unwrap(),
            "the first write must report a change"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("basicswap.json")).unwrap())
                .unwrap();
        let z = &v["chainclients"]["zephyr"];
        assert_eq!(z["mainwalletrpcport"], 28183);
        assert_eq!(z["mainwalletrpchost"], "127.0.0.1");
        assert_eq!(
            z["mainwalletrpcauth"],
            serde_json::json!(["u", "p"]),
            "must be a 2-element ARRAY, not a joined string — same auth[0]/auth[1] \
             reasoning as apply_host_xmr_wallet_to_config"
        );
        assert_eq!(z["wallet_name"], "mine");
        // Untouched keys stay untouched.
        assert_eq!(z["rpcport"], 17767);

        assert!(
            !apply_host_zph_wallet_to_config(&dir, &pkg, "127.0.0.1", 28183, "u", "p", "mine")
                .unwrap(),
            "an unchanged config must report no write"
        );

        // A coin block that does not exist is a no-op, not an error.
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({ "chainclients": {} })).unwrap(),
        )
        .unwrap();
        assert!(
            !apply_host_zph_wallet_to_config(&dir, &pkg, "127.0.0.1", 28183, "u", "p", "mine")
                .unwrap()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C-RX's twin of `host_xmr_wallet_is_refused_on_an_unpatched_engine` /
    /// `host_zph_wallet_is_refused_on_an_unpatched_engine` — same shape,
    /// ZANO types/markers/files/keys, but THREE markers (15, 16, 17) rather
    /// than two, and the config keys differ (single `walletrpcjwt`/
    /// `scratchwalletrpcjwt` secrets, `walletrpcport`/`scratchwalletrpcport`
    /// for the two instances, `external_main_wallet`) rather than XMR/ZEPH's
    /// `mainwalletrpc*` four.
    #[test]
    fn host_zano_wallet_is_refused_on_an_unpatched_engine() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-c-rx-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let pkg = dir.join("basicswap");
        std::fs::create_dir_all(pkg.join("interface").join("zano")).unwrap();
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "chainclients": { "zano": { "rpcport": 11211 } }
            }))
            .unwrap(),
        )
        .unwrap();

        let zano_py = pkg.join("interface").join("zano").join("zano.py");
        let bsw_py = dir.join("basicswap").join("basicswap.py");

        // Unpatched: every marker absent.
        std::fs::write(&zano_py, "class ZanoInterface:\n    pass\n").unwrap();
        assert!(!engine_has_patch(&pkg, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-15"));
        let refused = apply_host_zano_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28084, "main-jwt", 28086, "scratch-jwt",
        );
        let msg = refused.expect_err("an unpatched engine must be refused");
        assert!(msg.contains("0015"), "the message must name the patch: {msg}");
        let after = std::fs::read_to_string(dir.join("basicswap.json")).unwrap();
        assert!(
            !after.contains("walletrpcjwt"),
            "a refusal must not have written anything: {after}"
        );

        // PATCH-15 present, 16/17 absent: still refused, naming 0016 first.
        std::fs::write(&zano_py, "# PWNDA-PATCH-15: coin module\n").unwrap();
        std::fs::write(&bsw_py, "class BasicSwap:\n    pass\n").unwrap();
        let half_refused = apply_host_zano_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28084, "main-jwt", 28086, "scratch-jwt",
        );
        let half_msg = half_refused.expect_err("PATCH-15-only must still be refused");
        assert!(half_msg.contains("0016"), "the message must name the patch: {half_msg}");

        // 15 + 16 present, 17 absent: still refused, naming 0017 — the
        // fund-safety guard is the LAST gate, not skippable once the wiring
        // exists, mirroring why XMR's own 0008 gate cannot be bypassed by
        // 0005 alone.
        std::fs::write(
            &bsw_py,
            "class BasicSwap:\n    pass  # PWNDA-PATCH-16: register zano\n",
        )
        .unwrap();
        let guard_refused = apply_host_zano_wallet_to_config(
            &dir, &pkg, "127.0.0.1", 28084, "main-jwt", 28086, "scratch-jwt",
        );
        let guard_msg = guard_refused.expect_err("PATCH-15+16-only must still be refused");
        assert!(guard_msg.contains("0017"), "the message must name the patch: {guard_msg}");

        // Fully patched: the write goes through, and is idempotent.
        std::fs::write(
            &zano_py,
            "# PWNDA-PATCH-15: coin module\n# PWNDA-PATCH-17: guard the transfer\n",
        )
        .unwrap();
        assert!(engine_has_patch(&pkg, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-15"));
        assert!(engine_has_patch(&pkg, ZANO_REGISTRATION_PATCH_FILE, "PWNDA-PATCH-16"));
        assert!(engine_has_patch(&pkg, ZANO_MODULE_PATCH_FILE, "PWNDA-PATCH-17"));
        assert!(
            apply_host_zano_wallet_to_config(
                &dir, &pkg, "127.0.0.1", 28084, "main-jwt", 28086, "scratch-jwt",
            )
            .unwrap(),
            "the first write must report a change"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("basicswap.json")).unwrap())
                .unwrap();
        let z = &v["chainclients"]["zano"];
        assert_eq!(z["walletrpchost"], "127.0.0.1");
        assert_eq!(z["walletrpcport"], 28084);
        assert_eq!(
            z["walletrpcjwt"], "main-jwt",
            "Main's secret is a single JWT string, not a (user, pass) array — \
             Zano's auth scheme differs from XMR/ZEPH's Digest pair"
        );
        assert_eq!(z["scratchwalletrpcport"], 28086);
        assert_eq!(z["scratchwalletrpcjwt"], "scratch-jwt");
        assert_eq!(
            z["external_main_wallet"], true,
            "without this flag ZanoInterface.initialiseWallet runs REU26's \
             engine-owned-wallet path against a wallet-rpc Grove never intends \
             the engine to provision"
        );
        // Untouched keys stay untouched.
        assert_eq!(z["rpcport"], 11211);

        assert!(
            !apply_host_zano_wallet_to_config(
                &dir, &pkg, "127.0.0.1", 28084, "main-jwt", 28086, "scratch-jwt",
            )
            .unwrap(),
            "an unchanged config must report no write"
        );

        // A coin block that does not exist is a no-op, not an error.
        std::fs::write(
            dir.join("basicswap.json"),
            serde_json::to_string_pretty(&serde_json::json!({ "chainclients": {} })).unwrap(),
        )
        .unwrap();
        assert!(
            !apply_host_zano_wallet_to_config(
                &dir, &pkg, "127.0.0.1", 28084, "main-jwt", 28086, "scratch-jwt",
            )
            .unwrap()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing file must read as "not patched", never as "patched" — the
    /// direction matters, because the marker gates a refusal.
    #[test]
    fn a_missing_engine_file_is_not_patched() {
        assert!(!engine_has_patch(
            std::path::Path::new("/nonexistent-engine-dir"),
            ACCOUNT_KEY_PATCH_FILE,
            "PWNDA-PATCH-3"
        ));
    }

    /// The figure rendered beside the enable toggle must describe what the node
    /// WILL do, not what has been asked for.
    #[test]
    fn disk_figure_follows_the_config_not_the_request() {
        // Nothing configured yet: the request is all there is.
        assert_eq!(effective_mode(CoinMode::Lean, None), CoinMode::Lean);
        assert_eq!(effective_mode(CoinMode::Full, None), CoinMode::Full);

        // Configured: the config wins, in BOTH directions.
        assert_eq!(
            effective_mode(CoinMode::Lean, Some(CoinMode::Full)),
            CoinMode::Full,
            "a coin already syncing a local chain must not report as lean"
        );
        assert_eq!(
            effective_mode(CoinMode::Full, Some(CoinMode::Lean)),
            CoinMode::Lean,
            "a request the node has not acted on must not inflate the figure"
        );

        // And the consequence the user sees: 0 GB is claimed only for a coin
        // the config actually runs lean.
        assert!(
            est_disk_gb(
                "bitcoin",
                false,
                effective_mode(CoinMode::Lean, Some(CoinMode::Full))
            ) > 1.0,
            "a pending lean request must not zero out a chain that is syncing"
        );
        assert_eq!(
            est_disk_gb(
                "bitcoin",
                false,
                effective_mode(CoinMode::Lean, Some(CoinMode::Lean))
            ),
            0.0
        );
    }

    /// The addcoin path is the seam W-13 was found on, from the other side.
    #[test]
    fn addcoin_carries_the_mode_for_that_coin_only() {
        let mut cfg = test_config();
        cfg.lean_coins = vec!["bitcoin".into(), "litecoin".into()];

        let plan = build_addcoin_plan(&cfg, "bitcoin");
        assert!(plan.has_arg("--btc-mode=electrum"), "{:?}", plan.args);
        assert!(
            !plan.args.iter().any(|a| a.starts_with("--ltc-mode")),
            "a directive about a coin this run is not adding: {:?}",
            plan.args
        );

        // A full coin adds no flag at all.
        cfg.lean_coins = vec![];
        let plan = build_addcoin_plan(&cfg, "bitcoin");
        assert!(
            !plan.args.iter().any(|a| a.contains("-mode=electrum")),
            "{:?}",
            plan.args
        );

        // And a coin with no lean option never gets one, whatever the record says.
        cfg.lean_coins = vec!["dogecoin".into()];
        let plan = build_addcoin_plan(&cfg, "dogecoin");
        assert!(
            !plan.args.iter().any(|a| a.contains("-mode=electrum")),
            "{:?}",
            plan.args
        );
    }

    /// `connection_type` is the ground truth for what the node will do.
    #[test]
    fn xmr_host_wallet_active_reads_the_key_the_engine_branches_on() {
        // The key PWNDA-PATCH-5's __init__ reads to set _external_main_wallet.
        let shared = r#"{"chainclients":{"monero":{
            "connection_type":"rpc",
            "mainwalletrpchost":"127.0.0.1",
            "mainwalletrpcport":18082,
            "mainwalletrpcauth":["u","p"],
            "wallet_name":"pwnda-active"
        }}}"#;
        assert!(config_xmr_host_wallet_active(shared));

        // Consent recorded but the node has not restarted yet: the config the
        // engine booted from carries no mainwalletrpc*, so sharing is NOT
        // active however emphatically the opt-in record says it will be.
        let not_yet = r#"{"chainclients":{"monero":{
            "connection_type":"rpc","wallet_name":"bsx_wallet"
        }}}"#;
        assert!(!config_xmr_host_wallet_active(not_yet));

        // No monero block at all, and unparseable input, both read false
        // rather than panicking — this feeds a UI decision, not a guard.
        assert!(!config_xmr_host_wallet_active(
            r#"{"chainclients":{"bitcoin":{"connection_type":"electrum"}}}"#
        ));
        assert!(!config_xmr_host_wallet_active("not json"));
    }

    /// The 2026-08-21 mis-keying, pinned so it cannot come back.
    ///
    /// A UI asking `adoption == "accountkey"` about Monero gets a permanent
    /// `false` — Monero shares via C9's wallet-rpc redirect and never reaches
    /// `Adoption::AccountKey`, which is C8's BTC/LTC push. The operator's own
    /// record read `monero: adoption = "deposit"` while their engine was
    /// demonstrably running on their wallet.
    #[test]
    fn monero_sharing_is_not_expressible_as_adoption_accountkey() {
        let shared_cfg = r#"{"chainclients":{"monero":{"mainwalletrpcport":18082}}}"#;
        // Sharing is genuinely active...
        assert!(config_xmr_host_wallet_active(shared_cfg));

        // ...while the adoption a fully-shared Monero coin actually carries is
        // the DEFAULT, not AccountKey. If a future change ever makes Monero
        // report AccountKey, this assertion fires and the UI keyed on
        // `xmr_host_wallet_active` should be revisited rather than silently
        // double-counting.
        let entry = coin_entry(true, CoinMode::Lean, Adoption::default());
        assert_ne!(
            entry.adoption,
            Adoption::AccountKey,
            "Monero must not be expected to report accountkey — see \
             config_xmr_host_wallet_active's doc comment"
        );
    }

    #[test]
    fn config_coin_mode_reads_connection_type() {
        let cfg = r#"{"chainclients":{
            "particl":  {"connection_type":"rpc","manage_daemon":true},
            "litecoin": {"connection_type":"electrum","manage_daemon":false},
            "bitcoin":  {"connection_type":"rpc","manage_daemon":true}
        }}"#;
        assert_eq!(config_coin_mode(cfg, "litecoin"), Some(CoinMode::Lean));
        assert_eq!(config_coin_mode(cfg, "bitcoin"), Some(CoinMode::Full));
        assert_eq!(config_coin_mode(cfg, "particl"), Some(CoinMode::Full));
        // A coin with no block is not "Full", it is UNKNOWN, and the caller
        // must be able to tell those apart to decide whether R20 applies.
        assert_eq!(config_coin_mode(cfg, "dogecoin"), None);
        assert_eq!(config_coin_mode("not json", "bitcoin"), None);

        // An unrecognised connection_type reads as the HEAVIER mode, so a
        // future upstream value cannot make the UI promise 0 GB.
        let odd = r#"{"chainclients":{"bitcoin":{"connection_type":"something-new"}}}"#;
        assert_eq!(config_coin_mode(odd, "bitcoin"), Some(CoinMode::Full));
    }

    /// R18 / R19 / R20.
    #[test]
    fn mode_change_refusals_fire_for_the_right_reasons() {
        // R19 - particl, and the message must say WHY rather than "no light
        // option", which is the generic R18 wording.
        let e = decide_mode_change("particl", CoinMode::Lean, None).unwrap_err();
        assert!(e.contains("SMSG"), "{e}");

        // R18 - no electrum support at all.
        //
        // `bitcoincash` moved OUT of this list 2026-09-03 (Grove expansion
        // plan, Phase C, unit C-R0) once it gained an ELECTRUM_CAPABLE entry;
        // `zephyr`/`zano` (never electrum-capable — see REMOTE_ONLY_COINS)
        // took its place so the "no electrum support at all" case stays
        // actually covered rather than silently losing a member.
        for coin in ["dogecoin", "dash", "monero", "zephyr", "zano"] {
            let e = decide_mode_change(coin, CoinMode::Lean, None).unwrap_err();
            assert!(e.contains(coin), "{e}");
        }
        // ...and the coins that DO have it are accepted. `bitcoincash` joined
        // 2026-09-03 alongside the ELECTRUM_CAPABLE widening above.
        for coin in ["bitcoin", "litecoin", "bitcoincash"] {
            assert_eq!(
                decide_mode_change(coin, CoinMode::Lean, None),
                Ok(ModeChange::Persist),
                "{coin} is electrum-capable"
            );
        }
        // Full is always available, including for the coins R18 rejects.
        for coin in ["particl", "dogecoin", "bitcoin", "monero"] {
            assert_eq!(
                decide_mode_change(coin, CoinMode::Full, None),
                Ok(ModeChange::Persist)
            );
        }

        // R20 - a coin already baked into the config cannot be switched. The
        // message must NOT promise a workaround: the first version said
        // "switch it off, restart, switch it back on", and that sequence does
        // nothing (disable keeps the chainclient block, and reconcile only
        // addcoins coins missing from the config).
        let e = decide_mode_change("bitcoin", CoinMode::Lean, Some(CoinMode::Full)).unwrap_err();
        assert!(e.contains("before a coin is enabled"), "{e}");
        assert!(
            !e.contains("restart"),
            "the false off/restart/on remedy must stay dead: {e}"
        );
        let e = decide_mode_change("bitcoin", CoinMode::Full, Some(CoinMode::Lean)).unwrap_err();
        assert!(e.contains("before a coin is enabled"), "{e}");

        // Re-requesting what is already configured is a no-op, not an error: a
        // UI that re-sends its current state must not surface a failure.
        assert_eq!(
            decide_mode_change("bitcoin", CoinMode::Full, Some(CoinMode::Full)),
            Ok(ModeChange::AlreadyApplied)
        );
        assert_eq!(
            decide_mode_change("litecoin", CoinMode::Lean, Some(CoinMode::Lean)),
            Ok(ModeChange::AlreadyApplied)
        );
    }

    /// The default must be the light one. If this flips, every fresh install
    /// starts a ~15 GB Bitcoin sync nobody asked for.
    #[test]
    fn lean_is_the_default_mode() {
        assert_eq!(CoinMode::default(), CoinMode::Lean);
        assert_eq!(CoinOptIn::default().mode, CoinMode::Lean);
    }

    /// A record can say `lean` for a coin with no lean option (the freeze
    /// stamps the default on every coin); the API must not repeat it.
    ///
    /// `bitcoincash` moved to the accepted-lean list below 2026-09-03 (Grove
    /// expansion plan, Phase C, unit C-R0); `zephyr`/`zano` replace it here as
    /// still-genuinely-impossible coins (see [`REMOTE_ONLY_COINS`]).
    #[test]
    fn reported_mode_clamps_impossible_lean() {
        for coin in ["particl", "dogecoin", "dash", "monero", "zephyr", "zano"] {
            assert_eq!(reported_mode(coin, CoinMode::Lean), CoinMode::Full);
        }
        assert_eq!(reported_mode("bitcoin", CoinMode::Lean), CoinMode::Lean);
        assert_eq!(reported_mode("bitcoincash", CoinMode::Lean), CoinMode::Lean);
        assert_eq!(reported_mode("litecoin", CoinMode::Full), CoinMode::Full);
    }

    /// The wire spelling is frozen: `src/api/basicswap.ts` reads these strings.
    #[test]
    fn coin_mode_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&CoinMode::Lean).unwrap(), "\"lean\"");
        assert_eq!(serde_json::to_string(&CoinMode::Full).unwrap(), "\"full\"");
        assert_eq!(
            serde_json::from_str::<CoinMode>("\"full\"").unwrap(),
            CoinMode::Full
        );
    }

    // ── secret redaction in failure tails (C1.4) ────────────────────

    /// A 24-word BIP39 phrase, shaped exactly like what prepare prints.
    const FAKE_PHRASE: &str = "puppy ocean match cereal symbol another shed magic wrap hammer bulb intact gadget divorce twin tonight reason outdoor destroy simple truth cigar social volcano";

    /// Reviewer PROBE-B, reproduced. A phrase carrying ONE adjacent non-BIP39
    /// token (a trailing period, or the `--particl_mnemonic=` argv prefix)
    /// currently survives redaction entirely.
    #[test]
    fn probe_phrase_with_adjacent_punctuation() {
        let bare = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about.";
        let argv = "Unknown argument --particl_mnemonic=abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let quoted = "ValueError: bad phrase 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'";
        for (name, case) in [("trailing-dot", bare), ("argv", argv), ("quoted", quoted)] {
            let out = redact_secrets(case);
            assert!(!out.contains("abandon abandon"), "{name} LEAKED: {out}");
        }
    }

    /// THE test for R2. A phrase line with **no header above it** must still be
    /// redacted, because truncation is exactly what removes the header.
    ///
    /// This is the test that fails if anyone reorders `tail_bytes` to slice
    /// before redacting: slicing a large buffer first can drop the
    /// "IMPORTANT - Save your…" banner and leave the bare phrase as line one,
    /// where every header-anchored rule is blind.
    #[test]
    fn tail_redacts_a_headerless_phrase_line() {
        let out = redact_secrets(FAKE_PHRASE);
        assert!(
            !out.contains("puppy"),
            "a bare phrase line must be redacted with no header present: {out}"
        );
        assert!(out.contains("[redacted"), "must say it redacted: {out}");
    }

    /// The header-anchored path, i.e. prepare's actual success output.
    #[test]
    fn tail_redacts_the_phrase_and_extended_keys_prepare_prints() {
        let stdout = format!(
            "INFO : Done.\n\nIMPORTANT - Save your particl wallet recovery phrase:\n{FAKE_PHRASE}\n\nExtended private keys (for external wallet import):\n  Litecoin: zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE\n  Bitcoin: zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGX4NuxTum1BeGaNKSTVAdKAB1RaCLTKrTpnJt4mZjLBFmDMKfr\n\nNOTE: These keys can be imported into Electrum using 'Use a master key'.\n"
        );
        let out = redact_secrets(&stdout);
        assert!(!out.contains("puppy"), "phrase leaked: {out}");
        assert!(!out.contains("volcano"), "phrase leaked: {out}");
        assert!(!out.contains("zprv"), "extended private key leaked: {out}");
        // The surrounding diagnostics must survive so the message still helps.
        assert!(out.contains("INFO : Done."));
        assert!(out.contains("IMPORTANT - Save your particl wallet recovery phrase:"));
    }

    /// The paired falsifier: redaction must NOT eat the diagnostics the tail
    /// exists to deliver. Without this, the regexes could be "fixed" by
    /// over-broadening until everything is redacted and every failure becomes
    /// unreadable.
    #[test]
    fn tail_preserves_diagnostics() {
        let noisy = "Error: Unknown argument --ltc-mode=electrum\n\
             stopDaemon [WinError 2] The system cannot find the file specified\n\
             Mismatched pid for particld\n\
             Binding RPC on address 127.0.0.1 port 19792 failed.\n\
             the system cannot find the file specified please check that the path exists here";
        let out = redact_secrets(noisy);
        assert!(out.contains("Unknown argument --ltc-mode=electrum"));
        assert!(out.contains("[WinError 2]"));
        assert!(out.contains("Mismatched pid"));
        assert!(out.contains("port 19792 failed"));
        // The last line is 13 lowercase words — a naive "12+ short lowercase
        // tokens" heuristic would redact it. The real wordlist must not.
        assert!(
            out.contains("please check that the path exists"),
            "an ordinary prose diagnostic was redacted: {out}"
        );
    }

    /// Public extended keys are not secret and are useful in diagnostics; only
    /// the private forms go.
    #[test]
    fn redaction_keeps_public_extended_keys() {
        let line = "watch descriptor wpkh([f0f0f0f0/84h/0h/0h]zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs/0/*)";
        let out = redact_secrets(line);
        assert!(out.contains("zpub"), "a PUBLIC key must survive: {out}");
    }

    /// `--addcoin` prints the extended-keys block too (prepare.py:1770-1772),
    /// and that site is NOT gated on `generated_mnemonic` — so it fires on
    /// every coin add, not just first run.
    #[test]
    fn redaction_covers_the_addcoin_extended_key_block() {
        let stdout = "INFO : Adding coin: dogecoin\nExtended private keys (for external wallet import):\n  Dogecoin: xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb\n";
        let out = redact_secrets(stdout);
        assert!(!out.contains("xprv"), "addcoin key leaked: {out}");
        assert!(out.contains("Adding coin: dogecoin"));
    }

    /// `tail_bytes` is the chokepoint, so prove the redaction is wired into it
    /// rather than only existing as a free function.
    #[test]
    fn tail_bytes_redacts_and_still_truncates() {
        let mut buf = String::new();
        buf.push_str(&"filler line that is perfectly ordinary\n".repeat(400));
        buf.push_str("IMPORTANT - Save your particl wallet recovery phrase:\n");
        buf.push_str(FAKE_PHRASE);
        buf.push('\n');
        let out = tail_bytes(buf.as_bytes());
        assert!(!out.contains("puppy"), "phrase survived tail_bytes: {out}");
        assert!(
            out.len() <= LOG_TAIL_BYTES as usize + 64,
            "tail should still be bounded, got {} bytes",
            out.len()
        );
    }

    /// **This is the test that pins the redact-BEFORE-slice ordering**, and it
    /// took a failed mutation to find the case that actually does it.
    ///
    /// The obvious construction (phrase at the very end of a long buffer) does
    /// NOT distinguish the two orderings: slicing first still leaves the whole
    /// phrase in the window, where the context-free wordlist rule catches it.
    /// The ordering only matters when truncation lands *inside* the phrase and
    /// leaves **fewer than [`MIN_MNEMONIC_WORDS`] words** — too few for that
    /// rule to fire, so a slice-first implementation emits a partial phrase.
    ///
    /// So the buffer is built to straddle the boundary deliberately: enough
    /// trailing filler that the last `LOG_TAIL_BYTES` begin ~10 words into the
    /// phrase. Redacting first removes the phrase whole and only then
    /// truncates; slicing first leaks those 10 words.
    #[test]
    fn tail_bytes_redacts_a_phrase_straddling_the_truncation_boundary() {
        let words: Vec<&str> = FAKE_PHRASE.split_whitespace().collect();
        let keep = 10usize;
        assert!(
            keep < MIN_MNEMONIC_WORDS,
            "the point of this test is a remainder too short for the word rule"
        );
        let tail_words = words[words.len() - keep..].join(" ");
        let head = format!(
            "{}IMPORTANT - Save your particl wallet recovery phrase:\n",
            "ordinary filler line\n".repeat(50)
        );
        // after the phrase we need (LOG_TAIL_BYTES - tail_words.len()) bytes so
        // the window opens right at the start of the final `keep` words.
        let after = "z".repeat(LOG_TAIL_BYTES as usize - tail_words.len());
        let buf = format!("{head}{FAKE_PHRASE}\n{after}");

        let out = tail_bytes(buf.as_bytes());
        for w in &words[words.len() - keep..] {
            assert!(
                !out.contains(*w),
                "a partial phrase leaked through truncation (word {w:?} survived). \
                 This is what redacting AFTER slicing produces.\nout: {out}"
            );
        }
    }

    // ── coin set ────────────────────────────────────────────────────

    /// Every name in `WALLET_SIDECAR_COINS` must be one of the (patched)
    /// engine's own `known_coins` keys, because that is what `chainclients` is
    /// keyed by and what `--addcoin` validates against (`ensure_coin_valid`).
    ///
    /// The failure this prevents is quiet: `--addcoin=bitcoin-cash` exits
    /// non-zero, `reconcile_coin_set` records it under `failed`, and the pair
    /// simply never appears. Pinned as a literal list rather than derived,
    /// because the point is to catch a *rename* on either side.
    ///
    /// **Renamed from `coin_names_are_upstream_known_coins`** (Grove expansion
    /// plan, Phase C, unit C-R0): `zephyr` and `zano` are NOT in plain
    /// upstream's `known_coins` at all — they exist only because
    /// `upstream/patches/0014` and `0016` add them (confirmed by reading the
    /// patches themselves: `0014` line ~245 adds `"zephyr": (...)` to
    /// `known_coins`; `0016` line ~382 adds `"zano": (...)`). So this list is
    /// now the PATCHED engine's `known_coins`, and the name says so.
    #[test]
    fn coin_names_are_engine_known_coins() {
        // prepare.py `known_coins` at the pinned commit (9266677e), PLUS the
        // two entries `upstream/patches/0014` and `0016` add. Every entry here
        // must be traceable to either plain upstream or a named patch — this
        // is not "whatever WALLET_SIDECAR_COINS happens to say" restated.
        const ENGINE_KNOWN: &[&str] = &[
            "particl",
            "bitcoin",
            "litecoin",
            "decred",
            "namecoin",
            "monero",
            "wownero",
            "pivx",
            "dash",
            "firo",
            "navcoin",
            "bitcoincash",
            "zephyr", // PWNDA-PATCH-14
            "zano",   // PWNDA-PATCH-16
            "dogecoin",
        ];
        for c in WALLET_SIDECAR_COINS {
            assert!(
                ENGINE_KNOWN.contains(c),
                "{c} is not an engine known_coins key — --addcoin would reject it"
            );
        }
        assert_eq!(
            WALLET_SIDECAR_COINS.first(),
            Some(&"particl"),
            "particl carries SMSG and must lead the list"
        );
    }

    /// `missing_coins` is what makes a widened `WALLET_SIDECAR_COINS` reach an
    /// install that already ran setup. Case-insensitive on both sides.
    #[test]
    fn missing_coins_diffs_against_the_configured_set() {
        let configured = vec![
            "particl".to_string(),
            "Litecoin".to_string(),
            "monero".to_string(),
        ];
        let missing = missing_coins(&configured, WALLET_SIDECAR_COINS);
        assert_eq!(
            missing,
            vec!["bitcoin", "dogecoin", "dash", "bitcoincash", "zephyr", "zano"]
        );

        // A fully-configured install must produce no work at all — this is the
        // every-launch case and it has to be free.
        let all: Vec<String> = WALLET_SIDECAR_COINS.iter().map(|c| c.to_string()).collect();
        assert!(missing_coins(&all, WALLET_SIDECAR_COINS).is_empty());
    }

    /// `chainclients` is the authority on what is configured, not the coin
    /// directories on disk — an addcoin that half-failed leaves the directory.
    #[test]
    fn configured_coins_come_from_chainclients() {
        let json = r#"{"htmlport":12700,"chainclients":{"particl":{},"monero":{}}}"#;
        let mut got = read_configured_coins(json).expect("parses");
        got.sort();
        assert_eq!(got, vec!["monero", "particl"]);

        // No chainclients key at all is an empty set, not an error: every coin
        // is then addable.
        assert_eq!(
            read_configured_coins(r#"{"htmlport":12700}"#).expect("parses"),
            Vec::<String>::new()
        );
        // Unparseable input must NOT read as "nothing configured" — that would
        // make the reconcile try to add coins that are already there.
        assert!(read_configured_coins("not json").is_err());
        assert!(read_configured_coins(r#"{"chainclients":[]}"#).is_err());
    }

    /// `--addcoin` must NOT carry `--client-auth-password`: that flag is what
    /// makes prepare take the `prepare.py:1436-1461` early return on an
    /// existing config, which would rewrite the auth hash and exit **without
    /// adding the coin**. Same short-circuit that made `--portoffset` and
    /// `--withcoins` inert; this test is the one that keeps it from claiming a
    /// third victim.
    #[test]
    fn addcoin_plan_omits_the_flag_that_would_short_circuit_it() {
        let cfg = test_config();
        let plan = build_addcoin_plan(&cfg, "dogecoin");

        assert!(plan.has_arg("--addcoin=dogecoin"));
        assert!(plan.has_arg("--mainnet"));
        assert!(plan.has_arg("--nocores"));
        assert!(plan.has_arg(r"--bindir=C:\app\swap-sidecar\bin"));
        assert!(
            !plan.args.iter().any(|a| a.starts_with("--client-auth-password")),
            "--client-auth-password triggers prepare's early return: {:?}",
            plan.args
        );
        assert!(
            !plan.args.iter().any(|a| a.starts_with("--withcoins")),
            "--withcoins is inert on an existing config and must not imply otherwise: {:?}",
            plan.args
        );
        // One coin per invocation — upstream's add_coin is a single string.
        assert_eq!(
            plan.args.iter().filter(|a| a.starts_with("--addcoin=")).count(),
            1
        );
    }

    /// The FIRST-RUN list must be binary-gated too, not just the reconcile.
    ///
    /// Regression guard for the 2026-08-19 failure: gating only `--addcoin`
    /// left a fresh datadir taking the `--withcoins` path ungated, so prepare
    /// configured three coins with no daemon and the node died with
    /// `stopDaemon [WinError 2] The system cannot find the file specified`
    /// before ever binding its UI port.
    #[test]
    fn first_run_coin_list_is_binary_gated_too() {
        let tmp = std::env::temp_dir().join(format!("pwnda-seedable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for c in ["bitcoin", "litecoin", "monero"] {
            std::fs::create_dir_all(tmp.join(c)).unwrap();
            std::fs::write(tmp.join(c).join("d.exe"), b"x").unwrap();
        }
        // dogecoin/dash/bitcoincash deliberately absent; particl absent too.
        let got = seedable_coins(&tmp, WALLET_SIDECAR_COINS);

        assert_eq!(got, vec!["particl", "bitcoin", "litecoin", "monero"]);
        // particl is exempt: a config without SMSG transport is not a swap
        // node, so a missing particl must fail loudly later, not vanish here.
        assert!(
            got.contains(&"particl".to_string()),
            "particl must never be filtered out"
        );
        for absent in ["dogecoin", "dash", "bitcoincash"] {
            assert!(
                !got.contains(&absent.to_string()),
                "{absent} has no binary and must not reach --withcoins"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A coin with no seeded daemon binary must be skipped, not added: with
    /// `--nocores` prepare writes the chainclient and never fetches the
    /// daemon, so adding it turns "this pair is unavailable" into "the node
    /// dies on next launch".
    #[test]
    fn coin_binaries_presence_gates_on_a_nonempty_dir() {
        let tmp = std::env::temp_dir().join(format!("pwnda-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("dogecoin")).unwrap();
        std::fs::write(tmp.join("dogecoin").join("dogecoind.exe"), b"x").unwrap();
        // Present but EMPTY — a half-finished extraction must not read as ready.
        std::fs::create_dir_all(tmp.join("dash")).unwrap();

        assert!(coin_binaries_present(&tmp, "dogecoin"));
        assert!(!coin_binaries_present(&tmp, "dash"));
        assert!(!coin_binaries_present(&tmp, "bitcoincash"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── autostart ───────────────────────────────────────────────────

    /// Consent is mandatory and the env var cannot grant it. The env var can
    /// only turn autostart ON — it exists to add a behaviour to a dev run, and
    /// letting it turn autostart off would give a dev session a way to silently
    /// contradict the user's saved preference.
    #[test]
    fn autostart_requires_consent_and_env_can_only_add() {
        // No opt-in: nothing starts, whatever anything else says.
        assert!(!should_autostart(false, true, Some("1")));
        assert!(!should_autostart(false, false, Some("1")));

        // Opted in, preference off: only the env var starts it.
        assert!(!should_autostart(true, false, None));
        assert!(should_autostart(true, false, Some("1")));

        // Opted in, preference on: starts regardless of the env var, including
        // when the env var is explicitly off.
        assert!(should_autostart(true, true, None));
        assert!(should_autostart(true, true, Some("0")));

        // Falsey env spellings must not count as "set".
        for falsey in ["", "  ", "0", "false", "False"] {
            assert!(
                !should_autostart(true, false, Some(falsey)),
                "{falsey:?} should not enable autostart"
            );
        }
    }

    /// `resolve_network` — added 2026-08-22 to make a regtest rehearsal
    /// reachable through the REAL supervisor + REAL UI without a frontend
    /// change: `swap_sidecar_start`'s own `network` argument already let any
    /// caller ask for regtest, but the shipped UI never passes one, so this
    /// dev-only env fallback is the only difference between "the argument
    /// exists" and "a dev session can actually reach it".
    #[test]
    fn resolve_network_lets_env_default_but_never_override_an_explicit_choice() {
        // No explicit choice, no env: the shipped default.
        assert_eq!(resolve_network(None, None), Network::Mainnet);
        // No explicit choice, env says regtest.
        assert_eq!(resolve_network(None, Some("regtest")), Network::Regtest);
        assert_eq!(resolve_network(None, Some("REGTEST")), Network::Regtest);
        assert_eq!(resolve_network(None, Some(" regtest ")), Network::Regtest);
        // An explicit caller argument always wins, in both directions —
        // a future wizard that DOES pass a choice must never have a stale
        // dev env var silently override it.
        assert_eq!(
            resolve_network(Some(Network::Mainnet), Some("regtest")),
            Network::Mainnet
        );
        assert_eq!(
            resolve_network(Some(Network::Regtest), Some("mainnet")),
            Network::Regtest
        );
        // Junk env values fall back to the safe default, not to regtest.
        for junk in ["", "  ", "testnet", "REGTES"] {
            assert_eq!(
                resolve_network(None, Some(junk)),
                Network::Mainnet,
                "{junk:?} must not be read as regtest"
            );
        }
    }

    /// Revoking consent must clear the autostart preference. A record with
    /// `optedIn:false, autostart:true` would start the node the instant the
    /// user re-consented, which is not what accepting a setup screen means.
    #[test]
    fn revoking_consent_clears_autostart() {
        let revoked = OptInRecord {
            archival_chain: false,
            opted_in: false,
            at: None,
            autostart: false,
            wallet_encrypted: false,
            swap_seed_fingerprint: None,
            coins: Default::default(),
        };
        assert!(!should_autostart(revoked.opted_in, revoked.autostart, None));
        // The field defaults to false so a record written before it existed
        // keeps meaning "manual".
        let legacy: OptInRecord =
            serde_json::from_str(r#"{"optedIn":true,"at":null}"#).expect("legacy record parses");
        assert!(legacy.opted_in);
        assert!(!legacy.autostart, "a legacy record must not imply autostart");
    }

    // ── C3: per-coin enablement + the selection gate ────────────────

    fn c3_tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-c3-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn optin_with(coins: &[(&str, bool)]) -> OptInRecord {
        OptInRecord {
            archival_chain: false,
            opted_in: true,
            at: Some("2026-08-19T00:00:00+00:00".to_string()),
            autostart: false,
            wallet_encrypted: false,
            swap_seed_fingerprint: None,
            coins: coins
                .iter()
                .map(|(c, e)| {
                    (
                        (*c).to_string(),
                        CoinOptIn {
                            enabled: *e,
                            at: Some("2026-08-19T00:00:00+00:00".to_string()),
                            ..CoinOptIn::default()
                        },
                    )
                })
                .collect(),
        }
    }

    /// Every coin the sidecar can run needs a ticker, or `coin_key_from` half
    /// works and `coin_status` renders an uppercased engine name where the UI
    /// expects a ticker.
    #[test]
    fn coin_tickers_cover_every_sidecar_coin() {
        for coin in WALLET_SIDECAR_COINS {
            assert!(
                COIN_TICKERS.iter().any(|(c, _)| c == coin),
                "{coin} is in WALLET_SIDECAR_COINS but has no ticker row"
            );
            assert!(
                COIN_DISK_GB.iter().any(|(c, _)| c == coin)
                    || REMOTE_ONLY_COINS.contains(coin),
                "{coin} has no chaindata budget (COIN_DISK_GB) and is not in \
                 REMOTE_ONLY_COINS, so the enable toggle cannot say what it costs"
            );
        }
        assert_eq!(WALLET_SIDECAR_COINS.first(), Some(&MANDATORY_COIN));
    }

    /// [`est_disk_gb`] must actually return zero for every
    /// [`REMOTE_ONLY_COINS`] entry, whatever `mode`/`monero_is_remote` say —
    /// pins the "unconditional" half of the doc comment, not just the table
    /// membership the test above checks.
    #[test]
    fn remote_only_coins_are_always_zero_disk() {
        for coin in REMOTE_ONLY_COINS {
            for monero_is_remote in [false, true] {
                for mode in [CoinMode::Lean, CoinMode::Full] {
                    assert_eq!(
                        est_disk_gb(coin, monero_is_remote, mode),
                        0.0,
                        "{coin} (monero_is_remote={monero_is_remote}, mode={mode:?}) must be zero"
                    );
                }
            }
        }
    }

    /// Both spellings reach this module — the engine's `chainclients` key and
    /// the wallet's ticker — and both must land on the same key.
    ///
    /// **`"zephyr"` moved out of the refusal list 2026-09-03** (Grove
    /// expansion plan, Phase C, unit C-R0): it used to be a "bad" input
    /// precisely because it was NOT yet a coin this module knew about. Adding
    /// it to [`COIN_TICKERS`] makes `coin_key_from("zephyr")` correctly
    /// resolve — leaving it in the refusal list would have made this test
    /// assert the coin does not exist, the opposite of the point of adding
    /// it. `"zano"` is now tested as an accept case for the same reason.
    #[test]
    fn coin_key_from_accepts_both_spellings_and_refuses_anything_else() {
        assert_eq!(coin_key_from("bitcoincash"), Some("bitcoincash"));
        assert_eq!(coin_key_from("BCH"), Some("bitcoincash"));
        assert_eq!(coin_key_from(" bch "), Some("bitcoincash"));
        assert_eq!(coin_key_from("Bitcoin"), Some("bitcoin"));
        assert_eq!(coin_key_from("BTC"), Some("bitcoin"));
        assert_eq!(coin_key_from("zephyr"), Some("zephyr"));
        assert_eq!(coin_key_from("ZEPH"), Some("zephyr"));
        assert_eq!(coin_key_from("zano"), Some("zano"));
        assert_eq!(coin_key_from("ZANO"), Some("zano"));
        for bad in ["", "  ", "wownero", "eth", "bitcoin cash", "bitcoins"] {
            assert_eq!(coin_key_from(bad), None, "{bad:?} must be refused");
        }
    }

    /// A record written before C3 keeps meaning "everything", because that
    /// install is already running those chains.
    #[test]
    fn a_legacy_record_enables_every_coin() {
        let legacy: OptInRecord = serde_json::from_str(r#"{"optedIn":true,"at":null}"#)
            .expect("a pre-C3 record must still parse");
        assert!(legacy.coins.is_empty());
        assert_eq!(
            enabled_coins(&legacy),
            WALLET_SIDECAR_COINS
                .iter()
                .map(|c| c.to_string())
                .collect::<Vec<_>>()
        );
    }

    /// An explicit map is exhaustive — and `particl` survives being left out
    /// of it, because SMSG is not optional.
    #[test]
    fn an_explicit_map_enables_only_what_it_names_and_always_particl() {
        let rec = optin_with(&[("bitcoin", true), ("litecoin", false)]);
        let got = enabled_coins(&rec);
        assert!(got.contains(&"particl".to_string()), "{got:?}");
        assert!(got.contains(&"bitcoin".to_string()), "{got:?}");
        assert!(!got.contains(&"litecoin".to_string()), "{got:?}");
        // A coin the map never mentions is NOT enabled — that is what makes a
        // later widening of WALLET_SIDECAR_COINS an opt-in rather than a
        // surprise chain download.
        assert!(!got.contains(&"dogecoin".to_string()), "{got:?}");
    }

    /// **The silent-mass-disable trap.**
    ///
    /// A legacy record has an empty map, which reads as "everything". Writing
    /// one explicit entry makes the map non-empty, and every unmentioned coin
    /// would flip to disabled. Freezing the effective set first is what stops
    /// one toggle from switching six chains off with no error anywhere.
    #[test]
    fn the_first_explicit_choice_preserves_the_legacy_set() {
        let legacy = OptInRecord {
            archival_chain: false,
            opted_in: true,
            at: None,
            autostart: false,
            wallet_encrypted: false,
            swap_seed_fingerprint: None,
            coins: Default::default(),
        };
        let before = enabled_coins(&legacy);
        assert_eq!(before.len(), WALLET_SIDECAR_COINS.len());

        let mut rec = legacy.clone();
        rec.coins = materialize_coin_map(&legacy, "2026-08-19T00:00:00+00:00");
        rec.coins.get_mut("dogecoin").unwrap().enabled = false;

        let after = enabled_coins(&rec);
        assert!(!after.contains(&"dogecoin".to_string()), "{after:?}");
        for coin in WALLET_SIDECAR_COINS.iter().filter(|c| **c != "dogecoin") {
            assert!(
                after.contains(&coin.to_string()),
                "{coin} must survive an unrelated toggle, got {after:?}"
            );
        }
    }

    /// The light default is for genuinely fresh installs only. Applying it to
    /// an install that already has a config would retroactively disable coins
    /// it is already syncing.
    #[test]
    fn consent_seeds_the_light_default_only_on_a_fresh_install() {
        let at = "2026-08-19T00:00:00+00:00";
        let fresh = coins_on_consent(&Default::default(), false, at);
        assert!(!fresh.is_empty());
        for coin in WALLET_SIDECAR_COINS {
            assert_eq!(
                fresh.get(*coin).map(|e| e.enabled),
                Some(DEFAULT_ENABLED_COINS.contains(coin)),
                "{coin}"
            );
        }
        assert!(DEFAULT_ENABLED_COINS.contains(&MANDATORY_COIN));
        // BTC/LTC joined the default 2026-08-22 — safe only because a newly
        // enabled coin defaults to CoinMode::Lean (see the const's own doc),
        // which costs zero disk for these two specifically. The coins with NO
        // lean option must still never be a default, on the original "a 750
        // GB chain must never be a default" reasoning — it just now names a
        // narrower set.
        for heavy in ["dogecoin", "dash"] {
            assert!(
                !DEFAULT_ENABLED_COINS.contains(&heavy),
                "{heavy}: no lean option, so a default-on here IS a 750 GB chain"
            );
        }
        // The host-wallet followers are default-ON since 2026-09-04 (operator's
        // decision): zero disk, no daemon, and a wallet process this app already
        // runs. What makes that safe is not this table but the policy: a coin
        // whose wallet process is absent this session is parked, never allowed
        // to stall the start — `apply_host_wallet_coin_policy`'s own tests pin
        // that.
        for follower in REMOTE_ONLY_COINS {
            assert!(
                DEFAULT_ENABLED_COINS.contains(follower),
                "{follower}: a remote-only coin costs nothing and ships enabled"
            );
        }
        for lean in ["bitcoin", "litecoin", "bitcoincash"] {
            assert!(
                DEFAULT_ENABLED_COINS.contains(&lean),
                "{lean} is ELECTRUM_CAPABLE, so defaulting it on costs zero disk"
            );
            // The invariant that makes the default safe: a default-enabled
            // coin MUST be one that runs without a local chain.
            assert!(can_run_lean(lean), "{lean} is default-on but cannot run lean");
        }
        // And the whole default set is zero-disk, by construction: every entry
        // is the mandatory transport, a remote/host-wallet coin, or lean-capable.
        for coin in DEFAULT_ENABLED_COINS {
            assert!(
                *coin == MANDATORY_COIN
                    || *coin == "monero"
                    || REMOTE_ONLY_COINS.contains(coin)
                    || can_run_lean(coin),
                "{coin}: a default-enabled coin must not need a local chain"
            );
        }

        // An existing install keeps the legacy (empty) reading.
        assert!(coins_on_consent(&Default::default(), true, at).is_empty());

        // An explicit map survives re-consent untouched.
        let explicit = optin_with(&[("bitcoin", true)]).coins;
        assert_eq!(coins_on_consent(&explicit, false, at), explicit);
    }

    /// The wire shape the TS `CoinOptIn` / `OptInRecord` types expect.
    #[test]
    fn the_opt_in_record_serializes_camel_case_with_its_coin_map() {
        let rec = optin_with(&[("bitcoin", true)]);
        let v: serde_json::Value = serde_json::to_value(&rec).unwrap();
        assert_eq!(v["optedIn"], true);
        assert_eq!(v["coins"]["bitcoin"]["enabled"], true);
        assert_eq!(v["coins"]["bitcoin"]["adoption"], "deposit");
        assert_eq!(v["coins"]["bitcoin"]["descriptorsImportedAt"], serde_json::Value::Null);
        assert_eq!(v["coins"]["bitcoin"]["firstSyncStarted"], false);
        // Both consent fields start null: nothing pressed either way.
        assert_eq!(
            v["coins"]["bitcoin"]["shareWalletAckAt"],
            serde_json::Value::Null
        );
        assert_eq!(
            v["coins"]["bitcoin"]["shareWalletDeclinedAt"],
            serde_json::Value::Null
        );

        // A record written before EITHER consent field existed must still
        // deserialize, and — since 2026-08-20 — must read as SHARING, because
        // the fields are absent rather than declined.
        let legacy: OptInRecord = serde_json::from_str(
            r#"{"optedIn":true,"coins":{"bitcoin":{"enabled":true,"mode":"lean"}}}"#,
        )
        .expect("a pre-C8 record must still deserialize");
        assert!(legacy.coins["bitcoin"].share_wallet_declined_at.is_none());
        assert_eq!(
            adoption_coins(&legacy),
            vec!["btc".to_string()],
            "MIGRATION, stated deliberately: an existing opted-in install starts              sharing when this ships. That is the operator's 2026-08-20 call —              opting into the DEX is the decision, and re-asking per coin was the              friction being removed. The disclosure moved to the opt-in wizard;              an install that opted in BEFORE that wizard copy existed will not              have seen it, and the per-row copy is what tells them."
        );

        // The durable decline survives a round trip and still wins.
        let declined: OptInRecord = serde_json::from_str(
            r#"{"optedIn":true,"coins":{"bitcoin":{"enabled":true,"mode":"lean",
                "shareWalletDeclinedAt":"2026-08-20T00:00:00Z"}}}"#,
        )
        .expect("a declined record must deserialize");
        assert!(
            adoption_coins(&declined).is_empty(),
            "an explicit decline must survive deserialization and keep sharing off"
        );
    }

    /// The wire shape for the two new C9-shaped consent pairs — pinned the
    /// same way [`the_opt_in_record_serializes_camel_case_with_its_coin_map`]
    /// pins C8's, so the TS side (a separate unit's job) has an exact target.
    #[test]
    fn zph_and_zano_host_wallet_fields_serialize_camel_case() {
        let rec = optin_with(&[("zephyr", true), ("zano", true)]);
        let v: serde_json::Value = serde_json::to_value(&rec).unwrap();
        for (coin, ack_key, declined_key) in [
            ("zephyr", "zphHostWalletAckAt", "zphHostWalletDeclinedAt"),
            ("zano", "zanoHostWalletAckAt", "zanoHostWalletDeclinedAt"),
        ] {
            assert_eq!(
                v["coins"][coin][ack_key],
                serde_json::Value::Null,
                "{coin}.{ack_key}"
            );
            assert_eq!(
                v["coins"][coin][declined_key],
                serde_json::Value::Null,
                "{coin}.{declined_key}"
            );
        }

        // Round trip, mirroring the XMR case above: a durable ZEPH decline
        // must survive deserialization and keep `shares_zph_host_wallet` off,
        // without touching ZANO's.
        let declined: OptInRecord = serde_json::from_str(
            r#"{"optedIn":true,"coins":{"zephyr":{"enabled":true,"mode":"lean",
                "zphHostWalletDeclinedAt":"2026-08-20T00:00:00Z"},
                "zano":{"enabled":true,"mode":"lean"}}}"#,
        )
        .expect("a declined ZEPH record must deserialize");
        assert!(!shares_zph_host_wallet(
            declined.opted_in,
            &declined.coins["zephyr"]
        ));
        assert!(shares_zano_host_wallet(
            declined.opted_in,
            &declined.coins["zano"]
        ));
    }

    #[test]
    fn coin_enable_status_serializes_camel_case() {
        let row = CoinEnableStatus {
            mode: CoinMode::Lean,
            configured_mode: None,
            can_run_lean: false,
            can_share_wallet: false,
            shares_wallet: false,
            xmr_host_wallet_active: false,
            host_wallet_active: false,
            active: Some(true),
            parked_reason: None,
            coin: "bitcoincash".to_string(),
            ticker: "BCH".to_string(),
            enabled: false,
            binary_present: true,
            configured: true,
            adoption: Adoption::Consolidate,
            descriptors_imported: false,
            est_disk_gb: 250.0,
        };
        let v: serde_json::Value = serde_json::to_value(&row).unwrap();
        assert_eq!(v["binaryPresent"], true);
        assert_eq!(v["descriptorsImported"], false);
        assert_eq!(v["estDiskGb"], 250.0);
        assert_eq!(v["adoption"], "consolidate");
        assert_eq!(v["canShareWallet"], false);
        assert_eq!(v["sharesWallet"], false);
    }

    /// Pins [`Adoption::HostWallet`]'s wire spelling the same way the test
    /// above pins `Consolidate`'s — `src/api/basicswap.ts`'s `DexAdoption`
    /// union is a separate unit's job to extend (Grove expansion plan,
    /// Phase C, unit C-T1), but whatever string this enum emits IS the
    /// contract that unit has to match, so it is pinned here rather than left
    /// to be discovered by a mismatch later.
    #[test]
    fn adoption_host_wallet_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(Adoption::HostWallet).unwrap(),
            "hostwallet"
        );
        assert_eq!(
            serde_json::from_value::<Adoption>(serde_json::json!("hostwallet")).unwrap(),
            Adoption::HostWallet
        );
    }

    /// A pinned remote Monero node means no local monerod and therefore no
    /// chaindata — the one row in the budget table that is derived rather than
    /// guessed.
    #[test]
    fn est_disk_gb_is_zero_for_a_pinned_remote_monero() {
        assert_eq!(est_disk_gb("monero", true, CoinMode::Full), 0.0);
        assert!(
            est_disk_gb("monero", false, CoinMode::Full) > 10.0,
            "a locally-managed monerod still costs real disk"
        );
        assert!(est_disk_gb("bitcoin", true, CoinMode::Full) > 1.0, "the pin only affects XMR");
    }

    /// **The figures must reflect PRUNING, because the engine prunes.**
    ///
    /// This table is rendered on the enable toggle, so it is the number that
    /// decides whether a user turns a coin on. It first shipped with
    /// full-archive sizes — bitcoin 750 GB — while upstream writes `prune=2000`
    /// into every BTC conf it generates (`interface/btc/core.py:123`), making
    /// the real cost roughly 15 GB. A 50x overstatement talks the user out of a
    /// coin that would have cost them almost nothing, which is not the safe
    /// direction for a number in a yes/no control.
    ///
    /// Asserted as a CEILING per coin rather than exact values: the point is
    /// that nothing here is archive-scale, and exact estimates are allowed to
    /// drift as chains grow.
    #[test]
    fn disk_estimates_are_pruned_scale_not_archive_scale() {
        for (coin, cap) in [
            ("bitcoin", 40.0),
            ("litecoin", 40.0),
            ("dogecoin", 40.0),
            ("dash", 40.0),
            ("bitcoincash", 40.0),
            ("particl", 40.0),
        ] {
            let gb = est_disk_gb(coin, false, CoinMode::Full);
            assert!(
                gb < cap,
                "{coin} is quoted at {gb} GB, which is archive-scale — upstream                  PRUNES this chain, so the figure should be the prune cap plus a                  chainstate, not the full chain"
            );
        }
        // Lean mode is the leanest option there is: no chain at all. Only
        // BTC and LTC have it.
        assert_eq!(est_disk_gb("bitcoin", false, CoinMode::Lean), 0.0);
        assert_eq!(est_disk_gb("litecoin", false, CoinMode::Lean), 0.0);
        assert!(
            est_disk_gb("dogecoin", false, CoinMode::Lean) > 0.0,
            "dogecoin has no electrum option upstream, so Lean cannot make it free"
        );

        // Monero is pruned differently (`prune-blockchain=1`, about a third),
        // so it is legitimately larger — but still far below a full archive.
        let xmr = est_disk_gb("monero", false, CoinMode::Full);
        assert!(xmr < 150.0, "monero quoted at {xmr} GB looks un-pruned");
    }

    /// `manage_daemon` is the disable mechanism (contract 1.4). The chainclient
    /// block survives, nothing is deleted, and re-running is a no-op.
    #[test]
    fn coin_enablement_writes_manage_daemon_idempotently_and_bomlessly() {
        let dir = c3_tmpdir("enable");
        let path = dir.join("basicswap.json");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            br#"{"htmlport":12700,"chainclients":{
                 "particl":{"connection_type":"rpc","manage_daemon":true,"rpcport":19792},
                 "bitcoin":{"connection_type":"rpc","manage_daemon":true,"rpcport":19796},
                 "litecoin":{"connection_type":"rpc","manage_daemon":true,"rpcport":19795},
                 "monero":{"connection_type":"rpc","manage_daemon":true,"rpcport":29798}}}"#,
        );
        std::fs::write(&path, &bytes).unwrap();

        let enabled = vec!["particl".to_string(), "bitcoin".to_string()];
        assert!(apply_coin_enablement_to_config(&dir, &enabled).unwrap());

        let written = std::fs::read(&path).unwrap();
        assert_ne!(
            &written[..written.len().min(3)],
            &[0xEF, 0xBB, 0xBF],
            "the rewritten config must NOT start with a UTF-8 BOM"
        );
        let v: serde_json::Value = serde_json::from_slice(&written).unwrap();
        assert_eq!(v["chainclients"]["bitcoin"]["manage_daemon"], true);
        assert_eq!(v["chainclients"]["litecoin"]["manage_daemon"], false);
        assert_eq!(v["chainclients"]["monero"]["manage_daemon"], false);
        assert_eq!(
            v["chainclients"]["particl"]["manage_daemon"], true,
            "particl carries SMSG and must never be switched off"
        );
        assert!(
            v["chainclients"]["litecoin"]["rpcport"].is_number(),
            "disable must not delete the chainclient block"
        );
        assert_eq!(v["htmlport"], 12700, "unrelated keys must survive");

        // Idempotent: a second identical run must not rewrite the file.
        assert!(!apply_coin_enablement_to_config(&dir, &enabled).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), written, "byte-identical");

        // ── The particl guarantee, asserted so it can actually fail ──
        //
        // The version of this test that only checked `manage_daemon == true`
        // with "particl" IN the enabled list was GREEN with the SMSG skip
        // deleted (mutation M13, 2026-08-19): the assertion could not tell
        // "skipped" from "enabled". The property is that the enable policy
        // never touches particl **whatever the list says**, so the list has to
        // omit it for the check to mean anything.
        let without_particl = vec!["bitcoin".to_string()];
        assert!(
            !apply_coin_enablement_to_config(&dir, &without_particl).unwrap(),
            "an enabled set that merely omits particl must change nothing"
        );
        let v2: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            v2["chainclients"]["particl"]["manage_daemon"], true,
            "particl carries SMSG; the enable policy must never switch it off,              even when it is absent from the enabled set"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pinned remote Monero node must win over the enable toggle, or the
    /// engine tries to start a monerod it has no binary for. The ordering
    /// inside `apply_local_config_policy` is what guarantees it, so this drives
    /// the two writes in that order.
    #[test]
    fn the_xmr_node_pin_overrules_a_monero_enable() {
        let dir = c3_tmpdir("xmrpin");
        std::fs::write(
            dir.join("basicswap.json"),
            br#"{"chainclients":{"monero":{"connection_type":"rpc","manage_daemon":false,
                 "rpchost":"127.0.0.1","rpcport":29798}}}"#,
        )
        .unwrap();

        let enabled = vec!["particl".to_string(), "monero".to_string()];
        apply_coin_enablement_to_config(&dir, &enabled).unwrap();
        let mid: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("basicswap.json")).unwrap()).unwrap();
        assert_eq!(
            mid["chainclients"]["monero"]["manage_daemon"], true,
            "enabling monero asks for a locally managed daemon..."
        );

        apply_xmr_node_to_config(&dir, "node.example.org", 18089).unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("basicswap.json")).unwrap()).unwrap();
        assert_eq!(
            after["chainclients"]["monero"]["manage_daemon"], false,
            "...but a pinned remote node overrules it"
        );
        assert_eq!(after["chainclients"]["monero"]["rpchost"], "node.example.org");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── R9: the selection gate ──────────────────────────────────────

    fn reading(locked: usize, bids: usize) -> GateReading {
        GateReading {
            locked_utxos: locked,
            active_bids: bids,
            as_of: "2026-08-19T00:00:00+00:00".to_string(),
        }
    }

    /// **R9, the required test.**
    ///
    /// An unreachable daemon plus a persisted `{locked: 0}` must NOT open the
    /// gate. The persisted zero is a photograph of a moment that has already
    /// passed; a bid can be accepted in the interval, and spending a reserved
    /// input aborts a live swap.
    ///
    /// Asserts on `allowed`, deliberately not on `reason` — a text assertion
    /// passes for the wrong reason the day the copy is reworded.
    #[test]
    fn selection_gate_is_closed_when_state_is_stale() {
        let gate = decide_gate(None, Some(reading(0, 0)), "2026-08-19T01:00:00+00:00");
        assert!(
            !gate.allowed,
            "an unreachable daemon cannot prove the absence of locks"
        );
        assert!(gate.stale);
        // With nothing persisted at all it is still closed.
        assert!(!decide_gate(None, None, "2026-08-19T01:00:00+00:00").allowed);
    }

    /// The control that makes the test above informative: a **fresh** zero is
    /// the only thing that opens the gate, and a fresh non-zero closes it
    /// without being stale.
    #[test]
    fn only_a_fresh_zero_reading_opens_the_gate() {
        let now = "2026-08-19T01:00:00+00:00";
        let open = decide_gate(Some(reading(0, 0)), None, now);
        assert!(open.allowed);
        assert!(!open.stale);
        assert_eq!(open.as_of, now);

        for (locked, bids) in [(1usize, 0usize), (0, 1), (2, 3)] {
            let shut = decide_gate(Some(reading(locked, bids)), None, now);
            assert!(!shut.allowed, "locked={locked} bids={bids}");
            assert!(!shut.stale, "a live reading is never stale");
            assert_eq!(shut.locked_utxos, locked);
            assert_eq!(shut.active_bids, bids);
        }
    }

    /// "The engine cannot be holding this" and "we could not tell" must not
    /// share a branch. Collapsing them either permanently disables sending on
    /// coins the node has never heard of, or opens the gate on a config we
    /// could not read.
    #[test]
    fn gate_scope_separates_not_shared_from_cannot_tell() {
        let shared = r#"{"chainclients":{"bitcoin":{"connection_type":"rpc",
            "manage_daemon":true,"rpchost":"127.0.0.1","rpcport":19796,
            "wallet_name":"wallet.dat"}}}"#;
        assert!(matches!(
            gate_scope(Some(shared), "bitcoin"),
            GateScope::Shared(_)
        ));
        // Configured, but the engine does not manage its wallet.
        let unmanaged = r#"{"chainclients":{"bitcoin":{"connection_type":"rpc",
            "manage_daemon":false,"rpchost":"127.0.0.1","rpcport":19796}}}"#;
        assert!(matches!(
            gate_scope(Some(unmanaged), "bitcoin"),
            GateScope::NotShared(_)
        ));
        // Not a bitcoin-family daemon at all.
        let xmr = r#"{"chainclients":{"monero":{"connection_type":"rpc","manage_daemon":true,
            "core_type_group":"xmr","rpchost":"127.0.0.1","rpcport":29798}}}"#;
        assert!(matches!(
            gate_scope(Some(xmr), "monero"),
            GateScope::NotShared(_)
        ));
        // Not configured, and no config at all.
        assert!(matches!(
            gate_scope(Some(shared), "dogecoin"),
            GateScope::NotShared(_)
        ));
        assert!(matches!(gate_scope(None, "bitcoin"), GateScope::NotShared(_)));
        // A config we cannot read is the one case that must fail closed.
        assert!(matches!(
            gate_scope(Some("{not json"), "bitcoin"),
            GateScope::Unknown(_)
        ));
    }

    #[test]
    fn selection_gate_serializes_camel_case() {
        let v: serde_json::Value =
            serde_json::to_value(decide_gate(None, Some(reading(2, 1)), "now")).unwrap();
        assert_eq!(v["allowed"], false);
        assert_eq!(v["lockedUtxos"], 2);
        assert_eq!(v["activeBids"], 1);
        assert_eq!(v["stale"], true);
        assert!(v["asOf"].is_string());
    }

    /// The engine names coins by **display name**, and `"Bitcoin Cash"` starts
    /// with `"Bitcoin"`. A prefix test would count every BCH bid as a BTC bid
    /// — closing the gate on BTC for no reason, and worse, an inverted version
    /// of the same mistake would open it on the coin that really is reserved.
    #[test]
    fn bid_counting_does_not_confuse_bitcoin_cash_with_bitcoin() {
        let body = serde_json::json!([
            {"bid_id":"a","coin_from":"Bitcoin Cash","coin_to":"Monero"},
            {"bid_id":"b","coin_from":"Bitcoin","coin_to":"Monero"},
            {"bid_id":"c","coin_from":"Monero","coin_to":"Litecoin MWEB"},
            {"bid_id":"d","coin_from":"Particl Anon","coin_to":"Bitcoin"}
        ]);
        assert_eq!(count_bids_for_coin(&body, "bitcoin"), Some(2), "b and d");
        assert_eq!(count_bids_for_coin(&body, "bitcoincash"), Some(1), "a only");
        assert_eq!(count_bids_for_coin(&body, "litecoin"), Some(1), "the MWEB variant");
        assert_eq!(count_bids_for_coin(&body, "particl"), Some(1), "the anon variant");
        assert_eq!(count_bids_for_coin(&body, "monero"), Some(3));
        assert_eq!(count_bids_for_coin(&body, "dash"), Some(0));
        // A non-array body (an engine error object) is UNKNOWN, never zero:
        // until 2026-09-05 this line asserted `0`, which every gate reads as
        // "nothing in flight — proceed". A locked wallet's `{"error": …}`
        // reply would have opened the sweep gate mid-swap.
        assert_eq!(count_bids_for_coin(&serde_json::json!({"error":"x"}), "bitcoin"), None);
    }

    /// `active_bids_for` must read BOTH halves of the book. A taker's own
    /// swaps live only on `sentbids`; reading `bids` alone answered zero for
    /// every swap this app's users actually make. Source-level, because the
    /// function needs a node — the property is that both endpoint names are
    /// posted to, and that a non-list reply is an error rather than a zero.
    #[test]
    fn the_in_flight_count_reads_both_halves_and_fails_closed() {
        let src = include_str!("swap_sidecar.rs");
        let start = src.find("pub(crate) async fn active_bids_for(").expect("moved");
        let body = &src[start..start + 2600];
        assert!(body.contains(r#"["bids", "sentbids"]"#), "both halves of the book");
        assert!(body.contains("did not return a list"), "an unreadable list is an error");
        assert!(!body.contains(".unwrap_or(0))\n}"), "must not default an unreadable list to 0");
    }

    /// The env block is what makes the remote-XMR node work and what keeps the
    /// `/tmp` defaults out of a Windows run.
    #[test]
    fn prepare_plan_env_pins_windows_paths_and_remote_xmr() {
        let cfg = test_config();
        let plan = build_prepare_plan(&cfg);

        assert_eq!(
            plan.env("BASICSWAP_DATADIR"),
            Some(r"C:\app\swap-sidecar\datadir")
        );
        // config.py:17 defaults DATADIRS to /tmp/basicswap — fatal on Windows.
        assert_eq!(plan.env("DATADIRS"), Some(r"C:\app\swap-sidecar\datadir"));
        assert_eq!(plan.env("UI_HTML_PORT"), Some("12700"));
        assert_eq!(plan.env("UI_WS_PORT"), Some("11700"));
        // Presence of these two is what flips manage_daemon off for XMR.
        assert_eq!(plan.env("XMR_RPC_HOST"), Some("node.example.org"));
        assert_eq!(plan.env("XMR_RPC_PORT"), Some("18089"));
        assert_eq!(plan.cwd, PathBuf::from(r"C:\app\swap-sidecar\datadir"));
    }

    /// With no remote node configured, `XMR_RPC_HOST`/`PORT` must be ABSENT —
    /// an empty value would still read as "set" to `shouldManageDaemon` and
    /// silently disable a daemon we then never configure.
    #[test]
    fn prepare_plan_omits_xmr_env_when_no_remote_node() {
        let mut cfg = test_config();
        cfg.xmr_rpc_host = None;
        cfg.xmr_rpc_port = None;
        let plan = build_prepare_plan(&cfg);
        assert_eq!(plan.env("XMR_RPC_HOST"), None);
        assert_eq!(plan.env("XMR_RPC_PORT"), None);
        assert!(
            !plan.has_arg("--trustremotenode"),
            "--trustremotenode is meaningless without a remote node"
        );
    }

    /// The offset is passed to prepare and reflected in the resolved ports.
    #[test]
    fn port_offset_flows_into_prepare_and_resolved_ports() {
        let mut cfg = test_config();
        cfg.port_offset = 200;
        let plan = build_prepare_plan(&cfg);
        assert!(plan.has_arg("--portoffset=200"));
        // Upstream computes htmlport = UI_HTML_PORT + port_offset.
        assert_eq!(plan.env("UI_HTML_PORT"), Some("12700"));
        assert_eq!(cfg.html_port(), 12900);
        assert_eq!(cfg.ws_port(), 11900);
    }

    #[test]
    fn run_plan_uses_module_invocation_and_regtest_flag() {
        let mut cfg = test_config();
        cfg.network = Network::Regtest;
        let plan = build_run_plan(&cfg);
        assert_eq!(plan.args[0], "-s");
        assert_eq!(plan.args[1], "-E");
        assert_eq!(plan.args[2], "-m");
        assert_eq!(plan.args[3], "basicswap.bin.run");
        assert!(plan.has_arg("--regtest"));
        assert!(!plan.has_arg("--mainnet"));
        assert!(plan.has_arg(r"--datadir=C:\app\swap-sidecar\datadir"));
        assert!(!plan.args.iter().any(|a| a.contains("basicswap-run")));
    }

    /// DEFECT 4 — the supervisor must not spawn the embedded interpreter bare.
    ///
    /// Without `-s` the interpreter adds the machine's *user* site-packages to
    /// `sys.path`; a bare `python -m basicswap.bin.run` was observed importing
    /// `babel` out of the user's site directory, so "embedded runtime" stopped
    /// meaning anything. Without `-E` an inherited `PYTHONPATH`/`PYTHONHOME`
    /// does the same thing from the environment side.
    ///
    /// Position is load-bearing: they are *interpreter* options, so they only
    /// take effect before `-m`. Asserting `has_arg("-s")` alone would pass with
    /// the flags appended after the module name, where python hands them to the
    /// module as argv — hence the index assertions.
    #[test]
    fn both_plans_isolate_the_interpreter_before_the_module_flag() {
        let cfg = test_config();
        for (label, plan) in [
            ("prepare", build_prepare_plan(&cfg)),
            ("run", build_run_plan(&cfg)),
        ] {
            let m = plan
                .args
                .iter()
                .position(|a| a == "-m")
                .unwrap_or_else(|| panic!("{label}: no -m in {:?}", plan.args));
            for flag in ISOLATION_FLAGS {
                let at = plan.args.iter().position(|a| a == flag).unwrap_or_else(|| {
                    panic!("{label}: missing {flag} in {:?}", plan.args)
                });
                assert!(
                    at < m,
                    "{label}: {flag} is at {at}, after -m at {m} — python would pass it \
                     to the module instead of applying it: {:?}",
                    plan.args
                );
            }
        }
    }

    // ── API allow-list ──────────────────────────────────────────────

    /// A real bid/offer id: 28 bytes hex-encoded (js_server.py:766).
    const OBJ_ID: &str = "0011223344556677889900aabbccddeeff00112233445566778899aa";

    /// Every sensitive endpoint is refused, in every spelling a caller could
    /// reach for. Fail-closed is the requirement: if this test can pass while
    /// the policy allows everything, it is worthless — hence the explicit
    /// "the allow-list still works" half below.
    #[test]
    fn sensitive_endpoints_are_refused() {
        let denied = [
            "getcoinseed",
            "/getcoinseed",
            "json/getcoinseed",
            "/json/getcoinseed",
            "/json/getcoinseed/1",
            "GETCOINSEED",
            "/json/GetCoinSeed",
            "setpassword",
            "/json/setpassword",
            "unlock",
            "/json/unlock",
            "//json//unlock",
            "/json/unlock?coin=particl",
            "lock",
            "/json/lock",
            "/json/lock#frag",
        ];
        for p in denied {
            assert!(is_denied_endpoint(p), "should be denied: {p}");
            for m in [ApiMethod::Get, ApiMethod::Post] {
                assert!(
                    build_api_url(12700, p, m).is_err(),
                    "URL must not build for {m:?}: {p}"
                );
            }
        }
    }

    /// BLOCKER 2 — **the fund-moving endpoint**.
    ///
    /// `wallets/<coin>/withdraw` names no denied *endpoint*, but upstream
    /// routes `cmd == "withdraw"` to `withdraw_coin(...)` →
    /// `swap_client.withdrawParticl` / `withdrawCoin` (js_server.py:316-330),
    /// and the `/json/` routes skip upstream's `checkForm` CSRF control. A
    /// single `swap_sidecar_api_post("wallets/particl/withdraw", {...})` from
    /// the renderer therefore moved coins on-chain, with this module injecting
    /// the auth header for it.
    ///
    /// Every sub-command under `wallets` is checked, not just `withdraw`: the
    /// defect is the *shape* (a second tail segment is always a command), so
    /// the test asserts on the shape.
    #[test]
    fn wallet_subcommands_including_withdraw_are_refused() {
        let subcommands = [
            "withdraw",
            "createutxo",
            "nextdepositaddr",
            "reseed",
            "rescan",
            "newstealthaddress",
            "newmwebaddress",
            "convertmweb",
            "watchaddress",
            "listaddresses",
            "fixseedid",
            "mwebbalance",
        ];
        for cmd in subcommands {
            for coin in ["particl", "PART", "LTC"] {
                let p = format!("wallets/{coin}/{cmd}");
                for m in [ApiMethod::Get, ApiMethod::Post] {
                    assert!(
                        build_api_url(12700, &p, m).is_err(),
                        "a wallet sub-command must not be reachable ({m:?}): {p}"
                    );
                }
                // ...and with the /json/ prefix spelled out, which is the form
                // a caller copying a URL out of the web UI would use.
                assert!(
                    build_api_url(12700, &format!("/json/{p}"), ApiMethod::Post).is_err(),
                    "/json/{p} must not be reachable"
                );
            }
        }
        // The read that the sub-commands hang off of is still reachable.
        assert_eq!(
            build_api_url(12700, "wallets/PART", ApiMethod::Get).unwrap(),
            "http://127.0.0.1:12700/json/wallets/PART"
        );
    }

    /// Deny by default. Nothing outside the written-down allow-list is
    /// reachable, including upstream endpoints that merely *look* harmless.
    #[test]
    fn unlisted_endpoints_are_denied_by_default() {
        for p in [
            // node-state mutation
            "vacuumdb",
            "generatenotification",
            &format!("revokeoffer/{OBJ_ID}"),
            // creation verbs
            "offers/new",
            "bids/new",
            "/json/bids/new",
            "smsgaddresses/new",
            "getsubfeebidtx",
            // attacker-chosen egress
            "readurl",
            "electrumdiscover",
            "coinprices",
            // read-only but not (yet) needed — must be a deliberate addition
            "identities",
            "automationstrategies",
            "messageroutes",
            "modeswitchinfo",
            "help",
            "checkupdates",
            // simply not an endpoint
            "definitely-not-an-endpoint",
            // right endpoint, wrong shape
            "coins/1",
            "network/peers",
            &format!("bids/{OBJ_ID}/anything"),
        ] {
            for m in [ApiMethod::Get, ApiMethod::Post] {
                assert!(
                    build_api_url(12700, p, m).is_err(),
                    "should be denied by default ({m:?}): {p}"
                );
            }
        }
    }

    /// The policy is VERB-aware. `/json/bids/<id>` renders a bid on GET, but
    /// the same URL with a POST body carrying `accept` calls
    /// `swap_client.acceptBid(bid_id)` (js_server.py:773-776) — which commits
    /// funds. So the id form is GET-only while the bare list form, where
    /// upstream reads its filters out of the body, takes both.
    #[test]
    fn bid_detail_is_get_only_because_a_post_body_accepts_the_bid() {
        let detail = format!("bids/{OBJ_ID}");
        assert!(
            build_api_url(12700, &detail, ApiMethod::Get).is_ok(),
            "reading a bid must stay possible"
        );
        assert!(
            build_api_url(12700, &detail, ApiMethod::Post).is_err(),
            "POST to a bid id is accept/abandon — it must not be reachable"
        );
        assert!(
            build_api_url(12700, &format!("{detail}/states"), ApiMethod::Get).is_ok(),
            "the states sub-view is read-only and stays reachable"
        );
        assert!(
            build_api_url(12700, &format!("{detail}/states"), ApiMethod::Post).is_err()
        );
        // The list form is where filters legitimately ride in a POST body.
        assert!(build_api_url(12700, "bids", ApiMethod::Post).is_ok());
        assert!(build_api_url(12700, "bids", ApiMethod::Get).is_ok());
        // A word in an id position is not an id.
        assert!(build_api_url(12700, "bids/new", ApiMethod::Get).is_err());
        assert!(build_api_url(12700, "bids/abc123", ApiMethod::Get).is_err());
    }

    /// BLOCKER 1 — **assert on what goes on the wire, not on the string.**
    ///
    /// The previous version of this test compared `build_api_url`'s return
    /// *string* and only ever fed it a literal `..`. It stayed green through
    /// the entire bypass class: `reqwest` hands that string to the WHATWG URL
    /// parser, which percent-decodes each segment and *then* collapses
    /// dot-segments, so a correct-looking string left the process as a request
    /// for `/shutdown/<token>`. Verbatim, from the probe that found it:
    ///
    /// ```text
    /// PROBE input="x/%2e%2e/%2e%2e/shutdown/0123456789abcdef"
    ///   build_api_url=Ok("http://127.0.0.1:12700/json/x/%2e%2e/%2e%2e/shutdown/0123456789abcdef")
    ///   wire request line = "GET /shutdown/0123456789abcdef HTTP/1.1"
    /// PROBE input="x/%2E%2E/%2E%2E/rpc"  -> wire "GET /rpc HTTP/1.1"
    /// PROBE input="x/.%2e/.%2e/wallets"  -> wire "GET /wallets HTTP/1.1"
    /// ```
    ///
    /// So this version parses the built URL exactly as reqwest would and
    /// asserts on `Url::path()` — the bytes that reach the socket.
    #[test]
    fn proxy_path_cannot_escape_the_json_prefix_on_the_wire() {
        let escapes = [
            // the three demonstrated bypasses
            "x/%2e%2e/%2e%2e/shutdown/0123456789abcdef",
            "x/%2E%2E/%2E%2E/rpc",
            "x/.%2e/.%2e/wallets",
            // the same class, other spellings
            "x/%2e./%2e./shutdown/0123456789abcdef",
            "x/%252e%252e/shutdown/0123456789abcdef",
            "coins/%2e%2e/%2e%2e/shutdown/0123456789abcdef",
            "%2e%2e/%2e%2e/login",
            // the literal forms the old test did cover
            "../shutdown/aaaaaaaaaaaaaaaa",
            "/json/../shutdown/aaaaaaaaaaaaaaaa",
            "http://127.0.0.1:12700/shutdown/aaaaaaaaaaaaaaaa",
            r"json\unlock",
            // separator smuggling by other encodings
            "coins%2f%2e%2e%2fshutdown",
            "coins/%00",
            // empty-ish
            "",
            "   ",
            "/",
            "/json/",
        ];
        for p in escapes {
            // LAYER 1 — `normalize_api_path` is where the traversal fix lives,
            // so it is asserted directly. If it ever accepts one of these, the
            // URL its segments produce must STILL parse to a path under
            // `/json/`. Asserting on `Url::path()` rather than on the string is
            // the whole point: the string was already correct-looking when the
            // bypass shipped.
            //
            // This assertion is deliberately NOT routed through the allow-list.
            // `check_endpoint` refuses every input here on shape alone (`x` is
            // not an endpoint; a five-segment tail matches nothing), so a test
            // that only called `build_api_url` would stay green with the
            // traversal fix deleted — it could not fail for the reason it
            // exists, which is the defect that produced this rewrite.
            if let Ok(segs) = normalize_api_path(p) {
                let url = format!("http://127.0.0.1:12700/json/{}", segs.join("/"));
                let parsed = reqwest::Url::parse(&url)
                    .unwrap_or_else(|e| panic!("{p:?} produced an unparseable URL {url:?}: {e}"));
                assert!(
                    parsed.path().starts_with("/json/"),
                    "ESCAPED THE PIN: input={p:?} segments={segs:?} built={url:?} \
                     wire_path={:?}",
                    parsed.path()
                );
            }
            // LAYER 2 — and the proxy's front door refuses it for both verbs.
            for m in [ApiMethod::Get, ApiMethod::Post] {
                assert!(
                    build_api_url(12700, p, m).is_err(),
                    "escape not rejected by the proxy ({m:?}): {p:?}"
                );
            }
        }

        // And the legitimate paths are pinned under /json/ once PARSED, which
        // is the property the pin actually needs to have.
        for (p, want) in [
            ("offers", "/json/offers"),
            ("/json/coins", "/json/coins"),
            ("wallets/PART", "/json/wallets/PART"),
        ] {
            let url = build_api_url(12700, p, ApiMethod::Get)
                .unwrap_or_else(|e| panic!("{p} should build: {e}"));
            let parsed = reqwest::Url::parse(&url).expect("parses");
            assert_eq!(parsed.path(), want, "wire path drifted for {p}");
            assert!(
                parsed.path().starts_with("/json/"),
                "not pinned under /json/: {p} -> {}",
                parsed.path()
            );
        }
        let bid = build_api_url(12900, &format!("/json/bids/{OBJ_ID}"), ApiMethod::Get).unwrap();
        let parsed = reqwest::Url::parse(&bid).expect("parses");
        assert_eq!(parsed.port(), Some(12900));
        assert_eq!(parsed.path(), format!("/json/bids/{OBJ_ID}"));
    }

    /// Belt-and-braces: the WHATWG parser really does collapse the encoded
    /// dot-segments. If this ever stops holding, the test above is asserting
    /// against a threat that no longer exists and should be revisited — but
    /// while it holds, it is the reason a string-level `".."` check is not a
    /// control.
    #[test]
    fn the_url_parser_collapses_percent_encoded_dot_segments() {
        let u = reqwest::Url::parse(
            "http://127.0.0.1:12700/json/x/%2e%2e/%2e%2e/shutdown/0123456789abcdef",
        )
        .expect("parses");
        assert_eq!(
            u.path(),
            "/shutdown/0123456789abcdef",
            "the parser no longer collapses %2e%2e — re-derive the path pin"
        );
    }

    /// The policy must not swallow the endpoints the wrapper UI actually needs
    /// (this is the half that would go red if someone "fixed" blocker 2 by
    /// denying everything).
    #[test]
    fn ordinary_endpoints_are_allowed() {
        let get_ok = [
            "coins",
            "/json/coins",
            "walletbalances",
            "wallets",
            "wallets/PART",
            "wallets/PART_ANON",
            "wallettransactions/LTC",
            "offers",
            "sentoffers",
            "bids",
            "sentbids",
            "network",
            "notifications",
            "active",
            "rateslist",
        ];
        for p in get_ok {
            assert!(
                build_api_url(12700, p, ApiMethod::Get).is_ok(),
                "GET should be allowed: {p}"
            );
        }
        let post_ok = [
            "rate",
            "rates",
            "validateamount",
            "offerfeeestimate",
            "offers",
            "sentoffers",
            "bids",
            "sentbids",
            "wallettransactions/LTC",
        ];
        for p in post_ok {
            assert!(
                build_api_url(12700, p, ApiMethod::Post).is_ok(),
                "POST should be allowed: {p}"
            );
        }
        assert!(
            build_api_url(12700, &format!("offers/{OBJ_ID}"), ApiMethod::Get).is_ok(),
            "reading one offer must stay possible"
        );
    }

    /// Auth header is Basic with the password in the password half — upstream
    /// only ever compares the password (http_server.py:989-997).
    /// W-15 - the 2026-09-08 unclearable-error loop, pinned.
    ///
    /// The gate protects an ENGINE-BUILT wallet from having its address
    /// table discarded. Once the wallet IS the host's, there is nothing
    /// left to protect -- and applying it anyway produced a refusal whose
    /// stated remedy (sweep back) is deliberately unavailable for exactly
    /// the coins it fired on.
    #[test]
    fn balance_gate_skipped_only_for_an_already_adopted_coin() {
        // The one state where a re-push changes nothing.
        assert!(!balance_gate_applies(&Adoption::AccountKey));

        // Everything else keeps the gate. Deposit is the default and the
        // case the gate was written for; HostWallet coins (XMR/ZEPH/ZANO)
        // do not push account keys at all, so leaving them gated costs
        // nothing and fails closed if that ever changes.
        assert!(balance_gate_applies(&Adoption::Deposit));
        assert!(balance_gate_applies(&Adoption::HostWallet));

        // Default() is Deposit, so a record written before adoption
        // existed is gated, not waved through.
        assert!(balance_gate_applies(&Adoption::default()));
    }

    #[test]
    fn basic_auth_header_encodes_password_half() {
        use base64::Engine;
        let h = basic_auth_header("hunter2");
        let b64 = h.strip_prefix("Basic ").expect("Basic prefix");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64");
        let s = String::from_utf8(decoded).unwrap();
        assert_eq!(s, "pwnda:hunter2");
    }

    // ── port-offset selection ───────────────────────────────────────

    #[test]
    fn port_offset_zero_when_defaults_are_free() {
        let chosen = select_port_offset(DEFAULT_HTML_PORT, DEFAULT_WS_PORT, |_| false);
        assert_eq!(chosen, Some(0));
    }

    /// If EITHER port of a candidate pair is taken, that offset is skipped —
    /// a half-free pair is not usable.
    #[test]
    fn port_offset_skips_pairs_with_either_port_taken() {
        // 12700 free, 11700 taken -> offset 0 unusable.
        // 12800 taken               -> offset 100 unusable.
        // 12900/11900 free          -> offset 200 chosen.
        let taken = [11700u16, 12800u16];
        let chosen = select_port_offset(DEFAULT_HTML_PORT, DEFAULT_WS_PORT, |p| {
            taken.contains(&p)
        });
        assert_eq!(chosen, Some(200));
    }

    #[test]
    fn port_offset_none_when_everything_is_taken() {
        let chosen = select_port_offset(DEFAULT_HTML_PORT, DEFAULT_WS_PORT, |_| true);
        assert_eq!(chosen, None);
    }

    /// Offsets step by 100 so a shifted set cannot land on the previous set's
    /// chain-daemon ports (`--portoffset` raises ALL ports).
    #[test]
    fn candidate_offsets_are_spaced_and_start_at_zero() {
        let c = candidate_offsets();
        assert_eq!(c[0], 0);
        assert_eq!(c[1], PORT_OFFSET_STEP);
        assert_eq!(c.len(), PORT_OFFSET_TRIES as usize);
        assert!(c.windows(2).all(|w| w[1] - w[0] == PORT_OFFSET_STEP));
    }

    /// `parent_alive` must ask about the PROCESS, not the port.
    ///
    /// Driven against this test binary's own PID, which is by definition alive
    /// and binds nothing — so a port-based probe would answer "dead" here,
    /// which is precisely the 2026-08-19 orphan: the node's UI port closes
    /// ~1.5 s into a teardown whose daemons are still running two minutes
    /// later. See the implementation's comment for the measurements.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn parent_alive_tracks_the_process_not_the_port() {
        let me = std::process::id();
        let my_image = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .expect("current_exe has a file name");

        let ladder = |pid: Option<u32>, image: &str| LiveLadder {
            // A port nothing is listening on: if the probe still consulted the
            // port, every case below would come back false.
            html_port: 1,
            password: String::new(),
            parent_pid: pid,
            datadir: std::path::PathBuf::from("."),
            parent_image: image.to_string(),
        };

        assert!(
            ladder(Some(me), &my_image).parent_alive().await,
            "a live PID with a matching image must read as alive"
        );
        // The image guard: a recycled PID must not be mistaken for our parent,
        // the same protection `terminate_parent` applies before it kills.
        assert!(
            !ladder(Some(me), "python.exe").parent_alive().await,
            "a live PID with the WRONG image must not read as our parent"
        );
        // 0 is never a real user process on Windows (System Idle).
        assert!(!ladder(Some(0), &my_image).parent_alive().await);
    }

    /// Live probe path against a real bound socket: bind :0 (the repo's test
    /// precedent), then assert the probe sees it.
    #[tokio::test]
    async fn live_probe_sees_a_bound_loopback_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                if listener.accept().await.is_err() {
                    return;
                }
            }
        });
        assert!(crate::wallet_rpc_common::port_is_bound(port).await);
        // And the pure selector rejects an offset whose html port is that one.
        let chosen = select_port_offset(port, 60000, |p| p == port);
        assert_ne!(chosen, Some(0), "offset 0 must be rejected when html port is bound");
    }

    // ── session ports: the config file beats the offset scan ────────

    #[test]
    fn configured_ports_are_read_out_of_basicswap_json() {
        let cfg = r#"{"htmlhost":"127.0.0.1","htmlport":12700,"wshost":"127.0.0.1","wsport":11700}"#;
        assert_eq!(read_configured_ports(cfg).unwrap(), (12700, Some(11700)));
        // prepare omits wsport when wshost == "none" (prepare.py:2048).
        let no_ws = r#"{"htmlport":12800}"#;
        assert_eq!(read_configured_ports(no_ws).unwrap(), (12800, None));
        // Absent / unusable -> Err, which the caller reads as "not configured".
        assert!(read_configured_ports("{}").is_err());
        assert!(read_configured_ports(r#"{"htmlport":0}"#).is_err());
        assert!(read_configured_ports(r#"{"htmlport":99999}"#).is_err());
        assert!(read_configured_ports("not json").is_err());
    }

    /// BLOCKER 3 — **an existing config wins over the offset scan.**
    ///
    /// `--portoffset` is only applied by prepare's settings block, and prepare
    /// never reaches it on a second run: with the config present *and* a
    /// `--client-auth-password` passed (which `build_prepare_plan` always
    /// passes) it rewrites `client_auth_hash` and `return 0`s at
    /// prepare.py:1436-1461. So from run #2 the whole offset subsystem is
    /// inert, and believing it produces the traced orphan:
    ///
    /// 11700 held, 12700 free -> `select_port_offset` rejects offset 0 (it
    /// needs both ports) and returns 100 -> supervisor believes html 12800 ->
    /// prepare no-ops -> `run.py` binds the configured 12700 and is healthy ->
    /// supervisor polls 12800 for the full READY_BUDGET and reports
    /// `Failed{"health timeout"}` -> `swap_sidecar_stop` builds
    /// `LiveLadder{html_port: 12800}`, whose `parent_alive` bind-probe on 12800
    /// reads false, so the ladder returns `clean: true` after
    /// `[GracefulParent, BoundedWait]` and never touches `particld` or
    /// `monero-wallet-rpc`.
    #[test]
    fn session_ports_come_from_an_existing_config_not_a_fresh_scan() {
        // The exact traced situation: config says 12700, a fresh scan (11700
        // held) would have said offset 100 / port 12800.
        let scan_would_have_said = select_port_offset(DEFAULT_HTML_PORT, DEFAULT_WS_PORT, |p| {
            p == 11700
        });
        assert_eq!(
            scan_would_have_said,
            Some(100),
            "precondition: the scan must actually disagree, or this test proves nothing"
        );

        let plan = plan_session_ports(
            Some((12700, Some(11700))),
            scan_would_have_said,
            DEFAULT_HTML_PORT,
            DEFAULT_WS_PORT,
        )
        .expect("a configured node always has ports");

        assert_eq!(
            plan.html_port, 12700,
            "the supervisor must target the port the node will actually bind"
        );
        assert_eq!(plan.ws_port, 11700);
        assert_eq!(plan.port_offset, 0);
        assert!(
            !plan.run_prepare,
            "prepare must not re-run on an already-configured node — it would \
             no-op anyway and its offset would be ignored"
        );
    }

    /// A config written by a previous run at a non-zero offset is followed
    /// exactly, including a hand-edited port the base+offset arithmetic does
    /// not reproduce.
    #[test]
    fn session_ports_follow_a_shifted_or_hand_edited_config() {
        let shifted = plan_session_ports(
            Some((12800, Some(11800))),
            Some(0),
            DEFAULT_HTML_PORT,
            DEFAULT_WS_PORT,
        )
        .unwrap();
        assert_eq!((shifted.html_port, shifted.ws_port), (12800, 11800));
        assert_eq!(shifted.port_offset, 100);
        assert!(!shifted.run_prepare);

        // htmlport hand-edited to something off the candidate grid, wsport
        // absent (wshost == "none").
        let odd = plan_session_ports(Some((12345, None)), Some(0), DEFAULT_HTML_PORT, DEFAULT_WS_PORT)
            .unwrap();
        assert_eq!(odd.html_port, 12345, "a hand-edited port is still the bound port");
        assert!(!odd.run_prepare);
    }

    /// First run: nothing configured, so the scan decides AND prepare runs —
    /// this is the only situation in which `--portoffset` is honoured.
    #[test]
    fn first_run_uses_the_scan_and_runs_prepare() {
        let plan =
            plan_session_ports(None, Some(200), DEFAULT_HTML_PORT, DEFAULT_WS_PORT).unwrap();
        assert!(plan.run_prepare, "a first run must write a config");
        assert_eq!(plan.port_offset, 200);
        assert_eq!((plan.html_port, plan.ws_port), (12900, 11900));

        // Nothing configured and no free pair is a hard failure, not a guess.
        let err = plan_session_ports(None, None, DEFAULT_HTML_PORT, DEFAULT_WS_PORT).unwrap_err();
        assert!(err.contains("no free loopback port pair"), "unexpected: {err}");
    }

    // ── health-response parsing ─────────────────────────────────────

    #[test]
    fn health_parses_a_real_coins_payload() {
        // Shape from js_server.py:107-132.
        let body = r#"[
            {"id":1,"ticker":"PART","name":"Particl","active":true,"decimal_places":8},
            {"id":4,"ticker":"LTC","name":"Litecoin","active":true,"decimal_places":8},
            {"id":6,"ticker":"XMR","name":"Monero","active":true,"decimal_places":12}
        ]"#;
        let coins = parse_coins_health(body).expect("should parse");
        assert_eq!(coins.len(), 3);
        assert_eq!(coins[0].ticker, "PART");
        assert!(coins.iter().any(|c| c.ticker == "XMR" && c.active));
    }

    /// A node that is UP but not usable answers `{"error": …}`. That must read
    /// as unhealthy, not as a successful parse and not as a crash.
    #[test]
    fn health_rejects_error_shaped_and_junk_bodies() {
        let e = parse_coins_health(r#"{"error":"Wallet locked"}"#).unwrap_err();
        assert!(e.contains("error"), "unexpected message: {e}");

        assert!(parse_coins_health("[]").is_err(), "empty list is not healthy");
        assert!(parse_coins_health("<html>login</html>").is_err());
        assert!(parse_coins_health("").is_err());
        // Well-formed JSON of the wrong shape.
        assert!(parse_coins_health(r#"{"coins":[]}"#).is_err());
    }

    /// **F5 — the unlock must actually FIRE.**
    ///
    /// `unlock_failure_prevents_healthy` injects its own failing future into
    /// [`finalize_healthy`], so it pins the *ordering* of a seam and is
    /// structurally incapable of noticing that the production unlock does
    /// nothing. An adversarial review proved that: replacing
    /// `Some(pwd) => unlock_wallets(..)` with `Some(_pwd) => Ok(())` left the
    /// whole suite green, meaning every configured node could reach `Healthy`
    /// with its wallets still locked — exactly R6's stated risk.
    ///
    /// This drives [`unlock_if_configured`] against a real socket and asserts
    /// a request was issued, to the right path, with the right body and auth.
    /// Deleting the `unlock_wallets` call turns it red because no connection
    /// ever arrives.
    #[tokio::test]
    async fn unlock_if_configured_actually_issues_the_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(StdMutex::new(String::new()));
        let connected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen2 = seen.clone();
        let connected2 = connected.clone();

        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            connected2.store(true, Ordering::SeqCst);
            // Read until the headers AND the declared body have arrived.
            //
            // A single `read()` is a race: TCP has no message boundaries, so a
            // short read leaves `seen` truncated. That mattered here more than
            // usual because the truncated case tripped the same assertion a
            // genuine R6 regression trips, printing "NO REQUEST WAS ISSUED"
            // for a socket hiccup — which is precisely how a real regression
            // gets waved away as flaky. Observed failing ~2 runs in 10 while
            // passing in isolation every time.
            let mut acc = Vec::new();
            let mut buf = vec![0u8; 4096];
            loop {
                let n = match sock.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                acc.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&acc);
                if let Some(h_end) = text.find("\r\n\r\n") {
                    let want: usize = text
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length: ")
                                .or_else(|| l.strip_prefix("Content-Length: "))
                        })
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if acc.len() >= h_end + 4 + want {
                        break;
                    }
                }
            }
            *seen2.lock().unwrap() = String::from_utf8_lossy(&acc).to_string();
            let body = r#"{"success":true}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
        });

        let mut cfg = test_config();
        cfg.wallet_encryption_pwd = Some(Secret::new("s3kr1t-wallet-key".to_string()));
        unlock_if_configured(&cfg, port)
            .await
            .expect("unlock should succeed against the stub");

        let req = seen.lock().unwrap().clone();
        // The two failures are distinguished ON PURPOSE. Conflating them is
        // what let a socket race wear a security regression's error message.
        assert!(
            connected.load(Ordering::SeqCst),
            "NO CONNECTION WAS MADE — the unlock is a no-op, so a configured node              would reach Healthy with locked wallets"
        );
        assert!(
            req.contains("\r\n\r\n"),
            "the stub read an INCOMPLETE request ({} bytes). This is a test-harness              socket problem, NOT an unlock regression — the connection was made.",
            req.len()
        );
        assert!(
            req.starts_with("POST /json/unlock "),
            "wrong request line: {req}"
        );
        assert!(
            req.contains(&basic_auth_header(&cfg.client_auth_password)),
            "auth header missing from: {req}"
        );
        assert!(
            req.contains("s3kr1t-wallet-key"),
            "the wallet password must be in the body: {req}"
        );
    }

    /// The other half: with no encryption configured, the unlock must issue
    /// **no request at all**. Without this, "always POST unlock" would pass the
    /// test above while breaking every unencrypted install.
    #[tokio::test]
    async fn unlock_is_skipped_when_encryption_is_not_configured() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().unwrap().port();
        let hit = Arc::new(StdMutex::new(false));
        let hit2 = hit.clone();
        tokio::spawn(async move {
            if listener.accept().await.is_ok() {
                *hit2.lock().unwrap() = true;
            }
        });

        let mut cfg = test_config();
        cfg.wallet_encryption_pwd = None;
        unlock_if_configured(&cfg, port).await.expect("no-op is Ok");
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert!(
            !*hit.lock().unwrap(),
            "an unconfigured session must not contact the node at all"
        );
    }

    /// End-to-end over a real socket: a stub server answering `/json/coins`
    /// must be seen as healthy, and must have received our Basic auth header.
    #[tokio::test]
    async fn health_check_hits_json_coins_with_auth() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(StdMutex::new(String::new()));
        let seen2 = seen.clone();

        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            *seen2.lock().unwrap() = req;
            let body = r#"[{"id":1,"ticker":"PART","name":"Particl","active":true}]"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
        });

        let coins = health_check(port, "hunter2").await.expect("healthy");
        assert_eq!(coins.len(), 1);

        let req = seen.lock().unwrap().clone();
        assert!(
            req.starts_with("GET /json/coins "),
            "wrong request line: {req}"
        );
        assert!(
            req.contains(&basic_auth_header("hunter2")),
            "auth header missing from: {req}"
        );
    }

    /// A 401 must surface as an error, not as "no coins".
    #[tokio::test]
    async fn health_check_reports_unauthorized() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let body = r#"{"error":"Unauthorized"}"#;
            let resp = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        let err = health_check(port, "wrong").await.unwrap_err();
        assert!(err.contains("401"), "unexpected error: {err}");
    }

    // ── shutdown token extraction ───────────────────────────────────

    #[test]
    fn shutdown_token_is_extracted_from_a_rendered_page() {
        let html = r#"<a class="x" href="/shutdown/0123456789abcdef">Shutdown</a>"#;
        assert_eq!(
            extract_shutdown_token(html).as_deref(),
            Some("0123456789abcdef")
        );
        // No token present.
        assert_eq!(extract_shutdown_token("<html></html>"), None);
        // Too short to be an 8-byte hex token.
        assert_eq!(extract_shutdown_token("/shutdown/abc"), None);
    }

    // ── chain-daemon target derivation ──────────────────────────────

    /// Only daemons WE manage are stop targets; an electrum LTC and a remote
    /// XMR contribute nothing.
    #[test]
    fn chain_daemon_targets_respect_manage_flags_and_connection_type() {
        let cfg = r#"{
          "chainclients": {
            "particl":  {"connection_type":"rpc","manage_daemon":true,"rpchost":"127.0.0.1","rpcport":51735,
                         "rpcuser":"u","rpcpassword":"p"},
            "litecoin": {"connection_type":"electrum","manage_daemon":false,"rpchost":"127.0.0.1","rpcport":19795},
            "monero":   {"connection_type":"rpc","manage_daemon":false,"manage_wallet_daemon":true,
                         "core_type_group":"xmr","rpchost":"node.example.org","rpcport":18089,
                         "walletrpchost":"127.0.0.1","walletrpcport":29798,
                         "walletrpcuser":"wu","walletrpcpassword":"wp"},
            "bitcoin":  {"connection_type":"none","manage_daemon":true,"rpcport":19796}
          }
        }"#;
        let targets = parse_chain_daemon_targets(cfg).expect("parse");
        let names: Vec<&str> = targets.iter().map(|t| t.coin.as_str()).collect();
        assert_eq!(names, vec!["monero-wallet", "particl"]);

        let part = &targets[1];
        assert_eq!(part.kind, DaemonKind::BitcoinRpc);
        assert_eq!(part.port, 51735);
        assert_eq!(part.user.as_deref(), Some("u"));

        let xmrw = &targets[0];
        assert_eq!(xmrw.kind, DaemonKind::MoneroWalletRpc);
        assert_eq!(xmrw.port, 29798);
        assert_eq!(xmrw.host, "127.0.0.1");
    }

    #[test]
    fn chain_daemon_targets_tolerate_a_missing_section() {
        assert!(parse_chain_daemon_targets("{}").unwrap().is_empty());
        assert!(parse_chain_daemon_targets(r#"{"chainclients":{}}"#)
            .unwrap()
            .is_empty());
        assert!(parse_chain_daemon_targets("not json").is_err());
    }

    /// U-4 ordering (adversarial-audit finding): with a LOCALLY-managed monerod,
    /// the monero wallet daemon must be stopped BEFORE the chain daemon it
    /// depends on. A plain coin-name sort put "monero" before "monero-wallet";
    /// the stop-priority must invert that so `store`/`stop_wallet` runs while
    /// monerod is still up.
    #[test]
    fn monero_wallet_daemon_is_stopped_before_its_local_monerod() {
        let cfg = r#"{
          "chainclients": {
            "particl": {"connection_type":"rpc","manage_daemon":true,"rpchost":"127.0.0.1","rpcport":51735},
            "monero":  {"connection_type":"rpc","manage_daemon":true,"manage_wallet_daemon":true,
                        "core_type_group":"xmr","rpchost":"127.0.0.1","rpcport":18081,
                        "walletrpchost":"127.0.0.1","walletrpcport":18083}
          }
        }"#;
        let targets = parse_chain_daemon_targets(cfg).expect("parse");
        let names: Vec<&str> = targets.iter().map(|t| t.coin.as_str()).collect();
        let wallet_ix = names.iter().position(|n| *n == "monero-wallet").unwrap();
        let daemon_ix = names.iter().position(|n| *n == "monero").unwrap();
        assert!(
            wallet_ix < daemon_ix,
            "monero-wallet must be stopped before monerod, got order {:?}",
            names
        );
        assert_eq!(targets[wallet_ix].kind, DaemonKind::MoneroWalletRpc);
        assert_eq!(targets[daemon_ix].kind, DaemonKind::MoneroDaemon);
    }

    // ── phase machine ───────────────────────────────────────────────

    #[test]
    fn phase_machine_allows_only_the_documented_path() {
        use Phase::*;
        assert!(Stopped.can_transition_to(&Preparing));
        assert!(Preparing.can_transition_to(&Starting));
        assert!(Starting.can_transition_to(&Healthy));
        assert!(Healthy.can_transition_to(&Stopping));
        assert!(Stopping.can_transition_to(&Stopped));
        // Failure is reachable from anywhere, and recoverable.
        assert!(Starting.can_transition_to(&Failed {
            reason: "x".into()
        }));
        assert!(Failed {
            reason: "x".into()
        }
        .can_transition_to(&Preparing));
        // A failed start can still have left a child, so it must be tearable
        // down — otherwise `swap_sidecar_stop` errors on exactly the state
        // that most needs the ladder.
        assert!(Failed {
            reason: "x".into()
        }
        .can_transition_to(&Stopping));
        // Illegal jumps.
        assert!(!Stopped.can_transition_to(&Healthy));
        assert!(!Stopped.can_transition_to(&Starting));
        assert!(!Healthy.can_transition_to(&Preparing));
        assert!(!Stopping.can_transition_to(&Healthy));
        // `Stopped -> Stopping` stays illegal on purpose: `swap_sidecar_stop`
        // short-circuits on an already-stopped node rather than transitioning,
        // so a Stopped->Stopping request means the caller lost track of state.
        assert!(!Stopped.can_transition_to(&Stopping));
        // is_running is what the exit hook and the API proxy gate on.
        assert!(Healthy.is_running());
        assert!(Starting.is_running());
        assert!(!Stopped.is_running());
        assert!(!Failed {
            reason: "x".into()
        }
        .is_running());
    }

    /// The engine datadir belongs to ONE wallet. These pin the fingerprint that
    /// says which, because a cross-wallet account-key push reaches funds.
    #[test]
    fn seed_fingerprint_identifies_a_wallet_without_revealing_it() {
        let a = "abandon abandon abandon abandon abandon abandon abandon abandon                  abandon abandon abandon about";
        let b = "legal winner thank year wave sausage worth useful legal winner                  thank yellow";

        // Stable across calls, and different seeds give different answers.
        assert_eq!(seed_fingerprint(a), seed_fingerprint(a));
        assert_ne!(seed_fingerprint(a), seed_fingerprint(b));

        // Whitespace-normalised: the same phrase re-spaced is the same wallet,
        // or a harmless reformat would look like a wallet switch and refuse to
        // share.
        assert_eq!(
            seed_fingerprint("abandon  abandon	abandon"),
            seed_fingerprint("abandon abandon abandon")
        );

        // One-way and short. It is written to a PLAINTEXT opt-in record, so it
        // must never carry the seed itself.
        let fp = seed_fingerprint(a);
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        for word in a.split_whitespace() {
            assert!(!fp.contains(word), "fingerprint leaked the word {word:?}");
        }
    }

    /// The SAME vector `src/lib/swapSeedFingerprint.test.ts` asserts.
    ///
    /// The frontend recomputes this fingerprint for the active wallet and
    /// compares it with the one recorded here, to decide whether the engine's
    /// balances belong to the wallet on screen. A one-sided change to the
    /// domain string, the whitespace normalisation or the truncation would make
    /// EVERY wallet look mismatched — which fails safe, but silently hides a
    /// real shared-wallet balance. Only a shared vector catches that.
    #[test]
    fn seed_fingerprint_matches_the_frontend_vector() {
        let a = "abandon abandon abandon abandon abandon abandon abandon abandon                  abandon abandon abandon about";
        let b = "legal winner thank year wave sausage worth useful legal winner                  thank yellow";
        assert_eq!(seed_fingerprint(a), "8328ec3d75fcf950");
        assert_eq!(seed_fingerprint(b), "0db344bf5a8169c3");
    }

    /// The status payload must never carry the credential.
    #[test]
    fn status_payload_carries_no_credential() {
        let s = SidecarStatus {
            phase: Phase::Healthy,
            running: true,
            opted_in: true,
            html_port: 12700,
            ws_port: 11700,
            port_offset: 0,
            configured: true,
            runtime_installed: true,
            datadir: r"C:\app\swap-sidecar\datadir".to_string(),
            autostart: true,
            coins: vec!["particl".to_string(), "monero".to_string()],
            coins_unavailable: vec!["dash".to_string()],
            bundle_available: false,
            engine: crate::grove::EngineIdentity::Ok {
                id: crate::grove::expected_id(),
            },
            seed_mismatch: None,
            swap_seed_fingerprint: None,
            particl_unpruned: false,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("password"), "status leaked a password: {json}");
        assert!(!json.contains("auth"), "status leaked an auth field: {json}");
    }

    /// The engine identity must actually reach the frontend, in the shape
    /// `src/api/basicswap.ts` declares. Adding the field to the struct is not the
    /// same as shipping it: a `#[serde(skip)]` or a renamed tag would leave the UI
    /// showing nothing while the Rust side "had" the answer — which is the same
    /// class of gap as the supervisor having the stamp available and never reading
    /// it. Assert on the wire bytes, not on the Rust value.
    #[test]
    fn status_payload_carries_the_engine_identity() {
        let drifted = SidecarStatus {
            phase: Phase::Healthy,
            running: true,
            opted_in: true,
            html_port: 12700,
            ws_port: 11700,
            port_offset: 0,
            configured: true,
            runtime_installed: true,
            datadir: r"C:\app\swap-sidecar\datadir".to_string(),
            autostart: true,
            coins: vec!["particl".to_string()],
            coins_unavailable: vec![],
            bundle_available: true,
            engine: crate::grove::EngineIdentity::Drift {
                stamped: "pwnda-grove 0.18.4+p11".into(),
                expected: crate::grove::expected_id(),
            },
            seed_mismatch: None,
            swap_seed_fingerprint: None,
            particl_unpruned: false,
        };
        let json = serde_json::to_string(&drifted).unwrap();
        assert!(json.contains(r#""engine""#), "engine field absent: {json}");
        assert!(json.contains(r#""state":"drift""#), "drift not tagged: {json}");
        assert!(
            json.contains("pwnda-grove 0.18.4+p11"),
            "the stamped id the user needs to see is missing: {json}"
        );
    }

    // ── shutdown ladder ordering (scripted fake) ────────────────────

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Call {
        Graceful,
        AliveProbe,
        FinalisedProbe,
        StopDaemons,
        Terminate,
        Wait,
    }

    /// Scripted parent: alive for `alive_polls` liveness probes, then gone.
    /// `u64::MAX` means "hangs forever" (the documented Monero-RPC hang).
    struct FakeLadder {
        calls: StdMutex<Vec<Call>>,
        alive_polls: AtomicU64,
        graceful_fails: bool,
        daemons_fail: AtomicBool,
        daemon_count: usize,
        /// Finalised (HTTP port closed) from this many finalised-probes on;
        /// `u64::MAX` = never, which is every pre-2026-09-04 scenario.
        finalised_after: AtomicU64,
        finalised_probes: AtomicU64,
    }

    impl FakeLadder {
        fn new(alive_polls: u64) -> Self {
            Self {
                calls: StdMutex::new(Vec::new()),
                alive_polls: AtomicU64::new(alive_polls),
                graceful_fails: false,
                daemons_fail: AtomicBool::new(false),
                daemon_count: 2,
                finalised_after: AtomicU64::new(u64::MAX),
                finalised_probes: AtomicU64::new(0),
            }
        }
        /// A parent that closes its HTTP port at once and then hangs on its
        /// children — the shape measured on 2026-08-19 and 2026-09-04.
        fn finalised_from(mut self, probes: u64) -> Self {
            self.finalised_after = AtomicU64::new(probes);
            self
        }
        fn log(&self, c: Call) {
            self.calls.lock().unwrap().push(c);
        }
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
        fn index_of(&self, c: Call) -> Option<usize> {
            self.calls().iter().position(|x| *x == c)
        }
    }

    impl LadderActions for FakeLadder {
        async fn graceful_parent(&self) -> Result<(), String> {
            self.log(Call::Graceful);
            if self.graceful_fails {
                Err("node did not answer".to_string())
            } else {
                Ok(())
            }
        }
        async fn parent_alive(&self) -> bool {
            self.log(Call::AliveProbe);
            let left = self.alive_polls.load(Ordering::SeqCst);
            if left == u64::MAX {
                return true;
            }
            if left == 0 {
                return false;
            }
            self.alive_polls.store(left - 1, Ordering::SeqCst);
            true
        }
        async fn parent_finalised(&self) -> bool {
            self.log(Call::FinalisedProbe);
            let n = self.finalised_probes.fetch_add(1, Ordering::SeqCst);
            n >= self.finalised_after.load(Ordering::SeqCst)
        }
        async fn stop_chain_daemons(&self) -> Result<usize, String> {
            self.log(Call::StopDaemons);
            if self.daemons_fail.load(Ordering::SeqCst) {
                Err("particld unreachable".to_string())
            } else {
                Ok(self.daemon_count)
            }
        }
        async fn terminate_parent(&self) -> Result<(), String> {
            self.log(Call::Terminate);
            Ok(())
        }
        async fn wait(&self, _ms: u64) {
            self.log(Call::Wait);
        }
    }

    /// Happy path: the parent honours the graceful request and exits inside
    /// the bounded wait. No daemon is touched and nothing is terminated —
    /// upstream's own teardown did the flushing.
    #[tokio::test]
    async fn ladder_stops_after_graceful_when_the_parent_exits() {
        let fake = FakeLadder::new(2);
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 5_000,
                poll_ms: 100,
                finalised_grace_ms: u64::MAX,
            },
        )
        .await;

        assert!(out.clean, "should be a clean stop: {out:?}");
        assert_eq!(
            out.steps,
            vec![LadderStep::GracefulParent, LadderStep::BoundedWait]
        );
        assert_eq!(out.daemons_stopped, 0);
        assert!(
            fake.index_of(Call::StopDaemons).is_none(),
            "daemons must not be touched on the happy path: {:?}",
            fake.calls()
        );
        assert!(
            fake.index_of(Call::Terminate).is_none(),
            "parent must not be terminated on the happy path: {:?}",
            fake.calls()
        );
    }

    /// THE ORDERING INVARIANT. A hung parent escalates, but the chain daemons
    /// are only reached AFTER the graceful attempt and the bounded wait, and
    /// the parent is terminated LAST.
    /// 2026-09-04 — the 124-second stop. The parent closes its HTTP port at
    /// once (finalise), then waits up to 120 s per child for a Ctrl+C that
    /// never arrives. Once it is seen finalised past the grace, the ladder
    /// sends the daemons their own RPC stop WHILE the parent waits; the
    /// parent's wait returns, the parent exits on its own, and the stop is
    /// still clean — no termination, and the daemon stop happened after the
    /// graceful request and inside the bounded wait, never before either.
    #[tokio::test]
    async fn ladder_stops_daemons_early_once_the_parent_has_finalised() {
        // Alive for 6 liveness probes, finalised from the first finalised
        // probe, grace 200 ms at 100 ms polls -> the early stop lands on the
        // third poll, well before the parent's own exit.
        let fake = FakeLadder::new(6).finalised_from(0);
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 60_000,
                poll_ms: 100,
                finalised_grace_ms: 200,
            },
        )
        .await;

        assert!(out.clean, "the parent exited on its own: {out:?}");
        assert_eq!(
            out.steps,
            vec![
                LadderStep::GracefulParent,
                LadderStep::BoundedWait,
                LadderStep::StopChainDaemonsEarly,
            ]
        );
        assert_eq!(out.daemons_stopped, 2);
        let calls = fake.calls();
        let g = fake.index_of(Call::Graceful).unwrap();
        let s = fake.index_of(Call::StopDaemons).expect("early stop must be sent");
        assert!(g < s, "daemons stopped before the graceful request: {calls:?}");
        assert!(
            fake.index_of(Call::Wait).unwrap() < s,
            "the early stop must wait out the grace first: {calls:?}"
        );
        assert_eq!(
            calls.iter().filter(|c| **c == Call::StopDaemons).count(),
            1,
            "the early stop is sent exactly once: {calls:?}"
        );
        assert!(fake.index_of(Call::Terminate).is_none(), "{calls:?}");
    }

    /// The grace is real: a parent that finalises and exits within it is
    /// never sent an early daemon stop — the liveness poll sees it go first.
    #[tokio::test]
    async fn ladder_early_stop_respects_the_finalised_grace() {
        let fake = FakeLadder::new(2).finalised_from(0);
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 60_000,
                poll_ms: 100,
                finalised_grace_ms: 5_000,
            },
        )
        .await;
        assert!(out.clean);
        assert_eq!(out.steps, vec![LadderStep::GracefulParent, LadderStep::BoundedWait]);
        assert!(fake.index_of(Call::StopDaemons).is_none(), "{:?}", fake.calls());
    }

    /// A parent that never finalises (port still bound) gets the old ladder
    /// exactly: no early stop, escalation only after the ceiling.
    #[tokio::test]
    async fn ladder_sends_no_early_stop_while_the_parent_has_not_finalised() {
        let fake = FakeLadder::new(u64::MAX); // never finalised, never exits
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 300,
                poll_ms: 100,
                finalised_grace_ms: 0,
            },
        )
        .await;
        assert!(!out.steps.contains(&LadderStep::StopChainDaemonsEarly), "{out:?}");
        assert_eq!(
            out.steps,
            vec![
                LadderStep::GracefulParent,
                LadderStep::BoundedWait,
                LadderStep::StopChainDaemons,
                LadderStep::TerminateParent,
            ]
        );
    }

    #[tokio::test]
    async fn ladder_never_touches_daemons_before_the_graceful_attempt() {
        let fake = FakeLadder::new(u64::MAX); // hangs forever
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 300,
                poll_ms: 100,
                finalised_grace_ms: u64::MAX,
            },
        )
        .await;

        assert!(!out.clean);
        assert_eq!(
            out.steps,
            vec![
                LadderStep::GracefulParent,
                LadderStep::BoundedWait,
                LadderStep::StopChainDaemons,
                LadderStep::TerminateParent,
            ],
            "ladder ran out of order"
        );
        assert_eq!(out.daemons_stopped, 2);

        let calls = fake.calls();
        let g = fake.index_of(Call::Graceful).expect("graceful must happen");
        let s = fake
            .index_of(Call::StopDaemons)
            .expect("daemons should be stopped for a hung parent");
        let t = fake.index_of(Call::Terminate).expect("parent terminated");
        assert!(g < s, "daemons stopped BEFORE the graceful attempt: {calls:?}");
        assert!(s < t, "parent terminated before the daemons: {calls:?}");
        assert_eq!(
            t,
            calls.len() - 1,
            "terminate must be the last action: {calls:?}"
        );
        assert!(
            fake.index_of(Call::Wait).unwrap() < s,
            "bounded wait must precede daemon stops: {calls:?}"
        );
    }

    /// Even when the graceful request FAILS outright, the ordering holds: the
    /// attempt is still first, and nothing is killed before it.
    #[tokio::test]
    async fn ladder_keeps_order_when_the_graceful_request_fails() {
        let mut fake = FakeLadder::new(u64::MAX);
        fake.graceful_fails = true;
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 200,
                poll_ms: 100,
                finalised_grace_ms: u64::MAX,
            },
        )
        .await;

        assert_eq!(
            out.steps,
            vec![
                LadderStep::GracefulParent,
                LadderStep::BoundedWait,
                LadderStep::StopChainDaemons,
                LadderStep::TerminateParent,
            ]
        );
        assert_eq!(fake.calls()[0], Call::Graceful, "graceful must be attempted first");
        assert!(
            out.notes.iter().any(|n| n.contains("graceful shutdown request failed")),
            "the failure must be recorded: {:?}",
            out.notes
        );
    }

    /// A daemon-stop failure must not stop the ladder — the parent still gets
    /// terminated, and the failure is reported rather than swallowed.
    #[tokio::test]
    async fn ladder_still_terminates_when_daemon_stops_fail() {
        let fake = FakeLadder::new(u64::MAX);
        fake.daemons_fail.store(true, Ordering::SeqCst);
        let out = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 100,
                poll_ms: 100,
                finalised_grace_ms: u64::MAX,
            },
        )
        .await;
        assert_eq!(out.daemons_stopped, 0);
        assert_eq!(*out.steps.last().unwrap(), LadderStep::TerminateParent);
        assert!(out
            .notes
            .iter()
            .any(|n| n.contains("chain-daemon graceful stop failed")));
    }

    /// The bounded wait must actually be bounded — a forever-hung parent must
    /// not spin past its ceiling.
    #[tokio::test]
    async fn ladder_bounded_wait_respects_its_ceiling() {
        let fake = FakeLadder::new(u64::MAX);
        let _ = run_shutdown_ladder(
            &fake,
            LadderConfig {
                max_wait_ms: 500,
                poll_ms: 100,
                finalised_grace_ms: u64::MAX,
            },
        )
        .await;
        let waits = fake.calls().iter().filter(|c| **c == Call::Wait).count();
        // ceil(500/100) = 5 waits, plus the loop's final over-budget check.
        assert!(waits <= 6, "waited {waits} times, expected <= 6");
        assert!(waits >= 4, "waited {waits} times, expected >= 4");
    }

    /// The exit-path budget is what app close will BLOCK for, so it is bounded
    /// from both sides: long enough that a healthy node actually finishes
    /// (two loopback round trips plus the parent's own daemon teardown), short
    /// enough that closing the wallet never reads as a hang.
    ///
    /// This assertion replaced `EXIT_LADDER_BUDGET_MS <= 2_000` on 2026-08-19.
    /// The old cap was correct for a *detached* ladder and wrong the moment the
    /// requirement became "the swap tree must not outlive the window" — at 2 s
    /// on a task nothing awaited, the tree routinely survived. See the const's
    /// docs for the two assumptions that failed.
    /// Step (b) on the exit path must be short enough that steps (c) and (d)
    /// still fit inside the overall budget.
    ///
    /// The ordering this pins is the whole point: on Windows the parent will
    /// NOT exit on its own inside any wait we can afford (its daemon
    /// interrupts are CTRL_C_EVENT to console-less children), so a step-(b)
    /// ceiling that eats the budget means the daemon-RPC tier — the tier that
    /// works — never runs before the timeout fires.
    #[test]
    fn exit_parent_wait_leaves_room_for_the_tiers_that_actually_work() {
        assert!(
            EXIT_PARENT_WAIT_MS < EXIT_LADDER_BUDGET_MS,
            "step (b) must not consume the whole exit budget"
        );
        // Step (c) alone sleeps 2 s for the LevelDB settle before it returns,
        // and then (d) has to run. Leave at least that much.
        assert!(
            EXIT_LADDER_BUDGET_MS - EXIT_PARENT_WAIT_MS >= 5_000,
            "only {}ms left for the daemon stops + terminate after step (b)",
            EXIT_LADDER_BUDGET_MS - EXIT_PARENT_WAIT_MS
        );
        assert!(
            EXIT_PARENT_WAIT_MS < LADDER_WAIT_MS,
            "the exit path must not wait as long as a user-driven stop"
        );
    }

    /// A Login page carries no shutdown link, so the token extractor must
    /// return `None` for it — which is exactly what `GET /` returned for the
    /// whole life of this module before the login handshake was added.
    ///
    /// This is the regression guard for the *symptom*: if
    /// `graceful_shutdown_via_http` ever loses its login step again, it will be
    /// parsing this shape.
    #[test]
    fn a_login_page_yields_no_shutdown_token() {
        // Trimmed from the real 14,807-byte body the live node returned to a
        // Basic-auth-only GET / (2026-08-19).
        let login_page = r#"<!DOCTYPE html><html lang="en"><head>
            <title>(BSX) BasicSwap - Login - v0.17.9</title></head>
            <body><form method="post" action="/login">
            <input type="password" name="password"></form></body></html>"#;
        assert_eq!(extract_shutdown_token(login_page), None);

        // And the authenticated page does yield one — same 16-hex shape the
        // live node minted.
        let index_page = r#"<a href="/shutdown/33954214a3226523" class="shutdown-button">"#;
        assert_eq!(
            extract_shutdown_token(index_page).as_deref(),
            Some("33954214a3226523")
        );
    }

    #[test]
    fn exit_ladder_budget_is_bounded_on_both_sides() {
        assert!(
            EXIT_LADDER_BUDGET_MS >= 5_000,
            "exit budget shrank to {EXIT_LADDER_BUDGET_MS}ms — too short for the parent to \
             stop its daemons, which puts the orphan back"
        );
        assert!(
            EXIT_LADDER_BUDGET_MS <= 20_000,
            "exit budget grew to {EXIT_LADDER_BUDGET_MS}ms — app close blocks on this"
        );
        assert!(
            EXIT_LADDER_BUDGET_MS < LADDER_WAIT_MS,
            "the exit path must never wait as long as an explicit user-driven stop"
        );
        assert_eq!(LADDER_WAIT_MS, 120_000, "ladder ceiling must match run.py's wait(timeout=120)");
    }

    // ── regression tests for the 2026-08-16 defect-register fixes ───

    /// W-8: an over-long hex run is not a valid 16-char token. The prior
    /// `.take(16)` truncated it and returned a WRONG token that still passed
    /// `len == 16`. It must now be rejected, and a genuine 16-char token found
    /// later on the page still returns.
    #[test]
    fn shutdown_token_rejects_an_overlong_hex_run() {
        // 17 hex chars after the needle → not a token.
        assert_eq!(extract_shutdown_token("/shutdown/0123456789abcdef0"), None);
        // A bad (over-long) hit followed by a good one still resolves.
        let html = r#"/shutdown/0123456789abcdef0 ... href="/shutdown/00112233445566ff""#;
        assert_eq!(
            extract_shutdown_token(html).as_deref(),
            Some("00112233445566ff")
        );
    }

    /// W-9: XMR host and port are a pair. A port with no host must emit NEITHER
    /// env var, because upstream disables the local XMR daemon if EITHER is set
    /// — a port-only config would disable it while configuring no host.
    #[test]
    fn prepare_plan_drops_xmr_port_when_host_is_absent() {
        let mut cfg = test_config();
        cfg.xmr_rpc_host = None;
        cfg.xmr_rpc_port = Some(18089);
        let plan = build_prepare_plan(&cfg);
        assert_eq!(plan.env("XMR_RPC_HOST"), None);
        assert_eq!(
            plan.env("XMR_RPC_PORT"),
            None,
            "a port with no host must not reach the env, or it silently disables the XMR daemon"
        );
    }

    /// W-5: the exit ladder must fire for a live child regardless of phase —
    /// especially `Failed`, which a health timeout leaves WITH a running child.
    #[test]
    fn exit_ladder_fires_for_a_live_child_even_when_not_running() {
        // Healthy/starting/stopping → running=true → fire.
        assert!(should_run_exit_ladder(true, Some(1234)));
        assert!(should_run_exit_ladder(true, None));
        // Failed-with-child: is_running()==false but a pid is live → MUST fire.
        assert!(
            should_run_exit_ladder(false, Some(1234)),
            "a Failed phase with a live child must still be torn down"
        );
        // Truly nothing to do.
        assert!(!should_run_exit_ladder(false, None));
    }

    /// U-3: the supervisor sizes BasicSwap's pid-wait budget to the contention.
    /// Remote XMR (fewer local daemons) gets a smaller ceiling than a full-local
    /// config, and the value is always well above upstream's default of 20.
    #[test]
    fn pid_wait_budget_scales_with_local_daemon_contention() {
        let mut cfg = test_config();
        // Remote XMR node configured → no local monerod → lighter contention.
        cfg.xmr_rpc_host = Some("node.example.org".to_string());
        let remote = build_run_plan(&cfg);
        assert_eq!(remote.env("BSX_PID_WAIT_ITERS"), Some("40"));
        // No remote node → a full-local config could run monerod too → more.
        cfg.xmr_rpc_host = None;
        let local = build_run_plan(&cfg);
        assert_eq!(local.env("BSX_PID_WAIT_ITERS"), Some("80"));
        // Both must beat upstream's hardcoded 20, or the fix does nothing.
        assert!("40".parse::<u32>().unwrap() > 20);
    }

    /// dbcache is the IBD speed lever. It must be present, larger than Core's
    /// 450 MB default, and it must respect a user's own value.
    #[test]
    fn harden_daemon_confs_sets_a_real_dbcache() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-dbcache-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let part = dir.join("particl");
        std::fs::create_dir_all(&part).unwrap();
        std::fs::write(part.join("particl.conf"), "rpcport=19792
").unwrap();

        // A coin whose conf already pins dbcache — a user override that must
        // NOT be second-guessed.
        let btc = dir.join("bitcoin");
        std::fs::create_dir_all(&btc).unwrap();
        std::fs::write(btc.join("bitcoin.conf"), "dbcache=300
rpcport=19796
").unwrap();

        harden_daemon_confs(&dir).expect("harden");

        let part_conf = std::fs::read_to_string(part.join("particl.conf")).unwrap();
        let line = part_conf
            .lines()
            .find(|l| l.trim_start().starts_with("dbcache="))
            .expect("particl.conf must gain a dbcache line");
        let mb: u64 = line.trim().trim_start_matches("dbcache=").parse().unwrap();
        assert!(
            mb > 450,
            "dbcache must beat Core's 450 MB default or it is pointless: {mb}"
        );
        assert!(mb <= 4096, "the ceiling must hold: {mb}");

        // The user's 300 MB stays. Lower than we would choose, but theirs.
        let btc_conf = std::fs::read_to_string(btc.join("bitcoin.conf")).unwrap();
        assert!(btc_conf.contains("dbcache=300"), "{btc_conf}");
        assert_eq!(btc_conf.matches("dbcache=").count(), 1, "no second dbcache");

        // Idempotent.
        harden_daemon_confs(&dir).unwrap();
        let again = std::fs::read_to_string(part.join("particl.conf")).unwrap();
        assert_eq!(again.matches("dbcache=").count(), 1, "second pass duplicated dbcache");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // =====================================================================
    // Option A — Particl pruning
    // =====================================================================

    /// Per-test scratch dir with a generated `particl.conf`, shaped like the
    /// one `interface/part/core.py` actually writes.
    fn prune_fixture(tag: &str, extra: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-prune-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let part = dir.join("particl");
        std::fs::create_dir_all(&part).unwrap();
        std::fs::write(
            part.join("particl.conf"),
            format!(
                "dbcache=4096\nlisten=0\nrpcport=19792\nwallet=bsx_wallet\n\
                 zmqpubsmsg=tcp://127.0.0.1:20792\nspentindex=1\ntxindex=1\nstaking=0\n{extra}"
            ),
        )
        .unwrap();
        dir
    }

    /// The core rewrite: both index lines out, `prune=` in, everything else
    /// byte-identical. The negative half matters as much as the positive —
    /// eating `wallet=` or `zmqpubsmsg=` would break the node silently.
    #[test]
    fn prune_particl_conf_strips_both_indexes_and_adds_prune() {
        let src = "dbcache=4096\nspentindex=1\nrpcport=19792\ntxindex=1\nwallet=bsx_wallet\n";
        let out = prune_particl_conf(src, PARTICL_PRUNE_MIB).expect("must rewrite");
        assert!(out.starts_with(&format!("prune={}\n", PARTICL_PRUNE_MIB)), "{out}");
        assert!(!out.contains("txindex="), "txindex survived: {out}");
        assert!(!out.contains("spentindex="), "spentindex survived: {out}");
        for keep in ["dbcache=4096", "rpcport=19792", "wallet=bsx_wallet"] {
            assert!(out.contains(keep), "rewrite ate {keep}: {out}");
        }
    }

    /// Idempotence, stated as the property that matters: a second pass must
    /// return None, not "a file that happens to look the same". `None` is what
    /// stops the caller writing the file on every single start.
    #[test]
    fn prune_particl_conf_is_a_noop_once_applied() {
        let src = "spentindex=1\ntxindex=1\nrpcport=19792\n";
        let once = prune_particl_conf(src, PARTICL_PRUNE_MIB).expect("first pass rewrites");
        assert!(
            prune_particl_conf(&once, PARTICL_PRUNE_MIB).is_none(),
            "second pass must be a no-op, got a rewrite of: {once}"
        );
    }

    /// A hand-set `prune=` is the user's. We still strip the indexes, because
    /// `prune=` beside `txindex=1` is the one combination particld REFUSES to
    /// start on (`init.cpp:1130`) — leaving it would be honouring a preference
    /// by breaking the node.
    ///
    /// The fixture carries BOTH index lines and the assertions name both:
    /// an earlier version set only `txindex=1` and asserted only on it, so a
    /// regression that stripped one index and left the other would have kept
    /// this test green while the node refused to start. Caught by injecting
    /// exactly that fault (2026-09-09) — the test said "strips indexes" and
    /// checked one.
    #[test]
    fn prune_particl_conf_keeps_a_hand_set_prune_but_still_strips_indexes() {
        let src = "prune=2000\ntxindex=1\nspentindex=1\nrpcport=19792\n";
        let out = prune_particl_conf(src, PARTICL_PRUNE_MIB).expect("indexes must still go");
        assert!(out.contains("prune=2000"), "user's value replaced: {out}");
        assert_eq!(out.matches("prune=").count(), 1, "second prune line: {out}");
        assert!(!out.contains("txindex="), "txindex survived: {out}");
        assert!(!out.contains("spentindex="), "spentindex survived: {out}");
    }

    /// A commented line is a note, not a setting. Deleting it would silently
    /// rewrite something the user wrote for themselves.
    #[test]
    fn prune_particl_conf_leaves_commented_index_lines_alone() {
        let src = "# txindex=1 was here for PART-leg swaps\nrpcport=19792\n";
        let out = prune_particl_conf(src, PARTICL_PRUNE_MIB).expect("must add prune");
        assert!(out.contains("# txindex=1 was here"), "comment eaten: {out}");
    }

    /// The safety gate, and the reason this is not just a conf rewrite: a
    /// datadir that already synced WITH the indexes must be left alone.
    /// Stripping them there produces "best block of the index goes beyond
    /// pruned data" (`init.cpp:2302`) — a node that will not start.
    #[test]
    fn an_already_indexed_chain_is_refused() {
        let dir = prune_fixture("indexed", "");
        std::fs::create_dir_all(dir.join("particl").join("blocks")).unwrap();
        std::fs::create_dir_all(dir.join("particl").join("indexes").join("txindex")).unwrap();

        assert_eq!(
            particl_chain_mode(&dir.join("particl")),
            ParticlChainMode::IndexedChainPresent
        );
        assert!(!apply_particl_prune_policy(&dir).unwrap(), "must refuse");
        let conf = std::fs::read_to_string(dir.join("particl").join("particl.conf")).unwrap();
        assert!(conf.contains("txindex=1"), "conf was rewritten anyway: {conf}");
        assert!(!conf.contains("prune="), "prune added to an indexed chain: {conf}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh datadir (no `blocks/` at all) is the normal first-run case.
    #[test]
    fn a_fresh_datadir_is_pruned() {
        let dir = prune_fixture("fresh", "");
        assert_eq!(particl_chain_mode(&dir.join("particl")), ParticlChainMode::Prunable);
        assert!(apply_particl_prune_policy(&dir).unwrap(), "must rewrite");

        let conf = std::fs::read_to_string(dir.join("particl").join("particl.conf")).unwrap();
        assert!(conf.contains(&format!("prune={}", PARTICL_PRUNE_MIB)), "{conf}");
        assert!(!conf.contains("txindex="), "{conf}");
        assert!(conf.contains("wallet=bsx_wallet"), "{conf}");

        // Second run writes nothing.
        assert!(!apply_particl_prune_policy(&dir).unwrap(), "second pass rewrote");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A chain that is already index-less — a previous pruned run, or a
    /// restored snapshot — is prunable, not "an existing chain, hands off".
    /// Getting this wrong would leave a snapshot-restored node unconfigured.
    #[test]
    fn an_index_less_chain_is_still_prunable() {
        let dir = prune_fixture("pruned-already", "");
        std::fs::create_dir_all(dir.join("particl").join("blocks")).unwrap();
        assert_eq!(particl_chain_mode(&dir.join("particl")), ParticlChainMode::Prunable);
        assert!(apply_particl_prune_policy(&dir).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The retained window must dwarf the longest lock a swap can ask for.
    /// `lock_value` is bounded at 96 h upstream; at ~250 bytes per Particl
    /// block and 2-minute spacing, 550 MiB is ~1.8 years. This pins the
    /// REASON rather than the number, so it stays honest if the floor moves.
    #[test]
    fn the_prune_budget_retains_far_more_than_any_lock_window() {
        const PARTICL_BLOCK_BYTES: u64 = 300; // measured 247-287, rounded up
        const SECONDS_PER_BLOCK: u64 = 120;
        let blocks_retained = PARTICL_PRUNE_MIB * 1024 * 1024 / PARTICL_BLOCK_BYTES;
        let hours_retained = blocks_retained * SECONDS_PER_BLOCK / 3600;
        assert!(
            hours_retained > 96 * 100,
            "prune={PARTICL_PRUNE_MIB} MiB retains only {hours_retained} h; the longest \
             swap lock is 96 h and the margin must be orders of magnitude, not tight"
        );
    }

    /// The archival choice must reach `PART_PRUNE`, and both values must be
    /// SENT — never omitted.
    ///
    /// `0` is PWNDA-PATCH-31's explicit "archival, no pruning". Omitting the
    /// variable instead would make its absence mean two different things
    /// ("archival" and "this build is too old to care"), and the patch reads
    /// upstream behaviour from exactly that absence.
    #[test]
    fn the_chain_choice_reaches_the_prepare_env() {
        let base = test_config();

        let pruned = prepare_time_envs(&SidecarConfig {
            archival_chain: false,
            ..base.clone()
        });
        let v = pruned
            .iter()
            .find(|(k, _)| k == "PART_PRUNE")
            .map(|(_, v)| v.clone())
            .expect("PART_PRUNE must always be sent");
        assert_eq!(v, PARTICL_PRUNE_MIB.to_string());

        let archival = prepare_time_envs(&SidecarConfig {
            archival_chain: true,
            ..base
        });
        let v = archival
            .iter()
            .find(|(k, _)| k == "PART_PRUNE")
            .map(|(_, v)| v.clone())
            .expect("PART_PRUNE must always be sent, archival included");
        assert_eq!(
            v, "0",
            "archival must send 0, not omit the variable — absence already \
             means 'upstream default' to the patch"
        );
    }

    /// The daemon pin must match the fetcher, or a snapshot built for the
    /// daemon we actually ship would be refused (or worse, one built for
    /// another daemon accepted). Same guard shape `grove.rs` uses for the
    /// engine tag, and for the same reason: a restated version in a constant is
    /// exactly what goes stale.
    #[test]
    fn particld_version_matches_the_fetcher_pin() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("scripts")
            .join("fetch-swap-runtime.mjs");
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        // Anchor on the COIN_CORES entry key, not on the bare word: "particl"
        // appears in comments and URLs long before the table, and the first
        // version after one of those belongs to a different coin entirely. The
        // first attempt at this test read "3.1.6" that way and failed for a
        // reason that had nothing to do with the pin.
        let key = "coin: \"particl\",";
        let idx = src
            .find(key)
            .expect("no `coin: \"particl\"` entry in COIN_CORES — did the table move?");
        let after = &src[idx + key.len()..];
        let vi = after.find("version:").expect("no version in the particl entry");
        let rest = &after[vi + "version:".len()..];
        let start = rest.find('"').unwrap() + 1;
        let end = start + rest[start..].find('"').unwrap();
        assert_eq!(
            &rest[start..end],
            PARTICLD_VERSION,
            "the fetcher pins a different particld than PARTICLD_VERSION"
        );
    }

    /// The scan-skip is passed ONLY for a chain prepare did not create.
    ///
    /// Both halves matter. Missing it on a restored snapshot means the node
    /// cannot start at all; passing it on an ordinary install would skip a
    /// birthday scan that upstream does for free and that a future restored-seed
    /// case may depend on.
    #[test]
    fn the_wallet_scan_skip_is_only_for_a_restored_chain() {
        let dir = std::env::temp_dir().join(format!("pwnda-scanfrom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("particl")).unwrap();

        // Fresh install: no chain at all.
        assert!(!crate::snapshot::chain_awaiting_first_prepare(&dir));

        // A restored snapshot: chain present, prepare has never run.
        std::fs::create_dir_all(dir.join("particl").join("blocks")).unwrap();
        assert!(crate::snapshot::chain_awaiting_first_prepare(&dir));

        // Once prepare has run, the chain is the node's own business again —
        // a later reconfigure must NOT skip the scan.
        std::fs::write(dir.join("basicswap.json"), "{}").unwrap();
        assert!(
            !crate::snapshot::chain_awaiting_first_prepare(&dir),
            "a configured datadir must not look like a pending restore"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A3: the three datadir shapes must map onto the status flag the UI reads,
    /// and only ONE of them is the "stuck on the old layout" case. Getting this
    /// backwards would either nag every healthy install or stay silent on the
    /// one install that needs the explanation.
    #[test]
    fn only_an_indexed_chain_reports_as_unpruned() {
        let cases: [(&str, bool, bool, bool); 3] = [
            // (tag, make blocks/, make indexes/txindex/, expect unpruned)
            ("fresh", false, false, false),
            ("pruned", true, false, false),
            ("legacy", true, true, true),
        ];
        for (tag, blocks, txindex, expect_unpruned) in cases {
            let dir = prune_fixture(&format!("a3-{tag}"), "");
            let part = dir.join("particl");
            if blocks {
                std::fs::create_dir_all(part.join("blocks")).unwrap();
            }
            if txindex {
                std::fs::create_dir_all(part.join("indexes").join("txindex")).unwrap();
            }
            let unpruned =
                particl_chain_mode(&part) == ParticlChainMode::IndexedChainPresent;
            assert_eq!(
                unpruned, expect_unpruned,
                "{tag}: blocks={blocks} txindex={txindex} reported unpruned={unpruned}"
            );
            // And the flag must agree with what the policy actually DOES, or the
            // UI would explain a state the supervisor is not in.
            let rewrote = apply_particl_prune_policy(&dir).unwrap();
            assert_eq!(
                rewrote, !expect_unpruned,
                "{tag}: status says unpruned={unpruned} but the policy \
                 {} — these must never disagree",
                if rewrote { "rewrote the conf" } else { "declined" }
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The disk quote must reflect the pruned node the supervisor now writes.
    /// Left as an inequality against the OLD unpruned figure so it fails loudly
    /// if someone restores 8.0 without restoring the prune policy with it.
    #[test]
    fn the_particl_disk_quote_is_the_pruned_one() {
        let gb = est_disk_gb(MANDATORY_COIN, false, CoinMode::Full);
        assert!(
            gb > 0.0 && gb < 3.0,
            "particl is pruned now (measured 1.15 GB, quoted just under the \
             pre-prune peak); {gb} GB looks like the old unpruned budget"
        );
    }

    /// The sizing formula: never below Core's default, never a runaway
    /// reservation, and it scales with RAM in between.
    #[test]
    fn dbcache_formula_is_clamped_and_scales() {
        // The live value on this machine must be sane.
        let mb = daemon_dbcache_mb();
        assert!((512..=4096).contains(&mb), "out of range: {mb}");
    }

    /// The firewall fix: harden_daemon_confs adds `listen=0` to a btc-family
    /// conf that lacks it, leaves an existing `listen=` setting alone, and does
    /// not invent a conf where none exists.
    ///
    /// **This test spent time not running.** Inserting
    /// `harden_daemon_confs_sets_a_real_dbcache` above it stranded this
    /// function's doc comment AND its `#[test]` attribute on the new test, which
    /// then carried two. `cargo test` reported one more passing test than it
    /// ran, and the only visible trace was a `duplicated attribute` warning in a
    /// build that emits several. Restored 2026-08-20.
    #[test]
    fn harden_daemon_confs_disables_the_p2p_listener_idempotently() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-conf-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let part = dir.join("particl");
        std::fs::create_dir_all(&part).unwrap();
        std::fs::write(part.join("particl.conf"), "regtest=1\n[regtest]\nrpcport=19792\n").unwrap();
        // litecoin conf that already pins listen — must be left untouched.
        let ltc = dir.join("litecoin");
        std::fs::create_dir_all(&ltc).unwrap();
        std::fs::write(ltc.join("litecoin.conf"), "listen=1\nrpcport=19795\n").unwrap();

        harden_daemon_confs(&dir).expect("harden should succeed");

        let part_conf = std::fs::read_to_string(part.join("particl.conf")).unwrap();
        assert!(
            part_conf.lines().any(|l| l.trim() == "listen=0"),
            "particl.conf must gain listen=0, got:\n{}",
            part_conf
        );
        // Idempotent: a second pass must not add a second listen line.
        harden_daemon_confs(&dir).unwrap();
        let again = std::fs::read_to_string(part.join("particl.conf")).unwrap();
        assert_eq!(
            again.matches("listen=").count(),
            1,
            "second pass must not duplicate listen="
        );
        // An existing listen= is respected, not overwritten.
        let ltc_conf = std::fs::read_to_string(ltc.join("litecoin.conf")).unwrap();
        assert!(ltc_conf.contains("listen=1") && !ltc_conf.contains("listen=0"));
        // No bitcoin dir → no bitcoin.conf invented.
        assert!(!dir.join("bitcoin").join("bitcoin.conf").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DEC-3 + W-10: the update ping is turned off, the file is rewritten
    /// WITHOUT a UTF-8 BOM (upstream's json.load rejects a BOM), a BOM present
    /// on the way IN is tolerated, other keys survive, and the result reparses.
    #[test]
    fn disable_update_ping_writes_bomless_check_updates_false() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-sidecar-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("basicswap.json");

        // Write WITH a BOM and check_updates:true to prove both are handled.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            br#"{"check_updates": true, "htmlport": 12700, "chainclients": {"particl": {}}}"#,
        );
        std::fs::write(&path, &bytes).unwrap();

        disable_update_ping(&dir).expect("disable_update_ping should succeed");

        let written = std::fs::read(&path).unwrap();
        assert_ne!(
            &written[..written.len().min(3)],
            &[0xEF, 0xBB, 0xBF],
            "the rewritten config must NOT start with a UTF-8 BOM"
        );
        let v: serde_json::Value =
            serde_json::from_slice(&written).expect("must reparse as plain UTF-8 JSON");
        assert_eq!(v["check_updates"], serde_json::Value::Bool(false));
        assert_eq!(v["htmlport"], 12700, "unrelated keys must survive");
        assert!(v["chainclients"]["particl"].is_object());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P3: a generated bitcoin-family chainclient has no `rpcuser`/
    /// `rpcpassword`, so `stop` must authenticate with the daemon's own
    /// `.cookie`. Both layouts (`mainnet` = datadir root, everything else = a
    /// chain subdir) must resolve, and the target must carry the datadir that
    /// makes the lookup possible at all.
    #[test]
    fn bitcoin_family_stop_credentials_come_from_the_auth_cookie() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-sidecar-cookie-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let part = dir.join("particl");
        std::fs::create_dir_all(part.join("regtest")).unwrap();

        // A config shaped like the one prepare actually writes: NO rpcuser and
        // NO rpcpassword. This is the shape that made an unauthenticated `stop`
        // the only thing the ladder could ever send.
        let cfg = format!(
            r#"{{"chainclients": {{"particl": {{
                 "connection_type": "rpc", "manage_daemon": true,
                 "rpchost": "127.0.0.1", "rpcport": 19792,
                 "datadir": {}}}}}}}"#,
            serde_json::to_string(&part.to_string_lossy().into_owned()).unwrap()
        );
        let targets = parse_chain_daemon_targets(&cfg).expect("config must parse");
        assert_eq!(targets.len(), 1);
        assert!(
            targets[0].user.is_none() && targets[0].password.is_none(),
            "the generated config genuinely has no static rpc credentials"
        );
        assert_eq!(
            targets[0].chain_datadir.as_deref(),
            Some(part.as_path()),
            "the target must carry the datadir the cookie lives under"
        );

        // No cookie yet → nothing to authenticate with.
        assert!(cookie_auth(&part).is_none());

        // regtest layout: <datadir>/regtest/.cookie
        std::fs::write(part.join("regtest").join(".cookie"), "__cookie__:abc123").unwrap();
        assert_eq!(
            cookie_auth(&part),
            Some(("__cookie__".to_string(), "abc123".to_string()))
        );

        // mainnet layout: <datadir>/.cookie, and it wins (probed first).
        std::fs::write(part.join(".cookie"), "__cookie__:mainnetpw").unwrap();
        assert_eq!(
            cookie_auth(&part),
            Some(("__cookie__".to_string(), "mainnetpw".to_string()))
        );

        // A malformed cookie is not credentials.
        std::fs::write(part.join(".cookie"), "__cookie__:").unwrap();
        std::fs::remove_file(part.join("regtest").join(".cookie")).unwrap();
        assert!(cookie_auth(&part).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── daemon-port preflight (P3 live-run defect) ──────────────────

    const PREFLIGHT_CONFIG: &str = r#"{
        "htmlport": 12700,
        "zmqport": 20792,
        "chainclients": {
            "particl":  {"connection_type": "rpc", "manage_daemon": true,
                         "rpchost": "127.0.0.1", "rpcport": 19792},
            "litecoin": {"connection_type": "electrum", "manage_daemon": false,
                         "rpchost": "127.0.0.1", "rpcport": 19895, "onionport": 9333},
            "monero":   {"connection_type": "rpc", "core_type_group": "xmr",
                         "manage_daemon": false, "manage_wallet_daemon": true,
                         "rpchost": "node.example.org", "rpcport": 18089,
                         "zmqport": 30898,
                         "walletrpchost": "127.0.0.1", "walletrpcport": 29998}
        }
    }"#;

    /// The preflight list must be exactly the loopback sockets **our own**
    /// processes bind: particld's RPC + the top-level SMSG zmq publisher, and
    /// the local monero-wallet-rpc. It must NOT contain the remote XMR node's
    /// rpcport (someone else's socket), the electrum-mode litecoin rpcport
    /// (no daemon at all), or any tor `onionport` (nothing binds it under
    /// `listen=0`, so it would invent conflicts).
    #[test]
    fn preflight_lists_only_ports_our_own_daemons_bind() {
        let ports = managed_loopback_ports(PREFLIGHT_CONFIG).expect("config must parse");
        let labels: Vec<&str> = ports.iter().map(|(l, _)| l.as_str()).collect();
        let nums: Vec<u16> = ports.iter().map(|(_, p)| *p).collect();

        assert!(nums.contains(&19792), "particl rpc must be probed: {:?}", ports);
        assert!(
            nums.contains(&20792),
            "the top-level SMSG zmqport must be probed: {:?}",
            ports
        );
        assert!(
            nums.contains(&29998),
            "the LOCAL monero-wallet-rpc port must be probed: {:?}",
            ports
        );
        assert!(
            !nums.contains(&18089),
            "the REMOTE xmr rpcport is not ours to bind: {:?}",
            ports
        );
        assert!(
            !nums.contains(&30898),
            "a remote-managed monerod's zmqport is not ours either: {:?}",
            ports
        );
        assert!(
            !nums.contains(&19895),
            "electrum-mode litecoin runs no daemon: {:?}",
            ports
        );
        assert!(
            !nums.contains(&9333),
            "onionport is never bound under listen=0: {:?}",
            ports
        );
        assert!(
            labels.iter().any(|l| l.contains("particl")),
            "labels must name the coin so the error is actionable: {:?}",
            labels
        );
    }

    /// The node's OWN http/ws sockets belong in the preflight too.
    ///
    /// Regression lock for 2026-08-28: they were absent, so a foreign process
    /// holding the UI port sailed past this check and surfaced a full budget
    /// later as `health timeout` — the failure the preflight exists to make
    /// impossible. `run.py` raises inside `start()` when `HttpThread` cannot
    /// bind, and swallows the traceback to stderr, so there is no other
    /// evidence to find.
    #[test]
    fn preflight_includes_the_nodes_own_http_and_ws_ports() {
        let cfg = r#"{
            "htmlhost": "127.0.0.1", "htmlport": 12700,
            "wshost": "127.0.0.1",   "wsport": 11700,
            "chainclients": {}
        }"#;
        let ports = managed_loopback_ports(cfg).expect("config must parse");
        let nums: Vec<u16> = ports.iter().map(|(_, p)| *p).collect();
        assert!(nums.contains(&12700), "the UI/API port must be probed: {:?}", ports);
        assert!(nums.contains(&11700), "the websocket port must be probed: {:?}", ports);
        assert!(
            ports.iter().any(|(l, _)| l.contains("http")),
            "labels must say which socket, so the error is actionable: {:?}",
            ports
        );

        // A non-loopback bind is someone else's socket, exactly as for daemons.
        let remote = r#"{
            "htmlhost": "0.0.0.0", "htmlport": 12700,
            "wshost": "127.0.0.1", "wsport": 11700,
            "chainclients": {}
        }"#;
        let ports = managed_loopback_ports(remote).expect("config must parse");
        let nums: Vec<u16> = ports.iter().map(|(_, p)| *p).collect();
        assert!(!nums.contains(&12700), "a non-loopback htmlhost is not ours: {:?}", ports);
        assert!(nums.contains(&11700), "the loopback ws port is still ours: {:?}", ports);
    }

    /// The whole point: a bound daemon port must be REPORTED, not walked into.
    /// Before this check the same situation produced 80 s of "particl.pid: No
    /// such file or directory" and then `exited with code 0` — a message that
    /// blames the pid-file wait (U-3) for a bind failure no wait can fix.
    #[tokio::test]
    async fn preflight_reports_a_bound_daemon_port_instead_of_spawning() {
        // Bind a real socket, then claim it as particl's rpcport.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral loopback port");
        let taken = listener.local_addr().unwrap().port();

        let dir = std::env::temp_dir().join(format!(
            "pwnda-sidecar-preflight-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = format!(
            // No htmlport on purpose: this test is about DAEMON ports, and a
            // hardcoded UI port makes it depend on that port being free on the
            // developer's machine. It stopped being free on 2026-08-28 (a
            // dockerised BasicSwap owns 12700 here), at which point this test
            // failed by correctly reporting a real conflict — the fixture's
            // assumption was the bug, not the code.
            r#"{{"chainclients": {{"particl": {{
                 "connection_type": "rpc", "manage_daemon": true,
                 "rpchost": "127.0.0.1", "rpcport": {}}}}}}}"#,
            taken
        );
        std::fs::write(dir.join("basicswap.json"), cfg).unwrap();

        let conflict = daemon_port_conflict(&dir).await;
        let msg = conflict.expect("a bound daemon port must be reported");
        assert!(
            msg.contains(&taken.to_string()) && msg.contains("particl"),
            "the message must name the coin and the port: {}",
            msg
        );

        // Free the port and the same config must pass.
        //
        // Retried on a FRESH ephemeral port each attempt, because the naive
        // form (`drop(listener); assert!(…is_none())`) is a race this suite
        // actually lost on 2026-08-19: the OS is free to hand the just-released
        // ephemeral port to any other process — and this repo's own test run
        // churns the ephemeral range hard — so the "free" port can be genuinely
        // bound by someone else a microsecond later. The failure then reads as
        // "a free port must not be reported as a conflict", i.e. it accuses the
        // code under test of the one thing that did not happen.
        drop(listener);
        let mut freed_ok = false;
        for _ in 0..8 {
            if daemon_port_conflict(&dir).await.is_none() {
                freed_ok = true;
                break;
            }
            // Someone took it. Re-point the config at a new ephemeral port.
            let l = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind an ephemeral loopback port");
            let p = l.local_addr().unwrap().port();
            drop(l);
            std::fs::write(
                dir.join("basicswap.json"),
                format!(
                    r#"{{"chainclients": {{"particl": {{
                         "connection_type": "rpc", "manage_daemon": true,
                         "rpchost": "127.0.0.1", "rpcport": {}}}}}}}"#,
                    p
                ),
            )
            .unwrap();
        }
        assert!(
            freed_ok,
            "a free port must not be reported as a conflict (8 ephemeral ports \
             were all re-taken, which is a machine problem, not a code one)"
        );

        // No config at all is the spawn's problem to report, not this one's.
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(daemon_port_conflict(&empty).await.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // =====================================================================
    // C1 / C5 — secrets: the newtype, the argv, the env
    // =====================================================================

    /// The 24-word BIP39 test phrase. Nothing in a `SidecarConfig` Debug
    /// legitimately contains any of these words, which is what makes
    /// "no word of it survives" a usable assertion.
    const TEST_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                               abandon abandon abandon about";
    const TEST_WALLET_KEY: &str = "kQ7fRz9vNbT2xLmWjHs4pYcE6uAdG1oX";

    fn secret_config() -> SidecarConfig {
        let mut cfg = test_config();
        cfg.particl_mnemonic = Some(Secret::new(TEST_PHRASE.to_string()));
        cfg.wallet_encryption_pwd = Some(Secret::new(TEST_WALLET_KEY.to_string()));
        cfg
    }

    /// R16 — `SidecarConfig` derives `Debug`, so a single `{:?}` anywhere in the
    /// supervisor prints the whole config. The ONLY thing standing between that
    /// and a recovery phrase in the log is [`Secret`]'s hand-written `Debug`.
    ///
    /// Falsify by deriving `Debug` on `Secret` instead of writing it: the
    /// phrase, and every word of it, reappears.
    #[test]
    fn secret_debug_is_redacted() {
        let cfg = secret_config();
        let dbg = format!("{:?}", cfg);

        assert!(
            !dbg.contains(TEST_PHRASE),
            "the whole phrase must not appear in Debug output:\n{}",
            dbg
        );
        for word in TEST_PHRASE.split_whitespace() {
            assert!(
                !dbg.contains(word),
                "the phrase word {:?} must not appear in Debug output:\n{}",
                word,
                dbg
            );
        }
        assert!(
            !dbg.contains(TEST_WALLET_KEY),
            "the wallet key must not appear in Debug output:\n{}",
            dbg
        );
        // ...and the redaction is visible rather than the field being silently
        // dropped, so a reader of the log knows a value was there.
        assert_eq!(
            dbg.matches("<redacted>").count(),
            2,
            "both secret fields must render as <redacted>:\n{}",
            dbg
        );
        // The same guarantee for the newtype on its own, which is what any
        // future container of a Secret inherits.
        assert_eq!(
            format!("{:?}", Secret::new(TEST_PHRASE.to_string())),
            "<redacted>"
        );
    }

    /// C1 — the phrase reaches upstream on prepare's argv, as ONE argv element
    /// (it contains spaces), and only when the caller supplied one.
    #[test]
    fn prepare_plan_carries_particl_mnemonic_only_when_present() {
        let with = build_prepare_plan(&secret_config());
        let expected = format!("--particl_mnemonic={}", TEST_PHRASE);
        assert!(
            with.args.iter().any(|a| a == &expected),
            "prepare must carry the phrase as a single argv element: {:?}",
            with.args
        );
        // One element, not twelve: `prepare.py:1311` splits on the FIRST '='
        // and takes the rest verbatim, so a phrase split across argv would
        // arrive as the single word "abandon".
        assert_eq!(
            with.args
                .iter()
                .filter(|a| a.starts_with("--particl_mnemonic"))
                .count(),
            1
        );

        // Absent means ABSENT — not `--particl_mnemonic=`, which upstream would
        // read as a set-but-empty phrase.
        let without = build_prepare_plan(&test_config());
        assert!(
            !without
                .args
                .iter()
                .any(|a| a.starts_with("--particl_mnemonic")),
            "no phrase configured => no flag at all: {:?}",
            without.args
        );
    }

    /// R1 — **the addcoin plan must never carry the phrase.** Falsify by
    /// pushing it into `build_addcoin_plan` and this goes red.
    ///
    /// Paired with the assertion that addcoin DOES carry the encryption var,
    /// so the test cannot be satisfied by an addcoin plan that simply forgot
    /// every secret.
    #[test]
    fn addcoin_plan_never_carries_the_mnemonic() {
        let cfg = secret_config();
        for coin in ["monero", "litecoin", "particl"] {
            let plan = build_addcoin_plan(&cfg, coin);
            assert!(
                !plan.args.iter().any(|a| a.contains("particl_mnemonic")),
                "--addcoin={} must not carry the phrase: {:?}",
                coin,
                plan.args
            );
            for word in TEST_PHRASE.split_whitespace() {
                assert!(
                    !plan.args.iter().any(|a| a.contains(word)),
                    "no phrase word may appear on the addcoin argv ({}): {:?}",
                    word,
                    plan.args
                );
            }
            assert!(
                !plan.envs.iter().any(|(_, v)| v.contains("abandon")),
                "nor in its env: {:?}",
                plan.envs
            );
            // The addcoin run still needs the encryption password, or the coin
            // it adds gets an UNENCRYPTED wallet while every other coin is
            // locked. Asserting it here is what stops "delete every secret"
            // from being a passing fix.
            assert_eq!(plan.env("WALLET_ENCRYPTION_PWD"), Some(TEST_WALLET_KEY));
        }
    }

    /// R5 — `run.py:361-371` raises `ValueError("Please unset the
    /// WALLET_ENCRYPTION_PWD environment variable.")`, so the node dies on
    /// EVERY start if this var reaches the run plan.
    ///
    /// Falsify by moving the push from `prepare_time_envs` into `shared_envs`:
    /// the run plan inherits it and this goes red.
    #[test]
    fn run_plan_never_carries_the_encryption_var() {
        let cfg = secret_config();
        let run = build_run_plan(&cfg);
        assert_eq!(
            run.env("WALLET_ENCRYPTION_PWD"),
            None,
            "the run plan must not carry the encryption password: {:?}",
            run.envs
        );
        assert!(
            !run.envs.iter().any(|(_, v)| v == TEST_WALLET_KEY),
            "and not under any other name either: {:?}",
            run.envs
        );
        // The paired positive: prepare DOES carry it. Without this half, a
        // build that dropped the feature entirely would still pass.
        assert_eq!(
            build_prepare_plan(&cfg).env("WALLET_ENCRYPTION_PWD"),
            Some(TEST_WALLET_KEY)
        );
        // ...and no config => no var, on either plan.
        assert_eq!(
            build_prepare_plan(&test_config()).env("WALLET_ENCRYPTION_PWD"),
            None
        );
    }

    /// R3 — a first prepare with a locked vault would mint a Particl wallet
    /// with a recovery phrase nobody has. The existing-config path is
    /// deliberately NOT gated (prepare.py:1436-1461 early-returns there).
    #[test]
    fn prepare_without_mnemonic_on_fresh_datadir_is_refused() {
        let err = check_first_prepare_gate(true, false, false)
            .expect_err("a fresh prepare with no phrase must be refused");
        assert_eq!(err, "the vault must be unlocked to create the swap wallet");

        // Existing config => not gated, even though prepare will run (a
        // reconfigure, or a recovered credsfile).
        assert!(check_first_prepare_gate(true, false, true).is_ok());
        // Phrase supplied => fine.
        assert!(check_first_prepare_gate(true, true, false).is_ok());
        // Ordinary start => prepare does not run at all.
        assert!(check_first_prepare_gate(false, false, false).is_ok());
    }

    /// F3 — [`Secret`] stops protecting a value the moment that value is
    /// formatted into a plan's `args` / `envs` as a plain `String`.
    /// `secret_debug_is_redacted` asserts over [`SidecarConfig`] and therefore
    /// could never have caught it: a `SpawnPlan` is a different type, and it
    /// used to `#[derive(Debug)]`.
    ///
    /// Falsify by putting `Debug` back in the derive list and deleting the
    /// hand-written impl: the phrase, its words, the wallet key and the auth
    /// password all reappear.
    #[test]
    fn spawn_plan_debug_redacts_argv_and_env() {
        let cfg = secret_config();
        let plan = build_prepare_plan(&cfg);
        let dbg = format!("{:?}", plan);

        // ── nothing secret survives ────────────────────────────────────
        assert!(
            !dbg.contains(TEST_PHRASE),
            "the whole phrase must not appear in a plan's Debug output:\n{}",
            dbg
        );
        for word in TEST_PHRASE.split_whitespace() {
            assert!(
                !dbg.contains(word),
                "the phrase word {:?} must not appear in a plan's Debug output:\n{}",
                word,
                dbg
            );
        }
        assert!(
            !dbg.contains(TEST_WALLET_KEY),
            "WALLET_ENCRYPTION_PWD's value must not appear:\n{}",
            dbg
        );
        assert!(
            !dbg.contains(&cfg.client_auth_password),
            "the node's auth password must not appear either — it is the \
             credential the API proxy injects, and W-7 already calls its argv \
             exposure bounded:\n{}",
            dbg
        );

        // ── ...and the plan is still worth printing ────────────────────
        // A redaction that ate the whole struct would pass every assertion
        // above and be useless. These are what make it a diagnostic.
        assert!(dbg.starts_with("SpawnPlan {"), "shape changed:\n{}", dbg);
        assert!(
            dbg.contains("--datadir"),
            "--datadir must survive verbatim:\n{}",
            dbg
        );
        assert!(
            dbg.contains("--withcoins=particl,litecoin,monero"),
            "ordinary argv must survive verbatim:\n{}",
            dbg
        );
        assert!(
            dbg.contains("WALLET_ENCRYPTION_PWD"),
            "the env KEY stays visible — 'was it set at all?' is the useful \
             question, and it is answerable without the value:\n{}",
            dbg
        );
        assert!(
            dbg.contains("--particl_mnemonic=<redacted>"),
            "the secret FLAG stays visible, only its value is elided:\n{}",
            dbg
        );
        assert!(
            dbg.contains("--client-auth-password=<redacted>"),
            "same for the auth password:\n{}",
            dbg
        );

        // ── the two-element spelling, which no builder emits today ─────
        // A `Debug` that only knew `--flag=value` would keep passing the
        // assertions above while going blind the day a builder switched to
        // `--flag value`. Covering it is the difference between a check that
        // can fail for the reason we run it and one that cannot.
        let two_element = SpawnPlan {
            program: "python.exe".to_string(),
            args: vec![
                "--particl_mnemonic".to_string(),
                TEST_PHRASE.to_string(),
                "--datadir=D".to_string(),
            ],
            envs: vec![("BASICSWAP_DATADIR".to_string(), "D".to_string())],
            cwd: PathBuf::from("D"),
        };
        let two_dbg = format!("{:?}", two_element);
        assert!(
            !two_dbg.contains("abandon"),
            "a phrase in the element AFTER its flag must still be elided:\n{}",
            two_dbg
        );
        assert!(
            two_dbg.contains("--datadir=D"),
            "only ONE element may be eaten — the next argv entry must survive:\n{}",
            two_dbg
        );

        // ── the match is on the flag, not on a loose prefix ────────────
        let near_miss = SpawnPlan {
            program: "python.exe".to_string(),
            args: vec![
                "--particl_mnemonic_file=C:/keys.txt".to_string(),
                "--datadirs=D".to_string(),
            ],
            envs: vec![(
                "WALLET_ENCRYPTION_PWD_FILE".to_string(),
                "C:/pwd.txt".to_string(),
            )],
            cwd: PathBuf::from("D"),
        };
        let near_dbg = format!("{:?}", near_miss);
        assert!(
            near_dbg.contains("--particl_mnemonic_file=C:/keys.txt")
                && near_dbg.contains("C:/pwd.txt"),
            "a different option that merely starts with a secret flag's name \
             must not be redacted — over-broad elision hides diagnostics:\n{}",
            near_dbg
        );

        // ── Eq still compares the REAL values ──────────────────────────
        // If equality were ever computed from the redacted rendering, two
        // plans carrying DIFFERENT phrases would compare equal, and every
        // plan test that asserts "this config produces that plan" would go
        // blind at once.
        let mut other = secret_config();
        other.particl_mnemonic = Some(Secret::new(
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong".to_string(),
        ));
        assert_eq!(build_prepare_plan(&cfg), build_prepare_plan(&cfg));
        assert_ne!(
            build_prepare_plan(&cfg),
            build_prepare_plan(&other),
            "plans differing only in the redacted value must NOT be equal"
        );
    }

    // =====================================================================
    // F4 — the wallet-password rotation is not the renderer's to drive
    // =====================================================================

    /// F4 — consent gates the rotation, and it is the FIRST thing checked.
    ///
    /// Falsify three ways, each of which goes red here:
    /// * delete the `opted_in` branch — the first assertion fails;
    /// * move it below the phase check — the second fails, because a
    ///   never-enabled install would then be told "not running";
    /// * make the gate refuse unconditionally — the paired positive fails.
    #[test]
    fn rotate_refuses_without_optin() {
        let err = check_rotation_gate(false, &Phase::Healthy, true)
            .expect_err("a rotation without consent must be refused");
        assert!(
            err.contains("has not been enabled"),
            "the OPT-IN check must produce this refusal: {}",
            err
        );

        // Consent is diagnosed before phase. A subsystem the user never
        // enabled has no node, so "the swap node is not running" would be a
        // true-but-useless answer that sends the reader to the wrong problem.
        let never_started = check_rotation_gate(false, &Phase::Stopped, false)
            .expect_err("still refused, and still for the opt-in reason");
        assert!(
            never_started.contains("has not been enabled"),
            "opt-in must be checked BEFORE the phase: {}",
            never_started
        );

        // The other two refusals, so "refuse everything" cannot pass.
        for phase in [
            Phase::Stopped,
            Phase::Preparing,
            Phase::Starting,
            Phase::Stopping,
            Phase::Failed {
                reason: "x".to_string(),
            },
        ] {
            let e = check_rotation_gate(true, &phase, true)
                .expect_err("only a Healthy node may rotate");
            assert!(
                e.contains("not running"),
                "{:?} must be refused as not-running: {}",
                phase,
                e
            );
        }
        let no_key = check_rotation_gate(true, &Phase::Healthy, false)
            .expect_err("upstream needs the OLD password; we hold it or nobody does");
        assert!(no_key.contains("no wallet key"), "{}", no_key);

        // ...and the paired positive.
        assert!(check_rotation_gate(true, &Phase::Healthy, true).is_ok());
    }

    /// F4 — **the webview may not name the swap wallet's new password.**
    ///
    /// After C3.5 that password is the only thing protecting the user's account
    /// xprv inside the node's `wallet.dat`, so a renderer that can set it to an
    /// attacker-known value has durable escrow over pre-existing funds. The
    /// command that allowed it is gone; these are the two facts that keep it
    /// gone.
    ///
    /// Both are asserted against the **source text**, because both are
    /// properties of *registration* rather than of any value a running test
    /// could produce:
    ///
    /// 1. `tauri::generate_handler![…]` in `lib.rs` lists no rotation command.
    ///    That list is the entire IPC surface; absence from it IS
    ///    unreachability. There is no runtime handle to assert on, and no
    ///    compile-time analogue — re-adding the line is a one-line edit that
    ///    builds.
    /// 2. this module puts no `#[tauri::command]` on `rotate_wallet_password`,
    ///    and its new key arrives as a [`Secret`]. Both halves are asserted,
    ///    because the compiler covers less here than it first appears to: the
    ///    attribute ALONE compiles fine — measured, see the helper's
    ///    "Re-exposing it" note — and only `#[tauri::command]` *together with*
    ///    a line in `generate_handler!` trips `Secret`'s missing
    ///    `Deserialize`. So the attribute assertion is not redundant with the
    ///    compiler, and the signature assertion catches the other half of the
    ///    pincer: a "fix" that widened the parameter back to `String` compiles
    ///    perfectly and takes the compile-time barrier away with it.
    #[test]
    fn rotate_key_cannot_come_from_the_webview() {
        // Relative to THIS file, so both paths are stable regardless of cwd.
        const LIB_RS: &str = include_str!("lib.rs");
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");

        // ── (1) the IPC surface ────────────────────────────────────────
        let start = LIB_RS
            .find("generate_handler![")
            .expect("lib.rs must register commands");
        let rest = &LIB_RS[start..];
        let end = rest
            .find("\n        ])")
            .expect("the handler list must be delimited by its closing `])`");
        // Comments stripped: the note in `lib.rs` explaining WHY the rotation
        // was removed names it, and a substring test over the raw text would
        // be satisfied — or tripped — by prose instead of by registrations.
        let handlers = rest[..end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            !handlers.contains("rotate_wallet_password"),
            "no wallet-password rotation may be registered as a tauri command — \
             it hands the renderer the effect of the DENIED `setpassword` \
             endpoint. Handler list:\n{}",
            handlers
        );
        // The paired positive: its SIBLING C5 command is still registered, so a
        // mis-sliced or empty handler list cannot make the assertion above pass.
        assert!(
            handlers.contains("swap_sidecar_set_wallet_key"),
            "the handler slice is wrong — it does not contain the C5 command \
             that IS registered:\n{}",
            handlers
        );

        // ── (2) the helper's own attributes and signature ──────────────
        let at = THIS_FILE
            .find("pub(crate) async fn rotate_wallet_password")
            .expect("the crate-private helper must still exist");
        // Walk backwards over the contiguous doc-comment/attribute block. The
        // doc comment *mentions* `#[tauri::command]` (it explains why there is
        // not one), so only lines that ARE attributes may be inspected.
        let attrs: Vec<&str> = THIS_FILE[..at]
            .lines()
            .rev()
            .map(|l| l.trim())
            .take_while(|l| l.starts_with("#[") || l.starts_with("//"))
            .filter(|l| l.starts_with("#["))
            .collect();
        assert!(
            attrs.contains(&"#[allow(dead_code)]"),
            "the attribute scan found nothing — it is not reading the right \
             lines, so its negative assertion below would be vacuous: {:?}",
            attrs
        );
        assert!(
            !attrs.iter().any(|a| a.starts_with("#[tauri::command]")),
            "rotate_wallet_password must not be a tauri command: {:?}",
            attrs
        );

        let sig_end = at + THIS_FILE[at..]
            .find(") -> Result")
            .expect("the helper's signature must end in a Result");
        let sig = &THIS_FILE[at..sig_end];
        assert!(
            sig.contains("new_key: Secret"),
            "the new key must arrive as a `Secret`: it has no `Deserialize`, so \
             naming this function in generate_handler! cannot compile. A \
             `String` here removes that barrier and re-opens F4:\n{}",
            sig
        );
    }

    // =====================================================================
    // C0.2 — the user's Monero node, all the way into basicswap.json
    // =====================================================================

    #[test]
    fn parse_node_url_handles_the_forms_a_user_can_produce() {
        assert_eq!(
            parse_node_url("http://127.0.0.1:18081"),
            Some(("127.0.0.1".to_string(), 18081))
        );
        assert_eq!(
            parse_node_url("https://xmr.example.org:18089"),
            Some(("xmr.example.org".to_string(), 18089))
        );
        // Bare host:port — what a hand-typed entry looks like.
        assert_eq!(
            parse_node_url("node.example.org:18089"),
            Some(("node.example.org".to_string(), 18089))
        );
        // Scheme-implied port. This is a URL fact, not a Monero guess.
        assert_eq!(
            parse_node_url("https://xmr.example.org"),
            Some(("xmr.example.org".to_string(), 443))
        );
        assert_eq!(
            parse_node_url("http://xmr.example.org"),
            Some(("xmr.example.org".to_string(), 80))
        );
        // Path / query / credentials are dropped, host and port survive.
        assert_eq!(
            parse_node_url("http://user:pw@xmr.example.org:18081/json_rpc?x=1"),
            Some(("xmr.example.org".to_string(), 18081))
        );
        assert_eq!(
            parse_node_url("  http://xmr.example.org:18081/  "),
            Some(("xmr.example.org".to_string(), 18081))
        );
        // Bracketed IPv6, with and without a port.
        assert_eq!(
            parse_node_url("http://[::1]:18081"),
            Some(("[::1]".to_string(), 18081))
        );
        assert_eq!(
            parse_node_url("https://[2001:db8::1]"),
            Some(("[2001:db8::1]".to_string(), 443))
        );

        // ── Refusals. Each one would otherwise write a WRONG rpcport. ──
        // No scheme and no port: the only way to produce a number is to
        // invent one, and 18081 is a guess, not a fact.
        assert_eq!(parse_node_url("node.example.org"), None);
        // A bare IPv6 literal: `rsplit_once(':')` would cut "1" out of the
        // ADDRESS and call it a port.
        assert_eq!(parse_node_url("::1"), None);
        assert_eq!(parse_node_url("2001:db8::1"), None);
        assert_eq!(parse_node_url("http://host:notaport"), None);
        assert_eq!(parse_node_url("http://host:99999"), None);
        assert_eq!(parse_node_url("http://host:0"), None);
        assert_eq!(parse_node_url("ftp://host:21"), None);
        assert_eq!(parse_node_url(""), None);
        assert_eq!(parse_node_url("   "), None);
        assert_eq!(parse_node_url("http://"), None);
    }

    /// The candidates are read out of the wallet's own plaintext store file,
    /// under the keys the node picker writes (`src/wallets/xmr-nodes.ts`).
    ///
    /// Migrated from a test of the single-value `pinned_node_from_store_json`,
    /// which the candidate list superseded. The single reader was DELETED
    /// rather than left dead: it reads one node and looks like a reasonable
    /// thing to call, so wiring it back would silently disable failover and
    /// nothing would fail — the node would just be brittle again.
    ///
    /// The half worth preserving verbatim is the resilience: a start must
    /// never be blocked by an unreadable preference file.
    #[test]
    fn candidates_are_read_from_the_wallet_store_keys() {
        let store = r#"{"wallet": "…", "xmr_selected_node": "http://10.0.0.5:18089"}"#;
        assert_eq!(
            xmr_node_candidates_from_store_json(store),
            vec![("10.0.0.5".to_string(), 18089)]
        );
        // Absent key, wrong type, unusable value, and a corrupt store are all
        // "no candidates" — never a failure that could block a start.
        assert!(xmr_node_candidates_from_store_json(r#"{"wallet": "…"}"#).is_empty());
        assert!(xmr_node_candidates_from_store_json(r#"{"xmr_selected_node": 5}"#).is_empty());
        assert!(
            xmr_node_candidates_from_store_json(r#"{"xmr_selected_node": "not a url"}"#)
                .is_empty()
        );
        assert!(xmr_node_candidates_from_store_json("{ not json").is_empty());
    }

    /// R17 — precedence is **explicit args > stored pin > none**. Reorder it
    /// and autostart silently overrides a node the user just picked in the UI.
    #[test]
    fn explicit_args_beat_the_pin() {
        let pin = Some(("pinned.example.org".to_string(), 18089));

        // Explicit host wins outright, and takes the explicit port with it.
        assert_eq!(
            resolve_xmr_node(Some("arg.example.org".into()), Some(18081), pin.clone()),
            (Some("arg.example.org".to_string()), Some(18081))
        );
        // An explicit host with no port does NOT borrow the pin's port — that
        // would silently splice two different nodes together.
        assert_eq!(
            resolve_xmr_node(Some("arg.example.org".into()), None, pin.clone()),
            (Some("arg.example.org".to_string()), None)
        );
        // No args => the pin, host AND port.
        assert_eq!(
            resolve_xmr_node(None, None, pin.clone()),
            (Some("pinned.example.org".to_string()), Some(18089))
        );
        // No args, no pin => nothing. A port with no host is dropped here
        // rather than left for `shared_envs` to discard (W-9).
        assert_eq!(resolve_xmr_node(None, Some(18081), None), (None, None));
    }

    /// R17 — **the test that can actually fail for the reason we run it.**
    ///
    /// `XMR_RPC_HOST` is read by upstream at PREPARE time and baked into
    /// `basicswap.json`; `run.py` reads the FILE. So asserting the env var was
    /// emitted proves nothing about an install that already has a config. This
    /// asserts the FILE.
    ///
    /// Drives the production funnel (`apply_local_config_policy`), not the
    /// writer in isolation, so removing the call from the start path fails
    /// here too.
    #[test]
    fn xmr_node_written_into_chainclients() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-xmrnode-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("basicswap.json");

        // The shape prepare writes for a LOCALLY managed monerod — which is
        // exactly the state a pin has to overwrite.
        std::fs::write(
            &path,
            br#"{"htmlport": 12700, "chainclients": {
                 "particl": {"rpcport": 19792},
                 "monero": {"manage_daemon": true, "rpchost": "127.0.0.1",
                            "rpcport": 29798, "walletrpcport": 29998}}}"#,
        )
        .unwrap();

        let mut cfg = test_config();
        cfg.datadir = dir.clone();
        cfg.xmr_rpc_host = Some("xmr.example.org".to_string());
        cfg.xmr_rpc_port = Some(18089);

        apply_local_config_policy(&cfg);

        let after_first = std::fs::read(&path).unwrap();
        assert_ne!(
            &after_first[..after_first.len().min(3)],
            &[0xEF, 0xBB, 0xBF],
            "W-10: the rewritten config must not start with a UTF-8 BOM"
        );
        let v: serde_json::Value = serde_json::from_slice(&after_first).unwrap();
        let xmr = &v["chainclients"]["monero"];
        assert_eq!(xmr["rpchost"], "xmr.example.org");
        assert_eq!(xmr["rpcport"], 18089);
        assert_eq!(
            xmr["manage_daemon"],
            serde_json::Value::Bool(false),
            "a remote node means the engine must not try to launch monerod"
        );
        // Untouched neighbours: the wallet RPC is still local, and the other
        // chainclients are intact.
        assert_eq!(xmr["walletrpcport"], 29998);
        assert_eq!(v["chainclients"]["particl"]["rpcport"], 19792);
        assert_eq!(v["htmlport"], 12700);

        // Idempotent to the BYTE. A second pass that rewrote the file would
        // mean every start dirties the config.
        apply_local_config_policy(&cfg);
        let after_second = std::fs::read(&path).unwrap();
        assert_eq!(
            after_first, after_second,
            "a second policy pass must not change a single byte"
        );

        // No monero chainclient => no-op. Inventing the block would mean
        // inventing every other key upstream's getConfigSegment fills in.
        let no_xmr = dir.join("no-xmr");
        std::fs::create_dir_all(&no_xmr).unwrap();
        let no_xmr_path = no_xmr.join("basicswap.json");
        let original = br#"{"chainclients": {"particl": {"rpcport": 19792}}}"#;
        std::fs::write(&no_xmr_path, original).unwrap();
        assert_eq!(
            apply_xmr_node_to_config(&no_xmr, "xmr.example.org", 18089),
            Ok(false)
        );
        assert_eq!(std::fs::read(&no_xmr_path).unwrap(), original.to_vec());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C9 — the same F6 shape as `xmr_node_written_into_chainclients` above,
    /// for the OTHER pin: `apply_local_config_policy` must actually write
    /// `mainwalletrpc*` when `SidecarConfig::xmr_host_wallet` is `Some`, on a
    /// patched engine, non-fatally skip on an unpatched one, and never touch
    /// the file when it's `None` (every install before C9 opts in).
    #[test]
    fn xmr_host_wallet_written_into_chainclients_when_patched() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-c9-policy-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let pkg = dir.join("basicswap");
        std::fs::create_dir_all(pkg.join("interface").join("xmr")).unwrap();
        let config_path = dir.join("basicswap.json");
        std::fs::write(
            &config_path,
            br#"{"chainclients": {"monero": {"rpcport": 18081}}}"#,
        )
        .unwrap();

        let host_wallet = XmrHostWalletParams {
            host: "127.0.0.1".to_string(),
            port: 28083,
            auth_user: Secret::new("u".to_string()),
            auth_pass: Secret::new("p".to_string()),
            wallet_name: "pwnda-active".to_string(),
            engine_pkg_dir: pkg.clone(),
        };
        let mut cfg = test_config();
        cfg.datadir = dir.clone();
        // Isolate the axis under test: test_config()'s baseline pins a
        // chainclient daemon (an orthogonal C0.2 concern this test is not
        // about), which would otherwise write its own rpchost/rpcport keys
        // and confuse "untouched neighbour" assertions below.
        cfg.xmr_rpc_host = None;
        cfg.xmr_rpc_port = None;
        cfg.xmr_host_wallet = Some(host_wallet);

        // Unpatched engine: non-fatal skip, config untouched — mirrors
        // `apply_host_xmr_wallet_to_config`'s own refusal, one level up.
        std::fs::write(
            pkg.join("interface").join("xmr").join("xmr.py"),
            "class XMRInterface:\n    pass\n",
        )
        .unwrap();
        std::fs::write(pkg.join("basicswap.py"), "class BasicSwap:\n    pass\n").unwrap();
        apply_local_config_policy(&cfg);
        let before = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            !before.contains("mainwalletrpcport"),
            "an unpatched engine must not have anything written for it: {before}"
        );

        // Patched: the pin lands.
        std::fs::write(
            pkg.join("interface").join("xmr").join("xmr.py"),
            "# PWNDA-PATCH-5\n# PWNDA-PATCH-8\n",
        )
        .unwrap();
        std::fs::write(
            pkg.join("basicswap.py"),
            "# PWNDA-PATCH-8\nclass BasicSwap:\n    pass\n",
        )
        .unwrap();
        apply_local_config_policy(&cfg);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let m = &v["chainclients"]["monero"];
        assert_eq!(m["mainwalletrpchost"], "127.0.0.1");
        assert_eq!(m["mainwalletrpcport"], 28083);
        assert_eq!(
            m["mainwalletrpcauth"],
            serde_json::json!(["u", "p"]),
            "must be a 2-element ARRAY, not a joined string -- callrpc_xmr 
             (rpc_xmr.py) does auth[0]/auth[1], and a string would silently 
             index by character instead of raising"
        );
        assert_eq!(m["wallet_name"], "pwnda-active");
        // The chainclient DAEMON pin is a different axis — untouched here,
        // since this cfg's xmr_rpc_host/port are both None.
        assert!(m.get("rpchost").is_none());

        // `xmr_host_wallet: None` — every install before C9 opts in — must
        // never write these keys at all, even with a patched engine sitting
        // right there.
        let no_share_path = dir.join("no-share-basicswap.json");
        std::fs::write(
            &no_share_path,
            br#"{"chainclients": {"monero": {"rpcport": 18081}}}"#,
        )
        .unwrap();
        let mut cfg_no_share = test_config();
        cfg_no_share.datadir = dir.join("no-share-parent");
        std::fs::create_dir_all(&cfg_no_share.datadir).unwrap();
        std::fs::write(
            cfg_no_share.datadir.join("basicswap.json"),
            br#"{"chainclients": {"monero": {"rpcport": 18081}}}"#,
        )
        .unwrap();
        cfg_no_share.xmr_host_wallet = None;
        apply_local_config_policy(&cfg_no_share);
        let untouched =
            std::fs::read_to_string(cfg_no_share.datadir.join("basicswap.json")).unwrap();
        assert!(!untouched.contains("mainwalletrpcport"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F6, again: the writer above works, but does anything actually CALL
    /// it with a populated `xmr_host_wallet`? `maybe_activate_xmr_host_wallet`
    /// is async and touches live Tauri state, so it isn't unit-testable the
    /// way the pure writer is — this instead proves the WIRING exists by
    /// reading the source, the same class of check
    /// `set_xmr_host_wallet_refuses_every_coin_but_monero` already uses
    /// elsewhere in this file for exactly this reason.
    #[test]
    fn swap_sidecar_start_actually_calls_maybe_activate_xmr_host_wallet() {
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");
        let start_at = THIS_FILE
            .find("pub async fn swap_sidecar_start(")
            .expect("swap_sidecar_start must still exist");
        let start_body = &THIS_FILE[start_at..];
        let build_config_at = start_body
            .find("let cfg = build_config(")
            .expect("swap_sidecar_start must still call build_config");
        // Scoped to BEFORE build_config's call, not the whole function tail —
        // a mention anywhere in the file would make this vacuous.
        let before_build = &start_body[..build_config_at];
        assert!(
            before_build.contains("maybe_activate_xmr_host_wallet(&app).await"),
            "swap_sidecar_start no longer calls maybe_activate_xmr_host_wallet \
             BEFORE build_config — C9 would go back to being wired but never \
             invoked, same as it was before this patch"
        );
        assert!(
            build_config_at > 0,
            "sanity: build_config must be found after maybe_activate_xmr_host_wallet's search window"
        );
        // And the result must actually be threaded INTO build_config, not
        // just computed and discarded.
        let build_config_call_end = build_config_at
            + start_body[build_config_at..]
                .find(")?;")
                .expect("build_config's call must terminate")
            + ")?;".len();
        let build_config_call = &start_body[build_config_at..build_config_call_end];
        assert!(
            build_config_call.contains("xmr_host_wallet"),
            "build_config's call site does not pass xmr_host_wallet through: {}",
            build_config_call
        );
    }

    /// C-RZ's twin of the wiring-proof test immediately above — same
    /// "read the source" technique (`maybe_activate_zph_host_wallet` is
    /// async + touches live Tauri state, so it isn't unit-testable the way
    /// `apply_host_zph_wallet_to_config` itself is), same two assertions:
    /// called BEFORE `build_config`, and its result actually threaded IN.
    #[test]
    fn swap_sidecar_start_actually_calls_maybe_activate_zph_host_wallet() {
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");
        let start_at = THIS_FILE
            .find("pub async fn swap_sidecar_start(")
            .expect("swap_sidecar_start must still exist");
        let start_body = &THIS_FILE[start_at..];
        let build_config_at = start_body
            .find("let cfg = build_config(")
            .expect("swap_sidecar_start must still call build_config");
        let before_build = &start_body[..build_config_at];
        assert!(
            before_build.contains("maybe_activate_zph_host_wallet(&app).await"),
            "swap_sidecar_start no longer calls maybe_activate_zph_host_wallet \
             BEFORE build_config — C-RZ would go back to being wired but never \
             invoked"
        );
        let build_config_call_end = build_config_at
            + start_body[build_config_at..]
                .find(")?;")
                .expect("build_config's call must terminate")
            + ")?;".len();
        let build_config_call = &start_body[build_config_at..build_config_call_end];
        assert!(
            build_config_call.contains("zph_host_wallet"),
            "build_config's call site does not pass zph_host_wallet through: {}",
            build_config_call
        );
    }

    /// C-RX's twin of the two wiring-proof tests immediately above — same
    /// "read the source" technique (`maybe_activate_zano_host_wallet` is
    /// async + touches live Tauri state, so it isn't unit-testable the way
    /// `apply_host_zano_wallet_to_config` itself is), same two assertions:
    /// called BEFORE `build_config`, and its result actually threaded IN.
    #[test]
    fn swap_sidecar_start_actually_calls_maybe_activate_zano_host_wallet() {
        const THIS_FILE: &str = include_str!("swap_sidecar.rs");
        let start_at = THIS_FILE
            .find("pub async fn swap_sidecar_start(")
            .expect("swap_sidecar_start must still exist");
        let start_body = &THIS_FILE[start_at..];
        let build_config_at = start_body
            .find("let cfg = build_config(")
            .expect("swap_sidecar_start must still call build_config");
        let before_build = &start_body[..build_config_at];
        assert!(
            before_build.contains("maybe_activate_zano_host_wallet(&app).await"),
            "swap_sidecar_start no longer calls maybe_activate_zano_host_wallet \
             BEFORE build_config — C-RX would go back to being wired but never \
             invoked"
        );
        let build_config_call_end = build_config_at
            + start_body[build_config_at..]
                .find(")?;")
                .expect("build_config's call must terminate")
            + ")?;".len();
        let build_config_call = &start_body[build_config_at..build_config_call_end];
        assert!(
            build_config_call.contains("zano_host_wallet"),
            "build_config's call site does not pass zano_host_wallet through: {}",
            build_config_call
        );
    }

    // =====================================================================
    // C5 — unlock ordering and the privileged door
    // =====================================================================

    /// A [`SessionSink`] that records phases and enforces the same transition
    /// gate the production sink does.
    /// **F6 — the C0.2 no-op trap, one call level up.**
    ///
    /// `xmr_node_written_into_chainclients` calls `apply_local_config_policy`
    /// directly, so it proves the WRITER works and says nothing about whether
    /// the start path ever calls it. An adversarial review deleted the call
    /// from `start_node_core`'s existing-config branch and the whole suite
    /// stayed green — which is R17's own failure mode (prepare bakes the env,
    /// `run.py` reads the FILE) moved up one level: a pinned node that never
    /// reaches `basicswap.json` is a pin that does nothing.
    ///
    /// So this drives the real funnel. `start_node_core` with
    /// `run_prepare: false` applies the config policy BEFORE it spawns, so
    /// pointing `python` at a path that cannot exist makes the start fail
    /// *after* the write — letting the test assert on the file while needing
    /// no python parent.
    #[tokio::test]
    async fn start_path_pins_the_xmr_node_into_the_config_file() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-startpin-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // A minimal existing config: the branch under test is the one taken
        // when prepare does NOT run.
        std::fs::write(
            dir.join("basicswap.json"),
            r#"{"htmlport":12700,"wsport":11700,"chainclients":{"monero":{"connection_type":"rpc","manage_daemon":true,"rpchost":"127.0.0.1","rpcport":29798}}}"#,
        )
        .unwrap();

        let mut cfg = test_config();
        cfg.datadir = dir.clone();
        cfg.xmr_rpc_host = Some("node.example.org".to_string());
        cfg.xmr_rpc_port = Some(18089);
        // Guarantees the spawn fails, so the test never needs a real node.
        cfg.python = dir.join("definitely-not-a-real-python.exe");

        // Must start from Stopped: `start_node_core` sets Preparing first, and
        // Starting -> Preparing is an illegal transition, which would abort the
        // function before it reached the code under test.
        let sink = RecordingSink {
            phase: StdMutex::new(Phase::Stopped),
            phases: StdMutex::new(Vec::new()),
        };
        let ports = SessionPorts {
            run_prepare: false,
            port_offset: 0,
            html_port: 12700,
            ws_port: 11700,
        };
        // Expected to fail at spawn; the write we care about already happened.
        let _ = start_node_core(&sink, &cfg, ports, false, 10, 10).await;

        let raw = std::fs::read_to_string(dir.join("basicswap.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mon = &v["chainclients"]["monero"];
        assert_eq!(
            mon["rpchost"].as_str(),
            Some("node.example.org"),
            "the START PATH must pin the node into basicswap.json — upstream reads \
             this file, not our env var, on every run after the first prepare.\n{raw}"
        );
        assert_eq!(mon["rpcport"].as_u64(), Some(18089), "port not pinned:\n{raw}");
        assert_eq!(
            mon["manage_daemon"].as_bool(),
            Some(false),
            "a remote node must turn the managed local daemon OFF:\n{raw}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct RecordingSink {
        phase: StdMutex<Phase>,
        phases: StdMutex<Vec<Phase>>,
    }

    impl RecordingSink {
        fn starting() -> Self {
            Self {
                phase: StdMutex::new(Phase::Starting),
                phases: StdMutex::new(Vec::new()),
            }
        }
        fn phases(&self) -> Vec<Phase> {
            self.phases.lock().unwrap().clone()
        }
    }

    impl SessionSink for RecordingSink {
        fn set_phase(&self, next: Phase) -> Result<(), String> {
            let mut cur = self.phase.lock().map_err(|e| e.to_string())?;
            if !cur.can_transition_to(&next) {
                return Err(format!("illegal sidecar transition {:?} -> {:?}", cur, next));
            }
            *cur = next.clone();
            self.phases.lock().map_err(|e| e.to_string())?.push(next);
            Ok(())
        }
        fn progress(&self, _stage: &str, _percent: f64, _message: &str) {}
        fn on_spawned(
            &self,
            _child: tokio::process::Child,
            _pid: Option<u32>,
            _ports: &SessionPorts,
            _password: &str,
        ) -> Result<(), String> {
            Ok(())
        }
        fn child_exit_code(&self) -> Option<i32> {
            None
        }
    }

    /// R6 — every consumer reads `Healthy` as "this node can sign". A node
    /// whose wallets did not unlock must therefore never reach it.
    ///
    /// Falsify by moving the `unlock.await` in `finalize_healthy` below
    /// `set_phase(Phase::Healthy)`: `Healthy` appears in the recorded phases
    /// and this goes red.
    #[tokio::test]
    async fn unlock_failure_prevents_healthy() {
        let sink = RecordingSink::starting();
        let err = finalize_healthy(&sink, async {
            Err("swap node HTTP 401: Unauthorized".to_string())
        })
        .await
        .expect_err("a failed unlock must fail the start");
        assert!(
            err.contains("could not be unlocked"),
            "the error must name the unlock, not look like a health timeout: {}",
            err
        );

        let phases = sink.phases();
        assert!(
            !phases.iter().any(|p| matches!(p, Phase::Healthy)),
            "Healthy must never be reached after a failed unlock: {:?}",
            phases
        );
        assert!(
            matches!(phases.last(), Some(Phase::Failed { .. })),
            "the session must end at Failed: {:?}",
            phases
        );

        // The paired positive, so "never set Healthy" is not a passing fix.
        let ok_sink = RecordingSink::starting();
        finalize_healthy(&ok_sink, async { Ok(()) })
            .await
            .expect("a successful unlock must reach Healthy");
        assert_eq!(ok_sink.phases(), vec![Phase::Healthy]);
    }

    /// The Rust-side privileged door refuses anything that is not one of its
    /// two literals — checked BEFORE any socket is opened, so an unlisted path
    /// cannot even be attempted.
    #[tokio::test]
    async fn privileged_post_refuses_an_unlisted_path() {
        for path in ["wallets/XMR/withdraw", "getcoinseed", "lock", "coins"] {
            let err = privileged_post(1, "pw", path, serde_json::json!({}))
                .await
                .expect_err("an unlisted path must be refused");
            assert!(
                err.contains("not a privileged swap-node endpoint"),
                "the GUARD must produce the failure, not the network: {}",
                err
            );
        }
    }

    /// R15 / contract 0.4 — the privileged Rust path exists so `unlock` and
    /// `setpassword` work from the backend. The failure mode is somebody
    /// "simplifying" it by adding them to the allow-list instead.
    ///
    /// Asserts `check_endpoint` **alone** rejects, so the test cannot pass on
    /// `DENIED_ENDPOINTS` doing the work.
    #[test]
    fn unlock_and_setpassword_stay_webview_denied() {
        for name in ["unlock", "setpassword", "lock", "getcoinseed"] {
            let segs = vec![name.to_string()];
            for m in [ApiMethod::Get, ApiMethod::Post] {
                assert!(
                    check_endpoint(&segs, m).is_err(),
                    "check_endpoint alone must reject {} ({:?})",
                    name,
                    m
                );
            }
            // Belt and braces: the denylist and the URL builder still refuse
            // too, including the sub-path spellings.
            assert!(is_denied_endpoint(name));
            assert!(build_api_url(12700, &format!("/json/{}", name), ApiMethod::Post).is_err());
        }
        // The unlock's own coin-scoped spelling, which upstream also serves.
        assert!(check_endpoint(
            &["unlock".to_string(), "PART".to_string()],
            ApiMethod::Post
        )
        .is_err());
    }
}

// =========================================================================
// LIVE INTEGRATION TEST (P3) — real runtime, real particld, regtest only
// =========================================================================
//
// Everything above this line had been unit-tested and stub-tested; the GLUE
// (config-gen -> prepare -> spawn -> health-poll -> shutdown ladder) had never
// been executed against a live node. This module closes that gap by driving
// [`start_node_core`] / [`stop_node_core`] — the *same* functions the
// `#[tauri::command]` wrappers delegate to — against the pre-built workspace
// runtime.
//
// **Double-gated**, matching the repo convention for tests that spawn real
// processes (`desk::conductor::cli_*`, `xmr_rpc`'s live tier): `#[ignore]`
// *and* its own env flag, so no blanket `cargo test -- --ignored` can start a
// swap node.
//
// ```text
//   $env:PWNDA_SIDECAR_ITEST = "1"
//   cargo test --features full --lib swap_sidecar:: -- --ignored --nocapture
// ```
//
// **regtest only.** The chain is a private throwaway whose datadir the test
// creates and deletes; `--regtest` never reaches mainnet or a public testnet,
// and nothing here funds a wallet or executes a swap.
//
// Requirements (the "proven stack"):
//   <work>/runtime/python.exe   embedded CPython 3.12 + basicswap at the pinned
//                               tag (crate::grove::EXPECTED_UPSTREAM_VERSION)
//   <work>/bin/particl/particld.exe
// where `<work>` is `<repo>/.swap-sidecar-work`, overridable with
// `PWNDA_SIDECAR_ITEST_WORK`.
#[cfg(test)]
mod itest {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// `<repo>/.swap-sidecar-work`, or `PWNDA_SIDECAR_ITEST_WORK`.
    fn work_dir() -> PathBuf {
        if let Ok(p) = std::env::var("PWNDA_SIDECAR_ITEST_WORK") {
            if !p.trim().is_empty() {
                return PathBuf::from(p);
            }
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri always has a parent")
            .join(".swap-sidecar-work")
    }

    /// Test-side [`SessionSink`]. Deliberately enforces the SAME
    /// [`Phase::can_transition_to`] gate the production sink does, so a live
    /// run also proves the state machine accepts the real sequence.
    struct ItestSink {
        phase: StdMutex<Phase>,
        phases: StdMutex<Vec<Phase>>,
        progress: StdMutex<Vec<(String, f64, String)>>,
        child: StdMutex<Option<tokio::process::Child>>,
        pid: StdMutex<Option<u32>>,
        ports: StdMutex<Option<SessionPorts>>,
    }

    impl ItestSink {
        fn new() -> Self {
            Self {
                phase: StdMutex::new(Phase::Stopped),
                phases: StdMutex::new(Vec::new()),
                progress: StdMutex::new(Vec::new()),
                child: StdMutex::new(None),
                pid: StdMutex::new(None),
                ports: StdMutex::new(None),
            }
        }
    }

    impl SessionSink for ItestSink {
        fn set_phase(&self, next: Phase) -> Result<(), String> {
            let mut cur = self.phase.lock().map_err(|e| e.to_string())?;
            if !cur.can_transition_to(&next) {
                return Err(format!("illegal sidecar transition {:?} -> {:?}", cur, next));
            }
            *cur = next.clone();
            self.phases.lock().map_err(|e| e.to_string())?.push(next);
            Ok(())
        }

        fn progress(&self, stage: &str, percent: f64, message: &str) {
            eprintln!(
                "[itest progress] {:>10} {:5.1}%  {}",
                stage, percent, message
            );
            if let Ok(mut v) = self.progress.lock() {
                v.push((stage.to_string(), percent, message.to_string()));
            }
        }

        fn on_spawned(
            &self,
            child: tokio::process::Child,
            pid: Option<u32>,
            ports: &SessionPorts,
            _password: &str,
        ) -> Result<(), String> {
            eprintln!(
                "[itest] spawned python parent pid={:?} html_port={} ws_port={}",
                pid, ports.html_port, ports.ws_port
            );
            *self.child.lock().map_err(|e| e.to_string())? = Some(child);
            *self.pid.lock().map_err(|e| e.to_string())? = pid;
            *self.ports.lock().map_err(|e| e.to_string())? = Some(ports.clone());
            Ok(())
        }

        fn child_exit_code(&self) -> Option<i32> {
            let mut guard = self.child.lock().ok()?;
            match guard.as_mut()?.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                _ => None,
            }
        }
    }

    /// One raw GET, returning `(status, body)` so the test can assert the
    /// literal 200 rather than only `health_check`'s `Ok`.
    async fn raw_get(port: u16, path: &str, password: Option<&str>) -> (Option<u16>, String) {
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => return (None, format!("client build failed: {}", e)),
        };
        let mut req = client.get(format!("http://127.0.0.1:{}{}", port, path));
        if let Some(p) = password {
            req = req.header("Authorization", basic_auth_header(p));
        }
        match req.send().await {
            Ok(r) => {
                let s = r.status().as_u16();
                let b = r.text().await.unwrap_or_default();
                (Some(s), b)
            }
            Err(e) => (None, e.to_string()),
        }
    }

    /// `<datadir>/.pids` as `(coin, pid)` — upstream writes it after spawning
    /// the chain daemons (run.py:598-602) and rewrites it with only the
    /// still-running ones on exit (run.py:648-659).
    fn read_daemon_pids(datadir: &Path) -> Vec<(String, u32)> {
        std::fs::read_to_string(datadir.join(".pids"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| {
                let (c, p) = l.split_once(':')?;
                Some((c.trim().to_string(), p.trim().parse().ok()?))
            })
            .collect()
    }

    /// The live orphan check, scoped to PIDs we actually started so an
    /// unrelated `python.exe` on the box cannot make this pass or fail.
    async fn still_alive(pid: u32) -> Option<String> {
        crate::platform::pid_image_name(pid).await
    }

    /// A brand-new, empty datadir. **Never a re-wipe.**
    ///
    /// The first live passes tried `remove_dir_all` + recreate between retries
    /// and it does not work on Windows: the call deletes part of the tree and
    /// then fails (LevelDB `LOCK`/`.ldb` handles and the AV scanner that
    /// follows them), leaving `particl/particl.conf` behind while
    /// `basicswap.json` is gone. That is exactly the half-prepared state
    /// [`half_prepared_hint`] names, and it makes every subsequent prepare exit
    /// 1 in ~366 ms. A fresh path per attempt cannot inherit anything.
    fn fresh_datadir(root: &Path, attempt: u32) -> PathBuf {
        let dd = root.join(format!("attempt-{}", attempt)).join("datadir");
        std::fs::create_dir_all(&dd)
            .unwrap_or_else(|e| panic!("create {}: {}", dd.display(), e));
        assert!(
            std::fs::read_dir(&dd).map(|mut d| d.next().is_none()).unwrap_or(false),
            "{} must start empty",
            dd.display()
        );
        dd
    }

    /// prepare -> spawn -> authenticated `/json/coins` 200 -> shutdown ladder ->
    /// zero orphans, against the real embedded runtime on a private regtest
    /// chain with **particl only** (mandatory SMSG coin; fastest, and the
    /// production-shaped path).
    #[tokio::test]
    #[ignore = "live: spawns a real regtest BasicSwap node. Set PWNDA_SIDECAR_ITEST=1 to arm."]
    async fn itest_particl_regtest_start_health_and_shutdown() {
        if std::env::var("PWNDA_SIDECAR_ITEST").ok().as_deref() != Some("1") {
            eprintln!(
                "itest: SKIPPED - PWNDA_SIDECAR_ITEST is not \"1\". This test starts real chain \
                 daemons; it stays off unless explicitly armed."
            );
            return;
        }

        let work = work_dir();
        let python = work.join("runtime").join("python.exe");
        let bin_dir = work.join("bin");
        assert!(
            python.is_file(),
            "the embedded runtime is missing: {}",
            python.display()
        );
        assert!(
            bin_dir.join("particl").join("particld.exe").is_file(),
            "particld.exe is missing under {}",
            bin_dir.display()
        );

        // Scratch space — a private regtest chain the test mints and deletes.
        // Best-effort sweep of what previous runs left, then a run-unique root
        // so a leftover we could NOT delete can never be inherited.
        let _ = std::fs::remove_dir_all(work.join("p3-itest"));
        let root = work.join("p3-itest").join(format!(
            "run-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("create the scratch root");
        eprintln!("[itest] scratch root {}", root.display());

        // U-2: `--nocores` means prepare fetches nothing, but the flag is part
        // of the documented Windows env and costs nothing to set. `shared_envs`
        // does not emit it, so it rides the inherited process environment.
        std::env::set_var("SKIP_GPG_VALIDATION", "true");

        let password = crate::wallet_rpc_common::random_hex(24);

        let make_cfg = |dd: &Path, offset: u16| SidecarConfig {
            archival_chain: false,
            python: python.clone(),
            datadir: dd.to_path_buf(),
            bin_dir: bin_dir.clone(),
            network: Network::Regtest,
            wallet_encrypted: false,
            adoption_coins: Vec::new(),
            coins: vec!["particl".to_string()],
            lean_coins: Vec::new(),
            enabled_coins: vec!["particl".to_string()],
            client_auth_password: password.clone(),
            html_base_port: DEFAULT_HTML_PORT,
            ws_base_port: DEFAULT_WS_PORT,
            port_offset: offset,
            xmr_rpc_host: None,
            xmr_rpc_port: None,
            xmr_host_wallet: None,
            zph_host_wallet: None,
            zano_host_wallet: None,
            trust_remote_node: false,
            particl_mnemonic: None,
            wallet_encryption_pwd: None,
        };

        // ── Offset selection, the way the production scan CANNOT ────
        //
        // `resolve_port_offset` probes only the UI pair, which is the defect
        // `daemon_port_conflict` now reports (this run's first attempt died on
        // it: another BasicSwap held regtest 19792). The test therefore learns
        // the config's real daemon ports from a throwaway prepare at offset 0,
        // then picks an offset where the UI pair AND every daemon port is free.
        // No port table is hardcoded — upstream's own config is the source.
        let probe_dd = fresh_datadir(&root, 0);
        run_prepare_step(&make_cfg(&probe_dd, 0))
            .await
            .unwrap_or_else(|e| panic!("probe prepare failed: {}", e.detail));
        let probe_raw = std::fs::read(probe_dd.join("basicswap.json"))
            .expect("the probe prepare must write basicswap.json");
        let base_daemon_ports = managed_loopback_ports(
            strip_bom(&probe_raw).expect("probe config is UTF-8"),
        )
        .expect("probe config must parse");
        eprintln!(
            "[itest] daemon ports at offset 0: {:?}",
            base_daemon_ports
        );
        assert!(
            base_daemon_ports
                .iter()
                .any(|(label, _)| label == "particl rpc"),
            "the preflight must see particl's RPC port: {:?}",
            base_daemon_ports
        );

        // The round hundreds `candidate_offsets()` yields are exactly what every
        // other BasicSwap on this box also picks — upstream's own test framework
        // strides the same way, and this machine has one running: offsets 0, 100
        // and 200 were each taken out from under a probe on consecutive attempts.
        // So the sweep leads with a 137 stride nobody else uses and keeps the
        // production-shaped candidates as the tail. A *test-environment*
        // concession; it says nothing about the product's offset policy.
        let sweep: Vec<u16> = (1..=24u16)
            .map(|i| 1000 + i * 137)
            .chain(candidate_offsets())
            .collect();

        let free_offset = |tried: Vec<u16>| {
            let base_daemon_ports = base_daemon_ports.clone();
            let sweep = sweep.clone();
            async move {
                for off in sweep {
                    if tried.contains(&off) {
                        continue;
                    }
                    let mut wanted: Vec<u16> =
                        ports_for_offset(DEFAULT_HTML_PORT, DEFAULT_WS_PORT, off).to_vec();
                    wanted.extend(base_daemon_ports.iter().map(|(_, p)| p.saturating_add(off)));
                    let mut all_free = true;
                    for p in &wanted {
                        if crate::wallet_rpc_common::port_is_bound(*p).await {
                            eprintln!("[itest] offset {} rejected: port {} is bound", off, p);
                            all_free = false;
                            break;
                        }
                    }
                    if all_free {
                        return Some(off);
                    }
                }
                None
            }
        };

        // A neighbouring process can claim a port between the probe and the
        // spawn — it did, on this machine, twice. That is a genuine TOCTOU and
        // `daemon_port_conflict` is what turns it into a one-line diagnosis
        // instead of a mystery, so the test retries on exactly that message and
        // on nothing else.
        let mut sink = ItestSink::new();
        let mut tried: Vec<u16> = Vec::new();
        let mut start_res: Result<SessionPorts, String> =
            Err("no attempt was made".to_string());
        let mut elapsed = std::time::Duration::ZERO;
        let mut ports_used: Option<SessionPorts> = None;
        let mut datadir = probe_dd.clone();

        for attempt in 1..=3u32 {
            let offset = free_offset(tried.clone()).await.expect(
                "no candidate offset had BOTH a free UI pair and free daemon ports — \
                 something else on this box is using the whole range",
            );
            tried.push(offset);
            eprintln!("[itest] attempt {}: port offset {}", attempt, offset);

            // A brand-new datadir per attempt — never a re-wipe. See
            // `fresh_datadir` for the Windows partial-delete this avoids.
            datadir = fresh_datadir(&root, attempt);
            eprintln!("[itest] datadir {}", datadir.display());

            let configured = configured_ports_in(&datadir);
            assert!(configured.is_none(), "the scratch datadir must start empty");
            let ports = plan_session_ports(
                configured,
                Some(offset),
                DEFAULT_HTML_PORT,
                DEFAULT_WS_PORT,
            )
            .expect("a free loopback port pair");
            assert!(ports.run_prepare, "a fresh datadir must schedule prepare");
            eprintln!(
                "[itest] planned ports offset={} html={} ws={}",
                ports.port_offset, ports.html_port, ports.ws_port
            );
            let cfg = make_cfg(&datadir, ports.port_offset);
            ports_used = Some(ports.clone());

            // -- the thing under test --------------------------------
            // A fresh sink per attempt: the phase trace asserted below must
            // describe THIS start, not a previous attempt's failure.
            sink = ItestSink::new();
            let started_at = std::time::Instant::now();
            start_res = start_node_core(
                &sink,
                &cfg,
                ports.clone(),
                /* run_prepare */ true,
                READY_BUDGET_MS,
                READY_POLL_MS,
            )
            .await;
            elapsed = started_at.elapsed();
            let retryable = start_res
                .as_ref()
                .err()
                .map(|e| e.contains("already in use"))
                .unwrap_or(false);
            if !retryable {
                break;
            }
            eprintln!(
                "[itest] attempt {} lost a port race, retrying on a new offset: {}",
                attempt,
                start_res.as_ref().err().cloned().unwrap_or_default()
            );
        }
        eprintln!("[itest] start_node_core -> {:?} in {:?}", start_res, elapsed);

        // Facts captured BEFORE teardown so the asserts at the bottom still
        // have them if anything below panics.
        let ports = ports_used.expect("at least one attempt must have planned ports");
        let parent_pid = *sink.pid.lock().unwrap();
        let phases = sink.phases.lock().unwrap().clone();
        let session_ports = sink.ports.lock().unwrap().clone().unwrap_or(ports.clone());
        let daemon_pids = read_daemon_pids(&datadir);
        eprintln!("[itest] .pids = {:?}", daemon_pids);

        // Config artefacts — read them here so a shutdown that rewrites
        // something cannot mask a prepare defect.
        let cfg_path = datadir.join("basicswap.json");
        let cfg_present = cfg_path.is_file();
        let cfg_raw = std::fs::read(&cfg_path).unwrap_or_default();
        let cfg_json: Option<serde_json::Value> = strip_bom(&cfg_raw)
            .ok()
            .and_then(|s| serde_json::from_str(s).ok());
        let cfg_has_bom = cfg_raw.starts_with(&[0xEF, 0xBB, 0xBF]);
        let part_conf = std::fs::read_to_string(datadir.join("particl").join("particl.conf"))
            .unwrap_or_default();

        // Live API probes while the node is still up.
        let (coins_status, coins_body) = if start_res.is_ok() {
            raw_get(session_ports.html_port, "/json/coins", Some(&password)).await
        } else {
            (None, String::new())
        };
        let (unauth_status, _) = if start_res.is_ok() {
            raw_get(session_ports.html_port, "/json/coins", None).await
        } else {
            (None, String::new())
        };

        // -- shutdown ladder — runs even when the start failed, because a
        //    failed start is exactly the case that can leave a child behind --
        let outcome = stop_node_core(
            session_ports.html_port,
            &password,
            parent_pid,
            datadir.clone(),
            LadderConfig::default(),
        )
        .await;
        eprintln!(
            "[itest] ladder: clean={} steps={:?} daemons_stopped={} notes={:?}",
            outcome.clean, outcome.steps, outcome.daemons_stopped, outcome.notes
        );

        // -- orphan sweep, scoped to the PIDs WE started -------------
        let port_bound_after =
            crate::wallet_rpc_common::port_is_bound(session_ports.html_port).await;
        let mut orphans: Vec<String> = Vec::new();
        if let Some(pp) = parent_pid {
            if let Some(img) = still_alive(pp).await {
                orphans.push(format!("python parent pid {} still alive as {}", pp, img));
            }
        }
        for (coin, dp) in &daemon_pids {
            if let Some(img) = still_alive(*dp).await {
                orphans.push(format!("{} daemon pid {} still alive as {}", coin, dp, img));
            }
        }
        // Test hygiene: never leave a stray behind even when we are about to
        // fail. Recorded in `orphans` FIRST so the cleanup cannot hide it.
        if !orphans.is_empty() {
            eprintln!("[itest] ORPHANS DETECTED, force-cleaning: {:?}", orphans);
            for (_, dp) in &daemon_pids {
                let _ = crate::wallet_rpc_common::kill_pid_force(*dp).await;
            }
            if let Some(pp) = parent_pid {
                let _ = crate::wallet_rpc_common::kill_pid_force(pp).await;
            }
        }

        // -- assertions ----------------------------------------------
        let start_err = start_res.as_ref().err().cloned().unwrap_or_default();

        // (1) prepare succeeded and wrote basicswap.json.
        assert!(
            cfg_present,
            "prepare did not write basicswap.json. start_node_core said: {}",
            start_err
        );
        let cfgv = cfg_json.expect("basicswap.json must be readable, BOM-tolerant JSON");
        assert!(!cfg_has_bom, "W-10: basicswap.json must be written BOM-less");
        assert!(
            cfgv["chainclients"]["particl"].is_object(),
            "basicswap.json must carry a particl chainclient: {}",
            cfgv
        );

        // (2) DEC-3: the update ping is off in the config prepare just wrote.
        assert_eq!(
            cfgv["check_updates"],
            serde_json::Value::Bool(false),
            "check_updates must be false in {}",
            cfg_path.display()
        );

        // (3) F-1: the coin conf carries listen=0 (no Windows Firewall prompt).
        assert!(
            part_conf.lines().any(|l| l.trim() == "listen=0"),
            "particl.conf must carry listen=0, got:\n{}",
            part_conf
        );

        // (4) the node spawned, and (5) went healthy inside the ready budget.
        assert!(
            parent_pid.is_some(),
            "no python parent pid was recorded — the spawn never happened. {}",
            start_err
        );
        assert!(
            start_res.is_ok(),
            "start_node_core failed after {:?}: {}",
            elapsed,
            start_err
        );
        assert_eq!(
            phases,
            vec![Phase::Preparing, Phase::Starting, Phase::Healthy],
            "the live phase sequence must be Preparing -> Starting -> Healthy"
        );
        assert!(
            elapsed < std::time::Duration::from_millis(READY_BUDGET_MS),
            "reaching healthy took {:?}, over the {} ms budget",
            elapsed,
            READY_BUDGET_MS
        );

        // (6) an AUTHENTICATED GET /json/coins returns 200 with a usable list.
        assert_eq!(
            coins_status,
            Some(200),
            "authenticated GET /json/coins must be 200, body: {}",
            snippet(&coins_body)
        );
        let coins = parse_coins_health(&coins_body)
            .unwrap_or_else(|e| panic!("/json/coins body did not parse: {} - {}", e, coins_body));
        assert!(
            coins.iter().any(|c| c.name.eq_ignore_ascii_case("particl")),
            "the coin list must contain particl: {:?}",
            coins
        );
        // The credential is load-bearing, not decorative: without it the same
        // URL must NOT be 200.
        assert_ne!(
            unauth_status,
            Some(200),
            "unauthenticated GET /json/coins must not succeed (got {:?})",
            unauth_status
        );

        // (7) the ladder ran and returned clean — the parent exited on its own
        //     after step (a), so nothing had to be forced.
        assert_eq!(
            outcome.steps,
            vec![LadderStep::GracefulParent, LadderStep::BoundedWait],
            "a healthy node must stop on the graceful rung alone; notes: {:?}",
            outcome.notes
        );
        assert!(
            outcome.clean,
            "the ladder did not come back clean: notes={:?}",
            outcome.notes
        );
        assert!(
            !port_bound_after,
            "the UI port {} is still bound after the ladder",
            session_ports.html_port
        );

        // (8) no orphan python or particld.
        assert!(
            !daemon_pids.is_empty(),
            "upstream wrote no .pids — the test would then be asserting nothing about particld"
        );
        assert!(
            orphans.is_empty(),
            "processes survived the shutdown ladder: {:?}",
            orphans
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
