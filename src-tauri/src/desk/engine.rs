//! Client-side 8.1 state machine + the safety gating that makes every desk
//! message ADVICE, not a command (sub-plan 04 D). The Rust twin of the
//! `SafeToReleaseClaimSig` + `ValidM2` halves of the reference client's
//! `safety.go`, plus the role/state model the harness drives.
//!
//! The desk drives the canonical state; the client holds a MIRRORED machine and
//! gates every value-moving step on its OWN chain observation
//! ([`super::watch::ChainObserver`]) — never on the desk's `/status`. The gates
//! here are what the hostile-desk tests exercise (harness H1/H3); the refund
//! backstop (H2) lives in [`super::watch`].

#![allow(dead_code)] // consumed by desk/commands.rs + the Stage-A driver (later)

use super::watch::{Chain, ChainObserver, LockSighting};
use super::wire;

/// The 8.1 swap states (the desk's `state` strings). `Unknown` never panics on a
/// state the desk adds later — the engine treats it as non-terminal and keeps
/// observing rather than crashing a swap that holds funds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeskSwapState {
    Accepted,
    ALocked,
    BLocked,
    Ready,
    AClaimed,
    Settled,
    ARefunded,
    Failed,
    Aborted,
    Unknown(String),
}

impl DeskSwapState {
    pub fn parse(s: &str) -> Self {
        match s {
            "ACCEPTED" => Self::Accepted,
            "A_LOCKED" => Self::ALocked,
            "B_LOCKED" => Self::BLocked,
            "READY" => Self::Ready,
            "A_CLAIMED" => Self::AClaimed,
            "SETTLED" => Self::Settled,
            "A_REFUNDED" => Self::ARefunded,
            "FAILED" => Self::Failed,
            "ABORTED" => Self::Aborted,
            other => Self::Unknown(other.to_string()),
        }
    }

    /// The swap is over; watchers can stop.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Settled | Self::ARefunded | Self::Failed | Self::Aborted
        )
    }

    /// The happy-path terminal (both legs done).
    pub fn is_settled(&self) -> bool {
        matches!(self, Self::Settled)
    }

    /// A refund/abort/failure terminal — the client should hold (or has
    /// reclaimed) its own coin; never a silent loss.
    pub fn is_recovered_or_failed(&self) -> bool {
        matches!(self, Self::ARefunded | Self::Failed | Self::Aborted)
    }
}

/// Which side leads the swap. Derived from the desk's `deskRole`: the desk is
/// LEADER for SELL_FOLLOWER (the client sells the follower coin and follows), and
/// FOLLOWER for BUY_FOLLOWER (the client buys it and leads chain A). The client
/// is always the opposite of the desk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientRole {
    /// Client follows (SELL_FOLLOWER): contributes the adaptor point + view key
    /// in M2, locks chain B after observing the desk's chain-A lock.
    Follower,
    /// Client leads (BUY_FOLLOWER): locks chain A first, then releases its claim
    /// adaptor sig via /ready-ack after observing chain B.
    Leader,
}

impl ClientRole {
    /// From the desk's `deskRole` field ("LEADER" | "FOLLOWER").
    pub fn from_desk_role(desk_role: &str) -> Result<Self, EngineError> {
        match desk_role {
            "LEADER" => Ok(Self::Follower),   // desk leads => client follows
            "FOLLOWER" => Ok(Self::Leader),   // desk follows => client leads
            other => Err(EngineError::UnknownDeskRole(other.to_string())),
        }
    }

    /// From the swap DIRECTION, which is what the client knows at quote time -
    /// before any `deskRole` has come back. `SELL_FOLLOWER` means the user sells
    /// the follower coin, so the desk leads and the client follows.
    pub fn from_direction(direction: &str) -> Result<Self, EngineError> {
        match direction {
            "SELL_FOLLOWER" => Ok(Self::Follower),
            "BUY_FOLLOWER" => Ok(Self::Leader),
            other => Err(EngineError::UnknownDeskRole(other.to_string())),
        }
    }

    /// Which chain the client locks: the follower locks chain B (its follower
    /// coin), the leader locks chain A.
    pub fn client_lock_chain(self) -> &'static str {
        match self {
            Self::Follower => "B",
            Self::Leader => "A",
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EngineError {
    #[error("desk role not recognized: {0}")]
    UnknownDeskRole(String),
    #[error("M2 (keys) response was not accepted by the desk")]
    M2NotAccepted,
    #[error(
        "M2 (keys) response claims accepted but is missing the joint lock material — \
         refusing to proceed to lock funds"
    )]
    IncompleteM2,
    #[error(
        "desk signalled ready but the client's own chain-B observation is unconfirmed — \
         refusing to release the claim sig"
    )]
    PrematureClaimRelease,
    #[error(
        "the client's own chain-A observation is unconfirmed - refusing to lock chain B"
    )]
    PrematureLock,
    /// Distinct from the two `Premature*` variants ON PURPOSE. Those mean the
    /// chain answered and the lock is not there; this means we could not ask.
    /// Both refuse, but only one of them is fixed by waiting - and a swap that
    /// is blind while looking patient is how a timelock arrives unattended.
    #[error(
        "cannot see chain {chain} - refusing to act on an unverified counterparty lock. \
         This is OUR visibility failing, not evidence about the counterparty: {error}"
    )]
    ChainUnreadable { chain: &'static str, error: String },
    /// CC-18. The message's role-shape is wrong for its leg.
    ///
    /// Carries the leg, the sender's role and the offending field so the refusal
    /// names all three - "adaptorPoint present" is not actionable on its own,
    /// because whether it is a fault depends entirely on the other two.
    #[error(
        "role-shape violation on the {leg} leg: a {role} must not send {field} ({why}). \
         Refusing rather than ignoring it: an unexpected field is either a version mismatch or \
         an attempt to have us bind to something we did not ask about, and silently dropping it \
         makes those two indistinguishable"
    )]
    RoleShape {
        leg: &'static str,
        role: &'static str,
        field: &'static str,
        why: &'static str,
    },
    /// CC-18, the mirror: a field the leg REQUIRES for this role is absent.
    #[error(
        "role-shape violation on the {leg} leg: a {role} must send {field} ({why}), and it is \
         absent"
    )]
    RoleShapeMissing {
        leg: &'static str,
        role: &'static str,
        field: &'static str,
        why: &'static str,
    },
}

/// `ValidM2`: reject a success-shaped-but-incomplete `/keys` (M2) response before
/// locking real funds (safety.go `ValidM2`; harness H3). A desk that claims
/// `accepted` while omitting the joint lock material is lying, and acting on it
/// would move funds into an address the client can't recover from.
pub fn valid_m2(kr: &wire::KeysResponse) -> Result<(), EngineError> {
    if !kr.accepted {
        return Err(EngineError::M2NotAccepted);
    }
    if kr.chain_a_lock_addr.is_empty() || kr.chain_b_joint_addr.is_empty() {
        return Err(EngineError::IncompleteM2);
    }
    Ok(())
}

/// CC-18: which party sent the message whose shape is being checked.
///
/// Deliberately NOT [`ClientRole`], which answers "what are WE" — this answers
/// "who wrote this message", and the two are opposites for every message we
/// receive. A name that describes a neighbouring concern is worse than a new
/// one, because it stops the reader looking (the v77 `refundPresig.rEnc`
/// lesson, applied before it costs anything).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Party {
    Leader,
    Follower,
}

impl Party {
    fn as_str(self) -> &'static str {
        match self {
            Party::Leader => "LEADER",
            Party::Follower => "FOLLOWER",
        }
    }
}

/// CC-18: the role-shape of the key-exchange fields, **by leg**.
///
/// # What this enforces, and why it did not exist before
///
/// `adaptorPoint` / `dleqProof` / `viewKey` flip by ROLE, and until now that
/// contract lived in doc comments on [`super::wire`] plus one fixture assertion.
/// The vendored engines enforce it; this mirror did not, so an ADA message
/// carrying a leader proof would have been passed straight through to the engine
/// to refuse. That is fine until the day the rule WIDENS for one leg — which is
/// what CLIENT-1 does — because then "the engine will catch it" stops being true
/// for the leg that no longer refuses it.
///
/// # The rule
///
/// | | FOLLOWER | LEADER (ADA) | LEADER (LTC, proof off) | LEADER (LTC, proof on) |
/// |---|---|---|---|---|
/// | `adaptorPoint` | required | refused | refused | **required** |
/// | `dleqProof` | required on LTC, refused on ADA | refused | refused | **required** |
/// | `viewKey` | required | refused | refused | **still refused** |
///
/// Three points that are easy to get wrong and are therefore stated:
///
/// - **ADA carries no DLEq in either direction.** Both legs of an ADA swap are
///   ed25519, so there is no cross-group statement to prove. A `dleqProof` on
///   ADA is refused no matter who sent it.
/// - **A leader NEVER sends a `viewKey`, capability on or off.** One shared view
///   secret is used and it is the FOLLOWER's. Widening the leader's shape for
///   CLIENT-1 must not quietly widen this too.
/// - **An unasked-for proof is REFUSED, not ignored.** With the capability off,
///   an LTC leader proof arriving means either a version mismatch or an attempt
///   to have us bind to something we never negotiated; dropping it silently
///   makes those indistinguishable.
///
/// The adaptor point is read OUT of the proof by the engine and is never
/// supplied beside it — so this function takes the two together and never
/// treats a supplied point as evidence about anything.
/// Must we refuse this swap at M1 because our own chain-B lock could never
/// happen? (CLIENT-1 / D170; scope corrected by DESK-ANSWER-v102 s2.)
///
/// The rule is **role**, not leg-alone and not "did we ask". The engine guard
/// that kills such a swap (`refund_spend_is_otves`, `ltc_swap.py:544`) refuses
/// the FOLLOWER's chain-B lock, because the follower is the party left holding a
/// signature that reveals no scalar. [`ClientRole::client_lock_chain`] states the
/// same fact: Follower locks B, Leader locks A.
///
/// So each side refuses early for its OWN chain-B lock and neither refuses on the
/// other's behalf:
///
/// * **we FOLLOW** on a leg that needs the capability, and it is off -> refuse.
///   Whether we asked is irrelevant: a swap we did not opt into is still a swap
///   we cannot finish, and it would die at the lock instead of the handshake.
/// * **we LEAD** -> never refuse here. Our chain-A lock is fine; it is the DESK
///   that cannot recover, and that risk is theirs to decline (their accept
///   already does).
///
/// Extracted as a predicate rather than left inline in `accept_and_persist` so it
/// is reachable without a live desk — the same reason the desk extracted theirs.
pub fn must_refuse_at_m1(
    leg: super::sidecar::Leg,
    role: ClientRole,
    leader_proof_negotiated: bool,
) -> bool {
    // ADA is same-curve: the follower's refund pre-signature is an ed25519
    // adaptor signed unconditionally, so there is nothing to negotiate and
    // nothing to refuse.
    matches!(leg, super::sidecar::Leg::Ltc)
        && matches!(role, ClientRole::Follower)
        && !leader_proof_negotiated
}

pub fn valid_role_shape(
    leg: super::sidecar::Leg,
    sender: Party,
    leader_proof_negotiated: bool,
    adaptor_point: Option<&str>,
    dleq_proof: Option<&str>,
    view_key: Option<&str>,
) -> Result<(), EngineError> {
    use super::sidecar::Leg;
    let present = |f: Option<&str>| f.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let (leg_name, role) = (
        match leg {
            Leg::Ada => "ADA",
            Leg::Ltc => "LTC",
        },
        sender.as_str(),
    );
    let refuse = |field: &'static str, why: &'static str| {
        Err(EngineError::RoleShape { leg: leg_name, role, field, why })
    };
    let missing = |field: &'static str, why: &'static str| {
        Err(EngineError::RoleShapeMissing { leg: leg_name, role, field, why })
    };

    // The view key is the one rule that does not move with the leg or the
    // capability, so it is checked first and unconditionally.
    match sender {
        Party::Leader if present(view_key) => {
            return refuse(
                "viewKey",
                "one shared view secret is used and it is the FOLLOWER's",
            )
        }
        Party::Follower if !present(view_key) => {
            return missing(
                "viewKey",
                "both sides need it to see the locked chain-B output",
            )
        }
        _ => {}
    }

    // Whether a DLEq proof is meaningful at all is a property of the LEG, not of
    // the role: same-curve legs have nothing to prove.
    let leg_has_dleq = matches!(leg, Leg::Ltc);
    if present(dleq_proof) && !leg_has_dleq {
        return refuse(
            "dleqProof",
            "both legs of this swap are ed25519, so there is no cross-group statement to prove",
        );
    }

    let may_carry_proof = match sender {
        Party::Follower => true,
        Party::Leader => leg_has_dleq && leader_proof_negotiated,
    };

    if !may_carry_proof {
        if present(adaptor_point) {
            return refuse(
                "adaptorPoint",
                match (sender, leg_has_dleq, leader_proof_negotiated) {
                    (Party::Leader, true, false) => {
                        "this swap did not negotiate the leader-proof capability"
                    }
                    _ => "the adaptor point is FOLLOWER material on this leg",
                },
            );
        }
        if present(dleq_proof) {
            return refuse(
                "dleqProof",
                "this swap did not negotiate the leader-proof capability",
            );
        }
        return Ok(());
    }

    // May carry it — therefore MUST. A half-populated pair is the worst shape:
    // a point with no proof is a point nobody proved anything about.
    if !present(adaptor_point) {
        return missing("adaptorPoint", "it is read out of the proof this role must send");
    }
    if leg_has_dleq && !present(dleq_proof) {
        return missing(
            "dleqProof",
            "an adaptor point on a cross-group leg is meaningless without the proof binding it",
        );
    }
    Ok(())
}

/// CC-6: one direction's resolved sizing window, and where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct SizingWindow {
    pub min: String,
    pub max: String,
    /// The denomination. EMPTY means the desk did not publish one — which is
    /// could-not-look, not a default (their D23).
    pub coin: String,
    pub min_basis: String,
    pub min_reason: String,
    /// Inputs the desk could not look up. Non-empty means a floor was never
    /// computed.
    pub unknown: Vec<String>,
    /// Which surface answered: the per-direction entry or the flat fallback.
    /// A client that cannot say which it used is worse off than one that only
    /// has the flat pair.
    pub source: &'static str,
}

/// CC-6: resolve the window for ONE direction, preferring the per-direction
/// `sizing` entry and falling back to the flat pair fields.
///
/// The flat window is follower-denominated and cannot honestly describe both
/// directions — the desk pays the leader coin on a SELL and the follower coin
/// on a BUY — so where the desk publishes a per-direction entry it wins.
pub fn sizing_for(pair: &wire::PairInfo, direction: &str) -> SizingWindow {
    if let Some(e) = pair.sizing.get(direction) {
        // An entry present but EMPTY is the shape the desk sends for a
        // direction it could not size (we have seen `""`/`""` with
        // `maxBasis: unbounded` on halted pairs). Treat that as the entry
        // answering "I cannot say", not as a zero-width window.
        if !e.min_size.trim().is_empty() || !e.max_size.trim().is_empty() {
            return SizingWindow {
                min: e.min_size.clone(),
                max: e.max_size.clone(),
                coin: pair.size_coin.clone(),
                min_basis: e.min_basis.clone(),
                min_reason: e.min_reason.clone(),
                unknown: e.unknown.clone(),
                source: "sizing[direction]",
            };
        }
        return SizingWindow {
            min: String::new(),
            max: String::new(),
            coin: pair.size_coin.clone(),
            min_basis: e.min_basis.clone(),
            min_reason: e.min_reason.clone(),
            unknown: e.unknown.clone(),
            source: "sizing[direction] (empty — the desk could not size this direction)",
        };
    }
    SizingWindow {
        min: pair.min_size.clone(),
        max: pair.max_size.clone(),
        coin: pair.size_coin.clone(),
        min_basis: String::new(),
        min_reason: String::new(),
        unknown: Vec::new(),
        source: "flat minSize/maxSize (no per-direction entry)",
    }
}

/// CC-6: what a window says about an amount. **Four states, not two** — the same
/// discipline `LockSighting` carries, for the same reason: "outside the window"
/// and "I cannot honestly judge this" demand opposite responses, and a client
/// that collapses them shows a confident number it has no basis for.
#[derive(Debug, Clone, PartialEq)]
pub enum SizeVerdict {
    Within,
    BelowMin { min: String, coin: String, basis: String, reason: String },
    AboveMax { max: String, coin: String },
    /// We looked and cannot answer. Carries WHY, because every cause here has a
    /// different fix.
    CannotJudge { why: String },
}

/// Judge `amount` (denominated in `amount_coin`) against a resolved window.
///
/// Refuses to guess in three distinct ways, each of which would otherwise
/// produce a confidently wrong answer:
///
/// - **The desk published no `sizeCoin`.** Then we do not know what unit the
///   window is in, and comparing a XMR amount to an ADA-denominated bound is
///   arithmetic on two different things. This is D23's exact shape.
/// - **The denominations differ.** Same reason, but knowable — say so and name
///   both, rather than converting through an indicative mid nobody agreed to.
/// - **`unknown` is non-empty.** A floor that was never computed is not a floor
///   that did not bind. Painting it as a clean window is the lie.
pub fn judge_size(window: &SizingWindow, amount: &str, amount_coin: &str) -> SizeVerdict {
    let cannot = |why: String| SizeVerdict::CannotJudge { why };
    if !window.unknown.is_empty() {
        return cannot(format!(
            "the desk could not look up {} sizing input(s), so this window was never fully computed: {}",
            window.unknown.len(),
            window.unknown.join("; ")
        ));
    }
    if window.coin.trim().is_empty() {
        return cannot(
            "the desk published no sizeCoin, so the denomination of this window is unknown and comparing an amount to it would be arithmetic on two different units (their D23)"
                .to_string(),
        );
    }
    if !window.coin.eq_ignore_ascii_case(amount_coin.trim()) {
        return cannot(format!(
            "the window is denominated in {} and the amount is in {}; converting through an indicative mid would invent a bound neither side agreed to",
            window.coin, amount_coin
        ));
    }
    let n = match amount.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => n,
        _ => return cannot(format!("amount {amount:?} is not a finite number")),
    };
    // An absent bound is not an infinite one — but it is also not a refusal, so
    // each side is judged only when the desk actually published it.
    if let Ok(min) = window.min.trim().parse::<f64>() {
        if n < min {
            return SizeVerdict::BelowMin {
                min: window.min.clone(),
                coin: window.coin.clone(),
                basis: window.min_basis.clone(),
                reason: window.min_reason.clone(),
            };
        }
    }
    if let Ok(max) = window.max.trim().parse::<f64>() {
        // A zero maximum is an EMPTY window, not "no ceiling" — the ZEPH pairs
        // publish exactly that when the desk holds none of the coin.
        if n > max {
            return SizeVerdict::AboveMax {
                max: window.max.clone(),
                coin: window.coin.clone(),
            };
        }
    }
    SizeVerdict::Within
}

/// The client-side M5 gate (safety.go `SafeToReleaseClaimSig`; harness H1). When
/// the client LEADS (BUY_FOLLOWER) it may release its claim adaptor sig via
/// `/ready-ack` ONLY after its OWN observer confirms chain B. `desk_says_ready`
/// (the desk's `/status` / M5 signal) is ADVICE and is deliberately insufficient
/// on its own — gating on it would be the setReady-timing theft.
pub fn safe_to_release_claim_sig(
    obs: &dyn ChainObserver,
    _desk_says_ready: bool,
    min_confs: u64,
) -> Result<(), EngineError> {
    judge(obs, Chain::B, min_confs, EngineError::PrematureClaimRelease)
}

/// Turn a sighting into a verdict. Both non-confirmed states refuse — the gate
/// is fail-closed either way — but they refuse with DIFFERENT errors, because
/// "the counterparty has not locked" and "I cannot see the chain" call for
/// opposite responses from whoever is watching. `RPC-PROTOCOL.md` requires the
/// three states be kept apart; this is where that requirement is honoured on the
/// decision path rather than only in the data type.
fn judge(
    obs: &dyn ChainObserver,
    chain: Chain,
    min_confs: u64,
    premature: EngineError,
) -> Result<(), EngineError> {
    match obs.observe_lock(chain) {
        s if s.is_confirmed_to(min_confs) => Ok(()),
        LockSighting::CouldNotLook { error } => Err(EngineError::ChainUnreadable {
            chain: chain.as_str(),
            error,
        }),
        // Confirmed-but-too-shallow lands here too, which is right: it is a
        // "not yet", and the chain answered.
        _ => Err(premature),
    }
}

/// The follower's lock gate (sub-plan 04 C, step 3). When the client FOLLOWS
/// (SELL_FOLLOWER) it broadcasts its chain-B lock ONLY after its own watcher
/// confirms the desk's chain-A lock — never on the desk's word. The same
/// principle as the M5 gate, applied to the lock step.
///
/// `min_confs` is the agreed depth. Depth alone is NOT the whole check — the
/// lock must also be to the right script address for the agreed amount — but
/// that binding is enforced inside the engine's `watch_lock` (A: `>= amountA`
/// [E4]; B: destination == joint addr AND `>= amountB`), which is what produces
/// a [`LockSighting::Confirmed`] in the first place. So this gate is only sound
/// over an observer fed by `watch_lock`; an observer that merely asked a chain
/// tip "does this txid have N confirmations?" would satisfy the signature and
/// silently drop the address and amount binding. That is the one way to
/// implement [`ChainObserver`] wrongly, so it is named here and in the trait.
pub fn safe_to_lock_follower(obs: &dyn ChainObserver, min_confs: u64) -> Result<(), EngineError> {
    judge(obs, Chain::A, min_confs, EngineError::PrematureLock)
}

/// A client-side swap in flight: the in-memory engine view (role + current
/// mirrored state + the T1 the refund watcher needs). The FULL durable record —
/// secret shares, adaptor points, pre-signed refund txs, lock txids — lives in
/// `desk/store.rs` (task 24); this is the lightweight machine the driver folds
/// desk `/status` polls into while gating on the [`ChainObserver`].
#[derive(Debug, Clone)]
pub struct DeskSwap {
    pub swap_id: String,
    pub role: ClientRole,
    pub state: DeskSwapState,
    /// Absolute T1 refund deadline (unix seconds) from M1.
    pub t1_unix: u64,
}

impl DeskSwap {
    /// Seed the machine from the M1 accept response.
    pub fn from_accept(m1: &wire::AcceptResponse) -> Result<Self, EngineError> {
        Ok(Self {
            swap_id: m1.swap_id.clone(),
            role: ClientRole::from_desk_role(&m1.desk_role)?,
            state: DeskSwapState::Accepted,
            t1_unix: m1.t1.max(0) as u64,
        })
    }

    /// Fold a desk `/status` poll into the machine. The desk drives the state;
    /// the engine only mirrors it. Actual value-moving steps stay gated on the
    /// [`ChainObserver`] via the `safe_to_*` functions above — observing a state
    /// here is NOT permission to sign.
    pub fn observe_status(&mut self, st: &wire::StatusResponse) {
        self.state = DeskSwapState::parse(&st.state);
    }

    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::watch::MockObserver;

    fn accept_json(desk_role: &str, t1: i64) -> wire::AcceptResponse {
        serde_json::from_str(&format!(
            r#"{{"swapId":"s1","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"{desk_role}","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.1","t0":10,"t1":{t1},"t2":30,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"aa","deskChainAPubkey":"bb","adaptorPoint":null,"viewKey":null,"dleqProof":null,"commitments":[],"scriptAddress":"addr","expiresAt":10}}"#
        ))
        .unwrap()
    }

    // ---- ValidM2 (safety_test.go::TestValidM2_RejectsIncompleteSuccess; H3) ----

    #[test]
    fn valid_m2_rejects_incomplete_success() {
        let incomplete: wire::KeysResponse =
            serde_json::from_str(r#"{"swapId":"s1","state":"ACCEPTED","chainALockAddr":"","chainBJointKey":"","chainBJointAddr":"","accepted":true}"#).unwrap();
        assert_eq!(valid_m2(&incomplete), Err(EngineError::IncompleteM2));
    }

    #[test]
    fn valid_m2_rejects_not_accepted() {
        let not_ok: wire::KeysResponse =
            serde_json::from_str(r#"{"swapId":"s1","state":"ACCEPTED","chainALockAddr":"a","chainBJointKey":"k","chainBJointAddr":"b","accepted":false}"#).unwrap();
        assert_eq!(valid_m2(&not_ok), Err(EngineError::M2NotAccepted));
    }

    #[test]
    fn valid_m2_accepts_complete() {
        let good: wire::KeysResponse =
            serde_json::from_str(r#"{"swapId":"s1","state":"ACCEPTED","chainALockAddr":"a","chainBJointKey":"k","chainBJointAddr":"b","accepted":true}"#).unwrap();
        assert_eq!(valid_m2(&good), Ok(()));
    }

    // ---- SafeToReleaseClaimSig (safety_test.go::...GatesOnOwnObservation; H1) ----

    #[test]
    fn release_gated_on_own_chain_b_not_the_desks_word() {
        let obs = MockObserver::new();
        // Desk says ready, but our own chain-B observation is unconfirmed -> refuse.
        assert_eq!(
            safe_to_release_claim_sig(&obs, true, 1),
            Err(EngineError::PrematureClaimRelease)
        );
        // Once our own watcher confirms chain B, we may release.
        obs.set_confirmed(Chain::B, 1);
        assert_eq!(safe_to_release_claim_sig(&obs, true, 1), Ok(()));
        // Our own confirmation is sufficient; the desk's opinion is irrelevant.
        assert_eq!(safe_to_release_claim_sig(&obs, false, 1), Ok(()));
    }

    // ---- follower lock gate (04 C step 3) ----

    #[test]
    fn follower_lock_gated_on_own_chain_a() {
        let obs = MockObserver::new();
        assert_eq!(safe_to_lock_follower(&obs, 1), Err(EngineError::PrematureLock));
        obs.set_confirmed(Chain::A, 1);
        assert_eq!(safe_to_lock_follower(&obs, 1), Ok(()));
    }

    // ---- role + state model ----

    #[test]
    fn role_is_opposite_of_desk() {
        assert_eq!(ClientRole::from_desk_role("LEADER").unwrap(), ClientRole::Follower);
        assert_eq!(ClientRole::from_desk_role("FOLLOWER").unwrap(), ClientRole::Leader);
        assert_eq!(ClientRole::Follower.client_lock_chain(), "B");
        assert_eq!(ClientRole::Leader.client_lock_chain(), "A");
        assert!(ClientRole::from_desk_role("SIDEWAYS").is_err());
    }

    #[test]
    fn state_parse_and_terminals() {
        assert_eq!(DeskSwapState::parse("A_LOCKED"), DeskSwapState::ALocked);
        assert!(DeskSwapState::parse("SETTLED").is_settled());
        assert!(DeskSwapState::parse("SETTLED").is_terminal());
        assert!(DeskSwapState::parse("A_REFUNDED").is_recovered_or_failed());
        assert!(DeskSwapState::parse("ABORTED").is_terminal());
        // An unknown desk state is non-terminal (keep observing, never panic).
        let u = DeskSwapState::parse("SOME_NEW_STATE");
        assert!(matches!(u, DeskSwapState::Unknown(_)));
        assert!(!u.is_terminal());
    }

    #[test]
    fn desk_swap_seeds_role_and_t1_from_m1() {
        let sell = DeskSwap::from_accept(&accept_json("LEADER", 2400)).unwrap();
        assert_eq!(sell.role, ClientRole::Follower);
        assert_eq!(sell.state, DeskSwapState::Accepted);
        assert_eq!(sell.t1_unix, 2400);

        let buy = DeskSwap::from_accept(&accept_json("FOLLOWER", 2400)).unwrap();
        assert_eq!(buy.role, ClientRole::Leader);
    }

    #[test]
    fn observe_status_advances_the_mirror() {
        let mut sw = DeskSwap::from_accept(&accept_json("LEADER", 2400)).unwrap();
        let st: wire::StatusResponse = serde_json::from_str(r#"{"swapId":"s1","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","state":"A_LOCKED","coinIn":"XMR","coinOut":"ADA","amountIn":"0.1","amountOut":"27","lockATxid":"a","lockBTxid":"","claimATxid":"","sweepBTxid":"","refundTxid":"","reclaimTxid":"","confsA":3,"confsB":0,"minConfsA":3,"minConfsB":10,"t0":10,"t1":2400,"t2":30,"t0Remaining":0,"t1Remaining":5,"readyAck":false,"releasedClaimSig":null,"updatedAt":11,"error":""}"#).unwrap();
        sw.observe_status(&st);
        assert_eq!(sw.state, DeskSwapState::ALocked);
        assert!(!sw.is_terminal());
    }

    // ── CC-18: leg-aware role shape ──────────────────────────────────────
    //
    // The FALSIFY the desk named is the first test: widening the rule for LTC
    // must NOT widen it for ADA. That is the C49 mirror - a consumer nobody
    // re-read after the producer changed - and it is the specific way this
    // change goes wrong while every new test passes.

    use crate::desk::sidecar::Leg;

    const PT: Option<&str> = Some("02aa");
    const PROOF: Option<&str> = Some("deadbeef");
    const VK: Option<&str> = Some("cafe");

    /// ADA's rule is UNCHANGED. A leader proof on the ADA leg is refused
    /// however hard the caller insists - including with the LTC capability
    /// flag mistakenly on, which is the realistic way this would happen.
    #[test]
    fn an_ada_leader_proof_is_still_refused_cc18() {
        for negotiated in [false, true] {
            assert!(
                matches!(
                    valid_role_shape(Leg::Ada, Party::Leader, negotiated, PT, None, None),
                    Err(EngineError::RoleShape { field: "adaptorPoint", .. })
                ),
                "an ADA leader must never carry an adaptor point (negotiated={negotiated})"
            );
            // And the proof itself is refused on ADA whoever sends it: both
            // legs are ed25519, so there is no cross-group statement to make.
            assert!(matches!(
                valid_role_shape(Leg::Ada, Party::Follower, negotiated, PT, PROOF, VK),
                Err(EngineError::RoleShape { field: "dleqProof", .. })
            ));
        }
        // The shape ADA actually uses still passes, in both directions.
        assert!(valid_role_shape(Leg::Ada, Party::Follower, false, PT, None, VK).is_ok());
        assert!(valid_role_shape(Leg::Ada, Party::Leader, false, None, None, None).is_ok());
    }

    /// LTC with the capability ON accepts the leader proof - CLIENT-1 shape (a).
    #[test]
    fn an_ltc_leader_proof_is_accepted_only_when_negotiated_cc18() {
        assert!(valid_role_shape(Leg::Ltc, Party::Leader, true, PT, PROOF, None).is_ok());
        // OFF: an unasked-for proof is REFUSED, not ignored. Silently dropping
        // it would make a version mismatch and a bind-to-something-unnegotiated
        // attempt indistinguishable.
        assert!(matches!(
            valid_role_shape(Leg::Ltc, Party::Leader, false, PT, PROOF, None),
            Err(EngineError::RoleShape { .. })
        ));
        // ON but half-populated: a point with no proof is a point nobody proved
        // anything about.
        assert!(matches!(
            valid_role_shape(Leg::Ltc, Party::Leader, true, PT, None, None),
            Err(EngineError::RoleShapeMissing { field: "dleqProof", .. })
        ));
        assert!(matches!(
            valid_role_shape(Leg::Ltc, Party::Leader, true, None, PROOF, None),
            Err(EngineError::RoleShapeMissing { field: "adaptorPoint", .. })
        ));
    }

    /// The rule that does NOT move with the leg or the capability: a leader
    /// never sends a view key. Widening the leader's shape for CLIENT-1 must
    /// not quietly widen this too.
    #[test]
    fn a_leader_never_sends_a_view_key_cc18() {
        for (leg, negotiated) in
            [(Leg::Ada, false), (Leg::Ltc, false), (Leg::Ltc, true)]
        {
            assert!(
                matches!(
                    valid_role_shape(leg, Party::Leader, negotiated, PT, PROOF, VK),
                    Err(EngineError::RoleShape { field: "viewKey", .. })
                ),
                "a leader sent a viewKey on {leg:?} (negotiated={negotiated}) and was not refused"
            );
        }
        // The follower's view key is REQUIRED, so its absence is also a fault -
        // an "if present then check" over an always-absent field passes forever.
        assert!(matches!(
            valid_role_shape(Leg::Ltc, Party::Follower, true, PT, PROOF, None),
            Err(EngineError::RoleShapeMissing { field: "viewKey", .. })
        ));
    }

    /// The follower's shape is unchanged by the capability on either leg - it
    /// has always carried the proof material, and CLIENT-1 adds nothing to it.
    #[test]
    fn the_follower_shape_is_untouched_by_the_capability_cc18() {
        for negotiated in [false, true] {
            assert!(valid_role_shape(Leg::Ltc, Party::Follower, negotiated, PT, PROOF, VK).is_ok());
            assert!(valid_role_shape(Leg::Ada, Party::Follower, negotiated, PT, None, VK).is_ok());
        }
    }

    /// Whitespace is not a value. An empty-string field is the shape a JSON
    /// mirror produces when a producer "sets" a field it has nothing for, and
    /// treating it as present would let a blank point satisfy the check.
    #[test]
    fn a_blank_field_counts_as_absent_cc18() {
        assert!(matches!(
            valid_role_shape(Leg::Ltc, Party::Leader, true, Some("  "), PROOF, None),
            Err(EngineError::RoleShapeMissing { field: "adaptorPoint", .. })
        ));
        assert!(valid_role_shape(Leg::Ada, Party::Leader, false, Some(""), None, Some("")).is_ok());
    }

    // ── CC-6 / CC-20: the sizing surface ─────────────────────────────────

    fn pair_with(sizing: Vec<(&str, wire::SizingEntry)>, size_coin: &str) -> wire::PairInfo {
        wire::PairInfo {
            pair: "XMR/ADA".into(),
            follower: "XMR".into(),
            leader: "ADA".into(),
            directions: vec!["SELL_FOLLOWER".into(), "BUY_FOLLOWER".into()],
            desk_role: Default::default(),
            min_size: "0.12".into(),
            max_size: "0.5".into(),
            size_coin: size_coin.into(),
            sizing: sizing.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            indicative_mid: "300".into(),
            indicative_mid_unit: "ADA per XMR".into(),
            halt_reason: String::new(),
            indicative_spread: 0.1,
            quote_ttl_seconds: 120,
            t0_seconds: 10200,
            t1_seconds: 10800,
            t2_seconds: 12600,
            min_confs_follower: 10,
            min_confs_leader: 3,
            enabled: true,
            halted: false,
        }
    }

    fn entry(min: &str, max: &str, unknown: &[&str]) -> wire::SizingEntry {
        wire::SizingEntry {
            min_size: min.into(),
            max_size: max.into(),
            min_basis: "fee-erosion".into(),
            max_basis: "configured".into(),
            min_reason: "the four fixed chain bodies cost 0.0024 XMR".into(),
            unknown: unknown.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The per-direction entry WINS over the flat window, and the resolver says
    /// which surface answered - a client that cannot tell is worse off than one
    /// that only had the flat pair.
    #[test]
    fn the_per_direction_entry_wins_and_names_its_source_cc6() {
        let p = pair_with(vec![("BUY_FOLLOWER", entry("0.2", "0.4", &[]))], "XMR");
        let buy = sizing_for(&p, "BUY_FOLLOWER");
        assert_eq!((buy.min.as_str(), buy.max.as_str()), ("0.2", "0.4"));
        assert!(buy.source.starts_with("sizing[direction]"));
        // A direction with no entry falls back to the flat window, and says so.
        let sell = sizing_for(&p, "SELL_FOLLOWER");
        assert_eq!((sell.min.as_str(), sell.max.as_str()), ("0.12", "0.5"));
        assert!(sell.source.starts_with("flat"));
    }

    /// The desk publishes an EMPTY entry for a direction it could not size (we
    /// have seen ""/"" with maxBasis unbounded on halted pairs). That is the
    /// entry saying "I cannot", not a zero-width window.
    #[test]
    fn an_empty_entry_is_could_not_size_not_a_zero_window_cc6() {
        let p = pair_with(vec![("SELL_FOLLOWER", entry("", "", &[]))], "XMR");
        let w = sizing_for(&p, "SELL_FOLLOWER");
        assert!(w.min.is_empty() && w.max.is_empty());
        assert!(w.source.contains("could not size"));
        // And judging against it does not silently pass: with no bounds
        // published there is nothing to be inside of, so it is Within only
        // because neither side was stated - which the source string discloses.
        assert_eq!(judge_size(&w, "0.15", "XMR"), SizeVerdict::Within);
    }

    /// FALSIFY (the desk's, for CC-6d): a pair whose `unknown` is non-empty must
    /// NOT produce a clean verdict. A floor that was never computed is not a
    /// floor that did not bind.
    #[test]
    fn a_non_empty_unknown_cannot_be_judged_cc6() {
        let p = pair_with(
            vec![("BUY_FOLLOWER", entry("0.002", "54.28", &["rate: no leg-to-leg conversion"]))],
            "XMR",
        );
        let w = sizing_for(&p, "BUY_FOLLOWER");
        match judge_size(&w, "0.15", "XMR") {
            SizeVerdict::CannotJudge { why } => {
                assert!(why.contains("never fully computed"), "{why}");
                assert!(why.contains("rate:"), "the caveat must NAME the missing input: {why}");
            }
            other => panic!("an unmeasured window judged cleanly as {other:?}"),
        }
    }

    /// D23's shape, refused rather than guessed: no denomination, or a
    /// denomination that differs from the amount's, is could-not-look. Comparing
    /// a XMR amount to an ADA bound is arithmetic on two different things.
    #[test]
    fn a_window_of_unknown_or_mismatched_denomination_cannot_be_judged_cc6() {
        let no_coin = sizing_for(&pair_with(vec![], ""), "SELL_FOLLOWER");
        assert!(matches!(
            judge_size(&no_coin, "0.15", "XMR"),
            SizeVerdict::CannotJudge { .. }
        ));
        let xmr = sizing_for(&pair_with(vec![], "XMR"), "SELL_FOLLOWER");
        match judge_size(&xmr, "27", "ADA") {
            SizeVerdict::CannotJudge { why } => {
                assert!(why.contains("XMR") && why.contains("ADA"), "name both: {why}");
            }
            other => panic!("a cross-denomination comparison produced {other:?}"),
        }
        // Matching denomination judges normally, case-insensitively.
        assert_eq!(judge_size(&xmr, "0.15", "xmr"), SizeVerdict::Within);
    }

    /// The bounds themselves, including the ZEPH shape: max 0 with min 0.002 is
    /// an EMPTY window (the desk holds none of the coin), not "no ceiling".
    #[test]
    fn below_min_and_above_max_carry_the_desks_own_reason_cc6() {
        let p = pair_with(vec![("SELL_FOLLOWER", entry("0.12", "0.5", &[]))], "XMR");
        let w = sizing_for(&p, "SELL_FOLLOWER");
        match judge_size(&w, "0.1", "XMR") {
            SizeVerdict::BelowMin { min, basis, reason, .. } => {
                assert_eq!(min, "0.12");
                assert_eq!(basis, "fee-erosion");
                assert!(reason.contains("chain bodies"), "the desk's sentence is surfaced verbatim");
            }
            other => panic!("0.1 against a 0.12 floor gave {other:?}"),
        }
        assert!(matches!(judge_size(&w, "0.6", "XMR"), SizeVerdict::AboveMax { .. }));
        let zeph = pair_with(vec![("BUY_FOLLOWER", entry("0.002", "0", &[]))], "ZEPH");
        let zw = sizing_for(&zeph, "BUY_FOLLOWER");
        assert!(
            matches!(judge_size(&zw, "0.5", "ZEPH"), SizeVerdict::AboveMax { .. }),
            "max 0 is an empty window, not an absent ceiling"
        );
    }

    /// The M1 refusal is scoped by ROLE, and the two rows that matter are the
    /// ones that killed the alternatives we proposed to the desk.
    ///
    /// "Only if we asked" under-refuses row 2; "any LTC swap" over-refuses row 3.
    #[test]
    fn m1_refusal_is_scoped_by_who_locks_chain_b() {
        use super::super::sidecar::Leg;
        use ClientRole::{Follower, Leader};

        // 1. we FOLLOW on LTC with the capability ON — the whole point; proceed.
        assert!(!must_refuse_at_m1(Leg::Ltc, Follower, true));

        // 2. we FOLLOW on LTC with it OFF — WE lock chain B and our own engine
        //    would refuse that lock, so the swap is already dead. Refuse at the
        //    handshake rather than after chain A is committed. This row is true
        //    whether or not we asked: the predicate never sees our request.
        assert!(must_refuse_at_m1(Leg::Ltc, Follower, false));

        // 3. we LEAD on LTC with it OFF — we lock chain A, which is fine. It is
        //    the DESK that cannot recover, their guard fires, and refusing here
        //    would be refusing on a counterparty's behalf.
        assert!(
            !must_refuse_at_m1(Leg::Ltc, Leader, false),
            "leading is not our chain-B lock — this is the row 'any LTC swap' gets wrong"
        );

        // 4/5. ADA is same-curve: nothing to negotiate, so nothing to refuse in
        //      either role even with the flag off.
        assert!(!must_refuse_at_m1(Leg::Ada, Follower, false));
        assert!(!must_refuse_at_m1(Leg::Ada, Leader, false));
    }
}
