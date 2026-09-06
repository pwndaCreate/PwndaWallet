//! Stage-A conformance: the Rust client's port of the reference harness.
//!
//! Two kinds of test live here, and the split is deliberate.
//!
//! ## 1. Live directional tests (`#[ignore]`)
//!
//! Drive the REAL `-dev` desk end to end in BOTH directions, matching what
//! `reference-client/cmd/harness` does. They are `#[ignore]`d because they need
//! the oracle listening on 127.0.0.1:8795, so the normal `cargo test` run stays
//! hermetic:
//!
//! ```text
//! cd pwnda-desk-handoff/desk-server
//! ./swap-desk.exe -dev -config ../reference-client/config.harness.yaml
//! cargo test --lib desk::conformance -- --ignored --nocapture
//! ```
//!
//! ## 2. Hostile-desk tests (always run)
//!
//! The client's OWN defenses (harness P7: H1/H2/H3) against a desk that LIES.
//! These spin up a tiny in-process HTTP server that misbehaves on demand, so
//! they are self-contained and run in the normal suite — which is where they
//! belong, because they encode the security properties that must never
//! regress silently.
//!
//! The fake desk is deliberately NOT the real one: injecting misbehaviour into
//! the real coordinator's money paths would be its own risk. It ignores sigauth
//! entirely — it is a test double, not a desk.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    use crate::desk::{client, engine, watch, wire};
    use crate::swap::state::SwapState;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use zeroize::Zeroizing;

    // ───────────────────────── shared helpers ─────────────────────────

    /// Deterministic 64-hex schema stand-in. NOT a spend scalar — the client
    /// never puts one on the wire (sub-plan 04 D).
    fn mock_hex(label: &str) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(format!("pwnda-desk-conformance|{label}").as_bytes()))
    }

    /// A SwapState wired to `base` with a fresh, enrolled ed25519 identity.
    async fn enrolled_state(base: &str) -> SwapState {
        let state = SwapState::new();
        state.set_proxy_url(base.to_string());
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        let pubkey = crate::swap::auth::pubkey_b64(&seed);
        state.set_seed(Zeroizing::new(seed), pubkey.clone());
        let _ = crate::swap::proxy::enroll(base, &pubkey).await;
        state
    }

    fn desk_url() -> String {
        std::env::var("DESK_URL").unwrap_or_else(|_| "http://127.0.0.1:8795".into())
    }

    // ───────────────────── live: both directions ──────────────────────

    /// P3-BUY mirror: the user BUYS the follower (XMR) with the leader (ADA),
    /// so the desk FOLLOWS and the CLIENT leads. This is the direction that
    /// exercises `/ready-ack` (the client-side M5) and the opposite half of the
    /// M1/M2 role flip — `adaptorPoint`/`viewKey` arrive in M1 and are NOT sent
    /// in M2.
    #[test]
    #[ignore = "requires a running -dev desk on 127.0.0.1:8795"]
    fn live_buy_follower_to_settled() {
        let base = desk_url();
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move {
            let state = enrolled_state(&base).await;

            // DERIVE the BUY size; do not hardcode it.
            //
            // This test asked for `3` until 2026-07-27, which was valid when it was
            // written and became `DeskSizeOutOfRange` after D23 — the desk's size
            // window is denominated in the FOLLOWER coin (XMR), while a BUY's
            // `amountIn` is the LEADER coin (ADA). The fixture had encoded the same
            // assumption the bug did, which is how two of the desk's own tests
            // survived the same fault: **a fixture that hardcodes a number inherits
            // whatever misunderstanding produced it.**
            //
            // There is no price on `/pairs` (`indicativeSpread` is a spread, not a
            // rate), so a client CANNOT compute a valid BUY size from published
            // data alone. What it can do is ask: a SELL quote at exactly `minSize`
            // returns the ADA that buys that much XMR, which is the bottom of the
            // window expressed in the coin BUY actually sends.
            let pairs = client::pairs(&state).await.expect("pairs");
            let pair = pairs
                .pairs
                .iter()
                .find(|p| p.pair == "XMR/ADA")
                .expect("XMR/ADA offered");

            let probe = client::quote(
                &state,
                &wire::QuoteRequest {
                    pair: "XMR/ADA".into(),
                    direction: "SELL_FOLLOWER".into(),
                    amount_in: pair.min_size.clone(),
                },
            )
            .await
            .expect("probe quote to learn the rate");
            let floor_ada: f64 = probe.amount_out.parse().expect("probe amountOut");
            // Comfortably inside the window: the ceiling is many multiples of the
            // floor, so 1.5x the minimum is safe at both ends without needing the
            // max at all.
            let buy_ada = format!("{:.6}", floor_ada * 1.5);

            let q = client::quote(
                &state,
                &wire::QuoteRequest {
                    pair: "XMR/ADA".into(),
                    direction: "BUY_FOLLOWER".into(),
                    amount_in: buy_ada.clone(),
                },
            )
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "buy quote at {buy_ada} ADA (derived: 1.5x the ADA price of minSize \
                     {} XMR) was rejected: {e:?}. If this is DeskSizeOutOfRange the window \
                     and the derivation disagree — check which coin each is denominated in.",
                    pair.min_size
                )
            });
            assert_eq!(q.desk_role, "FOLLOWER", "BUY_FOLLOWER => the desk follows");

            let m1 = client::accept(
                &state,
                &wire::AcceptRequest {
                    leader_proof: None,
                    quote_id: q.quote_id.clone(),
                    payout_address: "addr_test_payout".into(),
                    refund_address: "addr_test_refund".into(),
                    client_chain_a_pubkey: Some(mock_hex("clientChainA")),
                },
            )
            .await
            .expect("buy accept");

            // THE ROLE FLIP, live: because the desk is the follower here, it
            // supplies the adaptor point + view key in M1. In SELL_FOLLOWER
            // both are null at this point and the CLIENT supplies them in M2.
            assert!(
                m1.adaptor_point.is_some(),
                "desk-as-follower must carry adaptorPoint in M1"
            );
            assert!(
                m1.view_key.is_some(),
                "desk-as-follower must carry viewKey in M1"
            );
            let id = m1.swap_id.clone();

            // M2: the client LEADS, so it does NOT send adaptorPoint/viewKey -
            // they are present-with-null. It DOES send the chain-A timelock
            // slots, which are LEADER material (engine v7): the desk-as-follower
            // feeds them to set_lock_slots so it derives the same chain-A script
            // address it must watch our lock at. Only t2 > t1 > 0 is checked.
            let kr = client::keys(
                &state,
                &id,
                &wire::KeysRequest {
                    client_key_share_point: mock_hex("clientKeyshare"),
                    client_chain_a_pubkey: mock_hex("clientChainA"),
                    adaptor_point: None,
                    view_key: None,
                    dleq_proof: None,
                    t1_slot: Some(84_600_000),
                    t2_slot: Some(84_603_600),
                },
            )
            .await
            .expect("buy keys");
            engine::valid_m2(&kr).expect("M2 must be complete");

            // ── claimDest / claimDestSource: DELIBERATELY NOT ASSERTED HERE ──
            //
            // `buy_leader` calls `claim_dest_check` before submitting our chain-A
            // lock, and an EMPTY `claimDest` reads as `Unpublished` — which logs and
            // PROCEEDS, so that an older desk is not locked out. That default is
            // right and it is also the trap: a desk publishing nothing does not fail
            // the guard, it **silently disables** it, in the one direction where the
            // desk receives the ADA and we are the ones signing the claim.
            //
            // So this property matters more than most — and this suite structurally
            // CANNOT check it. The `-dev` desk runs `engine::Stub`, whose `Status`
            // (stub.go:238) builds an `EngineStatus` with no `ClaimDest` field at
            // all. Against this oracle the value is always empty, for a reason that
            // has nothing to do with the desk's correctness: the desk's own
            // publication is present and correct at `coordinator.go:738`, verified
            // by reading it.
            //
            // The temptation is `if claim_dest != "" { assert ... }`. That is exactly
            // the shape the desk's own dry run was caught by on 2026-07-27 — an
            // assertion reading `ClaimDest != "" && ClaimDestSource == ""`, which
            // passes when both are blank, and both were. **A conditional assertion
            // over a field that is always absent is a check that cannot fail.**
            //
            // Verified instead by the desk's BUY dry run, which drives the real
            // engine over real HTTP. Recorded as a known limit of this suite rather
            // than papered over with a conditional that would always pass.
            let st_m2 = client::status(&state, &id).await.expect("status after M2");
            eprintln!(
                "[conformance] NOT COVERED HERE: claimDest={:?} source={:?} — the -dev \
                 stub engine never populates these. The pre-lock claim-destination \
                 guard is verified by the desk's BUY dry run, not by this suite.",
                st_m2.claim_dest, st_m2.claim_dest_source
            );

            client::refund_sigs(
                &state,
                &id,
                &wire::RefundSigsRequest {
                    refund_presig: wire::AdaptorPresig {
                        r_enc: mock_hex("refundR"),
                        sp: mock_hex("refundS"),
                    },
                    claim_cosig: None,
                leg_sigs: None,
                    lock_utxo: None,   // SELL shape: the desk leads, so no lock UTxO of ours
                },
            )
            .await
            .expect("buy refund-sigs");

            // M4: the client-as-leader locks chain A first.
            let lk = client::lock(
                &state,
                &id,
                &wire::LockRequest {
                    chain: "A".into(),
                    lock_txid: mock_hex("clientLockA"),
                    amount: Some(m1.amount_a.clone()),
                    joint_output_proof: None,
                },
            )
            .await
            .expect("buy lock A");
            assert!(lk.accepted);

            // The desk-as-follower locks chain B and parks at B_LOCKED.
            let mut saw_b_locked = false;
            for _ in 0..40 {
                let st = client::status(&state, &id).await.expect("status");
                if matches!(
                    st.state.as_str(),
                    "B_LOCKED" | "READY" | "A_CLAIMED" | "SETTLED"
                ) {
                    saw_b_locked = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            assert!(saw_b_locked, "desk should lock chain B and await ready-ack");

            // M5: the client-as-leader releases its claim adaptor sig. In the
            // real client this is gated on the client's OWN chain-B confirm
            // (see hostile_h1_* below); here the -dev stub self-confirms.
            let obs = watch::MockObserver::new();
            obs.set_confirmed(watch::Chain::B, 1);
            engine::safe_to_release_claim_sig(&obs, true, 1)
                .expect("gate must pass once our own watcher confirms chain B");

            let sig = wire::AdaptorPresig {
                r_enc: mock_hex("clientClaimR"),
                sp: mock_hex("clientClaimS"),
            };
            client::ready_ack(
                &state,
                &id,
                &wire::ReadyAckRequest {
                    ack: true,
                    claim_adaptor_sig: Some(sig),
                },
            )
            .await
            .expect("buy ready-ack");

            // The desk-as-follower claims chain A and settles.
            let mut final_state = String::new();
            for _ in 0..40 {
                let st = client::status(&state, &id).await.expect("status");
                final_state = st.state.clone();
                if final_state == "SETTLED" {
                    assert!(
                        !st.claim_a_txid.is_empty(),
                        "SETTLED needs a chain-A claim txid"
                    );
                    break;
                }
                if matches!(final_state.as_str(), "FAILED" | "A_REFUNDED" | "ABORTED") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            assert_eq!(final_state, "SETTLED", "BUY_FOLLOWER should reach SETTLED");
        });
    }

    /// P5-H4 mirror: the desk's non-custody scanner rejects a bare scalar in a
    /// non-allowlisted field. Proves from OUR side that the wallet would be
    /// stopped if it ever tried, and that the typed error surfaces correctly
    /// through `classify_error`.
    #[test]
    #[ignore = "requires a running -dev desk on 127.0.0.1:8795"]
    fn live_desk_rejects_a_scalar_in_a_non_allowlisted_field() {
        let base = desk_url();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let state = enrolled_state(&base).await;
            let err = client::abort(
                &state,
                "none",
                &wire::AbortRequest {
                    reason: Some(mock_hex("leak")),
                },
            )
            .await
            .expect_err("a 64-hex scalar in `reason` must be rejected");
            assert!(
                matches!(err, crate::swap::proxy::ProxyError::DeskPrivateKeyRejected),
                "expected DeskPrivateKeyRejected, got {err:?}"
            );
        });
    }

    /// P5-H5 mirror: a bogus/consumed quote is refused, and our shared
    /// classifier maps it to the typed variant the UI keys off.
    #[test]
    #[ignore = "requires a running -dev desk on 127.0.0.1:8795"]
    fn live_expired_quote_is_rejected_as_typed_error() {
        let base = desk_url();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let state = enrolled_state(&base).await;
            let err = client::accept(
                &state,
                &wire::AcceptRequest {
                    leader_proof: None,
                    quote_id: "quote-does-not-exist".into(),
                    payout_address: "addr_a".into(),
                    refund_address: "addr_b".into(),
                    client_chain_a_pubkey: None,
                },
            )
            .await
            .expect_err("a bogus quote id must be rejected");
            assert!(
                matches!(err, crate::swap::proxy::ProxyError::DeskQuoteExpired),
                "expected DeskQuoteExpired, got {err:?}"
            );
        });
    }

    // ─────────────────── hostile desk (P7: H1/H2/H3) ──────────────────

    #[derive(Clone, Copy, PartialEq)]
    enum Hostile {
        /// Claims chain B is locked before it is, to solicit the claim sig early.
        PrematureReady,
        /// Accepts the lock, then goes dark (503) forever.
        OfflineAfterLock,
        /// Returns a truncated, success-shaped M2.
        MalformedM2,
        /// Returns a well-formed M2 that claims accepted but omits the joint
        /// lock material.
        IncompleteM2,
    }

    #[derive(Default)]
    struct HostileLog {
        ready_ack_hits: AtomicU64,
        lock_hits: AtomicU64,
    }

    /// Minimal HTTP/1.1 responder. Hand-rolled rather than pulling in a test
    /// server dep — it only has to answer four paths with canned bodies.
    async fn spawn_hostile(mode: Hostile) -> (String, Arc<HostileLog>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let log = Arc::new(HostileLog::default());
        let log2 = log.clone();

        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let log = log2.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = match sock.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("")
                        .to_string();

                    let (status, body): (u16, String) = if path.ends_with("/enroll") {
                        (200, r#"{"enrolled":true}"#.into())
                    } else if path.ends_with("/lock") {
                        log.lock_hits.fetch_add(1, Ordering::SeqCst);
                        (
                            200,
                            r#"{"swapId":"h","state":"A_LOCKED","accepted":true,"verifying":true}"#
                                .into(),
                        )
                    } else if path.ends_with("/ready-ack") {
                        // THE THING UNDER TEST: did the client release its claim
                        // sig? For H1 it must never reach here while our own
                        // chain-B observation is unconfirmed.
                        log.ready_ack_hits.fetch_add(1, Ordering::SeqCst);
                        (
                            200,
                            r#"{"swapId":"h","state":"READY","ready":true,"releasedClaimSig":null}"#
                                .into(),
                        )
                    } else if path.ends_with("/keys") {
                        match mode {
                            Hostile::MalformedM2 => (
                                200,
                                // Truncated garbage that still claims success.
                                r#"{"swapId":"h","state":"ACCEPTED","accepted":true,"#.into(),
                            ),
                            Hostile::IncompleteM2 => (
                                200,
                                // Well-formed, claims accepted, but no joint
                                // lock material at all.
                                r#"{"swapId":"h","state":"ACCEPTED","chainALockAddr":"","chainBJointKey":"","chainBJointAddr":"","accepted":true}"#
                                    .into(),
                            ),
                            _ => (
                                200,
                                r#"{"swapId":"h","state":"ACCEPTED","chainALockAddr":"addr","chainBJointKey":"k","chainBJointAddr":"xmr","accepted":true}"#
                                    .into(),
                            ),
                        }
                    } else if path.ends_with("/status") {
                        if mode == Hostile::OfflineAfterLock
                            && log.lock_hits.load(Ordering::SeqCst) > 0
                        {
                            (503, String::new()) // the desk has gone dark
                        } else {
                            let state = if mode == Hostile::PrematureReady {
                                "B_LOCKED" // THE LIE
                            } else {
                                "A_LOCKED"
                            };
                            (200, format!(r#"{{"swapId":"h","pair":"XMR/ADA","direction":"BUY_FOLLOWER","deskRole":"FOLLOWER","state":"{state}","coinIn":"ADA","coinOut":"XMR","amountIn":"3","amountOut":"0.009","lockATxid":"a","lockBTxid":"","claimATxid":"","sweepBTxid":"","refundTxid":"","reclaimTxid":"","confsA":3,"confsB":0,"minConfsA":3,"minConfsB":10,"t0":1,"t1":2,"t2":3,"t0Remaining":0,"t1Remaining":0,"readyAck":false,"releasedClaimSig":null,"updatedAt":1,"error":""}}"#))
                        }
                    } else {
                        (404, r#"{"error":"NOT_FOUND"}"#.into())
                    };

                    let resp = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.flush().await;
                });
            }
        });

        (format!("http://{addr}"), log)
    }

    /// **H1 — the setReady-timing theft.**
    ///
    /// A hostile desk reports chain B locked BEFORE it is, to solicit the
    /// client-as-leader's claim adaptor sig early. A naive client that trusts
    /// `/status` releases it and loses chain A. The safe client gates
    /// `/ready-ack` on its OWN chain-B observation and refuses.
    #[tokio::test]
    async fn hostile_h1_refuses_to_release_claim_sig_on_the_desks_word() {
        let (base, log) = spawn_hostile(Hostile::PrematureReady).await;
        let state = enrolled_state(&base).await;
        let obs = watch::MockObserver::new(); // our watcher has NOT confirmed chain B

        // ── Cycle 1: the desk lies, our watcher has not confirmed. ──
        let st = client::status(&state, "h").await.expect("status");
        assert_eq!(
            st.state, "B_LOCKED",
            "the hostile desk is supposed to be lying here"
        );
        // THE DECISION UNDER TEST: gate on our OWN view, not the desk's word.
        if engine::safe_to_release_claim_sig(&obs, st.state == "B_LOCKED", 1).is_ok() {
            let _ = client::ready_ack(
                &state,
                "h",
                &wire::ReadyAckRequest {
                    ack: true,
                    claim_adaptor_sig: Some(wire::AdaptorPresig {
                        r_enc: mock_hex("r"),
                        sp: mock_hex("s"),
                    }),
                },
            )
            .await;
        }
        assert_eq!(
            log.ready_ack_hits.load(Ordering::SeqCst),
            0,
            "client released its claim sig on the desk's word alone - this is the theft"
        );

        // ── Cycle 2: our OWN watcher confirms chain B -> releasing is correct. ──
        obs.set_confirmed(watch::Chain::B, 1);
        let st = client::status(&state, "h").await.expect("status");
        if engine::safe_to_release_claim_sig(&obs, st.state == "B_LOCKED", 1).is_ok() {
            let _ = client::ready_ack(
                &state,
                "h",
                &wire::ReadyAckRequest {
                    ack: true,
                    claim_adaptor_sig: Some(wire::AdaptorPresig {
                        r_enc: mock_hex("r"),
                        sp: mock_hex("s"),
                    }),
                },
            )
            .await;
        }
        assert_eq!(
            log.ready_ack_hits.load(Ordering::SeqCst),
            1,
            "client should release once its own observation confirms chain B"
        );
    }

    /// **H2 — the desk goes dark after the lock.**
    ///
    /// Once the client's coin is locked, a desk that stops answering must not
    /// be able to strand the funds. The refund watcher fires at T1 with the
    /// desk returning 503, because it depends on the local clock and the
    /// client's own settlement signal — never on the desk.
    #[tokio::test]
    async fn hostile_h2_refund_fires_with_the_desk_offline() {
        let (base, log) = spawn_hostile(Hostile::OfflineAfterLock).await;
        let state = enrolled_state(&base).await;

        let lk = client::lock(
            &state,
            "h",
            &wire::LockRequest {
                chain: "B".into(),
                lock_txid: mock_hex("lockB"),
                amount: Some("0.1".into()),
                joint_output_proof: None,
            },
        )
        .await
        .expect("lock accepted");
        assert!(lk.accepted);
        assert_eq!(log.lock_hits.load(Ordering::SeqCst), 1);

        // The desk is now dark. Confirm that from the client's side.
        assert!(
            client::status(&state, "h").await.is_err(),
            "the hostile desk should be returning 503 after the lock"
        );

        // T1 has passed and our own observation never saw settlement.
        let stop = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        let w = watch::RefundWatcher {
            t1_unix: 1_000,
            poll: std::time::Duration::from_millis(1),
        };
        let outcome = w
            .run(stop, || 2_000, move || async move { f.store(true, Ordering::SeqCst) })
            .await;

        assert_eq!(outcome, watch::RefundOutcome::Refunded);
        assert!(
            fired.load(Ordering::SeqCst),
            "refund must fire without the desk - this is what makes an unattended swap safe"
        );
    }

    /// **H3a — a truncated, success-shaped M2.**
    ///
    /// The client must fail the decode and stop, not crash and not proceed to
    /// lock funds against a response it could not read.
    #[tokio::test]
    async fn hostile_h3_rejects_a_truncated_m2() {
        let (base, _log) = spawn_hostile(Hostile::MalformedM2).await;
        let state = enrolled_state(&base).await;

        let res = client::keys(
            &state,
            "h",
            &wire::KeysRequest {
                client_key_share_point: mock_hex("k"),
                client_chain_a_pubkey: mock_hex("c"),
                adaptor_point: None,
                view_key: None,
                dleq_proof: None,
                // H3 exercises a malformed/incomplete RESPONSE; the request's
                // role material is not what is under test.
                t1_slot: None,
                t2_slot: None,
            },
        )
        .await;

        let err = res.expect_err("truncated JSON must not decode");
        assert!(
            matches!(err, crate::swap::proxy::ProxyError::Parse(_)),
            "expected a parse error, got {err:?}"
        );
    }

    /// **H3b — a well-formed M2 that CLAIMS success but omits the joint lock
    /// material.** This one decodes cleanly, so only the semantic gate catches
    /// it. It must be rejected BEFORE any funds move.
    #[tokio::test]
    async fn hostile_h3_rejects_a_success_shaped_but_incomplete_m2() {
        let (base, _log) = spawn_hostile(Hostile::IncompleteM2).await;
        let state = enrolled_state(&base).await;

        let kr = client::keys(
            &state,
            "h",
            &wire::KeysRequest {
                client_key_share_point: mock_hex("k"),
                client_chain_a_pubkey: mock_hex("c"),
                adaptor_point: None,
                view_key: None,
                dleq_proof: None,
                // H3 exercises a malformed/incomplete RESPONSE; the request's
                // role material is not what is under test.
                t1_slot: None,
                t2_slot: None,
            },
        )
        .await
        .expect("this one decodes fine - that is the point");

        assert!(kr.accepted, "the desk is claiming success");
        assert_eq!(
            engine::valid_m2(&kr),
            Err(engine::EngineError::IncompleteM2),
            "a success-shaped M2 with no joint lock address must be refused"
        );
    }
}
