//! The refund path: what actually happens when the refund watcher fires.
//!
//! # Why this is a module and not four lines inside the watcher
//!
//! The refund is the only part of an atomic swap that runs with NO counterparty
//! and NO user present. Every other step has someone to notice it went wrong;
//! this one runs at T1 in the background, possibly days later, possibly after an
//! app restart, against a desk that may be gone. It is also the step that
//! decides whether the user's coin comes back. So it gets its own module, its
//! own error type, and its own tests with an injected broadcaster.
//!
//! # Ordering is the safety property
//!
//! The checks below run in a deliberate order, most-dangerous first:
//!
//! 1. **Terminal state.** Refunding a SETTLED swap is the worst outcome in the
//!    file — the counterparty legitimately claimed, and publishing a refund on
//!    top is at best a wasted fee and at worst a double-spend attempt against
//!    our own settled leg. A watcher that survived past settlement (a stop flag
//!    that never got raised, a stale rehydrated task) must be stopped HERE, not
//!    trusted to have stopped earlier.
//! 2. **Did we lock anything.** No lock txid on our own leg means no funds are
//!    at risk. That is a *good* outcome, not an error, and it must not be
//!    reported as a failed refund.
//! 3. **Do we hold a pre-signature.** If not, the coin is stuck and the log has
//!    to say so in as many words — this is the one case that needs a human.
//!
//! Only then is a request assembled and handed to the [`RefundBroadcaster`].
//!
//! # What is real here and what is not
//!
//! Everything up to the chain submission is real: the load, the guards, the
//! chain-leg selection, the pre-signature extraction, the provenance check, the
//! state transition on success. The submission itself sits behind the
//! [`crate::desk::crypto`] seam, because the transaction builders live in the
//! vendored engine library. Stage A therefore ends in a specific, loud refusal
//! rather than a silent no-op — see [`RefundError`].

use crate::desk::crypto::{self, KeyProvenance, RefundBroadcaster, RefundRequest};
use crate::desk::engine::{ClientRole, DeskSwapState};
use crate::desk::store::{DeskStore, StoreError};
use crate::desk::wire;

#[derive(Debug, thiserror::Error)]
pub enum RefundError {
    #[error("cannot read swap {swap_id} from the store: {source}")]
    Load {
        swap_id: String,
        #[source]
        source: StoreError,
    },
    /// The swap is over. Refusing is the correct behaviour, so this is an error
    /// only in the sense that no refund happened.
    #[error("swap {swap_id} is already in terminal state {state} - refusing to refund")]
    AlreadyTerminal { swap_id: String, state: String },
    #[error("swap {swap_id} has an unrecognized desk role: {source}")]
    Role {
        swap_id: String,
        #[source]
        source: crate::desk::engine::EngineError,
    },
    /// NEEDS A HUMAN: funds are locked and there is no pre-signed way out.
    #[error(
        "swap {swap_id} locked chain {chain} (tx {lock_txid}) but holds NO pre-signed refund - \
         the coin cannot be reclaimed automatically and needs manual recovery"
    )]
    NoPresignedRefund {
        swap_id: String,
        chain: String,
        lock_txid: String,
    },
    #[error("refund broadcast for swap {swap_id} failed: {source}")]
    Broadcast {
        swap_id: String,
        #[source]
        source: crypto::CryptoError,
    },
    /// The refund went out but the record could not be updated. Reported
    /// separately because the money is safe and only the bookkeeping is behind.
    #[error("refund for swap {swap_id} was broadcast as {txid} but the record could not be updated: {source}")]
    Persist {
        swap_id: String,
        txid: String,
        #[source]
        source: StoreError,
    },
}

/// What a refund attempt concluded.
#[derive(Debug, PartialEq)]
pub enum RefundVerdict {
    /// The refund transaction was published. Carries its txid.
    Broadcast(String),
    /// The client never locked its leg, so there is nothing to reclaim. This is
    /// the benign case: T1 passed on a swap that died before it cost anything.
    NothingLocked,
}

/// C40: whether the LEADER's deep abort (B3, the after-T2 swipe) is available.
///
/// A separate, pure decision because every way of getting this wrong is a
/// role-or-timing confusion, and those are exactly what this campaign keeps
/// finding in code that mixes the decision with the action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepAbortDecision {
    /// Try it. The ordinary refund has not worked and T2 has passed.
    Available,
    /// We are the FOLLOWER. B3 is `[after T2, sigAlice]` — Alice-only — so a
    /// follower has no such branch. Its coin comes back by RECLAIM, from the
    /// leader's leaked `s_a`, not by a swipe.
    NotLeader,
    /// T2 has not passed. The branch is invalid until then and the chain would
    /// reject it; attempting early wastes a call and muddies the log.
    TooEarly { seconds_remaining: i64 },
    /// The swap already ended. Nothing to abort.
    AlreadyTerminal,
}

/// Decide whether to deep-abort. `now` and `t2` are unix seconds.
///
/// **Leader-only and after-T2 are both hard.** The desk's `swipe_ada` refuses a
/// non-leader for the same reason, and it is right to: B3 omits the follower's
/// signature entirely, so a follower asking for it is asking for a transaction
/// that cannot validate.
pub fn deep_abort_decision(
    role: ClientRole,
    state: &str,
    now: i64,
    t2: i64,
) -> DeepAbortDecision {
    if DeskSwapState::parse(state).is_terminal() {
        return DeepAbortDecision::AlreadyTerminal;
    }
    // The leader is the party that locks chain A, which is where the script -
    // and therefore B3 - lives.
    if role.client_lock_chain() != "A" {
        return DeepAbortDecision::NotLeader;
    }
    if now < t2 {
        return DeepAbortDecision::TooEarly {
            seconds_remaining: t2 - now,
        };
    }
    DeepAbortDecision::Available
}

/// CC-2: the T2 the deep abort is allowed to run on — the ENGINE's, never the
/// wire's. `rec.t2` is the desk's advertisement; on the 07-30 rung it was
/// 1200s early (D48), and a swipe scheduled off it carries `invalid_before` in
/// the future, is rejected by the node, and reads to a retry loop as "the
/// swipe failed" when the true answer is "not yet".
///
/// `None` is could-not-look: the record predates CC-2 or its accept could read
/// neither the acting engine's slots nor the desk's effective-config. The
/// caller must refuse to arm and say so — falling back to `rec.t2` here would
/// rebuild the exact fault this field exists to prevent.
pub(crate) fn engine_t2_for_deep_abort(rec: &crate::desk::store::StoredSwap) -> Result<i64, String> {
    rec.t2_engine_unix.ok_or_else(|| {
        format!(
            "no engine-derived T2 on the record (t2_engine_unix unset). When we lead it comes \
             from our own engine's slots; when we follow, from AcceptResponse.t2Slot or the \
             desk's effective-config. This record predates CC-2 or its accept could read \
             neither source — refusing to schedule branch B3 off the ADVERTISED t2 ({}), \
             which is the number D48 proved can lie",
            rec.t2
        )
    })
}

/// The decision as the production driver takes it: provenance first, then the
/// pure C40 gate. One function on purpose — the FALSIFY test drives THIS, and
/// its only production caller is a few lines below, so "the decision was
/// handed `rec.t2`" cannot happen without either changing this function (the
/// test goes red) or bypassing the one named seam in the same file (visible in
/// any diff of the call site).
pub(crate) fn deep_abort_decision_for_record(
    rec: &crate::desk::store::StoredSwap,
    role: ClientRole,
    now: i64,
) -> Result<DeepAbortDecision, String> {
    let t2 = engine_t2_for_deep_abort(rec)?;
    if t2 != rec.t2 {
        eprintln!(
            "[desk::refund] swap {}: engine T2 {t2} differs from the advertised t2 {} by {}s — \
             the engine's value decides (CC-2/D48)",
            rec.swap_id,
            rec.t2,
            t2 - rec.t2
        );
    }
    Ok(deep_abort_decision(role, &rec.state, now, t2))
}

/// Run the refund path for one swap.
///
/// The broadcaster is a parameter rather than a global so tests can drive every
/// branch; production callers pass [`crypto::active_refund_broadcaster`].
pub async fn execute_refund(
    store: &DeskStore,
    swap_id: &str,
    broadcaster: &dyn RefundBroadcaster,
) -> Result<RefundVerdict, RefundError> {
    let mut rec = store.load(swap_id).map_err(|source| RefundError::Load {
        swap_id: swap_id.to_string(),
        source,
    })?;

    // (1) Terminal check, before anything else touches a chain. Note this reads
    //     the PERSISTED state: a settlement recorded by any path - the tracker,
    //     a status poll, a previous refund - stops this watcher's late fire.
    let state = DeskSwapState::parse(&rec.state);
    if state.is_terminal() {
        return Err(RefundError::AlreadyTerminal {
            swap_id: swap_id.to_string(),
            state: rec.state.clone(),
        });
    }

    // (2) Which leg is ours, and did we actually lock it? The leader locks chain
    //     A, the follower locks chain B - so the role decides which txid proves
    //     we have funds out there.
    let role =
        ClientRole::from_desk_role(&rec.desk_role).map_err(|source| RefundError::Role {
            swap_id: swap_id.to_string(),
            source,
        })?;
    let chain = role.client_lock_chain();
    let lock_txid = match chain {
        "A" => rec.lock_a_txid.clone(),
        _ => rec.lock_b_txid.clone(),
    };
    let lock_txid = match lock_txid.filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => return Ok(RefundVerdict::NothingLocked),
    };

    // (3) The pre-signature must be complete. Half of one is the same as none -
    //     and is worth its own loud log line, because it means the M3 write was
    //     interrupted.
    let presig = match (
        rec.refund_presig_r_enc.clone(),
        rec.refund_presig_sp.clone(),
    ) {
        (Some(r_enc), Some(sp)) if !r_enc.is_empty() && !sp.is_empty() => {
            wire::AdaptorPresig { r_enc, sp }
        }
        _ => {
            return Err(RefundError::NoPresignedRefund {
                swap_id: swap_id.to_string(),
                chain: chain.to_string(),
                lock_txid,
            })
        }
    };

    let req = RefundRequest {
        swap_id: &rec.swap_id,
        pair: &rec.pair,
        direction: &rec.direction,
        refund_address: &rec.refund_address,
        refund_presig: presig,
        chain,
        lock_txid: &lock_txid,
        // Parsed from the record, NOT from the currently-active provider: a swap
        // accepted under the placeholder provider stays mock forever, even if
        // the app has since been upgraded to a real one.
        provenance: KeyProvenance::parse(&rec.key_provenance),
    };

    let txid = broadcaster
        .broadcast_refund(&req)
        .await
        .map_err(|source| RefundError::Broadcast {
            swap_id: swap_id.to_string(),
            source,
        })?;

    // The money is back. Record it so no later watcher re-fires on this swap.
    //
    // C43: record WHICH transaction did it, not just that something did. This
    // set the state and dropped the txid on the floor, so a live refund printed
    //
    //     refund broadcast, txid a9fa251f...
    //     swap ... is now state=A_REFUNDED refund_txid=<none>
    //
    // — the proof of the refund and the record of it, contradicting each other
    // two lines apart. `StoredSwap` has carried a `refund_txid` field the whole
    // time; nothing ever filled it.
    //
    // `reclaim.rs:256` does exactly this for its own txid, which is what makes
    // it an asymmetry rather than a decision: the two terminal recovery paths
    // are the same shape and only one of them remembered its evidence.
    //
    // It costs nothing while everything works and everything when it does not:
    // the record is what survives a restart, and after one the only answer to
    // "which tx refunded this?" was to go grepping transcripts.
    rec.refund_txid = Some(txid.clone());
    rec.state = "A_REFUNDED".to_string();
    store.save(&rec).map_err(|source| RefundError::Persist {
        swap_id: swap_id.to_string(),
        txid: txid.clone(),
        source,
    })?;

    Ok(RefundVerdict::Broadcast(txid))
}

/// Run the refund path and report the outcome to the log.
///
/// The watcher calls this. It never panics and never propagates, because it runs
/// in a detached task where a propagated error would vanish. Every branch says
/// something specific - "nothing happened" is not an acceptable log line for the
/// step that decides whether the user gets their coin back.
pub async fn execute_refund_and_report(store: &DeskStore, swap_id: &str) {
    match execute_refund(store, swap_id, crypto::active_refund_broadcaster()).await {
        Ok(RefundVerdict::Broadcast(txid)) => {
            eprintln!("[desk::refund] swap {swap_id}: refund broadcast, txid {txid}");
        }
        Ok(RefundVerdict::NothingLocked) => {
            eprintln!(
                "[desk::refund] swap {swap_id}: T1 passed but the client never locked its leg - \
                 no funds at risk, nothing to reclaim"
            );
        }
        Err(e @ RefundError::AlreadyTerminal { .. }) => {
            // Expected whenever a stop flag lost a race with settlement.
            eprintln!("[desk::refund] {e}");
        }
        Err(e @ RefundError::NoPresignedRefund { .. }) => {
            eprintln!("[desk::refund] MANUAL RECOVERY REQUIRED: {e}");
        }
        Err(e) => {
            eprintln!("[desk::refund] swap {swap_id}: refund did NOT go out: {e}");
        }
    }
}

/// C40: the LEADER's deep abort — try the ordinary refund, and only if it will
/// not go out and T2 has passed, take chain A via B3.
///
/// **Cooperative first, always, and that ordering is the whole design.** B2 (the
/// ordinary refund) is signed with an ADAPTOR signature, so publishing it leaks
/// `s_a` and the counterparty reclaims its own leg automatically. B3 is signed
/// with an ORDINARY signature and leaks nothing — we get our coin back and
/// theirs is stranded until they get our key share by hand.
///
/// So the swipe is not a faster refund, it is a worse one that works when the
/// refund does not. Trying it first, or in parallel, would strand a counterparty
/// who had done nothing wrong. It is attempted only after the refund has
/// actually failed.
///
/// And on a failed swipe we go back and re-attempt the refund rather than
/// stopping — mirroring the desk's `leaderDeepAbort`. Doing nothing is the one
/// unacceptable outcome for a coin that is otherwise ours to lose.
///
/// Returns `true` if anything was published.
pub async fn execute_deep_abort_and_report(
    store: &DeskStore,
    swap_id: &str,
    crypto: &crate::desk::crypto::VendoredDeskCrypto,
) -> bool {
    // 1. The cooperative path, first and always.
    match execute_refund(store, swap_id, crypto::active_refund_broadcaster()).await {
        Ok(RefundVerdict::Broadcast(txid)) => {
            eprintln!(
                "[desk::refund] swap {swap_id}: refund broadcast, txid {txid} - `s_a` is now \
                 public and the counterparty can reclaim its own leg. No deep abort needed."
            );
            return true;
        }
        Ok(RefundVerdict::NothingLocked) => {
            eprintln!("[desk::refund] swap {swap_id}: nothing of ours is locked - no deep abort");
            return false;
        }
        Err(e @ RefundError::AlreadyTerminal { .. }) => {
            eprintln!("[desk::refund] {e}");
            return false;
        }
        Err(e) => {
            eprintln!(
                "[desk::refund] swap {swap_id}: the ordinary refund did NOT go out ({e}) - \
                 considering the T2 deep abort"
            );
        }
    }

    // 2. Is the deep abort even ours to take?
    let rec = match store.load(swap_id) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[desk::refund] swap {swap_id}: cannot read the record for a deep abort: {e}");
            return false;
        }
    };
    let role = match ClientRole::from_desk_role(&rec.desk_role) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[desk::refund] swap {swap_id}: cannot determine our role ({e}) - refusing \
                       to deep-abort on a guess");
            return false;
        }
    };
    // CC-2: the decision runs on the ENGINE's T2, through the one named seam. A
    // record that cannot name one gets no deep abort — could-not-look is a
    // refusal with a reason, not a license to use the advertisement that D48
    // proved can lie.
    let decision =
        match deep_abort_decision_for_record(&rec, role, super::watch::unix_now() as i64) {
            Ok(d) => d,
            Err(why) => {
                eprintln!(
                    "[desk::refund] swap {swap_id}: COULD-NOT-LOOK on the engine T2 — {why}. \
                     The deep abort stays UNARMED for this swap; the ordinary refund path is \
                     unaffected."
                );
                return false;
            }
        };
    match decision {
        DeepAbortDecision::Available => {}
        DeepAbortDecision::NotLeader => {
            eprintln!(
                "[desk::refund] swap {swap_id}: our refund is stuck and we are the FOLLOWER, so \
                 there is no swipe for us - B3 is Alice-only. Our chain-B coin comes back by \
                 RECLAIM once the leader publishes its refund and leaks `s_a`. Still watching."
            );
            return false;
        }
        DeepAbortDecision::TooEarly { seconds_remaining } => {
            eprintln!(
                "[desk::refund] swap {swap_id}: refund stuck, but T2 is {seconds_remaining}s away \
                 - the B3 branch is not valid yet and the chain would reject it. Will retry the \
                 refund until then."
            );
            return false;
        }
        DeepAbortDecision::AlreadyTerminal => return false,
    }

    // 3. Take it.
    eprintln!(
        "[desk::refund] swap {swap_id}: DEEP ABORT - the ordinary refund will not go out and T2 \
         has passed, so taking chain A via B3. This leaks NO `s_a`, so the counterparty's leg \
         stays stranded until it gets our key share by hand. Doing this only because the \
         cooperative path already failed."
    );
    match crypto.swipe(swap_id).await {
        Ok(txid) => {
            eprintln!("[desk::refund] swap {swap_id}: SWIPED chain A, txid {txid}");
            // D50, learned from the desk's own log: their swipe printed NOTHING
            // and four days passed with nobody knowing branch B3 had been
            // taken. A terminal transition has to be loud in the log before any
            // notification layer has anything to carry — so the branch is named
            // here, in taxonomy terms, on its own line.
            eprintln!(
                "[desk::refund] swap {swap_id}: TERMINAL TRANSITION — branch B3 (leader-only \
                 swipe after T2) has been TAKEN by us, txid {txid}. No `s_a` was revealed: the \
                 counterparty's chain-B leg stays stranded until it gets our key share by hand."
            );
            true
        }
        Err(e) => {
            // Never stop here. A failed swipe leaves the coin exactly where it
            // was, so the cooperative path is still worth another attempt - and
            // it is the one that also frees the counterparty.
            eprintln!(
                "[desk::refund] swap {swap_id}: the swipe FAILED ({e}) - falling back to another \
                 refund attempt rather than leaving the coin alone"
            );
            matches!(
                execute_refund(store, swap_id, crypto::active_refund_broadcaster()).await,
                Ok(RefundVerdict::Broadcast(_))
            )
        }
    }
}

/// CC-3: whether one swap gets a [`super::watch::SwipeWatcher`], decided
/// PURELY — both spawn paths (the in-session conductor and the cold-restart
/// rehydrate) consume this one function, because C41 was exactly a fix wired
/// into one of those paths and not the other.
#[derive(Debug)]
pub(crate) struct SwipePlan {
    /// `Some(deadline)` — arm a swipe watcher at this absolute unix second
    /// (CC-2's ENGINE value, never the advertisement).
    pub arm_at_unix: Option<u64>,
    /// When NOT arming, the loud line saying so and why. A swap standing down
    /// silently is D50's precondition.
    pub stand_down: Option<String>,
}

pub(crate) fn swipe_plan(rec: &crate::desk::store::StoredSwap) -> SwipePlan {
    let refuse = |why: String| SwipePlan {
        arm_at_unix: None,
        stand_down: Some(why),
    };
    if DeskSwapState::parse(&rec.state).is_terminal() {
        return refuse(format!(
            "[desk::watch] swap {}: no swipe watcher — swap is already terminal ({})",
            rec.swap_id, rec.state
        ));
    }
    let role = match ClientRole::from_desk_role(&rec.desk_role) {
        Ok(r) => r,
        Err(e) => {
            return refuse(format!(
                "[desk::watch] swap {}: no swipe watcher — cannot determine our role ({e}); \
                 refusing to schedule branch B3 on a guess",
                rec.swap_id
            ));
        }
    };
    if role.client_lock_chain() != "A" {
        // The follower's stand-down is CORRECT, not a gap — but it must be
        // said. Same words as the deep abort's NotLeader arm.
        return refuse(format!(
            "[desk::watch] swap {}: no swipe watcher for us — we are the FOLLOWER and branch \
             B3 is Alice-only (leader-only, after T2). Our chain-B coin comes back by RECLAIM \
             once the leader publishes its refund and leaks `s_a`; the reclaim watch covers \
             that.",
            rec.swap_id
        ));
    }
    match rec.t2_engine_unix {
        Some(t2) => SwipePlan {
            arm_at_unix: Some(t2.max(0) as u64),
            stand_down: None,
        },
        None => refuse(format!(
            "[desk::watch] swap {}: COULD-NOT-LOOK — we lead but the record carries no \
             engine-derived T2 (predates CC-2, or its accept could read neither our engine's \
             slots nor the desk's effective-config). NO swipe watcher is armed: a watcher on \
             the ADVERTISED t2 ({}) is worse than none — it fires early, the chain rejects the \
             swipe, and the failure reads as 'the swipe failed' when the true answer is 'not \
             yet' (D48). Branch B3 for this swap needs a manual `deep-abort` after the engine \
             T2.",
            rec.swap_id, rec.t2
        )),
    }
}

/// CC-3: load one swap, decide via [`swipe_plan`], and run the
/// [`super::watch::SwipeWatcher`] to completion. The T2 twin of
/// [`super::reclaim::run_reclaim_watch`] — spawned by the conductor for
/// in-session swaps and by rehydrate on a cold restart, so the T2 schedule
/// survives exactly the restarts the T1 one does.
///
/// Every exit of this function prints a line. The deep abort is the most
/// consequential branch this protocol can take, and D50 is what its silence
/// costs: the desk's swipe logged nothing and four days passed with nobody
/// knowing.
pub async fn run_swipe_watch(
    store: std::sync::Arc<DeskStore>,
    crypto: &'static crate::desk::crypto::VendoredDeskCrypto,
    swap_id: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use super::watch::{unix_now, SwipeOutcome, SwipeWatcher};

    let plan = match store.load(&swap_id) {
        Ok(rec) => swipe_plan(&rec),
        Err(e) => {
            eprintln!(
                "[desk::watch] swap {swap_id}: cannot read the record to arm a swipe watcher \
                 ({e}) — NO T2 schedule exists for this swap"
            );
            return;
        }
    };
    let t2 = match plan.arm_at_unix {
        Some(t2) => t2,
        None => {
            // stand_down is always Some when arm_at_unix is None, but never
            // trust an invariant a refactor could break silently: say
            // SOMETHING either way.
            eprintln!(
                "{}",
                plan.stand_down
                    .unwrap_or_else(|| format!(
                        "[desk::watch] swap {swap_id}: no swipe watcher (unnamed reason — \
                         swipe_plan broke its own contract; report this)"
                    ))
            );
            return;
        }
    };

    let now = unix_now();
    eprintln!(
        "[desk::watch] swap {swap_id}: swipe watcher ARMED — branch B3 becomes legal at the \
         ENGINE's T2 ({t2}, {}s from now). If the swap settles first this stands down; if the \
         refund cannot go out by then, the deep abort runs.",
        t2 as i64 - now as i64
    );

    let store_for_fire = std::sync::Arc::clone(&store);
    let id_for_fire = swap_id.clone();
    let outcome = SwipeWatcher::new(t2)
        .run(stop, unix_now, move || async move {
            eprintln!(
                "[desk::watch] swap {id_for_fire}: ENGINE T2 REACHED — running the deep-abort \
                 driver (cooperative refund B2 first; branch B3 only if it will not go out)."
            );
            refund_driver_at_t2(&store_for_fire, &id_for_fire, crypto).await;
        })
        .await;
    match outcome {
        SwipeOutcome::Fired => eprintln!(
            "[desk::watch] swap {swap_id}: swipe watcher ended — T2 passed and the deep-abort \
             driver ran; its verdict is logged above under [desk::refund]"
        ),
        SwipeOutcome::Stopped => eprintln!(
            "[desk::watch] swap {swap_id}: swipe watcher STOOD DOWN — the swap resolved before \
             the engine's T2; branch B3 was never needed"
        ),
    }
}

/// The single seam the swipe watcher fires through, named so a test can assert
/// the wiring exists. Delegates to [`execute_deep_abort_and_report`].
async fn refund_driver_at_t2(
    store: &DeskStore,
    swap_id: &str,
    crypto: &'static crate::desk::crypto::VendoredDeskCrypto,
) {
    execute_deep_abort_and_report(store, swap_id, crypto).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::crypto::CryptoError;
    use crate::desk::store::StoredSwap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    /// Same unique-temp-dir idiom as `store.rs`'s tests (no `tempfile` dep),
    /// plus a drop guard so a full test run does not leave dirs behind.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let d = std::env::temp_dir().join(format!(
                "pwnda-desk-refund-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Records what it was asked to publish, so the tests can assert on the
    /// ASSEMBLY of the request and not merely that a call happened.
    #[derive(Default)]
    struct SpyBroadcaster {
        seen: Mutex<Vec<(String, String, String, String, KeyProvenance)>>,
        fail: Option<CryptoError>,
    }

    impl RefundBroadcaster for SpyBroadcaster {
        fn broadcast_refund<'a>(
            &'a self,
            req: &'a RefundRequest<'a>,
        ) -> crate::desk::crypto::BroadcastFuture<'a> {
            self.seen.lock().unwrap().push((
                req.swap_id.to_string(),
                req.chain.to_string(),
                req.lock_txid.to_string(),
                req.refund_presig.r_enc.clone(),
                req.provenance,
            ));
            let out = match &self.fail {
                Some(e) => Err(match e {
                    CryptoError::MockMaterialRefused => CryptoError::MockMaterialRefused,
                    other => CryptoError::Unavailable(other.to_string()),
                }),
                None => Ok(format!("refundtx-{}", req.swap_id)),
            };
            Box::pin(async move { out })
        }
    }

    fn store() -> (TempDir, DeskStore) {
        let dir = TempDir::new();
        let s = DeskStore::open_with_key(dir.path(), zeroize::Zeroizing::new([7u8; 32])).unwrap();
        (dir, s)
    }

    /// A locked, refundable swap in which the client FOLLOWS (desk leads), so
    /// the client's own leg is chain B.
    fn locked_follower(swap_id: &str) -> StoredSwap {
        let mut r = StoredSwap {
            leader_proof: false,
            refund_txid: None,
            reclaim_txid: None,
            swap_id: swap_id.into(),
            pair: "XMR/ADA".into(),
            direction: "SELL_FOLLOWER".into(),
            desk_role: "LEADER".into(),
            amount_a: "100".into(),
            amount_b: "1".into(),
            state: "B_LOCKED".into(),
            payout_address: "addr_payout".into(),
            refund_address: "addr_refund".into(),
            script_address: "addr_script".into(),
            chain_a_lock_addr: None,
            chain_b_joint_addr: None,
            chain_b_joint_key: None,
            desk_key_share_point: "aa".repeat(32),
            desk_chain_a_pubkey: "bb".repeat(32),
            adaptor_point: None,
            view_key: None,
            dleq_proof: None,
            client_key_share_point: Some("cc".repeat(32)),
            engine_ref: Some("eng-ref-1".into()),
            refund_presig_r_enc: Some("ee".repeat(32)),
            refund_presig_sp: Some("ff".repeat(32)),
            claim_presig_r_enc: None,
            claim_presig_sp: None,
            lock_a_txid: Some("lockA-desk".into()),
            lock_b_txid: Some("lockB-ours".into()),
            t0: 0,
            t1: 100,
            t2: 200,
            t1_slot: None,
            t2_slot: None,
            t2_engine_slot: None,
            t2_engine_unix: Some(200),
            created_at: 0,
            key_provenance: "vendored".into(),
        };
        r.state = "B_LOCKED".into();
        r
    }

    /// C40: the deep abort is LEADER-ONLY and AFTER-T2, and both are hard.
    ///
    /// Every way of getting this wrong is a role-or-timing confusion, which is
    /// the class this campaign has found most often — so the decision is a pure
    /// function and every branch is pinned, including the ones that must refuse.
    #[test]
    fn the_deep_abort_is_leader_only_and_after_t2_c40() {
        const T2: i64 = 1_000;

        // The follower has no B3 at all: the branch is `[after T2, sigAlice]`,
        // so a follower asking for it is asking for a transaction that cannot
        // validate. Its coin comes back by RECLAIM instead.
        assert_eq!(
            deep_abort_decision(ClientRole::Follower, "B_LOCKED", T2 + 1, T2),
            DeepAbortDecision::NotLeader,
            "a follower must never attempt a swipe, even past T2 - B3 omits its signature entirely"
        );

        // Before T2 the branch is invalid and the chain would reject it.
        assert_eq!(
            deep_abort_decision(ClientRole::Leader, "A_LOCKED", T2 - 30, T2),
            DeepAbortDecision::TooEarly {
                seconds_remaining: 30
            },
            "before T2 the swipe cannot validate; attempting it early wastes a call"
        );

        // Exactly at T2 it becomes available - the boundary is inclusive, and an
        // off-by-one here would silently delay a deep abort by a poll interval.
        assert_eq!(
            deep_abort_decision(ClientRole::Leader, "A_LOCKED", T2, T2),
            DeepAbortDecision::Available
        );
        assert_eq!(
            deep_abort_decision(ClientRole::Leader, "A_LOCKED", T2 + 1, T2),
            DeepAbortDecision::Available
        );

        // A settled swap has nothing to abort, and this is checked FIRST so a
        // terminal leader past T2 can never be talked into a swipe.
        assert_eq!(
            deep_abort_decision(ClientRole::Leader, "SETTLED", T2 + 9_999, T2),
            DeepAbortDecision::AlreadyTerminal,
            "terminal must win over every other condition, or a settled swap could be swiped"
        );
    }

    /// CC-2, the 07-30 shape exactly: the wire advertised T1+600 while both
    /// engines committed T1+1800 (D48). The decision must be fed the ENGINE's
    /// value — this test goes red if the call path is ever pointed back at
    /// `rec.t2`.
    #[test]
    fn the_deep_abort_arms_on_the_engines_t2_not_the_advertisement_cc2() {
        let mut rec = locked_follower("cc2-a");
        rec.desk_role = "FOLLOWER".into(); // the desk follows => WE lead; B3 is ours
        rec.t2 = 600; // the advertisement
        rec.t2_engine_unix = Some(1_800); // what the engines committed

        rec.state = "READY".into();

        // Minute 700, through the PRODUCTION seam: past the advertisement,
        // before the engine's T2 — the exact window a wire-fed swipe would
        // burn. Engine-fed, it waits. This is the assertion that goes red if
        // `deep_abort_decision_for_record` is ever pointed back at `rec.t2`
        // (it would return Available with 0 remaining).
        assert_eq!(
            deep_abort_decision_for_record(&rec, ClientRole::Leader, 700).unwrap(),
            DeepAbortDecision::TooEarly {
                seconds_remaining: 1_100
            },
            "between advertised and engine T2 the swipe is invalid on chain; firing here is \
             the D48 failure reproduced client-side"
        );
        // The counterfactual, pinned so the difference stays visible: fed the
        // ADVERTISEMENT the pure gate would fire in that window. If the two
        // fixture values ever converge, this guard stops the test going vacuous.
        assert_eq!(
            deep_abort_decision(ClientRole::Leader, "READY", 700, rec.t2),
            DeepAbortDecision::Available,
            "fixture no longer separates the two provenances — restore t2 != t2_engine_unix"
        );
        // At the engine's T2 the swipe becomes legal, through the same seam.
        assert_eq!(
            deep_abort_decision_for_record(&rec, ClientRole::Leader, 1_800).unwrap(),
            DeepAbortDecision::Available
        );
    }

    /// CC-2: a record with no engine T2 refuses to arm rather than falling
    /// back — could-not-look, with the sources named.
    #[test]
    fn a_record_without_an_engine_t2_refuses_rather_than_falls_back_cc2() {
        let mut rec = locked_follower("cc2-b");
        rec.t2_engine_unix = None;
        let err = engine_t2_for_deep_abort(&rec).unwrap_err();
        assert!(
            err.contains("AcceptResponse.t2Slot") && err.contains("effective-config"),
            "the refusal must name the sources that could have answered: {err}"
        );
        assert!(
            err.contains("ADVERTISED"),
            "the refusal must say what it is refusing to fall back to: {err}"
        );
    }

    // ── CC-3: swipe_plan — who gets a T2 watcher, decided purely ──

    /// The FALSIFY anchor: a leading client with an engine T2 MUST be planned a
    /// swipe watcher. If the respawn logic stops arming, this goes red for
    /// NO-WATCHER — not for a wrong state.
    #[test]
    fn a_leader_with_an_engine_t2_is_planned_a_swipe_watcher_cc3() {
        let mut rec = locked_follower("cc3-a");
        rec.desk_role = "FOLLOWER".into(); // the desk follows => WE lead
        rec.t2_engine_unix = Some(1_800);
        let plan = swipe_plan(&rec);
        assert_eq!(
            plan.arm_at_unix,
            Some(1_800),
            "NO SWIPE WATCHER would be armed for a leading client that has an engine T2 — \
             this is the schedule CC-3 exists to create"
        );
        assert!(plan.stand_down.is_none());
    }

    /// The deadline the plan hands out is the ENGINE's, never the advertised
    /// `t2` sitting on the same record.
    #[test]
    fn the_planned_deadline_is_the_engines_not_the_advertisement_cc3() {
        let mut rec = locked_follower("cc3-b");
        rec.desk_role = "FOLLOWER".into();
        rec.t2 = 600; // the advertisement (the 07-30 shape)
        rec.t2_engine_unix = Some(1_800);
        assert_eq!(
            swipe_plan(&rec).arm_at_unix,
            Some(1_800),
            "600 here means the planner reads the advertisement — the D48 early fire"
        );
    }

    /// A follower stands DOWN — correctly, but loudly, naming the return path.
    #[test]
    fn a_follower_stands_down_loudly_naming_reclaim_cc3() {
        let rec = locked_follower("cc3-c"); // desk_role LEADER => we follow
        let plan = swipe_plan(&rec);
        assert_eq!(plan.arm_at_unix, None, "a follower has no branch B3");
        let why = plan.stand_down.expect("standing down silently is D50's precondition");
        assert!(why.contains("RECLAIM"), "must name the follower's actual return path: {why}");
        assert!(why.contains("B3"), "must name the branch it is declining: {why}");
    }

    /// A leading client WITHOUT an engine T2 gets no watcher — and the refusal
    /// says could-not-look and refuses the advertisement by name.
    #[test]
    fn a_leader_without_an_engine_t2_stands_down_as_could_not_look_cc3() {
        let mut rec = locked_follower("cc3-d");
        rec.desk_role = "FOLLOWER".into();
        rec.t2_engine_unix = None;
        let plan = swipe_plan(&rec);
        assert_eq!(plan.arm_at_unix, None);
        let why = plan.stand_down.unwrap();
        assert!(why.contains("COULD-NOT-LOOK"), "{why}");
        assert!(
            why.contains("ADVERTISED"),
            "must say why the advertised t2 is not a substitute: {why}"
        );
    }

    /// A terminal swap is never scheduled a swipe.
    #[test]
    fn a_terminal_swap_is_planned_no_swipe_watcher_cc3() {
        let mut rec = locked_follower("cc3-e");
        rec.desk_role = "FOLLOWER".into();
        rec.state = "SETTLED".into();
        rec.t2_engine_unix = Some(1_800);
        let plan = swipe_plan(&rec);
        assert_eq!(plan.arm_at_unix, None, "a settled swap must never be swiped");
        assert!(plan.stand_down.unwrap().contains("terminal"));
    }

    #[tokio::test]
    async fn a_locked_swap_refunds_our_own_leg_and_is_marked_refunded() {
        let (_d, store) = store();
        store.save(&locked_follower("s1")).unwrap();
        let spy = SpyBroadcaster::default();

        let out = execute_refund(&store, "s1", &spy).await.unwrap();
        assert_eq!(out, RefundVerdict::Broadcast("refundtx-s1".into()));

        let seen = spy.seen.lock().unwrap();
        let (id, chain, lock_txid, r_enc, prov) = &seen[0];
        assert_eq!(id, "s1");
        // The client FOLLOWS here, so it reclaims chain B - reclaiming A would
        // be reclaiming the DESK's lock.
        assert_eq!(chain, "B");
        assert_eq!(lock_txid, "lockB-ours");
        assert_eq!(r_enc, &"ee".repeat(32));
        assert_eq!(*prov, KeyProvenance::Vendored);

        // Persisted, so a second watcher cannot fire on the same swap.
        let after = store.load("s1").unwrap();
        assert_eq!(after.state, "A_REFUNDED");
        // C43: and WHICH transaction did it. This assertion is the one that was
        // missing — the state check above passed throughout, which is why a
        // refund could broadcast a txid and record `<none>` without any test
        // noticing. Pattern 1 in a test: it could not go red for the defect.
        assert_eq!(
            after.refund_txid.as_deref(),
            Some("refundtx-s1"),
            "the record must name the transaction that refunded it, not merely that something \
             did - after a restart the record is the only answer to 'which tx was it?'"
        );
    }

    #[tokio::test]
    async fn a_leading_client_reclaims_chain_a_instead() {
        let (_d, store) = store();
        let mut r = locked_follower("s2");
        r.direction = "BUY_FOLLOWER".into();
        r.desk_role = "FOLLOWER".into(); // desk follows => client leads
        store.save(&r).unwrap();

        let spy = SpyBroadcaster::default();
        execute_refund(&store, "s2", &spy).await.unwrap();
        let seen = spy.seen.lock().unwrap();
        assert_eq!(seen[0].1, "A");
        assert_eq!(seen[0].2, "lockA-desk"); // ours, in this direction
    }

    #[tokio::test]
    async fn a_settled_swap_is_never_refunded() {
        let (_d, store) = store();
        let mut r = locked_follower("s3");
        r.state = "SETTLED".into();
        store.save(&r).unwrap();

        let spy = SpyBroadcaster::default();
        let err = execute_refund(&store, "s3", &spy).await.unwrap_err();
        assert!(matches!(err, RefundError::AlreadyTerminal { .. }));
        // The decisive assertion: the broadcaster was never even called.
        assert!(spy.seen.lock().unwrap().is_empty());
        assert_eq!(store.load("s3").unwrap().state, "SETTLED");
    }

    #[tokio::test]
    async fn an_unlocked_swap_reports_nothing_at_risk_rather_than_a_failure() {
        let (_d, store) = store();
        let mut r = locked_follower("s4");
        r.state = "ACCEPTED".into();
        r.lock_b_txid = None; // we never locked
        store.save(&r).unwrap();

        let spy = SpyBroadcaster::default();
        assert_eq!(
            execute_refund(&store, "s4", &spy).await.unwrap(),
            RefundVerdict::NothingLocked
        );
        assert!(spy.seen.lock().unwrap().is_empty());
        // Still not terminal - nothing happened, so nothing is recorded.
        assert_eq!(store.load("s4").unwrap().state, "ACCEPTED");
    }

    #[tokio::test]
    async fn a_locked_swap_with_no_presig_demands_manual_recovery() {
        let (_d, store) = store();
        let mut r = locked_follower("s5");
        r.refund_presig_sp = None; // half a pre-signature is none
        store.save(&r).unwrap();

        let spy = SpyBroadcaster::default();
        match execute_refund(&store, "s5", &spy).await.unwrap_err() {
            RefundError::NoPresignedRefund {
                chain, lock_txid, ..
            } => {
                // The error has to carry enough to act on by hand.
                assert_eq!(chain, "B");
                assert_eq!(lock_txid, "lockB-ours");
            }
            other => panic!("expected NoPresignedRefund, got {other}"),
        }
    }

    #[tokio::test]
    async fn mock_provenance_survives_into_the_request_so_the_broadcaster_can_refuse() {
        let (_d, store) = store();
        let mut r = locked_follower("s6");
        r.key_provenance = "mock".into();
        store.save(&r).unwrap();

        let spy = SpyBroadcaster {
            fail: Some(CryptoError::MockMaterialRefused),
            ..Default::default()
        };
        let err = execute_refund(&store, "s6", &spy).await.unwrap_err();
        assert!(matches!(err, RefundError::Broadcast { .. }));
        assert_eq!(spy.seen.lock().unwrap()[0].4, KeyProvenance::Mock);
        // A refund that did NOT go out must not look like one that did.
        assert_eq!(store.load("s6").unwrap().state, "B_LOCKED");
    }

    #[tokio::test]
    async fn a_record_written_before_provenance_existed_is_treated_as_mock() {
        let (_d, store) = store();
        let mut r = locked_follower("s7");
        r.key_provenance = String::new(); // what #[serde(default)] yields
        store.save(&r).unwrap();

        let spy = SpyBroadcaster::default();
        execute_refund(&store, "s7", &spy).await.unwrap();
        assert_eq!(
            spy.seen.lock().unwrap()[0].4,
            KeyProvenance::Mock,
            "absent provenance must degrade to the refused value, never the trusted one"
        );
    }

    #[tokio::test]
    async fn the_stage_a_broadcaster_leaves_the_swap_untouched() {
        // End-to-end against the REAL active broadcaster: the path runs, the
        // request assembles, and the refusal is what stops it - the record must
        // not be advanced by a refund that never happened.
        let (_d, store) = store();
        store.save(&locked_follower("s8")).unwrap();
        let err =
            execute_refund(&store, "s8", crypto::active_refund_broadcaster()).await.unwrap_err();
        assert!(matches!(err, RefundError::Broadcast { .. }));
        assert_eq!(store.load("s8").unwrap().state, "B_LOCKED");
    }

    #[tokio::test]
    async fn a_missing_record_is_an_error_not_a_silent_return() {
        let (_d, store) = store();
        let spy = SpyBroadcaster::default();
        assert!(matches!(
            execute_refund(&store, "nope", &spy).await.unwrap_err(),
            RefundError::Load { .. }
        ));
    }
}
