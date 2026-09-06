//! Monero wallet-rpc sidecar manager.
//!
//! Spawns the official `monero-wallet-rpc.exe` binary as a background child
//! process and proxies JSON-RPC calls to it from the frontend. All RPC calls
//! use per-session HTTP Digest authentication (random credentials generated at
//! startup) to prevent any other local process from accessing the wallet.
//!
//! Lifecycle:
//!   - `xmr_start_rpc(daemon_address)` — generates random credentials, launches
//!     the child with `--rpc-login user:pass`, pings until ready.
//!   - `xmr_rpc_call(method, params)` — forwards JSON-RPC with Digest auth.
//!   - `xmr_stop_rpc()` — graceful stop_wallet + kill child.
//!   - `xmr_rpc_is_running()` — state check for the frontend.
//!
//! Security notes:
//!   - `--rpc-login` is always passed; `--disable-rpc-login` is never used.
//!   - `--trusted-daemon` is only added for localhost/127.0.0.1 nodes.
//!     Remote nodes never receive the secret view key.
//!   - Port is bound to loopback only (`--rpc-bind-ip 127.0.0.1`).

use futures_util::StreamExt;
use md5::Md5;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Loopback port that monero-wallet-rpc binds to. Must match `xmr-rpc.ts`.
pub const XMR_RPC_PORT: u16 = 18082;

/// The port the CURRENT sidecar is actually bound to.
///
/// `XMR_RPC_PORT` above is the PREFERRED port, not a guarantee. 18082 is also
/// Monero's own default ZMQ-RPC port (mainnet P2P 18080 / RPC 18081 / ZMQ
/// 18081+1), so anyone running a local `monerod` already has it taken — and
/// that's exactly the run-your-own-node user a Monero wallet attracts. When the
/// preferred port is occupied we bind an ephemeral one instead of failing, and
/// record it here so call-time URL construction follows the spawn.
///
/// An atomic rather than Tauri state because `do_rpc_call` and friends are free
/// functions with no `AppHandle` in scope. Single-sidecar invariant makes a
/// single global correct: `xmr_start_rpc` is the only writer, and it stops any
/// previous instance before storing a new value.
static ACTIVE_XMR_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(XMR_RPC_PORT);

/// Port the running (or last-started) Monero sidecar is bound to.
pub fn active_xmr_port() -> u16 {
    ACTIVE_XMR_PORT.load(std::sync::atomic::Ordering::Relaxed)
}

fn set_active_xmr_port(port: u16) {
    ACTIVE_XMR_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
}

/// JSON-RPC endpoint for the running sidecar. Must be computed per call —
/// this used to be a `const` pinned to 18082, which silently became wrong the
/// moment the sidecar bound anywhere else.
fn xmr_rpc_url() -> String {
    format!("http://127.0.0.1:{}/json_rpc", active_xmr_port())
}

/// On-disk filename of the PRIMARY (first-imported) Monero wallet. Must
/// match `xmr-rpc.ts`'s `XMR_WALLET_FILENAME`. C9 shares only this wallet —
/// see `swap_sidecar::maybe_activate_xmr_host_wallet`'s doc comment for why
/// a per-wallet (Phase-2 multi-wallet) filename can't be shared instead.
pub const XMR_PRIMARY_WALLET_FILENAME: &str = "pwnda-active";

/// PWNDA-LEASE (C9): who currently wants the wallet-rpc process alive.
///
/// `xmr_start_rpc` starts the process when the lease set goes from empty to
/// non-empty; `xmr_stop_rpc` stops it only when a removal leaves the set
/// empty. Without this, two independent owners can't depend on the same
/// process — the user's own Monero session (`Session`) and the swap engine
/// under C9 (`SwapEngine`, which needs the process LISTENING, not
/// necessarily a wallet OPEN, so its startup probe succeeds even with the
/// vault locked) would each be able to kill the other's dependency by
/// calling stop. Every caller before C9 passes `Session`, so this is a
/// behaviour-preserving change on its own.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum XmrLease {
    /// The user's own Monero panel — started on vault unlock, released on
    /// Lock (see `useXmrSession`'s lock/forget split).
    Session,
    /// The swap engine's requirement that the process be listening for its
    /// startup probe and any main-wallet call. Acquired at swap-node start,
    /// released only once no bid is in flight.
    SwapEngine,
}

/// Per-session state: the running child process + per-session RPC credentials.
pub struct XmrRpcInner {
    pub child: Option<tokio::process::Child>,
    /// Random (username, password) generated fresh each time wallet-rpc starts.
    pub creds: Option<(String, String)>,
    /// PWNDA-LEASE: see [`XmrLease`]. Empty when no one wants the process
    /// alive — the state the struct starts in and returns to after a clean
    /// stop or a failed spawn.
    pub leases: std::collections::HashSet<XmrLease>,
    /// PWNDA-SINGLE-FLIGHT (2026-08-23): true from the moment a caller has
    /// committed to spawning a fresh process until that attempt resolves,
    /// success or failure. See `xmr_start_rpc`'s own doc for the incident
    /// this closes — two callers (the user's own Monero panel and the swap
    /// sidecar's C9 activation) racing on a fresh app boot, both reading
    /// `child: None` before either had set it, both spawning a competing
    /// monero-wallet-rpc.exe on the same port.
    pub starting: bool,
}

impl XmrRpcInner {
    /// Remove `lease` and report whether the CALLER should now actually
    /// stop the process. Pure — no I/O, no lock of its own (the caller
    /// already holds one) — so the lease arithmetic is unit-testable
    /// without spawning a real wallet-rpc child.
    ///
    /// `false` when nothing was running (there is nothing to stop) OR
    /// another lease still needs the process; `true` only when a process
    /// exists AND this was the last lease on it.
    pub fn release_lease(&mut self, lease: XmrLease) -> bool {
        self.leases.remove(&lease);
        self.child.is_some() && self.leases.is_empty()
    }
}

/// What a caller of `xmr_start_rpc` should do, given the state read under
/// ONE lock acquisition. Pure — no I/O, no lock of its own — so the
/// single-flight property (PWNDA-SINGLE-FLIGHT, 2026-08-23) is
/// unit-testable without an `AppHandle` or a real process. `xmr_start_rpc`
/// executes this decision; it does not re-derive it.
#[derive(Debug, PartialEq, Eq)]
pub enum XmrStartDecision {
    /// A process already exists — attach the lease, spawn nothing.
    AlreadyRunning,
    /// Another caller is mid-spawn — attach the lease and back off; the
    /// winner's success path will pick this lease up once `child` is set.
    AlreadyStarting,
    /// Neither running nor starting — this caller claims it and spawns.
    ShouldSpawn,
}

/// See [`XmrStartDecision`]. `child_running` and `starting` must both come
/// from the SAME lock acquisition — that atomicity is the entire point;
/// calling this twice under two separate locks reintroduces the race it
/// exists to close.
pub fn decide_xmr_start(child_running: bool, starting: bool) -> XmrStartDecision {
    if child_running {
        XmrStartDecision::AlreadyRunning
    } else if starting {
        XmrStartDecision::AlreadyStarting
    } else {
        XmrStartDecision::ShouldSpawn
    }
}

/// Tauri-managed state for the Monero wallet-rpc sidecar.
pub struct XmrRpcChild(pub Mutex<XmrRpcInner>);

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// Minimum file size (bytes) below which a file at the expected path is
/// considered a placeholder stub rather than the real binary. The actual
/// `monero-wallet-rpc.exe` is ~60 MB; a placeholder shipped in the repo
/// is a few hundred bytes. 5 MB is a comfortable threshold.
const REAL_BINARY_MIN_SIZE: u64 = 5 * 1024 * 1024;

/// Check whether a file exists and is large enough to plausibly be the
/// real monero-wallet-rpc.exe (not the repo placeholder).
fn is_real_binary(p: &PathBuf) -> bool {
    match std::fs::metadata(p) {
        Ok(meta) => meta.len() >= REAL_BINARY_MIN_SIZE,
        Err(_) => false,
    }
}

/// Platform-correct filename for the Monero wallet-rpc binary.
/// "monero-wallet-rpc.exe" on Windows, "monero-wallet-rpc" elsewhere.
fn monero_wallet_rpc_filename() -> String {
    format!("monero-wallet-rpc{}", crate::platform::EXE_SUFFIX)
}

/// Resolve the path to the Monero wallet-rpc binary.
///
/// Search order (2026-07-07 — app-data now comes FIRST):
///   1. `<app_data_dir>/monero/monero-wallet-rpc[.exe]` — the live copy: an
///      updater-refreshed, downloaded, or manually dropped binary. Checked
///      first so a NEWER binary always beats the one frozen into the
///      installer at release time.
///   2. `<resource_dir>/binaries/monero-wallet-rpc[.exe]` — a real binary
///      dropped into the resource dir by hand (legacy/manual path).
///   3. `<resource_dir>/binaries/monero-wallet-rpc.gz` — the BUNDLED payload.
///      Decompressed + SHA256-verified into app-data on first use. Until this
///      point it has sat compressed and dormant in the install dir, never
///      executed, for users who never open the Monero section.
///   4. Otherwise `Err` — the caller falls back to `xmr_download_wallet_rpc`.
fn resolve_rpc_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let fname = monero_wallet_rpc_filename();
    if let Ok(app_data) = app.path().app_data_dir() {
        let p = app_data.join("monero").join(&fname);
        if is_real_binary(&p) {
            return Ok(p);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("binaries").join(&fname);
        if is_real_binary(&p) {
            return Ok(p);
        }
    }
    // Wake the dormant bundled payload.
    if let (Ok(resource_dir), Ok(app_data)) =
        (app.path().resource_dir(), app.path().app_data_dir())
    {
        let dest = app_data.join("monero");
        match crate::wallet_rpc_common::extract_bundled_sidecar(&resource_dir, &dest, "monero") {
            Ok(p) if is_real_binary(&p) => return Ok(p),
            Ok(_) => {}
            Err(e) => eprintln!("[xmr] bundled sidecar unavailable ({}), will download", e),
        }
    }
    let (download_url, extract_hint) = if cfg!(target_os = "windows") {
        (
            "https://www.getmonero.org/downloads/",
            "extract monero-wallet-rpc.exe (~60 MB), and place it",
        )
    } else {
        (
            "https://downloads.getmonero.org/cli/ (pick monero-linux-x64-*.tar.bz2)",
            "extract monero-wallet-rpc (~60 MB) from the tarball and place it",
        )
    };
    Err(format!(
        "{0} not found (or only a placeholder is present).\n\
         Download 'Monero CLI' from {1}, {2} in one of:\n  \
         - src-tauri/binaries/{0} (rebuild required)\n  \
         - <app-data>/com.pwnda.wallet/monero/{0} (takes effect immediately)",
        fname, download_url, extract_hint
    ))
}

/// Per-user directory holding the RPC's wallet files (<name>, <name>.keys,
/// <name>.address.txt). Scan state lives here so the wallet doesn't re-scan
/// from genesis on every login.
fn get_wallet_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let wallet_dir = app_data.join("xmr-wallets");
    std::fs::create_dir_all(&wallet_dir)
        .map_err(|e| format!("Failed to create wallet dir: {}", e))?;
    Ok(wallet_dir)
}

/// Return the on-disk wallet directory path to the frontend.
#[tauri::command]
pub async fn xmr_wallet_dir(app: AppHandle) -> Result<String, String> {
    let dir = get_wallet_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Delete the active wallet file + its associated .keys and .address.txt.
///
/// On Windows, `close_wallet` returns before wallet-rpc fully releases the
/// file handle, so a delete attempt milliseconds later can hit
/// `ERROR_SHARING_VIOLATION` / "access denied". We retry with short backoffs
/// for up to ~2 seconds so the handle has time to close before we give up.
/// This is the backend half of the self-heal delete-then-regenerate flow in
/// `src/wallets/xmr-wallet.ts`; that frontend loop retries too, but doing
/// the fast loop here saves a few extra round trips over the Tauri bridge.
#[tauri::command]
pub async fn xmr_delete_wallet_files(app: AppHandle, filename: String) -> Result<(), String> {
    let dir = get_wallet_dir(&app)?;
    for suffix in &["", ".keys", ".address.txt"] {
        let p = dir.join(format!("{}{}", filename, suffix));
        if !p.exists() {
            continue;
        }
        let mut last_err: Option<String> = None;
        let mut removed = false;
        for _ in 0..10 {
            match std::fs::remove_file(&p) {
                Ok(()) => {
                    removed = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(format!("{}", e));
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
        if !removed {
            return Err(format!(
                "Failed to delete {:?} after 10 attempts: {}",
                p,
                last_err.unwrap_or_else(|| "unknown".into())
            ));
        }
    }
    Ok(())
}

// =========================================================================
// Internal RPC helpers
// =========================================================================

/// Generate a random lowercase hex string of `n` bytes (2n characters).
fn random_hex(n: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..n).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

/// PWNDA-STABLE-CREDS (C9): which credentials a fresh wallet-rpc spawn
/// should use. Pure — no I/O, no randomness of its own (the caller supplies
/// `fresh` via a closure precisely so this stays that way) — so the policy
/// is unit-testable without touching disk: only `XmrLease::SwapEngine`
/// consults `existing_stable`, and only when it's present. `Session` — the
/// ordinary path every user takes today — always calls `fresh()` and
/// ignores `existing_stable` entirely, which is what keeps this a no-op for
/// anyone who has never touched C9.
fn creds_for_spawn(
    lease: XmrLease,
    existing_stable: Option<&(String, String)>,
    fresh: impl FnOnce() -> (String, String),
) -> (String, String) {
    if lease == XmrLease::SwapEngine {
        if let Some(pair) = existing_stable {
            return pair.clone();
        }
    }
    fresh()
}

/// MD5 hex digest of the given bytes. Used for HTTP Digest auth (RFC 7616).
fn md5_hex(data: &[u8]) -> String {
    let mut h = Md5::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// Extract a quoted or unquoted field value from a single `WWW-Authenticate`
/// challenge string. e.g. for `Digest realm="monero-rpc",nonce="abc==",qop="auth"`,
/// `parse_digest_field(s, "nonce")` returns `Some("abc==")`.
fn parse_digest_field(challenge: &str, field: &str) -> Option<String> {
    // Very permissive: find the field=, then grab everything up to the next
    // unescaped comma at the top level. Handles both quoted and unquoted values.
    let needle = format!("{}=", field);
    let rest = challenge.splitn(2, &needle).nth(1)?;
    let trimmed = rest.trim_start();
    if let Some(stripped) = trimmed.strip_prefix('"') {
        // Quoted — stop at the closing quote.
        stripped.split('"').next().map(|s| s.to_string())
    } else {
        // Unquoted — stop at comma or whitespace.
        let end = trimmed
            .find(|c: char| c == ',' || c.is_whitespace())
            .unwrap_or(trimmed.len());
        Some(trimmed[..end].to_string())
    }
}

/// Build an RFC 7616 HTTP Digest `Authorization` header value for a POST.
///
/// Monero's wallet-rpc is strict about formatting — we format fields the same
/// way curl does: `qop="auth"` quoted, `nc` lowercase, `algorithm=MD5`, and
/// `response` quoted. Using the `digest_auth` crate produced responses that
/// monero-wallet-rpc silently rejected with 401 (see 2026-04-22 log entry).
///
/// Only supports `algorithm=MD5` and `qop=auth` — the challenge parsed from
/// Monero wallet-rpc always uses these, but we bail with an explicit error
/// if something else shows up so a regression doesn't silently re-fail.
fn build_digest_auth_header(
    challenge: &str,
    user: &str,
    password: &str,
    method: &str,
    uri: &str,
    cnonce: &str,
    nc: u32,
) -> Result<String, String> {
    let realm = parse_digest_field(challenge, "realm")
        .ok_or_else(|| format!("WWW-Authenticate missing realm: {}", challenge))?;
    let nonce = parse_digest_field(challenge, "nonce")
        .ok_or_else(|| format!("WWW-Authenticate missing nonce: {}", challenge))?;
    let qop = parse_digest_field(challenge, "qop").unwrap_or_else(|| "auth".to_string());
    let algorithm =
        parse_digest_field(challenge, "algorithm").unwrap_or_else(|| "MD5".to_string());

    // Monero sends both MD5 and MD5-sess challenges; we always pick MD5 upstream.
    if !algorithm.eq_ignore_ascii_case("MD5") {
        return Err(format!(
            "Unsupported Digest algorithm: {} (only MD5 supported)",
            algorithm
        ));
    }
    if !qop.split(',').any(|q| q.trim().eq_ignore_ascii_case("auth")) {
        return Err(format!("Unsupported qop: {} (only 'auth' supported)", qop));
    }

    let ha1 = md5_hex(format!("{}:{}:{}", user, realm, password).as_bytes());
    let ha2 = md5_hex(format!("{}:{}", method, uri).as_bytes());
    let nc_hex = format!("{:08x}", nc);
    let response = md5_hex(
        format!("{}:{}:{}:{}:auth:{}", ha1, nonce, nc_hex, cnonce, ha2).as_bytes(),
    );


    Ok(format!(
        r#"Digest username="{user}",realm="{realm}",nonce="{nonce}",uri="{uri}",cnonce="{cnonce}",nc={nc_hex},qop="auth",algorithm=MD5,response="{response}""#,
        user = user,
        realm = realm,
        nonce = nonce,
        uri = uri,
        cnonce = cnonce,
        nc_hex = nc_hex,
        response = response,
    ))
}

/// Core JSON-RPC HTTP call with HTTP Digest authentication.
///
/// If `creds` is `None`, the first request is sent unauthenticated (useful for
/// stale-process pings). If the server returns 401, we perform the standard
/// Digest challenge/response handshake and retry once.
async fn do_rpc_call(
    creds: Option<&(String, String)>,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    do_rpc_call_at(&xmr_rpc_url(), creds, method, params, timeout).await
}

/// Same as `do_rpc_call` but takes an explicit URL. Extracted so tests can
/// point at a wallet-rpc on a non-standard port without colliding with the
/// default 18082 used by the running app.
/// Parsed URL components for a loopback JSON-RPC endpoint.
fn split_loopback_url(url: &str) -> Result<(String, u16, String), String> {
    // Expected shape: "http://<host>:<port>/<path>". We only talk to
    // monero-wallet-rpc on loopback, so a tiny parser suffices (no TLS, no auth
    // in URL). The canonical URL is `http://127.0.0.1:18082/json_rpc`.
    let stripped = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("Only http:// URLs are supported, got: {}", url))?;
    let (host_port, path) = match stripped.find('/') {
        Some(i) => (&stripped[..i], &stripped[i..]),
        None => (stripped, "/"),
    };
    let (host, port) = match host_port.rfind(':') {
        Some(i) => {
            let p = host_port[i + 1..]
                .parse::<u16>()
                .map_err(|e| format!("Bad port in URL: {}", e))?;
            (host_port[..i].to_string(), p)
        }
        None => (host_port.to_string(), 80),
    };
    Ok((host, port, path.to_string()))
}

/// Read one HTTP/1.1 response (status line + headers + body) from a TCP
/// stream. Only handles fixed Content-Length bodies — that is what Monero's
/// Epee HTTP server always sends. Returns (status_code, headers, body_text).
async fn read_http_response(
    sock: &mut tokio::net::TcpStream,
    timeout_dur: std::time::Duration,
) -> Result<(u16, Vec<(String, String)>, String), String> {
    use tokio::io::AsyncReadExt;

    let fut = async {
        let mut buf = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];

        // Read until we've seen the end-of-headers marker.
        let header_end = loop {
            let n = sock
                .read(&mut tmp)
                .await
                .map_err(|e| format!("TCP read failed: {}", e))?;
            if n == 0 {
                return Err::<_, String>("TCP closed before headers complete".to_string());
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
            if buf.len() > 16 * 1024 {
                return Err("HTTP headers too large".to_string());
            }
        };

        let header_bytes = &buf[..header_end - 4];
        let header_str = std::str::from_utf8(header_bytes)
            .map_err(|e| format!("Non-UTF8 headers: {}", e))?
            .to_string();
        let mut lines = header_str.split("\r\n");
        let status_line = lines.next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .ok_or_else(|| format!("Malformed status line: {}", status_line))?;

        let mut headers = Vec::new();
        let mut content_length: usize = 0;
        for line in lines {
            if let Some(colon) = line.find(':') {
                let name = line[..colon].trim().to_string();
                let value = line[colon + 1..].trim().to_string();
                if name.eq_ignore_ascii_case("Content-Length") {
                    content_length = value.parse().unwrap_or(0);
                }
                headers.push((name, value));
            }
        }

        // Pull the body to exactly Content-Length bytes.
        let have = buf.len() - header_end;
        let mut body = Vec::with_capacity(content_length);
        body.extend_from_slice(&buf[header_end..]);
        let mut remaining = content_length.saturating_sub(have);
        while remaining > 0 {
            let chunk_size = tmp.len().min(remaining);
            let n = sock
                .read(&mut tmp[..chunk_size])
                .await
                .map_err(|e| format!("TCP read (body) failed: {}", e))?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
            remaining -= n;
        }

        let body_text = String::from_utf8_lossy(&body).to_string();
        Ok((status, headers, body_text))
    };

    tokio::time::timeout(timeout_dur, fut)
        .await
        .map_err(|_| format!("RPC timed out after {:?}", timeout_dur))?
}

async fn do_rpc_call_at(
    url: &str,
    creds: Option<&(String, String)>,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    // We talk directly over TCP rather than via reqwest because Monero's
    // Epee HTTP server uses **connection-scoped Digest nonces**: the
    // authenticated retry must go over the same TCP connection as the 401.
    // reqwest's pooling makes that hard to guarantee (see 2026-04-22 log),
    // and losing the connection silently reissues the wrong nonce → 401
    // forever. Raw TCP keeps the code simple and proven — the live tests
    // in `tests::rpc_live_*` exercise this path.
    use tokio::io::AsyncWriteExt;

    let (host, port, path) = split_loopback_url(url)?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "0",
        "method": method,
        "params": params,
    });
    let body_str = serde_json::to_string(&body)
        .map_err(|e| format!("Body serialization failed: {}", e))?;

    let mut sock = tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| format!("TCP connect timed out after {:?}", timeout))?
    .map_err(|e| format!("TCP connect failed: {}", e))?;

    // Probe 1 — no Authorization header. Keep-alive so we can retry on the
    // same socket if the server returns 401.
    let probe = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: keep-alive\r\n\r\n{body}",
        path = path,
        host = host,
        port = port,
        len = body_str.len(),
        body = body_str,
    );
    sock.write_all(probe.as_bytes())
        .await
        .map_err(|e| format!("TCP write failed: {}", e))?;

    let (status1, headers1, text1) = read_http_response(&mut sock, timeout).await?;

    let (status, text) = if status1 == 401 {
        let creds =
            creds.ok_or_else(|| "RPC returned 401 but no credentials provided".to_string())?;

        // Grab the first MD5 (not MD5-sess) WWW-Authenticate challenge.
        let auth_values: Vec<&String> = headers1
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case("WWW-Authenticate"))
            .map(|(_, v)| v)
            .collect();
        let www_auth_str = auth_values
            .iter()
            .find(|v| v.contains("algorithm=MD5,") || v.contains("algorithm=MD5 "))
            .copied()
            .or_else(|| auth_values.first().copied())
            .cloned()
            .unwrap_or_default();
        if www_auth_str.is_empty() {
            return Err("RPC returned 401 with no WWW-Authenticate header".to_string());
        }

        let cnonce = random_hex(16);
        let auth_header = build_digest_auth_header(
            &www_auth_str,
            &creds.0,
            &creds.1,
            "POST",
            &path,
            &cnonce,
            1,
        )?;

        // Retry on the SAME socket so the Epee per-connection nonce stays valid.
        let authed = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
            path = path,
            host = host,
            port = port,
            auth = auth_header,
            len = body_str.len(),
            body = body_str,
        );
        sock.write_all(authed.as_bytes())
            .await
            .map_err(|e| format!("TCP write (auth retry) failed: {}", e))?;
        let (status2, _h2, text2) = read_http_response(&mut sock, timeout).await?;
        (status2, text2)
    } else {
        (status1, text1)
    };

    if status < 200 || status >= 300 {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("RPC HTTP {}: {}", status, snippet));
    }

    let json: JsonRpcResponse = serde_json::from_str(&text).map_err(|e| {
        let snippet: String = text.chars().take(200).collect();
        format!("RPC response parse failed: {} — body: {}", e, snippet)
    })?;

    if let Some(err) = json.error {
        return Err(format!("RPC error {}: {}", err.code, err.message));
    }
    Ok(json.result.unwrap_or(serde_json::Value::Null))
}

/// One-shot health check using the current session credentials.
async fn xmr_rpc_ping(creds: &(String, String)) -> Result<(), String> {
    do_rpc_call(
        Some(creds),
        "get_version",
        serde_json::json!({}),
        std::time::Duration::from_secs(2),
    )
    .await
    .map(|_| ())
}

// =========================================================================
// Stale-process cleanup helpers
// =========================================================================

/// Path to the pidfile that records the wallet-rpc child from the most recent
/// session. Next session reads this on startup so it can kill the exact old
/// process instead of nuking every `monero-wallet-rpc.exe` on the machine
/// (which would also kill Feather / GUI Wallet instances).
fn get_pidfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_wallet_dir(app)?.join("wallet-rpc.pid"))
}

/// Path to the per-session credentials file. See
/// `wallet_rpc_common::read_creds_file` for the rationale — this is what
/// lets next session's cleanup graceful-stop our orphaned wallet-rpc so
/// scan progress survives hard kills (Ctrl+C in `tauri dev`, crash, etc.).
fn get_credsfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_wallet_dir(app)?.join("wallet-rpc.creds"))
}

/// PWNDA-LEASE (C9): path to the STABLE credentials file — deliberately a
/// different file and a different lifecycle from `get_credsfile`'s.
///
/// The regular creds file is per-session and deleted on a clean stop (its
/// job ends when the process it authenticates is gone). This one exists
/// because `basicswap.json`'s `mainwalletrpcauth` is written once and read
/// by the engine's `run.py` once at process start — there is no reload path
/// (see PwndaWalletVault/wiki/synthesis/c9-xmr-lifecycle-design.md,
/// blocker 3). A wallet-rpc restart WHILE the swap engine still needs this
/// process (a daemon hot-swap, a self-heal) must not silently invalidate
/// auth the engine's config already has — so while `XmrLease::SwapEngine`
/// is in play, credentials are read from here instead of regenerated, and
/// only cleared once `XmrRpcInner::leases` returns to fully empty (i.e. the
/// swap engine no longer needs this process at all).
fn get_stable_credsfile(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_wallet_dir(app)?.join("wallet-rpc.shared-creds"))
}

fn read_pidfile(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

fn write_pidfile(path: &PathBuf, pid: u32) {
    let _ = std::fs::write(path, pid.to_string());
}

fn delete_pidfile(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

/// Read the "user:pass" line from the creds file, if present. The creds
/// file is written right after wallet-rpc's per-session credentials are
/// generated and deleted on a clean shutdown. Its sole purpose is letting
/// the *next* session authenticate a graceful `stop_wallet` against an
/// orphaned sidecar that we couldn't teardown ourselves.
fn read_credsfile(path: &PathBuf) -> Option<(String, String)> {
    let s = std::fs::read_to_string(path).ok()?;
    let line = s.trim();
    let (user, pass) = line.split_once(':')?;
    if user.is_empty() || pass.is_empty() {
        return None;
    }
    Some((user.to_string(), pass.to_string()))
}

fn write_credsfile(path: &PathBuf, user: &str, pass: &str) {
    let _ = std::fs::write(path, format!("{}:{}", user, pass));
}

fn delete_credsfile(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

/// TCP-level probe: returns true iff something is accepting connections on
/// the wallet-rpc port. Used to detect port conflicts before `spawn()`, where
/// the old HTTP ping was unreliable — a wallet-rpc busy scanning blocks can
/// take longer than 1 second to reply to an unauthenticated POST, making the
/// HTTP probe falsely report the port as free.
async fn xmr_port_is_bound() -> bool {
    tokio::time::timeout(
        std::time::Duration::from_millis(500),
        tokio::net::TcpStream::connect(("127.0.0.1", active_xmr_port())),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// Kill a specific PID only if it's a `monero-wallet-rpc.exe`.
///
/// The `/FI "IMAGENAME eq ..."` filter makes taskkill a no-op if the PID has
/// been recycled to an unrelated process — so a stale pidfile pointing at a
/// reused PID can't accidentally kill something the user cares about.
///
/// Returns the taskkill exit code (0 = killed, 128 = no match, other = error).
#[cfg(target_os = "windows")]
async fn kill_wallet_rpc_pid(pid: u32) -> Result<i32, String> {
    let mut cmd = tokio::process::Command::new("taskkill");
    cmd.args([
        "/PID",
        &pid.to_string(),
        "/FI",
        "IMAGENAME eq monero-wallet-rpc.exe",
        "/F",
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("taskkill spawn failed: {}", e))?;
    Ok(output.status.code().unwrap_or(-1))
}

/// Read the tail of the wallet-rpc log so error messages can include the
/// actual failure reason (e.g. "Failed to bind IPv4") instead of just a
/// bare "failed to become ready" timeout.
fn read_log_tail(path: &PathBuf, max_bytes: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::from("(log file unavailable)"),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::from("(log seek failed)");
    }
    let mut buf = Vec::with_capacity(max_bytes as usize);
    let _ = file.take(max_bytes).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    // Trim any half-line at the start we landed in the middle of.
    match text.find('\n') {
        Some(i) if start > 0 => text[i + 1..].to_string(),
        _ => text,
    }
}

// =========================================================================
// Tauri commands
// =========================================================================

/// Launch monero-wallet-rpc as a child process and wait until it's responsive.
///
/// Per-session random credentials are generated and stored in app state.
/// `--trusted-daemon` is only passed for localhost nodes.
#[tauri::command]
pub async fn xmr_start_rpc(
    app: AppHandle,
    daemon_address: String,
    lease: XmrLease,
) -> Result<(), String> {
    // Short-circuit if already running — but still register the lease. A
    // second owner arriving after the first must be counted, or its later
    // `xmr_stop_rpc(lease)` would find the set already empty and skip the
    // teardown it's entitled to expect ran, while an EARLIER stop by the
    // first owner (who never saw this lease) could kill the process out
    // from under this caller.
    {
        let state = app.state::<XmrRpcChild>();
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        // PWNDA-SINGLE-FLIGHT (incident, 2026-08-23): the check here and the
        // actual spawn below are NOT atomic on their own — everything from
        // here to the success-path `*guard = XmrRpcInner { child: Some(child),
        // .. }` near the bottom of this function is async work with real I/O
        // in it (resolving the binary, stale-process cleanup with
        // multi-second RPC timeouts). On a fresh app boot, the user's own
        // Monero panel (`XmrLease::Session`) and the swap sidecar's C9
        // activation (`XmrLease::SwapEngine`) can both call this within the
        // SAME fraction of a second — `decide_xmr_start` reading BOTH
        // `child.is_some()` and `starting` under this ONE lock acquisition,
        // and `starting` being set before the lock is released below, is
        // what makes the decision atomic. Observed live before this fix: two
        // monero-wallet-rpc.exe processes 0.9s apart fighting over the same
        // port, the swap engine then unable to reach either one
        // ("[WinError 10061] No connection could be made because the target
        // machine actively refused it") for over two minutes, cascading into
        // a full autostart failure at the 180s ceiling.
        match decide_xmr_start(guard.child.is_some(), guard.starting) {
            XmrStartDecision::AlreadyRunning => {
                guard.leases.insert(lease);
                // PWNDA-STABLE-CREDS (C9): SwapEngine may be JOINING a
                // process Session already started with ordinary per-session
                // random creds. Persist those actual creds now, so a LATER
                // restart while SwapEngine still needs this process reuses
                // them instead of generating fresh ones the engine's
                // already-written config doesn't know about. A no-op if the
                // stable file already exists (e.g. SwapEngine started this
                // process itself) or this lease isn't SwapEngine.
                if lease == XmrLease::SwapEngine {
                    if let Some((u, p)) = guard.creds.clone() {
                        let stable_path = get_stable_credsfile(&app)?;
                        if read_credsfile(&stable_path).is_none() {
                            write_credsfile(&stable_path, &u, &p);
                        }
                    }
                }
                return Ok(());
            }
            XmrStartDecision::AlreadyStarting => {
                // Lease still recorded — same reasoning as the branch above
                // — so it attaches once the winner's process comes up,
                // rather than the loser silently never counting.
                guard.leases.insert(lease);
                return Err(
                    "a Monero wallet-rpc start is already in progress — this lease \
                     will attach once it is up; do not start a second process"
                        .to_string(),
                );
            }
            XmrStartDecision::ShouldSpawn => {
                guard.starting = true;
            }
        }
    }

    // Drop guard: whichever way this function exits from here on — the
    // happy path, an early `?`, an explicit `return Err` — `starting` must
    // go back to `false`, or every later caller would see "already
    // starting" forever. The happy path's own `*guard = XmrRpcInner { .. }`
    // already sets `starting: false` explicitly; this still runs after it
    // and is a harmless no-op in that case; it is the ONLY thing that runs
    // on every other exit, which is the property that matters.
    struct StartingClaim<'a>(&'a AppHandle);
    impl Drop for StartingClaim<'_> {
        fn drop(&mut self) {
            if let Ok(mut g) = self.0.state::<XmrRpcChild>().0.lock() {
                g.starting = false;
            }
        }
    }
    let _claim = StartingClaim(&app);

    // Reset to the preferred port before the stale-process sweep below. Without
    // this, a session that fell back to an ephemeral port would leave the
    // global pointing there, and the next start would hunt for orphans on a
    // port nothing ever used — missing a real orphan on 18082.
    set_active_xmr_port(XMR_RPC_PORT);

    let binary = resolve_rpc_binary(&app)?;
    let wallet_dir = get_wallet_dir(&app)?;
    let log_file = wallet_dir.join("monero-wallet-rpc.log");
    let pidfile = get_pidfile(&app)?;
    let credsfile = get_credsfile(&app)?;

    // ===== Stale-process cleanup =====
    //
    // Order matters: try to gracefully shut down any orphaned wallet-rpc
    // from a previous session FIRST, so it can flush scan state to disk
    // before exiting. Only fall back to hard-kill if the graceful path
    // fails. A hard-kill mid-sync reverts the wallet file to its last
    // autosave — often back to `restore_height` — and Monero users see
    // this as the app "restarting sync from scratch" every run.
    //
    //   1. If a creds file exists from the previous session, authenticate
    //      and call `store` + `close_wallet` + `stop_wallet`. Wallet-rpc
    //      commits and exits cleanly. Wait up to 3s for the port to free.
    //   2. If still bound, try the (legacy) unauthenticated `stop_wallet`
    //      — no-op when auth is on, but covers the pre-creds-file case.
    //   3. If still bound, hard-kill by PID (pidfile-precise, image-filtered).
    //   4. If still bound, broad `taskkill /IM` as the last hammer.

    let old_creds = read_credsfile(&credsfile);

    if xmr_port_is_bound().await {
        if let Some(creds) = old_creds.as_ref() {
            // Graceful path. `store` is first so scan state hits disk even
            // if `stop_wallet` then times out for any reason.
            let _ = do_rpc_call(
                Some(creds),
                "store",
                serde_json::json!({}),
                std::time::Duration::from_secs(10),
            )
            .await;
            let _ = do_rpc_call(
                Some(creds),
                "close_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(5),
            )
            .await;
            let _ = do_rpc_call(
                Some(creds),
                "stop_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(5),
            )
            .await;
            // Give wallet-rpc up to 3s to actually flush + exit.
            for _ in 0..15 {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                if !xmr_port_is_bound().await {
                    break;
                }
            }
        }

        // Legacy no-auth path — covers wallet-rpc instances started
        // before this code shipped (no creds file on disk).
        if xmr_port_is_bound().await {
            let _ = do_rpc_call(
                None,
                "stop_wallet",
                serde_json::json!({}),
                std::time::Duration::from_secs(2),
            )
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }

    if xmr_port_is_bound().await {
        // Hard-kill fallback (pidfile-precise).
        if let Some(old_pid) = read_pidfile(&pidfile) {
            #[cfg(target_os = "windows")]
            {
                let _ = kill_wallet_rpc_pid(old_pid).await;
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = old_pid;
            }
        }
    }

    // Anything still holding the preferred port at this point is NOT ours: the
    // graceful-stop and pidfile-kill passes above have already dealt with our
    // own orphans. Move to an ephemeral port rather than fighting for 18082.
    //
    // This replaces two behaviours:
    //   - a hard error telling the user to go kill the process by hand, which
    //     dead-ended anyone running a local monerod (18082 IS monerod's default
    //     ZMQ-RPC port), and
    //   - a Windows-only `taskkill /IM monero-wallet-rpc.exe /F`, which killed
    //     EVERY monero-wallet-rpc on the machine by image name — including
    //     wallet-rpc instances belonging to other applications that we had no
    //     business terminating.
    //
    // Picking a different port makes both unnecessary: we no longer need the
    // port, so we no longer need to take it from anyone.
    if xmr_port_is_bound().await {
        let fallback = crate::wallet_rpc_common::pick_free_port(XMR_RPC_PORT);
        eprintln!(
            "[xmr_rpc] preferred port {} is held by another process; \
             using {} for this session instead",
            XMR_RPC_PORT, fallback
        );
        set_active_xmr_port(fallback);
    }

    // Both stale markers are about to be rewritten — clear them so a
    // failed spawn below doesn't leave the next run believing an
    // orphaned sidecar is alive on this port.
    delete_credsfile(&credsfile);

    // Drop any stale pidfile now — we'll rewrite it after a successful spawn.
    delete_pidfile(&pidfile);

    // Generate per-session random credentials (16 random bytes each = 32 hex chars) —
    // UNLESS this spawn is for XmrLease::SwapEngine, in which case reuse a
    // durably-persisted pair if one exists (see `get_stable_credsfile`'s doc
    // comment for why: `mainwalletrpcauth` in the engine's config is
    // write-once, so a restart while the engine still needs this process
    // must not invalidate the auth it already has). A plain Session-only
    // start is byte-identical to before this existed.
    let stable_path = get_stable_credsfile(&app)?;
    let existing_stable = read_credsfile(&stable_path);
    let (username, password) =
        creds_for_spawn(lease, existing_stable.as_ref(), || {
            (random_hex(16), random_hex(16))
        });
    if lease == XmrLease::SwapEngine && existing_stable.is_none() {
        write_credsfile(&stable_path, &username, &password);
    }
    let rpc_login = format!("{}:{}", username, password);

    // Only trust the daemon when it's local — remote nodes must not receive
    // the secret view key that --trusted-daemon sends.
    let is_local = daemon_address.contains("127.0.0.1") || daemon_address.contains("localhost");

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("--rpc-bind-ip")
        .arg("127.0.0.1")
        .arg("--rpc-bind-port")
        // active, not preferred — may have fallen back above
        .arg(active_xmr_port().to_string())
        .arg("--rpc-login")
        .arg(&rpc_login)
        .arg("--wallet-dir")
        .arg(&wallet_dir)
        .arg("--daemon-address")
        .arg(&daemon_address)
        .arg("--log-level")
        .arg("0")
        .arg("--non-interactive")
        .arg("--log-file")
        .arg(&log_file);

    // For explicit `http://` nodes, tell wallet-rpc plaintext up front so
    // it skips the autodetect probe (saves one round-trip on first connect).
    //
    // For `https://` (or schemeless), we intentionally DO NOT pass
    // `--daemon-ssl enabled`: wallet-rpc rejects that unless we also pass
    // one of `--daemon-ssl-allow-any-cert` / `--daemon-ssl-ca-certificates`
    // / `--daemon-ssl-allowed-fingerprints`, and public Monero nodes ship
    // a mix of Let's Encrypt + self-signed + expired certs that no single
    // static policy handles. wallet-rpc's default `autodetect` + system
    // cert store is the least-bad compromise for https daemons. A naive
    // `--daemon-ssl-allow-any-cert` would silently accept MITM'd daemons.
    if daemon_address.starts_with("http://") {
        cmd.arg("--daemon-ssl").arg("disabled");
    }

    // Parallelize block parsing during scan. `--max-concurrency N` sizes
    // wallet2's `threadpool::getInstanceForCompute`, used by
    // `pull_and_parse_next_blocks` to parse blocks and derive key images
    // in parallel (wallet2.cpp:3239, 3502, 4089). Default is 1, leaving
    // most cores idle on modern hardware.
    //
    // We pick **physical** cores, not logical — hyperthreading hurts
    // here because two SMT threads on the same core contend for the same
    // L1/L2 and the view-key scan is latency-bound on cache. Capped at
    // 16 so a 32-core Threadripper doesn't starve the rest of the app.
    // Floor of 2 so single-core boxes still get some parallelism.
    let concurrency = (num_cpus::get_physical() as u32).clamp(2, 16);
    cmd.arg("--max-concurrency").arg(concurrency.to_string());

    if is_local {
        cmd.arg("--trusted-daemon");
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.kill_on_drop(true);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn monero-wallet-rpc: {}", e))?;

    // Record our PID so the next session's stale-cleanup can target us
    // exactly, even if we're force-killed and can't run our own teardown.
    if let Some(pid) = child.id() {
        write_pidfile(&pidfile, pid);
    }

    let creds = (username, password);

    // Persist credentials for the next session's graceful-stop path. Without
    // this, a hard-kill here (Ctrl+C in `tauri dev`, crash) leaves an
    // orphaned wallet-rpc that the next startup can only kill forcibly,
    // discarding any unflushed scan progress.
    write_credsfile(&credsfile, &creds.0, &creds.1);

    {
        let state = app.state::<XmrRpcChild>();
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut leases = std::collections::HashSet::new();
        leases.insert(lease);
        *guard = XmrRpcInner {
            child: Some(child),
            creds: Some(creds.clone()),
            leases,
            starting: false,
        };
    }

    // Ready probe: poll `get_version` with credentials until ready or timeout.
    //
    // Budget: 30s (doubled from the old 15s) — on a first-run of a freshly
    // downloaded binary, Windows Defender's initial scan can eat most of
    // that. Each iteration also checks whether the child has already
    // exited — a silent bind failure after spawn() succeeded is the exact
    // scenario the pre-spawn port check prevents, but we keep this guard
    // so any other early crash surfaces the actual error from the log
    // instead of the meaningless "failed to become ready" timeout.
    const READY_BUDGET_MS: u64 = 30_000;
    const READY_POLL_MS: u64 = 250;
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(READY_BUDGET_MS);

    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(READY_POLL_MS)).await;

        // Detect early child death (bind failure, daemon rejection, etc.)
        let exit_code: Option<i32> = {
            let state = app.state::<XmrRpcChild>();
            let result = match state.0.lock() {
                Ok(mut guard) => match guard.child.as_mut() {
                    Some(ch) => match ch.try_wait() {
                        Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                        _ => None,
                    },
                    None => None,
                },
                Err(_) => None,
            };
            result
        };
        if let Some(code) = exit_code {
            let tail = read_log_tail(&log_file, 3072);
            xmr_stop_rpc_internal(&app).await;
            return Err(format!(
                "monero-wallet-rpc exited with code {} before becoming ready. \
                 Last log lines:\n{}",
                code, tail
            ));
        }

        if xmr_rpc_ping(&creds).await.is_ok() {
            return Ok(());
        }
    }

    // Timeout — include log tail so the real failure is visible.
    let tail = read_log_tail(&log_file, 3072);
    xmr_stop_rpc_internal(&app).await;
    Err(format!(
        "monero-wallet-rpc failed to become ready within {}s. Last log lines:\n{}",
        READY_BUDGET_MS / 1000,
        tail
    ))
}

/// Proxy a JSON-RPC call to the running monero-wallet-rpc.
///
/// Reads the per-session credentials from app state and handles HTTP Digest auth
/// transparently. The frontend never sees or manages credentials.
#[tauri::command]
pub async fn xmr_rpc_call(
    state: tauri::State<'_, XmrRpcChild>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let creds = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.creds.clone()
    };

    // `refresh` can take many minutes on a fresh wallet (scan from genesis).
    let timeout = if method == "refresh" {
        std::time::Duration::from_secs(60 * 60)
    } else {
        std::time::Duration::from_secs(30)
    };

    do_rpc_call(creds.as_ref(), &method, params, timeout).await
}

/// The wallet's own primary address (account 0), read from wallet-rpc.
///
/// # Why this exists rather than a `pub(crate) do_rpc_call`
///
/// C4's sweep-back (`swap_bridge`) needs a Monero destination that the renderer
/// cannot influence. Widening [`do_rpc_call`] to `pub(crate)` would give that
/// module — and every future one — the ability to issue **any** wallet-rpc
/// method, `transfer` and `sweep_all` included, which is a far larger grant
/// than "tell me my own address". This is the whole capability, named.
///
/// **No fallback.** If wallet-rpc is not reachable the caller must refuse the
/// sweep; the alternative would be accepting an address from somewhere less
/// trustworthy than the wallet itself, which is exactly the attack C4 is shaped
/// to prevent.
pub(crate) async fn primary_address(
    state: &tauri::State<'_, XmrRpcChild>,
) -> Result<String, String> {
    let creds = {
        let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.creds.clone()
    };
    let v = do_rpc_call(
        creds.as_ref(),
        "get_address",
        serde_json::json!({ "account_index": 0 }),
        std::time::Duration::from_secs(20),
    )
    .await?;
    v.get("address")
        .and_then(|a| a.as_str())
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(|a| a.to_string())
        .ok_or_else(|| "monero-wallet-rpc returned no address".to_string())
}

/// Release `lease`'s claim on the wallet-rpc process. Only actually stops
/// the child once the lease set is empty — see [`XmrLease`].
#[tauri::command]
pub async fn xmr_stop_rpc(app: AppHandle, lease: XmrLease) -> Result<(), String> {
    let should_stop = {
        let state = app.state::<XmrRpcChild>();
        let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.release_lease(lease)
    };
    if should_stop {
        xmr_stop_rpc_internal(&app).await;
    }
    Ok(())
}

async fn xmr_stop_rpc_internal(app: &AppHandle) {
    // Grab credentials before we tear down state.
    let creds = {
        let state = app.state::<XmrRpcChild>();
        let x = match state.0.lock() {
            Ok(guard) => guard.creds.clone(),
            Err(_) => None,
        };
        x
    };

    // Best-effort graceful shutdown with auth.
    let _ = do_rpc_call(
        creds.as_ref(),
        "close_wallet",
        serde_json::json!({}),
        std::time::Duration::from_secs(5),
    )
    .await;
    let _ = do_rpc_call(
        creds.as_ref(),
        "stop_wallet",
        serde_json::json!({}),
        std::time::Duration::from_secs(5),
    )
    .await;

    let child_opt = {
        let state = app.state::<XmrRpcChild>();
        let mut guard = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let child = guard.child.take();
        guard.creds = None;
        guard.leases.clear();
        child
    };

    if let Some(mut child) = child_opt {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    // Clean up the pidfile + creds file — next startup's stale-cleanup
    // has nothing to do.
    if let Ok(pidfile) = get_pidfile(app) {
        delete_pidfile(&pidfile);
    }
    if let Ok(credsfile) = get_credsfile(app) {
        delete_credsfile(&credsfile);
    }
    // We only reach this function when the lease set is (or is being made)
    // empty — `xmr_stop_rpc` gates the call on it, and the two internal
    // failure-path callers (early child death, ready-timeout) are both
    // "nothing to have leased yet" cases. Either way, no lease still needs
    // stable auth, so reset it — the NEXT SwapEngine acquisition generates
    // and persists a fresh pair rather than reusing one for a process that
    // no longer exists.
    if let Ok(stable_credsfile) = get_stable_credsfile(app) {
        delete_credsfile(&stable_credsfile);
    }
}

/// Frontend-visible status: is the sidecar currently running?
#[tauri::command]
pub async fn xmr_rpc_is_running(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<XmrRpcChild>();
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(guard.child.is_some())
}

/// Result of probing a Monero daemon's `/get_info` endpoint.
///
/// `latency_ms` is the wall-clock time from request start to response
/// headers. `height` is parsed from the response body when present —
/// absent/zero means the response wasn't valid JSON or didn't include a
/// height field (some misconfigured nodes omit it).
#[derive(Clone, Serialize)]
pub struct XmrProbeResult {
    pub url: String,
    pub ok: bool,
    pub latency_ms: Option<u32>,
    pub height: Option<u64>,
    pub error: Option<String>,
}

/// Probe a Monero daemon's `/get_info` from the Rust side.
///
/// The reason this exists instead of a plain `fetch()` in the renderer:
/// the webview runs at origin `tauri://localhost` and the browser enforces
/// CORS on outbound requests. Most public Monero nodes don't send
/// `Access-Control-Allow-Origin` (only cakewallet + sethforprivacy out of
/// the 15 Feather-curated mainnet clearnet nodes, as of 2026-04-23), so a
/// renderer-side fetch fails on most of the pool with `TypeError: Failed
/// to fetch` — making "Test All Nodes" show data for only a couple of
/// rows. reqwest doesn't enforce CORS; routing probes through here lets
/// us benchmark every curated node honestly and pick the fastest for
/// sync. Also the same path `raceBestNode()` / `getSyncStatus` use for
/// daemon selection and progress polling, so those get the same
/// coverage boost for free.
#[tauri::command]
pub async fn xmr_probe_node(url: String, timeout_ms: u64) -> Result<XmrProbeResult, String> {
    let clean_url = url.trim_end_matches('/').to_string();
    let endpoint = format!("{}/get_info", clean_url);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(XmrProbeResult {
                url,
                ok: false,
                latency_ms: None,
                height: None,
                error: Some(format!("client build: {}", e)),
            });
        }
    };

    let start = std::time::Instant::now();
    let resp = match client.get(&endpoint).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "timeout".to_string()
            } else if e.is_connect() {
                "connect failed".to_string()
            } else {
                format!("{}", e)
            };
            return Ok(XmrProbeResult {
                url,
                ok: false,
                latency_ms: None,
                height: None,
                error: Some(msg),
            });
        }
    };
    let latency_ms = start.elapsed().as_millis() as u32;
    let status = resp.status();

    if !status.is_success() {
        return Ok(XmrProbeResult {
            url,
            ok: false,
            latency_ms: Some(latency_ms),
            height: None,
            error: Some(format!("HTTP {}", status.as_u16())),
        });
    }

    // `get_info` returns JSON with a numeric `height`. Some node configs
    // serve it with a wrong Content-Type; parse defensively.
    let height = match resp.text().await {
        Ok(body) => serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("height").and_then(|h| h.as_u64())),
        Err(_) => None,
    };

    Ok(XmrProbeResult {
        url,
        ok: true,
        latency_ms: Some(latency_ms),
        height,
        error: None,
    })
}

// =========================================================================
// Auto-download + Windows Defender exclusion for monero-wallet-rpc.exe
// =========================================================================

/// Directory where the auto-downloaded monero-wallet-rpc.exe lives.
fn get_monero_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let monero_dir = app_data.join("monero");
    std::fs::create_dir_all(&monero_dir)
        .map_err(|e| format!("Failed to create monero dir: {}", e))?;
    Ok(monero_dir)
}

/// Progress event payload sent to the frontend during wallet-rpc download.
#[derive(Clone, Serialize)]
pub struct XmrDownloadProgress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

/// Minimal GitHub release shape — we only use the tag name for version discovery.
/// Monero does NOT publish binaries as GitHub release assets; the canonical
/// binaries live at downloads.getmonero.org. See `xmr_download_wallet_rpc`.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
}

/// Parse the SHA256 hash for a given filename out of the PGP-signed hashes.txt
/// served at https://www.getmonero.org/downloads/hashes.txt.
///
/// The file is PGP-signed by binaryFate; we skip PGP verification (TLS + the
/// known canonical path is a reasonable trust boundary for now) and just parse
/// the line matching `<sha256>  <filename>`.
fn parse_hash_for_file<'a>(hashes_txt: &'a str, filename: &str) -> Option<&'a str> {
    for line in hashes_txt.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        // Expected format: "<64-hex-sha256>  <filename>"
        let mut parts = trimmed.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        if name == filename && hash.len() == 64 {
            return Some(hash);
        }
    }
    None
}

/// Hidden PowerShell command helper (no console window).
/// Cross-platform via `platform::apply_hidden_spawn` (no-op on Linux).
fn hidden_powershell_command() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("powershell");
    crate::platform::apply_hidden_spawn(&mut cmd);
    cmd.args(["-ExecutionPolicy", "Bypass"]);
    cmd
}

/// Check if monero-wallet-rpc.exe is present and real (not a placeholder).
#[tauri::command]
pub async fn xmr_check_wallet_rpc(app: AppHandle) -> Result<bool, String> {
    Ok(resolve_rpc_binary(&app).is_ok())
}

/// Download monero-wallet-rpc.exe from the Monero project's canonical download host.
///
/// Monero does NOT attach binaries to GitHub releases — only source tags exist
/// there. The real Windows binary lives at:
///
///   https://downloads.getmonero.org/cli/monero-win-x64-<tag>.zip
///
/// Flow:
///   1. Hit GitHub to discover the latest tag name (e.g. "v0.18.4.6").
///   2. Fetch the PGP-signed hashes.txt and parse the SHA256 for our zip.
///   3. Stream-download the zip while hashing, verify the digest matches.
///   4. Extract just monero-wallet-rpc.exe into `<app_data>/monero/`.
///
/// Any mismatch in step 3 aborts before extraction — a corrupted or MITM'd
/// zip never reaches disk as an executable.
#[tauri::command]
pub async fn xmr_download_wallet_rpc(app: AppHandle) -> Result<(), String> {
    // Linux uses a different archive format (.tar.bz2) and entry layout than
    // Windows (.zip). Dispatch to the Linux-specific helper which uses the
    // system `tar` binary for bzip2 extraction (no `bzip2` Rust crate dep —
    // `tar` ships with every Linux distro's base install). macOS would need
    // its own flow with a Darwin tarball; not in scope.
    #[cfg(target_os = "linux")]
    {
        return download_monero_wallet_rpc_linux(app).await;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return Err(
            "Auto-download of monero-wallet-rpc on macOS not yet wired. \
             Download monero-mac-x64-*.tar.bz2 from \
             https://downloads.getmonero.org/cli/ and place monero-wallet-rpc \
             in <app-data>/com.pwnda.wallet/monero/."
                .to_string(),
        );
    }

    let monero_dir = get_monero_dir(&app)?;
    let exe_path = monero_dir.join("monero-wallet-rpc.exe");

    // Skip if already present and real
    if is_real_binary(&exe_path) {
        crate::emit_meter::bump("xmr-download-progress");
        let _ = app.emit(
            "xmr-download-progress",
            XmrDownloadProgress {
                stage: "complete".to_string(),
                percent: 100.0,
                message: "monero-wallet-rpc.exe already present".to_string(),
            },
        );
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // 1. Discover the latest tag name from GitHub. The release body has no
    //    usable assets — we only want the version string.
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "fetching".to_string(),
            percent: 0.0,
            message: "Fetching latest Monero release info…".to_string(),
        },
    );

    let release: GhRelease = client
        .get("https://api.github.com/repos/monero-project/monero/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Monero release: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {}", e))?;

    let tag = release.tag_name; // e.g. "v0.18.4.6"
    let filename = format!("monero-win-x64-{}.zip", tag);
    let download_url = format!("https://downloads.getmonero.org/cli/{}", filename);

    // 2. Fetch hashes.txt and parse the expected SHA256 for our file.
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "fetching".to_string(),
            percent: 0.0,
            message: "Fetching Monero SHA256 hashes…".to_string(),
        },
    );

    let hashes_txt = client
        .get("https://www.getmonero.org/downloads/hashes.txt")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch hashes.txt: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read hashes.txt body: {}", e))?;

    let expected_hash = parse_hash_for_file(&hashes_txt, &filename)
        .ok_or_else(|| {
            format!(
                "No SHA256 found for {} in hashes.txt — release {} may not yet be published \
                 on downloads.getmonero.org. Try again in a few minutes.",
                filename, tag
            )
        })?
        .to_ascii_lowercase();

    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "downloading".to_string(),
            percent: 0.0,
            message: format!("Downloading {} from downloads.getmonero.org…", filename),
        },
    );

    // 3. Stream-download the ZIP, hashing as we go.
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {} from {}",
            response.status(),
            download_url
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    let zip_path = monero_dir.join(&filename);
    let mut file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        let percent = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };
        crate::emit_meter::bump("xmr-download-progress");
        let _ = app.emit(
            "xmr-download-progress",
            XmrDownloadProgress {
                stage: "downloading".to_string(),
                percent,
                message: format!(
                    "Downloading monero-wallet-rpc — {:.1}/{:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            },
        );
    }
    drop(file);

    // 3b. Verify SHA256 before extracting. If the hash doesn't match, the
    //     zip was corrupted or tampered with in transit — remove it and bail.
    let actual_hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    if actual_hash != expected_hash {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!(
            "SHA256 mismatch for {} — expected {}, got {}. Download aborted.",
            filename, expected_hash, actual_hash
        ));
    }

    // 4. Extract just monero-wallet-rpc.exe from the zip
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "extracting".to_string(),
            percent: 0.0,
            message: "Extracting monero-wallet-rpc.exe…".to_string(),
        },
    );

    let zip_file = std::fs::File::open(&zip_path)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|e| format!("Failed to read zip: {}", e))?;

    let mut found = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Zip entry error: {}", e))?;
        if entry.name().ends_with("monero-wallet-rpc.exe") {
            let mut outfile = std::fs::File::create(&exe_path)
                .map_err(|e| format!("Failed to create exe: {}", e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Failed to extract exe: {}", e))?;
            found = true;
            break;
        }
    }

    let _ = std::fs::remove_file(&zip_path);

    if !found {
        return Err("monero-wallet-rpc.exe not found inside the downloaded zip".to_string());
    }

    // Record what we placed so the background updater can version-compare
    // without executing a 60 MB binary just to ask it. A binary with no marker
    // is treated as hand-placed and left alone — see sidecar_update.rs.
    crate::sidecar_update::set_installed_version(&monero_dir, &tag);

    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "complete".to_string(),
            percent: 100.0,
            message: "monero-wallet-rpc.exe ready".to_string(),
        },
    );
    Ok(())
}

/// Linux equivalent of the Windows auto-download flow above. Same steps —
/// GitHub-tag discovery, hashes.txt fetch, streamed download with SHA256
/// verification, extract — but uses `monero-linux-x64-<tag>.tar.bz2` and
/// extracts via the system `tar -xjf` binary (universally available on
/// Linux; avoids adding a `bzip2` Rust crate + native libbz2 dep).
///
/// Search for the extracted binary is recursive because Monero's tarball
/// places it under `monero-x86_64-linux-gnu-v<tag>/monero-wallet-rpc`.
#[cfg(target_os = "linux")]
async fn download_monero_wallet_rpc_linux(app: AppHandle) -> Result<(), String> {
    let monero_dir = get_monero_dir(&app)?;
    let exe_path = monero_dir.join("monero-wallet-rpc");

    if is_real_binary(&exe_path) {
        crate::emit_meter::bump("xmr-download-progress");
        let _ = app.emit(
            "xmr-download-progress",
            XmrDownloadProgress {
                stage: "complete".to_string(),
                percent: 100.0,
                message: "monero-wallet-rpc already present".to_string(),
            },
        );
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("PwndaWallet/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // 1. Discover the latest tag from GitHub.
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "fetching".to_string(),
            percent: 0.0,
            message: "Fetching latest Monero release info…".to_string(),
        },
    );
    let release: GhRelease = client
        .get("https://api.github.com/repos/monero-project/monero/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Monero release: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {}", e))?;

    let tag = release.tag_name; // e.g. "v0.18.5.0"
    let filename = format!("monero-linux-x64-{}.tar.bz2", tag);
    let download_url = format!("https://downloads.getmonero.org/cli/{}", filename);

    // 2. Fetch hashes.txt and parse the expected SHA256.
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "fetching".to_string(),
            percent: 0.0,
            message: "Fetching Monero SHA256 hashes…".to_string(),
        },
    );
    let hashes_txt = client
        .get("https://www.getmonero.org/downloads/hashes.txt")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch hashes.txt: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read hashes.txt body: {}", e))?;
    let expected_hash = parse_hash_for_file(&hashes_txt, &filename)
        .ok_or_else(|| {
            format!(
                "No SHA256 found for {} in hashes.txt — release {} may not yet be published \
                 on downloads.getmonero.org. Try again in a few minutes.",
                filename, tag
            )
        })?
        .to_ascii_lowercase();

    // 3. Stream-download with hashing.
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "downloading".to_string(),
            percent: 0.0,
            message: format!("Downloading {}…", filename),
        },
    );
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {} from {}",
            response.status(),
            download_url
        ));
    }
    let total_size = response.content_length().unwrap_or(0);
    let tarball_path = monero_dir.join(&filename);
    let mut file = std::fs::File::create(&tarball_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        let percent = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };
        crate::emit_meter::bump("xmr-download-progress");
        let _ = app.emit(
            "xmr-download-progress",
            XmrDownloadProgress {
                stage: "downloading".to_string(),
                percent,
                message: format!(
                    "Downloading monero-wallet-rpc — {:.1}/{:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            },
        );
    }
    drop(file);

    // 3b. Verify SHA256 before extracting.
    let actual_hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    if actual_hash != expected_hash {
        let _ = std::fs::remove_file(&tarball_path);
        return Err(format!(
            "SHA256 mismatch for {} — expected {}, got {}. Download aborted.",
            filename, expected_hash, actual_hash
        ));
    }

    // 4. Extract via system `tar -xjf` into a staging subdir, then locate
    //    `monero-wallet-rpc` recursively (it lives under a version-pinned
    //    `monero-x86_64-linux-gnu-v…/` directory inside the tarball).
    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "extracting".to_string(),
            percent: 0.0,
            message: "Extracting monero-wallet-rpc…".to_string(),
        },
    );

    let extract_dir = monero_dir.join("_extract");
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    let tar_status = tokio::process::Command::new("tar")
        .arg("-xjf")
        .arg(&tarball_path)
        .arg("-C")
        .arg(&extract_dir)
        .status()
        .await
        .map_err(|e| format!("Failed to spawn tar (is it installed?): {}", e))?;
    if !tar_status.success() {
        let _ = std::fs::remove_file(&tarball_path);
        let _ = std::fs::remove_dir_all(&extract_dir);
        return Err(format!(
            "tar -xjf exited with status {} — archive may be malformed",
            tar_status
        ));
    }

    // Recursive walk for `monero-wallet-rpc`. The tarball's layout is
    // `monero-x86_64-linux-gnu-vX.Y.Z.W/monero-wallet-rpc` so the binary
    // is typically two levels deep.
    fn find_binary(dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            let ft = entry.file_type().ok()?;
            if ft.is_file() && entry.file_name() == name {
                return Some(p);
            }
            if ft.is_dir() {
                if let Some(found) = find_binary(&p, name) {
                    return Some(found);
                }
            }
        }
        None
    }

    let found = find_binary(&extract_dir, "monero-wallet-rpc");
    if let Some(src) = found {
        std::fs::copy(&src, &exe_path)
            .map_err(|e| format!("Failed to copy monero-wallet-rpc into place: {}", e))?;
        // chmod +x — Monero's tarball already marks it executable, but be
        // defensive against any umask weirdness when extracting.
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&exe_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&exe_path, perms);
        }
    } else {
        let _ = std::fs::remove_file(&tarball_path);
        let _ = std::fs::remove_dir_all(&extract_dir);
        return Err(
            "monero-wallet-rpc binary not found inside the extracted tarball".into(),
        );
    }

    let _ = std::fs::remove_dir_all(&extract_dir);
    let _ = std::fs::remove_file(&tarball_path);

    // See the Windows path above — marks this copy as updater-managed.
    crate::sidecar_update::set_installed_version(&monero_dir, &tag);

    crate::emit_meter::bump("xmr-download-progress");
    let _ = app.emit(
        "xmr-download-progress",
        XmrDownloadProgress {
            stage: "complete".to_string(),
            percent: 100.0,
            message: "monero-wallet-rpc ready".to_string(),
        },
    );
    Ok(())
}

/// Check if Windows Defender has an exclusion for the monero binary directory.
#[tauri::command]
pub async fn xmr_check_defender_exclusion(app: AppHandle) -> Result<bool, String> {
    let monero_dir = get_monero_dir(&app)?;
    let monero_path = monero_dir.to_string_lossy().to_string();

    let ps_script = format!(
        r#"
$pref = Get-MpPreference
$targetPath = '{monero_path}'
$targetLower = $targetPath.ToLower().TrimEnd('\').TrimEnd('/')

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

$procMatch = $false
if ($pref.ExclusionProcess) {{
    foreach ($p in $pref.ExclusionProcess) {{
        if ($p.ToLower() -like '*monero-wallet-rpc*') {{
            $procMatch = $true
            break
        }}
    }}
}}

if ($pathMatch -or $procMatch) {{ Write-Output 'true' }} else {{ Write-Output 'false' }}
"#,
        monero_path = monero_path
    );

    let mut cmd = hidden_powershell_command();
    cmd.args(["-Command", &ps_script]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to check Defender exclusions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(stdout.to_lowercase().contains("true"))
}

/// Add Windows Defender exclusion for the monero directory + wallet-rpc exe.
/// Requires UAC elevation — triggers a user consent prompt.
#[tauri::command]
pub async fn xmr_add_defender_exclusion(app: AppHandle) -> Result<bool, String> {
    let monero_dir = get_monero_dir(&app)?;
    let monero_path = monero_dir.to_string_lossy().to_string();
    let exe_path = monero_dir.join("monero-wallet-rpc.exe");

    let script_content = format!(
        "Add-MpPreference -ExclusionPath '{}'\nAdd-MpPreference -ExclusionProcess '{}'",
        monero_path,
        exe_path.to_string_lossy()
    );

    let script_path = monero_dir.join("_defender_setup.ps1");
    std::fs::write(&script_path, &script_content)
        .map_err(|e| format!("Failed to write defender script: {}", e))?;

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

    let _ = std::fs::remove_file(&script_path);

    // Verify
    let mut verify_cmd = hidden_powershell_command();
    verify_cmd.args([
        "-Command",
        &format!(
            "(Get-MpPreference).ExclusionPath -contains '{}'",
            monero_path
        ),
    ]);
    let verify = verify_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to verify Defender exclusion: {}", e))?;

    let stdout = String::from_utf8_lossy(&verify.stdout).trim().to_string();
    Ok(stdout.eq_ignore_ascii_case("true"))
}

// =========================================================================
// Live integration tests
// =========================================================================
//
// These exercise the real Digest-auth flow against a freshly-spawned
// monero-wallet-rpc.exe on a test port. They are `#[ignore]` by default so
// `cargo test` stays fast / hermetic; run explicitly with:
//
//     cargo test --test-threads=1 -- --ignored rpc_live
//
// Requirements: `src-tauri/binaries/monero-wallet-rpc.exe` exists and is a
// real binary (≥ 5 MB). No daemon connection is needed — `get_version`
// works without one.

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_inner_with_child() -> XmrRpcInner {
        // No real Child exists in a unit test — the lease arithmetic only
        // reads `child.is_some()`, so a placeholder standing in for "a
        // process is running" is enough. Spawn a genuinely trivial one
        // rather than reach for `unsafe`/mem::transmute tricks: `tokio`
        // gives us `Command::new` for free, and this process is killed on
        // drop (`kill_on_drop` is set by the real spawn path, not needed
        // here since the test process exits immediately anyway).
        #[cfg(target_os = "windows")]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(target_os = "windows")]
        cmd.args(["/C", "exit"]);
        #[cfg(not(target_os = "windows"))]
        let mut cmd = tokio::process::Command::new("true");
        let child = cmd.spawn().expect("spawn a trivial child for the test");
        XmrRpcInner {
            child: Some(child),
            creds: Some(("u".to_string(), "p".to_string())),
            leases: std::collections::HashSet::new(),
            starting: false,
        }
    }

    /// PWNDA-SINGLE-FLIGHT (incident, 2026-08-23): two callers racing
    /// `xmr_start_rpc` on a fresh app boot both read `child: None` before
    /// either had set it, and both spawned a competing monero-wallet-rpc.exe
    /// on the same port. These pin `decide_xmr_start`'s three-way branch —
    /// the piece of logic that has to be right for the fix to hold — without
    /// needing an `AppHandle` or a real process.
    #[test]
    fn decide_xmr_start_spawns_only_when_neither_running_nor_starting() {
        assert_eq!(
            decide_xmr_start(false, false),
            XmrStartDecision::ShouldSpawn,
            "the ordinary first-caller case must still spawn"
        );
    }

    #[test]
    fn decide_xmr_start_attaches_rather_than_spawns_when_already_running() {
        assert_eq!(decide_xmr_start(true, false), XmrStartDecision::AlreadyRunning);
        // Running always wins even if `starting` was somehow also left set
        // (e.g. a stale flag from a start that crashed before clearing it) —
        // a live child is the stronger fact.
        assert_eq!(decide_xmr_start(true, true), XmrStartDecision::AlreadyRunning);
    }

    #[test]
    fn decide_xmr_start_backs_off_instead_of_racing_a_second_spawn() {
        // THE regression this whole fix exists for: a second caller arriving
        // while the first is still mid-spawn (no child yet, but claimed)
        // must NOT get `ShouldSpawn` — that is exactly the two-processes-on-
        // one-port incident.
        assert_eq!(
            decide_xmr_start(false, true),
            XmrStartDecision::AlreadyStarting,
            "a caller arriving while another is mid-spawn must back off, not race it"
        );
    }

    #[test]
    fn release_lease_does_not_stop_while_another_lease_remains() {
        let mut inner = fresh_inner_with_child();
        inner.leases.insert(XmrLease::Session);
        inner.leases.insert(XmrLease::SwapEngine);

        assert!(
            !inner.release_lease(XmrLease::Session),
            "SwapEngine still holds it — releasing Session must not stop the process"
        );
        assert!(
            inner.leases.contains(&XmrLease::SwapEngine),
            "the remaining lease must survive the release call"
        );
        assert!(
            !inner.leases.contains(&XmrLease::Session),
            "the released lease must actually be removed"
        );
    }

    #[test]
    fn release_lease_stops_once_the_last_lease_is_released() {
        let mut inner = fresh_inner_with_child();
        inner.leases.insert(XmrLease::SwapEngine);

        assert!(
            inner.release_lease(XmrLease::SwapEngine),
            "the last remaining lease must trigger a stop"
        );
        assert!(inner.leases.is_empty());
    }

    #[test]
    fn release_lease_is_a_noop_when_nothing_was_running() {
        // Nothing to have raced with — a stray stop call (e.g. a second
        // click, or a caller whose start attempt already failed) must not
        // report "stop" and go re-run teardown against a process that was
        // never there.
        let mut inner = XmrRpcInner {
            child: None,
            creds: None,
            leases: std::collections::HashSet::new(),
            starting: false,
        };
        inner.leases.insert(XmrLease::Session);
        assert!(!inner.release_lease(XmrLease::Session));
    }

    #[test]
    fn creds_for_spawn_session_always_uses_fresh() {
        let stable = ("stable_u".to_string(), "stable_p".to_string());
        let mut fresh_called = false;
        let (u, p) = creds_for_spawn(XmrLease::Session, Some(&stable), || {
            fresh_called = true;
            ("fresh_u".to_string(), "fresh_p".to_string())
        });
        assert!(fresh_called, "Session must not skip generating fresh creds");
        assert_eq!((u.as_str(), p.as_str()), ("fresh_u", "fresh_p"));
    }

    #[test]
    fn creds_for_spawn_swap_engine_reuses_existing_stable_creds() {
        let stable = ("stable_u".to_string(), "stable_p".to_string());
        let (u, p) = creds_for_spawn(XmrLease::SwapEngine, Some(&stable), || {
            panic!("must not generate fresh creds when a stable pair already exists")
        });
        assert_eq!((u.as_str(), p.as_str()), ("stable_u", "stable_p"));
    }

    #[test]
    fn creds_for_spawn_swap_engine_generates_fresh_when_no_stable_pair_exists() {
        let (u, p) = creds_for_spawn(XmrLease::SwapEngine, None, || {
            ("fresh_u".to_string(), "fresh_p".to_string())
        });
        assert_eq!((u.as_str(), p.as_str()), ("fresh_u", "fresh_p"));
    }

    #[test]
    fn release_lease_of_an_unheld_lease_is_harmless() {
        // Releasing a lease this caller never held (e.g. a double-release,
        // or SwapEngine releasing before it ever acquired) must not stop a
        // process a DIFFERENT lease is still relying on.
        let mut inner = fresh_inner_with_child();
        inner.leases.insert(XmrLease::Session);
        assert!(!inner.release_lease(XmrLease::SwapEngine));
        assert!(
            inner.leases.contains(&XmrLease::Session),
            "an unrelated release must not disturb a lease it doesn't name"
        );
    }

    /// Locate a real wallet-rpc binary. Mirrors resolve_rpc_binary but
    /// without needing a Tauri AppHandle (tests don't have one).
    fn test_binary_path() -> Option<PathBuf> {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("monero-wallet-rpc.exe");
        if is_real_binary(&p) { Some(p) } else { None }
    }

    /// Kill anything currently listening on `port` (typically an orphan
    /// wallet-rpc from a failed earlier test) so our spawn can bind it.
    /// Orphans left over from a failed test will serve stale Digest nonces
    /// that our current-session credentials can't answer.
    async fn kill_listener_on_port(port: u16) {
        #[cfg(target_os = "windows")]
        {
            let script = format!(
                r#"Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue |
                   Select-Object -ExpandProperty OwningProcess -Unique |
                   ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"#,
                port
            );
            let _ = tokio::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }

    /// Ask the test daemon (plain monerod, not wallet-rpc) for its current
    /// chain tip. Returns None if unreachable so tests can fall back to a
    /// sensible default rather than failing on transient network issues.
    async fn probe_daemon_tip() -> Option<u64> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .ok()?;
        let resp = client
            .get("http://xmr.stormycloud.org:18089/get_info")
            .send()
            .await
            .ok()?;
        let body: serde_json::Value = resp.json().await.ok()?;
        body.get("height").and_then(|v| v.as_u64())
    }

    /// Spawn wallet-rpc on `port` with `user:pass` and block until it
    /// accepts HTTP connections on the port (not necessarily our Digest).
    async fn spawn_wallet_rpc(
        binary: &PathBuf,
        port: u16,
        wallet_dir: &PathBuf,
        creds: &(String, String),
    ) -> tokio::process::Child {
        kill_listener_on_port(port).await;
        let log_path = wallet_dir.join("wallet-rpc.log");
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("--rpc-bind-ip")
            .arg("127.0.0.1")
            .arg("--rpc-bind-port")
            .arg(port.to_string())
            .arg("--rpc-login")
            .arg(format!("{}:{}", creds.0, creds.1))
            .arg("--wallet-dir")
            .arg(wallet_dir)
            .arg("--daemon-address")
            .arg("http://xmr.stormycloud.org:18089")
            .arg("--non-interactive")
            .arg("--log-level")
            .arg("1")
            .arg("--log-file")
            .arg(&log_path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.kill_on_drop(true);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        cmd.stdin(std::process::Stdio::null());

        let child = cmd.spawn().expect("spawn wallet-rpc");

        // Poll the raw TCP port until it accepts — faster than waiting for
        // the auth handshake to succeed.
        for _ in 0..80 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                // Give the HTTP server a moment after the bind completes.
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                return child;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        panic!("wallet-rpc did not open port {} within 20s", port);
    }

    /// Full end-to-end: spawn wallet-rpc with random credentials, make a
    /// `get_version` call through the same `do_rpc_call_at` path the app
    /// uses, and verify we get a numeric version back. Regression guard
    /// for the 2026-04-22 GET-vs-POST Digest bug that caused
    /// "monero-wallet-rpc failed to become ready within 15s".
    #[tokio::test]
    #[ignore = "live; spawns monero-wallet-rpc.exe"]
    async fn rpc_live_get_version_with_digest_auth() {
        let binary = match test_binary_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "SKIP: no real monero-wallet-rpc.exe at src-tauri/binaries/. \
                     Drop one in per binaries/README.md and re-run."
                );
                return;
            }
        };

        let tmp = std::env::temp_dir().join(format!(
            "pwnda-xmr-test-{}",
            random_hex(4)
        ));
        std::fs::create_dir_all(&tmp).unwrap();

        let port: u16 = 28082;
        let creds = (random_hex(8), random_hex(8));
        let url = format!("http://127.0.0.1:{}/json_rpc", port);

        let mut child = spawn_wallet_rpc(&binary, port, &tmp, &creds).await;

        let result = do_rpc_call_at(
            &url,
            Some(&creds),
            "get_version",
            serde_json::json!({}),
            std::time::Duration::from_secs(5),
        )
        .await;

        // Clean up whether the assertion passes or fails.
        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(&tmp);

        let value = result.expect("get_version with Digest auth should succeed");
        let version = value
            .get("version")
            .and_then(|v| v.as_u64())
            .expect("version field missing from response");
        assert!(version > 0, "version looked empty: {}", value);
    }

    /// Live test with raw TCP — bypasses reqwest entirely. If reqwest is
    /// somehow mangling the request (header ordering, connection handling,
    /// etc), this isolates it.
    #[tokio::test]
    #[ignore = "live; spawns monero-wallet-rpc.exe"]
    async fn rpc_live_raw_tcp_digest() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let binary = match test_binary_path() {
            Some(p) => p,
            None => return,
        };
        let tmp = std::env::temp_dir().join(format!("pwnda-xmr-raw-{}", random_hex(4)));
        std::fs::create_dir_all(&tmp).unwrap();

        let port: u16 = 28089;
        let creds = ("rawuser".to_string(), "rawpass".to_string());
        let mut child = spawn_wallet_rpc(&binary, port, &tmp, &creds).await;

        // Send probe 1: no auth, expect 401 with WWW-Authenticate.
        let body = r#"{"jsonrpc":"2.0","id":"0","method":"get_version","params":{}}"#;
        let probe = format!(
            "POST /json_rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: keep-alive\r\n\r\n{body}",
            port = port,
            len = body.len(),
            body = body
        );
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        sock.write_all(probe.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.unwrap();
        let probe_resp = String::from_utf8_lossy(&buf[..n]).to_string();
        eprintln!("[raw-debug] probe response (first 400): {}", &probe_resp[..probe_resp.len().min(400)]);

        // Parse first WWW-Authenticate header (MD5, not MD5-sess).
        let challenge = probe_resp
            .lines()
            .find(|l| l.to_lowercase().starts_with("www-authenticate:") && l.contains("algorithm=MD5,"))
            .expect("MD5 challenge")
            .splitn(2, ':')
            .nth(1)
            .unwrap()
            .trim()
            .to_string();

        let cnonce = random_hex(16);
        let auth_header = build_digest_auth_header(
            &challenge, &creds.0, &creds.1, "POST", "/json_rpc", &cnonce, 1,
        )
        .expect("build header");
        eprintln!("[raw-debug] Authorization: {}", auth_header);

        let authed = format!(
            "POST /json_rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
            port = port,
            auth = auth_header,
            len = body.len(),
            body = body
        );
        sock.write_all(authed.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        sock.read_to_end(&mut out).await.unwrap();
        let authed_resp = String::from_utf8_lossy(&out).to_string();

        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(&tmp);

        eprintln!("[raw-debug] authed response (first 400): {}", &authed_resp[..authed_resp.len().min(400)]);
        assert!(
            authed_resp.starts_with("HTTP/1.1 200") || authed_resp.starts_with("HTTP/1.1 200 Ok"),
            "raw TCP digest should succeed"
        );
    }

    /// End-to-end: replay the full polyseed init sequence through our
    /// Digest-auth `do_rpc_call_at` (not raw TCP). This exercises every
    /// JSON-RPC method the polyseed code path depends on:
    ///
    ///   generate_from_keys → get_address → auto_refresh → get_height
    ///   (polled) → close_wallet → generate_from_keys (regenerate after
    ///   self-heal delete)
    ///
    /// Regression guard for the user-reported "sync no longer works since
    /// migrating from 25 word seed to polyseed" bug. If the standalone
    /// `scripts/polyseed-sync.mjs` (direct HTTP, no auth) passes but this
    /// one fails, the bug is in our Digest bridge, not the protocol.
    #[tokio::test]
    #[ignore = "live; spawns monero-wallet-rpc.exe + uses a public daemon"]
    async fn rpc_live_polyseed_full_flow() {
        let binary = match test_binary_path() {
            Some(p) => p,
            None => {
                eprintln!("SKIP: no real monero-wallet-rpc.exe");
                return;
            }
        };

        let tmp = std::env::temp_dir().join(format!("pwnda-xmr-poly-{}", random_hex(4)));
        std::fs::create_dir_all(&tmp).unwrap();

        let port: u16 = 28092;
        let creds = (random_hex(8), random_hex(8));
        let url = format!("http://127.0.0.1:{}/json_rpc", port);

        let mut child = spawn_wallet_rpc(&binary, port, &tmp, &creds).await;

        // --- Hard-coded polyseed-derived keys (from scripts/polyseed-e2e.mjs
        //     reference phrase "raven tail swear ... language") ---
        //
        // If these ever drift, the e2e script should be run to regenerate:
        //     npx tsx scripts/polyseed-e2e.mjs
        //
        // Using a known reference avoids having to run PBKDF2 / key derivation
        // inside Rust tests.
        let address = "47AjPj7DVPQVGGXJXbbTMZWcKQDejGHYZChVkeujy8qPLjKkgdsxge4DzvkRMgU4sDUigGLuBN9stKBMowhuXH2HJHWAuRf";
        let spendkey = "6dd6b2029bfdf1c44a36ce8b229f35dcaa5800b8d858da9facf4b0a778dc2800";
        let viewkey = "3c56a3cc3e7f94dc428ffe3b856adb6054552dfa14360d4cdec3f7730b999107";

        // Probe the daemon so we can use a restore height within a few
        // hundred blocks of the current tip. This mirrors the production
        // "fresh polyseed wallet" case and keeps the test fast (scanning
        // 500K historical blocks on a remote node takes many minutes and
        // makes this test too flaky to live-run in CI).
        let tip = probe_daemon_tip().await.unwrap_or(3_600_000);
        let restore_height: u64 = tip.saturating_sub(500);

        let timeout = std::time::Duration::from_secs(30);

        // Step 1: generate_from_keys (equivalent of `initXmrSession` polyseed restore path)
        let gen = do_rpc_call_at(
            &url,
            Some(&creds),
            "generate_from_keys",
            serde_json::json!({
                "filename": "polyflow-test",
                "password": "",
                "restore_height": restore_height,
                "address": address,
                "viewkey": viewkey,
                "spendkey": spendkey,
                "language": "English",
                "autosave_current": true,
            }),
            timeout,
        )
        .await;
        let gen_result = match gen {
            Ok(v) => v,
            Err(e) => {
                let _ = child.kill().await;
                let _ = std::fs::remove_dir_all(&tmp);
                panic!("generate_from_keys failed: {}", e);
            }
        };
        eprintln!("[polyflow] generate_from_keys = {}", gen_result);

        // Step 2: get_address must return the same address we passed in.
        let addr = do_rpc_call_at(
            &url,
            Some(&creds),
            "get_address",
            serde_json::json!({ "account_index": 0 }),
            timeout,
        )
        .await
        .expect("get_address");
        assert_eq!(
            addr.get("address").and_then(|v| v.as_str()),
            Some(address),
            "wallet-rpc address doesn't match the one passed to generate_from_keys"
        );

        // Step 3: auto_refresh must succeed.
        let ar = do_rpc_call_at(
            &url,
            Some(&creds),
            "auto_refresh",
            serde_json::json!({ "enable": true, "period": 10 }),
            timeout,
        )
        .await
        .expect("auto_refresh");
        eprintln!("[polyflow] auto_refresh = {}", ar);

        // Step 4: poll get_height with a generous window. Monero wallet-rpc
        // reports height=1 until its first refresh cycle completes — during
        // that cycle every other RPC call queues behind the wallet mutex.
        // We accept EITHER an advancing height OR a completed refresh (we
        // scrape the log afterwards) as proof that scanning works.
        //
        // Fixed 60s window: long enough for a 500-block near-tip scan to
        // complete on a reasonably-responsive remote node.
        let mut saw_advance = false;
        let mut last_height: u64 = 0;
        for i in 0..12 {
            let h = do_rpc_call_at(
                &url,
                Some(&creds),
                "get_height",
                serde_json::json!({}),
                std::time::Duration::from_secs(5),
            )
            .await;
            match h {
                Ok(v) => {
                    let n = v.get("height").and_then(|x| x.as_u64()).unwrap_or(0);
                    eprintln!("[polyflow] height t={}s: {}", i * 5, n);
                    if n > 1 {
                        saw_advance = true;
                        last_height = n;
                        break;
                    }
                    last_height = n;
                }
                Err(e) => eprintln!("[polyflow] height t={}s: ERR {}", i * 5, e),
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }

        // Step 5: get_balance works after restore.
        let bal = do_rpc_call_at(
            &url,
            Some(&creds),
            "get_balance",
            serde_json::json!({ "account_index": 0 }),
            timeout,
        )
        .await;

        // Step 6: close_wallet must succeed (needed for self-heal delete).
        let close = do_rpc_call_at(
            &url,
            Some(&creds),
            "close_wallet",
            serde_json::json!({}),
            timeout,
        )
        .await;

        // Step 7: simulate delete + regenerate (the self-heal path).
        let mut delete_ok = true;
        for suffix in &["", ".keys", ".address.txt"] {
            let p = tmp.join(format!("polyflow-test{}", suffix));
            if p.exists() {
                if std::fs::remove_file(&p).is_err() {
                    delete_ok = false;
                }
            }
        }

        // Give wallet-rpc a moment to release any file handles.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let regen = do_rpc_call_at(
            &url,
            Some(&creds),
            "generate_from_keys",
            serde_json::json!({
                "filename": "polyflow-test",
                "password": "",
                "restore_height": restore_height,
                "address": address,
                "viewkey": viewkey,
                "spendkey": spendkey,
                "language": "English",
                "autosave_current": true,
            }),
            timeout,
        )
        .await;

        // Cleanup BEFORE asserting so a failure doesn't leak the process.
        let _ = child.kill().await;
        let _ = child.wait().await;

        // If get_height never advanced past 1, check the log for a completed
        // refresh — that's proof the wallet is actually scanning even though
        // get_height hasn't caught up. This is the "first refresh cycle
        // behavior" documented in the Monero entity wiki page.
        let log_path = tmp.join("wallet-rpc.log");
        let mut refresh_completed = false;
        if let Ok(log) = std::fs::read_to_string(&log_path) {
            refresh_completed = log.contains("Refresh done, blocks received");
        }
        let advanced = saw_advance || refresh_completed;
        eprintln!(
            "[polyflow] advanced={} (height>1: {}, refresh-in-log: {})",
            advanced, saw_advance, refresh_completed
        );
        let _ = last_height;

        if let Ok(log) = std::fs::read_to_string(&log_path) {
            // Filter to the interesting lines so the test output stays parseable.
            let filtered: Vec<&str> = log
                .lines()
                .filter(|l| {
                    l.contains("Calling RPC method")
                        || l.contains("Refresh done")
                        || l.contains("setting daemon")
                        || l.contains("error")
                        || l.contains("ERROR")
                        || l.contains("restore_height")
                        || l.contains("scan height")
                        || l.contains("generate_from_keys")
                        || l.contains("get_height")
                        || l.contains("auto_refresh")
                        || l.contains("file_exists")
                })
                .collect();
            eprintln!(
                "[polyflow] wallet-rpc.log filtered ({} lines):\n{}",
                filtered.len(),
                filtered.join("\n")
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(
            advanced,
            "no scan progression observed (height advance OR log refresh) in 60s"
        );
        assert!(bal.is_ok(), "get_balance errored: {:?}", bal);
        assert!(close.is_ok(), "close_wallet errored: {:?}", close);
        assert!(delete_ok, "wallet file deletion failed");
        assert!(
            regen.is_ok(),
            "generate_from_keys after delete errored: {:?}",
            regen
        );
    }

    /// Unit test: verify the MD5 response math against a known-good
    /// curl-generated digest response. If this passes but the live test
    /// still 401s, the bug is on the wire, not in our hashing.
    #[test]
    fn digest_response_matches_curl() {
        let challenge =
            r#"Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="E4d2XuRWq9WTxMQ7AzjqwA==",stale=false"#;
        let header = build_digest_auth_header(
            challenge,
            "test",
            "abc123",
            "POST",
            "/json_rpc",
            "3a2bd8223f85725ffad16f373fb8ce9d",
            1,
        )
        .expect("header build");
        // Expected MD5 response from a working curl --digest request (verified
        // with Python hashlib — see test setup notes in log).
        assert!(
            header.contains(r#"response="0134e6aa709533f02eac04d9d8e55448""#),
            "response hash mismatch; header was: {}",
            header
        );
    }

    /// Negative test: wrong password must NOT be accepted.
    #[tokio::test]
    #[ignore = "live; spawns monero-wallet-rpc.exe"]
    async fn rpc_live_wrong_password_rejected() {
        let binary = match test_binary_path() {
            Some(p) => p,
            None => return,
        };

        let tmp = std::env::temp_dir().join(format!(
            "pwnda-xmr-test-{}",
            random_hex(4)
        ));
        std::fs::create_dir_all(&tmp).unwrap();

        let port: u16 = 28083;
        let creds = (random_hex(8), random_hex(8));
        let wrong = (creds.0.clone(), "definitely-not-the-password".to_string());
        let url = format!("http://127.0.0.1:{}/json_rpc", port);

        let mut child = spawn_wallet_rpc(&binary, port, &tmp, &creds).await;

        let result = do_rpc_call_at(
            &url,
            Some(&wrong),
            "get_version",
            serde_json::json!({}),
            std::time::Duration::from_secs(5),
        )
        .await;

        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(
            result.is_err(),
            "wrong password must be rejected, got: {:?}",
            result
        );
    }
}
