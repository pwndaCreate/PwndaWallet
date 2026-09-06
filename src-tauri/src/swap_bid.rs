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
    /// Where the bought coin should land. `None` lets the engine pick.
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

/// The body posted to the engine. Built here, never forwarded from the
/// renderer, so no unexpected key can ride along.
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
        body["addr_to"] = Value::String(addr.to_string());
    }
    if let Some(v) = req.valid_for_seconds {
        body["valid_for_seconds"] = Value::String(v.to_string());
    }
    body
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

    // 3. The write. Pinned path, body built here.
    let url = format!("http://127.0.0.1:{}/json/{}", port, BID_NEW_PATH);
    let resp = client
        .post(&url)
        .header("Authorization", basic_auth_header(&auth))
        .json(&build_bid_body(&req))
        .send()
        .await
        .map_err(|e| format!("the bid could not be sent to the swap node: {}", e))?;
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
        return Err(
            "this swap-node runtime does not carry the recovery patch              (upstream/patches/0011); run `node scripts/apply-engine-patches.mjs`              and restart the node"
                .to_string(),
        );
    }
    serde_json::from_value(parsed)
        .map_err(|e| format!("could not read the recovery result: {}", e))
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
                "addr_to",
                "amount_from",
                "offer_id",
                "rate",
                "valid_for_seconds"
            ]
        );
    }

    #[test]
    fn omits_an_absent_payout_address_rather_than_sending_empty() {
        let mut r = req();
        r.addr_to = Some("   ".into());
        assert!(build_bid_body(&r).get("addr_to").is_none());
        r.addr_to = None;
        assert!(build_bid_body(&r).get("addr_to").is_none());
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
        let mut requeues: HashMap<String, u32> = HashMap::new();
        let mut unpark_attempts: HashMap<String, u32> = HashMap::new();
        supervisor_log(&app, "janitor: watcher started");
        loop {
            tokio::time::sleep(JANITOR_IDLE_POLL).await;
            let healthy = {
                let state = app.state::<SwapSidecarState>();
                api_context(&state).is_ok()
            };
            if !healthy {
                healthy_since = None;
                last_sweep = None;
                continue;
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
                match unpark_tick(&app, &mut unpark_attempts).await {
                    Ok(Some(coin)) => {
                        // A restart is on its way; the phase will leave Healthy
                        // and this loop resets itself on the next poll.
                        supervisor_log(&app, &format!("unpark: restart requested for {coin}"));
                        healthy_since = None;
                        last_sweep = None;
                        continue;
                    }
                    Ok(None) => {}
                    Err(e) => supervisor_log(&app, &format!("unpark: check skipped — {e}")),
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
            let first_sweep = last_sweep.is_none();
            last_sweep = Some(Instant::now());
            supervisor_log(&app, "janitor: sweep starting (POST /json/sentbids)");
            match run_bid_janitor_once(&app, &mut requeues).await {
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
// only the unlocked app can supply it again. At most `UNPARK_MAX_RESTARTS`
// per coin per app session, so a wallet that keeps failing cannot turn into a
// restart loop; after that the DEX-coins row's reason stands and the user
// restarts by hand.
// ═══════════════════════════════════════════════════════════════════════════

/// Emitted with `{ coin, attempt, max }` when a restart is warranted. The
/// listener (`useSwapAutoSetup`) stops the node, re-supplies the wallet key
/// and starts it again.
pub const UNPARK_EVENT: &str = "swap-sidecar-unpark";
pub const UNPARK_MAX_RESTARTS: u32 = 2;
/// Do not judge a start for this long after it turned healthy: the engine is
/// still loading, and the warm-up wait may just have ended.
const UNPARK_SETTLE: Duration = Duration::from_secs(60);

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

async fn host_wallet_up(app: &AppHandle, coin: &str) -> bool {
    match coin {
        "zano" => crate::zano_rpc::zano_rpc_is_running(app.clone()).await.unwrap_or(false),
        "zephyr" => crate::zph_rpc::zph_rpc_is_running(app.clone()).await.unwrap_or(false),
        _ => false,
    }
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
    attempts: &mut HashMap<String, u32>,
) -> Result<Option<String>, String> {
    let state = app.state::<SwapSidecarState>();
    let (port, password) = api_context(&state)?;
    let cfg = read_config_text(app)?;
    let rec = read_optin(app);
    for coin in parked_consented_coins(&cfg, &rec) {
        let n = attempts.get(&coin).copied().unwrap_or(0);
        if n >= UNPARK_MAX_RESTARTS {
            continue;
        }
        if !host_wallet_up(app, &coin).await {
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
        let attempt = n + 1;
        attempts.insert(coin.clone(), attempt);
        supervisor_log(
            app,
            &format!(
                "unpark: the {coin} wallet is up and no swap is in flight — asking the app to \
                 restart the swap node so it is added (attempt {attempt} of {UNPARK_MAX_RESTARTS})"
            ),
        );
        let _ = app.emit(
            UNPARK_EVENT,
            &UnparkRequest { coin: coin.clone(), attempt, max: UNPARK_MAX_RESTARTS },
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
    fn restart_cap_and_settle_are_sane() {
        assert!(UNPARK_MAX_RESTARTS >= 1 && UNPARK_MAX_RESTARTS <= 3);
        assert!(UNPARK_SETTLE >= Duration::from_secs(30));
    }
}
