//! The BasicSwap **bid write path** — the one renderer-reachable door that
//! commits funds to a peer-to-peer swap.
//!
//! # Why this is its own door and not an allow-list entry
//!
//! `bids/new` stays in [`crate::swap_sidecar::DENIED_ENDPOINTS`] and stays out
//! of `check_endpoint`'s allow-list, exactly as before. The generic API proxy
//! (`swap_sidecar_api_post`) is a pass-through: it forwards whatever JSON the
//! renderer hands it to whatever path the renderer names. Widening it to reach
//! `bids/new` would mean a compromised renderer — an XSS, a poisoned
//! dependency — could post an arbitrary bid body to the engine. So it is not
//! widened. This module is a *separate* command with a pinned path and its own
//! validation, the same shape `swap_bridge`'s privileged withdraw door already
//! uses (`api_post_privileged` + `assert_privileged_path`).
//!
//! The comment this replaces said it out loud: `submitSidecarBid` was written
//! against the real endpoint and left failing "because the two alternatives are
//! worse ... nothing to review when the reviewed Rust write command lands."
//! This is that command.
//!
//! # What Rust checks that the renderer cannot be trusted for
//!
//! The renderer already mirrors the node's bid rules in `offers.ts::validateBid`
//! so the user gets an answer while typing. That mirror is a UX affordance, not
//! a control: it runs in the process an attacker would own. So this door
//! **re-reads the offer from the engine** and re-derives the verdict from the
//! engine's own numbers:
//!
//! 1. the body is structurally sound (ids, decimals, bounded lengths);
//! 2. the offer exists, and is not expired / revoked / our own;
//! 3. the bid amount is inside the offer's own `[min_bid_amount, amount_from]`;
//! 4. the bid rate matches the offer's rate within [`BID_RATE_TOLERANCE`].
//!
//! (4) is the one that matters most: it is what stops a compromised renderer
//! from showing the user a good rate and submitting a bad one. The engine
//! re-checks everything again after us and remains the authority — this door
//! exists so a renderer bug cannot *reach* the engine with something the user
//! never saw.
//!
//! # What this door deliberately does NOT gate on
//!
//! In-flight swaps. [`crate::swap_bridge::reserved_balance_gate`] refuses a
//! *sweep* while the engine has swaps in flight, because draining the wallet
//! would abort them. A bid is the opposite operation: other swaps running is
//! the normal state of a working node, and blocking on it would make a second
//! concurrent swap impossible.

use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::swap_sidecar::{
    api_context, basic_auth_header, build_api_url, config_coin_active, datadir,
    decode_api_response, read_optin, shares_zano_host_wallet, shares_zph_host_wallet,
    supervisor_log, ApiMethod, OptInRecord, SwapSidecarState, HOST_MANAGED_DAEMON_COINS,
};

/// The ONLY path this door will ever post to. Not a parameter, not a prefix —
/// a constant, so there is no input that can redirect it.
const BID_NEW_PATH: &str = "bids/new";

/// How many `bids/new` POSTs this process has sent. A plain counter that the
/// swap path bumps and never reads: anything that wants to react to a new
/// taker bid (the interface-fee watcher does, 2026-09-18) polls it locally
/// instead of sweeping the node's bid list on a timer. The dependency runs one
/// way — this module knows nothing about its readers.
static BIDS_SENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// See [`BIDS_SENT`].
pub fn bids_sent() -> u64 {
    BIDS_SENT.load(std::sync::atomic::Ordering::Relaxed)
}

/// How far a bid's rate may differ from the offer's, as a fraction.
///
/// 0.01 %, mirroring `offers.ts::RATE_TOLERANCE_FRACTION` and upstream's own
/// check. Both sides must agree: a wallet that submits outside this window gets
/// a guaranteed round-trip rejection, and a wallet *looser* than the engine
/// would let a renderer move the price under the user.
pub const BID_RATE_TOLERANCE: f64 = 0.0001;

/// Upper bound on an id we will echo into a request. Upstream ids are 56 hex
/// chars; the bound is generous but finite so a pathological string cannot be
/// forwarded.
const MAX_ID_LEN: usize = 128;

/// Upper bound on a decimal amount string.
const MAX_AMOUNT_LEN: usize = 64;

/// What the renderer asks for. Every field is re-checked here.
#[derive(Debug, Clone)]
pub struct BidRequest {
    pub offer_id: String,
    /// The RECEIVE leg — upstream denominates a bid in the offer's `coin_from`.
    pub amount_from: String,
    /// Send-coin per 1 receive-coin, pinned to the offer.
    pub rate: String,
    /// Where the bought coin should land: the payout address the user
    /// reviewed. `None` leaves it to the engine, which pays its own wallet.
    /// Sent as `destination_address` (see [`build_bid_body`]) and only after
    /// [`payout_destination`] has checked it against the engine's own copy of
    /// the offer.
    pub addr_to: Option<String>,
    pub valid_for_seconds: Option<u64>,
}

/// An object id as upstream writes them: hex, non-empty, bounded.
pub fn is_bid_object_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID_LEN && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A positive decimal amount. Rejects exponent notation, signs, and anything
/// that is not digits-and-at-most-one-dot: those are the shapes that survive a
/// naive `parse::<f64>()` and then mean something different to the engine.
pub fn parse_positive_decimal(s: &str) -> Result<f64, String> {
    let t = s.trim();
    if t.is_empty() || t.len() > MAX_AMOUNT_LEN {
        return Err(format!("{:?} is not a usable amount", s));
    }
    if !t.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(format!(
            "{:?} is not a plain decimal amount (no signs, no exponents)",
            s
        ));
    }
    if t.matches('.').count() > 1 {
        return Err(format!("{:?} has more than one decimal point", s));
    }
    let v: f64 = t.parse().map_err(|_| format!("{:?} is not a number", s))?;
    if !v.is_finite() || v <= 0.0 {
        return Err(format!("{:?} must be greater than zero", s));
    }
    Ok(v)
}

/// Structural validation of the request, before any socket is opened.
pub fn validate_bid_request(req: &BidRequest) -> Result<(f64, f64), String> {
    if !is_bid_object_id(&req.offer_id) {
        return Err(format!(
            "{:?} is not a valid offer id - expected hex",
            req.offer_id
        ));
    }
    let amount = parse_positive_decimal(&req.amount_from)?;
    let rate = parse_positive_decimal(&req.rate)?;
    if let Some(addr) = &req.addr_to {
        let a = addr.trim();
        if a.is_empty() || a.len() > 128 || a.chars().any(|c| c.is_whitespace()) {
            return Err(format!("{:?} is not a usable payout address", addr));
        }
    }
    if let Some(v) = req.valid_for_seconds {
        // Upstream's own window: 10 minutes to 24 hours.
        if !(600..=86_400).contains(&v) {
            return Err(format!(
                "a bid's validity must be between 600 and 86400 seconds, got {}",
                v
            ));
        }
    }
    Ok((amount, rate))
}

fn field_str<'a>(offer: &'a Value, key: &str) -> Option<&'a str> {
    offer.get(key).and_then(|v| v.as_str())
}

fn field_decimal(offer: &Value, key: &str) -> Option<f64> {
    match offer.get(key) {
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

fn field_bool(offer: &Value, key: &str) -> bool {
    offer.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// The engine's `/json/offers/<id>` answers with a ONE-ELEMENT ARRAY, not the
/// object (`js_server.py`). Accept either, and say so when neither is there.
pub fn offer_from_reply(reply: &Value, offer_id: &str) -> Result<Value, String> {
    if let Some(e) = reply.get("error").and_then(|e| e.as_str()) {
        return Err(format!("the swap node refused the offer lookup: {}", e));
    }
    let candidate = match reply {
        Value::Array(items) => items.first().cloned(),
        Value::Object(_) => Some(reply.clone()),
        _ => None,
    };
    let offer = candidate.ok_or_else(|| {
        format!(
            "the swap node returned no offer for {} - it may have just expired or been withdrawn",
            offer_id
        )
    })?;
    // Guard against the engine handing back a *different* offer than asked for.
    if let Some(got) = field_str(&offer, "offer_id") {
        if !got.eq_ignore_ascii_case(offer_id) {
            return Err(format!(
                "the swap node answered with offer {} when asked for {}",
                got, offer_id
            ));
        }
    }
    Ok(offer)
}

/// Re-derive the verdict from the ENGINE's own copy of the offer.
///
/// `now_secs` is passed rather than read so the expiry arithmetic is itself
/// under test.
pub fn verify_against_offer(
    _req: &BidRequest,
    amount: f64,
    rate: f64,
    offer: &Value,
    now_secs: u64,
) -> Result<(), String> {
    if field_bool(offer, "is_expired") {
        return Err("that offer has expired - re-quote to price against the current book".into());
    }
    if field_bool(offer, "is_revoked") {
        return Err("that offer was withdrawn by the other user - re-quote".into());
    }
    if field_bool(offer, "is_own_offer") {
        return Err("that is this node's own offer and cannot be bid on".into());
    }
    if let Some(expire_at) = offer.get("expire_at").and_then(|v| v.as_u64()) {
        if expire_at <= now_secs {
            return Err(
                "that offer expired while it was on screen - re-quote to price against the current book"
                    .into(),
            );
        }
    }

    let offer_rate = field_decimal(offer, "rate").ok_or_else(|| {
        "the swap node's copy of that offer has no readable rate, so the bid is refused".to_string()
    })?;
    if !(offer_rate.is_finite() && offer_rate > 0.0) {
        return Err("the swap node's copy of that offer has an unusable rate".into());
    }
    // THE check this door exists for: the rate the user reviewed must be the
    // rate the engine has. A renderer that displayed one price and submitted
    // another dies here, not at the engine.
    let drift = (rate - offer_rate).abs() / offer_rate;
    if drift > BID_RATE_TOLERANCE {
        return Err(format!(
            "the bid's rate ({}) no longer matches the offer's ({}) - the offer was re-priced or \
             the request was altered. Nothing was sent; re-quote and review again.",
            rate, offer_rate
        ));
    }

    let max_receive = field_decimal(offer, "amount_from").ok_or_else(|| {
        "the swap node's copy of that offer has no readable size, so the bid is refused".to_string()
    })?;
    if amount > max_receive {
        return Err(format!(
            "that offer only has {} available and the bid asks for {}",
            max_receive, amount
        ));
    }
    // `min_bid_amount` is optional upstream; absent means "no maker minimum".
    if let Some(min_receive) = field_decimal(offer, "min_bid_amount") {
        if min_receive > 0.0 && amount < min_receive {
            return Err(format!(
                "that offer will not fill less than {} and the bid asks for {}",
                min_receive, amount
            ));
        }
    }
    Ok(())
}

/// `{"bid_id": "..."}`, a bare string, or an `error` body (HTTP 200).
pub fn extract_bid_id(v: &Value) -> Result<String, String> {
    if let Some(e) = v.get("error") {
        return Err(format!("the swap node refused the bid: {}", e));
    }
    let id = match v {
        Value::String(s) => Some(s.trim().to_string()),
        _ => ["bid_id", "bidId", "id"]
            .iter()
            .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
            .map(|s| s.trim().to_string()),
    };
    id.filter(|s| !s.is_empty()).ok_or_else(|| {
        "the swap node accepted the bid but returned no bid id, so the wallet cannot track it - \
         check the advanced console before retrying, so the same bid is not placed twice"
            .to_string()
    })
}

/// The key the deployed engine reads a bid's payout address from.
///
/// `js_bids` (deployed `js_server.py:770-778`) reads `destination_address`:
/// into `dest_af = ci_from.decodeAddress(...)` for a normal bid, or into
/// `dest_bl` (the string itself) for a reversed one. It never reads
/// `addr_to`, which is what this door sent until 2026-10-06, so every bid
/// paid the swap node's own wallet (`getReceiveAddressFromPool`,
/// `basicswap.py:7084-7092`) and never the address on the confirm screen.
/// Found by the swap open-items pass of 2026-10-01; the operator's decision
/// is that the engine pays the address the user confirmed.
pub const DESTINATION_FIELD: &str = "destination_address";

/// The body posted to the engine. Built here, never forwarded from the
/// renderer, so no unexpected key can ride along.
///
/// The payout address goes in as [`DESTINATION_FIELD`]. `addr_to` must never
/// appear: the engine ignores it, and a body carrying it looks as if it sets
/// the payout while it sets nothing (the 2026-10-01 finding above).
/// `swap_sidecar_place_bid` puts an address here only after
/// [`payout_destination`] accepted it.
pub fn build_bid_body(req: &BidRequest) -> Value {
    let mut body = serde_json::json!({
        "offer_id": req.offer_id,
        "amount_from": req.amount_from.trim(),
        "rate": req.rate.trim(),
    });
    if let Some(addr) = req
        .addr_to
        .as_ref()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
    {
        body[DESTINATION_FIELD] = Value::String(addr.to_string());
    }
    if let Some(v) = req.valid_for_seconds {
        body["valid_for_seconds"] = Value::String(v.to_string());
    }
    body
}

// ── The payout address: which forms the engine pays as written ──────────
//
// Operator decision, 2026-10-01: the engine pays the address the user
// confirmed. Sending it is not enough on its own, because the deployed engine
// handles some address forms in ways that do not pay that address. Read in the
// deployed tree (`.swap-sidecar-work/runtime/Lib/site-packages/basicswap/`):
//
// * Which path an address takes depends on the coin bought, the offer's
//   `coin_from`. `is_reverse_ads_bid` (`basicswap.py:3992`) is true when it is
//   one of `scriptless_coins + coins_without_segwit` (`chainparams.py:55-71`:
//   XMR, ZEPH, ZANO, DOGE among others, and DASH). Then the address is kept as
//   a string, `dest_bl`, checked by that coin's `isValidAddress`
//   (`basicswap.py:6993-7004`), and this node's chain-B redeem pays it
//   (`redeemXmrBidCoinBLockTx`, `:14182-14191`). Otherwise (BTC, LTC, BCH) it
//   becomes `dest_af = ci_from.decodeAddress(...)` (`js_server.py:776`),
//   checked only for its LENGTH (`isValidSwapDest`, `basicswap.py:4393`: 20
//   bytes, or a full P2WPKH/P2WSH script), and the chain-A spend the other
//   side builds pays `getScriptForPubkeyHash(dest_af)`, which this node
//   verifies (`interface/btc/btc.py:2045`, "Bad output destination").
// * BTC/LTC `decodeAddress` (`interface/btc/btc.py:1298`) returns a bech32
//   address's witness program, or a base58 address's hash with its version
//   byte dropped. `getScriptForPubkeyHash` (`:1414`) is P2WPKH. So `bc1q`/
//   `ltc1q` + 20 bytes is paid exactly; a legacy `1…`/`L…` address is paid as
//   the P2WPKH of the same hash, an address the wallet does not show; a P2SH
//   `3…`/`M…` address is paid as P2WPKH of a SCRIPT hash, which no key can
//   spend; P2WSH, taproot and MWEB fail `isValidSwapDest` or the decode and
//   the bid is refused.
// * BCH `decodeAddress` (`interface/bch/bch.py:198`) is the CashAddr payload,
//   prefix required (`contrib/cashaddress.py:219`), paid as P2PKH (`:377`, and
//   the covenant's `out_1`, `basicswap.py:7357`). A `p…` (P2SH) payload would
//   be paid as P2PKH of a script hash.
// * DOGE and DASH redeem through `spendBLockTx` (`interface/btc/btc.py:3554`):
//   base58 decode with the version dropped, paid as P2PKH (`doge.py:53`,
//   `dash.py:94`). `isValidAddress` there is the node's `validateaddress`, which
//   a P2SH address passes; it would be paid as P2PKH of a script hash.
// * XMR and ZEPH (`interface/xmr/xmr.py:586`) accept a standard or a
//   subaddress for their own prefixes and `sweep_all` to it (`:926-930`); an
//   integrated address is refused. ZANO (`interface/zano/zano.py:1740`)
//   accepts a plain `Zx…` address of exact length and `transfer`s to it
//   (`:1536`).
// * A non-adaptor-signature offer (SELLER_FIRST) reads no destination at all:
//   `postBid` ignores it and the redeem pays the node's own pool address
//   (`basicswap.py:8244`). With `strict_swap_type` on, the mainnet default
//   (`:4021`), only PIVX/DASH pairs may use it, so none the wallet routes.
//
// So each coin has ONE form sent as written, the form the wallet itself
// derives by default. Anything else is refused here; the renderer
// (`swap-sidecar/payoutDestination.ts`, the same table) does not send it and
// says on the confirm screen that the coin lands in the swap node's wallet.
// This check is the backstop for that renderer rule, not a second opinion:
// the two tables are pinned equal by `payoutDestination.test.ts`.
//
// ── ...and only where the node can follow a payout to an outside address ──
//
// 2026-10-06: an address is sent only when the swap node can confirm a
// payment to an address outside its wallet for the coin bought. Read in the
// same deployed tree:
//
// * BTC, LTC and BCH are bought on a normal bid, paid by this node's chain-A
//   redeem. The state machine completes such a bid when its chain watcher sees
//   the lock spent (`process_XMR_SWAP_A_LOCK_tx_spend`,
//   `basicswap.py:10560-10626`), whatever the redeem pays. A bid that lands in
//   BID_ERROR after the redeem is published, though, is settled by
//   PWNDA-PATCH-27 (`pwndaRecoverStalledBid`, `:7870-7940`, which the janitor
//   below calls), and that reads the redeem's confirmations
//   (`pwndaTxConfirmations`, `:7975-7999`): an electrum backend answers for
//   any transaction; an RPC node answers for a confirmed one only with
//   txindex (`getrawtransaction`) or for its wallet's own (`gettransaction`;
//   "Only works for wallet txns", `interface/btc/btc.py:5055`). The engine
//   neither turns txindex on for these coins nor reports it (only Particl's
//   config gets `txindex=1`, `interface/part/core.py:150`), and a redeem
//   paying the user's address is not the wallet's. On RPC that bid would stay
//   "in progress" for good, the 2026-08-23 shape PATCH-27 exists for. So
//   electrum only.
// * DOGE and DASH get no electrum connection from this engine
//   (`electrum_supported_coins` is bitcoin, litecoin, bitcoincash,
//   `ui/page_settings.py:169-173`) and their RPC node has the same lookup, so
//   by the same rule they are never sent. Their payout is a chain-B redeem
//   like XMR's (next point), so this follows the rule, not a need of the
//   settle path today: one entry each below if that should change.
// * XMR, ZEPH and ZANO are bought on a reversed bid (`is_reverse_ads_bid`,
//   `:3992`), paid by this node's chain-B redeem (`redeemXmrBidCoinBLockTx`).
//   For an address its wallet does not own (`isAddressMine`, `:14184`) the
//   engine marks the bid completed as soon as the redeem is submitted ("The
//   spend won't be seen in the wallet, there is nothing to wait for",
//   `:14262-14268`); for its own address it waits until its wallet finds the
//   redeem (`findConfirmedTxnByHash`, `:9658-9670`, which for an outside
//   address is a TODO, `interface/xmr/xmr.py:805`). Nothing reads an outside
//   payout again, so nothing stalls on it whatever the connection. Nothing
//   confirms it either.
//
// The connection is what the RUNNING engine reports: `connection_type` in
// `/json/wallets` (`getWalletInfo`, `:16536`, from its live `coin_clients`,
// not `basicswap.json`, which a settings edit rewrites before a restart
// applies it, `:16324-16329`). Not read, or not listed, counts as not
// electrum.

/// `SwapTypes.XMR_SWAP` (deployed `basicswap_util.py:91`).
const SWAP_TYPE_XMR: u64 = 5;

/// The one address form per coin that the deployed engine pays exactly as
/// written. Shape only: the engine verifies the checksum, and a shape that
/// matches with a bad checksum is refused there, not paid elsewhere.
pub const PAYOUT_ADDRESS_SHAPES: &[(&str, &str)] = &[
    ("BTC", r"^bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$"),
    ("LTC", r"^ltc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$"),
    ("BCH", r"^bitcoincash:q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$"),
    ("DOGE", r"^D[1-9A-HJ-NP-Za-km-z]{33}$"),
    ("DASH", r"^X[1-9A-HJ-NP-Za-km-z]{33}$"),
    ("XMR", r"^[48][1-9A-HJ-NP-Za-km-z]{94}$"),
    ("ZEPH", r"^(?:ZEPHYR[1-9A-HJ-NP-Za-km-z]{95}|ZEPHs[1-9A-HJ-NP-Za-km-z]{94})$"),
    ("ZANO", r"^Zx[1-9A-HJ-NP-Za-km-z]{95}$"),
];

/// The ticker of the coin a bid on `offer` buys: the offer's `coin_from`, as
/// the engine names it in `/json/offers` (`ci.coin_name()`: "Litecoin",
/// "Bitcoin Cash", …). `None` for a coin the table above has no rule for.
pub fn receive_ticker(offer: &Value) -> Option<&'static str> {
    let name = field_str(offer, "coin_from")?;
    let key: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    Some(match key.as_str() {
        "BITCOIN" | "BTC" => "BTC",
        "LITECOIN" | "LTC" => "LTC",
        "BITCOINCASH" | "BCH" => "BCH",
        "DOGECOIN" | "DOGE" => "DOGE",
        "DASH" => "DASH",
        "MONERO" | "XMR" => "XMR",
        "ZEPHYR" | "ZEPH" => "ZEPH",
        "ZANO" => "ZANO",
        _ => return None,
    })
}

/// How the swap node must reach a coin's chain before a payout to an outside
/// address is sent (2026-10-06, the trace above): `"electrum"`, or `"any"` for
/// a coin whose outside payout the engine never reads again. A coin missing
/// here is never sent. `payoutDestination.ts` has the same table, pinned equal
/// by its test.
pub const PAYOUT_CONNECTION_REQUIRED: &[(&str, &str)] = &[
    ("BTC", "electrum"),
    ("LTC", "electrum"),
    ("BCH", "electrum"),
    ("DOGE", "electrum"),
    ("DASH", "electrum"),
    ("XMR", "any"),
    ("ZEPH", "any"),
    ("ZANO", "any"),
];

fn connection_required(ticker: &str) -> Option<&'static str> {
    PAYOUT_CONNECTION_REQUIRED
        .iter()
        .find(|(t, _)| *t == ticker)
        .map(|(_, need)| *need)
}

/// Whether a payout of `ticker` depends on how the node reaches its chain, so
/// the place-bid door asks the node before it decides.
pub fn payout_needs_connection(ticker: &str) -> bool {
    connection_required(ticker) != Some("any")
}

/// The `connection_type` the running engine reports for `ticker` in a
/// `/json/wallets` reply (ticker-keyed, `getWalletsInfo`). `None` for an error
/// reply, a coin it does not list, or a coin whose entry is `{name, error}`.
pub fn reported_connection(wallets: &Value, ticker: &str) -> Option<String> {
    wallets
        .get(ticker)?
        .get("connection_type")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// What one payout decision looks at. A rule that needs more of the swap (the
/// fee rule, if it comes: a taker buying a scripted coin with a scriptless one
/// while the licence fee is live) adds its input here.
pub struct PayoutCase<'a> {
    /// The ENGINE's copy of the offer.
    pub offer: &'a Value,
    /// The coin bought, when the wallet has a rule for it.
    pub ticker: Option<&'static str>,
    /// The address as it would be sent, trimmed.
    pub address: &'a str,
    /// How the node reports it reaches the coin bought's chain, when read.
    pub connection: Option<&'a str>,
}

/// One check: a refusal (a sentence ending "Nothing was sent."), or `None`.
type PayoutCheck = fn(&PayoutCase<'_>) -> Option<String>;

/// Every check an address passes before it is sent, in order; the first
/// refusal decides. `payoutDestination.ts::PAYOUT_CHECKS` is the same list in
/// the same order (`check_<name>` here, `name` there), pinned by its test: a
/// new rule is one entry in each.
const PAYOUT_CHECKS: &[PayoutCheck] = &[check_protocol, check_coin, check_form, check_connection];

fn check_protocol(c: &PayoutCase<'_>) -> Option<String> {
    if c.offer.get("swap_type").and_then(|v| v.as_u64()) == Some(SWAP_TYPE_XMR) {
        return None;
    }
    Some(
        "this offer's swap protocol pays the swap node's own wallet whatever address is \
         given, so the wallet should not have sent one. Nothing was sent."
            .to_string(),
    )
}

fn check_coin(c: &PayoutCase<'_>) -> Option<String> {
    if c.ticker.is_some() {
        return None;
    }
    Some(format!(
        "the wallet has no payout rule for {}, so it should not have sent an address. \
         Nothing was sent.",
        field_str(c.offer, "coin_from").unwrap_or("this coin")
    ))
}

fn check_form(c: &PayoutCase<'_>) -> Option<String> {
    let Some(ticker) = c.ticker else {
        return check_coin(c);
    };
    let Some(pattern) = PAYOUT_ADDRESS_SHAPES
        .iter()
        .find(|(t, _)| *t == ticker)
        .map(|(_, p)| *p)
    else {
        return Some(format!(
            "no payout address form is recorded for {}. Nothing was sent.",
            ticker
        ));
    };
    match regex::Regex::new(pattern) {
        Err(e) => Some(format!(
            "the {} payout address rule does not compile: {}. Nothing was sent.",
            ticker, e
        )),
        Ok(shape) if shape.is_match(c.address) => None,
        Ok(_) => Some(format!(
            "{:?} is not a {} address form the swap engine pays as written, so the bid is \
             refused rather than paid somewhere else. Nothing was sent.",
            c.address, ticker
        )),
    }
}

fn check_connection(c: &PayoutCase<'_>) -> Option<String> {
    let Some(ticker) = c.ticker else {
        return check_coin(c);
    };
    match connection_required(ticker) {
        Some("any") => None,
        Some("electrum") => match c.connection {
            Some("electrum") => None,
            Some(other) => Some(format!(
                "the swap node follows {} through a full node ({:?}), which can confirm a \
                 payment only to its own wallet, so the wallet should not have sent an \
                 outside address. Nothing was sent.",
                ticker, other
            )),
            None => Some(format!(
                "the swap node did not say how it reaches {}, so a payment to an outside \
                 address could not be followed and the wallet should not have sent one. \
                 Nothing was sent.",
                ticker
            )),
        },
        _ => Some(format!(
            "no payout connection rule is recorded for {}. Nothing was sent.",
            ticker
        )),
    }
}

/// The payout address to send as [`DESTINATION_FIELD`], or why it must not be
/// sent. Checked against the ENGINE's copy of the offer (its `swap_type` and
/// `coin_from`), not the renderer's, and against the node's own report of how
/// it reaches the coin bought (`connection`, from `/json/wallets`; `None` when
/// it was not read or did not say).
pub fn payout_destination(
    offer: &Value,
    addr: &str,
    connection: Option<&str>,
) -> Result<String, String> {
    let case = PayoutCase {
        offer,
        ticker: receive_ticker(offer),
        address: addr.trim(),
        connection,
    };
    match PAYOUT_CHECKS.iter().find_map(|check| check(&case)) {
        Some(refusal) => Err(refusal),
        None => Ok(case.address.to_string()),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Place a bid on a BasicSwap offer. **Commits funds.**
///
/// Returns the engine's bid id, which the renderer hands to the tracker.
#[tauri::command]
pub async fn swap_sidecar_place_bid(
    sc: tauri::State<'_, SwapSidecarState>,
    offer_id: String,
    amount_from: String,
    rate: String,
    addr_to: Option<String>,
    valid_for_seconds: Option<u64>,
) -> Result<String, String> {
    let req = BidRequest {
        offer_id,
        amount_from,
        rate,
        addr_to,
        valid_for_seconds,
    };
    // 1. Structure, before any socket is opened.
    let (amount, rate_f) = validate_bid_request(&req)?;

    let (port, auth) = api_context(&sc)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;

    // 2. Re-read the offer from the engine and re-derive the verdict.
    let offer_reply: Value = {
        let url = format!("http://127.0.0.1:{}/json/offers/{}", port, req.offer_id);
        let resp = client
            .get(&url)
            .header("Authorization", basic_auth_header(&auth))
            .send()
            .await
            .map_err(|e| format!("could not re-read the offer from the swap node: {}", e))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("could not read the swap node's reply: {}", e))?;
        if !(200..300).contains(&status) {
            return Err(format!("swap node HTTP {} on the offer lookup", status));
        }
        serde_json::from_str(&text)
            .map_err(|e| format!("the swap node's offer reply was not JSON: {}", e))?
    };
    let offer = offer_from_reply(&offer_reply, &req.offer_id)?;
    verify_against_offer(&req, amount, rate_f, &offer, now_secs())?;

    // 2b. The payout address, against the engine's own copy of the offer: only
    //     a form the engine pays exactly as written goes into the body
    //     (2026-10-01), and only for a coin whose payout to an outside address
    //     the node can follow (2026-10-06). How the node reaches that coin's
    //     chain is read from the node itself, not taken from the renderer, and
    //     only for a coin whose rule depends on it. Anything else refuses the
    //     bid instead. See `payout_destination`.
    let destination = match req
        .addr_to
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        Some(a) => {
            let connection = match receive_ticker(&offer) {
                Some(ticker) if payout_needs_connection(ticker) => {
                    engine_json(port, &auth, "wallets", ApiMethod::Get, None)
                        .await
                        .ok()
                        .and_then(|wallets| reported_connection(&wallets, ticker))
                }
                _ => None,
            };
            Some(payout_destination(&offer, a, connection.as_deref())?)
        }
        None => None,
    };
    let req = BidRequest {
        addr_to: destination,
        ..req
    };

    // 3. The write. Pinned path, body built here.
    let url = format!("http://127.0.0.1:{}/json/{}", port, BID_NEW_PATH);
    let resp = client
        .post(&url)
        .header("Authorization", basic_auth_header(&auth))
        .json(&build_bid_body(&req))
        .send()
        .await
        .map_err(|e| format!("the bid could not be sent to the swap node: {}", e))?;
    // Counted once the POST has gone out, whatever the reply: a reply that
    // failed to parse can still belong to a bid the node created.
    BIDS_SENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("could not read the swap node's reply: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "the swap node refused the bid (HTTP {}): {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "the swap node's reply was not JSON: {} - {}",
            e,
            text.chars().take(200).collect::<String>()
        )
    })?;
    extract_bid_id(&parsed)
}

/// The flag `js_bids` dispatches on for PWNDA-PATCH-11's recovery branch.
const BID_RECOVER_FLAG: &str = "pwndarecover";

/// What the engine concluded about a recovery attempt.
///
/// `recovered: false` is a normal, expected answer — the engine refuses rather
/// than raises when a gate is not met (the bid is not stuck, a refund already
/// owns it, there is nothing to retry) — so the caller can offer recovery
/// unconditionally and show `reason` when it was not needed.
/// Serialised to the renderer in camelCase (what every other TS binding in
/// this app expects) while still DESERIALISING the engine's snake_case reply —
/// `rename_all` covers the first, the per-field `alias` the second. One struct
/// crosses both boundaries, so it has to speak both.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverOutcome {
    pub recovered: bool,
    /// The engine's own sentence. Present on a refusal; absent on success.
    #[serde(default)]
    pub reason: Option<String>,
    /// Bid state after the call.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default, alias = "state_before")]
    pub state_before: Option<String>,
    /// Seconds until the re-queued action fires.
    #[serde(default, alias = "retry_in_seconds")]
    pub retry_in_seconds: Option<u64>,
    /// PWNDA-PATCH-27: the engine did not re-queue anything — it found the
    /// chain-A redeem already confirmed and marked the swap Completed.
    #[serde(default)]
    pub settled: Option<bool>,
    /// Confirmations the chain reported for that redeem (settled only).
    #[serde(default)]
    pub confirmations: Option<u64>,
    /// The redeem's txid (settled only).
    #[serde(default)]
    pub txid: Option<String>,
}

/// The recovery POST itself — the one call, on the BACKEND-trusted route.
///
/// # Why this does not go through `build_api_url`
///
/// `check_endpoint` refuses `POST /json/bids/<id>` on purpose: a body carrying
/// `accept`/`abandon` there calls `acceptBid`/`abandonBid`, so the RENDERER
/// must never reach it. That allow-list is a boundary around the *webview*,
/// not around this process — and the janitor, which is Rust code sending one
/// hard-coded body to a bid id it read from the engine's own list, spent every
/// sweep being refused by it:
///
/// ```text
/// Looked at 3 swap(s), 1 in Error. 00000006a…: POST /json/bids/00000006a8…
/// is not reachable through the wallet (not on the read-only allow-list)
/// ```
///
/// Which is the second shape CLAUDE.md names by name: a precondition copied
/// from a neighbouring operation is not a precondition, it is an assumption
/// about which operation you are running. The command below always built its
/// URL directly for exactly this reason; the janitor was written against the
/// generic helper and inherited a guard meant for someone else.
///
/// The allow-list is unchanged — `renderer_still_cannot_post_to_a_bid` pins
/// that it still refuses — and the body is still this module's constant, not
/// a caller's.
async fn recover_bid_call(port: u16, auth: &str, bid_id: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let url = format!("http://127.0.0.1:{}/json/bids/{}", port, bid_id);
    let resp = client
        .post(&url)
        .header("Authorization", basic_auth_header(auth))
        .json(&serde_json::json!({ BID_RECOVER_FLAG: true }))
        .send()
        .await
        .map_err(|e| format!("could not reach the swap node: {}", e))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("could not read the swap node's reply: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "the swap node refused the recovery (HTTP {}): {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    // An engine without PWNDA-PATCH-11 has no `pwndarecover` branch: it falls
    // through and answers with the ordinary bid document, which has no
    // `recovered` field. Naming that explicitly beats letting serde report a
    // missing field the user cannot act on.
    serde_json::from_str(&text)
        .map_err(|e| format!("the swap node's reply was not JSON: {}", e))
}

/// Ask the engine to restart a swap it parked in `BID_ERROR`.
///
/// # Why this is safe to expose to the renderer, unlike `bids/new`
///
/// It commits nothing. The engine-side handler (`pwndaRecoverStalledBid`,
/// PWNDA-PATCH-11) takes **no target state** from the caller — the only input
/// is which bid — and restores the one state/action pairing the engine itself
/// uses for that step, then lets `redeemXmrBidCoinALockTx`'s own guards decide
/// what actually happens. Those guards already return early if the redeem is
/// recorded or a chain-A refund exists, and PWNDA-PATCH-10 made that function
/// idempotent against an on-chain duplicate. So the worst outcome a malicious
/// caller could produce is a wasted engine tick on a bid that is already
/// stuck — not a transaction.
///
/// That is why this does NOT need `swap_sidecar_place_bid`'s re-verification
/// treatment: there is no user-visible number to substitute and no body to
/// tamper with. The bid id is the whole request.
#[tauri::command]
pub async fn swap_sidecar_recover_bid(
    sc: tauri::State<'_, SwapSidecarState>,
    bid_id: String,
) -> Result<RecoverOutcome, String> {
    if !is_bid_object_id(&bid_id) {
        return Err("that is not a valid bid id".to_string());
    }
    let (port, auth) = api_context(&sc)?;
    let parsed = recover_bid_call(port, &auth, &bid_id).await?;
    if parsed.get("recovered").is_none() {
        return Err(NO_RECOVERY_PATCH.to_string());
    }
    serde_json::from_value(parsed)
        .map_err(|e| format!("could not read the recovery result: {}", e))
}

/// What the user reads when the engine has no PWNDA-PATCH-11 branch. One
/// sentence: until 2026-10-06 it carried two runs of 14 spaces, after "patch"
/// and after the script name, where a line continuation had been lost. Found
/// while adding the read below to this file.
const NO_RECOVERY_PATCH: &str = "this swap-node runtime does not carry the recovery patch \
     (upstream/patches/0011); run `node scripts/apply-engine-patches.mjs` and restart the node";

// ═══════════════════════════════════════════════════════════════════════════
// A bid's transactions: the one read that needs the POST verb (2026-10-01)
//
// Operator request, 2026-10-01: P2P swap details should list each leg's
// transactions. For an adaptor-signature swap (any pair with XMR, ZEPH or
// ZANO) the engine lists them only on request: `describeBid` adds `txns` when
// `show_txns` is set (deployed `ui/util.py:412-486`), and only a POST to
// `bids/<id>` whose body carries `show_extra` sets it (`js_server.py:845-846`).
// The renderer reads a bid with a GET, and `check_endpoint` keeps `bids/<id>`
// GET-only on purpose: a POST body there is an ACTION (`accept`, `abandon`,
// `pwndarecover`, `debugind`, `js_server.py:821-843`), and `chainbkeysplit`
// answers with a key share (`:856-866`).
//
// So this is a door of its own, the same shape as the recovery call above: the
// path is `bids/<id>` with a 56-hex id, the body is a constant built here, and
// the renderer passes the id and nothing else. The allow-list is unchanged
// (`renderer_still_cannot_post_to_a_bid` pins that).
//
// The REPLY is filtered too. With the engine's `debug_ui` setting on (a user
// setting, off by default, `basicswap.py:479`), the same `show_txns` branch
// adds `xmr_b_half_privatekey` and `xmr_b_half_privatekey_remote`, the key
// shares of the chain-B lock (`ui/util.py:497-525`), next to the chain-B view
// key. Those are what `chainbkeysplit` is kept out of reach for, so the reply
// is cut down to an allow-list of the fields the wallet reads.

/// The flag that makes `js_bids` list a bid's transactions. Present as a key;
/// its value is not read (`have_data_entry`, `ui/util.py:76-79`).
const BID_TXNS_FLAG: &str = "show_extra";

/// The ONLY body the transactions read posts: `{"show_extra": true}`. Built
/// here; the command takes no body from the renderer, so no other key
/// (`accept`, `abandon`, `chainbkeysplit`, …) can reach the engine through it.
pub fn bid_txns_body() -> Value {
    serde_json::json!({ BID_TXNS_FLAG: true })
}

/// A bid id as the engine writes it: 28 bytes, hex (`ensure(len(bid_id) ==
/// 28)`, `js_server.py:815`). Exactly 56 hex characters, so no word (`new`)
/// and no extra path segment (`<id>/states`) can take the id's place.
pub fn is_bid_id(s: &str) -> bool {
    s.len() == 56 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The URL of one bid's record. Only ever called with a checked id.
fn bid_txns_url(port: u16, bid_id: &str) -> String {
    format!("http://127.0.0.1:{}/json/bids/{}", port, bid_id)
}

/// Top-level `describeBid` fields the transactions read hands to the renderer.
/// Everything else is dropped: the key shares above, the chain-B view key, and
/// whatever a later engine adds.
const BID_TXNS_REPLY_FIELDS: &[&str] = &[
    "offer_id",
    "coin_from",
    "coin_to",
    "ticker_from",
    "ticker_to",
    "amt_from",
    "amt_to",
    "bid_rate",
    "bid_state",
    "bid_state_ind",
    "state_description",
    "created_at_timestamp",
    "state_time_timestamp",
    "expired_at",
    "was_sent",
    "was_received",
    "reverse_bid",
    // A scripted-to-scripted swap's two locks ("<txid> <TICKER>" or "None",
    // `ui/util.py:384`). Its claims and refunds (`:538-547`) are left out:
    // with `strict_swap_type` on, the mainnet default (`basicswap.py:4021`),
    // the engine runs that protocol only for PIVX/DASH pairs, none of which
    // the wallet routes, and the wallet does not read them.
    "initiate_tx",
    "participate_tx",
    // An adaptor-signature swap's transactions, entry by entry below.
    "txns",
];

/// The fields of one `txns` entry (`ui/util.py:412-486`).
const BID_TXNS_ENTRY_FIELDS: &[&str] = &["type", "txid", "confirms"];

/// Cut the engine's reply down to [`BID_TXNS_REPLY_FIELDS`]. An `{"error": …}`
/// reply passes through as an error object, as the generic proxy passes it,
/// so the renderer's `isApiError` reads it the same way.
pub fn bid_txns_reply(v: Value) -> Result<Value, String> {
    let Some(obj) = v.as_object() else {
        return Err("the swap node's reply was not a bid record".to_string());
    };
    if let Some(err) = obj.get("error") {
        let text = err
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| err.to_string());
        return Ok(serde_json::json!({ "error": text }));
    }
    let mut out = serde_json::Map::new();
    for key in BID_TXNS_REPLY_FIELDS {
        let Some(value) = obj.get(*key) else {
            continue;
        };
        if *key == "txns" {
            let entries: Vec<Value> = value
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| row.as_object())
                        .map(|row| {
                            let mut kept = serde_json::Map::new();
                            for f in BID_TXNS_ENTRY_FIELDS {
                                if let Some(x) = row.get(*f) {
                                    kept.insert((*f).to_string(), x.clone());
                                }
                            }
                            Value::Object(kept)
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.insert("txns".to_string(), Value::Array(entries));
        } else {
            out.insert((*key).to_string(), value.clone());
        }
    }
    Ok(Value::Object(out))
}

/// The POST itself. The body is [`bid_txns_body`] and nothing else.
async fn bid_txns_call(port: u16, auth: &str, bid_id: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .post(bid_txns_url(port, bid_id))
        .header("Authorization", basic_auth_header(auth))
        .json(&bid_txns_body())
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    decode_api_response(resp).await
}

/// One bid's record WITH its transactions, for the swap history and details.
/// Read-only: the body only asks the engine to list what it already recorded.
#[tauri::command]
pub async fn swap_sidecar_bid_txns(
    sc: tauri::State<'_, SwapSidecarState>,
    bid_id: String,
) -> Result<Value, String> {
    if !is_bid_id(&bid_id) {
        return Err("that is not a valid bid id".to_string());
    }
    let (port, auth) = api_context(&sc)?;
    bid_txns_reply(bid_txns_call(port, &auth, &bid_id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const THIS_FILE: &str = include_str!("swap_bid.rs");

    fn req() -> BidRequest {
        BidRequest {
            offer_id: "ab".repeat(28),
            amount_from: "0.5".into(),
            rate: "1.4".into(),
            addr_to: Some("ltc1qexample".into()),
            valid_for_seconds: Some(3600),
        }
    }

    fn offer() -> Value {
        json!({
            "offer_id": "ab".repeat(28),
            "rate": "1.4",
            "amount_from": "2.5",
            "min_bid_amount": "0.05",
            "is_expired": false,
            "is_revoked": false,
            "is_own_offer": false,
            "expire_at": 2_000_000_000u64,
        })
    }

    // -- the pinned path ---------------------------------------------

    #[test]
    fn the_write_path_is_a_constant_not_a_parameter() {
        assert_eq!(BID_NEW_PATH, "bids/new");
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_place_bid(")
            .expect("the command must exist");
        let body = &THIS_FILE[at..];
        assert!(
            body.contains("port, BID_NEW_PATH"),
            "the bid POST must use the pinned BID_NEW_PATH constant"
        );
    }

    #[test]
    fn the_offer_is_re_read_before_the_write() {
        // Ordering is the whole control: verifying AFTER posting would be
        // theatre. Assert the verify call appears before the POST.
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_place_bid(")
            .expect("the command must exist");
        let body = &THIS_FILE[at..];
        let verify = body.find("verify_against_offer(").expect("must verify");
        let post = body.find("port, BID_NEW_PATH").expect("must post");
        assert!(
            verify < post,
            "the offer must be re-verified BEFORE the bid is posted"
        );
    }

    // -- structure ----------------------------------------------------

    #[test]
    fn rejects_a_non_hex_offer_id() {
        let mut r = req();
        r.offer_id = "../../etc/passwd".into();
        assert!(validate_bid_request(&r).is_err());
        r.offer_id = "bids/new".into();
        assert!(validate_bid_request(&r).is_err());
        r.offer_id = String::new();
        assert!(validate_bid_request(&r).is_err());
    }

    #[test]
    fn rejects_amounts_that_are_not_plain_decimals() {
        for bad in ["-1", "1e9", "0", "", "1.2.3", "abc", " 1 2 "] {
            assert!(
                parse_positive_decimal(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!((parse_positive_decimal("0.41993281").unwrap() - 0.41993281).abs() < 1e-12);
    }

    #[test]
    fn rejects_an_out_of_range_validity_window() {
        let mut r = req();
        r.valid_for_seconds = Some(59);
        assert!(validate_bid_request(&r).is_err());
        r.valid_for_seconds = Some(200_000);
        assert!(validate_bid_request(&r).is_err());
        r.valid_for_seconds = Some(3600);
        assert!(validate_bid_request(&r).is_ok());
    }

    // -- the rate pin: the control this door exists for ---------------

    #[test]
    fn accepts_a_rate_that_matches_the_offer() {
        let r = req();
        let (a, rt) = validate_bid_request(&r).unwrap();
        assert!(verify_against_offer(&r, a, rt, &offer(), 1_700_000_000).is_ok());
    }

    #[test]
    fn refuses_a_rate_that_drifted_from_the_offer() {
        // A renderer that showed 1.4 and submitted 1.6 - the attack this
        // whole module exists to stop.
        let mut r = req();
        r.rate = "1.6".into();
        let (a, rt) = validate_bid_request(&r).unwrap();
        let err = verify_against_offer(&r, a, rt, &offer(), 1_700_000_000).unwrap_err();
        assert!(err.contains("no longer matches"), "{err}");
        assert!(err.contains("Nothing was sent"), "{err}");
    }

    #[test]
    fn tolerates_drift_inside_the_window_and_refuses_just_outside_it() {
        let base = 1.4_f64;
        let inside = base * (1.0 + BID_RATE_TOLERANCE * 0.5);
        let outside = base * (1.0 + BID_RATE_TOLERANCE * 2.0);
        let r = req();
        assert!(verify_against_offer(&r, 0.5, inside, &offer(), 1_700_000_000).is_ok());
        assert!(verify_against_offer(&r, 0.5, outside, &offer(), 1_700_000_000).is_err());
    }

    // -- the offer's own bounds ---------------------------------------

    #[test]
    fn refuses_above_the_offer_size_and_below_its_minimum() {
        let r = req();
        let too_big = verify_against_offer(&r, 99.0, 1.4, &offer(), 1_700_000_000).unwrap_err();
        assert!(too_big.contains("only has"), "{too_big}");
        let too_small = verify_against_offer(&r, 0.001, 1.4, &offer(), 1_700_000_000).unwrap_err();
        assert!(too_small.contains("will not fill less than"), "{too_small}");
    }

    #[test]
    fn refuses_an_untakeable_offer() {
        for flag in ["is_expired", "is_revoked", "is_own_offer"] {
            let mut o = offer();
            o[flag] = json!(true);
            assert!(
                verify_against_offer(&req(), 0.5, 1.4, &o, 1_700_000_000).is_err(),
                "{flag} must refuse"
            );
        }
    }

    #[test]
    fn refuses_an_offer_that_expired_while_on_screen() {
        let o = offer();
        // now is PAST expire_at
        let err = verify_against_offer(&req(), 0.5, 1.4, &o, 2_000_000_001).unwrap_err();
        assert!(err.contains("expired while it was on screen"), "{err}");
    }

    #[test]
    fn refuses_an_offer_whose_rate_or_size_cannot_be_read() {
        let mut o = offer();
        o["rate"] = json!("not-a-number");
        assert!(verify_against_offer(&req(), 0.5, 1.4, &o, 1_700_000_000).is_err());
        let mut o2 = offer();
        o2.as_object_mut().unwrap().remove("amount_from");
        assert!(verify_against_offer(&req(), 0.5, 1.4, &o2, 1_700_000_000).is_err());
    }

    // -- reply parsing -------------------------------------------------

    #[test]
    fn reads_the_offer_out_of_the_one_element_array_upstream_returns() {
        let id = "ab".repeat(28);
        let arr = json!([offer()]);
        assert!(offer_from_reply(&arr, &id).is_ok());
        assert!(offer_from_reply(&json!([]), &id).is_err());
    }

    #[test]
    fn refuses_a_reply_about_a_different_offer() {
        let mut o = offer();
        o["offer_id"] = json!("cd".repeat(28));
        let err = offer_from_reply(&json!([o]), &"ab".repeat(28)).unwrap_err();
        assert!(err.contains("when asked for"), "{err}");
    }

    #[test]
    fn extracts_a_bid_id_and_refuses_a_silent_success() {
        assert_eq!(extract_bid_id(&json!({"bid_id": "beef"})).unwrap(), "beef");
        assert_eq!(extract_bid_id(&json!("beef")).unwrap(), "beef");
        let err = extract_bid_id(&json!({})).unwrap_err();
        assert!(err.contains("placed twice"), "{err}");
        assert!(extract_bid_id(&json!({"error": "nope"})).is_err());
    }

    // -- the body ------------------------------------------------------

    #[test]
    fn the_body_carries_only_the_fields_this_module_built() {
        let b = build_bid_body(&req());
        let obj = b.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "amount_from",
                "destination_address",
                "offer_id",
                "rate",
                "valid_for_seconds"
            ]
        );
    }

    /// The 2026-10-01 finding: the payout address went out as `addr_to`, a
    /// key the deployed `js_bids` never reads (it reads `destination_address`,
    /// `js_server.py:770-778`), so the engine paid its own wallet instead of
    /// the address on the confirm screen.
    #[test]
    fn the_payout_address_is_sent_in_the_field_the_engine_reads() {
        let mut r = req();
        r.addr_to = Some(" ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh ".into());
        let b = build_bid_body(&r);
        assert_eq!(
            b.get("destination_address").and_then(|v| v.as_str()),
            Some("ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh")
        );
        assert!(
            b.get("addr_to").is_none(),
            "addr_to is ignored by the engine; sending it only looks like setting the payout"
        );
    }

    #[test]
    fn omits_an_absent_payout_address_rather_than_sending_empty() {
        let mut r = req();
        r.addr_to = Some("   ".into());
        let b = build_bid_body(&r);
        assert!(b.get("destination_address").is_none());
        assert!(b.get("addr_to").is_none());
        r.addr_to = None;
        let b = build_bid_body(&r);
        assert!(b.get("destination_address").is_none());
        assert!(b.get("addr_to").is_none());
    }

    // -- the payout address: forms the engine pays as written ------------
    //
    // Vectors: the world-public test seed ("abandon … about") for the
    // bitcoin family, invented CryptoNote keys (G and 2G) encoded with the
    // wallet's own encoders for XMR/ZEPH/ZANO, and BIP173/BIP86's published
    // examples. `payoutDestination.test.ts` runs the same list.

    fn offer_buying(coin: &str) -> Value {
        json!({ "offer_id": "ab".repeat(28), "swap_type": 5, "coin_from": coin, "coin_to": "Monero" })
    }

    /// The form tests run on the connection that lets every coin through, so
    /// the address form is the only thing they test (the connection rule has
    /// its own tests below).
    const ELECTRUM: Option<&str> = Some("electrum");

    const PAYS_AS_WRITTEN: &[(&str, &str)] = &[
        ("Bitcoin", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
        ("Litecoin", "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh"),
        ("Bitcoin Cash", "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"),
        ("Dogecoin", "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC"),
        ("Dash", "XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5"),
        ("Monero", "44yQXfkWZNmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJCAof7pyUai3Q68xyoie3ASK9sBTXNue95yhG7PE7RLs4rqwDTA"),
        ("Monero", "85oYs3QM9oBJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJCAof7pyUai3Q68xyoie3ASK9sBTXNue95yhG7PE7RLs4rdEtwF"),
        ("Zephyr", "ZEPHYR2gFxHJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfG5oMhJqwM8VTD26sHnCRtxD4nc9amkwQQ4KPqC2fYvAUdc59X3p"),
        ("Zephyr", "ZEPHs92AsZfJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRhndvPBW9giPpPRWyZEZNx1oihwAQfsH48NwuPEYhnBrmBZPkm9"),
        ("Zano", "ZxCUF69qnXfJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ8RXqxM5RWMGuAR2uvk8dcAdhyEt5LtNRU7jNspTdSp41pscRv83C"),
    ];

    const PAID_ELSEWHERE_OR_REFUSED: &[(&str, &str)] = &[
        // Legacy P2PKH: paid as the P2WPKH of the same hash, not this address.
        ("Bitcoin", "1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso"),
        ("Litecoin", "LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez"),
        // P2SH: a script hash paid as a pubkey hash, which no key can spend.
        ("Bitcoin", "3GtVZYzsKF6Feikdjd4bDyPdAiyeHANY9b"),
        ("Litecoin", "MUi6eFEWq7Sj3XaWUzJTDvSFTpaSdDR3fq"),
        ("Bitcoin Cash", "bitcoincash:pqyx49mu0kkn9ftfj6hje6g2wfer34yfnqrwqc8jm8"),
        ("Dogecoin", "9yD3AjCTjHyHvs4chBsGMz3DNPshJXyL3i"),
        ("Dash", "7f1y4KLkmCjUfLy3RP4oWqiq5cBxRWfP62"),
        // P2WSH and taproot: refused by `isValidSwapDest`.
        ("Bitcoin", "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"),
        ("Bitcoin", "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"),
        ("Litecoin", "ltc1qqurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurselq749"),
        // Uppercase bech32: the engine's prefix test is case-sensitive.
        ("Bitcoin", "BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU"),
        // CashAddr without its prefix: "Cash address is missing prefix".
        ("Bitcoin Cash", "qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"),
        // Integrated / auditable: refused by the coin's `isValidAddress`.
        ("Monero", "4Eg5YUa1AeHJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJCAof7pyUai3Q68xyoie3ASK9sBTXNue95yhG7PE7RLs6gqsUSqmg6b14AJGrE"),
        ("Zano", "aZxb1EVcyvmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgcreQvwwCmh1mHADqPe3YhfxfRoJs1Gq4YyNFZBA28nQNxY9SY4"),
        ("Zano", "iZ1xNPFPrayJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ8RXqxM5RWMGuAR2uvk8dcAdhyEt5LtNRU7jNspTdSp4H5cJg5vSXu91115AmrYn"),
        // Another coin's address.
        ("Litecoin", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
        ("Zephyr", "44yQXfkWZNmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJCAof7pyUai3Q68xyoie3ASK9sBTXNue95yhG7PE7RLs4rqwDTA"),
    ];

    #[test]
    fn payout_forms_the_engine_pays_as_written_are_sent() {
        for (coin, addr) in PAYS_AS_WRITTEN {
            assert_eq!(
                payout_destination(&offer_buying(coin), addr, ELECTRUM).as_deref(),
                Ok(*addr),
                "{coin}: {addr}"
            );
        }
    }

    #[test]
    fn payout_forms_the_engine_would_pay_elsewhere_are_refused() {
        for (coin, addr) in PAID_ELSEWHERE_OR_REFUSED {
            let err = payout_destination(&offer_buying(coin), addr, ELECTRUM)
                .expect_err(&format!("{coin}: {addr} must be refused"));
            assert!(err.contains("Nothing was sent"), "{coin}: {err}");
        }
    }

    #[test]
    fn a_payout_address_on_a_non_adaptor_offer_is_refused() {
        // SELLER_FIRST (1): `postBid` reads no destination at all.
        let mut o = offer_buying("Litecoin");
        o["swap_type"] = json!(1);
        assert!(payout_destination(&o, "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh", ELECTRUM).is_err());
        o.as_object_mut().unwrap().remove("swap_type");
        assert!(payout_destination(&o, "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh", ELECTRUM).is_err());
    }

    #[test]
    fn a_payout_address_for_a_coin_with_no_rule_is_refused() {
        assert!(payout_destination(&offer_buying("Particl"), "Pinvented00000000000000000000000000", ELECTRUM).is_err());
    }

    #[test]
    fn the_coin_bought_is_the_offers_coin_from_as_the_engine_names_it() {
        for (name, ticker) in [
            ("Bitcoin", "BTC"),
            ("Litecoin", "LTC"),
            ("Bitcoin Cash", "BCH"),
            ("Dogecoin", "DOGE"),
            ("Dash", "DASH"),
            ("Monero", "XMR"),
            ("Zephyr", "ZEPH"),
            ("Zano", "ZANO"),
        ] {
            assert_eq!(receive_ticker(&offer_buying(name)), Some(ticker), "{name}");
        }
        assert_eq!(receive_ticker(&offer_buying("Particl")), None);
        assert_eq!(receive_ticker(&json!({})), None);
    }

    #[test]
    fn every_payout_shape_compiles_and_names_its_coin_once() {
        let mut seen = std::collections::HashSet::new();
        for (ticker, pattern) in PAYOUT_ADDRESS_SHAPES {
            assert!(regex::Regex::new(pattern).is_ok(), "{ticker}: {pattern}");
            assert!(seen.insert(*ticker), "{ticker} appears twice");
            assert!(pattern.starts_with('^') && pattern.ends_with('$'), "{ticker} must be anchored");
        }
    }

    #[test]
    fn the_payout_is_checked_against_the_engines_offer_before_the_write() {
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_place_bid(")
            .expect("the command must exist");
        let body = &THIS_FILE[at..];
        let verify = body.find("verify_against_offer(").expect("must verify the offer");
        let check = body.find("payout_destination(&offer").expect("must check the payout");
        let post = body.find("port, BID_NEW_PATH").expect("must post");
        assert!(verify < check && check < post, "the payout must be checked BEFORE the bid is posted");
    }

    // -- ...and only where the node can follow it (2026-10-06) ------------

    fn sent_for(coins: &[&str]) -> Vec<(&'static str, &'static str)> {
        PAYS_AS_WRITTEN
            .iter()
            .filter(|(c, _)| coins.contains(c))
            .copied()
            .collect()
    }

    /// BTC, LTC and BCH: PATCH-27's settle re-reads this node's chain-A redeem,
    /// which an electrum backend finds whatever it pays.
    #[test]
    fn an_electrum_coin_still_sends_the_address() {
        for (coin, addr) in sent_for(&["Bitcoin", "Litecoin", "Bitcoin Cash"]) {
            assert_eq!(
                payout_destination(&offer_buying(coin), addr, Some("electrum")).as_deref(),
                Ok(addr),
                "{coin}"
            );
        }
    }

    /// The same coins on a full node (RPC, no txindex), and DOGE and DASH,
    /// which have nothing else: no outside address, and not when the node did
    /// not say either.
    #[test]
    fn a_coin_on_a_full_node_without_txindex_is_not_sent_to_an_outside_address() {
        for (coin, addr) in sent_for(&["Bitcoin", "Litecoin", "Bitcoin Cash", "Dogecoin", "Dash"]) {
            for connection in [Some("rpc"), Some("none"), None] {
                let err = payout_destination(&offer_buying(coin), addr, connection)
                    .expect_err(&format!("{coin} on {connection:?} must not be sent"));
                assert!(err.contains("Nothing was sent"), "{coin}: {err}");
            }
        }
    }

    /// The engine completes a reversed bid paying an outside address when the
    /// redeem is submitted (`basicswap.py:14262-14268`) and never reads it
    /// again, so the connection does not decide anything for these.
    #[test]
    fn xmr_zeph_and_zano_payouts_do_not_depend_on_the_connection() {
        let coins = sent_for(&["Monero", "Zephyr", "Zano"]);
        assert_eq!(coins.len(), 5);
        for (coin, addr) in coins {
            for connection in [Some("rpc"), Some("electrum"), Some("none"), None] {
                assert_eq!(
                    payout_destination(&offer_buying(coin), addr, connection).as_deref(),
                    Ok(addr),
                    "{coin} on {connection:?}"
                );
            }
        }
    }

    #[test]
    fn the_door_asks_the_node_only_where_the_rule_depends_on_it() {
        for t in ["BTC", "LTC", "BCH", "DOGE", "DASH"] {
            assert!(payout_needs_connection(t), "{t}");
        }
        for t in ["XMR", "ZEPH", "ZANO"] {
            assert!(!payout_needs_connection(t), "{t}");
        }
    }

    #[test]
    fn every_payout_coin_has_a_connection_rule() {
        let shapes: Vec<&str> = PAYOUT_ADDRESS_SHAPES.iter().map(|(t, _)| *t).collect();
        let rules: Vec<&str> = PAYOUT_CONNECTION_REQUIRED.iter().map(|(t, _)| *t).collect();
        assert_eq!(shapes, rules);
        for (t, need) in PAYOUT_CONNECTION_REQUIRED {
            assert!(["electrum", "any"].contains(need), "{t}: {need}");
        }
    }

    /// `/json/wallets` is ticker-keyed; a coin that failed is `{name, error}`
    /// and a node that failed altogether answers `{error}`.
    #[test]
    fn the_connection_is_the_running_engines_own_report() {
        let wallets = json!({
            "LTC": { "balance": "0.1", "connection_type": "electrum" },
            "BTC": { "balance": "0", "connection_type": "rpc" },
            "DOGE": { "name": "Dogecoin", "error": "Timeout" },
        });
        assert_eq!(reported_connection(&wallets, "LTC").as_deref(), Some("electrum"));
        assert_eq!(reported_connection(&wallets, "BTC").as_deref(), Some("rpc"));
        assert_eq!(reported_connection(&wallets, "DOGE"), None);
        assert_eq!(reported_connection(&wallets, "BCH"), None);
        assert_eq!(reported_connection(&json!({ "error": "Wallet is locked" }), "LTC"), None);
    }

    #[test]
    fn the_payout_connection_is_read_from_the_node_before_the_write() {
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_place_bid(")
            .expect("the command must exist");
        let body = &THIS_FILE[at..];
        let body = &body[..body.find("const BID_RECOVER_FLAG").expect("the next item")];
        let verify = body.find("verify_against_offer(").expect("must verify the offer");
        let read = body
            .find("\"wallets\", ApiMethod::Get")
            .expect("must read the node's own report of how it reaches the coin");
        let check = body.find("payout_destination(&offer").expect("must check the payout");
        let post = body.find("port, BID_NEW_PATH").expect("must post");
        assert!(
            verify < read && read < check && check < post,
            "the node must be asked after the offer is verified and before the payout is checked"
        );
    }

    // -- the transactions read (2026-10-01) -----------------------------

    #[test]
    fn the_txns_read_posts_exactly_show_extra() {
        assert_eq!(
            serde_json::to_string(&bid_txns_body()).unwrap(),
            r#"{"show_extra":true}"#
        );
    }

    #[test]
    fn the_txns_read_takes_nothing_but_a_bid_id_from_the_renderer() {
        // The command's parameters: the state and the id. No body, no path.
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_bid_txns(")
            .expect("the command must exist");
        let sig_end = at + THIS_FILE[at..].find(") -> Result<Value, String>").unwrap();
        let params: Vec<&str> = THIS_FILE[at + "pub async fn swap_sidecar_bid_txns(".len()..sig_end]
            .lines()
            .map(|p| p.trim().trim_end_matches(','))
            .filter(|p| !p.is_empty())
            .collect();
        assert_eq!(
            params,
            vec!["sc: tauri::State<'_, SwapSidecarState>", "bid_id: String"]
        );
        // The one POST: its body is the constant above and nothing else.
        let call = THIS_FILE
            .find("async fn bid_txns_call(")
            .expect("the call must exist");
        let call_end = call + THIS_FILE[call..].find("decode_api_response(resp)").unwrap();
        let body = &THIS_FILE[call..call_end];
        assert_eq!(body.matches(".json(").count(), 1);
        assert!(body.contains(".json(&bid_txns_body())"));
    }

    #[test]
    fn the_txns_read_takes_a_56_hex_bid_id_only() {
        let id = "0123456789abcdefABCDEF0123456789abcdef0123456789abcdef01";
        assert_eq!(id.len(), 56);
        assert!(is_bid_id(id));
        let bad: Vec<String> = vec![
            String::new(),
            "new".to_string(),
            id[..55].to_string(),
            format!("{id}0"),
            format!("{}g", &id[..55]),
            format!("{id}/states"),
            "../../../json/getcoinseed/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        ];
        for b in &bad {
            assert!(!is_bid_id(b), "{b:?} must be refused");
        }
        assert_eq!(
            bid_txns_url(11700, id),
            format!("http://127.0.0.1:11700/json/bids/{id}")
        );
    }

    #[test]
    fn the_txns_reply_keeps_txids_and_drops_key_shares() {
        // `describeBid(..., show_txns=True)` with `debug_ui` on: the shape of
        // `ui/util.py:353-525`, invented values.
        let reply = json!({
            "offer_id": "aa".repeat(28),
            "coin_from": "Litecoin",
            "coin_to": "Monero",
            "ticker_from": "LTC",
            "ticker_to": "XMR",
            "amt_from": "0.24650000",
            "amt_to": "0.025000000000",
            "bid_state": "Completed",
            "bid_state_ind": 8,
            "state_time_timestamp": 1_790_000_000u64,
            "was_sent": true,
            "was_received": null,
            "reverse_bid": false,
            "addr_from": "pwndaSandboxBidderAddr",
            "events": [{ "at": 1, "desc": "Bid sent" }],
            "show_txns": true,
            "txns": [
                { "type": "Chain A Lock", "txid": "11".repeat(32), "confirms": 5, "extra": "x" },
                { "type": "Chain B Lock", "txid": "22".repeat(32), "confirms": null },
                "not an object",
            ],
            "xmr_b_shared_address": "4shared",
            "xmr_b_shared_viewkey": "view-key",
            "xmr_b_half_privatekey": "KEY-SHARE",
            "xmr_b_half_privatekey_remote": "REMOTE-KEY-SHARE",
            "debug_ind": 0,
        });
        let out = bid_txns_reply(reply).unwrap();
        let text = out.to_string();
        for secret in ["KEY-SHARE", "view-key", "4shared"] {
            assert!(!text.contains(secret), "{secret} must not reach the renderer: {text}");
        }
        for dropped in ["addr_from", "events", "show_txns", "debug_ind"] {
            assert!(out.get(dropped).is_none(), "{dropped} is not on the allow-list");
        }
        assert_eq!(out["bid_state_ind"], json!(8));
        assert_eq!(out["was_sent"], json!(true));
        assert_eq!(
            out["txns"],
            json!([
                { "type": "Chain A Lock", "txid": "11".repeat(32), "confirms": 5 },
                { "type": "Chain B Lock", "txid": "22".repeat(32), "confirms": null },
            ])
        );
    }

    #[test]
    fn an_error_reply_passes_through_as_an_error_object() {
        assert_eq!(
            bid_txns_reply(json!({ "error": "Unknown bid id" })).unwrap(),
            json!({ "error": "Unknown bid id" })
        );
        assert!(bid_txns_reply(json!(["not", "a", "record"])).is_err());
    }

    #[test]
    fn the_recovery_refusal_reads_as_one_sentence() {
        assert!(!NO_RECOVERY_PATCH.contains("  "), "{NO_RECOVERY_PATCH:?}");
        assert!(NO_RECOVERY_PATCH.contains("patch (upstream/patches/0011); run"));
        // And the source no longer carries the run of spaces the old inline
        // literal had (the needle is built, so this file cannot match itself).
        let gap = format!("patch{}(upstream", " ".repeat(14));
        assert!(!THIS_FILE.contains(&gap));
    }

    // -- the generic proxy stays shut ----------------------------------

    #[test]
    fn this_module_does_not_reopen_the_generic_proxy() {
        // The whole premise: bids/new is reachable ONLY through this command.
        // If someone later "simplifies" it by routing through the generic
        // pass-through, this fails.
        // Scoped to the command BODY and to CALL syntax on purpose: the
        // module doc names the generic proxy (explaining why this door does
        // not use it), and a naive whole-file `contains` matched that prose
        // and could never pass — a check that fails for a reason unrelated to
        // the property it guards is worse than no check.
        let at = THIS_FILE
            .find("pub async fn swap_sidecar_place_bid(")
            .expect("the command must exist");
        let end = at + THIS_FILE[at..]
            .find("
#[cfg(test)]")
            .expect("the command must be followed by the test module");
        let body = &THIS_FILE[at..end];
        assert!(
            !body.contains("swap_sidecar_api_post("),
            "the bid door must not delegate to the generic API proxy"
        );
        assert!(
            !body.contains("api_post_privileged("),
            "the bid door must not borrow swap_bridge's wallets/<T>/<verb> door either"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// The bid janitor (2026-09-04)
//
// Why it exists: the 2026-08-23 mainnet swap settled on chain within the hour
// and stayed the console's one "Swap in Progress" (status Error) for twelve
// days. The engine parks a bid in BID_ERROR and never re-examines it; the
// wallet's tracker had a "Restart this swap" button (PWNDA-PATCH-11) that
// nobody found, and even that button could only re-queue a redeem the chain
// had already confirmed — it could not CLOSE the bid. PWNDA-PATCH-27 gives
// the engine a settle path for exactly that case; this janitor is what calls
// it without anyone having to.
//
// What it does, and does not do:
//   * reads `sentbids` (the taker's own swaps — the only ones this wallet
//     places) and picks the rows whose `bid_state` is "Error";
//   * POSTs the same idempotent `pwndarecover` the button sends, at most
//     `JANITOR_MAX_REQUEUES` times per bid per app session (a settle is
//     final; a re-queue that keeps failing is left to the operator after
//     that, rather than retried every ten minutes forever);
//   * never abandons, never chooses a state, never touches the maker's half
//     of the book (`bids`), and sends nothing on chain — the engine's own
//     guards decide, as they do for the button;
//   * reports what it did on the `swap-sidecar-janitor` event and in the
//     supervisor log, so a cleaned-up swap is visible rather than silently
//     different the next time the tracker polls.
// ═══════════════════════════════════════════════════════════════════════════

/// The event the janitor emits after every sweep that looked at anything.
pub const JANITOR_EVENT: &str = "swap-sidecar-janitor";
/// Seconds after the node turns healthy before the first sweep — the engine
/// is still loading bids and wallets in that window.
pub const JANITOR_FIRST_DELAY: Duration = Duration::from_secs(45);
/// Cadence after that. A swap leg is 30–90 minutes; there is nothing to gain
/// from polling harder.
pub const JANITOR_PERIOD: Duration = Duration::from_secs(600);

/// While the node's wallet is locked the janitor retries this often instead of
/// waiting a whole period, so the first real sweep lands soon after unlock.
pub const JANITOR_LOCKED_RETRY: Duration = Duration::from_secs(60);

/// The error `run_bid_janitor_once` returns when the node refuses because its
/// wallet is still locked (`{"error": …, "locked": true}`) — boot, not a fault.
pub const JANITOR_LOCKED: &str = "the swap wallet is locked";
/// How often the loop looks at the node's phase between sweeps.
const JANITOR_IDLE_POLL: Duration = Duration::from_secs(20);
/// Automatic re-queues per bid per app session before the janitor leaves a
/// bid to the operator. A settle (PATCH-27) ends the bid, so it never counts.
pub const JANITOR_MAX_REQUEUES: u32 = 3;
/// The engine's label for `BidStates.BID_ERROR` on the list payloads
/// (`strBidState`, basicswap_util.py).
pub const BID_STATE_ERROR_LABEL: &str = "Error";

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JanitorSettled {
    pub bid_id: String,
    pub txid: Option<String>,
    pub confirmations: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JanitorLeft {
    pub bid_id: String,
    pub reason: String,
}

/// One sweep's outcome. Every list is bid ids from `sentbids`.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JanitorReport {
    /// Unix seconds.
    pub at: u64,
    /// Rows on `sentbids`.
    pub scanned: usize,
    /// Rows whose state was "Error" — the candidates.
    pub errored: usize,
    /// Bids PATCH-27 marked Completed.
    pub settled: Vec<JanitorSettled>,
    /// Bids PATCH-11 re-queued (the engine will retry the claim).
    pub requeued: Vec<String>,
    /// Bids the engine declined to touch, with its own sentence.
    pub left: Vec<JanitorLeft>,
    /// Bids skipped because this session already re-queued them
    /// `JANITOR_MAX_REQUEUES` times.
    pub capped: Vec<String>,
}

/// Which rows a sweep acts on. Pure, so the label matching is testable
/// without a node: the list payload spells the state as a display string.
pub fn janitor_candidates(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter(|r| {
            r.get("bid_state")
                .and_then(|s| s.as_str())
                .map(|s| s.trim() == BID_STATE_ERROR_LABEL)
                .unwrap_or(false)
        })
        .filter_map(|r| r.get("bid_id").and_then(|s| s.as_str()))
        .filter(|id| is_bid_object_id(id))
        .map(|id| id.to_string())
        .collect()
}

async fn engine_json(
    port: u16,
    password: &str,
    path: &str,
    method: ApiMethod,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = build_api_url(port, path, method)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;
    let req = match method {
        ApiMethod::Get => client.get(&url),
        ApiMethod::Post => client.post(&url).json(&body.unwrap_or_else(|| serde_json::json!({}))),
    };
    let resp = req
        .header("Authorization", basic_auth_header(password))
        .send()
        .await
        .map_err(|e| format!("could not reach the swap node: {e}"))?;
    decode_api_response(resp).await
}

/// One sweep. Returns `Err` only when the node could not be read at all; a
/// bid the engine declines is a row in `left`, not an error.
pub async fn run_bid_janitor_once(
    app: &AppHandle,
    requeues: &mut HashMap<String, u32>,
) -> Result<JanitorReport, String> {
    let state = app.state::<SwapSidecarState>();
    let (port, password) = api_context(&state)?;
    let sweep = engine_json(port, &password, "sentbids", ApiMethod::Post, None).await?;
    if sweep.get("locked").and_then(|v| v.as_bool()) == Some(true) {
        return Err(JANITOR_LOCKED.to_string());
    }
    let rows = sweep
        .as_array()
        .cloned()
        .ok_or_else(|| format!("sentbids did not return a list: {}", sweep))?;
    let mut report = JanitorReport {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        scanned: rows.len(),
        ..Default::default()
    };
    let candidates = janitor_candidates(&rows);
    report.errored = candidates.len();
    for bid_id in candidates {
        let tries = requeues.get(&bid_id).copied().unwrap_or(0);
        if tries >= JANITOR_MAX_REQUEUES {
            report.capped.push(bid_id);
            continue;
        }
        // The trusted route, NOT `engine_json`: the renderer allow-list
        // refuses a POST to a bid, and it is right to — but it is a boundary
        // around the webview, and this is the wallet's own janitor. See
        // `recover_bid_call`.
        let reply = match recover_bid_call(port, &password, &bid_id).await {
            Ok(v) => v,
            Err(e) => {
                report.left.push(JanitorLeft { bid_id, reason: e });
                continue;
            }
        };
        if reply.get("recovered").is_none() {
            report.left.push(JanitorLeft {
                bid_id,
                reason: "this swap-node runtime does not carry the recovery patch (upstream/patches/0011)".to_string(),
            });
            continue;
        }
        let outcome: RecoverOutcome = match serde_json::from_value(reply) {
            Ok(o) => o,
            Err(e) => {
                report.left.push(JanitorLeft { bid_id, reason: format!("unreadable reply: {e}") });
                continue;
            }
        };
        if outcome.settled == Some(true) {
            supervisor_log(
                app,
                &format!(
                    "janitor: bid {} settled — chain-A redeem {} confirmed x{}",
                    bid_id,
                    outcome.txid.as_deref().unwrap_or("?"),
                    outcome.confirmations.unwrap_or(0)
                ),
            );
            report.settled.push(JanitorSettled {
                bid_id,
                txid: outcome.txid,
                confirmations: outcome.confirmations,
            });
        } else if outcome.recovered {
            *requeues.entry(bid_id.clone()).or_insert(0) += 1;
            supervisor_log(
                app,
                &format!(
                    "janitor: bid {} re-queued (attempt {} of {})",
                    bid_id,
                    tries + 1,
                    JANITOR_MAX_REQUEUES
                ),
            );
            report.requeued.push(bid_id);
        } else {
            let reason = outcome
                .reason
                .unwrap_or_else(|| "the swap node declined without a reason".to_string());
            supervisor_log(app, &format!("janitor: bid {} left alone — {}", bid_id, reason));
            report.left.push(JanitorLeft { bid_id, reason });
        }
    }
    if report.errored > 0 {
        let _ = app.emit(JANITOR_EVENT, &report);
    }
    Ok(report)
}

/// Runs a sweep `JANITOR_FIRST_DELAY` after every healthy transition and every
/// `JANITOR_PERIOD` while the node stays healthy. Self-driving by design, like
/// the fee watcher: a stuck swap must not depend on a screen being open.
pub fn spawn_bid_janitor(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut healthy_since: Option<Instant> = None;
        let mut last_sweep: Option<Instant> = None;
        // Locked-wallet spell: said once, and the first-sweep report is kept
        // for the first sweep that actually ran.
        let mut locked = false;
        let mut reported_first = false;
        let mut requeues: HashMap<String, u32> = HashMap::new();
        let mut unpark_backoff: HashMap<String, UnparkBackoff> = HashMap::new();
        let mut unlock_gen = unpark_unlock_gen();
        // The swaps-in-progress reading a locked app shows
        // (`swap_sidecar::SwapsLastSeen`): read every 2 minutes while healthy,
        // written when it changes and at least every 15 minutes, so its time
        // stays honest.
        const SWAPS_LAST_SEEN_PERIOD: Duration = Duration::from_secs(120);
        const SWAPS_LAST_SEEN_REFRESH: Duration = Duration::from_secs(900);
        let mut swaps_read_at: Option<Instant> = None;
        let mut swaps_written: Option<(u32, Instant)> = None;
        supervisor_log(&app, "janitor: watcher started");
        loop {
            tokio::time::sleep(JANITOR_IDLE_POLL).await;
            let healthy = {
                let state = app.state::<SwapSidecarState>();
                api_context(&state).is_ok()
            };
            if !healthy {
                // A restart request that was out when the node went down was
                // acted on.
                for b in unpark_backoff.values_mut() {
                    b.on_node_down();
                }
                healthy_since = None;
                last_sweep = None;
                reported_first = false;
                locked = false;
                continue;
            }
            let gen = unpark_unlock_gen();
            if gen != unlock_gen {
                unlock_gen = gen;
                for b in unpark_backoff.values_mut() {
                    b.on_unlock();
                }
            }
            if healthy_since.is_none() {
                // Diagnostics (2026-09-05): a run whose node was healthy for
                // four minutes produced no janitor line at all, and nothing
                // could say whether the loop saw the node, started a sweep, or
                // hung inside one. Every step now leaves a line.
                supervisor_log(
                    &app,
                    &format!(
                        "janitor: node healthy — first sweep in {}s, unpark checks from {}s",
                        JANITOR_FIRST_DELAY.as_secs(),
                        UNPARK_SETTLE.as_secs()
                    ),
                );
            }
            let since = *healthy_since.get_or_insert_with(Instant::now);
            // The unpark watcher rides this loop: once the node has settled,
            // a parked host-wallet coin whose wallet is now up gets the node
            // restarted (through the frontend, which holds the wallet key).
            if since.elapsed() >= UNPARK_SETTLE {
                match unpark_tick(&app, &mut unpark_backoff).await {
                    Ok(Some(_)) => {
                        // Skip this round's sweep. If the app acts on the
                        // request, the node leaves Healthy and this loop resets
                        // itself. Nothing is reset here: a locked app never
                        // acts, and resetting after every unheard request would
                        // re-log "node healthy" and re-run the first sweep each
                        // time. `unpark_tick` has already logged the request.
                        continue;
                    }
                    Ok(None) => {}
                    Err(e) => supervisor_log(&app, &format!("unpark: check skipped — {e}")),
                }
            }
            // The reading a locked app shows. A failed read (the engine is
            // locked, or slow) keeps the previous reading: a count that could
            // not be read is not zero.
            if swaps_read_at.map_or(true, |t| t.elapsed() >= SWAPS_LAST_SEEN_PERIOD) {
                swaps_read_at = Some(Instant::now());
                let count = {
                    let state = app.state::<SwapSidecarState>();
                    crate::swap_sidecar::swaps_in_progress_now(&state).await
                };
                if let Ok(n) = count {
                    let n = u32::try_from(n).unwrap_or(u32::MAX);
                    let due = swaps_written.map_or(true, |(last, at)| {
                        last != n || at.elapsed() >= SWAPS_LAST_SEEN_REFRESH
                    });
                    if due && crate::swap_sidecar::write_swaps_last_seen(&app, n).is_ok() {
                        swaps_written = Some((n, Instant::now()));
                    }
                }
            }
            if since.elapsed() < JANITOR_FIRST_DELAY {
                continue;
            }
            if let Some(t) = last_sweep {
                if t.elapsed() < JANITOR_PERIOD {
                    continue;
                }
            }
            let first_sweep = !reported_first;
            last_sweep = Some(Instant::now());
            if !locked {
                supervisor_log(&app, "janitor: sweep starting (POST /json/sentbids)");
            }
            let result = run_bid_janitor_once(&app, &mut requeues).await;
            if matches!(&result, Err(e) if e == JANITOR_LOCKED) {
                if !locked {
                    supervisor_log(
                        &app,
                        "janitor: the swap wallet is locked — sweeps resume once it is unlocked",
                    );
                    locked = true;
                }
                // Retry in a minute, not a period.
                last_sweep = Instant::now()
                    .checked_sub(JANITOR_PERIOD.saturating_sub(JANITOR_LOCKED_RETRY));
                continue;
            }
            if locked {
                supervisor_log(&app, "janitor: the swap wallet is unlocked — sweeping");
                locked = false;
            }
            reported_first = true;
            match result {
                // The first sweep after a healthy transition is logged even when
                // it found nothing: "the janitor saw N bids and none in Error" is
                // the answer to "why is my old error swap still active", and a
                // silent no-op cannot give it (2026-09-04).
                Ok(r) if r.errored == 0 => {
                    if first_sweep {
                        supervisor_log(
                            &app,
                            &format!("janitor: first sweep — {} bid(s) on sentbids, none in Error", r.scanned),
                        );
                    }
                }
                Ok(r) => eprintln!(
                    "[swap-sidecar] janitor: {} bid(s) in Error of {} — settled {}, re-queued {}, left {}, capped {}",
                    r.errored,
                    r.scanned,
                    r.settled.len(),
                    r.requeued.len(),
                    r.left.len(),
                    r.capped.len()
                ),
                Err(e) => eprintln!("[swap-sidecar] janitor: sweep skipped — {e}"),
            }
        }
    });
}

/// The same sweep, on demand — for a "clean up now" affordance and for
/// checking what the automatic one would do. Re-queue caps are per call
/// here (a fresh map), so a manual run can retry what the loop capped.
#[tauri::command]
pub async fn swap_sidecar_janitor_run(app: AppHandle) -> Result<JanitorReport, String> {
    let mut requeues = HashMap::new();
    run_bid_janitor_once(&app, &mut requeues).await
}

#[cfg(test)]
mod janitor_tests {
    use super::*;
    use serde_json::json;

    /// This module's own copy — `THIS_FILE` belongs to the module above and
    /// is not in scope here. Same device, same reason: some invariants are
    /// about WHICH function a path calls, and only the source can say.
    const SOURCE: &str = include_str!("swap_bid.rs");

    const ID: &str = "000000006a8b2e0000000000000000000000000000000000000000000000";

    #[test]
    fn candidates_are_error_rows_with_a_real_bid_id() {
        // Pins D-36 (defect register): the janitor re-examines Error bids.
        let rows = vec![
            json!({"bid_id": ID, "bid_state": "Error"}),
            json!({"bid_id": ID, "bid_state": "Completed"}),
            json!({"bid_id": ID, "bid_state": " Error "}),
            json!({"bid_id": "nope", "bid_state": "Error"}),
            json!({"bid_state": "Error"}),
            json!({"bid_id": ID}),
        ];
        assert_eq!(janitor_candidates(&rows), vec![ID.to_string(), ID.to_string()]);
    }

    /// The label is the engine's display string, not a state number: the list
    /// payload has never carried `bid_state_ind` (the fee watcher learned that
    /// the hard way, 2026-09-02).
    #[test]
    fn the_label_is_upstreams_display_string() {
        assert_eq!(BID_STATE_ERROR_LABEL, "Error");
        let rows = vec![json!({"bid_id": ID, "bid_state": 23})];
        assert!(janitor_candidates(&rows).is_empty(), "a number is not the label");
    }

    #[test]
    fn a_settled_reply_carries_the_patch_27_fields() {
        let v = json!({
            "recovered": true, "settled": true, "state_before": "Error",
            "state": "Completed", "confirmations": 1710, "txid": "4e08"
        });
        let o: RecoverOutcome = serde_json::from_value(v).unwrap();
        assert_eq!(o.settled, Some(true));
        assert_eq!(o.confirmations, Some(1710));
        assert_eq!(o.txid.as_deref(), Some("4e08"));
        assert_eq!(o.state_before.as_deref(), Some("Error"));
    }

    /// A PATCH-11 reply (no `settled`) still parses — the janitor must not
    /// mistake an older engine's re-queue for a settle.
    #[test]
    fn a_requeue_reply_is_not_a_settle() {
        let v = json!({"recovered": true, "state_before": "Error", "state": "Lock released", "retry_in_seconds": 5});
        let o: RecoverOutcome = serde_json::from_value(v).unwrap();
        assert!(o.recovered);
        assert_eq!(o.settled, None);
    }

    /// The sweep's recovery POST must NOT go through the renderer allow-list.
    ///
    /// The 2026-09-05 incident: `run_bid_janitor_once` called `engine_json`,
    /// which builds its URL with `build_api_url` → `check_endpoint`, which
    /// refuses `POST bids/<id>`. Every sweep therefore reported the stalled
    /// bid as `left`, with the allow-list's own sentence as the reason, and
    /// the Error swap the janitor exists to clear survived four weeks of
    /// them. Source-level, in the style of
    /// `the_write_path_is_a_constant_not_a_parameter`, because the failure is
    /// *which function is called*, and no unit test with a live node in it
    /// would be run often enough to catch it.
    #[test]
    fn the_janitor_recovers_through_the_trusted_call_not_the_allow_list() {
        // Pins D-58 (defect register): recovery bypasses the renderer allow-list.
        let body = &SOURCE[SOURCE
            .find("pub async fn run_bid_janitor_once(")
            .expect("janitor moved")..];
        let body = &body[..body.find("\n/// Runs a sweep").expect("janitor end moved")];
        assert!(
            body.contains("recover_bid_call(port, &password, &bid_id)"),
            "the sweep must recover through the trusted call"
        );
        // The sweep still has exactly ONE allow-listed call: the `sentbids`
        // list, which upstream reads filters from and is therefore a POST.
        // The recovery is the one that must not be there — it was, and every
        // sweep was refused by our own proxy.
        assert!(body.contains("&password, \"sentbids\", ApiMethod::Post"), "the list read stays allow-listed");
        assert_eq!(
            body.matches("ApiMethod::Post").count(),
            1,
            "the ONLY allow-listed POST in a sweep is the sentbids list: {body}"
        );
        assert!(
            !body.contains("format!(\"bids/{}\", bid_id)"),
            "the recovery must not be built as an allow-listed path again"
        );
    }

    /// ...and the allow-list still refuses the renderer, which is the half
    /// that must not change. If this ever goes green the fix above became a
    /// hole: the webview could abandon or accept a bid.
    #[test]
    fn renderer_still_cannot_post_to_a_bid() {
        let id = "00000006a8b2e93ea546c74a88dac94a18298886d393054af3ee395b";
        let segs = vec!["bids".to_string(), id.to_string()];
        let e = crate::swap_sidecar::check_endpoint(&segs, ApiMethod::Post)
            .expect_err("a renderer POST to a bid must stay refused");
        assert!(e.contains("not on the read-only allow-list"), "unexpected: {e}");
        // The read is still allowed, so the refusal above is about the VERB
        // and not about the path being unreachable.
        assert!(crate::swap_sidecar::check_endpoint(&segs, ApiMethod::Get).is_ok());
    }

    #[test]
    fn cadence_constants_are_sane() {
        assert!(JANITOR_FIRST_DELAY < JANITOR_PERIOD);
        assert!(JANITOR_MAX_REQUEUES >= 1);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// The unpark watcher (2026-09-04)
//
// A host-wallet coin (ZANO, ZEPH) is parked for the session when its wallet
// was not up at the start — `connection_type: "none"` in the engine's config.
// The warm-up wait covers the common 14-second race; this covers everything
// the wait cannot: a wallet the user opens later, a scratch wallet that
// failed once, a start that raced anyway. When the coin is parked AND
// consented AND its wallet is now answering AND the engine has no swap in
// flight, the watcher asks the FRONTEND to restart the node — the frontend,
// not Rust, because the wallet key is cleared at every stop (C5 hygiene) and
// only the unlocked app can supply it again.
//
// 2026-09-15: requests back off instead of stopping at a cap. The first cut
// allowed two per coin per app session, never reset the count, and counted a
// request the moment it was emitted, whether or not anything listened. The
// listener only exists while the vault is unlocked, so a locked app spent both
// requests on nothing, and the coin then stayed parked until the app itself
// restarted, however long its wallet had been back — with any PATCH-36
// deferred bid on it waiting the whole time. Now only a restart that actually
// happened and still left the coin parked counts ([`UnparkBackoff`]); those
// back off to a 30-minute ceiling, and an unheard request is simply repeated.
// ═══════════════════════════════════════════════════════════════════════════

/// Emitted with `{ coin, attempt, max }` when a restart is warranted. The
/// listener (`useSwapAutoSetup`) stops the node, re-supplies the wallet key
/// and starts it again. `max` is always 0: requests back off, they are not
/// capped (see [`UnparkBackoff`]).
pub const UNPARK_EVENT: &str = "swap-sidecar-unpark";
/// Do not judge a start for this long after it turned healthy: the engine is
/// still loading, and the warm-up wait may just have ended.
const UNPARK_SETTLE: Duration = Duration::from_secs(60);
/// A request the node has not acted on within this long went unheard.
const UNPARK_UNHEARD_AFTER: Duration = Duration::from_secs(90);
/// How soon an unheard request is repeated. Nothing listens while the vault
/// is locked, and an unlock cuts this short ([`UnparkBackoff::on_unlock`]).
const UNPARK_UNHEARD_RETRY: Duration = Duration::from_secs(300);

/// Wait after `failures` restarts that left the coin parked. Pure. Grows to a
/// 30-minute ceiling and stays there, because there is no number of failures
/// after which giving up is right: a wallet that failed four times can work
/// the fifth, and a parked coin can have a bid waiting on it (PATCH-36).
pub fn unpark_delay(failures: u32) -> Duration {
    const SCHEDULE_SECS: [u64; 5] = [0, 120, 300, 600, 1200];
    const CEILING_SECS: u64 = 1800;
    Duration::from_secs(
        SCHEDULE_SECS
            .get(failures as usize)
            .copied()
            .unwrap_or(CEILING_SECS),
    )
}

/// One parked coin's place in the retry schedule. Every method is pure, so the
/// schedule is tested without a node.
///
/// Only a restart that HAPPENED counts as a failure. A request goes out, and
/// if the node goes down afterwards the app acted on it; if the coin is still
/// parked when the node is back, that was a real failed attempt. If the node
/// never goes down, nothing was listening (the vault was locked) and the
/// request is simply repeated later.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UnparkBackoff {
    /// Restarts that were acted on and still left the coin parked.
    pub failures: u32,
    /// No request before this instant.
    pub not_before: Option<Instant>,
    /// When the request not yet accounted for went out.
    pub pending: Option<Instant>,
    /// The node went down after `pending` went out.
    pub acted_on: bool,
    /// The last request went unheard, so `not_before` is only a polling
    /// interval and an unlock may cut it short.
    pub unheard: bool,
}

/// What settling a pending request found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnparkSettled {
    /// Nothing was pending.
    Nothing,
    /// Still inside the window in which the app could act on it.
    Waiting,
    /// The node restarted and the coin is still parked.
    Failed,
    /// Nothing restarted the node.
    Unheard,
}

impl UnparkBackoff {
    /// The node went down: a pending request was acted on.
    pub fn on_node_down(&mut self) {
        if self.pending.is_some() {
            self.acted_on = true;
        }
    }

    /// The vault was unlocked: the listener exists again, so an unheard
    /// request's polling wait no longer applies. A failure's wait stays.
    pub fn on_unlock(&mut self) {
        if self.unheard {
            self.not_before = None;
        }
    }

    /// Account for a pending request, as seen at `now` with the coin still
    /// parked.
    pub fn settle(&mut self, now: Instant) -> UnparkSettled {
        let Some(sent) = self.pending else {
            return UnparkSettled::Nothing;
        };
        if self.acted_on {
            self.failures = self.failures.saturating_add(1);
            self.not_before = Some(now + unpark_delay(self.failures));
            self.pending = None;
            self.acted_on = false;
            self.unheard = false;
            UnparkSettled::Failed
        } else if now.saturating_duration_since(sent) >= UNPARK_UNHEARD_AFTER {
            self.not_before = Some(now + UNPARK_UNHEARD_RETRY);
            self.pending = None;
            self.unheard = true;
            UnparkSettled::Unheard
        } else {
            UnparkSettled::Waiting
        }
    }

    /// May a request go out at `now`? Call [`Self::settle`] first.
    pub fn due(&self, now: Instant) -> bool {
        self.pending.is_none() && self.not_before.map_or(true, |t| now >= t)
    }

    pub fn on_request(&mut self, now: Instant) {
        self.pending = Some(now);
        self.acted_on = false;
    }
}

/// Bumped each time the app pushes the wallet key, which is what an unlock
/// does. The janitor turns a change into [`UnparkBackoff::on_unlock`].
static UNPARK_UNLOCK_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Called from `swap_sidecar::swap_sidecar_set_wallet_key`.
pub fn note_wallet_key_pushed() {
    UNPARK_UNLOCK_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

fn unpark_unlock_gen() -> u64 {
    UNPARK_UNLOCK_GEN.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnparkRequest {
    pub coin: String,
    pub attempt: u32,
    pub max: u32,
}

/// Parked, consented host-wallet coins in a config. Pure.
pub fn parked_consented_coins(config_json: &str, rec: &OptInRecord) -> Vec<String> {
    HOST_MANAGED_DAEMON_COINS
        .iter()
        .filter(|coin| config_coin_active(config_json, coin) == Some(false))
        .filter(|coin| {
            rec.coins
                .get(**coin)
                .map(|e| match **coin {
                    "zephyr" => shares_zph_host_wallet(rec.opted_in, e),
                    "zano" => shares_zano_host_wallet(rec.opted_in, e),
                    _ => false,
                })
                .unwrap_or(false)
        })
        .map(|c| c.to_string())
        .collect()
}

fn read_config_text(app: &AppHandle) -> Result<String, String> {
    let dd = datadir(app)?;
    let raw = std::fs::read(dd.join("basicswap.json"))
        .map_err(|e| format!("cannot read basicswap.json: {e}"))?;
    let raw = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&raw);
    String::from_utf8(raw.to_vec()).map_err(|e| format!("basicswap.json is not UTF-8: {e}"))
}

/// One check. `Ok(Some(coin))` means a restart was requested for that coin.
pub async fn unpark_tick(
    app: &AppHandle,
    backoff: &mut HashMap<String, UnparkBackoff>,
) -> Result<Option<String>, String> {
    let state = app.state::<SwapSidecarState>();
    let (port, password) = api_context(&state)?;
    let cfg = read_config_text(app)?;
    let rec = read_optin(app);
    let parked = parked_consented_coins(&cfg, &rec);
    // A coin that is active again was added. If it ever parks again, its
    // schedule starts from nothing.
    backoff.retain(|coin, _| parked.contains(coin));
    let now = Instant::now();
    for coin in parked {
        let mut entry = backoff.get(&coin).copied().unwrap_or_default();
        let was_unheard = entry.unheard;
        match entry.settle(now) {
            UnparkSettled::Failed => supervisor_log(
                app,
                &format!(
                    "unpark: {coin} is still parked after the restart (failed attempt {}); \
                     the next attempt is in {}s",
                    entry.failures,
                    unpark_delay(entry.failures).as_secs()
                ),
            ),
            UnparkSettled::Unheard if !was_unheard => supervisor_log(
                app,
                &format!(
                    "unpark: nothing restarted the node for {coin} (the app is probably locked); \
                     asking again every {}s, and at once after an unlock",
                    UNPARK_UNHEARD_RETRY.as_secs()
                ),
            ),
            _ => {}
        }
        backoff.insert(coin.clone(), entry);
        if !entry.due(now) {
            continue;
        }
        // ANSWERING, not merely spawned. Zephyr's old check was
        // `child.is_some()`, which is true long before the wallet serves a
        // request.
        if !crate::swap_sidecar::host_wallet_answering(app, &coin).await {
            continue;
        }
        // The one thing that must never be interrupted: a swap in flight.
        let active = engine_json(port, &password, "active", ApiMethod::Get, None).await?;
        let in_flight = match active.as_array() {
            Some(rows) => rows.len(),
            None => {
                supervisor_log(app, &format!("unpark: `active` did not return a list, treating the node as busy: {active}"));
                return Ok(None);
            }
        };
        if in_flight > 0 {
            supervisor_log(
                app,
                &format!(
                    "unpark: the {coin} wallet is up but {in_flight} swap(s) are in flight — not restarting"
                ),
            );
            return Ok(None);
        }
        // A locked app hears nothing, and the same line every five minutes for
        // hours says nothing new: while requests go unheard they are not logged
        // (the first unheard one was, in the settle above).
        let quiet = entry.unheard;
        entry.on_request(now);
        backoff.insert(coin.clone(), entry);
        let attempt = entry.failures + 1;
        if !quiet {
            supervisor_log(
                app,
                &format!(
                    "unpark: the {coin} wallet is up and no swap is in flight — asking the app to \
                     restart the swap node so it is added (attempt {attempt})"
                ),
            );
        }
        let _ = app.emit(
            UNPARK_EVENT,
            &UnparkRequest { coin: coin.clone(), attempt, max: 0 },
        );
        return Ok(Some(coin));
    }
    Ok(None)
}

#[cfg(test)]
mod unpark_tests {
    use super::*;
    use crate::swap_sidecar::CoinOptIn;

    fn rec(zano_enabled: bool, declined: bool) -> OptInRecord {
        let mut rec = OptInRecord::default();
        rec.opted_in = true;
        let mut e = CoinOptIn::default();
        e.enabled = zano_enabled;
        e.zano_host_wallet_declined_at = if declined {
            Some("2026-09-04T00:00:00Z".to_string())
        } else {
            None
        };
        rec.coins.insert("zano".to_string(), e);
        rec
    }

    const PARKED: &str = r#"{"chainclients":{"zano":{"connection_type":"none"},"zephyr":{"connection_type":"rpc"}}}"#;
    const ACTIVE: &str = r#"{"chainclients":{"zano":{"connection_type":"rpc"}}}"#;

    /// The 2026-09-04 case: zano parked, consented, zephyr fine.
    #[test]
    fn a_parked_consented_coin_is_a_candidate() {
        assert_eq!(parked_consented_coins(PARKED, &rec(true, false)), vec!["zano".to_string()]);
    }

    #[test]
    fn an_active_or_declined_or_disabled_coin_is_not() {
        assert!(parked_consented_coins(ACTIVE, &rec(true, false)).is_empty());
        assert!(parked_consented_coins(PARKED, &rec(true, true)).is_empty(), "declined sharing");
        assert!(parked_consented_coins(PARKED, &rec(false, false)).is_empty(), "not enabled");
    }

    #[test]
    fn settle_and_windows_are_sane() {
        assert!(UNPARK_SETTLE >= Duration::from_secs(30));
        assert!(
            UNPARK_UNHEARD_AFTER > JANITOR_IDLE_POLL * 2,
            "the janitor must get to see the node go down before a request counts as unheard"
        );
    }

    /// Failures back off to a ceiling and never stop.
    #[test]
    fn unpark_delay_grows_to_a_ceiling_and_never_stops() {
        // Pins D-43 (defect register): the unpark watcher keeps retrying a parked coin.
        assert_eq!(unpark_delay(1), Duration::from_secs(120));
        let mut prev = Duration::ZERO;
        for n in 1..64 {
            let d = unpark_delay(n);
            assert!(d >= prev, "the delay shrank at failure {n}");
            prev = d;
        }
        assert_eq!(unpark_delay(u32::MAX), Duration::from_secs(1800), "a ceiling, not a cap");
    }

    /// 2026-09-15: a locked app spent both of the old capped attempts on
    /// nothing. A request the node never acted on is not a failure. It is
    /// repeated on a polling interval, and an unlock cuts that short.
    #[test]
    fn an_unheard_request_is_not_a_failure() {
        let t0 = Instant::now();
        let mut b = UnparkBackoff::default();
        assert!(b.due(t0));
        b.on_request(t0);
        assert!(!b.due(t0), "one request at a time");
        assert_eq!(b.settle(t0 + Duration::from_secs(30)), UnparkSettled::Waiting);
        let t1 = t0 + UNPARK_UNHEARD_AFTER;
        assert_eq!(b.settle(t1), UnparkSettled::Unheard);
        assert_eq!(b.failures, 0, "nothing restarted, so nothing failed");
        assert!(!b.due(t1 + Duration::from_secs(10)));
        assert!(b.due(t1 + UNPARK_UNHEARD_RETRY));
        b.on_unlock();
        assert!(b.due(t1 + Duration::from_secs(10)), "an unlock ends the polling wait");
    }

    /// A restart that happened and still left the coin parked counts, and its
    /// wait survives an unlock. Every unpark restart pushes the wallet key,
    /// which is the unlock signal, so if an unlock cut a failure's wait short a
    /// failing wallet would become a restart loop.
    #[test]
    fn a_restart_that_left_the_coin_parked_backs_off() {
        let t0 = Instant::now();
        let mut b = UnparkBackoff::default();
        b.on_request(t0);
        b.on_node_down();
        let back = t0 + Duration::from_secs(70);
        assert_eq!(b.settle(back), UnparkSettled::Failed);
        assert_eq!(b.failures, 1);
        assert!(!b.due(back + Duration::from_secs(119)));
        b.on_unlock();
        assert!(
            !b.due(back + Duration::from_secs(119)),
            "an unlock must not cut a failure's wait"
        );
        assert!(b.due(back + Duration::from_secs(120)));
    }

    /// The node going down with nothing pending (a manual stop) marks nothing.
    #[test]
    fn a_node_down_with_nothing_pending_changes_nothing() {
        let mut b = UnparkBackoff::default();
        b.on_node_down();
        assert_eq!(b, UnparkBackoff::default());
    }

    /// Structural: the wallet-key push is what the janitor reads as an unlock.
    #[test]
    fn the_wallet_key_push_is_the_unlock_signal() {
        // Normalized (2026-09-25): on a Windows checkout (core.autocrlf) this source is
        // CRLF, so a search for a "\n...\n" shape never matched and the test failed
        // for line endings, not code. See PwndaWalletVault/log.md 2026-09-25.
        let src = include_str!("swap_sidecar.rs").replace("\r\n", "\n");
        let f = &src[src
            .find("pub async fn swap_sidecar_set_wallet_key(")
            .expect("key push moved")..];
        let f = &f[..f.find("\n}\n").expect("key push end")];
        assert!(f.contains("crate::swap_bid::note_wallet_key_pushed()"));
        let before = unpark_unlock_gen();
        note_wallet_key_pushed();
        assert!(unpark_unlock_gen() > before);
    }
}
