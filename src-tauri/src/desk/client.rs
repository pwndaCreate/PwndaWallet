//! Signed `/api/desk/*` transport — the Rust twin of the reference client's
//! `client.go`. It is a thin typed surface over the wallet's EXISTING sigauth
//! rail ([`crate::swap::proxy`]): every call here delegates to `post_signed` /
//! `get_signed`, so there is ONE signing implementation and no duplicated
//! crypto. The desk shares the wallet's enrolled ed25519 pubkey as its identity
//! — there is no separate desk enrollment (sub-plan 04 C).
//!
//! In production these functions dial the desk's `.b32.i2p` address through the
//! wallet's i2pd sidecar; the transport is identical loopback-vs-I2P (only the
//! configured base URL changes), which is why the same code proves out against
//! the loopback `-dev` desk in the conformance test below.
//!
//! Every desk message has a full serde mirror + round-trip test in
//! [`super::wire`] (the silent-strip guard). Desk-specific error codes
//! (`QUOTE_EXPIRED`, `INVENTORY_UNAVAILABLE`, `SWAP_STATE_CONFLICT`,
//! `PAIR_HALTED`, `SIZE_OUT_OF_RANGE`, `PRIVATE_KEY_REJECTED`) are classified
//! into typed [`ProxyError`] variants by the shared `classify_error`.
//!
//! Choreography (from `traces/wire-trace.md`), all calls after `/enroll`
//! sigauthed; `{id}` is the swapId from [`accept`]:
//!
//! ```text
//! quote -> accept(M1) -> keys(M2) -> refund-sigs(M3) -> lock(M4)
//!   SELL_FOLLOWER (desk leads): desk drives A_LOCKED->B_LOCKED->READY->A_CLAIMED->SETTLED
//!   BUY_FOLLOWER  (client leads): client locks A, desk locks B, client releases via ready-ack(M5)
//! ```
//!
//! NOTE: these calls are the raw wire transport. In the real client every one
//! that authorizes value movement is GATED by `engine`/`watch` on the client's
//! OWN chain observation (never the desk's `/status`) — see [`super`] and
//! sub-plan 04 D. This module does not gate; it only speaks the protocol.

#![allow(dead_code)] // consumed by desk/engine.rs + desk/commands.rs (added next)

use super::wire;
use crate::swap::proxy::{self, ProxyError};
use crate::swap::state::SwapState;

fn swap_path(id: &str, sub: &str) -> String {
    format!("/api/desk/swap/{id}/{sub}")
}

/// `GET /api/desk/pairs` — public (unsigned). The routable-pairs roster.
pub async fn pairs(state: &SwapState) -> Result<wire::PairsResponse, ProxyError> {
    let base = state.proxy_url().ok_or(ProxyError::NoUrl)?;
    proxy::get_unsigned(&base, "/api/desk/pairs").await
}

/// `GET /api/desk/effective-config` — public (unsigned). The desk's RESOLVED
/// runtime config: the commitment surface, as opposed to the `/pairs`
/// advertisement. CC-2's follower fallback reads `ada.refundTimelockSlots` /
/// `ada.swipeDeltaSlots` from here when M1 carried no slots; a failure is
/// reported to the caller as could-not-look, never swallowed into a default.
pub async fn effective_config(state: &SwapState) -> Result<wire::EffectiveConfig, ProxyError> {
    let base = state.proxy_url().ok_or(ProxyError::NoUrl)?;
    proxy::get_unsigned(&base, "/api/desk/effective-config").await
}

/// `POST /api/desk/quote` — priced quote (deskRole + terms). Re-quote if the
/// TTL expires before [`accept`]; do not settle on a stale rate.
pub async fn quote(
    state: &SwapState,
    req: &wire::QuoteRequest,
) -> Result<wire::QuoteResponse, ProxyError> {
    proxy::post_signed(state, "/api/desk/quote", req).await
}

/// `POST /api/desk/accept` — reserves inventory, creates the swap, returns M1.
/// `adaptorPoint`/`viewKey` in M1 are populated only when the desk is the
/// follower (BUY_FOLLOWER).
pub async fn accept(
    state: &SwapState,
    req: &wire::AcceptRequest,
) -> Result<wire::AcceptResponse, ProxyError> {
    proxy::post_signed(state, "/api/desk/accept", req).await
}

/// `POST /api/desk/swap/{id}/keys` — M2. `adaptorPoint`/`viewKey` are sent
/// (present-with-null otherwise) only when the CLIENT is the follower.
pub async fn keys(
    state: &SwapState,
    id: &str,
    req: &wire::KeysRequest,
) -> Result<wire::KeysResponse, ProxyError> {
    proxy::post_signed(state, &swap_path(id, "keys"), req).await
}

/// `POST /api/desk/swap/{id}/refund-sigs` — M3, pre-signed BEFORE any funds
/// move.
pub async fn refund_sigs(
    state: &SwapState,
    id: &str,
    req: &wire::RefundSigsRequest,
) -> Result<wire::RefundSigsResponse, ProxyError> {
    proxy::post_signed(state, &swap_path(id, "refund-sigs"), req).await
}

/// `POST /api/desk/swap/{id}/lock` — M4. Reports the submitter's own lock txid;
/// the desk verifies on-chain itself. In the real client this fires only AFTER
/// the client's own watcher confirms the counterparty lock + refund-path safety.
pub async fn lock(
    state: &SwapState,
    id: &str,
    req: &wire::LockRequest,
) -> Result<wire::LockResponse, ProxyError> {
    proxy::post_signed(state, &swap_path(id, "lock"), req).await
}

/// `POST /api/desk/swap/{id}/ready-ack` — the client-side M5 (client-as-leader
/// releases its claim adaptor sig). MUST be gated on the client's own chain-B
/// confirmation by `engine`, never on the desk's word (the setReady-timing
/// theft; harness H1).
pub async fn ready_ack(
    state: &SwapState,
    id: &str,
    req: &wire::ReadyAckRequest,
) -> Result<wire::ReadyAckResponse, ProxyError> {
    proxy::post_signed(state, &swap_path(id, "ready-ack"), req).await
}

/// `GET /api/desk/swap/{id}/status` — poll the 8.1 state. ADVICE only.
pub async fn status(state: &SwapState, id: &str) -> Result<wire::StatusResponse, ProxyError> {
    proxy::get_signed(state, &swap_path(id, "status")).await
}

/// `POST /api/desk/swap/{id}/abort` — release a pre-lock reservation. Rejected
/// (409) once the swap has locked; post-lock recovery is timeout-driven.
pub async fn abort(
    state: &SwapState,
    id: &str,
    req: &wire::AbortRequest,
) -> Result<wire::AbortResponse, ProxyError> {
    proxy::post_signed(state, &swap_path(id, "abort"), req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic 64-hex schema stand-in (NOT a real spend scalar — the
    /// client never puts one on the wire; sub-plan 04 D). Mirrors the Go
    /// harness's `mockHex` intent so the `-dev` stub sees well-formed material.
    fn mock_hex(label: &str) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(format!("pwnda-desk-mock|{label}").as_bytes()))
    }

    /// Build a SwapState wired to a fresh, enrolled ed25519 identity pointed at
    /// the loopback `-dev` desk. Uses a random seed so repeated runs don't
    /// collide, and injects it directly (no OS keyring) so the test is hermetic.
    async fn enrolled_state(base: &str) -> SwapState {
        use zeroize::Zeroizing;
        let state = SwapState::new();
        state.set_proxy_url(base.to_string());

        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        let pubkey = crate::swap::auth::pubkey_b64(&seed);
        state.set_seed(Zeroizing::new(seed), pubkey.clone());

        let (status, body) = proxy::enroll(base, &pubkey).await.expect("enroll call");
        assert_eq!(status, 200, "enroll should 200: {body}");
        state
    }

    /// LIVE conformance smoke test — the Rust client's twin of the Go harness's
    /// P2+P3 SELL_FOLLOWER path. Drives the real `-dev` desk (stub engine, mem
    /// ledger, mock oracle — no chains, no funds) end to end:
    /// quote -> accept -> keys(M2) -> refund-sigs(M3) -> lock(M4) -> SETTLED.
    ///
    /// `#[ignore]` because it needs the desk listening on 127.0.0.1:8795:
    ///   (terminal 1) cd pwnda-desk-handoff/desk-server && \
    ///                ./swap-desk.exe -dev -config ../reference-client/config.harness.yaml
    ///   (terminal 2) cargo test --lib desk::client -- --ignored --nocapture
    /// Overridable via DESK_URL. This is the Rust half of Stage-A conformance;
    /// the full both-directions + H1/H2/H3 suite lands with engine.rs/watch.rs.
    #[test]
    #[ignore = "requires a running -dev desk on 127.0.0.1:8795 (see doc comment)"]
    fn live_sell_follower_to_settled() {
        let base = std::env::var("DESK_URL").unwrap_or_else(|_| "http://127.0.0.1:8795".into());
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move {
            let state = enrolled_state(&base).await;

            // quote
            let q = quote(
                &state,
                &wire::QuoteRequest {
                    pair: "XMR/ADA".into(),
                    direction: "SELL_FOLLOWER".into(),
                    amount_in: "0.1".into(),
                },
            )
            .await
            .expect("quote");
            assert_eq!(q.desk_role, "LEADER", "SELL_FOLLOWER => desk leads");
            assert!(!q.quote_id.is_empty());

            // accept -> M1
            let m1 = accept(
                &state,
                &wire::AcceptRequest {
                    leader_proof: None,
                    quote_id: q.quote_id.clone(),
                    payout_address: "addr_test_client_payout".into(),
                    refund_address: "addr_test_client_refund".into(),
                    client_chain_a_pubkey: Some(mock_hex("clientChainA")),
                },
            )
            .await
            .expect("accept");
            assert!(!m1.swap_id.is_empty());
            assert!(!m1.desk_key_share_point.is_empty());
            // desk leads => adaptorPoint/viewKey null in M1
            assert!(m1.adaptor_point.is_none());
            let id = m1.swap_id.clone();

            // keys(M2): client is the follower, so it contributes T + view key
            let kr = keys(
                &state,
                &id,
                &wire::KeysRequest {
                    client_key_share_point: mock_hex("clientKeyshare"),
                    client_chain_a_pubkey: mock_hex("clientChainA"),
                    adaptor_point: Some(mock_hex("adaptorT")),
                    view_key: Some(mock_hex("viewkey")),
                    dleq_proof: None, // ADA same-curve
                    // Client FOLLOWS here, so the slots are the DESK's to commit
                    // (it sent them in M1). Leader material stays null.
                    t1_slot: None,
                    t2_slot: None,
                },
            )
            .await
            .expect("keys");
            assert!(kr.accepted);
            assert!(!kr.chain_a_lock_addr.is_empty());

            // refund-sigs(M3)
            let rs = refund_sigs(
                &state,
                &id,
                &wire::RefundSigsRequest {
                    refund_presig: wire::AdaptorPresig {
                        r_enc: mock_hex("refundR"),
                        sp: mock_hex("refundS"),
                    },
                    claim_cosig: None,
                leg_sigs: None,
                    lock_utxo: None,   // SELL shape against the -dev oracle: we hold no chain-A lock
                },
            )
            .await
            .expect("refund-sigs");
            assert!(rs.verified);

            // lock(M4): follower reports chain-B lock (the stub self-confirms)
            let lk = lock(
                &state,
                &id,
                &wire::LockRequest {
                    chain: "B".into(),
                    lock_txid: mock_hex("clientLockB"),
                    amount: Some(m1.amount_b.clone()),
                    joint_output_proof: None,
                },
            )
            .await
            .expect("lock");
            assert!(lk.accepted);

            // poll to SETTLED
            let mut final_state = String::new();
            for _ in 0..50 {
                let st = status(&state, &id).await.expect("status");
                final_state = st.state.clone();
                if final_state == "SETTLED" {
                    assert!(!st.claim_a_txid.is_empty(), "SETTLED needs a chain-A claim");
                    assert!(!st.sweep_b_txid.is_empty(), "SETTLED needs a chain-B sweep");
                    break;
                }
                if matches!(final_state.as_str(), "FAILED" | "A_REFUNDED" | "ABORTED") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            assert_eq!(final_state, "SETTLED", "swap should reach SETTLED");
        });
    }

    /// LIVE LEADER-PROOF NEGOTIATION - the seam DESK-ANSWER-v103 says is still
    /// unproven: *"your negotiation, your M1 refusal and your `#[serde(default)]`
    /// are yours and were not exercised here."*
    ///
    /// **Moves no funds and locks nothing.** It goes quote -> accept -> assert ->
    /// abort. Every one of those is pre-lock: `accept` reserves inventory and
    /// mints the desk's M1, and `abort` is the endpoint that exists to release a
    /// pre-lock reservation. It never reaches M3, M4, or any chain. The abort
    /// runs on every path, including assertion failure, so a red test does not
    /// leave a reservation parked on the desk.
    ///
    /// What it actually exercises, which unit tests cannot:
    ///
    /// * our `AcceptRequest.leaderProof` is understood by the real desk;
    /// * the desk's answer decodes through our `#[serde(default)]` mirror off
    ///   the real wire rather than a fixture we wrote;
    /// * [`super::engine::must_refuse_at_m1`] evaluated against a LIVE M1, in the
    ///   FOLLOWER role — the role whose chain-B lock the engine guard stops.
    ///
    /// SELL_FOLLOWER is chosen deliberately: it is the direction in which WE
    /// follow, so it is the only one where our own refusal is the operative one.
    ///
    ///   cargo test --features full --lib desk::client::tests::live_leader_proof_negotiation \
    ///       -- --ignored --nocapture
    #[test]
    #[ignore = "drives the real desk pre-lock (quote/accept/abort); see DESK-ANSWER-v103"]
    fn live_leader_proof_negotiation() {
        let base = std::env::var("DESK_URL").unwrap_or_else(|_| "http://127.0.0.1:8796".into());
        let pair = std::env::var("DESK_PAIR").unwrap_or_else(|_| "XMR/LTC".into());
        let amount = std::env::var("DESK_AMOUNT").unwrap_or_else(|_| "0.05".into());

        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move {
            let state = enrolled_state(&base).await;

            let q = quote(
                &state,
                &wire::QuoteRequest {
                    pair: pair.clone(),
                    direction: "SELL_FOLLOWER".into(),
                    amount_in: amount.clone(),
                },
            )
            .await
            .expect("quote");
            println!("quote      : {} deskRole={}", q.quote_id, q.desk_role);

            // We FOLLOW on SELL_FOLLOWER, so the desk must LEAD.
            assert_eq!(q.desk_role, "LEADER", "SELL_FOLLOWER => desk leads");
            let role = super::super::engine::ClientRole::from_direction("SELL_FOLLOWER").unwrap();

            let m1 = accept(
                &state,
                &wire::AcceptRequest {
                    quote_id: q.quote_id.clone(),
                    // NOT `mock_hex` — the REAL desk rejects a 64-hex string in
                    // an address field with PRIVATE_KEY_REJECTED, a guard the
                    // `-dev` desk the conformance test targets does not have.
                    // That is the desk protecting a user from pasting a key, and
                    // it means the existing conformance fixtures cannot be
                    // pointed at production unchanged.
                    payout_address: std::env::var("DESK_PAYOUT")
                        .expect("DESK_PAYOUT must be a real chain-A address for this pair"),
                    refund_address: std::env::var("DESK_REFUND")
                        .expect("DESK_REFUND must be a real chain-B address for this pair"),
                    client_chain_a_pubkey: None,
                    // The capability, ON, which is what the desk asked us to point
                    // at it. DESK_NO_CAPABILITY=1 omits the field entirely, which
                    // is the A/B that separates "the desk rejects our new field"
                    // from "the desk rejects something else in this body".
                    leader_proof: match std::env::var("DESK_CAPABILITY").as_deref() {
                        Ok("omit") => None,
                        Ok("false") => Some(false),
                        _ => Some(true),
                    },
                },
            )
            .await
            .expect("accept");

            // Abort on EVERY path from here, so a failed assertion does not park
            // a reservation on the desk. The result is reported, not unwrapped:
            // an abort failure must not mask the assertion that caused it.
            let verdict = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                println!("m1         : swap={} leaderProof={}", m1.swap_id, m1.leader_proof);
                println!(
                    "dleqProof  : {}",
                    m1.dleq_proof
                        .as_deref()
                        .map(|p| format!("{} hex chars, [0:66]={}", p.len(), &p[..66.min(p.len())]))
                        .unwrap_or_else(|| "(none)".into())
                );

                let leg = if pair.to_ascii_uppercase().ends_with("/LTC") {
                    super::super::sidecar::Leg::Ltc
                } else {
                    super::super::sidecar::Leg::Ada
                };
                let refuse = super::super::engine::must_refuse_at_m1(leg, role, m1.leader_proof);
                println!("must_refuse_at_m1({leg:?}, {role:?}, {}) = {refuse}", m1.leader_proof);

                // The invariant that must hold on EVERY leg: our refusal agrees
                // with the negotiated value and our role. Asserting only "the
                // capability is on" would make this test unrunnable on the ADA
                // leg, where `false` is the correct and permanent answer.
                match leg {
                    super::super::sidecar::Leg::Ada => {
                        assert!(
                            !m1.leader_proof,
                            "ADA is same-curve; the desk must never claim the capability there"
                        );
                        assert!(!refuse, "ADA needs no proof, so a false answer is not a refusal");
                    }
                    super::super::sidecar::Leg::Ltc => {
                        assert!(
                            m1.leader_proof,
                            "we asked for the capability on {pair} and the desk answered no — as \
                             FOLLOWER our engine would refuse the chain-B lock (ltc_swap.py:544), \
                             so this swap could not settle"
                        );
                        assert!(!refuse, "capability granted, so nothing to refuse");
                    }
                }

                // Step 1 of the mutual exchange, checkable from a value we already
                // reproduced from the leader seed on our own machine.
                if let Some(p) = m1.dleq_proof.as_deref() {
                    assert!(
                        p.len() >= 66,
                        "a leader dleqProof must carry at least the 33-byte point"
                    );
                    println!("pkasl[0:33]: {}", &p[..66]);
                }
            }));

            match abort(
                &state,
                &m1.swap_id,
                &wire::AbortRequest {
                    reason: Some("client negotiation probe, pre-lock, no funds".into()),
                },
            )
            .await
            {
                Ok(a) => println!("abort      : {} released", a.swap_id),
                Err(e) => println!("abort      : FAILED ({e}) — reservation may need manual release"),
            }

            if let Err(p) = verdict {
                std::panic::resume_unwind(p);
            }
        });
    }

    /// LIVE TRANSPORT SIZE SWEEP - the measurement DESK-ANSWER-v99 section 1 asks
    /// for. Moves no funds and touches no swap state: it enrolls a fresh identity
    /// and does signed GETs against `/api/desk/echo?bytes=N`.
    ///
    /// **Why this measures anything.** v98's four samples were all at ONE payload
    /// size, and at one size "slow per byte" and "fixed tunnel build" fit the same
    /// numbers while calling for opposite fixes. Only a sweep across sizes
    /// separates the intercept from the slope.
    ///
    /// **Why the timeout here is 180s and not the production 20s.** The thing under
    /// measurement IS the time, and a 20-second client turns every sample over the
    /// deadline into an error instead of a datapoint - censoring exactly the slow
    /// tail that decides the question. The 20s deadline is applied in ANALYSIS
    /// against the recorded milliseconds, never by the instrument.
    ///
    /// Emits `bytes,milliseconds,...` on stdout for `tools/fit-transport-model.py`.
    /// Failures are recorded as rows with ok=false rather than panicking, so one
    /// bad sample cannot destroy the sweep.
    ///
    ///   cargo test --features full --lib desk::client::tests::live_transport_size_sweep \
    ///       -- --ignored --nocapture
    #[test]
    #[ignore = "requires the desk reachable via the i2p proxy (Start-Stack.ps1); see DESK-ANSWER-v99 s1"]
    fn live_transport_size_sweep() {
        use std::time::Instant;

        let base = std::env::var("DESK_URL").unwrap_or_else(|_| "http://127.0.0.1:8796".into());
        let reps: usize = std::env::var("SWEEP_REPS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5);
        // 97786 is the exact hex length of a real DLEAG proof.
        let sizes: Vec<usize> = std::env::var("SWEEP_SIZES")
            .ok()
            .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
            .unwrap_or_else(|| vec![1000, 5000, 10000, 25000, 50000, 97786]);

        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move {
            let state = enrolled_state(&base).await;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()
                .expect("sweep client");

            println!("# live transport sweep, base={base}, reps={reps}");
            println!("bytes,milliseconds,rep,echo_header,body_len,ok");
            // ORDER MATTERS, and the first version of this got it wrong. Sizes
            // outside / reps inside walks the sizes in ascending order exactly
            // once, so size and elapsed-time are perfectly confounded and any
            // slow tunnel window is booked as a per-byte cost (D170's sibling:
            // there, one payload size made a latency look like a rate; here, one
            // measurement ORDER makes drift look like a slope).
            //
            // Reps OUTSIDE, sizes INSIDE, alternating direction each pass: a slow
            // window now lands on different sizes on different passes instead of
            // always on the large ones, so drift cannot alias onto the x-axis.
            for rep in 1..=reps {
                let mut pass: Vec<usize> = sizes.clone();
                if rep % 2 == 0 {
                    pass.reverse();
                }
                for &size in &pass {
                    // The signature covers the path. Include the query string: it is
                    // part of what the desk receives, and if their canonicalisation
                    // disagrees this fails LOUDLY as a 401 rather than skewing a time.
                    let path = format!("/api/desk/echo?bytes={size}");
                    let url = format!("{}{}", base.trim_end_matches('/'), path);
                    let builder = client.get(&url);
                    let signed = state
                        .with_seed(|seed| {
                            let h = crate::swap::auth::build_headers(seed, "GET", &path, &[], 0);
                            client
                                .get(&url)
                                .header("X-Client-Pubkey", h.pubkey)
                                .header("X-Client-Timestamp", h.timestamp)
                                .header("X-Client-Nonce", h.nonce)
                                .header("X-Client-Sig", h.signature)
                        })
                        .unwrap_or(builder);

                    let t0 = Instant::now();
                    let outcome = async {
                        let resp = signed.send().await.map_err(|e| e.to_string())?;
                        let status = resp.status().as_u16();
                        let echo = resp
                            .headers()
                            .get("X-Echo-Bytes")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("-")
                            .to_string();
                        let body = resp.bytes().await.map_err(|e| e.to_string())?;
                        Ok::<_, String>((status, echo, body.len()))
                    }
                    .await;
                    // Timed across the FULL body read, matching what the production
                    // 20s total deadline actually covers.
                    let ms = t0.elapsed().as_millis();

                    match outcome {
                        Ok((status, echo, len)) => {
                            let ok = status == 200 && len == size;
                            println!("{size},{ms},{rep},{echo},{len},{ok}");
                            if !ok {
                                println!("#   status={status} expected_len={size} got={len}");
                            }
                        }
                        Err(e) => println!("{size},{ms},{rep},-,0,false  # {e}"),
                    }
                }
            }
        });
    }
}
