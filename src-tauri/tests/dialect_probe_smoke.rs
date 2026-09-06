//! Behavioral smoke tests for the dialect probe.
//!
//! Same Windows-cdylib rationale as `pool_simulator_smoke.rs` — this
//! file is self-contained (no `use tauri_eth_wallet_lib::...`) because
//! the lib crate ships with `crate-type = ["lib", "cdylib", "staticlib"]`
//! and on Windows linking the cdylib from a test binary fails at load
//! time with `STATUS_ENTRYPOINT_NOT_FOUND` (the test binary references
//! tauri runtime symbols that the cdylib expects to be resolved at
//! load-time but aren't, in the test harness). See rust-lang/cargo#5754.
//!
//! These tests therefore re-implement the probe's wire behaviour
//! inline, mirroring the contract from `src/dev_fee/dialect_probe.rs`:
//!
//! - Five subscribe shapes (Empty / Agent / AgentExt / AgentWallet /
//!   WalletOnly) iterated in that canonical order.
//! - Per-shape wallet selection: WalletOnly takes the full
//!   `<addr>.<worker>`; AgentWallet strips the worker; others ignore.
//! - Fresh TCP connection per probe.
//! - Per-probe timeout via tokio::time::timeout.
//! - On error / EOF / timeout, the result carries `error: Some(...)`
//!   and `frame_received: None`.
//!
//! If you change the dialect probe behaviour in
//! `src/dev_fee/dialect_probe.rs`, mirror the change here too. The
//! duplication is intentional — the alternative is no automated test
//! coverage at all on Windows.

use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

// =======================================================================
// Local re-implementation of the probe (mirrors
// `src/dev_fee/dialect_probe.rs`).
// =======================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubscribeShape {
    Empty,
    Agent,
    AgentExt,
    AgentWallet,
    WalletOnly,
    /// 2026-05-18 — `[wallet, pass]`. Native lolMiner→HeroMiners CFX.
    WalletWithPass,
}

impl SubscribeShape {
    fn name(self) -> &'static str {
        match self {
            Self::Empty => "Empty",
            Self::Agent => "Agent",
            Self::AgentExt => "AgentExt",
            Self::AgentWallet => "AgentWallet",
            Self::WalletOnly => "WalletOnly",
            Self::WalletWithPass => "WalletWithPass",
        }
    }
}

#[derive(Debug, Clone)]
struct ProbeResult {
    shape: &'static str,
    frame_sent: String,
    frame_received: Option<String>,
    parsed_error: Option<String>,
    error: Option<String>,
}

fn build_subscribe(shape: SubscribeShape, agent: &str, wallet: &str, pass: &str) -> String {
    let params = match shape {
        SubscribeShape::Empty => serde_json::json!([]),
        SubscribeShape::Agent => serde_json::json!([agent]),
        SubscribeShape::AgentExt => serde_json::json!([agent, "EthereumStratum/1.0.0"]),
        SubscribeShape::AgentWallet => serde_json::json!([agent, wallet]),
        SubscribeShape::WalletOnly => serde_json::json!([wallet]),
        SubscribeShape::WalletWithPass => serde_json::json!([wallet, pass]),
    };
    serde_json::to_string(&serde_json::json!({
        "id": 1,
        "method": "mining.subscribe",
        "params": params,
    }))
    .unwrap()
}

fn parse_error(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let e = v.get("error")?;
    match e {
        serde_json::Value::Array(arr) => arr.get(1).and_then(|x| x.as_str()).map(String::from),
        serde_json::Value::Object(obj) => obj
            .get("message")
            .and_then(|x| x.as_str())
            .map(String::from),
        serde_json::Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

async fn probe_one(
    host: &str,
    port: u16,
    shape: SubscribeShape,
    agent: &str,
    wallet_with_worker: &str,
    timeout_ms: u64,
) -> ProbeResult {
    let wallet_for_shape = match shape {
        SubscribeShape::AgentWallet => wallet_with_worker
            .split_once('.')
            .map(|(a, _)| a)
            .unwrap_or(wallet_with_worker),
        _ => wallet_with_worker,
    };
    let frame = build_subscribe(shape, agent, wallet_for_shape, "x");
    let res = timeout(Duration::from_millis(timeout_ms), async {
        let tcp = TcpStream::connect((host, port)).await?;
        let _ = tcp.set_nodelay(true);
        let (read_half, mut write_half) = tcp.into_split();
        let payload = format!("{}\n", frame);
        write_half.write_all(payload.as_bytes()).await?;
        let mut buf = BufReader::new(read_half);
        let mut line = String::new();
        let n = buf.read_line(&mut line).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "pool closed without sending a response",
            ));
        }
        Ok::<String, std::io::Error>(line.trim_end_matches(['\n', '\r']).to_string())
    })
    .await;
    let (frame_received, error) = match res {
        Ok(Ok(line)) => (Some(line), None),
        Ok(Err(e)) => (None, Some(format!("io: {}", e))),
        Err(_) => (None, Some(format!("timeout after {} ms", timeout_ms))),
    };
    let parsed_error = frame_received.as_deref().and_then(parse_error);
    ProbeResult {
        shape: shape.name(),
        frame_sent: frame,
        frame_received,
        parsed_error,
        error,
    }
}

async fn probe_all(
    host: &str,
    port: u16,
    agent: &str,
    wallet_with_worker: &str,
    timeout_ms: u64,
) -> Vec<ProbeResult> {
    let shapes = [
        SubscribeShape::Empty,
        SubscribeShape::Agent,
        SubscribeShape::AgentExt,
        SubscribeShape::AgentWallet,
        SubscribeShape::WalletOnly,
        SubscribeShape::WalletWithPass,
    ];
    let mut out = Vec::with_capacity(shapes.len());
    for shape in shapes {
        out.push(probe_one(host, port, shape, agent, wallet_with_worker, timeout_ms).await);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    out
}

// =======================================================================
// Mock pool harness
// =======================================================================

async fn spawn_canned_pool<F>(accepts: usize, respond_fn: F) -> std::io::Result<u16>
where
    F: Fn(String) -> String + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let respond_fn = std::sync::Arc::new(respond_fn);
    tokio::spawn(async move {
        for _ in 0..accepts {
            let Ok((sock, _)) = listener.accept().await else { return };
            let respond_fn = respond_fn.clone();
            tokio::spawn(async move {
                let (read_half, mut write_half) = sock.into_split();
                let mut buf = BufReader::new(read_half);
                let mut line = String::new();
                if buf.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let response = respond_fn(line);
                    let _ = write_half.write_all(response.as_bytes()).await;
                    if !response.ends_with('\n') {
                        let _ = write_half.write_all(b"\n").await;
                    }
                }
            });
        }
    });
    Ok(port)
}

const TEST_WALLET: &str = "cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw.worker1";
const TEST_AGENT: &str = "lolMiner/1.96";

// =======================================================================
// Tests
// =======================================================================

#[tokio::test]
async fn probe_all_returns_six_rows_in_canonical_order() {
    let port = spawn_canned_pool(6, |_| {
        r#"{"id":1,"error":[-1,"Invalid params",null]}"#.to_string()
    })
    .await
    .expect("mock listener");
    let rows = probe_all("127.0.0.1", port, TEST_AGENT, TEST_WALLET, 1500).await;
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0].shape, "Empty");
    assert_eq!(rows[1].shape, "Agent");
    assert_eq!(rows[2].shape, "AgentExt");
    assert_eq!(rows[3].shape, "AgentWallet");
    assert_eq!(rows[4].shape, "WalletOnly");
    assert_eq!(rows[5].shape, "WalletWithPass");
}

#[tokio::test]
async fn probe_extracts_error_message_from_v1_error_array() {
    let port = spawn_canned_pool(6, |_| {
        r#"{"id":1,"error":[-1,"Invalid params",null]}"#.to_string()
    })
    .await
    .expect("mock listener");
    let rows = probe_all("127.0.0.1", port, TEST_AGENT, TEST_WALLET, 1500).await;
    for row in &rows {
        assert!(
            row.frame_received.is_some(),
            "missing frame_received for shape {}",
            row.shape
        );
        assert_eq!(
            row.parsed_error.as_deref(),
            Some("Invalid params"),
            "shape {} did not parse error",
            row.shape
        );
        assert!(row.error.is_none(), "shape {} got io error: {:?}", row.shape, row.error);
    }
}

#[tokio::test]
async fn probe_selects_correct_wallet_per_shape() {
    // Mock echoes back the params[0] from the subscribe wrapped in an
    // error so we can verify the per-shape wallet selection happens
    // client-side without depending on real pool dialect.
    let port = spawn_canned_pool(6, |request: String| {
        let v: serde_json::Value = serde_json::from_str(request.trim()).unwrap_or_default();
        let params0 = v
            .get("params")
            .and_then(|p| p.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.as_str())
            .unwrap_or("<missing>")
            .to_string();
        format!(r#"{{"id":1,"error":[-1,"echo:{}",null]}}"#, params0)
    })
    .await
    .expect("mock listener");
    let rows = probe_all("127.0.0.1", port, TEST_AGENT, TEST_WALLET, 1500).await;

    let empty = rows.iter().find(|r| r.shape == "Empty").unwrap();
    assert!(
        empty.parsed_error.as_deref().unwrap_or("").contains("<missing>"),
        "expected <missing> for Empty, got {:?}",
        empty.parsed_error
    );
    let agent = rows.iter().find(|r| r.shape == "Agent").unwrap();
    assert!(
        agent.parsed_error.as_deref().unwrap_or("").contains("lolMiner/1.96"),
        "expected lolMiner/1.96 for Agent, got {:?}",
        agent.parsed_error
    );
    let aw = rows.iter().find(|r| r.shape == "AgentWallet").unwrap();
    assert!(
        aw.parsed_error.as_deref().unwrap_or("").contains("lolMiner/1.96"),
        "expected lolMiner/1.96 for AgentWallet (params[0] is agent), got {:?}",
        aw.parsed_error
    );
    let wo = rows.iter().find(|r| r.shape == "WalletOnly").unwrap();
    assert!(
        wo.parsed_error.as_deref().unwrap_or("").contains("cfx:aamf"),
        "expected cfx:aamf… for WalletOnly, got {:?}",
        wo.parsed_error
    );
    let wp = rows.iter().find(|r| r.shape == "WalletWithPass").unwrap();
    assert!(
        wp.parsed_error.as_deref().unwrap_or("").contains("cfx:aamf"),
        "expected cfx:aamf… for WalletWithPass params[0], got {:?}",
        wp.parsed_error
    );
    assert!(
        wp.frame_sent.contains("\"x\""),
        "WalletWithPass must include the password at params[1], got {}",
        wp.frame_sent
    );
    // AgentWallet's params[1] should be the BARE wallet (no .worker).
    // Verify by looking at the frame_sent.
    assert!(
        aw.frame_sent.contains("cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw\"")
            && !aw.frame_sent.contains(".worker1"),
        "AgentWallet should strip worker from wallet, got {}",
        aw.frame_sent
    );
}

#[tokio::test]
async fn probe_times_out_on_unresponsive_pool() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let mut held: Vec<TcpStream> = Vec::new();
        for _ in 0..6 {
            if let Ok((sock, _)) = listener.accept().await {
                held.push(sock);
            }
        }
        tokio::time::sleep(Duration::from_secs(6)).await;
    });
    let start = Instant::now();
    let rows = probe_all("127.0.0.1", port, TEST_AGENT, TEST_WALLET, 300).await;
    assert_eq!(rows.len(), 6);
    // Total wall time should be roughly 6 × 300 ms = 1.8 s (plus the
    // 50 ms inter-probe gaps). If it's much less, the timeout isn't
    // firing per-probe.
    assert!(
        start.elapsed() >= Duration::from_millis(1500),
        "elapsed {:?} too short — timeouts not respected per probe?",
        start.elapsed()
    );
    for row in &rows {
        assert!(
            row.frame_received.is_none(),
            "expected no frame for shape {}",
            row.shape
        );
        assert!(
            row.error.as_deref().unwrap_or("").contains("timeout"),
            "expected timeout error for {}: {:?}",
            row.shape,
            row.error
        );
    }
}

#[tokio::test]
async fn probe_reports_connect_error_when_pool_refuses() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let rows = probe_all("127.0.0.1", port, TEST_AGENT, TEST_WALLET, 800).await;
    assert_eq!(rows.len(), 6);
    for row in &rows {
        assert!(
            row.frame_received.is_none(),
            "expected no frame for shape {}",
            row.shape
        );
        assert!(row.error.is_some(), "expected connect error for shape {}", row.shape);
    }
}

#[tokio::test]
async fn build_subscribe_wallet_only_carries_wallet_in_params_zero() {
    let frame = build_subscribe(
        SubscribeShape::WalletOnly,
        TEST_AGENT,
        TEST_WALLET,
        "x",
    );
    let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["params"][0], TEST_WALLET);
    assert_eq!(v["params"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn build_subscribe_wallet_with_pass_carries_wallet_then_password() {
    // 2026-05-18 — HeroMiners CFX native shape. Captured from
    // lolMiner → de.conflux.herominers.com in session 033004Z.
    let frame = build_subscribe(
        SubscribeShape::WalletWithPass,
        TEST_AGENT,
        TEST_WALLET,
        "x",
    );
    let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["params"][0], TEST_WALLET);
    assert_eq!(v["params"][1], "x");
    assert_eq!(v["params"].as_array().unwrap().len(), 2);
    // Agent must NOT leak in.
    assert!(
        !frame.contains("lolMiner"),
        "agent leaked into WalletWithPass: {}",
        frame
    );
}

#[tokio::test]
async fn build_subscribe_agent_wallet_carries_agent_then_wallet() {
    let frame = build_subscribe(
        SubscribeShape::AgentWallet,
        TEST_AGENT,
        "cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw",
        "x",
    );
    let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["params"][0], TEST_AGENT);
    assert_eq!(
        v["params"][1],
        "cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw"
    );
    assert_eq!(v["params"].as_array().unwrap().len(), 2);
}
