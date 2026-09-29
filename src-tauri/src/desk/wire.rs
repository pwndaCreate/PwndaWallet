//! serde mirror of the desk's wire DTOs — the Rust twin of the reference
//! client's `wire.go`, which is itself the independent mirror of the desk
//! server's `internal/api/dto.go`.
//!
//! ## The serde-strip rule (why this file exists)
//!
//! Request bodies are deserialized into these structs and then re-serialized
//! onto the wire. **A field the desk sends that a mirror struct lacks is
//! silently dropped on decode** — the 2026-05-06 `dry` bug, which stripped a
//! required boolean between the JS log line and the proxy POST and produced an
//! opaque upstream error. The wallet already carries one regression lock for
//! that class ([`crate::swap::proxy`]'s `IntentsQuoteRequest` round-trip test);
//! this module extends the same discipline to every desk message: a full mirror
//! plus a round-trip test per message (see the `tests` module, which replays the
//! exact proven wire bytes captured in
//! `pwnda-desk-handoff/reference-client/traces/wire-trace.md`).
//!
//! ## `,omitempty` vs present-with-null (get this right — it is load-bearing)
//!
//! The contract's SERDE-STRIP RULE: protocol/handshake fields do NOT use
//! `,omitempty` — a zero/empty value must still serialize so the mirror always
//! sees the key. Only fields the server marks optional (a pointer that is null
//! on the ADA leg, or an explicit `,omitempty`) may be absent. That maps to two
//! distinct Rust shapes:
//!
//! - **present-with-null** (Go `*T` WITHOUT `,omitempty`, e.g. `adaptorPoint`,
//!   `viewKey`, `dleqProof`, `t1Slot`, `releasedClaimSig`) -> `Option<T>` with
//!   NO `skip_serializing_if`. It serializes as `null` when `None`. This is the
//!   role-flip carrier: `adaptorPoint`/`viewKey` are null in M1 (accept) when
//!   the desk leads and populated in M2 (keys); populated in M1 and null in M2
//!   when the client leads. If you wrongly add `skip_serializing_if` here the
//!   key vanishes and the desk misreads the role — the #1 porting mistake. Two
//!   tests below (`*_serializes_adaptor_as_null_not_omitted`) lock it.
//! - **omitempty** (Go `,omitempty`, e.g. `claimCosig`, `claimPresig`,
//!   `claimAdaptorSig`, `clientChainAPubkey`, request `amount`) -> `Option<T>`
//!   WITH `skip_serializing_if = "Option::is_none"`. Omitted entirely when
//!   `None`, matching Go's `,omitempty`.
//!
//! All field names are `camelCase` on the wire; `#[serde(rename_all =
//! "camelCase")]` reproduces every desk tag without per-field renames
//! (`chain_a_lock_addr` -> `chainALockAddr`, `s_total` -> `sTotal`, `r_enc` ->
//! `rEnc`, `t1_slot` -> `t1Slot`, and so on).
//!
//! Integer fields use `i64` uniformly (JSON numbers; the desk's Go types are a
//! mix of `int` and `int64`). Markups are `f64`.

#![allow(dead_code)] // consumed by desk/client.rs (added in the next unit)

use serde::{Deserialize, Serialize};

/// Skip helper for Go `bool ,omitempty` (skip when `false`).
fn is_false(b: &bool) -> bool {
    !*b
}

// --- enroll (bootstrap, unsigned) ---
//
// The wallet already enrolls through [`crate::swap::proxy::enroll`]; these
// shapes are mirrored for completeness and to keep the round-trip discipline
// uniform across the whole surface.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollRequest {
    pub pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub enrolled: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub already: bool,
}

// --- pairs (public GET /api/desk/pairs) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairsResponse {
    #[serde(default)]
    pub pairs: Vec<PairInfo>,
    pub server_time: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub pair: String,
    pub follower: String,
    pub leader: String,
    #[serde(default)]
    pub directions: Vec<String>,
    /// direction -> "LEADER" | "FOLLOWER". `BTreeMap` for deterministic
    /// serialization; the desk sends a small fixed-key map.
    #[serde(default)]
    pub desk_role: std::collections::BTreeMap<String, String>,
    /// The FLAT window. Kept as the fallback: a client that reads only these is
    /// never wrong, only less informed. But see [`sizing`](Self::sizing) — one
    /// follower-denominated window cannot honestly describe both directions,
    /// because the desk pays the leader coin on a SELL and the follower coin on
    /// a BUY.
    pub min_size: String,
    pub max_size: String,
    /// CC-6: which coin the window above is denominated in.
    ///
    /// This field exists because DOCUMENTING the denomination failed. The desk's
    /// config said "the follower coin" and its DTO said "whole units of
    /// coin_in"; both are true on a SELL and silently different on a BUY, and
    /// the desk's own size gate believed the wrong one (their D23). It is
    /// published so the party that has to honour the window can check which
    /// denomination it is in rather than infer it.
    ///
    /// Empty from a desk that predates it — which is could-not-look, not XMR.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub size_coin: String,
    /// CC-6: the per-DIRECTION sizing surface, keyed by direction
    /// (`SELL_FOLLOWER` / `BUY_FOLLOWER`). Empty from an older desk.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub sizing: std::collections::BTreeMap<String, SizingEntry>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub indicative_mid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub indicative_mid_unit: String,
    /// Why the pair is halted, when it is. Empty when it is not, and empty from
    /// a desk that does not publish it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub halt_reason: String,
    pub indicative_spread: f64,
    pub quote_ttl_seconds: i64,
    pub t0_seconds: i64,
    pub t1_seconds: i64,
    pub t2_seconds: i64,
    pub min_confs_follower: i64,
    pub min_confs_leader: i64,
    pub enabled: bool,
    pub halted: bool,
}

/// CC-6: one direction's sizing window, with its provenance.
///
/// `min_basis` / `max_basis` say WHICH control bound: `fee-erosion`,
/// `recovery`, `protocol`, `configured`, `liquidity`, `unbounded`. The derived
/// ones send an operator to three different places, so the basis is worth as
/// much as the number.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizingEntry {
    #[serde(default)]
    pub min_size: String,
    #[serde(default)]
    pub max_size: String,
    #[serde(default)]
    pub min_basis: String,
    #[serde(default)]
    pub max_basis: String,
    /// The desk's own sentence explaining the floor. Surfaced verbatim rather
    /// than re-worded — it names the four chain bodies and their costs, which
    /// is not something a client can reconstruct.
    #[serde(default)]
    pub min_reason: String,
    /// **Every input that could not be looked up.** Non-empty means a floor was
    /// never COMPUTED, which is a different thing from a floor that did not
    /// bind — and treating the two alike turns an unmeasured window into one
    /// that looks measured. Painted, never dropped.
    #[serde(default)]
    pub unknown: Vec<String>,
}

// --- quote ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    pub pair: String,
    pub direction: String,
    pub amount_in: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub quote_id: String,
    pub pair: String,
    pub direction: String,
    pub desk_role: String,
    pub coin_in: String,
    pub coin_out: String,
    pub amount_in: String,
    pub amount_out: String,
    pub rate: String,
    pub mid: String,
    pub markup: f64,
    pub s_total: f64,
    pub expires_at: i64,
    pub min_confs_in: i64,
    pub min_confs_out: i64,
    pub t0_seconds: i64,
    pub t1_seconds: i64,
    pub t2_seconds: i64,
}

// --- shared pre-signature wire type (never a spend scalar) ---

/// `rEnc` = R_enc 32B hex; `sp` = pre-signature scalar s' 32B little-endian
/// hex. This is a PRE-signature, never a spend scalar (sub-plan 04 D).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptorPresig {
    pub r_enc: String,
    pub sp: String,
}

// --- accept (M1) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptRequest {
    pub quote_id: String,
    pub payout_address: String,
    pub refund_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_chain_a_pubkey: Option<String>,
    /// CLIENT-1 / C31-2: a REQUEST for the leader-proof capability, never a
    /// declaration. Absent means false, so a swap that does not ask is
    /// byte-identical on the wire to every swap that has settled to date.
    ///
    /// The desk's answer in [`AcceptResponse::leader_proof`] is authoritative and
    /// is the ONLY value either side opens the engine with — asking for it here
    /// and then acting on this field rather than the answer would be D20's shape
    /// (one rule evaluated twice).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader_proof: Option<bool>,
}

/// M1 SwapProposal (desk -> client). `adaptor_point`/`view_key` are populated
/// ONLY when the desk is the follower (BUY_FOLLOWER) **on the ADA leg**; see
/// [`super::engine::valid_role_shape`] for the leg-aware rule, which is now
/// ENFORCED rather than only documented here (CC-18). On the LTC leg with the
/// CLIENT-1 leader-proof capability negotiated, a LEADER also carries
/// `adaptor_point` + `dleq_proof` — but never a `view_key`, on any leg, with the
/// capability on or off. `dleq_proof` is null on
/// the ADA leg (same curve). All three are present-with-null (no skip).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptResponse {
    pub swap_id: String,
    pub pair: String,
    pub direction: String,
    pub desk_role: String,
    pub coin_in: String,
    pub coin_out: String,
    pub amount_a: String,
    pub amount_b: String,
    pub t0: i64,
    pub t1: i64,
    pub t2: i64,
    pub t1_slot: Option<i64>,
    pub t2_slot: Option<i64>,
    pub desk_key_share_point: String,
    pub desk_chain_a_pubkey: String,
    pub adaptor_point: Option<String>,
    pub view_key: Option<String>,
    pub dleq_proof: Option<String>,
    /// The DESK's authoritative answer on the leader-proof capability
    /// (CLIENT-1 / C31-2 / D170). `requested AND the leg can carry it`.
    ///
    /// **`#[serde(default)]` is load-bearing and was our v100 amendment.** The
    /// desk always serializes this field; we still tolerate its absence, and the
    /// two halves prevent different failures:
    ///
    /// * always-send without absent-tolerance makes the capability's own arrival
    ///   a flag day — every swap against a not-yet-deployed desk fails to PARSE
    ///   M1 instead of negotiating `false`;
    /// * absent-tolerance without always-send loses the distinction between "the
    ///   desk declined" and "this desk predates the field".
    ///
    /// Absent therefore reads as `false`, which is the only answer that is safe
    /// under both readings: no proof is sent, and [`super::engine::valid_role_shape`]
    /// keeps refusing one that arrives unasked.
    #[serde(default)]
    pub leader_proof: bool,
    #[serde(default)]
    pub commitments: Vec<String>,
    pub script_address: String,
    pub expires_at: i64,
    /// CC-24 / F32-0: the destinations the DESK nominates for its OWN chain-A
    /// proceeds, and where each value came from (`"nominated"` | `"derived"`).
    ///
    /// # Why these are on M1 and not read off `/status`
    ///
    /// The desk used to DERIVE its own claim and refund destinations per swap,
    /// which fragmented its float and needed a sweep script to undo. The fix is
    /// symmetry: each side nominates where its own coins go and the other
    /// honours it. Ours has always been honoured (`payout_address` /
    /// `refund_address`); this is theirs.
    ///
    /// **They ride M1 specifically so that `/status.claimDest` stays an
    /// INDEPENDENT channel.** Sourcing both sides of
    /// [`super::conductor::claim_dest_check`] from `/status` would make it
    /// compare a value to itself: `Agrees` for every input, including a hostile
    /// one, with every existing test still green because they all assert
    /// `Agrees` on the happy path. Two channels keep the check able to answer a
    /// real question - *did the value you published match the value you
    /// nominated?*
    ///
    /// Additive and `omitempty`: a desk that does not nominate sends nothing,
    /// both sides fall back to deriving, and the round-trip stays byte-exact.
    /// Empty is therefore "derive", never a destination.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub claim_dest: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub claim_dest_source: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub refund_dest: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub refund_dest_source: String,
}

// --- keys (M2) ---

/// M2 SwapAccept (client -> desk). Carries BOTH role-flipped field groups, and
/// they flip in OPPOSITE directions — which is the whole point of pinning them:
///
/// - `adaptor_point`/`view_key` are **FOLLOWER** material: present when the
///   CLIENT follows (SELL_FOLLOWER, the dominant flow), null when it leads.
///   **Leg-aware since CC-18:** on the LTC leg with the leader-proof capability
///   negotiated, a leading CLIENT also sends `adaptor_point` + `dleq_proof` here
///   (CLIENT-1 shape (a) — the leader's material rides M2 when the client
///   leads, mirroring `t1_slot`/`t2_slot`). The `view_key` never flips: it is
///   the follower's on every leg. [`super::engine::valid_role_shape`] is the
///   enforced rule; this comment is its description, and the two going out of
///   step is the C49 shape.
/// - `t1_slot`/`t2_slot` are **LEADER** material: present when the CLIENT
///   **leads** (BUY_FOLLOWER), null when it follows.
///
/// The slots are the chain-A two-timelock refund window, and the LEADER commits
/// them because only the scripted-coin holder can hold an on-chain refund — that
/// is structural in REU26 8.1, not a convention (engine v7,
/// `DESK-ANSWER-v7.md`). So they ride M1 when the desk leads and M2 when we do,
/// the exact mirror of how the adaptor/view fields already flip. The desk (as
/// follower) feeds them to `ingest_counterparty` -> `set_lock_slots` so it
/// derives the SAME chain-A script address it must watch our lock at.
///
/// All of these are **present-with-null**: no `skip_serializing_if`, so they
/// serialize as `null` rather than vanishing. A vanished slot field would leave
/// the desk unable to compute our lock address; a vanished adaptor field makes
/// it misread the role. `dleq_proof` is null on the ADA same-curve leg either
/// way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysRequest {
    pub client_key_share_point: String,
    pub client_chain_a_pubkey: String,
    pub adaptor_point: Option<String>,
    pub view_key: Option<String>,
    pub dleq_proof: Option<String>,
    /// Chain-A refund timelock slot. Present only when the CLIENT leads.
    pub t1_slot: Option<i64>,
    /// Chain-A swipe timelock slot. Present only when the CLIENT leads.
    pub t2_slot: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysResponse {
    pub swap_id: String,
    pub state: String,
    pub chain_a_lock_addr: String,
    pub chain_b_joint_key: String,
    pub chain_b_joint_addr: String,
    pub accepted: bool,
}

// --- refund-sigs (M3) ---


/// CC-23 (desk v77): the LTC leg's M3 signature pair.
///
/// # Why this is not `refundPresig`
///
/// On XMR/LTC the chain-A recovery is TWO transactions, not one - a refund
/// PARENT (lock output -> refund script, BIP68 sequence t1 on the input) and a
/// refund SPEND (refund output -> the leader, the cooperative branch). Each
/// takes a **plain 2-of-2 ECDSA signature**, not an adaptor pre-signature.
///
/// Carrying them in `refundPresig.rEnc`/`.sp` would put an ECDSA signature in
/// fields named for an adaptor's nonce point and pre-signature scalar. A name
/// that describes a neighbouring concern is worse than an opaque one, because
/// it stops the reader looking - the desk's words, and the same reasoning that
/// named `Party` rather than reusing `ClientRole` in CC-18.
///
/// **Omitted entirely on XMR/ADA**, whose M3 is one adaptor pre-signature and
/// is unchanged by any of this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegSigs {
    /// Signs the lock output into the refund script.
    pub refund_parent_sig: String,
    /// Signs the refund output back to the leader, cooperative branch.
    pub refund_spend_sig: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundSigsRequest {
    pub refund_presig: AdaptorPresig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_cosig: Option<AdaptorPresig>,
    /// CC-23: the LTC leg's pair. `None` on ADA, and the field then never
    /// appears - so every ADA request stays byte-identical to one that has
    /// settled. The desk FAILS CLOSED if it is absent on an LTC swap: it will
    /// not fund a lock whose refund cannot be completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leg_sigs: Option<LegSigs>,
    /// **BUY only.** Our PREPARED-but-unsubmitted chain-A lock output.
    ///
    /// The mirror of `/status.lockUtxo`, which is how the desk tells us about its
    /// lock when it leads. When *we* lead, the desk needs this exact input before
    /// it can build a refund pre-signature that binds it — so the value has to
    /// arrive no later than M3, and M3 is the request where it is needed.
    ///
    /// `skip_serializing_if` keeps SELL byte-identical on the wire: a follower
    /// sends no lock UTxO and the field never appears.
    ///
    /// **Fail-closed if the desk ignores it.** Without our UTxO the desk cannot
    /// construct a refund pre-signature over it at all, so we get either an error
    /// or a signature that does not adaptor-verify — and we refuse before the
    /// chain-A lock is submitted. An unsupported field costs a failed handshake,
    /// never a stranded coin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_utxo: Option<LockUtxo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundSigsResponse {
    pub swap_id: String,
    pub state: String,
    pub refund_presig: AdaptorPresig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_presig: Option<AdaptorPresig>,
    /// CC-23: the desk's half of the pair, on an LTC swap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leg_sigs: Option<LegSigs>,
    pub verified: bool,
}

// --- status (poll) ---

/// The desk's PREPARED (built-but-not-yet-submitted) chain-A lock output, exposed
/// on `/status.lockUtxo` once the desk has prepared its ADA lock — which it does
/// automatically after our M2 (keys) lands. The client records it via
/// `set_lock_utxo` so its M3 refund pre-signature binds the EXACT input the refund
/// body is built over. This is the delivery field for the seam-1 fix
/// (prepare-and-share, desk commit `b3fcfc2` / `DESK-DELIVERY-FIELD.md`): the desk
/// submits the built lock on-chain only AFTER our M3 verifies, so nothing moves
/// until M3 does. `amount` is lovelace as a JSON number (not a decimal string).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockUtxo {
    pub txid: String,
    pub index: i64,
    pub amount: i64,
}

/// GET /api/desk/swap/{id}/status. The txid fields are plain (non-omitempty)
/// strings — they serialize as `""` until their leg happens, so the mirror
/// always sees the key. `released_claim_sig` and `lock_utxo` are present-with-null.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub swap_id: String,
    pub pair: String,
    pub direction: String,
    pub desk_role: String,
    pub state: String,
    pub coin_in: String,
    pub coin_out: String,
    pub amount_in: String,
    pub amount_out: String,
    pub lock_a_txid: String,
    pub lock_b_txid: String,
    pub claim_a_txid: String,
    pub sweep_b_txid: String,
    pub refund_txid: String,
    /// CC-5 (desk D49). Set ONLY for a branch-B3 swipe, and **additive**: the
    /// desk deliberately did NOT empty `refund_txid` for a swipe, because we
    /// parse it and emptying it would be a silent behaviour change on a shared
    /// surface.
    ///
    /// It is a CROSS-CHECK, never the verdict. Reading the chain is the source
    /// of truth: this field is the desk's opinion, and if the two disagree that
    /// is a desk fault worth a loud error, not a tie to break by preference.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub swipe_txid: String,
    pub reclaim_txid: String,
    pub confs_a: i64,
    pub confs_b: i64,
    pub min_confs_a: i64,
    pub min_confs_b: i64,
    pub t0: i64,
    pub t1: i64,
    pub t2: i64,
    pub t0_remaining: i64,
    pub t1_remaining: i64,
    pub ready_ack: bool,
    pub released_claim_sig: Option<AdaptorPresig>,
    /// Present-with-null: the desk's prepared chain-A lock UTxO (seam-1 delivery
    /// field), null until the desk has prepared its ADA lock after our M2.
    /// `#[serde(default)]` so the `-dev`/stub desk — which uses the single-shot
    /// `Lock()` adapter and never emits this field — still decodes cleanly.
    #[serde(default)]
    pub lock_utxo: Option<LockUtxo>,
    /// D20: the chain-A address the desk will sign the claim over, and the txid
    /// its claim pre-signature actually binds.
    ///
    /// These exist so the party that did NOT sign the claim body can test it
    /// **before committing funds**. The claim is the asymmetric one: the desk
    /// signs it and we cannot verify it until M5 — by which point both legs are
    /// locked. A destination mismatch is cheap here and ruinous there, which is
    /// exactly what swap `46d85388` cost.
    ///
    /// `#[serde(default)]` because a desk without D20 omits them; absence means
    /// "cannot check", which we report rather than treat as agreement.
    #[serde(default)]
    pub claim_dest: String,
    #[serde(default)]
    pub claim_presig_txid: String,
    /// `"nominated"` | `"derived"` | `""` (a desk that does not publish it).
    ///
    /// The field that lets one guard serve both directions. A *derived* claim
    /// destination is **correct in BUY** — the desk receives the ADA there and
    /// nobody nominates a destination for it — and is **the C12 failure in SELL**,
    /// where we did nominate one and it went missing. Same value, opposite
    /// verdicts, and only the source separates them.
    ///
    /// Without it the guard would have to special-case direction, which is how
    /// `payout_address` went wrong four times running.
    #[serde(default)]
    pub claim_dest_source: String,
    /// The chain-A address the desk will build the **refund** body to, and where
    /// that value came from (`"nominated"` | `"derived"` | `""`).
    ///
    /// The mirror of `claim_dest`, and it exists because the same fault happened
    /// twice: C12 on the claim, C23 on the refund. Published from M2 — the same
    /// point as `claim_dest`, and well before either side locks.
    ///
    /// The asymmetry worth remembering: the claim body is signed by whoever
    /// receives, the refund body by whoever locked. On BUY we lock chain A, so
    /// this destination is **ours**, and a disagreement means the pre-signature we
    /// are about to rely on would pay somewhere we did not choose.
    #[serde(default)]
    pub refund_dest: String,
    #[serde(default)]
    pub refund_dest_source: String,
    pub updated_at: i64,
    pub error: String,
}

// --- lock (M3b / M4) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockRequest {
    pub chain: String,
    pub lock_txid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joint_output_proof: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockResponse {
    pub swap_id: String,
    pub state: String,
    pub accepted: bool,
    pub verifying: bool,
}

// --- ready-ack (M5, client-as-leader releases its claim sig) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyAckRequest {
    pub ack: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_adaptor_sig: Option<AdaptorPresig>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyAckResponse {
    // C31 CORRECTED: these are NOT defaulted, and the first version of this fix
    // wrongly made them so. The 202 accept-and-queue body carries all three — Go
    // emits zero values unless a field is tagged `omitempty` — so `state` is an
    // empty VALUE, never an absent field. See the producer's golden fixture in the
    // test below. Defaulting them would blind the mirror to a genuinely missing
    // field, which is the one thing it exists to catch.
    pub swap_id: String,
    pub state: String,
    pub ready: bool,
    pub released_claim_sig: Option<AdaptorPresig>,
    /// `true` when the desk durably PERSISTED our M5 rather than applying it
    /// (desk `dc69cc8`: a slow engine call can no longer reject an inbound
    /// message, only delay applying one). Answered as **202** with no state
    /// fields — see [`ReadyAckResponse`]'s decode test.
    #[serde(default, skip_serializing_if = "is_false")]
    pub queued: bool,
}

// --- abort ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortResponse {
    pub swap_id: String,
    pub state: String,
    pub reservation_released: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The desk's error envelope (best-effort decode for diagnostics). Mirrors the
/// reference client's `APIError`. See [`crate::swap::proxy`] for how the shared
/// sigauth rail maps status+code into typed errors; desk-specific codes
/// (`QUOTE_EXPIRED`, `INVENTORY_UNAVAILABLE`, `SWAP_STATE_CONFLICT`,
/// `PAIR_HALTED`, `SIZE_OUT_OF_RANGE`, `PRIVATE_KEY_REJECTED`) are classified in
/// the client unit (added next).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub error: String,
}

// --- effective-config (the desk's RESOLVED runtime config, read-only) ---

/// `GET /api/desk/effective-config` — the layer that ACTS on the desk's side.
/// Everything here is `#[serde(default)]` on purpose: this endpoint grows
/// fields per desk release, an older desk omits newer ones, and absence must
/// decode as "not published" (could-not-look), never as a decode failure.
/// CC-2 reads only the `ada` block, and only as the FOLLOWER's fallback when
/// `AcceptResponse` carried no slots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveConfig {
    #[serde(default)]
    pub ada: Option<EffectiveAdaConfig>,
    #[serde(default)]
    pub build: Option<EffectiveBuild>,
}

/// The ENGINE's resolved chain-A numbers — the commitment surface, distinct
/// from the `/pairs` advertisement (C48/D48: the two disagreed by 1200s while
/// both sides read the advertisement).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAdaConfig {
    #[serde(default)]
    pub refund_timelock_slots: Option<i64>,
    #[serde(default)]
    pub swipe_delta_slots: Option<i64>,
}

/// The desk's build stamp (linker-set, frozen per process). D59 made "which
/// commit is the desk" a per-surface question; the stamp is how a claim about
/// the running process is checked rather than believed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveBuild {
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub time: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// C31: `/ready-ack` answers in two shapes, decoded against **the producer's own
    /// golden fixtures** rather than against a body we imagined.
    ///
    /// The desk made ready-ack accept-and-queue (`dc69cc8`): if it cannot take its
    /// per-swap lock promptly it persists the message durably and answers **202**,
    /// applying it on the next advance.
    ///
    /// **The first version of this test was wrong, and the way it was wrong is the
    /// point.** The relay described the 202 as carrying `queued: true` "and zero
    /// state fields". That was read as *fields absent*; it meant *fields present
    /// with zero values*. Go's `encoding/json` emits every exported field unless it
    /// is tagged `omitempty`, so `state` is `""` and `ready` is `false` — both on
    /// the wire. A red test was built from that misreading, and it decoded a body
    /// the desk has never sent. The mirror was never broken.
    ///
    /// So this now reads the bytes the producer commits, via `include_str!`: if the
    /// desk changes the shape and re-publishes, our build sees the new bytes; if it
    /// stops publishing them, the build fails loudly rather than silently testing a
    /// stale copy. **A fixture is not an argument.**
    ///
    /// What WAS real: `queued` was absent from this mirror entirely, so the field
    /// would have been silently stripped and an APPLIED ack (200) would have been
    /// indistinguishable from a PROMISED one (202) at 5/7 with both legs locked.
    /// That is the C29 shape, and it is what the fix is actually for.
    #[test]
    fn ready_ack_decodes_the_producers_golden_fixtures_c31() {
        const APPLIED: &str = include_str!(
            "fixtures/ready_ack_applied.json"
        );
        const QUEUED: &str = include_str!(
            "fixtures/ready_ack_queued.json"
        );

        let applied: ReadyAckResponse =
            serde_json::from_str(APPLIED).expect("the 200 applied fixture must decode");
        assert_eq!(applied.state, "READY");
        assert!(applied.ready);
        assert!(!applied.queued, "an applied ack is not a queued one");
        assert!(applied.released_claim_sig.is_some());

        let queued: ReadyAckResponse =
            serde_json::from_str(QUEUED).expect("the 202 accept-and-queue fixture must decode");
        assert!(
            queued.queued,
            "a queued ack must be distinguishable from an applied one, or the operator \
             cannot tell a delivered M5 from a promised one"
        );
        assert!(
            queued.state.is_empty() && !queued.ready,
            "the queued shape carries zero VALUES, not absent fields — the distinction \
             this test originally got backwards"
        );
        assert!(
            !queued.swap_id.is_empty(),
            "swapId is populated even on the queued path; if this ever goes empty the \
             desk has changed the contract"
        );
    }

    /// Replay a message's EXACT wire bytes through the mirror and prove nothing
    /// is dropped or altered: parse the JSON to a `Value`, decode it into the
    /// mirror `T`, re-serialize `T`, and assert the re-serialized `Value` is
    /// byte-equivalent (structurally equal) to the original. A field missing
    /// from the mirror is stripped on decode and fails this equality — the
    /// silent-strip guard. Returns the decoded `T` for further assertions.
    fn roundtrip<T>(json: &str) -> T
    where
        T: Serialize + serde::de::DeserializeOwned,
    {
        let original: Value = serde_json::from_str(json).expect("parse original JSON");
        let typed: T = serde_json::from_str(json).expect("decode into mirror struct");
        let reserialized: Value = serde_json::to_value(&typed).expect("re-serialize mirror");
        assert_eq!(
            original, reserialized,
            "round-trip mismatch: a field was dropped or altered (silent-strip class)"
        );
        typed
    }

    // ---- exact wire bytes from traces/wire-trace.md ----
    // SELL_FOLLOWER (desk = leader): user sells XMR for ADA.
    const SELL_QUOTE_REQ: &str =
        r#"{"pair":"XMR/ADA","direction":"SELL_FOLLOWER","amountIn":"0.1"}"#;
    const SELL_QUOTE_RESP: &str = r#"{"quoteId":"q_be681ca93f5144a84ad38353b78fac49","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountIn":"0.1","amountOut":"27","rate":"270","mid":"300","markup":0.1,"sTotal":0.1,"expiresAt":1783792092,"minConfsIn":10,"minConfsOut":3,"t0Seconds":1200,"t1Seconds":2400,"t2Seconds":3600}"#;
    const SELL_ACCEPT_REQ: &str = r#"{"quoteId":"q_be681ca93f5144a84ad38353b78fac49","payoutAddress":"addr_test_payout","refundAddress":"addr_test_refund","clientChainAPubkey":"9553f53d329d6299073048816db0c362ffa7151fd954ea601b0e0c86b71deed2"}"#;
    const SELL_ACCEPT_RESP: &str = r#"{"swapId":"8f40ce4bde68391ba9ea156934941420","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.1","t0":1783792067,"t1":1783792072,"t2":1783792077,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"b05da3f5694cb470b05da3f5694cb470b05da3f5694cb470b05da3f5694cb470","deskChainAPubkey":"d544f9c3b0ed35a4d544f9c3b0ed35a4d544f9c3b0ed35a4d544f9c3b0ed35a4","adaptorPoint":null,"viewKey":null,"dleqProof":null,"leaderProof":false,"commitments":[],"scriptAddress":"addr_test_stub_8f40ce4b","expiresAt":1783792067}"#;
    const SELL_KEYS_REQ: &str = r#"{"clientKeySharePoint":"083844dd8e9fc41db28dcacad796a8a0bc1209050eb7cd13b66b61a53221ee12","clientChainAPubkey":"9553f53d329d6299073048816db0c362ffa7151fd954ea601b0e0c86b71deed2","adaptorPoint":"996069e6c80427aaffde806789826409b20b3a20d95d22af824adde7a917d90c","viewKey":"a61b5c67b605d4fafbfcbe5b1a28f40f69698bac6b0b0beae3b4d96eff807ecd","dleqProof":null,"t1Slot":null,"t2Slot":null}"#;
    const SELL_KEYS_RESP: &str = r#"{"swapId":"8f40ce4bde68391ba9ea156934941420","state":"ACCEPTED","chainALockAddr":"addr_test_stub_8f40ce4b","chainBJointKey":"89190bf5a699eddd89190bf5a699eddd89190bf5a699eddd89190bf5a699eddd","chainBJointAddr":"xmr_stub_8f40ce4b","accepted":true}"#;
    const SELL_REFUND_SIGS_REQ: &str = r#"{"refundPresig":{"rEnc":"855d9122f27736c6c8bdc78cba6ff85c3f47a73c8aa05296afada116d32b848c","sp":"334f386ba569cf66f1b665dfe3aaab2f0f37b1f55c2de0665b88ad2ab31a3e50"}}"#;
    const SELL_REFUND_SIGS_RESP: &str = r#"{"swapId":"8f40ce4bde68391ba9ea156934941420","state":"ACCEPTED","refundPresig":{"rEnc":"3475de384ee194f73475de384ee194f73475de384ee194f73475de384ee194f7","sp":"ad184716f80d80e7ad184716f80d80e7ad184716f80d80e7ad184716f80d80e7"},"claimPresig":{"rEnc":"f0b3d224bf39b92ff0b3d224bf39b92ff0b3d224bf39b92ff0b3d224bf39b92f","sp":"6d7b036712ce991a6d7b036712ce991a6d7b036712ce991a6d7b036712ce991a"},"verified":true}"#;
    const SELL_LOCK_REQ: &str = r#"{"chain":"B","lockTxid":"d9fb885d8b3e1fc8cfa40e588bcf6987af2a284edb1c1132e18b24f90d85abc0","amount":"0.1"}"#;
    const SELL_LOCK_RESP: &str = r#"{"swapId":"8f40ce4bde68391ba9ea156934941420","state":"SETTLED","accepted":true,"verifying":true}"#;

    // BUY_FOLLOWER (desk = follower): user buys XMR with ADA; client leads.
    const BUY_QUOTE_RESP: &str = r#"{"quoteId":"q_2a48c902cbb2806fdd68c588a236a253","pair":"XMR/ADA","direction":"BUY_FOLLOWER","deskRole":"FOLLOWER","coinIn":"ADA","coinOut":"XMR","amountIn":"3","amountOut":"0.009","rate":"0.003","mid":"0.003333333333333333","markup":0.1,"sTotal":0.1,"expiresAt":1783792092,"minConfsIn":3,"minConfsOut":10,"t0Seconds":1200,"t1Seconds":2400,"t2Seconds":3600}"#;
    const BUY_ACCEPT_RESP: &str = r#"{"swapId":"451456418f5f47b9286a283ebf629caa","pair":"XMR/ADA","direction":"BUY_FOLLOWER","deskRole":"FOLLOWER","coinIn":"ADA","coinOut":"XMR","amountA":"3","amountB":"0.009","t0":1783792067,"t1":1783792072,"t2":1783792077,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"b0f89d533513ff10b0f89d533513ff10b0f89d533513ff10b0f89d533513ff10","deskChainAPubkey":"1160304bf158df7e1160304bf158df7e1160304bf158df7e1160304bf158df7e","adaptorPoint":"086f92e99970ddeb086f92e99970ddeb086f92e99970ddeb086f92e99970ddeb","viewKey":"fceee5ce3a767427fceee5ce3a767427fceee5ce3a767427fceee5ce3a767427","dleqProof":null,"leaderProof":false,"commitments":[],"scriptAddress":"addr_test_stub_45145641","expiresAt":1783792067}"#;
    const BUY_KEYS_REQ: &str = r#"{"clientKeySharePoint":"083844dd8e9fc41db28dcacad796a8a0bc1209050eb7cd13b66b61a53221ee12","clientChainAPubkey":"b5bbcfbd5e39c64cdb534c5e2be1ddc29dddbf1bd1c8b73d5a5451a35c0bed9f","adaptorPoint":null,"viewKey":null,"dleqProof":null,"t1Slot":84600000,"t2Slot":84603600}"#;
    const BUY_LOCK_REQ: &str = r#"{"chain":"A","lockTxid":"6ef6203cceb6e23d149f39addeaed83f203017b10ba555bdfc46fdd6d37185b2","amount":"3"}"#;
    const BUY_LOCK_RESP: &str = r#"{"swapId":"451456418f5f47b9286a283ebf629caa","state":"B_LOCKED","accepted":true,"verifying":true}"#;
    const BUY_READY_ACK_REQ: &str = r#"{"ack":true,"claimAdaptorSig":{"rEnc":"249bdb9a0b21a181626634624ce1349f938ed1f69becac0685a270b3f1373f03","sp":"d15d6f202417e05468354926043009ab6bbe16d485efcb776ec13ef5e30986f9"}}"#;
    const BUY_READY_ACK_RESP: &str = r#"{"swapId":"451456418f5f47b9286a283ebf629caa","state":"B_LOCKED","ready":false,"releasedClaimSig":null}"#;

    // ---- one round-trip per message, both directions ----

    #[test]
    fn sell_quote_request_roundtrips() {
        roundtrip::<QuoteRequest>(SELL_QUOTE_REQ);
    }
    #[test]
    fn sell_quote_response_roundtrips() {
        let q = roundtrip::<QuoteResponse>(SELL_QUOTE_RESP);
        assert_eq!(q.desk_role, "LEADER");
        assert_eq!(q.amount_out, "27");
    }
    #[test]
    fn sell_accept_request_roundtrips() {
        let a = roundtrip::<AcceptRequest>(SELL_ACCEPT_REQ);
        assert!(a.client_chain_a_pubkey.is_some());
    }
    #[test]
    fn sell_accept_response_roundtrips() {
        roundtrip::<AcceptResponse>(SELL_ACCEPT_RESP);
    }
    #[test]
    fn sell_keys_request_roundtrips() {
        roundtrip::<KeysRequest>(SELL_KEYS_REQ);
    }
    #[test]
    fn sell_keys_response_roundtrips() {
        roundtrip::<KeysResponse>(SELL_KEYS_RESP);
    }
    #[test]
    fn sell_refund_sigs_request_roundtrips() {
        roundtrip::<RefundSigsRequest>(SELL_REFUND_SIGS_REQ);
    }
    #[test]
    fn sell_refund_sigs_response_roundtrips() {
        let r = roundtrip::<RefundSigsResponse>(SELL_REFUND_SIGS_RESP);
        assert!(r.claim_presig.is_some());
    }
    #[test]
    fn sell_lock_request_roundtrips() {
        roundtrip::<LockRequest>(SELL_LOCK_REQ);
    }
    #[test]
    fn sell_lock_response_roundtrips() {
        roundtrip::<LockResponse>(SELL_LOCK_RESP);
    }
    #[test]
    fn buy_quote_response_roundtrips() {
        let q = roundtrip::<QuoteResponse>(BUY_QUOTE_RESP);
        assert_eq!(q.desk_role, "FOLLOWER");
    }
    #[test]
    fn buy_accept_response_roundtrips() {
        roundtrip::<AcceptResponse>(BUY_ACCEPT_RESP);
    }
    #[test]
    fn buy_keys_request_roundtrips() {
        roundtrip::<KeysRequest>(BUY_KEYS_REQ);
    }
    #[test]
    fn buy_lock_request_roundtrips() {
        roundtrip::<LockRequest>(BUY_LOCK_REQ);
    }
    #[test]
    fn buy_lock_response_roundtrips() {
        roundtrip::<LockResponse>(BUY_LOCK_RESP);
    }
    #[test]
    fn buy_ready_ack_request_roundtrips() {
        let r = roundtrip::<ReadyAckRequest>(BUY_READY_ACK_REQ);
        assert!(r.ack);
        assert!(r.claim_adaptor_sig.is_some());
    }
    #[test]
    fn buy_ready_ack_response_roundtrips() {
        let r = roundtrip::<ReadyAckResponse>(BUY_READY_ACK_RESP);
        assert!(r.released_claim_sig.is_none()); // present-with-null, not yet released
    }

    // ---- the role-dependent M1/M2 field flip (the #1 porting mistake) ----

    #[test]
    fn sell_m1_leaves_adaptor_and_view_null() {
        // Desk leads (LEADER): adaptorPoint/viewKey are null in M1, moved to M2.
        // CC-18: this is the ADA rule and it is UNCHANGED. The leg-aware widening
        // for LTC's leader proof must not reach this fixture — that is the
        // falsify in `engine::tests::an_ada_leader_proof_is_still_refused_cc18`.
        let m1 = roundtrip::<AcceptResponse>(SELL_ACCEPT_RESP);
        assert!(m1.adaptor_point.is_none());
        assert!(m1.view_key.is_none());
        assert!(m1.dleq_proof.is_none());
        assert!(m1.t1_slot.is_none());
        assert!(m1.t2_slot.is_none());
    }
    #[test]
    fn buy_m1_carries_adaptor_and_view() {
        // Desk follows (FOLLOWER): adaptorPoint/viewKey are populated in M1.
        let m1 = roundtrip::<AcceptResponse>(BUY_ACCEPT_RESP);
        assert!(m1.adaptor_point.is_some());
        assert!(m1.view_key.is_some());
        assert!(m1.dleq_proof.is_none()); // ADA same-curve: no DLEq in either direction
    }
    #[test]
    fn sell_m2_carries_adaptor_and_view() {
        // Client follows: it contributes adaptorPoint/viewKey in M2.
        let m2 = roundtrip::<KeysRequest>(SELL_KEYS_REQ);
        assert!(m2.adaptor_point.is_some());
        assert!(m2.view_key.is_some());
    }
    #[test]
    fn buy_m2_leaves_adaptor_and_view_null() {
        // Client leads: the desk-follower already provided them in M1.
        let m2 = roundtrip::<KeysRequest>(BUY_KEYS_REQ);
        assert!(m2.adaptor_point.is_none());
        assert!(m2.view_key.is_none());
    }

    // ---- present-with-null must serialize the key, NOT omit it ----

    #[test]
    fn buy_m2_serializes_adaptor_as_null_not_omitted() {
        // If skip_serializing_if were wrongly applied, the key would vanish and
        // the desk would misread the role. Lock the present-with-null contract.
        let m2: KeysRequest = serde_json::from_str(BUY_KEYS_REQ).unwrap();
        let v = serde_json::to_value(&m2).unwrap();
        for key in ["adaptorPoint", "viewKey", "dleqProof"] {
            assert!(v.get(key).is_some(), "{key} key must be PRESENT (present-with-null)");
            assert!(v[key].is_null(), "{key} must serialize as null, not be omitted");
        }
    }

    // ── M2 timelock slots: LEADER material, the mirror of adaptor/view ────

    #[test]
    fn buy_m2_carries_the_leaders_committed_slots() {
        // BUY_FOLLOWER: the CLIENT leads, so it commits the chain-A two-timelock
        // refund window and conveys it in M2. The desk (follower) needs these to
        // derive the same chain-A script address it must watch our lock at.
        let m2 = roundtrip::<KeysRequest>(BUY_KEYS_REQ);
        assert_eq!(m2.t1_slot, Some(84_600_000));
        assert_eq!(m2.t2_slot, Some(84_603_600));
        assert!(m2.t2_slot > m2.t1_slot, "t2 must be after t1");
    }

    #[test]
    fn sell_m2_leaves_the_slots_null_because_the_desk_committed_them() {
        // SELL_FOLLOWER: the DESK leads and committed the slots in M1, so the
        // client must NOT re-commit them here.
        let m2 = roundtrip::<KeysRequest>(SELL_KEYS_REQ);
        assert_eq!(m2.t1_slot, None);
        assert_eq!(m2.t2_slot, None);
    }

    #[test]
    fn sell_m2_serializes_slots_as_null_not_omitted() {
        // Same silent-strip guard as the adaptor fields, for the other role. A
        // vanished slot key does not make the desk misread the role — it leaves
        // the desk unable to compute our lock address at all.
        let m2: KeysRequest = serde_json::from_str(SELL_KEYS_REQ).unwrap();
        let v = serde_json::to_value(&m2).unwrap();
        for key in ["t1Slot", "t2Slot"] {
            assert!(v.get(key).is_some(), "{key} key must be PRESENT (present-with-null)");
            assert!(v[key].is_null(), "{key} must serialize as null, not be omitted");
        }
    }

    #[test]
    fn the_two_m2_field_groups_flip_in_opposite_directions() {
        // The decision this round, in one assertion. `adaptorPoint`/`viewKey` are
        // FOLLOWER material; `t1Slot`/`t2Slot` are LEADER material. So in M2
        // (client -> desk) exactly one group is populated, and which one is
        // decided by whether the CLIENT leads. Getting either backwards is the
        // role-flip mistake, now in both polarities.
        let sell = roundtrip::<KeysRequest>(SELL_KEYS_REQ); // client FOLLOWS
        let buy = roundtrip::<KeysRequest>(BUY_KEYS_REQ); // client LEADS

        assert!(sell.adaptor_point.is_some() && sell.view_key.is_some());
        assert!(sell.t1_slot.is_none() && sell.t2_slot.is_none());

        assert!(buy.adaptor_point.is_none() && buy.view_key.is_none());
        assert!(buy.t1_slot.is_some() && buy.t2_slot.is_some());
    }
    #[test]
    fn sell_m1_serializes_adaptor_as_null_not_omitted() {
        let m1: AcceptResponse = serde_json::from_str(SELL_ACCEPT_RESP).unwrap();
        let v = serde_json::to_value(&m1).unwrap();
        for key in ["adaptorPoint", "viewKey", "dleqProof", "t1Slot", "t2Slot"] {
            assert!(v.get(key).is_some(), "{key} key must be PRESENT (present-with-null)");
            assert!(v[key].is_null(), "{key} must serialize as null, not be omitted");
        }
    }

    // ---- omitempty fields must be OMITTED when absent (Go `,omitempty`) ----

    #[test]
    fn refund_sigs_request_omits_claim_cosig_when_absent() {
        let r: RefundSigsRequest = serde_json::from_str(SELL_REFUND_SIGS_REQ).unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert!(
            v.get("claimCosig").is_none(),
            "claimCosig is `,omitempty` - must be absent when None"
        );
    }
    #[test]
    fn lock_request_omits_joint_output_proof_when_absent() {
        let r: LockRequest = serde_json::from_str(SELL_LOCK_REQ).unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert!(
            v.get("jointOutputProof").is_none(),
            "jointOutputProof is `,omitempty` - must be absent when None"
        );
        assert_eq!(v.get("amount").and_then(Value::as_str), Some("0.1"));
    }
    #[test]
    fn abort_request_omits_reason_when_none() {
        let v = serde_json::to_value(AbortRequest { reason: None }).unwrap();
        assert!(v.get("reason").is_none(), "reason is `,omitempty`");
        assert_eq!(v, serde_json::json!({}));
    }

    // ---- StatusResponse (polls are absent from the trace) ----

    /// BUY attaches the prepared chain-A lock to M3; SELL must not.
    ///
    /// The second half is the one that matters: every settled SELL sent a request
    /// with exactly two fields, and adding an optional third must not change that
    /// on the wire. `skip_serializing_if` is what guarantees it, and this pins it —
    /// a future `#[derive]` reshuffle that drops the attribute would otherwise
    /// start sending `"lockUtxo": null` to a desk that has only ever seen SELL.
    #[test]
    fn only_buy_puts_a_lock_utxo_on_the_m3_request() {
        let presig = AdaptorPresig {
            r_enc: "aa".into(),
            sp: "bb".into(),
        };
        let sell = RefundSigsRequest {
            refund_presig: presig.clone(),
            claim_cosig: None,
                leg_sigs: None,
            lock_utxo: None,
        };
        let json = serde_json::to_string(&sell).expect("serialize SELL M3");
        assert!(
            !json.contains("lockUtxo"),
            "SELL M3 must not mention lockUtxo at all, got {json}"
        );
        assert!(!json.contains("claimCosig"), "absent options stay absent: {json}");

        let buy = RefundSigsRequest {
            refund_presig: presig,
            claim_cosig: None,
                leg_sigs: None,
            lock_utxo: Some(LockUtxo {
                txid: "1149f30b".into(),
                index: 0,
                amount: 27_000_000,
            }),
        };
        let v: serde_json::Value =
            serde_json::to_value(&buy).expect("serialize BUY M3");
        assert_eq!(v["lockUtxo"]["txid"], "1149f30b");
        assert_eq!(v["lockUtxo"]["amount"], 27_000_000);
    }

    #[test]
    fn status_response_full_roundtrips_with_empty_txids_and_null_sig() {
        // A mid-flight status: chain A locked, chain B not yet, no claim sig
        // released. Empty txids serialize as "" (present); releasedClaimSig as
        // null (present-with-null).
        let json = r#"{"swapId":"8f40ce4bde68391ba9ea156934941420","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","state":"A_LOCKED","coinIn":"XMR","coinOut":"ADA","amountIn":"0.1","amountOut":"27","lockATxid":"12161ff2a2","lockBTxid":"","claimATxid":"","claimDest":"","claimPresigTxid":"","claimDestSource":"","refundDest":"","refundDestSource":"","sweepBTxid":"","refundTxid":"","reclaimTxid":"","confsA":3,"confsB":0,"minConfsA":3,"minConfsB":10,"t0":1783792067,"t1":1783792072,"t2":1783792077,"t0Remaining":0,"t1Remaining":5,"readyAck":false,"releasedClaimSig":null,"lockUtxo":null,"updatedAt":1783792070,"error":""}"#;
        let st = roundtrip::<StatusResponse>(json);
        assert_eq!(st.state, "A_LOCKED");
        assert_eq!(st.lock_b_txid, "");
        assert!(st.released_claim_sig.is_none());
        assert!(st.lock_utxo.is_none(), "lockUtxo is null until the desk prepares its ADA lock");
    }

    /// The seam-1 delivery field (`DESK-DELIVERY-FIELD.md`): once the desk PREPARES
    /// its ADA lock (after our M2), `/status.lockUtxo` carries the built-but-
    /// unsubmitted chain-A output the client feeds to `set_lock_utxo` before M3.
    /// `amount` is a JSON number (lovelace), not a decimal string.
    /// A desk older than D20 sends no `claimDest`/`claimPresigTxid`. It must
    /// still decode — the fields default to empty, which
    /// `conductor::claim_dest_check` reads as "could not check", never as
    /// agreement. Deliberately not a `roundtrip`: the whole point is that the
    /// re-serialized form gains fields the original lacked.
    #[test]
    fn a_pre_d20_status_without_claim_dest_still_decodes_as_unpublished() {
        let json = r#"{"swapId":"8f40ce","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","state":"A_LOCKED","coinIn":"XMR","coinOut":"ADA","amountIn":"0.1","amountOut":"27","lockATxid":"12161ff2a2","lockBTxid":"","claimATxid":"","sweepBTxid":"","refundTxid":"","reclaimTxid":"","confsA":3,"confsB":0,"minConfsA":3,"minConfsB":10,"t0":1,"t1":2,"t2":3,"t0Remaining":0,"t1Remaining":5,"readyAck":false,"releasedClaimSig":null,"lockUtxo":null,"updatedAt":4,"error":""}"#;
        let st: StatusResponse = serde_json::from_str(json).expect("pre-D20 status must decode");
        assert_eq!(st.claim_dest, "");
        assert_eq!(st.claim_presig_txid, "");
        assert_eq!(st.state, "A_LOCKED", "the rest of the payload is unaffected");
    }

    #[test]
    fn status_response_carries_a_prepared_lock_utxo() {
        let json = r#"{"swapId":"8f40ce4bde68391ba9ea156934941420","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","state":"ACCEPTED","coinIn":"XMR","coinOut":"ADA","amountIn":"0.1","amountOut":"27","lockATxid":"","lockBTxid":"","claimATxid":"","claimDest":"","claimPresigTxid":"","claimDestSource":"","refundDest":"","refundDestSource":"","sweepBTxid":"","refundTxid":"","reclaimTxid":"","confsA":0,"confsB":0,"minConfsA":3,"minConfsB":10,"t0":1783792067,"t1":1783792072,"t2":1783792077,"t0Remaining":0,"t1Remaining":5,"readyAck":false,"releasedClaimSig":null,"lockUtxo":{"txid":"aa11bb22cc33","index":0,"amount":5000000},"updatedAt":1783792070,"error":""}"#;
        let st = roundtrip::<StatusResponse>(json);
        let u = st.lock_utxo.expect("lockUtxo present once the desk has prepared its lock");
        assert_eq!(u.txid, "aa11bb22cc33");
        assert_eq!(u.index, 0);
        assert_eq!(u.amount, 5_000_000);
    }

    // ---- pairs (public) + enroll ----

    #[test]
    fn pairs_response_roundtrips() {
        let json = r#"{"pairs":[{"pair":"XMR/ADA","follower":"XMR","leader":"ADA","directions":["SELL_FOLLOWER","BUY_FOLLOWER"],"deskRole":{"BUY_FOLLOWER":"FOLLOWER","SELL_FOLLOWER":"LEADER"},"minSize":"0.05","maxSize":"5.0","indicativeSpread":0.1,"quoteTtlSeconds":30,"t0Seconds":1200,"t1Seconds":2400,"t2Seconds":3600,"minConfsFollower":10,"minConfsLeader":3,"enabled":true,"halted":false}],"serverTime":1783792000}"#;
        let p = roundtrip::<PairsResponse>(json);
        assert_eq!(p.pairs.len(), 1);
        assert_eq!(p.pairs[0].desk_role.get("SELL_FOLLOWER").map(String::as_str), Some("LEADER"));
    }
    /// CC-6: the CURRENT desk bytes, carrying the sizing surface. The fixture
    /// above is a pre-sizing desk and must stay byte-identical (an additive
    /// field we invent on re-serialization is the mirror lying about what was
    /// sent); this one proves the same mirror does not DROP the fields when
    /// they are present, which is the fault the round-trip discipline exists
    /// for.
    #[test]
    fn pairs_response_roundtrips_with_the_sizing_surface_cc6() {
        let json = r#"{"pairs":[{"pair":"XMR/ADA","follower":"XMR","leader":"ADA","directions":["SELL_FOLLOWER"],"deskRole":{"SELL_FOLLOWER":"LEADER"},"minSize":"0.12","maxSize":"0.5","sizeCoin":"XMR","sizing":{"SELL_FOLLOWER":{"minSize":"0.12","maxSize":"0.5","minBasis":"fee-erosion","maxBasis":"configured","minReason":"the four fixed chain bodies cost 0.0024 XMR","unknown":[]}},"indicativeMid":"300","indicativeMidUnit":"ADA per XMR","indicativeSpread":0.1,"quoteTtlSeconds":120,"t0Seconds":10200,"t1Seconds":10800,"t2Seconds":12600,"minConfsFollower":10,"minConfsLeader":3,"enabled":true,"halted":false}],"serverTime":1785851021}"#;
        let p = roundtrip::<PairsResponse>(json);
        let e = p.pairs[0].sizing.get("SELL_FOLLOWER").expect("the per-direction entry survived");
        assert_eq!(e.min_basis, "fee-erosion");
        assert!(e.min_reason.contains("chain bodies"));
        assert_eq!(p.pairs[0].size_coin, "XMR");
    }


    /// F32-0 / D116 round: decode the desk's M1 nomination in BOTH role shapes.
    ///
    /// The desk asked us to confirm we read the four fields off a real M1
    /// before they flip the float address on. This is that confirmation, and it
    /// also pins their contract: exactly ONE pair is populated and the role
    /// decides which, because chain A has two branches with one owner each.
    #[test]
    fn m1_carries_the_desks_nomination_in_exactly_one_pair_f32_0() {
        // LEADER / SELL: the desk locks chain A, so the desk REFUNDS.
        let sell = r#"{"swapId":"s1","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.15","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"leaderProof":false,"commitments":[],"scriptAddress":"addr","expiresAt":1,"refundDest":"addr_test1desk_float","refundDestSource":"nominated"}"#;
        let m1: AcceptResponse = serde_json::from_str(sell).unwrap();
        assert_eq!(m1.refund_dest, "addr_test1desk_float");
        assert_eq!(m1.refund_dest_source, "nominated");
        // The claim branch is OURS on this direction; a desk filling it would be
        // choosing where our coins go.
        assert!(m1.claim_dest.is_empty() && m1.claim_dest_source.is_empty());

        // FOLLOWER / BUY: we lock chain A, so the desk CLAIMS.
        let buy = r#"{"swapId":"s2","pair":"XMR/ADA","direction":"BUY_FOLLOWER","deskRole":"FOLLOWER","coinIn":"ADA","coinOut":"XMR","amountA":"3","amountB":"0.009","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":"ap","viewKey":"vk","dleqProof":null,"leaderProof":false,"commitments":[],"scriptAddress":"addr","expiresAt":1,"claimDest":"addr_test1desk_float","claimDestSource":"nominated"}"#;
        let m2: AcceptResponse = serde_json::from_str(buy).unwrap();
        assert_eq!(m2.claim_dest, "addr_test1desk_float");
        assert_eq!(m2.claim_dest_source, "nominated");
        assert!(m2.refund_dest.is_empty() && m2.refund_dest_source.is_empty());
    }

    /// The near-miss, pinned so it cannot recur quietly.
    ///
    /// The desk first shipped a single `deskChainADest`. `#[serde(default)]`
    /// means an unknown key is DROPPED and ours arrive EMPTY - which our own
    /// contract defines as "derive". We would have derived while they built
    /// with a nomination: two honest derivations, two bodies, and a
    /// pre-signature binding one the other party never builds. It would not
    /// have failed at the seam; it fails later at M3 as a signature error.
    ///
    /// This test asserts the SILENCE, so the shape of the near-miss is on
    /// record rather than only in a relay.
    #[test]
    fn an_unknown_nomination_key_is_dropped_and_reads_as_derive_f32_0() {
        let wrong = r#"{"swapId":"s3","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.15","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"leaderProof":false,"commitments":[],"scriptAddress":"addr","expiresAt":1,"deskChainADest":"rltc1qwould_have_been_ignored"}"#;
        let m: AcceptResponse = serde_json::from_str(wrong).unwrap();
        assert!(
            m.refund_dest.is_empty() && m.claim_dest.is_empty(),
            "an unknown key must not populate a nomination - silence is the fault, not a decode error"
        );
    }

    /// An unconfigured desk omits all four, and the M1 stays byte-identical to
    /// a pre-F32-0 one. `skip_serializing_if` is what makes the addition
    /// invisible to a desk that has not turned it on.
    #[test]
    fn an_unconfigured_m1_is_byte_identical_to_pre_f32_0() {
        let plain = r#"{"swapId":"s4","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.15","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"leaderProof":false,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#;
        let m = roundtrip::<AcceptResponse>(plain);
        assert!(m.claim_dest.is_empty() && m.refund_dest.is_empty());
        let re = serde_json::to_string(&m).unwrap();
        for k in ["claimDest", "claimDestSource", "refundDest", "refundDestSource"] {
            assert!(!re.contains(k), "an unconfigured M1 grew {k}: {re}");
        }
    }

    #[test]
    fn enroll_response_roundtrips_without_already() {
        // `already` is `,omitempty` — absent when false.
        let v = serde_json::to_value(EnrollResponse { enrolled: true, already: false }).unwrap();
        assert_eq!(v, serde_json::json!({"enrolled": true}));
        let r: EnrollResponse = serde_json::from_str(r#"{"enrolled":true,"already":true}"#).unwrap();
        assert!(r.already);
    }

    // ── CLIENT-1 / C31-2: the leader-proof capability (D170) ─────────────

    /// **The v100 amendment, and the failure it prevents.** The desk always
    /// sends `leaderProof`; we must still DECODE an M1 that lacks it, because
    /// otherwise the field's own arrival is a flag day — every swap against a
    /// desk that has not deployed yet fails to PARSE M1 rather than negotiating
    /// false. Absent must read as false, which is also the only safe answer:
    /// "this desk predates the field" and "the desk declined" both mean no proof
    /// is coming.
    ///
    /// The fixture is the pre-capability M1 verbatim — if `#[serde(default)]`
    /// is ever dropped, this goes red instead of a live swap doing it.
    #[test]
    fn m1_without_leader_proof_decodes_as_false_rather_than_failing() {
        // NO `leaderProof` KEY. That absence is the entire subject of this test —
        // if a bulk edit ever adds one here the test passes while asserting
        // nothing, so the guard below re-checks the fixture itself.
        let pre_capability = r#"{"swapId":"s9","pair":"XMR/LTC","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"LTC","amountA":"27","amountB":"0.15","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#;
        assert!(
            !pre_capability.contains("leaderProof"),
            "the fixture for 'M1 WITHOUT leaderProof' grew a leaderProof key - this test would \
             now pass without testing anything"
        );
        let m: AcceptResponse = serde_json::from_str(pre_capability)
            .expect("an M1 from a desk that predates the field MUST still decode");
        assert!(!m.leader_proof, "absent must read as false, never as true");
    }

    /// The other half: when the desk DOES answer, the answer is carried through
    /// verbatim. Both halves are needed — absent-tolerance alone would lose the
    /// distinction between "declined" and "older desk".
    #[test]
    fn m1_carries_the_desks_answer_when_present() {
        let with = r#"{"swapId":"s9","pair":"XMR/LTC","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"LTC","amountA":"27","amountB":"0.15","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"leaderProof":true,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#;
        let m = roundtrip::<AcceptResponse>(with);
        assert!(m.leader_proof);
        // And it survives a re-serialize, so a rehydrated record and the wire agree.
        assert!(serde_json::to_string(&m).unwrap().contains("\"leaderProof\":true"));
    }

    /// An accept that does not ask stays byte-identical to every accept that has
    /// settled to date. `skip_serializing_if` is what keeps the ADA leg — and
    /// any pre-capability client behaviour — invisible to the desk.
    #[test]
    fn an_accept_that_does_not_ask_omits_the_field_entirely() {
        let req = AcceptRequest {
            quote_id: "q".into(),
            payout_address: "p".into(),
            refund_address: "r".into(),
            client_chain_a_pubkey: None,
            leader_proof: None,
        };
        let s = serde_json::to_string(&req).unwrap();
        assert!(!s.contains("leaderProof"), "a non-asking accept grew the field: {s}");

        let asking = AcceptRequest { leader_proof: Some(true), ..req };
        assert!(serde_json::to_string(&asking).unwrap().contains("\"leaderProof\":true"));
    }
}
