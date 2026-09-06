//! The rung-3 conductor: [`run_swap_choreography`] — the ONE function that
//! sequences a funded swap by calling the already-built, already-tested
//! components in the order the safety spine requires.
//!
//! # Shared function, two callers (the operator's build order)
//!
//! There is exactly one implementation of the choreography, with two entry
//! points into it:
//!
//! - [`run_swap_choreography`] driven by a CLI / integration-test entry point
//!   (the `#[ignore]` `cli_funded_sell_follower` below) — proves the funded
//!   client→desk swap over I2P against the real armed desk, **no UI**.
//! - the same function called behind the UI's `desk_proceed` click later.
//!
//! Prove it via the CLI first; wire the identical logic to the UI second. The UI
//! becomes a thin trigger over proven code. The sandbox mocks the UI `invoke`
//! bridge, but a standalone binary that calls this function directly does NOT go
//! through `invoke`, so the mock does not apply: it can drive the real installed
//! engine, the real loopback wallet-rpc + Blockfrost, and dial the real desk.
//!
//! # This is a conductor, not new crypto (design principle 3)
//!
//! Every value-moving step is one of the existing methods, gated on one of the
//! existing gates:
//!
//! | Step | Component | Gate |
//! |---|---|---|
//! | M3 refund pre-sig | [`crypto::VendoredDeskCrypto::exchange_refund_sigs`] + [`client::refund_sigs`] | — (pre-signed BEFORE funds move; the recovery net) |
//! | lock the client's leg | [`crypto::VendoredDeskCrypto::lock`] | **[`engine::safe_to_lock_follower`] / [`engine::safe_to_release_claim_sig`]** |
//! | deliver the claim sig | poll `/status` (SELL) / [`client::ready_ack`] (BUY) | [`engine::safe_to_release_claim_sig`] (BUY, chain B) |
//! | settle | [`crypto::VendoredDeskCrypto::claim`] (role-dispatched) | — (the counterparty already revealed / we hold `t`) |
//!
//! The refund watcher, reclaim watch, and observer poll loop run concurrently as
//! the net, sharing one stop flag with the conductor — exactly what
//! [`super::rehydrate`] spawns on a cold restart, spawned here for a swap driven
//! live in this session.
//!
//! # Ordering is the whole safety property (desk v26 review)
//!
//! For SELL_FOLLOWER the desk LEADS: it locks ADA (chain A) first, gated only on
//! M2+M3, and the client must **observe that lock confirmed to depth BEFORE
//! locking XMR (chain B)**. Locking the scriptless coin before the scripted lock
//! is confirmed is the directionality violation that strands funds. The gate
//! [`engine::safe_to_lock_follower`] enforces it; this conductor calls it as a
//! HARD PRECONDITION and never reorders around it. The blueprint's first draft
//! inverted this; the desk caught it against `statemachine.go`; it is corrected
//! here and pinned by [`tests::gate_blocks_until_chain_a_confirmed`].

#![allow(dead_code)] // driven by desk/commands.rs::desk_proceed + the CLI entry

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::depth::SwapDepths;
use super::engine::{self, ClientRole};
use super::observer::{self, SidecarObserver};
use super::store::{DeskStore, StoredSwap};
use super::watch::{self, ChainObserver};
use super::{client, crypto, reclaim, refund, wire};
use super::crypto::{ActiveCrypto, VendoredDeskCrypto};
use super::rehydrate::DeskWatchers;
use crate::swap::proxy::ProxyError;
use crate::swap::state::SwapState;

/// How often the conductor re-polls the desk `/status` while waiting for the M5
/// released claim sig (SELL) or the desk's own leg (BUY). Deliberately unhurried:
/// block times on both legs are tens of seconds to minutes, and both sides draw
/// on one shared Blockfrost bucket.
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(12);

/// How often the long waits print an operator-facing progress line. The loops
/// themselves tick every 12–15s; across a 3h timelock that is ~900 iterations, so
/// a line per tick would bury the stage markers it exists to make findable.
const HEARTBEAT_INTERVAL_SECS: u64 = 60;

/// An operator-facing stage marker: the drive's happy path announcing itself.
///
/// Everything else the conductor prints is a fault. Without these the funded
/// drive is silent from `accept` to `claim` — which is most of an hour of a
/// terminal that looks identical whether the swap is progressing or wedged.
/// `STAGE` is a stable, greppable token on purpose: `scripts/swap/Start-Swap.ps1`
/// keys its live banners off these lines, so treat the token as a contract and
/// put the prose after it.
macro_rules! stage {
    ($swap_id:expr, $($arg:tt)*) => {
        eprintln!(
            "[desk::conductor] swap {}: STAGE {}",
            $swap_id,
            format_args!($($arg)*)
        )
    };
}

/// Rate-limiter for the progress lines inside a poll loop.
///
/// Fires immediately on first use (entering a wait should announce itself), then
/// at most once per `every` seconds.
struct Heartbeat {
    next_unix: u64,
    every: u64,
}

impl Heartbeat {
    fn new() -> Self {
        Self {
            next_unix: 0,
            every: HEARTBEAT_INTERVAL_SECS,
        }
    }

    fn due(&mut self) -> bool {
        let now = watch::unix_now();
        if now < self.next_unix {
            return false;
        }
        self.next_unix = now + self.every;
        true
    }
}

/// Minutes left until `deadline_unix`, for the progress lines. Saturating: a
/// passed deadline reads `0m`, never a wrapped absurdity.
fn mins_left(deadline_unix: u64) -> u64 {
    deadline_unix.saturating_sub(watch::unix_now()) / 60
}

#[derive(Debug, thiserror::Error)]
pub enum ConductorError {
    /// The real engine is not installed — `active_crypto()` is `Mock`. A funded
    /// choreography on placeholder crypto could lock a coin it can never claim or
    /// refund, so this refuses up front rather than at the first move. This is the
    /// fail-closed backstop for the arm-status consistency check (Part 2).
    #[error(
        "refusing to drive a funded swap: the vendored engine is NOT installed (crypto is Mock). \
         Arm the desk (PWNDA_DESK_ARM + testnet config) before proceeding."
    )]
    NotArmed,
    #[error("the wallet data dir is not resolved yet, so the swap store cannot be opened")]
    DataDirUnresolved,
    #[error("cannot load swap {swap_id} from the store: {source}")]
    Load {
        swap_id: String,
        #[source]
        source: super::store::StoreError,
    },
    #[error("swap {swap_id} has an unrecognized desk role: {source}")]
    Role {
        swap_id: String,
        #[source]
        source: engine::EngineError,
    },
    /// The desk moved the swap to a non-settled terminal state (aborted / failed /
    /// refunded) while we were driving. Not our error to fix — the recovery
    /// watchers own it — but the drive stops.
    #[error("swap {swap_id} reached terminal desk state {state} before we settled")]
    DeskTerminal { swap_id: String, state: String },
    /// We could not confirm the precondition (SELL: the desk's chain-A lock; BUY:
    /// the desk's chain-B lock) before the drive window closed. Nothing of ours is
    /// locked yet on this path, so it is safe to stop and let the reservation
    /// lapse / the desk refund its own leg.
    #[error(
        "swap {swap_id}: could not confirm chain {chain} to the agreed depth before the drive \
         window closed; stopping WITHOUT locking our leg (nothing of ours is at risk)"
    )]
    PreconditionTimeout { swap_id: String, chain: &'static str },
    #[error("swap {swap_id}: the desk did not release its claim pre-sig before the drive window closed")]
    ClaimSigTimeout { swap_id: String },
    #[error(
        "swap {swap_id}: the desk did not publish a prepared lock UTxO (/status.lockUtxo) before the \
         drive window closed — nothing of ours is locked yet, so stopping is safe"
    )]
    PreparedLockTimeout { swap_id: String },
    #[error("swap {swap_id}: HTTP {step} failed: {detail}")]
    Http {
        swap_id: String,
        step: &'static str,
        detail: String,
    },
    #[error("swap {swap_id}: engine {step} failed: {source}")]
    Engine {
        swap_id: String,
        step: &'static str,
        #[source]
        source: crypto::CryptoError,
    },
    #[error("swap {swap_id}: persisting the record after {step} failed: {source}")]
    Persist {
        swap_id: String,
        step: &'static str,
        #[source]
        source: super::store::StoreError,
    },
    /// A protocol-shape violation caught before it could move a coin (a follower
    /// M3 that produced no pre-signature, a released claim sig that was null).
    #[error("swap {swap_id}: {what}")]
    Protocol { swap_id: String, what: String },
}

/// Whether `extract_secret` failing means "not yet" or "never".
///
/// The third instance of a distinction this codebase already makes twice —
/// [`watch::LockSighting`] and [`ClaimDestCheck`] both refuse to collapse "could
/// not look" into "looked and found nothing". The settle tail collapsed it anyway,
/// and that cost swap `ad13b8c9` its unattended finish: the desk's claim was
/// **seconds** old, Blockfrost had not indexed it, and we treated a timing answer
/// as a verdict.
///
/// The engine has been supplying the distinction the whole time. `desk_watch.py:80`
/// documents the contract and its reason for existing:
///
/// ```text
///   (None, "not-indexed")         : the tx / our vkey witness is not visible yet - RETRY.
///   (None, "unsupported-backend") : PERMANENT for this preset; retrying will never help.
///   (None, "error: <msg>")        : a transient RPC error - retry later.
///   A2: the reason lets a caller distinguish 'not yet' from 'never' - the abort path
///       must not burn the refund window retrying a permanent failure.
/// ```
///
/// **We were handed a three-state answer and read the first bit of it.**
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SecretSighting {
    /// `t` is in engine memory; the sweep can proceed.
    Held,
    /// Not visible *yet*. The scalar is on a public chain permanently, so this is
    /// bounded by patience rather than by a deadline — but still bounded, because
    /// a leader who never sweeps is a leader who paid and did not collect.
    NotYet(String),
    /// It will not become visible on this configuration. Retrying burns the window
    /// for nothing, which is precisely what the engine's A2 note warns against.
    NeverWill(String),
}

/// Classify an `extract_secret` outcome. See [`SecretSighting`].
pub(crate) fn classify_extraction(secret_held: bool, reason: &str) -> SecretSighting {
    if secret_held {
        return SecretSighting::Held;
    }
    let r = reason.trim();
    // Matched on the documented reason strings. UNKNOWN reasons are PERMANENT here.
    //
    // **The desk classifies unknown reasons as RETRYABLE, and that is deliberate on
    // both sides — do not "harmonise" them.** The costs are asymmetric and each
    // side errs away from its own expensive outcome:
    //
    //   us   a needless stop costs one `Invoke-Settle`; `t` is on a public chain
    //        permanently, so nothing expires. A needless SPIN eats the refund
    //        window, which is the engine's own A2 warning.
    //   desk a needless stop abandons a swap it could still complete; a needless
    //        retry costs poll cycles it has anyway until T1, where the abort path
    //        takes over regardless.
    //
    // Neither choice is safer in general; each is safer for the party making it.
    // Agreed with the desk 2026-07-27, and recorded in a test on both sides so the
    // next person does not read the difference as a bug.
    if r.eq_ignore_ascii_case("not-indexed") || r.to_ascii_lowercase().starts_with("error:") {
        SecretSighting::NotYet(r.to_string())
    } else {
        SecretSighting::NeverWill(if r.is_empty() { "no reason given".into() } else { r.to_string() })
    }
}

/// The verdict of the pre-lock claim-destination comparison.
///
/// Three states rather than a bool, for the same reason [`LockSighting`] has
/// three: "we looked and they differ" and "we could not look" are different
/// facts, and collapsing them into `false` is how a missing check becomes an
/// apparent agreement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimDestCheck {
    Agrees,
    Disagrees,
    Unpublished,
    /// Both sides resolved the SAME destination — and it is not the one we
    /// nominated. Agreement is not correctness: when a nominated address fails
    /// the engine's `_is_ada_address` test, BOTH engines silently fall back to
    /// `Address(vkey_hash(B_ada))` and agree perfectly on a destination the
    /// operator never asked for. A two-party comparison structurally cannot see
    /// a substitution both parties make.
    AgreedButNotOurs,
}

/// Compare our claim destination with the desk's published one.
///
/// Either side being empty means the comparison did not happen — a desk without
/// D20 publishes nothing, and our engine has no destination before the
/// counterparty key is known. Only two present-and-different values are a
/// refusal.
pub(crate) fn claim_dest_check(
    ours: &str,
    theirs: &str,
    nominated: &str,
    source: &str,
) -> ClaimDestCheck {
    let (ours, theirs, nominated) = (ours.trim(), theirs.trim(), nominated.trim());
    if ours.is_empty() || theirs.is_empty() {
        return ClaimDestCheck::Unpublished;
    }
    if ours != theirs {
        return ClaimDestCheck::Disagrees;
    }
    // Agreement established. Now the question the comparison cannot answer on its
    // own: is the thing both sides agree on the thing we asked for?
    //
    // `nominated` is EMPTY whenever we did not nominate a claim destination — which
    // is every BUY, because there the desk receives the ADA and nobody nominates
    // for it. So this arm cannot fire on a correct BUY, and the guard needs no
    // knowledge of direction to be right in both.
    if nominated.is_empty() {
        return ClaimDestCheck::Agrees;
    }
    if ours != nominated {
        return ClaimDestCheck::AgreedButNotOurs;
    }
    // Values match. One more thing the values alone cannot say: the desk reporting
    // `derived` while we nominated means our nomination never took, and the match
    // is a coincidence of derivation rather than agreement about a nomination.
    // Cheap to catch, and it is exactly the C12 shape one layer in.
    if source.trim().eq_ignore_ascii_case("derived") {
        return ClaimDestCheck::AgreedButNotOurs;
    }
    ClaimDestCheck::Agrees
}

/// B2: does the operator want this SELL to stop before locking chain B?
///
/// **Deliberately permissive, and the asymmetry with the arm gate is the point.**
/// `PWNDA_CONDUCTOR_CLI_DRIVE` is strict — only exactly `"1"` arms a funded drive
/// — because an unrecognised value there must not move funds. This is the same
/// rule pointed the other way: the failure that costs money HERE is *"the
/// operator meant to stop and we locked chain B anyway"*, so anything set that is
/// not an explicit off resolves to STOP.
///
/// So `=true`, `=yes`, and a typo like `=y3s` all stop. Both gates resolve
/// ambiguity toward not moving funds; they just sit on opposite sides of the
/// literal.
fn stop_before_lock_b_requested(raw: Option<&str>) -> bool {
    match raw.map(str::trim) {
        None | Some("") => false,
        Some(v) => !matches!(
            v.to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

/// What the drive concluded. Never carries key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConductorOutcome {
    /// The happy path: our leg's claim was submitted. Carries the claim/sweep
    /// txid. The desk drives the canonical `SETTLED`.
    Claimed { chain: &'static str, txid: String },

    /// Abort-path rung B2: we stopped deliberately, after M3 and after the desk's
    /// chain-A lock confirmed to depth, WITHOUT locking chain B.
    ///
    /// **This is a success, not a failure**, and the distinction has to survive
    /// all the way to the operator's summary — the run did exactly what it was
    /// asked to do. Nothing of ours moved; the only outstanding item is the
    /// desk's own chain-A refund at T1, which is the thing the rung exercises.
    StoppedBeforeLockB { swap_id: String },
}

/// Drive one funded swap to settlement (or a clean stop). The shared entry point.
///
/// Loads the persisted swap, asserts the engine is armed, spawns the recovery
/// watchers, and runs the role-dispatched choreography. Never panics; every
/// failure returns an error the caller logs. The value-moving steps are gated on
/// the client's OWN chain observation, never the desk's `/status`.
pub async fn run_swap_choreography(
    state: &SwapState,
    watchers: &DeskWatchers,
    swap_id: &str,
) -> Result<ConductorOutcome, ConductorError> {
    // ── Fail closed if the engine is not real ────────────────────────────────
    // A Mock provider cannot move a coin; driving a funded swap on it is exactly
    // the silent-partial-arm footgun. Refuse before anything else.
    let crypto: &'static VendoredDeskCrypto = match crypto::active_crypto() {
        ActiveCrypto::Vendored(v) => v,
        ActiveCrypto::Mock(_) => return Err(ConductorError::NotArmed),
    };

    // ── Load the swap + resolve the role ─────────────────────────────────────
    let dir = state.data_dir().ok_or(ConductorError::DataDirUnresolved)?;
    let store = Arc::new(DeskStore::open(&dir).map_err(|source| ConductorError::Load {
        swap_id: swap_id.to_string(),
        source,
    })?);
    let rec = store.load(swap_id).map_err(|source| ConductorError::Load {
        swap_id: swap_id.to_string(),
        source,
    })?;
    let role = ClientRole::from_desk_role(&rec.desk_role).map_err(|source| ConductorError::Role {
        swap_id: swap_id.to_string(),
        source,
    })?;

    // ── Depths: prefer /status (labelled by chain, no direction to get wrong) ─
    // A single poll before we spawn anything. `SwapDepths::from_status` floors
    // each leg at its reorg depth, so a shallow preset can only make us wait
    // longer, never act sooner.
    let depths = match client::status(state, swap_id).await {
        Ok(st) => {
            if engine::DeskSwapState::parse(&st.state).is_terminal() {
                return Err(ConductorError::DeskTerminal {
                    swap_id: swap_id.to_string(),
                    state: st.state,
                });
            }
            SwapDepths::from_status(st.min_confs_a, st.min_confs_b)
        }
        // If the first status poll fails, fall back to the reorg floors alone
        // (via `from_status(0,0)`), which is the SAFE direction — floored deep,
        // never shallow.
        Err(_) => SwapDepths::from_status(0, 0),
    };

    // ── Spawn the recovery net, sharing one stop flag ────────────────────────
    // Registering the flag BEFORE spawning means desk_status can raise it (on a
    // terminal poll) even if a watcher task has not been scheduled yet. The
    // conductor raises it itself on a successful claim.
    let stop = watchers.register(swap_id);
    spawn_recovery_watchers(crypto, Arc::clone(&store), swap_id, rec.t1, Arc::clone(&stop));

    // The observer the gates read. Its poll loop (spawned inside
    // spawn_recovery_watchers) writes fresh sightings; the gate here reads them.
    // We keep our OWN handle so the gate and the loop share one observer.
    let observer = Arc::new(SidecarObserver::with_interval(observer::POLL_INTERVAL));

    // Chain B is NOT watched until a chain-B leg exists — see
    // `observer::chains_to_poll` for why watching it early killed a funded drive.
    // The choreography flips this the moment B becomes real: on SELL when our own
    // lock lands, on BUY once our chain-A lock is out and the desk starts locking B.
    // A rehydrated swap sets it from the durable record instead (it already has a leg).
    let watch_b = Arc::new(AtomicBool::new(rec.lock_b_txid.is_some()));
    {
        let obs = Arc::clone(&observer);
        let id = swap_id.to_string();
        let st = Arc::clone(&stop);
        let wb = Arc::clone(&watch_b);
        tauri::async_runtime::spawn(async move {
            observer::run_poll_loop(obs, crypto, id, st, observer::POLL_INTERVAL, wb).await;
        });
    }

    // ── Role-dispatched choreography ─────────────────────────────────────────
    let result = match role {
        ClientRole::Follower => {
            sell_follower(state, crypto, &store, &observer, &stop, rec, depths, &watch_b).await
        }
        ClientRole::Leader => {
            buy_leader(state, crypto, &store, &observer, &stop, rec, depths, &watch_b).await
        }
    };

    // Decide whether to stand the recovery net down. Stand down ONLY when it is
    // safe: our leg was never locked (nothing at risk), or the swap reached a
    // settled/recovered terminal state. If our leg IS locked and the swap is not
    // settled — a submitted-but-unconfirmed claim, or a mid-flight error after the
    // lock — LEAVE the net running so the refund watcher can fire at T1. (rehydrate
    // re-spawns it from the durable record + absolute T1 on the next launch
    // regardless, but we must not tear it down WITHIN the session on a
    // locked-and-unsettled swap — that is the safety backstop.)
    if should_stand_down(&store, swap_id, role) {
        stop.store(true, Ordering::SeqCst);
        watchers.clear(swap_id);
    } else {
        eprintln!(
            "[desk::conductor] swap {swap_id}: recovery net LEFT RUNNING — our leg is locked and the \
             swap is not settled; the refund watcher fires at T1 if it stays stuck"
        );
    }
    result
}

/// **SELL_FOLLOWER** — the client FOLLOWS (locks XMR / chain B), and this is the
/// direction the operator drives FIRST. Authoritative flow from the desk's v26
/// read of `statemachine.go`:
///
/// 1. M3 (refund pre-sig) — pre-signed BEFORE any funds move. Gates the desk lock.
/// 2. \[the desk locks ADA (chain A) automatically once M2+M3 land\]
/// 3. **observe chain A confirmed to depth (HARD gate), THEN lock chain B**
/// 4. report the lock via `POST /lock` (chain=B) — optimization, desk re-verifies
/// 5. poll `/status.releasedClaimSig`; `ingest_claim_presig`
/// 6. `claim` chain A (reveals `t`) → the desk sweeps chain B → SETTLED
async fn sell_follower(
    state: &SwapState,
    crypto: &'static VendoredDeskCrypto,
    store: &Arc<DeskStore>,
    observer: &Arc<SidecarObserver>,
    stop: &Arc<AtomicBool>,
    mut rec: StoredSwap,
    depths: SwapDepths,
    watch_b: &Arc<AtomicBool>,
) -> Result<ConductorOutcome, ConductorError> {
    let swap_id = rec.swap_id.clone();

    // ── (0) SEAM-1 FIX (prepare-and-share): record the desk's prepared ADA lock
    // UTxO before M3. The desk builds + signs its chain-A lock and publishes the
    // built-but-UNSUBMITTED output on /status.lockUtxo (null until it prepares,
    // which it does automatically after our M2). Our M3 refund pre-signature is
    // built OVER this exact input — the engine's make_refund_presig raises "no lock
    // UTxO recorded yet" without it — so we record it here, before M3. The desk
    // submits the lock on-chain only AFTER our M3 verifies, so nothing has moved
    // and the observe-A gate below still waits for the real on-chain lock.
    // (Delivery field: /status.lockUtxo, desk commit b3fcfc2 / DESK-DELIVERY-FIELD.md.)
    let lock_utxo = wait_for_prepared_lock_utxo(state, &swap_id, stop, rec.t1).await?;
    // Announce the RECEIPT separately from the RECORDING. They are two different
    // facts about two different counterparties — the desk published a prepared
    // UTxO, and our engine accepted it — and the step between them is an engine
    // call that can fail on its own. Collapsing both into the post-`set_lock_utxo`
    // marker cost a full relay round-trip on 2026-07-25: the engine timed out
    // here, no marker printed, and the desk had to ask whether we had ever seen
    // its lockUtxo at all. The answer was in the control flow, not the log.
    stage!(
        swap_id,
        "prepared-lock-utxo RECEIVED from /status — {}#{} for {}. Recording it with the engine; \
         M3 then binds our refund pre-signature to exactly this input.",
        lock_utxo.txid,
        lock_utxo.index,
        lock_utxo.amount
    );
    crypto
        .set_lock_utxo(
            &swap_id,
            &lock_utxo.txid,
            lock_utxo.index,
            &lock_utxo.amount.to_string(),
        )
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "set_lock_utxo",
            source,
        })?;
    stage!(
        swap_id,
        "1/7 prepared-lock-utxo RECORDED with the engine — the desk's ADA lock {}#{} for {} \
         (built, NOT yet on-chain; the desk submits it only after our M3 verifies)",
        lock_utxo.txid,
        lock_utxo.index,
        lock_utxo.amount
    );

    // ── (1) M3: produce our refund pre-sig, exchange it, PERSIST it ──────────
    // This is the recovery net: the refund watcher can only reclaim our leg if
    // `refund_presig_{r_enc,sp}` are on disk. `desk_accept` does NOT do M3, so the
    // conductor must, and it must be BEFORE the lock — "pre-signed before any
    // funds move" is the whole point. The set_lock_utxo above is M3's precondition.
    //
    // SEAM 1 (DESK-REVIEW v1) — now CLOSED on both sides. The engine does NOT
    // self-derive the refund body: make_refund_presig binds the recorded lock UTxO
    // and raises "no lock UTxO recorded yet" without it. The desk's prepare-and-
    // share (commit b3fcfc2) is what makes that UTxO exist before M3; step (0)
    // above is the client half (the one `set_lock_utxo` call). This
    // exchange_refund_sigs now succeeds where the first funded run would have
    // fail-closed — which is exactly what the conductor was built to do.
    let produced = crypto
        .exchange_refund_sigs(&swap_id, None, None)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "exchange_refund_sigs",
            source,
        })?;
    let ours = produced.ours.ok_or_else(|| ConductorError::Protocol {
        swap_id: swap_id.clone(),
        what: "M3: the follower produced no refund pre-signature (`ours` was null) — refusing to \
               lock a leg we could not later reclaim"
            .into(),
    })?;
    // CC-23: on the LTC leg we are the FOLLOWER and the PRODUCING side for both
    // signatures. Refuse rather than send a half-populated M3: the desk fails
    // closed on an absent pair, so a partial one turns a clear refusal into a
    // confusing one.
    let leg_sigs = if leg_uses_leg_sigs(&rec.pair) {
        match produced.ours_leg_sigs.clone() {
            Some(ls) => Some(ls),
            None => {
                return Err(ConductorError::Protocol {
                    swap_id: swap_id.clone(),
                    what: format!(
                        "M3 on {} requires legSigs (refundParentSig + refundSpendSig) and our                          engine produced none. The desk fails closed without them - it will not                          fund a lock whose refund cannot be completed - so we stop here rather                          than send an M3 that cannot be honoured.",
                        rec.pair
                    ),
                })
            }
        }
    } else {
        // ADA: the field never appears, so every ADA M3 stays byte-identical to
        // one that has settled.
        None
    };
    let m3 = client::refund_sigs(
        state,
        &swap_id,
        &wire::RefundSigsRequest {
            refund_presig: ours.clone(),
            claim_cosig: None,
            leg_sigs,
            // SELL: the DESK leads and publishes its lock on /status.lockUtxo.
            // We have no chain-A lock of our own, so the field stays absent and
            // this request is byte-identical to every SELL that has settled.
            lock_utxo: None,
        },
    )
    .await
    .map_err(|e| ConductorError::Http {
        swap_id: swap_id.clone(),
        step: "refund-sigs",
        detail: e.to_string(),
    })?;
    rec.refund_presig_r_enc = Some(ours.r_enc);
    rec.refund_presig_sp = Some(ours.sp);
    // The desk returns a claim pre-sig at M3 too (wire-trace `claimPresig`). We
    // persist it for the record, but the sig we COMPLETE the claim with is the M5
    // `releasedClaimSig` polled below — the desk only releases that after its own
    // watcher re-confirms our chain-B lock.
    if let Some(cp) = &m3.claim_presig {
        rec.claim_presig_r_enc = Some(cp.r_enc.clone());
        rec.claim_presig_sp = Some(cp.sp.clone());
    }
    persist(store, &rec, "refund-sigs")?;
    stage!(
        swap_id,
        "2/7 M3 refund pre-signature exchanged and PERSISTED — the recovery net is armed (our leg \
         is reclaimable at T1 from here on)"
    );

    // ── (2)+(3) observe chain A confirmed to depth — HARD PRECONDITION ───────
    // The desk locks ADA automatically now that M2+M3 have landed. We do not
    // trust its word for that: we wait on our OWN observer confirming chain A to
    // the agreed depth. Never lock chain B before this passes.
    stage!(
        swap_id,
        "3/7 observing chain A — the desk locks ADA now; we need {} confs on our OWN watcher \
         before locking XMR (HARD gate, never the desk's word)",
        depths.chain_a
    );
    match wait_for_lock_gate(
        &**observer,
        stop,
        depths.chain_a,
        drive_deadline_unix(rec.t1),
        observer::POLL_INTERVAL,
        watch::Chain::A,
        &swap_id,
    )
    .await
    {
        GateOutcome::Confirmed => {
            stage!(
                swap_id,
                "4/7 chain-A lock CONFIRMED to {} confs by our own watcher — clear to lock chain B",
                depths.chain_a
            );
        }
        GateOutcome::Stopped => {
            return Err(desk_terminal_or_stopped(state, &swap_id).await);
        }
        GateOutcome::Deadline => {
            return Err(ConductorError::PreconditionTimeout {
                swap_id,
                chain: "A",
            })
        }
    }

    // ── (2b) claim-destination agreement — the last cheap moment ─────────────
    // The desk signs the claim body; we cannot verify its signature until M5,
    // which is AFTER both legs are locked. That asymmetry is what swap
    // `46d85388` cost: our engine derived the claim destination from B_ada while
    // the desk used the address we nominated, so the pre-sig bound a body we
    // never build — and we found out with 0.1 sXMR already locked.
    //
    // Since D20 the desk publishes the destination it will sign over. Comparing
    // it here costs one GET; comparing it at M5 costs a refund cycle. This is
    // the whole lesson of that swap expressed as four lines.
    let (theirs, claim_dest_source) = client::status(state, &swap_id)
        .await
        .map(|s| (s.claim_dest, s.claim_dest_source))
        .unwrap_or_default();
    let ours = crypto.claim_dest(&swap_id).await.unwrap_or_default();
    match claim_dest_check(&ours, &theirs, &rec.payout_address, &claim_dest_source) {
        ClaimDestCheck::Agrees => {
            stage!(
                swap_id,
                "4b/7 claim destination AGREED with the desk ({}) — the claim body we build is                  the one it will sign",
                ours
            );
        }
        ClaimDestCheck::Disagrees => {
            return Err(ConductorError::Protocol {
                swap_id,
                what: format!(
                    "claim destination MISMATCH before locking chain B: we would build the claim                      to {ours}, the desk will sign to {theirs}. Its claim pre-signature would bind                      a body we never construct, so the claim could not complete and both legs                      would ride to refund. Refusing to lock. (This is the C12/46d85388 fault,                      caught before the money moves rather than after.)"
                ),
            });
        }
        ClaimDestCheck::AgreedButNotOurs => {
            return Err(ConductorError::Protocol {
                swap_id,
                what: format!(
                    "claim destination AGREED but is NOT the address we nominated: both sides \
                     resolved {ours}, we asked for {}. Both engines silently fell back to the \
                     derived per-swap address, which means our nomination failed the engine's \
                     is-this-an-ADA-address-for-this-network test. The claim would succeed and \
                     pay somewhere we did not choose. Refusing to lock. Check \
                     PWNDA_CLI_PAYOUT_ADDR — a mainnet address, an XMR address or a typo all \
                     land here, and both sides make the same substitution, so the two-party \
                     comparison cannot catch it.",
                    rec.payout_address
                ),
            });
        }
        ClaimDestCheck::Unpublished => {
            // Not a refusal: a desk older than D20 omits the field, and so does one
            // that does not know our key yet. But an unrun check is not a passed
            // check, and saying so is the difference between a gap and a silent gap.
            eprintln!(
                "[desk::conductor] swap {swap_id}: claim-destination check COULD NOT RUN                  (ours={}, desk={}). Locking chain B without it — a mismatch would surface                  at M5 with both legs locked.",
                if ours.is_empty() { "<none>" } else { &ours },
                if theirs.is_empty() { "<unpublished>" } else { &theirs },
            );
        }
    }

    // ── B2: the deliberate stop, BEFORE the first irreversible client step ───
    //
    // The desk's abort-path rung B2: a SELL where the desk locks chain A and we
    // never lock chain B, so its refund at T1 is exercised with real funds. The
    // risk allocation is the reason this is the right shape — **our XMR never
    // moves; the only coin at stake is the desk's own ~27 tADA, and recovering it
    // is the thing under test.**
    //
    // Why a gate and not "arm it and kill the process at the right moment": a
    // kill is a RACE against our own watcher, and losing it locks chain B. That
    // is a different scenario, it costs real XMR, and unwinding it needs a
    // reclaim. **A gate evaluated before the call cannot lose a race** — there is
    // no window in which the lock has been issued and the stop has not.
    //
    // Placed here rather than after M3 on purpose. Stopping at M3 would abort at
    // T0 before the desk ever submits its chain-A lock, which is rung B1 and
    // tests nothing about a refund. The desk must have LOCKED for its refund to
    // have something to refund, and it locks once M2+M3 land — so the stop
    // belongs after the observe-A gate has confirmed that lock is real, and
    // immediately before ours.
    //
    // SELL-only by construction: this is the site where the CLIENT locks the
    // scriptless coin, which only happens when we follow. `buy_leader` has no
    // corresponding site — there we lock chain A first, and the desk follows.
    if stop_before_lock_b_requested(
        std::env::var("PWNDA_CONDUCTOR_STOP_BEFORE_LOCK_B")
            .ok()
            .as_deref(),
    ) {
        rec.state = "STOPPED_BEFORE_LOCK_B".to_string();
        persist(store, &rec, "stop_before_lock_b")?;
        stage!(
            swap_id,
            "STOPPED BEFORE LOCK B (abort-path rung B2, deliberate). Everything up to and \
             including M3 ran, and the desk's chain-A lock is CONFIRMED to depth — that is what \
             its refund at T1 has to recover. We are stopping instead of locking chain B."
        );
        eprintln!(
            "[desk::conductor] swap {swap_id}: NOTHING OF OURS IS AT RISK — our chain-B lock was \
             never issued, so no XMR moved and there is nothing for us to reclaim. The desk holds \
             a chain-A lock it must refund at T1 (~3h, enforced by slot number and not \
             compressible). Leave it; no action is required on our side."
        );
        return Ok(ConductorOutcome::StoppedBeforeLockB { swap_id });
    }

    // ── (3) lock chain B (XMR) — the first irreversible client step ──────────
    let lock_txid = crypto
        .lock(&swap_id)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "lock",
            source,
        })?;
    rec.lock_b_txid = Some(lock_txid.clone());
    rec.state = "B_LOCKED".to_string();
    persist(store, &rec, "lock")?;
    // Chain B now has a leg, so the observer may start watching it — and only
    // now, because `watch_lock(B)` re-points the shared wallet-rpc at a joint
    // view wallet. Doing that any earlier is what starved this very lock call.
    watch_b.store(true, Ordering::SeqCst);
    stage!(
        swap_id,
        "5/7 chain-B LOCKED — our XMR lock txid {lock_txid}"
    );
    stage!(
        swap_id,
        "BOTH LEGS LOCKED — chain A confirmed to depth, chain B submitted. This is the mid-swap \
         checkpoint: from here the swap survives a restart on both sides, and T1 is the net."
    );

    // ── (4) report the lock (optimization; the desk re-verifies on-chain) ────
    // Best-effort: a failed report must NOT strand the swap — the desk discovers
    // our lock by watching chain B itself. So we log and continue.
    // Report SUCCESS as well as failure. This step only ever logged on error, so
    // a successful report was indistinguishable from one that never happened —
    // and on 2026-07-26 the desk, whose store showed no chain-B txid, concluded
    // we had not sent it. We had: 4s after the lock, and it 200'd. Neither side
    // could show that from its own log alone. Same lesson as the lock-UTxO
    // receipt: silence is not evidence of either outcome.
    match client::lock(
        state,
        &swap_id,
        &wire::LockRequest {
            chain: "B".to_string(),
            lock_txid: lock_txid.clone(),
            amount: Some(rec.amount_b.clone()),
            joint_output_proof: None,
        },
    )
    .await
    {
        Ok(resp) => stage!(
            swap_id,
            "chain-B lock REPORTED to the desk — POST /lock {{chain:B, lockTxid:{lock_txid}}} \
             accepted (desk state {}, accepted={}, verifying={})",
            resp.state,
            resp.accepted,
            resp.verifying
        ),
        Err(e) => eprintln!(
            "[desk::conductor] swap {swap_id}: POST /lock report FAILED ({e}); the desk can also \
             discover the lock on-chain, so this is non-fatal — continuing. If the desk later says \
             it never learned about chain B, THIS line is the reason."
        ),
    }

    // ── (5) wait for M5: the desk's released claim pre-sig, then ingest it ───
    let presig = wait_for_released_claim_sig(state, &swap_id, stop, rec.t1).await?;
    crypto
        .ingest_claim_presig(&swap_id, &presig)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "ingest_claim_presig",
            source,
        })?;
    stage!(
        swap_id,
        "6/7 M5 claim pre-signature released by the desk and ingested — its own watcher re-confirmed \
         our chain-B lock. Clear to claim chain A."
    );

    // ── (6) claim chain A (ADA) — completes the claim pre-sig with `t`, ──────
    // reveals `t`, and the desk sweeps chain B off it. Role-dispatched `claim`
    // (desk v27): the FOLLOWER branch needs the ingested claim pre-sig and does
    // NOT call extract_secret — we do not hold `t` on this side, the completion
    // reveals it.
    let claim_txid = crypto
        .claim(&swap_id)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "claim",
            source,
        })?;
    stage!(
        swap_id,
        "7/7 chain-A CLAIM submitted — txid {claim_txid}. `t` is revealed; the desk may now sweep \
         chain B. Waiting for its SETTLED before standing the refund net down."
    );

    // Our side has revealed `t`: the desk can now take our XMR — the trade we
    // agreed to. HARDENING (desk review v1, minor): do NOT stand the refund net
    // down on a merely SUBMITTED claim. Wait for the desk to reach SETTLED — it
    // sweeps chain B only after our chain-A claim confirms, so SETTLED is an
    // unambiguous "our claim confirmed" signal (stronger than the review's
    // suggested minConfsA), cross-checked against OUR claim txid. If the drive
    // window closes first, mark A_CLAIMED (non-terminal) and LEAVE the net up so
    // the refund watcher can still fire at T1 — we hold `t` + the released pre-sig,
    // so a dropped/reorged claim (rare on Cardano) is re-submittable.
    // `should_stand_down` (checked by the caller) reads this persisted state.
    match wait_for_settlement(state, &swap_id, &claim_txid, stop, rec.t1).await {
        SettlementOutcome::Settled => {
            stage!(
                swap_id,
                "SETTLED — the desk swept chain B against OUR claim txid. Swap complete."
            );
            rec.state = "SETTLED".to_string();
        }
        SettlementOutcome::Unconfirmed => {
            stage!(
                swap_id,
                "A_CLAIMED — our claim is submitted but the desk had not settled before the drive \
                 window closed. NON-TERMINAL: the refund net stays up and the claim is re-submittable."
            );
            rec.state = "A_CLAIMED".to_string();
        }
    }
    persist(store, &rec, "claim")?;
    Ok(ConductorOutcome::Claimed {
        chain: "A",
        txid: claim_txid,
    })
}

/// **BUY_FOLLOWER** — the client LEADS (locks ADA / chain A), driven SECOND,
/// after SELL is proven. The mirror of SELL from the desk's v26 flow:
///
/// 1. M3 (refund pre-sig)
/// 2. **you lock ADA (chain A) FIRST**; report via `POST /lock` (chain=A)
/// 3. \[the desk confirms A, then locks XMR (chain B)\]
/// 4. **observe chain B confirmed (HARD gate)**
/// 5. `release_claim_sig` (gated on our own chain-B confirm) → deliver via `POST /ready-ack`
/// 6. \[the desk claims chain A with it, revealing `t`\]
/// 7. `extract_secret` from the desk's chain-A claim, then **`claim` chain B** → SETTLED
///
/// DESK-REVIEW → RESOLVED (v1): SELL is the confident, first-to-run deliverable;
/// BUY is BLOCKED until the desk's prepare-and-share lands (mirrored) and the flow
/// is re-reviewed. What the desk confirmed:
/// (a) M3 DIRECTION — for BUY the desk is the FOLLOWER and PRODUCES the refund
///     pre-sig, so the leader-client sends an EMPTY/absent `refundPresig` and reads
///     the desk's pre-sig back from `RefundSigsResponse.refundPresig`, then
///     adaptor-verifies it under S_a and stores it. The empty-send below is right;
///     the adaptor-verify step is still to add.
/// (b) SAME lock-UTxO root cause as seam 1, MIRRORED — here WE lead and build the
///     ADA lock, so WE prepare-and-share its deterministic UTxO to the desk before
///     M3 (and `set_lock_utxo` on our own side). Not wired yet.
/// `set_lock_b_txid` before the M5 gate is confirmed as the right relay.
/// DO NOT DRIVE BUY until both land and the desk re-reviews the combined flow.
async fn buy_leader(
    state: &SwapState,
    crypto: &'static VendoredDeskCrypto,
    store: &Arc<DeskStore>,
    observer: &Arc<SidecarObserver>,
    stop: &Arc<AtomicBool>,
    mut rec: StoredSwap,
    depths: SwapDepths,
    watch_b: &Arc<AtomicBool>,
) -> Result<ConductorOutcome, ConductorError> {
    let swap_id = rec.swap_id.clone();

    // ── (0) PREPARE-AND-SHARE, mirrored. We lead, so WE build the chain-A lock ──
    //
    // Build and sign it WITHOUT submitting, which records the deterministic UTxO
    // engine-side. Two later steps depend on that record existing:
    //
    //   * the desk-as-follower builds its refund pre-signature over this exact
    //     input, so it must learn the UTxO before M3; and
    //   * OUR verification of that pre-signature re-derives the same canonical
    //     refund body — `verify_and_store_refund_presig` calls `_locked_input()`,
    //     so without the recorded UTxO the verify cannot even be attempted.
    //
    // Submitting first and sharing after is the shape that strands a leg: funds in
    // a script with no counter-signed way out. Hence prepare → share → M3 → submit.
    let our_lock_utxo = crypto
        .prepare_lock(&swap_id)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "prepare_lock",
            source,
        })?;
    stage!(
        swap_id,
        "0/7 prepared OUR chain-A lock {}#{} for {} — built and signed, NOT submitted. The desk \
         must learn this UTxO before M3 so its refund pre-signature binds this exact input.",
        our_lock_utxo.txid,
        our_lock_utxo.index,
        our_lock_utxo.amount
    );

    // ── (0b) SHARE it with the desk. The one piece of BUY that is not ours ─────
    // Fails today, by design — see the function. Everything after this point is
    // written, reachable and exercised the moment the channel exists.
    check_prepared_lock_utxo(&swap_id, &our_lock_utxo)?;
    stage!(
        swap_id,
        "0b/7 attaching our prepared lock {}#{} to M3 — the desk cannot bind a refund \
         pre-signature to an input it has not been told about, so this rides on the same request \
         rather than a round trip of its own",
        our_lock_utxo.txid,
        our_lock_utxo.index
    );

    // ── (1) M3 — direction confirmed: the leader-client sends an EMPTY/absent
    // refundPresig; the desk-as-follower returns ITS pre-sig in
    // RefundSigsResponse.refundPresig, which we then adaptor-verify under S_a and
    // store.
    let produced = crypto
        .exchange_refund_sigs(&swap_id, None, None)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "exchange_refund_sigs",
            source,
        })?;
    // A leader has no `ours`; if the engine gave one anyway, forward it.
    let req_presig = produced.ours.clone().unwrap_or(wire::AdaptorPresig {
        // Present-with-empty is refused by the desk's shape checks (fail-closed),
        // which is the safe direction if this branch is ever wrong.
        r_enc: String::new(),
        sp: String::new(),
    });
    let m3_req = wire::RefundSigsRequest {
        refund_presig: req_presig,
        claim_cosig: None,
        // CC-23: on BUY we LEAD, so on the LTC leg the desk is the follower and
        // the producing side for both signatures - we send none and verify its
        // pair below. On ADA the field never appears in either direction.
        leg_sigs: None,
        // BUY: we lead, so the desk learns our prepared chain-A lock HERE — it
        // cannot bind a refund pre-signature to an input it has not seen.
        lock_utxo: Some(our_lock_utxo.clone()),
    };
    let m3 = retry_while_desk_busy(&swap_id, "M3 refund-sigs", || async {
        client::refund_sigs(state, &swap_id, &m3_req).await
    })
    .await
    .map_err(|e| ConductorError::Http {
        swap_id: swap_id.clone(),
        step: "refund-sigs",
        detail: e.to_string(),
    })?;
    // ── (1b) ADAPTOR-VERIFY the desk's refund pre-signature under S_a ──────────
    //
    // The M3 defence the leader MUST run before locking, and the mirror of the
    // check the desk runs on us during SELL. Feeding the counterparty's pre-sig
    // back through `exchange_refund_sigs` makes the engine re-derive the canonical
    // refund body over the SAME realized UTxO and `adaptor_verify` the pre-sig
    // under S_a, storing it only if it binds (`verify_and_store_refund_presig`).
    //
    // Persisting an UNVERIFIED pre-signature would be the worst of both worlds: it
    // would look like recovery material on disk and then fail at broadcast, at T1,
    // with our funds locked. So verify FIRST, persist second — and refuse the
    // whole swap on a non-binding pre-sig rather than locking against it.
    // CC-23: hand the desk's leg-sig pair to our engine alongside its adaptor
    // pre-signature, so the verification covers BOTH recovery transactions on
    // the LTC leg. `None` on ADA, where there is no pair.
    let exchange = crypto
        .exchange_refund_sigs(&swap_id, Some(&m3.refund_presig), m3.leg_sigs.as_ref())
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "verify_refund_presig",
            source,
        })?;
    // CC-23, the mirror of the SELL guard: on the LTC leg the desk is the
    // producing side, so a response with NO pair means the recovery path cannot
    // be completed. Refuse before locking rather than discover it at T1.
    if leg_uses_leg_sigs(&rec.pair) && m3.leg_sigs.is_none() {
        return Err(ConductorError::Protocol {
            swap_id: swap_id.clone(),
            what: format!(
                "M3 on {} came back with NO legSigs. On this leg the chain-A recovery is two                  transactions and the desk is the producing side for both, so without them our                  chain-A lock would have no completable refund. Refusing before the lock.",
                rec.pair
            ),
        });
    }
    if !exchange.verified {
        // A bare `verified=false` cannot distinguish a wrong body from a wrong UTxO
        // from a bad signature — the opacity that made the C12 day expensive. Engine
        // 6e5194b returns the txid the deriving engine computed, which here is ours.
        //
        // This is deliberately only HALF a diff: `wire::RefundSigsResponse` carries no
        // refund txid, so the desk's value is not available to compare against and we
        // print ours for the operator to relay. Unlike the claim destination, that gap
        // is not urgent — the refund is verified at M3, BEFORE the chain-A lock
        // submits, so a disagreement here fails closed with nothing at risk.
        let ours = if exchange.our_refund_txid.is_empty() {
            " Our engine reported no derived refund txid (pre-6e5194b engine?).".to_string()
        } else {
            format!(
                " We derived refund txid {}. The desk does not publish its own on this \
                 response, so relay ours and ask for theirs: equal txids mean the bodies \
                 agree and the signature is what failed; different txids mean the bodies \
                 differ, and the locked input, locked amount, destination and fee are what \
                 to compare.",
                exchange.our_refund_txid
            )
        };
        return Err(ConductorError::Protocol {
            swap_id: swap_id.clone(),
            what: format!(
                "M3: the desk's refund pre-signature does NOT adaptor-verify under S_a over our \
                 own canonical refund body (output-pinning failed). It would not reclaim our \
                 chain-A lock at T1, so we refuse to submit that lock. Nothing is on chain.{ours}"
            ),
        });
    }
    stage!(
        swap_id,
        "1b/7 the desk's refund pre-signature ADAPTOR-VERIFIED under S_a and stored — it binds our \
         prepared UTxO, so our chain-A leg is reclaimable at T1 before we submit it"
    );

    // Persist the refund pre-sig we hold for the recovery net. For a leader this
    // is our OWN reclaim material for chain A (`execute_refund` reclaims chain A
    // when we lead). The desk returns it in the M3 response.
    rec.refund_presig_r_enc = Some(m3.refund_presig.r_enc.clone());
    rec.refund_presig_sp = Some(m3.refund_presig.sp.clone());
    if let Some(cp) = &m3.claim_presig {
        rec.claim_presig_r_enc = Some(cp.r_enc.clone());
        rec.claim_presig_sp = Some(cp.sp.clone());
    }
    persist(store, &rec, "refund-sigs")?;
    stage!(
        swap_id,
        "1/7 M3 refund pre-signature received from the desk-as-follower and PERSISTED — our chain-A \
         reclaim material is on disk before we lock"
    );

    // ── (1b) claim-destination agreement — the last cheap moment ─────────────
    //
    // BUY inverts the asymmetry that made this necessary in SELL. There the desk
    // signed the claim and we could not test it until M5; here WE sign the claim
    // pre-signature, so it is our derivation that has to be right, and a
    // disagreement costs the desk its leg rather than us ours. It is still ours
    // to prevent — we are the party that can, before anything is on chain.
    //
    // The nomination argument is EMPTY on purpose, and this is the whole reason
    // `claimDestSource` exists. In BUY the desk receives the ADA and nobody
    // nominates a destination for it, so `derived` is the correct answer and
    // `AgreedButNotOurs` must not fire. Passing `rec.payout_address` here — which
    // holds our XMR address in BUY — would refuse every correct drive.
    let (their_dest, their_source) = client::status(state, &swap_id)
        .await
        .map(|s| (s.claim_dest, s.claim_dest_source))
        .unwrap_or_default();
    let our_dest = crypto.claim_dest(&swap_id).await.unwrap_or_default();
    match claim_dest_check(&our_dest, &their_dest, "", &their_source) {
        ClaimDestCheck::Agrees => {
            stage!(
                swap_id,
                "1b/7 claim destination AGREED with the desk ({}, source={}) — the claim body we \
                 pre-sign is the one it will submit",
                our_dest,
                if their_source.is_empty() { "unpublished" } else { &their_source }
            );
        }
        ClaimDestCheck::Disagrees => {
            return Err(ConductorError::Protocol {
                swap_id,
                what: format!(
                    "claim destination MISMATCH before submitting our chain-A lock: we would \
                     pre-sign the claim to {our_dest}, the desk expects {their_dest}. Our claim \
                     pre-signature would bind a body it never submits, so it could not complete \
                     the swap and both legs would ride to refund. Refusing to lock — nothing is \
                     on chain."
                ),
            });
        }
        // Unreachable with an empty nomination; handled so a future change to the
        // arguments cannot silently fall through to a lock.
        ClaimDestCheck::AgreedButNotOurs => {
            return Err(ConductorError::Protocol {
                swap_id,
                what: format!(
                    "claim destination {our_dest} agreed but flagged as not ours, on a BUY where \
                     we nominate none. This should be unreachable — treat it as a bug in the \
                     guard's arguments rather than a protocol fault, and do not lock."
                ),
            });
        }
        ClaimDestCheck::Unpublished => {
            eprintln!(
                "[desk::conductor] swap {swap_id}: claim-destination check COULD NOT RUN \
                 (ours={}, desk={}). Submitting our chain-A lock without it — a mismatch would \
                 surface at the desk's claim, with both legs locked.",
                if our_dest.is_empty() { "<none>" } else { &our_dest },
                if their_dest.is_empty() { "<unpublished>" } else { &their_dest },
            );
        }
    }

    // ── (1c) refund-destination agreement — the destination that is OURS ─────
    //
    // The mirror of the claim check above, and it exists because the same fault
    // happened twice. C12: the desk honoured a nominated CLAIM destination while
    // we derived. C23: the desk honoured a nominated REFUND destination while we
    // derived — caught at M3 by adaptor_verify, which is safe but late and cost a
    // drive.
    //
    // The asymmetry: the claim destination is the counterparty's business and we
    // check it to be sure they will pay where we expect. **This one is ours.** We
    // lock chain A on BUY, so a disagreement means the pre-signature we are about
    // to depend on for T1 recovery pays somewhere we did not choose — the exact
    // shape of D25, where 19.82 tADA landed at a derived address.
    //
    // Unlike the claim, we DO nominate here, so the nomination is passed and
    // `AgreedButNotOurs` is live: agreement on a destination that is not the one
    // we asked for is still a refusal.
    let (their_refund, their_refund_src) = client::status(state, &swap_id)
        .await
        .map(|s| (s.refund_dest, s.refund_dest_source))
        .unwrap_or_default();
    let (our_refund, _our_src) = crypto
        .refund_dest(&swap_id)
        .await
        .unwrap_or_else(|_| (String::new(), String::new()));
    match claim_dest_check(
        &our_refund,
        &their_refund,
        &rec.refund_address,
        &their_refund_src,
    ) {
        ClaimDestCheck::Agrees => {
            stage!(
                swap_id,
                "1c/7 refund destination AGREED with the desk ({}, source={}) — the pre-signature \
                 we rely on at T1 pays where we asked",
                our_refund,
                if their_refund_src.is_empty() { "unpublished" } else { &their_refund_src }
            );
        }
        ClaimDestCheck::Disagrees | ClaimDestCheck::AgreedButNotOurs => {
            return Err(ConductorError::Protocol {
                swap_id,
                what: format!(
                    "refund destination MISMATCH before submitting our chain-A lock: we would \
                     build the refund to {our_refund}, the desk to {their_refund} (source \
                     {their_refund_src}), and we nominated {}. The refund pre-signature we \
                     depend on for T1 recovery would pay somewhere we did not choose — which \
                     is how 19.82 tADA landed at a derived address on swap 967c76b9. Refusing \
                     to lock; nothing is on chain.",
                    rec.refund_address
                ),
            });
        }
        ClaimDestCheck::Unpublished => {
            eprintln!(
                "[desk::conductor] swap {swap_id}: refund-destination check COULD NOT RUN \
                 (ours={}, desk={}). Submitting our chain-A lock without it — a mismatch would \
                 surface at T1, when the refund is the only thing left.",
                if our_refund.is_empty() { "<none>" } else { &our_refund },
                if their_refund.is_empty() { "<unpublished>" } else { &their_refund },
            );
        }
    }

    // ── (2) SUBMIT the lock we prepared at (0) — the first irreversible event ──
    //
    // `submit_lock`, not `lock`. The engine's `lock` takes the leader branch
    // straight through `prepare_and_lock_ada` — prepare AND submit in one call —
    // which would build a SECOND transaction, discarding the UTxO the desk's
    // pre-signature was just verified against. The two-phase split is the whole
    // point of (0).
    let lock_txid = crypto
        .submit_lock(&swap_id)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "submit_lock",
            source,
        })?;
    rec.lock_a_txid = Some(lock_txid.clone());
    rec.state = "A_LOCKED".to_string();
    persist(store, &rec, "lock")?;
    stage!(
        swap_id,
        "2/7 chain-A LOCKED — our ADA lock txid {lock_txid}. We lead, so this is the swap's first \
         irreversible event."
    );
    // Our chain-A lock is out, so the desk locks chain B next and the release
    // gate below needs to see it. Before this point there was nothing on B to
    // watch, and watching it anyway re-points the shared wallet-rpc.
    watch_b.store(true, Ordering::SeqCst);
    if let Err(e) = client::lock(
        state,
        &swap_id,
        &wire::LockRequest {
            chain: "A".to_string(),
            lock_txid,
            amount: Some(rec.amount_a.clone()),
            joint_output_proof: None,
        },
    )
    .await
    {
        eprintln!(
            "[desk::conductor] swap {swap_id}: POST /lock (A) report failed ({e}); non-fatal, the \
             desk watches chain A itself — continuing"
        );
    }

    // ── (3)+(4) observe chain B (the desk's XMR lock) confirmed — HARD gate ──
    // The desk confirms our A lock, then locks XMR. We wait on our OWN observer
    // confirming chain B before releasing anything. Same principle as SELL's
    // observe-A-before-lock, applied to the M5 release.
    stage!(
        swap_id,
        "3/7 observing chain B — the desk locks XMR now; we need {} confs on our OWN watcher before \
         releasing the claim sig (HARD gate, never the desk's ready flag)",
        depths.chain_b
    );
    // C18. LEARN THE DESK'S LOCK TXID FIRST — the gate cannot count without it.
    //
    // The engine's chain-B watch ends in `get_transfer_by_txid(lock_b_txid)`
    // (`desk_watch.py:191`). On SELL that txid is ours: we made the lock, so the
    // engine already had it. On BUY the DESK makes it, and until we are told, the
    // engine asks the wallet about the empty string, gets nothing, and reports
    // **0 confirmations forever** — while the coin sits confirmed on chain.
    //
    // We used to call `set_lock_b_txid` only AFTER this gate confirmed, which made
    // the gate wait for a count that needs a txid the code set only once the gate
    // had passed. A circular dependency that no test could see: it needs a real
    // desk that actually locks, and it costs a funded drive to observe, which is
    // exactly what swap `967c76b9` paid.
    //
    // Polled, not read once — the desk locks chain B AFTER our chain-A lock
    // confirms to depth, so at this point it usually has not locked yet. A single
    // read here would be the same bug one line earlier.
    {
        let deadline = drive_deadline_unix(rec.t1);
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err(desk_terminal_or_stopped(state, &swap_id).await);
            }
            match client::status(state, &swap_id).await {
                Ok(st) if !st.lock_b_txid.is_empty() => {
                    // C47c. A `?` here is what turned the 2026-07-28 contention
                    // into lane death: one EngineBusy — the engine healthy,
                    // merely mid-someone-else's-work — propagated out of a loop
                    // whose entire design is "poll until the deadline", four
                    // lines below a /status failure that already retries. Busy
                    // now FALLS THROUGH to the loop's own deadline check and
                    // sleep (not `continue`, which would bypass the deadline
                    // and spin a perma-busy engine past T1). Every OTHER error
                    // — rejection, config fault, death — still propagates;
                    // retrying those ranges from useless to dangerous.
                    match crypto.set_lock_b_txid(&swap_id, &st.lock_b_txid).await {
                        Err(e) if e.is_transient_busy() => {
                            eprintln!(
                                "[desk::conductor] swap {swap_id}: set_lock_b_txid found the \
                                 engine busy ({e}); the txid is not going anywhere — retrying \
                                 on the poll cadence"
                            );
                        }
                        Err(source) => {
                            return Err(ConductorError::Engine {
                                swap_id: swap_id.clone(),
                                step: "set_lock_b_txid",
                                source,
                            })
                        }
                        Ok(()) => {
                            rec.lock_b_txid = Some(st.lock_b_txid.clone());
                            persist(store, &rec, "lock-b-txid")?;
                            stage!(
                                swap_id,
                                "3a/7 the desk's chain-B lock txid {} recorded with the engine — \
                                 our own watcher can now count its confirmations. Until this \
                                 lands the engine has nothing to look up and reports 0 confs \
                                 regardless of the chain.",
                                st.lock_b_txid
                            );
                            break;
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: /status poll failed while waiting for \
                         the desk's chain-B lock txid ({e}); retrying"
                    );
                }
            }
            if watch::unix_now() >= deadline {
                return Err(ConductorError::PreconditionTimeout {
                    swap_id,
                    chain: "B",
                });
            }
            tokio::time::sleep(observer::POLL_INTERVAL).await;
        }
    }

    match wait_for_release_gate(
        &**observer,
        stop,
        depths.chain_b,
        drive_deadline_unix(rec.t1),
        observer::POLL_INTERVAL,
        &swap_id,
    )
    .await
    {
        GateOutcome::Confirmed => {
            stage!(
                swap_id,
                "4/7 chain-B lock CONFIRMED to {} confs by our own watcher",
                depths.chain_b
            );
            stage!(
                swap_id,
                "BOTH LEGS LOCKED — chain A (ours) submitted, chain B (the desk's) confirmed to \
                 depth. This is the mid-swap checkpoint; T1 is the net."
            );
        }
        GateOutcome::Stopped => return Err(desk_terminal_or_stopped(state, &swap_id).await),
        GateOutcome::Deadline => {
            // OUR chain-A lock is already on chain at this point, so exiting now
            // would take the refund watcher with it. Hold first, return after.
            // rec.t2 as well (C46): the deep abort is part of what the hold keeps
            // alive, and it does not become legal until T2.
            //
            // CC-2: T2 here is the ENGINE's when the record has one — on the
            // 07-30 rung the advertisement was 1200s EARLY (D48), and a hold
            // bounded by it ends 20 minutes before the swipe it exists to keep
            // alive becomes legal. `max` with the advertisement is deliberate:
            // for a LIFETIME bound the longer wait is free insurance, and the
            // engine value stays the one that decides when B3 actually fires.
            let hold_t2 = rec.t2.max(rec.t2_engine_unix.unwrap_or(rec.t2));
            if let Some(eng) = rec.t2_engine_unix {
                if eng != rec.t2 {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: engine T2 {eng} and advertised t2 {} \
                         disagree by {}s — the hold runs to the LATER ({hold_t2}); the engine \
                         value alone decides when B3 fires (CC-2/D48)",
                        rec.t2,
                        eng - rec.t2
                    );
                }
            }
            hold_open_for_refund(&swap_id, rec.t1, hold_t2, stop, watch_b).await;
            return Err(ConductorError::PreconditionTimeout {
                swap_id,
                chain: "B",
            })
        }
    }

    // Relay the desk's chain-B lock txid so our engine gates its own M5 release on
    // its own watch of THAT lock (never the desk's word). We read the txid from
    // /status (the desk surfaces its own lockBTxid there).
    if let Ok(st) = client::status(state, &swap_id).await {
        if !st.lock_b_txid.is_empty() {
            if let Err(e) = crypto.set_lock_b_txid(&swap_id, &st.lock_b_txid).await {
                eprintln!(
                    "[desk::conductor] swap {swap_id}: set_lock_b_txid failed ({e}); the engine's \
                     M5 gate re-derives its own chain-B view, so this is a hint, not a trust point"
                );
            }
        }
    }

    // ── (5) release our claim adaptor sig, gated on our own chain-B confirm ──
    // The engine's release_claim_sig is the INNER belt (it re-runs its own chain-B
    // watch and ANDs it); our `safe_to_release_claim_sig` gate above is the OUTER
    // one. Never pass `true` on the desk's word — that is the H1 setReady-timing
    // theft. We pass `true` only because our OWN observer confirmed B (the gate
    // above already returned Confirmed).
    let claim_sig = crypto
        .release_claim_sig(&swap_id, true)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "release_claim_sig",
            source,
        })?;
    // C30: retried on `desk_busy`, and this is the call site that made the budget
    // matter. A 503 here lands at 5/7 on BUY — OUR chain-A lock is down and the
    // desk's chain-B lock is down — so a single decline aborts a swap with both
    // legs committed and drops us into the abort path.
    //
    // The collision is CORRELATED, not coincidental: the desk holds its per-swap
    // lock across `watch_lock`, and the moment we send ready-ack is the moment it
    // is most likely to be watching the chain-B lock it has just made. The 503 is
    // likeliest exactly here.
    //
    // Safe to retry: `DeskBusy` means the desk declined before doing anything, so
    // there is no side effect to duplicate, and re-delivering the same adaptor
    // signature is idempotent — it releases nothing the first delivery did not.
    let ready_req = wire::ReadyAckRequest {
        ack: true,
        claim_adaptor_sig: Some(claim_sig),
    };
    let ready = retry_while_desk_busy(&swap_id, "ready-ack (M5)", || async {
        client::ready_ack(state, &swap_id, &ready_req).await
    })
    .await
    .map_err(|e| ConductorError::Http {
        swap_id: swap_id.clone(),
        step: "ready-ack",
        detail: e.to_string(),
    })?;
    // C31: the desk answers ready-ack in two shapes. A 200 means it APPLIED our
    // M5; a 202 with `queued` means it could not take its per-swap lock promptly,
    // persisted the message durably, and will apply it on the next advance. Both
    // are successful delivery — but they are not the same fact, and at 5/7 with
    // both legs locked the operator should not have to guess which one happened.
    // Saying nothing here is the C29 shape: a promise and a completion rendering
    // identically.
    if ready.queued {
        eprintln!(
            "[desk::conductor] swap {swap_id}: ready-ack ACCEPTED AND QUEUED (202) — the desk \
             persisted our claim adaptor sig rather than applying it inline, and will apply it \
             on its next advance. Delivery is durable; the desk's state has not moved yet, so \
             the `t`-reveal we wait for next may lag by one advance."
        );
    }
    stage!(
        swap_id,
        "5/7 claim adaptor sig RELEASED via ready-ack — the desk can now claim chain A, which \
         reveals `t` to us"
    );

    // ── (6)+(7) the desk claims chain A (reveals `t`); we extract it, then ───
    // claim chain B. Role-dispatched `claim` (desk v27): the LEADER branch
    // REQUIRES `t` to have been extract_secret-ed first, and refuses otherwise.
    let claim_a_txid = wait_for_desk_chain_a_claim(state, &swap_id, stop, rec.t1).await?;
    // Retry a NOT-YET, stop on a NEVER-WILL. The desk publishes `claimATxid` the
    // instant it submits — before any indexer has the transaction — so arriving
    // here with the witness unreadable is the NORMAL case, not an exception.
    let deadline = drive_deadline_unix(rec.t1);
    // The loop's product is the RETRY, not the payload: `claim` reads `t` from the
    // engine's own state, not from this value. Bound to `_` so the warning it was
    // emitting on every build stops competing with warnings that mean something.
    let _extraction = loop {
        if stop.load(Ordering::SeqCst) {
            return Err(desk_terminal_or_stopped(state, &swap_id).await);
        }
        let e = crypto
            .extract_secret(&swap_id, &claim_a_txid)
            .await
            .map_err(|source| ConductorError::Engine {
                swap_id: swap_id.clone(),
                step: "extract_secret",
                source,
            })?;
        match classify_extraction(e.secret_held, &e.reason) {
            SecretSighting::Held => break e,
            SecretSighting::NeverWill(why) => {
                return Err(ConductorError::Protocol {
                    swap_id: swap_id.clone(),
                    what: format!(
                        "extract_secret from the desk's chain-A claim {claim_a_txid} will NOT \
                         yield `t` on this configuration ({why}); retrying would burn the \
                         window for nothing, so we stop. The leader `claim` refuses without \
                         `t` and we do not call it."
                    ),
                });
            }
            SecretSighting::NotYet(why) => {
                if watch::unix_now() >= deadline {
                    return Err(ConductorError::Protocol {
                        swap_id: swap_id.clone(),
                        what: format!(
                            "extract_secret from {claim_a_txid} still reports `{why}` at the \
                             drive deadline. `t` is on chain permanently, so this is \
                             recoverable at any later time with Invoke-Settle — nothing is \
                             lost, it is simply not finished."
                        ),
                    });
                }
                eprintln!(
                    "[desk::conductor] swap {swap_id}: `t` not readable yet from \
                     {claim_a_txid} ({why}) — the desk publishes the txid on submit, ahead of \
                     any indexer. Retrying; the scalar is on chain permanently."
                );
                tokio::time::sleep(observer::POLL_INTERVAL).await;
            }
        }
    };
    stage!(
        swap_id,
        "6/7 `t` EXTRACTED from the desk's chain-A claim {claim_a_txid} — clear to claim chain B"
    );
    let sweep_txid = crypto
        .claim(&swap_id)
        .await
        .map_err(|source| ConductorError::Engine {
            swap_id: swap_id.clone(),
            step: "claim",
            source,
        })?;
    rec.state = "SETTLED".to_string();
    persist(store, &rec, "claim")?;
    stage!(
        swap_id,
        "7/7 chain-B CLAIMED — sweep txid {sweep_txid}. SETTLED; swap complete."
    );
    Ok(ConductorOutcome::Claimed {
        chain: "B",
        txid: sweep_txid,
    })
}

/// Share our prepared chain-A lock UTxO with the desk, so its refund
/// pre-signature binds that exact input. The mirror of `/status.lockUtxo`.
///
/// **UNIMPLEMENTED, and not because it was overlooked — there is no channel.**
///
/// `lock_utxo` exists in the wire only INBOUND, as a field on [`wire::StatusResponse`]:
/// the desk publishing ITS prepared UTxO to us, which is how seam 1 was closed for
/// SELL. There is no outbound equivalent, and none of the six client→desk endpoints
/// can carry ours:
///
/// | endpoint | why not |
/// |---|---|
/// | `refund-sigs` | `RefundSigsRequest` is `{refund_presig, claim_cosig}` |
/// | `lock` | reports a **submitted** txid — wrong semantics, and it would set the desk watching chain A for a transaction deliberately not there yet |
/// | `keys` / `ready-ack` / `status` / `abort` | wrong messages entirely |
///
/// So this is **seam 1 exactly mirrored**, and it needs the same fix in the other
/// direction. Asked of the desk 2026-07-26; a `lockUtxo` field on the M3 request is
/// the cheaper form — one round-trip fewer, and it binds the UTxO to the very
/// message that must be built over it.
///
/// **Why it is a function that returns an error, rather than a `todo!()` or an
/// early return in the caller.** A `todo!()` panics, and a panic in a funds-moving
/// path is never the right failure. An early `return` in `buy_leader` made every
/// step after it unreachable, which silenced the compiler on the whole rest of the
/// function — real warnings would have hidden behind the deliberate one. This shape
/// keeps the entire BUY path live, type-checked and reachable, with one obvious
/// landing site: give this body an implementation and nothing else has to change.
///
/// Refusing HERE rather than letting M3 proceed is also deliberate. Without the
/// share, the desk cannot produce a pre-signature that binds our input, so M3 would
/// either fail opaquely on its side or return something that does not bind — which
/// we would then catch at the verify, one step later and with less to say about it.
/// Re-run a one-shot desk call through a transient failure — `503 desk_busy`
/// or an I2P transport blip.
///
/// The pollers already retry everything, so this exists for the calls that do NOT
/// loop, where a single 503 would abort a live swap. Two of them, not three:
///
/// - **M3 refund-sigs** and **ready-ack** — wrapped. A 503 here aborts a swap.
/// - **the chain-B lock report** — deliberately NOT wrapped. The desk re-verifies
///   that lock on chain itself, so a dropped report is non-fatal by design.
///   Wrapping it would be tidiness mistaken for safety.
///
/// **C30: what `desk_busy` measures, and what it does not.** It means "I could not
/// take my per-swap mutex within my own bound" — a statement about how long the
/// desk is willing to WAIT for that lock. This comment used to reason from that
/// number ("the desk's next three seconds") when sizing the retry. That is the
/// wrong constant. What matters is how long the desk HOLDS the lock, and it holds
/// it across `watch_lock`: a COLD chain-B watch was measured at **~128s**
/// (`open_wallet` 4.4s + full scan 123.8s, 2026-07-28). The old budget — 5
/// attempts, 4s apart — gave up after 16s of waiting, roughly 8x too short, and
/// expired precisely while the desk was doing the legitimate work the retry exists
/// to wait out. Two constants, and only one of them was visible from outside.
///
/// The budget is therefore derived from the measured hold time rather than chosen,
/// and the derivation is asserted at compile time so the product of the two
/// constants cannot drift out from under the reasoning again.
///
/// Bounded deliberately, still. An unbounded retry against a desk that is wedged
/// rather than busy would spin until the drive window closed, and a stalled swap
/// that still holds its timelock is more recoverable than one that spent its window
/// pretending to make progress. Every other error returns on the first attempt —
/// only `DeskBusy` is retried, because only `DeskBusy` is documented as transient.
async fn retry_while_desk_busy<T, F, Fut>(
    swap_id: &str,
    what: &'static str,
    mut call: F,
) -> Result<T, ProxyError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, ProxyError>>,
{
    /// The desk's **declared** worst-case per-swap lock hold, from
    /// `/api/desk/effective-config` `desk.lockHoldWorstCaseSeconds`.
    ///
    /// 30s — the desk's declared **protocol** bound, live since its 2026-07-28
    /// 13:05 restart (`ADA_ENGINE_POOL_SIZE` rebuild, pid 2507910).
    ///
    /// **This tracks the RUNNING desk, not the desk's source tree.** It was 128
    /// (their raw measurement), then 150 (their bound for the old behaviour), and
    /// is now 30 — three values in two days, which is the argument for the
    /// preflight comparison rather than for any particular number. It was
    /// deliberately held at 150 while the desk's *source* said 30 and its *running
    /// binary* still held the per-swap lock across a chain watch: a constant
    /// describing a counterparty is a statement about a deployed process, not a
    /// commit. The restart is what earned the change.
    ///
    /// The 184s budget now clears it by ~6x. Deliberately not shrunk to match:
    /// the margin costs nothing, and tightening a retry budget in the week its
    /// input moved three times is optimising the wrong thing.
    ///
    /// Take the **protocol** bound, never the abort ceiling. The calls this wrapper
    /// guards (M3, quote, ready-ack) are protocol calls, and the 1800s ceiling
    /// belongs to `reclaim` — which is per-swap mutually exclusive with them, since
    /// a swap being reclaimed is not a swap sending M5. Sizing this budget to 1800s
    /// would be the C30 fault inverted: a bound taken from an operation the guarded
    /// calls never race.
    ///
    /// **This is a copy of someone else's number, and it went stale within one
    /// round of being written** — it was 128 for exactly as long as it took the
    /// desk to declare 150. The assertion below pins our two constants to each
    /// other, which was the C30 fault; it cannot pin either to reality. If the
    /// desk's hold time RISES and nobody relays it, this stays green and the
    /// budget is too short again. The desk now measures itself and publishes
    /// observed-beside-declared; **the other half — preflight comparing this
    /// constant against the live declaration — is not built yet**, so treat this
    /// value as owned by the counterparty and verified by nothing.
    const DESK_LOCK_HOLD_WORST_CASE_SECS: u64 = 30;
    const PAUSE_SECS: u64 = 8;
    const ATTEMPTS: u32 = 24;
    /// Sleeping happens between attempts, so the budget is one pause short of the
    /// attempt count: 23 x 8s = 184s, the measured worst case plus ~44% margin.
    const RETRY_BUDGET_SECS: u64 = (ATTEMPTS as u64 - 1) * PAUSE_SECS;
    /// The whole point of C30: the two constants multiply into a budget nobody was
    /// looking at. Make the product a compile error if it ever falls back under the
    /// hold time it exists to outlast.
    const _: () = assert!(
        RETRY_BUDGET_SECS > DESK_LOCK_HOLD_WORST_CASE_SECS,
        "the desk_busy retry budget must outlast the desk's worst-case lock hold, \
         or the retry expires while the desk is doing legitimate work"
    );
    const PAUSE: Duration = Duration::from_secs(PAUSE_SECS);

    for attempt in 1..=ATTEMPTS {
        let outcome = call().await;
        // `DeskBusy` is the desk declining within its own bound. `Network` over I2P
        // is the transport doing what I2P does — a single blip, observed 2026-07-26
        // when `/healthz` timed out while `/api/desk/pairs` answered 200 in the same
        // second. Neither says anything about the swap, and both are worth another
        // look before abandoning one.
        //
        // ONLY safe for calls with no side effect. A retried quote costs a round
        // trip; a retried accept would create a second swap and a retried lock
        // could double-submit, so those stay one-shot deliberately.
        let transient = matches!(
            outcome,
            Err(ProxyError::DeskBusy) | Err(ProxyError::Network(_))
        );
        if transient && attempt < ATTEMPTS {
            let why = match &outcome {
                Err(ProxyError::DeskBusy) => "503 desk_busy — mid-engine-call, not down",
                _ => "transport blip (I2P)",
            };
            eprintln!(
                "[desk::conductor] swap {swap_id}: {what} — {why} (attempt \
                 {attempt}/{ATTEMPTS}). Retrying in {}s.",
                PAUSE.as_secs()
            );
            tokio::time::sleep(PAUSE).await;
            continue;
        }
        return outcome;
    }
    unreachable!("loop returns on the final attempt")
}

/// BUY: hand the desk our PREPARED chain-A lock output.
///
/// There is no separate endpoint and there should not be one. The desk needs this
/// UTxO for exactly one purpose — building a refund pre-signature bound to it —
/// and that happens at M3. A standalone POST would add a second round trip, a
/// second failure mode, and a window in which the desk holds a UTxO for a swap
/// whose M3 never arrives.
///
/// So this does not send anything. It validates that what we are about to attach
/// to M3 is actually usable, and the M3 request carries it. Kept as a named step
/// because the *decision* is worth a name even when the delivery is a field:
/// [[swap-desk-buy-readiness]] calls this out as BUY's one build blocker, and a
/// future reader looking for "where do we share the lock UTxO" should land here
/// rather than on a struct field.
fn check_prepared_lock_utxo(
    swap_id: &str,
    utxo: &wire::LockUtxo,
) -> Result<(), ConductorError> {
    // C16 (2026-07-26). A lock smaller than its own refund cannot be recovered.
    //
    // The first funded BUY prepared a 100_000 lovelace lock — 0.1 tADA — because
    // `amountIn` is denominated in coin_in and coin_in flips with direction: 0.1
    // means 0.1 XMR on SELL and 0.1 ADA on BUY. The engine caught it at M3
    // (`ada_refund: locked 100000 too small for fee 176765 + min-UTxO`) and died
    // taking the sidecar with it, which is fail-closed but not legible.
    //
    // A refund pays one output back to us, so it must cover the network fee plus
    // Cardano's min-UTxO on that output. Both move with protocol params, so this
    // is a deliberately loose floor: it is not trying to predict the exact cost,
    // only to refuse the locks that obviously cannot pay it. A lock we cannot
    // refund is a lock we cannot walk away from, which is the one property the
    // whole abort design exists to preserve.
    const MIN_REFUNDABLE_LOVELACE: i64 = 2_000_000; // ~2 tADA: min-UTxO (~1) + fee (~0.2) + slack
    if utxo.amount > 0 && utxo.amount < MIN_REFUNDABLE_LOVELACE {
        return Err(ConductorError::Protocol {
            swap_id: swap_id.to_string(),
            what: format!(
                "BUY: our prepared chain-A lock is {} lovelace ({:.6} tADA), which cannot pay for \
                 its own refund — a Cardano refund needs the network fee plus min-UTxO on the \
                 output it returns, roughly {} lovelace. Locking it would strand the coin: no \
                 refund could be built at T1. Refusing before M3; nothing is on chain.\n\
                 \n\
                 The usual cause is the AMOUNT DENOMINATION: `amountIn` is in coin_in, and coin_in \
                 flips with direction. 0.1 means 0.1 XMR on SELL but 0.1 ADA on BUY. To buy 0.1 \
                 XMR you pass roughly its ADA price, not 0.1.",
                utxo.amount,
                utxo.amount as f64 / 1e6,
                MIN_REFUNDABLE_LOVELACE
            ),
        });
    }
    // A prepared lock we cannot describe is a prepared lock the desk cannot bind.
    // Refuse here, where nothing is on chain, rather than let the desk build a
    // refund pre-signature over a zero-amount or empty-txid input.
    if utxo.txid.trim().is_empty() || utxo.amount == 0 {
        return Err(ConductorError::Protocol {
            swap_id: swap_id.to_string(),
            what: format!(
                "BUY: our prepared chain-A lock is not describable — txid {:?}, index {}, amount \
                 {}. The desk binds its refund pre-signature to exactly this input, so an empty \
                 txid or a zero amount would produce a signature that protects nothing. Refusing \
                 before M3; nothing is on chain.",
                utxo.txid, utxo.index, utxo.amount
            ),
        });
    }
    Ok(())
}

// ───────────────────────────── shared helpers ──────────────────────────────

/// Persist the record, mapping the error to a step-labelled [`ConductorError`].
fn persist(store: &DeskStore, rec: &StoredSwap, step: &'static str) -> Result<(), ConductorError> {
    store.save(rec).map_err(|source| ConductorError::Persist {
        swap_id: rec.swap_id.clone(),
        step,
        source,
    })
}

/// Whether it is safe to stand the recovery net (observer + reclaim + refund
/// watcher) down now that the conductor has finished driving. Reads the PERSISTED
/// record, so it reflects what actually happened, not what the drive returned:
///
/// - our leg was never locked → nothing at risk → stand down.
/// - the swap is settled or recovered (refunded/failed/aborted) → the net is done.
/// - otherwise (our leg locked, not settled — a submitted-but-unconfirmed claim, a
///   mid-flight error after the lock) → KEEP the net: the refund watcher must be
///   able to fire at T1. A record we cannot even load is treated as "keep the net",
///   the safe default.
///
/// This is the fix the desk-review v1 minor point pointed at, generalised: tearing
/// the refund backstop down on an unconfirmed action is the premature-standdown
/// bad ordering, whether the action is a submitted claim or an errored drive.
fn should_stand_down(store: &DeskStore, swap_id: &str, role: ClientRole) -> bool {
    let Ok(rec) = store.load(swap_id) else {
        return false; // cannot tell → do not tear the net down
    };
    let our_lock = match role {
        ClientRole::Follower => rec.lock_b_txid.as_deref(),
        ClientRole::Leader => rec.lock_a_txid.as_deref(),
    };
    let locked = our_lock.map(|t| !t.is_empty()).unwrap_or(false);
    if !locked {
        return true; // nothing of ours is on-chain
    }
    let st = engine::DeskSwapState::parse(&rec.state);
    st.is_settled() || st.is_recovered_or_failed()
}

/// The absolute wall-clock instant (unix seconds) past which the conductor stops
/// DRIVING and leaves recovery to the watchers. Bounded by T1: locking or
/// claiming right at the refund deadline is pointless, and past it the refund
/// watcher owns the swap. A small margin keeps us from racing the watcher.
/// Hold the process open until the refund window opens, when our leg is locked.
///
/// C19. Every gate deadlines at `drive_deadline_unix` = **T1 minus 90 seconds**, and
/// the `RefundWatcher` spawned by the recovery net fires at **T1**. Returning from a
/// deadlined gate ends the drive, the process exits, and every watcher it spawned
/// dies with it — **ninety seconds before the refund it was waiting for becomes
/// valid.**
///
/// The margin itself is right: a drive should stop *driving* before racing its own
/// timelock. What was wrong is that stopping the drive also stopped the recovery,
/// and `cli_entry` never rehydrates. Observed on swap `967c76b9`, which sat locked
/// and unrefunded hours past T1 because the process had exited on schedule.
///
/// So: stop driving at the deadline, but do not stop EXISTING until the watcher has
/// had its moment. This does not itself refund — it simply declines to kill the
/// thing that will.
///
/// C46 (LADDER-06). "Its moment" used to end at **T1 + grace**, and that was C19's
/// fix stopping one rung short of C41's. The watcher this hold protects does not
/// finish at T1: when the refund keeps failing, `execute_deep_abort_and_report`
/// retries it until **T2** and only then takes branch B3 — and the hold was exiting
/// 30 minutes (production) or 450 seconds (the compressed rung pair) before that
/// moment became legal. The unattended swipe could never fire in-process; it only
/// existed via a manual re-run, which is why nothing noticed: `Invoke-Refund.ps1`
/// covered the gap by hand. The hold now runs to **max(T1, T2) + grace** — `max`
/// rather than `t2` so a degenerate record with `t2 = 0` (old stub-era stores)
/// falls back to exactly the old bound instead of returning instantly.
///
/// The only caller is the leader path with our chain-A lock on chain, which is the
/// one role that HAS a T2 branch. A follower's recovery (reclaim) keys off the
/// leader's refund and is unbounded — no hold can cover it, which is why reclaim
/// material persists to disk instead.
async fn hold_open_for_refund(
    swap_id: &str,
    t1_unix: i64,
    t2_unix: i64,
    stop: &Arc<AtomicBool>,
    watch_b: &Arc<AtomicBool>,
) {

    // C33: stand the chain-B watch down before starting the hold.
    //
    // GRACE_SECS was sized for POLLING JITTER and was quietly also absorbing
    // sidecar contention it was never sized for. The squeeze, measured:
    //
    //   the observer polls chain B every 15s          (observer::POLL_INTERVAL)
    //   each watch_lock(B) restores the joint VIEW wallet — ~128s cold
    //   that call holds the ONE serialized sidecar
    //   this hold is 150s
    //
    // which left about 7 seconds in the worst alignment, for the one call that
    // must not be late. Widening the constant is the belt; this is the braces,
    // and it is the better half: **once we are refunding chain A, watching chain
    // B buys nothing.** No gate is waiting on that sighting — they have all
    // deadlined, which is why we are here — so the poll is pure contention
    // against the refund.
    //
    // This applies an existing decision rather than inventing one. `chains_to_poll`
    // already refuses to watch B before it has a leg, on the reasoning that
    // watching B when it cannot help is actively harmful; the refund window is the
    // same statement at the other end of the swap.
    if watch_b.swap(false, Ordering::SeqCst) {
        eprintln!(
            "[desk::conductor] swap {swap_id}: chain-B watch STOOD DOWN for the refund window — \
             no gate is waiting on it now, and its ~128s cold restore holds the one sidecar the \
             refund needs. The refund has the engine to itself."
        );
    }
    let until = refund_hold_until(t1_unix, t2_unix);
    let now = watch::unix_now();
    if now >= until {
        return;
    }
    eprintln!(
        "[desk::conductor] swap {swap_id}: gate deadlined with OUR leg locked. Holding the \
         process open {}s — until max(T1,T2)+{REFUND_HOLD_GRACE_SECS}s — so the refund watcher \
         can fire at T1 and, if the refund keeps failing, the deep abort can take branch B3 at \
         T2 (C19, C46). Killing the drive here kills the recovery it spawned. Leave this window \
         alone.",
        until - now
    );
    while watch::unix_now() < until {
        if stop.load(Ordering::SeqCst) {
            eprintln!(
                "[desk::conductor] swap {swap_id}: stop raised while holding for the refund \
                 window — the watcher fired or the swap resolved."
            );
            return;
        }
        tokio::time::sleep(observer::POLL_INTERVAL).await;
    }
    eprintln!(
        "[desk::conductor] swap {swap_id}: both recovery windows have opened and the watcher \
         has had its chance at each — the refund from T1, the deep abort from T2. If neither \
         went out, run Invoke-Refund.ps1."
    );
}

/// CC-11: whether a FAILED drive leaves anything worth holding the process open
/// for, and if so the `(t1, t2)` bound to hold to. Pure so the decision is
/// pinnable without a store.
///
/// The 07-28 funded pair run is the incident: 125s into the BUY leg a sidecar
/// timeout on `set_lock_b_txid` surfaced as `Err`, the CLI entry's `.expect()`
/// turned a recoverable stall into a process abort, and every watcher for the
/// swap — refund, reclaim, and now swipe — died with it, 125 seconds after our
/// ADA had locked. The C46 hold existed but only on the ONE error path that
/// was seen deadline (the B-lock gate); `wait_for_desk_chain_a_claim`'s
/// T1−90s deadline and every `?`-propagated engine error bypassed it — C41's
/// "a fix applied to one instance of a pattern is not applied to the pattern",
/// at the process boundary this time. The fix is ONE hold at that boundary,
/// covering every error path at once, rather than a third scattered instance.
///
/// `None` means exit freely: the swap is terminal, or our own leg never
/// locked (a failure that cost nothing — the same `NothingLocked` reasoning
/// as the refund path).
fn recovery_hold_bound(rec: &StoredSwap) -> Option<(i64, i64)> {
    if engine::DeskSwapState::parse(&rec.state).is_terminal() {
        return None;
    }
    let role = engine::ClientRole::from_desk_role(&rec.desk_role).ok()?;
    let ours = match role.client_lock_chain() {
        "A" => rec.lock_a_txid.as_deref(),
        _ => rec.lock_b_txid.as_deref(),
    };
    if ours.map_or(true, str::is_empty) {
        return None;
    }
    // CC-2: the engine's T2 when the record has one; `max` with the
    // advertisement because for a LIFETIME bound the longer wait is free
    // insurance (same reasoning as the in-drive hold call site).
    let hold_t2 = rec.t2.max(rec.t2_engine_unix.unwrap_or(rec.t2));
    Some((rec.t1, hold_t2))
}

/// CC-11: the process-boundary recovery vigil. Called by the CLI entries when
/// `run_swap_choreography` returns `Err` — in the app the watchers outlive the
/// error inside the Tauri runtime, but in a CLI drive the process IS the
/// runtime, and exiting kills them. Loads the record, and if our leg is locked
/// on a live swap, holds the process open to `max(T1, engine T2) + grace` so
/// the watchers spawned for this swap can fire. The stop flag is the SAME one
/// the watchers share (via [`DeskWatchers`]), so a settlement observed during
/// the vigil ends it early.
async fn hold_for_recovery_after_failed_drive(
    state: &SwapState,
    watchers: &DeskWatchers,
    swap_id: &str,
) {
    let rec = match state
        .data_dir()
        .ok_or_else(|| "data dir unresolved".to_string())
        .and_then(|d| DeskStore::open(&d).map_err(|e| e.to_string()))
        .and_then(|s| s.load(swap_id).map_err(|e| e.to_string()))
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "[desk::conductor] swap {swap_id}: drive failed AND the record cannot be read \
                 ({e}) — cannot tell whether funds are locked, so holding is impossible. If \
                 anything of ours is on chain, run Invoke-Refund.ps1 by hand."
            );
            return;
        }
    };
    match recovery_hold_bound(&rec) {
        None => {
            eprintln!(
                "[desk::conductor] swap {swap_id}: drive failed with nothing of ours locked \
                 (state {}) — no recovery window to hold for; exiting is free.",
                rec.state
            );
        }
        Some((t1, t2)) => {
            eprintln!(
                "[desk::conductor] swap {swap_id}: the drive FAILED but OUR LEG IS LOCKED — \
                 keeping the process alive for the recovery windows instead of aborting (the \
                 07-28 BUY died 125s in and took its own refund watcher with it). Refund at \
                 T1={t1}, deep abort from T2={t2}."
            );
            let stop = watchers.register(swap_id);
            let watch_b = Arc::new(AtomicBool::new(false));
            hold_open_for_refund(swap_id, t1, t2, &stop, &watch_b).await;
        }
    }
}


/// CC-23: does this pair's chain-A leg carry `legSigs` on M3?
///
/// XMR/ADA's M3 is ONE adaptor pre-signature and always has been. XMR/LTC's
/// chain-A recovery is two transactions, each taking a plain 2-of-2 ECDSA
/// signature, so its M3 carries a pair instead - and the desk FAILS CLOSED if
/// that pair is absent on an LTC swap, because it will not fund a lock whose
/// refund cannot be completed.
///
/// Derived from the pair label rather than hardcoded per call site: the same
/// reasoning as CC-18's leg derivation, and there is exactly one place to be
/// wrong.
fn leg_uses_leg_sigs(pair: &str) -> bool {
    pair.to_ascii_uppercase().ends_with("/LTC")
}

/// A small margin past the last recovery deadline, because the watcher polls rather
/// than firing on an exact edge, and because a refund submitted one second early is
/// invalid.
const REFUND_HOLD_GRACE_SECS: u64 = 150;

/// C46: the hold's bound, pure so the arithmetic is pinnable. `max` and not `t2`,
/// so a record with no real T2 (zero, stub-era) degrades to the old T1-based bound
/// rather than to "return immediately".
fn refund_hold_until(t1_unix: i64, t2_unix: i64) -> u64 {
    (t1_unix.max(t2_unix).max(0) as u64).saturating_add(REFUND_HOLD_GRACE_SECS)
}

fn drive_deadline_unix(t1_unix: i64) -> u64 {
    const MARGIN_SECS: u64 = 90;
    (t1_unix.max(0) as u64).saturating_sub(MARGIN_SECS)
}

/// The outcome of waiting on a chain gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateOutcome {
    /// The gate passed — the required lock is confirmed to depth.
    Confirmed,
    /// The shared stop flag was raised (cooperative settle, terminal desk state,
    /// or a refund fired) — stop driving.
    Stopped,
    /// The drive deadline passed without the gate confirming.
    Deadline,
}

/// Wait until [`engine::safe_to_lock_follower`] passes (SELL: chain A confirmed
/// to depth), the stop flag is raised, or the deadline passes.
///
/// The gate is fail-closed: both `NotYet` (the desk has not locked / not deep
/// enough) and `CouldNotLook` (our visibility failed) keep us waiting rather than
/// proceeding — locking chain B on either would be the funds-stranding move.
async fn wait_for_lock_gate(
    obs: &dyn ChainObserver,
    stop: &AtomicBool,
    min_confs: u64,
    deadline_unix: u64,
    poll: Duration,
    chain: watch::Chain,
    swap_id: &str,
) -> GateOutcome {
    let mut hb = Heartbeat::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return GateOutcome::Stopped;
        }
        if engine::safe_to_lock_follower(obs, min_confs).is_ok() {
            return GateOutcome::Confirmed;
        }
        if hb.due() {
            report_sighting(obs, chain, min_confs, deadline_unix, swap_id, "lock gate");
        }
        if watch::unix_now() >= deadline_unix {
            return GateOutcome::Deadline;
        }
        tokio::time::sleep(poll).await;
    }
}

/// One progress line for a gate that is still waiting.
///
/// It reports WHICH of the three [`watch::LockSighting`] states we are in, not
/// merely "still waiting". That distinction is the whole reason the sighting is
/// not a bool: `NotYet` means the chain answered and the swap is patient;
/// `CouldNotLook` means *we* are blind and the operator must fix chain access
/// before the timelock burns down. Collapsed into silence they are
/// indistinguishable — and a blind swap that looks patient is how a T1 arrives
/// unattended.
fn report_sighting(
    obs: &dyn ChainObserver,
    chain: watch::Chain,
    min_confs: u64,
    deadline_unix: u64,
    swap_id: &str,
    gate: &str,
) {
    let c = chain.as_str();
    let left = mins_left(deadline_unix);
    match obs.observe_lock(chain) {
        watch::LockSighting::Confirmed { confs, txid, .. } => eprintln!(
            "[desk::conductor] swap {swap_id}: {gate} chain {c} — seen at {confs}/{min_confs} \
             confs (txid {txid}), {left}m of drive window left"
        ),
        watch::LockSighting::NotYet { confs } => eprintln!(
            "[desk::conductor] swap {swap_id}: {gate} chain {c} — not yet ({confs}/{min_confs} \
             confs); the chain answered, so this is patience, {left}m left"
        ),
        watch::LockSighting::CouldNotLook { error } => eprintln!(
            "[desk::conductor] swap {swap_id}: {gate} chain {c} — CANNOT LOOK ({error}). This is \
             about OUR chain access, not the counterparty — fix it; {left}m of drive window left"
        ),
    }
}

/// Wait until [`engine::safe_to_release_claim_sig`] passes (BUY: chain B confirmed
/// to depth). `desk_says_ready` is deliberately passed `false` — our own chain-B
/// observation is the only thing that may unblock the release (the H1 gate).
async fn wait_for_release_gate(
    obs: &dyn ChainObserver,
    stop: &AtomicBool,
    min_confs: u64,
    deadline_unix: u64,
    poll: Duration,
    swap_id: &str,
) -> GateOutcome {
    let mut hb = Heartbeat::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return GateOutcome::Stopped;
        }
        if engine::safe_to_release_claim_sig(obs, false, min_confs).is_ok() {
            return GateOutcome::Confirmed;
        }
        if hb.due() {
            report_sighting(
                obs,
                watch::Chain::B,
                min_confs,
                deadline_unix,
                swap_id,
                "release gate",
            );
        }
        if watch::unix_now() >= deadline_unix {
            return GateOutcome::Deadline;
        }
        tokio::time::sleep(poll).await;
    }
}

/// Poll the desk `/status` until it publishes its PREPARED chain-A lock UTxO
/// (`lockUtxo`, the seam-1 delivery field). Null until the desk prepares its ADA
/// lock, which it does automatically after our M2 — usually within a coordinator
/// tick. Bounded by the drive deadline; nothing of ours is locked yet, so a
/// timeout here strands nothing.
async fn wait_for_prepared_lock_utxo(
    state: &SwapState,
    swap_id: &str,
    stop: &AtomicBool,
    t1_unix: i64,
) -> Result<wire::LockUtxo, ConductorError> {
    let deadline = drive_deadline_unix(t1_unix);
    let mut hb = Heartbeat::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(desk_terminal_or_stopped(state, swap_id).await);
        }
        match client::status(state, swap_id).await {
            Ok(st) => {
                if let Some(u) = st.lock_utxo {
                    return Ok(u);
                }
                if engine::DeskSwapState::parse(&st.state).is_terminal() {
                    return Err(ConductorError::DeskTerminal {
                        swap_id: swap_id.to_string(),
                        state: st.state,
                    });
                }
                if hb.due() {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: waiting for the desk to PREPARE its \
                         chain-A lock (/status.lockUtxo still null, desk state {}); {}m of drive \
                         window left. Nothing of ours is locked.",
                        st.state,
                        mins_left(deadline)
                    );
                }
            }
            Err(e) => eprintln!(
                "[desk::conductor] swap {swap_id}: /status poll failed while waiting for the desk's \
                 prepared lock UTxO ({e}); retrying"
            ),
        }
        if watch::unix_now() >= deadline {
            return Err(ConductorError::PreparedLockTimeout {
                swap_id: swap_id.to_string(),
            });
        }
        tokio::time::sleep(STATUS_POLL_INTERVAL).await;
    }
}

/// Poll the desk `/status` until `releasedClaimSig` is present (SELL M5). The desk
/// sets it ONLY after its own watcher re-confirms our chain-B lock, so its mere
/// presence is proof the desk saw the lock — but this is DELIVERY of the sig, not
/// a trigger to sign: the client already locked B under its own gate.
async fn wait_for_released_claim_sig(
    state: &SwapState,
    swap_id: &str,
    stop: &AtomicBool,
    t1_unix: i64,
) -> Result<wire::AdaptorPresig, ConductorError> {
    let deadline = drive_deadline_unix(t1_unix);
    let mut hb = Heartbeat::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(desk_terminal_or_stopped(state, swap_id).await);
        }
        match client::status(state, swap_id).await {
            Ok(st) => {
                if let Some(sig) = st.released_claim_sig {
                    return Ok(sig);
                }
                if engine::DeskSwapState::parse(&st.state).is_terminal() {
                    return Err(ConductorError::DeskTerminal {
                        swap_id: swap_id.to_string(),
                        state: st.state,
                    });
                }
                if hb.due() {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: waiting for M5 — the desk releases the \
                         claim sig once its own watcher confirms our chain-B lock to {} confs \
                         (desk state {}, confsB {}); {}m of drive window left",
                        st.min_confs_b,
                        st.state,
                        st.confs_b,
                        mins_left(deadline)
                    );
                }
            }
            Err(e) => eprintln!(
                "[desk::conductor] swap {swap_id}: /status poll failed while waiting for the claim \
                 sig ({e}); retrying"
            ),
        }
        if watch::unix_now() >= deadline {
            return Err(ConductorError::ClaimSigTimeout {
                swap_id: swap_id.to_string(),
            });
        }
        tokio::time::sleep(STATUS_POLL_INTERVAL).await;
    }
}

/// The result of waiting for the desk to settle after our SELL chain-A claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettlementOutcome {
    /// The desk reached SETTLED (it swept chain B, which it can only do once our
    /// chain-A claim confirmed to depth). Safe to stand the refund net down.
    Settled,
    /// The drive window closed without a confirmed settlement — keep the net up.
    Unconfirmed,
}

/// Wait for the desk to reach SETTLED after our chain-A claim, cross-checking that
/// it settled via OUR claim txid — a desk reporting SETTLED against a DIFFERENT
/// chain-A tx is not evidence our claim confirmed. Bounded by the drive deadline.
///
/// SETTLED is the confirmation signal on purpose: the desk sweeps chain B only
/// after our claim confirms, so it is unambiguous and stronger than the review's
/// suggested `minConfsA`, and standing watchers down on a terminal `/status` is
/// what `desk_status` already does. On the unconfirmed path we do NOT trust the
/// desk's word to tear the net down — we simply leave it running.
async fn wait_for_settlement(
    state: &SwapState,
    swap_id: &str,
    our_claim_txid: &str,
    stop: &AtomicBool,
    t1_unix: i64,
) -> SettlementOutcome {
    let deadline = drive_deadline_unix(t1_unix);
    let mut hb = Heartbeat::new();
    // Whether the last poll could see the desk at all, so the two transitions
    // (going blind, coming back) can print immediately while the steady state
    // stays on the heartbeat.
    let mut blind = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            // Something else already stood the swap down (a terminal desk_status
            // poll, or a fired refund) — nothing left for us to confirm.
            return SettlementOutcome::Unconfirmed;
        }
        // C29: three states, and the instrument has to say which one it is in.
        //
        // A failed poll is COULD-NOT-LOOK — emphatically not "the desk has not
        // settled yet". It used to be neither: the `if let Ok` had no else arm and
        // the heartbeat lived INSIDE it, so a desk that went away produced total
        // silence until the deadline. Silence here reads as "still working", and
        // the last line the operator saw was `7/7 chain-A CLAIM submitted`.
        //
        // The sibling `wait_for_claim_sig` (~70 lines up) has announced this since
        // it was written. A fix applied to one instance and not to the pattern —
        // the same shape `LockSighting::CouldNotLook` exists to prevent, missing
        // from the loop that decides whether to stand the refund net down.
        //
        // Rate-limited through the SAME heartbeat as progress rather than printed
        // per tick: polls are 12s, so a bare line per failure is ~300/hour and
        // would bury the stage markers the heartbeat exists to keep findable
        // (see HEARTBEAT_INTERVAL_SECS). Both TRANSITIONS print immediately —
        // going blind and coming back are the events worth knowing promptly; the
        // steady state is a pulse. `due` is taken once per iteration so the two
        // arms genuinely share one timer instead of each advancing it.
        let due = hb.due();
        match client::status(state, swap_id).await {
            Ok(st) => {
                if blind {
                    blind = false;
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: /status readable again — the settlement \
                         wait can see the desk"
                    );
                }
                if due && !engine::DeskSwapState::parse(&st.state).is_settled() {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: waiting for the desk to SETTLE (it sweeps \
                         chain B only after our chain-A claim confirms; desk state {}, confsA {}/{}); \
                         {}m of drive window left",
                        st.state,
                        st.confs_a,
                        st.min_confs_a,
                        mins_left(deadline)
                    );
                }
                if engine::DeskSwapState::parse(&st.state).is_settled() {
                    if !st.claim_a_txid.is_empty() && st.claim_a_txid != our_claim_txid {
                        eprintln!(
                            "[desk::conductor] swap {swap_id}: /status is SETTLED but its claimATxid {} \
                             is not our claim {our_claim_txid} — NOT standing the refund net down on \
                             that; keeping it up",
                            st.claim_a_txid
                        );
                    } else {
                        return SettlementOutcome::Settled;
                    }
                }
            }
            Err(e) => {
                if !blind || due {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: COULD NOT LOOK — /status poll failed \
                         ({e}). This is not 'the desk has not settled', it is 'we cannot see the \
                         desk'. Our chain-A claim is submitted and the refund net stays up; {}m of \
                         drive window left",
                        mins_left(deadline)
                    );
                }
                blind = true;
            }
        }
        if watch::unix_now() >= deadline {
            return SettlementOutcome::Unconfirmed;
        }
        tokio::time::sleep(STATUS_POLL_INTERVAL).await;
    }
}

/// Poll the desk `/status` until it publishes its chain-A claim txid (BUY: the
/// desk claims chain A with our released sig, revealing `t`). We hand that txid to
/// `extract_secret`, which binds it to the swap independently — so a wrong or
/// hostile txid can only produce a refusal, never a bad action (the desk may
/// choose what we EXAMINE, never what we CONCLUDE).
async fn wait_for_desk_chain_a_claim(
    state: &SwapState,
    swap_id: &str,
    stop: &AtomicBool,
    t1_unix: i64,
) -> Result<String, ConductorError> {
    let deadline = drive_deadline_unix(t1_unix);
    let mut hb = Heartbeat::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(desk_terminal_or_stopped(state, swap_id).await);
        }
        match client::status(state, swap_id).await {
            Ok(st) => {
                if !st.claim_a_txid.is_empty() {
                    return Ok(st.claim_a_txid);
                }
                if engine::DeskSwapState::parse(&st.state).is_terminal()
                    && !engine::DeskSwapState::parse(&st.state).is_settled()
                {
                    return Err(ConductorError::DeskTerminal {
                        swap_id: swap_id.to_string(),
                        state: st.state,
                    });
                }
                if hb.due() {
                    eprintln!(
                        "[desk::conductor] swap {swap_id}: waiting for the desk to CLAIM chain A \
                         with our released sig — that claim is what reveals `t` to us (desk state \
                         {}); {}m of drive window left",
                        st.state,
                        mins_left(deadline)
                    );
                }
            }
            Err(e) => eprintln!(
                "[desk::conductor] swap {swap_id}: /status poll failed while waiting for the desk's \
                 chain-A claim ({e}); retrying"
            ),
        }
        if watch::unix_now() >= deadline {
            return Err(ConductorError::ClaimSigTimeout {
                swap_id: swap_id.to_string(),
            });
        }
        tokio::time::sleep(STATUS_POLL_INTERVAL).await;
    }
}

/// Classify why the stop flag was raised: a terminal desk state is reported as
/// such; otherwise it was a cooperative stop we treat as a generic terminal. Used
/// when a gate/poll returns `Stopped` so the error names the real cause.
async fn desk_terminal_or_stopped(state: &SwapState, swap_id: &str) -> ConductorError {
    match client::status(state, swap_id).await {
        Ok(st) => ConductorError::DeskTerminal {
            swap_id: swap_id.to_string(),
            state: st.state,
        },
        Err(_) => ConductorError::DeskTerminal {
            swap_id: swap_id.to_string(),
            state: "STOPPED".to_string(),
        },
    }
}

/// Spawn the three chain-facing recovery tasks that run concurrently with the
/// drive and share its stop flag: the reclaim watch (abort-table row 2), and the
/// refund watcher (fires at absolute T1 if the swap is stuck). The observer poll
/// loop is spawned by the caller so it can share the SAME observer the gates read.
///
/// This mirrors what [`super::rehydrate`] spawns on a cold restart — the same net,
/// spawned for a swap driven live this session (rehydrate covers the restart
/// case; this covers the in-session case).
fn spawn_recovery_watchers(
    crypto: &'static VendoredDeskCrypto,
    store: Arc<DeskStore>,
    swap_id: &str,
    t1_unix: i64,
    stop: Arc<AtomicBool>,
) {
    // Reclaim watch: discovers the leader's chain-A refund itself and sweeps
    // chain B off the leaked secret. A no-op for a leader (nothing of ours on B).
    {
        let store = Arc::clone(&store);
        let id = swap_id.to_string();
        let st = Arc::clone(&stop);
        tauri::async_runtime::spawn(async move {
            reclaim::run_reclaim_watch(store, crypto, id, st, observer::POLL_INTERVAL).await;
        });
    }

    // Refund watcher: fires ONCE at absolute T1 unless the swap settles first
    // (stop raised). T1 is wall-clock, so this is correct even across a restart.
    {
        let store = Arc::clone(&store);
        let id = swap_id.to_string();
        let st = Arc::clone(&stop);
        let t1 = t1_unix.max(0) as u64;
        tauri::async_runtime::spawn(async move {
            let outcome = watch::RefundWatcher::new(t1)
                .run(st, watch::unix_now, move || async move {
                    // C40: the deep-abort-aware driver, not the plain refund.
                    //
                    // It still tries the ordinary refund FIRST and returns as
                    // soon as that works, so nothing changes on the normal path.
                    // What it adds is the leader's T2 escape: if the refund will
                    // not go out and T2 has passed, take chain A via B3 rather
                    // than watching a coin sit there.
                    //
                    // Before this, `crypto.swipe()` existed with no caller
                    // anywhere in `src-tauri/src`, and we stored `t2_slot`
                    // without ever acting on it — so a leader whose refund kept
                    // failing had no deep abort at all. Exactly the shape of
                    // D26, mirrored onto us: a complete, role-aware capability
                    // whose caller was only ever built for the role we had
                    // already been playing.
                    refund::execute_deep_abort_and_report(&store, &id, crypto).await;
                })
                .await;
            eprintln!("[desk::conductor] refund watcher for swap ended: {outcome:?}");
        });
    }

    // CC-3: swipe watcher — the T2 sibling. The refund watcher above fires
    // ONCE at T1; if the refund fails there with T2 still ahead, its fire is
    // spent and `TooEarly` is the end of the story. This second schedule is
    // what brings the deep abort back at the ENGINE's T2 (never the
    // advertised one — D48). Leader-only; `run_swipe_watch` loads the record,
    // decides via `swipe_plan`, and logs loudly whichever way it goes (D50).
    {
        let store = Arc::clone(&store);
        let id = swap_id.to_string();
        let st = Arc::clone(&stop);
        tauri::async_runtime::spawn(async move {
            refund::run_swipe_watch(store, crypto, id, st).await;
        });
    }
}

#[cfg(test)]
mod tests {


    // ── CC-23: legSigs, and the leg that decides whether they exist ──────

    /// The gate is derived from the pair label, so there is exactly one place
    /// to be wrong - and ADA must never grow the field, because its M3 is one
    /// adaptor pre-signature and always has been.
    #[test]
    fn only_the_ltc_leg_carries_leg_sigs_cc23() {
        assert!(leg_uses_leg_sigs("XMR/LTC"));
        assert!(leg_uses_leg_sigs("ZEPH/LTC"));
        assert!(leg_uses_leg_sigs("xmr/ltc"), "case must not decide a protocol shape");
        assert!(!leg_uses_leg_sigs("XMR/ADA"));
        assert!(!leg_uses_leg_sigs("ZEPH/ADA"));
        // A contract leg has no M3 at all (CLIENT-2), so it certainly has no pair.
        assert!(!leg_uses_leg_sigs("XMR/AVAX"));
    }

    /// The ADA request must serialize WITHOUT the key, so every ADA M3 stays
    /// byte-identical to one that has already settled. `skip_serializing_if`
    /// is what makes the addition invisible to the leg that does not use it.
    #[test]
    fn an_ada_m3_does_not_grow_a_leg_sigs_key_cc23() {
        let req = wire::RefundSigsRequest {
            refund_presig: wire::AdaptorPresig { r_enc: "aa".into(), sp: "bb".into() },
            claim_cosig: None,
            leg_sigs: None,
            lock_utxo: None,
        };
        let j = serde_json::to_string(&req).unwrap();
        assert!(!j.contains("legSigs"), "ADA M3 grew a legSigs key: {j}");
        assert!(j.contains("refundPresig"));
    }

    /// And the LTC request carries both, under the desk's own field names.
    #[test]
    fn an_ltc_m3_carries_both_signatures_cc23() {
        let req = wire::RefundSigsRequest {
            refund_presig: wire::AdaptorPresig { r_enc: "aa".into(), sp: "bb".into() },
            claim_cosig: None,
            leg_sigs: Some(wire::LegSigs {
                refund_parent_sig: "3045parent".into(),
                refund_spend_sig: "3045spend".into(),
            }),
            lock_utxo: None,
        };
        let j = serde_json::to_string(&req).unwrap();
        assert!(j.contains("\"refundParentSig\":\"3045parent\""), "{j}");
        assert!(j.contains("\"refundSpendSig\":\"3045spend\""), "{j}");
    }

    /// A response that omits the pair decodes as None rather than failing, so
    /// an ADA desk and a pre-CC-23 desk both stay readable. Absence is "this
    /// leg has no pair", never "the pair was empty".
    #[test]
    fn a_response_without_leg_sigs_decodes_as_absent_cc23() {
        let j = r#"{"swapId":"s1","state":"A_LOCKED","refundPresig":{"rEnc":"aa","sp":"bb"},"verified":true}"#;
        let r: wire::RefundSigsResponse = serde_json::from_str(j).unwrap();
        assert!(r.leg_sigs.is_none());
        assert!(r.verified);
        let j2 = r#"{"swapId":"s1","state":"A_LOCKED","refundPresig":{"rEnc":"aa","sp":"bb"},"legSigs":{"refundParentSig":"p","refundSpendSig":"s"},"verified":true}"#;
        let r2: wire::RefundSigsResponse = serde_json::from_str(j2).unwrap();
        let ls = r2.leg_sigs.expect("the pair survived the mirror");
        assert_eq!(ls.refund_parent_sig, "p");
        assert_eq!(ls.refund_spend_sig, "s");
    }

    /// BUY refuses a prepared lock it cannot describe.
    ///
    /// The desk binds its refund pre-signature to exactly this input. An empty
    /// txid or a zero amount yields a signature that protects nothing, and the
    /// failure would not surface until T1 — when the refund it was supposed to
    /// authorise turns out not to work. Cheap to catch before M3.
    #[test]
    fn buy_refuses_a_prepared_lock_it_cannot_describe() {
        let ok = wire::LockUtxo {
            txid: "1149f30b".into(),
            index: 0,
            amount: 27_000_000,
        };
        assert!(check_prepared_lock_utxo("s", &ok).is_ok());

        for bad in [
            wire::LockUtxo { txid: "".into(), index: 0, amount: 27_000_000 },
            wire::LockUtxo { txid: "   ".into(), index: 0, amount: 27_000_000 },
            wire::LockUtxo { txid: "1149f30b".into(), index: 0, amount: 0 },
            // C16: the first funded BUY. 100_000 lovelace is 0.1 tADA, less than
            // the 176_765 its own refund would cost — a lock that cannot be
            // walked away from.
            wire::LockUtxo { txid: "6e7d89ea".into(), index: 0, amount: 100_000 },
            wire::LockUtxo { txid: "6e7d89ea".into(), index: 0, amount: 1_999_999 },
        ] {
            assert!(
                check_prepared_lock_utxo("s", &bad).is_err(),
                "must refuse txid={:?} amount={}",
                bad.txid,
                bad.amount
            );
        }
    }

    /// `not-indexed` is a timing answer, not a verdict — named for the swap it cost.
    ///
    /// `ad13b8c9` reached STAGE 5/7 and then asked Blockfrost for the desk's claim
    /// **seconds** after it was submitted. The engine said `not-indexed`, which its
    /// own contract documents as RETRY (`desk_watch.py:80`), and we treated it as
    /// terminal. The three-state information was in the payload; the caller read
    /// one bit of it.
    #[test]
    fn not_indexed_is_a_retry_not_a_verdict_ad13b8c9() {
        assert_eq!(classify_extraction(true, ""), SecretSighting::Held);
        // Held wins even if a reason is somehow attached — the secret is either in
        // engine memory or it is not.
        assert_eq!(classify_extraction(true, "not-indexed"), SecretSighting::Held);

        assert!(matches!(
            classify_extraction(false, "not-indexed"),
            SecretSighting::NotYet(_)
        ));
        // Transient RPC errors carry their message; the contract says retry.
        assert!(matches!(
            classify_extraction(false, "error: connection reset"),
            SecretSighting::NotYet(_)
        ));
        assert!(matches!(
            classify_extraction(false, "ERROR: Upstream 502"),
            SecretSighting::NotYet(_)
        ));
    }

    /// A reason we do not recognise must stop, not spin — **on our side only**.
    ///
    /// The engine's A2 note is the reason: *"the abort path must not burn the refund
    /// window retrying a permanent failure."* For us a needless stop is recoverable
    /// with one `Invoke-Settle` (the scalar is on a public chain permanently), while
    /// a needless spin eats the window.
    ///
    /// **The desk deliberately classifies unknown reasons the OTHER way**, because
    /// its costs invert: a needless stop abandons a swap it could still complete,
    /// and a needless retry only spends poll cycles it has until T1 anyway.
    ///
    /// **This divergence is intentional and agreed (2026-07-27).** Both sides err
    /// away from their own expensive outcome. A future reader who notices the two
    /// implementations disagree should not make them match — the asymmetry IS the
    /// design, and this test exists to say so.
    #[test]
    fn an_unrecognised_extraction_reason_is_permanent_not_transient() {
        assert!(matches!(
            classify_extraction(false, "unsupported-backend"),
            SecretSighting::NeverWill(_)
        ));
        assert!(matches!(
            classify_extraction(false, "extracted scalar does not match the expected adaptor point"),
            SecretSighting::NeverWill(_)
        ));
        assert!(matches!(
            classify_extraction(false, "something nobody has seen before"),
            SecretSighting::NeverWill(_)
        ));
        // Even an empty reason: we would rather a human read it than loop on it.
        assert!(matches!(
            classify_extraction(false, ""),
            SecretSighting::NeverWill(_)
        ));
    }

    /// Named for swap `46d85388`, which locked 0.1 sXMR against a claim
    /// pre-signature bound to a destination our engine never builds. The
    /// mismatch was discoverable one GET before the lock; it was discovered
    /// one M5 after it.
    #[test]
    fn a_disagreeing_claim_destination_stops_the_lock_that_46d85388_made() {
        let ours = "addr_test1_ours";
        assert_eq!(
            claim_dest_check(ours, ours, ours, "nominated"),
            ClaimDestCheck::Agrees
        );
        assert_eq!(
            claim_dest_check(ours, "addr_test1_theirs", ours, "nominated"),
            ClaimDestCheck::Disagrees,
            "two present-and-different destinations must refuse the lock"
        );
    }

    /// A check that did not run must never read as a check that passed — the
    /// shape that made a `CouldNotLook` sighting worth its own variant.
    #[test]
    fn an_unpublished_claim_destination_is_not_agreement() {
        for (ours, theirs) in [("", "addr"), ("addr", ""), ("", ""), ("  ", "addr")] {
            assert_eq!(
                claim_dest_check(ours, theirs, "addr", "nominated"),
                ClaimDestCheck::Unpublished,
                "ours={ours:?} theirs={theirs:?} must be Unpublished, never Agrees"
            );
        }
    }

    /// BUY passes no nomination, so a DERIVED claim destination is correct there.
    ///
    /// This is the case that makes one guard serve both directions. In BUY the desk
    /// receives the ADA and nobody nominates a destination for it, so `derived` is
    /// the right answer; in SELL the identical value with a nomination outstanding
    /// is the C12 failure. Passing `rec.payout_address` here — our XMR address on
    /// BUY — would have refused every correct BUY drive, which is what
    /// [[swap-desk-buy-readiness]] trap 1 predicted.
    #[test]
    fn a_derived_claim_destination_is_correct_when_we_nominated_nothing() {
        let derived = "addr_test1_the_desks_derived_dest";
        assert_eq!(
            claim_dest_check(derived, derived, "", "derived"),
            ClaimDestCheck::Agrees,
            "BUY: no nomination + derived is the expected, correct outcome"
        );
        // Disagreement is still a refusal in BUY — the direction changes who is
        // hurt by a mismatch, never whether it is one.
        assert_eq!(
            claim_dest_check(derived, "addr_test1_other", "", "derived"),
            ClaimDestCheck::Disagrees
        );
    }

    /// A nomination we sent that the desk reports as `derived` never took, even
    /// when the two values happen to match.
    ///
    /// The values agreeing is not proof the nomination was honoured — a derivation
    /// can coincide with it. `claimDestSource` is the only field that distinguishes
    /// "we agree because you used my address" from "we agree because we both
    /// derived the same one", and only the first is what a nomination asked for.
    #[test]
    fn a_nomination_reported_as_derived_is_refused_even_when_the_values_match() {
        let addr = "addr_test1_ours";
        assert_eq!(
            claim_dest_check(addr, addr, addr, "derived"),
            ClaimDestCheck::AgreedButNotOurs,
            "source=derived with a nomination outstanding means it was dropped"
        );
        assert_eq!(
            claim_dest_check(addr, addr, addr, "nominated"),
            ClaimDestCheck::Agrees
        );
        // A desk that publishes no source at all must not be read as "derived".
        assert_eq!(
            claim_dest_check(addr, addr, addr, ""),
            ClaimDestCheck::Agrees,
            "absent source is unknown, not an accusation"
        );
    }

    /// The limit of a two-party comparison, found by the desk's 93357a1 review.
    /// When a nominated address fails `_is_ada_address`, BOTH engines fall back to
    /// the derived per-swap address and agree perfectly — on a destination the
    /// operator never asked for. **A symmetric substitution is invisible to a
    /// symmetric check**, so the nomination has to be compared separately.
    #[test]
    fn agreement_on_a_destination_we_did_not_nominate_is_still_a_refusal() {
        let derived = "addr_test1_derived_per_swap";
        let asked_for = "addr_test1_the_operators_wallet";
        assert_eq!(
            claim_dest_check(derived, derived, asked_for, "derived"),
            ClaimDestCheck::AgreedButNotOurs,
            "both sides agreeing does not make it the address we chose"
        );
        // No nomination means deriving IS the correct outcome — this must not fire.
        assert_eq!(
            claim_dest_check(derived, derived, "", "derived"),
            ClaimDestCheck::Agrees,
            "with nothing nominated, a derived destination is correct, not a fault"
        );
    }
    use super::*;
    use crate::desk::watch::{Chain, MockObserver};

    fn past() -> u64 {
        watch::unix_now().saturating_sub(1)
    }
    fn future() -> u64 {
        watch::unix_now() + 3600
    }

    /// C29: the heartbeat fires on entry, then rate-limits — the contract
    /// `wait_for_settlement` leans on when it takes `due` ONCE per iteration and
    /// shares it between the can-see and cannot-see arms.
    ///
    /// If each arm called `hb.due()` for itself, the second call within the same
    /// tick would always be false, so the COULD-NOT-LOOK line would never reach
    /// the operator at heartbeat cadence. That is C29 reintroduced by the shape of
    /// its own fix: the loop would still be blind, and now provably so.
    ///
    /// `client::status` has no injection seam, so the loop itself is not unit
    /// testable without threading a status provider through the conductor. This
    /// pins the one property underneath it that is.
    #[test]
    fn heartbeat_fires_on_entry_then_rate_limits_c29() {
        let mut hb = Heartbeat::new();
        assert!(
            hb.due(),
            "entering a wait must announce itself immediately, or the first \
             COULD-NOT-LOOK is swallowed"
        );
        assert!(
            !hb.due(),
            "a second call in the same tick must NOT fire — this is exactly why \
             wait_for_settlement takes `due` once and shares it across both match \
             arms rather than calling hb.due() inside each"
        );
    }

    /// B2's stop gate resolves ambiguity toward STOPPING, which is the opposite
    /// literal from the arm gate and the same principle.
    ///
    /// `PWNDA_CONDUCTOR_CLI_DRIVE` is strict — only `"1"` arms — because an
    /// unrecognised value there must not move funds. Here the costly mistake is
    /// the mirror: the operator meant to stop and we locked chain B anyway. So a
    /// typo must stop, not proceed.
    #[test]
    fn the_b2_stop_gate_fails_toward_stopping() {
        for on in ["1", "true", "TRUE", "yes", " 1 ", "y3s", "please"] {
            assert!(
                stop_before_lock_b_requested(Some(on)),
                "{on:?} must STOP — an unrecognised value here has to resolve toward not \
                 locking chain B, because the expensive mistake is proceeding when the \
                 operator meant to stop"
            );
        }
        for off in ["0", "false", "FALSE", "no", "off", "", "   "] {
            assert!(
                !stop_before_lock_b_requested(Some(off)),
                "{off:?} must NOT stop — an explicit off has to be honoured, or the switch \
                 cannot be turned back off without unsetting it"
            );
        }
        assert!(
            !stop_before_lock_b_requested(None),
            "unset must not stop — the normal funded drive must be unaffected by this gate"
        );
    }

    /// C33: the refund hold stands the chain-B watch down before it starts
    /// waiting, so the refund is not queued behind a cold wallet restore.
    ///
    /// `GRACE_SECS` is 150 and a cold `watch_lock(B)` holds the one serialized
    /// sidecar for ~128s, which left ~7 seconds of margin for the single call in
    /// this protocol that must not be late. This asserts the contention is
    /// removed rather than merely budgeted for.
    ///
    /// The stand-down happens BEFORE the already-past-T1 early return on purpose:
    /// whether or not there is a window left to protect, the drive is ending and
    /// the watch has nothing left to tell anyone.
    #[tokio::test]
    async fn the_refund_hold_stands_the_chain_b_watch_down_c33() {
        let stop = Arc::new(AtomicBool::new(false));
        let watch_b = Arc::new(AtomicBool::new(true));
        // T1 AND T2 far in the past, so the hold returns immediately and the test
        // does not sit for 150s. The quiesce must still have happened.
        let t1_long_past = (watch::unix_now() as i64) - 10_000;
        let t2_long_past = t1_long_past + 600;

        hold_open_for_refund("s-c33", t1_long_past, t2_long_past, &stop, &watch_b).await;

        assert!(
            !watch_b.load(Ordering::SeqCst),
            "the chain-B watch must be stood down for the refund window — a ~128s cold restore \
             holding the one sidecar is what leaves the refund ~7s of margin"
        );
    }

    /// C46 (LADDER-06): the hold must outlive the LAST recovery deadline, not the
    /// first. The refund watcher fires at T1, but when the refund keeps failing the
    /// deep abort takes branch B3 at T2 — and a hold that ends at T1+grace kills
    /// the process 450s (rung pair) or 30min (production) before that branch is
    /// legal. The unattended swipe then exists only as a manual re-run, which is
    /// exactly how this went unnoticed: Invoke-Refund.ps1 was covering the gap.
    #[test]
    fn the_refund_hold_covers_the_deep_abort_window_c46() {
        // The rung pair: T1 = 900, T2 = T1 + 600.
        let t1 = 1_000_000i64;
        let t2 = t1 + 600;
        assert_eq!(
            refund_hold_until(t1, t2),
            (t2 as u64) + 150,
            "with a real T2 the hold must run to T2+grace — T1+grace ends 450s before \
             the deep abort becomes legal on the rung pair"
        );
        // Degenerate T2 (stub-era record, or zero) degrades to the OLD bound, not
        // to an instant return.
        assert_eq!(refund_hold_until(t1, 0), (t1 as u64) + 150);
        // And a hostile/garbage negative pair cannot underflow into a huge hold.
        assert_eq!(refund_hold_until(-5, -9), 150);
    }

    /// CC-11 fixture: a mid-flight record in the 07-28 BUY shape — we lead,
    /// our ADA is locked, the swap is live.
    fn cc11_rec() -> StoredSwap {
        let m1: wire::AcceptResponse = serde_json::from_str(
            r#"{"swapId":"cc11","pair":"XMR/ADA","direction":"BUY_FOLLOWER","deskRole":"FOLLOWER","coinIn":"ADA","coinOut":"XMR","amountA":"27","amountB":"0.1","t0":10,"t1":1000,"t2":1600,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":"ap","viewKey":"vk","dleqProof":null,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#,
        )
        .unwrap();
        let mut rec = StoredSwap::from_accept(&m1, "payout", "refund", 0);
        rec.state = "A_LOCKED".into();
        rec.lock_a_txid = Some("lockA-ours".into());
        rec
    }

    /// CC-11: a failed drive with OUR leg locked must hold — and the bound is
    /// CC-2's engine T2 when the record carries one. On the 07-28 run the
    /// process aborted 125s in instead; every watcher for the swap died with
    /// it. This pins the decision that replaces the `.expect()`.
    #[test]
    fn a_failed_drive_with_our_leg_locked_holds_to_the_engines_t2_cc11() {
        let mut rec = cc11_rec();
        rec.t2_engine_unix = Some(2_800); // engine committed T1+1800; wire said T1+600
        assert_eq!(
            recovery_hold_bound(&rec),
            Some((1_000, 2_800)),
            "NO VIGIL would run for a locked, live swap — the 07-28 process death repeated"
        );

        // Without an engine T2 the hold degrades to the advertised bound — a
        // LIFETIME degrades gracefully; only the swipe DECISION refuses (CC-2).
        rec.t2_engine_unix = None;
        assert_eq!(recovery_hold_bound(&rec), Some((1_000, 1_600)));
    }

    /// CC-11: failures that cost nothing exit freely — terminal swaps, and
    /// drives that died before OUR leg locked (the counterparty's lock is not
    /// ours to hold for).
    #[test]
    fn a_failed_drive_with_nothing_of_ours_locked_exits_freely_cc11() {
        // Nothing locked at all.
        let mut rec = cc11_rec();
        rec.lock_a_txid = None;
        assert_eq!(recovery_hold_bound(&rec), None, "no lock, no funds at risk, no vigil");

        // Only the DESK's leg is on chain (we lead ⇒ ours is A, theirs is B).
        let mut rec = cc11_rec();
        rec.lock_a_txid = None;
        rec.lock_b_txid = Some("lockB-desk".into());
        assert_eq!(
            recovery_hold_bound(&rec),
            None,
            "the counterparty's lock is not ours to hold a process open for"
        );

        // Terminal: the swap already resolved; a vigil would be a lie in the log.
        let mut rec = cc11_rec();
        rec.state = "SETTLED".into();
        assert_eq!(recovery_hold_bound(&rec), None);

        // And the follower shape: our leg is B, and with it locked we DO hold.
        let mut rec = cc11_rec();
        rec.direction = "SELL_FOLLOWER".into();
        rec.desk_role = "LEADER".into();
        rec.lock_a_txid = Some("lockA-desk".into());
        rec.lock_b_txid = Some("lockB-ours".into());
        assert_eq!(recovery_hold_bound(&rec), Some((1_000, 1_600)));
    }

    /// The observe-before-lock precondition, pinned. With chain A UNCONFIRMED the
    /// SELL gate must NOT return `Confirmed` — it returns `Deadline` (here, via a
    /// deadline already in the past) rather than letting the conductor proceed to
    /// lock chain B. This is the funds-stranding case the desk caught, so it gets
    /// a test whose failure means the driver would lock the scriptless coin blind.
    #[tokio::test]
    async fn gate_blocks_until_chain_a_confirmed() {
        let obs = MockObserver::new(); // both legs NotYet by default
        let stop = AtomicBool::new(false);

        // Unconfirmed A + a past deadline -> Deadline, never Confirmed.
        assert_eq!(
            wait_for_lock_gate(&obs, &stop, 3, past(), Duration::from_millis(1), watch::Chain::A, "t").await,
            GateOutcome::Deadline,
            "the gate must NOT confirm while chain A is unconfirmed"
        );

        // Confirm A to the required depth -> the gate passes immediately, even
        // against a deadline (it checks the gate before the deadline).
        obs.set_confirmed(Chain::A, 3);
        assert_eq!(
            wait_for_lock_gate(&obs, &stop, 3, past(), Duration::from_millis(1), watch::Chain::A, "t").await,
            GateOutcome::Confirmed,
            "a chain-A lock confirmed to depth must let the lock proceed"
        );
    }

    /// A shallow chain-A confirmation must not satisfy a deeper required depth —
    /// the reorg floor is real, and `SwapDepths` applies it. Here A is confirmed
    /// to 2 but the gate wants 3.
    #[tokio::test]
    async fn gate_respects_the_required_depth() {
        let obs = MockObserver::new();
        obs.set_confirmed(Chain::A, 2);
        let stop = AtomicBool::new(false);
        assert_eq!(
            wait_for_lock_gate(&obs, &stop, 3, past(), Duration::from_millis(1), watch::Chain::A, "t").await,
            GateOutcome::Deadline,
            "2 confs must not satisfy a depth-3 gate"
        );
        obs.set_confirmed(Chain::A, 3);
        assert_eq!(
            wait_for_lock_gate(&obs, &stop, 3, future(), Duration::from_millis(1), watch::Chain::A, "t").await,
            GateOutcome::Confirmed
        );
    }

    /// A BLIND observer (CouldNotLook — our visibility failed) must not pass the
    /// gate either. "We cannot see the chain" is not "the counterparty locked".
    #[tokio::test]
    async fn a_blind_observer_never_confirms_the_gate() {
        // A fresh SidecarObserver starts blind (CouldNotLook, "no poll yet").
        let obs = SidecarObserver::new();
        let stop = AtomicBool::new(false);
        assert_eq!(
            wait_for_lock_gate(&obs, &stop, 1, past(), Duration::from_millis(1), watch::Chain::A, "t").await,
            GateOutcome::Deadline,
            "a blind observer must block the lock, not pass it"
        );
    }

    /// The stop flag wins immediately — a cooperative settle / terminal desk state
    /// stops the wait without locking anything.
    #[tokio::test]
    async fn a_raised_stop_flag_ends_the_wait() {
        let obs = MockObserver::new();
        let stop = AtomicBool::new(true);
        assert_eq!(
            wait_for_lock_gate(&obs, &stop, 1, future(), Duration::from_millis(1), watch::Chain::A, "t").await,
            GateOutcome::Stopped
        );
        // ...and the BUY release gate behaves the same way.
        assert_eq!(
            wait_for_release_gate(&obs, &stop, 1, future(), Duration::from_millis(1), "t").await,
            GateOutcome::Stopped
        );
    }

    /// The BUY release gate is the mirror: it gates on chain B, not chain A.
    /// Confirming A must NOT unblock it; confirming B must.
    #[tokio::test]
    async fn the_release_gate_gates_on_chain_b_not_chain_a() {
        let obs = MockObserver::new();
        let stop = AtomicBool::new(false);
        obs.set_confirmed(Chain::A, 10); // A deep, B still NotYet
        assert_eq!(
            wait_for_release_gate(&obs, &stop, 1, past(), Duration::from_millis(1), "t").await,
            GateOutcome::Deadline,
            "confirming chain A must not release the BUY claim sig — that gate is chain B"
        );
        obs.set_confirmed(Chain::B, 1);
        assert_eq!(
            wait_for_release_gate(&obs, &stop, 1, future(), Duration::from_millis(1), "t").await,
            GateOutcome::Confirmed
        );
    }

    /// The drive deadline sits a margin BEFORE T1, never after — the conductor
    /// must stop driving before the refund watcher's deadline, not race it.
    #[test]
    fn the_drive_deadline_is_before_t1() {
        let t1: i64 = 1_000_000;
        assert!(drive_deadline_unix(t1) < t1 as u64);
        // A tiny or zero T1 saturates to 0 rather than underflowing.
        assert_eq!(drive_deadline_unix(0), 0);
        assert_eq!(drive_deadline_unix(-5), 0);
    }

    /// The stand-down guard: the refund net comes down ONLY when our leg is
    /// unlocked (nothing at risk) or the swap is settled/recovered — never on a
    /// locked-and-unsettled swap (a submitted-but-unconfirmed claim, or an errored
    /// drive), where the refund watcher must survive to T1.
    #[test]
    fn should_stand_down_only_when_safe() {
        use crate::desk::store::{DeskStore, StoredSwap};
        let dir = std::env::temp_dir().join(format!(
            "pwnda-conductor-standdown-{}-{}",
            std::process::id(),
            watch::unix_now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = DeskStore::open_with_key(&dir, zeroize::Zeroizing::new([3u8; 32])).unwrap();
        let m1: wire::AcceptResponse = serde_json::from_str(
            r#"{"swapId":"sd1","pair":"XMR/ADA","direction":"SELL_FOLLOWER","deskRole":"LEADER","coinIn":"XMR","coinOut":"ADA","amountA":"27","amountB":"0.1","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":null,"viewKey":null,"dleqProof":null,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#,
        )
        .unwrap();
        let save = |lock_b: Option<&str>, state: &str| {
            let mut rec = StoredSwap::from_accept(&m1, "payout", "refund", 0);
            rec.lock_b_txid = lock_b.map(String::from);
            rec.state = state.to_string();
            store.save(&rec).unwrap();
        };

        // Never locked our leg -> nothing at risk -> stand down.
        save(None, "ACCEPTED");
        assert!(should_stand_down(&store, "sd1", ClientRole::Follower));

        // Locked B, still in flight -> KEEP the net.
        save(Some("lockB"), "B_LOCKED");
        assert!(!should_stand_down(&store, "sd1", ClientRole::Follower));

        // Locked B, submitted-but-unconfirmed claim (A_CLAIMED) -> KEEP the net.
        save(Some("lockB"), "A_CLAIMED");
        assert!(!should_stand_down(&store, "sd1", ClientRole::Follower));

        // Settled -> stand down.
        save(Some("lockB"), "SETTLED");
        assert!(should_stand_down(&store, "sd1", ClientRole::Follower));

        // Recovered (refunded) -> stand down.
        save(Some("lockB"), "A_REFUNDED");
        assert!(should_stand_down(&store, "sd1", ClientRole::Follower));

        // A record we cannot load -> keep the net (safe default).
        assert!(!should_stand_down(&store, "no-such-swap", ClientRole::Follower));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ─────────────────────────── CLI funded entry point ────────────────────────
//
// The "CLI / non-#[ignore] test entry point" the operator asked for, in the same
// #[ignore] shape as the existing `desk::client::live_sell_follower_to_settled`:
// runnable ON DEMAND against a real armed desk, skipped by the default suite
// because it needs a running desk + the armed engine + testnet funds. It calls
// the SAME `run_swap_choreography` the UI's `desk_proceed` will — proving the
// funded client→desk swap with no UI in the loop.
//
// This is deliberately its own module so the heavy live imports do not touch the
// unit-test module above.
#[cfg(test)]
mod cli_entry {
    //! The real funded driver — the "CLI entry point" the operator runs to prove
    //! the funded client→desk swap WITHOUT the UI, calling the SAME
    //! [`run_swap_choreography`] the UI's `desk_proceed` will.
    //!
    //! Run it (operator, ONLY after the desk arms its side and the conductor is
    //! reviewed):
    //!
    //! ```text
    //!   source client-testnet.env.sh                 # PWNDA_DESK_ARM + engine + wallet-rpc + blockfrost + state key
    //!   export DESK_URL=http://127.0.0.1:<i2p-proxy-port>   # the desk's .b32 via the i2p proxy (or the loopback -dev desk)
    //!   export PWNDA_CLI_PAYOUT_ADDR=<your preprod ADA receive addr>
    //!   export PWNDA_CLI_REFUND_ADDR=<your stagenet XMR refund addr>
    //!   export PWNDA_CLI_AMOUNT=0.1                   # XMR to sell (optional; default 0.1)
    //!   export PWNDA_CONDUCTOR_CLI_DRIVE=1            # SEPARATE, explicit funds-moving opt-in
    //!   cargo test --lib desk::conductor::cli_entry -- --ignored --nocapture
    //! ```
    //!
    //! Two independent gates guard the funds-moving path, so neither the default
    //! suite nor a blanket `cargo test -- --ignored` with a testnet env present can
    //! move a coin by accident: (1) `#[ignore]` + the full funded env must be
    //! set, and (2) `PWNDA_CONDUCTOR_CLI_DRIVE=1` — a flag unique to this driver,
    //! not shared with rung2b or any other env — must be set for the lock to run.
    //! Without (2) the test wires all the way through accept and stops.
    use super::*;
    use zeroize::Zeroizing;

    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty())
    }

    /// SKIP (with a printed reason) unless the full funded environment is present.
    /// Same discipline as rung2b: "skipped" with no reason is how a check silently
    /// stops running.
    fn funded_env_ready() -> bool {
        for k in [
            "PWNDA_DESK_ARM",
            "PWNDA_ENGINE_PYTHON",
            "PWNDA_ENGINE_DIR",
            "ADA_ENGINE_ENV",
            "BLOCKFROST_PROJECT_ID",
            "XMR_WALLET_RPC",
            "ADA_ENGINE_STATE_KEY",
            "DESK_URL",
        ] {
            if env(k).is_none() {
                eprintln!("cli_entry: SKIPPED — {k} is not set (needs the full funded testnet env)");
                return false;
            }
        }
        true
    }

    /// A fresh enrolled desk identity pointed at `base`. The ed25519 auth identity
    /// is separate from wallet funds (which live in the loopback wallet-rpc / the
    /// ADA funding key), so a fresh identity per run is fine on testnet.
    async fn enrolled_state(base: &str, data_dir: std::path::PathBuf) -> Result<SwapState, String> {
        let state = SwapState::new();
        state.set_proxy_url(base.to_string());
        state.set_data_dir(data_dir);
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        let pubkey = crate::swap::auth::pubkey_b64(&seed);
        state.set_seed(Zeroizing::new(seed), pubkey.clone());
        let (status, body) = crate::swap::proxy::enroll(base, &pubkey)
            .await
            .map_err(|e| format!("enroll call failed: {e}"))?;
        if status != 200 {
            return Err(format!("enroll returned {status}: {body}"));
        }
        Ok(state)
    }

    #[tokio::test]
    #[ignore = "funded: needs a running armed desk + testnet funds. Operator-run — see module doc."]
    async fn cli_funded_sell_follower() {
        if !funded_env_ready() {
            return;
        }
        let base = env("DESK_URL").expect("checked in funded_env_ready");
        let data_dir = std::path::PathBuf::from(
            env("PWNDA_CLI_DATA_DIR")
                .unwrap_or_else(|| std::env::temp_dir().join("pwnda-conductor-cli").display().to_string()),
        );
        std::fs::create_dir_all(&data_dir).expect("create cli data dir");

        // Arm the real engine FIRST — before ANY active_crypto() call would
        // otherwise initialize the Mock provider (the global is set-once). If the
        // arm gate faults it prints DESK-ARM-FAULT and stays Mock, which the
        // assertion below turns into a clear failure.
        crate::desk::arm::install_from_env(data_dir.join("desk-engine"));
        assert!(
            crate::desk::crypto::crypto_is_production_ready(),
            "engine did not arm — check PWNDA_DESK_ARM + the testnet config (a DESK-ARM-FAULT: \
             line on stderr names the missing piece). Cannot drive a funded swap on Mock crypto."
        );

        let state = enrolled_state(&base, data_dir).await.expect("enroll the desk identity");
        let watchers = DeskWatchers::default();

        let amount = env("PWNDA_CLI_AMOUNT").unwrap_or_else(|| "0.1".to_string());
        let payout = env("PWNDA_CLI_PAYOUT_ADDR")
            .expect("PWNDA_CLI_PAYOUT_ADDR — the client's preprod ADA receive address");
        let refund = env("PWNDA_CLI_REFUND_ADDR")
            .expect("PWNDA_CLI_REFUND_ADDR — the client's stagenet XMR refund address");

        // Quote SELL_FOLLOWER (the direction driven first).
        // A quote has no side effect, so it is the one pre-commitment call that is
        // safe to retry. Over I2P a single blip should not end a run before
        // anything is at stake — it did on 2026-07-26.
        let qreq = wire::QuoteRequest {
            pair: "XMR/ADA".into(),
            direction: "SELL_FOLLOWER".into(),
            amount_in: amount,
        };
        let q = retry_while_desk_busy("<pre-accept>", "quote", || async {
            client::quote(&state, &qreq).await
        })
        .await
        .expect("quote");
        assert_eq!(q.desk_role, "LEADER", "SELL_FOLLOWER => the desk leads");

        // Accept + the M1/M2/ingest handshake, via the SAME helper `desk_accept`
        // uses — no duplicated protocol. Moves no funds.
        let rec = crate::desk::commands::accept_and_persist(
            &state,
            q.quote_id,
            "XMR/ADA".into(),
            "SELL_FOLLOWER".into(),
            payout,
            refund,
        )
        .await
        .unwrap_or_else(|e| {
            // A transport failure during accept/M2 costs NOTHING — no lock exists,
            // no pre-signature has been exchanged, and the half-built swap on the
            // desk expires at T0. Say so, because a panic on a raw reqwest string
            // reads like a protocol fault and this is the third drive lost to an
            // I2P blip before anything was at stake.
            //
            // Deliberately NOT retried. `accept_and_persist` is accept + keys +
            // ingest: retrying the bundle would create a SECOND swap, and retrying
            // `keys` alone is not provably safe either — the desk accepts it while
            // ACCEPTED and re-runs ingestion, which is the re-derivation shape that
            // cost D17. A free failure and a manual re-run beat a clever retry that
            // could strand a leg.
            let transport = e.contains("error sending request") || e.contains("timed out");
            panic!(
                "accept + handshake: {e}{}",
                if transport {
                    "

  This is a TRANSPORT failure, not a protocol fault. Nothing is on                      chain, no key material was exchanged, and the partial swap on the desk                      expires at T0. Just re-run the same command — a new swap id is correct                      here, and retrying this call automatically is deliberately not done."
                } else {
                    ""
                }
            )
        });
        let swap_id = rec.swap_id.clone();
        eprintln!("cli_entry: accepted swap {swap_id} (vendored crypto). Handshake complete.");

        // GATE 2: the funds-moving drive needs its OWN explicit opt-in, distinct
        // from the general funded env, so a blanket `cargo test -- --ignored`
        // cannot lock a coin. Without it, we have proven the wiring up to accept
        // and stop.
        if env("PWNDA_CONDUCTOR_CLI_DRIVE").as_deref() != Some("1") {
            eprintln!(
                "cli_entry: wired through accept for swap {swap_id}. Set \
                 PWNDA_CONDUCTOR_CLI_DRIVE=1 to DRIVE the funded swap (this LOCKS XMR). Held here \
                 by design — do not drive before the desk has reviewed the conductor ordering."
            );
            return;
        }

        // DRIVE — the exact same entry point `desk_proceed` calls.
        //
        // CC-11: never `.expect()` this. In a CLI drive the process IS the
        // runtime — a panic here aborts every watcher for the swap, which is
        // how the 07-28 BUY leg died 125s in with its ADA locked. On Err the
        // vigil below keeps the process alive through the recovery windows,
        // and only THEN does the run report failure.
        let outcome = match run_swap_choreography(&state, &watchers, &swap_id).await {
            Ok(o) => o,
            Err(e) => {
                eprintln!("cli_entry: swap {swap_id} — the drive FAILED: {e}");
                hold_for_recovery_after_failed_drive(&state, &watchers, &swap_id).await;
                panic!(
                    "run_swap_choreography failed (the recovery vigil above ran to completion \
                     first — the watchers had their windows): {e}"
                );
            }
        };
        match outcome {
            ConductorOutcome::Claimed { chain, txid } => {
                eprintln!("cli_entry: swap {swap_id} — claimed chain {chain}, txid {txid}");
                assert_eq!(chain, "A", "SELL_FOLLOWER settles by claiming chain A (ADA)");
            }
            // Abort-path rung B2. A pass, not a failure: the run stopped where it
            // was told to, before the first irreversible client step.
            ConductorOutcome::StoppedBeforeLockB { swap_id } => {
                eprintln!(
                    "cli_entry: swap {swap_id} — STOPPED BEFORE LOCK B by \
                     PWNDA_CONDUCTOR_STOP_BEFORE_LOCK_B. Our XMR never moved; the desk now has a \
                     chain-A lock to refund at T1. That refund is the thing under test."
                );
            }
        }
    }

    #[tokio::test]
    #[ignore = "funded: needs a running armed desk + testnet ADA. Operator-run — see module doc."]
    async fn cli_funded_buy_leader() {
        if !funded_env_ready() {
            return;
        }
        let base = env("DESK_URL").expect("checked in funded_env_ready");
        let data_dir = std::path::PathBuf::from(
            env("PWNDA_CLI_DATA_DIR").unwrap_or_else(|| {
                std::env::temp_dir().join("pwnda-conductor-cli").display().to_string()
            }),
        );
        std::fs::create_dir_all(&data_dir).expect("create cli data dir");

        crate::desk::arm::install_from_env(data_dir.join("desk-engine"));
        assert!(
            crate::desk::crypto::crypto_is_production_ready(),
            "engine did not arm — cannot drive a funded swap on Mock crypto."
        );

        let state = enrolled_state(&base, data_dir).await.expect("enroll the desk identity");
        let watchers = DeskWatchers::default();

        // BUY INVERTS THE ADDRESS ROLES. We lock ADA and receive XMR, so the payout
        // is a Monero address and the refund is a Cardano one — the opposite of
        // SELL. `Import-SwapEnv -Direction Buy` assigns them; this entry just reads
        // the slots, and deliberately does NOT re-derive which is which. A second
        // place deciding that is a second place to get it wrong, which is the
        // payout_address family's whole history (D16–D22).
        let amount = env("PWNDA_CLI_AMOUNT").unwrap_or_else(|| "0.1".to_string());
        let payout = env("PWNDA_CLI_PAYOUT_ADDR")
            .expect("PWNDA_CLI_PAYOUT_ADDR — on BUY this is our stagenet XMR receive address");
        let refund = env("PWNDA_CLI_REFUND_ADDR")
            .expect("PWNDA_CLI_REFUND_ADDR — on BUY this is our preprod ADA refund address");

        // Fail loudly rather than driving a swap whose payout would go nowhere we
        // watch. The env layer is where three of the four BUY traps lived, so it
        // gets asserted here too and not only in preflight — preflight is a
        // separate process an operator can skip.
        assert!(
            payout.starts_with('5') || payout.starts_with('7'),
            "BUY payout must be a stagenet XMR address (we RECEIVE XMR); got {payout}. \\
             Run Import-SwapEnv -Direction Buy."
        );
        assert!(
            refund.starts_with("addr_test1"),
            "BUY refund must be a preprod ADA address (our own chain-A lock refunds there); \\
             got {refund}. Run Import-SwapEnv -Direction Buy."
        );

        // A quote has no side effect, so it is the one pre-commitment call that is
        // safe to retry. Over I2P a single blip should not end a run before
        // anything is at stake — it did on 2026-07-26.
        let qreq = wire::QuoteRequest {
            pair: "XMR/ADA".into(),
            direction: "BUY_FOLLOWER".into(),
            amount_in: amount,
        };
        let q = retry_while_desk_busy("<pre-accept>", "quote", || async {
            client::quote(&state, &qreq).await
        })
        .await
        .expect("quote");
        assert_eq!(
            q.desk_role, "FOLLOWER",
            "BUY_FOLLOWER => the desk follows and WE lead"
        );

        let rec = crate::desk::commands::accept_and_persist(
            &state,
            q.quote_id,
            "XMR/ADA".into(),
            "BUY_FOLLOWER".into(),
            payout,
            refund,
        )
        .await
        .unwrap_or_else(|e| {
            // A transport failure during accept/M2 costs NOTHING — no lock exists,
            // no pre-signature has been exchanged, and the half-built swap on the
            // desk expires at T0. Say so, because a panic on a raw reqwest string
            // reads like a protocol fault and this is the third drive lost to an
            // I2P blip before anything was at stake.
            //
            // Deliberately NOT retried. `accept_and_persist` is accept + keys +
            // ingest: retrying the bundle would create a SECOND swap, and retrying
            // `keys` alone is not provably safe either — the desk accepts it while
            // ACCEPTED and re-runs ingestion, which is the re-derivation shape that
            // cost D17. A free failure and a manual re-run beat a clever retry that
            // could strand a leg.
            let transport = e.contains("error sending request") || e.contains("timed out");
            panic!(
                "accept + handshake: {e}{}",
                if transport {
                    "

  This is a TRANSPORT failure, not a protocol fault. Nothing is on                      chain, no key material was exchanged, and the partial swap on the desk                      expires at T0. Just re-run the same command — a new swap id is correct                      here, and retrying this call automatically is deliberately not done."
                } else {
                    ""
                }
            )
        });
        let swap_id = rec.swap_id.clone();
        eprintln!("cli_entry: accepted BUY swap {swap_id} (vendored crypto). Handshake complete.");

        // Same two-gate design as SELL, and the same reasoning: a blanket
        // `cargo test -- --ignored` must not be able to lock a coin. BUY's first
        // irreversible act is submitting OUR chain-A lock, so the gate sits here.
        if env("PWNDA_CONDUCTOR_CLI_DRIVE").as_deref() != Some("1") {
            eprintln!(
                "cli_entry: wired through accept for BUY swap {swap_id}. Set \\
                 PWNDA_CONDUCTOR_CLI_DRIVE=1 to DRIVE (this LOCKS ADA)."
            );
            return;
        }

        // CC-11: same boundary rule as the SELL entry — and THIS is the exact
        // line the 07-28 crash came through: `.expect()` on an engine timeout
        // (`set_lock_b_txid`, 12s) 125 seconds after our ADA locked.
        let outcome = match run_swap_choreography(&state, &watchers, &swap_id).await {
            Ok(o) => o,
            Err(e) => {
                eprintln!("cli_entry: BUY swap {swap_id} — the drive FAILED: {e}");
                hold_for_recovery_after_failed_drive(&state, &watchers, &swap_id).await;
                panic!(
                    "run_swap_choreography failed (the recovery vigil above ran to completion \
                     first — the watchers had their windows): {e}"
                );
            }
        };
        match outcome {
            ConductorOutcome::Claimed { chain, txid } => {
                eprintln!("cli_entry: BUY swap {swap_id} — settled on chain {chain}, txid {txid}");
                // BUY settles by SWEEPING chain B: the desk claims chain A, revealing
                // `t`, and we sweep the XMR. The mirror of SELL's chain-A claim.
                assert_eq!(chain, "B", "BUY_FOLLOWER settles by sweeping chain B (XMR)");
            }
            // Unreachable by construction, and asserted rather than ignored. The
            // B2 stop lives at the site where the CLIENT locks the scriptless
            // coin, which only exists when we FOLLOW. On BUY we lead and lock
            // chain A first, so `buy_leader` has no such site — if this ever
            // fires, the gate has been copied into the wrong role, which is the
            // C9/C16 shape (a precondition belonging to the other direction).
            ConductorOutcome::StoppedBeforeLockB { swap_id } => {
                panic!(
                    "BUY swap {swap_id} reported StoppedBeforeLockB — that stop belongs to \
                     SELL, where the client locks chain B. On BUY the client leads and the desk \
                     locks chain B, so this outcome means the gate was placed in the wrong role."
                );
            }
        }
    }
}

// Finish a BUY whose desk-claim landed but whose sweep never ran.
//
// BUY's tail is `extract_secret` from the desk's chain-A claim, then `claim` to
// sweep chain B. Both happen in the last seconds of a drive, and the drive is a
// single process: if it dies between the desk's claim confirming and our sweep,
// the swap sits half-done with the counterparty paid and our leg untouched.
//
// **That is not a loss and there is no race.** `t` is public in the desk's claim
// witness the moment it confirms, and it stays public. The desk cannot take the
// chain-B coin back: the follower's reclaim needs the LEADER's chain-A refund to
// leak `s_a`, and our chain-A lock has already been spent by their claim, so that
// refund can never exist. The XMR waits for us indefinitely.
//
// Found on swap `ad13b8c9` (2026-07-27), the first BUY to reach STAGE 5/7. The
// desk claimed, we tried to extract `t` seconds later, and Blockfrost had not yet
// indexed the transaction — `not-indexed`. The conductor refused to call `claim`
// without the secret, which is right; then the machine restarted and took the
// process with it.
//
// `Resume-Swap` deliberately refuses BUY (its tail is a CLAIM, ours is a SWEEP),
// so this is the BUY-shaped sibling of `cli_resume`.
//
// Run it (operator):
//
// ```text
//   export PWNDA_CLI_SETTLE_SWAP=<swap_id>
//   export PWNDA_CLI_DESK_CLAIM_TXID=<the desk's chain-A claim txid>
//   #  dry run first: reports what it would do and stops
//   export PWNDA_CONDUCTOR_CLI_SETTLE=1     # then re-run to sweep
//   cargo test --features full --lib desk::conductor::cli_settle -- --ignored --nocapture
// ```
//
// **It does not trust the supplied txid.** `extract_secret` binds the recovered
// scalar to the expected adaptor point, so a wrong or hostile txid yields a
// refusal, never a false sweep. The operator chooses what we examine; never what
// we conclude.
#[cfg(test)]
mod cli_settle {
    use super::*;

    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty())
    }

    #[tokio::test]
    #[ignore = "funded: sweeps chain B for a half-settled BUY. Operator-run — see module doc."]
    async fn cli_settle_buy_sweep_chain_b() {
        let swap_id = match env("PWNDA_CLI_SETTLE_SWAP") {
            Some(v) => v,
            None => {
                eprintln!(
                    "cli_settle: SKIPPED — PWNDA_CLI_SETTLE_SWAP is not set. Expected the id of a \
                     BUY we led whose chain-B leg is still unswept."
                );
                return;
            }
        };
        let claim_txid = match env("PWNDA_CLI_DESK_CLAIM_TXID") {
            Some(v) => v,
            None => {
                eprintln!(
                    "cli_settle: SKIPPED — PWNDA_CLI_DESK_CLAIM_TXID is not set. It is the desk's \
                     chain-A claim, the transaction whose witness carries `t`."
                );
                return;
            }
        };

        let data_dir = std::path::PathBuf::from(env("PWNDA_CLI_DATA_DIR").unwrap_or_else(|| {
            std::env::temp_dir().join("pwnda-conductor-cli").display().to_string()
        }));
        eprintln!("cli_settle: data dir {}", data_dir.display());

        crate::desk::arm::install_from_env(data_dir.join("desk-engine"));
        let crypto: &'static VendoredDeskCrypto = match crypto::active_crypto() {
            ActiveCrypto::Vendored(v) => v,
            ActiveCrypto::Mock(_) => panic!(
                "engine did not arm — a DESK-ARM-FAULT: line on stderr names the missing piece. \
                 Refusing to sweep on Mock crypto."
            ),
        };
        let store = DeskStore::open(&data_dir).expect("open the desk store");
        let mut rec = store
            .load(&swap_id)
            .unwrap_or_else(|e| panic!("load swap {swap_id}: {e}"));

        eprintln!(
            "cli_settle: swap {swap_id}\n  \
             desk_role   {}  (we {})\n  \
             state       {}\n  \
             lock_a      {}\n  \
             lock_b      {}\n  \
             desk claim  {claim_txid}",
            rec.desk_role,
            if rec.desk_role == "FOLLOWER" { "LED — this is a BUY" } else { "FOLLOWED — this is a SELL" },
            rec.state,
            rec.lock_a_txid.as_deref().unwrap_or("<none>"),
            rec.lock_b_txid.as_deref().unwrap_or("<none>"),
        );

        // Refuse the cases where a sweep is wrong, before the flag is consulted.
        if rec.desk_role != "FOLLOWER" {
            eprintln!(
                "cli_settle: REFUSING — desk_role={} means we FOLLOWED (a SELL). There our tail is \
                 a chain-A CLAIM, not a chain-B sweep; use Resume-Swap.",
                rec.desk_role
            );
            return;
        }
        if rec.lock_b_txid.as_deref().unwrap_or("").is_empty() {
            eprintln!(
                "cli_settle: REFUSING — no chain-B lock recorded. The desk never locked, so there \
                 is nothing to sweep and our chain-A leg is a T1 refund story instead."
            );
            return;
        }
        if rec.state == "SETTLED" {
            eprintln!("cli_settle: nothing to do — swap {swap_id} is already SETTLED.");
            return;
        }

        // Extract FIRST, and report, even on a dry run. This is the read-only half
        // and it is the half that can fail for an interesting reason — `not-indexed`
        // is a timing answer, `NotTheRefund` is a binding refusal, and an operator
        // needs to know which before arming anything.
        let extraction = crypto
            .extract_secret(&swap_id, &claim_txid)
            .await
            .unwrap_or_else(|e| panic!("extract_secret from {claim_txid}: {e}"));
        if !extraction.secret_held {
            eprintln!(
                "cli_settle: `t` NOT recovered from {claim_txid} — reason: {}.\n  \
                 `not-indexed` means the explorer has not caught up; wait and re-run.\n  \
                 Anything else means this txid does not carry the swap's secret, and the sweep \
                 would be wrong — the binding to the adaptor point is what refuses it.",
                extraction.reason
            );
            return;
        }
        eprintln!("cli_settle: `t` EXTRACTED from {claim_txid} — the chain-B sweep can proceed");

        if env("PWNDA_CONDUCTOR_CLI_SETTLE").as_deref() != Some("1") {
            eprintln!(
                "cli_settle: DRY RUN — the secret is recovered and the sweep is ready. Set \
                 PWNDA_CONDUCTOR_CLI_SETTLE=1 to actually sweep chain B."
            );
            return;
        }

        eprintln!("cli_settle: ARMED — sweeping chain B for {swap_id} (this can take minutes)");
        let sweep_txid = crypto
            .claim(&swap_id)
            .await
            .unwrap_or_else(|e| panic!("claim (chain-B sweep): {e}"));
        rec.state = "SETTLED".to_string();
        store.save(&rec).unwrap_or_else(|e| {
            // The coin has MOVED at this point. A store write that fails must not
            // read as a sweep that failed.
            eprintln!(
                "cli_settle: SWEEP SUCCEEDED (txid {sweep_txid}) but the record could not be \
                 updated: {e}. The funds are home; the state file is stale."
            )
        });
        eprintln!("cli_settle: SETTLED — chain-B sweep txid {sweep_txid}");
    }
}

// The chain-A refund entry, for a BUY we led and abandoned. The mirror of
// `cli_reclaim`, and it exists for the same reason plus one worse one.
//
// `cli_reclaim` covers the SELL abort: the desk refunds chain A, leaks `s_a`, and
// we sweep chain B. This covers the BUY abort, where the roles invert: WE locked
// chain A, so WE are the party who refunds it at T1 using the counterparty's
// pre-signature that M3 verified before we ever submitted the lock.
//
// **Why it cannot be left to the watcher.** `run_swap_choreography` spawns a
// `RefundWatcher` that fires at absolute T1 — but the drive's own gates give up at
// `drive_deadline_unix` = T1 minus 90 seconds. When a gate deadlines the drive
// returns an error, the test process exits, and every watcher it spawned dies
// with it: **ninety seconds before the refund it was waiting for becomes valid.**
// Found on swap `967c76b9`, the first funded BUY to lock a leg (2026-07-27).
//
// The margin is not wrong — a drive SHOULD stop before racing its own timelock.
// What was missing is that stopping the drive stops the recovery too, and the CLI
// has no rehydrate. That is an absent process, not a broken mechanism, and this is
// the deliberate way to run the mechanism.
//
// Run it (operator), AFTER T1 has passed:
//
// ```text
//   export PWNDA_CLI_REFUND_SWAP=<swap_id>
//   #  dry run first: reports what it WOULD do and refuses to broadcast
//   export PWNDA_CONDUCTOR_CLI_REFUND=1      # then re-run to actually refund
//   cargo test --features full --lib desk::conductor::cli_refund -- --ignored --nocapture
// ```
//
// Double-gated exactly like the others: `#[ignore]` plus its OWN env flag, so no
// blanket `cargo test -- --ignored` can broadcast a refund, and arming a reclaim
// can never arm a refund.
#[cfg(test)]
mod cli_refund {
    use super::*;

    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty())
    }

    #[tokio::test]
    #[ignore = "funded: refunds OUR chain-A lock after T1. Operator-run — see module doc."]
    async fn cli_refund_our_chain_a_lock() {
        let swap_id = match env("PWNDA_CLI_REFUND_SWAP") {
            Some(v) => v,
            None => {
                eprintln!(
                    "cli_refund: SKIPPED — PWNDA_CLI_REFUND_SWAP is not set. Expected the swap id \
                     of a BUY we led, locked chain A on, and abandoned."
                );
                return;
            }
        };

        let data_dir = std::path::PathBuf::from(env("PWNDA_CLI_DATA_DIR").unwrap_or_else(|| {
            std::env::temp_dir()
                .join("pwnda-conductor-cli")
                .display()
                .to_string()
        }));
        eprintln!("cli_refund: data dir {}", data_dir.display());

        // Arm FIRST, for the same reason as the reclaim entry: a refund moves a
        // coin, so Mock crypto must be a hard failure rather than a quiet no-op.
        crate::desk::arm::install_from_env(data_dir.join("desk-engine"));
        assert!(
            crate::desk::crypto::crypto_is_production_ready(),
            "engine did not arm — a DESK-ARM-FAULT: line on stderr names the missing piece. \
             Refusing to attempt a refund on Mock crypto."
        );

        let store = DeskStore::open(&data_dir).expect("open the desk store");
        let rec = store.load(&swap_id).unwrap_or_else(|e| {
            panic!(
                "load swap {swap_id} from {}: {e}. Check PWNDA_CLI_DATA_DIR — the record and the                  engine state live under <data_dir>/desk-swaps and <data_dir>/desk-engine, and                  both halves are needed.",
                data_dir.display()
            )
        });

        // Report the facts the operator needs to judge this BEFORE arming, rather
        // than after. Every one of these is a reason a refund would be wrong.
        let now = watch::unix_now();
        eprintln!(
            "cli_refund: swap {swap_id}\n  \
             desk_role   {}  (we {})\n  \
             state       {}\n  \
             lock_a      {}\n  \
             lock_b      {}\n  \
             t1          {} ({}s {})\n  \
             refund pre-sig on disk: {}",
            rec.desk_role,
            if rec.desk_role == "FOLLOWER" { "LED — this is a BUY" } else { "FOLLOWED — this is a SELL" },
            rec.state,
            rec.lock_a_txid.as_deref().unwrap_or("<none>"),
            rec.lock_b_txid.as_deref().unwrap_or("<none>"),
            rec.t1,
            (rec.t1 - now as i64).abs(),
            if now as i64 >= rec.t1 { "AGO — the refund is valid" } else { "AWAY — TOO EARLY" },
            rec.refund_presig_r_enc.is_some()
        );

        // Refuse the cases where a refund is wrong, loudly, before the flag is even
        // consulted. A refund submitted before T1 is invalid and simply burns a
        // fee; one on a swap we FOLLOWED would be aimed at the wrong chain.
        if rec.desk_role != "FOLLOWER" {
            eprintln!(
                "cli_refund: REFUSING — desk_role={} means we FOLLOWED (a SELL), so our leg is \
                 chain B and the chain-A refund is the DESK's to make. What you want is \
                 cli_reclaim, after their refund leaks s_a.",
                rec.desk_role
            );
            return;
        }
        if (now as i64) < rec.t1 {
            eprintln!(
                "cli_refund: REFUSING — T1 has not passed ({}s away). The refund transaction is \
                 not valid until then; submitting early wastes a fee and proves nothing.",
                rec.t1 - now as i64
            );
            return;
        }

        // GATE 2: its own explicit opt-in, distinct from every other armed flag.
        if env("PWNDA_CONDUCTOR_CLI_REFUND").as_deref() != Some("1") {
            eprintln!(
                "cli_refund: DRY RUN — everything above is what the armed run would act on. Set \
                 PWNDA_CONDUCTOR_CLI_REFUND=1 to actually broadcast the chain-A refund."
            );
            return;
        }

        eprintln!("cli_refund: ARMED — broadcasting the chain-A refund for {swap_id}");
        refund::execute_refund_and_report(&store, &swap_id).await;

        // Re-read rather than trusting the call: the verdict we care about is what
        // is now on disk, which is what any later run will also read.
        match store.load(&swap_id) {
            Ok(after) => eprintln!(
                "cli_refund: swap {swap_id} is now state={} refund_txid={}",
                after.state,
                after.refund_txid.as_deref().unwrap_or("<none>")
            ),
            Err(e) => eprintln!("cli_refund: could not re-read swap {swap_id}: {e}"),
        }
    }
}

// The reclaim CLI entry the desk asked for (2026-07-25), in the same #[ignore] +
// double-gate shape as `cli_entry` above. It exists because the leader's T1
// refund LEAKS `s_a`, and `reclaim::attempt_reclaim_and_report` already takes a
// refund txid directly — so recovering an abandoned swap needs no watcher, no
// desk contact, and no live counterparty. Just the chain.
#[cfg(test)]
mod cli_reclaim {
    //! Reclaim chain B for an ABANDONED swap, given the leader's on-chain refund
    //! txid. The operator-run companion to the two-step manual recovery: the desk
    //! refunds chain A (leaking `s_a`), then this reads `s_a` back off the chain
    //! and sweeps our chain-B lock home.
    //!
    //! **Why this entry exists.** The conductor's automatic reclaim watcher only
    //! runs while a drive process is alive. A swap abandoned by a Ctrl-C'd (or
    //! long-exited) `cli_entry` run has NO watcher — `cli_entry` holds its
    //! watchers in memory and never rehydrates, and `rehydrate::start` needs a
    //! Tauri `AppHandle` plus the app's own data dir. So the leaked `s_a` sits
    //! unread. That is an absent process, not a broken mechanism, and this is the
    //! deliberate way to run the mechanism.
    //!
    //! **It does not trust the desk.** The refund txid is only a pointer at
    //! something to EXAMINE. `extract_secret` binds the recovered scalar to the
    //! expected adaptor point, so a relayed or hostile txid can only ever produce
    //! a refusal (`NotTheRefund`), never a false reclaim. The desk may choose what
    //! we examine; never what we conclude.
    //!
    //! Run it (operator):
    //!
    //! ```text
    //!   source client-testnet.env.sh                  # arm gate + engine + wallet-rpc + blockfrost + state key
    //!   export PWNDA_CLI_DATA_DIR=<the SAME data dir the abandoned drive used>
    //!   export PWNDA_CLI_RECLAIM="<swap_id>:<refund_txid>,<swap_id>:<refund_txid>"
    //!   cargo test --lib desk::conductor::cli_reclaim -- --ignored --nocapture   # DRY RUN
    //!   export PWNDA_CONDUCTOR_CLI_RECLAIM=1          # then re-run to actually sweep
    //! ```
    //!
    //! `DESK_URL` is deliberately NOT required: this path never speaks to the
    //! desk. `PWNDA_CLI_DATA_DIR` matters most — the encrypted per-swap record
    //! lives under `<data_dir>/desk-swaps/`, and pointing at the wrong directory
    //! surfaces as "record not found", not as a silent no-op.
    //!
    //! Two independent gates, same discipline as the drive: (1) `#[ignore]` + the
    //! full armed env, and (2) `PWNDA_CONDUCTOR_CLI_RECLAIM=1` — its OWN flag, not
    //! shared with `PWNDA_CONDUCTOR_CLI_DRIVE`, so neither the default suite nor a
    //! blanket `--ignored` run can move a coin. Without (2) it DRY-RUNS: it opens
    //! the store, loads each record, and reports what it would attempt — which is
    //! also how the operator confirms the data dir is right before arming a sweep.
    use super::*;

    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty())
    }

    /// SKIP (with a printed reason) unless the armed environment is present.
    /// Same list as the drive MINUS `DESK_URL` — reclaim needs chain access and a
    /// real engine, never the counterparty.
    fn reclaim_env_ready() -> bool {
        for k in [
            "PWNDA_DESK_ARM",
            "PWNDA_ENGINE_PYTHON",
            "PWNDA_ENGINE_DIR",
            "ADA_ENGINE_ENV",
            "BLOCKFROST_PROJECT_ID",
            "XMR_WALLET_RPC",
            "ADA_ENGINE_STATE_KEY",
        ] {
            if env(k).is_none() {
                eprintln!("cli_reclaim: SKIPPED — {k} is not set (needs the armed testnet env)");
                return false;
            }
        }
        true
    }

    /// Parse `PWNDA_CLI_RECLAIM` into `(swap_id, refund_txid)` pairs.
    ///
    /// Strict on shape, because the failure it prevents is silent: a mistyped
    /// entry that parses into a plausible-but-wrong txid would spend a real
    /// `extract_secret` round and report `NotTheRefund`, which reads exactly like
    /// "the desk gave us the wrong txid". Better to reject it here by name.
    fn parse_pairs(raw: &str) -> Result<Vec<(String, String)>, String> {
        let mut out = Vec::new();
        for entry in raw.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            let (swap_id, refund_txid) = entry
                .split_once(':')
                .ok_or_else(|| format!("entry {entry:?} is not <swap_id>:<refund_txid>"))?;
            let (swap_id, refund_txid) = (swap_id.trim(), refund_txid.trim());
            for (label, v) in [("swap id", swap_id), ("refund txid", refund_txid)] {
                if v.is_empty() {
                    return Err(format!("entry {entry:?} has an empty {label}"));
                }
                if !v.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(format!(
                        "entry {entry:?}: {label} {v:?} is not hex (a label or stray quote pasted in?)"
                    ));
                }
            }
            out.push((swap_id.to_string(), refund_txid.to_string()));
        }
        if out.is_empty() {
            return Err("no entries — expected <swap_id>:<refund_txid>[,…]".to_string());
        }
        Ok(out)
    }

    #[test]
    fn parse_pairs_accepts_and_rejects() {
        let ok = parse_pairs(" 2943b910:ca7c5309 , 95101d75:030ccb09 ").expect("valid");
        assert_eq!(
            ok,
            vec![
                ("2943b910".to_string(), "ca7c5309".to_string()),
                ("95101d75".to_string(), "030ccb09".to_string()),
            ]
        );
        // A missing colon is the paste error that would otherwise become a
        // swap-id-shaped txid.
        assert!(parse_pairs("2943b910 ca7c5309").is_err());
        assert!(parse_pairs("2943b910:").is_err());
        assert!(parse_pairs(":ca7c5309").is_err());
        // Non-hex catches a pasted label / quote rather than treating it as a txid.
        assert!(parse_pairs("swap=2943b910:ca7c5309").is_err());
        assert!(parse_pairs("").is_err());
    }

    #[tokio::test]
    #[ignore = "funded: needs the armed engine + testnet chain access. Operator-run — see module doc."]
    async fn cli_reclaim_from_leader_refund() {
        if !reclaim_env_ready() {
            return;
        }
        let raw = match env("PWNDA_CLI_RECLAIM") {
            Some(r) => r,
            None => {
                eprintln!(
                    "cli_reclaim: SKIPPED — PWNDA_CLI_RECLAIM is not set. Expected \
                     \"<swap_id>:<refund_txid>[,<swap_id>:<refund_txid>…]\" (the leader's on-chain \
                     chain-A refund that leaked s_a)."
                );
                return;
            }
        };
        let pairs = parse_pairs(&raw).expect("PWNDA_CLI_RECLAIM");

        let data_dir = std::path::PathBuf::from(
            env("PWNDA_CLI_DATA_DIR").unwrap_or_else(|| {
                std::env::temp_dir()
                    .join("pwnda-conductor-cli")
                    .display()
                    .to_string()
            }),
        );
        eprintln!("cli_reclaim: data dir {}", data_dir.display());

        // Arm FIRST — before any active_crypto() call would latch the Mock
        // provider (the global is set-once). Reclaim moves a coin, so Mock crypto
        // must be a hard failure, never a quiet no-op.
        crate::desk::arm::install_from_env(data_dir.join("desk-engine"));
        let crypto: &'static VendoredDeskCrypto = match crypto::active_crypto() {
            ActiveCrypto::Vendored(v) => v,
            ActiveCrypto::Mock(_) => panic!(
                "engine did not arm — a DESK-ARM-FAULT: line on stderr names the missing piece. \
                 Refusing to attempt a reclaim on Mock crypto."
            ),
        };
        let store = DeskStore::open(&data_dir).expect("open the desk store");

        // GATE 2: the sweep needs its OWN explicit opt-in. Without it, report what
        // WOULD be attempted — which is also the cheap way to prove the data dir
        // holds these swaps before arming anything.
        let armed = env("PWNDA_CONDUCTOR_CLI_RECLAIM").as_deref() == Some("1");
        if !armed {
            eprintln!(
                "cli_reclaim: DRY RUN — set PWNDA_CONDUCTOR_CLI_RECLAIM=1 to actually sweep chain B."
            );
        }

        // OPTIONAL explicit Monero restore height (desk D18). Required for swaps
        // recorded before the engine stored `xmr_restore_height` — they have no
        // usable height anywhere in their state, and the client cannot patch one in
        // because `public` is under the D4 AAD. Without it the wallet restores from
        // genesis, which on stagenet does not error: it holds the single-threaded
        // wallet-rpc for hours and starves everything else (observed 2026-07-26).
        //
        // Err HIGH. Too high fails safe (the wallet never sees the output); too low
        // only costs scan time.
        let restore_height: Option<i64> = match env("PWNDA_CLI_RECLAIM_RESTORE_HEIGHT") {
            None => {
                eprintln!(
                    "cli_reclaim: PWNDA_CLI_RECLAIM_RESTORE_HEIGHT is not set — the engine will use                      its own stored height if it has one, and REFUSE loudly if it does not. Swaps                      recorded before xmr_restore_height existed need this passed."
                );
                None
            }
            Some(raw) => match raw.trim().parse::<i64>() {
                Ok(h) if h > 0 => {
                    eprintln!("cli_reclaim: restore height {h} (explicit; wins over stored values)");
                    Some(h)
                }
                _ => panic!(
                    "PWNDA_CLI_RECLAIM_RESTORE_HEIGHT={raw:?} is not a positive integer. Leave it                      unset to use the engine's stored height, or pass a Monero block number."
                ),
            },
        };

        for (swap_id, refund_txid) in pairs {
            match store.load(&swap_id) {
                Err(e) => {
                    // The most likely cause by far is the wrong data dir, so say
                    // that rather than only echoing the error.
                    eprintln!(
                        "cli_reclaim: swap {swap_id}: NO RECORD in {} ({e}). Is PWNDA_CLI_DATA_DIR \
                         the same directory the abandoned drive used?",
                        data_dir.display()
                    );
                    continue;
                }
                Ok(rec) => {
                    // Only chain facts — StoredSwap holds secrets and has no Debug.
                    //
                    // Say WHOSE role: the field is the DESK's, so a SELL_FOLLOWER
                    // swap (where we followed) prints LEADER. A bare `role=` on a
                    // recovery tool invites the operator to read that as "I led
                    // this one" and conclude the record is the wrong swap.
                    eprintln!(
                        "cli_reclaim: swap {swap_id}: desk_role={} (ours={}) lock_b={} reclaim={}",
                        rec.desk_role,
                        if rec.desk_role == "LEADER" { "FOLLOWER" } else { "LEADER" },
                        rec.lock_b_txid.as_deref().unwrap_or("<none>"),
                        rec.reclaim_txid.as_deref().unwrap_or("<none>"),
                    );
                    // C45: a dry run that reports our own store and stops has
                    // told the operator what we already believe, not what the
                    // armed run would CONCLUDE. Inspect the chain and name the
                    // verdict — read-only, no lock_b required, and the only way
                    // to run the branch-B3 discriminator against a real witness
                    // without arming a sweep.
                    if !armed {
                        reclaim::inspect_spend_and_report(&swap_id, &refund_txid, crypto).await;
                        continue;
                    }
                }
            }
            // Every verdict is reported by name; this never panics, so one
            // stubborn swap cannot abandon the rest of the batch.
            reclaim::attempt_reclaim_and_report(&store, &swap_id, &refund_txid, crypto, restore_height)
                .await;
        }
    }
}

// The RESUME entry (2026-07-26). Built because a desk restart mid-swap ended the
// client's drive process, leaving swap 8fbd36d5 alive at READY with its claim
// pre-sig released and nobody to claim it.
//
// It exists as a SEPARATE, NARROWER entry rather than a `--resume` flag on the
// drive, and that is the whole design:
//
//   `run_swap_choreography` has NO state gating. `sell_follower` runs from step 0
//   unconditionally, so pointing the normal drive at an already-locked swap sails
//   through the satisfied steps (lockUtxo already published, chain A already
//   confirmed) and reaches `crypto.lock()` — locking a SECOND leg. The resume
//   path must therefore be one that cannot reach that call at all, and the only
//   way to prove that is for the code not to contain it.
//
// So this module never references `crypto.lock`. Not gated away — absent.
#[cfg(test)]
mod cli_resume {
    //! Finish a swap whose chain-B leg is already locked: ingest the desk's
    //! released claim pre-signature and claim chain A.
    //!
    //! **When to use.** The drive process died (desk restart, Ctrl-C, network)
    //! after `STAGE 5/7 chain-B LOCKED` but before the claim. The swap is not
    //! broken — our leg is locked, our recovery material is on disk, and the desk
    //! is waiting. This picks the tail back up.
    //!
    //! **When NOT to use.** If chain B was never locked there is nothing to
    //! resume; re-run the normal drive. This refuses that case by name rather
    //! than doing something clever.
    //!
    //! Run it (operator):
    //!
    //! ```text
    //!   source client-testnet.env.sh            # arm gate + engine + wallet-rpc + blockfrost
    //!   export DESK_URL=http://127.0.0.1:8796   # the tail DOES talk to the desk (M5 + settle)
    //!   export PWNDA_CLI_DATA_DIR=<the SAME data dir the drive used>
    //!   export PWNDA_CLI_RESUME_SWAP=<swap_id>
    //!   cargo test --features full --lib desk::conductor::cli_resume -- --ignored --nocapture
    //!   export PWNDA_CONDUCTOR_CLI_RESUME=1     # then re-run to actually claim
    //! ```
    //!
    //! Two gates, same discipline as the drive and the reclaim: `#[ignore]` plus
    //! `PWNDA_CONDUCTOR_CLI_RESUME=1` — **its own flag**, distinct from
    //! `PWNDA_CONDUCTOR_CLI_DRIVE` and `PWNDA_CONDUCTOR_CLI_RECLAIM`, so arming
    //! any one of the three can never arm another. Without it this DRY-RUNS: it
    //! loads the record, prints what it would do, and stops.
    use super::*;
    use zeroize::Zeroizing;

    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty())
    }

    /// SKIP (with a printed reason) unless the funded environment is present.
    /// Same list as the drive — the tail needs chain access, a real engine, AND
    /// the desk (it polls /status for the released sig and for SETTLED).
    fn resume_env_ready() -> bool {
        for k in [
            "PWNDA_DESK_ARM",
            "PWNDA_ENGINE_PYTHON",
            "PWNDA_ENGINE_DIR",
            "ADA_ENGINE_ENV",
            "BLOCKFROST_PROJECT_ID",
            "XMR_WALLET_RPC",
            "ADA_ENGINE_STATE_KEY",
            "DESK_URL",
        ] {
            if env(k).is_none() {
                eprintln!("cli_resume: SKIPPED — {k} is not set (needs the full funded testnet env)");
                return false;
            }
        }
        true
    }

    /// Why a record cannot be resumed. Each variant names a DIFFERENT operator
    /// action, which is the point of separating them.
    #[derive(Debug, PartialEq)]
    enum NotResumable {
        /// Our leg was never locked — there is nothing at risk and nothing to
        /// finish. The normal drive is the right entry.
        NothingLocked,
        /// We led this swap; the leader's tail is extract_secret → claim chain B,
        /// not ingest → claim chain A. Refuse rather than run the wrong tail.
        WeLed,
        /// Already finished.
        AlreadySettled,
    }

    /// Decide whether a persisted record is a candidate for the claim tail.
    ///
    /// Deliberately a pure function over the two fields that matter, so the
    /// decision is unit-testable without a store, a desk, or a chain.
    fn resumable(desk_role: &str, lock_b_txid: Option<&str>, state: &str) -> Result<(), NotResumable> {
        if desk_role != "LEADER" {
            // desk_role LEADER == we FOLLOW == SELL. Anything else means we led.
            return Err(NotResumable::WeLed);
        }
        if state == "SETTLED" {
            return Err(NotResumable::AlreadySettled);
        }
        match lock_b_txid {
            Some(t) if !t.is_empty() => Ok(()),
            _ => Err(NotResumable::NothingLocked),
        }
    }

    #[test]
    fn only_a_locked_following_swap_can_resume_the_claim_tail() {
        // The happy case: we followed, our leg is locked, not yet settled.
        assert_eq!(resumable("LEADER", Some("be266a39"), "B_LOCKED"), Ok(()));
        assert_eq!(resumable("LEADER", Some("be266a39"), "A_LOCKED"), Ok(()));

        // Nothing locked => nothing to resume. This is the one that MUST refuse:
        // the normal drive would lock, and a resume that silently fell through to
        // it would be the double-lock this entry exists to make impossible.
        assert_eq!(
            resumable("LEADER", None, "ACCEPTED"),
            Err(NotResumable::NothingLocked)
        );
        assert_eq!(
            resumable("LEADER", Some(""), "ACCEPTED"),
            Err(NotResumable::NothingLocked)
        );

        // We led => the leader tail is a different sequence entirely.
        assert_eq!(
            resumable("FOLLOWER", Some("aa"), "A_LOCKED"),
            Err(NotResumable::WeLed)
        );

        // Already done.
        assert_eq!(
            resumable("LEADER", Some("aa"), "SETTLED"),
            Err(NotResumable::AlreadySettled)
        );
    }

    /// A fresh enrolled identity pointed at `base`. The auth identity is separate
    /// from the swap's crypto material — the swap is identified by its id and its
    /// persisted record, not by who is asking — so re-enrolling to resume is fine.
    async fn enrolled_state(base: &str, data_dir: std::path::PathBuf) -> Result<SwapState, String> {
        let state = SwapState::new();
        state.set_proxy_url(base.to_string());
        state.set_data_dir(data_dir);
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        let pubkey = crate::swap::auth::pubkey_b64(&seed);
        state.set_seed(Zeroizing::new(seed), pubkey.clone());
        let (status, body) = crate::swap::proxy::enroll(base, &pubkey)
            .await
            .map_err(|e| format!("enroll call failed: {e}"))?;
        if status != 200 {
            return Err(format!("enroll returned {status}: {body}"));
        }
        Ok(state)
    }

    #[tokio::test]
    #[ignore = "funded: finishes a swap whose chain-B leg is already locked. Operator-run — see module doc."]
    async fn cli_resume_claim_tail() {
        if !resume_env_ready() {
            return;
        }
        let swap_id = match env("PWNDA_CLI_RESUME_SWAP") {
            Some(s) => s,
            None => {
                eprintln!(
                    "cli_resume: SKIPPED — PWNDA_CLI_RESUME_SWAP is not set. Expected the id of a \
                     swap whose chain-B leg is already locked (the drive printed it as \
                     `accepted swap <id>`)."
                );
                return;
            }
        };
        let base = env("DESK_URL").expect("checked in resume_env_ready");
        let data_dir = std::path::PathBuf::from(
            env("PWNDA_CLI_DATA_DIR").unwrap_or_else(|| {
                std::env::temp_dir()
                    .join("pwnda-conductor-cli")
                    .display()
                    .to_string()
            }),
        );
        eprintln!("cli_resume: data dir {}", data_dir.display());

        // Arm FIRST — before any active_crypto() call latches Mock (set-once).
        crate::desk::arm::install_from_env(data_dir.join("desk-engine"));
        let crypto: &'static VendoredDeskCrypto = match crypto::active_crypto() {
            ActiveCrypto::Vendored(v) => v,
            ActiveCrypto::Mock(_) => panic!(
                "engine did not arm — a DESK-ARM-FAULT: line on stderr names the missing piece. \
                 Refusing to resume a funded swap on Mock crypto."
            ),
        };

        let store = DeskStore::open(&data_dir).expect("open the desk store");
        let mut rec = match store.load(&swap_id) {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "cli_resume: swap {swap_id}: NO RECORD in {} ({e}). Is PWNDA_CLI_DATA_DIR the \
                     same directory the drive used?",
                    data_dir.display()
                );
                return;
            }
        };

        // Refuse by name, before touching the desk or the chain.
        if let Err(why) = resumable(&rec.desk_role, rec.lock_b_txid.as_deref(), &rec.state) {
            let detail = match why {
                NotResumable::NothingLocked =>
                    "chain B was never locked, so there is no tail to finish. Nothing of ours is at \
                     risk. Run the NORMAL drive to start a swap — do NOT point it at this id.",
                NotResumable::WeLed =>
                    "we LED this swap. The leader's tail is extract_secret then claim chain B, not \
                     ingest then claim chain A. Refusing rather than running the wrong sequence.",
                NotResumable::AlreadySettled => "already SETTLED — nothing to do.",
            };
            eprintln!("cli_resume: swap {swap_id}: NOT RESUMABLE — {detail}");
            return;
        }

        eprintln!(
            "cli_resume: swap {swap_id}: resumable — we FOLLOWED, chain-B lock {} is on disk, state {}",
            rec.lock_b_txid.as_deref().unwrap_or("<none>"),
            rec.state
        );

        // GATE 2: the funds-moving claim needs its OWN explicit opt-in.
        if env("PWNDA_CONDUCTOR_CLI_RESUME").as_deref() != Some("1") {
            eprintln!(
                "cli_resume: DRY RUN — set PWNDA_CONDUCTOR_CLI_RESUME=1 to poll for the released \
                 claim pre-signature and CLAIM chain A. Held here by design."
            );
            return;
        }

        // NO recovery watchers are spawned, deliberately. The tail is a short
        // unconditional sequence with no gate that reads an observer, our
        // recovery material is already persisted, and every background poller is
        // sidecar contention against the exact engine calls this entry needs —
        // which is precisely what killed an earlier drive. If the claim fails,
        // the operator re-runs this, or falls back to the T1 refund/reclaim path,
        // which is unaffected by anything here.
        let stop = Arc::new(AtomicBool::new(false));

        // ── Claim chain A, WITHOUT asking the desk anything ──────────────────
        //
        // The engine may already hold the released pre-sig: an earlier drive can
        // have ingested it (STAGE 6/7) and then died at the claim — which is
        // exactly the case this entry exists for. When it does, **the desk is not
        // needed at all**: a chain-A claim is a Cardano transaction we build,
        // sign and submit ourselves.
        //
        // The first version polled /status for the pre-sig unconditionally, on
        // this reasoning, which was wrong and is worth recording:
        //
        //     "the swap is identified by its id and its persisted record, not by
        //      who is asking — so re-enrolling to resume is fine"
        //
        // The desk scopes /status to the ENROLLED IDENTITY that created the swap.
        // Our auth identity is ephemeral per run (a fresh seed, never persisted),
        // so a resumed run enrolls a NEW identity and gets
        // `404 VALIDATION "swap not found"` for a swap that plainly exists. An
        // assumption stated confidently in a comment and never checked — the same
        // failure mode this project has been cataloguing on the other side of the
        // wire all week.
        //
        // Trying the claim FIRST removes the dependency entirely on the path that
        // matters, and falls back to the desk only when the engine genuinely has
        // nothing to complete.
        let claim_txid = match crypto.claim(&swap_id).await {
            Ok(txid) => {
                stage!(
                    swap_id,
                    "RESUME 1/2 the engine ALREADY held the released claim pre-sig (ingested by the \
                     earlier drive) — no desk contact needed"
                );
                txid
            }
            Err(source) if source.to_string().contains("no released claim pre-sig") => {
                stage!(
                    swap_id,
                    "RESUME 1/2 the engine has no claim pre-sig yet — falling back to polling the \
                     desk for M5. NOTE: this needs an identity the desk associates with this swap; \
                     a resumed run enrolls a fresh one and will 404."
                );
                let state = enrolled_state(&base, data_dir.clone())
                    .await
                    .expect("enroll the desk identity");
                let presig = wait_for_released_claim_sig(&state, &swap_id, &stop, rec.t1)
                    .await
                    .expect("wait for the released claim sig");
                crypto
                    .ingest_claim_presig(&swap_id, &presig)
                    .await
                    .expect("ingest_claim_presig");
                crypto.claim(&swap_id).await.expect("claim chain A after ingest")
            }
            Err(source) => panic!("claim chain A: {source}"),
        };
        stage!(
            swap_id,
            "RESUME 2/2 chain-A CLAIM submitted — txid {claim_txid}. `t` is revealed; the desk may \
             now sweep chain B."
        );

        // Settlement is the DESK's move and it discovers our claim on-chain, so we
        // do not poll for it — that poll needs the same identity-scoped /status
        // that is unavailable to a resumed run, and waiting on it would turn a
        // successful claim into a hang. Record A_CLAIMED (non-terminal, correct)
        // and let the desk's own watcher take it from here.
        // (StoredSwap has no claim_a_txid field — the state transition is what the
        // recovery net reads, and the txid is in the transcript and on chain.)
        rec.state = "A_CLAIMED".to_string();
        store.save(&rec).expect("persist the resumed swap");
        eprintln!(
            "cli_resume: swap {swap_id}: A_CLAIMED, chain-A claim {claim_txid}. The desk sweeps \
             chain B off this transaction; ask it to confirm SETTLED."
        );
    }
}
