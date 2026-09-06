//! Zephyr wallet-rpc sidecar manager.
//!
//! Zephyr Protocol is a Monero-lineage fork (Monero → Haven → Zephyr). Its
//! `zephyr-wallet-rpc.exe` speaks the same JSON-RPC protocol over HTTP
//! Digest as `monero-wallet-rpc.exe`, with asset-aware additions to a
//! handful of methods (`get_balance`, `transfer`, `sweep_all`). We run it
//! as a second sidecar on loopback port **18083** (Monero uses 18082) so
//! both wallets can be active simultaneously.
//!
//! The protocol details (digest auth, raw TCP transport, pidfile cleanup,
//! log-tail-on-error) live in `wallet_rpc_common` so Monero and Zephyr
//! can't drift. The Zephyr-specific pieces are: the binary name, the port,
//! the wallet-dir path, and the download URL template.
//!
//! Security notes (identical to Monero):
//!   - `--rpc-login` always passed; `--disable-rpc-login` never used.
//!   - `--trusted-daemon` only for localhost/127.0.0.1. Remote nodes
//!     never receive the secret view key.
//!   - Bound to loopback only (`--rpc-bind-ip 127.0.0.1`).

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

use crate::wallet_rpc_common::{
    delete_creds_file, delete_pidfile, do_rpc_call_at, port_is_bound, probe_node, random_hex,
    read_creds_file, read_log_tail, read_pidfile, write_creds_file,
    write_pidfile, NodeProbeResult,
};

// Only the pidfile-precise kill survives. The by-image sweep, the
// netstat-PID lookup and the by-PID force-kill were dropped 2026-08-13 with
// the port-fallback change: we no longer need to evict whoever holds 18083,
// so we no longer terminate processes we don't own.
#[cfg(target_os = "windows")]
use crate::platform::kill_process_by_pid_and_image;

#[cfg(target_os = "windows")]
use crate::wallet_rpc_common::CREATE_NO_WINDOW;

// =========================================================================
// Zephyr-specific constants
// =========================================================================

/// Loopback port that zephyr-wallet-rpc binds to. Must match `zph-rpc.ts`.
/// One higher than Monero's 18082 so both can run concurrently.
pub const ZPH_RPC_PORT: u16 = 18083;

/// The port the CURRENT Zephyr sidecar is actually bound to.
///
/// `ZPH_RPC_PORT` is the PREFERRED port, not a guarantee — see
/// `xmr_rpc::ACTIVE_XMR_PORT` for the full rationale. Zephyr's exposure is the
/// same shape as Monero's: 18083 sits one above Monero's 18082, so a machine
/// running a Monero stack (whose ZMQ-RPC lands on 18082) frequently has a
/// second wallet-rpc on 18083 too.
static ACTIVE_ZPH_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(ZPH_RPC_PORT);

/// Port the running (or last-started) Zephyr sidecar is bound to.
pub fn active_zph_port() -> u16 {
    ACTIVE_ZPH_PORT.load(std::sync::atomic::Ordering::Relaxed)
}

fn set_active_zph_port(port: u16) {
    ACTIVE_ZPH_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
}

/// JSON-RPC endpoint for the running sidecar. Computed per call — this was a
/// `const` pinned to 18083, which became wrong the moment the sidecar bound
/// anywhere else.
fn zph_rpc_url() -> String {
    format!("http://127.0.0.1:{}/json_rpc", active_zph_port())
}

/// On-disk filename of the primary Zephyr wallet. Must match `zph-rpc.ts`'s
/// `ZPH_WALLET_FILENAME`. Grove expansion plan, Phase C, unit C-RZ: the same
/// role [`crate::xmr_rpc::XMR_PRIMARY_WALLET_FILENAME`] plays for C9 — the
/// ONE wallet file `apply_host_zph_wallet_to_config` (in `swap_sidecar.rs`)
/// ever points the swap engine's Zephyr `wallet_name` at. Primary-wallet
/// only, for the same reason C9 is: `wallet_name` is written once into a
/// config the engine reads once at start, and a per-wallet (secondary ZEPH
/// wallet) filename isn't knowable at swap-node autostart with the vault
/// locked — see `maybe_activate_zph_host_wallet`'s own doc comment.
pub const ZPH_PRIMARY_WALLET_FILENAME: &str = "pwnda-zph-active";

/// Image name used for PID-safe taskkill filtering. Platform-dependent
/// via cfg so it stays a `&'static str` for the existing call sites.
#[cfg(target_os = "windows")]
const ZPH_BINARY_NAME: &str = "zephyr-wallet-rpc.exe";
#[cfg(not(target_os = "windows"))]
const ZPH_BINARY_NAME: &str = "zephyr-wallet-rpc";

/// Minimum file size below which a file at the expected path is considered
/// a placeholder stub rather than the real binary. Real Zephyr wallet-rpc
/// is ~18–25 MB; a placeholder would be a few hundred bytes.
const REAL_BINARY_MIN_SIZE: u64 = 5 * 1024 * 1024;

/// Wallet-dir subdirectory name (inside `%APPDATA%/com.pwnda.wallet/`).
const ZPH_WALLET_DIR_NAME: &str = "zph-wallets";

/// Subdirectory for auto-downloaded binary + extraction staging.
const ZPH_BINARY_DIR_NAME: &str = "zephyr";

// =========================================================================
// Per-session state
// =========================================================================

pub struct ZphRpcInner {
    pub child: Option<tokio::process::Child>,
    /// Random (username, password) generated fresh each time — unless the
    /// spawn is for [`ZphLease::SwapEngine`] and a stable pair already
    /// exists, see [`creds_for_spawn`].
    pub creds: Option<(String, String)>,
}

pub struct ZphRpcChild(pub Mutex<ZphRpcInner>);

// =========================================================================
// PWNDA-LEASE (Grove expansion plan, Phase C, unit C-RZ): single-flight +
// refcount tracking for the Zephyr wallet-rpc process — ported from
// `XmrLease`/`XmrRpcInner::leases`/`starting` in `xmr_rpc.rs`. See that
// module's doc comments for the full incident this closes (two callers
// racing a spawn on the same port) and why a lease set exists at all (two
// independent owners — the user's own Zephyr panel and the swap engine
// under this unit's C9-shaped ZEPH sharing — must not be able to kill each
// other's dependency on the same process by calling stop).
//
// **Divergence from `XmrRpcInner`'s shape, and why:** XMR keeps `leases`
// and `starting` as fields ON `XmrRpcInner` itself, alongside `child` and
// `creds`. This unit's OWNS is `zph_rpc.rs` and `swap_sidecar.rs` only —
// `src-tauri/src/lib.rs` (which constructs the initial `ZphRpcChild`/
// `ZphRpcInner` by an exhaustive field-by-field literal, the same way it
// does for `XmrRpcInner` two lines above it) is explicitly out of scope for
// this unit, so widening `ZphRpcInner`'s field list would force an edit
// there too. Instead, the lease set and the single-flight `starting` flag
// live in a module-local static, [`lease_state`], guarded by its own lock.
//
// **Why this stays exactly as atomic as XMR's single combined lock:** every
// call site that touches `starting` or `leases` acquires the `ZphRpcChild`
// Tauri-state lock FIRST (the same lock `child`/`creds` already live
// behind) and the [`lease_state`] lock SECOND, nested inside it, and never
// releases the outer lock between the "is a child/spawn already
// in-flight?" read and the "claim it" write — the same all-or-nothing
// window `xmr_start_rpc` holds under its one lock. A second caller cannot
// observe a partially-committed state because it must wait for the SAME
// outer lock before it can even begin its own read. Fixed lock order
// (`ZphRpcChild` outer, `lease_state()` inner) is maintained everywhere in
// this file to avoid a lock-order inversion.
static ZPH_LEASE_STATE: OnceLock<Mutex<ZphLeaseState>> = OnceLock::new();

fn lease_state() -> &'static Mutex<ZphLeaseState> {
    ZPH_LEASE_STATE.get_or_init(|| Mutex::new(ZphLeaseState::default()))
}

/// Who currently wants the Zephyr wallet-rpc process alive. Mirrors
/// `xmr_rpc::XmrLease` exactly — see that type's doc comment for the full
/// rationale.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ZphLease {
    /// The user's own Zephyr panel.
    Session,
    /// The swap engine's requirement that the process be listening for its
    /// startup probe and any main-wallet call (C9-shaped sharing for ZEPH;
    /// see `swap_sidecar::maybe_activate_zph_host_wallet`).
    SwapEngine,
}

/// The lease set + single-flight flag, split out of `ZphRpcInner` — see the
/// divergence note above [`ZPH_LEASE_STATE`].
#[derive(Default)]
pub struct ZphLeaseState {
    pub leases: HashSet<ZphLease>,
    /// True from the moment a caller has committed to spawning a fresh
    /// process until that attempt resolves, success or failure. Mirrors
    /// `XmrRpcInner::starting` — see `xmr_rpc.rs`'s PWNDA-SINGLE-FLIGHT
    /// comment for the incident this closes.
    pub starting: bool,
}

impl ZphLeaseState {
    /// Remove `lease` and report whether the caller should now actually
    /// stop the process. `child_present` is read by the caller from
    /// `ZphRpcInner` under the SAME (outer) lock acquisition — see the
    /// divergence note above [`ZPH_LEASE_STATE`] for why that keeps this as
    /// atomic as `XmrRpcInner::release_lease`, which reads `self.child`
    /// directly because both live on the same struct.
    ///
    /// Pure given its inputs, so it is unit-testable exactly like
    /// `XmrRpcInner::release_lease` without needing a real child process —
    /// slightly MORE directly, in fact: `child_present` is just a `bool`
    /// parameter here instead of requiring a placeholder `Child` to spawn.
    pub fn release_lease(&mut self, lease: ZphLease, child_present: bool) -> bool {
        self.leases.remove(&lease);
        child_present && self.leases.is_empty()
    }
}

/// What a caller of `zph_start_rpc` should do, given the state read under
/// ONE combined lock acquisition (see the divergence note above
/// [`ZPH_LEASE_STATE`]). Mirrors `xmr_rpc::XmrStartDecision` exactly.
#[derive(Debug, PartialEq, Eq)]
pub enum ZphStartDecision {
    /// A process already exists — attach the lease, spawn nothing.
    AlreadyRunning,
    /// Another caller is mid-spawn — attach the lease and back off.
    AlreadyStarting,
    /// Neither running nor starting — this caller claims it and spawns.
    ShouldSpawn,
}

/// See [`ZphStartDecision`]. `child_running` and `starting` must both come
/// from the SAME combined lock acquisition — mirrors `xmr_rpc::decide_xmr_start`
/// exactly (same three-way branch, same reasoning).
pub fn decide_zph_start(child_running: bool, starting: bool) -> ZphStartDecision {
    if child_running {
        ZphStartDecision::AlreadyRunning
    } else if starting {
        ZphStartDecision::AlreadyStarting
    } else {
        ZphStartDecision::ShouldSpawn
    }
}

/// PWNDA-STABLE-CREDS (mirrors `xmr_rpc::creds_for_spawn`): which
/// credentials a fresh wallet-rpc spawn should use. Pure — no I/O, no
/// randomness of its own (the caller supplies `fresh` via a closure
/// precisely so this stays that way) — only [`ZphLease::SwapEngine`]
/// consults `existing_stable`, and only when it's present. `Session` always
/// calls `fresh()` and ignores `existing_stable` entirely, which is what
/// keeps this a no-op for anyone who has never touched C9-shaped ZEPH
/// sharing.
fn creds_for_spawn(
    lease: ZphLease,
    existing_stable: Option<&(String, String)>,
    fresh: impl FnOnce() -> (String, String),
) -> (String, String) {
    if lease == ZphLease::SwapEngine {
        if let Some(pair) = existing_stable {
            return pair.clone();
        }
    }
    fresh()
}

// =========================================================================
// Binary + directory resolution
// =========================================================================

fn is_real_binary(p: &PathBuf) -> bool {
    match std::fs::metadata(p) {
        Ok(meta) => meta.len() >= REAL_BINARY_MIN_SIZE,
        Err(_) => false,
    }
}

/// Resolve the path to the Zephyr wallet-rpc binary.
///
/// Search order (2026-07-07 — app-data now comes FIRST):
///   1. `<app_data_dir>/zephyr/zephyr-wallet-rpc[.exe]` — the live copy
///      (updater-refreshed, downloaded, or manually dropped). First, so a
///      NEWER binary always beats the one frozen into the installer.
///   2. `<resource_dir>/binaries/zephyr-wallet-rpc[.exe]` — manual drop.
///   3. `<resource_dir>/binaries/zephyr-wallet-rpc.gz` — the BUNDLED payload,
///      decompressed + SHA256-verified into app-data on first use. Dormant
///      (never decompressed, never executed) for users who never open the
///      Zephyr section.
///   4. Otherwise `Err` — the caller falls back to `zph_download_wallet_rpc`.
fn resolve_rpc_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(app_data) = app.path().app_data_dir() {
        let p = app_data.join(ZPH_BINARY_DIR_NAME).join(ZPH_BINARY_NAME);
        if is_real_binary(&p) {
            return Ok(p);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("binaries").join(ZPH_BINARY_NAME);
        if is_real_binary(&p) {
            return Ok(p);
        }
    }
    // Wake the dormant bundled payload.
    if let (Ok(resource_dir), Ok(app_data)) =
        (app.path().resource_dir(), app.path().app_data_dir())
    {
        let dest = app_data.join(ZPH_BINARY_DIR_NAME);
        match crate::wallet_rpc_common::extract_bundled_sidecar(&resource_dir, &dest, "zephyr") {
            Ok(p) if is_real_binary(&p) => return Ok(p),
            Ok(_) => {}
            Err(e) => eprintln!("[zph] bundled sidecar unavailable ({}), will download", e),
        }
    }
    let archive_hint = if cfg!(target_os = "windows") {
        "extract zephyr-wallet-rpc.exe from the windows zip"
    } else {
        "extract zephyr-wallet-rpc from the linux tarball"
    };
    Err(format!(
        "{0} not found (or only a placeholder is present).\n\
         Download the Zephyr CLI bundle from \
         https://github.com/ZephyrProtocol/zephyr/releases/latest, \
         {1} (~18 MB), and place it in one of:\n  \
         - src-tauri/binaries/{0} (rebuild required)\n  \
         - <app-data>/com.pwnda.wallet/zephyr/{0} (takes effect immediately)",
        ZPH_BINARY_NAME, archive_hint
    ))
}

fn get_wallet_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let wallet_dir = app_data.join(ZPH_WALLET_DIR_NAME);
    std::fs::create_dir_all(&wallet_dir)
        .map_err(|e| format!("Failed to create wallet dir: {}", e))?;
    Ok(wallet_dir)
}

fn get_zephyr_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let dir = app_data.join(ZPH_BINARY_DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create zephyr dir: {}", e))?;
    Ok(dir)
}

fn get_pidfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_wallet_dir(app)?.join("wallet-rpc.pid"))
}

/// Per-session credentials file. See `wallet_rpc_common::read_creds_file`
/// for the rationale — graceful-stop path for the next session.
fn get_credsfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_wallet_dir(app)?.join("wallet-rpc.creds"))
}

/// PWNDA-LEASE / PWNDA-STABLE-CREDS: path to the STABLE credentials file —
/// mirrors `xmr_rpc::get_stable_credsfile` exactly, including WHY it's a
/// different file with a different lifecycle from [`get_credsfile`]'s:
/// `basicswap.json`'s `mainwalletrpcauth` (written for `chainclients.zephyr`
/// by `apply_host_zph_wallet_to_config`) is read by the engine's `run.py`
/// ONCE, at process start — there is no reload path. A wallet-rpc restart
/// while `ZphLease::SwapEngine` still needs this process must not silently
/// invalidate auth the engine's config already has, so while that lease is
/// held, credentials are read from here instead of regenerated, and only
/// cleared once [`ZphLeaseState::leases`] returns to fully empty.
fn get_stable_credsfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_wallet_dir(app)?.join("wallet-rpc.shared-creds"))
}

#[tauri::command]
pub async fn zph_wallet_dir(app: AppHandle) -> Result<String, String> {
    let dir = get_wallet_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Delete the on-disk wallet files for `filename` (the wallet + its `.keys`
/// + `.address.txt`). Same Windows file-handle retry dance as Monero.
#[tauri::command]
pub async fn zph_delete_wallet_files(app: AppHandle, filename: String) -> Result<(), String> {
    let dir = get_wallet_dir(&app)?;
    for suffix in &["", ".keys", ".address.txt"] {
        let p = dir.join(format!("{}{}", filename, suffix));
        if !p.exists() {
            continue;
        }
        let mut last_err: Option<String> = None;
        let mut removed = false;
        for _ in 0..10 {
            match std::fs::remove_file(&p) {
                Ok(()) => {
                    removed = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(format!("{}", e));
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
        if !removed {
            return Err(format!(
                "Failed to delete {:?} after 10 attempts: {}",
                p,
                last_err.unwrap_or_else(|| "unknown".into())
            ));
        }
    }
    Ok(())
}

// =========================================================================
// Internal RPC call helper (uses shared digest-auth TCP path)
// =========================================================================

async fn do_rpc_call(
    creds: Option<&(String, String)>,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    do_rpc_call_at(&zph_rpc_url(), creds, method, params, timeout).await
}

async fn zph_rpc_ping(creds: &(String, String)) -> Result<(), String> {
    do_rpc_call(
        Some(creds),
        "get_version",
        serde_json::json!({}),
        std::time::Duration::from_secs(2),
    )
    .await
    .map(|_| ())
}

// =========================================================================
// Tauri commands — sidecar lifecycle
// =========================================================================

/// Launch zephyr-wallet-rpc as a child process and wait until responsive.
///
/// Mirror of `xmr_start_rpc` — see that function's docs for the
/// stale-process cleanup rationale (pidfile → TCP probe → graceful stop →
/// taskkill → wait-for-port-free). 30-sec ready budget.
///
/// `lease` is `Option` — and defaults to [`ZphLease::Session`] when absent —
/// so the existing frontend caller (`zph-rpc.ts`'s `startZphRpc`, which
/// invokes this command with only `daemonAddress`) keeps working unchanged;
/// see `ZphLease`'s own doc comment. Only `swap_sidecar.rs`'s
/// `maybe_activate_zph_host_wallet` ever passes `Some(ZphLease::SwapEngine)`
/// explicitly, as a direct Rust call (not over the Tauri IPC bridge, so no
/// frontend change is needed for that call site either).
#[tauri::command]
pub async fn zph_start_rpc(
    app: AppHandle,
    daemon_address: String,
    lease: Option<ZphLease>,
) -> Result<(), String> {
    let lease = lease.unwrap_or(ZphLease::Session);

    // PWNDA-SINGLE-FLIGHT: mirrors `xmr_start_rpc`'s own block — see that
    // function's doc comment for the incident this closes (two callers on a
    // fresh app boot both reading "not running" before either commits, both
    // spawning a competing wallet-rpc on the same port). `decide_zph_start`
    // reading BOTH `child.is_some()` (from the `ZphRpcChild` guard, held
    // for this whole block) and `starting` (from `lease_state()`, locked
    // nested inside it — see the divergence note above `ZPH_LEASE_STATE`)
    // is what makes the decision atomic.
    {
        let state = app.state::<ZphRpcChild>();
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut ls = lease_state().lock().map_err(|e| format!("Lock error: {}", e))?;
        match decide_zph_start(guard.child.is_some(), ls.starting) {
            ZphStartDecision::AlreadyRunning => {
                ls.leases.insert(lease);
                // PWNDA-STABLE-CREDS: SwapEngine may be JOINING a process
                // Session already started with ordinary per-session random
                // creds — persist those actual creds now (mirrors
                // `xmr_start_rpc`'s identical branch) so a LATER restart
                // while SwapEngine still needs this process reuses them
                // instead of generating fresh ones the engine's
                // already-written config doesn't know about.
                if lease == ZphLease::SwapEngine {
                    if let Some((u, p)) = guard.creds.clone() {
                        let stable_path = get_stable_credsfile(&app)?;
                        if read_creds_file(&stable_path).is_none() {
                            write_creds_file(&stable_path, &u, &p);
                        }
                    }
                }
                return Ok(());
            }
            ZphStartDecision::AlreadyStarting => {
                ls.leases.insert(lease);
                return Err(
                    "a Zephyr wallet-rpc start is already in progress — this lease \
                     will attach once it is up; do not start a second process"
                        .to_string(),
                );
            }
            ZphStartDecision::ShouldSpawn => {
                ls.starting = true;
            }
        }
    }

    // Drop guard: whichever way this function exits from here on, `starting`
    // must go back to `false` — mirrors `xmr_start_rpc`'s `StartingClaim`.
    // The happy path clears it explicitly too; this is a harmless no-op
    // there and the only thing that runs on every OTHER exit path.
    struct StartingClaim;
    impl Drop for StartingClaim {
        fn drop(&mut self) {
            if let Ok(mut ls) = lease_state().lock() {
                ls.starting = false;
            }
        }
    }
    let _claim = StartingClaim;

    // Reset to the preferred port before the stale-process sweep below, so
    // orphan detection targets 18083 rather than whatever ephemeral port a
    // previous fallback session used.
    set_active_zph_port(ZPH_RPC_PORT);

    let binary = resolve_rpc_binary(&app)?;
    let wallet_dir = get_wallet_dir(&app)?;
    let log_file = wallet_dir.join("zephyr-wallet-rpc.log");
    let pidfile = get_pidfile(&app)?;
    let credsfile = get_credsfile(&app)?;

    // ===== Stale-process cleanup =====
    //
    // Graceful-first ordering — see `xmr_start_rpc` for the long version.
    // Without this, a hard kill (Ctrl+C in `tauri dev`) loses unflushed
    // scan progress and the next session reverts the wallet file to its
    // last autosave.
    let old_creds = read_creds_file(&credsfile);

    if port_is_bound(ZPH_RPC_PORT).await {
        if let Some(creds) = old_creds.as_ref() {
            let _ = do_rpc_call(
                Some(creds),
                "store",
                serde_json::json!({}),
                std::time::Duration::from_secs(10),
            )
            .await;
            let _ = do_rpc_call(
                Some(creds),
                "close_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(5),
            )
            .await;
            let _ = do_rpc_call(
                Some(creds),
                "stop_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(5),
            )
            .await;
            for _ in 0..15 {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                if !port_is_bound(ZPH_RPC_PORT).await {
                    break;
                }
            }
        }

        if port_is_bound(ZPH_RPC_PORT).await {
            let _ = do_rpc_call(
                None,
                "stop_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(2),
            )
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }

    if port_is_bound(ZPH_RPC_PORT).await {
        if let Some(old_pid) = read_pidfile(&pidfile) {
            #[cfg(target_os = "windows")]
            {
                let _ = kill_process_by_pid_and_image(old_pid, ZPH_BINARY_NAME).await;
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = old_pid;
            }
        }
    }

    // Anything still holding the preferred port is NOT ours — the graceful-stop
    // and pidfile-precise passes above already cleared our own orphans. Take a
    // different port instead of fighting for this one.
    //
    // Replaces a Windows `kill_process_by_image(ZPH_BINARY_NAME)` sweep plus a
    // netstat-and-kill fallback, both of which terminated processes we did not
    // own purely because they shared a name or a port, and a hard error on
    // Linux/macOS that dead-ended the user. None of it is needed once we can
    // simply bind elsewhere.
    if port_is_bound(ZPH_RPC_PORT).await {
        let fallback = crate::wallet_rpc_common::pick_free_port(ZPH_RPC_PORT);
        eprintln!(
            "[zph_rpc] preferred port {} is held by another process; \
             using {} for this session instead",
            ZPH_RPC_PORT, fallback
        );
        set_active_zph_port(fallback);
    }
    delete_pidfile(&pidfile);
    delete_creds_file(&credsfile);

    // Per-session random credentials (16 random bytes each = 32 hex chars) —
    // UNLESS this spawn is for `ZphLease::SwapEngine`, in which case reuse a
    // durably-persisted pair if one exists (see `get_stable_credsfile`'s doc
    // comment for why: `mainwalletrpcauth` in the engine's config is
    // write-once). Mirrors `xmr_start_rpc`'s identical `creds_for_spawn` use
    // — a plain Session-only start is byte-identical to before this existed.
    let stable_path = get_stable_credsfile(&app)?;
    let existing_stable = read_creds_file(&stable_path);
    let (username, password) =
        creds_for_spawn(lease, existing_stable.as_ref(), || (random_hex(16), random_hex(16)));
    if lease == ZphLease::SwapEngine && existing_stable.is_none() {
        write_creds_file(&stable_path, &username, &password);
    }
    let rpc_login = format!("{}:{}", username, password);

    let is_local =
        daemon_address.contains("127.0.0.1") || daemon_address.contains("localhost");

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("--rpc-bind-ip")
        .arg("127.0.0.1")
        .arg("--rpc-bind-port")
        // active, not preferred — may have fallen back above
        .arg(active_zph_port().to_string())
        .arg("--rpc-login")
        .arg(&rpc_login)
        .arg("--wallet-dir")
        .arg(&wallet_dir)
        .arg("--daemon-address")
        .arg(&daemon_address)
        .arg("--log-level")
        .arg("0")
        .arg("--non-interactive")
        .arg("--log-file")
        .arg(&log_file);

    // See xmr_rpc.rs for the `--daemon-ssl` reasoning: `--daemon-ssl enabled`
    // requires a cert-verify strategy that no one-size-fits-all value works
    // for a public-node pool. Only pin `disabled` for `http://` to skip
    // autodetect's extra round-trip; let `https://` fall through to default
    // autodetect + system cert store.
    if daemon_address.starts_with("http://") {
        cmd.arg("--daemon-ssl").arg("disabled");
    }

    // Parallel block parsing. Physical cores only — SMT hurts view-key scan.
    let concurrency = (num_cpus::get_physical() as u32).clamp(2, 16);
    cmd.arg("--max-concurrency").arg(concurrency.to_string());

    if is_local {
        cmd.arg("--trusted-daemon");
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn zephyr-wallet-rpc: {}", e))?;

    if let Some(pid) = child.id() {
        write_pidfile(&pidfile, pid);
    }

    let creds = (username, password);

    // Persist creds for next session's graceful-stop path (survives hard kills).
    write_creds_file(&credsfile, &creds.0, &creds.1);

    {
        let state = app.state::<ZphRpcChild>();
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        *guard = ZphRpcInner {
            child: Some(child),
            creds: Some(creds.clone()),
        };
        // PWNDA-LEASE: record this caller's claim now that the process is
        // actually up. `starting` was already cleared by `StartingClaim`'s
        // drop at the end of this scope-adjacent block on every OTHER exit
        // path; on this, the happy path, clear it explicitly too so the
        // ready-probe below (which can itself fail and tear the process
        // back down) never observes a stale `starting: true`.
        let mut ls = lease_state().lock().map_err(|e| format!("Lock error: {}", e))?;
        ls.leases.insert(lease);
        ls.starting = false;
    }

    // Ready probe: 30 sec budget, 250 ms poll. Each iteration also checks
    // `try_wait()` so an early child death (bind failure, daemon unreachable,
    // Defender quarantine) surfaces the log tail immediately.
    const READY_BUDGET_MS: u64 = 30_000;
    const READY_POLL_MS: u64 = 250;
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(READY_BUDGET_MS);

    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(READY_POLL_MS)).await;

        let exit_code: Option<i32> = {
            let state = app.state::<ZphRpcChild>();
            let result = match state.0.lock() {
                Ok(mut guard) => match guard.child.as_mut() {
                    Some(ch) => match ch.try_wait() {
                        Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                        _ => None,
                    },
                    None => None,
                },
                Err(_) => None,
            };
            result
        };
        if let Some(code) = exit_code {
            let tail = read_log_tail(&log_file, 3072);
            zph_stop_rpc_internal(&app).await;
            return Err(format!(
                "zephyr-wallet-rpc exited with code {} before becoming ready. \
                 Last log lines:\n{}",
                code, tail
            ));
        }

        if zph_rpc_ping(&creds).await.is_ok() {
            return Ok(());
        }
    }

    let tail = read_log_tail(&log_file, 3072);
    zph_stop_rpc_internal(&app).await;
    Err(format!(
        "zephyr-wallet-rpc failed to become ready within {}s. Last log lines:\n{}",
        READY_BUDGET_MS / 1000,
        tail
    ))
}

#[tauri::command]
pub async fn zph_rpc_call(
    state: tauri::State<'_, ZphRpcChild>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let creds = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.creds.clone()
    };

    let timeout = if method == "refresh" {
        std::time::Duration::from_secs(60 * 60)
    } else {
        std::time::Duration::from_secs(30)
    };

    do_rpc_call_at(&zph_rpc_url(), creds.as_ref(), &method, params, timeout).await
}

/// Release `lease`'s claim on the wallet-rpc process. Only actually stops
/// the child once the lease set is empty — mirrors `xmr_stop_rpc` exactly.
///
/// `lease` defaults to [`ZphLease::Session`] when absent, so the existing
/// frontend caller (`zph-rpc.ts`'s `stopZphRpc`, which invokes this command
/// with NO arguments at all) keeps working unchanged.
#[tauri::command]
pub async fn zph_stop_rpc(app: AppHandle, lease: Option<ZphLease>) -> Result<(), String> {
    let lease = lease.unwrap_or(ZphLease::Session);
    let should_stop = {
        let state = app.state::<ZphRpcChild>();
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut ls = lease_state().lock().map_err(|e| format!("Lock error: {}", e))?;
        ls.release_lease(lease, guard.child.is_some())
    };
    if should_stop {
        zph_stop_rpc_internal(&app).await;
    }
    Ok(())
}

async fn zph_stop_rpc_internal(app: &AppHandle) {
    let creds = {
        let state = app.state::<ZphRpcChild>();
        let x = match state.0.lock() {
            Ok(guard) => guard.creds.clone(),
            Err(_) => None,
        };
        x
    };

    let _ = do_rpc_call(
        creds.as_ref(),
        "close_wallet",
        serde_json::json!({}),
        std::time::Duration::from_secs(5),
    )
    .await;
    let _ = do_rpc_call(
        creds.as_ref(),
        "stop_wallet",
        serde_json::json!({}),
        std::time::Duration::from_secs(5),
    )
    .await;

    let child_opt = {
        let state = app.state::<ZphRpcChild>();
        let mut guard = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let child = guard.child.take();
        guard.creds = None;
        child
    };

    if let Some(mut child) = child_opt {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    if let Ok(pidfile) = get_pidfile(app) {
        delete_pidfile(&pidfile);
    }
    if let Ok(credsfile) = get_credsfile(app) {
        delete_creds_file(&credsfile);
    }
    // PWNDA-LEASE: this function only runs when the lease set is (or is
    // being made) empty — `zph_stop_rpc` gates the call on it, and the two
    // internal failure-path callers (early child death, ready-timeout) are
    // both "nothing to have leased yet" cases. Clear both fields so a stale
    // `starting: true` or an orphaned lease can never survive a teardown —
    // mirrors `xmr_stop_rpc_internal`'s identical reset.
    if let Ok(mut ls) = lease_state().lock() {
        ls.leases.clear();
        ls.starting = false;
    }
    // No lease still needs stable auth once we reach here — reset it so the
    // NEXT SwapEngine acquisition generates and persists a fresh pair
    // rather than reusing one for a process that no longer exists.
    if let Ok(stable_credsfile) = get_stable_credsfile(app) {
        delete_creds_file(&stable_credsfile);
    }
}

#[tauri::command]
pub async fn zph_rpc_is_running(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<ZphRpcChild>();
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(guard.child.is_some())
}

// =========================================================================
// Tauri command — node probe (bypasses webview CORS)
// =========================================================================

/// Probe `/get_info` of a Zephyr daemon via the shared Rust-side HTTP
/// probe. Zephyr's `/get_info` response is byte-compatible with
/// Monero's (it's the same core_rpc_server), so the generic
/// `probe_node` helper is unchanged between chains.
///
/// Most public Zephyr nodes (as of 2026-04-23) omit
/// `Access-Control-Allow-Origin` — a renderer `fetch()` would fail on
/// e.g. `remote-node.zephyrprotocol.com:17767`. Probing through this
/// command lets us honestly benchmark every node in the pool.
#[tauri::command]
pub async fn zph_probe_node(url: String, timeout_ms: u64) -> Result<NodeProbeResult, String> {
    Ok(probe_node(url, timeout_ms).await)
}

// =========================================================================
// Binary check (auto-download TBD — see plan)
// =========================================================================

/// Check if zephyr-wallet-rpc.exe is present and real (not a placeholder).
#[tauri::command]
pub async fn zph_check_wallet_rpc(app: AppHandle) -> Result<bool, String> {
    Ok(resolve_rpc_binary(&app).is_ok())
}

// =========================================================================
// Auto-download + Windows Defender exclusion
// =========================================================================
//
// Mirrors `xmr_download_wallet_rpc` / `xmr_{check,add}_defender_exclusion`
// with one important wrinkle: Zephyr does NOT publish a PGP-signed hashes
// file, so discovery-plus-hash-from-web (Monero's pattern) is unavailable.
// Instead we pin the release URL + ZIP SHA256 at compile time. Maintainer
// bumps the constants per Zephyr release; see
// `PwndaWalletVault/wiki/entities/Zephyr.md` for the current pinned SHAs.

/// Tag of the Zephyr release this build knows how to download.
/// Bump together with `ZPH_ZIP_SHA256` whenever Zephyr cuts a new release.
const ZPH_RELEASE_TAG: &str = "v2.3.0";

/// Exact filename in the GitHub release. URL assembly below depends on this
/// matching the asset name exactly. Platform-specific — the Linux release
/// is also a .zip (containing the bare `zephyr-wallet-rpc` binary), so the
/// existing zip-extraction path handles both.
#[cfg(target_os = "windows")]
const ZPH_ZIP_FILENAME: &str = "zephyr-cli-windows-v2.3.0.zip";
#[cfg(not(target_os = "windows"))]
const ZPH_ZIP_FILENAME: &str = "zephyr-cli-linux-v2.3.0.zip";

/// Direct download URL for the pinned ZIP. GitHub release assets are
/// immutable once published, so this URL + the pinned SHA below is a stable
/// integrity anchor.
#[cfg(target_os = "windows")]
const ZPH_ZIP_URL: &str =
    "https://github.com/ZephyrProtocol/zephyr/releases/download/v2.3.0/zephyr-cli-windows-v2.3.0.zip";
#[cfg(not(target_os = "windows"))]
const ZPH_ZIP_URL: &str =
    "https://github.com/ZephyrProtocol/zephyr/releases/download/v2.3.0/zephyr-cli-linux-v2.3.0.zip";

/// SHA256 of the pinned ZIP. Computed at install time — any deviation
/// aborts the download before the extracted binary ever touches disk.
/// Windows hash dates to 2026-04-23 (log.md entry); Linux hash computed
/// 2026-05-16 against the same upstream release.
#[cfg(target_os = "windows")]
const ZPH_ZIP_SHA256: &str =
    "1139bde911980ff6f93e8540bf1b9d0b67370f33daf15f6b78d47360947d6726";
#[cfg(not(target_os = "windows"))]
const ZPH_ZIP_SHA256: &str =
    "d60a94d187e288de0ea76d26ecba26c850cdec0500bba84699c7abe85d1a6f91";

/// Progress event payload emitted during download. The frontend subscribes
/// to `zph-download-progress` and updates the sync-card UI accordingly.
#[derive(Clone, Serialize)]
pub struct ZphDownloadProgress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

/// PowerShell command helper — hidden window, exec-policy bypass.
/// Cross-platform via `platform::apply_hidden_spawn` (no-op on Linux).
fn hidden_powershell_command() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("powershell");
    crate::platform::apply_hidden_spawn(&mut cmd);
    cmd.args(["-ExecutionPolicy", "Bypass"]);
    cmd
}

/// Download the pinned Zephyr CLI ZIP from GitHub releases, verify the
/// pinned SHA256, and extract just `zephyr-wallet-rpc.exe` into
/// `<app_data>/zephyr/`. Emits `zph-download-progress` events so the
/// frontend can render a progress bar.
///
/// Integrity model (weaker than Monero's PGP-signed hashes.txt):
///   - HTTPS + GitHub release asset immutability anchor the bytes.
///   - Pinned `ZPH_ZIP_SHA256` constant, bumped per release, catches
///     tampered/corrupted downloads before the EXE is extracted.
///   - Users running with Windows Defender real-time protection need an
///     exclusion first (`zph_add_defender_exclusion`) or the OS will
///     quarantine the EXE on extraction — same false positive every
///     Monero-lineage wallet-rpc hits.
#[tauri::command]
pub async fn zph_download_wallet_rpc(app: AppHandle) -> Result<(), String> {
    // Zephyr ships both Windows (.zip) and Linux (.zip) release assets.
    // The platform-specific URL + SHA256 are selected at compile-time via
    // `ZPH_ZIP_URL` / `ZPH_ZIP_SHA256` cfg-gates above; the rest of the
    // function is identical for both targets (zip extraction works on Linux
    // via the cross-platform `zip` crate).
    let zephyr_dir = get_zephyr_dir(&app)?;
    let exe_path = zephyr_dir.join(ZPH_BINARY_NAME);

    // Skip if already present and real.
    if is_real_binary(&exe_path) {
        crate::emit_meter::bump("zph-download-progress");
        let _ = app.emit(
            "zph-download-progress",
            ZphDownloadProgress {
                stage: "complete".to_string(),
                percent: 100.0,
                message: "zephyr-wallet-rpc.exe already present".to_string(),
            },
        );
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // 1. Kick off download. No discovery step — URL is pinned.
    crate::emit_meter::bump("zph-download-progress");
    let _ = app.emit(
        "zph-download-progress",
        ZphDownloadProgress {
            stage: "downloading".to_string(),
            percent: 0.0,
            message: format!(
                "Downloading {} from GitHub ({})…",
                ZPH_ZIP_FILENAME, ZPH_RELEASE_TAG
            ),
        },
    );

    let response = client
        .get(ZPH_ZIP_URL)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {} from {}",
            response.status(),
            ZPH_ZIP_URL
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    let zip_path = zephyr_dir.join(ZPH_ZIP_FILENAME);
    let mut file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        let percent = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };
        crate::emit_meter::bump("zph-download-progress");
        let _ = app.emit(
            "zph-download-progress",
            ZphDownloadProgress {
                stage: "downloading".to_string(),
                percent,
                message: format!(
                    "Downloading zephyr-wallet-rpc — {:.1}/{:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            },
        );
    }
    drop(file);

    // 2. Verify SHA256 before extracting. A mismatch aborts with a clear
    //    signal that the maintainer-pinned constant is stale or the ZIP
    //    was tampered with in transit.
    let actual_hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    if actual_hash != ZPH_ZIP_SHA256 {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!(
            "SHA256 mismatch for {} — expected {}, got {}. \
             Download aborted. Either the pinned constant is stale (a new \
             Zephyr release was cut and PwndaWallet hasn't been updated) \
             or the ZIP was corrupted in transit. Update \
             ZPH_ZIP_SHA256/ZPH_ZIP_URL in src-tauri/src/zph_rpc.rs to ship a fix.",
            ZPH_ZIP_FILENAME, ZPH_ZIP_SHA256, actual_hash
        ));
    }

    // 3. Extract just zephyr-wallet-rpc.exe from the ZIP.
    crate::emit_meter::bump("zph-download-progress");
    let _ = app.emit(
        "zph-download-progress",
        ZphDownloadProgress {
            stage: "extracting".to_string(),
            percent: 0.0,
            message: "Extracting zephyr-wallet-rpc.exe…".to_string(),
        },
    );

    let zip_file = std::fs::File::open(&zip_path)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|e| format!("Failed to read zip: {}", e))?;

    let mut found = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Zip entry error: {}", e))?;
        let name = entry.name().to_string();

        // Skip Apple resource forks. The Linux bundle was zipped on macOS, so
        // it carries `__MACOSX/zephyr-cli-linux-v2.3.0/._zephyr-wallet-rpc`
        // alongside the real 31 MB binary — and that 274-byte stub ALSO ends
        // with "zephyr-wallet-rpc", so the match below can't tell them apart.
        // Today the real entry happens to come first and `break` saves us, but
        // that's upstream zip ordering we don't control: reverse it and we'd
        // silently install a 274-byte file. Filter explicitly instead.
        if name.starts_with("__MACOSX/")
            || std::path::Path::new(&name)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("._"))
        {
            continue;
        }

        if name.ends_with(ZPH_BINARY_NAME) {
            let mut outfile = std::fs::File::create(&exe_path)
                .map_err(|e| format!("Failed to create exe: {}", e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Failed to extract exe: {}", e))?;
            found = true;
            break;
        }
    }

    let _ = std::fs::remove_file(&zip_path);

    if !found {
        return Err(format!(
            "{} not found inside the downloaded zip",
            ZPH_BINARY_NAME
        ));
    }

    // Marks this copy as updater-managed. The tag is a compile-time pin, so
    // what we record is exactly what this build knows how to verify — which is
    // also why Zephyr has no upstream check (see sidecar_update.rs).
    crate::sidecar_update::set_installed_version(&zephyr_dir, ZPH_RELEASE_TAG);

    // Zip entries don't carry the executable bit through `File::create`, which
    // makes a 0644 file — the sidecar spawn then fails with "Permission
    // denied". Monero's Linux downloader already does this (xmr_rpc.rs:1703);
    // Zephyr never did, so its download could only ever have produced a
    // non-executable binary on Linux/macOS. No-op on Windows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&exe_path)
            .map_err(|e| format!("Failed to stat extracted binary: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&exe_path, perms)
            .map_err(|e| format!("Failed to chmod +x the extracted binary: {}", e))?;
    }

    crate::emit_meter::bump("zph-download-progress");
    let _ = app.emit(
        "zph-download-progress",
        ZphDownloadProgress {
            stage: "complete".to_string(),
            percent: 100.0,
            message: "zephyr-wallet-rpc.exe ready".to_string(),
        },
    );
    Ok(())
}

/// Check if Windows Defender has an exclusion covering the Zephyr binary
/// dir or the `zephyr-wallet-rpc` process. Returns `true` if either
/// exclusion is present — the downloader / sidecar runtime only needs
/// one to avoid quarantine.
#[tauri::command]
pub async fn zph_check_defender_exclusion(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let zephyr_dir = get_zephyr_dir(&app)?;
        let zephyr_path = zephyr_dir.to_string_lossy().to_string();

        let ps_script = format!(
            r#"
$pref = Get-MpPreference
$targetPath = '{zephyr_path}'
$targetLower = $targetPath.ToLower().TrimEnd('\').TrimEnd('/')

$pathMatch = $false
if ($pref.ExclusionPath) {{
    foreach ($p in $pref.ExclusionPath) {{
        $pLower = $p.ToLower().TrimEnd('\').TrimEnd('/')
        if ($pLower -eq $targetLower) {{
            $pathMatch = $true
            break
        }}
    }}
}}

$procMatch = $false
if ($pref.ExclusionProcess) {{
    foreach ($p in $pref.ExclusionProcess) {{
        if ($p.ToLower() -like '*zephyr-wallet-rpc*') {{
            $procMatch = $true
            break
        }}
    }}
}}

if ($pathMatch -or $procMatch) {{ Write-Output 'true' }} else {{ Write-Output 'false' }}
"#,
            zephyr_path = zephyr_path
        );

        let mut cmd = hidden_powershell_command();
        cmd.args(["-Command", &ps_script]);

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to check Defender exclusions: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(stdout.to_lowercase().contains("true"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        // Non-Windows: no Defender, treat as "exclusion present" so the UI
        // doesn't ask the user to configure something that doesn't exist.
        Ok(true)
    }
}

/// Add Windows Defender exclusions for the Zephyr binary dir + the
/// `zephyr-wallet-rpc.exe` process. Launches an elevated PowerShell
/// (`Start-Process -Verb RunAs`) which triggers a UAC prompt — the user
/// must click Yes. Verifies the path exclusion landed on return.
#[tauri::command]
pub async fn zph_add_defender_exclusion(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let zephyr_dir = get_zephyr_dir(&app)?;
        let zephyr_path = zephyr_dir.to_string_lossy().to_string();
        let exe_path = zephyr_dir.join(ZPH_BINARY_NAME);

        let script_content = format!(
            "Add-MpPreference -ExclusionPath '{}'\nAdd-MpPreference -ExclusionProcess '{}'",
            zephyr_path,
            exe_path.to_string_lossy()
        );

        let script_path = zephyr_dir.join("_defender_setup.ps1");
        std::fs::write(&script_path, &script_content)
            .map_err(|e| format!("Failed to write defender script: {}", e))?;

        let elevate_cmd_str = format!(
            "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-ExecutionPolicy Bypass -File \"{}\"'",
            script_path.to_string_lossy()
        );
        let mut elevate_cmd = hidden_powershell_command();
        elevate_cmd.args(["-Command", &elevate_cmd_str]);
        let _output = elevate_cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run Defender exclusion script: {}", e))?;

        let _ = std::fs::remove_file(&script_path);

        // Verify the path exclusion landed. Process-only exclusions are
        // harder to verify from unelevated context (Get-MpPreference hides
        // them), so the UI should also offer a retry if this returns false.
        let mut verify_cmd = hidden_powershell_command();
        verify_cmd.args([
            "-Command",
            &format!(
                "(Get-MpPreference).ExclusionPath -contains '{}'",
                zephyr_path
            ),
        ]);
        let verify = verify_cmd
            .output()
            .await
            .map_err(|e| format!("Failed to verify Defender exclusion: {}", e))?;

        let stdout = String::from_utf8_lossy(&verify.stdout).trim().to_string();
        Ok(stdout.eq_ignore_ascii_case("true"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(true)
    }
}

// =========================================================================
// Tests — mirrored from `xmr_rpc.rs`'s test suite (Grove expansion plan,
// Phase C, unit C-RZ). Same assertions, ZEPH types. See the divergence note
// above `ZPH_LEASE_STATE` for why `release_lease`'s tests here take a plain
// `child_present: bool` rather than needing a placeholder spawned process
// the way `xmr_rpc.rs`'s `fresh_inner_with_child()` does — a simplification
// the split-state design enables, not a weaker test.
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── PWNDA-SINGLE-FLIGHT: decide_zph_start ───────────────────────────
    //
    // Mirrors `xmr_rpc::tests::decide_xmr_start_*` exactly — same incident
    // (two callers racing a spawn on a fresh app boot both reading "not
    // running" before either commits), same three-way branch.

    #[test]
    fn decide_zph_start_spawns_only_when_neither_running_nor_starting() {
        assert_eq!(
            decide_zph_start(false, false),
            ZphStartDecision::ShouldSpawn,
            "the ordinary first-caller case must still spawn"
        );
    }

    #[test]
    fn decide_zph_start_attaches_rather_than_spawns_when_already_running() {
        assert_eq!(decide_zph_start(true, false), ZphStartDecision::AlreadyRunning);
        // Running always wins even if `starting` was somehow also left set.
        assert_eq!(decide_zph_start(true, true), ZphStartDecision::AlreadyRunning);
    }

    #[test]
    fn decide_zph_start_backs_off_instead_of_racing_a_second_spawn() {
        // THE regression this whole fix exists for: a second caller arriving
        // while the first is still mid-spawn (no child yet, but claimed)
        // must NOT get `ShouldSpawn`.
        assert_eq!(
            decide_zph_start(false, true),
            ZphStartDecision::AlreadyStarting,
            "a caller arriving while another is mid-spawn must back off, not race it"
        );
    }

    // ── PWNDA-LEASE: ZphLeaseState::release_lease ───────────────────────

    #[test]
    fn release_lease_does_not_stop_while_another_lease_remains() {
        let mut ls = ZphLeaseState::default();
        ls.leases.insert(ZphLease::Session);
        ls.leases.insert(ZphLease::SwapEngine);

        assert!(
            !ls.release_lease(ZphLease::Session, true),
            "SwapEngine still holds it — releasing Session must not stop the process"
        );
        assert!(
            ls.leases.contains(&ZphLease::SwapEngine),
            "the remaining lease must survive the release call"
        );
        assert!(
            !ls.leases.contains(&ZphLease::Session),
            "the released lease must actually be removed"
        );
    }

    #[test]
    fn release_lease_stops_once_the_last_lease_is_released() {
        let mut ls = ZphLeaseState::default();
        ls.leases.insert(ZphLease::SwapEngine);

        assert!(
            ls.release_lease(ZphLease::SwapEngine, true),
            "the last remaining lease must trigger a stop"
        );
        assert!(ls.leases.is_empty());
    }

    #[test]
    fn release_lease_is_a_noop_when_nothing_was_running() {
        // Nothing to have raced with — a stray stop call must not report
        // "stop" and go re-run teardown against a process that was never
        // there.
        let mut ls = ZphLeaseState::default();
        ls.leases.insert(ZphLease::Session);
        assert!(!ls.release_lease(ZphLease::Session, false));
    }

    #[test]
    fn release_lease_of_an_unheld_lease_is_harmless() {
        // Releasing a lease this caller never held (e.g. a double-release,
        // or SwapEngine releasing before it ever acquired) must not stop a
        // process a DIFFERENT lease is still relying on.
        let mut ls = ZphLeaseState::default();
        ls.leases.insert(ZphLease::Session);
        assert!(!ls.release_lease(ZphLease::SwapEngine, true));
        assert!(
            ls.leases.contains(&ZphLease::Session),
            "an unrelated release must not disturb a lease it doesn't name"
        );
    }

    // ── PWNDA-STABLE-CREDS: creds_for_spawn ─────────────────────────────

    #[test]
    fn creds_for_spawn_session_always_uses_fresh() {
        let stable = ("stable_u".to_string(), "stable_p".to_string());
        let mut fresh_called = false;
        let (u, p) = creds_for_spawn(ZphLease::Session, Some(&stable), || {
            fresh_called = true;
            ("fresh_u".to_string(), "fresh_p".to_string())
        });
        assert!(fresh_called, "Session must not skip generating fresh creds");
        assert_eq!((u.as_str(), p.as_str()), ("fresh_u", "fresh_p"));
    }

    #[test]
    fn creds_for_spawn_swap_engine_reuses_existing_stable_creds() {
        let stable = ("stable_u".to_string(), "stable_p".to_string());
        let (u, p) = creds_for_spawn(ZphLease::SwapEngine, Some(&stable), || {
            panic!("must not generate fresh creds when a stable pair already exists")
        });
        assert_eq!((u.as_str(), p.as_str()), ("stable_u", "stable_p"));
    }

    #[test]
    fn creds_for_spawn_swap_engine_generates_fresh_when_no_stable_pair_exists() {
        let (u, p) = creds_for_spawn(ZphLease::SwapEngine, None, || {
            ("fresh_u".to_string(), "fresh_p".to_string())
        });
        assert_eq!((u.as_str(), p.as_str()), ("fresh_u", "fresh_p"));
    }

    // ── Live tests: real zephyr-wallet-rpc binary ───────────────────────
    //
    // Mirrors `xmr_rpc::tests::rpc_live_*` — real Digest-auth round trip
    // against the real binary, `#[ignore]`d by default (CI/most sandboxes
    // don't have the binary or network access) but runnable for real when
    // both are present.

    /// A real Zephyr node from `zph-nodes-default.ts`'s baked-in pool HEAD
    /// (`remote-node.zephyrprotocol.com` — "zephyrprotocol (official)") —
    /// reused here rather than invented, same reasoning as
    /// `xmr_rpc.rs::tests::probe_daemon_tip`'s public-node use.
    const ZPH_TEST_DAEMON: &str = "http://remote-node.zephyrprotocol.com:17767";

    /// Locate a real zephyr-wallet-rpc binary for the live tests. Checks, in
    /// order: (1) `src-tauri/binaries/` — mirrors `xmr_rpc.rs`'s own
    /// `test_binary_path` convention (drop a real copy there and rebuild);
    /// (2) the repo's `.cache/sidecars-fetch/` — where Grove expansion plan
    /// Phase A unit A2 already seeded a real, hash-verified copy, so this
    /// live test can run for real in this environment without anyone
    /// dropping a binary into (1) by hand.
    fn test_binary_path() -> Option<PathBuf> {
        let primary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(ZPH_BINARY_NAME);
        if is_real_binary(&primary) {
            return Some(primary);
        }
        #[cfg(target_os = "windows")]
        {
            let cached = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()?
                .join(".cache")
                .join("sidecars-fetch")
                .join("win32")
                .join("zephyr-wallet-rpc-x")
                .join(ZPH_BINARY_NAME);
            if is_real_binary(&cached) {
                return Some(cached);
            }
        }
        None
    }

    /// Spawn zephyr-wallet-rpc on `port` with `creds`, pointed at
    /// [`ZPH_TEST_DAEMON`], and block until it accepts HTTP connections
    /// (not necessarily the Digest handshake itself — mirrors
    /// `xmr_rpc.rs::tests::spawn_wallet_rpc`).
    async fn spawn_wallet_rpc(
        binary: &PathBuf,
        port: u16,
        wallet_dir: &PathBuf,
        creds: &(String, String),
    ) -> tokio::process::Child {
        let log_path = wallet_dir.join("zephyr-wallet-rpc-test.log");
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("--rpc-bind-ip")
            .arg("127.0.0.1")
            .arg("--rpc-bind-port")
            .arg(port.to_string())
            .arg("--rpc-login")
            .arg(format!("{}:{}", creds.0, creds.1))
            .arg("--wallet-dir")
            .arg(wallet_dir)
            .arg("--daemon-address")
            .arg(ZPH_TEST_DAEMON)
            .arg("--non-interactive")
            .arg("--log-level")
            .arg("1")
            .arg("--log-file")
            .arg(&log_path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.kill_on_drop(true);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        cmd.stdin(std::process::Stdio::null());

        let child = cmd.spawn().expect("spawn zephyr-wallet-rpc");

        for _ in 0..80 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                return child;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        panic!("zephyr-wallet-rpc did not open port {} within 20s", port);
    }

    /// Full end-to-end: spawn zephyr-wallet-rpc with random credentials,
    /// make a `get_version` call through the same `do_rpc_call_at` path the
    /// app uses, and verify a numeric version comes back. Regression guard
    /// for the same class of Digest-auth wiring bug `xmr_rpc.rs`'s own
    /// `rpc_live_get_version_with_digest_auth` guards.
    #[tokio::test]
    #[ignore = "live; spawns zephyr-wallet-rpc + uses a public daemon"]
    async fn zph_rpc_live_get_version_with_digest_auth() {
        let binary = match test_binary_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "SKIP: no real zephyr-wallet-rpc[.exe] found at src-tauri/binaries/ \
                     or the repo's .cache/sidecars-fetch/. Run \
                     `Get-SwapCoinBinaries.ps1 -Coins zephyr` and re-run."
                );
                return;
            }
        };

        let tmp = std::env::temp_dir().join(format!("pwnda-zph-test-{}", random_hex(4)));
        std::fs::create_dir_all(&tmp).unwrap();

        let port: u16 = 28183;
        let creds = (random_hex(8), random_hex(8));
        let url = format!("http://127.0.0.1:{}/json_rpc", port);

        let mut child = spawn_wallet_rpc(&binary, port, &tmp, &creds).await;

        let result = do_rpc_call_at(
            &url,
            Some(&creds),
            "get_version",
            serde_json::json!({}),
            std::time::Duration::from_secs(5),
        )
        .await;

        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(&tmp);

        let value = result.expect("get_version with Digest auth should succeed");
        let version = value
            .get("version")
            .and_then(|v| v.as_u64())
            .expect("version field missing from response");
        assert!(version > 0, "version looked empty: {}", value);
    }

    /// GATE (Grove expansion plan, Phase C, unit C-RZ): "a headless start
    /// against the dev sandbox proves the engine confirms the host ZEPH
    /// wallet address before treating it as usable." This is the RPC leg
    /// `maybe_activate_zph_host_wallet` (`swap_sidecar.rs`) and
    /// `apply_host_zph_wallet_to_config`'s `mainwalletrpc*` write both
    /// depend on being real: a genuine zephyr-wallet-rpc process, real
    /// Digest auth, a real wallet, and a real confirmed `get_address` —
    /// mirrors how `xmr_rpc.rs::tests::rpc_live_polyseed_full_flow`'s own
    /// step 2 (`get_address` must match the wallet just opened) is XMR's
    /// verification of the identical property today. Deliberately does NOT
    /// boot the BasicSwap engine itself (`.swap-sidecar-work/runtime` and
    /// `dev-home` are out of scope for this unit and off-limits per
    /// the contributor guide's swap-desk autonomy boundary) — the engine-level
    /// confirmation (`_confirmMainWalletIdentity`-equivalent behaviour
    /// against a patched runtime) is Phase D unit D-Z2's
    /// `verify-zeph-host-wallet.py`, not this one.
    #[tokio::test]
    #[ignore = "live; spawns zephyr-wallet-rpc + uses a public daemon"]
    async fn zph_rpc_live_confirms_host_wallet_address() {
        let binary = match test_binary_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "SKIP: no real zephyr-wallet-rpc[.exe] found at src-tauri/binaries/ \
                     or the repo's .cache/sidecars-fetch/."
                );
                return;
            }
        };

        let tmp = std::env::temp_dir().join(format!("pwnda-zph-addr-{}", random_hex(4)));
        std::fs::create_dir_all(&tmp).unwrap();

        let port: u16 = 28184;
        let creds = (random_hex(8), random_hex(8));
        let url = format!("http://127.0.0.1:{}/json_rpc", port);

        let mut child = spawn_wallet_rpc(&binary, port, &tmp, &creds).await;

        // A fresh wallet — the same "does the process actually hold a real,
        // usable wallet" question `apply_host_zph_wallet_to_config` relies
        // on the answer to before it ever writes `mainwalletrpc*` for
        // `chainclients.zephyr`. 60s: `create_wallet` against a real remote
        // daemon can synchronously block on the wallet's initial daemon
        // handshake before responding — observed live to take longer than a
        // 30s budget once, hence the wider window here (production code's
        // own `zph_rpc_call` gives `refresh` a full hour for the same class
        // of daemon-bound wait).
        let create = do_rpc_call_at(
            &url,
            Some(&creds),
            "create_wallet",
            serde_json::json!({ "filename": "gate-test", "language": "English" }),
            std::time::Duration::from_secs(60),
        )
        .await;

        // Poll rather than a single call: right after `create_wallet`
        // returns, the process can still be finishing housekeeping against
        // the remote daemon and momentarily fail to answer — retry for up
        // to a minute so a slow-but-working daemon round-trip isn't
        // mistaken for a broken RPC path.
        let mut addr = Err("not attempted".to_string());
        for _ in 0..12 {
            addr = do_rpc_call_at(
                &url,
                Some(&creds),
                "get_address",
                serde_json::json!({ "account_index": 0 }),
                std::time::Duration::from_secs(10),
            )
            .await;
            if addr.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }

        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(&tmp);

        create.expect("create_wallet should succeed against the real binary");
        let addr_val = addr.expect("get_address should succeed against the real binary");
        let address = addr_val
            .get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(
            address.len() > 80,
            "get_address returned an implausible ZEPH address: {:?}",
            addr_val
        );
    }
}
