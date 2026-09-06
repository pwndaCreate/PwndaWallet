//! The REAL [`ChainObserver`]: our own view of both chains, taken through our
//! own engine sidecar's `watch_lock`.
//!
//! # Why this is not a hand-rolled chain client
//!
//! The obvious build would be a Blockfrost client for Cardano and a
//! `monero-wallet-rpc` client for Monero. It would also be wrong, for the same
//! reason we do not re-implement the crypto: `watch_lock` does not merely count
//! confirmations, it **binds the sighting to the swap** —
//!
//! > `BOTH chains now bind amount (A: >= amountA [E4]; B: destination == joint
//! > addr AND >= amountB), depth floored at >= 1 [B2]`
//!
//! — and that binding is the whole safety property. As the desk put it: *depth
//! alone is not enough; an under-funded or wrong-address lock confirms N blocks
//! deep too.* A tip query answering "does this txid have N confirmations?" would
//! satisfy [`ChainObserver`] perfectly and silently drop the address and amount
//! check. Driving the engine keeps the binding where it is already implemented,
//! reviewed, and shared with the counterparty's identical engine.
//!
//! This is still **our own** view, not the desk's: our sidecar, our chain
//! credential, our process. The invariant is "never trust the desk's `/status`",
//! not "never use a library".
//!
//! # Split of responsibilities
//!
//! [`ChainObserver::observe_lock`] is a cheap non-blocking read, because it sits
//! on the gate path. The network I/O lives in [`SidecarObserver::poll_once`],
//! which a background task calls on a cadence and which writes the latest
//! sighting into the cell the gate reads.
//!
//! # Fail-soft, preserved end to end
//!
//! `watch_lock` fails SOFT (C3): an unreachable chain returns `confirmed:false`
//! with a populated `error` rather than raising. The mapping here keeps those
//! three outcomes apart — confirmed / not-yet / could-not-look — all the way to
//! the gate. Collapsing them is the documented way to make a FOLLOWER mistake
//! its own connectivity loss for "the desk never locked".

#![allow(dead_code)] // consumed by the rung-3 driver

use std::sync::Mutex;

use super::crypto::VendoredDeskCrypto;
use super::watch::{Chain, ChainObserver, LockSighting};

/// How old a sighting may be and still count as our current view.
///
/// **This is the difference between "the chain says so" and "the chain said so
/// once".** Without it a `Confirmed` written an hour ago reads at the gate
/// exactly like one written a second ago, so a poll loop that died — a panicked
/// task, a starved runtime, a sidecar that never came back — leaves every later
/// gate reading a frozen positive and looking perfectly healthy. That is the
/// silent-failure shape this integration keeps turning up, and the observer had
/// it: a cache with no clock is indistinguishable from a live feed.
///
/// Six poll intervals rather than one or two: a single slow round-trip must not
/// flap a gate to blind, but nothing should be trusted across minutes of
/// silence.
pub const STALENESS_INTERVALS: u32 = 6;

/// The bound for an observer polled at the DEFAULT cadence.
///
/// Prefer [`SidecarObserver::max_age`] over this constant. It exists for the
/// common case and for tests; deriving a bound from a default while the loop
/// takes its cadence as a *parameter* is exactly the coupling the desk caught —
/// see [`SidecarObserver::with_interval`].
pub const MAX_SIGHTING_AGE: std::time::Duration = POLL_INTERVAL.saturating_mul(STALENESS_INTERVALS);

/// A [`ChainObserver`] backed by our own engine sidecar.
pub struct SidecarObserver {
    a: Mutex<Dated>,
    b: Mutex<Dated>,
    /// How old a sighting may be, derived from **this observer's** poll cadence
    /// rather than the default.
    ///
    /// The desk's finding: `run_poll_loop` takes the interval as a parameter,
    /// so a bound computed from the default constant agreed with reality only
    /// because the one caller happened to pass that same constant — discipline,
    /// not construction. Widening the interval (the obvious lever, since both
    /// sides share one Blockfrost rate-limit bucket) would make every sighting
    /// stale before the next poll landed and every gate permanently blind.
    ///
    /// It **fails safe**, which is precisely why it would never surface as a
    /// bug in testing — it would surface during a funded run as "we cannot see
    /// the chain". So the relationship is now structural: pass the cadence in
    /// and the bound follows it.
    max_age: std::time::Duration,
}

/// A sighting plus when it was taken. `at: None` means "never polled".
struct Dated {
    sighting: LockSighting,
    at: Option<std::time::Instant>,
}

impl Default for SidecarObserver {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarObserver {
    /// Starts BLIND, not "not yet".
    ///
    /// This matters more than it looks. A fresh observer has not seen the chain
    /// at all, and `NotYet` would be a claim about the counterparty that we have
    /// no basis for. Starting at [`LockSighting::CouldNotLook`] means a gate
    /// consulted before the first successful poll refuses with "cannot see chain
    /// X" rather than the confident-sounding "the counterparty has not locked".
    pub fn new() -> Self {
        Self::with_interval(POLL_INTERVAL)
    }

    /// An observer whose staleness bound follows the cadence it will actually be
    /// polled at. Pass the same `interval` to [`run_poll_loop`].
    pub fn with_interval(interval: std::time::Duration) -> Self {
        let blind = || {
            Mutex::new(Dated {
                sighting: LockSighting::CouldNotLook {
                    error: "no poll has completed yet".to_string(),
                },
                at: None,
            })
        };
        Self {
            a: blind(),
            b: blind(),
            max_age: if interval.is_zero() {
                MAX_SIGHTING_AGE
            } else {
                interval.saturating_mul(STALENESS_INTERVALS)
            },
        }
    }

    /// How old a sighting from this observer may be before it stops counting.
    pub fn max_age(&self) -> std::time::Duration {
        self.max_age
    }

    fn cell(&self, chain: Chain) -> &Mutex<Dated> {
        match chain {
            Chain::A => &self.a,
            Chain::B => &self.b,
        }
    }

    /// One `watch_lock` round-trip for one leg, writing the result into the cell
    /// the gate reads. Returns the sighting it stored.
    ///
    /// A transport-level failure is recorded as [`LockSighting::CouldNotLook`]
    /// rather than propagated: the engine already fails soft for an unreachable
    /// chain, and a dead sidecar is the same class of event from the gate's point
    /// of view — we cannot see. Propagating would tempt a caller into treating
    /// the `Err` as "not locked".
    pub async fn poll_once(
        &self,
        crypto: &VendoredDeskCrypto,
        swap_id: &str,
        chain: Chain,
    ) -> LockSighting {
        let sighting = match crypto.watch_lock(swap_id, chain.as_str()).await {
            Ok(v) => Self::map_watch_lock(&v),
            Err(e) => LockSighting::CouldNotLook {
                error: format!("sidecar did not answer watch_lock: {e}"),
            },
        };
        *self.cell(chain).lock().expect("observer cell") = Dated {
            sighting: sighting.clone(),
            at: Some(std::time::Instant::now()),
        };
        sighting
    }

    /// Map a `watch_lock` result — `{confirmed, confs, height, txid, error}` —
    /// onto the three states.
    ///
    /// Order matters: a populated `error` means "could not look" EVEN IF
    /// `confirmed` is false, because that false is the fail-soft default and not
    /// an observation. Checking `confirmed` first would relabel every outage as
    /// a confident "not yet".
    fn map_watch_lock(v: &serde_json::Value) -> LockSighting {
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("").trim();
        let confirmed = v
            .get("confirmed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let confs = v.get("confs").and_then(serde_json::Value::as_u64).unwrap_or(0);

        if !err.is_empty() && !confirmed {
            return LockSighting::CouldNotLook {
                error: err.to_string(),
            };
        }
        if confirmed {
            return LockSighting::Confirmed {
                confs,
                height: v.get("height").and_then(serde_json::Value::as_u64).unwrap_or(0),
                txid: v
                    .get("txid")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string(),
            };
        }
        LockSighting::NotYet { confs }
    }
}

impl ChainObserver for SidecarObserver {
    fn observe_lock(&self, chain: Chain) -> LockSighting {
        let cell = self.cell(chain).lock().expect("observer cell");
        match cell.at {
            // Fresh enough to be our current view.
            Some(at) if at.elapsed() <= self.max_age => cell.sighting.clone(),
            // Stale. Reported as CouldNotLook rather than the cached value,
            // because that is the honest state: we do not know what the chain
            // says now. Note this DOWNGRADES a stale `Confirmed` — which is the
            // whole point, since a frozen positive is the one that moves funds.
            Some(at) => LockSighting::CouldNotLook {
                error: format!(
                    "the last sighting for chain {} is {}s old (limit {}s) - the poll loop has \
                     stopped or is starved, so this is not our current view of the chain",
                    chain.as_str(),
                    at.elapsed().as_secs(),
                    self.max_age.as_secs()
                ),
            },
            None => cell.sighting.clone(),
        }
    }
}

/// How often the background poll asks the chain. Slow on purpose: block times on
/// both legs are measured in tens of seconds to minutes, so a tighter cadence
/// buys nothing and, on a shared Blockfrost project id, spends the rate-limit
/// bucket both sides draw from.
pub const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Keep `observer` fresh for both legs until `stop` is raised.
///
/// Polls BOTH legs every tick rather than only the one currently being waited
/// on. It costs one extra call and removes a whole class of bug: the leg we care
/// about changes as the swap advances (a follower waits on A to lock, then on
/// its own B to confirm), and a loop that tracks "which leg matters now" has to
/// be kept in step with the state machine. This one does not.
///
/// Never stops on error. A failing poll writes [`LockSighting::CouldNotLook`]
/// and the loop continues — an observer task that exited on a transient outage
/// would leave every later gate reading a frozen, increasingly stale sighting
/// while looking perfectly healthy.
pub async fn run_poll_loop(
    observer: std::sync::Arc<SidecarObserver>,
    crypto: &'static VendoredDeskCrypto,
    swap_id: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    interval: std::time::Duration,
    watch_b: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    let interval = if interval.is_zero() {
        POLL_INTERVAL
    } else {
        interval
    };
    let mut announced_b = false;
    while !stop.load(Ordering::SeqCst) {
        let b_live = watch_b.load(Ordering::SeqCst);
        if b_live && !announced_b {
            announced_b = true;
            eprintln!("[desk::observer] swap {swap_id}: chain B now has a leg — watching both chains");
        }
        // C33: the flag can also go BACK to false — `hold_open_for_refund` stands
        // the chain-B watch down so the refund is not queued behind a ~128s cold
        // wallet restore. Announce that too. A watcher that goes quiet without
        // saying so is indistinguishable from a watcher that died, which is the
        // exact confusion C29 and the desk's own watchdog were both about.
        if !b_live && announced_b {
            announced_b = false;
            eprintln!(
                "[desk::observer] swap {swap_id}: chain-B watch stood down — polling chain A only"
            );
        }
        for chain in chains_to_poll(b_live) {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            observer.poll_once(crypto, &swap_id, *chain).await;
        }
        tokio::time::sleep(interval).await;
    }
    eprintln!("[desk::observer] swap {swap_id}: poll loop stopped");
}

/// Which chains are worth looking at, given whether chain B has a leg yet.
///
/// **Watching chain B before a chain-B lock exists is not merely wasted work —
/// it is actively harmful**, and it cost a funded drive on 2026-07-25.
/// `watch_lock(B)` restores a per-swap joint VIEW wallet on the Monero
/// wallet-rpc, which (a) re-points that rpc away from the funded reserve, so the
/// engine's lock guard can later find a watch-only wallet open and refuse, and
/// (b) triggers a wallet rescan that monopolises the ONE serialised engine
/// sidecar every protocol call shares — starving `set_lock_utxo` until its 30s
/// timeout fired and killed the drive before a single stage completed.
///
/// Chain A is cheap by comparison (a Blockfrost query, no wallet), so it is
/// always polled: on SELL the observe-A gate depends on it from the start.
fn chains_to_poll(watch_b: bool) -> &'static [Chain] {
    if watch_b {
        &[Chain::A, Chain::B]
    } else {
        &[Chain::A]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wl(json: serde_json::Value) -> LockSighting {
        SidecarObserver::map_watch_lock(&json)
    }

    #[test]
    fn chain_b_is_not_watched_until_it_has_a_leg() {
        // Before our leg exists, watching B restores a joint view wallet for a
        // lock that is not there — which re-points the shared wallet-rpc and
        // wedges the serialised sidecar. A is always safe to watch.
        assert_eq!(chains_to_poll(false), &[Chain::A]);
        assert_eq!(chains_to_poll(true), &[Chain::A, Chain::B]);
    }

    #[test]
    fn a_confirmed_lock_carries_its_depth_and_txid() {
        let s = wl(serde_json::json!({
            "confirmed": true, "confs": 4, "height": 900, "txid": "abcd", "error": ""
        }));
        assert_eq!(
            s,
            LockSighting::Confirmed {
                confs: 4,
                height: 900,
                txid: "abcd".into()
            }
        );
        assert!(s.is_confirmed_to(4));
        assert!(!s.is_confirmed_to(5));
    }

    #[test]
    fn a_clean_miss_is_not_yet_with_the_depth_seen() {
        assert_eq!(
            wl(serde_json::json!({ "confirmed": false, "confs": 1, "error": "" })),
            LockSighting::NotYet { confs: 1 }
        );
    }

    /// The C3 mapping, and the reason this file exists. `watch_lock` fails soft:
    /// an unreachable chain answers `confirmed:false` WITH an error. Read
    /// `confirmed` first and every outage becomes a confident "the counterparty
    /// has not locked" — which for a FOLLOWER is precisely the misreading the
    /// protocol names.
    #[test]
    fn an_unreachable_chain_is_could_not_look_never_not_yet() {
        let s = wl(serde_json::json!({
            "confirmed": false, "confs": 0, "error": "connection refused"
        }));
        match s {
            LockSighting::CouldNotLook { error } => assert!(error.contains("connection refused")),
            other => panic!("an outage must not be reported as an observation: {other:?}"),
        }
    }

    /// A missing `error` key must behave like an empty one, not like a fault —
    /// the engine omits it on the happy path.
    #[test]
    fn an_absent_error_field_is_not_an_outage() {
        assert_eq!(
            wl(serde_json::json!({ "confirmed": false, "confs": 0 })),
            LockSighting::NotYet { confs: 0 }
        );
    }

    /// A malformed/empty answer must not read as "not yet" either — we did not
    /// learn anything about the chain from it.
    #[test]
    fn an_unparseable_answer_does_not_become_evidence() {
        // No `confirmed`, but an error present -> could-not-look.
        match wl(serde_json::json!({ "error": "engine returned garbage" })) {
            LockSighting::CouldNotLook { .. } => {}
            other => panic!("expected could-not-look, got {other:?}"),
        }
    }

    /// A fresh observer has not looked at anything. It must not imply the
    /// counterparty failed to lock.
    #[test]
    fn a_fresh_observer_is_blind_not_negative() {
        let obs = SidecarObserver::new();
        for chain in [Chain::A, Chain::B] {
            match obs.observe_lock(chain) {
                LockSighting::CouldNotLook { error } => {
                    assert!(error.contains("no poll"), "got: {error}")
                }
                other => panic!(
                    "an observer that has never polled must report blindness, not a claim \
                     about the counterparty: {other:?}"
                ),
            }
        }
    }

    /// Plant a sighting observed **now**.
    ///
    /// Deliberately does NOT back-date via `Instant::now() - age`: `Instant`
    /// subtraction panics on underflow by contract, so on a machine that has
    /// been up for less than the age being subtracted — a reboot, a fresh CI
    /// container — the test would *panic* rather than fail, reporting the wrong
    /// cause entirely. The desk caught that.
    ///
    /// Staleness is now produced by shrinking the BOUND instead of by inventing
    /// a past, which needs no clock arithmetic at all and exercises the
    /// configurable bound at the same time.
    fn plant(obs: &SidecarObserver, chain: Chain, s: LockSighting) {
        *obs.cell(chain).lock().unwrap() = Dated {
            sighting: s,
            at: Some(std::time::Instant::now()),
        };
    }

    /// An observer whose sightings go stale almost immediately.
    fn fast_stale() -> SidecarObserver {
        SidecarObserver::with_interval(std::time::Duration::from_millis(5))
    }

    fn wait_past_bound(obs: &SidecarObserver) {
        std::thread::sleep(obs.max_age() + std::time::Duration::from_millis(30));
    }

    fn confirmed(confs: u64) -> LockSighting {
        LockSighting::Confirmed {
            confs,
            height: 1,
            txid: "a".into(),
        }
    }

    /// The two legs are independent: confirming A must not imply anything about B.
    #[test]
    fn the_two_legs_do_not_leak_into_each_other() {
        let obs = SidecarObserver::new();
        plant(&obs, Chain::A, confirmed(3));
        assert!(obs.observe_lock(Chain::A).is_confirmed_to(3));
        assert!(!obs.observe_lock(Chain::B).is_confirmed_to(1));
    }

    /// **A cache with no clock is indistinguishable from a live feed.** If the
    /// poll loop dies, every later gate reads a frozen positive and looks
    /// healthy. So a sighting past the freshness bound stops counting as our
    /// view of the chain.
    #[test]
    fn a_stale_confirmation_stops_being_confirmed() {
        let obs = fast_stale();
        plant(&obs, Chain::A, confirmed(9));
        wait_past_bound(&obs);
        assert!(
            !obs.observe_lock(Chain::A).is_confirmed_to(1),
            "a sighting older than the bound must not gate a lock"
        );
        match obs.observe_lock(Chain::A) {
            LockSighting::CouldNotLook { error } => {
                assert!(error.contains("old"), "the error must say it is stale: {error}");
                assert!(
                    error.contains("poll loop"),
                    "and name the likely cause: {error}"
                );
            }
            other => panic!("stale must downgrade to could-not-look, got {other:?}"),
        }
    }

    /// It downgrades to COULD-NOT-LOOK, never to NotYet. Stale means we do not
    /// know what the chain says now — reporting "not yet" would be a fresh claim
    /// about the counterparty built out of our own silence.
    #[test]
    fn stale_becomes_blind_not_a_negative_claim() {
        let obs = fast_stale();
        plant(&obs, Chain::B, LockSighting::NotYet { confs: 2 });
        wait_past_bound(&obs);
        assert!(matches!(
            obs.observe_lock(Chain::B),
            LockSighting::CouldNotLook { .. }
        ));
    }

    /// A sighting inside the bound is untouched — the guard must not flap a
    /// healthy gate on one slow round-trip.
    #[test]
    fn a_recent_sighting_passes_through_unchanged() {
        let obs = SidecarObserver::new();
        plant(&obs, Chain::A, confirmed(4));
        assert!(obs.observe_lock(Chain::A).is_confirmed_to(4));
    }

    /// **The bound must follow the observer's OWN cadence, not the default.**
    ///
    /// `run_poll_loop` takes the interval as a parameter, so a bound computed
    /// from the default constant agreed with reality only because the single
    /// caller happened to pass that same constant. Widening the interval — the
    /// obvious lever, since both sides share one Blockfrost rate-limit bucket —
    /// would have made every sighting stale before the next poll landed, and
    /// every gate permanently blind.
    ///
    /// It fails SAFE, which is exactly why no test would have caught it: it
    /// would have surfaced during a funded run as "we cannot see the chain".
    #[test]
    fn the_staleness_bound_follows_the_configured_interval() {
        let slow = SidecarObserver::with_interval(std::time::Duration::from_secs(60));
        assert_eq!(
            slow.max_age(),
            std::time::Duration::from_secs(60 * STALENESS_INTERVALS as u64),
            "a slower poll must widen the bound with it, or the observer blinds itself"
        );
        assert!(
            slow.max_age() > MAX_SIGHTING_AGE,
            "and must not stay pinned to the default"
        );
        assert_eq!(SidecarObserver::new().max_age(), MAX_SIGHTING_AGE);
    }

    /// A zero interval must not produce a zero bound — that would make every
    /// sighting instantly stale, which is the failure above in its worst form.
    #[test]
    fn a_zero_interval_falls_back_to_the_default_bound() {
        let obs = SidecarObserver::with_interval(std::time::Duration::ZERO);
        assert_eq!(obs.max_age(), MAX_SIGHTING_AGE);
        plant(&obs, Chain::A, confirmed(2));
        assert!(obs.observe_lock(Chain::A).is_confirmed_to(2));
    }
}
