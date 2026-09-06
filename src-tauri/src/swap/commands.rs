//! Tauri command handlers — the IPC surface the webview can invoke.
//!
//! Naming convention: every command in this module is prefixed `swap_*` to
//! distinguish from the project's existing miner / wallet commands.
//!
//! ## Hard rules (per Agent Brief B + May 2026 X-Client-Sig amendment):
//! 1. There is **no command** that exports a mnemonic, seed bytes, or raw
//!    private key. Sign-only.
//! 2. The webview never receives derived secret keys; it only sees public
//!    addresses, signed-tx blobs (safe to broadcast), and tx hashes.
//! 3. The session token from `swap_unlock` is required by every signing
//!    command and is invalidated after [`crate::swap::SESSION_TTL_SECS`]
//!    seconds.
//! 4. The per-install ed25519 X-Client-Sig keypair is stored in the OS
//!    keyring; this module never returns the raw seed to the webview either.
//!    Only the *public* key is exposed via `swap_proxy_get_pubkey`.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use super::auth;
use super::keystore::EncryptedVault;
use super::proxy::ProxyError;
use super::state::SwapState;
use super::{
    broadcast as bcast, btc, derive, evm, keystore, near, nep413, proxy, solana,
    stellar, sui,
};

// ----------------------------------------------------------------------
// proxy URL configuration + auth init
// ----------------------------------------------------------------------

/// Initialize / update the proxy URL and load (or create) the per-install
/// X-Client-Sig keypair. Idempotent: safe to call on every app launch.
///
/// Resolves the app's local data directory via `AppHandle` so the auth
/// sidecar files (`client_sig_pubkey.json`, `proxy-auth-state.json`) can
/// be persisted next to `wallet.dat`.
#[tauri::command]
pub fn swap_set_proxy_url(
    state: State<'_, SwapState>,
    app: AppHandle,
    url: String,
) -> Result<(), String> {
    if url.is_empty() {
        return Err("empty proxy URL".into());
    }
    state.set_proxy_url(url.clone());

    // Resolve and cache the data dir.
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("resolve app_local_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    state.set_data_dir(dir.clone());

    // Load (or create) the signing seed, cache the pubkey, and persist the
    // pubkey file. The seed itself never leaves Rust.
    if state.pubkey_b64().is_none() {
        let seed = auth::load_or_create_seed().map_err(|e| e.to_string())?;
        let pubkey = auth::pubkey_b64(&seed);
        state.set_seed(seed, pubkey.clone());
        // Best-effort: a pubkey file write failure should not block startup.
        let _ = auth::write_pubkey_file(&dir, &pubkey);
    }

    // Restore enrolled-at + clock offset from disk FOR THIS SERVER. The
    // state file is keyed by origin (2026-08-12), so pointing the wallet at
    // a different server starts that server's auth state fresh instead of
    // carrying another server's enrollment badge or clock offset.
    let persisted = auth::read_state(&dir, &url);
    state.set_enrolled_at(persisted.enrolled_at);
    state.set_clock_offset_secs(persisted.clock_offset_secs);

    Ok(())
}

// ----------------------------------------------------------------------
// proxy auth surface
// ----------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub url: Option<String>,
    pub pubkey: Option<String>,
    pub enrolled: bool,
    pub enrolled_at: Option<String>,
    pub clock_offset_secs: i64,
}

#[tauri::command]
pub fn swap_proxy_get_status(state: State<'_, SwapState>) -> ProxyStatus {
    let enrolled_at = state.enrolled_at();
    ProxyStatus {
        url: state.proxy_url(),
        pubkey: state.pubkey_b64(),
        enrolled: enrolled_at.is_some(),
        enrolled_at,
        clock_offset_secs: state.clock_offset_secs(),
    }
}

#[tauri::command]
pub fn swap_proxy_get_pubkey(state: State<'_, SwapState>) -> Result<String, String> {
    state.pubkey_b64().ok_or_else(|| {
        "auth keypair not initialized — call swap_set_proxy_url first".to_string()
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResult {
    pub enrolled: bool,
    pub already: bool,
    pub status: u16,
    /// Trimmed body, ≤ 240 chars, useful for the UI toast.
    pub body: String,
}

/// Auto-allowlist this client on the wallet-proxy. Returns success on
/// 200 (`{enrolled:true}` or `{enrolled:true, already:true}`) and on any
/// already-enrolled signal. ENROLL_RATE_LIMIT is mapped to a non-fatal
/// `enrolled:false` so the UI shows the toast and we silently retry next
/// launch.
#[tauri::command]
pub async fn swap_proxy_enroll(state: State<'_, SwapState>) -> Result<EnrollResult, String> {
    let base = state.proxy_url().ok_or_else(|| "proxy URL not set".to_string())?;
    let pubkey = state
        .pubkey_b64()
        .ok_or_else(|| "auth keypair not initialized".to_string())?;
    let (status, body) = proxy::enroll(&base, &pubkey).await.map_err(|e| e.to_string())?;
    let trimmed = trim_body_to_240_chars_with_ellipsis(&body);

    if status >= 200 && status < 300 {
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let enrolled_flag = v
            .get("enrolled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let already_flag = v
            .get("already")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if enrolled_flag {
            let now = Utc::now().to_rfc3339();
            state.set_enrolled_at(Some(now.clone()));
            if let Some(dir) = state.data_dir() {
                let mut s = auth::read_state(&dir, &base);
                s.enrolled_at = Some(now);
                let _ = auth::write_state(&dir, &base, &s);
            }
            return Ok(EnrollResult {
                enrolled: true,
                already: already_flag,
                status,
                body: trimmed,
            });
        }
    }

    // Non-success response. Surface it but don't promote a transient 429 to
    // a fatal error from the UI's perspective.
    Ok(EnrollResult {
        enrolled: false,
        already: false,
        status,
        body: trimmed,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub healthz: ConnectionRow,
    pub tokens: ConnectionRow,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRow {
    pub status: u16,
    pub body: String,
    pub error: Option<String>,
}

/// Proxy health check — hits `/healthz` (unsigned) and
/// `/api/intents/tokens` (read-only catalog) and reports the status
/// + body of each. Suitable for Settings → "Test Connection" and for
/// debug-from-DevTools verification that the proxy is reachable.
///
/// Body truncation: when `full` is false / omitted (default), each
/// response body is truncated to 240 characters with a literal `…`
/// ellipsis so the UI gets a readable connection-test sample. When
/// `full` is true, the entire bodies are returned untruncated —
/// useful for catalog inspection from the DevTools console (e.g.
/// `JSON.parse(r.tokens.body)` to enumerate intents asset ids).
///
/// Pre-2026-05-26 this was named `swap_proxy_test_connection` AND
/// hard-truncated. That trapped one canary debug session into trying
/// to parse a sample as the full catalog (the literal `…` made
/// JSON.parse fail in a confusing way). The deprecated alias below
/// keeps the old name working for any consumer that already imports
/// it; new code should use this command.
#[tauri::command]
pub async fn swap_proxy_health_check(
    state: State<'_, SwapState>,
    full: Option<bool>,
) -> Result<ConnectionTest, String> {
    let full = full.unwrap_or(false);
    let trim = |b: &str| -> String {
        if full {
            b.to_string()
        } else {
            trim_body_to_240_chars_with_ellipsis(b)
        }
    };
    let base = state.proxy_url().ok_or_else(|| "proxy URL not set".to_string())?;
    let healthz = match proxy::healthz(&base).await {
        Ok((s, b)) => ConnectionRow {
            status: s,
            body: trim(&b),
            error: None,
        },
        Err(e) => ConnectionRow {
            status: 0,
            body: String::new(),
            error: Some(e.to_string()),
        },
    };
    let tokens = match proxy::intents_tokens(&state).await {
        Ok((s, b)) => ConnectionRow {
            status: s,
            body: trim(&b),
            error: None,
        },
        Err(e) => ConnectionRow {
            status: 0,
            body: String::new(),
            error: Some(e.to_string()),
        },
    };
    Ok(ConnectionTest { healthz, tokens })
}

/// Deprecated back-compat alias for `swap_proxy_health_check`.
/// Renamed 2026-05-26 because the original name implied a binary
/// "did connection work" check but the return shape is a sampled
/// connection-test envelope. Kept for one release cycle so any
/// caller already importing the old name keeps working; remove
/// after 2026-09 once consumers have migrated.
#[tauri::command]
pub async fn swap_proxy_test_connection(
    state: State<'_, SwapState>,
) -> Result<ConnectionTest, String> {
    swap_proxy_health_check(state, None).await
}

/// Truncate a response body to 240 characters with a literal `…`
/// ellipsis suffix when over the limit. Pre-2026-05-26 this was
/// named `trim_body_for_ui` — the name didn't imply truncation, so
/// callers reasonably assumed it was lossless. Renamed so a `grep`
/// for the function makes the behavior obvious.
fn trim_body_to_240_chars_with_ellipsis(s: &str) -> String {
    let max = 240usize;
    if s.len() <= max {
        s.to_string()
    } else {
        // Walk to the largest char boundary at or below `max` so we
        // never split a multi-byte UTF-8 sequence (which would panic
        // on `&s[..max]` if max landed mid-codepoint).
        let mut split_at = max;
        while !s.is_char_boundary(split_at) && split_at > 0 {
            split_at -= 1;
        }
        let mut out = s[..split_at].to_string();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_body_short_passes_through() {
        let s = "small body";
        assert_eq!(trim_body_to_240_chars_with_ellipsis(s), s);
    }

    #[test]
    fn trim_body_long_truncates_to_240_plus_ellipsis() {
        let s = "x".repeat(500);
        let out = trim_body_to_240_chars_with_ellipsis(&s);
        // 240 ASCII chars + one '…' char (3 UTF-8 bytes).
        assert_eq!(out.chars().count(), 241);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn trim_body_full_mode_returns_untruncated_for_health_check() {
        // The `full: true` branch is exercised through the public
        // command — this test pins the contract that
        // `trim_body_to_240_chars_with_ellipsis` is the ONLY thing
        // that ever truncates, so the command's `full` branch (which
        // skips this call entirely) returns the body untouched.
        // Sanity check the helper doesn't fire for "exactly 240"
        // either — boundary case.
        let s = "y".repeat(240);
        assert_eq!(trim_body_to_240_chars_with_ellipsis(&s).len(), 240);
        assert!(!trim_body_to_240_chars_with_ellipsis(&s).ends_with('…'));
    }
}

// ----------------------------------------------------------------------
// unlock / lock
// ----------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResp {
    pub session_id: String,
    pub expires_at: String, // ISO8601
}

/// The store file and key the wallet's encrypted vault lives under, mirroring
/// `src/store.ts` (`load("wallet.dat")`, `WALLET_KEY = "wallet"`).
const VAULT_STORE_FILE: &str = "wallet.dat";
const VAULT_STORE_KEY: &str = "wallet";

/// Refuse a vault blob that is not the one this installation has on disk.
///
/// # The hole this closes (found by adversarial review, 2026-08-19)
///
/// `swap_unlock` takes **both** the encrypted vault and the password from the
/// renderer and decrypts whatever it is handed. Nothing compared that blob to
/// the vault the app actually stores, so a compromised renderer could forge a
/// vault around *its own* mnemonic under *its own* password, unlock it, and
/// hold a perfectly valid session keyed to an attacker-controlled seed —
/// without ever knowing the user's password.
///
/// That was survivable while sessions only signed transactions the caller
/// already controlled. It stopped being survivable when `swap_bridge` began
/// deriving a **sweep destination** from the session: every downstream guard
/// (the single-use token, the confirm phrase, the reserved-balance gate) still
/// passed, because each one's input had just been handed to the attacker. The
/// review demonstrated the full chain end-to-end — the engine was asked to
/// withdraw the user's balance to an attacker address.
///
/// The fix is to remove the caller's ability to choose the vault at all. The
/// password must still come from the renderer (there is nowhere else it could
/// come from), but the *ciphertext* now has to byte-match what is on disk, so
/// an attacker needs the real password to obtain any session — which is the
/// property the whole session model already assumed it had.
///
/// **Fails closed.** If the store cannot be read, or holds no vault, no session
/// is issued. A first run has nothing to sweep, so refusing costs nothing;
/// silently allowing would restore the hole for exactly the case where the
/// on-disk state is unreadable.
fn assert_vault_matches_disk(app: &AppHandle, supplied: &EncryptedVault) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;

    let store = app
        .store(VAULT_STORE_FILE)
        .map_err(|e| format!("the wallet store could not be opened: {}", e))?;
    let Some(raw) = store.get(VAULT_STORE_KEY) else {
        return Err(
            "this installation has no wallet vault, so no swap session can be opened".to_string(),
        );
    };
    let on_disk: EncryptedVault = serde_json::from_value(raw)
        .map_err(|e| format!("the stored wallet vault could not be read: {}", e))?;

    if vaults_match(&on_disk, supplied) {
        return Ok(());
    }
    Err(
        "the supplied vault is not this installation's wallet — refusing to open a swap session"
            .to_string(),
    )
}

/// Whole-blob equality between the stored vault and the supplied one.
///
/// Every field is compared, not just the ciphertext: `salt` feeds the KDF and
/// `iv` feeds the decryption, so a blob that shares a ciphertext but differs in
/// either is a different vault and must not be accepted. Split out from
/// [`assert_vault_matches_disk`] so the comparison itself is unit-testable
/// without an `AppHandle` or a store on disk.
fn vaults_match(on_disk: &EncryptedVault, supplied: &EncryptedVault) -> bool {
    on_disk.salt == supplied.salt
        && on_disk.iv == supplied.iv
        && on_disk.ciphertext == supplied.ciphertext
}

#[cfg(test)]
mod vault_binding_tests {
    use super::*;

    fn vault(salt: &str, iv: &str, ct: &str) -> EncryptedVault {
        EncryptedVault {
            salt: salt.to_string(),
            iv: iv.to_string(),
            ciphertext: ct.to_string(),
        }
    }

    #[test]
    fn only_the_exact_on_disk_vault_matches() {
        let disk = vault("s1", "i1", "c1");
        assert!(vaults_match(&disk, &vault("s1", "i1", "c1")));

        // A forged blob differing in ANY field must be refused — including one
        // that reuses the real ciphertext, since salt and iv still decide what
        // key is derived and what plaintext comes out.
        assert!(!vaults_match(&disk, &vault("s2", "i1", "c1")), "salt ignored");
        assert!(!vaults_match(&disk, &vault("s1", "i2", "c1")), "iv ignored");
        assert!(
            !vaults_match(&disk, &vault("s1", "i1", "c2")),
            "ciphertext ignored"
        );
    }

    /// **The guard must be WIRED IN, not merely present.**
    ///
    /// An adversarial review found that deleting a call site left every test
    /// green because the tests exercised the pure function and never the
    /// command. That is the same defect class this repo keeps hitting, so this
    /// asserts the ordering in the source itself: `swap_unlock` must call
    /// `assert_vault_matches_disk` and must do so BEFORE `decrypt_vault`.
    /// Deleting the call, or moving it after the decrypt, turns this red.
    #[test]
    fn swap_unlock_checks_the_vault_before_decrypting() {
        // Normalised: this file is stored CRLF on Windows checkouts, so a bare
        // "\n}\n" sentinel silently never matches and the test fails for a
        // reason that has nothing to do with the guard it is checking.
        let normalized = include_str!("commands.rs").replace("\r\n", "\n");
        // Anchor on the ATTRIBUTE, not the signature. This test module sits
        // above `swap_unlock` in the file, so searching for the bare signature
        // matched the copy inside this very test's string literal and happily
        // "found" the guard in its own source — passing while the real call
        // site was deleted. Self-referential source parsing is its own little
        // trap, and it cost a mutation run to notice.
        const ANCHOR: &str = "#[tauri::command]\npub async fn swap_unlock(";
        let start = normalized
            .find(ANCHOR)
            .expect("swap_unlock must exist as a tauri command");
        let rest = &normalized[start..];
        let end = rest.find("\n}\n").expect("function must terminate");
        // Strip line comments before searching. The body's own comment explains
        // what the guard is for and therefore NAMES it, which was enough to
        // satisfy a naive substring search while the actual call was deleted —
        // the second way this one test managed to pass for the wrong reason.
        let body: String = rest[..end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        let body = body.as_str();

        let guard = body
            .find("assert_vault_matches_disk")
            .unwrap_or_else(|| panic!("swap_unlock does not call the vault guard:\n{body}"));
        let decrypt = body
            .find("decrypt_vault")
            .expect("swap_unlock must still decrypt");
        assert!(
            guard < decrypt,
            "the vault guard must run BEFORE decryption, otherwise a forged blob \
             is decrypted first and only then rejected"
        );
    }
}

#[tauri::command]
pub async fn swap_unlock(
    app: AppHandle,
    state: State<'_, SwapState>,
    encrypted: EncryptedVault,
    password: String,
) -> Result<UnlockResp, String> {
    // BEFORE any decryption: the vault must be the one on disk. See
    // `assert_vault_matches_disk` for the fund-theft path this closes.
    assert_vault_matches_disk(&app, &encrypted)?;
    let mnemonic =
        keystore::decrypt_vault(&encrypted, &password).map_err(|e| e.to_string())?;
    let (session_id, expires_at_inst) = state.unlock(mnemonic);
    let now_inst = std::time::Instant::now();
    let now_utc: DateTime<Utc> = Utc::now();
    let delta = expires_at_inst.saturating_duration_since(now_inst);
    let expires_at = now_utc + chrono::Duration::from_std(delta).unwrap_or_default();
    Ok(UnlockResp {
        session_id,
        expires_at: expires_at.to_rfc3339(),
    })
}

#[tauri::command]
pub fn swap_lock(state: State<'_, SwapState>) {
    state.lock();
}

// ----------------------------------------------------------------------
// address derivation
// ----------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Addresses {
    pub eth: String,
    pub btc: String,
    pub near: String,
    pub sol: String,
}

#[tauri::command]
pub fn swap_get_addresses(
    state: State<'_, SwapState>,
    session_id: String,
) -> Result<Addresses, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<Addresses, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let evm_sk = derive::evm_private_key(&seed[..], 0, 0).map_err(|e| e.to_string())?;
            let eth = derive::evm_address_eip55(&evm_sk).map_err(|e| e.to_string())?;
            let btc = derive::btc_p2wpkh_address(&seed[..], 0, 0).map_err(|e| e.to_string())?;
            let near_sk = near::near_secret_from_seed(&seed[..]);
            let near_pub = near::public_key(&near_sk);
            let sol_sk = solana::sol_secret_from_seed(&seed[..]);
            let sol_pub = bs58::encode(
                ed25519_dalek::SigningKey::from_bytes(&sol_sk)
                    .verifying_key()
                    .to_bytes(),
            )
            .into_string();
            Ok(Addresses {
                eth,
                btc,
                near: near_pub,
                sol: sol_pub,
            })
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

#[tauri::command]
pub fn swap_get_utxo_address(
    state: State<'_, SwapState>,
    session_id: String,
    chain: derive::UtxoChain,
    account: Option<u32>,
    index: Option<u32>,
) -> Result<String, String> {
    let acct = account.unwrap_or(0);
    let idx = index.unwrap_or(0);
    state
        .with_session(&session_id, |mnemonic| -> Result<String, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            derive::utxo_address(&seed[..], chain, acct, idx).map_err(|e| e.to_string())
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

#[tauri::command]
pub fn swap_get_solana_address(
    state: State<'_, SwapState>,
    session_id: String,
) -> Result<String, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<String, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            Ok(derive::solana_address(&seed[..]))
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

/// Returns `{ accountId, publicKey }` where `accountId` is the 64-char
/// implicit-account hex (the funding target) and `publicKey` is the
/// `ed25519:<base58>` form for display.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearAddress {
    pub account_id: String,
    pub public_key: String,
}

#[tauri::command]
pub fn swap_get_near_address(
    state: State<'_, SwapState>,
    session_id: String,
) -> Result<NearAddress, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<NearAddress, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            Ok(NearAddress {
                account_id: derive::near_implicit_account(&seed[..]),
                public_key: derive::near_ed25519_public_key(&seed[..]),
            })
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

// ----------------------------------------------------------------------
// proxy passthrough (signed) — with auto re-enroll-once on AUTH_REQUIRED /
// AUTH_UNKNOWN_PUBKEY.
// ----------------------------------------------------------------------

/// Attempt a signed call. If the server says we're not enrolled (AUTH_REQUIRED
/// or AUTH_UNKNOWN_PUBKEY), trigger a single re-enrollment then retry. Any
/// other error bubbles out unchanged.
async fn signed_call_with_reenroll<F, Fut, R>(
    state: &SwapState,
    mut call: F,
) -> Result<R, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<R, ProxyError>>,
{
    match call().await {
        Ok(v) => Ok(v),
        Err(ProxyError::AuthRequired) | Err(ProxyError::AuthUnknownPubkey) => {
            // One re-enroll attempt.
            let base = state.proxy_url().ok_or_else(|| "proxy URL not set".to_string())?;
            let pubkey = state
                .pubkey_b64()
                .ok_or_else(|| "auth keypair not initialized".to_string())?;
            match proxy::enroll(&base, &pubkey).await {
                Ok((status, body)) if (200..300).contains(&status) => {
                    // Mark enrolled and retry the original call once.
                    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    if v.get("enrolled").and_then(Value::as_bool).unwrap_or(false) {
                        let now = Utc::now().to_rfc3339();
                        state.set_enrolled_at(Some(now.clone()));
                        if let Some(dir) = state.data_dir() {
                            let mut s = auth::read_state(&dir, &base);
                            s.enrolled_at = Some(now);
                            let _ = auth::write_state(&dir, &base, &s);
                        }
                    }
                    call().await.map_err(|e| e.to_string())
                }
                Ok((status, body)) => Err(format!(
                    "auto re-enroll failed: {} {}",
                    status,
                    trim_body_to_240_chars_with_ellipsis(&body)
                )),
                Err(e) => Err(e.to_string()),
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn swap_get_quote(
    state: State<'_, SwapState>,
    req: proxy::SwapKitQuoteRequest,
) -> Result<Value, String> {
    let inner = state.inner();
    signed_call_with_reenroll(inner, || proxy::swapkit_quote(inner, &req)).await
}

#[tauri::command]
pub async fn swap_build_tx(
    state: State<'_, SwapState>,
    req: proxy::SwapKitSwapRequest,
) -> Result<Value, String> {
    let inner = state.inner();
    signed_call_with_reenroll(inner, || proxy::swapkit_swap(inner, &req)).await
}

#[tauri::command]
pub async fn swap_track(
    state: State<'_, SwapState>,
    req: proxy::SwapKitTrackRequest,
) -> Result<Value, String> {
    let inner = state.inner();
    signed_call_with_reenroll(inner, || proxy::swapkit_track(inner, &req)).await
}

#[tauri::command]
pub async fn intents_quote(
    state: State<'_, SwapState>,
    req: proxy::IntentsQuoteRequest,
) -> Result<Value, String> {
    let inner = state.inner();
    signed_call_with_reenroll(inner, || proxy::intents_quote(inner, &req)).await
}

#[tauri::command]
pub async fn intents_deposit_submit(
    state: State<'_, SwapState>,
    req: proxy::IntentsDepositSubmit,
) -> Result<Value, String> {
    let inner = state.inner();
    signed_call_with_reenroll(inner, || proxy::intents_deposit_submit(inner, &req)).await
}

#[tauri::command]
pub async fn intents_status(
    state: State<'_, SwapState>,
    deposit_address: String,
) -> Result<Value, String> {
    let inner = state.inner();
    signed_call_with_reenroll(inner, || proxy::intents_status(inner, &deposit_address)).await
}

// ----------------------------------------------------------------------
// signing
// ----------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedHexResp {
    pub raw_tx: String,
}

#[tauri::command]
pub fn swap_sign_evm(
    state: State<'_, SwapState>,
    session_id: String,
    account: Option<u32>,
    index: Option<u32>,
    tx: evm::UnsignedEvmTx,
) -> Result<SignedHexResp, String> {
    let acct = account.unwrap_or(0);
    let idx = index.unwrap_or(0);
    state
        .with_session(&session_id, |mnemonic| -> Result<SignedHexResp, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = derive::evm_private_key(&seed[..], acct, idx).map_err(|e| e.to_string())?;
            let raw = evm::sign_tx(&tx, &sk).map_err(|e| e.to_string())?;
            Ok(SignedHexResp { raw_tx: raw })
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

#[tauri::command]
pub fn swap_sign_psbt(
    state: State<'_, SwapState>,
    session_id: String,
    psbt_hex: String,
    chain: Option<derive::UtxoChain>,
) -> Result<SignedHexResp, String> {
    let chain = chain.unwrap_or(derive::UtxoChain::Btc);
    state
        .with_session(&session_id, |mnemonic| -> Result<SignedHexResp, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let signed =
                btc::sign_psbt_for_chain(&seed[..], &psbt_hex, chain).map_err(|e| e.to_string())?;
            // Surface the broadcast-ready raw tx; callers can ignore the PSBT.
            let raw_tx = btc::extract_tx(&signed).unwrap_or(signed);
            Ok(SignedHexResp { raw_tx })
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

#[tauri::command]
pub fn swap_sign_near_intent(
    state: State<'_, SwapState>,
    session_id: String,
    input: nep413::SignNep413Input,
) -> Result<nep413::SignedNep413, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<_, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = near::near_secret_from_seed(&seed[..]);
            nep413::sign(&input, &sk).map_err(|e| e.to_string())
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

/// Sign arbitrary bytes with the user's NEAR ed25519 key (the same key
/// `swap_sign_near_intent` uses for NEP-413). Used to sign on-chain NEAR
/// transactions: the caller borsh-encodes a `Transaction`, passes the
/// raw bytes here, gets back a base64 64-byte ed25519 signature, then
/// bundles it into a `SignedTransaction` for broadcast.
///
/// Inputs and outputs are base64 to avoid having to round-trip arbitrary
/// binary through Tauri's JSON IPC.
#[tauri::command]
pub fn swap_sign_near_tx(
    state: State<'_, SwapState>,
    session_id: String,
    message_b64: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    let bytes = B64.decode(message_b64.as_bytes()).map_err(|e| e.to_string())?;
    state
        .with_session(&session_id, |mnemonic| -> Result<String, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = near::near_secret_from_seed(&seed[..]);
            let signing = SigningKey::from_bytes(&sk);
            let sig = signing.sign(&bytes);
            Ok(B64.encode(sig.to_bytes()))
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

#[tauri::command]
pub fn swap_sign_solana(
    state: State<'_, SwapState>,
    session_id: String,
    input: solana::SignSolanaInput,
) -> Result<solana::SignedSolana, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<_, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = solana::sol_secret_from_seed(&seed[..]);
            solana::sign_message(&sk, &input).map_err(|e| e.to_string())
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

/// Phase 6 — sign a Stellar `Transaction` XDR. The TS caller builds the
/// XDR; Rust signs the network-id-prefixed SHA-256 digest.
#[tauri::command]
pub fn swap_sign_stellar_tx(
    state: State<'_, SwapState>,
    session_id: String,
    input: stellar::SignStellarInput,
) -> Result<stellar::SignedStellar, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<_, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = stellar::stellar_secret_from_seed(&seed[..]);
            stellar::sign_tx(&sk, &input).map_err(|e| e.to_string())
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

/// Phase 6 — derive the user's Stellar G-address. Used when the dashboard
/// needs the address but doesn't have a wallet adapter (e.g. for the swap
/// destination resolver).
#[tauri::command]
pub fn swap_get_stellar_address(
    state: State<'_, SwapState>,
    session_id: String,
) -> Result<String, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<String, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = stellar::stellar_secret_from_seed(&seed[..]);
            let pk = stellar::stellar_public_key(&sk);
            // StrKey encode: version 0x30 || pk(32) || crc16-xmodem(2).
            Ok(strkey_encode_account(&pk))
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

fn strkey_encode_account(pk: &[u8; 32]) -> String {
    let mut body = [0u8; 33];
    body[0] = 0x30; // account public key version byte
    body[1..].copy_from_slice(pk);
    let crc = crc16_xmodem(&body);
    let mut full = [0u8; 35];
    full[..33].copy_from_slice(&body);
    full[33] = (crc & 0xff) as u8;
    full[34] = ((crc >> 8) & 0xff) as u8;
    base32_encode(&full)
}

fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

fn base32_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    for &b in data {
        value = (value << 8) | (b as u32);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((value >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// Phase 7 — sign a Sui TransactionData (BCS-encoded, base64-wrapped).
/// Returns the 97-byte wire signature (flag || sig || pubkey), base64.
#[tauri::command]
pub fn swap_sign_sui_tx(
    state: State<'_, SwapState>,
    session_id: String,
    input: sui::SignSuiInput,
) -> Result<sui::SignedSui, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<_, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = sui::sui_secret_from_seed(&seed[..]);
            sui::sign_tx(&sk, &input).map_err(|e| e.to_string())
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

/// Phase 7 — derive the user's Sui address (`0x` + 64 hex).
#[tauri::command]
pub fn swap_get_sui_address(
    state: State<'_, SwapState>,
    session_id: String,
) -> Result<String, String> {
    state
        .with_session(&session_id, |mnemonic| -> Result<String, String> {
            let seed = derive::mnemonic_to_seed(mnemonic, "").map_err(|e| e.to_string())?;
            let sk = sui::sui_secret_from_seed(&seed[..]);
            let pk = sui::sui_public_key(&sk);
            Ok(sui::sui_address(&pk))
        })
        .ok_or_else(|| "session expired or invalid".to_string())?
}

// ----------------------------------------------------------------------
// broadcast — direct chain RPC, never via the proxy
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn swap_broadcast(input: bcast::BroadcastInput) -> Result<String, String> {
    bcast::broadcast(&input).await.map_err(|e| e.to_string())
}

/// Verified EVM broadcast — iterates through `rpcUrls`, sends
/// `eth_sendRawTransaction` against each, and confirms with
/// `eth_getTransactionByHash` on the same node before declaring
/// success. Failure (every URL falls through) returns an error message
/// that includes the per-URL audit trail.
///
/// This is the P0 fix for the "fake success" bug — the previous flow
/// returned the hash the node COMPUTED from the bytes, which doesn't
/// prove the network actually accepted the tx. A rate-limited or
/// stressed node could 200-OK a submission without propagating it.
/// Verification with `getTransactionByHash` on the same node closes
/// that gap.
#[tauri::command]
pub async fn swap_evm_broadcast_verified(
    input: bcast::VerifiedBroadcastInput,
) -> Result<bcast::VerifiedBroadcastResult, String> {
    bcast::evm_broadcast_verified(&input).await.map_err(|(err, attempts)| {
        // Pretty-print the audit trail so the UI can render it inline.
        let trail = attempts
            .iter()
            .map(|a| format!("  {} ({}): {}", a.url, a.stage, a.error))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{err}\n{trail}")
    })
}
