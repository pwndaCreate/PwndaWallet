//! The fee schedule — rate, per-coin floors, fee addresses, and eligibility.
//!
//! Pure. No I/O, no clock, no network. Everything here is compiled into the
//! binary on purpose: see [[fee-enforcement-and-fork-resistance]] — the fee is
//! avoidable by design, and what makes removal *costly* is that it needs a Rust
//! rebuild rather than a text edit. No env override, no JSON config, no remote
//! source, exactly as the removed mining dev-fee's `wallets.rs` did it.
//!
//! # Money is integers here
//!
//! Every amount is **atomic units** (`u64`) — satoshi-equivalent, 1e-8, which is
//! the divisor for all three fee coins. Floats never touch a fee amount. The
//! engine API strings are parsed in [`parse_amount`] and rendered once, at the
//! edge, in [`format_amount`].

/// Fee rate in basis points. 50 bps = 0.5%. Operator-settled 2026-08-26.
pub const RATE_BPS: u64 = 50;

/// `flat = max(chain_min_output, K * tx_cost)` — the collection floor.
pub const K: u64 = 2;

/// The guard: never charge more than this share of a trade. Percent.
///
/// **DORMANT-PENDING-ZEPH.** With XMR as the only scriptless leg, every pair's
/// protocol minimum (~0.001 XMR ≈ $0.39) sits far above every guard zone
/// ($0.0022 / $0.02 / $1.20), so this branch cannot fire today. It is kept
/// implemented and tested against a *synthetic* pair because it goes live the
/// moment ZEPH returns (`types.ts:86` records it as planned): ZEPH's ~$0.00035
/// floor is exactly what made unguarded flats reach 150% / 571% / 51,286% in the
/// spec's worked examples.
pub const MAX_EFFECTIVE_RATE_PCT: u64 = 50;

/// Atomic units per whole coin. All three fee coins are 8-decimal.
pub const ATOMIC_PER_COIN: u64 = 100_000_000;

/// Tickers with no script layer. The fee is only charged on pairs that have
/// exactly one of these, and it is never denominated in one.
///
/// XMR, and since 2026-09-04 the two Grove followers ZEPH and ZANO (both
/// CryptoNote adaptor-signature legs, like Monero). The operator's rule,
/// restated that day: the fee is collected from TAKERS only and in the
/// SCRIPTED coin only — makers and scriptless coins are free. A ZEPH↔LTC or
/// ZANO↔BTC swap is therefore charged in LTC / BTC; ZEPH↔XMR has no scripted
/// leg and is free, exactly like the scripted↔scripted case. No schedule row
/// exists for a scriptless coin, by construction: `fee_address_for("ZEPH")`
/// is `None` and the tests below pin that it stays so.
pub const SCRIPTLESS_TICKERS: &[&str] = &["XMR", "ZEPH", "ZANO"];

/// One row of the schedule.
#[derive(Debug, Clone, Copy)]
pub struct CoinFee {
    pub ticker: &'static str,
    /// Dust / min-UTXO in atomic units. **Sourced from the wallet layer**, not
    /// from the bitcoin default: BTC's segwit dust is 294, not 546.
    pub chain_min_output: u64,
    /// Cost of making the collection transaction, atomic units.
    pub tx_cost: u64,
    /// Where the fee is sent. Compiled in; rotation needs a rebuild, by design.
    ///
    /// **Rotated 2026-09-02** (operator): BTC and BCH moved off the operator's
    /// personal wallet receive addresses onto dedicated collection addresses.
    /// LTC was re-supplied unchanged. Every value here is checksum-verified by
    /// [`tests::every_address_passes_its_own_checksum`] — a prefix match cannot
    /// catch a transposed character, and a fee sent to a valid-looking but wrong
    /// address is unrecoverable.
    pub address: &'static str,
    /// The USD price this row's floors were derived from, and the date. Kept so
    /// the derivation stays auditable without the runtime needing a price feed
    /// — see [`tests::flats_match_their_usd_targets`].
    pub price_usd_at_derivation: f64,
}

/// The live schedule.
///
/// **Scope: LTC, BCH, BTC** (operator, 2026-08-29). DASH and DOGE are out —
/// which also removed the only two coins without dedicated upstream XMR-pair
/// regtest coverage, so the charged scope is the testable scope.
///
/// Floors derived 2026-08-19 against the prices recorded per row:
///
/// | coin | chain min | tx cost | flat = max(min, 2×cost) | ≈ USD |
/// |---|---|---|---|---|
/// | BCH | 546 (dust)   | 243    | 546    | $0.0011 |
/// | LTC | 546 (dust)   | 11_369 | 22_738 | $0.0100 |
/// | BTC | 294 (segwit dust) | 476 | 952 | $0.6000 |
pub const FEE_COINS: &[CoinFee] = &[
    CoinFee {
        ticker: "LTC",
        chain_min_output: 546,
        tx_cost: 11_369,
        address: "ltc1q5rm7yppfc7yf7zh0ua9lm4cr6vgd5veppzalkk",
        price_usd_at_derivation: 43.98,
    },
    CoinFee {
        ticker: "BCH",
        chain_min_output: 546,
        tx_cost: 243,
        address: "bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8xc",
        price_usd_at_derivation: 205.38,
    },
    CoinFee {
        ticker: "BTC",
        chain_min_output: 294,
        tx_cost: 476,
        address: "bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0604l0",
        price_usd_at_derivation: 63_030.0,
    },
];

/// Normalise a ticker for comparison. Engine payloads are not case-consistent.
pub fn norm(ticker: &str) -> String {
    ticker.trim().to_ascii_uppercase()
}

pub fn is_scriptless(ticker: &str) -> bool {
    let t = norm(ticker);
    SCRIPTLESS_TICKERS.iter().any(|s| *s == t)
}

pub fn row_for(ticker: &str) -> Option<&'static CoinFee> {
    let t = norm(ticker);
    FEE_COINS.iter().find(|c| c.ticker == t)
}

/// The published fee address for a coin, or `None`.
///
/// `None` is the **activation gate**, and it fails OPEN: an unknown coin means
/// no fee, never a blocked swap. Same posture as the dev-fee registry's `None`.
pub fn fee_address_for(ticker: &str) -> Option<&'static str> {
    row_for(ticker).map(|c| c.address)
}

/// `flat = max(chain_min_output, K * tx_cost)`, atomic units.
pub fn flat_fee(ticker: &str) -> Option<u64> {
    row_for(ticker).map(|c| c.chain_min_output.max(K * c.tx_cost))
}

/// Which leg of a pair the fee is denominated in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeLeg {
    /// The scripted (transparent) ticker — what the fee is charged in.
    pub scripted: String,
    /// The scriptless ticker — what made the pair eligible.
    pub scriptless: String,
}

/// Identify the fee leg **by ticker, never by position**.
///
/// This is deliberately not `reverse_bid`-based. Upstream's own
/// `is_reverse_ads_bid` returns true for `scriptless_coins + coins_without_segwit`
/// — it answers "which side carries the initiator tx", not "which side is
/// scriptless", and it is true for DOGE/DASH/FIRO, which are scripted. The same
/// trap sits in `offers.ts`'s `REVERSED_COIN_KEYS`. Keying the fee on it would
/// mean depending on a flag that answers a *neighbouring* question, and reading
/// the wrong leg on XMR↔LTC mis-charges by the price ratio (~9×).
///
/// Because eligibility already requires **exactly one** scriptless leg, "the
/// other one" is unambiguous with no flag at all. The mis-charge is removed
/// structurally rather than tested for.
///
/// Returns `None` when the pair is not fee-eligible: zero scriptless legs
/// (scripted↔scripted is free — the Phantom rule) or two (which no pair is).
pub fn fee_leg(ticker_from: &str, ticker_to: &str) -> Option<FeeLeg> {
    let (a, b) = (norm(ticker_from), norm(ticker_to));
    if a.is_empty() || b.is_empty() || a == b {
        return None;
    }
    match (is_scriptless(&a), is_scriptless(&b)) {
        (true, false) => Some(FeeLeg { scripted: b, scriptless: a }),
        (false, true) => Some(FeeLeg { scripted: a, scriptless: b }),
        _ => None,
    }
}

/// Parse an engine amount string (`"1.23456789"`) into atomic units.
///
/// Rejects rather than rounds: an amount we cannot represent exactly is an
/// amount we must not charge against.
pub fn parse_amount(s: &str) -> Result<u64, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("empty amount".into());
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.starts_with('-') {
        return Err(format!("negative amount {s:?}"));
    }
    if frac.len() > 8 {
        return Err(format!("amount {s:?} has more precision than 8 decimals"));
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("amount {s:?} is not a decimal number"));
    }
    let whole: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| format!("amount {s:?} overflows"))?
    };
    let mut padded = frac.to_string();
    while padded.len() < 8 {
        padded.push('0');
    }
    let frac: u64 = if padded.is_empty() { 0 } else { padded.parse().unwrap_or(0) };
    whole
        .checked_mul(ATOMIC_PER_COIN)
        .and_then(|w| w.checked_add(frac))
        .ok_or_else(|| format!("amount {s:?} overflows"))
}

/// Render atomic units back to the decimal string the engine expects.
pub fn format_amount(atomic: u64) -> String {
    let whole = atomic / ATOMIC_PER_COIN;
    let frac = atomic % ATOMIC_PER_COIN;
    format!("{whole}.{frac:08}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_is_exactly_ltc_bch_btc() {
        let tickers: Vec<&str> = FEE_COINS.iter().map(|c| c.ticker).collect();
        assert_eq!(tickers, vec!["LTC", "BCH", "BTC"]);
    }

    /// Every row must carry a real address. An empty or placeholder address that
    /// reached a release would send fees nowhere — or worse, somewhere.
    #[test]
    fn every_row_has_a_plausible_address() {
        for c in FEE_COINS {
            assert!(!c.address.trim().is_empty(), "{} has no address", c.ticker);
            let ok = match c.ticker {
                "LTC" => c.address.starts_with("ltc1"),
                "BTC" => c.address.starts_with("bc1"),
                "BCH" => c.address.starts_with("bitcoincash:"),
                _ => false,
            };
            assert!(ok, "{} address has the wrong prefix: {}", c.ticker, c.address);
        }
    }

    // ---- address checksums -------------------------------------------------
    //
    // The prefix test above is an instance of the exact anti-pattern this repo's
    // bug-documentation protocol names first: **a check that cannot fail for the
    // reason you run it.** You run it to be sure the fee reaches us; it can only
    // catch a wrong PREFIX. Transpose two characters in the middle of a bech32
    // address and it still starts with `bc1`, still looks right in a diff, and
    // sends every fee ever collected to an address nobody holds the key to.
    //
    // So the checksum is verified here rather than trusted. These two functions
    // are the standard BIP-173 and CashAddr polymods; they are test-only because
    // the addresses are compile-time constants, so the build is the right place
    // to catch a bad one and a runtime check would be dead weight.

    const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

    fn charset_pos(c: u8) -> Option<u8> {
        CHARSET.iter().position(|&x| x == c).map(|i| i as u8)
    }

    /// BIP-173 polymod. Returns 1 for a valid bech32 string.
    fn bech32_polymod(values: &[u8]) -> u32 {
        const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
        let mut chk: u32 = 1;
        for &v in values {
            let b = chk >> 25;
            chk = ((chk & 0x1ff_ffff) << 5) ^ (v as u32);
            for (i, g) in GEN.iter().enumerate() {
                if (b >> i) & 1 == 1 {
                    chk ^= g;
                }
            }
        }
        chk
    }

    fn bech32_valid(addr: &str) -> bool {
        if addr != addr.to_ascii_lowercase() {
            return false; // mixed case is forbidden and we only ship lowercase
        }
        let Some(sep) = addr.rfind('1') else { return false };
        if sep < 1 || sep + 7 > addr.len() || addr.len() > 90 {
            return false;
        }
        let (hrp, data) = (&addr[..sep], &addr[sep + 1..]);
        let mut values: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
        values.push(0);
        values.extend(hrp.bytes().map(|c| c & 31));
        for c in data.bytes() {
            match charset_pos(c) {
                Some(v) => values.push(v),
                None => return false,
            }
        }
        // 1 = bech32 (v0 witness, which is what a bc1q/ltc1q address is).
        bech32_polymod(&values) == 1
    }

    /// CashAddr polymod (40-bit). Returns 0 for a valid string.
    fn cashaddr_polymod(values: &[u8]) -> u64 {
        let mut c: u64 = 1;
        for &d in values {
            let b = c >> 35;
            c = ((c & 0x07_ffff_ffff) << 5) ^ (d as u64);
            if b & 0x01 != 0 { c ^= 0x98f2_bc8e61; }
            if b & 0x02 != 0 { c ^= 0x79b7_6d99e2; }
            if b & 0x04 != 0 { c ^= 0xf33e_5fb3c4; }
            if b & 0x08 != 0 { c ^= 0xae2e_abe2a8; }
            if b & 0x10 != 0 { c ^= 0x1e4f_43e470; }
        }
        c ^ 1
    }

    fn cashaddr_valid(addr: &str) -> bool {
        let Some((prefix, payload)) = addr.split_once(':') else { return false };
        let mut values: Vec<u8> = prefix.bytes().map(|c| c & 31).collect();
        values.push(0);
        for c in payload.bytes() {
            match charset_pos(c) {
                Some(v) => values.push(v),
                None => return false,
            }
        }
        cashaddr_polymod(&values) == 0
    }

    /// **The money constant, verified rather than eyeballed.**
    ///
    /// Every fee address must pass its own chain's checksum. This is what makes
    /// an address rotation safe to do by hand: a typo cannot survive the build.
    #[test]
    fn every_address_passes_its_own_checksum() {
        for c in FEE_COINS {
            let ok = match c.ticker {
                "LTC" | "BTC" => bech32_valid(c.address),
                "BCH" => cashaddr_valid(c.address),
                other => panic!("no checksum rule known for {other} — add one before shipping it"),
            };
            assert!(ok, "{} fee address FAILS its checksum: {}", c.ticker, c.address);
        }
    }

    /// The checksum test must be able to fail. A validator that returns true for
    /// everything would pass the test above while protecting nothing — the same
    /// fault as the prefix check it replaces, one level up.
    #[test]
    fn the_checksum_validators_reject_a_tampered_address() {
        // Real addresses, each with two characters transposed in the payload.
        assert!(!bech32_valid("bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0640l0"), "BTC transposition");
        assert!(!bech32_valid("ltc1q5rm7yppfc7yf7zh0ua9lm4cr6vgd5veppzakll"), "LTC transposition");
        assert!(
            !cashaddr_valid("bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8cx"),
            "BCH transposition"
        );
        // And the positive control, so a validator that rejects everything is
        // caught too.
        assert!(bech32_valid("bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0604l0"));
        assert!(cashaddr_valid("bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8xc"));
    }

    /// The addresses must be distinct — a copy-paste that pointed two coins at
    /// one address would send funds to a chain that cannot spend them.
    #[test]
    fn addresses_are_distinct() {
        let mut seen = std::collections::HashSet::new();
        for c in FEE_COINS {
            assert!(seen.insert(c.address), "duplicate fee address: {}", c.address);
        }
    }

    /// The coin-denominated floors must still mean what the USD schedule says.
    /// This is what keeps the constants auditable WITHOUT putting a price feed
    /// in the money path.
    #[test]
    fn flats_match_their_usd_targets() {
        let want = [("LTC", 0.0100), ("BCH", 0.0011), ("BTC", 0.6000)];
        for (ticker, target_usd) in want {
            let c = row_for(ticker).unwrap();
            let flat = flat_fee(ticker).unwrap();
            let usd = (flat as f64 / ATOMIC_PER_COIN as f64) * c.price_usd_at_derivation;
            let drift = (usd - target_usd).abs() / target_usd;
            assert!(
                drift < 0.05,
                "{ticker} flat {flat} atomic = ${usd:.6} at ${}, target ${target_usd} (drift {:.1}%)",
                c.price_usd_at_derivation,
                drift * 100.0
            );
        }
    }

    #[test]
    fn flat_is_max_of_dust_and_k_times_cost() {
        // BCH: dust wins (546 > 2*243)
        assert_eq!(flat_fee("BCH"), Some(546));
        // LTC: k*cost wins (2*11369 > 546)
        assert_eq!(flat_fee("LTC"), Some(22_738));
        // BTC: k*cost wins (2*476 > 294)
        assert_eq!(flat_fee("BTC"), Some(952));
        assert_eq!(flat_fee("XMR"), None);
    }

    /// The rule that removes the ~9× mis-charge. Both directions, both cases.
    #[test]
    fn fee_leg_is_the_non_scriptless_side_in_either_position() {
        let a = fee_leg("LTC", "XMR").expect("XMR pair is eligible");
        assert_eq!(a.scripted, "LTC");
        let b = fee_leg("XMR", "LTC").expect("reversed XMR pair is eligible");
        assert_eq!(b.scripted, "LTC");
        // Same leg regardless of position — that is the whole point.
        assert_eq!(a.scripted, b.scripted);
    }

    /// The Phantom rule: charge only where we are indispensable.
    #[test]
    fn scripted_to_scripted_is_free() {
        for (f, t) in [("LTC", "BTC"), ("BTC", "BCH"), ("BCH", "LTC")] {
            assert_eq!(fee_leg(f, t), None, "{f}<->{t} must be free");
        }
    }

    /// Negative control for the trap this design exists to avoid: DOGE and DASH
    /// are `reverse_bid`-true upstream but are SCRIPTED. If anything ever keys
    /// eligibility off that flag, this goes red.
    #[test]
    fn reverse_bid_coins_are_not_treated_as_scriptless() {
        for t in ["DOGE", "DASH", "FIRO", "PIVX"] {
            assert!(!is_scriptless(t), "{t} is scripted, not scriptless");
        }
        // DOGE<->LTC has no scriptless leg at all, so it is free.
        assert_eq!(fee_leg("DOGE", "LTC"), None);
    }

    /// 2026-09-04: the Grove followers are scriptless legs too. Charged in the
    /// scripted coin, never in ZEPH/ZANO, and a scriptless↔scriptless pair is
    /// free — the operator's "takers only, scripted coins only" rule.
    #[test]
    fn grove_followers_are_scriptless_legs() {
        assert!(is_scriptless("ZEPH") && is_scriptless("zano"));
        assert_eq!(fee_leg("ZEPH", "LTC").expect("ZEPH-LTC is eligible").scripted, "LTC");
        assert_eq!(fee_leg("BTC", "ZANO").expect("BTC-ZANO is eligible").scripted, "BTC");
        assert_eq!(fee_leg("ZEPH", "XMR"), None, "two scriptless legs: free");
        assert_eq!(fee_leg("ZANO", "ZEPH"), None, "two scriptless legs: free");
        assert_eq!(fee_address_for("ZEPH"), None);
        assert_eq!(fee_address_for("ZANO"), None);
    }

    #[test]
    fn ticker_matching_is_case_and_space_insensitive() {
        assert_eq!(fee_leg(" ltc ", "xmr").unwrap().scripted, "LTC");
        assert_eq!(fee_address_for("btc"), fee_address_for("BTC"));
    }

    #[test]
    fn unknown_coin_has_no_address_and_therefore_no_fee() {
        assert_eq!(fee_address_for("ZEPH"), None);
        assert_eq!(fee_address_for("DOGE"), None);
        assert_eq!(fee_address_for(""), None);
    }

    #[test]
    fn amounts_round_trip_without_floats() {
        for (s, atomic) in [
            ("1", 100_000_000u64),
            ("0.00000001", 1),
            ("1.23456789", 123_456_789),
            ("0", 0),
            ("12345.6789", 1_234_567_890_000),
        ] {
            assert_eq!(parse_amount(s).unwrap(), atomic, "parse {s}");
            assert_eq!(parse_amount(&format_amount(atomic)).unwrap(), atomic, "round-trip {s}");
        }
    }

    #[test]
    fn amounts_refuse_rather_than_round() {
        for bad in ["1.234567891", "-1", "abc", "", "1.2.3"] {
            assert!(parse_amount(bad).is_err(), "{bad:?} must be refused");
        }
    }
}
