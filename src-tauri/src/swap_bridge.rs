//! C4 / C6 — destination-pinned sweep-back, and the privileged deposit-address
//! rotation that pairs with it.
//!
//! # What this module is for
//!
//! The swap node runs its own wallets. For coins the user did **not** enable a
//! local daemon for, those wallets are the only place that coin lives while the
//! engine holds it, and there has to be a way to get the balance back into the
//! user's own wallet without leaving dust behind. That is the sweep: upstream's
//! `wallets/<TICKER>/withdraw` with `sweepall` (XMR family) or `subfee: true`
//! (bitcoin family), so the fee comes out of the amount and the source wallet
//! ends at zero rather than at "zero minus a fee we had to guess".
//!
//! # THE security property, stated once
//!
//! `wallets/<coin>/withdraw` is on [`crate::swap_sidecar::DENIED_ENDPOINTS`]
//! (defect W-2) because a compromised renderer must not be able to move coin.
//! This module re-opens that capability for the *wallet*, and the entire
//! argument that doing so is safe is one sentence:
//!
//! > **No code path in this module accepts a destination address from the
//! > renderer.**
//!
//! Concretely:
//!
//! * [`swap_bridge_execute_sweep`] has **no address parameter**. Its argument
//!   list is `(token, confirm_phrase)` and nothing else. Adding one is a
//!   *compile* error in the test module — see `_pin_execute_sweep_signature`,
//!   whose only job is to stop building the moment that signature changes.
//! * The destination is computed backend-side: [`pinned_destination`] derives
//!   it from the user's own vault seed for the UTXO family, and Monero's comes
//!   from the wallet's own `monero-wallet-rpc` via `get_address`. A coin we do
//!   not handle is a refusal, never a guess — a fall-through that encoded one
//!   chain's pubkey hash under another chain's version byte would produce a
//!   valid-looking address that burns the funds.
//! * Nothing here widens [`crate::swap_sidecar::check_endpoint`]. The engine
//!   call goes through [`api_post_privileged`], a Rust-only door that asserts
//!   the path shape itself; `check_endpoint` **alone** still refuses
//!   `wallets/XMR/withdraw` and `wallets/XMR/nextdepositaddr` after this module
//!   exists, and `webview_route_still_denied` is the standing proof (R15).
//!
//! # Replay and mis-confirmation (R14)
//!
//! Preparing a sweep mints a **single-use, 120-second** token and pins a
//! confirm phrase — the last six characters of the destination, which the user
//! reads off the plan card and types back. Execute needs both. Every one of
//! those checks runs *before* any transport call, which is why
//! `confirm_phrase_mismatch_refuses` can assert **no HTTP was issued at all**
//! rather than the much weaker "the request failed".
//!
//! # The reserved-balance gate
//!
//! A sweep drains the engine's wallet. If the engine has a swap in flight for
//! that coin it is about to need those funds for a lock transaction, and a
//! sweep that lands first aborts the swap. The failure mode is a dead swap
//! rather than lost coin, but it is preventable, so [`reserved_balance_gate`]
//! refuses while anything is in flight — and fails closed, because a count we
//! could not read is not a count of zero.

use serde::Serialize;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::swap_sidecar::{
    self, active_bids_for, api_context, basic_auth_header, coin_key_from, read_optin, ticker_for,
    Adoption, ApiMethod, SwapSidecarState, WALLET_SIDECAR_COINS,
};
use tauri::AppHandle;

// =========================================================================
// Constants
// =========================================================================

/// How long a minted sweep token stays spendable. Contract §1.6.
///
/// Short on purpose: the token is a bearer capability to move the engine's
/// whole balance for one coin, and the only thing it needs to survive is the
/// user reading six characters off the screen and typing them.
pub const SWEEP_TOKEN_TTL: Duration = Duration::from_secs(120);

/// How many trailing characters of the destination the user must type back.
/// Mirrored in `src/features/swap-sidecar/sweepBack.ts` — the TS copy exists so
/// a typo costs no round trip; **this** one is the check that matters.
pub const SWEEP_CONFIRM_LEN: usize = 6;

/// The only two `wallets/<TICKER>/<verb>` calls Rust may make past the
/// allow-list.
///
/// Both are on [`crate::swap_sidecar::DENIED_ENDPOINTS`] and **stay there**.
/// This constant is the *Rust* surface; widening `check_endpoint` instead would
/// hand the same power to the renderer, which is the exact regression
/// `webview_route_still_denied` exists to catch.
pub(crate) const PRIVILEGED_WALLET_VERBS: &[&str] = &["withdraw", "nextdepositaddr"];

// =========================================================================
// The plan (renderer-facing) and the ticket (backend-only)
// =========================================================================

/// A prepared sweep. Rust-struct regime: camelCase over the wire (contract
/// §0.1).
///
/// `destination` is an **output**. It is on this struct so the plan card can
/// show the user where the money is going and so they can read the confirm
/// phrase off it; it is never read back in.
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SweepPlan {
    /// 32 random bytes, hex. Single-use, consumed by the execute call.
    pub token: String,
    /// Engine coin name (`"bitcoin"`, `"monero"`, …), normalized.
    pub coin: String,
    pub destination: String,
    /// Decimal string for the bitcoin family; `None` when `sweepall`.
    pub amount: Option<String>,
    pub sweepall: bool,
    /// RFC3339.
    pub expires_at: String,
}

/// Hand-written so a stray `{:?}` cannot put a live capability into a log.
///
/// The token is not a long-lived secret, but for its 120 seconds it *is* the
/// authority to move a whole wallet balance, and log tails from this subsystem
/// reach the webview verbatim (`PrepareError.detail`). Everything else on the
/// plan is public.
impl std::fmt::Debug for SweepPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SweepPlan")
            .field("token", &"<redacted>")
            .field("coin", &self.coin)
            .field("destination", &self.destination)
            .field("amount", &self.amount)
            .field("sweepall", &self.sweepall)
            .field("expiresAt", &self.expires_at)
            .finish()
    }
}

/// The backend's copy of a prepared sweep. Never serialized, never sent.
#[derive(Clone, PartialEq)]
pub(crate) struct SweepTicket {
    pub(crate) token: String,
    /// A `&'static str` out of [`WALLET_SIDECAR_COINS`], so a caller cannot
    /// carry a differently-cased copy forward.
    pub(crate) coin: &'static str,
    pub(crate) ticker: String,
    pub(crate) destination: String,
    pub(crate) amount: Option<String>,
    pub(crate) sweepall: bool,
    pub(crate) expires_at: SystemTime,
}

/// Same redaction rule as [`SweepPlan`]'s — the ticket is the plan's twin and
/// the token is the half worth hiding.
impl std::fmt::Debug for SweepTicket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SweepTicket")
            .field("token", &"<redacted>")
            .field("coin", &self.coin)
            .field("ticker", &self.ticker)
            .field("destination", &self.destination)
            .field("amount", &self.amount)
            .field("sweepall", &self.sweepall)
            .finish()
    }
}

/// Tauri-managed store for the one outstanding sweep.
///
/// **Exactly one slot, deliberately.** The UI shows one plan card at a time,
/// and a map of pending tokens would be a set of simultaneously live bearer
/// capabilities in exchange for nothing. Preparing a second sweep replaces the
/// first, which can only ever turn a would-be spend into a refusal.
pub struct SweepState(Mutex<Option<SweepTicket>>);

impl SweepState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for SweepState {
    fn default() -> Self {
        Self::new()
    }
}

// =========================================================================
// Pure helpers — destination pinning (R13)
// =========================================================================

/// Is this a coin whose destination we derive ourselves from the vault seed?
///
/// Monero is deliberately **false**: its address is read from the wallet's own
/// `monero-wallet-rpc`, not derived here. Particl is false because the wallet
/// holds no Particl account at all — there is nowhere of the user's own to
/// sweep a PART balance to, so it must refuse rather than invent somewhere.
pub fn is_utxo_family(coin: &str) -> bool {
    utxo_chain_for(coin).is_some()
}

fn utxo_chain_for(coin: &str) -> Option<crate::swap::derive::UtxoChain> {
    use crate::swap::derive::UtxoChain;
    match coin_key_from(coin)? {
        "bitcoin" => Some(UtxoChain::Btc),
        "litecoin" => Some(UtxoChain::Ltc),
        "dogecoin" => Some(UtxoChain::Doge),
        "dash" => Some(UtxoChain::Dash),
        "bitcoincash" => Some(UtxoChain::Bch),
        _ => None,
    }
}

/// The wallet's own receive address for `coin`, from the vault seed. Pure.
///
/// This is the whole of C4's destination story for the UTXO family: account 0,
/// index 0 — the *same* derivation `swap::commands` uses to show the user their
/// address, so "where did my swap balance go?" has the answer "to the address
/// already on your wallet screen".
///
/// **Refuses rather than falls back.** Monero errs here on purpose (its
/// destination is an RPC read, not a derivation) and so does every coin we do
/// not handle.
pub fn pinned_destination(seed: &[u8], coin: &str) -> Result<String, String> {
    let Some(key) = coin_key_from(coin) else {
        return Err(format!(
            "{:?} is not a coin the swap node can hold — no destination can be \
             derived for it, and guessing one would send the funds into another \
             chain's address space",
            coin
        ));
    };
    let Some(chain) = utxo_chain_for(key) else {
        return Err(format!(
            "no vault-derived destination exists for {} — {}",
            key,
            if key == "monero" {
                "Monero's sweep destination is read from the wallet's own \
                 monero-wallet-rpc, not derived here"
            } else {
                "the wallet holds no account for this coin"
            }
        ));
    };
    crate::swap::derive::utxo_address(seed, chain, 0, 0).map_err(|e| {
        format!(
            "could not derive the wallet's own {} address: {}",
            ticker_for(key),
            e
        )
    })
}

/// The phrase the user must type: the last [`SWEEP_CONFIRM_LEN`] **characters**
/// of the destination.
///
/// Characters, not bytes — every address we produce is ASCII so the two agree,
/// but slicing bytes would panic rather than mis-answer if that ever stopped
/// being true, and a panic on a fund-moving path is worse than a refusal.
pub fn confirm_phrase_for(destination: &str) -> String {
    let n = destination.chars().count();
    destination
        .chars()
        .skip(n.saturating_sub(SWEEP_CONFIRM_LEN))
        .collect()
}

/// Length-checked, non-short-circuiting equality. Used for the token.
///
/// The token is unguessable (32 OS-random bytes), so this is belt-and-braces
/// rather than load-bearing — but it costs one loop and removes the need to
/// argue about how many attempts a 120-second window allows.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// =========================================================================
// The reserved-balance gate
// =========================================================================

/// May we drain this coin's wallet right now?
///
/// `in_flight` is the engine's count of bids that touch this coin, or `None`
/// for "could not measure".
///
/// **`None` is a refusal.** The engine funds its lock transactions out of the
/// wallet we are draining; a count we could not read is not a count of zero,
/// and the point of the gate is that it holds when we are least sure. Being
/// wrong in the other direction costs a swap that dies mid-flight, which on a
/// live leg is not free.
pub fn reserved_balance_gate(in_flight: Option<usize>) -> Result<(), String> {
    match in_flight {
        None => Err(
            "the swap node's in-flight swaps could not be read, so a sweep is refused — \
             draining the wallet while the engine needs it to fund a lock would abort \
             that swap"
                .to_string(),
        ),
        Some(0) => Ok(()),
        Some(n) => Err(format!(
            "the swap node has {} swap(s) in flight for this coin and needs this wallet \
             to fund them — finish or abandon them before sweeping",
            n
        )),
    }
}

// =========================================================================
// The privileged door (R15)
// =========================================================================

/// Is `t` an UPPERCASE ticker of a coin the sidecar can run?
///
/// Derived from [`WALLET_SIDECAR_COINS`] rather than written out again, so a
/// coin added there cannot silently fail to be sweepable — and, more to the
/// point, a ticker that is *not* there can never reach the engine through
/// [`api_post_privileged`].
fn is_known_ticker(t: &str) -> bool {
    WALLET_SIDECAR_COINS.iter().any(|c| ticker_for(c) == t)
}

/// Build a privileged path from a validated ticker and a `&'static str` verb.
///
/// The verb being `&'static str` is the same device
/// [`crate::swap_daemon::daemon_rpc`] uses for RPC method names: a
/// renderer-derived `String` cannot be passed here without the compiler saying
/// so, at every call site.
pub(crate) fn privileged_wallet_path(ticker: &str, verb: &'static str) -> Result<String, String> {
    if !PRIVILEGED_WALLET_VERBS.contains(&verb) {
        return Err(format!("'{}' is not a privileged wallet verb", verb));
    }
    if !is_known_ticker(ticker) {
        return Err(format!("{:?} is not a coin the swap node can run", ticker));
    }
    Ok(format!("wallets/{}/{}", ticker, verb))
}

/// Structural check on a privileged path: exactly `wallets/<TICKER>/<verb>`.
///
/// Runs **before any socket is opened**, which is what lets
/// `privileged_path_is_checked_before_the_socket` tell "the guard refused"
/// apart from "the network refused".
pub(crate) fn assert_privileged_path(path: &str) -> Result<(), String> {
    let segs: Vec<&str> = path.split('/').collect();
    let bad = |why: &str| {
        Err(format!(
            "{:?} is not a privileged swap-node endpoint ({})",
            path, why
        ))
    };
    if segs.len() != 3 {
        return bad("expected exactly wallets/<TICKER>/<verb>");
    }
    if segs[0] != "wallets" {
        return bad("does not start at wallets/");
    }
    if !is_known_ticker(segs[1]) {
        return bad("unknown coin ticker");
    }
    if !PRIVILEGED_WALLET_VERBS.contains(&segs[2]) {
        return bad("verb is not withdraw or nextdepositaddr");
    }
    Ok(())
}

/// Error prefix for a request that was SENT and whose reply was then lost — a
/// timeout, a reset mid-body. The engine may have acted on it.
///
/// Money-moving callers (the sidecar fee) key on this: a withdraw whose reply
/// is lost must close as indeterminate rather than be retried, because the
/// retry is how a fee gets taken twice. Kept as a constant shared with
/// [`is_transport_failure`] so the classifier and the producer cannot drift
/// apart by a wording change.
pub(crate) const TRANSPORT_FAILURE_PREFIX: &str = "swap node request failed";

/// Error prefix for a connection that was REFUSED before anything was sent.
/// Nothing reached the engine, so a retry is safe.
pub(crate) const NODE_UNREACHABLE_PREFIX: &str = "swap node unreachable";

/// Was this error a request that went out and lost its reply?
///
/// `false` for every answer the node actually gave (HTTP status, JSON error,
/// no txid) and for a connection refused up front — all of which prove nothing
/// was broadcast.
pub(crate) fn is_transport_failure(err: &str) -> bool {
    err.starts_with(TRANSPORT_FAILURE_PREFIX)
}

/// One authenticated POST to a privileged `/json/wallets/<TICKER>/<verb>`.
///
/// Contract §0.4: the allow-list is never widened; privileged engine calls get
/// their own Rust-only door that asserts the path itself.
pub(crate) async fn api_post_privileged(
    port: u16,
    pwd: &str,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    assert_privileged_path(path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .post(format!("http://127.0.0.1:{}/json/{}", port, path))
        .header("Authorization", basic_auth_header(pwd))
        // `Content-Type: application/json` is what makes upstream parse with
        // `json.loads` instead of `urllib.parse.parse_qs`
        // (http_server.py -> js_server.py:55-63). Form-encoded, `withdraw_coin`
        // would receive `{"address": ["bc1…"], "subfee": ["true"]}` — lists —
        // and `toBool(["true"])` is not `True`.
        .json(&body)
        .send()
        .await
        // Two different facts hide in one reqwest error. A connect failure
        // means the request never left; anything else (timeout, reset) means
        // it did and the answer did not come back. The fee's at-most-once
        // rule needs to tell them apart, so they get different prefixes.
        .map_err(|e| {
            if e.is_connect() {
                format!("{}: {}", NODE_UNREACHABLE_PREFIX, e)
            } else {
                format!("{}: {}", TRANSPORT_FAILURE_PREFIX, e)
            }
        })?;
    decode_json(resp).await
}

async fn decode_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("could not read the swap node's reply: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(format!("swap node HTTP {}: {}", status, snippet(&text)));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("swap node reply was not JSON: {} — {}", e, snippet(&text)))
}

fn snippet(s: &str) -> String {
    s.chars().take(200).collect()
}

// =========================================================================
// The transport seam
// =========================================================================

/// The one call [`execute_sweep_with`] makes. Injectable so the R14 tests can
/// assert **"no request was issued"** rather than the much weaker "the request
/// failed" — a recorder that was never called is the only way to tell a guard
/// that refused apart from a network that happened to be down.
pub(crate) trait EnginePoster: Send + Sync {
    fn post<'a>(
        &'a self,
        path: &'a str,
        body: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}

/// The production implementation: the privileged door, nothing else.
pub(crate) struct HttpPoster {
    pub(crate) port: u16,
    pub(crate) auth: String,
}

impl EnginePoster for HttpPoster {
    fn post<'a>(
        &'a self,
        path: &'a str,
        body: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async move { api_post_privileged(self.port, &self.auth, path, body).await })
    }
}

// =========================================================================
// Ticket lifecycle
// =========================================================================

fn mint_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf)
        .map_err(|e| format!("OS entropy syscall failed while minting a sweep token: {}", e))?;
    Ok(hex::encode(buf))
}

/// Build a ticket whose deadline is `minted_at + SWEEP_TOKEN_TTL`.
///
/// Takes `minted_at` rather than reading the clock, so the TTL arithmetic
/// itself is under test: `token_is_single_use_and_expires` mints at
/// `now - 121 s` through this same function, which makes it a test of
/// [`SWEEP_TOKEN_TTL`] rather than of a number the test wrote down twice.
pub(crate) fn new_ticket(
    token: String,
    coin: &'static str,
    ticker: String,
    destination: String,
    amount: Option<String>,
    sweepall: bool,
    minted_at: SystemTime,
) -> SweepTicket {
    SweepTicket {
        token,
        coin,
        ticker,
        destination,
        amount,
        sweepall,
        expires_at: minted_at + SWEEP_TOKEN_TTL,
    }
}

/// Park the ticket in the single slot and hand back the renderer's view of it.
pub(crate) fn stash_ticket(store: &SweepState, ticket: SweepTicket) -> Result<SweepPlan, String> {
    let plan = SweepPlan {
        token: ticket.token.clone(),
        coin: ticket.coin.to_string(),
        destination: ticket.destination.clone(),
        amount: ticket.amount.clone(),
        sweepall: ticket.sweepall,
        expires_at: rfc3339(ticket.expires_at),
    };
    let mut guard = store.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *guard = Some(ticket);
    Ok(plan)
}

fn rfc3339(t: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()
}

/// Check the token and the confirm phrase, and take the ticket on success.
///
/// **Every refusal here happens before any transport call.** That ordering is
/// the feature: it is what lets `confirm_phrase_mismatch_refuses` assert that
/// zero requests were issued.
///
/// Three deliberate asymmetries:
///
/// * A **wrong token** does not consume the stored one. The token is 32 random
///   bytes; nobody guesses it, and consuming on mismatch would let any caller
///   destroy a legitimate pending sweep by naming garbage.
/// * A **wrong confirm phrase** also does not consume. The phrase is six
///   characters of a destination shown on screen — a confirmation, not a
///   secret — so a typo must not cost the user a fresh prepare.
/// * An **expired** ticket *is* dropped. It can never be spent again, and
///   leaving it in the slot only invites a later caller to trip over it.
pub(crate) fn consume_ticket(
    store: &SweepState,
    token: &str,
    confirm_phrase: &str,
    now: SystemTime,
) -> Result<SweepTicket, String> {
    let mut guard = store.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let Some(ticket) = guard.as_ref() else {
        return Err("no sweep is prepared — prepare one first".to_string());
    };
    if !ct_eq(&ticket.token, token) {
        return Err("that sweep token is not the prepared one".to_string());
    }
    if now >= ticket.expires_at {
        *guard = None;
        return Err(format!(
            "this sweep expired after {} seconds — prepare a new one",
            SWEEP_TOKEN_TTL.as_secs()
        ));
    }
    let want = confirm_phrase_for(&ticket.destination);
    if want.is_empty() || confirm_phrase.trim() != want {
        return Err(format!(
            "the confirmation does not match — type the last {} characters of the \
             destination shown on the plan",
            SWEEP_CONFIRM_LEN
        ));
    }
    Ok(guard.take().expect("checked Some above"))
}

/// The engine's `withdraw` body for this ticket.
///
/// Shapes verified against `js_server.py::withdraw_coin` (~line 66):
/// * the XMR family reads `sweepall` (and only reads `value` when it is false);
/// * everything else reads `value` **and** `subfee`, both mandatory.
///
/// `subfee: true` is what makes this zero-residue: the fee comes out of the
/// amount, so the source wallet lands on zero instead of on "balance minus a
/// fee we had to predict".
pub(crate) fn withdraw_body(ticket: &SweepTicket) -> Result<Value, String> {
    if ticket.sweepall {
        return Ok(json!({ "address": ticket.destination, "sweepall": true }));
    }
    let value = ticket
        .amount
        .as_ref()
        .ok_or_else(|| "a bitcoin-family sweep needs an amount".to_string())?;
    Ok(json!({
        "address": ticket.destination,
        "value": value,
        "subfee": true,
    }))
}

/// C8 — the engine-routed send for a coin whose lean wallet **is** the user's
/// wallet (`Adoption::AccountKey`).
///
/// # Why this exists at all
///
/// Once a coin is shared, the engine's `WalletManager` — not this wallet's own
/// single-address adapter — holds the complete account: both derivation
/// branches, every UTXO, the change the wallet's own send path cannot see (the
/// finding recorded in [[2026-08-20-lean-zero-move-feasibility]] and
/// [[pwnda-basicswap-convergence-plan]] § C8 step 21). P4's rule is one
/// selector per keyset; for a shared coin that selector is the engine. This
/// command is that selector's front door for an ordinary send — arbitrary
/// destination, arbitrary amount, exactly the shape `wallets/<coin>/withdraw`
/// already has, and exactly why it sits on
/// [`crate::swap_sidecar::DENIED_ENDPOINTS`] and can only be reached from here.
///
/// # Not the sweep pattern, and deliberately not
///
/// [`execute_sweep_with`] pins its destination server-side because a sweep has
/// exactly one legitimate destination — the user's own wallet. An ordinary
/// send has no such invariant: the whole point is paying an address the
/// renderer supplies, precisely as every other chain's Send flow in this
/// wallet already works. The safety property here is narrower and different:
/// **the coin must be `Adoption::AccountKey`-verified**, checked by the
/// command below before any socket opens, so this door cannot be used to route
/// an ordinary payment through a wallet the engine does not actually share.
pub(crate) fn shared_withdraw_body(address: &str, amount: &str) -> Result<Value, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("a destination address is required".to_string());
    }
    let amount = amount.trim();
    let parsed: f64 = amount
        .parse()
        .map_err(|_| format!("{:?} is not a valid amount", amount))?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err("the amount must be greater than zero".to_string());
    }
    // `subfee: false` — the opposite of the sweep's `true`. A sweep wants zero
    // residue (drain the wallet, fee comes out of the amount); an ordinary
    // send wants to pay exactly `amount` to the recipient, with the fee drawn
    // from the rest of the balance, matching every other chain's Send in this
    // wallet and matching upstream's own non-sweep default.
    Ok(json!({
        "address": address,
        "value": amount,
        "subfee": false,
    }))
}

/// The whole of the shared-coin send, minus Tauri — testable with a recording
/// transport, mirroring [`execute_sweep_with`].
pub(crate) async fn execute_shared_withdraw_with(
    poster: &dyn EnginePoster,
    ticker: &str,
    address: &str,
    amount: &str,
) -> Result<String, String> {
    let body = shared_withdraw_body(address, amount)?;
    let path = privileged_wallet_path(ticker, "withdraw")?;
    let v = poster.post(&path, body).await?;
    extract_txid(&v)
}

/// Is `key`'s wallet CONFIRMED shared — the engine's own derivation already
/// matched the wallet's, at push time?
///
/// Pulled out of the command as its own pure predicate so the gate is
/// testable without any Tauri machinery, the same shape as
/// `addcoins_are_doomed` / `unlock_wallets_precheck` elsewhere in this
/// subsystem: a `bool` in, `bool` out, and every caller-affecting decision
/// lives in the one place that can be driven by a hand-built [`OptInRecord`].
///
/// **Consent alone is not enough.** `CoinOptIn::share_wallet_ack_at` records
/// that a push was ATTEMPTED; only `Adoption::AccountKey` records that the
/// engine's derived address was verified to match. This command moves funds,
/// so it checks the stronger fact.
pub(crate) fn coin_is_verified_shared(rec: &swap_sidecar::OptInRecord, key: &str) -> bool {
    rec.coins
        .get(key)
        .map(|e| e.adoption == Adoption::AccountKey)
        .unwrap_or(false)
}

/// C8 — send FROM a coin's shared wallet, through the engine.
///
/// Refuses on anything but a **verified** shared coin — see
/// [`coin_is_verified_shared`] for why consent alone does not qualify. This
/// command moves funds.
///
/// Also runs [`reserved_balance_gate`] — the same check
/// `swap_bridge_execute_sweep` applies before draining a deposit-mode coin. It
/// generalises without change: a shared wallet is exactly as reachable by the
/// engine's lock-funding as the sweep's source wallet is, and a
/// pwnda-initiated send that outran an in-flight bid would abort that swap the
/// same way a drain would. **`None` (could not measure) is a refusal**, not a
/// pass.
#[tauri::command]
pub async fn swap_bridge_shared_coin_withdraw(
    app: AppHandle,
    sc: tauri::State<'_, SwapSidecarState>,
    coin: String,
    address: String,
    amount: String,
) -> Result<String, String> {
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    let ticker = ticker_for(key);

    if !coin_is_verified_shared(&read_optin(&app), key) {
        return Err(format!(
            "{} is not confirmed as a wallet the swap node shares — send from this wallet's own send flow instead",
            ticker
        ));
    }

    // Cheapest refusal first, and the one that must not be skipped — mirrors
    // swap_bridge_prepare_sweep's ordering exactly.
    let in_flight = active_bids_for(&sc, key).await.ok();
    reserved_balance_gate(in_flight)?;

    let (port, auth) = api_context(&sc)?;
    let poster = HttpPoster { port, auth };
    execute_shared_withdraw_with(&poster, &ticker, &address, &amount).await
}

/// `{"txid": "..."}` — or an `error` body, which upstream returns with HTTP 200.
pub(crate) fn extract_txid(v: &Value) -> Result<String, String> {
    if let Some(e) = v.get("error") {
        return Err(format!("the swap node refused the withdrawal: {}", e));
    }
    v.get("txid")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .ok_or_else(|| format!("the swap node returned no txid: {}", snippet(&v.to_string())))
}

/// `nextdepositaddr` answers with a **bare JSON string**
/// (`json.dumps(cacheNewAddressForCoin(...))`, js_server.py:332-335), not an
/// object. The object form is accepted too, so an upstream that starts wrapping
/// it does not break this silently.
pub(crate) fn extract_address(v: &Value) -> Result<String, String> {
    if let Some(e) = v.get("error") {
        return Err(format!("the swap node refused the address request: {}", e));
    }
    let addr = match v {
        Value::String(s) => Some(s.as_str()),
        _ => v.get("address").and_then(|a| a.as_str()),
    };
    addr.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "the swap node returned no deposit address: {}",
                snippet(&v.to_string())
            )
        })
}

/// The whole of execute, minus Tauri. Testable with a recording transport.
pub(crate) async fn execute_sweep_with(
    poster: &dyn EnginePoster,
    store: &SweepState,
    token: &str,
    confirm_phrase: &str,
    now: SystemTime,
) -> Result<String, String> {
    // Ordering is load-bearing: nothing below the guard runs unless the guard
    // passed, and the guard touches no socket.
    let ticket = consume_ticket(store, token, confirm_phrase, now)?;
    let body = withdraw_body(&ticket)?;
    let path = privileged_wallet_path(&ticket.ticker, "withdraw")?;
    let v = poster.post(&path, body).await?;
    extract_txid(&v)
}

// =========================================================================
// Balance read (allow-listed, ordinary route)
// =========================================================================

/// The engine's balance for one coin, off the allow-listed `wallets/<TICKER>`
/// read.
///
/// Goes through [`crate::swap_sidecar::build_api_url`] on purpose: this is a
/// plain read the webview could also make, so it has no business using the
/// privileged door.
pub(crate) async fn wallet_balance(
    port: u16,
    auth: &str,
    ticker: &str,
) -> Result<String, String> {
    let url = swap_sidecar::build_api_url(port, &format!("wallets/{}", ticker), ApiMethod::Get)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", basic_auth_header(auth))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    let v = decode_json(resp).await?;
    if let Some(e) = v.get("error") {
        return Err(format!("the swap node could not read that wallet: {}", e));
    }
    balance_string(&v)
}

/// How many addresses the engine holds for one coin.
///
/// # Why this exists: "unreadable" and "absent" are different facts
///
/// [`pre_share_balance_gate`] fails closed on a balance it cannot read,
/// because a balance we could not measure is not a balance of zero. That is
/// right for a wallet that EXISTS. It is a deadlock for one that does not:
/// PWNDA-PATCH-3 makes the engine refuse to build a lean wallet for an armed
/// coin until the host pushes its account key, and `getWalletInfo` on a coin
/// with no wallet raises — so the balance is unreadable *because* the push has
/// not happened, and the push is refused *because* the balance is unreadable.
/// BCH sat in exactly that loop from 2026-09-04 (see `log.md`): the console
/// read `NaN BCH` while the engine logged, every twenty seconds,
/// `getWalletInfo for Bitcoin Cash failed with: Bitcoin Cash wallet not
/// initialized (electrum mode)`.
///
/// The address list breaks the tie without guessing from an error string.
/// `getAllAddresses` reads `wallet_addresses`/`wallet_watch_only` straight out
/// of the engine's SQLite by `coin_type` (wallet_manager.py:664) — it does not
/// need the coin's wallet to be initialised, and it answers the only question
/// the gate actually cares about: **has this engine ever handed out an address
/// for this coin?** No addresses means nothing can be sitting on them, so
/// there is nothing to strand. Any addresses at all, or a list we cannot read,
/// keeps the refusal.
///
/// Not on the renderer allow-list, and deliberately not added to it: this
/// enumerates every address the engine holds, the wrapper UI has no use for
/// it, and the allow-list's own policy for read-only-but-unneeded endpoints is
/// "add deliberately, with a test". Nor does it go through
/// [`privileged_wallet_path`] — that constant is scoped to the two MUTATING
/// verbs on [`crate::swap_sidecar::DENIED_ENDPOINTS`], and putting a read
/// through it would make its own documentation false. The ticker is validated
/// against [`WALLET_SIDECAR_COINS`] the same way, so nothing renderer-derived
/// reaches the path either way.
pub(crate) async fn wallet_address_count(
    port: u16,
    auth: &str,
    ticker: &str,
) -> Result<usize, String> {
    if !is_known_ticker(ticker) {
        return Err(format!("{:?} is not a coin the swap node can run", ticker));
    }
    let url = format!("http://127.0.0.1:{}/json/wallets/{}/listaddresses", port, ticker);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", basic_auth_header(auth))
        .send()
        .await
        .map_err(|e| format!("swap node request failed: {}", e))?;
    let v = decode_json(resp).await?;
    address_count(&v)
}

/// The `addresses` array's length, or an error. A reply without the field is
/// an error, not an empty list — see [`wallet_address_count`] for why the
/// difference decides whether a key push is allowed.
pub(crate) fn address_count(v: &Value) -> Result<usize, String> {
    if let Some(e) = v.get("error") {
        return Err(format!(
            "the swap node could not list that wallet's addresses: {}",
            e
        ));
    }
    match v.get("addresses") {
        Some(Value::Array(a)) => Ok(a.len()),
        _ => Err("the swap node's address reply carried no list".to_string()),
    }
}

/// The `balance` field as a decimal **string** (contract §0.3 — amounts never
/// become numbers on the way through).
pub(crate) fn balance_string(v: &Value) -> Result<String, String> {
    match v.get("balance") {
        Some(Value::String(s)) => Ok(s.trim().to_string()),
        // Upstream normally stringifies, but `getWalletInfo` has paths that
        // hand back a float. Accepting it is not a licence to do arithmetic on
        // it — it is re-emitted as a string immediately.
        Some(Value::Number(n)) => Ok(n.to_string()),
        _ => Err("the swap node's wallet reply carried no balance".to_string()),
    }
}

/// C8 — may this coin's keys be replaced without stranding funds?
///
/// # Why a balance check gates a KEY push
///
/// Installing the host's account key makes the engine discard the address
/// table it built from its OWN key (PWNDA-PATCH-3's `_discardForeignAddresses`
/// — `getAddress` reads that table rather than deriving, so stale rows are
/// worse than useless). That is correct for the wallet, and destructive for
/// anything already sitting in the node's own deposit-mode wallet: those coins
/// stay on-chain and stay recoverable from the swap seed, but the engine stops
/// watching them, so the UI would simply show them gone.
///
/// So a non-zero balance is a REFUSAL with an instruction, not a warning:
/// sweep it back first (the C4 path, which exists and is one click), then
/// share. `Ok(())` only for a wallet with nothing to lose.
///
/// **Fails closed on an unreadable balance** for the same reason
/// [`reserved_balance_gate`] does: "could not measure" is not "measured zero",
/// and the cost of being wrong here is the user's funds disappearing from
/// their own UI.
///
/// ## The one exception, and why it is not a weakening (2026-09-05)
///
/// `addresses` is [`wallet_address_count`]'s answer for the same coin, or
/// `None` when that could not be read either. A coin the engine holds **no**
/// addresses for cannot be holding funds: every deposit route in this system
/// ends at an address the engine handed out and recorded. So
/// `(balance: None, addresses: Some(0))` is not "could not measure" — it is
/// "there is nothing to measure", and refusing it deadlocks the coin forever
/// (PWNDA-PATCH-3 will not build the wallet without the key; the key is not
/// sent without a balance; the balance needs the wallet). Every other
/// combination still refuses. BTC and LTC never met this because both were
/// adopted on 2026-08-20, hours BEFORE this gate was written — BCH was the
/// first coin to face it on a first-ever push, which is why a gate that could
/// not pass stood for two weeks looking correct.
pub(crate) fn pre_share_balance_gate(
    balance: Option<&str>,
    addresses: Option<usize>,
) -> Result<(), String> {
    let raw = match balance {
        None => {
            if addresses == Some(0) {
                // No wallet, no addresses, nothing to strand — and a coin with
                // no addresses can only be facing its FIRST push.
                return Ok(());
            }
            return Err(
                "the swap node's current balance for this coin could not be read, so \
                 its wallet was not replaced — try again once the node is responding"
                    .to_string(),
            )
        }
        Some(b) => b.trim(),
    };
    let parsed: f64 = raw.parse().map_err(|_| {
        format!(
            "the swap node reported an unreadable balance ({:?}), so its wallet was \
             not replaced",
            raw
        )
    })?;
    if !parsed.is_finite() {
        return Err(
            "the swap node reported a non-finite balance, so its wallet was not replaced"
                .to_string(),
        );
    }
    if parsed > 0.0 {
        return Err(format!(
            "the swap node already holds {} of this coin in its own wallet. Sweep it \
             back to your wallet first (Swap ▸ Sweep back), then this coin will use \
             your own wallet — sharing now would leave that balance unwatched",
            raw
        ));
    }
    Ok(())
}

/// Is this decimal-string amount worth sweeping?
///
/// Parses only to compare against zero, and **fails closed on an unreadable
/// string**: a balance we cannot parse is not one to drain with `subfee: true`,
/// which would otherwise ask the engine to build a transaction whose output is
/// negative.
pub(crate) fn is_sweepable_amount(amount: &str) -> Result<(), String> {
    let parsed: f64 = amount
        .trim()
        .parse()
        .map_err(|_| format!("the swap node reported an unreadable balance: {:?}", amount))?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err("that wallet's balance is zero — there is nothing to sweep".to_string());
    }
    Ok(())
}

// =========================================================================
// Commands
// =========================================================================

/// C4 — derive the destination, run the gates, mint a token. **Moves nothing.**
///
/// The `sc` state parameter is not in the frozen §1.6 signature. It is a Tauri
/// `State`, so it is injected rather than sent and the wire contract
/// (`{ sessionId, coin }`) is unchanged — but prepare cannot do its job without
/// it: the balance read and the reserved-balance gate both need the engine's
/// port and session credential.
#[tauri::command]
pub async fn swap_bridge_prepare_sweep(
    swap: tauri::State<'_, crate::swap::state::SwapState>,
    xmr: tauri::State<'_, crate::xmr_rpc::XmrRpcChild>,
    sc: tauri::State<'_, SwapSidecarState>,
    bridge: tauri::State<'_, SweepState>,
    session_id: String,
    coin: String,
) -> Result<SweepPlan, String> {
    let key = coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    let ticker = ticker_for(key);

    // Refuses unless the node is Healthy — a sweep off a node that is not
    // running cannot succeed anyway.
    let (port, auth) = api_context(&sc)?;

    // Cheapest refusal first, and the one that must not be skipped: draining
    // the wallet the engine is about to fund a lock from kills that swap.
    let in_flight = swap_sidecar::active_bids_for(&sc, key).await.ok();
    reserved_balance_gate(in_flight)?;

    // Destination. Derived here, or read from our own wallet-rpc; never taken
    // from the caller, and never guessed for a coin we do not handle.
    let destination = if is_utxo_family(key) {
        swap.with_session(&session_id, |mnemonic| -> Result<String, String> {
            let seed =
                crate::swap::derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            pinned_destination(&seed[..], key)
        })
        .ok_or_else(|| "the vault must be unlocked to prepare a sweep".to_string())??
    } else if key == "monero" {
        // Refuse rather than fall back. There is no second source for this
        // address that is more trustworthy than the wallet's own.
        crate::xmr_rpc::primary_address(&xmr).await.map_err(|e| {
            format!(
                "the Monero wallet is not reachable, so the sweep destination cannot \
                 be established: {}",
                e
            )
        })?
    } else {
        return Err(format!(
            "no sweep destination exists for {} — the wallet holds no account for it",
            key
        ));
    };

    // Amount. The XMR family sweeps everything; the bitcoin family needs an
    // explicit value, and `subfee: true` takes the fee out of it.
    let balance = wallet_balance(port, &auth, &ticker).await?;
    is_sweepable_amount(&balance)?;
    let sweepall = !is_utxo_family(key);
    let amount = if sweepall { None } else { Some(balance) };

    let ticket = new_ticket(
        mint_token()?,
        key,
        ticker,
        destination,
        amount,
        sweepall,
        SystemTime::now(),
    );
    stash_ticket(&bridge, ticket)
}

/// C4 — spend the token and perform the withdrawal. Resolves to the txid.
///
/// **There is no address parameter and there must never be one** (R13). See
/// `_pin_execute_sweep_signature` in the test module: it exists solely so that
/// adding one stops the build.
#[tauri::command]
pub async fn swap_bridge_execute_sweep(
    sc: tauri::State<'_, SwapSidecarState>,
    bridge: tauri::State<'_, SweepState>,
    token: String,
    confirm_phrase: String,
) -> Result<String, String> {
    let (port, auth) = api_context(&sc)?;
    let poster = HttpPoster { port, auth };
    execute_sweep_with(&poster, &bridge, &token, &confirm_phrase, SystemTime::now()).await
}

/// C6 — a fresh deposit address for the node's own wallet (an XMR subaddress).
///
/// Goes through the privileged door. `nextdepositaddr` is **not** added to the
/// webview allow-list and `check_endpoint` alone still refuses it — re-asserted
/// by `webview_route_still_denied` every phase (R15).
#[tauri::command]
pub async fn swap_bridge_next_deposit_addr(
    sc: tauri::State<'_, SwapSidecarState>,
    ticker: String,
) -> Result<String, String> {
    let key = coin_key_from(&ticker).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            ticker,
            WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    let t = ticker_for(key);
    let (port, auth) = api_context(&sc)?;
    let path = privileged_wallet_path(&t, "nextdepositaddr")?;
    let v = api_post_privileged(port, &auth, &path, json!({})).await?;
    extract_address(&v)
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swap::derive::{mnemonic_to_seed, utxo_address, UtxoChain};

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// BIP-84 m/84'/0'/0'/0/0 for [`ABANDON`] — the BIP-84 spec's own first
    /// receive address, pinned independently in `swap::derive`'s tests.
    const ABANDON_BTC: &str = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

    fn seed() -> Vec<u8> {
        mnemonic_to_seed(ABANDON, "").unwrap()[..].to_vec()
    }

    // ── the R13 compile-level barrier ───────────────────────────────
    //
    // This function is NEVER CALLED. Its entire purpose is to fail
    // compilation if `swap_bridge_execute_sweep`'s argument list changes —
    // an added `destination: String` above all. `#[cfg(test)]` items are
    // compiled whether or not anything references them, so the check runs
    // on every `cargo test` without a test needing to invoke it.
    #[allow(dead_code)]
    fn _pin_execute_sweep_signature(
        sc: tauri::State<'_, SwapSidecarState>,
        bridge: tauri::State<'_, SweepState>,
        token: String,
        confirm_phrase: String,
    ) {
        let _ = swap_bridge_execute_sweep(sc, bridge, token, confirm_phrase);
    }

    /// A transport that records instead of connecting.
    ///
    /// The recording is what makes "no HTTP was issued" assertable. A test that
    /// pointed a real client at a closed port could only ever assert "the
    /// request failed", which is equally true when the guard did nothing.
    struct RecordingPoster {
        calls: Mutex<Vec<(String, Value)>>,
        reply: Value,
    }

    impl RecordingPoster {
        fn replying(reply: Value) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                reply,
            }
        }
        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
        fn count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    impl EnginePoster for RecordingPoster {
        fn post<'a>(
            &'a self,
            path: &'a str,
            body: Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
            self.calls.lock().unwrap().push((path.to_string(), body));
            let reply = self.reply.clone();
            Box::pin(async move { Ok(reply) })
        }
    }

    fn btc_ticket(token: &str, minted_at: SystemTime) -> SweepTicket {
        new_ticket(
            token.to_string(),
            "bitcoin",
            "BTC".to_string(),
            ABANDON_BTC.to_string(),
            Some("0.5".to_string()),
            false,
            minted_at,
        )
    }

    fn store_with(ticket: SweepTicket) -> SweepState {
        let s = SweepState::new();
        stash_ticket(&s, ticket).unwrap();
        s
    }

    // ── C8 — the shared-coin send gate and body shape ───────────────

    fn opt_in_with(key: &str, adoption: Adoption) -> swap_sidecar::OptInRecord {
        let mut rec = swap_sidecar::OptInRecord::default();
        rec.opted_in = true;
        let mut entry = swap_sidecar::CoinOptIn::default();
        entry.enabled = true;
        entry.adoption = adoption;
        rec.coins.insert(key.to_string(), entry);
        rec
    }

    #[test]
    fn coin_is_verified_shared_requires_accountkey_not_just_consent() {
        // Positive control first.
        assert!(coin_is_verified_shared(
            &opt_in_with("bitcoin", Adoption::AccountKey),
            "bitcoin"
        ));
        // Every OTHER adoption state — including a coin the user consented to
        // share but the engine has not yet confirmed — must refuse. This is
        // the exact distinction the standing-issue review raised: consent and
        // verified fact are different, and a fund-moving command must gate on
        // the stronger one.
        for adoption in [
            Adoption::Descriptor,
            Adoption::Consolidate,
            Adoption::Deposit,
        ] {
            assert!(
                !coin_is_verified_shared(&opt_in_with("bitcoin", adoption), "bitcoin"),
                "{:?} must not be treated as verified-shared",
                adoption
            );
        }
        // Absent entirely (never enabled, or a pre-C8 record) must also refuse.
        assert!(!coin_is_verified_shared(
            &swap_sidecar::OptInRecord::default(),
            "bitcoin"
        ));
        // Verified on one coin must not leak to another.
        assert!(!coin_is_verified_shared(
            &opt_in_with("bitcoin", Adoption::AccountKey),
            "litecoin"
        ));
    }

    #[test]
    fn shared_withdraw_body_shape() {
        let body = shared_withdraw_body("bc1qexample", "0.25").unwrap();
        assert_eq!(body["address"], "bc1qexample");
        assert_eq!(body["value"], "0.25");
        // subfee:false — the opposite of the sweep's true. An ordinary send
        // pays exactly the amount; the sweep drains to zero.
        assert_eq!(body["subfee"], false);
    }

    #[test]
    fn shared_withdraw_body_refuses_bad_input() {
        assert!(shared_withdraw_body("", "0.25").is_err());
        assert!(shared_withdraw_body("   ", "0.25").is_err());
        assert!(shared_withdraw_body("bc1qexample", "not-a-number").is_err());
        assert!(shared_withdraw_body("bc1qexample", "0").is_err());
        assert!(shared_withdraw_body("bc1qexample", "-1").is_err());
        assert!(shared_withdraw_body("bc1qexample", "").is_err());
    }

    #[tokio::test]
    async fn execute_shared_withdraw_posts_to_the_right_privileged_path() {
        let poster = RecordingPoster::replying(json!({ "txid": "shared-tx-1" }));
        let txid = execute_shared_withdraw_with(&poster, "BTC", "bc1qexample", "0.1")
            .await
            .unwrap();
        assert_eq!(txid, "shared-tx-1");
        let calls = poster.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "wallets/BTC/withdraw");
        assert_eq!(calls[0].1["subfee"], false);
    }

    #[tokio::test]
    async fn execute_shared_withdraw_refuses_an_unknown_ticker_before_any_socket() {
        // Mirrors R13's "refused before a socket opens" discipline — a
        // recorder with zero calls is the only way to tell "the guard
        // refused" apart from "the network refused".
        let poster = RecordingPoster::replying(json!({ "txid": "should-not-happen" }));
        let err = execute_shared_withdraw_with(&poster, "NOTACOIN", "bc1qexample", "0.1")
            .await
            .unwrap_err();
        assert!(
            err.contains("not a coin the swap node can run"),
            "unexpected message: {err}"
        );
        assert_eq!(poster.count(), 0);
    }

    #[tokio::test]
    async fn execute_shared_withdraw_refuses_bad_amount_before_any_socket() {
        let poster = RecordingPoster::replying(json!({ "txid": "should-not-happen" }));
        let err = execute_shared_withdraw_with(&poster, "BTC", "bc1qexample", "0")
            .await
            .unwrap_err();
        assert!(err.contains("greater than zero"), "unexpected message: {err}");
        assert_eq!(poster.count(), 0);
    }

    #[test]
    fn shared_coin_withdraw_command_signature_carries_the_reserved_balance_gate() {
        // Rather than construct a live SwapSidecarState/AppHandle (this
        // command needs both, and the fixture cost is not worth it here), a
        // source scan confirms the gate is actually IN the command body, not
        // merely available in the module. This is the shape
        // `attacker_destination_is_refused` uses for the same reason: the unit
        // tests above prove `reserved_balance_gate` and `active_bids_for`
        // behave correctly in isolation; this proves the command actually
        // calls them, which a pure-function test cannot.
        const THIS_FILE: &str = include_str!("swap_bridge.rs");
        let at = THIS_FILE
            .find("pub async fn swap_bridge_shared_coin_withdraw(")
            .expect("the command must exist");
        let end = at + THIS_FILE[at..]
            .find("\r\n}\r\n")
            .or_else(|| THIS_FILE[at..].find("\n}\n"))
            .expect("the command body must end");
        let body = &THIS_FILE[at..end];
        assert!(
            body.contains("reserved_balance_gate(in_flight)"),
            "the reserved-balance gate must run before the transport call:
{body}"
        );
        assert!(
            body.contains("active_bids_for(&sc, key)"),
            "the in-flight count must come from the engine's own bid list:
{body}"
        );
        // And it must run AFTER the shared-wallet check, not before — a coin
        // that is not shared has no business being asked about in-flight bids
        // for THIS purpose at all.
        let shared_check_at = body.find("coin_is_verified_shared").unwrap();
        let gate_at = body.find("reserved_balance_gate(in_flight)").unwrap();
        assert!(
            shared_check_at < gate_at,
            "the shared-wallet check must run before the reserved-balance gate"
        );
    }

    #[tokio::test]
    async fn execute_shared_withdraw_surfaces_an_engine_error_body() {
        // upstream returns errors with HTTP 200 (contract's own note on
        // extract_txid) — the recorder still "succeeds" the HTTP call, and the
        // error must come from the BODY, not the transport.
        let poster = RecordingPoster::replying(json!({ "error": "insufficient funds" }));
        let err = execute_shared_withdraw_with(&poster, "BTC", "bc1qexample", "0.1")
            .await
            .unwrap_err();
        assert!(err.contains("insufficient funds"), "unexpected message: {err}");
    }

    // ── R13 — the destination cannot come from the caller ───────────

    /// **R13.** Two halves, and they cover different failure modes.
    ///
    /// 1. *Compile level.* `_pin_execute_sweep_signature` above only builds
    ///    while the command takes exactly `(State, State, String, String)`. An
    ///    added address parameter is a build failure, not a test failure.
    /// 2. *Value level.* The destination a prepare would pin for BTC is
    ///    byte-identical to the address the wallet itself shows for that seed.
    ///    A derivation that drifted — wrong chain, wrong account, wrong index —
    ///    goes red here even though everything still "works".
    ///
    /// The source scan is the third leg: it catches the one mutation the
    /// compile pin cannot see, namely *renaming* `confirm_phrase` to
    /// `destination` while keeping the arity and types.
    #[test]
    fn attacker_destination_is_refused() {
        let seed = seed();

        // (2) the pinned destination IS the wallet's own address.
        assert_eq!(
            pinned_destination(&seed, "btc").unwrap(),
            utxo_address(&seed, UtxoChain::Btc, 0, 0).unwrap(),
            "the sweep destination must be the wallet's own BTC address"
        );
        assert_eq!(pinned_destination(&seed, "btc").unwrap(), ABANDON_BTC);
        // Every other UTXO coin must pin to ITS OWN chain, so a copy-paste that
        // pointed two coins at one encoder goes red.
        for (coin, chain) in [
            ("litecoin", UtxoChain::Ltc),
            ("dogecoin", UtxoChain::Doge),
            ("dash", UtxoChain::Dash),
            ("bitcoincash", UtxoChain::Bch),
        ] {
            assert_eq!(
                pinned_destination(&seed, coin).unwrap(),
                utxo_address(&seed, chain, 0, 0).unwrap(),
                "{coin} must pin to its own chain's address"
            );
        }

        // (3) the source-level half.
        const THIS_FILE: &str = include_str!("swap_bridge.rs");
        let at = THIS_FILE
            .find("pub async fn swap_bridge_execute_sweep(")
            .expect("the execute command must exist");
        let end = at + THIS_FILE[at..]
            .find(") -> Result")
            .expect("its signature must end in a Result");
        let sig = &THIS_FILE[at..end];
        // Positive control FIRST: if the slice were wrong, every negative
        // assertion below would pass vacuously.
        assert!(
            sig.contains("bridge: tauri::State") && sig.contains("token: String"),
            "the signature scan is reading the wrong text — it must contain the \
             state and token params:\n{sig}"
        );
        assert!(
            sig.contains("confirm_phrase: String"),
            "the confirm phrase must still be a parameter:\n{sig}"
        );
        for banned in ["address", "destination", "dest", "recipient", "payto"] {
            assert!(
                !sig.contains(banned),
                "`{banned}` must never appear in execute_sweep's parameter list — \
                 the whole C4 security argument is that no code path takes a \
                 destination from the renderer:\n{sig}"
            );
        }
    }

    /// **R13, paired.** An unhandled coin can never sweep to a wrong-chain
    /// address.
    ///
    /// The failure this guards against is not an error — it is a *success* that
    /// sends BTC to a string encoded for another chain. So the assertion is not
    /// "it errs", it is "it errs **and** the error is not an address".
    #[test]
    fn unknown_coin_refused() {
        let seed = seed();
        let btc = utxo_address(&seed, UtxoChain::Btc, 0, 0).unwrap();

        for coin in [
            "zephyr",     // a wallet coin the swap node does not run
            "ethereum",   // not UTXO at all
            "",           //
            "particl",    // the node runs it; the WALLET has no account for it
            "monero",     // handled, but by the wallet-rpc, never by derivation
            "bitcoin gold",
            "BTC ",       // note: coin_key_from trims, so this one SHOULD resolve
        ] {
            let got = pinned_destination(&seed, coin);
            if coin.trim().eq_ignore_ascii_case("btc") {
                // The positive control inside the loop: without it, a
                // `pinned_destination` that returned `Err` for absolutely
                // everything would pass this test.
                assert_eq!(got.unwrap(), btc, "a valid coin must still resolve");
                continue;
            }
            let e = got.unwrap_err();
            assert!(
                !e.contains(&btc),
                "the refusal for {coin:?} must not carry an address: {e}"
            );
        }

        // …and the classifier that decides which branch runs agrees.
        assert!(is_utxo_family("bitcoin") && is_utxo_family("BCH"));
        assert!(!is_utxo_family("monero"));
        assert!(!is_utxo_family("particl"));
        assert!(!is_utxo_family("zephyr"));
    }

    // ── R14 — replay and mis-confirmation ───────────────────────────

    /// **R14.** A token is spendable exactly once, and only inside its TTL.
    #[tokio::test]
    async fn token_is_single_use_and_expires() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let phrase = confirm_phrase_for(ABANDON_BTC);
        let poster = RecordingPoster::replying(json!({ "txid": "aabbcc" }));

        // ── single use ──
        let store = store_with(btc_ticket("tok-a", now));
        let txid = execute_sweep_with(&poster, &store, "tok-a", &phrase, now)
            .await
            .expect("the first execute must succeed");
        assert_eq!(txid, "aabbcc");
        assert_eq!(poster.count(), 1, "the first execute must reach the engine");

        let err = execute_sweep_with(&poster, &store, "tok-a", &phrase, now)
            .await
            .expect_err("a spent token must not work twice");
        assert!(
            err.contains("no sweep is prepared"),
            "unexpected second-use error: {err}"
        );
        assert_eq!(
            poster.count(),
            1,
            "a spent token must not reach the engine a second time"
        );

        // ── expiry: minted at T-121 s, so the deadline is 1 s in the past ──
        let minted_at = now - Duration::from_secs(121);
        let store = store_with(btc_ticket("tok-b", minted_at));
        let err = execute_sweep_with(&poster, &store, "tok-b", &phrase, now)
            .await
            .expect_err("a token past its TTL must not work");
        assert!(err.contains("expired"), "unexpected expiry error: {err}");
        assert_eq!(poster.count(), 1, "an expired token must issue no request");

        // The bracketing case, so "expires" is not just "always refuses":
        // minted at T-119 s is still inside the 120 s window.
        let store = store_with(btc_ticket("tok-c", now - Duration::from_secs(119)));
        execute_sweep_with(&poster, &store, "tok-c", &phrase, now)
            .await
            .expect("a token one second inside its TTL must still work");
        assert_eq!(poster.count(), 2);
    }

    /// **R14.** A wrong confirmation issues **no request at all**.
    ///
    /// The recorder is what makes that assertable — and the paired positive at
    /// the end is what stops it being vacuous: a recorder that never recorded
    /// anything would satisfy the negative assertion on its own.
    #[tokio::test]
    async fn confirm_phrase_mismatch_refuses() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let poster = RecordingPoster::replying(json!({ "txid": "deadbeef" }));
        let store = store_with(btc_ticket("tok", now));

        for wrong in [
            "",
            "306FYU",             // right characters, wrong case
            "z306fy",             // off by one position
            ABANDON_BTC,          // the whole address is not the phrase
            "306fyu ",            // trailing space is trimmed, so this one PASSES
        ] {
            if wrong.trim() == confirm_phrase_for(ABANDON_BTC) {
                continue;
            }
            let err = execute_sweep_with(&poster, &store, "tok", wrong, now)
                .await
                .expect_err("a wrong confirmation must be refused");
            assert!(
                err.contains("confirmation does not match"),
                "unexpected refusal for {wrong:?}: {err}"
            );
        }
        assert_eq!(
            poster.calls(),
            Vec::<(String, Value)>::new(),
            "a mismatched confirmation must issue NO request — not a failed one"
        );

        // A wrong token is likewise silent on the wire…
        let err = execute_sweep_with(&poster, &store, "not-the-token", "306fyu", now)
            .await
            .expect_err("a wrong token must be refused");
        assert!(err.contains("not the prepared one"), "{err}");
        assert_eq!(poster.count(), 0);

        // …and neither refusal burned the ticket: the RIGHT inputs still work.
        // Without this the assertions above would also pass for a function that
        // refuses everything, or for a recorder that never records.
        let txid = execute_sweep_with(&poster, &store, "tok", " 306fyu ", now)
            .await
            .expect("the correct token + phrase must still work afterwards");
        assert_eq!(txid, "deadbeef");
        assert_eq!(poster.count(), 1);
        assert_eq!(poster.calls()[0].0, "wallets/BTC/withdraw");
    }

    /// The phrase is the last six characters, and nothing shorter is accepted.
    #[test]
    fn confirm_phrase_is_the_last_six_characters() {
        assert_eq!(confirm_phrase_for(ABANDON_BTC), "306fyu");
        assert_eq!(confirm_phrase_for("abc"), "abc");
        assert_eq!(confirm_phrase_for(""), "");

        // A destination-less ticket can never be confirmed by typing nothing.
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let mut t = btc_ticket("tok", now);
        t.destination = String::new();
        let store = store_with(t);
        assert!(consume_ticket(&store, "tok", "", now).is_err());
    }

    // ── R15 — the webview route is still shut ───────────────────────

    /// **R15.** After the privileged path exists, `check_endpoint` **alone**
    /// still refuses the endpoints it opens.
    ///
    /// Asserting on `check_endpoint` rather than on `build_api_url` is the
    /// point: `build_api_url` also consults the denylist, so a version of this
    /// test that only used it would keep passing after someone widened the
    /// allow-list, which is the exact mistake being guarded against.
    #[test]
    fn webview_route_still_denied() {
        use swap_sidecar::{build_api_url, check_endpoint, is_denied_endpoint};
        let segs = |p: &str| p.split('/').map(String::from).collect::<Vec<_>>();

        for path in [
            "wallets/XMR/withdraw",
            "wallets/XMR/nextdepositaddr",
            "wallets/BTC/withdraw",
            "wallets/BTC/nextdepositaddr",
            "wallets/PART/withdraw",
        ] {
            assert!(
                check_endpoint(&segs(path), ApiMethod::Post).is_err(),
                "check_endpoint ALONE must refuse POST {path}"
            );
            assert!(
                check_endpoint(&segs(path), ApiMethod::Get).is_err(),
                "check_endpoint ALONE must refuse GET {path}"
            );
            assert!(is_denied_endpoint(path), "{path} must stay on the denylist");
            assert!(
                build_api_url(1234, path, ApiMethod::Post).is_err(),
                "no webview URL may be built for {path}"
            );
        }

        // The standing C5/C0 regression, re-run here: these stay unreachable
        // for every phase, and `check_endpoint` alone is what must say no.
        for name in ["withdraw", "getcoinseed", "setpassword", "unlock", "lock"] {
            assert!(
                check_endpoint(&segs(name), ApiMethod::Post).is_err(),
                "check_endpoint ALONE must refuse {name}"
            );
        }

        // Positive control: an allow-listed read still passes. Without it, a
        // `check_endpoint` that had been broken into refusing everything would
        // make every assertion above pass for the wrong reason.
        assert!(check_endpoint(&segs("wallets/XMR"), ApiMethod::Get).is_ok());
        assert!(check_endpoint(&segs("coins"), ApiMethod::Get).is_ok());
    }

    /// The privileged door only opens for the two literal verbs, and the check
    /// happens **before** a socket does.
    ///
    /// The falsifier is the second half: a *listed* path against the same
    /// absent port fails with a transport error, which proves the first
    /// failure came from the guard rather than from the network.
    #[tokio::test]
    async fn privileged_path_is_checked_before_the_socket() {
        // Port 1 is privileged and never bound by this process, so any attempt
        // to connect fails immediately.
        const ABSENT: u16 = 1;

        for path in [
            "wallets/BTC/createutxo",  // a real upstream verb, not ours
            "wallets/BTC/reseed",
            "wallets/ZZZ/withdraw",    // unknown ticker
            "wallets/BTC",             // too few segments
            "wallets/BTC/withdraw/x",  // too many
            "unlock",
            "../wallets/BTC/withdraw",
        ] {
            let e = api_post_privileged(ABSENT, "pw", path, json!({}))
                .await
                .expect_err("must refuse");
            assert!(
                e.contains("not a privileged swap-node endpoint"),
                "{path} must be refused by the GUARD, not by the network: {e}"
            );
        }

        // Falsifier: the guard passes, so the failure now comes from the wire.
        let e = api_post_privileged(ABSENT, "pw", "wallets/BTC/withdraw", json!({}))
            .await
            .expect_err("nothing is listening on port 1");
        assert!(
            e.starts_with(NODE_UNREACHABLE_PREFIX),
            "a LISTED path must get past the guard and fail on the network \
             instead — otherwise the assertions above prove nothing: {e}"
        );
        // And a connection REFUSED is the retry-safe class, never the
        // lost-reply class: nothing was sent, so nothing can have landed.
        assert!(
            !is_transport_failure(&e),
            "refused-before-send must not read as a lost reply: {e}"
        );
    }

    /// The path builder cannot be handed a verb that is not one of the two.
    #[test]
    fn privileged_wallet_path_shape() {
        assert_eq!(
            privileged_wallet_path("XMR", "nextdepositaddr").unwrap(),
            "wallets/XMR/nextdepositaddr"
        );
        assert_eq!(
            privileged_wallet_path("BTC", "withdraw").unwrap(),
            "wallets/BTC/withdraw"
        );
        assert!(privileged_wallet_path("BTC", "createutxo").is_err());
        assert!(privileged_wallet_path("btc", "withdraw").is_err(), "tickers are UPPERCASE");
        assert!(privileged_wallet_path("ZZZ", "withdraw").is_err());
        // Every sidecar coin's ticker resolves, so the check is derived from
        // WALLET_SIDECAR_COINS rather than from a second hand-written list.
        for coin in WALLET_SIDECAR_COINS {
            assert!(privileged_wallet_path(&ticker_for(coin), "withdraw").is_ok(), "{coin}");
        }
    }

    // ── the reserved-balance gate ───────────────────────────────────

    /// A count we could not read is not a count of zero.
    #[test]
    fn pre_share_balance_gate_refuses_a_funded_wallet() {
        // Zero is the only pass: the key swap makes the engine forget its own
        // addresses, so anything sitting on them would vanish from the UI.
        assert!(pre_share_balance_gate(Some("0"), None).is_ok());
        assert!(pre_share_balance_gate(Some("0.00000000"), None).is_ok());

        let e = pre_share_balance_gate(Some("0.00000001"), None).unwrap_err();
        assert!(e.contains("Sweep it back"), "unexpected: {e}");
        assert!(e.contains("0.00000001"), "must quote the balance: {e}");

        // Fails CLOSED — unreadable is not zero.
        assert!(pre_share_balance_gate(None, None).is_err());
        assert!(pre_share_balance_gate(Some(""), None).is_err());
        assert!(pre_share_balance_gate(Some("not-a-number"), None).is_err());
        assert!(pre_share_balance_gate(Some("NaN"), None).is_err());
        assert!(pre_share_balance_gate(Some("inf"), None).is_err());

        // A READABLE balance is decided on its own: the address count is not
        // an override, so a funded wallet stays refused however many (or few)
        // addresses the engine reports.
        assert!(pre_share_balance_gate(Some("0.5"), Some(0)).is_err());
    }

    /// The 2026-09-05 deadlock, pinned: a coin the engine has never handed out
    /// an address for has nothing to strand, so an unreadable balance must NOT
    /// refuse its first key push.
    ///
    /// Without this, BCH could never be adopted at all — PWNDA-PATCH-3 refuses
    /// to build the wallet until the key arrives, `getWalletInfo` raises while
    /// there is no wallet (`{"error": "getWalletInfo failed for coin: 17"}`,
    /// verbatim from the running node), and the gate read that as "could not
    /// measure". The console showed `NaN BCH` for a day with no error anywhere
    /// a user could see.
    #[test]
    fn an_unread_balance_with_no_addresses_is_a_first_push_not_a_risk() {
        // The BCH case: no wallet, no addresses → allowed.
        assert!(pre_share_balance_gate(None, Some(0)).is_ok());

        // The BTC case: the engine holds 40 addresses and the balance read
        // failed → still refused, because those addresses may hold coin.
        let e = pre_share_balance_gate(None, Some(40)).unwrap_err();
        assert!(e.contains("could not be read"), "unexpected: {e}");
        assert!(pre_share_balance_gate(None, Some(1)).is_err());

        // The address list itself was unreadable → refused. "Could not ask"
        // is not "asked and got zero", which is the whole reason this
        // parameter is an Option rather than a usize.
        assert!(pre_share_balance_gate(None, None).is_err());
    }

    /// `addresses` reads the engine's own list, and an absent list is an
    /// error rather than an empty one — the distinction the gate rests on.
    #[test]
    fn address_count_reads_the_list_and_refuses_a_reply_without_one() {
        assert_eq!(address_count(&json!({"addresses": []})).unwrap(), 0);
        assert_eq!(
            address_count(&json!({"addresses": ["bitcoincash:qq", "bitcoincash:qp"]})).unwrap(),
            2
        );
        assert!(address_count(&json!({})).is_err());
        assert!(address_count(&json!({"addresses": "two"})).is_err());
        // The engine's own error reply is an error, not an empty wallet —
        // otherwise a node that answered "coin not supported" would look
        // exactly like a fresh coin and unlock the push.
        assert!(address_count(&json!({"error": "getWalletInfo failed for coin: 17"})).is_err());
    }

    #[test]
    fn reserved_balance_gate_fails_closed() {
        assert!(reserved_balance_gate(Some(0)).is_ok());
        let e = reserved_balance_gate(None).unwrap_err();
        assert!(e.contains("could not be read"), "{e}");
        let e = reserved_balance_gate(Some(2)).unwrap_err();
        assert!(e.contains("2 swap(s) in flight"), "{e}");
    }

    // ── wire shapes ─────────────────────────────────────────────────

    /// `withdraw_coin` reads different keys per family (js_server.py:66-95).
    /// Sending the wrong set is a 500 at best and a wrong amount at worst.
    #[test]
    fn withdraw_body_matches_upstream_per_family() {
        let now = SystemTime::UNIX_EPOCH;
        let btc = withdraw_body(&btc_ticket("t", now)).unwrap();
        assert_eq!(
            btc,
            json!({ "address": ABANDON_BTC, "value": "0.5", "subfee": true })
        );
        assert!(
            btc.get("sweepall").is_none(),
            "the bitcoin family has no sweepall — upstream would KeyError on value"
        );

        let xmr = new_ticket(
            "t".into(),
            "monero",
            "XMR".into(),
            "4Addr".into(),
            None,
            true,
            now,
        );
        let body = withdraw_body(&xmr).unwrap();
        assert_eq!(body, json!({ "address": "4Addr", "sweepall": true }));
        assert!(
            body.get("subfee").is_none() && body.get("value").is_none(),
            "the XMR family reads sweepall, and value only when it is false"
        );

        // Amount is decimal-STRING all the way through (contract §0.3).
        assert!(btc.get("value").unwrap().is_string());
    }

    #[test]
    fn amounts_stay_strings_and_zero_is_refused() {
        assert_eq!(balance_string(&json!({"balance": "1.25"})).unwrap(), "1.25");
        assert_eq!(balance_string(&json!({"balance": 1.25})).unwrap(), "1.25");
        assert!(balance_string(&json!({})).is_err());

        assert!(is_sweepable_amount("0.00000001").is_ok());
        assert!(is_sweepable_amount("0").is_err());
        assert!(is_sweepable_amount("0.0").is_err());
        assert!(is_sweepable_amount("-1").is_err());
        assert!(is_sweepable_amount("").is_err());
        assert!(is_sweepable_amount("Refresh necessary").is_err());
        assert!(is_sweepable_amount("NaN").is_err());
    }

    /// `nextdepositaddr` answers with a bare JSON string, not an object.
    #[test]
    fn extract_address_accepts_the_bare_string_form() {
        assert_eq!(extract_address(&json!("8Bxyz")).unwrap(), "8Bxyz");
        assert_eq!(
            extract_address(&json!({ "address": "8Bxyz" })).unwrap(),
            "8Bxyz"
        );
        assert!(extract_address(&json!({ "error": "locked" })).is_err());
        assert!(extract_address(&json!("")).is_err());
        assert!(extract_address(&json!({})).is_err());
    }

    /// Upstream returns errors with HTTP 200 and an `error` key, so a 2xx is
    /// not by itself proof that anything was sent.
    #[test]
    fn extract_txid_treats_a_200_error_body_as_a_failure() {
        assert_eq!(extract_txid(&json!({"txid": "ab"})).unwrap(), "ab");
        let e = extract_txid(&json!({"error": "Insufficient funds"})).unwrap_err();
        assert!(e.contains("Insufficient funds"), "{e}");
        assert!(extract_txid(&json!({"txid": ""})).is_err());
        assert!(extract_txid(&json!({})).is_err());
    }

    /// **R16-shaped.** The plan's Debug must not print the live capability.
    #[test]
    fn debug_never_prints_the_token() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let ticket = btc_ticket("super-secret-token", now);
        let store = SweepState::new();
        let plan = stash_ticket(&store, ticket.clone()).unwrap();

        for rendered in [format!("{:?}", plan), format!("{:?}", ticket)] {
            assert!(
                !rendered.contains("super-secret-token"),
                "a live sweep token must not survive a Debug render: {rendered}"
            );
            assert!(rendered.contains("<redacted>"), "{rendered}");
            // Positive control: the non-secret fields ARE there, so the
            // assertion above cannot pass because Debug renders nothing.
            assert!(rendered.contains(ABANDON_BTC), "{rendered}");
        }

        // …but the renderer still receives it, because it has to hand it back.
        let wire = serde_json::to_string(&plan).unwrap();
        assert!(wire.contains("super-secret-token"));
    }

    /// Every `State<'_, T>` these commands take must be `.manage()`d.
    ///
    /// This is the one failure in the module that **nothing else can catch**:
    /// `State` resolves at *invoke* time, so a missing `.manage()` compiles
    /// cleanly, passes every unit test, registers fine — and then every sweep
    /// fails at runtime with an opaque state error. `lib.rs`'s own comments
    /// warn about exactly this trap for the three states that came before;
    /// this asserts it instead of warning about it.
    #[test]
    fn every_state_the_bridge_needs_is_managed() {
        const LIB_RS: &str = include_str!("lib.rs");

        // Only the builder chain, so a `.manage(` mentioned in a comment or in
        // some other function cannot satisfy this.
        let start = LIB_RS
            .find(".manage(miners::MinerProcess")
            .expect("the builder's manage chain must start at the miner states");
        let end = start
            + LIB_RS[start..]
                .find("// ── Tauri command surface")
                .expect("the manage chain must end before the command surface");
        let managed = LIB_RS[start..end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("
");

        for state in [
            "swap_bridge::SweepState",
            "swap_sidecar::SwapSidecarState",
            "swap::state::SwapState",
            "xmr_rpc::XmrRpcChild",
        ] {
            assert!(
                managed.contains(state),
                "{state} is taken by a swap_bridge command but never `.manage()`d —                  that fails at INVOKE time, not at build time. Chain:
{managed}"
            );
        }

        // …and all three commands are actually registered, which is the other
        // half of "compiles but is unreachable".
        let h_start = LIB_RS
            .find("generate_handler![")
            .expect("lib.rs must register commands");
        let h_end = h_start
            + LIB_RS[h_start..]
                .find("
        ])")
                .expect("the handler list must be delimited by its closing `])`");
        let handlers = LIB_RS[h_start..h_end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("
");
        for cmd in [
            "swap_bridge_prepare_sweep",
            "swap_bridge_execute_sweep",
            "swap_bridge_next_deposit_addr",
        ] {
            assert!(handlers.contains(cmd), "{cmd} is not registered:
{handlers}");
        }
        // Negative control: the F4-removed rotation must still NOT be there,
        // so this slice is proven to be discriminating rather than a substring
        // search over the whole file.
        assert!(
            !handlers.contains("rotate_wallet_password"),
            "the handler slice is wrong or F4 regressed:
{handlers}"
        );
    }

    /// camelCase over the wire (contract §0.1), including `expiresAt`.
    #[test]
    fn plan_serializes_camel_case() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let store = SweepState::new();
        let plan = stash_ticket(&store, btc_ticket("t", now)).unwrap();
        let v: Value = serde_json::from_str(&serde_json::to_string(&plan).unwrap()).unwrap();
        for key in ["token", "coin", "destination", "amount", "sweepall", "expiresAt"] {
            assert!(v.get(key).is_some(), "missing {key}: {v}");
        }
        assert!(v.get("expires_at").is_none(), "snake_case must not leak: {v}");
        // The deadline is minted_at + TTL, rendered RFC3339.
        assert!(
            v["expiresAt"].as_str().unwrap().starts_with("2023-11-14T22:15:2"),
            "{v}"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADVERSARIAL REVIEW — R13 defeated end-to-end
    //
    // `attacker_destination_is_refused` proves the derivation is correct
    // GIVEN a seed. It never asks where the seed comes from. The seed comes
    // from `SwapState::with_session(session_id)`, and the session is
    // installed by `swap::commands::swap_unlock(encrypted, password)` —
    // BOTH of which are renderer-supplied command parameters, with no
    // binding whatsoever to the vault on disk (`keystore::decrypt_vault`
    // decrypts the blob it was handed).
    //
    // So the renderer does not need an address parameter. It supplies the
    // SEED, and `pinned_destination` politely encodes the attacker's own
    // address for it.
    // ═══════════════════════════════════════════════════════════════════

    /// A valid BIP-39 phrase that is NOT the user's. (Trezor test vector.)
    const ATTACKER: &str =
        "legal winner thank year wave sausage worth useful legal winner thank yellow";


    /// **R13 — the seam the review found, and the guard that closes it.**
    ///
    /// The sweep destination is derived from the unlocked session, so whoever
    /// controls the session controls where the money goes. `execute_sweep`
    /// having no address parameter was documented as the security property; it
    /// is not, on its own — the caller chooses the *seed*, so the caller
    /// chooses the address.
    ///
    /// What makes it safe is upstream of this module: `swap_unlock` now
    /// refuses any vault blob that does not byte-match the one on disk
    /// (`swap::commands::assert_vault_matches_disk`), so a renderer cannot
    /// install a foreign seed without the user's real password. This test
    /// pins the consequence — that a session and the user's wallet agree —
    /// and `swap::commands::vault_binding_tests` pins the guard itself and
    /// that it is wired in ahead of the decrypt.
    #[tokio::test]
    async fn sweep_destination_is_the_session_seeds_own_address() {
        use crate::swap::state::SwapState;

        let user_seed = seed();
        let user_btc = utxo_address(&user_seed, UtxoChain::Btc, 0, 0).unwrap();
        assert_eq!(user_btc, ABANDON_BTC, "fixture sanity");

        // A session opened from the USER's mnemonic — which, post-fix, is the
        // only session `swap_unlock` can produce, because the blob it decrypts
        // has to be the vault this installation stores.
        let state = SwapState::new();
        let (session_id, _) = state.unlock(zeroize::Zeroizing::new(ABANDON.to_string()));

        // The destination block, copied verbatim from prepare_sweep.
        let destination = state
            .with_session(&session_id, |mnemonic| -> Result<String, String> {
                let s = mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
                pinned_destination(&s[..], "bitcoin")
            })
            .expect("session resolves")
            .expect("destination derives");

        assert_eq!(
            destination, user_btc,
            "a sweep must land in the wallet's own address"
        );
        assert_ne!(
            destination,
            utxo_address(
                &mnemonic_to_seed(&zeroize::Zeroizing::new(ATTACKER.to_string()), "").unwrap()[..],
                UtxoChain::Btc,
                0,
                0
            )
            .unwrap(),
            "and must never be some other seed's address"
        );
    }

    /// The rest of the chain, end to end: whatever destination the ticket was
    /// minted with is exactly what the engine is asked to pay.
    ///
    /// Worth stating plainly, because it is what the review turned on: the
    /// single-use token and the confirm phrase are **mis-click guards, not
    /// authorization**. The phrase is derived from the destination and shown to
    /// the user, so a caller holding the plan already holds the phrase. All the
    /// security in this path rests on the destination being trustworthy, which
    /// is why `swap_unlock` must bind the session to the on-disk vault
    /// (`swap::commands::vault_binding_tests`). Nothing here can compensate for
    /// a session opened around a foreign seed.
    #[tokio::test]
    async fn the_chain_pays_exactly_the_ticket_destination() {
        let user_seed = seed();
        let user_btc = utxo_address(&user_seed, UtxoChain::Btc, 0, 0).unwrap();

        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let store = store_with(new_ticket(
            "tok".into(),
            "bitcoin",
            "BTC".into(),
            user_btc.clone(),
            Some("0.5".into()),
            false,
            now,
        ));
        let phrase = confirm_phrase_for(&user_btc);

        let poster = RecordingPoster::replying(json!({ "txid": "ok" }));
        let txid = execute_sweep_with(&poster, &store, "tok", &phrase, now)
            .await
            .expect("the happy path completes");

        assert_eq!(txid, "ok");
        let (path, body) = poster.calls()[0].clone();
        assert_eq!(path, "wallets/BTC/withdraw");
        assert_eq!(
            body["address"].as_str().unwrap(),
            user_btc,
            "the engine must be asked to pay the ticket's destination, unaltered: {body}"
        );
    }
}
