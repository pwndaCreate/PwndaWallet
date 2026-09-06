//! Tauri command surface for the swap desk — the bridge the TS layer calls.
//!
//! ## What is deliberately NOT here
//!
//! The desk handshake (M2 keys, M3 refund-sigs, M4 lock, M5 ready-ack) is NOT
//! exposed. Those steps move value and must be gated on the client's own chain
//! observation inside [`super::engine`] / [`super::watch`] — routing them
//! through the webview would put the gating decision on the wrong side of the
//! trust boundary. The webview drives INTENT (quote, accept, abort) and
//! observes PROGRESS (status); the Rust core runs the protocol.
//!
//! **No command returns key material.** [`DeskSwapSummary`] is a deliberately
//! narrowed projection of [`super::store::StoredSwap`]: the secret scalar
//! share, the pre-signatures, and the shared view key are all omitted. That
//! omission is the load-bearing part of this file — if you add a field here,
//! check it against sub-plan 04 D first.

#![allow(dead_code)] // registered in lib.rs::invoke_handler behind `full`

use serde::Serialize;
use tauri::{Manager, State};

use super::{client, store, watch, wire};
use crate::swap::state::SwapState;

/// Open the encrypted swap store against the wallet's data dir.
fn open_store(state: &SwapState) -> Result<store::DeskStore, String> {
    let dir = state
        .data_dir()
        .ok_or_else(|| "wallet data dir not resolved yet".to_string())?;
    store::DeskStore::open(&dir).map_err(|e| e.to_string())
}

/// UI-safe projection of a persisted swap. See the module note: secrets
/// (`engine_ref`, the refund/claim pre-signatures, `view_key`) are
/// intentionally absent and must stay absent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskSwapSummary {
    pub swap_id: String,
    pub pair: String,
    pub direction: String,
    /// The DESK's role; the client is always the opposite.
    pub desk_role: String,
    pub amount_a: String,
    pub amount_b: String,
    pub state: String,
    /// Where the counterparty locks (chain A) — shown in the tracker.
    pub script_address: String,
    pub chain_b_joint_addr: Option<String>,
    pub lock_a_txid: Option<String>,
    pub lock_b_txid: Option<String>,
    pub t0: i64,
    /// The refund deadline the tracker counts down to.
    pub t1: i64,
    pub t2: i64,
    pub created_at: i64,
}

impl From<&store::StoredSwap> for DeskSwapSummary {
    fn from(s: &store::StoredSwap) -> Self {
        Self {
            swap_id: s.swap_id.clone(),
            pair: s.pair.clone(),
            direction: s.direction.clone(),
            desk_role: s.desk_role.clone(),
            amount_a: s.amount_a.clone(),
            amount_b: s.amount_b.clone(),
            state: s.state.clone(),
            script_address: s.script_address.clone(),
            chain_b_joint_addr: s.chain_b_joint_addr.clone(),
            lock_a_txid: s.lock_a_txid.clone(),
            lock_b_txid: s.lock_b_txid.clone(),
            t0: s.t0,
            t1: s.t1,
            t2: s.t2,
            created_at: s.created_at,
        }
    }
}

/// UI-safe projection of a desk `/status` poll. Carries the 8.1 state, the
/// per-leg txids the tracker renders, and the countdowns — but NOT
/// `releasedClaimSig`, which is protocol material for the engine. Same rule as
/// [`DeskSwapSummary`]: the webview sees progress, not crypto.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskStatusView {
    pub swap_id: String,
    pub state: String,
    pub lock_a_txid: String,
    pub lock_b_txid: String,
    pub claim_a_txid: String,
    pub sweep_b_txid: String,
    pub refund_txid: String,
    pub reclaim_txid: String,
    pub confs_a: i64,
    pub confs_b: i64,
    pub min_confs_a: i64,
    pub min_confs_b: i64,
    pub t0_remaining: i64,
    pub t1_remaining: i64,
    pub ready_ack: bool,
    pub updated_at: i64,
    pub error: String,
}

impl From<&wire::StatusResponse> for DeskStatusView {
    fn from(s: &wire::StatusResponse) -> Self {
        Self {
            swap_id: s.swap_id.clone(),
            state: s.state.clone(),
            lock_a_txid: s.lock_a_txid.clone(),
            lock_b_txid: s.lock_b_txid.clone(),
            claim_a_txid: s.claim_a_txid.clone(),
            sweep_b_txid: s.sweep_b_txid.clone(),
            refund_txid: s.refund_txid.clone(),
            reclaim_txid: s.reclaim_txid.clone(),
            confs_a: s.confs_a,
            confs_b: s.confs_b,
            min_confs_a: s.min_confs_a,
            min_confs_b: s.min_confs_b,
            t0_remaining: s.t0_remaining,
            t1_remaining: s.t1_remaining,
            ready_ack: s.ready_ack,
            updated_at: s.updated_at,
            error: s.error.clone(),
        }
    }
}

/// `GET /api/desk/pairs` — the tradable-pair roster + per-pair size limits and
/// halt state. Public (unsigned); safe to call before enrollment.
#[tauri::command]
pub async fn desk_pairs(state: State<'_, SwapState>) -> Result<wire::PairsResponse, String> {
    client::pairs(&state).await.map_err(|e| e.to_string())
}

/// Price a desk swap. `pair` is always FOLLOWER/LEADER (e.g. "XMR/ADA") and
/// `direction` is SELL_FOLLOWER | BUY_FOLLOWER — the TS side derives both from
/// the capability registry (`deskPairLabel` / `deskDirectionFor`) so the two
/// layers can't disagree about which side is which.
///
/// Quotes carry a 30-120s TTL. Do not settle on a stale rate: re-quote before
/// [`desk_accept`] if the confirm modal has been open long enough to expire it.
#[tauri::command]
pub async fn desk_quote(
    state: State<'_, SwapState>,
    pair: String,
    direction: String,
    amount_in: String,
) -> Result<wire::QuoteResponse, String> {
    client::quote(
        &state,
        &wire::QuoteRequest {
            pair,
            direction,
            amount_in,
        },
    )
    .await
    .map_err(|e| e.to_string())
}

/// Reserve inventory and create the swap (M1), then PERSIST it before doing
/// anything else. `payout_address` / `refund_address` are the user's own
/// public addresses, resolved TS-side from the wallet.
///
/// `clientChainAPubkey` is deliberately NOT a parameter: per-swap key material
/// is derived inside the Rust core at accept-time (sub-plan 04 B.2), never
/// supplied by the webview. It stays `None` until the engine's per-swap keygen
/// lands, which is also why this command does not yet start the handshake.
///
/// If persistence fails the swap is reported as an error even though the desk
/// accepted it — an unpersisted post-accept swap is one we could not recover
/// after a crash. It is still pre-lock at this point (no funds have moved), so
/// the safe response is to abort it or let the reservation lapse.
#[tauri::command]
pub async fn desk_accept(
    state: State<'_, SwapState>,
    quote_id: String,
    pair: String,
    direction: String,
    payout_address: String,
    refund_address: String,
) -> Result<DeskSwapSummary, String> {
    let record =
        accept_and_persist(&state, quote_id, pair, direction, payout_address, refund_address)
            .await?;
    Ok(DeskSwapSummary::from(&record))
}

/// The accept + M2 + ingest handshake, factored out of [`desk_accept`] so BOTH
/// the command AND the rung-3 CLI entry point (`super::conductor`) drive an
/// IDENTICAL handshake with no duplicated protocol. Returns the persisted
/// [`store::StoredSwap`]; the command narrows it to a [`DeskSwapSummary`] and the
/// conductor loads it by id.
///
/// Moves NO funds: it reserves inventory, mints our per-swap key material,
/// exchanges M2, and forms the 2-of-2 joint key. M3 (the refund pre-signature)
/// and every lock belong to the conductor, behind the explicit `desk_proceed`
/// step — accept is never a silent consequence that moves value.
pub(crate) async fn accept_and_persist(
    state: &SwapState,
    quote_id: String,
    pair: String,
    direction: String,
    payout_address: String,
    refund_address: String,
) -> Result<store::StoredSwap, String> {
    // The role comes from the direction, which the client knows at quote time
    // (`deskDirectionFor`) without waiting for the desk's `deskRole`.
    let role = super::engine::ClientRole::from_direction(&direction)
        .map_err(|e| e.to_string())?;

    // ── Accept FIRST, with NO client key material ────────────────────────
    // `clientChainAPubkey` is `,omitempty` on the wire and the desk never reads
    // it: `Coordinator.Accept()` mints only the DESK's own material and returns
    // M1; the client's chain-A pubkey is consumed solely at `SubmitKeys`/M2,
    // which requires `State==ACCEPTED`. That matches REU26 8.1, where M2
    // `SwapAccept` is what carries the client's key material (confirmed by the
    // desk in `DESK-ANSWER-v6.md`).
    //
    // This ordering is not cosmetic: the real engine CANNOT mint our keys before
    // accept, because `init_swap` needs the swapId + `t0/t1/t2` + the timelock
    // slots + amounts, and every one of those arrives in the accept RESPONSE.
    // Generating pre-accept only ever worked because the placeholder provider is
    // deterministic from the quoteId.
    // The leg is derived from the pair rather than assumed: today every routable
    // pair is */ADA, but hardcoding that is how a rule outlives the reason for
    // it. Derived BEFORE the accept because it now decides what we ask for.
    let leg = if pair.to_ascii_uppercase().ends_with("/LTC") {
        super::sidecar::Leg::Ltc
    } else {
        super::sidecar::Leg::Ada
    };

    // CLIENT-1 / C31-2: ask for the leader-proof capability on the leg that
    // needs it, and only there.
    //
    // LTC<>XMR is the only scripted cross-curve leg, so it is the only one where
    // the encryption point has to be TRANSPORTED rather than derived. Asking on
    // ADA would be meaningless (same curve, `dleqProof` is null by
    // construction), and asking everywhere would be the mirror of the desk's own
    // near-miss: gating on "cross-curve" is wrong on EVM<>XMR, which is
    // cross-curve and needs nothing because `refund(secret)` reveals the scalar
    // in calldata. The property is not the curve, it is whether the abort
    // reveals the scalar by itself.
    let want_leader_proof = matches!(leg, super::sidecar::Leg::Ltc);

    let m1 = client::accept(
        state,
        &wire::AcceptRequest {
            quote_id,
            payout_address: payout_address.clone(),
            refund_address: refund_address.clone(),
            client_chain_a_pubkey: None,
            // Absent when we are not asking, so an ADA accept stays byte-identical
            // to every accept that has settled to date.
            leader_proof: want_leader_proof.then_some(true),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // ── Parse-tolerant, semantically STRICT (DESK-ANSWER-v101 s1) ────────
    //
    // `#[serde(default)]` on the response is what lets us DECODE an older desk's
    // M1; it is not a licence to proceed. If we asked for the capability and the
    // desk answered no, this swap cannot complete: our own engine refuses to
    // lock chain B when the refund-spend is plain
    // (`ltc_swap.py:544`, and that guard found itself on a real swap that locked
    // 1.44 stagenet XMR unrecoverably).
    //
    // So the swap dies either way, and the only question is WHEN. Refusing here
    // costs a handshake. Discovering it at lock time costs a timelock window
    // with chain A already locked. This is the same reasoning the engine guard
    // states for its own placement — check where the condition is first
    // knowable — applied one message earlier, because at M1 it already is.
    //
    // BasicSwap does the same one layer up: `protocol_version` rides the bid and
    // the responder `ensure()`s on it (basicswap.py:5991/:6211) rather than
    // silently downgrading.
    // THE SCOPE IS ROLE, NOT LEG, AND NOT "DID WE ASK" (DESK-ANSWER-v102 s2).
    //
    // The guard that kills the swap is `refund_spend_is_otves`, and it stops the
    // FOLLOWER's chain-B lock — the follower is the party left holding a
    // signature that reveals nothing. `ClientRole::client_lock_chain` says the
    // same thing in our own code: Follower locks B, Leader locks A. So the line
    // is "am I the party that locks chain B", and both alternatives we proposed
    // were wrong at one end:
    //
    //   * "only if we asked"  UNDER-refuses: a swap we did not opt into is still
    //     a swap we cannot finish, and it dies at the lock instead of the
    //     handshake.
    //   * "any LTC swap"      OVER-refuses: when WE lead, our chain-A lock is
    //     fine and it is the DESK that cannot recover. Refusing there would be
    //     refusing on a counterparty's behalf for a risk that is theirs to take,
    //     and the desk already declines those at accept for its own reasons.
    //
    // Each side refuses early for its OWN chain-B lock; neither refuses for the
    // other's. We still ASK on the leg regardless of role, because when we lead
    // it is our proof the desk needs and the desk's answer is what decides.
    if super::engine::must_refuse_at_m1(leg, role, m1.leader_proof) {
        return Err(format!(
            "swap {}: refusing at M1. This is an LTC-leg swap in which WE follow, so we are the \
             party that locks chain B — and the leader-proof capability is off, so our \
             refund-spend half would be a PLAIN signature that reveals no scalar. Our engine \
             refuses to lock chain B on exactly that record (ltc_swap.py:544, a guard that found \
             itself on a swap which locked 1.44 stagenet XMR unrecoverably), so this swap cannot \
             settle. Refusing here costs a handshake; discovering it at the chain-B lock costs a \
             timelock window with chain A already locked. The desk must open the swap with \
             leaderProof:true on this pair before it can be driven.",
            m1.swap_id,
        ));
    }

    // ── CC-18: check M1's ROLE-SHAPE before we mint anything against it ──
    //
    // The desk's contribution flips by role, and until CC-18 that contract was
    // documented on `wire` and enforced only inside the engines. Enforcing it
    // here too costs nothing on the ADA leg (both production shapes pass
    // unchanged) and stops a malformed M1 reaching `generate_swap_keys`, where
    // the same fault would surface as a crypto error rather than a wire one.
    //
    // `leg` is derived above, before the accept, because it decides what we ask
    // for. The capability is now the DESK's answer rather than a hardcoded
    // false: this is the one value that widens the shape CC-18 enforces, and it
    // comes from M1 so that what we validate against is what was handshook.
    let desk_party = match m1.desk_role.as_str() {
        "LEADER" => super::engine::Party::Leader,
        _ => super::engine::Party::Follower,
    };
    super::engine::valid_role_shape(
        leg,
        desk_party,
        m1.leader_proof,
        m1.adaptor_point.as_deref(),
        m1.dleq_proof.as_deref(),
        m1.view_key.as_deref(),
    )
    .map_err(|e| {
        format!(
            "the desk's M1 for swap {} has the wrong shape for its role: {e}",
            m1.swap_id
        )
    })?;

    // ── init_swap: mint OUR half, now that the swap exists ───────────────
    // Keyed on the desk-assigned swapId and fed the accept response's terms.
    // The slots we pass are the DESK's, and they are populated only when the
    // desk LEADS; when we lead they are null by design (v8) and the engine
    // derives our own from the chain tip. We read the authoritative slots back
    // out of the result below, never off M1.
    let provider = super::crypto::active_crypto();
    let material = provider
        .generate_swap_keys(&super::crypto::SwapInitContext {
            swap_id: &m1.swap_id,
            role,
            pair: &pair,
            amount_a: &m1.amount_a,
            amount_b: &m1.amount_b,
            t0: m1.t0,
            t1: m1.t1,
            t2: m1.t2,
            t1_slot: m1.t1_slot,
            t2_slot: m1.t2_slot,
            // The DESK's answer, never `want_leader_proof`. Opening the engine
            // with what we ASKED for rather than what was AGREED is D20's shape
            // and it would strand a coin: the engine would sign an OtVES the
            // desk never expects, or a plain spend the desk's validator refuses.
            leader_proof: m1.leader_proof,
            // The same address sent to the desk in the accept. Both engines must
            // apply it or both must derive; a split makes the claim bodies differ.
            payout_address: &payout_address,
            // Same contract, the refund body instead of the claim (desk D25).
            refund_address: &refund_address,
        })
        .await
        .map_err(|e| e.to_string())?;

    if !super::crypto::crypto_is_production_ready() {
        // Loud, once per accept. A build running the placeholder provider must
        // never be mistakable for one that is not.
        eprintln!(
            "[desk] WARNING: accepting swap with PLACEHOLDER key material \
             (provenance={}). The protocol and persistence are real; the key \
             material is not. This swap cannot be claimed or refunded on a \
             real chain.",
            provider.provenance().as_str()
        );
    }

    let mut record = store::StoredSwap::from_accept(
        &m1,
        &payout_address,
        &refund_address,
        watch::unix_now() as i64,
    );

    // Persist the handle + our public half. The SECRET is not here and never
    // was: it lives in the sidecar's own encrypted store, addressed by
    // `engine_ref`. Losing THIS record still costs us the ability to drive the
    // swap, which is why it is written before anything else proceeds.
    record.client_key_share_point = Some(material.client_key_share_point.clone());
    record.engine_ref = Some(material.engine_ref.clone());
    record.key_provenance = material.provenance.as_str().to_string();

    // The adaptor point + view key are the FOLLOWER's contribution. When the
    // client leads, `from_accept` has already copied the DESK's values out of
    // M1 and overwriting them with our own would corrupt the record.
    if role == super::engine::ClientRole::Follower {
        record.adaptor_point = material.adaptor_point.clone();
        record.view_key = material.view_key.clone();
    } else {
        // We LEAD: our own engine committed the chain-A refund window, so the
        // record must carry OUR slots, not M1's nulls. These are what we send in
        // M2 and what the desk needs to derive our lock address.
        record.t1_slot = material.t1_slot;
        record.t2_slot = material.t2_slot;
    }

    // ── CC-2: persist the ENGINE's T2, separately from the advertisement ──
    // `record.t2` stays exactly what M1 said — display-only from here on. The
    // deep abort, the swipe watcher and the C46 hold all read the engine
    // fields, sourced from the layer that ACTS on the chain-A leg. On the
    // 07-30 rung the advertisement was T1+600 while both engines committed
    // T1+1800 (D48); a swipe scheduled off the advertisement carries
    // `invalid_before` 1200s in the future and the node rejects it.
    let cfg_delta = if role == super::engine::ClientRole::Follower
        && (m1.t1_slot.is_none() || m1.t2_slot.is_none())
    {
        // Follower fallback only: M1 carried no slots, so ask the desk's
        // resolved config. A fetch failure is could-not-look — logged, never
        // defaulted.
        match client::effective_config(state).await {
            Ok(c) => c.ada.and_then(|a| a.swipe_delta_slots),
            Err(e) => {
                eprintln!(
                    "[desk] swap {}: effective-config could not be read ({e}) while deriving \
                     the engine T2 — could-not-look, not a default",
                    m1.swap_id
                );
                None
            }
        }
    } else {
        None
    };
    match derive_engine_t2(
        role,
        m1.t1,
        m1.t1_slot,
        m1.t2_slot,
        material.t1_slot,
        material.t2_slot,
        cfg_delta,
    ) {
        Ok(e) => {
            record.t2_engine_slot = e.slot;
            record.t2_engine_unix = e.unix;
            if let Some(eu) = e.unix {
                if eu != m1.t2 {
                    // CC-2e: when the two copies disagree, say so loudly, name
                    // the authority, and carry the delta.
                    eprintln!(
                        "[desk] swap {}: T2 DISAGREEMENT — the desk ADVERTISED t2={} but the \
                         engine committed T2={} ({}; delta {}s). The engine's value arms the \
                         deep abort and bounds the hold; the advertised value is display-only. \
                         On the 07-30 rung this delta was 1200s (D48).",
                        m1.swap_id,
                        m1.t2,
                        eu,
                        e.source,
                        eu - m1.t2
                    );
                }
            }
        }
        Err(why) => {
            eprintln!(
                "[desk] swap {}: engine T2 NOT persisted — {why}. The deep abort will REFUSE \
                 to arm for this swap rather than fall back to the advertised t2 (CC-2).",
                m1.swap_id
            );
        }
    }
    open_store(state)?.save(&record).map_err(|e| {
        format!(
            "swap {} was accepted by the desk but could NOT be persisted ({e}) — \
             abort it rather than proceeding: an unpersisted swap cannot be \
             recovered after a restart",
            m1.swap_id
        )
    })?;

    // ── M2: send our half to the desk ────────────────────────────────────
    // Deliberately AFTER the store write. If the process dies between the two,
    // we hold a persisted swap we can re-drive; the reverse order would leave
    // the desk holding key material for a swap we have no record of.
    let m2 = client::keys(state, &m1.swap_id, &material.keys_request())
        .await
        .map_err(|e| e.to_string())?;
    if !m2.accepted {
        return Err(format!(
            "the desk rejected our M2 key material for swap {} — refusing to \
             proceed to a lock",
            m1.swap_id
        ));
    }

    // ── Ingest the desk's half locally, forming the joint key ────────────
    // Our OWN engine's view of the 2-of-2. The desk's slots go in only when the
    // DESK leads (it is then the slot authority); when we lead they are null.
    let joint = provider
        .ingest_counterparty(
            &m1.swap_id,
            &super::crypto::CounterpartyKeys {
                key_share_point: &m1.desk_key_share_point,
                chain_a_pubkey: &m1.desk_chain_a_pubkey,
                adaptor_point: m1.adaptor_point.as_deref(),
                view_key: m1.view_key.as_deref(),
                dleq_proof: m1.dleq_proof.as_deref(),
                t1_slot: if role == super::engine::ClientRole::Follower { m1.t1_slot } else { None },
                t2_slot: if role == super::engine::ClientRole::Follower { m1.t2_slot } else { None },
                // CC-24 / F32-0: the desk's nomination for ITS OWN chain-A
                // proceeds. Passed straight through - it is their money, so a
                // wrong value moves their coins and never ours, and our own
                // nomination stays protected by `AgreedButNotOurs`.
                //
                // Empty is NOT a destination: it means the desk did not
                // nominate, and the engine derives as it always has. That is
                // both the compatibility path for a desk that has not shipped
                // this and the fallback the FALSIFY requires.
                claim_dest: opt_nonempty(&m1.claim_dest),
                refund_dest: opt_nonempty(&m1.refund_dest),
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // Cross-check our own derivation against the desk's. A mismatch means the
    // two sides would watch/lock different addresses, which is the
    // funds-stranding class — refuse rather than proceed.
    if !m2.chain_a_lock_addr.is_empty() && m2.chain_a_lock_addr != joint.chain_a_lock_addr {
        return Err(format!(
            "chain-A lock address disagreement on swap {}: the desk says {} but our own engine \
             derived {} — refusing to proceed",
            m1.swap_id, m2.chain_a_lock_addr, joint.chain_a_lock_addr
        ));
    }
    record.chain_a_lock_addr = Some(joint.chain_a_lock_addr);
    record.chain_b_joint_key = Some(joint.chain_b_joint_key);
    record.chain_b_joint_addr = Some(joint.chain_b_joint_addr);
    open_store(state)?.save(&record).map_err(|e| e.to_string())?;

    // Hand back the persisted record. The command narrows it to a
    // DeskSwapSummary (deskKeySharePoint / adaptorPoint / viewKey / dleqProof are
    // engine protocol material with no business in the webview); the conductor
    // loads it by id to drive the funded choreography.
    Ok(record)
}


/// CC-24: an empty wire string is ABSENT, not a value.
///
/// The nomination fields are `omitempty` on the desk's side, so a desk that
/// does not nominate omits them and serde gives us `""`. Treating that as a
/// destination would hand the engine an empty address to build a body to; the
/// engine must be told "derive" instead, which is what `None` means to it.
fn opt_nonempty(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// CC-2: the engine-committed T2 for a swap, by provenance.
#[derive(Debug)]
pub(crate) struct EngineT2 {
    /// Absolute chain-A slot, when an engine published one. The chain fact.
    pub slot: Option<i64>,
    /// Unix-seconds projection for local scheduling, anchored on the same
    /// wall-clock T1 the refund watcher runs on: `t1 + (T2 slot − T1 slot)`
    /// (1 slot = 1 s on preprod/mainnet).
    pub unix: Option<i64>,
    /// Which layer answered — named so a disagreement log can cite it.
    pub source: &'static str,
}

/// Derive the T2 from the layer that ACTS on the chain-A leg (v75 §3).
///
/// - We LEAD: our own engine's slots. The desk's copy is an echo of what we
///   send in M2; reading the desk's config here would be "luck dressed as
///   agreement" — right only while the tree hashes happen to match.
/// - We FOLLOW: the desk's engine commits its slots, delivered in M1
///   (`t1Slot`/`t2Slot`); its `effective-config` delta is the fallback when M1
///   carried none.
/// - Neither readable: `Err` naming what failed. The caller logs it and leaves
///   the engine fields unset — could-not-look, never the advertisement.
///
/// The advertised `t2` is DELIBERATELY not a parameter: the signature itself
/// is what guarantees the advertisement cannot leak into the derivation.
pub(crate) fn derive_engine_t2(
    role: super::engine::ClientRole,
    m1_t1_unix: i64,
    m1_t1_slot: Option<i64>,
    m1_t2_slot: Option<i64>,
    material_t1_slot: Option<i64>,
    material_t2_slot: Option<i64>,
    cfg_swipe_delta_slots: Option<i64>,
) -> Result<EngineT2, String> {
    if role == super::engine::ClientRole::Follower {
        if let (Some(a), Some(b)) = (m1_t1_slot, m1_t2_slot) {
            return Ok(EngineT2 {
                slot: Some(b),
                unix: Some(m1_t1_unix + (b - a)),
                source: "AcceptResponse t1Slot/t2Slot (the desk leads and commits the chain-A \
                         slots)",
            });
        }
        if let Some(d) = cfg_swipe_delta_slots {
            return Ok(EngineT2 {
                // No absolute slot was published, only the delta — the unix
                // projection is derivable, the chain fact is not.
                slot: None,
                unix: Some(m1_t1_unix + d),
                source: "effective-config ada.swipeDeltaSlots (M1 carried no slots)",
            });
        }
        return Err(format!(
            "we follow, M1 carried no usable slots (t1Slot={m1_t1_slot:?}, \
             t2Slot={m1_t2_slot:?}) and the desk's effective-config could not supply \
             ada.swipeDeltaSlots"
        ));
    }
    // We lead: only our own engine speaks for the leg we script.
    match (material_t1_slot, material_t2_slot) {
        (Some(a), Some(b)) => Ok(EngineT2 {
            slot: Some(b),
            unix: Some(m1_t1_unix + (b - a)),
            source: "our own engine's derived slots (we lead; the desk echoes us)",
        }),
        _ => Err(format!(
            "we lead but our engine reported no slots (t1Slot={material_t1_slot:?}, \
             t2Slot={material_t2_slot:?}) — init_swap validation should have refused this"
        )),
    }
}


/// CC-25: the sizing window for one pair+direction, and the verdict on an
/// amount, as ONE serializable answer for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskSizeView {
    /// `"within" | "belowMin" | "aboveMax" | "cannotJudge"`.
    pub verdict: String,
    /// The user-facing sentence. On a refusal this is the DESK's own wording
    /// where it gave one, never a re-phrasing.
    pub message: String,
    pub min: String,
    pub max: String,
    /// The denomination. Empty means the desk published none, which is
    /// could-not-look and is why `verdict` will be `cannotJudge`.
    pub coin: String,
    pub min_basis: String,
    /// Every sizing input the desk could not look up. Non-empty means the floor
    /// was never COMPUTED - painted as a caveat, never dropped.
    pub unknown: Vec<String>,
    /// Which surface answered: the per-direction entry or the flat fallback.
    pub source: String,
}

/// CC-25: judge an amount against the desk's published window.
///
/// **This exists so the rule has ONE implementation.** `engine::sizing_for` +
/// `engine::judge_size` already encode it, the preflight reads the same
/// published fields, and a third copy in TypeScript would be the
/// two-places-holding-one-quantity fault this project keeps paying for
/// (D5/D7/D48). The webview asks; it does not re-derive.
///
/// Fetching `/pairs` here rather than taking a `PairInfo` from the webview is
/// deliberate for the same reason: the value judged is the value the desk
/// published, not one that made a round trip through the UI and could have been
/// edited on the way.
#[tauri::command]
pub async fn desk_size_check(
    state: State<'_, SwapState>,
    pair: String,
    direction: String,
    amount: String,
    amount_coin: String,
) -> Result<DeskSizeView, String> {
    let roster = client::pairs(&state).await.map_err(|e| e.to_string())?;
    let info = roster
        .pairs
        .iter()
        .find(|p| p.pair.eq_ignore_ascii_case(&pair))
        .ok_or_else(|| {
            // CC-8: absent from the PUBLIC roster is not "does not exist" - an
            // unlisted pair answers the same way a nonexistent one does.
            format!(
                "{pair} is not in the desk's public roster. That is three states this endpoint                  cannot separate: no such pair, unlisted and not ours, or unlisted and ours."
            )
        })?;

    let w = super::engine::sizing_for(info, &direction);
    let v = super::engine::judge_size(&w, &amount, &amount_coin);
    let (verdict, message) = match &v {
        super::engine::SizeVerdict::Within => ("within", String::new()),
        super::engine::SizeVerdict::BelowMin { min, coin, basis, reason } => (
            "belowMin",
            if reason.trim().is_empty() {
                format!("Below the desk's minimum of {min} {coin} ({basis}).")
            } else {
                // The desk's own sentence, verbatim: it names the four chain
                // bodies and their costs, which we cannot reconstruct.
                format!("Below the desk's minimum of {min} {coin}. {reason}")
            },
        ),
        super::engine::SizeVerdict::AboveMax { max, coin } => (
            "aboveMax",
            format!("Above the desk's maximum of {max} {coin} for this direction."),
        ),
        super::engine::SizeVerdict::CannotJudge { why } => ("cannotJudge", why.clone()),
    };
    Ok(DeskSizeView {
        verdict: verdict.to_string(),
        message,
        min: w.min,
        max: w.max,
        coin: w.coin,
        min_basis: w.min_basis,
        unknown: w.unknown,
        source: w.source.to_string(),
    })
}

/// Poll the desk's view of a swap (the 8.1 state + per-leg txids) for the
/// tracker. ADVICE only — the engine never acts on this without its own chain
/// observation. Best-effort: the last-known state is mirrored into the durable
/// record so a restart starts from something recent.
#[tauri::command]
pub async fn desk_status(
    state: State<'_, SwapState>,
    watchers: State<'_, super::rehydrate::DeskWatchers>,
    swap_id: String,
) -> Result<DeskStatusView, String> {
    let status = client::status(&state, &swap_id)
        .await
        .map_err(|e| e.to_string())?;

    let parsed = super::engine::DeskSwapState::parse(&status.state);

    // A terminal state is the ONLY cooperative signal a refund watcher gets.
    // Without this raise, a watcher (especially one rehydrated at startup)
    // sits until T1 and then fires a refund on a swap that already paid out.
    if parsed.is_terminal() {
        watchers.raise(&swap_id);
    }

    if let Ok(store) = open_store(&state) {
        if parsed.is_settled()
            || matches!(parsed, super::engine::DeskSwapState::ARefunded)
        {
            // Drop the record. It holds the secret scalar share and the
            // pre-signatures, and desk_list_active already filters terminal
            // swaps out — so leaving it on disk makes the leftover INVISIBLE
            // rather than absent. (ABORTED is handled by desk_abort. FAILED is
            // deliberately kept: it may still need manual recovery from the
            // persisted pre-signatures.)
            let _ = store.remove(&swap_id);
        } else if let Ok(mut rec) = store.load(&swap_id) {
            rec.state = status.state.clone();
            if !status.lock_a_txid.is_empty() {
                rec.lock_a_txid = Some(status.lock_a_txid.clone());
            }
            if !status.lock_b_txid.is_empty() {
                rec.lock_b_txid = Some(status.lock_b_txid.clone());
            }
            let _ = store.save(&rec); // best-effort mirror; never fail the poll
        }
    }

    Ok(DeskStatusView::from(&status))
}

/// Cancel a PRE-LOCK swap and release the desk's inventory reservation. The
/// desk rejects this with 409 once the swap has locked — post-lock recovery is
/// timeout-driven (the refund watcher at T1), not a cancel button. The durable
/// record is dropped only on a confirmed abort.
#[tauri::command]
pub async fn desk_abort(
    state: State<'_, SwapState>,
    swap_id: String,
    reason: Option<String>,
) -> Result<wire::AbortResponse, String> {
    let resp = client::abort(&state, &swap_id, &wire::AbortRequest { reason })
        .await
        .map_err(|e| e.to_string())?;

    if resp.state == "ABORTED" {
        if let Ok(store) = open_store(&state) {
            let _ = store.remove(&swap_id);
        }
    }

    Ok(resp)
}

/// Rehydrate the in-flight swaps from the encrypted store — what the tracker
/// calls on mount so a swap that was mid-flight when the app closed reappears
/// (and, once the engine is wired, has its refund watcher re-spawned).
/// Terminal swaps are filtered out; only recoverable ones are returned.
#[tauri::command]
pub async fn desk_list_active(state: State<'_, SwapState>) -> Result<Vec<DeskSwapSummary>, String> {
    let all = open_store(&state)?.load_all().map_err(|e| e.to_string())?;
    Ok(all
        .iter()
        .filter(|s| !super::engine::DeskSwapState::parse(&s.state).is_terminal())
        .map(DeskSwapSummary::from)
        .collect())
}

/// Read-only: is the real engine installed, and for what preset?
///
/// The UI uses this to present the desk as "live" only when the engine can
/// actually move funds — so `VITE_DESK_LIVE=true` on a Mock build shows as NOT
/// live rather than accepting a swap that could never complete. Carries no
/// secrets: just a bool and the (public) preset name.
#[tauri::command]
pub fn desk_arm_status() -> super::arm::ArmStatus {
    super::arm::arm_status()
}

/// Kick off the funded choreography for an already-accepted swap. **This is the
/// value-moving step, deliberately behind an explicit user action** — not a
/// silent consequence of `desk_accept`. The UI calls this only after the confirm
/// modal; the actual locks/claim run in the spawned conductor.
///
/// Fails closed on two axes before spawning anything:
/// 1. the engine must be armed (real, not Mock) — the UI must not be able to
///    start a funded drive on placeholder crypto;
/// 2. the swap must exist and be non-terminal.
///
/// Returns immediately after spawning the conductor: the drive runs for the life
/// of the swap (minutes to hours), so the command must NOT await it. Progress is
/// observed through [`desk_status`]; recovery is the watchers' job.
#[tauri::command]
pub async fn desk_proceed(
    app: tauri::AppHandle,
    state: State<'_, SwapState>,
    swap_id: String,
) -> Result<String, String> {
    // (1) Fail closed if the engine is not armed. `run_swap_choreography` checks
    // this too, but refusing HERE gives the webview an immediate, honest error
    // rather than a swap that spawns and then dies.
    if !super::crypto::crypto_is_production_ready() {
        return Err(
            "the desk engine is not armed (crypto is Mock) — refusing to start a funded swap. \
             Arm the desk (PWNDA_DESK_ARM + testnet config) first."
                .to_string(),
        );
    }

    // (2) The swap must exist and be non-terminal. Scoped so no store handle or
    // record (which is ZeroizeOnDrop) is held across the spawn.
    let current_state = {
        let store = open_store(&state)?;
        store.load(&swap_id).map_err(|e| e.to_string())?.state.clone()
    };
    if super::engine::DeskSwapState::parse(&current_state).is_terminal() {
        return Err(format!(
            "swap {swap_id} is already in terminal state {current_state}; nothing to drive"
        ));
    }

    // Spawn the conductor detached. It resolves SwapState + DeskWatchers off the
    // app handle inside the task (the command's `State` borrow cannot cross the
    // spawn), and drives to a claim or a clean stop, logging its verdict.
    let app_handle = app.clone();
    let id = swap_id.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(state), Some(watchers)) = (
            app_handle.try_state::<SwapState>(),
            app_handle.try_state::<super::rehydrate::DeskWatchers>(),
        ) else {
            eprintln!(
                "[desk::conductor] swap {id}: SwapState/DeskWatchers not managed; cannot drive"
            );
            return;
        };
        match super::conductor::run_swap_choreography(&state, &watchers, &id).await {
            Ok(outcome) => {
                eprintln!("[desk::conductor] swap {id}: finished — {outcome:?}")
            }
            Err(e) => eprintln!("[desk::conductor] swap {id}: stopped — {e}"),
        }
    });

    Ok("started".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trust-boundary lock: the UI projection must never carry key
    /// material. Serializing a record whose secret fields are populated must
    /// produce a payload with none of them — if someone adds `secretKeyShare`
    /// (or a pre-signature, or the view key) to `DeskSwapSummary`, this fails.
    #[test]
    fn summary_never_serializes_key_material() {
        let mut rec: store::StoredSwap = store::StoredSwap::from_accept(
            &serde_json::from_str(
                r#"{"swapId":"aa01","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.1","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#,
            )
            .unwrap(),
            "payout",
            "refund",
            42,
        );
        // Populate every secret the record can hold.
        rec.engine_ref = Some("ENGINE_REF_HANDLE".into());
        rec.view_key = Some("SECRET_VIEW_KEY".into());
        rec.refund_presig_r_enc = Some("SECRET_REFUND_R".into());
        rec.refund_presig_sp = Some("SECRET_REFUND_S".into());
        rec.claim_presig_r_enc = Some("SECRET_CLAIM_R".into());
        rec.claim_presig_sp = Some("SECRET_CLAIM_S".into());

        let json = serde_json::to_string(&DeskSwapSummary::from(&rec)).unwrap();
        for leaked in [
            "SECRET_SCALAR_SHARE",
            "SECRET_VIEW_KEY",
            "SECRET_REFUND_R",
            "SECRET_REFUND_S",
            "SECRET_CLAIM_R",
            "SECRET_CLAIM_S",
        ] {
            assert!(
                !json.contains(leaked),
                "DeskSwapSummary leaked key material ({leaked}) to the webview: {json}"
            );
        }
        // And the fields the tracker legitimately needs ARE present.
        assert!(json.contains("\"swapId\":\"aa01\""));
        assert!(json.contains("\"t1\":2"));
    }

    // ── CC-2: derive_engine_t2 — provenance by role, advertisement excluded ──
    //
    // Note what these tests CANNOT express: feeding the advertised `t2` into
    // the derivation. It is not a parameter, which is the structural half of
    // the guarantee; the tests below pin the behavioural half.

    use crate::desk::engine::ClientRole;

    /// We lead: only our own engine's slots count. The 07-30 shape — engine
    /// delta 1800 against an advertised 600 — resolves to T1+1800.
    #[test]
    fn leading_the_engine_t2_comes_from_our_own_slots() {
        let e = derive_engine_t2(
            ClientRole::Leader,
            5_000,             // advertised T1 unix (the shared anchor)
            None,              // M1 slots are null when we lead (v8)
            None,
            Some(100_000),     // our engine's T1 slot
            Some(101_800),     // our engine's T2 slot — delta 1800
            None,
        )
        .unwrap();
        assert_eq!(e.slot, Some(101_800));
        assert_eq!(e.unix, Some(6_800), "T1 anchor + engine delta, not the advertisement");
        assert!(e.source.contains("our own engine"));
    }

    /// We follow: the desk's engine commits its slots and they arrive in M1.
    #[test]
    fn following_the_engine_t2_comes_from_m1_slots() {
        let e = derive_engine_t2(
            ClientRole::Follower,
            7_000,
            Some(200_000),
            Some(201_800),
            None,
            None,
            Some(600), // a lying fallback must NOT be consulted when M1 spoke
        )
        .unwrap();
        assert_eq!(e.slot, Some(201_800));
        assert_eq!(e.unix, Some(8_800));
        assert!(e.source.contains("AcceptResponse"));
    }

    /// We follow and M1 carried no slots: effective-config's delta is the
    /// fallback. No absolute slot exists in that case and none is invented.
    #[test]
    fn following_without_m1_slots_falls_back_to_effective_config() {
        let e = derive_engine_t2(ClientRole::Follower, 7_000, None, None, None, None, Some(1_800))
            .unwrap();
        assert_eq!(e.slot, None, "no absolute slot was published; do not invent one");
        assert_eq!(e.unix, Some(8_800));
        assert!(e.source.contains("effective-config"));
    }

    /// Neither source readable: could-not-look, named. The caller leaves the
    /// engine fields unset and the deep abort refuses to arm — never the
    /// advertised t2.
    #[test]
    fn following_with_neither_source_is_could_not_look() {
        let err = derive_engine_t2(ClientRole::Follower, 7_000, None, None, None, None, None)
            .unwrap_err();
        assert!(err.contains("M1 carried no usable slots"), "names the wire: {err}");
        assert!(err.contains("effective-config"), "names the fallback too: {err}");
    }

    /// A leader whose engine reported no slots is an init bug, not a case to
    /// paper over with the desk's numbers.
    #[test]
    fn leading_without_engine_slots_is_an_error_not_a_fallback() {
        let err = derive_engine_t2(
            ClientRole::Leader,
            5_000,
            Some(1),    // even with M1 slots present…
            Some(2),
            None,       // …a slotless own-engine is refused, not substituted
            None,
            Some(1_800),
        )
        .unwrap_err();
        assert!(err.contains("we lead"), "{err}");
    }
}
