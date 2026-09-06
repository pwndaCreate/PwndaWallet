//! PwndaWallet build script.
//!
//! In addition to the standard `tauri_build::build()` step, we check whether
//! the **compressed wallet-rpc sidecar payloads** are staged, and emit
//! `cargo:warning` lines so maintainers get a loud signal at build time if a
//! release is about to ship without them.
//!
//! This is intentionally non-fatal: builds without the payloads still succeed,
//! and the runtime downloaders (`xmr_download_wallet_rpc` /
//! `zph_download_wallet_rpc`) fill the gap on first use. The warning just makes
//! sure nobody accidentally ships an installer that silently forces every
//! XMR/ZPH user through an 88 MB / 44 MB first-run download.
//!
//! 2026-07-07: rewritten for the bundled-sidecar pipeline. This used to check
//! for a real `binaries/monero-wallet-rpc.exe` and tell the maintainer to drop
//! one in by hand — but binaries are no longer committed, and hand-dropping is
//! no longer the shipping path. The inputs are now produced by
//! `node scripts/fetch-sidecars.mjs <win32|linux>` (which verifies upstream
//! SHA256s) and embedded via `bundle.resources`. The small `*.exe` files still
//! in that directory are self-describing placeholders and are EXPECTED — they
//! are no longer warned about.

use std::path::Path;

fn main() {
    check_bundled_sidecars();
    tauri_build::build()
}

fn check_bundled_sidecars() {
    let manifest = Path::new("binaries/sidecars.json");
    println!("cargo:rerun-if-changed=binaries/sidecars.json");
    println!("cargo:rerun-if-changed=binaries/monero-wallet-rpc.gz");
    println!("cargo:rerun-if-changed=binaries/zephyr-wallet-rpc.gz");

    if !manifest.exists() {
        println!(
            "cargo:warning=No binaries/sidecars.json — the Monero/Zephyr wallet-rpc \
             payloads are NOT staged, so this build will not bundle them and XMR/ZPH \
             users will download them on first use. For a release, run: \
             node scripts/fetch-sidecars.mjs <win32|linux>"
        );
        return;
    }

    // Warn per-sidecar so a half-staged directory is obvious.
    for (label, gz) in [
        ("Monero", "binaries/monero-wallet-rpc.gz"),
        ("Zephyr", "binaries/zephyr-wallet-rpc.gz"),
    ] {
        if !Path::new(gz).exists() {
            println!(
                "cargo:warning=sidecars.json is present but {} payload ({}) is missing — \
                 that sidecar will fall back to a first-use download. Re-run \
                 scripts/fetch-sidecars.mjs to stage it.",
                label, gz
            );
        }
    }

    check_staged_platform(manifest);
}

/// Warn when the staged payloads are for a different OS than we're building.
///
/// Both platforms stage to the SAME fixed paths and differ only in content
/// (that's the workaround for Tauri 2 having no per-OS `resources`), so
/// whichever fetch ran last wins. A release run stages win32, builds the MSI,
/// then stages linux for the Docker half — which leaves the tree holding Linux
/// payloads. A later local Windows build would then embed those.
///
/// The consequence is mild — `extract_bundled_sidecar` checks `platform` at
/// runtime and falls back to downloading — but silent. This makes it visible.
/// The real guard is the runtime check; this is only a heads-up, which is why
/// it scrapes the field rather than pulling serde_json into build-dependencies.
fn check_staged_platform(manifest: &Path) {
    let Ok(target_os) = std::env::var("CARGO_CFG_TARGET_OS") else {
        return;
    };
    let expected = if target_os == "windows" { "win32" } else { "linux" };

    let Ok(raw) = std::fs::read_to_string(manifest) else {
        return;
    };
    // "platform"<ws>:<ws>"<value>"
    let Some(staged) = raw.split_once("\"platform\"").and_then(|(_, rest)| {
        let rest = rest.trim_start().strip_prefix(':')?.trim_start();
        rest.strip_prefix('"')?.split('"').next()
    }) else {
        return;
    };

    if staged != expected {
        println!(
            "cargo:warning=binaries/sidecars.json is staged for '{}' but this build targets \
             '{}' — the bundled wallet-rpc payloads will be REJECTED at runtime and XMR/ZPH \
             users will download them instead. Run: node scripts/fetch-sidecars.mjs {}",
            staged, expected, expected
        );
    }
}
