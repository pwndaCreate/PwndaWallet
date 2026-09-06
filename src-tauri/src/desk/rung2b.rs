//! Rung 2b: M3 pre-signature agreement + the M5 release gate, on Cardano preprod.
//!
//! # What this rung proves that nothing before it does
//!
//! Rung 1 and the offline half of rung 2 are already proven cross-machine by the
//! KAT vectors reproducing byte-identically here against the desk's Linux-
//! generated file, across every engine version. What is NOT yet proven is the
//! part that depends on two *independently fetched* views of a live chain
//! agreeing at the moment of signing:
//!
//! - `exchange_refund_sigs` (M3) builds a canonical Cardano refund body whose
//!   fee comes from **live protocol parameters**. If the two sides estimate
//!   against different params they build different bodies, the txids differ, and
//!   the pre-signature "fails to verify" when nothing is actually wrong.
//! - `init_swap(role=LEADER)` with slots unsupplied derives them from the **live
//!   chain tip**, so the leader's committed refund window is only real here.
//!
//! Both are fail-closed (a mismatch blocks, it does not strand), which is why
//! this rung is safe to run before any funds exist — and why it is worth running
//! before any do.
//!
//! # What it needs, and why it cannot self-provision
//!
//! | Requirement | Why |
//! |---|---|
//! | `PWNDA_2B_BLOCKFROST_PROJECT_ID` | a **read-only** preprod project id. Chain reads only: this rung never submits a transaction and never needs a funded wallet. |
//! | `PWNDA_ENGINE_TEST_PYTHON` + `_DIR` | the sidecar interpreter + engine tree |
//! | the desk running its side on preprod | for the cross-machine variant — see below |
//!
//! The project id is a credential; this harness reads it from the environment
//! and never persists or logs it. Absent any of the three, every test here skips
//! so `cargo test` stays green.
//!
//! # Local vs cross-machine
//!
//! Run locally, both sidecars fetch params from the same project within
//! milliseconds, so agreement is nearly tautological — it still proves the
//! harness, the pre-sig verification, and the M5 gate, but not the property the
//! rung exists for. The REAL run is cross-machine, with the desk driving its own
//! sidecar against its own chain access at the same time. That is why the
//! kick-off is coordinated rather than unilateral.
//!
//! Scope: **dev + public testnet only, no funds.** This rung reads the chain and
//! signs nothing that is broadcast.

#![cfg(test)]

use super::crypto::{CounterpartyKeys, SwapInitContext, VendoredDeskCrypto};
use super::engine::ClientRole;
use super::sidecar::{EngineSidecar, SidecarConfig};

/// Everything the rung needs from the environment, or a reason it cannot run.
struct Rung2bEnv {
    python: String,
    engine_dir: String,
    project_id: String,
    blockfrost_url: Option<String>,
    /// Required by the engine since v12. Loopback stagenet, never the 18083
    /// default — see the note in `provider_at`.
    xmr_wallet_rpc: String,
}

impl Rung2bEnv {
    /// `None` (with a printed reason) when the rung cannot run. Deliberately
    /// prints WHICH piece is missing — "skipped" with no reason is how a rung
    /// silently stops running.
    fn load() -> Option<Self> {
        let missing = |k: &str| {
            eprintln!("rung2b: SKIPPED - {k} is not set");
            None::<Rung2bEnv>
        };
        let python = match std::env::var("PWNDA_ENGINE_TEST_PYTHON") {
            Ok(v) => v,
            Err(_) => return missing("PWNDA_ENGINE_TEST_PYTHON"),
        };
        let engine_dir = match std::env::var("PWNDA_ENGINE_TEST_DIR") {
            Ok(v) => v,
            Err(_) => return missing("PWNDA_ENGINE_TEST_DIR"),
        };
        let project_id = match std::env::var("PWNDA_2B_BLOCKFROST_PROJECT_ID") {
            Ok(v) if !v.trim().is_empty() => v,
            _ => return missing("PWNDA_2B_BLOCKFROST_PROJECT_ID (read-only preprod)"),
        };
        Some(Self {
            python,
            engine_dir,
            project_id,
            blockfrost_url: std::env::var("PWNDA_2B_BLOCKFROST_URL").ok(),
            // Overridable, but the fallback is the stagenet port from
            // client-testnet.env.sh rather than the engine's old 18083 default.
            xmr_wallet_rpc: std::env::var("XMR_WALLET_RPC")
                .unwrap_or_else(|_| "http://127.0.0.1:38088/json_rpc".to_string()),
        })
    }

    /// A preprod sidecar with chain access. `preprod` (not `dev`) is the point:
    /// the dev preset uses the Ogmios backend and a devnet tip, neither of which
    /// exercises what this rung is for.
    fn provider(&self, tag: &str) -> VendoredDeskCrypto {
        let data = std::env::temp_dir().join(format!("pwnda-2b-{tag}"));
        let _ = std::fs::remove_dir_all(&data);
        self.provider_at(data)
    }

    /// Same, but WITHOUT wiping the engine's state dir. The cross-machine run is
    /// three separate processes, and the leader's pass 3 must reuse the swap its
    /// pass 1 created — wiping here would silently start a second swap and the
    /// pre-signature would then fail to verify for an entirely bogus reason.
    fn persistent_provider(&self, tag: &str) -> VendoredDeskCrypto {
        self.provider_at(std::env::temp_dir().join(format!("pwnda-2b-{tag}")))
    }

    fn provider_at(&self, data: std::path::PathBuf) -> VendoredDeskCrypto {
        let mut cfg = SidecarConfig::new(&self.python, &self.engine_dir, "preprod")
            .expect("preprod is a known preset")
            .with_data_dir(data.display().to_string())
            .with_env("ADA_ENGINE_STATE_KEY", "22".repeat(32))
            .expect("state key")
            // REQUIRED since engine v12 (D5): a sidecar spawned without it now
            // exits 78. This rung needs no Monero at all - the M5 check returns
            // not-confirmed with no chain B regardless - but the variable must
            // be PRESENT and it must be OURS.
            //
            // Pinned to the STAGENET port, never the 18083 default. That default
            // is exactly what D5 was: on the desk host 18083 was a live mainnet
            // wallet, and it passed the loopback guard because 127.0.0.1 is
            // loopback. A default that names a real resource is a guess about
            // whose funds to spend, and there is no safe guess - so this names
            // the port our own stagenet wallet uses and nothing else.
            .with_env("XMR_WALLET_RPC", &self.xmr_wallet_rpc)
            .expect("loopback stagenet wallet rpc")
            .with_env("BLOCKFROST_PROJECT_ID", &self.project_id)
            .expect("project id");
        if let Some(url) = &self.blockfrost_url {
            cfg = cfg.with_env("ADA_BLOCKFROST_URL", url).expect("blockfrost url");
        }
        VendoredDeskCrypto::new(EngineSidecar::new(cfg))
    }
}

fn init_ctx<'a>(
    swap_id: &'a str,
    role: ClientRole,
    t1_slot: Option<i64>,
    t2_slot: Option<i64>,
) -> SwapInitContext<'a> {
    SwapInitContext {
        leader_proof: false,
        swap_id,
        role,
        pair: "XMR/ADA",
        amount_a: "100",
        amount_b: "1",
        t0: 1_000,
        t1: 2_000,
        t2: 3_000,
        t1_slot,
        t2_slot,
        payout_address: "",
        refund_address: "",   // harness: empty = derive (pre-wiring behaviour)
    }
}

fn cp_of<'a>(
    m: &'a super::crypto::SwapKeyMaterial,
    t1: Option<i64>,
    t2: Option<i64>,
) -> CounterpartyKeys<'a> {
    CounterpartyKeys {
        key_share_point: &m.client_key_share_point,
        chain_a_pubkey: &m.client_chain_a_pubkey,
        adaptor_point: m.adaptor_point.as_deref(),
        view_key: m.view_key.as_deref(),
        dleq_proof: None,
        t1_slot: t1,
        t2_slot: t2,
        claim_dest: None,
        refund_dest: None,
    }
}

/// Flip the leading hex nibble, keeping the value well-formed hex of the same
/// length — so what is being tested is the signature check, not the parser.
fn flip_first_hex_nibble(hex: &str) -> String {
    let mut c = hex.chars();
    match c.next() {
        Some(first) => {
            let flipped = if first == '0' { '1' } else { '0' };
            std::iter::once(flipped).chain(c).collect()
        }
        None => hex.to_string(),
    }
}

/// A synthetic but well-formed lock UTxO. This rung never submits anything, so
/// the input does not need to exist on-chain — what must be identical is the
/// (txid, index, amount) BOTH sides build the refund body over.
///
/// **This constant is why 2b cannot run over the desk's HTTP transport.**
/// `set_lock_utxo` is engine-internal — it is on no desk endpoint — and the M4
/// `LockRequest` carries `{chain, lockTxid, amount}` with no index. In
/// production neither side needs it transmitted: each DISCOVERS the UTxO by
/// watching chain A. With no funds there is nothing to watch, so the triple has
/// to be an agreed out-of-band constant, which only the party-exchange shape
/// allows. Both sides must use these exact values.
const LOCK_TXID: &str = "aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900";
const LOCK_INDEX: i64 = 0;
const LOCK_AMOUNT: &str = "100000000"; // lovelace

/// One party's published bytes, relayed to the other side through the repo.
///
/// JSON on purpose: the operator moves it with git rather than transcribing it,
/// so a relay cannot introduce a typo into material the pre-signature binds.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartyPayload {
    /// The role of the party that WROTE this file.
    role: String,
    swap_id: String,
    key_share_point: String,
    chain_a_pubkey: String,
    /// FOLLOWER material.
    adaptor_point: Option<String>,
    view_key: Option<String>,
    /// LEADER material — real absolute slots off the live preprod tip.
    t1_slot: Option<i64>,
    t2_slot: Option<i64>,
    /// M3, present only on the FOLLOWER's second publish.
    refund_presig_r_enc: Option<String>,
    refund_presig_sp: Option<String>,
    /// Echoed so a mismatch is caught here rather than as a bogus crypto
    /// disagreement three steps later.
    lock_txid: String,
    lock_index: i64,
    lock_amount: String,
    /// The Cardano epoch this side built against.
    ///
    /// **This replaces a guard the party-exchange shape drops.** The desk's
    /// epoch pin rides in the HTTP M1, and 2b deliberately does not use the HTTP
    /// transport — so without this field nothing stops the passes landing in
    /// different epochs. Protocol params are a per-EPOCH constant, so that makes
    /// the two sides build different canonical bodies and the pre-signature
    /// "disagrees" when neither side is wrong. The relay is the only place that
    /// can see both epochs, so the check belongs here.
    epoch: Option<i64>,
    /// Advisory, for the operator: when the pinned epoch rolls. Not enforced —
    /// `epoch` equality is the load-bearing check.
    epoch_ends_utc: Option<String>,
}

impl PartyPayload {
    /// `our_epoch` is this side's current epoch (from `PWNDA_2B_EPOCH`), or
    /// `None` when it is unknown — in which case the cross-epoch check cannot
    /// run and says so rather than passing silently.
    fn read(path: &str, our_epoch: Option<i64>) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read counterparty payload {path}: {e}"))?;
        let p: Self = serde_json::from_str(&raw)
            .map_err(|e| format!("counterparty payload {path} is not valid JSON: {e}"))?;
        if p.lock_txid != LOCK_TXID || p.lock_index != LOCK_INDEX || p.lock_amount != LOCK_AMOUNT {
            return Err(format!(
                "LOCK UTXO MISMATCH: the counterparty pinned ({}, {}, {}) but this side pins \
                 ({LOCK_TXID}, {LOCK_INDEX}, {LOCK_AMOUNT}). The refund body is built over this \
                 input, so a mismatch would surface later as a bogus pre-signature disagreement.",
                p.lock_txid, p.lock_index, p.lock_amount
            ));
        }
        let Some(theirs) = p.epoch else {
            return Err(format!(
                "counterparty payload {path} carries no `epoch`. It is required by the relay \
                 contract (rung2b-relay/RELAY-CONTRACT.md): the epoch pin that would normally \
                 ride in the HTTP M1 is absent from the party-exchange shape, so this field is \
                 the only thing that catches the two sides building against different protocol \
                 params."
            ));
        };
        match our_epoch {
            Some(ours) if ours != theirs => {
                return Err(format!(
                    "EPOCH MISMATCH: the counterparty built against epoch {theirs}, this side is \
                     in epoch {ours}. Cardano protocol params are a per-epoch constant, so the \
                     two sides would build different canonical refund bodies and the \
                     pre-signature would appear to disagree with nothing actually wrong. Re-run \
                     from pass 1 inside a single epoch."
                ));
            }
            None => eprintln!(
                "rung2b: WARNING - PWNDA_2B_EPOCH is unset, so the cross-epoch check could not \
                 run. The counterparty built against epoch {theirs}."
            ),
            _ => {}
        }
        Ok(p)
    }

    fn write(&self, path: &str) {
        let json = serde_json::to_string_pretty(self).expect("serialize payload");
        std::fs::write(path, &json).unwrap_or_else(|e| panic!("cannot write {path}: {e}"));
        eprintln!("rung2b: wrote {} payload -> {path}\n{json}", self.role);
    }
}

/// This side's current Cardano epoch, supplied by the runner script
/// (`scripts/rung2b-pass.sh` queries it with the same project id the sidecar
/// uses). Kept out of the harness so the harness needs no chain access of its
/// own beyond the sidecar.
fn our_epoch() -> Option<i64> {
    std::env::var("PWNDA_2B_EPOCH").ok()?.trim().parse().ok()
}

fn payload_of(role: &str, swap_id: &str, m: &super::crypto::SwapKeyMaterial) -> PartyPayload {
    PartyPayload {
        role: role.to_string(),
        swap_id: swap_id.to_string(),
        key_share_point: m.client_key_share_point.clone(),
        chain_a_pubkey: m.client_chain_a_pubkey.clone(),
        adaptor_point: m.adaptor_point.clone(),
        view_key: m.view_key.clone(),
        t1_slot: m.t1_slot,
        t2_slot: m.t2_slot,
        refund_presig_r_enc: None,
        refund_presig_sp: None,
        lock_txid: LOCK_TXID.to_string(),
        lock_index: LOCK_INDEX,
        lock_amount: LOCK_AMOUNT.to_string(),
        epoch: our_epoch(),
        epoch_ends_utc: std::env::var("PWNDA_2B_EPOCH_ENDS_UTC").ok(),
    }
}

fn cp_from_payload(p: &PartyPayload) -> CounterpartyKeys<'_> {
    CounterpartyKeys {
        key_share_point: &p.key_share_point,
        chain_a_pubkey: &p.chain_a_pubkey,
        adaptor_point: p.adaptor_point.as_deref(),
        view_key: p.view_key.as_deref(),
        dleq_proof: None,
        t1_slot: p.t1_slot,
        t2_slot: p.t2_slot,
        claim_dest: None,
        refund_dest: None,
    }
}

/// **The rung.** Leader derives real slots from the live preprod tip, both sides
/// pin the same lock UTxO, the follower pre-signs its refund, and the leader
/// verifies it under output-pinning. Then the M5 gate is checked.
#[tokio::test]
async fn rung2b_m3_presig_agreement_and_m5_gate() {
    let Some(env) = Rung2bEnv::load() else { return };
    let leader = env.provider("leader");
    let follower = env.provider("follower");
    let id = "rung2b_1";

    // 1. The LEADER derives its timelock slots from the LIVE preprod tip. This
    //    is the first thing in the whole integration that needs a real chain.
    let l_material = leader
        .generate_swap_keys(&init_ctx(id, ClientRole::Leader, None, None))
        .await
        .expect("leader init_swap must reach the preprod tip - check the project id");
    let (t1, t2) = (
        l_material.t1_slot.expect("leader derives t1"),
        l_material.t2_slot.expect("leader derives t2"),
    );
    assert!(t2 > t1 && t1 > 0, "derived slots must satisfy t2 > t1 > 0");
    eprintln!("rung2b: leader derived live preprod slots t1={t1} t2={t2}");

    // 2. The FOLLOWER inits against the leader's committed window.
    let f_material = follower
        .generate_swap_keys(&init_ctx(id, ClientRole::Follower, Some(t1), Some(t2)))
        .await
        .expect("follower init_swap");

    // 3. Both form the joint key. Agreement here is the offline half, already
    //    proven - re-asserted so a failure downstream cannot be blamed on it.
    let l_joint = leader
        .ingest_counterparty(id, &cp_of(&f_material, None, None))
        .await
        .expect("leader ingests follower M2");
    let f_joint = follower
        .ingest_counterparty(id, &cp_of(&l_material, Some(t1), Some(t2)))
        .await
        .expect("follower ingests leader M1");
    assert_eq!(l_joint, f_joint, "joint derivation must agree before M3");

    // 4. Pin the SAME realized lock UTxO on both sides. The refund body is built
    //    over this exact input, so a divergence here would look like a crypto
    //    disagreement when it is really a bookkeeping one.
    for (who, p) in [("leader", &leader), ("follower", &follower)] {
        p.set_lock_utxo(id, LOCK_TXID, LOCK_INDEX, LOCK_AMOUNT)
            .await
            .unwrap_or_else(|e| panic!("{who} set_lock_utxo: {e}"));
    }

    // 5. M3. The follower pre-signs its refund; the leader verifies it under
    //    output-pinning (it re-derives the canonical body from its OWN state).
    //    THIS is the cross-machine property: both fee estimates must come from
    //    the same current protocol params.
    let produced = follower
        .exchange_refund_sigs(id, None, None)
        .await
        .expect("follower produces its refund pre-sig (needs read-only chain)");
    let ours = produced
        .ours
        .expect("a FOLLOWER must return `ours` - it is the producing side");
    eprintln!("rung2b: follower produced refund pre-sig rEnc={}...", &ours.r_enc[..16]);

    let verified = leader
        .exchange_refund_sigs(id, Some(&ours), None)
        .await
        .expect("leader verifies the follower's pre-sig");
    assert!(
        verified.verified,
        "M3 DISAGREEMENT: the leader could not verify the follower's refund pre-sig. \
         The usual cause is a protocol-param mismatch between the two sidecars \
         (see PROTOCOL-PARAMS.md) - the two sides built different canonical bodies, \
         so the txids differ. This is fail-closed, not a fund loss."
    );
    eprintln!("rung2b: M3 AGREEMENT - the leader verified the follower's refund pre-sig");

    // NEGATIVE CONTROL. `verified: true` is only evidence if `false` is
    // reachable — an implementation that answered "verified" unconditionally
    // would produce an identical green above, and the whole rung would be
    // measuring nothing. So corrupt one byte of the pre-signature and require
    // the leader to reject it. This is the assertion that gives the positive
    // result its meaning.
    let mut tampered = ours.clone();
    tampered.sp = flip_first_hex_nibble(&tampered.sp);
    assert_ne!(tampered.sp, ours.sp, "the tamper must actually change the value");
    match leader.exchange_refund_sigs(id, Some(&tampered), None).await {
        Err(e) => eprintln!("rung2b: negative control OK - a tampered pre-sig was rejected: {e}"),
        Ok(r) => assert!(
            !r.verified,
            "NEGATIVE CONTROL FAILED: the leader reported `verified` for a pre-signature with a \
             corrupted scalar. Every positive M3 result in this rung is then meaningless, \
             including the cross-machine one."
        ),
    }
    eprintln!("rung2b: negative control OK - verification distinguishes a good pre-sig from a bad one");

    // SECOND NEGATIVE CONTROL - output-pinning, which the desk's
    // `[desk:refund-wire]` selfcheck has carried since round 1 and this harness
    // did not. The pre-signature is re-checked UNMODIFIED against a DIFFERENT
    // lock UTxO and must still fail. That is what stops a valid pre-sig being
    // replayed onto another input: it binds the OUTPUT, not just the key.
    //
    // Distinct from the tamper control above. That one proves the signature
    // check runs; this one proves WHAT it is checking against.
    let other_txid = flip_first_hex_nibble(LOCK_TXID);
    assert_ne!(other_txid, LOCK_TXID);
    leader
        .set_lock_utxo(id, &other_txid, LOCK_INDEX, LOCK_AMOUNT)
        .await
        .expect("re-pin the leader onto a different input");
    match leader.exchange_refund_sigs(id, Some(&ours), None).await {
        Err(e) => eprintln!("rung2b: output-pinning OK - re-pinned input rejected: {e}"),
        Ok(r) => assert!(
            !r.verified,
            "OUTPUT-PINNING FAILED: the same pre-signature verified against a DIFFERENT lock \
             UTxO. A pre-sig that does not bind its input can be replayed onto another one."
        ),
    }
    eprintln!("rung2b: output-pinning OK - the pre-sig binds the input it was made over");

    // 6. M5, the gate. There is no real chain-B lock here, so the leader must
    //    REFUSE even though we assert chainBConfirmed=true. The engine re-runs
    //    its OWN chain-B watch and ANDs it with our claim - fail closed.
    //    A release here would be the H1 setReady-timing theft.
    match leader.release_claim_sig(id, true).await {
        Err(e) => eprintln!("rung2b: M5 gate correctly REFUSED with no chain-B lock: {e}"),
        Ok(_) => panic!(
            "M5 GATE FAILED OPEN: the leader released its claim adaptor pre-signature with no \
             confirmed chain-B lock. This is the H1 setReady-timing theft and must never happen."
        ),
    }

    leader.shutdown().await;
    follower.shutdown().await;
}

// ── The relay mechanism, tested without a chain ────────────────────────────
//
// The exchange format is the part a credential cannot help with and the part
// most likely to hold a bug, so it is pinned here: a payload must survive the
// round trip, and a lock-UTxO mismatch must be caught AT THE RELAY rather than
// three steps later as a bogus pre-signature disagreement.

#[test]
fn payload_round_trips_through_the_relay() {
    let dir = std::env::temp_dir().join("pwnda-2b-relay-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("leader.json");
    let p = PartyPayload {
        role: "LEADER".into(),
        swap_id: "s1".into(),
        key_share_point: "aa".repeat(32),
        chain_a_pubkey: "bb".repeat(32),
        adaptor_point: None,
        view_key: None,
        t1_slot: Some(90_000_123),
        t2_slot: Some(90_003_723),
        refund_presig_r_enc: None,
        refund_presig_sp: None,
        lock_txid: LOCK_TXID.into(),
        lock_index: LOCK_INDEX,
        lock_amount: LOCK_AMOUNT.into(),
        epoch: Some(302),
        epoch_ends_utc: Some("2026-07-25T00:00:00Z".into()),
    };
    p.write(path.to_str().unwrap());
    let back = PartyPayload::read(path.to_str().unwrap(), Some(302)).expect("round trip");
    assert_eq!(back.role, "LEADER");
    assert_eq!(back.t1_slot, Some(90_000_123));
    assert_eq!(back.t2_slot, Some(90_003_723));
    assert!(back.t2_slot > back.t1_slot);
    assert_eq!(back.epoch, Some(302));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_lock_utxo_mismatch_is_caught_at_the_relay_not_three_steps_later() {
    let dir = std::env::temp_dir().join("pwnda-2b-relay-mismatch");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bad.json");
    // A counterparty pinning a DIFFERENT input. Left undetected this surfaces
    // much later as "the pre-signature does not verify", which reads as a crypto
    // or param failure and sends you looking in the wrong place entirely.
    let raw = serde_json::json!({
        "role": "FOLLOWER", "swapId": "s1",
        "keySharePoint": "aa", "chainAPubkey": "bb",
        "adaptorPoint": null, "viewKey": null, "t1Slot": null, "t2Slot": null,
        "refundPresigREnc": null, "refundPresigSp": null,
        "lockTxid": "ff".repeat(32), "lockIndex": 7, "lockAmount": "999",
        "epoch": 302, "epochEndsUtc": null,
    });
    std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();

    let err = PartyPayload::read(path.to_str().unwrap(), Some(302)).expect_err("must reject");
    assert!(err.contains("LOCK UTXO MISMATCH"), "got: {err}");
    assert!(
        err.contains("bogus pre-signature disagreement"),
        "the error must say WHERE this would otherwise surface: {err}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The party-exchange shape drops the desk's HTTP-M1 epoch pin, so the relay is
/// the only place a cross-epoch run can still be caught. Same failure signature
/// as a lock-UTxO mismatch — an apparently-broken pre-signature with nothing
/// actually wrong — so it gets the same treatment: rejected here, named plainly.
#[test]
fn a_cross_epoch_run_is_caught_at_the_relay_rather_than_as_a_phantom_presig_failure() {
    let dir = std::env::temp_dir().join("pwnda-2b-relay-epoch");
    std::fs::create_dir_all(&dir).unwrap();

    let payload = |epoch: serde_json::Value| {
        serde_json::json!({
            "role": "LEADER", "swapId": "s1",
            "keySharePoint": "aa", "chainAPubkey": "bb",
            "adaptorPoint": null, "viewKey": null,
            "t1Slot": 128_996_564_i64, "t2Slot": 128_998_364_i64,
            "refundPresigREnc": null, "refundPresigSp": null,
            "lockTxid": LOCK_TXID, "lockIndex": LOCK_INDEX, "lockAmount": LOCK_AMOUNT,
            "epoch": epoch, "epochEndsUtc": "2026-07-25T00:00:00Z",
        })
    };
    let write = |name: &str, v: serde_json::Value| {
        let p = dir.join(name);
        std::fs::write(&p, serde_json::to_string(&v).unwrap()).unwrap();
        p.to_str().unwrap().to_string()
    };

    // The counterparty built one epoch earlier: params may have changed under
    // us, so the canonical bodies differ and the pre-sig would "disagree".
    let err = PartyPayload::read(&write("stale.json", payload(302.into())), Some(303))
        .expect_err("a cross-epoch payload must be rejected");
    assert!(err.contains("EPOCH MISMATCH"), "got: {err}");
    assert!(
        err.contains("per-epoch") && err.contains("pre-signature"),
        "the error must explain WHY an epoch difference breaks agreement: {err}"
    );

    // A payload with no epoch at all is refused too — silently accepting one
    // would reinstate exactly the gap this field exists to close.
    let err = PartyPayload::read(
        &write("noepoch.json", payload(serde_json::Value::Null)),
        Some(302),
    )
    .expect_err("a payload with no epoch must be rejected");
    assert!(err.contains("no `epoch`"), "got: {err}");
    assert!(err.contains("RELAY-CONTRACT.md"), "point at the contract: {err}");

    // Same epoch: accepted.
    PartyPayload::read(&write("good.json", payload(302.into())), Some(302)).expect("same epoch");

    let _ = std::fs::remove_dir_all(&dir);
}

/// **The cross-machine rung.** Runs ONE party on this side and exchanges the
/// M1/M2/M3 bytes with the desk through relayed JSON.
///
/// This is the shape 2b has to take, and the reason is structural rather than a
/// preference: `set_lock_utxo` is engine-internal (no desk endpoint), and M4's
/// `LockRequest` has no UTxO index, so with no funds there is no way to convey
/// the shared lock input over the desk's HTTP transport. In production nothing
/// needs conveying — each side watches chain A and discovers it. The full
/// HTTP/sigauth path is therefore the right shape for the FUNDED end-to-end run,
/// not for this one.
///
/// Three passes, two relays:
///
/// | Pass | Side | Does |
/// |---|---|---|
/// | 1 | LEADER | `init_swap` against the live tip -> publishes its real slots |
/// | 2 | FOLLOWER | inits against those slots, ingests, pins the UTxO, pre-signs its refund -> publishes `{rEnc, sp}` |
/// | 3 | LEADER | ingests, pins the same UTxO, VERIFIES the pre-sig, then asserts the M5 gate refuses |
///
/// Driven by env:
/// - `PWNDA_2B_ROLE` — `LEADER` or `FOLLOWER` (which party THIS side runs)
/// - `PWNDA_2B_OUT` — where to write our payload
/// - `PWNDA_2B_IN` — the counterparty payload (absent on the leader's pass 1)
///
/// The engine's encrypted store persists across passes, so the leader's pass 3
/// reuses the swap it created in pass 1 — which is why the data dir must NOT be
/// wiped between them.
#[tokio::test]
async fn rung2b_cross_machine_party() {
    let Some(env) = Rung2bEnv::load() else { return };
    let Ok(role_s) = std::env::var("PWNDA_2B_ROLE") else {
        eprintln!("rung2b: SKIPPED - PWNDA_2B_ROLE not set (this is the cross-machine driver)");
        return;
    };
    let out = std::env::var("PWNDA_2B_OUT").expect("PWNDA_2B_OUT must be set with PWNDA_2B_ROLE");
    let incoming = std::env::var("PWNDA_2B_IN").ok();
    let id = std::env::var("PWNDA_2B_SWAP_ID").unwrap_or_else(|_| "rung2b_xm".to_string());

    let role = match role_s.to_ascii_uppercase().as_str() {
        "LEADER" => ClientRole::Leader,
        "FOLLOWER" => ClientRole::Follower,
        other => panic!("PWNDA_2B_ROLE must be LEADER or FOLLOWER, got {other:?}"),
    };
    // Persist across passes: pass 3 reuses pass 1's swap.
    let party = env.persistent_provider(&format!("xm-{}", role_s.to_ascii_lowercase()));

    match (role, incoming.as_deref()) {
        // ── Pass 1: the LEADER derives real slots and publishes them. ──
        (ClientRole::Leader, None) => {
            // Fail here rather than publish a payload the counterparty is
            // contractually required to reject.
            assert!(
                our_epoch().is_some(),
                "PWNDA_2B_EPOCH must be set before publishing: the relay's cross-epoch check is \
                 the party-exchange substitute for the HTTP M1 epoch pin, and a payload without \
                 it will be rejected by the other side. Use scripts/rung2b-pass.sh."
            );
            let m = party
                .generate_swap_keys(&init_ctx(&id, ClientRole::Leader, None, None))
                .await
                .expect("leader init_swap must reach the live preprod tip");
            let (t1, t2) = (m.t1_slot.expect("t1"), m.t2_slot.expect("t2"));
            assert!(t2 > t1 && t1 > 0);
            eprintln!("rung2b: LEADER pass 1 - derived live slots t1={t1} t2={t2}");
            payload_of("LEADER", &id, &m).write(&out);
            eprintln!("rung2b: relay this to the desk, then re-run with PWNDA_2B_IN set");
        }

        // ── Pass 2: the FOLLOWER answers and pre-signs its refund. ──
        (ClientRole::Follower, Some(inp)) => {
            let lead = PartyPayload::read(inp, our_epoch()).expect("leader payload");
            assert_eq!(lead.role, "LEADER", "pass 2 needs the LEADER's payload");
            let (t1, t2) = (
                lead.t1_slot.expect("the leader must publish its slots"),
                lead.t2_slot.expect("the leader must publish its slots"),
            );

            let mine = party
                .generate_swap_keys(&init_ctx(&id, ClientRole::Follower, Some(t1), Some(t2)))
                .await
                .expect("follower init_swap");
            party
                .ingest_counterparty(&id, &cp_from_payload(&lead))
                .await
                .expect("follower ingests the leader's M1");
            party
                .set_lock_utxo(&id, LOCK_TXID, LOCK_INDEX, LOCK_AMOUNT)
                .await
                .expect("pin the shared lock UTxO");

            // M3. Needs read-only chain: the fee estimate fixes the txid.
            let produced = party
                .exchange_refund_sigs(&id, None, None)
                .await
                .expect("follower produces its refund pre-sig");
            let ours = produced.ours.expect("a FOLLOWER returns `ours`");
            eprintln!("rung2b: FOLLOWER pass 2 - refund pre-sig rEnc={}...", &ours.r_enc[..16]);

            let mut p = payload_of("FOLLOWER", &id, &mine);
            p.refund_presig_r_enc = Some(ours.r_enc);
            p.refund_presig_sp = Some(ours.sp);
            p.write(&out);
        }

        // ── Pass 3: the LEADER verifies, then the M5 gate must refuse. ──
        (ClientRole::Leader, Some(inp)) => {
            let foll = PartyPayload::read(inp, our_epoch()).expect("follower payload");
            assert_eq!(foll.role, "FOLLOWER", "pass 3 needs the FOLLOWER's payload");

            // Pass 3 is ONE-SHOT per swap, because the engine refuses to ingest
            // counterparty material twice (a replay/key-substitution guard —
            // correct, and worth having seen fire). Re-running it therefore
            // cannot verify anything. Say exactly that instead of surfacing the
            // raw rejection, which reads like an M3 failure and sends you
            // hunting a disagreement that never happened. It still FAILS rather
            // than skipping: a pass that quietly returns green without verifying
            // is worse than a confusing red.
            if let Err(e) = party.ingest_counterparty(&id, &cp_from_payload(&foll)).await {
                let already = e.to_string().contains("already ingested");
                assert!(
                    !already,
                    "PASS 3 HAS ALREADY RUN for swap id `{id}`. The engine refuses a second \
                     ingest of counterparty material (a replay guard), so this re-run can \
                     verify nothing and is NOT evidence about M3 either way. If you need to \
                     run it again, start a fresh swap id from pass 1. Original: {e}"
                );
                panic!("leader ingests the follower's M2: {e}");
            }
            party
                .set_lock_utxo(&id, LOCK_TXID, LOCK_INDEX, LOCK_AMOUNT)
                .await
                .expect("pin the same shared lock UTxO");

            let presig = super::wire::AdaptorPresig {
                r_enc: foll.refund_presig_r_enc.expect("follower must publish rEnc"),
                sp: foll.refund_presig_sp.expect("follower must publish sp"),
            };
            let res = party
                .exchange_refund_sigs(&id, Some(&presig), None)
                .await
                .expect("leader verifies the follower's pre-sig");
            assert!(
                res.verified,
                "M3 CROSS-MACHINE DISAGREEMENT: this side could not verify the counterparty's \
                 refund pre-signature. The two sides built different canonical bodies. Check, in \
                 order: (1) both on ADA_ENGINE_ENV=preprod, (2) no epoch boundary crossed between \
                 the passes - the epoch pin should have caught that, (3) the SAME lock UTxO on \
                 both sides. This is fail-closed: nothing is stranded."
            );
            eprintln!("rung2b: PASS 3 - CROSS-MACHINE M3 AGREEMENT. Two independently fetched \
                       preprod param views produced the same canonical refund body.");

            // M5: no real chain-B lock exists, so the gate MUST refuse even
            // though we assert confirmation. Releasing here is the H1 theft.
            match party.release_claim_sig(&id, true).await {
                Err(e) => eprintln!("rung2b: M5 gate correctly REFUSED (no chain-B lock): {e}"),
                Ok(_) => panic!(
                    "M5 GATE FAILED OPEN: released the claim adaptor pre-signature with no \
                     confirmed chain-B lock. That is the H1 setReady-timing theft."
                ),
            }
        }

        (ClientRole::Follower, None) => {
            panic!("the FOLLOWER cannot go first - it needs the LEADER's committed slots. Run the \
                    leader's pass 1, relay its payload, then set PWNDA_2B_IN.")
        }
    }
    party.shutdown().await;
}

/// The BUY direction's M2: the leader's slots are what the desk needs to reach
/// our chain-A address. Captured separately because the desk wants these exact
/// wire bytes from the 2b run to replace the client's synthesized fixture.
#[tokio::test]
async fn rung2b_capture_real_buy_m2_slots() {
    let Some(env) = Rung2bEnv::load() else { return };
    let leader = env.provider("buy-capture");
    let id = "rung2b_buy_capture";

    let m = leader
        .generate_swap_keys(&init_ctx(id, ClientRole::Leader, None, None))
        .await
        .expect("leader init_swap against the live tip");
    let req = m.keys_request();

    // Emitted for the desk to diff against its own capture, and so the wire.rs
    // fixture can stop being a shape mock.
    eprintln!(
        "rung2b: REAL BUY M2 slots from the live preprod tip -> t1Slot={:?} t2Slot={:?}",
        req.t1_slot, req.t2_slot
    );
    eprintln!(
        "rung2b: full M2 keys body = {}",
        serde_json::to_string(&req).expect("serialize M2")
    );
    assert!(req.t1_slot.is_some() && req.t2_slot.is_some());
    leader.shutdown().await;
}
