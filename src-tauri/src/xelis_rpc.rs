//! XELIS `xelis_wallet` sidecar manager.
//!
//! Fourth Pattern-A sidecar (`xmr_rpc.rs` :18082, `zph_rpc.rs` :18083,
//! `zano_rpc.rs` :18084 + :18086, this one :18087). Templated on `zano_rpc.rs`,
//! but XELIS is neither a Monero fork nor a CryptoNote implementation, and five
//! things follow from that. Every one of them was measured against the real
//! v1.25.0 binary during the P0 spike; see
//! `PwndaWalletVault/wiki/queries/2026-09-15-xelis-wallet-binary-spike.md`.
//!
//! 1. **Launch is `--config-file` ONLY.** Upstream's `main.rs` does
//!    `config = serde_json::from_reader(file)` — the file REPLACES the whole CLI
//!    config, so a flag passed alongside it is silently ignored (verified: an
//!    extra `--rpc-bind-address` had no effect). That is not a limitation here,
//!    it is the feature we want: the wallet password and the RPC credentials
//!    never appear on the process command line, where any local process can read
//!    them out of the process list. The file is deleted as soon as RPC answers.
//!
//! 2. **A missing password hangs forever, silently.** With
//!    `disable_interactive_mode` there is no prompt reader, and the password is
//!    read before anything is logged: 10 s, zero bytes of output, zero CPU.
//!    So this module never spawns without one — see [`build_wallet_config`].
//!
//! 3. **Auth is HTTP Basic, and it is mandatory even "without authentication".**
//!    A request with no `Authorization` header gets 401 with an EMPTY body, and
//!    so does a wrong one. Credentials are minted per start and held in Rust.
//!
//! 4. **Neither the exit code nor liveness proves the RPC server came up.** A
//!    failed bind leaves the process running happily with no server
//!    (`Error while enabling RPC Server: ... (os error 10048)`), and an RPC
//!    MISCONFIGURATION exits with code **0**. Readiness is therefore an
//!    authenticated `get_version` and nothing else, with the log scanned for the
//!    bind error so a port collision retries on another port instead of burning
//!    the whole readiness budget.
//!
//! 5. **One process per wallet directory, and a restore needs a FRESH one.**
//!    Storage is sled, whose lock is an OS byte-range lock on `<dir>/db` with no
//!    lock file. Worse, if the directory already holds a `db`, `seed` is
//!    **silently ignored** and the existing wallet opens — the same class of
//!    fault as Zano's "second wallet opened the first wallet's file". Hence
//!    per-wallet directories from day one, and a restore that deletes first.
//!
//! Shutdown is a real CTRL+C delivered through a borrowed console, because
//! XELIS has no RPC shutdown method and `exit` only exists in interactive mode.
//! See [`graceful_ctrl_c`].
//!
//! # Light client only
//!
//! PwndaWallet runs XELIS as a light wallet, and nothing else. It ships and
//! runs `xelis_wallet` alone. The release archive also carries
//! `xelis_daemon` (a full node, 67 MB, which downloads and stores the chain)
//! and `xelis_miner`; neither is ever extracted, bundled or started (see
//! [`extract_wallet_binary`] and `scripts/lib/sidecar-payloads.mjs`). An
//! online wallet always talks to a node picked from the node list, checked by
//! [`light_client_daemon`]. The only offline run is wallet creation, which
//! needs no network. Resource use is kept at the floor too:
//! [`XELIS_PRECOMPUTED_TABLES_L1`] and [`XELIS_MINIMAL_THREADS`].
//! Operator requirement, 2026-09-16.

use futures_util::StreamExt;
use sha2::{Digest as _, Sha256};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use crate::platform::{kill_pid_force, pid_image_name};
#[cfg(target_os = "windows")]
use crate::platform::find_pid_holding_port;
use crate::wallet_rpc_common::{
    delete_pidfile, pick_free_port, port_is_bound, random_hex, read_log_tail, read_pidfile,
    wait_for_port_free, write_pidfile,
};

#[cfg(target_os = "windows")]
use crate::wallet_rpc_common::CREATE_NO_WINDOW;

// =========================================================================
// Constants
// =========================================================================

/// Preferred loopback port for the wallet's JSON-RPC server.
///
/// Deliberately clear of the neighbours: 18082 (XMR), 18083 (ZEPH), 18084
/// (ZANO Main), 18086 (ZANO Scratch). Also clear of **8080**, which is both
/// XELIS's own built-in default daemon address and, on the spike machine, held
/// by an unrelated `AgentService` — which is why this module always passes a
/// daemon address explicitly and never relies on the upstream default.
///
/// Not a hard requirement: [`pick_free_port`] falls back to an ephemeral port,
/// and a bind failure retries on another one.
pub const XELIS_RPC_PORT_PREFERRED: u16 = 18087;

#[cfg(target_os = "windows")]
const XELIS_BINARY_NAME: &str = "xelis_wallet.exe";
#[cfg(not(target_os = "windows"))]
const XELIS_BINARY_NAME: &str = "xelis_wallet";

/// The real binary is ~30 MB. Guards against a truncated download or a
/// placeholder being mistaken for it.
const REAL_BINARY_MIN_SIZE: u64 = 5 * 1024 * 1024;

const XELIS_WALLET_DIR_NAME: &str = "xelis-wallets";
const XELIS_BINARY_DIR_NAME: &str = "xelis";
/// Shared by every Xelis wallet and every process: the tables are a pure
/// function of L1, contain nothing wallet-specific, and are read-only at run
/// time.
const XELIS_TABLES_DIR_NAME: &str = "xelis-tables";

/// Fallback directory name, used only when a caller passes none. Every wallet
/// the vault creates carries its own `sidecarFile` (`pwnda-xelis-<entry id>`),
/// so in practice this is never the path taken — it exists so a missing name is
/// a predictable directory rather than a panic.
const XELIS_DEFAULT_WALLET_DIR: &str = "pwnda-xelis-default";

/// **Precomputed ECDLP table size. The one number to change if decoding is slow.**
///
/// A XELIS balance is a twisted-ElGamal ciphertext; reading it means solving a
/// discrete log by BSGS against a precomputed table. L1 sets the table size, and
/// it trades RAM and a one-off generation cost against decode TIME. There is NO
/// precision loss at any L1 — decoding is exact either way, only slower.
///
/// Measured on the spike machine (32 logical CPUs), one decryption thread:
///
/// | L1 | file | generate | idle RSS | decode 1 XEL | decode 100k XEL |
/// |----|------|----------|----------|--------------|-----------------|
/// | 3 (the true minimum) | 16 KB | 3.5 ms | 35.7 MB | **4.7 s** | (hours) |
/// | 13 | 59 KB | 58 ms | 36.2 MB | 37 ms | (>45 s) |
/// | 18 | 1.4 MB | 133 ms | 37.4 MB | 22 ms | 16.2 s |
/// | **20 (this)** | **5.5 MB** | **0.33 s** | **41.3 MB** | **31 ms** | **2.9 s** |
/// | 22 | 21.8 MB | 1.24 s | 56.9 MB | 40 ms | 0.70 s |
/// | 26 (upstream default) | ~349 MB | — | — | — | — |
///
/// The operator asked for the smallest resource usage, and the smallest value
/// the binary ACCEPTS is 3 (1 and 2 panic: "Cuckoo hashmap insert needs
/// rehashing"). But L1=3 takes **4.7 seconds to decode 1 XEL** and 48 seconds
/// for 10 XEL, and the wallet decodes every changed balance AND every incoming
/// and outgoing amount during sync — so a handful of transactions at L1=3 is a
/// wallet that appears hung. 20 is the smallest value that keeps a realistic
/// balance under about 3 seconds while costing ~5 MB of disk and ~5 MB of RAM
/// over the floor.
///
/// Changing it is genuinely one line: the file is named
/// `precomputed_tables_<L1>.bin`, so a new value simply generates a new file on
/// the next start and leaves the old one to be deleted by hand.
const XELIS_PRECOMPUTED_TABLES_L1: usize = 20;

/// Threads for decryption, RPC serving, event notification and network
/// concurrency. All set to 1, which is the configuration every timing in
/// [`XELIS_PRECOMPUTED_TABLES_L1`] was measured under.
///
/// The saving is real but modest: 47 OS threads instead of 78, and ~36 MB
/// private instead of ~40 MB. It does NOT reduce the ~136 MB peak at open — that
/// is Argon2id's 128 MiB, fixed into the wallet at creation and not tunable by
/// any flag.
const XELIS_MINIMAL_THREADS: u32 = 1;

/// Stage A creates or restores a wallet: Argon2id (~1 s) plus, on the very
/// first run ever, generating the precomputed tables. Generous on purpose.
const STAGE_A_TIMEOUT_MS: u64 = 180_000;

/// Stage B readiness. Larger than the Monero-family sidecars' 30 s because a
/// cold start can include table generation and a first-run Defender scan of a
/// freshly downloaded 30 MB binary.
const READY_BUDGET_MS: u64 = 60_000;
const READY_POLL_MS: u64 = 250;

/// How many ports to try before giving up. A bind failure does not stop the
/// process, so each attempt costs a spawn and a kill.
const PORT_ATTEMPTS: usize = 3;

// =========================================================================
// Binary download — pinned release
// =========================================================================
//
// GitHub-hosted, unlike Zano's own build server, so both platforms can be
// fetched. Pins MUST stay in sync with `scripts/fetch-sidecars.mjs`.

const XELIS_RELEASE_TAG: &str = "v1.25.0";
const XELIS_RELEASE_BASE: &str =
    "https://github.com/xelis-project/xelis-blockchain/releases/download/v1.25.0";

#[cfg(target_os = "windows")]
const XELIS_ARCHIVE_NAME: &str = "x86_64-pc-windows-msvc.zip";
#[cfg(target_os = "windows")]
const XELIS_ARCHIVE_SHA256: &str =
    "c1c3494793bc492da84d6c1b82bda4bf225bc9e71198e91e5bd70fd1bcc26127";

#[cfg(not(target_os = "windows"))]
const XELIS_ARCHIVE_NAME: &str = "x86_64-unknown-linux-gnu.tar.gz";
#[cfg(not(target_os = "windows"))]
const XELIS_ARCHIVE_SHA256: &str =
    "424ac65de320a835b4cbe2c2a8b9140b12e8bab86cf5ebda89ffee024947135e";

#[derive(Clone, serde::Serialize)]
pub struct XelisDownloadProgress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

// =========================================================================
// Per-session state
// =========================================================================

pub struct XelisRpcInner {
    pub child: Option<tokio::process::Child>,
    /// Port the running child actually bound, which is not necessarily
    /// [`XELIS_RPC_PORT_PREFERRED`] — a collision retries elsewhere.
    pub port: Option<u16>,
    /// Per-start HTTP Basic credentials. Held here and mirrored beside the
    /// pidfile ONLY so a crash-recovery reattach can still authenticate. They
    /// never cross the invoke boundary into the webview.
    pub creds: Option<(String, String)>,
    /// The wallet directory the running child was started with. A start for a
    /// different directory restarts, rather than leaving the previous wallet
    /// answering for the new session.
    pub wallet_dir: Option<PathBuf>,
}

impl Default for XelisRpcInner {
    fn default() -> Self {
        Self { child: None, port: None, creds: None, wallet_dir: None }
    }
}

pub struct XelisRpcChild(pub Mutex<XelisRpcInner>);

impl Default for XelisRpcChild {
    fn default() -> Self {
        Self(Mutex::new(XelisRpcInner::default()))
    }
}

// =========================================================================
// Pure helpers (unit-tested below)
// =========================================================================

/// Normalise a network name. Anything unrecognised is mainnet, because the only
/// alternative is guessing testnet for a user whose funds are on mainnet.
pub fn normalize_network(network: Option<&str>) -> &'static str {
    match network {
        Some(n) if n.eq_ignore_ascii_case("testnet") => "testnet",
        _ => "mainnet",
    }
}

/// The base URL the wallet wants for `daemon_address`.
///
/// `network_handler.rs` builds its own URL as `format!("{}/json_rpc", addr)`
/// after `sanitize_ws_address`, so passing a full `…/json_rpc` produces
/// `…/json_rpc/json_rpc` and fails with a 404 — verified live:
/// `Error while connecting to the server 'wss://testnet-node.xelis.io/json_rpc/json_rpc': Http(Response { status: 404 …`
///
/// So this strips a trailing `/json_rpc` and any trailing slash, and nothing
/// else: the scheme is left alone because upstream maps `https:`→`wss:` and
/// `http:`→`ws:` itself.
pub fn daemon_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let stripped = trimmed.strip_suffix("/json_rpc").unwrap_or(trimmed);
    stripped.trim_end_matches('/').to_string()
}

/// The daemon an ONLINE wallet connects to, or why there is none.
///
/// Light-client-only means an online start always names a node. An empty
/// address would reach [`build_wallet_config`] as an online config pointing at
/// nothing; the wallet would start, never sync, and look like a slow node.
/// A user's own node (loopback included) is allowed: the wallet is still a
/// light client of it.
pub fn light_client_daemon(daemon_address: &str) -> Result<String, String> {
    let base = daemon_base_url(daemon_address);
    let lower = base.to_ascii_lowercase();
    let has_scheme = ["http://", "https://", "ws://", "wss://"]
        .iter()
        .any(|p| lower.starts_with(p) && lower.len() > p.len());
    if !has_scheme {
        return Err(format!(
            "No usable Xelis node address ({:?}). The wallet runs as a light client and \
             needs a node from Settings ▸ Xelis Nodes.",
            daemon_address
        ));
    }
    Ok(base)
}

/// `--precomputed-tables-path` MUST end with a separator, or the binary refuses
/// to start: `Error: Path for precomputed tables must ends with / or \` (sic).
pub fn tables_path_with_separator(dir: &Path) -> String {
    let mut s = dir.to_string_lossy().to_string();
    if !s.ends_with('/') && !s.ends_with('\\') {
        s.push(std::path::MAIN_SEPARATOR);
    }
    s
}

/// An HTTP Basic `Authorization` value. Built by hand rather than with
/// reqwest's `.basic_auth()` so the exact bytes are pinned by a unit test —
/// Zano shipped a base64 ALPHABET bug that passed on a lucky payload and failed
/// on others, and looked like flakiness for a week.
pub fn basic_auth_header(user: &str, password: &str) -> String {
    use base64::Engine;
    let raw = format!("{}:{}", user, password);
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
    )
}

/// Turn a captured startup log into a sentence a user can act on.
///
/// Every pattern below is a VERBATIM string observed from the real binary. The
/// order matters: the password and lock failures are terminal, while the bind
/// failure is recoverable by retrying on another port, so callers check
/// [`log_says_rpc_bind_failed`] first.
pub fn classify_xelis_failure(log: &str) -> Option<String> {
    if log.contains("Invalid password provided for this wallet") {
        return Some(
            "The Xelis wallet file could not be decrypted with this password. If you changed \
             your vault password, re-import the wallet from its seed."
                .to_string(),
        );
    }
    if log.contains("could not acquire lock on") {
        return Some(
            "Another process already has this Xelis wallet open. Close any other PwndaWallet \
             window or stray xelis_wallet process, then try again."
                .to_string(),
        );
    }
    if log.contains("failed to fill whole buffer") {
        return Some(
            "The Xelis precomputed tables file is truncated, most likely from an interrupted \
             first run. It will be deleted and regenerated automatically; try again."
                .to_string(),
        );
    }
    if log.contains("Path for precomputed tables must ends with") {
        return Some(
            "Internal error: the Xelis precomputed-tables path was not written with a trailing \
             separator."
                .to_string(),
        );
    }
    if log.contains("Invalid key from bytes") || log.contains("Invalid checksum") {
        return Some("The Xelis seed was rejected by the wallet binary.".to_string());
    }
    if log.contains("usernamd AND password must be provided")
        || log.contains("RPC Server is not enabled")
    {
        return Some(
            "Internal error: the Xelis RPC server was configured with incomplete credentials."
                .to_string(),
        );
    }
    None
}

/// Did the RPC server fail to BIND? Recoverable: retry on another port.
///
/// This is the case that makes exit codes useless here — the process keeps
/// running, perfectly healthy, with no server at all.
pub fn log_says_rpc_bind_failed(log: &str) -> bool {
    log.contains("Error while enabling RPC Server")
}

/// Is the precomputed-tables file corrupt (so it should be deleted)?
pub fn log_says_tables_corrupt(log: &str) -> bool {
    log.contains("failed to fill whole buffer")
}

/// Is a node stalled, given its top block's timestamp?
///
/// Topoheight alone LIES. The public testnet answered `get_info` and
/// `p2p_status` normally, reporting a plausible topoheight and 2 peers, while
/// its top block was **803 minutes old**. Any two probes of that node agree with
/// each other perfectly and are both wrong about it being usable.
///
/// 15 minutes against a 5-second target block time is 180 missed blocks — far
/// outside normal jitter, and comfortably clear of a brief network hiccup.
/// Returns the reason, or `None` when the node is fresh.
pub fn stalled_reason(top_block_ms: u64, now_ms: u64) -> Option<String> {
    const STALE_AFTER_MS: u64 = 15 * 60 * 1000;
    // A timestamp in the future is a clock disagreement, not staleness.
    let age = now_ms.saturating_sub(top_block_ms);
    if age > STALE_AFTER_MS {
        Some(format!("node is stalled (top block {} minutes old)", age / 60_000))
    } else {
        None
    }
}

/// Must a start restart the running child? Only when it serves a different
/// wallet directory. Pure.
pub fn start_needs_restart(running: Option<&Path>, requested: &Path) -> bool {
    matches!(running, Some(r) if r != requested)
}

/// The JSON config the binary is launched with.
///
/// Built from the template the binary itself emits (`--generate-config-template`),
/// because several fields have no serde default — `rpc.threads` and
/// `network_handler.offline_mode` among them — so a partial config is refused.
///
/// `password` is never optional: see this module's header for what a missing one
/// does.
#[allow(clippy::too_many_arguments)]
pub fn build_wallet_config(
    wallet_dir: &Path,
    password: &str,
    seed: Option<&str>,
    rpc_bind: Option<(u16, &str, &str)>,
    daemon_address: Option<&str>,
    tables_dir: &Path,
    network: &str,
) -> serde_json::Value {
    let (bind_address, username, rpc_password) = match rpc_bind {
        Some((port, user, pass)) => (
            serde_json::Value::String(format!("127.0.0.1:{}", port)),
            serde_json::Value::String(user.to_string()),
            serde_json::Value::String(pass.to_string()),
        ),
        None => (
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        ),
    };

    let offline = daemon_address.is_none();

    serde_json::json!({
        "rpc": {
            "bind_address": bind_address,
            "username": username,
            "password": rpc_password,
            "threads": XELIS_MINIMAL_THREADS,
            "notify_events_concurrency": XELIS_MINIMAL_THREADS,
        },
        "network_handler": {
            // Kept even when offline: the field has no serde default, and
            // upstream's own template ships this value.
            "daemon_address": daemon_address.map(daemon_base_url)
                .unwrap_or_else(|| "http://127.0.0.1:8080".to_string()),
            "offline_mode": offline,
        },
        "precomputed_tables": {
            "precomputed_tables_l1": XELIS_PRECOMPUTED_TABLES_L1,
            "precomputed_tables_path": tables_path_with_separator(tables_dir),
        },
        "log": {
            "log_level": "info",
            "file_log_level": null,
            // We capture stdout/stderr ourselves, so the binary's own file
            // logging would only be a second copy — and its date-based rotation
            // would scatter it across files the error classifier cannot find.
            "disable_file_logging": true,
            "disable_file_log_date_based": false,
            "auto_compress_logs": false,
            "disable_log_color": true,
            // Non-negotiable: with a console reader active the process waits on
            // stdin that a sidecar never provides.
            "disable_interactive_mode": true,
            "filename_log": "xelis-wallet.log",
            "logs_path": "logs/",
            "logs_modules": [],
            "disable_ascii_art": true,
            "datetime_format": "[%Y-%m-%d] (%H:%M:%S%.3f)",
        },
        "wallet_path": wallet_dir.to_string_lossy(),
        "password": password,
        "seed": seed,
        "n_decryption_threads": XELIS_MINIMAL_THREADS,
        "network_concurrency": XELIS_MINIMAL_THREADS,
        "network": network,
        "enable_xswd": false,
        "history_scan_mode": "all",
        "force_stable_balance": false,
    })
}

// =========================================================================
// Paths
// =========================================================================

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))
}

fn get_wallet_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(XELIS_WALLET_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

/// Resolve the per-wallet DIRECTORY (XELIS's `wallet_path` is a directory, not
/// a file).
///
/// A traversal-safe basename is enforced here rather than at the call site:
/// this value crosses the invoke boundary, and `..` or a separator in it would
/// let a caller place a wallet outside the wallet root.
fn get_wallet_dir(app: &AppHandle, name: Option<&str>) -> Result<PathBuf, String> {
    let dir = match name {
        Some(n) => {
            let n = n.trim();
            if n.is_empty()
                || n.contains('/')
                || n.contains('\\')
                || n.contains("..")
                || n.contains(':')
            {
                return Err(format!("Invalid Xelis wallet directory name: {:?}", n));
            }
            n.to_string()
        }
        None => XELIS_DEFAULT_WALLET_DIR.to_string(),
    };
    Ok(get_wallet_root(app)?.join(dir))
}

fn get_xelis_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(XELIS_BINARY_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

fn get_tables_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(XELIS_TABLES_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

fn tables_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_tables_dir(app)?.join(format!(
        "precomputed_tables_{}.bin",
        XELIS_PRECOMPUTED_TABLES_L1
    )))
}

fn get_pidfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_xelis_dir(app)?.join("xelis-rpc.pid"))
}

/// Port + credentials of the running child, for crash recovery only.
fn get_credsfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_xelis_dir(app)?.join("xelis-rpc.creds"))
}

fn get_log_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_xelis_dir(app)?.join("xelis-rpc.log"))
}

/// Where the launch config is written. Deleted once RPC answers.
fn get_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_xelis_dir(app)?.join("xelis-launch.json"))
}

fn is_real_binary(p: &PathBuf) -> bool {
    std::fs::metadata(p)
        .map(|m| m.len() >= REAL_BINARY_MIN_SIZE)
        .unwrap_or(false)
}

/// Resolve `xelis_wallet[.exe]`, mirroring the tiers the other sidecars use.
fn resolve_rpc_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let p = get_xelis_dir(app)?.join(XELIS_BINARY_NAME);
    if is_real_binary(&p) {
        return Ok(p);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let rp = resource_dir.join("binaries").join(XELIS_BINARY_NAME);
        if is_real_binary(&rp) {
            return Ok(rp);
        }
    }
    if let (Ok(resource_dir), Ok(dest)) = (app.path().resource_dir(), get_xelis_dir(app)) {
        match crate::wallet_rpc_common::extract_bundled_sidecar(&resource_dir, &dest, "xelis") {
            Ok(pp) if is_real_binary(&pp) => return Ok(pp),
            Ok(_) => {}
            Err(e) => eprintln!("[xelis] bundled sidecar unavailable ({}), will download", e),
        }
    }
    // Keep "binary" and "missing": XelisSyncCard offers its download button on
    // those words when the error arrives before its own binary check.
    Err(format!(
        "The Xelis wallet binary is missing: this build did not bundle one for this platform \
         and none has been downloaded to {:?} yet.",
        p
    ))
}

/// The port a running (or crash-orphaned) wallet recorded at start, for the
/// background updater's "is it busy?" check. Never the credentials.
pub fn recorded_rpc_port(app: &AppHandle) -> Option<u16> {
    get_credsfile(app).ok().and_then(|p| read_creds_file(&p)).map(|c| c.0)
}

fn write_creds_file(path: &PathBuf, port: u16, user: &str, pass: &str) {
    let _ = std::fs::write(path, format!("{}:{}:{}", port, user, pass));
}

fn read_creds_file(path: &PathBuf) -> Option<(u16, String, String)> {
    let s = std::fs::read_to_string(path).ok()?;
    let mut parts = s.trim().splitn(3, ':');
    let port = parts.next()?.parse::<u16>().ok()?;
    let user = parts.next()?.to_string();
    let pass = parts.next()?.to_string();
    if user.is_empty() || pass.is_empty() {
        return None;
    }
    Some((port, user, pass))
}

// =========================================================================
// JSON-RPC over HTTP Basic
// =========================================================================

/// Must `params` be left OUT of the request entirely?
///
/// XELIS refuses a `params` key on a method that takes none. Sending
/// `{"method":"get_version","params":{}}` comes back as
/// **`RPC error -32602: Unexpected parameters for this method`** — verified
/// live against v1.25.0, and it is why the spike's own captures show
/// `get_version`, `is_online`, `get_topoheight`, `network_info`, `get_nonce`
/// and `set_offline_mode` with NO `params` key at all, while `get_address`
/// and `get_balance` carry `"params":{}`.
///
/// Methods that accept optional parameters are happy either way, so omitting
/// an empty object is correct for every method and needs no per-method table.
///
/// This was not a theoretical tidy-up: the readiness probe polls `get_version`,
/// so with an empty `params` attached EVERY `xelis_start_rpc` would have failed
/// its 60 s readiness budget against a wallet that was answering correctly the
/// whole time. Caught by the live binary cross-check, not by any unit test —
/// nothing that does not talk to the real server could have found it.
pub fn omit_empty_params(params: &serde_json::Value) -> bool {
    params.is_null() || params.as_object().map(|o| o.is_empty()).unwrap_or(false)
}

/// Build a JSON-RPC request body. **The only place in this module that builds
/// one**, deliberately.
///
/// The rule in [`omit_empty_params`] applies to the DAEMON as well as the
/// wallet — verified live against `https://node.xelis.io`:
///
/// ```text
/// get_info WITH    params:{}  ->  -32602 Unexpected parameters for this method
/// get_info WITHOUT params     ->  ok
/// ```
///
/// The node probe used to build its own body with a hardcoded `"params": {}`,
/// which meant **every probe failed against every healthy node** — no node
/// would ever be selectable and `pickXelisDaemon` would report "No Xelis node
/// answered". The wallet client was fixed first and the probe was not, because
/// the probe's body was written by copying the shape rather than the rule. One
/// builder, so there is no second place for the rule to be missing from.
pub fn jsonrpc_body(method: &str, params: serde_json::Value) -> serde_json::Value {
    let mut body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method });
    if !omit_empty_params(&params) {
        body["params"] = params;
    }
    body
}

async fn do_rpc_call(
    port: u16,
    user: &str,
    password: &str,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let body = jsonrpc_body(method, params);

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;

    let resp = client
        .post(format!("http://127.0.0.1:{}/json_rpc", port))
        .header("Content-Type", "application/json")
        .header("Authorization", basic_auth_header(user, password))
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("Xelis RPC request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read body failed: {}", e))?;

    if status == reqwest::StatusCode::UNAUTHORIZED {
        // 401 with an EMPTY body is what both a wrong header and a missing one
        // produce, so there is nothing in the response to quote back.
        return Err("Xelis RPC rejected our credentials (401)".to_string());
    }
    if !status.is_success() {
        return Err(format!("Xelis RPC HTTP {}: {}", status, text));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("bad JSON from Xelis RPC: {} ({})", e, text))?;

    // JSON-RPC errors arrive as HTTP 200 with an `error` object carrying a
    // `kind` the frontend branches on (BALANCE_NOT_FOUND, NOT_ONLINE_MODE).
    // The shape below is the contract's: `RPC error <code>: <message>`.
    if let Some(err) = v.get("error") {
        if !err.is_null() {
            let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            let message = err.get("message").and_then(|m| m.as_str()).unwrap_or("");
            let kind = err.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            return Err(if kind.is_empty() {
                format!("RPC error {}: {}", code, message)
            } else {
                format!("RPC error {}: {} {}", code, kind, message)
            });
        }
    }
    Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

// =========================================================================
// Graceful shutdown — a real CTRL+C through a borrowed console
// =========================================================================

/// AttachConsole is process-global: two concurrent attaches would fight over
/// the one console slot this process has. Serialised here.
#[cfg(target_os = "windows")]
static CONSOLE_CTRL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Send a real CTRL+C to `pid`'s console group.
///
/// XELIS has no RPC shutdown method, and its `exit` command exists only in
/// interactive mode — which a sidecar cannot use. What it DOES have is a
/// `tokio::select!` on `tokio::signal::ctrl_c()`, which runs `wallet.close()`:
/// the RPC server stops, the network handler stops, and sled is flushed.
///
/// Measured on a `CREATE_NO_WINDOW` child (exactly how this module spawns):
/// AttachConsole returned 0, the process logged `CTRL+C received, exiting...`
/// and exited **0 in 0.52 s**.
///
/// `SetConsoleCtrlHandler(NULL, TRUE)` is what stops the event killing US as
/// well — the child's console becomes ours for the duration, and the event goes
/// to every process attached to it. It is restored before returning; leaving it
/// set would make the whole app ignore Ctrl+C.
///
/// Declared with a raw `extern "system"` block rather than pulling a new
/// `windows` crate feature into `Cargo.toml`, matching the precedent in
/// `data_paths.rs::system_ram_mb`.
#[cfg(target_os = "windows")]
fn graceful_ctrl_c(pid: u32) -> bool {
    const CTRL_C_EVENT: u32 = 0;

    extern "system" {
        fn AttachConsole(dwProcessId: u32) -> i32;
        fn FreeConsole() -> i32;
        fn SetConsoleCtrlHandler(handler: *const core::ffi::c_void, add: i32) -> i32;
        fn GenerateConsoleCtrlEvent(dwCtrlEvent: u32, dwProcessGroupId: u32) -> i32;
    }

    let _guard = match CONSOLE_CTRL_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    // Safe: all four take plain integers / a null pointer and touch no memory
    // we own. The sequence is the one verified against the real binary.
    unsafe {
        // Detach from any console we already hold; AttachConsole fails if one
        // is attached. A GUI app normally has none, so this usually no-ops.
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return false;
        }
        SetConsoleCtrlHandler(std::ptr::null(), 1);
        let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
        SetConsoleCtrlHandler(std::ptr::null(), 0);
        FreeConsole();
        sent
    }
}

#[cfg(not(target_os = "windows"))]
fn graceful_ctrl_c(pid: u32) -> bool {
    // SIGINT reaches the same `tokio::signal` handler upstream installs.
    std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// =========================================================================
// Stage A — create or restore, without a daemon
// =========================================================================

/// Ensure a wallet directory exists, creating or restoring it. Returns `true`
/// when one was created.
///
/// # Why this spawns a full RPC server just to make a wallet
///
/// XELIS has no one-shot "create and exit" mode: with interactive mode disabled
/// the process runs forever, and nothing it prints distinguishes "created
/// successfully" from "about to fail". Bringing the RPC up on a throwaway port,
/// asking it `get_version`, and stopping it again is the only way to learn that
/// the wallet was really created AND that the password really opens it — before
/// the user's session depends on both. It runs `offline_mode: true`, so no
/// network traffic happens at this stage.
pub async fn ensure_wallet_dir(
    app: &AppHandle,
    wallet_password: &str,
    seed_phrase: Option<&str>,
    force_recreate: bool,
    wallet_dir_name: Option<&str>,
    network: &str,
) -> Result<bool, String> {
    let wallet_dir = get_wallet_dir(app, wallet_dir_name)?;
    let db_path = wallet_dir.join("db");

    if force_recreate && wallet_dir.exists() {
        std::fs::remove_dir_all(&wallet_dir)
            .map_err(|e| format!("Failed to remove {:?}: {}", wallet_dir, e))?;
    }

    // A directory holding a `db` is a wallet. Opening it again here would cost
    // an Argon2id round for nothing — and, crucially, passing `seed` to it
    // would be SILENTLY IGNORED, which is the failure this early return makes
    // unreachable rather than merely unlikely.
    if db_path.exists() {
        return Ok(false);
    }

    let binary = resolve_rpc_binary(app)?;
    let tables_dir = get_tables_dir(app)?;
    let port = pick_free_port(XELIS_RPC_PORT_PREFERRED);
    let user = random_hex(16);
    let pass = random_hex(16);

    let config = build_wallet_config(
        &wallet_dir,
        wallet_password,
        seed_phrase,
        Some((port, &user, &pass)),
        None, // offline: creation never needs the network
        &tables_dir,
        network,
    );

    let config_path = get_xelis_dir(app)?.join("xelis-create.json");
    write_config(&config_path, &config)?;

    let log_path = get_xelis_dir(app)?.join("xelis-create.log");
    let mut child = spawn_wallet(&binary, &config_path, &log_path, &wallet_dir)?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(STAGE_A_TIMEOUT_MS);
    let mut created = false;
    loop {
        if do_rpc_call(
            port,
            &user,
            &pass,
            "get_version",
            serde_json::json!({}),
            std::time::Duration::from_millis(2_000),
        )
        .await
        .is_ok()
        {
            created = true;
            break;
        }

        if let Some(status) = child.try_wait().ok().flatten() {
            let log = read_log_tail(&log_path, 8192);
            let _ = std::fs::remove_file(&config_path);
            let detail = classify_xelis_failure(&log)
                .unwrap_or_else(|| format!("exited with {}. Log tail:\n{}", status, log));
            return Err(format!("The Xelis wallet could not be created: {}", detail));
        }

        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(READY_POLL_MS)).await;
    }

    // Stop the throwaway instance either way: a live process here would hold
    // the sled lock that Stage B is about to need.
    let pid = child.id();
    if created {
        if let Some(pid) = pid {
            if !graceful_ctrl_c(pid) {
                let _ = child.kill().await;
            }
        }
    } else {
        let _ = child.kill().await;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
    let _ = std::fs::remove_file(&config_path);
    wait_for_port_free(port, 5_000).await;

    if !created {
        let log = read_log_tail(&log_path, 8192);
        let detail = classify_xelis_failure(&log)
            .unwrap_or_else(|| format!("it did not answer in time. Log tail:\n{}", log));
        return Err(format!("The Xelis wallet could not be created: {}", detail));
    }

    if !db_path.exists() {
        return Err(format!(
            "The Xelis wallet reported ready but wrote no database at {:?}.",
            db_path
        ));
    }
    Ok(true)
}

fn write_config(path: &Path, config: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("Failed to write {:?}: {}", path, e))
}

/// Spawn the binary with ONLY `--config-file`, capturing stdout+stderr.
///
/// `current_dir` is always set. An unset working directory is how the swap
/// engine's per-swap Zano wallets ended up written into `src-tauri/`, which
/// `tauri dev` watches, relaunching the app mid-swap (2026-09-13 postmortem,
/// defect 3).
fn spawn_wallet(
    binary: &Path,
    config_path: &Path,
    log_path: &Path,
    cwd: &Path,
) -> Result<tokio::process::Child, String> {
    std::fs::create_dir_all(cwd).map_err(|e| format!("Failed to create {:?}: {}", cwd, e))?;
    let log = std::fs::File::create(log_path)
        .map_err(|e| format!("Failed to create {:?}: {}", log_path, e))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("Failed to clone log handle: {}", e))?;

    let mut cmd = tokio::process::Command::new(binary);
    cmd.current_dir(cwd);
    // The ONLY argument. Everything else — password, credentials, seed, network
    // — lives in the file, which keeps it off the process command line.
    cmd.arg("--config-file").arg(config_path);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err));

    cmd.spawn().map_err(|e| {
        if matches!(e.raw_os_error(), Some(126) | Some(-1073741515)) {
            "Xelis wallet could not start: the Microsoft Visual C++ Redistributable \
             (2015-2022, x64) appears to be missing."
                .to_string()
        } else {
            format!("Failed to spawn xelis_wallet: {}", e)
        }
    })
}

// =========================================================================
// Stage B — the long-lived RPC server
// =========================================================================

#[tauri::command]
pub async fn xelis_start_rpc(
    app: AppHandle,
    daemon_address: String,
    wallet_password: String,
    wallet_file: Option<String>,
    network: Option<String>,
) -> Result<(), String> {
    let state = app.state::<XelisRpcChild>();
    let network = normalize_network(network.as_deref());
    let wallet_dir = get_wallet_dir(&app, wallet_file.as_deref())?;
    let daemon_address = light_client_daemon(&daemon_address)?;

    {
        let inner = state.0.lock().await;
        if inner.child.is_some() && !start_needs_restart(inner.wallet_dir.as_deref(), &wallet_dir) {
            return Ok(());
        }
    }
    if state.0.lock().await.child.is_some() {
        stop_wallet(&app).await;
    }

    reap_stale_process(&app).await;

    if !wallet_dir.join("db").exists() {
        return Err("No Xelis wallet on disk. Run the import/create flow first.".into());
    }

    let binary = resolve_rpc_binary(&app)?;
    let tables_dir = get_tables_dir(&app)?;
    let log_path = get_log_file(&app)?;
    let config_path = get_config_file(&app)?;

    let mut last_error = String::new();

    for attempt in 0..PORT_ATTEMPTS {
        // First attempt prefers the canonical port; later ones take whatever
        // the OS hands out, because the canonical one is evidently contested.
        let port = if attempt == 0 {
            pick_free_port(XELIS_RPC_PORT_PREFERRED)
        } else {
            pick_free_port(0)
        };
        let user = random_hex(16);
        let pass = random_hex(16);

        let config = build_wallet_config(
            &wallet_dir,
            &wallet_password,
            None, // never on an open: `seed` is ignored when a db exists anyway
            Some((port, &user, &pass)),
            Some(&daemon_address),
            &tables_dir,
            network,
        );
        write_config(&config_path, &config)?;

        let child = spawn_wallet(&binary, &config_path, &log_path, &wallet_dir)?;
        let pid = child.id();

        if let Some(pid) = pid {
            if let Ok(p) = get_pidfile(&app) {
                write_pidfile(&p, pid);
            }
        }
        if let Ok(p) = get_credsfile(&app) {
            write_creds_file(&p, port, &user, &pass);
        }

        {
            let mut inner = state.0.lock().await;
            inner.child = Some(child);
            inner.port = Some(port);
            inner.creds = Some((user.clone(), pass.clone()));
            inner.wallet_dir = Some(wallet_dir.clone());
        }

        match await_ready(&app, port, &user, &pass, &log_path).await {
            ReadyOutcome::Ready => {
                // The config file has been read; it is now only a copy of the
                // password sitting on disk.
                let _ = std::fs::remove_file(&config_path);
                return Ok(());
            }
            ReadyOutcome::RetryPort(msg) => {
                last_error = msg;
                stop_wallet(&app).await;
                continue;
            }
            ReadyOutcome::Failed(msg) => {
                let _ = std::fs::remove_file(&config_path);
                stop_wallet(&app).await;
                if log_says_tables_corrupt(&read_log_tail(&log_path, 8192)) {
                    // Self-heal: the file is a pure function of L1, so deleting
                    // it costs one regeneration (~0.33 s) and nothing else.
                    if let Ok(t) = tables_file(&app) {
                        let _ = std::fs::remove_file(t);
                    }
                }
                return Err(msg);
            }
        }
    }

    let _ = std::fs::remove_file(&config_path);
    Err(format!(
        "The Xelis wallet's RPC server could not bind a port after {} attempts. {}",
        PORT_ATTEMPTS, last_error
    ))
}

enum ReadyOutcome {
    Ready,
    /// The RPC server failed to bind — recoverable on a different port.
    RetryPort(String),
    Failed(String),
}

/// Poll an AUTHENTICATED `get_version` until it answers.
///
/// A bare port check would go green on any process that happened to hold the
/// port, and would stay red forever on the "process alive, server never bound"
/// case this function exists to detect.
async fn await_ready(
    app: &AppHandle,
    port: u16,
    user: &str,
    pass: &str,
    log_path: &Path,
) -> ReadyOutcome {
    let state = app.state::<XelisRpcChild>();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(READY_BUDGET_MS);

    loop {
        if do_rpc_call(
            port,
            user,
            pass,
            "get_version",
            serde_json::json!({}),
            std::time::Duration::from_millis(2_000),
        )
        .await
        .is_ok()
        {
            return ReadyOutcome::Ready;
        }

        let log = read_log_tail(&log_path.to_path_buf(), 8192);
        if log_says_rpc_bind_failed(&log) {
            return ReadyOutcome::RetryPort(format!("port {} was already in use", port));
        }
        if let Some(reason) = classify_xelis_failure(&log) {
            return ReadyOutcome::Failed(reason);
        }

        // An exit code of 0 is NOT success here: an RPC misconfiguration exits
        // cleanly, having served nothing.
        {
            let mut inner = state.0.lock().await;
            let exited = match inner.child.as_mut() {
                Some(c) => c.try_wait().ok().flatten(),
                None => None,
            };
            if let Some(status) = exited {
                inner.child = None;
                drop(inner);
                let log = read_log_tail(&log_path.to_path_buf(), 8192);
                return ReadyOutcome::Failed(
                    classify_xelis_failure(&log).unwrap_or_else(|| {
                        format!(
                            "The Xelis wallet exited during startup ({}). Log tail:\n{}",
                            status, log
                        )
                    }),
                );
            }
        }

        if std::time::Instant::now() >= deadline {
            let log = read_log_tail(&log_path.to_path_buf(), 8192);
            return ReadyOutcome::Failed(classify_xelis_failure(&log).unwrap_or_else(|| {
                format!(
                    "The Xelis wallet did not become ready in {} ms. Log tail:\n{}",
                    READY_BUDGET_MS, log
                )
            }));
        }
        tokio::time::sleep(std::time::Duration::from_millis(READY_POLL_MS)).await;
    }
}

// =========================================================================
// Commands
// =========================================================================

#[tauri::command]
pub async fn xelis_ensure_wallet(
    app: AppHandle,
    wallet_password: String,
    seed_phrase: Option<String>,
    force_recreate: Option<bool>,
    wallet_file: Option<String>,
    network: Option<String>,
) -> Result<bool, String> {
    let network = normalize_network(network.as_deref());
    ensure_wallet_dir(
        &app,
        &wallet_password,
        seed_phrase.as_deref(),
        force_recreate.unwrap_or(false),
        wallet_file.as_deref(),
        network,
    )
    .await
}

#[tauri::command]
pub async fn xelis_rpc_call(
    app: AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<XelisRpcChild>();
    let live = {
        let inner = state.0.lock().await;
        match (inner.port, inner.creds.clone()) {
            (Some(port), Some((u, p))) => Some((port, u, p)),
            _ => None,
        }
    };
    let (port, user, pass) = live
        .or_else(|| {
            get_credsfile(&app)
                .ok()
                .and_then(|p| read_creds_file(&p))
        })
        .ok_or("Xelis RPC is not running")?;

    do_rpc_call(
        port,
        &user,
        &pass,
        &method,
        params,
        std::time::Duration::from_secs(120),
    )
    .await
}

#[tauri::command]
pub async fn xelis_stop_rpc(app: AppHandle) -> Result<(), String> {
    stop_wallet(&app).await;
    Ok(())
}

/// Stop the wallet, giving it every chance to flush first.
///
/// Order matters: go offline (so nothing is mid-scan), wait past sled's own
/// 500 ms flush interval, then CTRL+C, then — only if that failed — kill. A
/// hard kill IS recoverable here (verified: the wallet reopened with its synced
/// topoheight intact, leaving only a `snap.*` file behind), which is why the
/// fallback is acceptable rather than a corruption risk.
async fn stop_wallet(app: &AppHandle) {
    let state = app.state::<XelisRpcChild>();

    let live = {
        let inner = state.0.lock().await;
        match (inner.port, inner.creds.clone()) {
            (Some(port), Some((u, p))) => Some((port, u, p)),
            _ => None,
        }
    };

    if let Some((port, user, pass)) = live {
        let _ = do_rpc_call(
            port,
            &user,
            &pass,
            "set_offline_mode",
            serde_json::json!({}),
            std::time::Duration::from_millis(5_000),
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }

    let (child, port) = {
        let mut inner = state.0.lock().await;
        (inner.child.take(), inner.port.take())
    };

    if let Some(mut child) = child {
        let pid = child.id();
        let stopped = match pid {
            Some(pid) => {
                let sent = tokio::task::spawn_blocking(move || graceful_ctrl_c(pid))
                    .await
                    .unwrap_or(false);
                if sent {
                    tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
                        .await
                        .is_ok()
                } else {
                    false
                }
            }
            None => false,
        };
        if !stopped {
            let _ = child.kill().await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
        }
    }

    {
        let mut inner = state.0.lock().await;
        inner.creds = None;
        inner.wallet_dir = None;
    }

    if let Ok(p) = get_pidfile(app) {
        delete_pidfile(&p);
    }
    if let Ok(p) = get_credsfile(app) {
        let _ = std::fs::remove_file(p);
    }
    if let Ok(p) = get_config_file(app) {
        let _ = std::fs::remove_file(p);
    }
    if let Some(port) = port {
        wait_for_port_free(port, 5_000).await;
    }
}

#[tauri::command]
pub async fn xelis_rpc_is_running(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<XelisRpcChild>();
    let (has_child, port) = {
        let inner = state.0.lock().await;
        (inner.child.is_some(), inner.port)
    };
    match (has_child, port) {
        (true, Some(port)) => Ok(port_is_bound(port).await),
        _ => Ok(false),
    }
}

#[tauri::command]
pub async fn xelis_binary_status(app: AppHandle) -> Result<bool, String> {
    Ok(resolve_rpc_binary(&app).is_ok())
}

#[derive(Clone, serde::Serialize)]
pub struct XelisNodeProbe {
    pub url: String,
    pub ok: bool,
    pub latency_ms: Option<u32>,
    /// The daemon's TOPOHEIGHT (not `height` — XELIS is a BlockDAG, and the two
    /// differ: one live mainnet response carried height 7,672,788 and
    /// topoheight 8,904,921).
    pub height: Option<u64>,
    pub error: Option<String>,
}

/// Probe a XELIS daemon.
///
/// Deliberately NOT `wallet_rpc_common::probe_node`, which GETs `<url>/get_info`
/// — a Monero-family REST convention XELIS does not implement. XELIS is
/// JSON-RPC only: `POST <url>/json_rpc {"method":"get_info"}`.
///
/// Two calls, not one. `get_info` alone cannot tell a healthy node from a
/// stalled one — see [`stalled_reason`] for the node that answered everything
/// correctly with a 13-hour-old chain tip. A stalled node is reported as
/// **not ok**, with the age in the error, because selecting it would leave the
/// wallet quietly scanning a dead chain.
///
/// `get_top_block.timestamp` is in MILLISECONDS — confirmed live
/// (1789519627782, a tip 2.5 s old). Reading it as seconds would date every
/// healthy node to 1970 and mark the entire pool stalled.
///
/// Requests go through [`jsonrpc_body`], which omits an empty `params`. The
/// daemon rejects one exactly as the wallet does; see that function.
#[tauri::command]
pub async fn xelis_probe_node(url: String, timeout_ms: u64) -> Result<XelisNodeProbe, String> {
    let endpoint = format!("{}/json_rpc", daemon_base_url(&url));

    let fail = |latency: Option<u32>, msg: String| XelisNodeProbe {
        url: url.clone(),
        ok: false,
        latency_ms: latency,
        height: None,
        error: Some(msg),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Ok(fail(None, format!("client build: {}", e))),
    };

    let call = |method: &'static str| {
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move {
            // Null, not `{}` — see `jsonrpc_body`. Both methods this probe
            // calls take no parameters, and the daemon refuses an empty object.
            let body = jsonrpc_body(method, serde_json::Value::Null);
            let resp = client
                .post(&endpoint)
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        "timeout".to_string()
                    } else if e.is_connect() {
                        "connect failed".to_string()
                    } else {
                        format!("{}", e)
                    }
                })?;
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("HTTP {}", status.as_u16()));
            }
            let text = resp.text().await.map_err(|e| format!("read body: {}", e))?;
            let parsed: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("bad JSON: {}", e))?;
            if let Some(err) = parsed.get("error") {
                if !err.is_null() {
                    return Err(format!("RPC error: {}", err));
                }
            }
            Ok::<serde_json::Value, String>(
                parsed.get("result").cloned().unwrap_or(serde_json::Value::Null),
            )
        }
    };

    let start = std::time::Instant::now();
    let info = match call("get_info").await {
        Ok(v) => v,
        Err(e) => return Ok(fail(None, e)),
    };
    let latency_ms = start.elapsed().as_millis() as u32;

    let height = info.get("topoheight").and_then(|h| h.as_u64());

    // The staleness check. A failure to READ the top block is not a failure of
    // the node — report the node as healthy but say the age is unknown rather
    // than rejecting a node over our own second call.
    if let Ok(top) = call("get_top_block").await {
        if let Some(ts) = top.get("timestamp").and_then(|t| t.as_u64()) {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now_ms > 0 {
                if let Some(reason) = stalled_reason(ts, now_ms) {
                    return Ok(XelisNodeProbe {
                        url,
                        ok: false,
                        latency_ms: Some(latency_ms),
                        height,
                        error: Some(reason),
                    });
                }
            }
        }
    }

    Ok(XelisNodeProbe { url, ok: true, latency_ms: Some(latency_ms), height, error: None })
}

/// Kill a sidecar left behind by a previous run (crash, hard shutdown).
async fn reap_stale_process(app: &AppHandle) {
    let recorded_port = get_credsfile(app).ok().and_then(|p| read_creds_file(&p)).map(|c| c.0);

    if let Ok(pidfile) = get_pidfile(app) {
        if let Some(pid) = read_pidfile(&pidfile) {
            // Image-name filtered so a recycled PID can never make us kill an
            // unrelated process.
            if let Some(image) = pid_image_name(pid).await {
                if image.eq_ignore_ascii_case(XELIS_BINARY_NAME) {
                    let _ = kill_pid_force(pid).await;
                }
            }
            delete_pidfile(&pidfile);
        }
    }

    #[cfg(target_os = "windows")]
    {
        for port in [recorded_port, Some(XELIS_RPC_PORT_PREFERRED)].into_iter().flatten() {
            if let Some(pid) = find_pid_holding_port(port).await {
                let is_ours = pid_image_name(pid)
                    .await
                    .map(|img| img.eq_ignore_ascii_case(XELIS_BINARY_NAME))
                    .unwrap_or(false);
                if is_ours {
                    let _ = kill_pid_force(pid).await;
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = recorded_port;

    if let Ok(p) = get_credsfile(app) {
        let _ = std::fs::remove_file(p);
    }
    wait_for_port_free(XELIS_RPC_PORT_PREFERRED, 5_000).await;
}

// =========================================================================
// Download
// =========================================================================

/// Download, verify and extract `xelis_wallet` from the pinned release.
///
/// Error taxonomy is deliberate, matching `zano_download_wallet_rpc`: a blocked
/// host, a hash mismatch and a generic failure are three different problems with
/// three different right answers, and "retry" is correct for only one of them.
#[tauri::command]
pub async fn xelis_download_wallet_rpc(app: AppHandle) -> Result<(), String> {
    let xelis_dir = get_xelis_dir(&app)?;
    let exe_path = xelis_dir.join(XELIS_BINARY_NAME);

    if is_real_binary(&exe_path) {
        let _ = app.emit(
            "xelis-download-progress",
            XelisDownloadProgress {
                stage: "complete".to_string(),
                percent: 100.0,
                message: format!("{} already present", XELIS_BINARY_NAME),
            },
        );
        return Ok(());
    }

    let url = format!("{}/{}", XELIS_RELEASE_BASE, XELIS_ARCHIVE_NAME);
    let client = reqwest::Client::builder()
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let _ = app.emit(
        "xelis-download-progress",
        XelisDownloadProgress {
            stage: "downloading".to_string(),
            percent: 0.0,
            message: format!("Downloading XELIS {} ({})…", XELIS_RELEASE_TAG, XELIS_ARCHIVE_NAME),
        },
    );

    let response = client.get(&url).send().await.map_err(|e| {
        format!(
            "Download blocked: could not reach github.com ({}). If this persists, download {} \
             from {} on another network, verify its SHA256 is {}, extract {} and place it at {}.",
            e,
            XELIS_ARCHIVE_NAME,
            XELIS_RELEASE_BASE,
            XELIS_ARCHIVE_SHA256,
            XELIS_BINARY_NAME,
            exe_path.display()
        )
    })?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {} from {}", response.status(), url));
    }

    let total_size = response.content_length().unwrap_or(0);
    let archive_path = xelis_dir.join(XELIS_ARCHIVE_NAME);
    let mut file = std::fs::File::create(&archive_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            format!(
                "Download blocked: connection dropped mid-transfer ({}). {} bytes arrived first.",
                e, downloaded
            )
        })?;
        file.write_all(&chunk).map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        let percent = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit(
            "xelis-download-progress",
            XelisDownloadProgress {
                stage: "downloading".to_string(),
                percent,
                message: format!(
                    "Downloading xelis_wallet — {:.1}/{:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            },
        );
    }
    drop(file);

    let actual_hash: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    if actual_hash != XELIS_ARCHIVE_SHA256 {
        let _ = std::fs::remove_file(&archive_path);
        return Err(format!(
            "SHA256 mismatch for {} — expected {}, got {}. Aborted before extraction. Either the \
             pin in src-tauri/src/xelis_rpc.rs is stale (XELIS cuts releases roughly monthly) or \
             the download was corrupted or tampered with. Do not retry blindly: confirm the hash \
             against the release page first.",
            XELIS_ARCHIVE_NAME, XELIS_ARCHIVE_SHA256, actual_hash
        ));
    }

    let _ = app.emit(
        "xelis-download-progress",
        XelisDownloadProgress {
            stage: "extracting".to_string(),
            percent: 0.0,
            message: "Extracting xelis_wallet…".to_string(),
        },
    );

    extract_wallet_binary(&archive_path, &exe_path)?;
    let _ = std::fs::remove_file(&archive_path);

    if !is_real_binary(&exe_path) {
        return Err(format!("{} was not found inside {}", XELIS_BINARY_NAME, XELIS_ARCHIVE_NAME));
    }

    crate::sidecar_update::set_installed_version(&xelis_dir, XELIS_RELEASE_TAG);

    let _ = app.emit(
        "xelis-download-progress",
        XelisDownloadProgress {
            stage: "complete".to_string(),
            percent: 100.0,
            message: "xelis_wallet ready".to_string(),
        },
    );
    Ok(())
}

/// Pull ONLY the wallet binary out of the release archive.
///
/// The archive also carries `xelis_daemon` (67 MB) and `xelis_miner`, neither of
/// which this app runs — we use remote daemons and SRBMiner.
#[cfg(target_os = "windows")]
fn extract_wallet_binary(archive: &Path, dest: &Path) -> Result<(), String> {
    let zip_file = std::fs::File::open(archive).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut zip = zip::ZipArchive::new(zip_file).map_err(|e| format!("Failed to read zip: {}", e))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("Zip entry error: {}", e))?;
        let name = entry.name().to_string();
        if name.ends_with(XELIS_BINARY_NAME) {
            let mut out =
                std::fs::File::create(dest).map_err(|e| format!("Failed to create exe: {}", e))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("Failed to extract exe: {}", e))?;
            return Ok(());
        }
    }
    Err(format!("{} not found inside {:?}", XELIS_BINARY_NAME, archive))
}

#[cfg(not(target_os = "windows"))]
fn extract_wallet_binary(archive: &Path, dest: &Path) -> Result<(), String> {
    use std::io::Read;
    let file = std::fs::File::open(archive).map_err(|e| format!("Failed to open archive: {}", e))?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().map_err(|e| format!("Failed to read tar: {}", e))? {
        let mut entry = entry.map_err(|e| format!("Tar entry error: {}", e))?;
        let path = entry.path().map_err(|e| format!("Tar path error: {}", e))?.into_owned();
        if path.file_name().map(|n| n == XELIS_BINARY_NAME).unwrap_or(false) {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| format!("Failed to extract: {}", e))?;
            std::fs::write(dest, &bytes).map_err(|e| format!("Failed to write binary: {}", e))?;
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
            return Ok(());
        }
    }
    Err(format!("{} not found inside {:?}", XELIS_BINARY_NAME, archive))
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_defaults_to_mainnet_and_never_guesses_testnet() {
        assert_eq!(normalize_network(Some("testnet")), "testnet");
        assert_eq!(normalize_network(Some("TESTNET")), "testnet");
        assert_eq!(normalize_network(Some("mainnet")), "mainnet");
        assert_eq!(normalize_network(None), "mainnet");
        // The important one: an unrecognised value must land on MAINNET. The
        // opposite default would point a wallet holding real funds at a chain
        // where its addresses do not exist.
        assert_eq!(normalize_network(Some("stagenet")), "mainnet");
        assert_eq!(normalize_network(Some("")), "mainnet");
    }

    /// `wss://…/json_rpc` produced `…/json_rpc/json_rpc` and a live
    /// `HTTP error: 404 Not Found`. The wallet appends the path itself.
    #[test]
    fn daemon_address_is_reduced_to_a_base_url() {
        assert_eq!(daemon_base_url("https://node.xelis.io"), "https://node.xelis.io");
        assert_eq!(daemon_base_url("https://node.xelis.io/"), "https://node.xelis.io");
        assert_eq!(daemon_base_url("https://node.xelis.io/json_rpc"), "https://node.xelis.io");
        assert_eq!(daemon_base_url("https://node.xelis.io/json_rpc/"), "https://node.xelis.io");
        assert_eq!(daemon_base_url("  https://node.xelis.io  "), "https://node.xelis.io");
        // The scheme is upstream's business: it maps https->wss and http->ws.
        assert_eq!(daemon_base_url("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    }

    /// `Error: Path for precomputed tables must ends with / or \` (sic).
    #[test]
    fn tables_path_always_ends_with_a_separator() {
        let p = tables_path_with_separator(Path::new("C:\\data\\xelis-tables"));
        assert!(p.ends_with('/') || p.ends_with('\\'), "got {:?}", p);
        // Idempotent: a path that already ends with one does not gain a second.
        let already = tables_path_with_separator(Path::new("/tmp/x/"));
        assert_eq!(already, "/tmp/x/");
    }

    /// Pinned against bytes, not against another base64 call. Zano shipped a
    /// base64 ALPHABET bug that passed on a lucky payload and failed on others,
    /// and no unit test could have caught it because none encoded a known value.
    #[test]
    fn basic_auth_header_matches_fixed_bytes() {
        // "Aladdin:open sesame" is RFC 7617's own example.
        assert_eq!(
            basic_auth_header("Aladdin", "open sesame"),
            "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="
        );
        // A payload whose base64 contains BOTH '+' and '/' in the standard
        // alphabet, so a base64url implementation would differ visibly here.
        assert_eq!(basic_auth_header("a", "\u{00fb}\u{00ff}"), "Basic YTrDu8O/");
        assert!(basic_auth_header("u", "p").starts_with("Basic "));
    }

    #[test]
    fn a_failed_bind_is_recognised_and_is_retryable() {
        let log = "2026-09-15 ERROR xelis_wallet > Error while enabling RPC Server: Only one \
                   usage of each socket address (protocol/network address/port) is normally \
                   permitted. (os error 10048)";
        assert!(log_says_rpc_bind_failed(log));
        // It must NOT be classified as a terminal failure, or the retry never
        // happens: the process is still alive and healthy, just serverless.
        assert!(classify_xelis_failure(log).is_none());
    }

    #[test]
    fn startup_failures_map_to_distinguishable_messages() {
        let wrong_password =
            "Error: Invalid password provided for this wallet\n\nCaused by:\n    Error from crypto: aead::Error";
        let locked = "Error: IO error: could not acquire lock on \"C:\\\\…\\\\db\": Os { code: 33 }";
        let truncated = "Error: failed to fill whole buffer";
        let slash = "Error: Path for precomputed tables must ends with / or \\";

        let p = classify_xelis_failure(wrong_password).expect("password case");
        let l = classify_xelis_failure(locked).expect("lock case");
        let t = classify_xelis_failure(truncated).expect("tables case");
        let s = classify_xelis_failure(slash).expect("slash case");

        assert!(p.contains("password"));
        assert!(l.contains("Another process"));
        assert!(t.contains("regenerated"));
        assert!(s.contains("trailing separator"));

        // Distinguishable is the whole point: four causes, four messages.
        let all = [&p, &l, &t, &s];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "two startup failures share one message");
            }
        }
        assert!(classify_xelis_failure("nothing interesting here").is_none());
        assert!(log_says_tables_corrupt(truncated));
        assert!(!log_says_tables_corrupt(wrong_password));
    }

    /// The public testnet answered `get_info` and `p2p_status` normally, with a
    /// plausible topoheight and 2 peers, while its top block was 803 minutes
    /// old. Topoheight equality is not health.
    #[test]
    fn a_stalled_node_is_detected_by_block_age_not_by_topoheight() {
        let now = 1_800_000_000_000u64;
        // The real observation: 803 minutes.
        let stalled = stalled_reason(now - 803 * 60_000, now).expect("803 minutes must be stalled");
        assert!(stalled.contains("803"), "got {:?}", stalled);

        // 12.6 s old — the live mainnet tip at the same moment.
        assert!(stalled_reason(now - 12_600, now).is_none());
        // A few missed blocks is jitter, not death.
        assert!(stalled_reason(now - 5 * 60_000, now).is_none());
        // Past the threshold.
        assert!(stalled_reason(now - 16 * 60_000, now).is_some());
        // A tip timestamped in the future is a clock disagreement, and must not
        // underflow into a colossal age.
        assert!(stalled_reason(now + 60_000, now).is_none());
    }

    #[test]
    fn a_start_for_another_wallet_directory_restarts() {
        let a = PathBuf::from("/data/xelis-wallets/pwnda-xelis-1");
        let b = PathBuf::from("/data/xelis-wallets/pwnda-xelis-2");
        assert!(start_needs_restart(Some(&a), &b));
        assert!(!start_needs_restart(Some(&a), &a));
        // Nothing running: start, do not "restart".
        assert!(!start_needs_restart(None, &a));
    }

    /// THE config test: no secret may reach the command line, and the fields
    /// with no serde default must all be present.
    #[test]
    fn the_config_carries_every_secret_so_the_command_line_carries_none() {
        let cfg = build_wallet_config(
            Path::new("/data/xelis-wallets/pwnda-xelis-1"),
            "wallet-pw",
            Some("etched gypsy plywood"),
            Some((18087, "rpcuser", "rpcpass")),
            Some("https://node.xelis.io/json_rpc"),
            Path::new("/data/xelis-tables"),
            "mainnet",
        );

        assert_eq!(cfg["password"], "wallet-pw");
        assert_eq!(cfg["seed"], "etched gypsy plywood");
        assert_eq!(cfg["rpc"]["username"], "rpcuser");
        assert_eq!(cfg["rpc"]["password"], "rpcpass");
        assert_eq!(cfg["rpc"]["bind_address"], "127.0.0.1:18087");

        // Reduced to a base URL, or the wallet requests /json_rpc/json_rpc.
        assert_eq!(cfg["network_handler"]["daemon_address"], "https://node.xelis.io");
        assert_eq!(cfg["network_handler"]["offline_mode"], false);

        // Fields with NO serde default — a config missing any of them is
        // refused by the binary outright.
        assert!(cfg["rpc"]["threads"].is_number());
        assert!(cfg["rpc"]["notify_events_concurrency"].is_number());
        assert!(cfg["network_handler"]["offline_mode"].is_boolean());

        // A missing password hangs the process forever, silently.
        assert!(cfg["password"].is_string());
        assert!(!cfg["password"].as_str().unwrap().is_empty());

        // Interactive mode reads stdin a sidecar never provides.
        assert_eq!(cfg["log"]["disable_interactive_mode"], true);

        assert_eq!(cfg["precomputed_tables"]["precomputed_tables_l1"], 20);
        let tables = cfg["precomputed_tables"]["precomputed_tables_path"].as_str().unwrap();
        assert!(tables.ends_with('/') || tables.ends_with('\\'));
    }

    /// Operator requirement, 2026-09-16: light mode only. An online start
    /// names a real node, and an empty or scheme-less address is refused
    /// before anything is spawned.
    #[test]
    fn an_online_wallet_always_names_a_node() {
        assert_eq!(
            light_client_daemon("https://node.xelis.io/json_rpc").unwrap(),
            "https://node.xelis.io"
        );
        assert_eq!(light_client_daemon(" wss://node.xelis.io/ ").unwrap(), "wss://node.xelis.io");
        // A user's own node is still a node the light wallet talks to.
        assert_eq!(light_client_daemon("http://127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080");
        for bad in ["", "   ", "/json_rpc", "node.xelis.io", "https://", "ftp://node.xelis.io"] {
            let err = light_client_daemon(bad).expect_err(bad);
            assert!(err.contains("light client"), "{bad:?}: {err}");
        }
    }

    /// The online config is a light wallet of a remote node, with no local
    /// server beyond its own loopback RPC and nothing tuned above the floor.
    #[test]
    fn the_online_config_is_a_minimal_light_client() {
        let cfg = build_wallet_config(
            Path::new("/w"),
            "pw",
            None,
            Some((18087, "u", "p")),
            Some("https://node.xelis.io"),
            Path::new("/t"),
            "mainnet",
        );
        assert_eq!(cfg["network_handler"]["offline_mode"], false);
        assert_eq!(cfg["network_handler"]["daemon_address"], "https://node.xelis.io");
        // XSWD is a second server (dApp bridge); a light sidecar runs none.
        assert_eq!(cfg["enable_xswd"], false);
        assert_eq!(cfg["rpc"]["bind_address"], "127.0.0.1:18087");
        assert_eq!(cfg["n_decryption_threads"], 1);
        assert_eq!(cfg["network_concurrency"], 1);
        assert_eq!(cfg["rpc"]["threads"], 1);
        // History stays on: the operator's own address had 18 balance changes
        // when this was decided, so a full scan is cheap (log.md, 2026-09-16).
        assert_eq!(cfg["history_scan_mode"], "all");
    }

    /// The bundled light client, end to end, with this module's own pieces
    /// (2026-09-16). Unpacks the STAGED payload with the app's extractor,
    /// creates the vector-1 wallet offline, then opens it online against a
    /// public node exactly as `xelis_start_rpc` would, and waits for a synced
    /// status the way `xelis-rpc.ts::getSyncStatus` computes it.
    ///
    /// Stands in for driving the dev-sandbox window, which cannot be scripted
    /// from here. Needs the network and a staged `xelis-wallet.gz`:
    ///   PWNDA_XELIS_BUNDLE_RES=<src-tauri dir> cargo test --lib \
    ///     xelis_rpc::tests::live_bundled_light_client -- --ignored --nocapture
    ///
    /// The seed is the PUBLIC test vector from `xelis-vectors.ts`; it holds
    /// nothing and nothing is ever sent.
    #[tokio::test]
    #[ignore = "network + staged payload; set PWNDA_XELIS_BUNDLE_RES"]
    async fn live_bundled_light_client() {
        use crate::wallet_rpc_common::{extract_bundled_sidecar, pick_free_port, random_hex};
        use std::time::{Duration, Instant};

        const SEED: &str = "gutter slug fancy iguana drowning fewest bemused buckets pouch down ribbon bumper payment newt aztec gearbox fewest point hounded oncoming ongoing soapy tacit thaw thaw";
        const ADDRESS: &str = "xel:qc3hdkmsc0nqks7jqz8cpnzv5c3ur7my6yy7ct6ulf5kuexv53pqqjlaht0";

        let res = PathBuf::from(std::env::var("PWNDA_XELIS_BUNDLE_RES").expect("PWNDA_XELIS_BUNDLE_RES"));
        let root = std::env::temp_dir().join(format!("pwnda-xelis-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin_dir = root.join("xelis");
        let binary = extract_bundled_sidecar(&res, &bin_dir, "xelis").expect("unpack the bundled wallet");
        assert!(is_real_binary(&binary));
        let wallet_dir = root.join("xelis-wallets").join("pwnda-xelis-e2e");
        let tables = root.join("xelis-tables");
        std::fs::create_dir_all(&tables).unwrap();

        async fn ready(port: u16, u: &str, p: &str, budget: Duration) -> bool {
            let end = Instant::now() + budget;
            while Instant::now() < end {
                if do_rpc_call(port, u, p, "get_version", serde_json::json!({}), Duration::from_secs(2))
                    .await
                    .is_ok()
                {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(READY_POLL_MS)).await;
            }
            false
        }
        async fn call(port: u16, u: &str, p: &str, m: &str) -> serde_json::Value {
            do_rpc_call(port, u, p, m, serde_json::json!({}), Duration::from_secs(30))
                .await
                .unwrap_or_else(|e| panic!("{m}: {e}"))
        }

        // Stage A — offline create, as ensure_wallet_dir does.
        let t0 = Instant::now();
        let (port, u, p) = (pick_free_port(0), random_hex(16), random_hex(16));
        let cfg = build_wallet_config(&wallet_dir, "e2e-pw", Some(SEED), Some((port, &u, &p)), None, &tables, "mainnet");
        let cfg_path = bin_dir.join("xelis-create.json");
        write_config(&cfg_path, &cfg).unwrap();
        let log_a = bin_dir.join("xelis-create.log");
        let mut child = spawn_wallet(&binary, &cfg_path, &log_a, &wallet_dir).expect("spawn stage A");
        assert!(
            ready(port, &u, &p, Duration::from_millis(STAGE_A_TIMEOUT_MS)).await,
            "stage A never answered:\n{}",
            read_log_tail(&log_a, 4096)
        );
        assert_eq!(call(port, &u, &p, "get_address").await, ADDRESS, "restored address");
        println!("stage A (offline create) ready in {:?}", t0.elapsed());
        let _ = child.kill().await;
        let _ = child.wait().await;
        wait_for_port_free(port, 5_000).await;
        assert!(wallet_dir.join("db").exists(), "no wallet database written");

        // Stage B — online light client, as xelis_start_rpc does.
        let daemon = light_client_daemon("https://node.xelis.io/json_rpc").unwrap();
        let t1 = Instant::now();
        let (port, u, p) = (pick_free_port(0), random_hex(16), random_hex(16));
        let cfg = build_wallet_config(&wallet_dir, "e2e-pw", None, Some((port, &u, &p)), Some(&daemon), &tables, "mainnet");
        assert_eq!(cfg["network_handler"]["offline_mode"], false);
        let cfg_path = bin_dir.join("xelis-launch.json");
        write_config(&cfg_path, &cfg).unwrap();
        let log_b = bin_dir.join("xelis-rpc.log");
        let mut child = spawn_wallet(&binary, &cfg_path, &log_b, &wallet_dir).expect("spawn stage B");
        assert!(
            ready(port, &u, &p, Duration::from_millis(READY_BUDGET_MS)).await,
            "stage B never answered:\n{}",
            read_log_tail(&log_b, 4096)
        );
        let _ = std::fs::remove_file(&cfg_path);
        assert_eq!(call(port, &u, &p, "get_address").await, ADDRESS);
        println!("stage B (online) ready in {:?}", t1.elapsed());

        // Synced, by getSyncStatus's rule: online, and the wallet's topoheight
        // has reached the daemon's stable topoheight.
        let end = Instant::now() + Duration::from_secs(120);
        let mut last;
        let synced = loop {
            let online = call(port, &u, &p, "is_online").await == serde_json::json!(true);
            let wallet_topo = call(port, &u, &p, "get_topoheight").await.as_u64().unwrap_or(0);
            if online {
                let info = call(port, &u, &p, "network_info").await;
                let target = info["stable_topoheight"].as_u64().or(info["topoheight"].as_u64());
                last = format!("online wallet={} target={:?}", wallet_topo, target);
                if matches!(target, Some(t) if wallet_topo >= t && t > 0) {
                    break true;
                }
            } else {
                last = format!("offline wallet={}", wallet_topo);
            }
            if Instant::now() > end {
                break false;
            }
            tokio::time::sleep(Duration::from_millis(XELIS_SYNC_POLL_MS_FOR_TEST)).await;
        };
        println!("sync: {} after {:?}", last, t1.elapsed());
        let _ = do_rpc_call(port, &u, &p, "set_offline_mode", serde_json::json!({}), Duration::from_secs(5)).await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        let log = read_log_tail(&log_b, 4096);
        let _ = std::fs::remove_dir_all(&root);
        assert!(synced, "never synced ({last}). Log tail:\n{log}");
    }

    /// `useXelisSession`'s poll interval while syncing.
    const XELIS_SYNC_POLL_MS_FOR_TEST: u64 = 5_000;

    #[test]
    fn an_offline_config_omits_the_seed_and_the_bind_address_when_asked_to() {
        let cfg = build_wallet_config(
            Path::new("/w"),
            "pw",
            None,
            None,
            None,
            Path::new("/t"),
            "testnet",
        );
        assert!(cfg["seed"].is_null());
        assert!(cfg["rpc"]["bind_address"].is_null());
        assert!(cfg["rpc"]["username"].is_null());
        assert_eq!(cfg["network_handler"]["offline_mode"], true);
        assert_eq!(cfg["network"], "testnet");
    }

    /// The tables file is named after L1, so two L1 values coexist rather than
    /// one silently reading the other's file.
    #[test]
    fn the_precomputed_table_choice_is_the_documented_one() {
        assert_eq!(
            XELIS_PRECOMPUTED_TABLES_L1, 20,
            "L1 is a measured trade-off, not an arbitrary number — read the constant's \
             doc comment before changing it"
        );
        // 3 is the true minimum the binary accepts and is unusable (4.7 s to
        // decode 1 XEL); 26 is upstream's default at ~349 MB.
        assert!(XELIS_PRECOMPUTED_TABLES_L1 > 3 && XELIS_PRECOMPUTED_TABLES_L1 < 26);
    }

    #[test]
    fn the_preferred_port_avoids_every_neighbouring_sidecar() {
        // XMR 18082, ZEPH 18083, ZANO 18084, ZANO scratch 18086, and 8080 is
        // both XELIS's own default daemon port and taken by an unrelated
        // service on the dev machine.
        for taken in [8080u16, 18082, 18083, 18084, 18085, 18086] {
            assert_ne!(XELIS_RPC_PORT_PREFERRED, taken);
        }
    }

    /// `-32602 Unexpected parameters for this method`, found by the live
    /// cross-check against the real binary. See [`omit_empty_params`].
    #[test]
    fn a_no_parameter_method_must_not_carry_an_empty_params_object() {
        assert!(omit_empty_params(&serde_json::Value::Null));
        assert!(omit_empty_params(&serde_json::json!({})));

        // Anything with content must be sent unchanged.
        assert!(!omit_empty_params(&serde_json::json!({ "asset": "00" })));
        assert!(!omit_empty_params(&serde_json::json!({ "daemon_address": "https://n" })));

        // An empty ARRAY is not an empty object — a method taking positional
        // parameters would break if this started dropping it.
        assert!(!omit_empty_params(&serde_json::json!([])));
    }

    #[test]
    fn a_request_body_omits_empty_params_and_keeps_real_ones() {
        let none = jsonrpc_body("get_info", serde_json::Value::Null);
        assert!(
            none.get("params").is_none(),
            "a no-parameter method must not carry a params key at all"
        );
        assert_eq!(none["method"], "get_info");
        assert_eq!(none["jsonrpc"], "2.0");

        let empty = jsonrpc_body("get_version", serde_json::json!({}));
        assert!(empty.get("params").is_none());

        let real = jsonrpc_body("validate_address", serde_json::json!({ "address": "xel:x" }));
        assert_eq!(real["params"]["address"], "xel:x");
    }

    /// The node probe once built its own request body with a hardcoded empty
    /// `params`, so it failed against every healthy node while the wallet
    /// client worked. Pin the structural property — ONE body builder — rather
    /// than only the behaviour, because the bug was a second call site, not a
    /// wrong rule.
    #[test]
    fn only_one_place_in_this_module_builds_a_request_body() {
        let src = include_str!("xelis_rpc.rs");
        // Assembled at compile time so this test's own source does not contain
        // the contiguous needle and match itself.
        let needle = concat!("\"jsonrpc\"", ": ", "\"2.0\"");
        assert_eq!(
            src.matches(needle).count(),
            1,
            "every JSON-RPC request must go through jsonrpc_body(), which omits \
             an empty params object — a second hand-built body is how the node \
             probe came to fail against every healthy node"
        );
    }

    #[test]
    fn creds_file_round_trips_and_rejects_junk() {
        let dir = std::env::temp_dir().join(format!("pwnda-xelis-creds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("creds");
        write_creds_file(&p, 18087, "user", "pass");
        assert_eq!(read_creds_file(&p), Some((18087, "user".into(), "pass".into())));

        std::fs::write(&p, "not-a-port:user:pass").unwrap();
        assert_eq!(read_creds_file(&p), None);
        std::fs::write(&p, "18087::pass").unwrap();
        assert_eq!(read_creds_file(&p), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Every `xelis_wallet` this module launches must set its working directory,
/// and must be launched with `--config-file` and nothing else.
///
/// STRUCTURAL, not behavioural: it reads this file's own source, because a real
/// spawn needs an `AppHandle` and the binary. It guards two properties a new
/// spawn site would silently break — the working-directory rule from the
/// 2026-09-13 postmortem (engine wallets written into `src-tauri/`, relaunching
/// `tauri dev`), and the secrets-off-the-command-line rule that is the entire
/// reason this sidecar is configured by file.
#[cfg(test)]
mod spawn_tests {
    #[test]
    fn the_only_spawn_sets_cwd_and_passes_only_a_config_file() {
        let src = include_str!("xelis_rpc.rs");
        let body = &src[..src.find("mod spawn_tests").expect("this module")];

        // One spawn helper, used by both stages, so the rules hold everywhere.
        let spawns = body.matches("cmd.spawn()").count();
        assert_eq!(spawns, 1, "expected exactly one spawn site (the shared helper)");

        let helper = body
            .find("fn spawn_wallet(")
            .map(|i| &body[i..])
            .expect("spawn_wallet must exist");
        let helper = &helper[..helper.find("cmd.spawn()").expect("spawn in helper")];

        assert!(helper.contains(".current_dir(cwd)"), "the spawn must set current_dir");

        // Light client only: the binary spawned is the wallet, and the only
        // file taken out of the release archive is the wallet.
        assert!(body.contains("tokio::process::Command::new(binary)"));
        let daemon = ["xelis", "_daemon"].concat();
        let code: String = body
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains(&daemon),
            "this module must never name the full-node binary outside comments"
        );
        let extract = &body[body.find("fn extract_wallet_binary(").expect("extractor")..];
        assert!(extract.contains("ends_with(XELIS_BINARY_NAME)"));
        assert!(helper.contains("--config-file"), "the spawn must use --config-file");

        // No password, seed or credential may be handed to the process as an
        // argument. `.arg(` appears exactly twice: `--config-file` and its path.
        let args = helper.matches(".arg(").count();
        assert_eq!(
            args, 2,
            "the command line must be exactly `--config-file <path>` — anything else risks \
             putting a secret in the process list"
        );
    }
}
