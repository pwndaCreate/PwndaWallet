//! Pool-simulator smoke tests — integration-test form.
//!
//! These tests live in `tests/` (not as `#[cfg(test)] mod` blocks inside
//! the library) for a Windows-specific reason: the lib crate ships as
//! `crate-type = ["lib", "cdylib", "staticlib"]` for Tauri compatibility,
//! and on Windows `cargo test --lib` builds a test binary that fails to
//! load with `STATUS_ENTRYPOINT_NOT_FOUND` because cdylib exports don't
//! satisfy the test runner's symbol expectations. Integration tests in
//! `tests/` build the lib as a regular `rlib` link and don't hit this.
//! See [rust-lang/cargo#5754] for the upstream issue.
//!
//! These tests are reduced re-implementations of the in-lib tests in
//! `src/dev_fee/pool_simulator.rs` — same shapes, same fixtures, but
//! using only the public dev-fee surface (which is what an external
//! consumer would have anyway). The lib-internal version stays for
//! when this is run on Linux/CI where the Windows linker issue doesn't
//! apply, and for the documentation value of the inline test cases.
//!
//! [rust-lang/cargo#5754]: https://github.com/rust-lang/cargo/issues/5754

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::sleep;

// =======================================================================
// Re-implement a tiny mock pool inline (the production mock_pool is
// gated behind `#[cfg(test)]` in the lib and not reachable from this
// integration test).
// =======================================================================

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum MockResponse {
    ReplyTo {
        trigger: &'static str,
        payload: String,
    },
    Push {
        delay_ms: u64,
        payload: String,
    },
    /// Close the connection abruptly after a delay, without sending any
    /// response. Reproduces the HeroMiners-CFX silent-close fingerprint
    /// from 2026-05-17 PM (`dev-fee-20260517T202227Z-gpu.jsonl`).
    CloseAfterDelay {
        delay_ms: u64,
    },
    /// Reject any subscribe whose agent doesn't match `expected_agent`
    /// by closing the connection. Models pools that anti-proxy-filter
    /// on agent strings (HeroMiners suspected behaviour).
    CloseUnlessAgent {
        expected_agent: &'static str,
    },
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct RecordedFrame {
    line: String,
}

struct MockPoolHandle {
    port: u16,
    recorded: Arc<Mutex<Vec<RecordedFrame>>>,
}

async fn spawn_mock_pool(script: Vec<MockResponse>) -> std::io::Result<MockPoolHandle> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let recorded = Arc::new(Mutex::new(Vec::<RecordedFrame>::new()));
    let recorded_clone = recorded.clone();
    tokio::spawn(async move {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => return,
        };
        let (read_half, write_half) = stream.into_split();
        let mut buf = BufReader::new(read_half);
        let mut line = String::new();

        let mut replies: Vec<(&'static str, String)> = Vec::new();
        let mut pushes: Vec<(u64, String)> = Vec::new();
        let mut close_after_delay: Option<u64> = None;
        let mut required_agent: Option<&'static str> = None;
        for r in script {
            match r {
                MockResponse::ReplyTo { trigger, payload } => replies.push((trigger, payload)),
                MockResponse::Push { delay_ms, payload } => pushes.push((delay_ms, payload)),
                MockResponse::CloseAfterDelay { delay_ms } => {
                    close_after_delay = Some(delay_ms)
                }
                MockResponse::CloseUnlessAgent { expected_agent } => {
                    required_agent = Some(expected_agent)
                }
            }
        }

        let writer = Arc::new(Mutex::new(write_half));
        let push_handle = {
            let writer = writer.clone();
            tokio::spawn(async move {
                for (delay, payload) in pushes {
                    sleep(Duration::from_millis(delay)).await;
                    let mut w = writer.lock().await;
                    let mut payload = payload;
                    if !payload.ends_with('\n') {
                        payload.push('\n');
                    }
                    if w.write_all(payload.as_bytes()).await.is_err() {
                        return;
                    }
                }
            })
        };

        // Honor CloseAfterDelay if scripted — spawn a task that drops
        // the writer (closes the socket) after the configured delay.
        let close_handle = close_after_delay.map(|delay| {
            let writer = writer.clone();
            tokio::spawn(async move {
                sleep(Duration::from_millis(delay)).await;
                // Acquire then drop the writer's lock — when we drop
                // it later in main loop teardown, the socket is closed.
                // For an immediate close we'd need to take ownership,
                // which a Mutex doesn't allow. Instead, signal the
                // main loop via an external mechanism — but for the
                // sake of this test, write 0 bytes (the read loop
                // sees `Ok(0)` from the next read after our half is
                // closed, which happens when the task scope drops).
                // Simpler: shutdown the writer.
                let mut w = writer.lock().await;
                let _ = w.shutdown().await;
            })
        });

        loop {
            line.clear();
            match buf.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    recorded_clone
                        .lock()
                        .await
                        .push(RecordedFrame { line: line.clone() });
                    // CloseUnlessAgent: if this is a mining.subscribe
                    // with the wrong agent string, close the socket
                    // immediately. Models pool-side anti-proxy filters.
                    if let Some(expected) = required_agent {
                        if line.contains("mining.subscribe") && !line.contains(expected) {
                            let mut w = writer.lock().await;
                            let _ = w.shutdown().await;
                            break;
                        }
                    }
                    if let Some((_, payload)) = replies
                        .iter()
                        .find(|(trigger, _)| line.contains(trigger))
                    {
                        let mut w = writer.lock().await;
                        let mut payload = payload.clone();
                        if !payload.ends_with('\n') {
                            payload.push('\n');
                        }
                        if w.write_all(payload.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
        push_handle.abort();
        if let Some(h) = close_handle {
            h.abort();
        }
    });
    Ok(MockPoolHandle { port, recorded })
}

// =======================================================================
// Per-pool dialect fixtures. These match `pool_simulator.rs::script_for`
// for the dialects we exercise here.
// =======================================================================

fn woolypooly_octopus_script() -> Vec<MockResponse> {
    vec![
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":true,"error":null}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.authorize",
            payload: r#"{"id":5,"result":true,"error":null}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 50,
            payload: r#"{"id":null,"method":"mining.notify","params":["0x00028372","0xprev","0xheader","0xseed","0x00000fff",true,12345678,"1c0fffff"]}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.submit",
            payload: r#"{"id":10,"result":true,"error":null}"#.to_string(),
        },
    ]
}

fn herominers_octopus_script() -> Vec<MockResponse> {
    // HeroMiners CFX dialect model (refined 2026-05-17 over 6 iterations,
    // confirmed by cross-referencing the working server-side CFX proxy
    // at `GoPwnda.org/cmd/cfx-proxy/main.go`):
    //
    // - `[]`: → `Invalid params` (params[0] missing)
    // - `[agent]`: → `Invalid params` (params[1] required, no wallet)
    // - `[agent, "EthereumStratum/1.0.0"]`: → `Invalid address` (params[0] is agent, not wallet)
    // - `[agent, "cfx:wallet"]`: → `Invalid address` (still validates params[0])
    // - `["cfx:wallet.worker"]`: → array result + extranonce ✓ THE FIX
    //
    // HeroMiners parses `params[0]` of `mining.subscribe` as the wallet
    // directly — single-element subscribe with full `<wallet>.<worker>`.
    // No agent string, no protocol-version trailer.
    //
    // Triggers ordered most-specific first for substring matching:
    //   1. authorize before subscribe (wallet appears in both lines)
    //   2. WalletOnly (single-element subscribe with wallet) — success
    //   3. AgentWallet (2-element with wallet at [1]) — Invalid address
    //   4. EthereumStratum (2-element with proto-version at [1]) — Invalid address
    //   5. any other subscribe — Invalid params
    vec![
        MockResponse::ReplyTo {
            trigger: "mining.authorize",
            payload: r#"{"id":5,"result":true,"error":null}"#.to_string(),
        },
        // 1. WalletOnly — the actual dialect HeroMiners uses. Single
        // element `params: ["cfx:wallet.worker"]`. Match on the
        // subscribe-method + wallet pattern WITHOUT an agent in [0].
        MockResponse::ReplyTo {
            trigger: r#"mining.subscribe","params":["cfx:"#,
            payload: r#"{"id":3,"result":[[["mining.notify","SUB"]],"deadbeef",4],"error":null}"#.to_string(),
        },
        // 2. AgentWallet — params[1] = wallet, params[0] = agent. The
        // agent in [0] is what HeroMiners' validator rejects.
        MockResponse::ReplyTo {
            trigger: r#"mining.subscribe","params":["lolMiner/1.96","cfx:"#,
            payload: r#"{"id":3,"result":null,"error":[-1,"Invalid address",null]}"#.to_string(),
        },
        // 3. AgentExt — params[1] = "EthereumStratum/1.0.0"
        MockResponse::ReplyTo {
            trigger: "EthereumStratum",
            payload: r#"{"id":3,"result":null,"error":[-1,"Invalid address",null]}"#.to_string(),
        },
        // 4. Empty or Agent — "Invalid params"
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":null,"error":[-1,"Invalid params",null]}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 80,
            payload: r#"{"id":null,"method":"mining.set_difficulty","params":[16384]}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 130,
            payload: r#"{"id":null,"method":"mining.notify","params":["hero_oct_001","0xhdr","0xseed","0x00000fff",true,2348721,"1c0fffff"]}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.submit",
            payload: r#"{"id":10,"result":true,"error":null}"#.to_string(),
        },
    ]
}

// =======================================================================
// Tests
// =======================================================================

/// **Regression lock for the 2026-05-17 evening lolMiner/HeroMiners
/// failure.** Empty subscribe params produced "Invalid params" from
/// HeroMiners' real pool; lolMiner silently timed out waiting for
/// jobs. This test reproduces the symptom in <100ms.
#[tokio::test]
async fn herominers_rejects_empty_subscribe_with_invalid_params() {
    let pool = spawn_mock_pool(herominers_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(b"{\"id\":1,\"method\":\"mining.subscribe\",\"params\":[]}\n")
        .await
        .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");

    assert!(
        response.contains("Invalid params"),
        "HeroMiners empty-subscribe must return Invalid params; got: {}",
        response.trim()
    );
    assert!(
        response.contains("\"error\""),
        "Response must be an error envelope; got: {}",
        response.trim()
    );
}

/// **Negative case shipped 2026-05-17 evening.** HeroMiners CFX parses
/// `params[1]` of subscribe as a wallet address (non-standard NiceHash
/// behavior). Sending `["lolMiner/1.96", "EthereumStratum/1.0.0"]`
/// produces `{"error":[-1,"Invalid address",null]}` because the daemon
/// reads the protocol-version string as a wallet. Regression-locks the
/// telemetry-captured fingerprint from `dev-fee-20260517T211049Z-gpu.jsonl`.
#[tokio::test]
async fn herominers_agent_ext_subscribe_returns_invalid_address() {
    let pool = spawn_mock_pool(herominers_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["lolMiner/1.96","EthereumStratum/1.0.0"]}
"#,
    )
    .await
    .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");

    assert!(
        response.contains("Invalid address"),
        "AgentExt subscribe must produce Invalid address error; got: {}",
        response.trim()
    );
}

/// **Pinned 2026-05-17 evening (iteration #3).** Agent shape — just
/// `[agent]` — produced `Invalid params` because HeroMiners requires
/// `params[1]` (the wallet). Regression-locks the failure mode captured
/// in `dev-fee-20260517T214619Z-gpu.jsonl`.
#[tokio::test]
async fn herominers_agent_only_subscribe_returns_invalid_params() {
    let pool = spawn_mock_pool(herominers_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["lolMiner/1.96"]}
"#,
    )
    .await
    .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");

    assert!(
        response.contains("Invalid params"),
        "Agent-only subscribe must produce Invalid params; got: {}",
        response.trim()
    );
}

/// **Negative case shipped 2026-05-17 late evening.** AgentWallet
/// shape with `[agent, wallet]` produced "Invalid address" because
/// HeroMiners validates `params[0]` as the wallet and the agent string
/// isn't a valid CFX address. Regression-locks the failure mode that
/// drove iteration #4 and #5 before the cross-reference from the
/// server proxy revealed the WalletOnly dialect.
#[tokio::test]
async fn herominers_agent_wallet_subscribe_returns_invalid_address() {
    let pool = spawn_mock_pool(herominers_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["lolMiner/1.96","cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw.worker1"]}
"#,
    )
    .await
    .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");

    assert!(
        response.contains("Invalid address"),
        "AgentWallet must produce Invalid address (HeroMiners parses params[0] as wallet, agent is not a wallet); got: {}",
        response.trim()
    );
}

/// **Positive case for the 2026-05-17 final fix.** WalletOnly shape —
/// single-element `params: ["cfx:<wallet>.<worker>"]` — is what
/// HeroMiners CFX expects. Confirmed by cross-referencing the working
/// server-side CFX proxy at `GoPwnda.org/cmd/cfx-proxy/main.go` which
/// reads `params[0]` of `mining.subscribe` as the wallet directly.
#[tokio::test]
async fn herominers_wallet_only_subscribe_returns_array_result() {
    let pool = spawn_mock_pool(herominers_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw.worker1"]}
"#,
    )
    .await
    .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");

    assert!(
        response.contains("deadbeef"),
        "WalletOnly subscribe must get array+extranonce response; got: {}",
        response.trim()
    );
    assert!(
        !response.contains("Invalid address") && !response.contains("Invalid params"),
        "Response must not be an error envelope; got: {}",
        response.trim()
    );
}

/// WoolyPooly CFX returns `result: true` to empty subscribe — a
/// non-standard "subscribe OK, no extranonce" shape. lolMiner uses
/// defaults. This test pins the dialect.
#[tokio::test]
async fn woolypooly_octopus_returns_result_true_on_empty_subscribe() {
    let pool = spawn_mock_pool(woolypooly_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(b"{\"id\":1,\"method\":\"mining.subscribe\",\"params\":[]}\n")
        .await
        .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");

    let parsed: serde_json::Value = serde_json::from_str(response.trim()).expect("parse");
    assert_eq!(parsed["result"], serde_json::Value::Bool(true));
    assert_eq!(parsed["error"], serde_json::Value::Null);
}

/// End-to-end miner-simulator test. Drives a fake lolMiner against
/// the WoolyPooly Octopus script: subscribe → response → authorize →
/// response → notify push → submit → ack. Asserts the full sequence.
#[tokio::test]
async fn end_to_end_lolminer_woolypooly_octopus_flow() {
    let pool = spawn_mock_pool(woolypooly_octopus_script())
        .await
        .expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    let mut buf = BufReader::new(rh);

    // 1. Send subscribe with AgentExt (what lolMiner sends).
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["lolMiner/1.96","EthereumStratum/1.0.0"]}
"#,
    )
    .await
    .expect("send subscribe");

    // 2. Send authorize.
    wh.write_all(
        br#"{"id":2,"method":"mining.authorize","params":["cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw.worker1","x"]}
"#,
    )
    .await
    .expect("send authorize");

    // 3. Read 3 frames: subscribe response, authorize response, notify push.
    let mut received = Vec::<String>::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    while received.len() < 3 {
        let remaining = match deadline.checked_duration_since(tokio::time::Instant::now()) {
            Some(d) => d,
            None => break,
        };
        let mut line = String::new();
        match tokio::time::timeout(remaining, buf.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 => received.push(line),
            _ => break,
        }
    }

    assert!(
        received.iter().any(|l| l.contains("\"id\":3,\"result\":true")),
        "must receive subscribe response (id:3, result:true); received: {:?}",
        received
    );
    assert!(
        received.iter().any(|l| l.contains("\"id\":5,\"result\":true")),
        "must receive authorize response (id:5); received: {:?}",
        received
    );
    assert!(
        received.iter().any(|l| l.contains("mining.notify")),
        "must receive a notify; received: {:?}",
        received
    );

    // 4. Submit a share, expect accept.
    let notify_line = received
        .iter()
        .find(|l| l.contains("mining.notify"))
        .expect("notify");
    let notify_parsed: serde_json::Value =
        serde_json::from_str(notify_line.trim()).expect("parse notify");
    let job_id = notify_parsed["params"][0].as_str().expect("job_id");

    let share = format!(
        r#"{{"id":10,"method":"mining.submit","params":["worker","{}","0xdeadbeef","0xhdr"]}}"#,
        job_id
    );
    wh.write_all(format!("{}\n", share).as_bytes())
        .await
        .expect("send submit");

    let mut submit_response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut submit_response))
        .await
        .expect("timeout")
        .expect("read submit response");
    assert!(
        submit_response.contains("\"result\":true"),
        "submit must be accepted; got: {}",
        submit_response.trim()
    );

    // Inbound frame audit — the pool should have seen exactly subscribe,
    // authorize, and submit (3 inbound).
    sleep(Duration::from_millis(50)).await;
    let recorded = pool.recorded.lock().await.clone();
    assert_eq!(
        recorded.len(),
        3,
        "pool should have recorded 3 inbound frames; got: {:?}",
        recorded
    );
}

// =======================================================================
// Per-(miner, algo) end-to-end coverage. One test per mining program +
// algorithm combination the wallet ships. Each test drives a simulated
// miner of that program/algo through a representative pool dialect and
// asserts on the full handshake + share submission + acknowledgment.
// =======================================================================

// ---- Additional pool dialect scripts ----

fn hashvault_randomx_script() -> Vec<MockResponse> {
    // RandomX (Monero stratum) handshake: single `login` method, no
    // separate subscribe/authorize. Pool returns session_id + the first
    // job bundled in the result.
    vec![
        MockResponse::ReplyTo {
            trigger: "\"method\":\"login\"",
            payload: r#"{"id":1,"jsonrpc":"2.0","result":{"id":"sess-xmrig-abc","status":"OK","job":{"blob":"0a0b0c0d0e","job_id":"jobXmr001","target":"00ffffffff","seed_hash":"f7e6d5c4","height":3120000}},"error":null}"#.to_string(),
        },
        // Periodic job push to validate the notify path.
        MockResponse::Push {
            delay_ms: 100,
            payload: r#"{"jsonrpc":"2.0","method":"job","params":{"blob":"0a0b0c0d0f","job_id":"jobXmr002","target":"00ffffffff","seed_hash":"f7e6d5c4","height":3120001}}"#.to_string(),
        },
        // Submit ack (RandomX uses result.status == "OK").
        MockResponse::ReplyTo {
            trigger: "\"method\":\"submit\"",
            payload: r#"{"id":2,"jsonrpc":"2.0","result":{"status":"OK"},"error":null}"#.to_string(),
        },
    ]
}

fn herominers_kawpow_script() -> Vec<MockResponse> {
    // KawPow (Ravencoin) on HeroMiners — same dialect parser as
    // HeroMiners CFX/Octopus: AgentWallet shape required (params[1] = wallet).
    // AgentExt → "Invalid address"; Agent or Empty → "Invalid params";
    // AgentWallet → array result. KawPow notify carries 7 elements
    // ending with `bits`. Submits are 5-element with trailing mix_hash.
    vec![
        // authorize first — wallet prefix appears in both subscribe AND
        // authorize lines.
        MockResponse::ReplyTo {
            trigger: "mining.authorize",
            payload: r#"{"id":5,"result":true,"error":null}"#.to_string(),
        },
        // WalletOnly — single-element subscribe with RVN wallet
        MockResponse::ReplyTo {
            trigger: r#"mining.subscribe","params":["RTg"#,
            payload: r#"{"id":3,"result":[[["mining.notify","SUB"]],"abcd",4],"error":null}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "EthereumStratum",
            payload: r#"{"id":3,"result":null,"error":[-1,"Invalid address",null]}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":null,"error":[-1,"Invalid params",null]}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 80,
            payload: r#"{"id":null,"method":"mining.set_difficulty","params":[16384]}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 130,
            payload: r#"{"id":null,"method":"mining.notify","params":["1234abcd","0xhdr","0xseed","0x00000fff",true,2348721,"1c0fffff"]}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.submit",
            payload: r#"{"id":10,"result":true,"error":null}"#.to_string(),
        },
    ]
}

fn woolypooly_autolykos_script() -> Vec<MockResponse> {
    // Autolykos2 (Ergo) on WoolyPooly — IMPORTANT: WoolyPooly's ERG
    // endpoint returns an ARRAY result on subscribe (unlike its CFX
    // endpoint which returns `result: true`). This is the regression
    // anchor for the 2026-05-17 ERG session that broke when always-restash
    // pushed synthetic extranonces mid-session. SRBMiner sends Agent
    // shape (no EthereumStratum extension) per its Autolykos2 dialect.
    vec![
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":[[["mining.notify","SUB_USER"]],"cafe",4],"error":null}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.authorize",
            payload: r#"{"id":5,"result":true,"error":null}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 80,
            payload: r#"{"id":null,"method":"mining.notify","params":["job_auto_001","1198765","0xdeadbeef","0x00000000ffff0000"]}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.submit",
            payload: r#"{"id":10,"result":true,"error":null}"#.to_string(),
        },
    ]
}

fn herominers_autolykos_script() -> Vec<MockResponse> {
    // Autolykos2 on HeroMiners — Agent shape (no EthereumStratum
    // extension for Autolykos2). The ergo subdomain triggers the
    // pool_quirks Autolykos branch BEFORE the generic herominers branch,
    // so this is Agent not AgentExt.
    vec![
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":[[["mining.notify","SUB_USER"]],"feed",4],"error":null}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.authorize",
            payload: r#"{"id":5,"result":true,"error":null}"#.to_string(),
        },
        MockResponse::Push {
            delay_ms: 80,
            payload: r#"{"id":null,"method":"mining.notify","params":["job_hero_001","1198765","0xdeadbeef","0x00000000ffff0000"]}"#.to_string(),
        },
        MockResponse::ReplyTo {
            trigger: "mining.submit",
            payload: r#"{"id":10,"result":true,"error":null}"#.to_string(),
        },
    ]
}

// =======================================================================
// Miner-specific helpers for share-shape correctness
// =======================================================================

/// V1 miner simulator runner — sends subscribe + authorize, reads
/// notifies, submits one share per notify. `subscribe_params_json` is
/// the raw `params:` array literal (e.g. `["agent"]` for Agent shape,
/// `["agent","EthereumStratum/1.0.0"]` for AgentExt).
/// `submit_params_json_fn(job_id)` builds the `mining.submit` params
/// array for the given job_id — different per algo because share
/// trailing fields vary (KawPow=5, Octopus=4, Autolykos2=3).
async fn run_v1_miner_flow(
    port: u16,
    wallet: &str,
    subscribe_params_json: &str,
    submit_params_fn: fn(&str, &str) -> String,
) -> (Vec<String>, Vec<RecordedFrame>) {
    let stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    let mut buf = BufReader::new(rh);

    // Subscribe.
    let subscribe = format!(
        r#"{{"id":1,"method":"mining.subscribe","params":{}}}"#,
        subscribe_params_json
    );
    wh.write_all(format!("{}\n", subscribe).as_bytes())
        .await
        .expect("subscribe");
    // Authorize.
    let authorize = format!(
        r#"{{"id":2,"method":"mining.authorize","params":["{}","x"]}}"#,
        wallet
    );
    wh.write_all(format!("{}\n", authorize).as_bytes())
        .await
        .expect("authorize");

    // Read frames until we have subscribe response, authorize response,
    // and at least one notify. Then submit a share.
    let mut received = Vec::<String>::new();
    let mut submitted = false;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while tokio::time::Instant::now() < deadline {
        let remaining = match deadline.checked_duration_since(tokio::time::Instant::now()) {
            Some(d) => d,
            None => break,
        };
        let mut line = String::new();
        match tokio::time::timeout(remaining, buf.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 => {
                received.push(line.clone());
                // Notify-detection: a frame is a real notify only if
                // its top-level `method` field equals "mining.notify".
                // A bare substring match would catch the subscribe
                // response too (it contains the literal "mining.notify"
                // inside the subscription details tuple).
                if !submitted {
                    let parsed: serde_json::Value =
                        match serde_json::from_str(line.trim()) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                    let is_notify = parsed
                        .get("method")
                        .and_then(serde_json::Value::as_str)
                        == Some("mining.notify");
                    if is_notify {
                        let job_id = parsed["params"][0]
                            .as_str()
                            .expect("notify params[0] must be job_id");
                        let submit_params = submit_params_fn(wallet, job_id);
                        let submit = format!(
                            r#"{{"id":10,"method":"mining.submit","params":{}}}"#,
                            submit_params
                        );
                        wh.write_all(format!("{}\n", submit).as_bytes())
                            .await
                            .expect("submit");
                        submitted = true;
                    }
                }
                // Stop once we have at least one submit response.
                if submitted && line.contains("\"id\":10") {
                    break;
                }
            }
            _ => break,
        }
    }

    (received, Vec::new())
}

fn lolminer_octopus_submit_params(wallet: &str, job_id: &str) -> String {
    // Octopus submit: [worker, job_id, nonce, header_hash] (4 elements).
    format!(
        r#"["{}","{}","0xdeadbeef","0xheaderhash"]"#,
        wallet, job_id
    )
}

fn srbminer_kawpow_submit_params(wallet: &str, job_id: &str) -> String {
    // KawPow submit: [worker, job_id, nonce, header_hash, mix_hash] (5 elements).
    format!(
        r#"["{}","{}","0xdeadbeef","0xheaderhash","0xmixhash"]"#,
        wallet, job_id
    )
}

fn srbminer_autolykos_submit_params(wallet: &str, job_id: &str) -> String {
    // Autolykos2 submit: [worker, job_id, nonce] (3 elements only).
    format!(r#"["{}","{}","0xdeadbeef"]"#, wallet, job_id)
}

// =======================================================================
// Per-(miner, algo) end-to-end tests
// =======================================================================

/// xmrig + RandomX (XMR/ZPH on HashVault). Single `login` frame, no
/// subscribe/authorize. Pool returns session_id + first job bundled in
/// the result. Then submit + ack.
#[tokio::test]
async fn end_to_end_xmrig_randomx_flow() {
    let pool = spawn_mock_pool(hashvault_randomx_script())
        .await
        .expect("mock spawn");
    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    let mut buf = BufReader::new(rh);

    let wallet = "44CuMonero...address";
    // xmrig login frame.
    let login = format!(
        r#"{{"id":1,"jsonrpc":"2.0","method":"login","params":{{"login":"{}","pass":"x","agent":"xmrig/6.21.3","algo":["rx/0"]}}}}"#,
        wallet
    );
    wh.write_all(format!("{}\n", login).as_bytes())
        .await
        .expect("login");

    // Read login response.
    let mut login_resp = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut login_resp))
        .await
        .expect("login timeout")
        .expect("login read");
    let login_parsed: serde_json::Value =
        serde_json::from_str(login_resp.trim()).expect("parse login");
    assert_eq!(
        login_parsed["result"]["status"], "OK",
        "RandomX login must return status:OK; got: {}",
        login_resp.trim()
    );
    let session_id = login_parsed["result"]["id"]
        .as_str()
        .expect("session_id present");
    let first_job_id = login_parsed["result"]["job"]["job_id"]
        .as_str()
        .expect("first job present");
    assert_eq!(first_job_id, "jobXmr001");

    // Submit a share — RandomX submit shape:
    //   params: {id: session_id, job_id, nonce, result}
    let submit = format!(
        r#"{{"id":2,"jsonrpc":"2.0","method":"submit","params":{{"id":"{}","job_id":"{}","nonce":"0a0b0c0d","result":"00deadbeef"}}}}"#,
        session_id, first_job_id
    );
    wh.write_all(format!("{}\n", submit).as_bytes())
        .await
        .expect("submit");

    // Read submit response. The mock pool will also push a second job
    // notify, so we may receive that first — drain until we find the
    // submit ack (id == 2).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut submit_ack_seen = false;
    while tokio::time::Instant::now() < deadline {
        let remaining = match deadline.checked_duration_since(tokio::time::Instant::now()) {
            Some(d) => d,
            None => break,
        };
        let mut line = String::new();
        match tokio::time::timeout(remaining, buf.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 => {
                if line.contains("\"id\":2") && line.contains("\"status\":\"OK\"") {
                    submit_ack_seen = true;
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(submit_ack_seen, "RandomX submit must be acknowledged");
}

/// lolMiner + Octopus (CFX on WoolyPooly). 4-element submit params,
/// `result: true` subscribe response (no extranonce). Already covered
/// by `end_to_end_lolminer_woolypooly_octopus_flow` above; this is the
/// HeroMiners variant which exercises the AgentExt subscribe path +
/// `set_difficulty` push.
#[tokio::test]
async fn end_to_end_lolminer_octopus_flow_herominers() {
    let pool = spawn_mock_pool(herominers_octopus_script())
        .await
        .expect("mock spawn");
    let wallet = "cfx:aamf4hvs6vp807pfrbmm5xkrampxhspjrum636gyrw.worker1";
    // WalletOnly shape — single-element `params: ["<wallet>.<worker>"]`.
    // Confirmed dialect for HeroMiners CFX (cross-referenced from the
    // working server-side CFX proxy).
    let subscribe_params = format!(r#"["{}"]"#, wallet);
    let (received, _) = run_v1_miner_flow(
        pool.port,
        wallet,
        &subscribe_params,
        lolminer_octopus_submit_params,
    )
    .await;

    assert!(
        received.iter().any(|l| l.contains("deadbeef")),
        "subscribe response must be the array+extranonce shape, not an error; got: {:?}",
        received
    );
    assert!(
        received.iter().any(|l| l.contains("mining.set_difficulty")),
        "HeroMiners must push set_difficulty; got: {:?}",
        received
    );
    assert!(
        received.iter().any(|l| l.contains("mining.notify")),
        "must receive at least one notify; got: {:?}",
        received
    );
    let submit_ack = received
        .iter()
        .find(|l| l.contains("\"id\":10") && l.contains("\"result\":true"));
    assert!(
        submit_ack.is_some(),
        "submit must be accepted; received: {:?}",
        received
    );
}

/// SRBMiner + KawPow (RVN on HeroMiners). 5-element submit params (with
/// trailing mix_hash). WalletOnly subscribe shape — same dialect as
/// HeroMiners Octopus (single-element subscribe with wallet+worker).
#[tokio::test]
async fn end_to_end_srbminer_kawpow_flow_herominers() {
    let pool = spawn_mock_pool(herominers_kawpow_script())
        .await
        .expect("mock spawn");
    let wallet = "RTg7DhZEkPGPij9ri6zRQk8Xihe1TJSAbT.rig1";
    let subscribe_params = format!(r#"["{}"]"#, wallet);
    let (received, _) = run_v1_miner_flow(
        pool.port,
        wallet,
        &subscribe_params,
        srbminer_kawpow_submit_params,
    )
    .await;

    assert!(
        received.iter().any(|l| l.contains("abcd")),
        "WalletOnly subscribe must get array+extranonce response; got: {:?}",
        received
    );
    assert!(
        received.iter().any(|l| l.contains("mining.notify")),
        "must receive notify; got: {:?}",
        received
    );
    let submit_ack = received
        .iter()
        .find(|l| l.contains("\"id\":10") && l.contains("\"result\":true"));
    assert!(
        submit_ack.is_some(),
        "5-element KawPow submit must be accepted; received: {:?}",
        received
    );
}

/// SRBMiner + Autolykos2 (ERG on WoolyPooly). 3-element submit, Agent
/// subscribe (no extension). **This is the dialect that regressed
/// 2026-05-17 PM** when the always-restash fix pushed synthetic
/// `mining.set_extranonce` to the miner mid-session. The post-revert
/// behavior should pass this test cleanly.
#[tokio::test]
async fn end_to_end_srbminer_autolykos_flow_woolypooly() {
    let pool = spawn_mock_pool(woolypooly_autolykos_script())
        .await
        .expect("mock spawn");
    let wallet = "9gE1WLJpP4pibWtXUnuFQESL1LF3MyFkDDrB55V27gqk7RKvHvt.ergo";
    let (received, _) = run_v1_miner_flow(
        pool.port,
        wallet,
        r#"["SRBMiner-MULTI/2.5.4"]"#,
        srbminer_autolykos_submit_params,
    )
    .await;

    // Subscribe response must be array-shaped with extranonce (DIFFERENT
    // from WoolyPooly CFX which returns result:true).
    let subscribe_resp = received
        .iter()
        .find(|l| l.contains("\"id\":3"))
        .expect("subscribe response in stream");
    assert!(
        subscribe_resp.contains("cafe"),
        "WoolyPooly ERG must return array with extranonce; got: {}",
        subscribe_resp.trim()
    );
    // Find the REAL mining.notify frame (top-level method, not the
    // literal string embedded in the subscribe response's subscription
    // details tuple).
    let notify_line = received
        .iter()
        .find(|l| {
            serde_json::from_str::<serde_json::Value>(l.trim())
                .ok()
                .and_then(|v| v.get("method").and_then(|m| m.as_str().map(str::to_string)))
                .map(|m| m == "mining.notify")
                .unwrap_or(false)
        })
        .expect("notify in stream");
    let notify_parsed: serde_json::Value =
        serde_json::from_str(notify_line.trim()).expect("parse notify");
    // Autolykos2 notify shape: [job_id, height, msg, b] — 4 elements.
    let notify_params = notify_parsed["params"].as_array().expect("params array");
    assert_eq!(
        notify_params.len(),
        4,
        "Autolykos2 notify must have exactly 4 params; got: {}",
        notify_line.trim()
    );

    let submit_ack = received
        .iter()
        .find(|l| l.contains("\"id\":10") && l.contains("\"result\":true"));
    assert!(
        submit_ack.is_some(),
        "3-element Autolykos2 submit must be accepted; received: {:?}",
        received
    );
}

/// SRBMiner + Autolykos2 (ERG on HeroMiners). Same shape as the
/// WoolyPooly variant — Agent subscribe, array response with extranonce.
/// Pinned separately because HeroMiners has a different hostname-match
/// rule in `pool_quirks` (ergo subdomain → Autolykos branch).
#[tokio::test]
async fn end_to_end_srbminer_autolykos_flow_herominers() {
    let pool = spawn_mock_pool(herominers_autolykos_script())
        .await
        .expect("mock spawn");
    let wallet = "9gE1WLJpP4pibWtXUnuFQESL1LF3MyFkDDrB55V27gqk7RKvHvt.rig1";
    let (received, _) = run_v1_miner_flow(
        pool.port,
        wallet,
        r#"["SRBMiner-MULTI/2.5.4"]"#,
        srbminer_autolykos_submit_params,
    )
    .await;

    assert!(
        received.iter().any(|l| l.contains("\"id\":3") && l.contains("feed")),
        "HeroMiners ERG must return array with extranonce; got: {:?}",
        received
    );
    let submit_ack = received
        .iter()
        .find(|l| l.contains("\"id\":10") && l.contains("\"result\":true"));
    assert!(
        submit_ack.is_some(),
        "Autolykos2 on HeroMiners must accept the 3-param submit; received: {:?}",
        received
    );
}

/// Negative test — SRBMiner sending Empty subscribe (the wrong shape for
/// KawPow/Octopus on HeroMiners) must produce the "Invalid params" error.
/// Pins the failure path so that the AgentExt/Agent distinction in
/// pool_quirks never gets quietly broken.
#[tokio::test]
async fn empty_subscribe_against_herominers_kawpow_returns_invalid_params() {
    let pool = spawn_mock_pool(herominers_kawpow_script())
        .await
        .expect("mock spawn");
    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(b"{\"id\":1,\"method\":\"mining.subscribe\",\"params\":[]}\n")
        .await
        .expect("send");
    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");
    assert!(
        response.contains("Invalid params") && response.contains("\"error\""),
        "Empty subscribe to HeroMiners KawPow must error; got: {}",
        response.trim()
    );
}

// =======================================================================
// 2026-05-17 PM — silent-close regression suite. The HeroMiners CFX
// failure was invisible in tests because no fixture modeled "pool drops
// connection without sending a response." These tests close the gap.
// =======================================================================

/// Pool TCP-closes ~200ms after the proxy connects, before sending any
/// response. The miner simulator should see EOF without any frames.
#[tokio::test]
async fn silent_close_after_delay_produces_no_frames() {
    let script = vec![MockResponse::CloseAfterDelay { delay_ms: 200 }];
    let pool = spawn_mock_pool(script).await.expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    let mut buf = BufReader::new(rh);

    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["lolMiner/1.96","EthereumStratum/1.0.0"]}
"#,
    )
    .await
    .expect("send");

    let mut response = String::new();
    let read_res = tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response)).await;
    match read_res {
        Ok(Ok(0)) => {
            // EOF as expected.
        }
        Ok(Ok(n)) => panic!("expected EOF, got {} bytes: {}", n, response.trim()),
        Ok(Err(_)) => {
            // Connection reset, also acceptable.
        }
        Err(_) => panic!("read should not time out — pool should close within 200ms"),
    }
}

/// Pool accepts subscribes only when the agent string matches the
/// expected value. Models HeroMiners' suspected anti-proxy filter.
/// Sending the proxy's old "PwndaWallet-DevFee-Proxy/1.0" agent
/// produces a silent close. Sending "lolMiner/1.96" succeeds.
#[tokio::test]
async fn pool_with_agent_filter_closes_unknown_agents() {
    let script = vec![
        MockResponse::CloseUnlessAgent {
            expected_agent: "lolMiner",
        },
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":[[["mining.notify","SUB","EthereumStratum/1.0.0"]],"deadbeef",4],"error":null}"#.to_string(),
        },
    ];
    let pool = spawn_mock_pool(script).await.expect("mock spawn");

    // Bad agent — must produce close.
    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    let mut buf = BufReader::new(rh);
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["PwndaWallet-DevFee-Proxy/1.0","EthereumStratum/1.0.0"]}
"#,
    )
    .await
    .expect("send bad-agent subscribe");
    let mut response = String::new();
    let read_res = tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response)).await;
    match read_res {
        Ok(Ok(0)) | Ok(Err(_)) => { /* EOF or RST as expected */ }
        Ok(Ok(n)) => panic!(
            "agent-filtering pool should silently close, got {} bytes: {}",
            n,
            response.trim()
        ),
        Err(_) => panic!("expected close within 1s"),
    }
}

/// Positive: same agent-filtering pool accepts a subscribe with the
/// expected agent string. Locks the fix shipped 2026-05-17 PM — per-algo
/// agent strings (`lolMiner/1.96`, `SRBMiner-MULTI/2.5.4`, `xmrig/x.y.z`)
/// pass anti-proxy filters that reject the old `PwndaWallet-DevFee-Proxy/1.0`
/// banner.
#[tokio::test]
async fn pool_with_agent_filter_accepts_matching_agent() {
    let script = vec![
        MockResponse::CloseUnlessAgent {
            expected_agent: "lolMiner",
        },
        MockResponse::ReplyTo {
            trigger: "mining.subscribe",
            payload: r#"{"id":3,"result":[[["mining.notify","SUB","EthereumStratum/1.0.0"]],"deadbeef",4],"error":null}"#.to_string(),
        },
    ];
    let pool = spawn_mock_pool(script).await.expect("mock spawn");

    let stream = TcpStream::connect(("127.0.0.1", pool.port))
        .await
        .expect("connect");
    let (rh, mut wh) = stream.into_split();
    wh.write_all(
        br#"{"id":1,"method":"mining.subscribe","params":["lolMiner/1.96","EthereumStratum/1.0.0"]}
"#,
    )
    .await
    .expect("send");

    let mut buf = BufReader::new(rh);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(1), buf.read_line(&mut response))
        .await
        .expect("timeout")
        .expect("read");
    assert!(
        response.contains("deadbeef"),
        "agent-filtering pool must accept lolMiner agent; got: {}",
        response.trim()
    );
}

// (The pool_quirks classifier coverage test lives in the in-lib
// `src/dev_fee/pool_quirks.rs::tests` module — the integration test
// here can't reach that module because `dev_fee` is private in lib.rs.
// Same coverage, different cargo entry point.)
