//! WebView2 memory-pressure control — drop the renderer to "Low" memory
//! while the window is unfocused / minimized.
//!
//! This is Microsoft's officially-recommended mitigation for WebView2's
//! renderer memory growth (WebView2Feedback #3678 + the "Use memory
//! management APIs" section of the WebView2 performance docs): set
//! `MemoryUsageTargetLevel = Low` when the app goes inactive, restore
//! `Normal` when it becomes active again. Per MS, Low "may prompt the
//! browser engine to drop cached data or swap memory to disk"; scripts keep
//! running, so it composes with our forced `window.gc()` and the canvas
//! chart. It does NOT suspend the process (we still mine + sample in the
//! background), it just tells the engine to trim its working set.
//!
//! Windows-only. On other platforms `attach` is a no-op (WebView2 is the
//! Windows backend; WebKitGTK/macOS don't have this API and don't have the
//! leak). Best-effort throughout — any failure to reach the underlying
//! `ICoreWebView2` is swallowed; memory pressure is an optimization, never
//! load-bearing.

#[cfg(target_os = "windows")]
use tauri::{Manager, WindowEvent};

/// Attach a focus listener to every window so the WebView2 renderer drops to
/// `Low` memory while unfocused and returns to `Normal` on focus. Call once
/// from `lib.rs::setup`.
#[cfg(target_os = "windows")]
pub fn attach(app: &tauri::AppHandle) {
    // Apply to each existing webview window. New windows created later would
    // need their own hook, but PwndaWallet / PwndaLite each have exactly one
    // window created before setup runs, so iterating here covers them.
    for (label, window) in app.webview_windows() {
        let win = window.clone();
        let label = label.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(focused) = event {
                set_level(&win, *focused, &label);
            }
        });
    }
}

#[cfg(not(target_os = "windows"))]
pub fn attach(_app: &tauri::AppHandle) {
    // WebView2-only API; no-op on WebKitGTK / macOS (no such leak there).
}

/// Set the WebView2 memory-usage target level for one window.
/// `active == true` → Normal, `false` → Low. Best-effort.
#[cfg(target_os = "windows")]
fn set_level(window: &tauri::WebviewWindow, active: bool, label: &str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    // Interface::cast must come from windows-core 0.61 (the version
    // webview2-com 0.38's COM types are generated against), NOT our top-level
    // `windows = 0.59` re-export.
    use windows_core::Interface;

    let target = if active {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    };
    let _ = label;

    // `with_webview` hands us the PlatformWebview on the main thread; its
    // `controller()` is the ICoreWebView2Controller, from which we reach the
    // ICoreWebView2 and cast to _19 (where SetMemoryUsageTargetLevel lives,
    // WebView2 Runtime 114+). Older runtimes: the cast fails and we no-op.
    let _ = window.with_webview(move |webview| {
        // SAFETY: the controller is valid for the lifetime of the webview; we
        // only call it synchronously on the UI thread inside this callback.
        // All calls are best-effort and errors are swallowed — memory pressure
        // is an optimization, never load-bearing.
        unsafe {
            let controller = webview.controller();
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let Ok(core19) = core.cast::<ICoreWebView2_19>() else {
                return; // runtime older than 114 — feature absent, fine.
            };
            let _ = core19.SetMemoryUsageTargetLevel(target);
        }
    });
}
