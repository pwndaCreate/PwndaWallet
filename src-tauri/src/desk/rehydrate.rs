//! Startup rehydrate for in-flight desk swaps - the half of `store.rs` that
//! actually makes the durable record worth writing.
//!
//! `store.rs` persists every swap so a restart cannot strand funds, but nothing
//! reads it back on a cold launch: `desk_list_active` only runs when the TS
//! tracker mounts, and it does not spawn watchers. That leaves the real failure
//! this module closes - the app is killed (crash, reboot, mem_guard reload)
//! while a swap is post-lock, and no [`RefundWatcher`] exists to fire at T1. The
//! funds are recoverable in principle (the pre-signed refund is on disk) and
//! unrecoverable in practice, because nobody is watching the clock.
//!
//! ## Shape
//!
//! [`start`] is a detached spawn, modelled on
//! [`crate::sidecar_update::start`]: it never blocks `setup()`, never returns an
//! `Err` into the setup hook, and every failure path logs and returns. A swap
//! desk must not be able to prevent the wallet from launching.
//!
//! ## The data-dir ordering race
//!
//! We resolve `app_local_data_dir()` HERE rather than calling
//! [`crate::swap::state::SwapState::data_dir`]. At setup time that accessor is
//! `None`: the only writer is `swap::commands::configure_proxy`, which is driven
//! by a frontend effect and therefore lands some indeterminate time after setup.
//! Reading it here would return `None` on every cold launch, `DeskStore::open`
//! would be skipped with a swallowed warning, and in-flight swaps would silently
//! never resume. So we resolve it ourselves and seed it BACK into `SwapState`,
//! which also fixes the same race on the TS side (`desk_list_active` ->
//! `open_store` -> `data_dir()` can otherwise fail on a cold mount).
//!
//! ## Never panic here
//!
//! `DeskStore::open` reaches the OS keyring, which is absent or locked in CI,
//! in a headless session, and on a machine whose keyring the user has not
//! unlocked yet. An `unwrap` would take the whole wallet down for a swap-desk
//! feature. Every error is logged and returned from.

#![allow(dead_code)] // wired from lib.rs setup + desk/commands.rs (see follow-ups)

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Manager};

use super::store::DeskStore;
use super::watch::{unix_now, RefundOutcome, RefundWatcher};

/// Process-wide registry of the stop flags held by live refund watchers, keyed
/// by swap id. Managed as Tauri state (`.manage(DeskWatchers::default())`).
///
/// ## Why this exists
///
/// [`RefundWatcher::run`] takes an `Arc<AtomicBool>` stop flag that nothing in
/// the tree currently owns. Without a registry the caller drops its only handle
/// the moment it spawns the watcher, and a rehydrated watcher can then ONLY ever
/// reach [`RefundOutcome::Refunded`]: it has no way to learn that the swap
/// settled cooperatively, so it sits until T1 and fires a refund on a swap that
/// was already paid out. That is the difference between a correct recovery and a
/// redundant refund - the registry is what lets `desk_status` raise the flag the
/// instant it parses a terminal state.
///
/// ## Locking
///
/// The guard is never held across an `.await` (that would make the spawned
/// futures `!Send`); every method takes the lock, mutates, and drops it before
/// returning. A poisoned lock is recovered via `into_inner` rather than
/// unwrapped: a `HashMap<String, Arc<AtomicBool>>` has no invariant a panicking
/// thread could have half-broken, and refusing to hand out stop flags after an
/// unrelated panic would degrade every live watcher into refund-only.
#[derive(Default)]
pub struct DeskWatchers(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DeskWatchers {
    /// Get (or create) the stop flag for `swap_id`. Registering the same id
    /// twice returns the SAME flag, so a duplicate watcher shares one signal and
    /// a single [`raise`](Self::raise) stops both.
    pub fn register(&self, swap_id: &str) -> Arc<AtomicBool> {
        let mut map = self.lock_map();
        map.entry(swap_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// Signal the watcher for `swap_id` to stop without refunding - the
    /// "this swap settled cooperatively" path. A no-op for an id with no live
    /// watcher, so callers can raise unconditionally on any terminal state.
    pub fn raise(&self, swap_id: &str) {
        let map = self.lock_map();
        if let Some(flag) = map.get(swap_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// Drop the entry once its watcher has exited, so the map does not
    /// accumulate one dead flag per completed swap for the process lifetime.
    pub fn clear(&self, swap_id: &str) {
        let mut map = self.lock_map();
        map.remove(swap_id);
    }

    fn lock_map(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Spawn the two chain-facing background tasks for one swap: the observer poll
/// that keeps our own view of both legs fresh, and the reclaim watch that
/// discovers the leader's chain-A refund and sweeps chain B off it.
///
/// Both share the swap's stop flag with the refund watcher, so a settled swap
/// stops all three at once rather than leaving pollers running against a
/// finished swap.
///
/// **Requires a vendored engine.** Under the mock provider there is no chain
/// access, and a task polling a stub forever would be noise that looks like
/// coverage. That is logged once rather than passed over in silence: a build
/// where these did not start is a build where nothing is watching.
fn spawn_chain_watchers(
    swap_id: &str,
    store: Arc<DeskStore>,
    stop: Arc<AtomicBool>,
) {
    use crate::desk::crypto::{active_crypto, ActiveCrypto};

    let ActiveCrypto::Vendored(crypto) = active_crypto() else {
        eprintln!(
            "[desk::rehydrate] swap {swap_id}: no vendored engine is installed, so the chain              observer and the reclaim watch were NOT started - this swap has no independent              view of either chain"
        );
        return;
    };

    // The observer is kept fresh so any gate consulted later reads a real
    // sighting rather than the blind state it starts in.
    // ONE interval, used to build the observer AND to drive the loop. Naming it
    // twice is what let the staleness bound drift from the actual cadence: the
    // bound was derived from the default constant while the loop took a
    // parameter, so they agreed only because this caller passed the same value.
    // Widening the poll (the obvious lever, since both sides share a Blockfrost
    // rate-limit bucket) would then have blinded every gate — failing SAFE, and
    // therefore invisible until a funded run.
    let interval = crate::desk::observer::POLL_INTERVAL;
    let observer = Arc::new(crate::desk::observer::SidecarObserver::with_interval(
        interval,
    ));
    // Watch chain B only if this swap actually HAS a chain-B leg. The durable
    // record is the authority: a swap rehydrated before its lock landed has
    // nothing on B, and `watch_lock(B)` would restore a joint view wallet for a
    // lock that does not exist — re-pointing the shared wallet-rpc away from the
    // funded reserve and tying up the serialised engine sidecar. See
    // `observer::chains_to_poll`.
    let has_b_leg = store
        .load(swap_id)
        .map(|r| r.lock_b_txid.is_some())
        .unwrap_or(false);
    let obs_id = swap_id.to_string();
    let obs_stop = Arc::clone(&stop);
    let watch_b = Arc::new(AtomicBool::new(has_b_leg));
    tauri::async_runtime::spawn(async move {
        crate::desk::observer::run_poll_loop(observer, crypto, obs_id, obs_stop, interval, watch_b)
            .await;
    });

    let rec_id = swap_id.to_string();
    tauri::async_runtime::spawn(async move {
        crate::desk::reclaim::run_reclaim_watch(
            store,
            crypto,
            rec_id,
            stop,
            crate::desk::observer::POLL_INTERVAL,
        )
        .await;
    });
}

/// Spawn the detached startup rehydrate. Called once from `lib.rs::run`'s setup
/// hook, after `sidecar_update::start`.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        rehydrate(app).await;
    });
}

async fn rehydrate(app: AppHandle) {
    // 1. Resolve the data dir ourselves - see the module note on why
    //    SwapState::data_dir() is None at setup time.
    let dir = match app.path().app_local_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!(
                "[desk::rehydrate] cannot resolve app_local_data_dir ({e}); \
                 in-flight swaps will not be resumed this launch"
            );
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[desk::rehydrate] cannot create data dir {}: {e}",
            dir.display()
        );
        return;
    }

    // 2. Seed it back into SwapState so the TS side's desk_list_active ->
    //    open_store -> data_dir() path works on a cold mount too. Scoped: the
    //    State borrow must not survive to an await point.
    {
        match app.try_state::<crate::swap::state::SwapState>() {
            Some(state) => state.set_data_dir(dir.clone()),
            None => eprintln!(
                "[desk::rehydrate] SwapState is not managed; desk commands will \
                 stay unavailable until configure_proxy resolves the data dir"
            ),
        }
    }

    // 3. Open the encrypted store. Keyring access can legitimately fail
    //    (headless, CI, locked session) - log and return, never unwrap.
    // Arc'd because every watcher task needs it: the store is what the refund
    // path reads the pre-signature back out of when T1 fires.
    let store = match DeskStore::open(&dir).map(Arc::new) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "[desk::rehydrate] cannot open the desk store ({e}); refund \
                 watchers were NOT respawned - any in-flight swap is unwatched \
                 until the next successful launch"
            );
            return;
        }
    };

    // 4. Load every record and keep only the non-terminal ones. StoredSwap is
    //    ZeroizeOnDrop and holds the secret scalar share, so we project out just
    //    the id + T1 and let the records drop (and wipe) immediately.
    let pending: Vec<(String, i64)> = match store.load_all() {
        Ok(all) => all
            .iter()
            .filter(|s| !crate::desk::engine::DeskSwapState::parse(&s.state).is_terminal())
            .map(|s| (s.swap_id.clone(), s.t1))
            .collect(),
        Err(e) => {
            eprintln!("[desk::rehydrate] cannot read persisted swaps ({e}); nothing resumed");
            return;
        }
    };
    if pending.is_empty() {
        return;
    }

    // 5. Register a stop flag per swap, then spawn one watcher each. Registering
    //    BEFORE spawning means desk_status can raise a flag even if it polls
    //    before the watcher task is scheduled.
    let mut armed: Vec<(String, i64, Arc<AtomicBool>)> = Vec::with_capacity(pending.len());
    {
        let watchers = match app.try_state::<DeskWatchers>() {
            Some(w) => w,
            None => {
                eprintln!(
                    "[desk::rehydrate] DeskWatchers is not managed; refusing to \
                     spawn {} unstoppable watcher(s) - without a stop flag each \
                     one can only ever refund, including on a swap that already \
                     settled. Add .manage(DeskWatchers::default()) in lib.rs",
                    pending.len()
                );
                return;
            }
        };
        for (swap_id, t1) in pending {
            let flag = watchers.register(&swap_id);
            armed.push((swap_id, t1, flag));
        }
    }

    let count = armed.len();
    for (swap_id, t1, stop) in armed {
        // The chain-facing watchers. Both need real chain access, so they are
        // spawned only when a vendored engine is installed - under the mock
        // provider there is nothing to observe and a task that polled a stub
        // forever would just be noise that looks like coverage.
        spawn_chain_watchers(&swap_id, Arc::clone(&store), Arc::clone(&stop));

        // CC-3: the T2 sibling of the refund watcher below, respawned with the
        // same absolute-deadline discipline — T2 is hours after T1, so the
        // process that was driving when a refund first failed is exactly the
        // process least likely to still be alive at T2 (the C41 comment on the
        // refund watcher, and it applies with MORE force here). Leader-only;
        // `run_swipe_watch` loads the record, decides via `swipe_plan`, and is
        // loud whichever way it goes (D50). The vendored engine is resolved at
        // spawn: mock material cannot swipe, and that refusal must be said,
        // not skipped.
        match crate::desk::crypto::active_crypto() {
            crate::desk::crypto::ActiveCrypto::Vendored(c) => {
                let store_for_swipe = Arc::clone(&store);
                let id_for_swipe = swap_id.clone();
                let stop_for_swipe = Arc::clone(&stop);
                tauri::async_runtime::spawn(async move {
                    crate::desk::refund::run_swipe_watch(
                        store_for_swipe,
                        c,
                        id_for_swipe,
                        stop_for_swipe,
                    )
                    .await;
                });
            }
            _ => eprintln!(
                "[desk::watch] swap {swap_id}: swipe watcher NOT armed — no vendored engine is \
                 installed and mock material cannot swipe; branch B3 for this swap needs the \
                 real engine"
            ),
        }

        let app_for_task = app.clone();
        let id_for_refund = swap_id.clone();
        let store_for_refund = Arc::clone(&store);
        tauri::async_runtime::spawn(async move {
            // T1 is ABSOLUTE wall-clock, which is the whole point: a watcher
            // reconstructed after a restart fires at the same real instant the
            // original would have. If T1 already passed while the app was down,
            // the first loop iteration fires immediately - correct, not a bug.
            // Same 2s cadence as a freshly-spawned watcher, so rehydrated and
            // live swaps behave identically.
            let watcher = RefundWatcher::new(t1.max(0) as u64);
            let outcome = watcher
                .run(stop, unix_now, move || async move {
                    // Awaited INLINE, not spawned: the broadcast is chain I/O
                    // now, but the watcher still must not report "refunded"
                    // until the refund path has actually run and logged its
                    // verdict. A detached failure here would be
                    // indistinguishable from a success.
                    // C41: the deep-abort-aware driver, same as the in-session
                    // watcher. It was wired there and NOT here, which is "a fix
                    // applied to one instance of a pattern is not applied to the
                    // pattern" — a comment that already exists in our own
                    // preflight, committed one round after writing it.
                    //
                    // This is the caller that matters MOST for a deep abort, not
                    // least: T2 is hours after T1, so the process that was
                    // driving when the refund first failed is exactly the process
                    // least likely to still be alive at T2. Rehydrate is how a
                    // swipe ever gets attempted at all after a restart.
                    //
                    // Falls back to the plain refund when no vendored engine is
                    // installed — under the mock provider there is nothing to
                    // swipe with, and refusing to refund because we cannot swipe
                    // would be strictly worse.
                    match crate::desk::crypto::active_crypto() {
                        crate::desk::crypto::ActiveCrypto::Vendored(c) => {
                            crate::desk::refund::execute_deep_abort_and_report(
                                &store_for_refund,
                                &id_for_refund,
                                c,
                            )
                            .await;
                        }
                        _ => {
                            crate::desk::refund::execute_refund_and_report(
                                &store_for_refund,
                                &id_for_refund,
                            )
                            .await;
                        }
                    }
                })
                .await;
            match outcome {
                // "ran" not "succeeded": the refund path decides what actually
                // happened and logs its own verdict under [desk::refund].
                RefundOutcome::Refunded => eprintln!(
                    "[desk::rehydrate] watcher for swap {swap_id} ended: T1 passed, \
                     refund path ran"
                ),
                RefundOutcome::Stopped => eprintln!(
                    "[desk::rehydrate] watcher for swap {swap_id} ended: swap reached a \
                     terminal state before T1, no refund"
                ),
            }
            // try_state is taken AFTER the await, so no borrow of the app
            // handle is ever held across a suspension point.
            if let Some(w) = app_for_task.try_state::<DeskWatchers>() {
                w.clear(&swap_id);
            }
        });
    }

    eprintln!(
        "[desk::rehydrate] resumed {count} in-flight swap(s); refund watchers armed on their \
         absolute T1, swipe watchers on the engine's T2 where the record carries one (CC-3)"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_returns_an_unraised_flag() {
        let w = DeskWatchers::default();
        let flag = w.register("aa01");
        assert!(
            !flag.load(Ordering::SeqCst),
            "a fresh watcher must start un-stopped, or it would never refund"
        );
    }

    #[test]
    fn raise_sets_the_registered_flag() {
        let w = DeskWatchers::default();
        let flag = w.register("bb02");
        w.raise("bb02");
        assert!(
            flag.load(Ordering::SeqCst),
            "raise must be visible through the Arc the watcher already holds"
        );
    }

    #[test]
    fn raise_on_an_unknown_id_is_a_no_op() {
        let w = DeskWatchers::default();
        let flag = w.register("cc03");
        w.raise("no-such-swap");
        assert!(
            !flag.load(Ordering::SeqCst),
            "raising an unrelated id must not stop another swap's watcher"
        );
    }

    /// A duplicate rehydrate must not orphan the first watcher: both
    /// registrations share one flag, so one raise stops both.
    #[test]
    fn register_twice_returns_the_same_usable_flag() {
        let w = DeskWatchers::default();
        let first = w.register("dd04");
        let second = w.register("dd04");
        assert!(Arc::ptr_eq(&first, &second), "the same id must share one flag");
        assert!(!second.load(Ordering::SeqCst));
        w.raise("dd04");
        assert!(first.load(Ordering::SeqCst));
        assert!(second.load(Ordering::SeqCst));
    }

    #[test]
    fn clear_drops_the_entry_and_leaves_the_held_flag_alone() {
        let w = DeskWatchers::default();
        let flag = w.register("ee05");
        w.clear("ee05");
        // The exited watcher's own Arc is untouched...
        assert!(!flag.load(Ordering::SeqCst));
        // ...and a later raise for that id is now a harmless no-op.
        w.raise("ee05");
        assert!(!flag.load(Ordering::SeqCst));
        // Re-registering after a clear yields a brand new flag.
        let fresh = w.register("ee05");
        assert!(!Arc::ptr_eq(&flag, &fresh));
    }
}
