//! C3.5 — **zero-move adoption.** Import the user's own account descriptors
//! into the swap node's coin wallet, so the engine can spend funds that are
//! already on-chain without the user first moving them anywhere.
//!
//! # What this buys, and what it costs
//!
//! Without it, "trade the coins you already have" means *send them to the swap
//! node first* — a real on-chain transaction, a fee, a taint, and a window
//! where the funds sit in a wallet the user did not choose. With it, the user
//! imports their phrase, opts a coin in, and trades. Nothing moves.
//!
//! The cost is stated plainly because it is the largest key-handling expansion
//! in the whole convergence plan (contract §R10): after a successful import the
//! swap node's `wallet.dat` holds **spending authority over the user's
//! pre-existing funds**, and the only thing protecting that file at rest is the
//! C5 wallet-encryption password. That is why the first refusal below is not a
//! warning.
//!
//! # The four refusals
//!
//! 1. **§R10 — encryption.** [`check_encryption_gate`]. The session must hold a
//!    C5 key *and* the coin daemon's own `getwalletinfo` must prove the wallet
//!    encrypted and unlocked. `unlocked_until` is the proof: Core emits it only
//!    for an encrypted wallet, and `0` means locked.
//! 2. **§R12 — first sync.** [`check_first_sync_gate`]. A pruned node cannot
//!    rescan history it has discarded. An import issued after the chain has
//!    started syncing returns `success: true` for every descriptor and finds
//!    nothing; the user sees a zero balance and **no error at all**. This flag
//!    is the only thing between them and that outcome.
//! 3. **§R11 — inactive.** Every imported descriptor is `active: false`, and the
//!    change branch is `internal: true`. An active descriptor would make the
//!    engine hand out *the user's* addresses as its own deposit addresses.
//!    Enforced in [`importdescriptors_params`] / [`importmulti_params`].
//! 4. **§R16 — no key material out.** [`DescriptorImportReport`] carries branch
//!    *labels*, never a descriptor. A descriptor built from an account xprv is
//!    a spending key, and this struct is serialized straight to the webview.
//!
//! # The per-coin strategy is measured, not inferred
//!
//! Probed against the real binaries on 2026-08-19 — mirrored on the frontend in
//! `src/features/swap-sidecar/descriptorAdoption.ts`, which must stay in step:
//!
//! | coin | `importdescriptors` | `listdescriptors` | method | read-back |
//! |---|---|---|---|---|
//! | BTC  | yes | yes    | `importdescriptors` | verify   |
//! | LTC  | yes | **NO** | `importdescriptors` | **skip** |
//! | DOGE | yes | not probed | `importdescriptors` | tolerate |
//! | DASH | yes | not probed | `importdescriptors` | tolerate |
//! | BCH  | **NO** | n/a | `importmulti` (ranged) | tolerate |
//!
//! **LTC is the trap.** It accepts the import and then has no `listdescriptors`
//! to read the result back with. Verifying by read-back — the obvious way to
//! check an import worked — turns a *working* LTC import into a reported fault.
//! Hence [`ReadBack::Skip`]: for LTC the call is not made at all, rather than
//! made and forgiven, so a fork that answers a missing method with something
//! other than a clean method-not-found cannot produce a failure either.
//!
//! `Tolerate` is deliberately a third state and not a synonym for either
//! neighbour: DOGE and DASH were *not probed*, so "try it and believe nothing"
//! is the honest policy. Promote a row to `Verify` by probing it, never by
//! analogy — "DASH is a Bitcoin fork so it must have X" is the reasoning that
//! produced the unprobed rows in the first place.
//!
//! # Why this module has its own RPC allow-list
//!
//! `swap_daemon::DAEMON_METHODS` deliberately **excludes** `importdescriptors`
//! (`allow_list_excludes_every_key_and_unlock_method` asserts it). Both
//! properties are wanted at once: the fund-moving routing surface must never
//! import a key, and this adoption surface must never sign or broadcast one. So
//! [`DESCRIPTOR_METHODS`] is a second, three-entry list passed to
//! [`crate::swap_daemon::daemon_rpc_guarded`], and
//! `tests::descriptor_methods_are_disjoint_from_routing` pins the separation.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use zeroize::Zeroizing;

use bitcoin::key::Secp256k1;

use crate::swap::derive::{self, UtxoChain};
use crate::swap::keystore::{self, EncryptedVault};
use crate::swap_daemon::{self, DaemonEndpoint, RpcFault};
use crate::swap_sidecar::{self, Phase, SwapSidecarState};

// =========================================================================
// The allow-list (see the module header for why it is a second one)
// =========================================================================

/// Every JSON-RPC method C3.5 is permitted to issue.
///
/// Exactly the three it calls, and **disjoint** from
/// [`crate::swap_daemon::DAEMON_METHODS`]: the read-only calls this module also
/// makes (`getwalletinfo`, `listdescriptors`) are already on that list and go
/// through the ordinary [`crate::swap_daemon::daemon_rpc`], so the two lists
/// never need to overlap and are asserted not to.
///
/// Sorted, so an inserted entry cannot hide in the middle of a diff.
pub(crate) const DESCRIPTOR_METHODS: &[&str] =
    &["getdescriptorinfo", "importdescriptors", "importmulti"];

/// Frozen refusal prefix for §R10. The frontend's `precheckImport` shows its
/// own copy of this reasoning; Rust is the authority and this is its wording.
pub(crate) const ERR_NO_ENCRYPTION: &str =
    "wallet encryption (C5) must be enabled before importing keys";

/// Inclusive upper index of the imported range, on both branches.
///
/// **A choice, not a measurement.** 999 is ~50x the standard BIP-44 gap limit
/// of 20, which covers any realistic address history while staying cheap for
/// the daemon to derive. Mirrors `DEFAULT_RANGE_END` on the frontend.
pub const DEFAULT_RANGE_END: u32 = 999;

/// Refusal ceiling. A range in the millions makes the daemon derive millions of
/// keys and presents to the user as a hang, not as a mistake.
pub const MAX_RANGE_END: u32 = 50_000;

// =========================================================================
// The per-coin plan
// =========================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ImportMethod {
    Descriptors,
    Multi,
}

impl ImportMethod {
    /// The RPC name. `&'static str` so it can be handed to the guarded caller —
    /// a renderer-supplied `String` cannot coerce to it.
    pub(crate) fn rpc(self) -> &'static str {
        match self {
            ImportMethod::Descriptors => "importdescriptors",
            ImportMethod::Multi => "importmulti",
        }
    }

    /// The spelling that reaches the webview in
    /// [`DescriptorImportReport::method`] — frozen by the TS union
    /// `"importdescriptors" | "importmulti"`.
    pub(crate) fn label(self) -> &'static str {
        self.rpc()
    }
}

/// What to do about reading the import back.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ReadBack {
    /// `listdescriptors` is known present. Our branches missing after an import
    /// **is** a failure.
    Verify,
    /// Known absent (LTC). Do not call it; its absence is not evidence.
    Skip(&'static str),
    /// Not probed. Call it, but treat anything unhelpful as no information.
    Tolerate,
}

/// One coin's measured adoption plan.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CoinPlan {
    /// Lowercase ticker, e.g. `"bch"` — the spelling
    /// [`DescriptorImportReport::coin`] reports and the key the frontend's
    /// `adoptionPlanFor` uses.
    pub coin: &'static str,
    pub chain: UtxoChain,
    pub method: ImportMethod,
    pub read_back: ReadBack,
}

/// The plan for an engine `chainclients` coin name, or `None`.
///
/// `None` is a refusal, not a licence to fall back to Bitcoin's plan: running
/// BTC's `wpkh` / purpose-84 plan against a coin that needs `pkh` / purpose-44
/// imports descriptors for addresses the user does not own, and the failure
/// presents as a zero balance rather than as an error.
///
/// `particl` and `monero` are absent on purpose. Particl's wallet is the
/// *engine's own* (C1 seeds it from a BIP85 child, a different secret with a
/// different role), and Monero is not a descriptor chain at all.
pub(crate) fn plan_for(engine_coin: &str) -> Option<CoinPlan> {
    let (coin, chain, method, read_back) = match engine_coin {
        "bitcoin" => (
            "btc",
            UtxoChain::Btc,
            ImportMethod::Descriptors,
            ReadBack::Verify,
        ),
        "litecoin" => (
            "ltc",
            UtxoChain::Ltc,
            ImportMethod::Descriptors,
            ReadBack::Skip(
                "litecoin's daemon accepts importdescriptors but has no listdescriptors, so \
                 there is nothing to read the import back with",
            ),
        ),
        "dogecoin" => (
            "doge",
            UtxoChain::Doge,
            ImportMethod::Descriptors,
            ReadBack::Tolerate,
        ),
        "dash" => (
            "dash",
            UtxoChain::Dash,
            ImportMethod::Descriptors,
            ReadBack::Tolerate,
        ),
        "bitcoincash" => (
            "bch",
            UtxoChain::Bch,
            ImportMethod::Multi,
            ReadBack::Tolerate,
        ),
        _ => return None,
    };
    Some(CoinPlan {
        coin,
        chain,
        method,
        read_back,
    })
}

// =========================================================================
// Descriptor construction (§R10, §R11)
// =========================================================================

/// The two branches every import covers: `(index, internal)`.
///
/// Both, always. A one-branch import leaves **change** unspendable, which the
/// user experiences as "the balance is wrong" rather than as an error.
pub(crate) const BRANCHES: [(u32, bool); 2] = [(0, false), (1, true)];

/// `"bip84-external"`, `"bip44-internal"`, … — the only strings that reach the
/// report. Matches the frontend's `expectedBranchLabels`.
pub(crate) fn branch_label(chain: UtxoChain, internal: bool) -> String {
    format!(
        "bip{}-{}",
        chain.purpose(),
        if internal { "internal" } else { "external" }
    )
}

/// The **account** node's derivation path: `m/{purpose}'/{slip44}'/0'`.
///
/// Account, not master. Deriving the descriptor from the master key — which is
/// what upstream does for its *own* wallet (`interface/btc/btc.py:788`) — would
/// put a key with authority over every chain the user owns inside a wallet file
/// that only needs authority over one.
pub(crate) fn account_path(chain: UtxoChain) -> String {
    format!("m/{}'/{}'/0'", chain.purpose(), chain.slip44())
}

/// The same path in descriptor key-origin spelling: `84h/0h/0h`.
///
/// `h` rather than `'` matches the canonical form Core echoes back. The
/// checksum is computed over the exact bytes we send, so the two spellings must
/// never be mixed inside one descriptor.
pub(crate) fn origin_path(chain: UtxoChain) -> String {
    format!("{}h/{}h/0h", chain.purpose(), chain.slip44())
}

/// Purpose 84 → `wpkh`; purpose 44 → `pkh` (contract §1.5 item 3).
pub(crate) fn descriptor_fn(chain: UtxoChain) -> &'static str {
    match chain.purpose() {
        84 => "wpkh",
        _ => "pkh",
    }
}

/// Build one branch descriptor, **without** its checksum.
///
/// Shape: `wpkh([d34db33f/84h/0h/0h]xprv…/0/*)`. The key origin carries the
/// master *fingerprint* — four bytes of a public-key hash, not secret — so the
/// daemon reports a correct `hdkeypath` and the read-back can recognise our own
/// descriptors among the engine's.
pub(crate) fn build_descriptor(
    fingerprint: &str,
    chain: UtxoChain,
    account_xprv: &str,
    branch: u32,
) -> String {
    format!(
        "{}([{}/{}]{}/{}/*)",
        descriptor_fn(chain),
        fingerprint,
        origin_path(chain),
        account_xprv,
        branch
    )
}

/// The key material one import needs, derived in one place.
///
/// Exists as a named function rather than four lines inside the command for a
/// specific testing reason: `descriptor_is_account_xprv_not_master` used to
/// build its own account key and hand it to [`build_descriptor`], which meant
/// the test could not fail if the *command* had derived from the master node —
/// the exact defect it is named after. The command and the test now call the
/// same function, so a mutation in the derivation is visible to the test.
pub(crate) struct DerivedAccount {
    /// Master fingerprint, hex. Four bytes of a public-key hash — not secret,
    /// and what the descriptor's key origin and the read-back match on.
    pub fingerprint: String,
    pub master_xprv: Zeroizing<String>,
    pub account_xprv: Zeroizing<String>,
}

/// Derive the **account** node for `chain` from a BIP-39 seed.
///
/// The equality check at the end is cheap, and it is the one mistake whose
/// blast radius is every chain the user owns rather than just this one: a
/// descriptor carrying the master xprv gives the swap node's wallet file
/// spending authority over BTC, ETH, SOL and everything else at once.
pub(crate) fn derive_account(
    seed: &[u8],
    chain: UtxoChain,
    net: bitcoin::NetworkKind,
) -> Result<DerivedAccount, String> {
    let secp = Secp256k1::new();
    let master = derive::seed_to_xpriv_on(seed, net).map_err(|e| e.to_string())?;
    let account =
        derive::derive_xpriv_on(seed, &account_path(chain), net).map_err(|e| e.to_string())?;
    let out = DerivedAccount {
        fingerprint: master.fingerprint(&secp).to_string(),
        master_xprv: Zeroizing::new(master.to_string()),
        account_xprv: Zeroizing::new(account.to_string()),
    };
    if out.account_xprv.as_str() == out.master_xprv.as_str() {
        return Err(
            "refusing to import: the derived key is the vault master key, not an account key"
                .to_string(),
        );
    }
    Ok(out)
}

/// One branch, checksummed and ready to send.
///
/// `Debug` is hand-written and redacting: `desc` carries the **account xprv**,
/// so a derived `Debug` would put a spending key into any `{:?}` — a log line,
/// a panic message, an `anyhow` chain. Nothing formats this today, which is
/// exactly why it is worth fixing now: every other secret carrier in this
/// subsystem (`Secret`, `DerivedAccount`) already redacts, and the one that
/// did not was the one holding the most dangerous value.
#[derive(Clone, PartialEq)]
pub(crate) struct BranchImport {
    pub label: String,
    /// The full descriptor **including** its `#checksum`. Never serialized,
    /// never printed.
    pub desc: String,
    pub internal: bool,
}

impl std::fmt::Debug for BranchImport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchImport")
            .field("label", &self.label)
            .field("desc", &"<redacted: account extended private key>")
            .field("internal", &self.internal)
            .finish()
    }
}

/// `importdescriptors` params: one positional argument that is an array of
/// request objects (`interface/btc/btc.py:792-806`).
///
/// §R11 lives here: `active` is hard-coded `false` and never derived from an
/// argument, so there is no value a caller can pass that makes an imported
/// descriptor active. `range` is mandatory for a ranged descriptor — omitting
/// it makes Core refuse the whole batch.
pub(crate) fn importdescriptors_params(
    entries: &[BranchImport],
    timestamp: u64,
    range_end: u32,
) -> Value {
    let reqs: Vec<Value> = entries
        .iter()
        .map(|e| {
            let mut o = serde_json::Map::new();
            o.insert("desc".into(), json!(e.desc));
            o.insert("timestamp".into(), json!(timestamp));
            // §R11 — never active. The engine's own descriptors stay the
            // wallet's active set; ours are spendable-but-not-handed-out.
            o.insert("active".into(), json!(false));
            o.insert("range".into(), json!([0, range_end]));
            if e.internal {
                o.insert("internal".into(), json!(true));
            }
            Value::Object(o)
        })
        .collect();
    json!([reqs])
}

/// `importmulti` params — BCH's only route, since it has no
/// `importdescriptors`.
///
/// Two positional arguments: the request array and an options object.
/// `rescan: true` is passed **explicitly** rather than left to the default:
/// `rescan: false` is precisely the silent-nothing-found failure §R12 is about,
/// arriving by a second route, and a default is not something a test can pin.
///
/// `watchonly` and `keypool` are deliberately omitted. `watchonly: true`
/// alongside private keys is an error in Core ("Incompatibility found between
/// watchonly and keys"), both default to the value we want, and naming them
/// only adds fields a fork might reject.
pub(crate) fn importmulti_params(
    entries: &[BranchImport],
    timestamp: u64,
    range_end: u32,
) -> Value {
    let reqs: Vec<Value> = entries
        .iter()
        .map(|e| {
            let mut o = serde_json::Map::new();
            o.insert("desc".into(), json!(e.desc));
            o.insert("timestamp".into(), json!(timestamp));
            o.insert("range".into(), json!([0, range_end]));
            if e.internal {
                o.insert("internal".into(), json!(true));
            }
            Value::Object(o)
        })
        .collect();
    json!([reqs, { "rescan": true }])
}

// =========================================================================
// Gates
// =========================================================================

/// §R10 — refuse unless the wallet we are about to write a spending key into is
/// encrypted at rest **and** currently unlocked.
///
/// Two independent facts, because either alone is insufficient:
///
/// * `session_key_set` — C5 is configured for this session. Without it the node
///   was started with no `WALLET_ENCRYPTION_PWD` and prepare never encrypted
///   anything.
/// * `unlocked_until` from the coin daemon's **own** `getwalletinfo` — the
///   authority on the file we are importing into, as opposed to the engine's
///   second-hand view of it. Core emits the field **only for an encrypted
///   wallet**, so its absence is the "not encrypted" signal; `0` means
///   encrypted but locked.
///
/// Absence is read as *not encrypted* rather than as *unknown*, which is the
/// fail-closed direction: being wrong that way costs a refused import that
/// would have been safe, and being wrong the other way puts a plaintext account
/// xprv on disk.
pub(crate) fn check_encryption_gate(
    session_key_set: bool,
    walletinfo: &Value,
) -> Result<(), String> {
    if !session_key_set {
        return Err(format!(
            "{} — no wallet key is set for this session, so the swap node's wallet file is not \
             encrypted at rest. After an import that file can spend your existing funds, and the \
             encryption password is the only thing protecting it.",
            ERR_NO_ENCRYPTION
        ));
    }
    let raw = walletinfo.get("unlocked_until").ok_or_else(|| {
        format!(
            "{} — this coin's daemon reports an unencrypted wallet (getwalletinfo has no \
             unlocked_until field). Restart the swap node with wallet encryption configured \
             before importing any key.",
            ERR_NO_ENCRYPTION
        )
    })?;
    let until = raw
        .as_i64()
        .or_else(|| raw.as_f64().map(|f| f as i64))
        .ok_or_else(|| {
            format!(
                "{} — this coin's daemon reported an unreadable unlocked_until value",
                ERR_NO_ENCRYPTION
            )
        })?;
    if until <= 0 {
        return Err(format!(
            "{} — this coin's wallet is encrypted but locked. Start the swap node with the wallet \
             key set so it unlocks itself, then try again.",
            ERR_NO_ENCRYPTION
        ));
    }
    Ok(())
}

/// §R12 — refuse once this coin's chain has started syncing.
///
/// The error names **both** remedies on purpose. "Too late" with no way forward
/// is what makes a user reach for the one action that definitely works and
/// definitely costs them a fee and their privacy — sending everything to the
/// node — without ever being told that wiping the chaindata keeps the zero-move
/// promise intact.
pub(crate) fn check_first_sync_gate(first_sync_started: bool, coin: &str) -> Result<(), String> {
    if !first_sync_started {
        return Ok(());
    }
    Err(format!(
        "{} has already started syncing, so importing now would find nothing: a pruned node \
         cannot rescan history it has discarded, and the import would report success for every \
         descriptor while the balance stayed at zero. Two ways forward — wipe this coin's \
         chaindata and let it resync with the descriptors already in place, or switch this coin \
         to the consolidation fallback and move the funds once.",
        coin
    ))
}

/// Validate `rangeEnd`, mirroring the frontend's ceiling so both sides refuse
/// the same inputs. Absent means [`DEFAULT_RANGE_END`].
pub(crate) fn check_range_end(v: Option<u32>) -> Result<u32, String> {
    let end = v.unwrap_or(DEFAULT_RANGE_END);
    if end > MAX_RANGE_END {
        return Err(format!(
            "rangeEnd must be at most {}; {} would make the daemon derive so many keys that the \
             import is indistinguishable from a hang",
            MAX_RANGE_END, end
        ));
    }
    Ok(end)
}

/// Validate the descriptor `timestamp`. Absent means `0` — rescan from genesis.
///
/// **Never `"now"`.** `"now"` tells the daemon to skip every block before this
/// instant, which is exactly the history the import exists to find; it would
/// succeed, import cleanly, and show zero. A birthday in the future is refused
/// because it reaches the same outcome by a shorter route.
pub(crate) fn check_birthday(v: Option<u64>, now_unix: i64) -> Result<u64, String> {
    let b = match v {
        None => return Ok(0),
        Some(b) => b,
    };
    if now_unix > 0 && b > now_unix as u64 {
        return Err(format!(
            "birthdayUnix {} is in the future; the rescan would skip every block that could hold \
             your funds",
            b
        ));
    }
    Ok(b)
}

/// Are we talking to the wallet the engine actually spends from?
///
/// Contract §4.3 item 11: importing into the *watch* wallet yields watch-only
/// UTXOs the engine cannot spend, and the failure surfaces much later as "the
/// swap won't fund". [`crate::swap_daemon::resolve_send_target`] reads
/// `chainclients.<coin>.wallet_name` (the `_rpc_wallet`), and
/// [`crate::swap_daemon::resolve_endpoint`] may fall back to the bare `/` URL on
/// a fork without multiwallet routing — which is the case where we could land on
/// a *different* wallet without noticing.
///
/// # Why `routed_by_name` is a parameter and not an assumption
///
/// A mismatch only *means* something when we asked for a wallet by name. On a
/// fork built without multiwallet routing — Dogecoin Core is the live case —
/// `resolve_endpoint` falls back to the bare `/` URL, and that daemon's one and
/// only wallet may well report a `walletname` that is not the string in
/// `chainclients.<coin>.wallet_name` (commonly `""` for the legacy default
/// wallet). There is no second wallet it could be, so refusing there would
/// block a perfectly good import on every fork without multiwallet support.
///
/// This distinction was **not** in the first version of this function, which
/// refused on any mismatch. It is the second shape CONTRIBUTING.md names by name: a
/// precondition copied from a neighbouring operation. "The daemon must confirm
/// the wallet name" is true of the multiwallet route, and is an assumption about
/// which route we are on everywhere else.
///
/// `Ok(Some(warning))` when the answer is not evidence either way;
/// `Err` only when we named a wallet, the daemon named a different one, and both
/// facts are therefore about the same question.
pub(crate) fn check_wallet_target(
    configured: &str,
    walletinfo: &Value,
    routed_by_name: bool,
) -> Result<Option<String>, String> {
    let Some(name) = walletinfo.get("walletname").and_then(|w| w.as_str()) else {
        return Ok(Some(format!(
            "this daemon's getwalletinfo did not name the wallet, so it could not be confirmed \
             that the import landed in {:?} rather than a watch wallet",
            configured
        )));
    };
    if configured.is_empty() || name == configured {
        return Ok(None);
    }
    if !routed_by_name {
        return Ok(Some(format!(
            "this daemon has no multiwallet routing, so the import went to its only wallet \
             ({:?}) rather than to the configured {:?}",
            name, configured
        )));
    }
    Err(format!(
        "the daemon answered for wallet {:?} but the swap node spends from {:?}; importing here \
         would give the engine keys it never uses, and the swap would fail to fund later",
        name, configured
    ))
}

// =========================================================================
// Results and read-back
// =========================================================================

/// Read an `importdescriptors` / `importmulti` reply.
///
/// Both return an array with one entry per request:
/// `{success, warnings?, error?: {code, message}}`. A `success: false` anywhere
/// fails the whole import — a partial import leaves one branch of the wallet
/// unspendable, and reporting that as success is worse than reporting nothing.
///
/// The daemon's own warning strings are passed through, which is why every
/// caller scrubs them: an error text can echo the descriptor back.
pub(crate) fn parse_import_results(v: &Value, expected: usize) -> Result<Vec<String>, String> {
    let arr = v
        .as_array()
        .ok_or_else(|| "the daemon's import reply was not an array".to_string())?;
    if arr.len() != expected {
        return Err(format!(
            "the daemon answered for {} descriptor(s) but {} were sent",
            arr.len(),
            expected
        ));
    }
    let mut warnings = Vec::new();
    for (i, entry) in arr.iter().enumerate() {
        let ok = entry
            .get("success")
            .and_then(|s| s.as_bool())
            .unwrap_or(false);
        if !ok {
            let msg = entry
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("(the daemon gave no reason)");
            return Err(format!("descriptor {} was rejected: {}", i, msg));
        }
        if let Some(ws) = entry.get("warnings").and_then(|w| w.as_array()) {
            for w in ws {
                if let Some(s) = w.as_str() {
                    warnings.push(s.to_string());
                }
            }
        }
    }
    Ok(warnings)
}

/// Which branch indices of *our* account appear in a `listdescriptors` reply.
///
/// Recognised by the master fingerprint in the key origin, because the reply
/// carries the **public** form of every descriptor (`listdescriptors` with no
/// argument — never `true`, which returns xprv and is the §R8 catastrophe) and
/// so cannot be matched on the xprv we sent.
///
/// The descriptor strings themselves are read and dropped; nothing here is
/// stored or reported.
pub(crate) fn read_back_branches(listed: &Value, fingerprint: &str) -> Vec<u32> {
    let needle = format!("[{}/", fingerprint.to_ascii_lowercase());
    let mut out: Vec<u32> = listed
        .get("descriptors")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("desc").and_then(|d| d.as_str()))
                .filter(|d| d.to_ascii_lowercase().contains(&needle))
                .filter_map(trailing_branch)
                .collect()
        })
        .unwrap_or_default();
    out.sort_unstable();
    out.dedup();
    out
}

/// The `N` of a trailing `/N/*`, ignoring any `#checksum`.
fn trailing_branch(desc: &str) -> Option<u32> {
    let head = desc.split('#').next().unwrap_or(desc);
    let star = head.find("/*")?;
    let head = &head[..star];
    let slash = head.rfind('/')?;
    head[slash + 1..].parse::<u32>().ok()
}

/// Did the read-back find both branches?
pub(crate) fn read_back_confirms(listed: &Value, fingerprint: &str) -> bool {
    let found = read_back_branches(listed, fingerprint);
    BRANCHES.iter().all(|(i, _)| found.contains(i))
}

// =========================================================================
// Scrubbing
// =========================================================================

/// Replace known secrets in text that is about to reach the webview.
///
/// **Measured, not assumed** (2026-08-19): `swap_sidecar::redact_secrets` does
/// *not* catch an xprv embedded in a descriptor. Its token rule requires the
/// whole token to be alphanumeric after trimming, and
/// `[fp/84h/0h/0h]xprv…/0/*` never is, because of the slashes. Pinned by
/// `redact_secrets_alone_does_not_see_a_descriptor_embedded_xprv` — if that
/// test ever goes red because `redact_secrets` improved, delete the test; do
/// not "fix" it by weakening this function.
///
/// Exact replacement of the strings we actually hold is strictly stronger than
/// any pattern, so that runs first; `redact_secrets` then runs as the backstop
/// for anything the daemon echoed that we did not construct.
pub(crate) fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    // Longest first: replacing the account xprv before the descriptor that
    // contains it would leave a half-redacted descriptor and make the
    // descriptor replacement silently miss.
    let mut ordered: Vec<&&str> = secrets.iter().collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for s in ordered {
        if s.len() < 8 {
            continue;
        }
        out = out.replace(*s, "[redacted]");
    }
    swap_sidecar::redact_secrets(&out)
}

// =========================================================================
// The report
// =========================================================================

/// What C3.5 actually imported.
///
/// §R16: `imported` carries **branch labels only**. Adding a descriptor here
/// would serialize a spending key to the webview — see
/// `tests::import_report_leaks_no_key_material`, and the frontend's
/// `reportContainsKeyMaterial`, which refuses to render a report that looks
/// like it happened anyway.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DescriptorImportReport {
    /// Lowercase ticker (`"btc"`) — the C3.5 spelling, matching the frontend's
    /// `adoptionPlanFor` keys. The engine `chainclients` name is available from
    /// `swap_sidecar::coin_key_from` for a caller that needs it.
    pub coin: String,
    /// The `_rpc_wallet` the import targeted.
    pub wallet_name: String,
    pub imported: Vec<String>,
    pub method: String,
    pub warnings: Vec<String>,
}

// =========================================================================
// Wiring
// =========================================================================

async fn descriptor_rpc(
    client: &reqwest::Client,
    ep: &DaemonEndpoint,
    method: &'static str,
    params: Value,
) -> Result<Value, RpcFault> {
    swap_daemon::daemon_rpc_guarded(client, ep, DESCRIPTOR_METHODS, method, params).await
}

fn read_config(app: &AppHandle) -> Result<String, String> {
    let path = swap_sidecar::datadir(app)?.join("basicswap.json");
    let raw = std::fs::read(&path).map_err(|e| {
        format!(
            "the swap node is not configured yet ({}): {}",
            path.display(),
            e
        )
    })?;
    swap_sidecar::strip_bom(&raw).map(|s| s.to_string())
}

/// `importdescriptors` rescans **synchronously**, so this timeout has to cover
/// a rescan rather than a round trip. The §R12 gate keeps the chain short —
/// that is half of why the gate exists — but a fork with a few thousand blocks
/// already on disk still takes real time.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("http client build failed: {}", e))
}

/// Ask the daemon for a descriptor's checksum.
///
/// # The single most dangerous line in this file
///
/// `getdescriptorinfo` returns **two** descriptor-shaped fields:
///
/// * `descriptor` — the canonical form **with private keys removed**;
/// * `checksum` — the checksum of the descriptor that was *passed in*.
///
/// Importing `result.descriptor` would therefore import the *watch-only*
/// version of the user's account: every address recognised, no output
/// spendable, and nothing anywhere reporting an error. It is one field name
/// away from the correct code and it is exactly contract §4.3 item 11's
/// failure. So the checksum is appended to **our** string, and
/// `tests::checksum_is_appended_to_our_descriptor_not_the_daemons` pins it.
async fn checksummed(
    client: &reqwest::Client,
    ep: &DaemonEndpoint,
    desc: &str,
    secrets: &[&str],
) -> Result<String, String> {
    let v = descriptor_rpc(client, ep, "getdescriptorinfo", json!([desc]))
        .await
        .map_err(|e| scrub(&e.to_string(), secrets))?;
    compose_checksummed(desc, &v)
}

/// The pure half of [`checksummed`], split out so the field choice above is a
/// unit test rather than a code-reading exercise.
pub(crate) fn compose_checksummed(desc: &str, reply: &Value) -> Result<String, String> {
    let checksum = reply
        .get("checksum")
        .and_then(|c| c.as_str())
        .ok_or_else(|| "the daemon's getdescriptorinfo reply carried no checksum".to_string())?;
    Ok(format!("{}#{}", desc, checksum))
}

/// C3.5 — import the user's account descriptors into the swap node's wallet.
///
/// See the module header for the four refusals and the per-coin matrix. What
/// crosses this boundary is the **encrypted** vault plus the password; the
/// mnemonic and the account xprv are produced here and never leave. There is
/// deliberately no TS helper that derives an account xprv, and adding one would
/// defeat this arrangement rather than complement it.

/// Has this coin's chain already begun syncing, as far as we can tell?
///
/// The **direction of the unknown answer is the security property**, so it
/// lives in one place rather than being spelled out at the call site (an
/// earlier version inlined it, and a test then copied that inline logic
/// "verbatim" — so the test could not track the fix when the logic changed).
///
/// * an explicit entry is authoritative;
/// * no entry, but the coin is already in `basicswap.json` -> presume it HAS
///   synced and refuse. Those are pre-C3 installs carrying `coins: {}`, whose
///   chains have been running since before the field existed. Reading absence
///   as "not synced" made R12 inert for exactly the population it protects:
///   the import is allowed, every descriptor reports `success: true`, and the
///   balance stays at zero with no error anywhere.
/// * no entry and not configured -> genuinely new, safe to import into.
fn first_sync_presumed_started(
    entry: Option<&swap_sidecar::CoinOptIn>,
    configured: bool,
) -> bool {
    match entry {
        Some(e) => e.first_sync_started,
        None => configured,
    }
}

#[tauri::command]
pub async fn swap_sidecar_import_descriptors(
    app: AppHandle,
    state: tauri::State<'_, SwapSidecarState>,
    coin: String,
    encrypted: EncryptedVault,
    password: String,
    birthday_unix: Option<u64>,
    range_end: Option<u32>,
) -> Result<DescriptorImportReport, String> {
    // ---- identity -------------------------------------------------------
    let engine_coin = swap_sidecar::coin_key_from(&coin).ok_or_else(|| {
        format!(
            "{:?} is not a coin the swap node can run — expected one of: {}",
            coin,
            swap_sidecar::WALLET_SIDECAR_COINS.join(", ")
        )
    })?;
    let plan = plan_for(engine_coin).ok_or_else(|| {
        format!(
            "{} has no measured descriptor-import plan; fund it by depositing to the swap node's \
             own address instead",
            engine_coin
        )
    })?;

    // ---- consent, enablement, and R12 -----------------------------------
    let rec = swap_sidecar::read_optin(&app);
    if !rec.opted_in {
        return Err(
            "the BasicSwap sidecar has not been enabled — accept the setup screen first"
                .to_string(),
        );
    }
    if !swap_sidecar::enabled_coins(&rec)
        .iter()
        .any(|c| c == engine_coin)
    {
        return Err(format!(
            "{} is not enabled for the DEX; enable it before importing keys into its wallet",
            engine_coin
        ));
    }
    // R12, and the direction of the default is the whole point.
    //
    // An ABSENT `CoinOptIn` entry used to read as `false` — "has not synced" —
    // which is fail-OPEN, and on a pre-C3 record (`coins: {}`) that is every
    // coin. Those installs have been syncing since before the field existed,
    // so the one population R12 protects was the one it could not fire for:
    // the import would be permitted, every descriptor would report
    // `success: true`, and the balance would sit at zero with no error.
    //
    // So an unknown answer now depends on whether the node has this coin
    // CONFIGURED. A coin already in `basicswap.json` has had a daemon running
    // against it, so absent knowledge means "assume it synced" and refuse; a
    // coin not yet configured is genuinely new and safe to import into. That
    // keeps the happy path (enable a coin, import, then sync) working while
    // failing closed for the case that silently loses money's worth of time.
    let configured = swap_sidecar::datadir(&app)
        .ok()
        .and_then(|dd| swap_sidecar::configured_coins_in(&dd))
        .unwrap_or_default()
        .iter()
        .any(|c| c == engine_coin);
    check_first_sync_gate(
        first_sync_presumed_started(rec.coins.get(engine_coin), configured),
        engine_coin,
    )?;

    // ---- options --------------------------------------------------------
    let range_end = check_range_end(range_end)?;
    let timestamp = check_birthday(birthday_unix, chrono::Utc::now().timestamp())?;

    // ---- the node must be up --------------------------------------------
    match swap_sidecar::phase_snapshot(&state)? {
        Phase::Healthy => {}
        other => {
            return Err(format!(
                "the swap node is not running (phase {:?}); the import goes through its own coin \
                 daemon, which only exists while the node is up",
                other
            ))
        }
    }
    let session_key_set = swap_sidecar::wallet_key_is_set(&state)?;

    // ---- resolve the daemon and read its wallet state -------------------
    let cfg = read_config(&app)?;
    let target = swap_daemon::resolve_send_target(&cfg, engine_coin)?;
    let client = http_client()?;
    let (ep, walletinfo) = swap_daemon::resolve_endpoint(&client, &target).await?;

    // ---- R10: encryption, before a single key is derived ----------------
    check_encryption_gate(session_key_set, &walletinfo)?;
    let mut warnings: Vec<String> = Vec::new();
    // Compared against the URL builder rather than sniffed out of the string, so
    // "did we ask for this wallet by name?" is answered by the same function
    // that formed the request.
    let routed_by_name =
        ep.url == swap_daemon::wallet_url(&target.host, target.port, &target.wallet);
    if let Some(w) = check_wallet_target(&target.wallet, &walletinfo, routed_by_name)? {
        warnings.push(w);
    }

    // ---- which network's keys does this daemon accept? ------------------
    //
    // BIP-32 serialises the network into a key's version bytes and Core
    // validates them against its own chain, so a mainnet `xprv` sent to a
    // regtest node is refused with `wpkh(): key '...' is not valid`. Ask the
    // daemon rather than assuming: the answer differs between a shipped
    // mainnet install and the regtest harness the feature is TESTED on, and
    // assuming mainnet is what made this untestable anywhere but mainnet.
    let chain_info = swap_daemon::daemon_rpc_guarded(
        &client,
        &ep,
        swap_daemon::DAEMON_METHODS,
        "getblockchaininfo",
        json!([]),
    )
    .await
    .map_err(|e| format!("could not read the coin daemon's network: {}", e))?;
    let key_network = match swap_daemon::network_from_chain_field(
        chain_info.get("chain").and_then(|c| c.as_str()).unwrap_or(""),
    ) {
        swap_sidecar::Network::Mainnet => bitcoin::NetworkKind::Main,
        _ => bitcoin::NetworkKind::Test,
    };

    // ---- derive ---------------------------------------------------------
    // Everything from here on holds key material. Every error path below goes
    // through `scrub`.
    let mnemonic = keystore::decrypt_vault(&encrypted, &password).map_err(|e| e.to_string())?;
    let seed = derive::mnemonic_to_seed(&mnemonic, "").map_err(|e| e.to_string())?;
    drop(mnemonic);

    let DerivedAccount {
        fingerprint,
        master_xprv,
        account_xprv,
    } = derive_account(&seed[..], plan.chain, key_network)?;

    // ---- build both branches --------------------------------------------
    let plain: Vec<(String, String, bool)> = BRANCHES
        .iter()
        .map(|(idx, internal)| {
            (
                branch_label(plan.chain, *internal),
                build_descriptor(&fingerprint, plan.chain, account_xprv.as_str(), *idx),
                *internal,
            )
        })
        .collect();

    let mut secrets: Vec<&str> = vec![account_xprv.as_str(), master_xprv.as_str()];
    for (_, d, _) in &plain {
        secrets.push(d.as_str());
    }

    let mut entries: Vec<BranchImport> = Vec::with_capacity(plain.len());
    for (label, desc, internal) in &plain {
        entries.push(BranchImport {
            label: label.clone(),
            desc: checksummed(&client, &ep, desc, &secrets).await?,
            internal: *internal,
        });
    }

    // ---- import ---------------------------------------------------------
    let params = match plan.method {
        ImportMethod::Descriptors => importdescriptors_params(&entries, timestamp, range_end),
        ImportMethod::Multi => importmulti_params(&entries, timestamp, range_end),
    };
    let reply = descriptor_rpc(&client, &ep, plan.method.rpc(), params)
        .await
        .map_err(|e| scrub(&e.to_string(), &secrets))?;
    let daemon_warnings =
        parse_import_results(&reply, entries.len()).map_err(|e| scrub(&e, &secrets))?;
    for w in daemon_warnings {
        warnings.push(scrub(&w, &secrets));
    }

    // ---- read back ------------------------------------------------------
    match plan.read_back {
        ReadBack::Skip(why) => warnings.push(format!("import not read back: {}", why)),
        ReadBack::Verify | ReadBack::Tolerate => {
            let listed = swap_daemon::daemon_rpc(
                &client,
                &ep,
                "listdescriptors",
                swap_daemon::listdescriptors_params(),
            )
            .await;
            match (listed, plan.read_back) {
                (Ok(v), ReadBack::Verify) => {
                    if !read_back_confirms(&v, &fingerprint) {
                        return Err(format!(
                            "the daemon reported a successful import but does not list our \
                             descriptors afterwards — nothing was adopted. Branches found: {:?}",
                            read_back_branches(&v, &fingerprint)
                        ));
                    }
                }
                (Ok(v), _) => {
                    if !read_back_confirms(&v, &fingerprint) {
                        warnings.push(
                            "listdescriptors did not show both branches after the import; this \
                             daemon's read-back was never probed, so it is not treated as proof \
                             either way"
                                .to_string(),
                        );
                    }
                }
                (Err(e), ReadBack::Verify) => {
                    return Err(format!(
                        "the import reported success but could not be read back: {}",
                        scrub(&e.to_string(), &secrets)
                    ))
                }
                (Err(e), _) => warnings.push(format!(
                    "import not confirmed by read-back (not treated as failure): {}",
                    scrub(&e.to_string(), &secrets)
                )),
            }
        }
    }

    // ---- persist --------------------------------------------------------
    // Best effort by design: the keys are in the wallet whatever happens here,
    // and failing the command would tell the user nothing was imported when
    // something was. A re-run is idempotent on the daemon side.
    let at = chrono::Utc::now().to_rfc3339();
    let mut rec = swap_sidecar::read_optin(&app);
    if rec.coins.is_empty() {
        // Freeze the effective set BEFORE writing an entry: a first entry
        // written into an empty map turns "every coin enabled" (legacy) into
        // "only this coin enabled" and silently disables six chains.
        rec.coins = swap_sidecar::materialize_coin_map(&rec, &at);
    }
    match rec.coins.get_mut(engine_coin) {
        Some(e) => {
            e.adoption = swap_sidecar::Adoption::Descriptor;
            e.descriptors_imported_at = Some(at);
            if let Err(err) = swap_sidecar::write_optin(&app, &rec) {
                warnings.push(format!(
                    "the import succeeded but the opt-in record could not be updated ({}); the \
                     coin will still show as not adopted",
                    err
                ));
            }
        }
        None => warnings.push(
            "the import succeeded but this coin has no opt-in entry to record it against"
                .to_string(),
        ),
    }

    Ok(DescriptorImportReport {
        coin: plan.coin.to_string(),
        wallet_name: walletinfo
            .get("walletname")
            .and_then(|w| w.as_str())
            .unwrap_or(&target.wallet)
            .to_string(),
        imported: entries.iter().map(|e| e.label.clone()).collect(),
        method: plan.method.label().to_string(),
        warnings,
    })
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// The BIP-39 English test vector. World-public; it holds no funds and is
    /// the same phrase `VITE_SKIP_AUTH` uses, so a leak in a fixture cannot
    /// become a leak of anything real.
    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon \
                                 abandon abandon abandon abandon about";

    /// `(master_fingerprint, master_xprv, account_xprv)` for one chain.
    ///
    /// Goes through [`derive_account`] — the same function the command calls —
    /// rather than re-deriving here, so a mutation in the command's derivation
    /// is visible to every test below.
    fn keys(chain: UtxoChain) -> (String, String, String) {
        let seed = derive::mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let d = derive_account(&seed[..], chain, bitcoin::NetworkKind::Main).expect("test vector derives");
        (
            d.fingerprint,
            d.master_xprv.to_string(),
            d.account_xprv.to_string(),
        )
    }

    fn entries_for(chain: UtxoChain) -> Vec<BranchImport> {
        let (fp, _, account) = keys(chain);
        BRANCHES
            .iter()
            .map(|(idx, internal)| BranchImport {
                label: branch_label(chain, *internal),
                desc: format!(
                    "{}#abcdefgh",
                    build_descriptor(&fp, chain, &account, *idx)
                ),
                internal: *internal,
            })
            .collect()
    }

    /// A TCP port with nothing on it: bind, read the port, drop the listener.
    fn absent_socket_port() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    // ---------------------------------------------------------------- R10

    /// §R10 (paired half) — the descriptor carries the **account** key.
    ///
    /// Falsify by building from `master` instead of the account node: the first
    /// two assertions still pass (a master xprv is an xprv, and the suffix is
    /// unchanged), and the third goes red. That is the assertion that matters,
    /// which is why it is not merely "contains an xprv".
    #[test]
    fn descriptor_is_account_xprv_not_master() {
        for chain in [
            UtxoChain::Btc,
            UtxoChain::Ltc,
            UtxoChain::Doge,
            UtxoChain::Dash,
            UtxoChain::Bch,
        ] {
            let (fp, master, account) = keys(chain);
            assert_ne!(master, account, "the account node must not be the master");

            let d = build_descriptor(&fp, chain, &account, 0);
            assert!(d.contains(&account), "{:?}: account xprv missing", chain);
            assert!(
                d.ends_with(&format!("{}/0/*)", account)),
                "{:?}: suffix must be exactly /0/* — got {}",
                chain,
                &d[d.len().saturating_sub(24)..]
            );
            assert!(
                !d.contains(&master),
                "{:?}: the MASTER xprv reached the descriptor",
                chain
            );
            // The origin names the account path, so a reader of the wallet file
            // can see which node this is without re-deriving anything.
            assert!(
                d.contains(&format!("[{}/{}]", fp, origin_path(chain))),
                "{:?}: key origin missing or wrong: {}",
                chain,
                d
            );
        }
    }

    /// The change branch is `/1/*` and nothing else.
    #[test]
    fn change_branch_is_one() {
        let (fp, _, account) = keys(UtxoChain::Btc);
        let d = build_descriptor(&fp, UtxoChain::Btc, &account, 1);
        assert!(d.ends_with("/1/*)"), "{}", d);
    }

    /// Purpose 84 → `wpkh`, purpose 44 → `pkh` (contract §1.5 item 3). A
    /// `pkh` descriptor over a BIP-84 account, or the reverse, imports
    /// addresses the user does not own and shows a zero balance with no error.
    #[test]
    fn descriptor_function_follows_purpose() {
        assert_eq!(descriptor_fn(UtxoChain::Btc), "wpkh");
        assert_eq!(descriptor_fn(UtxoChain::Ltc), "wpkh");
        assert_eq!(descriptor_fn(UtxoChain::Doge), "pkh");
        assert_eq!(descriptor_fn(UtxoChain::Dash), "pkh");
        assert_eq!(descriptor_fn(UtxoChain::Bch), "pkh");

        // And the paths the work order pins, spelled out rather than derived,
        // so a change to `UtxoChain::purpose`/`slip44` shows up here.
        assert_eq!(account_path(UtxoChain::Btc), "m/84'/0'/0'");
        assert_eq!(account_path(UtxoChain::Ltc), "m/84'/2'/0'");
        assert_eq!(account_path(UtxoChain::Doge), "m/44'/3'/0'");
        assert_eq!(account_path(UtxoChain::Dash), "m/44'/5'/0'");
        assert_eq!(account_path(UtxoChain::Bch), "m/44'/145'/0'");
    }

    /// §R10 — no encryption proof, no import.
    ///
    /// Falsify by making [`check_encryption_gate`] return `Ok(())`
    /// unconditionally: all four refusal cases go red at once.
    #[test]
    fn import_refuses_without_wallet_encryption() {
        let unlocked = json!({ "walletname": "wallet.dat", "unlocked_until": 1_900_000_000i64 });

        // 1. No C5 key in this session.
        let e = check_encryption_gate(false, &unlocked).unwrap_err();
        assert!(e.starts_with(ERR_NO_ENCRYPTION), "{}", e);

        // 2. Key set, but the daemon's wallet is not encrypted at all — Core
        //    omits `unlocked_until` entirely for an unencrypted wallet.
        let e = check_encryption_gate(true, &json!({ "walletname": "wallet.dat" })).unwrap_err();
        assert!(e.starts_with(ERR_NO_ENCRYPTION), "{}", e);
        assert!(e.contains("unencrypted"), "{}", e);

        // 3. Encrypted but locked.
        let e = check_encryption_gate(true, &json!({ "unlocked_until": 0 })).unwrap_err();
        assert!(e.starts_with(ERR_NO_ENCRYPTION), "{}", e);
        assert!(e.contains("locked"), "{}", e);

        // 4. Unreadable value fails closed rather than being treated as proof.
        assert!(check_encryption_gate(true, &json!({ "unlocked_until": "soon" })).is_err());

        // The one accepting case, so the test cannot pass by refusing always.
        assert!(check_encryption_gate(true, &unlocked).is_ok());
    }

    // ---------------------------------------------------------------- R12

    /// §R12 — a post-sync import reports success and finds nothing, so it is
    /// refused, and the refusal has to hand the user both ways out.
    ///
    /// Falsify by dropping the guard (`Ok(())` unconditionally) → red.
    #[test]
    fn import_refuses_after_first_sync() {
        assert!(check_first_sync_gate(false, "bitcoin").is_ok());

        let e = check_first_sync_gate(true, "bitcoin").unwrap_err();
        assert!(e.contains("bitcoin"), "{}", e);
        // Both remedies, by name. A refusal that only says "too late" pushes
        // the user toward the one action that always works and always costs
        // them a fee and their privacy.
        assert!(e.contains("wipe"), "wipe-and-resync remedy missing: {}", e);
        assert!(e.contains("resync"), "wipe-and-resync remedy missing: {}", e);
        assert!(
            e.contains("consolidation"),
            "consolidation remedy missing: {}",
            e
        );
        // And the reason, so it does not read as an arbitrary rule.
        assert!(e.contains("pruned"), "{}", e);
    }

    // ---------------------------------------------------------------- R11

    /// §R11 — imported descriptors never become the wallet's active set, and
    /// the change branch is marked internal.
    ///
    /// Falsify by writing `json!(true)` for `active` → red on the first
    /// assertion; falsify by dropping the `internal` insert → red on the last.
    /// A derived `Debug` on `BranchImport` would print the account xprv into
    /// any `{:?}` — a log, a panic, an error chain. Nothing formats it today;
    /// this keeps it that way.
    #[test]
    fn branch_import_debug_redacts_the_descriptor() {
        let b = BranchImport {
            label: "pwnda-btc-receive".to_string(),
            desc: "wpkh([f0f0f0f0/84h/0h/0h]xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb/0/*)#checksum".to_string(),
            internal: false,
        };
        let shown = format!("{:?}", b);
        assert!(!shown.contains("xprv"), "the xprv leaked into Debug: {shown}");
        assert!(!shown.contains("wpkh"), "the descriptor leaked into Debug: {shown}");
        // Still useful for diagnostics.
        assert!(shown.contains("pwnda-btc-receive"), "label should survive: {shown}");
        assert!(shown.contains("redacted"), "must say it redacted: {shown}");
    }

    #[test]
    fn descriptors_are_inactive() {
        let entries = entries_for(UtxoChain::Btc);
        let params = importdescriptors_params(&entries, 0, 999);

        let reqs = params[0].as_array().expect("one positional array argument");
        assert_eq!(reqs.len(), 2, "both branches or the change is unspendable");

        for r in reqs {
            assert_eq!(
                r.get("active"),
                Some(&json!(false)),
                "an active descriptor hijacks the engine's own address chain: {}",
                r
            );
            assert_eq!(r.get("range"), Some(&json!([0, 999])), "{}", r);
            assert_eq!(r.get("timestamp"), Some(&json!(0)), "{}", r);
        }

        assert!(reqs[0].get("internal").is_none(), "receive branch: {}", reqs[0]);
        assert_eq!(
            reqs[1].get("internal"),
            Some(&json!(true)),
            "change branch must be internal: {}",
            reqs[1]
        );
    }

    /// `timestamp` is the birthday, never the string `"now"`.
    #[test]
    fn timestamp_is_never_now() {
        let entries = entries_for(UtxoChain::Btc);
        for p in [
            importdescriptors_params(&entries, 1_600_000_000, 10),
            importmulti_params(&entries, 1_600_000_000, 10),
        ] {
            let reqs = p[0].as_array().unwrap();
            for r in reqs {
                assert_eq!(r.get("timestamp"), Some(&json!(1_600_000_000u64)), "{}", r);
                assert!(!p.to_string().contains("\"now\""), "{}", p);
            }
        }
    }

    /// BCH's route. `rescan` is explicit because `rescan: false` reaches §R12's
    /// silent-zero-balance outcome by a second road, and `watchonly` must stay
    /// absent — `watchonly: true` next to private keys is a Core error, and a
    /// watch-only import is unspendable by the engine.
    #[test]
    fn importmulti_rescans_and_stays_spendable() {
        let entries = entries_for(UtxoChain::Bch);
        let params = importmulti_params(&entries, 0, 999);

        assert_eq!(params[1], json!({ "rescan": true }), "{}", params);

        let reqs = params[0].as_array().unwrap();
        assert_eq!(reqs.len(), 2);
        for r in reqs {
            assert_eq!(r.get("range"), Some(&json!([0, 999])), "{}", r);
            assert!(r.get("watchonly").is_none(), "{}", r);
            assert!(r.get("keypool").is_none(), "{}", r);
            assert!(r.get("label").is_none(), "a label on an internal entry is a Core error: {}", r);
        }
        assert!(reqs[0].get("internal").is_none(), "{}", reqs[0]);
        assert_eq!(reqs[1].get("internal"), Some(&json!(true)), "{}", reqs[1]);
    }

    // ---------------------------------------------------------------- R16

    /// §R16 — the report reaches the webview, so it must carry no key material.
    ///
    /// The realistic leak path is not the labels (which are constants) but the
    /// **warnings**, which carry daemon text verbatim. So the fixture builds a
    /// warning the way the command does — from a daemon error that echoed the
    /// descriptor back — and asserts the scrub held.
    ///
    /// Falsify by pushing the raw daemon text instead of `scrub(...)` → red.
    /// Falsify by putting `e.desc` into `imported` → red.
    ///
    /// Note the contract's literal "contains neither `xprv` nor `desc`" cannot
    /// hold as written: `method` is `"importdescriptors"`, which contains
    /// `desc`. The substantive assertions — no xprv, no descriptor string, no
    /// descriptor function call — are made instead.
    #[test]
    fn import_report_leaks_no_key_material() {
        let (fp, master, account) = keys(UtxoChain::Btc);
        let desc = build_descriptor(&fp, UtxoChain::Btc, &account, 0);
        let secrets: Vec<&str> = vec![account.as_str(), master.as_str(), desc.as_str()];

        let daemon_said = format!("Error: Invalid descriptor \"{}\": checksum missing", desc);
        let report = DescriptorImportReport {
            coin: "btc".to_string(),
            wallet_name: "wallet.dat".to_string(),
            imported: BRANCHES
                .iter()
                .map(|(_, i)| branch_label(UtxoChain::Btc, *i))
                .collect(),
            method: ImportMethod::Descriptors.label().to_string(),
            warnings: vec![scrub(&daemon_said, &secrets)],
        };

        let wire = serde_json::to_string(&report).unwrap();
        assert!(!wire.contains("xprv"), "serialized report carries an xprv: {}", wire);
        assert!(!wire.contains(&account), "account xprv in the report");
        assert!(!wire.contains(&master), "master xprv in the report");
        assert!(!wire.contains(&desc), "descriptor string in the report");
        assert!(!wire.contains("wpkh("), "descriptor function call in the report: {}", wire);
        assert!(!wire.contains("pkh("), "descriptor function call in the report: {}", wire);

        // Labels are label-shaped, not descriptor-shaped.
        for l in &report.imported {
            assert!(
                l == "bip84-external" || l == "bip84-internal",
                "unexpected label {:?}",
                l
            );
        }
        // camelCase on the wire (contract §0.1, Rust-owned struct).
        assert!(wire.contains("\"walletName\""), "{}", wire);
    }

    /// The scrub itself, and the reason it exists rather than leaning on
    /// `redact_secrets`.
    #[test]
    fn scrub_removes_the_descriptor_and_the_keys() {
        let (fp, master, account) = keys(UtxoChain::Btc);
        let desc = build_descriptor(&fp, UtxoChain::Btc, &account, 0);
        let secrets: Vec<&str> = vec![account.as_str(), master.as_str(), desc.as_str()];

        let text = format!("bad descriptor {} (key {})", desc, account);
        let out = scrub(&text, &secrets);
        assert!(!out.contains(&desc), "{}", out);
        assert!(!out.contains(&account), "{}", out);
        assert!(!out.contains("xprv"), "{}", out);
        // The diagnostic survives — a scrub that ate the message would be a
        // different bug, and one this test would otherwise not notice.
        assert!(out.contains("bad descriptor"), "{}", out);
    }

    /// **The measured fact `scrub` exists for.** `redact_secrets` alone does
    /// not see an xprv inside a descriptor: its token rule requires the whole
    /// token to be alphanumeric after trimming, and the slashes in
    /// `[fp/84h/0h/0h]xprv…/0/*` mean it never is.
    ///
    /// If this assertion ever fails because `redact_secrets` got better,
    /// **delete this test** — do not weaken `scrub` to make it pass again.
    #[test]
    fn redact_secrets_alone_does_not_see_a_descriptor_embedded_xprv() {
        let (fp, _, account) = keys(UtxoChain::Btc);
        let desc = build_descriptor(&fp, UtxoChain::Btc, &account, 0);
        let only_redacted = swap_sidecar::redact_secrets(&format!("Error: {}", desc));
        assert!(
            only_redacted.contains(&account),
            "redact_secrets now covers descriptor-embedded xprvs — delete this test rather than \
             weakening scrub"
        );
    }

    // ------------------------------------------------- checksum / read-back

    /// `getdescriptorinfo` answers with **two** descriptor-shaped fields, and
    /// only one of them is right. `descriptor` is the canonical form with
    /// private keys *removed* — importing it yields watch-only UTXOs the engine
    /// cannot spend, with no error anywhere (contract §4.3 item 11).
    ///
    /// Falsify by composing from `reply["descriptor"]` → red, and the failure
    /// message is the whole point: the public form no longer carries the xprv.
    #[test]
    fn checksum_is_appended_to_our_descriptor_not_the_daemons() {
        let (fp, _, account) = keys(UtxoChain::Btc);
        let ours = build_descriptor(&fp, UtxoChain::Btc, &account, 0);
        // What Core actually answers: the same descriptor with the xprv
        // swapped for its xpub.
        let public_form = "wpkh([73c5da0a/84h/0h/0h]xpub6BosfCnifzxcJJ1wYuntGJfF2zPJkDeG9ELNHcK\
                           NjezuEa1FfKY2GAG9Q9k9WWjKtVGpCsvvY4NNTdxKt6HuLmZmp3Q9YMKCFhb1YWBt/0/*)";
        let reply = json!({
            "descriptor": format!("{}#pubcksum", public_form),
            "checksum": "kkl5qsmr",
            "isrange": true,
            "issolvable": true,
            "hasprivatekeys": true,
        });

        let out = compose_checksummed(&ours, &reply).unwrap();
        assert_eq!(out, format!("{}#kkl5qsmr", ours));
        assert!(
            out.contains(&account),
            "the composed descriptor lost its private key — this import would be watch-only"
        );
        assert!(!out.contains("xpub"), "{}", out);

        // No checksum field at all is a refusal, not a checksum-less import:
        // Core rejects an unchecksummed descriptor anyway, and guessing here
        // would turn a clear failure into an obscure one.
        assert!(compose_checksummed(&ours, &json!({ "isrange": true })).is_err());
    }

    /// The read-back finds our branches by master fingerprint, because the
    /// reply carries the public form and cannot be matched on the xprv.
    #[test]
    fn read_back_recognises_both_branches_by_fingerprint() {
        let listed = json!({
            "wallet_name": "wallet.dat",
            "descriptors": [
                // The engine's own — different fingerprint, must be ignored.
                { "desc": "wpkh([ffffffff/84h/1h/0h]xpub6EngineKey/0/*)#aaaaaaaa", "active": true },
                { "desc": "wpkh([73c5da0a/84h/0h/0h]xpub6Ours/0/*)#bbbbbbbb", "active": false },
                { "desc": "wpkh([73c5da0a/84h/0h/0h]xpub6Ours/1/*)#cccccccc", "active": false },
            ]
        });
        assert_eq!(read_back_branches(&listed, "73c5da0a"), vec![0, 1]);
        assert!(read_back_confirms(&listed, "73c5da0a"));
        // Case-insensitive, because forks differ on fingerprint casing.
        assert!(read_back_confirms(&listed, "73C5DA0A"));
        // Somebody else's key is not our import.
        assert!(!read_back_confirms(&listed, "deadbeef"));
    }

    /// One branch is not an import. Change that lands on an unimported branch
    /// is unspendable, and the user reads that as "the balance is wrong".
    #[test]
    fn read_back_rejects_a_one_branch_import() {
        let listed = json!({
            "descriptors": [
                { "desc": "wpkh([73c5da0a/84h/0h/0h]xpub6Ours/0/*)#bbbbbbbb" },
            ]
        });
        assert_eq!(read_back_branches(&listed, "73c5da0a"), vec![0]);
        assert!(!read_back_confirms(&listed, "73c5da0a"));
    }

    /// LTC's whole reason for existing in this module. `Skip` carries the
    /// reason, so the warning the user sees explains itself.
    #[test]
    fn litecoin_skips_the_read_back() {
        let ltc = plan_for("litecoin").expect("litecoin has a plan");
        match ltc.read_back {
            ReadBack::Skip(why) => assert!(why.contains("listdescriptors"), "{}", why),
            other => panic!("LTC must SKIP the read-back, not {:?}", other),
        }
        // BTC is the only probed-present row.
        assert_eq!(plan_for("bitcoin").unwrap().read_back, ReadBack::Verify);
        // Unprobed rows tolerate rather than verify or skip.
        assert_eq!(plan_for("dogecoin").unwrap().read_back, ReadBack::Tolerate);
        assert_eq!(plan_for("dash").unwrap().read_back, ReadBack::Tolerate);
        assert_eq!(plan_for("bitcoincash").unwrap().read_back, ReadBack::Tolerate);
    }

    /// BCH has no `importdescriptors`; everything else does.
    #[test]
    fn per_coin_method_matches_the_measured_matrix() {
        assert_eq!(plan_for("bitcoincash").unwrap().method, ImportMethod::Multi);
        for c in ["bitcoin", "litecoin", "dogecoin", "dash"] {
            assert_eq!(
                plan_for(c).unwrap().method,
                ImportMethod::Descriptors,
                "{}",
                c
            );
        }
        // Not every coin the node runs is adoptable. Particl's wallet is the
        // engine's own (C1), and Monero is not a descriptor chain.
        assert!(plan_for("particl").is_none());
        assert!(plan_for("monero").is_none());
        assert!(plan_for("").is_none());
        assert!(plan_for("BITCOIN").is_none(), "plan_for takes the normalised engine name");
    }

    /// The report's coin spelling is the frontend's key, not the engine's.
    #[test]
    fn plan_coin_is_the_frontend_spelling() {
        assert_eq!(plan_for("bitcoincash").unwrap().coin, "bch");
        assert_eq!(plan_for("dogecoin").unwrap().coin, "doge");
        // And `coin_key_from` is what turns either spelling into the engine
        // name this module keys on.
        assert_eq!(swap_sidecar::coin_key_from("bch"), Some("bitcoincash"));
        assert_eq!(swap_sidecar::coin_key_from("btc"), Some("bitcoin"));
    }

    /// Grove expansion plan, Phase C, unit C-RB — the "no-op for lean"
    /// half of this unit's OWNS. BCH light mode (Phase B's patch 0018)
    /// adds a case this module had never been exercised against: a
    /// `bitcoincash` chainclient with `connection_type: "electrum"` (no
    /// local daemon at all — a public Electrum/Fulcrum server instead).
    ///
    /// C3.5 (this module) only ever adopts a coin by talking to ITS OWN
    /// daemon via [`swap_daemon::resolve_send_target`], called from
    /// `swap_sidecar_import_descriptors` BEFORE any key is derived (see
    /// that command's own "derive" comment block) — so the refusal below,
    /// if it fires, is a genuine no-op: no descriptor is built, no account
    /// xprv is ever computed, and the coin's opt-in record is untouched.
    /// Confirmed here for BCH SPECIFICALLY, not by analogy to LTC's
    /// existing electrum coverage
    /// (`swap_daemon::tests::an_electrum_chainclient_is_refused_by_name`) —
    /// the mechanism is coin-agnostic (`parse_chain_daemon_targets` keys
    /// only on `connection_type`, never on the coin name), but this unit's
    /// job is to confirm that for its own coin rather than assume it from
    /// a different one's test.
    ///
    /// A lean/electrum BCH shares via C8 (`push_account_key`,
    /// `swap_sidecar.rs`) instead — this module's job here is only to stay
    /// out of the way rather than hang, corrupt state, or half-import.
    #[test]
    fn bch_lean_electrum_mode_is_a_clean_no_op_for_descriptor_import() {
        let cfg = r#"{"chainclients":{"bitcoincash":{"connection_type":"electrum"}}}"#;
        let err = swap_daemon::resolve_send_target(cfg, "bitcoincash").unwrap_err();
        assert!(
            err.contains("no daemon to send through"),
            "a lean/electrum BCH must be refused as having no daemon, not \
             silently routed anywhere: {}",
            err
        );

        // The refusal is about MODE, not about BCH being unknown to C3.5 —
        // a FULL-mode BCH (its own local bitcoincashd) must still adopt
        // exactly as it always has. Guards against a fix for the electrum
        // case that accidentally makes `plan_for` refuse BCH altogether.
        assert!(
            plan_for("bitcoincash").is_some(),
            "BCH's C3.5 plan must survive electrum-mode support existing at all"
        );

        // And the negative control this file's own house style expects:
        // a FULL-mode (`connection_type: "rpc"`) BCH chainclient must NOT
        // hit the same refusal — proving the assertion above is actually
        // exercising the electrum branch, not a permanently-broken lookup.
        let full_cfg = r#"{"chainclients":{"bitcoincash":{"connection_type":"rpc",
            "manage_daemon":true,"rpchost":"127.0.0.1","rpcport":19797}}}"#;
        let target = swap_daemon::resolve_send_target(full_cfg, "bitcoincash")
            .expect("a FULL-mode BCH chainclient must resolve to a daemon");
        assert_eq!(target.port, 19797);
    }

    // ------------------------------------------------------ option validation

    #[test]
    fn range_end_defaults_and_has_a_ceiling() {
        assert_eq!(check_range_end(None).unwrap(), DEFAULT_RANGE_END);
        assert_eq!(check_range_end(Some(0)).unwrap(), 0);
        assert_eq!(check_range_end(Some(MAX_RANGE_END)).unwrap(), MAX_RANGE_END);
        let e = check_range_end(Some(MAX_RANGE_END + 1)).unwrap_err();
        assert!(e.contains("50000"), "{}", e);
    }

    #[test]
    fn a_future_birthday_is_refused() {
        let now = 1_700_000_000i64;
        assert_eq!(check_birthday(None, now).unwrap(), 0);
        assert_eq!(check_birthday(Some(1_600_000_000), now).unwrap(), 1_600_000_000);
        assert_eq!(check_birthday(Some(now as u64), now).unwrap(), now as u64);
        let e = check_birthday(Some(now as u64 + 1), now).unwrap_err();
        assert!(e.contains("future"), "{}", e);
    }

    // ------------------------------------------------------- wallet targeting

    /// Contract §4.3 item 11 — the watch wallet is not the spending wallet.
    #[test]
    fn a_different_wallet_is_a_refusal_not_a_warning() {
        assert_eq!(
            check_wallet_target("wallet.dat", &json!({ "walletname": "wallet.dat" }), true)
                .unwrap(),
            None
        );
        let e =
            check_wallet_target("wallet.dat", &json!({ "walletname": "watch" }), true).unwrap_err();
        assert!(e.contains("watch"), "{}", e);
        assert!(e.contains("wallet.dat"), "{}", e);

        // A daemon that does not name its wallet cannot be checked, and that is
        // said out loud rather than assumed away.
        let w = check_wallet_target("wallet.dat", &json!({}), true).unwrap();
        assert!(w.unwrap().contains("did not name the wallet"));
    }

    /// The other half: on a fork with no multiwallet routing there is only one
    /// wallet, so a name mismatch is not evidence of the wrong one. Refusing
    /// there would block every DOGE import.
    ///
    /// Falsify by deleting the `routed_by_name` branch — this goes red while the
    /// test above stays green, which is what separates the two cases rather than
    /// collapsing them.
    #[test]
    fn a_single_wallet_daemon_warns_instead_of_refusing() {
        let w = check_wallet_target("wallet.dat", &json!({ "walletname": "" }), false)
            .expect("a single-wallet daemon must not be a refusal");
        assert!(w.unwrap().contains("no multiwallet routing"));

        // The same daemon, asked by name, still refuses.
        assert!(check_wallet_target("wallet.dat", &json!({ "walletname": "" }), true).is_err());
    }

    /// `routed_by_name` is derived from the URL builder, not sniffed out of the
    /// string. Pinned so a change to `wallet_url`'s shape cannot silently flip
    /// the branch above.
    #[test]
    fn routed_by_name_matches_the_url_builder() {
        let named = swap_daemon::wallet_url("127.0.0.1", 8332, "wallet.dat");
        let bare = swap_daemon::wallet_url("127.0.0.1", 8332, "");
        assert_ne!(named, bare);
        assert!(named.ends_with("/wallet/wallet.dat"), "{}", named);
        assert!(bare.ends_with(":8332/"), "{}", bare);
    }

    // -------------------------------------------------------- import results

    #[test]
    fn a_single_rejected_descriptor_fails_the_whole_import() {
        let ok = json!([{ "success": true }, { "success": true }]);
        assert_eq!(parse_import_results(&ok, 2).unwrap(), Vec::<String>::new());

        let partial = json!([
            { "success": true },
            { "success": false, "error": { "code": -5, "message": "Missing checksum" } }
        ]);
        let e = parse_import_results(&partial, 2).unwrap_err();
        assert!(e.contains("Missing checksum"), "{}", e);
        assert!(e.contains("descriptor 1"), "{}", e);

        // Warnings are carried, not swallowed.
        let warned = json!([
            { "success": true, "warnings": ["Not all private keys provided"] },
            { "success": true }
        ]);
        assert_eq!(
            parse_import_results(&warned, 2).unwrap(),
            vec!["Not all private keys provided".to_string()]
        );

        // A short reply is a failure: two descriptors sent, one answered means
        // one branch is unaccounted for.
        assert!(parse_import_results(&json!([{ "success": true }]), 2).is_err());
        assert!(parse_import_results(&json!({ "success": true }), 1).is_err());
        // Missing `success` is not success.
        assert!(parse_import_results(&json!([{}]), 1).is_err());
    }

    // -------------------------------------------------------- the allow-list

    /// The two lists never overlap: daemon-direct routing (which signs and
    /// broadcasts) can never import a key, and adoption (which imports keys)
    /// can never sign or broadcast.
    ///
    /// Falsify by adding `"importdescriptors"` to `DAEMON_METHODS` → red here,
    /// and red in `allow_list_excludes_every_key_and_unlock_method` too.
    #[test]
    fn descriptor_methods_are_disjoint_from_routing() {
        for m in DESCRIPTOR_METHODS {
            assert!(
                !swap_daemon::DAEMON_METHODS.contains(m),
                "{} is reachable from BOTH allow-lists",
                m
            );
        }
        // And nothing that moves funds is on ours.
        for m in ["sendrawtransaction", "signrawtransactionwithwallet", "fundrawtransaction"] {
            assert!(!DESCRIPTOR_METHODS.contains(&m), "{} must not be adoptable", m);
        }
        let mut sorted = DESCRIPTOR_METHODS.to_vec();
        sorted.sort_unstable();
        assert_eq!(DESCRIPTOR_METHODS, sorted.as_slice());
    }

    /// The guard runs before the socket. Asserted against a port nothing is
    /// listening on, so removing the guard changes the error **kind** rather
    /// than merely its text.
    #[tokio::test]
    async fn descriptor_rpc_rejects_a_routing_method() {
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", absent_socket_port()),
            auth: None,
        };
        let client = reqwest::Client::builder().build().unwrap();

        let err = descriptor_rpc(&client, &ep, "sendrawtransaction", json!([]))
            .await
            .expect_err("a routing method must not be reachable from C3.5");
        assert!(
            matches!(err, RpcFault::Guard(_)),
            "expected a guard refusal before any socket, got {:?}",
            err
        );

        // The control: a LISTED method against the SAME dead port reaches the
        // network and fails differently. Without this, the assertion above
        // would pass even if the guard were deleted.
        let err = descriptor_rpc(&client, &ep, "getdescriptorinfo", json!([""]))
            .await
            .expect_err("nothing is listening on that port");
        assert!(
            matches!(err, RpcFault::Transport(_)),
            "expected a transport failure, got {:?}",
            err
        );
    }

    /// The reverse direction: routing cannot issue an import even though the
    /// shared HTTP path now takes a list parameter.
    #[tokio::test]
    async fn routing_still_cannot_import_descriptors() {
        let ep = DaemonEndpoint {
            url: format!("http://127.0.0.1:{}/", absent_socket_port()),
            auth: None,
        };
        let client = reqwest::Client::builder().build().unwrap();
        let err = swap_daemon::daemon_rpc(&client, &ep, "importdescriptors", json!([]))
            .await
            .expect_err("routing must not import keys");
        assert!(matches!(err, RpcFault::Guard(_)), "got {:?}", err);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADVERSARIAL REVIEW — R12 is inert on exactly the installs it protects
    //
    // The register calls `first_sync_started` "the ONLY thing between the
    // user and that outcome — not belt-and-braces". On a pre-C3 record it
    // can never become true:
    //
    //  * `coins_on_consent` (swap_sidecar.rs:2643) returns `existing.clone()`
    //    whenever a basicswap.json already exists, so an install that predates
    //    C3 keeps `coins: {}` for ever.
    //  * `enabled_coins` (swap_sidecar.rs:2598) treats an EMPTY map as
    //    "every seedable coin is enabled" — the frozen migration rule — so
    //    bitcoin sails through the enablement check at descriptors.rs:845.
    //  * `mark_first_sync_started` (swap_sidecar.rs:2993) early-returns on
    //    `rec.coins.is_empty()`, so it records nothing, ever.
    //  * the command reads it as
    //    `rec.coins.get(coin).map(..).unwrap_or(false)` (descriptors.rs:855)
    //    — absent entry == "has not synced".
    //
    // Net: the population whose chains are ALREADY fully synced — the only
    // population that can hit R12's failure — is the one population for
    // which the gate cannot fire.
    // ═══════════════════════════════════════════════════════════════════

    /// **R12.** For every coin the import will accept, the first-sync gate
    /// must be *capable* of firing. On a legacy record it is not.
    #[test]
    fn r12_gate_can_fire_for_every_coin_the_import_accepts() {
        use swap_sidecar::{enabled_coins, CoinOptIn, OptInRecord};

        // A pre-C3 opt-in.json: opted in, no `coins` key at all.
        let legacy: OptInRecord = serde_json::from_str(
            r#"{"optedIn":true,"at":"2026-01-01T00:00:00Z","autostart":false}"#,
        )
        .expect("a pre-C3 record must still deserialize");
        assert!(legacy.coins.is_empty(), "fixture: the map must be absent");

        // Positive control: the gate DOES work when an entry exists, so the
        // assertion below cannot be passing because the gate is broken
        // outright.
        let mut modern = legacy.clone();
        modern.coins.insert(
            "bitcoin".into(),
            CoinOptIn { enabled: true, first_sync_started: true, ..CoinOptIn::default() },
        );
        assert!(
            check_first_sync_gate(
                modern.coins.get("bitcoin").map(|e| e.first_sync_started).unwrap_or(false),
                "bitcoin",
            )
            .is_err(),
            "the gate must refuse a coin that HAS started syncing"
        );

        // Now the real question, for every coin the import would accept.
        for coin in enabled_coins(&legacy) {
            if !matches!(coin.as_str(), "bitcoin" | "litecoin" | "dogecoin" | "dash" | "bitcoincash")
            {
                continue; // no descriptor plan; the import refuses earlier
            }
            // Call the REAL decision, not a copy of it. The coin is present
            // in basicswap.json on this fixture, which is what "already
            // syncing" means for a legacy record.
            let started = first_sync_presumed_started(legacy.coins.get(&coin), true);
            assert!(
                started,
                "R12 IS INERT FOR {coin}: the record carries no CoinOptIn entry (a pre-C3                  install), so an absent entry must be read as \"presume synced\" and refuse.                  Reading it as \"not synced\" permits an import that reports success for                  every descriptor while the balance stays at zero."
            );
        }
    }
}

// =========================================================================
// Live regtest integration — the zero-move adoption proof (C3.5 / R6)
// =========================================================================
//
// Everything above this line is unit-tested against fixtures. What no fixture
// can answer is the claim the whole feature rests on: **that importing the
// user's classic derivation into the swap node's wallet makes their existing
// coins spendable by that wallet, without moving them.** Contract §4.3 lists
// that as settleable only by a live node.
//
// This drives the SAME functions the command uses — `plan_for`,
// `derive_account`, `build_descriptor`, `checksummed`,
// `importdescriptors_params` — against a real regtest `bitcoind`, then proves
// the outcome the user cares about:
//
//   1. import the descriptors for a known test mnemonic;
//   2. generate coins to an address that derivation owns, computed
//      INDEPENDENTLY of the wallet (so the test cannot pass by asking the
//      wallet to confirm its own belief);
//   3. assert the wallet now reports a spendable balance;
//   4. assert it can actually build a spend from those coins.
//
// **Double-gated**, matching the `swap_sidecar::itest` convention: `#[ignore]`
// plus its own env flag, so no blanket `cargo test -- --ignored` starts a node.
//
// ```text
//   $env:PWNDA_DESCRIPTOR_ITEST = "1"
//   cargo test --lib descriptors::itest -- --ignored --nocapture
// ```
//
// **regtest only, no funds.** The chain is a private throwaway the test
// creates and deletes. Regtest coins are worthless and unreachable from any
// real network.
#[cfg(test)]
mod itest {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Child, Command};

    /// The standard BIP-39 test vector. Public, worthless, and the same
    /// mnemonic the repo's other fixtures use.
    const TEST_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn enabled() -> bool {
        std::env::var("PWNDA_DESCRIPTOR_ITEST")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    fn work_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri always has a parent")
            .join(".swap-sidecar-work")
    }

    struct Node {
        child: Child,
        datadir: PathBuf,
        ep: DaemonEndpoint,
        cli: PathBuf,
    }

    impl Node {
        /// Every call goes through the daemon's own `bitcoin-cli`, so the test
        /// exercises the daemon rather than a second HTTP implementation.
        fn cli(&self, args: &[&str]) -> String {
            let out = Command::new(&self.cli)
                .arg("-regtest")
                .arg(format!("-datadir={}", self.datadir.display()))
                .arg("-rpcport=39443")
                .arg("-rpcuser=itest")
                .arg("-rpcpassword=itest")
                .args(args)
                .output()
                .unwrap_or_else(|e| panic!("cli {:?} failed to spawn: {e}", args));
            if !out.status.success() {
                panic!(
                    "cli {:?} exited {}: {}{}",
                    args,
                    out.status,
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn wallet_cli(&self, wallet: &str, args: &[&str]) -> String {
            let mut v = vec![format!("-rpcwallet={wallet}")];
            v.extend(args.iter().map(|s| s.to_string()));
            let refs: Vec<&str> = v.iter().map(|s| s.as_str()).collect();
            self.cli(&refs)
        }
    }

    impl Drop for Node {
        fn drop(&mut self) {
            // Graceful stop first — the ladder discipline applies to test
            // fixtures too; a killed bitcoind can leave a corrupt chainstate.
            let _ = Command::new(&self.cli)
                .arg("-regtest")
                .arg(format!("-datadir={}", self.datadir.display()))
                .arg("-rpcport=39443")
                .arg("-rpcuser=itest")
                .arg("-rpcpassword=itest")
                .arg("stop")
                .output();
            for _ in 0..50 {
                if let Ok(Some(_)) = self.child.try_wait() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            let _ = self.child.kill();
            let _ = std::fs::remove_dir_all(&self.datadir);
        }
    }

    fn start_regtest_bitcoind() -> Node {
        let bin = work_dir().join("bin").join("bitcoin");
        let d = bin.join(format!("bitcoind{}", crate::platform::EXE_SUFFIX));
        let cli = bin.join(format!("bitcoin-cli{}", crate::platform::EXE_SUFFIX));
        assert!(d.is_file(), "no seeded bitcoind at {}", d.display());

        let datadir = std::env::temp_dir().join(format!(
            "pwnda-desc-itest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|x| x.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&datadir).unwrap();

        let child = Command::new(&d)
            .arg("-regtest")
            .arg("-server=1")
            .arg("-listen=0")
            .arg("-connect=0")
            .arg("-dnsseed=0")
            .arg(format!("-datadir={}", datadir.display()))
            .arg("-rpcport=39443")
            .arg("-rpcuser=itest")
            .arg("-rpcpassword=itest")
            .arg("-fallbackfee=0.0002")
            .arg("-printtoconsole=0")
            .spawn()
            .expect("spawn bitcoind");

        let node = Node {
            child,
            datadir,
            ep: DaemonEndpoint {
                url: "http://127.0.0.1:39443".to_string(),
                auth: Some(("itest".to_string(), "itest".to_string())),
            },
            cli,
        };

        // Readiness: poll until the RPC answers AND the wallet subsystem is
        // past warmup. `getblockcount` alone succeeds while the wallet is
        // still loading — a distinction that produced a wrong capability
        // matrix earlier in this project.
        let start = std::time::Instant::now();
        loop {
            assert!(
                start.elapsed().as_secs() < 90,
                "bitcoind RPC never became ready"
            );
            let ok = Command::new(&node.cli)
                .arg("-regtest")
                .arg(format!("-datadir={}", node.datadir.display()))
                .arg("-rpcport=39443")
                .arg("-rpcuser=itest")
                .arg("-rpcpassword=itest")
                .arg("getblockchaininfo")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ok {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        node
    }

    /// **THE zero-move adoption proof.**
    ///
    /// Fails loudly rather than silently if the feature's central claim is
    /// wrong: an import that "succeeds" while the wallet still sees nothing is
    /// exactly the R12 failure, and asserting only on the import's own
    /// `success: true` would reproduce it.
    #[tokio::test]
    #[ignore = "spawns a real regtest bitcoind; set PWNDA_DESCRIPTOR_ITEST=1"]
    async fn itest_regtest_descriptor_import_makes_existing_coins_spendable() {
        if !enabled() {
            eprintln!("skipped: set PWNDA_DESCRIPTOR_ITEST=1 to run");
            return;
        }
        let node = start_regtest_bitcoind();
        let client = http_client().expect("http client");

        // A descriptor wallet, which is what the engine creates for BTC.
        node.cli(&["-named", "createwallet", "wallet_name=bsx_wallet", "descriptors=true"]);

        // ---- the production path, verbatim -----------------------------
        let plan = plan_for("bitcoin").expect("bitcoin has a plan");
        let mnemonic = zeroize::Zeroizing::new(TEST_MNEMONIC.to_string());
        let seed = crate::swap::derive::mnemonic_to_seed(&mnemonic, "").expect("seed");
        // regtest: the daemon only accepts TESTNET version bytes, which is the
        // whole point of the network-aware derivation this test first exposed.
        let acct = derive_account(&seed[..], plan.chain, bitcoin::NetworkKind::Test)
            .expect("derive account");

        let plain: Vec<(String, String, bool)> = BRANCHES
            .iter()
            .map(|(idx, internal)| {
                (
                    branch_label(plan.chain, *internal),
                    build_descriptor(&acct.fingerprint, plan.chain, acct.account_xprv.as_str(), *idx),
                    *internal,
                )
            })
            .collect();

        let secrets: Vec<&str> = vec![acct.account_xprv.as_str(), acct.master_xprv.as_str()];
        let mut entries = Vec::new();
        for (label, desc, internal) in &plain {
            entries.push(BranchImport {
                label: label.clone(),
                desc: checksummed(&client, &node.ep, desc, &secrets)
                    .await
                    .expect("getdescriptorinfo checksum"),
                internal: *internal,
            });
        }

        // timestamp 0 = rescan from genesis. Regtest has no history yet, so
        // this is the "import BEFORE first sync" ordering R12 requires.
        let params = importdescriptors_params(&entries, 0, 20);
        let reply = swap_daemon::daemon_rpc_guarded(
            &client,
            &DaemonEndpoint {
                url: format!("{}/wallet/bsx_wallet", node.ep.url),
                auth: node.ep.auth.clone(),
            },
            DESCRIPTOR_METHODS,
            "importdescriptors",
            params,
        )
        .await
        .expect("importdescriptors");

        let arr = reply.as_array().expect("importdescriptors returns an array");
        assert_eq!(arr.len(), 2, "one result per branch: {reply}");
        for r in arr {
            assert_eq!(
                r.get("success").and_then(|s| s.as_bool()),
                Some(true),
                "a branch failed to import: {reply}"
            );
        }

        // ---- the part that actually proves the feature ------------------
        //
        // Derive a receive address INDEPENDENTLY of the wallet, from the same
        // account key, and mine to it. If the import worked, the wallet
        // recognises coins it was never told about; if it did not, the balance
        // stays zero — which is the silent failure this test exists to catch.
        // Derive the receive address WITHOUT asking the wallet whether it owns
        // it. `deriveaddresses` is a pure function of the descriptor string, so
        // it cannot be biased by the import having succeeded or failed — which
        // is the independence this proof needs. (Deriving it in-process would
        // be more independent still, but `utxo_address` emits a mainnet `bc1`
        // HRP and regtest wants `bcrt1`; the network asymmetry this whole test
        // uncovered applies to addresses too.)
        let pub_desc = {
            let info = node.cli(&["getdescriptorinfo", &entries[0].desc]);
            let v: Value = serde_json::from_str(&info).expect("getdescriptorinfo json");
            v["descriptor"]
                .as_str()
                .expect("public descriptor")
                .to_string()
        };
        let derived = node.cli(&["deriveaddresses", &pub_desc, "[0,0]"]);
        let addr = serde_json::from_str::<Value>(&derived)
            .ok()
            .and_then(|v| v.get(0).and_then(|a| a.as_str()).map(str::to_string))
            .expect("deriveaddresses returned an address");
        node.cli(&["generatetoaddress", "101", &addr]);

        // NEGATIVE CONTROL, in-test. A second wallet on the same node, with
        // nothing imported, must see NOTHING from the same blocks. Without
        // this the positive assertion below cannot distinguish "our import
        // worked" from "this wallet would have counted these coins anyway" —
        // and an attempt to falsify the test by mining outside the imported
        // range did NOT turn it red, which is exactly the ambiguity that
        // motivated adding a control rather than trusting the mutation.
        node.cli(&[
            "-named",
            "createwallet",
            "wallet_name=control",
            "descriptors=true",
            "blank=true",
        ]);
        let control = node.wallet_cli("control", &["getbalances"]);
        let cv: Value = serde_json::from_str(&control).expect("control getbalances json");
        let c_total = cv["mine"]["trusted"].as_f64().unwrap_or(0.0)
            + cv["mine"]["immature"].as_f64().unwrap_or(0.0);
        assert_eq!(
            c_total, 0.0,
            "NEGATIVE CONTROL FAILED: a wallet that imported nothing still sees              these coins, so the positive result below proves nothing about the              import.
control getbalances: {control}"
        );

        let balances = node.wallet_cli("bsx_wallet", &["getbalances"]);
        let v: Value = serde_json::from_str(&balances).expect("getbalances json");
        let trusted = v["mine"]["trusted"].as_f64().unwrap_or(0.0);
        let immature = v["mine"]["immature"].as_f64().unwrap_or(0.0);

        assert!(
            trusted + immature > 0.0,
            "ZERO-MOVE ADOPTION IS BROKEN: the descriptors imported with \
             success:true, 101 blocks were mined to {addr} (an address this \
             account derivation owns), and the wallet still reports nothing \
             spendable.\ngetbalances: {balances}"
        );
        assert!(
            trusted > 0.0,
            "coins are recognised but none are mature/spendable yet — \
             getbalances: {balances}"
        );

        // And prove spendability, not just visibility: funding a transaction
        // is what the swap engine will do with these coins.
        let raw = node.wallet_cli(
            "bsx_wallet",
            &["createrawtransaction", "[]", &format!("{{\"{addr}\":1.0}}")],
        );
        let funded = node.wallet_cli("bsx_wallet", &["fundrawtransaction", &raw]);
        assert!(
            funded.contains("\"hex\""),
            "the wallet could not FUND a spend from the imported coins, so they \
             are watch-only rather than spendable: {funded}"
        );

        eprintln!(
            "zero-move adoption verified: trusted={trusted} immature={immature} addr={addr}"
        );
    }
}
