//! Sidecar interface fee — the self-driving watcher.
//!
//! Spec: `CLIENT-PLAN-SIDECAR-FEES.md` (policy), `HANDOFF-SIDECAR-FEES.md`
//! (parameters), [[fee-enforcement-and-fork-resistance]] (placement), and
//! [[sidecar-fee-implementation-plan]] — which is the one that matches the code,
//! because it was written against the code rather than the spec.
//!
//! # The property this module exists to have
//!
//! **The watcher owns the whole path.** It detects settlement, computes the fee
//! and issues the withdraw *as a consequence of detecting settlement* — never on
//! request from the frontend. A Rust `settle_fee()` **called by** TypeScript is
//! defeated by patching the easier TS call site; a self-driving watcher can only
//! be removed by a Rust rebuild. That is the entire argument for the placement,
//! and `no_command_can_trigger_settlement` pins it.
//!
//! Every command this module exposes is **read-only**.
//!
//! # Three modes, default OFF
//!
//! `PWNDA_SIDECAR_FEES` = `off` (default) | `dark` | `live`.
//!
//! * **off**  — the watcher never starts. Shipped default.
//! * **dark** — full detection and decision, records what it WOULD charge, and
//!   **never opens the money path**. This is the phase that validates
//!   eligibility, leg selection and the schedule against real mainnet swaps at
//!   zero risk. Read `sidecar_fees_history` after a few swaps before going live.
//! * **live** — collects. Behind the counsel gate.
//!
//! # What it reads
//!
//! **The taker's list only** — `POST /json/sentbids` — with **no filter**.
//! (Until 2026-09-04 it was both lists; the operator's rule is now "takers
//! only, scripted coins only — makers and scriptless coins are free", so the
//! received half of the book, where this node is the MAKER, is deliberately
//! not swept. See [`SWEEP_ENDPOINTS`].)
//!
//! Two independent things are being said there, and an earlier version of this
//! comment said only the first, which is how the watcher shipped blind:
//!
//! 1. **No STATE filter.** `with_available_or_active` defaults false and
//!    `with_expired` defaults true, and `js_server.py` treats them as mutually
//!    exclusive — so an unfiltered sweep returns terminal bids and there is no
//!    missed-settlement race to engineer around. Passing
//!    `{"with_available_or_active": true}` would reintroduce one.
//! 2. **Both ROLES.** `bids` is not the book; it is the half of it this node
//!    *received*. `js_bids` calls `listBids(sent=False)`, which appends
//!    `AND bids.was_received = 1`. Our users are takers, whose bids carry
//!    `was_sent = 1` and appear only on `sentbids` — the endpoint the wallet's
//!    own tracker reads (`basicswap.ts::fetchSentBids`). Sweeping `bids` alone
//!    meant the watcher could not see a single swap the user made, in any mode,
//!    ever. See [`SWEEP_ENDPOINTS`].
//!
//! Both endpoints are already on the supervisor's read allow-list; nothing is
//! widened for the fee, and `both_sweep_endpoints_are_on_the_read_allow_list`
//! keeps it that way.
//!
//! # What it charges — and what it deliberately does not
//!
//! Only bids created **after this wallet first started watching**
//! ([`ledger::read_or_create_baseline`]). The node's database can already hold
//! years of completed swaps on a first start; without that floor the first live
//! tick would bill every XMR pair the user had ever completed, for swaps that
//! settled while collection was off.

//! # The five invariants — read this before changing anything here
//!
//! The fee is **deliberately removable**. It is open-source software running on
//! the user's machine, so it always was; every attempt to make it otherwise —
//! obfuscation, attestation, licence keys — costs more than it saves and breaks
//! the open-source claim, and the one technique that would actually work
//! (refusing to settle a swap until the fee is paid) turns a software vendor
//! into a coordinator standing between someone and their own funds. We will not
//! build that. See [[fee-enforcement-and-fork-resistance]] for the full
//! argument; what follows is the part that constrains *this code*.
//!
//! What defends the fee is **placement and candour**, not prevention: removing
//! it should require a Rust rebuild rather than a text edit, and the wallet
//! should say so out loud (`FEE.md`). Each invariant below is what preserves
//! one of those properties, and each names the test that pins it. **If you
//! break one, you have not just changed behaviour — you have moved the fee into
//! a category the project has refused.**
//!
//! 1. **The watcher owns the whole path; no command may trigger settlement.**
//!    A Rust `settle_fee()` *called by* TypeScript is defeated by patching the
//!    easier half of the binary, and then the entire Rust-placement argument is
//!    worth nothing. Detection must cause collection.
//!    → `tests::no_command_can_trigger_settlement`
//! 2. **A release build exposes no runtime fee switch at all** — not even one
//!    that does nothing. `SHIPPED_MODE` is compiled in; the env read is
//!    `debug_assertions`-only. A switch that *appears* to disable a fee and does
//!    not is the `hyle-team/zano-pool` fault, and that fault — not the fee — is
//!    what made it read as malicious. Friction is legitimate; false affordances
//!    are not. → `tests::release_builds_ignore_the_environment` (release only)
//!    and `tests::mode_defaults_to_off_for_anything_unrecognised`
//! 3. **The fee never gates a swap.** No swap-path module may depend on this
//!    one. A swap must run and settle identically whether a fee is ever paid,
//!    which is a compliance boundary rather than a preference: gating converts
//!    us into a coordinator. → `tests::the_swap_path_does_not_depend_on_the_fee`
//! 4. **Only `SWAP_COMPLETED` is chargeable, and only after the fact.** Nothing
//!    is charged on a failure, refund, abort, expiry, swipe or mercy outcome —
//!    not by refunding, but because collection happens only after success.
//!    → `engine::tests::only_swap_completed_is_chargeable`
//! 5. **The schedule is compiled in and inspectable**: no env override, no JSON
//!    config, no remote source, addresses checksum-verified at build time. A fee
//!    the user can read and check is the only kind worth charging, and a
//!    remotely-changeable one would fail the walk-away test.
//!    → `schedule::tests::every_address_passes_its_own_checksum`
//!
//! A sixth is not enforceable here but belongs with them: **never describe the
//! fee as a commission, a spread, or a share of the trade**, in UI copy, docs or
//! comments. It is a per-use licence fee. That wording is load-bearing.

pub mod engine;
pub mod ledger;
pub mod schedule;
pub mod settle;

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::swap_bridge::{is_transport_failure, HttpPoster};
use crate::swap_sidecar::{
    api_context, basic_auth_header, build_api_url, coin_key_from, decode_api_response,
    sidecar_base_dir, ApiMethod, SwapSidecarState,
};

use engine::{Decision, SettledBid, SkipReason};
use ledger::{FeeRecord, FeeState};

/// Matches `desk/observer.rs`'s cadence. A swap leg is 30–90 minutes; there is
/// nothing to gain from polling harder, and the node is doing real work.
const POLL: Duration = Duration::from_secs(15);
/// How long to wait when the node is not up. Not an error — the ordinary state.
const IDLE_POLL: Duration = Duration::from_secs(60);
/// Give up deferring after this many attempts and close the record.
///
/// It was 40 attempts at the 15-second poll — ten minutes — which is shorter
/// than ONE slow Bitcoin or Bitcoin Cash block. A fee whose only obstacle was
/// "the inflow has not confirmed yet" (the buy-scripted direction leaves the
/// taker's payout unconfirmed at `SWAP_COMPLETED`, and the electrum funder
/// skips unconfirmed inputs) would routinely expire as `deferredExpired`,
/// silently and forever.
///
/// 96 attempts covers both waits this module can be in, because the backoff
/// differs by reason — see [`DEFER_BACKOFF`] and [`DEFER_BACKOFF_IN_FLIGHT`]:
///
/// | waiting for | backoff | total |
/// |---|---|---|
/// | a confirmation | 5 min | 8 hours |
/// | a swap on the same coin to end | 30 min | **48 hours** |
const MAX_DEFER_TRIES: u32 = 96;

/// How long a record waits when the WALLET cannot pay yet.
///
/// A confirmation is minutes away; re-asking every 15 seconds burned the whole
/// retry budget inside one block interval.
const DEFER_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// How long a record waits when a SWAP ON THE SAME COIN is in flight.
///
/// # Why this is six times the other one
///
/// Measured against the thing actually being waited for. A swap that stalls
/// with both legs locked is resolved by its own timelock, not by a block: the
/// live example on 2026-09-05 (bid `000000006a9c9d96…`, LTC lock refund
/// publishable at 2026-09-06 18:51 UTC) was **twenty hours** out, and the
/// chain-A refund is only the first of two CSV waits before the coin-B
/// recovery lands.
///
/// At the 5-minute backoff the fee for the OTHER swap — already sitting
/// `deferred, LTC 249999` behind exactly that gate — would have burned its
/// whole budget in three hours and closed as `deferredExpired` while the
/// engine was still holding the coin. Under-collecting is the safe direction,
/// but not when it is this avoidable: 96 × 30 min outlasts the full timelock
/// chain, and `the_in_flight_wait_outlasts_a_swaps_own_timelock` pins the
/// arithmetic.
const DEFER_BACKOFF_IN_FLIGHT: Duration = Duration::from_secs(30 * 60);

/// The bid list swept every pass: `sentbids`, the TAKER's half of the book.
///
/// **`bids` is the maker's half.** Upstream's `js_bids` (`js_server.py`) calls
/// `listBids(sent=False)`, and `listBids` then appends `AND bids.was_received =
/// 1` — so that endpoint returns only bids this node RECEIVED, i.e. swaps where
/// this node posted the offer. A taker's own bids carry `was_sent = 1` and live
/// exclusively on `sentbids`, which is why the wallet's swap tracker reads that
/// one.
///
/// Until 2026-09-04 both lists were swept ("a user who posts their own offer is
/// a maker on their own book and that swap is equally chargeable"). The
/// operator's rule that day reversed it: **takers only — makers are free**, so
/// `bids` left this array. Adding it back is a one-word change here; the test
/// `the_sweep_reads_only_the_takers_list` is what makes that a decision rather
/// than an accident.
const SWEEP_ENDPOINTS: [&str; 1] = ["sentbids"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Off,
    Dark,
    Live,
}

/// The mode a RELEASE build ships with. **Compiled in: changing it requires a
/// rebuild**, and that is the entire point. A runtime variable that could turn
/// collection *off* would be a no-rebuild bypass, which is precisely what the
/// Rust placement exists to prevent.
///
/// It is deliberately not a *lying* switch either: a release build exposes no
/// runtime control at all, rather than one that looks like it works and does
/// not. That distinction is the difference between this and the
/// `hyle-team/zano-pool` dev fee the estate removed, where `devDonation: 0` was
/// structurally unreachable while appearing settable. Friction is legitimate;
/// false affordances are not. The rebuild path is documented in `FEE.md`.
///
/// **`Live` since 2026-09-05.** The operator turned collection on ("turn the
/// fee collection on, it should be default"), which is the go-live act this
/// constant exists to make deliberate. What went with it, in the same change,
/// because a fee the user cannot read is the one thing this module's own rules
/// forbid:
///
/// * `settings/SwapFeeCard.tsx` — the surface `FEE.md` had been promising in
///   the present tense while nothing rendered it: the rate, when it applies,
///   the addresses, and every record this wallet has computed or paid.
/// * `reserve_for_sale` wired to the swap form's MAX, so a taker selling the
///   scripted leg does not spend the fee and leave the record deferring for
///   forty passes before expiring.
///
/// Unchanged: no runtime switch in a release build, collection only after
/// `SWAP_COMPLETED`, takers only, scripted legs only, and the schedule
/// compiled in.
const SHIPPED_MODE: Mode = Mode::Live;

/// Parse a mode string. Pure, and always compiled so tests exercise the real
/// parser in any build kind. **Defaults to `Off`** — an unset or unrecognised
/// value must never collect.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn mode_from_str(v: Option<&str>) -> Mode {
    match v.map(str::trim) {
        Some("dark") => Mode::Dark,
        Some("live") => Mode::Live,
        _ => Mode::Off,
    }
}

/// Read the mode.
///
/// **Debug builds** honour `PWNDA_SIDECAR_FEES` (`dark` | `live` | `off`) so
/// dark-run testing needs no rebuild — but an UNSET variable now falls through
/// to [`SHIPPED_MODE`] rather than to `Off` (2026-09-05).
///
/// Before, a dev build ignored the shipped default entirely, so "on by
/// default" would have been true of every user's installer and false of the
/// operator's own `tauri dev` — the one place swaps are actually driven here.
/// An explicit `PWNDA_SIDECAR_FEES=off` still turns it off for a test run,
/// which is what the override is for.
#[cfg(debug_assertions)]
pub fn mode() -> Mode {
    match std::env::var("PWNDA_SIDECAR_FEES") {
        Ok(v) if !v.trim().is_empty() => mode_from_str(Some(&v)),
        _ => SHIPPED_MODE,
    }
}

/// **Release builds ignore the environment entirely.** There is no runtime
/// switch to find, so removing the fee from a shipped binary means editing
/// `SHIPPED_MODE` and rebuilding.
#[cfg(not(debug_assertions))]
pub fn mode() -> Mode {
    SHIPPED_MODE
}

pub fn fees_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sidecar_base_dir(app)?.join("fees"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn skip_label(r: SkipReason) -> &'static str {
    match r {
        SkipReason::NotSettled => "notSettled",
        SkipReason::Ended => "ended",
        SkipReason::NoScriptlessLeg => "noScriptlessLeg",
        SkipReason::NoFeeAddress => "noFeeAddress",
        SkipReason::UnreadableAmount => "unreadableAmount",
        SkipReason::Guard => "guard",
        SkipReason::Dust => "dust",
    }
}

/// The moment a deferred record may be looked at again, as the ledger stores it.
fn defer_until(backoff: Duration) -> String {
    (chrono::Utc::now() + chrono::Duration::from_std(backoff).unwrap_or_default()).to_rfc3339()
}

/// Is a deferred record still inside its backoff?
///
/// Pure, so the rule is testable. An `until` that will not parse is treated as
/// due — an unreadable timestamp must not park a fee forever.
pub fn deferral_pending(until: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::DateTime::parse_from_rfc3339(until.trim()) {
        Ok(t) => t.with_timezone(&chrono::Utc) > now,
        Err(_) => false,
    }
}

/// What the pre-settle checks decided, with money still untouched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreSettle {
    /// Everything holds: open the money path.
    Proceed,
    /// Not now — keep the record open and come back after the backoff.
    ///
    /// The `Duration` is how long to wait, which depends on WHAT is being
    /// waited for: a confirmation is minutes away, a swap holding the coin is
    /// hours. See [`DEFER_BACKOFF_IN_FLIGHT`].
    Defer(String, Duration),
}

/// The checks that run BEFORE the attempt marker, as one pure decision.
///
/// * `balance` — atomic units the wallet can spend, or `None` if unreadable.
///   Must cover the fee **and** the chain cost of sending it: `subfee: false`
///   means the wallet pays the transaction fee on top, so a balance exactly
///   equal to the fee is a withdraw that fails on funds.
/// * `in_flight_reserve` — atomic units of `ticker` the engine may still need
///   for swaps already in progress, or `None` if the node could not say.
///   **`None` defers.**
///
/// # Why a RESERVE and not a count (2026-09-05, second pass)
///
/// The first version deferred whenever *any* swap touched the coin. That is
/// the right instinct — the engine funds its lock transactions from the wallet
/// this fee would draw on, and a fee withdraw that outran a lock funding would
/// abort that swap, which is invariant 3 broken by accident — but it is a
/// PROXY, and it was wrong in the first case it met.
///
/// Live, 2026-09-05: a completed LTC swap owed 0.00249999 LTC and sat
/// `deferred` behind an XMR → LTC swap holding **0.09992627 LTC**, against a
/// wallet with **3.2 LTC** in it. Thirty-one times the headroom needed, and the
/// fee was blocked anyway — for hours, and potentially until its retry budget
/// ran out, because the coin was merely *mentioned*.
///
/// So measure the thing the rule is actually about: can the engine still fund
/// everything it might need after this fee leaves? Reserve every in-flight
/// swap's own leg IN FULL, add its send cost, and proceed only with room to
/// spare. That is strictly more conservative than a count in the case that
/// matters (a thin wallet reserves the real amount, not just "something is
/// happening") and stops blocking the case that never did.
///
/// Deliberately NOT direction-aware. "Only defer when the node is the side
/// that LOCKS this coin" would unblock more, and getting it wrong opens a
/// funds-affecting gate at exactly the wrong moment: `is_reverse_ads_bid`
/// flips which party is leader, so `was_sent` on a row is not the answer on
/// its own. Reserving both directions costs a little headroom and needs no
/// frame reasoning to be safe.
pub fn pre_settle_gate(
    ticker: &str,
    amount: u64,
    balance: Option<u64>,
    in_flight_reserve: Option<u64>,
) -> PreSettle {
    let tx_cost = schedule::row_for(ticker).map(|r| r.tx_cost).unwrap_or(0);
    // Same rule as `with_reserve` below: an unrepresentable requirement must
    // not clamp into one a balance can satisfy.
    let Some(need) = amount.checked_add(tx_cost) else {
        return PreSettle::Defer(
            format!("the fee for {ticker} does not fit in a u64 with its send cost"),
            DEFER_BACKOFF,
        );
    };
    match balance {
        Some(bal) if bal >= need => {}
        Some(bal) => {
            return PreSettle::Defer(
                format!(
                    "balance {} {} does not cover the fee {} plus its {} send cost",
                    schedule::format_amount(bal),
                    ticker,
                    schedule::format_amount(amount),
                    schedule::format_amount(tx_cost)
                ),
                DEFER_BACKOFF,
            )
        }
        None => {
            return PreSettle::Defer(
                "the wallet balance is not readable yet (still syncing, locked, or the \
                 node did not answer) — a zero from a syncing wallet is not a zero balance"
                    .to_string(),
                DEFER_BACKOFF,
            )
        }
    }
    let Some(reserved) = in_flight_reserve else {
        return PreSettle::Defer(
            "the node's in-flight swaps could not be read, so the fee waits rather than risk one"
                .to_string(),
            DEFER_BACKOFF_IN_FLIGHT,
        );
    };
    if reserved == 0 {
        return PreSettle::Proceed;
    }
    // `balance` is Some here — the arm above returned otherwise.
    let bal = balance.unwrap_or(0);
    // `checked_add`, NOT `saturating_add`. Saturation clamps the requirement to
    // `u64::MAX`, and a balance of `u64::MAX` then SATISFIES it — so an absurd
    // reserve would proceed instead of defer, which is the one direction this
    // gate must never fail in. Found by
    // `implausible_numbers_cannot_wrap_the_gate_into_proceeding` (2026-09-05):
    // an amount that cannot be represented is not an amount to reason about.
    let Some(with_reserve) = need.checked_add(reserved) else {
        return PreSettle::Defer(
            format!(
                "the in-flight reserve for {ticker} is implausibly large ({reserved});                  refusing to compare against it"
            ),
            DEFER_BACKOFF_IN_FLIGHT,
        );
    };
    if bal >= with_reserve {
        return PreSettle::Proceed;
    }
    PreSettle::Defer(
        format!(
            "balance {} {} does not leave {} for the swap(s) in flight after the fee — \
             a fee withdraw must never race a lock funding",
            schedule::format_amount(bal),
            ticker,
            schedule::format_amount(reserved)
        ),
        DEFER_BACKOFF_IN_FLIGHT,
    )
}

/// Atomic units of `ticker` the engine may still need for swaps in progress.
///
/// Sums the coin's own leg across every row of `/json/active`, plus that coin's
/// send cost per swap, and **fails closed**: a reply that is not a list, a row
/// whose amount will not parse, or a ticker with no schedule row all answer
/// `None`, which [`pre_settle_gate`] treats as a refusal to proceed.
///
/// Both legs are matched because the row is in the OFFER's frame and
/// `is_reverse_ads_bid` flips which party locks which side — see the gate's own
/// note on why this is deliberately not direction-aware.
pub fn reserve_for_active_swaps(v: &serde_json::Value, coin: &str, tx_cost: u64) -> Option<u64> {
    let rows = v.as_array()?;
    let mut total: u64 = 0;
    for row in rows {
        let leg = [("coin_from", "amount_from"), ("coin_to", "amount_to")]
            .iter()
            .find_map(|(ck, ak)| {
                let name = row.get(*ck)?.as_str()?;
                if crate::swap_sidecar::bid_coin_matches(name, coin) {
                    row.get(*ak)?.as_str()
                } else {
                    None
                }
            });
        let Some(amount) = leg else { continue };
        let parsed = schedule::parse_amount(amount).ok()?;
        total = total.saturating_add(parsed).saturating_add(tx_cost);
    }
    Some(total)
}

/// What the engine may still need of `ticker`, from its OWN `swaps_in_progress`
/// (`GET /json/active`) — both roles, every pair. See
/// [`reserve_for_active_swaps`].
async fn active_swap_reserve(port: u16, password: &str, ticker: &str) -> Option<u64> {
    let coin = coin_key_from(ticker)?;
    let tx_cost = schedule::row_for(ticker)?.tx_cost;
    let v = api_json(port, password, "active", ApiMethod::Get, None).await.ok()?;
    reserve_for_active_swaps(&v, coin, tx_cost)
}

// =========================================================================
// Engine reads
// =========================================================================

async fn api_json(
    port: u16,
    password: &str,
    path: &str,
    method: ApiMethod,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = build_api_url(port, path, method)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;
    let req = match method {
        ApiMethod::Post => client
            .post(&url)
            .json(&body.unwrap_or_else(|| serde_json::json!({}))),
        ApiMethod::Get => client.get(&url),
    };
    let resp = req
        .header("Authorization", basic_auth_header(password))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {e}"))?;
    decode_api_response(resp).await
}

/// Pull the fields [`engine::decide`] needs out of a bid payload.
///
/// Tolerant on shape, strict on meaning: a bid we cannot read is left
/// `Watching` rather than closed, because "unreadable" is not "nothing owed".
/// **Test-only since `parse_bid_for` landed** (2026-09-05), and kept
/// deliberately: it states the contract the detail endpoint does NOT satisfy —
/// "with no id from anywhere, there is nothing to key a record on" — and three
/// tests assert exactly that. The production path always knows the id, because
/// the sweep opened the record with it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_bid(v: &serde_json::Value) -> Option<SettledBid> {
    parse_bid_for(v, "")
}

/// [`parse_bid`], with the id the CALLER already knows.
///
/// # Why the id cannot be required from the body
///
/// The bid-detail endpoint identifies the bid **by URL** and does not repeat it
/// in the payload: `GET /json/bids/<id>` answers with `bid_state_ind`,
/// `ticker_from`, `ticker_to`, `amt_from`, `amt_to`, `created_at_timestamp` …
/// and **no `bid_id` field at all** (verified against the live node,
/// 2026-09-05). `parse_bid` opened with `v.get("bid_id")…?`, so it returned
/// `None` for every detail payload it was ever handed.
///
/// The consequence was total and silent: `tick`'s step 2 could not resolve a
/// single record, so every one stayed `Watching` forever — including swaps that
/// had completed hours earlier, and including the pre-baseline ones that should
/// have closed as `NoFee` on the first pass. **Nothing had ever been charged,
/// skipped or closed since the module was written**, and the only visible
/// symptom was a fee ledger of `watching` records that a user would have to go
/// looking for. Found by checking, on the operator's own ask, whether a real
/// completed BCH → XMR taker swap had been charged.
///
/// The sweep already knows the id — it opened the record with it — so it is
/// passed in rather than demanded from a payload that has no reason to carry it.
pub fn parse_bid_for(v: &serde_json::Value, known_id: &str) -> Option<SettledBid> {
    let bid_id = v
        .get("bid_id")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("bidId").and_then(|x| x.as_str()))
        .map(|s| s.to_string())
        .or_else(|| {
            let k = known_id.trim();
            (!k.is_empty()).then(|| k.to_string())
        })?;
    let state = v
        .get("bid_state_ind")
        .and_then(|x| x.as_i64())
        .or_else(|| v.get("bid_state_ind").and_then(|x| x.as_str()).and_then(|s| s.parse().ok()))?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(SettledBid {
        bid_id,
        state,
        ticker_from: s("ticker_from"),
        ticker_to: s("ticker_to"),
        amt_from: s("amt_from"),
        amt_to: s("amt_to"),
    })
}

/// The only field the SWEEP needs: an id to open a record against.
///
/// Deliberately **not** [`parse_bid`]. The list payload upstream renders
/// (`js_server.py::formatBids`) carries `bid_state` as a human STRING and has
/// no `bid_state_ind`, no `ticker_from`/`ticker_to` and no `amt_from`/`amt_to`
/// — those exist only on the per-bid detail endpoint (`ui/util.py::describeBid`).
/// Requiring them here dropped **every** row of every sweep, so no record was
/// ever opened and nothing was ever resolved; the state and the amounts are
/// read in step 2, from the endpoint that actually carries them.
///
/// The id is screened with the ledger's own rule so that one malformed row
/// cannot abort a whole pass on a write error.
fn sweep_bid_id(v: &serde_json::Value) -> Option<String> {
    let raw = v
        .get("bid_id")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("bidId").and_then(|x| x.as_str()))?;
    ledger::safe_id(raw).ok()
}

/// When the bid was created, unix seconds, if the payload says so.
///
/// `describeBid` renders `created_at_timestamp` as an integer unconditionally,
/// and `created_at` as an integer only when `for_api` is set — which `js_bids`
/// does, but a future caller might not. Reading the timestamp field first means
/// a non-api rendering degrades to `None` rather than to a wrong number.
fn parse_created_at(v: &serde_json::Value) -> Option<i64> {
    for k in ["created_at_timestamp", "created_at"] {
        if let Some(n) = v.get(k).and_then(|x| x.as_i64()) {
            return Some(n);
        }
    }
    None
}

/// Whether a bid predates this wallet ever having watched for fees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Age {
    /// Created at or after the baseline. Chargeable, if everything else agrees.
    Fresh,
    /// Created before this wallet first watched. **Never charged.**
    Preexisting,
    /// The payload did not say. Not charged, and said out loud.
    Unknown,
}

/// Classify a bid against the baseline.
///
/// The boundary second belongs to the *fresh* side: a bid created in the same
/// second the watcher first started is new. The alternative would drop a swap
/// for a rounding reason, and the boundary is arbitrary either way.
fn classify_age(created_at: Option<i64>, baseline: i64) -> Age {
    match created_at {
        Some(t) if t >= baseline => Age::Fresh,
        Some(_) => Age::Preexisting,
        None => Age::Unknown,
    }
}

/// Read a wallet balance out of `GET /json/wallets/<TICKER>`.
///
/// `None` means **"could not tell"**, which defers rather than sends.
///
/// # A zero is not always a zero (2026-09-05, found live)
///
/// The first version took the first numeric `balance` it found. On a node that
/// had just restarted the fee record read:
///
/// ```text
/// balance 0.00000000 LTC does not cover the fee 0.00249999 plus its 0.00011369 send cost
/// ```
///
/// while the same wallet, asked three minutes later, answered **3.55726607**.
/// Nothing was wrong with the wallet: an electrum-mode `getWalletInfo` returns
/// a placeholder until its cache is populated —
///
/// ```python
/// # interface/btc/btc.py::getWalletInfo, electrum branch
/// db_balance = wm.getCachedTotalBalance(...)   # 0 on a cold start
/// return {"balance": db_balance / COIN if db_balance else 0, …, "syncing": True}
/// ```
///
/// — and it says so, in the same object, with `syncing: True`. Reading the 0
/// and ignoring the flag turns "not known yet" into "you have nothing", which
/// is a fact about the wallet that was never true.
///
/// It deferred either way, so no money moved wrongly. But it burned a retry
/// per pass against a budget that closes the record as `deferredExpired`, and
/// it wrote a reason into the ledger that a reader would act on.
///
/// So every "the answer is not ready" signal the payload can carry now returns
/// `None`: `syncing`, `locked`, a `synced` percentage below 100, an error
/// body, or no `balance` at all. A zero is only believed when the wallet says
/// it is synced and unlocked.
pub fn parse_wallet_balance(v: &serde_json::Value) -> Option<u64> {
    // An engine error object answers with a 200. It is not a wallet.
    if v.get("error").is_some() {
        return None;
    }
    // The electrum placeholder's own flag, and the plain locked case.
    if v.get("syncing").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    if v.get("locked").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    // `synced` is a percentage the node renders as a string ("100.00"). Below
    // 100 the balance is a partial view, and a partial view of a balance reads
    // exactly like a small one.
    if let Some(pct) = v.get("synced").and_then(json_number) {
        if pct < 100.0 {
            return None;
        }
    }
    // Only `balance` — never `unconfirmed`, and never a fallback chain. The
    // old version would happily have answered with `unconfirmed` when
    // `balance` was absent, and the electrum funder skips unconfirmed inputs,
    // so that is money the withdraw cannot actually spend.
    let b = v.get("balance")?;
    if let Some(s) = b.as_str() {
        return schedule::parse_amount(s).ok();
    }
    let f = b.as_f64()?;
    if !f.is_finite() || f < 0.0 {
        return None;
    }
    Some((f * schedule::ATOMIC_PER_COIN as f64).round() as u64)
}

/// A JSON value the node may render as either a number or a numeric string.
fn json_number(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

/// Available balance for a ticker, atomic units, if we can read it.
///
/// Used as the pre-settle check. `None` means "could not tell", which defers
/// rather than sends — the safe direction. See [`parse_wallet_balance`].
async fn available_balance(port: u16, password: &str, ticker: &str) -> Option<u64> {
    let v = api_json(port, password, &format!("wallets/{ticker}"), ApiMethod::Get, None)
        .await
        .ok()?;
    parse_wallet_balance(&v)
}

// =========================================================================
// The watcher
// =========================================================================

/// Start the watcher. Called from app setup; returns immediately.
pub fn spawn(app: &AppHandle) {
    let m = mode();
    if m == Mode::Off {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = match fees_dir(&app) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[sidecar-fees] cannot resolve the fee directory: {e}");
                return;
            }
        };
        match ledger::reconcile_on_start(&dir) {
            Ok(0) => {}
            Ok(n) => eprintln!(
                "[sidecar-fees] {n} interrupted withdraw(s) marked INDETERMINATE — \
                 they will NOT be retried; reconcile them against the wallet"
            ),
            Err(e) => {
                eprintln!("[sidecar-fees] REFUSING to collect: {e}");
                return;
            }
        }
        // The retroactive-charge floor. Established BEFORE the first sweep,
        // because the first sweep is what would otherwise open a record for
        // every swap already in the node's database.
        let baseline = match ledger::read_or_create_baseline(&dir) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[sidecar-fees] REFUSING to collect: {e}");
                return;
            }
        };
        eprintln!(
            "[sidecar-fees] watcher started in {m:?} mode; charging only bids created              at or after unix {baseline}"
        );
        loop {
            let slept = match tick(&app, &dir, m, baseline).await {
                Ok(true) => POLL,
                Ok(false) => IDLE_POLL,
                Err(e) => {
                    eprintln!("[sidecar-fees] tick failed: {e}");
                    IDLE_POLL
                }
            };
            tokio::time::sleep(slept).await;
        }
    });
}

/// One pass. `Ok(false)` means the node was not up — an ordinary state, not an
/// error, and the reason this backs off rather than logging noise.
async fn tick(app: &AppHandle, dir: &PathBuf, m: Mode, baseline: i64) -> Result<bool, String> {
    let state = app.state::<SwapSidecarState>();
    let Ok((port, password)) = api_context(&state) else {
        return Ok(false);
    };

    // 1. Sweep the taker's list, UNFILTERED. Roles and states: see the header.
    //    Only an id is needed here — the list payload carries nothing else the
    //    engine can use, which is exactly why this once opened no records.
    for endpoint in SWEEP_ENDPOINTS {
        let sweep =
            api_json(port, &password, endpoint, ApiMethod::Post, Some(serde_json::json!({})))
                .await?;
        let Some(rows) = sweep.as_array() else {
            // A non-array body is upstream REFUSING, not an empty book: a
            // locked wallet answers `{"error": …, "locked": true}` with a 200.
            // Silence on this path is what let the role bug live undetected —
            // so say it, every pass, rather than treating it as "no swaps".
            eprintln!(
                "[sidecar-fees] {endpoint} did not return a list; swept nothing from it: {sweep}"
            );
            continue;
        };
        for row in rows {
            let Some(id) = sweep_bid_id(row) else { continue };
            if ledger::read(dir, &id)?.is_none() {
                ledger::write(dir, &FeeRecord::watching(&id))?;
            }
        }
    }

    // 2. Resolve every open record individually — the detail endpoint returns
    //    terminal states, so a record in the set can never be lost.
    let (records, bad) = ledger::load_all(dir);
    if !bad.is_empty() {
        return Err(format!("unreadable fee record(s): {}", bad.join("; ")));
    }
    let now_utc = chrono::Utc::now();
    for rec in records.into_iter().filter(|r| r.is_open()) {
        // A deferred record is waiting on the chain, not on us. Re-reading it
        // every pass spent the entire retry budget inside one block interval.
        if let FeeState::Deferred { until, .. } = &rec.state {
            if deferral_pending(until, now_utc) {
                continue;
            }
        }
        let detail =
            match api_json(port, &password, &format!("bids/{}", rec.bid_id), ApiMethod::Get, None)
                .await
            {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[sidecar-fees] cannot read bid {}: {e}", rec.bid_id);
                    continue;
                }
            };
        // Resolve which object actually carries the bid, then read the state,
        // the amounts and the creation time from that SAME object — reading the
        // age from a different level than the amounts is how a record gets aged
        // against a field that was never there.
        let nested = detail.get("bid");
        let src = if parse_bid_for(&detail, &rec.bid_id).is_some() {
            &detail
        } else if let Some(inner) = nested.filter(|b| parse_bid_for(b, &rec.bid_id).is_some()) {
            inner
        } else {
            continue; // unreadable != nothing owed; stay Watching
        };
        let Some(bid) = parse_bid_for(src, &rec.bid_id) else { continue };
        act(app, dir, m, port, &password, &rec, &bid, parse_created_at(src), baseline).await?;
    }
    Ok(true)
}

/// Apply the decision for one bid.
async fn act(
    _app: &AppHandle,
    dir: &PathBuf,
    m: Mode,
    port: u16,
    password: &str,
    rec: &FeeRecord,
    bid: &SettledBid,
    created_at: Option<i64>,
    baseline: i64,
) -> Result<(), String> {
    // 0. AGE, before the decision and long before any money.
    //
    // A swap already in the node's database when this wallet first watched is
    // never charged. Collecting for swaps that settled while the fee was off is
    // the surprise `ledger::FeeState::Observed` refuses to spring, and on a
    // first live start it would bill every XMR pair the user had ever
    // completed. Closing here rather than after `decide` also stops us
    // re-polling the whole history forever.
    //
    // A swap in flight ACROSS the boundary is closed too, so it is never
    // charged. That under-collects exactly once, at first start, which is the
    // correct direction to fail.
    match classify_age(created_at, baseline) {
        Age::Fresh => {}
        Age::Preexisting => {
            let mut r = rec.clone();
            r.state = FeeState::NoFee { reason: "preexisting".into() };
            r.detail = "created before this wallet first watched for fees".into();
            return ledger::write(dir, &r);
        }
        Age::Unknown => {
            // Loud, per bid: if EVERY bid reports this, the detail payload has
            // changed shape and collection has silently stopped. That is the
            // safe direction, but it must not be a quiet one.
            eprintln!(
                "[sidecar-fees] bid {} carries no creation time, so it cannot be shown to                  postdate the baseline — NOT charging it. If every bid says this, the                  bid detail payload has changed shape.",
                rec.bid_id
            );
            let mut r = rec.clone();
            r.state = FeeState::NoFee { reason: "unknownAge".into() };
            r.detail = "no creation time in the payload; cannot prove it is not preexisting".into();
            return ledger::write(dir, &r);
        }
    }

    let decision = engine::decide(bid);

    let (ticker, amount, notional) = match decision {
        // The ONLY state that keeps a record open. `Ended` falls through to
        // the closing arm below, which is the whole point of splitting them.
        Decision::Skip { reason: SkipReason::NotSettled } => return Ok(()),
        Decision::Skip { reason } => {
            let mut r = rec.clone();
            r.state = FeeState::NoFee { reason: skip_label(reason).to_string() };
            return ledger::write(dir, &r);
        }
        Decision::Charge { ticker, amount, notional, .. } => (ticker, amount, notional),
    };

    // DARK: record the decision, open no socket that could move money.
    if m == Mode::Dark {
        let mut r = rec.clone();
        r.state = FeeState::Observed { ticker: ticker.clone(), amount, notional, at: now() };
        r.detail = "dark run — priced, not collected".into();
        eprintln!(
            "[sidecar-fees] DARK: bid {} would be charged {} {} (notional {})",
            rec.bid_id,
            schedule::format_amount(amount),
            ticker,
            schedule::format_amount(notional)
        );
        return ledger::write(dir, &r);
    }

    // LIVE. Balance check first: this is the §1.7 answer without needing to know
    // the swap's direction. Receive-scripted leaves the wallet up ~99.5% of
    // notional so it always passes; send-scripted only passes if the reserve
    // actually held. Deferring never blocks a swap, and never risks one.
    let tries = match rec.state {
        FeeState::Deferred { tries, .. } => tries,
        _ => 0,
    };
    let balance = available_balance(port, password, &ticker).await;
    let in_flight = active_swap_reserve(port, password, &ticker).await;
    if let PreSettle::Defer(why, backoff) = pre_settle_gate(&ticker, amount, balance, in_flight) {
        let mut r = rec.clone();
        if tries + 1 >= MAX_DEFER_TRIES {
            r.state = FeeState::NoFee { reason: "deferredExpired".into() };
            r.detail = format!("gave up after {} attempts; last reason: {why}", tries + 1);
        } else {
            let until = defer_until(backoff);
            r.state = FeeState::Deferred {
                ticker,
                amount,
                until: until.clone(),
                tries: tries + 1,
            };
            r.detail = format!("{why} — next check after {until}");
        }
        return ledger::write(dir, &r);
    }

    // Attempt marker BEFORE the network call. A crash from here on leaves an
    // Attempting record, which startup turns into Indeterminate and never
    // retries — at-most-once, chosen deliberately over at-least-once.
    let mut r = rec.clone();
    r.state = FeeState::Attempting { ticker: ticker.clone(), amount, at: now() };
    ledger::write(dir, &r)?;

    let poster = HttpPoster { port, auth: password.to_string() };
    match settle::settle_with(&poster, &ticker, amount).await {
        Ok(txid) => {
            r.state = FeeState::Paid { ticker, amount, txid: txid.clone(), at: now() };
            r.detail = String::new();
            eprintln!("[sidecar-fees] collected bid {} -> {}", rec.bid_id, txid);
        }
        Err(e) if is_transport_failure(&e) => {
            // The request went out and the REPLY was lost — a timeout, a reset.
            // The engine may well have broadcast. Retrying here is how a fee
            // gets taken twice: the balance re-check that used to stand in as
            // "did it go out" cannot see a 0.0002 BCH withdraw against a
            // 0.55 BCH wallet. At-most-once means this record closes as
            // indeterminate, exactly as a crash mid-withdraw does at startup,
            // and a human reconciles it against the wallet.
            r.state = FeeState::Indeterminate {
                ticker,
                amount,
                note: format!(
                    "the withdraw request was sent but its reply was lost ({e}); outcome \
                     unknown. NOT retried — check the wallet for a matching payment."
                ),
            };
            r.detail = String::new();
            eprintln!(
                "[sidecar-fees] bid {} withdraw reply lost — marked indeterminate, not retried: {e}",
                rec.bid_id
            );
        }
        Err(e) => {
            // The node ANSWERED and said no (an HTTP status, a JSON error, no
            // txid, or a connection refused before anything was sent).
            // Nothing was broadcast, so a later retry is safe.
            let until = defer_until(DEFER_BACKOFF);
            r.state = FeeState::Deferred {
                ticker,
                amount,
                until: until.clone(),
                tries: tries + 1,
            };
            r.detail = format!("withdraw refused: {e} — next check after {until}");
            eprintln!("[sidecar-fees] bid {} withdraw refused: {e}", rec.bid_id);
        }
    }
    ledger::write(dir, &r)
}

// =========================================================================
// Read-only commands. NOTHING here can trigger a settlement.
// =========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeesStatus {
    pub mode: Mode,
    pub open: usize,
    pub observed: usize,
    pub paid: usize,
    pub deferred: usize,
    pub indeterminate: usize,
    /// Records that can never change again — nothing further will be collected
    /// for them. The denominator the UI needs to say "N of M swaps resolved".
    pub closed: usize,
    pub unreadable: usize,
    /// The published schedule, for the disclosure surface.
    pub coins: Vec<FeeCoinInfo>,
    pub rate_bps: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeCoinInfo {
    pub ticker: String,
    pub address: String,
    pub flat_atomic: u64,
    pub flat: String,
    /// The USD price the floor was derived from. Shown on the disclosure
    /// surface so a reader can check the arithmetic without the runtime
    /// needing a price feed in the money path.
    pub price_usd_at_derivation: f64,
}

#[tauri::command]
pub async fn sidecar_fees_status(app: AppHandle) -> Result<FeesStatus, String> {
    let dir = fees_dir(&app)?;
    let (records, bad) = ledger::load_all(&dir);
    let mut s = FeesStatus {
        mode: mode(),
        open: 0,
        observed: 0,
        paid: 0,
        deferred: 0,
        indeterminate: 0,
        closed: 0,
        unreadable: bad.len(),
        coins: schedule::FEE_COINS
            .iter()
            .map(|c| {
                let flat = schedule::flat_fee(c.ticker).unwrap_or(0);
                FeeCoinInfo {
                    ticker: c.ticker.to_string(),
                    address: c.address.to_string(),
                    flat_atomic: flat,
                    flat: schedule::format_amount(flat),
                    price_usd_at_derivation: c.price_usd_at_derivation,
                }
            })
            .collect(),
        rate_bps: schedule::RATE_BPS,
    };
    for r in &records {
        if r.is_settled_forever() {
            s.closed += 1;
        }
        match r.state {
            FeeState::Watching => s.open += 1,
            FeeState::Observed { .. } => s.observed += 1,
            FeeState::Paid { .. } => s.paid += 1,
            FeeState::Deferred { .. } => s.deferred += 1,
            FeeState::Indeterminate { .. } => s.indeterminate += 1,
            _ => {}
        }
    }
    Ok(s)
}

#[tauri::command]
pub async fn sidecar_fees_history(app: AppHandle) -> Result<Vec<FeeRecord>, String> {
    let dir = fees_dir(&app)?;
    let (records, _bad) = ledger::load_all(&dir);
    Ok(records.into_iter().filter(|r| !matches!(r.state, FeeState::Watching)).collect())
}

/// How much the swap form must hold back when the user is **selling** `ticker`,
/// so the fee stays payable after the swap settles.
///
/// Read-only; moves no money. The swap form subtracts this from the balance
/// when computing "max", exactly as a wallet reserves gas. Returns `"0"` for
/// anything that will not be charged, so it fails open.
///
/// Only the SELL direction needs it — buying the scripted coin leaves the user
/// holding an inflow ~200x the fee.
#[tauri::command]
pub async fn sidecar_fees_reserve(ticker: String, balance: String) -> Result<String, String> {
    let atomic = schedule::parse_amount(&balance)?;
    Ok(schedule::format_amount(engine::reserve_for_sale(&ticker, atomic)))
}

/// What a swap of this size WOULD cost. Display only — never moves money.
#[tauri::command]
pub async fn sidecar_fees_quote(ticker: String, amount: String) -> Result<Decision, String> {
    let atomic = schedule::parse_amount(&amount)?;
    Ok(engine::quote(&ticker, atomic))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_off_for_anything_unrecognised() {
        // Exercises the REAL parser. The previous version of this test
        // duplicated the match arms, so it could not have caught an edit to the
        // function it was meant to protect.
        for v in [None, Some(""), Some("on"), Some("true"), Some("off"), Some("LIVE "), Some("darkly")] {
            assert_eq!(mode_from_str(v), Mode::Off, "{v:?} must not enable collection");
        }
        assert_eq!(mode_from_str(Some("dark")), Mode::Dark);
        assert_eq!(mode_from_str(Some("live")), Mode::Live);
        assert_eq!(mode_from_str(Some("  live  ")), Mode::Live, "whitespace is trimmed");
    }

    /// **The go-live tripwire, now pointing the other way** (2026-09-05).
    ///
    /// It read `Off` until the operator turned collection on. Flipping this
    /// constant is still the deliberate act it was — the assertion moves in
    /// the same commit as the constant, never before — but the thing it now
    /// guards is a silent regression to `Off`, i.e. a build that ships the
    /// disclosure, the settings card and the published schedule while
    /// quietly charging nothing.
    #[test]
    fn shipped_mode_is_live_and_moves_only_deliberately() {
        assert_eq!(SHIPPED_MODE, Mode::Live);
    }

    /// The disclosure is not optional decoration: `FEE.md` tells the user the
    /// wallet's settings screen shows every fee it has computed or paid, and
    /// this module's header says a fee the user can read is the only kind
    /// worth charging. Collection being on with no surface rendering it is the
    /// state this asserts against — it was the state on the morning of
    /// 2026-09-05, when the bindings existed and no component used them.
    #[test]
    fn collection_is_on_only_alongside_a_surface_that_shows_it() {
        if SHIPPED_MODE == Mode::Off {
            return;
        }
        // 2026-09-05: the surface MOVED, on the operator's instruction --
        // "remove the swap fee section in the settings ... just make it a
        // percentage or scaler number in the quote or receipt before the user
        // accepts". That is a better disclosure, not a weaker one: it is now
        // in front of every taker on every swap instead of on a settings card
        // nobody opens. So this asserts the QUOTE screen, and it asserts the
        // number is FETCHED -- the card it replaced was not the first wrong
        // thing here. A hardcoded "0.00 (not enabled)" sat in that modal
        // stating no fee was charged while the watcher was charging one.
        let modal =
            std::path::Path::new("../src/features/swap-sidecar/SidecarConfirmModal.tsx");
        let fee_src = std::path::Path::new("../src/features/swap-sidecar/licenceFee.ts");
        for p in [modal, fee_src] {
            assert!(
                p.exists(),
                "SHIPPED_MODE is {SHIPPED_MODE:?} but {} is missing -- the fee surface \
                 FEE.md promises must exist wherever collection is enabled",
                p.display()
            );
        }
        let modal_src = std::fs::read_to_string(modal).expect("read the confirm modal");
        assert!(
            modal_src.contains("useLicenceFee(") && modal_src.contains("licenceFeeLabel("),
            "the quote screen must render the licence fee before the user commits"
        );
        assert!(
            !modal_src.contains("(not enabled)"),
            "the fee line must come from the backend, never from a literal -- a \
             hardcoded not-enabled string is what outlived collection being turned on"
        );
        let fee_mod = std::fs::read_to_string(fee_src).expect("read licenceFee.ts");
        assert!(
            fee_mod.contains("sidecarFeesQuote("),
            "the number shown must be the one engine::decide will charge, not a \
             second implementation of the schedule"
        );
    }

    /// A release build must have no runtime fee switch. Only meaningful under
    /// `cargo test --release`; debug builds honour the env deliberately.
    #[cfg(not(debug_assertions))]
    #[test]
    fn release_builds_ignore_the_environment() {
        std::env::set_var("PWNDA_SIDECAR_FEES", "live");
        assert_eq!(mode(), SHIPPED_MODE, "release must expose no runtime switch");
        std::env::remove_var("PWNDA_SIDECAR_FEES");
    }

    /// THE anti-fork invariant. The watcher must own the settlement path; if a
    /// command could trigger it, patching the TS call site would remove the fee
    /// without a Rust rebuild — and the entire placement argument collapses.
    #[test]
    fn no_command_can_trigger_settlement() {
        let src = include_str!("mod.rs");
        for (i, line) in src.lines().enumerate() {
            if line.trim_start().starts_with("pub async fn sidecar_fees_") {
                let name = line.trim();
                assert!(
                    !name.contains("settle")
                        && !name.contains("collect")
                        && !name.contains("pay")
                        && !name.contains("charge"),
                    "line {}: a command named {name:?} would put the money path behind \
                     a frontend call — the watcher must be self-driving",
                    i + 1
                );
            }
        }
        // And settle_with must be reached only from `act`, never from a command.
        //
        // The needle is SPLIT so this line does not contain the string it looks
        // for. A source-text assertion that spells out its own needle always
        // matches itself, which is how the first two versions of this test
        // failed against correct code.
        let needle = concat!("settle_with", "(&poster");
        let calls: Vec<&str> = src.lines().filter(|l| l.contains(needle)).collect();
        assert_eq!(calls.len(), 1, "settle_with must have exactly one call site: {calls:?}");
    }

    /// One row exactly as upstream's `formatBids` renders it
    /// (`js_server.py`) — all FOURTEEN keys it emits, and none it does not.
    /// Re-read against the pin on 2026-09-02: `bid_id, offer_id, created_at,
    /// expire_at, coin_from, coin_to, amount_from, amount_to, bid_rate,
    /// bid_state, addr_from, addr_to, tx_state_a, tx_state_b`. Note what is
    /// absent and always has been: `bid_state_ind`, `ticker_from`, `amt_from`.
    fn sweep_row() -> serde_json::Value {
        serde_json::json!({
            "bid_id": "0000000000000000000000000000000000000000000000000badc0de",
            "offer_id": "1111111111111111111111111111111111111111111111111111beef",
            "created_at": 1_756_000_000i64,
            "expire_at": 1_756_003_600i64,
            "coin_from": "Litecoin",
            "coin_to": "Monero",
            "amount_from": "10.00000000",
            "amount_to": "1.00000000",
            "bid_rate": "0.10000000",
            "bid_state": "Completed",
            "addr_from": "someaddress",
            "addr_to": "someotheraddress",
            "tx_state_a": "None",
            "tx_state_b": "None"
        })
    }

    /// THE regression this whole path was rewritten for. The list payload
    /// cannot satisfy the engine — it has no `bid_state_ind` and no tickers —
    /// and the sweep must open a record anyway, because step 2 is what reads
    /// those. Requiring them here dropped every row and the watcher recorded
    /// nothing, in any mode, forever.
    #[test]
    fn a_sweep_row_opens_a_record_although_the_engine_cannot_read_it() {
        let row = sweep_row();
        assert!(
            parse_bid(&row).is_none(),
            "a LIST row cannot satisfy the engine — that is precisely why the              sweep must not ask it to"
        );
        assert_eq!(
            sweep_bid_id(&row).as_deref(),
            Some("0000000000000000000000000000000000000000000000000badc0de"),
            "the sweep needs an id and nothing else"
        );
    }

    #[test]
    fn a_row_with_no_usable_id_opens_nothing() {
        for v in [
            serde_json::json!({}),
            serde_json::json!({"bid_id": ""}),
            serde_json::json!({"bid_id": "../escape"}),
            serde_json::json!({"bid_id": 12345}),
            serde_json::json!({"offer_id": "beef"}),
        ] {
            assert_eq!(sweep_bid_id(&v), None, "{v} must open no record");
        }
    }

    /// The taker's list, and the loop that reads it. `bids` is the RECEIVED
    /// half of the book (`listBids(sent=False)` → `was_received = 1`) — the
    /// MAKER's swaps — and makers are free (operator's rule, 2026-09-04). A
    /// taker's own swaps — every swap this wallet's users make — appear only on
    /// `sentbids`.
    #[test]
    fn the_sweep_reads_only_the_takers_list() {
        assert!(
            !SWEEP_ENDPOINTS.contains(&"bids"),
            "makers are free: the received half of the book must not be swept"
        );
        assert!(
            SWEEP_ENDPOINTS.contains(&"sentbids"),
            "WITHOUT sentbids the watcher cannot see a single swap the user made"
        );
        let src = include_str!("mod.rs");
        let needle = concat!("for endpoint in SWEEP", "_ENDPOINTS");
        assert!(src.contains(needle), "the sweep must iterate the constant, not a literal");
    }

    /// A sweep endpoint the supervisor denies would fail every pass with an
    /// error instead of a swap — and `build_api_url` runs this exact check.
    #[test]
    fn both_sweep_endpoints_are_on_the_read_allow_list() {
        for endpoint in SWEEP_ENDPOINTS {
            crate::swap_sidecar::allow_api_path(endpoint, ApiMethod::Post)
                .unwrap_or_else(|e| panic!("{endpoint} must stay readable: {e}"));
        }
    }

    /// The retroactive-charge floor. Without it the first LIVE tick bills every
    /// XMR pair already sitting completed in the node's database.
    #[test]
    fn bids_older_than_the_baseline_are_never_charged() {
        assert_eq!(classify_age(Some(99), 100), Age::Preexisting);
        assert_eq!(classify_age(Some(0), 100), Age::Preexisting);
        assert_eq!(classify_age(Some(100), 100), Age::Fresh, "the boundary second is new");
        assert_eq!(classify_age(Some(101), 100), Age::Fresh);
    }

    /// An unreadable age must not read as a fresh bid. Charging on "we could
    /// not tell how old it is" is the one direction that takes money wrongly.
    #[test]
    fn an_unknown_age_is_not_treated_as_fresh() {
        assert_eq!(classify_age(None, 100), Age::Unknown);
        assert_ne!(classify_age(None, 100), Age::Fresh);
    }

    #[test]
    fn creation_time_is_read_from_either_field() {
        // `describeBid` always emits the _timestamp form as an integer; the
        // bare form is an integer only under for_api.
        let api = serde_json::json!({"created_at": 42, "created_at_timestamp": 42});
        assert_eq!(parse_created_at(&api), Some(42));
        let html = serde_json::json!({"created_at": "2026-09-02 10:00:00", "created_at_timestamp": 42});
        assert_eq!(parse_created_at(&html), Some(42), "the integer field wins");
        let bare = serde_json::json!({"created_at": 7});
        assert_eq!(parse_created_at(&bare), Some(7));
        let none = serde_json::json!({"created_at": "2026-09-02 10:00:00"});
        assert_eq!(parse_created_at(&none), None, "a string date is not a number");
        assert_eq!(parse_created_at(&serde_json::json!({})), None);
        // And the sweep row carries one, so a record opened from the list can
        // still be aged from its detail fetch later.
        assert_eq!(parse_created_at(&sweep_row()), Some(1_756_000_000));
    }

    /// **Invariant 3: the fee never gates a swap.**
    ///
    /// Enforced structurally rather than by review: if no swap-path module can
    /// even *name* this one, no swap can be made conditional on a fee. The
    /// allowed dependents are the module itself and `lib.rs`, which only
    /// registers the read-only commands and spawns the watcher.
    ///
    /// If this fails you are about to make settlement depend on collection,
    /// which is the coordinator shape the project has refused. Route whatever
    /// you need through a read-only command consumed for DISPLAY, or do not do
    /// it.
    #[test]
    fn the_swap_path_does_not_depend_on_the_fee() {
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![src_dir.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    // Our own module is allowed to talk about itself.
                    if p.file_name().and_then(|n| n.to_str()) != Some("sidecar_fees") {
                        stack.push(p);
                    }
                    continue;
                }
                if p.extension().and_then(|x| x.to_str()) != Some("rs") {
                    continue;
                }
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name == "lib.rs" {
                    continue; // registration + spawn only
                }
                if let Ok(text) = std::fs::read_to_string(&p) {
                    if text.contains("sidecar_fees") {
                        offenders.push(p.strip_prefix(&src_dir).unwrap_or(&p).display().to_string());
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "these modules reference sidecar_fees, which risks making a swap conditional              on a fee: {offenders:?}"
        );
    }

    #[test]
    fn parse_bid_reads_the_fields_the_engine_needs() {
        let v = serde_json::json!({
            "bid_id": "00000000deadbeef",
            "bid_state_ind": 8,
            "ticker_from": "LTC",
            "ticker_to": "XMR",
            "amt_from": "10.00000000",
            "amt_to": "1.00000000"
        });
        let b = parse_bid(&v).expect("should parse");
        assert_eq!(b.state, 8);
        assert_eq!(b.ticker_from, "LTC");
        assert_eq!(b.amt_from, "10.00000000");
        assert!(matches!(engine::decide(&b), Decision::Charge { .. }));
    }

    /// The 2026-09-05 incident, pinned to the payload that caused it.
    ///
    /// `GET /json/bids/<id>` identifies the bid by URL and does NOT repeat the
    /// id in the body. Captured verbatim from the live node for the operator's
    /// completed BCH -> XMR taker swap (bid `000000006a9c5eaa...`), which is
    /// the swap that should have been charged and was not: the keys below are
    /// the whole set the sweep needs, and `bid_id` is absent from all of them.
    ///
    /// While `parse_bid` demanded an id from this body, `tick` could not
    /// resolve a single record. Every fee record stayed `Watching` forever and
    /// nothing was ever charged, skipped, or closed.
    #[test]
    fn the_detail_payload_carries_no_id_and_is_still_readable() {
        let detail = serde_json::json!({
            "bid_state_ind": 8,
            "bid_state": "Completed",
            "ticker_from": "XMR",
            "ticker_to": "BCH",
            "amt_from": "0.018620377829",
            "amt_to": "0.03999999",
            "created_at": 1788632746i64,
            "created_at_timestamp": 1788632746i64
        });
        assert!(
            detail.get("bid_id").is_none() && detail.get("bidId").is_none(),
            "the fixture must keep the property that broke it: no id in the body"
        );
        assert!(
            parse_bid(&detail).is_none(),
            "without a known id there is genuinely nothing to key a record on"
        );

        let id = "000000006a9c5eaa907bda4d07e59a09019679527798038c46d93993";
        let bid = parse_bid_for(&detail, id).expect("the sweep knows the id it opened");
        assert_eq!(bid.bid_id, id);
        assert_eq!(bid.state, 8);
        // The taker sent the SCRIPTED leg (BCH) and received the scriptless
        // one, which is exactly the case the fee is defined on.
        assert_eq!(bid.ticker_to, "BCH");
        assert_eq!(bid.amt_to, "0.03999999");
        assert!(
            matches!(engine::decide(&bid), Decision::Charge { .. }),
            "a completed taker swap sending BCH is chargeable: {:?}",
            engine::decide(&bid)
        );
        assert_eq!(parse_created_at(&detail), Some(1788632746));
    }

    /// A body that DOES carry an id keeps it, even when the caller offers one.
    /// The known id is a fallback, not an override -- if the two ever disagree
    /// the payload is the authority on what it describes.
    #[test]
    fn a_body_with_its_own_id_is_not_overridden() {
        let v = serde_json::json!({
            "bid_id": "00000000deadbeef",
            "bid_state_ind": 8,
            "ticker_from": "XMR",
            "ticker_to": "LTC",
            "amt_from": "1.0",
            "amt_to": "10.0"
        });
        assert_eq!(parse_bid_for(&v, "0000ffff").unwrap().bid_id, "00000000deadbeef");
    }

    // ---- the pre-settle gate -------------------------------------------------

    /// The wallet pays the send cost on top (`subfee: false`), so a balance
    /// that covers the fee to the satoshi is a withdraw that fails on funds.
    #[test]
    fn the_balance_must_cover_the_fee_and_its_send_cost() {
        let cost = schedule::row_for("BCH").unwrap().tx_cost;
        assert!(matches!(
            pre_settle_gate("BCH", 19_999, Some(19_999), Some(0)),
            PreSettle::Defer(_, _)
        ));
        assert_eq!(pre_settle_gate("BCH", 19_999, Some(19_999 + cost), Some(0)), PreSettle::Proceed);
        assert!(matches!(pre_settle_gate("BCH", 19_999, None, Some(0)), PreSettle::Defer(_, _)));
    }

    /// Invariant 3, from the other side: the fee never gates a swap, and a
    /// withdraw that outruns a lock funding on the same coin gates it by
    /// accident. An unreadable reserve is a refusal, not a zero.
    ///
    /// **Rewritten 2026-09-05 from a COUNT to a RESERVE.** The count version
    /// deferred whenever any swap mentioned the coin, and the first real case
    /// it met was a false positive: 0.00249999 LTC owed, 0.09992627 LTC in
    /// flight, **3.2 LTC in the wallet**. See `pre_settle_gate`'s own note.
    #[test]
    fn the_fee_waits_only_when_the_swaps_in_flight_actually_need_the_room() {
        let cost = schedule::row_for("LTC").unwrap().tx_cost;
        let fee = 249_999u64;
        let in_flight = 9_992_627u64 + cost; // the live swap's LTC leg
        let plenty = Some(320_000_000u64); // the live 3.2 LTC balance

        // THE CASE THAT WAS WRONG: room for both, so the fee goes now.
        assert_eq!(
            pre_settle_gate("LTC", fee, plenty, Some(in_flight)),
            PreSettle::Proceed,
            "3.2 LTC covers a 0.0025 fee and a 0.1 swap many times over"
        );
        // Nothing in flight is still the simple yes.
        assert_eq!(pre_settle_gate("LTC", fee, plenty, Some(0)), PreSettle::Proceed);

        // THE CASE THE GATE EXISTS FOR: the swap's leg would not survive the
        // fee leaving. One satoshi either side of the line.
        let exact = fee + cost + in_flight;
        assert_eq!(pre_settle_gate("LTC", fee, Some(exact), Some(in_flight)), PreSettle::Proceed);
        match pre_settle_gate("LTC", fee, Some(exact - 1), Some(in_flight)) {
            PreSettle::Defer(why, _) => {
                assert!(why.contains("in flight"), "{why}");
                assert!(why.contains("0.10003996"), "it must name what it is holding: {why}");
            }
            other => panic!("expected Defer, got {other:?}"),
        }

        // Unreadable is a refusal, never a zero — the rule that keeps this
        // safe when the node is least able to answer.
        match pre_settle_gate("LTC", fee, plenty, None) {
            PreSettle::Defer(why, _) => assert!(why.contains("could not be read"), "{why}"),
            other => panic!("expected Defer, got {other:?}"),
        }
    }

    /// The reserve is read off the engine's own `/json/active` rows, and it
    /// fails closed on anything it cannot read.
    #[test]
    fn the_reserve_sums_the_coins_own_leg_and_fails_closed() {
        let cost = schedule::row_for("LTC").unwrap().tx_cost;
        // The live row, verbatim (2026-09-05).
        let live = serde_json::json!([{
            "bid_id": "000000006a9c9d9693ce89ef18912ce6480d0b264233cdffd59bb980",
            "coin_from": "Litecoin", "coin_to": "Monero",
            "amount_from": "0.09992627", "amount_to": "0.009999971468",
            "was_sent": true
        }]);
        assert_eq!(
            reserve_for_active_swaps(&live, "litecoin", cost),
            Some(9_992_627 + cost)
        );
        // The XMR leg of that same row is 12dp and must never be parsed as the
        // reserve for a fee coin — it is not one, so nothing matches.
        assert_eq!(reserve_for_active_swaps(&live, "bitcoincash", cost), Some(0));

        // "Bitcoin Cash" must not match "bitcoin" — the prefix trap that
        // `bid_coin_matches` exists for, reached through a second caller now.
        let bch = serde_json::json!([{
            "coin_from": "Bitcoin Cash", "coin_to": "Monero",
            "amount_from": "0.04000000", "amount_to": "0.018"
        }]);
        assert_eq!(reserve_for_active_swaps(&bch, "bitcoin", cost), Some(0));
        assert_eq!(reserve_for_active_swaps(&bch, "bitcoincash", cost), Some(4_000_000 + cost));

        // Two swaps on the same coin both count.
        let two = serde_json::json!([
            {"coin_from": "Litecoin", "coin_to": "Monero", "amount_from": "1.0", "amount_to": "0.1"},
            {"coin_from": "Monero", "coin_to": "Litecoin", "amount_from": "0.1", "amount_to": "2.0"}
        ]);
        assert_eq!(
            reserve_for_active_swaps(&two, "litecoin", cost),
            Some(100_000_000 + 200_000_000 + 2 * cost)
        );

        // Fails closed: a non-list body (a locked wallet answers `{"error":…}`
        // with a 200) and an unparseable amount are both UNKNOWN, never zero.
        assert_eq!(reserve_for_active_swaps(&serde_json::json!({"error": "x"}), "litecoin", cost), None);
        let bad = serde_json::json!([{"coin_from": "Litecoin", "coin_to": "Monero",
                                      "amount_from": "not a number", "amount_to": "1"}]);
        assert_eq!(reserve_for_active_swaps(&bad, "litecoin", cost), None);
        // An empty book is a real zero.
        assert_eq!(reserve_for_active_swaps(&serde_json::json!([]), "litecoin", cost), Some(0));
    }

    /// **The wait has to outlast the thing it is waiting for** (2026-09-05).
    ///
    /// When the gate DOES hold, it is holding for a swap resolved by a CSV
    /// timelock, not by a block: the live one's chain-A refund was not
    /// publishable for twenty-three hours, and that is the first of two waits.
    /// At one backoff for both reasons the fee closes as `deferredExpired`
    /// long before the coin is free.
    #[test]
    fn the_in_flight_wait_outlasts_a_swaps_own_timelock() {
        let cost = schedule::row_for("LTC").unwrap().tx_cost;
        // A balance that clears the fee itself but NOT the reserve, or this
        // lands in the balance-shortfall arm and measures the wrong backoff.
        let reserve = 9_992_627 + cost;
        let just_short = 249_999 + cost + reserve - 1;
        let in_flight = match pre_settle_gate("LTC", 249_999, Some(just_short), Some(reserve)) {
            PreSettle::Defer(_, b) => b,
            other => panic!("expected Defer, got {other:?}"),
        };
        let balance = match pre_settle_gate("LTC", 249_999, Some(0), Some(0)) {
            PreSettle::Defer(_, b) => b,
            other => panic!("expected Defer, got {other:?}"),
        };
        assert!(
            in_flight > balance,
            "waiting on a SWAP is a longer wait than waiting on a confirmation"
        );
        let horizon = in_flight * MAX_DEFER_TRIES;
        assert!(
            horizon >= Duration::from_secs(40 * 3600),
            "the in-flight budget must outlast a full timelock chain, got {horizon:?}"
        );
        let conf_horizon = balance * MAX_DEFER_TRIES;
        assert!(conf_horizon >= Duration::from_secs(4 * 3600), "{conf_horizon:?}");
    }

    /// `until` is a not-before time now, not a stamp. Inside it the record is
    /// skipped; past it, or unreadable, it is due.
    #[test]
    fn a_deferred_record_is_left_alone_until_its_backoff_passes() {
        let now = chrono::Utc::now();
        let later = (now + chrono::Duration::minutes(4)).to_rfc3339();
        let earlier = (now - chrono::Duration::seconds(1)).to_rfc3339();
        assert!(deferral_pending(&later, now));
        assert!(!deferral_pending(&earlier, now));
        assert!(!deferral_pending("sometime last tuesday", now), "unparseable must be due");
        // The backoff and the try cap together must outlast a slow block, and
        // then some: three hours, not ten minutes.
        let horizon = DEFER_BACKOFF * MAX_DEFER_TRIES;
        assert!(horizon >= Duration::from_secs(2 * 3600), "{horizon:?}");
    }

    /// At-most-once, applied to the reply rather than the crash. The three
    /// error shapes the withdraw door produces are classified by their own
    /// prefixes, so a wording change in `swap_bridge` cannot silently turn a
    /// lost reply back into a retry.
    #[test]
    fn a_lost_reply_is_indeterminate_and_a_refusal_is_retried() {
        use crate::swap_bridge::{NODE_UNREACHABLE_PREFIX, TRANSPORT_FAILURE_PREFIX};
        assert!(is_transport_failure(&format!("{TRANSPORT_FAILURE_PREFIX}: operation timed out")));
        assert!(!is_transport_failure(&format!("{NODE_UNREACHABLE_PREFIX}: connection refused")));
        assert!(!is_transport_failure("swap node HTTP 500: Insufficient funds"));
        assert!(!is_transport_failure("the swap node refused the withdrawal: Insufficient funds"));
        assert!(!is_transport_failure("the swap node returned no txid: {}"));
    }

    #[test]
    fn a_bid_without_a_state_is_not_guessed() {
        let v = serde_json::json!({"bid_id": "abc", "ticker_from": "LTC"});
        assert!(parse_bid(&v).is_none(), "no state means we must not decide");
    }

    // =====================================================================
    // Edge cases that could each cost a fee, silently
    //
    // Every one of these is either a shape the live node has actually
    // returned, or the boundary of a rule money passes through. They exist
    // because three separate faults in this module were only found by reading
    // the LEDGER after a real swap — a green suite over a decision module is
    // worth exactly the inputs it was given.
    // =====================================================================

    /// The live payloads, both of them, from the same wallet three minutes
    /// apart on 2026-09-05. The second is the one that mattered.
    #[test]
    fn a_syncing_wallets_zero_is_not_a_zero_balance() {
        // What the node answered once its electrum cache was populated.
        let ready = serde_json::json!({
            "balance": "3.55726607", "unconfirmed": "0.00000000",
            "immature": "0.00000000", "locked": false, "synced": "100.00",
            "connection_type": "electrum", "name": "Litecoin"
        });
        assert_eq!(parse_wallet_balance(&ready), Some(355_726_607));

        // The placeholder it answers with BEFORE that, which the fee gate read
        // as a real zero and wrote "balance 0.00000000 LTC does not cover the
        // fee" into the ledger.
        let syncing = serde_json::json!({
            "balance": 0, "unconfirmed_balance": 0, "immature_balance": 0,
            "encrypted": true, "locked": false, "locked_utxos": 0, "syncing": true
        });
        assert_eq!(
            parse_wallet_balance(&syncing),
            None,
            "a syncing wallet's zero must read as UNKNOWN, never as a balance"
        );
    }

    /// Every other "the answer is not ready" shape the payload can carry.
    #[test]
    fn an_unreadable_balance_is_never_mistaken_for_an_empty_one() {
        for (label, v) in [
            ("locked wallet", serde_json::json!({"balance": "0.00000000", "locked": true})),
            ("mid-sync percent", serde_json::json!({"balance": "1.0", "synced": "42.13"})),
            ("mid-sync numeric", serde_json::json!({"balance": "1.0", "synced": 42.13})),
            ("engine error body", serde_json::json!({"error": "Wallet must be unlocked"})),
            ("no balance key", serde_json::json!({"locked": false, "synced": "100.00"})),
            ("balance is a word", serde_json::json!({"balance": "lots"})),
            ("balance is negative", serde_json::json!({"balance": -1.0})),
            ("balance is null", serde_json::json!({"balance": serde_json::Value::Null})),
        ] {
            assert_eq!(parse_wallet_balance(&v), None, "{label} must read as unknown");
        }

        // ...and a GENUINE zero, from a synced unlocked wallet, still reads as
        // zero — or the fee would defer for ever on an empty wallet instead of
        // closing as `deferredExpired`.
        let empty = serde_json::json!({"balance": "0.00000000", "locked": false, "synced": "100.00"});
        assert_eq!(parse_wallet_balance(&empty), Some(0));
    }

    /// `unconfirmed` is not spendable by the electrum funder, so it must never
    /// stand in for `balance`. The previous version fell through to it.
    #[test]
    fn unconfirmed_funds_are_not_offered_as_a_balance() {
        let v = serde_json::json!({
            "unconfirmed": "5.00000000", "locked": false, "synced": "100.00"
        });
        assert_eq!(
            parse_wallet_balance(&v),
            None,
            "no `balance` key means unknown — an unconfirmed inflow cannot fund a withdraw"
        );
    }

    /// A fee coin is 8dp. Anything finer is a payload we do not understand,
    /// and rounding it would charge an amount nobody computed.
    #[test]
    fn a_balance_finer_than_the_coin_is_refused_rather_than_rounded() {
        let xmr_shaped = serde_json::json!({
            "balance": "1.234567891234", "locked": false, "synced": "100.00"
        });
        assert_eq!(parse_wallet_balance(&xmr_shaped), None);
        // The exact boundary is fine.
        let ok = serde_json::json!({"balance": "1.23456789", "locked": false, "synced": "100.00"});
        assert_eq!(parse_wallet_balance(&ok), Some(123_456_789));
    }

    /// The engine renders amounts as strings, but a future build could send a
    /// JSON number. Both must land on the same integer — a float path that
    /// truncated would under-charge by up to a satoshi every time.
    #[test]
    fn a_numeric_balance_and_a_string_balance_agree() {
        let base = |b: serde_json::Value| serde_json::json!({
            "balance": b, "locked": false, "synced": "100.00"
        });
        assert_eq!(parse_wallet_balance(&base(serde_json::json!("3.55726607"))), Some(355_726_607));
        assert_eq!(parse_wallet_balance(&base(serde_json::json!(3.55726607))), Some(355_726_607));
        // 0.1 + 0.2 territory: the float path must round, not truncate.
        assert_eq!(parse_wallet_balance(&base(serde_json::json!(0.3))), Some(30_000_000));
    }

    /// The two halves of the gate must not disagree about what "enough" means.
    /// A balance that exactly covers fee + cost + reserve proceeds; one
    /// satoshi less defers. Run across every fee coin, because each has its
    /// own `tx_cost` and an off-by-one here is a fee that never sends.
    #[test]
    fn the_gate_is_exact_at_its_boundary_for_every_fee_coin() {
        for c in schedule::FEE_COINS {
            let cost = c.tx_cost;
            let fee = schedule::flat_fee(c.ticker).unwrap();
            for reserve in [0u64, 1, 100_000_000] {
                let need = fee + cost + reserve;
                assert_eq!(
                    pre_settle_gate(c.ticker, fee, Some(need), Some(reserve)),
                    PreSettle::Proceed,
                    "{} exact at {need}",
                    c.ticker
                );
                assert!(
                    matches!(
                        pre_settle_gate(c.ticker, fee, Some(need - 1), Some(reserve)),
                        PreSettle::Defer(_, _)
                    ),
                    "{} one satoshi short must defer",
                    c.ticker
                );
            }
        }
    }

    /// Arithmetic that must not wrap. A hostile or broken payload could carry
    /// an enormous reserve; saturating is the difference between "defer" and
    /// "proceed on an overflowed comparison".
    #[test]
    fn implausible_numbers_cannot_wrap_the_gate_into_proceeding() {
        let huge = u64::MAX;
        assert!(matches!(
            pre_settle_gate("LTC", huge, Some(1), Some(huge)),
            PreSettle::Defer(_, _)
        ));
        assert!(matches!(
            pre_settle_gate("LTC", 249_999, Some(u64::MAX), Some(huge)),
            PreSettle::Defer(_, _)
        ));
        // A reserve big enough to overflow `need` still defers rather than
        // wrapping past the balance check.
        assert!(matches!(
            pre_settle_gate("BCH", 546, Some(u64::MAX - 1), Some(u64::MAX - 1)),
            PreSettle::Defer(_, _)
        ));
    }

    /// A coin with no schedule row must fail OPEN on the reserve read — it is
    /// not chargeable, so there is nothing to reserve for and nothing to get
    /// wrong. `decide` refuses it long before this point.
    #[test]
    fn a_coin_with_no_schedule_row_has_no_reserve_to_compute() {
        assert!(schedule::row_for("DOGE").is_none());
        // The gate still behaves: no row means no tx_cost, so the need is the
        // fee alone, and it never reaches `settle` because `decide` skipped it.
        assert_eq!(pre_settle_gate("DOGE", 100, Some(100), Some(0)), PreSettle::Proceed);
    }

    /// The sweep must be unfiltered. Passing `with_available_or_active` would
    /// reintroduce the missed-settlement window that filter creates.
    #[test]
    fn the_sweep_is_unfiltered() {
        let src = include_str!("mod.rs");
        // The needle is SPLIT so this line does not contain what it looks for
        // — the sweep call and this assertion would otherwise both match, and
        // `find` returning the wrong one is not something the test could tell.
        let needle = concat!("endpoint, ApiMethod", "::Post");
        let sweep_line =
            src.lines().find(|l| l.contains(needle)).expect("sweep call not found");
        assert!(
            sweep_line.contains("json!({})"),
            "the sweep must pass NO filter, got: {sweep_line}"
        );
        // Check CODE only. The module docstring names the filter to explain why
        // it is not used, so a naive whole-file scan flags its own rationale.
        let code_only: String = src
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("///") && !t.starts_with("//!")
            })
            .collect::<Vec<_>>()
            .join("
");
        // Split for the same reason as above — spelled out, this assertion is
        // itself a line of code containing the forbidden string.
        let forbidden = concat!("with_available", "_or_active");
        assert!(
            !code_only.contains(forbidden),
            "this module must never PASS the active-only bid filter"
        );
    }
}
