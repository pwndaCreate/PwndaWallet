//! The fee decision: a settled bid in, `Charge` or `Skip` out.
//!
//! Pure — no I/O, no clock, no network, no `AppHandle`. Everything that decides
//! whether money moves lives here so it can be exhaustively tested without a
//! node. [`super::settle`] is the only module that acts on the result.

use super::schedule::{
    self, fee_address_for, fee_leg, flat_fee, norm, parse_amount, row_for, MAX_EFFECTIVE_RATE_PCT,
    RATE_BPS,
};

/// Upstream's `BidStates.SWAP_COMPLETED`. **The only chargeable state.**
///
/// Mirrored deliberately as a bare integer rather than derived: it is a wire
/// value, and the sync check (`check-basicswap-upstream.mjs` probe 9) already
/// watches upstream's numbering for drift.
pub const SWAP_COMPLETED: i64 = 8;

/// States a bid can be in that it will never leave, and that are not a settled
/// swap.
///
/// # Why the watcher needs this
///
/// `decide` answers `Skip{NotSettled}` for everything that is not state 8, and
/// `act` treats that as "keep watching" — correct for a swap still in flight,
/// and wrong forever for one that ended. On 2026-09-05 the operator's
/// XMR → LTC bid closed as `BID_EXPIRED` (31) and its fee record stayed
/// `Watching`, re-fetching `/json/bids/<id>` every 15 seconds for a bid that
/// can never change again. One record is a rounding error; a year of them is
/// an unbounded ledger and an unbounded poll.
///
/// # Where the list comes from, and the mistake in the first version
///
/// The first version was derived from upstream's `inactive_states`, which
/// looks like the answer and is not: it is the list the bid QUERY treats as
/// inactive, and it **omits `XMR_SWAP_FAILED_REFUNDED` (17) and
/// `XMR_SWAP_FAILED_SWIPED` (18)** — the two ordinary endings of a swap whose
/// counterparty walks away after both legs are locked. So the same bug
/// survived for exactly the outcomes the operator's stalled swap was heading
/// toward, on the same day it was "fixed".
///
/// The authority is `checkXmrBidState`'s own
/// `rv = True  # Remove from swaps_in_progress` set: those are the states at
/// which the ENGINE stops working on a bid. This list is that set, minus
/// [`SWAP_COMPLETED`], plus the query-side states a bid can reach without ever
/// entering a swap at all (rejected, expired, abandoned, timed out).
/// `the_terminal_list_matches_upstreams_own_removal_set` reads upstream's
/// source and fails when it drifts.
///
/// 37 and 39 are deliberately absent: `SWIPED_USING_MERCY` and
/// `SWIPED_SENDING_MERCY` are transitional, and a bid in them is still moving.
pub const TERMINAL_UNSETTLED: &[i64] = &[
    17, // XMR_SWAP_FAILED_REFUNDED  — the counterparty took their refund
    18, // XMR_SWAP_FAILED_SWIPED    — we took theirs after the second timelock
    19, // XMR_SWAP_FAILED
    21, // SWAP_TIMEDOUT
    22, // BID_ABANDONED
    23, // BID_ERROR
    25, // BID_REJECTED
    31, // BID_EXPIRED
    36, // XMR_SWAP_FAILED_SWIPED_USED_MERCY
    38, // XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED
];

/// Will this bid never reach [`SWAP_COMPLETED`]?
///
/// `false` for anything still moving — including states this build does not
/// recognise, because an unknown state is not evidence of an ending.
pub fn is_terminal_unsettled(state: i64) -> bool {
    TERMINAL_UNSETTLED.contains(&state)
}

/// What we need off `GET /json/bids/<id>` to decide. Nothing else.
#[derive(Debug, Clone)]
pub struct SettledBid {
    pub bid_id: String,
    /// `bid_state_ind` — the integer form.
    pub state: i64,
    pub ticker_from: String,
    pub ticker_to: String,
    /// Decimal strings, as the engine renders them.
    pub amt_from: String,
    pub amt_to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Decision {
    Charge {
        ticker: String,
        /// Atomic units.
        amount: u64,
        address: String,
        /// Atomic units of the scripted leg the rate was applied to.
        notional: u64,
    },
    Skip {
        reason: SkipReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// Not `SWAP_COMPLETED`, and still moving. The caller keeps watching.
    NotSettled,
    /// Not `SWAP_COMPLETED`, and it never will be — a failure, refund, abort,
    /// expiry, rejection, swipe or mercy outcome. The money was never taken,
    /// so there is nothing to charge, and nothing left to wait for either.
    Ended,
    /// Scripted↔scripted. Free by policy, not by oversight.
    NoScriptlessLeg,
    /// The scripted leg has no schedule row. Fails OPEN.
    NoFeeAddress,
    /// The bid did not carry a usable amount for the scripted leg.
    UnreadableAmount,
    /// Below the switchover AND the flat would exceed `MAX_EFFECTIVE_RATE`.
    /// Dormant while XMR is the only scriptless leg — see the schedule.
    Guard,
    /// Rate applied to the notional rounds to nothing and the flat does not
    /// apply. Cannot happen with the current schedule; kept explicit so a
    /// future zero-flat coin cannot silently charge 0.
    Dust,
}

/// Decide. The entire policy, as ONE branch — never a per-coin A/B table.
pub fn decide(bid: &SettledBid) -> Decision {
    // 1. State. The narrow rule, and the reason the fee is immune to the four
    //    SWIPED_*_MERCY states v0.18.5 added: they are simply not this number.
    //
    //    Two ways to not be settled, and the caller does different things with
    //    them: `NotSettled` keeps the record open, `Ended` closes it. Before
    //    2026-09-05 both were `NotSettled`, so an expired bid was polled for
    //    ever (see `TERMINAL_UNSETTLED`).
    if bid.state != SWAP_COMPLETED {
        return Decision::Skip {
            reason: if is_terminal_unsettled(bid.state) {
                SkipReason::Ended
            } else {
                SkipReason::NotSettled
            },
        };
    }

    // 2. Eligibility + denomination, by TICKER. See `schedule::fee_leg`.
    let Some(leg) = fee_leg(&bid.ticker_from, &bid.ticker_to) else {
        return Decision::Skip { reason: SkipReason::NoScriptlessLeg };
    };

    let Some(address) = fee_address_for(&leg.scripted) else {
        return Decision::Skip { reason: SkipReason::NoFeeAddress };
    };
    let Some(flat) = flat_fee(&leg.scripted) else {
        return Decision::Skip { reason: SkipReason::NoFeeAddress };
    };

    // 3. Notional = the amount belonging to the SCRIPTED ticker, selected by
    //    matching the ticker, never by taking `amt_from` positionally.
    let notional_str = if norm(&bid.ticker_from) == leg.scripted {
        &bid.amt_from
    } else {
        &bid.amt_to
    };
    let Ok(notional) = parse_amount(notional_str) else {
        return Decision::Skip { reason: SkipReason::UnreadableAmount };
    };
    if notional == 0 {
        return Decision::Skip { reason: SkipReason::UnreadableAmount };
    }

    // 4. Structure B with the guard. Integer maths throughout.
    let pct = notional.saturating_mul(RATE_BPS) / 10_000;
    let amount = if pct < flat {
        // Would the flat exceed MAX_EFFECTIVE_RATE of the trade?
        //   flat / notional > pct_limit/100   <=>   flat*100 > notional*pct_limit
        if (flat as u128) * 100 > (notional as u128) * (MAX_EFFECTIVE_RATE_PCT as u128) {
            return Decision::Skip { reason: SkipReason::Guard };
        }
        flat
    } else {
        pct
    };

    if amount == 0 {
        return Decision::Skip { reason: SkipReason::Dust };
    }

    Decision::Charge {
        ticker: leg.scripted,
        amount,
        address: address.to_string(),
        notional,
    }
}

/// Convenience for the display layer: what a swap of this size WOULD cost.
/// Never used to move money — [`decide`] is the only authority for that.
pub fn quote(scripted_ticker: &str, notional_atomic: u64) -> Decision {
    decide(&SettledBid {
        bid_id: String::new(),
        state: SWAP_COMPLETED,
        ticker_from: scripted_ticker.to_string(),
        ticker_to: schedule::SCRIPTLESS_TICKERS[0].to_string(),
        amt_from: schedule::format_amount(notional_atomic),
        amt_to: "1".to_string(),
    })
}

/// How much of a balance must be held back so the fee is still payable AFTER a
/// swap that **sells** the scripted coin.
///
/// Only that direction needs it. Selling the scripted leg spends the very coin
/// the fee is denominated in, so a user who swaps their whole balance leaves
/// nothing to pay from — the collector then defers and eventually gives up, and
/// the fee is silently never collected. The receive direction needs no reserve:
/// the inflow is ~200x the fee, so the wallet ends up net up.
///
/// Deliberately slightly conservative — it prices the fee against the WHOLE
/// balance rather than solving for the largest self-consistent swap. Over-
/// reserving by a fraction of a percent is invisible to the user; under-
/// reserving strands the fee, which is the failure this exists to prevent.
///
/// Returns atomic units of `scripted_ticker`. `0` means nothing to hold back,
/// and every not-a-fee-coin path returns `0` so this **fails open** exactly
/// like [`decide`].
pub fn reserve_for_sale(scripted_ticker: &str, balance_atomic: u64) -> u64 {
    let Some(row) = row_for(scripted_ticker) else {
        return 0; // not a fee coin
    };
    if fee_address_for(scripted_ticker).is_none() {
        return 0; // no address configured — decide() would skip, so reserve nothing
    }
    let Some(flat) = flat_fee(scripted_ticker) else {
        return 0;
    };

    // Mirrors decide()'s structure-B branch, including the guard, so the
    // reserve can never disagree with what will actually be charged.
    let pct = balance_atomic.saturating_mul(RATE_BPS) / 10_000;
    let fee = if pct < flat {
        if (flat as u128) * 100 > (balance_atomic as u128) * (MAX_EFFECTIVE_RATE_PCT as u128) {
            return 0; // guard would skip the charge; nothing to reserve
        }
        flat
    } else {
        pct
    };

    // Plus the cost of actually sending the collection transaction.
    fee.saturating_add(row.tx_cost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar_fees::schedule::{format_amount, ATOMIC_PER_COIN};

    /// A bid that ENDED must be told apart from one still moving, or its fee
    /// record is polled for ever. The operator's 2026-09-05 XMR -> LTC bid
    /// closed as BID_EXPIRED (31) and its record sat `Watching`, re-reading a
    /// bid that can never change again.
    #[test]
    fn an_ended_bid_is_not_confused_with_one_still_in_flight() {
        // Every state upstream lists as inactive, minus the settled one.
        for state in TERMINAL_UNSETTLED {
            assert!(is_terminal_unsettled(*state), "{state}");
            let b = bid(*state, "XMR", "1.0", "LTC", "10.0");
            assert_eq!(
                engine_decide_reason(&b),
                Some(SkipReason::Ended),
                "state {state} will never settle, so the record must close"
            );
        }
        // Still moving: the record stays open.
        for state in [0i64, 1, 5, 11, 20 /* SWAP_DELAYING */] {
            assert!(!is_terminal_unsettled(state), "{state}");
            assert_eq!(
                engine_decide_reason(&bid(state, "XMR", "1.0", "LTC", "10.0")),
                Some(SkipReason::NotSettled),
                "state {state} may still complete"
            );
        }
        // A state this build has never heard of is NOT evidence of an ending.
        assert!(!is_terminal_unsettled(9_999));
        // And the settled one is still the only chargeable one.
        assert!(!is_terminal_unsettled(SWAP_COMPLETED));
        assert!(matches!(
            decide(&bid(SWAP_COMPLETED, "XMR", "1.0", "LTC", "10.0")),
            Decision::Charge { .. }
        ));
    }

    /// **Read upstream's own source rather than trusting a copied list.**
    ///
    /// `TERMINAL_UNSETTLED` was first derived from `inactive_states`, which is
    /// the bid QUERY's idea of inactive and omits the two states a stalled
    /// swap actually ends in. This check goes to the authority instead: the
    /// `rv = True  # Remove from swaps_in_progress` set in `checkXmrBidState`,
    /// which is where the engine stops working on a bid.
    ///
    /// It fails — rather than skipping — when the vendored source is missing,
    /// because a check that silently does nothing is how the first version
    /// stayed green.
    #[test]
    fn the_terminal_list_matches_upstreams_own_removal_set() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../upstream/basicswap/basicswap/basicswap.py");
        let src = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("cannot read the vendored engine at {}: {e}", path.display())
        });

        // Every `elif state == BidStates.X:` (or `if`) immediately followed by
        // a removal from swaps_in_progress.
        let lines: Vec<&str> = src.lines().collect();
        let mut removed: Vec<String> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if !line.contains("rv = True  # Remove from swaps_in_progress") {
                continue;
            }
            // Walk back to the nearest `state == BidStates.NAME` guard.
            for back in 1..=4 {
                let Some(prev) = i.checked_sub(back).map(|j| lines[j]) else { break };
                if let Some(rest) = prev.split("state == BidStates.").nth(1) {
                    let name: String =
                        rest.chars().take_while(|c| c.is_ascii_uppercase() || *c == '_').collect();
                    if !name.is_empty() {
                        removed.push(name);
                        break;
                    }
                }
            }
        }
        assert!(
            removed.len() >= 5,
            "found only {removed:?} — the removal set moved and this check went blind"
        );

        // Map upstream's names to their numbers, from the enum itself.
        let util = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../upstream/basicswap/basicswap/basicswap_util.py"),
        )
        .expect("read basicswap_util.py");
        let id_of = |name: &str| -> i64 {
            let needle = format!("    {name} = ");
            let line = util
                .lines()
                .find(|l| l.starts_with(&needle))
                .unwrap_or_else(|| panic!("{name} not found in BidStates"));
            line.split('=')
                .nth(1)
                .and_then(|v| v.split('#').next())
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or_else(|| panic!("cannot parse {name}"))
        };

        for name in &removed {
            let id = id_of(name);
            if id == SWAP_COMPLETED {
                continue; // the one that IS settled
            }
            assert!(
                is_terminal_unsettled(id),
                "upstream stops working on {name} ({id}) but the fee watcher would keep \
                 polling it for ever — add it to TERMINAL_UNSETTLED"
            );
        }
        // Positive control: the two the first version missed are in the set
        // this test reads, so it would have caught them.
        assert!(removed.iter().any(|n| n == "XMR_SWAP_FAILED_REFUNDED"), "{removed:?}");
        assert!(removed.iter().any(|n| n == "XMR_SWAP_FAILED_SWIPED"), "{removed:?}");
    }

    /// The two endings the operator's stalled swap can reach. Neither is a
    /// settled swap, so neither is charged — and both must CLOSE the record.
    #[test]
    fn a_swap_that_ends_in_refund_or_swipe_closes_without_a_fee() {
        for (state, what) in [(17, "XMR_SWAP_FAILED_REFUNDED"), (18, "XMR_SWAP_FAILED_SWIPED")] {
            let b = bid(state, "XMR", "0.009999971468", "LTC", "0.09992627");
            assert_eq!(
                engine_decide_reason(&b),
                Some(SkipReason::Ended),
                "{what} must close the record, not keep it watching"
            );
        }
        // ...and the transitional mercy states are NOT terminal — a bid in
        // them is still moving and must stay open.
        for state in [37, 39] {
            assert_eq!(
                engine_decide_reason(&bid(state, "XMR", "1.0", "LTC", "10.0")),
                Some(SkipReason::NotSettled),
                "state {state} is transitional"
            );
        }
    }

    fn engine_decide_reason(b: &SettledBid) -> Option<SkipReason> {
        match decide(b) {
            Decision::Skip { reason } => Some(reason),
            _ => None,
        }
    }

    fn bid(state: i64, tf: &str, af: &str, tt: &str, at: &str) -> SettledBid {
        SettledBid {
            bid_id: "b".into(),
            state,
            ticker_from: tf.into(),
            ticker_to: tt.into(),
            amt_from: af.into(),
            amt_to: at.into(),
        }
    }

    // ---- reserve_for_sale ----

    /// The reserve must cover what will actually be charged, or the fee it is
    /// protecting is stranded anyway.
    #[test]
    fn reserve_covers_the_fee_that_would_be_charged() {
        // 1 LTC balance: percentage branch (0.5% = 500_000 > flat 22_738).
        let bal = ATOMIC_PER_COIN;
        let r = reserve_for_sale("LTC", bal);
        let charged_on_max = match quote("LTC", bal - r) {
            Decision::Charge { amount, .. } => amount,
            other => panic!("expected a charge, got {other:?}"),
        };
        assert!(
            r >= charged_on_max,
            "reserve {r} must cover the {charged_on_max} that would be charged"
        );
    }

    #[test]
    fn reserve_includes_the_cost_of_sending_it() {
        // Exactly fee + tx_cost, never just the fee: a reserve that cannot pay
        // for its own transaction does not solve the problem.
        let bal = ATOMIC_PER_COIN;
        let pct = bal * RATE_BPS / 10_000;
        assert_eq!(reserve_for_sale("LTC", bal), pct + 11_369);
    }

    #[test]
    fn reserve_fails_open_for_anything_not_a_fee_coin() {
        for t in ["XMR", "DOGE", "DASH", "ZEPH", "", "nonsense"] {
            assert_eq!(reserve_for_sale(t, ATOMIC_PER_COIN), 0, "{t} must reserve nothing");
        }
    }

    /// Where the guard would skip the charge, there is nothing to reserve —
    /// otherwise we would hold back money for a fee that never arrives.
    #[test]
    fn reserve_is_zero_where_the_guard_would_skip() {
        // Below 2x flat the guard fires, so no charge and no reserve.
        let flat = flat_fee("LTC").unwrap();
        assert_eq!(reserve_for_sale("LTC", flat), 0);
        assert!(matches!(quote("LTC", flat), Decision::Skip { .. }));
    }

    #[test]
    fn reserve_agrees_with_decide_across_the_structure_b_boundary() {
        let flat = flat_fee("LTC").unwrap();
        // Just above the guard: flat branch, so reserve is flat + tx_cost.
        let bal = flat * 2;
        assert_eq!(reserve_for_sale("LTC", bal), flat + 11_369);
        // Far above the switchover: percentage branch.
        let big = ATOMIC_PER_COIN * 10;
        assert_eq!(reserve_for_sale("LTC", big), big * RATE_BPS / 10_000 + 11_369);
    }

    fn charged(d: &Decision) -> Option<(&str, u64)> {
        match d {
            Decision::Charge { ticker, amount, .. } => Some((ticker, *amount)),
            _ => None,
        }
    }

    /// §1.1 — the narrowest and most important rule. Every state that is not
    /// SWAP_COMPLETED must skip, including the ones the handoff wrongly listed
    /// as chargeable (13/15, the redeemed states) and the four v0.18.5 mercy
    /// states (36-39). Charging on 13/15 would bill mid-flight AND up to three
    /// times per swap.
    #[test]
    fn only_swap_completed_is_chargeable() {
        for state in 0..=40i64 {
            let d = decide(&bid(state, "LTC", "1", "XMR", "0.1"));
            if state == SWAP_COMPLETED {
                assert!(charged(&d).is_some(), "state {state} must charge");
            } else {
                // What this test guards is CHARGE vs SKIP. Which flavour of
                // skip is a different question (`NotSettled` keeps the record
                // open, `Ended` closes it) and is pinned by
                // `an_ended_bid_is_not_confused_with_one_still_in_flight` —
                // asserting it here too made this test fail for a reason it
                // was not run for when the two were split.
                assert!(charged(&d).is_none(), "state {state} must NOT charge: {d:?}");
            }
        }
    }

    /// The redeemed states and the mercy states called out by name, so a future
    /// reader sees the intent rather than inferring it from a range.
    #[test]
    fn the_states_the_handoff_got_wrong_are_refused_by_name() {
        for (state, what) in [
            (13, "XMR_SWAP_SCRIPT_TX_REDEEMED"),
            (15, "XMR_SWAP_NOSCRIPT_TX_REDEEMED"),
            (36, "XMR_SWAP_FAILED_SWIPED_USED_MERCY"),
            (37, "XMR_SWAP_FAILED_SWIPED_USING_MERCY"),
            (38, "XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED"),
            (39, "XMR_SWAP_FAILED_SWIPED_SENDING_MERCY"),
        ] {
            let d = decide(&bid(state, "LTC", "10", "XMR", "1"));
            assert!(charged(&d).is_none(), "{what} ({state}) must not be charged: {d:?}");
        }
    }

    /// §1.13 — the ~9× bug. The notional must come from the SCRIPTED leg
    /// whichever position it sits in.
    #[test]
    fn notional_is_the_scripted_leg_in_both_directions() {
        // 10 LTC <-> 1 XMR, stated both ways round.
        let fwd = decide(&bid(SWAP_COMPLETED, "LTC", "10", "XMR", "1"));
        let rev = decide(&bid(SWAP_COMPLETED, "XMR", "1", "LTC", "10"));
        assert_eq!(charged(&fwd), charged(&rev), "direction must not change the fee");
        let (ticker, amount) = charged(&fwd).unwrap();
        assert_eq!(ticker, "LTC");
        // 0.5% of 10 LTC = 0.05 LTC
        assert_eq!(amount, 5 * ATOMIC_PER_COIN / 100);
        // and emphatically NOT 0.5% of the 1 XMR leg
        assert_ne!(amount, ATOMIC_PER_COIN / 200);
    }

    #[test]
    fn scripted_to_scripted_is_free() {
        let d = decide(&bid(SWAP_COMPLETED, "LTC", "10", "BTC", "1"));
        assert_eq!(d, Decision::Skip { reason: SkipReason::NoScriptlessLeg });
    }

    /// Fails OPEN: a coin with no schedule row is never charged, never blocked.
    #[test]
    fn a_coin_with_no_row_is_skipped_not_guessed() {
        let d = decide(&bid(SWAP_COMPLETED, "DOGE", "1000", "XMR", "1"));
        assert_eq!(d, Decision::Skip { reason: SkipReason::NoFeeAddress });
    }

    /// Structure B: flat below the switchover, percentage above, and they meet.
    #[test]
    fn structure_b_switches_over_where_the_spec_says() {
        let flat = flat_fee("LTC").unwrap(); // 22_738
        let switchover = flat * 10_000 / RATE_BPS; // flat / 0.005

        // just below the switchover -> the flat
        let below = decide(&bid(
            SWAP_COMPLETED,
            "LTC",
            &format_amount(switchover / 2),
            "XMR",
            "1",
        ));
        assert_eq!(charged(&below).unwrap().1, flat);

        // exactly at the switchover -> both structures agree
        let at = decide(&bid(SWAP_COMPLETED, "LTC", &format_amount(switchover), "XMR", "1"));
        assert_eq!(charged(&at).unwrap().1, flat);

        // well above -> pure percentage
        let above_notional = switchover * 10;
        let above =
            decide(&bid(SWAP_COMPLETED, "LTC", &format_amount(above_notional), "XMR", "1"));
        assert_eq!(charged(&above).unwrap().1, above_notional * RATE_BPS / 10_000);
    }

    /// BCH is pure percentage in practice: its switchover ($0.22) sits below the
    /// smallest legal XMR-pair swap (~$0.39), so the flat never engages on a
    /// real trade. Asserted so that if the flat ever DOES engage, someone looks.
    #[test]
    fn bch_switchover_is_below_the_protocol_minimum() {
        let c = crate::sidecar_fees::schedule::row_for("BCH").unwrap();
        let flat = flat_fee("BCH").unwrap();
        let switchover_usd =
            (flat as f64 / ATOMIC_PER_COIN as f64) * c.price_usd_at_derivation * 10_000.0
                / RATE_BPS as f64;
        assert!(
            switchover_usd < 0.39,
            "BCH switchover ${switchover_usd:.4} should sit below the ~$0.39 XMR floor"
        );
    }

    /// The guard, exercised against a SYNTHETIC pair, because it cannot fire on
    /// a real one today. Shipping a test that passes vacuously would be worse
    /// than admitting the branch is dormant.
    #[test]
    fn the_dormant_guard_refuses_an_abusive_flat() {
        let flat = flat_fee("LTC").unwrap();
        // A notional where the flat is MORE than 50% of the trade.
        let tiny = flat; // flat/notional == 100% > 50%
        let d = decide(&bid(SWAP_COMPLETED, "LTC", &format_amount(tiny), "XMR", "1"));
        assert_eq!(d, Decision::Skip { reason: SkipReason::Guard });

        // Just above the guard boundary (2*flat) the flat is exactly 50% and is charged.
        let boundary = flat * 2;
        let d2 = decide(&bid(SWAP_COMPLETED, "LTC", &format_amount(boundary), "XMR", "1"));
        assert_eq!(charged(&d2).unwrap().1, flat);
    }

    #[test]
    fn unreadable_or_zero_amounts_skip_rather_than_charge_zero() {
        for amt in ["", "abc", "0", "-1", "1.234567891"] {
            let d = decide(&bid(SWAP_COMPLETED, "LTC", amt, "XMR", "1"));
            assert_eq!(
                d,
                Decision::Skip { reason: SkipReason::UnreadableAmount },
                "amount {amt:?} must skip"
            );
        }
    }

    /// A charge must never exceed the notional it was computed from — the
    /// crudest possible sanity bound on the money path.
    #[test]
    fn a_charge_never_exceeds_its_notional() {
        for n in [1u64, 546, 22_738, 100_000, ATOMIC_PER_COIN, 1_000 * ATOMIC_PER_COIN] {
            for t in ["LTC", "BCH", "BTC"] {
                let d = decide(&bid(SWAP_COMPLETED, t, &format_amount(n), "XMR", "1"));
                if let Decision::Charge { amount, notional, .. } = d {
                    assert!(amount <= notional, "{t}: charged {amount} on notional {notional}");
                }
            }
        }
    }
}
