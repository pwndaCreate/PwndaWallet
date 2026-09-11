//! Cross-platform helpers for OS-specific operations.
//!
//! Centralizes the `#[cfg(target_os = "...")]` sprawl that would otherwise live
//! inline in every consumer module. Compiled into every variant (full + lite).
//!
//! See `PwndaWalletVault/wiki/synthesis/linux-port-plan.md` §3.1 and the
//! implementation-status tracker for the current Linux-branch state of every
//! call site.

#![allow(dead_code)]

/// Platform-specific binary suffix (".exe" on Windows, "" elsewhere).
///
/// Use when building miner / sidecar binary names so the same code resolves
/// `xmrig.exe` on Windows and `xmrig` on Linux without scattering `#[cfg]`s.
pub const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

/// Apply OS-specific spawn flags. On Windows: `CREATE_NO_WINDOW` to suppress
/// the console flash for sidecar processes. On Linux/macOS: no-op.
///
/// `tokio::process::Command` exposes `creation_flags` as an inherent method on
/// Windows targets — the `CommandExt` trait import is not required here.
pub fn apply_hidden_spawn(_cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Same as `apply_hidden_spawn` but for `std::process::Command` (sync API).
pub fn apply_hidden_spawn_sync(_cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Force-kill a process by PID.
/// - Windows: `taskkill /F /T /PID <pid>`.
/// - Unix: `kill -9 <pid>`.
///
/// Returns `Ok(())` even if the process didn't exist — caller treats this as
/// idempotent cleanup.
pub async fn kill_pid_force(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        apply_hidden_spawn(&mut cmd);
        cmd.output().await.map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(unix)]
    {
        use tokio::process::Command;
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Enumerate PIDs whose process image matches `image_name`.
/// - Windows: `tasklist /FI "IMAGENAME eq <name>" /FO CSV /NH`. The image
///   name must include the `.exe` suffix on Windows.
/// - Unix: `pgrep -x <name>`. The name must NOT include any suffix.
///
/// Callers that need cross-platform image-name matching should construct the
/// query with `EXE_SUFFIX`.
pub async fn pids_for_image(image_name: &str) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let mut cmd = Command::new("tasklist");
        cmd.args([
            "/FI",
            &format!("IMAGENAME eq {}", image_name),
            "/FO",
            "CSV",
            "/NH",
        ]);
        apply_hidden_spawn(&mut cmd);
        let out = cmd.output().await.map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut pids = Vec::new();
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 2 {
                let pid_str = parts[1].trim_matches('"');
                if let Ok(pid) = pid_str.parse::<u32>() {
                    pids.push(pid);
                }
            }
        }
        Ok(pids)
    }
    #[cfg(unix)]
    {
        use tokio::process::Command;
        let out = Command::new("pgrep")
            .arg("-x")
            .arg(image_name)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect())
    }
}

/// Best-effort process image name for a PID — the executable's file name,
/// e.g. `monero-wallet-rpc.exe` / `monero-wallet-rpc` — or `None` if the PID
/// is not running.
///
/// - Windows: `tasklist /FI "PID eq N" /FO CSV /NH`. Keyed on the CSV format,
///   not the line position: `tasklist` writes its no-match notice to STDOUT and
///   `/NH` does not suppress it, so a dead PID once came back as
///   `Some("INFO: No tasks are running…")` — "alive, with a name that matches
///   nothing" — and the swap sidecar's W-6 ownership gate then left our own
///   orphan running (P3, 2026-08-18 — the record follows).
/// - Unix: the basename of argv[0] from `/proc/<pid>/cmdline`, falling back to
///   the basename of `readlink /proc/<pid>/exe`. **argv[0] first, on purpose**:
///   the swap node is launched as `<runtime>/bin/python`, a symlink to
///   `python3.12`, and three callers compare this against exactly
///   `format!("python{EXE_SUFFIX}")` — resolving the symlink would make our own
///   node look like a stranger. Never `/proc/<pid>/comm`: the kernel truncates
///   it to 15 bytes, so `monero-wallet-rpc` reads as `monero-wallet-r`.
///
/// A dead PID answers `None` on both platforms; a wrong `Some` here is what
/// turns a kill-guard into an orphan leak.
///
/// # A dead PID must return `None`, and once did not (P3, 2026-08-18)
///
/// `tasklist` writes its no-match notice to **stdout**, not stderr, and `/NH`
/// does not suppress it:
///
/// ```text
/// INFO: No tasks are running which match the specified criteria.
/// ```
///
/// The old body took `stdout.lines().next()`, split it on `,` and returned the
/// whole sentence as an image name — so *every* dead PID came back as
/// `Some("INFO: No tasks are running which match the specified criteria.")`,
/// i.e. "still alive", with a name that matches nothing. Found by the swap
/// sidecar's first live integration run, whose post-shutdown orphan sweep
/// reported the python parent as an orphan seconds after `tasklist` had
/// confirmed it gone.
///
/// It is not a cosmetic bug: `swap_sidecar::reconcile_stale_instance`'s W-6
/// ownership gate compares this against `python.exe` to decide whether the
/// port-holder is our own node. A garbage name fails that comparison, so
/// `terminate_pid` is cleared and OUR OWN orphan is left running — the exact
/// leak W-6 was written to avoid.
///
/// The fix keys on the format instead of the position: `/FO CSV` quotes every
/// field, so a real row always begins with `"`, and the notice never does.
/// (Record moved here from `wallet_rpc_common` with the body, 2026-09-06.)
pub async fn pid_image_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"]);
        apply_hidden_spawn(&mut cmd);
        let output = cmd.output().await.ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // A real CSV row always begins with a quote; the no-match notice never does.
        let line = stdout.lines().map(|l| l.trim()).find(|l| l.starts_with('"'))?;
        let first = line.split(',').next()?;
        let trimmed = first.trim().trim_matches('"');
        if trimmed.is_empty() {
            return None;
        }
        Some(trimmed.to_string())
    }
    #[cfg(unix)]
    {
        let proc_dir = std::path::PathBuf::from(format!("/proc/{pid}"));
        if !proc_dir.exists() {
            return None;
        }
        if let Ok(cmdline) = tokio::fs::read(proc_dir.join("cmdline")).await {
            if let Some(argv0) = cmdline.split(|b| *b == 0).next() {
                if let Some(name) = image_from_exe_path(&String::from_utf8_lossy(argv0)) {
                    return Some(name);
                }
            }
        }
        let target = tokio::fs::read_link(proc_dir.join("exe")).await.ok()?;
        image_from_exe_path(&target.to_string_lossy())
    }
}

/// The PID listening on a local TCP `port`, if any.
///
/// - Windows: `netstat -ano -p TCP`, LISTENING rows on `127.0.0.1:<port>` or
///   `[::1]:<port>`; the last token is the PID.
/// - Unix: `/proc/net/tcp` + `/proc/net/tcp6` for a socket in LISTEN (`0A`) on
///   that port — ANY local address, because a stranger on `0.0.0.0:<port>`
///   blocks our `127.0.0.1:<port>` bind just as surely — then the owner via
///   `/proc/<pid>/fd/*` → `socket:[<inode>]`. No external binary: `ss` and
///   `lsof` are not guaranteed on an AppImage's host.
///
/// # Windows notes (moved from `wallet_rpc_common` with the body, 2026-09-06)
///
/// Used as a last-resort cleanup path when the image-name-based taskkill
/// fails (returns code 1 — Windows is inconsistent about this; sometimes
/// it's "no match", sometimes "access denied", sometimes "process still
/// in TASK_TERMINATING state"). With the PID in hand we can issue a
/// blunter `taskkill /F /PID <n>` that often succeeds where the
/// image-filtered call did not.
///
/// Sample netstat output line:
///   `  TCP    127.0.0.1:18083        0.0.0.0:0              LISTENING       12345`
pub async fn find_pid_holding_port(port: u16) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let mut cmd = Command::new("netstat");
        cmd.args(["-ano", "-p", "TCP"]);
        apply_hidden_spawn(&mut cmd);
        let output = cmd.output().await.ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let needle_v4 = format!("127.0.0.1:{}", port);
        let needle_v6 = format!("[::1]:{}", port);
        for line in stdout.lines() {
            if !line.contains("LISTENING") {
                continue;
            }
            if !line.contains(&needle_v4) && !line.contains(&needle_v6) {
                continue;
            }
            if let Some(pid_str) = line.split_whitespace().last() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    return Some(pid);
                }
            }
        }
        None
    }
    #[cfg(unix)]
    {
        let mut inodes: Vec<u64> = Vec::new();
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(text) = std::fs::read_to_string(table) {
                inodes.extend(listen_inodes_for_port(&text, port));
            }
        }
        if inodes.is_empty() {
            return None;
        }
        let needles: Vec<String> = inodes.iter().map(|i| format!("socket:[{i}]")).collect();
        let procs = std::fs::read_dir("/proc").ok()?;
        for entry in procs.flatten() {
            let name = entry.file_name();
            let Ok(pid) = name.to_string_lossy().parse::<u32>() else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                if let Ok(link) = std::fs::read_link(fd.path()) {
                    let l = link.to_string_lossy();
                    if needles.iter().any(|n| *n == l) {
                        return Some(pid);
                    }
                }
            }
        }
        None
    }
}

/// Force-kill `pid` only if its image is exactly `image_name`, so a recycled
/// PID can never take down an unrelated process (a user's own
/// `monero-wallet-rpc` while we clean up our Zephyr sidecar, say).
///
/// Returns `taskkill`'s convention on both platforms, because callers read it:
/// **0 = killed, 128 = no such process / image did not match.**
/// - Windows: `taskkill /PID <pid> /FI "IMAGENAME eq <image>" /F`.
/// - Unix: [`pid_image_name`] must equal `image_name` exactly, then `kill -9`.
///
/// # Windows notes (moved from `wallet_rpc_common` with the body, 2026-09-06)
///
/// Kill a specific PID only if it's currently running `image_name`.
///
/// `/FI "IMAGENAME eq <image_name>"` makes taskkill a no-op if the PID has
/// been recycled to an unrelated process — stale pidfiles pointing at a
/// reused PID can never accidentally kill something the user cares about
/// (e.g. a Feather-wallet or Monero-GUI `monero-wallet-rpc.exe` when we're
/// cleaning up our own Zephyr sidecar).
///
/// Returns the taskkill exit code (0 = killed, 128 = no match, other = error).
pub async fn kill_process_by_pid_and_image(pid: u32, image_name: &str) -> Result<i32, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let mut cmd = Command::new("taskkill");
        cmd.args([
            "/PID",
            &pid.to_string(),
            "/FI",
            &format!("IMAGENAME eq {}", image_name),
            "/F",
        ]);
        apply_hidden_spawn(&mut cmd);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("taskkill spawn failed: {}", e))?;
        Ok(output.status.code().unwrap_or(-1))
    }
    #[cfg(unix)]
    {
        match pid_image_name(pid).await {
            Some(img) if img == image_name => kill_pid_force(pid).await.map(|_| 0),
            _ => Ok(128),
        }
    }
}

/// Basename of an executable path as `/proc` reports it, or `None` if empty.
/// Strips the ` (deleted)` suffix `readlink /proc/<pid>/exe` appends once the
/// binary on disk has been replaced — a node whose Python was upgraded
/// underneath it is still our node.
fn image_from_exe_path(path: &str) -> Option<String> {
    let p = path.trim();
    let p = p.strip_suffix(" (deleted)").unwrap_or(p);
    let base = p.rsplit('/').next().unwrap_or(p).trim();
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

/// Inodes of sockets in LISTEN state on `port`, from the text of
/// `/proc/net/tcp` or `/proc/net/tcp6`.
///
/// Row shape (header skipped): `sl local_address rem_address st … inode`, with
/// `local_address` as `HEXADDR:HEXPORT` and `st` `0A` meaning LISTEN. The
/// inode is the 10th whitespace field.
fn listen_inodes_for_port(text: &str, port: u16) -> Vec<u64> {
    let want = format!("{:04X}", port);
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                return None;
            }
            let hex_port = f[1].rsplit(':').next()?;
            if !hex_port.eq_ignore_ascii_case(&want) {
                return None;
            }
            f[9].parse::<u64>().ok()
        })
        .collect()
}

#[cfg(test)]
mod proc_parsers {
    use super::*;

    /// `/proc/<pid>/exe` shapes, including the post-upgrade one.
    #[test]
    fn image_name_is_the_basename_and_survives_a_replaced_binary() {
        assert_eq!(image_from_exe_path("/opt/grove/bin/python3.12").as_deref(), Some("python3.12"));
        assert_eq!(
            image_from_exe_path("/opt/grove/bin/monero-wallet-rpc (deleted)").as_deref(),
            Some("monero-wallet-rpc")
        );
        assert_eq!(image_from_exe_path("python").as_deref(), Some("python"));
        assert_eq!(image_from_exe_path(""), None);
        assert_eq!(image_from_exe_path("   "), None);
    }

    /// A LISTEN row on the port is found on any local address; an ESTABLISHED
    /// row on the same port is not; other ports are not.
    #[test]
    fn listen_sockets_are_picked_by_port_and_state_only() {
        // 12800 = 0x3200. Real column layout from a Linux 6.x kernel.
        let tcp = concat!(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
            "   0: 0100007F:3200 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0\n",
            "   1: 0100007F:3200 0100007F:A3F2 01 00000000:00000000 00:00000000 00000000  1000        0 41999 1 0000000000000000 20 4 30 10 -1\n",
            "   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55555 1 0000000000000000 100 0 0 10 0\n",
        );
        assert_eq!(listen_inodes_for_port(tcp, 12800), vec![41234]);
        assert_eq!(listen_inodes_for_port(tcp, 8080), vec![55555]);
        assert!(listen_inodes_for_port(tcp, 1).is_empty());
        // tcp6, any-address bind: still a conflict for our loopback bind.
        let tcp6 = concat!(
            "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
            "   0: 00000000000000000000000000000000:3200 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 77777 1 0000000000000000 100 0 0 10 0\n",
        );
        assert_eq!(listen_inodes_for_port(tcp6, 12800), vec![77777]);
    }
}

/// Probe Linux RandomX prerequisites. Used by the mining UI to show a
/// non-blocking "performance setup" hint when MSR / hugepages aren't
/// configured. Windows reports `(true, true)` because the equivalent setup
/// is handled by the existing elevated-spawn path.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct RandomxPrereqs {
    pub msr_available: bool,
    pub hugepages_configured: bool,
}

pub fn probe_randomx_prereqs() -> RandomxPrereqs {
    #[cfg(target_os = "linux")]
    {
        let msr_available = std::path::Path::new("/dev/cpu/0/msr").exists();
        let hugepages_configured = std::fs::read_to_string("/proc/sys/vm/nr_hugepages")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .map(|n| n >= 1280)
            .unwrap_or(false);
        RandomxPrereqs {
            msr_available,
            hugepages_configured,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        RandomxPrereqs {
            msr_available: true,
            hugepages_configured: true,
        }
    }
}

/// Whether this process is running from an AppImage.
///
/// The AppImage runtime exports `APPIMAGE` (absolute path to the .AppImage
/// file) and `APPDIR` into the child environment; nothing else sets them, so
/// this is a reliable positive test for "launched from an AppImage".
///
/// # Not the updater's question any more
///
/// This used to back `updater_can_self_install`, on the reasoning that Tauri
/// could self-replace an AppImage but must never overwrite apt/dnf-owned files
/// because doing so "corrupts the package database". That reasoning was wrong
/// — `tauri-plugin-updater` installs `.deb`/`.rpm` with `pkexec dpkg -i` /
/// `rpm -U`, which is exactly what apt runs underneath and is recorded in the
/// package database normally — and it is no longer used for that. The updater
/// now asks `tauri::utils::platform::bundle_type()`, which reads a marker the
/// BUNDLER stamps into each artifact rather than inferring from the
/// environment, and so answers for every format instead of one.
///
/// Kept because "am I an AppImage" is still a meaningful question with a
/// correct answer here; it simply is not the question the updater asks.
/// Always false on non-Linux.
pub fn is_appimage() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some()
}
