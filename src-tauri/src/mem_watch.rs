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
    /// RAM plan Phase 0.2 (2026-09-22): `tree_mb` broken down by functional
    /// role, so a session can answer "who's actually using the RAM" without
    /// re-deriving it from `by_name` by hand. Always sums to `tree_mb` ±
    /// float rounding — every counted pid lands in exactly one bucket.
    pub by_role: RoleBreakdown,
    /// Top 10 processes by RSS within the tree, for the cases `by_role`'s
    /// five buckets are too coarse (e.g. "which webview2.exe child").
    pub by_name: Vec<NameMb>,
    /// RAM plan Phase 0.1 (2026-09-22): children rejected during the tree
    /// walk because their WMI `CreationDate` predated their claimed
    /// parent's — the PID-reuse signature (F1: a foreign process that
    /// reused a dead child's pid gets silently adopted into the tree). A
    /// non-zero value here on an otherwise-stable host is the fix
    /// firing, not a bug — see `aggregate_tree`.
    pub skipped_reused_pids: usize,
    /// Total Tauri-event emits across ALL event names since process start
    /// (from `emit_meter`). A native-leak firehose shows up here as a
    /// fast-climbing total.
    pub emit_total: u64,
    /// Top emitters by event name, `"name=count, …"` highest first. Names the
    /// firehose so a leak hunt doesn't have to guess which `app.emit` is hot.
    pub emit_top: String,
    /// RAM plan Phase 2M.5 (2026-09-23): emits per minute since the PREVIOUS
    /// sample - the rate, not the running total. `emit_total` only shows a
    /// firehose to someone who subtracts two lines by hand; this is the number
    /// the budget below is checked against. `0` on the first sample.
    pub emit_per_min: u64,
    /// RAM plan 3.4 (2026-09-25): COMMITTED memory (WMI `PrivatePageCount`,
    /// Task Manager's "Commit size") of the whole tree, MB. Every `*Mb` field
    /// above is the WORKING SET, which `MemoryUsageLevel::Low` trims whenever
    /// the window loses focus - the 2026-09-24 trace watched a renderer sit at
    /// 7.4 GB committed while its working set read a few hundred MB. Commit is
    /// what the pagefile has to back, so it is the number that shows a leak.
    pub tree_commit_mb: f64,
    /// Commit of just the WebView2 processes (MB).
    pub webview_commit_mb: f64,
    /// `by_role`, in commit instead of working set.
    pub commit_by_role: RoleBreakdown,
    /// WebView2 processes split by Chromium process type (`browser`,
    /// `renderer`, `gpu-process`, `utility`, `crashpad-handler`), largest
    /// commit first. Names WHICH webview process grows, which `by_role` can't.
    pub webview_by_type: Vec<WebviewTypeMb>,
    /// Commit of the LARGEST single renderer process (MB) - what `mem_guard`
    /// guards. The largest rather than the sum: the `bsx-console` window
    /// (upstream's BasicSwap UI, never reloaded) has its own renderer, and a
    /// sum would let its growth trigger reloads of a window that is not the
    /// one growing. `None` when no row could be typed as a renderer (WMI gave
    /// no command line), so the guard falls back to the working set.
    pub renderer_commit_mb: Option<f64>,
}

/// One WebView2 process type within the tree (RAM plan 3.4).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebviewTypeMb {
    /// Chromium `--type=` value; `browser` for the process that has none.
    pub kind: String,
    pub count: usize,
    pub ws_mb: f64,
    pub commit_mb: f64,
    /// Largest single process of this type, by commit.
    pub max_commit_mb: f64,
}

/// Backend-to-frontend event budget, emits per minute (RAM plan Phase 2M.5).
///
/// Rounds 3, 4 and 7 of the WebView2 leak hunt were each an event firehose
/// that looked fine until it was not, and tauri-apps/tauri#12724 measured ~2 M
/// emits costing ~1.1 GB. The healthy baseline here is a handful of emits in
/// total (`emit_total` read 4 in the 2026-09-22 review), so one per second is
/// generous - yet at that rate a day is ~86 k emits, still well under the
/// order of magnitude that issue reports. A breach is logged loudly by the
/// sampler; it does not throttle anything.
pub const EMIT_BUDGET_PER_MIN: u64 = 60;

/// Emits per minute between two samples. Pure so the budget arithmetic is
/// testable. `0` when the clock did not advance or the counter went backwards
/// (a restarted process), never a wrapped huge number.
pub fn emit_rate_per_min(prev_total: u64, total: u64, elapsed_ms: i64) -> u64 {
    if elapsed_ms <= 0 || total < prev_total {
        return 0;
    }
    ((total - prev_total) as u128 * 60_000 / elapsed_ms as u128) as u64
}

/// Is `rate` (emits/min) over [`EMIT_BUDGET_PER_MIN`]?
pub fn over_emit_budget(rate: u64) -> bool {
    rate > EMIT_BUDGET_PER_MIN
}

/// Per-role memory breakdown (Phase 0.2). Fixed five-way partition —
/// extend `classify_role` when a new coin daemon or sidecar binary is
/// introduced, rather than adding a bucket here.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoleBreakdown {
    pub webview_mb: f64,
    pub miners_mb: f64,
    pub wallet_rpc_mb: f64,
    pub swap_node_mb: f64,
    pub other_mb: f64,
}

/// One entry in the top-10-by-name breakdown (Phase 0.2).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NameMb {
    pub name: String,
    pub mb: f64,
    pub count: usize,
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

/// The most recent commit of the largest WebView2 renderer, MB (RAM plan 3.4).
/// `None` until a sample lands, when the sampler is disabled, or when the
/// sample could not type any process as a renderer - `mem_guard` then falls
/// back to [`latest_webview_mb`].
pub fn latest_renderer_commit_mb() -> Option<u64> {
    LATEST
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|s| s.renderer_commit_mb.map(|mb| mb as u64)))
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
    // (emit_total, t) of the previous sample, for the per-minute rate.
    let mut prev_emit: Option<(u64, i64)> = None;
    loop {
        // First tick fires immediately, so the trace has a data point at
        // startup; subsequent ticks at the interval cadence.
        ticker.tick().await;
        let mut sample = match sample_tree().await {
            Some(s) => s,
            None => continue,
        };
        if let Some((prev_total, prev_t)) = prev_emit {
            sample.emit_per_min = emit_rate_per_min(prev_total, sample.emit_total, sample.t - prev_t);
            if over_emit_budget(sample.emit_per_min) {
                eprintln!(
                    "[mem-watch] EMIT BUDGET EXCEEDED: {}/min > {}/min (top: {}) - an app.emit \
                     firehose is a known WebView2 renderer-leak source (Rounds 3/4/7)",
                    sample.emit_per_min, EMIT_BUDGET_PER_MIN, sample.emit_top
                );
            }
        }
        prev_emit = Some((sample.emit_total, sample.t));
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
/// One row of the parsed `Get-CimInstance Win32_Process` snapshot. Split out
/// of `sample_tree` so the tree-walk + role/name aggregation below
/// (`aggregate_tree`) is a pure function, testable with a synthetic table,
/// independent of the PowerShell shell-out — which only exists on Windows
/// and can't run in CI.
#[derive(Debug, Clone)]
struct ProcessRow {
    pid: u32,
    ppid: u32,
    ws_bytes: u64,
    name: String,
    /// Unix ms the process was created, from WMI `CreationDate`. `0` means
    /// WMI gave us no value — treated as "unknown", never as "created at
    /// the epoch": a `0` must never let a genuine child get rejected by the
    /// PID-reuse guard just because one side's timestamp is missing.
    created_ms: i64,
    /// Committed bytes, WMI `PrivatePageCount` (RAM plan 3.4). Bytes despite
    /// the name - a fresh renderer reads ~100 MB, not ~400 GB.
    commit_bytes: u64,
    /// Chromium process type for a WebView2 row (`renderer`, `gpu-process`,
    /// ..., `browser` when the command line has no `--type=`); `None` for
    /// every other process, and for a WebView2 row whose command line WMI
    /// did not return.
    wv_type: Option<String>,
}

/// Result of one `aggregate_tree` walk.
#[derive(Debug, Clone, Default, PartialEq)]
struct TreeAggregate {
    tree_bytes: u64,
    webview_bytes: u64,
    proc_count: usize,
    by_role: RoleBreakdown,
    by_name: Vec<NameMb>,
    /// Children rejected because their `created_ms` predated their claimed
    /// parent's (Phase 0.1's PID-reuse guard). Each rejection cuts off that
    /// pid's WHOLE subtree, not just the one row — a foreign process's own
    /// children are foreign too.
    skipped_reused: usize,
    // RAM plan 3.4: the same walk, in committed bytes.
    tree_commit_bytes: u64,
    webview_commit_bytes: u64,
    commit_by_role: RoleBreakdown,
    webview_by_type: Vec<WebviewTypeMb>,
    /// Largest single renderer's commit; `None` if no row was typed renderer.
    renderer_max_commit_bytes: Option<u64>,
}

fn mb(b: u64) -> f64 {
    (b as f64) / 1024.0 / 1024.0
}

/// Best-effort role classification for the `byRole` breakdown (Phase 0.2).
/// Not exhaustive by coin — extend the name lists when a new coin daemon or
/// sidecar binary is introduced. `byRole` sums to `tree_mb` by construction
/// regardless (every pid gets exactly one bucket); getting one PARTICULAR
/// pid into the wrong bucket only affects readability, not that invariant.
fn classify_role(name_lower: &str) -> &'static str {
    // Chain daemons BasicSwap can spawn for `DEFAULT_ENABLED_COINS`
    // (particl, monero, bitcoin, litecoin, bitcoincash). bitcoincash reuses
    // the stock `bitcoind` binary (seeded into its own bin folder under a
    // different path, same executable name) — no separate entry needed.
    // zephyr/zano are `HOST_MANAGED_DAEMON_COINS`: no local daemon, their
    // process IS the wallet-rpc entry below.
    const DAEMON_NAMES: &[&str] = &["particld", "monerod", "bitcoind", "litecoind"];
    const MINER_NAMES: &[&str] = &["xmrig", "srbminer"];
    const WALLET_RPC_NAMES: &[&str] = &["wallet-rpc", "simplewallet", "xelis_wallet"];

    if name_lower.contains("webview2") {
        return "webview";
    }
    if MINER_NAMES.iter().any(|m| name_lower.contains(m)) {
        return "miners";
    }
    if WALLET_RPC_NAMES.iter().any(|m| name_lower.contains(m)) {
        return "wallet-rpc";
    }
    // python(.exe) within OUR subtree is, in practice, only ever the
    // BasicSwap engine's bundled interpreter — the tree walk starts from
    // `our` pid, so an unrelated system Python cannot appear here.
    if DAEMON_NAMES.iter().any(|d| name_lower.contains(d))
        || name_lower.contains("basicswap")
        || name_lower == "python.exe"
        || name_lower == "python"
    {
        return "swap-node";
    }
    "other"
}

/// Walk the process tree rooted at `our` (inclusive), guarding against
/// Windows PID reuse (Phase 0.1): a row is only accepted as `parent`'s
/// child if its `created_ms` is not earlier than the parent's — a genuine
/// child cannot predate its own parent. Pure and platform-independent, so
/// it's exercised with a synthetic table in tests; the only Windows-only
/// code is the PowerShell shell-out in `sample_tree` that builds `rows`.
fn aggregate_tree(rows: &[ProcessRow], our: u32) -> TreeAggregate {
    use std::collections::{HashMap, HashSet};

    let mut ws: HashMap<u32, u64> = HashMap::new();
    let mut commit: HashMap<u32, u64> = HashMap::new();
    let mut wv_type: HashMap<u32, String> = HashMap::new();
    let mut name: HashMap<u32, String> = HashMap::new();
    let mut created: HashMap<u32, i64> = HashMap::new();
    let mut by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in rows {
        ws.insert(r.pid, r.ws_bytes);
        commit.insert(r.pid, r.commit_bytes);
        if let Some(t) = &r.wv_type {
            wv_type.insert(r.pid, t.clone());
        }
        name.insert(r.pid, r.name.clone());
        created.insert(r.pid, r.created_ms);
        by_parent.entry(r.ppid).or_default().push(r.pid);
    }

    let mut agg = TreeAggregate::default();
    let mut by_name_bytes: HashMap<String, (u64, usize)> = HashMap::new();
    // kind -> (count, ws bytes, commit bytes, largest commit bytes)
    let mut by_type: HashMap<String, (usize, u64, u64, u64)> = HashMap::new();
    let mut visited: HashSet<u32> = HashSet::new();
    let mut queue = vec![our];
    while let Some(pid) = queue.pop() {
        if !visited.insert(pid) {
            continue; // cycle / already counted
        }
        let b = ws.get(&pid).copied().unwrap_or(0);
        let c = commit.get(&pid).copied().unwrap_or(0);
        agg.tree_bytes += b;
        agg.tree_commit_bytes += c;
        agg.proc_count += 1;
        let nm = name.get(&pid).cloned().unwrap_or_default();
        let nm_lower = nm.to_ascii_lowercase();
        match classify_role(&nm_lower) {
            "webview" => {
                agg.by_role.webview_mb += mb(b);
                agg.commit_by_role.webview_mb += mb(c);
                agg.webview_bytes += b;
                agg.webview_commit_bytes += c;
                if let Some(kind) = wv_type.get(&pid) {
                    let t = by_type.entry(kind.clone()).or_insert((0, 0, 0, 0));
                    t.0 += 1;
                    t.1 += b;
                    t.2 += c;
                    t.3 = t.3.max(c);
                    if kind == "renderer" {
                        agg.renderer_max_commit_bytes =
                            Some(agg.renderer_max_commit_bytes.unwrap_or(0).max(c));
                    }
                }
            }
            "miners" => {
                agg.by_role.miners_mb += mb(b);
                agg.commit_by_role.miners_mb += mb(c);
            }
            "wallet-rpc" => {
                agg.by_role.wallet_rpc_mb += mb(b);
                agg.commit_by_role.wallet_rpc_mb += mb(c);
            }
            "swap-node" => {
                agg.by_role.swap_node_mb += mb(b);
                agg.commit_by_role.swap_node_mb += mb(c);
            }
            _ => {
                agg.by_role.other_mb += mb(b);
                agg.commit_by_role.other_mb += mb(c);
            }
        }
        let entry = by_name_bytes.entry(nm).or_insert((0, 0));
        entry.0 += b;
        entry.1 += 1;

        if let Some(kids) = by_parent.get(&pid) {
            let parent_created = created.get(&pid).copied().unwrap_or(0);
            for k in kids {
                if visited.contains(k) {
                    continue;
                }
                let kid_created = created.get(k).copied().unwrap_or(0);
                if parent_created != 0 && kid_created != 0 && kid_created < parent_created {
                    // The claimed child existed BEFORE its claimed parent —
                    // impossible for a real child. This pid is a foreign
                    // process that happens to have been assigned our
                    // subtree's stale, reused pid. Cut the whole subtree.
                    agg.skipped_reused += 1;
                    continue;
                }
                queue.push(*k);
            }
        }
    }

    let mut by_name: Vec<NameMb> = by_name_bytes
        .into_iter()
        .map(|(name, (bytes, count))| NameMb { name, mb: mb(bytes), count })
        .collect();
    by_name.sort_by(|a, b| b.mb.partial_cmp(&a.mb).unwrap_or(std::cmp::Ordering::Equal));
    by_name.truncate(10);
    agg.by_name = by_name;

    let mut webview_by_type: Vec<WebviewTypeMb> = by_type
        .into_iter()
        .map(|(kind, (count, w, c, max_c))| WebviewTypeMb {
            kind,
            count,
            ws_mb: mb(w),
            commit_mb: mb(c),
            max_commit_mb: mb(max_c),
        })
        .collect();
    webview_by_type.sort_by(|a, b| {
        b.commit_mb
            .partial_cmp(&a.commit_mb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.kind.cmp(&b.kind))
    });
    agg.webview_by_type = webview_by_type;

    agg
}

/// Chromium process type from a WebView2 command line (RAM plan 3.4):
/// the `--type=` value, or `browser` for the one process launched without
/// it. Pure so the PowerShell side can stay a dumb row dump - the query
/// returns `CommandLine` only for WebView2 rows, and this does the parsing.
fn webview_type_from_cmdline(cmdline: &str) -> String {
    cmdline
        .split_whitespace()
        .find_map(|arg| arg.trim_matches('"').strip_prefix("--type="))
        .map(|t| t.to_string())
        .unwrap_or_else(|| "browser".to_string())
}

#[cfg(target_os = "windows")]
async fn sample_tree() -> Option<MemSample> {
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
        // `CreationDate` (Phase 0.1, PID-reuse guard) and `SelfPid` (Phase
        // 0.3's sibling fix — exclude the sampler's OWN transient
        // powershell.exe from the tree it's measuring) added 2026-09-22.
        // NOTE: `Get-CimInstance`'s `CreationDate` is already a
        // `[DateTime]`, not a WMI datetime STRING — an earlier draft piped
        // it through `[Management.ManagementDateTimeConverter]::ToDateTime`
        // (which expects a string) and got a silent `$null` back for every
        // row, verified live before shipping this. Use `.CreationDate`
        // directly.
        //
        // `PrivatePageCount` (commit) and `Cmd` added 2026-09-25 (RAM plan
        // 3.4). `Cmd` is the command line of WebView2 rows ONLY - it carries
        // the Chromium `--type=` that tells the renderer from the GPU process;
        // every other row gets `$null` so the JSON does not carry ~500 command
        // lines a minute. This exact string was dry-run on the dev host before
        // shipping: 535 rows, every WebView2 row typed (browser / renderer /
        // gpu-process / utility / crashpad-handler), no command line on any
        // other row, `PrivatePageCount` in bytes, ~91 KB of JSON.
        "$epoch=[datetime]'1970-01-01Z';\
         $rows=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,Name,\
         @{N='CreatedMs';E={ if($_.CreationDate){[long]($_.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds}else{0} }},\
         @{N='Cmd';E={ if($_.Name -like 'msedgewebview2*'){$_.CommandLine}else{$null} }};\
         [PSCustomObject]@{Rows=$rows;SelfPid=$PID} | ConvertTo-Json -Compress -Depth 4",
    ]);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let self_ps_pid = v.get("SelfPid").and_then(|x| x.as_u64()).map(|p| p as u32);
    // PS 5.1 serialises a single row as `{...}` and multiple as `[{...}]`.
    let raw_rows: Vec<serde_json::Value> = match v.get("Rows") {
        Some(serde_json::Value::Array(a)) => a.clone(),
        Some(obj @ serde_json::Value::Object(_)) => vec![obj.clone()],
        _ => return None,
    };

    let rows: Vec<ProcessRow> = raw_rows
        .iter()
        .filter_map(|r| {
            let pid = r.get("ProcessId").and_then(|x| x.as_u64())? as u32;
            if Some(pid) == self_ps_pid {
                return None; // exclude the sampler's own transient powershell.exe
            }
            let ppid = r
                .get("ParentProcessId")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32;
            Some(ProcessRow {
                pid,
                ppid,
                ws_bytes: r.get("WorkingSetSize").and_then(|x| x.as_u64()).unwrap_or(0),
                name: r.get("Name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                created_ms: r.get("CreatedMs").and_then(|x| x.as_i64()).unwrap_or(0),
                commit_bytes: r.get("PrivatePageCount").and_then(|x| x.as_u64()).unwrap_or(0),
                wv_type: r
                    .get("Cmd")
                    .and_then(|x| x.as_str())
                    .map(webview_type_from_cmdline),
            })
        })
        .collect();

    // BFS over the descendants of our own process (inclusive). Restricting
    // to our subtree means a second app instance (e.g. the full wallet
    // running alongside PwndaLite) is never conflated into this number.
    let our = std::process::id();
    let agg = aggregate_tree(&rows, our);
    let our_ws = rows.iter().find(|r| r.pid == our).map(|r| r.ws_bytes).unwrap_or(0);

    Some(MemSample {
        t: chrono::Utc::now().timestamp_millis(),
        main_mb: mb(our_ws),
        tree_mb: mb(agg.tree_bytes),
        webview_mb: mb(agg.webview_bytes),
        proc_count: agg.proc_count,
        by_role: agg.by_role,
        by_name: agg.by_name,
        skipped_reused_pids: agg.skipped_reused,
        emit_total: crate::emit_meter::total(),
        emit_top: crate::emit_meter::top_summary(8),
        // Filled in by `run`, which is the only place that has the previous
        // sample to subtract from.
        emit_per_min: 0,
        tree_commit_mb: mb(agg.tree_commit_bytes),
        webview_commit_mb: mb(agg.webview_commit_bytes),
        commit_by_role: agg.commit_by_role,
        webview_by_type: agg.webview_by_type,
        renderer_commit_mb: agg.renderer_max_commit_bytes.map(mb),
    })
}

#[cfg(test)]
mod aggregate_tree_tests {
    use super::*;

    fn row(pid: u32, ppid: u32, mb: u64, name: &str, created_ms: i64) -> ProcessRow {
        ProcessRow {
            pid,
            ppid,
            ws_bytes: mb * 1024 * 1024,
            name: name.to_string(),
            created_ms,
            commit_bytes: mb * 1024 * 1024,
            wv_type: None,
        }
    }

    /// A typed WebView2 row whose working set and commit differ - the whole
    /// point of 3.4 is that they can.
    fn wv(pid: u32, ppid: u32, ws_mb: u64, commit_mb: u64, kind: &str) -> ProcessRow {
        ProcessRow {
            pid,
            ppid,
            ws_bytes: ws_mb * 1024 * 1024,
            name: "msedgewebview2.exe".to_string(),
            created_ms: 1010,
            commit_bytes: commit_mb * 1024 * 1024,
            wv_type: Some(kind.to_string()),
        }
    }

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn a_trimmed_renderer_shows_its_leak_in_commit_not_working_set() {
        // The 2026-09-24 shape: blur trimmed the renderer's working set to a
        // few hundred MB while its commit sat in the GB.
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            wv(101, 100, 150, 50, "browser"),
            wv(102, 101, 300, 7_400, "renderer"),
            wv(103, 101, 100, 110, "gpu-process"),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.webview_bytes, 550 * MIB, "working set barely moves");
        assert_eq!(agg.webview_commit_bytes, 7_560 * MIB, "commit carries the leak");
        assert_eq!(agg.tree_commit_bytes, 7_610 * MIB);
        assert_eq!(agg.renderer_max_commit_bytes, Some(7_400 * MIB));
    }

    #[test]
    fn the_guarded_renderer_is_the_largest_one_not_the_sum() {
        // Two renderers: ours and the bsx-console window's. A sum would
        // reload our window for the other one's growth.
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            wv(101, 100, 150, 50, "browser"),
            wv(102, 101, 200, 900, "renderer"),
            wv(103, 101, 200, 300, "renderer"),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.renderer_max_commit_bytes, Some(900 * MIB));
        let r = agg.webview_by_type.iter().find(|t| t.kind == "renderer").unwrap();
        assert_eq!(r.count, 2);
        assert!((r.commit_mb - 1_200.0).abs() < 0.001);
        assert!((r.max_commit_mb - 900.0).abs() < 0.001);
    }

    #[test]
    fn a_gpu_process_never_counts_as_the_renderer() {
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            wv(101, 100, 150, 50, "browser"),
            wv(102, 101, 100, 5_000, "gpu-process"),
            wv(103, 101, 100, 200, "renderer"),
        ];
        assert_eq!(aggregate_tree(&rows, 100).renderer_max_commit_bytes, Some(200 * MIB));
    }

    #[test]
    fn no_typed_renderer_means_none_so_the_guard_falls_back() {
        // WMI returned no command line: the rows are webview by NAME but
        // untyped. `None`, never `Some(0)` - a zero would read as "healthy"
        // and silently disarm the breaker.
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            row(101, 100, 900, "msedgewebview2.exe", 1010),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.renderer_max_commit_bytes, None);
        assert!(agg.webview_by_type.is_empty());
        assert_eq!(agg.webview_bytes, 900 * MIB, "working-set path unchanged");
    }

    #[test]
    fn commit_by_role_sums_to_tree_commit() {
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            wv(101, 100, 150, 60, "browser"),
            wv(102, 101, 300, 700, "renderer"),
            row(103, 100, 10, "xmrig.exe", 1010),
            row(104, 100, 60, "monero-wallet-rpc.exe", 1010),
            row(105, 100, 40, "particld.exe", 1010),
        ];
        let agg = aggregate_tree(&rows, 100);
        let c = &agg.commit_by_role;
        let total = c.webview_mb + c.miners_mb + c.wallet_rpc_mb + c.swap_node_mb + c.other_mb;
        assert!((total - mb(agg.tree_commit_bytes)).abs() < 0.001);
        assert!((c.webview_mb - 760.0).abs() < 0.001);
        assert!((c.other_mb - 50.0).abs() < 0.001);
    }

    #[test]
    fn webview_by_type_is_largest_commit_first() {
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            wv(101, 100, 150, 50, "browser"),
            wv(102, 101, 300, 700, "renderer"),
            wv(103, 101, 100, 110, "gpu-process"),
            wv(104, 101, 40, 15, "utility"),
            wv(105, 101, 20, 10, "utility"),
        ];
        let kinds: Vec<_> = aggregate_tree(&rows, 100)
            .webview_by_type
            .into_iter()
            .map(|t| (t.kind, t.count))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("renderer".to_string(), 1),
                ("gpu-process".to_string(), 1),
                ("browser".to_string(), 1),
                ("utility".to_string(), 2),
            ]
        );
    }

    #[test]
    fn webview_type_is_read_from_the_command_line() {
        let exe = r#""C:\Program Files (x86)\Microsoft\EdgeWebView\Application\153.0\msedgewebview2.exe""#;
        assert_eq!(
            webview_type_from_cmdline(&format!("{exe} --type=renderer --lang=en-US --js-flags=--expose-gc")),
            "renderer"
        );
        assert_eq!(
            webview_type_from_cmdline(&format!("{exe} --type=utility --utility-sub-type=network.mojom.NetworkService")),
            "utility",
            "--utility-sub-type= must not be mistaken for --type="
        );
        assert_eq!(
            webview_type_from_cmdline(&format!("{exe} --embedded-browser-webview=1 --webview-exe-name=x.exe")),
            "browser",
            "the one process without --type= is the browser process"
        );
    }

    #[test]
    fn sums_a_normal_three_level_tree() {
        // our(100) -> webview2.exe(101) -> webview2.exe(102)
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            row(101, 100, 300, "msedgewebview2.exe", 1010),
            row(102, 101, 200, "msedgewebview2.exe", 1020),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.proc_count, 3);
        assert_eq!(agg.tree_bytes, 550 * 1024 * 1024);
        assert_eq!(agg.webview_bytes, 500 * 1024 * 1024);
        assert_eq!(agg.skipped_reused, 0);
    }

    #[test]
    fn pid_reuse_cuts_off_the_whole_foreign_subtree() {
        // our(100) claims child 999, but 999's CreationDate (500) predates
        // our own (1000) — 999 is a DIFFERENT, older process that merely
        // reused a pid our real child used to hold. Its own child 998 must
        // be excluded too, not just 999 itself.
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            row(999, 100, 400, "some-unrelated.exe", 500),
            row(998, 999, 100, "unrelated-child.exe", 510),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.proc_count, 1, "only `our` itself should be counted");
        assert_eq!(agg.tree_bytes, 50 * 1024 * 1024);
        assert_eq!(agg.skipped_reused, 1);
    }

    #[test]
    fn missing_creation_date_on_either_side_does_not_reject_a_child() {
        // `created_ms == 0` means "WMI gave us nothing", not "created at
        // the epoch" — a real child must still be counted when either
        // timestamp is unavailable.
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 0),
            row(101, 100, 300, "msedgewebview2.exe", 1010),
            row(102, 100, 10, "xmrig.exe", 0),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.proc_count, 3);
        assert_eq!(agg.skipped_reused, 0);
    }

    #[test]
    fn equal_creation_timestamps_are_accepted() {
        // A child created in the same WMI-resolution instant as its parent
        // (e.g. both stamped by a fast synthetic clock in a test, or two
        // processes spawned back-to-back) must not be rejected — the guard
        // only rejects STRICTLY earlier.
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            row(101, 100, 10, "helper.exe", 1000),
        ];
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.proc_count, 2);
        assert_eq!(agg.skipped_reused, 0);
    }

    #[test]
    fn by_role_always_sums_to_tree_mb() {
        let rows = vec![
            row(100, 1, 50, "tauri-eth-wallet.exe", 1000),
            row(101, 100, 300, "msedgewebview2.exe", 1010),
            row(102, 100, 10, "xmrig.exe", 1010),
            row(103, 100, 60, "monero-wallet-rpc.exe", 1010),
            row(104, 100, 40, "particld.exe", 1010),
            row(105, 100, 5, "conhost.exe", 1010),
        ];
        let agg = aggregate_tree(&rows, 100);
        let role_total = agg.by_role.webview_mb
            + agg.by_role.miners_mb
            + agg.by_role.wallet_rpc_mb
            + agg.by_role.swap_node_mb
            + agg.by_role.other_mb;
        assert!(
            (role_total - mb(agg.tree_bytes)).abs() < 0.001,
            "byRole must sum to treeMb: {role_total} vs {}",
            mb(agg.tree_bytes)
        );
        assert!((agg.by_role.webview_mb - 300.0).abs() < 0.001);
        assert!((agg.by_role.miners_mb - 10.0).abs() < 0.001);
        assert!((agg.by_role.wallet_rpc_mb - 60.0).abs() < 0.001);
        assert!((agg.by_role.swap_node_mb - 40.0).abs() < 0.001);
        assert!((agg.by_role.other_mb - 55.0).abs() < 0.001, "main(50) + conhost(5)");
    }

    #[test]
    fn classify_role_covers_every_bucket() {
        assert_eq!(classify_role("msedgewebview2.exe"), "webview");
        assert_eq!(classify_role("xmrig.exe"), "miners");
        assert_eq!(classify_role("srbminer-multi.exe"), "miners");
        assert_eq!(classify_role("monero-wallet-rpc.exe"), "wallet-rpc");
        assert_eq!(classify_role("zephyr-wallet-rpc.exe"), "wallet-rpc");
        assert_eq!(classify_role("simplewallet.exe"), "wallet-rpc");
        assert_eq!(classify_role("xelis_wallet.exe"), "wallet-rpc");
        assert_eq!(classify_role("particld.exe"), "swap-node");
        assert_eq!(classify_role("monerod.exe"), "swap-node");
        assert_eq!(classify_role("bitcoind.exe"), "swap-node");
        assert_eq!(classify_role("litecoind.exe"), "swap-node");
        assert_eq!(classify_role("python.exe"), "swap-node");
        assert_eq!(classify_role("conhost.exe"), "other");
        assert_eq!(classify_role("tauri-eth-wallet.exe"), "other");
    }

    #[test]
    fn by_name_is_sorted_desc_and_capped_at_ten() {
        let mut rows = vec![row(100, 1, 1, "tauri-eth-wallet.exe", 1000)];
        for i in 0..15u32 {
            // Each a DIFFERENT name so all 15+1 would appear without the cap.
            rows.push(row(200 + i, 100, (i + 1) as u64, &format!("proc{i}.exe"), 1010));
        }
        let agg = aggregate_tree(&rows, 100);
        assert_eq!(agg.by_name.len(), 10);
        assert!(agg.by_name.windows(2).all(|w| w[0].mb >= w[1].mb), "descending");
        assert!((agg.by_name[0].mb - 15.0).abs() < 0.001, "largest first (proc14.exe)");
    }
}

/// RAM plan Phase 2M.5 (2026-09-23): the emit-rate budget arithmetic.
#[cfg(test)]
mod emit_budget_tests {
    use super::{emit_rate_per_min, over_emit_budget, EMIT_BUDGET_PER_MIN};

    #[test]
    fn a_steady_one_per_second_is_sixty_a_minute_and_within_budget() {
        // 60 emits over exactly one minute.
        let rate = emit_rate_per_min(1_000, 1_060, 60_000);
        assert_eq!(rate, 60);
        assert!(!over_emit_budget(rate), "the budget is a ceiling, not a target");
    }

    #[test]
    fn one_more_than_the_budget_trips_it() {
        assert!(over_emit_budget(EMIT_BUDGET_PER_MIN + 1));
        assert!(!over_emit_budget(EMIT_BUDGET_PER_MIN));
    }

    #[test]
    fn the_rate_scales_when_the_samples_are_not_a_minute_apart() {
        // 30 emits in 30 s is 60/min; 30 emits in 10 s is 180/min.
        assert_eq!(emit_rate_per_min(0, 30, 30_000), 60);
        assert_eq!(emit_rate_per_min(0, 30, 10_000), 180);
    }

    #[test]
    fn a_firehose_is_flagged() {
        // The shape of the leak rounds: thousands of emits in a minute.
        assert!(over_emit_budget(emit_rate_per_min(4, 5_004, 60_000)));
    }

    #[test]
    fn a_quiet_app_reads_as_zero() {
        assert_eq!(emit_rate_per_min(4, 4, 60_000), 0);
    }

    #[test]
    fn a_backwards_counter_or_stalled_clock_is_zero_never_a_wrapped_number() {
        assert_eq!(emit_rate_per_min(500, 10, 60_000), 0, "counter reset after a restart");
        assert_eq!(emit_rate_per_min(0, 100, 0), 0, "no elapsed time");
        assert_eq!(emit_rate_per_min(0, 100, -5), 0, "clock went backwards");
    }
}
