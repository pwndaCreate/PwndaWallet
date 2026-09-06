//! On-disk data-location surfacing for the Settings UI.
//!
//! Lets the UI show WHERE PwndaWallet stores its wallet-RPC daemons, the
//! per-chain wallet + chain-scan cache (what users think of as "the
//! blockchain"), and the miner binaries — and open any of those folders in the
//! OS file manager on click.
//!
//! All paths derive from `app.path().app_data_dir()` (resolves per-product:
//! `com.pwnda.wallet` for the full wallet, `com.pwnda.lite` for PwndaLite). The
//! webview passes only a fixed location KEY ("data" / "monero" / …), never a
//! raw path, so this can never be used to open an arbitrary directory.
//!
//! Layout reference: `wiki/concepts/install-data-locations.md`.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The on-disk folders the Settings card displays. Strings (not `PathBuf`) so
/// they serialize cleanly to the webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocations {
    /// The app-data root — everything below lives under it.
    pub data_dir: String,
    /// Downloaded miner binaries (xmrig / SRBMiner-MULTI / lolMiner).
    pub miners: String,
    /// Monero wallet-RPC sidecar ("daemon") folder.
    pub monero_daemon: String,
    /// Zephyr wallet-RPC sidecar ("daemon") folder.
    pub zephyr_daemon: String,
    /// Monero wallet files + scanned chain index.
    pub xmr_wallets: String,
    /// Zephyr wallet files + scanned chain index.
    pub zph_wallets: String,
}

/// Whether an in-place self-update can be applied to this install.
///
/// True on Windows (MSI/NSIS own their install tree) and for Linux AppImages
/// (a single self-contained file we can replace). False for `.deb`/`.rpm`,
/// which are owned by apt/dnf — the Settings card uses this to point those
/// users at their package manager rather than offering a button that would
/// either silently no-op or corrupt the package database.
#[tauri::command]
pub fn updater_can_self_install() -> bool {
    if cfg!(target_os = "linux") {
        crate::platform::is_appimage()
    } else {
        true
    }
}

/// Return the on-disk paths the Settings card shows.
#[tauri::command]
pub fn get_data_locations(app: AppHandle) -> Result<DataLocations, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
    Ok(DataLocations {
        data_dir: s(base.clone()),
        miners: s(base.join("miners")),
        monero_daemon: s(base.join("monero")),
        zephyr_daemon: s(base.join("zephyr")),
        xmr_wallets: s(base.join("xmr-wallets")),
        zph_wallets: s(base.join("zph-wallets")),
    })
}

/// Open one of the known data folders in the OS file manager. `which` is a
/// fixed key (NOT a raw path), so the webview can only ever open our own
/// app-data subfolders. The folder is created if missing (the daemon/wallet
/// subdirs are created lazily on first use) so the click always lands there.
#[tauri::command]
pub fn open_data_location(app: AppHandle, which: String) -> Result<(), String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let target = match which.as_str() {
        "miners" => base.join("miners"),
        "monero" => base.join("monero"),
        "zephyr" => base.join("zephyr"),
        "xmr-wallets" => base.join("xmr-wallets"),
        "zph-wallets" => base.join("zph-wallets"),
        // "data" or any unknown key -> the root data folder.
        _ => base,
    };
    let _ = std::fs::create_dir_all(&target);
    open_in_file_manager(&target)
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    // explorer.exe returns a non-zero exit even on success; we spawn() and
    // don't wait, so "launched" is the success signal.
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch explorer: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open file manager: {e}"))
}
