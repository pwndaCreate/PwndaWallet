//! Background chain watchers + the refund watcher — the client's OWN view of
//! the chains. The Rust twin of the `Observer` + `RefundWatcher` halves of the
//! reference client's `safety.go`.
//!
//! ## Principle (sub-plan 04 D)
//!
//! Every value-moving signature the [`super::engine`] makes is gated on THIS —
//! the client's own chain observation — NEVER on the desk's `/status`. The
//! refund watcher recovers funds with the desk offline or hostile, and is built
//! to survive an app restart (rehydrated from `desk/store.rs`, task 24): its T1
//! is an absolute wall-clock deadline, so a watcher reconstructed after a crash
//! still fires at the right real time.
//!
//! ## Stage A vs. production
//!
//! [`ChainObserver`] is a trait. Stage-A conformance drives it with the
//! controllable [`MockObserver`] (the twin of the Go harness's mock `Observer`).
//! The real backends — Esplora (BTC-family/LTC), EVM `eth_getLogs` (AVAX),
//! Koios/Blockfrost (ADA), `monero-wallet-rpc` joint-address watching (XMR/ZEPH)
//! — implement the SAME trait behind a background polling task and slot in
//! without touching the engine's gating logic. The observer is a cheap cached
//! read; the network I/O lives in the task that WRITES to it, not the gate path.

#![allow(dead_code)] // consumed by desk/engine.rs gates + desk/commands.rs (later)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Which leg is being observed. `A` is the scripted chain (Cardano), `B` the
/// unscripted one (Monero/Zephyr) — the same `"A"`/`"B"` the engine's
/// `watch_lock` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chain {
    A,
    B,
}

impl Chain {
    pub fn as_str(self) -> &'static str {
        match self {
            Chain::A => "A",
            Chain::B => "B",
        }
    }
}

/// What our own watcher last saw for one leg.
///
/// **Three states, deliberately — never a `bool`.** `RPC-PROTOCOL.md` states the
/// rule for `watch_lock` outright: *"map `{confirmed, error}` to THREE states
/// (confirmed / not-yet / could-not-look), never collapse to a bool, or a
/// FOLLOWER mistakes local connectivity loss for 'desk never locked'."*
///
/// The distinction is not cosmetic. Both `NotYet` and `CouldNotLook` must block
/// a lock, so a bool is *safe* at the gate — but they demand opposite responses
/// from whoever is watching: one means keep waiting, the other means fix your
/// chain access before the timelock burns down. Collapsed into one `false` the
/// operator cannot tell a patient swap from a blind one, and a blind swap that
/// looks patient is how a T1 arrives unattended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockSighting {
    /// Our own watcher saw the lock **and the engine bound it** to the agreed
    /// address and amount (`watch_lock` enforces A `>= amountA` [E4]; B
    /// destination == joint addr AND `>= amountB`). Depth is `confs`.
    Confirmed {
        confs: u64,
        height: u64,
        txid: String,
    },
    /// We looked, and the lock is not there yet or is not deep enough. This is
    /// positive knowledge: the chain answered.
    NotYet { confs: u64 },
    /// We could not look. **Not** evidence about the counterparty — evidence
    /// about us. Carries the reason so the log names it.
    CouldNotLook { error: String },
}

impl LockSighting {
    /// True only for a confirmed sighting at or beyond `min_confs`.
    ///
    /// Deliberately NOT a `From<LockSighting> for bool`: collapsing has to be an
    /// explicit call at a gate that already decided the depth it needs, so the
    /// collapse cannot happen by accident somewhere that has not.
    pub fn is_confirmed_to(&self, min_confs: u64) -> bool {
        matches!(self, LockSighting::Confirmed { confs, .. } if *confs >= min_confs)
    }
}

/// The client's own view of the two swap chains. The engine consults this — not
/// the desk — before it signs. Implementors keep it fresh from independent
/// watchers; a gate is a cheap read of the latest sighting.
///
/// Implementors report **facts**; the gates in [`super::engine`] apply the
/// policy. That split is deliberate: if each observer judged for itself, every
/// new backend would re-implement the depth and fail-closed rules, and one of
/// them would eventually get it wrong in the lenient direction.
pub trait ChainObserver: Send + Sync {
    /// The latest sighting for one leg. Cheap and non-blocking — the network I/O
    /// belongs in whatever task refreshes this.
    fn observe_lock(&self, chain: Chain) -> LockSighting;
}

/// A controllable observer for tests + Stage-A conformance — the twin of the Go
/// harness's mock `Observer`.
pub struct MockObserver {
    a: std::sync::Mutex<LockSighting>,
    b: std::sync::Mutex<LockSighting>,
}

impl Default for MockObserver {
    fn default() -> Self {
        Self {
            a: std::sync::Mutex::new(LockSighting::NotYet { confs: 0 }),
            b: std::sync::Mutex::new(LockSighting::NotYet { confs: 0 }),
        }
    }
}

impl MockObserver {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, chain: Chain, s: LockSighting) {
        let cell = match chain {
            Chain::A => &self.a,
            Chain::B => &self.b,
        };
        *cell.lock().expect("mock observer lock") = s;
    }

    /// Convenience for the common "confirmed deep enough" case.
    pub fn set_confirmed(&self, chain: Chain, confs: u64) {
        self.set(
            chain,
            LockSighting::Confirmed {
                confs,
                height: 1,
                txid: "mock".into(),
            },
        );
    }
}

impl ChainObserver for MockObserver {
    fn observe_lock(&self, chain: Chain) -> LockSighting {
        let cell = match chain {
            Chain::A => &self.a,
            Chain::B => &self.b,
        };
        cell.lock().expect("mock observer lock").clone()
    }
}

/// Outcome of a refund-watcher run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefundOutcome {
    /// T1 passed while the swap was still in flight — the refund was fired.
    Refunded,
    /// The swap settled/aborted cooperatively (the stop flag was raised on the
    /// client's own observation) before T1 — no refund.
    Stopped,
}

/// Fires a refund exactly once when the post-lock deadline T1 passes, UNLESS the
/// swap settles first. The `RefundWatcher` half of `safety.go`, with one
/// deliberate hardening: the "done" decision is driven by the client's OWN
/// observation (the `stop` flag the engine raises when its watcher sees
/// settlement) rather than by polling the desk's `/status`. That is why it works
/// with the desk offline or hostile (harness H2) — it needs only the local clock
/// plus its own settlement signal.
pub struct RefundWatcher {
    /// Absolute T1 deadline in unix seconds (the desk's `AcceptResponse.t1`,
    /// wall-clock — so a watcher rehydrated after a restart still fires on time).
    pub t1_unix: u64,
    /// Cadence for re-checking the clock + the stop flag.
    pub poll: Duration,
}

impl RefundWatcher {
    pub fn new(t1_unix: u64) -> Self {
        Self {
            t1_unix,
            poll: Duration::from_secs(2),
        }
    }

    /// Run the watch loop. Returns [`RefundOutcome::Refunded`] after invoking
    /// `on_refund` at T1, or [`RefundOutcome::Stopped`] if `stop` is raised
    /// first. `now` yields the current unix-seconds time — pass [`unix_now`] in
    /// production; inject a controllable clock in tests.
    /// `on_refund` is async because publishing a refund is chain I/O. It is
    /// awaited INLINE rather than spawned: the watcher must not report
    /// `Refunded` until the refund path has actually run and logged its verdict,
    /// or a detached failure would be indistinguishable from a success.
    pub async fn run<N, R, F>(&self, stop: Arc<AtomicBool>, now: N, on_refund: R) -> RefundOutcome
    where
        N: Fn() -> u64,
        R: FnOnce() -> F,
        F: std::future::Future<Output = ()>,
    {
        let poll = if self.poll.is_zero() {
            Duration::from_millis(100)
        } else {
            self.poll
        };
        // FnOnce guarded by Option::take so the compiler sees it fires at most
        // once even though the check lives in a loop.
        let mut on_refund = Some(on_refund);
        loop {
            // Cooperative stop wins over the deadline (mirrors safety.go, which
            // checks Done() before T1).
            if stop.load(Ordering::SeqCst) {
                return RefundOutcome::Stopped;
            }
            if now() >= self.t1_unix {
                if let Some(f) = on_refund.take() {
                    f().await;
                }
                return RefundOutcome::Refunded;
            }
            tokio::time::sleep(poll).await;
        }
    }
}

/// Outcome of a swipe-watcher run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwipeOutcome {
    /// The ENGINE's T2 passed while the swap was still in flight — the
    /// deep-abort driver was invoked (which itself still tries the cooperative
    /// refund FIRST and swipes only if that will not go out).
    Fired,
    /// The swap resolved (stop raised) before T2 — no deep abort.
    Stopped,
}

/// CC-3: fires the leader's deep-abort driver exactly once when the ENGINE's
/// T2 passes, unless the swap settles first. The T2 sibling of
/// [`RefundWatcher`] — a SEPARATE watcher on purpose (plan v75 D-F): T1 missed
/// costs a retry, T2 missed costs the coin, and merging them means one bug
/// reaches both.
///
/// Before this existed, `deep_abort_decision` was only ever reached REACTIVELY
/// — inside the T1 watcher's single fire. A refund that failed at T1 with T2
/// still ahead got `TooEarly`, the fire was spent, and nothing ever came back
/// at T2. The desk's swipe on the 07-30 rung was scheduled by ITS engine;
/// ours had no schedule at all.
///
/// The deadline is CC-2's ENGINE value, never the advertised `t2` — a watcher
/// on an advertised deadline is worse than none: it fires early, the chain
/// rejects the swipe, and the failure reads as "the swipe failed" when the
/// true answer is "not yet" (D48).
pub struct SwipeWatcher {
    /// Absolute engine T2 in unix seconds (wall-clock, so a watcher rehydrated
    /// after a restart fires at the same real instant the original would have).
    pub t2_engine_unix: u64,
    /// Cadence for re-checking the clock + the stop flag.
    pub poll: Duration,
}

impl SwipeWatcher {
    pub fn new(t2_engine_unix: u64) -> Self {
        Self {
            t2_engine_unix,
            poll: Duration::from_secs(2),
        }
    }

    /// Run the watch loop. Same contract as [`RefundWatcher::run`]: `on_swipe`
    /// is awaited INLINE and fires at most once; a cooperative stop wins over
    /// the deadline. The driver behind `on_swipe` logs its own verdict — this
    /// loop's job is only to guarantee the T2 schedule exists and is loud
    /// (D50: the most consequential branch this protocol ever took once left
    /// no trace in a log).
    pub async fn run<N, R, F>(&self, stop: Arc<AtomicBool>, now: N, on_swipe: R) -> SwipeOutcome
    where
        N: Fn() -> u64,
        R: FnOnce() -> F,
        F: std::future::Future<Output = ()>,
    {
        let poll = if self.poll.is_zero() {
            Duration::from_millis(100)
        } else {
            self.poll
        };
        let mut on_swipe = Some(on_swipe);
        loop {
            if stop.load(Ordering::SeqCst) {
                return SwipeOutcome::Stopped;
            }
            if now() >= self.t2_engine_unix {
                if let Some(f) = on_swipe.take() {
                    f().await;
                }
                return SwipeOutcome::Fired;
            }
            tokio::time::sleep(poll).await;
        }
    }
}

/// Current wall-clock time in unix seconds — the production clock for
/// [`RefundWatcher::run`].
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn mock_observer_reports_what_was_set() {
        let obs = MockObserver::new();
        assert_eq!(obs.observe_lock(Chain::A), LockSighting::NotYet { confs: 0 });
        assert_eq!(obs.observe_lock(Chain::B), LockSighting::NotYet { confs: 0 });
        obs.set_confirmed(Chain::A, 3);
        assert!(obs.observe_lock(Chain::A).is_confirmed_to(1));
        assert_eq!(obs.observe_lock(Chain::B), LockSighting::NotYet { confs: 0 });
    }

    /// The depth floor is applied by the READER, so a shallow confirmation
    /// cannot pass a gate that wanted more. `watch_lock` floors depth at `>= 1`
    /// [B2]; anything above that is the caller's policy.
    #[test]
    fn a_confirmation_shallower_than_required_is_not_confirmed() {
        let s = LockSighting::Confirmed {
            confs: 2,
            height: 10,
            txid: "t".into(),
        };
        assert!(s.is_confirmed_to(2));
        assert!(!s.is_confirmed_to(3), "2 confs must not satisfy a 3-conf floor");
    }

    /// The distinction the protocol forbids collapsing: neither non-confirmed
    /// state passes, but they are not the same state.
    #[test]
    fn could_not_look_is_not_the_same_as_not_yet() {
        let blind = LockSighting::CouldNotLook {
            error: "connection refused".into(),
        };
        let waiting = LockSighting::NotYet { confs: 0 };
        assert!(!blind.is_confirmed_to(1));
        assert!(!waiting.is_confirmed_to(1));
        assert_ne!(
            blind, waiting,
            "collapsing these loses the difference between a patient swap and a blind one"
        );
    }

    /// safety_test.go::TestRefundWatcher_FiresAtT1WhenNotDone — the desk is
    /// offline (irrelevant here by design), T1 has passed, so the refund fires.
    #[tokio::test]
    async fn refund_fires_at_t1_when_not_stopped() {
        let stop = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        let w = RefundWatcher {
            t1_unix: 100,
            poll: Duration::from_millis(1),
        };
        // Clock already past T1 -> fires on the first iteration, no real wait.
        let outcome = w
            .run(stop, || 200, move || async move {
                f.store(true, Ordering::SeqCst)
            })
            .await;
        assert_eq!(outcome, RefundOutcome::Refunded);
        assert!(fired.load(Ordering::SeqCst), "on_refund must have fired");
    }

    /// safety_test.go::TestRefundWatcher_NoRefundWhenDone — the swap settled
    /// cooperatively (stop raised), so no refund even though T1 has passed.
    #[tokio::test]
    async fn refund_does_not_fire_when_stopped() {
        let stop = Arc::new(AtomicBool::new(true)); // settled before T1
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        let w = RefundWatcher {
            t1_unix: 100,
            poll: Duration::from_millis(1),
        };
        let outcome = w
            .run(stop, || 200, move || async move {
                f.store(true, Ordering::SeqCst)
            })
            .await;
        assert_eq!(outcome, RefundOutcome::Stopped);
        assert!(!fired.load(Ordering::SeqCst), "must not refund a settled swap");
    }

    /// CC-3: the swipe watcher fires once the ENGINE's T2 passes — the
    /// schedule that never existed before it (the deep abort was only ever
    /// reached reactively, inside the T1 fire).
    #[tokio::test]
    async fn swipe_fires_at_engine_t2_when_not_stopped() {
        let stop = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        let w = SwipeWatcher {
            t2_engine_unix: 1_800,
            poll: Duration::from_millis(1),
        };
        let outcome = w
            .run(stop, || 1_800, move || async move {
                f.store(true, Ordering::SeqCst)
            })
            .await;
        assert_eq!(outcome, SwipeOutcome::Fired);
        assert!(
            fired.load(Ordering::SeqCst),
            "the deadline is inclusive, same as the T1 watcher — an off-by-one delays the \
             deep abort by a poll interval"
        );
    }

    /// CC-3: a settled swap is never deep-aborted — stop wins over the
    /// deadline, mirroring the T1 watcher exactly.
    #[tokio::test]
    async fn swipe_does_not_fire_when_stopped() {
        let stop = Arc::new(AtomicBool::new(true));
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        let w = SwipeWatcher {
            t2_engine_unix: 100,
            poll: Duration::from_millis(1),
        };
        let outcome = w
            .run(stop, || 200, move || async move {
                f.store(true, Ordering::SeqCst)
            })
            .await;
        assert_eq!(outcome, SwipeOutcome::Stopped);
        assert!(!fired.load(Ordering::SeqCst), "must not deep-abort a settled swap");
    }

    /// CC-3: the watcher waits — it does not fire before the engine's T2, the
    /// window in which the chain would reject the swipe (D48's 1200s was
    /// exactly this window).
    #[tokio::test]
    async fn swipe_waits_for_the_engines_t2_before_firing() {
        let stop = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let clock = Arc::new(AtomicU64::new(700)); // past an advertised 600, before 1800

        let c2 = clock.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            c2.store(1_800, Ordering::SeqCst);
        });

        let f = fired.clone();
        let c3 = clock.clone();
        let w = SwipeWatcher {
            t2_engine_unix: 1_800,
            poll: Duration::from_millis(1),
        };
        let outcome = w
            .run(
                stop,
                move || c3.load(Ordering::SeqCst),
                move || async move { f.store(true, Ordering::SeqCst) },
            )
            .await;
        assert_eq!(outcome, SwipeOutcome::Fired);
        assert!(fired.load(Ordering::SeqCst));
    }

    /// The loop actually polls: it does not fire until the injected clock
    /// advances past T1 (the closest analog to the Go real-time test).
    #[tokio::test]
    async fn refund_fires_after_clock_advances_past_t1() {
        let stop = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let clock = Arc::new(AtomicU64::new(0));

        // Advance the clock past T1 shortly after the watcher starts.
        let c2 = clock.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            c2.store(100, Ordering::SeqCst);
        });

        let f = fired.clone();
        let c3 = clock.clone();
        let w = RefundWatcher {
            t1_unix: 50,
            poll: Duration::from_millis(1),
        };
        let outcome = w
            .run(
                stop,
                move || c3.load(Ordering::SeqCst),
                move || async move { f.store(true, Ordering::SeqCst) },
            )
            .await;
        assert_eq!(outcome, RefundOutcome::Refunded);
        assert!(fired.load(Ordering::SeqCst));
    }
}
