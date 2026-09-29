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
//! **What it measures (RAM plan 3.4, 2026-09-25).** Until 3.4 the breaker read
//! the summed WORKING SET of the WebView2 processes. `MemoryUsageLevel::Low`
//! trims that working set every time the window loses focus, so a leaking
//! renderer read a few hundred MB while its COMMIT - what the pagefile backs,
//! and what grew the operator's pagefile on 2026-09-24 - sat at 7.4 GB. The
//! breaker could not fire on the leak it exists for. It now reads the commit
//! of the largest single renderer (`mem_watch::latest_renderer_commit_mb`),
//! and falls back to the old working-set reading, with the old threshold, only
//! when the sampler could not type a renderer. See [`pick_reading`].
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
/// canvas build idles around 200–400 MB. Was 2048 from 2026-06-02 (after a
/// residual *focused-climb* during active mining peaked ~1,877 MB); raised to
/// 4096 as part of the RAM plan Phase 1.4 fix (2026-09-22) alongside gating
/// the reload on lock state (see `run`'s vault-unlock check below) — with
/// that gate in place an unlocked long session no longer gets silently
/// reloaded at all, so the raise is about the LOCKED case: a locked/idle
/// window sitting at the host/home screen has no in-progress state to lose,
/// so there is less reason to reclaim its memory aggressively, and a higher
/// threshold means fewer reload cycles for a window that was already safe to
/// reload at 2048. The host has tens of GB free at 4 GB, so the reload is
/// still calm. Override with `PWNDA_MEM_GUARD_MB`.
///
/// Since RAM plan 3.4 this is only the FALLBACK threshold - used when the
/// sample has no typed renderer and the guard reads working set as before.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const DEFAULT_WS_THRESHOLD_MB: u64 = 4096;

/// Reload when the largest renderer's COMMIT exceeds this many MB (RAM plan
/// 3.4, 2026-09-25). A fresh renderer commits ~100 MB (105 MB measured on the
/// dev host); the pre-3.6 dev build grew it ~150 MB/h and reached 7.4 GB, the
/// production build ~13 MB/h. 3 GB is ~30x a fresh renderer - far past
/// anything a healthy session reaches, well before the pagefile pressure of
/// 2026-06-02. What a healthy renderer commits after DAYS is not yet measured
/// (Phase 4); if the breaker ever fires on a session that was not leaking,
/// raise this rather than trusting the number. `PWNDA_MEM_GUARD_MB` overrides
/// both thresholds.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const DEFAULT_COMMIT_THRESHOLD_MB: u64 = 3072;

/// One breaker reading: the value, the threshold it is judged against, and
/// the name of what was measured (for the log line).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) struct Reading {
    pub mb: u64,
    pub threshold_mb: u64,
    pub metric: &'static str,
}

impl Reading {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn over(&self) -> bool {
        self.mb >= self.threshold_mb
    }
}

/// Which measurement the breaker judges this tick (RAM plan 3.4). Renderer
/// commit when the sampler typed a renderer, else the WebView2 working set
/// against its own (higher) threshold, else nothing. Never mixes one metric's
/// value with the other's threshold. Pure, so the choice is tested on every
/// platform even though the breaker only runs on Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn pick_reading(
    renderer_commit_mb: Option<u64>,
    webview_ws_mb: Option<u64>,
    commit_threshold_mb: u64,
    ws_threshold_mb: u64,
) -> Option<Reading> {
    if let Some(mb) = renderer_commit_mb {
        return Some(Reading { mb, threshold_mb: commit_threshold_mb, metric: "renderer commit" });
    }
    webview_ws_mb.map(|mb| Reading { mb, threshold_mb: ws_threshold_mb, metric: "webview working set" })
}

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
    // One override for both metrics: whichever the guard ends up reading,
    // the operator asked for this number.
    let override_mb = std::env::var("PWNDA_MEM_GUARD_MB")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n >= 256); // refuse an absurdly low threshold that would thrash-reload
    let commit_threshold_mb = override_mb.unwrap_or(DEFAULT_COMMIT_THRESHOLD_MB);
    let ws_threshold_mb = override_mb.unwrap_or(DEFAULT_WS_THRESHOLD_MB);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run(app, commit_threshold_mb, ws_threshold_mb).await });
}

#[cfg(not(target_os = "windows"))]
pub fn attach(_app: &tauri::AppHandle) {
    // WebView2-only; the renderer leak this guards against doesn't exist on
    // the WebKitGTK / macOS backends.
}

#[cfg(target_os = "windows")]
async fn run(app: tauri::AppHandle, commit_threshold_mb: u64, ws_threshold_mb: u64) {
    use tauri::Manager;

    eprintln!(
        "[mem-guard] webview memory circuit-breaker armed: renderer commit >= {} MB \
         (working set >= {} MB if no renderer is typed), poll {}s",
        commit_threshold_mb,
        ws_threshold_mb,
        POLL_INTERVAL.as_secs()
    );

    let mut last_reload: Option<Instant> = None;
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    loop {
        ticker.tick().await;

        let reading = match pick_reading(
            crate::mem_watch::latest_renderer_commit_mb(),
            webview_rss_mb(),
            commit_threshold_mb,
            ws_threshold_mb,
        ) {
            Some(r) => r,
            None => continue, // measurement hiccup — skip this tick, never fatal
        };
        if !reading.over() {
            continue;
        }

        // Over threshold. Respect the cooldown so a surviving leak can't
        // drive a tight reload loop.
        if let Some(t) = last_reload {
            if t.elapsed() < MIN_RELOAD_INTERVAL {
                eprintln!(
                    "[mem-guard] {} {} MB still >= {} MB but within reload cooldown — holding",
                    reading.metric, reading.mb, reading.threshold_mb
                );
                continue;
            }
        }

        // Request a reload of the wallet's OWN webview windows. Mining keeps
        // running (backend-owned); a reload only resets the UI renderer and
        // frees its leaked memory.
        //
        // # Why this is not "every window" (2026-08-21)
        //
        // This module's safety argument is specific and does not generalise:
        // *mining is driven entirely by the Rust backend, so tearing down the
        // DOM loses nothing.* That is true of surfaces this project wrote. It
        // is FALSE of [`SKIP_RELOAD_LABELS`] below, which renders upstream's
        // BasicSwap UI — a reload there discards whatever the user had typed,
        // and the realistic moment for a high RSS threshold to trip is a long
        // session, which is exactly when a half-filled bid form is on screen.
        // Losing a bid form is a bad outcome; losing an in-flight swap is not
        // possible (the engine owns that), but the form is not recoverable.
        //
        // Enumerated by label rather than by "is it the main window" so a
        // future second wallet-owned window keeps the leak protection by
        // default, and only surfaces we do NOT own are opted out.
        //
        // # Vault-lock gate (RAM plan Phase 1.4, 2026-09-22 — F2 fix)
        //
        // Before this, EVERY reload wiped the in-memory vault session
        // unconditionally — `location.reload()` is a full page navigation,
        // so an actively unlocked session got silently logged out by a
        // background memory sweep with zero warning. Rust has no visibility
        // into frontend vault state (it lives entirely in React state, never
        // sent over IPC), so rather than build a new command + AppState
        // field for one boolean, the injected script reads
        // `window.__pwndaVaultUnlocked` — a plain global the frontend
        // mirrors from `sessionPassword` (`AppStateContext.tsx`) — and skips
        // the reload while it is explicitly `true`. Anything else (`false`,
        // `undefined`, or the check itself throwing) is treated as safe to
        // reload: this is the hard safety net the module's own doc comment
        // describes, and it must fail TOWARD its original unconditional
        // behavior, never toward silently becoming a permanent no-op because
        // a future page forgot to set the flag.
        let mut requested = 0usize;
        for (label, win) in app.webview_windows() {
            if SKIP_RELOAD_LABELS.contains(&label.as_str()) {
                eprintln!(
                    "[mem-guard] skipping reload of '{}' — not a wallet-owned surface",
                    label
                );
                continue;
            }
            // Leave a breadcrumb the reloaded UI can read (App.tsx reads +
            // clears `pwnda.memGuardReloadAt` on mount to explain the reload
            // instead of landing on login with zero context) — set only
            // when the reload actually proceeds, so a deferred (vault
            // unlocked) tick never produces a misleading breadcrumb.
            let _ = win.eval(
                "try{\
                   if(window.__pwndaVaultUnlocked===true){\
                     /* vault unlocked — deferred, not reloaded */\
                   }else{\
                     sessionStorage.setItem('pwnda.memGuardReloadAt',String(Date.now()));\
                     window.location.reload();\
                   }\
                 }catch(e){window.location.reload();}",
            );
            requested += 1;
        }
        // We cannot get a return value back from `eval` here (fire-and-
        // forget, same as the breadcrumb write always was), so "requested"
        // vs "actually reloaded" can't be distinguished from the Rust side —
        // logged as a request only.
        if requested > 0 {
            eprintln!(
                "[mem-guard] {} {} MB >= {} MB threshold -> requested a reload on {} window(s) to reclaim renderer memory (skipped for any window whose vault is unlocked; mining unaffected either way)",
                reading.metric, reading.mb, reading.threshold_mb, requested
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

/// RAM plan 3.4 (2026-09-25): which measurement the breaker judges.
#[cfg(test)]
mod pick_reading_tests {
    use super::{pick_reading, DEFAULT_COMMIT_THRESHOLD_MB, DEFAULT_WS_THRESHOLD_MB};

    const C: u64 = DEFAULT_COMMIT_THRESHOLD_MB;
    const W: u64 = DEFAULT_WS_THRESHOLD_MB;

    #[test]
    fn renderer_commit_wins_when_present() {
        // The 2026-09-24 shape: working set trimmed to a few hundred MB,
        // commit in the GB. The old guard read the first number and slept.
        let r = pick_reading(Some(7_400), Some(550), C, W).unwrap();
        assert_eq!(r.metric, "renderer commit");
        assert_eq!(r.mb, 7_400);
        assert!(r.over(), "the leak the breaker exists for must trip it");
    }

    #[test]
    fn falls_back_to_working_set_with_its_own_threshold() {
        let r = pick_reading(None, Some(3_500), C, W).unwrap();
        assert_eq!(r.metric, "webview working set");
        assert_eq!(r.threshold_mb, W);
        assert!(
            !r.over(),
            "3.5 GB of working set is under the 4 GB WS threshold - judging it \
             against the 3 GB COMMIT threshold would reload a healthy window"
        );
    }

    #[test]
    fn nothing_measured_is_no_reading_not_a_zero() {
        assert_eq!(pick_reading(None, None, C, W), None);
    }

    #[test]
    fn a_healthy_renderer_is_under() {
        assert!(!pick_reading(Some(105), Some(160), C, W).unwrap().over());
    }

    #[test]
    fn the_threshold_is_inclusive() {
        assert!(pick_reading(Some(C), None, C, W).unwrap().over());
        assert!(!pick_reading(Some(C - 1), None, C, W).unwrap().over());
    }
}
