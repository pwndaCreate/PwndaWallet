//! Shared wallet-rpc sidecar plumbing.
//!
//! Zephyr is a Monero-lineage fork (Monero → Haven → Zephyr) and its
//! `zephyr-wallet-rpc.exe` speaks the same HTTP Digest + JSON-RPC
//! protocol as `monero-wallet-rpc.exe`. This module holds the pieces
//! both sidecar managers need: raw-TCP HTTP/1.1 with Digest auth,
//! TCP-level port check, free-port selection, pidfile I/O, PID-precise
//! process kill, and log-tail extraction for error messages.
//!
//! The image-name taskkill sweep, the netstat PID lookup and the
//! wait-for-port-to-free poller were removed 2026-08-13. Once the sidecars
//! fall back to an ephemeral port (`pick_free_port`) instead of insisting on
//! 18082/18083, there is nothing to evict and nothing to wait for — and the
//! by-image kill was terminating same-named processes owned by other apps.
//!
//! `xmr_rpc.rs` currently keeps its own private copies of these
//! helpers for stability reasons — the Monero code is proven and a
//! mass refactor during Zephyr integration would widen the blast
//! radius unnecessarily. A follow-up can collapse Monero onto this
//! module once both chains have soaked.

use md5::Md5;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

// =========================================================================
// Small utilities
// =========================================================================

/// Generate a random lowercase hex string of `n` bytes (2n characters).
pub fn random_hex(n: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..n).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

/// MD5 hex digest of the given bytes. Used for HTTP Digest auth (RFC 7616).
pub fn md5_hex(data: &[u8]) -> String {
    let mut h = Md5::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

// =========================================================================
// HTTP Digest authentication
// =========================================================================

/// Extract a quoted or unquoted field value from a single `WWW-Authenticate`
/// challenge string.
pub fn parse_digest_field(challenge: &str, field: &str) -> Option<String> {
    let needle = format!("{}=", field);
    let rest = challenge.splitn(2, &needle).nth(1)?;
    let trimmed = rest.trim_start();
    if let Some(stripped) = trimmed.strip_prefix('"') {
        stripped.split('"').next().map(|s| s.to_string())
    } else {
        let end = trimmed
            .find(|c: char| c == ',' || c.is_whitespace())
            .unwrap_or(trimmed.len());
        Some(trimmed[..end].to_string())
    }
}

/// Build an RFC 7616 HTTP Digest `Authorization` header value for a POST.
///
/// Monero/Haven/Zephyr's wallet-rpc is strict about formatting — fields
/// are formatted the same way curl does: `qop="auth"` quoted, `nc`
/// lowercase, `algorithm=MD5`, and `response` quoted. Only supports
/// `algorithm=MD5` and `qop=auth`; bails with an explicit error if the
/// challenge advertises anything else so a regression doesn't silently
/// re-fail.
pub fn build_digest_auth_header(
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
    let response = md5_hex(format!("{}:{}:{}:{}:auth:{}", ha1, nonce, nc_hex, cnonce, ha2).as_bytes());

    Ok(format!(
        r#"Digest username="{user}",realm="{realm}",nonce="{nonce}",uri="{uri}",cnonce="{cnonce}",nc={nc_hex},qop="auth",algorithm=MD5,response="{response}""#,
    ))
}

// =========================================================================
// Raw TCP HTTP/1.1 with Digest auth retry on same socket
// =========================================================================

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

/// Parsed URL components for a loopback JSON-RPC endpoint.
pub fn split_loopback_url(url: &str) -> Result<(String, u16, String), String> {
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
/// stream. Only handles fixed Content-Length bodies — that is what Epee's
/// HTTP server always sends.
pub async fn read_http_response(
    sock: &mut tokio::net::TcpStream,
    timeout_dur: std::time::Duration,
) -> Result<(u16, Vec<(String, String)>, String), String> {
    use tokio::io::AsyncReadExt;

    let fut = async {
        let mut buf = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];

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

/// Core JSON-RPC HTTP call with HTTP Digest auth, using raw TCP so the
/// authenticated retry stays on the same socket (Epee's Digest nonces
/// are connection-scoped — reqwest's pooling breaks that invariant).
pub async fn do_rpc_call_at(
    url: &str,
    creds: Option<&(String, String)>,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
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

    if !(200..300).contains(&status) {
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

// =========================================================================
// Port + pidfile + process-kill helpers
// =========================================================================

/// TCP-level port-in-use check. Returns true iff something is accepting
/// connections on `127.0.0.1:port`. The old HTTP ping was unreliable under
/// scan load — a wallet-rpc busy scanning could take longer than 1 sec to
/// answer an unauthenticated POST, making HTTP-level probing falsely
/// report the port as free and triggering a bind-failure spawn.
pub async fn port_is_bound(port: u16) -> bool {
    tokio::time::timeout(
        std::time::Duration::from_millis(500),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// Pick a loopback port for a wallet-rpc sidecar: `preferred` when it's free,
/// otherwise an OS-assigned ephemeral one.
///
/// Mirrors `miners::pick_xmrig_http_port`, which has used this shape since the
/// orphan-miner-squatting fix.
///
/// Why the sidecars need it (2026-08-13): the canonical ports were hardcoded —
/// 18082 for Monero, 18083 for Zephyr — and 18082 is *Monero's own default
/// ZMQ-RPC port* (mainnet P2P 18080 / RPC 18081 / ZMQ-RPC 18081+1). So any user
/// running a local `monerod` — precisely the run-your-own-node audience a Monero
/// wallet attracts — had our Monero sidecar collide with their daemon's ZMQ
/// socket, and 18083 collide with a second wallet-rpc, on every platform. The
/// app would wait 8s for a port that was never going to free, then fail.
///
/// Binding to port 0 asks the kernel for a free port; we drop the listener
/// immediately and hand the number to the sidecar. There is a benign race — the
/// port could be taken in the gap — but the sidecar's own bind failure surfaces
/// as a normal spawn error, and the window is microseconds.
pub fn pick_free_port(preferred: u16) -> u16 {
    use std::net::TcpListener;
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

pub fn read_pidfile(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

pub fn write_pidfile(path: &PathBuf, pid: u32) {
    let _ = std::fs::write(path, pid.to_string());
}

pub fn delete_pidfile(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

/// Persist per-session wallet-rpc Digest credentials so the *next* session
/// can gracefully stop an orphaned sidecar (Ctrl+C in `tauri dev`, app
/// crash, OS hard-kill — anywhere the current session couldn't run its own
/// teardown). Without this, the next session's cleanup code tries an
/// unauthenticated `stop_wallet`, wallet-rpc rejects it with 401, cleanup
/// falls through to `taskkill /F`, and any unwritten scan progress is lost
/// — reverting the on-disk wallet back to its last autosave, often all the
/// way to `restore_height`.
///
/// The file is a single line `user:pass` written next to the pidfile in the
/// wallet directory. Random 32-hex-char strings that rotate every session,
/// so the only value is authing the *specific* wallet-rpc we started last
/// time — which is already listening on localhost. Deleted on clean stop.
pub fn read_creds_file(path: &PathBuf) -> Option<(String, String)> {
    let s = std::fs::read_to_string(path).ok()?;
    let line = s.trim();
    let (user, pass) = line.split_once(':')?;
    if user.is_empty() || pass.is_empty() {
        return None;
    }
    Some((user.to_string(), pass.to_string()))
}

pub fn write_creds_file(path: &PathBuf, user: &str, pass: &str) {
    let _ = std::fs::write(path, format!("{}:{}", user, pass));
}

pub fn delete_creds_file(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

/// Force-kill a specific PID by number, no image filter. Used by the
/// netstat fallback path. Returns the taskkill exit code.
#[cfg(target_os = "windows")]
pub async fn kill_pid_force(pid: u32) -> Result<i32, String> {
    let mut cmd = tokio::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/F"]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("taskkill /PID spawn failed: {}", e))?;
    Ok(output.status.code().unwrap_or(-1))
}

// =========================================================================
// Log tail (for surfacing sidecar bind errors etc. to the user)
// =========================================================================

/// Read the last `max_bytes` of a log file, trimming any half-line prefix
/// we landed in the middle of. Used to attach real failure reasons
/// (e.g. `FATAL Failed to bind IPv4`) to "failed to become ready" errors.
pub fn read_log_tail(path: &PathBuf, max_bytes: u64) -> String {
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
    match text.find('\n') {
        Some(i) if start > 0 => text[i + 1..].to_string(),
        _ => text,
    }
}

// =========================================================================
// Monero-compatible /get_info probe (Zephyr's is byte-compatible)
// =========================================================================

/// Result of probing a Monero-compatible daemon's `/get_info` endpoint.
#[derive(Clone, Serialize)]
pub struct NodeProbeResult {
    pub url: String,
    pub ok: bool,
    pub latency_ms: Option<u32>,
    pub height: Option<u64>,
    pub error: Option<String>,
}

/// Probe `/get_info` of any Monero-compatible daemon (Monero, Haven, Zephyr).
///
/// Goes through reqwest rather than a renderer-side `fetch()` so the call
/// isn't subject to CORS — the webview origin is `tauri://localhost` and
/// most public Monero/Zephyr nodes omit `Access-Control-Allow-Origin`,
/// meaning renderer fetches silently fail on ~80% of the pool. Rust's
/// reqwest isn't subject to CORS.
pub async fn probe_node(url: String, timeout_ms: u64) -> NodeProbeResult {
    let clean_url = url.trim_end_matches('/').to_string();
    let endpoint = format!("{}/get_info", clean_url);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return NodeProbeResult {
                url,
                ok: false,
                latency_ms: None,
                height: None,
                error: Some(format!("client build: {}", e)),
            };
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
            return NodeProbeResult {
                url,
                ok: false,
                latency_ms: None,
                height: None,
                error: Some(msg),
            };
        }
    };
    let latency_ms = start.elapsed().as_millis() as u32;
    let status = resp.status();

    if !status.is_success() {
        return NodeProbeResult {
            url,
            ok: false,
            latency_ms: Some(latency_ms),
            height: None,
            error: Some(format!("HTTP {}", status.as_u16())),
        };
    }

    let height = match resp.text().await {
        Ok(body) => serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("height").and_then(|h| h.as_u64())),
        Err(_) => None,
    };

    NodeProbeResult {
        url,
        ok: true,
        latency_ms: Some(latency_ms),
        height,
        error: None,
    }
}

// =========================================================================
// Live-network tests — run with `cargo test -- --ignored --nocapture`
// =========================================================================
//
// These hit the real public Zephyr mainnet nodes, so they require network
// and may flake when a node is temporarily down. Gated behind `#[ignore]`
// so they don't run in normal `cargo test`.

#[cfg(test)]
mod tests {
    use super::*;

    /// `sidecar_naming` is the whole point of the zano generalization — pin the
    /// mapping so a future edit cannot silently make zano look for the wrong
    /// file. No I/O; runs everywhere.
    #[test]
    fn sidecar_naming_maps_each_id() {
        assert_eq!(
            sidecar_naming("monero").unwrap(),
            ("monero-wallet-rpc".to_string(), "monero-wallet-rpc".to_string())
        );
        assert_eq!(
            sidecar_naming("zephyr").unwrap(),
            ("zephyr-wallet-rpc".to_string(), "zephyr-wallet-rpc".to_string())
        );
        // The asymmetric one: bundle name != binary name.
        assert_eq!(
            sidecar_naming("zano").unwrap(),
            ("zano-simplewallet".to_string(), "simplewallet".to_string())
        );
        assert!(sidecar_naming("dogecoin").is_err());
    }

    /// End-to-end proof of the bundled Zano path against a REAL fixture.
    /// `#[ignore]` because it needs a ~16 MB `zano-simplewallet.gz` + a
    /// `sidecars.json` with a `zano` entry under `<DIR>/binaries/`:
    ///   PWNDA_ZANO_BUNDLE_RES=<DIR> cargo test --features full --lib \
    ///     wallet_rpc_common::tests::live_zano_bundle_extract -- --ignored --nocapture
    #[test]
    #[ignore = "needs a real zano-simplewallet.gz + sidecars.json; set PWNDA_ZANO_BUNDLE_RES"]
    fn live_zano_bundle_extract() {
        let resource = std::path::PathBuf::from(
            std::env::var("PWNDA_ZANO_BUNDLE_RES").expect("PWNDA_ZANO_BUNDLE_RES"),
        );
        let dest = std::env::temp_dir().join(format!("pwnda-zano-x-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        let out = extract_bundled_sidecar(&resource, &dest, "zano").expect("extract zano");
        assert!(out.ends_with(format!("simplewallet{}", crate::platform::EXE_SUFFIX)));
        assert!(
            std::fs::metadata(&out).map(|m| m.len() >= 10 * 1024 * 1024).unwrap_or(false),
            "extracted simplewallet is too small"
        );
        println!("live zano bundle extract OK -> {}", out.display());
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// P3 (2026-08-18): `tasklist` prints its no-match notice to **stdout**,
    /// and the old parser returned that sentence as an image name, so every
    /// dead PID looked alive. Pin both directions.
    ///
    /// Not `#[ignore]`d: it shells out to `tasklist` only, needs no network and
    /// spawns nothing of ours.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn pid_image_name_returns_none_for_a_dead_pid() {
        // u32::MAX is not a valid Windows PID (they are multiples of 4 and far
        // smaller), so tasklist is guaranteed to match nothing.
        let img = crate::platform::pid_image_name(u32::MAX).await;
        assert!(
            img.is_none(),
            "a non-existent PID must be None, got {:?} — the tasklist \
             \"INFO: No tasks are running…\" line is being parsed as an image name",
            img
        );

        // The positive direction, so the fix cannot be "always return None".
        let me = crate::platform::pid_image_name(std::process::id())
            .await
            .expect("our own PID must resolve to an image name");
        assert!(
            me.to_ascii_lowercase().ends_with(".exe"),
            "expected an .exe image name for our own process, got {:?}",
            me
        );
    }

    const ZEPHYR_NODES: &[&str] = &[
        "http://remote-node.zephyrprotocol.com:17767",
        "http://node.zeph.network:80",
        "https://node.zeph.network:443",
    ];

    const MONERO_NODES: &[&str] = &[
        "http://xmr-node.cakewallet.com:18081",
        "http://node.sethforprivacy.com:18089",
    ];

    /// Every listed Zephyr node must answer `/get_info` with a 200 and a
    /// non-zero block height. Verifies: reqwest path, `get_info` endpoint
    /// layout is Monero-compatible on Zephyr, JSON height extraction works,
    /// latency is captured.
    #[tokio::test]
    #[ignore]
    async fn probe_live_zephyr_nodes() {
        let mut ok_count = 0;
        for url in ZEPHYR_NODES {
            let r = probe_node(url.to_string(), 10_000).await;
            println!(
                "[zephyr] {} ok={} latency={:?}ms height={:?} error={:?}",
                r.url, r.ok, r.latency_ms, r.height, r.error
            );
            if r.ok {
                ok_count += 1;
                assert!(r.latency_ms.is_some(), "latency missing for {}", url);
                assert!(r.latency_ms.unwrap() < 10_000, "unreasonable latency for {}", url);
                assert!(
                    r.height.is_some() && r.height.unwrap() > 700_000,
                    "height missing or absurd for {}: {:?}",
                    url,
                    r.height
                );
            }
        }
        assert!(
            ok_count >= 2,
            "Expected at least 2 of {} Zephyr nodes to be reachable, got {}. \
             If this fails consistently, the baked-in default pool in \
             src/wallets/zph-nodes-default.ts needs re-curation.",
            ZEPHYR_NODES.len(),
            ok_count
        );
    }

    /// Monero probe through the same helper — proves `probe_node` is
    /// chain-agnostic as claimed (Zephyr's `/get_info` is byte-compatible
    /// with Monero's).
    #[tokio::test]
    #[ignore]
    async fn probe_live_monero_nodes() {
        let mut ok_count = 0;
        for url in MONERO_NODES {
            let r = probe_node(url.to_string(), 10_000).await;
            println!(
                "[monero] {} ok={} latency={:?}ms height={:?} error={:?}",
                r.url, r.ok, r.latency_ms, r.height, r.error
            );
            if r.ok {
                ok_count += 1;
            }
        }
        assert!(ok_count >= 1, "at least one Monero node must be reachable");
    }

    /// Unreachable URL must return `ok=false` with an error message, not panic.
    #[tokio::test]
    #[ignore]
    async fn probe_unreachable_returns_error() {
        let r = probe_node(
            "http://definitely-not-a-real-host-12345.invalid:17767".to_string(),
            3_000,
        )
        .await;
        assert!(!r.ok, "expected ok=false for unreachable host");
        assert!(r.error.is_some(), "expected error message");
        println!("unreachable error: {}", r.error.unwrap());
    }

    /// `pick_free_port` returns the preferred port when it's actually free.
    #[test]
    fn pick_free_port_prefers_the_requested_port() {
        // Ask the OS for a port, release it, then confirm we get it back.
        let free = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        assert_eq!(pick_free_port(free), free);
    }

    /// The whole point: an occupied preferred port yields a DIFFERENT, usable
    /// port rather than a failure. This is the 18082-collision case — Monero's
    /// own ZMQ-RPC default sits there whenever a local monerod is running.
    #[test]
    fn pick_free_port_falls_back_when_preferred_is_taken() {
        // Hold the port for the duration of the test.
        let hog = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = hog.local_addr().unwrap().port();

        let picked = pick_free_port(taken);
        assert_ne!(picked, taken, "must not hand back an occupied port");
        assert_ne!(picked, 0, "0 is not a usable port number");
        assert!(
            std::net::TcpListener::bind(("127.0.0.1", picked)).is_ok(),
            "fallback port {} should itself be bindable",
            picked
        );
        drop(hog);
    }

    /// TCP-level port check: nothing listening on 127.0.0.1:1 (reserved).
    #[tokio::test]
    #[ignore]
    async fn port_is_bound_false_when_nothing_listening() {
        assert!(!port_is_bound(1).await);
    }

    /// Digest header builder is deterministic for fixed inputs — pinned
    /// against the wire format we know monero-wallet-rpc / zephyr-wallet-rpc
    /// accepts (quoted qop, lowercase nc, algorithm=MD5).
    #[test]
    fn digest_header_formatting_is_pinned() {
        let h = build_digest_auth_header(
            r#"Digest realm="wallet-rpc",nonce="abc123",qop="auth",algorithm=MD5"#,
            "user",
            "pass",
            "POST",
            "/json_rpc",
            "aaaa",
            1,
        )
        .unwrap();
        // Must have quoted qop="auth", lowercase nc, algorithm=MD5 unquoted.
        assert!(h.contains(r#"qop="auth""#), "qop quoting broken: {}", h);
        assert!(h.contains("nc=00000001"), "nc lowercase 8-digit broken: {}", h);
        assert!(h.contains("algorithm=MD5"), "algorithm broken: {}", h);
        assert!(h.contains(r#"username="user""#));
        assert!(h.contains(r#"realm="wallet-rpc""#));
        assert!(h.contains(r#"nonce="abc123""#));
        assert!(h.contains(r#"uri="/json_rpc""#));
        assert!(h.contains(r#"cnonce="aaaa""#));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Bundled sidecar extraction (2026-07-07)
// ─────────────────────────────────────────────────────────────────────────
//
// The Monero / Zephyr wallet-rpc binaries ship INSIDE the installer as gzip
// payloads under `<resource_dir>/binaries/` (staged at release time by
// `scripts/fetch-sidecars.mjs`, wired via `bundle.resources`). Unlike the
// miners — which trip coin-miner AV heuristics and stay download-on-demand —
// these are wallet sidecars, a materially lower risk class, and bundling them
// makes the XMR/ZPH sections work out of the box instead of forcing an 88 MB /
// 44 MB first-use download from a third-party host.
//
// The payload stays COMPRESSED AND DORMANT: it is never decompressed and never
// executed unless the user actually opens that chain. `extract_bundled_sidecar`
// is the moment it wakes up.

/// One sidecar's entry in `binaries/sidecars.json`.
#[derive(Deserialize, Clone)]
pub struct SidecarEntry {
    /// Upstream release tag the payload was built from (e.g. "v0.18.5.1").
    /// This is the anchor the background updater compares against upstream.
    pub version: String,
    /// Platform-correct binary name inside the payload ("…-wallet-rpc[.exe]").
    pub binary: String,
    /// SHA256 of the UNCOMPRESSED binary. Verified after gunzip, before the
    /// bytes are ever written to disk as an executable.
    pub sha256: String,
}

/// Manifest emitted alongside the payloads by `scripts/fetch-sidecars.mjs`.
#[derive(Deserialize)]
pub struct SidecarManifest {
    /// "win32" | "linux" — lets us reject a payload staged for the wrong OS
    /// (the fetch script writes one fixed path per sidecar and swaps the
    /// CONTENT per target, which is how we sidestep Tauri 2's lack of
    /// per-OS `resources`).
    pub platform: String,
    pub monero: Option<SidecarEntry>,
    pub zephyr: Option<SidecarEntry>,
    /// Zano's `simplewallet` — bundled the same way as Monero/Zephyr so a
    /// blocked network at import does not strand it (2026-08-28). Unlike the
    /// other two it is NOT a `-wallet-rpc` binary; see `sidecar_naming`.
    pub zano: Option<SidecarEntry>,
}

/// Map a sidecar id to its `(gz basename, binary basename)`.
///
/// Monero and Zephyr both ship a `<id>-wallet-rpc` binary, so the id doubles as
/// the name. Zano breaks that symmetry — its binary is `simplewallet`, not
/// `zano-wallet-rpc` — which is exactly the naming assumption that has to be a
/// lookup rather than a `format!("{id}-wallet-rpc")` in two places.
fn sidecar_naming(which: &str) -> Result<(String, String), String> {
    match which {
        "monero" | "zephyr" => {
            Ok((format!("{which}-wallet-rpc"), format!("{which}-wallet-rpc")))
        }
        "zano" => Ok(("zano-simplewallet".to_string(), "simplewallet".to_string())),
        other => Err(format!("unknown sidecar '{other}'")),
    }
}

/// Platform tag as written by the fetch script.
fn current_platform_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// Read the manifest and pull out one sidecar's entry, rejecting a payload
/// staged for a different OS.
///
/// Shared by `extract_bundled_sidecar` and the background updater, which needs
/// the version without paying to decompress ~60 MB just to read it.
fn bundled_sidecar_entry(
    resource_dir: &PathBuf,
    which: &str,
) -> Result<SidecarEntry, String> {
    let manifest_raw =
        std::fs::read_to_string(resource_dir.join("binaries").join("sidecars.json"))
            .map_err(|e| format!("no bundled sidecar manifest: {}", e))?;
    let manifest: SidecarManifest = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("malformed sidecar manifest: {}", e))?;

    if manifest.platform != current_platform_tag() {
        return Err(format!(
            "bundled sidecars are for '{}' but this build is '{}' — ignoring",
            manifest.platform,
            current_platform_tag()
        ));
    }

    let entry = match which {
        "monero" => manifest.monero,
        "zephyr" => manifest.zephyr,
        "zano" => manifest.zano,
        other => return Err(format!("unknown sidecar '{}'", other)),
    }
    .ok_or_else(|| format!("no bundled '{}' sidecar in manifest", which))?;

    // Cross-check the payload's binary name against what THIS platform expects,
    // so a stale/mis-staged archive self-corrects to the download path.
    let (_gz_base, bin_base) = sidecar_naming(which)?;
    let expected_name = format!("{}{}", bin_base, crate::platform::EXE_SUFFIX);
    if entry.binary != expected_name {
        return Err(format!(
            "bundled '{}' payload holds '{}' but this platform needs '{}'",
            which, entry.binary, expected_name
        ));
    }

    Ok(entry)
}

/// Version tag of the bundled `which` payload, or `None` when this build
/// staged nothing usable for it. Used by the background updater to decide
/// whether the installer has superseded the copy in app-data.
pub fn bundled_sidecar_version(resource_dir: &PathBuf, which: &str) -> Option<String> {
    bundled_sidecar_entry(resource_dir, which)
        .ok()
        .map(|e| e.version)
}

/// Decompress the bundled `which` ("monero" | "zephyr") sidecar into
/// `dest_dir` and return the extracted binary's path.
///
/// Safety properties, in order:
///   1. Manifest platform must match this OS — a mismatched payload is
///      ignored rather than written (caller then falls back to downloading).
///   2. The gunzipped bytes are SHA256-verified against the manifest BEFORE
///      anything is written, so a corrupt or tampered payload never lands on
///      disk as an executable.
///   3. A `.sidecar-version` marker is written next to the binary so the
///      updater can compare versions without executing it.
///
/// Returns `Err` for every "not available / not usable" case; callers treat
/// that as "fall through to the network download", never as a hard failure.
pub fn extract_bundled_sidecar(
    resource_dir: &PathBuf,
    dest_dir: &PathBuf,
    which: &str,
) -> Result<PathBuf, String> {
    use std::io::Read;

    // Platform match + binary-name cross-check happen here.
    let entry = bundled_sidecar_entry(resource_dir, which)?;

    let (gz_base, _bin_base) = sidecar_naming(which)?;
    let gz_path = resource_dir
        .join("binaries")
        .join(format!("{}.gz", gz_base));
    let file = std::fs::File::open(&gz_path)
        .map_err(|e| format!("bundled {} payload unreadable: {}", which, e))?;
    let mut decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut bytes = Vec::new();
    decoder
        .read_to_end(&mut bytes)
        .map_err(|e| format!("failed to decompress bundled {}: {}", which, e))?;

    // Verify BEFORE writing an executable to disk.
    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    let got = hex::encode(hasher.finalize());
    if got != entry.sha256 {
        return Err(format!(
            "bundled {} payload FAILED integrity check (expected {}, got {}) — refusing to write it",
            which, entry.sha256, got
        ));
    }

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("cannot create {}: {}", dest_dir.display(), e))?;
    let out_path = dest_dir.join(&entry.binary);
    std::fs::write(&out_path, &bytes)
        .map_err(|e| format!("cannot write {}: {}", out_path.display(), e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o755));
    }

    // Version marker for the background updater (avoids executing the binary
    // just to learn what it is).
    let _ = std::fs::write(dest_dir.join(".sidecar-version"), entry.version.as_bytes());

    Ok(out_path)
}

// ── Restored on the origin/main merge (2026-09-03) ────────────────────────────
// Both helpers exist only on the swap-desk line; origin/main's copy of this file
// never had them. The auto-merge took origin/main's version of this region, so
// they vanished while their seven call sites in swap_sidecar.rs and zano_rpc.rs
// remained — a link error, not a silent behaviour change, which is why it
// surfaced immediately in `cargo test`.
/// Poll `port_is_bound(port)` until the port is free, up to `max_ms`.
pub async fn wait_for_port_free(port: u16, max_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(max_ms);
    loop {
        if !port_is_bound(port).await {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return !port_is_bound(port).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

