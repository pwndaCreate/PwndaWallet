//! Background updater for the Monero / Zephyr `wallet-rpc` sidecars.
//!
//! Companion to the bundling work in [[sidecar-bundling]]: the installer now
//! ships both sidecars gzipped and dormant, and `resolve_rpc_binary` wakes one
//! into `<app_data>/<chain>/` the first time the user opens that chain. This
//! module keeps that woken copy current afterwards.
//!
//! # Why this exists at all
//!
//! `resolve_rpc_binary` checks **app-data first**, which is what lets an
//! updated binary beat the one frozen into the installer. The cost of that
//! ordering is that, without this module, a woken sidecar would be pinned
//! forever: install wallet vX (bundles monero v0.18.5.1) → open Monero →
//! binary lands in app-data → upgrade to wallet vY (bundles v0.18.6.0) → the
//! *old* app-data copy still wins. Tier 1 below exists specifically to close
//! that hole, and it needs no network at all.
//!
//! # Two tiers
//!
//! **Tier 1 — reconcile against the bundled payload.** Local, offline,
//! instant. If the payload the installer shipped is newer than what's in
//! app-data, re-extract it (which re-verifies the SHA256 on the way in). This
//! is really "finish applying the wallet upgrade", not a network update, so it
//! is *not* behind the enable toggle.
//!
//! **Tier 2 — check upstream.** Networked, throttled to once a day, and
//! **Monero only**. Zephyr pins its release tag *at compile time*
//! (`ZPH_RELEASE_TAG`, because Zephyr publishes no signed hash file), so for
//! Zephyr "latest this build can verify" is by definition whatever it bundles
//! — tier 1 already covers it, and a genuinely newer Zephyr requires a wallet
//! release. Pretending otherwise would mean downloading a binary we have no
//! way to verify.
//!
//! # Rules this module will not break
//!
//! - **Never swap a running sidecar.** Guarded by the loopback port *and* the
//!   managed child slot.
//! - **Verify before replace, always.** Tier 1 goes through
//!   `extract_bundled_sidecar` (SHA256 vs the manifest); tier 2 delegates to
//!   the existing `xmr_download_wallet_rpc`, which verifies against Monero's
//!   PGP-signed `hashes.txt`. Neither path is re-implemented here — this
//!   module decides *whether* to update, never *how* to fetch.
//! - **Only manage what we placed.** A binary with no `.sidecar-version`
//!   marker beside it was hand-dropped by the user (`resolve_rpc_binary`'s
//!   error message tells them to do exactly that) or predates markers. We
//!   leave it strictly alone rather than overwrite someone's deliberate choice.
//! - **Never wake a dormant sidecar.** If the user has never opened Monero,
//!   there is nothing in app-data and we do nothing. Staying dormant is the
//!   entire point of shipping it compressed.
//! - **Never block.** Everything runs on a detached task; every failure path
//!   logs and leaves the working binary in place.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Minimum gap between upstream (networked) checks.
const UPSTREAM_CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Delay after launch before the first pass. Long enough for boot to settle,
/// short enough to land before a user can realistically navigate to the Monero
/// panel and unlock a wallet.
const STARTUP_DELAY_SECS: u64 = 10;

/// Re-run interval for long-lived sessions (a desktop wallet can stay open for
/// days). Tier 1 is a couple of file reads when there's nothing to do; tier 2
/// is separately throttled by `UPSTREAM_CHECK_INTERVAL_SECS`.
const LOOP_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Filename of the marker `extract_bundled_sidecar` (and the downloaders)
/// write next to a placed binary. Reading a file is how we learn the version
/// without executing an ~60 MB binary just to ask it.
pub const VERSION_MARKER: &str = ".sidecar-version";

// ── Preferences ──────────────────────────────────────────────────────────

/// Persisted in `<app_data>/sidecar-update.json`.
///
/// Rust-side rather than the frontend's `tauri-plugin-store` because this is
/// read on the background task well before the webview is up, and must not
/// depend on the vault being unlocked.
#[derive(Serialize, Deserialize, Clone)]
pub struct SidecarUpdatePrefs {
    /// Gates **tier 2 only**. Tier 1 is local reconciliation of a payload the
    /// user already installed, so disabling network checks doesn't disable it.
    pub enabled: bool,
    /// Unix seconds of the last upstream check *attempt* (not success — a
    /// failing check must not hot-loop against GitHub).
    pub last_check: u64,
}

impl Default for SidecarUpdatePrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            last_check: 0,
        }
    }
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("sidecar-update.json"))
        .map_err(|e| format!("no app data dir: {}", e))
}

fn read_prefs(app: &AppHandle) -> SidecarUpdatePrefs {
    prefs_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_prefs(app: &AppHandle, prefs: &SidecarUpdatePrefs) {
    if let Ok(path) = prefs_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(prefs) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Version handling ─────────────────────────────────────────────────────

/// Split a release tag into numeric components, tolerating a leading `v` and
/// any trailing non-digits on a component. Monero's four-part
/// `v0.18.5.1` and Zephyr's three-part `v2.3.0` both parse correctly.
fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

/// Component-wise numeric compare — `is_newer("v0.18.5.1", "v0.18.4.6")` is
/// true, which plain string ordering gets wrong once a component reaches two
/// digits. Missing components read as 0, so `v2.3` == `v2.3.0`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let (a, b) = (parse_version(candidate), parse_version(current));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Read the `.sidecar-version` marker beside a placed binary.
///
/// `None` means "not ours to manage" — either nothing is installed, or a
/// binary was hand-placed by the user. Both are left alone.
pub fn installed_version(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(VERSION_MARKER)).ok()?;
    let trimmed = raw.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Write the marker beside a binary we just placed. Called by the downloaders
/// too, so a downloaded sidecar becomes managed rather than opaque.
pub fn set_installed_version(dir: &Path, version: &str) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(VERSION_MARKER), version.as_bytes());
}

// ── "Is it safe to touch right now?" ─────────────────────────────────────

/// Per-chain wiring, so the two tiers don't repeat chain-specific literals.
struct Chain {
    /// Manifest key + binaries/<which>-wallet-rpc.gz stem.
    which: &'static str,
    /// Sub-directory under app-data.
    dir: &'static str,
    /// Loopback port the sidecar binds when running.
    port: u16,
}

const CHAINS: [Chain; 2] = [
    Chain {
        which: "monero",
        dir: "monero",
        port: crate::xmr_rpc::XMR_RPC_PORT,
    },
    Chain {
        which: "zephyr",
        dir: "zephyr",
        port: crate::zph_rpc::ZPH_RPC_PORT,
    },
];

/// True if the sidecar looks live and must not be swapped.
///
/// Two independent signals, because either alone has a blind spot: the managed
/// child slot misses a sidecar left running by a previous crash, and the port
/// check misses the window between spawn and bind. Replacing a running EXE
/// also just fails on Windows (file lock) — these checks make that a
/// deliberate skip rather than a confusing write error.
async fn sidecar_busy(app: &AppHandle, chain: &Chain) -> bool {
    // Scoped so no MutexGuard is alive across the await below.
    let child_present = {
        match chain.which {
            "monero" => app
                .try_state::<crate::xmr_rpc::XmrRpcChild>()
                .and_then(|s| s.0.lock().ok().map(|g| g.child.is_some()))
                .unwrap_or(false),
            "zephyr" => app
                .try_state::<crate::zph_rpc::ZphRpcChild>()
                .and_then(|s| s.0.lock().ok().map(|g| g.child.is_some()))
                .unwrap_or(false),
            _ => false,
        }
    };
    if child_present {
        return true;
    }
    crate::wallet_rpc_common::port_is_bound(chain.port).await
}

// ── Tier 1: reconcile against the bundled payload ────────────────────────

/// Re-extract a bundled payload over an app-data copy that the installer has
/// since superseded. Offline, verified, and a no-op in the common case.
///
/// Deliberately skips when there is no marker (see module docs) and when
/// nothing is installed — waking a dormant sidecar here would defeat the whole
/// point of shipping it compressed.
async fn reconcile_bundled(app: &AppHandle) {
    let (Ok(resource_dir), Ok(app_data)) = (app.path().resource_dir(), app.path().app_data_dir())
    else {
        return;
    };

    for chain in CHAINS.iter() {
        let Some(bundled) =
            crate::wallet_rpc_common::bundled_sidecar_version(&resource_dir, chain.which)
        else {
            continue; // nothing staged for this chain in this build
        };
        let dest = app_data.join(chain.dir);
        let Some(installed) = installed_version(&dest) else {
            continue; // dormant, or hand-placed — not ours
        };
        if !is_newer(&bundled, &installed) {
            continue;
        }
        if sidecar_busy(app, chain).await {
            println!(
                "[sidecar-update] {} {} → {} available but sidecar is running; deferring",
                chain.which, installed, bundled
            );
            continue;
        }

        match crate::wallet_rpc_common::extract_bundled_sidecar(&resource_dir, &dest, chain.which) {
            Ok(path) => {
                println!(
                    "[sidecar-update] {} reconciled {} → {} ({})",
                    chain.which,
                    installed,
                    bundled,
                    path.display()
                );
                emit_updated(app, chain.which, &installed, &bundled, "bundled");
            }
            Err(e) => {
                // The existing binary is untouched — extract_bundled_sidecar
                // verifies before it writes anything.
                eprintln!(
                    "[sidecar-update] {} reconcile to {} failed ({}); keeping {}",
                    chain.which, bundled, e, installed
                );
            }
        }
    }
}

// ── Tier 2: upstream check (Monero only) ─────────────────────────────────

#[derive(Deserialize)]
struct GhTag {
    tag_name: String,
}

/// Ask GitHub for Monero's latest release tag. Version discovery only — the
/// bytes come from `downloads.getmonero.org` and are verified against the
/// PGP-signed `hashes.txt` by the downloader we delegate to.
async fn latest_monero_tag() -> Option<String> {
    let client = reqwest::Client::builder()
        .user_agent("PwndaWallet/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let tag: GhTag = client
        .get("https://api.github.com/repos/monero-project/monero/releases/latest")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    Some(tag.tag_name)
}

/// Swap in a newer monero-wallet-rpc if upstream has one.
///
/// The swap is staged so a failed download can never leave the user without a
/// working binary: the current one is moved aside (not deleted), the verified
/// downloader runs, and the old copy is restored on any failure. The
/// downloader re-discovers the tag itself — one redundant GitHub call, in
/// exchange for not duplicating (or having to keep in sync) a verified
/// download path.
async fn check_upstream_monero(app: &AppHandle) {
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let chain = &CHAINS[0]; // monero
    let dir = app_data.join(chain.dir);

    let Some(installed) = installed_version(&dir) else {
        return; // dormant or hand-placed
    };
    let Some(latest) = latest_monero_tag().await else {
        return; // offline / rate-limited — try again next interval
    };
    if !is_newer(&latest, &installed) {
        return;
    }
    if sidecar_busy(app, chain).await {
        println!(
            "[sidecar-update] monero {} → {} available upstream but sidecar is running; deferring",
            installed, latest
        );
        return;
    }

    let binary = dir.join(format!(
        "monero-wallet-rpc{}",
        crate::platform::EXE_SUFFIX
    ));
    let backup = binary.with_extension("old");
    let _ = std::fs::remove_file(&backup);
    if std::fs::rename(&binary, &backup).is_err() {
        eprintln!("[sidecar-update] monero: cannot stage {} aside; skipping", binary.display());
        return;
    }
    // The downloader short-circuits when a real binary is already present, so
    // the marker goes too — it is rewritten on either outcome below.
    let _ = std::fs::remove_file(dir.join(VERSION_MARKER));

    match crate::xmr_rpc::xmr_download_wallet_rpc(app.clone()).await {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup);
            set_installed_version(&dir, &latest);
            println!("[sidecar-update] monero updated {} → {}", installed, latest);
            emit_updated(app, "monero", &installed, &latest, "upstream");
        }
        Err(e) => {
            // Put the working binary back exactly as it was.
            let _ = std::fs::remove_file(&binary);
            let _ = std::fs::rename(&backup, &binary);
            set_installed_version(&dir, &installed);
            eprintln!(
                "[sidecar-update] monero update to {} failed ({}); restored {}",
                latest, e, installed
            );
        }
    }
}

// ── Orchestration ────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct SidecarUpdated {
    chain: String,
    from: String,
    to: String,
    /// "bundled" (tier 1) or "upstream" (tier 2).
    source: String,
}

fn emit_updated(app: &AppHandle, chain: &str, from: &str, to: &str, source: &str) {
    crate::emit_meter::bump("sidecar-updated");
    let _ = app.emit(
        "sidecar-updated",
        SidecarUpdated {
            chain: chain.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            source: source.to_string(),
        },
    );
}

/// One full pass: tier 1 always, tier 2 if enabled and the throttle allows.
async fn run_pass(app: &AppHandle, force_upstream: bool) {
    reconcile_bundled(app).await;

    let mut prefs = read_prefs(app);
    if !prefs.enabled && !force_upstream {
        return;
    }
    let now = now_secs();
    let due = now.saturating_sub(prefs.last_check) >= UPSTREAM_CHECK_INTERVAL_SECS;
    if !due && !force_upstream {
        return;
    }
    // Stamp before the attempt: a check that fails (offline, rate-limited)
    // must wait out the interval like any other, not retry every loop.
    prefs.last_check = now;
    write_prefs(app, &prefs);

    check_upstream_monero(app).await;
}

/// Spawn the detached background updater. Called once from `lib.rs::run`'s
/// setup hook.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(STARTUP_DELAY_SECS)).await;
        loop {
            run_pass(&app, false).await;
            tokio::time::sleep(std::time::Duration::from_secs(LOOP_INTERVAL_SECS)).await;
        }
    });
}

// ── Commands (Settings surface) ──────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarUpdateStatus {
    pub enabled: bool,
    pub last_check: u64,
    /// Installed version per chain, `null` when dormant or hand-placed.
    pub monero_installed: Option<String>,
    pub zephyr_installed: Option<String>,
    /// Version this build ships, `null` when nothing was staged.
    pub monero_bundled: Option<String>,
    pub zephyr_bundled: Option<String>,
}

#[tauri::command]
pub async fn sidecar_update_status(app: AppHandle) -> Result<SidecarUpdateStatus, String> {
    let prefs = read_prefs(&app);
    let app_data = app.path().app_data_dir().ok();
    let resource_dir = app.path().resource_dir().ok();
    let installed = |sub: &str| {
        app_data
            .as_ref()
            .and_then(|d| installed_version(&d.join(sub)))
    };
    let bundled = |which: &str| {
        resource_dir
            .as_ref()
            .and_then(|d| crate::wallet_rpc_common::bundled_sidecar_version(d, which))
    };
    Ok(SidecarUpdateStatus {
        enabled: prefs.enabled,
        last_check: prefs.last_check,
        monero_installed: installed("monero"),
        zephyr_installed: installed("zephyr"),
        monero_bundled: bundled("monero"),
        zephyr_bundled: bundled("zephyr"),
    })
}

/// Toggle **tier 2** (networked upstream checks). Tier 1 always runs — see
/// the module docs for why disabling it would just strand users on a sidecar
/// their own installer already replaced.
#[tauri::command]
pub async fn sidecar_update_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut prefs = read_prefs(&app);
    prefs.enabled = enabled;
    write_prefs(&app, &prefs);
    Ok(())
}

/// Run a pass now, ignoring both the toggle and the throttle ("Check now").
#[tauri::command]
pub async fn sidecar_update_check_now(app: AppHandle) -> Result<(), String> {
    run_pass(&app, true).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_multi_digit_components_numerically() {
        // The case plain string ordering gets wrong: "5" > "4" lexically only
        // by luck, and "10" < "9" lexically always.
        assert!(is_newer("v0.18.5.1", "v0.18.4.6"));
        assert!(is_newer("v0.18.10.0", "v0.18.9.9"));
        assert!(!is_newer("v0.18.4.6", "v0.18.5.1"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!is_newer("v2.3.0", "v2.3.0"));
        assert!(!is_newer("2.3.0", "v2.3.0"));
        // Missing trailing components read as zero.
        assert!(!is_newer("v2.3", "v2.3.0"));
        assert!(!is_newer("v2.3.0", "v2.3"));
    }

    #[test]
    fn handles_real_pinned_tags() {
        assert!(is_newer("v2.4.0", "v2.3.0"));
        assert!(!is_newer("v2.3.0", "v2.4.0"));
    }

    #[test]
    fn garbage_components_do_not_panic() {
        assert!(!is_newer("", ""));
        assert!(is_newer("v1.0.0-rc2", "v0.9.9"));
    }
}
