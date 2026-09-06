//! How deep a counterparty lock must be before we act on it.
//!
//! # Why this is not just "read `quote`"
//!
//! `quote` IS the source of truth and this module reads it. But the desk's round
//! 15 answer came with a warning worth encoding rather than remembering: the
//! preprod preset is internally inconsistent. It reports `ada.confirmations = 2`
//! while its own `ada.confirm_depth = 3` is commented *"reorg-depth floor for a
//! public testnet"* — so the engine treats a lock as confirmed at 2 while
//! applying a depth-3 reorg floor to extraction and sweep. There are also two
//! layers: the engine preset decides `confirmed` inside `watch_lock` (the layer
//! [`super::observer::SidecarObserver`] sees), and the desk coordinator applies a
//! second, independent floor of its own.
//!
//! So the rule here is `max(reported, floor)`:
//!
//! - It can only ever make us wait **longer**, never shorter, so a reported
//!   value that is too shallow cannot put our coin at risk.
//! - When the desk reconciles its two layers to 3/10, the floor becomes a no-op
//!   and `quote` wins outright — no code change, no stale constant to notice.
//! - If the desk ever raises a depth ABOVE the floor, we take the desk's larger
//!   number. The floor is a floor, not a pin.
//!
//! # Which number goes with which leg
//!
//! `minConfsIn`/`minConfsOut` on `quote` are relative to the USER's trade, so
//! their mapping onto chain A/B flips with direction. `minConfsA`/`minConfsB` on
//! `/status` are labelled by chain and do not. Prefer the latter where it is
//! available; [`SwapDepths::from_quote`] exists for the pre-accept path and is
//! explicit about the flip, because getting it backwards would apply Monero's
//! depth to Cardano and Cardano's to Monero — waiting far too long on one leg and
//! nowhere near long enough on the other.

#![allow(dead_code)] // consumed by the rung-3 driver

use super::engine::EngineError;

/// Cardano reorg-depth floor on a public testnet — the engine's own
/// `ada.confirm_depth`, which its `ada.confirmations = 2` currently undercuts.
pub const ADA_REORG_FLOOR: u64 = 3;

/// Monero lock depth. Matches the preset; stated as a constant so a preset that
/// regresses cannot silently lower it.
pub const XMR_REORG_FLOOR: u64 = 10;

/// The depth each leg must reach before we act on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwapDepths {
    /// Chain A — the scripted leg (Cardano).
    pub chain_a: u64,
    /// Chain B — the unscripted leg (Monero/Zephyr).
    pub chain_b: u64,
}

impl SwapDepths {
    /// From `/status`, whose `minConfsA`/`minConfsB` are labelled by CHAIN, so
    /// there is no direction to get wrong. Preferred.
    pub fn from_status(min_confs_a: i64, min_confs_b: i64) -> Self {
        Self {
            chain_a: floor_at(min_confs_a, ADA_REORG_FLOOR, "A"),
            chain_b: floor_at(min_confs_b, XMR_REORG_FLOOR, "B"),
        }
    }

    /// From `quote`, whose `minConfsIn`/`minConfsOut` are relative to the USER's
    /// trade and therefore flip with direction:
    ///
    /// - `SELL_FOLLOWER` — the user sells the follower coin (XMR). It goes IN,
    ///   ADA comes OUT. So `in` is chain B and `out` is chain A.
    /// - `BUY_FOLLOWER` — the reverse.
    ///
    /// Returns an error on an unrecognized direction rather than picking one.
    /// Defaulting here would silently swap Monero's depth onto Cardano.
    pub fn from_quote(
        direction: &str,
        min_confs_in: i64,
        min_confs_out: i64,
    ) -> Result<Self, EngineError> {
        let (a, b) = match direction {
            "SELL_FOLLOWER" => (min_confs_out, min_confs_in),
            "BUY_FOLLOWER" => (min_confs_in, min_confs_out),
            other => return Err(EngineError::UnknownDeskRole(other.to_string())),
        };
        Ok(Self::from_status(a, b))
    }

    /// The depth for one leg.
    pub fn for_chain(&self, chain: super::watch::Chain) -> u64 {
        match chain {
            super::watch::Chain::A => self.chain_a,
            super::watch::Chain::B => self.chain_b,
        }
    }
}

/// `max(reported, floor)`, saying so when the floor bites. A negative or absent
/// value becomes the floor: an unset depth must never read as "no wait needed".
fn floor_at(reported: i64, floor: u64, chain: &str) -> u64 {
    let reported = u64::try_from(reported).unwrap_or(0);
    if reported < floor {
        eprintln!(
            "[desk::depth] chain {chain}: the desk reports minConfs={reported} but the reorg \
             floor is {floor} - using {floor}. Waiting longer than asked is safe; waiting less \
             is not."
        );
        return floor;
    }
    reported
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::watch::Chain;

    /// The case the desk warned about: preprod reports ADA=2 while its own reorg
    /// floor is 3. We must not lock our coin against a 2-deep chain-A view.
    #[test]
    fn a_reported_depth_below_the_reorg_floor_is_raised_not_taken() {
        let d = SwapDepths::from_status(2, 10);
        assert_eq!(d.chain_a, 3, "ADA=2 must be raised to the reorg floor");
        assert_eq!(d.chain_b, 10);
    }

    /// The floor is a floor, not a pin: when the desk asks for MORE, take more.
    /// Otherwise reconciling their two layers upward would be ignored.
    #[test]
    fn a_deeper_desk_requirement_wins_over_the_floor() {
        let d = SwapDepths::from_status(6, 25);
        assert_eq!(d.chain_a, 6);
        assert_eq!(d.chain_b, 25);
    }

    /// Once the desk reconciles to 3/10 the floor is a no-op and quote wins
    /// outright — no code change needed on this side.
    #[test]
    fn the_reconciled_values_pass_through_untouched() {
        assert_eq!(
            SwapDepths::from_status(3, 10),
            SwapDepths {
                chain_a: 3,
                chain_b: 10
            }
        );
    }

    /// A missing or nonsensical depth must never read as "act immediately".
    #[test]
    fn absent_or_negative_depths_fall_back_to_the_floor() {
        let d = SwapDepths::from_status(0, -1);
        assert_eq!(d.chain_a, ADA_REORG_FLOOR);
        assert_eq!(d.chain_b, XMR_REORG_FLOOR);
    }

    /// `in`/`out` are relative to the user's trade, so they flip with direction.
    /// Getting this backwards applies Monero's depth to Cardano and vice versa.
    #[test]
    fn quote_in_out_maps_onto_chains_by_direction_not_by_position() {
        // Both values are above BOTH floors on purpose, so this test measures
        // the mapping and nothing else. (Using realistic 10/4 here would let the
        // XMR floor rewrite the 4 and hide a mapping error behind a coincidence
        // — which is exactly what it did on the first run of this test.)
        const IN: i64 = 20;
        const OUT: i64 = 15;

        // SELL_FOLLOWER: user sells XMR (in = chain B), receives ADA (out = A).
        let sell = SwapDepths::from_quote("SELL_FOLLOWER", IN, OUT).unwrap();
        assert_eq!(sell.chain_a, OUT as u64);
        assert_eq!(sell.chain_b, IN as u64);

        // BUY_FOLLOWER is the mirror image, with the SAME wire numbers.
        let buy = SwapDepths::from_quote("BUY_FOLLOWER", IN, OUT).unwrap();
        assert_eq!(buy.chain_a, IN as u64);
        assert_eq!(buy.chain_b, OUT as u64);

        assert_ne!(sell, buy, "the direction must actually change the mapping");
    }

    /// An unrecognized direction must refuse rather than pick a mapping.
    #[test]
    fn an_unknown_direction_refuses_instead_of_guessing_the_mapping() {
        assert!(SwapDepths::from_quote("SIDEWAYS", 10, 2).is_err());
    }

    #[test]
    fn for_chain_selects_the_right_leg() {
        let d = SwapDepths::from_status(3, 10);
        assert_eq!(d.for_chain(Chain::A), 3);
        assert_eq!(d.for_chain(Chain::B), 10);
    }
}
