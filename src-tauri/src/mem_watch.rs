//! Native process-tree memory watchdog (dev diagnostics).
//!
//! Background task that samples the resident memory of the app's entire
//! process tree (the main Tauri process + every WebView2 child) once a
//! minute and appends it to a JSONL alongside the dev-fee logs. It exists
//! to make the *native* memory curve visible without any user interaction.
//!
//! Why a Rust-side sampler at all: the frontend `useMemoryTracker`
//! (`src/features/mining/useMemoryTrace.ts`) only sees `performance.memory`
//! — the V8 JS heap. In the 2026-05-29 PwndaLite leak the JS heap stayed
//! flat at ~90 MB while the WebView2 renderer's *native* memory (DOM / IPC
//! buffers / Blink) climbed to ~14 GB over ~9.6 h. Only a process-RSS
//! sampler can capture that curve, and only the host process can read it
//! (the webview can't measure its own renderer's RSS). Pairing this file
//! with the JS-heap trace gives "native climbing, JS flat" on disk after
//! any session — the proof, captured automatically.
//!
//! Each line also carries the total Tauri-event emit count (from
//! `emit_meter`) so one file shows both the symptom (native growth) and
//! whether an IPC-emit firehose is contributing.
//!
//! **Dev-only by default.** `start()` no-ops unless this is a debug build
//! (`cfg!(debug_assertions)`), or `PWNDA_MEM_WATCH=1` is set to force-enable
//! it in a packaged binary for a one-off native-leak hunt. It never writes
//! files in a normal release build.
//!
//! **Windows-only sampler** (WebView2 is Windows; the WebKitGTK/macOS
//! backends don't have this leak). On other platforms `start` compiles to
//! a no-op so Linux/macOS release builds stay green.
//!
//! Cross-reference: `wiki/concepts/webview2-memory-management.md`.

use serde::Serialize;

/// Sampling cadence. 1/min matches the frontend `useMemoryTracker` so the
/// two curves (native tree RSS vs V8 heap) line up minute-for-minute.
/// Windows-only — the sampler that reads it is gated to Windows.
#[cfg(target_os = "windows")]
const SAMPLE_INTERVAL_SECS: u64 = 60;

/// One native-memory sample. MB for human readability; `t` is Unix ms
/// (UTC) so it overlays directly on the `pwnda.memoryTrace.v1` JS-heap
/// samples the frontend already records.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemSample {
    /// Unix ms (UTC).
    pub t: i64,
    /// RSS of the main Tauri process alone (MB).
    pub main_mb: f64,
    /// RSS of the whole process tree rooted at the app (MB) — main + every
    /// WebView2 / GPU / utility child. This is the number that grows when
    /// the renderer leaks; compare it against the flat JS-heap trace.
    pub tree_mb: f64,
    /// RSS of just the WebView2 processes within the tree (MB).
    pub webview_mb: f64,
    /// Number of processes summed into `tree_mb`.
    pub proc_count: usize,
    /// Total Tauri-event emits across ALL event names since process start
    /// (from `emit_meter`). A native-leak firehose shows up here as a
    /// fast-climbing total.
    pub emit_total: u64,
    /// Top emitters by event name, `"name=count, …"` highest first. Names the
    /// firehose so a leak hunt doesn't have to guess which `app.emit` is hot.
    pub emit_top: String,
}

/// Latest sample, for the on-demand `mem_watch_status` command. Declared
/// unconditionally so the command compiles on every platform; only the
/// Windows sampler ever writes it.
static LATEST: std::sync::Mutex<Option<MemSample>> = std::sync::Mutex::new(None);

/// On-demand read of the most recent native-memory sample. `None` until
/// the first sample lands (~immediately after startup) or when the
/// watchdog is disabled (release build / non-Windows / no env override).
#[tauri::command]
pub async fn mem_watch_status() -> Result<Option<MemSample>, String> {
    Ok(LATEST.lock().ok().and_then(|g| g.clone()))
}

/// The most recent sampled WebView2-renderer RSS in MB, or `None` if no
/// sample has landed yet (or the sampler is disabled — it only runs in debug
/// builds / under `PWNDA_MEM_WATCH=1`). `mem_guard` reads this instead of
/// doing its own native process walk: the circuit-breaker shares the
/// sampler's one SAFE measurement rather than a hand-rolled `unsafe` FFI
/// (which corrupted the heap — `STATUS_HEAP_CORRUPTION` on startup, 2026-06-03).
pub fn latest_webview_mb() -> Option<u64> {
    LATEST
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.webview_mb as u64))
}

/// Append one FRONTEND memory sample (JS heap + DOM/SVG node counts + the
/// active view, from `useMemoryTracker`) to `mem-frontend-<session>.jsonl`,
/// next to the native `mem-native-*.jsonl`. The two overlay by their `t`
/// (Unix ms): if `domNodes`/`svgNodes` climb in lockstep with the native
/// `webviewMb` curve it's DOM-node accumulation (a fixable React leak); if
/// they stay flat while `webviewMb` climbs it's compositing/GPU growth (fix
/// the render). Added 2026-06-02 to localize the residual focused-climb that
/// survived the canvas fix. Same dev-only gate as the native sampler
/// (`cfg!(debug_assertions)` or `PWNDA_MEM_WATCH=1`) so release builds write
/// nothing. Cross-platform (the frontend calls it everywhere); best-effort —
/// never fails the caller.
#[tauri::command]
pub fn mem_frontend_log(app: tauri::AppHandle, sample: serde_json::Value) {
    use std::io::Write;
    use tauri::Manager;
    let enabled = cfg!(debug_assertions)
        || matches!(
            std::env::var("PWNDA_MEM_WATCH").as_deref(),
            Ok("1") | Ok("true") | Ok("on")
        );
    if !enabled {
        return;
    }
    // Resolve the per-process session file once.
    static PATH: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    let path = PATH.get_or_init(|| {
        let dir = app.path().app_log_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        Some(dir.join(format!("mem-frontend-{}.jsonl", stamp)))
    });
    let Some(path) = path.as_ref() else { return };
    if let Ok(line) = serde_json::to_string(&sample) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
            let _ = f.write_all(b"\n");
        }
    }
}

#[cfg(target_os = "windows")]
pub fn start(app: tauri::AppHandle) {
    // Dev-only by default. Spawning PowerShell once a minute + writing a
    // JSONL is a debugging affordance, not shipped behavior. Force-enable
    // in a release build with PWNDA_MEM_WATCH=1 if you ever need to chase
    // a native-memory leak in a packaged binary.
    let enabled = cfg!(debug_assertions)
        || matches!(
            std::env::var("PWNDA_MEM_WATCH").as_deref(),
            Ok("1") | Ok("true") | Ok("on")
        );
    if !enabled {
        return;
    }
    tauri::async_runtime::spawn(async move { run(app).await });
}

#[cfg(not(target_os = "windows"))]
pub fn start(_app: tauri::AppHandle) {
    // WebView2 is Windows-only; the native-memory leak this watches for
    // doesn't exist on the WebKitGTK / macOS backends. No-op so cross-
    // platform (e.g. the Linux release-build pipeline) stays green.
}

#[cfg(target_os = "windows")]
async fn run(app: tauri::AppHandle) {
    use std::io::Write;
    use tauri::Manager;

    // Write next to the dev-fee JSONLs so all session diagnostics live in
    // one place.
    let dir = match app.path().app_log_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[mem-watch] no app_log_dir; watchdog disabled: {}", e);
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[mem-watch] cannot create log dir; disabled: {}", e);
        return;
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let path = dir.join(format!("mem-native-{}.jsonl", stamp));
    eprintln!(
        "[mem-watch] sampling process-tree RSS every {}s -> {}",
        SAMPLE_INTERVAL_SECS,
        path.display()
    );

    let mut ticker =
        tokio::time::interval(std::time::Duration::from_secs(SAMPLE_INTERVAL_SECS));
    loop {
        // First tick fires immediately, so the trace has a data point at
        // startup; subsequent ticks at the interval cadence.
        ticker.tick().await;
        let sample = match sample_tree().await {
            Some(s) => s,
            None => continue,
        };
        if let Ok(mut g) = LATEST.lock() {
            *g = Some(sample.clone());
        }
        // Append one JSONL line. Best-effort; a write failure is non-fatal
        // and must never interrupt mining.
        if let Ok(line) = serde_json::to_string(&sample) {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = f.write_all(line.as_bytes());
                let _ = f.write_all(b"\n");
            }
        }
    }
}

/// Sample the RSS of our process tree via a single `Get-CimInstance
/// Win32_Process` call. Returns `None` on any failure (PowerShell missing,
/// WMI hiccup, parse error) so the caller simply skips that minute — the
/// watchdog never crashes or blocks mining.
#[cfg(target_os = "windows")]
async fn sample_tree() -> Option<MemSample> {
    use std::collections::{HashMap, HashSet};

    // Hidden-window flag — same pattern device_info.rs uses for its WMI
    // queries so no console window flashes during a session.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Json -Compress",
    ]);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    // PS 5.1 serialises a single row as `{...}` and multiple as `[{...}]`.
    let rows: Vec<serde_json::Value> = match v {
        serde_json::Value::Array(a) => a,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => return None,
    };

    let mut ws: HashMap<u32, u64> = HashMap::new();
    let mut name: HashMap<u32, String> = HashMap::new();
    let mut by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in &rows {
        let pid = match r.get("ProcessId").and_then(|x| x.as_u64()) {
            Some(p) => p as u32,
            None => continue,
        };
        let wss = r
            .get("WorkingSetSize")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let nm = r
            .get("Name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        ws.insert(pid, wss);
        name.insert(pid, nm);
        if let Some(ppid) = r.get("ParentProcessId").and_then(|x| x.as_u64()) {
            by_parent.entry(ppid as u32).or_default().push(pid);
        }
    }

    // BFS over the descendants of our own process (inclusive). Restricting
    // to our subtree means a second app instance (e.g. the full wallet
    // running alongside PwndaLite) is never conflated into this number.
    let our = std::process::id();
    let mut visited: HashSet<u32> = HashSet::new();
    let mut queue = vec![our];
    let mut tree_bytes: u64 = 0;
    let mut webview_bytes: u64 = 0;
    let mut count = 0usize;
    while let Some(pid) = queue.pop() {
        if !visited.insert(pid) {
            continue; // cycle / already counted
        }
        let b = ws.get(&pid).copied().unwrap_or(0);
        tree_bytes += b;
        count += 1;
        if name
            .get(&pid)
            .map(|n| n.to_ascii_lowercase().contains("webview2"))
            .unwrap_or(false)
        {
            webview_bytes += b;
        }
        if let Some(kids) = by_parent.get(&pid) {
            for k in kids {
                if !visited.contains(k) {
                    queue.push(*k);
                }
            }
        }
    }

    let to_mb = |b: u64| (b as f64) / 1024.0 / 1024.0;

    Some(MemSample {
        t: chrono::Utc::now().timestamp_millis(),
        main_mb: to_mb(ws.get(&our).copied().unwrap_or(0)),
        tree_mb: to_mb(tree_bytes),
        webview_mb: to_mb(webview_bytes),
        proc_count: count,
        emit_total: crate::emit_meter::total(),
        emit_top: crate::emit_meter::top_summary(8),
    })
}
