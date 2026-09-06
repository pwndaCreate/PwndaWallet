//! C2 — daemon-direct routing.
//!
//! # Why this module exists
//!
//! Pwnda and BasicSwap would otherwise each run their own coin selection over
//! the same coins. Two selectors over one pot of UTXOs is a race with no
//! referee: the engine reserves an input for a swap leg with `lockunspent`,
//! Pwnda's own selector knows nothing about that reservation, spends it, and
//! the swap leg dies at broadcast — on a live swap that can forfeit the leg.
//!
//! The fix is structural rather than cooperative. Instead of teaching two
//! selectors to negotiate, Pwnda stops selecting: a bitcoin-family send is
//! built by the **same daemon wallet BasicSwap is using**, via
//! `createrawtransaction` -> `fundrawtransaction`. Core's own coin selection
//! then honours its own `lockunspent` set for free, and the race becomes
//! impossible rather than unlikely. There is exactly one selection authority
//! per coin, and it is the daemon.
//!
//! # Why not the engine's `withdraw` endpoint
//!
//! Because it has no fee parameter. `wallets/<t>/withdraw` picks its own fee,
//! which makes "send at 3 sat/vB" or "confirm within 6 blocks" unexpressible —
//! and a wallet that cannot control its fee is not a wallet a user can rely on
//! during congestion. Fee control (`conf_target` / `fee_rate`) is the entire
//! stated reason this module talks to the daemon instead. `withdraw` also
//! stays on [`crate::swap_sidecar::DENIED_ENDPOINTS`], unreachable from the
//! webview; that does not change here.
//!
//! # The safety model (contract R7)
//!
//! **The renderer never names an RPC method.** A `daemon_rpc` that could be
//! handed an arbitrary method string from the webview is a full wallet
//! compromise in one hop — `walletpassphrase`, `dumpprivkey`, `sethdseed` and
//! `importprivkey` all live on the same socket as `fundrawtransaction`. So:
//!
//! * [`daemon_rpc`] takes `method: &'static str`, which makes a
//!   renderer-derived `String` a **compile** error at every call site, and
//!   checks it against [`DAEMON_METHODS`] **before** a socket is opened, which
//!   makes an unlisted literal a runtime refusal.
//! * The allow-list is exactly the nine methods this module actually issues.
//!   Nothing on it can move funds by itself except `sendrawtransaction`, which
//!   needs a signed transaction this module built.
//! * The signed transaction hex never crosses the Tauri boundary — the caller
//!   gets a txid or nothing.
//!
//! Layered on top: routing is off unless `PWNDA_SWAP_ROUTING=1`; broadcast on
//! anything that is not regtest additionally needs
//! `PWNDA_SWAP_ROUTING_MAINNET=1`; the daemon must be loopback and
//! bitcoin-family; and the supervisor must be `Healthy`, because the
//! reservations we are honouring only exist while the engine is up.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::AppHandle;

use crate::swap_sidecar::{
    self, cookie_auth, is_loopback, parse_chain_daemon_targets, strip_bom, DaemonKind, Network,
    Phase, SwapSidecarState,
};

// =========================================================================
// The allow-list (R7)
// =========================================================================

/// Every JSON-RPC method this module is permitted to issue.
///
/// Deliberately the *exact* set the code below calls, not "read-only methods
/// plus the ones we need". A method that is not used has no business being
/// reachable, and a list wider than its call sites is a list nobody re-derives
/// when a call site is deleted.
///
/// Kept sorted so a diff that adds an entry is impossible to miss in review.
pub(crate) const DAEMON_METHODS: &[&str] = &[
    "createrawtransaction",
    "decoderawtransaction",
    "fundrawtransaction",
    "getblockchaininfo",
    "getwalletinfo",
    "help",
    // Public form ONLY. `swap_daemon_capture_xpubs` calls this with
    // `listdescriptors_params()` == `[]`; passing `true` returns xprv/zprv and
    // is the R8 catastrophe. The parameters are a function, not a literal, so
    // `capture_never_asks_for_private_descriptors` can assert what goes on the
    // wire, and every key that comes back is re-classified against
    // `PUBLIC_EXTKEY_PREFIXES` before anything is written.
    "listdescriptors",
    "listlockunspent",
    "sendrawtransaction",
    "signrawtransactionwithwallet",
];

/// Env gate names. Both are read through [`env_flag`] so "set but empty" and
/// "set to 0" are both **off** — a gate that turns on for `""` is a gate that
/// turns on by accident.
pub(crate) const ROUTING_ENV: &str = "PWNDA_SWAP_ROUTING";
pub(crate) const ROUTING_MAINNET_ENV: &str = "PWNDA_SWAP_ROUTING_MAINNET";

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

/// Frozen refusal string (contract 1.3).
pub(crate) const ROUTING_DISABLED: &str = "daemon-direct routing is disabled";

/// Pure form of the routing gate, so the gate can be tested without mutating
/// process env from a multi-threaded test runner.
pub(crate) fn require_routing(enabled: bool) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err(ROUTING_DISABLED.to_string())
    }
}

/// Pure form of the broadcast gate.
///
/// Regtest broadcasts freely (the chain is a throwaway the operator minted).
/// Everything else — mainnet, and any chain string we did not recognise —
/// needs the explicit opt-in, because the failure mode here is an accidental
/// irreversible mainnet spend and "we could not tell which chain this is" must
/// resolve to *refuse*, never to *allow*.
pub(crate) fn require_broadcast(network: Network, mainnet_opt_in: bool) -> Result<(), String> {
    match network {
        Network::Regtest => Ok(()),
        Network::Mainnet => {
            if mainnet_opt_in {
                Ok(())
            } else {
                Err(format!(
                    "daemon-direct broadcast is limited to regtest; set {}=1 to allow a real \
                     broadcast",
                    ROUTING_MAINNET_ENV
                ))
            }
        }
    }
}

/// `getblockchaininfo.chain` -> the network we treat the daemon as being on.
///
/// **Fails closed on purpose.** Only the literal `"regtest"` is regtest;
/// `"main"`, `"test"`, `"signet"`, a fork's private devnet name, and an absent
/// field all map to [`Network::Mainnet`], which is the *guarded* side of
/// [`require_broadcast`]. Reading the chain off the daemon we are about to
/// broadcast through — rather than off a value stored at prepare time — means
/// the gate cannot be desynchronised from reality by a reconfigure.
pub(crate) fn network_from_chain_field(chain: &str) -> Network {
    if chain == "regtest" {
        Network::Regtest
    } else {
        Network::Mainnet
    }
}

// =========================================================================
// Wire types (contract 1.3)
// =========================================================================

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FeeMode {
    ConfTarget,
    FeeRate,
}

/// Flat rather than an internally-tagged enum — see the contract's note: an
/// internally-tagged enum with camelCase *fields* needs `rename_all_fields`,
/// whose availability varies by serde minor version. A flat struct plus a
/// validating pure fn ([`fund_options`]) is unambiguous and directly testable.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeeControl {
    pub mode: FeeMode,
    pub blocks: Option<u16>,
    pub estimate_mode: Option<String>,
    pub sat_per_vb: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSendRequest {
    pub coin: String,
    pub to_address: String,
    pub amount_sat: u64,
    pub subtract_fee: bool,
    pub fee: FeeControl,
    pub dry_run: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSendResult {
    pub txid: Option<String>,
    pub fee_sat: i64,
    pub vsize: u64,
    pub inputs: usize,
    pub locked_utxos: usize,
    pub broadcast: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonCapability {
    pub coin: String,
    pub wallet: String,
    pub descriptors: bool,
    pub fee_rate: bool,
    pub conf_target: bool,
    pub xpub_available: bool,
}

// =========================================================================
// Fee options — the reason this module exists, so it gets a pure fn
// =========================================================================

/// Build `fundrawtransaction`'s options object.
///
/// The XOR is enforced here rather than trusted from the renderer: a request
/// carrying *both* `blocks` and `satPerVb` has two different fee intents and
/// no correct answer, and silently preferring one is how a user ends up
/// broadcasting at a fee they did not choose.
///
/// `lockUnspents: false` is stated explicitly even though it is Core's
/// default. It is load-bearing in the opposite direction from everything else
/// in this file: locking inputs from a **dry run** would hand the engine a
/// reservation nobody ever releases, i.e. this module would create exactly the
/// class of stuck-UTXO bug it exists to prevent.
pub(crate) fn fund_options(fee: &FeeControl, subtract_fee: bool) -> Result<Value, String> {
    let mut o = serde_json::Map::new();
    match fee.mode {
        FeeMode::ConfTarget => {
            if fee.sat_per_vb.is_some() {
                return Err("fee mode confTarget must not carry satPerVb".to_string());
            }
            let blocks = fee
                .blocks
                .ok_or_else(|| "fee mode confTarget needs blocks".to_string())?;
            if blocks == 0 {
                return Err("conf_target must be at least 1 block".to_string());
            }
            o.insert("conf_target".into(), json!(blocks));
            let mode = fee.estimate_mode.as_deref().unwrap_or("conservative");
            if !matches!(mode, "economical" | "conservative") {
                return Err(format!(
                    "estimateMode must be economical or conservative, got {:?}",
                    mode
                ));
            }
            o.insert("estimate_mode".into(), json!(mode));
        }
        FeeMode::FeeRate => {
            if fee.blocks.is_some() {
                return Err("fee mode feeRate must not carry blocks".to_string());
            }
            if fee.estimate_mode.is_some() {
                return Err("fee mode feeRate must not carry estimateMode".to_string());
            }
            let rate = fee
                .sat_per_vb
                .ok_or_else(|| "fee mode feeRate needs satPerVb".to_string())?;
            if !rate.is_finite() || rate <= 0.0 {
                return Err(format!("satPerVb must be a positive number, got {}", rate));
            }
            o.insert("fee_rate".into(), json!(rate));
        }
    }
    if subtract_fee {
        o.insert("subtractFeeFromOutputs".into(), json!([0]));
    }
    o.insert("lockUnspents".into(), json!(false));
    Ok(Value::Object(o))
}

// =========================================================================
// Amounts — decimal on the wire, integers in our own structs (contract 0.3)
// =========================================================================

/// Satoshis -> the JSON number `createrawtransaction` wants (whole-coin units).
///
/// Every sat value below 21e6 coins is an exact `f64` integer (2.1e15 < 2^53),
/// so dividing by 1e8 lands on a double whose shortest round-trip decimal is
/// the exact amount — which is what serde_json emits. The bound is asserted
/// rather than assumed, so a nonsense `amountSat` fails here instead of
/// silently becoming a different amount.
pub(crate) fn btc_amount_value(sat: u64) -> Result<Value, String> {
    const MAX_SAT: u64 = 21_000_000 * 100_000_000;
    if sat == 0 {
        return Err("amountSat must be greater than zero".to_string());
    }
    if sat > MAX_SAT {
        return Err(format!("amountSat {} exceeds the 21e6 coin supply", sat));
    }
    let n = serde_json::Number::from_f64(sat as f64 / 1e8)
        .ok_or_else(|| format!("amountSat {} is not representable", sat))?;
    Ok(Value::Number(n))
}

/// A coin-denominated JSON field -> satoshis.
///
/// Accepts a number or a decimal string: `fee` comes back as a number from
/// Core, but the forks are not uniform and the contract's rule (0.3) is that
/// engine amounts are strings, so both shapes are handled rather than guessed.
pub(crate) fn btc_to_sat(v: &Value) -> Result<i64, String> {
    let f = match v {
        Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| "amount is not a number".to_string())?,
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|e| format!("amount {:?} is not a decimal: {}", s, e))?,
        other => return Err(format!("amount has unexpected JSON type: {}", other)),
    };
    if !f.is_finite() {
        return Err("amount is not finite".to_string());
    }
    Ok((f * 1e8).round() as i64)
}

/// `createrawtransaction`'s params: no inputs (the daemon selects them), one
/// output.
///
/// Extracted and tested because this is the payload that decides where the
/// money goes. An outputs object built as an array, or with the amount and the
/// address transposed, does not fail loudly — Core rejects some shapes and
/// silently accepts others, and the shapes it accepts are the dangerous ones.
///
/// The empty input array is the whole design: handing Core `[]` is what makes
/// Core's own coin selection — and therefore its own `lockunspent` set — the
/// single selection authority. Passing inputs here would reintroduce exactly
/// the second selector this module exists to delete.
pub(crate) fn create_raw_params(to_address: &str, amount: Value) -> Result<Value, String> {
    let to = to_address.trim();
    if to.is_empty() {
        return Err("a destination address is required".to_string());
    }
    let mut outputs = serde_json::Map::new();
    outputs.insert(to.to_string(), amount);
    Ok(json!([Value::Array(vec![]), Value::Object(outputs)]))
}

// =========================================================================
// Coin -> daemon resolution
// =========================================================================

/// One resolved bitcoin-family send target.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SendTarget {
    pub coin: String,
    pub host: String,
    pub port: u16,
    /// `chainclients.<coin>.wallet_name`; the engine's own fallback is
    /// `"wallet.dat"` (`upstream/basicswap/basicswap/basicswap.py:2280`), so
    /// ours must be too — funding against a *different* wallet than the engine
    /// uses would reinstate the two-selector race this module removes.
    pub wallet: String,
    pub user: Option<String>,
    pub password: Option<String>,
    pub chain_datadir: Option<PathBuf>,
}

/// Resolve `coin` to the daemon BasicSwap itself talks to.
///
/// Pure over the config text; the `.cookie` read that supplies credentials
/// happens later in [`endpoint_for`], so this whole function is unit-testable
/// without a filesystem.
///
/// # A deliberate narrowing worth knowing about
///
/// [`parse_chain_daemon_targets`] only yields chainclients with
/// `manage_daemon: true`, because it was written for the shutdown ladder where
/// "a daemon we did not start is never ours to stop" is exactly right. Reused
/// here — as the contract's D8 directs — it also means **an externally-managed
/// daemon cannot be sent through**. That is a refusal, not a silent wrong
/// answer, and the error below names which of the three cases fired. Widening
/// it to `connection_type == "rpc"` is a contract amendment, not a local
/// decision, so it is flagged rather than taken.
pub(crate) fn resolve_send_target(config_json: &str, coin: &str) -> Result<SendTarget, String> {
    let coin_key = coin.trim().to_ascii_lowercase();
    if coin_key.is_empty() {
        return Err("coin is required".to_string());
    }

    let v: Value = serde_json::from_str(config_json)
        .map_err(|e| format!("basicswap.json is not JSON: {}", e))?;
    let clients = v
        .get("chainclients")
        .and_then(|c| c.as_object())
        .ok_or_else(|| "basicswap.json has no chainclients".to_string())?;
    let cc = clients
        .get(&coin_key)
        .ok_or_else(|| format!("{} is not configured on the swap node", coin_key))?;

    let target = parse_chain_daemon_targets(config_json)?
        .into_iter()
        .find(|t| t.coin == coin_key)
        .ok_or_else(|| {
            let conn = cc
                .get("connection_type")
                .and_then(|x| x.as_str())
                .unwrap_or("none");
            if conn != "rpc" {
                format!(
                    "{} is configured as {:?}, which has no daemon to send through",
                    coin_key, conn
                )
            } else {
                format!(
                    "{} is configured with manage_daemon: false, so the swap node is not the \
                     authority for its wallet",
                    coin_key
                )
            }
        })?;

    if target.kind != DaemonKind::BitcoinRpc {
        return Err(format!(
            "{} is not a bitcoin-family daemon; daemon-direct routing does not apply",
            coin_key
        ));
    }
    if !is_loopback(&target.host) {
        return Err(format!(
            "{} points at {}, which is not this machine; daemon-direct routing is loopback-only",
            coin_key, target.host
        ));
    }

    Ok(SendTarget {
        coin: target.coin,
        host: target.host,
        port: target.port,
        wallet: cc
            .get("wallet_name")
            .and_then(|x| x.as_str())
            .unwrap_or("wallet.dat")
            .to_string(),
        user: target.user,
        password: target.password,
        chain_datadir: target.chain_datadir,
    })
}

/// Percent-encode one URL path segment.
///
/// Wallet names are user-influenceable through prepare's `<TICKER>_WALLET_NAME`
/// env (`upstream/basicswap/basicswap/bin/prepare.py:314 getWalletName`), so a
/// name containing `/` or `?` must not be able to re-point the request at a
/// different path.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub(crate) fn wallet_url(host: &str, port: u16, wallet: &str) -> String {
    if wallet.is_empty() {
        format!("http://{}:{}/", host, port)
    } else {
        format!("http://{}:{}/wallet/{}", host, port, encode_segment(wallet))
    }
}

/// A resolved JSON-RPC endpoint: URL plus whatever credentials that daemon
/// actually accepts.
#[derive(Clone, Debug)]
pub(crate) struct DaemonEndpoint {
    pub url: String,
    pub auth: Option<(String, String)>,
}

/// Credentials for a target: the config's static pair when it has one,
/// otherwise the daemon's own `.cookie`. A generated bitcoin-family
/// chainclient has neither `rpcuser` nor `rpcpassword` — see
/// [`crate::swap_sidecar::cookie_auth`] for why an unauthenticated request
/// would come back `401`.
fn endpoint_auth(t: &SendTarget) -> Option<(String, String)> {
    match (t.user.as_ref(), t.password.as_ref()) {
        (Some(u), Some(p)) => Some((u.clone(), p.clone())),
        _ => t.chain_datadir.as_deref().and_then(cookie_auth),
    }
}

pub(crate) fn endpoint_for(t: &SendTarget, wallet: &str) -> DaemonEndpoint {
    DaemonEndpoint {
        url: wallet_url(&t.host, t.port, wallet),
        auth: endpoint_auth(t),
    }
}

// =========================================================================
// The guarded RPC caller
// =========================================================================

/// Why a [`daemon_rpc`] call failed. The variants are distinguished because
/// the R7 test's whole point is asserting **which** failure came first.
#[derive(Debug)]
pub(crate) enum RpcFault {
    /// Refused by the allow-list. No socket was opened.
    Guard(String),
    /// Could not reach the daemon at all.
    Transport(String),
    /// The daemon answered with a JSON-RPC error object.
    Rpc { code: i64, message: String },
    /// The daemon answered with a non-2xx that was not a JSON-RPC error.
    Http(u16, String),
}

impl std::fmt::Display for RpcFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcFault::Guard(m) => write!(f, "{}", m),
            RpcFault::Transport(m) => write!(f, "could not reach the coin daemon: {}", m),
            // -13 is RPC_WALLET_UNLOCK_NEEDED. Mapped here, once, because the
            // remedy is never "prompt for a passphrase" — this module must
            // never call `walletpassphrase` (it is not on the allow-list and
            // must not be added). C5 owns unlocking, at start, before the
            // supervisor is allowed to report Healthy.
            RpcFault::Rpc { code: -13, .. } => write!(f, "the swap node's wallet is locked"),
            RpcFault::Rpc {
                code: -32601,
                message,
            } => write!(
                f,
                "this coin's daemon does not support a method daemon-direct routing needs ({}); \
                 use the engine's own send for this coin",
                message
            ),
            RpcFault::Rpc { code, message } => {
                write!(f, "coin daemon error {}: {}", code, message)
            }
            RpcFault::Http(s, body) => write!(f, "coin daemon HTTP {}: {}", s, snippet(body)),
        }
    }
}

impl RpcFault {
    pub(crate) fn http_status(&self) -> Option<u16> {
        match self {
            RpcFault::Http(s, _) => Some(*s),
            _ => None,
        }
    }
}

fn snippet(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 200 {
        t.to_string()
    } else {
        format!("{}...", t.chars().take(200).collect::<String>())
    }
}

/// Issue one JSON-RPC call against a coin daemon.
///
/// `method` is `&'static str` on purpose: a renderer-supplied `String` cannot
/// coerce to it, so "the webview named the method" is a compile error at every
/// call site rather than a review comment. The runtime check below covers the
/// remaining case — a *literal* somebody added without adding it to the list.
///
/// The guard runs before the request is built and before any name is resolved,
/// so an unlisted method fails with [`RpcFault::Guard`] and never touches the
/// network. `tests::daemon_rpc_rejects_unlisted_method` asserts that ordering,
/// against a port nothing is listening on, so that removing the guard changes
/// the error *kind* rather than merely its text.
pub(crate) async fn daemon_rpc(
    client: &reqwest::Client,
    ep: &DaemonEndpoint,
    method: &'static str,
    params: Value,
) -> Result<Value, RpcFault> {
    daemon_rpc_guarded(client, ep, DAEMON_METHODS, method, params).await
}

/// [`daemon_rpc`] with the allow-list named at the call site.
///
/// # Why a second list exists rather than a wider first one
///
/// C3.5 (`crate::descriptors`) has to issue `importdescriptors` / `importmulti`
/// / `getdescriptorinfo`, and `allow_list_excludes_every_key_and_unlock_method`
/// asserts — deliberately — that `importdescriptors` is **not** reachable
/// through daemon-direct routing. Both properties are wanted at once: the
/// fund-moving surface must never import a key, and the adoption surface must
/// never sign or broadcast one. Widening [`DAEMON_METHODS`] would have given up
/// the first to get the second.
///
/// So the HTTP path and the guard stay single-implementation here, and the
/// *list* becomes a parameter that every call site names as a `const`. The two
/// lists are asserted disjoint by
/// `crate::descriptors::tests::descriptor_methods_are_disjoint_from_routing`,
/// which is what stops this from decaying into "pass whatever list makes the
/// call compile".
pub(crate) async fn daemon_rpc_guarded(
    client: &reqwest::Client,
    ep: &DaemonEndpoint,
    allowed: &[&str],
    method: &'static str,
    params: Value,
) -> Result<Value, RpcFault> {
    if !allowed.contains(&method) {
        return Err(RpcFault::Guard(format!(
            "RPC method {:?} is not allowed by daemon-direct routing",
            method
        )));
    }

    let mut req = client.post(&ep.url).json(&json!({
        "jsonrpc": "1.0",
        "id": "pwnda",
        "method": method,
        "params": params,
    }));
    if let Some((u, p)) = ep.auth.as_ref() {
        req = req.basic_auth(u, Some(p));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| RpcFault::Transport(e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| RpcFault::Transport(e.to_string()))?;

    // A JSON-RPC error arrives with HTTP 500, so the body is parsed before the
    // status is judged — otherwise every wallet-locked reply would surface as
    // an opaque "HTTP 500" and the -13 mapping would never fire.
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        if let Some(err) = v.get("error") {
            if !err.is_null() {
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                let message = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("(no message)")
                    .to_string();
                return Err(RpcFault::Rpc { code, message });
            }
        }
        if (200..300).contains(&status) {
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    Err(RpcFault::Http(status, text))
}

/// Pick the URL this daemon actually answers on.
///
/// Multiwallet (`/wallet/<name>`) is what the engine uses
/// (`upstream/basicswap/basicswap/rpc.py:53 constructUrl`), but a fork built
/// without multiwallet support 404s that path (contract 4.3 item 7). Probed
/// **once**, with a read-only method, and the winning URL is then reused for
/// the whole operation — so no fund-moving call is ever retried on a different
/// URL, and `sendrawtransaction` in particular can never be issued twice.
pub(crate) async fn resolve_endpoint(
    client: &reqwest::Client,
    t: &SendTarget,
) -> Result<(DaemonEndpoint, Value), String> {
    let ep = endpoint_for(t, &t.wallet);
    match daemon_rpc(client, &ep, "getwalletinfo", json!([])).await {
        Ok(info) => Ok((ep, info)),
        Err(e) if e.http_status() == Some(404) => {
            let bare = endpoint_for(t, "");
            let info = daemon_rpc(client, &bare, "getwalletinfo", json!([]))
                .await
                .map_err(|e2| e2.to_string())?;
            Ok((bare, info))
        }
        Err(e) => Err(e.to_string()),
    }
}

// =========================================================================
// Outpoint bookkeeping — the R9 property, asserted rather than assumed
// =========================================================================

pub(crate) fn vin_outpoints(decoded: &Value) -> Vec<(String, u64)> {
    decoded
        .get("vin")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    Some((
                        i.get("txid")?.as_str()?.to_string(),
                        i.get("vout")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn locked_outpoints(listed: &Value) -> Vec<(String, u64)> {
    listed
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    Some((
                        i.get("txid")?.as_str()?.to_string(),
                        i.get("vout")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Refuse a transaction that spends an input the engine has reserved.
///
/// Core's `fundrawtransaction` already skips locked UTXOs, which is the whole
/// reason this module funds through the daemon. This check exists because
/// "already skips" is a property of versions of four forks we have not
/// measured — and the cost of being wrong is a dead swap leg. If the two sets
/// ever intersect, the assumption behind the design is false, and the right
/// answer is to stop, loudly, before signing.
pub(crate) fn assert_no_locked_inputs(
    inputs: &[(String, u64)],
    locked: &[(String, u64)],
) -> Result<(), String> {
    if let Some(bad) = inputs.iter().find(|i| locked.contains(i)) {
        return Err(format!(
            "refusing to spend {}:{} — the swap node has that output reserved for a swap. The \
             daemon's own coin selection did not honour its lock set, so daemon-direct routing \
             cannot be trusted on this coin.",
            bad.0, bad.1
        ));
    }
    Ok(())
}

/// The signed hex from `signrawtransactionwithwallet`, but **only** if the
/// wallet actually finished the job.
///
/// `complete: false` means at least one input is unsigned. Core still returns
/// a `hex` in that case, and broadcasting it produces a rejected transaction —
/// or, worse on a fork with laxer relay rules, a transaction that burns the
/// inputs it did sign. Treating "there is a hex" as "it is signed" is the
/// whole failure, so the presence of `hex` is never enough on its own.
///
/// Pure and separate from the command so it is directly testable: the command
/// itself needs an `AppHandle` and a live daemon, which is exactly the shape
/// of code that ends up with no test.
pub(crate) fn complete_signed_hex(signed: &Value) -> Result<String, String> {
    if signed.get("complete").and_then(|c| c.as_bool()) != Some(true) {
        let why = signed
            .get("errors")
            .map(|e| snippet(&e.to_string()))
            .unwrap_or_else(|| "(no detail)".to_string());
        return Err(format!(
            "the swap node's wallet could not fully sign this transaction: {}",
            why
        ));
    }
    signed
        .get("hex")
        .and_then(|h| h.as_str())
        .map(|h| h.to_string())
        .ok_or_else(|| "signrawtransactionwithwallet did not return hex".to_string())
}

// =========================================================================
// Capability probing — `help`, because version numbers do not compare
// =========================================================================

/// Does `help`'s command list contain `name`?
///
/// `help` with no arguments returns the daemon's whole command list, one
/// command per line with its signature. Matching on the first whitespace token
/// of a line avoids matching a command name inside another command's help
/// text, and skips the section headers (`== Wallet ==`).
pub(crate) fn help_lists_command(help_text: &str, name: &str) -> bool {
    help_text
        .lines()
        .filter(|l| !l.trim_start().starts_with("=="))
        .any(|l| l.split_whitespace().next() == Some(name))
}

/// Does a single command's help text mention this option?
///
/// Used for `fee_rate` / `conf_target` on `fundrawtransaction`. Version
/// numbers cannot answer this: `fee_rate` is Core >= 0.21, but Dogecoin, Dash
/// and BCH each number their releases independently, so "is this fork newer
/// than 0.21" is not a question with an answer. The daemon's own help text is.
///
/// Tokenised on non-`[A-Za-z0-9_]` so `fee_rate` does not match inside
/// `estimate_fee_rate`, and so quoting/punctuation in the help text is
/// irrelevant.
pub(crate) fn help_mentions_option(help_text: &str, option: &str) -> bool {
    help_text
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|tok| tok == option)
}

// =========================================================================
// Commands
// =========================================================================

fn read_config(app: &AppHandle) -> Result<String, String> {
    let path = swap_sidecar::datadir(app)?.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| {
        format!(
            "the swap node is not configured yet ({}): {}",
            path.display(),
            e
        )
    })?;
    strip_bom(&raw).map(|s| s.to_string())
}

fn require_healthy(state: &tauri::State<'_, SwapSidecarState>) -> Result<(), String> {
    match swap_sidecar::phase_snapshot(state)? {
        Phase::Healthy => Ok(()),
        other => Err(format!(
            "the swap node is not running (phase {:?}); daemon-direct routing needs it up so the \
             daemon's own reservations are current",
            other
        )),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))
}

/// Send a bitcoin-family coin through the swap node's own daemon wallet.
///
/// The ordering below is deliberate and every step is a refusal point: cheap
/// local gates first, then the probe that establishes which chain we are
/// actually on, then build -> fund -> verify-not-locked -> sign, and only then,
/// behind a **re-checked** broadcast gate, `sendrawtransaction`.
#[tauri::command]
pub async fn swap_daemon_send(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
    req: DaemonSendRequest,
) -> Result<DaemonSendResult, String> {
    require_routing(env_flag(ROUTING_ENV))?;
    require_healthy(&state)?;

    if req.to_address.trim().is_empty() {
        return Err("a destination address is required".to_string());
    }
    let amount = btc_amount_value(req.amount_sat)?;
    let options = fund_options(&req.fee, req.subtract_fee)?;

    let cfg = read_config(&app)?;
    let target = resolve_send_target(&cfg, &req.coin)?;
    let client = http_client()?;
    let (ep, _wallet_info) = resolve_endpoint(&client, &target).await?;

    // Which chain is this, really? Read off the daemon that would broadcast,
    // not off anything the renderer or a stale config said.
    let chain_info = daemon_rpc(&client, &ep, "getblockchaininfo", json!([]))
        .await
        .map_err(|e| e.to_string())?;
    let chain = chain_info
        .get("chain")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let network = network_from_chain_field(chain);
    if !req.dry_run {
        require_broadcast(network, env_flag(ROUTING_MAINNET_ENV))?;
    }

    let locked_raw = daemon_rpc(&client, &ep, "listlockunspent", json!([]))
        .await
        .map_err(|e| e.to_string())?;
    let locked = locked_outpoints(&locked_raw);

    let raw_hex = daemon_rpc(
        &client,
        &ep,
        "createrawtransaction",
        create_raw_params(&req.to_address, amount)?,
    )
    .await
    .map_err(|e| e.to_string())?;
    let raw_hex = raw_hex
        .as_str()
        .ok_or_else(|| "createrawtransaction did not return a hex string".to_string())?;

    let funded = daemon_rpc(&client, &ep, "fundrawtransaction", json!([raw_hex, options]))
        .await
        .map_err(|e| e.to_string())?;
    let funded_hex = funded
        .get("hex")
        .and_then(|h| h.as_str())
        .ok_or_else(|| "fundrawtransaction did not return hex".to_string())?
        .to_string();
    let fee_sat = funded
        .get("fee")
        .ok_or_else(|| "fundrawtransaction did not return a fee".to_string())
        .and_then(btc_to_sat)?;

    let decoded_unsigned = daemon_rpc(&client, &ep, "decoderawtransaction", json!([funded_hex]))
        .await
        .map_err(|e| e.to_string())?;
    assert_no_locked_inputs(&vin_outpoints(&decoded_unsigned), &locked)?;

    // Signed in both modes: a dry run that skips signing is not a rehearsal,
    // it is a guess — and the vsize that determines the real fee only exists
    // once the witnesses do. Signing mutates no wallet state; the hex stays in
    // Rust and never crosses the Tauri boundary.
    let signed = daemon_rpc(
        &client,
        &ep,
        "signrawtransactionwithwallet",
        json!([funded_hex]),
    )
    .await
    .map_err(|e| e.to_string())?;
    let signed_hex = complete_signed_hex(&signed)?;

    let decoded = daemon_rpc(&client, &ep, "decoderawtransaction", json!([&signed_hex]))
        .await
        .map_err(|e| e.to_string())?;
    let vsize = decoded
        .get("vsize")
        .and_then(|v| v.as_u64())
        .or_else(|| decoded.get("size").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let inputs = vin_outpoints(&decoded);
    assert_no_locked_inputs(&inputs, &locked)?;

    if req.dry_run {
        return Ok(DaemonSendResult {
            txid: None,
            fee_sat,
            vsize,
            inputs: inputs.len(),
            locked_utxos: locked.len(),
            broadcast: false,
        });
    }

    // Re-checked immediately before the only irreversible call in the module.
    // The earlier check is the one that saves the work; this one is the one
    // that survives a refactor which moves the earlier one.
    require_broadcast(network, env_flag(ROUTING_MAINNET_ENV))?;
    let txid = daemon_rpc(&client, &ep, "sendrawtransaction", json!([signed_hex]))
        .await
        .map_err(|e| e.to_string())?;
    let txid = txid
        .as_str()
        .ok_or_else(|| "sendrawtransaction did not return a txid".to_string())?
        .to_string();

    Ok(DaemonSendResult {
        txid: Some(txid),
        fee_sat,
        vsize,
        inputs: inputs.len(),
        locked_utxos: locked.len(),
        broadcast: true,
    })
}

/// Probe, live, what each configured bitcoin-family daemon can actually do.
///
/// Answers contract 4.3 items 5 and 6 by measurement rather than by version
/// arithmetic. Coins whose daemon cannot be reached are **omitted**, not
/// reported as all-false: reporting "no fee_rate" for a daemon we could not
/// reach is a claim we did not measure, and the caller would have no way to
/// tell the two apart.
#[tauri::command]
pub async fn swap_daemon_capabilities(app: AppHandle) -> Result<Vec<DaemonCapability>, String> {
    require_routing(env_flag(ROUTING_ENV))?;

    let cfg = read_config(&app)?;
    let client = http_client()?;
    let mut out = Vec::new();

    let coins: Vec<String> = parse_chain_daemon_targets(&cfg)?
        .into_iter()
        .filter(|t| t.kind == DaemonKind::BitcoinRpc && is_loopback(&t.host))
        .map(|t| t.coin)
        .collect();

    for coin in coins {
        let Ok(target) = resolve_send_target(&cfg, &coin) else {
            continue;
        };
        let Ok((ep, info)) = resolve_endpoint(&client, &target).await else {
            continue;
        };
        let Ok(all_help) = daemon_rpc(&client, &ep, "help", json!([])).await else {
            continue;
        };
        let all_help = all_help.as_str().unwrap_or("").to_string();
        let fund_help = daemon_rpc(&client, &ep, "help", json!(["fundrawtransaction"]))
            .await
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();

        out.push(DaemonCapability {
            coin: coin.clone(),
            wallet: info
                .get("walletname")
                .and_then(|w| w.as_str())
                .unwrap_or(&target.wallet)
                .to_string(),
            descriptors: info
                .get("descriptors")
                .and_then(|d| d.as_bool())
                .unwrap_or(false),
            fee_rate: help_mentions_option(&fund_help, "fee_rate"),
            conf_target: help_mentions_option(&fund_help, "conf_target"),
            // `listdescriptors` is the read-back half of C3.5's adoption path.
            // Measured on regtest 2026-08-19: BTC yes, LTC **no** (it has
            // `importdescriptors` but not `listdescriptors`), so LTC must skip
            // post-import read-back rather than treat its absence as failure.
            // Detected via `help`'s command list rather than by calling it —
            // `listdescriptors true` returns xprv/zprv (R8), and this module
            // has no business ever holding one.
            xpub_available: help_lists_command(&all_help, "listdescriptors"),
        });
    }

    Ok(out)
}

// =========================================================================
// C2 — watch records (R8): read the account xpub back, store NOTHING private
// =========================================================================
//
// # What this is for
//
// Once a coin is adopted by the swap node, the node's own daemon is the
// authority on that wallet's UTXOs — which is exactly what makes
// [`swap_daemon_send`] safe. It also means the balance disappears the moment
// the node is down, because nothing outside the daemon knows which addresses
// belong to it. Capturing the *account extended public key* fixes that half:
// with an xpub and its derivation branch, a watch-only client (Esplora) can
// render a balance with no daemon running at all. Spending still goes through
// the daemon; only watching is offloaded.
//
// # Why this is the most dangerous read in the module (R8)
//
// `listdescriptors` takes an optional boolean. Without it the daemon returns
// the **public** descriptors. With `true` it returns the **private** ones —
// xprv/zprv, and WIF secrets for imported single keys. The two calls differ by
// one JSON token, produce the same shape of reply, and only one of them is a
// full spending compromise if it lands in a file. So:
//
// * the request params are built by [`listdescriptors_params`], which is a
//   function rather than an inline literal precisely so a test can assert what
//   goes on the wire;
// * every key that comes back is classified by [`classify_key_token`] against
//   an **allow-list of public prefixes** — an unrecognised prefix is refused,
//   not assumed public, so a fork whose version bytes we have never seen fails
//   closed;
// * one private key anywhere in the reply aborts the whole coin. Skipping the
//   offending entry and writing the rest would turn "we asked for public keys
//   and got private ones" into a silent partial success;
// * the record is re-scanned as **serialized text** by [`record_is_public`]
//   immediately before the write, which covers fields added to [`WatchKey`] /
//   [`WatchRecord`] after this was written.
//
// The raw descriptor string is deliberately **not** stored. A public
// descriptor is not a spending key, but the project rule is that a descriptor
// never gets serialized, and the decomposed fields below carry everything a
// watcher actually needs.

/// Base58 alphabet (Bitcoin's). Used to decide whether a token is
/// *key-shaped*; no checksum is verified, because the question here is "could
/// this be a key" and the safe answer to "maybe" is yes.
const BASE58_ALPHABET: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Serialized extended keys are 78 payload bytes + 4 checksum = 82 bytes,
/// which is 111 base58 characters for every version prefix in use. The window
/// is widened a little so a fork with unusual leading bytes still lands inside
/// it — being *inside* the window only means the token gets classified, and
/// classification refuses anything it does not recognise.
const EXTKEY_LEN: std::ops::RangeInclusive<usize> = 100..=120;

/// WIF is 51 characters uncompressed, 52 compressed. Addresses top out around
/// 35 characters and bech32 is not base58, so a base58 token of this length
/// inside a descriptor is a private key with no realistic alternative reading.
const WIF_LEN: std::ops::RangeInclusive<usize> = 51..=52;

/// Extended **public** key prefixes, by fork.
///
/// An allow-list rather than a list of the private prefixes to reject. The
/// difference is what happens to a prefix nobody anticipated: a deny-list
/// stores it (it is "not known to be private"), an allow-list refuses it. Only
/// one of those two failure modes writes a spending key to disk.
///
/// BTC `xpub`/`ypub`/`zpub` (plus the `Ypub`/`Zpub` multisig spellings) and
/// their testnet `tpub`/`upub`/`vpub` counterparts; Litecoin `Ltub`/`Mtub` and
/// its testnet `ttub`; Dogecoin `dgub`; Dash `drkp`. Dash and Bitcoin Cash
/// also reuse Bitcoin's version bytes, so they arrive as `xpub`.
pub(crate) const PUBLIC_EXTKEY_PREFIXES: &[&str] = &[
    "Ltub", "Mtub", "Upub", "Vpub", "Ypub", "Zpub", "dgub", "drkp", "tpub", "ttub", "upub", "vpub",
    "xpub", "ypub", "zpub",
];

/// What one base58-shaped token in a descriptor is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeyToken {
    /// An extended key whose prefix is on [`PUBLIC_EXTKEY_PREFIXES`].
    PublicExtended,
    /// Extended-key shaped, prefix not recognised as public. Treated as
    /// private: this is the branch that must never reach a file.
    NotProvablyPublic,
    /// WIF shaped — a bare private key.
    Wif,
    /// Not key shaped (a path element, a checksum, an address).
    NotAKey,
}

pub(crate) fn classify_key_token(tok: &str) -> KeyToken {
    if tok.is_empty() || !tok.chars().all(|c| BASE58_ALPHABET.contains(c)) {
        return KeyToken::NotAKey;
    }
    let n = tok.chars().count();
    if EXTKEY_LEN.contains(&n) {
        let prefix: String = tok.chars().take(4).collect();
        return if PUBLIC_EXTKEY_PREFIXES.contains(&prefix.as_str()) {
            KeyToken::PublicExtended
        } else {
            KeyToken::NotProvablyPublic
        };
    }
    if WIF_LEN.contains(&n) {
        return KeyToken::Wif;
    }
    KeyToken::NotAKey
}

/// Split on everything that cannot appear inside a base58 token, so the
/// descriptor's structural characters all act as separators.
fn key_shaped_tokens(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Every public extended key in `text`, or an error naming the *class* of
/// secret that was found.
///
/// The error deliberately carries no part of the offending token. A refusal
/// message is written to a log; a key in a log is the thing this function
/// exists to prevent.
pub(crate) fn public_extended_keys(text: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for tok in key_shaped_tokens(text) {
        match classify_key_token(tok) {
            KeyToken::PublicExtended => out.push(tok.to_string()),
            KeyToken::NotProvablyPublic => {
                return Err(
                    "refusing to store an extended key that is not provably public — the swap \
                     node returned a private (or unrecognised) extended key where only public \
                     ones were requested"
                        .to_string(),
                )
            }
            KeyToken::Wif => {
                return Err(
                    "refusing to store a bare private key — the swap node returned key material \
                     where only public descriptors were requested"
                        .to_string(),
                )
            }
            KeyToken::NotAKey => {}
        }
    }
    Ok(out)
}

/// One watchable branch: an account xpub plus everything needed to derive
/// addresses from it without the daemon.
///
/// No descriptor string, no checksum, no private field — see the module note
/// above for why the descriptor itself is decomposed rather than stored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchKey {
    /// The descriptor's function chain, outermost first: `wpkh`, `sh-wpkh`,
    /// `pkh`, `tr`. Tells the watcher which address encoding to derive.
    pub script: String,
    /// Key origin exactly as the descriptor wrote it, brackets stripped:
    /// `d34db33f/84h/0h/0h`. `None` when the descriptor carried no origin.
    pub origin: Option<String>,
    /// The account extended **public** key.
    pub xpub: String,
    /// Branch index from the `/N/*` suffix — 0 external, 1 change.
    pub branch: u32,
    /// The daemon's own `internal` flag for this descriptor.
    pub internal: bool,
    /// The daemon's own `active` flag. An inactive descriptor is still worth
    /// watching (C3.5 imports the user's own branches inactive on purpose).
    pub active: bool,
    /// Upper end of the imported range, when the daemon reported one.
    pub range_end: Option<u32>,
}

/// What one coin's watch file holds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchRecord {
    /// Engine coin name, lowercase (`bitcoin`, `litecoin`).
    pub coin: String,
    /// The `_rpc_wallet` these keys came from.
    pub wallet: String,
    pub captured_at: String,
    pub keys: Vec<WatchKey>,
    /// Set when this coin cannot answer at all — LTC has `importdescriptors`
    /// but **no** `listdescriptors` (measured against the real binaries,
    /// 2026-08-19), so there is no public read-back path on it.
    ///
    /// A record that says *why* it is empty is the whole point: without it,
    /// "no keys" and "never asked" look identical to a reader, and the reader
    /// is a balance view that would render `0` for both.
    pub unavailable: Option<String>,
    /// Descriptors that were understood but not watchable (multisig, no
    /// extended key). Reasons only — never a descriptor.
    pub skipped: Vec<String>,
}

/// The parameters `listdescriptors` is called with.
///
/// A function, not an inline `json!([])`, so
/// `capture_never_asks_for_private_descriptors` can assert on the exact value
/// that goes on the wire. Passing `true` here is the R8 catastrophe.
pub(crate) fn listdescriptors_params() -> Value {
    json!([])
}

/// The function chain of a descriptor, outermost first, joined with `-`.
///
/// `wpkh([..]xpub…/0/*)` becomes `"wpkh"`; `sh(wpkh([..]xpub…/0/*))` becomes
/// `"sh-wpkh"`. Stops at the key origin so a hex fingerprint cannot be read as
/// a function name.
fn descriptor_script(desc: &str) -> String {
    let mut fns: Vec<String> = Vec::new();
    let mut ident = String::new();
    for c in desc.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            ident.push(c);
        } else if c == '(' {
            if !ident.is_empty() {
                fns.push(std::mem::take(&mut ident));
            }
        } else if c == '[' {
            break;
        } else {
            ident.clear();
        }
    }
    fns.join("-")
}

/// `[d34db33f/84h/0h/0h]` becomes `Some("d34db33f/84h/0h/0h")`.
fn descriptor_origin(desc: &str) -> Option<String> {
    let open = desc.find('[')?;
    let close = desc[open..].find(']')? + open;
    let inner = desc[open + 1..close].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// The `N` of a trailing `/N/*`. `None` for an unranged descriptor.
fn descriptor_branch(desc: &str) -> Option<u32> {
    let star = desc.find("/*")?;
    let head = &desc[..star];
    let slash = head.rfind('/')?;
    head[slash + 1..].parse::<u32>().ok()
}

/// Turn one `listdescriptors` entry into a [`WatchKey`].
///
/// * outer `Err` — the entry contains key material that is not provably
///   public. The caller must abort the coin, not skip the entry (R8).
/// * inner `Err` — nothing watchable here (no extended key, or more than one,
///   which a single xpub cannot represent). The reason is returned so the
///   record can say so out loud.
pub(crate) fn parse_watch_key(entry: &Value) -> Result<Result<WatchKey, String>, String> {
    let desc = entry
        .get("desc")
        .and_then(|d| d.as_str())
        .ok_or_else(|| "a listdescriptors entry carried no desc field".to_string())?;

    // R8 runs FIRST, before any field is read out, so a private reply cannot
    // be partially transcribed before the refusal fires.
    let pubs = public_extended_keys(desc)?;
    if pubs.is_empty() {
        return Ok(Err(
            "no extended key (not a ranged account descriptor)".to_string()
        ));
    }
    if pubs.len() > 1 {
        return Ok(Err(
            "more than one extended key (multisig cannot be watched from a single xpub)"
                .to_string(),
        ));
    }
    let Some(branch) = descriptor_branch(desc) else {
        return Ok(Err(
            "no /N/* branch suffix (not a ranged descriptor)".to_string()
        ));
    };

    Ok(Ok(WatchKey {
        script: descriptor_script(desc),
        origin: descriptor_origin(desc),
        xpub: pubs.into_iter().next().expect("length checked above"),
        branch,
        internal: entry
            .get("internal")
            .and_then(|i| i.as_bool())
            .unwrap_or(branch == 1),
        active: entry
            .get("active")
            .and_then(|a| a.as_bool())
            .unwrap_or(false),
        range_end: entry
            .get("range")
            .and_then(|r| r.as_array())
            .and_then(|a| a.get(1))
            .and_then(|e| e.as_u64())
            .map(|e| e as u32),
    }))
}

/// Every watchable branch in a `listdescriptors` reply, plus the reasons the
/// rest were left out.
///
/// Accepts both the Core shape (`{wallet_name, descriptors: [...]}`) and a
/// bare array, because a fork returning the array directly is a shape
/// difference, not a security one.
pub(crate) fn watch_keys_from_listdescriptors(
    listed: &Value,
) -> Result<(Vec<WatchKey>, Vec<String>), String> {
    let entries = listed
        .get("descriptors")
        .and_then(|d| d.as_array())
        .or_else(|| listed.as_array())
        .ok_or_else(|| "listdescriptors did not return a descriptor list".to_string())?;

    let mut keys = Vec::new();
    let mut skipped = Vec::new();
    for e in entries {
        match parse_watch_key(e)? {
            Ok(k) => keys.push(k),
            Err(why) => skipped.push(why),
        }
    }
    skipped.sort();
    skipped.dedup();
    Ok((keys, skipped))
}

/// Last barrier before the write: re-scan the **serialized record** and refuse
/// anything that is not provably public.
///
/// Not redundant with [`parse_watch_key`], which sees one descriptor string at
/// a time. This sees the finished document, so a field added to [`WatchKey`]
/// or [`WatchRecord`] later — one nobody thought to route through the parser —
/// is still covered.
pub(crate) fn record_is_public(rec: &WatchRecord) -> Result<(), String> {
    let text = serde_json::to_string(rec).map_err(|e| format!("serialize watch record: {}", e))?;
    public_extended_keys(&text).map(|_| ())
}

/// `<coin>.json`, but only for a coin name that cannot be a path.
///
/// The key comes from `basicswap.json`'s `chainclients` map, which prepare
/// writes — but a file name derived from a config value is a path traversal
/// waiting for the day the config is not ours.
fn watch_file_name(coin: &str) -> Result<String, String> {
    if coin.is_empty()
        || !coin
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(format!(
            "{:?} is not a coin name this module will build a path from",
            coin
        ));
    }
    Ok(format!("{}.json", coin))
}

/// Write one coin's watch record, BOM-less, after the public-only re-scan.
pub(crate) fn write_watch_record(
    watch_dir: &std::path::Path,
    rec: &WatchRecord,
) -> Result<(), String> {
    record_is_public(rec)?;
    let name = watch_file_name(&rec.coin)?;
    std::fs::create_dir_all(watch_dir)
        .map_err(|e| format!("cannot create {}: {}", watch_dir.display(), e))?;
    let body = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    let path = watch_dir.join(name);
    std::fs::write(&path, body.as_bytes())
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))
}

/// Read one coin's watch record back. `None` for "never captured".
pub fn read_watch_record(watch_dir: &std::path::Path, coin: &str) -> Option<WatchRecord> {
    let name = watch_file_name(coin).ok()?;
    let raw = std::fs::read_to_string(watch_dir.join(name)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Capture each configured coin's account xpub into `<sidecar_base>/watch/`.
///
/// Returns the same capability rows as [`swap_daemon_capabilities`], with
/// `xpubAvailable` now meaning **"a key was actually captured"** rather than
/// "the daemon lists the command" — the two differ on any coin whose
/// `listdescriptors` exists but returns nothing watchable, and the caller's
/// next decision (can this balance render offline?) depends on the stronger
/// reading.
///
/// A coin that cannot answer gets a record saying so rather than no record; a
/// coin that answers with anything private aborts the whole command.
#[tauri::command]
pub async fn swap_daemon_capture_xpubs(app: AppHandle) -> Result<Vec<DaemonCapability>, String> {
    require_routing(env_flag(ROUTING_ENV))?;

    let cfg = read_config(&app)?;
    let watch_dir = swap_sidecar::sidecar_base_dir(&app)?.join("watch");
    let client = http_client()?;
    let mut out = Vec::new();

    let coins: Vec<String> = parse_chain_daemon_targets(&cfg)?
        .into_iter()
        .filter(|t| t.kind == DaemonKind::BitcoinRpc && is_loopback(&t.host))
        .map(|t| t.coin)
        .collect();

    for coin in coins {
        let Ok(target) = resolve_send_target(&cfg, &coin) else {
            continue;
        };
        // Unreachable daemons are OMITTED rather than reported all-false, for
        // the same reason [`swap_daemon_capabilities`] omits them: "we could
        // not ask" and "the answer is no" are different claims.
        let Ok((ep, info)) = resolve_endpoint(&client, &target).await else {
            continue;
        };
        let Ok(all_help) = daemon_rpc(&client, &ep, "help", json!([])).await else {
            continue;
        };
        let all_help = all_help.as_str().unwrap_or("").to_string();
        let fund_help = daemon_rpc(&client, &ep, "help", json!(["fundrawtransaction"]))
            .await
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let wallet = info
            .get("walletname")
            .and_then(|w| w.as_str())
            .unwrap_or(&target.wallet)
            .to_string();
        let captured_at = chrono::Utc::now().to_rfc3339();

        let (keys, skipped, unavailable) = if !help_lists_command(&all_help, "listdescriptors") {
            (
                Vec::new(),
                Vec::new(),
                Some(
                    "this coin's daemon has no listdescriptors, so there is no public read-back \
                     path; balances for it need the swap node running"
                        .to_string(),
                ),
            )
        } else {
            match daemon_rpc(&client, &ep, "listdescriptors", listdescriptors_params()).await {
                Ok(listed) => {
                    // R8 propagates: one private key anywhere fails the whole
                    // command, loudly, and writes nothing for this coin.
                    let (k, s) = watch_keys_from_listdescriptors(&listed)
                        .map_err(|e| format!("{}: {}", coin, e))?;
                    (k, s, None)
                }
                Err(e) => (Vec::new(), Vec::new(), Some(e.to_string())),
            }
        };

        let xpub_available = !keys.is_empty();
        let rec = WatchRecord {
            coin: coin.clone(),
            wallet: wallet.clone(),
            captured_at,
            keys,
            unavailable,
            skipped,
        };
        write_watch_record(&watch_dir, &rec)?;

        out.push(DaemonCapability {
            coin,
            wallet,
            descriptors: info
                .get("descriptors")
                .and_then(|d| d.as_bool())
                .unwrap_or(false),
            fee_rate: help_mentions_option(&fund_help, "fee_rate"),
            conf_target: help_mentions_option(&fund_help, "conf_target"),
            xpub_available,
        });
    }

    Ok(out)
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn conf_target(blocks: u16) -> FeeControl {
        FeeControl {
            mode: FeeMode::ConfTarget,
            blocks: Some(blocks),
            estimate_mode: None,
            sat_per_vb: None,
        }
    }
    fn fee_rate(sat_per_vb: f64) -> FeeControl {
        FeeControl {
            mode: FeeMode::FeeRate,
            blocks: None,
            estimate_mode: None,
            sat_per_vb: Some(sat_per_vb),
        }
    }

    /// A loopback port that is bound and immediately released, so a connection
    /// attempt fails fast and deterministically instead of hanging.
    fn absent_socket_port() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let p = l.local_addr().expect("addr").port();
        drop(l);
        p
    }

    // ---------------------------------------------------------------------
    // R7 — the renderer must never name an RPC method
    // ---------------------------------------------------------------------

    /// The allow-list guard must produce the **first** failure, before any
    /// socket is opened.
    ///
    /// The endpoint deliberately points at a closed loopback port. So:
    /// * guard present  => `RpcFault::Guard`
    /// * guard removed  => the call reaches the network and yields
    ///   `RpcFault::Transport` (connection refused)
    ///
    /// Asserting the *variant* rather than the message is what makes the
    /// mutation informative: a test that only checked `is_err()` would stay
    /// green with the guard deleted.
    #[tokio::test]
    async fn daemon_rpc_rejects_unlisted_method() {
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", absent_socket_port()),
            auth: None,
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();

        let err = daemon_rpc(&client, &ep, "walletpassphrase", json!([]))
            .await
            .expect_err("walletpassphrase must never be issued");

        assert!(
            matches!(err, RpcFault::Guard(_)),
            "expected the allow-list guard to reject before any socket was opened, got {:?}",
            err
        );
        assert!(
            err.to_string().contains("not allowed"),
            "guard message should say why: {}",
            err
        );
    }

    /// The dangerous methods are absent by name, so adding one is a visible
    /// diff in this file and in the list above.
    ///
    /// `listdescriptors` used to be on this list and no longer is: the xpub
    /// capture needs it. Its danger lives in an *argument*, not in the name —
    /// `listdescriptors` is public, `listdescriptors true` is every private
    /// key in the wallet — so the guard moved to
    /// `capture_never_asks_for_private_descriptors`, which asserts the params
    /// on the wire, and to `PUBLIC_EXTKEY_PREFIXES`, which refuses anything
    /// private that comes back anyway. Removing a name from here without
    /// putting an equivalent guard somewhere else is the mistake this note
    /// exists to make visible.
    #[test]
    fn allow_list_excludes_every_key_and_unlock_method() {
        for m in [
            "walletpassphrase",
            "dumpprivkey",
            "dumpwallet",
            "sethdseed",
            "importprivkey",
            "importdescriptors",
            "backupwallet",
            "encryptwallet",
            "walletlock",
            "lockunspent",
            "sendtoaddress",
            "sendmany",
            "settxfee",
        ] {
            assert!(
                !DAEMON_METHODS.contains(&m),
                "{} must not be reachable through daemon-direct routing",
                m
            );
        }
        // Sorted, so an inserted entry cannot hide in the middle of the list.
        let mut sorted = DAEMON_METHODS.to_vec();
        sorted.sort_unstable();
        assert_eq!(DAEMON_METHODS, sorted.as_slice());
    }

    /// A listed method with the same closed port reaches the network — which
    /// is the control that proves the test above is measuring the guard and
    /// not merely "everything errors here".
    #[tokio::test]
    async fn listed_method_reaches_the_network() {
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", absent_socket_port()),
            auth: None,
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();

        let err = daemon_rpc(&client, &ep, "getblockchaininfo", json!([]))
            .await
            .expect_err("nothing is listening on that port");
        assert!(
            matches!(err, RpcFault::Transport(_)),
            "a listed method must get past the guard and fail at the socket, got {:?}",
            err
        );
    }

    // ---------------------------------------------------------------------
    // Gates
    // ---------------------------------------------------------------------

    #[test]
    fn routing_is_off_until_the_env_flag_is_set() {
        assert_eq!(require_routing(false).unwrap_err(), ROUTING_DISABLED);
        assert!(require_routing(true).is_ok());
    }

    #[test]
    fn env_flag_is_only_on_for_exactly_one() {
        // Guard against a "set but empty" or "=0" reading as enabled.
        for v in ["", "0", "false", "no", " ", "2"] {
            std::env::set_var("PWNDA_TEST_FLAG_C2", v);
            assert!(!env_flag("PWNDA_TEST_FLAG_C2"), "{:?} must be off", v);
        }
        std::env::set_var("PWNDA_TEST_FLAG_C2", " 1 ");
        assert!(env_flag("PWNDA_TEST_FLAG_C2"));
        std::env::remove_var("PWNDA_TEST_FLAG_C2");
        assert!(!env_flag("PWNDA_TEST_FLAG_C2"));
    }

    #[test]
    fn broadcast_needs_regtest_or_the_explicit_mainnet_opt_in() {
        assert!(require_broadcast(Network::Regtest, false).is_ok());
        let err = require_broadcast(Network::Mainnet, false)
            .expect_err("a mainnet broadcast must not happen by accident");
        assert!(err.contains(ROUTING_MAINNET_ENV), "{}", err);
        assert!(require_broadcast(Network::Mainnet, true).is_ok());
    }

    /// Anything we cannot positively identify as regtest is treated as
    /// mainnet, i.e. as the guarded side of the gate.
    #[test]
    fn unknown_chain_names_fail_closed_to_mainnet() {
        assert_eq!(network_from_chain_field("regtest"), Network::Regtest);
        for c in ["main", "test", "signet", "devnet", "", "REGTEST", "regtest "] {
            assert_eq!(
                network_from_chain_field(c),
                Network::Mainnet,
                "{:?} must not open the broadcast gate",
                c
            );
        }
    }

    // ---------------------------------------------------------------------
    // Fee control — the stated reason this module exists
    // ---------------------------------------------------------------------

    #[test]
    fn fund_options_conf_target_shape() {
        let v = fund_options(&conf_target(6), false).unwrap();
        assert_eq!(v["conf_target"], json!(6));
        assert_eq!(v["estimate_mode"], json!("conservative"));
        assert_eq!(v["lockUnspents"], json!(false));
        assert!(v.get("fee_rate").is_none());
        assert!(v.get("subtractFeeFromOutputs").is_none());

        let mut c = conf_target(3);
        c.estimate_mode = Some("economical".into());
        let v = fund_options(&c, true).unwrap();
        assert_eq!(v["estimate_mode"], json!("economical"));
        assert_eq!(v["subtractFeeFromOutputs"], json!([0]));
    }

    #[test]
    fn fund_options_fee_rate_shape() {
        let v = fund_options(&fee_rate(12.5), false).unwrap();
        assert_eq!(v["fee_rate"], json!(12.5));
        assert_eq!(v["lockUnspents"], json!(false));
        assert!(v.get("conf_target").is_none());
        assert!(v.get("estimate_mode").is_none());
    }

    /// A dry run that locked its inputs would create the exact stuck-UTXO
    /// class this module exists to prevent, so the explicit `false` is
    /// asserted for both modes.
    #[test]
    fn fund_options_never_locks_unspents() {
        for f in [conf_target(1), fee_rate(1.0)] {
            for sub in [true, false] {
                let v = fund_options(&f, sub).unwrap();
                assert_eq!(
                    v["lockUnspents"],
                    json!(false),
                    "funding must never reserve inputs"
                );
            }
        }
    }

    #[test]
    fn fund_options_rejects_a_request_with_two_fee_intents() {
        let both = FeeControl {
            mode: FeeMode::ConfTarget,
            blocks: Some(6),
            estimate_mode: None,
            sat_per_vb: Some(5.0),
        };
        assert!(fund_options(&both, false)
            .unwrap_err()
            .contains("must not carry satPerVb"));

        let both2 = FeeControl {
            mode: FeeMode::FeeRate,
            blocks: Some(6),
            estimate_mode: None,
            sat_per_vb: Some(5.0),
        };
        assert!(fund_options(&both2, false)
            .unwrap_err()
            .contains("must not carry blocks"));
    }

    #[test]
    fn fund_options_rejects_missing_or_nonsense_values() {
        let no_blocks = FeeControl {
            mode: FeeMode::ConfTarget,
            blocks: None,
            estimate_mode: None,
            sat_per_vb: None,
        };
        assert!(fund_options(&no_blocks, false).is_err());
        assert!(fund_options(&conf_target(0), false).is_err());

        let mut bad_mode = conf_target(6);
        bad_mode.estimate_mode = Some("unset".into());
        assert!(fund_options(&bad_mode, false).is_err());

        let no_rate = FeeControl {
            mode: FeeMode::FeeRate,
            blocks: None,
            estimate_mode: None,
            sat_per_vb: None,
        };
        assert!(fund_options(&no_rate, false).is_err());
        assert!(fund_options(&fee_rate(0.0), false).is_err());
        assert!(fund_options(&fee_rate(-1.0), false).is_err());
        assert!(fund_options(&fee_rate(f64::NAN), false).is_err());
    }

    /// Deserialization is part of the contract: the renderer sends camelCase.
    #[test]
    fn request_deserializes_from_the_camel_case_wire_shape() {
        let req: DaemonSendRequest = serde_json::from_str(
            r#"{"coin":"bitcoin","toAddress":"bcrt1qexample","amountSat":250000,
                "subtractFee":true,"dryRun":true,
                "fee":{"mode":"feeRate","satPerVb":3.5}}"#,
        )
        .expect("camelCase wire shape must deserialize");
        assert_eq!(req.amount_sat, 250_000);
        assert!(req.subtract_fee);
        assert!(req.dry_run);
        assert_eq!(req.fee.mode, FeeMode::FeeRate);
        assert_eq!(req.fee.sat_per_vb, Some(3.5));

        let ct: DaemonSendRequest = serde_json::from_str(
            r#"{"coin":"litecoin","toAddress":"x","amountSat":1,"subtractFee":false,
                "dryRun":false,"fee":{"mode":"confTarget","blocks":6,
                "estimateMode":"economical"}}"#,
        )
        .expect("confTarget wire shape must deserialize");
        assert_eq!(ct.fee.mode, FeeMode::ConfTarget);
        assert_eq!(ct.fee.blocks, Some(6));
        assert_eq!(ct.fee.estimate_mode.as_deref(), Some("economical"));
    }

    #[test]
    fn result_serializes_camel_case() {
        let s = serde_json::to_string(&DaemonSendResult {
            txid: None,
            fee_sat: 141,
            vsize: 141,
            inputs: 1,
            locked_utxos: 2,
            broadcast: false,
        })
        .unwrap();
        assert!(s.contains("\"feeSat\":141"), "{}", s);
        assert!(s.contains("\"lockedUtxos\":2"), "{}", s);
        assert!(s.contains("\"txid\":null"), "{}", s);
    }

    // ---------------------------------------------------------------------
    // Amounts
    // ---------------------------------------------------------------------

    #[test]
    fn sat_to_coin_amount_round_trips_exactly() {
        for sat in [
            1u64,
            546,
            100_000_000,
            12_345_678,
            99_999_999,
            2_100_000_000_000_000,
        ] {
            let v = btc_amount_value(sat).unwrap();
            let text = serde_json::to_string(&v).unwrap();
            let back: f64 = text.parse().expect("serialized amount must parse");
            assert_eq!(
                (back * 1e8).round() as u64,
                sat,
                "amount {} serialized as {}",
                sat,
                text
            );
        }
        // The exact decimal a daemon sees, not just a value that round-trips.
        assert_eq!(
            serde_json::to_string(&btc_amount_value(12_345_678).unwrap()).unwrap(),
            "0.12345678"
        );
        assert_eq!(
            serde_json::to_string(&btc_amount_value(100_000_000).unwrap()).unwrap(),
            "1.0"
        );
    }

    #[test]
    fn zero_and_out_of_range_amounts_are_refused() {
        assert!(btc_amount_value(0).is_err());
        assert!(btc_amount_value(2_100_000_000_000_001).is_err());
    }

    #[test]
    fn fee_parses_from_both_number_and_string() {
        assert_eq!(btc_to_sat(&json!(0.00000141)).unwrap(), 141);
        assert_eq!(btc_to_sat(&json!("0.00000141")).unwrap(), 141);
        assert_eq!(btc_to_sat(&json!(0)).unwrap(), 0);
        assert!(btc_to_sat(&json!(null)).is_err());
        assert!(btc_to_sat(&json!("not a number")).is_err());
    }

    // ---------------------------------------------------------------------
    // The payload that decides where the money goes
    // ---------------------------------------------------------------------

    #[test]
    fn create_raw_params_shape() {
        let v = create_raw_params("bcrt1qexample", btc_amount_value(12_345_678).unwrap()).unwrap();
        // Exactly two positional params: inputs, then outputs.
        assert_eq!(v.as_array().map(|a| a.len()), Some(2));
        // No inputs — the daemon selects, which is the entire point.
        assert_eq!(v[0], json!([]));
        // Outputs is an OBJECT keyed by address, valued by amount. Transposed
        // or array-shaped output would be a different transaction.
        assert!(v[1].is_object(), "outputs must be an object: {}", v);
        assert_eq!(v[1]["bcrt1qexample"], json!(0.12345678));
        assert_eq!(v[1].as_object().map(|o| o.len()), Some(1));
        // The exact JSON text a daemon would receive.
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"[[],{"bcrt1qexample":0.12345678}]"#
        );
    }

    #[test]
    fn create_raw_params_trims_and_refuses_an_empty_destination() {
        let v = create_raw_params("  bcrt1qpadded  ", btc_amount_value(1).unwrap()).unwrap();
        assert!(v[1].get("bcrt1qpadded").is_some(), "{}", v);
        assert!(create_raw_params("   ", btc_amount_value(1).unwrap()).is_err());
        assert!(create_raw_params("", btc_amount_value(1).unwrap()).is_err());
    }

    // ---------------------------------------------------------------------
    // Coin -> daemon resolution
    // ---------------------------------------------------------------------

    fn cfg_with(extra: &str) -> String {
        format!(
            r#"{{"htmlport":12700,"chainclients":{{
                "particl":{{"connection_type":"rpc","manage_daemon":true,
                    "rpchost":"127.0.0.1","rpcport":19792,"datadir":"C:\\p",
                    "wallet_name":"bsx_wallet"}},
                "bitcoin":{{"connection_type":"rpc","manage_daemon":true,
                    "rpchost":"127.0.0.1","rpcport":19796,"datadir":"C:\\b"}},
                "monero":{{"connection_type":"rpc","manage_daemon":true,
                    "core_type_group":"xmr","rpchost":"127.0.0.1","rpcport":29798,
                    "manage_wallet_daemon":true,"walletrpcport":29800}}
                {}}}}}"#,
            extra
        )
    }

    #[test]
    fn resolves_a_bitcoin_family_coin_with_its_wallet_name() {
        let t = resolve_send_target(&cfg_with(""), "particl").unwrap();
        assert_eq!(t.port, 19792);
        assert_eq!(t.wallet, "bsx_wallet");
        assert_eq!(t.host, "127.0.0.1");
    }

    /// The engine's own fallback when `wallet_name` is absent is `wallet.dat`
    /// (`basicswap.py:2280`). Funding a *different* wallet than the engine
    /// uses would reinstate the two-selector race, so the fallback must match.
    #[test]
    fn wallet_name_falls_back_to_the_engines_own_default() {
        let t = resolve_send_target(&cfg_with(""), "bitcoin").unwrap();
        assert_eq!(t.wallet, "wallet.dat");
    }

    #[test]
    fn monero_is_refused_because_it_is_not_bitcoin_family() {
        let err = resolve_send_target(&cfg_with(""), "monero").unwrap_err();
        assert!(err.contains("not a bitcoin-family daemon"), "{}", err);
    }

    #[test]
    fn a_remote_daemon_is_refused() {
        let cfg = cfg_with(
            r#","dogecoin":{"connection_type":"rpc","manage_daemon":true,
                "rpchost":"203.0.113.9","rpcport":22555}"#,
        );
        let err = resolve_send_target(&cfg, "dogecoin").unwrap_err();
        assert!(err.contains("loopback-only"), "{}", err);
    }

    /// An unmanaged chainclient is refused with a message that names the
    /// actual reason, rather than the generic "not configured".
    #[test]
    fn an_unmanaged_daemon_is_refused_by_name() {
        let cfg = cfg_with(
            r#","dash":{"connection_type":"rpc","manage_daemon":false,
                "rpchost":"127.0.0.1","rpcport":9998}"#,
        );
        let err = resolve_send_target(&cfg, "dash").unwrap_err();
        assert!(err.contains("manage_daemon: false"), "{}", err);
    }

    #[test]
    fn an_electrum_chainclient_is_refused_by_name() {
        let cfg = cfg_with(r#","litecoin":{"connection_type":"electrum"}"#);
        let err = resolve_send_target(&cfg, "litecoin").unwrap_err();
        assert!(err.contains("no daemon to send through"), "{}", err);
    }

    #[test]
    fn an_unconfigured_coin_is_refused() {
        let err = resolve_send_target(&cfg_with(""), "firo").unwrap_err();
        assert!(err.contains("not configured"), "{}", err);
        assert!(resolve_send_target(&cfg_with(""), "  ").is_err());
        assert!(resolve_send_target("not json", "particl").is_err());
    }

    // ---------------------------------------------------------------------
    // URL construction
    // ---------------------------------------------------------------------

    #[test]
    fn multiwallet_url_matches_the_engines_own_shape() {
        assert_eq!(
            wallet_url("127.0.0.1", 19792, "bsx_wallet"),
            "http://127.0.0.1:19792/wallet/bsx_wallet"
        );
        // `.` is unreserved, so `wallet.dat` must not be escaped.
        assert_eq!(
            wallet_url("127.0.0.1", 19792, "wallet.dat"),
            "http://127.0.0.1:19792/wallet/wallet.dat"
        );
        // Bare `/` is the fallback for a fork built without multiwallet.
        assert_eq!(wallet_url("127.0.0.1", 19792, ""), "http://127.0.0.1:19792/");
    }

    /// A wallet name is influenceable through prepare's `<TICKER>_WALLET_NAME`
    /// env, so it must not be able to re-point the request at another path.
    #[test]
    fn a_wallet_name_cannot_escape_its_path_segment() {
        let u = wallet_url("127.0.0.1", 1, "../../evil?x=1");
        let segment = u.strip_prefix("http://127.0.0.1:1/wallet/").expect(&u);
        // `..` survives verbatim because `.` is unreserved — harmless, since
        // the wallet name is a map key in the daemon, not a filesystem path.
        // What must not survive is a separator: an unescaped `/` would add a
        // path segment and an unescaped `?` would start a query string.
        assert!(!segment.contains('/'), "{}", u);
        assert!(!segment.contains('?'), "{}", u);
        assert_eq!(u, "http://127.0.0.1:1/wallet/..%2F..%2Fevil%3Fx%3D1");
    }

    // ---------------------------------------------------------------------
    // R9 — never spend an output the engine has reserved
    // ---------------------------------------------------------------------

    #[test]
    fn a_funded_input_that_is_locked_is_refused_before_signing() {
        let decoded = json!({"vin":[
            {"txid":"aa","vout":0},
            {"txid":"bb","vout":1}
        ]});
        let locked = json!([{"txid":"bb","vout":1}]);
        let err =
            assert_no_locked_inputs(&vin_outpoints(&decoded), &locked_outpoints(&locked))
                .expect_err("a reserved input must abort the send");
        assert!(err.contains("bb:1"), "{}", err);
        assert!(err.contains("reserved for a swap"), "{}", err);
    }

    #[test]
    fn disjoint_inputs_and_locks_pass() {
        let decoded = json!({"vin":[{"txid":"aa","vout":0}]});
        let locked = json!([{"txid":"bb","vout":1}, {"txid":"aa","vout":9}]);
        assert!(assert_no_locked_inputs(
            &vin_outpoints(&decoded),
            &locked_outpoints(&locked)
        )
        .is_ok());
    }

    /// The vout is part of the identity: the same txid at a different index is
    /// a different output and must not trip the check.
    #[test]
    fn outpoint_identity_includes_the_vout() {
        assert_eq!(
            vin_outpoints(&json!({"vin":[{"txid":"aa","vout":2}]})),
            vec![("aa".to_string(), 2u64)]
        );
        assert!(vin_outpoints(&json!({})).is_empty());
        assert!(locked_outpoints(&json!([])).is_empty());
        assert!(locked_outpoints(&json!(null)).is_empty());
        // A coinbase vin has no txid/vout pair and must not panic.
        assert!(vin_outpoints(&json!({"vin":[{"coinbase":"01"}]})).is_empty());
    }

    // ---------------------------------------------------------------------
    // Capability probing
    // ---------------------------------------------------------------------

    const HELP_LIST: &str = "== Rawtransactions ==\n\
        createrawtransaction [{\"txid\":\"hex\",...}] ...\n\
        decoderawtransaction \"hexstring\" ( iswitness )\n\
        == Wallet ==\n\
        fundrawtransaction \"hexstring\" ( options iswitness )\n\
        listdescriptors ( private )\n\
        listlockunspent\n";

    #[test]
    fn help_command_list_is_matched_on_the_command_token() {
        assert!(help_lists_command(HELP_LIST, "listdescriptors"));
        assert!(help_lists_command(HELP_LIST, "fundrawtransaction"));
        // Absent commands, and the LTC case measured on regtest 2026-08-19.
        let ltc = HELP_LIST.replace("listdescriptors ( private )\n", "");
        assert!(!help_lists_command(&ltc, "listdescriptors"));
        assert!(!help_lists_command(HELP_LIST, "importdescriptors"));
        // A header line must not be mistaken for a command.
        assert!(!help_lists_command(HELP_LIST, "=="));
        // A name that only appears mid-line is not a command.
        assert!(!help_lists_command(HELP_LIST, "hexstring"));
    }

    const FUND_HELP_MODERN: &str = "fundrawtransaction \"hexstring\" ( options iswitness )\n\
        Options:\n  \"conf_target\": n,   (numeric) Confirmation target in blocks\n\
        \"estimate_mode\": \"str\",\n  \"fee_rate\": amount, (numeric) Specify a fee rate in sat/vB.\n";
    const FUND_HELP_OLD: &str = "fundrawtransaction \"hexstring\" ( options )\n\
        Options:\n  \"feeRate\": n,  (numeric) Set a specific feerate in BTC/kB\n";

    #[test]
    fn fee_options_are_detected_from_the_daemons_own_help() {
        assert!(help_mentions_option(FUND_HELP_MODERN, "fee_rate"));
        assert!(help_mentions_option(FUND_HELP_MODERN, "conf_target"));
        // An old fork that only has the legacy `feeRate` must report neither.
        assert!(!help_mentions_option(FUND_HELP_OLD, "fee_rate"));
        assert!(!help_mentions_option(FUND_HELP_OLD, "conf_target"));
        assert!(!help_mentions_option("", "fee_rate"));
    }

    /// Substring matching would report `fee_rate` for a daemon that only
    /// mentions `estimate_fee_rate`, which is the wrong answer in the
    /// dangerous direction (we would send a fee option the daemon rejects, or
    /// worse, silently ignores).
    #[test]
    fn option_detection_is_not_substring_matching() {
        assert!(!help_mentions_option("estimate_fee_rate", "fee_rate"));
        assert!(!help_mentions_option("conf_target_blocks", "conf_target"));
        assert!(help_mentions_option("\"fee_rate\":", "fee_rate"));
    }

    #[test]
    fn capability_serializes_camel_case() {
        let s = serde_json::to_string(&DaemonCapability {
            coin: "litecoin".into(),
            wallet: "wallet.dat".into(),
            descriptors: false,
            fee_rate: true,
            conf_target: true,
            xpub_available: false,
        })
        .unwrap();
        assert!(s.contains("\"feeRate\":true"), "{}", s);
        assert!(s.contains("\"confTarget\":true"), "{}", s);
        assert!(s.contains("\"xpubAvailable\":false"), "{}", s);
    }

    // ---------------------------------------------------------------------
    // Signing completeness
    // ---------------------------------------------------------------------

    /// `complete: false` still carries a `hex`. Broadcasting it is the bug, so
    /// the presence of a hex must never be mistaken for a signed transaction.
    #[test]
    fn an_incomplete_signature_is_refused_even_though_it_has_a_hex() {
        let partial = json!({
            "hex": "0200000001deadbeef0000000000",
            "complete": false,
            "errors": [{"txid": "aa", "vout": 0, "error": "Input not found or already spent"}]
        });
        let err = complete_signed_hex(&partial)
            .expect_err("an incompletely signed transaction must never be broadcast");
        assert!(err.contains("could not fully sign"), "{}", err);
        assert!(err.contains("already spent"), "the reason must survive: {}", err);

        assert_eq!(
            complete_signed_hex(&json!({"hex": "abcd", "complete": true})).unwrap(),
            "abcd"
        );
        // A daemon that omits `complete` is not asserting success.
        assert!(complete_signed_hex(&json!({"hex": "abcd"})).is_err());
        assert!(complete_signed_hex(&json!({"complete": true})).is_err());
    }

    // ---------------------------------------------------------------------
    // What daemon_rpc actually PRODUCES
    //
    // The Display tests below construct an `RpcFault` by hand, which proves
    // the mapping but says nothing about whether `daemon_rpc` ever builds that
    // variant. A JSON-RPC error arrives on **HTTP 500**, so a reader that
    // judged the status before parsing the body would turn every locked-wallet
    // reply into an opaque `Http(500, ..)` and the -13 mapping would be dead
    // code that still passed its own test. These tests close that gap against
    // a fake daemon.
    // ---------------------------------------------------------------------

    /// Minimal HTTP/1.1 responder. `reply` sees the request URI and returns
    /// `(status, body)`. Answers `Connection: close` so each call gets a fresh
    /// connection and the accept loop stays trivial.
    fn fake_daemon<F>(reply: F) -> u16
    where
        F: Fn(&str) -> (u16, String) + Send + Sync + 'static,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let uri = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                let (status, body) = reply(&uri);
                let resp = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        port
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    /// The locked-wallet reply arrives as HTTP 500 with a JSON-RPC error body.
    /// If the body were not parsed before the status was judged, this would be
    /// `Http(500, ..)` and the frozen -13 message would never be produced.
    #[tokio::test]
    async fn a_locked_wallet_reply_becomes_the_frozen_message_end_to_end() {
        let port = fake_daemon(|_| {
            (
                500,
                r#"{"result":null,"error":{"code":-13,"message":"Error: Please enter the wallet passphrase with walletpassphrase first."},"id":"pwnda"}"#
                    .to_string(),
            )
        });
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", port),
            auth: None,
        };
        let err = daemon_rpc(&client(), &ep, "fundrawtransaction", json!([]))
            .await
            .expect_err("a -13 body must not be reported as success");
        assert!(
            matches!(err, RpcFault::Rpc { code: -13, .. }),
            "an HTTP 500 carrying a JSON-RPC error must be decoded as one, got {:?}",
            err
        );
        assert_eq!(err.to_string(), "the swap node's wallet is locked");
    }

    #[tokio::test]
    async fn a_successful_reply_yields_the_result_field() {
        let port = fake_daemon(|_| {
            (
                200,
                r#"{"result":{"chain":"regtest","blocks":101},"error":null,"id":"pwnda"}"#
                    .to_string(),
            )
        });
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", port),
            auth: None,
        };
        let v = daemon_rpc(&client(), &ep, "getblockchaininfo", json!([]))
            .await
            .expect("a 200 with a result must decode");
        assert_eq!(v["chain"], json!("regtest"));
        assert_eq!(
            network_from_chain_field(v["chain"].as_str().unwrap()),
            Network::Regtest
        );
    }

    /// Contract 4.3 item 7: a fork built without multiwallet 404s
    /// `/wallet/<name>`. The probe must fall back to the bare root, and the
    /// fallback must be decided on a **read-only** method so no fund-moving
    /// call is ever retried against a second URL.
    #[tokio::test]
    async fn a_fork_without_multiwallet_falls_back_to_the_bare_root() {
        let port = fake_daemon(|uri| {
            if uri.starts_with("/wallet/") {
                (404, "{}".to_string())
            } else {
                (
                    200,
                    r#"{"result":{"walletname":""},"error":null,"id":"pwnda"}"#.to_string(),
                )
            }
        });
        let t = SendTarget {
            coin: "dogecoin".into(),
            host: "127.0.0.1".into(),
            port,
            wallet: "wallet.dat".into(),
            user: None,
            password: None,
            chain_datadir: None,
        };
        let (ep, _info) = resolve_endpoint(&client(), &t)
            .await
            .expect("a 404 on the multiwallet path must fall back, not fail");
        assert_eq!(ep.url, format!("http://127.0.0.1:{}/", port));
    }

    /// And the fallback must NOT fire for a daemon that does route multiwallet
    /// — otherwise every send would land on the daemon's default wallet, which
    /// is a different wallet than the engine uses.
    #[tokio::test]
    async fn a_multiwallet_daemon_keeps_the_wallet_scoped_url() {
        let port = fake_daemon(|uri| {
            if uri == "/wallet/bsx_wallet" {
                (
                    200,
                    r#"{"result":{"walletname":"bsx_wallet"},"error":null,"id":"pwnda"}"#
                        .to_string(),
                )
            } else {
                (
                    500,
                    r#"{"error":{"code":-18,"message":"no wallet"}}"#.to_string(),
                )
            }
        });
        let t = SendTarget {
            coin: "particl".into(),
            host: "127.0.0.1".into(),
            port,
            wallet: "bsx_wallet".into(),
            user: None,
            password: None,
            chain_datadir: None,
        };
        let (ep, info) = resolve_endpoint(&client(), &t).await.expect("multiwallet");
        assert_eq!(
            ep.url,
            format!("http://127.0.0.1:{}/wallet/bsx_wallet", port)
        );
        assert_eq!(info["walletname"], json!("bsx_wallet"));
    }

    // ---------------------------------------------------------------------
    // Error mapping (contract 1.3, frozen)
    // ---------------------------------------------------------------------

    #[test]
    fn a_locked_wallet_is_named_as_such_and_never_prompts() {
        let e = RpcFault::Rpc {
            code: -13,
            message: "Error: Please enter the wallet passphrase with walletpassphrase first."
                .into(),
        };
        assert_eq!(e.to_string(), "the swap node's wallet is locked");
        // The remedy must not leak the RPC that would unlock it.
        assert!(!e.to_string().contains("walletpassphrase"));
    }

    #[test]
    fn a_missing_method_names_the_fallback() {
        let e = RpcFault::Rpc {
            code: -32601,
            message: "Method not found".into(),
        };
        assert!(e.to_string().contains("does not support"), "{}", e);
    }

    #[test]
    fn other_rpc_errors_keep_their_code_and_message() {
        let e = RpcFault::Rpc {
            code: -6,
            message: "Insufficient funds".into(),
        };
        assert_eq!(e.to_string(), "coin daemon error -6: Insufficient funds");
    }

    // ---------------------------------------------------------------------
    // R8 — the xpub capture must never store a private extended key
    // ---------------------------------------------------------------------

    /// BIP84's own account-0 test vectors (m/84'/0'/0'), so the two strings
    /// below differ exactly the way a real reply would: same length, same
    /// alphabet, one version byte apart.
    const BIP84_ZPUB: &str = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
    const BIP84_ZPRV: &str = "zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE";

    fn descriptor_entry(desc: &str) -> Value {
        json!({
            "desc": desc,
            "timestamp": 1_231_006_505u64,
            "active": true,
            "internal": false,
            "range": [0, 999],
            "next": 0
        })
    }

    /// **R8, the required test.** `listdescriptors true` returns the private
    /// form; one wrong flag would write spending authority into
    /// `<sidecar_base>/watch/<coin>.json`.
    ///
    /// Falsified by its own control below: the identical descriptor with the
    /// `zpub` half is `Ok`, so this cannot be passing because "everything
    /// errors".
    #[test]
    fn watch_record_rejects_private_extkeys() {
        let desc = format!("wpkh([f0abc123/84h/0h/0h]{}/0/*)#checksum", BIP84_ZPRV);
        let err = parse_watch_key(&descriptor_entry(&desc))
            .expect_err("a private extended key must abort the coin, not be skipped");
        assert!(
            err.contains("not provably public"),
            "the refusal must name the class of problem, got {err:?}"
        );
        // And the refusal itself must not carry the key it refused.
        assert!(
            !err.contains(BIP84_ZPRV),
            "a refusal message ends up in a log; it must not contain the key"
        );
    }

    /// The control that makes the test above informative.
    #[test]
    fn the_public_form_of_the_same_descriptor_is_accepted() {
        let desc = format!("wpkh([f0abc123/84h/0h/0h]{}/0/*)#checksum", BIP84_ZPUB);
        let key = parse_watch_key(&descriptor_entry(&desc))
            .expect("a public descriptor must not be refused")
            .expect("a ranged wpkh descriptor is watchable");
        assert_eq!(key.xpub, BIP84_ZPUB);
        assert_eq!(key.script, "wpkh");
        assert_eq!(key.origin.as_deref(), Some("f0abc123/84h/0h/0h"));
        assert_eq!(key.branch, 0);
        assert!(!key.internal);
        assert!(key.active);
        assert_eq!(key.range_end, Some(999));
    }

    /// An extended key whose version prefix we do not recognise is refused
    /// rather than stored.
    ///
    /// This is the difference between an allow-list and a deny-list, and it is
    /// the whole reason the classifier is written the way it is: a deny-list
    /// would store this, because it is "not one of the private prefixes we
    /// listed".
    #[test]
    fn an_unrecognised_extended_prefix_fails_closed() {
        let bogus = format!("qprv{}", &BIP84_ZPUB[4..]);
        let desc = format!("wpkh([f0abc123/84h/0h/0h]{}/0/*)", bogus);
        assert!(
            parse_watch_key(&descriptor_entry(&desc)).is_err(),
            "an unknown extended-key prefix must be refused, not assumed public"
        );
    }

    /// A bare WIF secret — what `listdescriptors true` returns for an imported
    /// single key — is a different shape from an extended key and gets its own
    /// rejection.
    #[test]
    fn a_bare_wif_in_a_descriptor_is_refused() {
        // 52 base58 characters, compressed-WIF shaped.
        let wif = "L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ";
        assert_eq!(wif.chars().count(), 52);
        let desc = format!("pkh({})#checksum", wif);
        let err = parse_watch_key(&descriptor_entry(&desc))
            .expect_err("a WIF private key must be refused");
        assert!(err.contains("bare private key"), "{err}");
        assert!(!err.contains(wif));
    }

    /// The serialize-time re-scan catches key material in a field the
    /// descriptor parser never sees.
    ///
    /// Deliberately not a restatement of the parser's check: this is the guard
    /// that survives somebody adding a field to [`WatchKey`] and forgetting
    /// where the sanitising happens.
    #[test]
    fn record_is_public_catches_a_key_smuggled_into_another_field() {
        let mut rec = WatchRecord {
            coin: "bitcoin".to_string(),
            wallet: "wallet.dat".to_string(),
            captured_at: "2026-08-19T00:00:00+00:00".to_string(),
            keys: vec![WatchKey {
                script: "wpkh".to_string(),
                origin: Some("f0abc123/84h/0h/0h".to_string()),
                xpub: BIP84_ZPUB.to_string(),
                branch: 0,
                internal: false,
                active: true,
                range_end: Some(999),
            }],
            unavailable: None,
            skipped: Vec::new(),
        };
        record_is_public(&rec).expect("an all-public record must pass");

        rec.keys[0].origin = Some(BIP84_ZPRV.to_string());
        assert!(
            record_is_public(&rec).is_err(),
            "a private key anywhere in the serialized record must block the write"
        );
    }

    /// Multisig cannot be represented by one account xpub, so it is reported
    /// as skipped rather than silently dropped or half-stored.
    #[test]
    fn a_multi_key_descriptor_is_skipped_with_a_reason() {
        let second = format!("xpub{}", &BIP84_ZPUB[4..]);
        let desc = format!(
            "wsh(sortedmulti(2,[f0abc123/48h/0h/0h/2h]{}/0/*,[a1b2c3d4/48h/0h/0h/2h]{}/0/*))",
            BIP84_ZPUB, second
        );
        let listed = json!({ "wallet_name": "", "descriptors": [descriptor_entry(&desc)] });
        let (keys, skipped) =
            watch_keys_from_listdescriptors(&listed).expect("public multisig is not a refusal");
        assert!(keys.is_empty());
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].contains("more than one extended key"), "{:?}", skipped);
    }

    /// Nested script functions and the change branch both come through.
    #[test]
    fn descriptor_decomposition_covers_nesting_and_the_change_branch() {
        let desc = format!("sh(wpkh([f0abc123/49h/0h/0h]{}/1/*))#abcdefgh", BIP84_ZPUB);
        let key = parse_watch_key(&descriptor_entry(&desc))
            .expect("public")
            .expect("watchable");
        assert_eq!(key.script, "sh-wpkh");
        assert_eq!(key.branch, 1);
        assert_eq!(key.origin.as_deref(), Some("f0abc123/49h/0h/0h"));
    }

    /// A descriptor with no extended key at all is not an error — it is just
    /// not watchable.
    #[test]
    fn a_fixed_address_descriptor_is_skipped_not_refused() {
        let listed = json!([descriptor_entry("addr(bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4)")]);
        let (keys, skipped) = watch_keys_from_listdescriptors(&listed).expect("not a refusal");
        assert!(keys.is_empty());
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].contains("no extended key"), "{:?}", skipped);
    }

    /// A coin name from the config can never become a path.
    #[test]
    fn a_watch_file_name_cannot_escape_its_directory() {
        for bad in ["../evil", "bit/coin", "Bitcoin", "", "bit coin", "..", "c:evil"] {
            assert!(
                watch_file_name(bad).is_err(),
                "{bad:?} must not be turned into a file name"
            );
        }
        assert_eq!(watch_file_name("bitcoincash").unwrap(), "bitcoincash.json");
    }

    /// Round-trip through the real filesystem, including the public-only gate.
    #[test]
    fn a_written_record_reads_back_and_a_private_one_never_lands() {
        let dir = std::env::temp_dir().join(format!(
            "pwnda-watch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut rec = WatchRecord {
            coin: "litecoin".to_string(),
            wallet: "wallet.dat".to_string(),
            captured_at: "2026-08-19T00:00:00+00:00".to_string(),
            keys: Vec::new(),
            unavailable: Some("this coin's daemon has no listdescriptors".to_string()),
            skipped: Vec::new(),
        };
        write_watch_record(&dir, &rec).expect("an unavailable record still gets written");
        let back = read_watch_record(&dir, "litecoin").expect("reads back");
        assert_eq!(back, rec);
        assert!(
            back.unavailable.is_some(),
            "an empty record must say WHY it is empty — otherwise a balance view \
             cannot tell 'no keys' from 'never asked'"
        );

        rec.keys.push(WatchKey {
            script: "wpkh".to_string(),
            origin: None,
            xpub: BIP84_ZPRV.to_string(),
            branch: 0,
            internal: false,
            active: false,
            range_end: None,
        });
        assert!(
            write_watch_record(&dir, &rec).is_err(),
            "the write must be blocked, not merely flagged"
        );
        // And the earlier, good file must still be what is on disk.
        assert!(read_watch_record(&dir, "litecoin").unwrap().keys.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Records the full request text so a test can assert what actually went
    /// on the wire, which `fake_daemon` (URI only) cannot.
    fn fake_daemon_recording(
        status: u16,
        body: &'static str,
    ) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Ok(mut g) = sink.lock() {
                    g.push(head);
                }
                let resp = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (port, seen)
    }

    /// **The R8 attack, asserted on the wire.**
    ///
    /// `listdescriptors` and `listdescriptors true` are one JSON token apart
    /// and return the same shape. This drives the exact params the capture
    /// command passes and reads them back off a recording daemon, so
    /// `listdescriptors_params()` returning `[true]` — the whole catastrophe —
    /// turns this red. Asserting on the constant instead would only restate
    /// the code.
    #[tokio::test]
    async fn capture_never_asks_for_private_descriptors() {
        let (port, seen) = fake_daemon_recording(
            200,
            r#"{"result":{"wallet_name":"","descriptors":[]},"error":null,"id":"pwnda"}"#,
        );
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", port),
            auth: None,
        };
        daemon_rpc(&client(), &ep, "listdescriptors", listdescriptors_params())
            .await
            .expect("the public listdescriptors call must succeed");

        let recorded = seen.lock().unwrap().join("\n");
        // `json!` sorts its keys, so the body does not start with "jsonrpc" —
        // split on the header terminator instead of guessing the first field.
        let body = recorded
            .split_once("\r\n\r\n")
            .map(|(_, b)| b)
            .unwrap_or_else(|| panic!("no HTTP body in the recorded request: {recorded:?}"));
        let sent: Value = serde_json::from_str(body.trim()).expect("body parses as JSON");
        assert_eq!(sent["method"], "listdescriptors");
        assert_eq!(
            sent["params"],
            json!([]),
            "the private form (`listdescriptors true`) must never be requested"
        );
    }

    /// `listdescriptors` is on [`DAEMON_METHODS`] on purpose — the capture
    /// needs it — so the guard that used to be "the name is absent" has to be
    /// replaced by one on the *arguments*. That guard is
    /// `capture_never_asks_for_private_descriptors`; this asserts the pairing
    /// exists rather than leaving the removal from the deny-list unexplained.
    #[test]
    fn listdescriptors_is_reachable_but_only_in_its_public_form() {
        assert!(DAEMON_METHODS.contains(&"listdescriptors"));
        assert_eq!(listdescriptors_params(), json!([]));
        // The private-form flag has no spelling anywhere in this module's
        // params builder, which is the only place the call is constructed.
        assert!(!listdescriptors_params().to_string().contains("true"));
    }
}
