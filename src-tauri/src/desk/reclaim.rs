//! Abort-table row 2: the leader refunded chain A, which **leaked `s_a`** — so
//! we reclaim chain B with it.
//!
//! # A refund is a trigger, not a loss
//!
//! The instinct is to treat the counterparty refunding as the swap failing and
//! our coin being gone. It is the opposite. Publishing the chain-A refund
//! *reveals* `s_a` on chain, and `s_a` is exactly what completes our chain-B
//! reclaim. The desk's abort table (round 14, row 2):
//!
//! > B IS locked, then the swap stalls (leader never sets ready) — at T1 the
//! > leader refunds A, which LEAKS `s_a`; you then reclaim B with the leaked
//! > `s_a`. **Both whole.** This is why your watcher must watch for the refund
//! > and arm the reclaim.
//!
//! So a detected refund must *start* work, not stop it. A client that recorded
//! "A_REFUNDED" and stood down would leave its own locked coin sitting in a
//! 2-of-2 it could have swept.
//!
//! # Why a txid we did not choose is safe here — and the M5 gate's is not
//!
//! Everywhere else in this tier the rule is: the desk's word is ADVICE, never a
//! trigger. This path acts on a txid it did not pick, and that is not a
//! contradiction, because of what happens next: the txid goes to
//! `extract_secret`, which **reads the chain and binds the result to the
//! swap's expected adaptor point**. A wrong or hostile txid can only produce a
//! refusal. The sharper form of the rule, which is the one worth keeping:
//!
//! > the desk may choose what we EXAMINE, never what we CONCLUDE.
//!
//! The M5 gate cannot work this way because "chain B is locked" was, at the
//! moment it mattered, a claim about the FUTURE that no chain read could settle.
//! "This txid reveals the secret" is settled by a chain read.
//!
//! **That guarantee did not exist when this argument was first written.** Engine
//! v10's `extract_secret` computed `s - sp`, stored it, and reported success
//! without checking the result was the swap's secret — so any transaction signed
//! by the same vkey yielded `secretHeld: true` and garbage, and a bad txid could
//! have made us act after all. The desk found that (A5) after the claim was
//! stated plainly enough to be checked, and bound the extraction to the expected
//! adaptor point before persisting. The reasoning was right; the guarantee it
//! rested on had to be built. Worth remembering that stating the assumption is
//! what got it verified.
//!
//! # Discovery: this path needs the desk for neither liveness nor safety
//!
//! Engine v11 added `watch_script_spend {swapId} -> {spent, txid, error}`, which
//! detects the spend of the chain-A lock and names the spending transaction. So
//! [`run_reclaim_watch`] finds the refund itself rather than being told about
//! it, and `extract_secret` verifies it independently. A `/status` hint remains
//! usable, but nothing depends on one.

#![allow(dead_code)] // consumed by the rung-3 driver

use super::crypto::{CryptoError, ExtractionOutlook};
use super::engine::ClientRole;
use super::store::{DeskStore, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum ReclaimError {
    #[error("cannot read swap {swap_id} from the store: {source}")]
    Load {
        swap_id: String,
        #[source]
        source: StoreError,
    },
    #[error("swap {swap_id} has an unrecognized desk role: {source}")]
    Role {
        swap_id: String,
        #[source]
        source: super::engine::EngineError,
    },
    /// NEEDS A HUMAN. The secret can never be extracted by this backend, so the
    /// automatic path is over while our coin is still locked.
    #[error(
        "swap {swap_id}: the leader's refund {refund_txid} is on chain but this backend can \
         NEVER extract the revealed secret from it ({reason}). Our chain-B lock cannot be \
         reclaimed automatically and needs manual recovery"
    )]
    SecretUnreachable {
        swap_id: String,
        refund_txid: String,
        reason: String,
    },
    #[error("swap {swap_id}: extracting the secret from refund {refund_txid} failed: {source}")]
    Extract {
        swap_id: String,
        refund_txid: String,
        #[source]
        source: CryptoError,
    },
    #[error("swap {swap_id}: the chain-B reclaim failed: {source}")]
    Broadcast {
        swap_id: String,
        #[source]
        source: CryptoError,
    },
    #[error("swap {swap_id} reclaimed as {txid} but the record could not be updated: {source}")]
    Persist {
        swap_id: String,
        txid: String,
        #[source]
        source: StoreError,
    },
}

/// What a reclaim attempt concluded.
#[derive(Debug, PartialEq)]
pub enum ReclaimVerdict {
    /// Chain B swept back to us. Carries the txid.
    Reclaimed(String),
    /// Nothing of ours is at risk on chain B — we lead, or we never locked it.
    NothingToReclaim,
    /// The refund is on chain but the secret is not readable YET (not indexed,
    /// or a transient read failure). Keep watching; this is the normal state for
    /// the first blocks after a refund lands.
    SecretNotYetReadable { reason: String },
    /// Already done — the record carries a reclaim txid.
    AlreadyReclaimed(String),
    /// The engine bound this txid to the expected adaptor point and it did not
    /// match, so it is NOT the refund. Permanent for this txid, not for the
    /// swap — keep discovering.
    NotTheRefund { txid: String, reason: String },
    /// C38: the counterparty took chain A via the after-T2 **B3 swipe**, so
    /// `s_a` was never published and never will be. **Permanent for the SWAP**,
    /// not just this txid — the discovery loop must stop.
    ///
    /// A verdict rather than an error, deliberately. The loop's job is to find
    /// out what happened to chain A, and it did: this is a successful
    /// determination of a bad outcome, not a failure to determine anything.
    /// Reporting it as `Err` would put it in the same bucket as "the chain was
    /// unreachable", which is the distinction this whole module exists to keep.
    ///
    /// The chain-B coin is not recoverable by us alone from here. It needs the
    /// counterparty to volunteer its key share — which is what the desk's
    /// "mercy" proposal is about, and which is **not built on either side**.
    Swiped { txid: String, reason: String },
}

/// Attempt the chain-B reclaim for one swap, given the leader's refund txid.
///
/// Guards run most-dangerous-first, same discipline as the refund path:
///
/// 1. **Already reclaimed** — re-broadcasting is at best a wasted fee.
/// 2. **Is any coin of ours at risk** — a LEADER has no chain-B lock to reclaim,
///    and a follower that never locked has nothing out there. Both are benign
///    and must not be reported as failures.
/// 3. **Is the secret actually readable** — the chain decides, not the desk.
///
/// Deliberately does NOT require the swap to be in a particular desk state. The
/// desk's state is its opinion; the chain-A refund is a fact, and our chain-B
/// lock is a fact. A swap the desk has written off as FAILED still holds our
/// coin, and this is the path that gets it back.
pub async fn attempt_reclaim(
    store: &DeskStore,
    swap_id: &str,
    refund_txid: &str,
    crypto: &super::crypto::VendoredDeskCrypto,
    restore_height: Option<i64>,
) -> Result<ReclaimVerdict, ReclaimError> {
    let mut rec = store.load(swap_id).map_err(|source| ReclaimError::Load {
        swap_id: swap_id.to_string(),
        source,
    })?;

    // (1) Already done.
    if let Some(t) = rec.reclaim_txid.clone().filter(|t| !t.is_empty()) {
        return Ok(ReclaimVerdict::AlreadyReclaimed(t));
    }

    // (2) Is anything of ours out there? Only a FOLLOWER locks chain B.
    let role = ClientRole::from_desk_role(&rec.desk_role).map_err(|source| ReclaimError::Role {
        swap_id: swap_id.to_string(),
        source,
    })?;
    if role != ClientRole::Follower {
        return Ok(ReclaimVerdict::NothingToReclaim);
    }
    if rec
        .lock_b_txid
        .as_deref()
        .map(str::is_empty)
        .unwrap_or(true)
    {
        return Ok(ReclaimVerdict::NothingToReclaim);
    }

    // (3) Does the refund actually reveal the secret? THE CHAIN ANSWERS THIS,
    //     which is what makes accepting a desk-supplied txid safe.
    let extraction = crypto
        .extract_secret(swap_id, refund_txid)
        .await
        .map_err(|source| ReclaimError::Extract {
            swap_id: swap_id.to_string(),
            refund_txid: refund_txid.to_string(),
            source,
        })?;
    match extraction.outlook() {
        ExtractionOutlook::Held => {}
        ExtractionOutlook::RetryLater => {
            return Ok(ReclaimVerdict::SecretNotYetReadable {
                reason: extraction.reason,
            })
        }
        // Permanent for THIS TXID, not for the swap. The engine bound the
        // extraction to the expected adaptor point and it did not match, so this
        // transaction is not the refund — but another one may be. The response
        // is neither "retry this" nor "give up": keep discovering.
        ExtractionOutlook::WrongTxid => {
            return Ok(ReclaimVerdict::NotTheRefund {
                txid: refund_txid.to_string(),
                reason: extraction.reason,
            })
        }
        ExtractionOutlook::Impossible => {
            return Err(ReclaimError::SecretUnreachable {
                swap_id: swap_id.to_string(),
                refund_txid: refund_txid.to_string(),
                reason: extraction.reason,
            })
        }
        // C38. Terminal for the SWAP, and the loop must stop rather than keep
        // discovering: B3 carries an ordinary signature, not an adaptor one, so
        // there is no later transaction that will reveal `s_a`. Waiting is
        // waiting for something that was never created.
        //
        // Loud on purpose. This is the one verdict that means a coin of ours is
        // gone unless a human negotiates it back.
        ExtractionOutlook::Swiped => {
            eprintln!(
                "[desk::reclaim] swap {swap_id}: CHAIN-A WAS SWIPED (B3, after-T2 deep abort) by \
                 tx {refund_txid}. That branch is signed with an ORDINARY signature and carries no \
                 adaptor component, so `s_a` was never revealed and no amount of watching will \
                 reveal it. STOPPING the reclaim discovery — there is nothing left to discover. \
                 Our chain-B funds cannot be swept without the counterparty volunteering its key \
                 share. This needs a human, not a retry."
            );
            return Ok(ReclaimVerdict::Swiped {
                txid: refund_txid.to_string(),
                reason: extraction.reason,
            });
        }
    }

    let txid = crypto
        .reclaim(swap_id, restore_height)
        .await
        .map_err(|source| ReclaimError::Broadcast {
            swap_id: swap_id.to_string(),
            source,
        })?;

    // Record it so no later watcher re-fires. The state moves to A_REFUNDED
    // because that IS what happened on chain A — our coin came back on B, which
    // the reclaim txid records. Both sides whole, which is the point.
    rec.reclaim_txid = Some(txid.clone());
    rec.state = "A_REFUNDED".to_string();
    store.save(&rec).map_err(|source| ReclaimError::Persist {
        swap_id: swap_id.to_string(),
        txid: txid.clone(),
        source,
    })?;
    Ok(ReclaimVerdict::Reclaimed(txid))
}

/// What a chain-A spend **is**, decided from the chain alone.
///
/// C45. This is the observation half of [`attempt_reclaim`], split out so it can
/// run where the action half must not.
///
/// **Note what this function is not given.** No [`DeskStore`], no record, no role,
/// no `lock_b_txid`. That is the point and it is enforced by the signature rather
/// than by a comment: "is this spend a claim, a refund, or a B3 swipe?" is a
/// question about a published transaction, and it cannot be made to depend on our
/// bookkeeping because our bookkeeping is not in scope.
///
/// `attempt_reclaim` declines before step (3) when we are not the follower or when
/// `lock_b_txid` is empty. Both are correct **for sweeping** — with nothing of ours
/// locked there is nothing to sweep. Neither is correct for *classifying*, and the
/// two were fused only because they lived in one function. That is the second shape
/// the protocol names: a precondition copied from a neighbouring operation is not a
/// precondition, it is an assumption about which operation you are running.
///
/// Read-only: `extract_secret` submits nothing. It reads a witness that is already
/// on chain and reports whether `s_a` is in it.
pub async fn inspect_spend(
    swap_id: &str,
    txid: &str,
    crypto: &super::crypto::VendoredDeskCrypto,
) -> Result<SpendReport, ReclaimError> {
    let extraction =
        crypto
            .extract_secret(swap_id, txid)
            .await
            .map_err(|source| ReclaimError::Extract {
                swap_id: swap_id.to_string(),
                refund_txid: txid.to_string(),
                source,
            })?;
    Ok(SpendReport {
        txid: txid.to_string(),
        outlook: extraction.outlook(),
        reason: extraction.reason,
    })
}

/// The verdict of [`inspect_spend`]: what the chain says, before anyone asks what
/// we should do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendReport {
    pub txid: String,
    pub outlook: ExtractionOutlook,
    pub reason: String,
}

/// [`inspect_spend`], reported by name. Used by the reclaim entry's DRY RUN, where
/// the whole value is learning what the armed run would conclude without arming it.
pub async fn inspect_spend_and_report(
    swap_id: &str,
    txid: &str,
    crypto: &super::crypto::VendoredDeskCrypto,
) {
    match inspect_spend(swap_id, txid, crypto).await {
        Err(e) => eprintln!(
            "[desk::reclaim] swap {swap_id}: could NOT read tx {txid} from the chain ({e}) - this \
             is 'could not look', NOT 'not a swipe'"
        ),
        Ok(r) => match r.outlook {
            ExtractionOutlook::Held => eprintln!(
                "[desk::reclaim] swap {swap_id}: tx {} carries `s_a` - it is the leader's REFUND \
                 (branch B2). An armed reclaim would sweep chain B off it.",
                r.txid
            ),
            // Chain facts only. This report deliberately does not know our holdings
            // (that is C45's point), so it must not predict what an ARMED run would
            // print — with chain B locked that is MANUAL RECOVERY REQUIRED; with
            // chain B never locked (the SWIPE-DESK rung) it is NothingToReclaim,
            // because the sweep declines on holdings before it ever classifies.
            ExtractionOutlook::Swiped => eprintln!(
                "[desk::reclaim] swap {swap_id}: tx {} is a SWIPE (branch B3, leader-only, after \
                 T2). It carries an ordinary signature, so `s_a` was never published and no retry \
                 will find it. If anything of ours is locked on chain B, recovering it needs the \
                 counterparty's key share (MANUAL RECOVERY); if nothing is, this verdict is the \
                 chain fact and there is nothing to recover.",
                r.txid
            ),
            ExtractionOutlook::WrongTxid => eprintln!(
                "[desk::reclaim] swap {swap_id}: tx {} is not this swap's refund ({}) - permanent \
                 for that txid, not for the swap",
                r.txid, r.reason
            ),
            ExtractionOutlook::RetryLater => eprintln!(
                "[desk::reclaim] swap {swap_id}: tx {} is on chain but not readable yet ({}) - an \
                 armed reclaim would retry",
                r.txid, r.reason
            ),
            ExtractionOutlook::Impossible => eprintln!(
                "[desk::reclaim] swap {swap_id}: tx {} CANNOT be read on this configuration ({}) - \
                 a config fault on our side, not a verdict about the chain",
                r.txid, r.reason
            ),
        },
    }
}

/// Discover the leader's refund ourselves and reclaim off it.
///
/// This is the loop that makes abort-table row 2 independent of the desk for
/// **liveness as well as safety** (engine v11 closed the discovery half with
/// `watch_script_spend`). It polls our own view of the chain-A script address;
/// when the lock is spent it hands the spending txid to [`attempt_reclaim`],
/// which verifies it against the chain before anything moves.
///
/// Notes on each outcome, because the differences are the whole point:
///
/// - **`CouldNotLook`** is logged and retried, never treated as "not spent".
///   Read as "not spent" it would silence the discovery at exactly the moment
///   the chain access we need has failed.
/// - **`NotTheRefund`** does not stop the loop. The spend could be a claim or a
///   swipe rather than a refund, and a later transaction may still be the one —
///   permanent for a txid is not permanent for a swap. It IS remembered, so the
///   same txid is not re-examined every tick.
/// - **`SecretNotYetReadable`** keeps the same txid and retries; the refund is
///   real but not yet indexed.
///
/// Runs until `stop` is raised or the reclaim succeeds. Errors do not end it
/// except the one that genuinely cannot be retried.
pub async fn run_reclaim_watch(
    store: std::sync::Arc<super::store::DeskStore>,
    crypto: &'static super::crypto::VendoredDeskCrypto,
    swap_id: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    interval: std::time::Duration,
) {
    use std::sync::atomic::Ordering;
    use super::crypto::SpendSighting;

    let interval = if interval.is_zero() {
        super::observer::POLL_INTERVAL
    } else {
        interval
    };
    // Txids already shown not to be the refund. Without this the same wrong
    // spend is re-examined every tick forever, which is both noise and a
    // pointless chain read on a shared rate-limit bucket.
    let mut ruled_out: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Dedupe state for the repetitive "cannot see" log below. The common cause is
    // the engine's watch_script_spend reporting spent-without-txid before any real
    // chain-A spend exists, which otherwise floods the console every poll and buries
    // the rest of the drive. Collapse identical reasons into ONE line, with a
    // heartbeat every 40 repeats (~10 min at the default cadence) so a long blind
    // stretch is still visible.
    let mut last_blind: Option<String> = None;
    let mut blind_repeat: u64 = 0;

    while !stop.load(Ordering::SeqCst) {
        match crypto.watch_script_spend(&swap_id).await {
            Ok(SpendSighting::Spent { txid }) if !ruled_out.contains(&txid) => {
                // No explicit height: a swap driven live in THIS process recorded
                // `xmr_restore_height` when it watched chain B, so the engine finds
                // it. Only swaps predating that field need one passed in, and those
                // are reached through the CLI entry, not this watcher.
                match attempt_reclaim(&store, &swap_id, &txid, crypto, None).await {
                    Ok(ReclaimVerdict::Reclaimed(t)) => {
                        eprintln!(
                            "[desk::reclaim] swap {swap_id}: chain B reclaimed from the leader's                              leaked secret, txid {t} - both sides whole"
                        );
                        return;
                    }
                    Ok(ReclaimVerdict::AlreadyReclaimed(t)) => {
                        eprintln!("[desk::reclaim] swap {swap_id}: already reclaimed as {t}");
                        return;
                    }
                    Ok(ReclaimVerdict::NothingToReclaim) => {
                        eprintln!(
                            "[desk::reclaim] swap {swap_id}: the chain-A lock was spent but we \
                             have nothing locked on chain B - nothing to reclaim"
                        );
                        return;
                    }
                    // C38: no longer says "a claim or a swipe". A swipe cannot
                    // reach here — B3 carries no follower witness, so the engine
                    // classifies it before any scalar is extracted and it lands in
                    // the `Swiped` arm below. This branch is reached by a CLAIM,
                    // which does carry our vkey, so a scalar IS extracted and the
                    // A5 point check is what rejects it. Naming both was reasoning
                    // about a case this arm never sees.
                    Ok(ReclaimVerdict::NotTheRefund { txid, reason }) => {
                        eprintln!(
                            "[desk::reclaim] swap {swap_id}: tx {txid} spent the lock but does \
                             not carry our secret ({reason}) - a claim, not the refund. Still \
                             watching"
                        );
                        ruled_out.insert(txid);
                    }
                    // C38: terminal for the SWAP. Return rather than keep
                    // watching — B3 is an ordinary signature with no adaptor
                    // component, so there is no later transaction that reveals
                    // `s_a`. Continuing to watch would be the defect this fixes.
                    Ok(ReclaimVerdict::Swiped { txid, reason }) => {
                        eprintln!(
                            "[desk::reclaim] MANUAL RECOVERY REQUIRED: swap {swap_id}: the \
                             counterparty SWIPED chain A via the after-T2 deep abort ({txid}). \
                             `s_a` was never published and never will be ({reason}). Our chain-B \
                             funds need the counterparty's key share to move - stopping the watch, \
                             because there is nothing left to watch for."
                        );
                        return;
                    }
                    Ok(ReclaimVerdict::SecretNotYetReadable { reason }) => eprintln!(
                        "[desk::reclaim] swap {swap_id}: refund seen, secret not readable yet \
                         ({reason}) - retrying"
                    ),
                    Err(e @ ReclaimError::SecretUnreachable { .. }) => {
                        eprintln!("[desk::reclaim] MANUAL RECOVERY REQUIRED: {e}");
                        return;
                    }
                    Err(e) => eprintln!(
                        "[desk::reclaim] swap {swap_id}: reclaim attempt failed ({e}) - retrying"
                    ),
                }
            }
            Ok(SpendSighting::Spent { .. }) | Ok(SpendSighting::NotSpent) => {}
            // NOT "not spent". Our visibility failed, which is worth saying - but
            // ONCE per distinct reason, not every poll (see the dedupe state above).
            Ok(SpendSighting::CouldNotLook { error }) => {
                let same = last_blind.as_deref() == Some(error.as_str());
                if same && blind_repeat < 40 {
                    blind_repeat += 1;
                } else {
                    let tail = if same {
                        format!(" (repeated x{})", blind_repeat + 1)
                    } else {
                        String::new()
                    };
                    eprintln!(
                        "[desk::reclaim] swap {swap_id}: cannot see whether the chain-A lock was \
                         spent ({error}) - this is OUR visibility, not evidence the leader has not \
                         refunded{tail}"
                    );
                    last_blind = Some(error);
                    blind_repeat = 0;
                }
            }
            Err(e) => eprintln!(
                "[desk::reclaim] swap {swap_id}: watch_script_spend did not answer ({e}) -                  retrying"
            ),
        }
        tokio::time::sleep(interval).await;
    }
    eprintln!("[desk::reclaim] swap {swap_id}: reclaim watch stopped");
}

/// Run the reclaim and report. Never panics, never propagates — like the refund
/// path, it runs detached where a propagated error would vanish. Every branch
/// says something specific.
pub async fn attempt_reclaim_and_report(
    store: &DeskStore,
    swap_id: &str,
    refund_txid: &str,
    crypto: &super::crypto::VendoredDeskCrypto,
    restore_height: Option<i64>,
) {
    match attempt_reclaim(store, swap_id, refund_txid, crypto, restore_height).await {
        Ok(ReclaimVerdict::Reclaimed(txid)) => eprintln!(
            "[desk::reclaim] swap {swap_id}: chain B reclaimed from the leader's leaked secret, \
             txid {txid} - both sides whole"
        ),
        Ok(ReclaimVerdict::AlreadyReclaimed(txid)) => {
            eprintln!("[desk::reclaim] swap {swap_id}: already reclaimed as {txid}")
        }
        Ok(ReclaimVerdict::NotTheRefund { txid, reason }) => eprintln!(
            "[desk::reclaim] swap {swap_id}: tx {txid} does not carry our secret ({reason}) - \
             not the refund. Permanent for THAT txid, not for the swap: keep discovering"
        ),
        Ok(ReclaimVerdict::NothingToReclaim) => eprintln!(
            "[desk::reclaim] swap {swap_id}: nothing of ours is locked on chain B - no reclaim \
             needed"
        ),
        Ok(ReclaimVerdict::SecretNotYetReadable { reason }) => eprintln!(
            "[desk::reclaim] swap {swap_id}: the refund is on chain but the secret is not \
             readable yet ({reason}) - will retry"
        ),
        // C38. Note the contrast with the line above: that one WILL retry, this
        // one must not. Both describe a secret we do not have; only one of them
        // describes a secret that exists.
        Ok(ReclaimVerdict::Swiped { txid, reason }) => eprintln!(
            "[desk::reclaim] MANUAL RECOVERY REQUIRED: swap {swap_id}: chain A was SWIPED via the \
             after-T2 deep abort ({txid}) - `s_a` was never published and no retry will find it \
             ({reason}). Our chain-B coin needs the counterparty's key share."
        ),
        Err(e @ ReclaimError::SecretUnreachable { .. }) => {
            eprintln!("[desk::reclaim] MANUAL RECOVERY REQUIRED: {e}")
        }
        Err(e) => eprintln!("[desk::reclaim] swap {swap_id}: reclaim did NOT happen: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::crypto::{SecretExtraction, SpendSighting};

    /// The classification that decides between "keep trying" and "wake a human".
    /// Getting `unsupported-backend` wrong in either direction is expensive: as
    /// retryable it is an infinite loop, as permanent it abandons a coin that a
    /// later poll would have recovered.
    #[test]
    fn extraction_reasons_classify_into_the_three_outlooks() {
        let held = SecretExtraction {
            secret_held: true,
            reason: String::new(),
        };
        assert_eq!(held.outlook(), ExtractionOutlook::Held);

        let not_indexed = SecretExtraction {
            secret_held: false,
            reason: "not-indexed".into(),
        };
        assert_eq!(not_indexed.outlook(), ExtractionOutlook::RetryLater);

        let transient = SecretExtraction {
            secret_held: false,
            reason: "error: connection reset".into(),
        };
        assert_eq!(transient.outlook(), ExtractionOutlook::RetryLater);

        let never = SecretExtraction {
            secret_held: false,
            reason: "unsupported-backend (ogmios dev preset)".into(),
        };
        assert_eq!(never.outlook(), ExtractionOutlook::Impossible);
    }

    /// C45. The reason `inspect_spend` exists: the classifier used to sit behind
    /// the sweep's preconditions, so the one rung that produces a real branch-B3
    /// witness (SWIPE-DESK — we deliberately never lock chain B) could not reach
    /// it. Armed or not, `attempt_reclaim` returns `NothingToReclaim` at step (2)
    /// and never asks the chain anything.
    ///
    /// This test pins the ASYMMETRY, not the happy path: the sweep is gated on our
    /// holdings and the inspection is not. The inspection half is proved by its
    /// signature — `inspect_spend` takes no store, no record and no role, so it
    /// cannot regain the gate without a compile error, which is a stronger
    /// guarantee than any assertion here.
    #[test]
    fn inspection_is_not_gated_on_holding_a_chain_b_lock_c45() {
        // A SWIPE-DESK record: the desk led, we accepted, and we stopped before
        // locking chain B. This is exactly the shape the rung produces.
        let follower_no_lock_b = ("LEADER", None::<&str>);
        let (desk_role, lock_b) = follower_no_lock_b;
        assert_eq!(
            ClientRole::from_desk_role(desk_role).unwrap(),
            ClientRole::Follower,
            "desk LEADER means we follow — the role the swipe rung runs as"
        );
        assert!(
            lock_b.map(str::is_empty).unwrap_or(true),
            "the rung's whole point is that chain B is never locked"
        );

        // `attempt_reclaim` step (2) declines on precisely this input. Correct for
        // sweeping: there is nothing of ours out there to sweep.
        //
        // And that is why the classifier had to move. Leaving it downstream of
        // this gate means the detection D37/C38 built can never be run against a
        // genuine branch-B3 spend — only against the string constant C39 pins.
        let sweep_would_decline = lock_b.map(str::is_empty).unwrap_or(true);
        assert!(sweep_would_decline);

        // The inspection reaches the discriminator regardless, because it is
        // never told any of the above. Documented here; enforced by the signature.
        let swiped = SecretExtraction {
            secret_held: false,
            reason: "SWIPED (B3 after-T2 deep abort): leader vkey present, follower vkey absent"
                .into(),
        };
        assert_eq!(swiped.outlook(), ExtractionOutlook::Swiped);
    }

    /// C38 / desk D37: a B3 swipe must classify as `Swiped`, not `RetryLater`.
    ///
    /// The reason text is the engine's own, built from
    /// `desk_engine.py:88 SWIPE_MARKER = "SWIPED (B3"`. If the engine reworded it
    /// past our match, this arm stops firing and the fallthrough sends us back to
    /// polling forever over a coin that is gone — which is the entire defect.
    ///
    /// It is deliberately NOT `Impossible`. Both mean "stop retrying", and they
    /// send different humans to different places: `Impossible` is our own config
    /// (fix the deployment), `Swiped` is a fact on the chain (the counterparty
    /// deep-aborted). Asserting the inequality is what stops a later tidy-up from
    /// folding the two together.
    #[test]
    fn a_b3_swipe_is_permanent_for_the_swap_not_retryable_c38() {
        let swiped = SecretExtraction {
            secret_held: false,
            reason: "chain-A lock was SWIPED (B3, leader-only witness): the counterparty spent \
                     the lock via the after-T2 deep-abort branch, which is signed with an \
                     ORDINARY signature and carries no adaptor component, so s_a was never \
                     revealed and no amount of waiting will reveal it. The chain-B funds cannot \
                     be reclaimed without the counterparty volunteering its key share - permanent"
                .into(),
        };
        assert_eq!(
            swiped.outlook(),
            ExtractionOutlook::Swiped,
            "a B3 swipe must be recognised; falling through to RetryLater means polling forever \
             for an s_a that was never published"
        );
        assert_ne!(
            swiped.outlook(),
            ExtractionOutlook::RetryLater,
            "this is the defect itself (desk D37) — the safe default for an UNKNOWN reason is the \
             wrong answer for a KNOWN terminal one"
        );
        assert_ne!(
            swiped.outlook(),
            ExtractionOutlook::Impossible,
            "Impossible is a config fault on our side; Swiped is a protocol outcome on the chain. \
             Folding them together sends someone to check their engine config over a coin that is \
             gone"
        );

        // The marker alone is what the contract pins, so a reworded surrounding
        // sentence must still classify.
        let terse = SecretExtraction {
            secret_held: false,
            reason: "SWIPED (B3) — nothing to wait for".into(),
        };
        assert_eq!(terse.outlook(), ExtractionOutlook::Swiped);
    }

    /// C39: the cross-language pin. Reads the ENGINE'S OWN SOURCE and fails if
    /// the marker our matcher greps for is no longer the marker the engine emits.
    ///
    /// The desk asked for this and the reasoning is exact: a Rust test that feeds
    /// the marker in by hand **only proves the matcher matches itself**. The
    /// literal is a contract across a language boundary — Python writes it, Rust
    /// greps it — and nothing in a `cargo build` can otherwise notice the Python
    /// side rewording it. The desk pins the same string from Go with
    /// `TestSwipeMarkerMatchesTheEngineLiteral`; this is our end of it.
    ///
    /// `include_str!` on purpose, exactly as the ready-ack fixtures do: the
    /// vendored engine is tracked, so if it is ever missing the build fails
    /// loudly rather than silently testing a stale copy of the string.
    ///
    /// If this goes red, DO NOT edit the literal here to match. Check whether the
    /// engine's rewording also broke the desk's Go matcher — the two must move
    /// together or one side starts classifying a swipe as retryable again, which
    /// is C38.
    #[test]
    fn our_swipe_marker_is_still_the_engines_c39() {
        const ENGINE_SRC: &str =
            include_str!("../../../pwnda-engine-handoff/engine/desk_engine.py");
        const OUR_MARKER: &str = "SWIPED (B3";

        assert!(
            ENGINE_SRC.contains(&format!("SWIPE_MARKER = \"{OUR_MARKER}\"")),
            "the engine no longer defines SWIPE_MARKER as {OUR_MARKER:?}. Our outlook() greps for \
             that literal, so a swipe would fall through to RetryLater and we would poll forever \
             over a coin that is gone (C38). Do not just edit the Rust literal — check the desk's \
             Go matcher moved too, or the two sides now disagree about what a swipe looks like."
        );

        // And the reason the engine builds from it must actually contain it —
        // the marker being *defined* is not the same as it reaching the wire.
        assert!(
            ENGINE_SRC.contains("SWIPE_REASON = (") && ENGINE_SRC.contains("+ SWIPE_MARKER +"),
            "SWIPE_REASON no longer interpolates SWIPE_MARKER, so the constant could be correct \
             while the string we actually receive is not"
        );
    }

    /// An unrecognized reason must be retryable, not permanent. A new reason
    /// string the desk adds later must not silently abandon a locked coin.
    #[test]
    fn an_unrecognized_reason_is_retryable_not_fatal() {
        let odd = SecretExtraction {
            secret_held: false,
            reason: "something-new-the-desk-added".into(),
        };
        assert_eq!(odd.outlook(), ExtractionOutlook::RetryLater);
    }

    /// `secretHeld: true` wins regardless of what `reason` says — the engine
    /// holding the scalar is the fact; the reason is commentary.
    #[test]
    fn secret_held_beats_any_reason_string() {
        let held = SecretExtraction {
            secret_held: true,
            reason: "unsupported-backend".into(),
        };
        assert_eq!(held.outlook(), ExtractionOutlook::Held);
    }

    /// The A5 refusal (engine v11). It is permanent for THAT TXID and not for
    /// the swap, which is a third thing — neither "retry this" nor "give up".
    /// Collapsing it into `Impossible` would abandon a coin whose real refund
    /// simply had not been found yet.
    #[test]
    fn a_wrong_txid_is_permanent_for_the_txid_and_not_for_the_swap() {
        let wrong = SecretExtraction {
            secret_held: false,
            reason: "does not carry the swap's secret (wrong or hostile txid) - permanent".into(),
        };
        assert_eq!(wrong.outlook(), ExtractionOutlook::WrongTxid);
        assert_ne!(
            wrong.outlook(),
            ExtractionOutlook::Impossible,
            "a wrong txid must not end the search - another tx may be the refund"
        );
        assert_ne!(
            wrong.outlook(),
            ExtractionOutlook::RetryLater,
            "and re-examining the SAME txid is futile"
        );
    }

    // ── watch_script_spend, the discovery half ────────────────────────────

    fn spend(v: serde_json::Value) -> SpendSighting {
        SpendSighting::from_engine(&v)
    }

    #[test]
    fn a_spend_carries_the_txid_to_hand_to_extract_secret() {
        assert_eq!(
            spend(serde_json::json!({ "spent": true, "txid": "ab12", "error": "" })),
            SpendSighting::Spent { txid: "ab12".into() }
        );
    }

    #[test]
    fn an_unspent_lock_is_not_spent() {
        assert_eq!(
            spend(serde_json::json!({ "spent": false, "txid": "", "error": "" })),
            SpendSighting::NotSpent
        );
    }

    /// The same three-state rule as the lock watcher, and the same reason: read
    /// as "not spent", an outage would silence the discovery at exactly the
    /// moment our chain access has failed.
    #[test]
    fn an_unreadable_chain_is_could_not_look_not_not_spent() {
        match spend(serde_json::json!({ "spent": false, "error": "backend timeout" })) {
            SpendSighting::CouldNotLook { error } => assert!(error.contains("backend timeout")),
            other => panic!("an outage must not read as 'the leader has not refunded': {other:?}"),
        }
    }

    /// `spent: true` with no txid is useless — there is nothing to hand to
    /// `extract_secret` — so it must not be reported as a spend we can act on.
    #[test]
    fn a_spend_without_a_txid_is_not_actionable() {
        match spend(serde_json::json!({ "spent": true, "txid": "", "error": "" })) {
            SpendSighting::CouldNotLook { error } => assert!(error.contains("named no spending tx")),
            other => panic!("expected could-not-look, got {other:?}"),
        }
    }
}

/// CC-5: what the desk's `swipeTxid` and OUR OWN witness read say, together.
#[derive(Debug, Clone, PartialEq)]
pub enum SwipeCrossCheck {
    /// Both say swipe, and about the same transaction.
    Agree { txid: String },
    /// The desk published no `swipeTxid` and our witness did not classify a
    /// swipe either. The ordinary case, and not evidence of anything.
    BothSilent,
    /// The desk named a swipe we have not classified yet. NOT a fault: their
    /// field is a hint that arrives before our chain read does, and using it to
    /// look sooner is the whole point of adopting it.
    DeskAheadOfUs { txid: String },
    /// **A desk fault, and loud.** The two surfaces disagree about a chain
    /// fact. Whichever is wrong, nobody should be acting on either until it is
    /// resolved, and the resolution is not "prefer one".
    Disagree { desk_says: String, we_say: String },
}

/// Compare the desk's claim against our own witness classification.
///
/// **The chain read is the verdict; this never overrides it.** `swipeTxid` is
/// adopted as a CROSS-CHECK: it can tell us to look sooner, and it can tell us
/// the desk believes something we can disprove. It cannot tell us what
/// happened. If the desk says swipe and the witness says refund, that is a desk
/// fault worth a loud error - not a tie to break by preference.
///
/// `witness_swiped` is the outcome of reading the chain-A spend ourselves:
/// `Some(true)` when the discriminator says branch B3 (one vkey witness),
/// `Some(false)` when it says a cooperative branch, `None` when we have not
/// looked or could not - and could-not-look is never a negative claim, so it
/// can only ever produce `DeskAheadOfUs`, never `Disagree`.
pub fn cross_check_swipe(
    desk_swipe_txid: &str,
    witness_swiped: Option<bool>,
    witness_txid: &str,
) -> SwipeCrossCheck {
    let desk = desk_swipe_txid.trim();
    match (desk.is_empty(), witness_swiped) {
        (true, Some(true)) => SwipeCrossCheck::Disagree {
            desk_says: "no swipe (field absent)".to_string(),
            we_say: format!("branch B3 swipe in {witness_txid}"),
        },
        (true, _) => SwipeCrossCheck::BothSilent,
        (false, Some(true)) => SwipeCrossCheck::Agree {
            txid: desk.to_string(),
        },
        (false, Some(false)) => SwipeCrossCheck::Disagree {
            desk_says: format!("branch B3 swipe in {desk}"),
            we_say: format!("a cooperative branch in {witness_txid}"),
        },
        // We have not looked, or could not. Their field is a hint to look now.
        (false, None) => SwipeCrossCheck::DeskAheadOfUs {
            txid: desk.to_string(),
        },
    }
}

impl SwipeCrossCheck {
    /// Report it. A disagreement is printed as a DESK FAULT in as many words,
    /// because the alternative - a quiet preference for one surface - is how a
    /// wrong terminal verdict reaches an operator looking confident.
    pub fn report(&self, swap_id: &str) {
        match self {
            SwipeCrossCheck::Agree { txid } => eprintln!(
                "[desk::reclaim] swap {swap_id}: cross-check AGREES - the desk's swipeTxid and our                  own witness read both say branch B3 in {txid}"
            ),
            SwipeCrossCheck::BothSilent => {}
            SwipeCrossCheck::DeskAheadOfUs { txid } => eprintln!(
                "[desk::reclaim] swap {swap_id}: the desk published swipeTxid {txid} and we have                  not classified it yet. That is a HINT to look now, not a verdict - the chain read                  is still what decides."
            ),
            SwipeCrossCheck::Disagree { desk_says, we_say } => eprintln!(
                "[desk::reclaim] swap {swap_id}: DESK FAULT - swipeTxid and our own witness read                  DISAGREE about a chain fact. The desk says {desk_says}; we read {we_say}. Our                  chain read is the source of truth and we are NOT preferring theirs, but one of                  these two surfaces is wrong and neither should be acted on until it is resolved.                  Relay this line verbatim."
            ),
        }
    }
}

#[cfg(test)]
mod cc5_tests {
    use super::*;

    /// FALSIFY (the desk's): a status carrying `swipeTxid` alongside a witness
    /// showing a cooperative branch must raise a DISAGREEMENT, not silently
    /// prefer one surface.
    #[test]
    fn desk_says_swipe_and_the_witness_says_refund_is_a_disagreement_cc5() {
        match cross_check_swipe("c5c285d4", Some(false), "a9fa251f") {
            SwipeCrossCheck::Disagree { desk_says, we_say } => {
                assert!(desk_says.contains("c5c285d4"), "{desk_says}");
                assert!(we_say.contains("cooperative"), "{we_say}");
            }
            other => panic!("a contradiction about a chain fact resolved to {other:?}"),
        }
        // ...and the mirror: we classified a swipe the desk never published.
        assert!(matches!(
            cross_check_swipe("", Some(true), "c5c285d4"),
            SwipeCrossCheck::Disagree { .. }
        ));
    }

    /// Agreement is agreement, and the ordinary silence is not a finding.
    #[test]
    fn agreement_and_silence_are_both_quiet_cc5() {
        assert_eq!(
            cross_check_swipe("c5c285d4", Some(true), "c5c285d4"),
            SwipeCrossCheck::Agree { txid: "c5c285d4".into() }
        );
        assert_eq!(cross_check_swipe("", Some(false), "a9fa251f"), SwipeCrossCheck::BothSilent);
        assert_eq!(cross_check_swipe("", None, ""), SwipeCrossCheck::BothSilent);
    }

    /// COULD-NOT-LOOK is never a negative claim. Having not read the chain, we
    /// cannot contradict the desk - their field is a hint to look sooner, which
    /// is the entire reason to adopt it.
    #[test]
    fn not_having_looked_can_never_produce_a_disagreement_cc5() {
        assert_eq!(
            cross_check_swipe("c5c285d4", None, ""),
            SwipeCrossCheck::DeskAheadOfUs { txid: "c5c285d4".into() }
        );
        // Whitespace is not a txid.
        assert_eq!(cross_check_swipe("   ", None, ""), SwipeCrossCheck::BothSilent);
    }
}
