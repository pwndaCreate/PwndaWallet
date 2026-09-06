//! Regression test for the V1 miner-side `mining.ping` keepalive.
//!
//! Background: SRBMiner has a 15-second silence timeout. ERG/Autolykos2
//! pools push `mining.notify` every 10-30s (because Ergo blocks are
//! ~2 min apart), which means natural quiet windows exceed SRBMiner's
//! threshold and the miner disconnects with "Pool not responding".
//! Captured in session `dev-fee-20260518T033208Z-gpu.jsonl`.
//!
//! Fix: the proxy's miner-writer task spawns a tokio ticker that sends
//! `{"id":null,"method":"mining.ping","params":[]}` to the miner if no
//! frame has been forwarded in the last 10 seconds. This test asserts
//! the timing contract.
//!
//! Same Windows-cdylib rationale as the sibling integration tests —
//! we re-implement the writer's keepalive logic inline so the test
//! doesn't need to link the lib crate (which would fail with
//! STATUS_ENTRYPOINT_NOT_FOUND per rust-lang/cargo#5754).
//!
//! Mirrors `proxy.rs::spawn_miner_writer`:
//! - On every real frame forwarded → update `last_send_at`
//! - Every `tick_secs` → if `idle_threshold_secs` elapsed, emit ping

use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::sleep;

/// Re-implementation of the keepalive logic from
/// `proxy.rs::spawn_miner_writer`. The constants are passed as
/// arguments instead of `const` so the test can use short windows
/// without sleeping for 15 seconds.
async fn run_writer(
    mut sock: tokio::net::tcp::OwnedWriteHalf,
    mut rx: mpsc::Receiver<String>,
    tick_secs: f32,
    idle_threshold_secs: f32,
    is_v1: bool,
) {
    let mut last_send_at = Instant::now();
    let mut ticker =
        tokio::time::interval(Duration::from_millis((tick_secs * 1000.0) as u64));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await; // skip immediate
    loop {
        tokio::select! {
            biased;
            msg = rx.recv() => {
                let Some(line) = msg else { return };
                if sock.write_all(line.as_bytes()).await.is_err() {
                    return;
                }
                if !line.ends_with('\n') {
                    let _ = sock.write_all(b"\n").await;
                }
                last_send_at = Instant::now();
            }
            _ = ticker.tick() => {
                if !is_v1 { continue; }
                if last_send_at.elapsed()
                    < Duration::from_millis((idle_threshold_secs * 1000.0) as u64)
                {
                    continue;
                }
                let ping = "{\"id\":null,\"method\":\"mining.ping\",\"params\":[]}\n";
                if sock.write_all(ping.as_bytes()).await.is_err() {
                    return;
                }
                last_send_at = Instant::now();
            }
        }
    }
}

/// Spin up a listener, accept one socket, run the writer task with
/// short timing windows. Returns the read-end (caller reads what came
/// out) plus the tx so caller can inject frames.
async fn spawn_writer_with_pipe(
    tick_secs: f32,
    idle_secs: f32,
    is_v1: bool,
) -> (TcpStream, mpsc::Sender<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::channel::<String>(16);
    let server_handle: tokio::task::JoinHandle<()> = tokio::spawn(async move {
        let (sock, _) = listener.accept().await.expect("accept");
        // sock is the SERVER half — we'll write the keepalive frames to it.
        let (_read, write) = sock.into_split();
        run_writer(write, rx, tick_secs, idle_secs, is_v1).await;
    });
    let _ = server_handle; // detached
    let client = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    (client, tx)
}

async fn read_lines_until(
    sock: &mut TcpStream,
    duration: Duration,
) -> Vec<String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut out = Vec::new();
    let mut buf = BufReader::new(sock);
    let deadline = tokio::time::Instant::now() + duration;
    loop {
        let mut line = String::new();
        let remaining = match deadline.checked_duration_since(tokio::time::Instant::now()) {
            Some(d) => d,
            None => break,
        };
        match tokio::time::timeout(remaining, buf.read_line(&mut line)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {
                out.push(line.trim_end_matches(['\n', '\r']).to_string());
            }
            _ => break,
        }
    }
    out
}

#[tokio::test]
async fn mining_ping_fires_after_idle_threshold_on_v1() {
    // 0.5s tick, 1.5s idle threshold. We wait ~3.5s with no traffic
    // and expect at least one mining.ping to land.
    let (mut sock, _tx) = spawn_writer_with_pipe(0.5, 1.5, true).await;
    let lines = read_lines_until(&mut sock, Duration::from_millis(3500)).await;
    let pings: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("\"method\":\"mining.ping\""))
        .collect();
    assert!(
        !pings.is_empty(),
        "expected at least one mining.ping after 3.5s idle, got: {:?}",
        lines
    );
    // Validate the shape: id=null, method=mining.ping, params=[]
    let parsed: serde_json::Value =
        serde_json::from_str(pings[0]).expect("valid JSON ping");
    assert!(parsed["id"].is_null(), "id should be null: {}", pings[0]);
    assert_eq!(parsed["method"], "mining.ping");
    let params = parsed["params"].as_array().expect("params is array");
    assert!(params.is_empty(), "params should be empty: {}", pings[0]);
}

#[tokio::test]
async fn mining_ping_does_not_fire_when_traffic_is_flowing() {
    // 0.4s tick, 1.0s idle threshold. We inject a real frame every
    // ~0.5s for 2 seconds. Idle threshold never reached → no pings.
    let (mut sock, tx) = spawn_writer_with_pipe(0.4, 1.0, true).await;
    let _injector = tokio::spawn(async move {
        for i in 0..4 {
            let _ = tx
                .send(format!(
                    "{{\"jsonrpc\":\"2.0\",\"method\":\"mining.notify\",\"params\":[\"job_{}\"],\"id\":null}}\n",
                    i
                ))
                .await;
            sleep(Duration::from_millis(500)).await;
        }
    });
    let lines = read_lines_until(&mut sock, Duration::from_millis(2200)).await;
    let pings: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("\"method\":\"mining.ping\""))
        .collect();
    let notifies: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("\"method\":\"mining.notify\""))
        .collect();
    assert!(
        pings.is_empty(),
        "no pings should fire while traffic flows, got {} pings",
        pings.len()
    );
    assert!(
        notifies.len() >= 3,
        "expected at least 3 forwarded notifies, got {}: {:?}",
        notifies.len(),
        lines
    );
}

#[tokio::test]
async fn mining_ping_suppressed_for_randomx() {
    // is_v1=false → RandomX-equivalent path. No pings should fire even
    // during long idle.
    let (mut sock, _tx) = spawn_writer_with_pipe(0.3, 0.5, false).await;
    let lines = read_lines_until(&mut sock, Duration::from_millis(2000)).await;
    let pings: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("\"method\":\"mining.ping\""))
        .collect();
    assert!(
        pings.is_empty(),
        "RandomX path must NOT emit mining.ping (xmrig has upstream keepalived); got {} pings",
        pings.len()
    );
}

#[tokio::test]
async fn mining_ping_repeats_when_idle_persists() {
    // 0.3s tick, 0.6s idle. Over 2.5s of total idle, expect at least
    // 2 pings (one every ~0.6-0.9s).
    let (mut sock, _tx) = spawn_writer_with_pipe(0.3, 0.6, true).await;
    let lines = read_lines_until(&mut sock, Duration::from_millis(2500)).await;
    let pings: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("\"method\":\"mining.ping\""))
        .collect();
    assert!(
        pings.len() >= 2,
        "expected at least 2 mining.ping over 2.5s sustained idle, got {}: {:?}",
        pings.len(),
        lines
    );
}
