//! WebView2 renderer memory circuit-breaker.
//!
//! Background watchdog that watches the resident memory of the app's
//! WebView2 renderer child processes and, when it crosses a threshold,
//! reloads the webview to reclaim the renderer's native memory.
//!
//! **Why a reload is safe.** Mining is driven entirely by the Rust backend
//! (the miner subprocesses in `miners.rs`, the dev-fee proxy, the sidecar
//! RPCs). The WebView2 renderer is *only* the UI. Reloading it
//! (`location.reload()`) tears down the DOM / Blink render tree — freeing
//! whatever the renderer leaked — and the React app re-reads live miner
//! status from the backend on mount. **A mining session is NOT interrupted
//! by a webview reload.**
//!
//! **Why it exists.** This is the hard safety net behind the canvas-chart
//! fix. Even if a renderer leak reappears (a regression, a new view, a
//! WebView2 quirk), the breaker bounds renderer RSS to ~`threshold` instead
//! of letting it climb until the host OOM / pagefile-thrashes. Anchor: a 7 h
//! CPU-mining session on the pre-canvas build climbed the renderer to
//! ~8 GB RSS (committed memory far higher — the working set was being
//! trimmed) and hard-froze a 64 GB host at 2026-06-02T20:23 (Kernel-Power
//! 41, no BugCheck — a pagefile-thrash wedge). See
//! `wiki/concepts/webview2-memory-management.md`.
//!
//! **Measurement (2026-06-03 — corrected).** This module FIRST shipped with
//! its own hand-rolled `unsafe` ToolHelp + PSAPI process walk (to be
//! release-capable + work under memory pressure). That FFI corrupted the heap
//! and killed the app on startup with `STATUS_HEAP_CORRUPTION (0xc0000374)`
//! on the breaker's very first poll. It now reads the renderer RSS from
//! `mem_watch`'s existing SAFE WMI-based sample (`latest_webview_mb()`) — one
//! shared measurement, zero `unsafe`. Consequence: the breaker is only ACTIVE
//! when `mem_watch` runs (debug builds / `PWNDA_MEM_WATCH=1`); in a plain
//! release build it's inert and the canvas chart + `MemoryUsageLevel::Low`
//! carry the leak defense. Re-adding a release-safe sampler is future work —
//! and it will NOT be a hand-rolled native process walk. Set
//! `PWNDA_MEM_GUARD=0` to disable, `PWNDA_MEM_GUARD_MB=<n>` to tune.
//!
//! Windows-only; a no-op elsewhere (WebView2 is the Windows backend and this
//! leak does not exist on the WebKitGTK / macOS backends).

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

/// How often to check the renderer RSS (read from `mem_watch`'s latest
/// sample). 30 s catches a runaway long before it matters; the underlying
/// sample refreshes every 60 s, so a value is at most ~60 s stale — fine for
/// a coarse GB-level threshold.
#[cfg(target_os = "windows")]
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Reload when the webview renderer's summed RSS exceeds this many MB. The
/// canvas build idles around 200–400 MB. Lowered 3072 -> 2048 on 2026-06-02
/// after the rebuilt-binary session (`mem-native-20260603T024702Z`) showed a
/// residual *focused-climb* during active mining that peaked ~1,877 MB and
/// was still rising when the window blurred. A 2 GB cap resets that climb via
/// reload before it grows further, while still sitting well clear of the
/// idle baseline (so it won't fire during normal blurred/idle operation).
/// The host has tens of GB free at 2 GB, so the reload is calm. Until the
/// residual is fixed at the source (see the mem-frontend trace), this keeps
/// the focused peak bounded. Override with `PWNDA_MEM_GUARD_MB`.
#[cfg(target_os = "windows")]
const DEFAULT_THRESHOLD_MB: u64 = 2048;

/// Windows this guard must NOT reload — surfaces the wallet does not own.
///
/// `bsx-console` is upstream's BasicSwap UI
/// (`swap_sidecar::CONSOLE_WINDOW_LABEL`). Kept as a literal rather than
/// importing the constant so this module stays independent of the `full`
/// feature gate — `mem_guard` compiles in the lite build, `swap_sidecar` does
/// not. The pairing is asserted by a test in `swap_sidecar.rs` instead, which
/// only compiles where both exist.
pub(crate) const SKIP_RELOAD_LABELS: &[&str] = &["bsx-console"];

/// Never reload more than once per this interval. If a leak somehow survives
/// a reload, this bounds it to one reload per window (logged) instead of a
/// tight reload loop.
#[cfg(target_os = "windows")]
const MIN_RELOAD_INTERVAL: Duration = Duration::from_secs(300);

/// Attach the circuit-breaker. Call once from `lib.rs::setup`. Spawns a
/// process-lifetime background task. Release-capable.
#[cfg(target_os = "windows")]
pub fn attach(app: &tauri::AppHandle) {
    if matches!(
        std::env::var("PWNDA_MEM_GUARD").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    ) {
        eprintln!("[mem-guard] disabled via PWNDA_MEM_GUARD");
        return;
    }
    let threshold_mb = std::env::var("PWNDA_MEM_GUARD_MB")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n >= 256) // refuse an absurdly low threshold that would thrash-reload
        .unwrap_or(DEFAULT_THRESHOLD_MB);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run(app, threshold_mb).await });
}

#[cfg(not(target_os = "windows"))]
pub fn attach(_app: &tauri::AppHandle) {
    // WebView2-only; the renderer leak this guards against doesn't exist on
    // the WebKitGTK / macOS backends.
}

#[cfg(target_os = "windows")]
async fn run(app: tauri::AppHandle, threshold_mb: u64) {
    use tauri::Manager;

    eprintln!(
        "[mem-guard] webview RSS circuit-breaker armed: threshold {} MB, poll {}s",
        threshold_mb,
        POLL_INTERVAL.as_secs()
    );

    let mut last_reload: Option<Instant> = None;
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    loop {
        ticker.tick().await;

        let rss_mb = match webview_rss_mb() {
            Some(mb) => mb,
            None => continue, // measurement hiccup — skip this tick, never fatal
        };
        if rss_mb < threshold_mb {
            continue;
        }

        // Over threshold. Respect the cooldown so a surviving leak can't
        // drive a tight reload loop.
        if let Some(t) = last_reload {
            if t.elapsed() < MIN_RELOAD_INTERVAL {
                eprintln!(
                    "[mem-guard] webview RSS {} MB still >= {} MB but within reload cooldown — holding",
                    rss_mb, threshold_mb
                );
                continue;
            }
        }

        // Reload the wallet's OWN webview windows. Mining keeps running
        // (backend-owned); this only resets the UI renderer and frees its
        // leaked memory.
        //
        // # Why this is not "every window" (2026-08-21)
        //
        // This module's safety argument is specific and does not generalise:
        // *mining is driven entirely by the Rust backend, so tearing down the
        // DOM loses nothing.* That is true of surfaces this project wrote. It
        // is FALSE of [`SKIP_RELOAD_LABELS`] below, which renders upstream's
        // BasicSwap UI — a reload there discards whatever the user had typed,
        // and the realistic moment for a 2 GB RSS threshold to trip is a long
        // session, which is exactly when a half-filled bid form is on screen.
        // Losing a bid form is a bad outcome; losing an in-flight swap is not
        // possible (the engine owns that), but the form is not recoverable.
        //
        // Enumerated by label rather than by "is it the main window" so a
        // future second wallet-owned window keeps the leak protection by
        // default, and only surfaces we do NOT own are opted out.
        let mut reloaded = false;
        for (label, win) in app.webview_windows() {
            if SKIP_RELOAD_LABELS.contains(&label.as_str()) {
                eprintln!(
                    "[mem-guard] skipping reload of '{}' — not a wallet-owned surface",
                    label
                );
                continue;
            }
            // Leave a breadcrumb the reloaded UI can read (to show a notice
            // or restore view); harmless if ignored.
            let _ = win.eval(
                "try{sessionStorage.setItem('pwnda.memGuardReloadAt',String(Date.now()))}catch(e){}window.location.reload()",
            );
            reloaded = true;
        }
        if reloaded {
            eprintln!(
                "[mem-guard] webview RSS {} MB >= {} MB threshold -> reloaded webview to reclaim renderer memory (mining unaffected)",
                rss_mb, threshold_mb
            );
            last_reload = Some(Instant::now());
        }
    }
}

/// The most recent WebView2-renderer RSS (MB) as measured by the native
/// sampler (`mem_watch`), or `None` until the first sample lands / when the
/// sampler is disabled (release build without `PWNDA_MEM_WATCH=1`).
///
/// 2026-06-03: this previously did its OWN ToolHelp + PSAPI process walk, but
/// that hand-rolled `unsafe` FFI corrupted the heap — the app died on startup
/// with `STATUS_HEAP_CORRUPTION (0xc0000374)` on the breaker's first poll
/// (tokio's `interval` fires its first tick immediately). We now reuse
/// `mem_watch`'s safe WMI-based sample instead of duplicating a fragile native
/// walk. Trade-off: the breaker is only active when `mem_watch` runs (debug /
/// `PWNDA_MEM_WATCH=1`); in a plain release build it's inert and the canvas
/// chart + `MemoryUsageLevel::Low` still bound the renderer. A release-safe
/// sampler is future work — but NEVER again a hand-rolled `unsafe` process walk.
#[cfg(target_os = "windows")]
fn webview_rss_mb() -> Option<u64> {
    crate::mem_watch::latest_webview_mb()
}
