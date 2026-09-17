use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Windows CREATE_NO_WINDOW flag — prevents helper processes from showing a console window
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Windows CREATE_NEW_CONSOLE flag — gives the child process its OWN new
/// console window. Required when the parent (Tauri GUI app) has no console
/// of its own — without this flag, the child inherits the parent's "no
/// console" state and its stdout goes to NUL with no visible window.
#[cfg(target_os = "windows")]
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

/// Global state to hold the running xmrig watcher process
pub struct MinerProcess(pub Mutex<Option<tokio::process::Child>>);

/// Global state to hold the PID of the elevated xmrig process (for killing it)
pub struct MinerPid(pub Mutex<Option<u32>>);

/// Send+Sync wrapper around a Windows process HANDLE returned by
/// `ShellExecuteExW` with `SEE_MASK_NOCLOSEPROCESS`. Stored as `usize`
/// because the raw `HANDLE` type is `*mut c_void` (`!Send`/`!Sync`),
/// but the underlying kernel handle is perfectly fine to use across
/// threads — `HANDLE` is a numeric kernel-managed token, not a pointer
/// into the launcher's address space.
///
/// **Why we need this for elevated kill**: xmrig is launched at high
/// integrity level (admin token, required for MSR-MOD). The wallet
/// itself runs at medium IL. `taskkill /F /PID` from the wallet fails
/// silently because Windows refuses medium-IL → high-IL termination
/// requests by process ID. **But** the HANDLE returned at process
/// *creation* carries full PROCESS_TERMINATE access regardless of IL
/// — the creator gets full rights baked into the handle. So calling
/// `TerminateProcess(handle, exit_code)` via the retained handle works
/// without UAC, even from medium IL.
///
/// See `wiki/synthesis/dev-fee-socks5-and-swap-overhead-plan.md`
/// "Problem 3.5 — CPU 'Stop Mining' doesn't terminate xmrig".
#[derive(Debug)]
pub struct ElevatedHandle(usize);

unsafe impl Send for ElevatedHandle {}
unsafe impl Sync for ElevatedHandle {}

#[cfg(target_os = "windows")]
impl ElevatedHandle {
    pub fn from_raw(handle: windows::Win32::Foundation::HANDLE) -> Self {
        Self(handle.0 as usize)
    }

    pub fn as_handle(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(self.0 as *mut std::ffi::c_void)
    }
}

/// Tauri-managed slot holding the elevated xmrig's process handle for
/// the lifetime of the current mining session. Cleared by `stop_xmrig`
/// after `TerminateProcess` runs. `None` between sessions or when no
/// session is active.
pub struct MinerHandle(pub Mutex<Option<ElevatedHandle>>);

/// Global state to hold the running GPU miner process (SRBMiner or lolMiner)
pub struct GpuMinerProcess(pub Mutex<Option<tokio::process::Child>>);

/// The SRBMiner-MULTI **CPU lane** process (XelisHash v3). Added 2026-09-15.
///
/// Its own slot — not `MinerProcess` (xmrig's elevated watcher) and not
/// `GpuMinerProcess` — so XEL-on-CPU and any GPU session (XEL included) run as
/// two independent SRBMiner processes. Every stop path takes the `Child` out of
/// THIS slot and kills that handle; nothing in this module kills SRBMiner by
/// image name, which would take the other lane down with it.
pub struct SrbCpuMinerProcess(pub Mutex<Option<tokio::process::Child>>);

/// 2026-05-18 — paths to the active miner-process log files (the
/// miner's OWN log output, written by the miner itself via its
/// `--log-file` / `--logfile` flag). Captures what the miner thinks
/// is happening — "Pool not responding", "Authorized worker", DAG
/// load progress, auto-tune state, share-found logging — which is
/// what you need to root-cause why a miner gave up at 15s. Stored as
/// separate slots for CPU vs GPU so a concurrent dual-mining session
/// writes two log files in parallel.
///
/// `None` between sessions or in release builds: the `--log-file`
/// flag is only appended when [`miner_logging_active`] is true
/// (debug builds only), so the field never gets populated in a
/// shipped MSI.
#[derive(Default)]
pub struct MinerLogPaths {
    pub cpu: Mutex<Option<PathBuf>>,
    pub gpu: Mutex<Option<PathBuf>>,
}

/// Whether to write the miner's own `--log-file` output to disk.
/// Debug builds only — a shipped MSI never appends the flag, so no
/// file is created and no tail task spawns. Previously gated on the
/// dev-fee logger's `dev_logging_active`; decoupled 2026-07-06 when
/// the dev-fee system was removed (pure-wallet cutover).
pub(crate) fn miner_logging_active() -> bool {
    cfg!(debug_assertions)
}

// ─────────────────────────────────────────────────────────────────────
// Miner-death watch
// ─────────────────────────────────────────────────────────────────────

/// Which mining lane a death-watch task monitors.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum MinerLane {
    /// xmrig (RandomX), elevated on Windows.
    Cpu,
    /// SRBMiner-MULTI's CPU lane (XelisHash v3), unelevated. Reported to the
    /// frontend as `"cpu"` as well — it IS the CPU lane; which binary runs it
    /// is the backend's business.
    CpuSrb,
    Gpu,
}

impl MinerLane {
    fn as_str(self) -> &'static str {
        match self {
            MinerLane::Cpu | MinerLane::CpuSrb => "cpu",
            MinerLane::Gpu => "gpu",
        }
    }
}

/// Result of one liveness poll.
enum LaneState {
    /// Miner still running — keep watching.
    Running,
    /// The lane's slot is empty, i.e. `stop_xmrig` / `stop_gpu_miner` already
    /// ran: the user stopped on purpose. Exit quietly, emit nothing.
    UserStopped,
    /// The tracked process exited while we still believed it was mining.
    Died,
}

/// Poll cadence for the death watch. 3 s sits inside the frontend's own 5 s
/// `is_mining` poll, so the UI corrects promptly; the cost is one
/// non-blocking `try_wait()` per tick.
const MINER_DEATH_POLL_SECS: u64 = 3;

/// One liveness poll. **Deliberately synchronous** — every mutex guard is
/// taken and dropped inside this function, so no `MutexGuard` is ever held
/// across an `.await` in the watch loop (that would make the task `!Send`).
fn poll_lane(app: &AppHandle, lane: MinerLane) -> LaneState {
    match lane {
        MinerLane::Cpu => {
            // `stop_xmrig` clears `MinerPid` FIRST, so an empty pid slot is
            // the unambiguous "user stopped on purpose" signal.
            let pid_state = app.state::<MinerPid>();
            let pid_empty = match pid_state.0.lock() {
                Ok(guard) => guard.is_none(),
                Err(_) => return LaneState::UserStopped,
            };
            if pid_empty {
                return LaneState::UserStopped;
            }
            // `MinerProcess` holds the hidden `Wait-Process -Id <xmrig pid>`
            // child, so ITS exit is exactly "the elevated xmrig exited".
            let proc_state = app.state::<MinerProcess>();
            let mut guard = match proc_state.0.lock() {
                Ok(g) => g,
                Err(_) => return LaneState::Running,
            };
            match guard.as_mut() {
                None => LaneState::UserStopped,
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => LaneState::Died,
                    _ => LaneState::Running,
                },
            }
        }
        MinerLane::CpuSrb => {
            // `stop_srbminer_cpu` takes the child out of its slot before
            // killing it — the same "empty slot = intentional stop" rule the
            // GPU lane uses below.
            let state = app.state::<SrbCpuMinerProcess>();
            let mut guard = match state.0.lock() {
                Ok(g) => g,
                Err(_) => return LaneState::Running,
            };
            match guard.as_mut() {
                None => LaneState::UserStopped,
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => LaneState::Died,
                    _ => LaneState::Running,
                },
            }
        }
        MinerLane::Gpu => {
            // `stop_gpu_miner` takes the child out of the slot before killing
            // it, so an empty slot likewise means an intentional stop.
            let state = app.state::<GpuMinerProcess>();
            let mut guard = match state.0.lock() {
                Ok(g) => g,
                Err(_) => return LaneState::Running,
            };
            match guard.as_mut() {
                None => LaneState::UserStopped,
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => LaneState::Died,
                    _ => LaneState::Running,
                },
            }
        }
    }
}

/// Detect an **unexpected** miner exit and tell the frontend by emitting
/// `mining-error` with code `MINER_PROCESS_DIED`.
///
/// This restores a signal the dev-fee stratum proxy used to provide: it
/// watched the miner→proxy TCP and emitted this event when the miner stopped
/// reconnecting. That proxy was removed 2026-07-06 (pure-wallet cutover),
/// which silently left the frontend's `MINER_PROCESS_DIED` handler inert — a
/// crashed miner would leave the UI showing "mining" indefinitely.
///
/// This replacement watches the **process** rather than a socket, so it is
/// transport-agnostic: it works identically for direct pool connections and
/// SOCKS5-proxied ones, and needs no stratum plumbing.
///
/// Emits at most once, then exits. Stays silent on an intentional stop.
pub(crate) fn spawn_miner_death_watch(app: AppHandle, lane: MinerLane) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(MINER_DEATH_POLL_SECS)).await;
            match poll_lane(&app, lane) {
                LaneState::Running => continue,
                LaneState::UserStopped => return,
                LaneState::Died => {
                    // Clear the lane's "are we mining" slots so `is_mining` /
                    // `is_gpu_mining` immediately report the truth even if no
                    // frontend is listening (e.g. the webview reloaded). The
                    // CPU `MinerHandle` is deliberately LEFT for `stop_xmrig`,
                    // which closes it properly via `CloseHandle`.
                    // NOTE: each lock result is bound to its own local so it
                    // drops BEFORE the `State` local it borrows from (locals
                    // drop in reverse declaration order). Inlining these as
                    // `if let Ok(..) = state.0.lock()` makes the temporary
                    // outlive the `State` binding → E0597.
                    match lane {
                        MinerLane::Cpu => {
                            let proc_state = app.state::<MinerProcess>();
                            let proc_lock = proc_state.0.lock();
                            if let Ok(mut g) = proc_lock {
                                *g = None;
                            }
                            let pid_state = app.state::<MinerPid>();
                            let pid_lock = pid_state.0.lock();
                            if let Ok(mut g) = pid_lock {
                                *g = None;
                            }
                        }
                        MinerLane::CpuSrb => {
                            let srb_state = app.state::<SrbCpuMinerProcess>();
                            let srb_lock = srb_state.0.lock();
                            if let Ok(mut g) = srb_lock {
                                *g = None;
                            }
                        }
                        MinerLane::Gpu => {
                            let gpu_state = app.state::<GpuMinerProcess>();
                            let gpu_lock = gpu_state.0.lock();
                            if let Ok(mut g) = gpu_lock {
                                *g = None;
                            }
                        }
                    }
                    crate::emit_meter::bump("mining-error");
                    let _ = app.emit(
                        "mining-error",
                        serde_json::json!({
                            "code": "MINER_PROCESS_DIED",
                            "kind": lane.as_str(),
                            "message": format!(
                                "The {} miner stopped unexpectedly (the process exited). \
                                 Mining has been stopped — check the pool/worker settings \
                                 or the miner log, then start again.",
                                lane.as_str().to_uppercase()
                            ),
                        }),
                    );
                    return;
                }
            }
        }
    });
}

/// Whether to launch miner processes with a visible console window.
/// `false` (default) hides the window via `CREATE_NO_WINDOW` (Windows) /
/// `SW_HIDE` (elevated xmrig). `true` shows the live miner output so the
/// user can inspect share accepts/rejects, pool diff changes, and any
/// errors. Toggled at runtime by `set_miner_window_visible`.
pub struct MinerWindowVisible(pub Mutex<bool>);

/// Sentinel "a CPU `start_xmrig` call is currently in flight" flag.
/// Set immediately on `start_xmrig` entry, cleared on success or any
/// error path via the `StartGuard` RAII helper.
///
/// **Why this exists**: the existing `MinerProcess.is_some()` check
/// only fires AFTER `ShellExecuteExW` + watcher spawn have completed —
/// a 2–5 s window during which a second `start_xmrig` call can pass the
/// "already running" check and create a duplicate proxy + scheduler +
/// accounting ticker. Observed in `dev-fee-20260513T073*-cpu.jsonl`
/// where three concurrent CPU sessions ran for 2 hours each because
/// the user clicked Start three times during the UAC prompt.
pub struct MinerStarting(pub AtomicBool);

/// Same sentinel for GPU `start_gpu_miner`. GPU has the same race —
/// build_and_spawn_gpu_miner is async, leaving a window where a second
/// start_gpu_miner call could pass the `GpuMinerProcess.is_some()` check.
pub struct GpuMinerStarting(pub AtomicBool);

/// RAII guard: on construction sets an `AtomicBool` to `true`; on drop
/// sets it back to `false`. Used to wrap `start_xmrig` / `start_gpu_miner`
/// so the "starting" sentinel is cleared regardless of which return
/// path the function takes (success, early `?`, late error). Matches
/// the `scopeguard` crate's pattern without pulling in the dep.
struct StartGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> StartGuard<'a> {
    /// Try to acquire the guard. Returns `Some` if we won the race
    /// (flag was `false`, now `true`). Returns `None` if another start
    /// is already in flight or completed without clearing — caller
    /// should return an `Err` to the frontend.
    fn try_acquire(flag: &'a AtomicBool) -> Option<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Self { flag })
        }
    }
}

impl<'a> Drop for StartGuard<'a> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

// `DevFeeConfig` struct + the four `*_dev_fee_enabled` / `*_dev_mode`
// Tauri commands were removed 2026-05-14. The dev fee is now hardcoded
// to always-on, production schedule (3% / 30 min). The "dev mode"
// diagnostic schedule (50% / 2 min) was retired entirely after the
// production schedule was verified end-to-end on a 9.5-hour live
// session (18/18 GPU cycles + 19/19 CPU cycles at 3.0% exact).
// See `wiki/log.md` 2026-05-14 entries.

/// Preferred HTTP API port for xmrig when we enable it (for hashrate polling).
pub const XMRIG_HTTP_PORT: u16 = 3333;

/// The HTTP API port the CURRENT xmrig session actually launched with.
/// Defaults to [`XMRIG_HTTP_PORT`]; `start_xmrig` overwrites it (via
/// [`pick_xmrig_http_port`]) so the hashrate/snapshot poll always targets the
/// port xmrig really bound — not a fixed 3333 that an orphan miner from a
/// prior crash-loop might be squatting on. (2026-06-30: xmrig fell back to a
/// random port when 3333 was taken at launch, but the poll kept hitting the
/// dead 3333 → every panel blank while mining was fine. See log.md.)
static XMRIG_API_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(XMRIG_HTTP_PORT);

/// Pick the HTTP API port for an xmrig launch: prefer the canonical
/// [`XMRIG_HTTP_PORT`] (stable for the banner / "Show miner console"), but if
/// it's occupied, fall back to an OS-assigned free port so xmrig binds a port
/// that is actually free and the wallet polls that exact port. The tiny
/// TOCTOU window between this probe and xmrig's bind is acceptable for a
/// loopback monitoring socket.
fn pick_xmrig_http_port() -> u16 {
    pick_loopback_api_port(XMRIG_HTTP_PORT, &[])
}

/// Pick a loopback port a miner's stats API can actually bind: `preferred`
/// when a bind to it succeeds and it is not in `avoid`, otherwise an
/// OS-assigned free port that is not in `avoid`.
///
/// A failed bind is not only "an orphan miner is squatting on it" (the
/// 2026-06-30 xmrig case). On Windows with Hyper-V / WSL2 / Docker, whole port
/// RANGES are reserved by the OS (`netsh interface ipv4 show excludedportrange
/// protocol=tcp`), re-drawn at boot, and a bind inside one fails with
/// WSAEACCES although nothing is listening. On the dev box on 2026-09-15 the
/// range 21515–21614 was reserved; it contains `GPU_HTTP_PORT` (21558), so
/// SRBMiner logged `HTTP API enabled on port …` and then `API daemon failed to
/// start`, and every stats poll came back empty while the miner hashed
/// normally. An OS-assigned port is never handed out from an excluded range.
///
/// `avoid` keeps two lanes resolving at the same moment from both falling back
/// to one ephemeral port.
pub(crate) fn pick_loopback_api_port(preferred: u16, avoid: &[u16]) -> u16 {
    use std::net::TcpListener;
    if !avoid.contains(&preferred) && TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    for _ in 0..8 {
        let candidate = TcpListener::bind(("127.0.0.1", 0))
            .ok()
            .and_then(|l| l.local_addr().ok())
            .map(|a| a.port());
        match candidate {
            Some(port) if !avoid.contains(&port) => return port,
            Some(_) => continue,
            None => break,
        }
    }
    preferred
}

/// PREFERRED HTTP API port for the GPU miner (SRBMiner or lolMiner). Picked
/// to avoid SRBMiner's default 21550 in case the user has another tool
/// already bound there. Both miners are launched with `--apiport=...`
/// (lolMiner) or `--api-enable --api-port=...` (SRBMiner).
///
/// Since 2026-09-15 this is only a preference: each launch resolves it through
/// [`pick_loopback_api_port`] and records the port it really used in
/// [`GPU_API_PORT`], which `get_gpu_miner_hashrate` / `get_gpu_miner_snapshot`
/// poll. See that function for the excluded-port-range failure that made a
/// fixed port wrong.
pub const GPU_HTTP_PORT: u16 = 21558;

/// The API port the CURRENT GPU miner session was launched with.
static GPU_API_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(GPU_HTTP_PORT);

/// PREFERRED API port for the SRBMiner-MULTI CPU lane (XelisHash v3) — a
/// different one from the GPU lane's, since the two run concurrently. Resolved
/// per launch exactly like the GPU port.
pub const SRB_CPU_HTTP_PORT: u16 = 21559;

/// The API port the CURRENT SRBMiner CPU-lane session was launched with.
static SRB_CPU_API_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(SRB_CPU_HTTP_PORT);

/// MSR status for frontend
#[derive(Clone, Serialize)]
pub struct MsrStatusPayload {
    pub status: String, // "ok" | "failed" | "disabled" | "unknown"
    pub message: Option<String>,
}

/// XMRig API summary hashrate (for GET /1/summary).
///
/// `total` is a 3-element array [10s, 60s, 15m]. Any element can be
/// `null` early in mining — the 60s and 15m averages aren't available
/// until xmrig has been running for that long. So we deserialize as
/// `Vec<Option<f64>>`; the avg in `get_xmrig_hashrate` filters out the
/// `None`s before computing.
#[derive(Deserialize)]
struct XmrigSummaryHashrate {
    total: Option<Vec<Option<f64>>>,
    /// Per-thread `[10s, 60s, 15m]` hashrate triples. Only `.len()` is
    /// used — that's xmrig's own resolved active-thread count after its
    /// cache/topology autoconfig ran, regardless of whether the launch
    /// used `--threads=N`, `--cpu-max-threads-hint=P`, or neither (High).
    /// `IgnoredAny` elements avoid coupling this struct to the exact
    /// per-thread array shape, which we never otherwise read.
    /// See https://github.com/xmrig/xmrig/blob/master/doc/api/1/summary.json
    threads: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(rename = "highest")]
    _highest: Option<f64>,
}

#[derive(Deserialize)]
struct XmrigSummary {
    hashrate: Option<XmrigSummaryHashrate>,
    results: Option<XmrigSummaryResults>,
    connection: Option<XmrigSummaryConnection>,
}

/// `summary.results` block — per-share counters + current pool diff.
/// All fields default to 0/None when absent so the parser stays robust
/// across xmrig versions (some 5.x builds omit `diff_current`).
#[derive(Deserialize, Default)]
struct XmrigSummaryResults {
    #[serde(rename = "diff_current")]
    diff_current: Option<u64>,
    #[serde(rename = "shares_good")]
    shares_good: Option<u64>,
    #[serde(rename = "shares_total")]
    shares_total: Option<u64>,
}

/// `summary.connection` block — pool ping + uptime in seconds.
#[derive(Deserialize, Default)]
struct XmrigSummaryConnection {
    uptime: Option<u64>,
    ping: Option<u64>,
}

/// Snapshot of every session-scope number we read out of xmrig in one
/// HTTP call. Returned by `get_xmrig_snapshot`. Fields mirror the
/// design's SESSION block and the EARNINGS estimator inputs:
/// - `accepted` / `rejected` — share counters (rejected = total − good)
/// - `diff_current` — current pool difficulty for this worker
/// - `ping_ms` — latest stratum ping round-trip
/// - `uptime_secs` — connection uptime; replaces React-mounted timer
/// - `hashrate` — same value `get_xmrig_hashrate` returns (10s window)
/// - `threads_active` — real resolved CPU thread count, from
///   `hashrate.threads.len()`. This is the ONE production-safe (not
///   debug-build-gated) source of the true thread count — a separate
///   `ReadyStatus` in the log-tail path also captures this, but that path
///   only exists when [`miner_logging_active`] is true (debug builds
///   only), which is always false in release builds and cannot be
///   toggled at runtime there.
#[derive(Serialize, Default)]
pub struct XmrigSnapshot {
    pub hashrate: Option<f64>,
    pub accepted: u64,
    pub rejected: u64,
    pub diff_current: Option<u64>,
    pub ping_ms: Option<u64>,
    pub uptime_secs: u64,
    pub threads_active: Option<usize>,
}

/// Miner definitions with their GitHub repo info and expected executable names
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinerInfo {
    pub name: String,
    pub repo: String,
    pub executable: String,
    /// When true, extract every file from the archive (flattened) instead of
    /// just the exe. Required for miners that ship supporting DLLs/configs
    /// alongside the exe.
    pub extract_all: bool,
}

// ---------------------------------------------------------------------------
// Pinned miner manifest
// ---------------------------------------------------------------------------
// `scripts/miners-manifest.json` is the single source of truth for which miner
// release we ship, per platform, with a SHA256 for each archive. It is compiled
// into the binary so the runtime downloader and the dev-time prefetch script
// (`scripts/fetch-miners.mjs`) can never drift apart.
//
// Before 2026-08-12 this command resolved `releases/latest` from the GitHub API
// and matched assets by keyword. That had two defects: the keywords were
// Windows-only (`windows-x64`, `Win64`), so Linux downloaded Windows archives
// and then failed to find the executable inside; and nothing verified what came
// back off the wire before we executed it. Pinning + hashing fixes both.

const MINERS_MANIFEST_JSON: &str = include_str!("../../scripts/miners-manifest.json");

#[derive(Deserialize)]
struct MinersManifest {
    miners: std::collections::HashMap<String, ManifestEntry>,
}

#[derive(Deserialize)]
struct ManifestEntry {
    version: String,
    #[serde(default)]
    win32: Option<ManifestPlatform>,
    #[serde(default)]
    linux: Option<ManifestPlatform>,
}

#[derive(Deserialize)]
struct ManifestPlatform {
    url: String,
    sha256: String,
    /// Path of the executable inside the archive, when only one file is needed.
    #[serde(default)]
    extract: Option<String>,
    /// Extract every file, flattened, instead of a single executable.
    #[serde(default)]
    extract_all: bool,
    /// Version-pinned root directory inside the archive whose *contents* get
    /// flattened (e.g. `SRBMiner-Multi-3-2-8`). Only used with `extract_all`.
    #[serde(default)]
    subdir: Option<String>,
}

impl ManifestEntry {
    /// The platform block for the OS we're compiled for.
    fn current_platform(&self) -> Option<&ManifestPlatform> {
        if cfg!(target_os = "windows") {
            self.win32.as_ref()
        } else {
            self.linux.as_ref()
        }
    }
}

fn load_miners_manifest() -> Result<MinersManifest, String> {
    serde_json::from_str(MINERS_MANIFEST_JSON)
        .map_err(|e| format!("Failed to parse embedded miners-manifest.json: {}", e))
}

/// Progress event payload sent to frontend
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub miner: String,
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

/// Result for check_miners_exist
#[derive(Serialize)]
pub struct MinerStatus {
    pub name: String,
    pub exists: bool,
    pub path: String,
}

fn get_miner_definitions() -> Vec<MinerInfo> {
    vec![
        // Binary names use crate::platform::EXE_SUFFIX so the same code resolves
        // `xmrig.exe` on Windows and `xmrig` on Linux. The download URL, SHA256
        // and archive layout for each of these comes from the embedded
        // `scripts/miners-manifest.json`, keyed by the `name` field below —
        // keep the names in sync with the manifest keys.
        MinerInfo {
            name: "xmrig".to_string(),
            repo: "xmrig/xmrig".to_string(),
            executable: format!("xmrig{}", crate::platform::EXE_SUFFIX),
            extract_all: false, // only needs the exe — WinRing0x64.sys is fetched lazily, see ensure_msr_driver
        },
        MinerInfo {
            name: "lolMiner".to_string(),
            repo: "Lolliedieb/lolMiner-releases".to_string(),
            executable: format!("lolMiner{}", crate::platform::EXE_SUFFIX),
            extract_all: false, // self-contained exe
        },
        MinerInfo {
            name: "SRBMiner-MULTI".to_string(),
            repo: "doktor83/SRBMiner-Multi".to_string(),
            executable: format!("SRBMiner-MULTI{}", crate::platform::EXE_SUFFIX),
            extract_all: true, // ships with DLLs and support files that must be present
        },
        // rigel was dropped 2026-08-28 (binary-bundling-plan T2). Every advertised
        // GPU algo routes to lolMiner (Octopus, Autolykos2) or SRBMiner (KawPoW,
        // ProgPowZ, Octopus) in pools.ts — no advertised pool was rigel-exclusive —
        // so removing it costs no algo. Re-adding it is a deliberate act, guarded by
        // `get_miner_definitions_is_exactly_the_three` below.
    ]
}

fn get_miners_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let miners_dir = resource_dir.join("miners");
    std::fs::create_dir_all(&miners_dir)
        .map_err(|e| format!("Failed to create miners dir: {}", e))?;
    Ok(miners_dir)
}

/// Check if all miner executables exist in the miners directory
#[tauri::command]
pub async fn check_miners_exist(app: AppHandle) -> Result<Vec<MinerStatus>, String> {
    let miners_dir = get_miners_dir(&app)?;
    let definitions = get_miner_definitions();

    let statuses: Vec<MinerStatus> = definitions
        .iter()
        .map(|m| {
            let exe_path = miners_dir.join(&m.executable);
            MinerStatus {
                name: m.name.clone(),
                exists: exe_path.exists(),
                path: exe_path.to_string_lossy().to_string(),
            }
        })
        .collect();

    Ok(statuses)
}

/// Check if Windows Defender exclusions are set for the miners directory.
/// Uses a broader check: looks for any ExclusionPath entry that case-insensitively
/// matches the miners dir (with or without trailing slash), OR checks ExclusionProcess
/// for any of the known miner executables.
#[tauri::command]
pub async fn check_defender_exclusions(app: AppHandle) -> Result<bool, String> {
    let miners_dir = get_miners_dir(&app)?;
    let miners_path = miners_dir.to_string_lossy().to_string();
    let _miners_path_lower = miners_path.to_lowercase();

    // Build a PowerShell script that checks both ExclusionPath and ExclusionProcess
    let definitions = get_miner_definitions();
    let exe_names: Vec<String> = definitions.iter().map(|m| m.executable.to_lowercase()).collect();

    let ps_script = format!(
        r#"
$pref = Get-MpPreference
$targetPath = '{miners_path}'
$targetLower = $targetPath.ToLower().TrimEnd('\').TrimEnd('/')

# Check ExclusionPath (case-insensitive, ignore trailing slash)
$pathMatch = $false
if ($pref.ExclusionPath) {{
    foreach ($p in $pref.ExclusionPath) {{
        $pLower = $p.ToLower().TrimEnd('\').TrimEnd('/')
        if ($pLower -eq $targetLower) {{
            $pathMatch = $true
            break
        }}
    }}
}}

# Check ExclusionProcess for any known miner exe
$procMatch = $false
if ($pref.ExclusionProcess) {{
    foreach ($p in $pref.ExclusionProcess) {{
        $pLower = $p.ToLower()
        {exe_checks}
    }}
}}

if ($pathMatch -or $procMatch) {{ Write-Output 'true' }} else {{ Write-Output 'false' }}
"#,
        miners_path = miners_path,
        exe_checks = exe_names.iter().map(|e| format!(
            "if ($pLower -like '*{e}*') {{ $procMatch = $true }}"
        )).collect::<Vec<_>>().join("\n        ")
    );

    let mut cmd = hidden_powershell_command();
    cmd.args(["-Command", &ps_script]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to check Defender exclusions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // Accept 'true' anywhere in stdout (PowerShell may include whitespace/newlines)
    Ok(stdout.to_lowercase().contains("true"))
}

/// Add Windows Defender exclusions for the miners directory (requires admin elevation)
/// Uses a temp .ps1 file to avoid quoting/escaping issues, then verifies success
#[tauri::command]
pub async fn add_defender_exclusions(app: AppHandle) -> Result<bool, String> {
    let miners_dir = get_miners_dir(&app)?;
    let miners_path = miners_dir.to_string_lossy().to_string();

    let definitions = get_miner_definitions();

    // Build PowerShell script content — one command per line, no escaping needed
    let mut script_lines = vec![format!(
        "Add-MpPreference -ExclusionPath '{}'",
        miners_path
    )];
    for m in &definitions {
        let exe_path = miners_dir.join(&m.executable);
        script_lines.push(format!(
            "Add-MpPreference -ExclusionProcess '{}'",
            exe_path.to_string_lossy()
        ));
    }

    // Sprint 1 (msr-mod-workaround-plan): explicit per-file ExclusionPath
    // entries for the runtime files that live in the miners directory.
    // Per research §53, Defender's directory exclusion alone isn't always
    // honored for the .sys file — we add it explicitly. The streaming log
    // files get exclusions to avoid Defender real-time-protection scanning
    // on every line write. The launcher script and task XML are small but
    // get exclusions defensively (heuristic flags on `sc.exe` activity).
    let runtime_files = [
        "WinRing0x64.sys",
        "xmrig.log",
        "xmrig.log.err",
        "xmrig.log.prev",
    ];
    for fname in &runtime_files {
        let p = miners_dir.join(fname);
        script_lines.push(format!(
            "Add-MpPreference -ExclusionPath '{}'",
            p.to_string_lossy()
        ));
    }
    let script_content = script_lines.join("\n");

    // Write script to a temp file to avoid quoting/escaping issues
    let script_path = miners_dir.join("_defender_setup.ps1");
    std::fs::write(&script_path, &script_content)
        .map_err(|e| format!("Failed to write defender script: {}", e))?;

    // Run the script elevated via UAC (hidden helper window)
    let elevate_cmd_str = format!(
        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-ExecutionPolicy Bypass -File \"{}\"'",
        script_path.to_string_lossy()
    );
    let mut elevate_cmd = hidden_powershell_command();
    elevate_cmd.args(["-Command", &elevate_cmd_str]);
    let _output = elevate_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run Defender exclusion script: {}", e))?;

    // Clean up temp script
    let _ = std::fs::remove_file(&script_path);

    // Verify by actually checking if the exclusion was added (hidden)
    let mut verify_cmd = hidden_powershell_command();
    verify_cmd.args([
        "-Command",
        &format!(
            "(Get-MpPreference).ExclusionPath -contains '{}'",
            miners_path
        ),
    ]);
    let verify = verify_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to verify Defender exclusions: {}", e))?;

    let stdout = String::from_utf8_lossy(&verify.stdout).trim().to_string();
    Ok(stdout.eq_ignore_ascii_case("true"))
}

/// Download all miner executables from GitHub releases
#[tauri::command]
pub async fn download_miners(app: AppHandle) -> Result<(), String> {
    let miners_dir = get_miners_dir(&app)?;
    let definitions = get_miner_definitions();
    let manifest = load_miners_manifest()?;

    // T1 (binary-bundling-plan): EXCLUSION BEFORE WRITE.
    //
    // Until 2026-08-28 the Defender exclusion was a separate button the user
    // could skip, and `download_miners` wrote miner exes with zero Defender
    // interaction — so Defender could quarantine a miner MID-DOWNLOAD, a
    // reliability failure, not merely an AV annoyance. The exclusion is now
    // added (and verified) BEFORE any byte is written, structurally, so the
    // whole download+extract happens inside an already-excluded directory.
    //
    // Best-effort, on purpose: if the exclusion cannot be added — a third-party
    // AV with no Defender to exclude, or an Intune/GPO-locked managed machine —
    // we warn and proceed rather than hard-blocking a legitimate user. It
    // covers Microsoft Defender only; third-party AV will still scan the write.
    // Skipping the UAC prompt when an exclusion is already present keeps this
    // from re-prompting on every re-download.
    #[cfg(target_os = "windows")]
    {
        let already = check_defender_exclusions(app.clone())
            .await
            .unwrap_or(false);
        if !already {
            let protected = add_defender_exclusions(app.clone())
                .await
                .unwrap_or(false);
            if !protected {
                let _ = app.emit(
                    "miner-download-progress",
                    DownloadProgress {
                        miner: "(defender)".to_string(),
                        stage: "warning".to_string(),
                        percent: 0.0,
                        message:
                            "Could not add a Windows Defender exclusion before downloading. \
                             Miners may be flagged; continuing anyway. If a download is \
                             quarantined, add the exclusion manually and retry."
                                .to_string(),
                    },
                );
            }
        }
    }

    // T5 (binary-bundling-plan): try the BUNDLED miners before the network.
    // If the installer shipped an encrypted `miners` bundle, extract it into the
    // (now Defender-excluded) miners dir — offline-reliable, and the per-miner
    // loop below then sees the exes present and skips the download. Best-effort:
    // a missing or failed bundle just leaves the download to do its job. app-data
    // presence (the loop's `exe_path.exists()` skip) still wins over both.
    let any_missing = definitions
        .iter()
        .any(|m| !miners_dir.join(&m.executable).exists());
    if any_missing {
        if let Ok(resource_dir) = app.path().resource_dir() {
            if crate::bundle::bundle_has(&resource_dir, "miners") {
                match crate::bundle::extract_encrypted_bundle(&resource_dir, "miners", &miners_dir) {
                    Ok(()) => {
                        let _ = app.emit(
                            "miner-download-progress",
                            DownloadProgress {
                                miner: "(bundle)".to_string(),
                                stage: "extracting".to_string(),
                                percent: 100.0,
                                message: "Staged mining software from the installer bundle."
                                    .to_string(),
                            },
                        );
                    }
                    Err(e) => eprintln!("[miners] bundled miners unavailable ({e}); will download"),
                }
            }
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("MultiChainWallet/0.5.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let total_miners = definitions.len();

    for (idx, miner) in definitions.iter().enumerate() {
        let exe_path = miners_dir.join(&miner.executable);

        // Skip if already exists
        if exe_path.exists() {
            crate::emit_meter::bump("miner-download-progress");
            let _ = app.emit(
                "miner-download-progress",
                DownloadProgress {
                    miner: miner.name.clone(),
                    stage: "complete".to_string(),
                    percent: 100.0,
                    message: format!(
                        "{} already exists ({}/{})",
                        miner.name,
                        idx + 1,
                        total_miners
                    ),
                },
            );
            continue;
        }

        // Resolve the pinned release for this miner on this platform.
        let entry = manifest.miners.get(&miner.name).ok_or_else(|| {
            format!(
                "{} has no entry in miners-manifest.json — add one before shipping.",
                miner.name
            )
        })?;
        let spec = entry.current_platform().ok_or_else(|| {
            format!(
                "{} has no '{}' block in miners-manifest.json, so it can't be downloaded on this platform.",
                miner.name,
                if cfg!(target_os = "windows") { "win32" } else { "linux" }
            )
        })?;

        let archive_name = spec
            .url
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Malformed URL for {} in manifest: {}", miner.name, spec.url))?
            .to_string();

        crate::emit_meter::bump("miner-download-progress");
        let _ = app.emit(
            "miner-download-progress",
            DownloadProgress {
                miner: miner.name.clone(),
                stage: "downloading".to_string(),
                percent: 0.0,
                message: format!(
                    "Downloading {} v{} ({}/{})",
                    miner.name,
                    entry.version,
                    idx + 1,
                    total_miners
                ),
            },
        );

        let response = client
            .get(&spec.url)
            .send()
            .await
            .map_err(|e| format!("Failed to download {}: {}", miner.name, e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to download {} — {} returned HTTP {}",
                miner.name,
                spec.url,
                response.status()
            ));
        }

        let total_size = response.content_length().unwrap_or(0);
        let archive_path = miners_dir.join(&archive_name);
        let mut file = std::fs::File::create(&archive_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;

        // Hash while streaming so verification costs no extra disk read.
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| format!("Download stream error for {}: {}", miner.name, e))?;
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write chunk: {}", e))?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;
            let percent = if total_size > 0 {
                (downloaded as f64 / total_size as f64) * 100.0
            } else {
                0.0
            };

            crate::emit_meter::bump("miner-download-progress");
            let _ = app.emit(
                "miner-download-progress",
                DownloadProgress {
                    miner: miner.name.clone(),
                    stage: "downloading".to_string(),
                    percent,
                    message: format!(
                        "Downloading {} - {:.1}/{:.1} MB",
                        miner.name,
                        downloaded as f64 / 1_048_576.0,
                        total_size as f64 / 1_048_576.0
                    ),
                },
            );
        }

        drop(file);

        // Verify BEFORE extracting — we are about to put an executable on disk
        // and later run it, so an unverified archive never gets unpacked.
        crate::emit_meter::bump("miner-download-progress");
        let _ = app.emit(
            "miner-download-progress",
            DownloadProgress {
                miner: miner.name.clone(),
                stage: "verifying".to_string(),
                percent: 100.0,
                message: format!("Verifying {}...", miner.name),
            },
        );

        let actual = hex_encode(&hasher.finalize());
        if !actual.eq_ignore_ascii_case(&spec.sha256) {
            let _ = std::fs::remove_file(&archive_path);
            return Err(format!(
                "SHA256 mismatch for {} — expected {}, got {}. The download was discarded; \
                 this means the upstream archive changed or the transfer was tampered with.",
                miner.name, spec.sha256, actual
            ));
        }

        crate::emit_meter::bump("miner-download-progress");
        let _ = app.emit(
            "miner-download-progress",
            DownloadProgress {
                miner: miner.name.clone(),
                stage: "extracting".to_string(),
                percent: 0.0,
                message: format!("Extracting {}...", miner.name),
            },
        );

        let extract_result = if archive_name.ends_with(".zip") {
            extract_miner_from_zip(
                &archive_path,
                &miners_dir,
                &miner.executable,
                spec.extract_all,
            )
        } else if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
            extract_miner_from_tar_gz(&archive_path, &miners_dir, &miner.executable, spec)
        } else {
            Err(format!(
                "Unsupported archive format for {}: {}",
                miner.name, archive_name
            ))
        };

        // Always drop the archive, success or failure — it's ~10-100 MB and
        // there's no resume path that would reuse it.
        let _ = std::fs::remove_file(&archive_path);
        extract_result?;

        // On Unix the executable bit does not survive the archive round-trip
        // for the single-file path, and tar-preserved modes can still be wrong
        // for flattened trees. Set it explicitly.
        make_executable(&miners_dir.join(&miner.executable))?;

        crate::emit_meter::bump("miner-download-progress");
        let _ = app.emit(
            "miner-download-progress",
            DownloadProgress {
                miner: miner.name.clone(),
                stage: "complete".to_string(),
                percent: 100.0,
                message: format!("{} ready ({}/{})", miner.name, idx + 1, total_miners),
            },
        );
    }

    // Emit overall completion
    crate::emit_meter::bump("miner-download-progress");
    let _ = app.emit(
        "miner-download-progress",
        DownloadProgress {
            miner: "all".to_string(),
            stage: "complete".to_string(),
            percent: 100.0,
            message: "All miners downloaded and ready!".to_string(),
        },
    );

    Ok(())
}

/// Files to extract alongside each miner executable.
///
/// 2026-07-01 — `WinRing0x64.sys` (xmrig's MSR-mod kernel driver) is
/// intentionally NOT auto-bundled here anymore. It used to ship with every
/// xmrig download regardless of whether MSR mod could ever work on that
/// machine or whether the user even mines CPU at all — but the driver's
/// mere presence on disk is exactly the kind of file Defender/AV heuristics
/// flag (it's a common target on Microsoft's own Vulnerable Driver
/// Blocklist), so bundling it unconditionally maximized false-positive
/// exposure for no benefit on machines that were never going to use it.
/// It's now fetched lazily by `ensure_msr_driver`, only for a session that's
/// actually about to attempt MSR mod. See `wiki/concepts/mining-process-management.md`.
fn get_extra_files(_executable_name: &str) -> Vec<&'static str> {
    vec![]
}

/// Lowercase hex for a hash digest. Avoids pulling `hex` into this module's
/// hot path just for one call site.
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Give `path` the executable bit on Unix. No-op on Windows, where
/// executability is determined by extension rather than mode bits.
///
/// Missing files are not an error: `extract_all` archives may name the binary
/// differently from our canonical `MinerInfo::executable`, and the caller
/// surfaces a clearer "not found" error at spawn time.
fn make_executable(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !path.exists() {
            return Ok(());
        }
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("Failed to stat {}: {}", path.display(), e))?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("Failed to chmod +x {}: {}", path.display(), e))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Extract a miner from a `.tar.gz` archive (the Linux distribution format for
/// every miner we ship).
///
/// Shells out to the system `tar` rather than linking a Rust tar+gzip stack —
/// the same choice `xmr_rpc::download_monero_wallet_rpc_linux` already makes
/// for `.tar.bz2`, and `tar` is declared in the deb/rpm `depends` lists in
/// `tauri.conf.json`, so it is guaranteed present on any machine that installed
/// us through a package. AppImage users get it from the base system (tar is
/// part of coreutils-adjacent baseline on every mainstream distro).
///
/// Extraction goes to a temp dir first, then the wanted files are copied out,
/// so a partial/hostile archive can never scatter files into `dest_dir`.
#[allow(dead_code)] // only reachable on platforms whose manifest entry ships a tarball
fn extract_miner_from_tar_gz(
    archive_path: &PathBuf,
    dest_dir: &PathBuf,
    executable_name: &str,
    spec: &ManifestPlatform,
) -> Result<(), String> {
    let staging = dest_dir.join(".extract-tmp");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Failed to create extraction dir: {}", e))?;

    let output = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(archive_path)
        .arg("-C")
        .arg(&staging)
        .output()
        .map_err(|e| {
            format!(
                "Failed to run `tar` to extract {}: {}. Install tar (package `tar`) and retry.",
                archive_path.display(),
                e
            )
        })?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "tar failed to extract {}: {}",
            archive_path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let result = (|| -> Result<(), String> {
        if spec.extract_all {
            // Flatten the contents of `subdir` (or the whole tree) into
            // dest_dir, matching both the zip path's behaviour and
            // fetch-miners.mjs.
            let root = match &spec.subdir {
                Some(sub) => staging.join(sub),
                None => staging.clone(),
            };
            let root = if root.is_dir() { root } else { staging.clone() };
            let mut copied = 0usize;
            copy_flattened(&root, dest_dir, &mut copied)?;
            if copied == 0 {
                return Err(format!(
                    "Archive for {} extracted no files",
                    executable_name
                ));
            }
        } else {
            // Single executable. Prefer the manifest's declared path; fall back
            // to a recursive search so a version bump that changes the archive's
            // top-level directory name doesn't break the download.
            let declared = spec.extract.as_ref().map(|rel| staging.join(rel));
            let src = match declared {
                Some(p) if p.is_file() => p,
                _ => find_file_named(&staging, executable_name).ok_or_else(|| {
                    format!(
                        "Executable '{}' not found inside the archive",
                        executable_name
                    )
                })?,
            };
            std::fs::copy(&src, dest_dir.join(executable_name))
                .map_err(|e| format!("Failed to copy {}: {}", executable_name, e))?;
        }
        Ok(())
    })();

    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Copy every file under `root` directly into `dest`, discarding directory
/// structure. Mirrors the zip path's `Path::file_name()` flattening.
#[allow(dead_code)]
fn copy_flattened(root: &std::path::Path, dest: &PathBuf, copied: &mut usize) -> Result<(), String> {
    let entries = std::fs::read_dir(root)
        .map_err(|e| format!("Failed to read {}: {}", root.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            copy_flattened(&path, dest, copied)?;
        } else if let Some(name) = path.file_name() {
            std::fs::copy(&path, dest.join(name))
                .map_err(|e| format!("Failed to copy {:?}: {}", name, e))?;
            *copied += 1;
        }
    }
    Ok(())
}

/// Depth-first search for a file with exactly `name` under `root`.
#[allow(dead_code)]
fn find_file_named(root: &std::path::Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            return Some(path);
        }
    }
    for dir in dirs {
        if let Some(found) = find_file_named(&dir, name) {
            return Some(found);
        }
    }
    None
}

/// Extract a miner from a zip archive.
///
/// When `extract_all` is false: only extracts the target executable and any
/// `get_extra_files` companions (e.g. WinRing0x64.sys for xmrig).
///
/// When `extract_all` is true: extracts every file in the archive, flattening
/// the directory structure into `dest_dir`. This is needed for miners like
/// SRBMiner that ship alongside required DLLs and support files.
fn extract_miner_from_zip(
    zip_path: &PathBuf,
    dest_dir: &PathBuf,
    executable_name: &str,
    extract_all: bool,
) -> Result<(), String> {
    let extra_files = get_extra_files(executable_name);
    let mut targets: Vec<String> = vec![executable_name.to_string()];
    for f in &extra_files {
        targets.push(f.to_string());
    }

    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open zip file: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    let mut found_exe = false;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        let entry_name = entry.name().to_string();

        // Skip directory entries
        if entry_name.ends_with('/') || entry_name.ends_with('\\') {
            continue;
        }

        if extract_all {
            // Flatten directory structure: extract every file directly into dest_dir
            let file_name = std::path::Path::new(&entry_name)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            if file_name.is_empty() {
                continue;
            }

            let dest_path = dest_dir.join(&file_name);
            let mut outfile = std::fs::File::create(&dest_path)
                .map_err(|e| format!("Failed to create {}: {}", file_name, e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Failed to extract {}: {}", file_name, e))?;

            if file_name == executable_name {
                found_exe = true;
            }
        } else {
            // Selective extraction: only grab named target files
            for target in &targets {
                if entry_name.ends_with(target.as_str()) {
                    let dest_path = dest_dir.join(target);
                    let mut outfile = std::fs::File::create(&dest_path)
                        .map_err(|e| format!("Failed to create {}: {}", target, e))?;
                    std::io::copy(&mut entry, &mut outfile)
                        .map_err(|e| format!("Failed to extract {}: {}", target, e))?;

                    if target == executable_name {
                        found_exe = true;
                    }
                    break;
                }
            }
        }
    }

    if !found_exe {
        return Err(format!(
            "Executable '{}' not found in zip archive",
            executable_name
        ));
    }

    Ok(())
}

/// Lazily fetch `WinRing0x64.sys` (the kernel driver xmrig loads for MSR
/// mod) into the miners directory, if it isn't already there. Deliberately
/// NOT part of the normal `download_miners` flow — see `get_extra_files` —
/// so a machine only ever has this file touch disk right before a session
/// that's actually going to attempt MSR mod. Ships inside xmrig's own
/// release zip, so this reuses the same pinned archive `download_miners`
/// resolves from `miners-manifest.json` rather than needing a second,
/// independently-versioned source.
///
/// The archive is SHA256-verified before extraction. That matters more here
/// than anywhere else in this file: the payload is a kernel-mode driver, and
/// an unverified one is on Microsoft's own Vulnerable Driver Blocklist radar.
///
/// Returns the driver path on success; leaves nothing behind on failure
/// (the temp zip is always cleaned up).
async fn ensure_msr_driver(app: &AppHandle) -> Result<PathBuf, String> {
    let miners_dir = get_miners_dir(app)?;
    let driver_path = miners_dir.join("WinRing0x64.sys");
    if driver_path.exists() {
        return Ok(driver_path);
    }

    let manifest = load_miners_manifest()?;
    let spec = manifest
        .miners
        .get("xmrig")
        .and_then(|e| e.win32.as_ref())
        .ok_or_else(|| "xmrig has no win32 entry in miners-manifest.json".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("MultiChainWallet/0.5.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let bytes = client
        .get(&spec.url)
        .send()
        .await
        .map_err(|e| format!("Failed to download xmrig zip: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read xmrig zip body: {}", e))?;

    let actual = hex_encode(&Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&spec.sha256) {
        return Err(format!(
            "SHA256 mismatch for the xmrig archive carrying WinRing0x64.sys — \
             expected {}, got {}. Refusing to extract a kernel driver from an \
             unverified download.",
            spec.sha256, actual
        ));
    }

    let tmp_zip = miners_dir.join(".ensure-msr-driver.tmp.zip");
    std::fs::write(&tmp_zip, &bytes)
        .map_err(|e| format!("Failed to write temp zip: {}", e))?;

    let extract_result = (|| -> Result<(), String> {
        let file = std::fs::File::open(&tmp_zip)
            .map_err(|e| format!("Failed to open temp zip: {}", e))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Failed to read zip archive: {}", e))?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read zip entry: {}", e))?;
            if entry.name().ends_with("WinRing0x64.sys") {
                let mut outfile = std::fs::File::create(&driver_path)
                    .map_err(|e| format!("Failed to create driver file: {}", e))?;
                std::io::copy(&mut entry, &mut outfile)
                    .map_err(|e| format!("Failed to extract driver file: {}", e))?;
                return Ok(());
            }
        }
        Err("WinRing0x64.sys not found in xmrig release archive".to_string())
    })();

    // Always clean up the temp zip, regardless of extraction outcome.
    let _ = std::fs::remove_file(&tmp_zip);
    extract_result?;
    Ok(driver_path)
}

/// Get the path to the miners directory
#[tauri::command]
pub async fn get_miners_dir_path(app: AppHandle) -> Result<String, String> {
    let miners_dir = get_miners_dir(&app)?;
    Ok(miners_dir.to_string_lossy().to_string())
}

/// Get the number of logical CPU threads available
#[tauri::command]
pub async fn get_cpu_thread_count() -> Result<usize, String> {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .map_err(|e| format!("Failed to get CPU thread count: {}", e))
}

/// Delete all miner executables from the miners directory so they can be
/// freshly re-downloaded (and fully extracted) on the next download pass.
/// Useful when a previous download only extracted the exe and is missing DLLs.
#[tauri::command]
pub async fn delete_miners(app: AppHandle) -> Result<(), String> {
    let miners_dir = get_miners_dir(&app)?;
    let definitions = get_miner_definitions();

    for miner in &definitions {
        let exe_path = miners_dir.join(&miner.executable);
        if exe_path.exists() {
            std::fs::remove_file(&exe_path)
                .map_err(|e| format!("Failed to remove {}: {}", miner.executable, e))?;
        }
    }

    Ok(())
}

/// Helper: create a hidden PowerShell command (no visible console window).
///
/// Cross-platform: on Linux this still returns a `Command::new("powershell")`
/// — calling code is Windows-specific and won't execute on Linux, but the
/// helper compiles in both targets so callers don't need cfg-guards.
fn hidden_powershell_command() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("powershell");
    crate::platform::apply_hidden_spawn(&mut cmd);
    cmd.args(["-ExecutionPolicy", "Bypass"]);
    cmd
}

/// Helper: create a hidden standard command (no visible console window).
/// On Linux this is a plain `Command::new(program)` — `apply_hidden_spawn`
/// is a no-op there.
fn hidden_command(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    crate::platform::apply_hidden_spawn(&mut cmd);
    cmd
}

/// Read the global "show miner window" flag. Used by the miner launch
/// paths to decide whether to hide the console. Defaults to `false`
/// (hidden) on lock-poison so a broken state doesn't accidentally
/// surface a window the user didn't ask for.
fn read_show_miner_window(app: &AppHandle) -> bool {
    app.state::<MinerWindowVisible>()
        .0
        .lock()
        .map(|g| *g)
        .unwrap_or(false)
}

/// Build a command for launching a miner binary. When `show_window` is
/// false (production default), suppresses the console window via
/// `CREATE_NO_WINDOW`. When true (debug toggle), passes `CREATE_NEW_CONSOLE`
/// so the child gets its own visible console window — needed because the
/// Tauri parent process is GUI-subsystem and has no console for the child
/// to inherit. Without `CREATE_NEW_CONSOLE`, "no `CREATE_NO_WINDOW`" still
/// gives the child no console at all.
///
/// On Linux this is a plain `Command::new(program)` — there's no equivalent
/// of `CREATE_NEW_CONSOLE` (xterm-style separate-window spawning isn't
/// something we want to wire), and `apply_hidden_spawn` is a no-op.
fn miner_command(program: &str, show_window: bool) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        if show_window {
            cmd.creation_flags(CREATE_NEW_CONSOLE);
        } else {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = show_window;
    }
    cmd
}

/// Toggle whether the miner's console window is shown. The change takes
/// effect on the next mining start — already-running miners keep their
/// current window state. Returns the new value.
#[tauri::command]
pub async fn set_miner_window_visible(
    app: AppHandle,
    visible: bool,
) -> Result<bool, String> {
    let state = app.state::<MinerWindowVisible>();
    let mut lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *lock = visible;
    Ok(*lock)
}

/// Read the current miner-window visibility setting.
#[tauri::command]
pub async fn get_miner_window_visible(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<MinerWindowVisible>();
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(*lock)
}

// Dev-fee runtime config + the four toggle commands were removed
// 2026-05-14. Dev fee is now hardcoded always-on; dev mode (diagnostic
// 50%) was retired. See top-of-file comment near where `DevFeeConfig`
// used to live, and `wiki/log.md` 2026-05-14 for the full ship notes.

/// Launch a process elevated using ShellExecuteExW with "runas" verb.
/// This triggers a proper UAC prompt and gives the child process a real admin token,
/// which is required for xmrig to load WinRing0 driver and apply MSR MOD.
///
/// Returns the PID of the launched elevated process.
///
/// `wait_for_exit` controls whether the function blocks until the elevated
/// process completes:
///
/// - `false` (used for `start_xmrig`): xmrig runs indefinitely; we need the
///   PID immediately so the watcher can be wired up. The handle is leaked
///   intentionally so the process reference stays alive.
/// - `true` (used for `setup_xmrig_task`): one-shot commands like
///   `schtasks /create` finish in <2 s but the previous fire-and-forget
///   behaviour caused the post-launch verify step to race the elevated
///   process. With `true`, we wait up to 30 s for exit, capture the
///   process's exit code, and surface a non-zero code as a clear error
///   instead of letting the caller see a misleading "task is not visible"
///   message.
/// Outcome of `shell_execute_elevated`. Carries the launched process's
/// PID, plus optionally its HANDLE.
///
/// - **`wait_for_exit = true`** (one-shot commands like `schtasks /create`):
///   the function blocks until the process exits, then closes the handle
///   internally. Returns `handle: None`.
/// - **`wait_for_exit = false`** (long-lived processes like xmrig): the
///   function returns immediately after launch and retains the handle by
///   wrapping it in `ElevatedHandle`. The caller is responsible for
///   eventually calling `TerminateProcess` + `CloseHandle` (typically via
///   `stop_xmrig`). The handle has full PROCESS_TERMINATE access from
///   creation time, so termination works without UAC.
pub struct ElevatedLaunch {
    pub pid: u32,
    pub handle: Option<ElevatedHandle>,
}

/// Linux/macOS stub. UAC-style elevation isn't applicable; the caller in
/// `start_xmrig` is currently Windows-only at the spawn-path level and won't
/// reach here on Linux. Keeping this stub lets the module compile cross-
/// platform so the rest of `miners.rs` can be Linux-aware later.
///
/// See `linux-port-implementation-status.md` Tier-A §3.2 — the actual Linux
/// miner spawn branch will short-circuit before reaching this stub.
#[cfg(not(target_os = "windows"))]
fn shell_execute_elevated(
    _exe_path: &str,
    _args: &str,
    _working_dir: &str,
    _wait_for_exit: bool,
    _show_window: bool,
) -> Result<ElevatedLaunch, String> {
    Err("Elevated launch is Windows-only — Linux miner spawn path not yet implemented (see Tier-A §3.2)".into())
}

#[cfg(target_os = "windows")]
fn shell_execute_elevated(
    exe_path: &str,
    args: &str,
    working_dir: &str,
    wait_for_exit: bool,
    show_window: bool,
) -> Result<ElevatedLaunch, String> {
    use std::mem;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessId, WaitForSingleObject,
    };
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(exe_path);
    let parameters = HSTRING::from(args);
    let directory = HSTRING::from(working_dir);

    let nshow_value = if show_window {
        SW_SHOWNORMAL.0 as i32
    } else {
        SW_HIDE.0 as i32
    };

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: windows::core::PCWSTR(verb.as_ptr()),
        lpFile: windows::core::PCWSTR(file.as_ptr()),
        lpParameters: windows::core::PCWSTR(parameters.as_ptr()),
        lpDirectory: windows::core::PCWSTR(directory.as_ptr()),
        nShow: nshow_value,
        ..unsafe { mem::zeroed() }
    };

    let result = unsafe { ShellExecuteExW(&mut sei) };

    match result {
        Ok(()) => {
            let handle: HANDLE = sei.hProcess;
            if handle.is_invalid() || handle.0 == std::ptr::null_mut() {
                return Err("UAC prompt was declined or process failed to start.".to_string());
            }
            let pid = unsafe { GetProcessId(handle) };
            if pid == 0 {
                return Err("Failed to get PID of elevated process.".to_string());
            }

            if wait_for_exit {
                // 30-s budget. `schtasks /create` finishes in <2 s on a
                // healthy system; AV-scanned binaries occasionally take a
                // bit longer, so the generous ceiling avoids spurious
                // timeouts.
                const TIMEOUT_MS: u32 = 30_000;
                let wait = unsafe { WaitForSingleObject(handle, TIMEOUT_MS) };
                // WAIT_OBJECT_0 = 0 means the process exited. Anything else
                // is timeout / abandoned / failed.
                if wait.0 != 0 {
                    let _ = unsafe { CloseHandle(handle) };
                    return Err(format!(
                        "Elevated process did not exit within {}ms (WaitForSingleObject status 0x{:x}). The schtasks.exe registration may still be in flight; try again in a few seconds.",
                        TIMEOUT_MS, wait.0
                    ));
                }
                let mut code: u32 = 0;
                let exit_ok = unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok();
                let _ = unsafe { CloseHandle(handle) };
                if !exit_ok {
                    return Err("Failed to read elevated process exit code.".to_string());
                }
                if code != 0 {
                    return Err(format!(
                        "Elevated process exited with code {} (schtasks.exe failure — common causes: Group Policy blocks Task Scheduler, AV intercepted the command, malformed task XML).",
                        code
                    ));
                }
                // One-shot command done; handle already closed above.
                return Ok(ElevatedLaunch { pid, handle: None });
            }
            // When wait_for_exit=false, RETAIN the handle so the caller
            // can terminate the long-lived process later. Pre-2026-05-13
            // this handle was leaked, which meant `stop_xmrig` had no way
            // to kill the elevated xmrig from medium IL — `taskkill /F`
            // silently failed and xmrig kept mining after the user clicked
            // "Stop Mining". TerminateProcess(handle) works because the
            // handle has PROCESS_TERMINATE access from creation time,
            // regardless of the wallet's IL.
            Ok(ElevatedLaunch {
                pid,
                handle: Some(ElevatedHandle::from_raw(handle)),
            })
        }
        Err(e) => {
            let msg = format!("{}", e);
            if msg.contains("1223") || msg.contains("cancelled") || msg.contains("canceled") {
                Err("UAC prompt was declined. Admin privileges are required for MSR MOD to maximize mining performance.".to_string())
            } else {
                Err(format!("Failed to launch elevated process: {}", e))
            }
        }
    }
}

/// 2026-05-18 — Resolve the path for a miner's own log file. Returns
/// `None` in release builds ([`miner_logging_active`]-gated) and on any
/// directory-resolution failure. The returned path lives in the
/// `app_log_dir` so all diagnostic files co-locate.
///
/// Format: `miner-<algo>-<kind>-<YYYYMMDDTHHMMSSZ>.log`
///   - `<algo>` is the lowercased algorithm name (`randomx`,
///     `octopus`, `kawpow`, `autolykos2`).
///   - `<kind>` is `cpu` or `gpu`.
///
/// The miner writes to this path directly via its `--log-file` /
/// `--logfile` flag — we don't pipe stdout/stderr because the Windows
/// xmrig path is elevated and we don't own its pipes from outside.
/// Using the miner's built-in flag works for both Windows-elevated
/// and Linux-direct spawn paths.
pub(crate) fn resolve_miner_log_path(
    app: &AppHandle,
    algo: &str,
    kind: &str,
) -> Option<PathBuf> {
    // Debug-only. When off, no path resolves → no `--log-file` flag
    // appended → no file created by the miner. Keeps release builds and
    // `tauri dev` runs that don't need captures clean of disk bloat.
    if !miner_logging_active() {
        return None;
    }
    let dir = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("logs")))
        .ok()?;
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let algo_slug = sanitize_algo_slug(algo);
    Some(dir.join(format!("miner-{}-{}-{}.log", algo_slug, kind, ts)))
}

/// Make an algorithm string filename-safe. xmrig's RandomX variants contain a
/// slash (`rx/0`, `rx/wow`, `cn/r`, …); on Windows `/` is a path separator, so
/// an unsanitized slug silently breaks `--log-file` — xmrig's open fails
/// because the implied parent directory (`miner-rx/`) was never created, and
/// no CPU miner log is ever written. Replace every non-alphanumeric character
/// with `_` so `rx/0` → `rx_0`. GPU algos (`autolykos2`, `kawpow`, `octopus`)
/// have no slash and are unaffected.
fn sanitize_algo_slug(algo: &str) -> String {
    algo.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod miner_definition_tests {
    use super::get_miner_definitions;

    /// binary-bundling-plan T2: the shipped miner set is exactly xmrig,
    /// lolMiner, SRBMiner-MULTI. rigel was dropped 2026-08-28 (no advertised GPU
    /// algo was rigel-exclusive). Re-adding a miner must be deliberate, so this
    /// pins the set — a silent re-add (or an accidental drop) goes red here.
    #[test]
    fn get_miner_definitions_is_exactly_the_three() {
        let names: Vec<String> = get_miner_definitions()
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(
            names,
            vec![
                "xmrig".to_string(),
                "lolMiner".to_string(),
                "SRBMiner-MULTI".to_string(),
            ],
            "shipped miner set changed — update binary-bundling-plan + the bundle producer if intentional"
        );
        assert!(
            !names.iter().any(|n| n == "rigel"),
            "rigel was dropped (T2); do not re-add without updating the manifest, wix, and the plan"
        );
    }
}

#[cfg(test)]
mod xmrig_api_port_tests {
    use super::{pick_xmrig_http_port, XMRIG_HTTP_PORT};
    use std::net::TcpListener;

    #[test]
    fn avoids_the_canonical_port_when_it_is_occupied() {
        // Create the precondition: hold 3333 for the test's duration so the
        // picker is forced to fall back (the orphan-miner-squatting case).
        let hog = match TcpListener::bind(("127.0.0.1", XMRIG_HTTP_PORT)) {
            Ok(l) => l,
            // Environment already uses 3333 — can't set up the case
            // deterministically; skip rather than flake.
            Err(_) => return,
        };
        let port = pick_xmrig_http_port();
        assert_ne!(
            port, XMRIG_HTTP_PORT,
            "must not hand back the occupied canonical port"
        );
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "fallback port {} should itself be free/bindable",
            port
        );
        drop(hog);
    }
}

#[cfg(test)]
mod log_path_tests {
    use super::sanitize_algo_slug;

    #[test]
    fn sanitizes_randomx_slash() {
        assert_eq!(sanitize_algo_slug("rx/0"), "rx_0");
        assert_eq!(sanitize_algo_slug("rx/wow"), "rx_wow");
        assert_eq!(sanitize_algo_slug("argon2/chukwa"), "argon2_chukwa");
    }

    #[test]
    fn lowercases_and_leaves_safe_algos_intact() {
        assert_eq!(sanitize_algo_slug("KAWPOW"), "kawpow");
        assert_eq!(sanitize_algo_slug("autolykos2"), "autolykos2");
        assert_eq!(sanitize_algo_slug("octopus"), "octopus");
    }

    #[test]
    fn never_contains_path_separators() {
        for a in ["rx/0", "rx/wow", "cn/r", "argon2/chukwa"] {
            let s = sanitize_algo_slug(a);
            assert!(!s.contains('/') && !s.contains('\\'), "slug {s} has a separator");
        }
    }
}

/// Store the active miner-log path in the corresponding state slot.
/// Replaces any prior value (a new spawn supersedes the previous
/// session's log). Debug-only; a no-op in release builds.
pub(crate) fn record_miner_log_path(app: &AppHandle, kind: &str, path: PathBuf) {
    if !miner_logging_active() {
        return;
    }
    let state = app.state::<MinerLogPaths>();
    // Keep `state` alive throughout the match so the &Mutex borrow
    // doesn't outlive the State<T> Deref wrapper.
    match kind {
        "cpu" => {
            if let Ok(mut guard) = state.cpu.lock() {
                *guard = Some(path);
            }
        }
        "gpu" => {
            if let Ok(mut guard) = state.gpu.lock() {
                *guard = Some(path);
            }
        }
        _ => {}
    }
}

/// CPU thread-selection args for a single xmrig launch. Mirrors the three
/// (largely independent) axes xmrig exposes for controlling CPU usage:
///
/// - `threads`               → literal `--threads=N`. Bypasses xmrig's own
///                              cache/topology autoconfig entirely — used
///                              for the "Low" tier's small fixed footprint.
/// - `cpu_max_threads_hint`  → `--cpu-max-threads-hint=P` (percentage,
///                              1-100). Lets xmrig's own cache- and
///                              topology-aware autoconfig pick the actual
///                              thread count and core placement — used for
///                              "Medium" so the wallet never has to
///                              hardcode per-CPU assumptions (SMT pairing,
///                              P-core/E-core, L2/L3 budget) for hardware
///                              it's never seen.
/// - `cpu_priority`          → `--cpu-priority=N` (0-5, Windows process
///                              priority class). Independent of thread
///                              count/placement — targets OS scheduling
///                              responsiveness directly.
///
/// `threads` and `cpu_max_threads_hint` are mutually exclusive in practice
/// (xmrig honors an explicit `--threads` over the hint if both were ever
/// passed); `None` on any field omits that flag, preserving xmrig's own
/// default for that axis. See `wiki/concepts/mining-process-management.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CpuThreadArgs {
    pub threads: Option<usize>,
    pub cpu_max_threads_hint: Option<u8>,
    pub cpu_priority: Option<u8>,
}

/// Clamp an explicit thread count from the UI's thread slider to
/// `1..=logical`. `logical == 0` means detection failed: the count is then
/// only floored at 1, never guessed at from nothing. Shared by both CPU miners
/// (xmrig `-t, --threads=N`; SRBMiner `--cpu-threads`).
pub(crate) fn clamp_cpu_thread_count(threads: usize, logical: usize) -> usize {
    let n = threads.max(1);
    if logical > 0 {
        n.min(logical)
    } else {
        n
    }
}

/// Whether an explicit thread count is a "background" footprint that should
/// also lower scheduling priority: at most `max(2, logical / 4)` threads and
/// fewer than all of them. This keeps the old LOW tier's behaviour (2 threads
/// at lowered priority on any machine) for every slider position near it.
/// Mirrored by `miningTuning.ts::cpuThreadsLowPriority`.
pub(crate) fn cpu_threads_low_priority(threads: usize, logical: usize) -> bool {
    let below_all = logical == 0 || threads < logical;
    below_all && threads <= std::cmp::max(2, logical / 4)
}

/// Append the CPU thread-selection flags described by [`CpuThreadArgs`] to
/// an xmrig argv. Pure function — no spawn/state — so it's covered by
/// `cpu_thread_args_tests` below without needing a real xmrig binary.
fn push_cpu_thread_args(args: &mut Vec<String>, t: CpuThreadArgs) {
    if let Some(n) = t.threads {
        if n > 0 {
            args.push(format!("--threads={}", n));
        }
    } else if let Some(hint) = t.cpu_max_threads_hint {
        args.push(format!("--cpu-max-threads-hint={}", hint.clamp(1, 100)));
    }
    if let Some(priority) = t.cpu_priority {
        args.push(format!("--cpu-priority={}", priority.clamp(0, 5)));
    }
}

#[cfg(test)]
mod cpu_thread_args_tests {
    use super::{push_cpu_thread_args, CpuThreadArgs};

    #[test]
    fn low_pushes_literal_threads_and_priority_no_hint() {
        let mut args = vec![];
        push_cpu_thread_args(
            &mut args,
            CpuThreadArgs {
                threads: Some(2),
                cpu_max_threads_hint: None,
                cpu_priority: Some(1),
            },
        );
        assert_eq!(args, vec!["--threads=2", "--cpu-priority=1"]);
    }

    #[test]
    fn medium_pushes_hint_and_priority_no_threads_flag() {
        let mut args = vec![];
        push_cpu_thread_args(
            &mut args,
            CpuThreadArgs {
                threads: None,
                cpu_max_threads_hint: Some(50),
                cpu_priority: Some(2),
            },
        );
        assert_eq!(args, vec!["--cpu-max-threads-hint=50", "--cpu-priority=2"]);
    }

    #[test]
    fn high_pushes_nothing() {
        let mut args = vec![];
        push_cpu_thread_args(&mut args, CpuThreadArgs::default());
        assert!(args.is_empty());
    }

    #[test]
    fn threads_takes_priority_over_hint_when_both_set() {
        // Shouldn't happen from our own callers today, but pins the
        // documented "threads wins" precedence in case of a future
        // caller mistake.
        let mut args = vec![];
        push_cpu_thread_args(
            &mut args,
            CpuThreadArgs {
                threads: Some(4),
                cpu_max_threads_hint: Some(50),
                cpu_priority: None,
            },
        );
        assert_eq!(args, vec!["--threads=4"]);
    }

    #[test]
    fn threads_zero_is_treated_as_omit_not_as_flag() {
        let mut args = vec![];
        push_cpu_thread_args(
            &mut args,
            CpuThreadArgs {
                threads: Some(0),
                cpu_max_threads_hint: None,
                cpu_priority: None,
            },
        );
        assert!(args.is_empty());
    }

    #[test]
    fn hint_is_clamped_to_1_100() {
        let mut args = vec![];
        push_cpu_thread_args(
            &mut args,
            CpuThreadArgs {
                threads: None,
                cpu_max_threads_hint: Some(0),
                cpu_priority: None,
            },
        );
        assert_eq!(args, vec!["--cpu-max-threads-hint=1"]);

        let mut args2 = vec![];
        push_cpu_thread_args(
            &mut args2,
            CpuThreadArgs {
                threads: None,
                cpu_max_threads_hint: Some(255),
                cpu_priority: None,
            },
        );
        assert_eq!(args2, vec!["--cpu-max-threads-hint=100"]);
    }

    #[test]
    fn slider_thread_count_is_clamped_to_the_detected_processors() {
        use super::clamp_cpu_thread_count;
        assert_eq!(clamp_cpu_thread_count(0, 32), 1);
        assert_eq!(clamp_cpu_thread_count(12, 32), 12);
        assert_eq!(clamp_cpu_thread_count(64, 32), 32);
        // Detection failed: floor only, never an invented ceiling.
        assert_eq!(clamp_cpu_thread_count(64, 0), 64);
        assert_eq!(clamp_cpu_thread_count(0, 0), 1);
    }

    #[test]
    fn only_a_small_partial_footprint_lowers_priority() {
        use super::cpu_threads_low_priority;
        // The old LOW tier: 2 threads, lowered, on any machine with more.
        assert!(cpu_threads_low_priority(2, 32));
        assert!(cpu_threads_low_priority(2, 4));
        assert!(cpu_threads_low_priority(8, 32));
        assert!(!cpu_threads_low_priority(9, 32));
        // All threads is never "background", however small the CPU.
        assert!(!cpu_threads_low_priority(2, 2));
        assert!(!cpu_threads_low_priority(32, 32));
        // Unknown core count: the fixed floor of 2 still applies.
        assert!(cpu_threads_low_priority(2, 0));
        assert!(!cpu_threads_low_priority(3, 0));
    }

    #[test]
    fn priority_is_clamped_to_0_5() {
        let mut args = vec![];
        push_cpu_thread_args(
            &mut args,
            CpuThreadArgs {
                threads: None,
                cpu_max_threads_hint: None,
                cpu_priority: Some(255),
            },
        );
        assert_eq!(args, vec!["--cpu-priority=5"]);
    }
}

/// Start xmrig CPU miner with proper admin elevation.
///
/// enable_msr: the user's toggle. When true AND the environment scan doesn't
/// already know this machine blocks it (see `should_attempt_msr_mod`), lazily
/// fetches the WinRing0 driver (`ensure_msr_driver`) and passes
/// `--randomx-wrmsr=6` for MSR optimization (may still fail at write time on
/// some Windows setups). Otherwise passes `--randomx-wrmsr=-1` for stable
/// mining without MSR — NOT `--randomx-no-wrmsr`, which doesn't exist in
/// xmrig 6.x (see the `attempt_msr` block below).
/// HTTP API is enabled on XMRIG_HTTP_PORT for hashrate polling.
///
/// `chain_ticker` is retained in the signature for frontend
/// compatibility but is no longer used — it keyed the dev-fee wallet
/// registry, removed 2026-07-06 (pure-wallet cutover). xmrig now
/// connects direct to the user's pool.
///
/// `threads` / `cpu_max_threads_hint` / `cpu_priority` together implement
/// the CPU mining-intensity tiers (Low/Medium/High). The frontend
/// (`devicePower.ts::cpuThreadArgsForIntensity`) computes exactly one of
/// `threads` or `cpu_max_threads_hint` per tier (never both) plus an
/// optional `cpu_priority`; this command just forwards them to xmrig via
/// [`push_cpu_thread_args`]. See `wiki/concepts/mining-process-management.md`.
#[tauri::command]
pub async fn start_xmrig(
    app: AppHandle,
    pool: String,
    user_string: String,
    algorithm: String,
    threads: Option<usize>,
    cpu_max_threads_hint: Option<u8>,
    cpu_priority: Option<u8>,
    enable_msr: bool,
    pass: Option<String>,
    enable_tls: Option<bool>,
    proxy: Option<String>,
    chain_ticker: Option<String>,
) -> Result<(), String> {
    // RAII "already starting" sentinel. Caught the duplicate-session
    // race observed in `dev-fee-20260513T073*-cpu.jsonl`: three Start
    // clicks during the UAC prompt all passed the existing
    // `MinerProcess.is_some()` check because that slot isn't populated
    // until ShellExecuteExW + watcher spawn have completed (a 2-5 s
    // window during which a second/third call observes None).
    // `StartGuard::try_acquire` is an atomic compare-and-swap that
    // wins exactly once; subsequent concurrent callers get None and
    // bail with a clean error.
    //
    // Bind state to a local so its lifetime spans the guard's lifetime
    // (the guard holds a `&AtomicBool` borrowed from the state's
    // inner field — a temporary `app.state::<_>()` would be dropped
    // immediately after the field access otherwise).
    let starting_state = app.state::<MinerStarting>();
    let _starting_guard = StartGuard::try_acquire(&starting_state.0)
        .ok_or_else(|| {
            "Mining is already starting. Wait for the current start to finish, or stop it first.".to_string()
        })?;

    // `chain_ticker` was consumed by the CPU dev-fee proxy wrap, removed
    // 2026-07-06 (pure-wallet cutover). Retained in the command signature
    // for frontend compatibility but no longer used.
    let _ = &chain_ticker;

    let pass = pass.unwrap_or_else(default_xmrig_pass);
    let enable_tls = enable_tls.unwrap_or_else(default_xmrig_tls);
    let miners_dir = get_miners_dir(&app)?;
    let xmrig_name = format!("xmrig{}", crate::platform::EXE_SUFFIX);
    let xmrig_path = miners_dir.join(&xmrig_name);

    if !xmrig_path.exists() {
        return Err(format!(
            "{} not found. Please download mining software first.",
            xmrig_name
        ));
    }

    // Check if already running — scope the lock so it's dropped before any .await.
    // The StartGuard above prevents concurrent callers from racing
    // through this check; this still catches the case where a prior
    // session is alive and the user hits Start again after it.
    {
        let state = app.state::<MinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut child) = *process {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *process = None;
                }
                Ok(None) => {
                    return Err("Miner is already running. Stop it first.".to_string());
                }
                Err(_) => {
                    *process = None;
                }
            }
        }
    } // MutexGuard dropped here

    // …and refuse while the OTHER CPU backend holds the lane. There is one
    // CPU lane and one CPU session; without this, starting RandomX during a
    // XelisHash session would run two CPU miners that each think they own
    // every core, and the frontend (which tracks one CPU session) would show
    // one of them. The mirror of this check lives in `start_srbminer_cpu`.
    {
        let state = app.state::<SrbCpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut child) = *process {
            match child.try_wait() {
                Ok(Some(_)) => *process = None,
                Ok(None) => {
                    return Err(
                        "The CPU is already mining with SRBMiner. Stop that session first."
                            .to_string(),
                    )
                }
                Err(_) => *process = None,
            }
        }
    } // MutexGuard dropped here

    // -------------------------------------------------------------------
    // Direct pool connection. The dev-fee stratum proxy was removed
    // 2026-07-06 (pure-wallet cutover) — xmrig connects straight to the
    // user's chosen pool. SOCKS5 proxy mode below still applies for
    // firewall escape.
    // -------------------------------------------------------------------
    let effective_pool = pool.clone();
    let effective_tls = enable_tls;

    // Build xmrig arguments: pool, user, password, [tls], algo, no-color
    let mut xmrig_args = vec![
        "-o".to_string(),
        effective_pool,
        "-u".to_string(),
        user_string,
        "-p".to_string(),
        pass,
        "-a".to_string(),
        algorithm.clone(),
        "--no-color".to_string(),
    ];

    if effective_tls {
        xmrig_args.push("--tls".to_string());
    }

    // SOCKS5 proxy mode (firewall escape). xmrig connects to the pool
    // through the user's chosen SOCKS5 proxy when set. (The dev-fee
    // localhost wrap that used to gate this was removed 2026-07-06.)
    if let Some(p) = proxy.as_deref() {
        if let Some(host_port) = normalize_socks_proxy(p) {
            xmrig_args.push(format!("--proxy=socks5://{}", host_port));
        }
    }

    // Decide whether to actually attempt MSR mod this session. `enable_msr`
    // is the user's toggle; `should_attempt_msr_mod` additionally consults
    // the environment scan so a machine already known to block it (HVCI,
    // Vulnerable Driver Blocklist, or a WinRing0 service collision) never
    // has the driver fetched or touched at all — not "attempt and fail",
    // just skipped outright. Scan failure fails open (attempt normally)
    // rather than blocking mining on a diagnostic hiccup.
    let msr_blocked_by_env = if enable_msr {
        get_env_scan(&app, false)
            .await
            .map(|plan| !should_attempt_msr_mod(&plan))
            .unwrap_or(false)
    } else {
        false
    };
    let attempt_msr = enable_msr && !msr_blocked_by_env;

    if attempt_msr {
        match ensure_msr_driver(&app).await {
            Ok(_) => {
                xmrig_args.push("--randomx-wrmsr=6".to_string());
            }
            // Lazy fetch failed (e.g. offline, GitHub unreachable) — fail
            // open and mine without MSR mod rather than blocking the
            // session on it.
            Err(_) => {
                xmrig_args.push("--randomx-wrmsr=-1".to_string());
            }
        }
    } else {
        // `--randomx-wrmsr=-1` disables the MSR mod. NOT `--randomx-no-wrmsr`
        // — that flag does not exist in xmrig 6.x; the miner aborts at startup
        // with `unknown option -- randomx-no-wrmsr` (observed in the launcher's
        // xmrig.log), so MSR-off sessions never started at all. See log.md
        // 2026-06-30.
        xmrig_args.push("--randomx-wrmsr=-1".to_string());
    }

    // HTTP API for hashrate polling (localhost only). Pick a free port —
    // prefer the canonical 3333, but fall back to an OS-assigned free port if
    // an orphan miner is squatting on it — and record it in XMRIG_API_PORT so
    // the snapshot poll targets the port xmrig actually binds (not a dead
    // fixed 3333). 2026-06-30 blank-hashrate fix; see log.md.
    let api_port = pick_xmrig_http_port();
    XMRIG_API_PORT.store(api_port, std::sync::atomic::Ordering::Relaxed);
    xmrig_args.push("--http-enabled".to_string());
    xmrig_args.push("--http-host=127.0.0.1".to_string());
    xmrig_args.push(format!("--http-port={}", api_port));

    // Fast reconnect on pool-disconnect. xmrig's defaults are
    // --retry-pause 5 / --retries 5 = 25s of tolerance before giving
    // up; a brief pool blip would kill the session. retry-pause=1 +
    // retries=100 keeps generous headroom for transient errors (pool
    // unreachable for a few seconds doesn't stop mining).
    xmrig_args.push("--retry-pause=1".to_string());
    xmrig_args.push("--retries=100".to_string());

    // The thread slider sends an exact count; never hand xmrig more threads
    // than the machine has (a stale persisted value from a bigger CPU, or a
    // caller bug). Detection only runs when a count was actually sent.
    let threads = match threads {
        Some(n) if n > 0 => Some(clamp_cpu_thread_count(n, detect_logical_processors().await)),
        other => other,
    };
    push_cpu_thread_args(
        &mut xmrig_args,
        CpuThreadArgs {
            threads,
            cpu_max_threads_hint,
            cpu_priority,
        },
    );

    // 2026-05-18 — Debug-only miner-log capture. Appends xmrig's
    // `--log-file=<path>` so the miner writes its OWN console output
    // (share events, "Pool not responding", pool diff, accept/reject)
    // to a file we can grep post-session. Release builds skip this
    // entirely (`miner_logging_active()`-gated inside
    // `resolve_miner_log_path`).
    // Resolve the per-session miner-log path ONCE and reuse it for both the
    // `--log-file` flag and the live tail task below, so the tail watches the
    // exact file xmrig writes. (Previously the tail watched a never-written
    // `miners_dir/xmrig.log`, leaving the HashrateFixPanel blind on CPU.)
    let cpu_miner_log_path = resolve_miner_log_path(&app, &algorithm, "cpu");
    if let Some(ref log_path) = cpu_miner_log_path {
        xmrig_args.push(format!(
            "--log-file={}",
            log_path.to_string_lossy()
        ));
        record_miner_log_path(&app, "cpu", log_path.clone());
    }

    // Emit MSR status for UI (we don't parse logs; backend just reports intent)
    crate::emit_meter::bump("msr-status");
    let _ = app.emit(
        "msr-status",
        MsrStatusPayload {
            status: if attempt_msr { "unknown".to_string() } else { "disabled".to_string() },
            message: if attempt_msr {
                Some("MSR optimization enabled. If hashrate is low, try disabling MSR in settings.".to_string())
            } else if msr_blocked_by_env {
                Some("MSR optimization skipped — this machine's security settings (Memory Integrity / Vulnerable Driver Blocklist) block it. Mining without MSR mod.".to_string())
            } else {
                Some("Mining without MSR optimization.".to_string())
            },
        },
    );

    let args_string = xmrig_args.join(" ");
    let exe_path_str = xmrig_path.to_string_lossy().to_string();
    let working_dir_str = miners_dir.to_string_lossy().to_string();

    // ── Linux spawn branch ────────────────────────────────────────────
    // No UAC equivalent on Linux. Run xmrig unprivileged and surface a
    // non-blocking perf-hint event if MSR / hugepages aren't configured —
    // the user can mine at ~95% hashrate without those, so don't block.
    //
    // We own the Child directly (no separate elevated process), so the
    // watcher slot stores the Child itself and `stop_xmrig` can call
    // `Child::kill()` directly. No hidden-watcher PowerShell process.
    //
    // See linux-port-plan §3.2 + linux-port-implementation-status.
    #[cfg(target_os = "linux")]
    {
        let prereqs = crate::platform::probe_randomx_prereqs();
        if !prereqs.msr_available || !prereqs.hugepages_configured {
            crate::emit_meter::bump("miner-perf-hint");
            let _ = app.emit("miner-perf-hint", &prereqs);
        }

        let mut cmd = tokio::process::Command::new(&exe_path_str);
        cmd.args(&xmrig_args);
        cmd.current_dir(&working_dir_str);
        cmd.kill_on_drop(true);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn xmrig: {}", e))?;
        let pid = child.id().ok_or_else(|| "xmrig PID unavailable".to_string())?;

        {
            let state = app.state::<MinerProcess>();
            let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
            *process = Some(child);
        }
        {
            let pid_state = app.state::<MinerPid>();
            let mut pid_lock = pid_state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
            *pid_lock = Some(pid);
        }

        // Skip spawn_log_tail_task on Linux — that path watches a log
        // file the Linux xmrig build doesn't produce by default. The
        // hashrate path uses xmrig's HTTP API at XMRIG_HTTP_PORT, which
        // works identically on both targets.
        return Ok(());
    }

    // ── Windows elevated launch (Use ShellExecuteExW with "runas") ────
    // This is done on a blocking thread because ShellExecuteExW is synchronous
    // and triggers the UAC dialog. wait_for_exit=false because xmrig is a
    // long-lived process — we want the PID right away so the watcher can be
    // wired up; the process keeps running in the background.
    //
    // `show_miner_window` is read from the global `MinerWindowVisible` state;
    // when on (debug toggle), xmrig's console pops up so the user sees live
    // share/diff output. Hidden by default.
    let show_miner_window = read_show_miner_window(&app);
    let launch = tokio::task::spawn_blocking(move || {
        shell_execute_elevated(
            &exe_path_str,
            &args_string,
            &working_dir_str,
            false,
            show_miner_window,
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    let pid = launch.pid;

    // Retain the elevated process handle so `stop_xmrig` can call
    // `TerminateProcess(handle)` from medium IL. Without this the
    // `taskkill /F /PID` fallback can't kill the high-IL xmrig and the
    // process keeps mining after the user clicks Stop. The handle has
    // full PROCESS_TERMINATE access from creation time, so termination
    // is possible without UAC.
    if let Some(handle) = launch.handle {
        let handle_state = app.state::<MinerHandle>();
        let mut slot = handle_state
            .0
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        *slot = Some(handle);
    }

    // Spawn a hidden watcher process that waits for xmrig to exit
    let mut watcher_cmd = hidden_powershell_command();
    watcher_cmd.args([
        "-Command",
        &format!("Wait-Process -Id {} -ErrorAction SilentlyContinue", pid),
    ]);
    let watcher = watcher_cmd
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to create process watcher: {}", e))?;

    // Store the watcher and PID — separate lock scopes, no .await while holding
    {
        let state = app.state::<MinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        *process = Some(watcher);
    }
    {
        let pid_state = app.state::<MinerPid>();
        let mut pid_lock = pid_state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        *pid_lock = Some(pid);
    }

    // Watch for an unexpected xmrig exit (crash / OOM-kill / killed by AV) and
    // surface it to the UI. Started only after the pid + watcher slots are
    // populated, so the first poll can't race the launch. See
    // `spawn_miner_death_watch`.
    spawn_miner_death_watch(app.clone(), MinerLane::Cpu);

    // Phase 7: spawn the log-tail task on the SAME file xmrig writes via
    // `--log-file`, so MSR / huge-pages / ready status flows to the UI. Only
    // when dev-logging is active (no `--log-file` → no file → nothing to tail).
    if let Some(log_path) = cpu_miner_log_path {
        spawn_log_tail_task(app.clone(), log_path);
    }

    Ok(())
}

fn default_xmrig_pass() -> String { "xmr".to_string() }
fn default_xmrig_tls() -> bool { true }

/// Stop the running xmrig process (kills the elevated process via taskkill).
/// `reason` is logged as the `SessionEnded` reason; the frontend passes a
/// specific reason for non-user stops (miner death, SOCKS5 exhausted, etc.)
/// and omits it for a genuine Stop-button click (→ "user stopped CPU mining").
#[tauri::command]
pub async fn stop_xmrig(app: AppHandle, reason: Option<String>) -> Result<(), String> {
    // Get the elevated xmrig PID + retained process handle.
    let pid = {
        let pid_state = app.state::<MinerPid>();
        let mut pid_lock = pid_state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        pid_lock.take()
    };
    let retained_handle = {
        let handle_state = app.state::<MinerHandle>();
        let mut slot = handle_state
            .0
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        slot.take()
    };

    // Primary kill path: use the retained handle to call
    // `TerminateProcess`. This works from medium IL because the handle
    // carries PROCESS_TERMINATE access from creation — IL enforcement
    // happens at handle-open time, not at use time. Pre-2026-05-13
    // this path didn't exist and `taskkill /F` silently failed against
    // the high-IL xmrig, leaving the process mining in the background
    // after the user clicked Stop.
    #[allow(unused_mut)]
    let mut terminated_via_handle = false;
    #[cfg(target_os = "windows")]
    if let Some(eh) = retained_handle {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::TerminateProcess;
        let handle = eh.as_handle();
        let ok = unsafe { TerminateProcess(handle, 1) }.is_ok();
        let _ = unsafe { CloseHandle(handle) };
        terminated_via_handle = ok;
    }

    // Defensive fallback: if the handle path failed or wasn't available
    // (e.g. handle was already closed by an earlier stop attempt, or the
    // app crashed and restarted while xmrig was still running), try the
    // cross-platform PID kill via `platform::kill_pid_force` — `taskkill /F`
    // on Windows, `kill -9` on Linux. On non-elevated xmrig (Linux always,
    // Windows only if the user declined UAC at start) this works directly.
    // On elevated Windows xmrig it'll fail (medium-IL → high-IL block), but
    // failing is harmless — `TerminateProcess` already succeeded above.
    if !terminated_via_handle {
        if let Some(pid) = pid {
            let _ = crate::platform::kill_pid_force(pid).await;

            // Last-ditch Windows fallback (Stop-Process). Same caveat applies
            // — runs at medium IL, can't kill high-IL xmrig. Kept for the
            // edge case where neither handle nor `kill_pid_force` worked
            // but we want to surface a clear error in the next `is_mining`
            // check. Linux doesn't need this — `kill -9` either succeeds
            // or the process is already gone.
            #[cfg(target_os = "windows")]
            {
                let mut ps_cmd = hidden_powershell_command();
                ps_cmd.args([
                    "-Command",
                    &format!(
                        "Stop-Process -Id {} -Force -ErrorAction SilentlyContinue",
                        pid
                    ),
                ]);
                let _ = ps_cmd.output().await;
            }
        }
    }

    // Also kill the watcher process
    let mut watcher = {
        let state = app.state::<MinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        process.take()
    };

    if let Some(ref mut c) = watcher {
        let _ = c.kill().await;
    }

    // The dev-fee proxy + per-session logger were removed 2026-07-06
    // (pure-wallet cutover). xmrig now connects direct to the user's
    // pool, so there is no proxy to tear down here. `reason` is retained
    // in the command signature for frontend compatibility (callers still
    // pass a teardown reason) but is no longer logged.
    let _ = reason;

    Ok(())
}

/// Get current GPU miner hashrate from its HTTP stats API. Caller passes
/// the running miner type ("SRBMiner-MULTI" or "lolMiner") because the
/// JSON shape differs between the two:
///
/// - **SRBMiner**: `algorithms[0].hashrate.{1min, gpu.total}` — values are
///   already in H/s. We prefer the 1-minute smoothed average to avoid UI
///   jitter, falling back to the instantaneous gpu.total when 1min is 0
///   (mining just started).
/// - **lolMiner**: `Algorithms[0].Total_Performance × Performance_Factor`.
///   `Total_Performance` is in the unit named by `Performance_Unit`
///   (Mh/s, Gh/s, etc.), and `Performance_Factor` is the multiplier to
///   reach H/s — using both means we don't have to hard-code unit
///   conversion per algorithm.
///
/// Returns Some(H/s) when hashrate > 0, None if API unreachable or no shares yet.
///
/// Polls the port the current session actually bound ([`GPU_API_PORT`]), not
/// the fixed preference — see [`pick_loopback_api_port`].
#[tauri::command]
pub async fn get_gpu_miner_hashrate(miner: String) -> Result<Option<f64>, String> {
    let port = GPU_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let v = match fetch_miner_api_json(port).await? {
        Some(v) => v,
        None => return Ok(None),
    };

    let h = if miner == "lolMiner" {
        let algo = &v["Algorithms"][0];
        let perf = algo["Total_Performance"].as_f64().unwrap_or(0.0);
        let factor = algo["Performance_Factor"].as_f64().unwrap_or(1.0);
        perf * factor
    } else {
        // Default branch covers "SRBMiner-MULTI" and any other JSON of that shape
        parse_srbminer_api(&v, SrbLane::Gpu).hashrate.unwrap_or(0.0)
    };

    Ok(if h > 0.0 { Some(h) } else { None })
}

/// GET `http://127.0.0.1:<port>/` and parse the body as JSON.
///
/// `Ok(None)` when the API is unreachable, answers non-2xx, or returns
/// something that is not JSON: every stats poll treats absence as "keep the
/// last snapshot" rather than an error.
async fn fetch_miner_api_json(port: u16) -> Result<Option<serde_json::Value>, String> {
    let url = format!("http://127.0.0.1:{}", port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let res = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };
    let body = res.text().await.map_err(|e| format!("Body: {}", e))?;
    Ok(serde_json::from_str(&body).ok())
}

/// Snapshot of session-scope numbers from a GPU miner's HTTP API. Same
/// shape as `XmrigSnapshot` so the JS-side hook can treat both miners
/// uniformly.
///
/// `ping_ms` (2026-09-15): SRBMiner DOES report its pool latency
/// (`algorithms[0].pool.latency`, captured live), so SRBMiner sessions fill
/// it; lolMiner exposes none and leaves it `None`, where the JS layer falls
/// back to the pre-mine TCP-probe latency.
#[derive(Serialize, Default)]
pub struct GpuMinerSnapshot {
    pub hashrate: Option<f64>,
    pub accepted: u64,
    pub rejected: u64,
    pub diff_current: Option<u64>,
    pub uptime_secs: u64,
    pub ping_ms: Option<u64>,
}

/// Snapshot fetch for SRBMiner-MULTI / lolMiner. Uses the same single-
/// HTTP-call pattern as `get_xmrig_snapshot`. SRBMiner exposes a
/// flatter `algorithms[0]` shape; lolMiner uses `Session.*` fields.
/// Pool diff lives at different paths per miner — handled inline.
#[tauri::command]
pub async fn get_gpu_miner_snapshot(miner: String) -> Result<Option<GpuMinerSnapshot>, String> {
    let port = GPU_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let v = match fetch_miner_api_json(port).await? {
        Some(v) => v,
        None => return Ok(None),
    };

    if miner == "lolMiner" {
        let algo = &v["Algorithms"][0];
        let perf = algo["Total_Performance"].as_f64().unwrap_or(0.0);
        let factor = algo["Performance_Factor"].as_f64().unwrap_or(1.0);
        let h = perf * factor;
        // lolMiner exposes share counters in `Session` per the docs;
        // top-level diff in `Algorithms[0].Pool_Difficulty` (when
        // present); uptime as `Session.Uptime` in seconds.
        //
        // 2026-05-24 — a 13-minute CFX GPU session had the pool
        // accepting shares while every `get_gpu_miner_snapshot` poll
        // returned `accepted: 0` (hashrate was correct). Suggests
        // lolMiner exposes the accepted counter at a different JSON
        // path than `Session.Accepted` in this build.
        //
        // Defensive parsing: try the canonical path first, then a set
        // of known alternates (`Algorithms[0].Accepted`,
        // `Algorithms[0].Total_Accepts`, `Algorithms[0].Solutions`).
        // First non-zero wins. Rejected count tracks the source field
        // (don't mix accepted from one path with submitted from
        // another — gives nonsense rejected counts).
        let session = &v["Session"];
        let (accepted, submitted, accepted_source) = {
            // Take the FIRST path that returns a non-zero count.
            // If all paths return zero (legitimate state — no shares
            // accepted yet), use Session.Accepted's value (0) and tag
            // the source for the diagnostic log.
            if let Some(a) = session["Accepted"].as_u64().filter(|n| *n > 0) {
                let sub = session["Submitted"].as_u64().unwrap_or(a);
                (a, sub, "Session.Accepted")
            } else if let Some(a) = algo["Accepted"].as_u64().filter(|n| *n > 0) {
                let sub = algo["Submitted"].as_u64().unwrap_or(a);
                (a, sub, "Algorithms[0].Accepted")
            } else if let Some(a) = algo["Total_Accepts"].as_u64().filter(|n| *n > 0) {
                let sub = algo["Total_Submits"].as_u64().unwrap_or(a);
                (a, sub, "Algorithms[0].Total_Accepts")
            } else if let Some(a) = algo["Solutions"].as_u64().filter(|n| *n > 0) {
                (a, a, "Algorithms[0].Solutions")
            } else {
                // All zero — return Session.Accepted (probably 0) so
                // the value is still semantically "session-scoped" not
                // "cumulative across restarts." Tag the source as
                // unknown so the DEV log surfaces it for the next
                // session's investigation.
                let s_acc = session["Accepted"].as_u64().unwrap_or(0);
                let s_sub = session["Submitted"].as_u64().unwrap_or(s_acc);
                (s_acc, s_sub, "all_zero_or_missing")
            }
        };
        let rejected = submitted.saturating_sub(accepted);
        let diff_current = algo["Pool_Difficulty"].as_u64();
        let uptime_secs = session["Uptime"]
            .as_u64()
            .or_else(|| algo["Uptime"].as_u64())
            .unwrap_or(0);

        // DEV-only diagnostic so next session reveals which field
        // lolMiner actually populates. Dead-stripped in release builds
        // by LLVM after the `cfg!(debug_assertions)` constant fold.
        if cfg!(debug_assertions) {
            let session_keys: Vec<String> = v["Session"]
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let algo_keys: Vec<String> = algo
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            eprintln!(
                "[gpu-snapshot] lolMiner accepted={} (source={}) rejected={} hashrate={:.0} session_keys={:?} algo_keys={:?}",
                accepted, accepted_source, rejected, h, session_keys, algo_keys
            );
        }

        return Ok(Some(GpuMinerSnapshot {
            hashrate: if h > 0.0 { Some(h) } else { None },
            accepted,
            rejected,
            diff_current,
            // lolMiner's API exposes no stratum latency, so the frontend
            // falls back to its own TCP probe of the active pool.
            ping_ms: None,
            uptime_secs,
        }));
    }

    // Default branch — SRBMiner-MULTI. Shares ONE parser with the CPU lane
    // and `get_gpu_miner_hashrate` (`parse_srbminer_api`), which is what
    // fixed the paths this branch used to read: `algorithms[0].difficulty`
    // and `algorithms[0].uptime`/`mining_started` do not exist in SRBMiner
    // 3.6.2's document — the real ones are `pool.difficulty` (a FLOAT, so
    // `as_u64()` returned None) and `pool.uptime`. POOL DIFF therefore
    // rendered "—" for every SRBMiner session, and uptime stayed 0, which
    // also kept shares/min (gated on uptime ≥ 30 s) permanently null.
    let s = parse_srbminer_api(&v, SrbLane::Gpu);
    Ok(Some(GpuMinerSnapshot {
        hashrate: s.hashrate,
        accepted: s.accepted,
        rejected: s.rejected,
        diff_current: s.diff_current,
        ping_ms: s.ping_ms,
        uptime_secs: s.uptime_secs,
    }))
}

/// Get current hashrate from xmrig HTTP API (when miner is running with --http-port=3333).
/// Returns hashrate in H/s or None if API unreachable.
#[tauri::command]
pub async fn get_xmrig_hashrate() -> Result<Option<f64>, String> {
    let port = XMRIG_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let url = format!("http://127.0.0.1:{}/1/summary", port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let res = client.get(&url).send().await;
    let res = match res {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };
    let summary: XmrigSummary = res.json().await.map_err(|e| format!("Parse summary: {}", e))?;
    let total = summary.hashrate.and_then(|h| h.total);
    // xmrig's [10s, 60s, 15m] array can contain nulls early in mining.
    // Prefer the 10s reading; fall back to the first non-null we find
    // so the chart still gets a value during the first few seconds.
    Ok(total.and_then(|v| {
        let nums: Vec<f64> = v.into_iter().flatten().filter(|n| *n > 0.0).collect();
        if nums.is_empty() {
            None
        } else {
            // Use the first non-null reading (xmrig orders short→long
            // window, so this is the freshest signal).
            Some(nums[0])
        }
    }))
}

/// Probe for a running local Tor SOCKS5 and return its port. Tries 9050
/// (standalone `tor` / Tor Expert Bundle) first, then 9150 (Tor Browser),
/// returning the first that accepts a TCP connection within a short timeout,
/// or `None` if neither is up. The "Maximum privacy (Tor)" preflight calls
/// this so a missing Tor surfaces as a clear message in the wallet instead
/// of the miner's cryptic "connection refused" (2026-06-30 report). See
/// log.md + [[tor-mining-transport-plan]].
#[tauri::command]
pub async fn probe_tor_socks() -> Result<Option<u16>, String> {
    let found = tokio::task::spawn_blocking(|| {
        use std::net::{SocketAddr, TcpStream};
        use std::time::Duration;
        // 9050 = standalone tor; 9150 = Tor Browser. A SOCKS5 listener
        // accepts the TCP connect immediately, so 400 ms/loopback is ample.
        for port in [9050u16, 9150u16] {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
                return Some(port);
            }
        }
        None
    })
    .await
    .map_err(|e| format!("tor probe join error: {}", e))?;
    Ok(found)
}

/// Full session snapshot from xmrig — share counters, pool diff, ping,
/// uptime, and hashrate in one HTTP call. Returns None if the API isn't
/// reachable (miner not running / port blocked / wrong port). The hook
/// treats absence as "stay on the last known snapshot" rather than
/// flushing fields to dashes between ticks.
#[tauri::command]
pub async fn get_xmrig_snapshot() -> Result<Option<XmrigSnapshot>, String> {
    let port = XMRIG_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let url = format!("http://127.0.0.1:{}/1/summary", port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let res = client.get(&url).send().await;
    let res = match res {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };
    let summary: XmrigSummary = res
        .json()
        .await
        .map_err(|e| format!("Parse summary: {}", e))?;

    // Real resolved thread count — extracted via a borrow BEFORE the
    // hashrate extraction below moves `summary.hashrate` out.
    let threads_active = summary
        .hashrate
        .as_ref()
        .and_then(|h| h.threads.as_ref())
        .map(|v| v.len());

    // Hashrate — same logic as get_xmrig_hashrate (freshest non-null).
    let hashrate = summary.hashrate.and_then(|h| h.total).and_then(|v| {
        let nums: Vec<f64> = v.into_iter().flatten().filter(|n| *n > 0.0).collect();
        if nums.is_empty() {
            None
        } else {
            Some(nums[0])
        }
    });

    let results = summary.results.unwrap_or_default();
    let connection = summary.connection.unwrap_or_default();
    let accepted = results.shares_good.unwrap_or(0);
    let total = results.shares_total.unwrap_or(accepted);
    // xmrig increments shares_total on every submission and shares_good
    // on accepts only; the difference is rejects (incl. duplicates,
    // stale, low-diff). Saturating sub keeps us at 0 if a build ever
    // returns total < good.
    let rejected = total.saturating_sub(accepted);

    Ok(Some(XmrigSnapshot {
        hashrate,
        accepted,
        rejected,
        diff_current: results.diff_current,
        ping_ms: connection.ping,
        uptime_secs: connection.uptime.unwrap_or(0),
        threads_active,
    }))
}

/* ─────────────────────────────────────────────────────────────────────
   Benchmark commands — Phase 5 of the hardware-prediction pass.

   Each spawns the relevant miner with its native benchmark flags,
   captures stdout, parses the final hashrate, returns it. These run
   *standalone* (no pool, no wallet) so they don't interact with the
   normal mining lifecycle. Caller is responsible for ensuring no
   real mining is in flight on the same hardware (UI gates this with
   the existing `is_mining` / `is_gpu_mining` checks).

   Cancellation: each takes a `duration_secs` cap and the CLI flag
   makes the miner exit cleanly after that window. We add ~5 s of
   headroom on top of the user's request before timing out the
   spawned process from Rust as a watchdog.
   ───────────────────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct BenchmarkResult {
    /// Average hashrate in H/s recorded over the bench window.
    pub hashrate: f64,
    /// Algorithm string the bench was run against (echoed back so the
    /// JS layer can key cache entries by `(device, algo)`).
    pub algorithm: String,
    /// Raw final-line snippet from the miner's stdout — useful when a
    /// regression breaks parsing and we want to debug from the field.
    pub raw_summary: String,
}

/// Run xmrig as a CPU calibration probe. Uses `--bench=N` in its
/// hash-count form, which is the only xmrig mode that's truly offline:
///
/// - `--bench=Ns` (seconds form) is only valid alongside `--submit`,
///   which uploads to xmrig.com's benchmark service and requires a
///   token. Without `--submit`, xmrig falls through to the regular
///   pool-loading path and exits with `no valid configuration found`.
/// - `--stress` is NOT a self-contained mode either — it still
///   requires a pool, and falls back to xmrig.com's default stratum
///   endpoint (`stratum+ssl://randomx.xmrig.com:443`) when no pool is
///   configured. That fails in airgapped environments and produces
///   `JSON decode failed / read error: end of file` in the captured
///   output (no hashrate ever measured).
/// - `--bench=N` (raw hash count, no suffix or with `K`/`M`) is fully
///   offline — xmrig generates a fixed seed locally, mines the
///   requested number of hashes against it, prints a final summary
///   line, and exits. No pool, no internet, no config file.
///
/// `target_hashes` is the count to mine. The frontend computes it from
/// the device's predicted hashrate × the desired window, so runtime is
/// roughly constant (~30 s) across hardware tiers. We default to 1M
/// when the caller passes `None` (≈30 s on a ~33 KH/s box, longer on
/// slower hardware), and floor/cap to keep extremes bounded.
///
/// xmrig prints a final summary like:
///   `[..] bench    finish: 1000000, 28341 ms, 35283.4 H/s`
/// The `best_hashrate_line` regex catches the rate.
#[tauri::command]
pub async fn run_xmrig_benchmark(
    app: AppHandle,
    algorithm: String,
    duration_secs: u32,
    target_hashes: Option<u64>,
) -> Result<BenchmarkResult, String> {
    use std::process::Stdio;

    let _ = duration_secs; // accepted for API compat with earlier versions

    let miners_dir = get_miners_dir(&app)?;
    let xmrig_name = format!("xmrig{}", crate::platform::EXE_SUFFIX);
    let exe_path = miners_dir.join(&xmrig_name);
    if !exe_path.exists() {
        return Err(format!(
            "{} is not installed — run Miner Setup first",
            xmrig_name
        ));
    }

    // xmrig 6.25 `--help` says: "N can be between 1M and 10M". The raw
    // integer form (`--bench=1000000`) is silently rejected — xmrig
    // doesn't enter bench mode and falls through to its normal startup
    // path, which then errors out with `no valid configuration found,
    // try https://xmrig.com/wizard`. Only the suffixed form `1M`–`10M`
    // is accepted. Round target_hashes to the nearest valid million
    // and clamp; default 1M when no hint provided.
    let millions = target_hashes
        .map(|h| ((h + 500_000) / 1_000_000).clamp(1, 10))
        .unwrap_or(1);
    let bench_arg = format!("--bench={}M", millions);
    let algo_arg = format!("--algo={}", algorithm);

    #[cfg(target_os = "windows")]
    let mut cmd = hidden_command(exe_path.to_string_lossy().as_ref());
    #[cfg(not(target_os = "windows"))]
    let mut cmd = tokio::process::Command::new(&exe_path);

    cmd.args([&bench_arg, &algo_arg, "--no-color", "--print-time=1"]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.current_dir(&miners_dir);
    cmd.kill_on_drop(true);

    // Fixed bench window — we don't wait for `--bench=1M` to finish
    // mining all hashes (that takes ~230 s on un-tuned 13900K, ~4 min
    // on a 4 KH/s laptop). xmrig prints `speed 10s/60s/15m` samples
    // every second under `--print-time=1`; after dataset init (~5–15
    // s on RandomX) the 10s window stabilises within ~10 more seconds.
    // 60 s gives 4–5 clean steady-state samples on every CPU we
    // support; we keep 90 s as a safety margin for slow SSDs / cold
    // dataset allocation. Fast hardware (Threadripper) finishes
    // naturally in ~17 s and exits before the window — `tokio::select!`
    // takes the earlier of the two events.
    const BENCH_WINDOW_SECS: u64 = 90;
    // Hard ceiling — used only if the natural-exit branch keeps spinning
    // (shouldn't happen with the bounded sleep, but guards against pipe
    // EOF stalls on Windows).
    let hard_cap_secs = (millions * 600 + 60).min(900);

    let mut child = cmd.spawn().map_err(|e| format!("Spawn xmrig: {}", e))?;
    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture xmrig stdout".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture xmrig stderr".to_string())?;

    use tokio::io::AsyncReadExt;
    let stdout_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf).await;
        buf
    });
    let stderr_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf).await;
        buf
    });

    // Race the bench-window timer against the natural exit. Whichever
    // fires first wins; the loser gets cancelled by `select!`'s
    // structured drop semantics.
    let mut natural_exit = false;
    tokio::select! {
        biased;
        _ = tokio::time::sleep(std::time::Duration::from_secs(BENCH_WINDOW_SECS)) => {
            // Window expired — xmrig is still benching. Kill it and
            // parse whatever speed samples we collected; on every CPU
            // we support, 90 s is more than enough for steady-state.
        }
        res = child.wait() => {
            // Fast hardware finished the full 1M before our window —
            // we'll get the `bench finish: ...` summary line in stdout.
            let _ = res;
            natural_exit = true;
        }
    }

    if !natural_exit {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            child.wait(),
        )
        .await;
    }

    // Last-resort cap so the readers can't keep this command pinned
    // forever if a pipe doesn't EOF after kill on Windows.
    let stdout_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(hard_cap_secs.saturating_sub(BENCH_WINDOW_SECS).max(10)),
        stdout_handle,
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or_default();
    let stderr_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stderr_handle,
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or_default();
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout_bytes),
        String::from_utf8_lossy(&stderr_bytes),
    );

    // Strict parse: pick the maximum `speed 10s` sample across the
    // captured window. Cold-start samples are real but
    // unrepresentative; the max naturally selects post-warmup
    // steady-state. Falls back to the liberal `<num>[KMG]?H/s` scan
    // if no strict speed line was captured (e.g. xmrig was killed
    // before printing any 10s sample on a very slow box, or the
    // summary-line format drifted in a future version).
    let strict_max = combined
        .lines()
        .filter(|l| l.contains("speed") && l.contains("10s/60s/15m"))
        .filter_map(|l| parse_xmrig_speed_line(l).map(|v| (v, l.to_string())))
        .fold(None::<(f64, String)>, |best, (v, line)| match best {
            Some((bv, bl)) if bv >= v => Some((bv, bl)),
            _ => Some((v, line)),
        });

    if let Some((hashrate, raw_summary)) = strict_max {
        return Ok(BenchmarkResult {
            hashrate,
            algorithm,
            raw_summary,
        });
    }

    if let Some((hashrate, raw_summary)) = best_hashrate_line(&combined) {
        return Ok(BenchmarkResult {
            hashrate,
            algorithm,
            raw_summary,
        });
    }

    Err(format!(
        "Could not parse xmrig benchmark output (window {}s, natural_exit={}). Tail: {}",
        BENCH_WINDOW_SECS,
        natural_exit,
        tail_lines(&combined, 5)
    ))
}

/// xmrig prints speed lines like:
///   `[2025-04-30 ...] miner    speed 10s/60s/15m 1136.6 1125.2 n/a H/s max 1148.0 H/s`
/// or under `--print-time=1`:
///   `[...] speed 10s/60s/15m 1136.6 1125.2 n/a`
/// We grab the first numeric token after `10s/60s/15m`.
fn parse_xmrig_speed_line(line: &str) -> Option<f64> {
    let idx = line.find("10s/60s/15m")?;
    let tail = &line[idx + "10s/60s/15m".len()..];
    for tok in tail.split_whitespace() {
        if let Ok(v) = tok.parse::<f64>() {
            if v > 0.0 {
                return Some(v);
            }
        }
        // Skip `n/a` and other non-numeric tokens; bail when we hit
        // `H/s` because we've passed all three windows.
        if tok.starts_with("H/s") || tok.starts_with("KH/s") || tok.starts_with("MH/s") {
            break;
        }
    }
    None
}

/// Liberal `<num>[.<num>]? [KkMmGg]?H/s` extractor — matches both
/// spaced (`25.5 Mh/s`) and unspaced (`25.5Mh/s`) forms, and accepts
/// commas as thousands separators. Returns each value normalised to
/// plain H/s. Used as the bench-output fallback when the per-miner
/// strict format doesn't apply.
fn extract_hashrate_candidates(text: &str) -> Vec<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)(\d+(?:[.,]\d+)?)\s*([kmg]?)\s*h/s")
            .expect("static regex compiles")
    });
    let mut out = Vec::new();
    for cap in re.captures_iter(text) {
        let num_str = match cap.get(1) {
            Some(m) => m.as_str().replace(',', ""),
            None => continue,
        };
        let v: f64 = match num_str.parse() {
            Ok(n) if n > 0.0 => n,
            _ => continue,
        };
        let mult = match cap
            .get(2)
            .map(|m| m.as_str().to_ascii_lowercase())
            .as_deref()
        {
            Some("k") => 1_000.0,
            Some("m") => 1_000_000.0,
            Some("g") => 1_000_000_000.0,
            _ => 1.0,
        };
        out.push(v * mult);
    }
    out
}

/// Walk every line, return the line + the largest single `<num> [KMG]?H/s`
/// value anywhere on it. Picking the max is intentional: across
/// per-GPU + total + max-of-window prints, the aggregate (which is
/// what we want to display) is reliably the largest number.
fn best_hashrate_line(text: &str) -> Option<(f64, String)> {
    let mut best: Option<(f64, String)> = None;
    for line in text.lines() {
        for v in extract_hashrate_candidates(line) {
            match best {
                Some((bv, _)) if bv >= v => {}
                _ => best = Some((v, line.to_string())),
            }
        }
    }
    best
}

/// Last `n` non-empty lines joined with ` | ` for inclusion in error
/// messages. Bench parsers fail rarely, but when they do we want a
/// breadcrumb that survives the toast/UI truncation in the field.
fn tail_lines(text: &str, n: usize) -> String {
    let mut tail: Vec<&str> = text
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(n)
        .collect();
    tail.reverse();
    tail.join(" | ")
}

/// Run a GPU calibration probe. Supports the two algorithm classes
/// PwndaWallet mines on GPU: KawPoW (RVN, SRBMiner) and Octopus (CFX,
/// lolMiner).
///
/// `gpu_index` targets a single GPU when set — without it both miners
/// enumerate every visible card, which would attribute the combined
/// rate to whichever device the user clicked Calibrate on.
///
/// **Octopus / lolMiner** runs fully offline via lolMiner's real
/// `--benchmark <ALGO>` flag — generates a synthetic DAG, mines for
/// ~30 s against a built-in seed, prints final rates, exits.
///
/// **KawPoW / SRBMiner** is harder. SRBMiner-MULTI 3.x has **no
/// offline benchmark mode** — `--benchmark` is not a real flag (it was
/// silently ignored, which is what was causing earlier calibration runs
/// to hang in connect-retry loops). We instead point SRBMiner at a
/// public KawPoW pool, mine briefly with the Ravencoin protocol's
/// asset-issuance burn address (`RXissueAssetXXXXXXXXXXXXXXXXXhhZGt`,
/// a real 34-char Base58 address with a valid checksum that no one
/// holds the keys to), kill the miner after a window, and read the
/// per-GPU MH/s lines from accumulated stdout.
///
/// Network requirement is unavoidable for KawPoW: SRBMiner needs a
/// real stratum job to mine against — no "offline test workload" exists.
/// Octopus calibration stays offline.
#[tauri::command]
pub async fn run_gpu_miner_benchmark(
    app: AppHandle,
    miner: String,
    algorithm: String,
    duration_secs: u32,
    gpu_index: Option<u32>,
) -> Result<BenchmarkResult, String> {
    use std::process::Stdio;

    let _ = duration_secs; // accepted for API compat; window sizing is per-miner now

    let miners_dir = get_miners_dir(&app)?;
    let exe_name = if miner == "lolMiner" {
        format!("lolMiner{}", crate::platform::EXE_SUFFIX)
    } else {
        format!("SRBMiner-MULTI{}", crate::platform::EXE_SUFFIX)
    };
    let exe_path = miners_dir.join(&exe_name);
    if !exe_path.exists() {
        return Err(format!(
            "{} is not installed — run Miner Setup first",
            exe_name
        ));
    }

    // Same translation as the mining path: the app's index is not the
    // miner's device id.
    let gpu_index = match gpu_index {
        None => None,
        Some(i) => resolve_miner_gpu_ids(&exe_path, &miner, &miners_dir, Some(&[i][..]))
            .await
            .map_err(|e| format!("GPU selection: {}", e))?
            .and_then(|ids| ids.first().copied()),
    };

    #[cfg(target_os = "windows")]
    let mut cmd = hidden_command(exe_path.to_string_lossy().as_ref());
    #[cfg(not(target_os = "windows"))]
    let mut cmd = tokio::process::Command::new(&exe_path);

    if miner == "lolMiner" {
        // lolMiner offline benchmark. The flag takes the algorithm
        // *as its value*: `--benchmark OCTOPUS`, NOT `--algo OCTOPUS
        // --benchmark`. Earlier code passed both as separate flags
        // which is why benches mis-printed and never produced a usable
        // total. `--nocolor on` strips ANSI escapes so the parser
        // doesn't have to worry about coloured digits in
        // `Average speed (15s): 50.93 Mh/s ...` lines.
        let mut args = vec![
            "--benchmark".to_string(),
            algorithm.to_uppercase(),
            "--nocolor".to_string(),
            "on".to_string(),
        ];
        if let Some(idx) = gpu_index {
            args.push("--devices".to_string());
            args.push(idx.to_string());
        }
        cmd.args(&args);
    } else {
        // SRBMiner KawPoW: real public pool + Ravencoin protocol burn
        // address. Tested approach:
        //   - PwndaWallet's own pool (`ravencoin.pwnda.org:20871`)
        //     was rejecting connections regardless of wallet — bot
        //     filter or registered-miner-only.
        //   - Naïve placeholder wallets like `RXXXX...` fail Base58
        //     checksum and the pool drops them immediately.
        //   - `RXissueAssetXXXXXXXXXXXXXXXXXhhZGt` is the canonical
        //     Ravencoin asset-issuance burn address — valid Base58,
        //     valid checksum, no spendable key. Public KawPoW pools
        //     (herominers tested working) accept it; any shares we
        //     submit before kill are credited to a destroyed account.
        // herominers TCP (no TLS) keeps the connection logic simple
        // and avoids the TLS-handshake delay on a short-lived run.
        let mut args = vec![
            "--algorithm".to_string(),
            algorithm.clone(),
            "--pool".to_string(),
            "stratum+tcp://de.ravencoin.herominers.com:1140".to_string(),
            "--wallet".to_string(),
            "RXissueAssetXXXXXXXXXXXXXXXXXhhZGt".to_string(),
            "--password".to_string(),
            "rvn".to_string(),
            "--disable-cpu".to_string(),
            "--retry-time".to_string(),
            "5".to_string(),
            "--give-up-limit".to_string(),
            "3".to_string(),
        ];
        if let Some(idx) = gpu_index {
            args.push("--gpu-id".to_string());
            args.push(idx.to_string());
        }
        cmd.args(&args);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.current_dir(&miners_dir);
    // Match the xmrig fix: without `kill_on_drop`, a watchdog timeout
    // drops the future but the miner keeps running orphaned. The
    // explicit `start_kill()` below is the primary kill path.
    cmd.kill_on_drop(true);

    // AMD OpenCL env vars — required for KawPoW on AMD GPUs to allocate
    // the DAG correctly. Mirrors the live `start_gpu_miner` path; without
    // them an AMD calibration can crash mid-run or hang during DAG
    // generation. Skipped for lolMiner (NVIDIA-focused, doesn't use
    // these AMD-specific knobs).
    if miner != "lolMiner" {
        cmd.env("GPU_MAX_HEAP_SIZE", "100");
        cmd.env("GPU_MAX_USE_SYNC_OBJECTS", "1");
        cmd.env("GPU_SINGLE_ALLOC_PERCENT", "100");
        cmd.env("GPU_MAX_ALLOC_PERCENT", "100");
        cmd.env("GPU_MAX_SINGLE_ALLOC_PERCENT", "100");
        cmd.env("GPU_ENABLE_LARGE_ALLOCATION", "100");
        cmd.env("GPU_MAX_WORKGROUP_SIZE", "1024");
    }

    // Window sizing per-miner. Empirical from live testing on this box
    // (RTX 5060 Ti):
    //   - lolMiner Octopus: synthetic DAG ~5 s, built-in bench ~25 s,
    //     final summary at ~30–35 s. Window 60 s covers worst-case
    //     slow GPUs comfortably; faster cards exit naturally well
    //     before that.
    //   - SRBMiner KawPoW: DAG ~10–30 s (NVIDIA fast, AMD slower),
    //     pool handshake ~3 s, auto-tune ~25 s, first stable hashrate
    //     visible by ~70 s. 120 s window gives ~50 s of post-tune
    //     mining for a steady-state read; partial-output recovery
    //     handles cases where the bench is killed mid-run.
    // Hard cap = window + 30 s safety net for pipe-EOF stalls.
    let bench_window_secs: u64 = if miner == "lolMiner" { 60 } else { 120 };
    let hard_cap_secs: u64 = bench_window_secs + 30;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Spawn {}: {}", exe_name, e))?;
    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| format!("Failed to capture {} stdout", exe_name))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| format!("Failed to capture {} stderr", exe_name))?;

    use tokio::io::AsyncReadExt;
    let stdout_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf).await;
        buf
    });
    let stderr_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf).await;
        buf
    });

    // Race natural exit against the bench-window timer.
    let mut natural_exit = false;
    tokio::select! {
        biased;
        _ = tokio::time::sleep(std::time::Duration::from_secs(bench_window_secs)) => {
            // Window expired — kill the miner and try to recover a
            // hashrate from accumulated stdout below.
        }
        res = child.wait() => {
            let _ = res;
            natural_exit = true;
        }
    }

    if !natural_exit {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            child.wait(),
        )
        .await;
    }

    let stdout_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(hard_cap_secs.saturating_sub(bench_window_secs).max(15)),
        stdout_handle,
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or_default();
    let stderr_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        stderr_handle,
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or_default();
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout_bytes),
        String::from_utf8_lossy(&stderr_bytes),
    );

    // Both miners print the headline rate as the largest `<num> [KMG]?H/s`
    // value in their output (per-GPU lines + a total line — total wins).
    // Partial-output recovery: if the bench was killed before the
    // final summary printed, mid-run per-GPU rate lines are still
    // valid measurements.
    if let Some((hashrate, raw_summary)) = best_hashrate_line(&combined) {
        return Ok(BenchmarkResult {
            hashrate,
            algorithm,
            raw_summary,
        });
    }

    Err(format!(
        "Could not parse {} benchmark output (window {}s, natural_exit={}). Tail: {}",
        exe_name,
        bench_window_secs,
        natural_exit,
        tail_lines(&combined, 5)
    ))
}

/// Start a GPU miner: SRBMiner-MULTI (kawpow/RVN) or lolMiner (octopus/CFX).
/// These miners do not require admin elevation.
///
/// miner:      "SRBMiner-MULTI" or "lolMiner"
/// pool:       full stratum URL, e.g. "stratum+ssl://ravencoin.pwnda.org:17706"
/// user_string: "PREFIX:ADDRESS.WORKER"
/// algorithm:  e.g. "kawpow" or "OCTOPUS"
/// pass:       password sent to pool, e.g. "rvn" or "cfx"
/// chain_ticker: retained for frontend compatibility but no longer used.
///   It keyed the dev-fee wallet registry + GPU time-slice scheduler,
///   both removed 2026-07-06 (pure-wallet cutover). The GPU miner now
///   connects direct to the user's pool with the user's own wallet.
// =========================================================================
// GPU selection → the miner's OWN device ids
// =========================================================================
//
// Reported 2026-09-16: the picker showed "GPU 0 · RTX 5060 Ti", the operator
// left it there, and the session mined on the RX 6700 XT. The app's index is a
// position in `get_gpu_info` (Windows registry order: 5060 Ti = 0), and it was
// passed to the miner verbatim. The two miners number the same two cards
// differently — captured on the dev box with the pinned binaries:
//
//   SRBMiner 3.6.2 --list-devices    (OpenCL devices first, then CUDA)
//     GPU0  [0][0] [06:00.0] : amd_radeon_rx_6700_xt [gfx1031] [12272 MB] ...
//     GPU1  [CUDA][0] [0000:01:00.0] : nvidia_geforce_rtx_5060_ti [blackwell] ...
//   lolMiner 1.98a --list-devices    (CUDA first)
//     Device 0: Name: NVIDIA GeForce RTX 5060 Ti   Address: 1:0
//     Device 1: Name: Radeon RX 6700XT             Address: 6:0
//
// So `--gpu-id 0` meant the 6700 XT to SRBMiner. Selected cards are now
// matched by model and vendor against the miner's own list and translated to
// its id; a card that cannot be matched refuses to start rather than mining on
// another one.

/// One GPU as a miner enumerates it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinerGpuDevice {
    /// The id the miner's own device flag takes.
    pub id: u32,
    pub name: String,
    /// "nvidia" | "amd" | "intel" | "other", as `device_info` spells it.
    pub vendor: String,
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn vendor_from_text(text: &str) -> String {
    let l = text.to_ascii_lowercase();
    if l.contains("nvidia") || l.contains("geforce") || l.contains("cuda") {
        "nvidia".into()
    } else if l.contains("amd") || l.contains("radeon") || l.contains("advanced micro") {
        "amd".into()
    } else if l.contains("intel") {
        "intel".into()
    } else {
        "other".into()
    }
}

/// Parse `SRBMiner-MULTI --list-devices`. Lines look like
/// `GPU1  [CUDA][0] [0000:01:00.0] : nvidia_geforce_rtx_5060_ti [blackwell] ...`
/// under `OPENCL devices` / `CUDA devices` headers.
pub fn parse_srbminer_list_devices(output: &str) -> Vec<MinerGpuDevice> {
    let mut section = String::new();
    let mut out = Vec::new();
    for line in strip_ansi(output).lines() {
        let t = line.trim();
        if t.ends_with("devices") && !t.starts_with("GPU") {
            section = t.to_ascii_lowercase();
            continue;
        }
        let Some(rest) = t.strip_prefix("GPU") else { continue };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(id) = digits.parse::<u32>() else { continue };
        let Some((_, after)) = rest.split_once(" : ") else { continue };
        let name = after.split_whitespace().next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let mut vendor = vendor_from_text(&name);
        if vendor == "other" && section.contains("cuda") {
            vendor = "nvidia".into();
        }
        out.push(MinerGpuDevice { id, name, vendor });
    }
    out
}

/// Parse `lolMiner --list-devices`: `Device N:` blocks with `Name:` and
/// `Vendor:` lines.
pub fn parse_lolminer_list_devices(output: &str) -> Vec<MinerGpuDevice> {
    let mut out: Vec<MinerGpuDevice> = Vec::new();
    for line in strip_ansi(output).lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Device ") {
            if let Some(num) = rest.strip_suffix(':') {
                if let Ok(id) = num.trim().parse::<u32>() {
                    out.push(MinerGpuDevice { id, name: String::new(), vendor: "other".into() });
                }
            }
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        if let Some(v) = t.strip_prefix("Name:") {
            cur.name = v.trim().to_string();
            if cur.vendor == "other" {
                cur.vendor = vendor_from_text(&cur.name);
            }
        } else if let Some(v) = t.strip_prefix("Vendor:") {
            let from_vendor = vendor_from_text(v);
            if from_vendor != "other" {
                cur.vendor = from_vendor;
            }
        }
    }
    out.retain(|d| !d.name.is_empty());
    out
}

/// A GPU model reduced to what both miners and the OS agree on:
/// `NVIDIA GeForce RTX 5060 Ti`, `nvidia_geforce_rtx_5060_ti` → `rtx5060ti`;
/// `AMD Radeon RX 6700 XT`, `Radeon RX 6700XT` → `rx6700xt`.
pub fn gpu_model_key(name: &str) -> String {
    const NOISE: &[&str] = &[
        "nvidia", "geforce", "amd", "ati", "radeon", "intel", "corporation", "tm", "r",
        "advanced", "micro", "devices", "inc", "graphics",
    ];
    let lowered = name.to_ascii_lowercase();
    let spaced: String = lowered
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    spaced
        .split_whitespace()
        .filter(|w| !NOISE.contains(w))
        .collect::<Vec<_>>()
        .join("")
}

/// Translate app GPU indices (positions in `app_gpus`, i.e. `get_gpu_info`)
/// into the miner's own ids.
///
/// Per selected card, the first tier with any candidate wins:
/// 1. same vendor and the same [`gpu_model_key`];
/// 2. same vendor and one key containing the other (Linux names carry the
///    chip code: `AD106 [GeForce RTX 4060 Ti]`);
/// 3. same vendor, when app and miner see the same number of that vendor's
///    cards — matched by order.
///
/// Identical cards are matched in order (the k-th such card in the app list
/// takes the k-th candidate). Anything unmatched, or two selections landing on
/// one device, is an error.
pub fn map_gpu_indices_to_miner(
    app_gpus: &[crate::device_info::GpuInfo],
    selected: &[u32],
    miner_devices: &[MinerGpuDevice],
) -> Result<Vec<u32>, String> {
    let mut mapped: Vec<u32> = Vec::new();
    for &sel in selected {
        let target = app_gpus
            .get(sel as usize)
            .ok_or_else(|| format!("GPU {} is not in the detected device list", sel))?;
        let t_key = gpu_model_key(&target.name);
        let same_vendor = |d: &&MinerGpuDevice| d.vendor == target.vendor;
        // How many earlier app cards would compete for the same candidates.
        let rank_among = |pred: &dyn Fn(&crate::device_info::GpuInfo) -> bool| {
            app_gpus[..sel as usize].iter().filter(|g| pred(g)).count()
        };

        let exact: Vec<&MinerGpuDevice> = miner_devices
            .iter()
            .filter(same_vendor)
            .filter(|d| gpu_model_key(&d.name) == t_key)
            .collect();
        let pick = if !exact.is_empty() {
            let k = rank_among(&|g| g.vendor == target.vendor && gpu_model_key(&g.name) == t_key);
            exact.get(k).copied()
        } else {
            let contained: Vec<&MinerGpuDevice> = miner_devices
                .iter()
                .filter(same_vendor)
                .filter(|d| {
                    let k = gpu_model_key(&d.name);
                    !k.is_empty() && !t_key.is_empty() && (k.contains(&t_key) || t_key.contains(&k))
                })
                .collect();
            if contained.len() == 1 {
                Some(contained[0])
            } else {
                let vendor_devs: Vec<&MinerGpuDevice> = miner_devices.iter().filter(same_vendor).collect();
                let app_same = app_gpus.iter().filter(|g| g.vendor == target.vendor).count();
                if !vendor_devs.is_empty() && vendor_devs.len() == app_same {
                    let k = rank_among(&|g| g.vendor == target.vendor);
                    vendor_devs.get(k).copied()
                } else {
                    None
                }
            }
        };
        let dev = pick.ok_or_else(|| {
            format!(
                "could not find the selected GPU \"{}\" in the miner's device list ({}). \
                 Choose ALL GPUs, or check the card's driver.",
                target.name,
                miner_devices
                    .iter()
                    .map(|d| format!("{}={}", d.id, d.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
        if mapped.contains(&dev.id) {
            return Err(format!(
                "two selected GPUs resolved to the same miner device {} ({})",
                dev.id, dev.name
            ));
        }
        mapped.push(dev.id);
    }
    Ok(mapped)
}

/// Run `<miner> --list-devices` (read-only; no pool, no mining) and parse it.
async fn list_miner_gpu_devices(
    exe_path: &std::path::Path,
    miner: &str,
    cwd: &std::path::Path,
) -> Result<Vec<MinerGpuDevice>, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = hidden_command(exe_path.to_string_lossy().as_ref());
    #[cfg(not(target_os = "windows"))]
    let mut cmd = tokio::process::Command::new(exe_path);
    cmd.arg("--list-devices");
    if miner == "lolMiner" {
        cmd.args(["--nocolor", "on"]);
    }
    cmd.current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| format!("{} --list-devices did not finish in 30 s", miner))?
        .map_err(|e| format!("{} --list-devices failed to run: {}", miner, e))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let devices = if miner == "lolMiner" {
        parse_lolminer_list_devices(&text)
    } else {
        parse_srbminer_list_devices(&text)
    };
    if devices.is_empty() {
        return Err(format!("{} --list-devices reported no GPUs", miner));
    }
    Ok(devices)
}

/// The miner ids for an app GPU selection. `None`/empty passes through
/// (every GPU, no device flag). Anything else is translated, or refused.
async fn resolve_miner_gpu_ids(
    exe_path: &std::path::Path,
    miner: &str,
    cwd: &std::path::Path,
    selected: Option<&[u32]>,
) -> Result<Option<Vec<u32>>, String> {
    let Some(sel) = selected.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let app_gpus = crate::device_info::get_gpu_info()
        .await
        .map_err(|e| format!("could not read the GPU list to match your selection: {}", e))?;
    let devices = list_miner_gpu_devices(exe_path, miner, cwd).await?;
    let ids = map_gpu_indices_to_miner(&app_gpus, sel, &devices)?;
    eprintln!(
        "[gpu-select] {}: app GPU(s) {:?} -> miner id(s) {:?} ({})",
        miner,
        sel,
        ids,
        devices.iter().map(|d| format!("{}={}", d.id, d.name)).collect::<Vec<_>>().join(", ")
    );
    Ok(Some(ids))
}

#[tauri::command]
pub async fn start_gpu_miner(
    app: AppHandle,
    miner: String,
    pool: String,
    user_string: String,
    algorithm: String,
    pass: String,
    proxy: Option<String>,
    chain_ticker: Option<String>,
    // `gpu_intensity`: SRBMiner `--gpu-intensity` (None = AUTO). Frontend
    // sends the GPU intensity slider's value (1-31; the LOW/MED/MAX presets
    // are 16/22/28 — `miningTuning.ts`). Clamped in `srb_gpu_intensity_arg`.
    // Ignored for lolMiner. See [[srbminer-flags]].
    gpu_intensity: Option<u32>,
    // Which physical GPU(s) to mine on — positions into the SAME device list
    // `get_gpu_info` returns. `None`/empty = every GPU (unchanged default).
    // Translated into the miner's own ids by `resolve_miner_gpu_ids` before
    // `build_gpu_miner_args` sees them (the two numberings differ; 2026-09-16).
    gpu_indices: Option<Vec<u32>>,
    // A worker name carried as its OWN stratum field rather than appended to
    // the wallet. XELIS only — see `build_gpu_miner_args`.
    worker: Option<String>,
) -> Result<(), String> {
    // RAII "already starting" sentinel — same pattern as `start_xmrig`.
    // Prevents duplicate concurrent sessions if the user click-spams
    // Start during the build_and_spawn_gpu_miner async window.
    //
    // Bind state to a local so its lifetime spans the guard's. See
    // `start_xmrig` for the rationale.
    let starting_state = app.state::<GpuMinerStarting>();
    let _starting_guard = StartGuard::try_acquire(&starting_state.0)
        .ok_or_else(|| {
            "GPU mining is already starting. Wait for the current start to finish, or stop it first.".to_string()
        })?;

    let miners_dir = get_miners_dir(&app)?;
    let exe_name = if miner == "lolMiner" {
        format!("lolMiner{}", crate::platform::EXE_SUFFIX)
    } else {
        format!("SRBMiner-MULTI{}", crate::platform::EXE_SUFFIX)
    };
    let exe_path = miners_dir.join(&exe_name);

    if !exe_path.exists() {
        return Err(format!(
            "{} not found. Please download mining software first.",
            exe_name
        ));
    }

    // Proxy mode is only wired through SRBMiner-MULTI; lolMiner has no
    // native --proxy flag and we deliberately don't ship a TCP-relay
    // workaround in this version. Reject the combination loudly so the
    // frontend can route the user to a coin/algorithm that's supported.
    if proxy.is_some() && miner == "lolMiner" {
        return Err("PROXY_NOT_SUPPORTED_FOR_LOLMINER".to_string());
    }

    // Check if already running
    {
        let state = app.state::<GpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut child) = *process {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *process = None;
                }
                Ok(None) => {
                    return Err("GPU miner is already running. Stop it first.".to_string());
                }
                Err(_) => {
                    *process = None;
                }
            }
        }
    }

    // Direct pool connection. The dev-fee stratum proxy, GPU timeslice
    // scheduler, and per-session JSONL logger were all removed 2026-07-06
    // (pure-wallet cutover). The GPU miner now connects straight to the
    // user's chosen pool with the user's own wallet — indistinguishable
    // from a vanilla lolMiner/SRBMiner launch. `chain_ticker` is retained
    // in the command signature for frontend compatibility but no longer
    // keys any registry.
    let _ = &chain_ticker;

    let show_miner_window = read_show_miner_window(&app);

    // The app's GPU indices are positions in `get_gpu_info`; each miner
    // numbers devices its own way. Translate before anything is spawned.
    let gpu_indices = resolve_miner_gpu_ids(&exe_path, &miner, &miners_dir, gpu_indices.as_deref())
        .await
        .map_err(|e| format!("GPU selection: {}", e))?;

    // Spawn the miner pointed straight at the user's pool with the
    // user's wallet. No proxy wrap, no time-slice scheduler — the miner
    // owns the pool connection for the whole session.
    build_and_spawn_gpu_miner(
        &app,
        &miner,
        &pool,
        &user_string,
        &algorithm,
        &pass,
        worker.as_deref(),
        proxy.as_deref(),
        show_miner_window,
        gpu_intensity,
        gpu_indices.as_deref(),
    )
    .await?;

    Ok(())
}

/// Build the per-miner argv vector for SRBMiner-MULTI or lolMiner. Pure
/// function — no spawn, no state. Used both by the initial start path
/// and by the time-slice scheduler when it restarts the miner with a
/// different wallet.
/// `gpu_intensity` — SRBMiner `--gpu-intensity` value, clamped to 1-31 by
/// [`srb_gpu_intensity_arg`]. `None` means "let SRBMiner pick (AUTO)". Ignored for lolMiner — it has
/// no equivalent flag, so the param is silently dropped on that branch.
/// See [[srbminer-flags]] for the full intensity-tuning reference.
///
/// `gpu_indices` — which physical GPU(s) to mine on. `None` or an empty list
/// means "every GPU the miner can see", which is today's behaviour and the
/// correct default for the overwhelming majority of installs (one GPU).
/// `Some(&[0])` / `Some(&[1])` restricts to a single card; `Some(&[0, 1])`
/// mines both from ONE process — SRBMiner-MULTI and lolMiner both split a
/// single process's work across a comma-separated device list, so a second
/// miner process (and the multi-process plumbing that would need) is never
/// required, even for "both".
///
/// Indices here are the MINER's own device ids. Callers translate the app's
/// `get_gpu_info` positions first with [`resolve_miner_gpu_ids`]. Until
/// 2026-09-16 the app's positions were passed through unchanged, on the
/// assumption that the orderings agreed. They do not: SRBMiner lists OpenCL
/// (AMD) before CUDA (NVIDIA) and lolMiner the reverse, so on the dev box
/// app GPU 0 (RTX 5060 Ti) became SRBMiner's RX 6700 XT.
///
/// `worker` — a SEPARATE worker name, for pools whose protocol carries it as
/// its own stratum field instead of appending it to the wallet. XELIS is the
/// only one today: its `mining.authorize` takes `[wallet, worker, pass]`, which
/// SRBMiner fills from `--worker` (captured from a live session 2026-09-15).
/// `None` for every other algorithm, which keeps taking `address.worker` in
/// `user_string` exactly as before.
///
/// `api_port` — the miner's HTTP API port, resolved by the CALLER rather than
/// hardcoded to [`GPU_HTTP_PORT`]. Windows reserves whole TCP ranges for
/// Hyper-V/WSL2, and one of them (21515–21614) contains 21558: binding inside
/// it fails with WSAEACCES although nothing is listening, so SRBMiner logged
/// "API daemon failed to start" and every hashrate poll silently returned
/// nothing while the miner hashed normally. See `pick_loopback_api_port`.
/// SRBMiner-MULTI 3.6.2 `--help`: `--gpu-intensity value (gpu intensity,
/// 0-31 or if > 31 it's treated as raw intensity, separate values with ',')`.
///
/// The UI only offers 1-31. Anything above 31 is clamped DOWN rather than
/// forwarded, because SRBMiner would read it as a raw intensity (a different
/// unit entirely) — a caller bug must not silently become a raw value. 0 is
/// clamped up to 1: the help text lists it as valid but never says what it
/// means, and "no flag" is already how AUTO is expressed.
pub(crate) const SRB_GPU_INTENSITY_MIN: u32 = 1;
pub(crate) const SRB_GPU_INTENSITY_MAX: u32 = 31;

/// The `--gpu-intensity` argument value: clamped to
/// [`SRB_GPU_INTENSITY_MIN`]..=[`SRB_GPU_INTENSITY_MAX`], and repeated once
/// per card when the caller named 2+ cards with `--gpu-id` (the flag takes a
/// per-device list; with an explicit list we never rely on SRBMiner's
/// undocumented handling of a single value for several cards). With no
/// explicit device list (every GPU) the single value is sent as before.
pub(crate) fn srb_gpu_intensity_arg(intensity: u32, explicit_devices: usize) -> String {
    let v = intensity
        .clamp(SRB_GPU_INTENSITY_MIN, SRB_GPU_INTENSITY_MAX)
        .to_string();
    if explicit_devices > 1 {
        vec![v; explicit_devices].join(",")
    } else {
        v
    }
}

#[allow(clippy::too_many_arguments)]
fn build_gpu_miner_args(
    miner: &str,
    pool: &str,
    user_string: &str,
    algorithm: &str,
    pass: &str,
    worker: Option<&str>,
    socks5_proxy: Option<&str>,
    gpu_intensity: Option<u32>,
    gpu_indices: Option<&[u32]>,
    api_port: u16,
    log_path: Option<&std::path::Path>,
) -> Vec<String> {
    // Shared by both branches below: empty and absent are the same "every
    // GPU" request, so callers (and tests) don't have to care which one a
    // given code path happens to produce.
    let device_csv: Option<String> = gpu_indices.filter(|ids| !ids.is_empty()).map(|ids| {
        ids.iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    });
    if miner == "lolMiner" {
        // lolMiner.exe --algo OCTOPUS --pool <pool> --user <user> --pass <pass>
        //              --apiport <port> --apihost 127.0.0.1
        // The API serves JSON at http://127.0.0.1:<port>/ (root). Default
        // apihost is 0.0.0.0 (everyone) — we explicitly bind to localhost.
        let mut args = vec![
            "--algo".to_string(),
            algorithm.to_string(),
            "--pool".to_string(),
            pool.to_string(),
            "--user".to_string(),
            user_string.to_string(),
            "--pass".to_string(),
            pass.to_string(),
            "--apiport".to_string(),
            api_port.to_string(),
            "--apihost".to_string(),
            "127.0.0.1".to_string(),
            // Fast reconnect on pool-disconnect. lolMiner defaults are
            // conservative; shorturl-retries high + retrydelay low gives
            // ~1s reconnect so a brief pool blip doesn't stop the session.
            "--shorturl-retries".to_string(),
            "100".to_string(),
            "--retrydelay".to_string(),
            "1".to_string(),
        ];
        // `--devices 0,1` — verified against lolMiner's own docs (comma-
        // separated indices, or ALL/AMD/NVIDIA — we always send indices).
        // Omitted entirely when unset, which is lolMiner's own "every GPU"
        // default — unchanged behaviour for every install that never touches
        // the picker.
        if let Some(csv) = &device_csv {
            args.push("--devices".to_string());
            args.push(csv.clone());
        }
        // 2026-05-18 — lolMiner's own log file. Captures the same
        // text seen in the console window (DAG load, "Subscribed to
        // stratum server", "Authorized worker", per-share output).
        // Only appended when `miner_logging_active()` → no overhead in release.
        if let Some(p) = log_path {
            args.push("--logfile".to_string());
            args.push(p.to_string_lossy().to_string());
        }
        args
    } else {
        // SRBMiner-MULTI.exe
        //   --disable-cpu          : GPU-only, no CPU threads
        //   --algorithm kawpow     : algorithm
        //   --pool stratum+…://    : pool URL
        //   --wallet ADDR.WORKER   : payout address / worker
        //   --password x           : pool password (SRBMiner uses --password, not --pass)
        //   --send-stales true     : submit stale shares (prevents dropped shares on some pools)
        //   --tls true             : TLS (only added for stratum+ssl pools)
        let is_ssl = pool.contains("ssl://");

        let mut srb_args = vec![
            "--disable-cpu".to_string(),
            "--algorithm".to_string(),
            algorithm.to_string(),
            "--pool".to_string(),
            pool.to_string(),
            "--wallet".to_string(),
            user_string.to_string(),
            "--password".to_string(),
            pass.to_string(),
            "--send-stales".to_string(),
            "true".to_string(),
            // Statistics API for hashrate polling. Binds to 127.0.0.1 by default.
            "--api-enable".to_string(),
            "--api-port".to_string(),
            api_port.to_string(),
            // Fast reconnect on pool-disconnect. SRBMiner-MULTI defaults
            // to ~5s retry-time; retry-time=1 + a high give-up-limit
            // reconnect within ~1s and tolerate transient pool
            // unavailability without killing the session.
            "--retry-time".to_string(),
            "1".to_string(),
            "--give-up-limit".to_string(),
            "100".to_string(),
        ];

        if is_ssl {
            // `--tls true` is SRBMiner's documented TLS flag, and the one the
            // CPU lane (`build_srbminer_cpu_args`) already sends. SRBMiner
            // also infers TLS from the `ssl://` scheme, so this states it
            // rather than enabling it.
            //
            // Until 2026-09-16 this sent `--tls-sni <host>`, which does
            // nothing. It is not in the `--help` of 3.1.1 or 3.6.2, and a
            // local TLS listener saw no SNI from 3.6.2 (Windows and Linux)
            // with it, without it, or with `--tls true` added. SRBMiner sends
            // no SNI at all, so no pool here can depend on one.
            srb_args.push("--tls".to_string());
            srb_args.push("true".to_string());
        }

        // `--worker <name>` — only for a protocol that authorizes the worker
        // as its own field (XELIS). Every other pool here gets the worker
        // appended to the wallet in `user_string`, so this stays absent and
        // their argv is byte-identical to before.
        if let Some(w) = worker.map(str::trim).filter(|w| !w.is_empty()) {
            srb_args.push("--worker".to_string());
            srb_args.push(w.to_string());
        }

        // SRBMiner accepts a SOCKS5 proxy via `--proxy host:port` (no
        // scheme prefix). Silently skip if the value is malformed — the
        // frontend validates before invoking, but we don't want to throw
        // at this layer.
        if let Some(p) = socks5_proxy {
            if let Some(host_port) = normalize_socks_proxy(p) {
                srb_args.push("--proxy".to_string());
                srb_args.push(host_port);
            }
        }

        // `--gpu-intensity N` — when None we omit the flag and let
        // SRBMiner pick AUTO (its built-in self-tuning default). The value
        // comes from the frontend's intensity slider (1-31) and is clamped
        // here by `srb_gpu_intensity_arg`, which also repeats it once per
        // explicitly selected card (SRBMiner 3.6.2 `--help`: "separate
        // values with ','"). See wiki/concepts/srbminer-flags.md.
        if let Some(intensity) = gpu_intensity {
            let explicit_devices = gpu_indices.map(|ids| ids.len()).unwrap_or(0);
            srb_args.push("--gpu-intensity".to_string());
            srb_args.push(srb_gpu_intensity_arg(intensity, explicit_devices));
        }

        // `--gpu-id 0,1` — indices "from --list-devices" per SRBMiner's own
        // Parameters file (see [[srbminer-flags]]). Same omit-when-unset rule
        // as lolMiner above: SRBMiner's own default is "every GPU it finds".
        if let Some(csv) = &device_csv {
            srb_args.push("--gpu-id".to_string());
            srb_args.push(csv.clone());
        }

        // 2026-05-18 — SRBMiner's own log file. Captures auto-tune
        // progress, "Pool not responding", "Authorized to mine on",
        // per-share submit logging. Same purpose as lolMiner's
        // --logfile and xmrig's --log-file (different flag spellings).
        if let Some(p) = log_path {
            srb_args.push("--log-file".to_string());
            srb_args.push(p.to_string_lossy().to_string());
        }

        srb_args
    }
}

#[cfg(test)]
mod gpu_device_selection_tests {
    use super::{build_gpu_miner_args, GPU_HTTP_PORT};

    // No existing test covered `build_gpu_miner_args` at all before this
    // module — the only exercise it got was the real caller. Reported
    // request: let a 2-GPU user pick GPU 1, GPU 2, or both, via the SAME
    // `--gpu-id`/`--devices` flags already verified (and already used, for a
    // one-shot benchmark probe) elsewhere in this file. These pin the
    // contract for the LIVE mining path specifically: omitted/empty must be
    // byte-for-byte what shipped before this feature existed, and a
    // multi-index selection must produce ONE process argument, not multiple
    // flags or multiple processes — SRBMiner-MULTI/lolMiner both split one
    // process's work across a comma list, so "both GPUs" never needs the
    // multi-process plumbing `GpuMinerProcess`'s single `Mutex` slot lacks.

    fn args(miner: &str, gpu_indices: Option<&[u32]>) -> Vec<String> {
        build_gpu_miner_args(
            miner,
            "stratum+tcp://pool.example:1234",
            "wallet.worker",
            "kawpow",
            "x",
            None,
            None,
            None,
            gpu_indices,
            GPU_HTTP_PORT,
            None,
        )
    }

    /// The XELIS shape: a bare wallet plus a separate `--worker`, and an API
    /// port the caller resolved rather than the hardcoded default.
    fn xelis_args(worker: Option<&str>, api_port: u16) -> Vec<String> {
        build_gpu_miner_args(
            "SRBMiner-MULTI",
            "stratum+tcp://de.xelis.herominers.com:1225",
            "xel:addr",
            "xelishashv3",
            "x",
            worker,
            None,
            None,
            None,
            api_port,
            None,
        )
    }

    #[test]
    fn a_separate_worker_is_passed_as_its_own_flag_only_when_present() {
        let a = xelis_args(Some("pwnda-gpu"), GPU_HTTP_PORT);
        assert!(a.windows(2).any(|w| w[0] == "--worker" && w[1] == "pwnda-gpu"));
        // The wallet stays bare — appending `.worker` here as well would send
        // the worker twice, in two different places.
        assert!(a.windows(2).any(|w| w[0] == "--wallet" && w[1] == "xel:addr"));
        for empty in [Some("  "), Some(""), None] {
            assert!(
                !xelis_args(empty, GPU_HTTP_PORT).iter().any(|s| s == "--worker"),
                "{empty:?} must not produce a --worker flag"
            );
        }
        // And the algorithms that carry the worker in the wallet keep no flag.
        assert!(!args("SRBMiner-MULTI", None).iter().any(|s| s == "--worker"));
        assert!(!args("lolMiner", None).iter().any(|s| s == "--worker"));
    }

    /// The pwnda-xelis GPU shape, 2026-09-16: an `ssl://` pool gets
    /// SRBMiner's documented `--tls true`, as the CPU lane does, and never the
    /// `--tls-sni` flag this lane used to send. SRBMiner 3.1.1 and 3.6.2 don't
    /// know that flag, and a local TLS listener saw no SNI with or without it.
    /// The worker rides in the wallet string, so the caller
    /// (`pools.ts::workerFlagFor`) passes no `--worker`.
    #[test]
    fn an_ssl_pool_gets_tls_true_and_no_sni_flag() {
        let ssl = build_gpu_miner_args(
            "SRBMiner-MULTI",
            "stratum+ssl://xel.pwnda.org:17706",
            "xel:addr.rig1",
            "xelishashv3",
            "x",
            None,
            None,
            None,
            None,
            GPU_HTTP_PORT,
            None,
        );
        assert!(ssl.windows(2).any(|w| w[0] == "--tls" && w[1] == "true"));
        assert!(ssl.windows(2).any(|w| w[0] == "--pool" && w[1] == "stratum+ssl://xel.pwnda.org:17706"));
        assert!(ssl.windows(2).any(|w| w[0] == "--wallet" && w[1] == "xel:addr.rig1"));
        assert!(!ssl.iter().any(|s| s == "--worker"));
        assert!(!ssl.iter().any(|s| s == "--tls-sni"));
        // A plain-TCP pool gets no TLS flag at all.
        let plain = xelis_args(None, GPU_HTTP_PORT);
        assert!(!plain.iter().any(|s| s == "--tls" || s == "--tls-sni"));
    }

    #[test]
    fn the_api_port_comes_from_the_caller_on_both_miners() {
        // Pins the 2026-09-15 fix: a port hardcoded to GPU_HTTP_PORT (21558)
        // lands inside Windows' reserved 21515–21614 range on this machine,
        // so the miner's API never binds and every poll reads nothing.
        let srb = xelis_args(None, 34_201);
        assert!(srb.windows(2).any(|w| w[0] == "--api-port" && w[1] == "34201"));
        assert!(!srb.iter().any(|s| s == "21558"));
        let lol = build_gpu_miner_args(
            "lolMiner",
            "stratum+tcp://pool.example:1234",
            "wallet.worker",
            "OCTOPUS",
            "x",
            None,
            None,
            None,
            None,
            34_202,
            None,
        );
        assert!(lol.windows(2).any(|w| w[0] == "--apiport" && w[1] == "34202"));
    }

    #[test]
    fn none_omits_the_device_flag_entirely_on_both_miners() {
        // The overwhelming majority of installs (one GPU, or a user who never
        // opens the picker) must see BYTE-IDENTICAL argv to before this
        // feature existed — this is the regression the whole feature must
        // not risk for its own target audience being a tiny minority.
        for miner in ["SRBMiner-MULTI", "lolMiner"] {
            let a = args(miner, None);
            assert!(
                !a.iter().any(|s| s == "--gpu-id" || s == "--devices"),
                "{miner}: device flag must be absent when unset, got {a:?}"
            );
        }
    }

    #[test]
    fn empty_slice_is_treated_the_same_as_none() {
        // A caller that resolves "no restriction" to `Some(&[])` rather than
        // `None` (e.g. an empty selection meaning "all") must not emit a
        // flag with no value, which would either be a SRBMiner/lolMiner
        // argument-parse error or silently select zero devices.
        for miner in ["SRBMiner-MULTI", "lolMiner"] {
            let a = args(miner, Some(&[]));
            assert!(
                !a.iter().any(|s| s == "--gpu-id" || s == "--devices"),
                "{miner}: empty selection must omit the flag, got {a:?}"
            );
        }
    }

    #[test]
    fn single_index_selects_one_gpu() {
        let srb = args("SRBMiner-MULTI", Some(&[1]));
        let i = srb.iter().position(|s| s == "--gpu-id").expect("--gpu-id present");
        assert_eq!(srb[i + 1], "1");

        let lol = args("lolMiner", Some(&[1]));
        let i = lol.iter().position(|s| s == "--devices").expect("--devices present");
        assert_eq!(lol[i + 1], "1");
    }

    #[test]
    fn two_indices_produce_one_comma_joined_value_not_two_flags() {
        // "Both GPUs" must still be a single flag/value pair — two separate
        // `--gpu-id 0 --gpu-id 1` pairs is not this flag's syntax on either
        // miner and would be misparsed.
        for (miner, flag) in [("SRBMiner-MULTI", "--gpu-id"), ("lolMiner", "--devices")] {
            let a = args(miner, Some(&[0, 1]));
            let count = a.iter().filter(|s| *s == flag).count();
            assert_eq!(count, 1, "{miner}: expected exactly one {flag}, got {a:?}");
            let i = a.iter().position(|s| s == flag).unwrap();
            assert_eq!(a[i + 1], "0,1");
        }
    }

    #[test]
    fn preserves_the_caller_s_index_order() {
        // Order is the caller's to decide (e.g. a UI that lists devices in a
        // specific order); this function must not sort or dedupe silently.
        let a = args("SRBMiner-MULTI", Some(&[1, 0]));
        let i = a.iter().position(|s| s == "--gpu-id").unwrap();
        assert_eq!(a[i + 1], "1,0");
    }

    #[test]
    fn device_selection_never_touches_gpu_intensity() {
        // The two SRBMiner flags are independent knobs (which card vs. how
        // hard to push it) and must not interact when both are set.
        let a = build_gpu_miner_args(
            "SRBMiner-MULTI",
            "stratum+tcp://pool.example:1234",
            "wallet.worker",
            "kawpow",
            "x",
            None,
            None,
            Some(22),
            Some(&[0]),
            GPU_HTTP_PORT,
            None,
        );
        assert!(a.windows(2).any(|w| w[0] == "--gpu-intensity" && w[1] == "22"));
        assert!(a.windows(2).any(|w| w[0] == "--gpu-id" && w[1] == "0"));
    }

    fn with_intensity(miner: &str, intensity: Option<u32>, ids: Option<&[u32]>) -> Vec<String> {
        build_gpu_miner_args(
            miner,
            "stratum+tcp://pool.example:1234",
            "wallet.worker",
            "kawpow",
            "x",
            None,
            None,
            intensity,
            ids,
            GPU_HTTP_PORT,
            None,
        )
    }

    fn intensity_value(a: &[String]) -> Option<String> {
        a.iter()
            .position(|s| s == "--gpu-intensity")
            .map(|i| a[i + 1].clone())
    }

    #[test]
    fn slider_intensity_is_clamped_to_srbminer_s_documented_1_31() {
        // 2026-09-16 intensity slider. 0 has no documented meaning; >31 would
        // be read by SRBMiner as a RAW intensity, a different unit.
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(0), None)).as_deref(), Some("1"));
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(1), None)).as_deref(), Some("1"));
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(31), None)).as_deref(), Some("31"));
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(32), None)).as_deref(), Some("31"));
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(u32::MAX), None)).as_deref(), Some("31"));
    }

    #[test]
    fn auto_intensity_omits_the_flag() {
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", None, Some(&[0, 1]))), None);
    }

    #[test]
    fn intensity_is_repeated_per_explicitly_selected_card() {
        let a = with_intensity("SRBMiner-MULTI", Some(20), Some(&[0, 1]));
        assert_eq!(intensity_value(&a).as_deref(), Some("20,20"));
        // One card, or every card (no --gpu-id): the single value, as before.
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(20), Some(&[1]))).as_deref(), Some("20"));
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(20), None)).as_deref(), Some("20"));
        assert_eq!(intensity_value(&with_intensity("SRBMiner-MULTI", Some(20), Some(&[]))).as_deref(), Some("20"));
    }

    #[test]
    fn lolminer_never_receives_an_intensity_flag() {
        // lolMiner 1.98a has no intensity flag; the slider is disabled for it
        // in the UI and the value is dropped here regardless.
        let a = with_intensity("lolMiner", Some(28), Some(&[0, 1]));
        assert!(!a.iter().any(|s| s.contains("intensity")));
    }
}

/// Spawn (or respawn) the GPU miner with the given parameters. Stores
/// the resulting child into `GpuMinerProcess` state. Also does a brief
/// 500 ms health check to surface immediate crashes (bad DLL, unsupported
/// GPU, malformed args).
///
/// Called by `start_gpu_miner` for the initial launch with the user
/// wallet. The caller is responsible for killing any prior process.
/// (The GPU time-slice scheduler that used to relaunch this with a
/// swapped wallet was removed 2026-07-06 — pure-wallet cutover.)
/// `gpu_intensity` — SRBMiner `--gpu-intensity` value (None = AUTO). See
/// [[srbminer-flags]] §"--gpu-intensity".
/// `gpu_indices` — see `build_gpu_miner_args`'s doc comment; threaded through
/// unchanged.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn build_and_spawn_gpu_miner(
    app: &AppHandle,
    miner: &str,
    pool: &str,
    user_string: &str,
    algorithm: &str,
    pass: &str,
    worker: Option<&str>,
    socks5_proxy: Option<&str>,
    show_window: bool,
    gpu_intensity: Option<u32>,
    gpu_indices: Option<&[u32]>,
) -> Result<(), String> {
    let miners_dir = get_miners_dir(app)?;
    let exe_name = if miner == "lolMiner" {
        format!("lolMiner{}", crate::platform::EXE_SUFFIX)
    } else {
        format!("SRBMiner-MULTI{}", crate::platform::EXE_SUFFIX)
    };
    let exe_path = miners_dir.join(&exe_name);
    if !exe_path.exists() {
        return Err(format!(
            "{} not found. Please download mining software first.",
            exe_name
        ));
    }

    // 2026-05-18 — pre-spawn: resolve a per-session log path for the
    // miner's own log file. Debug-builds only (None in release).
    // Stored in `MinerLogPaths::gpu` so the Diagnostics UI can surface
    // it. The Time-slice path calls start_gpu_miner multiple times
    // per session (kill+respawn on wallet swap); each respawn gets a
    // fresh log path so the user can see each window's narrative
    // without cross-contamination. Production cost: zero — the gate
    // dead-strips the call.
    let log_path = resolve_miner_log_path(app, algorithm, "gpu");
    // Resolve the API port at spawn time instead of hardcoding 21558, and
    // never take the port the SRBMiner CPU lane is already on — XEL runs both
    // lanes at once as two SRBMiner processes, and two miners sharing an API
    // port means one of them has no API at all. See `pick_loopback_api_port`
    // for the Windows reserved-range failure this also works around.
    let cpu_port = SRB_CPU_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let api_port = pick_loopback_api_port(GPU_HTTP_PORT, &[cpu_port]);
    GPU_API_PORT.store(api_port, std::sync::atomic::Ordering::Relaxed);

    let args = build_gpu_miner_args(
        miner,
        pool,
        user_string,
        algorithm,
        pass,
        worker,
        socks5_proxy,
        gpu_intensity,
        gpu_indices,
        api_port,
        log_path.as_deref(),
    );
    if let Some(p) = log_path {
        record_miner_log_path(app, "gpu", p);
    }

    let exe_str = exe_path.to_string_lossy().to_string();
    let working_dir = miners_dir.to_string_lossy().to_string();

    let mut cmd = miner_command(&exe_str, show_window);
    cmd.args(&args);
    cmd.current_dir(&working_dir);

    // AMD OpenCL environment variables required for KawPoW GPU mining on
    // AMD cards. Skipped for lolMiner (NVIDIA-focused — doesn't use these
    // AMD-specific knobs).
    if miner != "lolMiner" {
        cmd.env("GPU_MAX_HEAP_SIZE", "100");
        cmd.env("GPU_MAX_USE_SYNC_OBJECTS", "1");
        cmd.env("GPU_SINGLE_ALLOC_PERCENT", "100");
        cmd.env("GPU_MAX_ALLOC_PERCENT", "100");
        cmd.env("GPU_MAX_SINGLE_ALLOC_PERCENT", "100");
        cmd.env("GPU_ENABLE_LARGE_ALLOCATION", "100");
        cmd.env("GPU_MAX_WORKGROUP_SIZE", "1024");
    }

    let child = cmd
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("Failed to start GPU miner: {}", e))?;

    {
        let state = app.state::<GpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        *process = Some(child);
    }

    // Brief health check: if the process exits within ~500ms it crashed on init.
    // This catches missing DLLs, unsupported GPU, or bad arguments early.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    {
        let state = app.state::<GpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut child) = *process {
            if let Ok(Some(status)) = child.try_wait() {
                *process = None;
                return Err(format!(
                    "{} exited immediately (code: {:?}). If this is SRBMiner, go to Miner Setup → Reinstall All to extract required DLLs. Also verify your GPU supports this algorithm.",
                    exe_name,
                    status.code()
                ));
            }
        }
    }

    // Survived init — now watch for a LATER unexpected exit (driver crash,
    // OOM, killed by AV) and surface it to the UI. Started after the health
    // check so an init crash keeps reporting through the clearer `Err` above
    // rather than as a generic "miner died" event.
    spawn_miner_death_watch(app.clone(), MinerLane::Gpu);

    Ok(())
}

/// Stop the running GPU miner (SRBMiner or lolMiner)
#[tauri::command]
pub async fn stop_gpu_miner(app: AppHandle) -> Result<(), String> {
    // The GPU time-slice scheduler, dev-fee proxy, and per-session logger
    // were all removed 2026-07-06 (pure-wallet cutover), so there is
    // nothing to cancel ahead of the kill — just terminate the process.
    let mut child = {
        let state = app.state::<GpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        process.take()
    }; // lock dropped here

    if let Some(ref mut c) = child {
        let _ = c.kill().await;
    }

    Ok(())
}

/// Check if a GPU miner is currently running
#[tauri::command]
pub async fn is_gpu_mining(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<GpuMinerProcess>();
    let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(ref mut child) = *process {
        match child.try_wait() {
            Ok(Some(_)) => {
                *process = None;
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(_) => {
                *process = None;
                Ok(false)
            }
        }
    } else {
        Ok(false)
    }
}

/* ─────────────────────────────────────────────────────────────────────
   SRBMiner-MULTI CPU lane (XelisHash v3) — added 2026-09-15.

   xmrig cannot mine XelisHash, so the CPU lane grew a second backend. It
   gets its OWN process slot and API port, which is what lets XEL run on
   both lanes at once as two SRBMiner processes. Every stop path here takes
   the `Child` out of `SrbCpuMinerProcess` and kills that handle: nothing in
   this module kills SRBMiner by image name, which would take the GPU lane
   down with it.

   The two CPU backends are mutually exclusive — there is one CPU lane and
   one CPU session — so each start refuses while the other is live.
   ───────────────────────────────────────────────────────────────────── */

/// Algorithms this lane is allowed to launch. An allow-list rather than "any
/// string the frontend sends": SRBMiner also implements CPU RandomX, and
/// routing RandomX here would quietly bypass xmrig's elevation + MSR path.
const SRB_CPU_ALGORITHMS: &[&str] = &["xelishashv3"];

/// Which lane of an SRBMiner API document to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SrbLane {
    Cpu,
    Gpu,
}

/// The numbers one SRBMiner-MULTI API document carries for one lane.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct SrbApiSnapshot {
    pub hashrate: Option<f64>,
    pub accepted: u64,
    pub rejected: u64,
    pub diff_current: Option<u64>,
    pub uptime_secs: u64,
    pub ping_ms: Option<u64>,
    pub threads_active: Option<usize>,
}

/// Parse SRBMiner-MULTI's `GET /` document.
///
/// Paths verified against captures from live 3.6.2 sessions on 2026-09-15 (a
/// CPU lane on K1Pool and a GPU lane on HeroMiners, both with accepted
/// shares):
///
/// ```text
/// mining_time: 104, total_cpu_workers: 2,
/// algorithms[0].hashrate.{1min, 1hr, cpu.{thread0,…,total}, gpu.{gpu0,…,total}}
/// algorithms[0].shares.{total, accepted, rejected, avg_find_time}
/// algorithms[0].pool.{pool, wallet, uptime, difficulty, latency}
/// ```
///
/// Two paths the previous GPU-only parser read do not exist in that document,
/// and had been yielding nothing for every SRBMiner session:
/// `algorithms[0].difficulty` — the real one is `pool.difficulty` and it is a
/// FLOAT (`as_u64()` returns None for `100000.0`) — and `algorithms[0].uptime`
/// / `mining_started`, where the real ones are `pool.uptime` and top-level
/// `mining_time`. So POOL DIFF rendered "—" and uptime stayed 0, which also
/// kept `sharesPerMin` (gated on uptime ≥ 30 s) permanently null. SRBMiner
/// does report its stratum latency (`pool.latency`), so `ping_ms` is real
/// here even though lolMiner has no equivalent.
pub(crate) fn parse_srbminer_api(v: &serde_json::Value, lane: SrbLane) -> SrbApiSnapshot {
    let algo = &v["algorithms"][0];
    let hashrate = {
        let one_min = algo["hashrate"]["1min"].as_f64().unwrap_or(0.0);
        let instant = match lane {
            SrbLane::Cpu => algo["hashrate"]["cpu"]["total"].as_f64().unwrap_or(0.0),
            SrbLane::Gpu => algo["hashrate"]["gpu"]["total"].as_f64().unwrap_or(0.0),
        };
        // Prefer the 60-second average (the number SRBMiner itself displays);
        // fall back to the instantaneous lane total while it is still filling.
        let h = if one_min > 0.0 { one_min } else { instant };
        if h > 0.0 {
            Some(h)
        } else {
            None
        }
    };
    let pool = &algo["pool"];
    let diff_current = pool["difficulty"]
        .as_f64()
        .filter(|d| *d > 0.0)
        .map(|d| d.round() as u64)
        // Older/other shapes, kept as a fallback rather than a replacement.
        .or_else(|| algo["difficulty"].as_u64());
    let uptime_secs = pool["uptime"]
        .as_u64()
        .or_else(|| v["mining_time"].as_u64())
        .unwrap_or(0);
    SrbApiSnapshot {
        hashrate,
        accepted: algo["shares"]["accepted"].as_u64().unwrap_or(0),
        rejected: algo["shares"]["rejected"].as_u64().unwrap_or(0),
        diff_current,
        uptime_secs,
        ping_ms: pool["latency"].as_u64(),
        threads_active: match lane {
            // SRBMiner's own resolved worker count — the CPU equivalent of
            // xmrig's `hashrate.threads.len()`.
            SrbLane::Cpu => v["total_cpu_workers"].as_u64().map(|n| n as usize),
            SrbLane::Gpu => None,
        },
    }
}

/// CPU thread + priority flags for one mining-intensity tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct SrbCpuThreadArgs {
    pub threads: Option<usize>,
    pub threads_priority: Option<u8>,
    pub miner_priority: Option<u8>,
}

/// Map an intensity tier to SRBMiner CPU flags, given the machine's logical
/// processor count:
///
/// - `low` → 2 threads, lowest worker-thread priority (1) and a below-normal
///   process priority (2), so the desktop stays responsive.
/// - `medium` → half the logical processors at SRBMiner's own default
///   priorities.
/// - `high` → every logical processor.
///
/// Measured on the dev box 2026-09-15 (i9-13900K, SRBMiner 3.6.2,
/// xelishashv3): 2 threads ≈ 1.45 kH/s, 32 threads ≈ 12.4 kH/s. SRBMiner's
/// own auto (no `--cpu-threads` at all) also resolved to 32 threads, so
/// "high" passing the count explicitly changes nothing except making the tier
/// deterministic. An unknown tier lands on "high" for the same reason the
/// xmrig mapping does: quieter-than-asked is the worse failure.
pub(crate) fn srb_cpu_thread_args(intensity: &str, logical: usize) -> SrbCpuThreadArgs {
    match intensity {
        "low" => SrbCpuThreadArgs {
            threads: Some(2),
            threads_priority: Some(1),
            miner_priority: Some(2),
        },
        "medium" => SrbCpuThreadArgs {
            // Unknown core count → omit the flag and let SRBMiner decide,
            // rather than inventing a number.
            threads: if logical > 1 { Some(logical / 2) } else { None },
            ..Default::default()
        },
        _ => SrbCpuThreadArgs {
            threads: if logical > 0 { Some(logical) } else { None },
            ..Default::default()
        },
    }
}

/// SRBMiner CPU flags for an EXACT thread count from the UI's thread slider
/// (SRBMiner-MULTI 3.6.2 `--help`: `--cpu-threads (number of cpu threads to
/// use for mining, ...)`). The count is clamped to `1..=logical`; a small
/// partial footprint (see [`cpu_threads_low_priority`]) also gets the LOW
/// tier's priorities (`--cpu-threads-priority 1`, `--miner-priority 2`), so a
/// slider set near LOW behaves like LOW did.
pub(crate) fn srb_cpu_thread_args_for_count(threads: usize, logical: usize) -> SrbCpuThreadArgs {
    let n = clamp_cpu_thread_count(threads, logical);
    if cpu_threads_low_priority(n, logical) {
        SrbCpuThreadArgs {
            threads: Some(n),
            threads_priority: Some(1),
            miner_priority: Some(2),
        }
    } else {
        SrbCpuThreadArgs {
            threads: Some(n),
            ..Default::default()
        }
    }
}

/// Build the SRBMiner-MULTI **CPU lane** argv. Pure — no spawn, no state — so
/// the tests below cover it without a binary.
///
/// Mirrors `build_gpu_miner_args`'s SRBMiner branch with the lanes swapped:
/// `--algorithm-cpu <algo> --disable-gpu` instead of `--disable-cpu
/// --algorithm <algo>`, so this process never initialises a GPU backend the
/// GPU lane's process may be using.
///
/// TLS: SRBMiner infers it from a `stratum+ssl://` pool URL, and `--tls true`
/// (its documented flag) states it explicitly — verified 2026-09-15 with a
/// TLS 1.3 session to K1Pool 9352. `worker` is XELIS-specific: that protocol's
/// `mining.authorize` carries the worker as its own field, which SRBMiner
/// fills from `--worker` (captured: `["xel:…","pwnda-cpu","x"]`).
#[allow(clippy::too_many_arguments)]
fn build_srbminer_cpu_args(
    pool: &str,
    user_string: &str,
    algorithm: &str,
    pass: &str,
    worker: Option<&str>,
    socks5_proxy: Option<&str>,
    threads: SrbCpuThreadArgs,
    api_port: u16,
    log_path: Option<&std::path::Path>,
) -> Vec<String> {
    let mut args = vec![
        "--algorithm-cpu".to_string(),
        algorithm.to_string(),
        // GPU-free: this lane must not touch the cards the GPU lane uses.
        "--disable-gpu".to_string(),
        "--pool".to_string(),
        pool.to_string(),
        "--wallet".to_string(),
        user_string.to_string(),
        "--password".to_string(),
        pass.to_string(),
        "--send-stales".to_string(),
        "true".to_string(),
        "--api-enable".to_string(),
        "--api-port".to_string(),
        api_port.to_string(),
        // Same fast-reconnect posture as the GPU lane.
        "--retry-time".to_string(),
        "1".to_string(),
        "--give-up-limit".to_string(),
        "100".to_string(),
    ];

    if pool.contains("ssl://") {
        args.push("--tls".to_string());
        args.push("true".to_string());
    }

    if let Some(w) = worker.map(str::trim).filter(|w| !w.is_empty()) {
        args.push("--worker".to_string());
        args.push(w.to_string());
    }

    if let Some(p) = socks5_proxy {
        if let Some(host_port) = normalize_socks_proxy(p) {
            args.push("--proxy".to_string());
            args.push(host_port);
        }
    }

    if let Some(n) = threads.threads.filter(|n| *n > 0) {
        args.push("--cpu-threads".to_string());
        args.push(n.to_string());
    }
    if let Some(p) = threads.threads_priority {
        args.push("--cpu-threads-priority".to_string());
        args.push(p.clamp(1, 5).to_string());
    }
    if let Some(p) = threads.miner_priority {
        args.push("--miner-priority".to_string());
        args.push(p.clamp(1, 5).to_string());
    }

    if let Some(p) = log_path {
        args.push("--log-file".to_string());
        args.push(p.to_string_lossy().to_string());
    }

    args
}

/// Logical processor count for the intensity mapping. Asks `device_info`
/// first (the same detector the DEVICES panel shows the user, and the one
/// that sums sockets), falling back to the std parallelism hint if that scan
/// fails — the miner must still start when a diagnostic call does not.
async fn detect_logical_processors() -> usize {
    if let Ok(info) = crate::device_info::get_cpu_info().await {
        if info.threads > 0 {
            return info.threads as usize;
        }
    }
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0)
}

/// Start the SRBMiner-MULTI CPU lane (XelisHash v3). No elevation: MSR mod is
/// an xmrig/RandomX concern and this lane never asks for it.
#[tauri::command]
pub async fn start_srbminer_cpu(
    app: AppHandle,
    pool: String,
    user_string: String,
    algorithm: String,
    pass: String,
    proxy: Option<String>,
    worker: Option<String>,
    intensity: Option<String>,
    // Exact thread count from the thread slider (2026-09-16). When present
    // and non-zero it wins over `intensity`; `None` keeps the tier mapping,
    // which is also what "all threads" sends.
    threads: Option<usize>,
) -> Result<(), String> {
    // Shares the CPU lane's "already starting" sentinel with `start_xmrig`,
    // so click-spam cannot start two CPU sessions of either kind.
    let starting_state = app.state::<MinerStarting>();
    let _starting_guard = StartGuard::try_acquire(&starting_state.0).ok_or_else(|| {
        "Mining is already starting. Wait for the current start to finish, or stop it first."
            .to_string()
    })?;

    if !SRB_CPU_ALGORITHMS.contains(&algorithm.as_str()) {
        return Err(format!(
            "{} is not an SRBMiner CPU-lane algorithm (expected one of: {}).",
            algorithm,
            SRB_CPU_ALGORITHMS.join(", ")
        ));
    }

    // One CPU lane: refuse while xmrig holds it.
    {
        let pid_state = app.state::<MinerPid>();
        let pid = pid_state
            .0
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        if pid.is_some() {
            return Err(
                "The CPU is already mining with xmrig. Stop that session first.".to_string(),
            );
        }
    }

    // …and refuse if this lane is already running.
    {
        let state = app.state::<SrbCpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut child) = *process {
            match child.try_wait() {
                Ok(Some(_)) => *process = None,
                Ok(None) => {
                    return Err("The CPU miner is already running. Stop it first.".to_string())
                }
                Err(_) => *process = None,
            }
        }
    }

    let miners_dir = get_miners_dir(&app)?;
    let exe_name = format!("SRBMiner-MULTI{}", crate::platform::EXE_SUFFIX);
    let exe_path = miners_dir.join(&exe_name);
    if !exe_path.exists() {
        return Err(format!(
            "{} not found. Please download mining software first.",
            exe_name
        ));
    }

    let logical = detect_logical_processors().await;
    let threads = match threads {
        Some(n) if n > 0 => srb_cpu_thread_args_for_count(n, logical),
        _ => srb_cpu_thread_args(intensity.as_deref().unwrap_or("high"), logical),
    };

    // Never the GPU lane's port, even if both fall back to an OS-assigned one.
    let gpu_port = GPU_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let api_port = pick_loopback_api_port(SRB_CPU_HTTP_PORT, &[gpu_port]);
    SRB_CPU_API_PORT.store(api_port, std::sync::atomic::Ordering::Relaxed);

    let log_path = resolve_miner_log_path(&app, &algorithm, "cpu");
    let args = build_srbminer_cpu_args(
        &pool,
        &user_string,
        &algorithm,
        &pass,
        worker.as_deref(),
        proxy.as_deref(),
        threads,
        api_port,
        log_path.as_deref(),
    );
    if let Some(p) = log_path {
        record_miner_log_path(&app, "cpu", p);
    }

    let show_window = read_show_miner_window(&app);
    let mut cmd = miner_command(exe_path.to_string_lossy().as_ref(), show_window);
    cmd.args(&args);
    cmd.current_dir(miners_dir.to_string_lossy().to_string());

    let child = cmd
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("Failed to start the CPU miner: {}", e))?;

    {
        let state = app.state::<SrbCpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        *process = Some(child);
    }

    // Same brief health check as the GPU lane: an immediate exit is a bad
    // argument or a missing DLL, and says so clearly instead of surfacing
    // later as a generic "miner died".
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    {
        let state = app.state::<SrbCpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut child) = *process {
            if let Ok(Some(status)) = child.try_wait() {
                *process = None;
                return Err(format!(
                    "{} exited immediately (code: {:?}). Go to Miner Setup → Reinstall All to re-extract its support files, and check that the pool and address are valid.",
                    exe_name,
                    status.code()
                ));
            }
        }
    }

    spawn_miner_death_watch(app.clone(), MinerLane::CpuSrb);
    Ok(())
}

/// Stop the SRBMiner CPU lane. Takes the child OUT of the slot first (so the
/// death watch reads the empty slot as an intentional stop) and kills that
/// handle — never an image-name kill, which would also stop a GPU session.
#[tauri::command]
pub async fn stop_srbminer_cpu(app: AppHandle) -> Result<(), String> {
    let mut child = {
        let state = app.state::<SrbCpuMinerProcess>();
        let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        process.take()
    }; // lock dropped here

    if let Some(ref mut c) = child {
        let _ = c.kill().await;
    }

    Ok(())
}

/// Whether the SRBMiner CPU lane is running.
#[tauri::command]
pub async fn is_srbminer_cpu_mining(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<SrbCpuMinerProcess>();
    let mut process = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(ref mut child) = *process {
        match child.try_wait() {
            Ok(Some(_)) => {
                *process = None;
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(_) => {
                *process = None;
                Ok(false)
            }
        }
    } else {
        Ok(false)
    }
}

/// Session snapshot for the SRBMiner CPU lane, in the SAME wire shape as
/// `get_xmrig_snapshot` so the frontend poll only has to switch command name.
#[tauri::command]
pub async fn get_srbminer_cpu_snapshot() -> Result<Option<XmrigSnapshot>, String> {
    let port = SRB_CPU_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let v = match fetch_miner_api_json(port).await? {
        Some(v) => v,
        None => return Ok(None),
    };
    let s = parse_srbminer_api(&v, SrbLane::Cpu);
    Ok(Some(XmrigSnapshot {
        hashrate: s.hashrate,
        accepted: s.accepted,
        rejected: s.rejected,
        diff_current: s.diff_current,
        ping_ms: s.ping_ms,
        uptime_secs: s.uptime_secs,
        threads_active: s.threads_active,
    }))
}

#[cfg(test)]
mod srbminer_cpu_tests {
    use super::*;

    /// Verbatim (whitespace-trimmed) from the CPU lane's own API during a live
    /// SRBMiner-MULTI 3.6.2 session on 2026-09-15: `--algorithm-cpu
    /// xelishashv3 --disable-gpu --cpu-threads 2`, K1Pool's CPU port, two
    /// accepted shares.
    const CPU_API: &str = r#"{"rig_name":"SRBMiner-Multi-Rig","miner_version":"3.6.2","mining_time":104,"total_cpu_workers":2,"total_gpu_workers":0,"total_workers":2,"cpu_devices":[{"id":0,"device":"cpu0","model":"13th Gen Intel(R) Core(TM) i9-13900K"}],"gpu_devices":[],"algorithms":[{"id":0,"name":"xelishashv3","pool":{"pool":"eu.xel.k1pool.com:9350","wallet":"xel:teq…","time_connected":"2026-09-15 17:59:53","uptime":102,"difficulty":100000.0,"last_job_received":2,"latency":133},"shares":{"total":2,"accepted":2,"rejected":0,"avg_find_time":51},"hashrate":{"1min":1468.17,"1hr":1371.34,"6hr":0.0,"12hr":0.0,"cpu":{"thread0":742.93,"thread1":764.78,"total":1507.71},"gpu":{"total":0.0}}}]}"#;

    /// Same session pair, GPU lane: two cards on HeroMiners, three accepted.
    const GPU_API: &str = r#"{"rig_name":"SRBMiner-Multi-Rig","miner_version":"3.6.2","mining_time":104,"total_cpu_workers":0,"total_gpu_workers":2,"algorithms":[{"id":0,"name":"xelishashv3","pool":{"pool":"de.xelis.herominers.com:1225","uptime":99,"difficulty":187500.0,"latency":130},"shares":{"total":3,"accepted":3,"rejected":0,"avg_find_time":33},"hashrate":{"1min":11404.45,"1hr":11312.31,"cpu":{"total":0.0},"gpu":{"gpu0":3883.1,"gpu1":7015.31,"total":10898.41}}}]}"#;

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).expect("fixture parses")
    }

    #[test]
    fn parses_the_cpu_lane_document() {
        let s = parse_srbminer_api(&json(CPU_API), SrbLane::Cpu);
        assert_eq!(s.hashrate, Some(1468.17), "prefers the 1min average");
        assert_eq!(s.accepted, 2);
        assert_eq!(s.rejected, 0);
        assert_eq!(s.threads_active, Some(2), "SRBMiner's resolved worker count");
    }

    #[test]
    fn reads_pool_difficulty_uptime_and_latency_where_they_actually_live() {
        // The regression this pins: `algorithms[0].difficulty` does not exist
        // (it is `pool.difficulty`) and it is a FLOAT, so the old `as_u64()`
        // read returned None and POOL DIFF rendered "—" for every SRBMiner
        // session. Same story for uptime, which also disabled shares/min.
        for (doc, lane, diff, uptime, ping) in [
            (CPU_API, SrbLane::Cpu, 100_000u64, 102u64, 133u64),
            (GPU_API, SrbLane::Gpu, 187_500u64, 99u64, 130u64),
        ] {
            let s = parse_srbminer_api(&json(doc), lane);
            assert_eq!(s.diff_current, Some(diff));
            assert_eq!(s.uptime_secs, uptime);
            assert_eq!(s.ping_ms, Some(ping));
        }
    }

    #[test]
    fn reads_the_lane_it_was_asked_for() {
        // The GPU document's `hashrate.cpu.total` is 0.0 and the CPU
        // document's `hashrate.gpu.total` is 0.0, so a lane mix-up would show
        // a mining rig at zero.
        let gpu = parse_srbminer_api(&json(GPU_API), SrbLane::Gpu);
        assert_eq!(gpu.hashrate, Some(11404.45));
        assert_eq!(gpu.threads_active, None, "GPU lane has no thread count");
        // A document with no 1min average yet falls back to the lane total.
        let warming = json(
            r#"{"mining_time":4,"total_cpu_workers":32,"algorithms":[{"pool":{"uptime":3},"shares":{"accepted":0,"rejected":0},"hashrate":{"1min":0.0,"cpu":{"total":9000.5},"gpu":{"total":0.0}}}]}"#,
        );
        assert_eq!(parse_srbminer_api(&warming, SrbLane::Cpu).hashrate, Some(9000.5));
    }

    #[test]
    fn an_unreachable_or_empty_document_yields_nothing_rather_than_zeros() {
        let empty = parse_srbminer_api(&json("{}"), SrbLane::Cpu);
        assert_eq!(empty.hashrate, None);
        assert_eq!(empty.diff_current, None);
        assert_eq!(empty.uptime_secs, 0);
        assert_eq!(empty.ping_ms, None);
    }

    #[test]
    fn intensity_tiers_map_to_threads_and_priorities() {
        assert_eq!(
            srb_cpu_thread_args("low", 32),
            SrbCpuThreadArgs { threads: Some(2), threads_priority: Some(1), miner_priority: Some(2) }
        );
        assert_eq!(srb_cpu_thread_args("medium", 32).threads, Some(16));
        assert_eq!(srb_cpu_thread_args("high", 32).threads, Some(32));
        // Low is agnostic of the core count, exactly like xmrig's Low.
        assert_eq!(srb_cpu_thread_args("low", 4).threads, Some(2));
    }

    #[test]
    fn an_undetected_core_count_omits_the_thread_flag_instead_of_guessing() {
        assert_eq!(srb_cpu_thread_args("medium", 0).threads, None);
        assert_eq!(srb_cpu_thread_args("high", 0).threads, None);
        // …but Low still means 2 threads, which needs no detection.
        assert_eq!(srb_cpu_thread_args("low", 0).threads, Some(2));
    }

    #[test]
    fn an_exact_slider_count_maps_to_cpu_threads_clamped() {
        use super::srb_cpu_thread_args_for_count;
        assert_eq!(
            srb_cpu_thread_args_for_count(12, 32),
            SrbCpuThreadArgs { threads: Some(12), threads_priority: None, miner_priority: None }
        );
        // Over the machine's count -> every processor, default priorities.
        assert_eq!(
            srb_cpu_thread_args_for_count(64, 32),
            SrbCpuThreadArgs { threads: Some(32), threads_priority: None, miner_priority: None }
        );
        // Zero is floored to one thread, which is a background footprint.
        assert_eq!(
            srb_cpu_thread_args_for_count(0, 32),
            SrbCpuThreadArgs { threads: Some(1), threads_priority: Some(1), miner_priority: Some(2) }
        );
        // The LOW preset (2 threads) is byte-identical to the old "low" tier...
        assert_eq!(srb_cpu_thread_args_for_count(2, 32), srb_cpu_thread_args("low", 32));
        // ...and "all threads" to the old "high" tier.
        assert_eq!(srb_cpu_thread_args_for_count(32, 32), srb_cpu_thread_args("high", 32));
    }

    #[test]
    fn a_slider_count_reaches_the_argv_as_cpu_threads() {
        let a = build_srbminer_cpu_args(
            "stratum+tcp://eu.xel.k1pool.com:9350",
            "xel:addr",
            "xelishashv3",
            "x",
            None,
            None,
            super::srb_cpu_thread_args_for_count(12, 32),
            34201,
            None,
        );
        assert!(a.windows(2).any(|w| w[0] == "--cpu-threads" && w[1] == "12"));
        assert!(!a.iter().any(|s| s == "--cpu-threads-priority" || s == "--miner-priority"));
    }

    #[test]
    fn an_unknown_tier_lands_on_high_not_on_something_quieter() {
        assert_eq!(srb_cpu_thread_args("turbo", 16).threads, Some(16));
    }

    fn args(pool: &str, worker: Option<&str>, proxy: Option<&str>) -> Vec<String> {
        build_srbminer_cpu_args(
            pool,
            "xel:addr",
            "xelishashv3",
            "x",
            worker,
            proxy,
            srb_cpu_thread_args("low", 32),
            34201,
            None,
        )
    }

    #[test]
    fn cpu_argv_is_cpu_only_and_never_claims_a_gpu() {
        let a = args("stratum+tcp://eu.xel.k1pool.com:9350", None, None);
        assert!(a.windows(2).any(|w| w[0] == "--algorithm-cpu" && w[1] == "xelishashv3"));
        assert!(a.iter().any(|s| s == "--disable-gpu"));
        // The GPU lane's flags must never appear here: this process runs
        // beside a GPU session.
        assert!(!a.iter().any(|s| s == "--disable-cpu" || s == "--algorithm" || s == "--gpu-id"));
    }

    #[test]
    fn cpu_argv_carries_its_own_api_port_and_thread_flags() {
        let a = args("stratum+tcp://eu.xel.k1pool.com:9350", None, None);
        assert!(a.windows(2).any(|w| w[0] == "--api-port" && w[1] == "34201"));
        assert!(a.iter().any(|s| s == "--api-enable"));
        assert!(a.windows(2).any(|w| w[0] == "--cpu-threads" && w[1] == "2"));
        assert!(a.windows(2).any(|w| w[0] == "--cpu-threads-priority" && w[1] == "1"));
        assert!(a.windows(2).any(|w| w[0] == "--miner-priority" && w[1] == "2"));
    }

    #[test]
    fn tls_only_for_an_ssl_pool_url() {
        let plain = args("stratum+tcp://eu.xel.k1pool.com:9350", None, None);
        assert!(!plain.iter().any(|s| s == "--tls"));
        let ssl = args("stratum+ssl://xel.kryptex.network:8019", None, None);
        assert!(ssl.windows(2).any(|w| w[0] == "--tls" && w[1] == "true"));
        // pwnda-xelis (2026-09-16): one TLS port serves both lanes, and the
        // caller passes no worker (it is in the wallet string).
        let pwnda = args("stratum+ssl://xel.pwnda.org:17706", None, None);
        assert!(pwnda.windows(2).any(|w| w[0] == "--tls" && w[1] == "true"));
        assert!(!pwnda.iter().any(|s| s == "--worker" || s == "--tls-sni"));
    }

    #[test]
    fn worker_is_a_separate_flag_and_an_empty_one_is_omitted() {
        // XELIS authorize carries the worker as its own field; the wallet
        // stays a bare address (which is what K1Pool keys the account by).
        let a = args("stratum+tcp://eu.xel.k1pool.com:9350", Some("rig1"), None);
        assert!(a.windows(2).any(|w| w[0] == "--worker" && w[1] == "rig1"));
        assert!(a.windows(2).any(|w| w[0] == "--wallet" && w[1] == "xel:addr"));
        for empty in [Some("   "), Some(""), None] {
            let b = args("stratum+tcp://eu.xel.k1pool.com:9350", empty, None);
            assert!(!b.iter().any(|s| s == "--worker"), "{empty:?}");
        }
    }

    #[test]
    fn socks5_proxy_is_passed_normalized_and_omitted_when_absent() {
        let a = args(
            "stratum+tcp://eu.xel.k1pool.com:9350",
            None,
            Some("socks5://127.0.0.1:34300"),
        );
        assert!(a.windows(2).any(|w| w[0] == "--proxy" && w[1] == "127.0.0.1:34300"));
        let b = args("stratum+tcp://eu.xel.k1pool.com:9350", None, None);
        assert!(!b.iter().any(|s| s == "--proxy"));
    }

    #[test]
    fn only_allow_listed_algorithms_may_use_this_lane() {
        // RandomX must stay on xmrig (elevation + MSR); SRBMiner can mine it,
        // which is exactly why the guard is an allow-list.
        assert!(SRB_CPU_ALGORITHMS.contains(&"xelishashv3"));
        assert!(!SRB_CPU_ALGORITHMS.contains(&"randomx"));
        assert!(!SRB_CPU_ALGORITHMS.contains(&"rx/0"));
    }

    #[test]
    fn the_two_lanes_never_share_an_api_port() {
        assert_ne!(SRB_CPU_HTTP_PORT, GPU_HTTP_PORT);
        assert_ne!(SRB_CPU_HTTP_PORT, XMRIG_HTTP_PORT);
        // And the picker refuses to hand back a port it was told to avoid.
        assert_ne!(pick_loopback_api_port(SRB_CPU_HTTP_PORT, &[SRB_CPU_HTTP_PORT]), SRB_CPU_HTTP_PORT);
    }
}

/// Check if xmrig is currently running by checking if the elevated PID still exists
#[tauri::command]
pub async fn is_mining(app: AppHandle) -> Result<bool, String> {
    // Read the PID from state — drop the lock before any .await
    let pid = {
        let pid_state = app.state::<MinerPid>();
        let pid_lock = pid_state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        *pid_lock
    }; // MutexGuard dropped here

    if let Some(pid) = pid {
        // Check if the process with this PID is still running (hidden tasklist)
        let mut cmd = hidden_command("tasklist");
        cmd.args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"]);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to check mining status: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let running = stdout.contains(&pid.to_string());

        if !running {
            // Clean up: process ended — re-acquire locks in separate scopes
            {
                let pid_state = app.state::<MinerPid>();
                let mut pid_lock =
                    pid_state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
                *pid_lock = None;
            }
            {
                let state = app.state::<MinerProcess>();
                let mut process =
                    state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
                if let Some(ref mut c) = *process {
                    let _ = c.try_wait();
                }
                *process = None;
            }
        }

        Ok(running)
    } else {
        Ok(false)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 2 Phase 3 — MSR environment scan
//
// Single PowerShell call returns a JSON snapshot of every check the
// HashrateFixPanel needs. Cached in MsrEnvCache for the session; refreshed
// on Mining tab entry, Hard Reset, or app restart.
// ─────────────────────────────────────────────────────────────────────────────

/// State of the MSR environment as observed by the most recent scan.
/// Drives both Phase 2's flag matrix in start_xmrig_v2 and Phase 6's
/// HashrateFixPanel UI.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashrateFixPlan {
    /// Vulnerable Driver Blocklist is OFF — MSR mod is reachable.
    pub blocklist_off: bool,
    /// Smart App Control is OFF or in evaluation mode — driver loading not blocked by SAC.
    pub sac_off: bool,
    /// HVCI / Memory Integrity is OFF (informational only — not a runtime gate for MSR).
    pub hvci_off: bool,
    /// Secure Boot is OFF (informational only).
    pub secure_boot_off: bool,
    /// SeLockMemoryPrivilege is granted to the current user — `--huge-pages-jit` will work.
    pub se_lock_memory_granted: bool,
    /// If WinRing0_1_2_0 is registered with a non-PwndaWallet ImagePath, this contains it.
    /// Hard Reset clears it via `sc stop` + `sc delete` (one UAC consent).
    pub winring0_collision: Option<String>,
    /// Names of running offender processes that hold their own WinRing0 driver
    /// (HWiNFO64, MSIAfterburner, etc.). Informational; runtime collision-clear handles them.
    pub collision_apps: Vec<String>,
    /// Number of NUMA nodes — `--cpu-numa-pin` is set when > 1.
    pub numa_node_count: u32,
    /// Logical-cores != physical-cores → SMT enabled.
    pub smt_enabled: bool,
    pub physical_core_count: u32,
    pub logical_core_count: u32,
    /// Unix timestamp of when this scan was performed.
    pub scanned_at: u64,
}

/// Cached MSR environment, refreshed on demand.
pub struct MsrEnvCache(pub Mutex<Option<HashrateFixPlan>>);

/// PowerShell script that returns the full environment as a single JSON object.
/// Designed to never throw — every check is wrapped in try/catch so the script
/// always returns a parseable JSON document even on partial failures.
const ENV_SCAN_SCRIPT: &str = r#"
$result = [PSCustomObject]@{
    blocklistOff       = $false
    sacOff             = $false
    hvciOff            = $false
    secureBootOff      = $false
    seLockMemoryGranted = $false
    winring0Collision  = $null
    collisionApps      = @()
    numaNodeCount      = 1
    smtEnabled         = $false
    physicalCoreCount  = 0
    logicalCoreCount   = 0
    scannedAt          = [int][double]::Parse((Get-Date -UFormat %s))
}

try {
    $pref = Get-MpPreference -ErrorAction Stop
    $result.blocklistOff = -not $pref.EnableVulnerableDriverBlocklist
} catch {}

try {
    $dg = Get-CimInstance Win32_DeviceGuard -Namespace 'root\Microsoft\Windows\DeviceGuard' -ErrorAction Stop
    # SmartAppControlState: 0=Off, 1=Evaluation, 2=On. Off or eval = "off" for our purposes.
    $sacState = $dg.SmartAppControlState
    $result.sacOff = ($sacState -ne 2)
} catch {
    # If we can't query, assume SAC is off (consumer-default)
    $result.sacOff = $true
}

try {
    $hvciVal = Get-ItemPropertyValue -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity' -Name 'Enabled' -ErrorAction Stop
    $result.hvciOff = ($hvciVal -eq 0)
} catch {
    $result.hvciOff = $true
}

try {
    $sb = Confirm-SecureBootUEFI -ErrorAction Stop
    $result.secureBootOff = -not $sb
} catch {
    $result.secureBootOff = $true
}

try {
    $priv = whoami /priv 2>$null
    $result.seLockMemoryGranted = ($priv -match 'SeLockMemoryPrivilege')
} catch {}

try {
    $svc = Get-Service -Name 'WinRing0_1_2_0' -ErrorAction SilentlyContinue
    if ($svc) {
        $qc = & sc.exe qc WinRing0_1_2_0 2>$null
        $line = $qc | Where-Object { $_ -match 'BINARY_PATH_NAME' } | Select-Object -First 1
        if ($line) {
            $imagePath = ($line -replace '.*BINARY_PATH_NAME\s*:\s*','').Trim()
            $result.winring0Collision = $imagePath
        } else {
            $result.winring0Collision = '(unknown ImagePath)'
        }
    }
} catch {}

$offenders = @('HWiNFO64','MSIAfterburner','OpenRGB','OpenRGBServer','RyzenMaster','ThrottleStop',
               'AIDA64','FanControl','RazerCentralService','ArmouryCrate.Service',
               'LightingService','cpuz_140_x64','nhqmservice')
$collisions = @()
foreach ($name in $offenders) {
    try {
        if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
            $collisions += $name
        }
    } catch {}
}
$result.collisionApps = $collisions

try {
    $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop
    $physicalCores = ($cpu | Measure-Object -Property NumberOfCores -Sum).Sum
    $logicalProcs  = ($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    if ($physicalCores) { $result.physicalCoreCount = [int]$physicalCores }
    if ($logicalProcs)  { $result.logicalCoreCount  = [int]$logicalProcs }
    $result.smtEnabled = ($logicalProcs -gt $physicalCores)
} catch {}

try {
    $numa = Get-CimInstance -Namespace 'root\StandardCimv2' -ClassName MSFT_NetIPInterface -ErrorAction SilentlyContinue
    # Fallback: count NUMA nodes via Win32 API only if Win32_NumaNode exists
    $numaCount = 1
    try {
        $nn = Get-CimInstance Win32_NumaNode -ErrorAction Stop
        $numaCount = ($nn | Measure-Object).Count
    } catch {
        # Win32_NumaNode is not always available; default to 1
        $numaCount = 1
    }
    if ($numaCount -lt 1) { $numaCount = 1 }
    $result.numaNodeCount = [int]$numaCount
} catch {}

$result | ConvertTo-Json -Compress -Depth 5
"#;

/// Run the env scan PowerShell script and return the deserialized plan.
async fn run_env_scan() -> Result<HashrateFixPlan, String> {
    let mut cmd = hidden_powershell_command();
    cmd.args(["-NoProfile", "-Command", ENV_SCAN_SCRIPT]);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("env scan: failed to run powershell: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("env scan powershell exited non-zero: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("env scan returned empty output".to_string());
    }

    serde_json::from_str::<HashrateFixPlan>(trimmed)
        .map_err(|e| format!("env scan: failed to parse JSON ({}): {}", e, trimmed))
}

/// Get the cached MSR environment scan, running (and caching) a fresh one
/// when `force` is true or no cache exists yet. Shared by the frontend-facing
/// `scan_msr_environment` command and `start_xmrig`'s internal MSR-attempt
/// gating (`should_attempt_msr_mod`) — both need the exact same cache
/// semantics, so this is the single place that owns them.
async fn get_env_scan(app: &AppHandle, force: bool) -> Result<HashrateFixPlan, String> {
    if !force {
        let cache = app.state::<MsrEnvCache>();
        let read = cache.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(plan) = read.as_ref() {
            return Ok(plan.clone());
        }
    }

    let plan = run_env_scan().await?;
    let cache = app.state::<MsrEnvCache>();
    let mut write = cache.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *write = Some(plan.clone());
    Ok(plan)
}

/// Whether a session should even attempt MSR mod (driver fetch + the
/// `--randomx-wrmsr=6` flag) given the current environment scan.
///
/// `hvci_off` is documented elsewhere (see [`HashrateFixPlan`]) as
/// "informational only — not a runtime gate for MSR". This function treats
/// it as one anyway, deliberately more conservative than that documented
/// stance: a real-world session with HVCI confirmed running showed 100% MSR
/// write failures (`cannot set MSR 0x1a4`) across dozens of independent
/// mining sessions — strong enough correlation that attempting anyway (and
/// touching the WinRing0 driver for nothing) isn't worth it. This does NOT
/// change what `hvci_off` means for the HashrateFixPanel UI elsewhere; it's
/// only used as a heuristic input to this one internal decision.
///
/// A detected `winring0_collision` (another app's WinRing0 registered under
/// the same fixed service name) is also treated as a reason to skip —
/// attempting MSR mod against a mismatched driver registration is more
/// likely to misbehave than to succeed.
fn should_attempt_msr_mod(plan: &HashrateFixPlan) -> bool {
    plan.blocklist_off && plan.hvci_off && plan.winring0_collision.is_none()
}

/// Refresh the MSR environment scan (or return cache when force=false and cache is fresh).
/// Cache is considered fresh for the lifetime of the app session.
#[tauri::command]
pub async fn scan_msr_environment(
    app: AppHandle,
    force: bool,
) -> Result<HashrateFixPlan, String> {
    let plan = get_env_scan(&app, force).await?;
    crate::emit_meter::bump("msr-env-scan");
    let _ = app.emit("msr-env-scan", plan.clone());
    Ok(plan)
}

/// Read-only access to the cached env scan. Returns None if no scan has run yet.
#[tauri::command]
pub fn get_msr_environment(app: AppHandle) -> Result<Option<HashrateFixPlan>, String> {
    let cache = app.state::<MsrEnvCache>();
    let read = cache.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(read.clone())
}

#[cfg(test)]
mod msr_gate_tests {
    use super::{should_attempt_msr_mod, HashrateFixPlan};

    fn clean_plan() -> HashrateFixPlan {
        HashrateFixPlan {
            blocklist_off: true,
            hvci_off: true,
            winring0_collision: None,
            ..Default::default()
        }
    }

    #[test]
    fn attempts_when_environment_is_clean() {
        assert!(should_attempt_msr_mod(&clean_plan()));
    }

    #[test]
    fn skips_when_vulnerable_driver_blocklist_is_on() {
        let plan = HashrateFixPlan {
            blocklist_off: false,
            ..clean_plan()
        };
        assert!(!should_attempt_msr_mod(&plan));
    }

    #[test]
    fn skips_when_hvci_is_running() {
        // The real-world case this was added for: HVCI confirmed running,
        // MSR writes confirmed rejected on every session.
        let plan = HashrateFixPlan {
            hvci_off: false,
            ..clean_plan()
        };
        assert!(!should_attempt_msr_mod(&plan));
    }

    #[test]
    fn skips_on_winring0_service_collision() {
        let plan = HashrateFixPlan {
            winring0_collision: Some(r"C:\Other\App\WinRing0x64.sys".to_string()),
            ..clean_plan()
        };
        assert!(!should_attempt_msr_mod(&plan));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// xmrig.log tail + parser
//
// Spawned by start_xmrig after the elevated process is running. Polls the
// log file every 250ms, parses new lines for the failure-mode taxonomy from
// the research file, emits structured `hashrate-fix-status` events.
// Stops when MinerPid goes to None (xmrig has exited).
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HashrateFixStatus {
    pub msr: Option<MsrLogStatus>,
    pub huge_pages: Option<HugePagesStatus>,
    pub ready: Option<ReadyStatus>,
    pub raw_line: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MsrLogStatus {
    Ok { preset: String },
    Failed { reason: String, raw: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HugePagesStatus {
    pub allocated: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyStatus {
    pub threads_active: u32,
    pub threads_total: u32,
}

/// Map a single line of xmrig stdout to a HashrateFixStatus update, if any.
fn parse_xmrig_line(line: &str) -> Option<HashrateFixStatus> {
    let lower = line.to_ascii_lowercase();
    let raw_line = Some(line.to_string());

    // MSR success: `msr register values for "intel": ...` (or ryzen_17h, ryzen_19h, ryzen_1Ah_zen5)
    if let Some(idx) = lower.find("msr register values for") {
        let tail = &line[idx..];
        // Extract preset name from quoted field; fall back to a slice if absent
        let preset = tail
            .split('"')
            .nth(1)
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Some(HashrateFixStatus {
            msr: Some(MsrLogStatus::Ok { preset }),
            raw_line,
            ..Default::default()
        });
    }

    // WinRing0 driver load failures
    if let Some(idx) = lower.find("failed to start winring0 driver") {
        let tail = &line[idx..];
        let err_code = tail
            .split("error")
            .nth(1)
            .and_then(|s| s.trim_start_matches([' ', ':']).split_whitespace().next())
            .unwrap_or("?")
            .to_string();
        let reason = match err_code.as_str() {
            "5" => "not_admin".to_string(),
            "183" => "service_collision".to_string(),
            "1275" | "577" | "395" => "blocklist_hit".to_string(),
            _ => "driver_load_failed".to_string(),
        };
        return Some(HashrateFixStatus {
            msr: Some(MsrLogStatus::Failed {
                reason,
                raw: line.to_string(),
            }),
            raw_line,
            ..Default::default()
        });
    }

    // WRMSR rejected: `cannot set MSR 0xc0011020 to 0x...`
    if lower.contains("cannot set msr 0x") {
        return Some(HashrateFixStatus {
            msr: Some(MsrLogStatus::Failed {
                reason: "wrmsr_rejected".to_string(),
                raw: line.to_string(),
            }),
            raw_line,
            ..Default::default()
        });
    }

    // Generic MSR failure
    if lower.contains("failed to apply msr mod") {
        return Some(HashrateFixStatus {
            msr: Some(MsrLogStatus::Failed {
                reason: "unknown_failure".to_string(),
                raw: line.to_string(),
            }),
            raw_line,
            ..Default::default()
        });
    }

    // Huge pages: `huge pages: 1280/1280 100% (4 pages)` or similar
    if let Some(idx) = lower.find("huge pages") {
        let tail = &line[idx..];
        if let Some(stats) = tail.split_whitespace().find(|tok| tok.contains('/')) {
            let mut split = stats.split('/');
            if let (Some(a), Some(b)) = (split.next(), split.next()) {
                if let (Ok(allocated), Ok(total)) = (a.parse::<u64>(), b.parse::<u64>()) {
                    return Some(HashrateFixStatus {
                        huge_pages: Some(HugePagesStatus { allocated, total }),
                        raw_line,
                        ..Default::default()
                    });
                }
            }
        }
    }

    // READY: `READY (CPU) threads N/M ...`
    if let Some(idx) = lower.find("ready (cpu) threads") {
        let tail = &line[idx..];
        if let Some(stats) = tail.split_whitespace().find(|tok| tok.contains('/')) {
            let mut split = stats.split('/');
            if let (Some(a), Some(b)) = (split.next(), split.next()) {
                if let (Ok(active), Ok(total)) = (a.parse::<u32>(), b.parse::<u32>()) {
                    return Some(HashrateFixStatus {
                        ready: Some(ReadyStatus {
                            threads_active: active,
                            threads_total: total,
                        }),
                        raw_line,
                        ..Default::default()
                    });
                }
            }
        }
    }

    None
}

/// Spawn the log-tail task. Returns immediately. The task lives until either
/// the file stops growing for a sustained period OR the MinerPid clears.
fn spawn_log_tail_task(app: AppHandle, log_path: PathBuf) {
    tokio::spawn(async move {
        let mut byte_pos: u64 = 0;
        let mut idle_polls: u32 = 0;
        let max_idle_polls: u32 = 240; // 240 * 250ms = 60s of no-growth → exit
        let mut leftover: String = String::new();

        loop {
            // Stop when MinerPid clears (xmrig stopped)
            let pid_present = {
                if let Some(pid_state) = app.try_state::<MinerPid>() {
                    if let Ok(guard) = pid_state.0.lock() {
                        guard.is_some()
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            if !pid_present && byte_pos > 0 {
                break;
            }

            // Stat the file, read new bytes
            let metadata = std::fs::metadata(&log_path);
            let size = metadata.map(|m| m.len()).unwrap_or(0);

            if size > byte_pos {
                idle_polls = 0;
                if let Ok(mut file) = std::fs::File::open(&log_path) {
                    use std::io::{Read, Seek, SeekFrom};
                    if file.seek(SeekFrom::Start(byte_pos)).is_ok() {
                        let mut buf = Vec::with_capacity((size - byte_pos) as usize);
                        if file.read_to_end(&mut buf).is_ok() {
                            byte_pos = size;
                            let chunk = String::from_utf8_lossy(&buf).to_string();
                            leftover.push_str(&chunk);
                            // Process complete lines; keep partial trailing line
                            while let Some(nl_pos) = leftover.find('\n') {
                                let line = leftover[..nl_pos].trim_end_matches('\r').to_string();
                                leftover = leftover[nl_pos + 1..].to_string();
                                if let Some(status) = parse_xmrig_line(&line) {
                                    crate::emit_meter::bump("hashrate-fix-status");
                                    let _ = app.emit("hashrate-fix-status", status);
                                }
                            }
                        }
                    }
                }
            } else {
                idle_polls += 1;
                if idle_polls >= max_idle_polls && !pid_present {
                    break;
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard Reset
//
// Single elevated batch (one UAC) that clears the WinRing0 collision,
// refreshes Defender exclusions, and grants SeLockMemoryPrivilege. Used by
// the user-facing "Hard Reset Driver State" button in the HashrateFixPanel
// when something has gone wrong out-of-band (Defender ate a file, OS
// upgrade nuked a setting, prior uninstall left orphan state).
// ─────────────────────────────────────────────────────────────────────────────

const HARD_RESET_SCRIPT: &str = include_str!("msr-hard-reset.ps1");

/// Run the Hard Reset elevated batch and return the freshly re-scanned
/// environment. One UAC consent total. Errors include UAC declined or
/// elevated script exit non-zero (rare since the script is best-effort).
#[tauri::command]
pub async fn msr_hard_reset(app: AppHandle) -> Result<HashrateFixPlan, String> {
    let miners_dir = get_miners_dir(&app)?;

    // Write the Hard Reset PowerShell script to the miners directory
    let script_path = miners_dir.join("_hard_reset.ps1");
    std::fs::write(&script_path, HARD_RESET_SCRIPT)
        .map_err(|e| format!("Failed to write hard-reset script: {}", e))?;

    let script_path_str = script_path.to_string_lossy().to_string();
    let miners_dir_str = miners_dir.to_string_lossy().to_string();

    // Same pattern as add_defender_exclusions: outer hidden powershell launches
    // an elevated child via Start-Process -Verb RunAs -Wait. The -Wait makes
    // the entire chain synchronous from Rust's perspective, so by the time
    // .output().await returns, the elevated script has fully completed.
    let elevate_cmd_str = format!(
        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-ExecutionPolicy','Bypass','-NoProfile','-File','{}','-MinersDir','{}')",
        script_path_str.replace('\'', "''"),
        miners_dir_str.replace('\'', "''")
    );

    let mut elevate_cmd = hidden_powershell_command();
    elevate_cmd.args(["-Command", &elevate_cmd_str]);
    let output = elevate_cmd
        .output()
        .await
        .map_err(|e| format!("Hard Reset: failed to invoke powershell: {}", e))?;

    // Clean up the deployed script
    let _ = std::fs::remove_file(&script_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        // Detect the common "user declined UAC" case
        let combined = format!("{}{}", stderr, stdout);
        if combined.contains("cancelled") || combined.contains("canceled") || combined.contains("1223") {
            return Err(
                "UAC was declined. Hard Reset requires admin privileges to clear \
                 the WinRing0 driver, refresh exclusions, and grant the \
                 huge-pages privilege."
                    .to_string(),
            );
        }
        return Err(format!(
            "Hard Reset script exited non-zero (code {:?}). stderr: {} | stdout: {}",
            output.status.code(),
            stderr,
            stdout
        ));
    }

    // Refresh the env scan cache so the UI reflects the new state immediately
    let plan = scan_msr_environment(app, true).await?;
    Ok(plan)
}

/// Normalize a user-supplied SOCKS5 proxy string into `host:port`. Strips
/// any `socks5://` / `socks://` scheme. Returns None on malformed input so
/// callers can decide whether to surface an error or silently skip.
fn normalize_socks_proxy(s: &str) -> Option<String> {
    let stripped = s
        .trim()
        .trim_start_matches("socks5://")
        .trim_start_matches("socks://");
    let (host, port_str) = stripped.rsplit_once(':')?;
    let _: u16 = port_str.parse().ok()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{}:{}", host, port_str))
}

#[cfg(test)]
mod gpu_device_map_tests {
    use super::*;
    use crate::device_info::GpuInfo;

    fn gpu(name: &str, vendor: &str) -> GpuInfo {
        GpuInfo {
            name: name.to_string(),
            vendor: vendor.to_string(),
            vram_bytes: 8 << 30,
            driver_version: String::new(),
        }
    }

    /// Verbatim (ANSI and all colour stripped by the capture) from the dev box,
    /// SRBMiner-MULTI 3.6.2 `--list-devices`, 2026-09-16.
    const SRB: &str = "\u{1b}[1;37mOPENCL devices\u{1b}[0m
GPU0  [0][0] [06:00.0] : amd_radeon_rx_6700_xt [gfx1031] [12272 MB] [CU: 40] [MaxBuf: 12272 MB]
CUDA devices
GPU1  [CUDA][0] [0000:01:00.0] : nvidia_geforce_rtx_5060_ti [blackwell] [CC: 12.0] [SM: 36] [16310 MB]
";

    /// Verbatim, lolMiner 1.98a `--list-devices`, same box and day.
    const LOL: &str = "OpenCL driver detected. Number of OpenCL supported GPUs: 1
Cuda driver detected. Number of Cuda supported GPUs: 1
Device 0:
    Name:    NVIDIA GeForce RTX 5060 Ti
    Address: 1:0
    Vendor:  NVIDIA Corporation
    Drivers: Cuda
    Memory:  16310 MByte
Device 1:
    Name:    Radeon RX 6700XT
    Address: 6:0
    Vendor:  Advanced Micro Devices (AMD)
    Drivers: OpenCL
    Memory:  12272 MByte (12257 MByte free)
";

    /// The operator's machine as `get_gpu_info` lists it: 5060 Ti first.
    fn app() -> Vec<GpuInfo> {
        vec![gpu("NVIDIA GeForce RTX 5060 Ti", "nvidia"), gpu("AMD Radeon RX 6700 XT", "amd")]
    }

    #[test]
    fn both_device_lists_parse() {
        let srb = parse_srbminer_list_devices(SRB);
        assert_eq!(
            srb.iter().map(|d| (d.id, d.vendor.as_str())).collect::<Vec<_>>(),
            [(0, "amd"), (1, "nvidia")]
        );
        let lol = parse_lolminer_list_devices(LOL);
        assert_eq!(
            lol.iter().map(|d| (d.id, d.vendor.as_str())).collect::<Vec<_>>(),
            [(0, "nvidia"), (1, "amd")]
        );
    }

    #[test]
    fn model_keys_agree_across_the_three_spellings() {
        assert_eq!(gpu_model_key("NVIDIA GeForce RTX 5060 Ti"), "rtx5060ti");
        assert_eq!(gpu_model_key("nvidia_geforce_rtx_5060_ti"), "rtx5060ti");
        assert_eq!(gpu_model_key("AMD Radeon RX 6700 XT"), "rx6700xt");
        assert_eq!(gpu_model_key("amd_radeon_rx_6700_xt"), "rx6700xt");
        assert_eq!(gpu_model_key("Radeon RX 6700XT"), "rx6700xt");
    }

    /// THE reported bug: app GPU 0 is the 5060 Ti, which is SRBMiner's GPU1.
    #[test]
    fn the_5060_ti_is_srbminer_gpu1_and_lolminer_device0() {
        let srb = parse_srbminer_list_devices(SRB);
        let lol = parse_lolminer_list_devices(LOL);
        assert_eq!(map_gpu_indices_to_miner(&app(), &[0], &srb).unwrap(), vec![1]);
        assert_eq!(map_gpu_indices_to_miner(&app(), &[1], &srb).unwrap(), vec![0]);
        assert_eq!(map_gpu_indices_to_miner(&app(), &[0], &lol).unwrap(), vec![0]);
        assert_eq!(map_gpu_indices_to_miner(&app(), &[1], &lol).unwrap(), vec![1]);
        assert_eq!(map_gpu_indices_to_miner(&app(), &[0, 1], &srb).unwrap(), vec![1, 0]);
        // The old behaviour — the index verbatim — is exactly what went wrong.
        assert_ne!(map_gpu_indices_to_miner(&app(), &[0], &srb).unwrap(), vec![0]);
    }

    #[test]
    fn an_integrated_gpu_in_the_app_list_does_not_shift_the_mapping() {
        let app = vec![
            gpu("AMD Radeon(TM) Graphics", "amd"),
            gpu("NVIDIA GeForce RTX 5060 Ti", "nvidia"),
            gpu("AMD Radeon RX 6700 XT", "amd"),
        ];
        let srb = parse_srbminer_list_devices(SRB);
        assert_eq!(map_gpu_indices_to_miner(&app, &[1], &srb).unwrap(), vec![1]);
        assert_eq!(map_gpu_indices_to_miner(&app, &[2], &srb).unwrap(), vec![0]);
    }

    #[test]
    fn identical_cards_map_in_order() {
        let app = vec![gpu("NVIDIA GeForce RTX 3070", "nvidia"), gpu("NVIDIA GeForce RTX 3070", "nvidia")];
        let devs = vec![
            MinerGpuDevice { id: 0, name: "nvidia_geforce_rtx_3070".into(), vendor: "nvidia".into() },
            MinerGpuDevice { id: 1, name: "nvidia_geforce_rtx_3070".into(), vendor: "nvidia".into() },
        ];
        assert_eq!(map_gpu_indices_to_miner(&app, &[1], &devs).unwrap(), vec![1]);
        assert_eq!(map_gpu_indices_to_miner(&app, &[0, 1], &devs).unwrap(), vec![0, 1]);
    }

    #[test]
    fn linux_pci_names_match_by_containment_or_vendor_order() {
        // lspci-style name carrying the chip code.
        let app = vec![gpu("AD106 [GeForce RTX 4060 Ti]", "nvidia"), gpu("Navi 22 [Radeon RX 6700 XT]", "amd")];
        let devs = vec![
            MinerGpuDevice { id: 0, name: "amd_radeon_rx_6700_xt".into(), vendor: "amd".into() },
            MinerGpuDevice { id: 1, name: "nvidia_geforce_rtx_4060_ti".into(), vendor: "nvidia".into() },
        ];
        assert_eq!(map_gpu_indices_to_miner(&app, &[0], &devs).unwrap(), vec![1]);
        assert_eq!(map_gpu_indices_to_miner(&app, &[1], &devs).unwrap(), vec![0]);
        // A bare chip name with no model: one card of that vendor on each side.
        let app2 = vec![gpu("Device 2803", "nvidia")];
        assert_eq!(map_gpu_indices_to_miner(&app2, &[0], &devs).unwrap(), vec![1]);
    }

    #[test]
    fn a_5060_is_not_taken_for_a_5060_ti() {
        let app = vec![gpu("NVIDIA GeForce RTX 5060", "nvidia"), gpu("NVIDIA GeForce RTX 5060 Ti", "nvidia")];
        let devs = vec![
            MinerGpuDevice { id: 0, name: "nvidia_geforce_rtx_5060_ti".into(), vendor: "nvidia".into() },
            MinerGpuDevice { id: 1, name: "nvidia_geforce_rtx_5060".into(), vendor: "nvidia".into() },
        ];
        assert_eq!(map_gpu_indices_to_miner(&app, &[0], &devs).unwrap(), vec![1]);
        assert_eq!(map_gpu_indices_to_miner(&app, &[1], &devs).unwrap(), vec![0]);
    }

    #[test]
    fn an_unmatchable_selection_refuses_instead_of_guessing() {
        let srb = parse_srbminer_list_devices(SRB);
        let app = vec![gpu("Intel(R) Arc(TM) A770 Graphics", "intel")];
        let err = map_gpu_indices_to_miner(&app, &[0], &srb).unwrap_err();
        assert!(err.contains("could not find the selected GPU"), "{err}");
        assert!(map_gpu_indices_to_miner(&app, &[5], &srb).is_err(), "out of range");
    }

    /// Both start paths translate before they build any argv.
    #[test]
    fn both_gpu_start_paths_translate_the_selection() {
        let src = include_str!("miners.rs");
        let start = &src[src.find("pub async fn start_gpu_miner(").unwrap()..];
        let start = &start[..start.find("build_and_spawn_gpu_miner(").unwrap()];
        assert!(start.contains("resolve_miner_gpu_ids("));
        let bench = &src[src.find("pub async fn run_gpu_miner_benchmark(").unwrap()..];
        let bench = &bench[..bench.find("\"--benchmark\"").unwrap()];
        assert!(bench.contains("resolve_miner_gpu_ids("));
    }
}
