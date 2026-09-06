//! Safety-incident telemetry — local-only JSONL log.
//!
//! When a `SafetyInvariantError` fires in the swap pipeline (see
//! `src/features/swap/safety-invariants.ts`), the TS layer invokes
//! `swap_log_safety_incident` to append a one-line JSON record to
//! `%LOCALAPPDATA%\com.tauri-eth-wallet\safety-incidents.jsonl`. Users
//! can attach this file when reporting bugs.
//!
//! Hard rules:
//!   - **Local only.** This module never reads from / writes to network.
//!   - **Best-effort.** A failed log call must NOT block the UI's error
//!     banner — the TS caller wraps invocation in try/catch. The Rust
//!     side returns Ok(()) on disk write failure rather than surfacing
//!     the I/O error (which would just be unhelpful noise to the user).
//!   - **Append-only.** Every call APPENDS one line; nothing reads,
//!     truncates, or rotates the file. If the user wants to clear it,
//!     they delete the file manually. (Future: surface a "clear" button
//!     in Settings if the file grows beyond a few hundred KB.)
//!
//! File location: per Tauri convention, app-local data goes under
//! `dirs::data_local_dir()` (Windows: `%LOCALAPPDATA%`, macOS:
//! `~/Library/Application Support`, Linux: `~/.local/share`). We
//! hardcode the bundle id `com.tauri-eth-wallet` to match `tauri.conf.json`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
fn local_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

#[cfg(not(target_os = "windows"))]
fn local_data_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            p.push("Library");
            p.push("Application Support");
        } else {
            p.push(".local");
            p.push("share");
        }
        return Some(p);
    }
    None
}

/// Resolve the safety-incidents log path:
///   `<local_data_dir>/com.tauri-eth-wallet/safety-incidents.jsonl`
fn incident_log_path() -> Option<PathBuf> {
    let mut base = local_data_dir()?;
    base.push("com.tauri-eth-wallet");
    Some(base.join("safety-incidents.jsonl"))
}

/// Append a JSON record (already serialized by the TS layer) to the
/// incident log. Returns Ok on success or any best-effort skip;
/// surfaces an error string only on JSON-shape problems the caller
/// should know about.
#[tauri::command]
pub async fn swap_log_safety_incident(record: String) -> Result<(), String> {
    let trimmed = record.trim();
    if trimmed.is_empty() {
        return Err("safety-incident record is empty".into());
    }
    // Quick shape check: must be a valid JSON object (starts with `{`).
    // We don't fully parse — just defend against accidental binary garbage.
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Err("safety-incident record is not a JSON object".into());
    }

    let path = match incident_log_path() {
        Some(p) => p,
        None => {
            // Best-effort: no resolvable home dir → silently skip rather
            // than fail the call. The UI's banner has already rendered
            // the error message; missing log is acceptable degradation.
            return Ok(());
        }
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let line = format!("{}\n", trimmed);
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
    {
        Ok(_) => Ok(()),
        // Disk full / permissions / device-busy — also best-effort.
        // We do NOT bubble up because the caller (a UI event handler
        // already showing an error banner) gains nothing from a second
        // error stack and the user has zero remediation path.
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_non_json_input() {
        let err = swap_log_safety_incident("not-json".to_string()).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn rejects_empty_input() {
        let err = swap_log_safety_incident("".to_string()).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn accepts_valid_json_object() {
        let r = swap_log_safety_incident("{\"invariant\":\"TEST\"}".to_string()).await;
        // Either Ok (normal write) or silent-Ok (no LOCALAPPDATA in test env).
        // Both shapes produce Ok — the only Err path is malformed input.
        assert!(r.is_ok());
    }
}
