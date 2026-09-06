//! Zano wallet-rpc sidecar manager.
//!
//! Third instance of the Pattern-A sidecar (`xmr_rpc.rs` :18082,
//! `zph_rpc.rs` :18083, this :18084 for the MAIN instance). Templated on
//! `zph_rpc.rs` — nothing else shares the MAIN Zano wallet, so there is
//! deliberately NO lease system on it (contrast `xmr_rpc.rs::XmrLease`,
//! which exists only because the atomic-swap engine can co-own the Monero
//! wallet).
//!
//! # Grove expansion plan, Phase C, unit C-RX — a SECOND instance, not a
//! # lease on the first
//!
//! Unlike XMR/ZEPH (one host-managed wallet-rpc PROCESS the swap engine and
//! the user's own panel both lease), Zano's wallet-rpc can serve only ONE
//! wallet per process (no `open_wallet`/`close_wallet`, no `--wallet-dir`
//! multi-wallet mode — see `ensure_wallet_file`'s doc comment) and the
//! engine's own joint-wallet primitive, `generate_from_keys`
//! (`upstream/patches/zano-0001-wallet-rpc-generate-from-keys.patch`), is
//! DESTRUCTIVE: it overwrites whatever account the target process is
//! currently serving. Aiming it at the user's own funded wallet would
//! destroy it. So Grove runs TWO separate `simplewallet` processes:
//!
//! | | port | binary | owner | lifecycle |
//! |---|---|---|---|---|
//! | **Main** | 18084 | stock (unmodified) release | the user's own wallet — this file's existing Stage A/B functions, unchanged | long-lived, started/stopped by the user's own Zano panel; the swap engine only ever READS it (port + JWT secret) — never opens, creates, or re-keys it |
//! | **Scratch** | 18086 | pwnda-built PATCHED release (`generate_from_keys` support — `scripts/swap/zano-build/`, plan unit A5) | the swap engine, exclusively | ephemeral: a fresh wallet file + a fresh JWT secret generated on every engine start (`zano_scratch_start`), both deleted on stop (`zano_scratch_stop`) — never reused across restarts, because a stale scratch account holding a joint address from a torn-down swap has nothing legitimate to protect by surviving |
//!
//! `upstream/patches/0015-zano-coin-module.patch`'s `ZanoInterface.__init__`
//! reads both as `rpc_wallet` (main, `walletrpcport`/`walletrpcjwt`) and
//! `rpc_wallet_scratch` (`scratchwalletrpcport`/`scratchwalletrpcjwt`) — see
//! that patch's own "SECOND wallet-rpc" comment for the full REU26-derived
//! rationale, and `swap_sidecar.rs`'s `apply_host_zano_wallet_to_config` /
//! `maybe_activate_zano_host_wallet` for where these two ports+secrets are
//! written into `basicswap.json` and how "Main confirmed before Scratch is
//! ever spun up" is enforced (Scratch's password can only be known once the
//! vault is unlocked in practice, but the ladder is enforced structurally,
//! not by timing: activation reads Main's live state and returns early —
//! never starting Scratch — whenever Main is not already running).
//!
//! Scratch DOES need its own tiny single-flight guard
//! (`ZanoScratchInner::starting`), for the identical "check-then-act race"
//! reason `xmr_rpc::XmrRpcInner::starting` / `zph_rpc::ZphLeaseState::starting`
//! exist — see either module's doc comments for the incident (two callers
//! both observing "not yet started" before either commits, both spawning a
//! competing process on the same port) this pattern closes. It is NOT a
//! lease SET, though: Scratch has exactly one caller (the swap engine), so
//! there is nothing to refcount — a plain `Option<Child>` plus the
//! single-flight flag is the whole of it, unlike XMR/ZEPH's `HashSet` of
//! lease-holders.
//!
//! TWO THINGS DIFFER FROM THE MONERO-LINEAGE SIDECARS, and both follow from
//! Zano being an independent CryptoNote implementation, not a Monero fork:
//!
//! 1. **Auth is JWT, not HTTP Digest.** `wallet_rpc_common::do_rpc_call_at`
//!    is hardwired to the 401-challenge Digest flow and is NOT reused here;
//!    its pidfile/port/log-tail/process helpers ARE. Zano's server
//!    (`wallet_rpc_server.cpp::auth_http_request`) requires an HS256 token in
//!    a `Zano-Access-Token` header carrying a `body_hash` claim (hex SHA-256
//!    of the request body — SHA-256, NOT keccak) and a single-use `salt`.
//!    Reused salts are rejected, so a fresh salt per request is mandatory.
//!    Upstream refuses to start an RPC server with no `--jwt-secret` unless
//!    `--unsecure-no-auth` is passed; we always pass a secret.
//!
//! 2. **Wallet creation/restore is CLI-only** — there is no RPC equivalent of
//!    Monero's `restore_deterministic_wallet`. Hence the two-stage lifecycle:
//!    `ensure_wallet_file` (Stage A, one-shot CLI) then `zano_start_rpc`
//!    (Stage B, long-lived server). Stage A drives the binary's interactive
//!    prompts over **piped stdin**, which is a supported upstream path rather
//!    than a hack: `password_container::read_input` branches on
//!    `is_cin_tty()` and falls back to reading `std::cin` when stdin is not a
//!    TTY — exactly the case for a spawned child.
//!
//! Every constant here is Phase-0 verified against
//! `simplewallet v2.2.1.506[b76fa18]`; see
//! `PwndaWalletVault/wiki/synthesis/zano-integration-plan.md` for the evidence.

use futures_util::StreamExt;
use sha2::{Digest as _, Sha256};
use std::io::Write as _;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

// `kill_pid_force` / `pid_image_name` / `find_pid_holding_port` come from
// `crate::platform` (2026-09-06): the `wallet_rpc_common` originals were
// Windows-only, and this file imported them unconditionally — which is how a
// Windows-only Zano wallet still broke the LINUX build (8 unresolved names,
// first Linux compile since May). `platform` carries both branches.
use crate::platform::{kill_pid_force, pid_image_name};
// Its only callers sit in Windows-gated code, so the import is gated to match —
// the Linux build warned it unused when it was not (2026-09-06).
#[cfg(target_os = "windows")]
use crate::platform::find_pid_holding_port;
use crate::wallet_rpc_common::{
    delete_pidfile, port_is_bound, random_hex, read_log_tail, read_pidfile,
    wait_for_port_free, write_pidfile, NodeProbeResult,
};

#[cfg(target_os = "windows")]
use crate::wallet_rpc_common::CREATE_NO_WINDOW;

// =========================================================================
// Constants — Phase-0 verified, not assumed
// =========================================================================

/// Main instance — the user's own, stock-binary wallet. `pub` (not just
/// crate-visible) because `swap_sidecar::maybe_activate_zano_host_wallet`
/// needs it to build the `walletrpcport` value it writes into
/// `basicswap.json` — mirrors [`crate::zph_rpc::ZPH_RPC_PORT`]'s visibility.
pub const ZANO_RPC_PORT: u16 = 18084;
const ZANO_RPC_URL: &str = "http://127.0.0.1:18084/json_rpc";

/// Scratch instance — the engine-owned, patched-binary wallet (see this
/// module's own doc comment, "a SECOND instance, not a lease on the
/// first"). `pub` for the same reason [`ZANO_RPC_PORT`] is.
pub const ZANO_SCRATCH_RPC_PORT: u16 = 18086;
const ZANO_SCRATCH_RPC_URL: &str = "http://127.0.0.1:18086/json_rpc";

#[cfg(target_os = "windows")]
const ZANO_BINARY_NAME: &str = "simplewallet.exe";
#[cfg(not(target_os = "windows"))]
const ZANO_BINARY_NAME: &str = "simplewallet";

/// Measured 16,963,968 B for v2.2.1.506. Guards against a truncated download
/// or a placeholder being mistaken for the real binary.
const REAL_BINARY_MIN_SIZE: u64 = 10 * 1024 * 1024;

const ZANO_WALLET_DIR_NAME: &str = "zano-wallets";
const ZANO_BINARY_DIR_NAME: &str = "zano";
const ZANO_WALLET_FILE_NAME: &str = "pwnda.zan";

/// Scratch instance — deliberately a SEPARATE directory tree from Main's,
/// both for the wallet file (so a bug can never resolve the wrong path and
/// hand `generate_from_keys` the user's real wallet) and for the binary
/// (the patched build must never be mistaken for, or accidentally shadow,
/// the stock one `zano_download_wallet_rpc` fetches for Main).
const ZANO_SCRATCH_WALLET_DIR_NAME: &str = "zano-scratch-wallets";
const ZANO_SCRATCH_BINARY_DIR_NAME: &str = "zano-scratch";
/// Fixed name, unlike Main's per-`WalletEntry` [`get_wallet_file`]: Scratch
/// is deleted and recreated fresh on every engine start (this module's own
/// doc comment), so there is never more than one on disk and nothing to
/// disambiguate between.
const ZANO_SCRATCH_WALLET_FILE_NAME: &str = "scratch.zan";

/// Header name upstream looks for (`wallet_rpc_server.h:16`).
const ZANO_ACCESS_TOKEN_HEADER: &str = "Zano-Access-Token";

/// Stage A is one-shot and can be slow on a cold filesystem; be generous.
const STAGE_A_TIMEOUT_MS: u64 = 120_000;
/// Stage B readiness budget, matching the XMR/ZEPH convention.
const READY_BUDGET_MS: u64 = 30_000;
const READY_POLL_MS: u64 = 250;

// =========================================================================
// Binary download — pinned release, SHA256 + PGP trust model
// =========================================================================
//
// Deliberately the STRONGER of the two precedents in this codebase (XMR's
// PGP+SHA256 model, not ZEPH's hash-only one) — see the integration plan's
// rationale. Unlike Monero/Zephyr, Zano's binaries are NOT GitHub-hosted:
// the GitHub release carries only PGP-signed release NOTES containing the
// hash; the actual ZIP lives on Zano's own build server. Verified 2026-08-27
// against the real v2.2.1.506 release page (raw HTML, not a summarized
// fetch, after an earlier summarized read mis-transcribed a checksum).
const ZANO_RELEASE_TAG: &str = "2.2.1.506";

// Windows only, deliberately. Zano's Windows release is a ZIP containing a
// bare `simplewallet.exe` — the same shape ZEPH's downloader already
// extracts from. Zano's Linux release is an AppImage (a different,
// self-contained format this project has not verified even CONTAINS a
// separately-extractable `simplewallet` binary vs. only the GUI app) — no
// Linux branch is shipped rather than guess at an unverified format. Add one
// once that's confirmed against a real AppImage.
const ZANO_ZIP_FILENAME: &str = "zano-win-x64-release-v2.2.1.506[b76fa18].zip";
const ZANO_ZIP_URL: &str =
    "https://build.zano.org/builds/zano-win-x64-release-v2.2.1.506%5Bb76fa18%5D.zip";
const ZANO_ZIP_SHA256: &str =
    "ab805baf58b78d3a4210ad85a9c74e8156746e1aebcb0a8a4dda32d0203cf87f";

#[derive(Clone, serde::Serialize)]
pub struct ZanoDownloadProgress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

// =========================================================================
// Per-session state
// =========================================================================

pub struct ZanoRpcInner {
    pub child: Option<tokio::process::Child>,
    /// Per-session HS256 secret handed to the sidecar via `--jwt-secret`.
    /// Regenerated on every start; mirrored beside the pidfile only so a
    /// crash-recovery reattach can still authenticate.
    pub jwt_secret: Option<String>,
}

impl Default for ZanoRpcInner {
    fn default() -> Self {
        Self {
            child: None,
            jwt_secret: None,
        }
    }
}

pub struct ZanoRpcChild(pub Mutex<ZanoRpcInner>);

impl Default for ZanoRpcChild {
    fn default() -> Self {
        Self(Mutex::new(ZanoRpcInner::default()))
    }
}

// =========================================================================
// C-RX — Scratch instance state (module-local static, NOT a field on
// `ZanoRpcInner`)
//
// Two reasons, both ported from `zph_rpc::ZPH_LEASE_STATE`'s own doc
// comment — see that module for the fuller version:
//
// 1. `ZanoRpcChild` is `tokio::sync::Mutex`-guarded (unlike `XmrRpcChild`/
//    `ZphRpcChild`'s `std::sync::Mutex`), and every existing Main call site
//    already awaits it. A `starting`-clearing `Drop` guard — the exact
//    mechanism that makes `xmr_start_rpc`/`zph_start_rpc`'s single-flight
//    claim reliable on every exit path, panics included — cannot run async
//    code, so it needs a lock it can take SYNCHRONOUSLY and have succeed.
//    `tokio::sync::Mutex::try_lock()` is sync but can spuriously fail under
//    contention, which would leave `starting` stuck `true` forever on
//    exactly the race this guard exists to close. A plain
//    `std::sync::Mutex` makes the `Drop` guard's `.lock()` infallible
//    (barring a poison, already handled below the same way every other
//    lock in this codebase handles one) instead of best-effort.
// 2. Staying out of `ZanoRpcInner` means this unit's OWNS (`zano_rpc.rs`,
//    plus two new `swap_sidecar.rs` functions) never has to touch
//    `lib.rs`'s `.manage(zano_rpc::ZanoRpcChild::default())` call — which
//    already works unchanged, `::default()` picks up nothing new.
// =========================================================================

static ZANO_SCRATCH_STATE: std::sync::OnceLock<std::sync::Mutex<ZanoScratchState>> =
    std::sync::OnceLock::new();

fn scratch_state() -> &'static std::sync::Mutex<ZanoScratchState> {
    ZANO_SCRATCH_STATE.get_or_init(|| std::sync::Mutex::new(ZanoScratchState::default()))
}

/// Scratch instance state. Not a lease SET like `XmrRpcInner::leases` /
/// `ZphLeaseState::leases`: Scratch has exactly one caller (the swap
/// engine — see this module's own top-of-file doc comment), so there is
/// nothing to refcount. `starting` still exists, guarding the identical
/// check-then-act race `xmr_rpc`/`zph_rpc` both close — see either's doc
/// comment for the incident this pattern is named after.
#[derive(Default)]
pub struct ZanoScratchState {
    pub child: Option<tokio::process::Child>,
    pub jwt_secret: Option<String>,
    /// True from the moment a caller has committed to spawning a fresh
    /// Scratch process until that attempt resolves, success or failure.
    pub starting: bool,
}

// =========================================================================
// JWT (HS256) — the piece with no XMR/ZEPH precedent
// =========================================================================

/// STANDARD base64 alphabet (`+`/`/`), padding stripped — NOT base64url.
///
/// Verified against the real binary 2026-08-27: upstream's JWT decode is
/// `jwt::base::decode<jwt::alphabet::base64>(jwt::base::pad<jwt::alphabet::base64>(str))`
/// — the STANDARD alphabet, re-padded before decoding. base64url output
/// (`-`/`_` instead of `+`/`/`) fails there with "Invalid input: not within
/// alphabet". This was shipped wrong in the first Phase 1 pass: the header
/// segment is a fixed string whose encoding happens not to contain `+`/`/`,
/// so `getbalance` calls with a favorable random payload passed while others
/// failed — a coin-flip pass rate that looked like flakiness rather than a
/// wrong alphabet. Caught only by hitting the real sidecar; the Rust unit
/// tests below could not have caught it, since none of them talk to a server.
fn b64std_nopad(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(data)
}

/// Build a `Zano-Access-Token` value for one request body.
///
/// Upstream verifies: HS256 signature over the secret, `body_hash` ==
/// hex(sha256(body)), and that `salt` has not been seen before. The salt is
/// what makes tokens single-use, so it MUST be fresh per call — reusing one
/// is an auth failure, not a cache hit.
fn build_jwt(secret: &str, body: &str) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};

    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    let salt = random_hex(16);

    let header = serde_json::json!({ "alg": "HS256", "typ": "JWT" });
    // Short-lived per upstream's own guidance. Upstream additionally tracks
    // salts for an hour, so replay is blocked even inside this window.
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("clock error: {}", e))?
        .as_secs()
        + 60;
    let payload = serde_json::json!({ "body_hash": body_hash, "salt": salt, "exp": exp });

    let signing_input = format!(
        "{}.{}",
        b64std_nopad(
            serde_json::to_string(&header)
                .map_err(|e| e.to_string())?
                .as_bytes()
        ),
        b64std_nopad(
            serde_json::to_string(&payload)
                .map_err(|e| e.to_string())?
                .as_bytes()
        )
    );

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes())
        .map_err(|e| format!("HMAC key error: {}", e))?;
    mac.update(signing_input.as_bytes());
    Ok(format!(
        "{}.{}",
        signing_input,
        b64std_nopad(&mac.finalize().into_bytes())
    ))
}

/// JSON-RPC call against a local Zano sidecar with JWT auth.
///
/// Deliberately NOT `wallet_rpc_common::do_rpc_call_at`: that helper does the
/// Digest 401-challenge dance on a raw socket because Epee's Digest nonces are
/// connection-scoped. JWT has no challenge round-trip — the token goes out with
/// the first request — so a pooled client is correct and simpler here.
///
/// `url` is a parameter (not the hardcoded `ZANO_RPC_URL`, as it was before
/// C-RX) so this one function serves BOTH instances — Main (`ZANO_RPC_URL`)
/// and Scratch (`ZANO_SCRATCH_RPC_URL`) — rather than a duplicated copy for
/// each; every call site now passes its own instance's URL explicitly.
async fn do_rpc_call_jwt(
    url: &str,
    secret: &str,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "0",
        "method": method,
        "params": params,
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let token = build_jwt(secret, &body_str)?;

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;

    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header(ZANO_ACCESS_TOKEN_HEADER, token)
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("Zano RPC request failed: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body failed: {}", e))?;

    if status == reqwest::StatusCode::UNAUTHORIZED {
        // Distinct from a transport error: the token was rejected (bad secret,
        // reused salt, or body-hash mismatch), which is a bug in this module
        // rather than a user-facing condition. Say so plainly.
        return Err("Zano RPC rejected the JWT (401) — secret/salt/body-hash mismatch".into());
    }
    if !status.is_success() {
        return Err(format!("Zano RPC HTTP {}: {}", status, text));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("bad JSON from Zano RPC: {} ({})", e, text))?;
    if let Some(err) = v.get("error") {
        if !err.is_null() {
            return Err(format!("Zano RPC error: {}", err));
        }
    }
    Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

// =========================================================================
// Paths
// =========================================================================

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))
}

fn get_wallet_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(ZANO_WALLET_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

/// Whether this install has any Main wallet file on disk — i.e. whether the
/// app is going to open one after unlock (`useZanoSession` does, on every
/// unlock, for every `zano` WalletEntry). Read-only: never creates the dir.
///
/// The swap-node supervisor asks this before deciding how long to wait for
/// Main at a start (2026-09-04): the app's Zano wallet comes up ~20 s after
/// unlock, the node's config was written 14 s after, and ZANO was parked for
/// the whole session on a machine that had the wallet all along.
pub fn main_wallet_present(app: &AppHandle) -> bool {
    let Ok(base) = app_dir(app) else { return false };
    let dir = base.join(ZANO_WALLET_DIR_NAME);
    match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .any(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)),
        Err(_) => false,
    }
}

/// Resolve the on-disk wallet file. `name` is the per-wallet filename the
/// vault stores on a `zano` WalletEntry (`sidecarFile`); `None` falls back to
/// the single fixed name Zano used before it became a `WalletKind`, so the
/// FIRST (migrated) Zano wallet keeps its existing file and never rescans —
/// the same arrangement `LEGACY_XMR_SIDECAR_FILE` / `LEGACY_ZPH_SIDECAR_FILE`
/// already use for Monero and Zephyr.
///
/// A traversal-safe basename is enforced here rather than at the call site:
/// this value crosses the invoke boundary, and `..` or a separator in it would
/// let a caller write outside the wallet directory.
fn get_wallet_file(app: &AppHandle, name: Option<&str>) -> Result<PathBuf, String> {
    let file = match name {
        Some(n) => {
            let n = n.trim();
            if n.is_empty()
                || n.contains('/')
                || n.contains('\\')
                || n.contains("..")
                || n.contains(':')
            {
                return Err(format!("Invalid Zano wallet filename: {:?}", n));
            }
            n.to_string()
        }
        None => ZANO_WALLET_FILE_NAME.to_string(),
    };
    Ok(get_wallet_dir(app)?.join(file))
}

fn get_zano_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(ZANO_BINARY_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

fn get_pidfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_zano_dir(app)?.join("zano-rpc.pid"))
}

fn get_secretfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_zano_dir(app)?.join("zano-rpc.jwt"))
}

fn get_log_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_zano_dir(app)?.join("zano-rpc.log"))
}

fn is_real_binary(p: &PathBuf) -> bool {
    std::fs::metadata(p)
        .map(|m| m.len() >= REAL_BINARY_MIN_SIZE)
        .unwrap_or(false)
}

/// Resolve `simplewallet[.exe]`, mirroring `xmr_rpc`/`zph_rpc`'s tiers so Zano is
/// as offline-reliable as Monero/Zephyr (2026-08-28 — Zano previously had ONLY
/// the app-data tier and otherwise download-on-demanded from build.zano.org,
/// which strands a user whose network blocks that host):
///
///   1. `<app_data>/zano/simplewallet[.exe]` — the live copy (downloaded,
///      updater-refreshed, bundle-extracted, or hand-dropped). Checked first so
///      a NEWER binary always beats the one frozen into the installer.
///   2. `<resource_dir>/binaries/simplewallet[.exe]` — a real binary dropped in
///      by hand (legacy/manual path).
///   3. `<resource_dir>/binaries/zano-simplewallet.gz` — the BUNDLED payload,
///      decompressed + SHA256-verified into app-data on first use, dormant until
///      the user opens the Zano section.
///   4. Otherwise `Err` — the caller falls back to `zano_download_wallet_rpc`.
fn resolve_rpc_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let p = get_zano_dir(app)?.join(ZANO_BINARY_NAME);
    if is_real_binary(&p) {
        return Ok(p);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let rp = resource_dir.join("binaries").join(ZANO_BINARY_NAME);
        if is_real_binary(&rp) {
            return Ok(rp);
        }
    }
    // Wake the dormant bundled payload.
    if let (Ok(resource_dir), Ok(dest)) = (app.path().resource_dir(), get_zano_dir(app)) {
        match crate::wallet_rpc_common::extract_bundled_sidecar(&resource_dir, &dest, "zano") {
            Ok(pp) if is_real_binary(&pp) => return Ok(pp),
            Ok(_) => {}
            Err(e) => eprintln!("[zano] bundled sidecar unavailable ({}), will download", e),
        }
    }
    Err(format!(
        "Zano wallet binary not found at {:?}. Download it first.",
        p
    ))
}

// =========================================================================
// C-RX — Scratch instance: paths + binary resolution
//
// Deliberately a SEPARATE tree from Main's above, not a parameterised reuse
// of it — see this module's own top-of-file doc comment for why the two
// binaries and wallet files must never be resolvable to the same path.
// =========================================================================

fn get_scratch_wallet_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(ZANO_SCRATCH_WALLET_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

fn get_scratch_wallet_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_scratch_wallet_dir(app)?.join(ZANO_SCRATCH_WALLET_FILE_NAME))
}

fn get_scratch_zano_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join(ZANO_SCRATCH_BINARY_DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create {:?}: {}", d, e))?;
    Ok(d)
}

fn get_scratch_pidfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_scratch_zano_dir(app)?.join("zano-scratch-rpc.pid"))
}

fn get_scratch_secretfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_scratch_zano_dir(app)?.join("zano-scratch-rpc.jwt"))
}

fn get_scratch_log_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_scratch_zano_dir(app)?.join("zano-scratch-rpc.log"))
}

/// Resolve the PATCHED `simplewallet[.exe]` Scratch requires
/// (`generate_from_keys` support — plan unit A5,
/// `scripts/swap/zano-build/`). Deliberately only TWO tiers, unlike Main's
/// [`resolve_rpc_binary`]'s four: there is no download-on-demand path for a
/// binary pwnda builds itself rather than fetches from a release URL (see
/// `interface/zano/core.py`'s `downloadCore`, which raises for the same
/// reason), and no bundled-payload tier either, because nothing bundles a
/// build that A5 has not produced on this machine yet — extracting a
/// nonexistent payload would only trade one clear error for a more
/// confusing one.
///
///   1. `<app_data>/zano-scratch/simplewallet[.exe]` — the built copy, once
///      A5 has produced one and it has been placed here (or a future
///      updater path lands it there).
///   2. `<resource_dir>/binaries/zano-scratch/simplewallet[.exe]` — bundled
///      into the installer once A5's build is wired into the release
///      pipeline.
///   3. Otherwise `Err`, naming A5 and the build script directly — the
///      exact "genuine network/server-side problem vs. a build that simply
///      has not happened yet on this machine" distinction A5's own log.md
///      entry documents (Docker's engine crash / MSVC's missing Boost),
///      so a caller sees why rather than a bare "not found".
fn resolve_scratch_rpc_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let p = get_scratch_zano_dir(app)?.join(ZANO_BINARY_NAME);
    if is_real_binary(&p) {
        return Ok(p);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let rp = resource_dir
            .join("binaries")
            .join("zano-scratch")
            .join(ZANO_BINARY_NAME);
        if is_real_binary(&rp) {
            return Ok(rp);
        }
    }
    // Tier 3 (2026-09-04): the swap engine's own `bin/zano/simplewallet` — the
    // Grove bundle ships unit A5's PATCHED build there (it is what the engine
    // itself would run under `manage_wallet_daemon`), and a dev checkout has
    // it at `.swap-sidecar-work/bin/zano/` via the dev-home junction. Neither
    // of the two tiers above exists on a dev install and nothing wrote them,
    // so ZANO parked on every start with "scratch binary not found" while the
    // right binary sat one directory over. Guarded against the one wrong
    // answer: the STOCK simplewallet the Main panel downloads (no
    // generate_from_keys) must never be used as Scratch — the same size as the
    // Main binary means it is the stock build, not the patched one.
    if let Ok(bin) = crate::swap_sidecar::bin_dir(app) {
        let gp = bin.join("zano").join(ZANO_BINARY_NAME);
        if is_real_binary(&gp) {
            let stock_len = app_dir(app)
                .ok()
                .and_then(|d| std::fs::metadata(d.join("zano").join(ZANO_BINARY_NAME)).ok())
                .map(|m| m.len());
            let grove_len = std::fs::metadata(&gp).ok().map(|m| m.len());
            if stock_len.is_some() && stock_len == grove_len {
                return Err(format!(
                    "the swap engine's {:?} is the STOCK simplewallet (same size as the Main                      panel's) — it lacks generate_from_keys and cannot be the Scratch wallet;                      rebuild unit A5 (scripts/swap/zano-build/README.md)",
                    gp
                ));
            }
            return Ok(gp);
        }
    }
    Err(format!(
        "Zano SCRATCH wallet binary (the patched build with generate_from_keys          support) not found at {:?}, nor under the app resources, nor as the swap          engine's own bin/zano/simplewallet. This is a different binary from the          stock one the Main wallet panel downloads — see          scripts/swap/zano-build/README.md and Grove expansion plan unit A5          (PwndaWalletVault/wiki/synthesis/grove-expansion-master-plan.md) to          build it, then place it at that path.",
        p
    ))
}

// =========================================================================
// Stage A — CLI wallet creation / restore (no daemon, no network)
// =========================================================================

/// Ensure a wallet file exists, creating or restoring it via a one-shot CLI
/// invocation. Returns `true` if it had to create one.
///
/// Upstream constraints this encodes, all Phase-0 verified:
/// * `--restore-wallet` **fails outright if the target file already exists**,
///   so any self-heal path must delete first — hence `force_recreate` removes
///   the file rather than relying on overwrite semantics.
/// * `--password` suppresses the interactive wallet-password prompt entirely.
/// * `--offline-mode` means this stage needs no daemon and no network at all.
/// * Remaining prompts (seed phrase, then the seed passphrase *only if* the
///   seed is password-protected) are read from piped stdin, one line each.
pub async fn ensure_wallet_file(
    app: &AppHandle,
    wallet_password: &str,
    seed_phrase: Option<&str>,
    seed_passphrase: Option<&str>,
    force_recreate: bool,
    wallet_file_name: Option<&str>,
) -> Result<bool, String> {
    let wallet_file = get_wallet_file(app, wallet_file_name)?;

    if force_recreate && wallet_file.exists() {
        // Delete the whole set: upstream writes siblings beside the wallet.
        for suffix in ["", ".address.txt", ".bak"] {
            let p = PathBuf::from(format!("{}{}", wallet_file.display(), suffix));
            let _ = std::fs::remove_file(&p);
        }
    }
    if wallet_file.exists() {
        return Ok(false);
    }

    let binary = resolve_rpc_binary(app)?;
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("--password")
        .arg(wallet_password)
        .arg("--offline-mode");

    match seed_phrase {
        Some(_) => {
            cmd.arg("--restore-wallet").arg(&wallet_file);
        }
        None => {
            cmd.arg("--generate-new-wallet").arg(&wallet_file);
        }
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Zano wallet (stage A): {}", e))?;

    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().ok_or("stage A: no stdin handle")?;
        let mut script = String::new();
        if let Some(seed) = seed_phrase {
            script.push_str(seed.trim());
            script.push('\n');
            // Consumed only when the seed is password-protected; upstream
            // self-detects via `is_seed_password_protected` before prompting.
            // An unconditional line is safe: with no prompt it lands in the
            // command loop, and `exit` follows immediately.
            script.push_str(seed_passphrase.unwrap_or(""));
            script.push('\n');
        }
        script.push_str("exit\n");
        stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|e| format!("stage A stdin: {}", e))?;
        let _ = stdin.flush().await;
        drop(stdin);
    }

    let out = tokio::time::timeout(
        std::time::Duration::from_millis(STAGE_A_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "Zano wallet creation timed out (stage A)".to_string())?
    .map_err(|e| format!("stage A wait failed: {}", e))?;

    if !wallet_file.exists() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "Zano wallet was not created.\nstdout: {}\nstderr: {}",
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(true)
}

// =========================================================================
// Stage B — long-lived RPC server
// =========================================================================

#[tauri::command]
pub async fn zano_start_rpc(
    app: AppHandle,
    daemon_address: String,
    wallet_password: String,
    wallet_file: Option<String>,
) -> Result<(), String> {
    let state = app.state::<ZanoRpcChild>();

    {
        let inner = state.0.lock().await;
        if inner.child.is_some() {
            return Ok(());
        }
    }

    reap_stale_process(&app).await;

    // If something STILL holds the RPC port after reaping, spawning would either
    // fail to bind or — worse — leave the probe talking to a foreign process
    // whose JWT secret we do not know, i.e. the exact "invalid signature" dead
    // end reap_stale_process now targets. Fail with a clear message instead of
    // that 30s timeout.
    if port_is_bound(ZANO_RPC_PORT).await {
        return Err(format!(
            "Zano RPC port {} is still in use by another process after cleanup. \
             Close any stray Zano wallet, or reboot, then retry.",
            ZANO_RPC_PORT
        ));
    }

    let wallet_file = get_wallet_file(&app, wallet_file.as_deref())?;
    if !wallet_file.exists() {
        return Err("No Zano wallet file. Run the import/create flow first.".into());
    }

    let binary = resolve_rpc_binary(&app)?;
    let log_file = get_log_file(&app)?;
    let jwt_secret = random_hex(32);

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("--wallet-file")
        .arg(&wallet_file)
        .arg("--password")
        .arg(&wallet_password)
        .arg("--rpc-bind-ip")
        .arg("127.0.0.1")
        .arg("--rpc-bind-port")
        .arg(ZANO_RPC_PORT.to_string())
        .arg("--jwt-secret")
        .arg(&jwt_secret)
        .arg("--daemon-address")
        .arg(&daemon_address)
        .arg("--log-file")
        .arg(&log_file)
        .arg("--log-level")
        .arg("0");

    // NOTE: `--do-pos-mining` is deliberately absent and must stay absent.
    // Staking is an explicit non-goal; its ABSENCE is the kill switch, because
    // upstream provides no separate disable flag.

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = cmd.spawn().map_err(|e| {
        // A missing VC++ runtime surfaces here as STATUS_DLL_NOT_FOUND. The
        // upstream ZIP bundles 2016-era runtime DLLs and omits
        // VCRUNTIME140_1.dll entirely, so "copy the DLLs from the archive" is
        // NOT a valid fix — the user needs the redistributable itself.
        // 126 = ERROR_MOD_NOT_FOUND (Win32, the usual CreateProcess failure)
        // -1073741515 = 0xC0000135 STATUS_DLL_NOT_FOUND (NTSTATUS form)
        if matches!(e.raw_os_error(), Some(126) | Some(-1073741515)) {
            "Zano wallet could not start: the Microsoft Visual C++ Redistributable \
             (2015-2022, x64) appears to be missing."
                .to_string()
        } else {
            format!("Failed to spawn Zano wallet-rpc: {}", e)
        }
    })?;

    if let Some(pid) = child.id() {
        if let Ok(p) = get_pidfile(&app) {
            write_pidfile(&p, pid);
        }
    }
    if let Ok(p) = get_secretfile(&app) {
        let _ = std::fs::write(p, &jwt_secret);
    }

    {
        let mut inner = state.0.lock().await;
        inner.child = Some(child);
        inner.jwt_secret = Some(jwt_secret.clone());
    }

    // Readiness: poll a cheap AUTHENTICATED method, so we prove both that the
    // server is listening and that our JWT is accepted. A bare port check would
    // go green on a server that rejects every call we make.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(READY_BUDGET_MS);
    loop {
        if do_rpc_call_jwt(
            ZANO_RPC_URL,
            &jwt_secret,
            "getaddress",
            serde_json::json!({}),
            std::time::Duration::from_millis(2_000),
        )
        .await
        .is_ok()
        {
            return Ok(());
        }

        {
            let mut inner = state.0.lock().await;
            let exited = match inner.child.as_mut() {
                Some(c) => c.try_wait().ok().flatten(),
                None => None,
            };
            if let Some(status) = exited {
                inner.child = None;
                drop(inner);
                let tail = get_log_file(&app)
                    .map(|p| read_log_tail(&p, 4096))
                    .unwrap_or_default();
                return Err(format!(
                    "Zano wallet-rpc exited during startup ({}). Log tail:\n{}",
                    status, tail
                ));
            }
        }

        if std::time::Instant::now() >= deadline {
            let tail = get_log_file(&app)
                .map(|p| read_log_tail(&p, 4096))
                .unwrap_or_default();
            let _ = zano_stop_rpc(app.clone()).await;
            return Err(format!(
                "Zano wallet-rpc did not become ready in {} ms. Log tail:\n{}",
                READY_BUDGET_MS, tail
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(READY_POLL_MS)).await;
    }
}

#[tauri::command]
pub async fn zano_rpc_call(
    app: AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<ZanoRpcChild>();
    let in_memory = {
        let inner = state.0.lock().await;
        inner.jwt_secret.clone()
    };
    let secret = in_memory
        .or_else(|| {
            get_secretfile(&app)
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok())
        })
        .ok_or("Zano RPC is not running (no JWT secret)")?;

    do_rpc_call_jwt(ZANO_RPC_URL, &secret, &method, params, std::time::Duration::from_secs(120)).await
}

#[tauri::command]
pub async fn zano_stop_rpc(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ZanoRpcChild>();

    // Ask it to persist and close cleanly before killing: an abrupt kill during
    // a wallet write is how wallet files get corrupted, which then costs a full
    // rescan on next open.
    let secret = {
        let inner = state.0.lock().await;
        inner.jwt_secret.clone()
    };
    if let Some(secret) = secret {
        let _ = do_rpc_call_jwt(
            ZANO_RPC_URL,
            &secret,
            "store",
            serde_json::json!({}),
            std::time::Duration::from_millis(5_000),
        )
        .await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    {
        let mut inner = state.0.lock().await;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill().await;
        }
        inner.jwt_secret = None;
    }

    if let Ok(p) = get_pidfile(&app) {
        delete_pidfile(&p);
    }
    if let Ok(p) = get_secretfile(&app) {
        let _ = std::fs::remove_file(p);
    }
    wait_for_port_free(ZANO_RPC_PORT, 5_000).await;
    Ok(())
}

/// Thin command wrapper over [`ensure_wallet_file`].
///
/// Kept separate from the impl so the self-heal path inside this module can
/// call the Rust function directly (with `force_recreate`) without going back
/// out through the invoke boundary.
#[tauri::command]
pub async fn zano_ensure_wallet(
    app: AppHandle,
    wallet_password: String,
    seed_phrase: Option<String>,
    seed_passphrase: Option<String>,
    force_recreate: Option<bool>,
    wallet_file: Option<String>,
) -> Result<bool, String> {
    ensure_wallet_file(
        &app,
        &wallet_password,
        seed_phrase.as_deref(),
        seed_passphrase.as_deref(),
        force_recreate.unwrap_or(false),
        wallet_file.as_deref(),
    )
    .await
}

/// Has this app spawned a Zano wallet-rpc child?
///
/// TRUE the moment the process is launched, and long before its port answers —
/// which is the distinction [`crate::swap_sidecar::zano_warmup_plan`] needs.
/// `zano_rpc_is_running` deliberately requires BOTH this and a bound port,
/// because for "is the wallet usable" a launched-but-not-listening process is
/// not running. For "is a wallet on its way", it is exactly the signal.
pub async fn zano_rpc_child_spawned(app: &AppHandle) -> bool {
    let state = app.state::<ZanoRpcChild>();
    let inner = state.0.lock().await;
    inner.child.is_some()
}

#[tauri::command]
pub async fn zano_rpc_is_running(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<ZanoRpcChild>();
    let has_child = {
        let inner = state.0.lock().await;
        inner.child.is_some()
    };
    Ok(has_child && port_is_bound(ZANO_RPC_PORT).await)
}

/// Probe a Zano daemon's JSON-RPC `getinfo`.
///
/// Deliberately NOT `wallet_rpc_common::probe_node`, which GETs
/// `<url>/get_info` — a Monero-family REST convention. Zano's daemon has no
/// such REST endpoint (verified live 2026-08-27: `GET /get_info` -> 404
/// against the public node). Zano's daemon RPC is JSON-RPC-only, same shape
/// as the wallet-rpc: POST `<url>/json_rpc` with `{"method":"getinfo"}`. Also
/// unlike Digest-authed wallet-rpc, this endpoint takes no auth, so a plain
/// `reqwest` POST (not `do_rpc_call_jwt`, which signs for the WALLET secret)
/// is correct here.
#[tauri::command]
pub async fn zano_probe_node(url: String, timeout_ms: u64) -> Result<NodeProbeResult, String> {
    let clean_url = url.trim_end_matches('/').trim_end_matches("/json_rpc").to_string();
    let endpoint = format!("{}/json_rpc", clean_url);
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": "0", "method": "getinfo", "params": {}
    });

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(NodeProbeResult {
                url,
                ok: false,
                latency_ms: None,
                height: None,
                error: Some(format!("client build: {}", e)),
            });
        }
    };

    let start = std::time::Instant::now();
    let resp = match client.post(&endpoint).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "timeout".to_string()
            } else if e.is_connect() {
                "connect failed".to_string()
            } else {
                format!("{}", e)
            };
            return Ok(NodeProbeResult {
                url,
                ok: false,
                latency_ms: None,
                height: None,
                error: Some(msg),
            });
        }
    };
    let latency_ms = start.elapsed().as_millis() as u32;
    let status = resp.status();
    if !status.is_success() {
        return Ok(NodeProbeResult {
            url,
            ok: false,
            latency_ms: Some(latency_ms),
            height: None,
            error: Some(format!("HTTP {}", status.as_u16())),
        });
    }

    let text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return Ok(NodeProbeResult {
                url,
                ok: false,
                latency_ms: Some(latency_ms),
                height: None,
                error: Some(format!("read body: {}", e)),
            });
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return Ok(NodeProbeResult {
                url,
                ok: false,
                latency_ms: Some(latency_ms),
                height: None,
                error: Some(format!("bad JSON: {}", e)),
            });
        }
    };
    if let Some(err) = parsed.get("error") {
        if !err.is_null() {
            return Ok(NodeProbeResult {
                url,
                ok: false,
                latency_ms: Some(latency_ms),
                height: None,
                error: Some(format!("RPC error: {}", err)),
            });
        }
    }
    let height = parsed
        .get("result")
        .and_then(|r| r.get("height"))
        .and_then(|h| h.as_u64());

    Ok(NodeProbeResult {
        url,
        ok: true,
        latency_ms: Some(latency_ms),
        height,
        error: None,
    })
}

/// Download, verify, and extract `simplewallet.exe` from the pinned Zano
/// release ZIP.
///
/// Error taxonomy is DELIBERATE, not incidental — three distinct failure
/// modes, each with a distinguishable message the frontend can match on
/// (mirroring `zano_start_rpc`'s missing-DLL detection):
///   - `"Download blocked:"` — the connection itself failed. Verified
///     firsthand 2026-08-27: a security filter on the dev network blocked
///     `build.zano.org` specifically (a SafeBrowse interstitial on plain
///     HTTP, a stalled TLS handshake on HTTPS) while every other host,
///     including GitHub and Monero's own download host, passed through
///     unaffected. This is NOT hypothetical UI copy — it happened, and the
///     fix was fetching the file out-of-band and hash-verifying it, not
///     retrying. The message says so and offers that path.
///   - `"SHA256 mismatch"` — the pinned hash doesn't match what was
///     downloaded. Either the constant is stale (a new release shipped) or
///     the transfer was corrupted/tampered. Never silently accept.
///   - Anything else (HTTP error status, zip-extraction failure) is a
///     genuine network/server-side problem, reported as-is.
///
/// A caller must NEVER collapse these into one generic "download failed" —
/// that was explicitly called out as a design requirement in the
/// integration plan after the network-filter incident, precisely because
/// "retry" is the right UI action for one of these and the wrong action for
/// the other two.
#[tauri::command]
pub async fn zano_download_wallet_rpc(app: AppHandle) -> Result<(), String> {
    let zano_dir = get_zano_dir(&app)?;
    let exe_path = zano_dir.join(ZANO_BINARY_NAME);

    if is_real_binary(&exe_path) {
        let _ = app.emit(
            "zano-download-progress",
            ZanoDownloadProgress {
                stage: "complete".to_string(),
                percent: 100.0,
                message: "simplewallet.exe already present".to_string(),
            },
        );
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let _ = app.emit(
        "zano-download-progress",
        ZanoDownloadProgress {
            stage: "downloading".to_string(),
            percent: 0.0,
            message: format!(
                "Downloading {} ({})…",
                ZANO_ZIP_FILENAME, ZANO_RELEASE_TAG
            ),
        },
    );

    let response = client.get(ZANO_ZIP_URL).send().await.map_err(|e| {
        format!(
            "Download blocked: could not reach build.zano.org ({}). This has been              observed as a network-level block on some connections — the connection              itself fails before any HTTP response, distinct from a slow or missing              server. If this persists, download the ZIP from https://zano.org on a              different network, verify its SHA256 is {}, then place              simplewallet.exe at {}.",
            e,
            ZANO_ZIP_SHA256,
            exe_path.display()
        )
    })?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {} from {}",
            response.status(),
            ZANO_ZIP_URL
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    let zip_path = zano_dir.join(ZANO_ZIP_FILENAME);
    let mut file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            format!(
                "Download blocked: connection dropped mid-transfer ({}). {} bytes were                  received before the drop — likely the same network-level interference                  as a failed connection, just later in the stream.",
                e, downloaded
            )
        })?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        let percent = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit(
            "zano-download-progress",
            ZanoDownloadProgress {
                stage: "downloading".to_string(),
                percent,
                message: format!(
                    "Downloading simplewallet.exe — {:.1}/{:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            },
        );
    }
    drop(file);

    let actual_hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    if actual_hash != ZANO_ZIP_SHA256 {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!(
            "SHA256 mismatch for {} — expected {}, got {}. Download aborted before              extraction. Either the pinned constant in src-tauri/src/zano_rpc.rs is              stale (a new Zano release was cut and this build wasn't updated) or the              ZIP was corrupted or tampered with in transit. Do not retry blindly —              confirm the correct hash from a fresh PGP-signed Zano release page first.",
            ZANO_ZIP_FILENAME, ZANO_ZIP_SHA256, actual_hash
        ));
    }

    let _ = app.emit(
        "zano-download-progress",
        ZanoDownloadProgress {
            stage: "extracting".to_string(),
            percent: 0.0,
            message: "Extracting simplewallet.exe…".to_string(),
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
        if entry.name().ends_with(ZANO_BINARY_NAME) {
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
            ZANO_BINARY_NAME
        ));
    }

    crate::sidecar_update::set_installed_version(&zano_dir, ZANO_RELEASE_TAG);

    let _ = app.emit(
        "zano-download-progress",
        ZanoDownloadProgress {
            stage: "complete".to_string(),
            percent: 100.0,
            message: "simplewallet.exe ready".to_string(),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn zano_binary_status(app: AppHandle) -> Result<bool, String> {
    Ok(resolve_rpc_binary(&app).is_ok())
}

/// Kill a sidecar left behind by a previous run (crash, hard shutdown).
/// Image-name filtered so we can never kill an unrelated process that has
/// simply inherited the recorded PID.
async fn reap_stale_process(app: &AppHandle) {
    // 1. Fast path: kill the PID we recorded, if it is still a Zano wallet.
    if let Ok(pidfile) = get_pidfile(app) {
        if let Some(pid) = read_pidfile(&pidfile) {
            if let Some(image) = pid_image_name(pid).await {
                if image.eq_ignore_ascii_case(ZANO_BINARY_NAME) {
                    let _ = kill_pid_force(pid).await;
                }
            }
            delete_pidfile(&pidfile);
        }
    }

    // 2. Kill an orphan the pidfile MISSED. A wallet-rpc that outlived its
    //    pidfile (a crash, a hard app exit, a session whose pidfile was lost)
    //    keeps squatting ZANO_RPC_PORT with its OLD `--jwt-secret`. The next
    //    start mints a FRESH secret; every request the readiness probe signs
    //    with it is rejected by that orphan with "Invalid JWT token: invalid
    //    signature" (wallet_rpc_server.cpp auth_http_request), so the node
    //    never becomes ready and the user sees a stack-trace error. This is the
    //    same orphan class as the Monero/Zephyr sidecars (U-4/U-5). Image-check
    //    the port owner so we NEVER kill an unrelated process that happens to
    //    hold 18084.
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = find_pid_holding_port(ZANO_RPC_PORT).await {
            let is_ours = pid_image_name(pid)
                .await
                .map(|img| img.eq_ignore_ascii_case(ZANO_BINARY_NAME))
                .unwrap_or(false);
            if is_ours {
                let _ = kill_pid_force(pid).await;
            }
        }
    }

    // 3. Stale per-session secret file.
    if let Ok(p) = get_secretfile(app) {
        let _ = std::fs::remove_file(p);
    }

    // 4. Confirm the port is actually free before the caller spawns.
    wait_for_port_free(ZANO_RPC_PORT, 5_000).await;
}

// =========================================================================
// C-RX — Scratch instance lifecycle (Grove expansion plan, Phase C)
//
// The engine-owned twin of the Stage A/B pair above, spawning the PATCHED
// binary on [`ZANO_SCRATCH_RPC_PORT`] instead — never exposed as a
// `#[tauri::command]` (no frontend surface calls it, only
// `swap_sidecar::maybe_activate_zano_host_wallet`, as a direct Rust call —
// this unit's OWNS does not include `lib.rs`'s `invoke_handler!`
// registration, the same reasoning `zph_rpc::zph_start_rpc`'s own doc
// comment gives for why `ZphLease::SwapEngine` never needs a new command).
// =========================================================================

/// What [`zano_scratch_start`] should do, given the state read under ONE
/// lock acquisition. Mirrors `zph_rpc::ZphStartDecision` / `xmr_rpc::XmrStartDecision`
/// exactly (same three-way branch, same reasoning) — see either for the
/// full incident this closes.
#[derive(Debug, PartialEq, Eq)]
pub enum ZanoScratchStartDecision {
    /// A process already exists — hand back its recorded secret, spawn nothing.
    AlreadyRunning,
    /// Another caller is mid-spawn — back off rather than race it.
    AlreadyStarting,
    /// Neither running nor starting — this caller claims it and spawns.
    ShouldSpawn,
}

/// Pure — no I/O, no lock of its own — so it is unit-testable directly, the
/// same way `zph_rpc::decide_zph_start` is.
pub fn decide_zano_scratch_start(child_running: bool, starting: bool) -> ZanoScratchStartDecision {
    if child_running {
        ZanoScratchStartDecision::AlreadyRunning
    } else if starting {
        ZanoScratchStartDecision::AlreadyStarting
    } else {
        ZanoScratchStartDecision::ShouldSpawn
    }
}

/// What [`maybe_activate_zano_host_wallet`] (in `swap_sidecar.rs`) actually
/// needs handed back: the port (always [`ZANO_SCRATCH_RPC_PORT`], but
/// returned rather than assumed so the caller never has to import the
/// constant just to echo it) and the fresh JWT secret this start minted.
#[derive(Debug, Clone)]
pub struct ZanoScratchStarted {
    pub port: u16,
    pub jwt_secret: String,
}

/// Delete the Scratch wallet file and its siblings, unconditionally. Called
/// on every Scratch start (before creating a fresh one — "never reused
/// across restarts", this unit's own brief) AND on every stop, so a file is
/// never left behind describing an account [`generate_from_keys`] may have
/// already overwritten mid-swap.
fn delete_scratch_wallet_files(app: &AppHandle) -> Result<(), String> {
    let wallet_file = get_scratch_wallet_file(app)?;
    for suffix in ["", ".address.txt", ".bak"] {
        let p = PathBuf::from(format!("{}{}", wallet_file.display(), suffix));
        let _ = std::fs::remove_file(&p);
    }
    Ok(())
}

/// Stage A for Scratch: always a brand-new wallet (never a restore — a
/// throwaway account whose only purpose is to have SOMETHING open when
/// Stage B starts; the engine's own [`generate_from_keys`] call overwrites
/// it per-swap, per `upstream/patches/0015-zano-coin-module.patch`'s
/// `createWallet`). Mints and returns its own fresh CLI wallet-file
/// password — Scratch has no persistent identity for a caller to need this
/// value again after this call returns it into [`zano_scratch_start`]'s
/// own `--password` argument for Stage B.
/// Random bytes in the Scratch wallet's generated password; hex-encoded, so the
/// password is twice this in characters. Must stay ≤ 20 bytes (40 chars): see
/// `ensure_scratch_wallet_file`.
pub const ZANO_SCRATCH_PASSWORD_BYTES: usize = 16;

#[cfg(test)]
mod scratch_password_tests {
    use super::*;

    /// simplewallet refuses passwords longer than 40 characters when creating a
    /// wallet (measured 2026-09-05, patched and stock 2.2.1.506); `random_hex(n)`
    /// yields 2n characters.
    #[test]
    fn generated_scratch_password_fits_simplewallets_limit() {
        assert!(ZANO_SCRATCH_PASSWORD_BYTES * 2 <= 40);
        assert!(ZANO_SCRATCH_PASSWORD_BYTES >= 12, "keep it a real secret");
        assert_eq!(random_hex(ZANO_SCRATCH_PASSWORD_BYTES).len(), ZANO_SCRATCH_PASSWORD_BYTES * 2);
    }
}

async fn ensure_scratch_wallet_file(
    app: &AppHandle,
    binary: &std::path::Path,
) -> Result<(PathBuf, String), String> {
    let wallet_file = get_scratch_wallet_file(app)?;
    delete_scratch_wallet_files(app)?;

    // 32 hex chars, NOT 48 (2026-09-05). Zano's simplewallet caps a NEW
    // wallet's password at 40 characters and reports the overflow as
    // "Provided password contains invalid characters. Only letters, numbers and
    // ~!?@#$%^&*_+|{}[]()<>:;\"'-=/., symbols are allowed." — a message about
    // the alphabet for a rule about length. Measured on both the patched and
    // the stock 2.2.1.506 binaries: 6/16/32/40 hex generate, 48 hex refuses.
    // `random_hex(24)` produced 48 and every Scratch start failed at stage A,
    // which parked ZANO for the session with that sentence on the DEX row.
    let wallet_password = random_hex(ZANO_SCRATCH_PASSWORD_BYTES);

    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("--password")
        .arg(&wallet_password)
        .arg("--offline-mode")
        .arg("--generate-new-wallet")
        .arg(&wallet_file);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Zano scratch wallet (stage A): {}", e))?;

    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().ok_or("scratch stage A: no stdin handle")?;
        stdin
            .write_all(b"exit\n")
            .await
            .map_err(|e| format!("scratch stage A stdin: {}", e))?;
        let _ = stdin.flush().await;
        drop(stdin);
    }

    let out = tokio::time::timeout(
        std::time::Duration::from_millis(STAGE_A_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "Zano scratch wallet creation timed out (stage A)".to_string())?
    .map_err(|e| format!("scratch stage A wait failed: {}", e))?;

    if !wallet_file.exists() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "Zano scratch wallet was not created.\nstdout: {}\nstderr: {}",
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok((wallet_file, wallet_password))
}

/// Kill a Scratch sidecar left behind by a previous run. Mirrors
/// [`reap_stale_process`] exactly, targeting [`ZANO_SCRATCH_RPC_PORT`] and
/// the scratch pidfile/secretfile instead of Main's.
async fn reap_stale_scratch_process(app: &AppHandle) {
    if let Ok(pidfile) = get_scratch_pidfile(app) {
        if let Some(pid) = read_pidfile(&pidfile) {
            if let Some(image) = pid_image_name(pid).await {
                if image.eq_ignore_ascii_case(ZANO_BINARY_NAME) {
                    let _ = kill_pid_force(pid).await;
                }
            }
            delete_pidfile(&pidfile);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = find_pid_holding_port(ZANO_SCRATCH_RPC_PORT).await {
            let is_ours = pid_image_name(pid)
                .await
                .map(|img| img.eq_ignore_ascii_case(ZANO_BINARY_NAME))
                .unwrap_or(false);
            if is_ours {
                let _ = kill_pid_force(pid).await;
            }
        }
    }

    if let Ok(p) = get_scratch_secretfile(app) {
        let _ = std::fs::remove_file(p);
    }

    wait_for_port_free(ZANO_SCRATCH_RPC_PORT, 5_000).await;
}

/// Start (or attach to) the Scratch wallet-rpc — the engine-owned twin of
/// [`zano_start_rpc`]. Only ever called from `swap_sidecar::maybe_activate_zano_host_wallet`,
/// and only AFTER that function has confirmed Main is already running (the
/// "ladder ordering" this unit's own brief names) — this function itself
/// does not know or care about Main; it is unconditionally safe to call in
/// isolation, same as `zph_start_rpc` is safe to call without an opinion on
/// XMR's state.
pub async fn zano_scratch_start(
    app: &AppHandle,
    daemon_address: &str,
) -> Result<ZanoScratchStarted, String> {
    // PWNDA-SINGLE-FLIGHT — see the module-local static's own doc comment
    // for why this lock is `std::sync::Mutex`, not the `tokio::sync::Mutex`
    // Main's state uses.
    {
        let mut st = scratch_state()
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        match decide_zano_scratch_start(st.child.is_some(), st.starting) {
            ZanoScratchStartDecision::AlreadyRunning => {
                return match st.jwt_secret.clone() {
                    Some(secret) => Ok(ZanoScratchStarted {
                        port: ZANO_SCRATCH_RPC_PORT,
                        jwt_secret: secret,
                    }),
                    // A running child with no recorded secret cannot happen
                    // on any path this module writes — fail loudly rather
                    // than hand back an unusable credential if it somehow
                    // did.
                    None => Err(
                        "Zano scratch wallet-rpc is running but has no recorded \
                         JWT secret — refusing to report it ready"
                            .to_string(),
                    ),
                };
            }
            ZanoScratchStartDecision::AlreadyStarting => {
                return Err(
                    "a Zano scratch wallet-rpc start is already in progress".to_string(),
                );
            }
            ZanoScratchStartDecision::ShouldSpawn => {
                st.starting = true;
            }
        }
    }

    // Drop guard: whichever way this function exits from here on, `starting`
    // must go back to `false` — mirrors `xmr_start_rpc`'s `StartingClaim`,
    // reliable here (unlike a `tokio::sync::Mutex::try_lock`) because the
    // module-local static is a plain `std::sync::Mutex`.
    struct StartingClaim;
    impl Drop for StartingClaim {
        fn drop(&mut self) {
            if let Ok(mut st) = scratch_state().lock() {
                st.starting = false;
            }
        }
    }
    let _claim = StartingClaim;

    reap_stale_scratch_process(app).await;
    if port_is_bound(ZANO_SCRATCH_RPC_PORT).await {
        return Err(format!(
            "Zano scratch RPC port {} is still in use by another process after \
             cleanup.",
            ZANO_SCRATCH_RPC_PORT
        ));
    }

    let binary = resolve_scratch_rpc_binary(app)?;

    // "never reused across restarts": a fresh wallet file every start,
    // unconditionally — not only when one happens to be missing.
    let (wallet_file, wallet_password) = ensure_scratch_wallet_file(app, &binary).await?;

    let log_file = get_scratch_log_file(app)?;
    let jwt_secret = random_hex(32);

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("--wallet-file")
        .arg(&wallet_file)
        .arg("--password")
        .arg(&wallet_password)
        .arg("--rpc-bind-ip")
        .arg("127.0.0.1")
        .arg("--rpc-bind-port")
        .arg(ZANO_SCRATCH_RPC_PORT.to_string())
        .arg("--jwt-secret")
        .arg(&jwt_secret)
        .arg("--daemon-address")
        .arg(daemon_address)
        .arg("--log-file")
        .arg(&log_file)
        .arg("--log-level")
        .arg("0");

    // Same kill switch as Main — see `zano_start_rpc`'s identical note.
    // Staking has no role on a throwaway per-swap wallet either.

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = cmd.spawn().map_err(|e| {
        if matches!(e.raw_os_error(), Some(126) | Some(-1073741515)) {
            "Zano scratch wallet could not start: the Microsoft Visual C++ \
             Redistributable (2015-2022, x64) appears to be missing."
                .to_string()
        } else {
            format!("Failed to spawn Zano scratch wallet-rpc: {}", e)
        }
    })?;

    if let Some(pid) = child.id() {
        if let Ok(p) = get_scratch_pidfile(app) {
            write_pidfile(&p, pid);
        }
    }
    if let Ok(p) = get_scratch_secretfile(app) {
        let _ = std::fs::write(p, &jwt_secret);
    }

    {
        let mut st = scratch_state()
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        st.child = Some(child);
        st.jwt_secret = Some(jwt_secret.clone());
        // `starting` is cleared by `StartingClaim`'s drop at the end of this
        // scope on every OTHER exit path; clear it explicitly here too so
        // the readiness probe below (which can itself fail and tear the
        // process back down) never observes a stale `starting: true`.
        st.starting = false;
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(READY_BUDGET_MS);
    loop {
        if do_rpc_call_jwt(
            ZANO_SCRATCH_RPC_URL,
            &jwt_secret,
            "getaddress",
            serde_json::json!({}),
            std::time::Duration::from_millis(2_000),
        )
        .await
        .is_ok()
        {
            return Ok(ZanoScratchStarted {
                port: ZANO_SCRATCH_RPC_PORT,
                jwt_secret,
            });
        }

        {
            let exited = {
                let mut st = scratch_state()
                    .lock()
                    .map_err(|e| format!("Lock error: {}", e))?;
                match st.child.as_mut() {
                    Some(c) => c.try_wait().ok().flatten(),
                    None => None,
                }
            };
            if let Some(status) = exited {
                if let Ok(mut st) = scratch_state().lock() {
                    st.child = None;
                }
                let tail = get_scratch_log_file(app)
                    .map(|p| read_log_tail(&p, 4096))
                    .unwrap_or_default();
                return Err(format!(
                    "Zano scratch wallet-rpc exited during startup ({}). Log tail:\n{}",
                    status, tail
                ));
            }
        }

        if std::time::Instant::now() >= deadline {
            let tail = get_scratch_log_file(app)
                .map(|p| read_log_tail(&p, 4096))
                .unwrap_or_default();
            let _ = zano_scratch_stop(app).await;
            return Err(format!(
                "Zano scratch wallet-rpc did not become ready in {} ms. Log tail:\n{}",
                READY_BUDGET_MS, tail
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(READY_POLL_MS)).await;
    }
}

/// The `AppHandle`-independent half of [`zano_scratch_stop`]: take whatever
/// child is recorded, kill it, and clear the in-memory state. Split out for
/// two reasons:
///
/// 1. **Correctness.** [`scratch_state`] is a plain `std::sync::Mutex`
///    (deliberately — see that static's own doc comment), and its guard is
///    NOT `Send`. Awaiting `child.kill()` WHILE holding it would make this
///    function's future non-`Send` (and briefly serialise every other
///    locker across a process-kill for no reason). Taking the child out and
///    dropping the guard FIRST, matching `zph_rpc::zph_stop_rpc_internal`'s
///    identical shape for the identical `std::sync::Mutex` reason, is not a
///    style preference — the earlier draft of this function held the guard
///    across the `.await` and was caught by this exact "read the lock type,
///    not just copy the neighbouring code" check before it ever compiled;
///    see `PwndaWalletVault/log.md` for the write-up.
/// 2. **Testability.** With no `AppHandle` needed, this is directly
///    unit-testable against a real (placeholder) spawned child — proving
///    "does not leak a process" is a property of the CODE this function
///    runs, not a re-implementation of it in a test.
///
/// Idempotent: nothing recorded (`child: None`) is a no-op, never an error.
async fn scratch_kill_and_clear() {
    let child_opt = {
        let mut st = match scratch_state().lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let c = st.child.take();
        st.jwt_secret = None;
        st.starting = false;
        c
    };
    if let Some(mut child) = child_opt {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

/// Stop the Scratch wallet-rpc and delete its wallet file + secret —
/// "deleted on stop", this unit's own brief. Idempotent: calling this when
/// nothing is running is a harmless no-op, never an error, the same
/// contract [`zano_stop_rpc`]/`zph_stop_rpc`/`xmr_stop_rpc` all keep.
pub async fn zano_scratch_stop(app: &AppHandle) -> Result<(), String> {
    let secret = {
        let st = scratch_state()
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        st.jwt_secret.clone()
    };
    if let Some(secret) = secret {
        // Best-effort persist before killing — same reasoning as Main's
        // `zano_stop_rpc`, even though the account is about to be deleted
        // anyway: an abrupt kill mid-write is still how a wallet FILE (not
        // just its content) can end up corrupted on disk, and a corrupted
        // file is a slower, noisier failure for `delete_scratch_wallet_files`
        // to clean up than a clean one.
        let _ = do_rpc_call_jwt(
            ZANO_SCRATCH_RPC_URL,
            &secret,
            "store",
            serde_json::json!({}),
            std::time::Duration::from_millis(5_000),
        )
        .await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    scratch_kill_and_clear().await;

    if let Ok(p) = get_scratch_pidfile(app) {
        delete_pidfile(&p);
    }
    if let Ok(p) = get_scratch_secretfile(app) {
        let _ = std::fs::remove_file(p);
    }
    wait_for_port_free(ZANO_SCRATCH_RPC_PORT, 5_000).await;

    // "never reused across restarts": the file goes away with the process,
    // not just on the next start's pre-create delete — so nothing on disk
    // outlives the process that could serve it, between one engine session
    // and the next.
    delete_scratch_wallet_files(app)?;
    Ok(())
}

/// Read Main's current JWT secret WITHOUT starting or touching it in any
/// way — the "read/confirm only" half of this unit's own brief. `None`
/// means Main is not currently running (from this process's point of view:
/// no child recorded AND the port itself is not answering), which
/// `swap_sidecar::maybe_activate_zano_host_wallet` treats as "ZANO sharing
/// unavailable this session", never as a reason to start Main itself — see
/// that function's own doc comment for why starting Main is out of scope
/// for the engine entirely, unlike XMR/ZEPH's C9-shaped sharing.
pub async fn main_instance_jwt(app: &AppHandle) -> Option<String> {
    let running = zano_rpc_is_running(app.clone()).await.unwrap_or(false);
    if !running {
        return None;
    }
    let state = app.state::<ZanoRpcChild>();
    let in_memory = {
        let inner = state.0.lock().await;
        inner.jwt_secret.clone()
    };
    in_memory.or_else(|| {
        get_secretfile(app)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwt_has_three_parts() {
        let a = build_jwt("secret", "{\"a\":1}").unwrap();
        assert_eq!(a.split('.').count(), 3);
    }

    #[test]
    fn jwt_salt_is_fresh_per_call() {
        // Upstream rejects a reused salt, so two tokens over the SAME body must
        // still differ. This is the invariant that makes tokens single-use, and
        // a caching "optimisation" here would break auth in a confusing way.
        let a = build_jwt("secret", "{\"a\":1}").unwrap();
        let b = build_jwt("secret", "{\"a\":1}").unwrap();
        assert_ne!(a, b, "salt must be regenerated per request");
    }

    #[test]
    fn body_hash_is_sha256_not_keccak() {
        // Zano hashes the body with SHA-256 (`crypto::sha256_hash`), NOT the
        // keccak used everywhere else in its codebase. Pinning that here
        // because reaching for keccak is the obvious mistake to make.
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let body = "{\"method\":\"getbalance\"}";
        let token = build_jwt("secret", body).unwrap();
        let payload_b64 = token.split('.').nth(1).unwrap();
        let raw = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(payload_b64)
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(
            v["body_hash"].as_str().unwrap(),
            hex::encode(Sha256::digest(body.as_bytes()))
        );
    }

    /// Regression lock for the 2026-08-27 auth bug: shipped Phase 1 used
    /// base64URL (`-`/`_`) and passed every unit test, because those tests only
    /// checked round-trip consistency with THEMSELVES, never against upstream's
    /// actual decoder (`jwt::base::decode<jwt::alphabet::base64>`, the STANDARD
    /// alphabet). The failure was a coin flip: the header segment is a fixed
    /// string that happens not to need `+`/`/`, so only requests whose random
    /// payload/signature needed a substituted character failed — which read as
    /// intermittent flakiness, not a wrong alphabet, until traced against a
    /// live sidecar. This test forces the STANDARD-only bytes 0xff,0xff,0xff
    /// through the encoder directly, sidestepping randomness entirely: no
    /// number of lucky salts can make it pass with the wrong alphabet.
    #[test]
    fn jwt_uses_standard_base64_not_url_safe() {
        let encoded = b64std_nopad(&[0xff, 0xff, 0xff]);
        assert_eq!(encoded, "////", "must use '+/' alphabet, not '-_' (base64url)");
        assert!(!encoded.contains('-') && !encoded.contains('_'));
    }

    // ── C-RX: Scratch instance ──────────────────────────────────────────

    /// PWNDA-SINGLE-FLIGHT: mirrors `zph_rpc::tests::decide_zph_start_*` /
    /// `xmr_rpc::tests::decide_xmr_start_*` exactly — same three-way branch,
    /// same incident class this pattern closes across all three sidecars.
    #[test]
    fn decide_zano_scratch_start_spawns_only_when_neither_running_nor_starting() {
        assert_eq!(
            decide_zano_scratch_start(false, false),
            ZanoScratchStartDecision::ShouldSpawn,
            "the ordinary first-caller case must still spawn"
        );
    }

    #[test]
    fn decide_zano_scratch_start_attaches_rather_than_spawns_when_already_running() {
        assert_eq!(
            decide_zano_scratch_start(true, false),
            ZanoScratchStartDecision::AlreadyRunning
        );
        // Running always wins even if `starting` was somehow also left set
        // (e.g. a stale flag from a start that crashed before clearing it).
        assert_eq!(
            decide_zano_scratch_start(true, true),
            ZanoScratchStartDecision::AlreadyRunning
        );
    }

    #[test]
    fn decide_zano_scratch_start_backs_off_instead_of_racing_a_second_spawn() {
        assert_eq!(
            decide_zano_scratch_start(false, true),
            ZanoScratchStartDecision::AlreadyStarting,
            "a caller arriving while another is mid-spawn must back off, not race it"
        );
    }

    /// A genuinely trivial child, standing in for the real (unbuilt-on-this-
    /// machine, see A5) patched Zano binary — the lease/state arithmetic
    /// only reads `child.is_some()` / kills whatever handle is there, so a
    /// real-but-trivial process proves the CODE path (spawn a real OS
    /// process, hand back a real PID, later kill a real OS process) without
    /// needing the actual sidecar. Mirrors `xmr_rpc::tests::fresh_inner_with_child`.
    fn spawn_placeholder_child() -> tokio::process::Child {
        #[cfg(target_os = "windows")]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(target_os = "windows")]
        cmd.args(["/C", "timeout", "/t", "30", "/nobreak"]);
        #[cfg(not(target_os = "windows"))]
        let mut cmd = tokio::process::Command::new("sleep");
        #[cfg(not(target_os = "windows"))]
        cmd.args(["30"]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        cmd.stdin(std::process::Stdio::null());
        cmd.spawn()
            .expect("spawn a real, trivial, long-lived placeholder child for the test")
    }

    /// THE gate assertion this unit's own brief names: "scratch wallet
    /// spawn/stop proven idempotent (start-stop-start does not error or
    /// leak a process)". Exercises the REAL `scratch_kill_and_clear` (the
    /// `AppHandle`-independent half of `zano_scratch_stop` — see its own
    /// doc comment for why the split exists) against a real spawned
    /// process, end to end:
    ///
    ///   1. nothing running -> stop is a harmless no-op (idempotent on an
    ///      already-stopped state, the same property `zano_stop_rpc` /
    ///      `zph_stop_rpc` keep);
    ///   2. "start" (simulated: install a real placeholder child + secret,
    ///      since the actual spawn needs a live `AppHandle` + a patched
    ///      binary neither available in a unit test — see this module's own
    ///      Scratch lifecycle section's doc comment) -> `decide` reports
    ///      `AlreadyRunning`;
    ///   3. stop -> the real OS process is actually killed (not merely
    ///      dropped/leaked — verified by polling its exit, not just by
    ///      checking the in-memory flag), and the state resets to a fresh
    ///      "should spawn" decision;
    ///   4. a SECOND stop with nothing running -> still a no-op, not an
    ///      error;
    ///   5. "start" again (a fresh placeholder child) -> succeeds, proving
    ///      the SAME state machine two full start/stop cycles later is
    ///      still exactly as spawnable as it was the first time — the
    ///      literal "start-stop-start" the brief names.
    #[tokio::test]
    async fn scratch_start_stop_start_is_idempotent_and_does_not_leak_a_process() {
        // Reset first: tests in this module share the one process-global
        // static, so a prior test (or a prior failed run) must not leak
        // state into this one.
        scratch_kill_and_clear().await;

        // 1. Stop with nothing running: no panic, no error, no leftover state.
        scratch_kill_and_clear().await;
        {
            let st = scratch_state().lock().unwrap();
            assert!(st.child.is_none());
            assert!(st.jwt_secret.is_none());
            assert_eq!(
                decide_zano_scratch_start(st.child.is_some(), st.starting),
                ZanoScratchStartDecision::ShouldSpawn,
                "a clean state must still be spawnable"
            );
        }

        // 2. "Start": install a real child + secret, exactly as
        //    `zano_scratch_start`'s own post-spawn block does.
        let child = spawn_placeholder_child();
        let pid_first = child.id().expect("placeholder child must have a pid");
        {
            let mut st = scratch_state().lock().unwrap();
            st.child = Some(child);
            st.jwt_secret = Some("first-secret".to_string());
            st.starting = false;
        }
        {
            let st = scratch_state().lock().unwrap();
            assert_eq!(
                decide_zano_scratch_start(st.child.is_some(), st.starting),
                ZanoScratchStartDecision::AlreadyRunning,
                "a running child must be reported as already running, not spawned over"
            );
        }

        // 3. Stop: the real process must actually die, not just vanish from
        //    the struct. Poll for its exit rather than trusting the flag —
        //    this is the literal "does not leak a process" claim.
        scratch_kill_and_clear().await;
        {
            let st = scratch_state().lock().unwrap();
            assert!(st.child.is_none(), "the killed child's handle must be cleared");
            assert!(st.jwt_secret.is_none(), "the secret must be cleared on stop");
            assert!(!st.starting);
        }
        let mut process_gone = false;
        for _ in 0..25 {
            if crate::platform::pid_image_name(pid_first).await.is_none() {
                process_gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        assert!(
            process_gone,
            "the placeholder process (pid {}) must actually exit after stop, not \
             merely be dropped from the tracked state — a Child handle going out \
             of scope without an explicit kill can leave the OS process running",
            pid_first
        );

        // 4. A second stop with still-nothing-running: still a no-op.
        scratch_kill_and_clear().await;
        {
            let st = scratch_state().lock().unwrap();
            assert!(st.child.is_none());
        }

        // 5. Start again — the literal "start-stop-start" the gate names.
        //    A fresh placeholder stands in for a second real spawn.
        let child2 = spawn_placeholder_child();
        let pid_second = child2.id().expect("second placeholder child must have a pid");
        assert_ne!(
            pid_first, pid_second,
            "sanity: the second start must be a genuinely NEW process, not a \
             reused handle from the first"
        );
        {
            let mut st = scratch_state().lock().unwrap();
            st.child = Some(child2);
            st.jwt_secret = Some("second-secret".to_string());
        }
        {
            let st = scratch_state().lock().unwrap();
            assert_eq!(
                decide_zano_scratch_start(st.child.is_some(), st.starting),
                ZanoScratchStartDecision::AlreadyRunning
            );
        }

        // Clean up after ourselves so a later test in this module (or a
        // re-run) starts from a clean slate.
        scratch_kill_and_clear().await;
    }

    /// THE other literal gate assertion: "`wait_for_port_free(18086)`
    /// actually waits rather than racing". Binds a real listener on the
    /// Scratch port, holds it for a measured interval on a background task,
    /// and proves `wait_for_port_free` does not report the port free until
    /// AFTER that interval has actually elapsed — a helper that raced (e.g.
    /// checked once and gave up, or checked the wrong port) would return far
    /// too early and this would catch it, whereas an assertion that merely
    /// checks the final boolean would not.
    #[tokio::test]
    async fn scratch_wait_for_port_free_actually_waits_not_races() {
        use crate::wallet_rpc_common::{port_is_bound, wait_for_port_free};

        // Skip cleanly rather than fail if something ELSE already legitimately
        // holds this port (e.g. a real Scratch instance from a manual run) —
        // this test's own bind would fail for an unrelated reason then.
        if port_is_bound(ZANO_SCRATCH_RPC_PORT).await {
            eprintln!(
                "port {} already bound by something else; skipping \
                 scratch_wait_for_port_free_actually_waits_not_races",
                ZANO_SCRATCH_RPC_PORT
            );
            return;
        }

        let listener = std::net::TcpListener::bind(("127.0.0.1", ZANO_SCRATCH_RPC_PORT))
            .expect("bind the scratch port for the test");

        const HOLD_MS: u64 = 700;
        let started = std::time::Instant::now();
        let holder = tokio::task::spawn_blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(HOLD_MS));
            drop(listener);
        });

        let freed = wait_for_port_free(ZANO_SCRATCH_RPC_PORT, 5_000).await;
        let elapsed = started.elapsed();
        holder.await.expect("holder task must not panic");

        assert!(freed, "wait_for_port_free must report the port free once released");
        assert!(
            elapsed >= std::time::Duration::from_millis(HOLD_MS.saturating_sub(150)),
            "wait_for_port_free returned after {:?}, before the {}ms hold on port {} \
             had actually elapsed — it raced instead of genuinely waiting",
            elapsed,
            HOLD_MS,
            ZANO_SCRATCH_RPC_PORT
        );
    }
}
